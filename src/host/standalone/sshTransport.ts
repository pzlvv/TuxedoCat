/**
 * SSH 接入的控制通道建链器（`docs/core/core-remote.md` 第 2 节）。
 *
 * 目标环境只开放 SSH 端口时，Host 的全部通信都走这条 SSH 连接：
 * 1. `SshClient` 建立 SSH 连接（口令鉴权 + 主机密钥 TOFU 校验）；
 * 2. `ensureRemoteDaemon` 完成「发现 / 部署 / 启动」并拿回 daemon 的 endpoint；
 * 3. `forwardOut` 在远端开一条到该 endpoint 的转发通道——它就是控制通道；
 * 4. 其余交给 `CoreDaemon`（背压、channel 复用、目录操作全部复用）。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`。
 */

import type { ClientChannel } from 'ssh2';
import { SSH_DAEMON_LINK_TIMEOUT_MS, type CoreDaemonLink, type CoreDaemonLinkOpener } from './CoreDaemon.js';
import { ensureRemoteDaemon, type RemoteBootstrapOptions, type RemoteDaemonEndpoint, type RemoteSsh } from './sshDaemonBootstrap.js';
import { SshClient, type SshTarget } from './sshClient.js';
import { sshTargetKey } from '../sshTarget.js';
import { sharedInFlight, withTimeout } from '../../shared/utils/asyncUtils.js';

/** SSH 接入参数 */
export interface SshDaemonTransport {
  /** SSH 目标（host / port / user / password） */
  target: SshTarget;
  /** 应用 / 扩展根目录：本地 Core 产物的定位基准 */
  extensionPath: string;
}

/**
 * 进行中的远端引导（按 SSH 目标去重）。
 *
 * 启动期「可达性探测」与「正式连接」会同时为同一 endpoint 各跑一遍
 * `ensureRemoteDaemon`：不去重时两边都会全量上传产物（约 11MB，把探测的建链预算
 * 挤爆），两条 `start` 还会各拉起一个 daemon——内核分配端口互不冲突，
 * 多出来的那个成孤儿常驻远端。in-flight 的引导 promise 按目标共享，后到者直接
 * 复用；settle（成功或失败）后移除，之后的调用各自走常规的幂等快路径。
 */
const inFlightBootstraps = new Map<string, Promise<RemoteDaemonEndpoint>>();

/** 引导去重的键：连接目标的唯一身份键（`sshTargetKey`——端口归一、凭证指纹参与身份） */
function bootstrapKey(target: SshTarget): string {
  return sshTargetKey(target);
}

/**
 * 共享的 `ensureRemoteDaemon`：同目标的并发调用复用同一次引导。
 *
 * 引导跑在**第一个调用者**的 SSH 连接上，后到者只拿结果、用自己的连接开转发通道。
 * 导出仅为单测（`src/test/sshTransport.test.ts` 锁定共享语义）。
 */
export function ensureRemoteDaemonShared(
  target: SshTarget,
  ssh: RemoteSsh,
  options: RemoteBootstrapOptions,
): Promise<RemoteDaemonEndpoint> {
  return sharedInFlight(inFlightBootstraps, bootstrapKey(target), () =>
    ensureRemoteDaemon(ssh, options));
}

/**
 * 建一个 SSH 接入的建链器。
 *
 * SSH 连接与 daemon 引导都延迟到第一次 `open()` / `prepare()`：目录选择器打开窗口时
 * 还没有工作区，提前连接会让「取消」也留下一条 SSH 连接。
 */
export function createSshDaemonOpener(
  transport: SshDaemonTransport,
  log: (...args: unknown[]) => void,
): CoreDaemonLinkOpener {
  const ssh = new SshClient(transport.target, log);
  const bootstrap = (): Promise<RemoteDaemonEndpoint> =>
    ensureRemoteDaemonShared(transport.target, ssh, { extensionPath: transport.extensionPath, log });
  /**
   * 最近一次 `open()` 拿到的 endpoint。
   *
   * 心跳链路紧接着业务链路建在同一个 daemon 上：复用这份结果，不再跑一遍引导
   * （`ensureRemoteDaemonShared` 虽然是幂等快路径，但它要经 SSH exec 读状态文件 / 探活，
   * 白白多几个往返）。链路重开后 `open()` 会把它刷新成新的 endpoint。
   */
  let lastEndpoint: RemoteDaemonEndpoint | null = null;
  /** 建一条到该 endpoint 的转发通道并包成控制链路 */
  const forward = async (daemon: RemoteDaemonEndpoint): Promise<CoreDaemonLink> => {
    const channel = await ssh.openTcpForward(daemon.host, daemon.port);
    return openSshChannelLink(channel, log);
  };
  return {
    // 引导（上传产物 + 拉起 daemon）是建链前最慢的一步：单独暴露给探测方在计时前
    // 跑掉，`open()` 里照常再走一遍——daemon 已就绪时是幂等快路径。上限沿用
    // SSH_DAEMON_LINK_TIMEOUT_MS：探测不该被一条黑掉的链路挂死（正式连接的 open()
    // 不加这层上限，它的整体预算本来就是同一个值）。
    prepare: async (): Promise<void> => {
      await ssh.connect();
      await withTimeout(bootstrap(), SSH_DAEMON_LINK_TIMEOUT_MS, 'remote daemon bootstrap');
    },
    async open(): Promise<CoreDaemonLink> {
      await ssh.connect();
      const daemon = await bootstrap();
      lastEndpoint = daemon;
      return forward(daemon);
    },
    /**
     * 心跳专用转发通道：同一个 daemon 上的**第二条** `direct-tcpip` 通道。
     *
     * daemon 一条连接一个服务线程，`pong` 由该连接自己的写线程直接写出——因此它不会
     * 排在业务链路的大帧后面（业务链路的出站严格有序）。SSH 层多路复用同一条连接，
     * 两条转发通道各自独立成流（`docs/core/core-remote.md` 第 2.5 节）。
     */
    async openHeartbeat(): Promise<CoreDaemonLink> {
      await ssh.connect();
      const daemon = lastEndpoint ?? await bootstrap();
      lastEndpoint = daemon;
      const channel = await ssh.openTcpForward(daemon.host, daemon.port);
      const link = openSshChannelLink(channel, log);
      // 心跳链路的诊断单独标一次，日志里一眼能分清是哪条转发通道挂了
      channel.on('close', () => log('[ssh] heartbeat channel closed'));
      return link;
    },
    dispose: () => {
      lastEndpoint = null;
      ssh.dispose();
    },
  };
}

/** 把一条 SSH 转发通道包成控制通道链路 */
function openSshChannelLink(
  channel: ClientChannel,
  log: (...args: unknown[]) => void,
): CoreDaemonLink {
  channel.setEncoding('utf8');
  channel.on('error', (error: Error) => {
    log(`[ssh] control channel error: ${error.message}`);
  });
  const link: CoreDaemonLink = {
    write: (line) => channel.write(line),
    onceDrain: (listener) => {
      channel.once('drain', listener);
    },
    end: () => {
      channel.end();
    },
    kill: () => {
      channel.destroy();
    },
    onData: (listener) => {
      channel.on('data', (chunk: string | Buffer) => {
        listener(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });
    },
    onClose: (listener) => {
      channel.on('close', () => listener());
    },
  };
  return link;
}

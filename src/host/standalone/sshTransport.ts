/**
 * SSH 接入的控制通道建链器（`docs/core-daemon.md` 第 12 节）。
 *
 * 目标环境只开放 SSH 端口时，Host 的全部通信都走这条 SSH 连接：
 * 1. `SshClient` 建立 SSH 连接（口令鉴权 + 主机密钥 TOFU 校验）；
 * 2. `ensureRemoteDaemon` 完成「发现 / 部署 / 启动」并拿回 daemon 的 endpoint 与 token；
 * 3. `forwardOut` 在远端开一条到该 endpoint 的转发通道——它就是控制通道；
 * 4. 第一帧发 `auth`，其余交给 `CoreDaemon`（背压、channel 复用、目录操作全部复用）。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`。
 */

import type { ClientChannel } from 'ssh2';
import { encodeDaemonFrame } from './daemonProtocol.js';
import { ensureRemoteDaemon } from './sshDaemonBootstrap.js';
import { SshClient, type SshTarget } from './sshClient.js';
import type { CoreDaemonLink, CoreDaemonLinkOpener } from './CoreDaemon.js';

/** SSH 接入参数 */
export interface SshDaemonTransport {
  /** SSH 目标（host / port / user / password） */
  target: SshTarget;
  /** 应用 / 扩展根目录：本地 Core 产物的定位基准 */
  extensionPath: string;
}

/**
 * 建一个 SSH 接入的建链器。
 *
 * SSH 连接与 daemon 引导都延迟到第一次 `open()`：目录选择器打开窗口时还没有工作区，
 * 提前连接会让「取消」也留下一条 SSH 连接。
 */
export function createSshDaemonOpener(
  transport: SshDaemonTransport,
  log: (...args: unknown[]) => void,
): CoreDaemonLinkOpener {
  const ssh = new SshClient(transport.target, log);
  return {
    async open(): Promise<CoreDaemonLink> {
      await ssh.connect();
      const daemon = await ensureRemoteDaemon(ssh, {
        extensionPath: transport.extensionPath,
        log,
      });
      const channel = await ssh.openTcpForward(daemon.host, daemon.port);
      return openSshChannelLink(channel, daemon.token, log);
    },
    dispose: () => ssh.dispose(),
  };
}

/**
 * 把一条 SSH 转发通道包成控制通道链路，并发出 `auth` 第一帧。
 *
 * 远端 daemon 的 token 不出现在任何 UI / 日志里：它只在这一次 `auth` 中使用。
 */
function openSshChannelLink(
  channel: ClientChannel,
  token: string,
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
  channel.write(encodeDaemonFrame({ kind: 'auth', token }));
  return link;
}

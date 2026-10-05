/**
 * 远端 Core 的 SSH 引导（`docs/core-daemon.md` 第 12.8 节）。
 *
 * 目标环境只有 SSH 端口、daemon 端口映射不出来时，Host 经 SSH 完成：
 *
 * 1. **发现**：部署槽位由本机携带产物的**构建指纹**决定（`docs/standalone-core.md`
 *    第 4.4 节）——远端部署目录 `~/.local/bin/<core.deployPrefix>_<指纹前一半>/`，
 *    状态文件 `~/<configDir>/core-daemon-<指纹>.json`。状态文件里的 daemon 探得通就是
 *    本版本（同一指纹）的 daemon 在跑，直接复用：不重启、不覆盖。
 *    多版本 Core 在同一台远端机器上各占一个槽位、各跑一个 daemon——不同版本
 *    的客户端同时接入同一台机器互不干扰；同版本的多个客户端并发接同一个
 *    daemon 由 daemon 侧的多连接支持（`docs/core-daemon.md` 第 12.5 节）。
 * 2. **部署**：指纹目录里缺可执行文件或自带 `ripgrep/rg` 才上传（临时名 + rename，
 *    对可能仍在执行的旧 inode 安全）；**指纹目录存在即视为同版本**，不做产物
 *    哈希比对——指纹只由源码内容与编译器身份决定，同一版本不该因字节差异互相
 *    覆盖：新版本天然落在新槽位，旧 daemon 原样留给旧版本的客户端。
 * 3. **启动**：`start --idle-exit 30`（幂等：已在跑就复用），再读状态文件。
 *    daemon 恒绑回环、端口交给内核分配（`docs/core-daemon.md` 第 12.2 节）：转发连接
 *    从远端本机发起，daemon 端口不出机器；多版本 Core 各占一个槽位、各跑一个 daemon，
 *    内核分配端口使端口冲突从构造上不可能发生。实际端口以按指纹的状态文件为准
 *    （本模块唯一事实来源）。
 *
 * 各分支都以「读到状态文件里的 endpoint」收尾；任何一步失败都直接报错，
 * 不回退到「先连上再说」（`DEVELOPMENT.md` 第 12 章）。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`，可脱离宿主单测（见
 * `src/test/sshDaemonBootstrap.test.ts`）。
 */

import { existsSync } from 'node:fs';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import {
  CORE_RIPGREP_DIR,
  bundledRipgrepFileName,
  bundledRipgrepPath,
  coreBinaryFileName,
  coreDeployDirName,
  readCoreFingerprint,
  resolveCoreBinary,
} from './coreBinary.js';
import { daemonLogFileName, daemonStateFileName, type DaemonStateFile } from './daemonProtocol.js';
import type { SshExecResult, SshFileInfo } from './sshClient.js';

/**
 * 引导流程用到的 SSH 能力（`SshClient` 的实现子集）。
 *
 * 单独抽出来是为了能注入假实现做单测：真跑一遍要一台开着 SSH 的机器。
 */
export interface RemoteSsh {
  exec(command: string, timeoutMs?: number): Promise<SshExecResult>;
  homeDir(): Promise<string>;
  stat(target: string): Promise<SshFileInfo>;
  readText(target: string): Promise<string>;
  upload(localPath: string, remotePath: string, mode: number): Promise<void>;
  /** 打开一条到远端 `host:port` 的转发通道；只用于探测，拿到后立即 destroy */
  openTcpForward(host: string, port: number): Promise<{ destroy(): void }>;
}

/** 远端部署槽位的父目录（相对远端主目录）；实际落位是其下的 `<core.deployPrefix>_<指纹前一半>/` 子目录 */
export const REMOTE_BIN_DIR = '.local/bin';

/**
 * SSH 引导拉起的 daemon 的空闲退出秒数（`start --idle-exit`，`docs/core-daemon.md`
 * 第 12.5 节）。
 *
 * 客户端异常退出（crash / 断电 / 网络消失）后，该连接的 Core 随连接断开（EOF 或
 * 心跳超时）被 daemon 关闭，daemon 本体在**最后一条控制连接断开 30s**后自行退出——
 * 多客户端下其他客户端还连着就不退，最后一个走后才清场，远端不留常驻进程。
 * 30s 的宽限同时吸收网络闪断后的快速重连（复用在跑的 daemon，不用重新 start）；
 * 「拉起后无人接入」的孤儿 daemon 也由同一条规则兜底。
 */
export const REMOTE_DAEMON_IDLE_EXIT_SECONDS = 30;

/** 引导完成后拿到的 daemon 接入信息（host 恒为远端回环） */
export interface RemoteDaemonEndpoint {
  /** 从远端 sshd 视角可达的主机 */
  host: string;
  port: number;
}

/** 引导参数 */
export interface RemoteBootstrapOptions {
  /** 应用 / 扩展根目录：本地 Core 产物的定位基准（`docs/standalone-core.md` 第 4.1 节） */
  extensionPath: string;
  log: (...args: unknown[]) => void;
}

/** 远端平台 / 架构（与 `core-rs` 的产物矩阵同口径） */
export interface RemoteTarget {
  platform: NodeJS.Platform;
  arch: string;
}

/**
 * 确保远端 daemon 在跑，返回可直接转发的 endpoint。
 *
 * 调用方随后用 `ssh.openTcpForward(host, port)` 拿到控制通道——daemon 端口全程不出 SSH。
 */
export async function ensureRemoteDaemon(
  ssh: RemoteSsh,
  options: RemoteBootstrapOptions,
): Promise<RemoteDaemonEndpoint> {
  const home = await ssh.homeDir();

  // 平台先行：版本判定与产物落位都按远端平台挑本机携带的对应产物
  const target = await detectRemoteTarget(ssh);
  const localBinary = resolveCoreBinary(options.extensionPath, target.platform, target.arch);
  const fingerprint = readCoreFingerprint(options.extensionPath, target.platform, target.arch);
  const remoteBinary = posixJoin(
    home,
    REMOTE_BIN_DIR,
    coreDeployDirName(fingerprint),
    coreBinaryFileName(target.platform),
  );
  const statePath = posixJoin(home, CONFIG_DIR_NAME, daemonStateFileName(fingerprint));

  // 1. 该指纹的 daemon 在跑 → 直接复用。状态文件本身按指纹命名，探得通的一定是
  //    本版本的 daemon，无需再做任何版本比对。
  const running = await probeRunningDaemon(ssh, statePath, options.log);

  // 2. 产物齐全：缺了才传。「在跑」不等于产物齐全——指纹目录被外部清掉时进程
  //    仍在跑（inode 未释放），不在这里补，daemon 一死这份产物就彻底没了。
  if (await ensureRemoteBinary(ssh, localBinary, remoteBinary)) {
    options.log(`[ssh] deployed ${remoteBinary} (${target.platform}-${target.arch})`);
  }
  await ensureRemoteRipgrep(ssh, options, localBinary, remoteBinary, target);

  // 3. 在跑的 daemon 原样返回；否则 start（幂等：已在跑就只打印就绪信息）。启动前
  //    不结束别的 daemon：daemon 恒绑回环、端口交给内核分配，多版本 daemon 并存时
  //    互不抢固定端口，实际端口随状态文件读回；`--idle-exit` 让 daemon 在最后一条
  //    连接断开后自行退出（客户端 crash 不留常驻进程，`docs/core-daemon.md`
  //    第 12.5 节）。
  if (running) return running;

  const started = await ssh.exec(
    `${shellQuote(remoteBinary)} start --idle-exit ${REMOTE_DAEMON_IDLE_EXIT_SECONDS}`,
  );
  if (started.code !== 0) {
    throw new Error(
      `remote "${remoteBinary} start" failed (exit ${started.code ?? 'null'}): `
      + `${(started.stderr || started.stdout).trim() || 'no output'}`,
    );
  }

  // 4. 状态文件是唯一事实来源：daemon 实际监听的端口在这里
  const state = await readDaemonState(ssh, statePath);
  if (!state) {
    throw new Error(
      `remote daemon started but ${statePath} is missing or malformed; `
      + `see the remote ${daemonLogFileName(fingerprint)} for details.`,
    );
  }
  return state;
}

/**
 * 确保远端指纹目录里有可执行文件：缺失才上传，存在即同版本。
 *
 * 指纹只由源码内容与编译器身份决定（`docs/standalone-core.md` 第 4.4 节），同一
 * 指纹的两个构建产物行为一致，因此存在就不再上传——不同构建机 / 不同客户端的
 * 同版本产物互不覆盖。上传走「临时名 + `mv` 原子换名」：目标可能正被一个在跑的
 * daemon 执行（它的指纹目录被清过、状态文件丢失时我们无从得知它在跑），对执行中
 * 的文件直接覆盖写是 `ETXTBSY`（SFTP 层报 `Failure`）；`mv` 是 rename，只换目录项，
 * 运行中的进程继续用旧 inode。返回是否发生了上传（调用方据此打部署日志）。
 */
async function ensureRemoteBinary(
  ssh: RemoteSsh,
  localBinary: string,
  remoteBinary: string,
): Promise<boolean> {
  if ((await ssh.stat(remoteBinary)).exists) return false;
  await ssh.exec(`mkdir -p ${shellQuote(posixDirname(remoteBinary))}`);
  const staging = `${remoteBinary}.new`;
  await ssh.upload(localBinary, staging, 0o755);
  await ssh.exec(`mv -f ${shellQuote(staging)} ${shellQuote(remoteBinary)}`);
  return true;
}

/**
 * 确保远端有 Core 自带的 ripgrep（与远端可执行文件同级）。
 *
 * 远端机器不一定装过 `rg`，而 Grep / Glob 是核心工具：缺了它，远端的工具只能
 * `spawn rg ENOENT`。**缺了才传**——远端路径与平台无关（远端只支持 Linux，
 * 文件名恒为 `rg`），先按这个名字 stat。本机产物里没有这份 rg 属于构建不完整，
 * 直接报错（`DEVELOPMENT.md` 第 12 章）。
 */
async function ensureRemoteRipgrep(
  ssh: RemoteSsh,
  options: RemoteBootstrapOptions,
  localBinary: string,
  remoteBinary: string,
  target: RemoteTarget,
): Promise<void> {
  const remoteRipgrep = posixJoin(
    posixDirname(remoteBinary),
    CORE_RIPGREP_DIR,
    bundledRipgrepFileName('linux'),
  );
  if ((await ssh.stat(remoteRipgrep)).exists) return;

  const localRipgrep = bundledRipgrepPath(localBinary, target.platform);
  if (!existsSync(localRipgrep)) {
    throw new Error(
      `bundled ripgrep is missing from the local Core product: ${localRipgrep}; `
        + 'run "npm run build:core" first.',
    );
  }
  await ssh.exec(`mkdir -p ${shellQuote(posixDirname(remoteRipgrep))}`);
  await ssh.upload(localRipgrep, remoteRipgrep, 0o755);
  options.log(`[ssh] deployed ${remoteRipgrep} (${target.platform}-${target.arch})`);
}

/** 读远端状态文件；缺失 / 内容不合法 / endpoint 解析不出都返回 null（由调用方决定怎么办） */
async function readDaemonState(
  ssh: RemoteSsh,
  statePath: string,
): Promise<RemoteDaemonEndpoint | null> {
  const info = await ssh.stat(statePath);
  if (!info.exists) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await ssh.readText(statePath));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const state = parsed as Partial<DaemonStateFile>;
  if (typeof state.endpoint !== 'string') return null;
  const target = splitEndpoint(state.endpoint);
  if (!target) return null;
  return { host: target.host, port: target.port };
}

/**
 * 探测状态文件里的 daemon 是否还在跑。
 *
 * 连不上按「没有 daemon」处理——与 core 自己的 `start`（`ExistingDaemon::None`）同口径
 * （`docs/core-daemon.md` 第 12.3 节）。
 */
async function probeRunningDaemon(
  ssh: RemoteSsh,
  statePath: string,
  log: (...args: unknown[]) => void,
): Promise<RemoteDaemonEndpoint | null> {
  const state = await readDaemonState(ssh, statePath);
  if (!state) {
    // 状态文件缺失 / 损坏不等于没有 daemon（文件可能被外部清掉而进程还在跑）：
    // 这里只记录事实，由调用方决定「按没有处理」之后的路径（start 的端口重试会
    // 兜住）。不打这行，故障现场就一条 ssh 日志都没有。
    log('[ssh] daemon state file missing or unreadable; treating as no daemon');
    return null;
  }
  try {
    const channel = await ssh.openTcpForward(state.host, state.port);
    // 只探测：转发通道由建链方重新开一条，这里立刻放掉
    channel.destroy();
    log(`[ssh] reusing running daemon at ${state.host}:${state.port}`);
    return state;
  } catch {
    log(`[ssh] state file points at ${state.host}:${state.port} but it is not reachable`);
    return null;
  }
}

/** 远端平台 / 架构：`uname -sm`，认不出就报错，不猜 */
export async function detectRemoteTarget(ssh: RemoteSsh): Promise<RemoteTarget> {
  const result = await ssh.exec('uname -sm');
  if (result.code !== 0) {
    throw new Error(`remote "uname -sm" failed: ${result.stderr.trim() || 'no output'}`);
  }
  const [system, machine] = result.stdout.trim().split(/\s+/);
  const platform = system === 'Linux' ? 'linux' : null;
  if (!platform) {
    throw new Error(
      `remote platform "${system ?? 'unknown'}" is not supported by the bundled Core; `
      + 'deploy the Core on the target machine manually.',
    );
  }
  const arch = machine === 'x86_64' || machine === 'amd64'
    ? 'x64'
    : machine === 'aarch64' || machine === 'arm64'
      ? 'arm64'
      : null;
  if (!arch) {
    throw new Error(
      `remote architecture "${machine ?? 'unknown'}" is not supported by the bundled Core.`,
    );
  }
  return { platform, arch };
}

/**
 * 拆 `IP:端口`。状态文件里的 endpoint 恒为回环 IPv4（daemon 只绑回环）。
 *
 * 端口按最后一个 `:` 取；主机为空或端口非法都返回 null（调用方按状态文件损坏处理）。
 */
export function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const trimmed = endpoint.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = trimmed.slice(0, colon);
  const portText = trimmed.slice(colon + 1);
  if (host.length === 0 || !/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port <= 0 || port > 65535) return null;
  return { host, port };
}

/** POSIX 路径拼接：远端是 Linux，分隔符恒为 `/` */
export function posixJoin(...parts: readonly string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** 取路径的父目录（POSIX） */
function posixDirname(target: string): string {
  const index = target.lastIndexOf('/');
  return index <= 0 ? '/' : target.slice(0, index);
}

/** 单引号包裹：远端命令里的路径来自我们自己的拼接，仍然显式引用避免空格 / 元字符 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

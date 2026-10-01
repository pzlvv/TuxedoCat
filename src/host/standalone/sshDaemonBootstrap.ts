/**
 * 远端 Core 的 SSH 引导（`docs/core-daemon.md` 第 12 节）。
 *
 * 目标环境只有 SSH 端口、daemon 端口映射不出来时，Host 经 SSH 完成三件事：
 * 1. **发现**：远端状态文件里的 daemon 探得通就直接复用（用户已经手工 `start` 过）；
 * 2. **部署**：`~/.local/bin` 里没有可执行文件就上传一份本机携带的对应平台产物；
 * 3. **启动**：执行 `<远端可执行文件> start`（幂等：已在跑就复用），再读状态文件。
 *
 * 三条分支都以「读到状态文件里的 endpoint + token」收尾；任何一步失败都直接报错，
 * 不回退到「先连上再说」（`DEVELOPMENT.md` 第 12 章）。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`，可脱离宿主单测（见
 * `src/test/sshDaemonBootstrap.test.ts`）。
 */

import { CONFIG_DIR_NAME } from '../../config/project.js';
import { coreBinaryFileName, resolveCoreBinary } from './coreBinary.js';
import { DAEMON_STATE_FILE_NAME, type DaemonStateFile } from './daemonProtocol.js';
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

/** 远端可执行文件落位目录（相对远端主目录） */
export const REMOTE_BIN_DIR = '.local/bin';

/** 引导完成后拿到的 daemon 接入信息（host 恒为远端回环） */
export interface RemoteDaemonEndpoint {
  /** 从远端 sshd 视角可达的主机（通配地址已换成回环） */
  host: string;
  port: number;
  token: string;
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
 * 确保远端 daemon 在跑，返回可直接转发的 endpoint 与 token。
 *
 * 调用方随后用 `ssh.openTcpForward(host, port)` 拿到控制通道——daemon 端口全程不出 SSH。
 */
export async function ensureRemoteDaemon(
  ssh: RemoteSsh,
  options: RemoteBootstrapOptions,
): Promise<RemoteDaemonEndpoint> {
  const home = await ssh.homeDir();
  const statePath = posixJoin(home, CONFIG_DIR_NAME, DAEMON_STATE_FILE_NAME);

  // 1. 已经启动：状态文件里的 daemon 探得通就直接复用，不动远端任何东西
  const running = await probeRunningDaemon(ssh, statePath, options.log);
  if (running) return running;

  // 2. 平台不一致时产物不同：先问远端，再决定上传哪一份
  const target = await detectRemoteTarget(ssh);
  const localBinary = resolveCoreBinary(options.extensionPath, target.platform, target.arch);
  const remoteBinary = posixJoin(home, REMOTE_BIN_DIR, coreBinaryFileName(target.platform));

  // 3. 没部署就部署（已有可执行文件时原样使用，不覆盖用户自己放的那份）
  const existing = await ssh.stat(remoteBinary);
  if (!existing.exists) {
    await ssh.exec(`mkdir -p ${shellQuote(posixDirname(remoteBinary))}`);
    await ssh.upload(localBinary, remoteBinary, 0o755);
    options.log(`[ssh] deployed ${remoteBinary} (${target.platform}-${target.arch})`);
  }

  // 4. 启动：`start` 自己保证幂等（已在跑就只打印连接信息）
  const started = await ssh.exec(`${shellQuote(remoteBinary)} start`);
  if (started.code !== 0) {
    throw new Error(
      `remote "${remoteBinary} start" failed (exit ${started.code ?? 'null'}): `
      + `${(started.stderr || started.stdout).trim() || 'no output'}`,
    );
  }

  // 5. 状态文件是唯一事实来源：daemon 实际监听的端口与生效 token 都在这里
  const state = await readDaemonState(ssh, statePath);
  if (!state) {
    throw new Error(
      `remote daemon started but ${statePath} is missing or malformed; `
      + 'see the remote core-daemon.log for details.',
    );
  }
  return state;
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
  if (typeof state.endpoint !== 'string' || typeof state.token !== 'string') return null;
  if (state.token.length === 0) return null;
  const target = splitEndpoint(state.endpoint);
  if (!target) return null;
  return { host: target.host, port: target.port, token: state.token };
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
  if (!state) return null;
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
      + 'deploy the Core on the target machine manually, or use the connection string instead.',
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
 * 拆 `IP:端口`（IPv6 带方括号，`[::]:10975`）。
 *
 * 通配地址换成回环：绑 `0.0.0.0` 的 daemon 一定在回环上可达，而直接转发到 `0.0.0.0`
 * 在部分平台上会失败（与 `core-rs/src/remote.rs::connectable` 同口径）。
 */
export function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const trimmed = endpoint.trim();
  let host: string;
  let portText: string;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    if (close < 0) return null;
    host = trimmed.slice(1, close);
    const rest = trimmed.slice(close + 1);
    if (!rest.startsWith(':')) return null;
    portText = rest.slice(1);
  } else {
    const colon = trimmed.lastIndexOf(':');
    if (colon <= 0) return null;
    host = trimmed.slice(0, colon);
    portText = trimmed.slice(colon + 1);
  }
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (port <= 0 || port > 65535) return null;
  const loopback = host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  return { host: loopback, port };
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

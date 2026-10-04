/**
 * 远端 Core 的 SSH 引导（`docs/core-daemon.md` 第 12 节）。
 *
 * 目标环境只有 SSH 端口、daemon 端口映射不出来时，Host 经 SSH 完成四件事：
 * 1. **发现**：远端状态文件里的 daemon 探得通**且远端可执行文件与本机携带产物一致**
 *    （sha256 比对）才复用——daemon 是常驻进程，旧版本应用留下的 daemon 会一直用旧
 *    产物拉起 Core（帧协议兼容、行为缺失：新增契约事件不发，如对话空间清空回执，
 *    宿主侧表现为设置面板永远停在「删除中」），版本不一致必须换血；
 * 2. **部署**：`~/.local/bin` 里没有可执行文件、或与本机携带产物不一致（含哈希读不出
 *    的保守情形）就覆盖上传，并补齐 Core 自带的 `ripgrep/`（Grep / Glob 用的 `rg`，
 *    与可执行文件同级——Core 以**自己的可执行文件目录**为基准定位自带资源，见
 *    `docs/standalone-core.md` 第 4 节）；覆盖只发生在 daemon 未运行（或已被结束）之后；
 * 3. **换血**：在跑的 daemon 版本过期时先 `<可执行文件> kill`（幂等）再部署再启动；
 * 4. **启动**：执行 `<远端可执行文件> start --host 127.0.0.1`（幂等：已在跑就复用），
 *    再读状态文件。绑回环是因为转发连接从远端本机发起，daemon 端口不出机器；
 *    直连 `tcp` 的连接串模式不受影响（`start` 缺省仍绑 `0.0.0.0`，见
 *    `docs/core-daemon.md` 第 12.2 节）。
 *
 * 各分支都以「读到状态文件里的 endpoint + token」收尾；任何一步失败都直接报错，
 * 不回退到「先连上再说」（`DEVELOPMENT.md` 第 12 章）。
 *
 * 本模块是 host 层：不 import `vscode` / `electron`，可脱离宿主单测（见
 * `src/test/sshDaemonBootstrap.test.ts`）。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import {
  CORE_RIPGREP_DIR,
  bundledRipgrepFileName,
  bundledRipgrepPath,
  coreBinaryFileName,
  resolveCoreBinary,
} from './coreBinary.js';
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

  // 平台先行：版本比对与产物落位都按远端平台挑本机携带的对应产物
  const target = await detectRemoteTarget(ssh);
  const localBinary = resolveCoreBinary(options.extensionPath, target.platform, target.arch);
  const remoteBinary = posixJoin(home, REMOTE_BIN_DIR, coreBinaryFileName(target.platform));

  // 1. 已经启动且远端可执行文件与本机携带产物一致：直接复用——不重启、不覆盖。
  //    「在跑」不再无条件复用：版本判定用可执行文件哈希，过期的 daemon 走下面的换血。
  const running = await probeRunningDaemon(ssh, statePath, options.log);
  if (running && (await remoteBinaryMatches(ssh, localBinary, remoteBinary))) {
    // 「在跑且版本一致」不等于产物齐全：老版本部署过的远端可能缺自带的 ripgrep，
    // 而 daemon 是常驻进程，不在这里补就再没有补的时机（除非用户 kill 它）。
    await ensureRemoteRipgrep(ssh, options, home);
    return running;
  }

  // 2. 在跑但版本过期（或不一致 / 哈希读不出）：先结束旧 daemon 再覆盖——它还在用
  //    旧产物给新接入的 Core 服务，换血从停止它开始（kill 幂等；下面的覆盖本身对
  //    执行中的文件也是安全的——走临时名 + rename，见 ensureRemoteBinary）。
  if (running) {
    options.log('[ssh] remote daemon is running an outdated core binary; restarting it');
    const killed = await ssh.exec(`${shellQuote(remoteBinary)} kill`);
    if (killed.code !== 0) {
      throw new Error(
        `remote "${remoteBinary} kill" failed (exit ${killed.code ?? 'null'}): `
        + `${(killed.stderr || killed.stdout).trim() || 'no output'}`,
      );
    }
  }

  // 3. 部署：缺失或与本机携带版本不一致就覆盖上传。这条同时是「未启动的过期产物」
  //    的换血时机——否则 start 会拉起旧版 daemon，之后每次接入都复用它（回到第 2 步）。
  if (await ensureRemoteBinary(ssh, localBinary, remoteBinary)) {
    options.log(`[ssh] deployed ${remoteBinary} (${target.platform}-${target.arch})`);
  }

  // 4. Core 自带的 ripgrep：与可执行文件同级，缺了就补上
  await ensureRemoteRipgrep(ssh, options, home);

  // 5. 启动：`start` 自己保证幂等（已在跑就只打印连接信息）。绑回环——SSH 转发的
  //    连接从远端本机发起，daemon 端口不需要、也不应该对外暴露；换血路径已先结束
  //    在跑的 daemon，所以这条 start 只在「没有 daemon」时真正拉起进程。
  const started = await ssh.exec(`${shellQuote(remoteBinary)} start --host 127.0.0.1`);
  if (started.code !== 0) {
    throw new Error(
      `remote "${remoteBinary} start" failed (exit ${started.code ?? 'null'}): `
      + `${(started.stderr || started.stdout).trim() || 'no output'}`,
    );
  }

  // 6. 状态文件是唯一事实来源：daemon 实际监听的端口与生效 token 都在这里
  const state = await readDaemonState(ssh, statePath);
  if (!state) {
    throw new Error(
      `remote daemon started but ${statePath} is missing or malformed; `
      + 'see the remote core-daemon.log for details.',
    );
  }
  return state;
}

/**
 * 远端可执行文件是否与本机携带产物一致（sha256 摘要比对）。
 *
 * 哈希命令不可用 / 读不出按「不一致」处理：宁可多一次覆盖重启，也不复用可能过期的
 * 旧 daemon——旧 daemon 的危害（一直拉起行为缺失的旧 Core）远大于一次多余的重启。
 */
async function remoteBinaryMatches(
  ssh: RemoteSsh,
  localBinary: string,
  remoteBinary: string,
): Promise<boolean> {
  const [localHash, remoteHash] = await Promise.all([
    fileSha256(localBinary),
    remoteFileSha256(ssh, remoteBinary),
  ]);
  return localHash !== null && localHash === remoteHash;
}

/** 本地文件 sha256；读不出返回 null */
async function fileSha256(path: string): Promise<string | null> {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

/** 远端 `sha256sum` 的摘要；命令不可用或输出不合法返回 null */
async function remoteFileSha256(ssh: RemoteSsh, target: string): Promise<string | null> {
  const result = await ssh.exec(`sha256sum ${shellQuote(target)}`);
  if (result.code !== 0) return null;
  const hash = result.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
}

/**
 * 确保远端可执行文件与本机携带产物一致：缺失 / 哈希不一致 / 哈希读不出都覆盖上传。
 *
 * 覆盖走「上传临时名 + `mv` 原子换名」：目标可能正被一个在跑的 daemon 执行（它的
 * 状态文件可能已丢失，我们无从得知它在跑），对执行中的文件直接覆盖写是 `ETXTBSY`
 * （SFTP 层报 `Failure`）；`mv` 是 rename，只换目录项，运行中的进程继续用旧 inode。
 * 返回是否发生了上传（调用方据此打部署日志）。
 */
async function ensureRemoteBinary(
  ssh: RemoteSsh,
  localBinary: string,
  remoteBinary: string,
): Promise<boolean> {
  const existing = await ssh.stat(remoteBinary);
  const matches = existing.exists
    ? await remoteBinaryMatches(ssh, localBinary, remoteBinary)
    : false;
  if (matches) return false;
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
 * 文件名恒为 `rg`），先按这个名字 stat；真要上传时才 `uname -sm` 挑本机对应平台的产物。
 * 本机产物里没有这份 rg 属于构建不完整，直接报错（`DEVELOPMENT.md` 第 12 章）。
 */
async function ensureRemoteRipgrep(
  ssh: RemoteSsh,
  options: RemoteBootstrapOptions,
  home: string,
): Promise<void> {
  const remoteRipgrep = posixJoin(
    home,
    REMOTE_BIN_DIR,
    CORE_RIPGREP_DIR,
    bundledRipgrepFileName('linux'),
  );
  if ((await ssh.stat(remoteRipgrep)).exists) return;

  const target = await detectRemoteTarget(ssh);
  const localBinary = resolveCoreBinary(options.extensionPath, target.platform, target.arch);
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
  if (!state) {
    // 状态文件缺失 / 损坏不等于没有 daemon（文件可能被外部清掉而进程还在跑）：
    // 这里只记录事实，由调用方决定「按没有处理」之后的路径（版本门禁 / start 的
    // 端口重试都会兜住）。不打这行，故障现场就一条 ssh 日志都没有。
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

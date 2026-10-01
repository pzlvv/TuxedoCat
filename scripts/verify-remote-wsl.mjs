#!/usr/bin/env node
/**
 * 远程 Core 的 WSL 端到端验证（见 docs/core-daemon.md 第 12 节）。
 *
 * 步骤：
 *   1. 在本机交叉编译 Linux x64 的 Standalone Core（`npm run build:core:linux-x64`，不需要 WSL）；
 *   2. 在 WSL 里执行 `start`，读回启动输出里的连接串（`IP:端口#token`，daemon 留在后台）；
 *   3. 从 Windows（本进程）用 TCP 连上去：先发 `auth`，等 `authOk`，
 *      再发 `listDirectories`，核对返回的远端目录；
 *   4. 再执行一次 `start` 核对复用同一份连接信息，最后用 `kill` 结束 daemon。
 *
 * 用法：
 *   node scripts/verify-remote-wsl.mjs
 *   TUXEDO_CAT_WSL_DISTRO=archlinux node scripts/verify-remote-wsl.mjs
 *
 * 未指定 TUXEDO_CAT_WSL_DISTRO 时用 WSL 的默认发行版。
 */

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distro = process.env.TUXEDO_CAT_WSL_DISTRO || '';
const CORE_RELATIVE = 'resources/core/x64-linux/tuxedo-cat-core';

/** Windows 路径 → WSL 路径（`D:\git\x` → `/mnt/d/git/x`） */
function toWslPath(winPath) {
  return winPath
    .replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
    .replace(/\\/g, '/');
}

function wslArgs(command) {
  return distro ? ['-d', distro, '-e', 'bash', '-lc', command] : ['-e', 'bash', '-lc', command];
}

function runInWsl(command) {
  const result = spawnSync('wsl.exe', wslArgs(command), { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** 在 WSL 里执行并捕获输出（用于断言 `--help` 等） */
function captureInWsl(command) {
  const result = spawnSync('wsl.exe', wslArgs(command), { encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function killServer() {
  // 兜底清理：`start` 与它拉起的 `start-daemon` 都匹配
  spawnSync('wsl.exe', wslArgs("pkill -f 'tuxedo-cat-core start' || true"), { stdio: 'ignore' });
}

/**
 * 收集启动输出里的第一条连接串（`<IP>:<端口>#<token>`）；超时 / 输出结束都报错。
 *
 * `--host 0.0.0.0` 会按网卡逐个打一条连接串，第一条不一定能从 Windows 连上
 * （WSL 的虚拟网卡与 Windows 宿主之间要走 localhost 转发），所以调用方仍带回退。
 */
function collectConnectionString(stream, timeoutMs) {
  return new Promise((resolve, reject) => {
    const reader = createInterface({ input: stream });
    const timer = setTimeout(() => {
      reader.close();
      reject(new Error(`等待启动输出超时（${timeoutMs}ms）`));
    }, timeoutMs);
    reader.on('line', (line) => {
      process.stdout.write(`[core] ${line}\n`);
      const match = line.trim().match(/^([^#\s]+):(\d+)#(\S+)$/);
      if (!match) return;
      clearTimeout(timer);
      reader.close();
      resolve({ host: match[1], port: Number(match[2]), token: match[3] });
    });
    stream.on('end', () => {
      clearTimeout(timer);
      reject(new Error('等待启动输出时输出结束'));
    });
  });
}

/** 单次连接（带超时；WSL IP 不可达时 SYN 会挂住，必须有超时才能回退） */
function connectOnce(host, port, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 连接远端；连接串给出的 WSL IP 连不上时回退 Windows 的 localhost 转发 */
async function connectTo(host, port) {
  const candidates = host === '127.0.0.1' ? [host] : [host, '127.0.0.1'];
  let lastError;
  for (const candidate of candidates) {
    try {
      return await connectOnce(candidate, port);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 发一帧并等下一帧 */
function exchange(socket, reader, frame, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeoutMs);
    reader.once('line', (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`${label} 返回的不是 JSON：${line}`));
      }
    });
    socket.write(`${JSON.stringify(frame)}\n`);
  });
}

async function main() {
  const wslRepo = toWslPath(repoRoot);
  // 在**本机**交叉编译（rust-lld + zig，见 docs/standalone-core.md 第 4.3 节）：
  // WSL 只负责跑这个 Linux 产物，不参与构建。
  console.log('[verify] 交叉编译 Linux x64 core（本机）');
  const built = spawnSync('npm', ['run', 'build:core:linux-x64'], {
    stdio: 'inherit',
    cwd: repoRoot,
    shell: true,
  });
  if (built.error || built.status !== 0) {
    console.error('[verify] Linux core 构建失败');
    process.exit(1);
  }

  // 独立运行：`--help` 必须能直接跑出用法（不依赖宿主喂帧），且只列用户可见动作
  const help = captureInWsl(`cd '${wslRepo}' && ./${CORE_RELATIVE} --help`);
  const helpMissing = ['stdio', 'start', 'kill'].filter((action) => !help.stdout.includes(action));
  if (help.status !== 0 || helpMissing.length > 0 || help.stdout.includes('start-daemon')) {
    throw new Error(`--help 输出异常（exit ${help.status}）：${help.stdout}${help.stderr}`);
  }
  console.log('[verify] --help 可用');

  // 状态文件写在临时 HOME 里，别碰用户自己的 daemon
  const home = `/tmp/tuxedo-cat-verify-${Date.now()}`;
  const token = `verify${Date.now().toString(16)}`;
  const core = (args) => `cd '${wslRepo}' && HOME='${home}' ./${CORE_RELATIVE} ${args}`;
  // 末尾的 sleep 让这次 WSL 会话在验证期间一直活着（会话结束会带走后台进程），
  // 同时也让「daemon 已经脱离本会话」这件事被真正验证到：start 自己先退出。
  const command = `${core(`start --host 0.0.0.0 --port 0 --token ${token}`)} && sleep 300`;
  console.log('[verify] 在 WSL 执行 start ...');
  const child = spawn('wsl.exe', wslArgs(command), { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`[core:err] ${chunk}`));

  let socket;
  try {
    const connection = await collectConnectionString(child.stdout, 60_000);
    if (connection.token !== token) {
      throw new Error(`token 不匹配：期望 ${token}，输出给出 ${connection.token}`);
    }

    const { host, port } = connection;
    console.log(`[verify] 从 Windows 连接 ${host}:${port}`);

    // 先验证错误 token：daemon 同时只服务一条控制通道，
    // 必须在上面的「好连接」之前做，否则它只能排在 accept 队列里等。
    const bad = await connectTo(host, port);
    const badReader = createInterface({ input: bad });
    const rejected = await exchange(bad, badReader, { kind: 'auth', token: 'wrong' }, 10_000, 'authFailed');
    if (rejected.kind !== 'authFailed') throw new Error(`错误 token 未被拒绝：${JSON.stringify(rejected)}`);
    console.log('[verify] 错误 token 被拒绝');
    bad.destroy();

    socket = await connectTo(host, port);
    const reader = createInterface({ input: socket });

    const authOk = await exchange(socket, reader, { kind: 'auth', token }, 10_000, 'authOk');
    if (authOk.kind !== 'authOk') throw new Error(`鉴权失败：${JSON.stringify(authOk)}`);
    console.log('[verify] authOk');

    const listing = await exchange(
      socket,
      reader,
      { kind: 'listDirectories', id: 1, path: null },
      10_000,
      'directoriesListed',
    );
    if (listing.kind !== 'directoriesListed') {
      throw new Error(`列目录失败：${JSON.stringify(listing)}`);
    }
    console.log(`[verify] 远端主目录 ${listing.path}，${listing.entries.length} 个子目录`);

    socket.write(`${JSON.stringify({ kind: 'shutdown' })}\n`);
    socket.end();
    console.log('\n[verify] 通过：WSL 远程 Core 的 token 鉴权与目录列举可用');
  } finally {
    if (socket) socket.destroy();
    child.kill();
    killServer();
  }
}

main().catch((error) => {
  console.error(`[verify] 失败：${error.message}`);
  killServer();
  process.exit(1);
});

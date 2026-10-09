/**
 * 后台 watch 构建器（npm run watch:ext / VS Code 后台任务）
 *
 * 仅监听 VS Code 扩展相关构建：
 * - esbuild：src/extension.ts -> dist/extension.js
 * - tsc：类型检查（--noEmit --watch）
 * - vite：src/webview -> dist/webview
 *
 * 初次构建完成后输出 "watch:ext: ready"（供 VS Code 后台任务问题匹配器识别）。
 * 之后源码变化会在后台自动重建，按 F5 启动时无需再全量构建，大幅加速。
 *
 * 已运行的实例会通过 pid 锁识别：重复触发（例如再次按 F5）时直接标记 ready 退出，
 * 复用已有 watcher，避免每次启动都重新全量构建。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(ROOT, '.watch-ext.pid');

/** 初次构建就绪的判定产物（文件名稳定） */
const READY_TARGETS = [
  'dist/extension.js',
  'dist/webview/index.html',
];

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  try {
    return parseInt(fs.readFileSync(LOCK_FILE, 'utf-8'), 10);
  } catch {
    return null;
  }
}

function writeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
  } catch {
    // 写锁失败不阻塞启动
  }
}

function removeLock() {
  try {
    const pid = readLockPid();
    if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

console.log('watch:ext: start');

// 已有 watcher 在运行：直接 ready 退出，避免重复构建
const existingPid = readLockPid();
if (existingPid && existingPid !== process.pid && isAlive(existingPid)) {
  console.log(`watch:ext: ready (reusing existing watcher pid ${existingPid})`);
  process.exit(0);
}

// watcher 不监听 assets/resources，先复制一次静态资源（含按 Core 变体清理多余的 rg）
try {
  execSync('node scripts/copy-assets.mjs', { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  console.error('[watch:ext] copy-assets failed:', err);
}

writeLock();

const watchers = [
  { name: 'esbuild', command: 'npm run watch:esbuild' },
  { name: 'tsc', command: 'npm run watch:tsc' },
  { name: 'webview', command: 'npm run watch:webview' },
];

const procs = watchers.map((w) => {
  // shell: true 兼容 Windows（npm.cmd 直接 spawn 在部分 Node 版本上报 EINVAL）
  const p = spawn(w.command, { cwd: ROOT, stdio: 'inherit', shell: true });
  p.on('error', (err) => console.error(`[watch:ext] ${w.name} watcher error:`, err));
  p.watchName = w.name;
  return p;
});

// 任一 watcher 退出则整体退出（清理 pid 锁）
let shuttingDown = false;
for (const p of procs) {
  p.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[watch:ext] ${p.watchName || 'watcher'} exited (${code}); stopping all`);
    for (const q of procs) {
      try {
        q.kill();
      } catch {
        // ignore
      }
    }
    process.exit(code ?? 0);
  });
}

process.on('exit', removeLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// 轮询初次构建产物，全部就绪后输出 ready
const startMs = Date.now() - 1500; // 缓冲文件系统时间戳精度
let readyPrinted = false;

function isReady() {
  return READY_TARGETS.every((rel) => {
    try {
      return fs.statSync(path.join(ROOT, rel)).mtimeMs > startMs;
    } catch {
      return false;
    }
  });
}

const timer = setInterval(() => {
  if (!readyPrinted && isReady()) {
    readyPrinted = true;
    console.log('watch:ext: ready');
  }
}, 500);

// 安全兜底：初次构建长时间未就绪（如构建报错卡住）时，超时后仍标记 ready，
// 避免 F5 一直等待。watcher 后续修复后会自动重建 dist。
setTimeout(() => {
  if (!readyPrinted) {
    readyPrinted = true;
    console.warn('[watch:ext] initial build not ready within timeout; proceeding with existing dist');
    console.log('watch:ext: ready');
  }
}, 120000);

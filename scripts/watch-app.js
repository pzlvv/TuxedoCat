/**
 * 后台 watch 构建器（npm run watch:app / VS Code 后台任务）
 *
 * 并行启动 webview / monaco / sidebar / titlebar / remoteWorkspace / electron 的 watch 构建，
 * 初次构建完成后输出 "watch:app: ready"（供 VS Code 后台任务问题匹配器识别）。
 * 之后源码变化会在后台自动重建，按 F5 启动时无需再全量构建，大幅加速。
 *
 * 已运行的实例会通过 pid 锁识别：重复触发（例如再次按 F5）时直接标记 ready 退出，
 * 复用已有 watcher，避免每次启动都重新全量构建。
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(ROOT, '.watch-app.pid');

/** 初次构建就绪的判定产物（文件名稳定） */
const READY_TARGETS = [
  'dist/webview/index.html',
  'dist/monaco/index.html',
  'dist/sidebar/index.html',
  'dist/titlebar/index.html',
  'dist/remoteWorkspace/index.html',
  'dist-electron/main.cjs',
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

console.log('watch:app: start');

// 已有 watcher 在运行：直接 ready 退出，避免重复构建
const existingPid = readLockPid();
if (existingPid && existingPid !== process.pid && isAlive(existingPid)) {
  console.log(`watch:app: ready (reusing existing watcher pid ${existingPid})`);
  process.exit(0);
}

// watcher 不监听 assets/resources，先复制一次静态资源
try {
  execSync(
    `node -e "require('fs').cpSync('assets','dist/assets',{recursive:true});require('fs').cpSync('resources','dist/resources',{recursive:true})"`,
    { cwd: ROOT, stdio: 'inherit' }
  );
} catch (err) {
  console.error('[watch:app] copy-assets failed:', err);
}

writeLock();

const watchers = [
  { name: 'webview', command: 'npm run watch:webview' },
  { name: 'monaco', command: 'npm run watch:monaco' },
  { name: 'sidebar', command: 'npm run watch:sidebar' },
  { name: 'titlebar', command: 'npm run watch:titlebar' },
  { name: 'remoteWorkspace', command: 'npm run watch:remoteWorkspace' },
  { name: 'electron', command: 'npm run watch:electron' },
];

const procs = watchers.map((w) => {
  // shell: true 兼容 Windows（npm.cmd 直接 spawn 在部分 Node 版本上报 EINVAL）
  const p = spawn(w.command, { cwd: ROOT, stdio: 'inherit', shell: true });
  p.on('error', (err) => console.error(`[watch:app] ${w.name} watcher error:`, err));
  p.watchName = w.name;
  return p;
});

// 任一 watcher 退出则整体退出（清理 pid 锁）
let shuttingDown = false;
for (const p of procs) {
  p.on('exit', (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[watch:app] ${p.watchName || 'watcher'} exited (${code}); stopping all`);
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

// ==================== Rust Core 重建 ====================
//
// cargo 没有内置 watch，这里也不引入 `cargo-watch` 依赖：轮询 `core-rs` 下
// `.rs` / `Cargo.toml` 的 mtime，变化时跑一次 `npm run build:core:host`
// （release 构建，产物直接落 `resources/core/<平台>/`，即宿主加载的那份）。
//
// 与前端 watcher 解耦：**不**放进 `watchers` 数组——构建失败只打日志，
// 不会触发「任一 watcher 退出则整体退出」，也不阻塞 F5。
// 只监听变化、不在启动时构建：源码没动时开 watch 不会白等一次 40s 的 release 构建。
// 设 `WATCH_CORE=0` 可关闭（只想改前端时省一份 CPU）。
const CORE_WATCH_ENABLED = process.env.WATCH_CORE !== '0';
const CORE_DIR = path.join(ROOT, 'core-rs');
const CORE_SOURCES = ['src', 'Cargo.toml'];
const CORE_POLL_MS = 1500;
const CORE_DEBOUNCE_MS = 800;

/** 递归收集 core-rs 下受关注文件的 mtime（相对路径 → mtimeMs） */
function snapshotCoreMtimes() {
  const snapshot = new Map();
  const visit = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) visit(path.join(target, entry));
      return;
    }
    if (!target.endsWith('.rs') && !target.endsWith('Cargo.toml')) return;
    snapshot.set(path.relative(ROOT, target), stat.mtimeMs);
  };
  for (const rel of CORE_SOURCES) visit(path.join(CORE_DIR, rel));
  return snapshot;
}

function coreSnapshotChanged(previous, next) {
  if (previous.size !== next.size) return true;
  for (const [key, mtime] of next) {
    if (previous.get(key) !== mtime) return true;
  }
  return false;
}

if (CORE_WATCH_ENABLED && fs.existsSync(CORE_DIR)) {
  let snapshot = snapshotCoreMtimes();
  let rebuilding = false;
  let pending = false;

  const rebuild = () => {
    if (rebuilding) {
      // 构建期间又改了：等这次结束后再补一次，避免丢掉最后一次修改
      pending = true;
      return;
    }
    rebuilding = true;
    // 只重建当前平台：`npm run build:core` 会连 Linux 那份一起编（打包要携带的全部平台），
    // 本地调试用不上，还平白要求装 zig。见 docs/standalone-core.md 第 4.3 节。
    console.log('[watch:app] core-rs changed; rebuilding Rust core (npm run build:core:host)...');
    const child = spawn('npm run build:core:host', { cwd: ROOT, stdio: 'inherit', shell: true });
    child.on('error', (err) => {
      console.error('[watch:app] core rebuild failed to start:', err);
    });
    child.on('exit', (code) => {
      rebuilding = false;
      if (code === 0) {
        console.log('[watch:app] core rebuild done');
      } else {
        console.error(`[watch:app] core rebuild exited (${code}); keeping previous binary`);
      }
      if (pending) {
        pending = false;
        rebuild();
      }
    });
  };

  let debounce = null;
  setInterval(() => {
    const next = snapshotCoreMtimes();
    if (!coreSnapshotChanged(snapshot, next)) return;
    snapshot = next;
    // 编辑器保存常常一次触发多个文件（如 rustfmt 重排），去抖后再构建
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(rebuild, CORE_DEBOUNCE_MS);
    if (debounce.unref) debounce.unref();
  }, CORE_POLL_MS).unref?.();
} else if (CORE_WATCH_ENABLED) {
  console.warn(`[watch:app] ${path.relative(ROOT, CORE_DIR)} not found; skipping Rust core watcher`);
}

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
    console.log('watch:app: ready');
  }
}, 500);

// 安全兜底：初次构建长时间未就绪（如构建报错卡住）时，超时后仍标记 ready，
// 避免 F5 一直等待。watcher 后续修复后会自动重建 dist。
setTimeout(() => {
  if (!readyPrinted) {
    readyPrinted = true;
    console.warn('[watch:app] initial build not ready within timeout; proceeding with existing dist');
    console.log('watch:app: ready');
  }
}, 120000);

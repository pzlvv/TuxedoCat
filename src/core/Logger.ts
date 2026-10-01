import * as fs from 'fs';
import * as path from 'path';
import { ENV_PREFIX, LOG_FILE_NAME } from '../config/project.js';
import { resolveConfigDir } from '../config/configDir.js';
import { requireEventBus } from './AssistantEventBus.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIXES: Record<LogLevel, string> = {
  debug: '[DEBUG]',
  info: '[INFO]',
  warn: '[WARN]',
  error: '[ERROR]',
};

let logToConsole = false;

/* -------------------------------------------------------------------------- */
/*                                  配置                                       */
/* -------------------------------------------------------------------------- */

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// 配置目录口径与宿主 `SettingsStore` / Core 侧一致，见 `config/configDir.ts`
const LOG_DIR = path.join(resolveConfigDir(), 'logs');
const LOG_FILE = path.join(LOG_DIR, LOG_FILE_NAME);
/** 轮转互斥锁，保证多实例（VS Code / Electron）不会同时轮转 */
const LOCK_FILE = `${LOG_FILE}.lock`;

/** 单个日志文件大小上限，默认 5MB */
const MAX_FILE_SIZE = readPositiveIntEnv(`${ENV_PREFIX}_LOG_MAX_SIZE`, 5 * 1024 * 1024);
/** 日志文件总数上限，默认 4（1 个活动文件 + 3 个轮转备份） */
const MAX_FILES = Math.max(2, readPositiveIntEnv(`${ENV_PREFIX}_LOG_MAX_FILES`, 4));
const MAX_BACKUPS = MAX_FILES - 1;

/** 缓冲区达到该大小立即落盘 */
const FLUSH_THRESHOLD_BYTES = 8 * 1024;
/** 定时落盘间隔，避免低频日志长时间滞留内存 */
const FLUSH_INTERVAL_MS = 100;

/** 锁文件超过该时长未更新视为陈旧锁（持有者可能已崩溃） */
const LOCK_STALE_MS = 15_000;
const LOCK_MAX_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 10;

/** 进程标识，写入每行日志，便于区分同时写同一文件的多个实例 */
const PID = process.pid;

/* -------------------------------------------------------------------------- */
/*                                写入缓冲                                     */
/* -------------------------------------------------------------------------- */

/**
 * 待落盘日志。批量写入有两个目的：
 * 1. 减少系统调用；
 * 2. 保证单次 append 的数据量足够小，跨进程追加时不会被拆分成多次写而交错。
 */
let pending: string[] = [];
let pendingBytes = 0;
let flushTimer: NodeJS.Timeout | null = null;

function ensureLogDir(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch {
    // 目录创建失败时忽略，写入会降级为无文件日志
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
  // 不因等待日志落盘而阻止进程退出，退出时由 exit 钩子兜底
  flushTimer.unref?.();
}

/* -------------------------------------------------------------------------- */
/*                                跨进程锁                                     */
/* -------------------------------------------------------------------------- */

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但没有权限发信号
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function isLockStale(): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(LOCK_FILE);
  } catch {
    // 锁已不存在，可立即重试
    return true;
  }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;

  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const pid = Number.parseInt(raw.trim().split(/\s+/)[0] ?? '', 10);
    if (Number.isFinite(pid) && pid > 0 && !isProcessAlive(pid)) return true;
  } catch {
    // 读取失败（例如锁刚创建还未写入内容），交给 mtime 判断
  }
  return false;
}

function sleepSync(ms: number): void {
  try {
    // 主线程可用的同步休眠（Node 环境支持）
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* 退化方案：忙等 */
    }
  }
}

/**
 * 获取轮转锁。
 *
 * 使用 `wx`（O_CREAT | O_EXCL）打开锁文件，该操作在操作系统层面是原子的，
 * 因此同一时刻只有一个进程能成功创建，其余进程会收到 EEXIST。
 * 若锁持有者已崩溃（mtime 过旧或 pid 已不存在），则抢占该陈旧锁。
 */
function acquireRotationLock(): boolean {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      try {
        fs.writeSync(fd, `${PID} ${Date.now()}`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
      if (isLockStale()) {
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          // 其他进程可能已抢先清理，忽略
        }
        continue;
      }
      if (attempt < LOCK_MAX_ATTEMPTS - 1) sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
  return false;
}

function releaseRotationLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // 锁可能已被判定为陈旧并被清理，忽略
  }
}

/* -------------------------------------------------------------------------- */
/*                                  轮转                                       */
/* -------------------------------------------------------------------------- */

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // 文件不存在或被占用，忽略
  }
}

function safeRename(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    // Windows 上文件被其他进程短暂占用时可能失败，忽略并留待下次轮转
  }
}

function rotateLogFiles(): void {
  safeUnlink(`${LOG_FILE}.${MAX_BACKUPS}`);
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const src = `${LOG_FILE}.${i}`;
    if (fs.existsSync(src)) safeRename(src, `${LOG_FILE}.${i + 1}`);
  }
  if (fs.existsSync(LOG_FILE)) safeRename(LOG_FILE, `${LOG_FILE}.1`);
}

/**
 * 写入前判断是否需要轮转。
 *
 * 先做一次无锁快速判断，只有估算超限时才去竞争锁；拿到锁后必须基于磁盘真实
 * 大小重新确认，因为等待锁的过程中其他实例可能已经完成轮转。
 */
function rotateIfNeeded(pendingSize: number): void {
  let size: number;
  try {
    size = fs.statSync(LOG_FILE).size;
  } catch {
    size = 0; // 文件尚不存在
  }
  if (size + pendingSize <= MAX_FILE_SIZE) return;

  if (!acquireRotationLock()) {
    // 其他实例正在轮转：直接追加即可，下次落盘再评估
    return;
  }
  try {
    let actual: number;
    try {
      actual = fs.statSync(LOG_FILE).size;
    } catch {
      actual = 0;
    }
    if (actual + pendingSize <= MAX_FILE_SIZE) return;
    rotateLogFiles();
  } finally {
    releaseRotationLock();
  }
}

/* -------------------------------------------------------------------------- */
/*                                落盘 / 格式化                                */
/* -------------------------------------------------------------------------- */

/** 将缓冲区同步写入磁盘。使用 appendFileSync 保证每次都追加到"当前"文件。 */
function flush(): void {
  if (pending.length === 0) return;

  const text = pending.join('');
  const bytes = Buffer.byteLength(text);
  pending = [];
  pendingBytes = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    ensureLogDir();
    rotateIfNeeded(bytes);
    // 'a' 模式在多数平台上以 O_APPEND 打开，小数据量单次写入是原子的，
    // 因此多个实例并发追加不会互相覆盖。
    fs.appendFileSync(LOG_FILE, text);
  } catch {
    // 日志写入失败不应影响主流程
  }
}

/** 供外部（测试 / 优雅退出）强制落盘。 */
export function flushLogs(): void {
  flush();
}

/** 返回当前日志文件路径。 */
export function getLogFilePath(): string {
  return LOG_FILE;
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'bigint') return arg.toString();
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      arg,
      (_key, value: unknown) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return typeof value === 'bigint' ? value.toString() : value;
      },
      2,
    );
  } catch {
    try {
      return String(arg);
    } catch {
      return '[Unserializable]';
    }
  }
}

export function setLogToConsole(enabled: boolean): void {
  logToConsole = enabled;
}

/**
 * 把日志行发给 UI，由 UI 写自己的出口（VS Code 是 OutputChannel，Electron 是 console）。
 *
 * 日志出口是宿主差异，core 不持有宿主的输出通道。总线未注册（模块初始化早期）或
 * UI 尚未注册处理器时静默跳过——与「没有日志出口」同一口径，不影响主流程。
 */
function emitLogToUi(message: string): void {
  try {
    requireEventBus().emitToUi({ type: 'log', message });
  } catch {
    // 总线 / UI 处理器尚未就绪：日志只落盘
  }
}

function log(level: LogLevel, component: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const prefix = `${PREFIXES[level]} [pid:${PID}] [${component}]`;
  const message = `${prefix} ${timestamp} ${args.map(formatArg).join(' ')}`;

  if (logToConsole) {
    console.error(prefix, timestamp, ...args);
  }

  const line = `${message}\n`;
  pending.push(line);
  pendingBytes += Buffer.byteLength(line);

  // error 立即落盘以保证崩溃前可见，其余走批量缓冲
  if (level === 'error' || pendingBytes >= FLUSH_THRESHOLD_BYTES) {
    flush();
  } else {
    scheduleFlush();
  }

  emitLogToUi(message);
}

// 进程退出时兜底落盘，避免缓冲区中的日志丢失
process.once('exit', flush);
process.once('beforeExit', flush);

export const logger = {
  debug: (component: string, ...args: unknown[]) => log('debug', component, ...args),
  info: (component: string, ...args: unknown[]) => log('info', component, ...args),
  warn: (component: string, ...args: unknown[]) => log('warn', component, ...args),
  error: (component: string, ...args: unknown[]) => log('error', component, ...args),
};

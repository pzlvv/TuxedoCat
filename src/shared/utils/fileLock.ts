/**
 * 跨进程文件锁（`docs/architecture/core-ui-separation.md` 第 4.6 节）。
 *
 * 同一台机器上会有多个宿主进程同时读写同一份共享文件（VS Code 扩展宿主 + 多个
 * Electron 实例），而「读-改-写」在没有互斥时既不原子也不安全。这里的锁基于
 * `wx`（O_CREAT | O_EXCL）打开锁文件：该操作在操作系统层面是原子的，同一时刻只有
 * 一个进程能成功创建，其余进程收到 EEXIST。
 *
 * 陈旧锁会被抢占：持有者崩溃时不会留下永久锁。判据是「锁文件 mtime 过旧」或
 * 「锁里记录的 pid 已不存在」。
 *
 * 两个入口：
 * - `withFileLock`：异步，供异步写入路径使用；
 * - `acquireLockSync` / `releaseLockSync`：同步，供无法异步化的路径使用（如日志落盘）。
 *
 * 注意：锁只保证**协作进程**之间的互斥。写入本身仍必须是原子的（写临时文件再
 * `rename`），否则不遵守本约定的读者仍可能看到半截文件。
 */

import * as fs from 'fs';

/** 锁文件过期时间：超过这个时长仍未被释放，视为持有者已崩溃 */
export const LOCK_STALE_MS = 15_000;
/** 获取锁的最大尝试次数（同步路径：`sleepSync` 占着主线程，预算必须小） */
const LOCK_MAX_ATTEMPTS = 20;
/** 异步路径的获取预算：`withFileLock` 每次重试都让出事件循环，可以等得更久。
 * 共写进程多且机器负载高时锁会长时间饱和，预算太小会让「保存设置」这类用户操作
 * 无谓地抛错；总等待仍远小于 `LOCK_STALE_MS`，不会与陈旧锁抢占语义纠缠。 */
const LOCK_ASYNC_MAX_ATTEMPTS = 200;
/** 两次尝试之间的间隔 */
const LOCK_RETRY_DELAY_MS = 10;

/** rename 瞬时失败的重试参数：指数退避，封顶 `RENAME_RETRY_MAX_MS` */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_BASE_MS = 5;
const RENAME_RETRY_MAX_MS = 100;

/** 当前进程 pid（写入锁文件，供陈旧判定） */
const PID = process.pid;

/** 进程是否存活（用于判定陈旧锁） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但没有权限发信号
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 锁是否已陈旧（持有者崩溃 / 锁文件过旧） */
export function isLockStale(lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    // 锁已不存在，可立即重试
    return true;
  }
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;

  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 尝试创建锁文件一次；成功返回 true */
function tryCreateLock(lockPath: string): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, `${PID} ${Date.now()}`);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return false;
    if (isLockStale(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // 其他进程可能已抢先清理，忽略
      }
      return tryCreateLock(lockPath);
    }
    return false;
  }
}

/** 释放锁（幂等：锁已被判定陈旧并被清理时不报错） */
export function releaseLockSync(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // 忽略
  }
}

/**
 * 同步获取锁。返回是否拿到（拿不到时调用方必须放弃写入，不能当作成功）。
 */
export function acquireLockSync(lockPath: string): boolean {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    if (tryCreateLock(lockPath)) return true;
    if (attempt < LOCK_MAX_ATTEMPTS - 1) sleepSync(LOCK_RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Windows 上 `rename` 覆盖已有文件可能瞬时 `EPERM` / `EACCES`：目标正被一个不带
 * 删除共享位的句柄占住——最常见是杀毒软件 / 索引器接管了刚落盘的文件（`graceful-fs`
 * 对同一问题就是这么处理的）。这类占用是毫秒级的，有限次退避重试即可穿过；
 * 重试用尽或非瞬时错误原样抛出，不做静默降级。
 */
async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  let delay = RENAME_RETRY_BASE_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.promises.rename(tmpPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const transient = code === 'EPERM' || code === 'EACCES';
      if (!transient || attempt >= RENAME_MAX_ATTEMPTS) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, RENAME_RETRY_MAX_MS);
    }
  }
}

/**
 * 在跨进程互斥下执行 `fn`。
 *
 * 拿不到锁时抛错而不是继续执行：调用方要写的是共享文件，无锁写入会覆盖其它进程的
 * 修改（`docs/architecture/core-ui-separation.md` 第 4.6 节「后写覆盖」只适用于成功拿到锁的串行化）。
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_ASYNC_MAX_ATTEMPTS; attempt++) {
    if (tryCreateLock(lockPath)) {
      acquired = true;
      break;
    }
    if (attempt < LOCK_ASYNC_MAX_ATTEMPTS - 1) await sleep(LOCK_RETRY_DELAY_MS);
  }
  if (!acquired) {
    throw new Error(`failed to acquire file lock: ${lockPath}`);
  }
  try {
    return await fn();
  } finally {
    releaseLockSync(lockPath);
  }
}

/**
 * 原子写入：先写同目录临时文件再 `rename` 覆盖目标。
 *
 * 直接 `writeFile` 会先把目标截断再写入，并发读者会看到空文件或半截内容；
 * `rename` 在同一文件系统内是原子的，读者只会看到「旧内容」或「新内容」。
 */
export async function writeFileAtomic(
  filePath: string,
  data: string,
  tmpPath: string,
): Promise<void> {
  await fs.promises.writeFile(tmpPath, data, 'utf-8');
  try {
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    // rename 失败时清掉临时文件，避免残留
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

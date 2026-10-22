/**
 * 本地查看器文件的文件系统监听（specs/018 FR-001 / FR-005）。
 *
 * 监听目标文件的**父目录**并按 basename 过滤：编辑器常见的「写临时文件 + rename」
 * 会让文件级 watcher 失效，父目录监听能同时捕获 replace / delete / recreate。
 * 事件按 50ms 去抖；最终以 `stat` 结果判定 changed / deleted。
 *
 * 本模块只做 fs 监听，不读文件内容、不碰 Electron 窗口；内容判重与刷新由
 * `electron/viewerWatch.ts` 的控制器负责。
 */

import * as fs from 'fs';
import * as path from 'path';

/** 去抖窗口（与 Core 侧 `file_watch.rs` 同一口径） */
const DEBOUNCE_MS = 50;

/** Windows 目录项大小写不敏感（与 Core 侧 `file_watch.rs` 的 `same_name` 同一口径） */
const CASE_INSENSITIVE_NAMES = process.platform === 'win32';

/** basename 比较：Windows 不区分大小写——换大小写重建（删除后以 `README.MD` 重建）的目录项名与监听目标字面不同，精确比较会漏掉 */
function sameBasename(left: string, right: string): boolean {
  return CASE_INSENSITIVE_NAMES ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export type LocalWatchEvent =
  | { kind: 'changed' }
  | { kind: 'deleted' }
  | { kind: 'error'; error: string };

export interface LocalWatchHandle {
  close(): void;
}

/**
 * 监听一个本地文件的变更。
 *
 * 父目录不存在 / 无权限时通过 `onEvent({ kind: 'error' })` 上报，不抛出到调用方；
 * 返回的 handle 仍然可安全 `close()`（关闭 / 顶替竞态下幂等）。
 */
export function createLocalFileWatcher(
  filePath: string,
  onEvent: (event: LocalWatchEvent) => void,
  log: (...args: unknown[]) => void,
): LocalWatchHandle {
  const parent = path.dirname(filePath);
  const targetName = path.basename(filePath);
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let checking = false;
  let pending = false;

  const report = (event: LocalWatchEvent): void => {
    if (closed) return;
    onEvent(event);
  };

  const check = async (): Promise<void> => {
    if (closed) return;
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) report({ kind: 'changed' });
      else report({ kind: 'deleted' });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') report({ kind: 'deleted' });
      else report({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      checking = false;
      if (pending && !closed) {
        pending = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, DEBOUNCE_MS);
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(parent, { persistent: true }, (_eventType, filename) => {
      // 某些平台 / 场景 filename 为 null：无法过滤时按可能命中处理，最终 stat 会收敛。
      if (filename && !sameBasename(path.basename(filename.toString()), targetName)) return;
      schedule();
    });
    watcher.on('error', (err) => {
      report({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
    });
  } catch (err) {
    log(`[viewer-watch] failed to watch ${parent}: ${err}`);
    report({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
  }

  return {
    close: () => {
      if (closed) return;
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}

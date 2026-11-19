/**
 * src/host/overlayOpenResolve.ts - 工具卡片文件链接的 Overlay 归属判定（纯函数）
 *
 * 点击消息里的文件链接时，宿主必须回答「这份内容该读哪个事实来源」：
 *
 * - 普通会话（`storage: workspace`）→ 真实磁盘 / SFTP，维持既有语义；
 * - Overlay 会话（`storage: isolated`）→ 该会话私有叠加视图，只能经 Core 取数
 *   （`UiRequest.workViewFileDiffRequested`）。宿主进程读 Core 的挂载点得到空目录，
 *   读真实磁盘又拿不到对话内新建的文件——两条都不是「这个会话看到的文件」
 *   （[docs/core/conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)）。
 *
 * 本模块只做判定与路径换算，不读盘、不 import 宿主 API，因此可在单测里直接驱动
 * （`specs/defects/overlay-edit-and-card-links-read-real-disk.md`）。
 *
 * 归属与工作区根都由调用方注入：它们是 Core / main 进程的事实（`meta.json` 的
 * `storage`、会话 → 工作目录索引），本模块不缓存、不猜。
 */

import * as path from 'path';

/** Overlay 链接的取数三元组：会话 id + 真实工作区根 + 视图相对路径 */
export interface OverlayOpenTarget {
  sessionId: string;
  /** 真实工作区根（视图已 bind 到这条路径，因此它同时也是工具输出口径的路径） */
  root: string;
  /** `'/'` 分隔的相对路径（`UiRequest.workViewFileDiffRequested` 的载荷） */
  rel: string;
}

/**
 * 工具卡片的绝对路径 → 该工作区根的视图相对路径（`'/'` 分隔）；不在根内返回 `null`。
 *
 * 卡片的 `file_path` 是真实工作区绝对路径（工具输出口径），而视图取数请求只认相对
 * 路径。远程工作区根是目标机器上的 POSIX 串，必须按 posix 语义解析——Windows 上
 * 用 `path.relative` 会把 `/home/pz` 当成盘符相对路径（与 `resolveWithinRoot` 的
 * `posix` 选项同一结论）。
 *
 * 「根自身」与越界（`..` 上跳）都回 `null`：前者不是可打开的文件，后者不该经链接
 * 触发视图取数。
 */
export function workViewRelForOpen(
  root: string,
  absPath: string,
  options: { posix?: boolean } = {},
): string | null {
  if (!root || !absPath) return null;
  const p = options.posix ? path.posix : path;
  if (!p.isAbsolute(absPath)) return null;
  const rel = p.relative(p.resolve(root), p.resolve(absPath));
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) return null;
  return options.posix ? rel : rel.split(path.sep).join('/');
}

/**
 * 判定一次文件链接打开是否走 Overlay 视图取数；是则给出取数三元组。
 *
 * 判据三条缺一不可：
 * 1. `sessionId` 是**正式会话 id**——`new-` 开头的临时 key 属于「新建但还没收到
 *    sessionId」的视图，那时没有 `meta.json`、也没有视图可读；
 * 2. 该会话归属 `isolated`（Core 写入的事实，缺失即 `workspace`）；
 * 3. 路径落在该会话工作区根内（视图取数只认相对路径；根外文件在 Overlay 会话里同样
 *    读不到，交给既有本地 / SFTP 语义处理即可）。
 *
 * `workspaceRoot` 为 `null`（会话 → 工作目录索引查不到）时判不出相对路径，回 `null`。
 */
export function resolveOverlayOpenTarget(input: {
  sessionId: string | null;
  storage: 'workspace' | 'isolated';
  workspaceRoot: string | null;
  /** 工作区是否在远程机器上（决定相对路径按 posix 还是本机语义解析） */
  remote: boolean;
  /** 卡片链接的文件路径（工具输出口径的真实绝对路径） */
  filePath: string;
}): OverlayOpenTarget | null {
  const { sessionId, storage, workspaceRoot, remote, filePath } = input;
  if (!sessionId || sessionId.startsWith('new-')) return null;
  if (storage !== 'isolated') return null;
  if (!workspaceRoot) return null;
  const rel = workViewRelForOpen(workspaceRoot, filePath, { posix: remote });
  if (rel === null) return null;
  return { sessionId, root: workspaceRoot, rel };
}

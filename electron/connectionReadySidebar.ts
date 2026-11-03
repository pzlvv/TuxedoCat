/**
 * Connection 就绪时的侧栏文件树失效判定
 * （`specs/defects/sidebar-file-tree-stale-after-ssh-reconnect.md`）。
 *
 * 远程（SSH）工作区的两条 SSH 连接互相独立：Core 传输层一条（`sshTransport.ts`），
 * 侧栏文件池一条（`sidebarFilesRemote.ts` 的 `sharedClientFor`）。远端机器没起来时两次
 * 都失败，Core 那侧恢复后重建，侧栏那条在首次失败时已被移出缓存——它不会自己再连，
 * 目录条目就停在错误态，直到用户点错误行或刷新按钮。
 *
 * 因此「Connection 就绪」必须同时是「侧栏文件树缓存失效」的信号。本模块只做判定
 * （纯函数、无宿主依赖）；推送由 `ElectronUIHost.onWorkspaceConnectionReady` 经既有的
 * `sidebar:files-invalidate` 出口完成，不新增 IPC，也不改载荷形状。
 *
 * 本地工作区返回 `null`：本地文件树读的是宿主自己的 fs，与 Core 的 Connection 无关，
 * 走这条链只会白读一次盘。
 */

import { workspaceRefKey, type WorkspaceRef } from '../src/host/workspaceRef.js';

/** 侧栏失效推送的载荷（与 `sidebar:files-invalidate` 既有形状一致） */
export interface FilesInvalidatePayload {
  workspaceId: string;
  reasons: string[];
}

/**
 * 就绪时该工作区的文件树失效载荷；非远程返回 `null`。
 *
 * 与 Write 新建同一 reason（`tree`）：侧栏据此重读根与已展开目录、文档视图开启时
 * 重取数据；从未浏览过的工作区没有缓存可失效（侧栏侧按状态缺失直接 no-op），
 * 不会因此预读目录（US-42 的懒加载口径）。
 */
export function connectionReadyFileInvalidation(ref: WorkspaceRef): FilesInvalidatePayload | null {
  if (ref.endpoint === null) return null;
  return { workspaceId: workspaceRefKey(ref), reasons: ['tree'] };
}

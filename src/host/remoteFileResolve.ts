/**
 * src/host/remoteFileResolve.ts - openFile 路径的远程工作区解析（纯函数）
 *
 * 工具卡片链接的 `filePath` 是 core 读文件时那台机器上的路径：远程会话即使读工作区
 * **外**的文件（/etc/hosts、未打开的兄弟目录），路径也落在本会话所属机器上。
 * 解析分两级（specs/defects/remote-open-file-outside-workspace.md）：
 *
 * 1. 打开集合的 `/` 前缀匹配（调用方按「活动项优先」排好序）：原 ElectronUIHost 语义原样搬入；
 * 2. 前缀不中时回落到来源视图所属工作区——`UIHost.openFile` 第三参把视图交给宿主，
 *    宿主经 `getWorkspaceRefForView` 拿到所属引用后传入这里。
 *
 * 其余一律返回 `null`（维持本地语义）：`view` 为 `null` 时不做活动工作区兜底——
 * 无来源视图就无法判定机器归属，侧栏 `openLocalFile` 等本地调用点不能被误判成远程。
 * 只依赖 `WorkspaceRef`，可在单测里直接使用。
 */

import type { WorkspaceEndpoint, WorkspaceRef } from './workspaceRef.js';

/** 命中的远程工作区引用与其机器上的绝对路径 */
export interface RemoteFileResolution {
  /** 远程工作区引用（`endpoint` 已收窄为非空） */
  ref: WorkspaceRef & { endpoint: WorkspaceEndpoint };
  /** 那台机器上的 POSIX 绝对路径（原样透传，不做规范化） */
  abs: string;
}

/**
 * 把文件路径解析到一台远程机器上；解析不出（本地语义）返回 `null`。
 *
 * `refs`：打开集合，已按「活动项优先」排序；`viewRef`：来源视图所属工作区引用，
 * `undefined` 表示无来源视图（宿主主动调用 / 单视图宿主）。
 */
export function resolveRemoteFileWorkspace(
  filePath: string,
  refs: readonly WorkspaceRef[],
  viewRef: WorkspaceRef | undefined,
): RemoteFileResolution | null {
  if (typeof filePath !== 'string' || !filePath.startsWith('/')) return null;
  for (const ref of refs) {
    const endpoint = ref.endpoint;
    if (!endpoint) continue;
    const root = ref.path.replace(/\/+$/, '');
    if (filePath === root || filePath.startsWith(`${root}/`)) {
      return { ref: { ...ref, endpoint }, abs: filePath };
    }
  }
  // 前缀不中：来源视图所属工作区是远程时，工具路径仍是那台机器上的绝对路径
  const viewEndpoint = viewRef?.endpoint;
  if (viewEndpoint) {
    return { ref: { ...viewRef, endpoint: viewEndpoint }, abs: filePath };
  }
  return null;
}

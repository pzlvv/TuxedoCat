/**
 * 跨工作区派发的目标解析（specs/022 FR-002）。
 *
 * 纯函数：`Agent.target` 的身份 → 打开集合里的目标工作区引用。判定顺序：
 * 1. 等于来源工作区身份 → `local`（按缺省策略建本机子代理）；
 * 2. 未命中 → `missing`（工具错误，不创建对话）；
 * 3. 命中多项 → `ambiguous`（工具错误，不取第一项）；
 * 4. 唯一命中 → `target`。
 */

import type { UiEvent } from '../shared/AssistantEventBus.js';
import { resolveWorkspaceByIdentity, workspaceAgentId } from './workspaceIdentity.js';
import type { WorkspaceRef } from './workspaceRef.js';

/**
 * 跨工作区代理需要的 Connection 形状（`Client` 的 `Connection` 结构上满足它）。
 * 只声明用到的三个成员：工作区引用、就绪判定、下发 UiEvent。
 */
export interface CrossWorkspaceRoute {
  readonly workspaceRef: WorkspaceRef;
  isReady(): boolean;
  emitToCore(event: UiEvent): void;
}

/** 跨工作区代理的路由能力（由 `Client` 提供；测试可用同形桩） */
export interface CrossWorkspaceRouter {
  connectionForSession(sessionId: string): CrossWorkspaceRoute;
  connectionForWorkspace(ref: WorkspaceRef): CrossWorkspaceRoute | undefined;
  /** 登记「会话 → 工作区」（新建的跨工作区子代理会话必须登记，后续 UiEvent 才路由得到） */
  assignSession(sessionId: string, ref: WorkspaceRef): CrossWorkspaceRoute;
}

export type CrossWorkspaceTarget =
  | { kind: 'local' }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }
  | { kind: 'target'; ref: WorkspaceRef };

export function resolveCrossWorkspaceTarget(
  openRefs: readonly WorkspaceRef[],
  originRef: WorkspaceRef,
  targetWorkspaceId: string,
  machineName: string,
): CrossWorkspaceTarget {
  if (workspaceAgentId(originRef, machineName) === targetWorkspaceId) {
    return { kind: 'local' };
  }
  const resolved = resolveWorkspaceByIdentity(openRefs, targetWorkspaceId, machineName);
  if (resolved.kind === 'missing') return { kind: 'missing' };
  if (resolved.kind === 'ambiguous') return { kind: 'ambiguous' };
  return { kind: 'target', ref: resolved.ref };
}

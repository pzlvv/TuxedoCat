/**
 * 跨工作区派发的目标解析（specs/023 FR-002）。
 *
 * 纯函数：`Agent.target` 的身份 → 打开集合里的目标工作区引用。判定顺序：
 * 1. 等于来源工作区身份 → `local`（按缺省策略建本机子代理）；
 * 2. 未命中 → `missing`（工具错误，不创建对话）；
 * 3. 命中多项 → `ambiguous`（工具错误，不取第一项）；
 * 4. 唯一命中 → `target`。
 */

import type { UiEvent } from '../shared/AssistantEventBus.js';
import { resolveWorkspaceByIdentity, workspaceAgentId } from './workspaceIdentity.js';
import { sameWorkspaceRef } from './workspaceRef.js';
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

/** 跨工作区传输的两端解析结果（互斥：两端引用 / 守卫错误） */
export type TransferEndsResolution =
  | { kind: 'ends'; sourceRef: WorkspaceRef; destRef: WorkspaceRef }
  | { kind: 'error'; error: string };

/**
 * 跨工作区传输的两端解析与守卫（specs/028 FR-002）。
 *
 * 纯函数：`Transfer` 的两端身份 → 打开集合里的工作区引用。判定顺序：
 * 1. 任一端为 `null`（缺省）或等于来源身份 → 来源工作区；
 * 2. 未命中 / 歧义 → 错误（与 `Agent.target` 同族文案）；
 * 3. 解析后守卫——两端同一工作区（本工具仅服务跨工作区，同工作区用 Bash）、
 *    两端都不是来源（至少一端必须是本对话的工作区）→ 错误。
 */
export function resolveTransferEnds(
  openRefs: readonly WorkspaceRef[],
  originRef: WorkspaceRef,
  sourceTarget: string | null,
  destTarget: string | null,
  machineName: string,
): TransferEndsResolution {
  const resolveEnd = (target: string | null): WorkspaceRef | string => {
    if (target === null) return originRef;
    const resolved = resolveCrossWorkspaceTarget(openRefs, originRef, target, machineName);
    if (resolved.kind === 'local') return originRef;
    if (resolved.kind === 'missing') return `target workspace is not open: ${target}`;
    if (resolved.kind === 'ambiguous') return `target workspace identity is ambiguous: ${target}`;
    return resolved.ref;
  };
  const source = resolveEnd(sourceTarget);
  if (typeof source === 'string') return { kind: 'error', error: source };
  const dest = resolveEnd(destTarget);
  if (typeof dest === 'string') return { kind: 'error', error: dest };
  if (sameWorkspaceRef(source, dest)) {
    return {
      kind: 'error',
      error:
        'transfer requires two different workspaces; for copies inside a single workspace use Bash (cp / mv) instead',
    };
  }
  if (!sameWorkspaceRef(source, originRef) && !sameWorkspaceRef(dest, originRef)) {
    return {
      kind: 'error',
      error: 'at least one end of a transfer must be the current conversation workspace',
    };
  }
  return { kind: 'ends', sourceRef: source, destRef: dest };
}

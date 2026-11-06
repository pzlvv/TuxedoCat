/**
 * 时间线节点「从这里继续」的禁用判定（specs/039 FR-001 / FR-005）。
 *
 * 纯函数：`MessagesView` 把当前节点与运行态交给它，得到「能不能回退 + 不能的原因」，
 * 菜单只渲染结果。单测直接驱动（`src/test/rewindTimeline.test.ts`）。
 */

/** 禁用原因（同时是 i18n 键的一部分：`rewindDisabled.<reason>`） */
export type RewindDisabledReason =
  /** 末节点：其后没有可删内容 */
  | 'lastNode'
  /** 会话忙（运行 / 压缩中） */
  | 'busy'
  /** 压缩摘要：整体替换，回退到它之前没有可恢复的原始记录 */
  | 'compactSummary'
  /** 没有 messageUuid（once 通知 / 老数据）：core 认不出这个节点 */
  | 'noNodeId';

export interface RewindAvailability {
  enabled: boolean;
  reason: RewindDisabledReason | null;
}

/**
 * 判定某个时间线节点能否作为回退目标。
 *
 * 判定顺序固定（先判「有没有目标」再判「能不能动」）：多个条件同时不满足时，
 * 用户先看到的应该是「这个节点不是对话节点」而不是「会话忙」。
 *
 * @param nodeId 节点的 `messageUuid`（`undefined` = 不可回退）
 * @param isLast 是否是时间线最后一个节点
 * @param busy   会话是否非空闲（`running || compacting`）
 * @param isCompactSummary 是否是压缩摘要消息
 */
export function rewindAvailability(
  nodeId: string | undefined,
  isLast: boolean,
  busy: boolean,
  isCompactSummary: boolean,
): RewindAvailability {
  if (nodeId === undefined || nodeId === '') return { enabled: false, reason: 'noNodeId' };
  if (isCompactSummary) return { enabled: false, reason: 'compactSummary' };
  if (busy) return { enabled: false, reason: 'busy' };
  if (isLast) return { enabled: false, reason: 'lastNode' };
  return { enabled: true, reason: null };
}

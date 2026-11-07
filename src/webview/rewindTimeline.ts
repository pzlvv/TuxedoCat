/**
 * 时间线节点「从这里继续」的入口判定（specs/039 FR-001 / FR-005）。
 *
 * 两个纯函数：`isTimelineDotHit` 决定右键命中不命中状态点，`rewindAvailability` 决定
 * 命中的节点能不能回退。`MessagesView` 只把结果渲染成菜单，单测直接驱动
 * （`src/test/rewindTimeline.test.ts`）。
 */

/** 禁用原因（同时是 i18n 键的一部分：`rewindDisabled.<reason>`） */
export type RewindDisabledReason =
  /** 末节点：其后没有可删内容 */
  | 'lastNode'
  /** 会话未空闲（跑查询 / 等待用户 / 压缩 / 后台任务 / 子代理） */
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
 * @param idle   会话是否空闲（运行时快照的 `idle`；非 idle 一律不可回退）
 * @param isCompactSummary 是否是压缩摘要消息
 */
export function rewindAvailability(
  nodeId: string | undefined,
  isLast: boolean,
  idle: boolean,
  isCompactSummary: boolean,
): RewindAvailability {
  if (nodeId === undefined || nodeId === '') return { enabled: false, reason: 'noNodeId' };
  if (isCompactSummary) return { enabled: false, reason: 'compactSummary' };
  if (!idle) return { enabled: false, reason: 'busy' };
  if (isLast) return { enabled: false, reason: 'lastNode' };
  return { enabled: true, reason: null };
}

/**
 * 状态点的命中盒（CSS 像素，相对 `li.msg-timeline-item` 的**行内起点**边与顶边）。
 *
 * 状态点本身分两种画法：普通 / 运行中的圆点是 `::before` 伪元素（10×10，行内起点 0、
 * 顶边 7.5px），thinking 涟漪是真实 DOM 的 22×22 盒子（行内起点 -6px、顶边 1.5px）。
 * 伪元素不参与命中测试（`event.target` 只会是 `li`），所以两者统一按坐标判定。
 *
 * 取值把圆点外扩 3px：既不越过 li 的行内内边距（22px，内容区起点），
 * 也覆盖涟漪盒的主体。
 */
export const TIMELINE_DOT_HIT_BOX = {
  inlineStart: 0,
  inlineEnd: 13,
  top: 4,
  bottom: 21,
} as const;

/**
 * 右键是否命中状态点（`specs/039` 的入口范围：只有点响应，整行其余位置不弹菜单）。
 *
 * @param inlineOffset 光标相对 li **行内起点**边的距离（RTL 下由调用方换算成同口径）
 * @param offsetY 光标相对 li 顶边的距离
 */
export function isTimelineDotHit(inlineOffset: number, offsetY: number): boolean {
  return inlineOffset >= TIMELINE_DOT_HIT_BOX.inlineStart
    && inlineOffset <= TIMELINE_DOT_HIT_BOX.inlineEnd
    && offsetY >= TIMELINE_DOT_HIT_BOX.top
    && offsetY <= TIMELINE_DOT_HIT_BOX.bottom;
}

/** 回退预览只关心「是不是工具卡片」与「改没改文件」，取 `Message` 的这两个字段 */
export interface RewindPreviewMessage {
  role: 'user' | 'thinking' | 'toolcall' | 'system' | 'assistant';
  messageUuid?: string;
  toolCallId?: string;
  toolName?: string;
}

/**
 * 一条 UI 消息所属的 JSONL 行身份：`messageUuid` 优先，实时流式期还没有 uuid 的工具卡片
 * 退回 `toolCallId`（两者与 core 的 `truncate_index` 认的两种目标同源）。
 */
function rowKeyOf(message: RewindPreviewMessage): string | undefined {
  if (message.messageUuid !== undefined && message.messageUuid !== '') return message.messageUuid;
  return message.toolCallId;
}

/**
 * 目标节点在 UI 消息列表里的截断下标（保留 `[0, cut)`）。
 *
 * 与 core 的 `rewind::truncate_index` 同一口径，但要跨过一层展开：**一个 JSONL 行会被
 * 展开成多条 UI 消息**（assistant 行的 thinking / text / 多个工具卡片都共用同一个
 * `messageUuid`），而回退的原子单位是 JSONL 行。因此：
 *
 * 1. 目标是用户消息 → 保留自身（`index + 1`）；
 * 2. 其余角色都是产出物 → 从该节点之前继续，并前移到**它所属行的行首**
 *    （不能只删该行展开出的后半截）；
 * 3. 保留区末尾若是工具卡片，跟着前移到那张卡片的行首——core 侧对应的
 *    `tool_use` 会连带它的 `tool_result` 一起删，卡片不能停在半行上。
 *
 * UI 消息数不等于 JSONL 行数，所以这里只用于确认框的规模提示；真正删除的条数以 core
 * 回执为准。
 */
export function rewindCutIndex(messages: readonly RewindPreviewMessage[], targetUuid: string): number {
  const index = messages.findIndex(
    (message) => message.messageUuid === targetUuid || message.toolCallId === targetUuid,
  );
  if (index < 0) return -1;
  if (messages[index].role === 'user') return index + 1;

  // 前移到目标所属 JSONL 行的行首：同一行展开出的多级 UI 消息共用 rowKey
  const targetRow = rowKeyOf(messages[index]);
  let cut = index;
  while (
    cut > 0
    && targetRow !== undefined
    && rowKeyOf(messages[cut - 1]) === targetRow
  ) {
    cut -= 1;
  }
  // 保留区末尾不能是工具卡片（它对应的 tool_use 行已整体删除，卡片只是该行的一段）
  while (cut > 0 && messages[cut - 1].role === 'toolcall') {
    const orphanRow = rowKeyOf(messages[cut - 1]);
    cut -= 1;
    while (
      cut > 0
      && orphanRow !== undefined
      && rowKeyOf(messages[cut - 1]) === orphanRow
    ) {
      cut -= 1;
    }
  }
  return cut;
}

/** 确认框要显示的规模：被删的 UI 消息数与区间内被 Edit / Write 改过的文件数 */
export interface RewindPreview {
  removed: number;
  files: number;
}

/**
 * 回退规模预览（spec 039 FR-002）：区间内每个 Edit / Write 卡片算一个文件。
 *
 * 目标节点找不到时返回 `null`（调用方不弹确认框）。
 */
export function rewindPreview(
  messages: readonly RewindPreviewMessage[],
  targetUuid: string,
): RewindPreview | null {
  const cut = rewindCutIndex(messages, targetUuid);
  if (cut < 0) return null;
  let files = 0;
  for (let i = cut; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'toolcall') continue;
    if (message.toolName !== 'Edit' && message.toolName !== 'Write') continue;
    files += 1;
  }
  return { removed: messages.length - cut, files };
}

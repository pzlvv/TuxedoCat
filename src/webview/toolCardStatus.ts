/**
 * 工具卡片的两个状态推进不变量（`specs/defects/overlay-tool-card-stuck-running.md`）。
 *
 * 缺陷由**消息顺序**造成：`addMessage`（上架卡片）与 `updateToolStatus`（推进状态）是
 * 两条独立推送，同会话内不保证后者晚到。Overlay 对话把间隔放大（首次工具要现挂视图、
 * 权限阶段经代理回读文件），因此在那边最容易显形。
 *
 * 判定放在这里而不是 handler 里：它们是纯函数（不碰 React、不碰宿主），可以被单测直接
 * 驱动，也让「什么时候让出 thinking」这类表现规则只有一份。
 *
 * 与 `src/webview/inputAreaState.ts` 同一分工：模块只算状态，组件只渲染结果。
 */

import type { Message } from './types';

/** 工具状态优先级：success / fail > running > normal（与 handlers 共用同一份口径） */
export const TOOL_STATUS_PRIORITY: Record<string, number> = {
  success: 3,
  fail: 3,
  running: 2,
  normal: 1,
};

/** 缓冲里的一条状态更新（形状与 `ToolStatusEntry` 一致，这里只取用得到的字段） */
export interface BufferedToolStatus {
  status: string;
  output?: string;
}

/**
 * 把一条缓冲的状态更新应用到某张卡片上。
 *
 * 返回 `null` 表示「不该改这张卡片」：不是工具卡片、缓冲里没有它，或缓冲的状态优先级
 * 低于卡片当前状态（已经收尾的卡片不能被拉回运行态）。
 * 命中时顺带从缓冲删除该条——缓冲的语义是「等卡片上牌」，消费即出队。
 */
export function applyBufferedToolStatus(
  message: Message,
  buffered: Map<string, BufferedToolStatus>,
): Message | null {
  if (message.role !== 'toolcall' || !message.toolCallId) return null;
  const update = buffered.get(message.toolCallId);
  if (!update) return null;
  const currentPrio = TOOL_STATUS_PRIORITY[message.status || ''] ?? 0;
  const nextPrio = TOOL_STATUS_PRIORITY[update.status] ?? 0;
  // 无论是否覆盖都消费掉缓冲条目（避免后续重复应用）
  buffered.delete(message.toolCallId);
  if (nextPrio < currentPrio) return null;
  return {
    ...message,
    status: update.status as Message['status'],
    content: update.output || message.content,
    isStreaming:
      update.status === 'success' || update.status === 'fail' ? false : message.isStreaming,
  };
}

/**
 * 这张工具卡片此刻是否处于「进行中」（时间线该转风车）。
 *
 * 判据必须与卡片内容的渲染口径一致：`MessagesView` 的 `MessageItem` 用
 * `message.status || 'running'` 取状态，因此**状态尚未到达**（`undefined`）的卡片
 * 在视觉上就是「执行中」。状态点此前只看 `running` / `normal`，于是卡片上屏的那一瞬
 * 内容显示执行中、时间线却是普通圆点——如果此时 thinking 已经让出，界面上就没有任何
 * 进行中的指示（`specs/defects/overlay-tool-card-stuck-running.md` 的空窗形态）。
 *
 * `normal`（等待用户授权）同样算进行中：待确认的工具也是「还没结束」。
 */
export function isToolCardRunning(status: Message['status'] | undefined): boolean {
  return status === undefined || status === 'running' || status === 'normal';
}

/**
 * 工具卡片上屏时是否应继续显示 thinking 动画。
 *
 * - WebSearch：搜索发生在 LLM 流内且耗时较长，卡片自身没有动态反馈，关掉动画会像卡死；
 * - 其余情形：卡片一旦上屏就是「进行中」（见 `isToolCardRunning` 的口径），
 *   风车已经亮着，thinking 应当让位。
 */
export function shouldKeepThinkingForToolCard(
  toolName: string,
  status: Message['status'] | undefined,
): boolean {
  const toolNameNorm = (toolName || '').toLowerCase().replace(/[-_]/g, '');
  if (toolNameNorm === 'websearch') return true;
  return !isToolCardRunning(status);
}

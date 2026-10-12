/**
 * 对话树的共享默认值（webview 对话树与 Electron 原生侧栏对话树共用）。
 *
 * 两处渲染源各自实现树形展开逻辑（`src/webview/ConversationTreeItem.tsx` 与
 * `electron/sidebar/main.ts`），但「选中对话的子代理默认展开到什么程度」必须只有一份
 * 事实——阈值各写一遍必然漂移（改一处忘另一处），因此抽到这里。
 *
 * 本模块不 import 任何宿主 API，webview 与 Electron 侧栏都直接消费。
 */

/**
 * 选中对话的**直接**子会话数达到该值时，其子会话列表不再默认展开。
 *
 * 依据：子代理并发上限为 4（`SUBAGENT_CONCURRENCY_LIMIT`），一轮扇出超过 4 个的
 * 对话属于批量委派——自动展开会把对话列表撑满，把用户真正要找的其它对话挤走。
 * 用户仍可点击展开按钮显式展开。
 */
export const SUBAGENT_AUTO_EXPAND_LIMIT = 5;

/** 选中对话的子会话列表是否默认展开（直接子会话数小于上限即展开） */
export function shouldAutoExpandSubSessions(childCount: number): boolean {
  return childCount < SUBAGENT_AUTO_EXPAND_LIMIT;
}

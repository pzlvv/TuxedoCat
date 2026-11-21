/**
 * 会话加载的结束判据（`specs/defects/conversation-loading-times-out-before-large-session.md`）。
 *
 * 加载态有两个结束出口，都不是「时间到了」：**本视图负责的那个会话的
 * `conversationLoaded` 到达**（成功，本模块），或该会话的装载被 Core 拒绝
 * （`notice.session.lockedOpen`，见 `conversationLoadRejection.ts`）。
 * 不能带「等太久就放弃」的兜底超时——读盘耗时 = 会话大小 / 链路带宽，没有上界：
 * 8MB 会话经 SSH 慢链路读盘实测 24.9s，任何固定值都会在更慢的链路上复发，而放弃的
 * 那一刻消息已被清空，页面就落到「新对话空态」（占位 logo + 工作视图勾选框）。
 *
 * 抽成纯函数而不是写在 hook 里：它是可以单测直接驱动的状态转移，也让「什么条件下
 * 结束加载」只有一份判据（组装在 `useConversationLoading`，渲染在 `MessagesView`）。
 */

/** 本视图等待的会话身份：null = 没有待加载会话（新对话 / 已加载完成） */
export type PendingSession = string | null;

/**
 * 声明本视图即将原地加载某个会话（切换会话 / 新建对话时调用）。
 *
 * 空值一律归一成 null：「没有要等的会话」只有一种表示，避免 `''` 与 `null` 两种
 * 空态在后续判据里各自为政。
 */
export function pendingAfterBegin(sessionId: string | null | undefined): PendingSession {
  return sessionId ? sessionId : null;
}

/**
 * 收到某个会话的 `conversationLoaded` 后的等待状态。
 *
 * - 没有在等任何会话（`prev === null`）：无事可做，保持 null；
 * - 未指定 sessionId：按「当前等待的会话已到达」处理；
 * - 指定了 sessionId：**必须严格匹配**——迟到的旧会话数据不能关掉新会话的加载，
 *   否则新会话的加载态会在自己的数据到达前就消失（同一个可见症状的另一个入口）。
 */
export function pendingAfterLoaded(
  prev: PendingSession,
  sessionId: string | null | undefined,
): PendingSession {
  if (prev === null) return null;
  if (sessionId && prev !== sessionId) return prev;
  return null;
}

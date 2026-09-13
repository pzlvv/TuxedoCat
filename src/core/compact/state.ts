/**
 * 压缩状态注册表
 *
 * 会话在压缩期间（手动 /compact 或自动压缩）处于"正在压缩"状态，此时：
 * - 用户新发的消息只入队，不启动消费循环（QueryEngine.submitMessage 直接返回）
 * - Agent 回复同样只入队（QueryEngine.enqueueAgentMessage 不启动消费循环）
 * - 排队消息不会被 flush 进 LLM 上下文（QueryEngine.flushQueuedMessagesIntoContext 直接返回）
 *
 * 原因：压缩会整体替换 mutableMessages（messages.length = 0 后重新 push），
 * 若此时并发跑一轮 query，两者会互相踩踏 —— 新消息可能被压缩掉，或压缩结果被覆盖。
 * 压缩结束后由 QueryEngine.resumeAfterCompact() 统一排空队列。
 *
 * 单独放在这个无依赖模块里，避免 QueryEngine 与 compact/ 之间形成循环依赖。
 */

/** 正在压缩的会话集合 */
const compactingSessions = new Set<string>();

/** 标记会话开始压缩 */
export function markCompacting(sessionId: string): void {
  compactingSessions.add(sessionId);
}

/** 标记会话压缩结束（含失败 / 无消息可压缩的提前返回） */
export function unmarkCompacting(sessionId: string): void {
  compactingSessions.delete(sessionId);
}

/** 会话是否正在压缩 */
export function isCompacting(sessionId: string): boolean {
  return compactingSessions.has(sessionId);
}

/**
 * 待压缩会话集合。
 *
 * 用户手动触发压缩（/compress）时会话若非空闲（consumer 运行中 / 有后台任务或子代理），
 * 直接压缩会与运行中的查询并发改写 mutableMessages，因此这里只登记"待压缩"，
 * 视为"已达到需要压缩的条件"，交由下一轮对话开始时（Query.ts 的自动压缩检查）统一执行。
 */
const pendingCompactSessions = new Set<string>();

/** 标记会话"待压缩"（非空闲时手动触发，延后到下一轮对话开始执行） */
export function markPendingCompact(sessionId: string): void {
  pendingCompactSessions.add(sessionId);
}

/** 清除会话"待压缩"标记（压缩已执行 / 会话已销毁） */
export function unmarkPendingCompact(sessionId: string): void {
  pendingCompactSessions.delete(sessionId);
}

/** 会话是否有待执行的（延后）压缩请求 */
export function isPendingCompact(sessionId: string): boolean {
  return pendingCompactSessions.has(sessionId);
}

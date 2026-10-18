/**
 * 会话资源的宿主侧纯判定。
 *
 * 会话是否在忙的权威事实在 Core 进程内（`CoreEvent.sessionRuntimeChanged`
 * 全量推送）；宿主进程内没有引擎 / 后台任务 / 子代理登记表，因此这里不提供
 * 「扫描进程内状态」式的忙闲判定，宿主一律消费 Core 推送的快照。
 */

/** 临时会话 key（新建对话尚未上报正式 sessionId 前使用），不参与资源管理 */
export function isTemporarySessionId(sessionId: string): boolean {
  return sessionId.startsWith('new-');
}

/**
 * 打开对话被 Core 拒绝时，本视图要不要结束加载（纯判据，可单测）。
 *
 * 拒绝的唯一来源是 Core 的瞬时通知：会话被另一个实例持有时 Core 发
 * `notice.session.lockedOpen` 并回装载错误（specs/032 / US-66）。通知带会话键，
 * 而本视图在同一时刻可能正在等另一条对话——只有「被拒的正是本视图在等的」才作废
 * 这次加载，其余一律不干预（`finish` 的严格匹配在这里显式表达一次）。
 *
 * 判据只看键与会话身份，不做错误文案匹配（core 只给键，翻译在 UI：
 * `docs/architecture/core-ui-separation.md` 的瞬时提示一节）。
 */
import { CoreNoticeKeys } from '../shared/coreText';

/**
 * 返回要作废加载的会话 id；`null` = 这条通知不针对本视图正在等的对话。
 *
 * 被拒时界面停在打开前的原位置（「失败的打开动作无副作用」）：进入加载态时被清空的
 * 消息与排队横幅由 `handleConfigNotice` 按当前会话的内存缓存回滚，
 * 因此「结束加载 + 回滚」就是全部收尾动作。
 */
export function rejectedLoadSessionOf(
  pendingSessionId: string | null,
  notice: { key: string; sessionId?: string | undefined },
): string | null {
  if (!pendingSessionId) return null;
  if (notice.key !== CoreNoticeKeys.sessionLockedOpen) return null;
  return notice.sessionId === pendingSessionId ? pendingSessionId : null;
}

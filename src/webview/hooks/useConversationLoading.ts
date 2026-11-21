import { useCallback, useState } from 'react';
import { pendingAfterBegin, pendingAfterLoaded, type PendingSession } from '../conversationLoadingState';

export interface ConversationLoadingController {
  /** 是否正在等待本视图负责的会话数据（conversationLoaded） */
  isLoading: boolean;
  /** 本视图当前等待的会话；null 表示没有待加载会话（新对话/已加载完成） */
  pendingSessionId: PendingSession;
  /** 声明本视图即将原地加载某个会话（切换会话时调用；null 表示进入新对话） */
  begin: (sessionId: string | null | undefined) => void;
  /**
   * 收到某个会话的 `conversationLoaded`：本视图负责的那个会话数据已到达，结束加载。
   *
   * 加载态的另一条结束出口是「该会话的装载被 Core 拒绝」（`notice.session.lockedOpen`，
   * `conversationLoadRejection.ts`），它也走本方法收尾。两条都不是「时间到了」——没有
   * 「等太久就放弃」的兜底超时。读盘耗时 = 会话大小 / 链路带宽，没有上界（8MB 会话经
   * 慢速 SSH 读盘实测 24.9s），任何固定超时都会在更慢的链路上把加载态提前撤掉，让页面
   * 落到新对话空态
   * （`specs/defects/conversation-loading-times-out-before-large-session.md`）。
   */
  finish: (sessionId?: string | null) => void;
  /** 本视图进入一个无需加载的新对话 */
  reset: () => void;
}

/**
 * 会话加载状态（单一职责：由「对话」自己持有，外部只声明要加载哪个会话）。
 *
 * 语义：本视图正在等待「自己负责的那个会话」的数据到达。
 * - Electron：每个会话一个独立视图，视图创建时由 `?session=` / `__sessionId`
 *   确定目标会话，加载完成后不再变化；
 * - VSCode / 浏览器：单视图内切换，每次原地加载时更新目标会话。
 *
 * 关键点：loading 只在「本视图确实要加载该会话」时进入，并在收到该会话的
 * conversationLoaded 时结束。若切换会话由宿主另开一个视图完成（Electron 的
 * openConversation），本视图不会进入 loading，也就不会出现「显示了 loading
 * 但没有任何人通知它完成」的情况。
 *
 * 结束判据与匹配规则是纯函数（`../conversationLoading`），可以被单测直接驱动。
 */
export function useConversationLoading(
  initialTargetSessionId?: string | null,
): ConversationLoadingController {
  const [pendingSessionId, setPendingSessionId] = useState<PendingSession>(
    pendingAfterBegin(initialTargetSessionId),
  );

  const begin = useCallback((sessionId: string | null | undefined) => {
    setPendingSessionId(pendingAfterBegin(sessionId));
  }, []);

  const finish = useCallback((sessionId?: string | null) => {
    setPendingSessionId((prev) => pendingAfterLoaded(prev, sessionId));
  }, []);

  const reset = useCallback(() => {
    setPendingSessionId(null);
  }, []);

  return {
    isLoading: pendingSessionId !== null,
    pendingSessionId,
    begin,
    finish,
    reset,
  };
}

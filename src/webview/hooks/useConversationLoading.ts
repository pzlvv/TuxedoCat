import { useCallback, useEffect, useState } from 'react';

/** 加载兜底超时：目标会话数据长时间未到达（加载失败等异常）时自动结束 loading，避免永久遮罩 */
const CONVERSATION_LOAD_TIMEOUT_MS = 15_000;

export interface ConversationLoadingController {
  /** 是否正在等待本视图负责的会话数据（conversationLoaded） */
  isLoading: boolean;
  /** 本视图当前等待的会话；null 表示没有待加载会话（新对话/已加载完成） */
  pendingSessionId: string | null;
  /** 声明本视图即将原地加载某个会话（切换会话时调用；null 表示进入新对话） */
  begin: (sessionId: string | null | undefined) => void;
  /** 收到某个会话的 conversationLoaded 数据（仅当与当前等待的会话一致时结束 loading） */
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
 * `finish` 带 sessionId 校验：迟到的旧会话数据不会误关新会话的 loading。
 */
export function useConversationLoading(
  initialTargetSessionId?: string | null,
): ConversationLoadingController {
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(
    initialTargetSessionId ?? null,
  );

  const begin = useCallback((sessionId: string | null | undefined) => {
    setPendingSessionId(sessionId ? sessionId : null);
  }, []);

  const finish = useCallback((sessionId?: string | null) => {
    setPendingSessionId((prev) => {
      if (prev === null) return null;
      // 未指定 sessionId 时按“当前等待的会话已到达”处理；指定时要求严格匹配
      if (sessionId && prev !== sessionId) return prev;
      return null;
    });
  }, []);

  const reset = useCallback(() => {
    setPendingSessionId(null);
  }, []);

  // 兜底超时：只有仍在等待时才生效，正常结束会随 pendingSessionId 变化被清理
  useEffect(() => {
    if (pendingSessionId === null) return;
    const timer = setTimeout(() => {
      setPendingSessionId((prev) => (prev === pendingSessionId ? null : prev));
    }, CONVERSATION_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingSessionId]);

  return {
    isLoading: pendingSessionId !== null,
    pendingSessionId,
    begin,
    finish,
    reset,
  };
}

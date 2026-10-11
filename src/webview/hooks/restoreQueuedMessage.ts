import type { QueuedMessagePayload } from '../types';
import type { SessionStatesStore } from '../sessionState';
import type { InputAreaRef } from '../InputArea';

/**
 * 把排队消息回填到输入框：与用户当前草稿用 \n 连接（草稿为空时直接使用排队内容）。
 * 目标会话为当前会话时写入实时输入框；否则写入该会话的状态快照，
 * 保证切换回去后仍能看到回填的草稿。
 *
 * 唯一实现、两处调用（`docs/features/user-message-pipeline.md` FR-003）：
 * - `queryEnd` 兜底回投时用户主动 abort 的会话（useMessageHandler 的 queryEnd 分支）；
 * - 排队项「编辑」把消息撤回到输入框（useAppHandlers 的 handleEditQueuedMessage）。
 */
export function restoreQueuedMessageToInput(
  deps: {
    sessionStates: SessionStatesStore;
    currentSessionIdRef: React.MutableRefObject<string | null>;
    inputAreaRef: React.RefObject<InputAreaRef | null>;
    mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  },
  targetSessionId: string,
  queued: QueuedMessagePayload,
): void {
  const queuedText = queued.content ?? '';
  const queuedImages = queued.images ?? [];
  const joinWithDraft = (draft: string) => (draft ? `${queuedText}\n${draft}` : queuedText);

  const state = deps.sessionStates.get(targetSessionId);
  if (state) {
    state.queuedMessage = null;
  }

  if (targetSessionId === deps.currentSessionIdRef.current) {
    const draft = deps.inputAreaRef.current?.getValue() ?? '';
    const draftImages = deps.inputAreaRef.current?.getPastedImages?.() ?? [];
    const nextText = joinWithDraft(draft);
    deps.inputAreaRef.current?.setValue(nextText);
    if (queuedImages.length > 0) {
      deps.inputAreaRef.current?.setPastedImages?.([...queuedImages, ...draftImages]);
    }
    // 光标移到末尾，方便用户继续编辑（若期间已切换会话则跳过，避免抢焦点）
    setTimeout(() => {
      if (deps.currentSessionIdRef.current !== targetSessionId) return;
      const el = deps.mainInputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(nextText.length, nextText.length);
      }
    }, 0);
    return;
  }

  if (state) {
    state.input = joinWithDraft(state.input ?? '');
    if (queuedImages.length > 0) {
      state.pastedImages = [...queuedImages, ...(state.pastedImages ?? [])];
    }
  }
}

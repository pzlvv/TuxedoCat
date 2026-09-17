/**
 * 宿主共享的对话操作（/clear 等）。
 *
 * 三个版本（webviewMessageHandler / WebViewUI.onCommandSend）
 * 的公共核心：清空 JSONL + 重置 context tokens + 清引擎消息 + lastPersistedMessageUuid=null。
 * 各宿主"清空后"的收尾动作不同（刷新 webview 列表 / 刷新原生侧栏），由回调注入。
 */
import { logger } from '../Logger.js';

export interface ClearConversationCallbacks {
  /**
   * 清空成功后的收尾（刷新对话列表等）。
   * 注意：webviewMessageHandler 版本在清空后还会记录一条日志，
   * 由调用方在本回调内自行处理。
   */
  onSuccess?: () => void | Promise<void>;
  /** 清空失败时的错误处理（打日志） */
  onError?: (err: unknown) => void;
}

/**
 * 清空指定会话的对话数据：
 * 1. replaceConversationMessages(sessionId, []) —— 清空 JSONL
 * 2. updateConversationContext(sessionId, { totalContextTokens: 0 }) —— 重置 context tokens
 * 3. 清空内存引擎消息，lastPersistedMessageUuid 置 null
 * 不等待完成（与原实现一致，调用方原样 fire-and-forget）。
 */
export async function clearConversationData(sessionId: string, callbacks?: ClearConversationCallbacks): Promise<void> {
  try {
    const { replaceConversationMessages, updateConversationContext } = await import('./index.js');
    await replaceConversationMessages(sessionId, []);
    await updateConversationContext(sessionId, { totalContextTokens: 0 });
    const { getSessionEngine } = await import('../QueryEngine.js');
    const engine = getSessionEngine(sessionId);
    if (engine) {
      const msgs = engine.getMessages();
      msgs.length = 0;
      engine.lastPersistedMessageUuid = null;
    }
    await callbacks?.onSuccess?.();
  } catch (err) {
    if (callbacks?.onError) {
      callbacks.onError(err);
    } else {
      logger.warn('clearConversationData', `Error clearing conversation: ${err}`);
    }
  }
}

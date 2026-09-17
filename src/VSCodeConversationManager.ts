/**
 * SingleWebViewConversationManager - VS Code 的 ConversationManager 实现
 *
 * 单 webview 宿主：对话列表只推 webview 的 conversationsData（子对话树）；
 * 会话运行时状态无消费者（webview 对话树从 queryBegin/queryEnd 自己维护）→ 空实现。
 */

import type { ConversationMetadata } from './core/history/Conversation.js';
import type { SessionRuntimeState } from './core/AssistantEventBus.js';
import type { WebviewMessage } from './core/webviewTypes.js';
import { ConversationManager } from './host/ConversationManager.js';

export class SingleWebViewConversationManager extends ConversationManager {
  constructor(host: import('./host/UIHost.js').UIHost) {
    super(host);
  }

  /** 流 1：纯磁盘列表 → webview conversationsData */
  protected async dispatchList(list: readonly ConversationMetadata[]): Promise<void> {
    this.host.sendToWebview({
      type: 'conversationsData',
      conversations: list,
    } as unknown as WebviewMessage);
  }

  /** 流 2：空实现——webview 的对话树从 queryBegin/queryEnd 自己维护（第 4.5 节） */
  protected dispatchStates(_states: readonly SessionRuntimeState[]): void {
    /* 空实现：VS Code 单 webview 无原生侧栏/托盘消费者 */
  }
}

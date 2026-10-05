/**
 * TuiConversationManager - ConversationManager 的终端实现（docs/tui.md 第 6 节）。
 *
 * 只实现两个抽象分发方法（写 store）；缓存、脏标记、双流分发全部继承 concrete
 * 实现，TUI 不重写。Electron 专用的 setStatusListener / setSidebarOutlet 保持
 * 基类默认（未注册即 no-op）。
 */

import type { ConversationMetadata } from '../core/history/Conversation.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import { ConversationManager } from '../host/ConversationManager.js';
import type { UIHost } from '../host/UIHost.js';
import type { TuiAction } from './store.js';

export class TuiConversationManager extends ConversationManager {
  private readonly dispatchAction: (action: TuiAction) => void;

  constructor(host: UIHost, dispatch: (action: TuiAction) => void) {
    super(host);
    this.dispatchAction = dispatch;
  }

  /** 流 1：磁盘列表快照 → store（会话切换器的数据源） */
  protected async dispatchList(list: readonly ConversationMetadata[]): Promise<void> {
    this.dispatchAction({
      type: 'conversationsData',
      conversations: list.map((c) => ({
        sessionId: c.sessionId,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
        ...(c.parentSessionId !== undefined ? { parentSessionId: c.parentSessionId } : {}),
      })),
    });
  }

  /** 流 2：会话运行时状态全量 → store（状态栏流水灯与 abort 语义） */
  protected dispatchStates(states: readonly SessionRuntimeState[]): void {
    this.dispatchAction({ type: 'sessionRuntimeStates', states: states.map((s) => ({ ...s })) });
  }
}

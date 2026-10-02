/**
 * ElectronConversationManager - Electron 的 ConversationManager 实现
 *
 * dispatchList：① 原生侧栏（sidebar:conversations-updated）② webview 子对话树
 * dispatchStates：① 原生侧栏流水灯（sidebar:session-states-updated）② statusListener（托盘）
 *                 ③ 广播给所有聊天视图（webview 据此推导 abort 按钮可用性）
 *
 * 纯磁盘列表不再贴 loaded/idle/waitingForUser 标记：
 * - loaded 由 ChatViewManager 自己推（sidebar:session-loaded-changed）
 * - idle / waiting 走状态流（dispatchStates）
 */

import type { ConversationMetadata } from '../src/core/history/Conversation.js';
import type { SessionRuntimeState } from '../src/core/AssistantEventBus.js';
import type { WebviewMessage } from '../src/core/webviewTypes.js';
import type { UIHost } from '../src/host/UIHost.js';
import { ConversationManager } from '../src/host/ConversationManager.js';

export class ElectronConversationManager extends ConversationManager {
  /** 推侧栏的出口（宿主能力：main 进程的 sidebarView.webContents.send） */
  private get outlet(): (channel: string, payload: unknown) => void {
    return this.sidebarOutlet ?? (() => { /* 侧栏未就绪 */ });
  }

  constructor(
    host: UIHost,
    sendToSidebar: (channel: string, payload: unknown) => void,
  ) {
    super(host);
    this.setSidebarOutlet(sendToSidebar);
  }

  /** 流 1：纯磁盘列表 → ① 原生侧栏 ② webview 子对话树 */
  protected async dispatchList(list: readonly ConversationMetadata[]): Promise<void> {
    // ① 原生侧栏：纯磁盘元数据（loaded 标记由 ChatViewManager 单独推）
    this.outlet('sidebar:conversations-updated', list);
    // ② webview 内部列表（子对话树等）
    this.host.sendToWebview({
      type: 'conversationsData',
      conversations: list,
    } as unknown as WebviewMessage);
    this.host.log(`Conversation list refreshed (${list.length} conversations)`);
  }

  /** 流 2：① 原生侧栏流水灯 ② statusListener（托盘）③ 聊天视图（abort 按钮） */
  protected dispatchStates(states: readonly SessionRuntimeState[]): void {
    this.outlet('sidebar:session-states-updated', states);
    this.statusListener?.(states);
    // webview 不直接吃 core 事件，只读宿主推来的状态快照（与 VS Code 同一形态）。
    // 广播而非按 sessionId 单发：每个视图都持有全量快照，自己挑自己那份。
    this.host.broadcastToWebviews({ type: 'sessionRuntimeStates', states });
  }

  /**
   * 清空侧栏对话列表（活动工作区建链中 / 不可用时调用）：
   * 该目录没有可用的 Core，上一目录的列表不再适用，侧栏不显示对话列表。
   */
  clearConversationList(): void {
    void this.dispatchList([]);
  }
}

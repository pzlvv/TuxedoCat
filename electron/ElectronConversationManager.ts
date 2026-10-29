/**
 * ElectronConversationManager - Electron 的 ConversationManager 实现
 *
 * dispatchList：① 原生侧栏（sidebar:conversations-updated）② webview 子对话树——
 * 只推**活动工作目录**的列表；非活动目录的装载（`refreshWorkspace`，specs/defects/
 * inactive-tab-completion-light-missing）只喂灯管线（`onConversationsArrived`），
 * 不顶掉界面上正在显示的活动列表。
 * dispatchStates：① 原生侧栏流水灯（sidebar:session-states-updated）② statusListener（托盘 + 睡眠阻断）
 *                 ③ 广播给所有聊天视图（webview 据此推导 abort 按钮可用性）
 *
 * 纯磁盘列表不再贴 loaded/idle/waitingForUser 标记：
 * - loaded 由 ChatViewManager 自己推（sidebar:session-loaded-changed）
 * - idle / waiting 走状态流（dispatchStates）
 */

import type { ConversationMetadata } from '../src/shared/history/Conversation.js';
import type { SessionRuntimeState } from '../src/shared/AssistantEventBus.js';
import type { WebviewMessage } from '../src/host/webviewMessages.js';
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
    /**
     * 工作目录 → 快照缓存键（活动工作区的稳定 id `workspaceRefKey`）：列表快照按它
     * 分份——同路径不同主机的远程工作区各存一份，路径不作身份（Windows 本地规范化
     * 还会把它变形）。
     */
    private readonly keyForWorkspace: (workspacePath: string | undefined) => string = (workspacePath) => workspacePath ?? '',
    /**
     * 列表到达回调（灯管线，specs/defects/inactive-tab-completion-light-missing）：
     * 每次任何目录的列表装载完成都回调——宿主据此刷新归属索引、重推标签页聚合并对
     * `unreadCompletions > 0` 的会话补武装。非活动目录的列表不走侧栏 / webview 通道，
     * 灯管线只认这里。
     */
    private readonly onConversationsArrived: (list: readonly ConversationMetadata[]) => void = () => { /* 未接线 */ },
  ) {
    super(host);
    this.setSidebarOutlet(sendToSidebar);
  }

  /** 快照键 = 工作目录的稳定 id（活动目录传活动路径） */
  protected override workspaceCacheKey(workspace: string | undefined = this.host.getWorkspacePath()): string {
    return this.keyForWorkspace(workspace);
  }

  /** 流 1：纯磁盘列表 → 活动目录推侧栏 / webview；任何目录都喂灯管线 */
  protected async dispatchList(
    list: readonly ConversationMetadata[],
    workspace: string | undefined,
  ): Promise<void> {
    // 非活动目录的列表不进界面通道：侧栏正在显示活动目录的列表，被后台装载的
    // 别的目录顶掉就是串台（specs/defects/inactive-tab-completion-light-missing）
    if (this.keyForWorkspace(workspace) === this.keyForWorkspace(this.host.getWorkspacePath())) {
      // ① 原生侧栏：纯磁盘元数据（loaded 标记由 ChatViewManager 单独推）
      this.outlet('sidebar:conversations-updated', list);
      // ② webview 内部列表（子对话树等）；跨工作区对话是顶层普通条目，无占位字段
      // （specs/025 FR-001）
      this.host.sendToWebview({
        type: 'conversationsData',
        conversations: list.map((c) => ({
          sessionId: c.sessionId,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: c.messageCount,
          parentSessionId: c.parentSessionId,
        })),
      });
    }
    // ③ 灯管线：归属索引 / 标签页聚合 / 离场补武装都在宿主回调里（任何目录都到达）
    this.onConversationsArrived(list);
    this.host.log(`Conversation list refreshed (${list.length} conversations) for ${workspace ?? '<active>'}`);
  }

  /** 流 2：① 原生侧栏流水灯 ② statusListener（托盘 + 睡眠阻断）③ 聊天视图（abort 按钮） */
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
    void this.dispatchList([], undefined);
  }
}

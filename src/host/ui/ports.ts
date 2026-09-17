/**
 * WebViewUiPort - WebViewUI 暴露给共享子模块的端口
 *
 * 端口隔离：子模块（ToolHandler / UserChoiceManager / WebviewMessageHandler）
 * 拿不到 WebViewUI 的全量方法，只能通过这个窄接口回推 webview
 * （DEVELOPMENT.md 第 7 节）。
 * 由 WebViewUI 实现；子模块只依赖这个窄接口。成员全部必选。
 */

/**
 * 投递器：把 (sessionId, 部分消息体) 补全后交给宿主。
 * 由 WebViewUI 内部统一使用，避免多处各写一份合并逻辑。
 */
export type WebviewPoster = (sessionId: string, message: Record<string, unknown>) => void;

/** conversationLoaded 的附加信息（由 WebviewMessageHandler 提供） */
export interface ConversationLoadedExtra {
  pendingToolUseIds: string[];
  savedContext?: any;
  parentSessionId?: string;
  agentMode: string;
  hasActiveQuery: boolean;
  hasCompactArchive?: boolean;
  model?: string;
}

export interface WebViewUiPort {
  /** 补 sessionId 后投递到宿主 webview */
  postToWebview(sessionId: string, message: Record<string, unknown>): void;

  /** 推送 conversationLoaded（含宿主注入的 activityPhase） */
  postConversationLoaded(
    sessionId: string,
    conversation: unknown,
    extra: ConversationLoadedExtra,
  ): void;

  /** 会话标题变化通知（转调 WebViewUI.onTitleChanged） */
  onTitleChanged(sessionId: string, title: string): void;

  /**
   * 该会话的 UI 侧状态已释放（视图关闭 / 会话删除）。
   * `WebViewUI.dropSession` 借此 fan-out 给持有 per-session 状态的子模块：
   * `SessionUiState` 清阶段 / 计数 / abort scope；`UserChoiceManager` 清挂起的选择回调
   * 与 diff 快照；`WebviewMessageHandler` 清 tracked active session。
   */
  dropSession(sessionId: string): void;

  /**
   * 通知 UI 显示或清除排队消息状态。
   * 从原 AssistantUI 移来（唯一调用者是 WebviewMessageHandler，不是 core）。
   */
  onQueuedMessage(
    sessionId: string,
    content: string | null,
    images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>,
    fileInfo?: {
      filePath?: string;
      selectedLines?: { start: number; end: number };
      fileHidden?: boolean;
    },
  ): void;

  /** 当前活跃 session ID（UI 自己的状态，与宿主无关） */
  getActiveSessionId(): string | undefined;

  /**
   * 打开 Spin 设计器（转调 SpinDesign.open）。
   * 子模块不直接持有 SpinDesign，保持「只认 UIHost + WebViewUiPort」的约定。
   */
  openSpinDesign(): Promise<void>;

  /** 重新读取并分发对话列表（转调 ConversationManager.refresh） */
  refreshConversations(): Promise<void>;

  /**
   * 记录会话活动（打开 / 新建 / 用户发消息时调用），重置空闲关闭计时。
   * 空闲计时的 owner 是 VS Code 的 SingleWebViewConversationManager
   * （core 不参与计时；Electron 不做空闲回收，收到后无操作）。
   */
  noteSessionActivity(sessionId: string): void;
}

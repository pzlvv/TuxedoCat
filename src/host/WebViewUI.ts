/**
 * WebViewUI - 唯一的 UI 实现（宿主无关，不 import vscode / electron）
 *
 * 不 implements 任何事件契约：构造时把 CoreEventHandlers / CoreRequestHandlers
 * 两张映射表一次性注册到总线（穷尽检查由映射类型保证），
 * 需要通知 core 时通过注入的回调 / 总线。
 *
 * 持有 SessionUiState / ToolHandler / UserChoiceManager / WebviewMessageHandler；
 * 构造注入 host + spinDesign + conversations（三个契约，见第 5 节）。
 *
 * 渲染 handler 与控制面 handler 在一个类里按注释分区
 * （不再拆 WebViewNotifier / WebViewController，见第 3.3 节）。
 */

import type { AssistantEventBus, CoreEventHandlers, CoreRequestHandlers } from '../core/AssistantEventBus.js';
import type { MessageData, StreamMessageData, StreamEndData } from '../core/types.js';
import type { ToolProgressData, PermissionResult } from '../core/tools/Tool.js';
import type { UIHost } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { UserChoiceOptions } from '../core/UserChoiceQueue.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import { SessionUiState } from './SessionUiState.js';
import { UserChoiceManager } from './ui/userChoice.js';
import { ToolHandler } from './ui/toolHandler.js';
import { WebviewMessageHandler } from './ui/webviewMessageHandler.js';
import { fetchBalanceAndPush } from '../core/history/balancePush.js';
import { pushToolProgress } from './queryActivity.js';
import { buildConversationLoadedPayload } from './conversationPayload.js';
import type { WebViewUiPort, ConversationLoadedExtra, WebviewPoster } from './ui/ports.js';

export class WebViewUI implements WebViewUiPort {
  private static instance: WebViewUI | undefined;

  /** 按会话的 UI 运行时状态（活动阶段 / 工具计数 / 查询计数 / abort scope） */
  public readonly sessionUi = new SessionUiState();
  /** 对话列表刷新 debounce timer（500ms） */
  private conversationListRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** 共享子模块 */
  private readonly userChoiceManager: UserChoiceManager;
  private readonly toolHandler: ToolHandler;
  private readonly webviewMessageHandler: WebviewMessageHandler;
  /** 投递器（WebviewPoster） */
  private readonly post: WebviewPoster;

  /** 三个契约（构造注入） */
  private readonly spinDesign: SpinDesign;
  private readonly conversations: ConversationManager;

  /**
   * 创建全局唯一实例。重复调用抛错（启动接线错误应在启动期暴露）。
   * bus 由 bootstrap 先创建并注册（setGlobalEventBus）。
   */
  static create(
    host: UIHost,
    bus: AssistantEventBus,
    spinDesign: SpinDesign,
    conversations: ConversationManager,
    deps: {
      /** 宿主专属子模块工厂（VS Code: DocumentManager / buildDiffUris；Electron: 无预览句柄） */
      createUserChoiceManager: (post: WebviewPoster, closePreview: () => void, ui: WebViewUiPort) => UserChoiceManager;
      log: (...args: unknown[]) => void;
    },
  ): WebViewUI {
    if (WebViewUI.instance) {
      throw new Error('WebViewUI already created.');
    }
    const ui = new WebViewUI(host, bus, spinDesign, conversations, deps);
    WebViewUI.instance = ui;
    return ui;
  }

  /** 获取实例；未创建时抛错（替代静默 undefined） */
  static getInstance(): WebViewUI {
    if (!WebViewUI.instance) {
      throw new Error('WebViewUI not initialized. Call WebViewUI.create() first.');
    }
    return WebViewUI.instance;
  }

  private constructor(
    public readonly host: UIHost,
    bus: AssistantEventBus,
    spinDesign: SpinDesign,
    conversations: ConversationManager,
    deps: {
      createUserChoiceManager: (post: WebviewPoster, closePreview: () => void, ui: WebViewUiPort) => UserChoiceManager;
      log: (...args: unknown[]) => void;
    },
  ) {
    this.spinDesign = spinDesign;
    this.conversations = conversations;
    this.log = deps.log;

    this.post = (sessionId, message) => {
      this.postToWebview(sessionId, message);
    };

    this.userChoiceManager = deps.createUserChoiceManager(this.post, () => host.closePreview(), this);

    this.toolHandler = new ToolHandler({
      host,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      userChoiceManager: this.userChoiceManager,
    });

    this.webviewMessageHandler = new WebviewMessageHandler({
      host,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      postConversationLoaded: (sessionId, conversation, extra) =>
        this.postConversationLoaded(sessionId, conversation, extra),
      setTitle: (sessionID, title) => this.onTitleChanged(sessionID, title),
      userChoiceManager: this.userChoiceManager,
    });
    this.webviewMessageHandler.uiPort = this;

    // 初始化 UserChoiceQueue 回调
    this.userChoiceManager.initUserChoiceQueue();

    // ===================== 总线注册 =====================
    bus.onCoreEvents(this.buildCoreEventHandlers());
    bus.onCoreRequests(this.buildCoreRequestHandlers());
  }

  private log: (...args: unknown[]) => void;

  // ===================== WebViewUiPort（子模块端口）=====================

  /** 补 sessionId 后投递到宿主 webview */
  postToWebview(sessionId: string, message: Record<string, unknown>): void {
    this.host.sendToWebview({ ...message, sessionId } as never);
  }

  /** 推送 conversationLoaded（含宿主注入的 activityPhase） */
  postConversationLoaded(
    sessionId: string,
    conversation: any,
    extra: ConversationLoadedExtra,
  ): void {
    const payload = buildConversationLoadedPayload(sessionId, conversation, extra, {
      // 统一传（11.1 #2）：webview 依赖该字段恢复 thinking/text/tool 动画
      activityPhase: this.getActivityPhase(sessionId),
    });
    this.host.sendToWebview(payload as never);
    // 同步 abort 状态：切换到含活跃子代理的会话后，父会话的 abort 按钮仍应可用
    this.refreshAbortState();
  }

  /** 会话标题变化通知（转调 onTitleChanged） */
  onTitleChangedPort(sessionId: string, title: string): void {
    this.onTitleChanged(sessionId, title);
  }

  onTitleChanged(sessionId: string, title: string): void {
    this.postToWebview(sessionId, { type: 'setTitle', title });
  }

  /** 该会话的 UI 侧状态已释放（视图关闭 / 会话删除） */
  dropSession(sessionId: string): void {
    this.sessionUi.dropSession(sessionId);
  }

  /** 通知 UI 显示或清除排队消息状态（从 AssistantUI 移来） */
  onQueuedMessage(
    sessionId: string,
    content: string | null,
    images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>,
    fileInfo?: { filePath?: string; selectedLines?: { start: number; end: number }; fileHidden?: boolean },
  ): void {
    this.postToWebview(sessionId, content
      ? {
        type: 'queuedMessage',
        sessionId,
        content,
        images,
        filePath: fileInfo?.filePath,
        selectedLines: fileInfo?.selectedLines,
        fileHidden: fileInfo?.fileHidden,
      }
      : { type: 'clearQueuedMessage', sessionId });
  }

  /** 会话（含后台任务与递归子代理）是否有活跃查询 */
  hasActiveQueryInScope(sessionId: string): boolean {
    return this.sessionUi.hasActiveQueryInScope(sessionId);
  }

  /** 重新计算并下发 abort 按钮状态（内部调 host.syncAbortState） */
  refreshAbortState(): void {
    this.host.syncAbortState((sid) => this.sessionUi.hasActiveQueryInScope(sid));
  }

  /** 当前活跃 session ID（委托 WebviewMessageHandler 维护的 UI 状态） */
  getActiveSessionId(): string | undefined {
    return this.webviewMessageHandler.getActiveSessionId();
  }

  /** 打开 Spin 设计器（转调 SpinDesign.open） */
  openSpinDesign(): Promise<void> {
    return this.spinDesign.open();
  }

  /** 重新读取并分发对话列表（转调 ConversationManager.refresh） */
  refreshConversations(): Promise<void> {
    return this.conversations.refresh();
  }

  // ===================== 事件处理器（私有，命名与事件 type 对应）=====================

  private buildCoreEventHandlers(): CoreEventHandlers {
    return {
      // ===== 渲染 =====
      message: (e) => this.onMessage(e.sessionId, e.data),
      streamMessage: (e) => this.onStreamMessage(e.sessionId, e.data),
      streamEnd: (e) => this.onStreamEnd(e.sessionId, e.data),
      toolCall: (e) => this.onToolCall(e.sessionId, e.toolUseId, e.toolName),
      toolResult: (e) => this.onToolResult(e.sessionId, e.toolUseId, e.toolName, e.output, e.status),
      toolArgsUpdated: (e) => this.onToolArgsUpdated(e.sessionId, e.toolUseId, e.args),
      toolProgress: (e) => this.onToolProgress(e.sessionId, e.toolUseId, e.progress),
      aiBegin: (e) => this.onAIBegin(e.sessionId),
      aiEnd: (e) => this.onAIEnd(e.sessionId),
      clearMessages: (e) => this.clearMessages(e.sessionId),

      // ===== 控制面 =====
      queryBegin: (e) => this.onQueryBegin(e.sessionId),
      queryEnd: (e) => this.onQueryEnd(e.sessionId),
      titleChanged: (e) => this.onTitleChanged(e.sessionId, e.title),
      sessionCreated: (e) => this.onSessionCreated(e.sessionId),
      conversationListChanged: () => this.onConversationListChanged(),
      sessionRuntimeChanged: (e) => this.onSessionRuntimeChanged(e.states),
      spinDesignDataChanged: () => this.onSpinDesignDataChanged(),
      compactBegin: (e) => this.onCompactBegin(e.sessionId),
      compactEnd: (e) => this.onCompactEnd(e.sessionId, e.result),
      commandDispatched: (e) => void this.onCommandSend(e.commandName, e.args, e.sessionId),
      sessionConfigChanged: (e) => this.onSessionConfigChanged(e.sessionId, e.change),
    };
  }

  private buildCoreRequestHandlers(): CoreRequestHandlers {
    return {
      toolPermission: (r) =>
        this.onPreToolCall(r.sessionId, r.toolUseId, r.toolName, r.permResult, r.displayArgs),
      userChoice: (r) => this.requestUserChoice(r.sessionId, r.options),
    };
  }

  // --- 渲染 handler ---

  onMessage(sessionId: string, data: MessageData): void {
    this.postToWebview(sessionId, { type: 'addMessage', ...data });
    // 用户消息已进入持久化流程：刷新对话列表，使打开中的历史列表同步 messageCount
    if (data.role === 'user') {
      this.onConversationListChanged();
    }
  }

  onStreamMessage(sessionId: string, data: StreamMessageData): void {
    if (data.role === 'assistant' && data.accumulated && !data.accumulated.trim()) {
      return;
    }
    // 流式阶段决定当前是 thinking 还是 assistant 文本输出
    if (data.role === 'assistant') {
      this.sessionUi.markText(sessionId);
    } else {
      this.sessionUi.markThinking(sessionId);
    }
    this.postToWebview(sessionId, {
      type: 'streamMessage',
      role: data.role,
      delta: data.delta,
      accumulated: data.accumulated,
      streamId: data.streamId,
    });
  }

  onStreamEnd(sessionId: string, data: StreamEndData): void {
    this.postToWebview(sessionId, {
      type: 'streamEnd',
      role: data.role,
      accumulated: data.accumulated,
      usage: data.usage,
      streamId: data.streamId,
    });
  }

  private setThinkingAnimation(sessionId: string, show: boolean): void {
    this.postToWebview(sessionId, { type: 'showThinkingAnimation', show });
  }

  onToolCall(sessionId: string, toolUseId: string, toolName: string): void {
    this.sessionUi.markToolPhase(sessionId);
    this.toolHandler.onToolCall(sessionId, toolUseId, toolName);
  }

  onToolResult(sessionId: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void {
    this.sessionUi.endToolPhase(sessionId);
    this.toolHandler.onToolResult(sessionId, toolUseId, toolName, output, status);
  }

  onToolArgsUpdated(sessionId: string, toolUseId: string, args: Record<string, unknown>): void {
    this.postToWebview(sessionId, {
      type: 'updateToolArgs',
      toolCallId: toolUseId,
      toolArgs: args,
    });
  }

  onToolProgress(sessionId: string, toolUseId: string, progress: ToolProgressData): void {
    pushToolProgress(sessionId, toolUseId, progress, (sid, message) =>
      this.postToWebview(sid, message));
  }

  onAIBegin(sessionId: string): void {
    this.sessionUi.markThinking(sessionId);
    this.setThinkingAnimation(sessionId, true);
    this.postToWebview(sessionId, { type: 'aiBegin' });
  }

  onAIEnd(sessionId: string): void {
    this.sessionUi.markIdle(sessionId);
    this.setThinkingAnimation(sessionId, false);
    this.postToWebview(sessionId, { type: 'aiEnd' });
    // 每轮 LLM 调用后刷新余额
    this.fetchAndSendBalance(sessionId);
  }

  clearMessages(sessionId: string): void {
    this.postToWebview(sessionId, { type: 'clearMessages' });
  }

  // --- 控制面 handler ---

  /**
   * 工具调用开始前（CoreRequest.toolPermission 的处理方）：
   * 显示工具卡片；permResult.behavior === 'ask' 时弹确认框并回传用户选择。
   */
  onPreToolCall(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    permResult: PermissionResult,
    displayArgs: Record<string, unknown>,
  ): Promise<PermissionResult> {
    // 进入工具阶段（包括等待用户授权/权限检查），thinking 动画应让位于工具卡片
    this.sessionUi.beginToolPhase(sessionId);
    return this.toolHandler.onPreToolCall(sessionId, toolUseId, toolName, permResult, displayArgs);
  }

  requestUserChoice(sessionId: string, options: UserChoiceOptions): Promise<{ index: number; reply?: string }> {
    return this.userChoiceManager.requestUserChoice(sessionId, options);
  }

  /**
   * 查询开始。
   * 同一 session 可能被多个调用方同时标记 begin，由 SessionUiState 计数去重，
   * 保证一次查询只发一次 queryBegin/queryEnd。
   */
  onQueryBegin(sessionId: string): void {
    if (!this.sessionUi.beginQuery(sessionId)) {
      this.log(`Ignoring nested queryBegin for session: ${sessionId}`);
      return;
    }
    // 查询开始时立即显示 thinking 动画，覆盖前置耗时
    this.sessionUi.markThinking(sessionId);
    this.setThinkingAnimation(sessionId, true);
    this.refreshAbortState();
    this.postToWebview(sessionId, { type: 'queryBegin' });
  }

  onQueryEnd(sessionId: string): void {
    if (!this.sessionUi.endQuery(sessionId)) {
      // 没有对应的 queryBegin（重复 onQueryEnd），忽略，保证一次查询只发一次 queryEnd
      this.log(`Ignoring redundant queryEnd for session: ${sessionId}`);
      return;
    }
    this.sessionUi.markIdle(sessionId);
    // 查询结束必须关闭 thinking 动画：中断（尤其子代理中断）可能没有 onAIEnd，
    // 若只发 queryEnd 会让 webview 的 thinking 动画残留。（统一显式发，11.1 #4）
    this.setThinkingAnimation(sessionId, false);
    // 先同步 abort 状态再发 queryEnd：若当前会话仍有其他查询/子代理在运行，
    // 这里会保持 abort 按钮可用，而不是被其他会话的 queryEnd 置灰。
    this.refreshAbortState();
    this.postToWebview(sessionId, { type: 'queryEnd' });
    // 查询结束代表消息已持久化完成：推送最新对话列表，历史列表打开时条数实时更新
    this.onConversationListChanged();
  }

  onSessionCreated(sessionId: string): void {
    this.postToWebview(sessionId, { type: 'initSessionState' });
  }

  /**
   * 对话列表数据变化（磁盘元数据）。
   * 内部 500ms trailing debounce 后调 conversations.refresh()，
   * core 不再选择「立即 / 节流」，也不再关心推给哪些界面。
   */
  onConversationListChanged(): void {
    if (this.conversationListRefreshTimer) clearTimeout(this.conversationListRefreshTimer);
    this.conversationListRefreshTimer = setTimeout(() => {
      this.conversationListRefreshTimer = null;
      void this.conversations.refresh();
    }, 500);
  }

  /**
   * 会话运行时状态变化（running / waiting）。
   * 不防抖——状态要即时，直接 conversations.updateSessionStates(states)。
   * 只读：sessionUi 的活跃计数由 queryBegin/queryEnd 自维护，本 handler 不写回。
   */
  onSessionRuntimeChanged(states: readonly SessionRuntimeState[]): void {
    this.conversations.updateSessionStates(states);
  }

  /** Spin 设计器数据变化 → spinDesign.refresh()（设计器不在 UIHost 上） */
  onSpinDesignDataChanged(): void {
    void this.spinDesign.refresh();
  }

  onCompactBegin(sessionId: string): void {
    this.postToWebview(sessionId, {
      type: 'compressProgress',
      status: 'start',
    });
  }

  onCompactEnd(
    sessionId: string,
    result: { status: 'complete'; postCompactTokenCount: number | null } | { status: 'error' },
  ): void {
    this.postToWebview(sessionId, {
      type: 'compressProgress',
      status: result.status === 'complete' ? 'complete' : 'error',
      postCompactTokenCount: result.status === 'complete' ? result.postCompactTokenCount ?? undefined : undefined,
    });
  }

  /**
   * 命令发送回调（CoreEvent.commandDispatched 的处理方）。
   * 唯一调用方（CommandDispatcher）丢弃返回值。
   */
  async onCommandSend(commandName: string, args: string, sessionId: string): Promise<void> {
    if (commandName === 'clear') {
      this.postToWebview(sessionId, { type: 'clearMessages', sessionId });
      const { clearConversationData } = await import('../core/history/ops.js');
      void clearConversationData(sessionId, {
        // /clear 后同步列表 messageCount（清空后仍保留会话，显示 0 条）
        onSuccess: () => this.onConversationListChanged(),
        onError: (err) => {
          this.log(`Error clearing conversation: ${err}`);
        },
      });
      return;
    }

    if (commandName === 'spin') {
      const trimmed = args.trim();
      if (trimmed === 'design') {
        void this.spinDesign.open().catch((err: unknown) => {
          this.log(`Error opening spin design: ${err}`);
        });
        return;
      }
      // /spin: 无 spin.json 时打开设计器（shouldOpenSpinDesign 是 core 的只读函数）
      const { shouldOpenSpinDesign } = await import('../core/history/spinCommand.js');
      const ws = this.host.getWorkspacePath();
      if (ws && shouldOpenSpinDesign(ws)) {
        void this.spinDesign.open().catch((err: unknown) => {
          this.log(`Error opening spin design: ${err}`);
        });
      }
    }
  }

  /**
   * 会话配置变化（core 广播）→ 多端同步：按 change.key 发对应 wire message。
   */
  onSessionConfigChanged(
    sessionId: string,
    change:
      | { key: 'model'; value: string }
      | { key: 'thinkingEffort'; value: 'off' | 'low' | 'high' | 'max' }
      | { key: 'promptMode'; value: 'normal' | 'minimal' | 'mixed' }
      | { key: 'agentMode'; value: 'manual' | 'risk' | 'auto' }
      | { key: 'webSearch'; value: boolean }
      | { key: 'mcpEnabled'; value: string[] },
  ): void {
    switch (change.key) {
      case 'model':
        this.postToWebview(sessionId, { type: 'setModel', model: change.value });
        break;
      case 'thinkingEffort':
        // 落盘字段仍是 thinkingMode（wire 协议命名不受事件约定约束，见第 3.4 节）
        this.postToWebview(sessionId, { type: 'setThinkingMode', mode: change.value });
        break;
      case 'promptMode':
        this.postToWebview(sessionId, { type: 'setPromptMode', mode: change.value });
        break;
      case 'agentMode':
        this.postToWebview(sessionId, { type: 'setAgentMode', mode: change.value });
        break;
      case 'webSearch':
        this.postToWebview(sessionId, { type: 'setWebSearch', webSearch: change.value });
        break;
      case 'mcpEnabled':
        this.postToWebview(sessionId, { type: 'setMcpServers' });
        break;
    }
  }

  // ===================== 公开方法（供宿主接线 / core 调用）=====================

  /** 处理来自 webview 的消息（入口：宿主 webview 的 onDidReceiveMessage） */
  async handleWebviewMessage(message: unknown): Promise<void> {
    await this.webviewMessageHandler.handleWebviewMessage(message);
  }

  /** 某会话当前活动阶段，供 conversationLoaded 恢复 thinking 动画 */
  getActivityPhase(sessionId: string): 'idle' | 'thinking' | 'text' | 'tool' {
    return this.sessionUi.getActivityPhase(sessionId);
  }

  /** 指定会话是否正在等待用户选择/确认（ask user / 权限确认） */
  hasPendingUserChoice(sessionId: string): boolean {
    return this.userChoiceManager.hasPendingChoice(sessionId);
  }

  /** 当前工作区路径（委托 host.getWorkspacePath()，供 initializeHistory 使用） */
  getWorkspacePath(): string | undefined {
    return this.host.getWorkspacePath();
  }

  /**
   * 关闭会话：卸下运行时内存 + 销毁宿主视图。两件事归属不同，这里只做分发。
   */
  closeConversation(sessionId: string): void {
    const { requireEventBus } = require('../core/AssistantEventBus.js') as typeof import('../core/AssistantEventBus.js');
    requireEventBus().emitToCore({ type: 'conversationClosed', sessionId }); // core 卸内存
    void this.host.closeConversationView(sessionId); // 宿主销毁视图（VS Code 空）
    this.sessionUi.dropSession(sessionId); // 清 UI 侧 per-session 状态（阶段/计数/abort scope）
    this.webviewMessageHandler.dropTrackedSession(sessionId); // 清 UI 侧 tracked active session
  }

  /** 获取 DeepSeek 账户余额并发送到 webview（统一走 host.log，11.1 #13） */
  private fetchAndSendBalance(sessionId: string): void {
    fetchBalanceAndPush(
      (message) => this.postToWebview(sessionId, message),
      (line) => this.log(line),
    );
  }
}

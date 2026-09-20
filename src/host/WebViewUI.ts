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
 * （不拆 WebViewNotifier / WebViewController，见第 3.3 节）。
 */

import type { AssistantEventBus, CoreEventHandlers, CoreRequestHandlers } from '../core/AssistantEventBus.js';
import { requireEventBus } from '../core/AssistantEventBus.js';
import type { AgentMode, MessageData, StreamMessageData, StreamEndData } from '../core/types.js';
import type { ModelRef } from '../core/llm/modelRef.js';
import type { ToolProgressData, PermissionResult } from '../core/tools/Tool.js';
import type { UIHost, WebviewViewHandle } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { UserChoiceOptions } from '../core/UserChoiceQueue.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import { SessionUiState } from './SessionUiState.js';
import { UserChoiceManager } from './ui/userChoice.js';
import { ToolHandler } from './ui/toolHandler.js';
import { WebviewMessageHandler, type WebviewRequestContext } from './ui/webviewMessageHandler.js';
import { fetchBalanceAndPush } from '../core/history/balancePush.js';
import { pushToolProgress } from './queryActivity.js';
import { buildConversationLoadedPayload } from './conversationPayload.js';
import { readUiLanguageSync } from '../core/history/Config.js';
import type { WebviewMessage } from '../core/webviewTypes.js';
import type { WebViewUiPort, ConversationLoadedExtra, WebviewPoster, LLMConfigPanelTrigger } from './ui/ports.js';

export class WebViewUI implements WebViewUiPort {
  private static instance: WebViewUI | undefined;

  /** 按会话的 UI 运行时状态（活动阶段 / 工具计数 / 查询计数） */
  public readonly sessionUi = new SessionUiState();

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
  }

  /** 会话标题变化通知（转调 onTitleChanged） */
  onTitleChangedPort(sessionId: string, title: string): void {
    this.onTitleChanged(sessionId, title);
  }

  onTitleChanged(sessionId: string, title: string): void {
    this.postToWebview(sessionId, { type: 'setTitle', title });
  }

  /**
   * 该会话的 UI 侧状态已释放（视图关闭 / 会话删除）：
   * fan-out 给所有持有 per-session 状态的子模块，各自清理。
   * 由 `releaseConversation` 统一调用（第 6.1 节 / 第 10.5 节）。
   */
  dropSession(sessionId: string): void {
    this.sessionUi.dropSession(sessionId);                  // 阶段 / 工具计数 / 查询计数
    this.userChoiceManager.dropSession(sessionId);          // 挂起的选择回调 + diff 快照
    this.webviewMessageHandler.dropTrackedSession(sessionId); // tracked active session
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

  /** 记录会话活动，重置该会话的空闲关闭计时（空闲回收是 VS Code 专属，见第 5.4 节） */
  noteSessionActivity(sessionId: string): void {
    this.conversations.noteSessionActivity(sessionId);
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
      messagesReplaced: (e) => this.onMessagesReplaced(e.sessionId, e.messages),

      // ===== 控制面 =====
      queryBegin: (e) => this.onQueryBegin(e.sessionId),
      queryEnd: (e) => this.onQueryEnd(e.sessionId),
      titleChanged: (e) => this.onTitleChanged(e.sessionId, e.title),
      sessionCreated: (e) => this.onSessionCreated(e.sessionId),
      conversationListChanged: () => this.onConversationListChanged(),
      sessionRuntimeChanged: (e) => this.onSessionRuntimeChanged(e.states),
      spinDesignDataChanged: () => this.onSpinDesignDataChanged(),
      highlightLanguagesUsed: (e) => this.onHighlightLanguagesUsed(e.languages),
      projectConversationDirReady: (e) => this.onProjectConversationDirReady(e.projectDir, e.workspacePath),
      compactBegin: (e) => this.onCompactBegin(e.sessionId),
      compactEnd: (e) => this.onCompactEnd(e.sessionId, e.result),
      commandDispatched: (e) => void this.onCommandSend(e.commandName, e.args, e.sessionId),
      sessionConfigChanged: (e) => this.onSessionConfigChanged(e.sessionId, e.change),
    };
  }

  private buildCoreRequestHandlers(): CoreRequestHandlers {
    return {
      toolPermissionRequested: (r) =>
        this.requestToolPermission(r.sessionId, r.toolUseId, r.toolName, r.permResult, r.displayArgs, r.agentMode),
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

  /** 整批替换该会话显示的消息（core 的 messagesReplaced：压缩后重建 / 展开归档） */
  onMessagesReplaced(sessionId: string, messages: readonly MessageData[]): void {
    this.postToWebview(sessionId, { type: 'messagesReplaced', messages });
  }

  // --- 控制面 handler ---

  /**
   * 工具调用开始前（CoreRequest.toolPermissionRequested 的处理方）：
   * 显示工具卡片；permResult.behavior === 'ask' 时弹确认框并回传用户选择。
   */
  requestToolPermission(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    permResult: PermissionResult,
    displayArgs: Record<string, unknown>,
    agentMode: AgentMode,
  ): Promise<PermissionResult> {
    // 进入工具阶段（包括等待用户授权/权限检查），thinking 动画应让位于工具卡片
    this.sessionUi.beginToolPhase(sessionId);
    return this.toolHandler.requestToolPermission(sessionId, toolUseId, toolName, permResult, displayArgs, agentMode);
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
    this.postToWebview(sessionId, { type: 'queryEnd' });
    // 查询结束代表消息已持久化完成：推送最新对话列表，历史列表打开时条数实时更新
    this.onConversationListChanged();
  }

  onSessionCreated(sessionId: string): void {
    this.postToWebview(sessionId, { type: 'initSessionState' });
  }

  /**
   * 对话列表数据变化（磁盘元数据）→ conversations.refresh()。
   * 「立即还是节流、推给哪些界面」由 ConversationManager 决定，core 不参与。
   */
  onConversationListChanged(): void {
    void this.conversations.refresh();
  }

  /**
   * 会话运行时状态变化（idle / waiting）→ conversations.updateSessionStates(states)。
   * 只读：sessionUi 的活跃计数由 queryBegin/queryEnd 自维护，本 handler 不写回。
   */
  onSessionRuntimeChanged(states: readonly SessionRuntimeState[]): void {
    this.conversations.updateSessionStates(states);
  }

  /** Spin 设计器数据变化 → spinDesign.refresh()（设计器不在 UIHost 上） */
  onSpinDesignDataChanged(): void {
    void this.spinDesign.refresh();
  }

  /**
   * 消息里出现了新的高亮语言 → 并入 settings.json 的 highlightLanguages 字段。
   * core 只报告事实，字段名 / 去重 / 上限在 core 的 `highlightLanguagesMutator`，
   * 写盘由宿主承担（core 只读不写 settings.json）。
   */
  /**
   * 项目对话目录已就绪 → 让宿主写入其中的 settings.json（记录 workspacePath）。
   * core 只报告事实，写盘归宿主（core 只读不写 settings.json）。
   */
  onProjectConversationDirReady(projectDir: string, workspacePath: string): void {
    void this.host.ensureProjectSettings(projectDir, workspacePath).catch((err: unknown) => {
      this.log(`Failed to write project settings.json for ${projectDir}: ${err}`);
    });
  }

  onHighlightLanguagesUsed(languages: readonly string[]): void {
    void import('../core/history/Config.js').then(({ highlightLanguagesMutator }) =>
      this.host.updateSettingsJson(highlightLanguagesMutator(languages))
    ).catch((err: unknown) => {
      this.log(`Failed to record highlight languages: ${err}`);
    });
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
  async onCommandSend(commandName: string, args: string, _sessionId: string): Promise<void> {
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
      | { key: 'model'; ref: ModelRef }
      | { key: 'thinkingEffort'; value: 'off' | 'low' | 'high' | 'max' }
      | { key: 'promptMode'; value: 'normal' | 'minimal' | 'mixed' }
      | { key: 'agentMode'; value: 'manual' | 'risk' | 'auto' }
      | { key: 'webSearch'; value: boolean }
      | { key: 'mcpEnabled'; value: string[] },
  ): void {
    switch (change.key) {
      case 'model':
        // wire 协议保持扁平：模型身份拆成 model / provider 两个字段下发，
        // webview 需要 provider 才能把选中标记落到正确的分组。
        this.postToWebview(sessionId, { type: 'setModel', model: change.ref.model, provider: change.ref.provider });
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

  /**
   * 处理来自 webview 的消息（入口：宿主 webview 的 onDidReceiveMessage）。
   *
   * `ctx.sender` 标识消息来源视图（多视图宿主把平台对象包成 WebviewViewHandle 传入；
   * 单视图宿主 / 宿主主动推送省略）。需要按来源回包的消息（requestTheme /
   * requestContextLimit）依赖它定向投递。
   */
  async handleWebviewMessage(message: unknown, ctx?: WebviewRequestContext): Promise<void> {
    await this.webviewMessageHandler.handleWebviewMessage(message, ctx);
  }

  /**
   * 向对话 webview 下发当前上下文上限（视图加载完成时的初始化推送）。
   *
   * `sender` 为 null 时走默认路由（单视图宿主 / 活动视图）；模型切换的回包走 webview 的
   * `requestContextLimit`（第 7.3 节），与这里共用 `WebviewMessageHandler` 的同一份实现。
   */
  pushContextLimit(sender: WebviewViewHandle | null): void {
    this.webviewMessageHandler.pushContextLimit(sender, undefined);
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
   * 打开 LLM 配置面板。
   *
   * core 只提供配置事实（`getLLMConfigPanelPayload` / `hasActiveProviderSetting` /
   * `readMcpServersForDefaults`）；wire message 的组装与投递在 UI 层完成（第 12.6 节）。
   *
   * `trigger` 决定是否弹：
   * - `'startup'`：仅当「已配置 active provider 但 apiKey 为空」时弹（视图加载后的补弹）
   * - `'new-conversation'`：仅当「未配置 active provider 或 apiKey 为空」时弹（新对话引导）
   * - `'request'`：无条件弹（webview 主动请求）
   *
   * `sessionId` 为定向视图；`null` 表示单视图宿主的唯一 webview。
   */
  async showLLMConfigPanel(trigger: LLMConfigPanelTrigger, sessionId: string | null): Promise<void> {
    let message: Extract<WebviewMessage, { type: 'showLLMConfig' }>;
    try {
      const { getLLMConfigPanelPayload, hasActiveProviderSetting } = await import('../core/llm/config.js');
      const [payload, hasActiveProvider] = await Promise.all([
        getLLMConfigPanelPayload(),
        hasActiveProviderSetting(),
      ]);
      // 补弹只在「有 provider 缺 key」时触发；新对话引导只在配置不完整时触发
      if (trigger === 'startup' && (!hasActiveProvider || !!payload.apiKey)) return;
      if (trigger === 'new-conversation' && hasActiveProvider && !!payload.apiKey) return;
      // 三条路径共用同一份面板载荷（含 MCP 默认启用列表），不因触发场景裁剪
      const { readMcpServersForDefaults } = await import('../core/mcp/Config.js');
      message = {
        type: 'showLLMConfig',
        ...payload,
        mcpServers: await readMcpServersForDefaults(),
        language: readUiLanguageSync(),
      };
    } catch (err) {
      this.log(`[WebViewUI] Failed to read LLM config: ${err}`);
      // 读取失败仍打开面板，但不预置任何默认值（避免内置默认被误当成用户配置）
      message = {
        type: 'showLLMConfig',
        baseURL: '',
        webSearch: false,
        thinkingEffort: 'off',
        defaultModel: '',
        defaultAgentMode: 'risk',
        defaultPromptMode: 'normal',
        apiKey: '',
        providers: [],
        activeProvider: '',
        language: readUiLanguageSync(),
        mcpServers: [],
      };
    }
    this.host.sendToWebview(sessionId ? { ...message, sessionId } : message);
  }

  /**
   * 释放会话的运行时内存与 UI 侧状态，不销毁宿主视图。
   *
   * 这是 ChatViewManager 的「卸内存」入口（视图销毁序列在它内部自行完成，
   * 见 electron/ChatViewManager.destroyViewEntry），避免「关闭视图」与
   * 「卸内存」互相回调形成环。
   */
  releaseConversation(sessionId: string): void {
    requireEventBus().emitToCore({ type: 'conversationClosed', sessionId }); // core 卸内存
    this.dropSession(sessionId); // 清 UI 侧 per-session 状态（fan-out，见 dropSession）
  }

  /**
   * 关闭会话：卸下运行时内存 + 销毁宿主视图。两件事归属不同，这里只做分发。
   */
  closeConversation(sessionId: string): void {
    this.releaseConversation(sessionId);
    void this.host.closeConversationView(sessionId); // 宿主销毁视图（VS Code 空）
  }

  /** 获取 DeepSeek 账户余额并发送到 webview（统一走 host.log，11.1 #13） */
  private fetchAndSendBalance(sessionId: string): void {
    fetchBalanceAndPush(
      (message) => this.postToWebview(sessionId, message),
      (line) => this.log(line),
    );
  }
}

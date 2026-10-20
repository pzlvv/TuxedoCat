/**
 * WebViewUI - 唯一的 UI 实现（宿主无关，不 import vscode / electron）
 *
 * 不 implements 任何事件契约：构造时把 CoreEventHandlers / CoreRequestHandlers
 * 两张映射表一次性注册到总线（穷尽检查由映射类型保证），
 * 需要通知 core 时通过注入的回调 / 总线。
 *
 * 持有 SessionUiState / ToolHandler / UserChoiceManager / WebviewMessageHandler；
 * 构造注入 host + spinDesign + conversations（三个契约，见 `docs/architecture/contracts.md`）。
 *
 * 渲染 handler 与控制面 handler 在一个类里按注释分区
 * （不拆 WebViewNotifier / WebViewController，见 ``docs/architecture/events.md 第 1 节）。
 */

import type { AssistantEventBus, CoreEvent, CoreEventHandlers, CoreRequestHandlers, SpinDesignReadResult } from '../shared/AssistantEventBus.js';
import { requireEventBus } from '../shared/AssistantEventBus.js';
import type { AgentMode, MessageData, StreamMessageData, StreamEndData } from '../shared/types.js';
import type { ModelRef } from '../shared/llm/modelRef.js';
import type { ToolProgressData, PermissionResult } from '../shared/tools/Tool.js';
import type { UIHost, WebviewViewHandle } from './UIHost.js';
import type { SpinDesign } from './SpinDesign.js';
import type { ConversationManager } from './ConversationManager.js';
import type { UserChoiceOptions } from '../shared/UserChoiceQueue.js';
import type { SessionRuntimeState } from '../shared/AssistantEventBus.js';
import type { NoticeLevel, NoticeParams } from '../shared/coreText.js';
import { CoreNoticeKeys } from '../shared/coreText.js';
import { SessionUiState } from './SessionUiState.js';
import { UserChoiceManager } from './ui/userChoice.js';
import { ToolHandler } from './ui/toolHandler.js';
import { WebviewMessageHandler, type WebviewRequestContext } from './ui/webviewMessageHandler.js';

import { pushToolProgress } from './queryActivity.js';
import { buildConversationLoadedPayload } from './conversationPayload.js';
import { readUiLanguage, readUiFontSize, requestBalance, requestSpinDesign } from './coreFacts.js';
import { markCoreReady } from './coreReadiness.js';
import { isTemporarySessionId } from '../shared/sessionResources.js';
import {
  readHasActiveProviderSetting,
  readLlmConfigPanelPayload,
  readMcpServersForDefaults,
} from './settingsRead.js';
import { getSettingsStore } from './SettingsStore.js';
import type { HostToWebviewMessage, HostToWebviewMessageWithoutSessionId } from './webviewMessages.js';
import type {
  WebViewUiPort,
  ConversationLoadedExtra,
  WebviewPoster,
  LLMConfigPanelTrigger,
  QueuedMessageState,
} from './ui/ports.js';

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

  /**
   * 补 sessionId 后投递到宿主 webview。
   * sessionId 由本函数统一补全；部分广播类消息的 wire 类型不含 sessionId 字段，
   * 多余字段经 postMessage 通道无害，故合并点收敛为一次受控断言。
   */
  postToWebview(sessionId: string, message: HostToWebviewMessageWithoutSessionId): void {
    this.host.sendToWebview({ ...message, sessionId } as HostToWebviewMessage);
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
    this.host.sendToWebview(payload);
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
   * 由 `releaseConversation` 统一调用（`docs/hosts/webview-ui.md` 第 1 / 9 节）。
   */
  dropSession(sessionId: string): void {
    this.sessionUi.dropSession(sessionId);                  // 阶段 / 工具计数 / 查询计数
    this.userChoiceManager.dropSession(sessionId);          // 挂起的选择回调 + diff 快照
    this.webviewMessageHandler.dropTrackedSession(sessionId); // tracked active session
    this.onQueuedMessage(sessionId, null);                  // 会话释放 → 清排队项（`docs/features/user-message-pipeline.md` FR-003）
  }

  /**
   * 登记 / 清除该会话的排队项（`queued === null` 表示清除）。
   *
   * 登记时带上 `uuid`：core 把消息并入 LLM 上下文后补发 `addMessage`（含 `messageUuid`），
   * webview 按 uuid 清除排队项（见 `docs/features/user-message-pipeline.md` 第 5 节）。
   */
  onQueuedMessage(sessionId: string, queued: QueuedMessageState | null): void {
    this.postToWebview(sessionId, queued === null
      ? { type: 'clearQueuedMessage' }
      : {
        type: 'queuedMessage',
        uuid: queued.uuid,
        content: queued.content,
        images: queued.images,
        filePath: queued.filePath,
        selectedLines: queued.selectedLines,
        fileHidden: queued.fileHidden,
      });
  }

  /** 当前活跃 session ID（委托 WebviewMessageHandler 维护的 UI 状态） */
  getActiveSessionId(): string | undefined {
    return this.webviewMessageHandler.getActiveSessionId();
  }

  /**
   * 该会话是否处于 open 状态（UserChoiceQueue 的投递判定）。
   *
   * 多视图宿主（Electron）由 `setOpenSessions` 同步「已打开会话」集合；未同步过的
   * 单视图宿主（VS Code）退化为 open == active == 当前显示的会话。
   */
  isSessionOpen(sessionId: string): boolean {
    return this.webviewMessageHandler.isSessionOpen(sessionId);
  }

  /**
   * 宿主同步「已打开会话视图」集合（多视图宿主；视图创建 / 销毁 / LRU 淘汰时调用）。
   * 单视图宿主不调用：其 open 语义等同于 active。
   */
  setOpenSessions(sessionIds: string[]): void {
    this.webviewMessageHandler.setOpenSessions(sessionIds);
  }

  /**
   * 宿主切换前台会话时同步「当前活跃 session」。
   *
   * 多视图宿主（Electron）切到已打开的视图不会再触发 loadConversation /
   * startNewConversation，必须由宿主在活动视图变化时显式调用，否则 handler 的
   * tracked active session 会停在旧视图，按会话解析的数据（project skills / MCP
   * 启用列表）会取到别的标签页的工作目录。
   */
  setActiveSessionId(sessionId: string | undefined): void {
    this.webviewMessageHandler.setActiveSessionId(sessionId);
  }

  /** 打开 Spin 设计器（按当前活跃会话路由；数据经 Core 读取） */
  async openSpinDesign(): Promise<void> {
    await this.openSpinDesignForSession(this.getActiveSessionId() ?? null);
  }

  /**
   * 打开设计器并把首次读取失败转成该会话的 notice。
   *
   * `spin.json` 与技能清单都归 Core（`docs/core/standalone-core-boundaries.md` 第 2 节），
   * 宿主不再按工作目录读本地磁盘；`sessionId` 是路由键，`null` 表示没有会话。
   */
  private async openSpinDesignForSession(sessionId: string | null): Promise<void> {
    try {
      await this.spinDesign.open(sessionId);
    } catch (err) {
      this.log(`Error opening spin design: ${err}`);
      if (sessionId) {
        this.onNotice(sessionId, CoreNoticeKeys.spinCannotRead, {}, 'error');
      }
    }
  }

  /** 重新读取并分发对话列表（转调 ConversationManager.refresh） */
  refreshConversations(): Promise<void> {
    return this.conversations.refresh();
  }

  /** 最近一次会话运行时状态快照（Standalone 下拉取不能用进程内的 sessionRuntime） */
  getSessionRuntimeStatesSnapshot(): readonly SessionRuntimeState[] {
    return this.conversations.getSessionStatesSnapshot();
  }

  /**
   * 该会话自己的查询是否在跑（`conversationLoaded.hasActiveQuery` 的来源）。
   *
   * 只读 `SessionUiState` 的查询计数（本会话自己的消费循环），不读 `sessionRuntime.idle`
   * ——后者含后台子代理 / 后台 Bash / 压缩，会把「父会话空闲、后台子代理在等用户」
   * 误判成父会话有活跃查询（docs/hosts/webview-ui.md）。
   */
  isQueryActive(sessionId: string): boolean {
    return this.sessionUi.isQueryActive(sessionId);
  }

  /** 记录会话活动，重置该会话的空闲关闭计时（空闲回收是 VS Code 专属，见 `docs/architecture/contracts.md` 第 4 节） */
  noteSessionActivity(sessionId: string): void {
    this.conversations.noteSessionActivity(sessionId);
  }

  // ===================== 事件处理器（私有，命名与事件 type 对应）=====================

  private buildCoreEventHandlers(): CoreEventHandlers {
    return {
      // ===== 连接生命周期 =====
      // Core 处理完宿主环境与配置快照（`docs/architecture/core-ui-separation.md` 第 7 节）。
      // 每次重新推送快照后都会再来一次；宿主侧只记录闩锁状态，不触发渲染。
      coreReady: () => markCoreReady(),

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
      conversationSpaceCleared: (e) => this.onConversationSpaceCleared(e.dirName, e.result),
      sessionRuntimeChanged: (e) => this.onSessionRuntimeChanged(e.states),
      spinDesignDataChanged: () => this.onSpinDesignDataChanged(),
      workModeChanged: (e) => this.onWorkModeChanged(e.sessionId, e.workMode),
      highlightLanguagesUsed: (e) => this.onHighlightLanguagesUsed(e.languages),
      compactBegin: (e) => this.onCompactBegin(e.sessionId),
      compactEnd: (e) => this.onCompactEnd(e.sessionId, e.result),
      commandDispatched: (e) => void this.onCommandSend(e.commandName, e.args, e.sessionId),
      sessionConfigChanged: (e) => this.onSessionConfigChanged(e.sessionId, e.change),

      // ===== 瞬时提示 =====
      notice: (e) => this.onNotice(e.sessionId, e.key, e.params, e.level),

      // ===== 日志 =====
      log: (e) => this.log(e.message),
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
    this.postToWebview(sessionId, { type: 'messagesReplaced', messages: [...messages] });
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
   * 对话列表数据变化（磁盘元数据）→ ConversationManager.onConversationListChanged。
   * 活动目录立即重读、其余目录的快照标记脏（切换标签页命中脏快照时后台补读）。
   * 「立即还是节流、推给哪些界面」由 ConversationManager 决定，core 不参与。
   */
  onConversationListChanged(): void {
    void this.conversations.onConversationListChanged();
  }

  /**
   * 对话空间清空回执 → 设置面板的完成 / 失败通知。
   *
   * 这条下行消息是 LLMConfigPanel 的删除按钮从「删除中」恢复的**唯一**信号
   * （webviewMessages 的 `conversationSpaceCleared` / `conversationSpacesError`）：
   * UiEvent 是 fire-and-forget，core 的回执丢了面板就会永远停在「删除中」，
   * 因此成功与失败都必须转发，不做静默丢弃。
   */
  private onConversationSpaceCleared(
    dirName: string,
    result: Extract<CoreEvent, { type: 'conversationSpaceCleared' }>['result'],
  ): void {
    if (result.status === 'complete') {
      this.host.sendToWebview({
        type: 'conversationSpaceCleared',
        dirName,
        removedFiles: result.removedFiles,
        removedBytes: result.removedBytes,
      });
    } else {
      // 只回传原始错误：前缀文案由 webview 的 i18n 拼（与统计失败同口径）
      this.host.sendToWebview({
        type: 'conversationSpacesError',
        error: result.message,
      });
    }
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
   * 瞬时状态提示（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
   *
   * core 只给「键 + 参数」，翻译与呈现由 webview 承担：原样转发，不进消息流、
   * 不落盘。键缺失时 webview 显示键本身并记日志。
   */
  onNotice(sessionId: string, key: string, params: NoticeParams, level: NoticeLevel): void {
    this.postToWebview(sessionId, { type: 'notice', key, params, level });
  }

  /**
   * 消息里出现了新的高亮语言 → 并入 settings.json 的 highlightLanguages 字段。
   *
   * 字段名 / 去重 / 上限在宿主的 `highlightLanguagesMutator`（UI 专属字段，
   * Core 不感知）；写盘走 `UIHost.updateSettingsJson`。
   */
  onHighlightLanguagesUsed(languages: readonly string[]): void {
    void import('./highlightLanguages.js').then(({ highlightLanguagesMutator }) =>
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
  async onCommandSend(commandName: string, args: string, sessionId: string): Promise<void> {
    // 内置命令就地执行、不进入 LLM 上下文，因此不会补发用户气泡。
    // 这里显式清除该会话的排队项，避免 webview 在 queryEnd 时把它当成
    // 「未被消费」而重复投递（见 docs/architecture/host-ui-modules.md 第 4 节的 onQueuedMessage）。
    this.onQueuedMessage(sessionId, null);
    if (commandName === 'spin') {
      const trimmed = args.trim();
      // spin.json 属于对话自己的工作目录：按会话经 Core 读取（远程工作区在 Core
      // 所在机器），宿主不再用本地 fs 探测。
      if (trimmed === 'design') {
        await this.openSpinDesignForSession(sessionId);
        return;
      }
      // /spin: 无 spin.json 时打开设计器；存在性判断来自 Core。
      let read: SpinDesignReadResult;
      try {
        read = await requestSpinDesign(sessionId);
      } catch (err) {
        this.log(`Error reading spin design: ${err}`);
        this.onNotice(sessionId, CoreNoticeKeys.spinCannotRead, {}, 'error');
        return;
      }
      if (read.status === 'error') {
        this.log(`Error reading spin design: ${read.message}`);
        this.onNotice(sessionId, CoreNoticeKeys.spinCannotRead, {}, 'error');
        return;
      }
      const { shouldOpenSpinDesign } = await import('../shared/history/spinCommand.js');
      if (shouldOpenSpinDesign(read)) {
        await this.openSpinDesignForSession(sessionId);
      }
    }
  }

  /**
   * 会话工作模式变化（core 广播，进入 / 退出 spin）→ webview 输入框禁用态
   * （specs/016 FR-004）。会话切换时的初始态由 `conversationLoaded` 载荷携带。
   */
  onWorkModeChanged(sessionId: string, workMode: 'normal' | 'spin'): void {
    this.postToWebview(sessionId, { type: 'setWorkMode', workMode });
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
        // 落盘字段仍是 thinkingMode（wire 协议命名不受事件约定约束，见 ``docs/architecture/events.md 第 2 节）
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
        // 重新读取该会话的 MCP 配置 + 运行时状态并回推：
        // core 在连接/断开同步完成后才广播本事件，webview 据此把「连接中」刷新为
        // 连接成功 / 失败；不能只发一个不带 servers 的裸消息（webview 会清空列表）。
        void this.webviewMessageHandler.pushMcpServers(sessionId);
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
   * `requestContextLimit`（`docs/architecture/host-ui-modules.md` 第 3 节），与这里共用 `WebviewMessageHandler` 的同一份实现。
   */
  pushContextLimit(sender: WebviewViewHandle | null): void {
    this.webviewMessageHandler.pushContextLimit(sender, undefined);
  }

  /** 某会话当前活动阶段，供 conversationLoaded 恢复 thinking 动画 */
  getActivityPhase(sessionId: string): 'idle' | 'thinking' | 'text' | 'tool' {
    return this.sessionUi.getActivityPhase(sessionId);
  }

  /**
   * 打开 LLM 配置面板。
   *
   * 配置事实来自宿主自己的快照与 `settings.json`（`settingsRead.ts` /
   * `readMcpServersForDefaults`）；wire message 的组装与投递在 UI 层完成（``docs/architecture/principles.md` 第 6 节）。
   *
   * `trigger` 决定是否弹：
   * - `'startup'`：仅当「已配置 active provider 但 apiKey 为空」时弹（视图加载后的补弹）
   * - `'new-conversation'`：仅当「未配置 active provider 或 apiKey 为空」时弹（新对话引导）
   * - `'request'`：无条件弹（webview 主动请求）
   *
   * `sessionId` 为定向视图；`null` 表示单视图宿主的唯一 webview。
   */
  async showLLMConfigPanel(trigger: LLMConfigPanelTrigger, sessionId: string | null): Promise<void> {
    let message: Extract<HostToWebviewMessage, { type: 'showLLMConfig' }>;
    try {
      // 打开面板前先重读一次磁盘：手工恢复 / 编辑 settings.json 后不必重载窗口
      // （启动期只 loadSync 一次，不监听文件，见 `docs/architecture/core-ui-separation.md` 第 4.5 节）。
      const store = getSettingsStore();
      store.refreshFromDisk();
      // 面板载荷与「是否已配置 provider」都来自宿主自己的快照
      // （配置归宿主，见 `settingsRead.ts`），不问 Core。
      const snapshot = store.getSnapshot();
      const payload = readLlmConfigPanelPayload(snapshot);
      const hasActiveProvider = readHasActiveProviderSetting(snapshot);
      // 补弹只在「有 provider 缺 key」时触发；新对话引导只在配置不完整时触发
      if (trigger === 'startup' && (!hasActiveProvider || !!payload.apiKey)) return;
      if (trigger === 'new-conversation' && hasActiveProvider && !!payload.apiKey) return;
      // 三条路径共用同一份面板载荷（含 MCP 默认启用列表），不因触发场景裁剪。
      // MCP 默认列表来自宿主自己的快照（定义 + 全局启用列表），不问 Core。
      message = {
        type: 'showLLMConfig',
        ...payload,
        mcpServers: readMcpServersForDefaults(snapshot, getSettingsStore().getMcpServers()),
        language: readUiLanguage(),
        fontSize: readUiFontSize(),
      };
    } catch (err) {
      // 读取失败无法判断「是否真的未配置」，也无法给出面板载荷。载荷字段全部必选
      // （`docs/hosts/webview-facts.md` 第 6 节），不补默认值：不打开面板，只记日志。
      // 用一份空面板顶上去会把用户误导去重配，甚至把空值当默认值写回磁盘。
      this.log(`[WebViewUI] Failed to read LLM config; LLM 配置面板未打开: ${err}`);
      return;
    }
    this.host.sendToWebview(sessionId ? { ...message, sessionId } : message);
  }

  /**
   * 释放会话的运行时内存与 UI 侧状态，不销毁宿主视图。
   *
   * 这是 ChatViewManager 的「卸内存」入口（视图销毁序列在它内部自行完成，
   * 见 electron/ChatViewManager.destroyViewEntry），避免「关闭视图」与
   * 「卸内存」互相回调形成环。
   *
   * 临时 `new-` key 尚未对应正式会话（core 侧 releaseSessionResources 对它本就是
   * no-op，`src/core/sessionResources.ts`），不发 `conversationClosed`：
   * 会话从未登记过归属，多连接下 Client 按会话路由查不到归属会直接抛错
   * （`docs/core/client-connection.md` 第 6 节）。
   */
  releaseConversation(sessionId: string): void {
    if (!isTemporarySessionId(sessionId)) {
      requireEventBus().emitToCore({ type: 'conversationClosed', sessionId }); // core 卸内存
    }
    this.dropSession(sessionId); // 清 UI 侧 per-session 状态（fan-out，见 dropSession）
  }

  /**
   * 关闭会话：卸下运行时内存 + 销毁宿主视图。两件事归属不同，这里只做分发。
   */
  closeConversation(sessionId: string): void {
    this.releaseConversation(sessionId);
    void this.host.closeConversationView(sessionId); // 宿主销毁视图（VS Code 空）
  }

  /**
   * 获取 DeepSeek 账户余额并发送到 webview（统一走 host.log，11.1 #13）。
   *
   * 余额是 core 的事实（按 provider 的 apiKey 查询），经
   * Standalone 经 `UiRequest.balanceRequested` 让 Core 查，宿主不读 core 的配置。
   */
  private fetchAndSendBalance(sessionId: string): void {
    void (async () => {
      try {
        const balanceInfo = await requestBalance(sessionId);
        if (balanceInfo) {
          this.postToWebview(sessionId, {
            type: 'balanceUpdate',
            totalBalance: balanceInfo.totalBalance,
            currency: balanceInfo.currency,
            isUnlimited: balanceInfo.isUnlimited,
            fetchedAt: balanceInfo.fetchedAt,
          });
        } else {
          // 获取余额失败时清空余额，避免 webview 继续显示旧值
          this.postToWebview(sessionId, {
            type: 'balanceUpdate',
            totalBalance: null,
            currency: null,
            isUnlimited: null,
            fetchedAt: Date.now(),
          });
        }
      } catch (err) {
        this.log(`Failed to fetch balance: ${String(err)}`);
      }
    })();
  }
}

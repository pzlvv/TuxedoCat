/**
 * src/host/ui/webviewMessageHandler.ts - WebView 消息处理
 * 接收和处理来自 webview 的所有消息
 */
import type { UIHost } from '../UIHost.js';
import { fetch as undiciFetch } from 'undici';
import { logger } from '../../core/Logger.js';
import { getProbeDispatcher } from '../../core/llm/httpDispatcher.js';
import {
  apiTypeRegistry,
  type ApiTypeDefinition,
  type ApiTypeProbeRequest,
  type ProbeVerdict,
} from '../../core/llm/apiTypes/index.js';
import { buildEditDiffHunks } from '../../core/utils/editDiff.js';
import { buildReplayMessageData } from '../../core/utils/replayMessages.js';
import { buildUserContent, extractUserContent } from '../../core/utils/contentBlocks.js';
import type { ApiType } from '../../core/utils/modelConfig.js';
import { getSessionWorkspace, setSessionWorkspace } from '../../core/history/Config.js';
import { getSettingsStore } from '../SettingsStore.js';
import { modelRefOf, sameModelRef, type ModelRef } from '../../core/llm/modelRef.js';
import { getConversationModelRef } from '../../core/history/Conversation.js';
import { userChoiceQueue } from '../../core/UserChoiceQueue.js';
import type { WebviewMessage } from '../../core/webviewTypes.js';
import type { SessionRuntimeState, UiEvent } from '../../core/AssistantEventBus.js';
import { requireEventBus } from '../../core/AssistantEventBus.js';
import type { UserChoiceManager } from './userChoice.js';
import type { LLMConfigPanelTrigger, QueuedMessageState } from './ports.js';
import type { ConversationLoadedExtra } from '../conversationPayload.js';
import { resolveCoreKind } from '../coreKind.js';
import {
  loadConversationForHost,
  loadConversationListForHost,
  readUiLanguage,
  requestBalance,
  requestCompactArchive,
  requestConversationSpaces,
  requestFlushSession,
  requestMcpServers,
  requestSkills,
  requestSmartNaming,
} from '../coreFacts.js';
import { applyLlmConfigSave } from '../llmConfigSave.js';
import {
  readActiveModelRef,
  readDefaultAgentMode,
  readDefaultPromptMode,
  readDefaultThinkingEffort,
  readDefaultWebSearch,
  readLlmConfigPanelPayload,
  resolveModelRef,
} from '../settingsRead.js';

/**
 * 自动获取模型时，协议探测的并发上限（按「模型」计，每个模型内部再并发 3 个协议）。
 * 实测 37 模型：并发 6 → 5.4s，并发 10 → 3.3s；再往上收益递减且更容易触发网关限流。
 */
const API_TYPE_PROBE_CONCURRENCY = 10;
/** 单次协议探测请求的超时时间（含重试的总时长上限） */
const API_TYPE_PROBE_TIMEOUT_MS = 10_000;
/** 协议探测的最大重试次数（限流 / 瞬时故障时） */
const API_TYPE_PROBE_MAX_RETRIES = 2;
/** 协议探测重试的退避基数（第 n 次重试等待 n × 该值） */
const API_TYPE_PROBE_RETRY_BASE_DELAY_MS = 500;
/** 协议探测重试的最大等待时间（同时约束 Retry-After） */
const API_TYPE_PROBE_MAX_RETRY_DELAY_MS = 5_000;
/** 需要重试的探测状态码：限流 + 瞬时故障 */
const API_TYPE_PROBE_RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * WebviewMessageHandler - 处理 webview 发来的各类消息
 */

/**
 * 返回新会话的默认标题。
 *
 * 约定：extension 侧不关心界面语言，统一返回空字符串作为"未命名"标记，
 * 由 webview 侧在收到空标题时根据 VS Code 界面语言进行本地化翻译。
 */
function defaultTitle(): string {
  return '';
}


/** 按并发上限执行异步任务，结果顺序与输入一致 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  if (items.length === 0) return results;
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
/**
 * 一次 webview 消息的发送上下文。
 *
 * `sender` 标识消息来自哪个对话视图（宿主已把平台对象包成句柄）：
 * - 多视图宿主（Electron）：按来源视图直发回包（预热视图等非活动视图也能收到）；
 * - 单视图宿主（VS Code）：没有 sender 概念，恒为 `null`，按默认路由回包；
 * - 宿主主动触发（非 webview 请求，如视图加载完成时的初始化推送）：也传 `null`。
 */
export interface WebviewRequestContext {
  sender: import('../UIHost.js').WebviewViewHandle | null;
}

/** 缺省上下文：单视图宿主 / 宿主主动推送 */
const DEFAULT_REQUEST_CONTEXT: WebviewRequestContext = { sender: null };

export class WebviewMessageHandler {
  private host: UIHost;
  /** WebViewUI 端口（阶段 4 正式化；当前由宿主注入） */
  uiPort?: {
    openSpinDesign(): Promise<void>;
    refreshConversations(): Promise<void>;
    noteSessionActivity(sessionId: string): void;
    /** 打开 LLM 配置面板（core 给配置，WebViewUI 组装 wire message） */
    showLLMConfigPanel(trigger: LLMConfigPanelTrigger, sessionId: string | null): Promise<void>;
    /** 最近一次会话运行时状态快照（Standalone 下拉取不能用进程内 sessionRuntime） */
    getSessionRuntimeStatesSnapshot(): readonly SessionRuntimeState[];
    /** 该会话自己的查询是否在跑（`conversationLoaded.hasActiveQuery` 的来源） */
    isQueryActive(sessionId: string): boolean;
    /** 登记 / 清除该会话的排队项（`null` = 清除） */
    onQueuedMessage(sessionId: string, queued: QueuedMessageState | null): void;
  };
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private postConversationLoaded: (sessionId: string, conversation: any, extra: ConversationLoadedExtra) => void;
  private setTitle: (sessionID: string, title: string) => void;
  private userChoiceManager: UserChoiceManager;
  /** 用户响应 user choice 后的回调（宿主侧用于刷新侧栏流水灯状态） */
  private onUserChoiceResponded?: (sessionId: string) => void;
  /** loadConversation 的单调递增序号：并发切换会话时丢弃过期加载结果 */
  private loadConversationSeq = 0;
  /**
   * UI 侧维护的「最近一次成功加载/新建」会话 ID（原 core 的 activeSessionId）。
   * 「哪个会话在前台」是 UI 自己的状态，core 不感知（DEVELOPMENT.md 第 12.7 节）。
   * 空闲巡检（宿主层 ConversationManager）需要时通过注入的 provider 查询。
   */
  private trackedActiveSessionId: string | undefined;
  /**
   * 宿主同步的「已打开会话」集合（多视图宿主注入；未注入 = 单视图宿主）。
   * open 与 active 是两个概念：多视图下可以同时 open 多个会话，只有一个是 active/selected；
   * UserChoiceQueue 用 `isSessionOpen` 判定请求能否投递到该会话自己的视图里。
   */
  private openSessionIds: Set<string> | null = null;

  /** 消息类型 -> 处理器分发表（构造函数中构建一次） */
  private messageHandlers: Map<string, (msg: any, ctx: WebviewRequestContext) => Promise<void> | void>;

  constructor(deps: {
    host: UIHost;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    postConversationLoaded: (sessionId: string, conversation: any, extra: ConversationLoadedExtra) => void;
    setTitle: (sessionID: string, title: string) => void;
    userChoiceManager: UserChoiceManager;
    onUserChoiceResponded?: (sessionId: string) => void;
  }) {
    this.host = deps.host;
    this.postToWebview = deps.postToWebview;
    this.postConversationLoaded = deps.postConversationLoaded;
    this.setTitle = deps.setTitle;
    this.userChoiceManager = deps.userChoiceManager;
    this.onUserChoiceResponded = deps.onUserChoiceResponded;
    this.messageHandlers = this.buildMessageHandlers();
  }

  /**
   * UI → core：把 webview 协议消息翻译成 UiEvent 发到总线。
   * 本 handler 只做「解析 + 翻译」：改 core 状态的请求发 UiEvent，
   * 写 settings.json 经 UIHost（core 只读不写，见第 7.3 节）。
   */
  private emitUiEvent(event: UiEvent): Promise<void> {
    requireEventBus().emitToCore(event);
    return Promise.resolve();
  }

  /** 当前活跃会话 ID（UI 自己维护的状态；宿主 abort 判定 / MCP 面板使用） */
  getActiveSessionId(): string | undefined {
    return this.trackedActiveSessionId;
  }

  /**
   * 宿主切换前台会话时同步「当前活跃会话」。
   *
   * 多视图宿主（Electron）里切到**已经打开**的视图不会再走 `loadConversation` /
   * `startNewConversation`，必须由宿主在活动视图变化时显式同步，否则
   * `trackedActiveSessionId` 会停在旧视图，导致按会话解析的数据（project skills /
   * MCP 启用列表）取到别的标签页的工作目录。
   */
  setActiveSessionId(sessionId: string | undefined): void {
    this.trackedActiveSessionId = sessionId || undefined;
  }

  /**
   * 宿主同步「已打开会话视图」集合（多视图宿主；视图创建 / 销毁 / LRU 淘汰时调用）。
   *
   * 单视图宿主（VS Code）不调用本方法，`isSessionOpen` 退化为 open == active。
   */
  setOpenSessions(sessionIds: string[]): void {
    this.openSessionIds = new Set(sessionIds);
  }

  /**
   * 该会话是否处于 open 状态（UserChoiceQueue 的投递判定）。
   *
   * - 多视图宿主（Electron）：有聊天视图即 open（可以多个，只有一个 active/selected）
   * - 单视图宿主（VS Code）：open == active == 当前 webview 里显示的会话
   */
  isSessionOpen(sessionId: string): boolean {
    if (this.openSessionIds) {
      return this.openSessionIds.has(sessionId);
    }
    return this.trackedActiveSessionId === sessionId;
  }

  /**
   * 会话被关闭 / 删除：清除 UI 侧维护的 tracked active session
   * （该会话已卸内存，不再被视为前台会话）。
   */
  dropTrackedSession(sessionId: string): void {
    if (this.trackedActiveSessionId === sessionId) {
      this.trackedActiveSessionId = undefined;
    }
  }

  /**
   * 构建消息类型 -> 处理器的分发表。
   * 大多数处理器直接接收消息对象；少数不使用消息参数的处理器
   * （requestSkills / openSpinDesign / requestSettingsDefaults /
   * requestConversationSpaces / getConversations）包装为忽略参数的形式；
   * debugLog 是同步日志分支，包一层同步 lambda。
   */
  private buildMessageHandlers(): Map<string, (msg: any, ctx: WebviewRequestContext) => Promise<void> | void> {
    return new Map<string, (msg: any, ctx: WebviewRequestContext) => Promise<void> | void>([
      // ===== 纯宿主操作（留在 handler 内直接调 UIHost，见第 4.3 节保留清单）=====
      ['openFile', (msg) => this.handleOpenFile(msg)],
      ['requestToolMeta', (msg) => this.handleRequestToolMeta(msg)],
      ['showVirtualDocument', (msg) => this.handleShowVirtualDocument(msg)],
      ['openMermaidPreview', (msg) => this.handleOpenMermaidPreview(msg)],
      ['openSpinDesign', () => this.handleOpenSpinDesign()],
      ['openUrl', (msg) => this.handleOpenUrl(msg)],
      ['debugLog', async (msg) => {
        // 来自 webview 的诊断日志
        this.log(`[Webview Debug] ${msg.message}`);
      }],

      // ===== 无副作用查询（直接调 core 查询函数并回推）=====
      ['requestModels', (msg) => this.handleRequestModels(msg)],
      ['fetchProviderModels', (msg) => this.handleFetchProviderModels(msg)],
      ['detectProviderModelApiTypes', (msg) => this.handleDetectProviderModelApiTypes(msg)],
      ['requestLLMConfig', (msg) => this.handleRequestLLMConfig(msg)],
      ['requestSettingsDefaults', () => this.handleRequestSettingsDefaults()],
      ['requestSkills', (_msg, ctx) => this.handleRequestSkills(ctx)],
      ['requestConversationSpaces', () => this.handleRequestConversationSpaces()],
      ['requestMcpServers', (msg) => this.handleRequestMcpServers(msg)],
      ['getConversations', () => this.handleGetConversations()],
      // 会话运行时状态全量快照：状态流只在「变化」时推，视图创建 / 激活不会补发，
      // 新视图会错过广播；webview 启动 / 切到单视图时主动拉一次（按来源回包）。
      ['requestSessionRuntimeStates', (_msg, ctx) => this.pushSessionRuntimeStates(ctx.sender)],

      // ===== 环境查询（按来源视图直发回包；此前由两宿主在消息入口各自拦截实现）=====
      ['requestTheme', (msg, ctx) => {
        // sender 为 null（单视图宿主 / 宿主主动推送）时广播语义，由 UIHost 实现决定；
        // 指定句柄时只发该视图（Electron 多视图下预热视图也能收到回包）。
        this.host.onThemeChanged(ctx.sender);
      }],
      ['requestContextLimit', (msg, ctx) => this.pushContextLimit(ctx.sender, modelRefOf(msg.provider, msg.model))],

      // ===== 请求响应 / 显示 =====
      ['respondUserChoice', (msg) => this.handleRespondUserChoice(msg)],
      ['expandCompact', (msg) => this.handleExpandCompact(msg)],
      ['rollbackEdit', (msg) => this.emitUiEvent({ type: 'editRolledBack', sessionId: msg.sessionId, toolUseId: msg.toolUseId, direction: msg.direction, filePath: msg.filePath })],

      // ===== 消息 / 压缩 / 中止（UiEvent 翻译）=====
      ['requestCompress', (msg) => this.emitUiEvent({ type: 'compactRequested', sessionId: msg.sessionId })],
      ['sendMessage', (msg) => this.handleUserMessage(msg)],
      ['abort', (msg) => this.handleAbort(msg)],

      // ===== 会话生命周期（UiEvent 翻译）=====
      ['loadConversation', (msg) => this.handleLoadConversation(msg)],
      ['startNewConversation', (msg) => this.handleStartNewConversation(msg)],
      ['deleteConversation', (msg) => this.emitUiEvent({ type: 'conversationDeleted', sessionId: msg.sessionId })],
      ['renameConversation', (msg) => this.emitUiEvent({ type: 'conversationRenamed', sessionId: msg.sessionId, title: msg.title })],
      ['updateConversationContext', (msg) => this.handleUpdateConversationContext(msg)],
      ['clearConversationSpace', (msg) => this.emitUiEvent({ type: 'conversationSpaceCleared', sessionId: msg.dirName })],

      // ===== 会话配置（UiEvent 翻译：core 处理并广播 sessionConfigChanged）=====
      ['setModel', (msg) => this.handleSetModel(msg)],
      ['setThinkingMode', (msg) => this.emitUiEvent({ type: 'thinkingEffortChanged', sessionId: msg.sessionId, mode: msg.mode })],
      ['setPromptMode', (msg) => this.emitUiEvent({ type: 'promptModeChanged', sessionId: msg.sessionId, mode: msg.mode })],
      ['setAgentMode', (msg) => this.emitUiEvent({ type: 'agentModeChanged', sessionId: msg.sessionId, mode: msg.mode })],
      ['setWebSearch', (msg) => this.emitUiEvent({ type: 'webSearchChanged', sessionId: msg.sessionId, enabled: !!msg.webSearch })],
      ['setMcpEnabled', (msg) => this.emitUiEvent({ type: 'mcpEnabledChanged', sessionId: msg.sessionId, name: msg.name, enabled: !!msg.enabled })],

      // ===== 其它（UiEvent 翻译）=====
      ['saveLLMConfig', (msg) => this.handleSaveLLMConfig(msg)],
      ['requestSmartNaming', (msg) => this.handleRequestSmartNaming(msg)],
    ]);
  }

  /**
   * 按消息类型分发到具体处理器，由 handleWebviewMessage() 统一兜底异常。
   */
  private async dispatchWebviewMessage(message: any, ctx: WebviewRequestContext): Promise<void> {
    logger.info("handleWebviewMessage", `Received from webview: ${message.type}`);

    const handler = this.messageHandlers.get(message.type);
    if (handler) {
      await handler(message, ctx);
    } else {
      logger.warn('webviewMessageHandler', `Unknown message type: ${message.type}`);
    }
  }

  private log(...args: unknown[]): void {
    this.host.log(...args);
  }

  /**
   * 处理来自 webview 的消息
   *
   * `ctx.sender` 标识消息来源视图（多视图宿主传入，单视图宿主 / 宿主主动推送为 null），
   * 需要「按来源回包」的消息（requestTheme / requestContextLimit）依赖它定向投递。
   */
  async handleWebviewMessage(message: any, ctx: WebviewRequestContext = DEFAULT_REQUEST_CONTEXT): Promise<void> {
    try {
      await this.dispatchWebviewMessage(message, ctx);
    } catch (err) {
      // 单条消息处理失败不应变成未处理的 rejection：
      // VS Code 会打印 "rejected promise not handled within 1 second"，
      // 且整条消息链路静默失败、难以定位。
      const detail = err instanceof Error ? (err.stack || err.message) : String(err);
      this.log(`[WebviewMessageHandler] handleWebviewMessage failed for type=${message?.type}: ${detail}`);
    }
  }

  /**
   * 当前活跃会话 ID（MCP 启用列表是按会话解析的）。
   * 优先使用调用方显式传入的 sessionId（多 webview 宿主下全局 activeSessionId 可能不准）。
   * 未打开工作区 / 尚未进入任何会话时返回 undefined，此时只用全局默认。
   */
  private async getActiveMcpSessionId(preferred?: string): Promise<string | undefined> {
    if (preferred && preferred !== 'undefined') return preferred;
    const sessionId = this.trackedActiveSessionId;
    return sessionId && sessionId !== 'undefined' ? sessionId : undefined;
  }

  /**
   * 读取 mcp.json + 当前会话的启用状态，并合并运行时状态后推送给 webview。
   */
  private async handleRequestMcpServers(message?: any): Promise<void> {
    const sessionId = await this.getActiveMcpSessionId(message?.sessionId);
    this.log(`MCP servers requested (session=${sessionId ?? '-'})`);
    // 只读展示：引用的建立在 core 的会话生命周期（createEngine / restoreConversationEngine
    // → MCPHost.onSessionOpened），面板只是读状态，不再触发 acquire
    await this.pushMcpServers(sessionId);
  }

  /**
   * 组装并推送 MCP 列表：配置（mcp.json）+ 该会话的启用状态 + 运行时状态。
   * 带上 sessionId，webview 据此区分会话，避免异步回推串到其它会话。
   *
   * 公开给 `WebViewUI`：core 广播 `sessionConfigChanged(mcpEnabled)`（MCP 连接/断开
   * 同步完成）时由 UI 侧调用，重新读取运行时状态回推给 webview。
   */
  async pushMcpServers(sessionId?: string): Promise<void> {
    try {
      // 配置、启用状态与运行时状态都是 core 的事实（`coreFacts.requestMcpServers`）：
      // Embedded 下同进程直读，Standalone 下经 `UiRequest.mcpServersRequested` 索取。
      const servers = await requestMcpServers(sessionId);
      this.host.sendToWebview({
        type: 'setMcpServers',
        sessionId,
        servers,
      });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to read MCP servers: ${err.message}`);
    }
  }

  /**
   * 打开外部链接（使用系统默认浏览器）
   * webview 中点击 markdown 链接时调用
   */
  private async handleOpenUrl(message: any): Promise<void> {
    const url = typeof message.url === 'string' ? message.url : '';
    if (!url) return;
    this.log(`[WebviewMessageHandler] Open URL externally: ${url}`);
    try {
      await this.host.openExternalUrl(url);
    } catch (err) {
      this.log(`[WebviewMessageHandler] Failed to open URL: ${err}`);
    }
  }

  /**
   * 用户消息的唯一处理入口：取 / 建会话引擎，登记会话覆盖，入队到引擎待处理队列。
   *
   * 命令解析、Skill 注入、内置命令执行都发生在引擎的消费循环（轮次边界，见
   * QueryEngine.resolvePendingCommand）。入口不做这些事，因此查询进行中不会被立刻
   * 注入 Skill / 执行内置命令。
   */
  private async handleUserMessage(message: any): Promise<void> {
    const { sessionId, content } = message;
    const images: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }> | undefined = Array.isArray(message.images)
      ? message.images
      : undefined;
    if (!sessionId || typeof content !== 'string' || (!content.trim() && (!images || images.length === 0))) {
      return;
    }
    logger.info('WebviewMessageHandler', `User message received for session ${sessionId} (queue path)`);

    // 用户主动发消息：刷新该会话的空闲关闭计时（空闲回收只在 VS Code 生效）
    this.uiPort?.noteSessionActivity(sessionId);

    // wire 字段名是 `selectedLines`（与 `updateConversationContext` 同一口径）；
    // 进 core 的载荷字段名是 `fileSelectedLines`（`UiEvent.userMessageSubmitted` 的契约名，
    // 见 DEVELOPMENT.md 第 4.3 节 #41），两者在这一层做翻译。
    const selectedLines = message.selectedLines;
    const filePath = typeof message.filePath === 'string' ? message.filePath : undefined;
    const uuid = `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 命令消息（`/xxx`）不做乐观回显：内置命令就地执行、不落盘，立刻画气泡会留下
    // 一个刷新后消失的「幽灵」用户消息。交给引擎在消息真正进入上下文时补发
    // （Skill 命令）或干脆不发（内置命令）——Embedded 走 `QueryEngine.notifyUserMessageToUI`，
    // Standalone 走 `engine::emit_user_message_to_ui`，两侧同一契约。
    const isCommandMessage = content.trim().startsWith('/');

    // 引擎是否仍在忙：读 core 推送的会话运行时状态快照（`sessionRuntimeChanged`，
    // ConversationManager 缓存）。Standalone 下进程内没有引擎，这份快照是宿主唯一
    // 能拿到的「忙碌」事实（`idle === false` 覆盖消费循环运行中与压缩中）。
    // 忙碌时该消息要等下一次 LLM 请求才进入上下文：不在发送侧乐观回显，改为在输入框
    // 上方登记排队项（`docs/user-message-pipeline.md` 第 5.1 节），并置 `deferEcho`
    // 让 core 真正并入上下文时补发用户气泡（第 5.2 节，webview 按 uuid 清除排队项）。
    const runtimeState = this.uiPort
      ?.getSessionRuntimeStatesSnapshot()
      .find((state) => state.sessionId === sessionId);
    const isQueued = runtimeState !== undefined && runtimeState.idle === false;
    const deferEcho = isQueued || isCommandMessage;

    if (isQueued) {
      this.uiPort?.onQueuedMessage(sessionId, {
        uuid,
        content,
        images,
        filePath,
        selectedLines,
        fileHidden: message.fileHidden === true,
      });
    }

    if (!deferEcho) {
      // 立即回显用户气泡（乐观渲染）：core 落盘时沿用同一个 uuid，
      // 因此不需要在消息真正进入上下文时再补发一次 addMessage。
      const uiContent = buildUserContent(content, images);
      const { text: uiText, images: uiImages } = extractUserContent(uiContent);
      const uiMeta: Record<string, unknown> = {};
      if (filePath && !message.fileHidden) {
        const fileName = filePath.split(/[/\\]/).pop();
        uiMeta.filePath = filePath;
        uiMeta.param = `${fileName}${selectedLines ? `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}` : ''}`;
      }
      this.postToWebview(sessionId, {
        type: 'addMessage',
        role: 'user',
        messageUuid: uuid,
        content: uiText,
        images: uiImages.length > 0 ? uiImages : undefined,
        filePath: message.fileHidden ? undefined : filePath,
        fileSelectedLines: message.fileHidden ? undefined : selectedLines,
        meta: Object.keys(uiMeta).length > 0 ? uiMeta : undefined,
      } as Record<string, unknown>);
    }

    // 进入 core 的唯一路径：组装载荷后发 UiEvent。取 / 建引擎、应用会话覆盖、
    // 入队、命令解析与轮次边界消费都在 core 侧（见 docs/user-message-pipeline.md）。
    await this.emitUiEvent({
      type: 'userMessageSubmitted',
      sessionId,
      content,
      uuid,
      images,
      filePath,
      fileSelectedLines: selectedLines,
      fileHidden: message.fileHidden || undefined,
      agentMode: message.agentMode,
      thinkingMode: message.thinkingMode,
      model: this.messageModelRef(message),
      webSearch: typeof message.webSearch === 'boolean' ? message.webSearch : undefined,
      workspacePath: this.host.getWorkspacePath(),
      deferEcho: deferEcho || undefined,
    });
  }

  /**
   * 会话模型切换（webview → core）。
   *
   * webview 侧模型身份是 (provider, model) 整体：provider 缺失或为空串即非法，
   * 记录日志并忽略，不再猜测/回退到其它 provider。
   */
  private async handleSetModel(message: any): Promise<void> {
    const ref = modelRefOf(message?.provider, message?.model);
    if (!ref) {
      this.log(`[WebviewMessageHandler] setModel: provider 为空（非法），忽略 model="${message?.model ?? ''}"`);
      return;
    }
    await this.emitUiEvent({ type: 'modelChanged', sessionId: message.sessionId, ref });
  }

  /**
   * 从 webview 消息的扁平字段组装「本次发送携带的模型身份」。
   *
   * model 与 provider 必须同时提供：只给 model 不给 provider 属于非法
   * （provider 空串不表示「未知」），记录日志并按「未携带模型」处理，
   * 由 Integration 沿用会话已选模型。
   */
  private messageModelRef(message: any): ModelRef | undefined {
    const hasModel = typeof message?.model === 'string' && message.model.trim().length > 0;
    const ref = modelRefOf(message?.provider, message?.model);
    if (hasModel && !ref) {
      this.log(`[WebviewMessageHandler] message carries model without provider (illegal), ignored: model="${message.model}"`);
    }
    return ref;
  }

  private async handleOpenFile(message: any): Promise<void> {
    const { filePath, selectedLines } = message;
    this.log(`[WebviewMessageHandler] openFile: ${filePath} ${JSON.stringify(selectedLines)}`);

    if (!filePath) return;

    try {
      await this.host.openFile(filePath, selectedLines ?? null);
    } catch (err) {
      this.log(`[WebviewMessageHandler] Error opening file: ${err}`);
    }
  }

  private async handleRequestToolMeta(message: any): Promise<void> {
    const { sessionId: targetSessionId, toolUseIds } = message;
    this.log(`[WebviewMessageHandler] requestToolMeta: ${targetSessionId}, ids: ${JSON.stringify(toolUseIds)}`);

    (async () => {
      try {
        // 按会话读盘前先确保会话工作目录已登记（core 不再有活动目录兜底）
        this.ensureSessionWorkspace(targetSessionId);
        const conversation = await loadConversationForHost(targetSessionId);
        const result: Record<string, any> = {};

        // tool_result 里也带着 Edit / Write 的 before/after（旧版本会话或 `_meta`
        // 未落盘时的兜底）。按 tool_use_id 索引，供 `_meta` 缺字段时回退。
        const resultDiff = new Map<string, Record<string, unknown>>();
        for (const msg of conversation.messages) {
          if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              const r = block as { type?: string; tool_use_id?: string;[key: string]: unknown };
              if (r.type === 'tool_result' && typeof r.tool_use_id === 'string') {
                resultDiff.set(r.tool_use_id, r as Record<string, unknown>);
              }
            }
          }
        }

        for (const msg of conversation.messages) {
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              const b = block as { type: string; id?: string; name?: string; input?: any;[key: string]: unknown };
              if (b.type !== 'tool_use' || !toolUseIds.includes(b.id)) continue;
              const meta = (b._meta as Record<string, unknown> | undefined) || {};
              const fallback = resultDiff.get(b.id!);
              const beforeContent = typeof meta.beforeContent === 'string'
                ? meta.beforeContent
                : (typeof fallback?.beforeContent === 'string' ? fallback.beforeContent : undefined);
              const afterContent = typeof meta.afterContent === 'string'
                ? meta.afterContent
                : (typeof fallback?.afterContent === 'string' ? fallback.afterContent : undefined);
              const startLine = (meta.startLine as number | undefined) ?? (fallback?.startLine as number | undefined);
              const endLine = (meta.endLine as number | undefined) ?? (fallback?.endLine as number | undefined);
              const contextBefore = (meta.contextBefore as string[] | undefined) ?? (fallback?.contextBefore as string[] | undefined);
              const contextAfter = (meta.contextAfter as string[] | undefined) ?? (fallback?.contextAfter as string[] | undefined);

              if (b.name === 'Edit' && typeof beforeContent === 'string' && typeof afterContent === 'string') {
                // 按需加载也返回紧凑 diff，避免把完整文件内容发给 webview
                result[b.id!] = {
                  diffHunks: buildEditDiffHunks({
                    beforeContent,
                    afterContent,
                    startLine,
                    endLine,
                    replaceAll: Boolean(b.input?.replace_all),
                  }),
                  contextBefore: contextBefore || [],
                  contextAfter: contextAfter || [],
                  startLine,
                  endLine,
                };
              } else if (b.name === 'Edit' || b.name === 'Write') {
                result[b.id!] = {
                  ...meta,
                  beforeContent: beforeContent ?? meta.beforeContent ?? null,
                  afterContent: afterContent ?? meta.afterContent ?? '',
                  contextBefore: contextBefore || [],
                  contextAfter: contextAfter || [],
                  startLine,
                  endLine,
                };
              } else if (Object.keys(meta).length > 0) {
                result[b.id!] = meta;
              }
            }
          }
        }

        this.host.sendToWebview({
          type: 'toolMetaData',
          toolMeta: result,
          sessionId: targetSessionId,
        });
      } catch (err) {
        this.log(`[WebviewMessageHandler] Error loading tool meta: ${err}`);
      }
    })();
  }

  private async handleShowVirtualDocument(message: any): Promise<void> {
    const { content, title } = message;
    this.log(`[WebviewMessageHandler] showVirtualDocument: ${title}`);
    await this.host.showVirtualDocument(content, title);
  }

  private async handleAbort(message: any): Promise<void> {
    this.log(`Abort requested from webview, sessionId: ${message.sessionId}`);
    // UI → core：中止请求走总线（core 侧由 Integration.abortCurrentQuery 消费）
    await this.emitUiEvent({ type: 'abortRequested', sessionId: message.sessionId });
  }

  private async handleGetConversations(): Promise<void> {
    this.log(`getConversations requested`);
    // 列表查询走 ConversationManager.refresh()（唯一产出 conversationsData 的地方，
    // 见第 5.4 节）；端口未注入时回退直读（过渡形态）
    if (this.uiPort?.refreshConversations) {
      await this.uiPort.refreshConversations();
      return;
    }
    const conversations = await loadConversationListForHost(this.host.getWorkspacePath() ?? undefined);
    this.host.sendToWebview({
      type: 'conversationsData',
      conversations,
    } as WebviewMessage);
  }

  private async handleLoadConversation(message: any): Promise<void> {
    this.log(`[WebviewMessageHandler] loadConversation requested: ${message.sessionId}`);
    // 打开对话：刷新该会话的空闲关闭计时（空闲回收只在 VS Code 生效）
    this.uiPort?.noteSessionActivity(message.sessionId);

    // 并发切换会话竞态防护：用户快速连点两个对话时，两个 handler 会交错执行
    // （后发的 loadConversation 可能先完成）。这里登记本次加载的序号，
    // 所有 await 之后若发现已有更新的加载请求，丢弃过期结果，保证
    // active session 与 webview 实际显示的对话一致。
    const loadSeq = ++this.loadConversationSeq;
    const isStaleLoad = (): boolean => loadSeq !== this.loadConversationSeq;

    // 「哪个会话在前台」是 UI 自己的状态（第 12.7 节）：不再读写 core 的
    // activeSessionId 全局缓存，由本 handler 维护最近一次成功加载的会话。
    const oldSessionId = this.trackedActiveSessionId;
    if (oldSessionId && oldSessionId !== message.sessionId) {
      // 切走前等旧会话的挂起持久化收尾：引擎归 core，宿主只发请求
      // （Embedded 退化为一次同进程调用，Standalone 由 Core 自己等待落盘）。
      this.log(`[WebviewMessageHandler] Flushing pending persists for old session ${oldSessionId}`);
      await requestFlushSession(oldSessionId);
      if (isStaleLoad()) {
        this.log(`[WebviewMessageHandler] loadConversation stale after flush, abort: ${message.sessionId}`);
        return;
      }
    }

    // 先登记该会话的工作目录：core 加载要按它定位 meta.json / jsonl
    this.ensureSessionWorkspace(message.sessionId);
    // 会话内容与派生事实一次取齐（Embedded 读盘 + 进程内事实；Standalone 经 UiRequest）
    const loaded = await loadConversationForHost(message.sessionId);
    const conversation = { messages: loaded.messages, metadata: loaded.metadata ?? undefined };
    if (isStaleLoad()) {
      this.log(`[WebviewMessageHandler] loadConversation stale after disk load, abort: ${message.sessionId}`);
      return;
    }

    this.trackedActiveSessionId = message.sessionId;
    this.log(`Tracked active session: ${message.sessionId}`);
    // Standalone 下 core 以本事件载入会话；同时登记到 openSessions，Core 重启后重放。
    await this.emitUiEvent({ type: 'conversationOpened', sessionId: message.sessionId });
    // 加载对话时查询余额
    this.fetchBalanceAndSend(message.sessionId);

    // MCP：加载对话即建立该会话的引用——由 core 的 restoreConversationEngine /
    // conversationOpened 处理器驱动（幂等，不释放旧会话），UI 不再触发 acquire。
    // 但菜单里的列表是按会话展示的：webview 在 currentSessionId 变化时会先把列表
    // 清空为该会话的缓存，必须回推一次该会话的配置，否则菜单会一直显示「未配置」。
    // 列表内容是 core 的事实（`requestMcpServers`），两种装配同一条路径。
    void this.pushMcpServers(message.sessionId);

    const hasHistory = conversation.messages && conversation.messages.length > 0;
    this.log(`[WebviewMessageHandler] Conversation has history: ${hasHistory}`);

    if (isStaleLoad()) {
      this.log(`[WebviewMessageHandler] loadConversation stale before postConversationLoaded, abort: ${message.sessionId}`);
      return;
    }

    if (conversation.metadata?.title) {
      this.setTitle(message.sessionId, conversation.metadata.title);
    }

    logger.info(
      'handleWebviewMessage',
      `pendingToolUseIds: ${JSON.stringify(loaded.pendingToolUseIds)}`,
    );

    const savedContext = conversation.metadata?.context;
    this.log(`[WebviewMessageHandler] Conversation context: ${JSON.stringify(savedContext)}`);

    // 如果没有 per-session 的 thinkingMode/webSearch/promptMode，从 settings.json 读取默认值
    let effectiveSavedContext = savedContext;
    // meta.json 保持扁平字段：这里组装成模型身份（provider 缺失 → undefined）
    let modelRef = getConversationModelRef(conversation.metadata);
    try {
      if (!savedContext?.thinkingMode || typeof savedContext?.webSearch !== 'boolean' || !savedContext?.promptMode) {
        const snapshot = getSettingsStore().getSnapshot();
        const defaultThinkingEffort = readDefaultThinkingEffort(snapshot);
        const defaultWebSearch = readDefaultWebSearch(snapshot);
        let nextCtx = effectiveSavedContext;
        if (!nextCtx?.thinkingMode) {
          nextCtx = { ...(nextCtx || {}), thinkingMode: defaultThinkingEffort };
        }
        if (typeof nextCtx?.webSearch !== 'boolean') {
          nextCtx = { ...(nextCtx || {}), webSearch: defaultWebSearch };
        }
        // 加载已有对话时，meta.json 中未保存 promptMode 则用配置快照的默认值
        // （默认值只有一处来源，见 `docs/webview-facts.md` 第 2 节）
        if (!nextCtx?.promptMode) {
          nextCtx = { ...(nextCtx || {}), promptMode: readDefaultPromptMode(snapshot) };
        }
        effectiveSavedContext = nextCtx;
      }
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to read default thinking/webSearch from settings.json: ${err.message}`);
    }

    // 切换对话后校验模型身份（meta.json 是扁平字段，这里解析成 ModelRef）：
    // - 未记录 provider（undefined）→ 取 active provider 的默认模型，但不回写 meta.json；
    // - provider 已被移除 / 模型不在其列表 → 解析出可用身份，回写 meta.json 并同步引擎配置；
    // - 身份合法 → 原样使用。
    try {
      const stored = modelRef;
      const resolved = resolveModelRef(getSettingsStore().getSnapshot(), stored);
      modelRef = resolved;
      if (stored && !sameModelRef(stored, resolved)) {
        this.log(`[WebviewMessageHandler] Session model (provider="${stored.provider}", model="${stored.model}") invalid, resolved to (provider="${resolved?.provider ?? ''}", model="${resolved?.model ?? ''}")`);
        if (resolved) {
          // 模型身份的落盘与引擎同步都归 core（`UiEvent.modelChanged` 的 core 侧
          // 处理器写 meta.json + setSessionModel），宿主不直接调用 core 的状态变更函数。
          await this.emitUiEvent({ type: 'modelChanged', sessionId: message.sessionId, ref: resolved });
        }
      }
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to resolve model for session: ${err.message}`);
    }

    // 会话询问模式归 core：core 的权威取值未记录时回退 meta.json / settings.json 默认值。
    // 权限决策在 PermissionPolicy 中读取，这里只为 conversationLoaded 带上展示值。
    let effectiveAgentMode: 'manual' | 'risk' | 'auto' | undefined =
      loaded.agentMode ?? undefined;
    if (!effectiveAgentMode) {
      effectiveAgentMode = (conversation.metadata?.context?.agentMode as 'manual' | 'risk' | 'auto' | undefined) ?? undefined;
    }
    if (!effectiveAgentMode) {
      // 会话未记录询问模式：用配置快照的默认值（默认值只有一处来源）。
      // 快照读不到属于接线错误，保持未到达（不猜取值），webview 侧显示等待态。
      try {
        effectiveAgentMode = readDefaultAgentMode(getSettingsStore().getSnapshot());
        this.log(`[WebviewMessageHandler] No agentMode for session ${message.sessionId}, using configured default ${effectiveAgentMode}`);
      } catch (err: any) {
        this.log(`[WebviewMessageHandler] Failed to read default agentMode: ${err.message}`);
      }
    }

    // 该会话**自己的**查询是否在跑（`SessionUiState` 的查询计数，跨 Embedded / Standalone）：
    // webview 重新加载会话时据此恢复 thinking 动画。
    // 不能用 `sessionRuntime.idle === false`：那是「会话非空闲」口径，包含后台子代理 /
    // 后台 Bash / 压缩；后台子代理在等用户时父会话会 idle=false，重新加载父会话就会
    // 误恢复出 thinking 动画（DEVELOPMENT.md 第 10 节）。
    const hasActiveQuery = this.uiPort?.isQueryActive(message.sessionId) ?? false;

    // 压缩归档是否存在由 core 判定（随会话加载结果一次返回）
    const hasCompactArchive = loaded.hasCompactArchive;

    this.postConversationLoaded(message.sessionId, conversation, {
      pendingToolUseIds: loaded.pendingToolUseIds,
      savedContext: effectiveSavedContext,
      parentSessionId: conversation.metadata?.parentSessionId,
      agentMode: effectiveAgentMode,
      hasActiveQuery,
      hasCompactArchive,
      modelRef,
    });

    userChoiceQueue.onSessionLoaded(message.sessionId);

    // Standalone 下会话引擎归 Core 进程所有：UI 进程不建引擎（core 已由
    // conversationOpened 载入历史），只负责把消息渲染给 webview。
    if (hasHistory && resolveCoreKind() === 'embedded') {
      this.log(`[WebviewMessageHandler] Restoring conversation engine with ${conversation.messages.length} history messages`);
      void import('../../core/Integration.js').then(({ restoreConversationEngine }) =>
        restoreConversationEngine(
          message.sessionId,
          conversation.messages,
          conversation.metadata?.role,
        ),
      ).catch(err => {
        this.log(`[WebviewMessageHandler] Error restoring engine: ${err}`);
      });
    }
  }

  private async handleUpdateConversationContext(message: any): Promise<void> {
    this.log(`[WebviewMessageHandler] updateConversationContext: ${message.sessionId}`);
    // 写 meta.json 的请求翻译成 UiEvent.conversationContextUpdated 走总线
    // （core 侧消费方 initializeCoreEvents → history.updateConversationContext）。
    // webview 消息是扁平字段，总线载荷是 changes 数组，这里做映射；
    // 未携带的字段不进入 changes，保持 meta.json 原值。
    const changes: Extract<UiEvent, { type: 'conversationContextUpdated' }>['changes'] = [];
    if (message.currentFile !== undefined) {
      changes.push({ key: 'currentFile', value: message.currentFile ?? null });
    }
    if (message.selectedLines !== undefined) {
      changes.push({ key: 'selectedLines', value: message.selectedLines ?? null });
    }
    if (message.totalContextTokens !== undefined) {
      changes.push({ key: 'totalContextTokens', value: message.totalContextTokens });
    }
    await this.emitUiEvent({ type: 'conversationContextUpdated', sessionId: message.sessionId, changes });
  }

  /**
   * 登记会话的工作目录（core 按会话解析目录的唯一来源）。
   *
   * 多视图宿主（Electron）在把消息交给本 handler 之前已按来源视图登记，
   * 此时以其为准；单目录宿主（VS Code）没有这一步，用宿主当前工作目录登记。
   * 必须在 core 首次按会话解析目录（loadConversation / createEngine）之前调用。
   */
  private ensureSessionWorkspace(sessionId: string): void {
    // 会话已有归属时以它为准：多工作区宿主里活动目录可能不是该会话自己的目录
    // （Electron 按来源视图登记；Client 的路由也以先登记者为先）。
    const registered = getSessionWorkspace(sessionId);
    const workspacePath = registered ?? this.host.getWorkspacePath();
    if (!workspacePath) return;
    // Embedded：同一进程、同一张表，直接写（幂等）。
    if (!registered) setSessionWorkspace(sessionId, workspacePath);
    // Standalone：会话工作目录表在 Core 进程内，只有事件能过去（Embedded 的事件
    // 处理器转调同一个函数，重复写等价）。
    requireEventBus().emitToCore({ type: 'sessionWorkspaceAssigned', sessionId, workspacePath });
  }

  private async handleStartNewConversation(message: any): Promise<void> {
    const newSessionId = message.sessionId;
    // 「哪个会话在前台」由 UI 自己维护（第 12.7 节）
    this.trackedActiveSessionId = newSessionId;
    // 先登记该会话的工作目录：core 收到 conversationStarted 后要按会话解析目录建引擎
    this.ensureSessionWorkspace(newSessionId);
    // UI → core：报告「用户新建了对话」（core 预创建引擎）
    await this.emitUiEvent({ type: 'conversationStarted', sessionId: newSessionId });
    // 登记为「已打开会话」：Standalone 下 Core 重启后据此重放 conversationOpened。
    await this.emitUiEvent({ type: 'conversationOpened', sessionId: newSessionId });
    // 新建对话：开始空闲关闭计时（空闲回收只在 VS Code 生效）
    this.uiPort?.noteSessionActivity(newSessionId);
    this.setTitle(newSessionId, defaultTitle());
    // 新对话开始时查询余额
    this.fetchBalanceAndSend(newSessionId);

    // MCP：新对话打开即建立引用——由 core 的 createEngine（conversationStarted
    // 事件消费）→ MCPHost.onSessionOpened 驱动，UI 不再触发 acquire。
    // Standalone 下 MCP 尚未迁入，且 UI 进程不应触碰 MCPHost，跳过回推。
    if (resolveCoreKind() === 'embedded') {
      void this.pushMcpServers(newSessionId);
    }

    // 从 settings.json 读取新对话的默认 model、thinking_effort、agentMode 和 webSearch 并发送给 webview 立即应用。
    // 注意：不再写入 meta.json（meta.json 只在发第一条消息时由 appendMessage 创建），
    // 默认值在发送第一条消息后仍可通过 handleSetModel/handleSetThinkingMode/handleSetPromptMode 持久化。
    try {
      const snapshot = getSettingsStore().getSnapshot();
      const defaultModelRef = readActiveModelRef(snapshot);
      const defaultThinkingEffort = readDefaultThinkingEffort(snapshot);
      const defaultAgentMode = readDefaultAgentMode(snapshot);
      const defaultPromptMode = readDefaultPromptMode(snapshot);
      const defaultWebSearch = readDefaultWebSearch(snapshot);
      this.postToWebview(newSessionId, {
        type: 'setNewConversationDefaults',
        // wire 协议保持扁平：模型身份拆成 model / provider 两个字段
        model: defaultModelRef?.model ?? '',
        provider: defaultModelRef?.provider,
        thinkingMode: defaultThinkingEffort,
        agentMode: defaultAgentMode,
        promptMode: defaultPromptMode,
        webSearch: defaultWebSearch,
      });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to send defaults: ${err.message}`);
    }

    // 新对话引导配置：未配置 active provider 或 apiKey 为空时弹设置页。
    // core 只提供配置事实，消息组装在 WebViewUI（sessionId 定向到刚创建的会话）。
    await this.uiPort?.showLLMConfigPanel('new-conversation', newSessionId);
  }

  /**
   * 获取 DeepSeek 账户余额并发送到 webview。
   *
   * 余额要按 `settings.json` 里 `api.deepseek.com` 这个 provider 的 apiKey 查
   * （与 active provider 无关），因此 Standalone 下由 Core 查、宿主取结果——
   * 宿主不读 core 的配置文件。
   */
  private fetchBalanceAndSend(sessionID: string): void {
    void (async () => {
      try {
        const balanceInfo = await requestBalance(sessionID);
        if (balanceInfo) {
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: balanceInfo.totalBalance,
            currency: balanceInfo.currency,
            isUnlimited: balanceInfo.isUnlimited,
            fetchedAt: balanceInfo.fetchedAt,
          });
        } else {
          // 获取余额失败时清空余额，避免 webview 继续显示旧值
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: null,
            currency: null,
            isUnlimited: null,
            fetchedAt: Date.now(),
          });
        }
      } catch (err: unknown) {
        this.log(`Failed to fetch balance: ${err}`);
      }
    })();
  }

  private async handleRespondUserChoice(message: any): Promise<void> {
    this.log(`[WebviewMessageHandler] User choice response: ${message.choiceId}, index: ${message.index}`);
    const pending = this.userChoiceManager.pendingUserChoices.get(message.choiceId);
    if (pending) {
      this.userChoiceManager.pendingUserChoices.delete(message.choiceId);
      userChoiceQueue.respond(pending.sessionId, { index: message.index, reply: message.reply });
      pending.resolve({ index: message.index, reply: message.reply });
      this.onUserChoiceResponded?.(pending.sessionId);
    } else {
      this.log(`[WebviewMessageHandler] Warning: No pending choice found for ${message.choiceId}`);
    }
  }

  /**
   * 读取当前上下文上限并回包 `contextLimitUpdated`。
   *
   * 两条路径共用这一份实现：webview 的 `requestContextLimit`（带模型身份），以及
   * 宿主在视图加载完成时的初始化推送（`ref` 为 undefined，按 active provider 默认模型算）。
   * 上下文上限取自 `SettingsStore` 的配置快照（已解析的模型限值，
   * 含内置注册表与用户覆盖的合并结果）。投递：
   * - `sender` 指定句柄：直发该视图（Electron 多视图，预热视图也能收到）；
   * - `sender` 为 null：走默认路由（单视图宿主即唯一 webview）。
   */
  pushContextLimit(sender: WebviewRequestContext['sender'], ref?: ModelRef): void {
    try {
      const message: WebviewMessage = {
        type: 'contextLimitUpdated',
        maxContextTokens: getSettingsStore().readContextLimit(ref),
      };
      if (sender) {
        this.host.sendToWebviewView(sender, message);
      } else {
        this.host.sendToWebview(message);
      }
    } catch (err) {
      const detail = err instanceof Error ? (err.stack || err.message) : String(err);
      this.log(`[WebviewMessageHandler] pushContextLimit failed: ${detail}`);
    }
  }

  /**
   * 推送会话运行时状态（idle / waiting）的全量快照，回包 `sessionRuntimeStates`。
   *
   * 状态流（core `sessionRuntimeChanged` → `dispatchStates`）只在**变化**时推一次，
   * 视图创建 / 激活时不会补发。webview 启动、或切到单视图（浮窗）时主动拉一次，
   * 避免新视图的对话树流水灯 / abort 按钮 / 历史提醒因为错过广播而"失明"到下一次状态变化。
   *
   * 投递：`sender` 指定句柄时直发该视图（Electron 多视图下请求方不一定是活动视图）；
   * `sender` 为 null 时走默认路由（单视图宿主即唯一 webview）。
   */
  private pushSessionRuntimeStates(sender: WebviewRequestContext['sender']): void {
    try {
      // 状态源是 core 推送的 sessionRuntimeChanged 快照（经 ConversationManager 缓存）。
      // 不能用进程内的 getSessionRuntimeStates()：Standalone 下该模块不被写入，恒为空。
      const states = this.uiPort?.getSessionRuntimeStatesSnapshot() ?? [];
      const message: WebviewMessage = {
        type: 'sessionRuntimeStates',
        states,
      };
      if (sender) {
        this.host.sendToWebviewView(sender, message);
      } else {
        this.host.sendToWebview(message);
      }
    } catch (err) {
      const detail = err instanceof Error ? (err.stack || err.message) : String(err);
      this.log(`[WebviewMessageHandler] pushSessionRuntimeStates failed: ${detail}`);
    }
  }

  private async handleRequestModels(_message: any): Promise<void> {
    this.log(`[WebviewMessageHandler] Requesting model list from all providers`);
    try {
      const settings = getSettingsStore().getRawSettings();
      const providersMap: Record<string, any> =
        settings?.llm?.providers && typeof settings.llm.providers === 'object'
          ? settings.llm.providers
          : {};
      const activeKey = typeof settings?.llm?.activeProvider === 'string'
        && providersMap[settings.llm.activeProvider]?.baseURL
        ? settings.llm.activeProvider
        : '';

      const normalize = (raw: unknown): string[] => Array.isArray(raw)
        ? Array.from(new Set(
            (raw as unknown[])
              .filter((m): m is string => typeof m === 'string' && !!m.trim())
              .map((m) => m.trim()),
          ))
        : [];

      // 按 settings.json 的定义顺序收集全部 provider（baseURL 非空）。
      // 模型名与 provider 分开存放，菜单据此建立三级子菜单，不做字符串拼接。
      const groups = Object.entries(providersMap)
        .filter(([, p]) => !!p?.baseURL)
        .map(([key, p]) => {
          const models = normalize(p?.models);
          const defaultModel = typeof p?.defaultModel === 'string' && p.defaultModel.trim()
            ? p.defaultModel.trim()
            : models[0];
          const unique = Array.from(new Set(models.filter((m) => !!m.trim())));
          if (defaultModel && !unique.includes(defaultModel)) unique.unshift(defaultModel);
          return {
            key,
            baseURL: typeof p?.baseURL === 'string' ? p.baseURL.trim() : '',
            apiKey: typeof p?.apiKey === 'string' ? p.apiKey.trim() : '',
            defaultModel,
            models: unique,
          };
        });

      // 仅 active provider 尝试从 API 拉取最新模型并合并（其它 provider 直接用已保存列表）。
      const activeGroup = groups.find((g) => g.key === activeKey);
      if (activeGroup && activeGroup.baseURL && activeGroup.apiKey) {
        try {
          const fetched = await this.fetchModelsFromProvider(activeGroup.baseURL, activeGroup.apiKey);
          if (fetched.length > 0) {
            this.log(`[WebviewMessageHandler] Fetched ${fetched.length} models from API for ${activeGroup.key}`);
            activeGroup.models = Array.from(new Set(
              [activeGroup.defaultModel, ...fetched, ...activeGroup.models].filter((m) => !!m && !!m.trim()),
            ));
          } else {
            this.log(`[WebviewMessageHandler] API returned no models for ${activeGroup.key}, using saved models`);
          }
        } catch (err: any) {
          this.log(`[WebviewMessageHandler] Failed to fetch models for ${activeGroup.key}: ${err?.message || err}`);
        }
      }

      this.host.sendToWebview({
        type: 'setModels',
        providers: groups.map((g) => ({ key: g.key, models: g.models })),
        activeProvider: activeKey,
      });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to fetch models: ${err.message}`);
      this.host.sendToWebview({ type: 'setModels', providers: [], activeProvider: '' });
    }
  }

  /** 从消息里提取「模型名 -> 协议」映射（只保留合法的协议值） */
  private extractApiTypeMap(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [model, apiType] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof apiType === 'string' && (apiType === 'Responses' || apiType === 'OpenAI' || apiType === 'Anthropic')) {
        out[model] = apiType;
      }
    }
    return out;
  }

  /**
   * 处理设置页的「自动获取模型」请求 —— 阶段一：只拉取模型列表。
   *
   * 协议探测会向服务商发送探测请求（虽然极小，但可能产生少量 token），
   * 因此这里只把「哪些模型还没有协议」回传给面板，由用户确认后再执行探测
   * （见 handleDetectProviderModelApiTypes）。
   */
  private async handleFetchProviderModels(message: any): Promise<void> {
    const baseURL = typeof message?.baseURL === 'string' ? message.baseURL.trim() : '';
    const apiKey = typeof message?.apiKey === 'string' ? message.apiKey.trim() : '';
    // 面板已知的模型协议：已有值的不需要再探测
    const knownApiTypes = this.extractApiTypeMap(message?.knownApiTypes);
    if (!baseURL || !apiKey) {
      this.host.sendToWebview({ type: 'providerModelsFetched', models: [], modelApiTypes: {}, needDetect: [] });
      return;
    }
    try {
      this.log(`[WebviewMessageHandler] Fetching provider models from ${baseURL}`);
      const models = await this.fetchModelsFromProvider(baseURL, apiKey);

      // 只回传「本次列表里且已有协议」的映射，避免把无关模型带回面板
      const modelApiTypes: Record<string, string> = {};
      for (const model of models) {
        if (knownApiTypes[model]) modelApiTypes[model] = knownApiTypes[model];
      }
      const needDetect = models.filter((m) => !modelApiTypes[m]);
      this.log(`[WebviewMessageHandler] Fetched ${models.length} models, ${needDetect.length} without API type`);
      this.host.sendToWebview({ type: 'providerModelsFetched', models, modelApiTypes, needDetect });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to fetch provider models: ${err.message}`);
      this.host.sendToWebview({ type: 'providerModelsFetched', models: [], modelApiTypes: {}, needDetect: [] });
    }
  }

  /**
   * 处理设置页的「确认后自动检测模型协议」请求 —— 阶段二。
   * 面板已就「可能消耗少量 token」征得用户同意，这里才真正发起探测。
   */
  private async handleDetectProviderModelApiTypes(message: any): Promise<void> {
    const baseURL = typeof message?.baseURL === 'string' ? message.baseURL.trim() : '';
    const apiKey = typeof message?.apiKey === 'string' ? message.apiKey.trim() : '';
    const models = Array.isArray(message?.models)
      ? Array.from(new Set(
          (message.models as unknown[])
            .filter((m): m is string => typeof m === 'string' && !!m.trim())
            .map((m) => m.trim()),
        ))
      : [];
    const knownApiTypes = this.extractApiTypeMap(message?.knownApiTypes);

    const modelApiTypes: Record<string, string> = {};
    for (const model of models) {
      if (knownApiTypes[model]) modelApiTypes[model] = knownApiTypes[model];
    }
    const toDetect = models.filter((m) => !modelApiTypes[m]);

    if (!baseURL || !apiKey || toDetect.length === 0) {
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes });
      return;
    }

    try {
      this.log(`[WebviewMessageHandler] Detecting API type for ${toDetect.length} model(s) concurrently (concurrency=${API_TYPE_PROBE_CONCURRENCY})...`);
      const started = Date.now();
      const detected = await mapWithConcurrency(
        toDetect,
        API_TYPE_PROBE_CONCURRENCY,
        async (model) => ({ model, apiType: await this.detectModelApiType(baseURL, apiKey, model) }),
      );
      for (const item of detected) {
        if (item.apiType) modelApiTypes[item.model] = item.apiType;
      }
      this.log(`[WebviewMessageHandler] API type detection finished in ${Date.now() - started}ms (${Object.keys(modelApiTypes).length}/${models.length} resolved)`);
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to detect provider model api types: ${err.message}`);
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes });
    }
  }

  /** 从服务商拉取模型列表（兼容 /v1/models 与 /models，兼容 data[].id / data[].model / string） */
  private async fetchModelsFromProvider(baseURL: string, apiKey: string): Promise<string[]> {
    const trimmed = baseURL.replace(/\/+$/, '');
    const probeSessionId = `probe-${Date.now()}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // 同时携带 Anthropic 风格的鉴权头，兼容只认 x-api-key 的网关
      'x-api-key': apiKey,
      'x-opencode-session': probeSessionId,
      'x-session-id': probeSessionId,
    };
    const candidateUrls = [
      `${trimmed}/v1/models`,
      `${trimmed}/models`,
    ];
    for (const url of candidateUrls) {
      try {
        const response = await undiciFetch(url, { headers, dispatcher: getProbeDispatcher() });
        if (!response.ok) continue;
        const data = await response.json() as { data?: unknown[]; models?: unknown[]; model_ids?: unknown[] };
        const rawList: unknown[] = Array.isArray(data.data) ? data.data
          : Array.isArray(data.models) ? data.models
          : Array.isArray(data.model_ids) ? data.model_ids
          : [];
        const models = rawList
          .map((item: unknown) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
              const record = item as Record<string, unknown>;
              const id = typeof record.id === 'string' ? record.id : (typeof record.model === 'string' ? record.model : '');
              return id.trim();
            }
            return '';
          })
          .filter((m): m is string => !!m);
        if (models.length > 0) {
          return Array.from(new Set(models));
        }
      } catch {
        // 尝试下一个候选地址
      }
    }
    return [];
  }

  /**
   * 近乎零成本地探测单个模型支持的 API 协议。
   *
   * 各协议的探测规则（如何构建探测请求、如何判定响应）由 apiTypes 注册表中的
   * 协议类实现（一个 Type 一个类），这里只负责按优先级并发发起、按顺序等待，
   * 取第一个可用的协议。
   *
   * 原理：网关按「路径定协议 → 查模型是否注册该协议 → 鉴权 → 转发上游」的顺序处理。
   * 探测 body 故意不携带必填字段，请求会在上游入参校验阶段被拒，正常情况下不会
   * 进入推理，因此不产生 completion、不消耗 token（各协议实现里用 1 token 兜底封顶）。
   *
   * 结果不确定（限流 / 地区限制 / 网络异常）时返回 null 而不是猜测，
   * 避免写入错误的协议。
   *
   * @returns 探测到的协议；不确定或所有协议都不支持时返回 null
   */
  private async detectModelApiType(baseURL: string, apiKey: string, model: string): Promise<ApiType | null> {
    const sessionId = `probe-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    // 按探测优先级取已注册的协议（未注册的协议自动跳过）
    const definitions = apiTypeRegistry.listByProbePriority();
    if (definitions.length === 0) return null;

    const candidates = definitions.map((definition) => ({
      definition,
      request: definition.buildProbeRequest({ baseURL, apiKey, model, sessionId }),
    }));

    // 所有协议**同时发起**，但按优先级顺序 await：
    // 高优先级一旦有结论就立即返回并 abort 掉其余探测，
    // 不必等低优先级那些慢请求（最坏情况等价于 Promise.all，最好情况省掉大部分等待）。
    const controllers = candidates.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), API_TYPE_PROBE_TIMEOUT_MS));

    const probes = candidates.map((candidate, index) =>
      this.probeWithRetry(candidate, model, sessionId, controllers[index]));

    const abortLower = (fromIndex: number): void => {
      for (let lower = fromIndex + 1; lower < controllers.length; lower++) {
        controllers[lower].abort();
      }
    };

    try {
      for (let index = 0; index < candidates.length; index++) {
        const verdict = await probes[index];
        if (verdict === 'supported') {
          // 命中即中止所有更低优先级的探测，避免无谓等待
          abortLower(index);
          return candidates[index].definition.type;
        }
        if (verdict === 'unknown') {
          // 高优先级结果不确定（限流重试后仍失败 / 地区限制 / 网络异常）：
          // 不猜测、不降级到低优先级，交给用户手动选择或下次自动获取时重试
          this.log(`[WebviewMessageHandler] probe ${model}: ${candidates[index].definition.type} verdict unknown, skipping detection (will retry next fetch)`);
          abortLower(index);
          return null;
        }
      }
      return null;
    } finally {
      for (const controller of controllers) controller.abort();
      for (const timer of timers) clearTimeout(timer);
    }
  }

  /**
   * 探测一次（含限流重试）。
   *
   * 网关/上游返回 429（限流）、502/503/504（瞬时故障）时按退避重试，
   * 而不是直接判为「不支持」——否则一次限流就会让该模型选到错误的协议。
   * 优先遵循 Retry-After 响应头。
   */
  private async probeWithRetry(
    candidate: { definition: ApiTypeDefinition; request: ApiTypeProbeRequest },
    model: string,
    sessionId: string,
    controller: AbortController,
  ): Promise<ProbeVerdict> {
    const apiType = candidate.definition.type;
    let lastStatus = 0;
    for (let attempt = 0; attempt <= API_TYPE_PROBE_MAX_RETRIES; attempt++) {
      if (controller.signal.aborted) return 'unknown';
      try {
        const response = await undiciFetch(candidate.request.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-opencode-session': sessionId,
            'x-session-id': sessionId,
            ...candidate.request.headers,
          },
          body: JSON.stringify(candidate.request.body),
          signal: controller.signal,
          dispatcher: getProbeDispatcher(),
        });
        const text = await response.text();
        lastStatus = response.status;

        // 限流 / 瞬时故障：退避重试
        if (API_TYPE_PROBE_RETRYABLE_STATUS.has(response.status) && attempt < API_TYPE_PROBE_MAX_RETRIES) {
          const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
          const delay = retryAfterMs ?? API_TYPE_PROBE_RETRY_BASE_DELAY_MS * (attempt + 1);
          this.log(`[WebviewMessageHandler] probe ${model} ${apiType} -> HTTP ${response.status} (retryable), retrying in ${delay}ms (${attempt + 1}/${API_TYPE_PROBE_MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // 判定规则由协议类实现（默认复用 ProbeClassify 的通用三态规则）
        const verdict = candidate.definition.classifyProbeResponse(response.status, text);
        this.log(`[WebviewMessageHandler] probe ${model} ${apiType} -> HTTP ${response.status} ${verdict}${verdict === 'supported' ? '' : ` ${text.slice(0, 160)}`}`);
        return verdict;
      } catch (err: any) {
        // 被主动 abort 的低优先级探测不记录为错误
        if (controller.signal.aborted) return 'unknown';
        // 网络错误也重试
        if (attempt < API_TYPE_PROBE_MAX_RETRIES) {
          const delay = API_TYPE_PROBE_RETRY_BASE_DELAY_MS * (attempt + 1);
          this.log(`[WebviewMessageHandler] probe ${model} ${apiType} -> error ${err?.message || err}, retrying in ${delay}ms (${attempt + 1}/${API_TYPE_PROBE_MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        this.log(`[WebviewMessageHandler] probe ${model} ${apiType} -> error ${err?.message || err}`);
        return 'unknown';
      }
    }
    this.log(`[WebviewMessageHandler] probe ${model} ${apiType} -> exhausted retries (last HTTP ${lastStatus})`);
    return 'unknown';
  }

  /** 解析 Retry-After 响应头（秒数或 HTTP 日期），非法时返回 undefined */
  private parseRetryAfterMs(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, API_TYPE_PROBE_MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(date - Date.now(), 0), API_TYPE_PROBE_MAX_RETRY_DELAY_MS);
    }
    return undefined;
  }

  private async handleRequestSkills(ctx: WebviewRequestContext): Promise<void> {
    this.log(`[WebviewMessageHandler] Skills requested`);
    // 命令 / 技能是 core 的事实：Embedded 同进程组装，Standalone 经 UiRequest 取回。
    // 项目技能基于会话自己的工作目录扫描（会话归属取 `trackedActiveSessionId`——
    // 多视图宿主下由宿主在活动视图变化时同步，否则会扫到别的标签页的技能）；
    // 没有工作目录时（空态视图也会请求技能）只列内置项。
    const skills = await requestSkills(this.trackedActiveSessionId);
    const message: WebviewMessage = {
      type: 'setSkills',
      skills,
    };
    // 按来源视图回包（多视图宿主下请求方不一定是活动视图）
    if (ctx.sender) {
      this.host.sendToWebviewView(ctx.sender, message);
    } else {
      this.host.sendToWebview(message);
    }
  }

  private async handleOpenMermaidPreview(message: any): Promise<void> {
    const code: string = message.code || '';
    if (!code.trim()) return;

    this.log(`[WebviewMessageHandler] openMermaidPreview`);
    try {
      await this.host.openMermaidPreview(code);
    } catch (err) {
      this.log(`[WebviewMessageHandler] Error opening mermaid preview: ${err}`);
    }
  }

  public async handleOpenSpinDesign(): Promise<void> {
    this.log(`openSpinDesign`);
    try {
      // Spin 设计器是独立 surface（第 5.2 节）：经由 WebViewUI 转发到 SpinDesign.open，
      // 不再放回 UIHost
      if (this.uiPort?.openSpinDesign) {
        await this.uiPort.openSpinDesign();
      }
    } catch (err) {
      this.log(`Error opening spin design: ${err}`);
    }
  }

  /**
   * 智能命名：读会话消息 → 调 LLM → 解析标题。
   *
   * Standalone 下会话消息与 LLM 配置都在 Core 侧，整段生成过程经
   * `UiRequest.smartNamingRequested` 交给 Core；两种装配下本方法的后半段相同。
   */
  private async handleRequestSmartNaming(message: any): Promise<void> {
    const sessionId = message.sessionId;
    // 会话可能只出现在对话树里、尚未加载：先按会话登记工作目录再交给 core 解析
    this.ensureSessionWorkspace(sessionId);
    this.log(`[WebviewMessageHandler] requestSmartNaming: ${sessionId}`);
    try {
      const title = await requestSmartNaming(sessionId);
      this.log(`[WebviewMessageHandler] smartNaming result for ${sessionId}: "${title}"`);
      this.setTitle(sessionId, title);
      this.host.sendToWebview({ type: 'smartNamingResult', sessionId, title });
      // UI → core：标题写盘走总线（core 落盘 + 广播 titleChanged / conversationListChanged）；
      // 列表刷新由 conversationListChanged → ConversationManager.refresh() 统一驱动，
      // 这里不再直接落盘、也不直接推 conversationsData。
      await this.emitUiEvent({ type: 'conversationRenamed', sessionId, title });
    } catch (error: any) {
      this.log(`[WebviewMessageHandler] smartNaming error: ${error.message}`);
    }
  }

  /**
   * 展开压缩归档：把「归档消息 + 当前未压缩部分」整批替换 webview 的显示。
   *
   * Standalone 下归档与主 JSONL 都在 Core 侧，合并口径也在 Core 侧实现
   * （`compact_archive_display`），宿主只负责转换与下发。
   */
  private async handleExpandCompact(message: any): Promise<void> {
    this.log(`[WebviewMessageHandler] expandCompact requested: ${message.sessionId}`);
    try {
      const messagesToDisplay = await requestCompactArchive(message.sessionId);
      if (!messagesToDisplay || messagesToDisplay.length === 0) {
        this.log(`[WebviewMessageHandler] No compact archive found for ${message.sessionId}`);
        return;
      }
      this.log(
        `[WebviewMessageHandler] Expanding compact: ${messagesToDisplay.length} messages`,
      );

      // 整批替换 webview 当前显示：转换逻辑与 core 的压缩后重建共用同一个纯函数
      // （`buildReplayMessageData`），不再在这里复制一份裁剪 / diffHunks 逻辑。
      this.host.sendToWebview({
        type: 'messagesReplaced',
        sessionId: message.sessionId,
        messages: buildReplayMessageData(messagesToDisplay),
      });

      // 通知 webview 展开完成（删除展开按钮）
      this.host.sendToWebview({
        type: 'expandCompactDone',
        sessionId: message.sessionId,
      });

      this.log(`[WebviewMessageHandler] Compact expanded for ${message.sessionId}: messages displayed from archive`);
    } catch (err) {
      this.log(`[WebviewMessageHandler] Failed to expand compact for ${message.sessionId}: ${err}`);
    }
  }

  /**
   * 处理来自 webview 的 LLM 配置保存请求
   * 保存 baseURL、apiKey、apiType、models、defaultModel、webSearch 到 ~/<CONFIG_DIR_NAME>/settings.json 的 llm.*；
   * 默认 thinking_effort 保存到 llm.thinking_effort；
   * 默认工作模式和默认提示词模式保存到顶层（defaultAgentMode / defaultPromptMode，与 llm 平级）
   */
  private async handleSaveLLMConfig(message: any): Promise<void> {
    const {
      webSearch, thinkingEffort,
      defaultAgentMode, defaultPromptMode, language,
      providers, activeProvider: requestedActiveProvider, closeAfterSave,
      saveProviders,
      sessionId: requestedSessionId, currentModel: requestedCurrentModel,
      currentProvider: requestedCurrentProvider,
    } = message;

    this.log(`[WebviewMessageHandler] saveLLMConfig: webSearch=${!!webSearch}, thinkingEffort=${thinkingEffort}, defaultAgentMode=${defaultAgentMode}, defaultPromptMode=${defaultPromptMode}, language=${language}, saveProviders=${!!saveProviders}, providers=${Array.isArray(providers) ? providers.length : 0}, activeProvider=${requestedActiveProvider || ''}, closeAfterSave=${!!closeAfterSave}, sessionId=${requestedSessionId || ''}, currentModel=${requestedCurrentModel || ''}`);

    try {
      // 写 settings.json 是宿主能力（`docs/core-ui-separation.md` 第 4 节）：整段 mutation
      // （provider 表 + modelConfigs 补齐 + 顶层默认值 + MCP 默认启用列表）在宿主侧执行，
      // 两种装配同一条路径。写盘后 `SettingsStore` 重新构造快照并推给已就绪的 Connection，
      // Core 侧不需要任何「配置已保存」的通知。
      await this.host.updateSettingsJson((cfg: Record<string, any>) => {
        applyLlmConfigSave(cfg, message);
      });

      // 界面语言只有 UI 消费、不进快照：写盘后把收敛结果灌回宿主进程内的 i18n
      // （Electron 菜单、Spin 设计器页面用同一套 `tt()`）。
      if (language === 'zh' || language === 'en' || language === 'auto') {
        try {
          const { setHostUiLanguage } = await import('../i18n.js');
          setHostUiLanguage(language);
        } catch { /* 语言收敛失败不影响保存结果 */ }
      }

      // MCP 默认启用列表（设置面板「默认配置」）已随上面那次写盘落盘，
      // 快照重推后 core 会按新默认值重同步所有已注册会话的连接。
      // 这里只负责刷新界面：重新读取该会话的 MCP 配置 + 运行时状态回推，
      // 让 webview 把「连接中」收敛掉。
      if (Array.isArray(message.mcpServers)) {
        try {
          const mcpSessionId = await this.getActiveMcpSessionId(requestedSessionId);
          // 先回推一次：默认值已落盘、连接尚未开始 → webview 显示「连接中」。
          // 这样设置面板保存不会被 MCP 启动阻塞，可以立即返回 llmConfigSaved。
          await this.pushMcpServers(mcpSessionId);
          // 差量同步（连接 / 断开）由 core 在收到新快照后自己触发（M9 起
          // `hostEnvironmentProvided` 的默认列表变化 → core 重同步所有已注册会话），
          // 完成后 core 广播 `sessionConfigChanged(mcpEnabled)`，UI 据此刷新列表。
          // 宿主不再调用 core 的状态变更函数（第 2 节规则 9）。
        } catch (err: any) {
          this.log(`[WebviewMessageHandler] Failed to refresh MCP after default change: ${err.message}`);
        }
      }

      // 读取保存后的实际默认值，随 llmConfigSaved 回传给 webview，
      // webview 据此更新本地的默认值并应用到当前对话（如默认工作模式）。
      // 全部来自宿主自己的快照：Core 不提供默认值、不读配置文件。
      const snapshot = getSettingsStore().getSnapshot();
      const payload = readLlmConfigPanelPayload(snapshot);
      const savedModel = payload.defaultModel;
      const savedActiveProvider = payload.activeProvider;
      const savedThinkingEffort = payload.thinkingEffort;
      const savedAgentMode = payload.defaultAgentMode;
      const savedPromptMode = payload.defaultPromptMode;
      const savedWebSearch = payload.webSearch;
      const savedProviderGroups: Array<{ key: string; models: string[] }> =
        payload.providers.map((p: { key: string; models: string[] }) => ({ key: p.key, models: [...p.models] }));

      // 保存后校验当前会话的模型身份：provider 或模型失效时解析出可用身份，
      // 并把结果作为 `modelChanged` 报给 core（core 负责落 meta.json 与同步引擎配置，
      // 见 `initializeCoreEvents` 的 `modelChanged` 处理器）。返回给 webview 的
      // activeModel / activeModelProvider 用于刷新当前对话的模型选择（含已有消息的对话）。
      let activeModel = '';
      let activeModelProvider = '';
      try {
        const currentSessionId = (typeof requestedSessionId === 'string' && requestedSessionId) || this.trackedActiveSessionId;
        if (currentSessionId && currentSessionId !== 'undefined') {
          // 优先使用 webview 回传的当前模型身份（最贴近界面显示），
          // 其次读取该会话 meta.json 中保存的值（meta.json 是扁平字段）。
          let storedRef = modelRefOf(requestedCurrentProvider, requestedCurrentModel);
          if (!storedRef) {
            try {
              this.ensureSessionWorkspace(currentSessionId);
              const conversation = await loadConversationForHost(currentSessionId);
              storedRef = getConversationModelRef(conversation.metadata ?? undefined);
            } catch { /* 新对话可能还没有 meta.json */ }
          }
          const resolved = resolveModelRef(snapshot, storedRef);
          if (resolved) {
            activeModel = resolved.model;
            activeModelProvider = resolved.provider;
            if (!storedRef || !sameModelRef(storedRef, resolved)) {
              if (storedRef) {
                this.log(`[WebviewMessageHandler] Current session model (provider="${storedRef.provider}", model="${storedRef.model}") invalid, resolved to (provider="${resolved.provider}", model="${resolved.model}")`);
              }
              // core 侧落盘 + 同步引擎配置（Embedded 与 Standalone 同一条通路）
              await this.emitUiEvent({ type: 'modelChanged', sessionId: currentSessionId, ref: resolved });
            }
          }
        }
      } catch (err: any) {
        this.log(`[WebviewMessageHandler] Failed to resolve active model after save: ${err.message}`);
      }

      // 保存后立即刷新主界面的模型下拉列表：回传全部 provider 的分组列表。
      // 当前会话选中的模型/默认模型若不在对应 provider 列表里，则补进去。
      const groups = savedProviderGroups.map((g) => ({ key: g.key, models: [...g.models] }));
      const ensureModel = (providerKey: string, model: string) => {
        if (!providerKey || !model) return;
        const group = groups.find((g) => g.key === providerKey);
        if (group && !group.models.includes(model)) group.models.unshift(model);
      };
      ensureModel(savedActiveProvider, savedModel);
      ensureModel(activeModelProvider, activeModel);
      this.host.sendToWebview({ type: 'setModels', providers: groups, activeProvider: savedActiveProvider });

      // 通知 webview 保存成功
      this.host.sendToWebview({
        type: 'llmConfigSaved',
        defaultModel: savedModel,
        defaultModelProvider: savedActiveProvider,
        activeModel,
        activeModelProvider,
        thinkingEffort: savedThinkingEffort,
        defaultAgentMode: savedAgentMode,
        defaultPromptMode: savedPromptMode,
        webSearch: savedWebSearch,
        ...(language === 'zh' || language === 'en' || language === 'auto' ? { language } : {}),
        activeProvider: savedActiveProvider,
        closeAfterSave: !!closeAfterSave,
      });
    } catch (err) {
      this.log(`[WebviewMessageHandler] Failed to save LLM config: ${err}`);
      this.host.sendToWebview({
        type: 'llmConfigSaveError',
        error: `保存失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 处理来自 webview 的默认值读取请求（webview 挂载时触发）
   * 返回 settings.json 中的默认 model、thinking_effort 和 agentMode，
   * 使 webview 在新对话创建时能一次性使用正确默认值，避免先显示 manual 再跳变
   */
  private async handleRequestSettingsDefaults(): Promise<void> {
    try {
      // 全部来自宿主自己的快照：Core 不提供默认值，也不参与设置面板的展示。
      // 先重读一次磁盘，避免启动期读到残缺文件后一直停留在旧快照（见 SettingsStore.refreshFromDisk）。
      const snapshot = getSettingsStore().refreshFromDisk();
      const defaultModelRef = readActiveModelRef(snapshot);
      const thinkingMode = readDefaultThinkingEffort(snapshot);
      const agentMode = readDefaultAgentMode(snapshot);
      const promptMode = readDefaultPromptMode(snapshot);
      const webSearch = readDefaultWebSearch(snapshot);
      const payload = readLlmConfigPanelPayload(snapshot);
      const providerConfigured = !!payload.activeProvider && !!payload.apiKey;
      this.host.sendToWebview({
        type: 'settingsDefaults',
        // wire 协议保持扁平：模型身份拆成 model / provider 两个字段
        model: defaultModelRef?.model ?? '',
        provider: defaultModelRef?.provider,
        thinkingMode,
        agentMode,
        promptMode,
        webSearch,
        language: this.getUiLanguageFromSettings(),
        providerConfigured,
      });
      this.log(`[WebviewMessageHandler] Sent settings defaults: model=${defaultModelRef?.model ?? ''}, provider=${defaultModelRef?.provider ?? ''}, thinkingMode=${thinkingMode}, agentMode=${agentMode}, promptMode=${promptMode}, webSearch=${webSearch}, providerConfigured=${providerConfigured}`);
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to send settings defaults: ${err.message}`);
      // 读取失败也要回一条：否则 webview 的 configReady 永远为 false，发送按钮会一直禁用。
      // 不带任何默认值，providerConfigured=false 会让输入框引导用户去设置页配置。
      this.host.sendToWebview({
        type: 'settingsDefaults',
        model: '',
        thinkingMode: undefined,
        agentMode: undefined,
        promptMode: undefined,
        webSearch: false,
        language: this.getUiLanguageFromSettings(),
        providerConfigured: false,
      });
    }
  }

  /** 从 settings.json 读取 UI 语言（同步，供消息回传使用） */
  private getUiLanguageFromSettings(): 'auto' | 'zh' | 'en' {
    try {
      return readUiLanguage();
    } catch {
      return 'auto';
    }
  }

  /**
   * 处理来自 webview 的对话空间统计请求
   */
  private async handleRequestConversationSpaces(): Promise<void> {
    this.log(`[WebviewMessageHandler] requestConversationSpaces`);
    try {
      // 统计对象在 core 的数据目录内：Embedded 直读，Standalone 经 UiRequest 索取
      const spaces = await requestConversationSpaces();
      this.host.sendToWebview({ type: 'conversationSpacesData', spaces });
    } catch (err: any) {
      this.log(`[WebviewMessageHandler] Failed to get conversation spaces: ${err.message}`);
      this.host.sendToWebview({
        type: 'conversationSpacesError',
        error: `统计对话空间失败: ${err.message}`,
      });
    }
  }

  /**
   * 处理来自 webview 的对话空间清空请求
   */
  /**
   * 处理来自 webview 的 LLM 配置读取请求（用户点击设置按钮时触发）。
   * core 只提供配置事实，消息组装与投递在 WebViewUI。
   */
  private async handleRequestLLMConfig(message: any): Promise<void> {
    // 定向会话：多视图宿主据此把设置面板只弹到发起端（同一会话的其它视图不同步弹）
    const sessionId: string | undefined = message?.sessionId;
    await this.uiPort?.showLLMConfigPanel('request', sessionId ?? null);
  }

}

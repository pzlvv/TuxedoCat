/**
 * VSCodeUI/webviewMessageHandler.ts - WebView 消息处理
 * 接收和处理来自 webview 的所有消息
 */
import type { UIHost } from '../host/UIHost.js';
import { fetch as undiciFetch } from 'undici';
import { logger } from '../core/Logger.js';
import { getProbeDispatcher } from '../core/llm/httpDispatcher.js';
import { getPendingToolUseIds } from '../core/tools/index.js';
import { providerKeyFromBaseURL } from '../core/utils/providerKey.js';
import { buildEditDiffHunks } from '../core/utils/editDiff.js';
import { buildUserContent, extractUserContent } from '../core/utils/contentBlocks.js';
import { MODEL_CONFIGS, normalizeModelTokenLimits, type ModelTokenLimits } from '../core/utils/modelConfig.js';
import { DEFAULT_WAKE_SHORTCUT, normalizeAccelerator } from '../core/utils/shortcut.js';
import { userChoiceQueue } from '../core/UserChoiceQueue.js';
import { noteSessionActivity, clearSessionIdleState } from '../core/sessionIdle.js';
import { isCompacting } from '../core/compact/state.js';
import type { WebviewMessage } from '../core/webviewTypes.js';
import type { Message } from '../core/types.js';
import type { UserChoiceManager } from './userChoice.js';

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
 * 单次协议探测的判定结果：
 * - supported   该协议可用
 * - unsupported 明确不支持 / 该协议适配器不可用
 * - unknown     无法判断（限流重试后仍失败、地区限制、网络异常）→ 不猜测
 */
type ProbeVerdict = 'supported' | 'unsupported' | 'unknown';

/**
 * WebviewMessageHandler - 处理 webview 发来的各类消息
 *
 * extractLastJsonObject - 从字符串中提取最后一个完整的 JSON 对象。
 * 从字符串末尾反向查找，避免被思考过程中的花括号干扰，只取最终输出。
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
function extractLastJsonObject(text: string): string | null {
  let lastBrace = -1;
  let inString = false;
  let escape = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) {
      if (i > 0 && text[i - 1] === '\\') { i--; continue; }
      continue;
    }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString && ch === '{') { lastBrace = i; break; }
  }
  if (lastBrace < 0) return null;
  let depth = 0;
  inString = false;
  escape = false;
  for (let i = lastBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = text.substring(lastBrace, i + 1);
          try { const parsed = JSON.parse(jsonStr); if (parsed && typeof parsed.title === 'string') return jsonStr; } catch { }
          break;
        }
      }
    }
  }
  const remainingText = text.substring(0, lastBrace);
  if (remainingText.length > 0) return extractLastJsonObject(remainingText);
  return null;
}

export class WebviewMessageHandler {
  private host: UIHost;
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private postConversationLoaded: (sessionId: string, conversation: any, extra: {
    pendingToolUseIds: string[];
    savedContext?: any;
    parentSessionId?: string;
    agentMode: string;
    hasActiveQuery: boolean;
    hasCompactArchive?: boolean;
    model?: string;
  }) => void;
  private setTitle: (sessionID: string, title: string) => void;
  private sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'>;
  private userChoiceManager: UserChoiceManager;
  /** 用户响应 user choice 后的回调（宿主侧用于刷新侧栏流水灯状态） */
  private onUserChoiceResponded?: (sessionId: string) => void;

  constructor(deps: {
    host: UIHost;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    postConversationLoaded: (sessionId: string, conversation: any, extra: {
      pendingToolUseIds: string[];
      savedContext?: any;
      parentSessionId?: string;
      agentMode: string;
      hasActiveQuery: boolean;
      hasCompactArchive?: boolean;
      model?: string;
    }) => void;
    setTitle: (sessionID: string, title: string) => void;
    sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'>;
    userChoiceManager: UserChoiceManager;
    onUserChoiceResponded?: (sessionId: string) => void;
  }) {
    this.host = deps.host;
    this.postToWebview = deps.postToWebview;
    this.postConversationLoaded = deps.postConversationLoaded;
    this.setTitle = deps.setTitle;
    this.sessionAgentModes = deps.sessionAgentModes;
    this.userChoiceManager = deps.userChoiceManager;
    this.onUserChoiceResponded = deps.onUserChoiceResponded;
  }

  private log(...args: unknown[]): void {
    this.host.log(...args);
  }

  /**
   * 处理来自 webview 的消息
   */
  async handleWebviewMessage(message: any): Promise<void> {
    try {
      await this.dispatchWebviewMessage(message);
    } catch (err) {
      // 单条消息处理失败不应变成未处理的 rejection：
      // VS Code 会打印 "rejected promise not handled within 1 second"，
      // 且整条消息链路静默失败、难以定位。
      const detail = err instanceof Error ? (err.stack || err.message) : String(err);
      this.log(`[VSCodeUI] handleWebviewMessage failed for type=${message?.type}: ${detail}`);
    }
  }

  /**
   * 按消息类型分发到具体处理器，由 handleWebviewMessage() 统一兜底异常。
   */
  private async dispatchWebviewMessage(message: any): Promise<void> {
    logger.info("handleWebviewMessage", `Received from webview: ${message.type}`);

    if (message.type === 'requestCompress') {
      await this.handleRequestCompress(message);
    } else if (message.type === 'queueMessage') {
      await this.handleQueueMessage(message);
    } else if (message.type === 'sendMessage') {
      await this.handleSendMessage(message);
    } else if (message.type === 'openFile') {
      await this.handleOpenFile(message);
    } else if (message.type === 'requestToolMeta') {
      await this.handleRequestToolMeta(message);
    } else if (message.type === 'showVirtualDocument') {
      await this.handleShowVirtualDocument(message);
    } else if (message.type === 'showDiffInVirtualDocument') {
      await this.handleShowDiffInVirtualDocument(message);
    } else if (message.type === 'abort') {
      await this.handleAbort(message);
    } else if (message.type === 'getConversations') {
      await this.handleGetConversations();
    } else if (message.type === 'setActiveSessionId') {
      await this.handleSetActiveSessionId(message);
    } else if (message.type === 'loadConversation') {
      await this.handleLoadConversation(message);
    } else if (message.type === 'updateConversationContext') {
      await this.handleUpdateConversationContext(message);
    } else if (message.type === 'requestTimeStats') {
      await this.handleRequestTimeStats(message);
    } else if (message.type === 'saveConversationStats') {
      await this.handleSaveConversationStats(message);
    } else if (message.type === 'startNewConversation') {
      await this.handleStartNewConversation(message);
    } else if (message.type === 'deleteConversation') {
      await this.handleDeleteConversation(message);
    } else if (message.type === 'clearConversation') {
      await this.handleClearConversation(message);
    } else if (message.type === 'respondUserChoice') {
      await this.handleRespondUserChoice(message);
    } else if (message.type === 'setAgentMode') {
      await this.handleSetAgentMode(message);
    } else if (message.type === 'setPromptMode') {
      await this.handleSetPromptMode(message);
    } else if (message.type === 'setThinkingMode') {
      await this.handleSetThinkingMode(message);
    } else if (message.type === 'setWebSearch') {
      await this.handleSetWebSearch(message);
    } else if (message.type === 'setModel') {
      await this.handleSetModel(message);
    } else if (message.type === 'createEngine') {
      await this.handleCreateEngine(message);
    } else if (message.type === 'requestSkills') {
      await this.handleRequestSkills();
    } else if (message.type === 'openMermaidPreview') {
      await this.handleOpenMermaidPreview(message);
    } else if (message.type === 'openSpinDesign') {
      await this.handleOpenSpinDesign();
    } else if (message.type === 'renameConversation') {
      await this.handleRenameConversation(message);
    } else if (message.type === 'requestSmartNaming') {
      await this.handleRequestSmartNaming(message);
    } else if (message.type === 'rollbackEdit') {
      await this.handleRollbackEdit(message);
    } else if (message.type === 'expandCompact') {
      await this.handleExpandCompact(message);
    } else if (message.type === 'checkServerLoad') {
      await this.handleCheckServerLoad(message);
    } else if (message.type === 'requestModels') {
      await this.handleRequestModels(message);
    } else if (message.type === 'fetchProviderModels') {
      await this.handleFetchProviderModels(message);
    } else if (message.type === 'detectProviderModelApiTypes') {
      await this.handleDetectProviderModelApiTypes(message);
    } else if (message.type === 'saveLLMConfig') {
      await this.handleSaveLLMConfig(message);
    } else if (message.type === 'requestLLMConfig') {
      await this.handleRequestLLMConfig(message);
    } else if (message.type === 'requestSettingsDefaults') {
      await this.handleRequestSettingsDefaults();
    } else if (message.type === 'debugLog') {
      // 来自 webview 的诊断日志
      this.log(`[Webview Debug] ${message.message}`);
    } else if (message.type === 'openUrl') {
      await this.handleOpenUrl(message);
    } else if (message.type === 'openWorkspaceFolder') {
      await this.handleOpenWorkspaceFolder();
    } else if (message.type === 'requestConversationSpaces') {
      await this.handleRequestConversationSpaces();
    } else if (message.type === 'clearConversationSpace') {
      await this.handleClearConversationSpace(message);
    } else if (message.type === 'requestMcpServers') {
      await this.handleRequestMcpServers(message);
    } else if (message.type === 'setMcpEnabled') {
      await this.handleSetMcpEnabled(message);
    } else if (message.type === 'recordHighlightLanguage') {
      // webview 按需加载了某个 Shiki 语言：记录到 settings.json，供下次启动预热
      await this.handleRecordHighlightLanguage(message);
    }
  }

  /**
   * 记录 webview 已按需加载的 Shiki 语言。
   * 只在语言首次被加载时由 webview 上报，宿主侧再做一次去重后落盘。
   */
  private async handleRecordHighlightLanguage(message: { language?: string }): Promise<void> {
    if (!message.language) return;
    try {
      const { recordHighlightLanguage } = await import('../core/history/Config.js');
      await recordHighlightLanguage(message.language);
    } catch (err) {
      logger.error('handleRecordHighlightLanguage', `记录高亮语言失败: ${err}`);
    }
  }

  /**
   * 当前活跃会话 ID（MCP 启用列表是按会话解析的）。
   * 优先使用调用方显式传入的 sessionId（多 webview 宿主下全局 activeSessionId 可能不准）。
   * 未打开工作区 / 尚未进入任何会话时返回 undefined，此时只用全局默认。
   */
  private async getActiveMcpSessionId(preferred?: string): Promise<string | undefined> {
    if (preferred && preferred !== 'undefined') return preferred;
    try {
      const { getActiveSessionId } = await import('../core/history/Config.js');
      const sessionId = getActiveSessionId();
      return sessionId && sessionId !== 'undefined' ? sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 读取 mcp.json + 当前会话的启用状态，并合并运行时状态后推送给 webview。
   */
  private async handleRequestMcpServers(message?: any): Promise<void> {
    const sessionId = await this.getActiveMcpSessionId(message?.sessionId);
    this.log(`[VSCodeUI] MCP servers requested (session=${sessionId ?? '-'})`);
    await this.pushMcpServers(sessionId);
    // VS Code 只有一个 webview，这里按「当前活动会话」建立引用是准确的。
    // Electron 有多个 webview，引用由 ChatViewManager 在打开/关闭视图时精确维护；
    // 这里若按全局 activeSessionId acquire，可能引用到已关闭的会话导致泄漏，故跳过。
    if (this.host.kind === 'electron') return;
    // 打开面板即建立该会话的 MCP 引用（幂等）。acquire 可能耗时（首次拉取包、握手），
    // 因此后台执行，完成后回推一次运行时状态；期间 webview 显示「连接中」。
    void (async () => {
      try {
        const { getMcpManager } = await import('../core/mcp/Manager.js');
        await getMcpManager().acquire(sessionId);
        await this.pushMcpServers(sessionId);
      } catch (err: any) {
        this.log(`[VSCodeUI] MCP background acquire failed: ${err.message}`);
      }
    })();
  }

  /**
   * 切换某个 MCP 的启用状态。
   *
   * 只写入**当前会话**的 meta.json（context.mcpEnabled），不触碰全局默认。
   * 保存后立即回推一次（此时 running 仍为旧值 → webview 显示「连接中」），
   * 真正的连接/断开放到后台异步执行，完成后再次回推运行时状态。
   */
  private async handleSetMcpEnabled(message: any): Promise<void> {
    const name = typeof message.name === 'string' ? message.name : '';
    const enabled = !!message.enabled;
    if (!name) return;
    const sessionId = await this.getActiveMcpSessionId(message.sessionId);
    this.log(`[VSCodeUI] Session MCP enabled set: ${name} = ${enabled} (session=${sessionId ?? '-'})`);
    try {
      const { setSessionMcpEnabled } = await import('../core/mcp/Config.js');
      await setSessionMcpEnabled(sessionId, name, enabled);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to set session MCP enabled: ${err.message}`);
      return;
    }
    // 先回推：让菜单立刻反映新的勾选状态（连接尚未开始 → 显示「连接中」）
    await this.pushMcpServers(sessionId);
    // 连接/断开异步进行，完成后再次回推运行时状态（工具数 / 错误 / 连接中→已连接）
    void (async () => {
      try {
        const { getMcpManager } = await import('../core/mcp/Manager.js');
        await getMcpManager().syncSession(sessionId);
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to sync session MCP: ${err.message}`);
      }
      await this.pushMcpServers(sessionId);
    })();
  }

  /**
   * 组装并推送 MCP 列表：配置（mcp.json）+ 该会话的启用状态 + 运行时状态。
   * 带上 sessionId，webview 据此区分会话，避免异步回推串到其它会话。
   */
  private async pushMcpServers(sessionId?: string): Promise<void> {
    try {
      const { readMcpServers } = await import('../core/mcp/Config.js');
      const { getMcpManager } = await import('../core/mcp/Manager.js');
      const servers = await readMcpServers(sessionId);
      const status = getMcpManager().getServerStatus();
      this.host.sendToWebview({
        type: 'setMcpServers',
        sessionId,
        servers: servers.map((server) => {
          const runtime = status.get(server.name);
          return {
            ...server,
            running: runtime?.running ?? false,
            toolCount: runtime?.toolCount ?? 0,
            error: runtime?.error ?? null,
            refCount: runtime?.refCount ?? 0,
          };
        }),
      });
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to read MCP servers: ${err.message}`);
    }
  }

  /**
   * 打开外部链接（使用系统默认浏览器）
   * webview 中点击 markdown 链接时调用
   */
  private async handleOpenUrl(message: any): Promise<void> {
    const url = typeof message.url === 'string' ? message.url : '';
    if (!url) return;
    this.log(`[VSCodeUI] Open URL externally: ${url}`);
    try {
      await this.host.openExternalUrl(url);
    } catch (err) {
      this.log(`[VSCodeUI] Failed to open URL: ${err}`);
    }
  }

  /**
   * 未打开工作目录时，webview 引导用户选择并打开一个文件夹。
   * 宿主能力由 UIHost.openWorkspaceFolder 提供（Electron 未实现时静默忽略）。
   */
  private async handleOpenWorkspaceFolder(): Promise<void> {
    this.log(`[VSCodeUI] Open workspace folder requested from webview`);
    if (!this.host.openWorkspaceFolder) {
      this.log(`[VSCodeUI] openWorkspaceFolder is not supported by current host`);
      return;
    }
    try {
      await this.host.openWorkspaceFolder();
    } catch (err) {
      this.log(`[VSCodeUI] Failed to open workspace folder: ${err}`);
    }
  }

  private async handleRequestCompress(message: any): Promise<void> {
    this.log(`[VSCodeUI] Request compress from webview`);
    const { requestCompact } = await import('../core/Integration.js');
    requestCompact(message.sessionId);
  }

  private async handleQueueMessage(message: any): Promise<void> {
    // 统一消息入口：sendMessage 与 queueMessage 都汇聚到这里。
    // - engine 不存在时走 Integration.sendMessage 完整路径（创建引擎、命令分发、Skill 注入等）。
    // - engine 已存在且为普通消息时直接入队到 QueryEngine，使消息在"下一次 LLM 请求"时立刻
    //   被带上，即使当前 query 正处于多轮工具调用循环中也不会中断。
    // - 命令类消息仍交给 sendMessage 处理，保留内置命令 / Skill 命令的原有行为。
    const { sessionId, content } = message;
    const images: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }> | undefined = Array.isArray((message as any).images)
      ? (message as any).images
      : undefined;
    if (!sessionId || typeof content !== 'string' || (!content.trim() && (!images || images.length === 0))) {
      return;
    }
    logger.info('VSCodeUI', `User message received for session ${sessionId} (unified queue path)`);

    try {
      const { getSessionEngine } = await import('../core/QueryEngine.js');
      const engine = getSessionEngine(sessionId);

      if (message.agentMode) {
        this.sessionAgentModes.set(sessionId, message.agentMode);
      }

      // engine 不存在：走正常 sendMessage 路径（会创建 engine、处理命令等）
      if (!engine) {
        logger.warn('VSCodeUI', `No engine for message session ${sessionId}, falling back to sendMessage`);
        const { sendMessage } = await import('../core/Integration.js');
        const { isPromptPresetId } = await import('../core/prompt/PromptPreset.js');
        for await (const _ of sendMessage(content, sessionId, {
          filePath: message.filePath,
          selectedLines: message.selectedLines || message.fileSelectedLines,
          fileHidden: !!message.fileHidden,
          thinkingMode: message.thinkingMode,
          webSearch: message.webSearch,
          promptPreset: isPromptPresetId(message.promptMode) ? message.promptMode : undefined,
          images,
        })) {
          void _;
        }
        return;
      }

      // 命令类消息继续交给 sendMessage，由 CommandDispatcher 处理内置命令 / Skill 注入
      if (content.trim().startsWith('/')) {
        const { sendMessage } = await import('../core/Integration.js');
        const { isPromptPresetId } = await import('../core/prompt/PromptPreset.js');
        for await (const _ of sendMessage(content, sessionId, {
          filePath: message.filePath,
          selectedLines: message.selectedLines || message.fileSelectedLines,
          fileHidden: !!message.fileHidden,
          thinkingMode: message.thinkingMode || engine.thinkingModeOverride,
          webSearch: message.webSearch,
          promptPreset: isPromptPresetId(message.promptMode) ? message.promptMode : undefined,
          images,
        })) {
          void _;
        }
        return;
      }

      // 普通消息：入队到 QueryEngine
      // 这里根据 webview 传入的当前 thinking 模式显式设置，
      // 未传入时回退到引擎当前的 thinking effort（当前对话正在使用的值）。
      const thinkingEffort = message.thinkingMode || engine.thinkingModeOverride;
      engine.thinkingModeOverride = thinkingEffort;

      // 应用会话关联的 Web Search 开关（与 sendMessage 路径一致）
      if (typeof message.webSearch === 'boolean') {
        engine.updateWebSearch(message.webSearch);
      }

      // 应用会话关联的提示词预设（仅内存；与 sendMessage 路径一致）
      const { isPromptPresetId } = await import('../core/prompt/PromptPreset.js');
      if (isPromptPresetId(message.promptMode)) {
        engine.setPromptPreset(message.promptMode);
      }

      // 等待之前的持久化完成，确保新消息在消息链中按顺序持久化
      await engine.flush().catch((e: any) => {
        logger.error('VSCodeUI', `Queued message flush failed: ${e}`);
      });

      const selectedLines = message.selectedLines || message.fileSelectedLines;
      // 区分“排队消息”与“空闲会话的普通发送”：
      // - queueMessage / 引擎仍在消费：先只显示在输入框上方的 queue 中，
      //   等下一次 LLM 请求真正消费该消息时再由 QueryEngine 补发到 MessagesView。
      // - sendMessage 且引擎空闲：保持原有行为，立即回显到 MessagesView。
      const isQueueMessage = message.type === 'queueMessage' || engine.isConsumerRunning || isCompacting(sessionId);

      // 构造用户消息对象（暂存，不立即 push 到 mutableMessages）。
      // 由 flushQueuedMessagesIntoContext 在处理 pendingUserMessage 时用该对象现场追加，
      // 确保消息在"下一次 LLM 请求"时立刻进入上下文，
      // 同时保留 filePath / fileSelectedLines 等元数据。
      const { getGlobalUI } = await import('../core/AssistantUI.js');
      const ui = getGlobalUI();
      const userContent = buildUserContent(content, images);
      const { text: uiText, images: uiImages } = extractUserContent(userContent);
      // 与 Integration.sendMessage 的落盘格式保持一致：文件信息同时写入 _meta，
      // 避免“引擎已存在时的后续消息”只带顶层字段，导致历史加载/压缩展开时无法还原文件标签。
      const persistMeta: Record<string, unknown> = {};
      if (message.filePath) {
        persistMeta.filePath = message.filePath;
        persistMeta.param = `${message.filePath.split(/[/\\]/).pop()}${selectedLines ? `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}` : ''}`;
      }
      if (selectedLines) {
        persistMeta.fileSelectedLines = selectedLines;
      }

      const userMsg: Message = {
        type: 'user',
        message: { role: 'user', content: userContent },
        uuid: `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
        timestamp: Date.now(),
        ...(message.filePath && { filePath: message.filePath }),
        ...(selectedLines && { fileSelectedLines: selectedLines }),
        ...(message.fileHidden && { fileHidden: true }),
      };
      if (Object.keys(persistMeta).length > 0) {
        (userMsg as any)._meta = persistMeta;
      }

      // 标记为"用户主动发送"的消息（含排队消息）：只有这类消息才更新
      // meta.json 的 updatedAt，使对话列表按最后一条用户消息排序。
      (userMsg as any)._userInitiated = true;

      // 将图片宽高随消息一起持久化，供 meta.json 标题生成使用（不进入 LLM content）
      const imageSizes = (images ?? []).map((img) => ({
        width: img.width,
        height: img.height,
      }));
      if (imageSizes.some((s) => s.width && s.height)) {
        (userMsg as any).imageSizes = imageSizes;
      }

      if (isQueueMessage) {
        // 排队消息不立即回显到 MessagesView，只在输入框上方显示队列状态。
        // QueryEngine 真正把它追加进 LLM 上下文时，会通过 _needsUINotification 补发 addMessage。
        (userMsg as any)._needsUINotification = true;
        ui?.onQueuedMessage?.(sessionId, content, uiImages, {
          filePath: message.filePath,
          selectedLines: selectedLines || undefined,
          fileHidden: !!message.fileHidden,
        });
      } else {
        // 显示用户消息到 UI（文件信息逻辑与 sendMessage 一致）
        const uiMeta: Record<string, unknown> = {};
        if (message.filePath && !message.fileHidden) {
          uiMeta.filePath = message.filePath;
          uiMeta.param = `${message.filePath.split(/[/\\]/).pop()}${selectedLines ? `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}` : ''}`;
        }
        ui?.onMessage(sessionId, {
          role: 'user',
          content: uiText,
          images: uiImages.length > 0 ? uiImages : undefined,
          filePath: message.fileHidden ? undefined : message.filePath,
          fileSelectedLines: message.fileHidden ? undefined : selectedLines,
          meta: Object.keys(uiMeta).length > 0 ? uiMeta : undefined,
        });
      }

      // 提交到引擎队列：设置 pendingUserMessage，使消息在下次 LLM 请求时被带上。
      // 若 consumer 正在运行，submitMessage 会等待其退出（消息已被现有 consumer
      // 在 while 循环中消费）；若已退出，则启动新的 consumer 处理该消息。
      // manageQueryUI=true：排队消息绕过 Integration.sendMessage，若该调用启动了
      // 自己的 consumer，需要自行管理 onQueryBegin/onQueryEnd（与 enqueueAgentMessage 一致）。
      void (async () => {
        try {
          for await (const _ of engine.submitMessage(content, 'user', undefined, {
            manageQueryUI: true,
            // 排队路径：消息未 push 到 mutableMessages，consumer 处理时用此对象现场追加
            userMsgData: userMsg,
          })) {
            // 排队消息的回复由现有/新 consumer 通过正常路径推送，无需在此转发
            void _;
          }
        } catch (e) {
          logger.error('VSCodeUI', `Error processing queued message: ${e}`);
        }
      })();
    } catch (err) {
      this.log(`[VSCodeUI] Failed to enqueue queued message: ${err}`);
      // 入队失败时通知 webview 显示排队状态，由 webview 在 queryEnd 后重新投递
      this.host.sendToWebview({
        type: 'queuedMessage',
        sessionId,
        content,
        images,
      } as WebviewMessage);
    }
  }

  private async handleSendMessage(message: any): Promise<void> {
    // 与 queueMessage 共用同一套入队/处理逻辑，避免两套行为分叉
    await this.handleQueueMessage(message);
  }

  private async handleOpenFile(message: any): Promise<void> {
    const { filePath, selectedLines, sessionId, clientId } = message;
    this.log(`[VSCodeUI] openFile: ${filePath} ${JSON.stringify(selectedLines)}`);

    if (filePath) {
      try {
        // 浏览器端（带 clientId）：由服务端读取内容回推给发起端，在页面内预览，
        // 不打开宿主原生窗口（查看类操作不跨端）
        if (clientId && this.host.previewFile) {
          await this.host.previewFile(filePath, selectedLines, sessionId, clientId);
          return;
        }
        await this.host.openFile(filePath, selectedLines);
      } catch (err) {
        this.log(`[VSCodeUI] Error opening file: ${err}`);
      }
    }
  }

  private async handleRequestToolMeta(message: any): Promise<void> {
    const { sessionId: targetSessionId, toolUseIds } = message;
    this.log(`[VSCodeUI] requestToolMeta: ${targetSessionId}, ids: ${JSON.stringify(toolUseIds)}`);

    (async () => {
      try {
        const { loadConversation } = await import('../core/history/index.js');
        const conversation = await loadConversation(targetSessionId);
        const result: Record<string, any> = {};

        for (const msg of conversation.messages) {
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              const b = block as { type: string; id?: string; name?: string; input?: any;[key: string]: unknown };
              if (b.type === 'tool_use' && toolUseIds.includes(b.id) && b._meta) {
                const meta = b._meta as Record<string, unknown>;
                if (b.name === 'Edit' && typeof meta.beforeContent === 'string' && typeof meta.afterContent === 'string') {
                  // 按需加载也返回紧凑 diff，避免把完整文件内容发给 webview
                  result[b.id!] = {
                    diffHunks: buildEditDiffHunks({
                      beforeContent: meta.beforeContent,
                      afterContent: meta.afterContent,
                      startLine: meta.startLine as number | undefined,
                      endLine: meta.endLine as number | undefined,
                      replaceAll: Boolean(b.input?.replace_all),
                    }),
                  };
                } else {
                  result[b.id!] = meta;
                }
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
        this.log(`[VSCodeUI] Error loading tool meta: ${err}`);
      }
    })();
  }

  private async handleShowVirtualDocument(message: any): Promise<void> {
    const { content, title, language, sessionId, clientId } = message;
    this.log(`[VSCodeUI] showVirtualDocument: ${title}`);
    // 浏览器端：内容本来就在 webview 里，回推给发起端在页面内预览即可，不打开桌面窗口
    if (clientId) {
      this.host.sendToWebview({ type: 'openPreview', mode: 'text', title, content, language, sessionId, clientId } as any);
      return;
    }
    await this.host.showVirtualDocument(content, title);
  }

  private async handleShowDiffInVirtualDocument(message: any): Promise<void> {
    const { filePath, newContent, title, beforeContent, afterContent, sessionId, clientId } = message;
    // 浏览器端：回推给发起端在页面内预览 diff
    if (clientId) {
      this.host.sendToWebview({
        type: 'openPreview',
        mode: 'diff',
        filePath,
        title,
        beforeContent,
        afterContent,
        newContent,
        sessionId,
        clientId,
      } as any);
      return;
    }
    await this.host.showDiff({
      filePath,
      newContent,
      title,
      beforeContent,
      afterContent,
    });
  }

  private async handleAbort(message: any): Promise<void> {
    this.log(`[VSCodeUI] Abort requested from webview, sessionId: ${message.sessionId}`);
    const { abortCurrentQuery } = await import('../core/Integration.js');
    abortCurrentQuery(message.sessionId);
    // 后台任务/子代理可能已同步中止，立即刷新 abort 按钮状态
    this.host.refreshAbortState?.();
  }

  private async handleGetConversations(): Promise<void> {
    this.log(`[VSCodeUI] getConversations requested`);
    const { loadConversationList } = await import('../core/history/index.js');
    const conversations = await loadConversationList();

    this.host.sendToWebview({
      type: 'conversationsData',
      conversations,
    });
  }

  private async handleSetActiveSessionId(message: any): Promise<void> {
    const { setActiveSessionId } = await import('../core/history/Config.js');
    setActiveSessionId(message.sessionId);
    // 切换/激活对话：刷新该会话的空闲关闭计时
    noteSessionActivity(message.sessionId);
    logger.info("handleWebviewMessage", `Set active session from webview: ${message.sessionId}`);
    // 切换会话时查询余额
    this.fetchBalanceAndSend(message.sessionId);

    // MCP 引用绑定「会话被打开过」：切换会话只 acquire 新会话，不释放旧会话
    // （VSCode 没有关闭对话的概念，释放只发生在删除对话 / 扩展停用时）。
    void (async () => {
      try {
        const { getMcpManager } = await import('../core/mcp/Manager.js');
        // 先回推该会话的 MCP 配置：连接尚未开始 → webview 显示「连接中」并禁用发送
        await this.pushMcpServers(message.sessionId);
        await getMcpManager().acquire(message.sessionId);
        await this.pushMcpServers(message.sessionId);
      } catch (err: any) {
        this.log(`[VSCodeUI] MCP acquire on session switch failed: ${err.message}`);
      }
    })();
  }

  private async handleLoadConversation(message: any): Promise<void> {
    this.log(`[VSCodeUI] loadConversation requested: ${message.sessionId}`);
    // 打开对话：刷新该会话的空闲关闭计时
    noteSessionActivity(message.sessionId);

    const { getActiveSessionId: getCurSessionId } = await import('../core/history/Config.js');
    const { getSessionEngine } = await import('../core/QueryEngine.js');
    const oldSessionId = getCurSessionId();
    if (oldSessionId && oldSessionId !== message.sessionId) {
      const oldEngine = getSessionEngine(oldSessionId);
      if (oldEngine) {
        this.log(`[VSCodeUI] Flushing pending persists for old session ${oldSessionId}`);
        await oldEngine.flush();
      }
    }

    const { loadConversation } = await import('../core/history/index.js');
    const { setActiveSessionId } = await import('../core/history/Config.js');
    const { restoreConversationEngine } = await import('../core/Integration.js');
    const conversation = await loadConversation(message.sessionId);

    setActiveSessionId(message.sessionId);
    this.log(`[VSCodeUI] Set active session: ${message.sessionId}`);
    // 加载对话时查询余额
    this.fetchBalanceAndSend(message.sessionId);

    // MCP：加载对话即建立该会话的引用（幂等，不释放旧会话）
    void (async () => {
      try {
        const { getMcpManager } = await import('../core/mcp/Manager.js');
        // 先回推该会话的 MCP 配置：连接尚未开始 → webview 显示「连接中」并禁用发送
        await this.pushMcpServers(message.sessionId);
        await getMcpManager().acquire(message.sessionId);
        await this.pushMcpServers(message.sessionId);
      } catch (err: any) {
        this.log(`[VSCodeUI] MCP acquire on loadConversation failed: ${err.message}`);
      }
    })();

    const hasHistory = conversation.messages && conversation.messages.length > 0;
    this.log(`[VSCodeUI] Conversation has history: ${hasHistory}`);

    if (conversation.metadata?.title) {
      this.setTitle(message.sessionId, conversation.metadata.title);
    }

    const pendingToolUseIds = Array.from(getPendingToolUseIds());
    logger.info('handleWebviewMessage', `pendingToolUseIds: ${JSON.stringify(pendingToolUseIds)}`);

    const savedContext = conversation.metadata?.context;
    this.log(`[VSCodeUI] Conversation context: ${JSON.stringify(savedContext)}`);

    // 如果没有 per-session 的 thinkingMode/model/webSearch，从 settings.json 读取默认值
    let effectiveSavedContext = savedContext;
    let effectiveModel = conversation.metadata?.model || conversation.metadata?.context?.model;
    try {
      if (!savedContext?.thinkingMode || !effectiveModel || typeof savedContext?.webSearch !== 'boolean' || !savedContext?.promptMode) {
        const { getDefaultThinkingEffort, getDefaultModel, getDefaultWebSearch } = await import('../core/llm/config.js');
        const defaultThinkingEffort = await getDefaultThinkingEffort();
        const defaultModel = await getDefaultModel();
        const defaultWebSearch = await getDefaultWebSearch();
        if (!effectiveModel) {
          effectiveModel = defaultModel;
        }
        let nextCtx = effectiveSavedContext;
        if (!nextCtx?.thinkingMode) {
          nextCtx = { ...(nextCtx || {}), thinkingMode: defaultThinkingEffort };
        }
        if (typeof nextCtx?.webSearch !== 'boolean') {
          nextCtx = { ...(nextCtx || {}), webSearch: defaultWebSearch };
        }
        // 加载已有对话时，meta.json 中未保存 promptMode 则回退到普通模式
        if (!nextCtx?.promptMode) {
          nextCtx = { ...(nextCtx || {}), promptMode: 'normal' };
        }
        effectiveSavedContext = nextCtx;
      }
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to read default model/thinking from settings.json: ${err.message}`);
    }

    // 切换对话后校验模型：若该会话保存的模型不在当前 active provider 的模型列表中，
    // 回退到 provider 默认模型，并持久化到该会话 meta.json，避免继续使用失效模型。
    if (effectiveModel) {
      try {
        const { resolveModelForActiveProvider } = await import('../core/llm/config.js');
        const resolvedModel = await resolveModelForActiveProvider(effectiveModel);
        if (resolvedModel && resolvedModel !== effectiveModel) {
          this.log(`[VSCodeUI] Session model "${effectiveModel}" is not in active provider model list, fallback to "${resolvedModel}"`);
          effectiveModel = resolvedModel;
          const { updateConversationContext } = await import('../core/history/index.js');
          await updateConversationContext(message.sessionId, { model: resolvedModel });
          const { setSessionModel } = await import('../core/Integration.js');
          setSessionModel(message.sessionId, resolvedModel);
        }
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to resolve model for active provider: ${err.message}`);
      }
    }

    if (!this.sessionAgentModes.has(message.sessionId)) {
      // 会话没有保存询问模式时，使用 settings.json 中的默认询问模式
      let defaultAgentMode: 'manual' | 'risk' | 'auto' = 'risk';
      try {
        const { getDefaultAgentMode } = await import('../core/llm/config.js');
        defaultAgentMode = await getDefaultAgentMode();
      } catch { /* ignore */ }
      this.sessionAgentModes.set(message.sessionId, defaultAgentMode);
      this.log(`[VSCodeUI] No agentMode for session ${message.sessionId}, defaulting to ${defaultAgentMode}`);
    }

    const targetEngine = getSessionEngine(message.sessionId);
    const hasActiveQuery = targetEngine?.isConsumerRunning === true;

    // 检查压缩归档
    let hasCompactArchive = false;
    try {
      const isCompacted = conversation.metadata?.context?.isCompacted === true;
      if (isCompacted) {
        const { hasCompactArchive: checkArchive } = await import('../core/history/Conversation.js');
        hasCompactArchive = await checkArchive(message.sessionId);
      }
    } catch { /* ignore */ }

    this.postConversationLoaded(message.sessionId, conversation, {
      pendingToolUseIds,
      savedContext: effectiveSavedContext,
      parentSessionId: conversation.metadata?.parentSessionId,
      agentMode: this.sessionAgentModes.get(message.sessionId) ?? 'risk',
      hasActiveQuery,
      hasCompactArchive,
      model: effectiveModel,
    });

    userChoiceQueue.onSessionLoaded(message.sessionId);

    if (hasHistory) {
      this.log(`[VSCodeUI] Restoring conversation engine with ${conversation.messages.length} history messages`);
      restoreConversationEngine(message.sessionId, conversation.messages, conversation.metadata.role).catch(err => {
        this.log(`[VSCodeUI] Error restoring engine: ${err}`);
      });
    }
  }

  private async handleUpdateConversationContext(message: any): Promise<void> {
    this.log(`[VSCodeUI] updateConversationContext: ${message.sessionId}`);
    const { updateConversationContext } = await import('../core/history/index.js');
    const ctxUpdate: Record<string, unknown> = {
      currentFile: message.currentFile,
      selectedLines: message.selectedLines,
    };
    if (message.totalContextTokens !== undefined) {
      ctxUpdate.totalContextTokens = message.totalContextTokens;
    }
    await updateConversationContext(message.sessionId, ctxUpdate as any);
  }

  private async handleRequestTimeStats(message: any): Promise<void> {
    this.log(`[VSCodeUI] requestTimeStats: ${message.sessionId}`);
    const { getSessionEngine } = await import('../core/QueryEngine.js');
    // TimeStats module removed; local no-op stub
    const computeTimeStats = (_messages: unknown[]) => ({
      toolExecution: 0, aiThinking: 0, humanFeedback: 0, totalTime: 0,
      toolCount: 0, thinkingCount: 0, humanCount: 0,
    });
    const engine = getSessionEngine(message.sessionId);
    const msgs = engine ? engine.getMessages() : message.messages;
    if (msgs && msgs.length > 0) {
      this.log(`[VSCodeUI] requestTimeStats: computing from ${msgs.length} messages (engine=${!!engine})`);

      if (engine) {
        const engineMsgs = engine.getMessages();
        for (let ei = 0; ei < engineMsgs.length; ei++) {
          const em = engineMsgs[ei] as any;
          if (em.type === 'assistant' && Array.isArray(em.message?.content)) {
            for (const block of em.message.content) {
              if (block?.type === 'tool_use') {
                this.log(`[TimeStatsDebug][ENGINE] [${ei}] tool_use id=${block.id} uuid=${em.uuid} _meta=${JSON.stringify(block?._meta)}`);
              }
            }
          }
        }
        for (let wi = 0; wi < message.messages.length; wi++) {
          const wm = message.messages[wi] as any;
          if (wm.role === 'toolcall') {
            this.log(`[TimeStatsDebug][WEBVIEW] [${wi}] toolcall name=${wm.param} ts=${wm.timestamp} toolStart=${wm.toolStartTimestamp} toolResult=${wm.toolResultTimestamp}`);
          }
        }
      }

      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i] as any;
        if (m.type === 'assistant' || m.role === 'assistant') {
          const content = m.message?.content || m.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'tool_use') {
                const confirmTs = block?._meta?.confirmTimestamp;
                const toolStartTs = block?._meta?.toolStartTimestamp;
                const msgTs = m.timestamp || 0;
                this.log(`[TimeStatsDebug] [${i}] tool_use id=${block.id} name=${block.name} msgTs=${msgTs} confirmTs=${confirmTs} toolStartTs=${toolStartTs} uuid=${m.uuid} _meta=${JSON.stringify(block?._meta)}`);
              }
            }
          }
        }
      }

      const stats = computeTimeStats(msgs);
      this.log(`[TimeStatsDebug] result: toolExec=${stats.toolExecution} ai=${stats.aiThinking} human=${stats.humanFeedback} total=${stats.totalTime} toolCount=${stats.toolCount} thinkingCount=${stats.thinkingCount} humanCount=${stats.humanCount}`);
      this.host.sendToWebview({
        type: 'timeStatsResult',
        stats,
      });
    } else {
      this.log(`[VSCodeUI] requestTimeStats: no messages available`);
      this.host.sendToWebview({
        type: 'timeStatsResult',
        stats: null,
      });
    }
  }

  private async handleSaveConversationStats(message: any): Promise<void> {
    this.log(`[VSCodeUI] saveConversationStats: ${message.sessionId}`);
    const { updateConversationContext } = await import('../core/history/index.js');
    await updateConversationContext(message.sessionId, {
      stats: message.stats,
    });
  }

  private async handleStartNewConversation(message: any): Promise<void> {
    const { setActiveSessionId } = await import('../core/history/Config.js');
    const newSessionId = message.sessionId;
    setActiveSessionId(newSessionId);
    // 新建对话：开始空闲关闭计时
    noteSessionActivity(newSessionId);
    this.setTitle(newSessionId, defaultTitle());
    // 新对话开始时查询余额
    this.fetchBalanceAndSend(newSessionId);

    // MCP：新对话打开即建立引用（meta.json 尚未创建时按全局默认解析，幂等）
    void (async () => {
      try {
        const { getMcpManager } = await import('../core/mcp/Manager.js');
        // 先回推新会话的 MCP 配置（按全局默认解析）：连接尚未开始 → 显示「连接中」
        await this.pushMcpServers(newSessionId);
        await getMcpManager().acquire(newSessionId);
        await this.pushMcpServers(newSessionId);
      } catch (err: any) {
        this.log(`[VSCodeUI] MCP acquire on new conversation failed: ${err.message}`);
      }
    })();

    // 从 settings.json 读取新对话的默认 model、thinking_effort、agentMode 和 webSearch 并发送给 webview 立即应用。
    // 注意：不再写入 meta.json（meta.json 只在发第一条消息时由 appendMessage 创建），
    // 默认值在发送第一条消息后仍可通过 handleSetModel/handleSetThinkingMode/handleSetPromptMode 持久化。
    try {
      const { getDefaultModel, getDefaultThinkingEffort, getDefaultAgentMode, getDefaultPromptMode, getDefaultWebSearch } = await import('../core/llm/config.js');
      const defaultModel = await getDefaultModel();
      const defaultThinkingEffort = await getDefaultThinkingEffort();
      const defaultAgentMode = await getDefaultAgentMode();
      const defaultPromptMode = await getDefaultPromptMode();
      const defaultWebSearch = await getDefaultWebSearch();
      this.postToWebview(newSessionId, {
        type: 'setNewConversationDefaults',
        model: defaultModel,
        thinkingMode: defaultThinkingEffort,
        agentMode: defaultAgentMode,
        promptMode: defaultPromptMode,
        webSearch: defaultWebSearch,
      } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to send defaults: ${err.message}`);
    }

    // 新对话如果没有设置 llm.activeProvider（或 active provider 缺少 apiKey），则弹出设置页引导用户配置
    try {
      const { hasActiveProviderSetting, getLLMConfigPanelPayload } = await import('../core/llm/config.js');
      const { readMcpServersForDefaults } = await import('../core/mcp/Config.js');
      const [hasActiveProvider, payload, mcpServers] = await Promise.all([
        hasActiveProviderSetting(),
        getLLMConfigPanelPayload(),
        readMcpServersForDefaults(),
      ]);
      if (!hasActiveProvider || !payload.apiKey) {
        this.host.sendToWebview({
          type: 'showLLMConfig',
          ...payload,
          mcpServers,
          language: this.getUiLanguageFromSettings(),
          // 定向到刚创建的会话：避免新对话的配置引导弹到其它端
          sessionId: newSessionId,
        });
        this.log(`[VSCodeUI] ${hasActiveProvider ? 'Active provider apiKey is empty' : 'No llm.activeProvider configured'}, showing LLM config panel for new conversation`);
      }
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to check active provider: ${err.message}`);
    }
  }

  /**
   * 获取 DeepSeek 账户余额并发送到 webview
   */
  private fetchBalanceAndSend(sessionID: string): void {
    import('../core/utils/balance.js').then(({ fetchBalance }) => {
      fetchBalance(sessionID).then(balanceInfo => {
        if (balanceInfo) {
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: balanceInfo.totalBalance,
            currency: balanceInfo.currency,
            isUnlimited: balanceInfo.isUnlimited,
            fetchedAt: balanceInfo.fetchedAt,
          } as any);
        } else {
          // 获取余额失败时清空余额，避免 webview 继续显示旧值
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: null,
            currency: null,
            isUnlimited: null,
            fetchedAt: Date.now(),
          } as any);
        }
      }).catch((err: unknown) => {
        this.log(`Failed to fetch balance: ${err}`);
      });
    }).catch((err: unknown) => {
      this.log(`Failed to import balance module: ${err}`);
    });
  }

  private async handleDeleteConversation(message: any): Promise<void> {
    this.log(`[VSCodeUI] deleteConversation requested: ${message.sessionId}`);
    const { deleteConversation, loadConversationList } = await import('../core/history/index.js');
    const { getActiveSessionId, setActiveSessionId } = await import('../core/history/Config.js');
    try {
      const deletedSessionId = message.sessionId;
      const currentActiveSessionId = getActiveSessionId();
      const allConversations = await loadConversationList();

      let needsNewSession = currentActiveSessionId === deletedSessionId;
      if (!needsNewSession) {
        let checkId: string | null = currentActiveSessionId;
        while (checkId) {
          const conv = allConversations.find(c => c.sessionId === checkId);
          if (!conv) break;
          if (conv.parentSessionId === deletedSessionId) {
            needsNewSession = true;
            break;
          }
          checkId = conv.parentSessionId ?? null;
        }
      }

      // 受影响会话 = 根 + 所有后代（deleteConversation 会级联删除子对话）
      const affectedSessions = new Set<string>([deletedSessionId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const conv of allConversations) {
          const parentId = conv.parentSessionId;
          if (parentId && affectedSessions.has(parentId) && !affectedSessions.has(conv.sessionId)) {
            affectedSessions.add(conv.sessionId);
            grew = true;
          }
        }
      }

      // 删除 = abort -> close -> delete。
      // 1) abort：先中止受影响会话正在运行的查询（含后台 Bash 任务与递归子代理）。
      //    必须在 deleteConversation 把引擎移出 sessionEngines 之前执行，
      //    否则引擎失联后无法再中断，查询会在后台继续跑并复活已删除的对话文件。
      try {
        const { abortCurrentQuery } = await import('../core/Integration.js');
        for (const sid of affectedSessions) {
          abortCurrentQuery(sid);
        }
      } catch { /* 中止失败不阻塞删除 */ }

      // 2) close：关闭会话（中止查询 + 释放 MCP 引用，引用归零的 server 由 McpManager 回收）。
      //    该动作在 Electron 中也可由用户点关闭按钮直接触发；VS Code 无独立视图，
      //    用户无法直接触发，只能由这里的删除流程调用。
      for (const sid of affectedSessions) {
        try {
          await this.host.closeConversation?.(sid);
        } catch { /* 关闭失败不阻塞删除 */ }
      }

      // 3) delete：删除磁盘文件并清理引擎池 / 缓存
      await deleteConversation(deletedSessionId);
      // 会话已删除：清理空闲关闭计时状态
      for (const sid of affectedSessions) {
        clearSessionIdleState(sid);
      }
      this.log(`[VSCodeUI] Conversation deleted: ${deletedSessionId}`);

      // NodeRegistry (Redis-based) removed

      if (needsNewSession) {
        this.log(`[VSCodeUI] Deleted session is the active session or its ancestor, creating new session`);
        const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        setActiveSessionId(newSessionId);
        this.log(`[VSCodeUI] Created new session ${newSessionId} (old active session was deleted)`);

        this.host.sendToWebview({
          type: 'switchToNewSession',
          sessionId: newSessionId,
        } as WebviewMessage);

        // 与手动新建对话走同一套初始化逻辑：
        // 设置标题、查询余额、下发 settings.json 默认 model/thinking/agentMode/promptMode/webSearch，
        // 并在缺少 provider 配置时弹出配置引导。
        await this.handleStartNewConversation({ sessionId: newSessionId });
      }

      const conversations = await loadConversationList();
      this.host.sendToWebview({
        type: 'conversationsData',
        conversations,
      });
    } catch (err) {
      this.log(`[VSCodeUI] Error deleting conversation: ${err}`);
    }
  }

  private async handleClearConversation(message: any): Promise<void> {
    this.log(`[VSCodeUI] clearConversation requested: ${message.sessionId}`);
    (async () => {
      try {
        const { replaceConversationMessages, updateConversationContext } = await import('../core/history/index.js');
        await replaceConversationMessages(message.sessionId, []);
        await updateConversationContext(message.sessionId, { totalContextTokens: 0 });
        const { getSessionEngine } = await import('../core/QueryEngine.js');
        const engine = getSessionEngine(message.sessionId);
        if (engine) {
          const msgs = engine.getMessages();
          msgs.length = 0;
          engine.lastPersistedMessageUuid = null;
        }
        this.log(`[VSCodeUI] Conversation cleared: ${message.sessionId}`);
        const { loadConversationList } = await import('../core/history/index.js');
        const conversations = await loadConversationList();
        this.host.sendToWebview({ type: 'conversationsData', conversations } as any);
      } catch (err) {
        this.log(`[VSCodeUI] Error clearing conversation: ${err}`);
      }
    })();
  }

  private async handleRespondUserChoice(message: any): Promise<void> {
    this.log(`[VSCodeUI] User choice response: ${message.choiceId}, index: ${message.index}`);
    const pending = this.userChoiceManager.pendingUserChoices.get(message.choiceId);
    if (pending) {
      this.userChoiceManager.pendingUserChoices.delete(message.choiceId);
      userChoiceQueue.respond(pending.sessionId, { index: message.index, reply: message.reply });
      pending.resolve({ index: message.index, reply: message.reply });
      this.onUserChoiceResponded?.(pending.sessionId);
    } else {
      this.log(`[VSCodeUI] Warning: No pending choice found for ${message.choiceId}`);
    }
  }

  private async handleSetAgentMode(message: any): Promise<void> {
    this.sessionAgentModes.set(message.sessionId, message.mode);
    this.log(`[VSCodeUI] Agent mode set to: ${message.mode} for session: ${message.sessionId}`);
    // 多端同步：同一会话在其它端也打开时，一并更新其 agent 模式
    if (message.sessionId) {
      this.host.sendToWebview({ type: 'setAgentMode', mode: message.mode, sessionId: message.sessionId } as any);
    }
  }

  private async handleSetPromptMode(message: any): Promise<void> {
    const { isPromptPresetId } = await import('../core/prompt/PromptPreset.js');
    if (!isPromptPresetId(message.mode)) {
      this.log(`[VSCodeUI] Invalid prompt mode: ${message.mode}`);
      return;
    }
    const { setSessionPromptPreset } = await import('../core/Integration.js');
    setSessionPromptPreset(message.sessionId, message.mode);
    this.log(`[VSCodeUI] Prompt mode set to: ${message.mode} for session: ${message.sessionId}`);

    // 仅持久化到会话 meta.json（不影响 settings.json，settings.json 中的值只影响新对话初始值）
    const sessionId = message.sessionId;
    if (sessionId && sessionId !== 'undefined') {
      try {
        const { updateConversationContext } = await import('../core/history/Conversation.js');
        await updateConversationContext(sessionId, { promptMode: message.mode });
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to save prompt mode to session meta.json: ${err.message}`);
      }
      // 多端同步：同一会话在其它端也打开时，一并更新其提示词模式
      this.host.sendToWebview({ type: 'setPromptMode', mode: message.mode, sessionId } as any);
    }
  }

  private async handleSetThinkingMode(message: any): Promise<void> {
    const { setSessionThinkingMode } = await import('../core/Integration.js');
    setSessionThinkingMode(message.sessionId, message.mode);
    this.log(`[VSCodeUI] Thinking mode set to: ${message.mode} for session: ${message.sessionId}`);

    // 仅持久化到会话 meta.json（不影响 settings.json，settings.json 中的值只影响新对话初始值）
    const sessionId = message.sessionId;
    if (sessionId && sessionId !== 'undefined') {
      try {
        const { updateConversationContext } = await import('../core/history/Conversation.js');
        await updateConversationContext(sessionId, { thinkingMode: message.mode });
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to save thinking mode to session meta.json: ${err.message}`);
      }
      // 多端同步：同一会话在其它端也打开时，一并更新其 thinking 模式
      this.host.sendToWebview({ type: 'setThinkingMode', mode: message.mode, sessionId } as any);
    }
  }

  private async handleSetWebSearch(message: any): Promise<void> {
    const webSearch = !!message.webSearch;
    this.log(`[VSCodeUI] Web search set to: ${webSearch} for session: ${message.sessionId}`);

    // 更新引擎的 modelConfig.webSearch（会话关联的联网开关，立即生效）
    try {
      const { getSessionEngine } = await import('../core/QueryEngine.js');
      const engine = getSessionEngine(message.sessionId);
      if (engine) {
        engine.updateWebSearch(webSearch);
      }
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to update engine webSearch: ${err.message}`);
    }

    // 仅持久化到会话 meta.json（不影响 settings.json，settings.json 中的值只影响新对话初始值）
    const sessionId = message.sessionId;
    if (sessionId && sessionId !== 'undefined') {
      try {
        const { updateConversationContext } = await import('../core/history/Conversation.js');
        await updateConversationContext(sessionId, { webSearch });
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to save webSearch to session meta.json: ${err.message}`);
      }
      // 多端同步：同一会话在其它端也打开时，一并更新其联网开关
      this.host.sendToWebview({ type: 'setWebSearch', webSearch, sessionId } as any);
    }
  }

  private async handleSetModel(message: any): Promise<void> {
    this.log(`[VSCodeUI] Model set to: ${message.model} for session: ${message.sessionId}`);
    // 仅保存到当前会话的 meta.json，不修改全局 settings.json
    // settings.json 中的 model 仅作为新对话的默认值
    const sessionId = message.sessionId;
    if (sessionId && sessionId !== 'undefined') {
      try {
        const { updateConversationContext } = await import('../core/history/Conversation.js');
        await updateConversationContext(sessionId, { model: message.model });
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to save model to session meta.json: ${err.message}`);
      }

      // 更新当前引擎的 modelConfig，确保后续 API 调用使用新模型；
      // 若引擎尚未创建（如新对话发送首条消息前），由 Integration 缓存并在引擎创建后应用。
      try {
        const { setSessionModel } = await import('../core/Integration.js');
        setSessionModel(sessionId, message.model);
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to update engine modelConfig: ${err.message}`);
      }

      // 多端同步：同一会话在其它端也打开时，一并更新其当前模型
      this.host.sendToWebview({ type: 'setModel', model: message.model, sessionId } as any);
    }
  }

  private async handleRequestModels(_message: any): Promise<void> {
    this.log(`[VSCodeUI] Requesting model list from API`);
    const builtinModels = MODEL_CONFIGS.map((cfg) => cfg.name);
    try {
      const { readSettingsJson } = await import('../core/history/Config.js');
      const settings = await (readSettingsJson as () => Promise<Record<string, any>>)();
      const activeKey = settings?.llm?.activeProvider;
      const activeProvider = activeKey ? settings?.llm?.providers?.[activeKey] : undefined;
      const baseURL = typeof activeProvider?.baseURL === 'string' ? activeProvider.baseURL.trim() : '';
      const apiKey = typeof activeProvider?.apiKey === 'string' ? activeProvider.apiKey.trim() : '';

      const savedModels = Array.isArray(activeProvider?.models)
        ? (activeProvider.models as unknown[])
            .filter((m): m is string => typeof m === 'string' && !!m.trim())
            .map((m) => m.trim())
        : [];
      // 当前服务商的默认 model，确保始终出现在模型列表中
      const defaultModel: string | undefined =
        (typeof activeProvider?.defaultModel === 'string' && activeProvider.defaultModel.trim())
          ? activeProvider.defaultModel.trim()
          : (Array.isArray(activeProvider?.models) && activeProvider.models.length > 0
              ? activeProvider.models[0]
              : undefined);
      const ensureDefault = (models: string[]): string[] => {
        const unique = Array.from(new Set(models.filter((m) => !!m.trim())));
        if (defaultModel && !unique.includes(defaultModel)) {
          unique.unshift(defaultModel);
        }
        return unique;
      };

      if (baseURL && apiKey) {
        const fetched = await this.fetchModelsFromProvider(baseURL, apiKey);
        if (fetched.length > 0) {
          this.log(`[VSCodeUI] Fetched ${fetched.length} models from API`);
          const models = ensureDefault([...fetched, ...savedModels]);
          this.host.sendToWebview({ type: 'setModels', models } as any);
          return;
        }
        this.log(`[VSCodeUI] API returned no models, using saved/builtin models`);
      }

      // Fallback：优先使用已保存的模型列表；没有时使用内置模型
      const fallbackModels = ensureDefault(savedModels.length > 0 ? savedModels : builtinModels);
      this.host.sendToWebview({ type: 'setModels', models: fallbackModels } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to fetch models: ${err.message}`);
      this.host.sendToWebview({ type: 'setModels', models: builtinModels } as any);
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
      this.host.sendToWebview({ type: 'providerModelsFetched', models: [], modelApiTypes: {}, needDetect: [] } as any);
      return;
    }
    try {
      this.log(`[VSCodeUI] Fetching provider models from ${baseURL}`);
      const models = await this.fetchModelsFromProvider(baseURL, apiKey);

      // 只回传「本次列表里且已有协议」的映射，避免把无关模型带回面板
      const modelApiTypes: Record<string, string> = {};
      for (const model of models) {
        if (knownApiTypes[model]) modelApiTypes[model] = knownApiTypes[model];
      }
      const needDetect = models.filter((m) => !modelApiTypes[m]);
      this.log(`[VSCodeUI] Fetched ${models.length} models, ${needDetect.length} without API type`);
      this.host.sendToWebview({ type: 'providerModelsFetched', models, modelApiTypes, needDetect } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to fetch provider models: ${err.message}`);
      this.host.sendToWebview({ type: 'providerModelsFetched', models: [], modelApiTypes: {}, needDetect: [] } as any);
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
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes } as any);
      return;
    }

    try {
      this.log(`[VSCodeUI] Detecting API type for ${toDetect.length} model(s) concurrently (concurrency=${API_TYPE_PROBE_CONCURRENCY})...`);
      const started = Date.now();
      const detected = await this.mapWithConcurrency(
        toDetect,
        API_TYPE_PROBE_CONCURRENCY,
        async (model) => ({ model, apiType: await this.detectModelApiType(baseURL, apiKey, model) }),
      );
      for (const item of detected) {
        if (item.apiType) modelApiTypes[item.model] = item.apiType;
      }
      this.log(`[VSCodeUI] API type detection finished in ${Date.now() - started}ms (${Object.keys(modelApiTypes).length}/${models.length} resolved)`);
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to detect provider model api types: ${err.message}`);
      this.host.sendToWebview({ type: 'providerModelsResult', models, modelApiTypes } as any);
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
        const data = await response.json() as any;
        const rawList: unknown[] = Array.isArray(data?.data) ? data.data
          : Array.isArray(data?.models) ? data.models
          : Array.isArray(data?.model_ids) ? data.model_ids
          : [];
        const models = rawList
          .map((item: any) => {
            if (typeof item === 'string') return item.trim();
            if (item && typeof item === 'object') {
              const id = typeof item.id === 'string' ? item.id : (typeof item.model === 'string' ? item.model : '');
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
   * 近乎零成本地探测单个模型支持的 API 协议，按 Responses > OpenAI > Anthropic 取第一个可用的。
   *
   * 原理：网关按「路径定协议 → 查模型是否注册该协议 → 鉴权 → 转发上游」的顺序处理。
   * 探测 body 故意不携带必填的 messages / input，请求会在上游入参校验阶段被拒，
   * 正常情况下不会进入推理，因此不产生 completion、不消耗 token。
   *
   * 注意：并非所有后端都严格遵守 schema（实测 opencode 的 omen-alpha 有时会
   * 忽略缺失的 messages 直接生成）。因此额外带上 max_tokens / max_output_tokens = 1
   * 兜底：即使真的生成了，输出也被封顶在 1 个 token（实测 finish_reason=length、
   * content 为空），单次探测的额外成本可忽略。
   *
   * 判定规则见 classifyProbeResult；结果不确定（限流 / 地区限制 / 网络异常）时
   * 返回 null 而不是猜测，避免写入错误的协议。
   *
   * @returns 探测到的协议；不确定或三种都不支持时返回 null
   */
  private async detectModelApiType(baseURL: string, apiKey: string, model: string): Promise<'Responses' | 'OpenAI' | 'Anthropic' | null> {
    const trimmed = baseURL.replace(/\/+$/, '');
    const v1 = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
    const sessionId = `probe-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // 顺序即优先级
    const candidates: Array<{
      apiType: 'Responses' | 'OpenAI' | 'Anthropic';
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [
      {
        apiType: 'Responses',
        url: `${v1}/responses`,
        headers: { 'Authorization': `Bearer ${apiKey}` },
        // 缺少必填的 input → 上游入参校验必失败；max_output_tokens 兜底封顶
        body: { model, max_output_tokens: 1 },
      },
      {
        apiType: 'OpenAI',
        url: `${v1}/chat/completions`,
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: { model, max_tokens: 1 },
      },
      {
        apiType: 'Anthropic',
        url: `${v1}/messages`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 1 },
      },
    ];

    // 三个协议**同时发起**，但按优先级顺序 await：
    // 高优先级一旦有结论就立即返回并 abort 掉其余探测，
    // 不必等低优先级那些慢请求（最坏情况等价于 Promise.all，最好情况省掉 2/3 等待）。
    const controllers = candidates.map(() => new AbortController());
    const timers = controllers.map((controller) =>
      setTimeout(() => controller.abort(), API_TYPE_PROBE_TIMEOUT_MS));

    const probes = candidates.map((candidate, index) =>
      this.probeWithRetry(candidate, model, sessionId, controllers[index]));

    try {
      for (let index = 0; index < candidates.length; index++) {
        const verdict = await probes[index];
        if (verdict === 'supported') {
          // 命中即中止所有更低优先级的探测，避免无谓等待
          for (let lower = index + 1; lower < controllers.length; lower++) {
            controllers[lower].abort();
          }
          return candidates[index].apiType;
        }
        if (verdict === 'unknown') {
          // 高优先级结果不确定（限流重试后仍失败 / 地区限制 / 网络异常）：
          // 不猜测、不降级到低优先级，交给用户手动选择或下次自动获取时重试
          this.log(`[VSCodeUI] probe ${model}: ${candidates[index].apiType} verdict unknown, skipping detection (will retry next fetch)`);
          for (let lower = index + 1; lower < controllers.length; lower++) {
            controllers[lower].abort();
          }
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
    candidate: { apiType: 'Responses' | 'OpenAI' | 'Anthropic'; url: string; headers: Record<string, string>; body: Record<string, unknown> },
    model: string,
    sessionId: string,
    controller: AbortController,
  ): Promise<ProbeVerdict> {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= API_TYPE_PROBE_MAX_RETRIES; attempt++) {
      if (controller.signal.aborted) return 'unknown';
      try {
        const response = await undiciFetch(candidate.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-opencode-session': sessionId,
            'x-session-id': sessionId,
            ...candidate.headers,
          },
          body: JSON.stringify(candidate.body),
          signal: controller.signal,
          dispatcher: getProbeDispatcher(),
        });
        const text = await response.text();
        lastStatus = response.status;

        // 限流 / 瞬时故障：退避重试
        if (API_TYPE_PROBE_RETRYABLE_STATUS.has(response.status) && attempt < API_TYPE_PROBE_MAX_RETRIES) {
          const retryAfterMs = this.parseRetryAfterMs(response.headers.get('retry-after'));
          const delay = retryAfterMs ?? API_TYPE_PROBE_RETRY_BASE_DELAY_MS * (attempt + 1);
          this.log(`[VSCodeUI] probe ${model} ${candidate.apiType} -> HTTP ${response.status} (retryable), retrying in ${delay}ms (${attempt + 1}/${API_TYPE_PROBE_MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        const verdict = this.classifyProbeResult(response.status, text);
        this.log(`[VSCodeUI] probe ${model} ${candidate.apiType} -> HTTP ${response.status} ${verdict}${verdict === 'supported' ? '' : ` ${text.slice(0, 160)}`}`);
        return verdict;
      } catch (err: any) {
        // 被主动 abort 的低优先级探测不记录为错误
        if (controller.signal.aborted) return 'unknown';
        // 网络错误也重试
        if (attempt < API_TYPE_PROBE_MAX_RETRIES) {
          const delay = API_TYPE_PROBE_RETRY_BASE_DELAY_MS * (attempt + 1);
          this.log(`[VSCodeUI] probe ${model} ${candidate.apiType} -> error ${err?.message || err}, retrying in ${delay}ms (${attempt + 1}/${API_TYPE_PROBE_MAX_RETRIES})`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        this.log(`[VSCodeUI] probe ${model} ${candidate.apiType} -> error ${err?.message || err}`);
        return 'unknown';
      }
    }
    this.log(`[VSCodeUI] probe ${model} ${candidate.apiType} -> exhausted retries (last HTTP ${lastStatus})`);
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

  /**
   * 判定一次探测响应的含义（三态）。
   *
   * 需要区分三种形状相近、含义完全不同的响应体：
   *   1. 网关自身信封：{"type":"error","error":{"type":"ModelError"|"AuthError"|"RegionError"|"error"|...}}
   *      → 与协议无关的拒绝（模型不支持该格式 / 鉴权 / 地区限制 / 内部错误）
   *   2. 上游错误被网关包一层：{"model":"X","error":{...}} 或 {"error":{...}}
   *      → 请求已经路由到该协议的上游，说明该协议**可用**
   *        （例如 gpt-5.6-luna 的 Responses 返回 403 地区限制，恰恰证明 Responses 路由通了）
   *   3. 上游标准错误（Anthropic 风格）被网关原样透传：
   *      {"type":"error","error":{"type":"invalid_request_error"|"authentication_error"|...}}
   *      → 同样说明请求到达了上游
   */
  private classifyProbeResult(status: number, text: string): ProbeVerdict {
    /** 网关自身产生的、明确表示「该协议不可用」的错误类型 */
    const GATEWAY_REJECT_TYPES = new Set(['ModelError', 'AuthError', 'MissingSessionID', 'CreditsError', 'error']);
    /** 网关自身产生的、与协议无关（无法判断）的错误类型 */
    const GATEWAY_UNKNOWN_TYPES = new Set(['RegionError']);

    let payload: any;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }

    if (payload && typeof payload === 'object') {
      const isGatewayEnvelope = payload.type === 'error'
        && payload.error && typeof payload.error === 'object';
      if (isGatewayEnvelope) {
        const errType = typeof payload.error.type === 'string' ? payload.error.type : '';
        if (GATEWAY_REJECT_TYPES.has(errType)) {
          // 模型不支持该格式 / 鉴权失败 / 网关内部 500（适配器崩溃）
          return 'unsupported';
        }
        if (GATEWAY_UNKNOWN_TYPES.has(errType)) {
          // 地区限制等，与协议无关 → 无法判断
          return 'unknown';
        }
        // 其余是上游业务错误（invalid_request_error 等）被网关原样透传：已到达真实上游
        return status === 400 || status === 422 ? 'supported' : 'unknown';
      }

      // 上游错误被网关包了一层（可能带顶层 model 字段）→ 已路由到该协议的上游
      if (payload.error && typeof payload.error === 'object') {
        return 'supported';
      }
    }

    // 无错误体：按状态码兜底
    //   400/422 → 上游入参校验拒绝（body 缺必填字段）→ 端点存在，支持
    //   2xx     → 理论上不会发生（body 非法），保守视为支持
    //   404/405 → 端点不存在 → 不支持
    //   401/403/其它 5xx → 无法判断
    if (status === 400 || status === 422) return 'supported';
    if (status >= 200 && status < 300) return 'supported';
    if (status === 404 || status === 405) return 'unsupported';
    return 'unknown';
  }

  /** 按并发上限执行异步任务，结果顺序与输入一致 */
  private async mapWithConcurrency<T, R>(
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

  private async handleRollbackEdit(message: any): Promise<void> {
    const { sessionId, toolUseId, filePath, direction } = message;
    this.log(`[VSCodeUI] rollbackEdit: session=${sessionId}, toolUseId=${toolUseId}, filePath=${filePath}, direction=${direction}`);

    // 防御性检查：sessionId 必须有效
    if (!sessionId || sessionId === 'undefined' || sessionId === 'null') {
      this.log(`[VSCodeUI] rollbackEdit: invalid sessionId`);
      this.postToWebview(sessionId || '', {
        type: 'rollbackEditResult',
        success: false,
        message: '无效的会话 ID，无法执行回滚',
      } as any);
      return;
    }

    (async () => {
      try {
        const { loadConversation } = await import('../core/history/index.js');
        const conversation = await loadConversation(sessionId);

        // 收集所有 Edit tool_use block（按消息出现的顺序排列）
        const allToolUses: Array<{ id: string; name: string; _meta: any; input: any }> = [];
        // 收集 tool_result 中的 beforeContent，按 tool_use_id 索引
        const toolResultBeforeContent = new Map<string, string | null>();
        for (const msg of conversation.messages) {
          if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              const b = block as any;
              if (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write')) {
                allToolUses.push({
                  id: b.id,
                  name: b.name,
                  _meta: b._meta || {},
                  input: b.input || {},
                });
              }
            }
          }
          // 从 tool_result 消息中收集 beforeContent（_meta 可能因异步写入时序未持久化）
          if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
            for (const block of msg.message.content) {
              const b = block as any;
              if (b.type === 'tool_result' && b.beforeContent !== undefined) {
                toolResultBeforeContent.set(b.tool_use_id, b.beforeContent);
              }
            }
          }
        }

        // 找到目标 tool_use 的索引
        const targetIndex = allToolUses.findIndex(t => t.id === toolUseId);
        if (targetIndex === -1) {
          this.log(`[VSCodeUI] rollbackEdit: toolUseId ${toolUseId} not found among ${allToolUses.length} tool calls`);
          this.postToWebview(sessionId, {
            type: 'rollbackEditResult',
            success: false,
            message: '未找到指定的编辑操作，可能历史记录已被压缩',
          } as any);
          return;
        }

        const target = allToolUses[targetIndex];
        // 先从 _meta 读，如果不在则从 tool_result 的 beforeContent 读（Write 新建文件可能为 null）
        let targetBeforeContent = target._meta?.beforeContent;
        if (targetBeforeContent === undefined) {
          targetBeforeContent = toolResultBeforeContent.has(target.id) ? toolResultBeforeContent.get(target.id) : undefined;
        }
        const targetAfterContent = target._meta?.afterContent;
        const targetFilePath = target.input?.file_path || filePath;

        if (direction === 'before' && (targetBeforeContent === undefined || targetBeforeContent === '')) {
          this.log(`[VSCodeUI] rollbackEdit: target Edit has no beforeContent in _meta`);
          this.postToWebview(sessionId, {
            type: 'rollbackEditResult',
            success: false,
            message: '目标编辑操作缺少备份内容（beforeContent），无法回滚',
          } as any);
          return;
        }
        if (direction === 'after' && !targetAfterContent) {
          this.log(`[VSCodeUI] rollbackEdit: target Edit has no afterContent in _meta`);
          this.postToWebview(sessionId, {
            type: 'rollbackEditResult',
            success: false,
            message: '目标编辑操作缺少备份内容（afterContent），无法回滚到修改后',
          } as any);
          return;
        }

        const filesToRestore = new Map<string, string | null>(); // filePath -> content to restore to (null = delete file)

        if (direction === 'before') {
          // 回滚到目标修改**前**：用目标的 beforeContent 写回，并撤销该目标之后所有后续修改
          filesToRestore.set(targetFilePath, targetBeforeContent);
          // 对其他文件，恢复到它们在目标时刻的状态（即它们第一次被 Edit 前的状态）
          for (let i = targetIndex + 1; i < allToolUses.length; i++) {
            const edit = allToolUses[i];
            const fp = edit.input?.file_path;
            if (fp && !filesToRestore.has(fp)) {
              const bc = edit._meta?.beforeContent;
              if (bc !== undefined) {
                filesToRestore.set(fp, bc);
              }
            }
          }
        } else {
          // 回滚到目标修改**后**：用目标的 afterContent 写回，并撤销该目标之后的所有后续修改
          // 但保留目标自身的改动（即不撤销目标的修改）
          filesToRestore.set(targetFilePath, targetAfterContent);
          // 对其他文件，恢复到它们在目标时刻的状态
          for (let i = targetIndex + 1; i < allToolUses.length; i++) {
            const edit = allToolUses[i];
            const fp = edit.input?.file_path;
            if (fp && !filesToRestore.has(fp)) {
              const bc = edit._meta?.beforeContent;
              if (bc !== undefined) {
                filesToRestore.set(fp, bc);
              }
            }
          }
        }

        this.log(`[VSCodeUI] rollbackEdit: restoring ${filesToRestore.size} files...`);
        let restoredCount = 0;
        for (const [fp, content] of filesToRestore) {
          try {
            const { expandPath } = await import('../core/utils/path.js');
            const { writeFile, unlink, mkdir } = await import('fs/promises');
            const { dirname } = await import('path');
            const fullPath = expandPath(fp);

            if (content === null) {
              // beforeContent 为 null 表示文件原本不存在，删除它
              try {
                await unlink(fullPath);
                this.log(`[VSCodeUI] rollbackEdit: deleted ${fp}`);
                restoredCount++;
              } catch (err: any) {
                if (err.code !== 'ENOENT') {
                  this.log(`[VSCodeUI] rollbackEdit: failed to delete ${fp}: ${err.message}`);
                } else {
                  this.log(`[VSCodeUI] rollbackEdit: ${fp} already deleted, skipped`);
                  restoredCount++;
                }
              }
            } else {
              // 向前回滚（after 方向）时目标可能不存在，需先创建目录和文件
              try {
                await mkdir(dirname(fullPath), { recursive: true });
              } catch {
                // 目录已存在或创建失败，继续尝试写文件
              }
              await writeFile(fullPath, content, 'utf-8');
              this.log(`[VSCodeUI] rollbackEdit: restored ${fp} (${content.length} chars)`);
              restoredCount++;
            }
          } catch (err: any) {
            this.log(`[VSCodeUI] rollbackEdit: failed to restore ${fp}: ${err.message}`);
          }
        }

        this.postToWebview(sessionId, {
          type: 'rollbackEditResult',
          success: true,
          message: `已回滚到目标修改${direction === 'before' ? '前' : '后'}：${restoredCount > 0 ? `恢复了 ${restoredCount} 个文件` : '没有文件需要恢复'}`,
          restoredFiles: restoredCount,
        } as any);
      } catch (err: any) {
        this.log(`[VSCodeUI] rollbackEdit error: ${err.message}`);
        this.postToWebview(sessionId, {
          type: 'rollbackEditResult',
          success: false,
          message: `回滚失败：${err.message}`,
        } as any);
      }
    })();
  }

  private async handleCreateEngine(message: any): Promise<void> {
    const { createEngine } = await import('../core/Integration.js');
    const { sessionId, title, role } = message;
    if (!sessionId) {
      this.log('[VSCodeUI] createEngine: missing sessionId');
      return;
    }
    const engine = createEngine(sessionId, title || defaultTitle(), role);
    if (engine) {
      this.log(`[VSCodeUI] Engine created for session ${sessionId} (title="${title || defaultTitle()}")`);
      // 注意：不再提前把默认 model/thinking 写入 meta.json，
      // meta.json 只在发第一条消息（appendMessage）时创建。
    }
  }

  private async handleRequestSkills(): Promise<void> {
    this.log(`[VSCodeUI] Skills requested`);
    const { getBundledSkills } = await import('../core/skills/bundledSkills.js');
    const { getSkillDirCommands } = await import('../core/skills/loadSkillsDir.js');
    const { getBuiltinCommands } = await import('../core/skills/builtinCommands.js');
    const bundled = getBundledSkills();
    const fileSkills = await getSkillDirCommands(process.cwd());
    const builtinCmds = getBuiltinCommands();
    const allSkills = [...bundled, ...fileSkills];
    this.host.sendToWebview({
      type: 'setSkills',
      skills: [
        ...builtinCmds.map(c => ({
          name: c.name,
          description: c.description,
          isBuiltin: true as const,
        })),
        ...allSkills.map(s => ({
          name: s.name,
          description: s.description,
          isBuiltin: false as const,
        })),
      ],
    });
  }

  private async handleOpenMermaidPreview(message: any): Promise<void> {
    const code: string = message.code || '';
    if (!code.trim()) return;

    this.log(`[VSCodeUI] openMermaidPreview`);
    // 浏览器端：回推给发起端在页面内预览（页内按源码展示，不打开桌面窗口）
    if (message.clientId) {
      this.host.sendToWebview({
        type: 'openPreview',
        mode: 'mermaid',
        title: 'Mermaid',
        code,
        sessionId: message.sessionId,
        clientId: message.clientId,
      } as any);
      return;
    }
    try {
      await this.host.openMermaidPreview(code);
    } catch (err) {
      this.log(`[VSCodeUI] Error opening mermaid preview: ${err}`);
    }
  }

  public async handleOpenSpinDesign(): Promise<void> {
    this.log(`[VSCodeUI] openSpinDesign`);
    try {
      await this.host.openSpinDesign();
    } catch (err) {
      this.log(`[VSCodeUI] Error opening spin design: ${err}`);
    }
  }

  private async handleRenameConversation(message: any): Promise<void> {
    this.log(`[VSCodeUI] renameConversation: ${message.sessionId} -> "${message.title}"`);
    const { updateConversationMetadataTitle } = await import('../core/history/Conversation.js');
    await updateConversationMetadataTitle(message.sessionId, message.title);
    this.setTitle(message.sessionId, message.title);
    const { loadConversationList } = await import('../core/history/index.js');
    const conversations = await loadConversationList();
    this.host.sendToWebview({ type: 'conversationsData', conversations } as any);
  }

  private async handleRequestSmartNaming(message: any): Promise<void> {
    this.log(`[VSCodeUI] requestSmartNaming: ${message.sessionId}`);
    const sessionId = message.sessionId;
    (async () => {
      try {
        const { loadConversation } = await import('../core/history/index.js');
        const conversation = await loadConversation(sessionId);
        const msgs = conversation.messages || [];
        const contentMessages: string[] = [];
        for (const msg of msgs) {
          const m = msg as any;
          if (m.type === 'user' && typeof m.message?.content === 'string') {
            contentMessages.push(`[用户]: ${m.message.content.substring(0, 500)}`);
            if (contentMessages.length >= 5) break;
          } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
            for (const block of m.message.content) {
              if ((block as any).type === 'text' && (block as any).text) {
                contentMessages.push(`[助手]: ${(block as any).text.substring(0, 500)}`);
                if (contentMessages.length >= 5) break;
              }
            }
            if (contentMessages.length >= 5) break;
          }
        }
        const { callLLM } = await import('../core/llm/index.js');
        const { getConfig } = await import('../core/llm/config.js');
        const systemPrompt = '你是一个对话标题生成器。\n\n'
          + '示例1:\n对话内容：[用户]: 帮我写一个Python排序函数\n[助手]: 以下是冒泡排序实现...\n'
          + '输出：{"title": "Python排序函数"}\n\n'
          + '示例2:\n对话内容：[用户]: 今天天气怎么样\n[助手]: 今天北京晴转多云...\n'
          + '输出：{"title": "查询天气"}\n\n'
          + '现在请为以下对话生成标题（不超过20个字），只输出 JSON：';
        const modelConfig = await getConfig();
        let rawResult = '';
        for await (const event of callLLM({
          messages: [
            { role: 'user' as const, content: `${systemPrompt}\n\n对话内容：\n${contentMessages.join('\n\n')}` },
          ],
          tools: [],
          signal: null,
          modelConfig,
          sessionId,
        })) {
          if (event.type === 'text_delta') {
            rawResult += event.text;
          } else if (event.type === 'assistant') {
            const ct = event.message?.content;
            if (Array.isArray(ct)) {
              for (const block of ct) {
                if (block.type === 'text' && block.text) {
                  rawResult = block.text;
                }
              }
            }
          }
        }
        const jsonStr = extractLastJsonObject(rawResult);
        let title = '';
        if (jsonStr) {
          try { const parsed = JSON.parse(jsonStr); title = parsed.title || ''; } catch { /* ignore */ }
        }
        if (!title) {
          // 从任意 { "title": "..." } 模式中提取
          const tMatch = rawResult.match(/\{\s*"title"\s*:\s*"([^"]+)"\s*\}/);
          if (tMatch) { title = tMatch[1]; }
          else {
            const lines = rawResult.split('\n').filter(l => l.trim());
            title = lines[lines.length - 1]?.trim()?.substring(0, 50) || '智能命名';
          }
        }
        this.log(`[VSCodeUI] smartNaming raw response: ${rawResult.substring(0, 500)}`);
        this.log(`[VSCodeUI] smartNaming extracted jsonStr: ${jsonStr || '(null)'}`);
        this.log(`[VSCodeUI] smartNaming result for ${sessionId}: "${title}"`);
        const { updateConversationMetadataTitle: updateTitle } = await import('../core/history/Conversation.js');
        await updateTitle(sessionId, title);
        this.setTitle(sessionId, title);
        this.host.sendToWebview({ type: 'smartNamingResult', sessionId, title } as any);
        const { loadConversationList: loadList } = await import('../core/history/index.js');
        const convs = await loadList();
        this.host.sendToWebview({ type: 'conversationsData', conversations: convs } as any);
      } catch (error: any) {
        this.log(`[VSCodeUI] smartNaming error: ${error.message}`);
      }
    })();
  }

  private async handleExpandCompact(message: any): Promise<void> {
    this.log(`[VSCodeUI] expandCompact requested: ${message.sessionId}`);
    try {
      const { loadCompactArchive } = await import('../core/history/Conversation.js');

      const originalMessages = await loadCompactArchive(message.sessionId);
      if (!originalMessages || originalMessages.length === 0) {
        this.log(`[VSCodeUI] No compact archive found for ${message.sessionId}`);
        return;
      }

      this.log(`[VSCodeUI] Expanding compact: ${originalMessages.length} messages from archive`);

      // 从压缩后的主 JSONL 读取 summary 和保留的最近消息
      let messagesToDisplay: any[] = originalMessages;
      {
        const summaryCount = originalMessages.filter(m => (m as any).isCompactSummary === true).length;
        try {
          const { loadConversation } = await import('../core/history/index.js');
          const conversation = await loadConversation(message.sessionId);
          const compressedSummaries = conversation.messages.filter((m: any) =>
            m.type === 'user' && (m as any).isCompactSummary === true
          );
          // 从压缩后消息中提取"当前未被压缩部分"（保留的最近消息）
          const retainedMessages = conversation.messages.filter((m: any) =>
            (m.type === 'user' || m.type === 'assistant')
            && !(m as any).isCompactSummary
            && !((m as any).subtype === 'compact_boundary')
          );
          this.log(`[VSCodeUI] Archive=${originalMessages.length} (summaries=${summaryCount}), compressed summaries=${compressedSummaries.length}, retained=${retainedMessages.length}`);
          // 顺序：被压缩归档消息 -> 摘要 -> 当前未被压缩部分
          if (summaryCount === 0 && compressedSummaries.length > 0) {
            // 旧归档：从主 JSONL 取 summary
            messagesToDisplay = [...originalMessages, ...compressedSummaries, ...retainedMessages];
          } else {
            // 新归档：归档中已有 summary，只需补充 retainedMessages
            messagesToDisplay = [...originalMessages, ...retainedMessages];
          }
          this.log(`[VSCodeUI] Built display: archive=${originalMessages.length} + retained=${retainedMessages.length}`);
        } catch (err) {
          this.log(`[VSCodeUI] Failed to load data from compressed messages: ${err}`);
        }
      }

      // 清空 webview 当前显示
      this.host.sendToWebview({
        type: 'clearMessages',
        sessionId: message.sessionId,
      } as any);

      // 先扫描所有消息，建立 tool_use_id -> tool_result 的映射
      const toolResultMap = new Map<string, { content: string; exitCode: number }>();
      for (const msg of messagesToDisplay) {
        if (msg.type === 'user' && Array.isArray((msg as any).message?.content)) {
          const toolResults = ((msg as any).message.content as any[]).filter((block: any) => block.type === 'tool_result');
          for (const result of toolResults) {
            const r = result as { tool_use_id?: string; is_canceled?: boolean; content?: string; exit_code?: number };
            if (r.tool_use_id && r.is_canceled !== true) {
              toolResultMap.set(r.tool_use_id, {
                content: r.content || '',
                exitCode: r.exit_code ?? 0,
              });
            }
          }
        }
      }

      // 从归档推送完整消息到 webview 显示（复用 pushCompactMessagesToUI 的转换逻辑）
      // 不修改 JSONL 文件，LLM 仍然只看到压缩后的消息
      for (const msg of messagesToDisplay) {
        const m = msg as any;
        if (m.isMeta || m.silent) continue;

        if (m.type === 'system') {
          if (m.subtype === 'compact_boundary') continue;
          this.postToWebview(message.sessionId, {
            type: 'addMessage',
            role: 'system',
            content: m.content,
          } as any);
        } else if (m.type === 'user') {
          const content = typeof m.message?.content === 'string' ? m.message.content : undefined;
          if (content !== undefined) {
            this.postToWebview(message.sessionId, {
              type: 'addMessage',
              role: 'user',
              content,
              filePath: m.filePath,
              fileSelectedLines: m.fileSelectedLines,
              isCompactSummary: m.isCompactSummary === true,
              isFromAgent: m.fromSubAgent === true,
              meta: m._meta,
            } as any);
          }
        } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
          for (const block of m.message.content) {
            const b = block as any;
            if (b.type === 'thinking') {
              this.postToWebview(message.sessionId, {
                type: 'addMessage',
                role: 'thinking',
                content: b.thinking || '',
              } as any);
            } else if (b.type === 'text') {
              this.postToWebview(message.sessionId, {
                type: 'addMessage',
                role: 'assistant',
                content: b.text || '',
              } as any);
            } else if (b.type === 'tool_use') {
              const toolUseId = b.id || '';
              const result = toolResultMap.get(toolUseId);
              this.postToWebview(message.sessionId, {
                type: 'addMessage',
                role: 'toolcall',
                content: result?.content || '',
                param: `⚙️ ${b.name || 'tool'}`,
                toolName: b.name,
                toolArgs: b.input as Record<string, unknown>,
                toolCallId: toolUseId,
                status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
              } as any);
            }
          }
        }
      }

      // 通知 webview 展开完成（删除展开按钮）
      this.host.sendToWebview({
        type: 'expandCompactDone',
        sessionId: message.sessionId,
      } as any);

      this.log(`[VSCodeUI] Compact expanded for ${message.sessionId}: messages displayed from archive`);
    } catch (err) {
      this.log(`[VSCodeUI] Failed to expand compact for ${message.sessionId}: ${err}`);
    }
  }

  /**
   * 检查服务器负载：时间 + context 大小
   * webview 发送消息前调用，若满足条件则返回红色警告提示
   */
  private async handleCheckServerLoad(message: any): Promise<void> {
    const sessionId = message.sessionId;
    const contextLength = message.contextLength as number;

    // 条件1: 周一~周五
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      this.host.sendToWebview({ type: 'serverLoadResult', showWarning: false, sessionId } as any);
      return;
    }

    // 条件2: 9:30~12:00 或 14:00~18:00
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeMinutes = hour * 60 + minute;
    const morningStart = 9 * 60 + 30;  // 9:30
    const morningEnd = 12 * 60;        // 12:00
    const afternoonStart = 14 * 60;    // 14:00
    const afternoonEnd = 18 * 60;      // 18:00

    const inTimeRange = (timeMinutes >= morningStart && timeMinutes < morningEnd) ||
                        (timeMinutes >= afternoonStart && timeMinutes < afternoonEnd);
    if (!inTimeRange) {
      this.host.sendToWebview({ type: 'serverLoadResult', showWarning: false, sessionId } as any);
      return;
    }

    // 条件3: context 超过 250K
    if (contextLength <= 250_000) {
      this.host.sendToWebview({ type: 'serverLoadResult', showWarning: false, sessionId } as any);
      return;
    }

    // 默认不显示警告
    this.host.sendToWebview({ type: 'serverLoadResult', showWarning: false, sessionId } as any);
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
      shortcut,
      providers, activeProvider: requestedActiveProvider, closeAfterSave,
      saveProviders,
      sessionId: requestedSessionId, currentModel: requestedCurrentModel,
    } = message;

    // 快捷键只由 Electron 设置页提交；校验失败时不写文件，避免保存无效配置
    let normalizedShortcut: string | undefined;
    if (typeof shortcut === 'string') {
      const normalized = normalizeAccelerator(shortcut);
      if (!normalized) {
        this.host.sendToWebview({
          type: 'llmConfigSaveError',
          error: '快捷键无效，请重新设置',
        } as any);
        return;
      }
      normalizedShortcut = normalized;
    }

    this.log(`[VSCodeUI] saveLLMConfig: webSearch=${!!webSearch}, thinkingEffort=${thinkingEffort}, defaultAgentMode=${defaultAgentMode}, defaultPromptMode=${defaultPromptMode}, language=${language}, shortcut=${normalizedShortcut || ''}, saveProviders=${!!saveProviders}, providers=${Array.isArray(providers) ? providers.length : 0}, activeProvider=${requestedActiveProvider || ''}, closeAfterSave=${!!closeAfterSave}, sessionId=${requestedSessionId || ''}, currentModel=${requestedCurrentModel || ''}`);

    try {
      // 串行化写入 settings.json，避免与其他写入口（handleSetModel 等）并发写坏文件
      const { updateSettingsJson } = await import('../core/history/Config.js');
      const keyOf = providerKeyFromBaseURL;
      await updateSettingsJson((cfg: Record<string, any>) => {
        if (!cfg.llm) cfg.llm = {};

        // 有 provider 变更（如编辑模型列表/API 配置）或显式选择「使用此 Provider」时，
        // 保存 llm.providers / llm.activeProvider；普通保存只写默认设置，不修改 provider。
        if (saveProviders && Array.isArray(providers) && providers.length > 0) {
          const providersMap: Record<string, any> = {};
          for (const p of providers) {
            const providerBaseURL = typeof p?.baseURL === 'string' ? p.baseURL.trim() : '';
            const providerApiKey = typeof p?.apiKey === 'string' ? p.apiKey.trim() : '';
            if (!providerBaseURL || !providerApiKey) continue;
            const key = keyOf(providerBaseURL);
            if (!key) continue;
            const providerModels = Array.isArray(p?.models)
              ? Array.from(new Set(
                  (p.models as unknown[])
                    .filter((m): m is string => typeof m === 'string' && !!m.trim())
                    .map((m) => m.trim()),
                ))
              : [];
            // 面板传来的「模型 -> 协议」映射（手动选择或自动探测结果）；
            // 未出现在映射中的模型保持原状（不写入 apiType），以便下次自动获取时继续探测
            const apiTypeOverrides: Record<string, 'Responses' | 'OpenAI' | 'Anthropic'> = {};
            if (p?.modelApiTypes && typeof p.modelApiTypes === 'object' && !Array.isArray(p.modelApiTypes)) {
              for (const [model, apiType] of Object.entries(p.modelApiTypes as Record<string, unknown>)) {
                if (apiType === 'Responses' || apiType === 'OpenAI' || apiType === 'Anthropic') {
                  apiTypeOverrides[model] = apiType;
                }
              }
            }
            // modelConfigs：保留已有 context/output/apiType，缺失的 context/output
            // 从内置注册表匹配补齐；apiType 来自面板（手动选择或自动探测结果）
            const oldProvider = cfg.llm.providers?.[key];
            const oldModelConfigs: Record<string, ModelTokenLimits> = oldProvider?.modelConfigs
              && typeof oldProvider.modelConfigs === 'object'
              ? oldProvider.modelConfigs
              : {};
            const modelConfigs = normalizeModelTokenLimits(providerModels, oldModelConfigs, apiTypeOverrides);
            providersMap[key] = {
              baseURL: providerBaseURL,
              apiKey: providerApiKey,
              models: providerModels,
              modelConfigs,
              ...(typeof p?.defaultModel === 'string' && p.defaultModel.trim()
                ? { defaultModel: p.defaultModel.trim() }
                : {}),
            };
          }
          const keys = Object.keys(providersMap);
          if (keys.length > 0) {
            cfg.llm.providers = providersMap;

            let activeKey = typeof requestedActiveProvider === 'string' ? requestedActiveProvider : '';
            if (!activeKey || !providersMap[activeKey]) {
              activeKey = keys[0];
            }
            cfg.llm.activeProvider = activeKey;
          }
        }

        // 无论本次保存是否修改了 provider，都探测一遍所有 provider 的模型 context/output 配置：
        // 已有值保留，缺失的字段从内置模型注册表匹配补齐（匹配不到则用兜底配置），
        // 保证运行时不会因为缺少限值而回退到全局默认值。
        if (cfg.llm.providers && typeof cfg.llm.providers === 'object') {
          for (const provider of Object.values(cfg.llm.providers as Record<string, any>)) {
            if (!provider || typeof provider !== 'object') continue;
            const models = Array.isArray(provider.models)
              ? (provider.models as unknown[])
                  .filter((m): m is string => typeof m === 'string' && !!m.trim())
                  .map((m) => m.trim())
              : [];
            provider.modelConfigs = normalizeModelTokenLimits(models, provider.modelConfigs);
          }
        }

        // 预设值只在发生变化（或尚不存在）时写入；如果 settings 中已经有相同值，
        // 新建/编辑 Provider 时不再重复写入，避免每次保存都覆盖一遍预设字段。
        if (typeof webSearch === 'boolean' && cfg.llm.webSearch !== webSearch) {
          cfg.llm.webSearch = webSearch;
        }
        if (thinkingEffort && cfg.llm.thinking_effort !== thinkingEffort) {
          cfg.llm.thinking_effort = thinkingEffort;
        }
        // 默认工作模式：顶层字段，与 llm 平级
        if (defaultAgentMode && cfg.defaultAgentMode !== defaultAgentMode) {
          cfg.defaultAgentMode = defaultAgentMode;
        }
        if ((defaultPromptMode === 'normal' || defaultPromptMode === 'minimal' || defaultPromptMode === 'mixed')
          && cfg.defaultPromptMode !== defaultPromptMode) {
          cfg.defaultPromptMode = defaultPromptMode;
        }
        // UI 语言（auto | zh | en）：顶层字段
        if (language === 'zh' || language === 'en' || language === 'auto') {
          const nextUiLanguage = language;
          if (cfg.uiLanguage !== nextUiLanguage) {
            if (nextUiLanguage === 'auto') {
              // auto 是默认值，若当前没有显式配置则无需写入
              if (cfg.uiLanguage !== undefined) {
                delete cfg.uiLanguage;
              }
            } else {
              cfg.uiLanguage = nextUiLanguage;
            }
          }
        }
        // 唤醒快捷键（Electron）：顶层字段，accelerator 形式
        if (normalizedShortcut && cfg.shortcut !== normalizedShortcut) {
          cfg.shortcut = normalizedShortcut;
        }
      });

      // 同步更新 core 层界面语言，使 Spin 等核心流程文案跟随设置
      try {
        if (language === 'zh' || language === 'en' || language === 'auto') {
          const { setCoreUiLanguage } = await import('../core/i18n.js');
          setCoreUiLanguage(language);
        }
      } catch {}

      // MCP 默认启用列表（设置面板「默认配置」）→ 全局 settings.json 的 mcp.enabled。
      // 只改全局默认；各会话在菜单里的勾选存在各自 meta.json，不受影响。
      if (Array.isArray(message.mcpServers)) {
        try {
          const { setDefaultEnabledMcps } = await import('../core/mcp/Config.js');
          await setDefaultEnabledMcps(
            (message.mcpServers as unknown[]).filter((n): n is string => typeof n === 'string'),
          );
          const mcpSessionId = await this.getActiveMcpSessionId(requestedSessionId);
          // 先回推一次：默认值已落盘，连接尚未开始 → webview 显示「连接中」。
          // 这样设置面板保存不会被 MCP 启动阻塞，可以立即返回 llmConfigSaved。
          await this.pushMcpServers(mcpSessionId);
          // 连接动作放到后台异步执行：默认值变化会影响所有「没有会话覆盖」的已打开会话，
          // 因此对所有已注册会话重新对齐引用，而不只是当前活动会话。
          void (async () => {
            try {
              const { getMcpManager } = await import('../core/mcp/Manager.js');
              await getMcpManager().syncAllSessions();
              await getMcpManager().acquire(mcpSessionId);
              await this.pushMcpServers(mcpSessionId);
            } catch (err: any) {
              this.log(`[VSCodeUI] Failed to sync MCP after default change: ${err.message}`);
            }
          })();
        } catch (err: any) {
          this.log(`[VSCodeUI] Failed to save default MCP enabled list: ${err.message}`);
        }
      }

      this.log(`[VSCodeUI] LLM config saved successfully`);

      // 清除 config.ts 中的缓存，下次 getConfig 能读到新配置
      // （updateSettingsJson 内部已清除 Config.ts 的 cachedSettings）
      try {
        const { clearConfigCache } = await import('../core/llm/config.js');
        clearConfigCache();
      } catch {}

      // 读取保存后的实际默认值，随 llmConfigSaved 回传给 webview，
      // webview 据此更新本地的默认值并应用到当前对话（如默认工作模式）
      let savedModel = '';
      let savedThinkingEffort: 'off' | 'low' | 'high' | 'max' = 'off';
      let savedAgentMode: 'manual' | 'risk' | 'auto' = 'risk';
      let savedPromptMode: 'normal' | 'minimal' | 'mixed' = 'normal';
      let savedWebSearch = false;
      let savedActiveProvider = '';
      let savedProviderModels: string[] = [];
      try {
        const { getDefaultModel, getDefaultThinkingEffort, getDefaultAgentMode, getDefaultPromptMode, getDefaultWebSearch, getLLMConfigPanelPayload } = await import('../core/llm/config.js');
        [savedModel, savedThinkingEffort, savedAgentMode, savedPromptMode, savedWebSearch] = await Promise.all([
          getDefaultModel(),
          getDefaultThinkingEffort(),
          getDefaultAgentMode(),
          getDefaultPromptMode(),
          getDefaultWebSearch(),
        ]);
        const payload = await getLLMConfigPanelPayload();
        savedActiveProvider = payload.activeProvider;
        savedProviderModels = payload.providers.find((p) => p.key === savedActiveProvider)?.models || [];
      } catch {}

      // 切换 provider 后校验当前会话模型：若不在新 provider 的模型列表中，
      // 回退到新 provider 的默认模型，并持久化到会话 meta.json、同步引擎配置。
      // 返回给 webview 的 activeModel 用于刷新当前对话的模型选择（含已有消息的对话）。
      let activeModel = '';
      try {
        const { getActiveSessionId } = await import('../core/history/Config.js');
        const currentSessionId = (typeof requestedSessionId === 'string' && requestedSessionId) || getActiveSessionId();
        if (currentSessionId && currentSessionId !== 'undefined') {
          // 优先使用 webview 回传的当前模型（最贴近界面显示），
          // 其次读取该会话 meta.json 中保存的模型。
          let sessionModel = typeof requestedCurrentModel === 'string' ? requestedCurrentModel.trim() : '';
          if (!sessionModel) {
            try {
              const { loadConversation } = await import('../core/history/index.js');
              const conversation = await loadConversation(currentSessionId);
              sessionModel = conversation?.metadata?.model || conversation?.metadata?.context?.model || '';
            } catch { /* 新对话可能还没有 meta.json */ }
          }
          const { resolveModelForActiveProvider } = await import('../core/llm/config.js');
          const resolved = await resolveModelForActiveProvider(sessionModel || savedModel);
          if (resolved) {
            activeModel = resolved;
            if (sessionModel && resolved !== sessionModel) {
              this.log(`[VSCodeUI] Current session model "${sessionModel}" is not in active provider model list, fallback to "${resolved}"`);
              const { updateConversationContext } = await import('../core/history/index.js');
              await updateConversationContext(currentSessionId, { model: resolved });
            }
            const { setSessionModel } = await import('../core/Integration.js');
            setSessionModel(currentSessionId, resolved);
          }
        }
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to resolve active model after save: ${err.message}`);
      }

      // 保存后立即刷新主界面的模型下拉列表：有模型列表时用模型列表，否则回退内置模型
      const builtinModels = MODEL_CONFIGS.map((cfg) => cfg.name);
      const baseModels = savedProviderModels.length > 0 ? savedProviderModels : builtinModels;
      const modelList = Array.from(new Set([...baseModels, ...(savedModel ? [savedModel] : []), ...(activeModel ? [activeModel] : [])]));
      this.host.sendToWebview({ type: 'setModels', models: modelList } as any);

      // 通知 webview 保存成功
      this.host.sendToWebview({
        type: 'llmConfigSaved',
        defaultModel: savedModel,
        activeModel,
        thinkingEffort: savedThinkingEffort,
        defaultAgentMode: savedAgentMode,
        defaultPromptMode: savedPromptMode,
        webSearch: savedWebSearch,
        ...(language === 'zh' || language === 'en' || language === 'auto' ? { language } : {}),
        ...(normalizedShortcut ? { shortcut: normalizedShortcut } : {}),
        activeProvider: savedActiveProvider,
        closeAfterSave: !!closeAfterSave,
      });
    } catch (err) {
      this.log(`[VSCodeUI] Failed to save LLM config: ${err}`);
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
      const { getDefaultModel, getDefaultThinkingEffort, getDefaultAgentMode, getDefaultPromptMode, getDefaultWebSearch, getLLMConfigPanelPayload } = await import('../core/llm/config.js');
      const [model, thinkingMode, agentMode, promptMode, webSearch, payload] = await Promise.all([
        getDefaultModel(),
        getDefaultThinkingEffort(),
        getDefaultAgentMode(),
        getDefaultPromptMode(),
        getDefaultWebSearch(),
        getLLMConfigPanelPayload(),
      ]);
      const providerConfigured = !!payload.activeProvider && !!payload.apiKey;
      this.host.sendToWebview({
        type: 'settingsDefaults',
        model,
        thinkingMode,
        agentMode,
        promptMode,
        webSearch,
        language: this.getUiLanguageFromSettings(),
        providerConfigured,
      });
      this.log(`[VSCodeUI] Sent settings defaults: model=${model}, thinkingMode=${thinkingMode}, agentMode=${agentMode}, promptMode=${promptMode}, webSearch=${webSearch}, providerConfigured=${providerConfigured}`);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to send settings defaults: ${err.message}`);
    }
  }

  /** 从 settings.json 读取 UI 语言（同步，供消息回传使用） */
  private getUiLanguageFromSettings(): 'auto' | 'zh' | 'en' {
    try {
      const { readUiLanguageSync } = require('../core/history/Config.js') as typeof import('../core/history/Config.js');
      return readUiLanguageSync();
    } catch {
      return 'auto';
    }
  }

  /**
   * 处理来自 webview 的对话空间统计请求
   */
  private async handleRequestConversationSpaces(): Promise<void> {
    this.log(`[VSCodeUI] requestConversationSpaces`);
    try {
      const { getConversationSpaces } = await import('../core/history/ConversationSpace.js');
      const spaces = await getConversationSpaces();
      this.host.sendToWebview({ type: 'conversationSpacesData', spaces } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to get conversation spaces: ${err.message}`);
      this.host.sendToWebview({
        type: 'conversationSpacesError',
        error: `统计对话空间失败: ${err.message}`,
      } as any);
    }
  }

  /**
   * 处理来自 webview 的对话空间清空请求
   */
  private async handleClearConversationSpace(message: any): Promise<void> {
    const dirName = typeof message.dirName === 'string' ? message.dirName : '';
    this.log(`[VSCodeUI] clearConversationSpace: ${dirName}`);
    try {
      const { clearConversationSpace } = await import('../core/history/ConversationSpace.js');
      const result = await clearConversationSpace(dirName);
      this.log(`[VSCodeUI] Conversation space cleared: ${dirName} (${result.removedFiles} files, ${result.removedBytes} bytes)`);

      this.host.sendToWebview({
        type: 'conversationSpaceCleared',
        dirName,
        removedFiles: result.removedFiles,
        removedBytes: result.removedBytes,
      } as any);

      // 清空后立即刷新统计，让界面显示最新大小
      try {
        const { getConversationSpaces } = await import('../core/history/ConversationSpace.js');
        const spaces = await getConversationSpaces();
        this.host.sendToWebview({ type: 'conversationSpacesData', spaces } as any);
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to refresh conversation spaces after clear: ${err.message}`);
      }

      // 同时刷新当前项目的对话列表，避免侧栏继续显示已删除的会话
      try {
        const { loadConversationList } = await import('../core/history/index.js');
        const conversations = await loadConversationList();
        this.host.sendToWebview({ type: 'conversationsData', conversations } as any);
      } catch (err: any) {
        this.log(`[VSCodeUI] Failed to refresh conversation list after clear: ${err.message}`);
      }
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to clear conversation space ${dirName}: ${err.message}`);
      this.host.sendToWebview({
        type: 'conversationSpacesError',
        error: `清空对话空间失败: ${err.message}`,
      } as any);
    }
  }

  /**
   * 处理来自 webview 的 LLM 配置读取请求（用户点击设置按钮时触发）
   * 读取 settings.json 并回传 showLLMConfig，由 webview 打开配置面板
   */
  private async handleRequestLLMConfig(message: any): Promise<void> {
    // 设置面板只在「点开设置的那个端」打开：带上发起端的 sessionId / clientId 做定向回推，
    // 不带则会被广播到所有浏览器端（req: 设置页面不要同步到其它端打开）
    const route = {
      sessionId: message?.sessionId,
      clientId: message?.clientId,
    };
    try {
      const { getLLMConfigPanelPayload } = await import('../core/llm/config.js');
      const { readMcpServersForDefaults } = await import('../core/mcp/Config.js');
      // 设置面板编辑的是「全局默认」，因此这里给的是全局默认的启用状态
      const [payload, mcpServers] = await Promise.all([
        getLLMConfigPanelPayload(),
        readMcpServersForDefaults(),
      ]);
      this.host.sendToWebview({
        type: 'showLLMConfig',
        ...payload,
        mcpServers,
        language: this.getUiLanguageFromSettings(),
        ...route,
      });
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to read LLM config: ${err.message}`);
      // 读取失败时仍然打开面板，使用首次设置的预置值（允许联网、thinking=high、flash、关键模式）
      this.host.sendToWebview({
        type: 'showLLMConfig',
        baseURL: 'https://api.deepseek.com',
        webSearch: true,
        thinkingEffort: 'high',
        defaultModel: 'deepseek-v4-flash',
        defaultAgentMode: 'risk',
        defaultPromptMode: 'normal',
        apiKey: '',
        providers: [{ key: 'api.deepseek.com', baseURL: 'https://api.deepseek.com', apiKey: '', models: [], modelConfigs: {} }],
        activeProvider: '',
        language: this.getUiLanguageFromSettings(),
        shortcut: DEFAULT_WAKE_SHORTCUT,
        mcpServers: [],
        ...route,
      });
    }
  }

}

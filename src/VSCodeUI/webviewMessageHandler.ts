/**
 * VSCodeUI/webviewMessageHandler.ts - WebView 消息处理
 * 接收和处理来自 webview 的所有消息
 */
import type { UIHost } from '../host/UIHost.js';
import { fetch as undiciFetch } from 'undici';
import { logger } from '../core/Logger.js';
import { getLLMDispatcher } from '../core/llm/httpDispatcher.js';
import { getPendingToolUseIds } from '../core/tools/index.js';
import { providerKeyFromBaseURL } from '../core/utils/providerKey.js';
import { buildEditDiffHunks } from '../core/utils/editDiff.js';
import { buildUserContent, extractUserContent } from '../core/utils/contentBlocks.js';
import { MODEL_CONFIGS, normalizeModelTokenLimits, type ModelTokenLimits } from '../core/utils/modelConfig.js';
import { DEFAULT_WAKE_SHORTCUT, normalizeAccelerator } from '../core/utils/shortcut.js';
import { userChoiceQueue } from '../core/UserChoiceQueue.js';
import type { WebviewMessage } from '../core/webviewTypes.js';
import type { Message } from '../core/types.js';
import type { UserChoiceManager } from './userChoice.js';

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
      const isQueueMessage = message.type === 'queueMessage' || engine.isConsumerRunning;

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

      // 与 Integration.sendMessage 路径保持一致，记录到提示词历史
      try {
        const { addToHistory } = await import('../core/history/index.js');
        if (content.trim()) {
          addToHistory(content);
        }
      } catch { /* 历史记录失败不阻塞消息发送 */ }

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
    const { filePath, selectedLines } = message;
    this.log(`[VSCodeUI] openFile: ${filePath} ${JSON.stringify(selectedLines)}`);

    if (filePath) {
      try {
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
    const { content, title } = message;
    this.log(`[VSCodeUI] showVirtualDocument: ${title}`);
    await this.host.showVirtualDocument(content, title);
  }

  private async handleShowDiffInVirtualDocument(message: any): Promise<void> {
    const { filePath, newContent, title, beforeContent, afterContent } = message;
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
    logger.info("handleWebviewMessage", `Set active session from webview: ${message.sessionId}`);
    // 切换会话时查询余额
    this.fetchBalanceAndSend(message.sessionId);
  }

  private async handleLoadConversation(message: any): Promise<void> {
    this.log(`[VSCodeUI] loadConversation requested: ${message.sessionId}`);

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
      // 会话没有保存工作模式时，使用 settings.json 中的默认工作模式
      let defaultAgentMode: 'manual' | 'risk' | 'auto' = 'manual';
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
      agentMode: this.sessionAgentModes.get(message.sessionId) ?? 'manual',
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
    this.setTitle(newSessionId, defaultTitle());
    // 新对话开始时查询余额
    this.fetchBalanceAndSend(newSessionId);

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
      const [hasActiveProvider, payload] = await Promise.all([
        hasActiveProviderSetting(),
        getLLMConfigPanelPayload(),
      ]);
      if (!hasActiveProvider || !payload.apiKey) {
        this.host.sendToWebview({
          type: 'showLLMConfig',
          ...payload,
          language: this.getUiLanguageFromSettings(),
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

      let needsNewSession = currentActiveSessionId === deletedSessionId;
      if (!needsNewSession) {
        const allConversations = await loadConversationList();
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

      await deleteConversation(deletedSessionId);
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
      const apiType = activeProvider?.apiType === 'Anthropic' ? 'Anthropic' : 'Responses';
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
        const fetched = await this.fetchModelsFromProvider(baseURL, apiType, apiKey);
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

  /** 处理设置页的「自动获取模型」请求 */
  private async handleFetchProviderModels(message: any): Promise<void> {
    const baseURL = typeof message?.baseURL === 'string' ? message.baseURL.trim() : '';
    const apiKey = typeof message?.apiKey === 'string' ? message.apiKey.trim() : '';
    const apiType = message?.apiType === 'Anthropic' ? 'Anthropic' : 'Responses';
    if (!baseURL || !apiKey) {
      this.host.sendToWebview({ type: 'providerModelsResult', models: [] } as any);
      return;
    }
    try {
      this.log(`[VSCodeUI] Fetching provider models from ${baseURL}`);
      const models = await this.fetchModelsFromProvider(baseURL, apiType, apiKey);
      this.host.sendToWebview({ type: 'providerModelsResult', models } as any);
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to fetch provider models: ${err.message}`);
      this.host.sendToWebview({ type: 'providerModelsResult', models: [] } as any);
    }
  }

  /** 从服务商拉取模型列表（兼容 /v1/models 与 /models，兼容 data[].id / data[].model / string） */
  private async fetchModelsFromProvider(baseURL: string, apiType: 'Anthropic' | 'Responses', apiKey: string): Promise<string[]> {
    const trimmed = baseURL.replace(/\/+$/, '');
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    if (apiType === 'Anthropic') {
      headers['x-api-key'] = apiKey;
    }
    const candidateUrls = [
      `${trimmed}/v1/models`,
      `${trimmed}/models`,
    ];
    for (const url of candidateUrls) {
      try {
        const response = await undiciFetch(url, { headers, dispatcher: getLLMDispatcher() });
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
            // modelConfigs：保留已有 context/output，缺失的字段从内置注册表匹配补齐
            const oldProvider = cfg.llm.providers?.[key];
            const oldModelConfigs: Record<string, ModelTokenLimits> = oldProvider?.modelConfigs
              && typeof oldProvider.modelConfigs === 'object'
              ? oldProvider.modelConfigs
              : {};
            const modelConfigs = normalizeModelTokenLimits(providerModels, oldModelConfigs);
            providersMap[key] = {
              baseURL: providerBaseURL,
              apiKey: providerApiKey,
              apiType: p?.apiType === 'Anthropic' ? 'Anthropic' : 'Responses',
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
      let savedAgentMode: 'manual' | 'risk' | 'auto' = 'manual';
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
  private async handleRequestLLMConfig(_message: any): Promise<void> {
    try {
      const { getLLMConfigPanelPayload } = await import('../core/llm/config.js');
      const payload = await getLLMConfigPanelPayload();
      this.host.sendToWebview({
        type: 'showLLMConfig',
        ...payload,
        language: this.getUiLanguageFromSettings(),
      });
    } catch (err: any) {
      this.log(`[VSCodeUI] Failed to read LLM config: ${err.message}`);
      // 读取失败时仍然打开面板，使用首次设置的预置值（允许联网、thinking=high、flash、手动模式）
      this.host.sendToWebview({
        type: 'showLLMConfig',
        baseURL: 'https://api.deepseek.com',
        apiType: 'Responses',
        webSearch: true,
        thinkingEffort: 'high',
        defaultModel: 'deepseek-v4-flash',
        defaultAgentMode: 'manual',
        defaultPromptMode: 'normal',
        apiKey: '',
        providers: [{ key: 'api.deepseek.com', baseURL: 'https://api.deepseek.com', apiKey: '', apiType: 'Responses', models: [] }],
        activeProvider: '',
        language: this.getUiLanguageFromSettings(),
        shortcut: DEFAULT_WAKE_SHORTCUT,
      });
    }
  }

}

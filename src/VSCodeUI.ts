/**
 * VSCodeUI - Singleton 管理 VSCode UI 交互
 * 实现 AssistantUI 接口，负责 core 层和 webview 之间的通信桥接
 *
 * 已拆分为以下模块:
 *   - types.ts: 接口定义
 *   - userChoice.ts: UserChoiceQueue 管理 (UserChoiceManager)
 *   - toolHandler.ts: 工具调用处理 (ToolHandler)
 *   - documentManager.ts: 文档/Diff/预览管理 (DocumentManager)
 *   - webviewMessageHandler.ts: WebView 消息处理 (WebviewMessageHandler)
 */

import * as vscode from 'vscode';
import type { AssistantUI } from './core/AssistantUI.js';
import type { MessageData, StreamMessageData, StreamEndData, UIDynamicInfo } from './core/AssistantUI.js';
import type { ToolProgressData } from './core/tools/Tool.js';
import type { WebviewMessage, ValidationRule } from './core/webviewTypes.js';
import type { UIHost } from './host/UIHost.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from './host/mermaidHtml.js';
import { tt, getSystemLocale } from './core/i18n.js';
import { readUiLanguageSync } from './core/history/Config.js';
import { MERMAID_PANEL_ID, SPIN_DESIGN_PANEL_ID } from './config/project.js';
import { replayMessagesToUI } from './core/utils/replayMessages.js';
import type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent } from './VSCodeUI/types.js';
import { UserChoiceManager } from './VSCodeUI/userChoice.js';
import { DocumentManager } from './VSCodeUI/documentManager.js';
import { buildDiffUris } from './VSCodeUI/diffUris.js';
import { ToolHandler } from './VSCodeUI/toolHandler.js';
import { WebviewMessageHandler } from './VSCodeUI/webviewMessageHandler.js';

export type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent };

export class VSCodeUI implements AssistantUI {
  private static outputChannel: vscode.OutputChannel | undefined;
  private static instance: VSCodeUI | undefined;
  private webviewView: vscode.WebviewView | undefined;
  /** 按 session 保存的 agent mode */
  private sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'> = new Map();
  private _windowStateRegistered: boolean = false;

  // 子模块
  private userChoiceManager: UserChoiceManager;
  private documentManager: DocumentManager;
  private toolHandler: ToolHandler;
  private webviewMessageHandler: WebviewMessageHandler;
  private extensionUri: vscode.Uri = vscode.Uri.file('');

  constructor() {
    // 先初始化子模块（需要引用 postToWebview 等方法）
    this.userChoiceManager = new UserChoiceManager({
      outputChannel: VSCodeUI.outputChannel,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      closePreview: () => this.closePreview(),
      getActiveSessionIdInternal: () => this.getActiveSessionIdInternal(),
      onShowDiffInVirtualDocumentCallback: undefined, // 稍后设置
      buildDiffUris: (title) => buildDiffUris(title),
      showPasswordInput: async (prompt, plainText) => {
        const result = await vscode.window.showInputBox({
          prompt,
          password: !plainText,
          ignoreFocusOut: true,
          placeHolder: plainText ? '请输入' : '请输入API密钥',
        });
        return result || null;
      },
      hasWebview: () => !!this.webviewView,
    });

    this.documentManager = new DocumentManager(VSCodeUI.outputChannel);

    this.toolHandler = new ToolHandler({
      outputChannel: VSCodeUI.outputChannel,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      sessionAgentModes: this.sessionAgentModes,
      userChoiceManager: this.userChoiceManager,
    });

    this.webviewMessageHandler = new WebviewMessageHandler({
      host: this.buildHost(),
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      postConversationLoaded: (sessionId, conversation, extra) =>
        this.postConversationLoaded(sessionId, conversation, extra),
      setTitle: (sessionID, title) => this.setTitle(sessionID, title),
      sessionAgentModes: this.sessionAgentModes,
      userChoiceManager: this.userChoiceManager,
    });

    // 初始化 UserChoiceQueue 回调
    this.userChoiceManager.initUserChoiceQueue();
  }

  /**
   * 构建宿主能力实现（vscode 版）
   * 供共享的 WebviewMessageHandler 使用，将 vscode API 收敛到此处
   */
  private buildHost(): UIHost {
    return {
      sendToWebview: (message) => {
        this.webviewView?.webview.postMessage(message as WebviewMessage);
      },
      openFile: async (filePath, selectedLines) => {
        const uri = vscode.Uri.file(filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        if (selectedLines) {
          const startLine = selectedLines.start - 1;
          const endLine = selectedLines.end - 1;
          const start = new vscode.Position(startLine, 0);
          const end = new vscode.Position(endLine, editor.document.lineAt(endLine).text.length);
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
      },
      showVirtualDocument: async (content: string, title: string) => {
        const callback = (this.documentManager as any).onShowContentInVirtualDocumentCallback;
        if (typeof callback === 'function') {
          await callback({ content, title });
        } else {
          VSCodeUI.outputChannel?.appendLine('[VSCodeUI] Warning: No callback registered for showVirtualDocument');
        }
      },
      showDiff: async (options) => {
        await this.documentManager.showDiff(options as any);
      },
      openMermaidPreview: async (code) => {
        this.openMermaidPreviewPanel(code);
      },
      openSpinDesign: async () => {
        await this.openSpinDesignPanel();
      },
      openExternalUrl: async (url) => {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (err) {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to open external URL: ${err}`);
        }
      },
      isDarkTheme: () => {
        const kind = vscode.window.activeColorTheme.kind;
        return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
      },
      getLocale: () => vscode.env.language,
      log: (...args) => {
        VSCodeUI.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
      },
    };
  }

  /** 创建或复用 Mermaid 预览面板 */
  private openMermaidPreviewPanel(code: string): void {
    const panelId = MERMAID_PANEL_ID;
    const existingPanel = vscode.window.tabGroups.all
      .flatMap(tg => tg.tabs)
      .find(tab => (tab.input as any)?.viewType === panelId);

    let panel: vscode.WebviewPanel;
    if (existingPanel) {
      panel = (existingPanel.input as any).webviewPanel as vscode.WebviewPanel;
      panel.reveal();
    } else {
      panel = vscode.window.createWebviewPanel(
        panelId,
        'Mermaid Preview',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets'),
          ],
        }
      );
    }

    // 获取本地 mermaid.min.js 的 webview URI
    const mermaidUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'mermaid.min.js')
    );

    try {
      panel.webview.html = getMermaidPreviewHtml(code, mermaidUri.toString(), this.buildHost().isDarkTheme());
    } catch (err) {
      VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Mermaid preview error: ${err}`);
      panel.webview.html = getMermaidErrorHtml(code, String(err));
    }
  }

  /** 创建或复用 Spin 设计面板 */
  private async openSpinDesignPanel(): Promise<void> {
    const panelId = SPIN_DESIGN_PANEL_ID;
    const existingPanel = vscode.window.tabGroups.all
      .flatMap(tg => tg.tabs)
      .find(tab => (tab.input as any)?.viewType === panelId);

    let panel: vscode.WebviewPanel;
    if (existingPanel) {
      panel = (existingPanel.input as any).webviewPanel as vscode.WebviewPanel;
      panel.reveal();
      return;
    }

    panel = vscode.window.createWebviewPanel(
      panelId,
      tt('Spin 设计', 'Spin Design'),
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    // 读取已存在的 spin.json（从 ~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/）
    let existingData: any = null;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const { getProjectConversationDir } = await import('./core/history/Config.js');
      const path = require('path') as typeof import('path');
      const projectDir = getProjectConversationDir(workspaceFolders[0].uri.fsPath);
      const spinJsonPath = path.join(projectDir, 'spin.json');
      const fs = require('fs');
      try {
        if (fs.existsSync(spinJsonPath)) {
          const content = fs.readFileSync(spinJsonPath, 'utf-8');
          existingData = JSON.parse(content);
        }
      } catch {
        // 文件不存在或解析失败，忽略
      }
    }

    const { getSpinDesignHtml } = await import('./VSCodeUI/spinDesignHtml.js');
    const isDark = this.buildHost().isDarkTheme();
    panel.webview.html = getSpinDesignHtml(existingData, isDark, this.buildHost().getLocale(), getSystemLocale(), readUiLanguageSync());

    // 监听来自 spin design webview 的消息
    panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === 'saveSpinDesign' && msg.data) {
        if (workspaceFolders && workspaceFolders.length > 0) {
          const { getProjectConversationDir } = await import('./core/history/Config.js');
          const projectDir = getProjectConversationDir(workspaceFolders[0].uri.fsPath);
          const data = { ...msg.data, meta: msg.data.meta || {} };
          // 确保目录存在
          const fs = require('fs');
          if (!fs.existsSync(projectDir)) {
            fs.mkdirSync(projectDir, { recursive: true });
          }
          try {
            // 串行写入 spin.json，避免与 SpinLoop 的 updateNodeMeta 并发
            // "读-改-写"导致清除结果被回写（保存不生效）
            const { writeSpinJsonQueued } = await import('./core/spin/Engine.js');
            await writeSpinJsonQueued(workspaceFolders[0].uri.fsPath, data);
            panel?.webview.postMessage({ type: 'spinSaveResult', success: true });
          } catch (err) {
            VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] spin.json save failed: ${err}`);
            panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: String(err) });
          }
        } else {
          panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
        }
      }
    });
  }

  /**
   * 获取当前的活跃 session ID（从内存缓存读取）
   */
  private getActiveSessionIdInternal(): string | undefined {
    try {
      const configModule = require('./core/history/Config.js') as typeof import('./core/history/Config.js');
      return configModule.getActiveSessionId();
    } catch {
      return undefined;
    }
  }

  static getInstance(): VSCodeUI {
    if (!VSCodeUI.instance) {
      VSCodeUI.instance = new VSCodeUI();
    }
    return VSCodeUI.instance;
  }

  static setOutputChannel(outputChannel: vscode.OutputChannel): void {
    VSCodeUI.outputChannel = outputChannel;
  }

  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
  }

  private log(...args: unknown[]): void {
    VSCodeUI.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
  }

  setWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
  }

  /**
   * 注册 VS Code 窗口状态变化监听器
   */
  registerWindowStateListener(_context: vscode.ExtensionContext): void {
    if (this._windowStateRegistered) {
      return;
    }
    this._windowStateRegistered = true;
    // 不再注册任何监听器
  }

  /**
   * 设置显示内容虚拟文档的回调
   */
  setShowContentInVirtualDocumentCallback(callback: (event: ShowContentInVirtualDocumentEvent) => void | Promise<void>): void {
    this.documentManager.setShowContentCallback(callback);
  }

  /**
   * 设置显示 diff 虚拟文档的回调
   */
  setShowDiffInVirtualDocumentCallback(callback: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>): void {
    this.documentManager.setShowDiffCallback(callback);
    this.userChoiceManager.setShowDiffCallback(callback);
  }

  /**
   * 获取当前工作区路径
   */
  getWorkspacePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      return workspaceFolders[0].uri.fsPath;
    }
    return undefined;
  }

  /**
   * 发送消息到 webview
   */
  private postToWebview(sessionId: string, message: Record<string, unknown>, silent: boolean = false): void {
    void silent;
    const msgWithSession = { ...message, sessionId };
    try {
      this.webviewView?.webview.postMessage(msgWithSession as WebviewMessage);
    } catch (err) {
      VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] postToWebview error: ${err}`);
    }
  }

  /**
   * 发送对话加载消息到 webview
   */
  private postConversationLoaded(
    sessionId: string,
    conversation: any,
    extra: {
      pendingToolUseIds: string[];
      savedContext?: any;
      parentSessionId?: string;
      agentMode: string;
      hasActiveQuery: boolean;
      hasCompactArchive?: boolean;
      model?: string;
    },
  ): void {
    const trimmed = JSON.parse(JSON.stringify(conversation));
    const toolMetaMap: Record<string, any> = {};

    if (trimmed.messages) {
      // 过滤掉 isMeta/silent 消息（如 Skill 注入的 prompt），不在 UI 显示
      trimmed.messages = trimmed.messages.filter(
        (msg: any) => !msg.isMeta && !msg.silent
      );

      for (const msg of trimmed.messages) {
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use' && block._meta) {
              block._metaTrimmed = true;
              block._toolUseId = block.id;
              const { beforeContent, afterContent, ...smallFields } = block._meta;
              block._meta = smallFields;
              toolMetaMap[block.id!] = { beforeContent, afterContent };
            }
          }
        }
      }
    }

    this.webviewView?.webview.postMessage({
      type: 'conversationLoaded',
      conversation: trimmed,
      pendingToolUseIds: extra.pendingToolUseIds,
      savedContext: extra.savedContext,
      parentSessionId: extra.parentSessionId,
      agentMode: extra.agentMode,
      hasActiveQuery: extra.hasActiveQuery,
      sessionId,
      hasCompactArchive: extra.hasCompactArchive === true,
      toolMetaMap: Object.keys(toolMetaMap).length > 0 ? toolMetaMap : undefined,
      model: extra.model || trimmed.metadata?.model ||
        (trimmed.metadata?.context?.model) ||
        undefined,
    } as WebviewMessage);
  }

  /**
   * 关闭当前打开的预览文档
   * 同时清理 documentManager 和 userChoiceManager 中的预览状态
   */
  closePreview(): void {
    // 将 userChoiceManager 中记录的 diff 标识同步到 documentManager，
    // 确保 documentManager.closePreview() 能正确关闭通过 user choice 打开的 diff 标签
    if (this.userChoiceManager.currentPreviewUris.length > 0) {
      this.documentManager.currentPreviewUris.push(...this.userChoiceManager.currentPreviewUris);
    }
    this.documentManager.closePreview();
    this.userChoiceManager.resetPreviewState();
  }

  // ===================== AssistantUI 接口实现 =====================

  /**
   * 设置子会话的 agent mode
   * 子代理默认使用 risk 模式，仅当父会话为 auto 时继承 auto（auto > risk > manual）
   */
  onSetAgentMode(parentSessionId: string, childSessionId: string): void {
    const parentMode = this.sessionAgentModes.get(parentSessionId);
    this.sessionAgentModes.set(childSessionId, parentMode === 'auto' ? 'auto' : 'risk');
  }

  /**
   * 工具调用开始前
   */
  async onPreToolCall(
    sessionID: string,
    toolUseId: string,
    toolName: string,
    args: Record<string, any>,
    tool: unknown,
  ): Promise<import('./core/tools/Tool.js').PermissionResult> {
    return this.toolHandler.onPreToolCall(sessionID, toolUseId, toolName, args, tool);
  }

  /**
   * 工具调用开始
   */
  onToolCall(sessionID: string, toolUseId: string, toolName: string): void {
    this.toolHandler.onToolCall(sessionID, toolUseId, toolName);
  }

  /**
   * 工具调用结果
   */
  onToolResult(sessionID: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void {
    this.toolHandler.onToolResult(sessionID, toolUseId, toolName, output, status);
  }

  /**
   * 更新已存在工具卡片的参数（如 WebSearch 卡片补全搜索词/URL）
   */
  updateToolArgs(sessionID: string, toolUseId: string, args: Record<string, unknown>): void {
    this.postToWebview(sessionID, {
      type: 'updateToolArgs',
      toolCallId: toolUseId,
      toolArgs: args,
    } as any, true /* silent: 参数更新频繁，跳过日志 */);
  }

  /**
   * 工具执行进度（流式输出）
   * Bash 运行期间实时推送已累积输出到 webview，实现流式显示
   */
  onToolProgress(sessionID: string, toolUseId: string, progress: ToolProgressData): void {
    const p = progress as ToolProgressData & {
      output?: string;
      fullOutput?: string;
      elapsedTimeSeconds?: number;
      totalLines?: number;
      totalBytes?: number;
      taskId?: string;
    };

    // 流式输出可能非常大，限制单次发送大小，仅保留尾部（最新的输出）
    const STREAM_CAP_CHARS = 100_000;
    let streamed = p.fullOutput || p.output || '';
    if (streamed.length > STREAM_CAP_CHARS) {
      streamed = streamed.slice(-STREAM_CAP_CHARS);
    }

    this.postToWebview(sessionID, {
      type: 'toolProgress',
      toolCallId: toolUseId,
      output: streamed,
      isStreaming: true,
      elapsedTimeSeconds: p.elapsedTimeSeconds,
      totalLines: p.totalLines,
      totalBytes: p.totalBytes,
      taskId: p.taskId,
    } as any, true /* silent: 流式输出每 chunk 打印一次太频繁，跳过日志 */);
  }

  /**
   * 发送消息到 webview
   */
  onMessage(sessionID: string, data: MessageData): void {
    this.postToWebview(sessionID, {
      type: 'addMessage',
      ...data,
    });
  }

  /**
   * 流式消息增量更新
   */
  onStreamMessage(sessionID: string, data: StreamMessageData): void {
    if (data.role === 'assistant' && data.accumulated && !data.accumulated.trim()) {
      return;
    }
    this.postToWebview(sessionID, {
      type: 'streamMessage',
      role: data.role,
      delta: data.delta,
      accumulated: data.accumulated,
      streamId: data.streamId,
    }, true /* silent: 流式消息每 token 打印一次太频繁，跳过日志 */);
  }

  /**
   * 流结束通知
   */
  onStreamEnd(sessionID: string, data: StreamEndData): void {
    this.postToWebview(sessionID, {
      type: 'streamEnd',
      role: data.role,
      accumulated: data.accumulated,
      usage: data.usage,
      streamId: data.streamId,
    });
  }

  /**
   * 显示/隐藏 thinking 动画
   */
  setThinkingAnimation(sessionID: string, show: boolean): void {
    this.postToWebview(sessionID, {
      type: 'showThinkingAnimation',
      show,
    }, true /* silent: 切换频繁，不记录日志 */);
  }

  /**
   * 设置中止按钮状态
   */
  setEnableAbort(enable: boolean): void {
    this.webviewView?.webview.postMessage({
      type: 'setEnableAbort',
      enable,
    });
  }

  /**
   * 通知用户中止操作
   */
  onAbort(_sessionID: string): void {
    this.webviewView?.webview.postMessage({
      type: 'abort',
    });
  }

  /**
   * 设置当前对话标题
   */
  setTitle(sessionID: string, title: string): void {
    this.postToWebview(sessionID, {
      type: 'setTitle',
      title,
    });

    // NodeRegistry (Redis-based) removed
  }

  /**
   * 新会话创建通知
   */
  onSessionCreated(sessionID: string): void {
    this.postToWebview(sessionID, {
      type: 'initSessionState',
    });
  }

  /**
   * 刷新对话列表并推送到 webview
   * 用于子代理创建等场景：新子会话的 meta.json 创建后，通知 webview 重新加载
   * 对话列表，使子对话能在树形结构中正确显示并关联到主对话。
   */
  async refreshConversationList(): Promise<void> {
    try {
      const { loadConversationList } = await import('./core/history/index.js');
      const conversations = await loadConversationList();
      this.webviewView?.webview.postMessage({
        type: 'conversationsData',
        conversations,
      });
    } catch (err) {
      VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to refresh conversation list: ${err}`);
    }
  }

  /**
   * AI 开始处理
   */
  onAIBegin(sessionID: string): void {
    this.setThinkingAnimation(sessionID, true);
    this.postToWebview(sessionID, {
      type: 'aiBegin',
    });
  }

  /**
   * AI 处理结束（每轮 LLM 调用后触发）
   */
  onAIEnd(sessionID: string): void {
    this.setThinkingAnimation(sessionID, false);
    this.postToWebview(sessionID, {
      type: 'aiEnd',
    });
    // 每轮 LLM 调用后刷新余额
    this.fetchAndSendBalance(sessionID);
  }

  /**
   * 每个 session 当前处于"查询进行中"的计数。
   * 同一 session 可能被多个调用方同时标记 begin（主 sendMessage、排队消息 manageQueryUI、
   * enqueueAgentMessage 后台 consumer、子代理等），用计数去重，保证一次查询只发一次 queryBegin/queryEnd。
   */
  private queryActiveCounts: Map<string, number> = new Map();

  /**
   * 查询开始
   */
  onQueryBegin(sessionID: string): void {
    const count = (this.queryActiveCounts.get(sessionID) ?? 0) + 1;
    this.queryActiveCounts.set(sessionID, count);
    if (count > 1) return;
    this.setEnableAbort(true);
    // 查询开始时立即显示 thinking 动画，覆盖前置耗时
    this.setThinkingAnimation(sessionID, true);
    this.postToWebview(sessionID, {
      type: 'queryBegin',
    });
  }

  /**
   * 查询结束
   */
  onQueryEnd(sessionID: string): void {
    const count = this.queryActiveCounts.get(sessionID) ?? 0;
    if (count <= 0) return;
    const next = count - 1;
    if (next > 0) {
      this.queryActiveCounts.set(sessionID, next);
      return;
    }
    this.queryActiveCounts.delete(sessionID);
    this.setEnableAbort(false);
    this.postToWebview(sessionID, {
      type: 'queryEnd',
    });

  }

  /**
   * 获取 DeepSeek 账户余额并发送到 webview
   */
  private fetchAndSendBalance(sessionID: string): void {
    import('./core/utils/balance.js').then(({ fetchBalance }) => {
      fetchBalance(sessionID).then(balanceInfo => {
        if (balanceInfo) {
          this.postToWebview(sessionID, {
            type: 'balanceUpdate',
            totalBalance: balanceInfo.totalBalance,
            currency: balanceInfo.currency,
            isUnlimited: balanceInfo.isUnlimited,
            fetchedAt: balanceInfo.fetchedAt,
          } as any);
        }
      }).catch((err: unknown) => {
        VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to fetch balance: ${err}`);
      });
    }).catch((err: unknown) => {
      VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to import balance module: ${err}`);
    });
  }

  /**
   * 清空 UI 对话消息
   */
  clearMessages(sessionID: string): void {
    this.postToWebview(sessionID, {
      type: 'clearMessages',
    });
  }

  /**
   * 通知 UI 显示或清除排队消息状态
   */
  onQueuedMessage(sessionID: string, content: string | null): void {
    this.postToWebview(sessionID, content
      ? { type: 'queuedMessage', sessionId: sessionID, content }
      : { type: 'clearQueuedMessage', sessionId: sessionID });
  }

  /**
   * 命令发送回调
   */
  async onCommandSend(commandName: string, args: string, sessionId: string): Promise<boolean> {
    if (commandName === 'clear') {
      this.postToWebview(sessionId, {
        type: 'clearMessages',
        sessionId,
      });

      (async () => {
        try {
          const { replaceConversationMessages, updateConversationContext } = await import('./core/history/index.js');
          await replaceConversationMessages(sessionId, []);
          await updateConversationContext(sessionId, { totalContextTokens: 0 });
          const { getSessionEngine } = await import('./core/QueryEngine.js');
          const engine = getSessionEngine(sessionId);
          if (engine) {
            const msgs = engine.getMessages();
            msgs.length = 0;
            engine.lastPersistedMessageUuid = null;
          }
        } catch (err) {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Error clearing conversation: ${err}`);
        }
      })();

      return true;
    }

    if (commandName === 'spin') {
      const trimmed = args.trim();
      if (trimmed === 'design') {
        this.webviewMessageHandler.handleOpenSpinDesign().catch((err: any) => {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Error opening spin design: ${err}`);
        });
        return true;
      }
      // /spin: check if spin.json exists in ~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/, open design if not
      const wf = vscode.workspace.workspaceFolders;
      if (wf && wf.length > 0) {
        const { getProjectConversationDir } = require('./core/history/Config.js');
        const path = require('path') as typeof import('path');
        const projectDir = getProjectConversationDir(wf[0].uri.fsPath);
        const spinJsonPath = path.join(projectDir, 'spin.json');
        const fs = require('fs');
        let hasSpinJson = false;
        try {
          hasSpinJson = fs.existsSync(spinJsonPath);
        } catch {}
        if (!hasSpinJson) {
          // no spin.json, open design
          this.webviewMessageHandler.handleOpenSpinDesign().catch((err: any) => {
            VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Error opening spin design: ${err}`);
          });
          return true;
        }
      }
    }

    return false;
  }

  /**
   * 压缩进度通知
   */
  onCompressProgress(sessionID: string, status: 'start' | 'complete' | 'error', postCompactTokenCount?: number): void {
    this.postToWebview(sessionID, {
      type: 'compressProgress',
      status,
      postCompactTokenCount,
    });
  }

  /**
   * 展开压缩的对话：从归档读取消息推给 webview 显示，不动 JSONL
   * LLM 仍然只看到压缩后的消息，展开仅影响 webview 显示
   */
  async onExpandCompact(sessionID: string): Promise<void> {
    try {
      const { loadCompactArchive } = await import('./core/history/Conversation.js');

      const originalMessages = await loadCompactArchive(sessionID);
      if (!originalMessages || originalMessages.length === 0) {
        return;
      }

      // 后备：如果归档中没有 summary 消息（旧归档），从压缩后的主 JSONL 中读取并补充
      let messagesToDisplay = originalMessages;
      {
        const summaryCount = originalMessages.filter(m => (m as any).isCompactSummary === true).length;
        if (summaryCount === 0) {
          try {
            const { loadConversation } = await import('./core/history/index.js');
            const conversation = await loadConversation(sessionID);
            const compressedSummaries = conversation.messages.filter((m: any) =>
              m.type === 'user' && (m as any).isCompactSummary === true
            );
            // 从压缩后消息中提取"当前未被压缩部分"（保留的最近消息）
            const retainedMessages = conversation.messages.filter((m: any) =>
              (m.type === 'user' || m.type === 'assistant')
              && !(m as any).isCompactSummary
              && !((m as any).subtype === 'compact_boundary')
            );
            if (compressedSummaries.length > 0) {
              // 顺序：归档消息 -> 压缩摘要 -> 当前未被压缩部分
              messagesToDisplay = [...originalMessages, ...compressedSummaries, ...retainedMessages];
            }
          } catch (err) {
            VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to load summaries from compressed messages: ${err}`);
          }
        }
      }

      replayMessagesToUI(this, sessionID, messagesToDisplay);

      // 通知 webview 展开完成
      this.postToWebview(sessionID, { type: 'expandCompactDone' });

    } catch (err) {
      VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Failed to expand compact for ${sessionID}: ${err}`);
    }
  }

  /**
   * 获取 UI 动态信息
   */
  async getUIDynamicInfo(_sessionID: string): Promise<UIDynamicInfo> {
    const workspacePath = this.getWorkspacePath() || process.cwd();
    return { cwd: workspacePath };
  }

  /**
   * 请求用户输入密码
   */
  async requestPassword(sessionID: string, prompt: string, validationRule?: ValidationRule, plainText?: boolean): Promise<string | null> {
    return this.userChoiceManager.requestPassword(sessionID, prompt, validationRule, plainText);
  }

  /**
   * 请求用户选择或确认
   */
  async requestUserChoice(sessionID: string, options: {
    toolName: string;
    message: string;
    choices?: Array<{ label: string; description?: string }>;
    showPreview?: boolean;
    previewContent?: string;
    previewTitle?: string;
    showDiff?: boolean;
    beforeContent?: string;
    afterContent?: string;
    diffTitle?: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }): Promise<{ index: number; reply?: string }> {
    return this.userChoiceManager.requestUserChoice(sessionID, options);
  }

  /**
   * 处理来自 webview 的消息
   */
  async handleWebviewMessage(message: any): Promise<void> {
    await this.webviewMessageHandler.handleWebviewMessage(message);
  }
}

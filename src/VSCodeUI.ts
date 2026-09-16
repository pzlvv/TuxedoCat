/**
 * VSCodeUI - VS Code 侧 UI 实现（阶段 1 过渡形态）
 *
 * 阶段 1 起 core 不再 import UI：本类在构造时把 CoreEventHandlers / CoreRequestHandlers
 * 两张映射表注册到总线（穷尽检查由映射类型保证），阶段 5 将与本文件的宿主部分
 * 拆开合并为 WebViewUI。
 *
 * 宿主共享模块（VSCodeUI / ElectronUI 共用）位于 src/host/ui/：
 *   - types.ts / userChoice.ts / toolHandler.ts / webviewMessageHandler.ts / spinDesignHtml.ts
 * 本文件仅保留 VS Code 专有部分（webview 生命周期、虚拟文档、面板等）：
 *   - documentManager.ts / diffUris.ts
 */

import * as vscode from 'vscode';
import type { MessageData, StreamMessageData, StreamEndData } from './core/types.js';
import type { CoreEventHandlers, CoreRequestHandlers, AssistantEventBus } from './core/AssistantEventBus.js';
import type { ToolProgressData } from './core/tools/Tool.js';
import type { WebviewMessage } from './core/webviewTypes.js';
import type { UIHost } from './host/UIHost.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from './host/mermaidHtml.js';
import { tt, getSystemLocale } from './core/i18n.js';
import { readUiLanguageSync } from './core/history/Config.js';
import { MERMAID_PANEL_ID, SPIN_DESIGN_PANEL_ID } from './config/project.js';
import type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent } from './host/ui/types.js';
import { UserChoiceManager } from './host/ui/userChoice.js';
import { DocumentManager } from './VSCodeUI/documentManager.js';
import { buildDiffUris } from './VSCodeUI/diffUris.js';
import { ToolHandler } from './host/ui/toolHandler.js';
import { WebviewMessageHandler } from './host/ui/webviewMessageHandler.js';
import { isImageFile } from './host/imageFiles.js';
import { setSessionIdleCloseHandler, setSessionWaitingForUserProvider, releaseSessionResources } from './core/sessionIdle.js';
import { clearConversationData } from './core/history/ops.js';
import { fetchBalanceAndPush } from './core/history/balancePush.js';
import { buildConversationLoadedPayload } from './host/conversationPayload.js';
import { pushToolProgress, inheritAgentMode } from './host/queryActivity.js';
import { SessionUiState } from './host/SessionUiState.js';
import { shouldOpenSpinDesign } from './core/history/spinCommand.js';

export type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent };

export class VSCodeUI {
  private static outputChannel: vscode.OutputChannel | undefined;
  private static instance: VSCodeUI | undefined;
  private webviewView: vscode.WebviewView | undefined;
  /** 按 session 保存的 agent mode */
  private sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'> = new Map();
  /**
   * 按会话的 UI 运行时状态（活动阶段 / 工具计数 / 查询计数 / abort scope）。
   * 与 ElectronUI 共用同一实现，避免两端逻辑分叉。
   */
  private readonly sessionUi = new SessionUiState();
  /** 对话列表刷新 debounce timer：消息落盘是异步的，延迟刷新可拿到最新 messageCount */
  private conversationListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private _windowStateRegistered: boolean = false;

  // 子模块
  private userChoiceManager: UserChoiceManager<vscode.Uri>;
  private documentManager: DocumentManager;
  private toolHandler: ToolHandler;
  private webviewMessageHandler: WebviewMessageHandler;
  private extensionUri: vscode.Uri = vscode.Uri.file('');

  constructor(bus: AssistantEventBus) {
    // 先初始化子模块（需要引用 postToWebview 等方法）
    this.userChoiceManager = new UserChoiceManager({
      outputChannel: VSCodeUI.outputChannel,
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      closePreview: () => this.closePreview(),
      getActiveSessionIdInternal: () => this.getActiveSessionIdInternal(),
      onShowDiffInVirtualDocumentCallback: undefined, // 稍后设置
      buildDiffUris: (title) => buildDiffUris(title),
    });

    this.documentManager = new DocumentManager(VSCodeUI.outputChannel);

    this.toolHandler = new ToolHandler({
      host: this.buildHost(),
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      userChoiceManager: this.userChoiceManager,
    });

    this.webviewMessageHandler = new WebviewMessageHandler({
      host: this.buildHost(),
      postToWebview: (sessionId, message) => this.postToWebview(sessionId, message),
      postConversationLoaded: (sessionId, conversation, extra) =>
        this.postConversationLoaded(sessionId, conversation, extra),
      setTitle: (sessionID, title) => this.onTitleChanged(sessionID, title),
      userChoiceManager: this.userChoiceManager,
    });

    // 初始化 UserChoiceQueue 回调
    this.userChoiceManager.initUserChoiceQueue();

    // 空闲对话自动关闭（2 小时无活动）：VS Code 没有独立对话视图，
    // 关闭 = 释放引擎 / 消息缓存 / MCP 引用（见 releaseSessionResources）。
    // 当前激活的对话不会被关闭；切换回被关闭的对话时会重新 loadConversation，
    // 由 restoreConversationEngine 从磁盘重建引擎。
    setSessionIdleCloseHandler((sessionId) => releaseSessionResources(sessionId));
    setSessionWaitingForUserProvider((sessionId) => this.hasPendingUserChoice(sessionId));

    // ===================== 总线注册（阶段 1.5/1.6）=====================
    // 两张映射表一次性注册；漏写任何一个 CoreEvent['type'] / CoreRequest['type']
    // 都会编译报错（映射类型穷尽检查）。
    bus.onCoreEvents(this.buildCoreEventHandlers());
    bus.onCoreRequests(this.buildCoreRequestHandlers());
  }

  /** core → UI 单向事件的处理器表（原 AssistantUI 方法搬到这里，命名去 on 前缀） */
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
      conversationListChanged: () => this.scheduleConversationListRefresh(),
      spinDesignDataChanged: () => void this.refreshSpinDesign(),
      compactBegin: (e) => this.onCompressProgress(e.sessionId, 'start'),
      compactEnd: (e) =>
        this.onCompressProgress(
          e.sessionId,
          e.result.status === 'complete' ? 'complete' : 'error',
          e.result.status === 'complete' ? e.result.postCompactTokenCount ?? undefined : undefined,
        ),
      commandDispatched: (e) => void this.onCommandSend(e.commandName, e.args, e.sessionId),
      sessionConfigChanged: () => {
        // 阶段 2 落地：core 广播会话配置变化 → 多端同步回推 webview。
        // 当前 core 还不产生该事件（配置持久化仍在 webviewMessageHandler 内联）。
      },
    };
  }

  /** core → UI 请求的处理器表 */
  private buildCoreRequestHandlers(): CoreRequestHandlers {
    return {
      toolPermission: (r) =>
        this.onPreToolCall(r.sessionId, r.toolUseId, r.toolName, r.permResult, r.displayArgs),
      userChoice: (r) =>
        this.requestUserChoice(r.sessionId, {
          ...r.options,
          beforeContent: r.options.beforeContent ?? undefined,
        }),
    };
  }

  /** 指定会话是否正在等待用户选择/确认（ask user 提问或权限确认） */
  hasPendingUserChoice(sessionId: string): boolean {
    return this.userChoiceManager.hasPendingChoice(sessionId);
  }

  /**
   * 构建宿主能力实现（vscode 版）
   * 供共享的 WebviewMessageHandler 使用，将 vscode API 收敛到此处
   */
  private buildHost(): UIHost {
    return {
      sendToWebview: (message) => {
        this.webviewView?.webview.postMessage(message);
      },
      onSessionOpened: (sessionId) => {
        // 单 webview 宿主：打开 MCP 面板即按当前活动会话建立引用（幂等）。
        // acquire 可能耗时（首次拉取包、握手），后台执行，完成后回推运行时状态；
        // 期间 webview 显示「连接中」。多视图宿主由视图管理器维护，见 ElectronUI。
        this.webviewMessageHandler.acquireMcpOnSessionOpen(sessionId);
      },
      openFile: async (filePath, target) => {
        const selectedLines = target;
        const uri = vscode.Uri.file(filePath);

        // 图片文件直接交给默认编辑器（内置图片预览）打开。
        // 图片是二进制内容，openTextDocument 会抛
        // "File seems to be binary and cannot be opened as text"。
        if (isImageFile(filePath)) {
          await vscode.commands.executeCommand('vscode.open', uri);
          return;
        }

        // 其他二进制文件同样无法用 openTextDocument 打开，退回到 vscode.open。
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(uri);
        } catch (err) {
          VSCodeUI.outputChannel?.appendLine(
            `[VSCodeUI] openTextDocument failed, fallback to vscode.open: ${filePath} (${err})`
          );
          await vscode.commands.executeCommand('vscode.open', uri);
          return;
        }

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
      saveTextFile: async (content, options) => {
        const path = require('path') as typeof import('path');
        const os = require('os') as typeof import('os');
        const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const filters: { [name: string]: string[] } = {};
        for (const filter of options?.filters ?? []) {
          filters[filter.name] = filter.extensions;
        }
        try {
          const uri = await vscode.window.showSaveDialog({
            title: options?.title,
            defaultUri: vscode.Uri.file(path.join(baseDir, options?.defaultFileName ?? 'untitled.txt')),
            filters,
          });
          if (!uri) {
            return { success: false, canceled: true };
          }
          const fs = require('fs') as typeof import('fs');
          await fs.promises.writeFile(uri.fsPath, content, 'utf-8');
          return { success: true, filePath: uri.fsPath };
        } catch (err) {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] saveTextFile failed: ${err}`);
          return { success: false, canceled: false, error: String(err) };
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
      closeConversation: async (sessionId) => {
        // 关闭会话 = abort -> 释放 MCP 引用。
        // VS Code 没有独立的会话视图，用户无法直接触发关闭，仅在删除对话时由删除流程调用。
        try {
          const { abortCurrentQuery } = await import('./core/Integration.js');
          abortCurrentQuery(sessionId);
        } catch { /* 中止失败不阻塞关闭 */ }
        try {
          const { clearSessionMcpOverride } = await import('./core/mcp/Config.js');
          const { getMcpManager } = await import('./core/mcp/Manager.js');
          clearSessionMcpOverride(sessionId);
          await getMcpManager().release(sessionId);
        } catch { /* 释放失败不影响关闭 */ }
      },
      refreshAbortState: () => {
        this.syncAbortState();
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

  /** 读取 Spin 设计数据（spin.json + 工作区路径），带重试保护 */
  private async readSpinDesignData(): Promise<{
    existingData: any;
    spinJsonExists: boolean;
    spinJsonPath: string | null;
    workspacePath: string;
    hasWorkspace: boolean;
  }> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const hasWorkspace = !!(workspaceFolders && workspaceFolders.length > 0);
    // 未打开工作区时留空，绝不退回 process.cwd()（那是扩展宿主进程的启动目录）
    const workspacePath = hasWorkspace ? workspaceFolders![0].uri.fsPath : '';

    if (!hasWorkspace) {
      return {
        existingData: null,
        spinJsonExists: false,
        spinJsonPath: null,
        workspacePath,
        hasWorkspace: false,
      };
    }

    const { getProjectConversationDir } = await import('./core/history/Config.js');
    const path = require('path') as typeof import('path');
    const projectDir = getProjectConversationDir(workspacePath);
    const spinJsonPath = path.join(projectDir, 'spin.json');
    const fs = require('fs');
    let existingData: any = null;
    let spinJsonExists = false;

    // 使用重试读取：即使写入方已改为原子写，仍可能在极端情况下遇到文件占用/瞬时不可读，
    // 避免因一次读取失败就回退到空画布，导致节点内容看起来被清空。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (fs.existsSync(spinJsonPath)) {
          spinJsonExists = true;
          const content = fs.readFileSync(spinJsonPath, 'utf-8');
          existingData = JSON.parse(content);
        }
        break;
      } catch {
        existingData = null;
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }

    return { existingData, spinJsonExists, spinJsonPath, workspacePath, hasWorkspace };
  }

  /** 查找当前已打开的 Spin 设计面板 */
  private findSpinDesignPanel(): vscode.WebviewPanel | undefined {
    const existingPanel = vscode.window.tabGroups.all
      .flatMap(tg => tg.tabs)
      .find(tab => (tab.input as any)?.viewType === SPIN_DESIGN_PANEL_ID);
    return existingPanel
      ? (existingPanel.input as any).webviewPanel as vscode.WebviewPanel
      : undefined;
  }

  /** 创建或复用 Spin 设计面板 */
  private async openSpinDesignPanel(): Promise<void> {
    const panelId = SPIN_DESIGN_PANEL_ID;
    const existingPanel = this.findSpinDesignPanel();

    let panel: vscode.WebviewPanel;
    if (existingPanel) {
      panel = existingPanel;
      panel.reveal();
      return;
    }

    // 读取已存在的 spin.json（从 ~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/）
    const { existingData, spinJsonExists, spinJsonPath, workspacePath, hasWorkspace } =
      await this.readSpinDesignData();

    // 文件存在但连续重试仍无法解析时，不能打开空编辑器，
    // 否则后续保存可能用空数据覆盖真实 spin.json。
    if (spinJsonExists && !existingData) {
      vscode.window.showErrorMessage(`Failed to read spin.json: ${spinJsonPath}`);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      panelId,
      tt('Spin 设计', 'Spin Design'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        // 面板切到后台/被遮挡时保持 webview 内容与状态，避免重新加载丢失未保存编辑
        retainContextWhenHidden: true,
      }
    );

    const { getSpinDesignHtml } = await import('./host/ui/spinDesignHtml.js');
    const { getAllSkills } = await import('./core/skills/loadSkillsDir.js');
    const isDark = this.buildHost().isDarkTheme();
    // 无工作区时不做技能扫描（workspacePath 为空，扫相对路径会落到宿主进程目录）
    const availableSkills = (hasWorkspace ? await getAllSkills(workspacePath) : [])
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));
    panel.webview.html = getSpinDesignHtml(
      existingData,
      isDark,
      this.buildHost().getLocale(),
      getSystemLocale(),
      readUiLanguageSync(),
      availableSkills,
    );

    // 监听来自 spin design webview 的消息
    panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg.type === 'saveSpinDesign' && msg.data) {
        if (hasWorkspace) {
          const { getProjectConversationDir } = await import('./core/history/Config.js');
          const projectDir = getProjectConversationDir(workspacePath);
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
            await writeSpinJsonQueued(workspacePath, data);
            panel?.webview.postMessage({ type: 'spinSaveResult', success: true });
          } catch (err) {
            VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] spin.json save failed: ${err}`);
            panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: String(err) });
          }
        } else {
          panel?.webview.postMessage({ type: 'spinSaveResult', success: false, error: tt('没有打开的工作目录', 'No workspace folder is open') });
        }
      } else if (msg.type === 'exportSpinDesign' && msg.data) {
        try {
          const { exportSpinDesignJson } = await import('./host/spinDesignExport.js');
          const result = await exportSpinDesignJson(
            this.buildHost(),
            msg.data,
            tt('导出 Spin 设计', 'Export Spin Design'),
          );
          panel?.webview.postMessage({ type: 'spinExportResult', ...result } as any);
        } catch (err) {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] spin.json export failed: ${err}`);
          panel?.webview.postMessage({ type: 'spinExportResult', success: false, error: String(err) } as any);
        }
      } else if (msg.type === 'refreshSpinDesign') {
        await this.sendSpinDesignDataToPanel(panel);
      }
    });
  }

  /**
   * 读取磁盘上最新的 spin.json 与 Skill 列表，并推送给 Spin 设计器面板。
   * 供设计器“刷新”按钮和 SpinLoop 执行完成后自动刷新共用。
   */
  private async sendSpinDesignDataToPanel(panel: vscode.WebviewPanel): Promise<void> {
    const refreshed = await this.readSpinDesignData();
    if (refreshed.spinJsonExists && !refreshed.existingData) {
      panel.webview.postMessage({
        type: 'spinSaveResult',
        success: false,
        error: `Failed to read spin.json: ${refreshed.spinJsonPath}`,
      } as any);
      return;
    }
    const { getAllSkills } = await import('./core/skills/loadSkillsDir.js');
    const availableSkills = (await getAllSkills(refreshed.workspacePath))
      .filter(s => !s.isHidden && s.userInvocable)
      .map(s => ({ name: s.name, description: s.description }));
    panel.webview.postMessage({
      type: 'spinDesignData',
      data: refreshed.existingData,
      skills: availableSkills,
    } as any);
  }

  /**
   * SpinLoop 执行完成后刷新已打开的设计器，避免其缓存旧数据后
   * 用户再次保存时覆盖磁盘上的执行结果。
   */
  async refreshSpinDesign(): Promise<void> {
    const panel = this.findSpinDesignPanel();
    if (!panel) {
      return;
    }
    await this.sendSpinDesignDataToPanel(panel);
  }

  /**
   * 获取当前的活跃 session ID。
   * 「哪个会话在前台」是 UI 自己的状态（第 15.6 节）：委托 webviewMessageHandler
   * 维护的 trackedActiveSessionId，不再读写 core 的全局缓存。
   */
  private getActiveSessionIdInternal(): string | undefined {
    return this.webviewMessageHandler.getActiveSessionId();
  }

  static getInstance(): VSCodeUI {
    if (!VSCodeUI.instance) {
      throw new Error('VSCodeUI not initialized. Call VSCodeUI.create(bus) first.');
    }
    return VSCodeUI.instance;
  }

  /** 创建全局唯一实例并注册总线处理器 */
  static create(bus: AssistantEventBus): VSCodeUI {
    if (VSCodeUI.instance) {
      throw new Error('VSCodeUI already created.');
    }
    VSCodeUI.instance = new VSCodeUI(bus);
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

  /** 当前活跃会话 ID（UI 自己维护的状态，供宿主注入 sessionIdle provider 使用） */
  getActiveSessionId(): string | undefined {
    return this.webviewMessageHandler.getActiveSessionId();
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
    const payload = buildConversationLoadedPayload(sessionId, conversation, extra, {
      // VS Code 版独有：恢复 thinking 动画所需的活动阶段
      activityPhase: this.getActivityPhase(sessionId),
    });
    this.webviewView?.webview.postMessage(payload as WebviewMessage);

    // 同步 abort 状态：切换到含活跃子代理的会话后，父会话的 abort 按钮仍应可用
    this.syncAbortState();
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

  // ===================== CoreEvent 处理器（原 AssistantUI 实现） =====================

  /**
   * 设置子会话的 agent mode
   * 子代理默认使用 risk 模式，仅当父会话为 auto 时继承 auto（auto > risk > manual）
   */
  onSetAgentMode(parentSessionId: string, childSessionId: string): void {
    inheritAgentMode(this.sessionAgentModes, parentSessionId, childSessionId);
  }

  /**
   * 工具调用开始前（收到 CoreRequest.toolPermission）：
   * 显示工具卡片；permResult.behavior === 'ask' 时弹确认框并回传用户选择。
   * 权限决策已由 core 的 PermissionPolicy 加工完，这里只做展示。
   */
  async onPreToolCall(
    sessionID: string,
    toolUseId: string,
    toolName: string,
    permResult: import('./core/tools/Tool.js').PermissionResult,
    displayArgs: Record<string, unknown>,
  ): Promise<import('./core/tools/Tool.js').PermissionResult> {
    // 进入工具阶段（包括等待用户授权/权限检查），thinking 动画应让位于工具卡片
    this.sessionUi.beginToolPhase(sessionID);
    return this.toolHandler.onPreToolCall(sessionID, toolUseId, toolName, permResult, displayArgs);
  }

  /**
   * 工具调用开始
   */
  onToolCall(sessionID: string, toolUseId: string, toolName: string): void {
    this.sessionUi.markToolPhase(sessionID);
    this.toolHandler.onToolCall(sessionID, toolUseId, toolName);
  }

  /**
   * 工具调用结果
   */
  onToolResult(sessionID: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void {
    this.sessionUi.endToolPhase(sessionID);
    this.toolHandler.onToolResult(sessionID, toolUseId, toolName, output, status);
  }

  /**
   * 更新已存在工具卡片的参数（如 WebSearch 卡片补全搜索词/URL）
   */
  onToolArgsUpdated(sessionID: string, toolUseId: string, args: Record<string, unknown>): void {
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
    pushToolProgress(sessionID, toolUseId, progress, (sessionId, message) =>
      this.postToWebview(sessionId, message, true /* silent: 流式输出每 chunk 打印一次太频繁，跳过日志 */));
  }

  /**
   * 发送消息到 webview
   */
  onMessage(sessionID: string, data: MessageData): void {
    this.postToWebview(sessionID, {
      type: 'addMessage',
      ...data,
    });
    // 用户消息已进入持久化流程：刷新对话列表，使打开中的历史列表同步 messageCount
    if (data.role === 'user') {
      this.scheduleConversationListRefresh();
    }
  }

  /**
   * 流式消息增量更新
   */
  onStreamMessage(sessionID: string, data: StreamMessageData): void {
    if (data.role === 'assistant' && data.accumulated && !data.accumulated.trim()) {
      return;
    }
    // 流式阶段决定当前是 thinking 还是 assistant 文本输出
    if (data.role === 'assistant') {
      this.sessionUi.markText(sessionID);
    } else {
      this.sessionUi.markThinking(sessionID);
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
  private setEnableAbort(enable: boolean): void {
    this.webviewView?.webview.postMessage({
      type: 'setEnableAbort',
      enable,
    });
  }

  /**
   * 当前 abort scope 是否有活跃查询。
   * abort scope = 当前会话自身 + 其递归子代理；
   * 子代理在后台运行时，父会话的 abort 按钮仍应可用（中断父会话会连带中断子代理）。
   */
  private hasActiveQueryInScope(sessionId: string): boolean {
    return this.sessionUi.hasActiveQueryInScope(sessionId);
  }

  /**
   * 根据当前会话（及其子代理）的活跃状态同步 abort 按钮。
   * 在 queryBegin/queryEnd 或切换会话后调用。
   */
  private syncAbortState(): void {
    const activeSessionId = this.getActiveSessionIdInternal();
    this.setEnableAbort(activeSessionId ? this.hasActiveQueryInScope(activeSessionId) : false);
  }

  /**
   * 设置当前对话标题（原 setTitle，重命名为 onTitleChanged）
   */
  onTitleChanged(sessionID: string, title: string): void {
    this.postToWebview(sessionID, {
      type: 'setTitle',
      title,
    });
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
   * 节流刷新对话列表：消息持久化在 appendMessage 中异步完成，
   * 延迟 500ms 拉取可保证拿到包含最新 messageCount 的列表。
   * core 的 conversationListChanged 事件统一走这里（UI 决定节流策略）。
   */
  scheduleConversationListRefresh(): void {
    if (this.conversationListRefreshTimer) clearTimeout(this.conversationListRefreshTimer);
    this.conversationListRefreshTimer = setTimeout(() => {
      this.conversationListRefreshTimer = null;
      void this.refreshConversationList();
    }, 500);
  }

  /**
   * 刷新对话列表并推送到 webview
   * 用于子代理创建等场景：新子会话的 meta.json 创建后，通知 webview 重新加载
   * 对话列表，使子对话能在树形结构中正确显示并关联到主对话。
   * （阶段 3 起该方法迁到 ConversationManager。）
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
   * 获取某个 session 当前活动阶段（供 conversationLoaded 恢复 thinking 动画使用）
   */
  getActivityPhase(sessionID: string): 'idle' | 'thinking' | 'text' | 'tool' {
    return this.sessionUi.getActivityPhase(sessionID);
  }

  /**
   * AI 开始处理
   */
  onAIBegin(sessionID: string): void {
    this.sessionUi.markThinking(sessionID);
    this.setThinkingAnimation(sessionID, true);
    this.postToWebview(sessionID, {
      type: 'aiBegin',
    });
  }

  /**
   * AI 处理结束（每轮 LLM 调用后触发）
   */
  onAIEnd(sessionID: string): void {
    this.sessionUi.markIdle(sessionID);
    this.setThinkingAnimation(sessionID, false);
    this.postToWebview(sessionID, {
      type: 'aiEnd',
    });
    // 每轮 LLM 调用后刷新余额
    this.fetchAndSendBalance(sessionID);
  }

  /**
   * 查询开始。
   * 同一 session 可能被多个调用方同时标记 begin（主 sendMessage、排队消息 manageQueryUI、
   * enqueueAgentMessage 后台 consumer、子代理等），由 SessionUiState 计数去重，
   * 保证一次查询只发一次 queryBegin/queryEnd。
   */
  onQueryBegin(sessionID: string): void {
    if (!this.sessionUi.beginQuery(sessionID)) return;
    // 查询开始时立即显示 thinking 动画，覆盖前置耗时
    this.sessionUi.markThinking(sessionID);
    this.setThinkingAnimation(sessionID, true);
    this.syncAbortState();
    this.postToWebview(sessionID, {
      type: 'queryBegin',
    });
  }

  /**
   * 查询结束
   */
  onQueryEnd(sessionID: string): void {
    if (!this.sessionUi.endQuery(sessionID)) return;
    this.sessionUi.markIdle(sessionID);
    // 查询结束必须关闭 thinking 动画：中断（尤其子代理中断）可能没有 onAIEnd，
    // 若只发 queryEnd 会让 webview 的 thinking 动画残留。
    this.setThinkingAnimation(sessionID, false);
    // 先同步 abort 状态再发 queryEnd：若当前会话仍有其他查询/子代理在运行，
    // 这里会保持 abort 按钮可用，而不是被其他会话的 queryEnd 置灰。
    this.syncAbortState();
    this.postToWebview(sessionID, {
      type: 'queryEnd',
    });
    // 查询结束代表消息已持久化完成：推送最新对话列表，历史列表打开时条数实时更新
    void this.refreshConversationList();
    // 此时 meta.json 一定已创建：把新对话期间（meta.json 尚不存在时）记在内存里的
    // 会话级 MCP 选择补写进去
    void (async () => {
      try {
        const { flushSessionMcpToMeta } = await import('./core/mcp/Config.js');
        await flushSessionMcpToMeta(sessionID);
      } catch {
        // 补写失败不影响主流程
      }
    })();
  }

  /**
   * 获取 DeepSeek 账户余额并发送到 webview
   */
  private fetchAndSendBalance(sessionID: string): void {
    fetchBalanceAndPush(
      (message) => this.postToWebview(sessionID, message),
      (line) => VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] ${line}`),
    );
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
   * 通知 UI 显示或清除排队消息状态（供 webviewMessageHandler 的 queue 路径调用）
   */
  onQueuedMessage(sessionID: string, content: string | null, images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>, fileInfo?: { filePath?: string; selectedLines?: { start: number; end: number }; fileHidden?: boolean }): void {
    this.postToWebview(sessionID, content
      ? {
        type: 'queuedMessage',
        sessionId: sessionID,
        content,
        images,
        filePath: fileInfo?.filePath,
        selectedLines: fileInfo?.selectedLines,
        fileHidden: fileInfo?.fileHidden,
      }
      : { type: 'clearQueuedMessage', sessionId: sessionID });
  }

  /**
   * 命令发送回调（CoreEvent.commandDispatched 的处理方）。
   * 唯一调用方（CommandDispatcher）丢弃返回值，改为 Promise<void>。
   */
  async onCommandSend(commandName: string, args: string, sessionId: string): Promise<boolean> {
    if (commandName === 'clear') {
      this.postToWebview(sessionId, {
        type: 'clearMessages',
        sessionId,
      });

      void clearConversationData(sessionId, {
        // /clear 后同步列表 messageCount（清空后仍保留会话，显示 0 条）
        onSuccess: () => this.refreshConversationList(),
        onError: (err) => {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Error clearing conversation: ${err}`);
        },
      });

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
      if (wf && wf.length > 0 && shouldOpenSpinDesign(wf[0].uri.fsPath)) {
        // no spin.json, open design
        this.webviewMessageHandler.handleOpenSpinDesign().catch((err: any) => {
          VSCodeUI.outputChannel?.appendLine(`[VSCodeUI] Error opening spin design: ${err}`);
        });
        return true;
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
   * 请求用户选择或确认（CoreRequest.userChoice 的处理方）
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

import * as vscode from 'vscode';
import * as fs from 'fs';
import { VSCodeUIHost } from './VSCodeUIHost.js';
import { VSCodeSpinDesign } from './VSCodeSpinDesign.js';
import { SingleWebViewConversationManager } from './VSCodeConversationManager.js';
import { WebViewUI } from './host/WebViewUI.js';
import { UserChoiceManager } from './host/ui/userChoice.js';
import { buildDiffUris } from './VSCodeUIHost/diffUris.js';
import { setLogCallback } from './core/Logger.js';
import { initializeHistory } from './core/Integration.js';
import { setSessionWaitingForUserProvider } from './core/sessionResources.js';
import {
  readActiveProviderModelContextSync,
  readUiLanguageSync,
  readHighlightLanguagesSync,
  setExtensionPathProvider,
} from './core/history/Config.js';
import { ensureConfigDirs } from './core/history/index.js';
import { VSCODE_HOST_INFO } from './host/types.js';
import { getContextWindow } from './core/utils/modelConfig.js';
import { getLLMConfigPanelPayload, hasActiveProviderSetting } from './core/llm/config.js';
import { getSystemLocale, setCoreLocale, setCoreUiLanguage } from './core/i18n.js';
import { setGlobalEventBus, requireEventBus } from './core/AssistantEventBus.js';
import { createEventBus } from './host/EventBus.js';
import { initializeCoreEvents } from './core/initializeCoreEvents.js';
import {
  COMMAND_PREFIX,
  DIFF_AFTER_SCHEME,
  DIFF_BEFORE_SCHEME,
  OUTPUT_CHANNEL_NAME,
  PREVIEW_SCHEME,
  PRODUCT_NAME,
  VIEW_ID,
} from './config/project.js';

/** 当前 ConversationManager（空闲巡检的计时 owner），供 deactivate 停止巡检 */
let conversationManager: SingleWebViewConversationManager | undefined;

class VirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  private contentMap = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();

  get onDidChangeTree(): vscode.Event<vscode.Uri> {
    return this.onDidChangeEmitter.event;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentMap.get(uri.toString()) || '';
  }

  setContent(uri: vscode.Uri, content: string): void {
    this.contentMap.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }
}

export function activate(context: vscode.ExtensionContext) {
  setCoreLocale(vscode.env.language);
  setCoreUiLanguage(readUiLanguageSync());
  setExtensionPathProvider(() => context.extensionPath);

  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  outputChannel.appendLine(`${PRODUCT_NAME} extension activated`);

  setLogCallback((message: string) => {
    outputChannel.appendLine(message);
  });

  const host = new VSCodeUIHost(outputChannel);
  // 事件总线：core 与 UI 的唯一耦合点（DEVELOPMENT.md 第 3 节）。
  // 顺序：注册总线 → 注册 core 侧 UiEvent 订阅 → 创建 UI（其构造函数注册 CoreEvent 处理器）。
  const bus = createEventBus();
  setGlobalEventBus(bus);
  initializeCoreEvents(bus);
  // 宿主实现与共享 UI 一次成型；托盘/侧栏是 Electron 的事，VS Code 用空 manager
  const conversations = new SingleWebViewConversationManager(host);
  conversationManager = conversations;
  const ui = WebViewUI.create(
    host,
    bus,
    new VSCodeSpinDesign(host),
    conversations,
    {
      log: (...args: unknown[]) => {
        outputChannel.appendLine(args.map(a => String(a)).join(' '));
      },
      createUserChoiceManager: (post, closePreview, uiPort) =>
        new UserChoiceManager({
          outputChannel,
          postToWebview: post,
          closePreview,
          getActiveSessionIdInternal: () => uiPort.getActiveSessionId(),
        }),
    },
  );
  host.setExtensionUri(context.extensionUri);
  host.registerWindowStateListener(context);
  // 活跃会话读取（bootstrap 注入）；abort 按钮状态由 webview 从 core 的
  // sessionRuntimeStates 自行推导，不再由宿主推送
  host.getActiveSessionId = () => ui.getActiveSessionId();

  initializeHistory(ui);

  // 空闲对话自动关闭（VS Code 专属：单 webview，关闭只是卸内存）。
  // 计时 owner 是 SingleWebViewConversationManager，core 不参与计时；
  // 非激活对话 2 小时无活动后走 WebViewUI.closeConversation（core 卸内存 + 宿主销毁视图）。
  // core 的「是否在忙」判定需要「等待用户」事实（ask user / 权限确认）
  setSessionWaitingForUserProvider((sessionId) => ui.hasPendingUserChoice(sessionId));
  conversations.setActiveSessionProvider(() => ui.getActiveSessionId() ?? null);
  conversations.setIdleCloseHandler((sessionId) => ui.closeConversation(sessionId));
  conversations.startIdleMonitor();

  ensureConfigDirs().catch((error: Error) => {
    console.error('[Extension] Failed to initialize config directories:', error);
  });

  void (async () => {
    try {
      const { warmupSystemDynamicInfo } = await import('./core/prompt/SystemEnvironment.js');
      const { getProjectRoot } = await import('./core/history/Config.js');
      warmupSystemDynamicInfo(getProjectRoot());
    } catch {
      // 预热失败不影响主流程
    }
  })();

  // 注册虚拟文档内容提供者
  const virtualDocumentProvider = new VirtualDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, virtualDocumentProvider),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_BEFORE_SCHEME, virtualDocumentProvider),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_AFTER_SCHEME, virtualDocumentProvider)
  );

  host.setShowContentInVirtualDocumentCallback(async ({ content, title }: { content: string; title: string }) => {
    const displayTitle = `[${PRODUCT_NAME}] ${title}`;
    const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:${encodeURIComponent(displayTitle)}`);
    virtualDocumentProvider.setContent(uri, content);

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to show document: ${err}`);
    }
  });

  host.setShowDiffInVirtualDocumentCallback(async ({ beforeContent, afterContent, title }: { beforeContent: string; afterContent: string; title: string }) => {
    try {
      const { beforeUri, afterUri } = buildDiffUris(title);
      virtualDocumentProvider.setContent(beforeUri, beforeContent);
      virtualDocumentProvider.setContent(afterUri, afterContent);

      await vscode.commands.executeCommand(
        'vscode.diff',
        beforeUri,
        afterUri,
        title,
        {
          preview: true,
          preserveFocus: true,
          viewColumn: vscode.ViewColumn.Active
        }
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to show diff: ${err}`);
    }
  });

  const provider = new AssistantViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  const disposable = vscode.commands.registerCommand(`${COMMAND_PREFIX}.open`, () => {
    vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  });

  context.subscriptions.push(disposable);
  context.subscriptions.push(outputChannel);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = PRODUCT_NAME;
  statusBarItem.tooltip = `Open ${PRODUCT_NAME} Assistant`;
  statusBarItem.command = `${COMMAND_PREFIX}.open`;
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);

  // MCP：引用计数模型下，进程由「打开的对话」驱动，扩展激活时只做残留清理，
  // 不主动连接任何服务器；会话打开 / 切换时才 acquire。
  void (async () => {
    try {
      const { getMCPHost } = await import('./core/mcp/MCPHost.js');
      await getMCPHost().prune();
    } catch (err) {
      console.error('[Extension] Failed to initialize MCP servers:', err);
    }
  })();
}

class AssistantViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private ui: WebViewUI;
  private host: VSCodeUIHost;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {
    this.ui = WebViewUI.getInstance();
    this.host = this.ui.host as VSCodeUIHost;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getWebviewContent();
    this.host.setWebviewView(webviewView);

    this.sendCurrentFileInfo();

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.sendCurrentFileInfo();
      })
    );

    this.context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.sendCurrentFileInfo();
      })
    );

    setTimeout(() => {
      this.sendThemeInfo();
      this.sendContextLimit();
    }, 100);

    setTimeout(() => {
      this.checkAndSendLLMConfig();
    }, 1000);

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.sendThemeInfo();
      })
    );

    webviewView.webview.onDidReceiveMessage(async (message: any) => {
      // 兜底：单条 webview 消息处理失败不应变成未处理的 rejection
      // （VS Code 会打印 "rejected promise not handled within 1 second"，
      // 且整条消息链路静默失败，难以定位）。
      try {
        if (message.type === 'requestTheme') {
          this.sendThemeInfo();
          return;
        }
        if (message.type === 'requestContextLimit') {
          this.sendContextLimit(message.model);
          return;
        }
        await this.ui.handleWebviewMessage(message);
      } catch (err) {
        const detail = err instanceof Error ? (err.stack || err.message) : String(err);
        this.host.log(
          `[Extension] handleWebviewMessage failed for type=${message?.type}: ${detail}`
        );
      }
    });
  }

  /**
   * 检测 LLM 配置是否完整，如果不完整则向 webview 发送配置面板消息。
   * 新结构下：没有设置 llm.activeProvider 或 active provider 缺少 apiKey 时弹配置面板。
   */
  private async checkAndSendLLMConfig(): Promise<void> {
    try {
      const payload = await getLLMConfigPanelPayload();
      const hasActiveProvider = await hasActiveProviderSetting();
      // 仅在 active provider 已设置但缺少 apiKey 时补弹；
      // 没有 active provider 的场景由 handleStartNewConversation 在新对话时弹设置页
      if (!hasActiveProvider || payload.apiKey) {
        return;
      }

      this.host.log('[Extension] Active provider apiKey is empty, sending showLLMConfig to webview');
      this.webviewView?.webview.postMessage({
        type: 'showLLMConfig',
        ...payload,
        language: readUiLanguageSync(),
      });
    } catch (err) {
      console.error('[Extension] checkAndSendLLMConfig error:', err);
    }
  }

  private sendThemeInfo(): void {
    if (!this.webviewView) { return; }

    const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
      ? 'dark'
      : 'light';

    this.webviewView.webview.postMessage({
      type: 'setTheme',
      theme,
    });
  }

  private sendContextLimit(model?: string): void {
    if (!this.webviewView) { return; }

    // 与 Electron 共用同一份读取逻辑（含 provider 级 modelConfigs 覆盖），
    // 避免两端对「切换模型后的 context window」计算出不同结果。
    const { model: modelName, modelConfigs } = readActiveProviderModelContextSync(model);

    this.webviewView.webview.postMessage({
      type: 'contextLimitUpdated',
      maxContextTokens: getContextWindow(modelName || '', modelConfigs),
    });
  }

  private sendCurrentFileInfo(): void {
    if (!this.webviewView) { return; }

    const editor = vscode.window.activeTextEditor;
    // 仅把真实文件系统文件当作“当前文件”；Output、Terminal、虚拟文档等非文件窗口一律屏蔽
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.webviewView.webview.postMessage({
        type: 'setCurrentFile',
        filePath: '',
      });
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const selection = editor.selection;
    const cursorLine = selection.start.line + 1;
    const selectedLines = selection.isEmpty
      ? { start: cursorLine, end: cursorLine }
      : { start: selection.start.line + 1, end: selection.end.line + 1 };

    void this.persistCurrentFileContext(filePath, selectedLines);

    this.webviewView.webview.postMessage({
      type: 'setCurrentFile',
      filePath,
      selectedLines,
    });
  }

  private async persistCurrentFileContext(
    filePath: string,
    selectedLines: { start: number; end: number }
  ): Promise<void> {
    // 「当前活跃会话」由 UI 自己维护（第 12.7 节）；
    // 写 meta.json 的动作翻译成 UiEvent.conversationContextUpdated 走总线
    const activeSessionId = this.ui.getActiveSessionId();
    if (!activeSessionId) {
      return;
    }
    requireEventBus().emitToCore({
      type: 'conversationContextUpdated',
      sessionId: activeSessionId,
      changes: [
        { key: 'currentFile', value: filePath },
        { key: 'selectedLines', value: selectedLines },
      ],
    });
  }

  private getWebviewContent(): string {
    const indexHtmlUri = vscode.Uri.joinPath(vscode.Uri.file(this.context.extensionPath), 'dist', 'webview', 'index.html');
    const indexHtmlPath = indexHtmlUri.fsPath;

    let html = fs.readFileSync(indexHtmlPath, 'utf-8');

    const webviewBaseUri = this.webviewView!.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(this.context.extensionPath), 'dist', 'webview')
    );
    html = html.replace(/"\.\//g, `"${webviewBaseUri}/`);

    const logoUri = this.webviewView!.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(this.context.extensionPath), 'dist', 'webview', 'logo.png')
    );

    const hasWorkspace = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    const vscodeLocale = vscode.env.language;
    const systemLocale = getSystemLocale();
    const uiLanguage = readUiLanguageSync();
    // Shiki 语法高亮全部按需加载：注入上次已使用过的语言，webview 启动后后台预热
    const highlightLanguages = JSON.stringify(readHighlightLanguagesSync());

    html = html.replace(
      /(<script type="module"[^>]*>)/,
      `
    <script>
      window.vscode = acquireVsCodeApi();
      window.logoUri = "${logoUri}";
      window.__hasWorkspace = ${hasWorkspace};
      window.__vscodeLocale = "${vscodeLocale}";
      window.__systemLocale = "${systemLocale}";
      window.__uiLocale = "${uiLanguage}";
      window.__highlightLanguages = ${highlightLanguages};
      window.__hostInfo = ${JSON.stringify(VSCODE_HOST_INFO)};
    </script>
    $1`
    );

    return html;
  }
}

export async function deactivate(): Promise<void> {
  // 停止空闲巡检定时器（计时 owner 是 ConversationManager）
  conversationManager?.stopIdleMonitor();
  // 停用扩展时结束所有 MCP 子进程，避免留下孤儿进程
  try {
    const { getMCPHost } = await import('./core/mcp/MCPHost.js');
    getMCPHost().shutdown();
  } catch {
    // 停用阶段的清理失败不应影响退出
  }
}
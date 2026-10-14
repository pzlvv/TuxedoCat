import * as vscode from 'vscode';
import * as fs from 'fs';
import { VSCodeUIHost } from './VSCodeUIHost.js';
import { VSCodeSpinDesign } from './VSCodeSpinDesign.js';
import { SingleWebViewConversationManager } from './VSCodeConversationManager.js';
import { WebViewUI } from './host/WebViewUI.js';
import { bootstrapCore, bootstrapSnapshot, shutdownCore } from './host/bootstrapCore.js';
import { buildDiffUris } from './VSCodeUIHost/diffUris.js';
import { getSettingsStore } from './host/SettingsStore.js';
import { readSystemLocale, readUiLanguage, readUiFontSize } from './host/coreFacts.js';
import { VSCODE_HOST_INFO } from './host/types.js';
import { requireEventBus } from './core/AssistantEventBus.js';
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
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  outputChannel.appendLine(`${PRODUCT_NAME} extension activated`);

  const host = new VSCodeUIHost(outputChannel);
  // 宿主实现与共享 UI 一次成型；托盘/侧栏是 Electron 的事，VS Code 用空 manager
  const conversations = new SingleWebViewConversationManager(host);
  conversationManager = conversations;

  // 共享启动接线：locale / 日志 / 总线 / core 侧订阅 / WebViewUI / 历史 / 会话队列 /
  // 等待用户读取器 / 配置目录 / 环境预热 / MCP 残留清理（docs/architecture/events.md 第 5 节；宿主专属接线见 `docs/hosts/host-bootstrap.md` 第 1 节）
  const { ui } = bootstrapCore(host, new VSCodeSpinDesign(host), conversations, {
    locale: vscode.env.language,
    log: (...args: unknown[]) => {
      outputChannel.appendLine(args.map(a => String(a)).join(' '));
    },
    logToConsole: false,
    extensionPath: context.extensionPath,
  });

  host.setExtensionUri(context.extensionUri);
  host.registerWindowStateListener(context);
  // 活跃会话读取（bootstrap 注入）；abort 按钮状态由 webview 从 core 的
  // sessionRuntimeStates 自行推导，不再由宿主推送
  host.getActiveSessionId = () => ui.getActiveSessionId();

  // 空闲对话自动关闭（VS Code 专属：单 webview，关闭只是卸内存）。
  // 计时 owner 是 SingleWebViewConversationManager，core 不参与计时；
  // 非激活对话 2 小时无活动后走 WebViewUI.closeConversation（core 卸内存 + 宿主销毁视图）。
  conversations.setActiveSessionProvider(() => ui.getActiveSessionId() ?? null);
  conversations.setIdleCloseHandler((sessionId) => ui.closeConversation(sessionId));
  conversations.startIdleMonitor();

  outputChannel.appendLine(`[bootstrap] ${JSON.stringify(bootstrapSnapshot())}`);

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
      // 主题 / 上下文限制的加载初始化推送（sender 为 null 走默认路由）；
      // webview 的 requestTheme / requestContextLimit 走共享分发表，与这里共用同一份实现
      this.host.onThemeChanged(null);
      this.ui.pushContextLimit(null);
    }, 100);

    setTimeout(() => {
      this.checkAndSendLLMConfig();
    }, 1000);

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.host.onThemeChanged(null);
      })
    );

    webviewView.webview.onDidReceiveMessage(async (message: any) => {
      // 兜底：单条 webview 消息处理失败不应变成未处理的 rejection
      // （VS Code 会打印 "rejected promise not handled within 1 second"，
      // 且整条消息链路静默失败，难以定位）。
      try {
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
   * 视图加载完成后补弹 LLM 配置面板（active provider 已配置但缺 apiKey 时）。
   * 配置读取与消息组装在 WebViewUI；这里只触发（``docs/architecture/principles.md` 第 6 节：core 描述事实，UI 决定表现）。
   */
  private async checkAndSendLLMConfig(): Promise<void> {
    await this.ui.showLLMConfigPanel('startup', null);
  }

  private sendCurrentFileInfo(): void {
    if (!this.webviewView) { return; }

    const editor = vscode.window.activeTextEditor;
    // 仅把真实文件系统文件当作“当前文件”；Output、Terminal、虚拟文档等非文件窗口一律屏蔽
    if (!editor || editor.document.uri.scheme !== 'file') {
      this.host.sendToWebview({
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

    this.host.sendToWebview({
      type: 'setCurrentFile',
      filePath,
      selectedLines,
    });
  }

  private async persistCurrentFileContext(
    filePath: string,
    selectedLines: { start: number; end: number }
  ): Promise<void> {
    // 「当前活跃会话」由 UI 自己维护（``docs/architecture/principles.md` 第 7 节）；
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

    // 空状态背景图的第一张；webview 只取它所在目录，再拼候选文件名（见 placeholderLogo.ts）
    const logoUri = this.webviewView!.webview.asWebviewUri(
      vscode.Uri.joinPath(vscode.Uri.file(this.context.extensionPath), 'dist', 'webview', 'logo1.png')
    );

    const hasWorkspace = !!(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    const vscodeLocale = vscode.env.language;
    const systemLocale = readSystemLocale();
    const uiLanguage = readUiLanguage();
    const uiFontSize = readUiFontSize();
    // 首帧主题：webview 在 React 渲染前用它选对兜底背景色（浅色下不闪深色 loading）。
    // 权威主题仍由 setTheme 消息下发（跟随编辑器主题）。
    const initialTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
      ? 'light'
      : 'dark';
    // Shiki 语法高亮全部按需加载：注入上次已使用过的语言，webview 启动后后台预热
    const highlightLanguages = JSON.stringify(getSettingsStore().readHighlightLanguages());

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
      window.__uiFontSize = "${uiFontSize}";
      window.__initialTheme = "${initialTheme}";
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
  // core 侧的进程级资源（MCP 子进程 / Standalone Core 进程）统一由共享骨架释放
  await shutdownCore();
}

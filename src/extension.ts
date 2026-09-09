import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { VSCodeUI } from './VSCodeUI.js';
import { buildDiffUris } from './VSCodeUI/diffUris.js';
import { setLogCallback } from './core/Logger.js';
import { initializeHistory } from './core/Integration.js';
import {
  readUiLanguageSync,
  setExtensionPathProvider,
} from './core/history/Config.js';
import { ensureConfigDirs } from './core/history/index.js';
import { getContextWindow } from './core/utils/modelConfig.js';
import { getLLMConfigPanelPayload, hasActiveProviderSetting } from './core/llm/config.js';
import { getSystemLocale, setCoreLocale, setCoreUiLanguage } from './core/i18n.js';
import { setGlobalUI } from './core/AssistantUI.js';
import {
  COMMAND_PREFIX,
  CONFIG_DIR_NAME,
  DIFF_AFTER_SCHEME,
  DIFF_BEFORE_SCHEME,
  OUTPUT_CHANNEL_NAME,
  PREVIEW_SCHEME,
  PRODUCT_NAME,
  VIEW_ID,
} from './config/project.js';

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

  VSCodeUI.setOutputChannel(outputChannel);
  const ui = VSCodeUI.getInstance();
  ui.setExtensionUri(context.extensionUri);
  setGlobalUI(ui);
  ui.registerWindowStateListener(context);

  initializeHistory(ui);

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

  ui.setShowContentInVirtualDocumentCallback(async ({ content, title }) => {
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

  ui.setShowDiffInVirtualDocumentCallback(async ({ beforeContent, afterContent, title }) => {
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
  private ui: VSCodeUI;

  constructor(
    private readonly context: vscode.ExtensionContext,
  ) {
    this.ui = VSCodeUI.getInstance();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getWebviewContent();
    this.ui.setWebviewView(webviewView);

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
      if (message.type === 'requestTheme') {
        this.sendThemeInfo();
        return;
      }
      if (message.type === 'requestContextLimit') {
        this.sendContextLimit(message.model);
        return;
      }
      await this.ui.handleWebviewMessage(message);
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

      const outputChannel = VSCodeUI['outputChannel'];
      outputChannel?.appendLine('[Extension] Active provider apiKey is empty, sending showLLMConfig to webview');
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

    let modelName = model;
    let modelConfigs: Record<string, { context?: number; output?: number }> = {};
    try {
      const settingsPath = path.join(os.homedir(), CONFIG_DIR_NAME, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        const activeKey = cfg?.llm?.activeProvider;
        const activeProvider = activeKey ? cfg?.llm?.providers?.[activeKey] : undefined;
        if (activeProvider?.modelConfigs && typeof activeProvider.modelConfigs === 'object') {
          modelConfigs = activeProvider.modelConfigs;
        }
        if (!modelName) {
          modelName = activeProvider?.defaultModel || activeProvider?.models?.[0] || '';
        }
      }
    } catch {
      // 读取失败则使用默认配置
    }

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
    const { getActiveSessionId } = await import('./core/history/Config.js');
    const { updateConversationContext } = await import('./core/history/Conversation.js');

    const sessionId = getActiveSessionId();
    if (!sessionId) {
      return;
    }

    await updateConversationContext(sessionId, {
      currentFile: filePath,
      selectedLines,
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
      window.__hostInfo = {
        kind: 'vscode',
        conversationList: 'webview',
        newConversation: 'webview',
        closeConversation: false,
        openConversationMode: 'loadConversation'
      };
    </script>
    $1`
    );

    return html;
  }
}

export function deactivate() {}
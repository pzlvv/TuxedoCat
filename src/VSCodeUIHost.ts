/**
 * VSCodeUIHost - VS Code 侧的对话 webview 宿主能力实现（implements UIHost）
 *
 * 由原 VSCodeUI 的宿主部分（buildHost + webview 生命周期 + Mermaid 面板 +
 * 虚拟文档回调）整体迁入。core 与 UI 的事件通信不经过本类：
 * 它只实现 UIHost；总线订阅在 src/host/WebViewUI.ts。
 *
 * 硬约束：本文件不能放进 src/host/ 目录。electron/tsconfig.json 的 include
 * 含 ../src/host/ 下所有 ts，放进去会被 electron 侧编译，而本文件
 * 依赖 vscode API，会直接编译失败。
 */


import * as vscode from 'vscode';
import type { UIHost, WebviewViewHandle, WorkspaceChange } from './host/UIHost.js';
import type { CoreEvent } from './shared/AssistantEventBus.js';
import type { WebviewMessage } from './host/webviewMessages.js';
import { sameWorkspaceRef, type WorkspaceRef } from './host/workspaceRef.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from './host/mermaidHtml.js';
import { MERMAID_PANEL_ID } from './config/project.js';
import { DocumentManager } from './VSCodeUIHost/documentManager.js';
import type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent } from './host/ui/types.js';
import { isImageFile } from './host/imageFiles.js';
import { writeSettingsJson } from './host/settingsFile.js';

export type { ShowVirtualDocumentEvent, ShowContentInVirtualDocumentEvent, ShowDiffInVirtualDocumentEvent };

export class VSCodeUIHost implements UIHost {
  private webviewView: vscode.WebviewView | undefined;
  private extensionUri: vscode.Uri = vscode.Uri.file('');
  private _windowStateRegistered: boolean = false;
  // VS Code 专有：虚拟文档管理（预览句柄由 DocumentManager 持有）
  private readonly documentManager: DocumentManager;

  constructor(private readonly outputChannel: vscode.OutputChannel) {
    this.documentManager = new DocumentManager(outputChannel);
  }

  // ===================== bootstrap 专用接线（不属于 UIHost）=====================

  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
  }

  setWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
  }

  registerWindowStateListener(_context: vscode.ExtensionContext): void {
    if (this._windowStateRegistered) {
      return;
    }
    this._windowStateRegistered = true;
    // 不再注册任何监听器
  }

  /** 设置显示内容虚拟文档的回调 */
  setShowContentInVirtualDocumentCallback(callback: (event: ShowContentInVirtualDocumentEvent) => void | Promise<void>): void {
    this.documentManager.setShowContentCallback(callback);
  }

  /** 设置显示 diff 虚拟文档的回调 */
  setShowDiffInVirtualDocumentCallback(callback: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>): void {
    this.documentManager.setShowDiffCallback(callback);
  }

  // ===================== UIHost 实现 =====================

  sendToWebview(message: WebviewMessage): void {
    try {
      this.webviewView?.webview.postMessage(message);
    } catch (err) {
      this.outputChannel?.appendLine(`[VSCodeUIHost] postToWebview error: ${err}`);
    }
  }

  // 单视图宿主：广播与直发都落到唯一的 webview（句柄不参与路由）
  broadcastToWebviews(message: WebviewMessage): void {
    this.sendToWebview(message);
  }

  sendToWebviewView(_view: WebviewViewHandle, message: WebviewMessage): void {
    this.sendToWebview(message);
  }

  // 单视图宿主：无论是否指定视图，都下发到唯一的 webview
  onThemeChanged(_view: WebviewViewHandle | null): void {
    this.sendToWebview({
      type: 'setTheme',
      theme: this.isDarkTheme() ? 'dark' : 'light',
    });
  }

  log(...args: unknown[]): void {
    this.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
  }

  getWorkspacePath(): string | undefined {
    return this.getWorkspaceRef()?.path;
  }

  /**
   * 当前工作区引用：取第一个工作区文件夹的 URI。
   *
   * VS Code 的 workspace URI 是取值的来源（`docs/core/client-connection.md` 第 4 节）：
   * `scheme` 取 URI 的 scheme，`endpoint` 由 authority 解析，`path` 取 URI 的 path。
   * 当前只支持本地（file）连接；非 file scheme 的 endpoint 只登记取值，不实现传输。
   */
  getWorkspaceRef(): WorkspaceRef | undefined {
    const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!uri) return undefined;
    return {
      scheme: uri.scheme,
      path: uri.fsPath,
      endpoint: uri.scheme === 'file' || !uri.authority
        ? null
        : { host: uri.authority, port: null, user: null, auth: null },
    };
  }

  /** VS Code 是单工作区宿主：打开集合至多一项 */
  getOpenWorkspaceRefs(): readonly WorkspaceRef[] {
    const ref = this.getWorkspaceRef();
    return ref ? [ref] : [];
  }

  /** 单视图宿主：任何视图都属于当前工作区（specs/023 FR-007 的过滤口径） */
  getWorkspaceRefForView(_view: WebviewViewHandle | null): WorkspaceRef | undefined {
    return this.getWorkspaceRef();
  }

  /** 工作区文件夹变化：第一个文件夹的换入 / 换出映射为 opened / closed */
  onWorkspaceChanged(listener: (change: WorkspaceChange) => void): () => void {
    let current = this.getWorkspaceRef();
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const next = this.getWorkspaceRef();
      if (current && (!next || !sameWorkspaceRef(current, next))) {
        listener({ type: 'closed', ref: current });
      }
      if (next && (!current || !sameWorkspaceRef(current, next))) {
        listener({ type: 'opened', ref: next });
      } else if (next) {
        listener({ type: 'activated', ref: next });
      }
      current = next;
    });
    return () => subscription.dispose();
  }

  isDarkTheme(): boolean {
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
  }

  getLocale(): string {
    return vscode.env.language;
  }

  async openFile(filePath: string, target: import('./host/UIHost.js').LineSelection | null): Promise<void> {
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
      this.outputChannel?.appendLine(
        `[VSCodeUIHost] openTextDocument failed, fallback to vscode.open: ${filePath} (${err})`
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
  }

  async showVirtualDocument(content: string, title: string): Promise<void> {
    const callback = (this.documentManager as any).onShowContentInVirtualDocumentCallback;
    if (typeof callback === 'function') {
      await callback({ content, title });
    } else {
      this.log('[VSCodeUIHost] Warning: No callback registered for showVirtualDocument');
    }
  }

  async showDiff(options: import('./host/UIHost.js').ShowDiffOptions): Promise<void> {
    await this.documentManager.showDiff(options as any);
  }

  async openMermaidPreview(code: string): Promise<void> {
    this.openMermaidPreviewPanel(code);
  }

  /**
   * VS Code 的编辑器 / 预览标签自身随文件更新，不需要宿主侧刷新通道。
   * 该成员存在是为了让 `WebViewUI` 的 CoreEvent 处理器有统一出口（specs/018）。
   */
  onWorkspaceFileChanged(_event: Extract<CoreEvent, { type: 'workspaceFileChanged' }>): void {
    // 有意 no-op：VS Code 宿主没有独立查看器窗口。
  }

  closePreview(): void {
    this.documentManager.closePreview();
  }

  async openExternalUrl(url: string): Promise<void> {
    try {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (err) {
      this.log(`[VSCodeUIHost] Failed to open external URL: ${err}`);
    }
  }

  async saveTextFile(content: string, options: import('./host/UIHost.js').SaveFileOptions): Promise<import('./host/UIHost.js').SaveFileResult> {
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
      this.log(`[VSCodeUIHost] saveTextFile failed: ${err}`);
      return { success: false, canceled: false, error: String(err) };
    }
  }

  /** 当前活跃会话读取器（bootstrap 注入，读 WebViewUI 维护的 UI 状态） */
  getActiveSessionId: () => string | undefined = () => undefined;

  // VS Code 是单视图，只有一个 webview，没有可关闭的会话视图：
  // webview 侧由 canCloseConversation(hostInfo) 判定为 false，不渲染关闭按钮 → 空实现
  async closeConversationView(): Promise<void> {
    /* 空实现 */
  }

  // settings.json 的写入口（core 只读不写；两个宿主共用同一份实现）
  updateSettingsJson(mutator: (cfg: Record<string, any>) => void | Record<string, any>): Promise<void> {
    return writeSettingsJson(mutator);
  }

  // ===================== VS Code 专有：Mermaid 预览面板 =====================

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
      panel.webview.html = getMermaidPreviewHtml(code, mermaidUri.toString(), this.isDarkTheme());
    } catch (err) {
      this.log(`[VSCodeUIHost] Mermaid preview error: ${err}`);
      panel.webview.html = getMermaidErrorHtml(code, String(err));
    }
  }
}

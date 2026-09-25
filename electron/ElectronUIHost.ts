/**
 * ElectronUIHost - Electron 侧的对话 webview 宿主能力实现（implements UIHost）
 *
 * 由原 ElectronUI 的宿主部分（sendToRenderer / 预览窗口 / 对话框）整体迁入。
 *
 * 本文件允许 import electron（宿主实现层是唯一允许 import 宿主 API 的地方）。
 */

import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { app, nativeTheme, dialog, BrowserWindow as BrowserWindowCtor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import type { ChatViewManager } from './ChatViewManager.js';
import type { UIHost } from '../src/host/UIHost.js';
import { WebviewViewHandle } from '../src/host/UIHost.js';
import type { WebviewMessage } from '../src/core/webviewTypes.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from '../src/host/mermaidHtml.js';
import { PRODUCT_NAME } from '../src/config/project.js';
import { isImageFile } from '../src/host/imageFiles.js';
import { writeProjectSettings, writeSettingsJson } from '../src/host/settingsFile.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');

export class ElectronUIHost implements UIHost {
  private mainWindow: BrowserWindow | undefined;
  private sidebarView: WebContentsView | undefined;
  private chatViews: ChatViewManager | undefined;
  /** 当前工作区路径（由 main 进程设置，用户通过菜单选择） */
  private workspacePath: string | undefined;
  /** 工作区变化订阅者（WorkspaceProvider.onDidChangeWorkspace） */
  private readonly workspaceListeners = new Set<(path: string | undefined) => void>();
  /** 复用的 Mermaid 预览窗口（与 VSCodeUIHost 的单面板语义一致） */
  private mermaidWindow: BrowserWindowCtor | undefined;

  /** 内部日志实现（console 前缀） */
  private writeLog(...args: unknown[]): void {
    const line = args.map(a => String(a)).join(' ');
    console.log(`[ElectronUIHost] ${line}`);
  }

  // ===================== bootstrap 专用接线（不属于 UIHost）=====================

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setSidebarView(view: WebContentsView): void {
    this.sidebarView = view;
  }

  setChatViewManager(m: ChatViewManager): void {
    this.chatViews = m;
    // 预热视图被切到前台：宿主组装并直发 activatePrewarmedView
    // （视图管理器不直连 webContents.send，投递统一走 UIHost 传输成员）
    m.onActivatePrewarmedView = (view) => {
      this.sendToWebviewView(new WebviewViewHandle(view.webContents), {
        type: 'activatePrewarmedView',
      });
    };
  }

  /**
   * bootstrap 接线：把来源视图对象包成对话视图句柄（不属于 UIHost 契约）。
   * 句柄由 `sendToWebviewView` 解包回 `WebContents` 后直发。
   */
  webviewHandleFor(source: WebContents): WebviewViewHandle {
    return new WebviewViewHandle(source);
  }

  setWorkspacePath(p: string | undefined): void {
    if (this.workspacePath === p) return;
    this.workspacePath = p;
    // 通知订阅者（WorkspaceProvider 契约）；单个订阅者抛错不影响其它订阅者
    for (const listener of [...this.workspaceListeners]) {
      try {
        listener(p);
      } catch (err) {
        this.writeLog(`workspace listener failed: ${err}`);
      }
    }
  }

  /** 推送消息到渲染进程：优先按 sessionId 路由到对应聊天视图，否则发给当前活动视图 */
  private sendToRenderer(message: Record<string, unknown>): void {
    const sessionId = message.sessionId as string | undefined;
    if (sessionId && this.chatViews?.sendTo(sessionId, message)) {
      return;
    }
    this.chatViews?.sendToActive(message);
  }

  // ===================== UIHost 实现 =====================

  sendToWebview(message: WebviewMessage): void {
    this.sendToRenderer(message as unknown as Record<string, unknown>);
  }

  /** 广播到所有已打开的聊天视图（含隐藏对话视图与后台预热视图） */
  broadcastToWebviews(message: WebviewMessage): void {
    this.chatViews?.broadcast(message);
  }

  /** 直发某个对话视图（句柄包裹该视图的 `WebContents`） */
  sendToWebviewView(view: WebviewViewHandle, message: WebviewMessage): void {
    const source = view.view as WebContents | undefined;
    if (source && !source.isDestroyed()) {
      source.send('webview-message', message);
    }
  }

  /** 下发主题：指定视图则直发，否则广播到所有对话视图 */
  onThemeChanged(view: WebviewViewHandle | null): void {
    const message: WebviewMessage = {
      type: 'setTheme',
      theme: this.isDarkTheme() ? 'dark' : 'light',
    };
    if (view) {
      this.sendToWebviewView(view, message);
      return;
    }
    this.broadcastToWebviews(message);
  }

  log(...args: unknown[]): void {
    this.writeLog(...args);
  }

  getWorkspacePath(): string | undefined {
    return this.workspacePath;
  }

  /**
   * 订阅工作区变化：订阅时立即回调当前值（WorkspaceProvider 契约），
   * 之后由 `setWorkspacePath`（菜单 / 命令行设置工作区）驱动。
   */
  onDidChangeWorkspace(listener: (path: string | undefined) => void): () => void {
    this.workspaceListeners.add(listener);
    listener(this.workspacePath);
    return () => {
      this.workspaceListeners.delete(listener);
    };
  }

  isDarkTheme(): boolean {
    return nativeTheme.shouldUseDarkColors;
  }

  getLocale(): string {
    // 与 VS Code 的 vscode.env.language 对齐：返回原始 BCP-47 标签（如 zh-CN / en-US），
    // 不做归一化。消费方（getSpinDesignHtml）按 startsWith('zh') 判断是否中文。
    return app.getLocale();
  }

  async openFile(filePath: string, target: import('../src/host/UIHost.js').LineSelection | null): Promise<void> {
    // 图片用内置图片预览窗口打开，避免 Monaco 按 utf-8 读取显示乱码
    if (isImageFile(filePath)) {
      this.openImagePreview(filePath);
      return;
    }
    // Monaco 编辑器窗口打开文件并定位到行
    await this.openMonacoWindow({
      mode: 'view',
      filePath,
      selectedLines: target ?? undefined,
      title: path.basename(filePath),
    });
  }

  async showVirtualDocument(content: string, title: string): Promise<void> {
    await this.openMonacoWindow({
      mode: 'content',
      content,
      title,
    });
  }

  /**
   * 空实现：Electron 没有「原生 diff」这个界面。
   * Edit / Write 的改动只在 webview 的工具卡片里渲染（第 7.2 节），
   * 桌面端不再重复开 Monaco diff 窗口（DEVELOPMENT.md 第 11.1 节 UIHost 对照表）。
   */
  async showDiff(): Promise<void> {
    /* 空实现：diff 归 webview */
  }

  async openMermaidPreview(code: string): Promise<void> {
    this.openMermaidWindow(code);
  }

  /**
   * 空实现：`closePreview` 关的是**宿主侧**预览（VS Code 是虚拟文档预览标签）。
   * Electron 的预览是独立的 Monaco / Mermaid 窗口，不属于「宿主预览」这个概念
   * ——它们由用户自行关闭，不随选择框响应等 UI 动作被连带关掉。
   */
  closePreview(): void {
    /* 空实现：Electron 没有宿主侧预览 */
  }

  async openExternalUrl(url: string): Promise<void> {
    try {
      const { shell } = await import('electron');
      await shell.openExternal(url);
    } catch (err) {
      this.log(`Failed to open external URL: ${err}`);
    }
  }

  async saveTextFile(content: string, options: import('../src/host/UIHost.js').SaveFileOptions): Promise<import('../src/host/UIHost.js').SaveFileResult> {
    const baseDir = this.getWorkspacePath() ?? app.getPath('home');
    const dialogOptions = {
      title: options?.title,
      defaultPath: path.join(baseDir, options?.defaultFileName ?? 'untitled.txt'),
      filters: options?.filters,
    };
    const win = BrowserWindowCtor.getFocusedWindow();
    const result = win
      ? await dialog.showSaveDialog(win, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    try {
      await fs.promises.writeFile(result.filePath, content, 'utf-8');
      return { success: true, filePath: result.filePath };
    } catch (err) {
      this.log(`saveTextFile failed: ${err}`);
      return { success: false, canceled: false, error: String(err) };
    }
  }

  /** 只销毁视图；abort 与 MCP 释放归 core（conversationClosed / MCPHost.onSessionClosed） */
  async closeConversationView(sessionId: string): Promise<void> {
    this.chatViews?.closeView(sessionId);
  }

  // settings.json 的写入口（core 只读不写；两个宿主共用同一份实现）
  updateSettingsJson(mutator: (cfg: Record<string, any>) => void | Record<string, any>): Promise<void> {
    return writeSettingsJson(mutator);
  }

  // 项目对话目录的 settings.json（记录 workspacePath）
  ensureProjectSettings(projectDir: string, workspacePath: string): Promise<void> {
    return writeProjectSettings(projectDir, workspacePath);
  }

  // ===================== Electron 专有：预览窗口 =====================

  /**
   * 打开图片预览窗口。
   *
   * 直接把 file:// URL 交给 Chromium 渲染：浏览器内置的图片查看器会自动
   * 居中、自适应缩放并支持缩放/拖动，比自建 <img> 页面更接近“默认图片预览”。
   */
  private openImagePreview(filePath: string): void {
    const win = new BrowserWindowCtor({
      width: 900,
      height: 700,
      title: path.basename(filePath),
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
      webPreferences: { sandbox: true },
    });

    const url = pathToFileURL(filePath).toString();
    win.loadURL(url).catch((err) => {
      this.log(`Failed to load image preview: ${filePath} (${err})`);
    });
  }

  /**
   * 打开 Monaco 编辑器窗口并发送初始化数据
   * view 模式由主进程读取文件内容；content 模式直接传入内容
   */
  private async openMonacoWindow(init: {
    mode: 'view' | 'content';
    filePath?: string;
    selectedLines?: { start: number; end: number };
    content?: string;
    title?: string;
  }): Promise<void> {
    const win = new BrowserWindowCtor({
      width: 1080,
      height: 720,
      title: init.title || PRODUCT_NAME,
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      // 兜底底色与 Monaco 的 vs / vs-dark 编辑器底色一致（见 electron/monaco/main.ts），
      // 页面加载完成前不闪另一种主题的色块
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'monacoPreload.cjs'),
      },
    });

    const indexPath = path.join(APP_ROOT, 'dist', 'monaco', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`Monaco page not found: ${indexPath}. Run npm run build:monaco`);
      return;
    }
    await win.loadFile(indexPath);

    // 读取文件内容（view 模式）
    const data: Record<string, unknown> = { ...init };
    if (init.mode === 'view' && init.filePath) {
      try {
        data.content = await fs.promises.readFile(init.filePath, 'utf-8');
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          data.content = '';
        } else {
          data.content = `// 无法读取文件: ${err.message}`;
        }
      }
    }

    // 注意：Electron 桌面端不维护「当前文件」上下文。
    // VS Code 有 activeTextEditor 的概念，可以自动把「当前文件 + 选中行」带进消息；
    // 桌面端没有等价物（打开 Monaco 只是查看文件内容，不代表用户要把它作为消息上下文），
    // 因此这里刻意不发送 setCurrentFile —— 工具结果里点文件链接、查看 diff 等
    // 任务操作都不应改变发消息时附带的文件信息。
    win.webContents.send('monaco-init', data);
  }

  /**
   * Mermaid 预览窗口：复用同一个窗口（与 VSCodeUIHost 的单面板语义一致），
   * 避免同一会话多次预览堆出一串窗口。
   */
  private openMermaidWindow(code: string): void {
    let win = this.mermaidWindow;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindowCtor({
        width: 1000,
        height: 700,
        title: 'Mermaid Preview',
        icon: path.join(APP_ROOT, 'assets', 'logo.png'),
        autoHideMenuBar: true,
        // 与 getMermaidPreviewHtml 的 body 底色一致（isDark ? '#1a1a1f' : '#ffffff'）
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1f' : '#ffffff',
        webPreferences: { sandbox: true },
      });
      this.mermaidWindow = win;
      win.on('closed', () => {
        if (this.mermaidWindow === win) this.mermaidWindow = undefined;
      });
    } else {
      win.focus();
    }

    const isDark = nativeTheme.shouldUseDarkColors;
    // 优先使用 dist/webview/assets/mermaid.min.js（与 VS Code 版本一致）
    const mermaidCandidates = [
      path.join(APP_ROOT, 'dist', 'webview', 'assets', 'mermaid.min.js'),
      path.join(APP_ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'),
    ];
    const mermaidSrc = mermaidCandidates.find((p) => fs.existsSync(p));
    try {
      // 直接加载预览页并从 file:// 引用本地 mermaid.min.js
      const mermaidUri = mermaidSrc ? `file:///${mermaidSrc.replace(/\\/g, '/')}` : '';
      win.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(getMermaidPreviewHtml(code, mermaidUri, isDark))
      );
    } catch (err) {
      win.loadURL(
        'data:text/html;charset=utf-8,' +
        encodeURIComponent(getMermaidErrorHtml(code, String(err)))
      );
    }
  }
}

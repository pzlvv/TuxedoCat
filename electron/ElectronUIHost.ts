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
import type { ChatViewManager } from './ChatViewManager.js';
import type { UIHost, WorkspaceChange } from '../src/host/UIHost.js';
import { WebviewViewHandle } from '../src/host/UIHost.js';
import type { WorkspaceRef, WorkspaceEndpoint } from '../src/host/workspaceRef.js';
import type { WebviewMessage } from '../src/host/webviewMessages.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from '../src/host/mermaidHtml.js';
import { getMarkdownPreviewHtml } from '../src/host/markdownHtml.js';
import { PRODUCT_NAME } from '../src/config/project.js';
import { isImageFile } from '../src/host/imageFiles.js';
import { fileLogger } from '../src/core/Logger.js';
import { writeSettingsJson } from '../src/host/settingsFile.js';
import { imageMimeFor } from './fileTypes.js';
import { remoteFileReaderFor } from './sidebarFilesRemote.js';
import { guardViewNavigation } from './viewNavigation.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');

/** 本地图片 → data URL（图片查看器窗口统一吃 data URL：本地 / 远程同一渲染路径） */
async function readImageAsDataUrl(filePath: string, log: (line: string) => void): Promise<string> {
  try {
    const bytes = await fs.promises.readFile(filePath);
    return `data:${imageMimeFor(filePath)};base64,${bytes.toString('base64')}`;
  } catch (err) {
    log(`Failed to read image for preview: ${filePath} (${err})`);
    // 读不出内容时回一个 1x1 透明像素，窗口仍可打开并显示缩放角标（不静默吞错）
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  }
}

export class ElectronUIHost implements UIHost {
  private mainWindow: BrowserWindow | undefined;
  private sidebarView: WebContentsView | undefined;
  private chatViews: ChatViewManager | undefined;
  /** 当前工作区引用（由 main 进程设置，用户通过菜单 / 标签页选择） */
  private workspaceRef: WorkspaceRef | undefined;
  /**
   * 工作区事实来源（main 进程注入）。
   *
   * Electron 是多工作区宿主：打开集合 / 活动项由 main 维护，Client 经本契约
   * 取得引用并订阅变化。未注入时退回 `workspaceRef`（单工作区语义）。
   */
  private workspaceSource: {
    getOpenWorkspaceRefs: () => readonly WorkspaceRef[];
    getActiveWorkspaceRef: () => WorkspaceRef | undefined;
    subscribe: (listener: (change: WorkspaceChange) => void) => () => void;
  } | null = null;
  /** 复用的 Mermaid 预览窗口（与 VSCodeUIHost 的单面板语义一致） */
  private mermaidWindow: BrowserWindowCtor | undefined;

  /** 内部日志实现（console 前缀 + 落盘：宿主诊断不进日志文件就查不到问题） */
  private writeLog(...args: unknown[]): void {
    const line = args.map(a => String(a)).join(' ');
    console.log(`[ElectronUIHost] ${line}`);
    // fileLogger 只落盘、不回推 UI，避免 logger → emitToUi → 本出口 的自环
    fileLogger.info('host', line);
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

  /**
   * 更新当前工作目录（标签页切换 / 关闭活动项后的移交 / 新增目录）。
   *
   * 只更新 `getWorkspacePath()` 的返回值：会话的工作目录由宿主在会话被 core
   * 解析目录之前按来源视图登记（见 main 的 registerCoreSessionWorkspace）。
   */
  setWorkspacePath(ref: WorkspaceRef | undefined): void {
    if (this.workspaceRef === ref) return;
    this.workspaceRef = ref;
  }

  /**
   * 注入工作区事实来源（main 进程的打开集合 / 活动项 / 变化订阅）。
   *
   * 必须在 `bootstrapCore` 之前调用：Client 按打开集合建立 Connection。
   */
  setWorkspaceSource(source: {
    getOpenWorkspaceRefs: () => readonly WorkspaceRef[];
    getActiveWorkspaceRef: () => WorkspaceRef | undefined;
    subscribe: (listener: (change: WorkspaceChange) => void) => () => void;
  }): void {
    this.workspaceSource = source;
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

  /** 当前工作区的 core 侧路径（本地路径 / 远程路径；未打开返回 undefined） */
  getWorkspacePath(): string | undefined {
    return this.getWorkspaceRef()?.path;
  }

  /** 当前工作区引用（本地 / 远程同构） */
  getWorkspaceRef(): WorkspaceRef | undefined {
    return this.workspaceSource?.getActiveWorkspaceRef() ?? this.workspaceRef;
  }

  /** 当前打开的工作区集合（按打开顺序；main 进程维护） */
  getOpenWorkspaceRefs(): readonly WorkspaceRef[] {
    return this.workspaceSource?.getOpenWorkspaceRefs() ?? [];
  }

  /** 订阅工作区打开 / 关闭 / 激活（main 进程经 setWorkspaceSource 注入） */
  onWorkspaceChanged(listener: (change: WorkspaceChange) => void): () => void {
    return this.workspaceSource?.subscribe(listener) ?? (() => undefined);
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
    // 远程工作区的文件链接（Read 工具卡片等）：路径是远端机上的 POSIX 绝对路径，
    // 本地盘读不到（ENOENT → 空编辑器）——先按打开集合里的远程工作区做前缀匹配，
    // 命中就走 SFTP 读出内容，进与本地同一套内置窗口
    const remote = this.resolveRemoteWorkspaceFile(filePath);
    if (remote) {
      await this.openRemoteFile(remote.endpoint, remote.abs);
      return;
    }
    // 图片用内置图片查看器打开，避免 Monaco 按 utf-8 读取显示乱码
    if (isImageFile(filePath)) {
      await this.openImagePreviewWindow({
        title: path.basename(filePath),
        dataUrl: await readImageAsDataUrl(filePath, this.log.bind(this)),
      });
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

  /**
   * 把文件路径解析到某个已打开的远程工作区内（活动项优先）。
   *
   * webview 发来的 filePath 是 core 读文件时的远端真实路径（POSIX 绝对路径）；
   * 只有落在某个远程工作区 root 内才按远程处理，否则维持本地语义
   * （本地工作区路径、跨盘的 Windows 路径都不会命中 `/` 前缀匹配）。
   */
  private resolveRemoteWorkspaceFile(filePath: string): { endpoint: WorkspaceEndpoint; abs: string } | null {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) return null;
    // 活动工作区优先：同一文件在多个工作区出现时按用户当前上下文解释
    const active = this.getWorkspaceRef();
    const refs = [
      ...(active ? [active] : []),
      ...this.getOpenWorkspaceRefs().filter((ref) => ref !== active),
    ];
    for (const ref of refs) {
      if (!ref.endpoint) continue;
      const root = ref.path.replace(/\/+$/, '');
      if (filePath === root || filePath.startsWith(`${root}/`)) {
        return { endpoint: ref.endpoint, abs: filePath };
      }
    }
    return null;
  }

  /** 经 SFTP 读远端文件并进内置窗口（文本 → Monaco，图片 → 查看器） */
  private async openRemoteFile(endpoint: NonNullable<WorkspaceRef['endpoint']>, abs: string): Promise<void> {
    const name = path.posix.basename(abs);
    const reader = remoteFileReaderFor(endpoint, (...args) => this.log(...args));
    try {
      if (isImageFile(name)) {
        const bytes = await reader.readBytes(abs);
        await this.openImagePreviewWindow({
          title: name,
          dataUrl: `data:${imageMimeFor(name)};base64,${bytes.toString('base64')}`,
        });
        return;
      }
      // Read 链接指向 core 读过的文件（图片在上面分支拦下），按 utf8 文本读
      const content = await reader.readText(abs);
      // filePath 只传文件名：Monaco 据此选语法，不读本地盘
      await this.openMonacoWindow({ mode: 'view', content, title: name, filePath: name });
    } catch (err) {
      // 读不到（断链 / 权限 / 已删除）也保持「点击有响应」：与本地 ENOENT 开空窗口
      // 的行为对齐，开 content 窗口显示原因，不让链接点下去毫无反馈
      this.log(`Failed to open remote file ${abs}: ${err}`);
      await this.openMonacoWindow({
        mode: 'content',
        title: name,
        content: `// 无法读取远程文件: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
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
   * Edit / Write 的改动只在 webview 的工具卡片里渲染（`docs/architecture/contracts.md` 第 7 节），
   * 桌面端不再重复开 Monaco diff 窗口（docs/hosts/host-matrix.md 第 12 节 UIHost 对照表）。
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

  // ===================== Electron 专有：预览窗口 =====================

  /**
   * 打开内置图片查看器窗口（`dist/imageViewer`）。
   *
   * 主进程把文件字节构造成 data URL 发给页面，页面自建 <img>：打开时适配窗口、
   * 滚轮以光标为锚缩放、放大后可拖动平移（此前是把 file:// URL 直接交给 Chromium，
   * 没有缩放能力）。图片内容只在构造 data URL 时读一次盘。
   */
  async openImagePreviewWindow(init: { title: string; dataUrl: string }): Promise<void> {
    const indexPath = path.join(APP_ROOT, 'dist', 'imageViewer', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`Image viewer page not found: ${indexPath}. Run npm run build:webview`);
      return;
    }
    const win = new BrowserWindowCtor({
      width: 900,
      height: 700,
      title: init.title || PRODUCT_NAME,
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
      webPreferences: {
        sandbox: false,
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'imageViewerPreload.cjs'),
      },
    });
    guardViewNavigation(win.webContents, 'image-viewer');
    await win.loadFile(indexPath);
    win.webContents.send('imageviewer-init', init);
  }

  /**
   * 打开内置 Markdown 预览窗口：侧栏双击 `.md` 文件进渲染视图而非源码文本。
   *
   * 与 Mermaid 预览同一模式——主进程纯函数（`src/host/markdownHtml.ts`）生成
   * 只读 HTML，经 data URL 装进沙箱窗口，页面无 preload、无脚本。内容在生成侧
   * 就净化（原生 HTML 片段转义、危险协议链接降级为纯文本），渲染器对文件内容
   * 零信任。
   */
  async openMarkdownPreviewWindow(init: { title: string; content: string }): Promise<void> {
    const isDark = nativeTheme.shouldUseDarkColors;
    const title = init.title || PRODUCT_NAME;
    const win = new BrowserWindowCtor({
      width: 1080,
      height: 720,
      title,
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      // 与 markdownHtml 的暗色底色一致：页面加载完成前不闪另一主题的色块
      backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
      webPreferences: { sandbox: true },
    });
    // 预览页里的 http(s) / mailto 链接是 target=_blank：不拦的话 Electron 会新开一个
    // 应用内窗口装外部页面（默认 setWindowOpenHandler 行为），这里统一交给系统浏览器
    guardViewNavigation(win.webContents, 'markdown-preview');
    const html = await getMarkdownPreviewHtml(init.content, { title, isDark });
    // base64 而非 encodeURIComponent：CJK 的百分号编码会 9 倍膨胀，轻易顶破
    // Chromium 对 data URL 的 ~2MB 上限；base64 只放大 4/3（超大文件仍会被
    // 上限拒之门外，与 Mermaid 预览同一约束）
    await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
  }

  /**
   * 打开 Monaco 编辑器窗口并发送初始化数据
   * view 模式：给了 content 直接用（远程文件经 SFTP 读出）；给了 filePath 由主进程读盘；
   * content 模式直接传入内容
   */
  async openMonacoWindow(init: {
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
    // 页面注入 monacoPreload（读盘 / 写文件）：同其他应用自有页面一样拒绝窗口内导航
    guardViewNavigation(win.webContents, 'monaco');

    const indexPath = path.join(APP_ROOT, 'dist', 'monaco', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`Monaco page not found: ${indexPath}. Run npm run build:monaco`);
      return;
    }
    await win.loadFile(indexPath);

    // 读取文件内容（view 模式；调用方已给 content 时直接用——远程文件不走本地盘）
    const data: Record<string, unknown> = { ...init };
    if (init.mode === 'view' && init.filePath && init.content === undefined) {
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
      // 图表内容来自模型（mermaid securityLevel 默认 strict，链接不可点）：
      // 仍拒绝窗口内导航，避免拖放 / 脚本把窗口带到外部页面
      guardViewNavigation(win.webContents, 'mermaid-preview');
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

/**
 * ElectronUIHost - Electron 侧的对话 webview 宿主能力实现（implements UIHost）
 *
 * 由原 ElectronUI 的宿主部分（sendToRenderer / 预览窗口 / 对话框）整体迁入。
 *
 * 本文件允许 import electron（宿主实现层是唯一允许 import 宿主 API 的地方）。
 */

import type { BrowserWindow, WebContents, WebContentsView } from 'electron';
import { app, nativeTheme, dialog, screen, BrowserWindow as BrowserWindowCtor } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ChatViewManager } from './ChatViewManager.js';
import type { UIHost, WorkspaceChange } from '../src/host/UIHost.js';
import type { CoreEvent } from '../src/shared/AssistantEventBus.js';
import { WebviewViewHandle } from '../src/host/UIHost.js';
import { workspaceRefKey, type WorkspaceRef, type WorkspaceEndpoint } from '../src/host/workspaceRef.js';
import { parseCreatedFilePath, resolveToolWorkspace } from './toolResultSideEffects.js';
import type { WebviewMessage } from '../src/host/webviewMessages.js';
import { getMermaidErrorHtml, getMermaidPreviewHtml } from '../src/host/mermaidHtml.js';
import { getMarkdownPreviewBodyHtml, getMarkdownPreviewHtml } from '../src/host/markdownHtml.js';
import { PRODUCT_NAME } from '../src/config/project.js';
import { isImageFile } from '../src/host/imageFiles.js';
import { fileLogger } from '../src/shared/Logger.js';
import { writeSettingsJson } from '../src/host/settingsFile.js';
import { watchWorkspaceFile, unwatchWorkspaceFile } from '../src/host/coreFacts.js';
import { tt } from '../src/host/i18n.js';
import { imageMimeFor } from './fileTypes.js';
import { remoteFileReaderFor, sharedClientFor } from './sidebarFilesRemote.js';
import { localGitRunner } from './sidebarDocView.js';
import { DocSentinelManager } from './sidebarDocWatch.js';
import { createLocalFileWatcher } from './localFileWatch.js';
import {
  ViewerWatchController,
  type ViewerContent,
  type ViewerKind,
  type ViewerMarker,
  type ViewerWatchTarget,
} from './viewerWatch.js';
import { guardViewNavigation } from './viewNavigation.js';
import { readWorkspaceState, writeWorkspaceState } from './workspaceStateStore.js';
import {
  loadSlotRect,
  planViewerSlotBounds,
  saveSlotRect,
  trackWindowRect,
  type RectStateStore,
  type SlotBounds,
} from './viewerWindowRect.js';

/** 项目根目录（dist-electron 的上一级，与 main.ts 的 APP_ROOT 一致） */
const APP_ROOT = path.resolve(__dirname, '..');

/** workspace-state 读写口（viewerWindowRect 纯函数模块的注入点） */
const rectStateStore: RectStateStore = {
  readState: readWorkspaceState,
  writeState: writeWorkspaceState,
};

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
  /** 会话 → 工作区根的查询（main 进程注入；main.ts `sessionWorkspaces` 索引的投影） */
  private sessionWorkspaceLookup: ((sessionId: string) => string | null) | null = null;
  /** 复用的 Mermaid 预览窗口（与 VSCodeUIHost 的单面板语义一致） */
  private mermaidWindow: BrowserWindowCtor | undefined;
  /**
   * 查看器窗口名额的当前占用者（Monaco / 图片 / Markdown 共用；specs/016 FR-002）。
   * 新的打开请求先顶替它（销毁重建，继承其矩形），桌面同时至多一个查看器窗口；
   * Mermaid 预览与 Spin 设计器不占该名额。
   */
  private viewerWindow: BrowserWindowCtor | undefined;
  /** 当前查看器窗口的文件监听控制器（specs/018）；与查看器名额同生命周期 */
  private viewerWatch: ViewerWatchController | undefined;

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

  /** 会话 → 工作区根查询接线（specs/030 FR-001：toolResult 相对路径的展开基准） */
  setSessionWorkspaceLookup(lookup: (sessionId: string) => string | null): void {
    this.sessionWorkspaceLookup = lookup;
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

  /**
   * 视图所属工作区引用（specs/023 FR-007）：按聊天视图登记的归属解析，
   * 解析不出时退回活动工作区。
   */
  getWorkspaceRefForView(view: WebviewViewHandle | null): WorkspaceRef | undefined {
    if (!view) return this.getWorkspaceRef();
    const webContents = view.view as WebContents;
    const path = this.chatViews?.getWorkspaceForWebContents(webContents);
    if (!path) return this.getWorkspaceRef();
    return this.getOpenWorkspaceRefs().find((ref) => ref.path === path) ?? this.getWorkspaceRef();
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
      await this.openRemoteFile(remote.endpoint, remote.workspacePath, remote.abs);
      return;
    }
    // 图片用内置图片查看器打开，避免 Monaco 按 utf-8 读取显示乱码
    if (isImageFile(filePath)) {
      await this.openImagePreviewWindow({
        title: path.basename(filePath),
        dataUrl: await readImageAsDataUrl(filePath, this.log.bind(this)),
        watchTarget: { kind: 'local', filePath },
      });
      return;
    }
    // Monaco 编辑器窗口打开文件并定位到行
    await this.openMonacoWindow({
      mode: 'view',
      filePath,
      selectedLines: target ?? undefined,
      title: path.basename(filePath),
      watchTarget: { kind: 'local', filePath },
    });
  }

  /**
   * 把文件路径解析到某个已打开的远程工作区内（活动项优先）。
   *
   * webview 发来的 filePath 是 core 读文件时的远端真实路径（POSIX 绝对路径）；
   * 只有落在某个远程工作区 root 内才按远程处理，否则维持本地语义
   * （本地工作区路径、跨盘的 Windows 路径都不会命中 `/` 前缀匹配）。
   */
  private resolveRemoteWorkspaceFile(filePath: string): {
    endpoint: WorkspaceEndpoint;
    workspacePath: string;
    abs: string;
  } | null {
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
        return { endpoint: ref.endpoint, workspacePath: ref.path, abs: filePath };
      }
    }
    return null;
  }

  /** 经 SFTP 读远端文件并进内置窗口（文本 → Monaco，图片 → 查看器） */
  private async openRemoteFile(
    endpoint: NonNullable<WorkspaceRef['endpoint']>,
    workspacePath: string,
    abs: string,
  ): Promise<void> {
    const name = path.posix.basename(abs);
    const reader = remoteFileReaderFor(endpoint, (...args) => this.log(...args));
    const watchTarget: ViewerWatchTarget = {
      kind: 'remote',
      endpoint,
      workspacePath,
      absPath: abs,
    };
    try {
      if (isImageFile(name)) {
        const bytes = await reader.readBytes(abs);
        await this.openImagePreviewWindow({
          title: name,
          dataUrl: `data:${imageMimeFor(name)};base64,${bytes.toString('base64')}`,
          watchTarget,
        });
        return;
      }
      // Read 链接指向 core 读过的文件（图片在上面分支拦下），按 utf8 文本读
      const content = await reader.readText(abs);
      // filePath 只传文件名：Monaco 据此选语法，不读本地盘
      await this.openMonacoWindow({
        mode: 'view',
        content,
        title: name,
        filePath: name,
        watchTarget,
      });
    } catch (err) {
      // 读不到（断链 / 权限 / 已删除）也保持「点击有响应」：与本地 ENOENT 开空窗口
      // 的行为对齐，开 content 窗口显示原因，不让链接点下去毫无反馈
      this.log(`Failed to open remote file ${abs}: ${err}`);
      await this.openMonacoWindow({
        mode: 'content',
        title: name,
        content: `// 无法读取远程文件: ${err instanceof Error ? err.message : String(err)}`,
        watchTarget: null,
      });
    }
  }

  async showVirtualDocument(content: string, title: string): Promise<void> {
    await this.openMonacoWindow({
      mode: 'content',
      content,
      title,
      watchTarget: null,
    });
  }

  /**
   * 空实现：Electron 没有「原生 diff」这个界面。
   * Edit / Write 的改动只在 webview 的工具卡片里渲染（`docs/architecture/host-ui-modules.md` 第 2 节），
   * 桌面端不再重复开 Monaco diff 窗口（docs/hosts/host-matrix.md 第 6 节 UIHost 对照表）。
   */
  async showDiff(): Promise<void> {
    /* 空实现：diff 归 webview */
  }

  async openMermaidPreview(code: string): Promise<void> {
    this.openMermaidWindow(code);
  }

  /**
   * Core 上报远程工作区文件变化（specs/018 FR-002）。
   * 查看器监听控制器在 T007 接入；接入前保持可编译的显式出口，不做静默分支。
   */
  onWorkspaceFileChanged(event: Extract<CoreEvent, { type: 'workspaceFileChanged' }>): void {
    // 哨兵优先分流（specs/030 文档视图刷新）：命中的 watchId 不进查看器路由
    if (this.docSentinels?.handleWatchEvent(event.watchId) === true) return;
    this.viewerWatch?.handleCoreEvent(event);
  }

  /**
   * Core 上报工具执行结果（specs/030 FR-001）。
   * 只观察「Write 成功新建文件」这一个形态：解析输出首行路径（相对路径按会话工作区
   * 根展开），落在某个打开工作区内时向侧栏推 `sidebar:files-invalidate` 刷新该工作区
   * 的文件树。文档视图的自动刷新不经此链（git 哨兵监听承担，
   * `electron/sidebarDocWatch.ts`）。解析不到归属（集合外 / 索引查不到的相对路径）
   * 是设计允许的 no-op。
   */
  onToolResult(event: Extract<CoreEvent, { type: 'toolResult' }>): void {
    const pathText = parseCreatedFilePath(event.toolName, event.status, event.output);
    if (pathText === null) return;
    const refs = this.getOpenWorkspaceRefs();
    const openRoots = refs.map((ref) => ({ root: ref.path, remote: ref.endpoint !== null }));
    const sessionRoot = this.sessionWorkspaceLookup?.(event.sessionId) ?? null;
    const hit = resolveToolWorkspace(pathText, sessionRoot, openRoots);
    if (!hit) return;
    this.pushFilesInvalidate(workspaceRefKey(refs[openRoots.indexOf(hit)]), ['tree']);
  }

  /** 侧栏失效信号推送（specs/030）：Write 新建（tree）与 git 哨兵（doc）共用一个出口 */
  private pushFilesInvalidate(workspaceId: string, reasons: string[]): void {
    const webContents = this.sidebarView?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.send('sidebar:files-invalidate', { workspaceId, reasons });
    }
  }

  // ── 文档视图 git 哨兵（specs/030 FR-003）───────────────────────────────────

  private docSentinels: DocSentinelManager | undefined;

  private getDocSentinels(): DocSentinelManager {
    this.docSentinels ??= new DocSentinelManager({
      resolveGitDir: async (workspacePath, endpoint) => {
        const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
        try {
          if (endpoint !== null) {
            const client = await sharedClientFor(endpoint, (...args) => this.writeLog(...args));
            const out = await client.exec(`git -C ${shQuote(workspacePath)} rev-parse --absolute-git-dir`);
            return out.code === 0 ? out.stdout.trim() : null;
          }
          const out = await localGitRunner(workspacePath).run(['rev-parse', '--absolute-git-dir']);
          return out.code === 0 ? out.stdout.trim() : null;
        } catch (err) {
          this.writeLog('doc sentinel: resolve git dir failed:', err);
          return null;
        }
      },
      watchDir: (dir, onChange) =>
        new Promise((resolve) => {
          try {
            const watcher = fs.watch(dir, () => onChange());
            resolve(() => watcher.close());
          } catch (err) {
            this.writeLog(`doc sentinel: watch failed (${dir}):`, err);
            resolve(null);
          }
        }),
      watchRemote: (request) => watchWorkspaceFile(request),
      unwatchRemote: (request) => unwatchWorkspaceFile(request),
      onInvalidate: (workspaceId) => this.pushFilesInvalidate(workspaceId, ['doc']),
      log: (...args) => this.writeLog(...args),
    });
    return this.docSentinels;
  }

  /** 文档视图开关状态（渲染层经 IPC 上报；workspaceId 是 refKey） */
  async setDocSentinel(workspaceId: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.docSentinels?.disable(workspaceId);
      return;
    }
    const hit = this.getOpenWorkspaceRefs().find((ref) => workspaceRefKey(ref) === workspaceId);
    if (!hit) return; // 工作区不在打开集合：不监听（渲染层状态会在集合变化时丢弃）
    await this.getDocSentinels().enable(workspaceId, hit.path, hit.endpoint);
  }

  /** 工作区关闭：哨兵随之摘除（main 的 emitWorkspaceChange 订阅调用） */
  async stopDocSentinelFor(ref: WorkspaceRef): Promise<void> {
    await this.docSentinels?.disable(workspaceRefKey(ref));
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
   * 没有缩放能力）。图片内容在打开与刷新时读盘（specs/018）。
   */
  /**
   * 取得查看器窗口名额并返回新窗口的初始矩形（specs/016 FR-002 / FR-003）。
   *
   * 存活占用者被顶替：先补记其矩形（destroy 不触发 close），销毁后由新窗口继承；
   * 无存活窗口时用状态文件里记忆的矩形（多屏校验失败回退 undefined → 默认尺寸）。
   */
  private takeViewerSlot(): SlotBounds | undefined {
    const alive = this.viewerWindow && !this.viewerWindow.isDestroyed() ? this.viewerWindow : undefined;
    const workAreas = screen.getAllDisplays().map(({ workArea }) => workArea);
    const savedRect = loadSlotRect(rectStateStore, 'viewerWindowRect');
    if (!alive) {
      return planViewerSlotBounds({ savedRect, workAreas });
    }
    // 顶替：被替窗口的矩形先落盘再销毁（destroy 不触发 close，close 补记不会发生）
    const bounds = alive.getNormalBounds();
    saveSlotRect(rectStateStore, 'viewerWindowRect', bounds);
    this.viewerWatch?.close();
    alive.destroy();
    this.viewerWindow = undefined;
    return planViewerSlotBounds({
      liveBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      savedRect,
      workAreas,
    });
  }

  /** 把名额矩形转成 BrowserWindow 构造参数（位置缺失时交给 OS 默认摆放） */
  private static slotBoundsToOptions(bounds: SlotBounds | undefined, defaultWidth: number, defaultHeight: number): {
    width: number;
    height: number;
    x?: number;
    y?: number;
  } {
    if (!bounds) return { width: defaultWidth, height: defaultHeight };
    const base: { width: number; height: number; x?: number; y?: number } = {
      width: bounds.width,
      height: bounds.height,
    };
    if (bounds.x !== undefined && bounds.y !== undefined) {
      base.x = bounds.x;
      base.y = bounds.y;
    }
    return base;
  }

  /** 登记查看器名额占用者：矩形防抖落盘 + 用户关闭补记 + closed 清引用 */
  private trackViewerWindow(win: BrowserWindowCtor): void {
    this.viewerWindow = win;
    trackWindowRect(win, rectStateStore, 'viewerWindowRect');
    win.on('closed', () => {
      // 顶替时旧窗口的 closed 可能晚于新窗口登记：只有当前名额占用者才停监听，
      // 否则会把新查看器的监听一起关掉。
      if (this.viewerWindow !== win) return;
      this.viewerWindow = undefined;
      this.viewerWatch?.close();
    });
  }

  // ── 查看器文件监听（specs/018）────────────────────────────────────────────

  private getViewerWatchController(): ViewerWatchController {
    this.viewerWatch ??= new ViewerWatchController({
      watchRemote: (request) => watchWorkspaceFile(request),
      unwatchRemote: (request) => unwatchWorkspaceFile(request),
      readContent: (target, kind) => this.readViewerContent(target, kind),
      deliver: (target, kind, content) => this.deliverViewerContent(target, kind, content),
      setTitle: (title) => this.setViewerTitle(title),
      markerText: (marker) => ElectronUIHost.markerText(marker),
      createLocalWatcher: (filePath, onEvent) =>
        createLocalFileWatcher(filePath, onEvent, (...args) => this.writeLog(...args)),
      makeWatchId: () => randomUUID(),
      log: (...args) => this.writeLog(...args),
    });
    return this.viewerWatch;
  }

  /** 开窗完成后启动监听；`watchTarget: null`（虚拟文档 / diff）不监听。 */
  private startViewerWatch(
    target: ViewerWatchTarget | null,
    kind: ViewerKind,
    baseTitle: string,
    initialContent: ViewerContent,
  ): void {
    if (!target) {
      this.viewerWatch?.close();
      return;
    }
    this.getViewerWatchController().open(target, kind, baseTitle, initialContent);
  }

  private static markerText(marker: ViewerMarker): string {
    switch (marker) {
      case 'deleted':
        return tt('（文件已删除）', ' (file deleted)');
      case 'read-failed':
        return tt('（读取失败）', ' (read failed)');
      case 'auto-refresh-unavailable':
        return tt('（自动刷新不可用）', ' (auto-refresh unavailable)');
    }
  }

  private setViewerTitle(title: string): void {
    const win = this.viewerWindow;
    if (!win || win.isDestroyed()) return;
    win.setTitle(title);
    win.webContents.send('viewer-title', { title });
  }

  private async readViewerContent(
    target: ViewerWatchTarget,
    kind: ViewerKind,
  ): Promise<ViewerContent> {
    if (target.kind === 'local') {
      if (kind === 'image') {
        const bytes = await fs.promises.readFile(target.filePath);
        return {
          kind: 'image',
          dataUrl: `data:${imageMimeFor(target.filePath)};base64,${bytes.toString('base64')}`,
        };
      }
      return { kind: 'text', text: await fs.promises.readFile(target.filePath, 'utf-8') };
    }
    const reader = remoteFileReaderFor(target.endpoint, (...args) => this.writeLog(...args));
    if (kind === 'image') {
      const bytes = await reader.readBytes(target.absPath);
      return {
        kind: 'image',
        dataUrl: `data:${imageMimeFor(target.absPath)};base64,${bytes.toString('base64')}`,
      };
    }
    return { kind: 'text', text: await reader.readText(target.absPath) };
  }

  private async deliverViewerContent(
    _target: ViewerWatchTarget,
    kind: ViewerKind,
    content: ViewerContent,
  ): Promise<void> {
    const win = this.viewerWindow;
    if (!win || win.isDestroyed()) return;
    if (kind === 'image' && content.kind === 'image') {
      win.webContents.send('imageviewer-refresh', { dataUrl: content.dataUrl });
      return;
    }
    if (kind === 'markdown' && content.kind === 'text') {
      const bodyHtml = await getMarkdownPreviewBodyHtml(content.text);
      if (win.isDestroyed()) return;
      win.webContents.send('markdown-refresh', { bodyHtml });
      return;
    }
    if (kind === 'text' && content.kind === 'text') {
      win.webContents.send('monaco-refresh', { content: content.text });
    }
  }

  /** Connection 就绪（含 Core 重启 / 快照重推）：重注册当前远程查看器监听 */
  onWorkspaceConnectionReady(ref: WorkspaceRef): void {
    this.viewerWatch?.handleConnectionReady(ref);
  }

  async openImagePreviewWindow(init: {
    title: string;
    dataUrl: string;
    watchTarget: ViewerWatchTarget | null;
  }): Promise<void> {
    const indexPath = path.join(APP_ROOT, 'dist', 'imageViewer', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`Image viewer page not found: ${indexPath}. Run npm run build:webview`);
      return;
    }
    const title = init.title || PRODUCT_NAME;
    const win = new BrowserWindowCtor({
      ...ElectronUIHost.slotBoundsToOptions(this.takeViewerSlot(), 900, 700),
      title,
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
    this.trackViewerWindow(win);
    win.webContents.send('imageviewer-init', { title, dataUrl: init.dataUrl });
    this.startViewerWatch(init.watchTarget, 'image', title, {
      kind: 'image',
      dataUrl: init.dataUrl,
    });
  }

  /**
   * 打开内置 Markdown 预览窗口：侧栏双击 `.md` 文件进渲染视图而非源码文本。
   *
   * 与 Mermaid 预览同一模式——主进程纯函数（`src/host/markdownHtml.ts`）生成
   * 只读 HTML，经 data URL 装进沙箱窗口；页面没有内联脚本，只带一个负责刷新
   * `.markdown-body` 的 preload。内容在生成侧就净化（原生 HTML 片段转义、危险协议
   * 链接降级为纯文本），渲染器对文件内容零信任。
   */
  async openMarkdownPreviewWindow(init: {
    title: string;
    content: string;
    watchTarget: ViewerWatchTarget | null;
  }): Promise<void> {
    const isDark = nativeTheme.shouldUseDarkColors;
    const title = init.title || PRODUCT_NAME;
    const win = new BrowserWindowCtor({
      ...ElectronUIHost.slotBoundsToOptions(this.takeViewerSlot(), 1080, 720),
      title,
      icon: path.join(APP_ROOT, 'assets', 'logo.png'),
      autoHideMenuBar: true,
      // 与 markdownHtml 的暗色底色一致：页面加载完成前不闪另一主题的色块
      backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
      webPreferences: {
        sandbox: true,
        preload: path.join(__dirname, 'markdownPreload.cjs'),
      },
    });
    // 预览页里的 http(s) / mailto 链接是 target=_blank：不拦的话 Electron 会新开一个
    // 应用内窗口装外部页面（默认 setWindowOpenHandler 行为），这里统一交给系统浏览器
    guardViewNavigation(win.webContents, 'markdown-preview');
    const html = await getMarkdownPreviewHtml(init.content, { title, isDark });
    // base64 而非 encodeURIComponent：CJK 的百分号编码会 9 倍膨胀，轻易顶破
    // Chromium 对 data URL 的 ~2MB 上限；base64 只放大 4/3（超大文件仍会被
    // 上限拒之门外，与 Mermaid 预览同一约束）
    await win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
    this.trackViewerWindow(win);
    this.startViewerWatch(init.watchTarget, 'markdown', title, {
      kind: 'text',
      text: init.content,
    });
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
    watchTarget: ViewerWatchTarget | null;
  }): Promise<void> {
    // 页面产物缺失时不占名额（不顶替已有查看器窗口），维持「log + 不开窗」的现状
    const indexPath = path.join(APP_ROOT, 'dist', 'monaco', 'index.html');
    if (!fs.existsSync(indexPath)) {
      this.log(`Monaco page not found: ${indexPath}. Run npm run build:monaco`);
      return;
    }
    const title = init.title || PRODUCT_NAME;
    const win = new BrowserWindowCtor({
      ...ElectronUIHost.slotBoundsToOptions(this.takeViewerSlot(), 1080, 720),
      title,
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

    await win.loadFile(indexPath);
    this.trackViewerWindow(win);

    // 读取文件内容（view 模式；调用方已给 content 时直接用——远程文件不走本地盘）
    const { watchTarget, ...monacoInit } = init;
    const data: Record<string, unknown> = { ...monacoInit };
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
    if (init.mode === 'view' && watchTarget) {
      this.startViewerWatch(watchTarget, 'text', title, {
        kind: 'text',
        text: typeof data.content === 'string' ? data.content : '',
      });
    } else {
      this.viewerWatch?.close();
    }
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

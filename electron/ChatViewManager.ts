/**
 * ChatViewManager - 右侧聊天标签页管理
 *
 * 每个对话对应一个独立的 WebContentsView（保留各自的聊天状态），
 * 点击侧栏对话时切换显示（add/remove ChildView，不销毁页面）。
 *
 * 布局：
 *   ┌──────────┬──────────────────────────────┐
 *   │ sidebar  │ chat view (当前对话)          │
 *   │ 280px    │                              │
 *   └──────────┴──────────────────────────────┘
 */

import { BrowserWindow, WebContents, WebContentsView, Rectangle, shell } from 'electron';
import * as path from 'path';

export const SIDEBAR_WIDTH = 280;
/** 与主窗口 backgroundColor 一致，避免 webview 加载期间白屏闪烁 */
export const CHAT_VIEW_BACKGROUND = '#16161b';

/**
 * 判断 URL 是否为需要在系统浏览器打开的外部链接。
 * 内部链接（应用自身 file:// 页面、相对路径）不算外部链接。
 */
function isExternalUrl(targetUrl: string): boolean {
  return /^(https?|mailto|tel):/i.test(targetUrl);
}

export interface ChatViewManagerOptions {
  win: BrowserWindow;
  appRoot: string;
  preloadPath: string;
  workspacePath: string;
  locale: string;
  systemLocale: string;
  /** 用户显式选择的界面语言（'auto' | 'zh' | 'en'），随 --uiLanguage 注入 webview */
  uiLanguage?: 'auto' | 'zh' | 'en';
  onActiveSessionChanged: (sessionId: string | null) => void;
  onViewCreated?: (view: WebContentsView) => void;
}

export class ChatViewManager {
  /** sessionId -> view；新建会话使用 `new-<timestamp>` 临时 key，webview 上报后关联 */
  private views = new Map<string, WebContentsView>();
  private lru: string[] = [];
  private currentSessionId: string | null = null;
  private readonly maxViews = 12;
  private readonly opts: ChatViewManagerOptions;
  /** 会话是否正在等待用户输入（ask user / 权限确认）的判定，由 ElectronUI 注入 */
  private waitingForUserProvider: ((sessionId: string) => boolean) | null = null;

  constructor(opts: ChatViewManagerOptions) {
    this.opts = opts;
  }

  /** 注册"会话是否正在等待用户输入"判定（用于侧栏黄色流水灯） */
  setWaitingForUserProvider(fn: (sessionId: string) => boolean): void {
    this.waitingForUserProvider = fn;
  }

  /** 更新工作区路径（工作区变化后新建的视图会携带新 --workspace= 参数） */
  setWorkspacePath(p: string): void {
    this.opts.workspacePath = p;
  }

  private chatBounds(): Rectangle {
    const [w, h] = this.opts.win.getContentSize();
    return { x: SIDEBAR_WIDTH, y: 0, width: Math.max(320, w - SIDEBAR_WIDTH), height: h };
  }

  getActiveSessionId(): string | null {
    return this.currentSessionId;
  }

  /** 当前活动聊天视图的 webContents（用于打开 DevTools 等） */
  getActiveWebContents(): WebContents | undefined {
    if (!this.currentSessionId) return undefined;
    const view = this.views.get(this.currentSessionId);
    if (view && !view.webContents.isDestroyed()) {
      return view.webContents;
    }
    return undefined;
  }

  /** 当前已加载（有活动视图）的真实会话 ID 列表（排除新建中的临时 key） */
  getLoadedSessionIds(): string[] {
    return [...this.views.keys()].filter((key) => {
      const view = this.views.get(key);
      return !key.startsWith('new-') && !!view && !view.webContents.isDestroyed();
    });
  }

  /**
   * 侧栏对话列表：仅磁盘历史（已发送过消息的对话）+ loaded/running 标记。
   * 新建对话（messageCount === 0）尚未落盘，loadConversationList 不会包含它，
   * 因此用户发送第一条消息前，侧栏不显示任何新项；首条消息落盘后
   * 由 ElectronUI.onMessage 触发的 refreshSidebarThrottled 拉取到最新列表。
   * running 标记用于侧栏流水灯效果（非 idle 的会话）。
   */
  async getSidebarConversations(): Promise<Array<Record<string, unknown>>> {
    const { loadConversationList } = await import('../src/core/history/index.js');
    const list = (await loadConversationList()) as unknown as Array<Record<string, unknown>>;
    const loadedIds = new Set(this.getLoadedSessionIds());
    const { getSessionEngine } = await import('../src/core/QueryEngine.js');

    return list.map((c) => {
      const sid = c.sessionId as string;
      const engine = getSessionEngine(sid);
      return {
        ...c,
        loaded: loadedIds.has(sid),
        running: !!engine?.isConsumerRunning,
        // 正在等待用户输入（ask user / 权限确认）→ 侧栏流水灯显示黄色
        waitingForUser: this.waitingForUserProvider ? !!this.waitingForUserProvider(sid) : false,
      };
    });
  }

  /** 打开（或切换）指定会话的聊天视图 */
  openConversation(sessionId: string): void {
    let view = this.views.get(sessionId);
    if (!view || view.webContents.isDestroyed()) {
      // 视图已被销毁（如用户点击关闭按钮）但仍残留在 map 中时，清理后重建
      if (view) {
        this.views.delete(sessionId);
        this.lru = this.lru.filter((k) => k !== sessionId);
      }
      view = this.createView(sessionId);
      this.views.set(sessionId, view);
    }
    this.touch(sessionId);
    this.show(sessionId);
    // 会话被打开：建立 MCP 引用（幂等，重复打开不会重复计数）
    this.acquireMcp(sessionId);
  }

  /** 新建对话：打开一个无 session 的聊天视图，webview onStartup 生成会话后关联 */
  openNewConversation(): void {
    const key = `new-${Date.now()}`;
    const view = this.createView(undefined);
    this.views.set(key, view);
    this.touch(key);
    this.show(key);
  }

  /**
   * 将来源 webContents 关联到 sessionId（webview 上报 setActiveSessionId/startNewConversation 时调用）
   * 处理新建对话场景：临时 key 的 view 在 webview 生成 session 后转为正式条目
   */
  registerSession(webContents: WebContents, sessionId: string): void {
    // 找到包含该 webContents 的临时条目
    const tempKey = [...this.views.keys()].find((key) => {
      const v = this.views.get(key);
      return v && !v.webContents.isDestroyed() && v.webContents.id === webContents.id;
    });
    if (!tempKey || tempKey === sessionId) return;

    const view = this.views.get(tempKey)!;
    this.views.delete(tempKey);
    this.lru = this.lru.filter((k) => k !== tempKey);

    // 如果目标 sessionId 已有视图（如历史会话被重新打开），销毁旧视图避免重复
    const existing = this.views.get(sessionId);
    if (existing && existing !== view && !existing.webContents.isDestroyed()) {
      this.opts.win.contentView.removeChildView(existing);
      existing.webContents.close();
    }
    this.views.set(sessionId, view);
    this.lru.push(sessionId);
    if (this.currentSessionId === tempKey) {
      this.currentSessionId = sessionId;
      this.opts.onActiveSessionChanged(sessionId);
    }
    this.trim();
    // 新对话首次上报正式 sessionId：建立 MCP 引用（临时 new- key 不参与引用）
    this.acquireMcp(sessionId);
  }

  /** 按 sessionId 发送消息到对应视图 */
  sendTo(sessionId: string | undefined, message: unknown): boolean {
    if (sessionId) {
      const view = this.views.get(sessionId);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.send('webview-message', message);
        return true;
      }
    }
    return false;
  }

  /** 发送消息到当前活动视图 */
  sendToActive(message: unknown): void {
    const active = this.currentSessionId ? this.views.get(this.currentSessionId) : undefined;
    if (active && !active.webContents.isDestroyed()) {
      active.webContents.send('webview-message', message);
    }
  }

  /** 通知所有聊天视图（如主题变化） */
  broadcast(message: unknown): void {
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('webview-message', message);
      }
    }
  }

  /** 窗口尺寸变化时更新当前视图布局 */
  layout(): void {
    const active = this.currentSessionId ? this.views.get(this.currentSessionId) : undefined;
    if (active && !active.webContents.isDestroyed()) {
      active.setBounds(this.chatBounds());
    }
  }

  /** 清空所有聊天视图（工作区切换等场景） */
  disposeAll(): void {
    for (const key of [...this.views.keys()]) {
      // 销毁视图前先中止该会话正在运行的查询（工作区切换 / 退出场景）
      this.abortSession(key);
      const view = this.views.get(key);
      if (view && !view.webContents.isDestroyed()) {
        this.opts.win.contentView.removeChildView(view);
        view.webContents.close();
      }
      this.releaseMcp(key);
    }
    this.views.clear();
    this.lru = [];
    this.currentSessionId = null;
  }

  /**
   * 根据来源 webContents 关闭对应聊天视图（webview 右上角关闭按钮触发）。
   * 销毁渲染进程并释放资源；返回被关闭的 sessionId，找不到时返回 null。
   */
  closeViewByWebContents(webContents: WebContents): string | null {
    const sessionId = [...this.views.keys()].find((key) => {
      const view = this.views.get(key);
      return view && !view.webContents.isDestroyed() && view.webContents.id === webContents.id;
    });
    if (!sessionId) return null;
    this.closeView(sessionId);
    return sessionId;
  }

  /** 销毁指定会话的聊天视图（移除 ChildView + 关闭 webContents，释放渲染进程资源） */
  closeView(sessionId: string): void {
    // 关闭视图 = abort -> 释放 MCP 引用 -> 销毁视图。
    // 先中止该会话正在运行的查询（含后台 Bash 任务与递归子代理），
    // 避免关闭后查询仍在后台运行、继续消耗 token 并复活已删除的对话文件。
    this.abortSession(sessionId);

    const view = this.views.get(sessionId);
    if (!view || view.webContents.isDestroyed()) {
      this.views.delete(sessionId);
      this.lru = this.lru.filter((k) => k !== sessionId);
      // 视图可能已先被销毁但引用仍在：这里统一释放
      this.releaseMcp(sessionId);
      return;
    }

    this.opts.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(sessionId);
    this.lru = this.lru.filter((k) => k !== sessionId);
    // 会话被关闭：释放其 MCP 引用（引用归零的 server 进入延迟回收）
    this.releaseMcp(sessionId);

    // 关闭的是当前活动视图：切换到最近使用的其他视图；无可用视图则新建对话
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
      const next = [...this.lru].reverse().find((k) => {
        const v = this.views.get(k);
        return v && !v.webContents.isDestroyed();
      });
      if (next) {
        this.show(next);
      } else {
        this.openNewConversation();
      }
    }
  }

  private createView(sessionId?: string): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 防止窗口失焦/被遮挡时 Chromium 暂停渲染：
        // WebContentsView 偶发"整个页面空白，调整窗口大小后才恢复"的根因之一
        // 就是后台节流导致恢复显示后不再重绘，resize 强制重绘才恢复。
        backgroundThrottling: false,
        additionalArguments: [
          `--workspace=${this.opts.workspacePath}`,
          `--locale=${this.opts.locale}`,
          `--systemLocale=${this.opts.systemLocale}`,
          `--uiLanguage=${this.opts.uiLanguage || 'auto'}`,
          ...(sessionId ? [`--session=${sessionId}`] : []),
        ],
      },
    });

    const indexPath = path.join(this.opts.appRoot, 'dist', 'webview', 'index.html');
    const url = sessionId
      ? `file://${indexPath.replace(/\\/g, '/')}?session=${encodeURIComponent(sessionId)}`
      : `file://${indexPath.replace(/\\/g, '/')}`;
    view.setBackgroundColor(CHAT_VIEW_BACKGROUND); // 加载期间保持深色，避免闪烁
    void view.webContents.loadURL(url);

    // 外部链接防御：webview 内任何 window.open / target=_blank 都不在 Electron 中打开，
    // 统一交给系统默认浏览器（主进程 shell.openExternal）。
    view.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
      if (isExternalUrl(targetUrl)) {
        void shell.openExternal(targetUrl).catch((err) => {
          console.error(`[chat-view] Failed to open external URL (window.open): ${err}`);
        });
      }
      return { action: 'deny' };
    });

    // 外部链接防御：webview 内普通 <a href> 导航（未被 JS 拦截时）也不在 Electron 中打开，
    // 允许应用自身的 file:// 页面（如未来内置页面），其余一律交给系统浏览器。
    view.webContents.on('will-navigate', (event, targetUrl) => {
      if (targetUrl.startsWith('file://')) return; // 应用内导航放行
      event.preventDefault();
      if (isExternalUrl(targetUrl)) {
        void shell.openExternal(targetUrl).catch((err) => {
          console.error(`[chat-view] Failed to open external URL (navigate): ${err}`);
        });
      }
    });

    view.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error(`[chat-view] did-fail-load: ${code} ${desc}`);
    });
    view.webContents.on('console-message', (details) => {
      console.log(`[chat-view:${details.level}] ${details.message}`);
    });

    // 渲染进程崩溃/OOM：延迟重载，避免崩溃循环
    view.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[chat-view] render-process-gone: reason=${details.reason}, exitCode=${details.exitCode}`);
      if (details.reason === 'crashed' || details.reason === 'oom' || details.reason === 'killed') {
        setTimeout(() => {
          if (view.webContents.isDestroyed()) return;
          if (view.webContents.isCrashed()) view.webContents.reload();
        }, 500);
      }
    });
    // GPU 进程异常（合成表面丢失的常见原因）由 app 级 child-process-gone 统一处理
    // （见 main.ts），此处只处理渲染进程本身。

    this.opts.onViewCreated?.(view);
    return view;
  }

  /** 当前所有聊天视图（供主进程统一重绘/恢复） */
  getAllViews(): WebContentsView[] {
    return [...this.views.values()].filter((v) => !v.webContents.isDestroyed());
  }

  /**
   * 会话被打开：建立其 MCP 引用（异步，不阻塞 UI，幂等）。
   * 临时 new- key 尚未对应正式会话，不参与引用。
   */
  private acquireMcp(sessionId?: string): void {
    if (!sessionId || sessionId.startsWith('new-')) return;
    void import('../src/core/mcp/Manager.js')
      .then(({ getMcpManager }) => getMcpManager().acquire(sessionId))
      .catch((err) => console.error(`[chat-view] MCP acquire failed (${sessionId}):`, err));
  }

  /**
   * 会话被关闭 / 删除前：中止其正在运行的查询（含后台 Bash 任务与递归子代理）。
   * 引擎可能已被移除（删除后再次关闭），此时 abortCurrentQuery 会兜底中止后台任务。
   * 临时 new- key 尚未对应正式会话，跳过。
   */
  private abortSession(sessionId?: string): void {
    if (!sessionId || sessionId.startsWith('new-')) return;
    void import('../src/core/Integration.js')
      .then(({ abortCurrentQuery }) => abortCurrentQuery(sessionId))
      .catch((err) => console.error(`[chat-view] abort query failed (${sessionId}):`, err));
  }

  /** 会话被关闭 / 删除：释放其 MCP 引用（引用归零的 server 进入延迟回收） */
  private releaseMcp(sessionId?: string): void {
    if (!sessionId || sessionId.startsWith('new-')) return;
    void import('../src/core/mcp/Manager.js')
      .then(({ getMcpManager }) => getMcpManager().release(sessionId))
      .catch((err) => console.error(`[chat-view] MCP release failed (${sessionId}):`, err));
  }

  private touch(sessionId: string): void {
    this.lru = this.lru.filter((k) => k !== sessionId);
    this.lru.push(sessionId);
    this.trim();
  }

  private trim(): void {
    while (this.lru.length > this.maxViews) {
      const oldest = this.lru.shift();
      if (!oldest) break;
      if (oldest === this.currentSessionId) continue;
      // LRU 淘汰等价于关闭该对话视图：先 abort，再释放 MCP 引用。
      // 否则被淘汰的会话仍在后台运行，而其 MCP 引用已归零，工具调用会失败。
      this.abortSession(oldest);
      const view = this.views.get(oldest);
      if (view && !view.webContents.isDestroyed()) {
        this.opts.win.contentView.removeChildView(view);
        view.webContents.close();
      }
      this.views.delete(oldest);
      this.releaseMcp(oldest);
    }
  }

  private show(sessionId: string): void {
    const view = this.views.get(sessionId);
    if (!view || view.webContents.isDestroyed()) return;

    // 隐藏当前活动视图（不销毁，保留状态）
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      const old = this.views.get(this.currentSessionId);
      if (old && !old.webContents.isDestroyed()) {
        this.opts.win.contentView.removeChildView(old);
      }
    }

    this.opts.win.contentView.addChildView(view);
    view.setBounds(this.chatBounds());
    this.currentSessionId = sessionId;
    view.webContents.focus();
    this.opts.onActiveSessionChanged(sessionId);
  }
}

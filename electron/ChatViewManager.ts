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
  /** 上次已使用过的 Shiki 语言（来自 settings.json），随 --highlightLanguages 注入供 webview 预热 */
  highlightLanguages?: string[];
  onActiveSessionChanged: (sessionId: string | null) => void;
  onViewCreated?: (view: WebContentsView) => void;
}

/**
 * 外部聊天客户端（内置 HTTP 服务器接入的浏览器连接）。
 *
 * 浏览器页面没有 WebContentsView，但需要与原生聊天视图共享同一套消息路由：
 * ElectronUI 通过 chatViews.sendTo(sessionId, msg) 把消息按会话投递，
 * 因此这里把每个浏览器连接登记成一个「虚拟视图」，按 sessionId 参与路由。
 */
export interface ExternalChatClient {
  /** 客户端唯一标识（自增，避免与 WebContents.id 混淆） */
  readonly id: number;
  /** 连接是否已断开 */
  isDestroyed(): boolean;
  /** 向浏览器推送消息（channel 固定为 'webview-message'） */
  send(channel: string, message: unknown): void;
  /** 注册连接断开回调（用于清理会话资源） */
  onDestroyed(callback: () => void): void;
}

export class ChatViewManager {
  /**
   * 「卸内存」入口（宿主注入：WebViewUI.closeConversation）。
   * closeView / LRU trim / disposeAll 在销毁视图前先走它
   * （core：conversationClosed → releaseSessionResources；宿主随后只销毁视图）。
   * 未注入时退化为仅 abortSession（集成缺失暴露在启动期）。
   */
  closeConversation: ((sessionId: string) => void) | null = null;
  /** sessionId -> view；新建会话使用 `new-<timestamp>` 临时 key，webview 上报后关联 */
  private views = new Map<string, WebContentsView>();
  private lru: string[] = [];
  private currentSessionId: string | null = null;
  private readonly maxViews = 12;
  /**
   * 「新建但还没发过任何消息」的会话 key 集合（含尚未上报正式 sessionId 的 `new-` 临时 key）。
   *
   * 这类对话没有落盘、不会出现在侧栏列表里，一旦用户切走就再也回不去。
   * 保留这份标记是为了让「新建对话」复用同一个视图（草稿仍留在输入框里），
   * 而不是再开一个空白视图，导致上一个新对话里输入的内容丢失。
   * 发出第一条消息后由 markSessionUsed() 移除。
   */
  private unsentNewKeys = new Set<string>();
  private readonly opts: ChatViewManagerOptions;
  /** 会话是否正在等待用户输入（ask user / 权限确认）的判定，由 ElectronUI 注入 */
  private waitingForUserProvider: ((sessionId: string) => boolean) | null = null;
  /**
   * 内置 HTTP 服务器接入的浏览器客户端：id -> { client, sessionId, clientId }。
   * sessionId 为该连接当前正在展示的会话，用于按会话投递消息与维护 MCP 引用；
   * clientId 为页面侧生成的唯一标识，用于把「只回给发起端」的消息精确定位到该连接。
   */
  private externalClients = new Map<number, { client: ExternalChatClient; sessionId: string | null; clientId?: string }>();

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
    const ids = [...this.views.keys()].filter((key) => {
      const view = this.views.get(key);
      return !key.startsWith('new-') && !!view && !view.webContents.isDestroyed();
    });
    // 浏览器客户端当前展示的会话同样视为「已加载」（abort 状态、侧栏 loaded 标记）
    for (const { client, sessionId } of this.externalClients.values()) {
      if (sessionId && !sessionId.startsWith('new-') && !client.isDestroyed() && !ids.includes(sessionId)) {
        ids.push(sessionId);
      }
    }
    return ids;
  }

  // ===================== 外部客户端（内置 HTTP 服务器 / 浏览器） =====================

  /** 登记一个浏览器客户端（新连接建立时调用） */
  registerExternalClient(client: ExternalChatClient): void {
    this.externalClients.set(client.id, { client, sessionId: null });
    client.onDestroyed(() => this.unregisterExternalClient(client));
  }

  /** 登记浏览器客户端当前页面的唯一标识（页面发来带 clientId 的消息时调用） */
  setExternalClientToken(client: ExternalChatClient, clientId: string): void {
    const entry = this.externalClients.get(client.id);
    if (entry) entry.clientId = clientId;
  }

  /** 注销浏览器客户端并释放其持有的会话资源（连接断开时调用） */
  unregisterExternalClient(client: ExternalChatClient): void {
    const entry = this.externalClients.get(client.id);
    if (!entry) return;
    this.externalClients.delete(client.id);
    if (entry.sessionId) {
      // 浏览器侧持有者消失：MCP 引用由 MCPHost 判定「无内存持有才 release」
      void import('../src/core/mcp/MCPHost.js').then(({ getMCPHost }) =>
        getMCPHost().onExternalClientDetached(entry.sessionId ?? undefined)
      ).catch((err) => console.error(`[chat-view] MCP onExternalClientDetached failed:`, err));
    }
  }

  /**
   * 更新浏览器客户端当前展示的会话（webview 上报 setActiveSessionId / startNewConversation /
   * loadConversation 时调用）。切换会话时释放旧会话的 MCP 引用并 acquire 新会话。
   */
  setExternalClientSession(client: ExternalChatClient, sessionId: string | null): void {
    const entry = this.externalClients.get(client.id);
    if (!entry) return;
    if (entry.sessionId === sessionId) return;
    entry.sessionId = sessionId;
    // 浏览器端切换会话：MCP 引用由 core 的会话生命周期管理。
    // 新会话由 webview 的 loadConversation / startNewConversation 路径
    // （createEngine / restoreConversationEngine → MCPHost.onSessionOpened）建立；
    // 旧会话仍开着（引擎在池内）时保留引用，空闲回收 / 删除对话时释放。
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
    // 会话被打开：MCP 引用由 core 的 loadConversation 流程建立
    // （restoreConversationEngine → MCPHost.onSessionOpened），视图层不再触发
  }

  /**
   * 新建对话：打开一个无 session 的聊天视图，webview onStartup 生成会话后关联。
   *
   * 若已存在「新建但还没发过消息」的对话，则直接切回那个视图而不是再开一个：
   * 用户可能在那个新对话里已经输入了草稿，切到其它对话后再点「新建」时，
   * 复用旧视图才能保住草稿（与 webview 顶部「+」的行为一致），
   * 否则新视图是空白的，旧草稿随着被隐藏的视图一起"丢失"。
   */
  openNewConversation(): void {
    const reusable = this.findReusableNewConversation();
    if (reusable) {
      this.touch(reusable);
      // 已经在展示这个未发送的新对话：只聚焦，保留输入框里的草稿，避免重复 addChildView
      if (reusable === this.currentSessionId) {
        this.views.get(reusable)?.webContents.focus();
      } else {
        this.show(reusable);
      }
      return;
    }

    const key = `new-${Date.now()}`;
    const view = this.createView(undefined);
    this.views.set(key, view);
    this.unsentNewKeys.add(key);
    this.touch(key);
    this.show(key);
  }

  /**
   * 查找可复用的「未发送新对话」视图（优先当前正在展示的那个）。
   * 返回 null 表示没有可复用的，需要新建。
   */
  private findReusableNewConversation(): string | null {
    // 优先复用当前活动视图，避免无谓的视图切换
    if (this.currentSessionId && this.isUnsentNewConversation(this.currentSessionId)) {
      return this.currentSessionId;
    }
    for (const key of this.unsentNewKeys) {
      const view = this.views.get(key);
      if (view && !view.webContents.isDestroyed()) {
        return key;
      }
    }
    return null;
  }

  /** 该 key 是否对应一个「新建但还没发过消息」的对话 */
  private isUnsentNewConversation(key: string): boolean {
    if (!this.unsentNewKeys.has(key)) return false;
    const view = this.views.get(key);
    return !!view && !view.webContents.isDestroyed();
  }

  /**
   * 会话已发出第一条消息（sendMessage / queueMessage）：不再属于「未发送新对话」，
   * 后续点「新建」应创建新的视图。
   */
  markSessionUsed(sessionId: string): void {
    this.unsentNewKeys.delete(sessionId);
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
    // 临时 new- key 转为正式 sessionId：同步迁移「未发送新对话」标记
    if (this.unsentNewKeys.delete(tempKey)) {
      this.unsentNewKeys.add(sessionId);
    }

    // 如果目标 sessionId 已有视图（如历史会话被重新打开），销毁旧视图避免重复。
    // 同时把该 sessionId 从 LRU 中移除，避免下面 push 后出现重复条目
    // 挤占 LRU 配额（12 个上限被脏条目占位）。
    const existing = this.views.get(sessionId);
    if (existing && existing !== view && !existing.webContents.isDestroyed()) {
      this.opts.win.contentView.removeChildView(existing);
      existing.webContents.close();
      this.lru = this.lru.filter((k) => k !== sessionId);
    }
    this.views.set(sessionId, view);
    this.lru.push(sessionId);
    if (this.currentSessionId === tempKey) {
      this.currentSessionId = sessionId;
      this.opts.onActiveSessionChanged(sessionId);
    }
    this.trim();
    // 新对话首次上报正式 sessionId：MCP 引用由 core 的会话生命周期建立
  }

  /** 按 sessionId 发送消息到对应视图（原生聊天视图 + 浏览器客户端） */
  sendTo(sessionId: string | undefined, message: unknown): boolean {
    // 指定了发起端（浏览器页面）时只回给该客户端：
    // 查看文件、打开设置面板这类操作属于「本地行为」，不能落到其它端。
    const targetClientId = (message as { clientId?: unknown } | null)?.clientId;
    if (typeof targetClientId === 'string' && targetClientId) {
      for (const { client, clientId } of this.externalClients.values()) {
        if (clientId === targetClientId && !client.isDestroyed()) {
          client.send('webview-message', message);
          return true;
        }
      }
      return false;
    }

    let sent = false;
    if (sessionId) {
      const view = this.views.get(sessionId);
      if (view && !view.webContents.isDestroyed()) {
        view.webContents.send('webview-message', message);
        sent = true;
      }
      for (const { client, sessionId: clientSessionId } of this.externalClients.values()) {
        if (clientSessionId === sessionId && !client.isDestroyed()) {
          client.send('webview-message', message);
          sent = true;
        }
      }
    }
    return sent;
  }

  /** 发送消息到当前活动视图（会话无关的广播类消息同时推送给浏览器客户端） */
  sendToActive(message: unknown): void {
    const scoped = message as { sessionId?: unknown; clientId?: unknown } | null;
    // 指定了发起端或会话的消息不做广播，避免串到其它端（由 sendTo 精确投递）
    if (scoped?.clientId) return;

    const active = this.currentSessionId ? this.views.get(this.currentSessionId) : undefined;
    if (active && !active.webContents.isDestroyed()) {
      active.webContents.send('webview-message', message);
    }
    // 指定了 sessionId 但未匹配到任何视图/客户端时，不再广播给浏览器，
    // 避免把某个会话的内容串到其它浏览器会话。
    if (scoped?.sessionId) return;
    for (const { client } of this.externalClients.values()) {
      if (!client.isDestroyed()) {
        client.send('webview-message', message);
      }
    }
  }

  /** 通知所有聊天视图（如主题变化） */
  broadcast(message: unknown): void {
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('webview-message', message);
      }
    }
    for (const { client } of this.externalClients.values()) {
      if (!client.isDestroyed()) {
        client.send('webview-message', message);
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
      this.destroyViewEntry(key);
    }
    this.views.clear();
    this.lru = [];
    this.unsentNewKeys.clear();
    this.currentSessionId = null;
  }

  /**
   * 销毁单个会话视图条目的公共序列：
   * abort 会话查询 → 移除 ChildView 并关闭 webContents → 从 views 移除 →
   * 清理「未发送新对话」标记。
   *
   * MCP 引用的释放不在视图层（阶段 3.5，MCPHost 拥有生命周期）：
   * 引用跟会话走，由空闲回收（releaseSessionResources）/ 删除对话
   * （deleteConversation → MCPHost.onSessionClosed）驱动，不随视图销毁释放。
   *
   * 差异点通过参数表达：
   * - removeFromLru：trim 已把目标 shift 出 lru，无需再过滤；closeView 需要。
   * - closeIfAlive：closeView 在「视图已销毁但引用残留」分支不做 close，
   *   只做 map/标记清理（closeView 传入 false 复用其余步骤）。
   */
  private destroyViewEntry(
    key: string,
    opts?: {
      removeFromLru?: boolean;
      closeIfAlive?: boolean;
    },
  ): void {
    // 销毁视图前先卸内存（core：abort + 引擎出池 + MCP 释放），
    // 再做纯视图销毁（第 11.1 #18：不再依赖视图层内部 abort/release）
    if (this.closeConversation) {
      this.closeConversation(key);
    } else {
      this.abortSession(key);
    }
    const view = this.views.get(key);
    if (view && !view.webContents.isDestroyed()) {
      this.opts.win.contentView.removeChildView(view);
      if (opts?.closeIfAlive !== false) {
        view.webContents.close();
      }
    }
    this.views.delete(key);
    if (opts?.removeFromLru !== false) {
      this.lru = this.lru.filter((k) => k !== key);
    }
    this.unsentNewKeys.delete(key);
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
    // 关闭视图 = abort -> 释放 MCP 引用 -> 销毁视图（序列在 destroyViewEntry 内：
    // 先中止该会话正在运行的查询（含后台 Bash 任务与递归子代理），
    // 避免关闭后查询仍在后台运行、继续消耗 token 并复活已删除的对话文件）。
    const view = this.views.get(sessionId);
    if (!view || view.webContents.isDestroyed()) {
      // 视图已销毁但引用仍在：只做 map/标记清理（不 close）
      this.destroyViewEntry(sessionId, { closeIfAlive: false });
      // 即使视图已销毁，若它是当前活动会话，也要做善后切换，
      // 否则 currentSessionId 悬挂在已销毁会话上，sendToActive/layout 等静默失效。
      this.switchAwayFromClosedSession(sessionId);
      return;
    }

    // 会话被关闭：只销毁视图。MCP 引用由 core 持有（引用跟会话走）。
    this.destroyViewEntry(sessionId);

    // 关闭的是当前活动视图：切换到最近使用的其他视图；无可用视图则新建对话
    this.switchAwayFromClosedSession(sessionId);
  }

  /**
   * 关闭的会话是当前活动视图时的善后：切换到最近使用的其他视图；
   * 无可用视图则新建对话。（保持在调用侧，不属于 destroyViewEntry 的销毁序列）
   */
  private switchAwayFromClosedSession(sessionId: string): void {
    if (this.currentSessionId !== sessionId) return;
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
          `--highlightLanguages=${(this.opts.highlightLanguages || []).join(',')}`,
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

  private touch(sessionId: string): void {
    this.lru = this.lru.filter((k) => k !== sessionId);
    this.lru.push(sessionId);
    this.trim();
  }

  private trim(): void {
    while (this.lru.length > this.maxViews) {
      const oldest = this.lru.shift();
      if (!oldest) break;
      if (oldest === this.currentSessionId) {
        // 当前活动会话不淘汰，但必须放回队尾（而不是丢弃）：
        // 否则 LRU 链里没有当前会话，后续 touch/trim 的容量判断会失真。
        this.lru.push(oldest);
        break;
      }
      // LRU 淘汰等价于关闭该对话视图：先 abort，再释放 MCP 引用。
      // 否则被淘汰的会话仍在后台运行，而其 MCP 引用已归零，工具调用会失败。
      // oldest 已 shift 出 lru，无需再过滤。
      this.destroyViewEntry(oldest, { removeFromLru: false });
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

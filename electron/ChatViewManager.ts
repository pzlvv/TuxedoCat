/**
 * ChatViewManager - 右侧聊天标签页管理
 *
 * 每个对话对应一个独立的 WebContentsView（保留各自的聊天状态），
 * 点击侧栏对话时切换显示（add/remove ChildView，不销毁页面）。
 *
 * 布局：
 *   ┌──────────┬──────────────────────────────┐
 *   │ sidebar  │ chat view (当前对话)          │
 *   │ 可拖拽    │                              │
 *   └──────────┴──────────────────────────────┘
 *
 * 侧栏宽度不再用常量：布局时经 `opts.sidebarWidth()` 实时取值（main.ts 持有
 * 当前宽度并负责夹取与持久化，见 `docs/hosts/host-matrix.md` 第 12 节）。
 */

import { BrowserWindow, WebContents, WebContentsView, Rectangle, nativeTheme } from 'electron';
import * as path from 'path';
import type { WebviewMessage } from '../src/host/webviewMessages.js';
import { guardViewNavigation } from './viewNavigation.js';

/** 侧栏默认宽度（无持久化记录 / 双击拖拽手柄恢复时使用） */
export const SIDEBAR_DEFAULT_WIDTH = 280;
/** 自绘标题栏高度：主窗口顶部由标题栏 WebContentsView 占据，侧栏/聊天视图整体下移 */
export const TITLEBAR_HEIGHT = 38;
/** 深色主题下的聊天视图兜底背景色（与主窗口 backgroundColor 一致，避免加载期闪烁） */
const CHAT_VIEW_BACKGROUND = '#16161b';
/** 浅色主题下的聊天视图兜底背景色 */
const CHAT_VIEW_BACKGROUND_LIGHT = '#f4f4f5';

/**
 * 聊天视图的兜底背景色（按当前主题）。
 *
 * 页面加载完成前 WebContentsView 会先铺这层底色：
 * - 浅色取 webview 自身首帧背景 #f4f4f5（见 src/webview/styles/index.css 的
 *   .standalone-host.theme-light），否则会先闪一下深色；
 * - 深色沿用外壳色 #16161b（与主窗口 / 标题栏 / 侧栏一致），与 webview 首帧的
 *   #1a1a1f 只差一点明度，加载期察觉不到。
 */
export function chatViewBackgroundColor(isDark: boolean = nativeTheme.shouldUseDarkColors): string {
  return isDark ? CHAT_VIEW_BACKGROUND : CHAT_VIEW_BACKGROUND_LIGHT;
}

/** 语言 / 字号档位（readUiPreferences 的回包） */
interface UiFontPrefs {
  uiLanguage?: 'auto' | 'zh' | 'en';
  uiFontSize?: 'medium' | 'large' | 'xlarge';
}

export interface ChatViewManagerOptions {
  win: BrowserWindow;
  appRoot: string;
  preloadPath: string;
  /** 聊天区占位页的 preload（活动工作区建链中 / 不可用时替代对话视图，见 showChatPlaceholder） */
  chatPlaceholderPreloadPath: string;
  /** 活动工作区路径（--workspace= 注入 / 展示；身份判等不用它，用 workspaceId） */
  workspacePath: string;
  /**
   * 活动工作区 id（`workspaceRefKey` 稳定身份）：视图归属与判等只按 id——
   * 远程路径不能按本地语义规范化（会变形 / 大小写归一），同路径不同主机的
   * 两个远程工作区必须是两个身份。
   */
  workspaceId: string;
  locale: string;
  systemLocale: string;
  /** 用户显式选择的界面语言（'auto' | 'zh' | 'en'），随 --uiLanguage 注入 webview */
  uiLanguage?: 'auto' | 'zh' | 'en';
  /** 界面字号档位（'medium' | 'large' | 'xlarge'），随 --uiFontSize 注入 webview */
  uiFontSize?: 'medium' | 'large' | 'xlarge';
  /** 上次已使用过的 Shiki 语言（来自 settings.json），随 --highlightLanguages 注入供 webview 预热 */
  highlightLanguages?: string[];
  /**
   * 语言 / 字号的实时读取口：每个视图创建时调用一次，替代启动期快照——
   * 设置保存后新开的视图首帧就要拿到新档位（运行中的视图另有 defaults 推送）。
   * 返回 undefined 时回退上面的启动期值。
   */
  readUiPreferences?: () => UiFontPrefs | undefined;
  /**
   * 内容区顶部内缩量（自绘标题栏高度）。
   * 聊天视图从该 y 坐标开始，避免被顶部标题栏遮挡。
   */
  topInset?: number;
  /**
   * 对话列表渲染方，随 `--conversationListOwner=` 注入 webview 的 `__hostInfo`：
   * - `host`（默认）：完整模式，对话列表由宿主原生侧栏渲染，顶栏保留「关闭当前会话」
   * - `webview`：悬浮窗，宿主隐藏侧栏，列表改由 webview 顶栏渲染（历史对话入口）
   * 运行期可用 setConversationListOwner 切换。
   *
   * 视图模式（`HostInfo.conversationView`）不在这里：Electron 恒为 `multi`（每会话一个
   * webview），悬浮窗只把列表搬进顶栏，不改变「切换会话复用 / 另开视图」的行为。
   */
  conversationListOwner?: 'host' | 'webview';
  /**
   * 侧栏当前宽度（DIP）的实时读取口：布局时调用，不做缓存——用户拖拽手柄改宽度
   * 后要立即反映到聊天区摆位。夹取（最小 / 最大 / 不挤掉聊天区）由 main.ts 负责。
   */
  sidebarWidth: () => number;
  onActiveSessionChanged: (sessionId: string | null) => void;
  onViewCreated?: (view: WebContentsView) => void;
  /**
   * 「已打开会话」集合变化（视图层状态，owner 是 ChatViewManager）。
   * 视图创建 / 销毁 / LRU 淘汰时触发，
   * 由宿主推给侧栏（`sidebar:session-loaded-changed`），不并入对话列表流。
   */
  onLoadedChanged?: (sessionIds: string[]) => void;
}

export class ChatViewManager {
  /**
   * 「卸内存」入口（宿主注入：WebViewUI.releaseConversation）。
   * closeView / LRU trim / disposeAll 在销毁视图前先走它
   * （core：conversationClosed → releaseSessionResources；宿主随后只销毁视图）。
   *
   * 注意必须指向 releaseConversation（只卸内存），不能指向 closeConversation——
   * 后者还会回调 closeConversationView，与视图销毁序列互相回调形成死循环。
   *
   * 未注入时退化为仅 abortSession（集成缺失暴露在启动期）。
   */
  closeConversation: ((sessionId: string) => void) | null = null;

  /**
   * 预热视图被切到前台时的出口（`ElectronUIHost` 在 `setChatViewManager` 时注入）。
   *
   * 由宿主组装并直发 `activatePrewarmedView`——视图管理器不直连 `webContents.send`。
   * 未注入时不发，视图会停在 Loading，直到 webview 自己发 `prewarmViewReady`
   * 由 `handlePrewarmViewReady` 补发。
   */
  onActivatePrewarmedView: ((view: WebContentsView) => void) | null = null;

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
  /**
   * 后台预热的「空闲新对话」视图 key（`new-` 临时 key，最多一个）。
   *
   * 当前可见的新对话被「消耗」（发出第一条消息）后，用户下次点「新建对话」
   * 若还要现建视图 + 加载页面，就会看到明显的闪烁/等待。因此在消耗后延迟一点
   * 在后台把这个视图建好并完成加载，点击「新建」时直接 show()，几乎瞬切。
   *
   * 预热视图同时进入 unsentNewKeys（与可见的新对话同一语义：还没发过消息、
   * 切走也能复用）。它不进 LRU：既不代表「最近使用过的会话」，也不该被 LRU
   * 淘汰（成为活动视图时由 touch() 入 LRU）。
   *
   * 预热视图带 `--prewarm=1` 启动：页面照常加载并渲染 UI（主题/上下文限制按
   * 来源 webContents 直发回包），但跳过会「落地」的启动初始化 —— 不生成 session
   * （否则 core 会为一个可能永远不用的会话预创建引擎 / MCP 引用），
   * 也不请求技能 / 模型 / MCP / settings 默认值（这些回包只发给活动视图）。
   * 等被切到前台时由本类发 activatePrewarmedView 补做（见 electron/preload.ts
   * 与 src/webview/App.tsx）。
   *
   * 生命周期：创建时置位 → 被切到前台时发激活消息（置位保留）→ webview 上报
   * 正式 sessionId（registerSession）或视图被销毁时清空。置位期间无论「切走再切回」
   * 还是「页面加载中就被切前台」，都能保证激活消息最终送达。
   */
  private prewarmKey: string | null = null;
  /**
   * 所有「仍处于预热态、尚未被激活」的视图 key。
   *
   * prewarmKey 只跟踪最近一个（用于去重与 ready 回包），但工作目录切换等原因
   * 可能让旧的预热视图失去跟踪（见 setActiveWorkspace 的清理）。复用一个预热视图
   * 时必须给它补发 activatePrewarmedView，否则 webview 会一直停在 Loading。
   * 因此用一个集合记住全部预热态视图：加入预热、注册正式会话、销毁时维护。
   */
  private readonly prewarmKeys = new Set<string>();
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  /** 预热延迟：避开刚发出的第一条消息（正在流式输出）的 CPU/网络高峰 */
  private readonly prewarmDelayMs = 1200;
  /**
   * `new-` 临时 key 的自增序号。
   * 首次启动会连续为多个工作目录预加载视图，仅用 `Date.now()` 会撞 key。
   */
  private newKeySeq = 0;
  /** 原生侧栏是否隐藏（悬浮窗）：聊天视图占满整宽（由 conversationListOwner 派生） */
  private sidebarHidden: boolean;
  private readonly opts: ChatViewManagerOptions;
  /**
   * 聊天区占位页：活动工作区建链中 / 不可用时替代对话视图展示
   * （不显示对话列表与 webview，见 showChatPlaceholder）。null = 未展示。
   */
  private placeholderView: WebContentsView | null = null;
  /** 占位页当前渲染的 HTML：内容未变时不重复 loadURL，避免闪烁 */
  private placeholderHtml: string | null = null;

  /**
   * 视图 key（正式 sessionId 或 `new-` 临时 key）→ 该视图所属的工作区 id
   * （`workspaceRefKey` 稳定身份）。工作区是对话的属性：视图创建时记下它，
   * 切换工作区后重建视图时按对话自己的 id 归属。
   *
   * **id 与路径是两个维度**：id 用于归属与判等（远程路径不能按本地语义规范化，
   * 同路径不同主机的两个远程工作区必须是两个身份）；路径只用于给视图注入
   * `--workspace=` 与显示，按 id 在 `workspacePathById` 里查。
   */
  private readonly viewWorkspaces = new Map<string, string>();
  /** 工作区 id → 展示 / 注入用路径（登记于 setActiveWorkspace / 预热 / 新建对话） */
  private readonly workspacePathById = new Map<string, string>();

  constructor(opts: ChatViewManagerOptions) {
    this.opts = opts;
    this.workspacePathById.set(opts.workspaceId, opts.workspacePath);
    // 与 conversationListOwner 保持一致：以悬浮窗启动时首帧布局就没有侧栏，无需调用方再补一次
    this.sidebarHidden = opts.conversationListOwner === 'webview';
  }

  /** 更新活动工作区（id 用于归属判等，path 用于新建视图的 --workspace= 注入） */
  setWorkspacePath(p: string, id: string): void {
    this.opts.workspacePath = p;
    this.opts.workspaceId = id;
    this.workspacePathById.set(id, p);
  }

  /** 视图 key 所属的工作区 id（未登记时回退到当前活动工作区） */
  getWorkspaceForKey(key: string): string {
    return this.viewWorkspaces.get(key) ?? this.opts.workspaceId;
  }

  /** 某 webContents 对应的视图所属工作区 id（找不到时 undefined） */
  getWorkspaceForWebContents(webContents: WebContents): string | undefined {
    const key = this.getKeyByWebContents(webContents);
    return key ? this.viewWorkspaces.get(key) : undefined;
  }

  /** 视图 key 所属工作区的路径（--workspace= 注入 / 展示用；未登记回退活动路径） */
  getWorkspacePathForKey(key: string): string {
    return this.workspacePathById.get(this.getWorkspaceForKey(key)) ?? this.opts.workspacePath;
  }

  /** 某 webContents 对应的视图所属工作区路径（找不到时 undefined） */
  getWorkspacePathForWebContents(webContents: WebContents): string | undefined {
    const id = this.getWorkspaceForWebContents(webContents);
    return id === undefined ? undefined : this.workspacePathById.get(id) ?? this.opts.workspacePath;
  }

  /**
   * 两个工作区 id 是否相同：id 是 `workspaceRefKey` 稳定身份，字符串精确比较
   * （表示差异已在派生 id 时归一；`''` 是合法的「未打开工作区」空态 id）。
   */
  private isSameWorkspace(a: string | undefined, b: string | undefined): boolean {
    return a === b;
  }

  /**
   * 切换活动工作区（id = `workspaceRefKey`，path 用于视图注入）：
   * 把可见视图切到该目录最近使用的对话；没有则在该目录新建对话。
   *
   * 视图按对话自己的工作区保留（不随切换销毁），因此切回时能直接恢复上次的对话。
   * 属于其它工作区的后台预热视图不再适用：销毁它（预热定时器保留，触发时按
   * 新的活动目录创建），避免留下无人跟踪的孤儿视图。
   */
  setActiveWorkspace(workspace: string, id: string): void {
    this.setWorkspacePath(workspace, id);
    // 其它工作区的后台预热视图保留：它们是那些标签页的预加载视图，
    // 切过去时直接 show()（消除首次切换的闪烁）；关闭工作区 / 窗口时统一销毁。
    const next = [...this.lru]
      .reverse()
      .find((key) => this.isSameWorkspace(this.viewWorkspaces.get(key), id) && this.isViewAlive(key));
    if (next && next !== this.currentSessionId) {
      this.touch(next);
      this.show(next);
      this.emitLoadedChanged();
      return;
    }
    if (next) {
      // 已经是该工作区的活动视图：无需切换
      return;
    }
    this.openNewConversation(id);
  }

  /** 关闭一个工作区：销毁该目录下所有已打开的对话视图（卸内存 + 中止运行中查询） */
  closeWorkspace(id: string): void {
    const keys = [...this.views.keys()].filter((key) =>
      this.isSameWorkspace(this.viewWorkspaces.get(key), id),
    );
    const closedCurrent = !!this.currentSessionId && keys.includes(this.currentSessionId);
    for (const key of keys) {
      this.destroyViewEntry(key);
    }
    if (closedCurrent) {
      // 当前视图被销毁：清掉悬挂引用，由宿主（closeWorkspace → setActiveWorkspace）
      // 决定切到哪个目录的对话；这里不能自行 openNewConversation（会落在已关闭目录）
      this.currentSessionId = null;
      this.opts.onActiveSessionChanged(null);
    }
    if (keys.length > 0) {
      this.emitLoadedChanged();
      this.schedulePrewarmNewConversation();
    }
  }

  private isViewAlive(key: string): boolean {
    const view = this.views.get(key);
    return !!view && !view.webContents.isDestroyed();
  }

  /**
   * 聊天区占位页：活动工作区建链中 / 不可用时替代对话视图展示（不显示对话列表与 webview）。
   *
   * HTML 由宿主生成（`chatPlaceholderHtml.ts`，文案与重连按钮随状态不同）；
   * 内容未变时不重复 loadURL。`null` 收起占位页，恢复正常对话视图的展示
   * （由宿主随后调 setActiveWorkspace / openNewConversation）。
   */
  showChatPlaceholder(html: string | null): void {
    if (html === null) {
      if (this.placeholderView) {
        this.opts.win.contentView.removeChildView(this.placeholderView);
        if (!this.placeholderView.webContents.isDestroyed()) {
          this.placeholderView.webContents.close();
        }
        this.placeholderView = null;
        this.placeholderHtml = null;
      }
      return;
    }
    // 隐藏当前对话视图（不销毁：其它工作区的视图不受影响，切回时由 show() 重新挂回）
    if (this.currentSessionId) {
      const current = this.views.get(this.currentSessionId);
      if (current && !current.webContents.isDestroyed()) {
        this.opts.win.contentView.removeChildView(current);
      }
      this.currentSessionId = null;
      this.opts.onActiveSessionChanged(null);
    }
    if (!this.placeholderView) {
      this.placeholderView = new WebContentsView({
        webPreferences: {
          preload: this.opts.chatPlaceholderPreloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      // 占位页同样注入 chatPlaceholderPreload（重连按钮 IPC），拒绝窗口内导航 / window.open
      guardViewNavigation(this.placeholderView.webContents, 'chat-placeholder');
    }
    this.opts.win.contentView.addChildView(this.placeholderView);
    this.placeholderView.setBounds(this.chatBounds());
    this.placeholderView.setBackgroundColor(chatViewBackgroundColor());
    if (this.placeholderHtml !== html) {
      this.placeholderHtml = html;
      void this.placeholderView.webContents
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        .catch((err) => {
          console.error('[chat-placeholder] loadURL failed:', err);
        });
    }
  }

  /** 该 webContents 是否为聊天区占位页（重连按钮 IPC 的来源校验） */
  isChatPlaceholderWebContents(webContents: WebContents): boolean {
    const view = this.placeholderView;
    return !!view && !view.webContents.isDestroyed() && view.webContents.id === webContents.id;
  }

  /**
   * 切换对话列表渲染方（宿主能力声明里的 conversationListOwner）。
   *
   * 悬浮窗隐藏原生侧栏后，对话列表必须改由 webview 顶栏渲染，否则用户既看不到列表、
   * 也无法新建对话。已打开的视图发消息就地切换，之后新建的视图直接用新的
   * `--conversationListOwner=` 启动参数，避免顶栏闪一下。
   *
   * 布局（sidebarHidden）与能力声明在同一个入口里同步更新：分成两个方法靠调用方自觉配对，
   * 一旦只调其一就会出现「侧栏隐藏了但顶栏仍显示关闭按钮 / 没有历史列表」这类错配。
   * 只改布局、不重建视图——当前对话的 webview 原样复用，不会重新加载。
   */
  setConversationListOwner(owner: 'host' | 'webview'): void {
    const changed = (this.opts.conversationListOwner ?? 'host') !== owner;
    this.opts.conversationListOwner = owner;
    const hidden = owner === 'webview';
    if (this.sidebarHidden !== hidden) {
      this.sidebarHidden = hidden;
      this.layout();
    }
    if (!changed) return;
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.webContents.send('webview-message', this.conversationListOwnerMessage(owner));
      }
    }
  }

  /**
   * 对话列表渲染方切换消息。
   *
   * 标注为 WebviewMessage：channel 与 payload 都走同一个联合类型，
   * 拼错 type / owner 会在编译期暴露（webContents.send 本身不做校验）。
   */
  private conversationListOwnerMessage(owner: 'host' | 'webview'): WebviewMessage {
    return { type: 'setConversationListOwner', owner };
  }

  private chatBounds(): Rectangle {
    const [w, h] = this.opts.win.getContentSize();
    const top = this.opts.topInset ?? 0;
    // 侧栏隐藏（悬浮窗）：左侧不留侧栏宽度；窄窗下不再强撑 320（否则会被窗口裁掉）
    const left = this.sidebarHidden ? 0 : this.opts.sidebarWidth();
    const width = this.sidebarHidden ? Math.max(0, w - left) : Math.max(320, w - left);
    return { x: left, y: top, width, height: Math.max(0, h - top) };
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

  /** 该 webContents 是否为「仍在后台、尚未被切到前台」的预热视图 */
  isPrewarmWebContents(webContents: WebContents): boolean {
    const key = this.getKeyByWebContents(webContents);
    return !!key && this.prewarmKeys.has(key);
  }

  /** 根据 webContents 反查其对应的 key（正式会话 ID 或 new- 临时 key），找不到返回 null */
  getKeyByWebContents(webContents: WebContents): string | null {
    for (const [key, view] of this.views) {
      if (!view.webContents.isDestroyed() && view.webContents.id === webContents.id) {
        return key;
      }
    }
    return null;
  }

  /** 当前已加载（有活动视图）的真实会话 ID 列表（排除新建中的临时 key） */
  getLoadedSessionIds(): string[] {
    return [...this.views.keys()].filter((key) => {
      const view = this.views.get(key);
      return !key.startsWith('new-') && !!view && !view.webContents.isDestroyed();
    });
  }

  /**
   * 推送「已打开会话」集合变化（视图层状态，owner 是本类）。
   * 侧栏据此渲染绿点；不并入对话列表流（docs/architecture/contracts.md 第 4 节规则 8）。
   */
  private emitLoadedChanged(): void {
    this.opts.onLoadedChanged?.(this.getLoadedSessionIds());
  }

  /**
   * 打开（或切换）指定会话的聊天视图。
   * workspace 为该对话所属的工作目录（宿主按对话解析后传入）；省略时按视图已有登记，
   * 再回退到当前活动工作目录。
   */
  openConversation(sessionId: string, id?: string, path?: string): void {
    let view = this.views.get(sessionId);
    if (!view || view.webContents.isDestroyed()) {
      // 视图已被销毁（如用户点击关闭按钮）但仍残留在 map 中时，清理后重建
      if (view) {
        this.views.delete(sessionId);
        this.lru = this.lru.filter((k) => k !== sessionId);
      }
      const wsId = id ?? this.viewWorkspaces.get(sessionId) ?? this.opts.workspaceId;
      const ws = path ?? this.workspacePathById.get(wsId) ?? this.opts.workspacePath;
      this.workspacePathById.set(wsId, ws);
      view = this.createView(sessionId, { workspace: ws });
      this.views.set(sessionId, view);
      this.viewWorkspaces.set(sessionId, wsId);
    }
    this.touch(sessionId);
    this.show(sessionId);
    // 会话被打开：MCP 引用由 core 的 loadConversation 流程建立
    // （restoreConversationEngine → MCPHost.onSessionOpened），视图层不再触发
    this.emitLoadedChanged();
  }

  /**
   * 新建对话：打开一个无 session 的聊天视图，webview onStartup 生成会话后关联。
   *
   * 若已存在「新建但还没发过消息」的对话，则直接切回那个视图而不是再开一个：
   * 用户可能在那个新对话里已经输入了草稿，切到其它对话后再点「新建」时，
   * 复用旧视图才能保住草稿（与 webview 顶部「+」的行为一致），
   * 否则新视图是空白的，旧草稿随着被隐藏的视图一起"丢失"。
   *
   * 后台预热的视图也走这条复用路径：直接 show() 即可，由 show() 对仍是预热态的
   * 视图补发 activatePrewarmedView 让它完成启动初始化（见 show / prewarmKeys）。
   */
  openNewConversation(id?: string): void {
    const wsId = id ?? this.opts.workspaceId;
    // 注入用路径：按 id 查登记表（未登记回退活动路径）
    const ws = this.workspacePathById.get(wsId) ?? this.opts.workspacePath;
    const reusable = this.findReusableNewConversation(wsId);
    if (reusable) {
      this.touch(reusable);
      // 已经在展示这个未发送的新对话：只聚焦，保留输入框里的草稿，避免重复 addChildView。
      // 该分支不经过 show()，需要在这里补发激活消息（预热视图此前跳过了启动初始化）
      if (reusable === this.currentSessionId) {
        this.views.get(reusable)?.webContents.focus();
        if (this.prewarmKeys.has(reusable)) {
          const view = this.views.get(reusable);
          if (view) this.activatePrewarmedView(view);
        }
      } else {
        // show() 内部会对仍是预热态的视图补发 activatePrewarmedView
        this.show(reusable);
      }
      this.emitLoadedChanged();
      return;
    }

    const key = this.nextNewKey();
    const view = this.createView(undefined, { workspace: ws });
    this.views.set(key, view);
    this.viewWorkspaces.set(key, wsId);
    this.unsentNewKeys.add(key);
    this.touch(key);
    this.show(key);
    this.emitLoadedChanged();
  }

  /**
   * 查找可复用的「未发送新对话」视图（优先当前正在展示的那个）。
   * 只在同一工作区内复用：草稿属于该工作区下的新对话。
   * 返回 null 表示没有可复用的，需要新建。
   */
  private findReusableNewConversation(workspaceId: string): string | null {
    const inWorkspace = (key: string): boolean =>
      this.isSameWorkspace(this.viewWorkspaces.get(key), workspaceId);
    // 优先复用当前活动视图，避免无谓的视图切换
    if (this.currentSessionId && inWorkspace(this.currentSessionId) && this.isUnsentNewConversation(this.currentSessionId)) {
      return this.currentSessionId;
    }
    // 其次复用后台预热的视图（已经加载好，直接切过去最快）
    if (this.prewarmKey && inWorkspace(this.prewarmKey) && this.isUnsentNewConversation(this.prewarmKey)) {
      return this.prewarmKey;
    }
    for (const key of this.unsentNewKeys) {
      if (inWorkspace(key) && this.isUnsentNewConversation(key)) {
        return key;
      }
    }
    return null;
  }

  /** 指定工作区内是否已存在「新建但还没发过消息」的对话视图（含后台预热的那个） */
  private hasUnsentNewConversation(workspaceId?: string): boolean {
    for (const key of this.unsentNewKeys) {
      if (workspaceId !== undefined && !this.isSameWorkspace(this.viewWorkspaces.get(key), workspaceId)) continue;
      if (this.isUnsentNewConversation(key)) return true;
    }
    return false;
  }

  /**
   * 后台预热下一个「新对话」视图（延迟执行，避开刚发出的第一条消息的高峰）。
   *
   * 已有未发送的新对话（可见或后台）时不重复创建；重复调用会被去重。
   */
  private schedulePrewarmNewConversation(): void {
    // 占位页展示期间不预热：当前活动工作区没有可用的对话视图
    if (this.placeholderView) return;
    if (this.prewarmTimer) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      this.prewarmNewConversation();
    }, this.prewarmDelayMs);
  }

  private cancelPrewarm(): void {
    if (this.prewarmTimer) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
  }

  private prewarmNewConversation(): void {
    // 占位页展示期间不预热：当前活动工作区没有可用的对话视图
    if (this.placeholderView) return;
    this.prewarmForWorkspace(this.opts.workspaceId);
  }

  /**
   * 预加载某个工作区的聊天视图（宿主在首次启动时为**非活动标签页**逐个调用）。
   *
   * 复用后台预热机制：视图带 `--prewarm=1` 在后台把页面加载并渲染好，但跳过会「落地」的
   * 启动初始化（不生成 session）。用户点该标签页时 `setActiveWorkspace` 找到它，
   * 直接 `show()` 并补发激活消息，不再现建视图 + 等页面加载，因此不会闪烁。
   *
   * 同一目录已有「未发送的新对话」（含已预热的）时不重复创建。
   */
  preloadWorkspace(id: string, path: string): void {
    console.log(`[chat-view] preloading workspace view: ${path}`);
    this.workspacePathById.set(id, path);
    this.prewarmForWorkspace(id);
  }

  private prewarmForWorkspace(id: string): void {
    // 窗口已销毁（退出中）时不再创建
    if (this.opts.win.isDestroyed()) return;
    if (this.hasUnsentNewConversation(id)) return;
    const workspace = this.workspacePathById.get(id) ?? this.opts.workspacePath;
    const key = this.nextNewKey();
    const view = this.createView(undefined, { prewarm: true, workspace });
    this.viewWorkspaces.set(key, id);
    // 提前给出正确视口尺寸：预热视图未挂到窗口，若不设 bounds 会以 0x0 渲染，
    // 切到前台再 resize 可能出现一次布局跳动。
    view.setBounds(this.chatBounds());
    this.views.set(key, view);
    this.unsentNewKeys.add(key);
    this.prewarmKeys.add(key);
    this.prewarmKey = key;
    // 预热视图不进 LRU（见 prewarmKey 注释），也不触发 loaded 变化（new- key 不算已打开会话）
  }

  /** 生成新的 `new-` 临时 key（同一毫秒内连续创建多个视图也不会撞 key） */
  private nextNewKey(): string {
    this.newKeySeq += 1;
    return `new-${Date.now()}-${this.newKeySeq}`;
  }

  /**
   * 唤醒预热的视图：告诉它「已被切到前台」，补做启动初始化。
   *
   * 交给注入的出口发一次即可（页面多半已挂载）；若此刻页面还在加载、监听器尚未注册，
   * 消息会丢，但 webview 挂载后会发 prewarmViewReady，由
   * handlePrewarmViewReady 补发（见那里）。
   */
  private activatePrewarmedView(view: WebContentsView): void {
    if (view.webContents.isDestroyed()) return;
    this.onActivatePrewarmedView?.(view);
  }

  /**
   * 预热视图报告「已挂载、可以接收消息」。
   *
   * 若它此刻已被切到前台（用户在页面加载完成前就点了「新建」），补发激活消息 ——
   * 否则 openNewConversation 直发的那次会因为监听器还没注册而丢失，视图停在 Loading。
   * 仍在后台的预热视图保持休眠，等真正被切到前台时再激活。
   */
  handlePrewarmViewReady(webContents: WebContents): void {
    const key = this.getKeyByWebContents(webContents);
    if (!key || key !== this.currentSessionId || !this.prewarmKeys.has(key)) return;
    const view = this.views.get(key);
    if (view) this.activatePrewarmedView(view);
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
    // 这个新对话已被消耗（发出第一条消息 → 开始落盘、出现在侧栏），
    // 后台补一个空闲的新对话视图，保证下次点「新建」能瞬切。
    // 已有空闲新对话时（含后台预热的）由 prewarm 内部去重。
    this.schedulePrewarmNewConversation();
  }

  /**
   * 将来源 webContents 关联到 sessionId（webview 上报 startNewConversation / loadConversation 时调用）
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
    // 临时 new- key 转为正式 sessionId：同步迁移「未发送新对话」标记与所属工作目录
    if (this.unsentNewKeys.delete(tempKey)) {
      this.unsentNewKeys.add(sessionId);
    }
    const tempWorkspace = this.viewWorkspaces.get(tempKey);
    this.viewWorkspaces.delete(tempKey);
    // 注意判 undefined 而不是真值：`''` 是合法的「未打开工作目录」空态目录，
    // 丢掉它会让 closeWorkspace('') 找不到空态视图（残留隐藏 webContents）。
    if (tempWorkspace !== undefined) {
      this.viewWorkspaces.set(sessionId, tempWorkspace);
    }
    // 预热视图已上报正式 sessionId：激活完成，清掉预热标记
    this.prewarmKeys.delete(tempKey);
    if (this.prewarmKey === tempKey) {
      this.prewarmKey = null;
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
    this.emitLoadedChanged();
  }

  /** 按 sessionId 发送消息到对应视图 */
  sendTo(sessionId: string | undefined, message: unknown): boolean {
    if (!sessionId) return false;
    const view = this.views.get(sessionId);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send('webview-message', message);
      return true;
    }
    return false;
  }

  /** 发送消息到当前活动视图（会话无关的广播类消息） */
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

  /**
   * 更新所有聊天视图的兜底背景色（主题切换时调用）。
   * 已加载完成的页面会盖住这层底色，但预热视图 / 下次加载仍会用到。
   */
  setBackgroundColor(color: string): void {
    if (this.placeholderView && !this.placeholderView.webContents.isDestroyed()) {
      this.placeholderView.setBackgroundColor(color);
    }
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) {
        view.setBackgroundColor(color);
      }
    }
  }

  /** 窗口尺寸变化时更新当前视图布局 */
  layout(): void {
    if (this.placeholderView && !this.placeholderView.webContents.isDestroyed()) {
      this.placeholderView.setBounds(this.chatBounds());
    }
    const active = this.currentSessionId ? this.views.get(this.currentSessionId) : undefined;
    if (active && !active.webContents.isDestroyed()) {
      active.setBounds(this.chatBounds());
    }
  }

  /**
   * 窗口关闭时的收尾：后台预热的视图没有挂到窗口上，不会随窗口一起销毁，
   * 需要显式关闭它的 webContents（其余视图是窗口子视图，随窗口销毁）。
   * 失去 prewarmKey 跟踪的旧预热视图同样不在窗口子视图里，一并关闭。
   */
  dispose(): void {
    this.cancelPrewarm();
    this.prewarmKey = null;
    if (this.placeholderView && !this.placeholderView.webContents.isDestroyed()) {
      this.placeholderView.webContents.close();
    }
    this.placeholderView = null;
    this.placeholderHtml = null;
    for (const key of [...this.prewarmKeys]) {
      const view = this.views.get(key);
      this.views.delete(key);
      this.viewWorkspaces.delete(key);
      this.unsentNewKeys.delete(key);
      if (view && !view.webContents.isDestroyed()) {
        try {
          view.webContents.close();
        } catch { /* 窗口正在销毁，忽略 */ }
      }
    }
    this.prewarmKeys.clear();
  }

  /** 清空所有聊天视图（工作区切换等场景） */
  disposeAll(): void {
    this.cancelPrewarm();
    this.prewarmKey = null;
    for (const key of [...this.views.keys()]) {
      this.destroyViewEntry(key);
    }
    this.views.clear();
    this.viewWorkspaces.clear();
    this.lru = [];
    this.unsentNewKeys.clear();
    this.prewarmKeys.clear();
    this.currentSessionId = null;
    this.emitLoadedChanged();
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
    // 再做纯视图销毁（不再依赖视图层内部 abort/release，见 docs/hosts/host-matrix.md 第 12 节）
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
    this.viewWorkspaces.delete(key);
    if (opts?.removeFromLru !== false) {
      this.lru = this.lru.filter((k) => k !== key);
    }
    this.unsentNewKeys.delete(key);
    this.prewarmKeys.delete(key);
    if (this.prewarmKey === key) this.prewarmKey = null;
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
      this.emitLoadedChanged();
      // 关掉的若是后台预热视图（或善后切换后已没有空闲新对话），补一个
      this.schedulePrewarmNewConversation();
      return;
    }

    // 会话被关闭：只销毁视图。MCP 引用由 core 持有（引用跟会话走）。
    this.destroyViewEntry(sessionId);

    // 关闭的是当前活动视图：切换到最近使用的其他视图；无可用视图则新建对话
    this.switchAwayFromClosedSession(sessionId);
    this.emitLoadedChanged();
    // 关掉的若是后台预热视图（或善后切换后已没有空闲新对话），补一个
    this.schedulePrewarmNewConversation();
  }

  /**
   * 关闭的会话是当前活动视图时的善后：切换到同一工作目录下最近使用的其他视图；
   * 没有则在该目录新建对话。（保持在调用侧，不属于 destroyViewEntry 的销毁序列）
   *
   * 不跨工作目录借用视图：活动视图的工作目录必须等于活动工作目录
   * （否则标题栏标签 / 侧栏列表与聊天区不一致，后续关闭该目录的标签还会
   * 让 currentSessionId 悬空在已销毁视图上）。
   */
  private switchAwayFromClosedSession(sessionId: string): void {
    if (this.currentSessionId !== sessionId) return;
    const workspaceId = this.viewWorkspaces.get(sessionId) ?? this.opts.workspaceId;
    this.currentSessionId = null;
    const next = [...this.lru]
      .reverse()
      .find((k) => this.isSameWorkspace(this.viewWorkspaces.get(k), workspaceId) && this.isViewAlive(k));
    if (next) {
      this.show(next);
    } else {
      this.openNewConversation(workspaceId);
    }
  }

  private createView(sessionId?: string, opts?: { prewarm?: boolean; workspace?: string }): WebContentsView {
    const workspace = opts?.workspace ?? this.opts.workspacePath;
    // 首帧主题：preload 读它注入 window.__initialTheme，webview 据此在 React
    // 渲染前就选对背景色（否则浅色主题会先闪一帧深色 loading 背景）。
    const initialTheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
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
          `--workspace=${workspace}`,
          `--locale=${this.opts.locale}`,
          `--systemLocale=${this.opts.systemLocale}`,
          // 语言 / 字号每次建视图实时读取：设置保存后新开视图首帧即为新档位
          // （启动期 opts 值只作读盘失败时的回退）
          `--uiLanguage=${this.opts.readUiPreferences?.()?.uiLanguage ?? this.opts.uiLanguage ?? 'auto'}`,
          `--uiFontSize=${this.opts.readUiPreferences?.()?.uiFontSize ?? this.opts.uiFontSize ?? 'medium'}`,
          `--highlightLanguages=${(this.opts.highlightLanguages || []).join(',')}`,
          `--conversationListOwner=${this.opts.conversationListOwner ?? 'host'}`,
          `--theme=${initialTheme}`,
          ...(sessionId ? [`--session=${sessionId}`] : []),
          // 预热视图：页面照常加载，但跳过启动初始化，等被切到前台再补做
          ...(opts?.prewarm ? ['--prewarm=1'] : []),
        ],
      },
    });

    const indexPath = path.join(this.opts.appRoot, 'dist', 'webview', 'index.html');
    const url = sessionId
      ? `file://${indexPath.replace(/\\/g, '/')}?session=${encodeURIComponent(sessionId)}`
      : `file://${indexPath.replace(/\\/g, '/')}`;
    view.setBackgroundColor(chatViewBackgroundColor()); // 加载期间铺主题底色，避免闪烁
    // 页面加载完成后补发当前对话列表渲染方。
    // 页面就绪前 send 会丢（webview 的 message 监听器还没注册，见 activatePrewarmedView
    // 的同类处理）：若视图创建后、加载完成前用户切了悬浮窗，它就会停在 host 形态
    // （无历史列表、无「+」、有关闭按钮）。补发一次保证与当前渲染方一致；渲染方未变时
    // webview 侧的 setConversationListOwner 是空操作，不会产生多余重渲染。
    view.webContents.on('did-finish-load', () => {
      if (view.webContents.isDestroyed()) return;
      view.webContents.send('webview-message', this.conversationListOwnerMessage(this.opts.conversationListOwner ?? 'host'));
    });
    void view.webContents.loadURL(url);

    // 外部链接防御：webview 内任何 window.open / target=_blank / <a href> 导航都不在
    // Electron 中打开，统一交给系统默认浏览器（见 electron/viewNavigation.ts）。
    // webview 侧的全局点击拦截（src/webview/App.tsx）已覆盖常规点击，这里是第二道防线：
    // 未被 JS 拦截的导航（修饰键点击 / 脚本导航 / 拖放）同样落到这里。
    guardViewNavigation(view.webContents, 'chat-view');

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
          // 视图可能在等待期间被销毁（删除 / 切工作区）：webContents.close() 后
          // WebContentsView.webContents 变为 undefined（类型标注已不反映运行时），
          // 崩溃重载对死视图无意义，直接跳过
          const wc = view.webContents as WebContents | undefined;
          if (!wc || wc.isDestroyed()) return;
          if (wc.isCrashed()) wc.reload();
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
    // 预热视图被切到前台：补发激活消息让它完成启动初始化。
    // 任何路径把预热视图切到前台（复用预热 / 切回目录 / 关闭善后）都必须覆盖，
    // 否则 webview 会一直停在 Loading；重复发送由 webview 幂等忽略。
    if (this.prewarmKeys.has(sessionId)) this.activatePrewarmedView(view);
    view.webContents.focus();
    this.opts.onActiveSessionChanged(sessionId);
  }
}

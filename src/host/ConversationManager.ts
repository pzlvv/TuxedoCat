/**
 * ConversationManager - 对话相关数据的宿主契约（第三个 UI surface）
 *
 * 分发两条互相独立的流（DEVELOPMENT.md 第 5.4 节）：
 *
 * |          | 流 1：对话列表                     | 流 2：会话运行时状态              |
 * | -------- | --------------------------------- | -------------------------------- |
 * | 内容     | 磁盘元数据（title/createdAt/...）   | idle / waiting                   |
 * | 数据源   | 磁盘（core 的 loadConversationList）| core 的 sessionRuntime           |
 * | 变化频率 | 低（落盘/改名/删除/新建）           | 高（每次查询开始结束、等用户）      |
 * | 触发     | CoreEvent.conversationListChanged | CoreEvent.sessionRuntimeChanged  |
 * | 消费者   | webview 子对话树、Electron 原生侧栏 | Electron 侧栏流水灯、系统托盘      |
 *
 * 两条流分开推：列表只承载磁盘事实，不把 idle/waitingForUser「贴」上去，
 * 状态变化也就不必重读盘；托盘直接吃状态流。
 *
 * 用抽象类而不是接口：load() 两端一致、只有 dispatch*() 不同，
 * 模板方法把共享部分固定在基类。
 *
 * 空闲会话回收只在 VS Code 生效（Electron 每个对话一个独立视图，自动关闭等于关掉
 * 用户的窗口），实现在 SingleWebViewConversationManager。
 */

import type { ConversationMetadata } from '../core/history/Conversation.js';
import { loadConversationListForHost } from './coreFacts.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import type { UIHost } from './UIHost.js';

export abstract class ConversationManager {
  constructor(protected readonly host: UIHost) {}

  // ===================== 流 1：对话列表 =====================

  /** 最近一次 refresh() 分发的列表快照（见 getCachedList） */
  private cachedList: readonly ConversationMetadata[] | null = null;

  /**
   * 快照对应的活动工作目录。
   * 列表是「按目录」的：读盘期间用户可能切换活动目录，此时旧目录的列表既不进
   * 快照、也不推给界面（否则侧栏/子对话树会显示上一个目录的对话）。
   */
  private cachedListWorkspace: string | undefined;

  /**
   * 重新读取对话列表并分发给该宿主所有需要它的界面。
   *
   * 失败自持（只记日志）：调用方多是 fire-and-forget（`void refresh()`），而读列表
   * 走的 UiRequest 会在连接关闭 / Core 重启窗口被总线就地拒绝（第 3.7 节）——这里若
   * 把失败抛出去，就会变成未处理 rejection 按进程级错误崩掉宿主。刷新本来就是
   * 「尽力而为」：失败后下一次 conversationListChanged 会再触发。
   */
  async refresh(): Promise<void> {
    try {
      const workspace = this.host.getWorkspacePath();
      const list = await this.load();
      // 读盘期间活动工作目录已切换：丢弃过期结果，等新目录自己的 refresh()
      if (this.host.getWorkspacePath() !== workspace) return;
      this.cachedList = list;
      this.cachedListWorkspace = workspace;
      await this.dispatchList(list);
    } catch (error) {
      this.host.log(`[conversations] refresh failed: ${String(error)}`);
    }
  }

  /**
   * 读对话列表（source of truth，两端一致）。
   *
   * Embedded 下直接读盘；Standalone 下经 `UiRequest.conversationListRequested`
   * 向 Core 索取——宿主不直接读 core 的磁盘数据（规格第 10 节）。
   */
  protected async load(): Promise<ConversationMetadata[]> {
    return loadConversationListForHost(this.host.getWorkspacePath() ?? undefined);
  }

  /** 把纯磁盘列表分发给该宿主的界面 */
  protected abstract dispatchList(list: readonly ConversationMetadata[]): Promise<void>;

  /**
   * 最近一次分发的对话列表快照（从未分发过时为 null）。
   *
   * 宿主用它响应「拉取列表」请求——Electron 的 `sidebar:get-conversations`
   * 优先读这份快照，不必再读一次盘；列表变化本来就会经 `conversationListChanged`
   * → `refresh()` 更新快照并推送。
   *
   * 活动工作目录与快照不一致时返回 null（等价于「未缓存」），
   * 调用方会重新 refresh 拿到当前目录的列表。
   */
  getCachedList(): readonly ConversationMetadata[] | null {
    if (this.cachedList === null) return null;
    if (this.cachedListWorkspace !== this.host.getWorkspacePath()) return null;
    return this.cachedList;
  }

  /** 丢弃列表快照（工作区切换等场景），下次拉取时重新读盘 */
  invalidateCachedList(): void {
    this.cachedList = null;
    this.cachedListWorkspace = undefined;
  }

  // ===================== 流 2：会话运行时状态 =====================

  /** 最近一次 sessionRuntimeChanged 的全量快照（供新视图主动拉取，见 getSessionStatesSnapshot） */
  private latestStates: readonly SessionRuntimeState[] = [];

  /**
   * 把最新的会话状态分发给该宿主的界面。
   * states 由 core 的全量推送（CoreEvent.sessionRuntimeChanged）提供，不做增量合并。
   */
  updateSessionStates(states: readonly SessionRuntimeState[]): void {
    this.latestStates = states;
    this.dispatchStates(states);
  }

  /**
   * 最近一次会话运行时状态快照。
   *
   * 视图创建 / 切换时 webview 会主动拉一次（避免错过只推变化的广播）。
   * Standalone 下进程内的 `sessionRuntime` 模块不会被写入，必须用这份缓存，
   * 否则拉取恒为空、流水灯与 abort 按钮失明。
   */
  getSessionStatesSnapshot(): readonly SessionRuntimeState[] {
    return this.latestStates;
  }

  /** 把会话状态分发给该宿主的界面 */
  protected abstract dispatchStates(states: readonly SessionRuntimeState[]): void;

  /**
   * 注册会话状态回调，可选。
   * Electron 用它驱动系统托盘状态点与「任务结束」闪烁提醒；VS Code 不注册。
   */
  setStatusListener(fn: (states: readonly SessionRuntimeState[]) => void): void {
    this.statusListener = fn;
  }

  /** 已注册的状态回调（Electron 托盘）；未注册时为 null */
  protected statusListener: ((states: readonly SessionRuntimeState[]) => void) | null = null;

  /**
   * 设置「推侧栏」的出口（Electron 专用：侧栏就绪后由宿主替换 no-op 占位）。
   * VS Code 没有原生侧栏，不调用。
   */
  setSidebarOutlet(fn: (channel: string, payload: unknown) => void): void {
    this.sidebarOutlet = fn;
  }

  /** 侧栏出口（Electron 用；未设置时 no-op） */
  protected sidebarOutlet: ((channel: string, payload: unknown) => void) | null = null;

  // ===================== 空闲会话回收钩子（VS Code 专属） =====================

  /**
   * 记录会话活动，重置该会话的空闲关闭计时。
   * 空闲回收只在 VS Code 生效，基类默认无操作，
   * 由 SingleWebViewConversationManager 覆盖。
   */
  noteSessionActivity(_sessionId: string): void {
    /* 默认无操作 */
  }
}

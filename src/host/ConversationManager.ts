/**
 * ConversationManager - 对话相关数据的宿主契约（第三个 UI surface）
 *
 * 分发两条互相独立的流（docs/architecture/contracts.md 第 4 节）：
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

import type { ConversationMetadata } from '../shared/history/Conversation.js';
import { loadConversationListForHost } from './coreFacts.js';
import type { SessionRuntimeState } from '../shared/AssistantEventBus.js';
import type { UIHost } from './UIHost.js';

export abstract class ConversationManager {
  constructor(protected readonly host: UIHost) {}

  // ===================== 流 1：对话列表 =====================

  /**
   * 每个工作目录一份列表快照（`list`）+ 是否可能落后于磁盘（`dirty`）。
   *
   * 多工作目录宿主（Electron）切换标签页时直接命中目标目录的快照，不再每次完整
   * 读盘 / 走 `conversationListRequested` 网络往返（与 Core 自己的
   * `conversationListCaches` 同一策略：缓存只被本进程的落盘事件驱动更新）。
   * `dirty` 见 `onConversationListChanged`。
   */
  private readonly listSnapshots = new Map<string, { list: readonly ConversationMetadata[]; dirty: boolean }>();

  /**
   * 重新读取**当前活动目录**的对话列表并分发给该宿主所有需要它的界面，
   * 顺带把结果存成该目录的快照（标记为干净）。
   *
   * 失败自持（只记日志）：调用方多是 fire-and-forget（`void refresh()`），而读列表
   * 走的 UiRequest 会在连接关闭 / Core 重启窗口被总线就地拒绝（``docs/architecture/events.md` 第 6 节）——这里若
   * 把失败抛出去，就会变成未处理 rejection 按进程级错误崩掉宿主。刷新本来就是
   * 「尽力而为」：失败后下一次 conversationListChanged 会再触发。
   */
  async refresh(): Promise<void> {
    try {
      const workspace = this.host.getWorkspacePath();
      const list = await this.load();
      // 读盘期间活动工作目录已切换：丢弃过期结果，等新目录自己的 refresh()
      if (this.host.getWorkspacePath() !== workspace) return;
      this.listSnapshots.set(this.workspaceCacheKey(), { list, dirty: false });
      await this.dispatchList(list);
    } catch (error) {
      this.host.log(`[conversations] refresh failed: ${String(error)}`);
    }
  }

  /**
   * `conversationListChanged`（磁盘列表变了）的入口：活动目录立即重读，
   * 其余目录的快照标记脏。返回活动目录的重读完成（fire-and-forget 调用加 `void`）。
   *
   * 事件不带目录信息：变化多半发生在活动目录（重读已覆盖）；但后台目录的对话
   * 视图仍在落盘（多视图宿主里切走 ≠ 停止运行），无法排除，只能标记脏——
   * 下次切到该目录时先返回快照、后台重新读盘补推（stale-while-revalidate）。
   * 尚无快照的目录无需标脏：无缓存可命中，拉取本来就会完整读盘。
   */
  onConversationListChanged(): Promise<void> {
    const active = this.host.getWorkspacePath() ?? '';
    for (const [workspace, snapshot] of this.listSnapshots) {
      if (workspace !== active) snapshot.dirty = true;
    }
    return this.refresh();
  }

  /**
   * 读对话列表（source of truth，两端一致）。
   *
   * 经 `UiRequest.conversationListRequested` 向 Core 请求
   * 向 Core 索取——宿主不直接读 core 的磁盘数据（`docs/core/standalone-core-boundaries.md` 第 2 节）。
   */
  protected async load(): Promise<ConversationMetadata[]> {
    return loadConversationListForHost(this.host.getWorkspacePath() ?? undefined);
  }

  /** 把纯磁盘列表分发给该宿主的界面 */
  protected abstract dispatchList(list: readonly ConversationMetadata[]): Promise<void>;

  /**
   * 当前活动工作目录最近一次分发的对话列表快照（没有快照时为 null）。
   *
   * 宿主用它响应「拉取列表」请求——Electron 的 `sidebar:get-conversations`
   * 优先读这份快照，不必再读一次盘；列表变化本来就会经 `conversationListChanged`
   * → `onConversationListChanged()` 更新快照并推送。每个目录各留一份快照，
   * 切换目录后旧目录的快照仍在，切回来继续命中。
   */
  getCachedList(): readonly ConversationMetadata[] | null {
    return this.listSnapshots.get(this.workspaceCacheKey())?.list ?? null;
  }

  /**
   * 当前活动工作目录的快照是否可能落后于磁盘（没有快照时谈不上过期，返回 false）。
   *
   * 调用方命中脏快照时的约定：先返回快照让界面即时渲染，再后台 `refresh()`
   * 重新读盘，读到后经 `dispatchList` 推送更新。
   */
  isCachedListStale(): boolean {
    return this.listSnapshots.get(this.workspaceCacheKey())?.dirty ?? false;
  }

  /**
   * 快照缓存键：活动工作区的身份。默认用路径（单工作区宿主路径即身份）；
   * 多工作区宿主覆写为稳定 id（`workspaceRefKey`）——同路径不同主机的两个远程
   * 工作区不能共享一份快照（Windows 上本地规范化还会把远程路径变形归一）。
   */
  protected workspaceCacheKey(): string {
    return this.host.getWorkspacePath() ?? '';
  }

  /** 丢弃指定快照键的列表快照（关闭工作目录等场景；键与 `workspaceCacheKey` 同一口径），下次拉取时重新读盘 */
  invalidateCachedList(workspace: string): void {
    this.listSnapshots.delete(workspace);
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
   * Electron 用它驱动系统托盘状态点、「任务结束」闪烁提醒与系统睡眠阻断；VS Code 不注册。
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

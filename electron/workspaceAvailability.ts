/**
 * 工作区标签页的连接状态机（`docs/hosts/host-matrix.md`「不可用工作区」）。
 *
 * 三态：available 可用 / unavailable 不可用（红点）/ connecting 建链中（黄色呼吸点），
 * 按工作区去重键（`workspaceRefKey`）记录。这是 Electron 主进程专属事实（VS Code
 * 单工作目录没有标签页）；纯状态、无宿主依赖，独立成模块以便单测锁死「连接失败
 * 信号（lost）与可达性探测落定」的时序——两条失败信号的到达顺序不定，任何顺序下
 * 状态都必须落定为真实值。
 *
 * 三态优先级：connecting > unavailable > available。建链中的黄点遮蔽红点是重新
 * 连接期间的预期表现；反过来**落定不可用必须清掉建链中**：否则标红时推送的
 * availability 仍是 connecting（黄），同键的后续标记又被去重守卫拦下不再刷新，
 * 标签页黄点一直挂到用户点击标签页触发全量刷新为止（实测回归，
 * 见 `src/test/workspaceAvailability.test.ts`）。
 */

/** 标签页连接状态 */
export type WorkspaceAvailability = 'available' | 'unavailable' | 'connecting';

export class WorkspaceAvailabilityState {
  // ===================== 状态集合（按去重键） =====================

  /** 建链中：启动恢复的远程项在探测落定前、点击「重新连接」期间 */
  private readonly connecting = new Set<string>();

  /** 不可用：启动期判定（本地目录缺失 / 远程建连失败），标签页保留并挂红点 */
  private readonly unavailable = new Set<string>();

  /** Connection 曾就绪过：区分「建连失败」（标红）与「运行期 Core 退出」（重启策略恢复） */
  private readonly ready = new Set<string>();

  // ===================== 写入 =====================

  /** 进入建链中（启动恢复的远程项 / 点击「重新连接」） */
  markConnecting(key: string): void {
    this.connecting.add(key);
  }

  /** 建链中落定（探测出结果 / 重新连接收尾）后清掉呼吸点 */
  clearConnecting(key: string): void {
    this.connecting.delete(key);
  }

  /** Connection 就绪过（每次收到 coreReady 时登记） */
  markReady(key: string): void {
    this.ready.add(key);
  }

  /** 重新打开时清掉上一世的就绪标记：新的一次建连从「未就绪」算起 */
  clearReady(key: string): void {
    this.ready.delete(key);
  }

  /**
   * 落定不可用：建链中与不可用互斥，先清再判——即使本次被去重守卫挡住
   * （重复标记 / 曾就绪过），清除也已生效，调用方的下一次刷新画出的就是真实状态。
   *
   * 返回是否发生了新标记：false（重复标记，或 Connection 曾就绪过——探测与建链
   * 竞态的输家不否定赢家）时调用方跳过销毁 / 刷新等副作用。
   */
  markUnavailable(key: string): boolean {
    this.connecting.delete(key);
    if (this.unavailable.has(key)) return false;
    if (this.ready.has(key)) return false;
    this.unavailable.add(key);
    return true;
  }

  /**
   * 落定「运行期致命」不可用（曾就绪过、且 Host 侧无法自动恢复）：撤销就绪豁免后
   * 按 `markUnavailable` 落定。远程 daemon / 链路死亡属于此类——重启策略在 daemon
   * 手里，Host 侧不会自己恢复，红点 + 占位页「重新连接」是唯一出路；本地 Core 退出
   * 由 Host 侧重启策略恢复（恢复后 coreReady 重新 markReady），不走这里。
   */
  markRuntimeFatal(key: string): boolean {
    this.ready.delete(key);
    return this.markUnavailable(key);
  }

  /** 撤销不可用判定（探测成功恢复 / 目录重新存在）。返回是否真的撤销过（曾标红时调用方要补建 Connection） */
  revokeUnavailable(key: string): boolean {
    return this.unavailable.delete(key);
  }

  /** 关闭标签页 / 重连成功：丢弃该键的全部判定，之后按全新打开处理 */
  clearAll(key: string): void {
    this.unavailable.delete(key);
    this.connecting.delete(key);
    this.ready.delete(key);
  }

  // ===================== 读取 =====================

  /** 是否处于建链中（启动探测只探测处于建链中的项） */
  hasConnecting(key: string): boolean {
    return this.connecting.has(key);
  }

  /** 标签页连接状态：connecting 优先于 unavailable（重新连接期间黄点遮蔽红点） */
  availabilityOf(key: string): WorkspaceAvailability {
    if (this.connecting.has(key)) return 'connecting';
    return this.unavailable.has(key) ? 'unavailable' : 'available';
  }

  /** 是否可建 Connection：只排除不可用；建链中的项同样要建（建链正是它的目的） */
  isAvailable(key: string): boolean {
    return !this.unavailable.has(key);
  }
}

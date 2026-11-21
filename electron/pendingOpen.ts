/**
 * 「视图已建好、会话内容尚未装载完成」的登记（Electron 多视图宿主）。
 *
 * 一次打开要读盘 + 传输整段会话；在数据到达之前那条对话并不算「已打开」——
 * 侧栏绿点与 `UserChoiceQueue` 的 open 判定都应该看到事实，而不是「视图对象已存在」
 * 这个中间态（`docs/architecture/contracts.md` 第 4 节的 loaded 口径）。
 *
 * 打开还可能被 Core 直接拒绝：同一对话已被另一个实例持有（specs/032 / US-66）。
 * 那时这次打开必须整体撤销——销毁本次新建的视图、把界面交回打开前展示的那条对话
 * （它一直存活，消息、滚动位置与输入内容都保留），即「失败的打开动作无副作用」
 * （[docs/core/client-connection.md](../../../core/client-connection.md) 的会话跨实例独占）。
 *
 * 本模块零依赖：只记事实，视图的创建 / 销毁 / 切换全部留在 `ChatViewManager`。
 */
export interface PendingOpen {
  /**
   * 打开这条对话之前正在展示的视图 key；`null` = 之前没有可用的对话视图。
   *
   * 撤销时据此回到原位置：那些视图从不因「打开别的对话」而销毁，因此回到它们
   * 就是回到打开前的完整状态。
   */
  previousKey: string | null;
}

export class PendingOpenRegistry {
  private readonly entries = new Map<string, PendingOpen>();

  /**
   * 登记一次打开。
   *
   * 同一条对话已有登记时保留原记录：「打开前那一个」在装载完成之前不会再变，
   * 用户在等待中连点多次时重新登记会把正在加载的视图自己当成上一个视图，
   * 撤销后就回到了刚被撤销的那一个。
   */
  begin(sessionId: string, previousKey: string | null): void {
    if (this.entries.has(sessionId)) return;
    this.entries.set(sessionId, { previousKey });
  }

  /** 该会话是否仍在等装载完成 */
  isPending(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** 「已打开会话」集合的判据：排除仍在等装载完成的会话 */
  onlySettled(keys: readonly string[]): string[] {
    return keys.filter((key) => !this.entries.has(key));
  }

  /** 装载完成：注销登记；返回 false 表示没有在途打开（迟到的完成） */
  settle(sessionId: string): boolean {
    return this.entries.delete(sessionId);
  }

  /** 打开被拒：注销登记并交回撤销所需的事实；`null` = 没有对应的在途打开 */
  reject(sessionId: string): PendingOpen | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    this.entries.delete(sessionId);
    return entry;
  }

  /** 视图被别处销毁（关闭 / LRU 淘汰 / 关闭工作区）：幂等清理 */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}

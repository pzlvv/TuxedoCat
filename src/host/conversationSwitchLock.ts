/**
 * 对话切换锁的登记表（specs/059 FR-007）。
 *
 * 为什么单独成模块：锁的判据是宿主侧唯一的，而它要同时服务两件事——webview 的上报
 * （`conversationSwitchLockChanged`）与主进程各入口的早返回（标签页、侧栏、菜单动作）。
 * 放在 `ElectronUIHost` 里就得连 electron 一起测；抽出来是纯数据结构，判据可逐条单测。
 *
 * 为什么按视图做键（而不是全局一个布尔）：一个标签页弹着部署确认框，不该锁住别的标签页
 * 里正常的对话切换。键是视图自己的对象标识（Electron 侧即 `WebContents`），因此这里
 * 只要求「同一对象认得出自己」。
 */

/** 锁的原因（只用于日志与诊断，不渲染给用户） */
export type ConversationSwitchLockReason = string;

export class ConversationSwitchLock {
  /**
   * 锁着对话切换的视图集合。
   *
   * 用 `Set<object>` 而不是按会话 id 记：锁的生命周期只有「一次提交」，
   * 而一次提交可能在视图换会话之前就结束——按会话记会漏清或误清。
   */
  private readonly locked = new Set<object>();

  /**
   * 登记 / 撤销一个视图的锁。
   *
   * `view` 为 `null` 时**不动作**：锁必须指明是哪个视图，没有来源就是接线错误，
   * 猜一个视图去锁会误伤其它标签页（不过度 fallback）。
   */
  set(view: object | null, locked: boolean): void {
    if (!view) return;
    if (locked) this.locked.add(view);
    else this.locked.delete(view);
  }

  /**
   * 该视图是否锁着。
   *
   * `view` 为 `null` 时返回 false：主进程有些入口没有来源视图（宿主主动触发），
   * 它们不能被一个「猜出来」的锁挡住，否则用户会看到随机失效的菜单项。
   */
  isLocked(view: object | null): boolean {
    if (!view) return false;
    return this.locked.has(view);
  }

  /** 当前锁着的视图数量（诊断 / 测试用） */
  get size(): number {
    return this.locked.size;
  }

  /**
   * 该视图被销毁时清掉它的锁。
   *
   * 视图销毁而锁没清的话，同一个 `WebContents` 对象若被复用就会带上残留的锁——
   * 部署确认框早已不见，界面却切不动对话。
   */
  release(view: object | null): void {
    if (!view) return;
    this.locked.delete(view);
  }
}

/**
 * ManualBackground - 前台 Bash 命令的手工转后台注册表
 *
 * 用户在 Bash 卡片上点「转后台」（`UiEvent.bashBackgroundRequested`，见
 * DEVELOPMENT.md 第 4.3 节）时，把**正在前台运行**的那次执行转入后台。
 *
 * 生命周期归 `Exec.execForeground`：spawn 后登记（触发器即其内部的
 * `triggerAutoBackground('user-requested')`），命令收尾（完成 / 中止 / 已转后台 /
 * 出错）时注销。本模块只维护 toolUseId → 触发器的映射，不持有进程状态。
 *
 * 手工转后台与自动转后台（超时 / 通知驱动）共用 `autoBackgroundCommand`，
 * 区别只有两点（Standalone 侧为 `tools.rs` 的 `MANUAL_BG` 注册表 +
 * `LoopPauseSignal`，parity）：
 * 1. 转换成功后置引擎的循环暂停标记（`QueryEngine.requestLoopPause`）：
 *    工具结果照常进入上下文，但下一轮 LLM 请求不发起——会话回到
 *    「等待用户输入」；队列消息（用户消息 / 后台完成通知 / 提醒）到达时
 *    由既有入队路径立刻拉起新一轮（规格见 `docs/manual-background.md`，
 *    消费循环本身见 `docs/user-message-pipeline.md` 第 4 节）。
 * 2. 该任务同时登记进「已兜底提醒」集合：查询收尾的兜底提醒会为运行中的
 *    后台任务立刻补一条 reminder 并拉起新查询——那等于被转后台结果本身
 *    触发了接续循环，违背第 1 点的暂停语义，因此跳过。
 */

/** 前台执行触发器：幂等（执行已收尾时为 no-op），由 Exec 层闭包提供 */
type ForegroundTrigger = () => void;

const foregroundTriggers = new Map<string, ForegroundTrigger>();

/** 登记一次可手工转后台的前台执行（`Exec.execForeground` spawn 后调用） */
export function registerForegroundBashTrigger(toolUseId: string, trigger: ForegroundTrigger): void {
  foregroundTriggers.set(toolUseId, trigger);
}

/** 注销（`Exec.execForeground` 的全部收尾路径调用；未登记时 no-op） */
export function unregisterForegroundBashTrigger(toolUseId: string | undefined): void {
  if (!toolUseId) return;
  foregroundTriggers.delete(toolUseId);
}

/** 该 toolUseId 是否仍有一台前台执行在跑（测试探针，也可用于 UI 侧判定） */
export function isForegroundBashRunning(toolUseId: string): boolean {
  return foregroundTriggers.has(toolUseId);
}

/**
 * 触发手工转后台。
 * @returns 是否存在匹配的前台执行；不存在（命令已结束 / 从未登记）时为 false，
 *          调用方据此什么都不做（幂等，不过度兜底）。
 */
export function requestManualBackground(toolUseId: string): boolean {
  const trigger = foregroundTriggers.get(toolUseId);
  if (!trigger) return false;
  trigger();
  return true;
}

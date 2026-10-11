/**
 * 系统电源阻断（Electron `powerSaveBlocker`）：任一会话非 idle 时阻止系统进入
 * 睡眠 / 休眠，全部空闲后立即释放（`docs/host-matrix.md` 第 6 节宿主接线、
 * docs/host-matrix.md 第 12 节托盘段落）。
 *
 * 为什么在宿主：电源状态是桌面端集成能力，core 只描述「会话是否空闲」的事实，
 * 表现由 UI 决定（`DEVELOPMENT.md` 第 5.6 节）。判定复用 core 的 `sessionBusyLevel`，与托盘状态点 /
 * 标签页流水灯 / 关闭确认同一份派生——`waiting`（等用户确认）也非 idle，同样阻断。
 *
 * 阻断类型取 `prevent-app-suspension` 而非 `prevent-display-sleep`：跑任务时允许屏幕
 * 熄灭，只要求系统不挂起（长时间 LLM 查询 / 后台 Bash 不因睡眠中断）。
 *
 * Electron 依赖经构造参数注入（`PowerSaveBlockerPort`），纯状态机可单测。
 */
import { sessionBusyLevel } from '../src/core/sessionRuntime.js';
import type { SessionRuntimeState } from '../src/core/AssistantEventBus.js';

/**
 * 注入的 `powerSaveBlocker` 能力（Electron 模块的子集）。
 * 只声明用到的两个成员，测试替身不必实现其余成员。
 */
export interface PowerSaveBlockerPort {
  /** 开始阻断，返回阻断 id（后续 stop 用） */
  start(type: 'prevent-app-suspension'): number;
  /** 结束阻断 */
  stop(id: number): void;
}

/**
 * 这份会话状态快照是否需要阻断系统睡眠 / 休眠：
 * 任一会话非 idle（查询 / 压缩 / 后台 Bash / 子代理 / 等待用户）即需要。
 *
 * 只读、无副作用；判定口径与托盘状态点（`deriveTrayStatusFromStates`）一致。
 */
export function shouldPreventSleep(
  states: ReadonlyArray<Pick<SessionRuntimeState, 'idle' | 'waiting'>>,
): boolean {
  return states.some((state) => sessionBusyLevel(state) !== 'idle');
}

/**
 * 睡眠阻断的状态机：吃 core 的全量会话状态快照（`sessionRuntimeChanged`），
 * 维护「当前是否已阻断」这一个事实。
 *
 * 全量快照可能高频重复推送，故 `update` 幂等：已阻断时不重复 start，
 * 未阻断时不重复 stop——`powerSaveBlocker` 的阻断 id 不会被泄漏或误停。
 */
export class SleepBlocker {
  /** 当前生效的阻断 id；null = 未阻断 */
  private blockerId: number | null = null;

  constructor(private readonly api: PowerSaveBlockerPort) {}

  /** 按最新全量快照更新阻断（有非 idle 会话 → 阻断；全部空闲 → 释放） */
  update(states: ReadonlyArray<Pick<SessionRuntimeState, 'idle' | 'waiting'>>): void {
    if (shouldPreventSleep(states)) this.acquire();
    else this.release();
  }

  /** 应用退出：释放阻断（幂等），避免进程退出前仍占着系统的电源请求 */
  dispose(): void {
    this.release();
  }

  private acquire(): void {
    if (this.blockerId !== null) return;
    this.blockerId = this.api.start('prevent-app-suspension');
  }

  private release(): void {
    if (this.blockerId === null) return;
    this.api.stop(this.blockerId);
    this.blockerId = null;
  }
}

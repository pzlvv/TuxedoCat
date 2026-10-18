/**
 * 会话运行时状态的宿主侧派生工具。
 *
 * 会话运行时事实（idle / waiting / queryRunning 等）的 owner 是 Core 进程：
 * Core 经 `CoreEvent.sessionRuntimeChanged` 全量推送，宿主只缓存与派生，
 * 不在宿主进程内维护任何运行时登记表。
 */

import type { SessionRuntimeState } from './AssistantEventBus.js';

/**
 * 会话忙闲的单一派生：`waiting`（等用户）> `running`（任一活动）> `idle`。
 *
 * 流水灯（标签页 / 侧栏）、托盘状态点、关闭前的二次确认都消费这一个函数——
 * 此前三处各写一遍判定且口径互相矛盾（「等用户但空闲」的会话，关闭对话不问、
 * 关闭工作区却问）。`idle === true` 但 `waiting === true` 的会话是 busy 的：
 * 引擎已空闲但有一件事必须用户拍板。
 */
export function sessionBusyLevel(
  state: Pick<SessionRuntimeState, 'idle' | 'waiting'>,
): 'idle' | 'waiting' | 'running' {
  if (state.waiting) return 'waiting';
  return state.idle ? 'idle' : 'running';
}

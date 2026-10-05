/**
 * 托盘「任务结束提醒」的事件差分（`electron/main.ts` 的 startAttention 数据源）。
 *
 * 托盘状态点的**颜色**吃聚合状态（`deriveTrayStatusFromStates`：waiting > running >
 * idle），但**闪烁**是单会话事件：任一会话从运行中结束（完成或转等待）都要提醒，
 * 即使别的会话还在跑——两个对话在跑时其中一个完成，聚合状态仍是 running，
 * 用户同样不该错过，此时红点闪。
 *
 * core 只推全量 `sessionRuntimeChanged` 快照（第 4.5 节），没有单会话结束事件；
 * 这里对相邻两次全量推送按 sessionId 差分出事件，不引入新的事件流。
 */

import { sessionBusyLevel } from '../src/core/sessionRuntime.js';

/** 单个会话的忙闲级别（与托盘状态点同一套取值，派生收敛在 core 的 sessionBusyLevel） */
export type SessionLevel = 'idle' | 'running' | 'waiting';

export interface SessionEndEvents {
  /** 本次推送里至少一个会话从 running 变为 idle（完成提醒） */
  anyCompleted: boolean;
  /** 本次推送里至少一个会话从 running 变为 waiting（等待提醒） */
  anyNowWaiting: boolean;
}

/**
 * 差分两次全量推送，产出「任务结束」事件与推进后的级别表。
 *
 * - 只有 running → idle / waiting 算事件：waiting → running（用户已应答继续跑）、
 *   idle → waiting、running → running 都不是「任务结束」；
 * - 新出现的会话只登记不产生事件：应用启动 / 切换工作区时恢复出的 waiting 会话
 *   不是刚结束的任务，不应触发提醒；
 * - 本次推送里消失的会话从级别表移除且不产生事件：关闭对话 / 切换工作区是用户
 *   主动动作，不是任务结束。
 *
 * `prev` 是上一次推送的级别表（上次返回的 `next`），由调用方持有；本函数不修改它。
 */
export function diffSessionEndEvents(
  prev: ReadonlyMap<string, SessionLevel>,
  states: ReadonlyArray<{ sessionId: string; idle?: boolean; waiting?: boolean }>,
): { next: Map<string, SessionLevel> } & SessionEndEvents {
  const next = new Map<string, SessionLevel>();
  let anyCompleted = false;
  let anyNowWaiting = false;

  for (const item of states) {
    const level = sessionBusyLevel({ idle: item.idle ?? true, waiting: item.waiting ?? false });
    const before = prev.get(item.sessionId);
    if (before === 'running' && level === 'idle') anyCompleted = true;
    if (before === 'running' && level === 'waiting') anyNowWaiting = true;
    next.set(item.sessionId, level);
  }

  return { next, anyCompleted, anyNowWaiting };
}

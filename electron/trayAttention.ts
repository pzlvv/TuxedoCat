/**
 * 托盘「任务结束提醒」的事件差分（`electron/main.ts` 的 startAttention 数据源）。
 *
 * 托盘状态点的**颜色**吃聚合状态（`deriveTrayStatusFromStates`：waiting > running >
 * idle），但**闪烁**是单会话事件：任一会话从运行中结束（完成或转等待）都要提醒，
 * 即使别的会话还在跑——两个对话在跑时其中一个完成，聚合状态仍是 running，
 * 用户同样不该错过，此时红点闪。
 *
 * 「子对话完成」不提醒：子代理会话（`parentSessionId` 非空）自身的完成不是任务
 * 结束——主对话还在跑；父会话**仅因子代理在跑**而忙（spin 模式）时子代理跑完
 * 落回 idle 也不是——那是子对话一轮的结束，不是主对话完成。「转等待用户」
 * （running → waiting，ask user / 权限确认）不受此抑制，照常提醒。
 *
 * 「完成」还要过一道**确认窗口**才算数：空闲挂起项（`docs/features/user-message-pipeline.md`
 * FR-003，webview 本地事实）与排队压缩等队列续跑都发生在 idle 推送**之后**——
 * 差分看到 running → idle 时队列里可能还有活，立即提醒就是误报。完成先记入
 * `completedSessions` 由调用方挂确认窗口，窗口结束时会话仍空闲 / 等用户
 * （`shouldFireCompletion`）才提醒；期间又跑起来（挂起项提交、队列续跑）则取消，
 * 真正的完成由续跑任务自己的 running → idle 再触发。
 *
 * core 只推全量 `sessionRuntimeChanged` 快照（docs/core/session-runtime.md），没有单会话结束事件；
 * 这里对相邻两次全量推送按 sessionId 差分出事件，不引入新的事件流。
 */

import { sessionBusyLevel } from '../src/shared/sessionRuntime.js';

/** 单个会话的忙闲级别（与托盘状态点同一套取值，派生收敛在 core 的 sessionBusyLevel） */
export type SessionLevel = 'idle' | 'running' | 'waiting';

/** 差分用到的快照字段（core `SessionRuntimeState` 的子集，缺省按「无此事实」处理） */
export interface SessionRuntimeSummary {
  sessionId: string;
  idle?: boolean;
  waiting?: boolean;
  queryRunning?: boolean;
  compacting?: boolean;
  backgroundRunning?: boolean;
  subAgentRunning?: boolean;
  /** 父会话 id（子代理会话才有；普通会话为 null / 缺省） */
  parentSessionId?: string | null;
}

/** 差分基准：会话的忙闲级别 + 「忙是否仅由子代理贡献」 */
export interface SessionBusyRecord {
  level: SessionLevel;
  /**
   * 上次快照时该会话非 idle **仅因子代理在跑**（自身无 query / 等待 / 压缩 /
   * 后台任务）。这种会话随子代理完成落回 idle 属于「子对话完成」，不提醒。
   */
  subagentOnlyBusy: boolean;
}

export interface SessionEndEvents {
  /**
   * 本次推送里从 running 变为 idle 的会话（完成提醒的候选，不含子对话完成）。
   * 调用方对每个会话挂确认窗口：窗口结束时仍空闲 / 等用户（`shouldFireCompletion`）
   * 才提醒，期间又跑起来（空闲挂起项提交、排队压缩等队列续跑）则不提醒。
   */
  completedSessions: string[];
  /** 本次推送里至少一个会话从 running 变为 waiting（等待提醒，立即提醒不设窗口） */
  anyNowWaiting: boolean;
}

/**
 * 完成提醒确认窗口结束时的放行判定：会话仍空闲 / 等用户才算完成；又跑起来
 * （level === 'running'，队列续跑）或已从快照消失（undefined，会话被关闭）都不提醒。
 */
export function shouldFireCompletion(level: SessionLevel | undefined): boolean {
  return level === 'idle' || level === 'waiting';
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
  prev: ReadonlyMap<string, SessionBusyRecord>,
  states: ReadonlyArray<SessionRuntimeSummary>,
): { next: Map<string, SessionBusyRecord> } & SessionEndEvents {
  const next = new Map<string, SessionBusyRecord>();
  const completedSessions: string[] = [];
  let anyNowWaiting = false;

  for (const item of states) {
    const level = sessionBusyLevel({ idle: item.idle ?? true, waiting: item.waiting ?? false });
    const before = prev.get(item.sessionId);
    const isSubagent = !!item.parentSessionId;
    if (before && before.level === 'running' && level === 'idle' && !isSubagent && !before.subagentOnlyBusy) {
      completedSessions.push(item.sessionId);
    }
    // 转等待用户不受「子对话」抑制：子代理ask user / 权限确认同样要提醒
    if (before && before.level === 'running' && level === 'waiting') {
      anyNowWaiting = true;
    }
    next.set(item.sessionId, {
      level,
      subagentOnlyBusy:
        !!item.subAgentRunning
        && !item.queryRunning
        && !item.compacting
        && !item.backgroundRunning
        && !item.waiting,
    });
  }

  return { next, completedSessions, anyNowWaiting };
}

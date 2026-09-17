/**
 * sessionRuntime - 会话运行时状态（running / waiting）的唯一 owner
 *
 * 变化时推全量 `CoreEvent.sessionRuntimeChanged`（消费者不维护状态表，见第 3.1 节）：
 * - running（对外）＝ 下面任一来源为真，即「会话非空闲」
 * - waiting：正在等待用户操作（ask user / 权限确认，pending user choice）
 *
 * 内部按来源分开记账，对外合并成 running。分开的理由：多个来源会重叠
 * （自动压缩发生在一轮查询中间、后台 Bash 常在一轮查询结束后继续跑），
 * 若共用一个布尔位，任一来源结束就会把其他来源的 running 一起清掉。
 *
 * | 来源 | 事实 | 设置方 |
 * | --- | --- | --- |
 * | query | 引擎在消费消息 / 有活跃查询 | Integration、QueryEngine |
 * | compacting | 正在压缩上下文（会整体替换消息数组） | compact/compact.ts |
 * | background | 有运行中的后台 Bash 任务 | tools/bash/LocalShellTask |
 * | subagent | 有运行中的子代理会话（spin 模式下父会话不消费队列） | tools/agent/SubAgentRegistry |
 *
 * 与 SessionUiState（host 侧渲染投影）的分工（第 4.5 节）：
 * - core 的 sessionRuntime 是唯一事实 owner；SessionRuntimeState 进 CoreEvent
 * - SessionUiState 只留渲染投影（getActivityPhase），禁止互相写值
 *
 * 各 core 模块在自己的事实变化点调用 mark* 函数（幂等，内部 diff 后才发事件）；
 * `dropSessionRuntime` 在会话关闭 / 删除时清理。
 */

import type { SessionRuntimeState } from './AssistantEventBus.js';
import { requireEventBus } from './AssistantEventBus.js';
import { logger } from './Logger.js';

/** sessionId -> 运行时状态（内部事实表，按来源分列） */
interface Entry {
  /** 查询 / 引擎消费中 */
  query: boolean;
  /** 等待用户操作（ask user / 权限确认） */
  waiting: boolean;
  /** 正在压缩上下文 */
  compacting: boolean;
  /** 有运行中的后台 Bash 任务 */
  background: boolean;
  /** 有运行中的子代理会话 */
  subagent: boolean;
}

const states = new Map<string, Entry>();

/** 新建一条空白事实 */
function emptyEntry(): Entry {
  return { query: false, waiting: false, compacting: false, background: false, subagent: false };
}

/** 对外快照：各来源合并成 running（消费者只关心「忙不忙」） */
function toSnapshot(entry: Entry): { running: boolean; waiting: boolean } {
  return {
    running: entry.query || entry.compacting || entry.background || entry.subagent,
    waiting: entry.waiting,
  };
}

/** 「会话是否正在等待用户」的 provider（与 sessionResources 同一注入模式） */
let waitingProvider: ((sessionId: string) => boolean) | null = null;

/** 注册「会话是否正在等待用户输入」判定（bootstrap 注入） */
export function setSessionRuntimeWaitingProvider(
  fn: ((sessionId: string) => boolean) | null,
): void {
  waitingProvider = fn;
}

/** 两个事实条目是否完全一致（diff 用） */
function sameEntry(a: Entry, b: Entry): boolean {
  return (
    a.query === b.query &&
    a.waiting === b.waiting &&
    a.compacting === b.compacting &&
    a.background === b.background &&
    a.subagent === b.subagent
  );
}

/** 推全量事件（内部 diff，无变化不发） */
function pushIfChanged(next: Map<string, Entry>): void {
  let changed = next.size !== states.size;
  if (!changed) {
    for (const [key, entry] of next) {
      const prev = states.get(key);
      if (!prev || !sameEntry(prev, entry)) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) return;

  states.clear();
  for (const [key, entry] of next) {
    states.set(key, { ...entry });
  }

  const snapshot: SessionRuntimeState[] = [...states.entries()].map(([sessionId, entry]) => ({
    sessionId,
    ...toSnapshot(entry),
  }));
  try {
    requireEventBus().emitToUi({ type: 'sessionRuntimeChanged', states: snapshot });
  } catch (err) {
    logger.warn('sessionRuntime', `emit sessionRuntimeChanged failed: ${err}`);
  }
}

/** 更新某个会话的某个来源（克隆 → 改 → diff 后推全量） */
function update(sessionId: string, mutate: (entry: Entry) => void): void {
  if (!sessionId) return;
  const next = new Map<string, Entry>();
  for (const [key, entry] of states) {
    next.set(key, { ...entry });
  }
  const current = next.get(sessionId) ?? emptyEntry();
  mutate(current);
  next.set(sessionId, current);
  pushIfChanged(next);
}

/**
 * 查询开始 / 结束（queryBegin / queryEnd）时更新 running。
 * waiting 的值保持当前 provider 判定结果。
 */
export function markQueryRunning(sessionId: string, running: boolean): void {
  update(sessionId, (entry) => {
    entry.query = running;
    entry.waiting = waitingProvider ? !!waitingProvider(sessionId) : entry.waiting;
  });
}

/**
 * 压缩上下文开始 / 结束时更新 compacting（`compact/compact.ts` 调用）。
 * 与 query 分开记账：自动压缩发生在一轮查询中间，压缩结束时不能把该轮查询的
 * running 一起清掉。
 */
export function markSessionCompacting(sessionId: string, compacting: boolean): void {
  update(sessionId, (entry) => { entry.compacting = compacting; });
}

/** 后台 Bash 任务开始 / 结束时更新 background（`tools/bash/LocalShellTask` 调用） */
export function markSessionBackground(sessionId: string, background: boolean): void {
  update(sessionId, (entry) => { entry.background = background; });
}

/** 子代理会话开始 / 结束时更新 subagent（`tools/agent/SubAgentRegistry` 调用） */
export function markSessionSubAgent(sessionId: string, subagent: boolean): void {
  update(sessionId, (entry) => { entry.subagent = subagent; });
}

/** 进出 userChoice / 权限确认时更新 waiting */
export function markSessionWaiting(sessionId: string, waiting: boolean): void {
  update(sessionId, (entry) => { entry.waiting = waiting; });
}

/** 会话关闭 / 删除：移除该会话的运行时状态 */
export function dropSessionRuntime(sessionId: string): void {
  if (!sessionId || !states.has(sessionId)) return;
  const next = new Map<string, Entry>();
  for (const [key, entry] of states) {
    if (key !== sessionId) next.set(key, { ...entry });
  }
  pushIfChanged(next);
}

/** 读全量（MCPHost / 空闲回收 / 测试用） */
export function getSessionRuntimeStates(): readonly SessionRuntimeState[] {
  return [...states.entries()].map(([sessionId, entry]) => ({
    sessionId,
    ...toSnapshot(entry),
  }));
}

/** 清空全部状态（工作区切换 / 测试用） */
export function resetSessionRuntime(): void {
  if (states.size === 0) return;
  states.clear();
  try {
    requireEventBus().emitToUi({ type: 'sessionRuntimeChanged', states: [] });
  } catch {
    // 总线未注册时静默（启动窗口）
  }
}

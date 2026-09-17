/**
 * sessionRuntime - 会话运行时状态（running / waiting）的唯一 owner
 *
 * 变化时推全量 `CoreEvent.sessionRuntimeChanged`（消费者不维护状态表，见第 3.1 节）：
 * - running：引擎在消费消息（isConsumerRunning）或会话有活跃查询
 * - waiting：正在等待用户操作（ask user / 权限确认，pending user choice）
 *
 * 与 SessionUiState（host 侧渲染投影）的分工（第 4.5 节）：
 * - core 的 sessionRuntime 是唯一事实 owner；SessionRuntimeState 进 CoreEvent
 * - SessionUiState 保留为渲染投影（getActivityPhase / abort 判定），禁止互相写值
 *
 * 数据源：
 * - 引擎状态：QueryEngine.sessionEngines 的 isConsumerRunning（引擎消费开始/结束时变化）
 * - pending user choice：UserChoiceQueue 的 per-session pending（provider 模式拉取）
 *
 * 各 core 模块在自己的事实变化点调用 mark* 函数（幂等，内部 diff 后才发事件）；
 * `dropSessionRuntime` 在会话关闭 / 删除时清理。
 */

import type { SessionRuntimeState } from './AssistantEventBus.js';
import { requireEventBus } from './AssistantEventBus.js';
import { logger } from './Logger.js';

/** sessionId -> 运行时状态（内部事实表） */
interface Entry {
  running: boolean;
  waiting: boolean;
}

const states = new Map<string, Entry>();

/** 「会话是否正在等待用户」的 provider（与 sessionIdle 同一注入模式） */
let waitingProvider: ((sessionId: string) => boolean) | null = null;

/** 注册「会话是否正在等待用户输入」判定（bootstrap 注入） */
export function setSessionRuntimeWaitingProvider(
  fn: ((sessionId: string) => boolean) | null,
): void {
  waitingProvider = fn;
}

/** 推全量事件（内部 diff，无变化不发） */
function pushIfChanged(next: Map<string, Entry>): void {
  let changed = next.size !== states.size;
  if (!changed) {
    for (const [key, entry] of next) {
      const prev = states.get(key);
      if (!prev || prev.running !== entry.running || prev.waiting !== entry.waiting) {
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
    running: entry.running,
    waiting: entry.waiting,
  }));
  try {
    requireEventBus().emitToUi({ type: 'sessionRuntimeChanged', states: snapshot });
  } catch (err) {
    logger.warn('sessionRuntime', `emit sessionRuntimeChanged failed: ${err}`);
  }
}

/**
 * 查询开始 / 结束（queryBegin / queryEnd）时更新 running。
 * waiting 的值保持当前 provider 判定结果。
 */
export function markQueryRunning(sessionId: string, running: boolean): void {
  if (!sessionId) return;
  const next = new Map<string, Entry>();
  for (const [key, entry] of states) {
    next.set(key, { ...entry });
  }
  const current = next.get(sessionId) ?? { running: false, waiting: false };
  current.running = running;
  current.waiting = waitingProvider ? !!waitingProvider(sessionId) : current.waiting;
  next.set(sessionId, current);
  pushIfChanged(next);
}

/** 引擎消费开始 / 结束（后台任务、递归子代理）时更新 running */
export function markEngineRunning(sessionId: string, running: boolean): void {
  markQueryRunning(sessionId, running);
}

/** 进出 userChoice / 权限确认时更新 waiting */
export function markSessionWaiting(sessionId: string, waiting: boolean): void {
  if (!sessionId) return;
  const next = new Map<string, Entry>();
  for (const [key, entry] of states) {
    next.set(key, { ...entry });
  }
  const current = next.get(sessionId) ?? { running: false, waiting: false };
  current.waiting = waiting;
  next.set(sessionId, current);
  pushIfChanged(next);
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
    running: entry.running,
    waiting: entry.waiting,
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

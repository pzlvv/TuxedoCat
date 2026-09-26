/**
 * sessionRuntime - 会话运行时状态（idle / waiting）的唯一 owner
 *
 * 变化时推全量 `CoreEvent.sessionRuntimeChanged`（消费者不维护状态表，见第 3.1 节）：
 * - idle（对外）＝ 下面所有来源都为假，即「会话空闲」
 * - waiting：正在等待用户操作（ask user / 权限确认，pending user choice）
 *
 * 对外只暴露 `idle`（= !非空闲），流水灯与 abort 按钮都读它。内部按来源分开记账：
 * 多个来源会重叠（自动压缩发生在一轮查询中间、后台 Bash 常在一轮查询结束后继续跑），
 * 若共用一个布尔位，任一来源结束就会把其他来源的状态一起清掉。
 *
 * | 来源 | 事实 | 设置方 |
 * | --- | --- | --- |
 * | query | 引擎在消费消息 / 有活跃查询 | Integration、QueryEngine |
 * | compacting | 正在压缩上下文（会整体替换消息数组） | compact/compact.ts |
 * | background | 有运行中的后台 Bash 任务 | tools/bash/LocalShellTask |
 * | subagent | 已注册子代理（仅作变更信号；idle 递归看子代理是否非 idle） | tools/agent/SubAgentRegistry |
 * | waiting | 正在等待用户操作（ask user / 权限确认） | Integration（入队）、`UiEvent.userChoicePendingChanged`（弹出 / 应答） |
 *
 * 与 sessionResources.isSessionIdle 的关系：后者是宿主侧（空闲回收 / 手动压缩是否延后）
 * 的**异步只读**判定，覆盖同样的来源 + 子代理递归；本模块是跨层推送的**同步快照**。
 * 两者都读同一批事实，禁止互相写值。
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
  /**
   * 该会话是否已注册子代理（仅作「父会话需要重算 idle」的变更信号）。
   * idle 不看这个标志——它递归看子代理**当前是否非 idle**，见 isIdleInSnapshot。
   */
  subagent: boolean;
}

const states = new Map<string, Entry>();

/** 新建一条空白事实 */
function emptyEntry(): Entry {
  return { query: false, waiting: false, compacting: false, background: false, subagent: false };
}

/**
 * 惰性取「某会话的子代理 id 列表」。
 * 用 require 而不是顶层 import：SubAgentRegistry 反向 import 本模块的 markSessionSubAgent，
 * 顶层互相 import 会形成初始化环；快照阶段（事件推送时）再惰性加载是安全的。
 */
function listSubAgentIds(creatorSessionId: string): string[] {
  try {
    const { subAgentRegistry } = require('./tools/agent/SubAgentRegistry.js') as typeof import('./tools/agent/SubAgentRegistry.js');
    return subAgentRegistry.listForCreator(creatorSessionId);
  } catch {
    // 注册表不可用（测试 / 启动窗口）时按「无子代理」处理
    return [];
  }
}

/**
 * 递归判定会话是否空闲（快照用，同步）：
 * 自身无 query / waiting / compacting / background，且所有已注册子代理都 idle。
 * 子代理非 idle 同样递归判定（子代理自己也可能有后台 Bash / 更下层子代理）。
 *
 * 用「子代理当前是否非 idle」而不是「是否有已注册子代理」：子代理完成一轮后
 * 可能仍留在注册表里等 Reply，此时父会话应当回到 idle。
 */
function isIdleInSnapshot(sessionId: string, visiting: Set<string>): boolean {
  if (visiting.has(sessionId)) return true; // 环保护
  visiting.add(sessionId);

  const entry = states.get(sessionId);
  if (entry && (entry.query || entry.waiting || entry.compacting || entry.background)) return false;

  for (const childId of listSubAgentIds(sessionId)) {
    if (!isIdleInSnapshot(childId, visiting)) return false;
  }
  return true;
}

/** 对外快照：自身事实 + 递归子代理合并成 idle（消费者只关心「闲不闲」） */
function toSnapshot(sessionId: string, entry: Entry): { idle: boolean; waiting: boolean } {
  return {
    idle: isIdleInSnapshot(sessionId, new Set<string>()),
    waiting: entry.waiting,
  };
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
    ...toSnapshot(sessionId, entry),
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
 * 查询开始 / 结束（queryBegin / queryEnd）时更新 query 来源。
 * waiting 是独立来源，不随查询开始 / 结束变化。
 */
export function markQueryRunning(sessionId: string, running: boolean): void {
  update(sessionId, (entry) => { entry.query = running; });
}

/**
 * 压缩上下文开始 / 结束时更新 compacting（`compact/compact.ts` 调用）。
 * 与 query 分开记账：自动压缩发生在一轮查询中间，压缩结束时不能把该轮查询的
 * query 来源一起清掉。
 */
export function markSessionCompacting(sessionId: string, compacting: boolean): void {
  update(sessionId, (entry) => { entry.compacting = compacting; });
}

/** 后台 Bash 任务开始 / 结束时更新 background（`tools/bash/LocalShellTask` 调用） */
export function markSessionBackground(sessionId: string, background: boolean): void {
  update(sessionId, (entry) => { entry.background = background; });
}

/**
 * 子代理注册 / 注销时更新 subagent 变更信号（`tools/agent/SubAgentRegistry` 调用）。
 * 该标志不参与 idle 计算（idle 递归看子代理当前是否非 idle，见 isIdleInSnapshot），
 * 只用于触发父会话快照重算并推送。
 */
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

/**
 * 单个会话是否正在等待用户（ask user / 权限确认）。
 *
 * 供 `sessionResources.isSessionIdle` 读取——「等待用户」是 core 自己的事实，
 * 不由宿主注入判定闭包（第 8.7 节）。
 */
export function isSessionWaiting(sessionId: string): boolean {
  return !!states.get(sessionId)?.waiting;
}

/** 读全量（MCPHost / 空闲回收 / 测试用） */
export function getSessionRuntimeStates(): readonly SessionRuntimeState[] {
  return [...states.entries()].map(([sessionId, entry]) => ({
    sessionId,
    ...toSnapshot(sessionId, entry),
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

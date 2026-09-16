/**
 * 查询活动相关 UI 逻辑的宿主共享实现。
 *
 * VSCodeUI 与 ElectronUI 原为逐字重复的三个部分收敛于此：
 * - onToolProgress（工具流式进度推送，含尾部截断）
 * - hasActiveQueryInScope / queryActiveCounts（abort 按钮可用性判定）
 * - onSetAgentMode（子代理 agent mode 继承）
 *
 * 宿主差异（推送通道、日志）通过参数注入。
 */
import type { ToolProgressData } from '../core/tools/Tool.js';

/** 流式输出单次发送上限：超过则仅保留尾部（最新的输出） */
export const STREAM_CAP_CHARS = 100_000;

/** 宿主推送通道（VSCodeUI.postToWebview / ElectronUI.postToWebview） */
export type HostPush = (sessionId: string, message: Record<string, unknown>) => void;

/** 宿主日志通道（VSCodeUI.outputChannel / ElectronUI.log） */
export type HostLog = (message: string) => void;

/**
 * 工具执行进度推送（流式输出）。
 * Bash 运行期间实时推送已累积输出到 UI，实现流式显示。
 * VSCodeUI 版本推送时带 silent 标记（流式输出每 chunk 打印一次太频繁，跳过日志）；
 * Electron 版本无 silent 参数，postToWebview 本身不打日志，行为一致。
 */
export function pushToolProgress(
  sessionId: string,
  toolUseId: string,
  progress: ToolProgressData,
  push: HostPush,
): void {
  const p = progress as ToolProgressData & {
    output?: string;
    fullOutput?: string;
    elapsedTimeSeconds?: number;
    totalLines?: number;
    totalBytes?: number;
    taskId?: string;
  };

  // 流式输出可能非常大，限制单次发送大小，仅保留尾部（最新的输出）
  let streamed = p.fullOutput || p.output || '';
  if (streamed.length > STREAM_CAP_CHARS) {
    streamed = streamed.slice(-STREAM_CAP_CHARS);
  }

  push(sessionId, {
    type: 'toolProgress',
    toolCallId: toolUseId,
    output: streamed,
    isStreaming: true,
    elapsedTimeSeconds: p.elapsedTimeSeconds,
    totalLines: p.totalLines,
    totalBytes: p.totalBytes,
    taskId: p.taskId,
  });
}

/**
 * 设置子会话的 agent mode。
 * 子代理默认使用 risk 模式，仅当父会话为 auto 时继承 auto（auto > risk > manual）。
 */
export function inheritAgentMode(
  sessionAgentModes: Map<string, 'manual' | 'risk' | 'auto'>,
  parentSessionId: string,
  childSessionId: string,
): void {
  const parentMode = sessionAgentModes.get(parentSessionId);
  sessionAgentModes.set(childSessionId, parentMode === 'auto' ? 'auto' : 'risk');
}

/**
 * abort scope 活跃查询判定（纯函数）：
 * - 会话自身有计数中的查询，或
 * - 有该会话的后台 Bash 任务在运行，或
 * - 其递归子代理中有活跃查询
 *
 * @param sessionId 目标会话
 * @param queryActiveCounts 宿主维护的查询计数表
 * @param getBackgroundTasks 后台 Bash 任务查询（不可用时为 undefined）
 * @param listChildSessions 按给定会话查询其子代理会话 ID 列表（不可用时为 undefined）。
 *   注意必须是「按入参 sessionId 查询」的函数，而不是绑定某个固定会话的闭包：
 *   递归时要按当前子会话继续向下查，否则会退化成无限递归（栈溢出）。
 */
export function isActiveQueryInScope(
  sessionId: string,
  queryActiveCounts: ReadonlyMap<string, number>,
  getBackgroundTasks: (() => Array<{ status: string; sessionID?: string }>) | undefined,
  listChildSessions: ((sessionId: string) => string[]) | undefined,
): boolean {
  if ((queryActiveCounts.get(sessionId) ?? 0) > 0) {
    return true;
  }
  // 后台 Bash 任务可能在前台查询结束后继续运行，此时 abort 按钮仍应可用，
  // 以便用户中止该会话（及其子会话）的后台任务。
  if (getBackgroundTasks?.().some(task => task.status === 'running' && task.sessionID === sessionId)) {
    return true;
  }
  // 递归下降：每一层都按「当前会话」查询其子会话（含子代理的子代理）
  for (const childId of listChildSessions?.(sessionId) ?? []) {
    if (isActiveQueryInScope(childId, queryActiveCounts, getBackgroundTasks, listChildSessions)) {
      return true;
    }
  }
  return false;
}

/**
 * 宿主可直接调用的活跃查询判定：内部解析后台 Bash 任务 / 子代理注册表依赖。
 *
 * 依赖模块「不存在」时按无该依赖处理（这是唯一允许的降级：模块本身可选）；
 * 依赖存在但调用抛错则向上抛出，避免把架构/数据问题伪装成「无活跃查询」。
 * 供 SessionUiState 统一使用，VSCodeUI / ElectronUI 不再各自复制这段 try/catch。
 */
export function resolveActiveQueryInScope(
  sessionId: string,
  queryActiveCounts: ReadonlyMap<string, number>,
): boolean {
  let getBackgroundTasks: (() => Array<{ status: string; sessionID?: string }>) | undefined;
  try {
    const { getAllBackgroundTasks } = require('../core/tools/bash/LocalShellTask.js') as typeof import('../core/tools/bash/LocalShellTask.js');
    getBackgroundTasks = getAllBackgroundTasks;
  } catch {
    getBackgroundTasks = undefined;
  }

  let listChildSessions: ((sessionId: string) => string[]) | undefined;
  try {
    const { subAgentRegistry } = require('../core/tools/agent/SubAgentRegistry.js') as typeof import('../core/tools/agent/SubAgentRegistry.js');
    listChildSessions = (id: string) => subAgentRegistry.listForCreator(id);
  } catch {
    listChildSessions = undefined;
  }

  return isActiveQueryInScope(sessionId, queryActiveCounts, getBackgroundTasks, listChildSessions);
}

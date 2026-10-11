/**
 * LocalShellTask - 后台 shell 任务生命周期管理
 *
 * 负责将已在运行的 shell 命令注册为后台任务，并在任务完成时
 * 通过 agentMessageQueue 向 LLM 发送通知；同时为每个任务挂上
 * 周期性提醒时钟（`BackgroundReminder`，规格见 `docs/features/background-bash.md`）。
 *
 * 参考 claude-code-main 的 LocalShellTask 设计
 */

import type { ShellCommand } from './ShellCommand.js';
import { logger } from '../../Logger.js';
import { markSessionBackground } from '../../sessionRuntime.js';
import {
  formatDuration,
  registerBackgroundReminder,
  unregisterBackgroundReminder,
  unregisterSessionBackgroundReminders,
} from './BackgroundReminder.js';

/**
 * 后台任务增减后同步 sessionRuntime 的 background 事实。
 * 一个会话可能有多个后台任务，只有全部结束时才算「没有后台工作」。
 */
function syncBackgroundState(sessionID: string | undefined): void {
  if (!sessionID) return;
  markSessionBackground(sessionID, getRunningBackgroundTasksForSession(sessionID).length > 0);
}

export interface LocalShellTaskState {
  taskId: string;
  type: 'local_bash';
  description: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  command: string;
  isBackgrounded: boolean;
  startTime: number;
  endTime?: number;
  exitCode?: number;
  /** 子进程 pid（供展示 / 让 LLM 自行 kill；进程结束后可能已被系统复用） */
  pid?: number;
  shellCommand: ShellCommand | null;
  toolUseId?: string;
  agentId?: string;
  sessionID?: string;
}

/** 后台任务完成事件信息（在发送通知时触发） */
export interface BackgroundTaskCompletedInfo {
  taskId: string;
  description: string;
  status: 'completed' | 'failed';
  sessionID?: string;
  agentId?: string;
}

export type BackgroundTaskCompletedListener = (info: BackgroundTaskCompletedInfo) => void;

/** 后台任务完成事件监听器集合 */
const backgroundTaskCompletedListeners = new Set<BackgroundTaskCompletedListener>();

/**
 * 订阅后台任务完成事件（后台任务完成并发送通知时触发）
 * @returns 取消订阅函数
 */
export function onBackgroundTaskCompleted(listener: BackgroundTaskCompletedListener): () => void {
  backgroundTaskCompletedListeners.add(listener);
  return () => {
    backgroundTaskCompletedListeners.delete(listener);
  };
}

function emitBackgroundTaskCompleted(info: BackgroundTaskCompletedInfo): void {
  for (const listener of backgroundTaskCompletedListeners) {
    try {
      listener(info);
    } catch (err) {
      logger.error('LocalShellTask', `Background task completed listener error: ${err}`);
    }
  }
}

/**
 * 后台任务注册表
 * 存储所有活跃的后台任务
 */
const backgroundTasks = new Map<string, LocalShellTaskState>();

/**
 * 生成任务 ID
 */
export function generateTaskId(): string {
  return `bg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 注册后台 shell 任务
 * 将已在运行的 ShellCommand 转为后台任务，通过 agentMessageQueue 通知引擎
 *
 * @returns taskId
 */
export function registerBackgroundTask(
  shellCommand: ShellCommand,
  description: string,
  command: string,
  toolUseId?: string,
  agentId?: string,
  sessionID?: string,
): string {
  const taskId = shellCommand.taskOutput.taskId;

  const taskState: LocalShellTaskState = {
    taskId,
    type: 'local_bash',
    description,
    status: 'running',
    command,
    isBackgrounded: true,
    startTime: Date.now(),
    pid: shellCommand.pid,
    shellCommand,
    toolUseId,
    agentId,
    sessionID,
  };

  backgroundTasks.set(taskId, taskState);
  logger.info('LocalShellTask', `Registered background task ${taskId}: "${description}" (sessionID=${sessionID ?? 'unknown'})`);

  // 将进程转为后台
  shellCommand.background(taskId);
  syncBackgroundState(sessionID);
  startTaskReminder(taskState, shellCommand.pid);

  // 监听结果
  void shellCommand.result.then(result => {
    const task = backgroundTasks.get(taskId);
    if (!task) return;

    unregisterBackgroundReminder(taskId);
    const finalStatus = result.code === 0 ? 'completed' : 'failed';
    task.status = finalStatus;
    task.endTime = Date.now();
    task.exitCode = result.code;
    task.shellCommand = null;

    logger.info('LocalShellTask', `Background task ${taskId} ${finalStatus} (exit ${result.code})`);

    // 构建通知消息
    const duration = task.endTime - task.startTime;
    const durationStr = formatDuration(duration);

    let summary: string;
    switch (finalStatus) {
      case 'completed':
        summary = `Background command "${description}" completed (exit code ${result.code})`;
        break;
      case 'failed':
        summary = `Background command "${description}" failed with exit code ${result.code}`;
        break;
      default:
        summary = `Background command "${description}" was stopped`;
    }

    const notification = buildCompletionNotification(taskId, summary, durationStr, result.stdout);

    // 触发后台任务完成事件（供 Exec 前台命令观察，决定是否自动转入后台）
    emitBackgroundTaskCompleted({
      taskId,
      description,
      status: finalStatus,
      sessionID,
      agentId,
    });

    // 先唤醒引擎再清 background（与 core-rs `handle_finish` 的顺序对齐，parity）：
    // notifyEngine 置 running（idle=false 运行时快照，``docs/core/session-runtime.md`）之后，
    // syncBackgroundState 清 background 时 running 仍真——两份快照的 idle 恒为
    // false，完成通知触发的接续查询之前不会先推一份「瞬时 idle」被宿主差分成
    // running → idle 而误武装「任务完成」绿灯。引擎不接续（找不到引擎等）时
    // running 不置位，清 background 推出的 idle 才是真实完成，照常武装。
    notifyEngine(notification, sessionID, agentId);
    syncBackgroundState(sessionID);
  });

  return taskId;
}

/**
 * 将前台任务转为后台
 * 用于已注册为前台任务的情况（如运行一段时间后自动 background）
 */
export function backgroundExistingTask(
  taskId: string,
  shellCommand: ShellCommand,
  description: string,
  command: string,
  toolUseId?: string,
  agentId?: string,
  sessionID?: string,
): boolean {
  if (backgroundTasks.has(taskId)) {
    return false; // 已在后台
  }

  const taskState: LocalShellTaskState = {
    taskId,
    type: 'local_bash',
    description,
    status: 'running',
    command,
    isBackgrounded: true,
    startTime: Date.now(),
    pid: shellCommand.pid,
    shellCommand,
    toolUseId,
    agentId,
    sessionID,
  };

  backgroundTasks.set(taskId, taskState);
  logger.info('LocalShellTask', `Backgrounded existing task ${taskId}: "${description}" (sessionID=${sessionID ?? 'unknown'})`);

  // 将进程转为后台
  if (!shellCommand.background(taskId)) {
    backgroundTasks.delete(taskId);
    return false;
  }
  syncBackgroundState(sessionID);
  startTaskReminder(taskState, shellCommand.pid);

  // 监听结果
  void shellCommand.result.then(result => {
    const task = backgroundTasks.get(taskId);
    if (!task) return;

    unregisterBackgroundReminder(taskId);
    const finalStatus = result.code === 0 ? 'completed' : 'failed';
    task.status = finalStatus;
    task.endTime = Date.now();
    task.exitCode = result.code;
    task.shellCommand = null;
    syncBackgroundState(sessionID);

    const duration = task.endTime - task.startTime;
    const durationStr = formatDuration(duration);

    let summary: string;
    switch (finalStatus) {
      case 'completed':
        summary = `Background command "${description}" completed (exit code ${result.code})`;
        break;
      case 'failed':
        summary = `Background command "${description}" failed with exit code ${result.code}`;
        break;
      default:
        summary = `Background command "${description}" was stopped`;
    }

    const notification = buildCompletionNotification(taskId, summary, durationStr, result.stdout);

    // 触发后台任务完成事件（供 Exec 前台命令观察，决定是否自动转入后台）
    emitBackgroundTaskCompleted({
      taskId,
      description,
      status: finalStatus,
      sessionID,
      agentId,
    });

    notifyEngine(notification, sessionID, agentId);
  });

  return true;
}

/**
 * 后台任务完成通知（纯文本）。
 *
 * 通知会作为一条 user 消息进入 LLM 上下文并在 UI 展示；UI 侧按普通消息渲染
 * （不走 markdown），因此这里不使用 markdown 语法（加粗 / 列表 / 代码围栏）。
 */
function buildCompletionNotification(
  taskId: string,
  summary: string,
  durationStr: string,
  stdout: string,
): string {
  const lines = [
    'Background task completed',
    `Task: ${taskId}`,
    `Description: ${summary}`,
    `Duration: ${durationStr}`,
  ];
  if (stdout) {
    lines.push('Output (first 500 chars):');
    lines.push(stdout.slice(0, 500) + (stdout.length > 500 ? '\n...' : ''));
  }
  return lines.join('\n');
}

/**
 * 获取后台任务状态
 */
export function getBackgroundTaskStatus(taskId: string): LocalShellTaskState | undefined {
  return backgroundTasks.get(taskId);
}

/**
 * 获取所有后台任务
 */
export function getAllBackgroundTasks(): LocalShellTaskState[] {
  return Array.from(backgroundTasks.values());
}

/**
 * 获取指定会话所有仍在运行中的后台任务
 */
export function getRunningBackgroundTasksForSession(sessionID: string): LocalShellTaskState[] {
  return Array.from(backgroundTasks.values()).filter(
    task => task.status === 'running' && task.sessionID === sessionID,
  );
}

/**
 * 获取后台任务数量
 */
export function getBackgroundTaskCount(): number {
  return backgroundTasks.size;
}

/**
 * 中止指定会话的所有运行中后台 Bash 任务。
 *
 * 先标记并从注册表移除任务，再 kill 进程：任务 result 回调中查不到 task，
 * 会直接返回，从而丢弃被中止任务的输出与完成通知。
 *
 * @returns 被中止的任务数量
 */
export function abortBackgroundTasksForSession(sessionID: string): number {
  let count = 0;
  for (const [taskId, task] of Array.from(backgroundTasks.entries())) {
    if (task.sessionID !== sessionID || task.status !== 'running') {
      continue;
    }

    const shellCommand = task.shellCommand;
    task.status = 'killed';
    task.endTime = Date.now();
    task.shellCommand = null;
    // 先移除再 kill，确保 result.then 回调因查不到 task 而直接丢弃结果。
    backgroundTasks.delete(taskId);
    try {
      shellCommand?.kill();
    } catch {
      // 进程可能已结束
    }
    logger.info('LocalShellTask', `Aborted background task ${taskId} for session ${sessionID}`);
    count++;
  }
  if (count > 0) {
    // 被中止的任务不再提醒（先移除再 kill，result 回调查不到 task 也不会重复注销）
    unregisterSessionBackgroundReminders(sessionID);
    syncBackgroundState(sessionID);
  }
  return count;
}

/**
 * 通知指定会话的 QueryEngine
 * 通过 sessionID 直接定位到正确的引擎发送通知，避免误发到其他会话
 *
 * 来源固定为 `bash`：UI 侧按纯文本系统通知展示（不是子代理回复，不渲染 markdown）。
 */
function notifyEngine(notification: string, sessionID?: string, agentId?: string): void {
  try {
    const { sessionEngines, getSessionEngine } = require('../../QueryEngine.js');
    if (sessionID) {
      // 优先使用指定的 sessionID 定位引擎
      const engine = getSessionEngine(sessionID);
      if (engine && typeof engine.enqueueAgentMessage === 'function') {
        logger.info('LocalShellTask', `Notifying engine for sessionID=${sessionID}`);
        engine.enqueueAgentMessage(notification, agentId, 'bash');
        return;
      }
      logger.warn('LocalShellTask', `Session engine not found for sessionID=${sessionID}, falling back to first available`);
    }
    // 兜底：遍历所有引擎（兼容未传入 sessionID 的情况）
    if (sessionEngines) {
      for (const [, engine] of sessionEngines) {
        if (engine && typeof engine.enqueueAgentMessage === 'function') {
          engine.enqueueAgentMessage(notification, agentId, 'bash');
          break;
        }
      }
    }
  } catch (error) {
    logger.error('LocalShellTask', 'Failed to notify engine:', error);
  }
}

/**
 * 周期性提醒的投递：只投给该会话自己的引擎（找不到就丢弃，不误发到别的会话）。
 *
 * 与 `notifyEngine` 的区别：完成通知走 `enqueueAgentMessage`（UI 可见的纯文本
 * 系统消息）；提醒走 `deliverBackgroundReminder`（silent、UI 不可见，只喂给 LLM）。
 */
function deliverReminder(sessionID: string | undefined, content: string): void {
  if (!sessionID) return;
  try {
    const { getSessionEngine } = require('../../QueryEngine.js');
    const engine = getSessionEngine(sessionID);
    if (engine && typeof engine.deliverBackgroundReminder === 'function') {
      engine.deliverBackgroundReminder(content);
    }
  } catch (error) {
    logger.error('LocalShellTask', 'Failed to deliver background reminder:', error);
  }
}

/** 为刚登记的后台任务挂上提醒时钟（在 `syncBackgroundState` 之后调用，保证会话已登记） */
function startTaskReminder(task: LocalShellTaskState, pid: number | undefined): void {
  if (!task.sessionID) return;
  const sessionID = task.sessionID;
  registerBackgroundReminder({
    taskId: task.taskId,
    sessionID,
    description: task.description,
    command: task.command,
    startTime: task.startTime,
    pid,
    deliver: (content) => deliverReminder(sessionID, content),
  });
}

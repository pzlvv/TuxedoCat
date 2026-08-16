/**
 * LocalShellTask - 后台 shell 任务生命周期管理
 *
 * 负责将已在运行的 shell 命令注册为后台任务，并在任务完成时
 * 通过 agentMessageQueue 向 LLM 发送通知。
 *
 * 参考 claude-code-main 的 LocalShellTask 设计
 */

import type { ShellCommand } from './ShellCommand.js';
import { logger } from '../../Logger.js';

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
    shellCommand,
    toolUseId,
    agentId,
    sessionID,
  };

  backgroundTasks.set(taskId, taskState);
  logger.info('LocalShellTask', `Registered background task ${taskId}: "${description}" (sessionID=${sessionID ?? 'unknown'})`);

  // 将进程转为后台
  shellCommand.background(taskId);

  // 监听结果
  void shellCommand.result.then(result => {
    const task = backgroundTasks.get(taskId);
    if (!task) return;

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

    const notification = `**Background task completed**

- **Task**: ${taskId}
- **Description**: ${summary}
- **Duration**: ${durationStr}
${result.stdout ? `**First 500 chars of output**:\n\`\`\`\n${result.stdout.slice(0, 500)}${result.stdout.length > 500 ? '\n...' : ''}\n\`\`\`` : ''}`;

    // 触发后台任务完成事件（供 Exec 前台命令观察，决定是否自动转入后台）
    emitBackgroundTaskCompleted({
      taskId,
      description,
      status: finalStatus,
      sessionID,
      agentId,
    });

    // 通过 sessionID 通知正确的引擎
    notifyEngine(notification, sessionID, agentId);
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

  // 监听结果
  void shellCommand.result.then(result => {
    const task = backgroundTasks.get(taskId);
    if (!task) return;

    const finalStatus = result.code === 0 ? 'completed' : 'failed';
    task.status = finalStatus;
    task.endTime = Date.now();
    task.exitCode = result.code;
    task.shellCommand = null;

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

    const notification = `**Background task completed**

- **Task**: ${taskId}
- **Description**: ${summary}
- **Duration**: ${durationStr}
${result.stdout ? `**First 500 chars of output**:\n\`\`\`\n${result.stdout.slice(0, 500)}${result.stdout.length > 500 ? '\n...' : ''}\n\`\`\`` : ''}`;

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
 * 获取后台任务数量
 */
export function getBackgroundTaskCount(): number {
  return backgroundTasks.size;
}

/**
 * 通知指定会话的 QueryEngine
 * 通过 sessionID 直接定位到正确的引擎发送通知，避免误发到其他会话
 */
function notifyEngine(notification: string, sessionID?: string, agentId?: string): void {
  try {
    const { sessionEngines, getSessionEngine } = require('../../QueryEngine.js');
    if (sessionID) {
      // 优先使用指定的 sessionID 定位引擎
      const engine = getSessionEngine(sessionID);
      if (engine && typeof engine.enqueueAgentMessage === 'function') {
        logger.info('LocalShellTask', `Notifying engine for sessionID=${sessionID}`);
        engine.enqueueAgentMessage(notification, agentId);
        return;
      }
      logger.warn('LocalShellTask', `Session engine not found for sessionID=${sessionID}, falling back to first available`);
    }
    // 兜底：遍历所有引擎（兼容未传入 sessionID 的情况）
    if (sessionEngines) {
      for (const [, engine] of sessionEngines) {
        if (engine && typeof engine.enqueueAgentMessage === 'function') {
          engine.enqueueAgentMessage(notification, agentId);
          break;
        }
      }
    }
  } catch (error) {
    logger.error('LocalShellTask', 'Failed to notify engine:', error);
  }
}

/**
 * 格式化时长
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

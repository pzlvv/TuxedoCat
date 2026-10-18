/**
 * 查询活动相关 UI 逻辑的宿主共享实现。
 *
 * 收敛两个宿主逐字重复的部分：工具流式进度推送（`onToolProgress`）。
 * 宿主差异（推送通道）通过参数注入。
 */
import type { HostToWebviewMessageWithoutSessionId } from './webviewMessages.js';
import type { ToolProgressData } from '../shared/tools/Tool.js';

/** 宿主推送通道（UIHost.sendToWebview） */
/**
 * 进度推送回调：消息形状是 wire 协议的宿主→webview 方向（sessionId 由投递点补全）。
 */
export type HostPush = (sessionId: string, message: HostToWebviewMessageWithoutSessionId) => void;

/** 宿主日志通道（UIHost.log） */
export type HostLog = (message: string) => void;

/**
 * 工具执行进度推送（流式输出）。
 * Bash 运行期间实时推送已累积输出到 UI，实现流式显示。
 * VS Code 侧推送时带 silent 标记（流式输出每 chunk 打印一次太频繁，跳过日志）；
 * Electron 侧无 silent 参数，postToWebview 本身不打日志，行为一致。
 *
 * 推送内容已由工具层按统一上限（4K，前 2K + 后 2K）裁剪，宿主原样转发、不再二次截断。
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

  const streamed = p.fullOutput || p.output || '';

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



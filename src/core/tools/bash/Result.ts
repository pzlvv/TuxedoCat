/**
 * Bash 工具结果映射
 *
 * 结果格式化逻辑，由 RunTools 统一处理大结果持久化。
 * 这里只做基本的 stdout/stderr 拼接和后台任务信息展示。
 */

import type { BashToolOutput } from './Types.js';
import { getTaskOutputPath } from './TaskOutput.js';
import { BACKGROUND_REMINDER_FIRST_LABEL } from './BackgroundReminder.js';

/**
 * 将工具结果映射为工具结果块参数
 */
export function mapToolResultToToolResultBlockParam(
  content: unknown,
  toolUseID: string,
): {
  tool_use_id: string;
  type: 'tool_result';
  content: string | unknown[];
  exit_code?: number;
  is_canceled?: boolean;
} {
  const result = content as BashToolOutput;
  const { stdout, stderr, exitCode, interrupted, backgroundTaskId, backgroundElapsedMs, assistantAutoBackgrounded } = result;

  // 后台命令：通知模型命令已在后台运行
  if (backgroundTaskId) {
    const outputPath = getTaskOutputPath(backgroundTaskId);
    let backgroundInfo: string;
    if (assistantAutoBackgrounded) {
      // 自动转后台的说明只在这里拼一次：`Exec.ts` 只回传命令自身的 stderr 与
      // `find` 提示，避免 taskId / 完成通知在同一个 tool_result 里重复两遍。
      const elapsedNote = backgroundElapsedMs === undefined ? '' : ` after ${backgroundElapsedMs}ms`;
      backgroundInfo = `Command moved to the background${elapsedNote} (task ID: ${backgroundTaskId}). Output is being written to: ${outputPath}. Do not poll for the result — you will be notified when it completes. If it is still running, you will get a progress reminder in ${BACKGROUND_REMINDER_FIRST_LABEL}. Continue with other tasks in the meantime; if there is nothing else to do, end this turn.`;
      // 命令自身的 stderr 与 `find` 提示附在说明之后
      if (stderr) {
        backgroundInfo += '\n' + stderr;
      }
    } else {
      backgroundInfo = `Command running in background with ID: ${backgroundTaskId}. Output is being written to: ${outputPath}. You will be notified automatically when it completes. If it is still running, you will get a progress reminder in ${BACKGROUND_REMINDER_FIRST_LABEL}. Continue with other tasks in the meantime.`;
    }

    // 保留已累积的 stdout：命令转入后台前，前端 Bash 卡片已经在流式阶段展示过
    // 这些输出（最高约 115px）。如果这里只返回简短的后台提示，卡片内容会从
    // 流式高度突变为几行文本，出现"变矮"。把 stdout 放在提示之前拼接，
    // 保证结果内容（以及卡片高度）只增不减。
    const partialOutput = (stdout || '').trimEnd();
    const content = partialOutput
      ? `${partialOutput}\n${backgroundInfo}`
      : backgroundInfo;

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      exit_code: 0,
      is_canceled: false,
    };
  }

  // 拼接 stdout 和 stderr
  let output = stdout || '';

  if (stderr) {
    output += (output ? '\n' : '') + stderr;
  }

  // 附加退出码信息
  if (exitCode !== 0 && !interrupted) {
    output += `\nExit code: ${exitCode}`;
  }

  return {
    tool_use_id: toolUseID,
    type: 'tool_result',
    content: output.trim() || '(无输出)',
    exit_code: exitCode,
    is_canceled: false,
  };
}

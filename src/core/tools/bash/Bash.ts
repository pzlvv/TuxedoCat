/**
 * BashTool - 完整实现的 Bash 工具
 * 支持流式输出、中断、超时控制
 */

import type { BashProgress, ToolUseContext } from '../Tool.js';
import { buildTool } from '../Tool.js';
import { bashInputSchema, bashOutputSchema, type BashToolInput, type BashToolOutput } from './Types.js';
import { execCommand } from './Exec.js';
import {
  getDescription,
  getPrompt,
  getUserFacingName,
  getToolUseSummary,
  getActivityDescription,
} from './Prompt.js';
import {
  isReadOnly,
  isDestructive,
  isConcurrencySafe,
  validateInput,
} from './Validation.js';
import { mapToolResultToToolResultBlockParam } from './Result.js';
import { containsSleepCommand } from './SleepDetect.js';
import { splitBySeparators, DEFAULT_BASH_TIMEOUT_MS, SLEEP_NO_TIMEOUT_MS } from './TimeoutPolicy.js';

/**
 * Bash 工具实现
 */
export const BashTool = buildTool({
  name: 'Bash',
  aliases: ['bash', 'sh', 'shell'],
  maxResultSizeChars: 10_000, // 10KB - 超过此大小由 RunTools 持久化到磁盘

  // ========== Schema ==========
  inputSchema: bashInputSchema,
  outputSchema: bashOutputSchema,

  // ========== Description & Prompt ==========
  async description(input: BashToolInput) {
    return getDescription(input);
  },

  async prompt() {
    return getPrompt();
  },

  // ========== Permission & Validation ==========
  isReadOnly(input: BashToolInput) {
    return isReadOnly(input);
  },

  isDestructive(input: BashToolInput) {
    return isDestructive(input);
  },

  isConcurrencySafe(input: BashToolInput): boolean {
    return isConcurrencySafe(input);
  },

  async validateInput(input: BashToolInput) {
    return validateInput(input);
  },

  async checkPermissions(input: BashToolInput) {
    // 验证输入基本有效性
    if (!input || !input.command || typeof input.command !== 'string') {
      return {
        behavior: 'deny',
        message: 'Invalid command: command is required and must be a string',
      };
    }

    // 破坏性操作 - 需要用户明确确认
    if (isDestructive(input)) {
      return {
        behavior: 'ask',
        message: `⚠️ 请求执行：${input.command}`,
        choices: [
          { label: '允许执行', description: '我知道这个命令的风险，继续执行' },
          { label: '拒绝', description: '取消此操作' },
        ],
      };
    }

    // 写入操作（非只读）- 需要用户确认
    if (!isReadOnly(input)) {
      return {
        behavior: 'ask',
        message: `请求执行：${input.command}`,
        choices: [
          { label: '允许', description: '执行此命令' },
          { label: '拒绝', description: '取消此操作' },
        ],
      };
    }

    // 只读操作 - 直接允许
    return {
      behavior: 'allow',
      updatedInput: input,
    };
  },

  // ========== User Facing ==========
  userFacingName(input?: BashToolInput) {
    return getUserFacingName(input);
  },

  getToolUseSummary(input: BashToolInput) {
    return getToolUseSummary(input);
  },

  getActivityDescription(input?: BashToolInput): string | null {
    return getActivityDescription(input);
  },

  // ========== Core Execution ==========
  async call(input: BashToolInput, context: ToolUseContext, _parentMessage, onProgress) {
    const { command, run_in_background } = input;
    const { abortController } = context;

    // 使用会话工作目录作为默认 cwd
    const cwd = input.cwd || context.cwd;

    // 超时策略：
    // - 命令包含 sleep 子命令（按 ; && || | 拆分后任一子命令为 sleep）：不设超时，
    //   让 sleep 自然完成；Exec 层会监听后台任务完成/子代理 Reply 通知，
    //   收到通知时立刻将 sleep 转入后台
    // - 其他命令：默认 60s 前台超时，超时自动转入后台继续执行
    const isSleep = containsSleepCommand(splitBySeparators(command));
    const timeout = isSleep ? SLEEP_NO_TIMEOUT_MS : DEFAULT_BASH_TIMEOUT_MS;

    // 检查是否已 abort
    const signal = abortController?.signal as AbortSignal | null | undefined;
    if (signal?.aborted) {
      return {
        data: {
          stdout: '',
          stderr: '',
          exitCode: 130,
          interrupted: true,
        } as BashToolOutput,
      };
    }

    try {
      // 执行命令
      const result = await execCommand({
        command,
        timeout,
        cwd,
        signal: abortController.signal as AbortSignal,
        onProgress: (progress) => {
          // 报告进度
          onProgress?.({
            toolUseID: context.toolUseId || `bash-${Date.now()}`,
            data: {
              type: 'bash_progress',
              ...progress,
              taskId: undefined,
              timeoutMs: timeout,
            } satisfies BashProgress,
          });
        },
        runInBackground: run_in_background,
        description: input.description || command,
        toolUseId: context.toolUseId,
        agentId: context.role,
        sessionID: context.sessionId,
      });

      return {
        data: result,
      };
    } catch (error) {
      const signal = abortController?.signal as AbortSignal | null | undefined;
      const isAborted = signal?.aborted ?? false;
      return {
        data: {
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: isAborted ? 130 : 1,
          interrupted: isAborted,
        } as BashToolOutput,
      };
    }
  },

  // ========== Result Mapping ==========
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return mapToolResultToToolResultBlockParam(content, toolUseID);
  },
});

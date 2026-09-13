/**
 * Bash 工具类型定义
 */

import { z } from 'zod';

/**
 * Bash 工具输入 schema
 */
export const bashInputSchema = z.strictObject({
  command: z.string().describe('要执行的 shell 命令'),
  description: z
    .string()
    .optional()
    .describe(`Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`),
  cwd: z
    .string()
    .optional()
    .describe('工作目录，默认为当前目录'),
  run_in_background: z
    .coerce
    .boolean()
    .optional()
    .describe('设置 true 则在后台运行此命令（不会阻塞后续操作）。后台命令完成后会收到通知，无需主动轮询。'),
});

export type BashToolInput = z.infer<typeof bashInputSchema>;

/**
 * Bash 工具输出 schema
 */
export const bashOutputSchema = z.object({
  stdout: z.string().describe('标准输出'),
  stderr: z.string().describe('标准错误输出'),
  exitCode: z.number().describe('退出码'),
  interrupted: z.boolean().describe('是否被中断'),
  outputFilePath: z
    .string()
    .optional()
    .describe(
      '临时输出文件路径（当输出超过限制时保存完整输出的临时文件）',
    ),
  persistedOutputPath: z
    .string()
    .optional()
    .describe(
      '持久化输出文件路径（当输出超过预览大小时设置，完整输出保存到此文件）',
    ),
  persistedOutputSize: z
    .number()
    .optional()
    .describe('完整输出总大小（字节）'),
  backgroundTaskId: z
    .string()
    .optional()
    .describe('后台任务 ID（命令在后台运行时设置）'),
  assistantAutoBackgrounded: z
    .boolean()
    .optional()
    .describe('是否由助手模式自动转为后台运行'),
});

export type BashToolOutput = z.infer<typeof bashOutputSchema>;

/**
 * 预览大小阈值
 * 当输出超过此大小时，stdout 只包含预览，完整内容持久化到文件
 */
export const PREVIEW_SIZE_BYTES = 8 * 1024; // 8KB

/**
 * 持久化输出最大大小（超过此大小会被截断）
 */
export const MAX_PERSISTED_SIZE = 64 * 1024 * 1024; // 64MB

/**
 * 执行命令的选项
 */
export interface ExecOptions {
  command: string;
  /**
   * 前台超时（毫秒）。
   * 0 表示不设超时（如 sleep 命令）。
   * 普通命令默认 60s，超时自动转入后台。
   */
  timeout: number;
  cwd?: string;
  signal: AbortSignal;
  onProgress?: (progress: {
    output: string;
    fullOutput: string;
    elapsedTimeSeconds: number;
    totalLines: number;
    totalBytes: number;
  }) => void;
  /** 是否在后台运行（不阻塞等待结果） */
  runInBackground?: boolean;
  /** 命令描述（用于后台任务通知） */
  description?: string;
  /** 工具使用 ID（用于后台任务通知） */
  toolUseId?: string;
  /** 代理 ID（用于后台任务通知） */
  agentId?: string;
  /** 会话 ID（用于后台任务完成时通知正确的会话） */
  sessionID?: string;
}

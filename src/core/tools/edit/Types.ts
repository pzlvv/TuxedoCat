/**
 * Edit 工具类型定义
 */

import { z } from 'zod';

/**
 * Edit 工具输入 Schema
 */
export const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to edit'),
  old_string: z.string().describe('The exact string to replace'),
  new_string: z.string().describe('The new string to replace it with'),
  // 字符串感知：z.coerce.boolean() 会把 "false" 变成 true，这里显式处理字符串形式
  replace_all: z.union([
    z.boolean(),
    z.string().transform((v) => v === 'true' || (v !== 'false' && v.trim() !== '')),
  ]).optional().default(false)
    .describe('Replace all occurrences within the search range (default: false)'),
  offset: z.coerce.number().int().positive().optional()
    .describe('The 1-based line number where the search range starts (default: 1)'),
  limit: z.coerce.number().int().positive().optional()
    .describe('The number of lines to search within. If provided, old_string must match entirely within lines offset to offset+limit-1 (1-based); if omitted, searches to the end of the file'),
});

export type EditInput = z.infer<typeof inputSchema>;

/**
 * Edit 工具输出 Schema
 * 注意: diff 相关字段 (patch, contextBefore, contextAfter, afterContent)
 * 已在 requestToolPermission 阶段计算并显示，这里只返回执行结果
 *
 * beforeContent: 编辑前的文件内容，用于历史记录恢复时还原 diff 显示。
 * 虽然在当前对话的生命周期中 diff 已在 checkPermissions 阶段计算并显示，
 * 但 beforeContent 需要持久化到历史记录中，以便在加载历史对话时能重新计算 diff 并展示。
 */
export const outputSchema = z.object({
  type: z.enum(['create', 'update']).describe('Whether this was a file creation or update'),
  filePath: z.string().describe('The path to the file that was edited'),
  replacementsMade: z.number().describe('Number of replacements made'),
  lineCount: z.number().describe('Number of lines in the file after editing'),
  additions: z.number().describe('Number of lines added'),
  deletions: z.number().describe('Number of lines deleted'),
  startLine: z.number().describe('The 1-based line number where the edit starts'),
  endLine: z.number().describe('The 1-based line number where the edit ends'),
  beforeContent: z.string().optional().describe('The original file content before the edit (used for restoring diff display when loading history)'),
});

export type EditOutput = z.infer<typeof outputSchema>;

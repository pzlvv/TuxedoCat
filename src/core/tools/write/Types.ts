/**
 * Write 工具类型定义
 */

import { z } from 'zod';

/**
 * Write 工具输入 Schema
 */
export const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to write'),
  content: z.string().describe('The content to write to the file'),
});

export type WriteInput = z.infer<typeof inputSchema>;

/**
 * Write 工具输出 Schema
 */
export const outputSchema = z.object({
  type: z.enum(['create', 'update']).describe('Whether a new file was created or an existing file was updated'),
  filePath: z.string().describe('The path to the file that was written'),
  lineCount: z.number().describe('Number of lines written'),
  bytesWritten: z.number().describe('Number of bytes written'),
  beforeContent: z.string().nullable().optional().describe('The original file content before writing (null if file did not exist)'),
});

export type WriteOutput = z.infer<typeof outputSchema>;

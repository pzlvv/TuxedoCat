/**
 * Read 工具类型定义
 */

import { z } from 'zod';

/**
 * Read 工具输入 Schema
 */
export const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z.coerce.number().int().nonnegative().optional()
    .describe('The line number to start reading from (0-indexed)'),
  limit: z.coerce.number().int().positive().optional()
    .describe('The number of lines to read'),
  sheet: z.string().optional()
    .describe('Sheet name to read from Excel file. Defaults to the first sheet if not specified.'),
});

export type ReadInput = z.infer<typeof inputSchema>;

/**
 * Read 工具输出 Schema
 */
export const outputSchema = z.object({
  content: z.string().describe('The content of the file'),
  lineCount: z.number().describe('Number of lines read'),
  startLine: z.number().describe('The starting line number (0-indexed)'),
  totalLines: z.number().describe('Total number of lines in the file'),
  filePath: z.string().describe('The path to the file that was read'),
  sheetName: z.string().optional().describe('The name of the sheet that was read'),
  sheets: z.array(z.string()).optional().describe('List of all sheet names in the file (only for xlsx files)'),
  truncatedByBytes: z.boolean().optional().describe('Whether the output was truncated because it exceeded the maximum byte limit'),
});

export type ReadOutput = z.infer<typeof outputSchema>;

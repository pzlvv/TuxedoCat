/**
 * AskUserQuestion 工具类型定义
 *
 * 允许 LLM 在执行过程中向用户提问，等待用户回答后再继续。
 * 支持选择题（带选项）和开放题（纯文本输入）。
 */

import { z } from 'zod';

/**
 * AskUserQuestion 输入 Schema
 */
export const inputSchema = z.strictObject({
  question: z
    .string()
    .describe('The question to ask the user'),
  choices: z
    .array(
      z.strictObject({
        label: z.string().describe('The choice label (e.g., "A", "Option 1")'),
        description: z.string().optional().describe('Optional description for this choice'),
      }),
    )
    .min(1)
    .max(9)
    .optional()
    .describe('Multiple choice options (1-9). If not provided, user can reply with free text.'),
});

export type AskUserQuestionInput = z.infer<typeof inputSchema>;

/**
 * AskUserQuestion 输出 Schema
 */
export const outputSchema = z.object({
  index: z
    .number()
    .optional()
    .describe('The index of the selected choice (0-based). Only set if choices were provided.'),
  reply: z
    .string()
    .describe('The user\'s reply text. For multiple choice, this is the selected label. For free text, this is the user\'s input.'),
});

export type AskUserQuestionOutput = z.infer<typeof outputSchema>;

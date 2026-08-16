/**
 * SkillTool 类型定义
 */

import { z } from 'zod';

/**
 * SkillTool 输入 Schema
 */
export const inputSchema = z.strictObject({
  skill: z
    .string()
    .describe('The skill name. E.g., "commit", "review", or "test"'),
  args: z
    .string()
    .optional()
    .describe('Optional arguments for the skill'),
});

export type SkillToolInput = z.infer<typeof inputSchema>;

/**
 * SkillTool 输出 Schema
 */
export const outputSchema = z.object({
  success: z.boolean().describe('Whether the skill was executed successfully'),
  skillName: z.string().describe('The name of the skill that was invoked'),
  result: z.string().optional().describe('Result message from the skill execution'),
});

export type SkillToolOutput = z.infer<typeof outputSchema>;

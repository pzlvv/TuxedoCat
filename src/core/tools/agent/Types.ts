/**
 * AgentTool 工具类型定义
 * 子代理工具 - 委托复杂任务给专用子代理
 */

import { z } from 'zod';

/**
 * AgentTool 工具输入 Schema
 */
export const inputSchema = z.strictObject({
  prompt: z.string().describe('The task for the agent to perform'),
  description: z.string().optional().describe('A short (3-5 word) description of the task'),
  agentRole: z.enum(['Master']).describe('The role of the agent to spawn'),
});

export type AgentToolInput = z.infer<typeof inputSchema>;

/**
 * AgentTool 工具输出 Schema
 */
export const outputSchema = z.object({
  summary: z.string().describe('Summary of what the agent was tasked with'),
  subAgentId: z.string().optional().describe('The unique ID of the created sub-agent'),
  role: z.string().optional().describe('The role used for this agent'),
  messageCount: z.number().optional().describe('Number of messages exchanged in the sub-session'),
  exitCode: z.number().optional().describe('Exit code, 0 for success, non-zero for failure'),
  canceled: z.boolean().optional().describe('True when the queued call was canceled before the sub-agent was created'),
});

export type AgentToolOutput = z.infer<typeof outputSchema>;

/**
 * 角色-工具映射 & 角色-模型映射
 * 定义各角色可用的工具范围和对应的 LLM 模型配置
 *
 * Master: 主对话角色，所有工具可用
 */

import { getAllTools } from './index.js';
import type { LLMConfig } from '../llm/config.js';
import { getConfig } from '../llm/config.js';

/** 所有角色列表 */
export const AGENT_ROLES = ['Master'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * 获取角色对应的 LLM 模型配置
 * @param role 角色名
 * @returns 该角色绑定的 LLMConfig
 */
export async function getModelConfigForRole(_role: AgentRole): Promise<LLMConfig> {
  return getConfig();
}

/** Master 角色排除的工具（无） */
export const MASTER_EXCLUDED_TOOLS: string[] = [];

/**
 * 判断字符串是否为合法角色
 */
export function isValidRole(role: string): role is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role);
}

/**
 * 获取角色对应的可用工具列表
 * @param role 角色名
 * @returns 工具名数组（角色可见的工具），或 undefined（表示全部工具可见）
 */
export function getToolsForRole(role?: string): string[] | undefined {
  if (!role) return undefined;

  switch (role) {
    case 'Master': {
      // Master：所有工具可见
      const allTools = getAllTools() as unknown as Array<{ name: string }>;
      return allTools.map(t => t.name);
    }
    default:
      throw new Error(`Unknown agent role: ${role}`);
  }
}

/**
 * 获取角色描述
 */
export function getRoleDescription(role: string): string {
  switch (role) {
    case 'Master':
      return '主对话角色，可使用所有工具';
    default:
      throw new Error(`Unknown agent role: ${role}`);
  }
}

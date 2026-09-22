/**
 * 把 MCP 服务器暴露的工具适配成本项目内部的 Tool 接口。
 *
 * 关键点：
 * - 参数 schema 直接使用 MCP 提供的 JSON Schema（llmInputSchema），不经 Zod 往返；
 *   inputSchema 用 looseObject 放行任意参数，仅用于上游的参数校验不拦路。
 * - 工具名做命名空间隔离：mcp__<server>__<tool>，避免与内置工具重名。
 * - 输出统一展平为文本，非空，满足 RunTools 对 tool_result 的要求。
 */

import { z } from 'zod';
import { buildTool, MAX_RESULT_SIZE_CHARS } from '../tools/Tool.js';
import type { Tool } from '../tools/Tool.js';
import type { McpCallResult, McpToolDefinition } from './Client.js';

export interface McpToolOutput {
  text: string;
  isError: boolean;
}

/** LLM API 允许的工具名字符集，其余字符替换为下划线 */
function sanitizeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 生成暴露给 LLM 的工具名 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`;
}

/** 参数为空的兜底 JSON Schema */
const EMPTY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

/**
 * 创建一个 MCP 工具的 Tool 包装。
 *
 * @param serverName MCP 服务器名
 * @param exposedName 暴露给 LLM 的工具名（已命名空间隔离）
 * @param def MCP 服务器返回的工具定义
 * @param invoke 实际转发到 MCP 服务器的调用函数
 */
export function createMcpTool(
  serverName: string,
  exposedName: string,
  def: McpToolDefinition,
  invoke: (toolName: string, args: Record<string, unknown>) => Promise<McpCallResult>,
): Tool {
  const readOnlyHint = def.annotations?.readOnlyHint === true;
  const destructiveHint = def.annotations?.destructiveHint === true;
  const description = def.description?.trim()
    || `Tool "${def.name}" provided by MCP server "${serverName}".`;

  return buildTool({
    name: exposedName,
    searchHint: `MCP tool from ${serverName}`,
    // 统一上限（4K，前 2K + 后 2K 预览）
    maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

    get inputSchema() {
      // 放行任意参数：真正的约束由 llmInputSchema 交给 LLM，MCP 服务器自行校验
      return z.looseObject({});
    },

    get llmInputSchema() {
      return def.inputSchema ?? EMPTY_INPUT_SCHEMA;
    },

    description: async () => description,

    prompt: async () =>
      `MCP tool from server "${serverName}". Call it with the arguments described by its JSON schema; the server performs validation.`,

    async call(args): Promise<{ data: McpToolOutput }> {
      const result = await invoke(def.name, (args ?? {}) as Record<string, unknown>);
      const text = result.text && result.text.length > 0 ? result.text : '(no output)';
      return { data: { text, isError: result.isError } };
    },

    isReadOnly: () => readOnlyHint,
    isConcurrencySafe: () => readOnlyHint,
    isDestructive: () => destructiveHint,
    // 用户已在菜单中显式启用该 MCP，视为已授权
    checkPermissions: async () => ({ behavior: 'allow' as const }),
    userFacingName: () => `${serverName}: ${def.name}`,

    mapToolResultToToolResultBlockParam(result: McpToolOutput, toolUseID: string) {
      const content = result.isError ? `[MCP error] ${result.text}` : result.text;
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: content && content.length > 0 ? content : '(no output)',
      };
    },
  });
}

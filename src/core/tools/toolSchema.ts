/**
 * 工具 Schema 转换
 * 将 Zod schema 转换为 LLM API 格式
 */

import type { Tool } from './Tool.js';
import type { z } from 'zod';

/**
 * LLM API 工具格式
 */
export interface LlmTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description?: string;
      enum?: string[];
      items?: unknown;
    }>;
    required: string[];
  };
}

/**
 * 将 Zod schema 转换为 JSON Schema
 */
export function zodToJsonSchema(zodSchema: z.ZodType): {
  type: 'object';
  properties: Record<string, {
    type: string;
    description?: string;
  }>;
  required: string[];
} {
  const innerSchema = (zodSchema as any)._def;
  if (!innerSchema) {
    throw new Error('Invalid Zod schema: missing _def property');
  }

  const properties: Record<string, {
    type: string;
    description?: string;
  }> = {};
  const required: string[] = [];

  // 只处理 ZodObject 类型
  if (zodSchema.constructor?.name !== 'ZodObject') {
    throw new Error(`Expected ZodObject, got ${zodSchema.constructor?.name}`);
  }

  if (!innerSchema.shape) {
    throw new Error('ZodObject missing shape property');
  }

  // shape 可能是函数或对象
  const shape = typeof innerSchema.shape === 'function' ? innerSchema.shape() : innerSchema.shape;

  for (const [key, value] of Object.entries(shape)) {
    const fieldDef = (value as any)._def;
    const fieldConstructor = (value as any).constructor?.name;

    // 检查是否是 ZodOptional
    const isWrappedOptional = fieldConstructor === 'ZodOptional';

    // 获取类型名称
    let typeName = fieldConstructor;
    let description: string | undefined;

    // 如果是 ZodOptional，解包获取内部类型
    if (isWrappedOptional) {
      const innerType = fieldDef.innerType;
      if (innerType) {
        const innerDef = (innerType as any)._def;
        typeName = innerDef?.typeName || (innerType as any).constructor?.name;
        // 先检查外层 ZodOptional 的 description，再检查内层
        // .optional().describe() -> description 在外层
        // .describe().optional() -> description 在内层
        description = (value as any).description || (innerType as any).description;
      }
    } else {
      // 非 Optional 类型，描述存储在 value 对象上
      description = (value as any).description;
    }

    // 映射 Zod 类型到 JSON Schema 类型
    let fieldType = 'string';
    let enumValues: string[] | undefined;

    switch (typeName) {
      case 'ZodString':
        fieldType = 'string';
        break;
      case 'ZodNumber':
        fieldType = 'number';
        break;
      case 'ZodBoolean':
        fieldType = 'boolean';
        break;
      case 'ZodArray':
        fieldType = 'array';
        break;
      case 'ZodObject':
        fieldType = 'object';
        break;
      case 'ZodEnum':
        fieldType = 'string';
        enumValues = fieldDef.values;
        break;
    }

    properties[key] = {
      type: fieldType,
      ...(description && { description }),
      ...(enumValues && { enum: enumValues }),
    };

    // 检查是否必需
    if (!isWrappedOptional && !fieldDef?.defaultValue) {
      required.push(key);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}

/**
 * 将工具转换为 LLM API 格式
 */
export async function toolToLlmFormat(tool: Tool): Promise<LlmTool> {
  const description = await tool.description(
    {} as never,
    {
      isNonInteractiveSession: false,
      toolPermissionContext: {},
      tools: [],
    },
  );

  // 外部工具（MCP 等）自带 JSON Schema，直接透传，避免经 Zod 往返造成精度丢失
  const jsonSchema = (tool.llmInputSchema ?? zodToJsonSchema(tool.inputSchema)) as LlmTool['input_schema'];

  return {
    name: tool.name,
    description,
    input_schema: jsonSchema,
  };
}

/**
 * 批量转换工具列表
 */
export async function convertToolsToLlmFormat(tools: Tool[]): Promise<LlmTool[]> {
  return Promise.all(
    tools.map(tool => toolToLlmFormat(tool))
  );
}

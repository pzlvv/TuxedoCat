/**
 * 模型配置注册表 & max_tokens 管理
 *
 * 所有模型相关的配置集中管理：
 * - contextWindow: 上下文窗口大小
 * - maxOutputTokens: 最大输出 token 数
 * - supportsThinking: 是否支持 reasoning/thinking
 * - thinking_token_budget: 最大 thinking token 预算
 *
 * 当新增模型时，只需在此文件添加配置即可。
 */

import { ENV_MAX_OUTPUT_TOKENS } from '../../config/project.js';

// ============================================================
// 第一部分: ModelConfig — 模型配置注册表
// ============================================================

/**
 * 单个模型的配置项
 */
export interface ModelConfig {
  /** 模型名称（用于匹配 settings.json 中的 model 字段） */
  name: string;
  /** 上下文窗口大小（token 数） */
  contextWindow: number;
  /** 最大输出 token 数（如果未设置则使用全局默认值） */
  maxOutputTokens: number;
  /** 最大输出 thinking token 数（如果未设置则使用全局默认值） */
  thinking_token_budget: number;
  /** 是否支持 reasoning/thinking 功能 */
  supportsThinking?: boolean;
}

/**
 * settings.json 中 provider 级 modelConfigs 的单个模型限值。
 * 只允许覆盖 context 和 output，其它字段仍使用内置注册表。
 */
export interface ModelTokenLimits {
  context?: number;
  output?: number;
}

/**
 * 默认模型配置
 * 从 deepseek-v4-flash 复制而来，作为未命中已有模型配置时的兜底配置
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  name: 'deepseek-v4-flash',
  contextWindow: 1024 * 1024,
  thinking_token_budget: 192_000,
  maxOutputTokens: 384 * 1024,
  supportsThinking: true,
};

/**
 * 模型配置注册表
 * 按照模型名称匹配，支持子串匹配
 */
export const MODEL_CONFIGS: ModelConfig[] = [
  { ...DEFAULT_MODEL_CONFIG },
  // --- deepseek-v4-pro: 高质量模型
  {
    name: 'deepseek-v4-pro',
    contextWindow: 1024 * 1024,
    thinking_token_budget: 192_000,
    maxOutputTokens: 384 * 1024,
    supportsThinking: true,
  },
];

/**
 * 根据模型名称查找匹配的配置
 * 匹配逻辑：遍历注册表，返回第一个模型名是参数字串的配置
 * 如果没有精确匹配，则尝试子串匹配
 * 如果仍未匹配，返回注册表中的第一个模型配置作为默认配置
 * 传入 modelConfigs 时，会用 provider 配置中的 context/output 覆盖结果。
 */
export function getModelConfig(
  modelName: string,
  modelConfigs?: Record<string, ModelTokenLimits>,
): ModelConfig {
  const fallback = DEFAULT_MODEL_CONFIG;

  let base = fallback;
  if (modelName) {
    // 1. 精确匹配
    const exact = MODEL_CONFIGS.find((cfg) => cfg.name === modelName);
    if (exact) {
      base = exact;
    } else {
      // 2. 子串匹配：模型名包含注册表中的 name（注册表 name 较短）
      const substring = MODEL_CONFIGS.find((cfg) => modelName.includes(cfg.name));
      if (substring) {
        base = substring;
      }
    }
  }

  // provider 级 modelConfigs 覆盖（只覆盖 context / output）
  const override = modelName ? modelConfigs?.[modelName] : undefined;
  if (override) {
    return {
      ...base,
      contextWindow: Number.isFinite(override.context) ? override.context! : base.contextWindow,
      maxOutputTokens: Number.isFinite(override.output) ? override.output! : base.maxOutputTokens,
    };
  }

  return base;
}

/**
 * 获取模型的上下文窗口大小
 * modelConfigs 为可选的服务商级覆盖（settings.json 的 llm.providers[].modelConfigs）
 */
export function getContextWindow(
  modelName: string,
  modelConfigs?: Record<string, ModelTokenLimits>,
): number {
  return getModelConfig(modelName, modelConfigs).contextWindow;
}

// ============================================================
// 第二部分: max_tokens 输出限制管理
// ============================================================

// 默认 max_tokens 常量
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 384 * 1024;

export { ENV_MAX_OUTPUT_TOKENS };
/**
 * 获取最终有效的 max_tokens
 * 优先级：
 * 1. 环境变量 HARNESS_MAX_OUTPUT_TOKENS（最高优先级）
 * 2. 模型的默认 maxOutputTokens（来自 ModelConfig 注册表）
 * 3. 全局默认值 32K
 * 4. 不能超过上限 384K
 */
export function getMaxOutputTokens(
  modelName?: string,
  modelConfigs?: Record<string, ModelTokenLimits>,
): number {
  // 1. 检查环境变量覆盖（最高优先级）
  const envVal = process.env[ENV_MAX_OUTPUT_TOKENS];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    }
  }

  // 2. 如果传入了模型名称，尝试从 ModelConfig 获取模型默认值
  if (modelName) {
    const modelCfg = getModelConfig(modelName, modelConfigs);
    if (modelCfg.maxOutputTokens) {
      return Math.min(modelCfg.maxOutputTokens, MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    }
  }

  // 3. 全局默认值
  return MAX_OUTPUT_TOKENS_DEFAULT;
}

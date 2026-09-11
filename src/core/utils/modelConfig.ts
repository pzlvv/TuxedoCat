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
 * 模型参数配置（不含模型名）。
 * 描述一组模型限值，可作为注册表条目的参数，也可作为未命中时的兜底参数。
 */
export interface ModelParams {
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
 * 单个模型配置项 = 模型名 + 模型参数。
 * 注册表中的每个条目地位相同，仅用于按模型名匹配参数。
 */
export interface ModelConfig extends ModelParams {
  /** 模型名称（用于匹配 settings.json 中的 model 字段） */
  name: string;
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
 * 未命中 MODEL_CONFIGS 注册表时的兜底参数。
 *
 * 它不对应任何具体模型，也不是「默认模型」——默认模型由用户在
 * settings.json 的 llm.providers[].defaultModel 中配置；
 * 这里只是模型名无法匹配注册表条目时使用的一组保守限值。
 */
export const FALLBACK_MODEL_PARAMS: ModelParams = {
  contextWindow: 1024 * 1024,
  thinking_token_budget: 192 * 1024,
  maxOutputTokens: 384 * 1024,
  supportsThinking: true,
};

/**
 * 模型配置注册表
 * 按照模型名称匹配（精确匹配 + 子串匹配），所有条目地位相同。
 */
export const MODEL_CONFIGS: ModelConfig[] = [
  {
    name: 'deepseek-flash',
    contextWindow: 1024 * 1024,
    thinking_token_budget: 192 * 1024,
    maxOutputTokens: 384 * 1024,
    supportsThinking: true,
  },
  {
    name: 'deepseek-v4-flash',
    contextWindow: 1024 * 1024,
    thinking_token_budget: 192 * 1024,
    maxOutputTokens: 384 * 1024,
    supportsThinking: true,
  },
  {
    name: 'deepseek-v4-pro',
    contextWindow: 1024 * 1024,
    thinking_token_budget: 192 * 1024,
    maxOutputTokens: 384 * 1024,
    supportsThinking: true,
  },
];

/**
 * 根据模型名称查找匹配的配置
 * 匹配逻辑：先精确匹配注册表，其次子串匹配（模型名包含注册表 name）；
 * 未命中时使用 FALLBACK_MODEL_PARAMS 作为兜底参数。
 * 传入 modelConfigs 时，会用 provider 配置中的 context/output 覆盖结果。
 */
export function getModelConfig(
  modelName: string,
  modelConfigs?: Record<string, ModelTokenLimits>,
): ModelConfig {
  // 1. 精确匹配
  // 2. 子串匹配：模型名包含注册表中的 name（注册表 name 较短）
  const matched = modelName
    ? (MODEL_CONFIGS.find((cfg) => cfg.name === modelName)
      ?? MODEL_CONFIGS.find((cfg) => modelName.includes(cfg.name)))
    : undefined;

  const base: ModelParams = matched ?? FALLBACK_MODEL_PARAMS;

  // provider 级 modelConfigs 覆盖（只覆盖 context / output）
  const override = modelName ? modelConfigs?.[modelName] : undefined;
  const params: ModelParams = override
    ? {
        ...base,
        contextWindow: Number.isFinite(override.context) ? override.context! : base.contextWindow,
        maxOutputTokens: Number.isFinite(override.output) ? override.output! : base.maxOutputTokens,
      }
    : base;

  // name 放最后，避免 base（注册表条目）里的 name 覆盖匹配结果
  return { ...params, name: matched?.name ?? modelName ?? '' };
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

/**
 * 规范化 provider 的模型 context/output 配置（保存设置时使用）。
 *
 * - 已有且合法的 context/output 保留，不做覆盖；
 * - 缺失的字段从内置 MODEL_CONFIGS 注册表按模型名匹配补齐，
 *   匹配不到时回退到 FALLBACK_MODEL_PARAMS；
 * - models 列表中的每个模型都会生成一条包含 context 与 output 的完整配置；
 * - existing 中不在本次 models 列表里的历史条目也会保留（避免误删用户自定义限值）。
 *
 * 这样每次保存都能探测一遍配置，缺 context/output 的模型会自动补全，
 * 运行时就不会因为缺少限值而回退到全局默认值。
 */
export function normalizeModelTokenLimits(
  models: string[],
  existing?: Record<string, ModelTokenLimits> | null,
): Record<string, ModelTokenLimits> {
  const result: Record<string, ModelTokenLimits> = {};
  // 只有正数才视为「已存在」的限值，0/负数/非数字都按缺失处理
  const isValidLimit = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;

  // 1. 保留已有且合法的条目（含不在本次模型列表中的历史条目）
  for (const [model, limits] of Object.entries(existing || {})) {
    if (!limits || typeof limits !== 'object') continue;
    const entry: ModelTokenLimits = {};
    if (isValidLimit(limits.context)) entry.context = limits.context;
    if (isValidLimit(limits.output)) entry.output = limits.output;
    if (entry.context !== undefined || entry.output !== undefined) {
      result[model] = entry;
    }
  }

  // 2. 为 models 列表中的每个模型补齐缺失的 context/output
  for (const rawModel of models) {
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!model) continue;
    const fallback = getModelConfig(model);
    const current = result[model] || {};
    result[model] = {
      context: isValidLimit(current.context) ? current.context : fallback.contextWindow,
      output: isValidLimit(current.output) ? current.output : fallback.maxOutputTokens,
    };
  }

  return result;
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

/**
 * 计算本次请求实际可用的最大输出 token 数：
 *   min(output, contextWindow - currentContextTokens)
 *
 * 输出预留不能超过上下文窗口的剩余空间，否则「输入 + 输出」会超出窗口导致请求失败。
 * currentContextTokens 为当前上下文已占用的 token 数（input + output）。
 */
export function getAvailableOutputTokens(
  modelName: string | undefined,
  modelConfigs: Record<string, ModelTokenLimits> | undefined,
  currentContextTokens: number,
): number {
  const output = getMaxOutputTokens(modelName, modelConfigs);
  const contextWindow = getContextWindow(modelName || '', modelConfigs);
  const remaining = contextWindow - Math.max(0, currentContextTokens);
  return Math.max(1, Math.min(output, remaining));
}

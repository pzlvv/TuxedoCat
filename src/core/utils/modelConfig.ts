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
 * LLM API 协议类型（下放到模型级配置）：
 * - 'Responses'  OpenAI Responses API      POST {baseURL}/v1/responses
 * - 'OpenAI'     OpenAI Chat Completions   POST {baseURL}/v1/chat/completions
 * - 'Anthropic'  Anthropic Messages API    POST {baseURL}/v1/messages
 */
export type ApiType = 'Anthropic' | 'Responses' | 'OpenAI';

/**
 * 模型未显式配置协议时使用的默认协议。
 * 取 OpenAI Chat Completions：它是绝大多数服务商都兼容的接口，
 * 手动添加的模型默认走这里（自动获取的模型会探测后写入真实协议）。
 */
export const DEFAULT_API_TYPE: ApiType = 'OpenAI';

/**
 * 自动探测协议时的优先级由 llm/apiTypes 的协议注册表决定
 * （每个协议类自带 probePriority，数值越小越优先）。
 */

/** 把任意输入规范化为合法的 ApiType，非法值回退到 DEFAULT_API_TYPE */
export function normalizeApiType(value: unknown): ApiType {
  return value === 'Responses' || value === 'Anthropic' || value === 'OpenAI'
    ? value
    : DEFAULT_API_TYPE;
}

/**
 * settings.json 中 provider 级 modelConfigs 的单个模型配置。
 * context / output 可覆盖内置注册表；apiType 指定该模型使用的协议。
 */
export interface ModelTokenLimits {
  context?: number;
  output?: number;
  /** 该模型使用的 API 协议（模型级，替代原先的 provider 级 apiType） */
  apiType?: ApiType;
}

/**
 * 解析某个模型最终生效的 API 协议：
 * modelConfigs[model].apiType → DEFAULT_API_TYPE（未配置时）。
 */
export function resolveApiTypeForModel(
  model: string | undefined,
  modelConfigs?: Record<string, ModelTokenLimits> | null,
): ApiType {
  const explicit = model ? modelConfigs?.[model]?.apiType : undefined;
  return explicit === undefined ? DEFAULT_API_TYPE : normalizeApiType(explicit);
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
 * 规范化 provider 的模型配置（保存设置时使用）。
 *
 * - 已有且合法的 context/output/apiType 保留，不做覆盖；
 * - 缺失的 context/output 从内置 MODEL_CONFIGS 注册表按模型名匹配补齐，
 *   匹配不到时回退到 FALLBACK_MODEL_PARAMS；
 * - apiType 不会被自动填默认值，只来自 apiTypeOverrides（设置面板）或已有值，
 *   保证「未探测过协议」的模型在下次自动获取时仍会被探测；
 * - existing 中不在本次 models 列表里的历史条目也会保留（避免误删用户自定义限值）。
 */
export function normalizeModelTokenLimits(
  models: string[],
  existing?: Record<string, ModelTokenLimits> | null,
  apiTypeOverrides?: Record<string, ApiType> | null,
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
    if (limits.apiType !== undefined) entry.apiType = normalizeApiType(limits.apiType);
    if (entry.context !== undefined || entry.output !== undefined || entry.apiType !== undefined) {
      result[model] = entry;
    }
  }

  // 2. 为 models 列表中的每个模型补齐缺失的 context/output
  // apiType 只接受显式来源（面板传值 > 已有值），不会自动填充默认值：
  // 未配置 apiType 的模型需要由「自动获取」探测后写入，否则探测会被跳过。
  for (const rawModel of models) {
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!model) continue;
    const fallback = getModelConfig(model);
    const current = result[model] || {};
    const entry: ModelTokenLimits = {
      context: isValidLimit(current.context) ? current.context : fallback.contextWindow,
      output: isValidLimit(current.output) ? current.output : fallback.maxOutputTokens,
    };
    const overrideType = apiTypeOverrides?.[model];
    if (overrideType !== undefined) {
      entry.apiType = normalizeApiType(overrideType);
    } else if (current.apiType !== undefined) {
      entry.apiType = current.apiType;
    }
    result[model] = entry;
  }

  return result;
}

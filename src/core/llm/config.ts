/**
 * LLM API 配置
 * 从 ~/<CONFIG_DIR_NAME>/settings.json 读取配置
 */

import * as fs from 'fs/promises';
import type { AgentMode } from '../types.js';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../Logger.js';
import { readSettingsJson } from '../history/Config.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import {
  FALLBACK_MODEL_PARAMS,
  DEFAULT_API_TYPE,
  resolveApiTypeForModel,
  type ModelTokenLimits,
  type ApiType,
} from '../utils/modelConfig.js';
import type { PromptPresetId } from '../prompt/PromptPreset.js';

/**
 * LLM API 协议类型（定义在 utils/modelConfig.ts，这里重新导出方便调用方引用）
 * - 'Responses': OpenAI Responses API（POST {baseURL}/responses 或 {baseURL}/v1/responses）
 * - 'OpenAI':    OpenAI Chat Completions（POST {baseURL}/v1/chat/completions）
 * - 'Anthropic': Anthropic 兼容协议（POST {baseURL}/v1/messages）
 *
 * 注意：协议已下放到模型级（llm.providers[].modelConfigs[model].apiType），
 * 不再有 provider 级 / 全局 apiType。
 */
export type { ApiType };
export { DEFAULT_API_TYPE, resolveApiTypeForModel };

export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  maxTokens: number;
  // 注：不再提供 timeout 配置项。
  // 流式请求的超时保护统一由 streamTimeout.ts 的看门狗负责
  // （首字节 300s / 空闲 60s），配置项与真实行为不一致会造成误导。
  /**
   * LLM API 协议类型。由调用方（getConfig / callRealLLM）按最终生效的 model
   * 从 provider.modelConfigs[model].apiType 解析后填入，不再来自全局配置。
   * @default 'OpenAI'
   */
  apiType?: ApiType;
  /**
   * 是否启用 Web Search（仅 apiType='Responses' 时生效）
   * 开启后在请求中附加内置 { type: 'web_search' } 工具，模型自动联网搜索
   * @default true
   */
  webSearch?: boolean;
  /**
   * Thinking 的预算 token 数
   * 分配给思考过程的 token 上限
   * @default 2048
   */
  thinking_budget_tokens?: number;
  /**
   * 新对话的默认 thinking effort 模式
   * 仅影响新对话的默认值，已存在的对话使用各自的 meta.json 中保存的值
   * @default 'high'
   */
  thinking_effort?: 'off' | 'low' | 'high' | 'max';
  /** 当前 active provider 的各模型 context/output 覆盖 */
  modelConfigs?: Record<string, ModelTokenLimits>;
}

/** settings.json 中 llm.providers 下的单个 provider 配置 */
export interface LLMProviderConfig {
  /** 服务地址，如 https://opencode.ai/zen/go */
  baseURL: string;
  /** API Key */
  apiKey?: string;
  /** 该服务商可用的模型列表（由用户自动获取或手动维护） */
  models?: string[];
  /** 该服务商的默认模型 */
  defaultModel?: string;
  /**
   * 该服务商各模型的配置（与 models 并列，保存时自动维护）：
   * context / output 限值 + apiType 协议（协议已下放到模型级）
   */
  modelConfigs?: Record<string, ModelTokenLimits>;
}

/** 返回给设置面板的 provider 信息 */
export interface LLMProviderInfo {
  key: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  modelConfigs: Record<string, ModelTokenLimits>;
}

/** 设置面板需要的完整 LLM 配置载荷 */
export interface LLMConfigPanelPayload {
  baseURL: string;
  webSearch: boolean;
  thinkingEffort: 'off' | 'low' | 'high' | 'max';
  defaultModel: string;
  defaultAgentMode: AgentMode;
  defaultPromptMode: PromptPresetId;
  apiKey: string;
  providers: LLMProviderInfo[];
  activeProvider: string;
}

interface HarnessConfig {
  llm: {
    model: string;
    maxTokens: number;
    /** 是否启用 Web Search（仅 apiType='Responses' 时生效） */
    webSearch?: boolean;
    thinking_budget_tokens?: number;
    /**
     * 新对话的默认 thinking effort 模式
     * 仅影响新对话的默认值，已存在的对话使用各自的 meta.json 中保存的值
     */
    thinking_effort?: 'off' | 'low' | 'high' | 'max';
    /** 多个 provider 配置，以 baseURL 的 hostname 为 key */
    providers?: Record<string, LLMProviderConfig>;
    /** 当前使用的 provider key（对应 llm.providers 中的 key） */
    activeProvider?: string;
  };
  /**
   * 新对话的默认模型（顶层，与 llm 平级，不放入 llm）
   * 仅影响新对话的默认值，已存在的对话使用各自的 meta.json 中保存的值
   */
  defaultModel?: string;
  /**
   * 新对话的默认工作模式（manual | risk | auto，顶层，与 llm 平级）
   * 仅影响新对话的默认值，已存在的对话使用各自会话中保存的值
   */
  defaultAgentMode?: AgentMode;
  /**
   * 新对话的默认提示词模式（normal | minimal | mixed，顶层，与 llm 平级）
   * 仅影响新对话的默认值，已存在的对话使用各自 meta.json 中保存的值
   */
  defaultPromptMode?: PromptPresetId;
  features?: {
    enableTools?: boolean;
    enableThinking?: boolean;
    maxTurns?: number;
  };
  enableUsageStats?: boolean;
}

/**
 * 创建兜底配置（settings.json 完全未配置时使用）
 *
 * 注意：这里没有「默认模型」——模型（含默认模型）完全由用户配置：
 * 默认模型在 llm.providers[].defaultModel，会话模型在各自 meta.json。
 * 因此 model 留空，等用户在设置页配置 provider 后再由用户指定。
 * apiKey 为空字符串，getConfig() 发现 apiKey 为空时会直接抛错，引导用户到设置面板配置。
 */
function createFallbackConfig(): LLMConfig {
  return {
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: '',
    maxTokens: FALLBACK_MODEL_PARAMS.maxOutputTokens,
    apiType: DEFAULT_API_TYPE,
    webSearch: true,
    thinking_budget_tokens: FALLBACK_MODEL_PARAMS.thinking_token_budget,
    thinking_effort: 'high',
    modelConfigs: {},
  };
}

/**
 * 缓存的配置
 */
let cachedConfig: LLMConfig | null = null;
let cachedEnableUsageStats: boolean | null = null;

/**
 * 清除配置缓存，强制重新读取配置文件
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedEnableUsageStats = null;
}

/**
 * 读取配置文件
 *
 * 配置目录: ~/<CONFIG_DIR_NAME>/settings.json
 * 文件不存在或解析失败时抛出异常。
 */
async function loadConfigFile(): Promise<HarnessConfig> {
  const homeDir = os.homedir();
  const configPath = path.join(homeDir, CONFIG_DIR_NAME, 'settings.json');

  let config: Partial<HarnessConfig> = {};

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    config = JSON.parse(content);
  } catch {
    // 配置文件不存在或解析失败
  }

  if (!config.llm) {
    throw new Error('No LLM configuration found in settings files');
  }

  return config as HarnessConfig;
}

/**
 * 获取 LLM 配置
 * 优先从配置文件 ~/<CONFIG_DIR_NAME>/settings.json 读取，否则使用硬编码的默认值
 *
 * @returns LLM 配置对象；apiKey 未配置时抛错
 */
export async function getConfig(): Promise<LLMConfig> {
  return getDefaultConfig();
}

/**
 * 从配置文件中解析当前 active provider；未配置或不存在时返回 undefined。
 */
function getActiveProviderFromConfig(configFile?: HarnessConfig): LLMProviderConfig | undefined {
  const activeKey = configFile?.llm?.activeProvider;
  if (!activeKey) return undefined;
  const provider = configFile?.llm?.providers?.[activeKey];
  return provider && provider.baseURL ? provider : undefined;
}

/**
 * 从已解析的配置文件中读取当前 provider 的默认模型：
 * provider.defaultModel → provider.models[0] → ''。
 * 模型完全由用户配置，这里不存在内置的「兜底模型」。
 */
function getProviderDefaultModelFromConfig(configFile?: HarnessConfig): string {
  const activeProvider = getActiveProviderFromConfig(configFile);
  if (activeProvider?.defaultModel?.trim()) {
    return activeProvider.defaultModel.trim();
  }
  if (Array.isArray(activeProvider?.models) && activeProvider.models.length > 0) {
    return activeProvider.models[0];
  }
  return '';
}

/**
 * 读取 settings.json 中是否已设置有效的 llm.activeProvider。
 * 新对话检测用：未设置时前端应弹出设置页。
 */
export async function hasActiveProviderSetting(): Promise<boolean> {
  try {
    const settings = await readSettingsJson();
    const activeKey = settings?.llm?.activeProvider;
    return typeof activeKey === 'string'
      && !!activeKey
      && !!settings?.llm?.providers?.[activeKey]?.baseURL;
  } catch {
    return false;
  }
}

/**
 * 读取设置面板所需的完整 LLM 配置载荷。
 * 只读取 llm.providers / llm.activeProvider，不再兼容旧版扁平字段。
 */
export async function getLLMConfigPanelPayload(): Promise<LLMConfigPanelPayload> {
  const defaultConfig = createFallbackConfig();
  let settings: Record<string, any> = {};
  try {
    settings = await readSettingsJson();
  } catch {
    // 读取失败时使用空配置
  }
  const llm = settings?.llm || {};
  const providersMap: Record<string, LLMProviderConfig> =
    llm.providers && typeof llm.providers === 'object' ? llm.providers : {};

  const providers: LLMProviderInfo[] = Object.entries(providersMap)
    .filter(([, p]) => !!p?.baseURL)
    .map(([key, p]) => ({
      key,
      baseURL: p!.baseURL,
      apiKey: p?.apiKey || '',
      models: Array.isArray(p?.models)
        ? Array.from(new Set(
            (p!.models as unknown[])
              .filter((m): m is string => typeof m === 'string' && !!m.trim())
              .map((m) => m.trim()),
          ))
        : [],
      defaultModel: typeof p?.defaultModel === 'string' && p!.defaultModel.trim() ? p!.defaultModel.trim() : '',
      modelConfigs: p?.modelConfigs && typeof p.modelConfigs === 'object'
        ? p.modelConfigs
        : {},
    }));

  const rawActive = llm.activeProvider;
  const activeProvider = typeof rawActive === 'string' && providersMap[rawActive]?.baseURL ? rawActive : '';

  const active = activeProvider ? providersMap[activeProvider] : undefined;
  return {
    baseURL: active?.baseURL || defaultConfig.baseURL,
    apiKey: active?.apiKey || '',
    webSearch: typeof llm.webSearch === 'boolean' ? llm.webSearch : defaultConfig.webSearch,
    thinkingEffort: llm.thinking_effort || defaultConfig.thinking_effort,
    defaultModel: active?.defaultModel || active?.models?.[0] || defaultConfig.model,
    defaultAgentMode: settings?.defaultAgentMode === 'manual' || settings?.defaultAgentMode === 'auto' ? settings.defaultAgentMode : 'risk',
    defaultPromptMode: settings?.defaultPromptMode === 'minimal' || settings?.defaultPromptMode === 'mixed'
      ? settings.defaultPromptMode
      : 'normal',
    providers,
    activeProvider,
  };
}

/**
 * 获取主模型配置（优先从 settings.json 的 llm.* 读取）
 */
async function getDefaultConfig(): Promise<LLMConfig> {
  // 返回浅拷贝：调用方可能原地修改返回值（如 callRealLLM 写 config.apiType），
  // 若直接返回 cachedConfig 引用会污染全局缓存，影响后续所有 getConfig 结果。
  if (cachedConfig) {
    return { ...cachedConfig };
  }

  const defaultConfig = createFallbackConfig();

  // 读取配置文件，失败时回退到默认配置
  let configFile: HarnessConfig | undefined;
  try {
    configFile = await loadConfigFile();
  } catch {
    logger.warn('getConfig', 'Failed to read settings.json, using default config');
  }

  let config: LLMConfig;
  if (configFile?.llm) {
    // 只使用 llm.activeProvider 指向的 provider 配置；
    // 未设置 activeProvider 时使用默认配置，不再兼容旧版扁平字段
    const activeProvider = getActiveProviderFromConfig(configFile);
    const model = configFile.llm.model || getProviderDefaultModelFromConfig(configFile) || defaultConfig.model;
    const modelConfigs = activeProvider?.modelConfigs && typeof activeProvider.modelConfigs === 'object'
      ? activeProvider.modelConfigs
      : {};
    config = {
      apiKey: activeProvider?.apiKey || defaultConfig.apiKey,
      baseURL: activeProvider?.baseURL || defaultConfig.baseURL,
      model,
      maxTokens: configFile.llm.maxTokens || defaultConfig.maxTokens,
      // apiType 已下放到模型级：按最终生效的 model 解析
      apiType: resolveApiTypeForModel(model, modelConfigs),
      webSearch: configFile.llm.webSearch ?? defaultConfig.webSearch,
      thinking_budget_tokens: configFile.llm.thinking_budget_tokens ?? defaultConfig.thinking_budget_tokens,
      thinking_effort: configFile.llm.thinking_effort ?? defaultConfig.thinking_effort,
      modelConfigs,
    };
  } else {
    config = { ...defaultConfig };
  }

  // apiKey 是必填项：未配置时直接报错，引导用户到设置面板 / settings.json 配置
  if (!config.apiKey) {
    throw new Error(
      'API Key 未配置，无法调用 LLM。\n' +
      '请在「设置 → LLM 配置」中填写 API Key，\n' +
      `或编辑 ~/${CONFIG_DIR_NAME}/settings.json 中对应 provider 的 apiKey 字段。`
    );
  }

  cachedConfig = config;
  return { ...cachedConfig };
}

/**
 * 获取全局的 usage stats 配置
 * 不依赖 LLM 配置，对所有 subagent 模式生效
 * @default true
 */
export async function getEnableUsageStats(): Promise<boolean> {
  if (cachedEnableUsageStats !== null) {
    return cachedEnableUsageStats;
  }

  try {
    const configFile = await loadConfigFile();
    cachedEnableUsageStats = configFile.enableUsageStats ?? true;
  } catch {
    cachedEnableUsageStats = true;
  }

  return cachedEnableUsageStats;
}

/**
 * 获取 settings.json 中新对话的默认 thinking_effort 值
 * 仅用于新对话的初始值，已存在的对话使用各自 meta.json 中的 thinkingMode
 * @returns 'off' | 'low' | 'high' | 'max'，默认返回 'off'
 */
export async function getDefaultThinkingEffort(): Promise<'off' | 'low' | 'high' | 'max'> {
  try {
    const configFile = await loadConfigFile();
    return configFile?.llm?.thinking_effort ?? createFallbackConfig().thinking_effort ?? 'off';
  } catch {
    return createFallbackConfig().thinking_effort ?? 'off';
  }
}

/**
 * 获取 settings.json 中新对话的默认 model 值
 * 默认模型由用户配置、且归属到具体服务商：读取当前 activeProvider 的 defaultModel，
 * 未设置时取该服务商模型列表的第一个模型；两者都没有时返回空字符串，
 * 由用户在设置页配置 provider 后再指定。
 * 仅用于新对话的初始值，已存在的对话使用各自 meta.json 中的 model
 * @returns 模型名称，未配置 provider 时为空字符串
 */
export async function getDefaultModel(): Promise<string> {
  try {
    const configFile = await loadConfigFile();
    return getProviderDefaultModelFromConfig(configFile);
  } catch {
    return '';
  }
}

/**
 * 读取当前 activeProvider 的模型列表与默认模型。
 * 未配置 activeProvider、或该 provider 没有可用模型列表时返回 null
 * （此时无法判断模型是否合法，调用方应保持原值不做回退）。
 */
export async function getActiveProviderModels(): Promise<{ models: string[]; defaultModel: string } | null> {
  try {
    const configFile = await loadConfigFile();
    const activeKey = configFile?.llm?.activeProvider;
    const activeProvider = activeKey ? configFile?.llm?.providers?.[activeKey] : undefined;
    if (!activeProvider?.baseURL) return null;
    const models = Array.isArray(activeProvider.models)
      ? Array.from(new Set(
          (activeProvider.models as unknown[])
            .filter((m): m is string => typeof m === 'string' && !!m.trim())
            .map((m) => m.trim()),
        ))
      : [];
    if (models.length === 0) return null;
    const defaultModel = typeof activeProvider.defaultModel === 'string' && activeProvider.defaultModel.trim()
      ? activeProvider.defaultModel.trim()
      : models[0];
    return { models, defaultModel };
  } catch {
    return null;
  }
}

/**
 * 校验模型是否属于当前 activeProvider 提供的模型列表：
 * - 属于列表：原样返回
 * - 不属于列表：回退到 provider 的默认模型（defaultModel，其次 models[0]）
 * - 无法判断（未配置 provider / 模型列表为空）：原样返回
 *
 * 用于「切换 provider、切换对话」等场景，避免继续使用当前服务商不支持的模型。
 */
export async function resolveModelForActiveProvider(modelName: string): Promise<string> {
  const info = await getActiveProviderModels();
  if (!info) return modelName;
  if (modelName && info.models.includes(modelName)) return modelName;
  return info.defaultModel || modelName;
}

/**
 * 获取 settings.json 中新对话的默认询问模式（manual=所有 | risk=关键 | auto=禁用）
 * 读取顶层 defaultAgentMode（与 llm 平级）
 * 仅用于新对话的初始值，已存在的对话使用各自会话中保存的值
 * @returns 询问模式，默认返回 'risk'（关键）
 */
export async function getDefaultAgentMode(): Promise<AgentMode> {
  try {
    const configFile = await loadConfigFile();
    const mode = configFile?.defaultAgentMode;
    return mode === 'manual' || mode === 'risk' || mode === 'auto' ? mode : 'risk';
  } catch {
    return 'risk';
  }
}

/**
 * 获取 settings.json 中新对话的默认提示词模式（normal | minimal | mixed）
 * 读取顶层 defaultPromptMode（与 llm 平级）
 * 仅用于新对话的初始值，已存在的对话使用各自 meta.json 中保存的 promptMode
 * @returns 默认 'normal'
 */
export async function getDefaultPromptMode(): Promise<PromptPresetId> {
  try {
    const configFile = await loadConfigFile();
    const mode = configFile?.defaultPromptMode;
    return mode === 'normal' || mode === 'minimal' || mode === 'mixed' ? mode : 'normal';
  } catch {
    return 'normal';
  }
}

/**
 * 获取 settings.json 中新对话的默认 Web Search 开关（llm.webSearch）
 * 仅用于新对话的初始值，已存在的对话使用各自 meta.json 中保存的 webSearch
 * @returns 默认 false
 */
export async function getDefaultWebSearch(): Promise<boolean> {
  try {
    const configFile = await loadConfigFile();
    return configFile?.llm?.webSearch ?? createFallbackConfig().webSearch ?? false;
  } catch {
    return createFallbackConfig().webSearch ?? false;
  }
}



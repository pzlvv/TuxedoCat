/**
 * LLM API 配置
 * 从 ~/<CONFIG_DIR_NAME>/settings.json 读取配置
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../Logger.js';
import { saveApiKeyToSettings, readSettingsJson } from '../history/Config.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import {
  FALLBACK_MODEL_PARAMS,
  DEFAULT_API_TYPE,
  resolveApiTypeForModel,
  type ModelTokenLimits,
  type ApiType,
} from '../utils/modelConfig.js';
import { DEFAULT_WAKE_SHORTCUT, normalizeAccelerator } from '../utils/shortcut.js';
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
  timeout?: number;
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
  defaultAgentMode: 'manual' | 'risk' | 'auto';
  defaultPromptMode: PromptPresetId;
  apiKey: string;
  providers: LLMProviderInfo[];
  activeProvider: string;
  /** Electron 端唤醒快捷键（accelerator 形式，如 Ctrl+Alt+X） */
  shortcut: string;
}

interface HarnessConfig {
  llm: {
    model: string;
    maxTokens: number;
    timeout?: number;
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
  defaultAgentMode?: 'manual' | 'risk' | 'auto';
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
 * apiKey 为空字符串，在 getConfig() 中若发现 apiKey 为空，会弹出密码输入框让用户输入
 */
function createFallbackConfig(): LLMConfig {
  return {
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    model: '',
    maxTokens: FALLBACK_MODEL_PARAMS.maxOutputTokens,
    timeout: 300000,
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
 * Per-process 锁，用于防止多个并行 getConfig 同时弹出 apiKey 输入框。
 * 当第一个 getConfig 弹出输入框时，其他调用等待（await 此 Promise）。
 * apiKey 输入完成后，锁 resolve，所有等待的调用直接读取 settings 中已保存的 apiKey。
 */
const pendingApiKeyPromises = new Map<string, {
  promise: Promise<string | null>;
  resolve: (token: string | null) => void;
}>();

/**
 * 从 settings.json 中读取 baseURL，若不存在则返回默认值
 */
function getBaseUrlFromSettings(): string {
  try {
    const fs = require('fs');
    const path = require('path');
    const homeDir = require('os').homedir();
    const configPath = path.join(homeDir, CONFIG_DIR_NAME, 'settings.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const activeKey = cfg?.llm?.activeProvider;
      const activeProvider = activeKey ? cfg?.llm?.providers?.[activeKey] : undefined;
      if (activeProvider?.baseURL) {
        return activeProvider.baseURL;
      }
      if (activeKey) {
        // 已设置 activeProvider 但 provider 没有 baseURL 时，不使用旧扁平字段
        return createFallbackConfig().baseURL;
      }
    }
  } catch {}
  return createFallbackConfig().baseURL;
}

/**
 * 保存 baseURL 到 settings.json（串行化写入，避免并发写坏文件）
 */
async function saveBaseUrlToSettings(baseURL: string): Promise<void> {
  try {
    const { updateSettingsJson } = await import('../history/Config.js');
    await updateSettingsJson((cfg: Record<string, any>) => {
      if (!cfg.llm) cfg.llm = {};
      // 新结构：baseURL 只保存到 activeProvider 对应的 provider 内
      const activeKey = cfg.llm.activeProvider;
      if (activeKey && cfg.llm.providers?.[activeKey]) {
        cfg.llm.providers[activeKey].baseURL = baseURL;
      }
    });
    // 清除缓存，下次读取时会重新加载
    clearConfigCache();
  } catch (e) {
    logger.error('Config', `保存 baseURL 到 settings.json 失败: ${e}`);
  }
}

/**
 * 弹出配置对话框，让用户编辑 baseURL 和 API Key
 * 先提示 baseURL（从文件中预填，或使用默认值），再提示 apiKey
 * 用户输入后保存到 settings.json
 */
async function promptApiKey(context?: { sessionId?: string }): Promise<string | null> {
  // 动态导入 AssistantUI 以避免循环依赖
  const { getGlobalUI } = await import('../AssistantUI.js');
  const ui = getGlobalUI();

  if (!ui?.requestPassword) {
    // 没有 UI 交互能力（如 CLI 模式）时无法输入
    throw new Error(
      `API Key 未配置。请编辑 ~/${CONFIG_DIR_NAME}/settings.json 配置 LLM API Key：\n` +
      '  { "llm": { "apiKey": "your_api_key_here" } }\n' +
      '或访问 LLM 服务商控制台获取 API Key。'
    );
  }

  // 第一步：提示 baseURL（使用明文输入框，预填已有的或默认值）
  const existingBaseURL = getBaseUrlFromSettings();
  let baseURL = existingBaseURL;
  try {
    if (ui?.requestPassword) {
      const userBaseURL = await ui.requestPassword(
        context?.sessionId || '',
        '请输入 API Base URL（服务端地址）',
        undefined,
        true, // plainText: true，以明文显示
      );
      if (userBaseURL && userBaseURL.trim()) {
        baseURL = userBaseURL.trim();
      }
    }
  } catch {}

  // 第二步：提示 apiKey
  const msg =
    '请前往 LLM 服务商控制台获取 API Key，\n' +
    '然后将 Key 粘贴到下方输入框中，点击完成保存。';

  const apiKey = await ui.requestPassword(context?.sessionId || '', msg, {
    pattern: /^sk-/,
    message: 'API Key 格式错误，必须以 "sk-" 开头',
  });
  if (!apiKey) {
    return null; // 用户取消
  }

  // 保存 baseURL 到 settings.json（如果发生了变化）
  if (baseURL !== existingBaseURL) {
    await saveBaseUrlToSettings(baseURL);
  }

  // 保存 apiKey 到 settings.json
  await saveApiKeyToSettings(apiKey);
  // 清除配置缓存，确保下次 getConfig 能读到新配置
  clearConfigCache();

  logger.info('getConfig', `Base URL and API Key saved to settings.json (baseURL=${baseURL})`);
  return apiKey;
}

/**
 * 获取 LLM 配置
 * 优先从配置文件 ~/<CONFIG_DIR_NAME>/settings.json 读取，否则使用硬编码的默认值
 *
 * @param sessionId - 会话 ID（用于弹出 apiKey 输入框时标识所属会话）
 * @returns LLM 配置对象
 */
export async function getConfig(sessionId?: string): Promise<LLMConfig> {
  return getDefaultConfig(sessionId);
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
    defaultAgentMode: settings?.defaultAgentMode === 'risk' || settings?.defaultAgentMode === 'auto' ? settings.defaultAgentMode : 'manual',
    defaultPromptMode: settings?.defaultPromptMode === 'minimal' || settings?.defaultPromptMode === 'mixed'
      ? settings.defaultPromptMode
      : 'normal',
    providers,
    activeProvider,
    shortcut: normalizeAccelerator(settings?.shortcut) || DEFAULT_WAKE_SHORTCUT,
  };
}

/**
 * 获取主模型配置（优先从 settings.json 的 llm.* 读取）
 */
async function getDefaultConfig(sessionId?: string): Promise<LLMConfig> {
  if (cachedConfig) {
    return cachedConfig;
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
      timeout: configFile.llm.timeout || defaultConfig.timeout,
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

  // 如果 apiKey 为空，弹出输入框让用户输入
  if (!config.apiKey) {
    const userApiKey = await promptForApiKey(sessionId);
    config.apiKey = userApiKey;
  }

  cachedConfig = config;
  return cachedConfig;
}

/**
 * 弹出 apiKey 输入框让用户输入
 * 使用 Per-process 锁防止多个并行调用同时弹出多个输入框
 */
async function promptForApiKey(sessionId?: string): Promise<string> {
  const lockKey = 'llm_api_key';

  const pending = pendingApiKeyPromises.get(lockKey);
  if (pending) {
    // 已有调用在等待输入，await 那个输入的结果
    logger.info('getConfig', 'Waiting for pending apiKey input...');
    const userApiKey = await pending.promise;
    if (!userApiKey) {
      throw new Error(
        '用户取消了 API Key 输入，无法配置 LLM。\n' +
        '请前往 LLM 服务商控制台获取 API Key 后，\n' +
        `编辑 ~/${CONFIG_DIR_NAME}/settings.json 中的 "llm.apiKey" 字段。`
      );
    }
    // apiKey 已由第一个调用保存到 settings，重新从缓存中获取完整配置
    if (cachedConfig) {
      return cachedConfig.apiKey;
    }
    return userApiKey;
  }

  // 没有 pending 输入，创建新的锁并弹出输入框
  let resolveApiKeyPromise: (apiKey: string | null) => void = () => { };
  const apiKeyPromise = new Promise<string | null>((resolve) => {
    resolveApiKeyPromise = resolve;
  });
  pendingApiKeyPromises.set(lockKey, { promise: apiKeyPromise, resolve: resolveApiKeyPromise });

  try {
    const userApiKey = await promptApiKey({ sessionId });
    resolveApiKeyPromise(userApiKey);
    if (!userApiKey) {
      throw new Error(
        '用户取消了 API Key 输入，无法配置 LLM。\n' +
        '请前往 LLM 服务商控制台获取 API Key 后，\n' +
        `编辑 ~/${CONFIG_DIR_NAME}/settings.json 中的 "llm.apiKey" 字段。`
      );
    }
    return userApiKey;
  } finally {
    pendingApiKeyPromises.delete(lockKey);
  }
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
 * 获取 settings.json 中新对话的默认工作模式（manual | risk | auto）
 * 读取顶层 defaultAgentMode（与 llm 平级）
 * 仅用于新对话的初始值，已存在的对话使用各自会话中保存的值
 * @returns 工作模式，默认返回 'manual'
 */
export async function getDefaultAgentMode(): Promise<'manual' | 'risk' | 'auto'> {
  try {
    const configFile = await loadConfigFile();
    const mode = configFile?.defaultAgentMode;
    return mode === 'manual' || mode === 'risk' || mode === 'auto' ? mode : 'manual';
  } catch {
    return 'manual';
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



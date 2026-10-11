/**
 * LLM 配置读取。
 *
 * **配置归 UI**：本模块只从配置快照取值（`src/core/settings.ts`），不读
 * `settings.json`、不持有内置模型注册表——注册表与用户覆盖的合并由 UI 在产出快照时
 * 完成（`docs/architecture/core-ui-separation.md` 第 4 节）。因此这里没有任何读盘缓存：
 * 快照变了，下次取值就是新值。
 *
 * 面向设置面板的读取（默认值、provider 列表、模型身份校验）不在这里：
 * 那些是宿主侧的事，见 `src/host/settingsRead.ts`。
 */

import { logger } from '../Logger.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { DEEPSEEK_BASE_URL } from '../endpoints.js';
import { getSettings } from '../settings.js';
import type { ModelLimits } from '../settingsSnapshot.js';
import { limitsFor } from './modelLimits.js';
import {
  DEFAULT_API_TYPE,
  normalizeApiType,
  resolveApiTypeForModel,
  type ApiType,
} from '../utils/modelConfig.js';
import type { ModelRef } from './modelRef.js';
import type { AgentMode } from '../types.js';

export type { ApiType };
export { DEFAULT_API_TYPE, resolveApiTypeForModel };
/** DeepSeek 官方服务地址的唯一来源（这里只转出，值见 `endpoints.ts`） */
export { DEEPSEEK_BASE_URL };

/** 思考强度取值 */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

/** 调用 LLM 所需的最终配置 */
export interface LLMConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 配置级输出上限（快照的 `llm.maxTokens`） */
  maxTokens: number;
  /**
   * LLM API 协议类型。按最终生效的 model 从 `modelLimits` 解析后填入。
   * @default 'OpenAI'
   */
  apiType?: ApiType;
  /**
   * 是否启用 Web Search（仅 apiType='Responses' 时生效）
   * @default true
   */
  webSearch?: boolean;
  /**
   * 新对话的默认 thinking effort 模式
   * 仅影响新对话的默认值，已存在的对话使用各自的 meta.json 中保存的值
   * @default 'high'
   */
  thinking_effort?: ThinkingEffort;
  /**
   * 本次请求的输出 token 上限（可选）。
   *
   * 由调用方按「上下文窗口剩余空间」收窄后填入（`Query.ts` 的
   * `availableOutputTokens`）；不填时用模型限值。它是**每次请求派生**的值，
   * 不是配置字段。
   */
  outputTokenCap?: number;
  /** 该 provider 已解析的模型限值表（键为模型名） */
  modelLimits: Record<string, ModelLimits>;
  /** 模型未命中 `modelLimits` 时的全局兜底 */
  modelLimitsFallback: ModelLimits;
}

/**
 * 按 `(provider, model)` 构造 LLMConfig；apiKey 为空时抛错。
 *
 * `allowLegacyModel` 只在「没有会话级 provider 覆盖」时为真：那条路径允许顶层遗留的
 * `llm.model` 优先于 provider 的默认模型（对齐 `getConfigForProvider` 的分叉）。
 */
function buildConfig(providerKey: string, modelOverride?: string, allowLegacyModel = false): LLMConfig {
  const settings = getSettings();
  const provider = settings.llm.providers[providerKey];
  if (!provider?.baseURL) {
    logger.error('getConfigForProvider', `provider "${providerKey}" 不存在，拒绝构造 LLMConfig`);
    throw new Error(`provider "${providerKey}" 不存在或未配置 baseURL`);
  }

  const model = modelOverride
    || (allowLegacyModel ? settings.llm.model : '')
    || provider.defaultModel;
  const limits = provider.modelLimits[model];
  const apiType = limits?.apiType ?? DEFAULT_API_TYPE;

  const config: LLMConfig = {
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    model,
    maxTokens: settings.llm.maxTokens,
    apiType: normalizeApiType(apiType),
    webSearch: settings.llm.webSearch,
    thinking_effort: settings.llm.thinkingEffort,
    modelLimits: provider.modelLimits,
    modelLimitsFallback: settings.llm.modelLimitsFallback,
  };

  if (!config.apiKey) {
    throw new Error(
      'API Key 未配置，无法调用 LLM。\n' +
      '请在「设置 → LLM 配置」中填写 API Key，\n' +
      `或编辑 ~/${CONFIG_DIR_NAME}/settings.json 中对应 provider 的 apiKey 字段。`
    );
  }

  return config;
}

/**
 * 获取 LLM 配置（active provider）。
 *
 * @returns LLM 配置对象；未配置 active provider 或 apiKey 未填时抛错
 */
export async function getConfig(): Promise<LLMConfig> {
  const activeKey = getSettings().llm.activeProvider;
  if (!activeKey) {
    throw new Error(
      '未配置 LLM provider。\n' +
      '请在「设置 → LLM 配置」中添加 provider 并选择默认 provider。'
    );
  }
  return buildConfig(activeKey, undefined, true);
}

/** 是否上报 usage 统计（`llm.enableUsageStats`，默认开） */
export async function getEnableUsageStats(): Promise<boolean> {
  return getSettings().llm.enableUsageStats;
}

/** 新对话的默认 thinking_effort */
export async function getDefaultThinkingEffort(): Promise<ThinkingEffort> {
  return getSettings().llm.thinkingEffort;
}

// ==================== 多 provider：模型菜单与 (provider, model) 校验 ====================

/**
 * 取 baseURL 的 hostname（小写）；解析失败或为空返回空串。
 * 用于按域名识别 provider，避免把 `https://api.deepseek.com/v1` 这类带路径的写法漏掉。
 */
function baseUrlHostname(baseURL: unknown): string {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return '';
  try {
    return new URL(baseURL.trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 读取「api.deepseek.com」这个 provider 的 API Key —— 余额查询专用。
 *
 * 为什么不能直接用 getConfig()：它返回的是 **active provider** 的 apiKey/baseURL。
 * active provider 通常是第三方网关（opencode.ai / z.ai ...），拿它的 Key 去打
 * https://api.deepseek.com/user/balance 只会得到 401 Authorization Required。
 * 余额只有 DeepSeek 官方能查，所以这里固定按域名找 provider：
 * - 匹配 baseURL 的 hostname === api.deepseek.com（也兼容 provider key 恰好是域名）；
 * - 找不到该 provider、或它没配 apiKey → 返回 null，调用方跳过余额查询（不发请求）。
 */
export async function getDeepSeekProviderApiKey(): Promise<string | null> {
  const providers = getSettings().llm.providers;
  const targetHost = baseUrlHostname(DEEPSEEK_BASE_URL);

  for (const [key, provider] of Object.entries(providers)) {
    const matches = baseUrlHostname(provider.baseURL) === targetHost
      || key.trim().toLowerCase() === targetHost;
    if (!matches) continue;
    const apiKey = provider.apiKey.trim();
    if (apiKey) return apiKey;
  }
  return null;
}

/**
 * 取指定 `(provider, model)` 的 LLM 配置。
 *
 * 与 active provider 无关：调用方给出模型身份，本函数只解析该 provider 的配置。
 * provider 不存在 / 缺 baseURL 属于必须暴露的错误，不做兜底。
 *
 * - model 为空 → 取 provider.defaultModel；
 * - apiType 按最终生效的 model + 该 provider 的 modelLimits 解析；
 * - 全局字段（webSearch / thinkingEffort / enableUsageStats）取自快照。
 *
 * apiKey 未配置时抛错（与 getConfig 一致，引导用户到设置面板配置）。
 */
export async function getConfigForProvider(ref: ModelRef): Promise<LLMConfig> {
  return buildConfig(ref.provider, ref.model);
}

/** 新对话的默认询问模式（manual=总是 | risk=关键 | auto=从不） */
export async function getDefaultAgentMode(): Promise<AgentMode> {
  return getSettings().defaultAgentMode;
}

/** 新对话的默认 Web Search 开关 */
export async function getDefaultWebSearch(): Promise<boolean> {
  return getSettings().llm.webSearch;
}

/** 供调用方按 provider 取限值（`OpenAiApi` / `RealApi` / `ResponsesApi` 用） */
export function limitsOf(config: LLMConfig, model?: string): ModelLimits | undefined {
  return limitsFor(model, config.modelLimits, config.modelLimitsFallback);
}

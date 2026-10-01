/**
 * 配置快照：Core 消费的配置形态（契约由 core 定义）。
 *
 * 磁盘上的 `settings.json` 与 `mcp.json` 归 UI 所有（`docs/core-ui-separation.md`
 * 第 4 节）。UI 读盘后调本模块的纯函数补默认值、规范化，产出一份快照，经
 * `UiEvent.hostEnvironmentProvided` 下发给 Core；Core 侧只有一个读取入口
 * （`src/core/settings.ts` 的 `getSettings()` / `getMcpServerDefinitions()`），
 * 不感知这两个文件的路径，也不读盘。
 *
 * **字段全部必选**：缺字段即协议错误，不做静默回落。默认值与合并规则在 UI 侧执行
 * （本模块的纯函数），Core 不提供默认值。
 *
 * 快照**不含** `uiLanguage` 与 `highlightLanguages`：这两个字段只有 UI 消费；
 * 也**不含**工作区 endpoint 与凭证：那是 Connection 的配置，不是 Core 的。
 */

import type { AgentMode } from './types.js';
import type { PromptPresetId } from './prompt/PromptPreset.js';
import {
  DEFAULT_API_TYPE,
  FALLBACK_MODEL_PARAMS,
  MODEL_CONFIGS,
  getModelConfig,
  normalizeApiType,
  type ApiType,
  type ModelTokenLimits,
} from './utils/modelConfig.js';
import { isPlainObject, type McpServerDefinition } from './mcp/parse.js';

export type { McpServerDefinition };

/** 思考强度取值（与 `settings.json` 的 `llm.thinking_effort` 一致） */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

/**
 * 单个模型的**已解析**限值：内置模型注册表与用户覆盖合并后的结果。
 *
 * Core 只读结果，不持有注册表、不做模型名匹配（`docs/core-ui-separation.md`
 * 第 4.3 节）。未命中 `modelLimits` 的模型用 `modelLimitsFallback`。
 */
export interface ModelLimits {
  /** 上下文窗口（token 数） */
  context: number;
  /** 最大输出 token 数 */
  output: number;
  /** LLM API 协议 */
  apiType: ApiType;
  /** thinking token 预算 */
  thinkingTokenBudget: number;
}

/** provider 的规范化配置 */
export interface SettingsSnapshotProvider {
  /**
   * 服务地址。
   *
   * 允许为空串：快照原样携带 provider 表，是否可用由消费方各自判定
   * （调 LLM 要求非空；余额查询只按 key / hostname 匹配）。
   */
  baseURL: string;
  /** API Key；未配置时为空串 */
  apiKey: string;
  /** 该服务商可用的模型列表（去重、trim） */
  models: string[];
  /** 默认模型：`provider.defaultModel` → `models[0]` → 空串 */
  defaultModel: string;
  /** 已解析的模型限值，键为模型名 */
  modelLimits: Record<string, ModelLimits>;
}

/** 配置快照 */
export interface SettingsSnapshot {
  llm: {
    /** 当前 provider 键；未配置或指向不存在的 provider 时为空串 */
    activeProvider: string;
    /** 默认 Web Search 开关 */
    webSearch: boolean;
    /** 默认思考强度 */
    thinkingEffort: ThinkingEffort;
    /**
     * 顶层遗留模型名（`llm.model`）。
     *
     * 只在「没有会话级 provider 覆盖」时优先于 provider 的默认模型
     * （对齐 `getDefaultConfig` 与 `getConfigForProvider` 的分叉）。
     */
    model: string;
    /** 配置级输出上限（`llm.maxTokens`，缺省与兜底输出同值） */
    maxTokens: number;
    /** 是否上报 usage 统计（`llm.enableUsageStats`，默认开） */
    enableUsageStats: boolean;
    /** provider 表，键为 provider key */
    providers: Record<string, SettingsSnapshotProvider>;
    /**
     * 模型限值的全局兜底：未配置 provider、或模型不在任何 `modelLimits` 里时使用。
     * 兜底是全局常量，与具体 provider 无关。
     */
    modelLimitsFallback: ModelLimits;
  };
  mcp: {
    /** 全局默认启用的 MCP 服务器名列表 */
    enabled: string[];
  };
  /** 新会话默认询问模式 */
  defaultAgentMode: AgentMode;
  /** 新会话默认提示词模式 */
  defaultPromptMode: PromptPresetId;
}

/** 默认 Web Search 开关（对齐 `createFallbackConfig().webSearch`） */
const DEFAULT_WEB_SEARCH = true;
/** 默认思考强度（对齐 `createFallbackConfig().thinking_effort`） */
const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';
/** 是否上报 usage 统计的默认值（对齐 `getEnableUsageStats` 的 `?? true`） */
const DEFAULT_ENABLE_USAGE_STATS = true;

/**
 * 兜底模型限值：注册表未命中时使用（对齐 `FALLBACK_MODEL_PARAMS`）。
 * `apiType` 不在注册表里，取默认协议。
 */
const FALLBACK_LIMITS: ModelLimits = {
  context: FALLBACK_MODEL_PARAMS.contextWindow,
  output: FALLBACK_MODEL_PARAMS.maxOutputTokens,
  apiType: DEFAULT_API_TYPE,
  thinkingTokenBudget: FALLBACK_MODEL_PARAMS.thinking_token_budget,
};

/** 解析单个模型的限值：注册表匹配 → 用户 context/output 覆盖 → 补 apiType */
function resolveModelLimits(model: string, overrides: Record<string, ModelTokenLimits>): ModelLimits {
  const base = getModelConfig(model, overrides);
  const explicitApiType = model ? overrides[model]?.apiType : undefined;
  return {
    context: base.contextWindow,
    output: base.maxOutputTokens,
    apiType: explicitApiType === undefined ? DEFAULT_API_TYPE : normalizeApiType(explicitApiType),
    thinkingTokenBudget: base.thinking_token_budget,
  };
}

/** 规范化模型列表：只留非空字符串、trim、去重（保持原顺序） */
function normalizeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    (raw as unknown[])
      .filter((model): model is string => typeof model === 'string' && !!model.trim())
      .map((model) => model.trim()),
  ));
}

/**
 * 规范化 provider 的 `modelConfigs`（用户覆盖）。
 *
 * 保留口径与 `getModelConfig` 一致：`context` / `output` 只要求是有限数，
 * `apiType` 只要求是字符串；其余字段一律丢弃。
 */
function normalizeModelConfigs(raw: unknown): Record<string, ModelTokenLimits> {
  if (!isPlainObject(raw)) return {};
  const out: Record<string, ModelTokenLimits> = {};
  for (const [model, limits] of Object.entries(raw)) {
    if (!isPlainObject(limits)) continue;
    const entry: ModelTokenLimits = {};
    if (typeof limits.context === 'number' && Number.isFinite(limits.context)) {
      entry.context = limits.context;
    }
    if (typeof limits.output === 'number' && Number.isFinite(limits.output)) {
      entry.output = limits.output;
    }
    if (typeof limits.apiType === 'string') {
      entry.apiType = normalizeApiType(limits.apiType);
    }
    if (entry.context !== undefined || entry.output !== undefined || entry.apiType !== undefined) {
      out[model] = entry;
    }
  }
  return out;
}

/**
 * 收集需要预解析的模型名。
 *
 * 取 `provider.models` ∪ `modelConfigs` 的键 ∪ 内置注册表的模型名：
 * 前两者是用户显式配置的模型，后者保证注册表命中不依赖 Core 侧再做匹配。
 * 其它模型（用户手输、会话历史里保存的旧模型）一律走 `modelLimitsFallback`。
 */
function collectKnownModels(models: string[], modelConfigs: Record<string, ModelTokenLimits>): string[] {
  const names = new Set<string>(models);
  for (const model of Object.keys(modelConfigs)) names.add(model);
  for (const entry of MODEL_CONFIGS) names.add(entry.name);
  return Array.from(names);
}

/** 解析 provider 的默认模型：`defaultModel` → `models[0]` → 空串 */
function resolveDefaultModel(raw: Record<string, unknown>, models: string[]): string {
  const explicit = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : '';
  if (explicit) return explicit;
  return models.length > 0 ? models[0] : '';
}

/** 规范化 provider 表 */
function resolveProviders(raw: unknown): Record<string, SettingsSnapshotProvider> {
  const providers: Record<string, SettingsSnapshotProvider> = {};
  if (!isPlainObject(raw)) return providers;

  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue;
    const baseURL = typeof value.baseURL === 'string' ? value.baseURL.trim() : '';

    const models = normalizeModels(value.models);
    const modelConfigs = normalizeModelConfigs(value.modelConfigs);
    const modelLimits: Record<string, ModelLimits> = {};
    for (const model of collectKnownModels(models, modelConfigs)) {
      modelLimits[model] = resolveModelLimits(model, modelConfigs);
    }

    providers[key] = {
      baseURL,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      models,
      defaultModel: resolveDefaultModel(value, models),
      modelLimits,
    };
  }
  return providers;
}

/** 规范化 `mcp.enabled`：非数组或非字符串项一律丢弃 */
function resolveMcpEnabled(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const enabled = raw.enabled;
  if (!Array.isArray(enabled)) return [];
  return enabled.filter((name): name is string => typeof name === 'string');
}

/** 规范化询问模式：白名单外的取值回落到 `risk` */
function resolveAgentMode(raw: unknown): AgentMode {
  return raw === 'manual' || raw === 'auto' ? raw : 'risk';
}

/** 规范化提示词模式：白名单外的取值回落到 `normal` */
function resolvePromptMode(raw: unknown): PromptPresetId {
  return raw === 'minimal' || raw === 'mixed' ? raw : 'normal';
}

/** 规范化思考强度：白名单外的取值回落到 `high` */
function resolveThinkingEffort(raw: unknown): ThinkingEffort {
  return raw === 'off' || raw === 'low' || raw === 'high' || raw === 'max' ? raw : DEFAULT_THINKING_EFFORT;
}

/**
 * 把已 `JSON.parse` 的 `settings.json` 解析为配置快照（纯函数，不做 I/O）。
 *
 * 任何字段缺失、类型不对或取值非法都按默认值处理，不抛错：磁盘文件是用户可编辑的，
 * 解析失败退化为默认值比让 Core 起不来更合适。真正的协议错误（快照缺字段）由
 * Core 侧的必选类型与断言暴露。
 */
export function resolveSettingsSnapshot(rawSettings: unknown): SettingsSnapshot {
  const root = isPlainObject(rawSettings) ? rawSettings : {};
  const llm = isPlainObject(root.llm) ? root.llm : {};
  const providers = resolveProviders(llm.providers);

  const activeRaw = llm.activeProvider;
  const activeProvider = typeof activeRaw === 'string' && providers[activeRaw]?.baseURL
    ? activeRaw
    : '';

  return {
    llm: {
      activeProvider,
      webSearch: typeof llm.webSearch === 'boolean' ? llm.webSearch : DEFAULT_WEB_SEARCH,
      thinkingEffort: resolveThinkingEffort(llm.thinking_effort),
      model: typeof llm.model === 'string' ? llm.model.trim() : '',
      maxTokens: typeof llm.maxTokens === 'number' && Number.isFinite(llm.maxTokens) && llm.maxTokens > 0
        ? llm.maxTokens
        : FALLBACK_MODEL_PARAMS.maxOutputTokens,
      enableUsageStats: typeof llm.enableUsageStats === 'boolean'
        ? llm.enableUsageStats
        : DEFAULT_ENABLE_USAGE_STATS,
      providers,
      modelLimitsFallback: FALLBACK_LIMITS,
    },
    mcp: {
      enabled: resolveMcpEnabled(root.mcp),
    },
    defaultAgentMode: resolveAgentMode(root.defaultAgentMode),
    defaultPromptMode: resolvePromptMode(root.defaultPromptMode),
  };
}

/** 快照里该 provider 是否可用（存在且配了 baseURL） */
export function hasProvider(snapshot: SettingsSnapshot, key: string): boolean {
  return !!snapshot.llm.providers[key];
}

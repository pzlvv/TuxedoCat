/**
 * LLM 全局配置的保存（**宿主侧**，`docs/architecture/core-ui-separation.md` 第 4.6 节）。
 *
 * 配置归宿主：设置面板的整段 mutation（provider 表 + `modelConfigs` 补齐 +
 * 顶层默认值 + MCP 默认启用列表）在这里执行，`settings.json` 由宿主写，
 * 写盘后 `SettingsStore` 重新构造快照并推给已就绪的 Connection。
 *
 * Core 不参与：它既不读配置文件、也不提供默认值、也不持有内置模型注册表
 * （`modelConfigs` 的补齐用宿主侧的 `MODEL_CONFIGS`）。
 *
 * `applyLlmConfigSave` 是纯函数（改传入的 cfg 对象），因此可以直接交给
 * `SettingsStore.updateSettings` 做串行化的「读-改-写」。
 */

import { mcpDefaultsMutator } from '../shared/mcp/Config.js';
import { normalizeModelTokenLimits, type ModelTokenLimits } from '../shared/utils/modelConfig.js';
import { providerKeyFromBaseURL } from '../shared/utils/providerKey.js';

/** 设置面板保存消息（webview 发来的 `saveLLMConfig` 原始消息，字段都按可选处理） */
export interface LlmConfigSavePayload {
  /** 默认 Web Search 开关（顶层 `llm.webSearch`） */
  webSearch?: unknown;
  /** 默认思考强度（`llm.thinking_effort`） */
  thinkingEffort?: unknown;
  /** 默认工作模式（顶层 `defaultAgentMode`，与 `llm` 平级） */
  defaultAgentMode?: unknown;
  /** 默认提示词模式（顶层 `defaultPromptMode`） */
  defaultPromptMode?: unknown;
  /** 界面语言（顶层 `uiLanguage`）；只有 UI 消费，不进配置快照 */
  language?: unknown;
  /** 界面字号（顶层 `uiFontSize`）；只有 UI 消费，不进配置快照 */
  fontSize?: unknown;
  /** 是否写入 provider 表（编辑模型列表 / API 配置 / 显式选择 provider 时为 true） */
  saveProviders?: unknown;
  /** provider 表（`saveProviders` 为 true 时使用） */
  providers?: unknown;
  /** 面板选中的 active provider */
  activeProvider?: unknown;
  /** MCP 默认启用列表（设置面板「默认配置」） */
  mcpServers?: unknown;
}

/** provider 条目的面板侧形态（逐字段校验，不信任 webview 的类型） */
interface PanelProvider {
  baseURL?: unknown;
  apiKey?: unknown;
  models?: unknown;
  modelApiTypes?: unknown;
  defaultModel?: unknown;
}

const API_TYPES = new Set(['Responses', 'OpenAI', 'Anthropic']);
const PROMPT_MODES = new Set(['normal', 'minimal', 'mixed']);
const UI_LANGUAGES = new Set(['auto', 'zh', 'en']);
const UI_FONT_SIZES = new Set(['medium', 'large', 'xlarge']);

/**
 * 把设置面板的一次保存并入 `settings.json` 的内存对象。
 *
 * 直接改传入的 `cfg`（与 `SettingsJsonMutator` 的约定一致）。四段处理：
 * 1. provider 表（仅在 `saveProviders` 时）；
 * 2. 全表 `modelConfigs` 补齐（保留用户手填的 context/output）；
 * 3. 顶层默认值（只在发生变化时写，避免每次保存都覆盖一遍预设字段）；
 * 4. MCP 默认启用列表。
 */
export function applyLlmConfigSave(cfg: Record<string, any>, payload: LlmConfigSavePayload): void {
  if (!cfg.llm || typeof cfg.llm !== 'object' || Array.isArray(cfg.llm)) cfg.llm = {};

  // ---- 1. provider 表 ----
  // 有 provider 变更（如编辑模型列表/API 配置）或显式选择「使用此 Provider」时，
  // 保存 llm.providers / llm.activeProvider；普通保存只写默认设置，不修改 provider。
  const providers = payload.providers;
  if (payload.saveProviders === true && Array.isArray(providers) && providers.length > 0) {
    const providersMap: Record<string, any> = {};
    for (const raw of providers as PanelProvider[]) {
      const providerBaseURL = typeof raw?.baseURL === 'string' ? raw.baseURL.trim() : '';
      const providerApiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
      if (!providerBaseURL || !providerApiKey) continue;
      const key = providerKeyFromBaseURL(providerBaseURL);
      if (!key) continue;
      const providerModels = Array.isArray(raw?.models)
        ? Array.from(new Set(
            (raw.models as unknown[])
              .filter((m): m is string => typeof m === 'string' && !!m.trim())
              .map((m) => m.trim()),
          ))
        : [];
      // 面板传来的「模型 -> 协议」映射（手动选择或自动探测结果）；
      // 未出现在映射中的模型保持原状（不写入 apiType），以便下次自动获取时继续探测
      const apiTypeOverrides: Record<string, 'Responses' | 'OpenAI' | 'Anthropic'> = {};
      if (raw?.modelApiTypes && typeof raw.modelApiTypes === 'object' && !Array.isArray(raw.modelApiTypes)) {
        for (const [model, apiType] of Object.entries(raw.modelApiTypes as Record<string, unknown>)) {
          if (typeof apiType === 'string' && API_TYPES.has(apiType)) {
            apiTypeOverrides[model] = apiType as 'Responses' | 'OpenAI' | 'Anthropic';
          }
        }
      }
      // modelConfigs：保留已有 context/output/apiType，缺失的 context/output
      // 从内置注册表匹配补齐；apiType 来自面板（手动选择或自动探测结果）
      const oldProvider = cfg.llm.providers?.[key];
      const oldModelConfigs: Record<string, ModelTokenLimits> = oldProvider?.modelConfigs
        && typeof oldProvider.modelConfigs === 'object'
        ? oldProvider.modelConfigs
        : {};
      const modelConfigs = normalizeModelTokenLimits(providerModels, oldModelConfigs, apiTypeOverrides);
      providersMap[key] = {
        baseURL: providerBaseURL,
        apiKey: providerApiKey,
        models: providerModels,
        modelConfigs,
        ...(typeof raw?.defaultModel === 'string' && raw.defaultModel.trim()
          ? { defaultModel: raw.defaultModel.trim() }
          : {}),
      };
    }
    const keys = Object.keys(providersMap);
    if (keys.length > 0) {
      cfg.llm.providers = providersMap;

      const requested = typeof payload.activeProvider === 'string' ? payload.activeProvider : '';
      cfg.llm.activeProvider = requested && providersMap[requested] ? requested : keys[0];
    }
  }

  // ---- 2. 全表 modelConfigs 补齐 ----
  // 无论本次保存是否修改了 provider，都探测一遍所有 provider 的模型 context/output 配置：
  // 已有值保留，缺失的字段从内置模型注册表匹配补齐（匹配不到则用兜底配置），
  // 保证运行时不会因为缺少限值而回退到全局默认值。
  if (cfg.llm.providers && typeof cfg.llm.providers === 'object') {
    for (const provider of Object.values(cfg.llm.providers as Record<string, any>)) {
      if (!provider || typeof provider !== 'object') continue;
      const models = Array.isArray(provider.models)
        ? (provider.models as unknown[])
            .filter((m): m is string => typeof m === 'string' && !!m.trim())
            .map((m) => m.trim())
        : [];
      provider.modelConfigs = normalizeModelTokenLimits(models, provider.modelConfigs);
    }
  }

  // ---- 3. 顶层默认值 ----
  // 预设值只在发生变化（或尚不存在）时写入；如果 settings 中已经有相同值，
  // 新建/编辑 Provider 时不再重复写入，避免每次保存都覆盖一遍预设字段。
  if (typeof payload.webSearch === 'boolean' && cfg.llm.webSearch !== payload.webSearch) {
    cfg.llm.webSearch = payload.webSearch;
  }
  if (typeof payload.thinkingEffort === 'string' && payload.thinkingEffort
    && cfg.llm.thinking_effort !== payload.thinkingEffort) {
    cfg.llm.thinking_effort = payload.thinkingEffort;
  }
  if (typeof payload.defaultAgentMode === 'string' && payload.defaultAgentMode
    && cfg.defaultAgentMode !== payload.defaultAgentMode) {
    cfg.defaultAgentMode = payload.defaultAgentMode;
  }
  if (typeof payload.defaultPromptMode === 'string' && PROMPT_MODES.has(payload.defaultPromptMode)
    && cfg.defaultPromptMode !== payload.defaultPromptMode) {
    cfg.defaultPromptMode = payload.defaultPromptMode;
  }
  if (typeof payload.language === 'string' && UI_LANGUAGES.has(payload.language)
    && cfg.uiLanguage !== payload.language) {
    if (payload.language === 'auto') {
      // auto 是默认值：显式配置过才需要删掉
      delete cfg.uiLanguage;
    } else {
      cfg.uiLanguage = payload.language;
    }
  }
  if (typeof payload.fontSize === 'string' && UI_FONT_SIZES.has(payload.fontSize)
    && cfg.uiFontSize !== payload.fontSize) {
    if (payload.fontSize === 'medium') {
      // medium 是默认值：显式配置过才需要删掉
      delete cfg.uiFontSize;
    } else {
      cfg.uiFontSize = payload.fontSize;
    }
  }

  // ---- 4. MCP 默认启用列表 ----
  // 只改全局默认；各会话在菜单里的勾选存在各自 meta.json，不受影响。
  if (Array.isArray(payload.mcpServers)) {
    mcpDefaultsMutator(
      (payload.mcpServers as unknown[]).filter((n): n is string => typeof n === 'string'),
    )(cfg);
  }
}

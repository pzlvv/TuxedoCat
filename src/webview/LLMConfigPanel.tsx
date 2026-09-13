import React, { useState, useEffect, useRef } from 'react';
import { postMessage, getHostInfo } from './webviewEnv';
import { providerKeyFromBaseURL } from '../core/utils/providerKey.js';
import {
  DEFAULT_WAKE_SHORTCUT,
  acceleratorFromKeyboardEvent,
  formatAcceleratorForDisplay,
  normalizeAccelerator,
} from '../core/utils/shortcut.js';
import type { Colors, ThinkingMode, AgentMode, PromptMode } from './types';
import type { McpServerInfo } from '../core/webviewTypes';
import { t } from './i18n';

/** 一个模型的草稿（模型名 + 该模型使用的 API 协议） */
interface ModelDraft {
  name: string;
  /** Responses | OpenAI | Anthropic */
  apiType: string;
}

/** 一个 Provider 草稿（对应设置页里的一个 tab） */
interface ProviderDraft {
  /** React key / 草稿 ID */
  id: string;
  baseURL: string;
  apiKey: string;
  /** 该服务商的模型列表（自动获取或手动维护） */
  models: ModelDraft[];
  /** 该服务商的默认模型 */
  defaultModel: string;
}

/** 对话空间统计条目（来自 extension 的 conversationSpacesData） */
interface ConversationSpaceItem {
  dirName: string;
  projectPath: string;
  sizeBytes: number;
  fileCount: number;
  conversationCount: number;
}

interface LLMConfigPanelProps {
  colors: Colors;
  initialBaseURL: string;
  initialWebSearch?: boolean;
  initialThinkingEffort?: ThinkingMode;
  initialDefaultAgentMode?: AgentMode;
  initialDefaultPromptMode?: PromptMode;
  /** 已保存的 API Key（从设置中预填，避免每次打开都重新输入） */
  initialApiKey?: string;
  /** 已保存的界面语言（auto | zh | en） */
  initialLanguage?: 'auto' | 'zh' | 'en';
  /** 已保存的唤醒快捷键（仅 Electron 使用，accelerator 形式） */
  initialShortcut?: string;
  /** 已保存的 Provider 列表（settings.json 的 llm.providers，apiType 在 modelConfigs 里） */
  initialProviders?: Array<{
    key: string;
    baseURL: string;
    apiKey: string;
    models?: string[];
    defaultModel?: string;
    modelConfigs?: Record<string, { context?: number; output?: number; apiType?: string }>;
  }>;
  /** settings.json 的 llm.activeProvider */
  initialActiveProvider?: string;
  /** 全局默认启用的 MCP 列表（settings.json 的 mcp.enabled + mcp.json 的服务器定义） */
  initialMcpServers?: McpServerInfo[];
  /** 触发设置面板时当前显示的会话 ID（保存时回传，供扩展端校验/回退模型） */
  currentSessionId?: string | null;
  /** 触发设置面板时当前会话使用的模型（保存时回传，供扩展端校验/回退模型） */
  currentModel?: string;
  onClose: () => void;
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
/**
 * 手动添加的模型默认协议：v1 chat completions（兼容性最广）。
 * 自动获取的模型会由扩展端并发探测后写入真实协议。
 */
const DEFAULT_MODEL_API_TYPE = 'OpenAI';
/** 模型协议可选项（顺序即优先级展示顺序） */
const MODEL_API_TYPE_OPTIONS: Array<{ value: string; labelKey: string }> = [
  { value: 'Responses', labelKey: 'llmConfig.apiTypeResponses' },
  { value: 'OpenAI', labelKey: 'llmConfig.apiTypeOpenAI' },
  { value: 'Anthropic', labelKey: 'llmConfig.apiTypeAnthropic' },
];
/** 首次设置（settings.json 为空）时的预置值 */
const DEFAULT_THINKING_EFFORT: ThinkingMode = 'high';
const DEFAULT_WEB_SEARCH = true;
const DEFAULT_AGENT_MODE: AgentMode = 'risk';
const DEFAULT_PROMPT_MODE: PromptMode = 'normal';

/** 生成一个全新的空 Provider 草稿 */
const createEmptyProviderDraft = (baseURL: string = ''): ProviderDraft => ({
  id: `provider_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
  baseURL,
  apiKey: '',
  models: [],
  defaultModel: '',
});

/**
 * 规范化协议值；非法值返回空串。
 *
 * 空串表示「尚未探测/未显式配置」——UI 上按默认协议展示，
 * 保存时不写入 modelConfigs，下次自动获取时会重新探测。
 */
const normalizeModelApiType = (value: unknown): string =>
  value === 'Responses' || value === 'Anthropic' || value === 'OpenAI' ? value : '';

/** 规范化扩展端回传的模型列表（去空、去重、trim） */
const normalizeModelList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    (raw as unknown[])
      .filter((m): m is string => typeof m === 'string' && !!m.trim())
      .map((m) => m.trim()),
  ));
};

/** 只保留合法的协议值（非法值返回空串 = 未探测） */
const sanitizeApiTypeMap = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [model, apiType] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeModelApiType(apiType);
    if (normalized) out[model] = normalized;
  }
  return out;
};

/**
 * 把自动获取到的模型合并进指定 provider 草稿：
 * - 已有模型的协议保持不变（不覆盖用户手动选择的结果）
 * - 新增模型使用探测结果；没有结果时留空（= 未探测，UI 显示默认协议）
 * - 默认模型若仍在列表中则保留，否则取第一个
 */
const mergeFetchedModels = (
  prev: ProviderDraft[],
  providerId: string,
  models: string[],
  detected: Record<string, string>,
): ProviderDraft[] => prev.map((p) => {
  if (p.id !== providerId) return p;
  const byName = new Map<string, ModelDraft>();
  for (const m of p.models) {
    const name = m.name.trim();
    if (!name) continue;
    byName.set(name, { name, apiType: m.apiType });
  }
  for (const name of models) {
    const detectedType = detected[name] || '';
    const existing = byName.get(name);
    if (!existing) {
      byName.set(name, { name, apiType: detectedType });
    } else if (!existing.apiType && detectedType) {
      // 已有但尚未配置协议的模型：补上探测结果
      byName.set(name, { ...existing, apiType: detectedType });
    }
  }
  const merged = Array.from(byName.values());
  const previousDefault = p.defaultModel.trim();
  const nextDefault = previousDefault && byName.has(previousDefault)
    ? previousDefault
    : (merged[0]?.name || '');
  return { ...p, models: merged, defaultModel: nextDefault };
});

/** 由 settings.json 的 models + modelConfigs 还原出模型草稿列表 */
const buildModelDrafts = (
  models: unknown,
  modelConfigs?: Record<string, { apiType?: string }> | null,
): ModelDraft[] => {
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const drafts: ModelDraft[] = [];
  for (const raw of models as unknown[]) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    drafts.push({ name, apiType: normalizeModelApiType(modelConfigs?.[name]?.apiType) });
  }
  return drafts;
};

/** 根据 baseURL 计算 provider key（如 https://opencode.ai/zen/go -> opencode.ai） */
const providerKeyOf = (baseURL: string): string => {
  const trimmed = baseURL.trim();
  return trimmed ? providerKeyFromBaseURL(trimmed) : '';
};

/** 设置分组容器：将相关项放在同一卡片内 */
const SectionGroup = ({
  title,
  children,
  colors,
}: {
  title: string;
  children: React.ReactNode;
  colors: Colors;
}) => {
  return (
    <div
      className="mb-4 rounded-lg border p-4"
      style={{ borderColor: colors.border, backgroundColor: 'transparent' }}
    >
      <div
        className="text-[11px] font-semibold uppercase tracking-wider mb-3"
        style={{ color: colors.textSystem }}
      >
        {title}
      </div>
      {children}
    </div>
  );
};

/** 输入框统一样式（跟随暗色/亮色主题） */
const getInputStyle = (colors: Colors, isDark: boolean): React.CSSProperties => ({
  width: '100%',
  padding: '8px 12px',
  borderRadius: '6px',
  border: `1px solid ${colors.border}`,
  backgroundColor: isDark ? '#2a2a30' : '#ffffff',
  color: colors.textPrimary,
  fontSize: '13px',
  outline: 'none',
  boxSizing: 'border-box',
});

/** 通用分段选择控件 */
const SegmentControl = <T extends string>({
  segments,
  value,
  onChange,
  colors,
}: {
  segments: { key: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  colors: Colors;
}) => {
  return (
    <div
      style={{
        display: 'flex',
        borderRadius: '6px',
        border: `1px solid ${colors.border}`,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {segments.map((seg, idx) => {
        const selected = value === seg.key;
        return (
          <button
            key={seg.key}
            type="button"
            onClick={() => onChange(seg.key)}
            style={{
              flex: 1,
              fontSize: '12px',
              padding: '6px 8px',
              border: 'none',
              borderLeft: idx > 0 ? `1px solid ${colors.border}` : 'none',
              backgroundColor: selected ? colors.harness : 'transparent',
              color: selected ? '#fff' : colors.textSystem,
              cursor: 'pointer',
              transition: 'all 0.15s',
              fontWeight: selected ? 600 : 400,
              whiteSpace: 'nowrap',
            }}
          >
            {seg.label}
          </button>
        );
      })}
    </div>
  );
};

const LLMConfigPanel: React.FC<LLMConfigPanelProps> = ({
  colors,
  initialBaseURL,
  initialWebSearch,
  initialThinkingEffort,
  initialDefaultAgentMode,
  initialDefaultPromptMode,
  initialApiKey,
  initialLanguage,
  initialShortcut,
  initialProviders,
  initialActiveProvider,
  initialMcpServers,
  currentSessionId,
  currentModel,
  onClose,
}) => {
  const [providers, setProviders] = useState<ProviderDraft[]>(() => {
    if (initialProviders && initialProviders.length > 0) {
      return initialProviders.map((p) => ({
        id: p.key || createEmptyProviderDraft().id,
        baseURL: p.baseURL || '',
        apiKey: p.apiKey || '',
        models: buildModelDrafts(p.models, p.modelConfigs),
        defaultModel: p.defaultModel || '',
      }));
    }
    return [{
      id: createEmptyProviderDraft().id,
      baseURL: initialBaseURL || DEFAULT_BASE_URL,
      apiKey: initialApiKey || '',
      models: [],
      defaultModel: '',
    }];
  });
  const [activeProviderKey, setActiveProviderKey] = useState<string>(initialActiveProvider || '');
  /** 用户点击「使用此 Provider」后暂存的 key，点击保存时才真正写入 settings.json */
  const [pendingUseProviderKey, setPendingUseProviderKey] = useState<string | null>(() => {
    // 首次配置也是“新增”场景：只有一个服务商且尚未有默认服务商时，默认选中它
    if (initialActiveProvider) return null;
    if (providers.length === 1) {
      return providerKeyOf(providers[0].baseURL) || null;
    }
    return null;
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    if (initialActiveProvider) {
      const match = providers.find((p) => p.id === initialActiveProvider);
      if (match) return match.id;
    }
    return providers[0]?.id ?? '';
  });
  const [webSearch, setWebSearch] = useState<boolean>(initialWebSearch ?? DEFAULT_WEB_SEARCH);
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingMode>(initialThinkingEffort || DEFAULT_THINKING_EFFORT);
  const [defaultAgentMode, setDefaultAgentMode] = useState<AgentMode>(initialDefaultAgentMode || DEFAULT_AGENT_MODE);
  const [defaultPromptMode, setDefaultPromptMode] = useState<PromptMode>(initialDefaultPromptMode || DEFAULT_PROMPT_MODE);
  const [language, setLanguage] = useState<'auto' | 'zh' | 'en'>(initialLanguage || 'auto');
  /** MCP 默认启用草稿（保存时把勾选项写回全局 settings.json 的 mcp.enabled） */
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>(initialMcpServers ?? []);
  /** 仅 Electron 桌面端提供“最小化到托盘 + 快捷键唤醒”设置 */
  const isElectron = getHostInfo().kind === 'electron';
  const initialShortcutNormalized = normalizeAccelerator(initialShortcut) || DEFAULT_WAKE_SHORTCUT;
  const [shortcut, setShortcut] = useState<string>(initialShortcutNormalized);
  const [shortcutRecording, setShortcutRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [baseURLError, setBaseURLError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  /** 正在自动获取模型的服务商草稿 ID */
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const pendingFetchProviderIdRef = useRef<string | null>(null);
  /** 模型列表已拉取、等待用户确认是否自动检测协议的暂存数据 */
  const [pendingDetection, setPendingDetection] = useState<{
    models: string[];
    modelApiTypes: Record<string, string>;
    needDetect: string[];
  } | null>(null);
  /** 对话空间管理 */
  const [conversationSpaces, setConversationSpaces] = useState<ConversationSpaceItem[] | null>(null);
  const [conversationSpacesLoading, setConversationSpacesLoading] = useState(false);
  const [conversationSpacesError, setConversationSpacesError] = useState<string | null>(null);
  const [confirmClearSpaceDirName, setConfirmClearSpaceDirName] = useState<string | null>(null);
  const [clearingSpaceDirName, setClearingSpaceDirName] = useState<string | null>(null);

  const activeProvider = providers.find((p) => p.id === activeTabId) || providers[0];

  // 当前 provider 的地址是否与列表内其它 provider 重复（按 provider key 判断，避免仅路径不同）
  const activeDuplicateKey = activeProvider
    ? (() => {
        const key = providerKeyOf(activeProvider.baseURL);
        if (!key) return '';
        const matches = providers.filter((p) => p.id !== activeProvider.id && providerKeyOf(p.baseURL) === key);
        return matches.length > 0 ? key : '';
      })()
    : '';
  // Base URL 校验：与既有 provider 重复时立即标红；空地址在保存时通过 baseURLError 提示
  const activeBaseURLError = (() => {
    if (activeDuplicateKey) return t('llmConfig.duplicateBaseUrl');
    return null;
  })() ?? baseURLError;

  // 未保存修改检测：与打开面板时的初始值比较
  const initialProvidersSnapshot = initialProviders && initialProviders.length > 0
    ? initialProviders.map((p) => ({
        baseURL: p.baseURL || '',
        apiKey: p.apiKey || '',
        models: buildModelDrafts(p.models, p.modelConfigs),
        defaultModel: p.defaultModel || '',
      }))
    : [{
        baseURL: initialBaseURL || DEFAULT_BASE_URL,
        apiKey: initialApiKey || '',
        models: [] as ModelDraft[],
        defaultModel: '',
      }];
  const providersChanged =
    providers.length !== initialProvidersSnapshot.length ||
    providers.some((p, i) => {
      const init = initialProvidersSnapshot[i];
      if (!init) return true;
      const currentModels = p.models.filter((m) => !!m.name.trim());
      const initModels = init.models.filter((m) => !!m.name.trim());
      return p.baseURL !== init.baseURL
        || p.apiKey !== init.apiKey
        || currentModels.length !== initModels.length
        || currentModels.some((m, idx) => m.name !== initModels[idx].name || m.apiType !== initModels[idx].apiType)
        || p.defaultModel !== init.defaultModel;
    });
  const isDirty =
    providersChanged ||
    activeProviderKey !== (initialActiveProvider || '') ||
    (pendingUseProviderKey !== null && pendingUseProviderKey !== (initialActiveProvider || '')) ||
    webSearch !== (initialWebSearch ?? DEFAULT_WEB_SEARCH) ||
    thinkingEffort !== (initialThinkingEffort || DEFAULT_THINKING_EFFORT) ||
    defaultAgentMode !== (initialDefaultAgentMode || DEFAULT_AGENT_MODE) ||
    defaultPromptMode !== (initialDefaultPromptMode || DEFAULT_PROMPT_MODE) ||
    language !== (initialLanguage || 'auto') ||
    (isElectron && shortcut !== initialShortcutNormalized);

  const updateProvider = (id: string, patch: Partial<ProviderDraft>) => {
    setProviders((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const handleBaseURLChange = (value: string) => {
    if (!activeProvider) return;
    const oldKey = providerKeyOf(activeProvider.baseURL);
    updateProvider(activeProvider.id, { baseURL: value });
    setBaseURLError(null);
    const newKey = providerKeyOf(value);
    if (pendingUseProviderKey && pendingUseProviderKey === oldKey) {
      setPendingUseProviderKey(newKey || null);
    }
    if (activeProviderKey && activeProviderKey === oldKey) {
      setActiveProviderKey(newKey || '');
    }
  };

  const handleApiKeyChange = (value: string) => {
    if (activeProvider) {
      updateProvider(activeProvider.id, { apiKey: value });
    }
    if (!value.trim()) {
      setApiKeyError(t('llmConfig.enterApiKey'));
    } else {
      setApiKeyError(null);
    }
  };

  const handleModelChange = (index: number, value: string) => {
    if (!activeProvider) return;
    const models = activeProvider.models.map((m, i) => (i === index ? { ...m, name: value } : m));
    updateProvider(activeProvider.id, { models });
    setModelError(null);
  };

  /** 修改单个模型的 API 协议 */
  const handleModelApiTypeChange = (index: number, apiType: string) => {
    if (!activeProvider) return;
    const models = activeProvider.models.map((m, i) => (i === index ? { ...m, apiType } : m));
    updateProvider(activeProvider.id, { models });
  };

  const handleAddModel = () => {
    if (!activeProvider) return;
    updateProvider(activeProvider.id, {
      models: [...activeProvider.models, { name: '', apiType: DEFAULT_MODEL_API_TYPE }],
    });
    setModelError(null);
  };

  const handleRemoveModel = (index: number) => {
    if (!activeProvider) return;
    updateProvider(activeProvider.id, {
      models: activeProvider.models.filter((_, i) => i !== index),
    });
    setModelError(null);
  };

  const handleSetDefaultModel = (model: string) => {
    if (!activeProvider || !model.trim()) return;
    updateProvider(activeProvider.id, { defaultModel: model.trim() });
  };

  /**
   * 收集草稿里「已显式配置协议」的模型，供扩展端跳过重复探测。
   * 未探测过的模型（apiType 为空串）不在此列，会在自动获取时被探测。
   */
  const knownApiTypesOf = (provider: ProviderDraft): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const m of provider.models) {
      const name = m.name.trim();
      if (name && m.apiType) map[name] = m.apiType;
    }
    return map;
  };

  const handleFetchModels = () => {
    if (!activeProvider) return;
    const baseURL = activeProvider.baseURL.trim();
    const apiKey = activeProvider.apiKey.trim();
    if (!baseURL || !apiKey) {
      setFetchModelsError(t('llmConfig.fetchModelsRequireUrlKey'));
      return;
    }
    setFetchingProviderId(activeProvider.id);
    pendingFetchProviderIdRef.current = activeProvider.id;
    setFetchModelsError(null);
    setModelError(null);
    postMessage({
      type: 'fetchProviderModels',
      baseURL,
      apiKey,
      // 已配置协议的模型：扩展端据此跳过重复探测
      knownApiTypes: knownApiTypesOf(activeProvider),
    });
  };

  /** 用户确认：对「未设置协议」的模型执行自动检测（可能消耗少量 token） */
  const handleConfirmDetectApiType = () => {
    const providerId = pendingFetchProviderIdRef.current;
    const pending = pendingDetection;
    if (!providerId || !pending) return;
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) return;
    setPendingDetection(null);
    // 保持 fetching 状态，按钮继续显示「获取中...」
    postMessage({
      type: 'detectProviderModelApiTypes',
      baseURL: provider.baseURL.trim(),
      apiKey: provider.apiKey.trim(),
      models: pending.needDetect,
      knownApiTypes: pending.modelApiTypes,
    });
  };

  /** 用户跳过检测：只把模型列表合并进来，协议留空（运行时回退到默认协议） */
  const handleSkipDetectApiType = () => {
    const providerId = pendingFetchProviderIdRef.current;
    const pending = pendingDetection;
    setPendingDetection(null);
    setFetchingProviderId(null);
    pendingFetchProviderIdRef.current = null;
    if (!providerId || !pending) return;
    setProviders((prev) => mergeFetchedModels(prev, providerId, pending.models, pending.modelApiTypes));
    setFetchModelsError(null);
    setModelError(null);
  };

  /** 从当前 provider 草稿生成要保存的 provider 列表（过滤未填写的 tab） */
  const buildProvidersPayload = () => {
    const payload: Array<{
      key: string;
      baseURL: string;
      apiKey: string;
      models: string[];
      modelApiTypes: Record<string, string>;
      defaultModel: string;
    }> = [];
    for (const p of providers) {
      const baseURL = p.baseURL.trim();
      const apiKey = p.apiKey.trim();
      if (!baseURL || !apiKey) continue;
      const key = providerKeyOf(baseURL);
      if (!key) continue;
      const models: string[] = [];
      const modelApiTypes: Record<string, string> = {};
      for (const m of p.models) {
        const name = m.name.trim();
        if (!name || models.includes(name)) continue;
        models.push(name);
        // 只有显式配置/探测出协议的模型才写入；未探测的留空，下次自动获取继续探测
        if (m.apiType) modelApiTypes[name] = m.apiType;
      }
      payload.push({ key, baseURL, apiKey, models, modelApiTypes, defaultModel: p.defaultModel.trim() });
    }
    return payload;
  };

  /** 发送保存消息（saveProviders 控制是否写 providers/activeProvider） */
  const postSaveMessage = (activeKey: string | null, closeAfterSave: boolean, saveProviders: boolean) => {
    const providerPayload = buildProvidersPayload();
    const resolvedActiveKey = activeKey && providerPayload.some((p) => p.key === activeKey)
      ? activeKey
      : (providerPayload[0]?.key || null);
    const targetProvider = resolvedActiveKey
      ? providerPayload.find((p) => p.key === resolvedActiveKey)
      : undefined;
    // 联网搜索设置只记录用户选择；非 Responses provider 仅在界面和实际请求中禁用，不修改该设置
    const configuredWebSearch = !!webSearch;
    // 预设值只在用户实际修改过时才发送；若与打开面板时的初始值相同，则不重复写入 settings.json
    const presetPayload: Record<string, unknown> = {};
    if (configuredWebSearch !== (initialWebSearch ?? DEFAULT_WEB_SEARCH)) {
      presetPayload.webSearch = configuredWebSearch;
    }
    if (thinkingEffort !== (initialThinkingEffort || DEFAULT_THINKING_EFFORT)) {
      presetPayload.thinkingEffort = thinkingEffort;
    }
    if (defaultAgentMode !== (initialDefaultAgentMode || DEFAULT_AGENT_MODE)) {
      presetPayload.defaultAgentMode = defaultAgentMode;
    }
    if (defaultPromptMode !== (initialDefaultPromptMode || DEFAULT_PROMPT_MODE)) {
      presetPayload.defaultPromptMode = defaultPromptMode;
    }
    if (language !== (initialLanguage || 'auto')) {
      presetPayload.language = language;
    }
    // MCP 默认启用列表：只在用户实际改动过时才发送，避免每次保存都覆盖
    const enabledNamesKey = (list: McpServerInfo[]): string =>
      list.filter((s) => s.enabled).map((s) => s.name).sort().join('\n');
    if (enabledNamesKey(mcpServers) !== enabledNamesKey(initialMcpServers ?? [])) {
      presetPayload.mcpServers = mcpServers.filter((s) => s.enabled).map((s) => s.name);
    }
    if (isElectron) {
      const normalizedShortcut = normalizeAccelerator(shortcut);
      // 快捷键始终随保存写入，保证 settings.json 中一定有记录（默认 Ctrl+Alt+X）
      if (normalizedShortcut) {
        presetPayload.shortcut = normalizedShortcut;
      }
    }
    postMessage({
      type: 'saveLLMConfig',
      // 只要需要保存 provider（有 provider 变更或显式选择了服务商），就写入完整 providers；
      // 不应要求用户必须点击「使用此服务商」才保存模型列表等修改。
      ...(saveProviders && providerPayload.length > 0
        ? {
            providers: providerPayload,
            activeProvider: resolvedActiveKey || '',
            ...(targetProvider
              ? {
                  baseURL: targetProvider.baseURL.trim() || DEFAULT_BASE_URL,
                  apiKey: targetProvider.apiKey.trim(),
                }
              : {}),
          }
        : {}),
      ...presetPayload,
      saveProviders,
      closeAfterSave,
      // 回传当前会话与模型，供扩展端在切换 provider 后校验模型是否仍被支持
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      ...(currentModel ? { currentModel } : {}),
    });
  };

  const handleUseProvider = (provider: ProviderDraft) => {
    const baseURL = provider.baseURL.trim();
    const apiKey = provider.apiKey.trim();
    if (!apiKey) {
      setApiKeyError(t('llmConfig.enterApiKey'));
      return;
    }
    if (!baseURL) {
      setApiKeyError(t('llmConfig.enterBaseUrl'));
      return;
    }
    const key = providerKeyOf(baseURL);
    if (!key) {
      setApiKeyError(t('llmConfig.invalidBaseUrl'));
      return;
    }
    // 设为当前使用前必须至少指定 1 个模型
    const hasModel = provider.models.some((m) => !!m.name.trim());
    if (!hasModel) {
      setModelError(t('llmConfig.atLeastOneModel'));
      return;
    }
    setApiKeyError(null);
    setModelError(null);
    setActiveTabId(provider.id);
    // 只暂存选择，不写 settings.json；等用户点击「保存」后一起写入
    setPendingUseProviderKey(key);
  };

  const handleSave = () => {
    const providerPayload = buildProvidersPayload();
    // 有 provider 变更，或用户显式选择了要使用的服务商时，都需要保存 provider 列表。
    const saveProviders = providersChanged || pendingUseProviderKey !== null;
    // 保存前校验地址：不允许为空，也不允许与其它服务商重复
    const duplicateKey = (() => {
      const seen = new Set<string>();
      for (const p of providers) {
        const key = providerKeyOf(p.baseURL);
        if (!key) continue;
        if (seen.has(key)) return key;
        seen.add(key);
      }
      return '';
    })();
    if (activeProvider && !activeProvider.baseURL.trim()) {
      setBaseURLError(t('llmConfig.enterBaseUrl'));
      setApiKeyError(null);
      setModelError(null);
      return;
    }
    if (duplicateKey) {
      setBaseURLError(t('llmConfig.duplicateBaseUrl'));
      setApiKeyError(null);
      setModelError(null);
      return;
    }
    setBaseURLError(null);
    // 保存前必须至少有一个可用的服务商，并且必须明确选择了要使用的服务商
    const activeKey = pendingUseProviderKey || activeProviderKey || null;
    if (providerPayload.length === 0 || !activeKey || !providerPayload.some((p) => p.key === activeKey)) {
      setApiKeyError(t('llmConfig.noProviderUsed'));
      setModelError(null);
      return;
    }
    if (saveProviders && pendingUseProviderKey && !providerPayload.some((p) => p.key === pendingUseProviderKey)) {
      setApiKeyError(t('llmConfig.enterApiKey'));
      return;
    }
    if (saveProviders && activeKey) {
      setActiveProviderKey(activeKey);
    }
    if (isElectron) {
      const normalizedShortcut = normalizeAccelerator(shortcut);
      if (!normalizedShortcut) {
        setShortcutError(t('llmConfig.shortcutInvalid'));
        return;
      }
      setShortcut(normalizedShortcut);
    }
    setSaving(true);
    postSaveMessage(activeKey, true, saveProviders);
  };

  /** 点击关闭/取消：有未保存修改时先询问是否放弃 */
  const handleRequestClose = () => {
    if (isDirty && !saving) {
      setShowDiscardConfirm(true);
      return;
    }
    onClose();
  };

  /** 放弃进行中的「自动获取 / 协议检测」状态（切换服务商、增删服务商时调用） */
  const resetFetchState = () => {
    setFetchingProviderId(null);
    pendingFetchProviderIdRef.current = null;
    setPendingDetection(null);
    setFetchModelsError(null);
  };

  const handleAddProvider = () => {
    // 新增服务商时不预填默认地址，避免与已有服务商重复；地址栏留空让用户填写
    const draft = createEmptyProviderDraft();
    const next = [...providers, draft];
    setProviders(next);
    setActiveTabId(draft.id);
    // 如果新增后该服务商是唯一的服务商，则将其设为默认
    if (next.length === 1) {
      setPendingUseProviderKey(providerKeyOf(draft.baseURL));
    }
    setApiKeyError(null);
    setBaseURLError(null);
    resetFetchState();
    setModelError(null);
  };

  const handleRemoveProvider = (id: string) => {
    const current = providers;
    if (current.length <= 1) {
      // 至少保留一个 tab，清空内容即可
      const empty = createEmptyProviderDraft();
      setProviders([empty]);
      setActiveTabId(empty.id);
      setActiveProviderKey('');
      setPendingUseProviderKey(null);
      setApiKeyError(null);
      setBaseURLError(null);
      resetFetchState();
      setModelError(null);
      return;
    }
    const removedIndex = current.findIndex((p) => p.id === id);
    const removed = current[removedIndex];
    const next = current.filter((p) => p.id !== id);
    setProviders(next);
    if (activeTabId === id) {
      const nextActive = next[Math.max(0, removedIndex - 1)] || next[0];
      setActiveTabId(nextActive?.id ?? '');
    }
    if (removed) {
      const removedKey = providerKeyOf(removed.baseURL);
      // 删除后若仍有其它草稿使用相同 key（重复项），保留原默认/待使用标记；
      // 只有该 key 完全不存在时才清除标记，避免删除重复项误删原 provider 的标记。
      const stillHasKey = removedKey && next.some((p) => providerKeyOf(p.baseURL) === removedKey);
      if (activeProviderKey && activeProviderKey === removedKey && !stillHasKey) {
        setActiveProviderKey('');
      }
      if (pendingUseProviderKey && pendingUseProviderKey === removedKey && !stillHasKey) {
        setPendingUseProviderKey(null);
      }
    }
    setApiKeyError(null);
    setBaseURLError(null);
    resetFetchState();
    setModelError(null);
  };

  // 监听 extension 的保存结果
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'llmConfigSaved') {
        setSaving(false);
        setPendingUseProviderKey(null);
        if (msg.activeProvider) {
          setActiveProviderKey(msg.activeProvider);
        }
        if ((msg as any).closeAfterSave) {
          onClose();
        }
      } else if (msg.type === 'llmConfigSaveError') {
        setSaving(false);
        setApiKeyError(msg.error || t('llmConfig.saveFailed'));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onClose]);

  // 监听自动获取模型的阶段一 / 阶段二结果
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;

      // 阶段一：模型列表已拉到，但存在未设置协议的模型 → 先请用户确认是否自动检测
      if (msg.type === 'providerModelsFetched') {
        const providerId = pendingFetchProviderIdRef.current;
        if (!providerId) return;
        const models = normalizeModelList(msg.models);
        if (models.length === 0) {
          setFetchingProviderId(null);
          pendingFetchProviderIdRef.current = null;
          setPendingDetection(null);
          setFetchModelsError(t('llmConfig.fetchModelsFailed'));
          return;
        }
        const known = sanitizeApiTypeMap(msg.modelApiTypes);
        const needDetect = normalizeModelList(msg.needDetect).filter((m) => models.includes(m));
        if (needDetect.length > 0) {
          // 保持 fetching 状态（按钮继续显示「获取中...」），等待用户确认
          setPendingDetection({ models, modelApiTypes: known, needDetect });
          return;
        }
        // 全部模型都已有协议：直接合并
        setFetchingProviderId(null);
        pendingFetchProviderIdRef.current = null;
        setProviders((prev) => mergeFetchedModels(prev, providerId, models, known));
        setFetchModelsError(null);
        setModelError(null);
        return;
      }

      // 阶段二：探测完成（或用户跳过后由扩展端直接返回）
      if (msg.type !== 'providerModelsResult') return;
      const providerId = pendingFetchProviderIdRef.current;
      if (!providerId) return;
      setFetchingProviderId(null);
      pendingFetchProviderIdRef.current = null;
      setPendingDetection(null);
      const models = normalizeModelList(msg.models);
      if (models.length > 0) {
        setProviders((prev) => mergeFetchedModels(prev, providerId, models, sanitizeApiTypeMap(msg.modelApiTypes)));
        setFetchModelsError(null);
        setModelError(null);
      } else {
        setFetchModelsError(t('llmConfig.fetchModelsFailed'));
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 监听对话空间统计/清空结果
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'conversationSpacesData') {
        setConversationSpaces(Array.isArray(msg.spaces) ? msg.spaces : []);
        setConversationSpacesLoading(false);
        setConversationSpacesError(null);
      } else if (msg.type === 'conversationSpacesError') {
        setConversationSpacesLoading(false);
        setClearingSpaceDirName(null);
        setConversationSpacesError(msg.error || t('llmConfig.conversationSpaceError'));
      } else if (msg.type === 'conversationSpaceCleared') {
        setClearingSpaceDirName(null);
        setConfirmClearSpaceDirName(null);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // 快捷键录制：点击后捕获下一次按键组合（Esc 取消）
  useEffect(() => {
    if (!shortcutRecording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setShortcutRecording(false);
        return;
      }
      const accelerator = acceleratorFromKeyboardEvent(event);
      if (!accelerator) return; // 只按了修饰键，继续等待
      setShortcut(accelerator);
      setShortcutError(null);
      setShortcutRecording(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [shortcutRecording]);

  // 设置面板打开期间临时注销全局快捷键，避免影响快捷键设置
  useEffect(() => {
    if (!isElectron) return;
    postMessage({ type: 'suspendWakeShortcut' });
    return () => {
      postMessage({ type: 'resumeWakeShortcut' });
    };
  }, [isElectron]);

  const isDark = colors.bg === '#1a1a1f';

  const inputStyle = getInputStyle(colors, isDark);

  /**
   * 联网搜索只有 Responses 协议支持：按当前 provider「默认模型」的协议判断。
   * 协议已下放到模型级，因此不能再按 provider 判断。
   */
  const defaultModelApiType = (() => {
    if (!activeProvider) return DEFAULT_MODEL_API_TYPE;
    const named = activeProvider.models.filter((m) => !!m.name.trim());
    const target = named.find((m) => m.name.trim() === activeProvider.defaultModel.trim()) || named[0];
    return target?.apiType || DEFAULT_MODEL_API_TYPE;
  })();
  const webSearchDisabled = defaultModelApiType !== 'Responses';

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  };

  const handleRefreshConversationSpaces = () => {
    setConversationSpacesLoading(true);
    setConversationSpacesError(null);
    postMessage({ type: 'requestConversationSpaces' });
  };

  const handleConfirmClearConversationSpace = () => {
    if (!confirmClearSpaceDirName) return;
    setClearingSpaceDirName(confirmClearSpaceDirName);
    setConfirmClearSpaceDirName(null);
    postMessage({ type: 'clearConversationSpace', dirName: confirmClearSpaceDirName });
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: colors.bg,
      }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 border-b flex items-center justify-between"
        style={{ borderColor: colors.border, backgroundColor: 'transparent' }}
      >
        <h1 className="text-[13px] font-semibold" style={{ color: colors.textPrimary }}>
          {t('llmConfig.title')}
        </h1>
        <button
          onClick={handleRequestClose}
          className="w-6 h-6 rounded flex items-center justify-center transition-colors hover:bg-white/10"
          style={{ color: colors.textSystem }}
          title={t('llmConfig.close')}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 px-4 py-4 overflow-y-auto" style={{ backgroundColor: 'transparent' }}>
        {/* ── 分组一：API 连接配置 ── */}
        <SectionGroup title={t('llmConfig.sectionConnection')} colors={colors}>
          {/* Provider tabs */}
          <div
            className="mb-3"
            style={{
              borderBottom: `1px solid ${colors.border}`,
              overflowX: 'auto',
              overflowY: 'hidden',
            }}
          >
            <div
              className="flex"
              style={{
                width: 'fit-content',
                border: `1px solid ${colors.border}`,
                borderBottom: 'none',
                borderRadius: '4px 4px 0 0',
              }}
            >
            {providers.map((p, idx) => {
              const key = providerKeyOf(p.baseURL);
              // 同一地址的后续草稿视为重复项：重复项不复用原 provider 的标题和默认标记
              const isDuplicateTab = !!key
                && providers.findIndex((candidate) => providerKeyOf(candidate.baseURL) === key) !== idx;
              const label = key && !isDuplicateTab ? key : t('llmConfig.newProvider');
              const isActiveTab = p.id === activeTabId;
              const isPendingUse = !!key && key === pendingUseProviderKey;
              const hasPendingUse = !!pendingUseProviderKey;
              // 同一 key 只在第一个草稿上显示默认/待使用标记，避免重复项继承标记
              const isDotTarget = !!key && !isDuplicateTab
                && (hasPendingUse ? isPendingUse : key === activeProviderKey);
              return (
                <div
                  key={p.id}
                  className="group flex items-center shrink-0"
                  style={{
                    borderLeft: idx > 0 ? `1px solid ${colors.border}` : 'none',
                    backgroundColor: isActiveTab ? (isDark ? 'rgba(99, 102, 241, 0.15)' : 'rgba(99, 102, 241, 0.08)') : 'transparent',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => { setActiveTabId(p.id); setApiKeyError(null); setBaseURLError(null); resetFetchState(); setModelError(null); }}
                    onDoubleClick={() => handleUseProvider(p)}
                    title={t('llmConfig.useThisProviderHint')}
                    style={{
                      padding: '8px 4px 8px 14px',
                      fontSize: '12px',
                      border: 'none',
                      background: 'transparent',
                      color: isActiveTab ? colors.textPrimary : colors.textSystem,
                      fontWeight: 400,
                      cursor: 'pointer',
                      outline: 'none',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      userSelect: 'none',
                      WebkitUserSelect: 'none',
                    }}
                  >
                    {isDotTarget && (
                      <span
                        title={isPendingUse
                          ? t('llmConfig.useThisProviderSelected')
                          : t('llmConfig.providerInUse')}
                        style={{ color: colors.harness, fontSize: '10px', lineHeight: 1 }}
                      >
                        ●
                      </span>
                    )}
                    <span>{label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveProvider(p.id)}
                    title={t('llmConfig.removeProvider')}
                    className={isActiveTab
                      ? 'opacity-50 hover:opacity-100 transition-opacity'
                      : 'opacity-0 group-hover:opacity-100 transition-opacity'}
                    style={{
                      padding: '8px 14px 8px 2px',
                      fontSize: '12px',
                      border: 'none',
                      background: 'transparent',
                      color: colors.textSystem,
                      cursor: 'pointer',
                      outline: 'none',
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              onClick={handleAddProvider}
              title={t('llmConfig.addProvider')}
              className="bg-transparent hover:bg-white/10 transition-colors shrink-0"
              style={{
                padding: '8px 12px',
                fontSize: '12px',
                border: 'none',
                borderLeft: providers.length > 0 ? `1px solid ${colors.border}` : 'none',
                color: colors.harness,
                cursor: 'pointer',
                outline: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              + {t('llmConfig.addProvider')}
            </button>
            </div>
          </div>

          {/* 服务商名称操作说明 */}
          <div className="text-[11px] mt-1 mb-3" style={{ color: colors.textSystem }}>
            <strong style={{ color: colors.textPrimary, fontWeight: 700 }}>{t('llmConfig.useThisProviderHintBold')}</strong>
            {t('llmConfig.useThisProviderHintRest')}
          </div>

          {activeProvider ? (
            <>
              {/* Base URL */}
              <div className="mb-4">
                <label
                  className="block text-[12px] font-medium mb-1.5"
                  style={{ color: colors.textSystem }}
                >
                  {t('llmConfig.baseUrlLabel')}
                </label>
                <input
                  type="text"
                  value={activeProvider.baseURL}
                  onChange={(e) => handleBaseURLChange(e.target.value)}
                  placeholder={t('llmConfig.baseUrlPlaceholder')}
                  style={{
                    ...inputStyle,
                    borderColor: activeBaseURLError ? '#ef4444' : colors.border,
                  }}
                  onFocus={(e) => { if (!activeBaseURLError) e.target.style.borderColor = colors.harness; }}
                  onBlur={(e) => { if (!activeBaseURLError) e.target.style.borderColor = colors.border; }}
                />
                {activeBaseURLError && (
                  <div className="text-[11px] mt-1" style={{ color: '#ef4444' }}>
                    {activeBaseURLError}
                  </div>
                )}
                <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
                  {t('llmConfig.baseUrlHint')}
                </div>
              </div>

              {/* API Key */}
              <div className="mb-4">
                <label
                  className="block text-[12px] font-medium mb-1.5"
                  style={{ color: colors.textSystem }}
                >
                  API Key
                </label>
                <input
                  type="password"
                  value={activeProvider.apiKey}
                  onChange={(e) => handleApiKeyChange(e.target.value)}
                  placeholder="sk-"
                  style={{
                    ...inputStyle,
                    borderColor: apiKeyError ? '#ef4444' : colors.border,
                  }}
                  onFocus={(e) => { if (!apiKeyError) e.target.style.borderColor = colors.harness; }}
                  onBlur={(e) => { if (!apiKeyError) e.target.style.borderColor = colors.border; }}
                />
                {apiKeyError && (
                  <div className="text-[11px] mt-1" style={{ color: '#ef4444' }}>
                    {apiKeyError}
                  </div>
                )}
                <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
                  {t('llmConfig.obtainKey')}
                </div>
              </div>

              {/* 模型列表 */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    className="block text-[12px] font-medium"
                    style={{ color: colors.textSystem }}
                  >
                    {t('llmConfig.modelsLabel')}
                  </label>
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={fetchingProviderId !== null || !activeProvider?.baseURL.trim() || !activeProvider?.apiKey.trim()}
                    style={{
                      padding: '5px 10px',
                      borderRadius: '6px',
                      border: `1px solid ${colors.harness}`,
                      backgroundColor: 'transparent',
                      color: colors.harness,
                      fontSize: '11px',
                      cursor: (fetchingProviderId !== null || !activeProvider?.baseURL.trim() || !activeProvider?.apiKey.trim()) ? 'not-allowed' : 'pointer',
                      opacity: (fetchingProviderId !== null || !activeProvider?.baseURL.trim() || !activeProvider?.apiKey.trim()) ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fetchingProviderId === activeProvider?.id
                      ? t('llmConfig.fetchModelsLoading')
                      : t('llmConfig.fetchModels')}
                  </button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      maxHeight: 220,
                      overflowY: 'auto',
                    }}
                  >
                    {activeProvider.models.map((model, index) => {
                      const modelName = model.name;
                      const isDefault = !!modelName.trim() && activeProvider.defaultModel === modelName.trim();
                      return (
                        <div
                          key={index}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                        >
                          {/* 模型名：宽度收窄，腾出位置给右侧的协议选择 */}
                          <div style={{ position: 'relative', flex: '1 1 150px', minWidth: 0 }}>
                            <input
                              type="text"
                              value={modelName}
                              onChange={(e) => handleModelChange(index, e.target.value)}
                              placeholder="model-id"
                              title={modelName}
                              style={{
                                ...inputStyle,
                                paddingRight: isDefault ? 52 : 12,
                              }}
                              onFocus={(e) => { e.target.style.borderColor = colors.harness; }}
                              onBlur={(e) => { e.target.style.borderColor = colors.border; }}
                            />
                            {isDefault && (
                              <span
                                className="text-[11px]"
                                style={{
                                  position: 'absolute',
                                  right: 8,
                                  top: '50%',
                                  transform: 'translateY(-50%)',
                                  color: colors.textSystem,
                                  pointerEvents: 'none',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {t('llmConfig.defaultModelSuffix')}
                              </span>
                            )}
                          </div>
                          {/* 该模型的 API 协议 */}
                          <select
                            value={model.apiType || DEFAULT_MODEL_API_TYPE}
                            onChange={(e) => handleModelApiTypeChange(index, e.target.value)}
                            title={t('llmConfig.modelApiTypeTitle')}
                            style={{
                              flexShrink: 0,
                              width: 116,
                              padding: '8px 6px',
                              borderRadius: '6px',
                              border: `1px solid ${colors.border}`,
                              backgroundColor: isDark ? '#2a2a30' : '#ffffff',
                              color: colors.textPrimary,
                              fontSize: '12px',
                              outline: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            {MODEL_API_TYPE_OPTIONS.map((opt) => (
                              <option
                                key={opt.value}
                                value={opt.value}
                                style={{
                                  backgroundColor: isDark ? '#2a2a30' : '#ffffff',
                                  color: colors.textPrimary,
                                }}
                              >
                                {t(opt.labelKey)}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleSetDefaultModel(modelName)}
                            disabled={!modelName.trim()}
                            title={t('llmConfig.setDefaultModel')}
                            style={{
                              flexShrink: 0,
                              padding: '6px 10px',
                              borderRadius: '6px',
                              border: `1px solid ${colors.border}`,
                              backgroundColor: 'transparent',
                              color: colors.textSystem,
                              fontSize: '11px',
                              cursor: !modelName.trim() ? 'not-allowed' : 'pointer',
                              opacity: !modelName.trim() ? 0.5 : 1,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('llmConfig.setDefaultModel')}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveModel(index)}
                            title={t('llmConfig.removeModel')}
                            style={{
                              flexShrink: 0,
                              padding: '6px 10px',
                              borderRadius: '6px',
                              border: `1px solid ${colors.border}`,
                              backgroundColor: 'transparent',
                              color: colors.textSystem,
                              fontSize: '11px',
                              cursor: 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {t('llmConfig.removeModel')}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={handleAddModel}
                    style={{
                      padding: '6px 10px',
                      fontSize: '12px',
                      borderRadius: '6px',
                      border: `1px dashed ${colors.border}`,
                      backgroundColor: 'transparent',
                      color: colors.harness,
                      cursor: 'pointer',
                    }}
                  >
                    + {t('llmConfig.addModel')}
                  </button>
                </div>
                {fetchModelsError && (
                  <div className="text-[11px] mt-1" style={{ color: '#ef4444' }}>
                    {fetchModelsError}
                  </div>
                )}
                {modelError && (
                  <div className="text-[11px] mt-1" style={{ color: '#ef4444' }}>
                    {modelError}
                  </div>
                )}
                <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
                  {!activeProvider?.baseURL.trim() || !activeProvider?.apiKey.trim()
                    ? t('llmConfig.fetchModelsRequireUrlKey')
                    : t('llmConfig.modelsHint')}
                </div>
              </div>

            </>
          ) : null}
        </SectionGroup>

        {/* ── 分组二：默认设置 ── */}
        <SectionGroup title={t('llmConfig.sectionDefaults')} colors={colors}>
          {/* 默认 Thinking Effort */}
          <div className="mb-4">
            <label
              className="block text-[12px] font-medium mb-1.5"
              style={{ color: colors.textSystem }}
            >
              {t('llmConfig.defaultThinkingEffortLabel')}
            </label>
            <SegmentControl
              segments={[
                { key: 'off' as const, label: t('inputArea.thinkingOff') },
                { key: 'low' as const, label: t('inputArea.thinkingLow') },
                { key: 'high' as const, label: t('inputArea.thinkingHigh') },
                { key: 'max' as const, label: t('inputArea.thinkingMax') },
              ]}
              value={thinkingEffort}
              onChange={setThinkingEffort}
              colors={colors}
            />
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {t('llmConfig.defaultThinkingEffortHint')}
            </div>
          </div>

          {/* 默认询问模式 */}
          <div className="mb-4">
            <label
              className="block text-[12px] font-medium mb-1.5"
              style={{ color: colors.textSystem }}
            >
              {t('llmConfig.defaultAskModeLabel')}
            </label>
            <SegmentControl
              segments={[
                { key: 'manual' as const, label: t('inputArea.askModeAlways') },
                { key: 'risk' as const, label: t('inputArea.askModeCritical') },
                { key: 'auto' as const, label: t('inputArea.askModeNever') },
              ]}
              value={defaultAgentMode}
              onChange={setDefaultAgentMode}
              colors={colors}
            />
            <div className="mt-1.5 flex flex-col gap-1 text-[11px]">
              {[
                { key: 'manual' as const, label: t('inputArea.askModeAlways'), desc: t('llmConfig.askModeAlwaysDesc') },
                { key: 'risk' as const, label: t('inputArea.askModeCritical'), desc: t('llmConfig.askModeCriticalDesc') },
                { key: 'auto' as const, label: t('inputArea.askModeNever'), desc: t('llmConfig.askModeNeverDesc') },
              ].map((m) => {
                const active = defaultAgentMode === m.key;
                return (
                  <div
                    key={m.key}
                    className="leading-snug"
                    style={{ color: active ? colors.harness : colors.textSystem }}
                  >
                    <span style={{ fontWeight: active ? 600 : 400 }}>{m.label}</span>
                    <span>{': ' + m.desc}</span>
                  </div>
                );
              })}
            </div>
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {t('llmConfig.defaultAskModeHint')}
            </div>
          </div>

          {/* 默认提示词模式 */}
          <div className="mb-4">
            <label
              className="block text-[12px] font-medium mb-1.5"
              style={{ color: colors.textSystem }}
            >
              {t('llmConfig.defaultPromptModeLabel')}
            </label>
            <SegmentControl
              segments={[
                { key: 'normal' as const, label: t('inputArea.promptModeNormal') },
                { key: 'minimal' as const, label: t('inputArea.promptModeMinimal') },
                { key: 'mixed' as const, label: t('inputArea.promptModeMixed') },
              ]}
              value={defaultPromptMode}
              onChange={setDefaultPromptMode}
              colors={colors}
            />
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {t('llmConfig.defaultPromptModeHint')}
            </div>
          </div>

          {/* Web Search */}
          <div style={{ opacity: webSearchDisabled ? 0.45 : 1 }}>
            <label
              className="flex items-center gap-2"
              style={{
                fontSize: '12px',
                color: colors.textSystem,
                cursor: webSearchDisabled ? 'not-allowed' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={webSearch}
                disabled={webSearchDisabled}
                onChange={(e) => setWebSearch(e.target.checked)}
                style={{ accentColor: colors.harness }}
              />
              {t('llmConfig.webSearchLabel')}
            </label>
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {webSearchDisabled
                ? t('llmConfig.webSearchDisabledHint')
                : t('llmConfig.webSearchHint')}
            </div>
          </div>

          {/* 默认启用的 MCP（写入全局 settings.json 的 mcp.enabled，作为新对话默认值） */}
          <div className="mt-4">
            <label
              className="block text-[12px] font-medium mb-1.5"
              style={{ color: colors.textSystem }}
            >
              {t('llmConfig.mcpLabel')}
            </label>
            {mcpServers.length > 0 ? (
              <div className="flex flex-col gap-1">
                {mcpServers.map((server) => (
                  <label
                    key={server.name}
                    className="flex items-center gap-2"
                    style={{ fontSize: '12px', color: colors.textSystem, cursor: 'pointer' }}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setMcpServers((prev) =>
                          prev.map((s) => (s.name === server.name ? { ...s, enabled: checked } : s)),
                        );
                      }}
                      style={{ accentColor: colors.harness }}
                    />
                    {server.name}
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-[11px]" style={{ color: colors.textSystem }}>
                {t('llmConfig.mcpEmpty')}
              </div>
            )}
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {t('llmConfig.mcpHint')}
            </div>
          </div>
        </SectionGroup>

        {/* ── 分组三：界面设置 ── */}
        <SectionGroup title={t('llmConfig.sectionInterface')} colors={colors}>
          {/* 界面语言 */}
          <div>
            <label
              className="block text-[12px] font-medium mb-1.5"
              style={{ color: colors.textSystem }}
            >
              {t('llmConfig.languageLabel')}
            </label>
            <SegmentControl
              segments={[
                { key: 'auto' as const, label: t('llmConfig.languageAuto') },
                { key: 'zh' as const, label: '中文' },
                { key: 'en' as const, label: 'English' },
              ]}
              value={language}
              onChange={setLanguage}
              colors={colors}
            />
            <div className="text-[11px] mt-1" style={{ color: colors.textSystem }}>
              {t('llmConfig.languageHint')}
            </div>
          </div>

          {/* 唤醒快捷键（仅 Electron） */}
          {isElectron && (
            <div className="mt-4">
              <label
                className="block text-[12px] font-medium mb-1.5"
                style={{ color: colors.textSystem }}
              >
                {t('llmConfig.shortcutLabel')}
              </label>
              <button
                type="button"
                onClick={() => {
                  setShortcutRecording(true);
                  setShortcutError(null);
                }}
                onBlur={() => setShortcutRecording(false)}
                style={{
                  ...inputStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderColor: shortcutRecording ? colors.harness : colors.border,
                }}
              >
                <span style={{ color: shortcutRecording ? colors.textSystem : colors.textPrimary }}>
                  {shortcutRecording
                    ? t('llmConfig.shortcutRecording')
                    : formatAcceleratorForDisplay(shortcut)}
                </span>
                <span style={{ color: colors.textSystem, fontSize: '11px', flexShrink: 0 }}>
                  {shortcutRecording ? '' : t('llmConfig.shortcutChange')}
                </span>
              </button>
              <div
                className="text-[11px] mt-1"
                style={{ color: shortcutError ? '#ef4444' : colors.textSystem }}
              >
                {shortcutError || t('llmConfig.shortcutHint')}
              </div>
            </div>
          )}
        </SectionGroup>

        {/* ── 分组四：对话空间管理 ── */}
        <SectionGroup title={t('llmConfig.sectionConversationSpace')} colors={colors}>
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="text-[11px] leading-snug" style={{ color: colors.textSystem }}>
              {t('llmConfig.conversationSpaceHint')}
            </div>
            <button
              type="button"
              onClick={handleRefreshConversationSpaces}
              disabled={conversationSpacesLoading}
              style={{
                flexShrink: 0,
                padding: '5px 10px',
                borderRadius: '6px',
                border: `1px solid ${colors.harness}`,
                backgroundColor: 'transparent',
                color: colors.harness,
                fontSize: '11px',
                cursor: conversationSpacesLoading ? 'not-allowed' : 'pointer',
                opacity: conversationSpacesLoading ? 0.6 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              {conversationSpacesLoading ? t('llmConfig.conversationSpaceLoading') : t('llmConfig.conversationSpaceStats')}
            </button>
          </div>

          {conversationSpacesError && (
            <div className="text-[11px] mb-2" style={{ color: '#ef4444' }}>
              {conversationSpacesError}
            </div>
          )}

          {conversationSpaces === null ? (
            <div className="text-[12px]" style={{ color: colors.textSystem }}>
              {t('llmConfig.conversationSpaceNoStats')}
            </div>
          ) : conversationSpaces.length === 0 ? (
            <div className="text-[12px]" style={{ color: colors.textSystem }}>
              {t('llmConfig.conversationSpaceEmpty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {conversationSpaces.map((space) => (
                <div
                  key={space.dirName}
                  style={{
                    border: `1px solid ${colors.border}`,
                    borderRadius: '6px',
                    padding: '8px 10px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      className="text-[12px] font-medium truncate"
                      style={{ color: colors.textPrimary }}
                      title={space.projectPath || space.dirName}
                    >
                      {space.projectPath || space.dirName}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: colors.textSystem }}>
                      {formatBytes(space.sizeBytes)}
                      {' · '}
                      {t('llmConfig.conversationSpaceFiles', { count: space.fileCount })}
                      {' · '}
                      {space.conversationCount} {t('llmConfig.conversationSpaceConversations')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConfirmClearSpaceDirName(space.dirName)}
                    disabled={clearingSpaceDirName !== null}
                    style={{
                      flexShrink: 0,
                      padding: '4px 10px',
                      borderRadius: '6px',
                      border: `1px solid ${clearingSpaceDirName === space.dirName ? colors.textSystem : '#ef4444'}`,
                      backgroundColor: 'transparent',
                      color: clearingSpaceDirName === space.dirName ? colors.textSystem : '#ef4444',
                      fontSize: '11px',
                      cursor: clearingSpaceDirName !== null ? 'not-allowed' : 'pointer',
                      opacity: clearingSpaceDirName !== null ? 0.6 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {clearingSpaceDirName === space.dirName
                      ? t('llmConfig.conversationSpaceClearing')
                      : t('llmConfig.conversationSpaceDelete')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </SectionGroup>
      </div>

      {/* Footer */}
      <div
        className="px-4 py-3 border-t flex items-center justify-end gap-2"
        style={{ borderColor: colors.border, backgroundColor: 'transparent' }}
      >
        <button
          onClick={handleRequestClose}
          className="px-4 py-1.5 rounded text-[13px] transition-colors"
          style={{
            backgroundColor: 'transparent',
            color: colors.textSystem,
            border: `1px solid ${colors.border}`,
          }}
        >
          {t('llmConfig.cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 rounded text-[13px] text-white transition-colors"
          style={{
            backgroundColor: saving ? colors.textSystem : colors.harness,
            opacity: saving ? 0.6 : 1,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? t('llmConfig.saving') : t('llmConfig.save')}
        </button>
      </div>

      {/* 自动检测 API 类型确认（模型列表已拉取，但存在未设置协议的模型） */}
      {pendingDetection && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
          }}
          // 点击遮罩等同于「跳过」：不做消耗 token 的检测
          onClick={handleSkipDetectApiType}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.bgSecondary,
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '16px',
              maxWidth: '340px',
              width: 'calc(100% - 32px)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
            }}
          >
            <div className="text-[13px] font-semibold mb-2" style={{ color: colors.textPrimary }}>
              {t('llmConfig.detectApiTypeTitle')}
            </div>
            <div className="text-[12px] mb-2 leading-snug" style={{ color: colors.textPrimary }}>
              {t('llmConfig.detectApiTypeConfirm', { count: pendingDetection.needDetect.length })}
            </div>
            <div className="text-[12px] mb-4 leading-snug" style={{ color: colors.textSystem }}>
              {t('llmConfig.detectApiTypeWarning')}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={handleSkipDetectApiType}
                className="px-3 py-1.5 rounded text-[12px] transition-colors"
                style={{
                  backgroundColor: 'transparent',
                  color: colors.textSystem,
                  border: `1px solid ${colors.border}`,
                }}
              >
                {t('llmConfig.detectApiTypeSkipBtn')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDetectApiType}
                className="px-3 py-1.5 rounded text-[12px] text-white transition-colors"
                style={{
                  backgroundColor: colors.harness,
                }}
              >
                {t('llmConfig.detectApiTypeConfirmBtn')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 放弃修改确认 */}
      {showDiscardConfirm && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
          }}
          onClick={() => setShowDiscardConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.bgSecondary,
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '16px',
              maxWidth: '300px',
              width: 'calc(100% - 32px)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
            }}
          >
            <div className="text-[13px] font-semibold mb-2" style={{ color: colors.textPrimary }}>
              {t('llmConfig.discardConfirmTitle')}
            </div>
            <div className="text-[12px] mb-4 leading-snug" style={{ color: colors.textSystem }}>
              {t('llmConfig.discardConfirmMessage')}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDiscardConfirm(false)}
                className="px-3 py-1.5 rounded text-[12px] transition-colors"
                style={{
                  backgroundColor: 'transparent',
                  color: colors.textSystem,
                  border: `1px solid ${colors.border}`,
                }}
              >
                {t('llmConfig.discardKeepEditing')}
              </button>
              <button
                onClick={() => {
                  setShowDiscardConfirm(false);
                  onClose();
                }}
                className="px-3 py-1.5 rounded text-[12px] text-white transition-colors"
                style={{
                  backgroundColor: colors.harness,
                }}
              >
                {t('llmConfig.discardChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 清空对话空间确认 */}
      {confirmClearSpaceDirName && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 210,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.45)',
          }}
          onClick={() => setConfirmClearSpaceDirName(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.bgSecondary,
              border: `1px solid ${colors.border}`,
              borderRadius: '8px',
              padding: '16px',
              maxWidth: '340px',
              width: 'calc(100% - 32px)',
              boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
            }}
          >
            <div className="text-[13px] font-semibold mb-2" style={{ color: colors.textPrimary }}>
              {t('llmConfig.conversationSpaceClearTitle')}
            </div>
            <div
              className="text-[12px] mb-4 leading-snug break-all"
              style={{ color: colors.textSystem, whiteSpace: 'pre-line' }}
            >
              {t('llmConfig.conversationSpaceClearMessage', {
                path: conversationSpaces?.find((s) => s.dirName === confirmClearSpaceDirName)?.projectPath || confirmClearSpaceDirName,
              })}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmClearSpaceDirName(null)}
                className="px-3 py-1.5 rounded text-[12px] transition-colors"
                style={{
                  backgroundColor: 'transparent',
                  color: colors.textSystem,
                  border: `1px solid ${colors.border}`,
                }}
              >
                {t('llmConfig.cancel')}
              </button>
              <button
                onClick={handleConfirmClearConversationSpace}
                className="px-3 py-1.5 rounded text-[12px] text-white transition-colors"
                style={{ backgroundColor: '#ef4444' }}
              >
                {t('llmConfig.conversationSpaceDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LLMConfigPanel;

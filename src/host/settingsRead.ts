/**
 * 宿主侧的配置读取与派生（**全部基于宿主自己的配置快照**）。
 *
 * 配置归宿主（`docs/core-ui-separation.md` 第 4 节）：`settings.json` 的读写、
 * 默认值补齐、模型注册表都在宿主侧，因此「面板要显示的默认值」「某个模型身份还
 * 能不能用」这类判断也在宿主侧完成，不向 Core 请求。
 *
 * 两种装配走同一条路径：宿主读自己的 `SettingsStore`，与 Core 的实现无关。
 * 这些函数都是纯函数（快照进、值出），便于单测与复用。
 */

import { logger } from '../core/Logger.js';
import type { AgentMode } from '../core/types.js';
import type { PromptPresetId } from '../core/prompt/PromptPreset.js';
import type { ModelRef } from '../core/llm/modelRef.js';
import { DEEPSEEK_BASE_URL } from '../core/endpoints.js';
import type { ApiType } from '../core/utils/modelConfig.js';
import type { ThinkingEffort, SettingsSnapshot } from '../core/settingsSnapshot.js';
import type { McpServerDefinition } from '../core/mcp/parse.js';
import type { McpServerInfo } from '../core/webviewTypes.js';

export { DEEPSEEK_BASE_URL };

/** 返回给设置面板的 provider 信息 */
export interface LLMProviderInfo {
  key: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
  /**
   * 各模型**已解析**的限值与协议（键为模型名）。
   *
   * 取自快照的 `provider.modelLimits`：注册表匹配与用户覆盖的合并由快照解析完成，
   * 面板只显示结果。面板不自己推断协议——「某个模型用什么协议」是宿主的事实
   * （`docs/webview-facts.md` 第 3 节）。
   */
  modelConfigs: Record<string, { context: number; output: number; apiType: ApiType }>;
}

/** 设置面板需要的完整 LLM 配置载荷 */
export interface LLMConfigPanelPayload {
  baseURL: string;
  webSearch: boolean;
  thinkingEffort: ThinkingEffort;
  defaultModel: string;
  defaultAgentMode: AgentMode;
  defaultPromptMode: PromptPresetId;
  apiKey: string;
  providers: LLMProviderInfo[];
  activeProvider: string;
}

/**
 * 设置面板的 MCP 默认列表：服务器定义（宿主快照里的 `mcp.json` 解析结果）
 * 合并全局默认启用列表（`settings.json` 的 `mcp.enabled`）。
 *
 * 与 Core 无关：两个输入都来自宿主自己的 `SettingsStore`
 * （`docs/core-ui-separation.md` 第 4 节）。
 */
export function readMcpServersForDefaults(
  snapshot: SettingsSnapshot,
  servers: readonly McpServerDefinition[],
): McpServerInfo[] {
  const enabled = new Set(snapshot.mcp.enabled);
  return servers.map((server) => ({ ...server, enabled: enabled.has(server.name) }));
}

/** 新对话的默认思考强度 */
export function readDefaultThinkingEffort(snapshot: SettingsSnapshot): ThinkingEffort {
  return snapshot.llm.thinkingEffort;
}

/** 新对话的默认询问模式（manual=总是 | risk=关键 | auto=从不） */
export function readDefaultAgentMode(snapshot: SettingsSnapshot): AgentMode {
  return snapshot.defaultAgentMode;
}

/** 新对话的默认提示词模式（normal | minimal | mixed） */
export function readDefaultPromptMode(snapshot: SettingsSnapshot): PromptPresetId {
  return snapshot.defaultPromptMode;
}

/** 新对话的默认 Web Search 开关 */
export function readDefaultWebSearch(snapshot: SettingsSnapshot): boolean {
  return snapshot.llm.webSearch;
}

/**
 * 当前 active provider 对应的模型身份（provider + 该 provider 的默认模型）。
 *
 * 这是「没有已保存模型时该用哪个模型」的唯一来源（新对话初始值 / 未记录 provider 的会话）。
 * 未配置 activeProvider 时返回 undefined，由调用方按「未配置」处理。
 */
export function readActiveModelRef(snapshot: SettingsSnapshot): ModelRef | undefined {
  const llm = snapshot.llm;
  const provider = llm.activeProvider ? llm.providers[llm.activeProvider] : undefined;
  if (!provider?.baseURL) return undefined;
  return { provider: llm.activeProvider, model: provider.defaultModel };
}

/** `settings.json` 中是否已设置 `llm.activeProvider`（新对话检测用：未设置时弹设置页） */
export function readHasActiveProviderSetting(snapshot: SettingsSnapshot): boolean {
  return !!snapshot.llm.activeProvider;
}

/**
 * 设置面板载荷：provider 列表 + 当前默认值。
 *
 * 只读快照，不触发任何写盘。设置面板只列可用的 provider（有 baseURL 的）。
 */
export function readLlmConfigPanelPayload(snapshot: SettingsSnapshot): LLMConfigPanelPayload {
  const llm = snapshot.llm;
  const activeProvider = llm.activeProvider;
  const active = activeProvider ? llm.providers[activeProvider] : undefined;

  const providers: LLMProviderInfo[] = Object.entries(llm.providers)
    .filter(([, provider]) => !!provider.baseURL)
    .map(([key, provider]) => ({
      key,
      baseURL: provider.baseURL,
      apiKey: provider.apiKey,
      models: provider.models,
      defaultModel: provider.defaultModel,
      // 只带面板需要的三项（thinkingTokenBudget 是 core 侧的运行时取值）
      modelConfigs: Object.fromEntries(
        Object.entries(provider.modelLimits).map(([model, limits]) => [
          model,
          { context: limits.context, output: limits.output, apiType: limits.apiType },
        ]),
      ),
    }));

  return {
    baseURL: active?.baseURL || DEEPSEEK_BASE_URL,
    apiKey: active?.apiKey || '',
    webSearch: llm.webSearch,
    thinkingEffort: llm.thinkingEffort,
    defaultModel: active?.defaultModel || '',
    defaultAgentMode: snapshot.defaultAgentMode,
    defaultPromptMode: snapshot.defaultPromptMode,
    providers,
    activeProvider,
  };
}

/**
 * 校验模型身份是否仍然有效，并在失效时解析出可用的身份。
 *
 * 这是「已保存数据 → 运行时模型身份」的唯一校验入口（切换会话 / 保存设置后调用）：
 * - `ref` 为 undefined（meta.json 未记录 provider）→ 取当前 active provider 的默认模型；
 * - provider 已从配置里移除 → 记日志，回退到 active provider 的默认模型；
 * - provider 存在但 model 不在其模型列表 → 用该 provider 的默认模型；
 * - provider 与 model 都合法 → 原样返回。
 *
 * 返回 undefined 表示「没有任何可用 provider」，调用方按「未配置」处理。
 */
export function resolveModelRef(
  snapshot: SettingsSnapshot,
  ref: ModelRef | undefined,
): ModelRef | undefined {
  const llm = snapshot.llm;
  const activeProvider = llm.providers[llm.activeProvider];
  const activeRef: ModelRef | undefined = activeProvider?.baseURL
    ? { provider: llm.activeProvider, model: activeProvider.defaultModel }
    : undefined;

  if (!ref) return activeRef;

  const provider = llm.providers[ref.provider];
  if (!provider?.baseURL) {
    logger.warn(
      'resolveModelRef',
      `provider "${ref.provider}" 已不存在，回退到 active provider "${llm.activeProvider || '(未配置)'}"`,
    );
    return activeRef;
  }
  if (provider.models.length === 0) {
    // 无法判断模型是否合法：保留 provider，模型为空时用该 provider 的默认模型
    return { provider: ref.provider, model: ref.model || provider.defaultModel };
  }
  if (ref.model && provider.models.includes(ref.model)) {
    return { provider: ref.provider, model: ref.model };
  }
  return { provider: ref.provider, model: provider.defaultModel || provider.models[0] };
}

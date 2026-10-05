import type { HandlerContext } from './handlerContext';
import { modelRefOf, sameModelRef } from '../../../core/llm/modelRef';
import { HostToWebviewWire } from '../../../host/webviewMessages';
import { profileLog } from '../../debug';
import { UiLanguage, setUiLanguage, t } from '../../i18n';
import { setUiFontSize, type UiFontSize } from '../../fontSize';
import { AgentMode, ApplyDefaultsPrompt, LlmConfigPanelPayload, PromptMode, ThinkingMode } from '../../types';
import type { SessionState } from '../../types';
import { postMessage } from '../../webviewEnv';
import { sameMcpEnabledList } from '../../../core/utils/mcpList';
import { missingPanelFields } from './shared';

/**
 * 当前会话的会话状态快照打补丁：live state 与 store 快照的会话配置字段必须
 * 成对更新（切换边界 `saveCurrentSessionSnapshot` 会从 live 值整体重建快照，
 * 这里补的是切换发生前的读取方——压缩 / 恢复等路径直接读 store）。
 */
function patchCurrentSessionState(
  props: HandlerContext['props'],
  patch: Partial<Pick<SessionState, 'modelRef' | 'agentMode' | 'promptMode' | 'thinkingMode' | 'webSearch'>>,
): void {
  const sid = props.currentSessionIdRef.current;
  if (!sid) return;
  const state = props.sessionStates.get(sid);
  if (!state) return;
  Object.assign(state, patch);
}

const profileTag = '[Profile]';

/**
 * webview 消息处理的 config 域 handler。
 *
 * 由 useMessageHandler 的 switch 转发：msg 是判别收窄后的 wire 消息，
 * ctx 是 hook 注入的共享上下文（props / 各 ref / 当前会话判定）。
 * handler 保持同步纯转发语义，不自行订阅事件。
 */
export function handleConfigSetTheme(
  msg: Extract<HostToWebviewWire, { type: 'setTheme' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          props.setTheme(msg.theme);
          props.setThemeInitialized(true);
          profileLog(`${profileTag} setTheme 收到 | 从挂载到收到=${(performance.now() - props._appMountTime.current!).toFixed(2)}ms`);
          return;
        // 对话列表渲染方运行期切换（Electron 悬浮窗：隐藏原生侧栏后列表改由顶栏渲染）。
        // App 订阅了 webviewEnv 的渲染方变化，这里只需写进 store。
}

export function handleConfigSetModel(
  msg: Extract<HostToWebviewWire, { type: 'setModel' }>,
  ctx: HandlerContext,
): void {
  const { props, fromCurrentSession } = ctx;
          const wire = msg;
          // 多端同步：wire 消息是扁平的 model / provider，这里组装成模型身份。
          // provider 缺失（空串非法）时忽略本次同步，避免只改一半造成漂移。
          const ref = modelRefOf(wire.provider, wire.model);
          if (fromCurrentSession && ref) {
            props.setModelRef(ref);
            patchCurrentSessionState(props, { modelRef: ref });
          }
          return;
}

export function handleConfigSetAgentMode(
  msg: Extract<HostToWebviewWire, { type: 'setAgentMode' }>,
  ctx: HandlerContext,
): void {
  const { props, fromCurrentSession } = ctx;
          const wire = msg;
          if (fromCurrentSession && wire.mode) {
            props.setAgentMode(wire.mode);
            patchCurrentSessionState(props, { agentMode: wire.mode });
          }
          return;
}

export function handleConfigSetPromptMode(
  msg: Extract<HostToWebviewWire, { type: 'setPromptMode' }>,
  ctx: HandlerContext,
): void {
  const { props, fromCurrentSession } = ctx;
          const wire = msg;
          if (fromCurrentSession && wire.mode) {
            props.setPromptMode(wire.mode);
            patchCurrentSessionState(props, { promptMode: wire.mode });
          }
          return;
}

export function handleConfigSetThinkingMode(
  msg: Extract<HostToWebviewWire, { type: 'setThinkingMode' }>,
  ctx: HandlerContext,
): void {
  const { props, fromCurrentSession } = ctx;
          const wire = msg;
          if (fromCurrentSession && wire.mode) {
            props.setThinkingMode(wire.mode);
            patchCurrentSessionState(props, { thinkingMode: wire.mode });
          }
          return;
}

export function handleConfigSetWebSearch(
  msg: Extract<HostToWebviewWire, { type: 'setWebSearch' }>,
  ctx: HandlerContext,
): void {
  const { props, fromCurrentSession } = ctx;
          const wire = msg;
          if (fromCurrentSession) {
            props.setWebSearch(!!wire.webSearch);
            patchCurrentSessionState(props, { webSearch: !!wire.webSearch });
          }
          return;
}

export function handleConfigSetMcpServers(
  msg: Extract<HostToWebviewWire, { type: 'setMcpServers' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          const wire = msg;
          // MCP 状态按会话区分：异步回推可能晚于会话切换，
          // 因此先写入该会话的缓存，只有属于当前会话时才更新可见状态。
          const targetSessionId = wire.sessionId as string | undefined;
          if (targetSessionId) {
            props.mcpServersBySessionRef.current.set(targetSessionId, msg.servers);
            if (targetSessionId !== props.currentSessionIdRef.current) return;
          }
          props.setMcpServers(msg.servers);
          return;
}

export function handleConfigSetModels(
  msg: Extract<HostToWebviewWire, { type: 'setModels' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
  // 全量 provider 分组列表（菜单三级子菜单数据源）；模型名与 provider 分开，不拼接。
  // providers 未到达时 App 保持 undefined（菜单显示等待项），这里只在合法应答时写入。
  if (Array.isArray(msg.providers)) {
    props.setProviderModels(msg.providers);
  }
}

export function handleConfigSetSkills(
  msg: Extract<HostToWebviewWire, { type: 'setSkills' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          props.setSkills(msg.skills);
}

export function handleConfigContextLimitUpdated(
  msg: Extract<HostToWebviewWire, { type: 'contextLimitUpdated' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          profileLog(`[TokenDebug] contextLimitUpdated: maxContextTokens=${msg.maxContextTokens}`);
          if (msg.maxContextTokens) {
            props.setMaxContextTokens(msg.maxContextTokens);
          } else {
            console.warn(`[TokenDebug] contextLimitUpdated: maxContextTokens is falsy, not setting`);
          }
}

export function handleConfigNotice(
  msg: Extract<HostToWebviewWire, { type: 'notice' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          props.pushNotice(msg.key, msg.params, msg.level);
}

export function handleConfigSettingsDefaults(
  msg: Extract<HostToWebviewWire, { type: 'settingsDefaults' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, messagesRef } = ctx;
          // 从扩展端接收 settings.json 中的默认值（model / thinkingMode / agentMode / promptMode），
          // 供新对话创建时一次性使用，避免先显示 manual 再跳变
          {
            const defaults = msg as { model?: string; provider?: string; thinkingMode?: 'off' | 'low' | 'high' | 'max'; agentMode?: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch?: boolean; language?: UiLanguage; fontSize?: UiFontSize; providerConfigured?: boolean };
            // wire 消息是扁平的 model / provider，这里组装成模型身份（provider 为空 → undefined = 未配置）
            const defaultsModelRef = modelRefOf(defaults.provider, defaults.model);
            profileLog(`[Webview] settingsDefaults received: model=${defaults.model}, provider=${defaults.provider}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, language=${defaults.language}, fontSize=${defaults.fontSize}, providerConfigured=${defaults.providerConfigured}`);
            props.setSettingsDefaults({
              modelRef: defaultsModelRef,
              thinkingMode: defaults.thinkingMode,
              agentMode: defaults.agentMode,
              // 不做 'normal' 兜底：未配置时保持 undefined，由调用方决定
              promptMode: defaults.promptMode,
              webSearch: defaults.webSearch,
            });
            // 会话配置已从宿主获取到：解除发送按钮禁用（复用 MCP 连接中的效果）
            props.setConfigReady(true);
            if (typeof defaults.providerConfigured === 'boolean') {
              props.setProviderConfigured(defaults.providerConfigured);
            }
            // onStartup（500ms 延迟）可能早于本消息执行，导致当前会话的
            // model / thinkingMode / promptMode 仍为空。此时若当前会话是尚未发送
            // 消息的新对话，则用 settings.json 默认值补齐，避免停留在空配置。
            if (messagesRef.current.length === 0) {
              const sid = props.currentSessionIdRef.current;
              const st = sid ? props.sessionStates.get(sid) : undefined;
              // 模型身份整体补齐（仅在尚未设置时）：provider + model 一起，避免只补一半造成漂移
              if (!propsRef.current.modelRef && defaultsModelRef) {
                props.setModelRef(defaultsModelRef);
                if (st) st.modelRef = defaultsModelRef;
              }
              if (!propsRef.current.thinkingMode && defaults.thinkingMode) {
                props.setThinkingMode(defaults.thinkingMode);
                if (st) st.thinkingMode = defaults.thinkingMode;
              }
              if (!propsRef.current.promptMode && defaults.promptMode) {
                props.setPromptMode(defaults.promptMode);
                if (st) st.promptMode = defaults.promptMode;
              }
              if (typeof defaults.webSearch === 'boolean') {
                props.setWebSearch(defaults.webSearch);
                if (st) st.webSearch = defaults.webSearch;
              }
            }
            // 注意：settingsDefaults 只代表“新对话默认值”，不代表当前会话已有的 agentMode，
            // 因此这里不直接切换 agentMode/退出 loading；等 conversationLoaded 或
            // setNewConversationDefaults 下发会话级具体值后再显示菜单。
            // 应用界面语言（与 HTML 注入的 __uiLocale 一致，仅在极少数不一致时触发重渲染）
            if (defaults.language === 'zh' || defaults.language === 'en' || defaults.language === 'auto') {
              const changed = setUiLanguage(defaults.language);
              if (changed) {
                props.setLocaleVersion((v) => v + 1);
              }
            }
            // 应用界面字号（与 HTML 注入的 __uiFontSize 一致，仅在极少数不一致时触发重渲染）
            if (defaults.fontSize === 'medium' || defaults.fontSize === 'large' || defaults.fontSize === 'xlarge') {
              setUiFontSize(defaults.fontSize);
            }
          }
}

export function handleConfigProviderModelsResult(
  _msg: Extract<HostToWebviewWire, { type: 'providerModelsResult' }>,
  _ctx: HandlerContext,
): void {
          // 由 LLMConfigPanel 内部监听处理，这里只需要避免 Unknown message 日志
}

export function handleConfigSetNewConversationDefaults(
  msg: Extract<HostToWebviewWire, { type: 'setNewConversationDefaults' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef } = ctx;
          // 从扩展端接收新对话的默认 model、thinkingMode、agentMode、promptMode 和 webSearch（来自 settings.json）
          {
            const defaults = msg as { sessionId: string; model: string; provider?: string; thinkingMode: 'off' | 'low' | 'high' | 'max'; agentMode?: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch?: boolean };
            profileLog(`[Webview] setNewConversationDefaults received: model=${defaults.model}, provider=${defaults.provider}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, currentSessionId=${props.currentSessionIdRef.current}`);
            // 会话级默认值已下发：解除发送按钮禁用
            props.setConfigReady(true);
            // 如果用户已经手动切换过模型，不要再用 settings.json 的默认模型覆盖用户选择。
            // settingsDefaults 尚未获取到（undefined）时不视为用户修改，正常应用默认模型。
            // wire 消息是扁平的 model / provider，组装成模型身份整体应用。
            const defaultsModelRef = modelRefOf(defaults.provider, defaults.model);
            const sdModelRef = propsRef.current.settingsDefaults.modelRef;
            const modelChangedByUser = sdModelRef !== undefined && !sameModelRef(sdModelRef, propsRef.current.modelRef);
            if (!modelChangedByUser) {
              props.setModelRef(defaultsModelRef);
            }
            props.setThinkingMode(defaults.thinkingMode);
            if (defaults.agentMode) {
              props.setAgentMode(defaults.agentMode);
            }
            if (defaults.promptMode === 'normal' || defaults.promptMode === 'minimal' || defaults.promptMode === 'mixed') {
              props.setPromptMode(defaults.promptMode);
            }
            if (typeof defaults.webSearch === 'boolean') {
              props.setWebSearch(defaults.webSearch);
            }
            // 同步更新 session state
            const curSid = props.currentSessionIdRef.current;
            if (curSid) {
              const state = props.sessionStates.get(curSid);
              if (state) {
                if (!modelChangedByUser) {
                  state.modelRef = defaultsModelRef;
                }
                state.thinkingMode = defaults.thinkingMode;
                if (defaults.agentMode) {
                  state.agentMode = defaults.agentMode;
                }
                if (defaults.promptMode === 'normal' || defaults.promptMode === 'minimal' || defaults.promptMode === 'mixed') {
                  state.promptMode = defaults.promptMode;
                }
                if (typeof defaults.webSearch === 'boolean') {
                  state.webSearch = defaults.webSearch;
                }
              }
            }
            // 回传诊断日志到扩展端，确认 webview 已应用默认值
            postMessage({ type: 'debugLog', message: `[webview] setNewConversationDefaults APPLIED: model=${defaults.model}, thinking=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, webSearch=${defaults.webSearch}` });
          }
}

/** 默认配置项在确认对话框里的本地化显示值（'—' = 未知 / 未到达） */
function promptModeText(mode: PromptMode | undefined): string {
  if (mode === 'normal') return t('inputArea.promptModeNormal');
  if (mode === 'minimal') return t('inputArea.promptModeMinimal');
  if (mode === 'mixed') return t('inputArea.promptModeMixed');
  return '—';
}

function agentModeText(mode: AgentMode | undefined): string {
  if (mode === 'manual') return t('inputArea.askModeAlways');
  if (mode === 'risk') return t('inputArea.askModeCritical');
  if (mode === 'auto') return t('inputArea.askModeNever');
  return '—';
}

function thinkingModeText(mode: ThinkingMode | undefined): string {
  if (mode === 'off') return t('inputArea.thinkingOff');
  if (mode === 'low') return t('inputArea.thinkingLow');
  if (mode === 'high') return t('inputArea.thinkingHigh');
  if (mode === 'max') return t('inputArea.thinkingMax');
  return '—';
}

function webSearchText(value: boolean | undefined): string {
  if (value === undefined) return '—';
  return value ? t('applyDefaults.on') : t('applyDefaults.off');
}

/** MCP 启用列表在确认对话框里的显示值（空列表 = 全部禁用） */
function mcpListText(names: readonly string[]): string {
  return names.length > 0 ? names.join(', ') : t('applyDefaults.mcpNone');
}

/** 两个启用列表是否等价：收敛在 core 的 sameMcpEnabledList（顺序无关，唯一实现） */
function sameMcpList(a: readonly string[], b: readonly string[]): boolean {
  return sameMcpEnabledList(a, b);
}

export function handleConfigLlmConfigSaved(
  msg: Extract<HostToWebviewWire, { type: 'llmConfigSaved' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef } = ctx;
  // 保存成功即说明至少有一个可用的服务商
  props.setProviderConfigured(true);
  // 配置已可用：解除发送按钮禁用
  props.setConfigReady(true);

  const prevProps = propsRef.current;
  const prevDefaults = prevProps.settingsDefaults;
  const prevModelRef = prevDefaults.modelRef;
  const currentSessionId = props.currentSessionIdRef.current;
  const sessionState = currentSessionId ? props.sessionStates.get(currentSessionId) : undefined;

  // 宿主解析出的当前对话可用模型（provider / 模型失效时的回退）：与「默认配置是否应用」
  // 无关，必须立即生效，避免当前对话保留不可用模型。
  const activeModelRef = modelRefOf(msg.activeModelProvider, msg.activeModel);
  if (activeModelRef) {
    props.setModelRef(activeModelRef);
    if (sessionState) sessionState.modelRef = activeModelRef;
  }
  // 当前对话实际生效的模型身份：优先用宿主刚解析的 activeModel，否则用本地值。
  const currentModelRef = activeModelRef ?? prevProps.modelRef;

  // 逐项对比「新默认值」与「保存前的默认值 / 当前对话的值」：只有「相对保存前有变化」
  // 且「与当前对话不一致」时才需要询问是否应用到当前对话；只影响新对话的变化不进对话框。
  const pending: ApplyDefaultsPrompt = { changes: [] };
  const savedProvider = msg.defaultModelProvider;
  const savedModel = msg.defaultModel;

  if (savedProvider && savedProvider !== prevModelRef?.provider && savedProvider !== currentModelRef?.provider) {
    // 默认服务商变化，且当前对话用的是另一个服务商 → 询问是否切换
    const nextModelRef = modelRefOf(savedProvider, savedModel);
    if (nextModelRef) {
      pending.changes.push({
        label: t('applyDefaults.changeProvider'),
        from: currentModelRef?.provider ?? '—',
        to: savedProvider,
      });
      pending.modelRef = nextModelRef;
    }
  } else if (
    // 当前对话所用服务商的默认模型变化，且与当前对话所用模型不一致 → 询问是否切换。
    // 「当前对话所用服务商」可能是非默认服务商，其默认模型变化只有宿主知道
    // （webview 只有默认服务商的默认模型），故用宿主回传的
    // currentProviderDefaultModel / currentProviderDefaultModelChanged 判断。
    msg.currentProviderDefaultModelChanged
    && !!msg.currentProviderDefaultModel
    && !!currentModelRef?.provider
    && msg.currentProviderDefaultModel !== currentModelRef.model
  ) {
    const nextModelRef = modelRefOf(currentModelRef.provider, msg.currentProviderDefaultModel);
    if (nextModelRef) {
      pending.changes.push({
        label: t('applyDefaults.changeModel'),
        from: currentModelRef.model,
        to: msg.currentProviderDefaultModel,
      });
      pending.modelRef = nextModelRef;
    }
  }

  // 「当前对话的值」未到达（undefined = 等待态）的项不进确认框：undefined 不是值，
  // 拿它比较会把「还没收到」误判成「与默认值不同」（第 12.7 节：webview 不猜值）
  if (msg.defaultPromptMode && msg.defaultPromptMode !== prevDefaults.promptMode && prevProps.promptMode !== undefined && msg.defaultPromptMode !== prevProps.promptMode) {
    pending.changes.push({
      label: t('applyDefaults.changePromptMode'),
      from: promptModeText(prevProps.promptMode),
      to: promptModeText(msg.defaultPromptMode),
    });
    pending.promptMode = msg.defaultPromptMode;
  }
  if (msg.thinkingEffort && msg.thinkingEffort !== prevDefaults.thinkingMode && prevProps.thinkingMode !== undefined && msg.thinkingEffort !== prevProps.thinkingMode) {
    pending.changes.push({
      label: t('applyDefaults.changeThinkingEffort'),
      from: thinkingModeText(prevProps.thinkingMode),
      to: thinkingModeText(msg.thinkingEffort),
    });
    pending.thinkingMode = msg.thinkingEffort;
  }
  if (msg.defaultAgentMode && msg.defaultAgentMode !== prevDefaults.agentMode && prevProps.agentMode !== undefined && msg.defaultAgentMode !== prevProps.agentMode) {
    pending.changes.push({
      label: t('applyDefaults.changeAgentMode'),
      from: agentModeText(prevProps.agentMode),
      to: agentModeText(msg.defaultAgentMode),
    });
    pending.agentMode = msg.defaultAgentMode;
  }
  if (typeof msg.webSearch === 'boolean' && msg.webSearch !== prevDefaults.webSearch && prevProps.webSearch !== undefined && msg.webSearch !== prevProps.webSearch) {
    pending.changes.push({
      label: t('applyDefaults.changeWebSearch'),
      from: webSearchText(prevProps.webSearch),
      to: webSearchText(msg.webSearch),
    });
    pending.webSearch = msg.webSearch;
  }
  // 宿主未能把当前对话钉在保存前的 MCP 列表上（钉住失败不阻断保存，见
  // `docs/webview-facts.md` 第 6 节）：没有可靠的「当前对话的值」，不弹确认框，
  // 改为一次提示——该对话可能已跟随新的默认值。
  if (msg.mcpPinFailed) {
    props.pushNotice('notice.mcp.pinFailed', {}, 'warn');
  }
  // MCP 全局默认启用列表：宿主在写盘前已把当前对话钉在保存前的列表上，因此
  // currentSessionMcpEnabled 就是「当前对话的值」。只有默认值确实变了、且与当前
  // 对话不一致时才问；顺序无关（两侧列表顺序不保证一致）。
  if (
    msg.mcpDefaultEnabledChanged
    && Array.isArray(msg.mcpDefaultEnabled)
    && Array.isArray(msg.currentSessionMcpEnabled)
    && !sameMcpList(msg.mcpDefaultEnabled, msg.currentSessionMcpEnabled)
  ) {
    pending.changes.push({
      label: t('applyDefaults.changeMcp'),
      from: mcpListText(msg.currentSessionMcpEnabled),
      to: mcpListText(msg.mcpDefaultEnabled),
    });
    pending.mcpEnabled = [...msg.mcpDefaultEnabled];
  }

  // 更新本地默认值（新对话用），与「是否应用到当前对话」无关，始终生效。
  if (msg.defaultModel || msg.thinkingEffort || msg.defaultAgentMode || msg.defaultPromptMode || typeof msg.webSearch === 'boolean') {
    // wire 消息是扁平的 defaultModel / defaultModelProvider，组装成模型身份整体更新
    const nextDefaultModelRef = modelRefOf(msg.defaultModelProvider, msg.defaultModel) ?? prevDefaults.modelRef;
    props.setSettingsDefaults(prev => ({
      modelRef: nextDefaultModelRef,
      thinkingMode: msg.thinkingEffort || prev.thinkingMode,
      agentMode: msg.defaultAgentMode || prev.agentMode,
      promptMode: msg.defaultPromptMode || prev.promptMode,
      webSearch: typeof msg.webSearch === 'boolean' ? msg.webSearch : prev.webSearch,
    }));
  }

  // 有需要应用到当前对话的变化：交给 App 弹确认对话框，用户确认后再改当前对话，
  // 不静默覆盖用户在当前对话里的选择（`docs/core-ui-separation.md` 第 4 节）。
  if (pending.changes.length > 0) {
    props.setApplyDefaultsPrompt(pending);
  }

  // 应用界面语言：变更时递增 localeVersion 重挂载内容区，所有文案立即按新语言渲染
  if (msg.language === 'zh' || msg.language === 'en' || msg.language === 'auto') {
    const changed = setUiLanguage(msg.language);
    if (changed) {
      props.setLocaleVersion((v) => v + 1);
    }
  }
  // 应用界面字号：写根元素 CSS 变量（`ui-fs-*` 即时生效）并通知 antd token 消费方重渲染
  if (msg.fontSize === 'medium' || msg.fontSize === 'large' || msg.fontSize === 'xlarge') {
    setUiFontSize(msg.fontSize);
  }
}

export function handleConfigShowLLMConfig(
  msg: Extract<HostToWebviewWire, { type: 'showLLMConfig' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          // 显示 LLM 配置面板（启动时 apiKey 为空或用户点击设置时触发）。
          // 面板载荷由宿主一次给齐，webview 不补默认值（`docs/webview-facts.md` 第 6 节）；
          // 载荷字段缺失即协议错误，这里逐字段校验后组装，缺字段时不打开面板。
          const raw = msg as Record<string, any>;
          const rawProviders = raw.providers;
          const payload: LlmConfigPanelPayload = {
            baseURL: String(raw.baseURL ?? ''),
            webSearch: !!raw.webSearch,
            thinkingEffort: raw.thinkingEffort,
            defaultAgentMode: raw.defaultAgentMode,
            defaultPromptMode: raw.defaultPromptMode,
            apiKey: String(raw.apiKey ?? ''),
            language: raw.language,
            fontSize: raw.fontSize,
            activeProvider: String(raw.activeProvider ?? ''),
            providers: Array.isArray(rawProviders)
              ? rawProviders.map((p: any) => ({
                  key: String(p?.key || ''),
                  baseURL: String(p?.baseURL || ''),
                  apiKey: String(p?.apiKey || ''),
                  models: Array.isArray(p?.models)
                    ? (p.models as unknown[])
                        .filter((m): m is string => typeof m === 'string' && !!m.trim())
                        .map((m) => m.trim())
                    : [],
                  defaultModel: String(p?.defaultModel || ''),
                  // apiType 已下放到模型级：随 modelConfigs 一起回传
                  modelConfigs: (p?.modelConfigs && typeof p.modelConfigs === 'object' && !Array.isArray(p.modelConfigs))
                    ? p.modelConfigs
                    : {},
                }))
              : [],
            mcpServers: Array.isArray(raw.mcpServers)
              ? raw.mcpServers.map((s: any) => ({
                  name: String(s?.name || ''),
                  type: String(s?.type || 'local'),
                  command: Array.isArray(s?.command) ? (s.command as unknown[]).filter((c): c is string => typeof c === 'string') : [],
                  environment: (s?.environment && typeof s.environment === 'object' && !Array.isArray(s.environment)) ? s.environment as Record<string, string> : {},
                  url: typeof s?.url === 'string' ? s.url : '',
                  headers: (s?.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) ? s.headers as Record<string, string> : {},
                  enabled: !!s?.enabled,
                })).filter((s) => !!s.name)
              : [],
          };
          const problems = missingPanelFields(payload);
          if (problems.length > 0) {
            // 载荷不完整：不打开面板（避免用空值把用户误导去重配），记一条日志
            console.warn(`[Webview] showLLMConfig 载荷字段缺失：${problems.join(', ')}`);
            return;
          }
          props.setProviderConfigured(!!payload.activeProvider && !!payload.apiKey);
          props.setLlmConfigPayload(payload);
          return;
}

export function handleConfigBalanceUpdate(
  msg: Extract<HostToWebviewWire, { type: 'balanceUpdate' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          const wire = msg;
          // 更新全局余额信息（与会话无关）；获取失败时消息字段为 null，此时清空余额隐藏显示
          {
            const totalBalance = wire.totalBalance;
            const currency = wire.currency;
            const unlimited = wire.isUnlimited;
            props.setBalance(typeof totalBalance === 'number' ? totalBalance : undefined);
            props.setBalanceCurrency(typeof currency === 'string' ? currency : undefined);
            props.setIsUnlimited(typeof unlimited === 'boolean' ? unlimited : undefined);
          }
          return;
}

export function handleConfigFocusInput(
  msg: Extract<HostToWebviewWire, { type: 'focusInput' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef } = ctx;
          // 全局唤醒快捷键把窗口唤到前台后，聚焦输入框，用户可直接开始输入。
          // 等待一帧：窗口刚显示时 DOM 焦点可能还在同步中，立即 focus 会被覆盖。
          const focus = () => {
            if (propsRef.current.userChoiceRequest) {
              props.choiceInputRef.current?.focus();
            } else {
              props.mainInputRef.current?.focus();
            }
          };
          requestAnimationFrame(() => {
            focus();
            // 兜底再补一次，覆盖窗口从托盘恢复时的焦点竞争
            setTimeout(focus, 50);
          });
          return;
}

export function handleConfigActivatePrewarmedView(
  _msg: Extract<HostToWebviewWire, { type: 'activatePrewarmedView' }>,
  _ctx: HandlerContext,
): void {
          // 预热视图的启动初始化由 App.tsx 自己的监听处理（需要 onStartup 等组件级能力），
          // 这里只做登记，避免落到 default 分支打「未知消息类型」告警。
}

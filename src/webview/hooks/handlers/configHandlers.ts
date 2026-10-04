import type { HandlerContext } from './handlerContext';
import { modelRefOf, sameModelRef } from '../../../core/llm/modelRef';
import { HostToWebviewWire } from '../../../host/webviewMessages';
import { profileLog } from '../../debug';
import { UiLanguage, setUiLanguage } from '../../i18n';
import { setUiFontSize, type UiFontSize } from '../../fontSize';
import { LlmConfigPanelPayload, PromptMode } from '../../types';
import { postMessage } from '../../webviewEnv';
import { missingPanelFields } from './shared';

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

export function handleConfigLlmConfigSaved(
  msg: Extract<HostToWebviewWire, { type: 'llmConfigSaved' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, messagesRef } = ctx;
          // LLM 配置保存成功：更新本地默认值。
          // 如果当前对话是未发送消息的新对话，则模型/提示词模式等默认值也立刻生效；
          // 工作模式/思考强度/联网搜索保持原有“保存后应用到当前对话”的行为。
          {
            const saved = msg as { defaultModel?: string; defaultModelProvider?: string; activeModel?: string; activeModelProvider?: string; thinkingEffort?: 'off' | 'low' | 'high' | 'max'; defaultAgentMode?: 'manual' | 'risk' | 'auto'; defaultPromptMode?: PromptMode; webSearch?: boolean };
            // 保存成功即说明至少有一个可用的服务商
            props.setProviderConfigured(true);
            // 配置已可用：解除发送按钮禁用
            props.setConfigReady(true);
            if (saved.defaultModel || saved.thinkingEffort || saved.defaultAgentMode || saved.defaultPromptMode || typeof saved.webSearch === 'boolean') {
              // wire 消息是扁平的 defaultModel / defaultModelProvider，组装成模型身份整体更新
              const nextDefaultModelRef = modelRefOf(saved.defaultModelProvider, saved.defaultModel) ?? propsRef.current.settingsDefaults.modelRef;
              props.setSettingsDefaults(prev => ({
                modelRef: nextDefaultModelRef,
                thinkingMode: saved.thinkingEffort || prev.thinkingMode,
                agentMode: saved.defaultAgentMode || prev.agentMode,
                promptMode: saved.defaultPromptMode || prev.promptMode,
                webSearch: typeof saved.webSearch === 'boolean' ? saved.webSearch : prev.webSearch,
              }));
            }
            // 默认工作模式 / 思考强度 / 联网搜索保持原有行为：保存后应用到当前对话
            if (saved.defaultAgentMode) {
              props.setAgentMode(saved.defaultAgentMode);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStates.get(curSid);
                if (state) {
                  state.agentMode = saved.defaultAgentMode;
                }
              }
            }
            if (saved.thinkingEffort) {
              props.setThinkingMode(saved.thinkingEffort);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStates.get(curSid);
                if (state) {
                  state.thinkingMode = saved.thinkingEffort;
                }
              }
            }
            if (typeof saved.webSearch === 'boolean') {
              props.setWebSearch(saved.webSearch);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStates.get(curSid);
                if (state) {
                  state.webSearch = saved.webSearch;
                }
              }
            }
            // 切换 provider 后，扩展端会返回当前对话应使用的模型 activeModel
            // （已校验是否属于新 provider 的模型列表，不在列表中则回退到 provider 默认模型）。
            // 该值对已有消息的对话同样生效，避免当前对话保留新 provider 不支持的模型。
            const curSid = props.currentSessionIdRef.current;
            const state = curSid ? props.sessionStates.get(curSid) : undefined;
            // wire 消息是扁平字段（activeModel/activeModelProvider 等），组装成模型身份整体更新
            const activeModelRef = modelRefOf(saved.activeModelProvider, saved.activeModel);
            if (activeModelRef) {
              props.setModelRef(activeModelRef);
              if (state) state.modelRef = activeModelRef;
            }
            // 当前对话是未发送消息的新对话时，模型与提示词模式也立即使用新默认值
            if (messagesRef.current.length === 0) {
              const defaultModelRef = modelRefOf(saved.defaultModelProvider, saved.defaultModel);
              if (!activeModelRef && defaultModelRef) {
                props.setModelRef(defaultModelRef);
                if (state) state.modelRef = defaultModelRef;
              }
              if (saved.defaultPromptMode) {
                props.setPromptMode(saved.defaultPromptMode);
                if (state) state.promptMode = saved.defaultPromptMode;
              }
            }
            // 应用界面语言：变更时递增 localeVersion 重挂载内容区，所有文案立即按新语言渲染
            const savedLanguage = (saved as { language?: UiLanguage }).language;
            if (savedLanguage === 'zh' || savedLanguage === 'en' || savedLanguage === 'auto') {
              const changed = setUiLanguage(savedLanguage);
              if (changed) {
                props.setLocaleVersion((v) => v + 1);
              }
            }
            // 应用界面字号：写根元素 CSS 变量（`ui-fs-*` 即时生效）并通知 antd token 消费方重渲染
            const savedFontSize = (saved as { fontSize?: UiFontSize }).fontSize;
            if (savedFontSize === 'medium' || savedFontSize === 'large' || savedFontSize === 'xlarge') {
              setUiFontSize(savedFontSize);
            }
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

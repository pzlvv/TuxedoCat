import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Icon } from './Icon';
import 'github-markdown-css/github-markdown.css';
import { Dropdown } from 'antd';
import InputArea, { InputAreaRef } from './InputArea';
import MessagesView from './MessagesView';
import 'antd/dist/reset.css';
import type { Message, QueuedMessagePayload, UserChoiceRequest, SessionState, SessionRuntimeState, Theme, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, LlmConfigPanelPayload, ApplyDefaultsPrompt, IdleSuspendedMessage, TodoEntry } from './types';
import { createSessionState, SessionStatesStore } from './sessionState';

import UserChoiceOverlay from './UserChoiceOverlay';
import LLMConfigPanel from './LLMConfigPanel';
import { postMessage, getHasWorkspace, getInjectedSessionId, getEffectiveHostInfo, onConversationListOwnerChanged, navigateToConversation, getIsPrewarmView, getInitialTheme } from './webviewEnv';
import { getPlaceholderLogoUri, rotatePlaceholderLogo } from './placeholderLogo';
import { DecorativeLogo } from './DecorativeLogo';
import { canCloseConversation, newConversationEntryOf, openConversationModeOf, rendersConversationListInWebview, type HostInfo } from '../host/types';
import { resolveAbortButtonState, type AbortButtonState } from '../host/abortButtonState';
import { countTodoProgress, type TodoProgress } from '../host/todoProgress';
import { collectRunningSubAgents, type RunningSubAgentBrief } from '../shared/sessionRuntime';
import { shouldAutoExpandSubSessions } from '../host/ui/conversationTreeDefaults';
import type { McpServerInfo, ProviderModels } from '../shared/webviewTypes';
import type { ModelRef } from '../shared/llm/modelRef';
import type { SessionCreator } from '../shared/sessionCreator';
import { t } from './i18n';
import { ConversationTreeItem } from './ConversationTreeItem';
import { DeleteConfirmDialog } from './components/DeleteConfirmDialog';
import { ApplyDefaultsDialog } from './components/ApplyDefaultsDialog';
import { NoticeToast, type NoticeItem } from './components/NoticeToast';
import { getColors } from './colors';
import { useConversationTree } from './hooks/useConversationTree';
import { useConversationLoading } from './hooks/useConversationLoading';
import { useMessageHandler } from './hooks/useMessageHandler';
import { useAppHandlers } from './hooks/useAppHandlers';
import { profileLog } from './debug';

// Profiling helper
const profileTag = '[Profile]';

const App = () => {
  const _appMountTime = useRef<number | null>(null);
  const _appFirstRender = useRef(true);
  if (_appFirstRender.current) {
    _appMountTime.current = performance.now();
    profileLog(`${profileTag} App 组件挂载 | t=${_appMountTime.current.toFixed(2)}ms`);
    _appFirstRender.current = false;
  }
  // 首帧主题：Electron 宿主注入 __initialTheme，渲染前就选对兜底背景色；
  // 权威值随后由宿主的 setTheme 消息下发（setThemeInitialized(true)）。
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [themeInitialized, setThemeInitialized] = useState(false);
  // 检查是否已打开工作目录（由 extension 在 HTML 注入）
  const noWorkspace = getHasWorkspace() === false;
  // 宿主能力声明：决定对话列表 / 新建对话 / 关闭按钮等由谁渲染。
  // 对话列表渲染方可在运行期切换（Electron 悬浮窗隐藏原生侧栏 → 列表移到顶栏），故放进 state 订阅。
  const [hostInfo, setHostInfo] = useState<HostInfo>(() => getEffectiveHostInfo());
  useEffect(() => onConversationListOwnerChanged((owner) => {
    setHostInfo(getEffectiveHostInfo());
    // 渲染方切换会卸载 / 重挂「历史对话」下拉（只有 webview 渲染列表时才有它）：残留的 open 状态
    // 会让它切回 webview 时自动弹出，而且不触发 onOpenChange → 列表不刷新。
    // 删除确认弹层同理，切渲染方时一并收起。
    setConversationDropdownOpen(false);
    setDeleteConfirm(null);
    // 切到 webview 渲染列表（Electron 浮窗 / VS Code）：对话列表改由顶栏渲染，且「历史提醒」
    // 要判断本 workspace 的 waiting。本视图此前可能长期不是活动视图，conversations 与
    // 运行时状态都可能是旧的（列表只推给活动视图、状态只在变化时推），主动拉一次。
    if (owner === 'webview') {
      postMessage({ type: 'getConversations' });
      postMessage({ type: 'requestSessionRuntimeStates' });
    }
  }), []);
  const [messages, setMessages] = useState<Array<Message>>([]);
  /**
   * 按会话的 Todo 清单（`docs/features/todo-list.md` FR-002）。
   *
   * 事实由 core 持有：会话加载后经 `requestSessionTodos` 取一次，之后靠
   * `CoreEvent.todosChanged` 推送更新。压缩（messagesReplaced）不影响它。
   */
  const [sessionTodos, setSessionTodos] = useState<Map<string, TodoEntry[]>>(new Map());
  const inputAreaRef = useRef<InputAreaRef>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [selectedLines, setSelectedLines] = useState<{ start: number; end: number } | null>(null);
  const [fileHidden, setFileHidden] = useState(true);
  const [showThinkingAnimation, setShowThinkingAnimation] = useState(false);
  const [animationMode, setAnimationMode] = useState<'thinking' | 'compacting'>('thinking');
  // 界面语言变化版本号：递增后通过 key 重挂载内容区，使所有 t() 文案按新语言重新渲染
  const [localeVersion, setLocaleVersion] = useState(0);
  // 对话历史状态
  const [conversations, setConversations] = useState<Array<any>>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  // 插件模式（webview 渲染对话列表）下，历史对话分页展示：默认 50 条，滚动到底再加载 50 条
  const [visibleConversationCount, setVisibleConversationCount] = useState(50);
  const CONVERSATION_PAGE_SIZE = 50;
  // 本视图创建时绑定的目标会话（Electron：URL ?session= / preload 注入的 __sessionId）。
  // 单视图内切换（VSCode / 浏览器）时由 useConversationLoading.begin 更新。
  const initialSessionId = useMemo(() => getInjectedSessionId(), []);
  /**
   * 会话加载状态由「对话」自己持有（单一职责）：
   * 只在本视图确实要加载某个会话时进入 loading，收到该会话的 conversationLoaded 后结束。
   * Electron 下切换会话由宿主另开一个视图完成，本视图不进入 loading，
   * 因此不会出现「显示了 loading 但没有任何人通知它完成」。
   */
  const {
    isLoading: isLoadingConversation,
    begin: beginConversationLoad,
    finish: finishConversationLoad,
    reset: resetConversationLoad,
  } = useConversationLoading(initialSessionId);
  // 子对话展开状态（sessionId -> boolean）
  const [conversationDropdownOpen, setConversationDropdownOpen] = useState(false);
  const [conversationTitle, setConversationTitle] = useState<string>(t('app.untitled'));
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // 当前对话的父会话 ID（本地子对话时有效；跨工作区对话无父会话，specs/025 FR-002）
  const [parentSessionId, setParentSessionId] = useState<string | null>(null);
  /** 会话创建者（specs/025 FR-002）：返回按钮按它跳发起方（跨工作区）或父会话（本地） */
  const [creator, setCreator] = useState<SessionCreator | null>(null);
  // 当前会话的子代理角色（conversationLoaded.metadata.role，specs/020 FR-005）：
  // 非 Master 子代理会话锁定选项菜单的提示词模式 / 联网搜索 / MCP 三项
  const [subAgentRole, setSubAgentRole] = useState<string | null>(null);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const [contextLength, setContextLength] = useState<number>(0);
  const [maxContextTokens, setMaxContextTokens] = useState<number | null>(null);
  /**
   * 会话配置事实（`docs/hosts/webview-facts.md` 第 3 节）：全部以 `undefined` 起，
   * 收到宿主下发的值之前保持「尚未到达」。webview 不设默认值——未到达时输入区显示等待态，
   * 也不把这些字段当作配置回传给宿主。
   *
   * `agentMode` / `webSearch` 的「是否到达」同时是输入区菜单的等待判据。
   */
  const [agentMode, setAgentMode] = useState<AgentMode | undefined>(undefined);
  /**
   * 会话关联的提示词模式（普通/极简/混合），持久化到 meta.json。
   * 未从宿主获取到之前保持 undefined，发送按钮保持禁用（见 configReady）。
   */
  const [promptMode, setPromptMode] = useState<PromptMode | undefined>(undefined);
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode | undefined>(undefined);
  const [webSearch, setWebSearch] = useState<boolean | undefined>(undefined);
  /**
   * 当前会话选择的模型身份（provider + model）。模型完全由用户配置，未获取到之前为
   * undefined，发送按钮禁用。
   * provider 与 model 必须成对存在（provider 空串非法，不表示「未知」），
   * 因此不拆成两个独立状态，避免二者漂移。
   */
  const [modelRef, setModelRef] = useState<ModelRef | undefined>(undefined);
  /**
   * 全部 provider 及其模型列表（菜单按 provider 建立三级子菜单）。
   * `undefined` = 尚未收到宿主应答；空数组 = 宿主答了「没有配置模型」。
   */
  const [providerModels, setProviderModels] = useState<ProviderModels[] | undefined>(undefined);
  // settings.json 中的默认值（新对话创建时一次性使用，避免先显示 risk 再跳变）。
  // 不内置任何兜底值：未收到宿主回传前字段为 undefined。
  const [settingsDefaults, setSettingsDefaults] = useState<SettingsDefaults>({});
  /**
   * 会话配置（模型 / 思考强度 / 提示词模式等）是否已从宿主获取到。
   * 未就绪时禁用发送按钮（复用 MCP 连接中的效果），避免用空/兜底配置发起请求。
   */
  const [configReady, setConfigReady] = useState(false);
  // 全局余额信息（与会话无关）
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [balanceCurrency, setBalanceCurrency] = useState<string | undefined>(undefined);
  const [isUnlimited, setIsUnlimited] = useState<boolean | undefined>(undefined);
  // 压缩展开状态
  const [hasCompactArchive, setHasCompactArchive] = useState(false);
  const [isCompactExpanded, setIsCompactExpanded] = useState(false);
  // 会话工作模式（core `workModeChanged` / conversationLoaded 载荷的事实投影）：
  // spin = 主输入框禁用（specs/016 FR-004）；新对话与加载会话时随载荷重置。
  const [workMode, setWorkMode] = useState<'normal' | 'spin'>('normal');
  // 排队消息状态
  // queuedMessage 仅用于展示"当前会话"的排队横幅；
  // queuedMessageRef 按 sessionId 存储排队消息，保证排队消息与会话绑定，
  // 切换会话后排队消息仍归属原会话，不会被误投递到其他会话。
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessagePayload | null>(null);
  const queuedMessageRef = useRef<Map<string, QueuedMessagePayload>>(new Map());
  // 空闲发送的本地挂起（docs/features/user-message-pipeline.md FR-003）：ref 是唯一事实（按会话存完整 wire 载荷），
  // 展示在渲染时按当前会话派生；version 仅用于 ref 变更后触发重渲染。
  // 挂起项不上送宿主（sendMessage / onQueuedMessage 契约不变），webview 重载即丢失。
  const idleSuspendedRef = useRef<Map<string, IdleSuspendedMessage>>(new Map());
  const [idleSuspendedVersion, setIdleSuspendedVersion] = useState(0);
  // 记录用户主动点击 abort 的会话。queryEnd 到达时用于判断：
  // 若该会话仍有排队消息，则不重新发送它，而是回填到输入框由用户自行修改。
  const abortedSessionsRef = useRef<Set<string>>(new Set());

  // 正在智能命名的会话 ID 集合
  const [namingSessions, setNamingSessions] = useState<Set<string>>(new Set());

  /**
   * LLM 配置面板载荷：宿主随 `showLLMConfig` 一次给齐（`docs/hosts/webview-facts.md` 第 6 节）。
   *
   * `null` = 尚未收到载荷，面板不打开。webview 不补默认值，也不在载荷缺失时打开空面板。
   */
  const [llmConfigPayload, setLlmConfigPayload] = useState<LlmConfigPanelPayload | null>(null);
  // 服务商配置是否已完成（activeProvider 存在且 apiKey 非空）；未完成时禁用输入框并引导打开设置。
  // 初始为 null（尚未探测到配置），避免启动时因探测延迟而误显示"请配置模型服务"。
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);

  // Skills for slash-command autocomplete
  const [skills, setSkills] = useState<Array<{ name: string; description: string; isBuiltin?: boolean }>>([]);
  /** `@` 工作区候选（宿主已排除本工作区；specs/023 FR-007） */
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; path: string; displayName: string }>>([]);

  // MCP 服务器列表（来自 mcp.json + settings.json 启用状态），供菜单勾选。
  // 仅展示「当前会话」的列表；mcpServersBySessionRef 按会话缓存，避免异步回推串台。
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const mcpServersBySessionRef = useRef<Map<string, McpServerInfo[]>>(new Map());

  /**
   * 全局拦截外部链接点击（document capture 阶段，先于任何组件内 onClick）：
   * markdown 渲染的 <a href> 默认会在 webview 内导航（Electron 中会替换聊天 UI，
   * 或按 target=_blank 新开 Electron 窗口）。统一改为 postMessage('openUrl')，
   * 由宿主（VS Code / Electron）用系统默认浏览器打开。
   * 仅拦截 http/https/mailto/tel 等外部协议，应用内部链接不受影响。
   */
  useEffect(() => {
    const handleExternalLinkClick = (e: MouseEvent) => {
      // 允许用户按住修饰键（Ctrl/Cmd/Shift/Middle）走浏览器默认行为（新窗口/新标签）
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      if (!/^(https?|mailto|tel):/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      postMessage({ type: 'openUrl', url: href });
    };
    document.addEventListener('click', handleExternalLinkClick, true);
    return () => document.removeEventListener('click', handleExternalLinkClick, true);
  }, []);

  // 当 agentMode 变化时通知 extension（会话级，持久化到 meta.json）。
  // 会话尚未建立时 currentSessionId 为 null：此时不下发，等会话建立后本 effect 会因
  // currentSessionId 变化重跑并补发，避免以 null 作为 sessionId 写入 core 存储 / meta.json。
  // 未获取到配置前 agentMode 为 undefined：此时不下发，避免用 webview 的猜测
  // 覆盖会话配置（`docs/hosts/webview-facts.md` 第 5 节）。
  useEffect(() => {
    if (!currentSessionId || !agentMode) return;
    postMessage({ type: 'setAgentMode', mode: agentMode, sessionId: currentSessionId });
  }, [agentMode, currentSessionId]);

  // 当 promptMode 变化时通知 extension（会话级，持久化到 meta.json）。
  // 未获取到配置前 promptMode 为 undefined：此时不下发，避免把 undefined 写进 meta.json。
  useEffect(() => {
    if (currentSessionId && promptMode) {
      postMessage({ type: 'setPromptMode', mode: promptMode, sessionId: currentSessionId });
    }
  }, [promptMode, currentSessionId]);

  // 当 thinkingMode 变化时通知 extension（使其在对话中动态生效）。
  // 未获取到配置前 thinkingMode 为 undefined：此时不下发。
  useEffect(() => {
    if (currentSessionId && thinkingMode) {
      postMessage({ type: 'setThinkingMode', mode: thinkingMode, sessionId: currentSessionId });
    }
  }, [thinkingMode, currentSessionId]);

  // 当联网搜索开关变化时通知 extension（会话级，持久化到 meta.json）。
  // 未获取到配置前 webSearch 为 undefined：此时不下发，避免用 webview 的猜测
  // 覆盖会话配置（`docs/hosts/webview-facts.md` 第 5 节）。core 侧随消息携带的
  // webSearch 只承担新会话种子职责，这里的变化通知才是会话中途切换的正规写入口
  // （specs/defects/websearch-recheck-clobbered-by-payload）。
  useEffect(() => {
    if (currentSessionId && webSearch !== undefined) {
      postMessage({ type: 'setWebSearch', webSearch, sessionId: currentSessionId });
    }
  }, [webSearch, currentSessionId]);

  // 当模型身份（provider + model）变化时通知 extension，并重新请求对应模型的上下文限制。
  // 未获取到模型前为 undefined：此时不下发，避免空模型覆盖/污染会话配置。
  // wire 协议保持扁平：这里把模型身份拆成 model / provider 两个字段。
  // 依赖用两个标量而非对象本身，避免每次 setModelRef 生成新对象导致重复下发。
  useEffect(() => {
    if (!modelRef) return;
    if (currentSessionId) {
      postMessage({ type: 'setModel', model: modelRef.model, provider: modelRef.provider, sessionId: currentSessionId });
    }
    postMessage({ type: 'requestContextLimit', model: modelRef.model, provider: modelRef.provider });
  }, [modelRef?.model, modelRef?.provider, currentSessionId]);

  // 注意：不再使用防抖定时器持久化上下文，
  // currentFile/selectedLines 由 Extension 端的 sendCurrentFileInfo() 直接处理，
  // contextLength 仅在收到 thinking/assistant 消息时更新，切换对话时手动持久化。

  // Tool status 批量更新：使用 Map 替代 Array 避免 O(n) findIndex 查找
  const toolStatusRafRef = useRef<number | null>(null);
  const pendingToolStatusRef = useRef<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
  }>>(new Map());
  /** 跨会话工具状态缓冲：存储因 sessionId 不匹配而被过滤的 updateToolStatus，
   *  在 conversationLoaded 加载新会话后，扫描此缓冲并应用匹配的更新。
   *  解决子代理工具在会话切换期间发送的 updateToolStatus 丢失的问题。 */
  const bufferedToolStatusRef = useRef<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
  }>>(new Map());
  /** 工具流式输出批量更新：rAF throttle 合并高频 toolProgress 消息 */
  const toolProgressRafRef = useRef<number | null>(null);
  const pendingToolProgressRef = useRef<Map<string, {
    toolCallId: string;
    output: string;
    elapsedTimeSeconds?: number;
    totalLines?: number;
    totalBytes?: number;
  }>>(new Map());
  /** 正在加载会话的标记：conversationLoaded 消息处理期间设为 true，
   *  在 rAF 回调执行 setMessages(restoredMessages) 后设为 false。
   *  此期间到达的 updateToolStatus 统一进入 bufferedToolStatusRef，
   *  避免正常 rAF 路径与 conversationLoaded 的 rAF 回调之间的时序竞态。 */
  const conversationLoadingRef = useRef(false);

  // 流式消息批量更新：使用 rAF throttle 合并高频 delta 更新
  const streamRafRef = useRef<number | null>(null);
  const pendingStreamRef = useRef<Map<string, { role: string; accumulated: string; streamId?: string }>>(new Map());

  // 流式渲染版本号：每次 streamMessage content 更新时递增，
  // 传递给 MessagesView 强制更新 Messages 渲染（mutation 改对象属性不触发 React 重新渲染的情况）
  const [streamingVersion, setStreamingVersion] = useState(0);

  // 注意：不再通过防抖自动持久化上下文到 meta.json
  // currentFile/selectedLines 的变化由 Extension 端的 sendCurrentFileInfo() 直接处理
  // contextLength 在每次收到 thinking/assistant 消息时已更新，无需额外持久化
  // 仅在切换对话时主动持久化（见下方 onClick 中的立即发送）

  // 删除对话确认状态
  const [deleteConfirm, setDeleteConfirm] = useState<{
    sessionId: string;
    title: string;
  } | null>(null);
  const isDeletingRef = useRef(false);

  // 「默认配置已修改，是否应用到当前对话」待确认项（由 config handler 在
  // llmConfigSaved 时写入，见 handleConfigLlmConfigSaved）。
  const [applyDefaultsPrompt, setApplyDefaultsPrompt] = useState<ApplyDefaultsPrompt | null>(null);

  /**
   * 瞬时状态提示（`docs/architecture/core-ui-separation.md` 第 4.9 节）：core 只给「键 + 参数」，
   * 这里翻译后以浮层呈现，不进消息流；若干秒后自动消失。
   */
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const noticeIdRef = useRef(0);
  const pushNotice = useCallback(
    (key: string, params: Record<string, string | number>, level: NoticeItem['level']) => {
      const id = ++noticeIdRef.current;
      setNotices((prev) => [...prev, { id, key, params, level }]);
      setTimeout(() => {
        setNotices((prev) => prev.filter((notice) => notice.id !== id));
      }, level === 'error' ? 8000 : 5000);
    },
    [],
  );
  const dismissNotice = useCallback((id: number) => {
    setNotices((prev) => prev.filter((notice) => notice.id !== id));
  }, []);
  const currentSessionIdRef = useRef<string | null>(null);
  /** 统一设置当前会话 ID，同时同步 ref 和 window.__currentSessionId */
  const setCurrentSessionIdRef = useCallback((sid: string | null) => {
    currentSessionIdRef.current = sid;
    (window as any).__currentSessionId = sid;
  }, []);
  // Per-session state: input, userChoiceRequest, userChoiceInput
  // 会话级 UI 状态的唯一容器（组件生命周期内持久；写入口径收敛在 store）
  const [sessionStates] = useState(() => new SessionStatesStore());
  // core 推送的会话运行时状态：对话树流水灯与 abort 按钮的唯一数据源
  const sessionRuntimeStatesRef = useRef<Map<string, SessionRuntimeState>>(new Map());
  // Per-session command history (most recent first)
  const commandHistoryRef = useRef<Map<string, string[]>>(new Map());
  const COMMAND_HISTORY_MAX = 50;

  // Cursor position to restore after input change
  const cursorPositionRef = useRef<number | null>(null);
  const choiceCursorPositionRef = useRef<number | null>(null);

  // 使用 ref 同步 userChoiceRequest，避免 useCallback 中的 stale closure
  const userChoiceRequestRef = useRef<UserChoiceRequest | null>(null);
  // 用于会话状态持久化保存用户选择输入（仅 ref，不会触发重渲染）
  const userChoiceInputRef = useRef('');
  // 保存 userChoiceRequest 弹出前主输入框的内容，关闭后恢复
  const savedMainInputRef = useRef('');

  // ── "新对话"草稿：避免"新建 → 输入 → 切走 → 再新建"时内容丢失 ──────────
  // 会话还没发过任何消息时（webview 刚打开，或点了顶部"+"新建），输入框里的内容不属于
  // 任何已落盘的会话：切换会话时它不会被 sessionStates 保存下来，再点"新建"就丢了。
  // 这里单独暂存一份，新建对话时恢复。
  /**
   * 由顶部"+"新建、且尚未发送过消息的会话 id。
   * 与 currentSessionIdRef 相等即表示"当前正处于这个未发送的新对话"；
   * 加载过任何真实会话后两者自然不等，因此不需要额外的复位逻辑。
   */
  const newChatSessionRef = useRef<string | null>(null);
  /** 该对话里已输入但未发送的草稿（含光标位置） */
  const newChatDraftRef = useRef<{ input: string; cursor: number; pastedImages?: SessionState['pastedImages'] } | null>(null);

  /** 暂存"新对话"里已输入但未发送的草稿（离开该对话前调用） */
  const stashNewChatDraft = useCallback(() => {
    if (currentSessionIdRef.current !== newChatSessionRef.current) return;
    const input = inputAreaRef.current?.getValue() ?? '';
    newChatDraftRef.current = {
      input,
      // 光标位置一并暂存：恢复草稿时不能只把文本塞回去，否则光标会落到末尾
      cursor: Math.min(mainInputRef.current?.selectionStart ?? input.length, input.length),
      pastedImages: inputAreaRef.current?.getPastedImages?.() ?? [],
    };
  }, []);

  // 用户确认对话框状态
  const [userChoiceRequest, setUserChoiceRequest] = useState<UserChoiceRequest | null>(null);
  // 强制滚动 key：递增时 MessagesView 在底部时重新滚动到底部
  const [forceScrollKey, setForceScrollKey] = useState(0);
  // 会话运行状态版本号：core 推来 sessionRuntimeStates 时递增，
  // 强制 App 重渲染，使对话列表的流水灯（running-bar）与 abort 按钮即时变化。
  const [sessionIdleVersion, setSessionIdleVersion] = useState(0);
  // 未读完成的会话（「任务完成」绿色呼吸；sessionId → 推送到达时刻）。
  // 主进程推全量集合快照（幂等）：列表项呼吸一次后保持常亮，直到该对话成为当前
  // 对话（主进程清除并重推）。只有 Electron 宿主发这条消息，其它宿主集合恒为空。
  const [completionAttention, setCompletionAttention] = useState<Map<string, number>>(new Map());

  // 输入框 refs
  const mainInputRef = useRef<HTMLTextAreaElement>(null);
  const choiceInputRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  // 用户是否已主动滚离底部（由 MessagesView 的滚轮监听维护，
  // useMessageHandler 的预滚动逻辑也需要读取它，避免新节点与用户上滚抢位置）
  const userScrolledAwayRef = useRef(false);
  // 加载对话列表
  const listLoadedOnceRef = useRef(false);

  // -- hooks --
  const { conversationTree, expandedSubSessions, setExpandedSubSessions } = useConversationTree(conversations);

  // 对话树流水灯（idle / waiting）只读 core 推送的会话运行时状态：
  // 与 Electron 侧栏同一数据源（core sessionRuntimeChanged），不再本地推导（`docs/hosts/host-matrix.md`）。
  // 未记录的会话视为 idle（不显示流水灯）。
  const getSessionIdleState = useCallback((sid: string): boolean => {
    return sessionRuntimeStatesRef.current.get(sid)?.idle ?? true;
  }, []);
  const getSessionWaitingState = useCallback((sid: string): boolean => {
    return sessionRuntimeStatesRef.current.get(sid)?.waiting ?? false;
  }, []);

  // abort 按钮三态（红 / 黄 / 灰）：判定读 core 的 sessionRuntime 根事实，由纯函数
  // resolveAbortButtonState 推导表现（docs/features/abort-button.md FR-001）。事实未到达
  // （当前会话没有快照）按空闲处理，按钮置灰不可点。
  const abortButtonState: AbortButtonState = useMemo(() => {
    if (!currentSessionId) return 'none';
    const state = sessionRuntimeStatesRef.current.get(currentSessionId);
    if (!state) return 'none';
    // workMode 来自本组件状态（runtime 快照不携带工作模式）：spin 模式没有 query
    // engine，归入黄色档（只用于中止子代理；spin 单向不退出）
    return resolveAbortButtonState({ ...state, workMode });
    // sessionIdleVersion 是 core 推来新状态时的重渲染信号（ref 本身不触发渲染）
  }, [currentSessionId, sessionIdleVersion, workMode]);

  // 任务进度按钮的计数（docs/features/todo-list.md FR-002）：清单由 core 持有，
  // 这里只把当前会话的清单折成 done / total（唯一实现在 src/host/todoProgress.ts）。
  // 没有清单（事实未到达 / 该会话没有 Todo）→ null，按钮不渲染。
  const todoProgress: TodoProgress | null = useMemo(
    () => countTodoProgress(currentSessionId ? sessionTodos.get(currentSessionId) : null),
    [sessionTodos, currentSessionId],
  );

  // abort 悬停明细（specs/019 FR-002）：黄色态悬停 1s 显示的后台任务 / 子代理清单。
  // tasks 读当前会话快照的 backgroundTasks；子代理由唯一纯函数 collectRunningSubAgents
  // 按 parentSessionId 从全量快照聚合。`?? []` 是 specs/019「边界与错误路径」明文的缺
  // 字段口径（旧宿主 / 假宿主未带新字段），与上方布尔位的缺字段处理同一口径。
  const abortHoverDetail: { tasks: { taskId: string; description: string; command: string }[]; subAgents: RunningSubAgentBrief[] } = useMemo(() => {
    if (!currentSessionId) return { tasks: [], subAgents: [] };
    const state = sessionRuntimeStatesRef.current.get(currentSessionId);
    const tasks = state?.backgroundTasks ?? [];
    // webview 镜像不带 sessionId（快照里它退化为 Map 键），聚合前按 entry 还原
    const subAgents = collectRunningSubAgents(
      Array.from(sessionRuntimeStatesRef.current, ([sessionId, s]) => ({ ...s, sessionId })),
      currentSessionId,
    );
    return { tasks, subAgents };
    // sessionIdleVersion 是 core 推来新状态时的重渲染信号（ref 本身不触发渲染）
  }, [currentSessionId, sessionIdleVersion]);

  // 待压缩（手动压缩已排队、尚未开始）：用量文本显示「准备压缩」并取消点击入口
  // （docs/features/compaction.md FR-002）。事实未到达（当前会话没有快照）不显示。
  const compactPending = useMemo(() => {
    if (!currentSessionId) return false;
    const state = sessionRuntimeStatesRef.current.get(currentSessionId);
    return state ? state.pendingCompact && !state.compacting : false;
    // sessionIdleVersion 是 core 推来新状态时的重渲染信号（ref 本身不触发渲染）
  }, [currentSessionId, sessionIdleVersion]);

  // 只有对话列表由 webview 渲染（`rendersConversationListInWebview`）时才有内嵌的历史对话按钮。
  // 当「本工作目录的其它会话」正在等待用户输入（ask user / 权限确认）时，用户请求不再
  // 自动切换会话，因此在历史对话按钮上加黄色呼吸效果提醒用户：去那个会话处理待答请求。
  // 数据源与流水灯一致（core sessionRuntimeStates.waiting），但只认本视图对话列表里的会话：
  // 列表本身就是当前工作目录的（每条带 project 归属），其它工作目录的 waiting 不在这里
  // 提醒——浮窗顶栏的列表只能看到 / 切换到本目录的对话，提醒了也过不去。
  const historyButtonAttention = useMemo(() => {
    if (!rendersConversationListInWebview(hostInfo)) return false;
    const localSessionIds = new Set<string>(conversations.map((c) => c.sessionId));
    for (const [sid, state] of sessionRuntimeStatesRef.current) {
      if (state.waiting && sid !== currentSessionId && localSessionIds.has(sid)) return true;
    }
    return false;
    // sessionIdleVersion 是 waiting 变化时的重渲染信号（ref 本身不触发渲染）；
    // conversations 变化（切工作目录 / 列表刷新）也要重算「本目录有哪些会话」。
  }, [currentSessionId, sessionIdleVersion, hostInfo, conversations]);

  // 插件模式对话下拉滚动到底时，动态追加一页历史对话
  const handleConversationScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      setVisibleConversationCount(prev => Math.min(prev + CONVERSATION_PAGE_SIZE, conversationTree.roots.length));
    }
  }, [conversationTree.roots.length]);

  const handlerProps = useMemo(() => ({
    setMessages, setShowThinkingAnimation, setAnimationMode, setHasActiveQuery,
    setHasCompactArchive, setIsCompactExpanded, setConversations, setConversationsLoading,
    setVisibleConversationCount, finishConversationLoad, resetConversationLoad,
    setTheme, setThemeInitialized, setCurrentFile, setSelectedLines,
    setConversationTitle, setMaxContextTokens, setSkills, setWorkspaces, setMcpServers, setConversationDropdownOpen,
    setCurrentSessionId, setParentSessionId, setCreator, setAgentMode, setThinkingMode,
    setModelRef, setWebSearch, setContextLength, setQueuedMessage,
    setUserChoiceRequest, setNamingSessions, setStreamingVersion, setForceScrollKey,
    setSessionIdleVersion,
    setSessionTodos,
    setWorkMode,
    setCompletionAttention,
    setExpandedSubSessions, setProviderModels, setBalance, setBalanceCurrency, setIsUnlimited,
    setCurrentSessionIdRef, setLlmConfigPayload,
    setSettingsDefaults, settingsDefaults, setLocaleVersion,
    setApplyDefaultsPrompt,
    setProviderConfigured,
    setConfigReady,
    pushNotice,
    messages,
    currentSessionIdRef, sessionStates, sessionRuntimeStatesRef, userChoiceRequestRef, userChoiceInputRef,
    savedMainInputRef, queuedMessageRef, abortedSessionsRef, mcpServersBySessionRef, cursorPositionRef, choiceCursorPositionRef,
    newChatSessionRef,
    mainInputRef, choiceInputRef, messagesContainerRef, userScrolledAwayRef,
    streamRafRef, toolStatusRafRef, pendingStreamRef, pendingToolStatusRef,
    bufferedToolStatusRef, conversationLoadingRef, isDeletingRef, listLoadedOnceRef,
    toolProgressRafRef, pendingToolProgressRef,
    _appMountTime, modelRef, contextLength,
    inputAreaRef,
    // 当前会话实时状态（切换会话保存快照时使用）
    userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, thinkingMode,
    promptMode, setPromptMode, webSearch,
    setSubAgentRole,
    currentFile, selectedLines,
  }), [modelRef, contextLength, settingsDefaults, userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, thinkingMode, promptMode, webSearch, currentFile, selectedLines, messages]);
  useMessageHandler(handlerProps);

    const appHandlerProps = useMemo(() => ({
    currentFile, selectedLines, fileHidden, conversations, conversationsLoading,
    conversationDropdownOpen, conversationTitle, currentSessionId, parentSessionId,
    hasActiveQuery, contextLength, maxContextTokens, agentMode, thinkingMode,
    promptMode, setPromptMode,
    modelRef, webSearch, settingsDefaults, hasCompactArchive, isCompactExpanded,
    queuedMessage, deleteConfirm, userChoiceRequest,
    showThinkingAnimation, animationMode, messages,
    setCurrentFile, setSelectedLines, setFileHidden, setConversations,
    setConversationsLoading, setConversationDropdownOpen, setConversationTitle,
    setCurrentSessionId, setParentSessionId, setCreator, setSubAgentRole, setHasActiveQuery, setContextLength,
    setMaxContextTokens, setAgentMode, setThinkingMode,
    setModelRef, setWebSearch, setHasCompactArchive, setIsCompactExpanded, setQueuedMessage,
    setDeleteConfirm, setMessages, setUserChoiceRequest, setForceScrollKey,
    setShowThinkingAnimation, setExpandedSubSessions, setNamingSessions,
    currentSessionIdRef, sessionStates, commandHistoryRef, cursorPositionRef,
    choiceCursorPositionRef, userChoiceRequestRef, userChoiceInputRef,
    savedMainInputRef, queuedMessageRef, abortedSessionsRef, mainInputRef, choiceInputRef,
    newChatSessionRef, newChatDraftRef,
    isDeletingRef, listLoadedOnceRef, setCurrentSessionIdRef, inputAreaRef,
    COMMAND_HISTORY_MAX, _appMountTime,
    idleSuspendedRef, setIdleSuspendedVersion, sessionRuntimeStatesRef, sessionIdleVersion,
  }), [
    currentFile, selectedLines, fileHidden, conversations, conversationsLoading,
    conversationDropdownOpen, conversationTitle, currentSessionId, parentSessionId,
    hasActiveQuery, contextLength, maxContextTokens, agentMode, thinkingMode,
    promptMode,
    modelRef, webSearch, settingsDefaults, hasCompactArchive, isCompactExpanded,
    queuedMessage, deleteConfirm, userChoiceRequest,
    showThinkingAnimation, animationMode, messages,
    sessionIdleVersion,
  ]);

  const {
    formatRelativeTime, loadConversations, onStartup, handleSend, handleSendIdle, handleAbort,
    handleEditQueuedMessage, handleDeleteQueuedMessage,
    handleEditIdleSuspended, handleDeleteIdleSuspended,
    handleCompress, handleUserChoiceResponse, handleUserChoiceSubmit,
    handleAnswersSubmit, handleChoiceResponse, handleToggleFileHidden,
    toggleSubSession: _toggleSubSession,
  } = useAppHandlers(appHandlerProps as any);

  // 打开设置（LLM 配置）页面：先向扩展请求当前配置值，
  // 扩展回传 showLLMConfig 后由 useMessageHandler 填充配置面板并打开
  /**
   * 保存当前会话快照到 sessionStates，并立即持久化上下文到 meta.json。
   * 收敛 ConversationTreeItem onSelect / 新对话按钮等会话切换入口的保存动作。
   * 值类型状态（userChoiceRequest / showThinkingAnimation 等）直接读渲染闭包值。
   */
  const saveCurrentSessionSnapshot = useCallback(() => {
    const sid = currentSessionIdRef.current;
    if (!sid) return;
    const existing = sessionStates.get(sid);
    sessionStates.set(sid, createSessionState({
      input: inputAreaRef.current?.getValue() ?? '',
      pastedImages: inputAreaRef.current?.getPastedImages?.() ?? [],
      inputCursorPosition: mainInputRef.current?.selectionStart ?? 0,
      choiceCursorPosition: choiceInputRef.current?.selectionStart ?? 0,
      userChoiceRequest,
      userChoiceInput: userChoiceInputRef.current,
      showThinkingAnimation,
      animationMode,
      hasActiveQuery,
      preCompressHasActiveQuery: existing?.preCompressHasActiveQuery,
      agentMode,
      promptMode,
      thinkingMode,
      // webSearch 也在会话快照里：菜单开关的值经保存边界持久化，
      // 否则切走再切回会丢（恢复链读 savedState.webSearch）
      webSearch,
      contextLength,
      queuedMessage: queuedMessageRef.current.get(sid) ?? null,
      modelRef,
    }));
    postMessage({
      type: 'updateConversationContext',
      sessionId: sid,
      currentFile,
      selectedLines: selectedLines ?? undefined,
      totalContextTokens: contextLength,
    });
  }, [userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, promptMode, thinkingMode, webSearch, contextLength, modelRef, currentFile, selectedLines]);

  /**
   * **会话跳转的唯一 UI 入口**（对话列表 / 对话树 / 子代理 From 链接 / 返回父会话按钮
   * 全部收敛到这里；不允许任何入口直接调 webviewEnv.navigateToConversation）。
   *
   * 切换前的固定动作序列：
   * 1. 当前若是"新建但还没发消息"的对话，先把草稿暂存，供下次"新建"恢复；
   * 2. 清空消息并显示加载动画（插件模式与 Electron 模式统一）；
   * 3. 清空当前展示的排队横幅，避免上一会话的 queue 串到新会话；
   * 4. 发送导航消息（VS Code 插件 / Electron 都走 postMessage，由宿主决定打开方式）。
   */
  const navigateToSession = useCallback((sessionId: string, targetWorkspaceId: string | null = null) => {
    // 当前若是"新建但还没发消息"的对话，先把草稿暂存，供下次"新建"恢复
    stashNewChatDraft();
    // 多视图：由宿主另开一个会话视图来加载目标会话，本视图不参与加载。
    // 这里只做委托，不改动本视图的会话状态（消息 / loading），
    // 否则切回本视图会看到空消息或永远转圈的 loading（没有人为它通知完成）。
    if (openConversationModeOf(hostInfo) === 'openConversation') {
      navigateToConversation(sessionId, targetWorkspaceId);
      return;
    }
    // 单视图：在当前视图内原地加载。loading 由对话自身持有，
    // 收到目标会话的 conversationLoaded 后自动结束。
    beginConversationLoad(sessionId);
    setMessages([]);
    setQueuedMessage(null);
    navigateToConversation(sessionId, targetWorkspaceId);
  }, [stashNewChatDraft, hostInfo.conversationView, beginConversationLoad]);

  /**
   * 新建对话（顶部"+"按钮）。
   *
   * 先按 `openConversationModeOf` 分支：
   * - 多视图宿主：新对话是另一个视图，只发 `openNewConversation` 交给宿主另开 / 复用视图；
   * - 单视图宿主：在当前视图内原地新建，依次完成——
   *   保存当前会话快照并持久化上下文；暂存"新对话"草稿（未发送过的对话切走时草稿由
   *   stashNewChatDraft 保存）；轮换空状态背景图（每次新对话换一张，不与上一次重复）；
   *   生成新 sessionId，重置全部 UI 状态到 settings.json 默认值；把上一个"新对话"里
   *   没发出去的草稿带过来，避免切换会话后再新建时内容丢失。
   * 自按钮 onClick 内联约 90 行抽出，行为不变。
   */
  const handleNewConversation = useCallback(() => {
    // 多视图宿主：新对话是另一个视图，本视图不参与新建——只把请求交给宿主
    // （宿主复用「未发送的新对话」视图，保住那边的草稿）。与 navigateToSession 同一分工：
    // 本视图不改自己的会话状态，否则切回本视图会看到空消息或永远转圈的 loading。
    if (openConversationModeOf(hostInfo) === 'openConversation') {
      postMessage({ type: 'openNewConversation' });
      return;
    }
    // Save current session state before switching
    saveCurrentSessionSnapshot();
    // 当前若是"新建但还没发消息"的对话，先把草稿暂存，稍后带到新对话
    stashNewChatDraft();
    // 换一张空状态背景图（见 placeholderLogo.ts：随机且不与上一次重复）
    rotatePlaceholderLogo();
    // 新对话无需等待任何会话数据：结束对话自身的 loading 状态
    resetConversationLoad();
    // Generate new session for new conversation
    setConversationTitle(t('app.untitled'));
    setParentSessionId(null);
    setCreator(null);
    // 新建会话无子代理角色（specs/020 FR-005），置灰判定回到普通会话
    setSubAgentRole(null);
    // 新对话不在 spin 模式
    setWorkMode('normal');
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    setMessages([]);
    // 把上一个"新对话"里没发出去的草稿带过来，避免切换会话后再新建时内容丢失
    const draft = newChatDraftRef.current;
    const draftInput = draft?.input ?? '';
    const draftImages = draft?.pastedImages ?? [];
    const draftCursor = Math.min(draft?.cursor ?? draftInput.length, draftInput.length);
    inputAreaRef.current?.setValue(draftInput);
    inputAreaRef.current?.setPastedImages?.(draftImages);
    newChatSessionRef.current = newSessionId;
    setUserChoiceRequest(null);
    userChoiceInputRef.current = '';
    savedMainInputRef.current = '';
    setShowThinkingAnimation(false);
    setHasActiveQuery(false);
    setQueuedMessage(null);
    setContextLength(0);
    // 重置压缩状态（新对话没有压缩）
    setHasCompactArchive(false);
    setIsCompactExpanded(false);
    // 新对话使用 settings.json 中的默认值（一次性设置，避免跳变）。
    // settingsDefaults 尚未就绪（undefined）时保留当前值，不写入兜底默认值。
    const nextAgentMode = settingsDefaults.agentMode ?? agentMode;
    const nextThinkingMode = settingsDefaults.thinkingMode ?? thinkingMode;
    const nextWebSearch = settingsDefaults.webSearch ?? webSearch;
    // 模型身份整体跟随默认值：settingsDefaults 未就绪时保留当前选择。
    const nextModelRef = settingsDefaults.modelRef ?? modelRef;
    const nextPromptMode = settingsDefaults.promptMode ?? promptMode;
    setAgentMode(nextAgentMode);
    setThinkingMode(nextThinkingMode);
    setWebSearch(nextWebSearch);
    setModelRef(nextModelRef);
    setPromptMode(nextPromptMode);
    setCurrentSessionId(newSessionId);
    setCurrentSessionIdRef(newSessionId);
    // 为新对话创建默认 state
    sessionStates.set(newSessionId, createSessionState({
      input: draftInput,
      pastedImages: draftImages.length > 0 ? draftImages : undefined,
      inputCursorPosition: draftCursor,
      choiceCursorPosition: 0,
      agentMode: nextAgentMode,
      promptMode: nextPromptMode,
      thinkingMode: nextThinkingMode,
      webSearch: nextWebSearch,
      modelRef: nextModelRef,
    }));
    postMessage({ type: 'startNewConversation', sessionId: newSessionId });
    // 聚焦输入框，并把光标放回草稿里的原位置
    setTimeout(() => {
      mainInputRef.current?.focus();
      mainInputRef.current?.setSelectionRange(draftCursor, draftCursor);
    }, 0);
    // 依赖与 saveCurrentSessionSnapshot 相同（值类型快照来源）；ref 不进依赖数组
  }, [hostInfo, saveCurrentSessionSnapshot, stashNewChatDraft, resetConversationLoad, settingsDefaults, agentMode, thinkingMode, webSearch, modelRef, promptMode]);

  const handleOpenSettings = useCallback(() => {
    postMessage({ type: 'requestLLMConfig' });
  }, []);

  /**
   * 确认把新默认配置应用到当前对话。
   *
   * 只写 pending 里确实需要变的字段（模型身份 / 提示词模式 / thinking effort /
   * 询问模式 / 联网搜索 / MCP 启用列表），并同步当前会话的内存状态；下发到宿主由
   * 各字段自己的 effect 完成（见 setModelRef / setPromptMode / ... 的 useEffect），
   * MCP 列表没有对应的会话字段，直接发 `setMcpEnabledList`。
   */
  const handleApplyDefaults = useCallback(() => {
    const pending = applyDefaultsPrompt;
    setApplyDefaultsPrompt(null);
    if (!pending) return;
    const sid = currentSessionIdRef.current;
    const state = sid ? sessionStates.get(sid) : undefined;
    if (pending.modelRef) {
      setModelRef(pending.modelRef);
      if (state) state.modelRef = pending.modelRef;
    }
    if (pending.promptMode) {
      setPromptMode(pending.promptMode);
      if (state) state.promptMode = pending.promptMode;
    }
    if (pending.thinkingMode) {
      setThinkingMode(pending.thinkingMode);
      if (state) state.thinkingMode = pending.thinkingMode;
    }
    if (pending.agentMode) {
      setAgentMode(pending.agentMode);
      if (state) state.agentMode = pending.agentMode;
    }
    if (typeof pending.webSearch === 'boolean') {
      setWebSearch(pending.webSearch);
      if (state) state.webSearch = pending.webSearch;
    }
    if (pending.mcpEnabled && sid) {
      // 整体覆盖当前会话的启用列表：先乐观更新可见状态与会话缓存，再交给宿主写入
      // 会话覆盖，完成后 core 回推 setMcpServers（与输入框菜单勾选同一条链路）。
      const desired = new Set(pending.mcpEnabled);
      setMcpServers((prev) => prev.map((server) => ({ ...server, enabled: desired.has(server.name) })));
      const cached = mcpServersBySessionRef.current.get(sid);
      if (cached) {
        mcpServersBySessionRef.current.set(
          sid,
          cached.map((server) => ({ ...server, enabled: desired.has(server.name) })),
        );
      }
      postMessage({ type: 'setMcpEnabledList', sessionId: sid, names: pending.mcpEnabled });
    }
  }, [applyDefaultsPrompt, sessionStates]);

  // 勾选/取消某个 MCP：交给 extension 写入当前会话 meta.json，
  // 成功后 extension 回推最新列表（setMcpServers）刷新 UI。这里先乐观更新，
  // 避免等待往返造成勾选延迟；带上 sessionId 让宿主写入正确的会话。
  // 乐观更新同时写会话缓存：缓存与可见状态是同一事实的两份投影，
  // 只写一份的话「快速切走再切回」会短暂显示旧值（缓存读路径）。
  const handleMcpToggle = useCallback((name: string, enabled: boolean) => {
    setMcpServers((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
    const sid = currentSessionIdRef.current;
    if (sid) {
      const cached = mcpServersBySessionRef.current.get(sid);
      if (cached) {
        mcpServersBySessionRef.current.set(
          sid,
          cached.map((s) => (s.name === name ? { ...s, enabled } : s)),
        );
      }
    }
    postMessage({ type: 'setMcpEnabled', name, enabled, sessionId: currentSessionIdRef.current ?? undefined });
  }, []);

  // MessagesView 的回调保持引用稳定，避免 App 其他状态变化导致
  // MessagesView 默认 memo 比较失效而整体重渲染。
  const handleExpandCompact = useCallback(() => {
    const sid = currentSessionIdRef.current;
    if (sid && hasCompactArchive && !isCompactExpanded) {
      setIsCompactExpanded(true);
      postMessage({
        type: 'expandCompact',
        sessionId: sid,
      });
    }
  }, [hasCompactArchive, isCompactExpanded]);

  // 同步 userChoiceRequest 到 ref
  useEffect(() => {
    userChoiceRequestRef.current = userChoiceRequest;
  }, [userChoiceRequest]);

  // 切换会话时把 MCP 列表切换为该会话的缓存（可能为空，随后端回推填充）。
  // 避免上一个会话的「连接中」状态误禁用新会话的发送按钮。
  useEffect(() => {
    setMcpServers(currentSessionId ? (mcpServersBySessionRef.current.get(currentSessionId) ?? []) : []);
  }, [currentSessionId]);

  // 当前会话是否有 MCP 处于「连接中」（已启用但尚未连接成功、且无错误）。
  // 连接中禁用发送按钮，避免在不完整的工具集下发出消息。
  const mcpConnecting = mcpServers.some((s) => s.enabled && !s.running && !s.error);

  // 当 userChoiceRequest 弹出时，递增 forceScrollKey 触发底部自动滚动
  const prevUserChoiceRef = useRef<typeof userChoiceRequest>(null);
  useEffect(() => {
    if (userChoiceRequest && !prevUserChoiceRef.current) {
      setForceScrollKey((prev) => prev + 1);
    }
    prevUserChoiceRef.current = userChoiceRequest;
  }, [userChoiceRequest]);

  /**
   * 后台预热的「新对话」视图（Electron 专属，见 electron/ChatViewManager.ts 的 prewarmKey）。
   *
   * 这类视图的页面照常加载（所以被切到前台时不需要再等加载），但跳过部分启动初始化：
   *   - 不生成 session：启动就生成会让 core 为一个可能永远不用的会话预创建
   *     引擎 / MCP 引用；
   *   - 不请求技能 / 模型 / MCP / settings 默认值：它们的回包发给「当前活动视图」，
   *     预热视图在后台收不到。
   * 主题 / 上下文限制例外：宿主按「来源 webContents」直发回包，预热视图能收到，
   * 照常请求以便在后台就把真实 UI 渲染出来。
   * 等宿主把它切到前台并发来 activatePrewarmedView 时，再补做上述被跳过的初始化 ——
   * 此时它就是活动视图，所有回包都能正确送达。
   */
  const prewarmPendingRef = useRef(getIsPrewarmView());
  // onStartup 由 useCallback 创建，依赖变化时会重建；用 ref 保证激活时拿到最新实现
  const onStartupRef = useRef(onStartup);
  onStartupRef.current = onStartup;

  // 组件启动时主动请求主题和上下文限制（无延迟，确保尽早收到）
  useEffect(() => {
    // 主题 / 上下文限制的回包由宿主按「来源 webContents」直发（见 electron/main.ts），
    // 预热视图也能正确收到，所以照常请求 —— 让它在后台就渲染出真实 UI，
    // 被切到前台时不出现 Loading 一闪。
    postMessage({ type: 'requestTheme' });
    // 挂载时还没有模型身份（modelRef 为 undefined）：宿主按 active provider 的默认模型算。
    postMessage({ type: 'requestContextLimit', model: modelRef?.model, provider: modelRef?.provider });
    if (prewarmPendingRef.current) return;
    // 其余请求的回包走「当前活动视图」，预热视图在后台收不到，等激活时再补（见下）
    postMessage({ type: 'requestSkills' });
    postMessage({ type: 'requestMcpServers' });
    postMessage({ type: 'requestModels' });
    // 请求 settings.json 中的默认值（model / thinkingMode / agentMode），
    // 使新对话创建时能一次性使用正确默认值，避免先显示 manual 再跳变
    postMessage({ type: 'requestSettingsDefaults' });
  }, []);

  // 组件启动时异步加载对话列表
  useEffect(() => {
    // 预热视图：等被切到前台（activatePrewarmedView）后再初始化
    if (prewarmPendingRef.current) return;
    // 延迟加载，避免阻塞初始化
    const timer = setTimeout(() => {
      loadConversations();
      // 运行时状态只在变化时推：本视图可能在等待状态产生之后才创建，主动拉一次快照，
      // 否则对话树流水灯 / abort 按钮会一直"失明"到下一次状态变化。
      postMessage({ type: 'requestSessionRuntimeStates' });
      // Electron 侧栏点击打开对话时：视图创建时就绑定了目标会话（URL 参数 / preload 注入），
      // 由本视图主动请求加载；没有目标会话时创建新对话。
      // loading 由 useConversationLoading 在视图初始化时进入（见 initialSessionId）。
      if (initialSessionId) {
        postMessage({ type: 'loadConversation', sessionId: initialSessionId });
      } else {
        onStartup();
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [loadConversations]);

  // 预热视图被宿主切到前台：补做启动初始化
  useEffect(() => {
    if (!prewarmPendingRef.current) return;
    const handleActivate = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type !== 'activatePrewarmedView') return;
      if (!prewarmPendingRef.current) return;
      prewarmPendingRef.current = false;
      // 先生成 session 并上报（startNewConversation）：
      // 宿主的 MCP 面板等按「当前会话」取数，必须先有会话 ID。
      onStartupRef.current();
      // 此刻视图已是活动视图：所有「发给活动视图」的回包都能正确送达
      postMessage({ type: 'requestSkills' });
      postMessage({ type: 'requestMcpServers' });
      postMessage({ type: 'requestModels' });
      postMessage({ type: 'requestSettingsDefaults' });
      loadConversations();
      // 同启动路径：补一次运行时状态快照（预热视图创建时同样可能错过广播）
      postMessage({ type: 'requestSessionRuntimeStates' });
    };
    window.addEventListener('message', handleActivate);
    // 告诉宿主「已挂载、可以收消息」：若点「新建」时页面还在加载，
    // 宿主直发的激活消息会丢，这里由宿主收到 ready 后补发。
    postMessage({ type: 'prewarmViewReady' });
    return () => window.removeEventListener('message', handleActivate);
  }, [loadConversations]);

  // 键盘监听：在选择框模式下按 1-9 选择选项
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // 只在选择框模式下响应
      if (!userChoiceRequest) return;

      // 如果焦点在选择框的文本输入框中，不响应数字键
      if (document.activeElement === choiceInputRef.current) return;

      // 检查是否按了 1-9 键
      const key = e.key;
      const num = parseInt(key, 10);
      if (num >= 1 && num <= 9) {
        // 检查是否有对应的选项
        if (num <= (userChoiceRequest.choices?.length ?? 0)) {
          e.preventDefault();
          handleUserChoiceResponse(num - 1); // 转换为 0-based 索引
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, { capture: true });
  }, [userChoiceRequest]);

  // 选择框显示/隐藏时的焦点管理
  useEffect(() => {
    if (!userChoiceRequest) {
      // 选择框关闭：焦点回到主输入框，并恢复输入框内容
      // 延迟一下确保 DOM 已更新
      setTimeout(() => {
        const saved = savedMainInputRef.current;
        if (saved) {
          inputAreaRef.current?.setValue(saved);
          savedMainInputRef.current = '';
        }
        mainInputRef.current?.focus();
        const currentInput = inputAreaRef.current?.getValue() ?? '';
        const pos = Math.min(cursorPositionRef.current ?? currentInput.length, currentInput.length);
        mainInputRef.current?.setSelectionRange(pos, pos);
      }, 50);
    } else {
      // 选择框打开：焦点移到 overlay 的文本输入框，确保数字键可被直接响应
      setTimeout(() => {
        // 优先聚焦到第一个选项按钮，使用户可以直接按 1-9 选择
        // 如果用户想输入文本，按 Tab 可切换到输入框
        const firstButton = document.querySelector('.user-choice-button') as HTMLElement;
        if (firstButton) {
          firstButton.focus();
        } else {
          choiceInputRef.current?.focus();
        }
      }, 50);
    }
  }, [userChoiceRequest]);

  const isDark = theme === 'dark';

  // 使用 useMemo 缓存 colors 对象，避免每次 App 重渲染都新建
  const colors = useMemo(() => getColors(isDark), [isDark]);

  // 同步浏览器状态栏 / 地址栏配色（移动端顶部系统预留区）。
  // 页面内容画不到那块区域，未设置 theme-color 时浏览器会填成白色，
  // 深色界面下顶部就会多出一条白条（刘海机型更高、更明显）。
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colors.bg);
  }, [colors.bg]);

  // 独立宿主（Electron / 浏览器端）的 html/body 兜底背景由 .standalone-host 提供，
  // 必须随主题切换同步 class：内容区大多是透明底（.app-viewport backgroundColor:
  // transparent），根背景不跟着换的话，切到浅色后整块区域仍是深色，看起来就像
  // 「主题没生效」。Main.tsx 只在启动时按 __initialTheme 加一次，运行期靠这里补齐。
  useEffect(() => {
    const root = document.documentElement;
    if (!root.classList.contains('standalone-host')) return;
    root.classList.toggle('theme-light', theme === 'light');
  }, [theme]);

  // 排队消息横幅必须与会话绑定：若全局 queuedMessage 仍停留在上一个会话
  // （例如切换会话后的短暂加载期），不把它传给输入区，避免“串会”显示。
  const activeQueuedMessage =
    queuedMessage && currentSessionId && queuedMessage.sessionId === currentSessionId
      ? queuedMessage
      : null;
  // 空闲挂起横幅同理会话绑定：ref 按会话存事实，渲染时派生当前会话的挂起项
  //（version 递增保证 ref 变更后重渲染，读值在渲染期，无陈旧投影）
  const activeIdleSuspended: IdleSuspendedMessage | null =
    currentSessionId ? idleSuspendedRef.current.get(currentSessionId) ?? null : null;
  void idleSuspendedVersion;






  if (!themeInitialized) {
    return (
      <div className="app-viewport w-full flex items-center justify-center" style={{ backgroundColor: 'transparent', overflow: 'clip' }}>
        {/* 文案颜色跟随主题：浅色下写死的 #9f9fa9 对比度不足（约 2.3:1） */}
        <div className="text-[13px]" style={{ color: colors.textSystem }}>{t('app.loading')}</div>
      </div>
    );
  }

  // LLM 配置面板：以覆盖层形式渲染，打开/关闭时不卸载对话页面，
  // 避免输入框内已输入但未发送的内容被清空。
  // 载荷未到达时不渲染（webview 不补默认值，也不打开空面板）。
  const settingsPanel = llmConfigPayload ? (
    <LLMConfigPanel
      colors={colors}
      initialBaseURL={llmConfigPayload.baseURL}
      initialWebSearch={llmConfigPayload.webSearch}
      initialThinkingEffort={llmConfigPayload.thinkingEffort}
      initialDefaultAgentMode={llmConfigPayload.defaultAgentMode}
      initialDefaultPromptMode={llmConfigPayload.defaultPromptMode}
      initialApiKey={llmConfigPayload.apiKey}
      initialLanguage={llmConfigPayload.language}
      initialFontSize={llmConfigPayload.fontSize}
      initialProviders={llmConfigPayload.providers}
      initialActiveProvider={llmConfigPayload.activeProvider}
      initialMcpServers={llmConfigPayload.mcpServers}
      currentSessionId={currentSessionId}
      currentModel={modelRef?.model ?? ''}
      currentProvider={modelRef?.provider ?? ''}
      onClose={() => {
        setLlmConfigPayload(null);
        // 关闭设置后把焦点还给主输入框，继续输入不受影响
        setTimeout(() => mainInputRef.current?.focus(), 0);
      }}
    />
  ) : null;

  // 未打开工作目录时：只提示，不给操作入口 —— 打开/切换工作目录由 IDE 自己管理
  // （VS Code: File → Open Folder…；Electron: File → Open Workspace Folder…）。
  if (noWorkspace) {
    return (
      <div
        className="app-viewport w-full flex flex-col items-center justify-center gap-4"
        style={{
          backgroundColor: 'transparent',
          position: 'relative',
          overflow: 'clip',
          padding: '24px',
        }}
      >
        <DecorativeLogo src={getPlaceholderLogoUri()} variant="empty" opacity={0.8} />
        <div
          className="text-[13px] text-center"
          style={{ color: colors.textSystem, maxWidth: '320px' }}
        >
          {t('app.openWorkspaceHint')}
        </div>
        {settingsPanel}
      </div>
    );
  }

  return (
    <>
      <style>{`
        /* CSS variables at :root level so portal-rendered popups can also inherit them */
        :root {
          --border-color: ${colors.border};
          --text-secondary: ${colors.textSystem};
          --bg-secondary: ${colors.bgSecondary};
          --bg-primary: ${colors.bg};
          --primary-frame: ${colors.primaryFrame};
          --text-primary: ${colors.textPrimary};
          --harness: ${colors.harness};
          --scrollbar-color: ${colors.harness}80;
          --scrollbar-hover-color: ${colors.textSystem};
        }
        /* Agent mode menu — basic structural styles only (background/text handled by ConfigProvider theme tokens) */
        .agent-mode-menu .ant-dropdown-menu-item-disabled,
        .agent-mode-menu .ant-dropdown-menu-item-disabled:hover,
        .agent-mode-menu .ant-dropdown-menu-item-disabled:active {
          background-color: transparent !important;
          cursor: default !important;
          opacity: 1 !important;
          padding: 0 !important;
          height: auto !important;
          line-height: normal !important;
        }
      `}</style>
      <div
        key={`locale-${localeVersion}`}
        className={`app-viewport w-full flex flex-col overflow-hidden ${theme}`}
        style={{
          backgroundColor: 'transparent',
          color: colors.textPrimary,
          position: 'relative',
          // 根容器不允许任何形式的滚动（包括 focus/scrollIntoView 引发的隐藏滚动），
          // 否则加载长对话时整个页面（含标题栏/输入框）会被文档滚动带偏。
          overflow: 'clip',
          '--border-color': colors.border,
          '--text-secondary': colors.textSystem,
          '--bg-secondary': colors.bgSecondary,
          '--bg-primary': colors.bg,
          '--primary-frame': colors.primaryFrame,
          '--text-primary': colors.textPrimary,
          '--harness': colors.harness,
          '--scrollbar-color': colors.harness + '80', // 半透明 0.5 opacity
          '--scrollbar-hover-color': colors.textSystem,
        } as React.CSSProperties}
      >
        {/* Header */}
        <div
          className="px-4 py-2 border-b flex justify-between items-center"
          style={{
            borderColor: colors.border,
            backgroundColor: 'transparent',
            // 刻意不使用 env(safe-area-inset-top) 做顶部留白：
            // 普通浏览器标签页里浏览器 UI 已经占住了状态栏区域，
            // 全屏时该值又会变成状态栏/挖孔高度，两种情况都会在顶部多出一条空白。
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* 子对话返回按钮：与列表选会话共用 navigateToSession，避免出现「绕过 loading」的第二条入口。
                跨工作区对话（specs/025 FR-002）按 creator 跳发起方工作区，本地子代理按父会话跳 */}
            {(parentSessionId || (creator?.kind === 'agent' && creator.workspaceId)) && (
              <button
                onClick={() => {
                  if (creator?.kind === 'agent' && creator.workspaceId) {
                    navigateToSession(creator.sessionId, creator.workspaceId);
                  } else if (parentSessionId) {
                    navigateToSession(parentSessionId);
                  }
                }}
                className="w-6 h-6 rounded flex items-center justify-center transition-colors shrink-0 hover:bg-white/10"
                style={{ color: colors.textSystem }}
                title={t('app.backToParent')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
            <h1 className="ui-fs-13 font-semibold truncate" style={{ color: colors.textPrimary }}>{conversationTitle}</h1>
          </div>
          <div className="flex items-center gap-2">
            {rendersConversationListInWebview(hostInfo) && (
            <Dropdown
              open={conversationDropdownOpen}
              onOpenChange={(open) => {
                if (deleteConfirm && !open) {
                  return;
                }
                setConversationDropdownOpen(open);
                // 在 Dropdown 真正打开时再刷新列表，避免按钮 onClick 与
                // Dropdown 自身的开合逻辑竞争，高负载下导致菜单刚打开就关闭。
                if (open) {
                  loadConversations();
                }
              }}
              trigger={deleteConfirm ? [] : ['click']}
              placement="bottomRight"
              getPopupContainer={() => document.body}
              dropdownRender={() => {
                // 弹层右缘贴锚点（历史按钮右缘，bottomRight）。宽度上限 = 视口宽 -
                // 锚点到窗口右缘的固定 chrome：右内边距 16 + 新建按钮 32 + 间距 8
                // （多视图再加关闭按钮 32 + 间距 8）。纯 CSS 口径让宽度随窗口宽度
                // 实时变化（打开状态下拖拽缩放浮窗同样生效，与 VS Code 面板行为
                // 一致），且左缘恒 >= 0——antd 对左越界不做水平回移，打开瞬间实测
                // 一次的口径在缩放中的窗口里会越界。上限 400 由 width 收口。
                const dropdownChrome = 56 + (canCloseConversation(hostInfo) ? 40 : 0);
                return (
                <div
                  className="conversation-dropdown"
                  onScroll={handleConversationScroll}
                  style={{
                    width: '400px',
                    maxWidth: `calc(100vw - ${dropdownChrome}px)`,
                    maxHeight: '400px',
                    overflowY: 'auto',
                    backgroundColor: colors.primaryFrame,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '8px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  } as any}
                >
                  <div className="p-2">
                    <div
                      className="ui-fs-13 font-semibold mb-2"
                      style={{ color: colors.textPrimary }}
                    >
                      {t('app.conversationHistory')}
                    </div>
                    {conversationsLoading ? (
                      <div
                        className="flex items-center justify-center gap-2 p-4"
                        style={{ color: colors.textSystem }}
                      >
                        <div
                          className="animate-spin"
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: '50%',
                            border: '2px solid transparent',
                            borderTopColor: colors.harness,
                            borderRightColor: colors.harness,
                          }}
                        />
                        <span className="ui-fs-12">{t('app.loadingConversations')}</span>
                      </div>
                    ) : conversations.length === 0 ? (
                      <div
                        className="ui-fs-12 p-4 text-center"
                        style={{ color: colors.textSystem }}
                      >
                        {t('app.noConversationHistory')}
                      </div>
                    ) : (
                      conversationTree.roots.slice(0, visibleConversationCount).map((item: any) => (
                        <ConversationTreeItem
                          key={item.sessionId + '-' + (item.title || '')}
                          item={item}
                          isActive={item.sessionId === currentSessionId}
                          isRoot={true}
                          isExpanded={
                            expandedSubSessions[item.sessionId] === undefined
                              // 默认：当前选中对话展开；子代理数达到上限时不自动展开，
                              // 避免批量委派的对话把列表撑满（用户仍可手动展开）
                              ? item.sessionId === currentSessionId
                                && shouldAutoExpandSubSessions(
                                  (conversationTree.childrenMap.get(item.sessionId) ?? []).length,
                                )
                              : expandedSubSessions[item.sessionId]
                          }
                          isIdle={getSessionIdleState(item.sessionId)}
                          isWaitingForUser={getSessionWaitingState(item.sessionId)}
                          completionAttention={completionAttention}
                          getSessionIdleState={getSessionIdleState}
                          getSessionWaitingState={getSessionWaitingState}
                          onToggle={() => _toggleSubSession(item.sessionId)}
                          onSelect={() => {
                            const _t0_save = performance.now();
                            saveCurrentSessionSnapshot();
                            navigateToSession(item.sessionId);
                            setConversationDropdownOpen(false);
                            profileLog(`[Profile] onSelect(发送loadConversation) | session=${item.sessionId.substring(0, 20)} | save+postMsg耗时=${(performance.now() - _t0_save).toFixed(2)}ms`);
                          }}
                          onDelete={() => {
                            setDeleteConfirm({
                              sessionId: item.sessionId,
                              title: item.title,
                            });
                          }}
                          colors={colors}
                          formatRelativeTime={formatRelativeTime}
                          children={conversationTree.childrenMap.get(item.sessionId) || []}
                          childMap={conversationTree.childrenMap}
                          currentSessionId={currentSessionId}
                          expandedSubSessions={expandedSubSessions}
                          onToggleSub={_toggleSubSession}
                          depth={1}
                          onChildSelect={(sessionId) => {
                            navigateToSession(sessionId);
                            setConversationDropdownOpen(false);
                          }}
                          onChildDelete={(sessionId, title) => {
                            setDeleteConfirm({ sessionId, title });
                          }}
                          onSmartNaming={(sessionId) => {
                            // 标记为命名中
                            setNamingSessions(prev => {
                              const next = new Set(prev);
                              next.add(sessionId);
                              return next;
                            });
                            // 获取该会话的消息用于 AI 命名
                            postMessage({
                              type: 'requestSmartNaming',
                              sessionId,
                            });
                          }}
                          namingSessions={namingSessions}
                        />
                      ))
                    )}
                  </div>
                </div>
                );
              }}
            >
              <button
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors${historyButtonAttention ? ' history-btn--attention' : ''}`}
                style={{ backgroundColor: colors.bgTertiary }}
                title={historyButtonAttention ? t('app.conversationHistoryPending') : t('app.conversationHistory')}
              >
                {/* 提醒态的图标颜色由 .history-btn--attention 按主题给（亮色用更深的琥珀） */}
                <Icon name="history" size={14} style={historyButtonAttention ? undefined : { color: colors.textSystem }} />
              </button>
            </Dropdown>
            )}
            {/* 新对话按钮（Electron 完整模式下由侧栏"新建"接管） */}
            {newConversationEntryOf(hostInfo) === 'webview' && (
            <button
onClick={handleNewConversation}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ backgroundColor: colors.bgTertiary }}
              title={t('app.newChat')}
            >
              <Icon name="plus" size={16} style={{ color: colors.textSystem }} />
            </button>
            )}
            {/* 关闭按钮（多视图模式）：销毁当前 webview，释放渲染进程资源 */}
            {canCloseConversation(hostInfo) && (
            <button
              onClick={() => postMessage({ type: 'closeWebview' })}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-red-500/20 group"
              style={{ backgroundColor: colors.bgTertiary }}
              title={t('app.closeChat')}
            >
              <Icon name="x" size={16} style={{ color: colors.textSystem }} />
            </button>
            )}
          </div>
        </div>

        {/* Messages Area */}
        <MessagesView
          messages={messages}
          containerRef={messagesContainerRef}
          userScrolledAwayRef={userScrolledAwayRef}
          isLoadingConversation={isLoadingConversation}
          showThinkingAnimation={showThinkingAnimation}
          animationMode={animationMode}
          isDark={isDark}
          colors={colors}
          forceScrollKey={forceScrollKey}
          streamingVersion={streamingVersion}
          hasCompactArchive={hasCompactArchive}
          isCompactExpanded={isCompactExpanded}
          onExpandCompact={handleExpandCompact}
          onNavigate={navigateToSession}
        />

        {/* Input Area — 条件渲染 UserChoiceOverlay / InputArea，保持相同位置 */}
        <div
          className="px-4 pt-2"
          style={{
            flexShrink: 0,
            // 底部安全区：仅在系统手势条/圆角比常规留白更高时才生效（max 而非相加），
            // 避免普通浏览器下多出一截空白；桌面 / VS Code 下 env() 为 0，等于 1rem。
            paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))',
          }}
        >
          {userChoiceRequest ? (
            <UserChoiceOverlay
              userChoiceRequest={userChoiceRequest}
              onChoiceResponse={handleChoiceResponse}
              onSubmit={handleUserChoiceSubmit}
              onAnswersSubmit={handleAnswersSubmit}
              inputFocused={inputFocused}
              choiceInputRef={choiceInputRef}
              inputSyncRef={userChoiceInputRef}
              initialInputValue={userChoiceInputRef.current || ''}
              colors={colors}
            />
          ) : (
            <InputArea
              ref={inputAreaRef}
              inputFocused={inputFocused}
              setInputFocused={setInputFocused}
              currentFile={currentFile}
              selectedLines={selectedLines}
              fileHidden={fileHidden}
              onToggleFileHidden={handleToggleFileHidden}
              totalContextTokens={contextLength}
              maxContextTokens={maxContextTokens}
              compactPending={compactPending}
              abortButtonState={abortButtonState}
              todoProgress={todoProgress}
              sessionId={currentSessionId}
              abortHoverDetail={abortHoverDetail}
              agentMode={agentMode}
              setAgentMode={setAgentMode}
              promptMode={promptMode}
              setPromptMode={setPromptMode}
              thinkingMode={thinkingMode}
              setThinkingMode={setThinkingMode}
              webSearch={webSearch}
              setWebSearch={setWebSearch}
              modelRef={modelRef}
              setModelRef={setModelRef}
              providerModels={providerModels}
              onSend={handleSend}
              onSendIdle={handleSendIdle}
              onAbort={handleAbort}
              onCompress={handleCompress}
              onEditQueuedMessage={handleEditQueuedMessage}
              onDeleteQueuedMessage={handleDeleteQueuedMessage}
              idleSuspendedMessage={activeIdleSuspended}
              onEditIdleSuspended={handleEditIdleSuspended}
              onDeleteIdleSuspended={handleDeleteIdleSuspended}
              mainInputRef={mainInputRef as React.RefObject<HTMLTextAreaElement | null>}
              colors={colors}
              isDark={isDark}
              queuedMessage={activeQueuedMessage}
              skills={skills}
              workspaces={workspaces}
              mcpServers={mcpServers}
              onMcpToggle={handleMcpToggle}
              mcpConnecting={mcpConnecting}
              configLoading={!configReady}
              commandHistory={commandHistoryRef.current.get(currentSessionIdRef.current ?? '') ?? []}
              balance={balance}
              balanceCurrency={balanceCurrency}
              isUnlimited={isUnlimited}
              totalCacheReadInputTokens={sessionStates.get(currentSessionIdRef.current ?? '')?.totalCacheReadInputTokens}
              totalCacheCreationInputTokens={sessionStates.get(currentSessionIdRef.current ?? '')?.totalCacheCreationInputTokens}
              totalInputTokens={sessionStates.get(currentSessionIdRef.current ?? '')?.totalInputTokens}
              onOpenSettings={handleOpenSettings}
              isProviderConfigured={providerConfigured}
              creator={creator}
              subAgentRole={subAgentRole}
              workMode={workMode}
            />
          )}
        </div>

                {/* (non-Latin text removed for matching) */}
        {deleteConfirm && (
          <DeleteConfirmDialog
            deleteConfirm={deleteConfirm}
            colors={colors}
            onCancel={() => setDeleteConfirm(null)}
            onConfirm={(sessionId) => {
              // 删除的是当前打开的对话时，跳过「删除中保持面板打开」的标记。
              const isCurrent = sessionId === currentSessionIdRef.current;
              if (!isCurrent) {
                isDeletingRef.current = true;
              }
              postMessage({ type: 'deleteConversation', sessionId });
              setDeleteConfirm(null);
              if (isCurrent) {
                setConversationDropdownOpen(false);
                // 多视图宿主：删除由宿主连同该会话的视图一起关（见 electron/main.ts 的
                // deleteConversationWithViews），关掉当前视图后宿主会另开一个新对话视图，
                // 本视图随即被销毁，不能再自己新建（会多开一个视图）。
                // 单视图宿主没有可关的视图，在当前视图内原地新建即可。
                if (openConversationModeOf(hostInfo) === 'loadConversation') {
                  handleNewConversation();
                }
              }
            }}
          />
        )}
        {applyDefaultsPrompt && (
          <ApplyDefaultsDialog
            prompt={applyDefaultsPrompt}
            colors={colors}
            onDismiss={() => setApplyDefaultsPrompt(null)}
            onApply={handleApplyDefaults}
          />
        )}
        {settingsPanel}
        <NoticeToast notices={notices} colors={colors} onDismiss={dismissNotice} />
      </div>

    </>
  );
}

export default App;
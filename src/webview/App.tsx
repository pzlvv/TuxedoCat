import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Icon } from './Icon';
import 'github-markdown-css/github-markdown.css';
import { Dropdown } from 'antd';
import InputArea, { InputAreaRef } from './InputArea';
import MessagesView from './MessagesView';
import 'antd/dist/reset.css';
import type { Message, QueuedMessagePayload, UserChoiceRequest, SessionState, Theme, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, ProviderConfig, PreviewPayload } from './types';
import { createSessionState } from './sessionState';

import UserChoiceOverlay from './UserChoiceOverlay';
import LLMConfigPanel from './LLMConfigPanel';
import PreviewOverlay from './PreviewOverlay';
import { postMessage, getLogoUri, getHasWorkspace, LOGO_CLASS_NAME, getHostInfo, navigateToConversation } from './webviewEnv';
import { DEFAULT_WAKE_SHORTCUT } from '../core/utils/shortcut.js';
import type { McpServerInfo } from '../core/webviewTypes';
import { t } from './i18n';
import { ConversationTreeItem } from './ConversationTreeItem';
import { DeleteConfirmDialog } from './components/DeleteConfirmDialog';
import { getColors } from './colors';
import { useConversationTree } from './hooks/useConversationTree';
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
  const [theme, setTheme] = useState<Theme>('dark');
  const [themeInitialized, setThemeInitialized] = useState(false);
  // 检查是否已打开工作目录（由 extension 在 HTML 注入）
  const noWorkspace = getHasWorkspace() === false;
  // 宿主能力声明：决定对话列表 / 新建对话 / 关闭按钮等由谁渲染
  const hostInfo = getHostInfo();
  const [messages, setMessages] = useState<Array<Message>>([]);
  const inputAreaRef = useRef<InputAreaRef>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [currentFile, setCurrentFile] = useState<string>('');
  const [selectedLines, setSelectedLines] = useState<{ start: number; end: number } | null>(null);
  const [fileHidden, setFileHidden] = useState(true);
  const [showThinkingAnimation, setShowThinkingAnimation] = useState(false);
  const [animationMode, setAnimationMode] = useState<'thinking' | 'compacting'>('thinking');
  // 界面语言变化版本号：递增后通过 key 重挂载内容区，使所有 t() 文案按新语言重新渲染
  const [localeVersion, setLocaleVersion] = useState(0);
  // 设置面板中显示的界面语言（来自 settings.json，保存后生效）
  const [llmConfigLanguage, setLlmConfigLanguage] = useState<'auto' | 'zh' | 'en'>('auto');
  // 设置面板中显示的唤醒快捷键（仅 Electron 使用，accelerator 形式）
  const [llmConfigShortcut, setLlmConfigShortcut] = useState<string>(DEFAULT_WAKE_SHORTCUT);

  // 对话历史状态
  const [conversations, setConversations] = useState<Array<any>>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  // 插件模式（webview 渲染对话列表）下，历史对话分页展示：默认 50 条，滚动到底再加载 50 条
  const [visibleConversationCount, setVisibleConversationCount] = useState(50);
  const CONVERSATION_PAGE_SIZE = 50;
  // App 模式（Electron）下：正在加载对话（conversationLoaded 尚未到达）的 loading 状态
  const [isLoadingConversation, setIsLoadingConversation] = useState(false);
  // 子对话展开状态（sessionId -> boolean）
  const [conversationDropdownOpen, setConversationDropdownOpen] = useState(false);
  const [conversationTitle, setConversationTitle] = useState<string>(t('app.untitled'));
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // 当前对话的父会话 ID（子对话时有效）
  const [parentSessionId, setParentSessionId] = useState<string | null>(null);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const [contextLength, setContextLength] = useState<number>(0);
  const [maxContextTokens, setMaxContextTokens] = useState<number | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>('risk');
  /** agentMode 是否已收到会话/默认值；未收到前 UI 显示 loading，不展示具体模式 */
  const [agentModeReady, setAgentModeReady] = useState(false);
  const agentModeReadyRef = useRef(false);
  /** 会话关联的提示词模式（普通/极简/混合），持久化到 meta.json */
  const [promptMode, setPromptMode] = useState<PromptMode>('normal');
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('off');
  const [webSearch, setWebSearch] = useState<boolean>(false);
  const [model, setModel] = useState<string>('deepseek-v4-flash');
  const [models, setModels] = useState<string[]>(['deepseek-v4-flash', 'deepseek-v4-pro']);
  // settings.json 中的默认值（新对话创建时一次性使用，避免先显示 risk 再跳变）
  const [settingsDefaults, setSettingsDefaults] = useState<SettingsDefaults>({
    model: 'deepseek-v4-flash',
    thinkingMode: 'off',
    agentMode: 'risk',
    promptMode: 'normal',
    webSearch: false,
  });
  // 全局余额信息（与会话无关）
  const [balance, setBalance] = useState<number | undefined>(undefined);
  const [balanceCurrency, setBalanceCurrency] = useState<string | undefined>(undefined);
  const [isUnlimited, setIsUnlimited] = useState<boolean | undefined>(undefined);
  // 压缩展开状态
  const [hasCompactArchive, setHasCompactArchive] = useState(false);
  const [isCompactExpanded, setIsCompactExpanded] = useState(false);
  // 排队消息状态
  // queuedMessage 仅用于展示"当前会话"的排队横幅；
  // queuedMessageRef 按 sessionId 存储排队消息，保证排队消息与会话绑定，
  // 切换会话后排队消息仍归属原会话，不会被误投递到其他会话。
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessagePayload | null>(null);
  const queuedMessageRef = useRef<Map<string, QueuedMessagePayload>>(new Map());
  // 记录用户主动点击 abort 的会话。queryEnd 到达时用于判断：
  // 若该会话仍有排队消息，则不重新发送它，而是回填到输入框由用户自行修改。
  const abortedSessionsRef = useRef<Set<string>>(new Set());

  // 正在智能命名的会话 ID 集合
  const [namingSessions, setNamingSessions] = useState<Set<string>>(new Set());

  // LLM 配置面板状态
  const [showLLMConfig, setShowLLMConfig] = useState(false);
  const [llmConfigBaseURL, setLlmConfigBaseURL] = useState('');
  const [llmConfigWebSearch, setLlmConfigWebSearch] = useState(false);
  const [llmConfigThinkingEffort, setLlmConfigThinkingEffort] = useState<ThinkingMode>('off');
  const [llmConfigDefaultAgentMode, setLlmConfigDefaultAgentMode] = useState<AgentMode>('risk');
  const [llmConfigDefaultPromptMode, setLlmConfigDefaultPromptMode] = useState<PromptMode>('normal');
  const [llmConfigApiKey, setLlmConfigApiKey] = useState('');
  const [llmConfigProviders, setLlmConfigProviders] = useState<ProviderConfig[]>([]);
  const [llmConfigActiveProvider, setLlmConfigActiveProvider] = useState('');
  // 设置面板「默认配置」里的 MCP 默认启用列表（全局 settings.json 的 mcp.enabled）
  const [llmConfigMcpServers, setLlmConfigMcpServers] = useState<McpServerInfo[]>([]);
  // 服务商配置是否已完成（activeProvider 存在且 apiKey 非空）；未完成时禁用输入框并引导打开设置。
  // 初始为 null（尚未探测到配置），避免启动时因探测延迟而误显示"请配置模型服务"。
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);

  // 页内预览（仅浏览器端）：查看文件 / 虚拟文档 / diff / Mermaid 时由宿主回推内容，
  // 在这里就地展示，避免打开桌面原生窗口（查看类操作不跨端）。
  const [preview, setPreview] = useState<PreviewPayload | null>(null);

  // Skills for slash-command autocomplete
  const [skills, setSkills] = useState<Array<{ name: string; description: string; isBuiltin?: boolean }>>([]);

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

  // 当 agentMode 变化时通知 extension
  useEffect(() => {
    postMessage({ type: 'setAgentMode', mode: agentMode, sessionId: currentSessionId });
  }, [agentMode]);

  // 当 promptMode 变化时通知 extension（会话级，持久化到 meta.json）
  useEffect(() => {
    if (currentSessionId) {
      postMessage({ type: 'setPromptMode', mode: promptMode, sessionId: currentSessionId });
    }
  }, [promptMode, currentSessionId]);

  // 当 thinkingMode 变化时通知 extension（使其在对话中动态生效）
  useEffect(() => {
    if (currentSessionId) {
      postMessage({ type: 'setThinkingMode', mode: thinkingMode, sessionId: currentSessionId });
    }
  }, [thinkingMode, currentSessionId]);

  // 当 model 变化时通知 extension，并重新请求对应模型的上下文限制
  useEffect(() => {
    if (currentSessionId) {
      postMessage({ type: 'setModel', model, sessionId: currentSessionId });
    }
    postMessage({ type: 'requestContextLimit', model });
  }, [model, currentSessionId]);

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
  // 耗时分布统计（由 core 侧统一计算，webview 只做展示）
  const [stats, setStats] = useState<{
    toolExecution: number; aiThinking: number; humanFeedback: number;
    totalTime: number; toolPct: number; thinkingPct: number; humanPct: number;
    toolCount: number; thinkingCount: number; humanCount: number;
  } | null>(null);
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
  const currentSessionIdRef = useRef<string | null>(null);
  /** 统一设置当前会话 ID，同时同步 ref 和 window.__currentSessionId */
  const setCurrentSessionIdRef = useCallback((sid: string | null) => {
    currentSessionIdRef.current = sid;
    (window as any).__currentSessionId = sid;
  }, []);
  // Per-session state: input, userChoiceRequest, userChoiceInput
  const sessionStatesRef = useRef<Map<string, SessionState>>(new Map());
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
  // 任何已落盘的会话：切换会话时它不会被 sessionStatesRef 保存下来，再点"新建"就丢了。
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
  // 会话运行状态版本号：任意会话 queryBegin/queryEnd 时递增，
  // 强制 App 重渲染，使对话列表的流水灯（running-bar）即时出现/消失。
  const [, setSessionRunningVersion] = useState(0);

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

  // 判断会话是否正在等待用户输入（ask user 提问 / 权限确认）：
  // 查询仍在运行（hasActiveQuery）且存在待响应的 userChoiceRequest 时，流水灯显示黄色。
  const getSessionWaitingState = useCallback((sid: string): boolean => {
    const s = sessionStatesRef.current.get(sid);
    return !!(s?.hasActiveQuery && s?.userChoiceRequest);
  }, []);

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
    setVisibleConversationCount, setIsLoadingConversation,
    setTheme, setThemeInitialized, setCurrentFile, setSelectedLines, setStats,
    setConversationTitle, setMaxContextTokens, setSkills, setMcpServers, setConversationDropdownOpen,
    setCurrentSessionId, setParentSessionId, setAgentMode, setAgentModeReady, setThinkingMode,
    setModel, setWebSearch, setContextLength, setQueuedMessage,
    setUserChoiceRequest, setNamingSessions, setStreamingVersion, setForceScrollKey,
    setSessionRunningVersion,
    setExpandedSubSessions, setModels, setBalance, setBalanceCurrency, setIsUnlimited,
    setCurrentSessionIdRef, setShowLLMConfig, setLlmConfigBaseURL, setLlmConfigWebSearch,
    setLlmConfigThinkingEffort, setLlmConfigDefaultAgentMode, setLlmConfigDefaultPromptMode, setLlmConfigApiKey,
    setLlmConfigProviders, setLlmConfigActiveProvider, setLlmConfigMcpServers,
    setSettingsDefaults, settingsDefaults, setLocaleVersion, setLlmConfigLanguage,
    setLlmConfigShortcut,
    setProviderConfigured,
    setPreview,
    messages,
    currentSessionIdRef, sessionStatesRef, userChoiceRequestRef, userChoiceInputRef,
    agentModeReadyRef, savedMainInputRef, queuedMessageRef, abortedSessionsRef, mcpServersBySessionRef, cursorPositionRef, choiceCursorPositionRef,
    stashNewChatDraft, newChatSessionRef,
    mainInputRef, choiceInputRef, messagesContainerRef, userScrolledAwayRef,
    streamRafRef, toolStatusRafRef, pendingStreamRef, pendingToolStatusRef,
    bufferedToolStatusRef, conversationLoadingRef, isDeletingRef, listLoadedOnceRef,
    toolProgressRafRef, pendingToolProgressRef,
    _appMountTime, model, contextLength,
    inputAreaRef,
    // 当前会话实时状态（切换会话保存快照时使用）
    userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, thinkingMode,
    promptMode, setPromptMode,
    currentFile, selectedLines, stats,
  }), [model, contextLength, settingsDefaults, userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, thinkingMode, promptMode, currentFile, selectedLines, stats, messages]);
  useMessageHandler(handlerProps);

  const appHandlerProps = useMemo(() => ({
    currentFile, selectedLines, fileHidden, conversations, conversationsLoading,
    conversationDropdownOpen, conversationTitle, currentSessionId, parentSessionId,
    hasActiveQuery, contextLength, maxContextTokens, agentMode, thinkingMode,
    promptMode, setPromptMode,
    model, webSearch, settingsDefaults, hasCompactArchive, isCompactExpanded,
    queuedMessage, stats, deleteConfirm, userChoiceRequest,
    showThinkingAnimation, animationMode, messages,
    setCurrentFile, setSelectedLines, setFileHidden, setConversations,
    setConversationsLoading, setConversationDropdownOpen, setConversationTitle,
    setCurrentSessionId, setParentSessionId, setHasActiveQuery, setContextLength,
    setMaxContextTokens, setAgentMode, setThinkingMode,
    setModel, setWebSearch, setHasCompactArchive, setIsCompactExpanded, setQueuedMessage,
    setStats, setDeleteConfirm, setMessages, setUserChoiceRequest,
    setShowThinkingAnimation, setExpandedSubSessions, setNamingSessions,
    currentSessionIdRef, sessionStatesRef, commandHistoryRef, cursorPositionRef,
    choiceCursorPositionRef, userChoiceRequestRef, userChoiceInputRef,
    savedMainInputRef, queuedMessageRef, abortedSessionsRef, mainInputRef, choiceInputRef,
    newChatSessionRef, newChatDraftRef,
    isDeletingRef, listLoadedOnceRef, setCurrentSessionIdRef, inputAreaRef,
    COMMAND_HISTORY_MAX, _appMountTime,
  }), [
    currentFile, selectedLines, fileHidden, conversations, conversationsLoading,
    conversationDropdownOpen, conversationTitle, currentSessionId, parentSessionId,
    hasActiveQuery, contextLength, maxContextTokens, agentMode, thinkingMode,
    promptMode,
    model, webSearch, settingsDefaults, hasCompactArchive, isCompactExpanded,
    queuedMessage, stats, deleteConfirm, userChoiceRequest,
    showThinkingAnimation, animationMode, messages,
  ]);

  const {
    formatRelativeTime, loadConversations, onStartup, handleSend, handleAbort,
    handleCompress, handleUserChoiceResponse, handleUserChoiceSubmit,
    handleChoiceResponse, handleToggleFileHidden,
    toggleSubSession: _toggleSubSession,
  } = useAppHandlers(appHandlerProps as any);

  // 打开设置（LLM 配置）页面：先向扩展请求当前配置值，
  // 扩展回传 showLLMConfig 后由 useMessageHandler 填充配置面板并打开
  /**
   * 保存当前会话快照到 sessionStatesRef，并立即持久化上下文到 meta.json。
   * 三处重复收敛：ConversationTreeItem onSelect / 新对话按钮 / useMessageHandler
   * 的 switchToSession 各自保存一份（switchToSession 的版本字段更多，仍在 hook 内）。
   * 值类型状态（userChoiceRequest / showThinkingAnimation 等）直接读渲染闭包值，
   * 与原三处行为一致。
   */
  const saveCurrentSessionSnapshot = useCallback(() => {
    const sid = currentSessionIdRef.current;
    if (!sid) return;
    const existing = sessionStatesRef.current.get(sid);
    sessionStatesRef.current.set(sid, createSessionState({
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
      contextLength,
      queuedMessage: queuedMessageRef.current.get(sid) ?? null,
      model,
    }));
    postMessage({
      type: 'updateConversationContext',
      sessionId: sid,
      currentFile,
      selectedLines,
      totalContextTokens: contextLength,
    });
  }, [userChoiceRequest, showThinkingAnimation, animationMode, hasActiveQuery, agentMode, promptMode, thinkingMode, contextLength, model, currentFile, selectedLines]);

  /**
   * 导航到目标会话前的固定动作序列（四处重复收敛）：
   * 1. 当前若是"新建但还没发消息"的对话，先把草稿暂存，供下次"新建"恢复；
   * 2. 清空消息并显示加载动画（插件模式与 Electron 模式统一）；
   * 3. 清空当前展示的排队横幅，避免上一会话的 queue 串到新会话；
   * 4. 发送导航消息（VS Code 插件 postMessage / Electron 内置 HTTP 路由）。
   */
  const navigateToSession = useCallback((sessionId: string) => {
    stashNewChatDraft();
    setIsLoadingConversation(true);
    setMessages([]);
    setQueuedMessage(null);
    navigateToConversation(sessionId);
  }, [stashNewChatDraft]);

  const handleNavigateToConversation = navigateToSession;

  /**
   * 新建对话（顶部"+"按钮）：
   * - 保存当前会话快照并持久化上下文；
   * - 暂存"新对话"草稿（未发送过的对话切走时草稿由 stashNewChatDraft 保存）；
   * - 生成新 sessionId，重置全部 UI 状态到 settings.json 默认值；
   * - 把上一个"新对话"里没发出去的草稿带过来，避免切换会话后再新建时内容丢失。
   * 自按钮 onClick 内联约 90 行抽出，行为不变。
   */
  const handleNewConversation = useCallback(() => {
    // Save current session state before switching
    saveCurrentSessionSnapshot();
    // 当前若是"新建但还没发消息"的对话，先把草稿暂存，稍后带到新对话
    stashNewChatDraft();
    // Generate new session for new conversation
    setConversationTitle(t('app.untitled'));
    setParentSessionId(null);
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
    // 新对话使用 settings.json 中的默认值（一次性设置，避免跳变）
    setAgentMode(settingsDefaults.agentMode);
    setThinkingMode(settingsDefaults.thinkingMode);
    setWebSearch(settingsDefaults.webSearch);
    setModel(settingsDefaults.model);
    setPromptMode(settingsDefaults.promptMode);
    setCurrentSessionId(newSessionId);
    setCurrentSessionIdRef(newSessionId);
    // 为新对话创建默认 state
    sessionStatesRef.current.set(newSessionId, createSessionState({
      input: draftInput,
      pastedImages: draftImages.length > 0 ? draftImages : undefined,
      inputCursorPosition: draftCursor,
      choiceCursorPosition: 0,
      agentMode: settingsDefaults.agentMode,
      promptMode: settingsDefaults.promptMode,
      thinkingMode: settingsDefaults.thinkingMode,
      webSearch: settingsDefaults.webSearch,
      model: settingsDefaults.model,
    }));
    postMessage({ type: 'setActiveSessionId', sessionId: newSessionId });
    postMessage({ type: 'startNewConversation', sessionId: newSessionId });
    // 聚焦输入框，并把光标放回草稿里的原位置
    setTimeout(() => {
      mainInputRef.current?.focus();
      mainInputRef.current?.setSelectionRange(draftCursor, draftCursor);
    }, 0);
    // 依赖与 saveCurrentSessionSnapshot 相同（值类型快照来源）；ref 不进依赖数组
  }, [saveCurrentSessionSnapshot, stashNewChatDraft, settingsDefaults]);

  const handleOpenSettings = useCallback(() => {
    postMessage({ type: 'requestLLMConfig' });
  }, []);

  // 勾选/取消某个 MCP：交给 extension 写入当前会话 meta.json，
  // 成功后 extension 回推最新列表（setMcpServers）刷新 UI。这里先乐观更新，
  // 避免等待往返造成勾选延迟；带上 sessionId 让宿主写入正确的会话。
  const handleMcpToggle = useCallback((name: string, enabled: boolean) => {
    setMcpServers((prev) => prev.map((s) => (s.name === name ? { ...s, enabled } : s)));
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

  // 组件启动时主动请求主题和上下文限制（无延迟，确保尽早收到）
  useEffect(() => {
    postMessage({ type: 'requestTheme' });
    postMessage({ type: 'requestContextLimit', model });
    postMessage({ type: 'requestSkills' });
    postMessage({ type: 'requestMcpServers' });
    postMessage({ type: 'requestModels' });
    // 请求 settings.json 中的默认值（model / thinkingMode / agentMode），
    // 使新对话创建时能一次性使用正确默认值，避免先显示 manual 再跳变
    postMessage({ type: 'requestSettingsDefaults' });
  }, []);

  // App 模式（Electron）：侧栏点击打开对话时 URL 带 session 参数（或 preload 注入），
  // 在 conversationLoaded 到达前显示加载动画，替代默认的静态 Logo。
  useEffect(() => {
    if (hostInfo.openConversationMode !== 'openConversation') return;
    const urlSession = new URLSearchParams(window.location.search).get('session');
    const injectedSession = (window as any).__sessionId as string | undefined;
    if (urlSession || injectedSession) {
      setIsLoadingConversation(true);
      // 兜底：若 conversationLoaded 长时间未到达（加载失败等异常场景），自动关闭 loading
      const timer = setTimeout(() => setIsLoadingConversation(false), 15000);
      return () => clearTimeout(timer);
    }
  }, []);

  // 组件启动时异步加载对话列表
  useEffect(() => {
    // 延迟加载，避免阻塞初始化
    const timer = setTimeout(() => {
      loadConversations();
      // Electron 侧栏点击打开对话时：加载指定会话（URL 参数或 preload 注入）
      const urlSession = new URLSearchParams(window.location.search).get('session');
      const injectedSession = (window as any).__sessionId as string | undefined;
      const targetSession = urlSession || injectedSession;
      if (targetSession) {
        postMessage({ type: 'loadConversation', sessionId: targetSession });
      } else {
        onStartup();
      }
    }, 500);

    return () => clearTimeout(timer);
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

  // 排队消息横幅必须与会话绑定：若全局 queuedMessage 仍停留在上一个会话
  // （例如切换会话后的短暂加载期），不把它传给输入区，避免“串会”显示。
  const activeQueuedMessage =
    queuedMessage && currentSessionId && queuedMessage.sessionId === currentSessionId
      ? queuedMessage
      : null;






  if (!themeInitialized) {
    return (
      <div className="app-viewport w-full flex items-center justify-center" style={{ backgroundColor: 'transparent', overflow: 'clip' }}>
        <div className="text-[13px]" style={{ color: '#9f9fa9' }}>{t('app.loading')}</div>
      </div>
    );
  }

  // LLM 配置面板：以覆盖层形式渲染，打开/关闭时不卸载对话页面，
  // 避免输入框内已输入但未发送的内容被清空。
  const settingsPanel = showLLMConfig ? (
    <LLMConfigPanel
      colors={colors}
      initialBaseURL={llmConfigBaseURL}
      initialWebSearch={llmConfigWebSearch}
      initialThinkingEffort={llmConfigThinkingEffort}
      initialDefaultAgentMode={llmConfigDefaultAgentMode}
      initialDefaultPromptMode={llmConfigDefaultPromptMode}
      initialApiKey={llmConfigApiKey}
      initialLanguage={llmConfigLanguage}
      initialShortcut={llmConfigShortcut}
      initialProviders={llmConfigProviders}
      initialActiveProvider={llmConfigActiveProvider}
      initialMcpServers={llmConfigMcpServers}
      currentSessionId={currentSessionId}
      currentModel={model}
      onClose={() => {
        setShowLLMConfig(false);
        // 关闭设置后把焦点还给主输入框，继续输入不受影响
        setTimeout(() => mainInputRef.current?.focus(), 0);
      }}
    />
  ) : null;

  // 未打开工作目录时：提示用户打开工作目录，并提供引导按钮。
  // VS Code 宿主会弹出“打开文件夹”选择器；打开后窗口重载并重新注入 __hasWorkspace。
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
        <img
          src={getLogoUri()}
          alt="logo"
          className={LOGO_CLASS_NAME}
        />
        <div
          className="text-[13px] text-center"
          style={{ color: colors.textSystem, maxWidth: '320px' }}
        >
          {t('app.openWorkspaceHint')}
        </div>
        {hostInfo.kind === 'vscode' && (
          <button
            onClick={() => postMessage({ type: 'openWorkspaceFolder' })}
            className="px-4 py-2 rounded-lg text-[13px] transition-opacity hover:opacity-90"
            style={{
              backgroundColor: colors.harness,
              color: '#ffffff',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {t('app.openWorkspaceButton')}
          </button>
        )}
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
            {/* 子对话返回按钮 */}
            {parentSessionId && (
              <button
                onClick={() => {
                  navigateToConversation(parentSessionId);
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
            <h1 className="text-[13px] font-semibold truncate" style={{ color: colors.textPrimary }}>{conversationTitle}</h1>
          </div>
          <div className="flex items-center gap-2">
            {hostInfo.conversationList === 'webview' && (
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
              dropdownRender={() => (
                <div
                  className="conversation-dropdown"
                  onScroll={handleConversationScroll}
                  style={{
                    width: '400px',
                    maxWidth: 'calc(100vw - 70px)',
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
                      className="text-[13px] font-semibold mb-2"
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
                        <span className="text-[12px]">{t('app.loadingConversations')}</span>
                      </div>
                    ) : conversations.length === 0 ? (
                      <div
                        className="text-[12px] p-4 text-center"
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
                              ? item.sessionId === currentSessionId
                              : expandedSubSessions[item.sessionId]
                          }
                          isRunning={sessionStatesRef.current.get(item.sessionId)?.hasActiveQuery ?? false}
                          isWaitingForUser={getSessionWaitingState(item.sessionId)}
                          getSessionRunningState={(sid: string) => sessionStatesRef.current.get(sid)?.hasActiveQuery ?? false}
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
                              messages: [],
                            });
                          }}
                          namingSessions={namingSessions}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            >
              <button
                className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
                style={{ backgroundColor: colors.bgTertiary }}
                title={t('app.conversationHistory')}
              >
                <Icon name="history" size={14} style={{ color: colors.textSystem }} />
              </button>
            </Dropdown>
            )}
            {/* 新对话按钮（Electron 模式下由侧栏"新建"接管） */}
            {hostInfo.newConversation === 'webview' && (
            <button
onClick={handleNewConversation}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors"
              style={{ backgroundColor: colors.bgTertiary }}
              title={t('app.newChat')}
            >
              <Icon name="plus" size={16} style={{ color: colors.textSystem }} />
            </button>
            )}
            {/* 关闭按钮（Electron app 模式）：销毁当前 webview，释放渲染进程资源 */}
            {hostInfo.closeConversation && (
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
          onNavigate={handleNavigateToConversation}
        />

        {/* Input Area — 条件渲染 UserChoiceOverlay / InputArea，保持相同位置 */}
        <div
          className="px-4 pt-2"
          style={{
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
              hasActiveQuery={hasActiveQuery}
              agentMode={agentMode}
              agentModeReady={agentModeReady}
              setAgentMode={setAgentMode}
              promptMode={promptMode}
              setPromptMode={setPromptMode}
              thinkingMode={thinkingMode}
              setThinkingMode={setThinkingMode}
              webSearch={webSearch}
              setWebSearch={setWebSearch}
              model={model}
              setModel={setModel}
              models={models}
              onSend={handleSend}
              onAbort={handleAbort}
              onCompress={handleCompress}
              mainInputRef={mainInputRef as React.RefObject<HTMLTextAreaElement | null>}
              colors={colors}
              isDark={isDark}
              queuedMessage={activeQueuedMessage}
              skills={skills}
              mcpServers={mcpServers}
              onMcpToggle={handleMcpToggle}
              mcpConnecting={mcpConnecting}
              commandHistory={commandHistoryRef.current.get(currentSessionIdRef.current ?? '') ?? []}
              balance={balance}
              balanceCurrency={balanceCurrency}
              isUnlimited={isUnlimited}
              totalCacheReadInputTokens={sessionStatesRef.current.get(currentSessionIdRef.current ?? '')?.totalCacheReadInputTokens}
              totalCacheCreationInputTokens={sessionStatesRef.current.get(currentSessionIdRef.current ?? '')?.totalCacheCreationInputTokens}
              totalInputTokens={sessionStatesRef.current.get(currentSessionIdRef.current ?? '')?.totalInputTokens}
              onOpenSettings={handleOpenSettings}
              isProviderConfigured={providerConfigured}
              isSubAgent={!!parentSessionId}
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
              isDeletingRef.current = true;
              postMessage({ type: 'deleteConversation', sessionId });
              setDeleteConfirm(null);
            }}
          />
        )}
        {settingsPanel}
        {preview && (
          <PreviewOverlay payload={preview} colors={colors} onClose={() => setPreview(null)} />
        )}
      </div>

    </>
  );
}

export default App;
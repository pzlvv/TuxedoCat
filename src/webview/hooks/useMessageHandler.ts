import React, { useEffect, useRef } from 'react';
import type { WebviewMessage } from '../../core/webviewTypes';
import type { DiffHunk } from '../../core/utils/editDiff';
import type { Message, UserChoiceRequest, SessionState, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, Theme, ProviderConfig } from '../types';
import { postMessage } from '../webviewEnv';
import { profileLog } from '../debug';
import { t, resolveTitle, setUiLanguage, type UiLanguage } from '../i18n';

// Profiling helper
const profileTag = '[Profile]';

export interface UseMessageHandlerProps {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setShowThinkingAnimation: (v: boolean) => void;
  setAnimationMode: (v: 'thinking' | 'compacting') => void;
  setHasActiveQuery: (v: boolean) => void;
  setHasCompactArchive: (v: boolean) => void;
  setIsCompactExpanded: (v: boolean) => void;
  setConversations: React.Dispatch<React.SetStateAction<any[]>>;
  setConversationsLoading: (v: boolean) => void;
  /** 插件模式对话列表当前可见条数（滚动到底时追加一页） */
  setVisibleConversationCount: (v: number | ((prev: number) => number)) => void;
  /** App 模式加载对话的 loading 状态（conversationLoaded 到达后关闭） */
  setIsLoadingConversation: (v: boolean) => void;
  setTheme: (v: Theme) => void;
  setThemeInitialized: (v: boolean) => void;
  setCurrentFile: (v: string) => void;
  setSelectedLines: (v: { start: number; end: number } | null) => void;
  setStats: (v: any) => void;
  setConversationTitle: (v: string) => void;
  setMaxContextTokens: (v: number | null) => void;
  setSkills: (v: Array<{ name: string; description: string; isBuiltin?: boolean }>) => void;
  setConversationDropdownOpen: (v: boolean) => void;
  setCurrentSessionId: (v: string | null) => void;
  setParentSessionId: (v: string | null) => void;
  setAgentMode: (v: AgentMode) => void;
  setPromptMode: (v: PromptMode) => void;
  setThinkingMode: (v: ThinkingMode) => void;
  setWebSearch: (v: boolean) => void;
  setModel: (v: string) => void;
  setContextLength: (v: number | ((prev: number) => number)) => void;
  setQueuedMessage: (v: string | null) => void;
  setUserChoiceRequest: (v: UserChoiceRequest | null) => void;
  setNamingSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  setStreamingVersion: (v: number | ((prev: number) => number)) => void;
  setForceScrollKey: (v: number | ((prev: number) => number)) => void;
  /** 任意会话 queryBegin/queryEnd 时递增，强制对话列表重渲染以刷新流水灯 */
  setSessionRunningVersion: (v: number | ((prev: number) => number)) => void;
  setExpandedSubSessions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setModels: (v: string[]) => void;
  setBalance: (v: number | undefined) => void;
  setBalanceCurrency: (v: string | undefined) => void;
  setIsUnlimited: (v: boolean | undefined) => void;
  setCurrentSessionIdRef: (sid: string | null) => void;
  /** LLM 配置面板 */
  setShowLLMConfig: (v: boolean) => void;
  setLlmConfigBaseURL: (v: string) => void;
  setLlmConfigApiType: (v: string) => void;
  setLlmConfigWebSearch: (v: boolean) => void;
  setLlmConfigThinkingEffort: (v: ThinkingMode) => void;
  setLlmConfigDefaultAgentMode: (v: AgentMode) => void;
  setLlmConfigDefaultPromptMode: (v: PromptMode) => void;
  setLlmConfigApiKey: (v: string) => void;
  setLlmConfigProviders: (v: ProviderConfig[]) => void;
  setLlmConfigActiveProvider: (v: string) => void;
  /** 服务商配置完成状态：未完成时输入框禁用并引导打开设置；null 表示尚未探测到配置 */
  setProviderConfigured: (v: boolean | null) => void;
  /** 当前会话的消息列表（用于判断是否为未发送消息的新对话） */
  messages: Message[];
  /** 界面语言变化时递增，App 通过 key 重挂载内容区刷新所有文案 */
  setLocaleVersion: React.Dispatch<React.SetStateAction<number>>;
  /** 设置面板中显示的界面语言 */
  setLlmConfigLanguage: (v: UiLanguage) => void;
  /** settings.json 默认值（model / thinkingMode / agentMode / promptMode） */
  setSettingsDefaults: React.Dispatch<React.SetStateAction<SettingsDefaults>>;
  /** settings.json 默认值（当前值，供新会话初始化使用） */
  settingsDefaults: SettingsDefaults;
  /** 当前会话的实时状态值（切换会话保存快照时使用） */
  userChoiceRequest: UserChoiceRequest | null;
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  hasActiveQuery: boolean;
  agentMode: AgentMode;
  promptMode: PromptMode;
  thinkingMode: ThinkingMode;
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  stats: any;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  sessionStatesRef: React.MutableRefObject<Map<string, SessionState>>;
  userChoiceRequestRef: React.MutableRefObject<UserChoiceRequest | null>;
  userChoiceInputRef: React.MutableRefObject<string>;
  savedMainInputRef: React.MutableRefObject<string>;
  queuedMessageRef: React.MutableRefObject<Map<string, string>>;
  cursorPositionRef: React.MutableRefObject<number | null>;
  choiceCursorPositionRef: React.MutableRefObject<number | null>;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  choiceInputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 用户是否已主动滚离底部；为 true 时预滚动逻辑必须立刻停止，避免与用户上滚冲突 */
  userScrolledAwayRef: React.MutableRefObject<boolean>;
  streamRafRef: React.MutableRefObject<number | null>;
  toolStatusRafRef: React.MutableRefObject<number | null>;
  pendingStreamRef: React.MutableRefObject<Map<string, { role: string; accumulated: string; streamId?: string }>>;
  pendingToolStatusRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
    toolResultTimestamp?: number;
  }>>;
  bufferedToolStatusRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
    toolResultTimestamp?: number;
  }>>;
  /** 工具流式输出批量更新：rAF throttle 合并高频 toolProgress 消息 */
  toolProgressRafRef: React.MutableRefObject<number | null>;
  pendingToolProgressRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    output: string;
    elapsedTimeSeconds?: number;
    totalLines?: number;
    totalBytes?: number;
  }>>;
  conversationLoadingRef: React.MutableRefObject<boolean>;
  isDeletingRef: React.MutableRefObject<boolean>;
  listLoadedOnceRef: React.MutableRefObject<boolean>;
  _appMountTime: React.MutableRefObject<number | null>;
  model: string;
  contextLength: number;
  inputAreaRef: React.RefObject<any>;
}

export function useMessageHandler(props: UseMessageHandlerProps): void {
  // 使用 ref 追踪 contextLength 的最新值，避免 useEffect 闭包捕获过期值
  const contextLengthRef = useRef(props.contextLength);
  contextLengthRef.current = props.contextLength;
  // 使用 ref 追踪 messages 的最新值，便于在消息事件回调中判断当前会话是否已有消息
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;

  useEffect(() => {
    /**
     * 在 React 渲染/提交新内容前，先把滚动容器预滚到底部。
     *
     * 背景：Bash/Write/Edit 等工具的 preview（代码、bash 结果、diff）往往在
     * 工具消息之后异步出现。如果只在 MessagesView 的 useLayoutEffect 里滚动，
     * 用户会先看到新内容在下方渲染出来、再被滚动到视野内。这里在 setMessages/
     * setStreamingVersion 之前同步滚动一次，确保“先滚动、后渲染”的顺序。
     *
     * 只有用户本来就靠近底部时才预滚动，避免打断用户主动向上翻阅历史。
     */
    const scrollToBottomBeforeRender = () => {
      const container = props.messagesContainerRef.current;
      if (!container) return;
      // 用户已通过滚轮/触摸/键盘主动滚离底部时，任何渲染前预滚动都必须停止，
      // 否则新节点出现时会把用户刚上滚的位置强行拉回底部。
      if (props.userScrolledAwayRef.current) return;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom <= 50) {
        container.scrollTop = container.scrollHeight;
      }
    };

    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      const msg = event.data as WebviewMessage;
      const sessionId = props.currentSessionIdRef.current;
      profileLog(`[Webview] handleMessage: type=${msg.type} sessionId=${((msg as any).sessionId || '').substring(0, 20)} currentSessionId=${(sessionId || '').substring(0, 20)}`);

      switch (msg.type) {
        case 'addMessage':
          profileLog(`[Webview] addMessage: role=${msg.role} toolName=${msg.toolName || '-'} sessionMatch=${msg.sessionId === sessionId} isFromAgent=${!!msg.isFromAgent} isCompactSummary=${!!msg.isCompactSummary} contentStart=${(msg.content || '').substring(0, 50)}`);
          // 排队消息被后端真正消费并显示后，清除该会话的排队状态：
          // 入队消息已进入引擎队列，会在下次 LLM 请求时被带上，
          // 不再需要等待 queryEnd 重新投递（避免重复发送）。
          // 放在 session 过滤之前，即使消息属于非当前会话也清除对应排队项。
          if (msg.role === 'user' && msg.sessionId) {
            const queued = props.queuedMessageRef.current.get(msg.sessionId);
            if (queued !== undefined && queued === msg.content) {
              props.queuedMessageRef.current.delete(msg.sessionId);
              if (msg.sessionId === sessionId) {
                props.setQueuedMessage(null);
              }
            }
          }
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
          }

          const newMessage: Message = {
            role: msg.role,
            content: msg.content || '',
            param: msg.param,
            filePath: msg.filePath,
            fileSelectedLines: msg.fileSelectedLines,
            toolName: msg.toolName,
            toolArgs: msg.toolArgs,
            status: msg.status,
            toolCallId: msg.toolCallId || (msg.role === 'toolcall' ? `tool-${Date.now()}-${Math.random()}` : undefined),
            isCompactSummary: msg.isCompactSummary,
            hasBorder: msg.hasBorder,
            isFromAgent: msg.isFromAgent,
            meta: msg.meta as Record<string, unknown> | undefined,
            timestamp: Date.now(),
            cacheReadInputTokens: (msg as any).cacheReadInputTokens,
            cacheCreationInputTokens: (msg as any).cacheCreationInputTokens,
          };

          // 新消息渲染前先把滚动容器预滚到底部，避免 Bash/Write/Edit 等
          // 工具卡片先渲染出来、再被滚动到视野内。
          scrollToBottomBeforeRender();

          // 用户消息直接追加（无本地占位）
          if (msg.role === 'user') {
            props.setMessages((prev) => {
              profileLog(`[Webview] addMessage USER APPEND | msgs.length ${prev.length}->${prev.length + 1} | contentStart=${(msg.content || '').substring(0, 50)}`);
              return [...prev, newMessage];
            });
          } else if (msg.role === 'toolcall' && (msg.toolName || '').toLowerCase().replace(/[-_]/g, '') === 'websearch') {
            // WebSearch 卡片：按时间顺序增量追加到末尾。
            // 之前的"插入到第一条 assistant 文本之前"逻辑在单轮多文本块场景下会失效：
            // Responses API 可在一轮内输出"思考→文字→搜索→思考→文字→搜索…"，
            // 若每次都插到第一条文本前，所有卡片会堆在一起且顺序错乱。
            // 与 thinking/text 流式消息一致，工具卡片也应增量追加，保持 chronological 顺序。
            props.setMessages((prev) => {
              const next = [...prev, newMessage];
              profileLog(`[Webview] addMessage WebSearch APPEND | msgs.length ${prev.length}->${next.length}`);
              return next;
            });
          } else {
            props.setMessages((prev) => {
              const next = [...prev, newMessage];
              profileLog(`[Webview] addMessage APPEND: role=${msg.role} isFromAgent=${!!msg.isFromAgent} | msgs.length ${prev.length}->${next.length} | contentStart=${(msg.content || '').substring(0, 50)}`);
              return next;
            });
          }

          // 当收到工具调用消息时，强制关闭 thinking 动画
          // 例外：WebSearch（模型内置联网搜索）搜索发生在 LLM 流内且耗时较长，
          // 工具卡片本身没有动态反馈，若关闭动画界面会显得"卡死"，
          // 因此搜索期间保留（甚至重新打开）thinking 动画，待 onAIEnd 时再统一隐藏。
          if (msg.role === 'toolcall') {
            const toolNameNorm = (msg.toolName || '').toLowerCase().replace(/[-_]/g, '');
            if (toolNameNorm === 'websearch') {
              props.setShowThinkingAnimation(true);
            } else {
              props.setShowThinkingAnimation(false);
            }
          }

          // 更新 context length（仅对 thinking 和 assistant 消息，它们携带 token 数据）
          if (msg.role === 'thinking' || msg.role === 'assistant') {
            // contextLength = API 返回的 input_tokens（当前对话的输入 token 数）
            // outputTokens  = API 返回的 output_tokens（本次 LLM 输出的 token 数）
            // totalTokens   = input + output（当前对话累计到此刻的总 token 数）
            const inputTokens = (msg as any).contextLength || 0;
            const outputTokens = (msg as any).outputTokens || 0;
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = (msg as any).cacheReadInputTokens || 0;
            const cacheCreationTokens = (msg as any).cacheCreationInputTokens || 0;
            profileLog(`[TokenDebug] addMessage: role=${msg.role} contextLength=${(msg as any).contextLength} outputTokens=${(msg as any).outputTokens} totalTokens=${totalTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
            if (totalTokens > 0) {
              // 直接使用服务端返回的 input+output，不取 max；压缩后服务端会返回更小的数值，
              // 如果继续 max 会导致压缩后的 context 显示仍然停留在压缩前的旧值。
              props.setContextLength(totalTokens);
              // 同时保存到当前 session 的 state 中
              if (props.currentSessionIdRef.current) {
                const state = props.sessionStatesRef.current.get(props.currentSessionIdRef.current);
                if (state) {
                  state.contextLength = totalTokens;
                  // 只在 assistant 消息上累加缓存（避免 thinking 和 assistant 重复）
                  if (msg.role === 'assistant') {
                    const rawInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
                    state.totalCacheReadInputTokens = (state.totalCacheReadInputTokens || 0) + cacheReadTokens;
                    state.totalCacheCreationInputTokens = (state.totalCacheCreationInputTokens || 0) + cacheCreationTokens;
                    state.totalInputTokens = (state.totalInputTokens || 0) + Math.max(0, rawInputTokens);
                  }
                } else {
                  props.sessionStatesRef.current.set(props.currentSessionIdRef.current, {
                    input: '',
                    inputCursorPosition: 0,
                    choiceCursorPosition: 0,
                    userChoiceRequest: null,
                    userChoiceInput: '',
                    showThinkingAnimation: false,
                    hasActiveQuery: false,
                    agentMode: 'manual',
                    promptMode: props.settingsDefaults.promptMode,
                    thinkingMode: 'off',
                    contextLength: totalTokens,
                    queuedMessage: null,
                    model: props.model,
                    totalCacheReadInputTokens: msg.role === 'assistant' ? cacheReadTokens : 0,
                    totalCacheCreationInputTokens: msg.role === 'assistant' ? cacheCreationTokens : 0,
                    totalInputTokens: msg.role === 'assistant' ? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens) : 0,
                  });
                }
              }
            }
          }

          // Hide thinking animation when we receive an assistant message
          if (msg.role === 'assistant') {
            props.setShowThinkingAnimation(false);
          }
          break;
        case 'showThinkingAnimation':
          // 存储到当前 session 的状态中
          if (msg.sessionId && props.sessionStatesRef.current.has(msg.sessionId)) {
            const state = props.sessionStatesRef.current.get(msg.sessionId)!;
            state.showThinkingAnimation = msg.show !== false;
            state.animationMode = 'thinking';
          }
          if (msg.sessionId === sessionId) {
            // 更新全局状态
            props.setShowThinkingAnimation(msg.show !== false);
            // 非压缩场景下的 thinking 动画
            props.setAnimationMode('thinking');
          }
          break;
        case 'initSessionState':
          // 预初始化 session 状态（子代理创建时调用，使后续 thinking 动画能正确显示）
          if (msg.sessionId && !props.sessionStatesRef.current.has(msg.sessionId)) {
            props.sessionStatesRef.current.set(msg.sessionId, {
              input: '',
              inputCursorPosition: 0,
              choiceCursorPosition: 0,
              userChoiceRequest: null,
              userChoiceInput: '',
              showThinkingAnimation: false,
              animationMode: 'thinking',
              hasActiveQuery: false,
              agentMode: 'manual',
              promptMode: props.settingsDefaults.promptMode,
              thinkingMode: 'off',
              contextLength: 0,
              queuedMessage: null,
              model: (msg as any).model || undefined,
              totalCacheReadInputTokens: 0,
              totalCacheCreationInputTokens: 0,
              totalInputTokens: 0,
            });
          }
          break;
        case 'switchToSession':
          // UserChoiceQueue 触发的自动会话跳转
          // 先保存当前 session 的状态
          if (props.currentSessionIdRef.current) {
            const currentSessionId = props.currentSessionIdRef.current;
            const existingState = props.sessionStatesRef.current.get(currentSessionId);
            props.sessionStatesRef.current.set(currentSessionId, {
              input: props.inputAreaRef.current?.getValue() ?? '',
              inputCursorPosition: props.mainInputRef.current?.selectionStart ?? 0,
              choiceCursorPosition: props.choiceInputRef.current?.selectionStart ?? 0,
              userChoiceRequest: props.userChoiceRequest,
              userChoiceInput: props.userChoiceInputRef.current,
              showThinkingAnimation: props.showThinkingAnimation,
              animationMode: props.animationMode,
              hasActiveQuery: props.hasActiveQuery,
              preCompressHasActiveQuery: existingState?.preCompressHasActiveQuery,
              agentMode: props.agentMode,
              promptMode: props.promptMode,
              thinkingMode: props.thinkingMode,
              contextLength: contextLengthRef.current,
              queuedMessage: props.queuedMessageRef.current.get(currentSessionId) ?? null,
              model: props.model,
              // 保留 cache token 数据（可能由后台 streamEnd 更新），避免切换后丢失
              totalCacheReadInputTokens: existingState?.totalCacheReadInputTokens,
              totalCacheCreationInputTokens: existingState?.totalCacheCreationInputTokens,
              totalInputTokens: existingState?.totalInputTokens,
            });
            // 立即持久化当前上下文到 meta.json
            // 使用 contextLengthRef.current（ref 避免闭包过期），
            // 只在值 > 0 时持久化，避免覆盖 meta.json 中已有的正确值
            if (contextLengthRef.current > 0) {
              const currentSid = props.currentSessionIdRef.current;
              if (currentSid) {
                postMessage({
                  type: 'updateConversationContext',
                  sessionId: currentSid,
                  currentFile: props.currentFile,
                  selectedLines: props.selectedLines,
                  totalContextTokens: contextLengthRef.current,
                });
              }
            }
          }
          // 重置压缩状态（conversationLoaded 会覆盖为正确值）
          props.setHasCompactArchive(false);
          props.setIsCompactExpanded(false);
          // 切换到目标会话：在 conversationLoaded 返回前显示加载动画（插件/App 模式统一）
          props.setIsLoadingConversation(true);
          props.setMessages([]);
          // 然后向扩展发送 loadConversation 请求，切换到目标 session
          postMessage({
            type: 'loadConversation',
            sessionId: msg.sessionId,
          });
          break;
        case 'switchToNewSession':
          // 当当前活跃会话被删除时，扩展端通知 webview 切换到新创建的会话
          // 直接复用 onStartup 的逻辑来初始化新会话状态
          {
            const newSessionId = msg.sessionId;
            // 新会话不需要加载动画
            props.setIsLoadingConversation(false);
            // 重置所有会话状态
            props.setMessages([]);
            props.inputAreaRef.current?.setValue('');
            props.setUserChoiceRequest(null);
            props.userChoiceInputRef.current = '';
            props.savedMainInputRef.current = '';
            props.setContextLength(0);
            props.setConversationTitle(t('app.untitled'));
            props.setParentSessionId(null);
            props.setCurrentSessionId(newSessionId);
            props.setCurrentSessionIdRef(newSessionId);
            props.setAgentMode(props.settingsDefaults.agentMode);
            props.setThinkingMode(props.settingsDefaults.thinkingMode);
            props.setWebSearch(props.settingsDefaults.webSearch);
            props.setModel(props.settingsDefaults.model);
            props.setPromptMode(props.settingsDefaults.promptMode);
            props.setStats(null);
            props.setShowThinkingAnimation(false);
            props.setHasActiveQuery(false);
            props.setQueuedMessage(null);

            // 重置压缩状态（conversationLoaded 会覆盖为正确值）
            props.setHasCompactArchive(false);
            props.setIsCompactExpanded(false);

            // 为新对话创建默认 state
            props.sessionStatesRef.current.set(newSessionId, {
              input: '',
              inputCursorPosition: 0,
              choiceCursorPosition: 0,
              userChoiceRequest: null,
              userChoiceInput: '',
              showThinkingAnimation: false,
              hasActiveQuery: false,
              agentMode: props.settingsDefaults.agentMode,
              promptMode: props.settingsDefaults.promptMode,
              thinkingMode: props.settingsDefaults.thinkingMode,
              webSearch: props.settingsDefaults.webSearch,
              contextLength: 0,
              queuedMessage: null,
              model: props.settingsDefaults.model,
              totalCacheReadInputTokens: 0,
              totalCacheCreationInputTokens: 0,
              totalInputTokens: 0,
            });

            // 通知扩展端设置活跃会话 ID
            postMessage({ type: 'setActiveSessionId', sessionId: newSessionId });

            // 聚焦输入框
            setTimeout(() => {
              props.mainInputRef.current?.focus();
            }, 0);
          }
          break;
        case 'setTheme':
          props.setTheme(msg.theme);
          props.setThemeInitialized(true);
          profileLog(`${profileTag} setTheme 收到 | 从挂载到收到=${(performance.now() - props._appMountTime.current!).toFixed(2)}ms`);
          break;
        case 'setCurrentFile':
          props.setCurrentFile(msg.filePath || '');
          props.setSelectedLines(msg.selectedLines || null);
          break;
        case 'timeStatsResult':
          if (msg.stats) {
            props.setStats(msg.stats);
          } else {
            props.setStats(null);
          }
          break;
        case 'setTitle':
          if (msg.sessionId === props.currentSessionIdRef.current) {
            props.setConversationTitle(resolveTitle(msg.title));
          }
          break;
        case 'contextLimitUpdated':
          profileLog(`[TokenDebug] contextLimitUpdated: maxContextTokens=${(msg as any).maxContextTokens}`);
          if ((msg as any).maxContextTokens) {
            props.setMaxContextTokens((msg as any).maxContextTokens);
          } else {
            console.warn(`[TokenDebug] contextLimitUpdated: maxContextTokens is falsy, not setting`);
          }
          break;
        case 'setSkills':
          props.setSkills(msg.skills);
          break;
        case 'queryBegin':
          // 即使被当前 session 过滤，也更新目标 session 的状态（供后续 conversationLoaded 恢复）
          if (msg.sessionId) {
            const targetState = props.sessionStatesRef.current.get(msg.sessionId);
            if (targetState) {
              targetState.hasActiveQuery = true;
            } else {
              // 会话状态不存在（例如从历史记录加载后首次发消息的对话）时创建，
              // 否则 queryBegin 无法标记 hasActiveQuery，对话列表的流水灯不会显示。
              props.sessionStatesRef.current.set(msg.sessionId, {
                input: '',
                inputCursorPosition: 0,
                choiceCursorPosition: 0,
                userChoiceRequest: null,
                userChoiceInput: '',
                showThinkingAnimation: true,
                animationMode: 'thinking',
                hasActiveQuery: true,
                agentMode: props.settingsDefaults.agentMode,
                promptMode: props.settingsDefaults.promptMode,
                thinkingMode: props.settingsDefaults.thinkingMode,
                webSearch: props.settingsDefaults.webSearch,
                contextLength: 0,
                queuedMessage: null,
                model: props.model,
              });
            }
            // 递增版本号强制对话列表重渲染，使流水灯即时出现（或切换后消失）
            props.setSessionRunningVersion(v => v + 1);
          }
          // 只有当前 session 的消息才更新 UI
          // 如果当前没有 session（props.currentSessionIdRef.current 为 null），也接受 queryBegin
          if (msg.sessionId && props.currentSessionIdRef.current && msg.sessionId !== props.currentSessionIdRef.current) {
            break;
          }
          props.setHasActiveQuery(true);
          break;
        case 'queryEnd': {
          // 即使被当前 session 过滤，也更新目标 session 的状态
          const endedSessionId = msg.sessionId;
          if (endedSessionId) {
            const targetState = props.sessionStatesRef.current.get(endedSessionId);
            if (targetState) {
              targetState.hasActiveQuery = false;
              // 查询结束（含中断）时同步关闭 thinking 动画，避免残留
              targetState.showThinkingAnimation = false;
              targetState.animationMode = 'thinking';
            }
            // 递增版本号强制对话列表重渲染，使流水灯即时消失
            props.setSessionRunningVersion(v => v + 1);
          }
          // 查询结束后，如果该会话仍有排队消息（未被后端消费，如入队失败/引擎缺失），
          // 将消息投递到"该会话"（而不是当前会话），保证排队消息与会话绑定。
          if (endedSessionId) {
            const queued = props.queuedMessageRef.current.get(endedSessionId);
            if (queued) {
              props.queuedMessageRef.current.delete(endedSessionId);
              if (endedSessionId === props.currentSessionIdRef.current) {
                props.setQueuedMessage(null);
              }
              postMessage({
                type: 'sendMessage',
                sessionId: endedSessionId,
                content: queued,
              });
            }
          }
          // 只有当前 session 的消息才更新 UI
          // 如果当前没有 session（props.currentSessionIdRef.current 为 null），也接受 queryEnd
          if (endedSessionId && props.currentSessionIdRef.current && endedSessionId !== props.currentSessionIdRef.current) {
            break;
          }
          props.setHasActiveQuery(false);
          // 查询结束（含中断）时同步关闭 thinking 动画，避免残留
          props.setShowThinkingAnimation(false);
          props.setAnimationMode('thinking');
          break;
        }
        case 'setEnableAbort':
          // 扩展端请求启用/禁用 abort 按钮
          props.setHasActiveQuery(msg.enable === true);
          break;
        case 'updateToolArgs':
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            break;
          }
          // 工具参数（如 Edit beforeContent/afterContent、Write preview）更新前预滚动
          scrollToBottomBeforeRender();
          // 更新消息中工具调用的参数
          props.setMessages((prevMessages) => {
            return prevMessages.map((m) => {
              if (m.role === 'toolcall' && (m as any).toolCallId === msg.toolCallId) {
                const existingArgs = (m as any).toolArgs || {};
                const updatedMsg = { ...m };
                (updatedMsg as any).toolArgs = {
                  ...existingArgs,
                  // 通用参数更新：WebSearch 等工具在完成后补全 action/queries/url
                  ...(msg.toolArgs || {}),
                  contextBefore: msg.contextBefore || [],
                  contextAfter: msg.contextAfter || [],
                  beforeContent: msg.beforeContent !== undefined ? msg.beforeContent : existingArgs.beforeContent || '',
                  afterContent: msg.afterContent !== undefined ? msg.afterContent : existingArgs.afterContent || '',
                  diffHunks: msg.diffHunks !== undefined ? msg.diffHunks : existingArgs.diffHunks,
                  startLine: msg.startLine,
                  endLine: msg.endLine,
                };
                return updatedMsg;
              }
              return m;
            });
          });
          // 工具参数变化可能导致 Edit/Write 预览高度变化，触发一次滚动同步。
          props.setStreamingVersion(v => v + 1);
          break;
        case 'requestUserChoice':
          // 存储到当前 session 的状态中
          if (props.sessionStatesRef.current.has(msg.sessionId)) {
            const state = props.sessionStatesRef.current.get(msg.sessionId)!;
            state.userChoiceRequest = {
              choiceId: msg.choiceId,
              toolName: msg.toolName,
              message: msg.message,
              choices: msg.choices !== undefined && msg.choices.length > 0 ? msg.choices : undefined,
            };
          }
          if (msg.sessionId === sessionId) {
            // 保存主输入框内容和光标位置，关闭时需要恢复
            props.cursorPositionRef.current = props.mainInputRef.current?.selectionStart ?? props.inputAreaRef.current?.getValue()?.length ?? 0;
            props.savedMainInputRef.current = props.inputAreaRef.current?.getValue() ?? '';
            // 同时更新全局状态以显示对话框
            props.setUserChoiceRequest({
              choiceId: msg.choiceId,
              toolName: msg.toolName,
              message: msg.message,
              choices: msg.choices !== undefined && msg.choices.length > 0 ? msg.choices : undefined,
            });
          }
          break;
        case 'updateToolStatus':
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            // 不是当前会话的更新：存入跨会话缓冲区，供 conversationLoaded 时回放
            const toolCallId = msg.toolCallId;
            props.bufferedToolStatusRef.current.set(toolCallId, {
              toolCallId,
              status: msg.status || 'running',
              output: msg.output,
              startLine: msg.startLine,
              endLine: msg.endLine,
              toolStartTimestamp: msg.status === 'running' ? Date.now() : undefined,
              toolResultTimestamp: (msg.status === 'success' || msg.status === 'fail') ? Date.now() : undefined,
            });
            break;
          }
          // 🔴 conversationLoading 期间，所有 updateToolStatus（即使是当前会话的消息）
          // 也进入缓冲，由 conversationLoaded 的 rAF 回调统一回放。
          // 避免正常 rAF 路径（pendingToolStatusRef）与 props.setMessages(restoredMessages)
          // 之间的时序竞态导致状态丢失。
          if (props.conversationLoadingRef.current) {
            props.bufferedToolStatusRef.current.set(msg.toolCallId, {
              toolCallId: msg.toolCallId,
              status: msg.status || 'running',
              output: msg.output,
              startLine: msg.startLine,
              endLine: msg.endLine,
              toolStartTimestamp: msg.status === 'running' ? Date.now() : undefined,
              toolResultTimestamp: (msg.status === 'success' || msg.status === 'fail') ? Date.now() : undefined,
            });
            break;
          }
          // 使用函数式更新 + 防抖：将频繁的 status 更新合并到下一次 rAF 中
          if (!props.toolStatusRafRef.current) {
            props.toolStatusRafRef.current = requestAnimationFrame(() => {
              props.toolStatusRafRef.current = null;
              // 消费缓冲队列中的所有更新
              const pending = props.pendingToolStatusRef.current;
              props.pendingToolStatusRef.current = new Map();
              if (pending.size === 0) return;

              // 工具结果渲染前预滚动（Bash 输出等）
              scrollToBottomBeforeRender();

              props.setMessages((prev) => {
                // 一次性应用所有缓冲的更新：使用下标替换避免全量 map 遍历
                let changed = false;
                const next = prev.slice(); // 浅拷贝一次
                for (let i = 0; i < next.length; i++) {
                  const m = next[i];
                  if (m.role !== 'toolcall') continue;
                  const update = pending.get(m.toolCallId!);
                  if (!update) continue;
                  changed = true;
                  // 工具完成（success/fail）时清除流式标记；running 时保留已有标记
                  const updated = {
                    ...m,
                    content: update.output || m.content,
                    status: update.status as any,
                    isStreaming: update.status === 'success' || update.status === 'fail' ? false : m.isStreaming,
                  };

                  if (update.startLine !== undefined || update.endLine !== undefined) {
                    const toolArgs = { ...((m as any).toolArgs || {}) };
                    if (update.startLine !== undefined) toolArgs.startLine = update.startLine;
                    if (update.endLine !== undefined) toolArgs.endLine = update.endLine;
                    (updated as any).toolArgs = toolArgs;
                  }
                  if (update.toolResultTimestamp) (updated as any).toolResultTimestamp = update.toolResultTimestamp;
                  if (update.toolStartTimestamp) (updated as any).toolStartTimestamp = update.toolStartTimestamp;
                  next[i] = updated;
                }
                // 未匹配的更新（toolCallId 不在当前 messages 中）重新导向 buffered 备用
                for (const [toolCallId, update] of pending) {
                  if (!next.some(m => m.role === 'toolcall' && m.toolCallId === toolCallId)) {
                    props.bufferedToolStatusRef.current.set(toolCallId, { ...update });
                  }
                }
                return changed ? next : prev;
              });
              // 工具状态变更（如运行中→完成）更新了消息内容/状态时，
              // 递增 streamingVersion 触发 MessagesView 的 useLayoutEffect 重新执行，
              // 确保自动滚动到最新输出位置。
              // 注意：不能依赖 setMessages 的 updater 返回值来判断是否有变化——
              // React 18 的函数式 updater 在 render 阶段才执行，此时读取 hasChanges
              // 永远是 false，会导致 streamingVersion 从不递增、自动滚动失效。
              // 既然 rAF 批次只有在 pending 有数据时才存在，直接无条件递增即可
              // （内容未变化时 scrollToBottom 是幂等操作，无副作用）。
              props.setStreamingVersion(v => v + 1);
            });
          }
          // 将更新压入缓冲队列（Map 直接覆盖相同 key）
          props.pendingToolStatusRef.current.set(msg.toolCallId, {
            toolCallId: msg.toolCallId,
            status: msg.status || 'running',
            output: msg.output,
            startLine: msg.startLine,
            endLine: msg.endLine,
            // 工具开始执行时（用户确认后）记录开始时间戳
            toolStartTimestamp: msg.status === 'running' ? Date.now() : undefined,
            // 工具执行完成时记录结果返回时间戳
            toolResultTimestamp: (msg.status === 'success' || msg.status === 'fail') ? Date.now() : undefined,
          });
          break;
        case 'toolProgress':
          // Bash 流式输出：过滤非当前 session 的消息
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
          }
          // 使用 rAF throttle 合并高频进度更新，仅保留每个工具的最新累积输出
          if (!props.toolProgressRafRef.current) {
            props.toolProgressRafRef.current = requestAnimationFrame(() => {
              props.toolProgressRafRef.current = null;
              const pending = props.pendingToolProgressRef.current;
              props.pendingToolProgressRef.current = new Map();
              if (pending.size === 0) return;

              // Bash 流式输出渲染前预滚动
              scrollToBottomBeforeRender();

              props.setMessages(prev => {
                let changed = false;
                let next = prev;
                for (let i = 0; i < prev.length; i++) {
                  const m = prev[i];
                  if (m.role !== 'toolcall' || !m.toolCallId) continue;
                  const update = pending.get(m.toolCallId);
                  if (!update) continue;
                  if (!changed) {
                    next = prev.slice();
                    changed = true;
                  }
                  next[i] = {
                    ...m,
                    content: update.output,
                    isStreaming: true,
                    toolStartTimestamp: m.toolStartTimestamp ?? Date.now(),
                  };
                }
                return changed ? next : prev;
              });
              // 同 updateToolStatus：不能依赖 updater 内部的 hasChanges 判断
              // （React 18 函数式 updater 在 render 阶段才执行），否则 streamingVersion
              // 永不递增，Bash 流式输出增长时 MessagesView 不会自动滚动到底部。
              // rAF 批次只在 pending 有数据时存在，直接无条件递增即可。
              props.setStreamingVersion(v => v + 1);
            });
          }
          // 记录最新累积输出（Map 直接覆盖相同 key，只保留最新）
          props.pendingToolProgressRef.current.set(msg.toolCallId, {
            toolCallId: msg.toolCallId,
            output: msg.output || '',
            elapsedTimeSeconds: msg.elapsedTimeSeconds,
            totalLines: msg.totalLines,
            totalBytes: msg.totalBytes,
          });
          break;
        case 'conversationsData': {
          const convs = msg.conversations || [];
          props.setConversations(convs);
          props.setConversationsLoading(false);
          // 新列表到达时回到默认分页大小，避免旧会话的滚动位置/可见数量串到新列表
          props.setVisibleConversationCount(50);
          props.listLoadedOnceRef.current = true;
          // 如果修改的对话是当前对话，同步更新顶部标题
          const sid = props.currentSessionIdRef.current;
          if (sid) {
            const currentConv = convs.find((c: any) => c.sessionId === sid);
            if (currentConv?.title) {
              props.setConversationTitle(resolveTitle(currentConv.title));
            }
            // 自动展开当前对话的祖先链，确保选中子对话时父对话可见
            props.setExpandedSubSessions(prev => {
              const next = { ...prev };
              // 建立 sessionId -> conversation 索引，避免祖先链循环内反复 find()
              const convById = new Map(convs.map((c: any) => [c.sessionId, c]));
              let id: string | null = sid;
              while (id && convById.has(id)) {
                next[id] = true;
                id = convById.get(id)!.parentSessionId;
              }
              return next;
            });
          }
          // 如果正在删除对话，保持面板打开
          if (props.isDeletingRef.current) {
            props.setConversationDropdownOpen(true);
            props.isDeletingRef.current = false;
          }
          break;
        }
        case 'conversationLoaded':
          const _t_convLoaded = performance.now();
          const _convLoadedSessionId = msg.conversation?.metadata?.sessionId;
          profileLog(`[Profile] conversationLoaded收到 | session=${(_convLoadedSessionId || '').substring(0, 20)} | t=${_t_convLoaded.toFixed(2)}ms`);
          // 标记会话正在加载（此期间的 updateToolStatus 进入缓冲，避免时序竞态）
          props.conversationLoadingRef.current = true;
          // 设置当前会话 ID
          if (msg.conversation && msg.conversation.metadata && msg.conversation.metadata.sessionId) {
            const loadedSessionId = msg.conversation.metadata.sessionId;
            props.setCurrentSessionIdRef(loadedSessionId);
            props.setCurrentSessionId(loadedSessionId);
            // 恢复该会话的排队消息横幅（若有）
            props.setQueuedMessage(props.queuedMessageRef.current.get(loadedSessionId) ?? null);
            // 设置压缩状态
            props.setHasCompactArchive((msg as any).hasCompactArchive === true);
            props.setIsCompactExpanded(false);
            // 记录父会话 ID（子对话时有值）
            props.setParentSessionId((msg as any).parentSessionId || null);
            // 通知 extension 设置活跃会话
            postMessage({ type: 'setActiveSessionId', sessionId: loadedSessionId });
            // 恢复该会话的 UI 状态（input, userChoiceRequest, userChoiceInput, showThinkingAnimation）
            const savedState = props.sessionStatesRef.current.get(loadedSessionId);
            if (savedState) {
              props.inputAreaRef.current?.setValue(savedState.input);
              // 使用特殊值标记：恢复状态，不要在 onChange 中移动光标
              // 在 setTimeout 中会正确恢复光标位置
              props.cursorPositionRef.current = -1; // -1 表示恢复状态，不移动光标
              props.choiceCursorPositionRef.current = -1;
              // 如果恢复的会话有 userChoiceRequest，同时保存其对应的主输入框内容
              // 注意：userChoiceRequest 通过 userChoiceQueue.onSessionLoaded 由扩展端恢复，
              // 不使用本地保存的 state，避免 choiceId 过期导致 respondUserChoice 找不到对应记录
              if (savedState.userChoiceRequest) {
                props.savedMainInputRef.current = savedState.input || '';
              }
              // 不恢复 userChoiceRequest（由扩展端 onSessionLoaded 发送新 requestUserChoice）
              props.setUserChoiceRequest(null);
              // 恢复用户选择输入到 ref（组件内部使用自己的本地状态）
              props.userChoiceInputRef.current = savedState.userChoiceInput || '';
              // showThinkingAnimation 和 hasActiveQuery 是运行时状态，不依赖 session state 快照。
              // conversationLoaded 消息中扩展端已根据引擎实时状态提供 hasActiveQuery 和 activityPhase。
              // activityPhase 精确表示当前是 thinking / text / tool / idle，不能仅凭 hasActiveQuery 推断。
              // 压缩是独立于 QueryEngine 的异步任务，hasActiveQuery 可能为 false，
              // 因此压缩中必须优先使用 savedState 的 compacting 状态来恢复动画和流水灯。
              const activityPhase = (msg as any).activityPhase as string | undefined;
              const isCompacting = savedState.animationMode === 'compacting' && savedState.showThinkingAnimation === true;
              const showThinking = isCompacting || (
                (msg as any).hasActiveQuery === true && activityPhase !== 'tool' && activityPhase !== 'text'
              );
              props.setShowThinkingAnimation(showThinking);
              props.setHasActiveQuery(isCompacting || (msg as any).hasActiveQuery === true);
              // 恢复该会话自己的动画类型，避免把其他会话的 compacting 动画带过来
              props.setAnimationMode(isCompacting ? 'compacting' : 'thinking');
              // 同步到 session 状态，确保对话列表的流水灯与引擎实时状态一致
              savedState.hasActiveQuery = isCompacting || (msg as any).hasActiveQuery === true;
              // 优先使用消息中的 agentMode（扩展侧运行时内存值），没有则默认 manual
              props.setAgentMode((msg as any).agentMode || 'manual');
              // 提示词模式：优先使用 meta.json 中保存的 savedContext.promptMode，为空回退到普通模式
              const savedCtxPromptMode = (msg as any).savedContext?.promptMode as PromptMode | undefined;
              props.setPromptMode(savedCtxPromptMode ?? 'normal');
              savedState.promptMode = savedCtxPromptMode ?? 'normal';
              // 优先使用 savedContext.thinkingMode（meta.json 持久化/默认值），回退到 savedState，
              // 都没有时继承当前对话正在使用的 thinking effort
              const savedCtxThinkingMode = (msg as any).savedContext?.thinkingMode as ThinkingMode | undefined;
              props.setThinkingMode(savedCtxThinkingMode || savedState.thinkingMode || props.thinkingMode);
              // 会话关联的 Web Search：优先 savedContext（meta.json 持久化/默认值），回退 savedState，再回退设置默认值
              const savedCtxWebSearch = (msg as any).savedContext?.webSearch as boolean | undefined;
              props.setWebSearch(
                typeof savedCtxWebSearch === 'boolean'
                  ? savedCtxWebSearch
                  : (savedState.webSearch ?? props.settingsDefaults.webSearch)
              );
              props.setModel((msg as any).model ?? savedState.model ?? props.settingsDefaults.model);
              // 优先使用 savedContext.totalContextTokens（meta.json 中持久化的最新值），
              // 回退到 savedState.contextLength（内存中保存的快照值）。
              // 取两者的最大值以处理以下场景：
              // - subagent 在后台运行时，message_delta 已更新 meta.json 但 webview 的 savedState 未同步
              // - savedState 可能保存了切换时的旧值，而 meta.json 中有更新的 token 计数
              const savedCtxToken = (msg as any).savedContext?.totalContextTokens as number | undefined;
              // 优先使用服务端/meta.json 持久化的最新值，避免本地旧快照把压缩后的值重新抬回 max 旧值
              const restoredContextLength = savedCtxToken ?? savedState.contextLength ?? 0;
              profileLog(`[TokenDebug] conversationLoaded(savedState): restoredContextLength=${restoredContextLength} savedCtxToken=${savedCtxToken} savedState.contextLength=${savedState.contextLength}`);
              props.setContextLength(restoredContextLength);
              // 恢复 stats 快照 - 优先使用 conversationLoaded 顶层 timeStats（扩展侧统一计算的最新值），
              // 同时兼容旧的 savedContext.stats（从 meta.json 恢复的快照）
              const ctx = (msg as any).savedContext as { stats?: any } | undefined;
              const timeStats = (msg as any).timeStats || ctx?.stats;
              profileLog(`[TimeStats] savedState分支 | hasTimeStats=${!!(msg as any).timeStats} | hasCtxStats=${!!ctx?.stats} | totalTime=${timeStats?.totalTime ?? 'null'}`);
              if (timeStats) {
                props.setStats(timeStats);
              } else {
                props.setStats(null);
              }
              // 延迟恢复焦点和光标位置，等待 DOM 渲染完成
              setTimeout(() => {
                if (savedState.userChoiceRequest) {
                  props.choiceInputRef.current?.focus();
                  const pos = Math.min(savedState.choiceCursorPosition ?? 0, savedState.userChoiceInput?.length ?? 0);
                  props.choiceInputRef.current?.setSelectionRange(pos, pos);
                  props.choiceCursorPositionRef.current = null;
                } else {
                  props.mainInputRef.current?.focus();
                  const pos = Math.min(savedState.inputCursorPosition ?? 0, savedState.input?.length ?? 0);
                  props.mainInputRef.current?.setSelectionRange(pos, pos);
                  props.cursorPositionRef.current = null;
                }
              }, 0);
            } else {
              props.inputAreaRef.current?.setValue('');
              props.cursorPositionRef.current = null;
              props.choiceCursorPositionRef.current = null;
              props.setUserChoiceRequest(null);
              props.userChoiceInputRef.current = '';
              props.savedMainInputRef.current = '';
              // showThinkingAnimation 和 hasActiveQuery 由扩展端根据引擎实时状态提供
              // activityPhase 精确表示当前是 thinking / text / tool / idle，不能仅凭 hasActiveQuery 推断。
              const activityPhase = (msg as any).activityPhase as string | undefined;
              props.setShowThinkingAnimation(
                (msg as any).hasActiveQuery === true && activityPhase !== 'tool' && activityPhase !== 'text'
              );
              props.setHasActiveQuery((msg as any).hasActiveQuery === true);
              props.setAnimationMode('thinking');
              // 优先使用消息中的 agentMode（扩展侧运行时内存值），没有则默认 manual
              props.setAgentMode((msg as any).agentMode || 'manual');
              // 提示词模式：优先使用 meta.json 中保存的 savedContext.promptMode，为空回退到普通模式
              const savedCtxPromptMode = (msg as any).savedContext?.promptMode as PromptMode | undefined;
              props.setPromptMode(savedCtxPromptMode ?? 'normal');
              // 优先使用 savedContext.thinkingMode（meta.json 持久化/默认值），
              // 没有则继承当前对话正在使用的 thinking effort
              const savedCtxThinkingMode = (msg as any).savedContext?.thinkingMode as ThinkingMode | undefined;
              props.setThinkingMode(savedCtxThinkingMode || props.thinkingMode);
              // 会话关联的 Web Search：优先 savedContext（meta.json 持久化/默认值），回退设置默认值
              const savedCtxWebSearch = (msg as any).savedContext?.webSearch as boolean | undefined;
              props.setWebSearch(
                typeof savedCtxWebSearch === 'boolean'
                  ? savedCtxWebSearch
                  : props.settingsDefaults.webSearch
              );
              props.setModel((msg as any).model ?? props.settingsDefaults.model);
              // 从 savedContext 中恢复 totalContextTokens（meta.json 中持久化的值），
              // 用于 webview 显示进度条。savedState 不存在说明是首次加载，此时应该从 meta 恢复。
              const savedCtx = (msg as any).savedContext as { totalContextTokens?: number; stats?: any } | undefined;
              const restoredVal = savedCtx?.totalContextTokens ?? 0;
              profileLog(`[TokenDebug] conversationLoaded(no savedState): restoredContextLength=${restoredVal} savedCtx.totalContextTokens=${savedCtx?.totalContextTokens}`);
              props.setContextLength(restoredVal);
              // 确保 sessionStatesRef 中有该会话的状态。首次从历史加载的对话此前没有
              // 状态条目，若不在此时创建，后续 queryBegin 会因找不到 targetState 而无法
              // 标记 hasActiveQuery，导致对话列表的流水灯不显示。
              if (!props.sessionStatesRef.current.has(loadedSessionId)) {
                props.sessionStatesRef.current.set(loadedSessionId, {
                  input: '',
                  inputCursorPosition: 0,
                  choiceCursorPosition: 0,
                  userChoiceRequest: null,
                  userChoiceInput: '',
                  showThinkingAnimation: (msg as any).hasActiveQuery === true
                    && (msg as any).activityPhase !== 'tool'
                    && (msg as any).activityPhase !== 'text',
                  animationMode: 'thinking',
                  hasActiveQuery: (msg as any).hasActiveQuery === true,
                  agentMode: (msg as any).agentMode || 'manual',
                  promptMode: savedCtxPromptMode ?? 'normal',
                  thinkingMode: savedCtxThinkingMode || props.thinkingMode,
                  webSearch: typeof savedCtxWebSearch === 'boolean' ? savedCtxWebSearch : props.settingsDefaults.webSearch,
                  contextLength: restoredVal,
                  queuedMessage: null,
                  model: (msg as any).model ?? props.settingsDefaults.model,
                });
              }
              // 优先使用 conversationLoaded 顶层 timeStats（扩展侧统一计算的最新值），
              // 同时兼容旧的 savedContext.stats（从 meta.json 恢复的快照）
              const timeStats = (msg as any).timeStats || savedCtx?.stats;
              profileLog(`[TimeStats] 非savedState分支 | hasTimeStats=${!!(msg as any).timeStats} | hasCtxStats=${!!savedCtx?.stats} | totalTime=${timeStats?.totalTime ?? 'null'}`);
              if (timeStats) {
                props.setStats(timeStats);
              } else {
                props.setStats(null);
              }
              // 聚焦输入框（当没有保存的 state 时）
              setTimeout(() => {
                props.mainInputRef.current?.focus();
              }, 0);
            }
          }
          // sessionId 无效时（消息结构异常），立即清除 loading 标记
          if (props.conversationLoadingRef.current) {
            props.conversationLoadingRef.current = false;
          }
          // 设置对话标题
          if (msg.conversation && msg.conversation.metadata?.title) {
            props.setConversationTitle(resolveTitle(msg.conversation.metadata.title));
          }
          // 恢复对话消息
          if (msg.conversation && msg.conversation.messages) {
            try {
              // 首先扫描所有消息，建立 tool_use_id 到 tool_result 的映射（含时间戳）
              const toolResultMap = new Map<string, { content: string; exitCode: number; timestamp?: number }>();
              // 记录被取消的工具 ID 及其提示内容（未执行被取消的工具需要渲染为失败状态）
              const canceledToolResults = new Map<string, string>();

              // 历史消息结构来自 core 层持久化格式，字段以 any 处理
              const rawMessages = msg.conversation.messages as Array<any>;
              for (const convMsg of rawMessages) {
                if (convMsg.type === 'user' && Array.isArray(convMsg.message?.content)) {
                  const toolResults = convMsg.message.content.filter((block: any) => block.type === 'tool_result');
                  for (const result of toolResults) {
                    // 被取消的工具：记录 tool_use_id -> 提示内容，后续渲染为失败（红色）
                    if (result.is_canceled === true) {
                      if (result.tool_use_id) {
                        canceledToolResults.set(result.tool_use_id, result.content || '');
                      }
                      continue;
                    }
                    toolResultMap.set(result.tool_use_id, {
                      content: result.content || '',
                      exitCode: result.exit_code ?? 0,
                      timestamp: typeof (convMsg as any).timestamp === 'number' ? (convMsg as any).timestamp : undefined,
                    });
                  }
                }
              }

              // 将历史消息转换为当前格式
              const restoredMessages: Message[] = [];

              for (const convMsg of rawMessages) {
                // 跳过流控制消息
                if (convMsg.type === 'stream_request_start') {
                  continue;
                }

                // 消息时间戳：优先使用存储的时间戳，否则使用当前时间
                const msgTimestamp = typeof (convMsg as any).timestamp === 'number' ? (convMsg as any).timestamp : Date.now();

                // 转换系统消息
                if (convMsg.type === 'system') {
                  // 跳过压缩边界标记（内部标记，无需展示）
                  if ((convMsg as any).subtype === 'compact_boundary') {
                    continue;
                  }
                  const content = convMsg.content || '';
                  restoredMessages.push({
                    role: 'system' as const,
                    content,
                    timestamp: msgTimestamp,
                  });
                  continue;
                }

                // 转换用户消息
                if (convMsg.type === 'user') {
                  const content = convMsg.message?.content;
                  // 检查是否是工具结果（content 是数组）
                  if (Array.isArray(content)) {
                    const toolResult = content.find((block: any) => block.type === 'tool_result');
                    if (toolResult) {
                      // 工具结果已经通过 toolcall 消息的 content 显示，跳过单独的 tool_result 消息
                      continue;
                    }
                  }

                  // 从 _meta 读取元信息
                  const msgMeta = (convMsg as any)._meta as Record<string, unknown> | undefined;
                  const isFromAgent = (convMsg as any).fromSubAgent === true;
                  // 跳过 silent 消息（仅 LLM 可见，UI 不可见）
                  if ((convMsg as any).silent === true) {
                    continue;
                  }

                  // 历史消息不再展示文件标签：
                  // 当前文件是实时上下文（随编辑器/打开的 Monaco 视图变化），恢复历史时
                  // 展示陈旧的文件路径/行号会造成困惑；且发送时 fileHidden 的消息 _meta
                  // 也会持久化 filePath，导致"发送时不显示、加载后反而显示"的不一致。
                  // 子代理（from/to）消息的 param 用于跳转/来源展示，需要保留。
                  const msgMetaClean = msgMeta ? { ...msgMeta } : undefined;
                  if (msgMetaClean && msgMetaClean.filePath) {
                    delete msgMetaClean.filePath;
                    delete msgMetaClean.fileSelectedLines;
                    delete msgMetaClean.param;
                  }
                  const msgParam = isFromAgent ? (msgMeta?.param as string | undefined) : undefined;

                  restoredMessages.push({
                    role: 'user' as const,
                    content: typeof content === 'string' ? content : '',
                    param: msgParam,
                    filePath: undefined,
                    fileSelectedLines: undefined,
                    isCompactSummary: (convMsg as any).isCompactSummary === true,
                    isFromAgent,
                    meta: msgMetaClean,
                    timestamp: msgTimestamp,
                  });
                  continue;
                }

                // 转换助手消息
                if (convMsg.type === 'assistant') {
                  // 跳过 spin 模式下的 silent 消息
                  if ((convMsg as any).silent === true) {
                    continue;
                  }
                  const blocks = convMsg.message?.content || [];

                  // 按照 blocks 的原始顺序处理
                  for (const block of blocks) {
                    if ((block as any).type === 'thinking') {
                      // thinking 消息：转换为 thinking 角色显示
                      restoredMessages.push({
                        role: 'thinking' as const,
                        content: (block as any).thinking || '',
                        timestamp: msgTimestamp,
                      });
                    } else if ((block as any).type === 'text') {
                      // 文本消息
                      restoredMessages.push({
                        role: 'assistant' as const,
                        content: (block as any).text,
                        timestamp: msgTimestamp,
                      });
                    } else if ((block as any).type === 'tool_use') {
                      // 工具调用
                      const toolUse = block as any;
                      const toolUseId = toolUse.id;

                      // 被取消的工具调用：渲染为失败（红色），而不是跳过
                      const canceledContent = canceledToolResults.get(toolUseId);
                      if (canceledContent !== undefined) {
                        restoredMessages.push({
                          role: 'toolcall' as const,
                          content: canceledContent,
                          param: `⚙️ ${toolUse.name}`,
                          toolName: toolUse.name,
                          toolArgs: (toolUse.input || {}) as Record<string, unknown>,
                          toolCallId: toolUseId,
                          status: 'fail',
                          timestamp: msgTimestamp,
                        });
                        continue;
                      }

                      const result = toolResultMap.get(toolUseId);
                      const hasResult = result !== undefined;
                      const isPending = (msg.pendingToolUseIds || []).includes(toolUseId);

                      // 根据保存的状态判断工具执行结果
                      // 没有 result 且在 pendingToolUseIds 中 = 正在等待用户授权，显示 normal
                      // 没有 result 但不在 pendingToolUseIds 中 = 正在执行/已中断，显示 running
                      let status: 'success' | 'fail' | 'normal' | 'running' = 'running';
                      if (hasResult) {
                        status = result.exitCode !== 0 ? 'fail' : 'success';
                      } else if (isPending) {
                        status = 'normal';
                      }

                      // 从 _meta 中提取 diff 信息，由 EditFile组件在渲染时使用
                      // _meta 存储在 tool_use block 顶层（不在 input 内部），由 updateToolUseMeta 写入
                      const blockMeta = (toolUse as any)._meta as Record<string, unknown> | undefined;
                      const metaTrimmed = (toolUse as any)._metaTrimmed === true;
                      // 从 conversationLoaded 附带的 toolMetaMap 中查找裁剪掉的 _meta 大字段
                      const preloadedMeta = (msg as any).toolMetaMap?.[toolUseId as string] as
                        { beforeContent?: string; afterContent?: string; diffHunks?: DiffHunk[] } | undefined;
                      const toolArgs = (toolUse.input || {}) as Record<string, unknown>;

                      // Write 工具：补充 webview 展示所需的 contentPreview / totalLines / isTruncated
                      // （这些字段在实时工具调用时由 onPreToolCall 添加，但不会持久化到历史记录中）
                      if (toolUse.name === 'Write' && toolArgs.content) {
                        const content = String(toolArgs.content);
                        if (!toolArgs.contentPreview) {
                          (toolArgs as any).contentPreview = content;
                        }
                        if (!toolArgs.totalLines) {
                          (toolArgs as any).totalLines = content.split('\n').length;
                        }
                        if (toolArgs.isTruncated === undefined) {
                          (toolArgs as any).isTruncated = false;
                        }
                      }

                      if (blockMeta || preloadedMeta) {
                        if (metaTrimmed) {
                          // 优先使用 preloadedMeta（扩展端随 conversationLoaded 一次性发送），
                          // 避免每个 EditFile/UpdateWiki 组件单独触发 requestToolMeta
                          (toolArgs as any).contextBefore = (blockMeta as any)?.contextBefore || [];
                          (toolArgs as any).contextAfter = (blockMeta as any)?.contextAfter || [];
                          (toolArgs as any).startLine = (blockMeta as any)?.startLine;
                          (toolArgs as any).endLine = (blockMeta as any)?.endLine;

                          if (toolUse.name === 'Edit') {
                            // Edit 使用紧凑 diff：只包含 diff 相关行
                            const diffHunks = preloadedMeta?.diffHunks || (blockMeta as any)?.diffHunks || [];
                            (toolArgs as any).diffHunks = diffHunks;

                            // 旧数据兜底：还没有紧凑 diff，但 _meta 里是全量 before/after 时，
                            // 保留旧字段让 EditFile 自行计算。
                            if (diffHunks.length === 0) {
                              const bc = (blockMeta as any)?.beforeContent || '';
                              const ac = (blockMeta as any)?.afterContent || '';
                              if (bc || ac) {
                                (toolArgs as any).beforeContent = bc;
                                (toolArgs as any).afterContent = ac;
                              } else if (!preloadedMeta) {
                                // 仅当 preloadedMeta 和 _meta 中都没有数据时才标记需要按需请求
                                (toolArgs as any)._needsMeta = true;
                                (toolArgs as any)._toolUseId = (toolUse as any)._toolUseId || toolUseId;
                              }
                            }
                          } else {
                            // Write 等工具继续使用 beforeContent/afterContent
                            const bc = preloadedMeta?.beforeContent || (blockMeta as any)?.beforeContent || '';
                            const ac = preloadedMeta?.afterContent || (blockMeta as any)?.afterContent || '';
                            (toolArgs as any).beforeContent = bc;
                            (toolArgs as any).afterContent = ac;
                            if (!preloadedMeta && !bc && !ac) {
                              (toolArgs as any)._needsMeta = true;
                              (toolArgs as any)._toolUseId = (toolUse as any)._toolUseId || toolUseId;
                            }
                          }
                        } else {
                          // 完整 _meta（旧数据，兼容）
                          (toolArgs as any).beforeContent = (blockMeta as any)?.beforeContent || '';
                          (toolArgs as any).afterContent = (blockMeta as any)?.afterContent || '';
                          (toolArgs as any).contextBefore = (blockMeta as any)?.contextBefore || [];
                          (toolArgs as any).contextAfter = (blockMeta as any)?.contextAfter || [];
                          (toolArgs as any).startLine = (blockMeta as any)?.startLine;
                          (toolArgs as any).endLine = (blockMeta as any)?.endLine;
                        }
                      }

                      restoredMessages.push({
                        role: 'toolcall' as const,
                        content: result?.content || '',
                        param: `⚙️ ${toolUse.name}`,
                        toolName: toolUse.name,
                        toolArgs,
                        toolCallId: toolUseId,
                        status,
                        timestamp: msgTimestamp,
                        toolResultTimestamp: result?.timestamp,
                      });
                    }
                  }
                }
              }

              const _t_beforeRaf = performance.now();
              profileLog(`[Profile] conversationLoaded 消息解析完成 | session=${(_convLoadedSessionId || '').substring(0, 20)} | 消息数=${restoredMessages.length} | 解析耗时=${(_t_beforeRaf - _t_convLoaded).toFixed(2)}ms`);
              // 在设置新消息前，先强制收起所有 details 元素
              // 避免切换对话时展开状态互相影响
              requestAnimationFrame(() => {
                const _t_rafStart = performance.now();
                const container = props.messagesContainerRef.current;
                if (container) {
                  container.querySelectorAll('details[open]').forEach((details) => {
                    details.removeAttribute('open');
                  });
                }
                // 回放跨会话缓冲的 updateToolStatus：如果缓冲中有与恢复消息匹配的更新，
                // 优先使用最新状态（工具在会话切换期间已完成，但 updateToolStatus 被 sessionId 过滤丢失了）
                if (props.bufferedToolStatusRef.current.size > 0) {
                  for (let i = 0; i < restoredMessages.length; i++) {
                    const m = restoredMessages[i];
                    if (m.role === 'toolcall' && m.toolCallId) {
                      const buffered = props.bufferedToolStatusRef.current.get(m.toolCallId);
                      if (buffered) {
                        // 更新状态：只在缓冲的状态比当前状态"更新"时才覆盖
                        // success > running > normal > undefined
                        const statusPriority: Record<string, number> = { success: 3, fail: 3, running: 2, normal: 1 };
                        const currentPrio = statusPriority[m.status || ''] ?? 0;
                        const bufferedPrio = statusPriority[buffered.status] ?? 0;
                        if (bufferedPrio > currentPrio) {
                          restoredMessages[i] = { ...m, status: buffered.status as any, content: buffered.output || m.content };
                        }
                        // 无论是否覆盖，消费后移除（避免后续重复应用）
                        props.bufferedToolStatusRef.current.delete(m.toolCallId);
                      }
                    }
                  }
                }
                // 根据扩展端实时维护的 activityPhase 修正 thinking 动画状态；
                // 旧版本消息没有 activityPhase 时，退化为从恢复的消息内容推断当前阶段。
                // 不能用 hasActiveQuery 直接推断 thinking：查询进行中可能正处于
                // 工具执行/文本流式输出阶段，此时应显示工具卡片或文本而不是 thinking 动画。
                const activityPhase = (msg as any).activityPhase as string | undefined;
                const hasRunningTool = restoredMessages.some(m =>
                  m.role === 'toolcall' && m.status === 'running'
                );
                const hasStreamingAssistant = restoredMessages.some(m =>
                  m.role === 'assistant' && m.isStreaming === true
                );
                const loadedState = props.sessionStatesRef.current.get(_convLoadedSessionId);
                // 压缩任务不经过 QueryEngine，hasActiveQuery 可能为 false；
                // 因此压缩中要直接沿用 savedState 的 compacting 状态，而不是被 hasActiveQuery 关掉。
                const isCompacting = loadedState?.animationMode === 'compacting' && loadedState?.showThinkingAnimation === true;
                const shouldShowThinking =
                  isCompacting ||
                  ((msg as any).hasActiveQuery === true &&
                    (activityPhase
                      ? activityPhase !== 'tool' && activityPhase !== 'text'
                      : !hasRunningTool && !hasStreamingAssistant));
                const shouldCompact = isCompacting;
                props.setShowThinkingAnimation(shouldShowThinking);
                props.setAnimationMode(shouldCompact ? 'compacting' : 'thinking');
                if (loadedState) {
                  loadedState.showThinkingAnimation = shouldShowThinking;
                  loadedState.animationMode = shouldCompact ? 'compacting' : 'thinking';
                  if (shouldCompact) {
                    loadedState.hasActiveQuery = true;
                  }
                }

                // 然后再设置新消息
                const _t_setMsgStart = performance.now();
                // 历史消息渲染前预滚动，避免大量代码/diff 先渲染再滚动
                scrollToBottomBeforeRender();
                // 加载完成，关闭 loading 动画（与 setMessages 同批次提交，避免空状态闪烁）
                props.setIsLoadingConversation(false);
                props.setMessages(restoredMessages);
                // 触发强制滚动到底部：加载历史对话时，即使上一会话用户曾向上滚动
                // （userScrolledAwayRef 为 true），也要让新会话的消息滚动到最底部。
                props.setForceScrollKey((prev) => prev + 1);
                // 会话加载完成，清除 loading 标记
                props.conversationLoadingRef.current = false;
                const _t_setMsgEnd = performance.now();
                profileLog(`[Profile] setMessages同步完成 | session=${(_convLoadedSessionId || '').substring(0, 20)} | setMessages耗时=${(_t_setMsgEnd - _t_setMsgStart).toFixed(2)}ms | RAF中总耗时=${(_t_setMsgEnd - _t_rafStart).toFixed(2)}ms`);
                // 使用 requestAnimationFrame 回调完成时记录；setMessages 是批量更新，
                // 实际 React commit 在下一个 rAF 或 microtask 中，所以再等一帧
                requestAnimationFrame(() => {
                  profileLog(`[Profile] setMessages提交(首次渲染) | session=${(_convLoadedSessionId || '').substring(0, 20)} | 从收到消息到首次RAF渲染=${(performance.now() - _t_convLoaded).toFixed(2)}ms`);
                  // 再等一帧，让 React commit 和布局完成
                  requestAnimationFrame(() => {
                    profileLog(`[Profile] 渲染稳定(第二帧) | session=${(_convLoadedSessionId || '').substring(0, 20)} | 总耗时=${(performance.now() - _t_convLoaded).toFixed(2)}ms`);
                  });
                });
              });
            } catch (error) {
              console.error('[App] 恢复对话时出错:', error);
              props.conversationLoadingRef.current = false;
            }
          }
          break;
        case 'clearMessages':
          // 清空本地 UI 消息列表
          // 来自 core 层压缩后的推送（pushCompactMessagesToUI）和 /clear 命令
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
          }
          props.setMessages([]);
          props.setContextLength(0);
          props.setStats(null);
          break;
        case 'compressProgress': {
          // Handle compress progress notifications
          const targetSessionId = msg.sessionId || props.currentSessionIdRef.current;
          const isCurrentTarget = !msg.sessionId || msg.sessionId === props.currentSessionIdRef.current;
          let restoredActiveQuery: boolean | undefined;

          // 始终更新目标会话的动画状态，切换会话后可以恢复正确的动画类型
          if (targetSessionId) {
            const targetState = props.sessionStatesRef.current.get(targetSessionId);
            if (targetState) {
              if (msg.status === 'start') {
                // 记录压缩前是否有活跃查询：自动压缩发生在大查询中时，
                // 压缩结束后仍应保持 hasActiveQuery=true；手动压缩则恢复为 false。
                targetState.preCompressHasActiveQuery = targetState.hasActiveQuery;
                targetState.hasActiveQuery = true;
                targetState.showThinkingAnimation = true;
                targetState.animationMode = 'compacting';
              } else if (msg.status === 'complete' || msg.status === 'error') {
                restoredActiveQuery = targetState.preCompressHasActiveQuery ?? false;
                targetState.hasActiveQuery = restoredActiveQuery;
                targetState.preCompressHasActiveQuery = undefined;
                targetState.showThinkingAnimation = false;
                targetState.animationMode = 'thinking';
              }
              // 强制对话列表重渲染，使压缩期间的流水灯即时出现/消失
              props.setSessionRunningVersion(v => v + 1);
            }
          }

          // 非当前会话的压缩进度不更新全局动画，避免串到其他会话
          if (!isCurrentTarget) break;

          if (msg.status === 'start') {
            props.setAnimationMode('compacting');
            props.setShowThinkingAnimation(true);
            props.setHasActiveQuery(true);
          } else if (msg.status === 'complete' || msg.status === 'error') {
            props.setShowThinkingAnimation(false);
            props.setAnimationMode('thinking');
            // 恢复压缩前的查询状态（自动压缩仍在查询中时保持 true，手动压缩恢复 false）
            props.setHasActiveQuery(restoredActiveQuery ?? false);
            // 压缩完成后，设置 hasCompactArchive 以便显示展开按钮
            props.setHasCompactArchive(true);
            // 刷新 token 使用量显示为压缩后的值
            if (msg.postCompactTokenCount !== undefined) {
              props.setContextLength(msg.postCompactTokenCount);
            }
            // 压缩完成时，保存当前的耗时分布统计到 meta.json
            if (msg.status === 'complete') {
              if (props.currentSessionIdRef.current && props.stats) {
                postMessage({
                  type: 'saveConversationStats',
                  sessionId: props.currentSessionIdRef.current,
                  stats: props.stats,
                });
              }
            }
          }
          break;
        }
        case 'queuedMessage':
          // 按会话存储排队消息（绑定 sessionId），切换会话后仍能正确归属
          if (msg.sessionId) {
            props.queuedMessageRef.current.set(msg.sessionId, msg.content);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(msg.content);
              // 排队消息出现时触发自动滚动，让用户看到排队提示
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
          break;
        case 'clearQueuedMessage':
          // 仅清除指定会话的排队消息，不影响其他会话的排队项
          if (msg.sessionId) {
            props.queuedMessageRef.current.delete(msg.sessionId);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(null);
              // 排队消息清除时触发自动滚动
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
          break;
        case 'smartNamingResult':
          profileLog('[App] smartNamingResult received', msg);
          // 更新命名中状态
          {
            const namingSessionId = (msg as any).sessionId;
            const newTitle = (msg as any).title;
            props.setNamingSessions(prev => {
              const next = new Set(prev);
              next.delete(namingSessionId);
              return next;
            });
            // 如果重命名的是当前对话，同步更新顶部标题显示
            if (namingSessionId === props.currentSessionIdRef.current) {
              props.setConversationTitle(resolveTitle(newTitle));
            }
            // 同步更新对话列表中的标题（即时刷新，无需等待后端返回）
            props.setConversations(prev => prev.map(c =>
              c.sessionId === namingSessionId ? { ...c, title: newTitle } : c
            ));
          }
          break;
        case 'streamMessage': {
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
          }
          // streamId 由 RealApi.ts 保证每次 LLM 调用生成唯一 ID，不会为 undefined
          const streamId = (msg as any).streamId!;
          const accumulated = msg.accumulated;
          const role = msg.role;
          const mapKey = streamId + ':' + role;
          props.pendingStreamRef.current.set(mapKey, { role, accumulated, streamId });
          if (!props.streamRafRef.current) {
            props.streamRafRef.current = requestAnimationFrame(() => {
              props.streamRafRef.current = null;
              const buffer = props.pendingStreamRef.current;
              props.pendingStreamRef.current = new Map();
              if (buffer.size === 0) return;

              // 流式文本/代码渲染前预滚动
              scrollToBottomBeforeRender();

              props.setMessages(prev => {
                let next = prev;
                for (const [, { role: r, accumulated: acc, streamId: sid }] of buffer) {
                  // 用 streamId + role 精确匹配已有消息
                  let lastIdx = -1;
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const m = prev[i] as any;
                    if (m.streamId === sid && m.role === r) {
                      lastIdx = i;
                      break;
                    }
                  }
                  if (lastIdx >= 0) {
                    // 下标直写，避免全量 map 遍历 O(n)
                    next = next === prev ? next.slice() : next;
                    next[lastIdx] = { ...next[lastIdx], content: acc, isStreaming: true };
                  } else {
                    next = next.concat({ role: r as any, content: acc, isStreaming: true, streamId: sid, timestamp: Date.now() } as any);
                  }
                }
                return next;
              });
              props.setStreamingVersion(v => v + 1);
            });
          }
          break;
        }
        case 'streamEnd': {
          // 更新 token 用量：即使 sessionId 不匹配也要累加到对应 session 的 state 中，
          // 否则子代理（Agent Tool）在后台运行时，其 cache token 数据会丢失，
          // 导致切换到子代理后 Cache 命中率不显示。
          const streamEndSessionId = msg.sessionId || sessionId;
          if (streamEndSessionId !== sessionId) {
            profileLog(`[TokenDebug] streamEnd: session mismatch, updating session state for ${(streamEndSessionId || '').substring(0,20)} (current=${(sessionId || '').substring(0,20)})`);
            // 仍然更新非当前 session 的 cache token 数据到 sessionStatesRef
            if (streamEndSessionId && (msg as any).usage) {
              const usage = (msg as any).usage;
              const cacheReadTokens = usage.cache_read_input_tokens || 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
              const inputTokens = usage.input_tokens || 0;
              const outputTokens = usage.output_tokens || 0;
              const totalTokens = inputTokens + outputTokens;
              const role = msg.role;
              if (totalTokens > 0) {
                const state = props.sessionStatesRef.current.get(streamEndSessionId);
                if (state) {
                  if (role === 'assistant') {
                    const rawInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
                    state.totalCacheReadInputTokens = (state.totalCacheReadInputTokens || 0) + cacheReadTokens;
                    state.totalCacheCreationInputTokens = (state.totalCacheCreationInputTokens || 0) + cacheCreationTokens;
                    state.totalInputTokens = (state.totalInputTokens || 0) + Math.max(0, rawInputTokens);
                  }
                } else {
                  props.sessionStatesRef.current.set(streamEndSessionId, {
                    input: '',
                    inputCursorPosition: 0,
                    choiceCursorPosition: 0,
                    userChoiceRequest: null,
                    userChoiceInput: '',
                    showThinkingAnimation: false,
                    hasActiveQuery: false,
                    agentMode: 'manual',
                    promptMode: props.settingsDefaults.promptMode,
                    thinkingMode: 'off',
                    contextLength: totalTokens,
                    queuedMessage: null,
                    model: props.model,
                    totalCacheReadInputTokens: role === 'assistant' ? cacheReadTokens : 0,
                    totalCacheCreationInputTokens: role === 'assistant' ? cacheCreationTokens : 0,
                    totalInputTokens: role === 'assistant' ? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens) : 0,
                  });
                  profileLog('[TokenDebug] streamEnd(sessionMismatch): created session state for', streamEndSessionId);
                }
              }
            }
            break;
          }
          const streamId = (msg as any).streamId!;
          const accumulated = msg.accumulated;
          const role = msg.role;
          const mapKey = streamId + ':' + role;
          profileLog(`[TokenDebug] streamEnd: role=${role} streamId=${streamId} hasUsage=${!!(msg as any).usage} usage=${JSON.stringify((msg as any).usage)}`);
          if (props.streamRafRef.current) {
            cancelAnimationFrame(props.streamRafRef.current);
            props.streamRafRef.current = null;
          }
          props.pendingStreamRef.current.set(mapKey, { role, accumulated, streamId });
          const finalBuffer = props.pendingStreamRef.current;
          props.pendingStreamRef.current = new Map();
          if (finalBuffer.size > 0) {
            // 流式结束的最终内容渲染前预滚动
            scrollToBottomBeforeRender();
            props.setMessages(prev => {
              let next = prev;
              for (const [, { role: r, accumulated: acc, streamId: sid }] of finalBuffer) {
                let lastIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i] as any;
                  if (m.streamId === sid && m.role === r) {
                    lastIdx = i;
                    break;
                  }
                }
                if (lastIdx >= 0) {
                  // 下标直写，避免全量 map 遍历 O(n)
                  next = next === prev ? next.slice() : next;
                  next[lastIdx] = { ...next[lastIdx], content: acc, isStreaming: false };
                } else {
                  next = next.concat({ role: r as any, content: acc, isStreaming: false, streamId: sid, timestamp: Date.now() } as any);
                }
              }
              return next;
            });
            props.setStreamingVersion(v => v + 1);
          }
          // 更新 token 用量（累加 output_tokens，不替换）
          if ((msg as any).usage) {
            const usage = (msg as any).usage;
            const outputTokens = usage.output_tokens || 0;
            const inputTokens = usage.input_tokens || 0;
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
            profileLog(`[TokenDebug] streamEnd: role=${role} updating contextLength prev=${contextLengthRef.current} inputTokens=${inputTokens} outputTokens=${outputTokens} totalTokens=${totalTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
            if (totalTokens > 0) {
              // 直接使用服务端返回的 input+output，不取 max；压缩后服务端会返回更小的数值，
              // 如果继续 max 会导致压缩后的 context 显示仍然停留在压缩前的旧值。
              props.setContextLength(totalTokens);
              profileLog(`[TokenDebug] streamEnd: setContextLength ${contextLengthRef.current} -> ${totalTokens}`);
              // 同步更新到当前 session 的 state 中，确保切换会话后能正确恢复
              const currentSid = props.currentSessionIdRef.current;
              if (currentSid) {
                const state = props.sessionStatesRef.current.get(currentSid);
                if (state) {
                  state.contextLength = totalTokens;
                  // 只对 role=assistant 累加缓存（thinking 和 assistant 都会收到 streamEnd，但 usage 相同，避免重复累加）
                  if (role === 'assistant') {
                    // usage.input_tokens 已包含缓存部分，原始 input_tokens = inputTokens - cacheRead - cacheCreation
                    const rawInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
                    state.totalCacheReadInputTokens = (state.totalCacheReadInputTokens || 0) + cacheReadTokens;
                    state.totalCacheCreationInputTokens = (state.totalCacheCreationInputTokens || 0) + cacheCreationTokens;
                    state.totalInputTokens = (state.totalInputTokens || 0) + Math.max(0, rawInputTokens);
                  }
                } else {
                  // streamEnd 到达时 state 可能尚未初始化（例如子代理会话首次 LLM 回复），
                  // 此时需要创建初始 state 并写入 token/cache 数据，否则 Cache 命中率不会显示。
                  // 参考 addMessage 处理器中 role===thinking/assistant 分支的初始化逻辑。
                  props.sessionStatesRef.current.set(currentSid, {
                    input: '',
                    inputCursorPosition: 0,
                    choiceCursorPosition: 0,
                    userChoiceRequest: null,
                    userChoiceInput: '',
                    showThinkingAnimation: false,
                    hasActiveQuery: false,
                    agentMode: 'manual',
                    promptMode: props.settingsDefaults.promptMode,
                    thinkingMode: 'off',
                    contextLength: totalTokens,
                    queuedMessage: null,
                    model: props.model,
                    totalCacheReadInputTokens: role === 'assistant' ? cacheReadTokens : 0,
                    totalCacheCreationInputTokens: role === 'assistant' ? cacheCreationTokens : 0,
                    totalInputTokens: role === 'assistant' ? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens) : 0,
                  });
                  profileLog('[TokenDebug] streamEnd: created session state for', currentSid);
                }
              }
            }
          }
          break;
        }
        case 'expandCompactDone':
          // 展开完成，隐藏展开按钮
          props.setHasCompactArchive(false);
          props.setIsCompactExpanded(true);
          break;
        case 'setModels':
          if ((msg as any).models && Array.isArray((msg as any).models)) {
            props.setModels((msg as any).models);
          }
          break;
        case 'providerModelsResult':
          // 由 LLMConfigPanel 内部监听处理，这里只需要避免 Unknown message 日志
          break;
        case 'settingsDefaults':
          // 从扩展端接收 settings.json 中的默认值（model / thinkingMode / agentMode / promptMode），
          // 供新对话创建时一次性使用，避免先显示 manual 再跳变
          {
            const defaults = msg as { model: string; thinkingMode: 'off' | 'low' | 'high' | 'max'; agentMode: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch: boolean; language?: UiLanguage; providerConfigured?: boolean };
            profileLog(`[Webview] settingsDefaults received: model=${defaults.model}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, language=${defaults.language}, providerConfigured=${defaults.providerConfigured}`);
            props.setSettingsDefaults({
              model: defaults.model,
              thinkingMode: defaults.thinkingMode,
              agentMode: defaults.agentMode,
              promptMode: defaults.promptMode || 'normal',
              webSearch: defaults.webSearch,
            });
            if (typeof defaults.providerConfigured === 'boolean') {
              props.setProviderConfigured(defaults.providerConfigured);
            }
            // 应用界面语言（与 HTML 注入的 __uiLocale 一致，仅在极少数不一致时触发重渲染）
            if (defaults.language === 'zh' || defaults.language === 'en' || defaults.language === 'auto') {
              const changed = setUiLanguage(defaults.language);
              if (changed) {
                props.setLocaleVersion((v) => v + 1);
              }
            }
          }
          break;
        case 'llmConfigSaved':
          // LLM 配置保存成功：更新本地默认值。
          // 如果当前对话是未发送消息的新对话，则模型/提示词模式等默认值也立刻生效；
          // 工作模式/思考强度/联网搜索保持原有“保存后应用到当前对话”的行为。
          {
            const saved = msg as { defaultModel?: string; thinkingEffort?: 'off' | 'low' | 'high' | 'max'; defaultAgentMode?: 'manual' | 'risk' | 'auto'; defaultPromptMode?: PromptMode; webSearch?: boolean };
            // 保存成功即说明至少有一个可用的服务商
            props.setProviderConfigured(true);
            if (saved.defaultModel || saved.thinkingEffort || saved.defaultAgentMode || saved.defaultPromptMode || typeof saved.webSearch === 'boolean') {
              props.setSettingsDefaults(prev => ({
                model: saved.defaultModel || prev.model,
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
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.agentMode = saved.defaultAgentMode;
                }
              }
            }
            if (saved.thinkingEffort) {
              props.setThinkingMode(saved.thinkingEffort);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.thinkingMode = saved.thinkingEffort;
                }
              }
            }
            if (typeof saved.webSearch === 'boolean') {
              props.setWebSearch(saved.webSearch);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.webSearch = saved.webSearch;
                }
              }
            }
            // 当前对话是未发送消息的新对话时，模型与提示词模式也立即使用新默认值
            if (messagesRef.current.length === 0) {
              const curSid = props.currentSessionIdRef.current;
              const state = curSid ? props.sessionStatesRef.current.get(curSid) : undefined;
              if (saved.defaultModel) {
                props.setModel(saved.defaultModel);
                if (state) state.model = saved.defaultModel;
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
          }
          break;
        case 'setNewConversationDefaults':
          // 从扩展端接收新对话的默认 model、thinkingMode、agentMode、promptMode 和 webSearch（来自 settings.json）
          {
            const defaults = msg as { sessionId: string; model: string; thinkingMode: 'off' | 'low' | 'high' | 'max'; agentMode?: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch?: boolean };
            profileLog(`[Webview] setNewConversationDefaults received: model=${defaults.model}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, currentSessionId=${props.currentSessionIdRef.current}`);
            // 如果用户已经手动切换过模型，不要再用 settings.json 的默认模型覆盖用户选择
            const modelChangedByUser = props.model !== props.settingsDefaults.model;
            if (!modelChangedByUser) {
              props.setModel(defaults.model);
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
              const state = props.sessionStatesRef.current.get(curSid);
              if (state) {
                if (!modelChangedByUser) {
                  state.model = defaults.model;
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
          break;
        case 'toolMetaData':
          // EditFile 等工具异步加载完 diff 内容后，容器高度可能发生变化。
          // 先在渲染前预滚动，避免 diff 先出现在视野内再被滚动。
          scrollToBottomBeforeRender();
          // 递增 streamingVersion 触发 MessagesView 的 useLayoutEffect 重新执行，
          // 从而调用 scrollToBottom()，避免概率性出现 diff 展开但未自动滚到底的问题。
          // 使用 requestAnimationFrame 确保 React 已完成 diff DOM 的渲染和布局，
          // 避免在 useLayoutEffect 执行时 diff DOM 尚未渲染到布局中。
          requestAnimationFrame(() => {
            props.setStreamingVersion((prev) => prev + 1);
          });
          break;
        case 'balanceUpdate':
          // 更新全局余额信息（与会话无关）；获取失败时消息字段为 null，此时清空余额隐藏显示
          {
            const totalBalance = (msg as any).totalBalance;
            const currency = (msg as any).currency;
            const unlimited = (msg as any).isUnlimited;
            props.setBalance(typeof totalBalance === 'number' ? totalBalance : undefined);
            props.setBalanceCurrency(typeof currency === 'string' ? currency : undefined);
            props.setIsUnlimited(typeof unlimited === 'boolean' ? unlimited : undefined);
          }
          break;
        case 'showLLMConfig':
          // 显示 LLM 配置面板（启动时 apiKey 为空或用户点击设置时触发）
          props.setLlmConfigBaseURL((msg as any).baseURL || '');
          props.setLlmConfigApiType((msg as any).apiType || '');
          props.setLlmConfigWebSearch(!!(msg as any).webSearch);
          props.setLlmConfigThinkingEffort((msg as any).thinkingEffort || 'off');
          props.setLlmConfigDefaultAgentMode((msg as any).defaultAgentMode || 'manual');
          props.setLlmConfigDefaultPromptMode((msg as any).defaultPromptMode === 'minimal' || (msg as any).defaultPromptMode === 'mixed' ? (msg as any).defaultPromptMode : 'normal');
          props.setLlmConfigApiKey((msg as any).apiKey || '');
          const llmLanguage = (msg as any).language;
          props.setLlmConfigLanguage(llmLanguage === 'zh' || llmLanguage === 'en' || llmLanguage === 'auto' ? llmLanguage : 'auto');
          const rawProviders = (msg as any).providers;
          if (Array.isArray(rawProviders)) {
            props.setLlmConfigProviders(
              rawProviders.map((p: any) => ({
                key: String(p?.key || ''),
                baseURL: String(p?.baseURL || ''),
                apiKey: String(p?.apiKey || ''),
                apiType: p?.apiType === 'Anthropic' ? 'Anthropic' : 'Responses',
                models: Array.isArray(p?.models)
                  ? (p.models as unknown[])
                      .filter((m): m is string => typeof m === 'string' && !!m.trim())
                      .map((m) => m.trim())
                  : [],
                defaultModel: String(p?.defaultModel || ''),
              }))
            );
          } else {
            props.setLlmConfigProviders([]);
          }
          props.setLlmConfigActiveProvider(typeof (msg as any).activeProvider === 'string' ? (msg as any).activeProvider : '');
          props.setProviderConfigured(!!(msg as any).activeProvider && !!((msg as any).apiKey));
          props.setShowLLMConfig(true);
          break;
        default:
          console.warn(`[Webview] Unknown message type: ${msg.type}`);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
}

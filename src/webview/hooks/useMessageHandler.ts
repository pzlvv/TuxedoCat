import React, { useEffect, useRef } from 'react';
import type { McpServerInfo, ProviderModels } from '../../core/webviewTypes';
import type { ModelRef } from '../../core/llm/modelRef';
import type { HostToWebviewWire } from '../../host/webviewMessages';
import type { Message, QueuedMessagePayload, UserChoiceRequest, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, Theme, LlmConfigPanelPayload, SessionRuntimeState, ApplyDefaultsPrompt } from '../types';
import type { SessionStatesStore } from '../sessionState';
import { profileLog } from '../debug';
import { handleStreamShowThinkingAnimation, handleStreamAiEnd, handleStreamQueryBegin, handleStreamQueryEnd, handleStreamStreamMessage, handleStreamStreamEnd, handleStreamCompressProgress } from './handlers/streamHandlers';
import { handleToolAddMessage, handleToolUpdateToolArgs, handleToolUpdateToolStatus, handleToolToolProgress, handleToolRequestUserChoice, handleToolToolMetaData } from './handlers/toolHandlers';
import { handleConversationInitSessionState, handleConversationSetConversationListOwner, handleConversationSetCurrentFile, handleConversationSetTitle, handleConversationConversationsData, handleConversationSessionRuntimeStates, handleConversationSessionCompletionAttention, handleConversationConversationLoaded, handleConversationMessagesReplaced, handleConversationQueuedMessage, handleConversationClearQueuedMessage, handleConversationSmartNamingResult, handleConversationExpandCompactDone } from './handlers/conversationHandlers';
import { handleConfigSetTheme, handleConfigSetModel, handleConfigSetAgentMode, handleConfigSetPromptMode, handleConfigSetThinkingMode, handleConfigSetWebSearch, handleConfigSetMcpServers, handleConfigSetModels, handleConfigSetSkills, handleConfigContextLimitUpdated, handleConfigNotice, handleConfigSettingsDefaults, handleConfigProviderModelsResult, handleConfigSetNewConversationDefaults, handleConfigLlmConfigSaved, handleConfigShowLLMConfig, handleConfigBalanceUpdate, handleConfigFocusInput, handleConfigActivatePrewarmedView } from './handlers/configHandlers';
import type { HandlerContext } from './handlers/handlerContext';
import { restoreQueuedMessageToInput } from './restoreQueuedMessage';

// Profiling helper


/** 已提示过的未知消息类型：避免宿主重复发送时把控制台刷爆（同类只提示一次） */
const warnedUnknownMessageTypes = new Set<string>();

/**
 * 下行消息中「中央分发显式不消费」的 type 全集：
 * `providerModelsFetched` / `llmConfigSaveError` / `conversationSpaces*` 由
 * LLMConfigPanel 自己的 message 监听消费（面板打开期间才有意义）。
 *
 * 与 default 分支的穷尽守卫配套：switch 收窄后的剩余类型若超出本清单
 * （= 新增下行消息漏写 case），编译期报错，而不是运行期靠一次性
 * Unknown 警告（`setModels` 漏 case 导致模型菜单永远「加载中」的教训）。
 */
type WebviewIgnoredDownlinkType = Extract<
  HostToWebviewWire,
  { type: 'providerModelsFetched' | 'llmConfigSaveError' | 'conversationSpacesData' | 'conversationSpacesError' | 'conversationSpaceCleared' }
>;


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
  /** 收到某会话的 conversationLoaded 数据：结束对话自身的 loading */
  finishConversationLoad: (sessionId?: string | null) => void;
  /** 进入无需加载的新对话：清除对话自身的 loading */
  resetConversationLoad: () => void;
  setTheme: (v: Theme) => void;
  setThemeInitialized: (v: boolean) => void;
  setCurrentFile: (v: string) => void;
  setSelectedLines: (v: { start: number; end: number } | null) => void;
  setConversationTitle: (v: string) => void;
  setMaxContextTokens: (v: number | null) => void;
  setSkills: (v: Array<{ name: string; description: string; isBuiltin?: boolean }>) => void;
  /** 呈现一条 core 产出的瞬时提示（键 + 参数，`docs/architecture/core-ui-separation.md` 第 4.9 节） */
  pushNotice: (key: string, params: Record<string, string | number>, level: 'info' | 'warn' | 'error') => void;
  /** MCP 服务器列表（含启用状态），由 extension 读取 mcp.json + settings.json 后下发 */
  setMcpServers: (v: McpServerInfo[]) => void;
  setConversationDropdownOpen: (v: boolean) => void;
  setCurrentSessionId: (v: string | null) => void;
  setParentSessionId: (v: string | null) => void;
  setAgentMode: (v: AgentMode) => void;
  setPromptMode: (v: PromptMode | undefined) => void;
  setThinkingMode: (v: ThinkingMode | undefined) => void;
  /** undefined = 尚未从宿主获取到（保持等待态，不写猜测值） */
  setWebSearch: (v: boolean | undefined) => void;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  setModelRef: (v: ModelRef | undefined) => void;
  setContextLength: (v: number | ((prev: number) => number)) => void;
  setQueuedMessage: (v: QueuedMessagePayload | null) => void;
  setUserChoiceRequest: (v: UserChoiceRequest | null) => void;
  setNamingSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  setStreamingVersion: (v: number | ((prev: number) => number)) => void;
  setForceScrollKey: (v: number | ((prev: number) => number)) => void;
  /** core 推来会话运行时状态时递增，强制对话列表重渲染以刷新流水灯与 abort 按钮 */
  setSessionIdleVersion: (v: number | ((prev: number) => number)) => void;
  /** 未读完成的会话集合（「任务完成」绿色呼吸，Electron 宿主推送；sessionId → 到达时刻） */
  setCompletionAttention: React.Dispatch<React.SetStateAction<Map<string, number>>>;
  setExpandedSubSessions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /** 全部 provider 及其模型列表（菜单三级子菜单数据源）；空数组 = 宿主答了「没有配置模型」 */
  setProviderModels: (v: ProviderModels[]) => void;
  setBalance: (v: number | undefined) => void;
  setBalanceCurrency: (v: string | undefined) => void;
  setIsUnlimited: (v: boolean | undefined) => void;
  setCurrentSessionIdRef: (sid: string | null) => void;
  /**
   * LLM 配置面板载荷：宿主随 `showLLMConfig` 一次给齐；`null` 表示关闭面板。
   * 载荷到达即面板打开，webview 不补默认值（`docs/hosts/webview-facts.md` 第 6 节）。
   */
  setLlmConfigPayload: (v: LlmConfigPanelPayload | null) => void;
  /** 服务商配置完成状态：未完成时输入框禁用并引导打开设置；null 表示尚未探测到配置 */
  setProviderConfigured: (v: boolean | null) => void;
  /** 会话配置（模型 / 思考强度 / 提示词模式等）是否已从宿主获取到 */
  setConfigReady: (v: boolean) => void;
  /** 当前会话的消息列表（用于判断是否为未发送消息的新对话） */
  messages: Message[];
  /** 界面语言变化时递增，App 通过 key 重挂载内容区刷新所有文案 */
  setLocaleVersion: React.Dispatch<React.SetStateAction<number>>;
  /** settings.json 默认值（model / thinkingMode / agentMode / promptMode） */
  setSettingsDefaults: React.Dispatch<React.SetStateAction<SettingsDefaults>>;
  /** settings.json 默认值（当前值，供新会话初始化使用） */
  settingsDefaults: SettingsDefaults;
  /**
   * 「默认配置已修改，是否应用到当前对话」的待确认请求；null = 无待确认项。
   * 由 config handler 在默认值变化且与当前对话不一致时写入，App 渲染确认对话框。
   */
  setApplyDefaultsPrompt: React.Dispatch<React.SetStateAction<ApplyDefaultsPrompt | null>>;
  /** 当前会话的实时状态值（切换会话保存快照时使用） */
  userChoiceRequest: UserChoiceRequest | null;
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  hasActiveQuery: boolean;
  /** 会话询问模式；undefined = 尚未从宿主获取到 */
  agentMode: AgentMode | undefined;
  promptMode: PromptMode | undefined;
  thinkingMode: ThinkingMode | undefined;
  /** 会话联网搜索开关；undefined = 尚未从宿主获取到 */
  webSearch: boolean | undefined;
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  sessionStates: SessionStatesStore;
  /** core 推送的会话运行时状态：对话树流水灯与 abort 按钮的唯一数据源 */
  sessionRuntimeStatesRef: React.MutableRefObject<Map<string, SessionRuntimeState>>;
  userChoiceRequestRef: React.MutableRefObject<UserChoiceRequest | null>;
  userChoiceInputRef: React.MutableRefObject<string>;
  savedMainInputRef: React.MutableRefObject<string>;
  queuedMessageRef: React.MutableRefObject<Map<string, QueuedMessagePayload>>;
  /** 用户主动 abort 的会话集合，queryEnd 时用于把排队消息回填到输入框 */
  abortedSessionsRef: React.MutableRefObject<Set<string>>;
  /** 按会话缓存的 MCP 列表（含连接中状态），用于区分会话、避免异步回推串台 */
  mcpServersBySessionRef: React.MutableRefObject<Map<string, McpServerInfo[]>>;
  cursorPositionRef: React.MutableRefObject<number | null>;
  choiceCursorPositionRef: React.MutableRefObject<number | null>;
  /** 由"+"或启动时新建、尚未发送过消息的会话 id */
  newChatSessionRef: React.MutableRefObject<string | null>;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  choiceInputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
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
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  modelRef: ModelRef | undefined;
  contextLength: number;
  inputAreaRef: React.RefObject<any>;
}

export function useMessageHandler(props: UseMessageHandlerProps): void {
  // 消息监听 effect 只挂载一次（deps 为 []），handleMessage 闭包捕获的是首次渲染的 props。
  // 值类型的 props（settingsDefaults / model / currentFile 等）会随后续渲染更新，
  // 直接读取永远是初始值（会导致会话快照保存错误状态、新建会话用错默认值等）。
  // 统一通过 propsRef 读取最新值；ref 类 props 本身不变，但读取路径保持一致也无副作用。
  const propsRef = useRef(props);
  propsRef.current = props;
  // 使用 ref 追踪 contextLength 的最新值，避免 useEffect 闭包捕获过期值
  const contextLengthRef = useRef(props.contextLength);
  contextLengthRef.current = props.contextLength;
  // 使用 ref 追踪 messages 的最新值，便于在消息事件回调中判断当前会话是否已有消息
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  // 每个 session 本轮 query 的起始时间（用于计算首 token 耗时 TTFT）。
  // queryBegin 时写入、queryEnd 时删除。
  const queryStartBySessionRef = useRef<Map<string, number>>(new Map());

  // 每个 session 最近一次「模型产出活动」的时间（流式 delta / streamEnd / 工具完成 / 新消息）。
  // 每个 thinking block 的 "Thinking for Xs" 从这里算起，而不是从 query 起点累计：
  // 思考→工具→思考… 时，后一个 block 只统计「它自己开始前」到首 token 的耗时。
  const lastActivityBySessionRef = useRef<Map<string, number>>(new Map());

  // 已打开会话的消息缓存（仅内存，不持久化）。
  // 切换对话时 webview 会清空消息并从磁盘重新加载，实时字段（streamId 等）会丢失，
  // 导致流式性能统计（Thinking for / chars / tokens）消失。这里按 session 缓存最近一次
  // 的消息对象，重新加载时把 streamId 关联回去，保证同一 webview 内切走再切回不丢数据。
  //
  // 不设上限：所有已打开的对话都保留。
  // 释放时机：Electron 下每个对话是独立 WebContentsView，关闭（或 LRU 淘汰）时整个
  // 渲染进程销毁，缓存随之释放；VS Code 侧没有「关闭对话」操作，故不额外清理。
  const sessionMessagesCacheRef = useRef<Map<string, Message[]>>(new Map());

  // 把当前会话的最新消息写入内存缓存。
  // 注意：切换对话瞬间 setMessages([]) 会先触发一次空数组，此时不能覆盖缓存，
  // 否则切走时就把缓存清掉了（旧会话的消息仍在缓存里，等切回来时用）。
  useEffect(() => {
    const sid = props.currentSessionIdRef.current;
    if (!sid || props.messages.length === 0) return;
    const cache = sessionMessagesCacheRef.current;
    cache.delete(sid);
    cache.set(sid, props.messages);
  }, [props.messages]);

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

    /**
     * 把排队消息回填到输入框：与用户当前草稿用 \n 连接（草稿为空时直接使用排队内容）。
     * 目标会话为当前会话时写入实时输入框；否则写入该会话的状态快照，
     * 保证切换回去后仍能看到回填的草稿。
     *
     * 唯一实现在 restoreQueuedMessage.ts，排队项「编辑」撤回（useAppHandlers）共用。
     */
    const restoreQueuedMessage = (targetSessionId: string, queued: QueuedMessagePayload) =>
      restoreQueuedMessageToInput(props, targetSessionId, queued);

    const handleMessage = (event: MessageEvent<HostToWebviewWire>) => {
      // wire 数据在运行时无类型：只验「有字符串 type」即按协议窄化（分发靠 switch 判别）
      const data: unknown = event.data;
      if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
      const msg = data as HostToWebviewWire;
      const sessionId = props.currentSessionIdRef.current ?? undefined;
      // 会话级同步消息（setModel / setAgentMode 等）只作用于当前展示的会话
      const hostSessionId = msg.sessionId;
      const fromCurrentSession = !hostSessionId || hostSessionId === sessionId;
      profileLog(`[Webview] handleMessage: type=${msg.type} sessionId=${hostSessionId?.substring(0, 20) ?? ''} currentSessionId=${(sessionId || '').substring(0, 20)}`);

      const ctx: HandlerContext = {
        props,
        propsRef,
        contextLengthRef,
        messagesRef,
        queryStartBySessionRef,
        lastActivityBySessionRef,
        sessionMessagesCacheRef,
        scrollToBottomBeforeRender,
        restoreQueuedMessageToInput: restoreQueuedMessage,
        sessionId,
        fromCurrentSession,
        hostSessionId,
      };

      switch (msg.type) {
        case 'showThinkingAnimation':
          handleStreamShowThinkingAnimation(msg, ctx);
          break;
        case 'aiBegin':
        case 'aiEnd':
          handleStreamAiEnd(msg, ctx);
          break;
        case 'queryBegin':
          handleStreamQueryBegin(msg, ctx);
          break;
        case 'queryEnd':
          handleStreamQueryEnd(msg, ctx);
          break;
        case 'streamMessage':
          handleStreamStreamMessage(msg, ctx);
          break;
        case 'streamEnd':
          handleStreamStreamEnd(msg, ctx);
          break;
        case 'compressProgress':
          handleStreamCompressProgress(msg, ctx);
          break;
        case 'addMessage':
          handleToolAddMessage(msg, ctx);
          break;
        case 'updateToolArgs':
          handleToolUpdateToolArgs(msg, ctx);
          break;
        case 'updateToolStatus':
          handleToolUpdateToolStatus(msg, ctx);
          break;
        case 'toolProgress':
          handleToolToolProgress(msg, ctx);
          break;
        case 'requestUserChoice':
          handleToolRequestUserChoice(msg, ctx);
          break;
        case 'toolMetaData':
          handleToolToolMetaData(msg, ctx);
          break;
        case 'initSessionState':
          handleConversationInitSessionState(msg, ctx);
          break;
        case 'setConversationListOwner':
          handleConversationSetConversationListOwner(msg, ctx);
          break;
        case 'setCurrentFile':
          handleConversationSetCurrentFile(msg, ctx);
          break;
        case 'setTitle':
          handleConversationSetTitle(msg, ctx);
          break;
        case 'conversationsData':
          handleConversationConversationsData(msg, ctx);
          break;
        case 'sessionRuntimeStates':
          handleConversationSessionRuntimeStates(msg, ctx);
          break;
        case 'sessionCompletionAttention':
          handleConversationSessionCompletionAttention(msg, ctx);
          break;
        case 'conversationLoaded':
          handleConversationConversationLoaded(msg, ctx);
          break;
        case 'messagesReplaced':
          handleConversationMessagesReplaced(msg, ctx);
          break;
        case 'queuedMessage':
          handleConversationQueuedMessage(msg, ctx);
          break;
        case 'clearQueuedMessage':
          handleConversationClearQueuedMessage(msg, ctx);
          break;
        case 'smartNamingResult':
          handleConversationSmartNamingResult(msg, ctx);
          break;
        case 'expandCompactDone':
          handleConversationExpandCompactDone(msg, ctx);
          break;
        case 'setTheme':
          handleConfigSetTheme(msg, ctx);
          break;
        case 'setModel':
          handleConfigSetModel(msg, ctx);
          break;
        case 'setAgentMode':
          handleConfigSetAgentMode(msg, ctx);
          break;
        case 'setPromptMode':
          handleConfigSetPromptMode(msg, ctx);
          break;
        case 'setThinkingMode':
          handleConfigSetThinkingMode(msg, ctx);
          break;
        case 'setWebSearch':
          handleConfigSetWebSearch(msg, ctx);
          break;
        case 'setMcpServers':
          handleConfigSetMcpServers(msg, ctx);
          break;
        case 'setModels':
          handleConfigSetModels(msg, ctx);
          break;
        case 'setSkills':
          handleConfigSetSkills(msg, ctx);
          break;
        case 'contextLimitUpdated':
          handleConfigContextLimitUpdated(msg, ctx);
          break;
        case 'notice':
          handleConfigNotice(msg, ctx);
          break;
        case 'settingsDefaults':
          handleConfigSettingsDefaults(msg, ctx);
          break;
        case 'providerModelsResult':
          handleConfigProviderModelsResult(msg, ctx);
          break;
        case 'setNewConversationDefaults':
          handleConfigSetNewConversationDefaults(msg, ctx);
          break;
        case 'llmConfigSaved':
          handleConfigLlmConfigSaved(msg, ctx);
          break;
        case 'showLLMConfig':
          handleConfigShowLLMConfig(msg, ctx);
          break;
        case 'balanceUpdate':
          handleConfigBalanceUpdate(msg, ctx);
          break;
        case 'focusInput':
          handleConfigFocusInput(msg, ctx);
          break;
        case 'activatePrewarmedView':
          handleConfigActivatePrewarmedView(msg, ctx);
          break;
        default: {
          // 穷尽守卫：下行消息（HostToWebviewWire）每条都必须有显式去向——
          // switch 里有 case，或登记进 WebviewIgnoredDownlinkType。收窄后剩余
          // 类型超出清单时本行编译报错（新增消息漏接在此暴露，不靠运行期警告）。
          const ignored: WebviewIgnoredDownlinkType = msg;
          void ignored;
          // 运行期仍可能有清单外的 type（跨版本宿主 / wire 数据未校验），保留提示
          if (!warnedUnknownMessageTypes.has(msg.type)) {
            warnedUnknownMessageTypes.add(msg.type);
            console.warn(`[Webview] Unknown message type: ${msg.type}（同类消息仅提示一次）`);
          }
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
}

import { useCallback, useEffect, useRef } from 'react';
import { hasHostMessageApi, postMessage } from '../webviewEnv';
import { profileLog } from '../debug';
import type { Message, QueuedMessagePayload, UserChoiceRequest, SessionState, SessionRuntimeState, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, IdleSuspendedMessage, SendMessageWire } from '../types';
import type { SessionCreator } from '../../shared/sessionCreator';
import { createSessionState, type SessionStatesStore } from '../sessionState';
import { ensureImageSize } from '../imageSize';
import { restoreQueuedMessageToInput } from './restoreQueuedMessage';
import { buildConversationTitle } from '../../shared/utils/contentBlocks';
import type { ModelRef } from '../../shared/llm/modelRef';
import { t } from '../i18n';

const profileTag = '[Profile]';

export interface UseAppHandlersProps {
  // state values
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  fileHidden: boolean;
  conversations: Array<any>;
  conversationsLoading: boolean;
  conversationDropdownOpen: boolean;
  conversationTitle: string;
  currentSessionId: string | null;
  parentSessionId: string | null;
  hasActiveQuery: boolean;
  contextLength: number;
  maxContextTokens: number | null;
  /** 会话询问模式；undefined = 尚未从宿主获取到（不代宿主决定） */
  agentMode: AgentMode | undefined;
  thinkingMode: ThinkingMode | undefined;
  /** 会话关联的提示词模式（普通/极简/混合，持久化到 meta.json） */
  promptMode: PromptMode | undefined;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  modelRef: ModelRef | undefined;
  /** 会话关联的 Web Search 开关；undefined = 尚未从宿主获取到 */
  webSearch: boolean | undefined;
  /** settings.json 中的默认值（新对话一次性使用） */
  settingsDefaults: SettingsDefaults;
  hasCompactArchive: boolean;
  isCompactExpanded: boolean;
  queuedMessage: QueuedMessagePayload | null;
  deleteConfirm: { sessionId: string; title: string } | null;
  userChoiceRequest: UserChoiceRequest | null;
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  messages: Message[];
  // setters
  setCurrentFile: (v: string) => void;
  setSelectedLines: (v: { start: number; end: number } | null) => void;
  setFileHidden: React.Dispatch<React.SetStateAction<boolean>>;
  setConversations: React.Dispatch<React.SetStateAction<Array<any>>>;
  setConversationsLoading: (v: boolean) => void;
  setConversationDropdownOpen: (v: boolean) => void;
  setConversationTitle: (v: string) => void;
  setCurrentSessionId: (v: string | null) => void;
  setParentSessionId: (v: string | null) => void;
  /** 会话创建者（specs/025 FR-002）：返回按钮按它跨工作区跳发起方或跳本地父会话 */
  setCreator: (v: SessionCreator | null) => void;
  /** 当前会话的子代理角色（conversationLoaded.metadata.role，specs/020 FR-005）；普通会话为 null */
  setSubAgentRole: (v: string | null) => void;
  setHasActiveQuery: (v: boolean) => void;
  setContextLength: (v: number | ((prev: number) => number)) => void;
  setMaxContextTokens: (v: number | null) => void;
  setForceScrollKey: (v: number | ((prev: number) => number)) => void;
  /** undefined = 尚未从宿主获取到（保持等待态，不写猜测值） */
  setAgentMode: (v: AgentMode | undefined) => void;
  setThinkingMode: (v: ThinkingMode | undefined) => void;
  setPromptMode: (v: PromptMode | undefined) => void;
  setWebSearch: (v: boolean | undefined) => void;
  setModelRef: (v: ModelRef | undefined) => void;
  setHasCompactArchive: (v: boolean) => void;
  setIsCompactExpanded: (v: boolean) => void;
  setQueuedMessage: (v: QueuedMessagePayload | null) => void;
  setDeleteConfirm: (v: { sessionId: string; title: string } | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setUserChoiceRequest: (v: UserChoiceRequest | null) => void;
  setShowThinkingAnimation: (v: boolean) => void;
  setExpandedSubSessions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setNamingSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  // refs
  currentSessionIdRef: React.MutableRefObject<string | null>;
  sessionStates: SessionStatesStore;
  commandHistoryRef: React.MutableRefObject<Map<string, string[]>>;
  cursorPositionRef: React.MutableRefObject<number | null>;
  choiceCursorPositionRef: React.MutableRefObject<number | null>;
  userChoiceRequestRef: React.MutableRefObject<UserChoiceRequest | null>;
  userChoiceInputRef: React.MutableRefObject<string>;
  savedMainInputRef: React.MutableRefObject<string>;
  queuedMessageRef: React.MutableRefObject<Map<string, QueuedMessagePayload>>;
  /** 用户主动 abort 的会话集合，queryEnd 时用于把排队消息回填到输入框 */
  abortedSessionsRef: React.MutableRefObject<Set<string>>;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  choiceInputRef: React.RefObject<HTMLTextAreaElement | null>;
  isDeletingRef: React.MutableRefObject<boolean>;
  listLoadedOnceRef: React.MutableRefObject<boolean>;
  /** 由顶部"+"新建、尚未发送过消息的会话 id（新对话草稿相关） */
  newChatSessionRef: React.MutableRefObject<string | null>;
  /** "新对话"里已输入但未发送的草稿（新对话草稿相关） */
  newChatDraftRef: React.MutableRefObject<{ input: string; pastedImages?: SessionState['pastedImages'] } | null>;
  // special
  setCurrentSessionIdRef: (sid: string | null) => void;
  inputAreaRef: React.RefObject<any>;
  COMMAND_HISTORY_MAX: number;
  _appMountTime: React.MutableRefObject<number | null>;
  // 空闲发送挂起（docs/features/user-message-pipeline.md FR-003）：webview 本地事实，ref 是唯一写入点，version 递增触发重渲染
  idleSuspendedRef: React.MutableRefObject<Map<string, IdleSuspendedMessage>>;
  setIdleSuspendedVersion: (v: number | ((prev: number) => number)) => void;
  /** 会话运行时快照（core 推送的全量 states）：空闲判定与挂起项 GC 的事实源 */
  sessionRuntimeStatesRef: React.MutableRefObject<Map<string, SessionRuntimeState>>;
  /** 快照推送信号：每次 sessionRuntimeStates 到达递增，挂起项的触发与清理挂在其上 */
  sessionIdleVersion: number;
}

export interface UseAppHandlersReturn {
  formatRelativeTime: (timestamp: string | number) => string;
  loadConversations: () => void;
  onStartup: () => void;
  handleSend: () => Promise<void>;
  /** 空闲发送（US-46）：提交时机推迟到会话空闲；空闲时等价立即发送 */
  handleSendIdle: () => Promise<void>;
  handleAbort: () => void;
  handleCompress: () => void;
  handleEditQueuedMessage: () => void;
  handleDeleteQueuedMessage: () => void;
  /** 空闲挂起项「编辑」：撤回到输入框（与排队项撤回同一实现，纯本地动作） */
  handleEditIdleSuspended: () => void;
  /** 空闲挂起项「删除」：直接丢弃（纯本地动作） */
  handleDeleteIdleSuspended: () => void;
  handleUserChoiceResponse: (index: number, reply?: string) => void;
  handleUserChoiceSubmit: (inputValue: string) => void;
  handleChoiceResponse: (index: number) => void;
  handleToggleFileHidden: () => void;
  toggleSubSession: (sessionId: string) => void;
}

export function useAppHandlers(props: UseAppHandlersProps): UseAppHandlersReturn {
  // 用 ref 保存最新默认值，避免 onStartup（挂载时闭包）等被 useCallback 固定的回调读到过期值
  const settingsDefaultsRef = useRef(props.settingsDefaults);
  settingsDefaultsRef.current = props.settingsDefaults;

  const formatRelativeTime = useCallback((timestamp: string | number): string => {
    const now = Date.now();
    const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
    const diff = now - time;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('handlers.justNow');
    if (minutes < 60) return t('handlers.minutesAgo', { count: minutes });
    if (hours < 24) return t('handlers.hoursAgo', { count: hours });
    if (days <= 7) return t('handlers.daysAgo', { count: days });

    // 超过7天显示具体日期
    const date = new Date(time);
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
  }, []);

  const loadConversations = useCallback(() => {
    if (!hasHostMessageApi()) return;

    // 非首次加载：跳过 loading 状态，直接用旧数据展示，后台静默刷新
    if (props.listLoadedOnceRef.current) {
      postMessage({ type: 'getConversations' });
      return;
    }

    props.setConversationsLoading(true);
    postMessage({ type: 'getConversations' });
  }, []);

  const onStartup = () => {
    const startupTime = performance.now();
    profileLog(`[Webview] onStartup: currentSessionIdRef=${props.currentSessionIdRef.current?.substring(0, 20) || 'null'}`);
    // 如果已有 session，不重复生成
    if (props.currentSessionIdRef.current) {
      return;
    }
    props.setConversationTitle(t('app.untitled'));
    props.setParentSessionId(null);
    props.setCreator(null);
    // 新建会话无子代理角色（specs/020 FR-005），置灰判定回到普通会话
    props.setSubAgentRole(null);
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    // 启动时生成的这个会话同样是"新建但还没发消息"的对话：
    // 不登记的话，用户在这里输入后切走再点"新建"，草稿会被当成普通会话丢掉。
    props.newChatSessionRef.current = newSessionId;
    props.setMessages([]);
    props.inputAreaRef.current?.setValue('');
    props.inputAreaRef.current?.setPastedImages?.([]);
    props.setUserChoiceRequest(null);
    props.userChoiceInputRef.current = '';
    props.savedMainInputRef.current = '';
    props.setContextLength(0);
    props.setCurrentSessionId(newSessionId);
    props.setCurrentSessionIdRef(newSessionId);
    // 新对话使用 settings.json 中的默认值（一次性设置，避免先显示 manual 再跳变）。
    // 默认值未就绪（undefined）时保留当前值，不写入任何兜底默认。
    const sd = settingsDefaultsRef.current;
    const nextAgentMode = sd.agentMode ?? props.agentMode;
    const nextThinkingMode = sd.thinkingMode ?? props.thinkingMode;
    const nextWebSearch = sd.webSearch ?? props.webSearch;
    // 模型身份整体跟随默认值：settingsDefaults 未就绪时保留当前选择
    const nextModelRef = sd.modelRef ?? props.modelRef;
    const nextPromptMode = sd.promptMode ?? props.promptMode;
    props.setAgentMode(nextAgentMode);
    props.setThinkingMode(nextThinkingMode);
    props.setWebSearch(nextWebSearch);
    props.setModelRef(nextModelRef);
    props.setPromptMode(nextPromptMode);
    // 为新对话创建默认 state
    props.sessionStates.set(newSessionId, createSessionState({
      agentMode: nextAgentMode,
      promptMode: nextPromptMode,
      thinkingMode: nextThinkingMode,
      webSearch: nextWebSearch,
      modelRef: nextModelRef,
    }));
    postMessage({ type: 'startNewConversation', sessionId: newSessionId });
    // 聚焦输入框
    setTimeout(() => {
      props.mainInputRef.current?.focus();
      profileLog(`${profileTag} onStartup 输入框聚焦 | 从挂载到输入框可聚焦=${(performance.now() - props._appMountTime.current!).toFixed(2)}ms`);
    }, 0);
    profileLog(`${profileTag} onStartup 完成 | session创建+postMsg=${(performance.now() - startupTime).toFixed(2)}ms`);
  };

  /**
   * 用户消息提交的收尾（乐观列表刷新 + 命令历史 + 上送）：立即发送与空闲挂起的触发提交
   * 共用这同一条管线（docs/features/user-message-pipeline.md FR-003「按立即发送语义提交」）。排队登记不在发送侧做——
   * 宿主按引擎忙碌状态回推 queuedMessage，保证登记与清除都只有宿主一个来源
   * （docs/features/user-message-pipeline.md FR-003、docs/architecture/principles.md 第 7 节）。
   */
  const submitUserMessage = useCallback((wire: SendMessageWire) => {
    const sessionId = wire.sessionId;
    const messageContent = wire.content;
    const pastedImages = wire.images ?? [];

    // 用户主动发消息后立即在本地对话列表中刷新修改时间，使其排到最前，
    // 无需等待后端落盘 + 刷新列表；新会话则插入占位项。
    // 后端返回 conversationsData 后会用权威数据替换/校正。
    props.setConversations(prev => {
      const now = Date.now();
      const existingIdx = prev.findIndex(c => c.sessionId === sessionId);
      if (existingIdx !== -1) {
        // 已存在：只刷新 updatedAt，排序由 useConversationTree 按 updatedAt 完成
        const next = prev.slice();
        next[existingIdx] = { ...prev[existingIdx], updatedAt: now };
        return next;
      }
      return [{
        sessionId,
        project: '',
        title: buildConversationTitle(messageContent, pastedImages),
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
        ...(props.parentSessionId ? { parentSessionId: props.parentSessionId } : {}),
      }, ...prev];
    });

    // Save to per-session command history
    if (sessionId && messageContent.trim()) {
      const history = props.commandHistoryRef.current.get(sessionId) || [];
      // Avoid duplicate consecutive entries
      if (history.length === 0 || history[0] !== messageContent.trim()) {
        history.unshift(messageContent.trim());
        if (history.length > props.COMMAND_HISTORY_MAX) {
          history.length = props.COMMAND_HISTORY_MAX;
        }
        props.commandHistoryRef.current.set(sessionId, history);
      }
    }

    postMessage(wire);
  }, []);

  /**
   * 从输入框构造用户消息载荷：读文本 / 图片、判空、双来源排队守卫、清输入框、会话解析。
   * 立即发送（handleSend）与空闲发送（handleSendIdle）共用同一段构造——空闲发送拿到
   * 同一载荷后挂起而非提交（US-46/FR-003）。返回 null 表示无内容或被守卫拦下。
   */
  const buildUserMessageFromInput = async (): Promise<SendMessageWire | null> => {
    const inputValue = props.inputAreaRef.current?.getValue() ?? '';
    const rawPastedImages: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }> =
      props.inputAreaRef.current?.getPastedImages?.() ?? [];
    // 发送前补齐图片宽高，供 core 层生成 Image[<width>*<height>] 标题
    const pastedImages = await Promise.all(rawPastedImages.map((img) => ensureImageSize(img)));
    if (!inputValue.trim() && pastedImages.length === 0) return null;
    // 已有待处理消息时不允许再发（发送按钮置灰 + Enter 同守卫）：忙碌排队项与空闲挂起项
    // 同为「一次只有一条」，改主意走横幅上的编辑 / 删除（docs/features/user-message-pipeline.md FR-003），
    // 不靠继续提交覆盖。
    {
      const sid = props.currentSessionIdRef.current;
      if (sid && (props.queuedMessageRef.current.has(sid) || props.idleSuspendedRef.current.has(sid))) return null;
    }

    // Preserve cursor position before clearing - we'll restore it when user types after abort
    props.cursorPositionRef.current = props.mainInputRef.current?.selectionStart ?? inputValue.length;

    props.inputAreaRef.current?.clear();

    // Send message to VSCode extension
    if (!hasHostMessageApi()) {
      throw new Error('VSCode API not available - this webview must be run within VSCode');
    }

    // ─── 普通消息发送 ───────────────────────────────────────────────
    // 新对话里发出的第一条消息：草稿已被消费，清掉暂存，避免下次"新建"又把旧内容带回来。
    // 判断必须在生成新 sessionId 之前做 —— 此时 currentSessionId 仍指向那个未发送的新对话。
    if (props.currentSessionIdRef.current === props.newChatSessionRef.current) {
      props.newChatSessionRef.current = null;
      props.newChatDraftRef.current = null;
    }

    // Generate session ID if not exists
    let sessionId = props.currentSessionIdRef.current;
    if (!sessionId) {
      sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      props.setCurrentSessionIdRef(sessionId);
      props.setCurrentSessionId(sessionId);
      // 新对话使用 settings.json 中的默认值（一次性设置，避免跳变）；
      // 未就绪时保留当前值，不写入兜底默认。
      const sd = settingsDefaultsRef.current;
      const nextAgentMode = sd.agentMode ?? props.agentMode;
      const nextThinkingMode = sd.thinkingMode ?? props.thinkingMode;
      const nextWebSearch = sd.webSearch ?? props.webSearch;
      // 模型身份整体跟随默认值：settingsDefaults 未就绪时保留当前选择
      const nextModelRef = sd.modelRef ?? props.modelRef;
      const nextPromptMode = sd.promptMode ?? props.promptMode;
      props.setAgentMode(nextAgentMode);
      props.setThinkingMode(nextThinkingMode);
      props.setWebSearch(nextWebSearch);
      props.setModelRef(nextModelRef);
      props.setPromptMode(nextPromptMode);
      // 为新对话创建默认 state
      props.sessionStates.set(sessionId, createSessionState({
        agentMode: nextAgentMode,
        promptMode: nextPromptMode,
        thinkingMode: nextThinkingMode,
        webSearch: nextWebSearch,
        modelRef: nextModelRef,
      }));
      // 重置压缩状态（新对话没有压缩）
      props.setHasCompactArchive(false);
      props.setIsCompactExpanded(false);
    }

    const messagePayload: SendMessageWire = {
      // 用户消息只有一个 wire 类型：是否排队由宿主按引擎忙碌状态决定，
      // 排队项由宿主回推 queuedMessage 建立（见 docs/architecture/host-ui-modules.md 第 3 节）。
      type: 'sendMessage',
      sessionId,
      content: inputValue,
      images: pastedImages.length > 0 ? pastedImages : undefined,
      filePath: props.currentFile,
      fileHidden: props.fileHidden,
      selectedLines: props.selectedLines ?? undefined,
      // 会话配置只带「已从宿主获取到」的字段：未到达的字段留空，
      // 由宿主按自己的配置解析（webview 不代宿主决定，`docs/hosts/webview-facts.md` 第 5 节）。
      agentMode: props.agentMode,
      thinkingMode: props.thinkingMode,
      webSearch: props.webSearch,
      // promptMode 不随消息下发：由独立的 setPromptMode 消息承载（会话级持久化）
      // 模型身份随消息一起下发：避免 setModel 消息尚未处理时用错 provider。
      // wire 协议保持扁平：拆成 model / provider 两个字段。
      model: props.modelRef?.model,
      provider: props.modelRef?.provider,
    };
    return messagePayload;
  };

  const handleSend = async () => {
    const wire = await buildUserMessageFromInput();
    if (wire) submitUserMessage(wire);
  };

  /**
   * 空闲发送（US-46/FR-003）：构造与立即发送同一载荷。提交时刻该会话快照**显式忙碌**
   * （`idle === false`）才挂起为 webview 本地待发项（不上送宿主，宿主契约不变）；
   * 快照缺失（未登记的新会话等）视为本就空闲、等价立即发送——是否排队最终仍由宿主
   * 按引擎忙碌状态裁决，消息不会因判定缺失而滞留。挂起项由空闲触发 effect 提交。
   */
  const handleSendIdle = async () => {
    const wire = await buildUserMessageFromInput();
    if (!wire) return;
    if (props.sessionRuntimeStatesRef.current.get(wire.sessionId)?.idle !== false) {
      submitUserMessage(wire);
      return;
    }
    props.idleSuspendedRef.current.set(wire.sessionId, {
      sessionId: wire.sessionId,
      uuid: `idle_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      wire,
    });
    props.setIdleSuspendedVersion((v) => v + 1);
  };

  const handleAbort = useCallback(() => {
    if (!hasHostMessageApi()) {
      throw new Error('VSCode API not available');
    }

    const sessionId = props.currentSessionIdRef.current;
    // 中止回填优先（docs/features/user-message-pipeline.md FR-003）：挂起中的空闲发送项随中止回填输入框、不再自动
    // 提交。同步清挂起项先于 abort 上行与空闲触发 effect（触发以 ref 为事实源，先清
    // 后到即 no-op），「空闲推送 vs 中止 queryEnd」的竞态在这里收敛。
    const suspended = sessionId ? props.idleSuspendedRef.current.get(sessionId) : undefined;
    if (sessionId && suspended) {
      props.idleSuspendedRef.current.delete(sessionId);
      props.setIdleSuspendedVersion((v) => v + 1);
      restoreQueuedMessageToInput(props, sessionId, suspendedAsQueued(suspended));
    }
    // 标记该会话被用户主动中止：queryEnd 到达时若有排队消息，
    // 不再回发它，而是回填到输入框由用户自行修改。
    if (sessionId) {
      props.abortedSessionsRef.current.add(sessionId);
    }

    postMessage({
      type: 'abort',
      sessionId: sessionId ?? undefined,
    });
  }, []);

  /**
   * 排队项「编辑 / 删除」的共用实现：清除本端排队项，并通知 core 丢弃引擎队列里
   * 尚未消费的同一消息（按 uuid 配对，`docs/features/user-message-pipeline.md` FR-003）。
   * 与 abort 的 queryEnd 回填一样复用 restoreQueuedMessageToInput，但不置
   * abortedSessionsRef——撤回排队项不打断正在运行的查询。
   */
  const discardQueuedMessage = useCallback((restoreToInput: boolean) => {
    if (!hasHostMessageApi()) {
      throw new Error('VSCode API not available');
    }

    const sessionId = props.currentSessionIdRef.current;
    const queued = sessionId ? props.queuedMessageRef.current.get(sessionId) : undefined;
    if (!sessionId || !queued) return;

    // 排队项是 webview 拥有的 UI 状态：用户主动撤回时本地先清除（发送按钮随
    // queuedMessage 恢复可用），引擎侧的同一消息由 discardQueuedMessage 撤销。
    props.queuedMessageRef.current.delete(sessionId);
    props.setQueuedMessage(null);
    if (restoreToInput) {
      restoreQueuedMessageToInput(props, sessionId, queued);
    }
    postMessage({
      type: 'discardQueuedMessage',
      sessionId,
      uuid: queued.uuid,
    });
  }, []);

  /** 排队项「编辑」：把排队消息撤回到输入框（与 abort 的回填同一实现） */
  const handleEditQueuedMessage = useCallback(() => discardQueuedMessage(true), [discardQueuedMessage]);

  /** 排队项「删除」：丢弃排队消息，不回填输入框 */
  const handleDeleteQueuedMessage = useCallback(() => discardQueuedMessage(false), [discardQueuedMessage]);

  /** 挂起项转排队横幅字段视图：复用 restoreQueuedMessageToInput 与横幅展示的实现 */
  const suspendedAsQueued = (suspended: IdleSuspendedMessage): QueuedMessagePayload => ({
    sessionId: suspended.sessionId,
    uuid: suspended.uuid,
    content: suspended.wire.content,
    images: suspended.wire.images,
    filePath: suspended.wire.filePath,
    selectedLines: suspended.wire.selectedLines,
    fileHidden: suspended.wire.fileHidden,
  });

  /**
   * 空闲挂起项的「编辑 / 删除」共用实现（docs/features/user-message-pipeline.md FR-003）：纯本地动作——挂起项不经
   * 宿主，没有 discardQueuedMessage 对应物；编辑回填复用 restoreQueuedMessageToInput，
   * 不置 abortedSessionsRef、不打断正在运行的查询。
   */
  const discardIdleSuspended = useCallback((restoreToInput: boolean) => {
    const sessionId = props.currentSessionIdRef.current;
    const suspended = sessionId ? props.idleSuspendedRef.current.get(sessionId) : undefined;
    if (!sessionId || !suspended) return;
    props.idleSuspendedRef.current.delete(sessionId);
    props.setIdleSuspendedVersion((v) => v + 1);
    if (restoreToInput) {
      restoreQueuedMessageToInput(props, sessionId, suspendedAsQueued(suspended));
    }
  }, []);

  /** 空闲挂起项「编辑」：撤回到输入框（与排队项 / abort 回填同一实现） */
  const handleEditIdleSuspended = useCallback(() => discardIdleSuspended(true), [discardIdleSuspended]);

  /** 空闲挂起项「删除」：直接丢弃，不回填输入框 */
  const handleDeleteIdleSuspended = useCallback(() => discardIdleSuspended(false), [discardIdleSuspended]);

  // 空闲挂起的自动触发与清理（docs/features/user-message-pipeline.md FR-003），随运行时快照推送（sessionIdleVersion 递增）执行：
  // - 清理：**非空**快照中不再包含该会话（core 已卸载它 = 已关闭 / 释放）→ 挂起项清除、
  //   不提交；空快照视为信息不足（启动期补拉的种子 / 尚无会话），不回收、不触发。
  // - 触发：该会话快照显式 `idle === true` 才提交（快照缺失不猜——不过度 fallback），
  //   提交走立即发送语义的同一管线；此刻若会话又忙碌，宿主按既有排队语义接收，消息不丢。
  useEffect(() => {
    const suspended = props.idleSuspendedRef.current;
    if (suspended.size === 0) return;
    const states = props.sessionRuntimeStatesRef.current;
    let touched = false;
    if (states.size > 0) {
      for (const sid of [...suspended.keys()]) {
        if (!states.has(sid)) {
          suspended.delete(sid);
          touched = true;
        }
      }
    }
    for (const [sid, item] of [...suspended]) {
      if (states.get(sid)?.idle !== true) continue;
      suspended.delete(sid);
      touched = true;
      submitUserMessage(item.wire);
    }
    if (touched) props.setIdleSuspendedVersion((v) => v + 1);
  }, [props.sessionIdleVersion, submitUserMessage]);

  const handleCompress = useCallback(() => {
    if (!hasHostMessageApi()) {
      throw new Error('VSCode API not available');
    }

    const sessionId = props.currentSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    postMessage({
      type: 'requestCompress',
      sessionId,
    });
  }, []);

  const handleUserChoiceResponse = useCallback((index: number, reply?: string) => {
    // use ref to avoid stale closure over userChoiceRequest
    const currentRequest = props.userChoiceRequestRef.current;
    if (!hasHostMessageApi() || !currentRequest) {
      return;
    }

    postMessage({
      type: 'respondUserChoice',
      choiceId: currentRequest.choiceId,
      index,
      reply,
    });

    // 清空用户选择输入框
    props.userChoiceInputRef.current = '';
    props.setUserChoiceRequest(null);
    // 同步清除 session 状态，避免切换对话后再次弹出
    if (props.currentSessionIdRef.current && props.sessionStates.has(props.currentSessionIdRef.current)) {
      props.sessionStates.get(props.currentSessionIdRef.current)!.userChoiceRequest = null;
    }
    // 恢复主输入框焦点和光标位置
    setTimeout(() => {
      props.mainInputRef.current?.focus();
      const currentInput = props.inputAreaRef.current?.getValue() ?? '';
      const pos = Math.min(props.cursorPositionRef.current ?? currentInput.length, currentInput.length);
      props.mainInputRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }, []);

  const handleUserChoiceSubmit = useCallback((inputValue: string) => {
    const currentRequest = props.userChoiceRequestRef.current;
    if (!currentRequest) return;

    // 没有 choices 时（纯输入框），传 index=-1 表示未选择选项
    const hasChoices = currentRequest.choices && currentRequest.choices.length > 0;
    postMessage({
      type: 'respondUserChoice',
      choiceId: currentRequest.choiceId,
      index: hasChoices ? 1 : -1,
      reply: inputValue || undefined,
    });

    // 清空用户选择输入框
    props.userChoiceInputRef.current = '';
    props.setUserChoiceRequest(null);
    // 同步清除 session 状态，避免切换对话后再次弹出
    if (props.currentSessionIdRef.current && props.sessionStates.has(props.currentSessionIdRef.current)) {
      props.sessionStates.get(props.currentSessionIdRef.current)!.userChoiceRequest = null;
    }
    // 恢复主输入框焦点和光标位置
    setTimeout(() => {
      props.mainInputRef.current?.focus();
      const currentInput = props.inputAreaRef.current?.getValue() ?? '';
      const pos = Math.min(props.cursorPositionRef.current ?? currentInput.length, currentInput.length);
      props.mainInputRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }, []);

  const handleChoiceResponse = useCallback((index: number) => {
    handleUserChoiceResponse(index);
  }, [handleUserChoiceResponse]);

  const handleToggleFileHidden = useCallback(() => props.setFileHidden(prev => !prev), [props.setFileHidden]);

  const toggleSubSession = useCallback((sessionId: string) => {
    props.setExpandedSubSessions(prev => ({
      ...prev,
      [sessionId]: !prev[sessionId],
    }));
  }, []);


  return {
    formatRelativeTime,
    loadConversations,
    onStartup,
    handleSend,
    handleSendIdle,
    handleAbort,
    handleCompress,
    handleEditQueuedMessage,
    handleDeleteQueuedMessage,
    handleEditIdleSuspended,
    handleDeleteIdleSuspended,
    handleUserChoiceResponse,
    handleUserChoiceSubmit,
    handleChoiceResponse,
    handleToggleFileHidden,
    toggleSubSession,
  };
}

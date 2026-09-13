import { useCallback, useRef } from 'react';
import { hasVscodeApi, postMessage } from '../webviewEnv';
import { profileLog } from '../debug';
import type { Message, QueuedMessagePayload, UserChoiceRequest, SessionState, AgentMode, PromptMode, ThinkingMode, SettingsDefaults } from '../types';
import { ensureImageSize } from '../imageSize';
import { buildConversationTitle } from '../../core/utils/contentBlocks';
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
  agentMode: AgentMode;
  thinkingMode: ThinkingMode;
  /** 会话关联的提示词模式（普通/极简/混合，持久化到 meta.json） */
  promptMode: PromptMode;
  model: string;
  /** 会话关联的 Web Search 开关 */
  webSearch: boolean;
  /** settings.json 中的默认值（新对话一次性使用） */
  settingsDefaults: SettingsDefaults;
  hasCompactArchive: boolean;
  isCompactExpanded: boolean;
  queuedMessage: QueuedMessagePayload | null;
  serverLoadWarning: string | null;
  stats: any;
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
  setHasActiveQuery: (v: boolean) => void;
  setContextLength: (v: number | ((prev: number) => number)) => void;
  setMaxContextTokens: (v: number | null) => void;
  setForceScrollKey: (v: number | ((prev: number) => number)) => void;
  setAgentMode: (v: AgentMode) => void;
  setThinkingMode: (v: ThinkingMode) => void;
  setPromptMode: (v: PromptMode) => void;
  setWebSearch: (v: boolean) => void;
  setModel: (v: string) => void;
  setHasCompactArchive: (v: boolean) => void;
  setIsCompactExpanded: (v: boolean) => void;
  setQueuedMessage: (v: QueuedMessagePayload | null) => void;
  setServerLoadWarning: (v: string | null) => void;
  setStats: (v: any) => void;
  setDeleteConfirm: (v: { sessionId: string; title: string } | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setUserChoiceRequest: (v: UserChoiceRequest | null) => void;
  setShowThinkingAnimation: (v: boolean) => void;
  setExpandedSubSessions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setNamingSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  // refs
  currentSessionIdRef: React.MutableRefObject<string | null>;
  sessionStatesRef: React.MutableRefObject<Map<string, SessionState>>;
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
}

export interface UseAppHandlersReturn {
  formatRelativeTime: (timestamp: string | number) => string;
  loadConversations: () => void;
  onStartup: () => void;
  handleSend: () => Promise<void>;
  handleAbort: () => void;
  handleCompress: () => void;
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
    if (!hasVscodeApi()) return;

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
    // 新对话使用 settings.json 中的默认值（一次性设置，避免先显示 manual 再跳变）
    props.setAgentMode(settingsDefaultsRef.current.agentMode);
    props.setThinkingMode(settingsDefaultsRef.current.thinkingMode);
    props.setWebSearch(settingsDefaultsRef.current.webSearch);
    props.setModel(settingsDefaultsRef.current.model);
    props.setPromptMode(settingsDefaultsRef.current.promptMode);
    // 为新对话创建默认 state
    props.sessionStatesRef.current.set(newSessionId, {
      input: '',
      inputCursorPosition: 0,
      choiceCursorPosition: 0,
      userChoiceRequest: null,
      userChoiceInput: '',
      showThinkingAnimation: false,
      animationMode: 'thinking',
      hasActiveQuery: false,
      agentMode: settingsDefaultsRef.current.agentMode,
      promptMode: settingsDefaultsRef.current.promptMode,
      thinkingMode: settingsDefaultsRef.current.thinkingMode,
      webSearch: settingsDefaultsRef.current.webSearch,
      contextLength: 0,
      queuedMessage: null,
      model: settingsDefaultsRef.current.model,
    });
    postMessage({ type: 'startNewConversation', sessionId: newSessionId });
    postMessage({ type: 'setActiveSessionId', sessionId: newSessionId });
    // 聚焦输入框
    setTimeout(() => {
      props.mainInputRef.current?.focus();
      profileLog(`${profileTag} onStartup 输入框聚焦 | 从挂载到输入框可聚焦=${(performance.now() - props._appMountTime.current!).toFixed(2)}ms`);
    }, 0);
    profileLog(`${profileTag} onStartup 完成 | session创建+postMsg=${(performance.now() - startupTime).toFixed(2)}ms`);
  };

  const handleSend = async () => {
    const inputValue = props.inputAreaRef.current?.getValue() ?? '';
    const rawPastedImages: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }> =
      props.inputAreaRef.current?.getPastedImages?.() ?? [];
    // 发送前补齐图片宽高，供 core 层生成 Image[<width>*<height>] 标题
    const pastedImages = await Promise.all(rawPastedImages.map((img) => ensureImageSize(img)));
    if (!inputValue.trim() && pastedImages.length === 0) return;

    // ─── 服务器负载检查 ───────────────────────────────────────────
    // 如果已显示警告，阻止发送
    if (props.serverLoadWarning) {
      return;
    }
    // 条件1: 周一~周五
    const now = new Date();
    const dayOfWeek = now.getDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    // 条件2: 9:30~12:00 或 14:00~18:00
    const hour = now.getHours();
    const minute = now.getMinutes();
    const timeMinutes = hour * 60 + minute;
    const isPeakTime = (timeMinutes >= 570 && timeMinutes < 720) || (timeMinutes >= 840 && timeMinutes < 1080);
    // 条件3: context > 250K
    const isLargeContext = props.contextLength > 250_000;

    if (isWeekday && isPeakTime && isLargeContext) {
      // 向扩展发送负载检查请求，等待返回
      const warning = await new Promise<string | null>((resolve) => {
        const handler = (event: MessageEvent) => {
          const msg = event.data;
          if (msg.type === 'serverLoadResult') {
            window.removeEventListener('message', handler);
            resolve(msg.showWarning ? (msg.warningText || null) : null);
          }
        };
        window.addEventListener('message', handler);
        // 设置超时，5秒后忽略检查继续发送
        setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 5000);
        postMessage({ type: 'checkServerLoad', sessionId: props.currentSessionIdRef.current, contextLength: props.contextLength });
      });

      if (warning) {
        props.setServerLoadWarning(warning);
        return; // 不发送消息
      }
    }
    // 清除之前的警告（如果有）
    props.setServerLoadWarning(null);

    // Preserve cursor position before clearing - we'll restore it when user types after abort
    props.cursorPositionRef.current = props.mainInputRef.current?.selectionStart ?? inputValue.length;
    const messageContent = inputValue;

    props.inputAreaRef.current?.clear();

    // Send message to VSCode extension
    if (!hasVscodeApi()) {
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
      // 新对话使用 settings.json 中的默认值（一次性设置，避免跳变）
      props.setAgentMode(settingsDefaultsRef.current.agentMode);
      props.setThinkingMode(settingsDefaultsRef.current.thinkingMode);
      props.setWebSearch(settingsDefaultsRef.current.webSearch);
      props.setModel(settingsDefaultsRef.current.model);
      props.setPromptMode(settingsDefaultsRef.current.promptMode);
      // 为新对话创建默认 state
      props.sessionStatesRef.current.set(sessionId, {
        input: '',
        inputCursorPosition: 0,
        choiceCursorPosition: 0,
        userChoiceRequest: null,
        userChoiceInput: '',
        showThinkingAnimation: false,
        animationMode: 'thinking',
        hasActiveQuery: false,
        agentMode: settingsDefaultsRef.current.agentMode,
        promptMode: settingsDefaultsRef.current.promptMode,
        thinkingMode: settingsDefaultsRef.current.thinkingMode,
        webSearch: settingsDefaultsRef.current.webSearch,
        contextLength: 0,
        queuedMessage: null,
        model: settingsDefaultsRef.current.model,
      });
      // 重置压缩状态（新对话没有压缩）
      props.setHasCompactArchive(false);
      props.setIsCompactExpanded(false);
      // Notify extension to set active session
      postMessage({ type: 'setActiveSessionId', sessionId });
    }

    const messagePayload = {
      type: props.hasActiveQuery ? 'queueMessage' as const : 'sendMessage' as const,
      sessionId,
      content: messageContent,
      images: pastedImages.length > 0 ? pastedImages : undefined,
      filePath: props.currentFile,
      fileHidden: props.fileHidden,
      selectedLines: props.selectedLines,
      agentMode: props.agentMode,
      thinkingMode: props.thinkingMode,
      webSearch: props.webSearch,
      promptMode: props.promptMode,
    };

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

    if (props.hasActiveQuery) {
      // 当前有查询在进行，消息排队（按会话绑定，切换会话后仍归属正确会话）
      // 同时保存文件上下文，避免 queryEnd 重新投递时丢失 filePath/selectedLines
      const queuedPayload: QueuedMessagePayload = {
        sessionId,
        content: messageContent,
        images: pastedImages.length > 0 ? pastedImages : undefined,
        filePath: props.currentFile || undefined,
        selectedLines: props.selectedLines || undefined,
        fileHidden: props.fileHidden,
      };
      props.queuedMessageRef.current.set(sessionId, queuedPayload);
      props.setQueuedMessage(queuedPayload);
    }

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

    postMessage(messagePayload);
  };

  const handleAbort = useCallback(() => {
    if (!hasVscodeApi()) {
      throw new Error('VSCode API not available');
    }

    const sessionId = props.currentSessionIdRef.current;
    // 标记该会话被用户主动中止：queryEnd 到达时若有排队消息，
    // 不再回发它，而是回填到输入框（见 useMessageHandler 的 queryEnd 处理）。
    if (sessionId) {
      props.abortedSessionsRef.current.add(sessionId);
    }

    postMessage({
      type: 'abort',
      sessionId,
    });
  }, []);

  const handleCompress = useCallback(() => {
    if (!hasVscodeApi()) {
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
    if (!hasVscodeApi() || !currentRequest) {
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
    if (props.currentSessionIdRef.current && props.sessionStatesRef.current.has(props.currentSessionIdRef.current)) {
      props.sessionStatesRef.current.get(props.currentSessionIdRef.current)!.userChoiceRequest = null;
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
    if (props.currentSessionIdRef.current && props.sessionStatesRef.current.has(props.currentSessionIdRef.current)) {
      props.sessionStatesRef.current.get(props.currentSessionIdRef.current)!.userChoiceRequest = null;
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
    handleAbort,
    handleCompress,
    handleUserChoiceResponse,
    handleUserChoiceSubmit,
    handleChoiceResponse,
    handleToggleFileHidden,
    toggleSubSession,
  };
}

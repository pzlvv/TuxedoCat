/**
 * TUI 渲染事实的唯一来源（docs/tui.md 第 4 节）。
 *
 * 模式对齐 webview 侧的 `src/webview/sessionState.ts`：wire 协议（HostToWebviewMessage）
 * 是事实，本 store 是只读投影——不反推、不猜默认值（DEVELOPMENT.md 第 12 章原则）；
 * 事实未到达用 `null` / `undefined` 表达等待态，不填默认值。
 *
 * 除 wire 消息外，还有一组 `tui:` 前缀的本地动作（激活会话、开关覆盖层、本地通知）：
 * 它们是终端 UI 自己拥有的事实（不来自 core），与 wire 消息同走一个 reducer，
 * 保证「一份渲染事实只有一个写入点」。
 *
 * 纯函数 reducer：对 v1 不渲染的已知消息类型显式原样返回（注释标明理由）；
 * 对不认识的 type 返回 `'unhandled'`，由 store 记日志丢弃——与 core 对未知词汇的
 * 口径一致，新增协议词汇不至于打挂已运行的 TUI。
 */

import type { HostToWebviewMessage } from '../host/webviewMessages.js';
import type { SessionRuntimeState } from '../core/AssistantEventBus.js';
import type { ProviderModels } from '../core/webviewTypes.js';
import type { MessageData } from '../core/types.js';
import { noticeText } from './i18n.js';

// ── 状态形状 ──

/** 消息流里的一条（wire `addMessage` / `streamEnd` / 会话加载的共同形状） */
export interface TuiMessage {
  id: number;
  role: 'user' | 'thinking' | 'toolcall' | 'system' | 'assistant';
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  status: 'normal' | 'success' | 'running' | 'fail';
  /** 当前上下文 token 数（input + output；仅 thinking / assistant 携带） */
  contextTokens: number;
  /** 用户消息的 uuid（与排队项配对清除） */
  messageUuid: string | null;
  isCompactSummary: boolean;
}

/** 流式缓冲：streamMessage 累积、streamEnd / queryEnd 收敛 */
export interface TuiStreamBlock {
  role: 'thinking' | 'assistant';
  text: string;
}

/** 会话级投影（每会话一份；只在会话被打开 / 收到消息时存在） */
export interface TuiSessionState {
  sessionId: string;
  title: string | null;
  messages: TuiMessage[];
  stream: TuiStreamBlock | null;
  showThinking: boolean;
  queued: { uuid: string | null; content: string } | null;
  contextTokens: number;
  /** 会话配置（null = 事实未到达，显示等待态，不猜默认值） */
  model: string | null;
  provider: string | null;
  agentMode: 'manual' | 'risk' | 'auto' | null;
  thinkingMode: 'off' | 'low' | 'high' | 'max' | null;
  promptMode: 'normal' | 'minimal' | 'mixed' | null;
  webSearch: boolean | null;
}

/** 瞬时提示（core notice 翻译后的文本 / TUI 本地提示） */
export interface TuiNotice {
  id: number;
  text: string;
  level: 'info' | 'warn' | 'error';
  at: number;
}

/** 待回答的用户选择 / 权限确认（wire `requestUserChoice` 的投影） */
export interface TuiPendingChoice {
  sessionId: string;
  choiceId: string;
  toolName: string;
  message: string;
  choices: ReadonlyArray<{ label: string; description?: string }>;
}

/** 全屏只读覆盖层（虚拟文档 / diff；带色行由 UIHost 的 show* 方法组装） */
export interface TuiOverlay {
  kind: 'document' | 'diff';
  title: string;
  lines: ReadonlyArray<{ text: string; color: 'green' | 'red' | 'cyan' | 'yellow' | 'gray' | 'white' }>;
}

export interface TuiConversationSummary {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  parentSessionId?: string;
}

export interface TuiState {
  /** 会话投影表（key = sessionId）；只含被打开过 / 收到过消息的会话 */
  sessions: Readonly<Record<string, TuiSessionState>>;
  activeSessionId: string | null;
  conversations: ReadonlyArray<TuiConversationSummary>;
  runtimeStates: ReadonlyArray<SessionRuntimeState>;
  notices: ReadonlyArray<TuiNotice>;
  /** settings.json 的会话级默认值；null = 未到达（启动期转圈） */
  settingsDefaults: {
    model: string;
    provider: string | null;
    thinkingMode: 'off' | 'low' | 'high' | 'max' | null;
    agentMode: 'manual' | 'risk' | 'auto' | null;
    promptMode: 'normal' | 'minimal' | 'mixed' | null;
    webSearch: boolean | null;
  } | null;
  models: { providers: ReadonlyArray<ProviderModels>; activeProvider: string } | null;
  skills: ReadonlyArray<{ name: string; description: string; isBuiltin?: boolean }>;
  mcpServers: ReadonlyArray<{ name: string; enabled: boolean }> | null;
  pendingChoice: TuiPendingChoice | null;
  overlay: TuiOverlay | null;
  maxContextTokens: number | null;
  balance: { totalBalance: number; currency: string } | null;
}

// ── 动作 ──

/** 终端 UI 自己拥有的事实（不来自 core，不进 wire 协议） */
export type TuiLocalAction =
  | { type: 'tui:activateSession'; sessionId: string | null }
  | { type: 'tui:closeConversationView'; sessionId: string }
  | { type: 'tui:notice'; text: string; level: 'info' | 'warn' | 'error' }
  | { type: 'tui:dismissNotice'; id: number }
  | { type: 'tui:showOverlay'; overlay: TuiOverlay }
  | { type: 'tui:closeOverlay' };

export type TuiAction = HostToWebviewMessage | TuiLocalAction;

// ── 初始状态与工具 ──

export function initialTuiState(): TuiState {
  return {
    sessions: {},
    activeSessionId: null,
    conversations: [],
    runtimeStates: [],
    notices: [],
    settingsDefaults: null,
    models: null,
    skills: [],
    mcpServers: null,
    pendingChoice: null,
    overlay: null,
    maxContextTokens: null,
    balance: null,
  };
}

let nextMessageId = 1;
let nextNoticeId = 1;

function emptySession(sessionId: string): TuiSessionState {
  return {
    sessionId,
    title: null,
    messages: [],
    stream: null,
    showThinking: false,
    queued: null,
    contextTokens: 0,
    model: null,
    provider: null,
    agentMode: null,
    thinkingMode: null,
    promptMode: null,
    webSearch: null,
  };
}

type SessionMap = Record<string, TuiSessionState>;

/** 就地浅拷贝语义下的会话写入（immutable 更新；不存在则先建空会话） */
function withSession(state: TuiState, sessionId: string, mutate: (session: TuiSessionState) => TuiSessionState | void): TuiState {
  const sessions: SessionMap = { ...state.sessions };
  const existing = sessions[sessionId] ?? emptySession(sessionId);
  const next = { ...existing };
  const result = mutate(next) ?? next;
  sessions[sessionId] = result;
  return { ...state, sessions };
}

function pushNotice(state: TuiState, text: string, level: 'info' | 'warn' | 'error'): TuiState {
  const notices = [...state.notices, { id: nextNoticeId++, text, level, at: Date.now() }];
  // 只保留最近 5 条（旧提示不再占行；UI 层再按时效消散）
  return { ...state, notices: notices.slice(-5) };
}

function messageFromWire(role: TuiMessage['role'], content: string, extra: Partial<TuiMessage> = {}): TuiMessage {
  return {
    id: nextMessageId++,
    role,
    content,
    toolName: extra.toolName ?? null,
    toolCallId: extra.toolCallId ?? null,
    status: extra.status ?? 'normal',
    contextTokens: extra.contextTokens ?? 0,
    messageUuid: extra.messageUuid ?? null,
    isCompactSummary: extra.isCompactSummary ?? false,
  };
}

function messageFromHistory(data: MessageData): TuiMessage {
  return messageFromWire(data.role, data.content, {
    toolName: data.toolName ?? null,
    toolCallId: data.toolCallId ?? null,
    status: data.status ?? 'normal',
    contextTokens: (data.contextLength || 0) + (data.outputTokens || 0),
    messageUuid: data.messageUuid ?? null,
    isCompactSummary: !!data.isCompactSummary,
  });
}

/** 工具卡片状态只升不降（success/fail 是终态，迟到的 normal 不回退） */
const TOOL_STATUS_PRIORITY: Record<TuiMessage['status'], number> = { normal: 0, running: 1, success: 2, fail: 2 };

// ── reducer ──

/**
 * 纯 reducer：wire 消息 + 本地动作 → 新状态。
 * 返回 `'unhandled'` 表示动作类型不被认识（store 记日志丢弃）。
 */
export function reduceTuiState(state: TuiState, action: TuiAction): TuiState | 'unhandled' {
  switch (action.type) {
    // ===== 本地动作 =====
    case 'tui:activateSession':
      return { ...state, activeSessionId: action.sessionId };
    case 'tui:closeConversationView':
      // 只在正查看该会话时切出（回到「选择 / 新建」空态）；其余情况无显示变化
      return state.activeSessionId === action.sessionId
        ? { ...state, activeSessionId: null }
        : state;
    case 'tui:notice':
      return pushNotice(state, action.text, action.level);
    case 'tui:dismissNotice':
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
    case 'tui:showOverlay':
      return { ...state, overlay: action.overlay };
    case 'tui:closeOverlay':
      return { ...state, overlay: null };

    // ===== 消息流 =====
    case 'addMessage': {
      let next = state;
      // 排队消息被后端消费后按 uuid 清除（在会话过滤之前，别的会话也要清）
      if (action.role === 'user' && action.messageUuid) {
        const queued = state.sessions[action.sessionId]?.queued;
        if (queued && queued.uuid === action.messageUuid) {
          next = withSession(state, action.sessionId, (s) => {
            s.queued = null;
          });
        }
      }
      return withSession(next, action.sessionId, (s) => {
        // 工具卡片按 toolCallId 去重（历史恢复已建卡片时，实时 addMessage 就地更新）
        if (action.role === 'toolcall' && action.toolCallId) {
          const idx = s.messages.findIndex((m) => m.role === 'toolcall' && m.toolCallId === action.toolCallId);
          if (idx >= 0) {
            const existing = s.messages[idx];
            const messages = [...s.messages];
            messages[idx] = {
              ...existing,
              content: action.content ?? existing.content,
              status: (TOOL_STATUS_PRIORITY[action.status ?? 'normal'] ?? 0)
                >= (TOOL_STATUS_PRIORITY[existing.status] ?? 0)
                ? (action.status ?? 'normal')
                : existing.status,
            };
            s.messages = messages;
            return;
          }
        }
        // 流式定稿（streamEnd）与持久化回放（addMessage）可能相邻重复：同角色同内容且
        // 紧邻时不再追加（webview 侧靠流式块生命周期规避，这里用相邻去重达到同一效果）
        const last = s.messages[s.messages.length - 1];
        const candidate = messageFromWire(action.role, action.content, {
          toolName: action.toolName ?? null,
          toolCallId: action.toolCallId ?? null,
          status: action.status ?? 'normal',
          contextTokens: (action.contextLength || 0) + (action.outputTokens || 0),
          messageUuid: action.messageUuid ?? null,
          isCompactSummary: !!action.isCompactSummary,
        });
        if (!(last && last.role === candidate.role && last.content === candidate.content)) {
          s.messages = [...s.messages, candidate];
        }
        // token 用量：input + output（服务端值直接采用，不取 max——压缩后数值会变小）
        if (candidate.contextTokens > 0) s.contextTokens = candidate.contextTokens;
        // 工具调用强制关闭 thinking 动画（WebSearch 例外：发生在 LLM 流内，保留动画）
        if (action.role === 'toolcall') {
          const norm = (action.toolName || '').toLowerCase().replace(/[-_]/g, '');
          s.showThinking = norm === 'websearch';
        }
      });
    }
    case 'streamMessage':
      return withSession(state, action.sessionId, (s) => {
        s.stream = { role: action.role, text: action.accumulated };
      });
    case 'streamEnd': {
      const usage = action.usage;
      const total = usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : 0;
      return withSession(state, action.sessionId, (s) => {
        if (s.stream && s.stream.role === action.role) s.stream = null;
        const last = s.messages[s.messages.length - 1];
        if (!(last && last.role === action.role && last.content === action.accumulated)) {
          s.messages = [...s.messages, messageFromWire(action.role, action.accumulated, { contextTokens: total })];
        }
        if (total > 0) s.contextTokens = total;
      });
    }
    case 'showThinkingAnimation':
      return withSession(state, action.sessionId, (s) => {
        s.showThinking = action.show !== false;
      });
    case 'aiBegin':
      return withSession(state, action.sessionId, (s) => {
        s.showThinking = true;
      });
    case 'aiEnd':
      return withSession(state, action.sessionId, (s) => {
        s.showThinking = false;
        s.stream = null;
      });
    case 'queryEnd':
      // abort 等路径没有 streamEnd：收敛悬挂的流式缓冲，避免永久「转圈」
      return withSession(state, action.sessionId, (s) => {
        s.stream = null;
        s.showThinking = false;
      });
    case 'updateToolStatus':
      return withSession(state, action.sessionId, (s) => {
        const idx = s.messages.findIndex((m) => m.role === 'toolcall' && m.toolCallId === action.toolCallId);
        if (idx < 0) return;
        const messages = [...s.messages];
        const existing = messages[idx];
        // 状态只升不降：迟到的 normal 不能把 success/fail 拉回去
        const nextStatus = action.status !== undefined
        && (TOOL_STATUS_PRIORITY[action.status] ?? 0) >= (TOOL_STATUS_PRIORITY[existing.status] ?? 0)
          ? action.status
          : existing.status;
        messages[idx] = {
          ...existing,
          status: nextStatus,
          content: action.output ?? existing.content,
        };
        s.messages = messages;
      });
    case 'toolProgress':
      return withSession(state, action.sessionId, (s) => {
        const idx = s.messages.findIndex((m) => m.role === 'toolcall' && m.toolCallId === action.toolCallId);
        if (idx < 0) return;
        const messages = [...s.messages];
        messages[idx] = { ...messages[idx], content: action.output ?? messages[idx].content };
        s.messages = messages;
      });

    // ===== 排队 =====
    case 'queuedMessage':
      return withSession(state, action.sessionId, (s) => {
        s.queued = { uuid: action.uuid ?? null, content: action.content };
      });
    case 'clearQueuedMessage':
      return withSession(state, action.sessionId, (s) => {
        s.queued = null;
      });

    // ===== 会话生命周期 =====
    case 'conversationLoaded': {
      const history = Array.isArray(action.conversation?.messages)
        ? (action.conversation.messages as MessageData[]).map(messageFromHistory)
        : [];
      return withSession(state, action.sessionId, (s) => {
        s.messages = history;
        s.stream = null;
        s.showThinking = !!action.hasActiveQuery;
        s.title = action.conversation?.metadata?.title ?? s.title;
        s.model = action.model ?? action.conversation?.metadata?.model ?? null;
        s.provider = action.provider ?? action.conversation?.metadata?.provider ?? null;
        const ctx = action.conversation?.metadata?.context;
        s.agentMode = action.agentMode ?? ctx?.agentMode ?? null;
        s.thinkingMode = ctx?.thinkingMode ?? null;
        s.promptMode = ctx?.promptMode ?? null;
        s.webSearch = ctx?.webSearch ?? null;
        s.contextTokens = ctx?.totalContextTokens ?? 0;
      });
    }
    case 'messagesReplaced':
      return withSession(state, action.sessionId, (s) => {
        s.messages = action.messages.map(messageFromHistory);
      });
    case 'setTitle':
      return withSession(state, action.sessionId, (s) => {
        s.title = action.title;
      });
    case 'smartNamingResult':
      return withSession(state, action.sessionId, (s) => {
        s.title = action.title;
      });
    case 'conversationsData':
      return { ...state, conversations: action.conversations.map((c) => ({ ...c })) };
    case 'sessionRuntimeStates':
      return { ...state, runtimeStates: action.states.map((s) => ({ ...s })) };

    // ===== 用户选择 / 权限确认 =====
    case 'requestUserChoice':
      return {
        ...state,
        pendingChoice: {
          sessionId: action.sessionId,
          choiceId: action.choiceId,
          toolName: action.toolName,
          message: action.message,
          choices: action.choices ? [...action.choices] : [],
        },
      };

    // ===== 配置面 =====
    case 'settingsDefaults':
      return {
        ...state,
        settingsDefaults: {
          model: action.model,
          provider: action.provider ?? null,
          thinkingMode: action.thinkingMode ?? null,
          agentMode: action.agentMode ?? null,
          promptMode: action.promptMode ?? null,
          webSearch: action.webSearch ?? null,
        },
      };
    case 'setModels':
      return { ...state, models: { providers: [...action.providers], activeProvider: action.activeProvider ?? '' } };
    case 'setSkills':
      return { ...state, skills: action.skills.map((s) => ({ ...s })) };
    case 'setMcpServers':
      return { ...state, mcpServers: action.servers.map((s) => ({ name: s.name, enabled: !!s.enabled })) };
    case 'contextLimitUpdated':
      return { ...state, maxContextTokens: action.maxContextTokens };
    case 'balanceUpdate':
      return {
        ...state,
        balance: action.totalBalance === null || action.currency === null
          ? null
          : { totalBalance: action.totalBalance, currency: action.currency },
      };
    case 'notice':
      return pushNotice(state, noticeText(action.key, action.params), action.level);
    case 'compressProgress':
      // 压缩进度走瞬时提示（start / complete / error 三态都是一次性事件）
      return pushNotice(
        state,
        action.status === 'start'
          ? noticeText('compress.started', {})
          : action.status === 'complete'
            ? noticeText('compress.completed', { tokens: action.postCompactTokenCount ?? 0 })
            : noticeText('compress.failed', {}),
        action.status === 'error' ? 'error' : 'info',
      );
    case 'expandCompactDone':
      return pushNotice(state, noticeText('compact.expanded', {}), 'info');

    // ===== 会话配置确认（宿主广播的 BidirectionalWebviewMessage，core 收敛结果） =====
    case 'setModel':
      return withSession(state, action.sessionId, (s) => {
        s.model = action.model;
        s.provider = action.provider ?? s.provider;
      });
    case 'setAgentMode':
      return withSession(state, action.sessionId, (s) => {
        s.agentMode = action.mode;
      });
    case 'setThinkingMode':
      return withSession(state, action.sessionId, (s) => {
        s.thinkingMode = action.mode;
      });
    case 'setPromptMode':
      return withSession(state, action.sessionId, (s) => {
        s.promptMode = action.mode;
      });
    case 'setWebSearch':
      return withSession(state, action.sessionId, (s) => {
        s.webSearch = action.webSearch;
      });

    // ===== v1 显式不渲染（原样返回；协议词汇已认识，语义留给后续版本） =====
    // - setTheme / focusInput / activatePrewarmedView / setConversationListOwner：宿主专有 UI 语义
    // - setCurrentFile / updateToolArgs / toolMetaData：文件引用 chips 与紧凑 diff 的数据面
    // - setNewConversationDefaults / initSessionState / llmConfigSaved / showLLMConfig /
    //   providerModelsResult / providerModelsFetched / llmConfigSaveError：配置面板（webview 专属）
    // - conversationSpacesData / conversationSpaceCleared / conversationSpaceError：对话空间管理页
    // - queryBegin：状态栏只读 sessionRuntimeStates（全量投影，不从这里推导）
    case 'setTheme':
    case 'focusInput':
    case 'activatePrewarmedView':
    case 'setConversationListOwner':
    case 'setCurrentFile':
    case 'updateToolArgs':
    case 'toolMetaData':
    case 'setNewConversationDefaults':
    case 'initSessionState':
    case 'llmConfigSaved':
    case 'llmConfigSaveError':
    case 'showLLMConfig':
    case 'providerModelsResult':
    case 'providerModelsFetched':
    case 'conversationSpacesData':
    case 'conversationSpacesError':
    case 'conversationSpaceCleared':
    case 'queryBegin':
      return state;

    default: {
      // 联合类型穷尽性检查：新增 wire 词汇时这里在编译期暴露，运行期按未知词汇丢弃
      const exhaustive: never = action;
      void exhaustive;
      return 'unhandled';
    }
  }
}

// ── store（订阅 + dispatch；状态不可变更新） ──

export interface TuiStore {
  getState(): TuiState;
  dispatch(action: TuiAction): void;
  subscribe(listener: () => void): () => void;
}

export function createTuiStore(log: (line: string) => void): TuiStore {
  let state = initialTuiState();
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action: TuiAction): void {
      const next = reduceTuiState(state, action);
      if (next === 'unhandled') {
        log(`[tui] 丢弃未认识的消息 type=${(action as { type: string }).type}`);
        return;
      }
      if (next !== state) {
        state = next;
        for (const listener of [...listeners]) listener();
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ── 选择器（纯函数；组件层只经它们读状态） ──

export function activeSession(state: TuiState): TuiSessionState | null {
  return state.activeSessionId === null ? null : state.sessions[state.activeSessionId] ?? null;
}

/** 会话运行态（sessionRuntimeStates 的单项投影；没有记录视为空闲） */
export function runtimeOf(state: TuiState, sessionId: string | null): SessionRuntimeState | null {
  if (!sessionId) return null;
  return state.runtimeStates.find((s) => s.sessionId === sessionId) ?? null;
}

/** 运行态 → 状态栏 / abort 语义的展示名（对齐侧栏流水灯的词汇） */
export function runtimeLabel(state: SessionRuntimeState | null): string {
  if (!state) return '';
  if (state.compacting) return 'compacting';
  if (state.subAgentRunning) return 'subagent';
  if (state.backgroundRunning) return 'background';
  if (state.queryRunning) return 'running';
  if (state.waiting) return 'waiting';
  return 'idle';
}

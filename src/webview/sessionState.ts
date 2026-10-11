/**
 * SessionState 工厂与用量累加辅助。
 *
 * SessionState 字面量此前散落在 useMessageHandler / App / useAppHandlers 的十余处，
 * 各处字段并不一致（有的漏 totalCacheReadInputTokens 等字段、有的 thinkingMode
 * 硬编码 'off'），统一收敛到 createSessionState。
 *
 * 默认值取各处「最完整」版本（新建对话使用的 settingsDefaults 版本）。
 * 对原本漏写字段（undefined）的调用点，收敛后会得到合理默认值；
 * 逐字段核对过所有读取路径：
 * - totalCacheReadInputTokens / contextLength 等数值字段读取一律走 `x || 0` 或 `> 0` 判断，
 *   undefined 与 0 等价；
 * - animationMode 唯一的比较是 `=== 'compacting'`，undefined 与 'thinking' 等价；
 * - webSearch / pastedImages / preCompressHasActiveQuery 默认保持 undefined，
 *   不做默认填充（webSearch 的读取链 `savedState.webSearch ?? settingsDefaults.webSearch`
 *   依赖 undefined 触发回退，填 false 会改变行为）；
 * - promptMode / thinkingMode 同样默认 undefined：webview 不再内置兜底值，
 *   未从宿主 settings.json 获取到之前保持未设置，避免被误当成用户配置。
 */
import type { SessionState } from './types';

/**
 * 会话级 UI 状态的唯一容器（每 webview 一个实例）。
 *
 * 此前是裸 Map（App 的 useRef 持有、经 props 透传），App 与消息 handler 双方
 * 原地 get/set/has；收敛成 store 后 Map 与其写入口径只有这一份，读写全部
 * 走显式方法（getOrCreate 兜住「首次使用即创建」的样板）。
 */
export class SessionStatesStore {
  private readonly states = new Map<string, SessionState>();

  get(sessionId: string): SessionState | undefined {
    return this.states.get(sessionId);
  }

  set(sessionId: string, state: SessionState): void {
    this.states.set(sessionId, state);
  }

  has(sessionId: string): boolean {
    return this.states.has(sessionId);
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** 取或创建（切换会话 / 首次写入时的统一入口，避免 has+get+set 三连散落各处） */
  getOrCreate(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createSessionState();
      this.states.set(sessionId, state);
    }
    return state;
  }
}

export function createSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    input: '',
    pastedImages: undefined,
    inputCursorPosition: 0,
    choiceCursorPosition: 0,
    userChoiceRequest: null,
    userChoiceInput: '',
    showThinkingAnimation: false,
    animationMode: 'thinking',
    hasActiveQuery: false,
    preCompressHasActiveQuery: undefined,
    // 配置事实一律不设默认值：未从宿主获取到之前保持 undefined，
    // 避免 webview 内置兜底值被误当成用户配置（`docs/hosts/webview-facts.md` 第 3 节）。
    agentMode: undefined,
    promptMode: undefined,
    thinkingMode: undefined,
    webSearch: undefined,
    contextLength: 0,
    queuedMessage: null,
    modelRef: undefined,
    totalCacheReadInputTokens: 0,
    totalCacheCreationInputTokens: 0,
    totalInputTokens: 0,
    ...overrides,
  };
}

/**
 * 把一次 LLM 用量累加进已有 session state。
 * contextLength 直接使用服务端返回的 input+output（不取 max，压缩后服务端会返回
 * 更小的数值）；缓存 token 只在 assistant 消息上累加（thinking 与 assistant 携带
 * 相同 usage，重复累加会导致翻倍）。
 */
export function accumulateUsageToState(
  state: SessionState,
  role: string,
  totalTokens: number,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): void {
  state.contextLength = totalTokens;
  if (role === 'assistant') {
    // usage.input_tokens 已包含缓存部分，原始 input_tokens = inputTokens - cacheRead - cacheCreation
    const rawInputTokens = inputTokens - cacheReadTokens - cacheCreationTokens;
    state.totalCacheReadInputTokens = (state.totalCacheReadInputTokens || 0) + cacheReadTokens;
    state.totalCacheCreationInputTokens = (state.totalCacheCreationInputTokens || 0) + cacheCreationTokens;
    state.totalInputTokens = (state.totalInputTokens || 0) + Math.max(0, rawInputTokens);
  }
}

/**
 * 确保某会话存在 session state 并写入本次用量：
 * - state 已存在：累加（accumulateUsageToState）；
 * - state 不存在（例如子代理会话首次 LLM 回复 / 历史加载后首次发消息）：
 *   整份重建初始 state，缓存 token 按本次用量初始化（不是累加，避免从 0 变成本次值再翻倍）。
 */
export function ensureSessionStateWithUsage(
  sessionStates: SessionStatesStore,
  sessionId: string,
  role: string,
  totalTokens: number,
  inputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  overrides?: Partial<SessionState>,
): SessionState {
  const existing = sessionStates.get(sessionId);
  if (existing) {
    accumulateUsageToState(existing, role, totalTokens, inputTokens, cacheReadTokens, cacheCreationTokens);
    return existing;
  }
  const initial = createSessionState({
    ...overrides,
    contextLength: totalTokens,
    totalCacheReadInputTokens: role === 'assistant' ? cacheReadTokens : 0,
    totalCacheCreationInputTokens: role === 'assistant' ? cacheCreationTokens : 0,
    totalInputTokens: role === 'assistant' ? Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens) : 0,
  });
  sessionStates.set(sessionId, initial);
  return initial;
}

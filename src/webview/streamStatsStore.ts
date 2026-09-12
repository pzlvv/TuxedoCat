/**
 * 流式生成统计的全局存储（不依赖 React 组件生命周期）。
 *
 * 为什么放在组件外：
 *  - 切换对话时 ThinkingMessage 会被卸载，但流式仍在继续。统计放在这里由全局
 *    定时器每秒刷新，切回来时直接读到最新值（切换走期间只计算、不渲染）。
 *  - 历史恢复的消息没有 streamId，因此查不到统计，自然不显示。
 *
 * 时间口径：
 *  - ttftMs   ：首 token 耗时（query 开始 → 首个 token），登记后固定不变；
 *  - decodeMs ：decode 耗时（首个 token → 现在），每秒刷新，流结束时冻结。
 *
 * 计数口径：
 *  - 流式期间按累积文本的字符数（精确值，不估算）；
 *  - 流结束后优先用服务端返回的 token（thinking 优先 reasoning_tokens），
 *    拿不到 token 时继续按字符显示。
 */

export type StreamStatsUnit = 'chars' | 'tokens';

export interface StreamStats {
  /** 计数值（流式期间为字符数，完成后为 token 数） */
  count: number;
  /** 首 token 耗时（毫秒）；无起始时间时为 null（不显示 "Thinking for"） */
  ttftMs: number | null;
  /** decode 耗时（毫秒） */
  decodeMs: number;
  /** 平均生成速度（count / 秒，按 decode 时间计算） */
  rate: number;
  /** 计数单位 */
  unit: StreamStatsUnit;
  /** 是否仍在流式（组件据此决定是否需要本地定时刷新） */
  isStreaming: boolean;
}

interface Entry {
  streamId: string;
  sessionId: string;
  firstTokenAt: number | null;
  thinkingStartAt: number | null;
  chars: number;
  isStreaming: boolean;
  outputTokens?: number;
  reasoningTokens?: number;
  /** 流结束（或 abort）时冻结的 decode 耗时 */
  frozenDecodeMs: number | null;
  /** 缓存的计算结果，保证 getSnapshot 引用稳定 */
  stats: StreamStats | null;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
let tickerId: number | null = null;

function computeStats(entry: Entry): StreamStats | null {
  const reasoning = entry.reasoningTokens;
  const output = entry.outputTokens;
  const tokens = typeof reasoning === 'number' && reasoning > 0
    ? reasoning
    : (typeof output === 'number' && output > 0 ? output : undefined);
  const useTokens = !entry.isStreaming && tokens !== undefined;
  const count = useTokens ? tokens! : entry.chars;
  if (count <= 0) return null;

  const ttftMs = entry.firstTokenAt !== null && entry.thinkingStartAt !== null
    ? Math.max(0, entry.firstTokenAt - entry.thinkingStartAt)
    : null;

  const decodeMs = entry.isStreaming
    ? Math.max(1, Date.now() - (entry.firstTokenAt ?? Date.now()))
    : Math.max(1, entry.frozenDecodeMs ?? 1);

  return {
    count,
    ttftMs,
    decodeMs,
    rate: Math.round((count * 1000) / decodeMs),
    unit: useTokens ? 'tokens' : 'chars',
    isStreaming: entry.isStreaming,
  };
}

function notify(streamId: string): void {
  const set = listeners.get(streamId);
  if (!set) return;
  for (const cb of set) cb();
}

function refresh(entry: Entry): void {
  entry.stats = computeStats(entry);
  notify(entry.streamId);
}

function hasStreaming(): boolean {
  for (const entry of entries.values()) {
    if (entry.isStreaming) return true;
  }
  return false;
}

function startTicker(): void {
  if (tickerId !== null) return;
  tickerId = window.setInterval(() => {
    for (const entry of entries.values()) {
      if (entry.isStreaming) refresh(entry);
    }
    if (!hasStreaming()) stopTicker();
  }, 1000);
}

function stopTicker(): void {
  if (tickerId === null) return;
  window.clearInterval(tickerId);
  tickerId = null;
}

/** 冻结一个 entry 的 decode 耗时（流结束 / abort 时调用） */
function freeze(entry: Entry): void {
  entry.isStreaming = false;
  entry.frozenDecodeMs = entry.firstTokenAt !== null
    ? Math.max(1, Date.now() - entry.firstTokenAt)
    : 1;
}

/** 该 streamId 是否已登记统计（用于判断是否为该流的首个 delta） */
export function hasStreamStats(streamId: string): boolean {
  return entries.has(streamId);
}

/** 首个 delta：登记一个流式统计条目 */
export function beginThinkingStream(params: {
  streamId: string;
  sessionId: string;
  firstTokenAt: number;
  thinkingStartAt?: number | null;
}): void {
  const { streamId, sessionId, firstTokenAt, thinkingStartAt } = params;
  let entry = entries.get(streamId);
  if (!entry) {
    entry = {
      streamId,
      sessionId,
      firstTokenAt,
      thinkingStartAt: thinkingStartAt ?? null,
      chars: 0,
      isStreaming: true,
      frozenDecodeMs: null,
      stats: null,
    };
    entries.set(streamId, entry);
  } else {
    entry.sessionId = sessionId;
    if (entry.firstTokenAt === null) entry.firstTokenAt = firstTokenAt;
    if (entry.thinkingStartAt === null && thinkingStartAt != null) entry.thinkingStartAt = thinkingStartAt;
    entry.isStreaming = true;
    entry.frozenDecodeMs = null;
  }
  refresh(entry);
  startTicker();
}

/** 累积文本更新：只更新字符数，由每秒 ticker 统一刷新（避免每个 delta 都重渲染） */
export function updateStreamChars(streamId: string, chars: number): void {
  const entry = entries.get(streamId);
  if (!entry) return;
  entry.chars = chars;
}

/** 流结束：冻结 decode 耗时，并记录服务端返回的 token 数 */
export function endStream(
  streamId: string,
  usage?: { outputTokens?: number; reasoningTokens?: number },
): void {
  const entry = entries.get(streamId);
  if (!entry) return;
  freeze(entry);
  if (usage) {
    if (typeof usage.outputTokens === 'number' && usage.outputTokens > 0) entry.outputTokens = usage.outputTokens;
    if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) entry.reasoningTokens = usage.reasoningTokens;
  }
  refresh(entry);
  if (!hasStreaming()) stopTicker();
}

/**
 * 会话结束（含 abort）：冻结该会话所有仍在流式的统计，保留 abort 前最后一次的值。
 */
export function endStreamsForSession(sessionId: string): void {
  let changed = false;
  for (const entry of entries.values()) {
    if (!entry.isStreaming || entry.sessionId !== sessionId) continue;
    freeze(entry);
    refresh(entry);
    changed = true;
  }
  if (changed && !hasStreaming()) stopTicker();
}

/** 读取统计（useSyncExternalStore 的 getSnapshot；返回缓存对象保证引用稳定） */
export function getStreamStats(streamId: string | undefined | null): StreamStats | null {
  if (!streamId) return null;
  return entries.get(streamId)?.stats ?? null;
}

/** 订阅某个 streamId 的统计变化 */
export function subscribeStreamStats(streamId: string, cb: () => void): () => void {
  let set = listeners.get(streamId);
  if (!set) {
    set = new Set();
    listeners.set(streamId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(streamId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(streamId);
  };
}

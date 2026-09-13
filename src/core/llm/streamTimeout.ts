/**
 * LLM 流式请求看门狗（超时保护）
 *
 * 背景：
 * 部分 LLM 网关（例如 opencode/zen）会「接受连接后静默不响应」——
 * TCP/TLS 建连成功、请求体也发出去了，但服务端既不返回响应头，也不返回任何
 * SSE 事件；更有甚者会持续发送保活心跳（`ping` 事件 / SSE 注释行）把连接一直
 * 挂着。此时 undici 的 headersTimeout / bodyTimeout 会被不断到达的心跳重置，
 * 客户端永远等不到错误，表现为「进程无响应」：
 *
 *   19:12:20  === Responses LLM Request (stream) ===
 *   （之后 9 分钟一行日志都没有，请求既没完成也没报错）
 *
 * 解决：给流式请求加两层看门狗，超时后主动 abort 本次请求并抛出可识别的错误。
 *
 *   1. firstByteTimeoutMs（默认 300s）：从发起请求到收到**首个有效流事件**。
 *      注意判据是「有效事件」而不是「首个字节」——纯心跳不能算作进展，
 *      否则持续发 ping 的网关可以无限期绕过超时。
 *   2. idleTimeoutMs（默认 60s）：收到首个有效事件之后，两条有效事件之间的最大间隔。
 *
 * 「有效事件」指 type 以 `response.` 开头的 Responses API 事件（或各适配器自己
 * 认定的进展事件）。`ping`、SSE 注释、未知事件都不算进展，不会重置计时器。
 */

import { logger } from '../Logger.js';

/** 首字节（首个有效流事件）超时默认值：5 分钟 */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 300_000;
/** 流空闲超时默认值：60 秒 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
/**
 * 超时重试次数默认值。
 *
 * 与网络错误（各适配器的 MAX_RETRIES=3）分开计数：首字节超时最长要等 5 分钟，
 * 若沿用 3 次，用户最坏要等 20 分钟才能看到失败，因此默认只重试一次。
 */
export const DEFAULT_MAX_TIMEOUT_RETRIES = 1;

export type StreamTimeoutPhase = 'first-byte' | 'idle';

/**
 * 流式响应超时错误。
 *
 * 刻意不使用 `AbortError` 作为 name：上层（callResponsesLLM / RealApi / OpenAiApi）
 * 会把 AbortError 视为「用户主动取消」而静默丢弃，这里必须让它走错误上报路径，
 * 用户才能在界面上看到失败原因，而不是继续无限等待。
 */
export class LLMStreamTimeoutError extends Error {
  readonly phase: StreamTimeoutPhase;
  readonly timeoutMs: number;

  constructor(phase: StreamTimeoutPhase, timeoutMs: number) {
    super(
      phase === 'first-byte'
        ? `LLM 流式响应超时：${Math.round(timeoutMs / 1000)}s 内未收到任何有效输出事件`
        : `LLM 流式响应超时：连续 ${Math.round(timeoutMs / 1000)}s 无新的输出事件（流已停滞）`,
    );
    this.name = 'LLMTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export interface StreamWatchdog {
  /** 传给 undici fetch 的 signal（外部 signal 与超时都会触发它） */
  readonly signal: AbortSignal;
  /** 重新开始计时（每次请求尝试开始时调用，重试时首字节计时重新开始） */
  restart(): void;
  /**
   * 停止计时但保留看门狗（可再次 restart）。
   * 流已经正常读完、进入收尾处理时必须调用，否则收尾阶段会误报超时。
   */
  stop(): void;
  /** 每解析到一个有效流事件时调用，重置空闲计时器 */
  noteProgress(): void;
  /** 超时发生时的错误对象，未超时返回 null */
  timeoutError(): LLMStreamTimeoutError | null;
  /** 释放计时器与事件监听（必须调用，否则会泄漏定时器） */
  dispose(): void;
}

export interface StreamWatchdogOptions {
  /** 调用方传入的中断信号（用户点「停止」/ 发送新消息） */
  signal: AbortSignal | null;
  /** 首个有效流事件的超时时间，默认 300s */
  firstByteTimeoutMs?: number;
  /** 两条有效事件之间的最大间隔，默认 60s */
  idleTimeoutMs?: number;
  /** 日志组件名 */
  component?: string;
}

/**
 * 创建一个流式请求看门狗。
 *
 * 返回的 signal 需要传给 fetch；每解析到一个有效事件调用一次 noteProgress()；
 * 请求结束（成功/失败/重试）后必须调用 dispose()。
 */
export function createStreamWatchdog(options: StreamWatchdogOptions): StreamWatchdog {
  const component = options.component ?? 'LLM';
  const firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

  let controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timeoutError: LLMStreamTimeoutError | null = null;
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = (ms: number, phase: StreamTimeoutPhase): void => {
    clearTimer();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      if (disposed || timeoutError) return;
      timeoutError = new LLMStreamTimeoutError(phase, ms);
      logger.error(component, `${timeoutError.message}，主动中止本次请求`);
      // 触发 fetch / reader 失败，让上层走统一的错误处理与重试路径
      controller.abort();
    }, ms);
    // 计时器不应阻止进程退出
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const onExternalAbort = (): void => {
    controller.abort();
  };

  /** 把外部中断信号接到当前 controller 上 */
  const attachExternalSignal = (): void => {
    if (!options.signal) return;
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  };

  attachExternalSignal();

  // 计时从「请求发出」开始，而不是从「收到响应头」开始：
  // 网关完全不返回响应头（连接静默）是最常见的卡死形态，必须被覆盖。
  arm(firstByteTimeoutMs, 'first-byte');

  return {
    // 每次 restart() 都会换一个新的 controller，因此这里必须用 getter 取当前值
    get signal(): AbortSignal {
      return controller.signal;
    },
    restart(): void {
      if (disposed) return;
      // AbortController 是一次性的、abort 后无法复位，必须换一个新的：
      // 否则上一次超时触发的 abort 会让重试请求立刻以 AbortError 失败。
      options.signal?.removeEventListener?.('abort', onExternalAbort);
      controller = new AbortController();
      attachExternalSignal();
      // 清空上一次的超时记录，重新从首字节超时开始计时
      timeoutError = null;
      arm(firstByteTimeoutMs, 'first-byte');
    },
    stop(): void {
      if (disposed) return;
      clearTimer();
    },
    noteProgress(): void {
      if (disposed) return;
      arm(idleTimeoutMs, 'idle');
    },
    timeoutError(): LLMStreamTimeoutError | null {
      return timeoutError;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      options.signal?.removeEventListener?.('abort', onExternalAbort);
    },
  };
}

/**
 * 判断一个已解析的 SSE 事件是否代表「有效进展」（用于重置空闲计时器）。
 *
 * @param event   parseSSELines 解析出来的 JSON 对象
 * @param prefix  type 字段前缀（Responses API 用 `response.`；Anthropic 用 `''`）
 * @param exclude 不算进展的 type（默认排除心跳 `ping`）
 */
export function isProgressEvent(
  event: unknown,
  prefix: string,
  exclude: readonly string[] = ['ping'],
): boolean {
  if (!event || typeof event !== 'object') return false;
  const type = (event as { type?: unknown }).type;
  if (typeof type !== 'string' || type.length === 0) return false;
  if (exclude.includes(type)) return false;
  return type.startsWith(prefix);
}

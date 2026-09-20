/**
 * LLM 适配器共享工具
 *
 * 收敛 RealApi.ts / ResponsesApi.ts / OpenAiApi.ts 三份逐字重复的小工具：
 * - checkAborted：AbortSignal 中断检查
 * - recordLLMUsage：用量上报 no-op stub（RedisStats 模块已移除）
 * - logRawOutput：[LLM_RAW_OUTPUT] 原始输出日志块
 * - joinV1Path：baseURL 与 /v1 端点的拼接规则
 * - extractUsageFields：usage 对象到内部 usage 格式的参数化提取
 * - 重试骨架中的逐字相同碎片：RETRY_DELAY_MS / MAX_RETRIES / isRetryableStatus /
 *   isNetworkFetchError / sleep
 * - 错误序列化：serializeError（结构化，供失败转储）/ formatErrorChain（单行，供日志）
 */

import { logger } from '../Logger.js';
import { describeToolInput } from '../utils/toolInput.js';

/** 重试延迟（ms）与最大重试次数（三个适配器的重试配置逐字相同） */
export const RETRY_DELAY_MS = 1000;
export const MAX_RETRIES = 3;

/**
 * 检查中断
 */
export function checkAborted(signal: AbortSignal | null): void {
  if (signal && signal.aborted) {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

// RedisStats module removed; local no-op stub
export async function recordLLMUsage(_inputTokens: number, _outputTokens: number): Promise<void> {}

/**
 * 判断状态码是否可重试（502/503 等服务端瞬时错误）
 */
export function isRetryableStatus(status: number): boolean {
  return status === 502 || status === 503;
}

/**
 * 判断是否为可重试的网络层错误（fetch failed / ECONNRESET 等）
 */
export function isNetworkFetchError(error: unknown): boolean {
  return error instanceof TypeError &&
    ((error as TypeError).message === 'fetch failed' || (error as any)?.cause !== undefined);
}

/**
 * 错误 cause 链的最大序列化深度。
 *
 * undici 的 `fetch failed` 只是一个外壳，真正的根因（ECONNRESET / ENOTFOUND /
 * UND_ERR_CONNECT_TIMEOUT 等）藏在 `error.cause` 里，有时还有第二层
 * （如 `fetch failed` → `SocketError` → `Error: read ECONNRESET`）。
 * 限深是为了避免极端情况下的循环引用把转储文件撑爆。
 */
export const MAX_ERROR_CAUSE_DEPTH = 4;

/** 序列化后的错误信息（写入失败转储，比默认 JSON.stringify(Error) 多出 cause 链与系统错误码） */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Node 系统错误码：ECONNRESET / ENOTFOUND / ETIMEDOUT / UND_ERR_* ... */
  code?: string;
  errno?: string | number;
  /** 出错时的系统调用：connect / read / getaddrinfo ... */
  syscall?: string;
  /** 嵌套原因（递归序列化） */
  cause?: SerializedError | string;
  /** AggregateError 的子错误（如 undici 多地址连接全部失败） */
  errors?: Array<SerializedError | string>;
}

/**
 * 把任意抛出物序列化为可写入 JSON 的结构，保留 cause 链与系统错误码。
 *
 * 背景：`JSON.stringify(new Error('fetch failed'))` 会得到 `{}`，而只取
 * name/message/stack 又会丢掉 undici 挂在 `cause` 上的真实网络错误，
 * 导致失败转储里只剩一句「fetch failed」，无法区分 DNS 失败 / 连接被拒 /
 * TLS 失败 / 读超时。
 */
export function serializeError(error: unknown, depth = 0): SerializedError {
  if (!(error instanceof Error)) {
    return { name: 'NonError', message: String(error) };
  }

  const out: SerializedError = { name: error.name, message: error.message };
  if (error.stack) out.stack = error.stack;

  const e = error as Error & { code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
  if (e.code !== undefined) out.code = String(e.code);
  if (e.errno !== undefined) out.errno = typeof e.errno === 'number' ? e.errno : String(e.errno);
  if (e.syscall !== undefined) out.syscall = String(e.syscall);

  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    if (e.cause !== undefined && e.cause !== null) out.cause = '<max depth reached>';
    if (Array.isArray(e.errors) && e.errors.length > 0) out.errors = ['<max depth reached>'];
    return out;
  }
  if (e.cause !== undefined && e.cause !== null) {
    out.cause = serializeError(e.cause, depth + 1);
  }
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    out.errors = e.errors.map((sub) => serializeError(sub, depth + 1));
  }
  return out;
}

/**
 * 把错误（含 cause 链）压成单行字符串，用于日志。
 *
 * 例：`TypeError: fetch failed <- Error: connect ECONNRESET 127.0.0.1:443 (code=ECONNRESET, errno=-4077, syscall=connect)`
 */
export function formatErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;

  while (current !== undefined && current !== null) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      return parts.join(' <- ');
    }
    const e = current as Error & { code?: unknown; errno?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
    const extra: string[] = [];
    if (e.code !== undefined) extra.push(`code=${String(e.code)}`);
    if (e.errno !== undefined) extra.push(`errno=${String(e.errno)}`);
    if (e.syscall !== undefined) extra.push(`syscall=${String(e.syscall)}`);
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      const sub = e.errors.map((it) => (it instanceof Error ? `${it.name}: ${it.message}` : String(it)));
      extra.push(`errors=[${sub.join('; ')}]`);
    }
    parts.push(`${e.name}: ${e.message}${extra.length > 0 ? ` (${extra.join(', ')})` : ''}`);

    current = e.cause;
    depth++;
    if (depth >= MAX_ERROR_CAUSE_DEPTH && current !== undefined && current !== null) {
      parts.push('<max depth reached>');
      break;
    }
  }

  return parts.length > 0 ? parts.join(' <- ') : String(error);
}

/** 重试等待 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 构建 baseURL 与 /v1 端点的请求 URL。
 * 统一规则（与 buildResponsesUrl / buildChatCompletionsUrl 原实现逐字一致）：
 *   - baseURL 已以 /v1 结尾（如 https://api.deepseek.com/v1）→ `${baseURL}/${endpoint}`
 *   - 否则（如 https://api.deepseek.com、https://opencode.ai/zen/go）→ `${baseURL}/v1/${endpoint}`
 */
export function joinV1Path(baseURL: string, endpoint: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/${endpoint}`;
  }
  return `${trimmed}/v1/${endpoint}`;
}

/** 内部统一的 usage 格式 */
export interface InternalUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** 思考（reasoning）部分的 token 数（部分服务商返回） */
  reasoning_tokens?: number;
}

/**
 * 参数化提取服务商 usage 对象到内部 usage 格式。
 *
 * Responses API 与 Chat Completions 的 usage 结构逐字相同，仅字段名不同：
 * - Responses:  input_tokens / output_tokens
 *               input_tokens_details.cached_tokens / output_tokens_details.reasoning_tokens
 * - Chat:       prompt_tokens / completion_tokens
 *               prompt_tokens_details.cached_tokens / completion_tokens_details.reasoning_tokens
 *
 * 语义注意（与原实现一致）：
 * - OpenAI 语义下 input_tokens/prompt_tokens 已包含缓存命中部分（cached_tokens 是子集），
 *   不额外加回，否则双重计数导致 cache 命中率被低估；
 * - cache_creation_input_tokens 固定为 0（仅 Anthropic 协议有此概念）。
 */
export function extractUsageFields(
  u: Record<string, unknown> | undefined,
  fields: {
    inputTokens: string;
    outputTokens: string;
    inputDetails?: string;
    outputDetails?: string;
  },
): InternalUsage | undefined {
  if (!u) return undefined;
  const inputTokens = (u[fields.inputTokens] as number) || 0;
  const outputTokens = (u[fields.outputTokens] as number) || 0;
  const inputDetails = (fields.inputDetails ? (u as any)[fields.inputDetails] : {}) || {};
  const outputDetails = (fields.outputDetails ? (u as any)[fields.outputDetails] : {}) || {};
  const cacheRead = inputDetails.cached_tokens || 0;
  const reasoningTokens = outputDetails.reasoning_tokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    ...(typeof reasoningTokens === 'number' ? { reasoning_tokens: reasoningTokens } : {}),
  };
}

/**
 * 记录 LLM 原始输出的所有 content blocks（[LLM_RAW_OUTPUT] 日志块）。
 * 三个适配器在该处仅 component 名不同，其余逐字相同。
 */
export function logRawOutput(component: string, finalMsg: unknown): void {
  const msg = finalMsg as { message?: { content?: unknown[] } };
  if (msg?.message && Array.isArray(msg.message.content)) {
    const blocks = msg.message.content;
    logger.info(component, `[LLM_RAW_OUTPUT] total_blocks=${blocks.length}`);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as any;
      if (block.type === 'text') {
        const text = String(block.text || '');
        logger.info(component,
          `[LLM_RAW_OUTPUT] block[${i}] type=text, ` +
          `text_len=${text.length}, text_preview=${text.substring(0, 500)}`);
      } else if (block.type === 'tool_use') {
        logger.info(component,
          `[LLM_RAW_OUTPUT] block[${i}] type=tool_use, ` +
          `id=${block.id}, name=${block.name}, ` +
          describeToolInput(block.input));
      } else {
        logger.info(component, `[LLM_RAW_OUTPUT] block[${i}] type=${block.type}`);
      }
    }
  }
}

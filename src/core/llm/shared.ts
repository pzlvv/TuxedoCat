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

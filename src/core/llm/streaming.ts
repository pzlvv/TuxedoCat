/**
 * LLM 流式请求的公共骨架
 *
 * 三个适配器（RealApi / OpenAiApi / ResponsesApi）的「发送请求 → 传输层重试
 * （看门狗超时 / 网络错误 / 502·503 / 适配器级）→ 失败转储」流程逐字相同，收敛在
 * `fetchStreamingResponse`；请求体构建与 SSE 解析是协议差异所在，留在各适配器。
 * 传输层可重试失败以 `TransportRetry` 信号抛出（重试等待与中断检查已在骨架内完成），
 * 调用方捕获后发起下一次完整尝试；流解析中的中途重试（流被截断 / 退化重复）仍由
 * 各适配器自行判定后走同一条 runAttempt 递归。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { logger } from '../Logger.js';
import { resolveConfigDir } from '../../config/configDir.js';
import { getLLMDispatcher } from './httpDispatcher.js';
import type { StreamWatchdog } from './streamTimeout.js';
import { DEFAULT_MAX_TIMEOUT_RETRIES } from './streamTimeout.js';
import {
  checkAborted,
  isRetryableStatus,
  isNetworkFetchError,
  formatErrorChain,
  serializeError,
  RETRY_DELAY_MS,
  MAX_RETRIES,
  sleep,
} from './shared.js';
import { stringifyJsonSafe } from '../utils/stringUtils.js';

/** 采样参数（三个适配器一致；此前在各自文件里硬编码三份） */
export const SAMPLING_TEMPERATURE = 1.0;
export const SAMPLING_TOP_P = 0.95;

/**
 * 计算本次请求的输出上限：配置级上限（`llm.maxTokens`）与调用方按上下文剩余空间
 * 收窄的上限（`LLMConfig.outputTokenCap`）都要满足。三个适配器的规则逐字相同。
 */
export function computeMaxOutputTokens(config: {
  maxTokens: number;
  outputTokenCap?: number;
}, effectiveMaxTokens: number): number {
  const configuredMaxTokens = config.maxTokens > 0
    ? Math.min(config.maxTokens, effectiveMaxTokens)
    : effectiveMaxTokens;
  return config.outputTokenCap && config.outputTokenCap > 0
    ? Math.min(config.outputTokenCap, configuredMaxTokens)
    : configuredMaxTokens;
}

/**
 * 每次 LLM 调用分配唯一 ID，所有流事件共用，确保 WebView 端能精确配对不同次响应，
 * 不依赖响应里的消息 id 字段（部分模型不返回）。三个适配器规则逐字相同。
 */
export function newStreamMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/** 一次请求尝试的计划（每次尝试重建：构建闭包可能已按上一次失败调整状态） */
export interface StreamingRequestPlan {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 失败转储用的请求头；缺省复用 headers */
  dumpHeaders?: Record<string, string>;
  /**
   * 非 2xx 且非可重试状态码的适配器级重试判定（如 OpenAI 兼容网关不认识
   * stream_options 时的 400）。返回 true 表示重试（钩子内部自行调整构建状态）。
   */
  retryOnBadResponse?: (status: number, errorText: string) => boolean;
}

/** fetchStreamingResponse 的固定依赖（单次 LLM 调用内不变） */
export interface StreamingFetchDeps {
  /** 日志组件名（RealAPI / OpenAiAPI / ResponsesAPI） */
  component: string;
  signal: AbortSignal | null;
  watchdog: StreamWatchdog;
  /** dumpFailedRequest 所需的配置 */
  config: { apiKey: string; baseURL: string; model: string; thinking_effort?: string };
  /** 超时重试计数（单次 LLM 调用内共享，跨重试不重置；箱装便于骨架与解析层共用） */
  timeoutRetryState: { count: number };
}

/** 传输层可重试失败：骨架已完成重试等待与中断检查，调用方捕获后发起下一次尝试 */
export class TransportRetry extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportRetry';
  }
}

/**
 * 发送一次流式请求并处理全部传输层重试。
 *
 * 成功时返回响应对象；可重试失败在完成「等待 + 中断检查」后抛 `TransportRetry`，
 * 不可重试失败原样抛出（非 2xx 已先做失败转储）。日志句式与重试上限
 * （RETRY_DELAY_MS / MAX_RETRIES / DEFAULT_MAX_TIMEOUT_RETRIES）与三个适配器的
 * 原实现逐字一致。
 */
export async function fetchStreamingResponse(
  deps: StreamingFetchDeps,
  plan: StreamingRequestPlan,
  retryCount: number,
): Promise<UndiciResponse> {
  const { component, signal, watchdog } = deps;

  // 每次尝试都重新武装看门狗（重试时首字节计时重新开始）
  watchdog.restart();

  // 发送请求。网络层错误（如 TypeError: fetch failed）通常是服务器/网络瞬时问题，重试数次
  let response: UndiciResponse;
  try {
    response = await undiciFetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      // 用看门狗的 signal：外部中断与超时都会中止本次请求
      signal: watchdog.signal,
      body: stringifyJsonSafe(plan.body),
      dispatcher: getLLMDispatcher(),
    });
  } catch (fetchError) {
    // 看门狗超时（网关静默不响应）：单独处理，不按 TypeError 判定
    const timeoutError = watchdog.timeoutError();
    if (timeoutError) {
      if (deps.timeoutRetryState.count < DEFAULT_MAX_TIMEOUT_RETRIES) {
        deps.timeoutRetryState.count++;
        logger.warn(component,
          `${timeoutError.message}，丢弃本次请求并重试 (${deps.timeoutRetryState.count}/${DEFAULT_MAX_TIMEOUT_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
        // 先查中断再等重试间隔：abort 不能在重试等待上再叠加整段延迟
        checkAborted(signal);
        await sleep(RETRY_DELAY_MS);
        throw new TransportRetry(timeoutError.message);
      }
      throw timeoutError;
    }
    // 对网络层错误（fetch failed / ECONNRESET 等）重试数次
    if (retryCount < MAX_RETRIES && isNetworkFetchError(fetchError)) {
      logger.warn(component, `Network error while fetching (${formatErrorChain(fetchError)}), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
      // 先查中断再等重试间隔：abort 不能在重试等待上再叠加整段延迟
      checkAborted(signal);
      await sleep(RETRY_DELAY_MS);
      throw new TransportRetry(`network error: ${formatErrorChain(fetchError)}`);
    }
    throw fetchError;
  }

  // 502/503 重试逻辑：遇到服务端瞬时错误（502/503），等待 1s 后重试
  if (isRetryableStatus(response.status) && retryCount < MAX_RETRIES) {
    logger.warn(component, `API request got ${response.status}, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
    // 释放未消费的响应体，避免连接被占用
    response.body?.cancel().catch(() => { });
    // 先查中断再等重试间隔：abort 不能在重试等待上再叠加整段延迟
    checkAborted(signal);
    await sleep(RETRY_DELAY_MS);
    throw new TransportRetry(`HTTP ${response.status}`);
  }

  if (!response.ok) {
    let errorText: string;
    try {
      errorText = await response.text();
    } catch (error) {
      // 读取错误响应体失败（如 abort）时也释放 body，避免连接泄漏
      response.body?.cancel().catch(() => { });
      throw error;
    }
    logger.error(component, `API request failed: ${response.status} ${errorText}`);

    // 适配器级重试（如 stream_options 被网关拒绝时的 400）
    if (plan.retryOnBadResponse?.(response.status, errorText) && retryCount < MAX_RETRIES) {
      // 先查中断再等重试间隔：abort 不能在重试等待上再叠加整段延迟
      checkAborted(signal);
      await sleep(RETRY_DELAY_MS);
      throw new TransportRetry(`HTTP ${response.status} (adapter retry)`);
    }

    await dumpFailedRequest({
      url: plan.url,
      method: 'POST',
      requestHeaders: plan.dumpHeaders ?? plan.headers,
      requestBody: plan.body,
      config: deps.config,
      error: new Error(`HTTP ${response.status}: ${response.statusText}`),
      responseStatus: response.status,
      responseBody: errorText,
    });

    throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  return response;
}

/**
 * 在 ~/<CONFIG_DIR_NAME>/ 下创建 LLM 请求失败转储文件。
 * 记录完整的请求参数（apiKey 与常见凭证头脱敏），便于排查问题。
 * 此前定义在 RealApi.ts、被三个适配器共用，随流式骨架一并收敛。
 */
export async function dumpFailedRequest(params: {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: Record<string, unknown>;
  config: {
    apiKey: string;
    baseURL: string;
    model: string;
    thinking_effort?: string;
  };
  error: unknown;
  responseStatus?: number;
  responseBody?: string;
}): Promise<string | null> {
  try {
    const dumpDir = path.join(resolveConfigDir(), 'fail_logs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFile = path.join(dumpDir, `llm_fail_${timestamp}.json`);

    // 确保目录存在
    await fs.mkdir(dumpDir, { recursive: true });

    // 构建转储内容（脱敏处理 apiKey 与所有常见凭证头）
    const redactHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(headers || {})) {
        const lower = key.toLowerCase();
        if (lower === 'authorization') {
          out[key] = 'Bearer <REDACTED>';
        } else if (lower === 'x-api-key' || lower === 'api-key' || lower === 'x-goog-api-key' || lower === 'cookie' || lower === 'proxy-authorization') {
          out[key] = '<REDACTED>';
        } else {
          out[key] = value;
        }
      }
      return out;
    };
    const dump = {
      timestamp: new Date().toISOString(),
      url: params.url,
      method: params.method,
      responseStatus: params.responseStatus,
      config: {
        ...params.config,
        apiKey: params.config.apiKey ? `${params.config.apiKey.slice(0, 8)}...` : '',
      },
      requestHeaders: redactHeaders(params.requestHeaders),
      requestBody: params.requestBody,
      // 保留完整 cause 链与系统错误码：undici 的 `fetch failed` 只是外壳，
      // 根因（ECONNRESET / ENOTFOUND / UND_ERR_CONNECT_TIMEOUT ...）在 cause 上。
      error: serializeError(params.error),
      responseBody: params.responseBody,
    };

    await fs.writeFile(dumpFile, JSON.stringify(dump, null, 2), 'utf-8');
    logger.info('RealAPI', `Failed request dumped to: ${dumpFile}`);
    return dumpFile;
  } catch (dumpError) {
    logger.warn('RealAPI', `Failed to dump request: ${dumpError}`);
    return null;
  }
}

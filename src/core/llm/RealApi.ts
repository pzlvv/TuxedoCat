/**
 * 真实的 LLM API 调用（兼容格式）
 * 支持流式（SSE）模式
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '../types.js';
import { logger } from '../Logger.js';
import { getConfig, getEnableUsageStats } from './config.js';
import type { LLMConfig } from './config.js';
import { CONFIG_DIR_NAME } from '../../config/project.js';
import { getMaxOutputTokens, getContextWindow, getModelConfig } from '../utils/modelConfig.js';
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { getLLMDispatcher } from './httpDispatcher.js';

// RedisStats module removed; local no-op stub
async function recordLLMUsage(_inputTokens: number, _outputTokens: number): Promise<void> {}

export interface StreamOptions {
  messages: Array<{ role: string; content: string | unknown[] }>;
  systemPrompt?: string;
  tools: unknown[];
  signal: AbortSignal | null;
  onProgress?: (message: Message) => void;
  /** 覆盖 LLM 默认的 thinking 模式，不指定则无 thinking */
  thinkingEffort?: 'off' | 'low' | 'high' | 'max';
  /** 覆盖配置文件中的 thinking 预算 token 数，通常来自 ModelConfig */
  thinkingTokenBudget?: number;
  /** LLM 配置覆盖，不指定则使用 settings.json 中的配置 */
  modelConfig?: LLMConfig;
  /** 会话 ID，附加到请求头 x-session-id */
  sessionId: string;
}

/**
 * 流式事件类型 — 细粒度的 SSE 解析事件
 */
export type StreamEvent =
  | { type: 'block_start'; block: { type: 'thinking' | 'text' | 'tool_use' | 'web_search';[key: string]: unknown }; messageId?: string }
  | { type: 'thinking_delta'; thinking: string; messageId?: string }
  | { type: 'text_delta'; text: string; messageId?: string }
  | { type: 'block_stop'; messageId?: string }
  | { type: 'message_delta'; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; stop_reason?: string; messageId?: string; serverSessionRotated?: boolean }
  | { type: 'web_search_call'; callId: string; action?: string; queries?: string[]; url?: string; messageId?: string }
  | { type: 'web_search_call_update'; callId: string; action?: string; queries?: string[]; url?: string; messageId?: string }
  | { type: 'web_search_call_done'; callId: string; messageId?: string };

/**
 * 检查中断
 */
function checkAborted(signal: AbortSignal | null): void {
  if (signal && signal.aborted) {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
}

/**
 * 在 ~/<CONFIG_DIR_NAME>/ 下创建 LLM 请求失败转储文件
 * 记录完整的请求参数，便于排查问题
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
    maxTokens: number;
    timeout?: number;
    thinking_effort?: string;
    thinking_budget_tokens?: number;
  };
  error: unknown;
  responseStatus?: number;
  responseBody?: string;
}): Promise<string | null> {
  try {
    const homeDir = os.homedir();
    const dumpDir = path.join(homeDir, CONFIG_DIR_NAME, 'fail_logs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpFile = path.join(dumpDir, `llm_fail_${timestamp}.json`);

    // 确保目录存在
    await fs.mkdir(dumpDir, { recursive: true });

    // 构建转储内容（脱敏处理 apiKey）
    const dump = {
      timestamp: new Date().toISOString(),
      url: params.url,
      method: params.method,
      responseStatus: params.responseStatus,
      config: {
        ...params.config,
        apiKey: params.config.apiKey ? `${params.config.apiKey.slice(0, 8)}...` : '',
      },
      requestHeaders: {
        ...params.requestHeaders,
        Authorization: 'Bearer <REDACTED>',
      },
      requestBody: params.requestBody,
      error: params.error instanceof Error
        ? { name: params.error.name, message: params.error.message, stack: params.error.stack }
        : String(params.error),
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

/**
 * 解析 SSE 中的 data: 行，提取 JSON 对象
 * 兼容格式：data: {"type":"...","delta":{...}}
 * 忽略 event: 行和注释行
 */
/**
 * 解析 SSE data: 行。返回已成功解析的事件列表和未解析的 buffer 残留。
 * 按 \n 拆分后逐行解析，如果某行 data: 的 JSON 解析失败，说明该行可能被
 * TCP 分包截断（常见于 input_json_delta 的 partial_json 字段），此时将该行
 * 及之后所有内容作为 remaining 返回，由调用方保留到 buffer 中等待下次追加数据。
 * 成功解析的行不会延迟输出，保证 text_delta 等实时事件即时回显。
 */
export function parseSSELines(
  chunk: string,
): { parsed: Record<string, unknown>[]; remaining: string } {
  const lines = chunk.split('\n');
  const parsed: Record<string, unknown>[] = [];
  let remaining = '';
  for (const [lineIdx, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      const dataStr = trimmed.slice(5).trim();
      if (dataStr === '[DONE]') continue;
      if (!dataStr) continue;
      try {
        const parsedObj = JSON.parse(dataStr) as Record<string, unknown>;
        parsed.push(parsedObj);
      } catch {
        // 解析失败，说明这行数据不完整（可能被 TCP 分包截断）
        // 将该行及之后所有行作为 remaining 返回，等待下次追加数据后重试。
        // 这是流式传输中的正常现象（数据跨包截断），无需记录日志。
        remaining = lines.slice(lineIdx).join('\n');
        break;
      }
    }
    // event: 行和空行都忽略
  }
  return { parsed, remaining };
}

/**
 * 将流式 events 构建为完整的 assistant message，用于持久化
 */
export function buildAssistantMessageFromBlocks(
  blocks: Array<{ type: string;[key: string]: unknown }>,
  stopReason?: string,
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): Message {
  const now = Date.now();
  // 在每个 tool_use block 顶层记录 AI 发出工具调用的时间戳（不再放在 input._meta 中）
  // 注意：要创建副本再修改，避免影响原始 contentBlocks
  const contentBlocks = blocks.map((block) => {
    if (block.type === 'tool_use') {
      const newBlock = {
        ...block,
        _meta: { ...((block._meta as Record<string, unknown>) || {}), toolCallTimestamp: now },
      };
      return newBlock;
    }
    return block;
  });
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: contentBlocks as unknown as Array<{ type: 'text' | 'tool_use';[key: string]: unknown }>,
      stop_reason: stopReason,
      usage: usage ? {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
      } : undefined,
    },
    uuid: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    timestamp: now,
  };
}

/**
 * 调用 LLM API（流式模式）- 统一入口
 *
 * 根据 settings.json 中的 llm.apiType 字段分发：
 * - 'Anthropic'（默认）: Anthropic 兼容协议（POST {baseURL}/v1/messages）
 * - 'Responses': OpenAI Responses API（POST {baseURL}/responses）
 *
 * 返回两种类型的事件：
 * 1. StreamEvent - 细粒度的流式事件（用于 UI 逐 token 更新）
 * 2. Message - 完整的 assistant 消息（用于持久化）
 *
 * 使用方通过 message_delta 事件判断流结束，
 * 随后会 yield 最终的完整 Message 用于持久化。
 */
export async function* callRealLLM(options: StreamOptions): AsyncGenerator<StreamEvent | Message> {
  // 支持部分 modelConfig 覆盖（如引擎只有 webSearch 覆盖值时）：
  // 与 settings.json 的全量配置合并，避免缺失 apiKey/baseURL/model 等字段
  const baseConfig = await getConfig(options.sessionId);
  const config = options.modelConfig ? { ...baseConfig, ...options.modelConfig } : baseConfig;

  if (config.apiType === 'Responses') {
    logger.info('RealAPI', 'Using OpenAI Responses API adapter');
    const { callResponsesLLM } = await import('./ResponsesApi.js');
    yield* callResponsesLLM({ ...options, modelConfig: config });
    return;
  }

  logger.info('RealAPI', 'Using Anthropic-compatible API adapter');
  yield* callAnthropicLLM({ ...options, modelConfig: config });
}

/**
 * 调用 Anthropic 兼容协议的 LLM API（流式模式）
 *
 * 返回两种类型的事件：
 * 1. StreamEvent - 细粒度的流式事件（用于 UI 逐 token 更新）
 * 2. Message - 完整的 assistant 消息（用于持久化）
 *
 * 使用方通过 message_delta 事件判断流结束，
 * 随后会 yield 最终的完整 Message 用于持久化。
 */
async function* callAnthropicLLM(options: StreamOptions): AsyncGenerator<StreamEvent | Message> {
  const { messages, systemPrompt, tools, signal, thinkingEffort, thinkingTokenBudget, modelConfig: optionsModelConfig, sessionId } = options;

  // 从配置读取：优先使用传入的 modelConfig，否则读取 settings.json
  const config = optionsModelConfig ?? await getConfig(sessionId);
  const { apiKey, baseURL, model, maxTokens, thinking_budget_tokens } = config;
  const enableUsageStats = await getEnableUsageStats();

  // 使用传入的 thinkingEffort，不从配置文件读取该值
  const effectiveThinkingEffort = thinkingEffort;

  // 检查中断
  checkAborted(signal);

  // 在 try 外声明，catch 中可能需要引用
  let requestBody: Record<string, unknown> | undefined;
  // 累积 token 用量（流式模式下从 SSE 中逐步获取）
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0 as number;

  try {
    // 重试配置：最多重试 MAX_RETRIES 次，对 502/503 状态码、网络错误和 TypeError: terminated 生效
    const RETRY_DELAY_MS = 1000;
    const MAX_RETRIES = 3;

    // 判断状态码是否可重试（502/503 等服务端瞬时错误）
    const isRetryableStatus = (status: number): boolean =>
      status === 502 || status === 503;

    // 将核心请求+流读取逻辑提取为内部函数，支持重试
    const executeRequest = async function* (
      retryCount: number,
    ): AsyncGenerator<StreamEvent | Message> {
      // 计算 max_tokens：环境变量 > 模型配置 > 全局默认值
      const effectiveMaxTokens = getMaxOutputTokens(model);
      const maxTokensValue = maxTokens > 0 ? Math.min(maxTokens, effectiveMaxTokens) : effectiveMaxTokens;

      // 构建请求体
      requestBody = {
        model,
        max_tokens: maxTokensValue,
        messages,
        stream: true,
        temperature: 1.0,
        top_p: 0.95,
      };

      // 确定 thinking_token_budget（提前计算，日志中需要使用）
      const effectiveThinkingTokenBudget = thinkingTokenBudget ?? getModelConfig(model).thinking_token_budget;

      // 添加 reasoning 配置（chat_template_kwargs 格式）
      if (effectiveThinkingEffort && effectiveThinkingEffort !== 'off') {
        requestBody.chat_template_kwargs = {
          reasoning_effort: effectiveThinkingEffort,
          thinking: true,
        };

        // 仅在 thinking 开启时设置 thinking_token_budget
        if (effectiveThinkingTokenBudget > 0) {
          requestBody.thinking_token_budget = effectiveThinkingTokenBudget;
        }
      } else {
        // 显式关闭 thinking，防止 thinking_token_budget 残留导致 API 误开启
        requestBody.thinking = { type: 'disabled' };
      }

      // 添加 system prompt
      if (systemPrompt) {
        requestBody.system = systemPrompt;
      }

      // 如果有工具，添加到请求中
      if (tools && tools.length > 0) {
        requestBody.tools = tools;
      }

      // 关键日志：记录完整的LLM请求
      if (retryCount === 0) {
        logger.info('RealAPI', '=== LLM Request (stream) ===');
        logger.info('RealAPI', `Model: ${model}`);
        logger.info('RealAPI', `Max tokens: ${maxTokensValue} (config: ${maxTokens}, default: ${effectiveMaxTokens})`);
        logger.info('RealAPI', `Context window: ${getContextWindow(model)} tokens`);
        logger.info('RealAPI', `Context usage: ${messages.length} messages (${Buffer.byteLength(JSON.stringify(messages), 'utf8')} bytes), system prompt: ${systemPrompt?.length || 0} chars`);
        logger.info('RealAPI', `Thinking effort: ${effectiveThinkingEffort || 'off'} (budget: ${thinking_budget_tokens || 'default'}, modelConfig budget: ${effectiveThinkingTokenBudget})`);
        logger.info('RealAPI', `Sampling: temperature=1.0, top_p=0.95`);
        const messagesBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
        logger.info('RealAPI', `Messages: ${messages.length} items, ${messagesBytes} bytes`);
        logger.debug('RealAPI', `Tools (${tools.length}): ${tools.map((t: any) => t.name).join(', ')}`);
      } else {
        logger.info('RealAPI', `=== LLM Request Retry (${retryCount}/${MAX_RETRIES}) ===`);
      }

      // 发送请求
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        // 同时携带两种认证方式以兼容不同网关：
        // - x-api-key: 标准 Anthropic 协议（opencode.ai 等 Anthropic 兼容端点只认这个，否则 401）
        // - Authorization: Bearer: 部分 OpenAI 兼容网关（如 DeepSeek /anthropic）接受
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      };

      // 附加会话 ID 到请求头，供 LLM 服务端追踪会话上下文
      requestHeaders['x-session-id'] = sessionId;

      logger.debug('RealAPI', `Request headers: ${JSON.stringify(requestHeaders)}`);
      logger.debug('RealAPI', `Request URL: ${baseURL}/v1/messages`);

      // 发送请求。网络层错误（如 TypeError: fetch failed）通常是服务器/网络瞬时问题，重试数次
      let response: UndiciResponse;
      try {
        response = await undiciFetch(`${baseURL}/v1/messages`, {
          method: 'POST',
          headers: requestHeaders,
          signal: signal || undefined,
          body: JSON.stringify(requestBody),
          dispatcher: getLLMDispatcher(),
        });
      } catch (fetchError) {
        // 对网络层错误（fetch failed / ECONNRESET 等）重试数次
        const isNetworkError = fetchError instanceof TypeError &&
          (fetchError.message === 'fetch failed' || (fetchError as any)?.cause !== undefined);
        if (retryCount < MAX_RETRIES && isNetworkError) {
          logger.warn('RealAPI', `Network error while fetching (${fetchError.message}), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }
        throw fetchError;
      }

      // 502/503 重试逻辑：遇到服务端瞬时错误（502/503），等待 1s 后重试
      if (isRetryableStatus(response.status) && retryCount < MAX_RETRIES) {
        logger.warn('RealAPI', `API request got ${response.status}, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
        // 释放未消费的响应体，避免连接被占用
        response.body?.cancel().catch(() => { });
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        checkAborted(signal);
        yield* executeRequest(retryCount + 1);
        return;
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
        logger.error('RealAPI', `API request failed: ${response.status} ${errorText}`);

        await dumpFailedRequest({
          url: `${baseURL}/v1/messages`,
          method: 'POST',
          requestHeaders: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': '2023-06-01',
          },
          requestBody,
          config,
          error: new Error(`HTTP ${response.status}: ${response.statusText}`),
          responseStatus: response.status,
          responseBody: errorText,
        });

        throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`);
      }

      // ========== 流式读取 SSE 响应 ==========
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const contentBlocks: any[] = [];
      // 累积 thinking 和 text 的完整内容，用于构建最后的 Message
      let currentBlockType: string | null = null;
      let currentBlockAccumulator: Record<string, string> = {};
      let stopReason: string | undefined;
      let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
      // 每次 LLM 调用分配唯一 ID，所有流事件共用，确保 WebView 端能精确配对不同次响应
      // 不依赖 message_start 中的 id 字段（部分模型不返回）
      const streamMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // 流式读取期间必须确保 reader 被释放：abort、读取异常或消费者提前退出时，
      // 通过 finally 取消底层流，避免连接/内存泄漏。
      let streamEnded = false;
      const closeReader = (): void => {
        if (streamEnded) return;
        streamEnded = true;
        reader.cancel?.().catch(() => { });
      };
      try {
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (readError) {
          // 对 TypeError: terminated 重试数次
          if (retryCount < MAX_RETRIES && readError instanceof TypeError && readError.message === 'terminated') {
            logger.warn('RealAPI', `Stream terminated (TypeError: terminated), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
            // 释放之前的 reader
            closeReader();
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            checkAborted(signal);
            yield* executeRequest(retryCount + 1);
            return;
          }
          throw readError;
        }

        const { done, value } = readResult;
        if (done) {
          streamEnded = true;
          break;
        }

        // 检查中断
        checkAborted(signal);

        buffer += decoder.decode(value, { stream: true });

        // 解析 buffer。parseSSELines 返回成功解析的事件列表和未解析的 buffer 残留。
        // 解析失败的行（通常是被 TCP 分包截断的 input_json_delta）会作为 remaining 返回，
        // 由 buffer 保留等待下次追加数据后重试。成功解析的事件立即处理，不延迟输出。
        const { parsed: parsedEvents, remaining } = parseSSELines(buffer);
        buffer = remaining;
        for (const parsed of parsedEvents) {
          const eventType = parsed.type as string;

          if (eventType === 'content_block_start') {
            // block 开始
            const block = parsed.content_block as Record<string, unknown>;
            currentBlockType = block.type as string;
            currentBlockAccumulator = {};

            if (currentBlockType === 'thinking') {
              currentBlockAccumulator.thinking = '';
              const thinkingBlock: Record<string, unknown> = { type: 'thinking', thinking: '' };
              // 保留 signature 字段，Anthropic API 要求在 thinking mode 启用时
              // 历史消息中的 thinking block 必须携带 signature 原样传回
              if (block.signature) {
                thinkingBlock.signature = block.signature;
              }
              contentBlocks.push(thinkingBlock);
              yield { type: 'block_start', block: { type: 'thinking', signature: block.signature }, messageId: streamMessageId } as StreamEvent;
            } else if (currentBlockType === 'text') {
              currentBlockAccumulator.text = '';
              contentBlocks.push({ type: 'text', text: '' });
              yield { type: 'block_start', block: { type: 'text' }, messageId: streamMessageId } as StreamEvent;
            } else if (currentBlockType === 'tool_use') {
              const toolBlock: Record<string, unknown> = {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input || {},
              };
              contentBlocks.push(toolBlock);
              currentBlockAccumulator = {};
              // 记录 tool_use block 开始的初始 input 信息
              logger.debug('RealAPI',
                `[CONTENT_BLOCK_START_TOOL_USE] id=${block.id}, name=${block.name}, ` +
                `input=${JSON.stringify(block.input)}, input_type=${typeof block.input}, ` +
                `hasInput=${block.input !== undefined}`);
              yield { type: 'block_start', block: { type: 'tool_use', id: block.id, name: block.name, input: block.input }, messageId: streamMessageId } as StreamEvent;
            }
          } else if (eventType === 'content_block_delta') {
            const delta = parsed.delta as Record<string, unknown>;
            const deltaType = delta.type as string;

            if (deltaType === 'thinking_delta') {
              const thinkingDelta = delta.thinking as string || '';
              currentBlockAccumulator.thinking = (currentBlockAccumulator.thinking || '') + thinkingDelta;
              // 更新 contentBlocks 中最后一条 thinking block 的内容
              const lastBlock = contentBlocks[contentBlocks.length - 1];
              if (lastBlock && lastBlock.type === 'thinking') {
                lastBlock.thinking = currentBlockAccumulator.thinking;
              }
              yield { type: 'thinking_delta', thinking: thinkingDelta, messageId: streamMessageId } as StreamEvent;
            } else if (deltaType === 'text_delta') {
              const textDelta = delta.text as string || '';
              currentBlockAccumulator.text = (currentBlockAccumulator.text || '') + textDelta;
              const lastBlock = contentBlocks[contentBlocks.length - 1];
              if (lastBlock && lastBlock.type === 'text') {
                lastBlock.text = currentBlockAccumulator.text;
              }
              yield { type: 'text_delta', text: textDelta, messageId: streamMessageId } as StreamEvent;
            } else if (deltaType === 'input_json_delta') {
              // tool_use 的 input 增量（部分 JSON），累积到最后一个 tool_use block
              const partialJson = delta.partial_json as string || '';
              const lastBlock = contentBlocks[contentBlocks.length - 1];
              if (lastBlock && lastBlock.type === 'tool_use') {
                // 逐步拼接 input JSON，最后完整解析
                if (!lastBlock._partialJson) {
                  lastBlock._partialJson = '';
                }
                (lastBlock as any)._partialJson += partialJson;
                // 记录 input_json_delta 累积进度（debug 级别，首次和每 2000 字符记录一次）
                const totalLen = ((lastBlock as any)._partialJson as string).length;
                if (totalLen <= partialJson.length || totalLen % 2000 < partialJson.length) {
                  logger.debug('RealAPI',
                    `[INPUT_JSON_DELTA] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                    `delta_len=${partialJson.length}, accumulated_len=${totalLen}, ` +
                    `delta_preview=${partialJson.substring(0, 200)}`);
                }
              } else {
                logger.debug('RealAPI',
                  `[INPUT_JSON_DELTA_NO_BLOCK] deltaType=input_json_delta but no tool_use block found, ` +
                  `partialJson=${partialJson.substring(0, 200)}`);
              }
            }
          } else if (eventType === 'content_block_stop') {
            // block 结束
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            // 如果是 tool_use，解析累积的 partial JSON
            if (lastBlock && lastBlock.type === 'tool_use') {
              if ((lastBlock as any)._partialJson) {
                const rawJson = (lastBlock as any)._partialJson;
                logger.info('RealAPI',
                  `[TOOL_USE_RAW_JSON] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                  `raw_len=${rawJson.length}, raw_preview=${rawJson.substring(0, 500)}`);
                try {
                  (lastBlock as any).input = JSON.parse(rawJson);
                } catch (e) {
                  logger.error('RealAPI',
                    `[TOOL_USE_PARSE_FAILED] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                    `raw_len=${rawJson.length}, error=${e}, ` +
                    `raw=${rawJson.substring(0, 1000)}`);
                  // 解析失败则保留原始 input
                }
                delete (lastBlock as any)._partialJson;
              } else {
                logger.debug('RealAPI',
                  `[TOOL_USE_NO_PARTIAL_JSON] id=${lastBlock.id}, name=${lastBlock.name}`);
              }
            }
            currentBlockType = null;
            currentBlockAccumulator = {};
            yield { type: 'block_stop', messageId: streamMessageId } as StreamEvent;
          } else if (eventType === 'message_delta') {
            const msgDelta = parsed.delta as Record<string, unknown> || {};
            const msgUsage = parsed.usage as Record<string, unknown> || {};
            stopReason = msgDelta.stop_reason as string || stopReason;
            if (msgUsage.input_tokens !== undefined) {
              accumulatedInputTokens = msgUsage.input_tokens as number;
            }
            if (msgUsage.output_tokens !== undefined) {
              accumulatedOutputTokens = msgUsage.output_tokens as number;
            }
            // DeepSeek API 的 input_tokens 可能不包含缓存命中的部分，
            // 需要加上 cache_read_input_tokens 和 cache_creation_input_tokens
            // 才能得到完整的输入 token 数
            const cacheReadTokens = (msgUsage as any).cache_read_input_tokens || 0;
            const cacheCreationTokens = (msgUsage as any).cache_creation_input_tokens || 0;
            const totalInputTokens = accumulatedInputTokens + cacheReadTokens + cacheCreationTokens;
            usage = { input_tokens: totalInputTokens, output_tokens: accumulatedOutputTokens, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: cacheCreationTokens };
            yield {
              type: 'message_delta',
              usage,
              stop_reason: stopReason,
              messageId: streamMessageId,
            } as StreamEvent;
          } else if (eventType === 'message_start') {
            // message_start 中可以拿到初始 usage 和消息 ID
            const msg = parsed.message as Record<string, unknown> || {};
            const msgUsage = msg.usage as Record<string, unknown> | undefined;
            if (msgUsage) {
              accumulatedInputTokens = (msgUsage as any).input_tokens || 0;
              accumulatedOutputTokens = (msgUsage as any).output_tokens || 0;
              // DeepSeek API 的 input_tokens 可能不包含缓存命中的部分，
              // 需要加上 cache_read_input_tokens 和 cache_creation_input_tokens
              const cacheReadTokens = (msgUsage as any).cache_read_input_tokens || 0;
              const cacheCreationTokens = (msgUsage as any).cache_creation_input_tokens || 0;
              accumulatedInputTokens += cacheReadTokens + cacheCreationTokens;
            }
            // 提取消息 ID（部分模型返回，但我们已自生成 streamMessageId）
            // 如果有 id 则覆盖使用模型返回的 id，更可靠
            if (msg.id && typeof msg.id === 'string') {
              // 保留但不再赋值给 const 的 streamMessageId
            }
          } else if (eventType === 'ping') {
            // 心跳，忽略
          }
        }

      }
      } finally {
        closeReader();
      }

      // 流结束，解析 buffer 中剩余的所有数据（无法解析的残余丢弃）
      if (buffer.trim()) {
        const { parsed: finalEvents } = parseSSELines(buffer);
        for (const parsed of finalEvents) {
          const eventType = parsed.type as string;
          if (eventType === 'message_delta') {
            const msgDelta = (parsed.delta as Record<string, unknown>) || {};
            const msgUsage = parsed.usage as Record<string, unknown> || {};
            stopReason = msgDelta.stop_reason as string || stopReason;
            if ((msgUsage as any).input_tokens !== undefined) accumulatedInputTokens = (msgUsage as any).input_tokens;
            if ((msgUsage as any).output_tokens !== undefined) accumulatedOutputTokens = (msgUsage as any).output_tokens;
            const cacheReadTokens = (msgUsage as any).cache_read_input_tokens || 0;
            const cacheCreationTokens = (msgUsage as any).cache_creation_input_tokens || 0;
            const totalInputTokens = accumulatedInputTokens + cacheReadTokens + cacheCreationTokens;
            usage = { input_tokens: totalInputTokens, output_tokens: accumulatedOutputTokens, cache_read_input_tokens: cacheReadTokens, cache_creation_input_tokens: cacheCreationTokens };
          } else if (eventType === 'content_block_stop') {
            // 处理 buffer 中残留的 content_block_stop（同主循环逻辑）
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'tool_use') {
              if ((lastBlock as any)._partialJson) {
                const rawJson = (lastBlock as any)._partialJson;
                logger.info('RealAPI',
                  `[TOOL_USE_RAW_JSON_FINAL] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                  `raw_len=${rawJson.length}, raw_preview=${rawJson.substring(0, 500)}`);
                try {
                  (lastBlock as any).input = JSON.parse(rawJson);
                } catch (e) {
                  logger.error('RealAPI',
                    `[TOOL_USE_PARSE_FAILED_FINAL] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                    `raw_len=${rawJson.length}, error=${e}, ` +
                    `raw=${rawJson.substring(0, 1000)}`);
                }
                delete (lastBlock as any)._partialJson;
              }
            }
            currentBlockType = null;
            currentBlockAccumulator = {};
          } else if (eventType === 'content_block_delta') {
            const delta = parsed.delta as Record<string, unknown>;
            const deltaType = delta.type as string;
            if (deltaType === 'input_json_delta') {
              // 处理 buffer 中残留的 input_json_delta（累积到最后一个 tool_use block）
              const partialJson = delta.partial_json as string || '';
              const lastBlock = contentBlocks[contentBlocks.length - 1];
              if (lastBlock && lastBlock.type === 'tool_use') {
                if (!(lastBlock as any)._partialJson) {
                  (lastBlock as any)._partialJson = '';
                }
                (lastBlock as any)._partialJson += partialJson;
                logger.debug('RealAPI',
                  `[INPUT_JSON_DELTA_FINAL] id=${lastBlock.id}, name=${lastBlock.name}, ` +
                  `delta_len=${partialJson.length}, accumulated_len=${((lastBlock as any)._partialJson as string).length}`);
              }
            }
          }
        }
      }

      // 如果流结束时还没有得到 usage，取累积值
      if (!usage) {
        usage = { input_tokens: accumulatedInputTokens, output_tokens: accumulatedOutputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      }

      // 处理 tool_use 中的 arguments 兼容格式
      for (const block of contentBlocks) {
        if (block.type === 'tool_use') {
          const toolBlock = block as unknown as { name: string; id: string; input: Record<string, unknown> };
          if (toolBlock.input && typeof toolBlock.input.arguments === 'string') {
            logger.debug("RealAPI", `Arguments detected, expand arguments: ${JSON.stringify(toolBlock.input)}`);
            try {
              const parsed = JSON.parse(toolBlock.input.arguments) as Record<string, unknown>;
              toolBlock.input = parsed;
            } catch {
              // 解析失败保留原值
            }
          }
        }
      }

      // 🔴 关键日志：记录流式响应统计
      logger.debug('RealAPI', '=== LLM Stream Response ===');
      logger.debug('RealAPI', `Stop reason: ${stopReason}`);
      logger.debug('RealAPI', `Content blocks: ${contentBlocks.length} (types: ${contentBlocks.map(b => b.type).join(', ')})`);
      if (usage) {
        logger.debug('RealAPI', `Tokens: Input=${usage.input_tokens}, Output=${usage.output_tokens}`);
      }

      // yield 最终的完整 assistant message（用于持久化）
      const finalMsg = buildAssistantMessageFromBlocks(contentBlocks, stopReason, usage);

      // 记录 LLM 原始输出的所有 content blocks
      if ((finalMsg as any).message && Array.isArray((finalMsg as any).message.content)) {
        const blocks = (finalMsg as any).message.content;
        logger.info('RealAPI', `[LLM_RAW_OUTPUT] total_blocks=${blocks.length}`);
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i] as any;
          if (block.type === 'text') {
            const text = String(block.text || '');
            logger.info('RealAPI',
              `[LLM_RAW_OUTPUT] block[${i}] type=text, ` +
              `text_len=${text.length}, text_preview=${text.substring(0, 500)}`);
          } else if (block.type === 'tool_use') {
            const inputStr = typeof block.input === 'object' ? JSON.stringify(block.input) : String(block.input);
            logger.info('RealAPI',
              `[LLM_RAW_OUTPUT] block[${i}] type=tool_use, ` +
              `id=${block.id}, name=${block.name}, ` +
              `input_keys=[${Object.keys(block.input || {}).join(', ')}], ` +
              `input_size=${inputStr.length}, input_preview=${inputStr.substring(0, 500)}`);
          } else {
            logger.info('RealAPI', `[LLM_RAW_OUTPUT] block[${i}] type=${block.type}`);
          }
        }
      }

      yield finalMsg;

      // 记录 token 用量到 Redis（异步，不阻塞主流程）
      if (usage && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
        logger.info('RealAPI', `Stream completed: ${messages.length} messages (${Buffer.byteLength(JSON.stringify(messages), 'utf8')} bytes), input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}, total_tokens=${usage.input_tokens + usage.output_tokens}, stop_reason=${stopReason}`);

        if (enableUsageStats) {
          recordLLMUsage(usage.input_tokens, usage.output_tokens).catch((err: unknown) => {
            logger.warn('RealAPI', `Redis usage recording failed: ${err}`);
          });
        }
      }
    };

    yield* executeRequest(0);

  } catch (error) {
    // 排除 AbortError - 不转储用户主动取消的请求
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }

    logger.error('RealAPI', `API call failed: ${error}`);

    // 网络异常时 requestBody 可能尚未构建完整
    await dumpFailedRequest({
      url: `${baseURL}/v1/messages`,
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'Authorization': `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      requestBody: requestBody ?? { model, max_tokens: maxTokens, messages },
      config,
      error,
    });

    throw error;
  }
}

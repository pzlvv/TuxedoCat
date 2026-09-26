/**
 * OpenAI Chat Completions 适配器（流式 SSE）
 *
 * 将内部统一的 Anthropic 风格消息/工具格式转换为 Chat Completions 格式并调用：
 *   POST {baseURL}/v1/chat/completions
 *
 * 输出事件与 RealApi.ts / ResponsesApi.ts 完全一致（StreamEvent + Message），
 * 因此上层（Query.ts / QueryEngine.ts / WebView）无需任何改动。
 *
 * 支持：
 * - 流式文本（choices[].delta.content）
 * - 思考内容（choices[].delta.reasoning_content / delta.reasoning）
 * - 工具调用（choices[].delta.tool_calls，arguments 分片累积）
 * - 用量统计（stream_options.include_usage / 末帧 usage）
 * - 中止（AbortSignal）、502 / 网络错误重试
 */

import type { Message } from '../types.js';
import { logger } from '../Logger.js';
import { getConfig, getEnableUsageStats } from './config.js';
import { getMaxOutputTokens, getContextWindow } from '../utils/modelConfig.js';
import { parseSSELines, buildAssistantMessageFromBlocks, dumpFailedRequest } from './RealApi.js';
import { getServerSessionId } from './serverSession.js';
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { getLLMDispatcher } from './httpDispatcher.js';
import {
  createStreamWatchdog,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TIMEOUT_RETRIES,
} from './streamTimeout.js';
import {
  RepetitionDetector,
  checkRepetition,
  LLMRepetitionError,
  DEFAULT_MAX_REPETITION_RETRIES,
} from './repetitionDetector.js';
import { unwrapToolInput } from '../utils/toolInput.js';
import { stringifyJsonSafe } from '../utils/stringUtils.js';
import {
  checkAborted,
  recordLLMUsage,
  logRawOutput,
  joinV1Path,
  extractUsageFields,
  isRetryableStatus,
  isNetworkFetchError,
  formatErrorChain,
  sleep,
  RETRY_DELAY_MS,
  MAX_RETRIES,
  type InternalUsage,
} from './shared.js';
import type { StreamEvent, StreamOptions } from './RealApi.js';

/**
 * 构建 Chat Completions 请求 URL。
 * 与服务商约定的 baseURL 写法保持一致（统一规则见 shared.ts joinV1Path）：
 *   - baseURL 已以 /v1 结尾（如 https://api.deepseek.com/v1）→ `${baseURL}/chat/completions`
 *   - 否则（如 https://api.deepseek.com、https://opencode.ai/zen/go）→ `${baseURL}/v1/chat/completions`
 */
export function buildChatCompletionsUrl(baseURL: string): string {
  return joinV1Path(baseURL, 'chat/completions');
}

/** 将内部 image block（Anthropic 风格 source.data/base64）转为 Chat Completions 的 image_url part */
function toImagePart(block: any): unknown {
  const source = block?.source;
  if (!source?.data) return null;
  const mediaType = source.media_type || 'image/png';
  return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } };
}

/** 把 tool_result 的 content（字符串 / 内容块数组）压平成文本 */
function stringifyToolResultContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part: any) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (part?.type === 'image') return '[image]';
        return JSON.stringify(part ?? '');
      })
      .join('\n');
  }
  return JSON.stringify(raw ?? '');
}

/**
 * 将内部 Anthropic 风格消息转换为 Chat Completions 的 messages 数组。
 *
 * 内部格式：
 *   user:      { role: 'user', content: string | Array<{type:'text'|'image'|'tool_result'}> }
 *   assistant: { role: 'assistant', content: Array<{type:'text'|'thinking'|'tool_use'}> }
 *
 * Chat Completions 格式：
 *   - system prompt      → { role: 'system', content }
 *   - user 文本/图片      → { role: 'user', content: string | Array<{type:'text'|'image_url'}> }
 *   - assistant 文本      → { role: 'assistant', content }
 *   - assistant tool_use → { role: 'assistant', content, tool_calls: [{ id, type:'function', function:{ name, arguments } }] }
 *   - user tool_result   → { role: 'tool', tool_call_id, content }
 *
 * 注意：tool 消息必须紧跟在携带 tool_calls 的 assistant 消息之后，因此遇到
 * 「tool_result + 文本」混合的 user 消息时，先输出全部 tool 消息，再输出 user 消息。
 * thinking block 不回传（Chat Completions 无对应字段，回传易被服务商判为非法参数）。
 */
export function convertMessagesToChatCompletions(
  messages: Array<{ role: string; content: string | unknown[] }>,
  systemPrompt?: string,
): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      const toolMessages: unknown[] = [];
      const userParts: unknown[] = [];
      for (const block of msg.content as any[]) {
        if (!block) continue;
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id || block.tool_call_id || '';
          toolMessages.push({
            role: 'tool',
            tool_call_id: callId,
            content: stringifyToolResultContent(block.content),
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          userParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'input_text' && typeof block.text === 'string') {
          userParts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image') {
          const imagePart = toImagePart(block);
          if (imagePart) userParts.push(imagePart);
        }
      }

      out.push(...toolMessages);
      if (userParts.length > 0) {
        // 纯文本时退化为字符串形式，兼容更多服务商
        const onlyText = userParts.every((p: any) => p.type === 'text');
        out.push({
          role: 'user',
          content: onlyText ? userParts.map((p: any) => p.text).join('\n') : userParts,
        });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'assistant', content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const block of msg.content as any[]) {
        if (!block) continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || block.call_id,
            type: 'function',
            function: {
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            },
          });
        }
      }

      if (toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('') : null,
          tool_calls: toolCalls,
        });
      } else if (textParts.length > 0) {
        out.push({ role: 'assistant', content: textParts.join('') });
      }
      continue;
    }

    // 其它 role（system / developer 等）原样透传
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
    }
  }

  return out;
}

/**
 * 将内部 Anthropic 风格工具（input_schema）转换为 Chat Completions 的 function 工具格式。
 * 非 function 的内置工具（如 web_search）在 Chat Completions 下不支持，直接丢弃。
 */
export function convertToolsToChatCompletionsFormat(tools: unknown[]): unknown[] {
  const converted: unknown[] = [];
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as any;
    if (typeof t.type === 'string' && t.type !== 'function') continue;
    converted.push({
      type: 'function',
      function: {
        name: t.name || 'unknown',
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {}, required: [] },
      },
    });
  }
  return converted;
}

/** 把 Chat Completions 的 finish_reason 映射为内部 stop_reason */
export function mapFinishReason(reason: string | undefined): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'content_filter';
    default: return reason || 'end_turn';
  }
}

/**
 * 从 Chat Completions 的 usage 对象提取内部 usage 格式。
 * OpenAI 语义：prompt_tokens 已包含 cached_tokens（子集），因此不额外加回。
 * 字段提取逻辑与 ResponsesApi 的 extractUsage 逐字相同（仅字段名不同），
 * 参数化收敛到 shared.ts 的 extractUsageFields。
 */
export function extractChatUsage(u: Record<string, unknown> | undefined): InternalUsage | undefined {
  return extractUsageFields(u, {
    inputTokens: 'prompt_tokens',
    outputTokens: 'completion_tokens',
    inputDetails: 'prompt_tokens_details',
    outputDetails: 'completion_tokens_details',
  });
}

/**
 * 调用 OpenAI Chat Completions API（流式模式）
 */
export async function* callOpenAiLLM(options: StreamOptions): AsyncGenerator<StreamEvent | Message> {
  const { messages, systemPrompt, tools, signal, thinkingEffort, modelConfig: optionsModelConfig, sessionId } = options;

  // 从配置读取：优先使用传入的 modelConfig，否则读取 settings.json
  const config = optionsModelConfig ?? await getConfig();
  const { apiKey, baseURL, model, maxTokens } = config;
  const enableUsageStats = await getEnableUsageStats();

  const effectiveThinkingEffort = thinkingEffort;

  checkAborted(signal);

  let requestBody: Record<string, unknown> | undefined;
  /**
   * 是否在请求里带 stream_options.include_usage。
   * 个别 OpenAI 兼容服务（旧版 vLLM / 部分自建网关）会因未知字段直接 400，
   * 此时自动去掉该字段重试一次。
   */
  let includeStreamUsage = true;

  // 流式请求看门狗：首字节 300s / 空闲 60s，超时主动 abort。
  // 网关静默不响应（或只发心跳保活）时，undici 的 headersTimeout/bodyTimeout
  // 会被不断到达的心跳重置，没有这层保护请求会永远挂着且不留任何日志。
  const watchdog = createStreamWatchdog({
    signal,
    firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    component: 'OpenAiAPI',
  });
  // 超时重试计数（单次 callOpenAiLLM 内共享，跨重试不重置）
  let timeoutRetryCount = 0;
  // 退化重复重试计数（与超时/网络错误分开计数）
  let repetitionRetryCount = 0;

  try {
    // 核心请求+流读取逻辑提取为内部函数，支持重试
    // （重试配置 RETRY_DELAY_MS / MAX_RETRIES / isRetryableStatus 见 shared.ts）
    const executeRequest = async function* (
      retryCount: number,
    ): AsyncGenerator<StreamEvent | Message> {
      // 计算 max_tokens：环境变量 > 模型配置 > 全局默认值
      const effectiveMaxTokens = getMaxOutputTokens(model, config.modelConfigs);
      const maxTokensValue = maxTokens > 0 ? Math.min(maxTokens, effectiveMaxTokens) : effectiveMaxTokens;

      const chatMessages = convertMessagesToChatCompletions(messages, systemPrompt);
      const chatTools = convertToolsToChatCompletionsFormat(tools);

      requestBody = {
        model,
        messages: chatMessages,
        stream: true,
        max_tokens: maxTokensValue,
        temperature: 1.0,
        top_p: 0.95,
      };
      if (includeStreamUsage) {
        // 让服务商在流末尾补一帧 usage（OpenAI / 多数兼容网关支持）
        requestBody.stream_options = { include_usage: true };
      }

      // thinking / reasoning：Chat Completions 侧使用 reasoning_effort（GLM / DeepSeek / OpenAI 兼容）
      if (effectiveThinkingEffort && effectiveThinkingEffort !== 'off') {
        requestBody.reasoning_effort = effectiveThinkingEffort;
      }

      if (chatTools.length > 0) {
        requestBody.tools = chatTools;
      }

      if (retryCount === 0) {
        logger.info('OpenAiAPI', '=== Chat Completions LLM Request (stream) ===');
        logger.info('OpenAiAPI', `Model: ${model}`);
        logger.info('OpenAiAPI', `Max tokens: ${maxTokensValue} (config: ${maxTokens}, default: ${effectiveMaxTokens})`);
        logger.info('OpenAiAPI', `Context window: ${getContextWindow(model, config.modelConfigs)} tokens`);
        logger.info('OpenAiAPI', `Messages: ${chatMessages.length} items, tools: ${chatTools.length}, system prompt: ${systemPrompt?.length || 0} chars`);
        logger.info('OpenAiAPI', `Thinking effort: ${effectiveThinkingEffort || 'off'}`);
        logger.debug('OpenAiAPI', `Tools: ${chatTools.map((t: any) => t?.function?.name).join(', ')}`);
      } else {
        logger.info('OpenAiAPI', `=== Chat Completions LLM Request Retry (${retryCount}/${MAX_RETRIES}) ===`);
      }

      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // 部分网关（如 opencode.ai/zen/go）要求 x-opencode-session 才会路由请求
        'x-api-key': apiKey,
        'x-opencode-session': getServerSessionId(sessionId),
        'x-session-id': getServerSessionId(sessionId),
      };

      const chatUrl = buildChatCompletionsUrl(baseURL);
      logger.debug('OpenAiAPI', `Request URL: ${chatUrl}`);

      // 每次尝试都重新武装看门狗（重试时首字节计时重新开始）
      watchdog.restart();

      let response: UndiciResponse;
      try {
        response = await undiciFetch(chatUrl, {
          method: 'POST',
          headers: requestHeaders,
          // 用看门狗的 signal：外部中断与超时都会中止本次请求
          signal: watchdog.signal,
          body: stringifyJsonSafe(requestBody),
          dispatcher: getLLMDispatcher(),
        });
      } catch (fetchError) {
        // 看门狗超时（网关静默不响应）：单独处理，不按 TypeError 判定
        const timeoutError = watchdog.timeoutError();
        if (timeoutError) {
          if (timeoutRetryCount < DEFAULT_MAX_TIMEOUT_RETRIES) {
            timeoutRetryCount++;
            logger.warn('OpenAiAPI',
              `${timeoutError.message}，丢弃本次请求并重试 (${timeoutRetryCount}/${DEFAULT_MAX_TIMEOUT_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
            await sleep(RETRY_DELAY_MS);
            checkAborted(signal);
            yield* executeRequest(retryCount + 1);
            return;
          }
          throw timeoutError;
        }
        if (retryCount < MAX_RETRIES && isNetworkFetchError(fetchError)) {
          logger.warn('OpenAiAPI', `Network error while fetching (${formatErrorChain(fetchError)}), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }
        throw fetchError;
      }

      if (isRetryableStatus(response.status) && retryCount < MAX_RETRIES) {
        logger.warn('OpenAiAPI', `API request got ${response.status}, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
        response.body?.cancel().catch(() => { });
        await sleep(RETRY_DELAY_MS);
        checkAborted(signal);
        yield* executeRequest(retryCount + 1);
        return;
      }

      if (!response.ok) {
        let errorText: string;
        try {
          errorText = await response.text();
        } catch (error) {
          response.body?.cancel().catch(() => { });
          throw error;
        }
        logger.error('OpenAiAPI', `API request failed: ${response.status} ${errorText}`);

        // 服务商不认识 stream_options：去掉该字段重试一次
        if (response.status === 400 && includeStreamUsage
          && /stream_options/i.test(errorText) && retryCount < MAX_RETRIES) {
          logger.warn('OpenAiAPI', 'Provider rejected "stream_options"; retrying without it...');
          includeStreamUsage = false;
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }

        await dumpFailedRequest({
          url: chatUrl,
          method: 'POST',
          requestHeaders: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
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
      let stopReason: string | undefined;
      let usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; reasoning_tokens?: number } | undefined;
      const streamMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // 当前打开的块（thinking / text / tool_use），同一时刻只会有一个
      let openKind: 'thinking' | 'text' | 'tool_use' | null = null;
      let openBlock: any = null;
      let currentThinkingText = '';
      let currentText = '';
      // 退化重复检测：正文与思考各自独立（不随 block 边界重置，否则同一段话被切成
      // 多个 block 重复时会被漏掉）。工具调用参数不参与检测。
      const textRepetition = new RepetitionDetector();
      const thinkingRepetition = new RepetitionDetector();
      /** 按 tool_calls[].index 归并同一轮内的多个工具调用 */
      const toolBlockByIndex = new Map<number, any>();
      let messageDeltaYielded = false;

      const emitBlockStop = function* (): Generator<StreamEvent> {
        if (openKind === null) return;
        if (openKind === 'tool_use' && openBlock) {
          const raw = openBlock._partialJson as string | undefined;
          if (raw) {
            let parsed: unknown = raw;
            try {
              parsed = JSON.parse(raw);
            } catch {
              // 解析失败保留原始字符串，交由上层容错
            }
            // 模型可能把整个入参 double-encode 成 JSON 字符串，这里再解一层
            openBlock.input = unwrapToolInput(parsed);
          }
          // 置空而不是 delete：并行工具调用时部分服务商交错发送 index 0/1 的
          // arguments 分片，若 delete 后同一 block 再收到增量，`undefined + str`
          // 会拼出 "undefined{...}" 导致 JSON.parse 必然失败。
          // 置空后新增量继续累积，收尾阶段统一重新解析。
          openBlock._partialJson = '';
        }
        openKind = null;
        openBlock = null;
        yield { type: 'block_stop', messageId: streamMessageId } as StreamEvent;
      };

      const emitMessageDelta = function* (): Generator<StreamEvent> {
        if (messageDeltaYielded) return;
        messageDeltaYielded = true;
        yield {
          type: 'message_delta',
          usage,
          stop_reason: stopReason,
          messageId: streamMessageId,
        } as StreamEvent;
      };

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
            // 看门狗超时（流停滞 / 网关只发心跳）：释放底层流后按超时策略处理
            const timeoutError = watchdog.timeoutError();
            if (timeoutError) {
              closeReader();
              if (timeoutRetryCount < DEFAULT_MAX_TIMEOUT_RETRIES) {
                timeoutRetryCount++;
                logger.warn('OpenAiAPI',
                  `${timeoutError.message}，丢弃本次响应并重试 (${timeoutRetryCount}/${DEFAULT_MAX_TIMEOUT_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
                await sleep(RETRY_DELAY_MS);
                checkAborted(signal);
                yield* executeRequest(retryCount + 1);
                return;
              }
              throw timeoutError;
            }
            if (retryCount < MAX_RETRIES && readError instanceof TypeError && readError.message === 'terminated') {
              logger.warn('OpenAiAPI', `Stream terminated (TypeError: terminated), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
              closeReader();
              await sleep(RETRY_DELAY_MS);
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

          checkAborted(signal);
          buffer += decoder.decode(value, { stream: true });

          const { parsed: parsedEvents, remaining } = parseSSELines(buffer);
          buffer = remaining;

          // Chat Completions 的 SSE 没有统一的 type 字段，凡是能解析出 JSON 的
          // 数据帧（choices / usage / error）都算进展；纯注释型心跳不会被 parseSSELines
          // 解析成事件，因此不会重置空闲计时器。
          if (parsedEvents.length > 0) {
            watchdog.noteProgress();
          }

          for (const parsed of parsedEvents) {
            // 服务商在流中回传错误对象
            if ((parsed as any).error) {
              const err = (parsed as any).error;
              throw new Error(`Chat Completions failed: ${err?.message || JSON.stringify(err)}`);
            }

            // usage 可能出现在任意帧（含 choices 为空、仅含 usage 的末帧）
            const chunkUsage = extractChatUsage(parsed.usage as Record<string, unknown> | undefined);
            if (chunkUsage) {
              usage = chunkUsage;
            }

            const choices = parsed.choices as any[] | undefined;
            if (!Array.isArray(choices) || choices.length === 0) continue;
            const choice = choices[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              stopReason = mapFinishReason(choice.finish_reason as string);
            }

            const delta = choice.delta as Record<string, any> | undefined;
            if (!delta) continue;

            // ---- 思考内容（reasoning_content 为主，兼容 reasoning）----
            const reasoningDelta = typeof delta.reasoning_content === 'string' && delta.reasoning_content
              ? delta.reasoning_content
              : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
            if (reasoningDelta) {
              if (openKind !== 'thinking') {
                yield* emitBlockStop();
                const block: any = { type: 'thinking', thinking: '' };
                contentBlocks.push(block);
                openKind = 'thinking';
                openBlock = block;
                currentThinkingText = '';
                yield { type: 'block_start', block: { type: 'thinking' }, messageId: streamMessageId } as StreamEvent;
              }
              checkRepetition(thinkingRepetition, reasoningDelta, 'thinking');
              currentThinkingText += reasoningDelta;
              openBlock.thinking = currentThinkingText;
              yield { type: 'thinking_delta', thinking: reasoningDelta, messageId: streamMessageId } as StreamEvent;
            }

            // ---- 正文 ----
            if (typeof delta.content === 'string' && delta.content) {
              if (openKind !== 'text') {
                yield* emitBlockStop();
                const block: any = { type: 'text', text: '' };
                contentBlocks.push(block);
                openKind = 'text';
                openBlock = block;
                currentText = '';
                yield { type: 'block_start', block: { type: 'text' }, messageId: streamMessageId } as StreamEvent;
              }
              checkRepetition(textRepetition, delta.content, 'text');
              currentText += delta.content;
              openBlock.text = currentText;
              yield { type: 'text_delta', text: delta.content, messageId: streamMessageId } as StreamEvent;
            }

            // ---- 工具调用 ----
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as any[]) {
                if (!tc) continue;
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                let block = toolBlockByIndex.get(idx);
                if (!block) {
                  yield* emitBlockStop();
                  block = {
                    type: 'tool_use',
                    id: tc.id || `call_${streamMessageId}_${idx}`,
                    name: tc?.function?.name || '',
                    input: {},
                    _partialJson: '',
                  };
                  contentBlocks.push(block);
                  toolBlockByIndex.set(idx, block);
                  openKind = 'tool_use';
                  openBlock = block;
                  yield {
                    type: 'block_start',
                    block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
                    messageId: streamMessageId,
                  } as StreamEvent;
                } else {
                  if (tc.id && !block.id) block.id = tc.id;
                  if (tc?.function?.name && !block.name) block.name = tc.function.name;
                }
                if (typeof tc?.function?.arguments === 'string' && tc.function.arguments) {
                  block._partialJson = (block._partialJson || '') + tc.function.arguments;
                }
              }
            }
          }
        }
      } catch (loopError) {
        // 退化重复（模型循环输出同一段内容）：丢弃本轮已产生的全部输出 ——
        // 既有的 contentBlocks 全部作废，不写入上下文、不落盘，按服务端异常重试。
        if (loopError instanceof LLMRepetitionError && repetitionRetryCount < DEFAULT_MAX_REPETITION_RETRIES) {
          repetitionRetryCount++;
          closeReader();
          logger.warn('OpenAiAPI',
            `${loopError.message}，丢弃本次响应并重试 (${repetitionRetryCount}/${DEFAULT_MAX_REPETITION_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }
        throw loopError;
      } finally {
        closeReader();
        // 读取阶段已结束（正常读完或已超时），停表避免收尾阶段误报超时。
        // 重试时新的 executeRequest 会重新 restart()。
        watchdog.stop();
      }

      // 流结束，解析 buffer 中的残余数据
      if (buffer.trim()) {
        const { parsed: finalEvents } = parseSSELines(buffer);
        for (const parsed of finalEvents) {
          const chunkUsage = extractChatUsage(parsed.usage as Record<string, unknown> | undefined);
          if (chunkUsage) usage = chunkUsage;
          const choices = parsed.choices as any[] | undefined;
          if (!Array.isArray(choices) || choices.length === 0) continue;
          const choice = choices[0];
          if (choice?.finish_reason) stopReason = mapFinishReason(choice.finish_reason as string);
        }
      }

      // 收尾：关闭仍打开的块
      yield* emitBlockStop();

      // 截断检测：流结束但既没有 finish_reason 也没有任何内容 → 视为异常，重试
      if (stopReason === undefined) {
        if (contentBlocks.length > 0) {
          logger.warn('OpenAiAPI', 'Stream ended without finish_reason but content was received; accepting as end_turn');
          stopReason = 'end_turn';
        } else if (retryCount < MAX_RETRIES) {
          logger.warn('OpenAiAPI', `Stream ended without finish_reason and no content, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        } else {
          logger.error('OpenAiAPI', 'Stream ended without finish_reason and no content; retries exhausted');
          stopReason = 'end_turn';
        }
      }

      if (!usage) {
        usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      }

      yield* emitMessageDelta();

      logger.debug('OpenAiAPI', '=== Chat Completions Stream Response ===');
      logger.debug('OpenAiAPI', `Stop reason: ${stopReason}`);
      logger.debug('OpenAiAPI', `Content blocks: ${contentBlocks.length} (types: ${contentBlocks.map(b => b.type).join(', ')})`);
      logger.debug('OpenAiAPI', `Tokens: Input=${usage.input_tokens}, Output=${usage.output_tokens}`);

      // 收尾：close 之后又收到 arguments 增量的 tool_use block（并行工具调用交错分片），
      // 其 _partialJson 在 close 后被置空再累积，这里统一重新解析为最终 input。
      for (const b of contentBlocks) {
        if (b && b.type === 'tool_use' && typeof b._partialJson === 'string' && b._partialJson) {
          try {
            b.input = unwrapToolInput(JSON.parse(b._partialJson));
          } catch {
            // 解析失败保留已固化的 input，交由上层容错
          }
          delete b._partialJson;
        }
      }

      const finalMsg = buildAssistantMessageFromBlocks(contentBlocks, stopReason, usage);

      // 记录 LLM 原始输出的所有 content blocks
      logRawOutput('OpenAiAPI', finalMsg);

      yield finalMsg;

      if (usage && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
        logger.info('OpenAiAPI', `Stream completed: ${messages.length} messages, input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}, total_tokens=${usage.input_tokens + usage.output_tokens}, stop_reason=${stopReason}`);
        if (enableUsageStats) {
          recordLLMUsage(usage.input_tokens, usage.output_tokens).catch((err: unknown) => {
            logger.warn('OpenAiAPI', `Usage recording failed: ${err}`);
          });
        }
      }
    };

    yield* executeRequest(0);

  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      throw error;
    }

    logger.error('OpenAiAPI', `API call failed: ${formatErrorChain(error)}`);

    await dumpFailedRequest({
      url: buildChatCompletionsUrl(baseURL),
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      requestBody: requestBody ?? { model, max_tokens: maxTokens, messages },
      config,
      error,
    });

    throw error;
  } finally {
    // 无论成功、失败还是消费者提前退出（生成器被 return/throw），都必须释放看门狗计时器
    watchdog.dispose();
  }
}

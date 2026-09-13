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
import { unwrapToolInput, describeToolInput } from '../utils/toolInput.js';
import type { StreamEvent, StreamOptions } from './RealApi.js';

// RedisStats module removed; local no-op stub
async function recordLLMUsage(_inputTokens: number, _outputTokens: number): Promise<void> {}

/**
 * 构建 Chat Completions 请求 URL。
 * 与服务商约定的 baseURL 写法保持一致：
 *   - baseURL 已以 /v1 结尾（如 https://api.deepseek.com/v1）→ `${baseURL}/chat/completions`
 *   - 否则（如 https://api.deepseek.com、https://opencode.ai/zen/go）→ `${baseURL}/v1/chat/completions`
 */
export function buildChatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
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
 */
export function extractChatUsage(u: Record<string, unknown> | undefined): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
} | undefined {
  if (!u) return undefined;
  const inputTokens = (u.prompt_tokens as number) || 0;
  const outputTokens = (u.completion_tokens as number) || 0;
  const promptDetails = (u.prompt_tokens_details as any) || {};
  const completionDetails = (u.completion_tokens_details as any) || {};
  const cacheRead = promptDetails.cached_tokens || 0;
  const reasoningTokens = completionDetails.reasoning_tokens;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
    ...(typeof reasoningTokens === 'number' ? { reasoning_tokens: reasoningTokens } : {}),
  };
}

/**
 * 调用 OpenAI Chat Completions API（流式模式）
 */
export async function* callOpenAiLLM(options: StreamOptions): AsyncGenerator<StreamEvent | Message> {
  const { messages, systemPrompt, tools, signal, thinkingEffort, modelConfig: optionsModelConfig, sessionId } = options;

  // 从配置读取：优先使用传入的 modelConfig，否则读取 settings.json
  const config = optionsModelConfig ?? await getConfig(sessionId);
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

  try {
    const RETRY_DELAY_MS = 1000;
    const MAX_RETRIES = 3;

    const isRetryableStatus = (status: number): boolean => status === 502 || status === 503;

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

      let response: UndiciResponse;
      try {
        response = await undiciFetch(chatUrl, {
          method: 'POST',
          headers: requestHeaders,
          signal: signal || undefined,
          body: JSON.stringify(requestBody),
          dispatcher: getLLMDispatcher(),
        });
      } catch (fetchError) {
        const isNetworkError = fetchError instanceof TypeError &&
          (fetchError.message === 'fetch failed' || (fetchError as any)?.cause !== undefined);
        if (retryCount < MAX_RETRIES && isNetworkError) {
          logger.warn('OpenAiAPI', `Network error while fetching (${fetchError.message}), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }
        throw fetchError;
      }

      if (isRetryableStatus(response.status) && retryCount < MAX_RETRIES) {
        logger.warn('OpenAiAPI', `API request got ${response.status}, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
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
          response.body?.cancel().catch(() => { });
          throw error;
        }
        logger.error('OpenAiAPI', `API request failed: ${response.status} ${errorText}`);

        // 服务商不认识 stream_options：去掉该字段重试一次
        if (response.status === 400 && includeStreamUsage
          && /stream_options/i.test(errorText) && retryCount < MAX_RETRIES) {
          logger.warn('OpenAiAPI', 'Provider rejected "stream_options"; retrying without it...');
          includeStreamUsage = false;
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
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
          delete openBlock._partialJson;
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
            if (retryCount < MAX_RETRIES && readError instanceof TypeError && readError.message === 'terminated') {
              logger.warn('OpenAiAPI', `Stream terminated (TypeError: terminated), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
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

          checkAborted(signal);
          buffer += decoder.decode(value, { stream: true });

          const { parsed: parsedEvents, remaining } = parseSSELines(buffer);
          buffer = remaining;

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
                  block._partialJson += tc.function.arguments;
                }
              }
            }
          }
        }
      } finally {
        closeReader();
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
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
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

      const finalMsg = buildAssistantMessageFromBlocks(contentBlocks, stopReason, usage);

      if ((finalMsg as any).message && Array.isArray((finalMsg as any).message.content)) {
        const blocks = (finalMsg as any).message.content;
        logger.info('OpenAiAPI', `[LLM_RAW_OUTPUT] total_blocks=${blocks.length}`);
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i] as any;
          if (block.type === 'text') {
            const text = String(block.text || '');
            logger.info('OpenAiAPI', `[LLM_RAW_OUTPUT] block[${i}] type=text, text_len=${text.length}, text_preview=${text.substring(0, 500)}`);
          } else if (block.type === 'tool_use') {
            logger.info('OpenAiAPI',
              `[LLM_RAW_OUTPUT] block[${i}] type=tool_use, id=${block.id}, name=${block.name}, ` +
              describeToolInput(block.input));
          } else {
            logger.info('OpenAiAPI', `[LLM_RAW_OUTPUT] block[${i}] type=${block.type}`);
          }
        }
      }

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

    logger.error('OpenAiAPI', `API call failed: ${error}`);

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
  }
}

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

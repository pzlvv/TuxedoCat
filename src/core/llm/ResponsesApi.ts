/**
 * OpenAI Responses API 适配器（流式 SSE）
 *
 * 将内部统一的 Anthropic 风格消息/工具格式转换为 Responses API 格式并调用：
 *   POST {baseURL}/responses  （baseURL 以 /v1 结尾时为 {baseURL}/v1/responses）
 *
 * 输出事件与 RealApi.ts 完全一致（StreamEvent + Message），
 * 因此上层（Query.ts / QueryEngine.ts / WebView）无需任何改动。
 *
 * 支持：
 * - 流式文本（response.output_text.delta）
 * - 思考内容（response.reasoning_summary_text.delta / response.reasoning_text.delta）
 * - 工具调用（response.function_call_arguments.delta）
 * - 中止（AbortSignal）
 * - 502 / 网络错误重试一次
 */

import type { Message } from '../types.js';
import { logger } from '../Logger.js';
import { getConfig, getEnableUsageStats, limitsOf } from './config.js';
import { effectiveMaxOutputTokens } from './modelLimits.js';
import { parseSSELines, buildAssistantMessageFromBlocks, dumpFailedRequest } from './RealApi.js';
import { persistLargeOutput, buildLargeToolResultMessage } from '../tools/toolResultStorage.js';
import { getServerSessionId, markServerSessionRotate } from './serverSession.js';
import { fetch as undiciFetch, type Response as UndiciResponse } from 'undici';
import { getLLMDispatcher } from './httpDispatcher.js';
import {
  createStreamWatchdog,
  isProgressEvent,
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
 * 单条 assistant 回复文本的最大字符数（字符数，非 token）。
 * 超过此值时将完整文本持久化到磁盘，消息中只保留文件路径 + 预览（与 Bash 工具一致）。
 * 常见触发场景：Web Search 后模型把搜索结果整段写入回复（一次可达几十万字符），
 * 但也可能是工具调用后的后续轮次输出超长文本，因此对所有超长输出统一做兜底，
 * 避免超大文本撑爆对话历史与下一轮 LLM 上下文。
 */
const ASSISTANT_MAX_TEXT_CHARS = 40_000;

/**
 * 估算本地输入 token 时，每张图片按固定成本计。
 * 图片以 base64 内联发送（见 convertMessagesToResponsesInput），其字符长度
 * 远超真实 token 数，直接按「字符数 / 4」会把估算值抬到远高于 API 实际
 * input_tokens 的水平，导致污染检测失效。
 */
const IMAGE_TOKEN_ESTIMATE = 1_500;



/**
 * 估算客户端本轮实际发送的输入 token 数（仅用于诊断日志与异常兜底）。
 * 关键：先把图片 base64 替换为占位符再计算长度，最后按固定成本补回图片 token。
 */
export function estimateLocalInputTokens(
  responsesInput: unknown[],
  systemPrompt: string | undefined,
  responsesTools: unknown[],
): number {
  let imageCount = 0;
  const inputJson = JSON.stringify(responsesInput, (key, value) => {
    if (key === 'image_url' && typeof value === 'string' && value.startsWith('data:')) {
      imageCount++;
      return 'data:image/omitted;base64,';
    }
    return value;
  });
  const toolsJson = JSON.stringify(responsesTools);
  return Math.ceil((inputJson.length + (systemPrompt?.length ?? 0) + toolsJson.length) / 4)
    + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/** 本轮 usage 是否可信的判断结果 */
export interface UsageTrustDecision {
  /** true 表示本轮 usage 不可用于更新上下文，应跳过并延迟到后续轮次 */
  skip: boolean;
  /** 跳过原因（写入 serverSession 日志） */
  reason: string;
}

/**
 * 判断本轮 API 返回的 usage 是否可用于更新上下文显示 / compact / 命中率统计。
 *
 * - 内置 web search 轮次：`usage.input_tokens` 含服务端搜索上下文（搜索结果 /
 *   搜索子代理重放对话），实测接近真实上下文的两倍，一律不采用，延迟到下一轮
 *   干净会话的 usage 再显示；
 * - 其它轮次：`input_tokens` 超过上下文窗口 60% 时视为服务端异常累积，同样跳过。
 */
export function shouldSkipUsageForContext(params: {
  webSearchUsed: boolean;
  inputTokens: number;
  localInputEstimate: number;
  contextWindow: number;
}): UsageTrustDecision {
  if (params.webSearchUsed) {
    return {
      skip: true,
      reason: `web search usage skipped (input=${params.inputTokens}, localEstimate=${params.localInputEstimate})`,
    };
  }
  const absCap = Math.floor(params.contextWindow * 0.6);
  if (params.inputTokens > absCap) {
    return { skip: true, reason: `input_tokens ${params.inputTokens} exceeds cap ${absCap}` };
  }
  return { skip: false, reason: '' };
}

// 下面这组纯函数（URL / 工具 / 消息转换 / status / usage / output 校准）导出只为
// 「Responses API 对等对照表」（`scripts/gen-responses-parity.mjs`）能从编译产物调用，
// 运行时调用方仍在模块内部。

/**
 * 构建 Responses API 请求 URL
 * OpenAI SDK 约定：baseURL 为根路径（如 https://api.deepseek.com）时请求 /responses，
 * baseURL 以 /v1 结尾（如 https://api.deepseek.com/v1）时请求 /v1/responses。
 *
 * 注意：部分服务（如 opencode.ai/zen/go）的 baseURL 不带 /v1 前缀，
 * 但 Responses 端点必须位于 /v1/responses（直接拼 /responses 会 404）。
 * 因此统一规则（见 shared.ts joinV1Path）：
 *   - baseURL 已以 /v1 结尾 → `${baseURL}/responses`
 *   - 否则 → `${baseURL}/v1/responses`（多数 OpenAI 兼容服务同时接受此路径）
 */
export function buildResponsesUrl(baseURL: string): string {
  return joinV1Path(baseURL, 'responses');
}

/**
 * 将内部 Anthropic 风格工具（input_schema）转换为 Responses API 的工具格式
 * 输入: { name, description, input_schema }（函数工具）
 * 输出: { type: 'function', name, description, parameters }
 *
 * 注意：非 function 类型的工具（如 Responses API 内置的 web_search）原样透传，
 * 不做转换，保证 { type: 'web_search', ... } 这类工具能直接使用。
 */
export function convertToolsToResponsesFormat(tools: unknown[]): unknown[] {
  return (tools || []).map((tool: any) => {
    // 非 function 工具（如 web_search / computer 等内置工具）原样透传
    if (tool && typeof tool === 'object' && typeof tool.type === 'string' && tool.type !== 'function') {
      return tool;
    }
    return {
      type: 'function',
      name: tool?.name || 'unknown',
      description: tool?.description || '',
      parameters: tool?.input_schema || { type: 'object', properties: {}, required: [] },
    };
  });
}

/**
 * 将内部 Anthropic 风格消息转换为 Responses API 的 input items
 *
 * 内部消息格式（与 Anthropic 兼容）：
 *   user:      { role: 'user', content: string | Array<{type:'text'|'tool_result'|...}> }
 *   assistant: { role: 'assistant', content: Array<{type:'text'|'thinking'|'tool_use'|...}> }
 *
 * Responses API 格式（注意：工具调用是顶层 item，不是 content part）：
 *   - user 文本           → { role: 'user', content: [{ type: 'input_text', text }] }
 *   - assistant 文本      → { role: 'assistant', content: [{ type: 'output_text', text }] }
 *   - assistant thinking  → { type: 'reasoning', content: [{ type: 'reasoning_text', text }] }（顶层项）
 *   - assistant tool_use  → { type: 'function_call', id, call_id, name, arguments }（顶层项）
 *   - user tool_result    → { type: 'function_call_output', call_id, output }（顶层项）
 *
 * 说明：部分服务端（如 DeepSeek）不接受 content part 中的 `output_tool_call`，
 * 必须使用顶层的 `function_call` / `function_call_output` item。
 *
 * 注意：thinking（reasoning）不能省略。当请求开启 reasoning.effort 时，
 * DeepSeek 要求历史中模型产生的 `reasoning_text` 必须原样传回，
 * 否则报 400：The `reasoning_text` in the thinking mode must be passed back to the API.
 * 正确做法是转换为顶层的 `{ type: 'reasoning', content: [{ type: 'reasoning_text', text }] }` item。
 * 空的 thinking block（Query.ts 为 Anthropic 端点补齐的空占位）不满足该要求，应跳过。
 */
export function convertMessagesToResponsesInput(messages: Array<{ role: string; content: string | unknown[] }>): unknown[] {
  const items: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        items.push({
          role: 'user',
          content: [{ type: 'input_text', text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        // 将 user 消息拆分为 function_call_output（顶层项）和 text/image（role: user）
        const toolOutputs: unknown[] = [];
        const userParts: unknown[] = [];
        const toImagePart = (block: any): unknown => {
          if (!block?.source) return null;
          const mediaType = block.source.media_type || 'image/png';
          const data = block.source.data || '';
          return {
            type: 'input_image',
            image_url: `data:${mediaType};base64,${data}`,
            detail: 'auto',
          };
        };
        const toToolOutputPart = (block: any): unknown => {
          if (block.type === 'text' && typeof block.text === 'string') {
            return { type: 'input_text', text: block.text };
          }
          if (block.type === 'image') {
            return toImagePart(block);
          }
          return { type: 'input_text', text: typeof block === 'string' ? block : JSON.stringify(block ?? '') };
        };
        for (const block of msg.content as any[]) {
          if (!block) continue;
          if (block.type === 'tool_result') {
            const callId = block.tool_use_id || block.tool_call_id;
            const rawOutput = block.content;
            const output = Array.isArray(rawOutput)
              ? rawOutput.map(toToolOutputPart)
              : (typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput ?? ''));
            toolOutputs.push({
              type: 'function_call_output',
              call_id: callId,
              output,
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            userParts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'input_text' && typeof block.text === 'string') {
            userParts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'image') {
            const imagePart = toImagePart(block);
            if (imagePart) userParts.push(imagePart);
          }
        }
        // 先输出 function_call_output（紧跟 assistant 的 function_call），再输出 user 文本/图片
        items.push(...toolOutputs);
        if (userParts.length > 0) {
          items.push({
            role: 'user',
            content: userParts,
          });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        items.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const textParts: unknown[] = [];
        const reasoningItems: unknown[] = [];
        const functionCalls: unknown[] = [];
        for (const block of msg.content as any[]) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push({ type: 'output_text', text: block.text });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            // thinking 必须传回（thinking 模式下 API 校验），转为顶层 reasoning item。
            // 注意：不生成随机 id（保持请求前缀字节一致，避免破坏缓存命中），
            // 空的 thinking（占位 block）跳过——API 要求 reasoning_text 非空。
            reasoningItems.push({
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: block.thinking }],
            });
          } else if (block.type === 'tool_use') {
            const callId = block.id || block.call_id;
            functionCalls.push({
              type: 'function_call',
              id: callId,
              call_id: callId,
              name: block.name,
              arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
            });
          }
        }
        // 先输出 reasoning item（对应 assistant 的思考过程），
        // 再输出 assistant 消息项（文本），最后输出顶层的 function_call 项
        items.push(...reasoningItems);
        if (textParts.length > 0) {
          items.push({ role: 'assistant', content: textParts });
        }
        items.push(...functionCalls);
      }
    }
  }

  return items;
}

/**
 * 将 Responses API 的 status / incomplete_details 映射为内部 stop_reason
 */
export function mapResponsesStatus(status: string | undefined, incompleteDetails?: { reason?: string }): string {
  if (status === 'completed') return 'end_turn';
  if (status === 'incomplete') {
    if (incompleteDetails?.reason === 'max_output_tokens') return 'max_tokens';
    return 'incomplete';
  }
  if (status === 'failed') return 'error';
  if (status === 'cancelled') return 'cancelled';
  return status || 'end_turn';
}

/**
 * 从 Responses API 的 usage 对象中提取内部 usage 格式
 * {
 *   input_tokens, output_tokens,
 *   input_tokens_details: { cached_tokens },
 *   output_tokens_details: { reasoning_tokens }
 * }
 * 字段提取逻辑与 OpenAiApi 的 extractChatUsage 逐字相同（仅字段名不同），
 * 参数化收敛到 shared.ts 的 extractUsageFields。
 */
export function extractUsage(respUsage: Record<string, unknown> | undefined): InternalUsage | undefined {
  return extractUsageFields(respUsage, {
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    inputDetails: 'input_tokens_details',
    outputDetails: 'output_tokens_details',
  });
  // 语义说明（与原实现一致）：Responses API 的 input_tokens 已包含缓存命中部分
  // （OpenAI 语义：cached_tokens 是 input_tokens 的子集），无需再加回，否则会双重计数，
  // 导致 WebView 端 cache 命中率被低估（约 H/(1+H)，典型高命中会话显示 ~50%）。
  // 注：Anthropic 兼容端点（RealApi.ts）的 input_tokens 不包含缓存命中部分，
  // 那里才需要加回 cache_read/cache_creation。
}

/**
 * 用 response.completed 中权威的 response.output 校准 content blocks，
 * 避免增量事件缺失导致最终消息不完整。
 */
export function syncContentBlocksFromOutput(contentBlocks: any[], output: unknown[] | undefined): void {
  if (!Array.isArray(output) || output.length === 0) return;
  const newBlocks: any[] = [];
  for (const item of output as any[]) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const part of (item.content || []) as any[]) {
        if (part?.type === 'output_text') {
          newBlocks.push({ type: 'text', text: part.text || '' });
        }
      }
    } else if (item.type === 'reasoning') {
      // 优先取 content（reasoning_text），其次取 summary。
      // DeepSeek 返回的 reasoning item 中 summary 常为空数组，推理内容在 content[].reasoning_text 中。
      const contentText = ((item.content || []) as any[])
        .filter((p: any) => p?.type === 'reasoning_text')
        .map((p: any) => p.text || '')
        .join('');
      const summaryText = ((item.summary || []) as any[])
        .map((s: any) => s?.text || '')
        .join('');
      const thinkingText = contentText || summaryText;
      if (thinkingText) {
        newBlocks.push({ type: 'thinking', thinking: thinkingText });
      }
    } else if (item.type === 'function_call') {
      let input: unknown = {};
      try {
        input = unwrapToolInput(JSON.parse(item.arguments || '{}'));
      } catch {
        input = item.arguments || {};
      }
      newBlocks.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input,
      });
    }
  }
  if (newBlocks.length > 0) {
    contentBlocks.length = 0;
    contentBlocks.push(...newBlocks);
  }
}

/**
 * 调用 OpenAI Responses API（流式模式）
 *
 * 返回两种类型的事件：
 * 1. StreamEvent - 细粒度的流式事件（用于 UI 逐 token 更新）
 * 2. Message - 完整的 assistant 消息（用于持久化）
 *
 * 使用方通过 message_delta 事件判断流结束，
 * 随后会 yield 最终的完整 Message 用于持久化。
 */
export async function* callResponsesLLM(options: StreamOptions): AsyncGenerator<StreamEvent | Message> {
  const { messages, systemPrompt, tools, signal, thinkingEffort, thinkingTokenBudget, modelConfig: optionsModelConfig, sessionId } = options;

  // 从配置读取：优先使用传入的 modelConfig，否则取当前配置快照
  const config = optionsModelConfig ?? await getConfig();
  const { apiKey, baseURL, model } = config;
  // max_output_tokens / 上下文窗口 / thinking 预算都来自快照里已解析的模型限值
  const modelLimits = limitsOf(config, model);
  const effectiveMaxTokens = effectiveMaxOutputTokens(modelLimits);
  const contextWindow = (modelLimits ?? config.modelLimitsFallback).context;
  const enableUsageStats = await getEnableUsageStats();

  // 使用传入的 thinkingEffort，不从配置文件读取该值
  const effectiveThinkingEffort = thinkingEffort;

  // 检查中断
  checkAborted(signal);

  // 在 try 外声明，catch 中可能需要引用
  let requestBody: Record<string, unknown> | undefined;
  // 累积 token 用量（流式模式下从 SSE 中逐步获取）
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;

  // 流式请求看门狗：首字节 300s / 空闲 60s，超时主动 abort。
  // 网关静默不响应（或只发心跳保活）时，undici 的 headersTimeout/bodyTimeout
  // 会被不断到达的心跳重置，没有这层保护请求会永远挂着且不留任何日志。
  const watchdog = createStreamWatchdog({
    signal,
    firstByteTimeoutMs: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    component: 'ResponsesAPI',
  });
  // 超时重试计数（单次 callResponsesLLM 内共享，跨重试不重置）
  let timeoutRetryCount = 0;
  // 退化重复重试计数（与超时/网络错误分开计数）
  let repetitionRetryCount = 0;

  try {
    // 将核心请求+流读取逻辑提取为内部函数，支持重试
    // （重试配置 RETRY_DELAY_MS / MAX_RETRIES / isRetryableStatus 见 shared.ts）
    const executeRequest = async function* (
      retryCount: number,
    ): AsyncGenerator<StreamEvent | Message> {
      // 输出上限：配置级上限（`llm.maxTokens`）与调用方按上下文剩余空间收窄的上限
      // （`LLMConfig.outputTokenCap`）都要满足
      const configuredMaxTokens = config.maxTokens > 0
        ? Math.min(config.maxTokens, effectiveMaxTokens)
        : effectiveMaxTokens;
      const maxTokensValue = config.outputTokenCap && config.outputTokenCap > 0
        ? Math.min(config.outputTokenCap, configuredMaxTokens)
        : configuredMaxTokens;

      // 转换消息与工具
      const responsesInput = convertMessagesToResponsesInput(messages);
      const responsesTools = convertToolsToResponsesFormat(tools);

      // 启用 Web Search（settings.json: llm.webSearch=true）时附加内置 web_search 工具
      if (config.webSearch) {
        responsesTools.push({ type: 'web_search' });
        logger.info('ResponsesAPI', 'Web Search enabled: attached built-in web_search tool');
      }

      // 本地输入 token 估算（用于诊断日志与异常兜底）。
      // 注意：图片 base64 必须剔除，否则估算值会被抬到远超真实 input_tokens
      // 的水平，详见 estimateLocalInputTokens。
      const localInputEstimate = estimateLocalInputTokens(responsesInput, systemPrompt, responsesTools);

      // 构建请求体
      requestBody = {
        model,
        input: responsesInput,
        stream: true,
        max_output_tokens: maxTokensValue,
        temperature: 1.0,
        top_p: 0.95,
      };

      // 确定 reasoning 配置。
      // 对齐 DeepSeek Responses API 的 thinking 参数：reasoning.effort 支持
      // none | low | high | max，其中 none 关闭思考。
      //   - 'off'  → 'none'（必须显式传 none：服务端默认开启思考，不传无法关闭）
      //   - 'low'  → 'low'
      //   - 'high' → 'high'
      //   - 'max'  → 'max'（不能降级成 high，否则「思考强度」选择不生效）
      if (effectiveThinkingEffort) {
        const effort = effectiveThinkingEffort === 'off' ? 'none' : effectiveThinkingEffort;
        requestBody.reasoning = { effort };
        const effectiveThinkingTokenBudget = thinkingTokenBudget
          ?? (modelLimits ?? config.modelLimitsFallback).thinkingTokenBudget;
        logger.debug('ResponsesAPI',
          `Reasoning effort=${effort} (thinking budget ${effectiveThinkingTokenBudget} is not directly supported by Responses API reasoning.effort)`);
      }

      // 添加 instructions（system prompt）
      if (systemPrompt) {
        requestBody.instructions = systemPrompt;
      }

      // 如果有工具，添加到请求中
      if (responsesTools.length > 0) {
        requestBody.tools = responsesTools;
      }

      // 关键日志：记录完整的 LLM 请求
      if (retryCount === 0) {
        logger.info('ResponsesAPI', '=== Responses LLM Request (stream) ===');
        logger.info('ResponsesAPI', `Model: ${model}`);
        logger.info('ResponsesAPI', `Max output tokens: ${maxTokensValue}`);
        logger.info('ResponsesAPI', `Thinking effort: ${effectiveThinkingEffort || 'off'}`);
        logger.info('ResponsesAPI', `Sampling: temperature=1.0, top_p=0.95`);
        logger.info('ResponsesAPI', `Input items: ${responsesInput.length}, tools: ${responsesTools.length}, system prompt: ${systemPrompt?.length || 0} chars`);
        logger.debug('ResponsesAPI', `Tools: ${responsesTools.map((t: any) => t.name).join(', ')}`);
      } else {
        logger.info('ResponsesAPI', `=== Responses LLM Request Retry (${retryCount}/${MAX_RETRIES}) ===`);
      }

      // 发送请求
      const requestHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      };

      // 附加服务端会话 ID 到请求头，供 LLM 服务端追踪会话上下文。
      // 使用可轮换的 server session id：web search 会把搜索结果写入服务端会话，
      // 跨轮累积会让 input_tokens 虚高（详见 serverSession.ts），检测到污染后
      // 在下一轮自动轮换，避免上下文被搜索结果撑爆。
      requestHeaders['x-session-id'] = getServerSessionId(sessionId);

      const responsesUrl = buildResponsesUrl(baseURL);
      logger.debug('ResponsesAPI', `Request URL: ${responsesUrl}`);
      logger.debug('ResponsesAPI', `Request headers: ${JSON.stringify(requestHeaders)}`);

      // 每次尝试都重新武装看门狗（重试时首字节计时重新开始）
      watchdog.restart();

      // 发送请求。网络层错误（如 TypeError: fetch failed）通常是服务器/网络瞬时问题，重试数次
      let response: UndiciResponse;
      try {
        response = await undiciFetch(responsesUrl, {
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
            logger.warn('ResponsesAPI',
              `${timeoutError.message}，丢弃本次请求并重试 (${timeoutRetryCount}/${DEFAULT_MAX_TIMEOUT_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
            await sleep(RETRY_DELAY_MS);
            checkAborted(signal);
            yield* executeRequest(retryCount + 1);
            return;
          }
          throw timeoutError;
        }
        // 对网络层错误（fetch failed / ECONNRESET 等）重试数次
        if (retryCount < MAX_RETRIES && isNetworkFetchError(fetchError)) {
          logger.warn('ResponsesAPI', `Network error while fetching (${formatErrorChain(fetchError)}), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        }
        throw fetchError;
      }

      // 502/503 重试逻辑：遇到服务端瞬时错误（502/503），等待 1s 后重试
      if (isRetryableStatus(response.status) && retryCount < MAX_RETRIES) {
        logger.warn('ResponsesAPI', `API request got ${response.status}, retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
        // 释放未消费的响应体，避免连接被占用
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
          // 读取错误响应体失败（如 abort）时也释放 body，避免连接泄漏
          response.body?.cancel().catch(() => { });
          throw error;
        }
        logger.error('ResponsesAPI', `API request failed: ${response.status} ${errorText}`);

        await dumpFailedRequest({
          url: responsesUrl,
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
      // 统计 output_item.added / done，用于判断“流结束但没收到终止事件”时
      // 所有输出块是否其实已经完整返回（服务端可能漏发 response.completed）。
      let outputItemAddedCount = 0;
      let outputItemDoneCount = 0;
      // 每次 LLM 调用分配唯一 ID，所有流事件共用，确保 WebView 端能精确配对不同次响应
      const streamMessageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      // 当前正在累积的 output item 状态
      let currentItemState: {
        type: 'reasoning' | 'message' | 'function_call' | 'web_search_call';
        id?: string;
        initialSummary?: string;
        blockStarted: boolean;
        blockStopped: boolean;
        /** web_search_call 专用：added 时可能只有 id/status，完整 action 在 done 时才返回 */
        wsAction?: string;
        wsQueries?: string[];
        wsUrl?: string;
        /** web_search_call 专用：卡片事件（web_search_call）是否已发出，避免重复添加/丢失 */
        wsCallEmitted?: boolean;
      } | null = null;
      // 累积 thinking / text / function call 参数
      let currentThinkingText = '';
      let currentText = '';
      let currentFunctionCall: any = null; // { id, call_id, name, input, _partialJson }
      // 退化重复检测：正文与思考各自独立（不随 block 边界重置，否则同一段话被切成
      // 多个 block 重复时会被漏掉）。工具调用参数不参与检测。
      const textRepetition = new RepetitionDetector();
      const thinkingRepetition = new RepetitionDetector();
      // 是否已发出 message_delta（流结束信号）
      let messageDeltaYielded = false;

      // Web Search 使用情况跟踪（用于诊断"搜索后输出过大 / 占满对话上下文"）
      let webSearchUsed = false;
      let webSearchCallCount = 0;
      const webSearchQueries: string[] = [];
      const pushUniqueQuery = (q: string): void => {
        if (q && !webSearchQueries.includes(q)) webSearchQueries.push(q);
      };

      // 本轮 usage 是否不可信、需要跳过（web search 污染）并轮换服务端会话
      // （在 emitMessageDelta 中判定）。跳过时：usage 不写入最终消息、不更新上下文/
      // 命中率（见 Query.ts），延迟到下一轮干净会话的 usage 再显示。
      let serverSessionRotated = false;

      // 用 response.output 中的 web_search_call item 补全当前未结束的搜索项（兜底）
      const finalizePendingWebSearch = function* (resp: Record<string, unknown> | undefined): Generator<StreamEvent> {
        if (!currentItemState || currentItemState.type !== 'web_search_call' || currentItemState.blockStopped) return;
        const wsState = currentItemState; // 局部引用，避免回调闭包中 TS 报 null
        const output = (resp?.output as any[]) || [];
        const match = output.find((o: any) => o?.type === 'web_search_call' && o?.id === wsState.id);
        if (match) {
          const actionObj = match.action || {};
          const action = actionObj.type || '';
          const queries = actionObj.queries || [];
          const url = actionObj.url || '';
          if (action) wsState.wsAction = action;
          if (queries.length > 0) wsState.wsQueries = queries;
          if (url) wsState.wsUrl = url;
        }
        // 兜底日志：正常流程应在 output_item.done 结束，这里表示服务端事件缺失/顺序异常
        (wsState.wsQueries || []).forEach(pushUniqueQuery);
        logger.info('ResponsesAPI',
          `[WEB_SEARCH_FINALIZE_PENDING] callId=${wsState.id}, action=${wsState.wsAction}, ` +
          `queries=${JSON.stringify(wsState.wsQueries)}, url=${wsState.wsUrl}`);
        // 卡片若未发出则补发（含完整信息），否则更新卡片内容
        if (!wsState.wsCallEmitted) {
          yield* emitWebSearchCall();
        } else {
          yield* emitWebSearchUpdate();
        }
        yield* emitBlockStop();
      };

      // 发出 block_stop / web_search_call_done（每个 item 只发一次）
      const emitBlockStop = function* (): Generator<StreamEvent> {
        if (currentItemState && !currentItemState.blockStopped) {
          currentItemState.blockStopped = true;
          if (currentItemState.type === 'web_search_call') {
            // 防御异常顺序：若卡片事件尚未发出（例如后续 text item 先关闭本 block），
            // 先补发卡片事件再发 done，避免"只有 done 没有 call"导致 UI 卡片丢失。
            if (!currentItemState.wsCallEmitted) {
              yield* emitWebSearchCall();
            }
            yield { type: 'web_search_call_done', callId: currentItemState.id || '', messageId: streamMessageId } as StreamEvent;
          } else {
            yield { type: 'block_stop', messageId: streamMessageId } as StreamEvent;
          }
        }
      };

      // 发出 web_search_call 事件（卡片首次出现，携带当前可用的 action/queries/url）
      const emitWebSearchCall = function* (): Generator<StreamEvent> {
        if (!currentItemState || currentItemState.type !== 'web_search_call') return;
        currentItemState.wsCallEmitted = true;
        yield {
          type: 'web_search_call',
          callId: currentItemState.id || '',
          action: currentItemState.wsAction || 'search',
          queries: currentItemState.wsQueries || [],
          url: currentItemState.wsUrl || '',
          messageId: streamMessageId,
        } as StreamEvent;
      };

      // 发出 web_search_call_update 事件（卡片已存在，仅更新搜索词/URL 等参数）
      const emitWebSearchUpdate = function* (): Generator<StreamEvent> {
        if (!currentItemState || currentItemState.type !== 'web_search_call') return;
        yield {
          type: 'web_search_call_update',
          callId: currentItemState.id || '',
          action: currentItemState.wsAction || 'search',
          queries: currentItemState.wsQueries || [],
          url: currentItemState.wsUrl || '',
          messageId: streamMessageId,
        } as StreamEvent;
      };

      // 用 output_item.done / response 中的 web_search_call item 补全 action 信息
      const enrichWebSearchState = function (item: Record<string, unknown> | undefined): void {
        if (!currentItemState || currentItemState.type !== 'web_search_call' || !item) return;
        const actionObj = (item.action as Record<string, unknown>) || {};
        const action = (actionObj.type as string) || '';
        const queries = (actionObj.queries as string[]) || [];
        const url = (actionObj.url as string) || '';
        if (action) currentItemState.wsAction = action;
        if (queries.length > 0) currentItemState.wsQueries = queries;
        if (url) currentItemState.wsUrl = url;
      };

      // 发出 message_delta（流结束信号，只发一次）
      const emitMessageDelta = function* (): Generator<StreamEvent> {
        if (messageDeltaYielded) return;
        messageDeltaYielded = true;
        if (!usage) {
          usage = { input_tokens: accumulatedInputTokens, output_tokens: accumulatedOutputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        }
        // 判断本轮 usage 是否可信（web search 轮次 / 超上限 → 跳过）。
        // 跳过时：usage 不写入最终消息、不更新上下文/命中率（由 Query.ts 抑制），
        // 延迟到下一轮干净会话的 usage 再显示；同时轮换 x-session-id 避免跨轮累积
        // （见 shouldSkipUsageForContext / getServerSessionId / serverSession.ts）。
        serverSessionRotated = false;
        const skipDecision = shouldSkipUsageForContext({
          webSearchUsed,
          inputTokens: usage.input_tokens,
          localInputEstimate,
          contextWindow,
        });
        if (skipDecision.skip) {
          markServerSessionRotate(sessionId, skipDecision.reason);
          serverSessionRotated = true;
        }
        yield {
          type: 'message_delta',
          usage,
          stop_reason: stopReason,
          messageId: streamMessageId,
          serverSessionRotated,
        } as StreamEvent;
      };

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
          // 看门狗超时（流停滞 / 网关只发心跳）：释放底层流后按超时策略处理
          const timeoutError = watchdog.timeoutError();
          if (timeoutError) {
            closeReader();
            if (timeoutRetryCount < DEFAULT_MAX_TIMEOUT_RETRIES) {
              timeoutRetryCount++;
              logger.warn('ResponsesAPI',
                `${timeoutError.message}，丢弃本次响应并重试 (${timeoutRetryCount}/${DEFAULT_MAX_TIMEOUT_RETRIES})，${RETRY_DELAY_MS}ms 后开始...`);
              await sleep(RETRY_DELAY_MS);
              checkAborted(signal);
              yield* executeRequest(retryCount + 1);
              return;
            }
            throw timeoutError;
          }
          // 对 TypeError: terminated 重试数次
          if (retryCount < MAX_RETRIES && readError instanceof TypeError && readError.message === 'terminated') {
            logger.warn('ResponsesAPI', `Stream terminated (TypeError: terminated), retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
            // 释放之前的 reader
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

        // 检查中断
        checkAborted(signal);

        buffer += decoder.decode(value, { stream: true });

        // 解析 buffer。parseSSELines 返回成功解析的事件列表和未解析的 buffer 残留。
        const { parsed: parsedEvents, remaining } = parseSSELines(buffer);
        buffer = remaining;

        // 只有真正的 `response.*` 事件才算「模型有进展」并重置空闲计时器。
        // 网关的 ping 心跳虽然也是字节，但不算进展，否则可以无限绕过空闲超时。
        if (parsedEvents.some(event => isProgressEvent(event, 'response.'))) {
          watchdog.noteProgress();
        }

        for (const parsed of parsedEvents) {
          const eventType = parsed.type as string;

          if (eventType === 'response.output_item.added') {
            const item = parsed.item as Record<string, unknown> | undefined;
            if (!item) continue;
            outputItemAddedCount++;
            const itemType = item.type as string;

            // 新项开始时，先关闭上一个未关闭的 block（防御异常顺序）
            if (currentItemState && !currentItemState.blockStopped) {
              yield* emitBlockStop();
            }

            if (itemType === 'reasoning') {
              // 思考项开始
              currentItemState = { type: 'reasoning', id: (item.id as string) || undefined, blockStarted: true, blockStopped: false };
              currentThinkingText = '';
              // 预存 summary（部分服务端只在 output_item.added 携带完整 summary，后续无 delta 事件）
              const summary = (item.summary as any[]) || [];
              currentItemState.initialSummary = summary.map((s: any) => s?.text || '').join('');
              contentBlocks.push({ type: 'thinking', thinking: '' });
              yield { type: 'block_start', block: { type: 'thinking' }, messageId: streamMessageId } as StreamEvent;
            } else if (itemType === 'web_search_call') {
              // 内置 Web Search 调用（模型自动执行，不进入 contentBlocks / 不当作工具执行）。
              // 立即发出卡片事件（此时通常只有 id/status，queries/url 为空，
              // UI 显示"正在联网搜索…"），确保卡片在文本输出之前出现；
              // 完整的 action（queries/url）在 output_item.done 时才返回，
              // 届时用 web_search_call_update 更新卡片内容。
              const callId = (item.id as string) || '';
              const actionObj = (item.action as Record<string, unknown>) || {};
              currentItemState = {
                type: 'web_search_call',
                id: callId,
                blockStarted: true,
                blockStopped: false,
                wsAction: (actionObj.type as string) || 'search',
                wsQueries: (actionObj.queries as string[]) || [],
                wsUrl: (actionObj.url as string) || '',
              };
              // 统计 Web Search 使用情况：added 时 queries 通常为空，done 时才返回完整信息
              webSearchUsed = true;
              webSearchCallCount++;
              (currentItemState.wsQueries || []).forEach(pushUniqueQuery);
              logger.info('ResponsesAPI',
                `[WEB_SEARCH_ADDED] callId=${callId}, action=${currentItemState.wsAction}, ` +
                `queries=${JSON.stringify(currentItemState.wsQueries)}, url=${currentItemState.wsUrl}`);
              yield* emitWebSearchCall();
            } else if (itemType === 'function_call') {
              // 工具调用项开始
              currentItemState = { type: 'function_call', id: (item.id as string) || undefined, blockStarted: true, blockStopped: false };
              const callId = (item.call_id as string) || (item.id as string) || '';
              currentFunctionCall = {
                type: 'tool_use',
                id: callId,
                name: item.name,
                input: {},
              };
              contentBlocks.push(currentFunctionCall);
              yield {
                type: 'block_start',
                block: { type: 'tool_use', id: callId, name: item.name, input: item.arguments || {} },
                messageId: streamMessageId,
              } as StreamEvent;
            }
            // message 项的 content part 由 response.content_part.added 处理
          } else if (eventType === 'response.content_part.added') {
            const part = parsed.part as Record<string, unknown> | undefined;
            if (!part) continue;
            const partType = part.type as string;
            if (partType === 'output_text') {
              // 文本 part 开始
              if (currentItemState && !currentItemState.blockStopped) {
                yield* emitBlockStop();
              }
              currentItemState = { type: 'message', blockStarted: true, blockStopped: false };
              currentText = '';
              contentBlocks.push({ type: 'text', text: '' });
              yield { type: 'block_start', block: { type: 'text' }, messageId: streamMessageId } as StreamEvent;
            }
          } else if (eventType === 'response.output_text.delta') {
            const delta = (parsed.delta as string) || '';
            checkRepetition(textRepetition, delta, 'text');
            currentText += delta;
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text = currentText;
            }
            yield { type: 'text_delta', text: delta, messageId: streamMessageId } as StreamEvent;
          } else if (eventType === 'response.reasoning_summary_text.delta' || eventType === 'response.reasoning_text.delta') {
            const delta = (parsed.delta as string) || '';
            checkRepetition(thinkingRepetition, delta, 'thinking');
            currentThinkingText += delta;
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'thinking') {
              lastBlock.thinking = currentThinkingText;
            }
            yield { type: 'thinking_delta', thinking: delta, messageId: streamMessageId } as StreamEvent;
          } else if (eventType === 'response.function_call_arguments.delta') {
            const delta = (parsed.delta as string) || '';
            if (currentFunctionCall) {
              if (!(currentFunctionCall as any)._partialJson) {
                (currentFunctionCall as any)._partialJson = '';
              }
              (currentFunctionCall as any)._partialJson += delta;
              // 记录参数累积进度（debug 级别）
              const totalLen = ((currentFunctionCall as any)._partialJson as string).length;
              if (totalLen <= delta.length || totalLen % 2000 < delta.length) {
                logger.debug('ResponsesAPI',
                  `[FUNCTION_CALL_ARGS] id=${currentFunctionCall.id}, name=${currentFunctionCall.name}, ` +
                  `delta_len=${delta.length}, accumulated_len=${totalLen}`);
              }
            }
          } else if (eventType === 'response.output_text.done') {
            const text = (parsed.text as string) || currentText;
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'text') {
              lastBlock.text = text;
            }
            yield* emitBlockStop();
          } else if (eventType === 'response.reasoning_summary_text.done' || eventType === 'response.reasoning_text.done') {
            const text = (parsed.text as string) || currentThinkingText;
            currentThinkingText = text;
            const lastBlock = contentBlocks[contentBlocks.length - 1];
            if (lastBlock && lastBlock.type === 'thinking') {
              lastBlock.thinking = text;
            }
            yield* emitBlockStop();
          } else if (eventType === 'response.function_call_arguments.done') {
            const argsStr = (parsed.arguments as string) || (currentFunctionCall as any)?._partialJson || '';
            if (currentFunctionCall) {
              try {
                // 模型可能把整个入参 double-encode 成 JSON 字符串，解包后再交给上层
                currentFunctionCall.input = argsStr ? unwrapToolInput(JSON.parse(argsStr)) : {};
              } catch (e) {
                logger.error('ResponsesAPI',
                  `[FUNCTION_CALL_PARSE_FAILED] id=${currentFunctionCall.id}, name=${currentFunctionCall.name}, ` +
                  `error=${e}, raw=${argsStr.substring(0, 1000)}`);
                currentFunctionCall.input = argsStr; // 解析失败保留原始字符串
              }
              delete (currentFunctionCall as any)._partialJson;
            }
            yield* emitBlockStop();
          } else if (eventType === 'response.web_search_call.in_progress' ||
            eventType === 'response.web_search_call.completed' ||
            eventType === 'response.web_search_call.done') {
            // OpenAI 标准 web search 生命周期事件：item 中携带完整的 action
            // （queries / url）。部分服务商在 output_item.added / output_item.done
            // 中不携带 action 详情（例如"搜索→打开页面"链式调用中，search 项的
            // queries 只在 web_search_call 事件里给出），这里提前补全，
            // 否则 UI 卡片会显示为空白的"正在联网搜索…"。
            const wsItem = parsed.item as Record<string, unknown> | undefined;
            if (wsItem && wsItem.type === 'web_search_call' &&
              currentItemState && currentItemState.type === 'web_search_call' &&
              currentItemState.id === (wsItem.id as string)) {
              enrichWebSearchState(wsItem);
              // 若卡片尚未发出（事件顺序异常），补发卡片；否则仅更新内容
              if (!currentItemState.wsCallEmitted) {
                yield* emitWebSearchCall();
              } else {
                yield* emitWebSearchUpdate();
              }
              logger.info('ResponsesAPI',
                `[WEB_SEARCH_EVENT] type=${eventType}, callId=${wsItem.id}, ` +
                `action=${currentItemState.wsAction}, ` +
                `queries=${JSON.stringify(currentItemState.wsQueries)}, url=${currentItemState.wsUrl}`);
            }
          } else if (eventType === 'response.output_item.done') {
            const item = parsed.item as Record<string, unknown> | undefined;
            if (item) outputItemDoneCount++;
            // finalize 当前 item（若缺少 done 事件，则从 item 兜底）
            if (currentItemState?.type === 'reasoning') {
              // 若没有 delta 事件且 output_item.added 携带了 summary，则使用 summary
              if (!currentThinkingText && currentItemState.initialSummary) {
                currentThinkingText = currentItemState.initialSummary;
                const lastBlock = contentBlocks[contentBlocks.length - 1];
                if (lastBlock && lastBlock.type === 'thinking') {
                  lastBlock.thinking = currentThinkingText;
                }
                yield { type: 'thinking_delta', thinking: currentThinkingText, messageId: streamMessageId } as StreamEvent;
              }
              yield* emitBlockStop();
            } else if (currentItemState?.type === 'message') {
              // 若没有 delta 事件，从 item.content 兜底
              if (!currentText && item && Array.isArray(item.content)) {
                const text = (item.content as any[])
                  .filter((p: any) => p?.type === 'output_text')
                  .map((p: any) => p.text || '')
                  .join('');
                if (text) {
                  currentText = text;
                  const lastBlock = contentBlocks[contentBlocks.length - 1];
                  if (lastBlock && lastBlock.type === 'text') {
                    lastBlock.text = currentText;
                  }
                  yield { type: 'text_delta', text, messageId: streamMessageId } as StreamEvent;
                }
              }
              yield* emitBlockStop();
            } else if (currentItemState?.type === 'function_call') {
              // 若没有 function_call_arguments.done，从 item.arguments 或累积的 partial JSON 兜底
              if (currentFunctionCall) {
                let argsStr = '';
                if (item && typeof item.arguments === 'string' && item.arguments) {
                  argsStr = item.arguments;
                } else if ((currentFunctionCall as any)._partialJson) {
                  argsStr = (currentFunctionCall as any)._partialJson;
                }
                if (argsStr) {
                  try {
                    currentFunctionCall.input = unwrapToolInput(JSON.parse(argsStr));
                  } catch {
                    currentFunctionCall.input = argsStr;
                  }
                }
                delete (currentFunctionCall as any)._partialJson;
              }
              yield* emitBlockStop();
            } else if (currentItemState?.type === 'web_search_call') {
              // 内置 Web Search 调用结束：先用 item 中的完整 action 补全信息。
              // 卡片已在 added 时发出（正常顺序），这里仅更新搜索词/URL；
              // 若卡片尚未发出（异常顺序），则补发卡片事件。
              enrichWebSearchState(item);
              // done 时才返回完整的 queries/url，补全统计并记录日志
              (currentItemState.wsQueries || []).forEach(pushUniqueQuery);
              logger.info('ResponsesAPI',
                `[WEB_SEARCH_DONE] callId=${currentItemState.id}, action=${currentItemState.wsAction}, ` +
                `queries=${JSON.stringify(currentItemState.wsQueries)}, url=${currentItemState.wsUrl}`);
              if (!currentItemState.wsCallEmitted) {
                yield* emitWebSearchCall();
              } else {
                yield* emitWebSearchUpdate();
              }
              yield* emitBlockStop();
            }
            currentItemState = null;
            currentFunctionCall = null;
          } else if (eventType === 'response.completed') {
            const resp = parsed.response as Record<string, unknown> | undefined;
            if (resp) {
              stopReason = mapResponsesStatus(
                resp.status as string | undefined,
                resp.incomplete_details as { reason?: string } | undefined,
              );
              const respUsage = extractUsage(resp.usage as Record<string, unknown> | undefined);
              if (respUsage) {
                usage = respUsage;
                accumulatedInputTokens = respUsage.input_tokens;
                accumulatedOutputTokens = respUsage.output_tokens;
              }
              // 用权威的 response.output 校准 content blocks
              syncContentBlocksFromOutput(contentBlocks, resp.output as unknown[] | undefined);
              logger.info('ResponsesAPI', `[UsageDebug] response.completed status=${resp.status}, usage=${JSON.stringify(respUsage)}`);
            }
            // 兜底：若还有未结束的 web_search_call（服务端未发 output_item.done），补发事件
            yield* finalizePendingWebSearch(resp);
            yield* emitBlockStop();
            yield* emitMessageDelta();
          } else if (eventType === 'response.incomplete') {
            const resp = parsed.response as Record<string, unknown> | undefined;
            if (resp) {
              stopReason = mapResponsesStatus('incomplete', resp.incomplete_details as { reason?: string } | undefined);
              const respUsage = extractUsage(resp.usage as Record<string, unknown> | undefined);
              if (respUsage) {
                usage = respUsage;
                accumulatedInputTokens = respUsage.input_tokens;
                accumulatedOutputTokens = respUsage.output_tokens;
              }
              syncContentBlocksFromOutput(contentBlocks, resp.output as unknown[] | undefined);
            }
            yield* finalizePendingWebSearch(resp);
            yield* emitBlockStop();
            yield* emitMessageDelta();
          } else if (eventType === 'response.failed') {
            const resp = parsed.response as Record<string, unknown> | undefined;
            const err = (resp as any)?.error;
            throw new Error(
              `Responses API failed: ${err?.message || JSON.stringify(err) || 'unknown error'}`
            );
          }
          // 其他事件（response.created / response.in_progress / response.content_part.done 等）忽略
        }
      }
      } catch (loopError) {
        // 退化重复（模型循环输出同一段内容）：丢弃本轮已产生的全部输出 ——
        // 既有的 contentBlocks 全部作废，不写入上下文、不落盘，按服务端异常重试。
        if (loopError instanceof LLMRepetitionError && repetitionRetryCount < DEFAULT_MAX_REPETITION_RETRIES) {
          repetitionRetryCount++;
          closeReader();
          logger.warn('ResponsesAPI',
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

      // 流结束，解析 buffer 中剩余的所有数据（无法解析的残余丢弃）
      if (buffer.trim()) {
        const { parsed: finalEvents } = parseSSELines(buffer);
        for (const parsed of finalEvents) {
          const eventType = parsed.type as string;
          if (eventType === 'response.completed' || eventType === 'response.incomplete') {
            const resp = parsed.response as Record<string, unknown> | undefined;
            if (resp) {
              stopReason = mapResponsesStatus(
                resp.status as string | undefined,
                resp.incomplete_details as { reason?: string } | undefined,
              );
              const respUsage = extractUsage(resp.usage as Record<string, unknown> | undefined);
              if (respUsage) {
                usage = respUsage;
                accumulatedInputTokens = respUsage.input_tokens;
                accumulatedOutputTokens = respUsage.output_tokens;
              }
              syncContentBlocksFromOutput(contentBlocks, resp.output as unknown[] | undefined);
            }
          } else if (eventType === 'response.failed') {
            const resp = parsed.response as Record<string, unknown> | undefined;
            const err = (resp as any)?.error;
            throw new Error(
              `Responses API failed: ${err?.message || JSON.stringify(err) || 'unknown error'}`
            );
          }
        }
      }

      // ===== 截断检测：流结束但未收到终止事件（response.completed / response.incomplete）=====
      // 服务端提前掐断流时（例如只输出部分 thinking 就被关闭连接），stopReason 保持 undefined。
      // 此时已返回的内容是不完整的，不应进入上下文：丢弃本次部分输出并重试请求。
      // 注意：必须放在 emitMessageDelta 之前，否则兜底 message_delta 会把部分内容
      // 当作正常结束推给 UI / 更新上下文用量，重试后就会在上下文里留下残缺内容。
      //
      // 实测 opencode/zen 网关在部分响应中不会发送 response.completed，而是：
      //   ... output_item.done -> ping -> 流结束
      // 此时所有 output item 实际都已完整返回（output_item.done 已收到）。
      // 这种场景不应重试，否则 UI 会先收到第一份完整流式内容，再收到重试后的
      // 第二份完整内容，出现重复 thinking / text 消息。
      if (stopReason === undefined) {
        // 用户主动取消（abort）：流是本端提前掐断的，服务端不会补终止事件，
        // 因此「无终止事件」不是截断——不重试、也不补 message_delta，直接抛
        // AbortError 交给 Query.ts 走「用户中断」收尾（与 Standalone 侧
        // `responses.rs` 的 `cancel` 判定同一口径）。
        checkAborted(signal);
        const allOutputItemsDone =
          outputItemAddedCount > 0 &&
          outputItemDoneCount >= outputItemAddedCount &&
          !currentItemState;

        if (allOutputItemsDone) {
          logger.warn('ResponsesAPI',
            `Stream ended without terminal event (stopReason=undefined) but all output items completed ` +
            `(${outputItemDoneCount}/${outputItemAddedCount}); accepting response as end_turn`);
          stopReason = 'end_turn';
        } else if (retryCount < MAX_RETRIES) {
          logger.warn('ResponsesAPI',
            `Stream ended without terminal event (stopReason=undefined, blocks=${contentBlocks.length}, ` +
            `outputItems=${outputItemDoneCount}/${outputItemAddedCount}, pendingItem=${currentItemState?.type ?? 'none'}, ` +
            `bufferTail=${JSON.stringify(buffer.slice(-300))}), ` +
            `discarding partial output and retrying (${retryCount + 1}/${MAX_RETRIES}) after ${RETRY_DELAY_MS}ms...`);
          await sleep(RETRY_DELAY_MS);
          checkAborted(signal);
          yield* executeRequest(retryCount + 1);
          return;
        } else {
          logger.error('ResponsesAPI',
            `Stream ended without terminal event (stopReason=undefined, outputItems=${outputItemDoneCount}/${outputItemAddedCount}), ` +
            `retries exhausted, yielding partial response`);
        }
      }

      // 如果流结束时还没有发出 message_delta（服务端未发送 completed/incomplete），补发一次
      yield* emitMessageDelta();

      // 处理 tool_use 中的 arguments 兼容格式
      for (const block of contentBlocks) {
        if (block.type === 'tool_use') {
          const toolBlock = block as unknown as { name: string; id: string; input: Record<string, unknown> };
          if (toolBlock.input && typeof toolBlock.input.arguments === 'string') {
            logger.debug('ResponsesAPI', `Arguments detected, expand arguments: ${JSON.stringify(toolBlock.input)}`);
            try {
              const parsed = JSON.parse(toolBlock.input.arguments as string) as Record<string, unknown>;
              toolBlock.input = parsed;
            } catch {
              // 解析失败保留原值
            }
          }
        }
      }

      // 🔴 关键日志：记录流式响应统计
      logger.debug('ResponsesAPI', '=== Responses Stream Response ===');
      logger.debug('ResponsesAPI', `Stop reason: ${stopReason}`);
      logger.debug('ResponsesAPI', `Content blocks: ${contentBlocks.length} (types: ${contentBlocks.map(b => b.type).join(', ')})`);
      if (usage) {
        logger.debug('ResponsesAPI', `Tokens: Input=${usage.input_tokens}, Output=${usage.output_tokens}`);
      }

      // Web Search 使用统计：用于排查"搜索后输出过大 / 占满对话上下文"的问题。
      // 搜索本身不产生 token，但模型常把搜索结果整段写入回复（一次可达几十万字符），
      // 该日志把"是否搜索 / 搜索词 / 输出文本大小 / 实际 token 用量"关联起来。
      if (webSearchUsed) {
        const textBlocks = contentBlocks.filter((b: any) => b.type === 'text');
        const thinkingBlocks = contentBlocks.filter((b: any) => b.type === 'thinking');
        const totalTextLen = textBlocks.reduce((sum: number, b: any) => sum + String(b.text || '').length, 0);
        const totalThinkingLen = thinkingBlocks.reduce((sum: number, b: any) => sum + String(b.thinking || '').length, 0);
        logger.info('ResponsesAPI',
          `[WEB_SEARCH_SUMMARY] calls=${webSearchCallCount}, queries=${JSON.stringify(webSearchQueries)}, ` +
          `output_text_chars=${totalTextLen}, output_text_tokens≈${Math.ceil(totalTextLen / 4)}, ` +
          `thinking_chars=${totalThinkingLen}, ` +
          `usage=${usage ? JSON.stringify(usage) : 'n/a'}`);
      }

      // yield 最终的完整 assistant message（用于持久化）
      // 本轮 usage 被跳过（web search 污染 / 超上限）时不写入：
      // 避免虚高的 input/cache 数据进入上下文显示、auto-compact 判断与命中率统计，
      // 延迟到下一轮干净会话的 usage 正常记录（见 emitMessageDelta 的 serverSessionRotated）。
      const finalMsg = buildAssistantMessageFromBlocks(
        contentBlocks,
        stopReason,
        serverSessionRotated ? undefined : usage,
      );

      // 记录 LLM 原始输出的所有 content blocks
      logRawOutput('ResponsesAPI', finalMsg);

      // ---- 超大文本输出持久化（常见于 Web Search 后模型把搜索结果整段写入回复） ----
      // 只要单条 assistant 回复的文本超长（>ASSISTANT_MAX_TEXT_CHARS）就持久化到磁盘，
      // 消息内容替换为文件路径 + 预览（与 Bash 工具一致）。
      //
      // 注意：不能依赖 webSearchUsed（仅表示"本次响应里出现过 web_search_call"）。
      // 实际场景中，搜索后的后续轮次（工具调用后继续输出、或服务商不返回 web_search_call item）
      // 也可能把搜索结果整段写进回复；这些轮次没有 web_search_call，旧逻辑会漏掉它们，
      // 导致上下文仍被超长文本撑爆。因此这里对任何超长输出统一做兜底。
      if (Array.isArray((finalMsg as any).message?.content)) {
        const origBlocks = (finalMsg as any).message.content as any[];
        const textBlocks = origBlocks.filter((b: any) => b.type === 'text');
        const totalTextLen = textBlocks.reduce((sum: number, b: any) => sum + String(b.text || '').length, 0);
        if (totalTextLen > ASSISTANT_MAX_TEXT_CHARS) {
          try {
            const fullText = textBlocks.map((b: any) => String(b.text || '')).join('\n\n');
            const persisted = await persistLargeOutput(fullText, sessionId, `assistant-${streamMessageId}`);
            if (persisted) {
              const persistedMsg = buildLargeToolResultMessage(
                persisted.filepath,
                persisted.originalSize,
                persisted.preview,
              );
              // 用单个持久化消息块替换所有 text 块，保留 thinking / tool_use 等块
              const newContent: any[] = [];
              let inserted = false;
              for (const b of origBlocks) {
                if (b.type === 'text') {
                  if (!inserted) {
                    newContent.push({ type: 'text', text: persistedMsg, _streamId: streamMessageId });
                    inserted = true;
                  }
                  // 后续 text 块丢弃（内容已合并持久化到同一文件）
                } else {
                  newContent.push(b);
                }
              }
              (finalMsg as any).message.content = newContent;
              logger.info('ResponsesAPI',
                `Assistant output too large (${totalTextLen} chars > ${ASSISTANT_MAX_TEXT_CHARS}), ` +
                `persisted to ${persisted.filepath}` +
                (webSearchUsed ? `, webSearchUsed=true, calls=${webSearchCallCount}, queries=${JSON.stringify(webSearchQueries)}` : ''));
            }
          } catch (err) {
            logger.error('ResponsesAPI', 'Failed to persist large assistant output:', err);
            // 持久化失败时保留原内容（不阻塞响应）
          }
        }
      }

      yield finalMsg;

      // 记录 token 用量（异步，不阻塞主流程）
      if (usage && (usage.input_tokens > 0 || usage.output_tokens > 0)) {
        logger.info('ResponsesAPI', `Stream completed: ${messages.length} messages, input_tokens=${usage.input_tokens}, output_tokens=${usage.output_tokens}, total_tokens=${usage.input_tokens + usage.output_tokens}, stop_reason=${stopReason}`);

        if (enableUsageStats) {
          recordLLMUsage(usage.input_tokens, usage.output_tokens).catch((err: unknown) => {
            logger.warn('ResponsesAPI', `Usage recording failed: ${err}`);
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

    logger.error('ResponsesAPI', `API call failed: ${formatErrorChain(error)}`);

    // 网络异常时 requestBody 可能尚未构建完整
    await dumpFailedRequest({
      url: buildResponsesUrl(baseURL),
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      requestBody: requestBody ?? { model, max_output_tokens: effectiveMaxTokens, input: messages },
      config,
      error,
    });

    throw error;
  } finally {
    // 无论成功、失败还是消费者提前退出（生成器被 return/throw），都必须释放看门狗计时器
    watchdog.dispose();
  }
}

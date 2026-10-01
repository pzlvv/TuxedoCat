/**
 * query - 核心查询循环
 * 用户消息 → API 调用 → 工具执行 → 下一轮
 */

import type { Message, MessageData, StreamMessageData, StreamEndData } from './types.js';
import type { ToolUseContext } from './tools/Tool.js';
import type { LLMConfig } from './llm/config.js';
import type { Tool } from './tools/Tool.js';
import type { AutoCompactTrackingState } from './compact/types.js';
import type { CoreEvent } from './AssistantEventBus.js';
import { sessionQueue } from './SessionQueue.js';
import { logger } from './Logger.js';
import { updateConversationContext } from './history/index.js';
import { limitsOf } from './llm/config.js';
import { availableOutputTokens } from './llm/modelLimits.js';
import { estimateRequestTokens } from './utils/tokenEstimate.js';
import { CONFIG_DIR_NAME } from '../config/project.js';

/** core → UI 单向事件的发送侧封装（Query 模块统一走它） */
function emitToUi(event: CoreEvent): void {
  const { requireEventBus } = require('./AssistantEventBus.js') as typeof import('./AssistantEventBus.js');
  requireEventBus().emitToUi(event);
}

function cleanWebSearchUrl(url: string): string {
  return url.replace(/[#&?]ws_call_id=[^#&?]*/g, '').replace(/[?#]$/, '');
}

/**
 * 兼容性 AbortSignal 形状（与全局 AbortSignal 类型不同：只有 aborted/reason）。
 * 命名为 *Like 以避免遮蔽全局类型。
 */
type AbortSignalLike = {
  aborted: boolean;
  readonly reason?: unknown;
};

export interface QueryParams {
  sessionID: string
  messages: Message[]
  staticSystemPrompt: string
  toolUseContext: ToolUseContext
  querySource: string
  maxTurns?: number
  /**
   * 静默模式：不推送流式消息到 UI（core 不再持有 UI 引用，事件一律走总线）。
   * 保留该标记以维持「不向 UI 推送」的能力（子代理等静默场景）。
   */
  silent?: boolean
  /**
   * 动态获取当前 system prompt 和可用工具。
   * 每次 query 内部循环（工具调用后的下一轮 LLM 请求）都会重新获取，
   * 用于混合模式在首次 LLM 回复后从极简切换到普通。
   * 未提供时使用 staticSystemPrompt / availableTools 常量。
   */
  getPromptState?: () => Promise<{
    systemPrompt: string;
    availableTools?: string[];
    /**
     * 本会话启用的 MCP server 集合。提供时只把这些 server 的 MCP 工具发给 LLM，
     * 避免把其它会话启用、但本会话未勾选的 MCP 工具带出去。
     */
    enabledMcpServers?: ReadonlySet<string>;
  }>
  /** LLM 配置覆盖，不指定则使用 settings.json 中的配置 */
  modelConfig?: LLMConfig
  /**
   * 动态获取当前 LLM 配置。
   * 每次 query 内部循环都会重新获取，用于混合模式在首次 LLM 回复后
   * 从极简（强制关闭 Web Search）切换为普通（恢复用户 Web Search 设置）。
   * 未提供时使用 modelConfig 常量。
   */
  getModelConfig?: () => LLMConfig | undefined
  /**
   * 静默中止判定：返回 true 时，本次因 abort 结束的查询不向 UI 回显
   * "*User Interrupted*" 等中断消息（用于业务主动结束，如 spin 子代理
   * 首次 Reply 后停止自身）。
   */
  silentAbort?: () => boolean
}

// -- query loop state

// Mutable state carried between loop iterations
type State = {
  messages: Message[]
  turnCount: number
  autoCompactTracking?: AutoCompactTrackingState
}

type Terminal = {
  reason: string
}

type RawApiMessage = { role: string; content: string | unknown[] };

/**
 * content block 上「只服务 UI / 内部流程、不参与 LLM 请求」的字段。
 *
 * - `_meta` / `_partialJson`：UI 历史恢复与统计、SSE 流式解析的累积字段；
 * - `beforeContent` / `afterContent` / `contextBefore` / `contextAfter`：
 *   Edit / Write 的 diff 展示字段（见 tools/Tool.ts 的 PermissionDiffPayload），
 *   只用于 webview 工具卡片 diff 与 editRollback 兜底。`beforeContent` 可能是
 *   **整份文件内容**，留在请求里会把上下文撑大若干倍（实测 700 条消息的会话
 *   因此从 400K 被估成 3M token，远未到阈值就触发自动压缩）。
 *
 * 注意：只在「请求载荷」里剔除，持久化的对话消息保持原样
 * （webview 展开归档与 editRollback 仍要从 tool_result 读 beforeContent）。
 */
const NON_LLM_BLOCK_FIELDS = [
  '_meta',
  '_partialJson',
  'beforeContent',
  'afterContent',
  'contextBefore',
  'contextAfter',
] as const;

/** 返回剔除 UI 专用字段后的 block 副本；没有可剔除字段时原样返回（避免无谓拷贝）。 */
function stripNonLlmBlockFields(block: Record<string, unknown>): Record<string, unknown> {
  if (!NON_LLM_BLOCK_FIELDS.some((key) => block[key] !== undefined)) return block;
  const clean: Record<string, unknown> = { ...block };
  for (const key of NON_LLM_BLOCK_FIELDS) delete clean[key];
  return clean;
}

/**
 * 把 Message[] 转换为 API 请求用的原始消息数组（user/assistant 交替之前的格式）。
 *
 * 行为要点（与抽取前的内联实现逐行一致）：
 * - 只保留 user / assistant 类型
 * - 字符串 content 中格式化进文件/行号元数据（[Current File: ...]）
 *   在构造 rawApiMessages 时就把文件/行号元数据格式化进文本，
 *   而不是后续按 apiMessages 索引回填（索引在合并连续同角色消息后会错位）。
 * - 数组 content 剔除 block 上的 UI 专用字段（见 NON_LLM_BLOCK_FIELDS）
 * - 其他类型 content 统一 String() 化
 *
 * 该函数同时是「当前请求输入量」的唯一口径：自动压缩判断与 max_output_tokens
 * 预留都基于它的输出估算，保证估算与实际发送内容一致。
 */
export function buildRawApiMessages(messages: Message[]): RawApiMessage[] {
  return messages
    .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
    .map((msg) => {
      const content = msg.message.content;

      // 处理 content 类型
      let formattedContent: string | unknown[];
      if (typeof content === 'string') {
        let text = content;

        const fileMsg = msg as any;
        if (
          msg.type === 'user'
          && fileMsg.filePath
          && !fileMsg.fileHidden
          && !text.startsWith('[Current File:')
        ) {
          let fileInfoText = `[Current File: ${fileMsg.filePath}`;
          const sel = fileMsg.fileSelectedLines;
          if (sel && sel.start > 0 && sel.end > 0) {
            if (sel.start === sel.end) {
              fileInfoText += ` (line ${sel.start})]`;
            } else {
              fileInfoText += ` (lines ${sel.start}-${sel.end})]`;
            }
          } else {
            fileInfoText += ']';
          }
          text = fileInfoText + '\n\n' + text;
        }

        formattedContent = text;
      } else if (Array.isArray(content)) {
        // content 是数组，需要格式化
        formattedContent = content.map((block: unknown) => {
          if (typeof block === 'object' && block !== null) {
            // 剔除 UI 专用字段（_meta / _partialJson / diff 展示字段），
            // 它们体积可能远超真正的 tool 输出，且不属于 LLM 输入。
            return stripNonLlmBlockFields(block as Record<string, unknown>);
          }
          return block;
        });
      } else {
        formattedContent = String(content);
      }

      return {
        role: msg.type === 'user' ? 'user' : 'assistant',
        content: formattedContent,
      };
    });
}

/**
 * 为所有 content 为数组但缺少 thinking block 的 assistant 消息补空 thinking。
 *
 * 原因：DeepSeek 代理要求当开启 thinking 模式时，历史 assistant 消息的 content 数组
 * 中必须包含 type=thinking 的 block。如果用户在执行工具过程中（如 sleep 5）将 thinking
 * 从 off 切换为 max，下一轮 LLM 请求带 thinking 模式时，历史消息中的 assistant 消息
 * 含有 tool_use 但没有 thinking block，会导致 API 报错：
 *   "The content[].thinking in the thinking mode must be passed back to the API."
 * 解决方案：不管当前是否开启 thinking，统一补一个空的 thinking block。
 * 这样即使中途切换 thinking 模式，历史消息也已满足要求，无需额外处理。
 */
function ensureThinkingBlocks(rawApiMessages: RawApiMessage[]): void {
  for (const msg of rawApiMessages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasThinking = (msg.content as any[]).some((b: any) => b.type === 'thinking');
      if (!hasThinking) {
        (msg.content as any[]).unshift({ type: 'thinking', thinking: '' });
      }
    }
  }
}

/**
 * 合并连续同角色消息。
 * Anthropic API requires strict user/assistant alternation: each
 * tool_use block must have a corresponding tool_result block in the
 * immediately following message. Without merging, multiple separate
 * user messages (each with one tool_result) violate this requirement.
 */
function mergeConsecutiveSameRole(raw: RawApiMessage[]): RawApiMessage[] {
  const apiMessages: RawApiMessage[] = [];
  for (const msg of raw) {
    const last = apiMessages[apiMessages.length - 1];
    if (last && last.role === msg.role) {
      // Merge same-role consecutive messages by concatenating content
      const lastContent = Array.isArray(last.content)
        ? last.content
        : [{ type: 'text', text: last.content as string }];
      const newContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text', text: msg.content as string }];
      last.content = [...lastContent, ...newContent];
    } else {
      apiMessages.push(msg);
    }
  }
  return apiMessages;
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<Message, Terminal, unknown> {
  return yield* queryLoop(params);
}

async function* queryLoop(
  params: QueryParams,
): AsyncGenerator<Message, Terminal, unknown> {
  const { staticSystemPrompt, maxTurns } = params;

  const getPromptState = params.getPromptState
    ?? (async () => ({ systemPrompt: staticSystemPrompt, availableTools: undefined, enabledMcpServers: undefined }));
  const getModelConfig = params.getModelConfig ?? (() => params.modelConfig);

  let state: State = {
    messages: params.messages,
    // turnCount 只统计本次 query() 内部的工具循环轮次（每条用户消息独立预算），
    // 不计入历史 assistant 消息：否则 maxTurns 预算跨整条会话共享，
    // 历史消息数达到 maxTurns 后每条新消息第一轮就被 max_turns 截断。
    turnCount: 0,
  };

  while (true) {
    const { messages, turnCount } = state;
    // toolUseContext 整个循环不变（每轮不再重新赋回 state），直接取参数值
    const toolUseContext = params.toolUseContext;

    {
      const { getSessionEngine } = await import('./QueryEngine.js');
      const engine = getSessionEngine(params.sessionID);
      if (engine) {
        engine.flushQueuedMessagesIntoContext();
      }
    }

    // 当前上下文已占用的 token 数（最近一次 API 返回的 input + output），
    // 既用于自动压缩判断，也用于计算本次请求可用的 max output。
    let exactTokenCount: number | undefined;

    // Auto compact 检查（含手动触发但被延后的压缩）
    {
      const {
        shouldAutoCompact,
        compactAndApplyMessages,
        isPendingCompact,
        unmarkPendingCompact,
      } = await import('./compact/index.js');

      // 手动触发压缩时会话若非空闲，会登记"待压缩"（见 Integration.requestCompact）。
      // 这里把它当作"已达到需要压缩的条件"，与自动压缩走同一条安全路径，
      // 从而在下一轮对话开始时（本次 LLM 请求之前）完成压缩。
      const pendingCompact = isPendingCompact(params.sessionID);

      const apiMessages = messages.filter((m) => m.type === 'assistant');
      for (let i = apiMessages.length - 1; i >= 0; i--) {
        const usage = (apiMessages[i] as any)?.message?.usage;
        if (usage?.input_tokens > 0 && usage?.output_tokens !== undefined) {
          exactTokenCount = usage.input_tokens + usage.output_tokens;
          break;
        }
      }
      if (exactTokenCount === undefined) {
        try {
          const { loadConversation } = await import('./history/Conversation.js');
          const metaTokens = (await loadConversation(params.sessionID)).metadata?.context?.totalContextTokens;
          if (metaTokens !== undefined && metaTokens > 0) {
            exactTokenCount = metaTokens;
          }
        } catch {
          // meta.json 可能不存在
        }
      }

      // 用估算值兜底 exactTokenCount：估算包含本轮新增消息与 system prompt，
      // 偏保守（宁可高估），避免上下文实际已接近窗口却因旧 usage 偏低而不触发压缩。
      //
      // 估算口径必须与真正发出去的载荷一致：先经 buildRawApiMessages 剔除
      // _meta 与 tool_result 的 diff 展示字段（可能是整份文件内容），否则会把
      // 400K 的上下文估成 3M token，导致远未到阈值就触发自动压缩。
      const contextTokenCount = Math.max(
        exactTokenCount ?? 0,
        estimateRequestTokens({ messages: buildRawApiMessages(messages), systemPrompt: staticSystemPrompt }),
      );

      // 用动态获取的模型配置判断压缩阈值（主调用方只传 getPromptState/getModelConfig 回调，
      // params.modelConfig 恒为 undefined，会导致 shouldAutoCompact 拿不到模型名而使用默认阈值）。
      const currentModelConfig = getModelConfig();
      const shouldCompact = pendingCompact
        || await shouldAutoCompact(
          messages,
          state.autoCompactTracking,
          contextTokenCount,
          currentModelConfig ? limitsOf(currentModelConfig, currentModelConfig.model) : undefined,
          currentModelConfig?.modelLimitsFallback,
        );

      if (shouldCompact) {
        if (pendingCompact) {
          unmarkPendingCompact(params.sessionID);
          logger.info('query', `Executing deferred manual compact for session ${params.sessionID}`);
        }
        // 延后的手动压缩按 manual 记录边界（trigger = 'manual'）；自动压缩保持 'auto'。
        const applied = await compactAndApplyMessages(params.sessionID, messages, {
          isAutoCompact: !pendingCompact,
        });

        if (!applied) {
          // 不满足压缩条件（没有可摘要的消息）：不做任何处理，保持上下文原样。
          logger.info('query', `Compact skipped for session ${params.sessionID} (no messages to summarize)`);
        } else {
          // 压缩会重建消息数组，需要把 lastPersistedMessageUuid 指向新的末尾消息。
          const { getSessionEngine } = await import('./QueryEngine.js');
          const engine = getSessionEngine(params.sessionID);
          const lastMsg = messages[messages.length - 1];
          if (engine && lastMsg && 'uuid' in lastMsg && (lastMsg as any).uuid) {
            engine.lastPersistedMessageUuid = (lastMsg as any).uuid;
          }

          // 压缩后上下文已大幅缩短，旧的 exactTokenCount 不再代表当前上下文，
          // 重置后本次请求按“无历史占用”计算可用输出，避免输出被压缩前的旧值挤压。
          // 下面构建请求时会用压缩后的 messages 重新估算实际输入。
          exactTokenCount = undefined;
        }
      }
    }

    yield { type: 'stream_request_start' } as Message;

    const assistantMessages: Message[] = [];
    const toolUseBlocks: unknown[] = [];
    let needsFollowUp = false;
    const activeWebSearchCalls = new Set<string>();

    emitToUi({ type: 'aiBegin', sessionId: params.sessionID });

    try {
      const [{ callLLM }, { convertToolsToLlmFormat }, { getAllTools }] = await Promise.all([
        import('./llm/index.js'),
        import('./tools/toolSchema.js'),
        import('./tools/index.js'),
      ]);

      const rawApiMessages = buildRawApiMessages(messages);

      ensureThinkingBlocks(rawApiMessages);

      // Merge consecutive messages with the same role.
      const apiMessages = mergeConsecutiveSameRole(rawApiMessages);

      if (apiMessages.length === 0) {
        throw new Error('No valid messages to send to API');
      }

      // 获取当前 system prompt 和工具列表。
      // 混合模式下首次 LLM 回复完成后，这里会拿到普通模式的 system prompt 和完整工具列表。
      const { systemPrompt: fullSystemPrompt, availableTools, enabledMcpServers } = await getPromptState();

      // MCP 工具按会话过滤：即使进程被其它会话继续引用，也不把本会话未勾选的 MCP 工具发出去
      const allTools = getAllTools(enabledMcpServers);
      const filteredTools = availableTools
        ? allTools.filter(t => availableTools.includes(t.name))
        : allTools;
      const tools = await convertToolsToLlmFormat(filteredTools as unknown as typeof allTools & Tool[]);

      const { getSessionThinkingMode } = await import('./Integration.js');
      const thinkingEffort = getSessionThinkingMode(params.sessionID);

      // ===== 流式调用 =====
      // callLLM 现在 yield 两种类型：
      // 1. StreamEvent - 流式 delta 事件（逐 token 通知 UI）
      // 2. Message - 最终的完整 assistant 消息（用于持久化和工具调用处理）

      // 累积流式内容的缓冲
      let streamedThinkingContent = '';
      let streamedTextContent = '';
      // 当前正在流式输出的 block 专属 streamId。
      // 背景：Responses API 单次调用可能输出多个 thinking/text block（例如
      // "思考→文字→搜索→思考→文字→搜索…"）。若所有 block 共用同一个调用级
      // streamId（event.messageId），WebView 端 streamMessage 按 streamId+role
      // 匹配会把后续 block 的内容"改写"到第一条消息上，导致中间文本（如
      // "我来搜索…"）丢失、顺序错乱。这里在每次 block_start 时生成新的
      // block 级 streamId，保证每个 block 在 UI 中增量追加。
      let currentThinkingStreamId: string | undefined;
      let currentTextStreamId: string | undefined;
      // 当前正在流式输出的 block 类型（用于 block_stop 时精确收尾对应消息）
      let currentBlockType: 'thinking' | 'text' | 'tool_use' | null = null;
      const { randomId } = await import('./tools/RunTools.js');
      const newBlockStreamId = (): string => randomId('blk');
      // 辅助函数：判断是否为流式事件
      function isStreamEvent(val: any): val is import('./llm/RealApi.js').StreamEvent {
        return val && typeof val === 'object' && 'type' in val &&
          (val.type === 'thinking_delta' || val.type === 'text_delta' ||
            val.type === 'block_start' || val.type === 'block_stop' ||
            val.type === 'message_delta' ||
            val.type === 'web_search_call' || val.type === 'web_search_call_update' ||
            val.type === 'web_search_call_done');
      }

      // 本次请求的 max output：min(output, context - current_context)。
      // 为输出预留的空间不能超过上下文窗口的剩余空间，否则请求会超出窗口。
      // 这里用「真正要发送的 payload」（合并后的消息 + system prompt + 工具 schema）
      // 再估一次，与 exactTokenCount 取较大者；估算偏保守，宁可少留输出也不超窗口。
      const requestTokenCount = Math.max(
        exactTokenCount ?? 0,
        estimateRequestTokens({ messages: apiMessages, systemPrompt: fullSystemPrompt, tools }),
      );
      // 输出预留按「当前上下文剩余空间」收窄，避免「输入 + 输出」超出窗口。
      // 限值来自配置快照；模型未知时 `limitsOf` 返回 undefined，按全局默认处理。
      const baseModelConfig = getModelConfig();
      let requestModelConfig = baseModelConfig;
      if (baseModelConfig) {
        const available = availableOutputTokens(
          limitsOf(baseModelConfig, baseModelConfig.model),
          baseModelConfig.modelLimitsFallback,
          requestTokenCount,
        );
        // 配置级上限（`llm.maxTokens`）与上下文余量取更严的那个
        const configured = baseModelConfig.maxTokens > 0 ? baseModelConfig.maxTokens : available;
        requestModelConfig = { ...baseModelConfig, outputTokenCap: Math.min(configured, available) };
      }

      for await (const event of callLLM({
        messages: apiMessages,
        systemPrompt: fullSystemPrompt,
        tools,
        signal: (toolUseContext.abortController as any).signal,
        thinkingEffort,
        modelConfig: requestModelConfig,
        sessionId: toolUseContext.sessionId as string,
      })) {
        // ---- 处理流式事件 (StreamEvent) ----
        if (isStreamEvent(event)) {
          if (event.type === 'thinking_delta') {
            streamedThinkingContent += event.thinking;
            // 逐 token 通知 UI 增量追加（使用当前 block 的 streamId）
            if (!params.silent) {
              emitToUi({
                type: 'streamMessage',
                sessionId: params.sessionID,
                data: {
                  role: 'thinking',
                  delta: event.thinking,
                  accumulated: streamedThinkingContent,
                  streamId: currentThinkingStreamId ?? event.messageId,
                } as StreamMessageData,
              });
            }
          } else if (event.type === 'text_delta') {
            streamedTextContent += event.text;
            // 逐 token 通知 UI 增量追加（使用当前 block 的 streamId）
            if (!params.silent) {
              emitToUi({
                type: 'streamMessage',
                sessionId: params.sessionID,
                data: {
                  role: 'assistant',
                  delta: event.text,
                  accumulated: streamedTextContent,
                  streamId: currentTextStreamId ?? event.messageId,
                } as StreamMessageData,
              });
            }
          } else if (event.type === 'block_start') {
            const block = event.block;
            if (block.type === 'thinking') {
              streamedThinkingContent = '';
              // 新 thinking block：分配新的 block 级 streamId，避免 WebView 端
              // 按 streamId+role 匹配到上一条 thinking 消息而改写覆盖。
              currentThinkingStreamId = newBlockStreamId();
              currentBlockType = 'thinking';
            } else if (block.type === 'text') {
              streamedTextContent = '';
              currentTextStreamId = newBlockStreamId();
              currentBlockType = 'text';
            } else if (block.type === 'tool_use') {
              currentBlockType = 'tool_use';
            }
          } else if (event.type === 'block_stop') {
            // 每个 block 结束时立即发送 streamEnd，把对应流式消息标记为完成
            // （isStreaming=false）。否则单轮多 block（Responses API 的
            // 思考→文字→搜索→思考→文字…）时，只有最后一个 block 会被
            // message_delta 的 streamEnd 收尾，中间 block 的消息会一直停在
            // isStreaming=true，导致 WebView 的自动滚动轮询持续运行。
            // usage 传 undefined：token 统计仍由 message_delta 统一更新。
            if (currentBlockType === 'thinking' && streamedThinkingContent && !params.silent) {
              emitToUi({
                type: 'streamEnd',
                sessionId: params.sessionID,
                data: {
                  role: 'thinking',
                  accumulated: streamedThinkingContent,
                  usage: undefined,
                  streamId: currentThinkingStreamId ?? event.messageId,
                } as StreamEndData,
              });
            } else if (currentBlockType === 'text' && streamedTextContent && !params.silent) {
              emitToUi({
                type: 'streamEnd',
                sessionId: params.sessionID,
                data: {
                  role: 'assistant',
                  accumulated: streamedTextContent,
                  usage: undefined,
                  streamId: currentTextStreamId ?? event.messageId,
                } as StreamEndData,
              });
            }
            currentBlockType = null;
          } else if (event.type === 'message_delta') {
            // 流接近结束，更新 usage
            if (event.usage) {
              // 本轮 usage 不可信（内置 web search 轮次含服务端搜索上下文，或 input_tokens
              // 超上限，见 ResponsesApi / serverSession）：不能用来更新上下文使用量和命中率，
              // 否则上下文显示、compact 阈值判断与缓存命中率都会被污染。
              // 处理方式：本轮跳过上下文更新，streamEnd 不携带 usage（webview 不更新
              // contextLength / 命中率），延迟到下一轮干净会话的 usage 再正常更新。
              const serverSessionRotated = (event as any).serverSessionRotated === true;
              const streamEndUsage = serverSessionRotated ? undefined : event.usage;
              if (!serverSessionRotated) {
                const totalContextTokens = event.usage.input_tokens + event.usage.output_tokens;
                if (totalContextTokens > 0) {
                  updateConversationContext(params.sessionID, { totalContextTokens }).catch((e: unknown) => logger.warn('query', 'Failed to update context:', e));
                }
              }
              if (streamedThinkingContent) {
                if (!params.silent) {
                  emitToUi({
                    type: 'streamEnd',
                    sessionId: params.sessionID,
                    data: {
                      role: 'thinking',
                      accumulated: streamedThinkingContent,
                      usage: streamEndUsage,
                      // 使用最后一个 thinking block 的 streamId，保证更新到对应消息
                      streamId: currentThinkingStreamId ?? event.messageId,
                    } as StreamEndData,
                  });
                }
              }
              if (streamedTextContent) {
                if (!params.silent) {
                  emitToUi({
                    type: 'streamEnd',
                    sessionId: params.sessionID,
                    data: {
                      role: 'assistant',
                      accumulated: streamedTextContent,
                      usage: streamEndUsage,
                      // 使用最后一个 text block 的 streamId，保证更新到对应消息
                      streamId: currentTextStreamId ?? event.messageId,
                    } as StreamEndData,
                  });
                }
              }
              // 纯 tool_use 场景：虽然没有 thinking/text 内容，但仍需传递 usage 更新 token 计数
              if (!streamedThinkingContent && !streamedTextContent && !params.silent) {
                emitToUi({
                  type: 'streamEnd',
                  sessionId: params.sessionID,
                  data: {
                    role: 'assistant',
                    accumulated: '',
                    usage: streamEndUsage,
                    streamId: event.messageId,
                  } as StreamEndData,
                });
              }
            }
          } else if (event.type === 'web_search_call') {
            // Web Search 调用开始：以工具卡片形式显示（与其他工具风格一致，不进入消息历史）
            const queries = (event.queries || [])
              .filter((q: string) => !q.startsWith('ws_call_id='))
              .slice(0, 3);
            const action = event.action || 'search';
            // 部分服务商会在打开的 URL 上附加内部追踪片段（#ws_call_id=...），对用户是噪音，展示前剥离
            const url = cleanWebSearchUrl(event.url || '');
            if (!params.silent) {
              const toolCallId = `websearch_${event.callId}`;
              activeWebSearchCalls.add(toolCallId);
              emitToUi({
                type: 'message',
                sessionId: params.sessionID,
                data: {
                  role: 'toolcall',
                  content: '',
                  param: 'WebSearch',
                  toolName: 'WebSearch',
                  toolArgs: {
                    action,
                    queries,
                    url,
                  },
                  toolCallId,
                  status: 'running',
                } as MessageData,
              });
            }
          } else if (event.type === 'web_search_call_update') {
            // Web Search 卡片已在 added 时显示（status=running），
            // 此处用 output_item.done 返回的完整 action/queries/url 更新卡片内容。
            const queries = (event.queries || [])
              .filter((q: string) => !q.startsWith('ws_call_id='))
              .slice(0, 3);
            const action = event.action || 'search';
            const url = cleanWebSearchUrl(event.url || '');
            if (!params.silent) {
              emitToUi({
                type: 'toolArgsUpdated',
                sessionId: params.sessionID,
                toolUseId: `websearch_${event.callId}`,
                args: {
                  action,
                  queries,
                  url,
                },
              });
            }
          } else if (event.type === 'web_search_call_done') {
            if (!params.silent) {
              const toolCallId = `websearch_${event.callId}`;
              activeWebSearchCalls.delete(toolCallId);
              emitToUi({
                type: 'toolResult',
                sessionId: params.sessionID,
                toolUseId: toolCallId,
                toolName: 'WebSearch',
                output: '',
                status: 'success',
              });
            }
          }
          continue;
        }

        // ---- 处理完整的 Message（流结束后的最终消息） ----
        if (event.type === 'assistant') {
          const content = event.message.content as unknown[];

          /**
           * 数据流：LLM 返回 -> 持久化到 meta.json -> 发送到 webview 更新 UI
           *
           * 步骤 1: appendMessage() 将消息写入 .jsonl 文件，同时更新 .meta.json 中的：
           *   - messageCount（消息计数）
           *   - updatedAt（更新时间）
           *   - context.totalContextTokens（当前上下文总 token 数，用于恢复时显示进度条）
           *
           * 步骤 2: emitToUi(message) 将消息和 token 数据发送到 webview
           *   - contextLength（input_tokens）：当前用于显示的输入 token 数
           *   - outputTokens：本次输出 token 数
           *   - webview 自行计算 totalTokens = contextLength + outputTokens 更新进度条
           */

          // 解析 content blocks 并识别 tool_use。
          // thinking/text 分支已删除：其唯一的操作是重复调用 updateConversationContext
          // 写入与 message_delta 处理完全相同的 totalContextTokens（同一轮已写多次，
          // 纯冗余），usage 更新与 UI 收尾均由 message_delta 分支统一处理。
          for (const block of content) {
            const blockType = (block as { type: string }).type;

            if (blockType === 'tool_use') {
              const toolUse = block as { id: string; name: string; input: unknown };
              toolUseBlocks.push(toolUse);
              needsFollowUp = true;
            }
          }

          assistantMessages.push(event);

          // 超长文本输出被持久化到磁盘时，通知 UI 用「文件路径 + 预览」消息
          // 替换已经流式输出的完整文本（与 Bash 工具执行完替换为持久化预览一致）。
          // 复用 onStreamEnd（usage 传 undefined 避免重复累加 token），
          // webview 端会按 streamId + role 匹配流式消息并替换 content。
          // 注意：流式消息现在使用 block 级 streamId（见 block_start 处理），
          // 不能用 ResponsesApi 写入的调用级 _streamId（msg_...）匹配，
          // 否则 webview 找不到对应消息会追加一条重复预览。这里改用最后一个
          // text block 的 streamId（超长文本通常是最后的回答块）。
          if (Array.isArray(event.message.content)) {
            const persistedTextBlock = (event.message.content as any[]).find(
              (b: any) => b.type === 'text' && typeof b._streamId === 'string'
            );
            if (persistedTextBlock && !params.silent) {
              const collapseStreamId = currentTextStreamId ?? persistedTextBlock._streamId;
              emitToUi({
                type: 'streamEnd',
                sessionId: params.sessionID,
                data: {
                  role: 'assistant',
                  accumulated: String(persistedTextBlock.text || ''),
                  usage: undefined,
                  streamId: collapseStreamId,
                } as StreamEndData,
              });
            }
          }

          yield event;
        }
      }
    } catch (error) {
      emitToUi({ type: 'aiEnd', sessionId: params.sessionID });

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('query', 'API call error:', errorMessage);

      const signal = toolUseContext.abortController?.signal as AbortSignalLike | null;
      const isAborted = signal?.aborted ||
        errorMessage.includes('aborted') ||
        errorMessage.includes('The operation was aborted') ||
        error instanceof Error && error.name === 'AbortError';

      for (const toolCallId of activeWebSearchCalls) {
        emitToUi({
          type: 'toolResult',
          sessionId: params.sessionID,
          toolUseId: toolCallId,
          toolName: 'WebSearch',
          output: isAborted ? 'User Interrupted' : errorMessage,
          status: 'error',
        });
      }
      activeWebSearchCalls.clear();
      activeWebSearchCalls.clear();

      if (isAborted) {
        sessionQueue.cancelQueued(params.sessionID);

        // 静默中止（业务主动结束，如 spin 子代理首次 Reply 后停止自身）：
        // 不向 UI 回显中断消息，直接结束本轮查询。
        if (params.silentAbort?.()) {
          return { reason: 'user_aborted' };
        }

        emitToUi({
          type: 'message',
          sessionId: params.sessionID,
          data: { role: 'system', content: '*User Interrupted*' } as MessageData,
        });

        const abortMsg: Message = {
          type: 'system',
          content: '*User Interrupted*',
          uuid: `system_${Date.now()}`,
          timestamp: Date.now(),
        } as Message;
        yield abortMsg;
        messages.push(...assistantMessages, abortMsg);

        return { reason: 'user_aborted' };
      }

      emitToUi({
        type: 'message',
        sessionId: params.sessionID,
        data: {
          role: 'system',
          content: `❌ **LLM API Error**\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nPlease check your API configuration in \`~/${CONFIG_DIR_NAME}/settings.json\`.`,
        } as MessageData,
      });

      const errorToolResults: Message[] = [];
      // 动态 import：RunTools 与 Query 在 QueryEngine 中均为动态引用，无循环依赖问题
      const { buildToolResultMessage } = await import('./tools/RunTools.js');
      for (const assistantMessage of assistantMessages) {
        if (assistantMessage.type !== 'assistant') continue;
        const content = assistantMessage.message.content as unknown[];
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if ((block as { type: string }).type !== 'tool_use') continue;
          const toolUse = block as { id: string; name: string };
          const toolResultMessage = buildToolResultMessage(
            toolUse.id,
            `Tool execution failed: ${errorMessage}`,
            -1,
            false,
            undefined,
            { is_error: true },
          );
          yield toolResultMessage;
          errorToolResults.push(toolResultMessage);
        }
      }

      messages.push(...assistantMessages, ...errorToolResults);

      return { reason: 'model_error' };
    }

    if (!needsFollowUp) {
      emitToUi({ type: 'aiEnd', sessionId: params.sessionID });
      messages.push(...assistantMessages);
      return { reason: 'completed' };
    }

    const toolResults: Message[] = [];
    let shouldPreventContinuation = false;

    const { runTools } = await import('./tools/RunTools.js');
    for await (const update of runTools(params.sessionID, toolUseBlocks, toolUseContext)) {
      if (update.message) {
        yield update.message;
        toolResults.push(update.message);
      }
      if (update.shouldPreventContinuation) {
        shouldPreventContinuation = true;
      }
    }

    if (shouldPreventContinuation) {
      sessionQueue.cancelQueued(params.sessionID);

      const completedToolIds = new Set<string>();
      for (const result of toolResults) {
        if (result.type === 'user' && Array.isArray(result.message.content)) {
          const toolResult = result.message.content.find(
            (block: any) => block.type === 'tool_result'
          );
          if (toolResult && (toolResult as any).tool_use_id) {
            completedToolIds.add((toolResult as any).tool_use_id);
          }
        }
      }

      const errorMessage = 'Command was interrupted';
      const { buildToolResultMessage } = await import('./tools/RunTools.js');
      for (const toolUse of toolUseBlocks as { id: string }[]) {
        if (completedToolIds.has(toolUse.id)) continue;
        const toolResultMessage = buildToolResultMessage(
          toolUse.id,
          errorMessage,
          -1,
          true,
        );
        yield toolResultMessage;
        toolResults.push(toolResultMessage);
      }

      // 静默中止（业务主动结束，如 spin 子代理首次 Reply 后停止自身）：
      // 已补齐所有 tool_result 后直接结束，不向 UI 回显中断消息。
      if (params.silentAbort?.()) {
        messages.push(...assistantMessages, ...toolResults);
        return { reason: 'user_aborted' };
      }

      const interruptedMessage: Message = {
        type: 'system',
        content: '*User Interrupted*',
        uuid: `system_${Date.now()}`,
        timestamp: Date.now(),
      };

      emitToUi({
        type: 'message',
        sessionId: params.sessionID,
        data: { role: 'system', content: interruptedMessage.content } as MessageData,
      });

      yield interruptedMessage;
      messages.push(...assistantMessages, ...toolResults, interruptedMessage);

      return { reason: 'user_aborted' };
    }

    const nextTurnCount = turnCount + 1;
    if (maxTurns && nextTurnCount > maxTurns) {
      emitToUi({ type: 'aiEnd', sessionId: params.sessionID });
      messages.push(...assistantMessages, ...toolResults);
      yield { type: 'attachment', attachment: { type: 'max_turns_reached' } } as Message;
      return { reason: 'max_turns' as const };
    }

    emitToUi({ type: 'aiEnd', sessionId: params.sessionID });

    const nextTracking: AutoCompactTrackingState = {
      consecutiveFailures: state.autoCompactTracking?.consecutiveFailures ?? 0,
      compacted: true,
      turnId: params.sessionID,
      turnCounter: nextTurnCount,
    };

    messages.push(...assistantMessages, ...toolResults);
    state = {
      messages,
      turnCount: nextTurnCount,
      autoCompactTracking: nextTracking,
    };
  }
}

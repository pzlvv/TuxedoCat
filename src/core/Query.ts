/**
 * query - 核心查询循环
 * 用户消息 → API 调用 → 工具执行 → 下一轮
 */

import type { Message } from './types.js';
import type { ToolUseContext } from './tools/Tool.js';
import type { LLMConfig } from './llm/config.js';
import type { AssistantUI } from './AssistantUI.js';
import type { Tool } from './tools/Tool.js';
import type { AutoCompactTrackingState } from './compact/types.js';
import { sessionQueue } from './SessionQueue.js';
import { logger } from './Logger.js';
import { replaceConversationMessages, updateConversationContext } from './history/index.js';
import { replayMessagesToUI } from './utils/replayMessages.js';
import { CONFIG_DIR_NAME } from '../config/project.js';

function cleanWebSearchUrl(url: string): string {
  return url.replace(/[#&?]ws_call_id=[^#&?]*/g, '').replace(/[?#]$/, '');
}

// 全局 AbortSignal 类型（兼容性）
type AbortSignal = {
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
  ui: AssistantUI
  /** 可用的工具名称列表，不指定则使用全部工具 */
  availableTools?: string[]
  /**
   * 动态获取当前 system prompt 和可用工具。
   * 每次 query 内部循环（工具调用后的下一轮 LLM 请求）都会重新获取，
   * 用于混合模式在首次 LLM 回复后从极简切换到普通。
   * 未提供时使用 staticSystemPrompt / availableTools 常量。
   */
  getPromptState?: () => Promise<{ systemPrompt: string; availableTools?: string[] }>
  /** LLM 配置覆盖，不指定则使用 settings.json 中的配置 */
  modelConfig?: LLMConfig
  /**
   * 动态获取当前 LLM 配置。
   * 每次 query 内部循环都会重新获取，用于混合模式在首次 LLM 回复后
   * 从极简（强制关闭 Web Search）切换为普通（恢复用户 Web Search 设置）。
   * 未提供时使用 modelConfig 常量。
   */
  getModelConfig?: () => LLMConfig | undefined
  /** 静默模式：不推送流式消息到 UI */
  silent?: boolean
}

// -- query loop state

// Mutable state carried between loop iterations
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  turnCount: number
  autoCompactTracking?: AutoCompactTrackingState
}

type Terminal = {
  reason: string
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
    ?? (async () => ({ systemPrompt: staticSystemPrompt, availableTools: params.availableTools }));
  const getModelConfig = params.getModelConfig ?? (() => params.modelConfig);

  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    turnCount: params.messages.filter(m => m.type === 'assistant').length,
  };

  while (true) {
    const { toolUseContext } = state;
    const { messages, turnCount } = state;

    {
      const { getSessionEngine } = await import('./QueryEngine.js');
      const engine = getSessionEngine(params.sessionID);
      if (engine) {
        engine.flushQueuedMessagesIntoContext();
      }
    }

    // Auto compact 检查
    {
      const { shouldAutoCompact, compactConversation, buildPostCompactMessages } = await import('./compact/index.js');

      const apiMessages = messages.filter((m) => m.type === 'assistant');
      let exactTokenCount: number | undefined;
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

      if (await shouldAutoCompact(messages, state.autoCompactTracking, exactTokenCount, params.modelConfig?.model)) {
        const result = await compactConversation(params.sessionID, messages, undefined, true);
        const postCompactMessages = buildPostCompactMessages(result);

        // 就地替换，保持与 QueryEngine.mutableMessages 同一引用。
        messages.length = 0;
        messages.push(...postCompactMessages);
        await replaceConversationMessages(params.sessionID, postCompactMessages);
        for (const msg of postCompactMessages) {
          (msg as any)._persisted = true;
        }
        {
          const { updateConversationContext } = await import('./history/Conversation.js');
          await updateConversationContext(params.sessionID, {
            isCompacted: true,
            isExpanded: false,
          }).catch((err: unknown) => {
            logger.warn('query', `Failed to update compact context: ${err}`);
          });
        }
        {
          const { getSessionEngine } = await import('./QueryEngine.js');
          const engine = getSessionEngine(params.sessionID);
          const lastMsg = postCompactMessages[postCompactMessages.length - 1];
          if (engine && lastMsg && 'uuid' in lastMsg && (lastMsg as any).uuid) {
            engine.lastPersistedMessageUuid = (lastMsg as any).uuid;
          }
        }

        replayMessagesToUI(params.ui, params.sessionID, postCompactMessages);
      }
    }

    yield { type: 'stream_request_start' } as Message;

    const assistantMessages: Message[] = [];
    const toolUseBlocks: unknown[] = [];
    let needsFollowUp = false;
    const activeWebSearchCalls = new Set<string>();

    params.ui?.onAIBegin(params.sessionID);

    try {
      const [{ callLLM }, { convertToolsToLlmFormat }, { getAllTools }] = await Promise.all([
        import('./llm/index.js'),
        import('./tools/toolSchema.js'),
        import('./tools/index.js'),
      ]);

      const rawApiMessages = messages
        .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
        .map((msg) => {
          const content = msg.message.content;

          // 处理 content 类型
          let formattedContent: string | unknown[];
          if (typeof content === 'string') {
            formattedContent = content;
          } else if (Array.isArray(content)) {
            // content 是数组，需要格式化
            formattedContent = content.map((block: unknown) => {
              if (typeof block === 'object' && block !== null) {
                const srcBlock = block as { type: string;[key: string]: unknown };
                // 过滤掉 tool_use block 中的顶层 _meta 和 _partialJson 字段
                // _meta: 仅用于 UI 历史恢复和统计，不应发给 LLM
                // _partialJson: SSE 流式解析用的内部累积字段，不应发给 LLM
                if ((srcBlock as any)._meta !== undefined || (srcBlock as any)._partialJson !== undefined) {
                  const { _meta, _partialJson, ...cleanBlock } = srcBlock;
                  void _meta;
                  void _partialJson;
                  return cleanBlock;
                }
                return srcBlock;
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

      // ===== 为所有 content 为数组但缺少 thinking block 的 assistant 消息补空 thinking =====
      // 原因：DeepSeek 代理要求当开启 thinking 模式时，历史 assistant 消息的 content 数组
      // 中必须包含 type=thinking 的 block。如果用户在执行工具过程中（如 sleep 5）将 thinking
      // 从 off 切换为 max，下一轮 LLM 请求带 thinking 模式时，历史消息中的 assistant 消息
      // 含有 tool_use 但没有 thinking block，会导致 API 报错：
      //   "The content[].thinking in the thinking mode must be passed back to the API."
      // 解决方案：不管当前是否开启 thinking，统一补一个空的 thinking block。
      // 这样即使中途切换 thinking 模式，历史消息也已满足要求，无需额外处理。
      for (const msg of rawApiMessages) {
        if (msg.role === 'assistant' && Array.isArray(msg.content)) {
          const hasThinking = (msg.content as any[]).some((b: any) => b.type === 'thinking');
          if (!hasThinking) {
            (msg.content as any[]).unshift({ type: 'thinking', thinking: '' });
          }
        }
      }

      // Merge consecutive messages with the same role.
      // Anthropic API requires strict user/assistant alternation: each
      // tool_use block must have a corresponding tool_result block in the
      // immediately following message. Without merging, multiple separate
      // user messages (each with one tool_result) violate this requirement.
      const apiMessages: Array<{ role: string; content: string | unknown[] }> = [];
      for (const msg of rawApiMessages) {
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

      if (apiMessages.length === 0) {
        throw new Error('No valid messages to send to API');
      }

      // 获取当前 system prompt 和工具列表。
      // 混合模式下首次 LLM 回复完成后，这里会拿到普通模式的 system prompt 和完整工具列表。
      const { systemPrompt: fullSystemPrompt, availableTools } = await getPromptState();

      const allTools = getAllTools();
      const filteredTools = availableTools
        ? allTools.filter(t => availableTools.includes(t.name))
        : allTools;
      const tools = await convertToolsToLlmFormat(filteredTools as unknown as typeof allTools & Tool[]);

      {

        let apiUserIdx = 0;
        for (const msg of messages) {
          if (msg.type !== 'user') continue;

          const fileMsg = msg as any;
          const apiMsg = apiMessages.filter((m: any) => m.role === 'user')[apiUserIdx];
          apiUserIdx++;

          if (!fileMsg.filePath || fileMsg.fileHidden || !apiMsg) continue;
          if (typeof apiMsg.content !== 'string' || apiMsg.content.startsWith('[Current File:')) continue;

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

          apiMsg.content = fileInfoText + '\n\n' + apiMsg.content;
        }
      }

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
      const newBlockStreamId = (): string =>
        `blk_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      // 辅助函数：判断是否为流式事件
      function isStreamEvent(val: any): val is import('./llm/RealApi.js').StreamEvent {
        return val && typeof val === 'object' && 'type' in val &&
          (val.type === 'thinking_delta' || val.type === 'text_delta' ||
            val.type === 'block_start' || val.type === 'block_stop' ||
            val.type === 'message_delta' ||
            val.type === 'web_search_call' || val.type === 'web_search_call_update' ||
            val.type === 'web_search_call_done');
      }

      for await (const event of callLLM({
        messages: apiMessages,
        systemPrompt: fullSystemPrompt,
        tools,
        signal: (toolUseContext.abortController as any).signal,
        onProgress(_msg) {
          // 可以在这里处理进度
        },
        thinkingEffort,
        modelConfig: getModelConfig(),
        sessionId: toolUseContext.sessionId as string,
      })) {
        // ---- 处理流式事件 (StreamEvent) ----
        if (isStreamEvent(event)) {
          if (event.type === 'thinking_delta') {
            streamedThinkingContent += event.thinking;
            // 逐 token 通知 UI 增量追加（使用当前 block 的 streamId）
            if (!params.silent) {
              params.ui?.onStreamMessage?.(params.sessionID, {
                role: 'thinking',
                delta: event.thinking,
                accumulated: streamedThinkingContent,
                streamId: currentThinkingStreamId ?? event.messageId,
              });
            }
          } else if (event.type === 'text_delta') {
            streamedTextContent += event.text;
            // 逐 token 通知 UI 增量追加（使用当前 block 的 streamId）
            if (!params.silent) {
              params.ui?.onStreamMessage?.(params.sessionID, {
                role: 'assistant',
                delta: event.text,
                accumulated: streamedTextContent,
                streamId: currentTextStreamId ?? event.messageId,
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
              params.ui?.onStreamEnd?.(params.sessionID, {
                role: 'thinking',
                accumulated: streamedThinkingContent,
                usage: undefined,
                streamId: currentThinkingStreamId ?? event.messageId,
              });
            } else if (currentBlockType === 'text' && streamedTextContent && !params.silent) {
              params.ui?.onStreamEnd?.(params.sessionID, {
                role: 'assistant',
                accumulated: streamedTextContent,
                usage: undefined,
                streamId: currentTextStreamId ?? event.messageId,
              });
            }
            currentBlockType = null;
          } else if (event.type === 'message_delta') {
            // 流接近结束，更新 usage
            if (event.usage) {
              // 服务端会话被 web search 结果污染已轮换（见 ResponsesApi / serverSession）：
              // 本轮的 usage.input_tokens 包含了搜索结果（虚高），不能用来更新上下文
              // 使用量和命中率——否则 compact 阈值判断与缓存命中率都会被污染。
              // 处理方式：本轮跳过上下文更新，streamEnd 不携带 usage（webview 不更新
              // contextLength / 命中率），下一轮从干净会话开始时由真实 usage 正常更新。
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
                  params.ui?.onStreamEnd?.(params.sessionID, {
                    role: 'thinking',
                    accumulated: streamedThinkingContent,
                    usage: streamEndUsage,
                    // 使用最后一个 thinking block 的 streamId，保证更新到对应消息
                    streamId: currentThinkingStreamId ?? event.messageId,
                  });
                }
              }
              if (streamedTextContent) {
                if (!params.silent) {
                  params.ui?.onStreamEnd?.(params.sessionID, {
                    role: 'assistant',
                    accumulated: streamedTextContent,
                    usage: streamEndUsage,
                    // 使用最后一个 text block 的 streamId，保证更新到对应消息
                    streamId: currentTextStreamId ?? event.messageId,
                  });
                }
              }
              // 纯 tool_use 场景：虽然没有 thinking/text 内容，但仍需传递 usage 更新 token 计数
              if (!streamedThinkingContent && !streamedTextContent && !params.silent) {
                params.ui?.onStreamEnd?.(params.sessionID, {
                  role: 'assistant',
                  accumulated: '',
                  usage: streamEndUsage,
                  streamId: event.messageId,
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
              params.ui?.onMessage(params.sessionID, {
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
              params.ui?.updateToolArgs?.(params.sessionID, `websearch_${event.callId}`, {
                action,
                queries,
                url,
              });
            }
          } else if (event.type === 'web_search_call_done') {
            if (!params.silent) {
              const toolCallId = `websearch_${event.callId}`;
              activeWebSearchCalls.delete(toolCallId);
              params.ui?.onToolResult?.(params.sessionID, toolCallId, 'WebSearch', '', 'success');
            }
          }
          continue;
        }

        // ---- 处理完整的 Message（流结束后的最终消息） ----
        if (event.type === 'assistant') {
          const content = event.message.content as unknown[];

          // ========== 从 LLM 响应中提取 token 用量 ==========
          const inputTokens = (event.message as any)?.usage?.input_tokens as number | undefined;
          const outputTokens = (event.message as any)?.usage?.output_tokens as number | undefined;
          const totalContextTokens = (inputTokens ?? 0) + (outputTokens ?? 0);

          /**
           * 数据流：LLM 返回 -> 持久化到 meta.json -> 发送到 webview 更新 UI
           *
           * 步骤 1: appendMessage() 将消息写入 .jsonl 文件，同时更新 .meta.json 中的：
           *   - messageCount（消息计数）
           *   - updatedAt（更新时间）
           *   - context.totalContextTokens（当前上下文总 token 数，用于恢复时显示进度条）
           *
           * 步骤 2: params.ui?.onMessage() 将消息和 token 数据发送到 webview
           *   - contextLength（input_tokens）：当前用于显示的输入 token 数
           *   - outputTokens：本次输出 token 数
           *   - webview 自行计算 totalTokens = contextLength + outputTokens 更新进度条
           */

          // 解析 content blocks 并识别 tool_use
          for (const block of content) {
            const blockType = (block as { type: string }).type;

            if (blockType === 'thinking') {
              // Thinking 已经通过流事件实时更新，此处只做 meta 更新
              if (totalContextTokens > 0) {
                await updateConversationContext(params.sessionID, { totalContextTokens }).catch((e: unknown) => logger.warn('query', 'Failed to update context for thinking:', e));
              }
            } else if (blockType === 'text') {
              // Text 已经通过流事件实时更新，此处只做 meta 更新
              if (totalContextTokens > 0) {
                await updateConversationContext(params.sessionID, { totalContextTokens }).catch((e: unknown) => logger.warn('query', 'Failed to update context for text:', e));
              }
            } else if (blockType === 'tool_use') {
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
              params.ui?.onStreamEnd?.(params.sessionID, {
                role: 'assistant',
                accumulated: String(persistedTextBlock.text || ''),
                usage: undefined,
                streamId: collapseStreamId,
              });
            }
          }

          yield event;
        }
      }
    } catch (error) {
      params.ui?.onAIEnd(params.sessionID);

      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('query', 'API call error:', errorMessage);

      const signal = toolUseContext.abortController?.signal as AbortSignal | null;
      const isAborted = signal?.aborted ||
        errorMessage.includes('aborted') ||
        errorMessage.includes('The operation was aborted') ||
        error instanceof Error && error.name === 'AbortError';

      for (const toolCallId of activeWebSearchCalls) {
        params.ui?.onToolResult?.(
          params.sessionID,
          toolCallId,
          'WebSearch',
          isAborted ? 'User Interrupted' : errorMessage,
          'error',
        );
      }
      activeWebSearchCalls.clear();

      if (isAborted) {
        sessionQueue.cancelQueued(params.sessionID);

        params.ui?.onMessage(params.sessionID, {
          role: 'system',
          content: '*User Interrupted*',
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

      params.ui?.onMessage(params.sessionID, {
        role: 'system',
        content: `❌ **LLM API Error**\n\n\`\`\`\n${errorMessage}\n\`\`\`\n\nPlease check your API configuration in \`~/${CONFIG_DIR_NAME}/settings.json\`.`,
      });

      const errorToolResults: Message[] = [];
      for (const assistantMessage of assistantMessages) {
        if (assistantMessage.type !== 'assistant') continue;
        const content = assistantMessage.message.content as unknown[];
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if ((block as { type: string }).type !== 'tool_use') continue;
          const toolUse = block as { id: string; name: string };
          const toolResultMessage: Message = {
            type: 'user',
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUse.id,
                  content: `Tool execution failed: ${errorMessage}`,
                  is_error: true,
                } as unknown,
              ],
            },
            uuid: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            timestamp: Date.now(),
          };
          yield toolResultMessage;
          errorToolResults.push(toolResultMessage);
        }
      }

      messages.push(...assistantMessages, ...errorToolResults);

      return { reason: 'model_error' };
    }

    if (!needsFollowUp) {
      params.ui?.onAIEnd(params.sessionID);
      messages.push(...assistantMessages);
      return { reason: 'completed' };
    }

    const toolResults: Message[] = [];
    let shouldPreventContinuation = false;

    const { runTools } = await import('./tools/RunTools.js');
    for await (const update of runTools(params.sessionID, toolUseBlocks, toolUseContext, params.ui)) {
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
      for (const toolUse of toolUseBlocks as { id: string }[]) {
        if (completedToolIds.has(toolUse.id)) continue;
        const toolResultMessage: Message = {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: errorMessage,
                exit_code: -1,
                is_canceled: true,
              } as unknown,
            ],
          },
          uuid: `tool_${Date.now()}_${Math.random()}`,
          timestamp: Date.now(),
        };
        yield toolResultMessage;
        toolResults.push(toolResultMessage);
      }

      const interruptedMessage: Message = {
        type: 'system',
        content: '*User Interrupted*',
        uuid: `system_${Date.now()}`,
        timestamp: Date.now(),
      };

      params.ui?.onMessage(params.sessionID, {
        role: 'system',
        content: interruptedMessage.content
      });

      yield interruptedMessage;
      messages.push(...assistantMessages, ...toolResults, interruptedMessage);

      return { reason: 'user_aborted' };
    }

    const nextTurnCount = turnCount + 1;
    if (maxTurns && nextTurnCount > maxTurns) {
      params.ui?.onAIEnd(params.sessionID);
      messages.push(...assistantMessages, ...toolResults);
      yield { type: 'attachment', attachment: { type: 'max_turns_reached' } } as Message;
      return { reason: 'max_turns' as const };
    }

    params.ui?.onAIEnd(params.sessionID);

    const nextTracking: AutoCompactTrackingState = {
      consecutiveFailures: state.autoCompactTracking?.consecutiveFailures ?? 0,
      compacted: true,
      turnId: params.sessionID,
      turnCounter: nextTurnCount,
    };

    messages.push(...assistantMessages, ...toolResults);
    state = {
      messages,
      toolUseContext,
      turnCount: nextTurnCount,
      autoCompactTracking: nextTracking,
    };
  }
}

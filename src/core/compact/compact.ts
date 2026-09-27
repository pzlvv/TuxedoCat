/**
 * Core compact conversation function
 */

import type { Message } from '../types.js';
import type { CompactionResult } from './types.js';
import { COMPACT_SYSTEM_PROMPT } from './types.js';

import { generateCompactSummaryPrompt, generateCompactUserMessage, generateCompactBoundaryContent, getUserInputHistory, selectUserInputHistory, formatUserInputHistory } from './prompt.js';
import { logger } from '../Logger.js';
import { requireEventBus, type CoreEvent } from '../AssistantEventBus.js';
import { updateConversationContext, saveCompactArchive, replaceConversationMessages } from '../history/Conversation.js';
import { replayMessagesToUI } from '../utils/replayMessages.js';
import { getConfig } from '../llm/config.js';
import { markCompacting, unmarkCompacting } from './state.js';
import { markSessionCompacting } from '../sessionRuntime.js';

/** core → UI 单向事件的发送侧封装（compact 模块统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/**
 * Compact conversation by summarizing and creating a boundary marker
 *
 * Flow:
 * 1. Get messages after last compact boundary
 * 2. Calculate pre-compact token count
 * 3. Generate summary via LLM call
 * 4. Create boundary marker
 * 5. Create summary message
 * 6. Keep recent important messages (last N messages)
 *
 * 注意：压缩期间会把会话标记为"正在压缩"（见 compact/state.ts），
 * 期间用户新发的消息只入队不消费，压缩结束后由 QueryEngine.resumeAfterCompact() 排空。
 *
 * @returns 压缩结果；当不满足压缩条件（边界之后的消息数 <= maxMessagesToKeep，没有可摘要
 *   的内容）时返回 null，表示"未做任何处理"。
 */
export async function compactConversation(
  sessionId: string,
  messages: Message[],
  customInstructions?: string,
  isAutoCompact: boolean = false,
  maxMessagesToKeep: number = 30
): Promise<CompactionResult | null> {
  // 不满足压缩条件：不做任何处理 —— 不标记"正在压缩"、不通知 UI、不替换消息。
  // 调用方（手动 / 自动压缩）据此直接返回，避免把会话压缩成只剩一条边界标记。
  if (!hasCompactableMessages(messages, maxMessagesToKeep)) {
    logger.info('compact', 'Not enough messages to compact, skipping (no-op)');
    return null;
  }

  // 整个压缩过程（含提前返回与异常）都持有"正在压缩"标记：
  // 压缩会整体替换 mutableMessages，期间不能并发消费排队消息。
  markCompacting(sessionId);
  // 同一事实同步给运行时状态：压缩算「会话在忙」（对话树 / 侧栏流水灯、托盘、空闲回收）。
  // 与 compact/state 的 markCompacting 是两件事：前者给 QueryEngine 判断能否并发消费，
  // 后者是跨层可见的运行时事实。
  markSessionCompacting(sessionId, true);
  try {
    return await compactConversationInner(
      sessionId,
      messages,
      customInstructions,
      isAutoCompact,
      maxMessagesToKeep,
    );
  } finally {
    unmarkCompacting(sessionId);
    markSessionCompacting(sessionId, false);
  }
}

/**
 * 判断会话是否有可压缩的消息。
 *
 * 压缩会保留最近 maxMessagesToKeep 条消息，只把更早的消息摘要掉；
 * 因此压缩边界之后的消息数必须严格大于 maxMessagesToKeep，否则没有可摘要的内容。
 */
export function hasCompactableMessages(messages: Message[], maxMessagesToKeep: number = 30): boolean {
  return getMessagesAfterCompactBoundary(messages).length > maxMessagesToKeep;
}

async function compactConversationInner(
  sessionId: string,
  messages: Message[],
  customInstructions?: string,
  isAutoCompact: boolean = false,
  maxMessagesToKeep: number = 30
): Promise<CompactionResult | null> {
  logger.info('compact', 'Starting compact conversation');

  // Notify UI: compact started
  emitToUi({ type: 'compactBegin', sessionId });

  // Step 1: Get messages after last compact boundary
  const messagesForCompact = getMessagesAfterCompactBoundary(messages);
  logger.info('compact', `Found ${messagesForCompact.length} messages after boundary`);

  // Step 2: Keep recent messages (last N messages for context)
  // 截断后必须修复 tool_use / tool_result 配对：
  // 按条数截断可能把某条 tool_use 留在归档区、而其 tool_result 落在保留区
  // （或相反），导致下一轮 LLM 请求出现孤立 tool_result / tool_use，被上游以
  // "No tool call found for tool output with call_id ..." 拒绝。
  const recentMessages = sanitizeToolPairing(
    messagesForCompact.slice(-maxMessagesToKeep).map(clearMessageUsage)
  );
  const messagesToSummarize = messagesForCompact.slice(0, -maxMessagesToKeep);

  if (messagesToSummarize.length === 0) {
    // 兜底：调用方已通过 hasCompactableMessages 提前拦截，正常不会走到这里。
    logger.warn('compact', 'No messages to summarize, compact not needed');
    return null;
  }

  // Step 3: Generate summary via LLM
  const [summary, summaryOutputTokens] = await generateSummary(messagesToSummarize, customInstructions, sessionId);
  logger.info('compact', `Generated summary (${summary.length} chars, output tokens: ${summaryOutputTokens})`);

  // 提取用户输入历史（过滤掉系统自动产生的 reminder / silent / 子代理消息等），
  // 追加为摘要消息中的一个章节，避免压缩后丢失用户真实的原始输入。
  // 但只保留首尾两端（最多 12 条：最早 4 条 + 最后 8 条），
  // 否则归档区的全部用户输入都塞进摘要会让摘要无限膨胀，更快再次触发压缩。
  const rawUserInputHistory = getUserInputHistory(messagesToSummarize);
  const selectedUserInputHistory = selectUserInputHistory(rawUserInputHistory);
  const userInputHistory = formatUserInputHistory(selectedUserInputHistory);
  if (userInputHistory) {
    logger.info('compact', `Collected user input history (${selectedUserInputHistory.length}/${rawUserInputHistory.length} messages, ${userInputHistory.length} chars)`);
  }

  // Step 4: Create boundary marker
  const lastMessage = messagesForCompact[messagesForCompact.length - 1];
  const lastMessageUuid = lastMessage && 'uuid' in lastMessage ? lastMessage.uuid : undefined;
  const trigger: 'auto' | 'manual' = isAutoCompact ? 'auto' : 'manual';
  const boundaryMarker = {
    type: 'system' as const,
    subtype: 'compact_boundary' as const,
    content: generateCompactBoundaryContent(
      trigger,
      0, // token count unavailable after removal of local estimation
      lastMessageUuid
    ),
    uuid: `compact_${Date.now()}`,
    timestamp: Date.now(),
    compactMetadata: {
      trigger,
      preCompactTokenCount: 0, // token count unavailable
      postCompactTokenCount: 0, // token count unavailable
      timestamp: Date.now(),
    },
  };

  // Step 5: Create summary message
  const summaryMessage = {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: generateCompactUserMessage(summary, undefined, userInputHistory),
    },
    uuid: `summary_${Date.now()}`,
    timestamp: Date.now(),
    isCompactSummary: true,
  };

  // Notify UI: compact complete with actual output tokens from summary generation
  emitToUi({
    type: 'compactEnd',
    sessionId,
    result: { status: 'complete', postCompactTokenCount: summaryOutputTokens },
  });

  // Update meta.json with the output tokens from summary generation
  // This ensures the UI can display the correct token usage after compact
  if (summaryOutputTokens > 0) {
    updateConversationContext(sessionId, {
      totalContextTokens: summaryOutputTokens,
    }).catch((err: unknown) => {
      logger.warn('compact', `Failed to update conversation context: ${err}`);
    });
  }

  logger.info('compact', `Compact complete (summary output tokens: ${summaryOutputTokens})`);

  // Save compacted messages to archive for future expand.
  // Only the compressed part (messagesToSummarize) + the new summary.
  // Retained recent messages are NOT included — they remain visible and will be
  // re-pushed together with the archive on expand.
  {
    const archiveData = [...messagesToSummarize, summaryMessage];
    const summaryCount = archiveData.filter(m => (m as any).isCompactSummary === true).length;
    logger.info('compact', `Saving archive: ${archiveData.length} messages (${summaryCount} summaries, ${messagesToSummarize.length} compacted) for session ${sessionId}`);
    try {
      await saveCompactArchive(sessionId, archiveData);
      logger.info('compact', `Archive saved successfully for session ${sessionId}`);
    } catch (err) {
      logger.warn('compact', `Failed to save compact archive: ${err}`);
    }
  }

  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    messagesToKeep: recentMessages.length > 0 ? recentMessages : undefined,
  };
}

/**
 * Get messages after the last compact boundary marker
 */
function getMessagesAfterCompactBoundary(messages: Message[]): Message[] {
  const lastBoundaryIndex = messages.reduce((lastIndex, msg, index) => {
    if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
      return index;
    }
    return lastIndex;
  }, -1);

  return lastBoundaryIndex >= 0
    ? messages.slice(lastBoundaryIndex + 1)
    : messages;
}

/**
 * Generate summary by calling the LLM
 * @returns [summary text, output token count]
 */
async function generateSummary(messages: Message[], customInstructions: string | undefined, sessionId: string): Promise<[string, number]> {
  const prompt = generateCompactSummaryPrompt(messages, customInstructions);

  try {
    const { callLLM } = await import('../llm/index.js');
    const { getSessionThinkingMode } = await import('../Integration.js');

    // 摘要生成沿用用户在会话中设置的 thinking effort；未设置或为 'off' 时回退到 'high'，
    // 保证压缩质量（'off' 会让摘要模型跳过思考，长上下文压缩效果明显变差）。
    const sessionThinkingEffort = getSessionThinkingMode(sessionId);
    const compactThinkingEffort: 'off' | 'low' | 'high' | 'max' =
      !sessionThinkingEffort || sessionThinkingEffort === 'off' ? 'high' : sessionThinkingEffort;

    let summary = '';
    let outputTokens = 0;

    for await (const message of callLLM({
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: COMPACT_SYSTEM_PROMPT,
      tools: [],
      signal: null,
      thinkingEffort: compactThinkingEffort,
      modelConfig: await getConfig(),
      sessionId,
    })) {
      if (message.type === 'assistant') {
        // 提取 output tokens
        const usage = (message.message as any)?.usage;
        if (usage?.output_tokens) {
          outputTokens = usage.output_tokens;
        }

        const content = message.message.content;
        if (typeof content === 'string') {
          summary += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === 'object' && block !== null) {
              const b = block as { type: string; text?: string };
              if (b.type === 'text' && b.text) {
                summary += b.text;
              }
            }
          }
        }
      }
    }

    return [summary.trim() || '', outputTokens];
  } catch (error) {
    logger.error('compact', 'Failed to generate summary:', error);
    return ['', 0];
  }
}

/**
 * Build post-compact messages array
 */
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep || []),
  ];
}

/**
 * 执行压缩并把结果应用回会话：就地替换 messages、落盘、更新 meta 上下文、通知 UI 重放。
 *
 * 三个调用点共用这段逻辑，避免"压缩结果应用"各写一份导致行为不一致：
 * - Integration.requestCompact（空闲时手动触发）
 * - Query.ts queryLoop（自动压缩 / 下一轮对话开始时执行延后的手动压缩）
 * - QueryEngine.finalizeIdle（最后一轮对话结束后补判延后的手动压缩）
 *
 * @returns 是否真正执行了压缩；false 表示不满足压缩条件（没有可摘要内容），未做任何处理。
 */
export async function compactAndApplyMessages(
  sessionId: string,
  messages: Message[],
  options: {
    /** 是否自动压缩（决定边界标记 trigger 文案）；默认 false（手动） */
    isAutoCompact?: boolean;
    /** 自定义摘要指令 */
    customInstructions?: string;
  } = {},
): Promise<boolean> {
  const result = await compactConversation(
    sessionId,
    messages,
    options.customInstructions,
    options.isAutoCompact ?? false,
  );
  // 不满足压缩条件：不做任何处理，保持上下文原样。
  if (!result) return false;

  const postCompactMessages = buildPostCompactMessages(result);

  // 就地替换，保持与 QueryEngine.mutableMessages 同一引用。
  messages.length = 0;
  messages.push(...postCompactMessages);

  // 持久化压缩后的消息到磁盘
  await replaceConversationMessages(sessionId, postCompactMessages);

  // 标记压缩产生的消息为已持久化：
  // boundaryMarker / summaryMessage 是 compactConversation 新建的对象，没有 _persisted 标记，
  // 若不标记，下一次 QueryEngine 的 persist-all 循环会把它们再次 appendMessage 到 JSONL 末尾，
  // 产生相同 uuid 的重复消息，导致 loadConversation 的 messageMap 覆盖根节点、整条消息链断开、
  // 对话加载后空白。
  for (const msg of postCompactMessages) {
    (msg as any)._persisted = true;
  }

  // 标记 meta 中的压缩状态
  await updateConversationContext(sessionId, {
    isCompacted: true,
    isExpanded: false,
  }).catch((err: unknown) => {
    logger.warn('compact', `Failed to update compact context: ${err}`);
  });

  // 通知 UI 压缩完成：清空旧消息并推送压缩后的内容
  replayMessagesToUI(sessionId, postCompactMessages);

  return true;
}

/**
 * Clear usage field from assistant messages to avoid stale token data after compaction
 */
function clearMessageUsage(msg: Message): Message {
  if (msg.type === 'assistant' && msg.message.usage !== undefined) {
    return {
      ...msg,
      message: {
        ...msg.message,
        usage: undefined,
      },
    };
  }
  return msg;
}

/**
 * 修复压缩截断导致的 tool_use / tool_result 配对断裂。
 *
 * 压缩按固定条数 slice(-maxMessagesToKeep) 截断时，可能把某条 tool_use 留在
 * 归档区、而其 tool_result 落在保留区（或相反），导致下一轮 LLM 请求中出现
 * 孤立 tool_result / tool_use，被上游以 "No tool call found for tool output
 * with call_id ..." 拒绝（400）。
 *
 * 处理策略：
 * 1. 保留区中孤立的 tool_result（其 tool_use 不在保留区）→ 直接删除该块；
 *    若整个 user 消息只剩孤儿 tool_result，则丢弃该消息。
 * 2. 保留区中孤立的 tool_use（其 tool_result 不在保留区，通常是压缩时工具
 *    仍在执行/被中断）→ 为其生成一条 is_canceled: true 的 tool_result，
 *    保证历史消息的 tool_use/tool_result 始终成对。
 */
function sanitizeToolPairing(messages: Message[]): Message[] {
  // 收集保留区中已存在的 tool_use id 与 tool_result id
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block !== null && (block as any).type === 'tool_use' && typeof (block as any).id === 'string') {
          toolUseIds.add((block as any).id as string);
        }
      }
    } else if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (typeof block === 'object' && block !== null && (block as any).type === 'tool_result' && typeof (block as any).tool_use_id === 'string') {
          toolResultIds.add((block as any).tool_use_id as string);
        }
      }
    }
  }

  const result: Message[] = [];

  for (const msg of messages) {
    // 1) 丢弃保留区中的孤立 tool_result
    if (msg.type === 'user' && Array.isArray(msg.message.content)) {
      const blocks = msg.message.content as Array<{ type?: string; tool_use_id?: string; [key: string]: unknown }>;
      const hasToolResult = blocks.some((b) => b.type === 'tool_result');
      if (hasToolResult) {
        const keptBlocks = blocks.filter((b) => b.type !== 'tool_result' || (b.tool_use_id !== undefined && toolUseIds.has(b.tool_use_id)));
        if (keptBlocks.length === 0) {
          // 整条消息只剩孤儿 tool_result，整条丢弃
          continue;
        }
        if (keptBlocks.length !== blocks.length) {
          result.push({
            ...msg,
            message: { ...msg.message, content: keptBlocks },
          } as Message);
          continue;
        }
      }
    }
    result.push(msg);

    // 2) 为保留区中缺少 tool_result 的 tool_use 生成 is_canceled 结果
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      const orphanToolUses = msg.message.content.filter((block) =>
        typeof block === 'object' && block !== null &&
        (block as any).type === 'tool_use' &&
        typeof (block as any).id === 'string' &&
        !toolResultIds.has((block as any).id as string)
      );
      if (orphanToolUses.length > 0) {
        const syntheticResult: Message = {
          type: 'user',
          message: {
            role: 'user',
            content: orphanToolUses.map((block) => ({
              type: 'tool_result',
              tool_use_id: (block as any).id,
              content: '[Compact interrupted] Tool execution was canceled during compaction.',
              is_canceled: true,
            })),
          },
          uuid: `tool_compact_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          timestamp: Date.now(),
        };
        result.push(syntheticResult);
        for (const block of orphanToolUses) {
          toolResultIds.add((block as any).id as string);
        }
      }
    }
  }

  return result;
}
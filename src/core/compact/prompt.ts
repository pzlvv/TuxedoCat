/**
 * Compact prompt templates
 */

import type { Message, UserInputHistoryEntry, UserMessage } from '../types.js';
import { isAutoMessage } from '../utils/messageOrigin.js';

/**
 * Format messages for compact summary generation
 */
export function formatMessagesForCompact(messages: Message[]): string {
  const formattedMessages: string[] = [];

  for (const message of messages) {
    if (message.type === 'user') {
      const content = typeof message.message.content === 'string'
        ? message.message.content
        : formatContentBlocks(message.message.content);

      formattedMessages.push(`[User]: ${content}`);
    } else if (message.type === 'assistant') {
      const content = formatAssistantContent(message.message.content);
      formattedMessages.push(`[Assistant]: ${content}`);
    } else if (message.type === 'system') {
      formattedMessages.push(`[System]: ${message.content}`);
    }
  }

  return formattedMessages.join('\n\n');
}

/**
 * Format content blocks for user messages
 */
function formatContentBlocks(content: unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type: string; text?: string; source?: { type: string; file_path?: string }; content?: string | unknown[] };
        if (b.type === 'text') return b.text || '';
        if (b.type === 'tool_result') {
          const resultContent = Array.isArray(b.content)
            ? b.content.map((part) => {
              if (typeof part === 'object' && part !== null) {
                const p = part as { type?: string; text?: string };
                if (p.type === 'text') return p.text || '';
                if (p.type === 'image') return '[Image]';
              }
              return String(part);
            }).filter(Boolean).join('\n')
            : (b.content || '');
          return `[Tool Result]: ${resultContent}`;
        }
        if (b.type === 'image') return '[Image]';
        if (b.source) {
          return b.source.file_path ? `[File: ${b.source.file_path}]` : '[Source]';
        }
        return JSON.stringify(block);
      }
      return String(block);
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Format assistant message content
 */
function formatAssistantContent(content: unknown[]): string {
  return content
    .map((block) => {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type: string; text?: string; thinking?: string; name?: string };
        if (b.type === 'text') return b.text || '';
        if (b.type === 'thinking') return `[Thinking]: ${b.thinking?.substring(0, 200)}...`;
        if (b.type === 'tool_use') return `[Tool: ${b.name}]`;
        return '';
      }
      return String(block);
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Extract plain text content from a user message.
 * Skips tool_result / image / source blocks that are not genuine user input.
 */
function extractUserContent(msg: UserMessage): string {
  const content = msg.message.content;
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type?: string; text?: string };
        // 只保留 text 块，跳过 tool_result、image 等系统产生的内容
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(b.text);
        }
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    return parts.join('\n');
  }

  return String(content ?? '');
}

/**
 * Check whether a text looks like a system-generated reminder.
 */
function isReminderText(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  // 匹配 <reminder> / <Reminder> / </reminder> 等标记
  return /<\/?reminder>/i.test(trimmed);
}

/**
 * Extract genuine user input messages from message history.
 *
 * 过滤掉由系统自动产生、并非用户真实输入的消息：
 * - silent 消息（reminder、子代理自动消息等，仅 LLM 可见）
 * - origin 为 agent / bash 的消息（子代理回复、后台 Bash 通知）
 * - isMeta 消息（如 Skill 注入的 prompt）
 * - isCompactSummary 消息（压缩摘要）
 * - 携带 reminder 字段的消息
 * - 内容形如 <reminder>/<Reminder> 的提醒消息
 * - 空内容消息
 */
export function getUserInputHistory(messages: Message[]): UserMessage[] {
  const history: UserMessage[] = [];

  for (const message of messages) {
    if (message.type !== 'user') continue;

    const msg = message as UserMessage & {
      silent?: boolean;
      isCompactSummary?: boolean;
      reminder?: string;
    };

    // 跳过系统自动产生的消息
    if (msg.silent === true) continue;
    // 子代理回复 / 后台 Bash 完成通知（兼容旧字段 fromSubAgent / fromBashTask）
    if (isAutoMessage(message)) continue;
    if (msg.isMeta === true) continue;
    if (msg.isCompactSummary === true) continue;
    if (msg.reminder !== undefined) continue;

    const content = extractUserContent(msg);
    if (!content.trim() || isReminderText(content)) continue;

    history.push(msg);
  }

  return history;
}

/** 摘要中「用户输入历史」章节最多保留的条数 */
export const USER_INPUT_HISTORY_MAX = 12;
/** 超限时保留的最早条数 */
export const USER_INPUT_HISTORY_HEAD = 4;
/** 超限时保留的最后条数（与 HEAD 相加不超过 MAX） */
export const USER_INPUT_HISTORY_TAIL = 8;

/**
 * 把用户输入消息提取成历史条目（纯文本 + 来源 uuid）。
 *
 * 只保留 `extractUserContent` 得到的文本块，跳过图片 / 工具结果等系统内容，
 * 避免把大块内容带进摘要；空内容条目直接丢弃。
 */
export function toUserInputEntries(messages: readonly UserMessage[]): UserInputHistoryEntry[] {
  const entries: UserInputHistoryEntry[] = [];
  for (const msg of messages) {
    const content = extractUserContent(msg).trim();
    if (!content) continue;
    entries.push({ uuid: msg.uuid, content });
  }
  return entries;
}

/**
 * 读取上一次压缩摘要持久化的用户输入历史（没有则返回空数组）。
 *
 * 取消息数组里最后一条 `isCompactSummary` 消息上的 `compactUserInputHistory`：
 * 压缩总是整体替换消息，所以同一时刻至多一条摘要消息。
 */
export function readCompactUserInputHistory(messages: readonly Message[]): UserInputHistoryEntry[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.type !== 'user' || msg.isCompactSummary !== true) continue;
    const history = (msg as UserMessage).compactUserInputHistory;
    if (Array.isArray(history)) return history;
  }
  return [];
}

/**
 * 组装摘要里的「用户输入历史」：把上次摘要持久化的历史与本次归档区里的真实用户输入
 * 按时间顺序合并去重，再取最早 HEAD 条 + 最后 TAIL 条（不超过 MAX 条时全留）。
 *
 * - `previous`：上次摘要持久化的历史（可能为空；已压缩掉的用户输入只剩这一份）。
 * - `regionInputs`：本次被摘要掉的归档区里的真实用户输入（保留区不参与）。
 *
 * 两次压缩之间没有重叠：`previous` 里的条目在上次压缩时已从消息里移除，不会出现在
 * 本次的 `regionInputs`；去重只是防御性兜底，防止旧数据或异常状态产生重复条目。
 */
export function selectUserInputHistory(
  previous: readonly UserInputHistoryEntry[],
  regionInputs: readonly UserInputHistoryEntry[],
  max: number = USER_INPUT_HISTORY_MAX,
  head: number = USER_INPUT_HISTORY_HEAD,
  tail: number = USER_INPUT_HISTORY_TAIL,
): UserInputHistoryEntry[] {
  const seen = new Set<string>();
  const merged: UserInputHistoryEntry[] = [];
  for (const entry of [...previous, ...regionInputs]) {
    if (seen.has(entry.uuid)) continue;
    seen.add(entry.uuid);
    merged.push(entry);
  }
  if (merged.length <= max) return merged;
  return [...merged.slice(0, head), ...merged.slice(-tail)];
}

/**
 * 把用户输入历史条目格式化成编号列表。
 */
export function formatUserInputEntries(entries: readonly UserInputHistoryEntry[]): string {
  const lines: string[] = [];
  let index = 0;
  for (const entry of entries) {
    const content = entry.content.trim();
    if (!content) continue;
    index += 1;
    lines.push(`${index}. ${content}`);
  }
  return lines.join('\n\n');
}

/**
 * 把用户输入消息格式化成编号列表（`formatUserInputEntries` 的便捷封装）。
 */
export function formatUserInputHistory(messages: readonly UserMessage[]): string {
  return formatUserInputEntries(toUserInputEntries(messages));
}

/**
 * Generate compact summary prompt
 */
export function generateCompactSummaryPrompt(
  messages: Message[],
  customInstructions?: string
): string {
  const formattedMessages = formatMessagesForCompact(messages);

  const basePrompt = `请总结以下对话的要点，创建一个简洁但全面的摘要。

对话内容：
${formattedMessages}

请按照以下格式生成摘要：

## 对话摘要

### 主要话题
[1-3句话概括主要讨论内容]

### 关键决策
- [列出做出的重要决定]
- [或者: 无]

### 重要信息
- [需要记住的重要信息，如文件路径、配置值等]
- [或者: 无]

### 未完成事项
- [如果有未完成的任务或需要继续的工作]
- [或者: 无]

### 后续建议
[1-2句话建议如何继续]`;

  if (customInstructions) {
    return `${basePrompt}

\n\n额外指示：${customInstructions}`;
  }

  return basePrompt;
}

/**
 * Generate post-compact user message content
 */
export function generateCompactUserMessage(
  summary: string,
  transcriptPath?: string,
  userInputHistory?: string
): string {
  let content = `以下是之前对话的摘要：\n\n${summary}`;

  if (transcriptPath) {
    content += `\n\n完整对话记录保存在: ${transcriptPath}`;
  }

  if (userInputHistory) {
    content += `\n\n### 用户输入历史\n\n${userInputHistory}`;
  }

  content += '\n\n---\n\n请基于以上摘要继续工作。如有需要，我可以提供更多细节。';

  return content;
}

/**
 * Generate compact boundary marker content
 */
export function generateCompactBoundaryContent(
  trigger: 'auto' | 'manual',
  preCompactTokenCount: number,
  lastMessageUuid?: string
): string {
  const triggerText = trigger === 'auto' ? 'Auto' : 'Manual';
  const date = new Date().toISOString();

  return `[${triggerText} compaction boundary] ${date} | ~${preCompactTokenCount} tokens before compaction${lastMessageUuid ? ` | last message: ${lastMessageUuid}` : ''}`;
}
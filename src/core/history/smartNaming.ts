/**
 * 智能命名：从对话最近消息生成标题。
 *
 * 生成入口是 host/coreFacts.ts 的 requestSmartNaming（按 CORE_KIND 分派：
 * Embedded 在宿主进程直调本模块；Standalone 由 core-rs 的 smart_naming 同构实现
 * 应答 UiRequest.smartNamingRequested）。
 */
import { extractLastJsonObject } from '../utils/lastJson.js';
import { surrogateSafeHeadEnd } from '../utils/stringUtils.js';

/** 取最近多少条用户/助手文本消息作为命名依据 */
const MAX_CONTENT_MESSAGES = 5;
/** 单条消息参与命名的最大字符数 */
const MAX_CONTENT_CHARS = 500;
/** 兜底标题（无任何可用内容时） */
const FALLBACK_TITLE = '智能命名';

/** 智能命名共用的 system prompt（示例 + 输出格式约束） */
export const SMART_NAMING_SYSTEM_PROMPT = '你是一个对话标题生成器。\n\n'
  + '示例1:\n对话内容：[用户]: 帮我写一个Python排序函数\n[助手]: 以下是冒泡排序实现...\n'
  + '输出：{"title": "Python排序函数"}\n\n'
  + '示例2:\n对话内容：[用户]: 今天天气怎么样\n[助手]: 今天北京晴转多云...\n'
  + '输出：{"title": "查询天气"}\n\n'
  + '现在请为以下对话生成标题（不超过20个字），只输出 JSON：';

/**
 * 从对话消息中取最近 MAX_CONTENT_MESSAGES 条用户/助手文本，
 * 组装成 `[用户]: ...` / `[助手]: ...` 的命名依据文本。
 */
export function collectSmartNamingContext(messages: readonly unknown[]): string[] {
  const contentMessages: string[] = [];
  for (const raw of messages) {
    const m = raw as {
      type?: string;
      message?: { content?: unknown };
    };
    if (m.type === 'user' && typeof m.message?.content === 'string') {
      contentMessages.push(
        `[用户]: ${m.message.content.substring(0, surrogateSafeHeadEnd(m.message.content, MAX_CONTENT_CHARS))}`,
      );
      if (contentMessages.length >= MAX_CONTENT_MESSAGES) break;
    } else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        const b = block as { type?: string; text?: string };
        if (b?.type === 'text' && b.text) {
          contentMessages.push(
            `[助手]: ${b.text.substring(0, surrogateSafeHeadEnd(b.text, MAX_CONTENT_CHARS))}`,
          );
          if (contentMessages.length >= MAX_CONTENT_MESSAGES) break;
        }
      }
      if (contentMessages.length >= MAX_CONTENT_MESSAGES) break;
    }
  }
  return contentMessages;
}

/**
 * 从 LLM 原始输出中解析标题。
 * 优先级：最后一个 JSON 对象的 title 字段 → `{ "title": "..." }` 正则 → 最后一行非空文本截断。
 */
export function parseSmartNamingTitle(rawResult: string): string {
  let title = '';
  const jsonStr = extractLastJsonObject(rawResult);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as { title?: unknown };
      title = (parsed.title as string) || '';
    } catch { /* ignore */ }
  }
  if (!title) {
    // 从任意 { "title": "..." } 模式中提取
    const tMatch = rawResult.match(/\{\s*"title"\s*:\s*"([^"]+)"\s*\}/);
    if (tMatch) {
      title = tMatch[1];
    } else {
      const lines = rawResult.split('\n').filter(l => l.trim());
      const lastLine = lines[lines.length - 1]?.trim() ?? '';
      // 截断按完整字符取：50 个 UTF-16 单元内不切开代理对（与 Rust utf16_take 同口径）
      title = lastLine.substring(0, surrogateSafeHeadEnd(lastLine, 50)) || FALLBACK_TITLE;
    }
  }
  return title;
}

/**
 * 生成对话标题：取最近消息 → 调用 LLM → 解析标题。
 * 只负责"生成"标题，不写回 meta.json、不推送 UI（由调用方决定后续动作）。
 *
 * @param sessionId 目标会话 ID（同时作为 LLM 调用的 session 上下文）
 * @param conversationMessages 对话全部消息（内部自行截取最近几条）
 * @returns 生成的标题
 */
export async function resolveSmartTitle(
  sessionId: string,
  conversationMessages: readonly unknown[],
): Promise<string> {
  const contentMessages = collectSmartNamingContext(conversationMessages);

  const { callLLM } = await import('../llm/index.js');
  const { getConfig } = await import('../llm/config.js');
  const modelConfig = await getConfig();

  let rawResult = '';
  for await (const event of callLLM({
    messages: [
      {
        role: 'user' as const,
        content: `${SMART_NAMING_SYSTEM_PROMPT}\n\n对话内容：\n${contentMessages.join('\n\n')}`,
      },
    ],
    tools: [],
    signal: null,
    modelConfig,
    sessionId,
  })) {
    if (event.type === 'text_delta') {
      rawResult += event.text;
    } else if (event.type === 'assistant') {
      const ct = event.message?.content;
      if (Array.isArray(ct)) {
        for (const block of ct) {
          const b = block as { type?: string; text?: string };
          if (b.type === 'text' && b.text) {
            rawResult = b.text;
          }
        }
      }
    }
  }

  return parseSmartNamingTitle(rawResult);
}

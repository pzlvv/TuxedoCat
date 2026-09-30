/**
 * SpinJudger - 判断子任务是否通过验收
 *
 * 使用主模型配置，调用 callLLM 直接发请求，不经过 QueryEngine 的 consumer 循环。
 */

import { logger } from '../Logger.js';

/** SpinJudger 单次判断结果 */
export interface SpinJudgerResult {
  accept: boolean;
  rawReply: string;
}

export class SpinJudger {
  /**
   * 判断子任务是否通过验收
   * @param task 子任务描述
   * @param criteria 验收标准列表
   * @param reply sub-agent 的执行反馈
   * @returns 判断结果
   */
  static async judge(
    task: string,
    criteria: string[],
    reply: string,
  ): Promise<SpinJudgerResult> {
    const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');

    const systemPrompt = `你是一个严格的任务验收评审员。你的任务是根据验收标准判断子任务是否通过。
只返回 JSON 格式：{"accept": true/false}
不允许包含其他说明文字。`;

    const userPrompt = `子任务"${task}"已完成，以下是执行反馈：

${reply}

验收标准：
${criteriaList}

请根据验收标准判断是否通过。只返回JSON格式：{"accept": true/false}`;

    const messages = [
      { role: 'user' as const, content: userPrompt },
    ];

    let rawReply = '';
    try {
      const { callLLM } = await import('../llm/index.js');
      for await (const event of callLLM({
        messages,
        systemPrompt,
        tools: [],
        signal: null,
        sessionId: 'spin-judger',
      })) {
        if (event.type === 'text_delta') {
          rawReply += event.text;
        } else if (event.type === 'assistant') {
          const content = event.message?.content;
          if (Array.isArray(content)) {
            for (const block of content as any[]) {
              if (block.type === 'text' && block.text) {
                rawReply = block.text;
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn('SpinJudger', `LLM judgment failed: ${err}, defaulting to false`);
      return { accept: false, rawReply: '(LLM call failed)' };
    }

    // 解析 JSON 结果
    const accept = parseAccept(rawReply);
    logger.info('SpinJudger', `Task "${task.substring(0, 40)}..." judged: ${accept}` +
      ` | rawReply="${rawReply.substring(0, 80)}"`);
    return { accept, rawReply };
  }
}

/**
 * 从 LLM 回复中解析 accept 布尔值
 */
export function parseAccept(text: string): boolean {
  const cleaned = text.trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.accept === 'boolean') {
      return parsed.accept;
    }
  } catch {
    // 尝试提取 JSON 块
    const jsonMatch = cleaned.match(/\{(?:[^{}]|"[^"]*")*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.accept === 'boolean') {
          return parsed.accept;
        }
      } catch {}
    }
    // fallback
    const txt = cleaned.replace(/[^a-zA-Z]/g, '').toLowerCase();
    if (txt === 'true') return true;
    if (txt === 'false') return false;
  }
  return false;
}

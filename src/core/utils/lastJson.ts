/**
 * lastJson.ts - 从 LLM 输出文本中提取最后一个完整 JSON 对象
 *
 * 智能命名等场景需要从模型输出（可能夹杂思考过程的花括号）中解析 JSON。
 * 这里从字符串末尾反向查找，只取最终输出的完整 JSON 对象。
 * 原实现分散在 VSCodeUI/webviewMessageHandler.ts 与 electron/main.ts 各一份，
 * 收敛到这里共享，避免两份拷贝将来行为漂移。
 */

/**
 * 从字符串中提取最后一个完整的 JSON 对象（须含 string 类型的 title 字段）。
 * 找不到时返回 null。
 */
export function extractLastJsonObject(text: string): string | null {
  let lastBrace = -1;
  let inString = false;
  let escape = false;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) {
      if (i > 0 && text[i - 1] === '\\') { i--; continue; }
      continue;
    }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString && ch === '{') { lastBrace = i; break; }
  }
  if (lastBrace < 0) return null;
  let depth = 0;
  inString = false;
  escape = false;
  for (let i = lastBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const jsonStr = text.substring(lastBrace, i + 1);
          try { const parsed = JSON.parse(jsonStr); if (parsed && typeof parsed.title === 'string') return jsonStr; } catch { }
          break;
        }
      }
    }
  }
  const remainingText = text.substring(0, lastBrace);
  if (remainingText.length > 0) return extractLastJsonObject(remainingText);
  return null;
}

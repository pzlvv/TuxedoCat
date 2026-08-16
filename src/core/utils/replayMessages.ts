import type { AssistantUI } from '../AssistantUI.js';
import type { Message } from '../types.js';

type ToolResultInfo = { content: string; exitCode: number };

export function buildToolResultMap(messages: readonly Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue;
    for (const block of msg.message.content) {
      const result = block as { type?: string; tool_use_id?: string; is_canceled?: boolean; content?: string; exit_code?: number };
      if (result.type === 'tool_result' && result.tool_use_id && result.is_canceled !== true) {
        map.set(result.tool_use_id, {
          content: result.content || '',
          exitCode: result.exit_code ?? 0,
        });
      }
    }
  }
  return map;
}

/**
 * 将历史消息重新推送到 UI（压缩后重建 / 展开归档共用）。
 */
export function replayMessagesToUI(ui: AssistantUI, sessionId: string, messages: readonly Message[]): void {
  ui.clearMessages(sessionId);
  const toolResultMap = buildToolResultMap(messages);

  for (const msg of messages) {
    const meta = msg as Message & { isMeta?: boolean; silent?: boolean; subtype?: string; filePath?: string; fileSelectedLines?: { start: number; end: number }; isCompactSummary?: boolean; fromSubAgent?: boolean; _meta?: Record<string, unknown> };
    if (meta.isMeta || meta.silent) continue;

    if (msg.type === 'system') {
      if (meta.subtype === 'compact_boundary') continue;
      ui.onMessage(sessionId, { role: 'system', content: msg.content });
      continue;
    }

    if (msg.type === 'user') {
      const content = typeof msg.message.content === 'string' ? msg.message.content : undefined;
      if (content === undefined) continue;
      ui.onMessage(sessionId, {
        role: 'user',
        content,
        filePath: meta.filePath,
        fileSelectedLines: meta.fileSelectedLines,
        isCompactSummary: meta.isCompactSummary === true,
        isFromAgent: meta.fromSubAgent === true,
        meta: meta._meta,
      });
      continue;
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown> };
        if (b.type === 'thinking') {
          ui.onMessage(sessionId, { role: 'thinking', content: b.thinking || '' });
        } else if (b.type === 'text') {
          ui.onMessage(sessionId, { role: 'assistant', content: b.text || '' });
        } else if (b.type === 'tool_use') {
          const toolUseId = b.id || '';
          const result = toolResultMap.get(toolUseId);
          ui.onMessage(sessionId, {
            role: 'toolcall',
            content: result?.content || '',
            param: `⚙️ ${b.name || 'tool'}`,
            toolName: b.name,
            toolArgs: b.input,
            toolCallId: toolUseId,
            status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
          });
        }
      }
    }
  }
}

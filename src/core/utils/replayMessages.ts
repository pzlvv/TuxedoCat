import type { AssistantUI } from '../AssistantUI.js';
import type { Message } from '../types.js';
import { extractUserContent } from './contentBlocks.js';
import { buildEditDiffHunks } from './editDiff.js';

type ToolResultInfo = { content: string; exitCode: number };

export function buildToolResultMap(messages: readonly Message[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue;
    for (const block of msg.message.content) {
      const result = block as { type?: string; tool_use_id?: string; is_canceled?: boolean; content?: string | unknown[]; exit_code?: number };
      if (result.type === 'tool_result' && result.tool_use_id && result.is_canceled !== true) {
        map.set(result.tool_use_id, {
          content: Array.isArray(result.content) ? '[Image]' : (result.content || ''),
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
    const meta = msg as Message & { isMeta?: boolean; silent?: boolean; subtype?: string; filePath?: string; fileSelectedLines?: { start: number; end: number }; fileHidden?: boolean; isCompactSummary?: boolean; fromSubAgent?: boolean; _meta?: Record<string, unknown> };
    if (meta.isMeta || meta.silent) continue;

    if (msg.type === 'system') {
      if (meta.subtype === 'compact_boundary') continue;
      ui.onMessage(sessionId, { role: 'system', content: msg.content });
      continue;
    }

    if (msg.type === 'user') {
      const { text, images } = extractUserContent(msg.message.content);
      if (!text && images.length === 0) continue;

      // 与历史加载逻辑一致：发送时用户主动隐藏的文件标签，重放时也不能显示。
      // 文件信息可能落在顶层 filePath/fileSelectedLines，也可能在 _meta 中，统一兼容。
      const rawFilePath = meta.filePath || (meta._meta?.filePath as string | undefined);
      const rawFileSelectedLines = meta.fileSelectedLines || (meta._meta?.fileSelectedLines as { start: number; end: number } | undefined);
      const wasFileHidden = meta.fileHidden === true;
      const showFileInfo = !wasFileHidden && !!rawFilePath;

      const replayMeta = meta._meta ? { ...meta._meta } : undefined;
      if (replayMeta) {
        if (showFileInfo) {
          replayMeta.filePath = rawFilePath;
          if (rawFileSelectedLines) {
            replayMeta.fileSelectedLines = rawFileSelectedLines;
          }
        } else {
          delete replayMeta.filePath;
          delete replayMeta.fileSelectedLines;
          // 子代理 from/to 的 param 仍用于跳转/来源展示
          if (!meta.fromSubAgent) {
            delete replayMeta.param;
          }
        }
      }

      ui.onMessage(sessionId, {
        role: 'user',
        content: text,
        images: images.length > 0 ? images : undefined,
        filePath: showFileInfo ? rawFilePath : undefined,
        fileSelectedLines: showFileInfo ? rawFileSelectedLines : undefined,
        isCompactSummary: meta.isCompactSummary === true,
        isFromAgent: meta.fromSubAgent === true,
        meta: replayMeta,
      });
      continue;
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown>; _meta?: Record<string, unknown> };
        if (b.type === 'thinking') {
          ui.onMessage(sessionId, { role: 'thinking', content: b.thinking || '' });
        } else if (b.type === 'text') {
          ui.onMessage(sessionId, { role: 'assistant', content: b.text || '' });
        } else if (b.type === 'tool_use') {
          const toolUseId = b.id || '';
          const result = toolResultMap.get(toolUseId);
          const toolArgs: Record<string, unknown> = b.input ? { ...b.input } : {};
          const blockMeta = b._meta;

          if (b.name === 'Edit' && typeof blockMeta?.beforeContent === 'string' && typeof blockMeta?.afterContent === 'string') {
            // Edit 只发送 diff 相关行
            toolArgs.diffHunks = buildEditDiffHunks({
              beforeContent: blockMeta.beforeContent,
              afterContent: blockMeta.afterContent,
              startLine: blockMeta.startLine as number | undefined,
              endLine: blockMeta.endLine as number | undefined,
              replaceAll: Boolean(b.input?.replace_all),
            });
          } else if (blockMeta?.beforeContent !== undefined || blockMeta?.afterContent !== undefined) {
            // Write 等工具保留原有 before/after 字段
            toolArgs.beforeContent = blockMeta.beforeContent;
            toolArgs.afterContent = blockMeta.afterContent;
          }

          ui.onMessage(sessionId, {
            role: 'toolcall',
            content: result?.content || '',
            param: `⚙️ ${b.name || 'tool'}`,
            toolName: b.name,
            toolArgs,
            toolCallId: toolUseId,
            status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
          });
        }
      }
    }
  }
}

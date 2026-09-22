import type { Message, MessageData } from '../types.js';
import type { CoreEvent } from '../AssistantEventBus.js';
import { requireEventBus } from '../AssistantEventBus.js';
import { extractUserContent } from './contentBlocks.js';
import { buildEditDiffHunks } from './editDiff.js';

/** core → UI 单向事件的发送侧封装（replayMessages 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

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
 * 把持久化格式的历史消息转换成 UI 显示用的 `MessageData[]`（纯函数）。
 *
 * 这是「历史消息 → 显示消息」的**唯一转换点**：core 的压缩后重建与宿主的展开归档
 * 都调它，不再各写一份裁剪逻辑（`_meta` 裁剪、Edit `diffHunks` 构建都在这里）。
 */
export function buildReplayMessageData(messages: readonly Message[]): MessageData[] {
  const out: MessageData[] = [];
  const toolResultMap = buildToolResultMap(messages);

  for (const msg of messages) {
    const meta = msg as Message & { isMeta?: boolean; silent?: boolean; subtype?: string; filePath?: string; fileSelectedLines?: { start: number; end: number }; fileHidden?: boolean; isCompactSummary?: boolean; fromSubAgent?: boolean; fromBashTask?: boolean; _meta?: Record<string, unknown> };
    if (meta.isMeta || meta.silent) continue;

    if (msg.type === 'system') {
      if (meta.subtype === 'compact_boundary') continue;
      out.push({ role: 'system', content: msg.content } as MessageData);
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

      out.push({
        role: 'user',
        content: text,
        images: images.length > 0 ? images : undefined,
        filePath: showFileInfo ? rawFilePath : undefined,
        fileSelectedLines: showFileInfo ? rawFileSelectedLines : undefined,
        isCompactSummary: meta.isCompactSummary === true,
        isFromAgent: meta.fromSubAgent === true,
        // 后台任务通知：与 From 消息一样属于系统自动消息（不参与滚动置顶）
        fromBashTask: meta.fromBashTask === true,
        meta: replayMeta,
      } as MessageData);
      continue;
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        const b = block as { type?: string; text?: string; thinking?: string; name?: string; id?: string; input?: Record<string, unknown>; _meta?: Record<string, unknown> };
        if (b.type === 'thinking') {
          out.push({ role: 'thinking', content: b.thinking || '' } as MessageData);
        } else if (b.type === 'text') {
          out.push({ role: 'assistant', content: b.text || '' } as MessageData);
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

          out.push({
            role: 'toolcall',
            content: result?.content || '',
            param: `⚙️ ${b.name || 'tool'}`,
            toolName: b.name,
            toolArgs,
            toolCallId: toolUseId,
            status: result ? (result.exitCode !== 0 ? 'fail' : 'success') : 'running',
          } as MessageData);
        }
      }
    }
  }

  return out;
}

/**
 * 将历史消息整批替换到 UI（压缩后重建 / 展开归档共用）。
 *
 * 只发一条 `messagesReplaced`，不再「先发 clearMessages 再逐条补 message」——
 * 两步动作会让 UI 中间态（列表空着）暴露，也让「替换」这件事在事件流里看不出边界。
 */
export function replayMessagesToUI(sessionId: string, messages: readonly Message[]): void {
  emitToUi({ type: 'messagesReplaced', sessionId, messages: buildReplayMessageData(messages) });
}

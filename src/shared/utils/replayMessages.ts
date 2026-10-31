import type { Message, MessageData } from '../types.js';
import type { CoreEvent } from '../AssistantEventBus.js';
import { requireEventBus } from '../AssistantEventBus.js';
import { extractUserContent } from './contentBlocks.js';
import { buildEditDiffHunks } from './editDiff.js';
import { getMessageOrigin } from './messageOrigin.js';

/** core → UI 单向事件的发送侧封装（replayMessages 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/**
 * tool_result 里除文本输出外、只服务 diff 展示的字段。
 *
 * Edit / Write 的 beforeContent / afterContent 会随工具结果一起落盘（见
 * `mapToolResultToToolResultBlockParam`）。它们不在 tool_use 的 `_meta` 里时
 * （例如压缩时内存里的 `_meta` 未同步、或旧版本会话），仍可从 tool_result 读回，
 * 避免压缩 / 展开归档后 Edit 预览丢失。
 */
type ToolResultDiffFields = {
  beforeContent?: string | null;
  afterContent?: string;
  contextBefore?: string[];
  contextAfter?: string[];
  startLine?: number;
  endLine?: number;
};

type ToolResultInfo = { content: string; exitCode: number } & ToolResultDiffFields;

/**
 * 建 `tool_use_id → 结果` 表（同 id 后写覆盖先写）。
 *
 * 被取消（`is_canceled: true`）的结果单独登记成 `canceledToolResults`，而不是混进
 * 结果表：取消不是「执行成功 / 失败」，它的 `exit_code` 通常是 -1 / 130 这类哨兵值，
 * 按它算出来的状态与「工具报错」混在一起。调用方据此把对应 `tool_use` 落成
 * `status: 'fail'`——与 `conversationLoaded` 那条恢复路径（webview 的
 * `restoreMessagesFromConversation`）同口径，否则同一条历史会因为走的是哪条恢复
 * 通道而显示成两种卡片状态（specs/defects/replay-drops-canceled-tool-results.md）。
 */
export function buildToolResultMaps(messages: readonly Message[]): {
  results: Map<string, ToolResultInfo>;
  canceled: Map<string, string>;
} {
  const results = new Map<string, ToolResultInfo>();
  const canceled = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue;
    for (const block of msg.message.content) {
      const result = block as {
        type?: string; tool_use_id?: string; is_canceled?: boolean; content?: string | unknown[]; exit_code?: number;
        beforeContent?: string | null; afterContent?: string;
        contextBefore?: string[]; contextAfter?: string[];
        startLine?: number; endLine?: number;
      };
      if (result.type !== 'tool_result' || !result.tool_use_id) continue;
      if (result.is_canceled === true) {
        // 取消说明文本即卡片内容（core 写入的「中止原因」）；没有文本时留空串
        canceled.set(result.tool_use_id, Array.isArray(result.content) ? '' : (result.content || ''));
        continue;
      }
      results.set(result.tool_use_id, {
        content: Array.isArray(result.content) ? '[Image]' : (result.content || ''),
        exitCode: result.exit_code ?? 0,
        beforeContent: result.beforeContent,
        afterContent: result.afterContent,
        contextBefore: result.contextBefore,
        contextAfter: result.contextAfter,
        startLine: result.startLine,
        endLine: result.endLine,
      });
    }
  }
  return { results, canceled };
}

/** 未被取消的工具结果（`tool_use_id → 结果`）；取消结果见 `buildToolResultMaps` */
export function buildToolResultMap(messages: readonly Message[]): Map<string, ToolResultInfo> {
  return buildToolResultMaps(messages).results;
}

/**
 * 把持久化格式的历史消息转换成 UI 显示用的 `MessageData[]`（纯函数）。
 *
 * 这是「历史消息 → 显示消息」的**唯一转换点**：core 的压缩后重建与宿主的展开归档
 * 都调它，不再各写一份裁剪逻辑（`_meta` 裁剪、Edit `diffHunks` 构建都在这里）。
 */
export function buildReplayMessageData(messages: readonly Message[]): MessageData[] {
  const out: MessageData[] = [];
  const { results: toolResultMap, canceled: canceledToolResults } = buildToolResultMaps(messages);

  for (const msg of messages) {
    const meta = msg as Message & { isMeta?: boolean; silent?: boolean; subtype?: string; filePath?: string; fileSelectedLines?: { start: number; end: number }; fileHidden?: boolean; isCompactSummary?: boolean; _meta?: Record<string, unknown> };
    const origin = getMessageOrigin(meta);
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
          if (origin !== 'agent') {
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
        // 消息来源：agent（子代理）/ bash（后台任务通知）；用户消息为 undefined
        origin,
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

          // diff 内容优先取 tool_use 的 `_meta`（新版本写入），缺失时回退到
          // tool_result 的 before/after（压缩时 `_meta` 未同步到内存 / 旧版本会话）。
          const metaBefore = typeof blockMeta?.beforeContent === 'string' ? blockMeta.beforeContent : undefined;
          const metaAfter = typeof blockMeta?.afterContent === 'string' ? blockMeta.afterContent : undefined;
          const resultBefore = typeof result?.beforeContent === 'string' ? result.beforeContent : undefined;
          const resultAfter = typeof result?.afterContent === 'string' ? result.afterContent : undefined;
          const beforeContent = metaBefore ?? resultBefore;
          const afterContent = metaAfter ?? resultAfter;
          const startLine = (blockMeta?.startLine as number | undefined) ?? result?.startLine;
          const endLine = (blockMeta?.endLine as number | undefined) ?? result?.endLine;
          const contextBefore = (blockMeta?.contextBefore as string[] | undefined) ?? result?.contextBefore;
          const contextAfter = (blockMeta?.contextAfter as string[] | undefined) ?? result?.contextAfter;

          if (b.name === 'Edit' && typeof beforeContent === 'string' && typeof afterContent === 'string') {
            // Edit 只发送 diff 相关行
            const diffHunks = buildEditDiffHunks({
              beforeContent,
              afterContent,
              startLine,
              endLine,
              replaceAll: Boolean(b.input?.replace_all),
            });
            toolArgs.diffHunks = diffHunks;
            toolArgs.contextBefore = contextBefore || [];
            toolArgs.contextAfter = contextAfter || [];
            toolArgs.startLine = startLine;
            toolArgs.endLine = endLine;
            if (diffHunks.length === 0) {
              // 紧凑 diff 为空（内容为空 / 无实际改动）时退回完整 before/after，
              // 让 EditFile 自行计算；两者都为空才按需向宿主拉取 `_meta`。
              toolArgs.beforeContent = beforeContent;
              toolArgs.afterContent = afterContent;
              if (!beforeContent && !afterContent) {
                toolArgs._needsMeta = true;
                toolArgs._toolUseId = toolUseId;
              }
            }
          } else if (b.name === 'Edit') {
            // 没有任何 diff 数据：让 webview 按需向宿主拉取 `_meta`
            // （压缩后重建 / 展开归档都会走这条路径，避免 Edit 预览丢失）
            toolArgs._needsMeta = true;
            toolArgs._toolUseId = toolUseId;
          } else if (blockMeta?.beforeContent !== undefined || blockMeta?.afterContent !== undefined || result?.beforeContent !== undefined || result?.afterContent !== undefined) {
            // Write 等工具保留原有 before/after 字段
            toolArgs.beforeContent = blockMeta?.beforeContent ?? result?.beforeContent;
            toolArgs.afterContent = blockMeta?.afterContent ?? result?.afterContent;
          }

          // 被取消的工具：渲染为失败态，内容是那条取消说明（与 conversationLoaded 的
          // restoreMessagesFromConversation 同口径）。不能落成 running——那会让卡片
          // 时间线画旋转风扇、自动滚动轮询按 hasRunningTools 一直空转。
          const canceledContent = canceledToolResults.get(toolUseId);
          out.push({
            role: 'toolcall',
            content: canceledContent !== undefined ? canceledContent : (result?.content || ''),
            param: `⚙️ ${b.name || 'tool'}`,
            toolName: b.name,
            toolArgs,
            toolCallId: toolUseId,
            status: canceledContent !== undefined
              ? 'fail'
              : result
                ? (result.exitCode !== 0 ? 'fail' : 'success')
                : 'running',
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

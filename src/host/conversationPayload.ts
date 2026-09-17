/**
 * 构建 conversationLoaded 消息的共享逻辑。
 *
 * 两个宿主实现各自的 postConversationLoaded 原为约 60 行近乎逐字的重复：
 * JSON 深拷贝、isMeta/silent 过滤、
 * tool_use _meta 裁剪（beforeContent/afterContent 摘出，避免整文件内容发给 webview）、
 * Edit diffHunks 构建、消息组装。
 *
 * 宿主差异通过 extraFields 注入（如 WebViewUI 传入的 activityPhase）。
 */
import { buildEditDiffHunks } from '../core/utils/editDiff.js';

/** conversationLoaded 消息中除核心字段外的宿主专属字段 */
export type ConversationLoadedExtraFields = Record<string, unknown>;

export interface ConversationLoadedExtra {
  pendingToolUseIds: string[];
  savedContext?: any;
  parentSessionId?: string;
  agentMode: string;
  hasActiveQuery: boolean;
  hasCompactArchive?: boolean;
  model?: string;
}

/**
 * 深拷贝 conversation 并做 webview 传输前的裁剪：
 * - 过滤 isMeta / silent 消息
 * - tool_use 的 _meta 摘出 beforeContent/afterContent（_metaTrimmed / _toolUseId 标记）
 * - Edit 工具只发送 diff 相关行（diffHunks），其余工具保留 before/after 字段
 *
 * @returns { conversation: 裁剪后的会话对象, toolMetaMap: 工具 ID -> diff/before-after 元数据 }
 */
export function trimConversationForWebview(conversation: any): {
  conversation: any;
  toolMetaMap: Record<string, any>;
} {
  const trimmed = JSON.parse(JSON.stringify(conversation));
  const toolMetaMap: Record<string, any> = {};

  if (trimmed.messages) {
    // 过滤掉 isMeta/silent 消息（如 Skill 注入的 prompt），不在 UI 显示
    trimmed.messages = trimmed.messages.filter(
      (msg: any) => !msg.isMeta && !msg.silent
    );

    for (const msg of trimmed.messages) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && block._meta) {
            block._metaTrimmed = true;
            block._toolUseId = block.id;
            const rawMeta = block._meta as Record<string, unknown>;
            const { beforeContent, afterContent, ...smallFields } = rawMeta;
            block._meta = smallFields;

            if (block.name === 'Edit' && typeof beforeContent === 'string' && typeof afterContent === 'string') {
              // Edit 只发送 diff 相关行，避免把整个文件内容发给 webview
              toolMetaMap[block.id!] = {
                diffHunks: buildEditDiffHunks({
                  beforeContent,
                  afterContent,
                  startLine: rawMeta.startLine as number | undefined,
                  endLine: rawMeta.endLine as number | undefined,
                  replaceAll: Boolean((block.input as any)?.replace_all),
                }),
              };
            } else {
              // Write 等工具仍保留原有 beforeContent/afterContent 字段
              toolMetaMap[block.id!] = { beforeContent, afterContent };
            }
          }
        }
      }
    }
  }

  return { conversation: trimmed, toolMetaMap };
}

/**
 * 构建 conversationLoaded 消息体（不发送，由宿主选择通道投递）。
 *
 * @param sessionId 目标会话
 * @param conversation 磁盘/内存中的会话对象（函数内部深拷贝，不修改原对象）
 * @param extra WebviewMessageHandler 传入的额外信息
 * @param extraFields 附加字段（如 WebViewUI 的 activityPhase）
 */
export function buildConversationLoadedPayload(
  sessionId: string,
  conversation: any,
  extra: ConversationLoadedExtra,
  extraFields?: ConversationLoadedExtraFields,
): Record<string, unknown> {
  const { conversation: trimmed, toolMetaMap } = trimConversationForWebview(conversation);

  return {
    type: 'conversationLoaded',
    conversation: trimmed,
    pendingToolUseIds: extra.pendingToolUseIds,
    savedContext: extra.savedContext,
    parentSessionId: extra.parentSessionId,
    agentMode: extra.agentMode,
    hasActiveQuery: extra.hasActiveQuery,
    sessionId,
    hasCompactArchive: extra.hasCompactArchive === true,
    toolMetaMap: Object.keys(toolMetaMap).length > 0 ? toolMetaMap : undefined,
    model: extra.model || trimmed.metadata?.model ||
      (trimmed.metadata?.context?.model) ||
      undefined,
    ...extraFields,
  };
}

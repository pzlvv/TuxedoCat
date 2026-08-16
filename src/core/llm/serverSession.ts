/**
 * 服务端会话（x-session-id）管理
 *
 * 背景：Responses API 服务商（如 opencode.ai/zen/go）通过请求头 x-session-id
 * 维护服务端会话状态，内置 web_search 工具会把搜索结果写入该会话。由于客户端
 * 每次都携带完整 input（不依赖服务端会话保存对话），服务端会话里跨轮累积的
 * 搜索结果只会让后续请求的 input_tokens 虚高——实测一轮 4 次搜索后上下文从
 * ~180K 膨胀到 ~750K，其中大部分是搜索结果（cache_read 也随之一并膨胀）。
 *
 * 搜索结果只需在当轮对模型可见，不需要跨轮保留。因此当检测到服务端会话被
 * 搜索结果污染（web search 注入量过大）或体积超过上限时，标记"下一轮轮换"，
 * 使后续请求使用全新的服务端会话 ID，让上下文从干净状态重新开始。
 *
 * 注意：会话 ID 只影响服务端缓存/会话，不影响对话内容——客户端始终发送完整
 * input，轮换后对话上下文（历史消息）不丢失，仅损失一次服务端缓存命中。
 */

import { logger } from '../Logger.js';

interface ServerSessionEntry {
  /** 当前使用的服务端会话 ID（x-session-id 值） */
  id: string;
  /** 下一轮请求需要轮换（上一轮检测到污染） */
  rotateNext: boolean;
}

const serverSessions = new Map<string, ServerSessionEntry>();

/**
 * 获取当前服务端会话 ID。
 * 若上一轮标记了轮换（rotateNext），则生成一个新的会话 ID 并返回，
 * 使本轮请求从干净的服务端会话开始。
 */
export function getServerSessionId(conversationSessionId: string): string {
  const entry = serverSessions.get(conversationSessionId);
  if (!entry) return conversationSessionId;
  if (entry.rotateNext) {
    entry.rotateNext = false;
    entry.id = `${conversationSessionId}_srv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    logger.info('serverSession', `Rotated server session for ${conversationSessionId}: ${entry.id}`);
  }
  return entry.id;
}

/**
 * 标记服务端会话需要在下一轮轮换（web search 污染 / input_tokens 超上限）。
 */
export function markServerSessionRotate(conversationSessionId: string, reason: string): void {
  const entry = serverSessions.get(conversationSessionId);
  serverSessions.set(conversationSessionId, {
    id: entry?.id ?? conversationSessionId,
    rotateNext: true,
  });
  logger.info('serverSession', `Marked server session rotate for ${conversationSessionId}: ${reason}`);
}

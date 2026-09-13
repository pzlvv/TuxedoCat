/**
 * NotifyEvents - 通知事件总线
 *
 * 提供跨模块的轻量事件订阅：
 * - 后台 Bash 任务完成（LocalShellTask 发出）
 * - 子代理 Reply 消息投递（ReplyTool 发出）
 *
 * 供 Exec 前台命令（尤其是 sleep 命令）监听，
 * 以便在 sleep 等待过程中收到通知时立刻转入后台，避免阻塞模型处理通知。
 */

import { logger } from '../../Logger.js';

/** 子代理 Reply 投递事件信息 */
export interface AgentReplyDeliveredInfo {
  /** 目标会话 ID */
  targetSessionId: string;
  /** 发送方（子代理）会话 ID */
  fromSessionId?: string;
  /** 消息内容预览 */
  messagePreview?: string;
}

export type AgentReplyDeliveredListener = (info: AgentReplyDeliveredInfo) => void;

const agentReplyDeliveredListeners = new Set<AgentReplyDeliveredListener>();

/**
 * 订阅子代理 Reply 投递事件
 * @returns 取消订阅函数
 */
export function onAgentReplyDelivered(listener: AgentReplyDeliveredListener): () => void {
  agentReplyDeliveredListeners.add(listener);
  return () => {
    agentReplyDeliveredListeners.delete(listener);
  };
}

/**
 * 发出子代理 Reply 投递事件（由 ReplyTool 在消息成功入队后调用）
 */
export function emitAgentReplyDelivered(info: AgentReplyDeliveredInfo): void {
  for (const listener of agentReplyDeliveredListeners) {
    try {
      listener(info);
    } catch (err) {
      logger.error('NotifyEvents', `Agent reply delivered listener error: ${err}`);
    }
  }
}

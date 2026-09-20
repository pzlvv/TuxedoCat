/**
 * SessionQueue - 会话消息队列管理
 *
 * 统一管理每个会话的消息排队逻辑：
 * 1. 用户消息排队（每个 session 最多一条，新消息替换旧消息）
 * 2. 代理回复消息排队（每个 session 可以有多条）
 * 3. 按照"用户消息优先，代理消息在后"的顺序处理
 * 4. 通过回调将消息投递给 UI 层显示或将用户消息提交处理
 */

import type { MessageData } from './types.js';
import { logger } from './Logger.js';

export interface SessionQueueCallbacks {
  /** 显示消息到 UI */
  onDisplayMessage: (sessionId: string, data: MessageData) => void;
  /** 提交用户消息进行处理 */
  onProcessUserMessage: (sessionId: string, content: string) => Promise<void>;
  /** 队列清空通知（无更多排队消息） */
  onQueueDrained?: (sessionId: string) => void;
}

class SessionQueueManager {
  /** 每个 session 正在排队的用户消息（key: sessionId，最多一条） */
  private pendingUserMessages: Map<string, string> = new Map();
  /** 每个 session 正在排队的代理回复消息（key: sessionId，可以多条） */
  private pendingAgentMessages: Map<string, MessageData[]> = new Map();
  /** 正在处理中的 session 集合 */
  private sessionProcessing: Set<string> = new Set();

  private callbacks: SessionQueueCallbacks | null = null;

  /**
   * 注册回调
   */
  setCallbacks(cbs: SessionQueueCallbacks): void {
    this.callbacks = cbs;
  }

  /** 回调是否已注册（启动自检用） */
  hasCallbacks(): boolean {
    return this.callbacks !== null;
  }

  /**
   * 标记 session 开始处理
   */
  markProcessing(sessionId: string): void {
    this.sessionProcessing.add(sessionId);
  }

  /**
   * 检查 session 是否正在处理中
   */
  isProcessing(sessionId: string): boolean {
    return this.sessionProcessing.has(sessionId);
  }

  /**
   * 将用户消息加入队列
   * 如果 session 正在处理中则排队（最多一条，新消息替换旧消息），
   * 否则返回 false 由调用方立即处理。
   * @returns true 表示已排队，false 表示无需排队可立即处理
   */
  queueUserMessage(sessionId: string, content: string): boolean {
    if (this.sessionProcessing.has(sessionId)) {
      this.pendingUserMessages.set(sessionId, content);
      return true;
    }
    return false;
  }

  /**
   * 无条件存储排队用户消息（不检查 sessionProcessing 状态）
   * 由外部调用方负责在合适的时机调用，例如 webview 端已确认 hasActiveQuery 为 true
   * 消息被后续的 consumeUserMessage 消费
   */
  storeUserMessage(sessionId: string, content: string): void {
    this.pendingUserMessages.set(sessionId, content);
  }

  /**
   * 将代理的回复消息加入队列
   * 如果 session 正在处理中则排队，否则立即显示
   */
  queueAgentMessage(sessionId: string, data: MessageData): void {
    if (!this.callbacks) {
      logger.warn('SessionQueue', 'No callbacks registered, cannot queue subagent message');
      return;
    }

    if (this.sessionProcessing.has(sessionId)) {
      const queue = this.pendingAgentMessages.get(sessionId) || [];
      queue.push(data);
      this.pendingAgentMessages.set(sessionId, queue);
    } else {
      // session 空闲，立即显示
      this.callbacks.onDisplayMessage(sessionId, data);
    }
  }

  /**
   * 消费并移除排队的用户消息（用于 queryLoop 中在每次 LLM 请求前检查）
   * @returns 排队消息内容，如果没有排队消息则返回 null
   */
  consumeUserMessage(sessionId: string): string | null {
    const content = this.pendingUserMessages.get(sessionId);
    if (content) {
      this.pendingUserMessages.delete(sessionId);
      return content;
    }
    return null;
  }

  /**
   * 处理 session 的下一个排队消息
   * 按照"用户消息优先，子代理消息在后"的顺序依次处理。
   * 当前查询结束或出错后自动调用。
   */
  async processNext(sessionId: string): Promise<void> {
    // 从处理集合中移除（解锁）
    this.sessionProcessing.delete(sessionId);

    if (!this.callbacks) {
      logger.warn('SessionQueue', 'No callbacks registered, cannot process next');
      return;
    }

    // ===== 第一阶段：处理用户消息 =====
    // 用户排队消息优先由 queryLoop 中的 consumeQueuedUserMessage 在每次 LLM 请求前消费。
    // 这样可以实现"排队消息在下次 LLM 请求时自动带上"的效果。
    // 但如果 queryLoop 已结束（session 空闲），需要在这里主动发起新的请求。
    const pendingUserContent = this.pendingUserMessages.get(sessionId);
    if (pendingUserContent) {
      this.pendingUserMessages.delete(sessionId);

      // 标记正在处理
      this.sessionProcessing.add(sessionId);

      try {
        await this.callbacks.onProcessUserMessage(sessionId, pendingUserContent);
      } catch (error) {
        logger.error('SessionQueue', `Error processing queued user message: ${error}`);
      }

      // 递归处理下一个（继续检查是否有新的排队消息）
      await this.processNext(sessionId);
      return;
    }

    // ===== 第二阶段：处理代理消息 =====
    const pendingSubMsgs = this.pendingAgentMessages.get(sessionId);
    if (pendingSubMsgs && pendingSubMsgs.length > 0) {
      // 取出第一条并显示
      const data = pendingSubMsgs.shift()!;
      if (pendingSubMsgs.length === 0) {
        this.pendingAgentMessages.delete(sessionId);
      }

      this.callbacks.onDisplayMessage(sessionId, data);

      // 继续处理剩余的代理消息
      await this.processNext(sessionId);
      return;
    }

    // ===== 没有排队消息 =====
    this.callbacks.onQueueDrained?.(sessionId);
  }

  /**
   * 取消 session 的排队消息
   */
  cancelQueued(sessionId: string): void {
    this.pendingUserMessages.delete(sessionId);
    this.pendingAgentMessages.delete(sessionId);
  }

  /**
   * 获取待处理的子代理消息数量
   */
  getPendingAgentCount(sessionId: string): number {
    return this.pendingAgentMessages.get(sessionId)?.length || 0;
  }

  /**
   * 获取排队的用户消息内容（不消费）
   */
  getQueuedUserMessage(sessionId: string): string | null {
    return this.pendingUserMessages.get(sessionId) ?? null;
  }
}

export const sessionQueue = new SessionQueueManager();

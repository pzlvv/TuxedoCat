/**
 * UserChoiceQueue - 全局用户选择队列管理
 *
 * 管理多会话场景下的用户选择请求：
 * 1. 每个 session 最多有一个 pending 的 user choice（新请求会覆盖旧的）
 * 2. 维护一个全局 FIFO 队列，按 enqueue 顺序排列所有待处理的 user choice
 * 3. 每次 enqueue 或 respond 后尝试消费队列，但**只在目标恰好是当前活跃 session 时**弹出；
 *    其它会话的请求不会触发会话切换，只保留 pending 状态，由宿主 UI 提醒用户手动进入
 * 4. 用户做出选择后，移除该 session 的 pending 状态并 resolve Promise，然后继续消费下一个
 * 5. 当用户手动切换到某个 session 时，如果该 session 有 pending 的 user choice，自动弹出
 */

import { logger } from './Logger.js';

export interface UserChoiceOptions {
  toolName: string;
  message: string;
  choices: Array<{ label: string; description?: string }>;
  showPreview?: boolean;
  previewContent?: string;
  previewTitle?: string;
  beforeContent?: string;
  afterContent?: string;
  contextBefore?: string[];
  contextAfter?: string[];
}

export interface UserChoiceResult {
  index: number;
  reply?: string;
}

interface PendingChoiceEntry {
  sessionId: string;
  options: UserChoiceOptions;
  resolve: (value: UserChoiceResult) => void;
  reject: (reason: unknown) => void;
  /** 是否已在队列中 */
  queued: boolean;
}

/**
 * 插件回调接口
 */
export interface UserChoiceCallbacks {
  /** 在当前 session 发起用户选择请求 */
  onShowUserChoice: (sessionId: string, options: UserChoiceOptions) => void;
  /** 当 session 被加载时，检查是否需要恢复 user choice */
  onSessionLoaded: (sessionId: string) => void;
  /** 获取当前活跃的 session ID */
  onGetActiveSessionId: () => string | undefined;
}

class UserChoiceQueueManager {
  /** 每个 session 当前的 pending user choice（key: sessionId） */
  private pendingChoices: Map<string, PendingChoiceEntry> = new Map();
  /** 全局 FIFO 队列，按 enqueue 顺序排列 */
  private queue: PendingChoiceEntry[] = [];
  /** 插件回调 */
  private callbacks: UserChoiceCallbacks | null = null;
  /** 是否正在处理队列（防止递归） */
  private processingQueue = false;

  /**
   * 注册插件回调
   */
  setCallbacks(cbs: UserChoiceCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * 将用户选择请求加入队列
   * 每个 session 最多有一个 pending 的请求，新请求会覆盖旧的（旧的会 reject）
   * @returns 一个 Promise，在用户做出选择后 resolve
   */
  enqueue(sessionId: string, options: UserChoiceOptions): Promise<UserChoiceResult> {
    return new Promise((resolve, reject) => {
      // 如果该 session 已有 pending 的 choice，先 reject 旧的
      const existing = this.pendingChoices.get(sessionId);
      if (existing) {
        logger.info(
          'UserChoiceQueue',
          `Replacing existing pending choice for session ${sessionId}`,
        );
        // 从队列中移除旧的
        this.removeFromQueue(existing);
        existing.reject(new Error('User choice was replaced by a new request'));
      }

      const entry: PendingChoiceEntry = {
        sessionId,
        options,
        resolve,
        reject,
        queued: true,
      };

      this.pendingChoices.set(sessionId, entry);
      this.queue.push(entry);

      logger.info(
        'UserChoiceQueue',
        `Enqueued choice for session ${sessionId}, queue length: ${this.queue.length}, pending sessions: ${this.pendingChoices.size}`,
      );

      // 尝试消费队列
      this.tryProcessNext();
    });
  }

  /**
   * 尝试从队列中消费下一个 user choice
   *
   * 规则：
   * 1. 从队列头部遍历，找到第一个有效的 entry（仍在 pendingChoices 中）
   * 2. 如果这个 entry 属于当前活跃 session：
   *    - 无论当前 session 是否有 pending choice（就是它自己），直接弹出
   * 3. 如果这个 entry 属于其他 session：
   *    - 当前活跃 session 如果已有 pending choice（正在展示中），不消费队列
   *    - 否则，出队但**不切换会话**：请求仍保留在 pendingChoices 中，
   *      等用户手动进入该会话时由 onSessionLoaded 恢复弹出；
   *      宿主 UI 依据 sessionRuntime 的 waiting 状态提醒用户（Single View 的历史对话按钮呼吸效果）
   */
  private tryProcessNext(): void {
    if (this.processingQueue) return;
    if (this.queue.length === 0) return;

    this.processingQueue = true;

    try {
      // 从队列头部找到第一个有效的 entry
      let targetEntry: PendingChoiceEntry | undefined;

      for (let i = 0; i < this.queue.length; i++) {
        const entry = this.queue[i];
        // 检查 entry 是否仍然有效（仍在 pendingChoices 中）
        if (this.pendingChoices.has(entry.sessionId)) {
          targetEntry = entry;
          break;
        }
        // 无效的 entry，从队列中移除
        this.queue.splice(i, 1);
        i--;
      }

      if (!targetEntry) {
        this.processingQueue = false;
        return;
      }

      const activeSessionId = this.callbacks?.onGetActiveSessionId();

      // 如果目标 entry 属于当前活跃 session，直接弹出
      if (activeSessionId === targetEntry.sessionId) {
        this.removeFromQueue(targetEntry);
        logger.info(
          'UserChoiceQueue',
          `Already on target session ${targetEntry.sessionId}, showing choice directly`,
        );
        this.callbacks?.onShowUserChoice(targetEntry.sessionId, targetEntry.options);
      } else if (activeSessionId && this.pendingChoices.has(activeSessionId)) {
        // 当前活跃 session 已有 pending choice（正在展示中），不打断
        logger.info(
          'UserChoiceQueue',
          `Active session ${activeSessionId} still has pending choice, deferring queue consumption`,
        );
      } else {
        // 不再自动切换会话：把该请求移出 FIFO 队列（仍保留在 pendingChoices 中），
        // 等用户手动进入该会话时由 onSessionLoaded 恢复弹出。
        // 出队是必要的——否则它会一直卡在队头，挡住后续属于当前会话的请求。
        logger.info(
          'UserChoiceQueue',
          `Deferring choice for session ${targetEntry.sessionId} (no auto-switch, awaiting manual navigation)`,
        );
        this.removeFromQueue(targetEntry);
      }
    } finally {
      this.processingQueue = false;
    }
  }

  /**
   * 从队列中移除指定的 entry
   */
  private removeFromQueue(entry: PendingChoiceEntry): void {
    const idx = this.queue.indexOf(entry);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
    }
    entry.queued = false;
  }

  /**
   * 获取指定 session 的 pending user choice
   * 如果不存在则返回 null
   */
  getPendingChoice(sessionId: string): UserChoiceOptions | null {
    const entry = this.pendingChoices.get(sessionId);
    return entry ? entry.options : null;
  }

  /**
   * 检查指定 session 是否有 pending 的 user choice
   */
  hasPendingChoice(sessionId: string): boolean {
    return this.pendingChoices.has(sessionId);
  }

  /**
   * 用户对指定 session 的 user choice 做出了响应
   * 移除 pending 状态并 resolve Promise
   */
  respond(sessionId: string, result: UserChoiceResult): boolean {
    const entry = this.pendingChoices.get(sessionId);
    if (!entry) {
      logger.warn(
        'UserChoiceQueue',
        `No pending choice found for session ${sessionId} when trying to respond`,
      );
      return false;
    }

    // 确保从队列中移除
    this.removeFromQueue(entry);
    this.pendingChoices.delete(sessionId);
    logger.info(
      'UserChoiceQueue',
      `Choice responded for session ${sessionId}, queue length: ${this.queue.length}, pending sessions: ${this.pendingChoices.size}`,
    );

    entry.resolve(result);

    // 响应完成后，尝试消费下一个
    this.tryProcessNext();

    return true;
  }

  /**
   * 拒绝指定 session 的 pending user choice（如 session 被关闭）
   */
  rejectPending(sessionId: string, reason: unknown): void {
    const entry = this.pendingChoices.get(sessionId);
    if (entry) {
      this.removeFromQueue(entry);
      this.pendingChoices.delete(sessionId);
      entry.reject(reason);
      // 拒绝后尝试消费下一个
      this.tryProcessNext();
    }
  }

  /**
   * 当 session 被加载时调用，通知 UI 恢复该 session 的 user choice
   */
  onSessionLoaded(sessionId: string): void {
    logger.info(
      'UserChoiceQueue',
      `Session ${sessionId} loaded, checking for pending choice...`,
    );
    // 该会话已被加载：回调会弹出它的 pending choice；
    // 先从 FIFO 队列移除，避免下面的 tryProcessNext 对同一会话重复弹出（重复弹框会让
    // 旧 Promise 永远不 resolve，对应工具调用挂死）。
    const entry = this.pendingChoices.get(sessionId);
    if (entry) this.removeFromQueue(entry);
    this.callbacks?.onSessionLoaded(sessionId);
    // 尝试消费其它（属于当前会话的）请求
    this.tryProcessNext();
  }

  /**
   * 是否已注册插件回调（即是否已初始化队列消费能力）
   * 未初始化时（宿主未注册队列回调）不应入队等待，否则 Promise 永远不会 resolve
   */
  isInitialized(): boolean {
    return this.callbacks !== null;
  }

  /**
   * 获取当前所有有 pending choice 的 session ID 列表
   */
  getPendingSessionIds(): string[] {
    return Array.from(this.pendingChoices.keys());
  }

  /**
   * 获取队列中 pending 的数量
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * 清空所有 pending 状态
   */
  clear(): void {
    // reject 所有 pending
    for (const [, entry] of this.pendingChoices) {
      this.removeFromQueue(entry);
      entry.reject(new Error('UserChoiceQueue cleared'));
    }
    this.pendingChoices.clear();
    this.queue = [];
  }
}

export const userChoiceQueue = new UserChoiceQueueManager();

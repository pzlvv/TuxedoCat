/**
 * UserChoiceQueue - 全局用户选择请求管理
 *
 * 管理多会话场景下的用户选择请求（ask user 提问 / 工具权限确认）：
 * 1. 每个 session 最多有一个 pending 的 user choice（新请求会覆盖旧的，旧的 Promise 被 reject）
 * 2. 请求只投递给「已 open（有视图 / 正在显示）的会话」：
 *    - 多视图宿主（Electron）：open = 该会话有聊天视图；视图存在即可投递，弹框显示在该
 *      会话自己的视图里（即使该视图当前未被选中，切过去即可看到）
 *    - 单视图宿主（VS Code）：open == active == 当前 webview 里显示的会话
 *    会话是否 open 由宿主通过 `isSessionOpen` 回答（core 不持有视图状态）
 * 3. 会话未 open 时请求只登记在 pendingChoices，等宿主在会话 open 后（onSessionLoaded）
 *    清掉旧 choiceId 并重新投递 requestUserChoice
 * 4. 用户做出选择后，移除该 session 的 pending 状态并 resolve Promise
 *
 * 不维护全局 FIFO，也不自动切换会话：多视图下每个 open 会话有自己的显示面，各自显示自己的
 * 待答请求；单视图下「同一时刻只显示一个弹框」由 webview 的「消息 sessionId == 当前会话」
 * 判定天然保证（其它会话的请求等用户切过去时再投递）。
 */

import { logger } from './Logger.js';

/**
 * AskUserQuestion 的单个问题（specs/026，入参形状对齐 dsh）。
 *
 * 内部规范化后三个字段全必选：`header` 缺失用 `null`，`options` 缺失用空数组，
 * `description` 缺失用 `null`，`multi_select` 缺失用 `false`。
 */
export interface UserQuestion {
  id: string;
  question: string;
  header: string | null;
  options: Array<{ label: string; description: string | null }>;
  multi_select: boolean;
}

/** 单题回复：`selected` 是选项 label 数组，`custom` 是自由文本（缺失用 null）。 */
export interface UserAnswer {
  id: string;
  selected: string[];
  custom: string | null;
}

/** 工具权限确认场景（`toolPermissionRequested` 之后弹的确认框）。 */
export interface PermissionChoiceOptions {
  kind: 'permission';
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

/** AskUserQuestion 场景（逐题作答，答案按 id 回传）。 */
export interface QuestionChoiceOptions {
  kind: 'question';
  toolName: 'AskUserQuestion';
  questions: UserQuestion[];
}

export type UserChoiceOptions = PermissionChoiceOptions | QuestionChoiceOptions;

export type UserChoiceResult =
  | { kind: 'permission'; index: number; reply: string | null }
  | { kind: 'question'; answers: UserAnswer[] };

interface PendingChoiceEntry {
  sessionId: string;
  options: UserChoiceOptions;
  resolve: (value: UserChoiceResult) => void;
  reject: (reason: unknown) => void;
}

/**
 * 插件回调接口
 */
export interface UserChoiceCallbacks {
  /** 在当前 session 发起用户选择请求（宿主按 sessionId 路由到该会话的视图 / webview） */
  onShowUserChoice: (sessionId: string, options: UserChoiceOptions) => void;
  /** 当 session 被 open / 加载时，检查是否需要恢复 user choice（重新投递 requestUserChoice） */
  onSessionLoaded: (sessionId: string) => void;
  /** 该 session 当前是否 open（有视图 / 正在显示）；由宿主回答，core 不持有视图状态 */
  isSessionOpen: (sessionId: string) => boolean;
}

class UserChoiceQueueManager {
  /** 每个 session 当前的 pending user choice（key: sessionId） */
  private pendingChoices: Map<string, PendingChoiceEntry> = new Map();
  /** 插件回调 */
  private callbacks: UserChoiceCallbacks | null = null;

  /**
   * 注册插件回调
   */
  setCallbacks(cbs: UserChoiceCallbacks): void {
    this.callbacks = cbs;
  }

  /**
   * 将用户选择请求登记为 pending，并在会话已 open 时立即投递
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
        existing.reject(new Error('User choice was replaced by a new request'));
      }

      const entry: PendingChoiceEntry = { sessionId, options, resolve, reject };
      this.pendingChoices.set(sessionId, entry);

      const open = this.callbacks?.isSessionOpen(sessionId) ?? false;
      logger.info(
        'UserChoiceQueue',
        `Enqueued choice for session ${sessionId}, pending sessions: ${this.pendingChoices.size}, open: ${open}`,
      );

      if (open) {
        // 会话已 open：直接投递，由该会话自己的视图 / webview 弹出
        this.callbacks?.onShowUserChoice(sessionId, options);
      }
      // 未 open：保留 pending，等宿主在会话 open 后调用 onSessionLoaded 重新投递
    });
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

    this.pendingChoices.delete(sessionId);
    logger.info(
      'UserChoiceQueue',
      `Choice responded for session ${sessionId}, pending sessions: ${this.pendingChoices.size}`,
    );

    entry.resolve(result);

    return true;
  }

  /**
   * 拒绝指定 session 的 pending user choice（如 session 被关闭）
   */
  rejectPending(sessionId: string, reason: unknown): void {
    const entry = this.pendingChoices.get(sessionId);
    if (entry) {
      this.pendingChoices.delete(sessionId);
      entry.reject(reason);
    }
  }

  /**
   * 当 session 被 open / 加载时调用，通知 UI 投递该 session 的 pending choice
   *
   * 会话 open 之前入队的请求只登记在 pendingChoices 里、不投递；宿主在视图创建 /
   * 切换到该会话后调用本方法，由宿主清掉旧的 choiceId 并重新投递 requestUserChoice
   * （webview 重建时也走这条路径恢复弹框）。
   */
  onSessionLoaded(sessionId: string): void {
    logger.info(
      'UserChoiceQueue',
      `Session ${sessionId} loaded, checking for pending choice...`,
    );
    if (this.pendingChoices.has(sessionId)) {
      this.callbacks?.onSessionLoaded(sessionId);
    }
  }

  /**
   * 是否已注册插件回调（即是否已初始化队列消费能力）
   * 未初始化时（宿主未注册队列回调）不应入队等待，否则 Promise 永远不会 resolve
   */
  isInitialized(): boolean {
    return this.callbacks !== null;
  }

  /**
   * 清空所有 pending 状态
   */
  clear(): void {
    // reject 所有 pending
    for (const [, entry] of this.pendingChoices) {
      entry.reject(new Error('UserChoiceQueue cleared'));
    }
    this.pendingChoices.clear();
  }
}

export const userChoiceQueue = new UserChoiceQueueManager();

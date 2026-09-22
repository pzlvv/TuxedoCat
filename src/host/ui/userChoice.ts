/**
 * src/host/ui/userChoice.ts - UserChoiceQueue 逻辑
 *
 * 维护全局 FIFO 队列 + per-session 状态。用户请求（ask user 提问 / 权限确认）
 * 不再触发会话切换：请求只在用户当前所在的会话弹出，其它会话的请求保留 pending，
 * 由 UI 提醒用户手动进入（Single View 的历史对话按钮呼吸效果 / Electron 侧栏黄灯）。
 */
import type { LogChannel } from '../UIHost.js';
import { userChoiceQueue } from '../../core/UserChoiceQueue.js';
import { markSessionWaiting } from '../../core/sessionRuntime.js';

/**
 * UserChoiceManager - 管理 UserChoice 的展示与用户选择处理。
 *
 * 共享模块本身不 import 任何宿主 API；需要宿主能力时用注入的回调。
 */
export class UserChoiceManager {
  private outputChannel: LogChannel | undefined;
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private closePreview: () => void;
  private getActiveSessionIdInternal: () => string | undefined;

  /** 当前请求的上下文（前） */
  public currentContextBefore: string[] = [];
  /** 当前请求的上下文（后） */
  public currentContextAfter: string[] = [];
  /** 当前请求的 beforeContent */
  public currentBeforeContent: string = '';
  /** 当前请求的 afterContent */
  public currentAfterContent: string = '';
  /** 当前请求的 startLine */
  public currentStartLine?: number;
  /** 当前请求的 endLine */
  public currentEndLine?: number;
  /**
   * diff 快照归属的会话（最后一次写入者）。
   * 快照是「当前请求」的全局暂存位，本身不带会话键；记下写入方才能在
   * dropSession 时只清理属于该会话的快照，不误伤其它会话正在进行的 Edit / Write。
   */
  private diffSnapshotSessionId: string | undefined;
  /** 按 choiceId 存储的 pending 用户选择回调 */
  public pendingUserChoices: Map<string, { sessionId: string; resolve: (value: { index: number; reply?: string }) => void }> = new Map();
  /**
   * 用户选择框弹出后的可选回调（当前无人传入，保留给宿主做额外动作）。
   * waiting 状态已由 core 的 `sessionRuntime` → `CoreEvent.sessionRuntimeChanged`
   * 推给侧栏（黄灯）与托盘，宿主不再借该回调刷新侧栏。
   */
  private onChoiceShown?: (sessionId: string) => void;

  constructor(deps: {
    outputChannel: LogChannel | undefined;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    closePreview: () => void;
    getActiveSessionIdInternal: () => string | undefined;
    onChoiceShown?: (sessionId: string) => void;
  }) {
    this.outputChannel = deps.outputChannel;
    this.postToWebview = deps.postToWebview;
    this.closePreview = deps.closePreview;
    this.getActiveSessionIdInternal = deps.getActiveSessionIdInternal;
    this.onChoiceShown = deps.onChoiceShown;
  }

  private log(...args: unknown[]): void {
    this.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
  }

  /**
   * 写入 diff 快照并登记归属会话（供 ToolHandler 与权限确认共用）。
   * 全量覆盖 6 个字段，与原先直接赋值的语义一致。
   */
  saveDiffSnapshot(sessionId: string, snapshot: {
    beforeContent: string;
    afterContent: string;
    contextBefore: string[];
    contextAfter: string[];
    startLine?: number;
    endLine?: number;
  }): void {
    this.diffSnapshotSessionId = sessionId;
    this.currentBeforeContent = snapshot.beforeContent;
    this.currentAfterContent = snapshot.afterContent;
    this.currentContextBefore = snapshot.contextBefore;
    this.currentContextAfter = snapshot.contextAfter;
    this.currentStartLine = snapshot.startLine;
    this.currentEndLine = snapshot.endLine;
  }

  /** 清空 diff 快照与归属标记 */
  private clearDiffSnapshot(): void {
    this.diffSnapshotSessionId = undefined;
    this.currentBeforeContent = '';
    this.currentAfterContent = '';
    this.currentContextBefore = [];
    this.currentContextAfter = [];
    this.currentStartLine = undefined;
    this.currentEndLine = undefined;
  }

  /**
   * 初始化全局 UserChoiceQueue 回调
   */
  initUserChoiceQueue(): void {
    userChoiceQueue.setCallbacks({
      onShowUserChoice: (sessionId: string) => {
        this.restoreUserChoiceIfPending(sessionId);
      },

      onSessionLoaded: (sessionId: string) => {
        this.restoreUserChoiceIfPending(sessionId);
      },

      onGetActiveSessionId: () => {
        return this.getActiveSessionIdInternal();
      },
    });
  }

  /**
   * 检查指定 session 是否有 pending user choice，如果有则恢复显示
   */
  private restoreUserChoiceIfPending(sessionId: string): void {
    const pendingOptions = userChoiceQueue.getPendingChoice(sessionId);
    if (!pendingOptions) {
      return;
    }

    this.log(`[UserChoiceManager] Restoring pending user choice for session ${sessionId}`);

    // 清理该 session 在 pendingUserChoices 中旧的条目
    for (const [choiceId, entry] of this.pendingUserChoices) {
      if (entry.sessionId === sessionId) {
        this.log(`[UserChoiceManager] Cleaning up stale pendingUserChoice ${choiceId} for session ${sessionId}`);
        this.pendingUserChoices.delete(choiceId);
      }
    }

    // 先重置该 session 的 UI 状态
    this.postToWebview(sessionId, {
      type: 'showThinkingAnimation',
      sessionId,
      show: false,
    });

    // 显示 user choice
    this.requestUserChoice(sessionId, pendingOptions).catch(err => {
      this.log(`[UserChoiceManager] restoreUserChoiceIfPending error: ${err}`);
    });
  }

  /**
   * 请求用户选择或确认。
   * beforeContent 允许 null：Write 新建文件时无原文，diff 预览需要区分「空串」与「无原文件」。
   */
  async requestUserChoice(sessionID: string, options: {
    toolName: string;
    message: string;
    choices?: Array<{ label: string; description?: string }>;
    showPreview?: boolean;
    previewContent?: string;
    previewTitle?: string;
    beforeContent?: string | null;
    afterContent?: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }): Promise<{ index: number; reply?: string }> {
    const choiceId = `choice-${Date.now()}-${Math.random()}`;

    this.currentContextBefore = (options.contextBefore || [])
      .filter((line) => {
        const lineStr = String(line);
        return line !== null && lineStr.trim().length > 0 && lineStr !== 'undefined';
      });
    this.currentContextAfter = (options.contextAfter || [])
      .filter((line) => {
        const lineStr = String(line);
        return line !== null && lineStr.trim().length > 0 && lineStr !== 'undefined';
      });

    this.currentBeforeContent = options.beforeContent || '';
    this.currentAfterContent = options.afterContent || '';
    // 本次写入归属该会话（startLine / endLine 由 ToolHandler 侧保留，这里不动）
    this.diffSnapshotSessionId = sessionID;

    this.log(`[UserChoiceManager] Saved beforeContent (${this.currentBeforeContent.length} chars) and afterContent (${this.currentAfterContent.length} chars)`);

    const postData: Record<string, unknown> = {
      type: 'requestUserChoice',
      choiceId,
      toolName: options.toolName,
      message: options.message,
      choices: options.choices,
    };
    if (options.previewContent) {
      postData.previewContent = options.previewContent;
    }
    if (options.previewTitle) {
      postData.previewTitle = options.previewTitle;
    }
    this.postToWebview(sessionID, postData);

    // 会话运行时状态：等待用户操作（ask user / 权限确认）→ 侧栏黄灯 / 托盘状态点
    markSessionWaiting(sessionID, true);
    this.onChoiceShown?.(sessionID);

    return new Promise((resolve) => {
      this.pendingUserChoices.set(choiceId, {
        sessionId: sessionID,
        resolve: (value) => {
          this.closePreview();
          // 用户已响应：waiting 解除
          markSessionWaiting(sessionID, false);
          resolve(value);
        }
      });
    });
  }

  /**
   * 检查指定 session 是否正在等待用户选择/确认（ask user 提问或权限确认）。
   *
   * 两个来源都算「等待」：
   * - `pendingUserChoices`：已经在该会话的 webview 里弹出、等用户点选；
   * - `userChoiceQueue`：已入队但尚未弹出（用户当前不在该会话），请求仍在等待。
   *
   * 供 core 的 `isSessionIdle` 判定「非空闲，不应被空闲回收」。
   */
  hasPendingChoice(sessionId: string): boolean {
    if (userChoiceQueue.hasPendingChoice(sessionId)) {
      return true;
    }
    for (const entry of this.pendingUserChoices.values()) {
      if (entry.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 会话的 UI 侧状态已释放（视图关闭 / 会话删除）：清掉该会话在本模块的 per-session 状态。
   * 由 `WebViewUI.dropSession` 统一 fan-out 调用（DEVELOPMENT.md 第 10.5 节）。
   *
   * - 丢弃该会话挂起的用户选择回调：webview 已不在，响应不会再回来；
   * - diff 快照只有在归属该会话时才清空，避免误伤其它会话正在进行的 Edit / Write。
   */
  dropSession(sessionId: string): void {
    for (const [choiceId, entry] of this.pendingUserChoices) {
      if (entry.sessionId === sessionId) {
        this.pendingUserChoices.delete(choiceId);
      }
    }
    if (this.diffSnapshotSessionId === sessionId) {
      this.clearDiffSnapshot();
    }
  }
}

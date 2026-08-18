/**
 * VSCodeUI/userChoice.ts - UserChoiceQueue 逻辑
 * 维护全局 FIFO 队列 + per-session 状态，支持自动跳转
 */
import type { Uri } from 'vscode';
import type { LogChannel } from '../host/UIHost.js';
import { userChoiceQueue } from '../core/UserChoiceQueue.js';
import type { ShowDiffInVirtualDocumentEvent } from './types.js';
import type { ValidationRule } from '../core/webviewTypes.js';
import type { DiffUris } from './diffUris.js';

/**
 * UserChoiceManager - 管理 UserChoice 展示、diff 预览、用户选择处理等
 */
export class UserChoiceManager {
  private outputChannel: LogChannel | undefined;
  private postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
  private closePreview: () => void;
  private getActiveSessionIdInternal: () => string | undefined;
  private showPasswordInput: ((prompt: string, plainText?: boolean) => Promise<string | null>) | undefined;
  private hasWebview: () => boolean;

  /** 当前打开的预览文档标识（统一使用 vscode.Uri 规范化对象） */
  public currentPreviewUris: Uri[] = [];
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
  /** 当前打开的 diff 的哈希值 */
  public currentDiffHash: string = '';
  /** 按 choiceId 存储的 pending 用户选择回调 */
  public pendingUserChoices: Map<string, { sessionId: string; resolve: (value: { index: number; reply?: string }) => void }> = new Map();
  /** 按 passwordId 存储的 pending 密码输入回调 */
  public pendingPasswordRequests: Map<string, { resolve: (value: string | null) => void }> = new Map();
  /** diff 回调 */
  private onShowDiffInVirtualDocumentCallback?: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>;
  /** 构建 diff URI（宿主相关；Electron 宿主不需要传） */
  private buildDiffUris?: (title: string) => DiffUris;
  /** 用户选择框弹出后的回调（宿主侧用于刷新侧栏流水灯为黄色） */
  private onChoiceShown?: (sessionId: string) => void;

  constructor(deps: {
    outputChannel: LogChannel | undefined;
    postToWebview: (sessionId: string, message: Record<string, unknown>) => void;
    closePreview: () => void;
    getActiveSessionIdInternal: () => string | undefined;
    onShowDiffInVirtualDocumentCallback?: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>;
    buildDiffUris?: (title: string) => DiffUris;
    showPasswordInput?: (prompt: string, plainText?: boolean) => Promise<string | null>;
    hasWebview?: () => boolean;
    onChoiceShown?: (sessionId: string) => void;
  }) {
    this.outputChannel = deps.outputChannel;
    this.postToWebview = deps.postToWebview;
    this.closePreview = deps.closePreview;
    this.getActiveSessionIdInternal = deps.getActiveSessionIdInternal;
    this.onShowDiffInVirtualDocumentCallback = deps.onShowDiffInVirtualDocumentCallback;
    this.buildDiffUris = deps.buildDiffUris;
    this.showPasswordInput = deps.showPasswordInput;
    this.hasWebview = deps.hasWebview ?? (() => true);
    this.onChoiceShown = deps.onChoiceShown;
  }

  setShowDiffCallback(callback: (event: ShowDiffInVirtualDocumentEvent) => void | Promise<void>): void {
    this.onShowDiffInVirtualDocumentCallback = callback;
  }

  private log(...args: unknown[]): void {
    this.outputChannel?.appendLine(args.map(a => String(a)).join(' '));
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

      onSwitchSession: (sessionId: string) => {
        this.postToWebview(sessionId, {
          type: 'switchToSession',
          sessionId,
        });
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

    this.log(`[VSCodeUI] Restoring pending user choice for session ${sessionId}`);

    // 清理该 session 在 pendingUserChoices 中旧的条目
    for (const [choiceId, entry] of this.pendingUserChoices) {
      if (entry.sessionId === sessionId) {
        this.log(`[VSCodeUI] Cleaning up stale pendingUserChoice ${choiceId} for session ${sessionId}`);
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
      this.log(`[VSCodeUI] restoreUserChoiceIfPending error: ${err}`);
    });
  }

  /**
   * 请求用户选择或确认
   */
  async requestUserChoice(sessionID: string, options: {
    toolName: string;
    message: string;
    choices?: Array<{ label: string; description?: string }>;
    showPreview?: boolean;
    previewContent?: string;
    previewTitle?: string;
    showDiff?: boolean;
    beforeContent?: string | null;
    afterContent?: string;
    diffTitle?: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }): Promise<{ index: number; reply?: string }> {
    const choiceId = `choice-${Date.now()}-${Math.random()}`;

    // 如果需要显示 diff，先检查是否已经打开了相同的 diff
    const shouldShowDiff = options.showDiff === true
      && this.onShowDiffInVirtualDocumentCallback !== undefined
      && options.beforeContent !== undefined
      && options.afterContent !== undefined;

    if (shouldShowDiff) {
      const bc = options.beforeContent || '';
      const ac = options.afterContent || '';
      const newDiffHash = `${bc.length}-${ac.length}-${bc.substring(0, 100)}-${ac.substring(0, 100)}`;

      if (this.currentDiffHash === newDiffHash) {
        this.log(`[VSCodeUI] Same diff already open, skipping virtual doc creation`);
      } else {
        // 关闭之前的预览文档
        if (this.currentPreviewUris.length > 0) {
          this.closePreview();
        }

        this.currentDiffHash = newDiffHash;

        try {
          const result = this.onShowDiffInVirtualDocumentCallback!({
            beforeContent: options.beforeContent!,
            afterContent: options.afterContent!,
            title: options.diffTitle || '',
          });

          if (result && typeof result.then === 'function') {
            await result;
          }

          const displayTitle = options.diffTitle || '';
          const diffUris = this.buildDiffUris?.(displayTitle);
          if (diffUris) {
            this.currentPreviewUris.push(diffUris.beforeUri, diffUris.afterUri);
          }
        } catch (err) {
          this.log(`[VSCodeUI] Error in diff callback: ${err}`);
        }
      }
    }

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

    this.log(`[VSCodeUI] Saved beforeContent (${this.currentBeforeContent.length} chars) and afterContent (${this.currentAfterContent.length} chars)`);

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

    // 用户选择框已弹出：通知宿主（如 Electron 侧栏将流水灯刷新为黄色）
    this.onChoiceShown?.(sessionID);

    return new Promise((resolve) => {
      this.pendingUserChoices.set(choiceId, {
        sessionId: sessionID,
        resolve: (value) => {
          this.closePreview();
          resolve(value);
        }
      });
    });
  }

  /**
   * 请求用户输入密码（优先通过 WebView 展示，无 webview 时降级为宿主原生输入）
   * @param plainText 如果为 true，则以明文输入框显示
   */
  async requestPassword(sessionID: string, prompt: string, validationRule?: ValidationRule, plainText?: boolean): Promise<string | null> {
    if (!this.hasWebview()) {
      // 无 webview 通道时使用宿主原生输入（如 VSCode showInputBox / Electron dialog）
      if (this.showPasswordInput) {
        return this.showPasswordInput(prompt, plainText);
      }
      return null;
    }

    const passwordId = `password-${Date.now()}-${Math.random()}`;
    this.postToWebview(sessionID, {
      type: 'requestPassword',
      passwordId,
      prompt,
      plainText: plainText || false,
      validationRule: validationRule ? { pattern: validationRule.pattern.source, message: validationRule.message } : undefined,
    });

    return new Promise((resolve) => {
      this.pendingPasswordRequests.set(passwordId, { resolve });
    });
  }

  /**
   * 检查指定 session 是否正在等待用户选择/确认（ask user 提问或权限确认）。
   * 用于宿主侧（如 Electron 侧栏）将流水灯显示为黄色。
   */
  hasPendingChoice(sessionId: string): boolean {
    for (const entry of this.pendingUserChoices.values()) {
      if (entry.sessionId === sessionId) {
        return true;
      }
    }
    return false;
  }

  /**
   * 重置预览状态（由 VSCodeUI.closePreview() 调用）
   */
  resetPreviewState(): void {
    this.currentPreviewUris = [];
    this.currentDiffHash = '';
  }
}

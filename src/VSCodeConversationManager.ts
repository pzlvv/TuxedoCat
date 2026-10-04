/**
 * SingleWebViewConversationManager - VS Code 的 ConversationManager 实现
 *
 * 单 webview 宿主：对话列表只推 webview 的 conversationsData（子对话树）；
 * 会话运行时状态无消费者（webview 对话树从 queryBegin/queryEnd 自己维护）→ 空实现。
 *
 * 空闲会话回收也只在本实现里（DEVELOPMENT.md 第 5.4 节）：VS Code 只有一份 webview，
 * 关闭空闲对话只是卸内存；Electron 每个对话一个独立视图，自动关闭等于关掉用户的窗口，
 * 因此不参与回收。
 *
 * 规则：非激活对话在最后一次活动后空闲超过 SESSION_IDLE_CLOSE_MS（2 小时）即关闭，
 * 每 SESSION_IDLE_CHECK_INTERVAL_MS（1 分钟）巡检一次。「是否空闲」由 core 的
 * 只读查询 isSessionIdle 判定，判定失败时保守视为「非空闲」。
 */

import type { ConversationMetadata } from './core/history/Conversation.js';
import type { SessionRuntimeState } from './core/AssistantEventBus.js';
import type { UIHost } from './host/UIHost.js';
import { ConversationManager } from './host/ConversationManager.js';
import { isSessionIdle, isTemporarySessionId } from './core/sessionResources.js';

/** 非激活对话空闲多久后自动关闭（2 小时） */
export const SESSION_IDLE_CLOSE_MS = 2 * 60 * 60 * 1000;

/** 空闲巡检间隔（1 分钟） */
export const SESSION_IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export class SingleWebViewConversationManager extends ConversationManager {
  constructor(host: UIHost) {
    super(host);
  }

  /** 流 1：纯磁盘列表 → webview conversationsData */
  protected async dispatchList(list: readonly ConversationMetadata[]): Promise<void> {
    this.host.sendToWebview({
      type: 'conversationsData',
      conversations: list.map((c) => ({
        sessionId: c.sessionId,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messageCount,
        parentSessionId: c.parentSessionId,
      })),
    });
  }

  /**
   * 流 2：空实现——webview 的对话树从 queryBegin/queryEnd 自己维护（第 4.5 节）。
   *
   * 空闲计时顺带在这里刷新：会话从空闲进入工作（非 idle）或从工作回到空闲时，
   * 都视为一次活动（工作结束后才从头计时）。
   */
  updateSessionStates(states: readonly SessionRuntimeState[]): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const state of states) {
      if (!state.sessionId || isTemporarySessionId(state.sessionId)) continue;
      seen.add(state.sessionId);
      const busy = !state.idle;
      const wasBusy = this.sessionBusy.get(state.sessionId) ?? false;
      if (busy || wasBusy) {
        this.lastActivityAt.set(state.sessionId, now);
      }
      this.sessionBusy.set(state.sessionId, busy);
    }
    for (const key of [...this.sessionBusy.keys()]) {
      if (!seen.has(key)) this.sessionBusy.delete(key);
    }
    super.updateSessionStates(states);
  }

  /**
   * 流 2 的分发方：把 core 的会话运行时状态推给 webview，供对话树的流水灯
   * （idle / waiting）使用。VS Code 没有原生侧栏 / 托盘消费者。
   *
   * 这是流水灯的**唯一数据源**——webview 不再从 `queryBegin` / `queryEnd` 自行推导。
   */
  protected dispatchStates(states: readonly SessionRuntimeState[]): void {
    this.host.sendToWebview({
      type: 'sessionRuntimeStates',
      states,
    });
  }

  // ===================== 空闲会话回收（计时 owner 在宿主层） =====================

  /** sessionId -> 最后一次活动时间戳（毫秒） */
  private lastActivityAt = new Map<string, number>();

  /** sessionId -> 上一次推送的运行时状态是否「忙」（用于「变为空闲时重新计时」） */
  private sessionBusy = new Map<string, boolean>();

  /**
   * 「当前激活会话」读取器（bootstrap 注入）。
   * 「哪个会话在前台」是 UI 自己的状态（DEVELOPMENT.md 第 12.7 节），
   * 未注入时视为「无激活会话」。
   */
  private activeSessionProvider: (() => string | null | undefined) | null = null;

  /**
   * 「关闭对话」回调（bootstrap 注入：指向 WebViewUI.closeConversation）。
   * 未注入时不关闭任何会话。
   */
  private idleCloseHandler: ((sessionId: string) => void | Promise<void>) | null = null;

  private idleTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 记录会话活动：发送消息、打开或激活对话、查询开始/结束时调用。
   * 会重置该会话的空闲计时。
   */
  noteSessionActivity(sessionId?: string | null): void {
    if (!sessionId || isTemporarySessionId(sessionId)) return;
    this.lastActivityAt.set(sessionId, Date.now());
  }

  /** 注册「当前激活会话」读取器 */
  setActiveSessionProvider(fn: (() => string | null | undefined) | null): void {
    this.activeSessionProvider = fn;
  }

  /** 注册「关闭对话」回调（宿主在启动时注入） */
  setIdleCloseHandler(fn: ((sessionId: string) => void | Promise<void>) | null): void {
    this.idleCloseHandler = fn;
  }

  /** 启动空闲巡检（幂等；宿主在启动时调用一次） */
  startIdleMonitor(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.sweepIdleSessions().catch((err) => {
        this.host.log(`[ConversationManager] idle sweep failed: ${err}`);
      });
    }, SESSION_IDLE_CHECK_INTERVAL_MS);
    // Node 环境下不要因为该定时器阻止进程退出
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 停止空闲巡检（扩展停用时调用） */
  stopIdleMonitor(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * 巡检一次：关闭所有满足条件的空闲会话，返回被关闭的 sessionId 列表。
   * 导出以便测试与手动触发（默认每 SESSION_IDLE_CHECK_INTERVAL_MS 自动执行）。
   */
  async sweepIdleSessions(now: number = Date.now()): Promise<string[]> {
    if (!this.idleCloseHandler) return [];

    const closed: string[] = [];
    const activeSessionId = this.resolveActiveSessionId();

    for (const sessionId of [...this.lastActivityAt.keys()]) {
      if (!sessionId || isTemporarySessionId(sessionId)) continue;

      const last = this.lastActivityAt.get(sessionId);
      if (last === undefined) continue;
      // 当前激活的对话永不关闭，并持续刷新空闲计时
      if (activeSessionId && sessionId === activeSessionId) {
        this.lastActivityAt.set(sessionId, now);
        continue;
      }
      if (now - last < SESSION_IDLE_CLOSE_MS) continue;

      // 仍在工作 / 等待用户确认：重新计时
      if (await this.isBusy(sessionId)) {
        this.lastActivityAt.set(sessionId, now);
        continue;
      }

      // 上面的 await 期间状态可能已变化（重新激活 / 开始新查询）：关闭前再确认一次
      if (this.resolveActiveSessionId() === sessionId) {
        this.lastActivityAt.set(sessionId, now);
        continue;
      }
      if (await this.isBusy(sessionId)) {
        this.lastActivityAt.set(sessionId, now);
        continue;
      }

      try {
        await this.idleCloseHandler(sessionId);
        this.lastActivityAt.delete(sessionId);
        this.sessionBusy.delete(sessionId);
        closed.push(sessionId);
        this.host.log(
          `[ConversationManager] closed idle session ${sessionId} (idle ${Math.round((now - last) / 60000)}min)`,
        );
      } catch (err) {
        this.host.log(`[ConversationManager] failed to close idle session ${sessionId}: ${err}`);
      }
    }

    return closed;
  }

  private resolveActiveSessionId(): string | null {
    try {
      return this.activeSessionProvider?.() ?? null;
    } catch {
      return null;
    }
  }

  /** 会话是否仍在工作（core 只读事实查询）；判定失败时保守视为「非空闲」 */
  private async isBusy(sessionId: string): Promise<boolean> {
    try {
      return !(await isSessionIdle(sessionId));
    } catch {
      return true;
    }
  }
}

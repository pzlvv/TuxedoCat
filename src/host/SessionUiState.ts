/**
 * SessionUiState - 宿主共享的「按会话」UI 运行时状态。
 *
 * 两个宿主实现此前各自维护同一套 Map（活动阶段 / 工具计数 / 查询计数），
 * 且已经出现行为分叉（Electron 侧没有活动阶段）。这里收敛为单一实现：
 *
 * - 活动阶段（idle / thinking / text / tool）：切换对话时恢复 thinking 动画用
 * - 工具并发计数：并发工具全部结束才回到 idle
 * - 查询计数：同一会话嵌套 begin/end 去重，保证只发一次 queryBegin/queryEnd
 *
 * abort 按钮可用性**不在这里**：它读 core 的 sessionRuntime（`sessionRuntimeStates`，
 * 见 sessionResources.isSessionIdle），webview 自己推导。
 *
 * 只保存状态与纯逻辑，不涉及任何宿主 API（推送 / 视图生命周期由宿主负责）。
 */

export type SessionActivityPhase = 'idle' | 'thinking' | 'text' | 'tool';

export class SessionUiState {
  private readonly activityPhases = new Map<string, SessionActivityPhase>();
  private readonly activeToolCounts = new Map<string, number>();
  private readonly queryActiveCounts = new Map<string, number>();

  // ===================== 活动阶段 =====================

  /** 当前活动阶段（未记录时为 idle） */
  getActivityPhase(sessionId: string): SessionActivityPhase {
    return this.activityPhases.get(sessionId) ?? 'idle';
  }

  /** 进入 thinking 阶段（LLM 思考 / 等待开始） */
  markThinking(sessionId: string): void {
    this.activityPhases.set(sessionId, 'thinking');
  }

  /** 进入 text 阶段（assistant 文本流式输出） */
  markText(sessionId: string): void {
    this.activityPhases.set(sessionId, 'text');
  }

  /** 进入 idle 阶段 */
  markIdle(sessionId: string): void {
    this.activityPhases.set(sessionId, 'idle');
  }

  /**
   * 工具开始（权限检查 / 工具调用）：
   * 递增并发计数并进入 tool 阶段。
   */
  beginToolPhase(sessionId: string): void {
    const count = (this.activeToolCounts.get(sessionId) ?? 0) + 1;
    this.activeToolCounts.set(sessionId, count);
    this.activityPhases.set(sessionId, 'tool');
  }

  /** 工具阶段中（不改变并发计数） */
  markToolPhase(sessionId: string): void {
    this.activityPhases.set(sessionId, 'tool');
  }

  /**
   * 工具结束：递减并发计数，全部结束后回到 idle。
   * 计数为 0 时调用属于重复结束，直接返回（不掩盖调用方问题，但也不破坏状态）。
   */
  endToolPhase(sessionId: string): void {
    const count = this.activeToolCounts.get(sessionId) ?? 0;
    if (count <= 0) return;
    const next = count - 1;
    if (next === 0) {
      this.activeToolCounts.delete(sessionId);
      this.activityPhases.set(sessionId, 'idle');
    } else {
      this.activeToolCounts.set(sessionId, next);
    }
  }

  // ===================== 查询计数 =====================

  /**
   * 查询开始。返回 true 表示这是该会话本轮的第一次 begin
   * （调用方据此决定是否发送 queryBegin / 显示 thinking）。
   */
  beginQuery(sessionId: string): boolean {
    const count = (this.queryActiveCounts.get(sessionId) ?? 0) + 1;
    this.queryActiveCounts.set(sessionId, count);
    return count === 1;
  }

  /**
   * 查询结束。返回 true 表示这是该会话本轮的最后一个 end
   * （调用方据此决定是否发送 queryEnd）。
   * 没有对应的 begin 时返回 false（重复 end）。
   */
  endQuery(sessionId: string): boolean {
    const count = this.queryActiveCounts.get(sessionId) ?? 0;
    if (count <= 0) return false;
    const next = count - 1;
    if (next > 0) {
      this.queryActiveCounts.set(sessionId, next);
      return false;
    }
    this.queryActiveCounts.delete(sessionId);
    return true;
  }

  /**
   * 该会话**自己的**查询是否在跑（收到 `queryBegin`、尚未收到 `queryEnd`）。
   *
   * 与 `getActivityPhase` 的区别：活动阶段在轮次之间会短暂回到 `idle`（每轮 `aiEnd`
   * 之后、下一次 `aiBegin` / 工具阶段之前），本方法在整个查询生命周期内恒为 true。
   *
   * 供宿主回答 `conversationLoaded.hasActiveQuery`（webview 据此恢复 thinking 动画）。
   * 不能用 core 的 `sessionRuntime.idle`——那是「会话非空闲」口径，包含后台子代理 /
   * 后台 Bash / 压缩，后台子代理在等用户时会让父会话 `idle=false`，重新加载父会话会
   * 误恢复出 thinking 动画（docs/hosts/webview-ui.md）。
   */
  isQueryActive(sessionId: string): boolean {
    return (this.queryActiveCounts.get(sessionId) ?? 0) > 0;
  }

  // ===================== 生命周期 =====================

  /**
   * 会话关闭 / 删除：移除该会话的全部 per-session 状态（防长期运行累积）。
   * 由 WebViewUI.closeConversation 调用（docs/hosts/webview-ui.md 第 1 节）。
   */
  dropSession(sessionId: string): void {
    this.activityPhases.delete(sessionId);
    this.activeToolCounts.delete(sessionId);
    this.queryActiveCounts.delete(sessionId);
  }
}

/**
 * Overlay 对话的部署闸门（specs/051 FR-003 / FR-004 / FR-008）。
 *
 * ## 为什么闸门在宿主侧
 *
 * FR-003 的判据读的是 **Core 的能力事实**（`isolatedWorkView` / `deployable`），而
 * webview 只是投影。把闸门放在 webview 会变成「前端决定是否上行」——wire 上仍会出现
 * 那条 `sendMessage`，Core 会真的建会话、真的落盘。因此拦截必须发生在
 * `WebviewMessageHandler.handleUserMessage` 里：能力不可用且可部署时，消息**不上行**，
 * 先进入部署流程。
 *
 * ## 状态机
 *
 * ```text
 * idle ──sendMessage(需要部署)──▶ confirm
 * confirm ──deploy──▶ running ──免密成功──▶ done ──▶ 重发被拦消息
 *                       │
 *                       └─免密不可用──▶ needsCredential ──提交密码──▶ running
 *                                          └─显示命令──▶ needsCredential(manualCommand)
 * running ──失败──▶ failed ──重试(不限次数)──▶ running
 * 任意态 ──cancel──▶ idle（会话保持空状态、消息留在输入框，FR-003）
 * ```
 *
 * 重试不设上限：认证能试几次由服务端策略（`pam_faillock` / `sudoers`）决定，宿主不替
 * 用户设闸门，也不假装知道还剩几次。
 *
 * ## 与 Core 的边界
 *
 * 部署成功**不自己判 ready**：本模块只把「装上且落点可用」告诉调用方，由调用方重新查询
 * `storageCapabilitiesRequested`（FR-008）。重启 Core 不再是必需步骤。
 */

/** 闸门的阶段（与 wire 消息 `mountProxyDeployState.phase` 同集合） */
export type MountProxyGatePhase = 'confirm' | 'running' | 'needsCredential' | 'failed' | 'done' | 'cancelled';

/** 推给 webview 的部署状态（wire 载荷的唯一来源） */
export interface MountProxyGateState {
  phase: MountProxyGatePhase;
  failure: string | null;
  manualCommand: string | null;
  targetHost: string | null;
  installPath: string;
}

/**
 * 被闸门拦下的**待续动作**：部署成功后原样继续（FR-008「用户不需要重发」）。
 *
 * 两种入口共用一个状态机，但成功后要做的事不同：发消息的入口重发那条消息，打开对话的
 * 入口继续加载那个对话（specs/052 FR-002）。用判别联合而不是可选字段——`content` 与
 * 「打开对话」互斥，可选字段会让两者同时成立、分派点无法穷尽（AGENTS.md 铁律 4.2）。
 */
export type BlockedAction =
  | { kind: 'message'; sessionId: string; content: string }
  | { kind: 'openConversation'; sessionId: string };

/**
 * 闸门持有的一次部署会话。
 *
 * 生命周期与「一个待续动作」绑定：取消或继续完成后整体清空，不跨动作复用。
 */
export class MountProxyGate {
  private phase: MountProxyGatePhase | null = null;
  private blocked: BlockedAction | null = null;
  private manualCommandShown = false;

  constructor(
    private readonly options: {
      /** 安装落点（文案用，FR-003 四要素之一） */
      installPath: string;
      /** 目标主机（远端场景点名真实主机；本机为 `null`） */
      targetHost: string | null;
      /** 推状态给 webview */
      emit: (state: MountProxyGateState) => void;
    },
  ) {}

  /** 当前阶段；`null` 表示没有进行中的部署 */
  get currentPhase(): MountProxyGatePhase | null {
    return this.phase;
  }

  /** 被拦下的待续动作（部署成功后由调用方取出继续） */
  takeBlocked(): BlockedAction | null {
    const blocked = this.blocked;
    this.blocked = null;
    return blocked;
  }

  /**
   * 读被拦下的待续动作但**不清空**（取消时回填输入框用）。
   *
   * 与 `takeBlocked` 分开：取消路径要先把内容送回界面、再让 `cancel()` 清状态，
   * 用 `takeBlocked` 会提前拿走、`cancel()` 里就什么都不剩了。
   */
  peekBlocked(): BlockedAction | null {
    return this.blocked;
  }

  /**
   * 拦下一个待续动作并进入确认态（FR-003）。
   *
   * 调用方已判定「能力不可用且 deployable」，因此这里不再接收能力参数——判据只有一处
   * （`WebviewMessageHandler` 读 Core 事实的地方），不在这里重算。
   */
  block(blocked: BlockedAction): void {
    this.blocked = blocked;
    this.manualCommandShown = false;
    this.phase = 'confirm';
    this.emitState({});
  }

  /** 用户确认部署（FR-003 → FR-004） */
  confirmDeploy(): void {
    if (this.phase !== 'confirm' && this.phase !== 'failed') return;
    this.phase = 'running';
    this.emitState({});
  }

  /** 免密不可用，进入三选一（FR-004 第 2 条） */
  requireCredential(manualCommand: string): void {
    this.phase = 'needsCredential';
    this.manualCommandShown = false;
    this.emitState({ manualCommand });
  }

  /** 用户选择「显示命令自己执行」（零密码通道，AC-12） */
  showManualCommand(manualCommand: string): void {
    this.phase = 'needsCredential';
    this.manualCommandShown = true;
    this.emitState({ manualCommand });
  }

  /** 用户选择了密码来源：回到 running 等宿主执行 */
  beginCredentialAttempt(): void {
    this.phase = 'running';
    this.emitState({});
  }

  /** 一轮失败（FR-004 第 5 条）：失败原因回显，仍可换一条来源再试或取消 */
  fail(failure: string): void {
    this.phase = 'failed';
    this.emitState({ failure });
  }

  /** 部署成功（FR-008）：状态推 `done`，待续动作由调用方 `takeBlocked()` 取走继续 */
  succeed(): void {
    this.phase = 'done';
    this.emitState({});
  }

  /**
   * 用户取消（FR-003）：不创建对话、不发送消息、不执行提权、不写文件。
   *
   * 状态整体清空——下次再发消息重新走一遍确认。
   */
  cancel(): void {
    // 先把 `cancelled` 推给界面再清内部状态：webview 只在收到本消息时改变对话框，
    // 不发这一条的话界面会一直停在取消前的那一态（FR-003 的 AC-9）。
    this.phase = 'cancelled';
    this.emitState({});
    this.phase = null;
    this.blocked = null;
    this.manualCommandShown = false;
  }

  /** 拼一份 wire 载荷（其余字段从实例状态派生，避免多处各写一份默认值） */
  private emitState(overrides: { failure?: string; manualCommand?: string }): void {
    const phase = this.phase;
    if (phase === null) return;
    this.options.emit({
      phase,
      // 失败原因只在 failed 时有值（契约成员全必选，不适用用 null）
      failure: phase === 'failed' ? (overrides.failure ?? null) : null,
      // 零密码命令只在用户请求展示时下发，且只在 needsCredential 态有意义
      manualCommand:
        phase === 'needsCredential' && this.manualCommandShown
          ? (overrides.manualCommand ?? null)
          : null,
      targetHost: this.options.targetHost,
      installPath: this.options.installPath,
    });
  }
}

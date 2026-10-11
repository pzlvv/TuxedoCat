/**
 * CoreDaemon - Host 侧的 daemon 客户端（`docs/core/core-daemon.md`）。
 *
 * 一个 endpoint 一个 daemon：daemon 是目标机器上的常驻服务（由 `start` 拉起），
 * 只监听目标机器的回环地址，Host 经 SSH 转发连它的 TCP 控制通道。
 * 每个工作区对应控制通道上的一条逻辑 channel；`openChannel` 同步返回传输层对象，
 * 内部异步完成「连上 daemon → openWorkspace → channel 建立」，
 * 建立之前发出的帧按序排队（daemon 侧在 Core 进程起来前也会排队）。
 *
 * 重启责任在 daemon：Core 崩溃后 daemon 在同一 channel 上重启并回 `channelReset`；
 * 本模块把它翻译成「连接重置」——重新发 `hello`、等 `ready`、再通知总线。
 * 重启次数超限时 daemon 回 `workspaceClosed(reason=failed)`，本模块报告 fatal。
 *
 * 链路心跳（`docs/core/core-daemon.md` 第 12.5 节）：链路就绪后定期发 `ping`。
 * Host 消失而 TCP 未断（断网 / 休眠 / 进程冻结）时 daemon 读不到 EOF，只能靠
 * 控制帧的沉默判死；Host 定期发帧，daemon 才能区分「活着的静默」与「已死」。
 *
 * 沉默判定是同一件事的对称面：daemon 回 `pong`，Host 见到首个 pong 武装沉默死线——
 * 这么长时间没有任何入站帧即补发探针 ping 再宽限一次，仍无入站就断开链路并按
 * fatal 上报。daemon 死而 socket 未断（对端断电 / 网络分区）时 socket 层没有任何
 * 信号，这是 Host 在 3s 内感知断连的唯一手段。
 *
 * 背压：控制通道的出站帧进有序队列，socket 返回 false 时等 `drain`；
 * 越过软水位只记录诊断，不丢帧、不合并帧。
 */

import {
  CORE_PROTOCOL_VERSION,
  FrameDecoder,
  isCoreToUiFrame,
  type CoreToUiFrame,
  type UiToCoreFrame,
} from './protocol.js';
import {
  encodeDaemonFrame,
  isDaemonToHostFrame,
  type ChannelDescriptor,
  type DirectoryFailureReason,
  type DirectoryListing,
  type WorkspaceCloseReason,
} from './daemonProtocol.js';
import {
  NOOP_CORE_CHANNEL_HOOKS,
  type CoreChannelHooks,
  type CoreChannelTransport,
} from './StandaloneEventBus.js';
import type { WorkspaceRef } from '../workspaceRef.js';

/** 出站队列软水位：越过只记录诊断，不丢帧 */
const OUTBOX_WARN_THRESHOLD = 10_000;
/**
 * 链路心跳间隔（`docs/core/core-daemon.md` 第 12.5 节）。
 *
 * daemon 以「最近一次收到控制帧」判定链路死活（60s 空闲回收）：daemon 自己不发帧，
 * Host 不定期发心跳的话，它没有任何手段区分「活着的静默」与「已死而 TCP 未断」。
 * 链路就绪后开始发，未就绪不发。间隔取 1s：Host 侧的沉默判定要求断连在 3s 内
 * 落成 fatal（见 `LINK_SILENCE_DEADLINE_MS`），探针与 pong 都按这个节奏往返。
 */
const DAEMON_HEARTBEAT_INTERVAL_MS = 1_000;
/**
 * Host 侧沉默判定（`docs/core/core-daemon.md` 第 12.5 节）：链路上这么长时间没有任何
 * 入站帧即疑似断连。daemon 死而 socket 未断（对端断电 / 网络分区，等不到 EOF/RST）、
 * daemon 进程卡死，socket 层都没有任何信号，唯一依据是 pong 的有无。
 *
 * 见过首个 `pong` 才武装：链路刚建立时还没有任何入站帧，武装时机放在首个 pong
 * 之后。到期不直接判死：补发一帧探针 ping，再等
 * `LINK_SILENCE_RECHECK_MS`，期间任何入站帧都算活——本进程卡顿（定时器迟到、
 * 入站帧积压在内核缓冲）不误杀活链路。判死上限 = 死线 + 宽限 ≤ 3s。
 */
const LINK_SILENCE_DEADLINE_MS = 2_500;
/** 沉默探针的宽限：探针 ping 发出后等这么久，仍无入站帧才判死 */
const LINK_SILENCE_RECHECK_MS = 400;
/** 握手超时默认值（Core 进程启动后未回 `ready` 视为失败） */
export const DEFAULT_DAEMON_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 控制通道就绪超时默认值（连不上 / daemon 无应答） */
export const DEFAULT_DAEMON_LINK_TIMEOUT_MS = 10_000;
/**
 * SSH 接入的建链超时。
 *
 * SSH 建链包含「连 SSH → 探测 / 上传产物 → 启动 daemon → 转发」，首次接入要上传
 * 产物并等 daemon 启动，比后续接入慢一个量级，不能沿用 10s。
 */
export const SSH_DAEMON_LINK_TIMEOUT_MS = 120_000;
/** 关闭 channel / daemon 的等待上限 */
export const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
/** 仅断链（disconnect，不发 shutdown）时等本地链路退出的宽限；超时 kill 兜底 */
export const DAEMON_DISCONNECT_GRACE_MS = 2_000;

/**
 * 目录操作（列举 / 新建 / 删除）失败。
 *
 * 除了错误文本还带上 daemon 给的 `reason`：`notEmpty` 是可继续的失败——调用方据此
 * 提示「目录非空，连同内容一起删除？」。靠匹配错误文本分支会在改文案时静默失效。
 */
export class DirectoryOperationError extends Error {
  constructor(
    message: string,
    readonly reason: DirectoryFailureReason,
  ) {
    super(message);
    this.name = 'DirectoryOperationError';
  }
}

/**
 * 控制通道的链路（Host 侧）。
 *
 * 连接一个已经在监听的 daemon（`docs/core/core-daemon.md` 第 12 节）；本地同机工作区
 * 不走 daemon：`bootstrapCore` 直接用 `stdio` 动作起单进程 Core（stdio 帧通道，
 * 无端口，见 `createStandaloneCoreBus`）。
 *
 * `write` 返回 false 表示背压（数据已被接受，等 `drain` 再继续）；
 * `end` 是 shutdown 帧之后的优雅关闭，`kill` 是超时强杀。
 * 入站数据与链路结束都用订阅式接口：建链是异步的，入站帧也走 `onData`。
 */
export interface CoreDaemonLink {
  write(line: string): boolean;
  onceDrain(listener: () => void): void;
  end(): void;
  kill(): void;
  /** 订阅入站数据（建链完成后立即挂上，不丢帧） */
  onData(listener: (chunk: string) => void): void;
  /** 订阅链路结束（正常断开 / 出错 / 被杀） */
  onClose(listener: () => void): void;
}

/**
 * 控制通道建链器（`docs/core/core-daemon.md` 第 12 节）。
 *
 * 唯一实现是 `createSshDaemonOpener`（`sshTransport.ts`）：全部通信走 SSH 端口，
 * 远端 daemon 的 endpoint 由引导流程从远端状态文件取得（`sshDaemonBootstrap.ts`）。
 *
 * 失败时 reject：直接上报，不做「先连上再说」的降级（``docs/architecture/principles.md`）。
 */
export interface CoreDaemonLinkOpener {
  open(): Promise<CoreDaemonLink>;
  /**
   * 建链前的准备（SSH 实现为引导远端 daemon——发现 / 部署 / 启动）。
   *
   * 探测方（`probeRemoteEndpoint`）先跑它再开始计时：部署可能远超探测的短超时，
   * 计时只该覆盖「daemon 就绪之后的建链」。实现必须幂等——`open()` 自己会再走一遍
   * 引导，此时 daemon 已就绪，是快路径。无远端准备工作的形态给 no-op 实现
   * 并注明理由（TCP 直连 socket 连上即就绪，没有准备步骤）。
   */
  prepare(): Promise<void>;
  /** 释放底层资源（SSH 连接等）；幂等 */
  dispose(): void;
}

export interface CoreDaemonOptions {
  transport: CoreDaemonLinkOpener;
  log: (...args: unknown[]) => void;
  handshakeTimeoutMs?: number;
  /** 控制通道就绪超时；缺省用 `DEFAULT_DAEMON_LINK_TIMEOUT_MS`（SSH 接入要放宽） */
  linkTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** 链路心跳间隔；缺省 `DAEMON_HEARTBEAT_INTERVAL_MS`（测试注入更短的间隔） */
  heartbeatIntervalMs?: number;
  /** 沉默判定死线（毫秒）；缺省 `LINK_SILENCE_DEADLINE_MS`（测试注入更短的死线） */
  silenceDeadlineMs?: number;
  /** 沉默探针宽限（毫秒）；缺省 `LINK_SILENCE_RECHECK_MS` */
  silenceRecheckMs?: number;
}

/** 一条 daemon channel 的传输层实现（Host 侧） */
class DaemonChannel implements CoreChannelTransport {
  hooks: CoreChannelHooks = NOOP_CORE_CHANNEL_HOOKS;

  private channelId: number | null = null;
  private ready = false;
  /** 已请求关闭（stop() 之后不再发送 / 握手） */
  private stopping = false;
  /** 通道已终止（workspaceClosed / daemon 消失 / 打开失败） */
  private stopped = false;
  private failed = false;
  /** channel 建立前排队的出站帧 */
  private readonly outbox: UiToCoreFrame[] = [];
  private handshakeTimer: NodeJS.Timeout | null = null;
  /** 等待 `workspaceClosed` 的关闭者 */
  private closedWaiters: Array<() => void> = [];

  constructor(
    private readonly daemon: CoreDaemon,
    readonly workspaceRef: WorkspaceRef,
  ) {}

  // ===================== CoreChannelTransport =====================

  start(): void {
    this.daemon.requestOpen(this);
  }

  send(frame: UiToCoreFrame): void {
    if (this.stopping || this.stopped || this.failed) return;
    if (this.channelId === null) {
      this.outbox.push(frame);
      return;
    }
    this.daemon.sendChannelFrame(this.channelId, frame);
  }

  async stop(): Promise<void> {
    if (this.stopping || this.stopped) return;
    this.stopping = true;
    this.clearHandshakeTimer();
    const channelId = this.channelId;
    if (channelId !== null) {
      await this.daemon.closeChannel(channelId);
    }
    this.stopped = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  // ===================== daemon 回调 =====================

  /** `workspaceOpened`：channel 建立，发 hello 并等待 ready */
  handleOpened(channelId: number, _descriptor: ChannelDescriptor): void {
    if (this.stopping || this.stopped || this.failed) {
      // 打开尚未完成时宿主已经放弃（关闭工作区）：把 daemon 侧的 Core 一并关掉
      void this.daemon.closeChannel(channelId);
      return;
    }
    this.channelId = channelId;
    this.sendHello();
    const queued = this.outbox.splice(0, this.outbox.length);
    for (const frame of queued) this.daemon.sendChannelFrame(channelId, frame);
  }

  /** `workspaceFailed`：Core 进程没起来，channel 不存在 */
  handleOpenFailed(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.hooks.onFatal(error);
  }

  handleFrame(frame: CoreToUiFrame): void {
    if (this.stopping || this.stopped || this.failed) return;
    if (frame.kind === 'ready') {
      this.clearHandshakeTimer();
      this.ready = true;
      this.hooks.onReady();
      return;
    }
    this.hooks.onFrame(frame);
  }

  /** `channelReset`：Core 崩溃后在同一 channel 上重启，重新握手 */
  handleReset(reason: string): void {
    if (this.stopping || this.stopped || this.failed) return;
    this.hooks.onDiagnostic(`[daemon] channel reset: ${reason}`);
    const wasReady = this.ready;
    this.ready = false;
    if (wasReady) this.hooks.onNotReady();
    this.sendHello();
  }

  /** `workspaceClosed`：channel 关闭（Host 主动 / 重启超限 / daemon 清理） */
  handleClosed(reason: WorkspaceCloseReason): void {
    this.clearHandshakeTimer();
    const wasReady = this.ready;
    this.ready = false;
    this.stopped = true;
    const expected = reason === 'closed';
    if (wasReady) this.hooks.onNotReady();
    this.resolveClosedWaiters();
    this.hooks.onExit({ code: null, signal: null, expected });
    if (!expected && !this.failed) {
      this.failed = true;
      this.hooks.onFatal(new Error(`Core channel closed: ${reason}`));
    }
  }

  /** daemon 进程消失（崩溃 / 被关闭）：该 daemon 上的全部 channel 一起失败 */
  handleDaemonGone(error: Error): void {
    this.clearHandshakeTimer();
    this.ready = false;
    this.stopped = true;
    this.resolveClosedWaiters();
    if (!this.failed) {
      this.failed = true;
      this.hooks.onFatal(error);
    }
  }

  /** 等待 `workspaceClosed`；超时后返回（daemon 侧仍会强制结束 Core） */
  waitClosed(timeoutMs: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.removeClosedWaiter(finish);
        finish();
      }, timeoutMs);
      timer.unref();
      this.closedWaiters.push(finish);
    });
  }

  private resolveClosedWaiters(): void {
    const waiters = this.closedWaiters.splice(0, this.closedWaiters.length);
    for (const waiter of waiters) waiter();
  }

  private removeClosedWaiter(waiter: () => void): void {
    const index = this.closedWaiters.indexOf(waiter);
    if (index >= 0) this.closedWaiters.splice(index, 1);
  }

  // ===================== 内部 =====================

  private sendHello(): void {
    if (this.channelId === null) return;
    this.daemon.sendChannelFrame(this.channelId, {
      kind: 'hello',
      protocol: CORE_PROTOCOL_VERSION,
    });
    this.startHandshakeTimer();
  }

  private startHandshakeTimer(): void {
    this.clearHandshakeTimer();
    const timeoutMs = this.daemon.handshakeTimeoutMs();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ready || this.stopping || this.stopped || this.failed) return;
      this.hooks.onDiagnostic(
        `[daemon] channel handshake timed out after ${timeoutMs}ms; closing channel`,
      );
      const channelId = this.channelId;
      this.stopped = true;
      this.failed = true;
      if (channelId !== null) void this.daemon.closeChannel(channelId);
      this.hooks.onFatal(new Error('Core handshake timed out.'));
    }, timeoutMs);
    this.handshakeTimer.unref();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }
}

/**
 * Host 侧 daemon 客户端。
 *
 * `openChannel` 同步返回；控制通道在第一次需要时连接。
 */
export class CoreDaemon {
  private writer: CoreDaemonLink | null = null;
  /** 建链中（`open()` 尚未 settle）：重复调用 `ensureStarted` 不再发起新的建链 */
  private opening = false;
  /**
   * 建链代次：每次建链自增。超时 / 关闭时再自增一次，作废在途的 `open()`——
   * 否则慢连接会在已经上报失败之后又把链路挂回来。
   */
  private linkAttempt = 0;
  /** 控制通道是否可写出：链路建立即可写 */
  private linkReady = false;
  private readonly decoder: FrameDecoder;
  private readonly log: (...args: unknown[]) => void;
  private stopped = false;
  private shuttingDown = false;
  /** socket 退出是否已处理（`close` 只处理一次） */
  private exitHandled = false;
  private nextRequestId = 1;
  /** 出站帧队列（控制通道未就绪 / 背压时排队） */
  private readonly outbox: string[] = [];
  private waitingDrain = false;
  /** 已建立 channel：channelId → transport */
  private readonly channels = new Map<number, DaemonChannel>();
  /** 已发出、尚未收到应答的 openWorkspace：requestId → transport */
  private readonly openingRequests = new Map<number, DaemonChannel>();
  /** 已发出、尚未收到应答的目录操作（列举 / 新建 / 删除）：requestId → 等待者 */
  private readonly directoryRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** 控制通道建立前的等待者 */
  private linkWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private exitWaiters: Array<() => void> = [];
  /** 控制通道就绪超时（连接 / daemon 应答） */
  private linkTimer: NodeJS.Timeout | null = null;
  /** 链路心跳定时器（链路就绪后启动，链路退出即停） */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** 最近一次入站控制帧的时刻（沉默判定的时间基准） */
  private lastInboundAt: number | null = null;
  /** 沉默判定是否已武装（见到首个 pong 才武装） */
  private silenceArmed = false;
  private silenceTimer: NodeJS.Timeout | null = null;
  private recheckTimer: NodeJS.Timeout | null = null;
  /** 沉默判死的原因：看门狗 kill 链路后由 handleExit 用它替换默认 fatal 文案 */
  private silenceFatal: Error | null = null;

  constructor(private readonly options: CoreDaemonOptions) {
    this.log = options.log;
    this.decoder = new FrameDecoder({
      onFrame: (value) => this.handleFrame(value),
      onError: (error) => this.log(`[daemon] malformed frame: ${error.message}`),
    });
  }

  handshakeTimeoutMs(): number {
    return this.options.handshakeTimeoutMs ?? DEFAULT_DAEMON_HANDSHAKE_TIMEOUT_MS;
  }

  /**
   * 建立控制通道并等待可写出。
   *
   * 远程目录选择器在打开任何工作区之前就要连接，因此单独暴露这个入口。
   */
  async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error('Core daemon has been shut down.');
    if (!this.ensureStarted()) throw new Error('Core daemon failed to connect.');
    if (this.linkReady) return;
    return new Promise<void>((resolve, reject) => {
      this.linkWaiters.push({ resolve, reject });
    });
  }

  /** 列出目标机器上的子目录（远程目录选择器用；`path` 为 null 时从主目录开始） */
  async listDirectories(path: string | null): Promise<DirectoryListing> {
    await this.ensureConnected();
    return new Promise<DirectoryListing>((resolve, reject) => {
      const id = this.nextDirectoryRequestId();
      this.directoryRequests.set(id, {
        resolve: (value) => resolve(value as DirectoryListing),
        reject,
      });
      this.enqueue(encodeDaemonFrame({ kind: 'listDirectories', id, path }));
    });
  }

  /** 在目标机器上新建目录（父目录不存在时一并创建），返回实际路径 */
  async createDirectory(path: string): Promise<string> {
    await this.ensureConnected();
    return new Promise<string>((resolve, reject) => {
      const id = this.nextDirectoryRequestId();
      this.directoryRequests.set(id, {
        resolve: (value) => resolve((value as { path: string }).path),
        reject,
      });
      this.enqueue(encodeDaemonFrame({ kind: 'createDirectory', id, path }));
    });
  }

  /**
   * 重命名目标机器上的目录（只改同一父目录下的名字），返回新路径。
   *
   * `name` 是纯名字：daemon 会拒绝带分隔符 / `.` / `..` 的名字，以及已存在的目标。
   */
  async renameDirectory(path: string, name: string): Promise<string> {
    await this.ensureConnected();
    return new Promise<string>((resolve, reject) => {
      const id = this.nextDirectoryRequestId();
      this.directoryRequests.set(id, {
        resolve: (value) => resolve((value as { path: string }).path),
        reject,
      });
      this.enqueue(encodeDaemonFrame({ kind: 'renameDirectory', id, path, name }));
    });
  }

  /**
   * 删除目标机器上的目录，返回实际路径。
   *
   * `recursive` 为 `false` 时只接受空目录：非空会以 `DirectoryOperationError`
   * （`reason === 'notEmpty'`）失败，调用方据此提示「连同内容一起删除」。
   */
  async deleteDirectory(path: string, recursive: boolean): Promise<string> {
    await this.ensureConnected();
    return new Promise<string>((resolve, reject) => {
      const id = this.nextDirectoryRequestId();
      this.directoryRequests.set(id, {
        resolve: (value) => resolve((value as { path: string }).path),
        reject,
      });
      this.enqueue(encodeDaemonFrame({ kind: 'deleteDirectory', id, path, recursive }));
    });
  }

  /** 取下一个目录操作请求 id */
  private nextDirectoryRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id;
  }

  /** 打开一个 channel（同步返回；内部异步连接 daemon 并起 Core） */
  openChannel(ref: WorkspaceRef): CoreChannelTransport {
    if (this.stopped) throw new Error('Core daemon has been shut down.');
    return new DaemonChannel(this, ref);
  }

  /** 请求打开工作区（`DaemonChannel.start()` 调用） */
  requestOpen(channel: DaemonChannel): void {
    if (this.stopped) {
      channel.handleOpenFailed(new Error('Core daemon has been shut down.'));
      return;
    }
    // 先登记再连接：连不上 daemon 时 `fatalAll` 能把失败回给这条 channel
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.openingRequests.set(id, channel);
    if (!this.ensureStarted()) return; // 连接失败：已由 fatalAll 结束
    this.enqueue(
      encodeDaemonFrame({ kind: 'openWorkspace', id, workspaceRef: channel.workspaceRef }),
    );
  }

  /** 转发一帧内层帧到指定 channel */
  sendChannelFrame(channelId: number, frame: UiToCoreFrame): void {
    if (this.stopped) return;
    this.enqueue(encodeDaemonFrame({ kind: 'frame', channel: channelId, frame }));
  }

  /** 关闭一个 channel（发 `closeWorkspace`，等 `workspaceClosed` 或超时） */
  async closeChannel(channelId: number): Promise<void> {
    const channel = this.channels.get(channelId);
    this.enqueue(encodeDaemonFrame({ kind: 'closeWorkspace', channel: channelId }));
    if (!channel) return;
    await channel.waitClosed(this.options.shutdownTimeoutMs ?? DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS);
  }

  /**
   * 仅断开本机的控制通道，**不发 `shutdown` 帧**（宿主正常退出用）。
   *
   * `shutdown` 帧在 daemon 侧是全局停机：任一连接收到即结束全部 Core——多客户端
   * 并发接入下（`docs/core/core-daemon.md` 第 12.5 节），一台宿主退出会连坐杀掉其它
   * 客户端的会话。SSH 引导的 daemon 自带 `--idle-exit`：最后一条控制链路断开后
   * 空闲计时到期自行退出并清状态文件，宿主退出只需优雅关闭自己的链路。
   * 显式「杀 daemon」仍走 `shutdown`（kill 协议 / 换血流程）。
   */
  async disconnect(): Promise<void> {
    if (this.stopped) {
      this.options.transport.dispose();
      return;
    }
    this.stopped = true;
    this.clearLinkTimeout();
    this.stopHeartbeat();
    this.stopLinkWatchdog();
    this.silenceFatal = null;
    this.linkAttempt += 1;
    const writer = this.writer;
    if (writer) {
      // 优雅关闭链路（不发帧）：daemon 侧按断开处理，空闲计时起算
      writer.end();
      try {
        await this.waitForExit(DAEMON_DISCONNECT_GRACE_MS);
      } catch {
        // 本地链路退出超时：下面 kill 兜底
      }
    }
    try {
      writer?.kill();
    } catch {
      // 已断开
    }
    this.options.transport.dispose();
    const leftovers = [...this.channels.values()];
    this.channels.clear();
    this.openingRequests.clear();
    for (const channel of leftovers) {
      channel.handleDaemonGone(new Error('daemon disconnected by host'));
    }
  }

  /** 关闭控制通道：`shutdown` 帧 → 等链路退出 → 超时强制断开 */
  async shutdown(): Promise<void> {
    if (this.stopped) {
      this.options.transport.dispose();
      return;
    }
    this.stopped = true;
    this.shuttingDown = true;
    this.clearLinkTimeout();
    this.stopHeartbeat();
    this.stopLinkWatchdog();
    this.silenceFatal = null;
    // 建链还没回来：作废它，避免关闭后又挂上一条链路
    this.linkAttempt += 1;
    const writer = this.writer;
    if (writer) {
      try {
        writer.write(encodeDaemonFrame({ kind: 'shutdown' }));
      } catch {
        // 已退出：无需再发
      }
      // 主动结束链路，否则对端会一直等下一帧
      writer.end();
      await this.waitForExit(this.options.shutdownTimeoutMs ?? DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS);
    }
    // 优雅关闭未生效 / 连接尚未建立时，也不留悬挂的链路
    try {
      writer?.kill();
    } catch {
      // 已断开
    }
    // SSH 接入：控制通道只是这条 SSH 连接上的一条转发通道，一并释放
    this.options.transport.dispose();
    // daemon 退出后仍未收到 workspaceClosed 的 channel：一起失败
    const leftovers = [...this.channels.values()];
    this.channels.clear();
    this.openingRequests.clear();
    for (const channel of leftovers) {
      channel.handleDaemonGone(new Error('Core daemon has been shut down.'));
    }
  }

  // ===================== 内部：控制通道 =====================

  /** 确保控制通道已建立；返回 false 表示失败（失败已通过 fatalAll 上报） */
  private ensureStarted(): boolean {
    if (this.stopped) return false;
    if (this.writer || this.opening) return true;
    this.opening = true;
    const attempt = ++this.linkAttempt;
    this.armLinkTimeout('Core daemon connection');
    this.options.transport.open().then(
      (link) => {
        if (attempt !== this.linkAttempt || this.stopped) {
          // 已经超时 / 关闭：这条链路来晚了，直接放掉
          link.kill();
          return;
        }
        this.opening = false;
        // 上一次链路已经结束过：这次是新链路，退出要重新算一次
        this.exitHandled = false;
        this.writer = link;
        link.onData((chunk) => this.decoder.push(chunk));
        link.onClose(() => this.handleExit());
        // 链路建立即可写：清掉就绪超时、开始心跳，放行排队的帧
        this.clearLinkTimeout();
        this.linkReady = true;
        this.startHeartbeat();
        const waiters = this.linkWaiters;
        this.linkWaiters = [];
        for (const waiter of waiters) waiter.resolve();
        this.flushOutbox();
      },
      (error: unknown) => {
        if (attempt !== this.linkAttempt) return;
        this.opening = false;
        this.failPendingLink(toError(error));
      },
    );
    return true;
  }

  /**
   * 控制通道就绪超时（连不上 / daemon 无应答）。
   *
   * 超时后把等待者与已登记 channel 一起失败，并断开链路，不静默挂起。
   */
  private armLinkTimeout(label: string): void {
    this.clearLinkTimeout();
    const timeoutMs = this.options.linkTimeoutMs ?? DEFAULT_DAEMON_LINK_TIMEOUT_MS;
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      if (this.linkReady || this.exitHandled) return;
      const error = new Error(
        `${label} timed out after ${timeoutMs}ms. `
        + 'The remote daemon may still be held by a stale connection; '
        + 'retry in a minute, or stop it on the remote machine and reconnect.',
      );
      this.log(`[daemon] ${error.message}`);
      // 作废在途建链：慢连接不能在失败上报之后又把链路挂回来
      this.linkAttempt += 1;
      this.opening = false;
      this.failPendingLink(error);
      // 随后的 kill 会触发链路 close：那是超时的预期结果，不要让它以
      // 「exited unexpectedly」盖掉真正的失败原因
      this.exitHandled = true;
      this.writer?.kill();
    }, timeoutMs);
    this.linkTimer.unref();
  }

  private clearLinkTimeout(): void {
    if (this.linkTimer) {
      clearTimeout(this.linkTimer);
      this.linkTimer = null;
    }
  }

  // ===================== 内部：链路心跳 =====================

  /**
   * 启动链路心跳（链路就绪后）：定期发 `ping`，daemon 以「最近一次收到控制帧」
   * 判定链路死活，沉默超过它的心跳超时即按断开处理并回收全部 Core
   * （`docs/core/core-daemon.md` 第 12.5 节）。帧走 `enqueue`，与业务帧同序。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const interval = this.options.heartbeatIntervalMs ?? DAEMON_HEARTBEAT_INTERVAL_MS;
    const timer = setInterval(() => {
      if (this.stopped || !this.linkReady) return;
      this.enqueue(encodeDaemonFrame({ kind: 'ping' }));
    }, interval);
    timer.unref();
    this.heartbeatTimer = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ===================== 内部：沉默判定 =====================

  /**
   * 任何入站控制帧都证明链路活着：前移沉默判定的时间基准。
   * 探针宽限期内（`silenceTimer` 为 null，控制权在 recheck）不重排常规检查，
   * 由 `finishSilenceRecheck` 统一收口。
   */
  private noteInbound(): void {
    this.lastInboundAt = Date.now();
    if (this.silenceArmed && this.silenceTimer) this.scheduleSilenceCheck();
  }

  /** 武装沉默判定（首个 pong 到达时）；时间基准由 `noteInbound` 刚前移过 */
  private armSilenceWatchdog(): void {
    if (this.silenceArmed) return;
    this.silenceArmed = true;
    this.scheduleSilenceCheck();
  }

  /** 按最近入站时刻排沉默检查；时间基准每次前移都重排 */
  private scheduleSilenceCheck(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (!this.silenceArmed || this.lastInboundAt === null) return;
    const deadlineMs = this.options.silenceDeadlineMs ?? LINK_SILENCE_DEADLINE_MS;
    const remaining = this.lastInboundAt + deadlineMs - Date.now();
    if (remaining <= 0) {
      this.beginSilenceRecheck();
      return;
    }
    const timer = setTimeout(() => this.beginSilenceRecheck(), remaining);
    timer.unref();
    this.silenceTimer = timer;
  }

  /**
   * 沉默到期：补发一帧探针 ping，宽限 `silenceRecheckMs` 后再判。
   * 链路活着的话 pong 在一个 RTT 内回来；不宽限直接判死，会把本进程卡顿
   * （定时器迟到、入站帧积压在内核缓冲等先于定时器入队）误报成断连。
   */
  private beginSilenceRecheck(): void {
    if (this.stopped || !this.linkReady || !this.silenceArmed) return;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.enqueue(encodeDaemonFrame({ kind: 'ping' }));
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    const recheckMs = this.options.silenceRecheckMs ?? LINK_SILENCE_RECHECK_MS;
    const timer = setTimeout(() => this.finishSilenceRecheck(recheckMs), recheckMs);
    timer.unref();
    this.recheckTimer = timer;
  }

  /**
   * 宽限期收口：期间来过任何帧（探针的 pong / 业务帧）就算活，回到常规沉默检查；
   * 仍无入站即判死。kill 触发链路 close，handleExit 以 `silenceFatal` 上报 fatal，
   * 不落在「exited unexpectedly」的默认文案上。
   */
  private finishSilenceRecheck(recheckMs: number): void {
    if (this.stopped || !this.linkReady || !this.silenceArmed) return;
    const silentFor = this.lastInboundAt === null
      ? Number.POSITIVE_INFINITY
      : Date.now() - this.lastInboundAt;
    if (silentFor < recheckMs) {
      this.scheduleSilenceCheck();
      return;
    }
    const deadlineMs = this.options.silenceDeadlineMs ?? LINK_SILENCE_DEADLINE_MS;
    this.silenceFatal = new Error(
      `Remote Core link has been silent for ${deadlineMs + recheckMs}ms (no pong); `
      + 'declaring it dead. The remote daemon or the network path is gone.',
    );
    this.log(`[daemon] ${this.silenceFatal.message}`);
    this.stopLinkWatchdog();
    this.writer?.kill();
  }

  /** 停掉沉默判定（链路退出 / 关闭时）；下次建链后由 pong 重新武装 */
  private stopLinkWatchdog(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.recheckTimer) {
      clearTimeout(this.recheckTimer);
      this.recheckTimer = null;
    }
    this.silenceArmed = false;
  }

  /** 连接建立失败：拒绝未决的建链 / 目录请求，并把已登记的 channel 一起失败 */
  private failPendingLink(error: Error): void {
    const linkWaiters = this.linkWaiters;
    this.linkWaiters = [];
    for (const waiter of linkWaiters) waiter.reject(error);
    const directoryRequests = [...this.directoryRequests.values()];
    this.directoryRequests.clear();
    for (const request of directoryRequests) request.reject(error);
    this.fatalAll(error);
  }

  private handleExit(): void {
    if (this.exitHandled) return; // close 只处理一次
    this.exitHandled = true;
    this.clearLinkTimeout();
    this.stopHeartbeat();
    this.stopLinkWatchdog();
    this.opening = false;
    this.writer = null;
    this.linkReady = false;
    this.waitingDrain = false;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();
    // 未完成的建链 / 目录请求：连接没了，一律失败
    const linkWaiters = this.linkWaiters;
    this.linkWaiters = [];
    for (const waiter of linkWaiters) waiter.reject(new Error('Core daemon exited.'));
    const directoryRequests = [...this.directoryRequests.values()];
    this.directoryRequests.clear();
    for (const request of directoryRequests) request.reject(new Error('Core daemon exited.'));

    if (this.shuttingDown || this.stopped) return;
    if (this.silenceFatal) {
      // 沉默判死的 kill：原因已在看门狗处记录，不再以「exited unexpectedly」盖掉
      const fatal = this.silenceFatal;
      this.silenceFatal = null;
      this.fatalAll(fatal);
      return;
    }
    this.log('[daemon] exited unexpectedly');
    this.fatalAll(new Error('Core daemon exited unexpectedly.'));
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitHandled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.writer?.kill();
        resolve();
      }, timeoutMs);
      timer.unref();
      this.exitWaiters.push(finish);
    });
  }

  private fatalAll(error: Error): void {
    const channels = [...this.channels.values()];
    this.channels.clear();
    const opening = [...this.openingRequests.values()];
    this.openingRequests.clear();
    for (const channel of channels) channel.handleDaemonGone(error);
    for (const channel of opening) channel.handleOpenFailed(error);
  }

  // ===================== 内部：控制通道 =====================

  private handleFrame(value: unknown): void {
    if (!isDaemonToHostFrame(value)) {
      this.log(`[daemon] unknown or malformed frame: ${JSON.stringify(value)}`);
      return;
    }
    // 任何合法入站帧都证明链路活着：前移沉默判定的时间基准
    this.noteInbound();
    switch (value.kind) {
      case 'pong': {
        // 心跳应答：首个 pong 武装沉默判定（`docs/core/core-daemon.md` 第 12.5 节）
        if (!this.silenceArmed) this.armSilenceWatchdog();
        return;
      }
      case 'directoriesListed': {
        const request = this.directoryRequests.get(value.id);
        this.directoryRequests.delete(value.id);
        request?.resolve({ path: value.path, parent: value.parent, entries: value.entries });
        return;
      }
      case 'directoryCreated':
      case 'directoryRenamed':
      case 'directoryDeleted': {
        const request = this.directoryRequests.get(value.id);
        this.directoryRequests.delete(value.id);
        request?.resolve({ path: value.path });
        return;
      }
      case 'directoryFailed': {
        const request = this.directoryRequests.get(value.id);
        this.directoryRequests.delete(value.id);
        request?.reject(new DirectoryOperationError(value.error, value.reason));
        return;
      }
      case 'workspaceOpened': {
        const channel = this.openingRequests.get(value.id);
        this.openingRequests.delete(value.id);
        if (!channel) {
          // 迟到 / 重复的应答：关掉这条 channel，避免 Core 进程泄漏
          this.enqueue(encodeDaemonFrame({ kind: 'closeWorkspace', channel: value.channel }));
          return;
        }
        this.channels.set(value.channel, channel);
        channel.handleOpened(value.channel, value.descriptor);
        return;
      }
      case 'workspaceFailed': {
        const channel = this.openingRequests.get(value.id);
        this.openingRequests.delete(value.id);
        channel?.handleOpenFailed(new Error(value.error));
        return;
      }
      case 'frame': {
        if (!isCoreToUiFrame(value.frame)) {
          this.log(`[daemon] channel ${value.channel}: malformed inner frame; dropped`);
          return;
        }
        this.channels.get(value.channel)?.handleFrame(value.frame);
        return;
      }
      case 'channelReset': {
        this.channels.get(value.channel)?.handleReset(value.reason);
        return;
      }
      case 'workspaceClosed': {
        const channel = this.channels.get(value.channel);
        this.channels.delete(value.channel);
        channel?.handleClosed(value.reason);
        return;
      }
    }
  }

  private enqueue(line: string): void {
    this.outbox.push(line);
    if (this.outbox.length > OUTBOX_WARN_THRESHOLD) {
      this.log(`[daemon] outbound queue backlog ${this.outbox.length}; host is slow`);
    }
    this.flushOutbox();
  }

  private flushOutbox(): void {
    const writer = this.writer;
    // 链路未就绪不写：daemon 还没开始读这条连接
    if (!writer || !this.linkReady || this.waitingDrain) return;
    while (this.outbox.length > 0) {
      const line = this.outbox[0];
      let accepted: boolean;
      try {
        accepted = writer.write(line);
      } catch {
        // 控制通道已退出：队列由 handleExit 清空
        return;
      }
      // `write` 返回 false 只表示「内部缓冲越过软水位」，数据已经被接受、稍后照常写出；
      // 因此必须先出队再决定是否等 drain。留在队列里会被 drain 回调反复重写同一帧
      // （帧被无限复制），且排在它后面的帧永远写不出去——控制通道上表现为对端卡死。
      this.outbox.shift();
      if (!accepted) {
        this.waitingDrain = true;
        writer.onceDrain(() => {
          this.waitingDrain = false;
          this.flushOutbox();
        });
        return;
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

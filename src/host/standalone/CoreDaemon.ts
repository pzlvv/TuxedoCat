/**
 * CoreDaemon - Host 侧的 daemon 客户端（`docs/core-daemon.md`）。
 *
 * 一个 endpoint 一个 daemon：daemon 是目标机器上的常驻服务（由 `start` 拉起），
 * Host 连它的 TCP 控制通道，第一帧用 token 鉴权。
 * 每个工作区对应控制通道上的一条逻辑 channel；`openChannel` 同步返回传输层对象，
 * 内部异步完成「连上 daemon → 鉴权 → openWorkspace → channel 建立」，
 * 建立之前发出的帧按序排队（daemon 侧在 Core 进程起来前也会排队）。
 *
 * 重启责任在 daemon：Core 崩溃后 daemon 在同一 channel 上重启并回 `channelReset`；
 * 本模块把它翻译成「连接重置」——重新发 `hello`、等 `ready`、再通知总线。
 * 重启次数超限时 daemon 回 `workspaceClosed(reason=failed)`，本模块报告 fatal。
 *
 * 背压：控制通道的出站帧进有序队列，socket 返回 false 时等 `drain`；
 * 越过软水位只记录诊断，不丢帧、不合并帧。
 */

import { connect as netConnect, type Socket } from 'net';
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
/** 握手超时默认值（Core 进程启动后未回 `ready` 视为失败） */
export const DEFAULT_DAEMON_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 关闭 channel / daemon 的等待上限 */
export const DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * 控制通道：连接一个已经在监听的 daemon（`docs/core-daemon.md` 第 12 节）。
 *
 * 第一帧是 `auth`，`authOk` 之前不出站业务帧。
 * 本地同机工作区不走 daemon：`bootstrapCore` 直接用 `serve` 动作起单进程 Core
 * （stdio 帧通道，无端口、无 token，见 `createStandaloneCoreBus`）。
 */
export interface CoreDaemonTransport {
  host: string;
  port: number;
  token: string;
}

export interface CoreDaemonOptions {
  transport: CoreDaemonTransport;
  log: (...args: unknown[]) => void;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/**
 * 控制通道的写出端。
 *
 * `write` 返回 false 表示背压（数据已被接受，等 `drain` 再继续）；
 * `end` 是 shutdown 帧之后的优雅关闭，`kill` 是超时强杀。
 */
interface ControlWriter {
  write(line: string): boolean;
  onceDrain(listener: () => void): void;
  end(): void;
  kill(): void;
}

/** 远程 TCP socket */
class SocketWriter implements ControlWriter {
  constructor(private readonly socket: Socket) {}

  write(line: string): boolean {
    return this.socket.write(line);
  }

  onceDrain(listener: () => void): void {
    this.socket.once('drain', listener);
  }

  end(): void {
    this.socket.end();
  }

  kill(): void {
    this.socket.destroy();
  }
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
  private socket: Socket | null = null;
  private writer: ControlWriter | null = null;
  /** 控制通道是否可写出：`authOk` 之后才可写（此前只发 `auth`） */
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
  /** 已发出、尚未收到应答的 listDirectories：requestId → 等待者 */
  private readonly listRequests = new Map<
    number,
    { resolve: (listing: DirectoryListing) => void; reject: (error: Error) => void }
  >();
  /** 远程鉴权完成前的等待者 */
  private authWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private exitWaiters: Array<() => void> = [];
  /** 控制通道就绪超时（进程启动 / 连接 / 鉴权） */
  private linkTimer: NodeJS.Timeout | null = null;

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
   * 建立控制通道并等待可写出（`authOk`）。
   *
   * 远程目录选择器在打开任何工作区之前就要连接，因此单独暴露这个入口。
   */
  async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error('Core daemon has been shut down.');
    if (!this.ensureStarted()) throw new Error('Core daemon failed to connect.');
    if (this.linkReady) return;
    return new Promise<void>((resolve, reject) => {
      this.authWaiters.push({ resolve, reject });
    });
  }

  /** 列出目标机器上的子目录（远程目录选择器用；`path` 为 null 时从主目录开始） */
  async listDirectories(path: string | null): Promise<DirectoryListing> {
    await this.ensureConnected();
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<DirectoryListing>((resolve, reject) => {
      this.listRequests.set(id, { resolve, reject });
      this.enqueue(encodeDaemonFrame({ kind: 'listDirectories', id, path }));
    });
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

  /** 关闭控制通道：`shutdown` 帧 → 等 socket 退出 → 超时强制断开 */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shuttingDown = true;
    this.clearLinkTimeout();
    const writer = this.writer;
    if (writer) {
      try {
        writer.write(encodeDaemonFrame({ kind: 'shutdown' }));
      } catch {
        // 已退出：无需再发
      }
      // 主动结束 socket，否则对端会一直等下一帧
      writer.end();
      await this.waitForExit(this.options.shutdownTimeoutMs ?? DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS);
    }
    // 优雅关闭未生效 / 连接尚未建立时，也不留悬挂的 socket
    try {
      writer?.kill();
    } catch {
      // 已断开
    }
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
    if (this.socket) return true;
    const transport = this.options.transport;
    this.openRemoteSocket(transport.host, transport.port, transport.token);
    this.armLinkTimeout('Core daemon connection');
    return true;
  }

  /** 建立 TCP 控制通道并完成 `auth` 握手（`authOk` 前不出站业务帧） */
  private openRemoteSocket(host: string, port: number, token: string): void {
    const socket = netConnect({ host, port });
    this.socket = socket;
    this.writer = new SocketWriter(socket);
    this.linkReady = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      try {
        socket.write(encodeDaemonFrame({ kind: 'auth', token }));
      } catch (error) {
        this.log(`[daemon] auth write failed: ${toError(error).message}`);
      }
    });
    socket.on('data', (chunk: string) => this.decoder.push(chunk));
    socket.on('error', (error) => {
      this.log(`[daemon] socket error: ${error.message}`);
    });
    socket.on('close', () => this.handleExit());
  }

  /**
   * 控制通道就绪超时（连不上 / 鉴权无应答）。
   *
   * 超时后把等待者与已登记 channel 一起失败，并断开 socket，不静默挂起。
   */
  private armLinkTimeout(label: string): void {
    this.clearLinkTimeout();
    const timeoutMs = this.handshakeTimeoutMs();
    this.linkTimer = setTimeout(() => {
      this.linkTimer = null;
      if (this.linkReady || this.exitHandled) return;
      const error = new Error(`${label} timed out after ${timeoutMs}ms.`);
      this.log(`[daemon] ${error.message}`);
      this.failPendingLink(error);
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

  /** 连接建立失败：拒绝未决的鉴权 / 目录请求，并把已登记的 channel 一起失败 */
  private failPendingLink(error: Error): void {
    const authWaiters = this.authWaiters;
    this.authWaiters = [];
    for (const waiter of authWaiters) waiter.reject(error);
    const listRequests = [...this.listRequests.values()];
    this.listRequests.clear();
    for (const request of listRequests) request.reject(error);
    this.fatalAll(error);
  }

  private handleExit(): void {
    if (this.exitHandled) return; // close 只处理一次
    this.exitHandled = true;
    this.clearLinkTimeout();
    this.socket = null;
    this.writer = null;
    this.linkReady = false;
    this.waitingDrain = false;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();
    // 未完成的鉴权 / 目录请求：连接没了，一律失败
    const authWaiters = this.authWaiters;
    this.authWaiters = [];
    for (const waiter of authWaiters) waiter.reject(new Error('Core daemon exited.'));
    const listRequests = [...this.listRequests.values()];
    this.listRequests.clear();
    for (const request of listRequests) request.reject(new Error('Core daemon exited.'));

    if (this.shuttingDown || this.stopped) return;
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
    switch (value.kind) {
      case 'authOk': {
        if (this.linkReady) return;
        this.clearLinkTimeout();
        this.linkReady = true;
        const waiters = this.authWaiters;
        this.authWaiters = [];
        for (const waiter of waiters) waiter.resolve();
        this.flushOutbox();
        return;
      }
      case 'authFailed': {
        this.clearLinkTimeout();
        const error = new Error(`Remote Core authentication failed: ${value.error}`);
        const waiters = this.authWaiters;
        this.authWaiters = [];
        for (const waiter of waiters) waiter.reject(error);
        this.log(`[daemon] ${error.message}`);
        this.fatalAll(error);
        this.writer?.kill();
        return;
      }
      case 'directoriesListed': {
        const request = this.listRequests.get(value.id);
        this.listRequests.delete(value.id);
        request?.resolve({ path: value.path, parent: value.parent, entries: value.entries });
        return;
      }
      case 'directoriesFailed': {
        const request = this.listRequests.get(value.id);
        this.listRequests.delete(value.id);
        request?.reject(new Error(value.error));
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
    // 远程：authOk 之前不写业务帧（否则会被对端当作非法帧丢弃）
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

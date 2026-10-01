/**
 * CoreDaemon - Host 侧的 daemon 客户端（`docs/core-daemon.md`）。
 *
 * 一个 endpoint 一个 daemon：本地 daemon 由 Host 启动，控制通道走 stdio。
 * 每个工作区对应控制通道上的一条逻辑 channel；`openChannel` 同步返回传输层对象，
 * 内部异步完成「启动 daemon → openWorkspace → channel 建立」，
 * 建立之前发出的帧按序排队（daemon 侧在 Core 进程起来前也会排队）。
 *
 * 重启责任在 daemon：Core 崩溃后 daemon 在同一 channel 上重启并回 `channelReset`；
 * 本模块把它翻译成「连接重置」——重新发 `hello`、等 `ready`、再通知总线。
 * 重启次数超限时 daemon 回 `workspaceClosed(reason=failed)`，本模块报告 fatal。
 *
 * 背压：控制通道的出站帧进有序队列，stdin 返回 false 时等 `drain`；
 * 越过软水位只记录诊断，不丢帧、不合并帧。
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'child_process';
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

/** spawn 的测试注入点 */
export type DaemonSpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface CoreDaemonOptions {
  /** Core 可执行文件路径（daemon 与 Core 是同一个文件） */
  binaryPath: string;
  log: (...args: unknown[]) => void;
  /** 额外命令行参数；默认 `--daemon`，测试用来跑假 daemon */
  spawnArgs?: readonly string[];
  spawn?: DaemonSpawnFunction;
  handshakeTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

const defaultSpawn: DaemonSpawnFunction = (command, args, options) =>
  nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;

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
 * `openChannel` 同步返回；daemon 进程在第一次打开工作区时启动。
 */
export class CoreDaemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder: FrameDecoder;
  private readonly log: (...args: unknown[]) => void;
  private stopped = false;
  private shuttingDown = false;
  /** daemon 进程退出是否已处理（exit + close 双事件去重） */
  private exitHandled = false;
  private nextRequestId = 1;
  /** 出站帧队列（stdin 未就绪 / 背压时排队） */
  private readonly outbox: string[] = [];
  private waitingDrain = false;
  /** 已建立 channel：channelId → transport */
  private readonly channels = new Map<number, DaemonChannel>();
  /** 已发出、尚未收到应答的 openWorkspace：requestId → transport */
  private readonly openingRequests = new Map<number, DaemonChannel>();
  private exitWaiters: Array<() => void> = [];

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

  /** 打开一个 channel（同步返回；内部异步启动 daemon 与 Core） */
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
    // 先登记再启动：daemon 进程起不来时 `fatalAll` 能把失败回给这条 channel
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    this.openingRequests.set(id, channel);
    if (!this.ensureStarted()) return; // 启动失败：已由 fatalAll 结束
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

  /** 关闭 daemon：`shutdown` 帧 → 等进程退出 → 超时强制结束 */
  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.write(encodeDaemonFrame({ kind: 'shutdown' }));
    } catch {
      // 进程已退出：无需再发
    }
    await this.waitForExit(child, this.options.shutdownTimeoutMs ?? DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS);
    // daemon 退出后仍未收到 workspaceClosed 的 channel：一起失败
    const leftovers = [...this.channels.values()];
    this.channels.clear();
    this.openingRequests.clear();
    for (const channel of leftovers) {
      channel.handleDaemonGone(new Error('Core daemon has been shut down.'));
    }
  }

  // ===================== 内部：进程 =====================

  /** 确保 daemon 进程已启动；返回 false 表示启动失败（失败已通过 fatalAll 上报） */
  private ensureStarted(): boolean {
    if (this.stopped) return false;
    if (this.child) return true;
    const spawnFn = this.options.spawn ?? defaultSpawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(this.options.binaryPath, this.options.spawnArgs ?? ['--daemon'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.fatalAll(toError(error));
      return false;
    }
    this.child = child;
    this.exitHandled = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.decoder.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trimEnd();
      if (line.length > 0) this.log(line);
    });
    child.stdin.on('error', () => {
      // 进程退出过程中的 EPIPE：由 exit / close 处理
    });
    child.on('error', (error) => {
      this.log(`[daemon] process error: ${error.message}`);
      if (child.pid === undefined) this.handleExit();
    });
    child.on('exit', () => this.handleExit());
    child.on('close', () => this.handleExit());

    this.flushOutbox();
    return true;
  }

  private handleExit(): void {
    if (this.exitHandled) return; // exit + close 双事件只处理一次
    this.exitHandled = true;
    this.child = null;
    this.waitingDrain = false;
    const waiters = this.exitWaiters;
    this.exitWaiters = [];
    for (const waiter of waiters) waiter();

    if (this.shuttingDown || this.stopped) return;
    this.log('[daemon] exited unexpectedly');
    this.fatalAll(new Error('Core daemon exited unexpectedly.'));
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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
        try {
          child.kill();
        } catch {
          // 已经退出
        }
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
    const child = this.child;
    if (!child || this.waitingDrain) return;
    while (this.outbox.length > 0) {
      const line = this.outbox[0];
      let accepted = false;
      try {
        accepted = child.stdin.write(line);
      } catch {
        accepted = false;
      }
      if (!accepted) {
        this.waitingDrain = true;
        child.stdin.once('drain', () => {
          this.waitingDrain = false;
          this.flushOutbox();
        });
        return;
      }
      this.outbox.shift();
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

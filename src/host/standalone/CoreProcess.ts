/**
 * Standalone Core 进程管理（见 docs/core/standalone-core.md 第 4、6、7 节）。
 *
 * 职责：启动子进程、握手、帧收发、崩溃检测、退避重启、优雅关闭。
 * 不含任何 core 业务语义；事件的落地由 `StandaloneEventBus` 承担。
 *
 * 背压（`docs/core/standalone-core.md` 第 6.5 节）：不丢帧、不合并帧。出站帧进有序队列，底层流接受数据时
 * 按序冲刷；`stdin.write()` 返回 false 时等 `drain`。队列越过软水位只记录诊断。
 */

import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'child_process';
import {
  CORE_PROTOCOL_VERSION,
  FrameDecoder,
  encodeFrame,
  isCoreToUiFrame,
  type CoreToUiFrame,
  type UiToCoreFrame,
} from './protocol.js';

/** 进程退出信息 */
export interface CoreExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true = 宿主主动 `stop()` 触发的退出 */
  expected: boolean;
}

/** 重启策略（`docs/core/standalone-core.md` 第 7.1 节） */
export interface RestartPolicy {
  /** 时间窗口内允许的重启次数 */
  maxAttempts: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 首次重启延迟（毫秒） */
  baseDelayMs: number;
  /** 重启延迟上限（毫秒） */
  maxDelayMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxAttempts: 5,
  windowMs: 60_000,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

/** 出站队列软水位：越过只记录诊断，不丢帧 */
const OUTBOX_WARN_THRESHOLD = 10_000;

export interface CoreProcessHooks {
  /** 收到一帧合法 Core → UI 帧（`ready` 由本模块消费，不转发） */
  onFrame(frame: CoreToUiFrame): void;
  /** 握手成功（首次启动与每次重启后都会触发） */
  onReady(): void;
  /** 已就绪的连接断开 */
  onNotReady(): void;
  /** 进程退出（不论是否预期） */
  onExit(info: CoreExitInfo): void;
  /** 诊断输出：标准错误、非法帧、启动失败 */
  onDiagnostic(line: string): void;
  /** 重启次数超限或无法启动，不再重试 */
  onFatal(error: Error): void;
}

/** spawn 的测试注入点 */
export type CoreSpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface CoreProcessOptions {
  /** Standalone Core 可执行文件路径 */
  binaryPath: string;
  hooks: CoreProcessHooks;
  /** 命令行参数（必给：动作是裸词，漏掉就会落到缺省动作上；测试用它跑假 Core） */
  spawnArgs: readonly string[];
  restartPolicy?: RestartPolicy;
  /** 关闭等待上限（毫秒）；超时后强制结束 */
  shutdownTimeoutMs?: number;
  /** 测试注入的 spawn */
  spawn?: CoreSpawnFunction;
  /** 测试注入的时钟 */
  now?: () => number;
  /** 握手超时（毫秒）；Core 启动后未回 `ready` 视为启动失败 */
  handshakeTimeoutMs?: number;
}

/** 握手超时默认值 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const defaultSpawn: CoreSpawnFunction = (command, args, options) =>
  nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams;

export class CoreProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder: FrameDecoder;
  private ready = false;
  private stopped = false;
  private shuttingDown = false;
  private fatal = false;
  private restartTimestamps: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private outbox: string[] = [];
  private waitingDrain = false;

  constructor(private readonly options: CoreProcessOptions) {
    this.decoder = new FrameDecoder({
      onFrame: (value) => this.handleFrame(value),
      onError: (error) =>
        this.options.hooks.onDiagnostic(`[core] malformed frame: ${error.message}`),
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** 启动 Core 进程；重复调用在已有进程时为空操作 */
  start(): void {
    if (this.stopped) {
      throw new Error('CoreProcess has been stopped; create a new instance to start again.');
    }
    if (this.fatal) return;
    if (this.child) return;
    // 手动 start 取消待执行的重启，避免定时器到点后双 spawn
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.spawnChild();
  }

  /** 发送一帧（未就绪时由调用方负责排队） */
  send(frame: UiToCoreFrame): void {
    this.enqueue(encodeFrame(frame));
  }

  /**
   * 优雅关闭：发 `shutdown` 帧，等待进程退出；超时后强制结束。
   * 返回后不再重启。
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearHandshakeTimer();
    const child = this.child;
    if (!child) return;
    this.shuttingDown = true;
    try {
      child.stdin.write(encodeFrame({ kind: 'shutdown' }));
    } catch {
      // 子进程已退出：无需再发
    }
    await this.waitForExit(child, this.options.shutdownTimeoutMs ?? 5_000);
    this.shuttingDown = false;
  }

  // ==================== 内部：进程 ====================

  private spawnChild(): void {
    const spawnFn = this.options.spawn ?? defaultSpawn;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnFn(this.options.binaryPath, this.options.spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.fatal = true;
      this.options.hooks.onFatal(toError(error));
      return;
    }

    this.child = child;
    this.ready = false;
    this.decoder.reset();
    // 注意：不清空 outbox。handleExit 已负责清空；若在重启窗口内有人 send()，
    // 这里清空会静默丢帧。保留后由 flushOutbox 在新连接上按序冲刷。
    this.waitingDrain = false;

    // 每个子进程只允许触发一次终止处理：spawn 失败时 Node 只发 `error`+`close`
    // （不发 `exit`），只听 `exit` 会让宿主静默卡死、永不重启。
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      this.handleExit(code, signal);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.decoder.push(chunk));
    // 帧通道意外关闭（Core 关掉 stdout 但仍存活）：按连接丢失处理，杀掉后走重启
    child.stdout.on('close', () => {
      if (this.child !== child || this.stopped || this.shuttingDown) return;
      this.options.hooks.onDiagnostic('[core] stdout closed unexpectedly; terminating core process');
      try {
        child.kill();
      } catch {
        // 已经退出
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trimEnd();
      if (line.length > 0) this.options.hooks.onDiagnostic(line);
    });
    child.stdin.on('error', () => {
      // 进程退出过程中的 EPIPE：由 exit / close 处理，这里不重复报告
    });
    child.on('error', (error) => {
      this.options.hooks.onDiagnostic(`[core] process error: ${error.message}`);
      // spawn 失败（ENOENT / EACCES / 坏镜像）：pid 为空，且不会有 exit 事件
      if (child.pid === undefined) finish(null, null);
    });
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('close', (code, signal) => finish(code, signal));

    this.enqueue(encodeFrame({ kind: 'hello', protocol: CORE_PROTOCOL_VERSION }));
    this.startHandshakeTimer(child);
  }

  private startHandshakeTimer(child: ChildProcessWithoutNullStreams): void {
    this.clearHandshakeTimer();
    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.child !== child || this.ready || this.stopped) return;
      this.options.hooks.onDiagnostic(
        `[core] handshake timed out after ${timeoutMs}ms; terminating core process`,
      );
      try {
        child.kill();
      } catch {
        // 已经退出
      }
    }, timeoutMs);
    this.handshakeTimer.unref();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    const wasReady = this.ready;
    this.ready = false;
    this.clearHandshakeTimer();
    this.outbox = [];
    this.waitingDrain = false;

    const expected = this.stopped || this.shuttingDown;
    if (wasReady) this.options.hooks.onNotReady();
    this.options.hooks.onExit({ code, signal, expected });

    if (expected || this.fatal) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const policy = this.options.restartPolicy ?? DEFAULT_RESTART_POLICY;
    const now = this.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (timestamp) => now - timestamp < policy.windowMs,
    );
    if (this.restartTimestamps.length >= policy.maxAttempts) {
      this.fatal = true;
      this.options.hooks.onFatal(
        new Error(
          `Core process exited ${this.restartTimestamps.length} times within ` +
          `${policy.windowMs}ms; giving up.`,
        ),
      );
      return;
    }
    this.restartTimestamps.push(now);
    const delay = Math.min(
      policy.baseDelayMs * 2 ** (this.restartTimestamps.length - 1),
      policy.maxDelayMs,
    );
    this.options.hooks.onDiagnostic(
      `[core] restarting in ${delay}ms (attempt ${this.restartTimestamps.length}/${policy.maxAttempts})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && !this.fatal && !this.child) this.spawnChild();
    }, delay);
    this.restartTimer.unref();
  }

  private async waitForExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 已经退出
        }
        resolve();
      }, timeoutMs);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ==================== 内部：帧 ====================

  private handleFrame(value: unknown): void {
    if (!isCoreToUiFrame(value)) {
      this.options.hooks.onDiagnostic(
        `[core] unknown frame: ${JSON.stringify(value)?.slice(0, 200) ?? String(value)}`,
      );
      return;
    }
    if (value.kind === 'ready') {
      this.clearHandshakeTimer();
      this.ready = true;
      this.options.hooks.onReady();
      return;
    }
    this.options.hooks.onFrame(value);
  }

  private enqueue(line: string): void {
    this.outbox.push(line);
    if (this.outbox.length === OUTBOX_WARN_THRESHOLD) {
      this.options.hooks.onDiagnostic(
        `[core] outbound queue reached ${OUTBOX_WARN_THRESHOLD} frames; peer is not draining`,
      );
    }
    this.flushOutbox();
  }

  private flushOutbox(): void {
    const child = this.child;
    if (!child || this.waitingDrain) return;
    while (this.outbox.length > 0) {
      const line = this.outbox[0];
      let accepted: boolean;
      try {
        accepted = child.stdin.write(line);
      } catch {
        // 子进程已退出：队列由 handleExit 清空
        return;
      }
      this.outbox.shift();
      if (!accepted) {
        this.waitingDrain = true;
        child.stdin.once('drain', () => {
          this.waitingDrain = false;
          this.flushOutbox();
        });
        return;
      }
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * ShellCommand - shell 命令执行包装
 *
 * 管理子进程生命周期，支持：
 * - 状态管理：running / backgrounded / completed / killed
 * - background：将前台进程转为后台运行（解绑监听，后续通过文件轮询获取输出）
 * - kill：强制终止进程（使用 tree-kill 风格的递归终止）
 * - result Promise：命令完成时 resolve
 *
 * 参考 claude-code-main 的 ShellCommand 设计
 */

import type { ChildProcess } from 'child_process';
import { TaskOutput } from './TaskOutput.js';

/** SIGTERM 退出码 */
const SIGTERM = 143;
/** SIGKILL 退出码 */
const SIGKILL = 137;

/** 磁盘大小监控间隔 (ms) */
const SIZE_WATCHDOG_INTERVAL_MS = 5000;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  interrupted: boolean;
  backgroundTaskId?: string;
  backgroundedByUser?: boolean;
  assistantAutoBackgrounded?: boolean;
  outputFilePath?: string;
  outputFileSize?: number;
  outputTaskId?: string;
  preSpawnError?: string;
}

export interface ShellCommand {
  /** 将进程转入后台运行 */
  background: (backgroundTaskId: string) => boolean;
  /** 进程完成时的 Promise */
  result: Promise<ExecResult>;
  /** 终止进程 */
  kill: () => void;
  /** 子进程 pid（spawn 失败 / 已 cleanup 时为 undefined） */
  readonly pid?: number;
  /** 当前状态 */
  status: 'running' | 'backgrounded' | 'completed' | 'killed';
  /** 清理资源 */
  cleanup: () => void;
  /** 超时回调（用于自动 background） */
  onTimeout?: (callback: (backgroundFn: (taskId: string) => boolean) => void) => void;
  /** TaskOutput 实例 */
  taskOutput: TaskOutput;
}

/**
 * ShellCommand 实现
 */
export class ShellCommandImpl implements ShellCommand {
  private _status: 'running' | 'backgrounded' | 'completed' | 'killed' = 'running';
  private _backgroundTaskId: string | undefined;
  private _childProcess: ChildProcess;
  private _timeoutId: ReturnType<typeof setTimeout> | null = null;
  private _sizeWatchdog: ReturnType<typeof setInterval> | null = null;
  private _killedForSize = false;
  private _maxOutputBytes: number;
  private _abortSignal: AbortSignal;
  private _onTimeoutCallback: ((backgroundFn: (taskId: string) => boolean) => void) | undefined;
  private _timeout: number;
  private _shouldAutoBackground: boolean;
  private _resultResolver: ((result: ExecResult) => void) | null = null;
  private _exitCodeResolver: ((code: number) => void) | null = null;
  private _boundAbortHandler: (() => void) | null = null;
  readonly taskOutput: TaskOutput;

  readonly result: Promise<ExecResult>;
  readonly onTimeout?: (callback: (backgroundFn: (taskId: string) => boolean) => void) => void;

  constructor(
    childProcess: ChildProcess,
    abortSignal: AbortSignal,
    timeout: number,
    taskOutput: TaskOutput,
    shouldAutoBackground = false,
    maxOutputBytes = 5 * 1024 * 1024 * 1024, // 5GB
  ) {
    this._childProcess = childProcess;
    this._abortSignal = abortSignal;
    this._timeout = timeout;
    this._shouldAutoBackground = shouldAutoBackground;
    this._maxOutputBytes = maxOutputBytes;
    this.taskOutput = taskOutput;

    if (shouldAutoBackground) {
      this.onTimeout = (callback): void => {
        this._onTimeoutCallback = callback;
      };
    }

    this.result = this._createResultPromise();
  }

  get status(): 'running' | 'backgrounded' | 'completed' | 'killed' {
    return this._status;
  }

  /** 子进程 pid（cleanup 后为 undefined） */
  get pid(): number | undefined {
    return this._childProcess?.pid;
  }

  /**
   * 处理超时的静态方法
   */
  private static _handleTimeout(self: ShellCommandImpl): void {
    if (self._shouldAutoBackground && self._onTimeoutCallback) {
      self._onTimeoutCallback(self.background.bind(self));
    } else {
      self._doKill(15); // SIGTERM
    }
  }

  private _abortHandler(): void {
    if ((this._abortSignal as any).reason === 'interrupt') {
      // interrupt 信号不杀进程，允许后续 background
      return;
    }
    this.kill();
  }

  private _exitHandler(code: number | null, _signal: string | null): void {
    const exitCode = code !== null && code !== undefined
      ? code
      : 1;
    this._resolveExitCode(exitCode);
  }

  private _errorHandler(): void {
    this._resolveExitCode(1);
  }

  private _resolveExitCode(code: number): void {
    if (this._exitCodeResolver) {
      this._exitCodeResolver(code);
      this._exitCodeResolver = null;
    }
  }

  private _cleanupListeners(): void {
    this._clearSizeWatchdog();
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._boundAbortHandler) {
      this._abortSignal.removeEventListener('abort', this._boundAbortHandler);
      this._boundAbortHandler = null;
    }
  }

  private _clearSizeWatchdog(): void {
    if (this._sizeWatchdog) {
      clearInterval(this._sizeWatchdog);
      this._sizeWatchdog = null;
    }
  }

  private _startSizeWatchdog(): void {
    this._sizeWatchdog = setInterval(() => {
      try {
        const stats = require('fs').statSync(this.taskOutput.path);
        if (stats.size > this._maxOutputBytes && this._status === 'backgrounded' && this._sizeWatchdog !== null) {
          this._killedForSize = true;
          this._clearSizeWatchdog();
          this._doKill(9); // SIGKILL
        }
      } catch {
        // ENOENT
      }
    }, SIZE_WATCHDOG_INTERVAL_MS);
    this._sizeWatchdog.unref();
  }

  private _createResultPromise(): Promise<ExecResult> {
    this._boundAbortHandler = this._abortHandler.bind(this);
    this._abortSignal.addEventListener('abort', this._boundAbortHandler, { once: true });

    this._childProcess.once('exit', this._exitHandler.bind(this));
    this._childProcess.once('error', this._errorHandler.bind(this));

    this._timeoutId = setTimeout(
      ShellCommandImpl._handleTimeout,
      this._timeout,
      this,
    ) as unknown as ReturnType<typeof setTimeout>;

    const exitPromise = new Promise<number>(resolve => {
      this._exitCodeResolver = resolve;
    });

    return new Promise<ExecResult>(resolve => {
      this._resultResolver = resolve;
      void exitPromise.then(this._handleExit.bind(this));
    });
  }

  private async _handleExit(code: number): Promise<void> {
    this._cleanupListeners();
    if (this._status === 'running' || this._status === 'backgrounded') {
      this._status = 'completed';
    }

    const stdout = await this.taskOutput.getStdout();
    const result: ExecResult = {
      code,
      stdout,
      stderr: this.taskOutput.getStderr(),
      interrupted: code === SIGKILL || code === 137,
      backgroundTaskId: this._backgroundTaskId,
    };

    if (this.taskOutput.stdoutToFile && !this._backgroundTaskId) {
      if (this.taskOutput.outputFileRedundant) {
        void this.taskOutput.deleteOutputFile();
      } else {
        result.outputFilePath = this.taskOutput.path;
        result.outputFileSize = this.taskOutput.outputFileSize;
        result.outputTaskId = this.taskOutput.taskId;
      }
    }

    if (this._killedForSize) {
      result.stderr = `Background command killed: output file exceeded 5GB\n${result.stderr}`;
    } else if (code === 15 || code === SIGTERM || code === 143) {
      result.stderr = `Command timed out after ${this._timeout}ms\n${result.stderr}`;
    }

    const resultResolver = this._resultResolver;
    if (resultResolver) {
      this._resultResolver = null;
      resultResolver(result);
    }
  }

  private _doKill(signal?: number): void {
    if (this._status === 'killed' || this._status === 'completed') return;
    this._status = 'killed';
    if (this._childProcess.pid) {
      try {
        // 尝试终止进程树
        const killSignal = signal === 9 ? 'SIGKILL' : 'SIGTERM';
        this._childProcess.kill(killSignal);
        // Windows 上可能需要 taskkill
        if (process.platform === 'win32') {
          try {
            const { execSync } = require('child_process');
            execSync(`taskkill /T /F /PID ${this._childProcess.pid}`, { timeout: 2000 });
          } catch { /* OK */ }
        }
      } catch {
        // 进程可能已结束
      }
    }
    this._resolveExitCode(signal ?? SIGKILL);
  }

  kill(): void {
    this._doKill();
  }

  background(taskId: string): boolean {
    if (this._status === 'running') {
      this._backgroundTaskId = taskId;
      this._status = 'backgrounded';
      this._cleanupListeners();
      if (this.taskOutput.stdoutToFile) {
        this._startSizeWatchdog();
      }
      return true;
    }
    return false;
  }

  cleanup(): void {
    this.taskOutput.clear();
    this._cleanupListeners();
    (this._childProcess as any) = null;
    (this._abortSignal as any) = null;
    this._onTimeoutCallback = undefined;
  }
}

/**
 * 包装子进程为 ShellCommand 接口
 */
export function wrapSpawn(
  childProcess: ChildProcess,
  abortSignal: AbortSignal,
  timeout: number,
  taskOutput: TaskOutput,
  shouldAutoBackground = false,
  maxOutputBytes?: number,
): ShellCommand {
  return new ShellCommandImpl(
    childProcess,
    abortSignal,
    timeout,
    taskOutput,
    shouldAutoBackground,
    maxOutputBytes,
  );
}

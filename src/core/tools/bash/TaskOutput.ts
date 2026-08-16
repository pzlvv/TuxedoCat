/**
 * TaskOutput - 命令输出管理
 *
 * 支持两种模式：
 * - file mode: 子进程 stdout/stderr 直接写入文件 fd，JS 通过轮询文件尾部获取进度
 * - pipe mode: 数据通过流进入内存 buffer，超限后 spill 到磁盘
 *
 * 参考 claude-code-main 的 TaskOutput 设计
 */

import { mkdir, open, stat, unlink, readFile } from 'fs/promises';
import { join } from 'path';
import { TMP_TASK_DIR_NAME } from '../../../config/project.js';

/** 轮询间隔 (ms) */
const POLL_INTERVAL_MS = 1000;
/** 轮询尾部字节数 */
const PROGRESS_TAIL_BYTES = 4096;
/** 内存 buffer 上限 (8MB) */
const DEFAULT_MAX_MEMORY = 8 * 1024 * 1024;

export type ProgressCallback = (
  lastLines: string,
  allLines: string,
  totalLines: number,
  totalBytes: number,
  isIncomplete: boolean,
) => void;

/**
 * 获取任务输出目录
 */
export function getTaskOutputDir(): string {
  const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
  return join(tmpDir, TMP_TASK_DIR_NAME);
}

/**
 * 获取任务输出文件路径
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`);
}

/**
 * 任务输出管理器
 */
export class TaskOutput {
  readonly taskId: string;
  readonly path: string;
  /** true = file mode (stdout/stderr 直接写文件 fd) */
  readonly stdoutToFile: boolean;

  private _stdoutBuffer = '';
  private _stderrBuffer = '';
  private _totalBytes = 0;
  private _totalLines = 0;
  private _maxMemory: number;
  private _onProgress: ProgressCallback | null;
  private _outputFileSize = 0;
  private _outputFileRedundant = false;

  // --- 共享轮询器 ---
  private static _registry = new Map<string, TaskOutput>();
  private static _activePolling = new Map<string, TaskOutput>();
  private static _pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile = false,
    maxMemory = DEFAULT_MAX_MEMORY,
  ) {
    this.taskId = taskId;
    this.path = getTaskOutputPath(taskId);
    this.stdoutToFile = stdoutToFile;
    this._maxMemory = maxMemory;
    this._onProgress = onProgress;

    // file mode + 需要进度报告 → 注册到轮询器
    if (stdoutToFile && onProgress) {
      TaskOutput._registry.set(taskId, this);
    }
  }

  /**
   * 确保输出目录存在
   */
  static async ensureOutputDir(): Promise<void> {
    await mkdir(getTaskOutputDir(), { recursive: true });
  }

  /**
   * 打开输出文件并返回文件描述符
   * file mode 下用于子进程的 stdio 重定向
   */
  static async openOutputFile(taskId: string): Promise<number> {
    const path = getTaskOutputPath(taskId);
    await TaskOutput.ensureOutputDir();
    const handle = await open(path, 'w');
    return handle.fd;
  }

  /**
   * 开始轮询输出文件（用于 UI 进度显示）
   */
  static startPolling(taskId: string): void {
    const instance = TaskOutput._registry.get(taskId);
    if (!instance || !instance._onProgress) return;

    TaskOutput._activePolling.set(taskId, instance);
    if (!TaskOutput._pollInterval) {
      TaskOutput._pollInterval = setInterval(TaskOutput._tick, POLL_INTERVAL_MS);
      TaskOutput._pollInterval.unref();
    }
  }

  /**
   * 停止轮询输出文件
   */
  static stopPolling(taskId: string): void {
    TaskOutput._activePolling.delete(taskId);
    if (TaskOutput._activePolling.size === 0 && TaskOutput._pollInterval) {
      clearInterval(TaskOutput._pollInterval);
      TaskOutput._pollInterval = null;
    }
  }

  /**
   * 轮询 tick：读取所有活跃任务的输出文件尾部
   */
  static _tick(): void {
    for (const [, entry] of TaskOutput._activePolling) {
      if (!entry._onProgress) continue;

      TaskOutput._tailFile(entry.path, PROGRESS_TAIL_BYTES).then(
        ({ content, bytesRead, bytesTotal }) => {
          if (!entry._onProgress) return;

          if (!content) {
            entry._onProgress('', '', entry._totalLines, bytesTotal, false);
            return;
          }

          // 统计行数
          let pos = content.length;
          let n5 = 0;
          let n100 = 0;
          let lineCount = 0;
          while (pos > 0) {
            pos = content.lastIndexOf('\n', pos - 1);
            lineCount++;
            if (lineCount === 5) n5 = pos <= 0 ? 0 : pos + 1;
            if (lineCount === 100) n100 = pos <= 0 ? 0 : pos + 1;
          }

          const totalLines = bytesRead >= bytesTotal
            ? lineCount
            : Math.max(entry._totalLines, Math.round((bytesTotal / bytesRead) * lineCount));
          entry._totalLines = totalLines;

          entry._onProgress(
            content.slice(n5),
            content.slice(n100),
            totalLines,
            bytesTotal,
            bytesRead < bytesTotal,
          );
        },
        () => { /* 文件可能不存在 */ },
      );
    }
  }

  /**
   * 读取文件尾部内容
   */
  private static async _tailFile(
    filePath: string,
    bytes: number,
  ): Promise<{ content: string; bytesRead: number; bytesTotal: number }> {
    try {
      const stats = await stat(filePath);
      const fileSize = stats.size;
      if (fileSize === 0) {
        return { content: '', bytesRead: 0, bytesTotal: 0 };
      }

      const readSize = Math.min(bytes, fileSize);
      const fd = await open(filePath, 'r');
      const buf = Buffer.alloc(readSize);
      const { bytesRead } = await fd.read(buf, 0, readSize, Math.max(0, fileSize - readSize));
      await fd.close();

      return {
        content: buf.toString('utf-8', 0, bytesRead),
        bytesRead: fileSize,
        bytesTotal: fileSize,
      };
    } catch {
      return { content: '', bytesRead: 0, bytesTotal: 0 };
    }
  }

  /**
   * 写入 stdout 数据（pipe mode 使用）
   */
  writeStdout(data: string): void {
    this._writeBuffered(data, false);
  }

  /**
   * 写入 stderr 数据
   */
  writeStderr(data: string): void {
    this._writeBuffered(data, true);
  }

  private _writeBuffered(data: string, isStderr: boolean): void {
    this._totalBytes += data.length;
    this._updateProgress(data);

    if (isStderr) {
      this._stderrBuffer += data;
    } else {
      this._stdoutBuffer += data;
    }
  }

  private _updateProgress(data: string): void {
    // 简单行数统计
    const lineCount = data.split('\n').length - 1;
    this._totalLines += lineCount;
  }

  /**
   * 获取 stdout 内容
   * file mode 下从文件读取
   */
  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      try {
        const data = await readFile(this.path, { encoding: 'utf-8' });
        this._outputFileSize = data.length;
        this._outputFileRedundant = data.length <= 64 * 1024; // 64KB 以内可视为冗余
        return data;
      } catch {
        return this._stdoutBuffer;
      }
    }
    return this._stdoutBuffer;
  }

  /**
   * 获取 stderr 内容
   */
  getStderr(): string {
    return this._stderrBuffer;
  }

  /**
   * 清除内存 buffer
   */
  clear(): void {
    this._stdoutBuffer = '';
    this._stderrBuffer = '';
    this._onProgress = null;
    TaskOutput._registry.delete(this.taskId);
    TaskOutput._activePolling.delete(this.taskId);
  }

  /**
   * 删除输出文件
   */
  async deleteOutputFile(): Promise<void> {
    try {
      await unlink(this.path);
    } catch {
      // 忽略文件不存在的错误
    }
  }

  get outputFileSize(): number {
    return this._outputFileSize;
  }

  get outputFileRedundant(): boolean {
    return this._outputFileRedundant;
  }

  /**
   * 确保目录存在（实例方法版本）
   */
  async ensureDir(): Promise<void> {
    await TaskOutput.ensureOutputDir();
  }
}

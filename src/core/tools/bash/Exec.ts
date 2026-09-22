/**
 * Bash 命令执行逻辑
 *
 * 支持两种模式：
 * - 前台模式（默认）：pipe mode，通过 stdout/stderr 流式读取，支持实时进度
 * - 后台模式（runInBackground）：file mode，子进程直接写文件 fd，
 *   通过轮询文件尾部获取进度，命令完成后通过 agentMessageQueue 通知 LLM
 *
 * 参考 claude-code-main 的设计
 */

import { spawn } from 'child_process';
import { open } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as iconv from 'iconv-lite';
import type { BashToolOutput, ExecOptions } from './Types.js';
import { MAX_PERSISTED_SIZE, capResultContent } from '../toolResultStorage.js';
import { findSuitableShell, type ShellInfo } from './ShellDetector.js';
import { TaskOutput } from './TaskOutput.js';
import { wrapSpawn } from './ShellCommand.js';
import { registerBackgroundTask, onBackgroundTaskCompleted } from './LocalShellTask.js';
import { watchSleepNotifications } from './SleepDetect.js';
import { logger } from '../../Logger.js';

/** 自动转入后台后，等待完成的超时（不限制，让后台任务自然完成） */
const AUTO_BG_TIMEOUT_MS = 0; // 0 = no timeout

/** 有后台任务完成通知时，当前前台命令至少已运行的时长（超过则自动转入后台） */
const AUTO_BG_MIN_RUNNING_MS = 3000;/**
 * 执行 shell 命令
 *
 * @returns 如果 runInBackground 为 true，立即返回 { backgroundTaskId }，
 *          命令在后台继续执行，完成后自动通知 LLM。
 *          否则返回完整的执行结果。
 */
export async function execCommand(options: ExecOptions): Promise<BashToolOutput> {
  const { command, timeout, cwd, signal, onProgress, runInBackground, description, toolUseId, agentId, sessionID } = options;

  if (runInBackground) {
    return execBackground(command, timeout, cwd, signal, description, toolUseId, agentId, sessionID);
  }

  return execForeground(command, timeout, cwd, signal, onProgress, description, toolUseId, agentId, sessionID);
}

/**
 * 前台执行（pipe mode）
 * 保留原有逻辑，通过 stdout/stderr 流式读取
 * 超时时自动转入后台运行，不阻塞后续操作
 */
async function execForeground(
  command: string,
  timeout: number,
  cwd?: string,
  signal?: AbortSignal,
  onProgress?: ExecOptions['onProgress'],
  description?: string,
  toolUseId?: string,
  agentId?: string,
  sessionID?: string,
): Promise<BashToolOutput> {
  const startTime = Date.now();

  let stderr = '';
  let fullOutput = '';
  let isResolved = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let child: import('child_process').ChildProcess | null = null;

  // 检查是否已中断
  if (signal && signal.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: 130,
      interrupted: true,
    };
  }

  // 检测可用的 shell
  const shellInfo = await findSuitableShell();
  const { path: shell, args: shellArgsBase } = shellInfo;
  const shellArgs = [...shellArgsBase, command];

  child = spawn(shell, shellArgs, {
    cwd,
    env: process.env,
  });

  let resultResolve: ((result: BashToolOutput) => void) | null = null;
  const resultPromise = new Promise<BashToolOutput>(resolve => {
    resultResolve = resolve;
  });

  // 是否为 sleep 命令（timeout === 0 表示不设前台超时）
  const isSleepCommand = timeout === 0;

  // 定义 onAbort 处理函数（使用声明形式，让 timeout、abort、后台任务通知都能引用）
  const onAbort = () => {
    if (!isResolved) {
      isResolved = true;
      unsubscribeBgCompleted();
      unsubscribeSleepNotify?.();
      if (timeoutId) clearTimeout(timeoutId);
      if (child) {
        // 在 Windows 上 child.kill('SIGTERM') 可能无效，先尝试 SIGTERM 再 SIGKILL
        try {
          child.kill('SIGTERM');
        } catch { /* 进程可能已结束 */ }
        setTimeout(() => {
          try {
            if (child && !child.killed) {
              child.kill('SIGKILL');
            }
          } catch { /* 进程可能已结束 */ }
        }, 500);
      }

      resolveForegroundResult({
        stdout: fullOutput,
        stderr: '',
        exitCode: 130,
        interrupted: true,
      }, fullOutput);
    }
  };

  // 注册 abort 信号监听
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  // --- 后台任务完成时自动转入后台 ---
  // 若有后台任务完成并发送通知，且当前命令已运行超过 AUTO_BG_MIN_RUNNING_MS，
  // 将当前命令也转入后台，避免阻塞模型处理后台任务完成通知
  const unsubscribeBgCompleted = onBackgroundTaskCompleted(() => {
    const elapsed = Date.now() - startTime;
    if (elapsed >= AUTO_BG_MIN_RUNNING_MS) {
      logger.info('Exec', `Background task completed while foreground command running for ${elapsed}ms; auto-backgrounding "${description || command}"`);
      triggerAutoBackground('background-task-completed');
    }
  });

  // --- sleep 命令的通知监听 ---
  // sleep 命令不设前台超时，让 sleep 自然完成；
  // 但 sleep 过程中若收到后台任务完成通知或子代理 Reply，
  // 则立刻将 sleep 执行转入后台，避免阻塞模型处理通知。
  let unsubscribeSleepNotify: (() => void) | null = null;
  if (isSleepCommand) {
    const watch = watchSleepNotifications(sessionID, (reason) => {
      const elapsed = Date.now() - startTime;
      logger.info('Exec', `Notification received (${reason}) while sleep running for ${elapsed}ms; auto-backgrounding "${description || command}"`);
      triggerAutoBackground(reason);
    });
    unsubscribeSleepNotify = watch.unsubscribe;
  }

  /**
   * 将当前前台命令转入后台继续执行
   * 触发条件：超时，或 sleep 命令执行中收到后台任务完成/子代理 Reply 通知，
   * 或普通命令执行中收到后台任务完成通知且已运行超过 AUTO_BG_MIN_RUNNING_MS
   */
  const triggerAutoBackground = (reason: string) => {
    if (isResolved || !child) return;
    isResolved = true;
    unsubscribeBgCompleted();
    unsubscribeSleepNotify?.();
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // 转后台前冲刷解码器残留字节：切换为文件模式后不再经过解码器，
    // 残留的不完整多字节字符若不带过去会直接丢失。
    const flushedStdout = stdoutDecoder.end();
    if (flushedStdout) appendFullOutput(flushedStdout);
    const flushedStderr = stderrDecoder.end();
    if (flushedStderr) {
      stderr += flushedStderr;
      appendFullOutput(flushedStderr);
    }

    // 转入后台：detach 子进程，通过文件模式继续收集输出
    autoBackgroundCommand(child, command, cwd, signal, description, toolUseId, agentId, sessionID, fullOutput, stderr, startTime)
      .then(bgResult => {
        if (resultResolve) {
          resultResolve(bgResult);
        }
      })
      .catch(err => {
        logger.error('Exec', `Failed to auto-background command (${reason}):`, err);
        // fallback: 杀掉进程
        try { child?.kill('SIGKILL'); } catch { /* OK */ }
        resolveForegroundResult({
          stdout: fullOutput,
          stderr: `Auto-background failed after ${Date.now() - startTime}ms (${reason}): ${err instanceof Error ? err.message : err}`,
          exitCode: 124,
          interrupted: true,
        }, fullOutput);
      });
  };

  // --- 超时处理 ---
  // 普通命令：运行超过前台预算（默认 60s）时，自动转入后台继续执行
  // sleep 命令：不设前台超时，由通知监听决定是否转后台
  if (timeout > 0) {
    timeoutId = setTimeout(() => triggerAutoBackground('timeout'), timeout);
  }

  async function resolveForegroundResult(baseResult: {
    stdout: string;
    stderr: string;
    exitCode: number;
    interrupted: boolean;
    backgroundTaskId?: string;
    assistantAutoBackgrounded?: boolean;
  }, _rawOutput: string) {
    const result: BashToolOutput = {
      stdout: baseResult.stdout,
      stderr: baseResult.stderr,
      exitCode: baseResult.exitCode,
      interrupted: baseResult.interrupted,
      backgroundTaskId: baseResult.backgroundTaskId,
      assistantAutoBackgrounded: baseResult.assistantAutoBackgrounded,
    };



    if (resultResolve) {
      resultResolve(result);
    }
  }

  /** 安全的 fullOutput 追加 */
  function appendFullOutput(text: string) {
    if (fullOutput.length < MAX_PERSISTED_SIZE) {
      const remaining = MAX_PERSISTED_SIZE - fullOutput.length;
      fullOutput += text.slice(0, remaining);
    }
  }

  // --- 流式解码 ---
  // GBK 是多字节编码，一个字符可能被 TCP/管道分包切割在两个 chunk 边界上。
  // 对每个 chunk 独立 iconv.decode 会把被截断的多字节序列解成乱码。
  // 这里使用 iconv-lite 的流式 Decoder：不完整的多字节序列留在解码器内部，
  // 与下一个 chunk 拼接后再解码，既不会乱码也不会发生字节错位
  // （不能靠"扣下最后一个字节"的启发式判断字符边界：GBK 尾字节范围
  //   0x40-0xFE 与首字节 0x81-0xFE 重叠，会把完整字符的尾字节误扣下，
  //   与下一个 chunk 的首字节拼成错误字符并导致后续整段错位）。
  const useGbk = process.platform === 'win32' && shellInfo.type !== 'bash';
  interface StreamDecoder {
    write: (data: Buffer) => string;
    /** 冲刷解码器内部残留字节（进程退出 / 转入后台前调用），幂等 */
    end: () => string;
  }
  function createDecoder(): StreamDecoder {
    if (!useGbk) {
      return {
        write: (data: Buffer) => data.toString('utf-8'),
        end: () => '',
      };
    }
    const decoder = iconv.getDecoder('gbk');
    let ended = false;
    return {
      write: (data: Buffer) => (ended ? '' : decoder.write(data)),
      end: () => {
        if (ended) return '';
        ended = true;
        return decoder.end() ?? '';
      },
    };
  }
  const stdoutDecoder = createDecoder();
  const stderrDecoder = createDecoder();

  /**
   * 上报流式进度。
   *
   * `fullOutput` 走与最终结果相同的统一上限（4K，前 2K + 后 2K）：工具层是唯一
   * 的截断入口，宿主 / UI 不再各自限制单次推送大小。
   * totalLines / totalBytes 仍按完整输出统计，保证 UI 上的规模信息不缩水。
   */
  const emitProgress = (chunk: string) => {
    if (!onProgress || isResolved) return;
    const elapsedTimeSeconds = (Date.now() - startTime) / 1000;
    onProgress({
      output: chunk,
      fullOutput: capResultContent(fullOutput),
      elapsedTimeSeconds,
      totalLines: fullOutput.split('\n').length,
      totalBytes: fullOutput.length,
    });
  };

  // 处理标准输出
  child.stdout?.on('data', (data: Buffer) => {
    const text = stdoutDecoder.write(data);
    appendFullOutput(text);
    emitProgress(text);
  });

  // 处理标准错误
  child.stderr?.on('data', (data: Buffer) => {
    const text = stderrDecoder.write(data);
    stderr += text;
    appendFullOutput(text);
    emitProgress(text);
  });

  // 处理进程退出
  child.on('close', (code) => {
    if (!isResolved) {
      isResolved = true;
      unsubscribeBgCompleted();
      unsubscribeSleepNotify?.();
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);

      // 冲刷解码器内部残留字节（最后可能遗留一个不完整/完整的多字节字符）
      const flushedStdout = stdoutDecoder.end();
      if (flushedStdout) appendFullOutput(flushedStdout);
      const flushedStderr = stderrDecoder.end();
      if (flushedStderr) {
        stderr += flushedStderr;
        appendFullOutput(flushedStderr);
      }

      resolveForegroundResult({
        stdout: fullOutput,
        stderr,
        exitCode: code ?? 0,
        interrupted: false,
      }, fullOutput);
    }
  });

  // 处理错误
  child.on('error', (error) => {
    if (!isResolved) {
      isResolved = true;
      unsubscribeBgCompleted();
      unsubscribeSleepNotify?.();
      if (timeoutId) clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', onAbort);

      resolveForegroundResult({
        stdout: fullOutput,
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        interrupted: false,
      }, fullOutput);
    }
  });

  return resultPromise;
}

/**
 * 将前台运行超时的命令转入后台继续执行
 *
 * 1. 创建 file-mode TaskOutput 并用当前已收集的输出初始化文件
 * 2. 移除之前 pipe 模式的所有 listeners
 * 3. 将 stdout/stderr 重定向到文件 (通过 pipe -> write)
 * 4. 注册为后台任务，完成后通知 LLM
 * 5. 返回带有 assistantAutoBackgrounded 标记的结果
 */
async function autoBackgroundCommand(
  child: import('child_process').ChildProcess,
  command: string,
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  description: string | undefined,
  toolUseId: string | undefined,
  agentId: string | undefined,
  sessionID: string | undefined,
  currentOutput: string,
  currentStderr: string,
  startTime: number,
): Promise<BashToolOutput> {
  const taskId = `bg-auto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const taskOutput = new TaskOutput(taskId, null, true);

  await TaskOutput.ensureOutputDir();

  // 将已有的输出写入文件
  try {
    await taskOutput.ensureDir();
    const { writeFile } = await import('fs/promises');
    // 先写入已有的完整输出（作为文件的开头）
    await writeFile(taskOutput.path, currentOutput, 'utf-8');
  } catch (err) {
    logger.warn('Exec', `Failed to write current output to file for auto-background: ${err}`);
  }

  // 移除之前 pipe 模式的 listeners
  child.removeAllListeners('close');
  child.removeAllListeners('error');
  if (child.stdout) {
    child.stdout.removeAllListeners('data');
  }
  if (child.stderr) {
    child.stderr.removeAllListeners('data');
  }

  // 创建文件写入流，将后续输出追加到文件
  let fileHandle: import('fs').promises.FileHandle | undefined;
  try {
    fileHandle = await open(taskOutput.path, process.platform === 'win32' ? 'a' : (
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0)
    ));
  } catch (err) {
    logger.error('Exec', `Failed to open output file for auto-background: ${err}`);
    // fallback: 杀掉进程
    try { child.kill('SIGKILL'); } catch { /* OK */ }
    return {
      stdout: currentOutput,
      stderr: `Command timed out after ${Date.now() - startTime}ms, and failed to open output file for auto-background: ${err}`,
      exitCode: 124,
      interrupted: true,
    };
  }

  // 将后续 stdout/stderr 写入文件
  if (child.stdout) {
    child.stdout.on('data', (data: Buffer) => {
      if (fileHandle) {
        fileHandle.write(data as any).catch(() => { /* ignore write errors after close */ });
      }
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (data: Buffer) => {
      if (fileHandle) {
        fileHandle.write(data as any).catch(() => { /* ignore write errors after close */ });
      }
    });
  }

  // 包装为 ShellCommand（后台模式，超时不杀进程）
  // 重要：使用全新的 AbortController，避免父进程的 abort 信号传播到后台进程
  // 当用户点击中止时，不应杀掉已经自动转入后台的命令
  const bgAbortController = new AbortController();
  const shellCommand = wrapSpawn(
    child,
    bgAbortController.signal,
    AUTO_BG_TIMEOUT_MS, // 0 = no timeout
    taskOutput,
    false, // shouldAutoBackground - 已经是在 auto-background 中了
  );

  // 注册为后台任务
  registerBackgroundTask(
    shellCommand,
    description || command,
    command,
    toolUseId,
    agentId,
    sessionID,
  );

  const elapsed = Date.now() - startTime;
  logger.info('Exec', `Foreground command auto-backgrounded: "${description || command}" (taskId=${taskId}, ran for ${elapsed}ms)`);

  // 检测命令中是否包含 find，如果是则添加提示
  const containsFind = /\bfind\b/.test(command);
  let reminder = '';
  if (containsFind) {
    reminder = '\n[reminder] The command contains `find` and took longer than expected. Try re-reading the user\'s request carefully — there is usually a clue about the exact file path or pattern to use, which can help narrow the search scope.';
  }

  // 返回带有已收集部分输出和 auto-background 标记的结果
  return {
    stdout: currentOutput,
    stderr: `Command has been running for ${elapsed}ms and has been automatically moved to background.\n${currentStderr}Background task ID: ${taskId}\nYou will be notified when the command completes.${reminder}`,
    exitCode: 0,
    interrupted: true,
    backgroundTaskId: taskId,
    assistantAutoBackgrounded: true,
  };
}

/**
 * 后台执行（file mode）
 *
 * 1. spawn 时将 stdout/stderr 重定向到文件 fd
 * 2. 创建 ShellCommand 包装管理生命周期
 * 3. 注册为 LocalShellTask，完成后自动通知 LLM
 * 4. 立即返回 { backgroundTaskId }
 */
async function execBackground(
  command: string,
  timeout: number,
  cwd?: string,
  signal?: AbortSignal,
  description?: string,
  toolUseId?: string,
  agentId?: string,
  sessionID?: string,
): Promise<BashToolOutput> {
  const startTime = Date.now();

  // 检测可用的 shell
  const shellInfo: ShellInfo = await findSuitableShell();
  const { path: shell, args: shellArgsBase } = shellInfo;
  const shellArgs = [...shellArgsBase, command];

  // 生成任务 ID 并创建 TaskOutput（file mode）
  const taskId = `bg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const taskOutput = new TaskOutput(taskId, null, true);

  // 确保输出目录存在并打开输出文件
  await TaskOutput.ensureOutputDir();

  let outputHandle: import('fs').promises.FileHandle | undefined;
  try {
    outputHandle = await open(taskOutput.path, process.platform === 'win32' ? 'w' : (
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0)
    ));
  } catch (err) {
    logger.error('Exec', 'Failed to open output file:', err);
    return {
      stdout: '',
      stderr: `Failed to open output file for background command: ${err}`,
      exitCode: 1,
      interrupted: false,
    };
  }

  try {
    const child = spawn(shell, shellArgs, {
      cwd,
      env: process.env,
      stdio: ['pipe', outputHandle.fd, outputHandle.fd],
      detached: true, // 关键：使子进程独立于父进程
      windowsHide: true,
    });

    // 父进程关闭 fd 副本，子进程有自己的 dup
    try {
      await outputHandle.close();
      outputHandle = undefined;
    } catch {
      // 可能已被子进程关闭
    }

    // 包装为 ShellCommand
    // 使用全新的 AbortController，使后台命令不受父进程 abort 影响
    const bgAbortController = new AbortController();
    const shellCommand = wrapSpawn(
      child,
      bgAbortController.signal,
      timeout,
      taskOutput,
      true, // shouldAutoBackground
    );

    // 注册为后台任务（这将调用 shellCommand.background() + 监听 result）
    registerBackgroundTask(
      shellCommand,
      description || command,
      command,
      toolUseId,
      agentId,
      sessionID,
    );

    const elapsed = Date.now() - startTime;
    logger.info('Exec', `Background command started: "${description || command}" (taskId=${taskId}, spawn took ${elapsed}ms)`);

    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      interrupted: false,
      backgroundTaskId: taskId,
    };
  } catch (error) {
    // spawn 失败时需要清理 fd
    if (outputHandle) {
      try { await outputHandle.close(); } catch { /* OK */ }
    }
    taskOutput.clear();

    logger.error('Exec', 'Failed to spawn background command:', error);
    return {
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: 1,
      interrupted: false,
    };
  }
}

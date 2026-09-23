/**
 * Ripgrep utility for executing rg.exe
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getExtensionPath, getProjectRoot } from '../history/Config.js';

const execFileAsync = promisify(execFile);

const MAX_BUFFER_SIZE = 20_000_000; // 20MB

/**
 * 当前平台/架构对应的预编译 ripgrep 目录名（`<arch>-<platform>`），
 * 与 resources/ripgrep 下的目录命名保持一致。
 * 没有预编译产物时返回 null（回退到 PATH 中的系统 rg）。
 */
function getRipgrepSubDir(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    return `${arch}-win32`;
  }
  if (platform === 'linux' && arch === 'x64') {
    return 'x64-linux';
  }
  return null;
}

/**
 * Get the path to the ripgrep executable
 */
async function getRipgrepPath(): Promise<string> {
  const platform = process.platform;
  const subDir = getRipgrepSubDir();

  // 当前平台/架构没有预编译产物（macOS / linux-arm64 等）：回退到系统 rg
  if (!subDir) {
    return 'rg';
  }

  const exeName = platform === 'win32' ? 'rg.exe' : 'rg';

  // 优先用 getExtensionPath（生产环境：extension/dist/resources/ripgrep/<subDir>/）
  try {
    const exePath = path.join(getExtensionPath(), 'dist', 'resources', 'ripgrep', subDir, exeName);
    await fs.access(exePath);
    return exePath;
  } catch {
    // getExtensionPath 不可用（dev 模式）或产物缺失，fallback 到 getProjectRoot
  }

  // Fallback: getProjectRoot + resources/ripgrep/<subDir>/（dev 模式，未 build 时）
  const bundledPath = path.join(getProjectRoot(), 'resources', 'ripgrep', subDir, exeName);
  try {
    await fs.access(bundledPath);
    return bundledPath;
  } catch {
    // 打包产物缺失时也回退到 PATH 中的系统 rg
    return 'rg';
  }
}

/**
 * 在 Windows 环境下，删除目标目录中误创建的 `nul` 文件
 * 
 * Windows 保留设备名（如 nul, CON, PRN 等）在 Git Bash 中可能被误创建为物理文件，
 * 导致 ripgrep 扫描时行为异常。此函数检测并清理这类文件。
 */
async function cleanupNulFile(target: string): Promise<void> {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const nulPath = path.join(target, 'nul');
    await fs.access(nulPath);
    // 文件存在，删除它
    await fs.unlink(nulPath);
    console.warn(`[ripgrep] Removed accidentally created 'nul' file in: ${target}`);
  } catch {
    // 文件不存在或无法访问，不做处理
  }
}

/**
 * Execute ripgrep with the given arguments
 */
export async function ripGrep(
  args: string[],
  target: string,
  options: {
    timeout?: number;
    abortSignal?: AbortSignal;
  } = {},
): Promise<string[]> {
  // Windows 环境下清理目标目录中的 nul 文件，避免 ripgrep 行为异常
  await cleanupNulFile(target);

  const rgPath = await getRipgrepPath();
  const timeout = options.timeout ?? 20000; // 20 seconds default

  const fullArgs = [...args, target];

  try {
    const { stdout } = await execFileAsync(rgPath, fullArgs, {
      maxBuffer: MAX_BUFFER_SIZE,
      timeout,
      signal: options.abortSignal,
      windowsHide: true,
    });

    return stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (error: any) {
    // Exit code 1 means no matches found - return empty array
    if (error.code === 1) {
      return [];
    }

    // AbortError means the operation was cancelled
    if (error.name === 'AbortError') {
      return [];
    }

    // Re-throw other errors
    throw error;
  }
}

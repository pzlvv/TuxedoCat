/**
 * Ripgrep utility for executing rg.exe
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { getExtensionPath } from '../history/Config.js';

const execFileAsync = promisify(execFile);

const MAX_BUFFER_SIZE = 20_000_000; // 20MB

/**
 * Get the path to the ripgrep executable
 */
async function getRipgrepPath(): Promise<string> {
  // Try to find rg.exe in the resources directory
  const platform = process.platform;
  const arch = process.arch;

  // In production (VSCode extension), resources are in extensionPath/dist/resources
  let rgDir: string;

  if (platform === 'win32' && arch === 'x64') {
    rgDir = path.join(getExtensionPath(), 'dist', 'resources', 'ripgrep', 'x64-win32');
  } else if (platform === 'linux' && arch === 'x64') {
    rgDir = path.join(getExtensionPath(), 'dist', 'resources', 'ripgrep', 'x64-linux');
  } else {
    // Fallback to system rg
    return 'rg';
  }

  const rgPath = path.join(rgDir, platform === 'win32' ? 'rg.exe' : 'rg');

  await fs.access(rgPath);
  return rgPath;
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

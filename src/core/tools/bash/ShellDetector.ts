/**
 * Shell 检测器
 * 自动检测可用的 shell
 */

import * as fs from 'fs';
import { spawn } from 'child_process';
import { logger } from '../../Logger.js';

export type ShellType = 'bash' | 'powershell' | 'cmd';

export interface ShellInfo {
  type: ShellType;
  path: string;
  args: string[];
  name: string;
}

/**
 * 检测 bash 是否可用
 *
 * 优先级：Git Bash > PATH 里的 bash > 常见安装位置 > WSL
 * Windows 上优先使用 Git Bash，WSL 仅作为最后兜底。
 */
async function detectBash(): Promise<ShellInfo | null> {
  // 1. 优先通过 git.exe 安装路径推断 Git Bash 位置（最靠谱的方式）
  const gitDirBash = await detectBashFromGitDir();
  if (gitDirBash) {
    return gitDirBash;
  }

  // 2. 尝试常见 Git Bash / MSYS2 / Cygwin 安装路径
  const gitBashFromCommonPaths = await detectBashFromCommonPaths();
  if (gitBashFromCommonPaths) {
    return gitBashFromCommonPaths;
  }

  // 3. 通过 PATH 查找 bash
  const pathBash = await detectBashFromPath();
  if (pathBash) {
    return pathBash;
  }

  return null;
}

/**
 * 尝试从常见安装路径查找 Git Bash / MSYS2 / Cygwin
 */
async function detectBashFromCommonPaths(): Promise<ShellInfo | null> {
  const possiblePaths: string[] = [
    // Git for Windows - 标准安装
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    // Git for Windows - 32位
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    // Git for Windows - 便携版 / 自定义位置常见路径
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
    'D:\\Git\\bin\\bash.exe',
    'D:\\Git\\usr\\bin\\bash.exe',
    'E:\\Git\\bin\\bash.exe',
    'E:\\Git\\usr\\bin\\bash.exe',
    // Scoop 安装的 Git
    'C:\\Users\\%USERNAME%\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe',
    'C:\\Users\\%USERNAME%\\scoop\\apps\\git\\current\\bin\\bash.exe',
    // Chocolatey 安装的 Git
    'C:\\ProgramData\\chocolatey\\lib\\git\\tools\\usr\\bin\\bash.exe',
    // MSYS2
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\msys32\\usr\\bin\\bash.exe',
    // Cygwin
    'C:\\cygwin64\\bin\\bash.exe',
    'C:\\cygwin\\bin\\bash.exe',
    // Unix-like systems (WSL 内路径等)
    '/bin/bash',
    '/usr/local/bin/bash',
    '/usr/bin/bash',
  ];

  // 展开 %USERNAME% 环境变量
  const expandedPaths = possiblePaths.map(p => p.replace(/%USERNAME%/g, process.env.USERNAME || ''));

  for (const bashPath of expandedPaths) {
    try {
      if (!fs.existsSync(bashPath)) {
        continue;
      }

      await testShell(bashPath, ['--version']);

      let name = 'bash';
      if (bashPath.toLowerCase().includes('git')) {
        name = 'bash (Git Bash)';
      } else if (bashPath.toLowerCase().includes('msys')) {
        name = 'bash (MSYS2)';
      } else if (bashPath.toLowerCase().includes('cygwin')) {
        name = 'bash (Cygwin)';
      }

      return {
        type: 'bash',
        path: bashPath,
        args: ['-c'],
        name,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 通过 PATH 环境变量查找 bash（使用 where.exe / which）
 */
async function detectBashFromPath(): Promise<ShellInfo | null> {
  // Windows 使用 where.exe，Unix 使用 which
  const findCmd = process.platform === 'win32' ? 'where.exe' : 'which';

  return new Promise((resolve) => {
    const child = spawn(findCmd, ['bash'], {
      windowsHide: true,
    });

    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', async (code) => {
      if (code !== 0 || !stdout.trim()) {
        resolve(null);
        return;
      }

      // where.exe 可能返回多行（PATH 中有多个 bash），取第一个
      const firstPath = stdout.trim().split(/\r?\n/)[0].trim();
      if (!firstPath) {
        resolve(null);
        return;
      }

      try {
        await testShell(firstPath, ['--version']);
        resolve({
          type: 'bash',
          path: firstPath,
          args: ['-c'],
          name: firstPath.toLowerCase().includes('git') ? 'bash (Git Bash)' : 'bash',
        });
      } catch {
        resolve(null);
      }
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * 通过 git.exe 的位置推断 Git Bash 的安装路径
 * Git for Windows 的 bash 通常在 git.exe 同级目录的 ../bin/bash.exe 或 ../usr/bin/bash.exe
 */
async function detectBashFromGitDir(): Promise<ShellInfo | null> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], {
      windowsHide: true,
    });

    let stdout = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('close', async () => {
      const firstGitPath = stdout.trim().split(/\r?\n/)[0].trim();
      if (!firstGitPath) {
        resolve(null);
        return;
      }

      // git.exe 可能在 Git/cmd/git.exe 或 Git/bin/git.exe
      // Git Bash 通常位于 Git/bin/bash.exe 或 Git/usr/bin/bash.exe
      const gitDir = firstGitPath.replace(/[/\\]git\.exe$/i, '').replace(/[/\\]cmd$/i, '');

      const candidates = [
        `${gitDir}\\bin\\bash.exe`,
        `${gitDir}\\usr\\bin\\bash.exe`,
      ];

      for (const bashPath of candidates) {
        try {
          if (!fs.existsSync(bashPath)) {
            continue;
          }
          await testShell(bashPath, ['--version']);
          resolve({
            type: 'bash',
            path: bashPath,
            args: ['-c'],
            name: 'bash (Git Bash)',
          });
          return;
        } catch {
          continue;
        }
      }

      resolve(null);
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * 检测 PowerShell 是否可用
 */
async function detectPowerShell(): Promise<ShellInfo | null> {
  const possiblePaths = [
    'powershell.exe',
    'pwsh.exe', // PowerShell Core
  ];

  for (const psPath of possiblePaths) {
    try {
      await testShell(psPath, ['-Command', 'echo test']);

      return {
        type: 'powershell',
        path: psPath,
        args: ['-NoProfile', '-NonInteractive', '-Command'],
        name: 'PowerShell',
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 测试 shell 是否可执行
 */
function testShell(shellPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(shellPath, args, {
      windowsHide: true,
      timeout: 5000,
    });

    let stderr = '';

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Shell test failed with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * 缓存检测到的 shell
 */
let cachedShell: ShellInfo | null = null;

/**
 * 查找合适的 shell
 * 优先级：bash > PowerShell > cmd
 */
export async function findSuitableShell(): Promise<ShellInfo> {
  if (cachedShell) {
    return cachedShell;
  }

  // 非Windows 系统，直接使用 /bin/bash
  if (process.platform !== 'win32') {
    cachedShell = {
      type: 'bash',
      path: process.env.SHELL || '/bin/bash',
      args: ['-c'],
      name: 'bash',
    };
    logger.info('ShellDetector', `Using Unix shell: ${cachedShell.path}`);
    return cachedShell;
  }

  // Windows: 优先尝试 bash
  const bash = await detectBash();
  if (bash) {
    cachedShell = bash;
    const shellVariant = bash.path.includes('wsl') ? ' (WSL)' : ' (Git Bash)';
    logger.info('ShellDetector', `Using bash${shellVariant}: ${bash.path}`);
    return bash;
  }

  // 回退到 PowerShell
  const powershell = await detectPowerShell();
  if (powershell) {
    cachedShell = powershell;
    logger.info('ShellDetector', `Using PowerShell: ${powershell.path}`);
    return powershell;
  }

  // 最后回退到 cmd.exe
  cachedShell = {
    type: 'cmd',
    path: 'cmd.exe',
    args: ['/s', '/c'],
    name: 'cmd',
  };
  logger.info('ShellDetector', `Using cmd.exe (fallback)`);

  return cachedShell;
}

/**
 * 获取当前 shell 类型（同步）
 */
export function getCurrentShellType(): ShellType {
  return cachedShell?.type || 'powershell';
}



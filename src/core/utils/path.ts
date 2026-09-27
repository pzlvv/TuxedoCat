/**
 * 路径处理工具
 * 展开路径（支持 ~、相对路径等）
 */

import * as path from 'path';
import * as os from 'os';

/**
 * 展开路径（支持 ~、相对路径等）
 * @param filePath 要展开的路径
 * @param baseDir 相对路径的基准目录（会话自己的工作目录）
 * @returns 展开后的绝对路径
 */
export function expandPath(filePath: string, baseDir: string): string {
  if (typeof filePath !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof filePath}`);
  }

  const trimmedPath = filePath.trim();

  // 空路径，返回基准目录（会话工作目录）
  if (!trimmedPath) {
    return baseDir;
  }

  // 处理 ~ （主目录）
  if (trimmedPath === '~') {
    return os.homedir();
  }

  // 处理 ~/ （主目录下的路径）
  if (trimmedPath.startsWith('~/')) {
    return path.join(os.homedir(), trimmedPath.slice(2));
  }

  // Windows: 处理 WSL 路径 /mnt/d/xxx -> D:\xxx
  if (process.platform === 'win32') {
    // /mnt/d/xxx -> D:\xxx
    if (/^\/mnt\/([a-z])\//i.test(trimmedPath)) {
      const drive = trimmedPath[5]; // /mnt/[d]/... -> drive letter at index 5
      const rest = trimmedPath.slice(7); // skip "/mnt/d/"
      return path.normalize(`${drive.toUpperCase()}:\\${rest}`);
    }
    // /mnt/d (无尾随斜杠) -> D:\
    if (/^\/mnt\/([a-z])$/i.test(trimmedPath)) {
      const driveLetter = trimmedPath[5];
      return path.normalize(`${driveLetter.toUpperCase()}:\\`);
    }

    // Windows: 处理 /c/Users/... 风格的路径
    if (/^\/[a-z]\//i.test(trimmedPath)) {
      const drive = trimmedPath[1];
      const rest = trimmedPath.slice(2);
      return path.normalize(`${drive}:\\${rest}`);
    }
  }

  // 绝对路径：规范化后返回
  if (path.isAbsolute(trimmedPath)) {
    return path.normalize(trimmedPath);
  }

  // 相对路径：基于基准目录（会话工作目录）解析并规范化
  const resolvedPath = path.normalize(path.resolve(baseDir, trimmedPath));

  return resolvedPath;
}

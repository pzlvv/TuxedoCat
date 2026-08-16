/**
 * 文件锁机制
 * 用于避免多个进程同时写入历史文件
 */

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { getRandomValues } from 'crypto';

interface LockOptions {
  /**
   * 锁文件过期时间（毫秒）
   * 如果锁文件超过此时间未修改，视为过期
   */
  stale?: number;

  /**
   * 重试配置
   */
  retries?: {
    /**
     * 重试次数
     */
    retries: number;
    /**
     * 最小重试间隔（毫秒）
     */
    minTimeout: number;
  };
}

/**
 * 生成唯一的锁 token
 */
function generateLockToken(): string {
  const buffer = new Uint8Array(16);
  getRandomValues(buffer);
  return Array.from(buffer, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 获取锁文件路径
 */
function getLockPath(targetPath: string): string {
  return join(targetPath + '.lock');
}

/**
 * 解析锁文件内容
 */
function parseLockFile(content: string): { token: string; timestamp: number } | null {
  const parts = content.split('\n');
  if (parts.length >= 2) {
    return {
      token: parts[0],
      timestamp: parseInt(parts[1], 10),
    };
  }
  return null;
}

/**
 * 获取锁
 * @param targetPath - 要锁定的目标文件路径
 * @param options - 锁选项
 * @returns 释放锁的函数
 */
export async function lock(
  targetPath: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  const lockPath = getLockPath(targetPath);
  const stale = options?.stale ?? 10000; // 默认 10 秒过期
  const retryConfig = options?.retries ?? { retries: 3, minTimeout: 50 };

  const token = generateLockToken();
  const _startTime = Date.now(); // eslint-disable-line @typescript-eslint/no-unused-vars

  async function acquire(): Promise<void> {
    try {
      // 尝试读取现有锁文件
      try {
        const existingLock = await readFile(lockPath, 'utf8');
        const lockData = parseLockFile(existingLock);

        if (lockData) {
          const age = Date.now() - lockData.timestamp;

          // 检查锁是否过期
          if (age < stale) {
            // 锁仍然有效
            throw new Error('Lock is held by another process');
          } else {
            // 锁已过期，删除它
            await unlink(lockPath);
          }
        }
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
        // 文件不存在，继续创建锁
      }

      // 创建新的锁文件
      const lockContent = `${token}\n${Date.now()}\n`;
      await writeFile(lockPath, lockContent, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // 锁文件已存在，可能已被其他进程创建
        throw new Error('Lock is held by another process');
      }
      throw error;
    }
  }

  async function tryAcquireWithRetry(attempt = 0): Promise<void> {
    try {
      await acquire();
    } catch (error) {
      if (attempt >= retryConfig.retries) {
        throw new Error(`Failed to acquire lock after ${retryConfig.retries} retries: ${error}`);
      }

      // 指数退避
      const delay = retryConfig.minTimeout * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
      await tryAcquireWithRetry(attempt + 1);
    }
  }

  await tryAcquireWithRetry();

  // 返回释放锁的函数
  return async function release(): Promise<void> {
    try {
      const lockContent = await readFile(lockPath, 'utf8');
      const lockData = parseLockFile(lockContent);

      // 只有锁的持有者才能释放锁
      if (lockData && lockData.token === token) {
        await unlink(lockPath);
      }
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        // 记录错误但不要抛出
      }
    }
  };
}

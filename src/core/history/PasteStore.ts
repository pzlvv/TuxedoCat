/**
 * Paste Store - 大文本缓存存储
 * 使用 content-addressable 存储，相同内容只存储一份
 */

import { createHash } from 'crypto';
import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises';
import { getPasteCacheDir } from './Config.js';

/**
 * 计算文本内容的 hash（SHA256 的前 16 位）
 */
export function hashPastedText(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * 获取 paste 文件路径
 */
function getPastePath(hash: string): string {
  return join(getPasteCacheDir(), `${hash}.txt`);
}

/**
 * 存储粘贴的文本内容
 * @param hash - 内容 hash（应提前计算）
 * @param content - 文本内容
 */
export async function storePastedText(hash: string, content: string): Promise<void> {
  try {
    const pastePath = getPastePath(hash);
    await writeFile(pastePath, content, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error(`[PasteStore] Failed to store paste ${hash}:`, error);
  }
}

/**
 * 检索粘贴的文本内容
 * @param hash - 内容 hash
 * @returns 文本内容，未找到返回 null
 */
export async function retrievePastedText(hash: string): Promise<string | null> {
  try {
    const pastePath = getPastePath(hash);
    return await readFile(pastePath, { encoding: 'utf8' });
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error(`[PasteStore] Failed to retrieve paste ${hash}:`, error);
    }
    return null;
  }
}

/**
 * 清理过期的 paste 文件
 * @param cutoffDate - 截止日期，早于此日期的文件将被删除
 */
export async function cleanupOldPastes(cutoffDate: Date): Promise<void> {
  const pasteDir = getPasteCacheDir();
  const files = await readdir(pasteDir);
  const cutoffTime = cutoffDate.getTime();
  for (const file of files) {
    if (!file.endsWith('.txt')) {
      continue;
    }

    const filePath = join(pasteDir, file);
    const stats = await stat(filePath);
    if (stats.mtimeMs < cutoffTime) {
      await unlink(filePath);
    }
  }
}

// 导入 path 模块
import { join } from 'path';

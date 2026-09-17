/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import { mkdir, writeFile, stat as fsStat, link, copyFile, truncate as fsTruncate, unlink, readdir } from 'fs/promises';
import { join } from 'path';
import { getProjectConversationDir, getProjectRoot, ensureProjectConversationDir } from '../history/Config.js';
import { logger } from '../Logger.js';

/**
 * 预览大小阈值
 * 当输出超过此大小时，stdout 只包含预览，完整内容持久化到文件
 */
export const PREVIEW_SIZE_BYTES = 8 * 1024; // 8KB

/**
 * 持久化输出最大大小（超过此大小会被截断）
 */
export const MAX_PERSISTED_SIZE = 64 * 1024 * 1024; // 64MB

// XML tag used to wrap persisted output messages
export const PERSISTED_OUTPUT_TAG = '<persisted-output>';
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>';

/**
 * 获取工具结果目录
 */
export function getToolResultsDir(): string {
  return join(getProjectConversationDir(getProjectRoot()), 'tool-results');
}

/**
 * 工具结果文件名的会话前缀：`<sessionId>__<id>.<ext>`。
 *
 * 文件名带 sessionId，删除对话时按前缀直接清理，无需回扫消息内容。
 * 分隔符用双下划线：sessionId 形如 `session_<ts>_<rand>`，只含单个下划线，
 * 不会与其他会话的前缀（如 `session_1_ab` 与 `session_1_abc`）混淆。
 */
const SESSION_PREFIX_SEPARATOR = '__';

/** 工具结果文件的会话前缀（用于按会话清理） */
export function getToolResultFilePrefix(sessionId: string): string {
  return `${sessionId}${SESSION_PREFIX_SEPARATOR}`;
}

/**
 * 获取工具结果文件路径（文件名带会话前缀，便于按会话清理）
 */
export function getToolResultPath(sessionId: string, id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt';
  return join(getToolResultsDir(), `${getToolResultFilePrefix(sessionId)}${id}.${ext}`);
}

/**
 * 确保工具结果目录存在
 */
export async function ensureToolResultsDir(): Promise<void> {
  await ensureProjectConversationDir(getProjectRoot());
  await mkdir(getToolResultsDir(), { recursive: true });
}

/**
 * 生成内容的预览，尽可能在新行边界处截断
 */
export function generatePreview(
  content: string,
  maxBytes: number,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }

  // 在限制范围内查找最后一个换行符，避免截断在行中间
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf('\n');

  // 如果找到的新行在合理位置，使用它；否则直接使用精确限制
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;

  return { preview: content.slice(0, cutPoint), hasMore: true };
}

/**
 * 构建大型工具结果的持久化消息（带预览）
 */
export function buildLargeToolResultMessage(
  filepath: string,
  originalSize: number,
  preview: string,
  hasMore: boolean,
): string {
  const sizeKB = Math.round(originalSize / 1024);
  let message = `${PERSISTED_OUTPUT_TAG}\n`;
  message += `Output too large (${sizeKB}KB). Full output saved to: ${filepath}\n\n`;
  message += `Preview (first ${Math.round(PREVIEW_SIZE_BYTES / 1024)}KB):\n`;
  message += preview;
  message += hasMore ? '\n...\n' : '\n';
  message += PERSISTED_OUTPUT_CLOSING_TAG;
  return message;
}

/**
 * 持久化大型输出到磁盘
 *
 * @param stdout - stdout 内容
 * @param sessionId - 会话 ID（写入文件名前缀，便于删除对话时清理）
 * @param taskId - 任务 ID（用于文件名）
 * @returns 持久化信息，如果无需持久化则返回 null
 */
export async function persistLargeOutput(
  stdout: string,
  sessionId: string,
  taskId: string,
): Promise<{
  filepath: string;
  originalSize: number;
  preview: string;
  hasMore: boolean;
} | null> {
  // 如果输出太小，不需要持久化
  if (stdout.length <= PREVIEW_SIZE_BYTES) {
    return null;
  }

  try {
    await ensureToolResultsDir();
    const filepath = getToolResultPath(sessionId, taskId, false);
    const originalSize = stdout.length;

    // 如果超过最大持久化大小，截断
    let contentToWrite = stdout;
    if (originalSize > MAX_PERSISTED_SIZE) {
      contentToWrite = stdout.slice(0, MAX_PERSISTED_SIZE);
      contentToWrite += `\n... [output truncated to ${Math.round(MAX_PERSISTED_SIZE / 1024 / 1024)}MB]`;
    }

    // 写入文件
    await writeFile(filepath, contentToWrite, { encoding: 'utf-8' });

    // 生成预览
    const { preview, hasMore } = generatePreview(stdout, PREVIEW_SIZE_BYTES);

    logger.info('toolResultStorage', `Persisted large output to ${filepath} (${Math.round(originalSize / 1024)}KB)`);

    return {
      filepath,
      originalSize,
      preview,
      hasMore,
    };
  } catch (error) {
    logger.error('toolResultStorage', 'Failed to persist large output:', error);
    return null;
  }
}

/**
 * 从给定的 outputFilePath 持久化输出到工具结果目录
 * 用于处理 TaskOutput 产生的大文件
 */
export async function persistOutputFile(
  outputFilePath: string,
  sessionId: string,
  taskId: string,
): Promise<{
  filepath: string;
  originalSize: number;
} | null> {
  try {
    const fileStat = await fsStat(outputFilePath);
    const originalSize = fileStat.size;

    await ensureToolResultsDir();
    const dest = getToolResultPath(sessionId, taskId, false);

    // 超过最大持久化大小时截断
    if (fileStat.size > MAX_PERSISTED_SIZE) {
      await fsTruncate(outputFilePath, MAX_PERSISTED_SIZE);
    }

    try {
      await link(outputFilePath, dest);
    } catch {
      await copyFile(outputFilePath, dest);
    }

    logger.info('toolResultStorage', `Persisted output file from ${outputFilePath} to ${dest} (${Math.round(originalSize / 1024)}KB)`);

    return {
      filepath: dest,
      originalSize,
    };
  } catch {
    // 文件可能已删除 - stdout 预览已足够
    return null;
  }
}

/**
 * 删除指定会话在 tool-results 下的全部会话关联文件。
 *
 * 持久化工具结果（见 getToolResultPath）与 Read 工具生成的 pandoc 转换结果
 * （见 Read.convertDocToMd）文件名都带会话前缀，这里按前缀扫描目录直接删除，
 * 不需要回扫对话消息内容。
 *
 * @returns 实际删除的文件数
 */
export async function deleteSessionToolResults(sessionId: string): Promise<number> {
  const toolResultsDir = getToolResultsDir();
  const prefix = getToolResultFilePrefix(sessionId);

  let entries;
  try {
    entries = await readdir(toolResultsDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn('toolResultStorage', `读取 tool-results 目录失败: ${err}`);
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    try {
      await unlink(join(toolResultsDir, entry.name));
      removed += 1;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        logger.warn('toolResultStorage', `删除工具结果文件失败 ${entry.name}: ${err}`);
      }
    }
  }

  return removed;
}

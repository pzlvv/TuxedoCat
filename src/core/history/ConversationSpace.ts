/**
 * 对话空间管理
 *
 * 负责统计各对话空间的大小，并支持清空其中的对话数据。
 */

import { readdir, readFile, stat, rm, unlink } from 'fs/promises';
import { join, basename } from 'path';
import { getConversationDir, WORKSPACE_META_FILE } from './Config.js';
import { resetConversationCache, resetConversationListCache } from './Conversation.js';

/** 单个对话空间的统计信息 */
export interface ConversationSpaceInfo {
  /** 对话空间标识 */
  dirName: string;
  /** 对话空间对应的项目路径 */
  projectPath: string;
  /** 该空间的总大小（字节） */
  sizeBytes: number;
  /** 该空间内的文件数 */
  fileCount: number;
  /** 该空间内的会话数 */
  conversationCount: number;
  /**
   * 项目目录是否已不存在（`projectPath` 为空时恒为 false，无从判定不提示）。
   * core 的统计顺带核实这个事实（统计在 core 侧机器上跑，本地 / 远程口径一致）；
   * 「要不要提示清理」由 UI 决定。
   */
  workspaceMissing: boolean;
}

/** 递归计算目录大小和文件数 */
async function getDirSize(dir: string): Promise<{ sizeBytes: number; fileCount: number }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { sizeBytes: 0, fileCount: 0 };
  }

  let sizeBytes = 0;
  let fileCount = 0;
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        const sub = await getDirSize(fullPath);
        sizeBytes += sub.sizeBytes;
        fileCount += sub.fileCount;
      } else if (entry.isFile()) {
        const st = await stat(fullPath);
        sizeBytes += st.size;
        fileCount += 1;
      }
      // 符号链接不跟随，避免循环/越界统计
    } catch {
      // 单个文件读取失败不影响整体统计
    }
  }

  return { sizeBytes, fileCount };
}

/** 读取对话空间项目清单 `workspace.meta.json` 中的 workspacePath */
async function readWorkspacePath(dirPath: string): Promise<string> {
  try {
    const content = await readFile(join(dirPath, 'workspace.meta.json'), 'utf8');
    const settings = JSON.parse(content) as { workspacePath?: unknown };
    if (typeof settings.workspacePath === 'string' && settings.workspacePath.trim()) {
      return settings.workspacePath.trim();
    }
  } catch {
    // workspace.meta.json 不存在或解析失败，使用目录名兜底
  }

  try {
    return decodeURIComponent(basename(dirPath));
  } catch {
    return basename(dirPath);
  }
}

/** 项目目录是否还存在（读失败按不存在处理） */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 统计 conversations 下所有对话空间 */
export async function getConversationSpaces(): Promise<ConversationSpaceInfo[]> {
  const conversationDir = getConversationDir();
  let entries;
  try {
    entries = await readdir(conversationDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const spaces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<ConversationSpaceInfo> => {
        const dirPath = join(conversationDir, entry.name);
        const [size, projectPath, conversationCount] = await Promise.all([
          getDirSize(dirPath),
          readWorkspacePath(dirPath),
          countConversations(dirPath),
        ]);
        return {
          dirName: entry.name,
          projectPath,
          sizeBytes: size.sizeBytes,
          fileCount: size.fileCount,
          conversationCount,
          workspaceMissing: projectPath !== '' && !(await pathExists(projectPath)),
        };
      }),
  );

  spaces.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return spaces;
}

/** 统计对话空间内的会话数（`<sessionId>.meta.json`；空间清单不算会话） */
async function countConversations(dirPath: string): Promise<number> {
  try {
    const files = await readdir(dirPath);
    return files.filter(
      (file) => file.endsWith('.meta.json') && file !== 'workspace.meta.json',
    ).length;
  } catch {
    return 0;
  }
}

/**
 * 清空指定对话空间中的对话数据，保留空间级配置。
 */
export async function clearConversationSpace(
  dirName: string,
): Promise<{ removedFiles: number; removedBytes: number }> {
  const conversationDir = getConversationDir();
  const safeBase = basename(dirName);
  if (!dirName || safeBase !== dirName || dirName === '.' || dirName === '..') {
    throw new Error('Invalid conversation space directory name');
  }

  const dirPath = join(conversationDir, dirName);
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(`Conversation space not found: ${dirName}`);
    }
    throw err;
  }

  let removedFiles = 0;
  let removedBytes = 0;

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const isToolResults = entry.name === 'tool-results';
    const isJsonl = entry.isFile() && entry.name.endsWith('.jsonl');
    // workspace.meta.json 也以 .meta.json 结尾，但它是空间级配置（保留，
    // 与 Rust 侧 clear_conversation_space 同口径）
    const isMeta =
      entry.isFile() && entry.name.endsWith('.meta.json') && entry.name !== WORKSPACE_META_FILE;

    if (!isToolResults && !isJsonl && !isMeta) {
      continue;
    }

    try {
      if (isToolResults) {
        const size = await getDirSize(fullPath);
        removedFiles += size.fileCount;
        removedBytes += size.sizeBytes;
        await rm(fullPath, { recursive: true, force: true });
      } else {
        try {
          const st = await stat(fullPath);
          removedBytes += st.size;
        } catch {
          // 文件可能已不存在，继续删除
        }
        await unlink(fullPath);
        removedFiles += 1;
      }
    } catch (err) {
      // 单个文件删除失败不阻断后续清理
      console.error(`[ConversationSpace] Failed to remove ${fullPath}:`, err);
    }
  }

  // 清理内存缓存，避免 UI 继续显示已删除的会话/列表
  resetConversationCache();
  resetConversationListCache();

  return { removedFiles, removedBytes };
}

/**
 * 删除整个对话空间目录（连 `workspace.meta.json` 一起）。
 *
 * 与 `clearConversationSpace` 的区别：项目目录已不存在时空间级配置再无意义，
 * 只有把目录整个删掉，列表才不会再显示它。删除前先统计（回执要带删除量）。
 */
export async function removeConversationSpace(
  dirName: string,
): Promise<{ removedFiles: number; removedBytes: number }> {
  const conversationDir = getConversationDir();
  const safeBase = basename(dirName);
  if (!dirName || safeBase !== dirName || dirName === '.' || dirName === '..') {
    throw new Error('Invalid conversation space directory name');
  }

  const dirPath = join(conversationDir, dirName);
  if (!(await pathExists(dirPath))) {
    throw new Error(`Conversation space not found: ${dirName}`);
  }

  const size = await getDirSize(dirPath);
  await rm(dirPath, { recursive: true, force: true });

  // 清理内存缓存，避免 UI 继续显示已删除的会话/列表
  resetConversationCache();
  resetConversationListCache();

  return { removedFiles: size.fileCount, removedBytes: size.sizeBytes };
}

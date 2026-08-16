/**
 * 历史消息管理
 * 提供历史消息的写入、读取和管理功能
 */

import { appendFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { createReadStream } from 'fs';
import type { HistoryEntry, LogEntry, StoredPastedContent, TimestampedHistoryEntry } from './Types.js';
import { getHistoryFilePath, getProjectRoot, ensureConfigDirs } from './Config.js';
import { lock } from './Lockfile.js';
import { hashPastedText, storePastedText, retrievePastedText } from './PasteStore.js';

/**
 * 安全的 JSON 序列化，确保 \u2028（行分隔符）和 \u2029（段落分隔符）被转义。
 * Node.js 的 JSON.stringify 默认不转义这些字符，会导致 JSONL 文件损坏。
 */
function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// 配置常量
const MAX_HISTORY_ITEMS = 100;
const MAX_PASTED_CONTENT_LENGTH = 1024; // 1KB

// 状态管理
let pendingEntries: LogEntry[] = [];
let isWriting = false;
let currentFlushPromise: Promise<void> | null = null;
let lastAddedEntry: LogEntry | null = null;
let cleanupRegistered = false;
let sessionId: string | null = null;

/**
 * 获取或生成会话 ID
 */
function getSessionId(): string {
  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
  return sessionId;
}

/**
 * 解析日志条目
 */
function parseLogEntry(line: string): LogEntry | null {
  try {
    return JSON.parse(line) as LogEntry;
  } catch (error) {
    console.error('[History] Failed to parse log entry:', error);
    return null;
  }
}

/**
 * 解析存储的粘贴内容为完整内容
 */
async function resolveStoredPastedContent(
  stored: StoredPastedContent,
): Promise<StoredPastedContent> {
  // 如果有内联内容，直接返回
  if (stored.content) {
    return stored;
  }

  // 如果有 hash 引用，从 paste store 加载
  if (stored.contentHash) {
    const content = await retrievePastedText(stored.contentHash);
    if (content) {
      return {
        ...stored,
        content,
      };
    }
  }

  // 内容不可用
  return stored;
}

/**
 * 将 LogEntry 转换为 HistoryEntry
 */
async function logEntryToHistoryEntry(entry: LogEntry): Promise<HistoryEntry> {
  const pastedContents: Record<number, StoredPastedContent> = {};

  for (const [id, stored] of Object.entries(entry.pastedContents || {})) {
    const resolved = await resolveStoredPastedContent(stored);
    pastedContents[Number(id)] = resolved;
  }

  return {
    display: entry.display,
    pastedContents: pastedContents as any,
  };
}

/**
 * 反向读取文件的行
 */
async function* readLinesReverse(filePath: string): AsyncGenerator<string> {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });

  try {
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    const lines: string[] = [];

    for await (const line of rl) {
      lines.push(line);
    }

    // 反向输出
    for (let i = lines.length - 1; i >= 0; i--) {
      yield lines[i];
    }
  } finally {
    fileStream.close();
  }
}

/**
 * 创建日志条目读取器
 */
async function* makeLogEntryReader(): AsyncGenerator<LogEntry> {
  // 先从内存缓冲区读取（最新的未刷新条目）
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield pendingEntries[i];
  }

  // 再从磁盘读取
  const historyPath = getHistoryFilePath();

  try {
    for await (const line of readLinesReverse(historyPath)) {
      const entry = parseLogEntry(line);
      if (entry) {
        yield entry;
      }
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('[History] Failed to read history file:', error);
    }
    // 文件不存在是正常情况，直接返回
  }
}

/**
 * 立即刷新历史到磁盘
 */
async function immediateFlushHistory(): Promise<void> {
  if (pendingEntries.length === 0) {
    return;
  }

  let release: (() => Promise<void>) | null = null;
  try {
    const historyPath = getHistoryFilePath();

    // 确保文件存在
    await writeFile(historyPath, '', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    });

    // 获取文件锁
    release = await lock(historyPath, {
      stale: 10000,
      retries: {
        retries: 3,
        minTimeout: 50,
      },
    });

    // 批量写入
    const jsonLines = pendingEntries.map(entry => safeJsonStringify(entry) + '\n');
    pendingEntries = [];

    await appendFile(historyPath, jsonLines.join(''), { mode: 0o600 });
  } catch (error) {
    console.error('[History] Failed to write history:', error);
  } finally {
    if (release) {
      await release();
    }
  }
}

/**
 * 刷新历史（带重试）
 */
async function flushPromptHistory(retries: number): Promise<void> {
  if (isWriting || pendingEntries.length === 0) {
    return;
  }

  // 停止尝试刷新
  if (retries > 5) {
    return;
  }

  isWriting = true;

  try {
    await immediateFlushHistory();
  } finally {
    isWriting = false;

    if (pendingEntries.length > 0) {
      // 避免热循环，延迟后再试
      await new Promise(resolve => setTimeout(resolve, 500));
      await flushPromptHistory(retries + 1);
    }
  }
}

/**
 * 添加到提示历史（内部函数）
 */
async function addToPromptHistory(command: HistoryEntry | string): Promise<void> {
  // 确保配置目录存在
  await ensureConfigDirs();

  const entry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command;

  const storedPastedContents: Record<number, StoredPastedContent> = {};

  if (entry.pastedContents) {
    for (const [id, content] of Object.entries(entry.pastedContents)) {
      // 过滤掉图片（图片单独存储）
      if (content.type === 'image') {
        continue;
      }

      // 对于小文本，内联存储
      if (content.content.length <= MAX_PASTED_CONTENT_LENGTH) {
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          content: content.content,
          mediaType: content.mediaType,
          filename: content.filename,
        };
      } else {
        // 对于大文本，计算 hash 并存储引用
        const hash = hashPastedText(content.content);
        storedPastedContents[Number(id)] = {
          id: content.id,
          type: content.type,
          contentHash: hash,
          mediaType: content.mediaType,
          filename: content.filename,
        };
        // 异步写入磁盘，不阻塞历史条目创建
        void storePastedText(hash, content.content);
      }
    }
  }

  const logEntry: LogEntry = {
    ...entry,
    pastedContents: storedPastedContents,
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  };

  pendingEntries.push(logEntry);
  lastAddedEntry = logEntry;
  currentFlushPromise = flushPromptHistory(0);
  void currentFlushPromise;
}

/**
 * 添加到历史（公开函数）
 * @param command - 历史条目或命令字符串
 */
export function addToHistory(command: HistoryEntry | string): void {
  void addToPromptHistory(command);
}

/**
 * 获取历史条目（当前项目）
 */
export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const currentProject = getProjectRoot();
  const currentSession = getSessionId();
  const otherSessionEntries: LogEntry[] = [];
  let yielded = 0;

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') {
      continue;
    }
    if (entry.project !== currentProject) {
      continue;
    }

    if (entry.sessionId === currentSession) {
      yield await logEntryToHistoryEntry(entry);
      yielded++;
    } else {
      otherSessionEntries.push(entry);
    }

    if (yielded + otherSessionEntries.length >= MAX_HISTORY_ITEMS) {
      break;
    }
  }

  for (const entry of otherSessionEntries) {
    if (yielded >= MAX_HISTORY_ITEMS) {
      return;
    }
    yield await logEntryToHistoryEntry(entry);
    yielded++;
  }
}

/**
 * 获取带时间戳的历史条目（用于 UI 显示）
 */
export async function* getTimestampedHistory(): AsyncGenerator<TimestampedHistoryEntry> {
  const currentProject = getProjectRoot();
  const seen = new Set<string>();

  for await (const entry of makeLogEntryReader()) {
    if (!entry || typeof entry.project !== 'string') {
      continue;
    }
    if (entry.project !== currentProject) {
      continue;
    }
    if (seen.has(entry.display)) {
      continue;
    }
    seen.add(entry.display);

    yield {
      display: entry.display,
      timestamp: entry.timestamp,
      resolve: () => logEntryToHistoryEntry(entry),
    };

    if (seen.size >= MAX_HISTORY_ITEMS) {
      return;
    }
  }
}

/**
 * 撤销最后一条历史记录
 */
export function removeLastFromHistory(): void {
  if (!lastAddedEntry) {
    return;
  }
  const entry = lastAddedEntry;
  lastAddedEntry = null;

  const idx = pendingEntries.lastIndexOf(entry);
  if (idx !== -1) {
    pendingEntries.splice(idx, 1);
  }
}

/**
 * 清空待写入的历史条目
 */
export function clearPendingHistoryEntries(): void {
  pendingEntries = [];
  lastAddedEntry = null;
}

/**
 * 等待历史刷新完成
 */
export async function waitForFlush(): Promise<void> {
  if (currentFlushPromise) {
    await currentFlushPromise;
  }
}

/**
 * 注册进程退出时的清理
 */
export function registerCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;

  process.on('exit', () => {
    if (pendingEntries.length > 0) {
      // 同步写入（exit 时不能用异步）
      // 这里只是记录，实际写入需要在 beforeExit 事件
    }
  });

  process.on('beforeExit', async () => {
    if (pendingEntries.length > 0) {
      await immediateFlushHistory();
    }
  });
}

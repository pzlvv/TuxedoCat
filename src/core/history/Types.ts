/**
 * 历史消息类型定义
 */

/**
 * 粘贴的内容类型
 */
export interface PastedContent {
  id: number;
  type: 'text' | 'image';
  content: string;
  mediaType?: string;
  filename?: string;
}

/**
 * 历史消息条目（内存中使用）
 */
export interface HistoryEntry {
  display: string;
  pastedContents: Record<number, PastedContent>;
}

/**
 * 存储的粘贴内容（磁盘存储）
 */
export interface StoredPastedContent {
  id: number;
  type: 'text' | 'image';
  content?: string; // 小内容直接内联
  contentHash?: string; // 大内容存储 hash 引用
  mediaType?: string;
  filename?: string;
}

/**
 * 日志条目（存储在 history.jsonl）
 */
export interface LogEntry {
  display: string;
  pastedContents: Record<number, StoredPastedContent>;
  timestamp: number;
  project: string;
  sessionId?: string;
}

/**
 * 对话是否涉及远程通信
 */
export interface ConversationRemoteInfo {
  /** 是否涉及远程通信（跨节点消息发送/接收） */
  isRemote: boolean;
}

/**
 * 带时间戳的历史条目（用于 UI 显示）
 */
export interface TimestampedHistoryEntry {
  display: string;
  timestamp: number;
  resolve: () => Promise<HistoryEntry>;
}

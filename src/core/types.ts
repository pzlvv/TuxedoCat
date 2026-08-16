/**
 * 类型定义 - 消息和核心数据结构
 */

/**
 * 消息类型 - 核心消息联合类型
 */
export type Message =
  | AssistantMessage
  | UserMessage
  | SystemMessage
  | StreamEvent
  | StreamRequestStartMessage
  | AttachmentMessage
  | TombstoneMessage

/**
 * 助手消息
 */
export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: Array<{ type: 'text' | 'tool_use' | 'thinking'; [key: string]: unknown }>
    usage?: unknown
    stop_reason?: string | null
  }
  uuid: string
  timestamp: number
  isApiErrorMessage?: boolean
}

/**
 * 用户消息
 */
export interface UserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: string | unknown[]
  }
  uuid: string
  timestamp: number
  isMeta?: boolean
  filePath?: string
  fileSelectedLines?: { start: number; end: number }
  /** 用户主动隐藏文件信息，不发给 LLM */
  fileHidden?: boolean
  /** 静默消息，不展示在 UI 中但会发给 LLM */
  silent?: boolean
}

/**
 * 系统消息
 */
export interface SystemMessage {
  type: 'system'
  subtype?: 'compact_boundary' | 'api_error' | 'local_command'
  content: string
  uuid?: string
  timestamp?: number
  compactMetadata?: unknown
}

/**
 * 流事件
 */
export interface StreamEvent {
  type: 'stream_event'
  event: {
    type: 'message_start' | 'message_delta' | 'message_stop' | string
    usage?: unknown
    delta?: unknown
  }
}

/**
 * 流请求开始消息
 */
export interface StreamRequestStartMessage {
  type: 'stream_request_start'
}

/**
 * 附件消息
 */
export interface AttachmentMessage {
  type: 'attachment'
  attachment: {
    type: 'edited_text_file' | 'max_turns_reached' | 'queued_command' | string
    [key: string]: unknown
  }
  uuid?: string
  timestamp?: number
}

/**
 * 墓碑消息 - 用于标记需要删除的消息
 */
export interface TombstoneMessage {
  type: 'tombstone'
  message: Message
}

/**
 * 终止状态 - 循环退出时的返回值
 */
export type Terminal = {
  reason: string
  error?: unknown
}

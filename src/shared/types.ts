/**
 * 类型定义 - 消息和核心数据结构
 */

/**
 * 消息来源统一标记。
 *
 * - `user`：用户真实输入（默认，未显式标记时按此处理）
 * - `agent`：子代理回复 / 提醒等系统自动消息（UI 以 markdown + From 头渲染）
 * - `bash`：后台 Bash 任务完成通知（UI 按纯文本 + ANSI 颜色渲染，不参与滚动置顶）
 *
 * 历史会话里用的是 `fromSubAgent` / `fromBashTask` 两个布尔字段，
 * 读取时统一由 `getMessageOrigin` 归一化，见 `utils/messageOrigin.ts`。
 */
export type MessageOrigin = 'user' | 'agent' | 'bash'

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
 * 压缩摘要里保存的用户输入历史条目（见 `docs/features/compaction.md`）。
 *
 * 只保留用户真实输入的纯文本与来源 uuid：uuid 用于跨多次压缩合并去重，
 * content 用于拼进摘要的「用户输入历史」章节。不存原始 content blocks，
 * 避免把图片 base64 等大块内容带进摘要。
 */
export interface UserInputHistoryEntry {
  uuid: string
  content: string
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
  /** 持久化元信息（文件引用 / agent 来源等），不进入 LLM content */
  _meta?: Record<string, unknown>
  /** 是否用户主动发送：只有这类消息才更新 meta.json 的 updatedAt（列表按最后一条用户消息排序） */
  _userInitiated?: boolean
  /** 随消息持久化的图片宽高（供标题生成使用，不进入 LLM content） */
  imageSizes?: Array<{ width?: number; height?: number }>
  /** 排队消息标记：真正进入 LLM 上下文时补发 addMessage 通知 UI */
  _needsUINotification?: boolean
  /** 压缩摘要消息标记（展开归档时用于区分摘要与普通消息） */
  isCompactSummary?: boolean
  /**
   * 压缩摘要携带的全局用户输入历史（最早 4 条 + 最近 8 条，见 `docs/features/compaction.md`）。
   *
   * 只写在 `isCompactSummary` 消息上。多次压缩时下一次压缩据此恢复会话最初的
   * 用户输入，避免"开头被压缩掉后再也回不来"。保留区里的用户输入不进这里。
   */
  compactUserInputHistory?: UserInputHistoryEntry[]
  /**
   * 消息来源（仅系统自动消息需要显式标记，用户消息留空即视为 `user`）。
   *
   * - `agent`：子代理产生的自动消息（Agent 回复 / 提醒），UI 上以代理身份展示
   *   （markdown + From 头），压缩时不进用户输入历史；
   * - `bash`：后台 Bash 任务完成通知，同样属于「非用户真实输入」，
   *   但 UI 按普通纯文本消息展示，不渲染 markdown。
   *
   * 兼容字段：历史会话里的 `fromSubAgent` / `fromBashTask` 由
   * `getMessageOrigin` 读取时归一化。
   */
  origin?: MessageOrigin
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

/**
 * 询问模式（agent mode）：
 * - manual：所有危险操作都询问用户
 * - risk：只拦截危险操作，普通操作自动放行
 * - auto：全部自动放行（AskUserQuestion 不可用）
 */
export type AgentMode = 'manual' | 'risk' | 'auto';

// ==================== core → UI 事件载荷（原 AssistantUI.ts，随总线化搬家）====================

/** 流式消息数据 */
export interface StreamMessageData {
  /** 消息角色：'thinking' 或 'assistant' */
  role: 'thinking' | 'assistant';
  /** 本次增量文本 */
  delta: string;
  /** 当前累积的完整文本 */
  accumulated: string;
  /** LLM 消息 ID，用于 WebView 精确匹配到对应消息，防止多轮对话覆盖 */
  streamId?: string;
}

/** 流结束数据 */
export interface StreamEndData {
  /** 消息角色：'thinking' 或 'assistant' */
  role: 'thinking' | 'assistant';
  /** 最终累积的完整文本 */
  accumulated: string;
  /** token 用量 */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** 思考（reasoning）部分的 token 数（Responses API: output_tokens_details.reasoning_tokens） */
    reasoning_tokens?: number;
  };
  /** LLM 消息 ID，用于 WebView 精确匹配到对应消息 */
  streamId?: string;
}

/**
 * 会话 Todo 条目（`TodoWrite` 的元素，`docs/features/todo-list.md` FR-001）。
 *
 * 与 core-rs 的 `tools::TodoEntry` 逐字段对应；三个字段全必选——事实未到达用「清单为空」
 * 表达，不用可选字段猜值。
 */
export interface TodoEntry {
  /** 命令式任务描述（如「跑测试」） */
  content: string;
  /** 状态；`in_progress` 同时只有一条是提示词纪律，运行期不做强制 */
  status: 'pending' | 'in_progress' | 'completed';
  /** 进行中时的现在进行时描述（如「跑测试中」），非进行中条目也必填 */
  activeForm: string;
}

export interface MessageData {
  role: 'user' | 'assistant' | 'thinking' | 'toolcall' | 'system';
  content: string;
  /** 用户消息的 uuid：与 `queuedMessage.uuid` 配对，供 webview 精确清除排队项 */
  messageUuid?: string;
  param?: string;
  filePath?: string;
  fileSelectedLines?: { start: number; end: number };
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;
  status?: 'normal' | 'success' | 'running' | 'fail';
  /** 当前请求的 context token 数（input_tokens） */
  contextLength?: number;
  /** 当前请求的 output token 数（output_tokens） */
  outputTokens?: number;
  /** 缓存读取 token 数 */
  cacheReadInputTokens?: number;
  /** 缓存创建 token 数 */
  cacheCreationInputTokens?: number;
  /** 是否是压缩摘要消息 */
  isCompactSummary?: boolean;
  /** 是否显示边框（用于子代理 Reply 回复） */
  hasBorder?: boolean;
  /**
   * 消息来源：`agent`（子代理）或 `bash`（后台任务通知）；
   * 用户消息留空即视为 `user`。UI 依赖它决定渲染方式与是否参与滚动置顶。
   */
  origin?: MessageOrigin;
  /**
   * 一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：`true` 即通知类消息——不进
   * `<sid>.jsonl` / LLM 上下文，core 只把它记进 `meta.json` 的 `onceMessage`（一个对话
   * 至多一条）；UI 在时间线末位显示，任何新节点追加前先移除。缺省即常规消息。
   */
  once?: boolean;
  /** 用户消息携带的图片（仅用于 UI 展示，LLM 请求使用 content blocks） */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  /** 消息元信息，如文件引用、agent来源等 */
  meta?: Record<string, unknown>;
}

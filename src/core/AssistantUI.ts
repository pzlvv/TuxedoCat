/**
 * AssistantUI - UI 层抽象接口
 * core 层通过此接口与 UI 通信，不依赖具体的 VSCode 实现
 */

import type { UIDynamicInfo } from './prompt/SystemPrompt.js';
import type { PermissionResult, ToolProgressData } from './tools/Tool.js';

/**
 * 全局 UI 实例
 */
let globalUI: AssistantUI | undefined;

/**
 * 设置全局 UI 实例
 */
export function setGlobalUI(ui: AssistantUI): void {
  globalUI = ui;
}

/**
 * 获取全局 UI 实例
 */
export function getGlobalUI(): AssistantUI | undefined {
  return globalUI;
}

export interface AssistantUI {
  /**
   * 通知工具调用开始前（UI 先显示，状态为 normal）
   * 同时调用 checkPermissions 获取权限结果，避免重复计算
   * @param toolUseId 工具调用的唯一 ID（来自 toolUse.id）
   * @returns 权限结果，包含 behavior 和相关数据（beforeContent、afterContent 等）
   */
  onPreToolCall(sessionID: string, toolUseId: string, toolName: string, args: Record<string, any>, tool: unknown): Promise<PermissionResult>;

  /**
   * 通知工具调用开始（设置状态为 running）
   * @param toolUseId 工具调用的唯一 ID（来自 toolUse.id）
   */
  onToolCall(sessionID: string, toolUseId: string, toolName: string): void;

  /**
   * 通知工具执行结果
   * @param toolUseId 工具调用的唯一 ID（来自 toolUse.id）
   */
  onToolResult(sessionID: string, toolUseId: string, toolName: string, output: string, status: 'success' | 'error'): void;

  /**
   * 更新已存在工具卡片的参数
   * 用于工具执行过程中需要补全/修正展示参数的场景（如 WebSearch 卡片在
   * output_item.done 后获得完整 queries/url，更新卡片上显示的搜索词）。
   * @param toolUseId 工具调用的唯一 ID
   * @param args 要合并进 toolArgs 的参数
   */
  updateToolArgs(sessionID: string, toolUseId: string, args: Record<string, unknown>): void;

  /**
   * 工具执行进度（流式输出）
   * Bash 等工具在运行期间会多次回调，携带已累积的完整输出，
   * UI 层可实时刷新展示，无需等待完整输出
   * @param toolUseId 工具调用的唯一 ID（来自 toolUse.id）
   * @param progress 进度数据（type 区分具体工具）
   */
  onToolProgress(sessionID: string, toolUseId: string, progress: ToolProgressData): void;

  /**
   * 请求用户选择或确认
   * 在 checkPermissions 时调用
   * @returns 用户的选择结果（index 和可选的回复文本）
   */
  requestUserChoice(sessionID: string, options: {
    toolName: string;
    message: string;
    choices?: Array<{ label: string; description?: string }>;
    showPreview?: boolean;
    previewContent?: string;
    previewTitle?: string;
    showDiff?: boolean;
    beforeContent?: string;
    afterContent?: string;
    diffTitle?: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }): Promise<{ index: number; reply?: string }>;

  /**
   * 发送消息到 UI
   */
  onMessage(sessionID: string, data: MessageData): void;

  /**
   * 通知用户中止操作
   */
  onAbort(sessionID: string): void;

  /**
   * AI 开始处理
   */
  onAIBegin(sessionID: string): void;

  /**
   * AI 处理结束
   */
  onAIEnd(sessionID: string): void;

  /**
   * 查询开始（消息队列从空变非空）
   */
  onQueryBegin(sessionID: string): void;

  /**
   * 查询结束（消息队列从非空变空）
   */
  onQueryEnd(sessionID: string): void;

  /**
   * 获取 UI 动态信息
   * 用于生成 system prompt 的 UI 相关部分（当前文件、选中行等）
   */
  getUIDynamicInfo(sessionID: string): Promise<UIDynamicInfo>;

  /**
   * 设置对话标题
   */
  setTitle(sessionID: string, title: string): void;

  /**
   * 新会话创建通知
   * 用于子代理等场景，在会话文件创建后通知 UI（如 webview）预初始化状态
   */
  onSessionCreated(sessionID: string): void;

  /**
   * 刷新对话列表
   * 用于子代理等场景，新子会话的 meta.json 创建后，通知 UI（如 webview）
   * 重新加载对话列表，使子对话能正确显示并关联到主对话
   */
  refreshConversationList(): void | Promise<void>;

  /**
   * 节流/防抖刷新对话列表
   * 用于消息追加等高频场景；UI 层应合并短时间内的多次调用，避免频繁读盘
   */
  scheduleConversationListRefresh(): void;

  /**
   * 刷新已打开的 Spin 设计器，使其从磁盘重新加载 spin.json。
   * SpinLoop 执行过程中会直接更新磁盘 meta；若设计器仍持有旧缓存，
   * 用户后续保存会覆盖执行结果，因此执行完成后必须刷新。
   * 未打开设计器时无需处理。
   */
  refreshSpinDesign(): void | Promise<void>;

  /**
   * 压缩进度通知
   * @param sessionId 会话 ID
   * @param status 压缩状态
   * @param postCompactTokenCount 压缩后的 token 数（complete 时提供）
   */
  onCompressProgress(sessionId: string, status: 'start' | 'complete' | 'error', postCompactTokenCount?: number): void;

  /**
   * 清空 UI 上的对话消息列表
   * 用于压缩后清除旧消息，重新推送压缩后的内容
   */
  clearMessages(sessionID: string): void;

  /**
   * 展开压缩的对话
   * 从归档中恢复原始消息并重新加载
   */
  onExpandCompact(sessionID: string): Promise<void>;

  /**
   * 通知 UI 显示排队消息状态
   * @param sessionId 会话 ID
   * @param content 排队的消息内容，null 表示清除排队状态
   * @param images 排队的消息携带的图片
   * @param fileInfo 排队消息的文件上下文（供 queryEnd 重新投递时保留）
   */
  onQueuedMessage(sessionId: string, content: string | null, images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>, fileInfo?: { filePath?: string; selectedLines?: { start: number; end: number }; fileHidden?: boolean }): void;

  /**
   * 命令发送回调
   * 当内置命令即将执行时调用，UI 层在此判断命令名并执行客户端操作（如调用 webview 原子能力）。
   * @param commandName 命令名（如 'clear'）
   * @param args 命令参数
   * @param sessionId 会话 ID
   * @returns true 表示 UI 层已处理客户端操作
   */
  onCommandSend(commandName: string, args: string, sessionId: string): Promise<boolean>;

  // ========== 流式消息接口 ==========

  /**
   * 流式消息增量更新
   * 在 LLM 流式输出时，逐 delta 通知 UI 追加内容
   * @param sessionID 会话 ID
   * @param data 流式消息数据（增量 + 累积内容）
   */
  onStreamMessage(sessionID: string, data: StreamMessageData): void;

  /**
   * 流结束通知
   * 在 LLM 流式输出完成时，通知 UI 最终状态
   * @param sessionID 会话 ID
   * @param data 流结束数据（最终累积内容 + token 用量）
   */
  onStreamEnd(sessionID: string, data: StreamEndData): void;
}

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

export interface MessageData {
  role: 'user' | 'assistant' | 'thinking' | 'toolcall' | 'system';
  content: string;
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
  /** 是否来自代理消息 */
  isFromAgent?: boolean;
  /** 用户消息携带的图片（仅用于 UI 展示，LLM 请求使用 content blocks） */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  /** 消息元信息，如文件引用、agent来源等 */
  meta?: Record<string, unknown>;
}

// 重新导出 UIDynamicInfo 类型
export type { UIDynamicInfo } from './prompt/SystemPrompt.js';

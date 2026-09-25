/**
 * VSCode extension -> webview 消息的联合类型（discriminated union）
 * 在 host（WebViewUI）与 webview/App.tsx 中共享使用
 */

import type { MessageData, MessageOrigin } from './types.js';

/** 一个 MCP 服务器的展示信息（来自 ~/<configDir>/mcp.json + settings.json 启用状态） */
export interface McpServerInfo {
  /** 服务器名（mcp.json 中的 key） */
  name: string;
  /** 传输类型，如 local / stdio / remote / http / sse */
  type: string;
  /** 启动命令（统一为数组形式；远程传输时为空数组） */
  command: string[];
  /** 环境变量（仅 local 传输） */
  environment: Record<string, string>;
  /** 远程 MCP 端点（Streamable HTTP 或旧版 SSE 的入口地址；仅 remote 传输） */
  url: string;
  /** 远程请求附带的 HTTP 头（如 Authorization；仅 remote 传输） */
  headers: Record<string, string>;
  /** 是否启用（来自 settings.json，默认 false） */
  enabled: boolean;
  /** 运行时：进程是否已连接（未启用时为 false） */
  running?: boolean;
  /** 运行时：已发现的工具数量 */
  toolCount?: number;
  /** 运行时：启动/运行错误信息，null 表示正常 */
  error?: string | null;
  /** 运行时：当前引用该服务器的会话数（引用计数模型） */
  refCount?: number;
}

/**
 * 一个 provider 及其模型列表（供输入框菜单按 provider 分组展示）。
 * 模型名与 provider 分开存放，不拼接。
 */
export interface ProviderModels {
  /** provider key（baseURL 的 hostname） */
  key: string;
  /** 该 provider 的模型列表 */
  models: string[];
}

/** 对话空间统计信息 */
export interface ConversationSpaceInfo {
  /** 对话空间标识 */
  dirName: string;
  /** 对话空间对应的项目路径 */
  projectPath: string;
  /** 空间总大小（字节） */
  sizeBytes: number;
  /** 空间内文件数 */
  fileCount: number;
  /** 空间内会话数 */
  conversationCount: number;
}

export type WebviewMessage = {
  type: 'addMessage';
  sessionId: string;
  role: 'user' | 'thinking' | 'toolcall' | 'system' | 'assistant';
  /**
   * 用户消息的 uuid：与 `queuedMessage.uuid` 配对，供 webview 精确清除排队项。
   * 只有代表用户输入的用户气泡携带该字段。
   */
  messageUuid?: string;
  content: string;
  param?: string;
  filePath?: string;
  fileSelectedLines?: { start: number; end: number };
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status?: 'normal' | 'success' | 'running' | 'fail';
  toolCallId?: string;
  /** APi 返回的 input_tokens（当前上下文总 token 数，不含本次 output） */
  contextLength?: number;
  /** API 返回的 output_tokens（本次输出 token 数） */
  outputTokens?: number;
  /** API 返回的缓存读取 token 数 */
  cacheReadInputTokens?: number;
  /** API 返回的缓存创建 token 数 */
  cacheCreationInputTokens?: number;
  /** 是否是压缩摘要消息 */
  isCompactSummary?: boolean;
  /** 是否显示边框（用于子代理 Reply 回复） */
  hasBorder?: boolean;
  /**
   * 消息来源：`agent`（子代理 Reply）或 `bash`（后台任务通知）；
   * 用户消息留空即视为 `user`。
   *
   * 与 `MessageData.origin` 一一对应；宿主 `onMessage` 会把该字段原样透传，
   * webview 的 `toUiMessage` 依赖它区分「真正的用户消息」与系统通知。
   */
  origin?: MessageOrigin;
  /** 消息元信息，如文件引用、agent来源等 */
  meta?: Record<string, unknown>;
  /** 标记为压缩折叠区域的消息（加载时从 boundary 开始） */
  isCompactCollapsed?: boolean;
  /** 用户消息携带的图片（仅用于 UI 展示，LLM 请求使用 content blocks） */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
} | {
  type: 'showThinkingAnimation';
  sessionId: string;
  show?: boolean;
} | {
  type: 'setTheme';
  theme: 'dark' | 'light';
} | {
  /**
   * 运行期切换视图模式（宿主 → webview）。
   * Electron 悬浮窗隐藏原生侧栏后，对话列表改由 webview 顶栏渲染（single），
   * 同时隐藏「关闭当前会话」、把「新建对话」入口移到顶栏。
   */
  type: 'setConversationListMode';
  mode: 'single' | 'multi';
} | {
  type: 'setCurrentFile';
  filePath?: string;
  selectedLines?: { start: number; end: number };
} | {
  type: 'setTitle';
  sessionId: string;
  title: string;
} | {
  type: 'aiBegin';
  sessionId: string;
} | {
  type: 'aiEnd';
  sessionId: string;
} | {
  type: 'queryBegin';
  sessionId: string;
} | {
  type: 'queryEnd';
  sessionId: string;
} | {
  type: 'updateToolArgs';
  sessionId: string;
  toolCallId: string;
  contextBefore?: string[];
  contextAfter?: string[];
  beforeContent?: string;
  afterContent?: string;
  /** Edit 紧凑 diff 数据（只含 diff 相关行） */
  diffHunks?: unknown[];
  startLine?: number;
  endLine?: number;
  /** 通用参数更新：合并进现有 toolArgs（如 WebSearch 的 action/queries/url） */
  toolArgs?: Record<string, unknown>;
} | {
  type: 'requestUserChoice';
  sessionId: string;
  choiceId: string;
  toolName: string;
  message: string;
  choices?: Array<{ label: string; description?: string }>;
} | {
  type: 'updateToolStatus';
  sessionId: string;
  toolCallId: string;
  output?: string;
  status?: 'normal' | 'success' | 'running' | 'fail';
  startLine?: number;
  endLine?: number;
} | {
  type: 'toolProgress';
  sessionId: string;
  toolCallId: string;
  /** 当前已累积的完整输出（流式） */
  output?: string;
  /** 是否仍在流式输出中 */
  isStreaming?: boolean;
  /** 已运行秒数 */
  elapsedTimeSeconds?: number;
  /** 已输出行数 */
  totalLines?: number;
  /** 已输出字节数 */
  totalBytes?: number;
  /** 后台任务 ID（自动转后台时可能提供） */
  taskId?: string;
} | {
  type: 'conversationsData';
  conversations: Array<{ sessionId: string; title: string; createdAt: number; updatedAt: number; messageCount: number; parentSessionId?: string }>;
} | {
  /**
   * 会话运行时状态全量推送（core `sessionRuntimeChanged` → 宿主 → webview）。
   * 对话树的流水灯（idle / waiting）与 abort 按钮只读这份数据，不再从 `queryBegin` / `queryEnd` 推导。
   */
  type: 'sessionRuntimeStates';
  /** 全量快照；宿主不持有其所有权，调用方只读 */
  states: ReadonlyArray<{ sessionId: string; idle: boolean; waiting: boolean }>;
} | {
  type: 'conversationLoaded';
  conversation: {
    metadata?: {
      sessionId?: string;
      title?: string;
      context?: { currentFile?: string; selectedLines?: { start: number; end: number }; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; model?: string; provider?: string };
      parentSessionId?: string;
      model?: string;
      provider?: string;
    };
    messages?: unknown[]
  };
  pendingToolUseIds?: string[];
  /** 从 meta.json 恢复的上下文，webview 加载后直接应用 */
  savedContext?: { currentFile?: string; selectedLines?: { start: number; end: number }; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; provider?: string };
  parentSessionId?: string;
  /** 当前会话模型所属 provider（已按 provider 模型列表校验/回退） */
  provider?: string;
  /** 当前会话的 agent mode（运行时内存值，不持久化到文件） */
  agentMode?: 'manual' | 'risk' | 'auto';
  /** 引擎是否正在消费消息（查询进行中） */
  hasActiveQuery?: boolean;
  /** 当前会话活动阶段：thinking / text / tool / idle，用于恢复 thinking 动画 */
  activityPhase?: 'idle' | 'thinking' | 'text' | 'tool';
  /** 是否存在压缩归档（用于 webview 显示展开按钮） */
  hasCompactArchive?: boolean;
  /** 裁剪掉的 _meta 大字段索引：toolUseId -> 紧凑 diff 或 before/after 内容 */
  toolMetaMap?: Record<string, unknown>;
} | {
  type: 'respondUserChoice';
  choiceId: string;
  index: number;
  reply?: string;
} | {
  type: 'abort';
} | {
  type: 'error';
  message: string;
} | {
  type: 'setAgentMode';
  mode: 'manual' | 'risk' | 'auto';
  sessionId: string;
} | {
  type: 'setPromptMode';
  mode: 'normal' | 'minimal' | 'mixed';
  sessionId: string;
} | {
  type: 'setThinkingMode';
  mode: 'off' | 'low' | 'high' | 'max';
  sessionId: string;
} | {
  type: 'setModel';
  model: string;
  /** 模型所属 provider；model + provider 一起表征一个模型 */
  provider?: string;
  sessionId: string;
} | {
  type: 'setWebSearch';
  webSearch: boolean;
  sessionId: string;
} | {
  type: 'setNewConversationDefaults';
  sessionId: string;
  model: string;
  /** 默认模型所属 provider（model + provider 一起表征一个模型） */
  provider?: string;
  thinkingMode: 'off' | 'low' | 'high' | 'max';
  agentMode?: 'manual' | 'risk' | 'auto';
  promptMode?: 'normal' | 'minimal' | 'mixed';
  webSearch?: boolean;
} | {
  type: 'settingsDefaults';
  /** 默认模型（读取失败时为空串） */
  model: string;
  /** 默认模型所属 provider（activeProvider；无有效 provider 时为空串） */
  provider?: string;
  /**
   * 会话级默认值。读取 settings.json 失败时宿主无法给出这些值，
   * 会显式下发 undefined，由 webview 保持「未配置」状态（发送按钮禁用）。
   */
  thinkingMode?: 'off' | 'low' | 'high' | 'max';
  agentMode?: 'manual' | 'risk' | 'auto';
  promptMode?: 'normal' | 'minimal' | 'mixed';
  webSearch: boolean;
  language?: 'auto' | 'zh' | 'en';
  /** 是否已完成服务商配置（activeProvider 存在且 apiKey 非空） */
  providerConfigured?: boolean;
} | {
  type: 'requestModels';
} | {
  type: 'setModels';
  /**
   * 全部 provider 及其模型列表（按 provider 分组）。
   * 菜单按 provider 建立三级子菜单；模型名与 provider 分开，不拼接。
   */
  providers: ProviderModels[];
  /** 当前 activeProvider key（用于默认/勾选状态；无有效 provider 时为空串） */
  activeProvider?: string;
} | {
  type: 'compressProgress';
  sessionId: string;
  /** 压缩进度: 'start' | 'complete' | 'error' */
  status: 'start' | 'complete' | 'error';
  /** 压缩后的 token 使用量（complete 时提供） */
  postCompactTokenCount?: number;
} | {
  type: 'spinCommand';
  sessionId: string;
  cmd: 'init' | 'status' | 'auto';
  args?: string;
} | {
  type: 'messagesReplaced';
  sessionId: string;
  /** 整批替换后的消息（压缩后重建 / 展开归档共用；顺序即显示顺序） */
  messages: MessageData[];
} | {
  type: 'queuedMessage';
  sessionId: string;
  /** 该排队消息的 uuid；与补发的用户气泡 `messageUuid` 配对，用于按消息精确清除 */
  uuid?: string;
  /** 排队的消息内容 */
  content: string;
  /** 排队的消息携带的图片 */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  /** 排队时选中的文件路径 */
  filePath?: string;
  /** 排队时选中的文件行号 */
  selectedLines?: { start: number; end: number };
  /** 排队时文件信息是否被用户隐藏 */
  fileHidden?: boolean;
} | {
  type: 'clearQueuedMessage';
  sessionId: string;
} | {
  type: 'setSkills';
  /** Skill 列表 */
  skills: Array<{ name: string; description: string; isBuiltin?: boolean }>;
} | {
  type: 'contextLimitUpdated';
  /** 系统当前的最大 context window */
  maxContextTokens: number;
} | {
  type: 'updateConversationContext';
  sessionId: string;
  currentFile?: string;
  selectedLines?: { start: number; end: number };
  totalContextTokens?: number;
} | {
  type: 'requestSkills';
} | {
  type: 'requestSessionRuntimeStates';
} | {
  type: 'streamMessage';
  sessionId: string;
  role: 'thinking' | 'assistant';
  /** 本次增量文本 */
  delta: string;
  /** 当前累积的完整文本 */
  accumulated: string;
  /** LLM 消息 ID，用于 WebView 端精确匹配到对应消息 */
  streamId?: string;
} | {
  type: 'streamEnd';
  sessionId: string;
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
  /** LLM 消息 ID */
  streamId?: string;
} | {
  type: 'renameConversation';
  sessionId: string;
  title: string;
} | {
  type: 'requestSmartNaming';
  sessionId: string;
  messages: Array<{ role: string; content: string }>;
} | {
  type: 'smartNamingResult';
  sessionId: string;
  title: string;
} | {
  type: 'rollbackEdit';
  sessionId: string;
  /** 要回滚到的目标工具调用 ID */
  toolUseId: string;
  /** 编辑的文件路径 */
  filePath: string;
  /** 回滚方向：'before' = 回滚到此修改前，'after' = 回滚到此修改后 */
  direction: 'before' | 'after';
} | {
  type: 'expandCompact';
  sessionId: string;
  /** 原消息数量（展开后加载用） */
  originalMessageCount?: number;
} | {
  type: 'expandCompactDone';
  sessionId: string;
} | {
  type: 'balanceUpdate';
  sessionId: string;
  /** 账户总余额；null 表示查询失败，webview 清空余额显示 */
  totalBalance: number | null;
  /** 货币类型；null 表示查询失败 */
  currency: string | null;
  /** 是否无限额度；null 表示查询失败 */
  isUnlimited: boolean | null;
  /** 查询时间戳 */
  fetchedAt: number;
} | {
  type: 'initSessionState';
  sessionId: string;
  /** 会话默认模型（可选） */
  model?: string;
  /** 会话默认模型所属 provider（可选） */
  provider?: string;
} | {
  type: 'llmConfigSaved';
  defaultModel?: string;
  /** 默认模型所属 provider（activeProvider） */
  defaultModelProvider?: string;
  /** 当前会话应使用的模型（已按会话 provider 模型列表校验/回退） */
  activeModel?: string;
  /** 当前会话应使用的模型所属 provider（与 activeModel 配套） */
  activeModelProvider?: string;
  thinkingEffort?: 'off' | 'low' | 'high' | 'max';
  defaultAgentMode?: 'manual' | 'risk' | 'auto';
  defaultPromptMode?: 'normal' | 'minimal' | 'mixed';
  webSearch?: boolean;
  language?: 'auto' | 'zh' | 'en';
  activeProvider?: string;
  closeAfterSave?: boolean;
} | {
  type: 'llmConfigSaveError';
  error?: string;
} | {
  type: 'toolMetaData';
  sessionId?: string;
  /** 工具 use id -> _meta 字段 */
  toolMeta?: Record<string, unknown>;
} | {
  type: 'showLLMConfig';
  /** 定向会话（多视图宿主据此把设置面板只弹到发起端） */
  sessionId?: string;
  baseURL?: string;
  webSearch?: boolean;
  thinkingEffort?: string;
  defaultModel?: string;
  defaultAgentMode?: string;
  defaultPromptMode?: 'normal' | 'minimal' | 'mixed';
  apiKey?: string;
  language?: 'auto' | 'zh' | 'en';
  /** 新结构：settings.json 的 llm.providers 列表（apiType 已下放到 modelConfigs[model].apiType） */
  providers?: Array<{
    key: string;
    baseURL: string;
    apiKey: string;
    models?: string[];
    defaultModel?: string;
    modelConfigs?: Record<string, { context?: number; output?: number; apiType?: string }>;
  }>;
  /** settings.json 的 llm.activeProvider */
  activeProvider?: string;
  /** 全局默认启用的 MCP 列表（设置面板「默认配置」编辑用） */
  mcpServers?: McpServerInfo[];
} | {
  type: 'providerModelsResult';
  /** 自动获取到的模型列表；为空表示获取失败 */
  models?: string[];
  /** 自动探测出的模型协议：模型名 -> apiType（Responses | OpenAI | Anthropic） */
  modelApiTypes?: Record<string, string>;
  /** 错误信息（可选） */
  error?: string;
} | {
  /**
   * 阶段一结果：模型列表已拉取，但协议探测需要用户确认（可能消耗少量 token）。
   * 面板据此弹出确认条，用户确认后再发 detectProviderModelApiTypes。
   */
  type: 'providerModelsFetched';
  /** 拉取到的完整模型列表 */
  models?: string[];
  /** 本次列表里已有协议的模型：模型名 -> apiType */
  modelApiTypes?: Record<string, string>;
  /** 尚未设置协议、需要用户确认后探测的模型 */
  needDetect?: string[];
} | {
  type: 'requestConversationSpaces';
} | {
  type: 'conversationSpacesData';
  spaces: ConversationSpaceInfo[];
} | {
  type: 'conversationSpacesError';
  error: string;
} | {
  type: 'clearConversationSpace';
  dirName: string;
} | {
  type: 'conversationSpaceCleared';
  dirName: string;
  removedFiles: number;
  removedBytes: number;
} | {
  type: 'setMcpServers';
  /** 该列表归属的会话 ID；缺省表示与具体会话无关（全局默认） */
  sessionId?: string;
  /** 所有可用 MCP 服务器及其启用状态 */
  servers: McpServerInfo[];
} | {
  /** 全局唤醒快捷键激活窗口后，要求 webview 聚焦输入框，便于直接开始输入 */
  type: 'focusInput';
} | {
  /**
   * 后台预热的「新对话」视图被宿主切到前台：补做被跳过的启动初始化
   * （见 electron/ChatViewManager.ts 的 spareKey / src/webview/App.tsx）。
   */
  type: 'activatePrewarmedView';
} | {
  /** 预热视图（webview → 宿主）：页面已挂载、可以接收 activatePrewarmedView */
  type: 'prewarmViewReady';
};

// 不包含 sessionId 的消息类型（调用方传入，postToWebview 会添加）
export type WebviewMessageWithoutSessionId = Omit<WebviewMessage, 'sessionId'>;

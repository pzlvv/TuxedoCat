/**
 * VSCode extension -> webview 消息的联合类型（discriminated union）
 * 在 VSCodeUI.ts 和 webview/App.tsx 中共享使用
 */

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
  /** 是否来自代理消息 */
  isFromAgent?: boolean;
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
  type: 'setEnableAbort';
  enable: boolean;
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
  type: 'conversationLoaded';
  conversation: {
    metadata?: {
      sessionId?: string;
      title?: string;
      context?: { currentFile?: string; selectedLines?: { start: number; end: number }; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; model?: string };
      parentSessionId?: string;
      model?: string;
    };
    messages?: unknown[]
  };
  pendingToolUseIds?: string[];
  /** 从 meta.json 恢复的上下文，webview 加载后直接应用 */
  savedContext?: { currentFile?: string; selectedLines?: { start: number; end: number }; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean };
  parentSessionId?: string;
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
  /** 压缩前原始消息数量（展开后加载用） */
  /** 由 core 侧 TimeStats 统一计算的耗时分布统计 */
  timeStats?: {
    toolExecution: number;
    aiThinking: number;
    humanFeedback: number;
    totalTime: number;
    toolPct: number;
    thinkingPct: number;
    humanPct: number;
    toolCount: number;
    thinkingCount: number;
    humanCount: number;
  };
} | {
  type: 'respondUserChoice';
  choiceId: string;
  index: number;
  reply?: string;
} | {
  type: 'abort';
} | {
  type: 'setActiveSessionId';
  sessionId: string;
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
  sessionId: string;
} | {
  type: 'setWebSearch';
  webSearch: boolean;
  sessionId: string;
} | {
  type: 'setNewConversationDefaults';
  sessionId: string;
  model: string;
  thinkingMode: 'off' | 'low' | 'high' | 'max';
  agentMode?: 'manual' | 'risk' | 'auto';
  promptMode?: 'normal' | 'minimal' | 'mixed';
  webSearch?: boolean;
} | {
  type: 'settingsDefaults';
  model: string;
  thinkingMode: 'off' | 'low' | 'high' | 'max';
  agentMode: 'manual' | 'risk' | 'auto';
  promptMode: 'normal' | 'minimal' | 'mixed';
  webSearch: boolean;
  language?: 'auto' | 'zh' | 'en';
  /** 是否已完成服务商配置（activeProvider 存在且 apiKey 非空） */
  providerConfigured?: boolean;
} | {
  type: 'requestModels';
} | {
  type: 'setModels';
  models: string[];
} | {
  type: 'compressProgress';
  /** 压缩进度: 'start' | 'complete' | 'error' */
  status: 'start' | 'complete' | 'error';
  /** 压缩后的 token 使用量（complete 时提供） */
  postCompactTokenCount?: number;
} | {
  type: 'clearConversation';
  sessionId: string;
} | {
  type: 'spinCommand';
  sessionId: string;
  cmd: 'init' | 'status' | 'auto';
  args?: string;
} | {
  type: 'clearMessages';
  sessionId: string;
} | {
  type: 'queuedMessage';
  sessionId: string;
  /** 排队的消息内容 */
  content: string;
  /** 排队的消息携带的图片 */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
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
  type: 'getTokenRankings';
  period: 'daily' | 'monthly' | 'total';
} | {
  type: 'tokenRankingsData';
  rankings: Array<{
    username: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    totalCalls: number;
  }>;
  period: 'daily' | 'monthly' | 'total';
} | {
  type: 'requestSkills';
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
  };
  /** LLM 消息 ID */
  streamId?: string;
} | {
  type: 'switchToSession';
  sessionId: string;
} | {
  type: 'switchToNewSession';
  sessionId: string;
} | {
  type: 'fetchEmployeeName';
  username: string;
} | {
  type: 'employeeNameResult';
  username: string;
  employeeName: string | null;
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
  type: 'rollbackEditResult';
  success: boolean;
  message: string;
  /** 回滚的文件数量 */
  restoredFiles?: number;
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
  /** 账户总余额 */
  totalBalance: number;
  /** 货币类型 */
  currency: string;
  /** 是否无限额度 */
  isUnlimited: boolean;
  /** 查询时间戳 */
  fetchedAt: number;
} | {
  type: 'initSessionState';
  sessionId: string;
  /** 会话默认模型（可选） */
  model?: string;
} | {
  type: 'timeStatsResult';
  stats: {
    toolExecution: number;
    aiThinking: number;
    humanFeedback: number;
    totalTime: number;
    toolPct: number;
    thinkingPct: number;
    humanPct: number;
    toolCount: number;
    thinkingCount: number;
    humanCount: number;
  } | null;
} | {
  type: 'llmConfigSaved';
  defaultModel?: string;
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
  baseURL?: string;
  apiType?: string;
  webSearch?: boolean;
  thinkingEffort?: string;
  defaultModel?: string;
  defaultAgentMode?: string;
  defaultPromptMode?: 'normal' | 'minimal' | 'mixed';
  apiKey?: string;
  language?: 'auto' | 'zh' | 'en';
  /** 新结构：settings.json 的 llm.providers 列表 */
  providers?: Array<{ key: string; baseURL: string; apiKey: string; apiType: string; models?: string[]; defaultModel?: string }>;
  /** settings.json 的 llm.activeProvider */
  activeProvider?: string;
} | {
  type: 'providerModelsResult';
  /** 自动获取到的模型列表；为空表示获取失败 */
  models?: string[];
  /** 错误信息（可选） */
  error?: string;
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
};

// 不包含 sessionId 的消息类型（调用方传入，postToWebview 会添加）
export type WebviewMessageWithoutSessionId = Omit<WebviewMessage, 'sessionId'>;

/** 密码输入校验规则 */
export interface ValidationRule {
  /** 正则表达式，输入值必须匹配此规则 */
  pattern: RegExp;
  /** 不匹配时显示的错误提示 */
  message: string;
}

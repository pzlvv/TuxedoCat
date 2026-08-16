/**
 * Webview 内共享的类型定义
 * Message, Colors 等类型在多个组件间重复定义，统一抽离到这里
 */

export type Theme = 'dark' | 'light';
export type AgentMode = 'manual' | 'risk' | 'auto';
export type PromptMode = 'normal' | 'minimal' | 'mixed';
export type ThinkingMode = 'off' | 'low' | 'high' | 'max';
export type ModelType = 'deepseek-v4-flash' | 'deepseek-v4-pro';
export type RankingPeriod = 'daily' | 'monthly' | 'total';

/** settings.json 中的默认值（新对话一次性使用，避免创建后跳变） */
export interface SettingsDefaults {
  model: string;
  thinkingMode: ThinkingMode;
  agentMode: AgentMode;
  promptMode: PromptMode;
  webSearch: boolean;
}

/** settings.json 中的 provider 配置项 */
export interface ProviderConfig {
  key: string;
  baseURL: string;
  apiKey: string;
  apiType: 'Responses' | 'Anthropic';
  /** 该服务商可用的模型列表（可选，由自动获取或手动维护） */
  models?: string[];
  /** 该服务商的默认模型 */
  defaultModel?: string;
}

export interface Message {
  role: 'user' | 'thinking' | 'toolcall' | 'system' | 'assistant';
  content: string;
  param?: string;
  filePath?: string;
  fileSelectedLines?: { start: number; end: number };
  status?: 'normal' | 'success' | 'running' | 'fail';
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolCallId?: string;
  isCompactSummary?: boolean;
  isCompactCollapsed?: boolean;
  hasBorder?: boolean;
  isFromAgent?: boolean;
  /** 消息是否正在流式输出中（用于 ThinkingMessage 默认展开） */
  isStreaming?: boolean;
  /** 消息到达时间戳（ms），用于统计耗时分布 */
  timestamp?: number;
  /** 工具结果返回时间戳（ms），用于精确统计工具执行耗时 */
  toolResultTimestamp?: number;
  /** 工具开始执行时间戳（ms），即用户确认后、工具实际开始运行的时间，用于区分等待用户确认和工具执行时间 */
  toolStartTimestamp?: number;
  /** 消息元信息，如文件引用、agent来源等 */
  meta?: Record<string, unknown>;
  /** 缓存读取 token 数 */
  cacheReadInputTokens?: number;
  /** 缓存创建 token 数 */
  cacheCreationInputTokens?: number;
}

export interface UserChoiceRequest {
  choiceId: string;
  toolName: string;
  message: string;
  choices?: Array<{ label: string; description?: string }>;
}

export interface SessionState {
  input: string;
  inputCursorPosition: number;
  choiceCursorPosition: number;
  userChoiceRequest: UserChoiceRequest | null;
  userChoiceInput: string;
  showThinkingAnimation: boolean;
  hasActiveQuery: boolean;
  agentMode: AgentMode;
  /** 会话关联的提示词模式（普通/极简/混合），持久化到 meta.json */
  promptMode?: PromptMode;
  thinkingMode: ThinkingMode;
  /** 会话关联的 Web Search 开关（未设置时使用 settings.json 默认值） */
  webSearch?: boolean;
  contextLength: number;
  queuedMessage: string | null;
  model?: string;
  /** 累计缓存读取 token 数 */
  totalCacheReadInputTokens?: number;
  /** 累计缓存创建 token 数 */
  totalCacheCreationInputTokens?: number;
  /** 累计原始 input_tokens（不含缓存部分，用于计算命中率） */
  totalInputTokens?: number;
}

/** 排名条目接口 */
export interface TokenRankingItem {
  username: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCalls: number;
}

export interface Colors {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  primaryFrame: string;
  textPrimary: string;
  textSystem: string;
  textSecondary: string;
  toolName: string;
  harness: string;
  border: string;
  borderFocus: string;
  placeholder: string;
  timelineLine: string;
  timelineStatusNormal: string;
  timelineStatusSuccess: string;
  timelineStatusRunning: string;
  timelineStatusFail: string;
  success: string;
  error: string;
}


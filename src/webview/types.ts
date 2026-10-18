/**
 * Webview 内共享的类型定义
 * Message, Colors 等类型在多个组件间重复定义，统一抽离到这里
 */

import type { ModelRef } from '../shared/llm/modelRef';
import type { MessageOrigin } from '../shared/types';
import type { McpServerInfo } from '../shared/webviewTypes';
import type { WebviewToHostMessage } from '../host/webviewMessages';
import type { UiLanguage } from './i18n';
import type { UiFontSize } from './fontSize';

/** `sendMessage` 的 wire 载荷形态（宿主契约 `src/host/webviewMessages.ts`，webview 只消费不另定义） */
export type SendMessageWire = Extract<WebviewToHostMessage, { type: 'sendMessage' }>;

export type Theme = 'dark' | 'light';
export type AgentMode = 'manual' | 'risk' | 'auto';
export type PromptMode = 'normal' | 'minimal' | 'mixed';
export type ThinkingMode = 'off' | 'low' | 'high' | 'max';
export type RankingPeriod = 'daily' | 'monthly' | 'total';

/**
 * settings.json 中的默认值（新对话一次性使用，避免创建后跳变）。
 * 全部可选：webview 启动时不再内置任何默认值/兜底，未收到宿主回传前保持
 * undefined（此时发送按钮禁用，避免用错误默认值发起请求）。
 */
export interface SettingsDefaults {
  /** 默认模型身份（provider + model）；未从宿主获取到之前为 undefined */
  modelRef?: ModelRef;
  thinkingMode?: ThinkingMode;
  agentMode?: AgentMode;
  promptMode?: PromptMode;
  webSearch?: boolean;
}

/**
 * 「默认配置已修改」对话框里逐条展示的一项变更。
 *
 * label / from / to 都在产出处本地化（config handler 用 `t()` 组装），
 * 对话框只负责渲染，不再判断字段语义。
 */
export interface DefaultsChangeItem {
  /** 变更项名称（默认服务商 / 默认模型 / 提示词模式 / ...） */
  label: string;
  /** 变更前显示值（当前对话的值） */
  from: string;
  /** 变更后显示值（新的默认值） */
  to: string;
}

/**
 * 「默认配置已修改，是否应用到当前对话」的待确认请求。
 *
 * 由 config handler 在收到 `llmConfigSaved`、且某默认值相对保存前有变化、
 * 又与当前对话的值不一致时产出（见 `handleConfigLlmConfigSaved`）。
 * App 渲染确认对话框；用户确认后把这里的字段应用到当前对话，取消则丢弃。
 * 字段为 undefined 表示该项无需应用（未变化 / 已与当前对话一致）。
 */
export interface ApplyDefaultsPrompt {
  /** 需要切换到的模型身份（provider + model）；undefined = 模型无需切换 */
  modelRef?: ModelRef;
  promptMode?: PromptMode;
  thinkingMode?: ThinkingMode;
  agentMode?: AgentMode;
  webSearch?: boolean;
  /** 需要切换到的 MCP 启用列表（整体覆盖当前会话）；undefined = MCP 无需切换 */
  mcpEnabled?: string[];
  /** 对话框里逐条展示的变更 */
  changes: DefaultsChangeItem[];
}

/** LLM API 协议类型（模型级配置） */
export type ApiType = 'Responses' | 'OpenAI' | 'Anthropic';

/** 单个模型的配置项 */
export interface ModelConfigEntry {
  context?: number;
  output?: number;
  /** 该模型使用的 API 协议（已下放到模型级） */
  apiType?: ApiType;
}

/**
 * 设置面板载荷：宿主随 `showLLMConfig` 一次给齐的面板配置事实
 * （`docs/hosts/webview-facts.md` 第 6 节）。
 *
 * 字段全部必选：webview 不补默认值，宿主未给齐即协议错误。面板只在载荷到达后打开，
 * 因此不存在「部分字段缺失」的中间态。
 */
export interface LlmConfigPanelPayload {
  /** 当前生效的服务地址（未配置服务商时由宿主给预置地址） */
  baseURL: string;
  webSearch: boolean;
  thinkingEffort: ThinkingMode;
  defaultAgentMode: AgentMode;
  defaultPromptMode: PromptMode;
  /** 当前生效服务商的 API Key；未配置时为空串 */
  apiKey: string;
  language: UiLanguage;
  /** 界面字号档位（顶层 `uiFontSize`） */
  fontSize: UiFontSize;
  providers: ProviderConfig[];
  /** 当前生效的服务商 key；未配置时为空串 */
  activeProvider: string;
  mcpServers: McpServerInfo[];
}

/** settings.json 中的 provider 配置项 */
export interface ProviderConfig {
  key: string;
  baseURL: string;
  apiKey: string;
  /** 该服务商可用的模型列表（可选，由自动获取或手动维护） */
  models?: string[];
  /** 该服务商的默认模型 */
  defaultModel?: string;
  /** 该服务商各模型的配置（context/output/apiType） */
  modelConfigs?: Record<string, ModelConfigEntry>;
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
  /**
   * 消息来源：`agent`（子代理 Reply）或 `bash`（后台任务通知）；
   * 用户消息留空即视为 `user`。
   *
   * - `agent`：按 markdown + From 头渲染，不参与滚动置顶；
   * - `bash`：按普通纯文本（含 ANSI 颜色）渲染，同样不参与滚动置顶。
   */
  origin?: MessageOrigin;
  /** 消息是否正在流式输出中（用于 ThinkingMessage 默认展开） */
  isStreaming?: boolean;
  /** 消息到达时间戳（ms），用于统计耗时分布 */
  timestamp?: number;
  /** API 返回的本次输出 token 数（流式结束后才有，用于 thinking 完成后的统计） */
  outputTokens?: number;
  /** API 返回的思考（reasoning）token 数（Responses API 才有，用于 thinking 完成后的统计） */
  reasoningTokens?: number;
  /** 流式消息 ID（仅实时流式消息有；历史恢复的消息没有，用于关联全局流式统计） */
  streamId?: string;
  /** 工具结果返回时间戳（ms），用于精确统计工具执行耗时 */
  toolResultTimestamp?: number;
  /** 工具开始执行时间戳（ms），即用户确认后、工具实际开始运行的时间，用于区分等待用户确认和工具执行时间 */
  toolStartTimestamp?: number;
  /** 消息元信息，如文件引用、agent来源等 */
  meta?: Record<string, unknown>;
  /** 用户消息携带的图片（dataUrl，用于渲染缩略图） */
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  /** 缓存读取 token 数 */
  cacheReadInputTokens?: number;
  /** 缓存创建 token 数 */
  cacheCreationInputTokens?: number;
}

/** 排队消息完整载荷（文本 + 图片 + 文件上下文），保证图片/文件信息在排队/重发时不丢失 */
export interface QueuedMessagePayload {
  /** 该排队消息归属的会话 ID，防止切换对话后串会 */
  sessionId: string;
  /** 该排队消息的 uuid；与补发的用户气泡配对，用于按消息精确清除（编辑 / 删除撤回也按它配对） */
  uuid: string;
  content: string;
  images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  /** 排队时选中的文件路径 */
  filePath?: string;
  /** 排队时选中的文件行号 */
  selectedLines?: { start: number; end: number };
  /** 排队时文件信息是否被用户隐藏 */
  fileHidden?: boolean;
}

/**
 * 空闲发送的本地挂起项（规格 docs/features/user-message-pipeline.md FR-003）：完整保留
 * 构造好的 `sendMessage` wire 载荷，该会话快照 `idle === true` 时按立即发送语义原样提交。
 * 挂起是 webview 本地状态：不上送宿主（`sendMessage` / `onQueuedMessage` 契约不变），
 * webview 重载即丢失（无持久化）。
 */
export interface IdleSuspendedMessage {
  /** 挂起项归属的会话（提交时正编辑的会话），跨会话不串 */
  sessionId: string;
  /** 本地 uuid：仅为复用排队横幅的编辑 / 删除与回填实现，不上送宿主 */
  uuid: string;
  /** 构造完成的原样 wire 载荷（含提交时刻的会话配置与文件上下文） */
  wire: SendMessageWire;
}

export interface UserChoiceRequest {
  choiceId: string;
  toolName: string;
  message: string;
  choices?: Array<{ label: string; description?: string }>;
}

export interface SessionState {
  input: string;
  /** 输入框中尚未发送的图片（草稿） */
  pastedImages?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
  inputCursorPosition: number;
  choiceCursorPosition: number;
  userChoiceRequest: UserChoiceRequest | null;
  userChoiceInput: string;
  showThinkingAnimation: boolean;
  /** 当前动画类型：thinking 或 compacting */
  animationMode?: 'thinking' | 'compacting';
  hasActiveQuery: boolean;
  /** 压缩开始前是否已有活跃查询，用于压缩结束后恢复运行状态 */
  preCompressHasActiveQuery?: boolean;
  /** 会话关联的询问模式（未从宿主获取到前为 undefined） */
  agentMode?: AgentMode;
  /** 会话关联的提示词模式（普通/极简/混合），持久化到 meta.json */
  promptMode?: PromptMode;
  /** 会话关联的思考强度（未从宿主获取到前为 undefined） */
  thinkingMode?: ThinkingMode;
  /** 会话关联的 Web Search 开关（未从宿主获取到前为 undefined） */
  webSearch?: boolean;
  contextLength: number;
  queuedMessage: QueuedMessagePayload | null;
  /** 会话当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  modelRef?: ModelRef;
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

/**
 * core 推送的会话运行时状态（`sessionRuntimeStates` 的 webview 侧投影）。
 *
 * 与 core `SessionRuntimeState` 字段一致：根事实 + 派生 `idle`（``docs/core/session-runtime.md`）。
 * 流水灯读 `idle` / `waiting`；abort 按钮经 `resolveAbortButtonState` 读根事实
 * （`docs/features/abort-button.md`）。
 */
export interface SessionRuntimeState {
  idle: boolean;
  waiting: boolean;
  queryRunning: boolean;
  compacting: boolean;
  backgroundRunning: boolean;
  subAgentRunning: boolean;
  /** 父会话 id（子代理会话才有；普通会话为 null） */
  parentSessionId: string | null;
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

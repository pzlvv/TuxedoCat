/**
 * webview ↔ host 消息协议（wire 联合类型，按方向拆分）。
 *
 * - `HostToWebviewMessage`：宿主 → webview（core 事实推送 + 宿主操作通知）
 * - `BidirectionalWebviewMessage`：同一 `type` 双向共用的成员（webview 发出会话配置
 *   请求，宿主在 `sessionConfigChanged` 时把收敛结果以同形状广播给各视图）
 * - `WebviewToHostMessage`：webview → 宿主（用户操作 / 查询请求，宿主翻译成
 *   UiEvent 或直接调 UIHost）
 * - `WebviewMessage`：双向并集（兼容别名；宿主实现层的旧引用逐步迁移）
 *
 * 本文件是两端唯一的协议类型来源：webview 的 `postMessage`（`src/webview/webviewEnv.ts`）
 * 与宿主的 `sendToWebview`（`UIHost` 契约）都以这里为准，不允许 `as any` 绕过。
 * 载荷字段与宿主 / webview 两侧的实际读写一一对应；新增消息先在这里定形状，
 * 再在 `WebviewMessageHandler` 的分发表与 webview 的 switch 各补一个分支。
 */

import type { MessageData, MessageOrigin, TodoEntry } from '../shared/types.js';
import type { McpServerInfo, ProviderModels } from '../shared/webviewTypes.js';

/** 用户消息携带的图片（仅用于 UI 展示，LLM 请求使用 content blocks） */
export interface WebviewImagePayload {
  dataUrl: string;
  mediaType?: string;
  width?: number;
  height?: number;
}

/** 文件选中行号（1-indexed；start === end 表示单行） */
export interface WebviewSelectedLines {
  start: number;
  end: number;
}

/** LLM 流式用量的 wire 形状（core `streamEnd` 事件透传） */
export interface WebviewStreamUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** 思考（reasoning）部分的 token 数（Responses API: output_tokens_details.reasoning_tokens） */
  reasoning_tokens?: number;
}

// ==================== 双向消息（同形状，两方向共用） ====================

/**
 * 会话配置：webview 发出（用户改动，宿主翻译成 UiEvent 落盘），
 * 宿主广播（core `sessionConfigChanged` 收敛后的确认，多视图下同步其它视图）。
 */
export type BidirectionalWebviewMessage = {
  type: 'setModel';
  sessionId: string;
  model: string;
  /** 模型所属 provider；model + provider 一起表征一个模型 */
  provider?: string;
} | {
  type: 'setThinkingMode';
  sessionId: string;
  mode: 'off' | 'low' | 'high' | 'max';
} | {
  type: 'setPromptMode';
  sessionId: string;
  mode: 'normal' | 'minimal' | 'mixed';
} | {
  type: 'setAgentMode';
  sessionId: string;
  mode: 'manual' | 'risk' | 'auto';
} | {
  type: 'setWebSearch';
  sessionId: string;
  webSearch: boolean;
};

// ==================== 宿主 → webview ====================

export type HostToWebviewMessage = {
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
  fileSelectedLines?: WebviewSelectedLines;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status?: 'normal' | 'success' | 'running' | 'fail';
  toolCallId?: string;
  /** API 返回的 input_tokens（当前上下文总 token 数，不含本次 output） */
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
  /**
   * 一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：不进 jsonl / LLM 上下文，
   * core 只把它记进 meta.json 的 `onceMessage`（一个对话至多一条）；时间线末位显示、
   * 任何新节点追加前先移除。缺省即常规消息。随 `CoreEvent.message` 的载荷透传。
   */
  once?: boolean;
  /**
   * 一次性通知的类别（specs/036 FR-001）：`'llmError'` = LLM 失败通知，webview
   * 据此在通知末尾渲染重试按钮；其余 once 通知与常规消息不带。
   */
  noticeKind?: 'llmError';
  /** 标记为压缩折叠区域的消息（加载时从 boundary 开始） */
  isCompactCollapsed?: boolean;
  /** 用户消息携带的图片（仅用于 UI 展示，LLM 请求使用 content blocks） */
  images?: WebviewImagePayload[];
} | {
  type: 'showThinkingAnimation';
  sessionId: string;
  show?: boolean;
} | {
  type: 'setTheme';
  theme: 'dark' | 'light';
} | {
  /**
   * 运行期切换对话列表渲染方（宿主 → webview）。
   * Electron 悬浮窗隐藏原生侧栏后，对话列表改由 webview 顶栏渲染（owner = webview），
   * 「新建对话」入口随之移到顶栏；视图模式不变（仍是多视图，切换会话复用 / 另开视图）。
   */
  type: 'setConversationListOwner';
  owner: 'host' | 'webview';
} | {
  type: 'setCurrentFile';
  filePath?: string;
  selectedLines?: WebviewSelectedLines;
} | {
  type: 'setTitle';
  sessionId: string;
  title: string;
} | {
  /**
   * 会话工作模式变化（core `workModeChanged` 的 webview 投影，specs/016 FR-004）。
   * spin = 主输入框禁用（placeholder 提示）；单向，不会变回 normal。会话切换的初始态
   * 由 `conversationLoaded` 载荷的 `workMode` 携带，本消息只管运行期变化。
   */
  type: 'setWorkMode';
  sessionId: string;
  workMode: 'normal' | 'spin';
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
  /**
   * AskUserQuestion 的问题清单（specs/026）。
   * 权限确认场景没有该字段，webview 按旧形状渲染。
   */
  questions?: Array<{
    id: string;
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multi_select?: boolean;
  }>;
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
  /**
   * `placeholder` 非空表示这是跨工作区子代理的占位父对话（specs/023 FR-004）：
   * 不加载消息、不建立运行时，点击后由宿主显示跳转页。
   */
  conversations: Array<{
    sessionId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    parentSessionId?: string;
  }>;
} | {
  /**
   * 会话运行时状态全量推送（core `sessionRuntimeChanged` → 宿主 → webview）。
   * 对话树的流水灯（idle / waiting）与 abort 按钮只读这份数据，不再从 `queryBegin` / `queryEnd` 推导。
   */
  type: 'sessionRuntimeStates';
  /**
   * 全量快照；宿主不持有其所有权，调用方只读。
   * 字段与 core `SessionRuntimeState` 一致（根事实 + 派生 `idle`，``docs/core/session-runtime.md`）。
   */
  states: ReadonlyArray<{
    sessionId: string;
    idle: boolean;
    waiting: boolean;
    queryRunning: boolean;
    compacting: boolean;
    /** 已登记手动压缩、等待下一轮开始；不参与 `idle` */
    pendingCompact: boolean;
    backgroundRunning: boolean;
    /** 运行中后台 Bash 任务清单（specs/019 FR-001），注册序；空集为 `[]` */
    backgroundTasks: ReadonlyArray<{ taskId: string; description: string; command: string }>;
    subAgentRunning: boolean;
    /**
     * 子代理会话为创建时 Agent 工具调用的 description；普通会话与恢复路径
     * 取不到时为 `null`
     */
    subAgentDescription: string | null;
    /** 父会话 id（本地子代理会话才有；普通会话与跨工作区对话为 null，specs/025 FR-002） */
    parentSessionId: string | null;
    /** 会话创建者（specs/025 FR-002），镜像 shared `sessionCreator.ts` 判别联合 */
    creator: {
      kind: 'user';
    } | {
      kind: 'agent';
      workspaceId: string | null;
      sessionId: string;
    };
  }>;
} | {
  /**
   * 未读完成的会话集合（「任务完成」绿色呼吸，Electron 宿主专用——其它宿主不发）。
   * 主进程对相邻两次会话运行时快照差分出 running → idle，且完成时刻窗口失焦 /
   * 标签页未激活 / 会话非当前时记为未读；窗口聚焦后推送。列表项绿色呼吸一次后
   * 保持常亮，直到该对话成为当前对话（主进程清除并重推，条目随之熄灭）。
   * 全量集合快照（幂等）：webview 按自己的列表匹配 sessionId，列表里没有的忽略。
   */
  type: 'sessionCompletionAttention';
  sessionIds: string[];
} | {
  /**
   * 某会话的 Todo 清单（`docs/features/todo-list.md` FR-002）。
   *
   * 两条来源合流：webview 的 `requestSessionTodos` 应答，以及 core 的
   * `CoreEvent.todosChanged` 推送。空数组即「该会话没有 Todo」（按钮不渲染）。
   */
  type: 'sessionTodos';
  sessionId: string;
  todos: TodoEntry[];
} | {
  type: 'conversationLoaded';
  sessionId: string;
  conversation: {
    metadata?: {
      sessionId?: string;
      title?: string;
      context?: { currentFile?: string; selectedLines?: WebviewSelectedLines; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; model?: string; provider?: string };
      parentSessionId?: string;
      model?: string;
      provider?: string;
      role?: string;
      /** 会话创建者（specs/025 FR-002）：镜像 shared `sessionCreator.ts` 判别联合 */
      creator?: { kind: 'user' } | { kind: 'agent'; workspaceId: string | null; sessionId: string };
      /**
       * 最后一条一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：core 记在 meta.json，
       * 一个对话至多一条；webview 加载时追加到时间线末位。`noticeKind` 随通知
       * JSON 整份落盘（specs/036 FR-001），恢复后仍能识别 LLM 失败通知。
       */
      onceMessage?: { role: 'system'; content: string; noticeKind?: 'llmError' };
    };
    messages?: unknown[];
  };
  pendingToolUseIds?: string[];
  /** 从 meta.json 恢复的上下文，webview 加载后直接应用 */
  savedContext?: { currentFile?: string; selectedLines?: WebviewSelectedLines; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; promptMode?: 'normal' | 'minimal' | 'mixed'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; provider?: string };
  parentSessionId?: string;
  /** 会话创建者（specs/025 FR-002）：返回按钮按它跨工作区跳发起方或跳本地父会话 */
  creator?: { kind: 'user' } | { kind: 'agent'; workspaceId: string | null; sessionId: string };
  /** 当前会话模型所属 provider（已按 provider 模型列表校验/回退） */
  provider?: string;
  /** 当前会话模型（已按 provider 模型列表校验/回退） */
  model?: string;
  /** 当前会话的 agent mode（运行时内存值，不持久化到文件） */
  agentMode?: 'manual' | 'risk' | 'auto';
  /**
   * 会话工作模式（meta.json `workMode` 恢复，缺省 normal；specs/016 FR-005）：
   * spin 会话加载后主输入框保持禁用（单向，不再退出），运行期变化走 `setWorkMode`。
   */
  workMode: 'normal' | 'spin';
  /** 引擎是否正在消费消息（查询进行中） */
  hasActiveQuery?: boolean;
  /** 当前会话活动阶段：thinking / text / tool / idle，用于恢复 thinking 动画 */
  activityPhase?: 'idle' | 'thinking' | 'text' | 'tool';
  /** 是否存在压缩归档（用于 webview 显示展开按钮） */
  hasCompactArchive?: boolean;
  /** 裁剪掉的 _meta 大字段索引：toolUseId -> 紧凑 diff 或 before/after 内容 */
  toolMetaMap?: Record<string, unknown>;
} | {
  /**
   * 瞬时状态提示（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
   *
   * core 只给「键 + 参数」，webview 用 `t(key, params)` 翻译后以瞬时提示呈现；
   * 不进消息流、不落盘。键缺失时显示键本身并记日志。
   */
  type: 'notice';
  key: string;
  params: Record<string, string | number>;
  level: 'info' | 'warn' | 'error';
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
  /** 界面字号档位（顶层 `uiFontSize`）；只有 UI 消费 */
  fontSize?: 'medium' | 'large' | 'xlarge';
  /** 是否已完成服务商配置（activeProvider 存在且 apiKey 非空） */
  providerConfigured?: boolean;
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
  /** 压缩后上下文占用的重算值（complete 时提供；core 按压缩产物以运行时同款口径重算） */
  postCompactTokenCount?: number;
} | {
  type: 'messagesReplaced';
  sessionId: string;
  /** 整批替换后的消息（压缩后重建 / 展开归档共用；顺序即显示顺序） */
  messages: MessageData[];
} | {
  type: 'queuedMessage';
  sessionId: string;
  /** 该排队消息的 uuid；与补发的用户气泡 `messageUuid` 配对，用于按消息精确清除（宿主登记时恒生成） */
  uuid: string;
  /** 排队的消息内容 */
  content: string;
  /** 排队的消息携带的图片 */
  images?: WebviewImagePayload[];
  /** 排队时选中的文件路径 */
  filePath?: string;
  /** 排队时选中的文件行号 */
  selectedLines?: WebviewSelectedLines;
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
  /**
   * `@` 工作区补全的候选（specs/023 FR-007）：宿主按发起视图所属工作区过滤掉本工作区后下发。
   */
  type: 'setWorkspaces';
  workspaces: Array<{ id: string; path: string; displayName: string }>;
} | {
  type: 'contextLimitUpdated';
  /** 系统当前的最大 context window */
  maxContextTokens: number;
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
  usage?: WebviewStreamUsage;
  /** LLM 消息 ID */
  streamId?: string;
} | {
  type: 'smartNamingResult';
  sessionId: string;
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
  /**
   * 本次保存真正改动的默认项（宿主对比保存前后快照得出）。「是否询问应用到当前
   * 对话」只看这些标志 + 与当前对话值的比较，不再与 webview 本地缓存的默认值比较
   * （缓存未到达时是 undefined，比较会把「没改」误判成「改了」）。只改语言 / 字号
   * 等 UI 项时全为 false，即使默认值与当前对话不一致也不弹确认框。
   */
  defaultsChanged: {
    /** 默认服务商（activeProvider）变化 */
    activeProvider: boolean;
    thinkingEffort: boolean;
    promptMode: boolean;
    agentMode: boolean;
    webSearch: boolean;
  };
  /**
   * 当前对话所用服务商在保存后的默认模型。webview 只有默认服务商的默认模型，
   * 判断不了当前对话所用服务商（可能是另一个 provider）的默认模型变化。
   */
  currentProviderDefaultModel?: string;
  /** 当前对话所用服务商的默认模型相对保存前是否变化（宿主对比前后快照得出） */
  currentProviderDefaultModelChanged?: boolean;
  /**
   * 保存后的全局默认 MCP 启用列表（`settings.json` 的 `mcp.enabled`，新对话默认值）。
   * 只有面板提交了 MCP 默认列表（`saveLLMConfig.mcpServers`）时才带。
   */
  mcpDefaultEnabled?: string[];
  /** 全局默认 MCP 启用列表相对保存前是否变化（宿主对比前后快照得出） */
  mcpDefaultEnabledChanged?: boolean;
  /**
   * 保存前当前对话**生效**的 MCP 启用列表（宿主读 core 事实得出）。
   *
   * 宿主在写盘前已把当前对话钉在这个列表上，因此它同时是「当前对话的值」。
   * webview 的会话状态可能已被写盘后的回推覆盖，判断不了保存前的值。
   */
  currentSessionMcpEnabled?: string[];
  /**
   * 当前对话的 MCP 启用列表**未能钉住**（读 core 事实 / 下发事件失败）。
   *
   * 钉住与保存全局默认值是两件事：宿主已继续保存，只把失败报给 UI。
   * 此时不回传上面三项事实（拿不到可靠的「当前对话的值」），webview 不弹确认框，
   * 改为给出一次提示——该对话可能已跟随新的默认值。
   */
  mcpPinFailed?: boolean;
  language?: 'auto' | 'zh' | 'en';
  /** 界面字号（顶层 `uiFontSize`）；只有 UI 消费 */
  fontSize?: 'medium' | 'large' | 'xlarge';
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
  /** 界面字号（顶层 `uiFontSize`）；只有 UI 消费 */
  fontSize?: 'medium' | 'large' | 'xlarge';
  /** 新结构：settings.json 的 llm.providers 列表（apiType 已下放到 modelConfigs[model].apiType） */
  providers?: Array<{
    key: string;
    baseURL: string;
    apiKey: string;
    models?: string[];
    defaultModel?: string;
    modelConfigs?: Record<string, { context?: number; output?: number; apiType?: string; multimodal?: boolean }>;
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
  type: 'conversationSpacesData';
  spaces: import('../shared/webviewTypes.js').ConversationSpaceInfo[];
} | {
  type: 'conversationSpacesError';
  error: string;
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
} | BidirectionalWebviewMessage;

// ==================== webview → 宿主 ====================

/** saveLLMConfig 的 provider 条目（宿主侧 `llmConfigSave.ts` 会逐字段校验） */
export interface SaveLlmConfigProvider {
  key: string;
  baseURL: string;
  apiKey: string;
  models?: string[];
  /** 模型名 -> apiType（Responses | OpenAI | Anthropic） */
  modelApiTypes?: Record<string, string>;
  /** 模型名 -> 是否多模态（设置面板「多模态」checkbox 的勾选态） */
  modelMultimodal?: Record<string, boolean>;
  /**
   * 模型名 -> 弹层碰过的限值（specs/013-model-settings-popup）：正数 = 显式值，
   * `null` = 清空（回落注册表）；字段缺失 = 未碰过。
   */
  modelLimits?: Record<string, { context?: number | null; output?: number | null }>;
  defaultModel?: string;
}

export type WebviewToHostMessage = {
  /** 用户发出消息：宿主翻译成 `UiEvent.userMessageSubmitted`（排队 / 回显策略在宿主） */
  type: 'sendMessage';
  sessionId: string;
  content: string;
  images?: WebviewImagePayload[];
  /** 发送时选中的文件路径 */
  filePath?: string;
  /** 发送时文件引用是否被用户隐藏 */
  fileHidden?: boolean;
  selectedLines?: WebviewSelectedLines;
  agentMode?: 'manual' | 'risk' | 'auto';
  thinkingMode?: 'off' | 'low' | 'high' | 'max';
  webSearch?: boolean;
  /** 本次发送携带的模型身份（model + provider 一起表征；缺省沿用会话已选模型） */
  model?: string;
  provider?: string;
} | {
  /**
   * 失败 once 通知上的「重试」（specs/036 FR-003）：宿主翻译成
   * `UiEvent.queryRetryRequested`，core 以既有上下文重跑一轮（不追加用户消息）。
   */
  type: 'retryQuery';
  sessionId: string;
} | {
  /** 索取某会话当前的 Todo 清单（应答是下行 `sessionTodos`） */
  type: 'requestSessionTodos';
  sessionId: string;
} | {
  type: 'loadConversation';
  sessionId: string;
} | {
  /** 多视图宿主：新开一个 webview 加载指定会话（webview 按能力声明选择本消息或 loadConversation） */
  type: 'openConversation';
  sessionId: string;
  /**
   * 目标会话所属工作区的**代理身份**（`<机器名>:<路径>`）；`null` = 当前视图自己的工作区。
   * 跨工作区跳转（specs/023 FR-005）由宿主按身份解析打开集合、先切标签页再开视图。
   */
  targetWorkspaceId: string | null;
} | {
  /** 多视图宿主：顶栏「+」新开一个「新建对话」视图 */
  type: 'openNewConversation';
} | {
  type: 'startNewConversation';
  sessionId: string;
} | {
  type: 'deleteConversation';
  sessionId: string;
} | {
  /** 多视图宿主：关闭当前会话视图（视图生命周期归宿主） */
  type: 'closeWebview';
} | {
  /** 未设置工作区时 webview 引导按钮：请求宿主打开工作区选择对话框 */
  type: 'openWorkspace';
} | {
  type: 'openFile';
  filePath: string;
  selectedLines?: WebviewSelectedLines;
} | {
  type: 'showVirtualDocument';
  content: string;
  title: string;
  /** 语言标识（webview 侧提示意图；宿主目前按内容自判定，可缺省） */
  language?: string;
} | {
  type: 'openMermaidPreview';
  code: string;
} | {
  type: 'openSpinDesign';
} | {
  /** 用系统默认浏览器打开外部链接（webview 内不直接导航） */
  type: 'openUrl';
  url: string;
} | {
  /** webview 侧诊断日志（宿主落日志，便于排查渲染端问题） */
  type: 'debugLog';
  message: string;
} | {
  type: 'requestTheme';
} | {
  /** 请求上下文上限（按给定模型身份计算；缺省按 active provider 默认模型） */
  type: 'requestContextLimit';
  model?: string;
  provider?: string;
} | {
  type: 'requestCompress';
  sessionId: string;
} | {
  /** 拉取指定会话被裁剪的 _meta 大字段（diff / before-after） */
  type: 'requestToolMeta';
  sessionId: string;
  toolUseIds: string[];
} | {
  /** 请求弹出 LLM 配置面板；多视图宿主可定向到指定会话的视图 */
  type: 'requestLLMConfig';
  sessionId?: string;
} | {
  type: 'requestSettingsDefaults';
} | {
  type: 'requestMcpServers';
  sessionId?: string;
} | {
  /** 勾选 / 取消某个 MCP 服务器（会话级启用状态，core 落盘后广播 setMcpServers） */
  type: 'setMcpEnabled';
  sessionId?: string;
  name: string;
  enabled: boolean;
} | {
  /**
   * 整表覆盖当前会话的 MCP 启用列表（设置面板「应用到当前对话」用）：
   * 把该会话的启用状态整体写成给定列表，不做增量。
   */
  type: 'setMcpEnabledList';
  sessionId?: string;
  names: string[];
} | {
  type: 'getConversations';
} | {
  type: 'requestModels';
} | {
  type: 'requestSkills';
} | {
  /** `@` 工作区补全：请求宿主下发「除本工作区之外的已打开工作区」 */
  type: 'requestWorkspaces';
} | {
  type: 'requestSessionRuntimeStates';
} | {
  /** 阶段一：只拉取模型列表；协议探测需用户确认后另发 detectProviderModelApiTypes */
  type: 'fetchProviderModels';
  baseURL: string;
  apiKey: string;
  /** 面板已知的模型协议：已有值的不需要再探测 */
  knownApiTypes?: Record<string, string>;
} | {
  /** 阶段二：对未设置协议的模型执行探测（可能消耗少量 token，用户已确认） */
  type: 'detectProviderModelApiTypes';
  baseURL: string;
  apiKey: string;
  models: string[];
  knownApiTypes?: Record<string, string>;
} | {
  /** 保存 LLM 配置：宿主整段并入 settings.json（`applyLlmConfigSave` 逐字段校验） */
  type: 'saveLLMConfig';
  /** 是否写入 provider 表（编辑模型列表 / API 配置 / 显式选择 provider 时为 true） */
  saveProviders?: boolean;
  providers?: SaveLlmConfigProvider[];
  activeProvider?: string;
  webSearch?: boolean;
  thinkingEffort?: 'off' | 'low' | 'high' | 'max';
  defaultAgentMode?: 'manual' | 'risk' | 'auto';
  defaultPromptMode?: 'normal' | 'minimal' | 'mixed';
  language?: 'auto' | 'zh' | 'en';
  /** 界面字号（顶层 `uiFontSize`）；只有 UI 消费 */
  fontSize?: 'medium' | 'large' | 'xlarge';
  /** MCP 默认启用列表（设置面板「默认配置」，服务器名数组） */
  mcpServers?: string[];
  closeAfterSave?: boolean;
  /** 当前会话与 (provider, model)，供宿主校验模型是否仍被支持 */
  sessionId?: string;
  currentModel?: string;
  currentProvider?: string;
} | {
  type: 'respondUserChoice';
  choiceId: string;
  index: number;
  reply?: string;
  /**
   * AskUserQuestion 的逐题回复（specs/026）。权限确认场景仍用 index / reply。
   */
  answers?: Array<{ id: string; selected: string[]; custom?: string }>;
} | {
  /** 中止当前查询；多视图宿主下携带发起方会话 */
  type: 'abort';
  sessionId?: string;
} | {
  /**
   * 用户把某台正在前台运行的 Bash 命令转入后台（Bash 卡片「转后台」按钮）：
   * 宿主翻译成 `UiEvent.bashBackgroundRequested`，core 侧触发转换并暂停
   * 下一轮 agent 循环（见 `tools/bash/ManualBackground.ts`）。
   */
  type: 'backgroundBashTool';
  sessionId: string;
  toolUseId: string;
} | {
  /**
   * 用户撤回排队消息（排队项的「编辑 / 删除」）：宿主翻译成
   * `UiEvent.queuedMessageDiscarded`，core 按 uuid 丢弃引擎里尚未消费的同一消息。
   * 「编辑时回填输入框」是 webview 本地表现，不经过本消息。
   */
  type: 'discardQueuedMessage';
  sessionId: string;
  uuid: string;
} | {
  type: 'requestSmartNaming';
  sessionId: string;
} | {
  type: 'renameConversation';
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
} | {
  type: 'requestConversationSpaces';
} | {
  type: 'clearConversationSpace';
  dirName: string;
  /**
   * 清理深度：`clear` 清内容保留空间目录（workspace 还在）；
   * `remove` 整目录删除（workspace 已不存在，删除后列表不再显示）。
   */
  mode: 'clear' | 'remove';
} | {
  /** 会话上下文落盘请求（当前文件 / 选中行 / 上下文 token 数） */
  type: 'updateConversationContext';
  sessionId: string;
  currentFile?: string;
  selectedLines?: WebviewSelectedLines;
  totalContextTokens?: number;
} | {
  /** 后台预热视图报告「已挂载」：宿主可补发 activatePrewarmedView */
  type: 'prewarmViewReady';
} | BidirectionalWebviewMessage;

// ==================== 并集别名与派生工具 ====================

/**
 * webview 实际收到的形状：`WebViewUI.postToWebview` 会给所有消息补 `sessionId`
 * （直接 `sendToWebview` 的广播消息除外），因此广播类成员在 wire 上也带该字段。
 * webview 侧按会话过滤时统一读它。
 */
export type HostToWebviewWire = HostToWebviewMessage & { sessionId?: string };

/** 双向并集（兼容别名：宿主实现层既有引用沿用；新代码按方向选窄类型） */
export type WebviewMessage = HostToWebviewMessage | WebviewToHostMessage;

/** 去掉 sessionId 的宿主消息（postToWebview 统一补 sessionId 后投递） */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export type HostToWebviewMessageWithoutSessionId = DistributiveOmit<HostToWebviewMessage, 'sessionId'>;

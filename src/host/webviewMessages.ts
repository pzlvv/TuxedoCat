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
   * webview 的 `toUiMessage` 依赖它区分「真正的用户消息」与系统通知——两类系统通知
   * 在消息区都是一行折叠行（`docs/hosts/webview-ui.md` 第 11 节）。
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
  /**
   * Core 侧请求标识（specs/050 FR-001）：`userChoiceCanceled` 按它精确撤回这次请求。
   * 与 `choiceId` 的区别见 `src/shared/UserChoiceQueue.ts` 的 `choiceRequestId` 注释。
   */
  choiceRequestId: string;
  /**
   * 发起这次提问的工具调用 id（specs/050 FR-003）。
   * 该工具产出结果（成功或失败）时 webview 据此收回选择框。
   * 权限确认走 `toolPermissionRequested` 在先、`userChoice` 在后的时序，没有单一发起工具
   * 时就为 `undefined`，此时只由 `userChoiceCanceled` 收回。
   */
  toolUseId: string | undefined;
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
  /**
   * 收回当前选择框（specs/050 FR-002）。
   *
   * Core 宣告这次 `userChoice` 已作废（回复超时 / 会话 abort）时下发：webview 按
   * `choiceRequestId` 匹配在显示的选择框后收起。与「工具结果到达」走的 `updateToolStatus`
   * 收框路径是同一个落点，只是触发源不同。
   *
   * 只带 `choiceRequestId`、不带 `sessionId`：webview 全局只有一个在显示的选择框，
   * 按请求标识匹配已足够，多一个字段就多一处可能不一致。
   */
  type: 'userChoiceCanceled';
  choiceRequestId: string;
} | {
  type: 'updateToolStatus';
  sessionId: string;
  toolCallId: string;
  /**
   * 该卡片所属 JSONL 行的 uuid（specs/039 FR-001 的节点身份）：core 的 `toolCall`
   * 事件带来，webview 存到消息上供时间线回退定位。`null` = 这一路没有 uuid
   * （历史恢复 / 虚拟卡片）。
   */
  messageUuid: string | null;
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
    /** 已登记手动压缩、等前台工作收尾后执行；不参与 `idle` */
    pendingCompact: boolean;
    backgroundRunning: boolean;
    /** 运行中后台 Bash 任务清单（specs/019 FR-001），注册序；空集为 `[]`。`startedAt`
     * 是任务的开始时刻（毫秒，specs/054 FR-001），悬停明细的「已执行时间」起点 */
    backgroundTasks: ReadonlyArray<{ taskId: string; description: string; command: string; startedAt: number }>;
    subAgentRunning: boolean;
    /**
     * 子代理会话为创建时 Agent 工具调用的 description；普通会话与恢复路径
     * 取不到时为 `null`
     */
    subAgentDescription: string | null;
    /** 本地子代理的登记时刻（毫秒，specs/054 FR-002）；取不到为 `null` */
    subAgentStartedAt: number | null;
    /** 发起方仍在登记的跨工作区子代理（specs/054 FR-003），登记序；空集为 `[]` */
    remoteSubAgents: ReadonlyArray<{
      sessionId: string;
      description: string | null;
      workspaceId: string;
      startedAt: number;
    }>;
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
      context?: { currentFile?: string; selectedLines?: WebviewSelectedLines; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; model?: string; provider?: string };
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
  savedContext?: { currentFile?: string; selectedLines?: WebviewSelectedLines; agentMode?: 'manual' | 'risk' | 'auto'; thinkingMode?: 'off' | 'low' | 'high' | 'max'; webSearch?: boolean; totalContextTokens?: number; isCompacted?: boolean; isExpanded?: boolean; provider?: string };
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
  /** 对话级回退完成（specs/039 FR-006）：截断消息已由 `messagesReplaced` 下发，这里是结果摘要 */
  type: 'conversationRewoundDone';
  sessionId: string;
  targetUuid: string;
  removed: number;
  files: Array<{ path: string; ok: boolean; error: string | null }>;
  skipped: string[];
  hadBash: boolean;
  /** 整次回退被拒时的文案（此时消息与文件都没有变化）；成功为 null */
  error: string | null;
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
  /**
   * 文件存储能力（specs/051 FR-001）。
   *
   * 入口渲染判据是 `isolatedWorkView || deployable`（FR-002）：当下可用、或可经部署变得
   * 可用，都渲染；两者都不成立时整块入口不渲染。
   */
  type: 'setStorageCapabilities';
  isolatedWorkView: boolean;
  /** 挂载代理是否就位（`'ready'` / `'absent'`） */
  mountProxy: 'ready' | 'absent';
  /** 部署代理是否可能解决当下的不可用（Core 推导，宿主透传） */
  deployable: boolean;
  reason: string;
} | {
  /**
   * 挂载代理部署的进行状态（specs/051 FR-003 / FR-004 / FR-008）。
   *
   * 唯一的「部署走到哪一步」事实来源：webview 只渲染这里给的值，不自己推断进度、
   * 不自己判 ready（FR-005「自检归属唯一」）。`phase` 是判别字段，其余字段全必选——
   * 不适用时用 `null`，不用可选成员（铁律 4.2）。
   *
   * - `confirm`：闸门拦下了一条消息，等用户确认（四要素文案用 `targetHost` /
   *   `installPath`）；
   * - `running`：正在提权 / 安装；
   * - `needsCredential`：免密 `sudo` 不可用，等用户三选一；`manualCommand` 非
   *   `null` 时表示「显示命令自己执行」通道，此时不渲染密码框；
   * - `failed`：本轮失败，`failure` 是可行动的原因；换一条来源可继续重试，不设次数上限；
   * - `done`：代理就位且能力已重查可用，宿主接着发原来那条消息（FR-008）；
   * - `cancelled`：用户取消，界面收起对话框（FR-003 的 AC-9）。必须有这一态：webview
   *   只在收到本消息时改变对话框，取消若不下发，界面会一直停在 `confirm`。
   */
  type: 'mountProxyDeployState';
  phase: 'confirm' | 'running' | 'needsCredential' | 'failed' | 'done' | 'cancelled';
  /** 失败原因；非 `failed` 时为 `null` */
  failure: string | null;
  /** 零密码通道的完整命令；只在 `needsCredential` 的另一条通道里有值 */
  manualCommand: string | null;
  /** 目标主机（远端场景点名真实主机，null 表示本机） */
  targetHost: string | null;
  /** 完整安装落点 */
  installPath: string;
} | {
  /**
   * 一次提交请求被受理（specs/059 FR-004）：webview 可以消费载体并上送了。
   *
   * 两段式的第一段到这里结束——裁决到达之前 webview 不清空输入框、不建会话 id、不写
   * 对话列表与命令历史（specs/059 FR-001），因此「回到发送前」不需要回填通道，
   * 只要把这次提交丢掉（见 `userMessageRejected`）。
   *
   * `submitId` 由 webview 生成并随 `submitMessage` 上行，宿主原样回带：裁决与提交一一对应，
   * 不受同时存在的其它视图请求影响。
   */
  type: 'userMessageAccepted';
  submitId: string;
  /** 本次提交归属的会话（webview 在提交时算好，受理时才写进当前会话） */
  sessionId: string;
} | {
  /**
   * 一次提交请求被拒绝（specs/059 FR-003 / FR-002）：用户取消部署，或 Core 报
   * 「不可用且不可部署」的接线错误。
   *
   * webview 收到后**丢弃未决提交**——什么都不回填、什么都不改，因为载体从未被消费
   * （对比已删除的 `userMessageDraftRestored` 的「清空后写回」）。
   */
  type: 'userMessageRejected';
  submitId: string;
  /** 拒绝原因（`deployable === false` 时是 Core 给的 `reason`；取消时为空串） */
  reason: string;
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
  /**
   * 压缩归档展开数据（`docs/features/compaction.md` FR-005）：各代与当前保留区合并成的
   * **完整**显示序列 + 每代在其中的起始下标。展开到第几层由 webview 决定；取不到归档时
   * 两个字段都是空数组（webview 据此保持展开按钮不变、可见集合不变）。
   */
  type: 'expandCompactDone';
  sessionId: string;
  messages: MessageData[];
  generationStarts: number[];
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

/**
 * 一条用户消息的载荷（`sendMessage` 与 `submitMessage` 共用）。
 *
 * 单列出来是因为它有两个上行入口、载荷逐字段一致：`sendMessage` 是**已受理消息**的上行
 * （宿主重投排队项、部署成功后继续原提交），`submitMessage` 是**用户按下发送**的上行
 * （specs/059 FR-001 的两段式的第一段）。字段写成一份，两者不会漂移。
 */
export interface SendMessagePayload {
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
  /**
   * 该会话的文件存储归属（specs/045 FR-001）。
   *
   * 必选：部署闸门（specs/051 FR-003）只在 Overlay 归属上生效，而 `setConversationStorage`
   * 与消息上行是两条独立的上行，到达顺序取决于渲染时序——用先后顺序推归属会让闸门
   * 时灵时不灵。归属随消息一起带，判据就不依赖任何跨消息状态。
   */
  storage: 'workspace' | 'isolated';
}

export type WebviewToHostMessage = (
  {
    /**
     * 已受理的用户消息上行：宿主翻译成 `UiEvent.userMessageSubmitted`（排队 / 回显策略在宿主）。
     *
     * 用户按下发送不走这条（走 `submitMessage`）——两条的区别是**谁已经点过头**：
     * 这条的发送方（宿主重投、部署成功后继续）已在受理阶段拿到了裁决，不再需要判据。
     */
    type: 'sendMessage';
  } & SendMessagePayload
) | (
  {
    /**
     * **提交请求**（specs/059 FR-001）：用户按下发送时上行的第一条消息，携带载荷快照与
     * 一个 webview 生成的 `submitId`。
     *
     * 宿主对它做三态裁决（可发送 / 需要部署 / 拒绝），结果以 `userMessageAccepted` 或
     * `userMessageRejected` 按 `submitId` 回包。**裁决之前 webview 不消费任何载体**
     * ——不清输入框、不建会话、不写列表与命令历史，因此取消不需要回填。
     *
     * 载荷与 `sendMessage` 完全同一份（`SendMessagePayload`），受理之后宿主走的正是
     * 同一条 `handleUserMessage`。
     */
    type: 'submitMessage';
    /** webview 生成的提交标识；宿主原样回带进裁决消息 */
    submitId: string;
  } & SendMessagePayload
) | {
  /**
   * 对话切换锁的登记（specs/059 FR-007）：webview 在部署确认框打开、或一次提交还没拿到
   * 裁决时上报 `locked: true`，收尾时上报 `false`。
   *
   * 为什么要上报而不是让宿主自己查：闸门实例在 `WebviewMessageHandler`（按视图一份语义），
   * Electron 主进程拿不到；而「哪个视图锁着」是视图级事实，主进程按 `sender` 过滤才不会
   * 误伤同一标签页之外正常的对话切换。
   */
  type: 'conversationSwitchLockChanged';
  locked: boolean;
  /** 锁的原因（日志与诊断用；不渲染给用户） */
  reason: string;
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
  /**
   * 请求本 Core 的文件存储能力（specs/045 FR-001）。宿主转发 Core 的应答，
   * 再以 `setStorageCapabilities` 推回。
   */
  type: 'requestStorageCapabilities';
} | {
  type: 'startNewConversation';
  sessionId: string;
  /**
   * 文件存储归属（specs/045 FR-001）：新建对话时一律显式给出。
   *
   * 必选而不是可选：勾选框在「新建对话」之后才渲染，用户勾选的时刻晚于本消息，
   * 所以这里的值只是**初始**归属，随后的勾选取 `setConversationStorage` 补发。
   */
  storage: 'workspace' | 'isolated';
} | {
  /**
   * 改会话的文件存储归属（specs/045 FR-001）。
   *
   * 只在「新建对话、还没有任何消息」时有意义：勾选框在 `startNewConversation`
   * 之后才出现，用户勾选时必须补发一次，否则 Core 记的仍是初始的 `workspace`。
   * Core 侧按「meta.json 已存在即忽略」拒绝改动，归属因此仍然是写一次不变。
   */
  type: 'setConversationStorage';
  sessionId: string;
  storage: 'workspace' | 'isolated';
} | {
  /**
   * 用户在部署确认框点了「部署」（specs/051 FR-003 / FR-004）。
   *
   * 闸门在宿主侧：`sendMessage` 被拦下后宿主推 `mountProxyDeployState{phase:'confirm'}`，
   * 本消息是用户对那一问的「确认」。宿主收到后按 FR-004 的顺序取提权（先试免密
   * `sudo -n`），需要密码时再推 `needsCredential` 让用户三选一。
   */
  type: 'requestMountProxyDeploy';
} | {
  /**
   * 提交一次提权凭据（specs/051 FR-004）。
   *
   * **本消息的 handler 第一条语句必须声明不记录**（`docs/architecture/hosts.md`
   * 的日志口径）：`secret` 是明文密码，只允许写进提权子进程的标准输入，绝不进 argv /
   * 环境变量 / 日志 / 诊断输出。`method` 决定它交给 `sudo -S` 还是 `su -c`。
   */
  type: 'submitMountProxyCredential';
  method: 'sudoPassword' | 'rootPassword';
  /** 明文密码（一次性；宿主侧收到后转成可清零的字节缓冲，用后清零） */
  secret: string;
} | {
  /** 用户取消部署（确认框的取消 / Escape / 点遮罩，specs/051 FR-003） */
  type: 'cancelMountProxyDeploy';
} | {
  /**
   * 用户在提权三选一里选了「显示命令自己执行」（specs/051 FR-004 第 2 条）。
   *
   * 零密码通道：宿主把完整安装命令推回去（`mountProxyDeployState{phase:'needsCredential',
   * manualCommand}`），然后轮询落点是否就位；全程没有密码经过宿主进程（AC-12）。
   * 单独一条消息而不是复用 `requestMountProxyDeploy`——后者会重新跑一遍免密安装。
   */
  type: 'showMountProxyManualCommand';
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
  /**
   * 用户主动取消这次选择（specs/050 FR-004）。
   *
   * `true` 时 `index` / `reply` / `answers` 一律忽略：宿主以「请求得到否定答复」收敛，
   * 权限确认视为拒绝、`AskUserQuestion` 视为工具失败且不产出部分答案。
   * 与 `choiceId` 找不到对应 pending 时的处理一致（作废后取消是 no-op）。
   */
  canceled?: boolean;
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
  /** 从时间线某个节点「从这里继续」（specs/039）：core 截断消息并回滚区间内的文件 */
  type: 'rewindConversation';
  sessionId: string;
  /** 目标节点的 JSONL uuid（展示消息的 `messageUuid`） */
  targetUuid: string;
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

/**
 * AssistantEventBus - core 与 UI 的唯一耦合点（事件契约）
 *
 * core 与 UI 不互相引用，只通过总线上的事件耦合：
 * - core 发 CoreEvent / CoreRequest，订阅 UiEvent；
 * - UI（WebViewUI）订阅 CoreEvent / CoreRequest，发 UiEvent。
 * 事件类型是两边唯一的公共词汇表。
 *
 * 事件命名约定（见 DEVELOPMENT.md 第 3.4 节）：
 * - CoreEvent / CoreRequest 的 type = 处理器方法名去掉 on 前缀
 * - UiEvent 的 type 是过去式，描述用户已经做完的动作
 *
 * 边界语义（见 DEVELOPMENT.md 第 3.7 节）：
 * - emitToUi 时 onCoreEvents 尚未注册 → 抛错（bootstrap 顺序错误，启动期暴露）
 * - emitToCore / onUiEvent 对某 type 尚无 core 订阅者 → 静默丢弃（合法中间态）
 * - request() 无内置超时：响应方不存在 / 响应丢失会永久挂起；
 *   当前两个请求都不设超时，调用点自行决定兜底
 */

import type { Message, MessageData, StreamMessageData, StreamEndData } from './types.js';
import type { AgentMode } from './types.js';
import type { ModelRef } from './llm/modelRef.js';
import type { PermissionResult, ToolProgressData } from './tools/Tool.js';
import type { UserChoiceOptions } from './UserChoiceQueue.js';
import type { ConversationMetadata } from './history/Conversation.js';
import type { ConversationSpaceInfo } from './history/ConversationSpace.js';
import type { McpServerDefinition, SettingsSnapshot } from './settingsSnapshot.js';
import type { McpServerInfo } from './webviewTypes.js';
import type { NoticeLevel, NoticeParams } from './coreText.js';

// ==================== core → UI：单向事件 ====================

/**
 * core 发给 UI 的单向事件。
 *
 * 不按「渲染 / 控制」再分组：事件是纯数据，分组只会多一层没有语义的包装；
 * 「谁来处理」由订阅方（WebViewUI）在 `onCoreEvents` 里决定，
 * 逐事件的触发点与处理见 DEVELOPMENT.md 第 4 章。
 */
export type CoreEvent =
  /**
   * Core 已就绪（处理完 `hostEnvironmentProvided`，`docs/core-ui-separation.md` 第 7 节）。
   *
   * 每次应用配置快照后都发一次（首次握手、以及后续每次重新推送快照），
   * 宿主据此判定「Core 已跟上最新配置」。Core 侧的就绪状态本身是幂等的。
   */
  | { type: 'coreReady' }
  | { type: 'message'; sessionId: string; data: MessageData }
  | { type: 'streamMessage'; sessionId: string; data: StreamMessageData }
  | { type: 'streamEnd'; sessionId: string; data: StreamEndData }
  | { type: 'toolCall'; sessionId: string; toolUseId: string; toolName: string }
  | {
      type: 'toolResult';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      output: string;
      status: 'success' | 'error';
    }
  | {
      type: 'toolArgsUpdated';
      sessionId: string;
      toolUseId: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'toolProgress';
      sessionId: string;
      toolUseId: string;
      progress: ToolProgressData;
    }
  | { type: 'aiBegin'; sessionId: string }
  | { type: 'aiEnd'; sessionId: string }
  /**
   * 整批替换该会话显示的消息（压缩后重建 / 展开归档共用）。
   * core 只描述「消息列表被替换成了这些」，不做「先清空再逐条补」的两步动作。
   */
  | { type: 'messagesReplaced'; sessionId: string; messages: readonly MessageData[] }
  | { type: 'queryBegin'; sessionId: string }
  | { type: 'queryEnd'; sessionId: string }
  | { type: 'titleChanged'; sessionId: string; title: string }
  | {
      type: 'sessionCreated';
      sessionId: string;
      /** 子代理会话的父会话；普通新会话为 null */
      parentSessionId: string | null;
    }
  /** 对话列表（磁盘元数据）发生变化：落盘 / 改名 / 删除 / 新建 */
  | { type: 'conversationListChanged' }
  /**
   * 对话空间清空完成（`UiEvent.conversationSpaceCleared` 的执行回执）。
   *
   * `sessionId` 是对话空间目录名（与同名 UiEvent 同语义）。结果是判别联合：
   * 成功带删除统计，失败带原因。webview 设置面板靠这条回执解除「删除中」，
   * 成功与失败都必须发出（UiEvent 是 fire-and-forget，这是唯一的完成信号）。
   */
  | {
      type: 'conversationSpaceCleared';
      sessionId: string;
      result:
        | { status: 'complete'; removedFiles: number; removedBytes: number }
        | { status: 'error'; message: string };
    }
  /**
   * 会话运行时状态变化（有活跃查询 / 正在等待用户操作）。
   *
   * 推全量（所有已知会话的状态）而不是增量：会话数量是几十的量级，
   * 全量让消费者不必自己维护状态表，也不会因为丢一条增量而永久错位。
   *
   * 与 conversationListChanged 是两条独立的流：
   * - conversationListChanged：磁盘列表变了（落盘 / 改名 / 删除 / 新建）
   * - sessionRuntimeChanged：运行时状态变了（查询开始结束 / 等用户 / 用户响应 / 压缩开始结束）
   */
  | {
      type: 'sessionRuntimeChanged';
      states: readonly SessionRuntimeState[];
    }
  | { type: 'spinDesignDataChanged' }
  /**
   * 本条消息里用到了哪些高亮语言（围栏代码块语言）。
   *
   * core 只做「从消息里扫出来」这一件事，**不维护已记录集合**：`highlightLanguages`
   * 是 UI 专属字段（`docs/core-ui-separation.md` 第 4.9 节），去重与上限由宿主的
   * `highlightLanguagesMutator` 承担，写盘走 `UIHost.updateSettingsJson`。
   * 因此同一语言可能被重复上报，宿主按幂等处理。
   */
  | { type: 'highlightLanguagesUsed'; languages: readonly string[] }
  | { type: 'compactBegin'; sessionId: string }
  | {
      type: 'compactEnd';
      sessionId: string;
      /** 压缩结果：成功带压缩后 token 数，失败不带（错误详情走 message 事件） */
      result:
        | { status: 'complete'; postCompactTokenCount: number | null }
        | { status: 'error' };
    }
  | {
      type: 'commandDispatched';
      sessionId: string;
      commandName: string;
      args: string;
    }
  | {
      type: 'sessionConfigChanged';
      sessionId: string;
      /** 只带被改动的字段（判别联合，避免可选字段） */
      change:
        | { key: 'model'; ref: ModelRef }
        | { key: 'thinkingEffort'; value: 'off' | 'low' | 'high' | 'max' }
        | { key: 'promptMode'; value: 'normal' | 'minimal' | 'mixed' }
        | { key: 'agentMode'; value: AgentMode }
        | { key: 'webSearch'; value: boolean }
        | { key: 'mcpEnabled'; value: string[] };
    }
  /**
   * core 日志行（已格式化）。
   *
   * core 只报告事实：日志出口由 UI 决定（VS Code 写 OutputChannel，Electron 写 console），
   * core 侧没有日志出口的注入入口。
   */
  | { type: 'log'; message: string }
  /**
   * 瞬时状态提示（`docs/core-ui-separation.md` 第 4.9 节）。
   *
   * core 不拼文案：只给「键 + 参数」，翻译与呈现由 UI 承担（键在 `coreText.ts` 登记）。
   * 提示不进消息流、不落盘；`sessionId` 指出提示归属的会话。
   */
  | {
      type: 'notice';
      sessionId: string;
      key: string;
      params: NoticeParams;
      level: NoticeLevel;
    };

// ==================== core → UI：请求-响应 ====================

/**
 * 需要 UI 返回结果的请求。
 * 对应 WebViewUI 的两个带返回值的方法（requestToolPermission / requestUserChoice）。
 */
export type CoreRequest =
  | {
      type: 'toolPermissionRequested';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      /**
       * core 已按 agentMode 规则加工过的权限结果：
       * `allow` 直接放行、`deny` 直接拒绝、`ask` 需要 UI 弹确认框。
       * Edit / Write 的 diff 预览字段也在里面。
       */
      permResult: PermissionResult;
      /** 展示用参数（路径已展开） */
      displayArgs: Record<string, unknown>;
      /**
       * 本次决策实际采用的询问模式（core 已解析会话级覆盖 / settings.json 默认）。
       * UI 只读展示：仅 manual 模式才打开宿主侧 diff 标签。
       */
      agentMode: AgentMode;
    }
  | { type: 'userChoice'; sessionId: string; options: UserChoiceOptions };

/** 请求 → 结果的类型映射（判别联合，字段完整） */
export type CoreRequestResultMap = {
  toolPermissionRequested: PermissionResult;
  userChoice: { index: number; reply?: string };
};

/**
 * 发送侧取单个结果类型用 `request<T>` 的泛型签名，不需要这个联合。
 * 保留它只作为「所有可能结果」的枚举（如实现内部中转时用）。
 */
export type CoreRequestResult = CoreRequestResultMap[keyof CoreRequestResultMap];

// ==================== UI → core：单向事件 ====================

/**
 * UI 层报告「用户做了什么」。
 *
 * core 订阅这些事件并执行对应的业务动作；执行结果再通过 `CoreEvent` 广播回 UI
 * （多端同步用）。
 *
 * 注意：
 * - `CoreRequest` 的响应通过 `request()` 返回的 Promise 回传，不占用本组事件
 *   （所以没有 `userChoiceResponded`）。
 * - webview 协议消息由 WebviewMessageHandler 解析后翻译成本组事件，
 *   它自己不再直接调用 core 的业务函数。
 */
export type UiEvent =
  // ===== 消息 =====
  /**
   * 用户消息进入 core 的唯一入口。
   *
   * 宿主只负责组装载荷并发出本条事件；入队、落盘、命令解析、轮次边界消费都在 core 侧。
   * `uuid` 由宿主生成并回带，用于把 webview 里的排队项与 core 的消息配对。
   */
  | {
      type: 'userMessageSubmitted';
      sessionId: string;
      /** 纯文本内容（不含文件引用与图片） */
      content: string;
      /** 消息 uuid（宿主生成；core 落盘时沿用） */
      uuid: string;
      /** 图片（dataUrl 形式，随消息进入 LLM content blocks） */
      images?: Array<{ dataUrl: string; mediaType?: string; width?: number; height?: number }>;
      /** 引用的文件路径（展示与持久化用，是否发给 LLM 由 fileHidden 决定） */
      filePath?: string;
      fileSelectedLines?: { start: number; end: number };
      fileHidden?: boolean;
      /** 本次消息携带的会话覆盖（缺省时沿用会话已有取值） */
      agentMode?: AgentMode;
      thinkingMode?: 'off' | 'low' | 'high' | 'max';
      model?: ModelRef;
      webSearch?: boolean;
      /** 该会话的工作目录（多工作目录宿主按会话解析后带上） */
      workspacePath?: string;
      /**
       * 是否由 core 在「消息真正进入 LLM 上下文」时补发用户气泡。
       *
       * 仅 Embedded 下的命令消息（`/xxx`）置 true：宿主不再乐观回显，
       * 由 QueryEngine 在出队解析后决定是否补发（内置命令就地执行、不落盘，
       * 因此不应留下一个不会被持久化的气泡）。Standalone 无此机制，恒为 false。
       */
      deferEcho?: boolean;
    }
  | { type: 'abortRequested'; sessionId: string }

  // ===== 压缩 =====
  /** 用户触发压缩（会改写会话数据，属 core 业务） */
  | { type: 'compactRequested'; sessionId: string }

  // ===== 会话生命周期 =====
  /**
   * 新会话建立。
   *
   * `workspacePath` 是该会话归属的工作目录（多工作目录宿主按会话解析后带上）；
   * 缺省时 core 回退到活动工作目录。
   */
  | { type: 'conversationStarted'; sessionId: string; workspacePath?: string }
  | { type: 'conversationOpened'; sessionId: string }
  /**
   * 会话被关闭：释放该会话的运行时内存，磁盘数据不动。
   * core 收到后调 `sessionResources.releaseSessionResources(sessionId)`。
   */
  | { type: 'conversationClosed'; sessionId: string }
  | { type: 'conversationRenamed'; sessionId: string; title: string }
  | { type: 'conversationDeleted'; sessionId: string }
  /**
   * 会话上下文（meta.json 的 context 字段）部分更新。
   * 用 changes 数组而不是可选字段：一次可带多个字段，未列出的字段保持原值。
   */
  | {
      type: 'conversationContextUpdated';
      sessionId: string;
      changes: Array<
        | { key: 'currentFile'; value: string | null }
        | { key: 'selectedLines'; value: { start: number; end: number } | null }
        | { key: 'totalContextTokens'; value: number }
      >;
    }
  /**
   * 清理对话空间：`mode` 选择清理深度（互斥语义用字面量联合，不用可选字段）。
   *
   * - `clear`：清空空间内容（对话 / 工具结果），保留空间目录与
   *   `workspace.meta.json`（workspace 还在时用，项目映射要留着）；
   * - `remove`：整个空间目录一并删除（workspace 已不存在时用，
   *   清掉后列表不再显示该空间）。
   *
   * `sessionId` 是对话空间目录名（不是会话 id）。执行结果经
   * `CoreEvent.conversationSpaceCleared` 回执。
   */
  | { type: 'conversationSpaceCleared'; sessionId: string; mode: 'clear' | 'remove' }

  // ===== 会话配置 =====
  | { type: 'modelChanged'; sessionId: string; ref: ModelRef }
  | { type: 'thinkingEffortChanged'; sessionId: string; mode: 'off' | 'low' | 'high' | 'max' }
  | { type: 'promptModeChanged'; sessionId: string; mode: 'normal' | 'minimal' | 'mixed' }
  | { type: 'agentModeChanged'; sessionId: string; mode: AgentMode }
  | { type: 'webSearchChanged'; sessionId: string; enabled: boolean }
  | { type: 'mcpEnabledChanged'; sessionId: string; name: string; enabled: boolean }

  // ===== 其它 =====
  /**
   * 用户请求把某个 Edit / Write 操作回滚到修改前 / 后。
   *
   * `filePath` 是目标 tool_use 的 `input.file_path` 缺失时的兜底路径：
   * provider 偶发把整个入参 double-encode 成字符串，磁盘上的 `input` 不是对象，
   * core 取不到 `file_path`，此时用 UI 侧归一化后的 args.file_path 兜底。
   */
  | { type: 'editRolledBack'; sessionId: string; toolUseId: string; direction: string; filePath?: string }

  // ===== 宿主环境与配置 =====
  /**
   * 宿主环境与配置快照（连接建立后由 UI 发一次）。
   *
   * 宿主固有差异 + 配置快照一次给齐（`docs/core-ui-separation.md` 第 3.2 节）：
   * - 环境三项（extensionPath / logToConsole / configDirName）是宿主固有差异；
   * - `settings` 是配置快照，`mcpServers` 是 `mcp.json` 的解析结果。
   *
   * 配置归 UI：core 不感知 `settings.json` / `mcp.json` 的路径，只消费这里的快照
   * （`src/core/settings.ts` 是 core 侧唯一入口）。字段全必选，缺字段即协议错误。
   */
  | {
      type: 'hostEnvironmentProvided';
      /**
       * 扩展 / 应用根目录。
       *
       * Embedded Core 用它定位随宿主分发的 ripgrep / pandoc（`utils/ripgrep.ts`）；
       * Standalone Core 的自带资源以**自己的可执行文件目录**为基准（与可执行文件同级的
       * `ripgrep/`），这里只作本机开发期的兜底（`docs/standalone-core.md` 第 4 节）。
       */
      extensionPath: string;
      /** core 日志是否同时输出到控制台 */
      logToConsole: boolean;
      /** 配置目录名（`~/<configDirName>`）；产品名不进 core 实现 */
      configDirName: string;
      /** 配置快照（`settings.json` 规范化后的结果） */
      settings: SettingsSnapshot;
      /** MCP 服务器定义（`mcp.json` 规范化后的结果） */
      mcpServers: readonly McpServerDefinition[];
    }
  // ===== 用户选择 =====
  /**
   * 某个会话的用户选择（ask user / 权限确认）在 webview 里弹出 / 被应答。
   *
   * 宿主只报告自己知道的事实（弹出、应答）；core 据此维护 `sessionRuntime.waiting`，
   * 供 `isSessionIdle` 判定「非空闲」。入队阶段（尚未弹出）由 core 自己在
   * `Integration.requestUserChoice` 里标记。
   */
  | { type: 'userChoicePendingChanged'; sessionId: string; pending: boolean }
  /**
   * 登记「会话 → 工作目录」。
   *
   * Embedded 下宿主直接调 `setSessionWorkspace()`（同进程，同一张表）；Standalone 下
   * 这张表在 Core 进程内，宿主必须经事件交给 Core。多工作目录的宿主在打开 / 切换 /
   * 重命名会话时用它把会话自己的目录告诉 core，core 据此解析工具的相对路径。
   */
  | {
      type: 'sessionWorkspaceAssigned';
      sessionId: string;
      /** `null` 表示清除该会话的登记（回退到活动工作目录） */
      workspacePath: string | null;
    };

// ==================== UI → core：请求-响应 ====================

/**
 * 需要 core 返回结果的请求（`CoreRequest` 的反方向）。
 *
 * 宿主不直接读取 core 的磁盘数据（`docs/standalone-core.md` 第 10 节）：需要
 * 「core 的事实」时由宿主发起请求、core 应答。Embedded 下这些事实本来就在同进程，
 * 请求退化为一次函数调用，结果一致。
 *
 * 边界语义与 `request()` 相同：无内置超时，调用点自行兜底；应答方不存在时
 * 静默挂起（`StandaloneEventBus` 在 Core 断开时以错误结束挂起的请求）。
 */
export type UiRequest =
  /** 对话列表元数据（`loadConversationList` 的等价物） */
  | { type: 'conversationListRequested'; workspacePath?: string }
  /** 智能命名：读会话消息 + 调 LLM + 解析标题（`history/smartNaming` 的等价物） */
  | { type: 'smartNamingRequested'; sessionId: string }
  /**
   * DeepSeek 账户余额（`utils/balance` 的等价物）；未配置 api.deepseek.com 时为 `null`。
   * `sessionId` 用于多 Connection 路由（余额按各自 Core 的配置快照查询）。
   */
  | { type: 'balanceRequested'; sessionId?: string }
  /**
   * 压缩归档展开：归档消息 + 当前未压缩部分（`loadCompactArchive` + 主 JSONL 的合并）。
   * 返回 `null` 表示该会话没有归档。
   */
  | { type: 'compactArchiveRequested'; sessionId: string }
  /**
   * MCP 面板列表：配置（快照里的服务器定义）+ 该会话生效的启用状态 + 运行时状态。
   * `sessionId` 缺省时只按全局默认启用列表取值。
   */
  | { type: 'mcpServersRequested'; sessionId?: string }
  /**
   * 对话空间统计（各空间的字节数 / 文件数 / 会话数）。
   * 数据在 core 的数据目录内，宿主不直接读盘。
   */
  | { type: 'conversationSpacesRequested' }
  /**
   * 等待某会话的挂起持久化完成（宿主切走会话前调用，保证磁盘是最新状态）。
   * 结果无载荷；会话不存在时也算完成（`null`）。
   */
  | { type: 'flushSessionRequested'; sessionId: string }
  /**
   * 加载会话内容与派生事实（宿主渲染对话、工具元数据、模型身份用）。
   * 会话文件不存在时返回空消息与 `metadata: null`。
   */
  | { type: 'conversationLoadRequested'; sessionId: string }
  /**
   * 斜杠命令与技能列表（内置命令 + 内置技能 + 会话工作目录下的技能）。
   * `sessionId` 决定项目技能扫描的工作目录；缺省时只列内置项。
   */
  | { type: 'skillsRequested'; sessionId?: string };

/** 会话加载结果（`UiRequest.conversationLoadRequested`） */
export interface LoadedConversation {
  messages: Message[];
  metadata: ConversationMetadata | null;
  /**
   * 仍在等待权限 / 执行的工具调用 id。
   * Embedded 为进程内事实；Standalone 下由 Core 在加载时合成取消结果，恒为空。
   */
  pendingToolUseIds: string[];
  /** 是否存在压缩归档 */
  hasCompactArchive: boolean;
  /** 会话的询问模式（core 的权威取值；无记录为 null） */
  agentMode: AgentMode | null;
}

/** 技能 / 命令列表项（`UiRequest.skillsRequested`） */
export interface SkillListItem {
  name: string;
  description: string;
  /** true = 内置斜杠命令；false = 技能（内置或项目目录） */
  isBuiltin: boolean;
}

/** 请求 → 结果的类型映射（判别联合，字段完整） */
export type UiRequestResultMap = {
  conversationListRequested: ConversationMetadata[];
  smartNamingRequested: { title: string };
  balanceRequested: {
    totalBalance: number;
    currency: string;
    isUnlimited: boolean;
    fetchedAt: number;
  } | null;
  compactArchiveRequested: Message[] | null;
  mcpServersRequested: McpServerInfo[];
  conversationSpacesRequested: ConversationSpaceInfo[];
  flushSessionRequested: null;
  conversationLoadRequested: LoadedConversation;
  skillsRequested: { skills: SkillListItem[] };
};

// ==================== 会话运行时状态 ====================

/**
 * 单个会话的运行时状态。消费者：Electron 侧栏流水灯、系统托盘状态点、
 * webview 对话树的运行标记、两端的 abort 按钮。
 *
 * 只有 core 能提供的事实进这里；宿主自己的界面状态（如 Electron 的
 * 「视图已打开」）由宿主自己维护，不混进来。
 *
 * 判定统一用 `idle`（见 `sessionResources.isSessionIdle` 与第 4.5 节）：
 * 「非空闲」= queryEngine 在跑 / 正在压缩 / 有后台 Bash 任务 / 有非 idle 子代理 /
 * 正在等待用户确认。流水灯、abort 按钮都读它，不再有 `running` 概念。
 */
export interface SessionRuntimeState {
  sessionId: string;
  /** 会话是否空闲（true = 无任何在跑的工作）。非 idle 即「会话在忙」 */
  idle: boolean;
  /** 正在等待用户操作（ask user / 权限确认）——流水灯显示黄色 */
  waiting: boolean;
}

// ==================== 通用 ====================

/** 取消订阅 */
export type Unsubscribe = () => void;

// ==================== 总线接口 ====================

/**
 * 事件总线：core 与 UI 的唯一耦合点。
 *
 * 发布（emit*）与订阅（on*）刻意分成两组，让「谁在发、谁在收」在类型层面可见：
 * - `emitToUi` / `request`：core 侧调用
 * - `onCoreEvents` / `onCoreRequests`：UI 侧调用（批量注册，穷尽检查）
 * - `emitToCore` / `onUiEvent`：反方向
 */
export interface AssistantEventBus {
  // ===================== core → UI =====================

  /** 发布单向事件 */
  emitToUi(event: CoreEvent): void;

  /**
   * 发起请求并等待响应。
   * 泛型约束请求类型与结果类型一一对应，调用点无需手动收窄：
   *
   * ```ts
   * const permission = await bus.request({
   *   type: 'toolPermissionRequested', sessionId, toolUseId, toolName, permResult, displayArgs,
   * });  // permission: PermissionResult
   * ```
   */
  request<T extends CoreRequest['type']>(
    request: Extract<CoreRequest, { type: T }>,
  ): Promise<CoreRequestResultMap[T]>;

  /**
   * UI 侧：一次性注册全部 core 事件处理器。
   * `CoreEventHandlers` 是映射类型，少写任何一个 `CoreEvent['type']` 都会编译报错。
   * 重复调用抛错（重复注册说明 bootstrap 接线错误，启动期暴露）。
   */
  onCoreEvents(handlers: CoreEventHandlers): Unsubscribe;

  /** UI 侧：一次性注册全部 core 请求处理器（同上，穷尽检查） */
  onCoreRequests(handlers: CoreRequestHandlers): void;

  // ===================== UI → core =====================

  /** UI → core：发布单向事件。某 type 暂无 core 订阅者时静默丢弃（合法中间态） */
  emitToCore(event: UiEvent): void;

  /** core 侧：订阅自己关心的 UI 事件（core 是分散消费者，逐个订阅） */
  onUiEvent<T extends UiEvent['type']>(
    type: T,
    handler: (event: Extract<UiEvent, { type: T }>) => void,
  ): Unsubscribe;

  // ===================== UI → core 请求 =====================

  /**
   * UI 侧：发起请求并等待 core 的响应。
   *
   * 与 `request()` 对称；Embedded 下退化为一次同进程调用。
   */
  requestCore<T extends UiRequest['type']>(
    request: Extract<UiRequest, { type: T }>,
  ): Promise<UiRequestResultMap[T]>;

  /** core 侧：一次性注册全部 UI 请求处理器（穷尽检查，重复注册抛错） */
  onUiRequests(handlers: UiRequestHandlers): void;
}

/**
 * core 事件的处理器表。
 * 映射类型天然穷尽：漏掉任何一个 `CoreEvent['type']` 都会编译报错——
 * 这是保住「UI 不漏接事件」的唯一手段。
 */
export type CoreEventHandlers = {
  readonly [K in CoreEvent['type']]: (event: Extract<CoreEvent, { type: K }>) => void;
};

/** core 请求的处理器表（返回值类型由 `CoreRequestResultMap` 约束） */
export type CoreRequestHandlers = {
  readonly [K in CoreRequest['type']]: (
    request: Extract<CoreRequest, { type: K }>,
  ) => Promise<CoreRequestResultMap[K]>;
};

/** UI 请求的处理器表（返回值类型由 `UiRequestResultMap` 约束） */
export type UiRequestHandlers = {
  readonly [K in UiRequest['type']]: (
    request: Extract<UiRequest, { type: K }>,
  ) => Promise<UiRequestResultMap[K]>;
};

// ==================== 全局注册 ====================

/** 全局总线实例；未注册时直接抛错，不用 `?.` 静默跳过 */
let globalEventBus: AssistantEventBus | undefined;

/** 注册全局总线。重复注册抛错（bootstrap 接线错误应在启动期暴露） */
export function setGlobalEventBus(bus: AssistantEventBus): void {
  if (globalEventBus) {
    throw new Error('AssistantEventBus already registered. setGlobalEventBus() must be called once.');
  }
  globalEventBus = bus;
}

/**
 * 获取全局总线；未初始化时直接抛错。
 *
 * core 内部模块之间通过 `requireEventBus()` 发事件，不直接调用 UI 的任何方法；
 * 未初始化直接失败，把「总线未注册」这类集成缺失在启动期暴露，
 * 而不是伪装成「什么都没发生」。
 */
export function requireEventBus(): AssistantEventBus {
  if (!globalEventBus) {
    throw new Error('AssistantEventBus not initialized. Call setGlobalEventBus() first.');
  }
  return globalEventBus;
}

/** 测试用：清空全局总线 */
export function resetGlobalEventBus(): void {
  globalEventBus = undefined;
}

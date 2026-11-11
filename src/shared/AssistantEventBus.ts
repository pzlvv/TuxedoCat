/**
 * AssistantEventBus - core 与 UI 的唯一耦合点（事件契约）
 *
 * core 与 UI 不互相引用，只通过总线上的事件耦合：
 * - core 发 CoreEvent / CoreRequest，订阅 UiEvent；
 * - UI（WebViewUI）订阅 CoreEvent / CoreRequest，发 UiEvent。
 * 事件类型是两边唯一的公共词汇表。
 *
 * 事件命名约定（见 docs/architecture/events.md 第 2 节）：
 * - CoreEvent / CoreRequest 的 type = 处理器方法名去掉 on 前缀
 * - UiEvent 的 type 是过去式，描述用户已经做完的动作
 *
 * 边界语义（见 docs/architecture/events.md 第 6 节）：
 * - emitToUi 时 onCoreEvents 尚未注册 → 抛错（bootstrap 顺序错误，启动期暴露）
 * - emitToCore / onUiEvent 对某 type 尚无 core 订阅者 → 静默丢弃（合法中间态）
 * - request() 无内置超时：响应方不存在 / 响应丢失会永久挂起；
 *   当前两个请求都不设超时，调用点自行决定兜底
 */

import type { Message, MessageData, StreamMessageData, StreamEndData, TodoEntry } from './types.js';
import type { AgentMode } from './types.js';
import type { ModelRef } from './llm/modelRef.js';
import type { PermissionResult, ToolProgressData } from './tools/Tool.js';
import type { UserChoiceOptions, UserChoiceResult } from './UserChoiceQueue.js';
import type { ConversationMetadata } from './history/Conversation.js';
import type { SessionCreator } from './sessionCreator.js';
import type { ConversationSpaceInfo } from './webviewTypes.js';
import type { McpServerDefinition, SettingsSnapshot, ThinkingEffort } from './settingsSnapshot.js';
import type { McpServerInfo } from './webviewTypes.js';
import type { NoticeLevel, NoticeParams } from './coreText.js';
import type { SpinDesign } from './spin/Types.js';
import type { DirectoryEntry } from './DirectoryEntry.js';

// ==================== core → UI：单向事件 ====================

/**
 * core 发给 UI 的单向事件。
 *
 * 不按「渲染 / 控制」再分组：事件是纯数据，分组只会多一层没有语义的包装；
 * 「谁来处理」由订阅方（WebViewUI）在 `onCoreEvents` 里决定，
 * 逐事件的触发点与处理见 docs/architecture/events.md 第 2 节。
 */
export type CoreEvent =
  /**
   * Core 已就绪（处理完 `hostEnvironmentProvided`，`docs/architecture/core-ui-separation.md` 第 7 节）。
   *
   * 每次应用配置快照后都发一次（首次握手、以及后续每次重新推送快照），
   * 宿主据此判定「Core 已跟上最新配置」。Core 侧的就绪状态本身是幂等的。
   */
  | { type: 'coreReady' }
  | { type: 'message'; sessionId: string; data: MessageData }
  /**
   * 对话级回退完成（specs/039 FR-006）：`conversationRewound` 的处理结果。
   *
   * 截断后的消息序列经既有 `messagesReplaced` 整批下发，这条事件只带结果摘要
   * （删了多少条、哪些文件恢复了 / 跳过 / 失败），UI 据此提示。`error` 非空表示
   * 整次回退被拒（目标不存在 / 末节点 / 会话未空闲），此时消息与文件都没有变化。
   */
  | {
      type: 'conversationRewoundDone';
      sessionId: string;
      targetUuid: string;
      removed: number;
      files: Array<{ path: string; ok: boolean; error: string | null }>;
      skipped: string[];
      hadBash: boolean;
      error: string | null;
    }
  | { type: 'streamMessage'; sessionId: string; data: StreamMessageData }
  | { type: 'streamEnd'; sessionId: string; data: StreamEndData }
  | {
      type: 'toolCall';
      sessionId: string;
      toolUseId: string;
      toolName: string;
      /** 该卡片所属 JSONL 行的 uuid（specs/039 FR-001）：时间线回退的节点身份 */
      messageUuid: string;
    }
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
  | { type: 'sessionCreated'; sessionId: string }
  /** 对话列表（磁盘元数据）发生变化：落盘 / 改名 / 删除 / 新建 */
  | { type: 'conversationListChanged' }
  /**
   * 对话空间清空完成（`UiEvent.conversationSpaceCleared` 的执行回执）。
   *
   * `dirName` 是对话空间目录名（与同名 UiEvent 同语义）。结果是判别联合：
   * 成功带删除统计，失败带原因。webview 设置面板靠这条回执解除「删除中」，
   * 成功与失败都必须发出（UiEvent 是 fire-and-forget，这是唯一的完成信号）。
   */
  | {
      type: 'conversationSpaceCleared';
      dirName: string;
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
  /**
   * 某会话的 Todo 清单变了（`docs/features/todo-list.md` FR-002）。
   *
   * 推**全量清单**而不是增量：清单是几十条的量级，全量让消费者不必自己维护状态表；
   * 空数组即「该会话没有 Todo」。事实由 core 持有（`TodoWrite` 成功即写表），
   * 按需索取走 `UiRequest.sessionTodosRequested`——两条路径落到 webview 的同一个状态。
   */
  | {
      type: 'todosChanged';
      sessionId: string;
      todos: readonly TodoEntry[];
    }
  /**
   * 远程工作区中被监听文件发生变化（specs/018 FR-002）。
   *
   * core 是远端文件监听的唯一 owner：宿主注册 / 注销监听，core 只上报事实。
   * 事件只带路径与元数据，**不带文件内容**——宿主收到 `changed` 后自行读取内容，
   * 大文件不占用帧通道。`watchId` 由宿主生成，用于把事件路由回唯一查看器窗口；
   * 已注销的迟到事件由宿主按 `watchId` 丢弃。
   *
   * `kind: 'error'` 时 `error` 非空，其余情况为 `null`（契约不使用可选字段）。
   */
  | {
      type: 'workspaceFileChanged';
      watchId: string;
      path: string;
      kind: 'changed' | 'deleted' | 'error';
      mtimeMs: number;
      size: number;
      error: string | null;
    }
  | { type: 'spinDesignDataChanged' }
  /**
   * 会话工作模式变化（进入 spin）。
   *
   * core 的 `SessionState.work_mode` 是唯一事实：`/spin` 进入 spin 时写入；spin 单向，
   * 循环结束（完成 / 中止 / 失败）与恢复出的 spin 态都不再退出。UI 据此禁用主输入框
   * （specs/016 FR-004）。
   */
  | {
      type: 'workModeChanged';
      sessionId: string;
      workMode: 'normal' | 'spin';
    }
  /**
   * 本条消息里用到了哪些高亮语言（围栏代码块语言）。
   *
   * core 只做「从消息里扫出来」这一件事，**不维护已记录集合**：`highlightLanguages`
   * 是 UI 专属字段（`docs/architecture/core-ui-separation.md` 第 4.9 节），去重与上限由宿主的
   * `highlightLanguagesMutator` 承担，写盘走 `UIHost.updateSettingsJson`。
   * 因此同一语言可能被重复上报，宿主按幂等处理。
   */
  | { type: 'highlightLanguagesUsed'; languages: readonly string[] }
  | { type: 'compactBegin'; sessionId: string }
  | {
      type: 'compactEnd';
      sessionId: string;
      /** 压缩结果：成功带压缩后上下文占用的重算值（core 按压缩产物以运行时同款口径重算，与写回 meta.json 的 totalContextTokens 同值），失败不带（错误详情走 message 事件） */
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
   * 跨工作区子代理的回复投递请求（specs/023 FR-003）。
   *
   * 由目标工作区 Core 发出：跨工作区子代理调用 `Reply` 时，目标会话不在本进程内。
   * `sessionId` 是发起方会话 id，宿主按它路由到发起方 Connection，再以
   * `UiEvent.agentReplyReceived` 回投；`fromSessionId` 是子代理自己的会话 id。
   */
  | {
      type: 'crossWorkspaceAgentReplyRequested';
      sessionId: string;
      fromSessionId: string;
      content: string;
    }
  /**
   * 跨工作区子代理的中止请求（specs/023 FR-006）。
   *
   * 发起方 Core 的 `abort_session_scope` 对远程子代理发本事件（`sessionId` 是远程子代理
   * 的会话 id）；宿主按 link 表找到目标 Connection 后下发 `UiEvent.abortRequested`。
   */
  | { type: 'crossWorkspaceAgentAbortRequested'; sessionId: string }
  /**
   * 跨工作区子代理结束（完成 / 中止 / 失败）（specs/023 FR-010）。
   *
   * `sessionId` 是发起方会话 id（宿主据此路由），`subSessionId` 是目标工作区里的子代理
   * 会话 id；发起方 Core 收到后注销远程登记、释放并发槽位并刷新运行时快照。
   */
  | { type: 'crossWorkspaceAgentEnded'; sessionId: string; subSessionId: string }
  /**
   * 瞬时状态提示（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
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
  | { type: 'userChoice'; sessionId: string; options: UserChoiceOptions }
  /**
   * 跨工作区派发子代理（specs/023 FR-002；specs/025 FR-005）。
   *
   * 发起方 Core 在 `Agent` 带 `target` 时发出并阻塞等待；宿主按身份找到目标工作区
   * Connection、在目标 Core 建子代理会话后返回新会话 id。`sessionId` 是发起方会话。
   * `agentMode` 起各项是发起方会话**当前的生效值**（发起方 Core 解析，目标侧不再回落
   * 默认值）；提示词模式不随派发携带——跨工作区会话恒 normal（specs/025 FR-005）。
   */
  | {
      type: 'crossWorkspaceAgentRequested';
      sessionId: string;
      targetWorkspaceId: string;
      role: string;
      prompt: string;
      description: string;
      /** 发起方会话生效的 agent mode（specs/024 FR-004） */
      agentMode: AgentMode;
      /** 发起方会话生效的思考强度 */
      thinkingEffort: ThinkingEffort;
      /** 发起方会话生效的模型（经 `config::resolve_provider` 解析为具体值） */
      model: string;
      provider: string;
      /** 发起方会话生效的联网搜索开关 */
      webSearch: boolean;
      /** 发起方会话生效的 MCP 启用名单（server 名单；空名单合法） */
      mcpServers: string[];
    }
  /**
   * 跨工作区文件传输（specs/028 FR-002）。
   *
   * 发起方 Core 在 `Transfer` 工具执行时发出并阻塞等待；宿主解析两端工作区身份、
   * 执行传输后返回统计或错误。`sessionId` 是发起方会话；`sourceTarget` / `destTarget`
   * 的 `null` 表示该端缺省 = 发起会话所属工作区（契约成员必选，缺省语义用 `null`）。
   */
  | {
      type: 'crossWorkspaceTransferRequested';
      sessionId: string;
      sourcePath: string;
      targetPath: string;
      /** null = 发起会话所属工作区（缺省端） */
      sourceTarget: string | null;
      destTarget: string | null;
    };

/** 请求 → 结果的类型映射（判别联合，字段完整） */
/**
 * 本 Core 的文件存储能力（`UiRequest.storageCapabilitiesRequested`，specs/045 FR-001）。
 *
 * 两个字段都必选：`reason` 在能力可用时为空串（不是 `null`——「没有原因」用空串表达，
 * 与其它能力应答同一口径）。
 */
export interface StorageCapabilities {
  /** 能否为对话建立隔离工作视图（overlay：磁盘为基线 + 对话私有上层）。 */
  isolatedWorkView: boolean;
  /** 不可用的原因；可用时为空串。 */
  reason: string;
}

/**
 * Overlay 对话的目录列举结果（`UiRequest.workViewFilesRequested`，specs/046 FR-002）。
 *
 * 判别联合而不是可选字段：失败必带 `error`、成功必带 `entries`，渲染层不用双重判空。
 * 与 `electron/sidebarFiles.ts::listDirectory` 的本地回执同形——侧栏对两条来源的处理
 * 因此完全一致。
 */
export type WorkViewFilesResult =
  | { ok: true; entries: DirectoryEntry[] }
  | { ok: false; error: string };

/**
 * Overlay 对话的变更清单条目（`UiRequest.workViewChangesRequested`，specs/047 FR-001）。
 *
 * 形态与侧栏磁盘口径的 `DocEntry` 同构：`path` 是工作区相对的 '/' 分隔路径，行数徽标
 * 由界面直接渲染，渲染层不区分来源。
 */
export interface WorkViewChangeEntry {
  path: string;
  plus: number;
  minus: number;
}

/**
 * Overlay 对话的变更清单结果（`UiRequest.workViewChangesRequested`，specs/047 FR-001 / FR-002）。
 *
 * `not-a-git-workspace` 是**事实**而不是界面文案：Core 只说「这里没有 git 口径」，
 * 显示什么由界面决定（[docs/architecture/principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)）。
 * 失败必带 `error`、成功必带 `entries`，渲染层不用双重判空。
 */
export type WorkViewChangesResult =
  | { ok: true; entries: WorkViewChangeEntry[] }
  | { ok: false; kind: 'not-a-git-workspace' | 'error'; error: string };

/**
 * Overlay 对话里某个文件的两侧原文（`UiRequest.workViewFileDiffRequested`，specs/047 FR-004）。
 *
 * `after` 是视图内容、`before` 是视图里 HEAD 的版本（`null` = 该文件没有 HEAD 版本，
 * 即「新增」）。三个事实来自同一次取数：内容 / 是否新增 / 能否显示变更，调用方不必
 * 再发一次「读内容」。
 *
 * `not-a-git-workspace` 时只有内容（没有 HEAD 这个概念），查看器的变更按钮因此不可用。
 * 二进制（图片 / 压缩包 / 可执行文件）在 Overlay 对话里不支持打开——系统应用打不开视图
 * 里的路径，回错误比打开磁盘上的旧内容诚实。
 */
export type WorkViewFileDiffResult =
  | { ok: true; kind: 'not-a-git-workspace'; after: string }
  | { ok: true; kind: 'git'; before: string | null; after: string }
  | { ok: false; error: string };

export type CoreRequestResultMap = {
  toolPermissionRequested: PermissionResult;
  userChoice: UserChoiceResult;
  /**
   * 成功带目标工作区里的子代理会话 id；`local` 表示 target 就是当前工作区，
   * 由 Core 按缺省策略建本机子代理；失败带原因（不创建任何会话）。
   */
  crossWorkspaceAgentRequested: { sessionId: string } | { local: true } | { error: string };
  /**
   * 成功带传输统计与宿主解析后的两端身份（结果文本用）；失败带原因，
   * 两端零写入（specs/028 FR-002 / FR-003）。`paths` 是已搬运文件的相对路径
   * （相对被传输的子树根，POSIX 分隔符），供工具卡片展示清单（specs/042 FR-001）。
   */
  crossWorkspaceTransferRequested:
    | {
        files: number;
        bytes: number;
        skippedSymlinks: number;
        sourceWorkspaceId: string;
        destWorkspaceId: string;
        paths: string[];
      }
    | { error: string };
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
      /**
       * 宿主当前**活动**工作目录。会话工作目录的正规登记入口是
       * `sessionWorkspaceAssigned`（Core 侧读取方也是它）；本字段只服务
       * Standalone 的重启恢复——Core 重启后会话工作目录表丢失，消息进入时由
       * Core 据此兜底登记（`engine.rs` 的 `on_user_message`，仅在该会话尚未登记时生效）。
       */
      workspacePath?: string;
      /**
       * 宿主本次不做乐观回显（会话忙碌排队、或 `/` 开头的命令消息）时置 true：
       * 由 core 在消息真正进入 LLM 上下文时补发用户气泡；未置位时宿主已乐观回显，
       * core 不再补发。
       * （`Integration.submitUserMessage` 判定），Standalone 走 `engine::emit_user_message_to_ui`，
       * 两侧同语义。
       */
      deferEcho?: boolean;
    }
  | { type: 'abortRequested'; sessionId: string }
  /**
   * 用户请求把某台**正在前台运行**的 Bash 命令转入后台（Bash 卡片「转后台」按钮）。
   *
   * core 侧由引擎触发 `tools/bash/ManualBackground` 注册表里该 `toolUseId` 的
   * 转换；转换成功后暂停下一轮 LLM 请求（结果照常进上下文）。没有匹配的
   * 前台执行时幂等忽略（规格见 `docs/features/background-bash.md`）。
   */
  | { type: 'bashBackgroundRequested'; sessionId: string; toolUseId: string }
  /**
   * 用户撤回排队消息（webview 排队项的「编辑 / 删除」）。
   *
   * `uuid` 是排队项携带的消息 uuid：core 按 uuid 配对，只丢弃引擎队列里尚未消费的
   * 同一消息；已被消费（进入上下文）或被更新的排队消息替换时不动，也不打断正在
   * 运行的查询（`docs/features/user-message-pipeline.md` FR-003）。
   */
  | { type: 'queuedMessageDiscarded'; sessionId: string; uuid: string }
  /**
   * 失败 once 通知上的「重试」（specs/036 FR-003）。
   *
   * core 以既有上下文重跑一轮查询：失败轮次的用户消息已落盘、已在上下文里，重试
   * 不追加、不落盘任何新输入。会话忙碌 / spin / 已收尾子代理时幂等丢弃（core 侧
   * 守卫，与 `bashBackgroundRequested` 无匹配时同口径）——按钮可见时会话必为空闲，
   * 丢弃只兜多视图与提交时序的竞态。
   */
  | { type: 'queryRetryRequested'; sessionId: string }

  // ===== 压缩 =====
  /** 用户触发压缩（会改写会话数据，属 core 业务） */
  | { type: 'compactRequested'; sessionId: string }

  // ===== 会话生命周期 =====
  /**
   * 新会话建立。
   *
   * 只携带 `sessionId`：会话归属的工作目录由宿主先经 `sessionWorkspaceAssigned`
   * 登记（`WebviewMessageHandler.handleStartNewConversation` 先登记再发本事件），
   * core 按会话解析，不从本事件读取。Standalone Core 不发本事件（见 docs/core/core-parity.md）。
   */
  | {
      type: 'conversationStarted';
      sessionId: string;
      /**
       * 会话的文件存储归属（specs/045 FR-001）：`workspace` = 工具与 Bash 直接操作真实
       * 工作区；`isolated` = 落在本对话私有的叠加工作视图上（`lowerdir` 是真实工作区，
       * `upperdir` 是本对话的改动，对话之间互不可见）。创建时一次写定，之后不变。
       * 宿主必须显式给出——缺失按 `workspace`（存量会话口径）。
       */
      storage: 'workspace' | 'isolated';
    }
  /**
   * 改会话的文件存储归属（specs/045 FR-001）。
   *
   * 只对「新建对话、还没有任何消息」生效：勾选框在 `conversationStarted` 之后才渲染，
   * 用户勾选的时刻晚于创建，必须补发一次归属变更。core 按「meta.json 已存在即忽略」
   * 拒绝改动（`docs/core/conversation-work-view.md` 第 2 节），归属因此仍是一次写定。
   */
  | {
      type: 'storageChanged';
      sessionId: string;
      storage: 'workspace' | 'isolated';
    }
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
   * `dirName` 是对话空间目录名（不是会话 id）。执行结果经
   * `CoreEvent.conversationSpaceCleared` 回执。
   */
  | { type: 'conversationSpaceCleared'; dirName: string; mode: 'clear' | 'remove' }

  // ===== 会话配置 =====
  | { type: 'modelChanged'; sessionId: string; ref: ModelRef }
  | { type: 'thinkingEffortChanged'; sessionId: string; mode: 'off' | 'low' | 'high' | 'max' }
  | { type: 'promptModeChanged'; sessionId: string; mode: 'normal' | 'minimal' | 'mixed' }
  | { type: 'agentModeChanged'; sessionId: string; mode: AgentMode }
  | { type: 'webSearchChanged'; sessionId: string; enabled: boolean }
  | { type: 'mcpEnabledChanged'; sessionId: string; name: string; enabled: boolean }
  /**
   * 整表覆盖某个会话的 MCP 启用列表（去重、保留首次出现顺序，不做增量）。
   *
   * 与 `mcpEnabledChanged` 的单开关语义相对：输入框菜单的勾选走前者，
   * 「把当前对话的启用列表整体写成某个已知列表」走这里（设置面板保存默认值时
   * 先把当前对话钉在它当前的列表上；用户确认应用新默认值后再整体覆盖）。
   */
  | { type: 'mcpEnabledListChanged'; sessionId: string; names: string[] }

  // ===== 其它 =====
  /**
   * 用户请求把某个 Edit / Write 操作回滚到修改前 / 后。
   *
   * `filePath` 是目标 tool_use 的 `input.file_path` 缺失时的兜底路径：
   * provider 偶发把整个入参 double-encode 成字符串，磁盘上的 `input` 不是对象，
   * core 取不到 `file_path`，此时用 UI 侧归一化后的 args.file_path 兜底。
   */
  | { type: 'editRolledBack'; sessionId: string; toolUseId: string; direction: string; filePath?: string }
  /**
   * 从时间线某个节点「从这里继续」（specs/039）：截断该节点之后的消息并回滚区间内的文件。
   *
   * `targetUuid` 是会话 JSONL 行的 `uuid`（webview 从展示消息的 `messageUuid` 取）。
   * 截断与文件恢复都在 core 里做——UI 不自己算新消息序列（一份事实一个写入点）。
   */
  | { type: 'conversationRewound'; sessionId: string; targetUuid: string }

  // ===== 宿主环境与配置 =====
  /**
   * 宿主环境与配置快照（连接建立后由 UI 发一次）。
   *
   * 宿主固有差异 + 配置快照一次给齐（`docs/architecture/core-ui-separation.md` 第 3.2 节）：
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
       * Core 用它作本机开发期定位产物的兜底；
       * Standalone Core 的自带资源以**自己的可执行文件目录**为基准（与可执行文件同级的
       * `ripgrep/`），这里只作本机开发期的兜底（`docs/core/standalone-core.md` 第 4 节）。
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
      /**
       * 宿主是否支持跨工作区代理（specs/023 FR-009）。
       *
       * Electron 为 true；VS Code / TUI 为 false。Core 据此决定是否解析 `@` 命令、
       * 注入 reminder，以及是否接受 `Agent.target`——不做宿主类型嗅探。
       */
      crossWorkspaceAgent: boolean;
      /**
       * 宿主是否支持跨工作区文件传输（specs/028 FR-005）。
       *
       * Electron 为 true；VS Code / TUI 为 false。只作用于 `Transfer` 工具的执行
       * （位假时调用报「当前宿主不支持」）；工具定义与提示词恒定注入，不随本位收敛。
       */
      crossWorkspaceTransfer: boolean;
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
   * 宿主侧
   * 这张表在 Core 进程内，宿主必须经事件交给 Core。多工作目录的宿主在打开 / 切换 /
   * 重命名会话时用它把会话自己的目录告诉 core，core 据此解析工具的相对路径。
   */
  | {
      type: 'sessionWorkspaceAssigned';
      sessionId: string;
      /** `null` 表示清除该会话的登记（回退到活动工作目录） */
      workspacePath: string | null;
    }
  // ===== 跨工作区子代理（specs/023）=====
  /**
   * 在目标工作区创建一个跨工作区子代理对话并立即开始执行（specs/023 FR-003；
   * specs/025 FR-001——顶层普通会话，无 `parentSessionId`）。
   *
   * 由宿主在 `CoreRequest.crossWorkspaceAgentRequested` 的处理里直接下发到目标
   * Connection（不按 sessionId 路由——该会话在目标 Core 里尚不存在）。`origin*`
   * 记录发起方工作区身份与会话，目标 Core 据此写 `creator`（specs/025 FR-002）并
   * 组装 SystemPrompt（specs/025 FR-006）。`agentMode` 起各项是发起方会话的生效设置，
   * 目标 Core 全量应用（specs/025 FR-005）；提示词模式不携带——目标会话恒 normal。
   */
  | {
      type: 'remoteSubAgentStarted';
      sessionId: string;
      /** 目标工作区路径（目标 Core 据此登记会话工作目录） */
      workspacePath: string;
      role: string;
      prompt: string;
      description: string;
      originWorkspaceId: string;
      originSessionId: string;
      /** 发起方会话生效的 agent mode（specs/024 FR-004） */
      agentMode: AgentMode;
      /** 发起方会话生效的思考强度 */
      thinkingEffort: ThinkingEffort;
      /** 发起方会话生效的模型 */
      model: string;
      provider: string;
      /** 发起方会话生效的联网搜索开关 */
      webSearch: boolean;
      /** 发起方会话生效的 MCP 启用名单（server 名单；空名单合法） */
      mcpServers: string[];
    }
  /**
   * 跨工作区子代理的回复到达发起方会话（specs/023 FR-003）。
   *
   * 宿主把目标 Core 的 `CoreEvent.crossWorkspaceAgentReplyRequested` 翻译成本事件，
   * 按 `sessionId`（发起方会话）路由；`fromSessionId` 是远程子代理会话 id。
   */
  | { type: 'agentReplyReceived'; sessionId: string; fromSessionId: string; content: string }
  /**
   * 跨工作区子代理结束（specs/023 FR-010）：发起方 Core 注销远程登记、释放并发槽位。
   */
  | { type: 'crossWorkspaceAgentCompleted'; sessionId: string; subSessionId: string };

// ==================== UI → core：请求-响应 ====================

/**
 * 需要 core 返回结果的请求（`CoreRequest` 的反方向）。
 *
 * 宿主不直接读取 core 的磁盘数据（`docs/core/standalone-core-boundaries.md` 第 2 节）：需要
 * 「core 的事实」时由宿主发起请求、Core 应答。
 * 请求退化为一次函数调用，结果一致。
 *
 * 边界语义与 `request()` 相同：无内置超时，调用点自行兜底；应答方不存在时
 * 静默挂起（`StandaloneEventBus` 在 Core 断开时以错误结束挂起的请求）。
 */
export type UiRequest =
  /** 对话列表元数据（`loadConversationList` 的等价物） */
  | { type: 'conversationListRequested'; workspacePath?: string }
  /**
   * 本 Core 的文件存储能力（specs/045 FR-001）。
   *
   * 宿主据此决定是否渲染「Overlay 对话」入口。能力由 Core 判断——宿主平台回答不了
   * 这个问题（Windows 宿主连 Linux 远端 Core 时宿主不是 Linux，但 Core 是）。
   */
  | { type: 'storageCapabilitiesRequested' }
  /**
   * 列 Overlay 对话的叠加视图目录（specs/046 FR-002）。
   *
   * 侧栏的文件资源管理器据此显示「这个对话看到的文件树」。必须经 Core：视图挂在 Core
   * 私有的挂载命名空间里（`docs/core/conversation-work-view.md` 第 4 节），宿主进程读
   * 挂载点得到的是空目录；直接读 `upper/` 也不成立（whiteout 让删掉的文件仍可见、
   * 未改动的文件在 `lowerdir` 看不到）。
   *
   * `dir` 是 '/' 分隔的相对路径，`''` 表示视图根；越界（绝对路径 / `..`）由 Core 拒绝。
   * 视图尚未建立时回 `ok: false`——由宿主决定显示磁盘基线还是报错，Core 不替它决定。
   */
  | { type: 'workViewFilesRequested'; sessionId: string; dir: string }
  /**
   * 列 Overlay 对话视图里相对 HEAD 的改动（specs/047 FR-001）。
   *
   * 磁盘上的 git 看不到本对话的改动（改动只落私有上层目录），因此变更清单必须由 Core
   * 在视图里跑 git 得到。`scope` 与侧栏的 `ChangeScope` 同一判别值：`doc` 只看 Markdown、
   * `all` 不限定类型——两者只差 pathspec，解析与过滤完全同一份。
   *
   * 视图尚未建立、git 不可用、工作区不在 git 仓库内都回失败侧（`kind` 区分两种事实）；
   * 不回退成磁盘的变更清单，那会把两个来源的行集混成一个。
   */
  | { type: 'workViewChangesRequested'; sessionId: string; scope: 'doc' | 'all' }
  /**
   * 取 Overlay 对话里某个文件的两侧原文（specs/047 FR-004）。
   *
   * `path` 是 '/' 分隔的相对路径（不能是视图根）。`after` 来自视图、`before` 来自视图里
   * 的 HEAD（`null` = 新增）。宿主读不到 Core 的挂载命名空间，也读不到视图里的 `.git`，
   * 因此这一对原文只能由 Core 给出。
   */
  | { type: 'workViewFileDiffRequested'; sessionId: string; path: string }
  /** 智能命名：读会话消息 + 调 LLM + 解析标题（`history/smartNaming` 的等价物） */
  | { type: 'smartNamingRequested'; sessionId: string }
  /**
   * DeepSeek 账户余额（`utils/balance` 的等价物）；未配置 api.deepseek.com 时为 `null`。
   * `sessionId` 用于多 Connection 路由（余额按各自 Core 的配置快照查询）。
   */
  | { type: 'balanceRequested'; sessionId?: string }
  /**
   * 压缩归档展开：各代归档 + 当前未压缩部分合并成的**完整**展开序列，附带每代的起始下标
   * （`docs/features/compaction.md` FR-005）。返回 `null` 表示该会话没有归档。
   *
   * 展开到第几层由 UI 决定：宿主只把这条序列交给 webview，webview 按层级取尾部。
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
   * 某会话当前的 Todo 清单（`docs/features/todo-list.md` FR-002）。
   *
   * 事实由 core 持有：表里有就直接给，没有就按会话文件里最后一条成功的 `TodoWrite`
   * 重建后写表再给。会话文件不存在时返回空数组（「没有 Todo」与「读不到」同口径）。
   * 变更时另有 `CoreEvent.todosChanged` 推送——两条路径落到同一个 webview 状态。
   */
  | { type: 'sessionTodosRequested'; sessionId: string }
  /**
   * 斜杠命令与技能列表（内置命令 + 内置技能 + 会话工作目录下的技能）。
   * `sessionId` 决定项目技能扫描的工作目录；缺省时只列内置项。
   */
  | { type: 'skillsRequested'; sessionId?: string }
  /**
   * Spin 设计器数据：`spin.json` 内容 + 设计器技能清单。
   *
   * `sessionId` 决定目标机器上的会话工作目录（Core 自己所在机器的
   * `~/<CONFIG_DIR_NAME>/conversations/<encoded-project>/spin.json`）。
   * `data: null` 表示该会话没有设计文件；读取 / 解析失败用 `status: 'error'` 表达。
   */
  | { type: 'spinDesignRequested'; sessionId: string }
  /**
   * 保存 Spin 设计：Core 按 `sessionId` 的会话工作目录在自己所在机器落盘，
   * 与 SpinLoop 的节点 meta 更新共用同一把写锁。
   */
  | { type: 'spinDesignSaveRequested'; sessionId: string; data: SpinDesign }
  /**
   * 注册远程工作区文件监听（specs/018 FR-002 / FR-003）。
   *
   * `watchId` 由宿主生成并贯穿注册与事件；`workspacePath` 用于宿主侧按工作区路由到
   * 对应 Connection；`path` 是目标机器上的绝对路径，必须落在 `workspacePath` 内。
   * 注册失败（越界 / 权限 / 监听上限）用 `{ ok: false, error }` 如实回报。
   */
  | {
      type: 'watchWorkspaceFileRequested';
      watchId: string;
      workspacePath: string;
      path: string;
    }
  /** 注销远程工作区文件监听；`workspacePath` 用于宿主按工作区路由到对应 Connection，未知 `watchId` 按已注销处理（幂等） */
  | { type: 'unwatchWorkspaceFileRequested'; watchId: string; workspacePath: string };

/** 远程文件监听注册结果（`UiRequest.watchWorkspaceFileRequested`） */
export type WatchWorkspaceFileResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 压缩归档的展开序列（`UiRequest.compactArchiveRequested` 的应答，
 * `docs/features/compaction.md` FR-005）。
 *
 * 各代按代次升序拼接、按 `uuid` 去重后，再追加当前保留区——这是「展开到全部代次」的
 * 完整显示序列；宿主按 `generationStarts` 分段转换成显示消息，webview 按展开层级取尾部。
 */
export interface CompactArchiveDisplay {
  /** 完整展开序列（各代按代次升序 + 当前保留区，已按 `uuid` 去重） */
  messages: Message[];
  /**
   * 每代第一条记录在 `messages` 里的下标，按代次升序、单调不减；长度即归档代次数。
   *
   * 第 `i` 代的第一条通常是上一代的摘要（同一条消息只保留首次出现），因此分界落在它上面：
   * 展开到第 `depth` 层时从 `generationStarts[length - depth]` 开始显示。
   */
  generationStarts: number[];
}

/** 会话加载结果（`UiRequest.conversationLoadRequested`） */
export interface LoadedConversation {
  messages: Message[];
  metadata: ConversationMetadata | null;
  /**
   * 仍在等待权限 / 执行的工具调用 id。
   * 由 Core 在加载时合成取消结果，恒为空。
   */
  pendingToolUseIds: string[];
  /** 是否存在压缩归档 */
  hasCompactArchive: boolean;
  /** 会话的询问模式（core 的权威取值；无记录为 null） */
  agentMode: AgentMode | null;
  /**
   * 会话工作模式（meta.json 的 `workMode`，缺省 normal；specs/016 FR-005）。
   * spin = spin 模式会话（执行中或执行中断后恢复），UI 据此恢复输入框禁用态。
   */
  workMode: 'normal' | 'spin';
}

/** 技能 / 命令列表项（`UiRequest.skillsRequested`） */
export interface SkillListItem {
  name: string;
  description: string;
  /** true = 内置斜杠命令；false = 技能（内置或项目目录） */
  isBuiltin: boolean;
}

/** Spin 设计器技能项（`UiRequest.spinDesignRequested`）：只含设计器要展示的字段 */
export interface SpinDesignSkill {
  name: string;
  description: string;
}

/** Spin 设计器读取结果（`UiRequest.spinDesignRequested`） */
export type SpinDesignReadResult =
  | { status: 'ok'; data: SpinDesign | null; skills: SpinDesignSkill[] }
  | { status: 'error'; message: string };

/** Spin 设计器保存结果（`UiRequest.spinDesignSaveRequested`） */
export type SpinDesignSaveResult =
  | { status: 'ok' }
  | { status: 'error'; message: string };

/** 请求 → 结果的类型映射（判别联合，字段完整） */
export type UiRequestResultMap = {
  conversationListRequested: ConversationMetadata[];
  storageCapabilitiesRequested: StorageCapabilities;
  workViewFilesRequested: WorkViewFilesResult;
  workViewChangesRequested: WorkViewChangesResult;
  workViewFileDiffRequested: WorkViewFileDiffResult;
  smartNamingRequested: { title: string };
  balanceRequested: {
    totalBalance: number;
    currency: string;
    isUnlimited: boolean;
    fetchedAt: number;
  } | null;
  compactArchiveRequested: CompactArchiveDisplay | null;
  mcpServersRequested: McpServerInfo[];
  conversationSpacesRequested: ConversationSpaceInfo[];
  flushSessionRequested: null;
  conversationLoadRequested: LoadedConversation;
  sessionTodosRequested: TodoEntry[];
  skillsRequested: { skills: SkillListItem[] };
  spinDesignRequested: SpinDesignReadResult;
  spinDesignSaveRequested: SpinDesignSaveResult;
  watchWorkspaceFileRequested: WatchWorkspaceFileResult;
  unwatchWorkspaceFileRequested: null;
};

// ==================== 会话运行时状态 ====================

/**
 * 运行中的后台 Bash 任务快照（specs/019 FR-001）：`SessionRuntimeState.backgroundTasks`
 * 的元素。abort 按钮悬停明细据此展示任务身份；pid / 启动时刻等调度细节不进契约。
 */
export interface BackgroundTaskBrief {
  taskId: string;
  description: string;
  command: string;
}

/**
 * 单个会话的运行时状态。消费者：Electron 侧栏流水灯、系统托盘状态点、
 * webview 对话树的运行标记、两端的 abort 按钮。
 *
 * 只有 core 能提供的事实进这里；宿主自己的界面状态（如 Electron 的
 * 「视图已打开」）由宿主自己维护，不混进来。
 *
 * 契约只放**根事实**（``docs/architecture/principles.md` 第 8 节）：`queryRunning` / `waiting` / `compacting` /
 * `pendingCompact` / `backgroundRunning` / `subAgentRunning` 是各来源的事实，`idle` 是其余根事实的合取
 * （`pendingCompact` 不参与——排队不是正在执行的工作）。
 * 只关心「忙不忙」的消费者（流水灯 / 托盘）读 `idle`；要区分前台与后台的消费者
 * （abort 按钮三态，`docs/features/abort-button.md`）读根事实自己推导表现（``docs/architecture/principles.md` 第 6 节）。
 */
export interface SessionRuntimeState {
  sessionId: string;
  /**
   * 会话是否空闲（true = 无任何在跑的工作）。非 idle 即「会话在忙」。
   *
   * 派生字段：其余根事实（`queryRunning` / `waiting` / `compacting` /
   * `backgroundRunning` / `subAgentRunning`）全为假时才为真；`pendingCompact`
   * 不参与——排队不是正在执行的工作。保留它是为了让流水灯 / 托盘这类只关心
   * 「忙不忙」的消费者不必自己合取（``docs/architecture/principles.md` 第 8 节）。
   */
  idle: boolean;
  /** 正在等待用户操作（ask user / 权限确认）——流水灯显示黄色 */
  waiting: boolean;
  /** 前台查询 / 引擎在消费消息（abort 按钮红色态的判据之一） */
  queryRunning: boolean;
  /** 正在压缩上下文（会整体替换消息数组；与查询同属前台工作） */
  compacting: boolean;
  /**
   * 已登记手动压缩、等待下一轮对话开始时执行（`compact.rs` 的 `PENDING_COMPACT`）。
   * 不参与派生 `idle`：排队不是正在执行的工作。
   */
  pendingCompact: boolean;
  /**
   * 有运行中的后台 Bash 任务（abort 按钮黄色态的判据之一）
   */
  backgroundRunning: boolean;
  /**
   * 该会话运行中的后台 Bash 任务清单（specs/019 FR-001），按注册序；空集为 `[]`。
   * 与 `backgroundRunning` 同源（同一注册表、同一次 `emit_runtime` 产出），
   * abort 按钮黄色态的悬停明细据此列出任务（`docs/features/abort-button.md`）。
   */
  backgroundTasks: readonly BackgroundTaskBrief[];
  /**
   * 存在非 idle 的已登记子代理（递归到子代理自身的查询 / 压缩 / 后台任务 /
   * 下层子代理）。abort 按钮黄色态的判据之一。
   */
  subAgentRunning: boolean;
  /**
   * 子代理会话为创建时 Agent 工具调用的 description（specs/019 FR-001）；
   * 普通会话与恢复路径取不到时为 `null`，UI 对 `null` 显示回退文案。
   * abort 按钮黄色态的悬停明细据此列出子代理。
   */
  subAgentDescription: string | null;
  /**
   * 父会话 id（本地子代理会话才有；普通会话与跨工作区对话为 `null`）。登记于
   * 子代理创建时，随会话存续——不随 SubAgentRegistry 的注销消失（子代理完成一轮后
   * 仍留在注册表等 Reply，此时父子关系对消费者依然有意义）。
   *
   * 它是**树事实**（本地嵌套在哪）；「谁创建的」归属语义读 `creator`
   * （specs/025 FR-002），不得从本字段反推。
   */
  parentSessionId: string | null;
  /**
   * 会话创建者（specs/025 FR-002）：`user` = 用户 prompt 发起；agent 形态携带创建方
   * 工作区身份与会话 id。完成提醒 / 未读绿灯的抑制、输入禁用、`Reply` 回传路由与
   * 跨工作区跳转都以此为判据（specs/025 FR-003 / FR-004 / FR-007）。
   */
  creator: SessionCreator;
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
   * 与 `request()` 对称。
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

/**
 * QueryEngine - 管理会话状态和消息处理的主引擎
 */

import type { Message, MessageData } from './types.js';
import { extractUserContent } from './utils/contentBlocks.js';
import { query } from './Query.js';
import type { AbortControllerLike } from './tools/Tool.js';
import type { CoreEvent } from './AssistantEventBus.js';
import { requireEventBus } from './AssistantEventBus.js';
import { markQueryRunning } from './sessionRuntime.js';
import type { Tool } from './tools/Tool.js';
import type { LLMConfig } from './llm/config.js';
import type { ModelRef } from './llm/modelRef.js';
import type { PromptPresetId } from './prompt/PromptPreset.js';
import { getAllTools } from './tools/index.js';
import { logger } from './Logger.js';
import { isCompacting, isPendingCompact, markPendingCompact, unmarkPendingCompact } from './compact/state.js';
import { randomId } from './tools/RunTools.js';

/** core → UI 单向事件的发送侧封装（QueryEngine 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/**
 * 创建简单的 AbortController polyfill
 */
function createAbortController(): AbortControllerLike {
  // @ts-ignore
  if (typeof AbortController !== 'undefined') {
    // @ts-ignore
    return new AbortController();
  }
  return {
    signal: null,
    abort() { },
  } as AbortControllerLike;
}

export type WorkMode = 'normal' | 'spin';

/**
 * 排队消息（agentMessageQueue）的来源。
 *
 * - `subagent`：子代理 Reply 等真正的「来自子代理」的消息，UI 以代理身份展示并按
 *   markdown 渲染；
 * - `bash`：后台 Bash 任务完成通知，属于系统通知而非子代理回复，UI 以纯文本展示
 *   （不渲染 markdown、不带 From 头）。
 */
export type AgentMessageSource = 'subagent' | 'bash';

export interface QueryEngineConfig {
  cwd: string;
  tools: readonly unknown[];
  /** 会话角色，创建新会话时写入 meta.json，用于确定可用工具范围 */
  role?: string;
  getAppState: () => unknown;
  setAppState: (updater: (prev: unknown) => unknown) => void;
  initialMessages?: Message[];
  userSpecifiedModel?: string;
  maxTurns?: number;
  abortController?: AbortControllerLike;
  /** LLM 配置覆盖，不指定则使用 settings.json 中的配置 */
  modelConfig?: LLMConfig;
  /** 系统提示词，不指定则使用 generateStaticSystemPrompt() 自动生成 */
  staticSystemPrompt?: string;
  /** 会话标题，创建新会话时写入 meta.json */
  title?: string;
  /** 父会话 ID，创建新会话时写入 meta.json */
  parentSessionId?: string;
  /** 上游会话 ID（跨节点/跨会话消息投递的发起方） */
  upstreamSessionId?: string;
  /** 上游节点的主机名（跨节点 Reply 路由用） */
  upstreamHostname?: string;
  /** 上游节点的工作区路径（跨节点 Reply 路由用） */
  upstreamWorkspace?: string;
  /** 工作模式：normal（默认）| spin（主消息不发 LLM，由内部逻辑接管） */
  workMode?: WorkMode;
}

/**
 * QueryEngine 拥有查询的生命周期和会话状态
 * 一个 QueryEngine 实例对应一个对话
 */

// 全局会话引擎池
export const sessionEngines = new Map<string, QueryEngine>();

/**
 * 获取指定会话的 QueryEngine
 */
export function getSessionEngine(sessionId: string): QueryEngine | undefined {
  return sessionEngines.get(sessionId);
}

/**
 * 注册 QueryEngine 到全局引擎池
 */
export function registerSessionEngine(sessionID: string, engine: QueryEngine): void {
  sessionEngines.set(sessionID, engine);
}

/**
 * 清空所有会话引擎的 system prompt / 工具缓存。
 *
 * 工具集合在运行期发生变化（如启用/停用 MCP、MCP 连接后工具列表变化）时调用，
 * 使下一次 LLM 请求重新组装 system prompt 与可用工具列表。
 */
export function invalidateAllPromptCaches(): void {
  for (const engine of sessionEngines.values()) {
    engine.invalidateToolCache();
  }
}

/**
 * 只清空指定会话引擎的 system prompt / 工具缓存。
 *
 * 用于「该会话的 MCP 启用列表变化，但 MCP 进程被其它会话继续引用」的场景：
 * 此时全局工具集合不变，invalidateAllPromptCaches 不会被触发，但本会话
 * 需要重新组装 prompt / 工具列表（去掉或加上刚勾选/取消的 MCP 工具）。
 */
export function invalidateSessionPromptCache(sessionId: string): void {
  sessionEngines.get(sessionId)?.invalidateToolCache();
}

export class QueryEngine {
  private sessionID: string;
  private config: QueryEngineConfig;
  private mutableMessages: Message[];
  private externalAbortController: AbortControllerLike | undefined;
  // 存储当前活动的 AbortController，供 interrupt() 使用
  private activeAbortController: AbortControllerLike | null = null;
  /** 用户已请求中止；用于覆盖“中止发生在两次查询之间”的竞态 */
  private abortRequested = false;
  /**
   * 静默中止标记：本次中止是业务主动结束（如 spin 子代理首次 Reply 后停止自身），
   * 复用 interrupt() 的中止逻辑，但不向 UI 回显中断消息。
   */
  private silentAbortRequested = false;
  /** 用户界面的 thinking mode 覆盖值（'off' | 'low' | 'high' | 'max'），覆盖配置文件 */
  public thinkingModeOverride?: 'off' | 'low' | 'high' | 'max';
  /** 会话关联的 Web Search 覆盖值（即使 modelConfig 尚未初始化也记录，供查询时合并） */
  private webSearchOverride?: boolean;
  /**
   * 会话当前选择的模型身份（provider + model）。
   * 由 Integration 在应用会话模型配置时写入；meta.json 落盘与子代理继承都读取本字段。
   * 单独存一份而不是从 modelConfig 推导：LLMConfig 只含模型名，不含 provider。
   */
  public modelRefOverride?: ModelRef;
  /** 会话标题 */
  private sessionTitle?: string;
  /** 父会话 ID */
  private parentSessionId?: string;
  /** 上游会话 ID（跨节点/跨会话消息投递的发起方） */
  public upstreamSessionId?: string;
  /** 上游节点的主机名（跨节点 Reply 路由用） */
  public upstreamHostname?: string;
  /** 上游节点的工作区路径（跨节点 Reply 路由用） */
  public upstreamWorkspace?: string;
  /** 会话角色 */
  public readonly role?: string;
  /** 工作模式 */
  public readonly workMode: WorkMode;
  /** 会话关联的提示词预设（运行时值；持久化由 UiEvent 的 core 侧处理写入 meta.json） */
  public promptPresetId: PromptPresetId = 'normal';
  /** 混合模式是否已完成首次 LLM 回复；完成后从极简切换为普通 */
  private firstAssistantReplyCompleted = false;
  /** 缓存的有效工具名（角色 ∩ 预设白名单），由组装 prompt 时计算 */
  private effectiveToolNames: string[] | undefined;
  /** 完整的系统提示词（缓存，首次生成后复用；混合模式切换时清空重建） */
  private fullSystemPrompt: string | null = null;
  /** 缓存的角色可用工具列表 */
  private roleTools?: string[];
  /**
   * 本会话实际启用的 MCP server 名集合（组装 prompt 时读取并缓存）。
   * 用于把 MCP 工具按会话过滤：只有该会话勾选过的 server 的工具才会发给 LLM，
   * 即使进程因其它会话仍存活。`undefined` 表示尚未计算。
   */
  private enabledMcpServers?: ReadonlySet<string>;
  /** SystemEnvironment 模块预热 Promise（构造函数中提前 import，触发模块级预加载） */
  private _warmupSystemEnv: Promise<any> | undefined;
  private initialized = false;
  /** 待处理的用户消息（最多一条，新消息替换旧消息） */
  private pendingUserMessage: string | null = null;
  /** 待处理用户消息在 mutableMessages 中的 uuid（处理时用于确保其位于消息末尾） */
  private pendingUserMsgUuid: string | null = null;
  /** 待处理用户消息的完整 Message 对象（排队路径未 push 时暂存，consumer 处理时现场追加） */
  private pendingUserMsgData: Message | null = null;
  /** 子代理回复 / 后台 Bash 通知队列（多条，追加）；source 决定 UI 的展示方式 */
  public agentMessageQueue: Array<{ content: string; agentId: string; source: AgentMessageSource }> = [];
  /** 消息消费者是否正在运行 */
  public isConsumerRunning: boolean = false;
  /** 等待 consumer 退出的 Promise 解析器（用于 submitMessage 排队等待） */
  private consumerExitResolvers: Array<() => void> = [];
  /** 待处理的 Reminder 消息（LLM 可见，UI 不可见） */
  private pendingReminder: string | null = null;
  /**
   * 已提醒过「后台仍在运行」的后台任务 ID 集合。
   * 用于保证每个后台任务只提醒一次，避免「提醒 → 查询 → 提醒」的无限递归。
   */
  private remindedBackgroundTaskIds = new Set<string>();
  /** 正在进行的持久化操作列表，供 flush() 等待 */
  private pendingPersists: Promise<void>[] = [];
  /** 追踪最后一条持久化到磁盘的消息 uuid，用于在 appendMessage 时正确设置 parentUuid */
  lastPersistedMessageUuid: string | null = null;

  /** 内部应用状态（用于存储 TodoWrite 等工具的状态数据） */
  private internalAppState: Record<string, unknown> = {};

  /**
   * 设置 lastPersistedMessageUuid（用于从磁盘恢复对话时初始化）
   */
  setLastPersistedMessageUuid(uuid: string): void {
    this.lastPersistedMessageUuid = uuid;
  }

  /**
   * 解析持久化时使用的父节点 uuid：
   * 优先使用消息自带的 parentUuid（如 ensureToolResults 生成的 tool_recovered_* 消息，
   * 其 parentUuid 指向包含对应 tool_use 的 assistant 消息），
   * 否则回退到 lastPersistedMessageUuid。
   * 这能避免合成恢复消息被持久化时产生自引用 parentUuid（parentUuid === 自身），
   * 从而防止消息链在 BFS 遍历时断裂。
   */
  private resolvePersistParentUuid(msg: unknown): string | null {
    const own = (msg as any)?.parentUuid;
    if (typeof own === 'string' && own.length > 0) {
      return own;
    }
    return this.lastPersistedMessageUuid;
  }

  /**
   * 更新当前会话的 LLM 模型配置（仅影响当前会话）
   * 用于用户在 webview 中切换模型时，实时更新引擎使用的模型
   */
  updateModelConfig(modelConfig: LLMConfig): void {
    this.config.modelConfig = modelConfig;
  }

  /**
   * 设置当前会话的提示词预设（普通 / 极简 / 混合）。
   * 切换时清空 system prompt 缓存，使下一个消费循环按新预设重新组装。
   * 持久化由上层（UiEvent 的 core 侧处理）负责。
   */
  setPromptPreset(id: PromptPresetId): void {
    if (this.promptPresetId === id) return;
    this.promptPresetId = id;
    this.fullSystemPrompt = null;
    this.effectiveToolNames = undefined;
  }

  /**
   * 清空 system prompt / 工具缓存，使下一次 LLM 请求重新组装。
   * 供工具集合变化（MCP 启用/停用、工具列表刷新）时调用。
   */
  invalidateToolCache(): void {
    this.fullSystemPrompt = null;
    this.effectiveToolNames = undefined;
    this.enabledMcpServers = undefined;
  }

  /**
   * 更新会话关联的 Web Search 开关（覆盖 settings.json 中的默认值）
   * 只记录覆盖值，不改写 config.modelConfig：
   * minimal 预设（或非 Responses 协议）下强制关闭 webSearch 的逻辑
   * 统一在 getEffectiveModelConfig() 里按当前预设动态计算，
   * 否则会把用户设置的 webSearch 永久覆写为 false，切回 normal 后无法恢复。
   */
  public updateWebSearch(webSearch: boolean): void {
    this.webSearchOverride = webSearch;
  }

  /**
   * 获取当前实际生效的 modelConfig：
   * - 极简模式不使用联网搜索：无论 settings.json / 会话覆盖如何，都强制关闭
   * - 已有 modelConfig 时，将会话关联的 webSearch 覆盖值合并进去
   * - 没有 modelConfig（如 createEngine 预创建）但设置了 webSearchOverride 时，
   *   返回仅含 webSearch 的部分配置，由 callRealLLM 与 settings.json 全量配置合并
   * - 该值与每次 query() 发给 LLM 的配置保持一致，供 AgentTool/SpinRunner 创建子代理时继承。
   */
  /**
   * 获取本会话的工作目录（项目根目录）。
   * 供 AgentTool / SpinRunner 创建子代理时继承父会话的 cwd，避免退回 process.cwd()。
   */
  getCwd(): string {
    return this.config.cwd;
  }

  getEffectiveModelConfig(): LLMConfig | undefined {
    const presetMinimal = this.getActivePromptPresetId() === 'minimal';
    const apiTypeNotResponses = !!this.config.modelConfig?.apiType && this.config.modelConfig.apiType !== 'Responses';
    if (presetMinimal || apiTypeNotResponses) {
      if (this.config.modelConfig) {
        return { ...this.config.modelConfig, webSearch: false };
      }
      return { webSearch: false } as LLMConfig;
    }

    if (this.config.modelConfig) {
      return {
        ...this.config.modelConfig,
        ...(this.webSearchOverride !== undefined ? { webSearch: this.webSearchOverride } : {}),
      };
    }
    return this.webSearchOverride !== undefined
      ? ({ webSearch: this.webSearchOverride } as LLMConfig)
      : undefined;
  }

  /**
   * 获取当前实际生效的提示词预设：
   * - 非混合模式：直接返回用户选择的预设
   * - 混合模式：首次 LLM 回复前使用极简，首次回复后使用普通
   */
  private getActivePromptPresetId(): PromptPresetId {
    if (this.promptPresetId !== 'mixed') {
      return this.promptPresetId;
    }

    const hasSeenAssistantReply = this.firstAssistantReplyCompleted
      || this.mutableMessages.some(m => m.type === 'assistant');
    return hasSeenAssistantReply ? 'normal' : 'minimal';
  }

  /**
   * 记录首次 LLM 回复已完成。
   * 混合模式会立即清空 system prompt / 工具缓存，使下一次 LLM 请求切换到普通模式。
   */
  private markFirstAssistantReplyCompleted(): void {
    if (this.firstAssistantReplyCompleted) return;
    this.firstAssistantReplyCompleted = true;
    if (this.promptPresetId === 'mixed') {
      this.fullSystemPrompt = null;
      this.effectiveToolNames = undefined;
    }
  }

  /**
   * 解析本会话实际启用的 MCP server 名集合。
   *
   * - 子代理（有 parentSessionId 且父引擎存在）继承父会话的启用集合，
   *   否则子代理会各自回退到全局默认，可能与父会话不一致；
   * - 其余情况按本会话配置读取（会话覆盖优先，其次全局默认）。
   *
   * 读取配置而不是复用 McpManager.sessionRefs：后者是异步建立的，
   * 首条消息存在竞态；这里在组装 prompt 时 await 读取，结果是权威且最新的。
   */
  private async resolveEnabledMcpServers(): Promise<ReadonlySet<string>> {
    const parentId = this.parentSessionId;
    if (parentId && parentId !== this.sessionID) {
      const parent = sessionEngines.get(parentId);
      if (parent) {
        try {
          return await parent.getEnabledMcpServers();
        } catch (err) {
          logger.warn('QueryEngine', `继承父会话 MCP 启用集合失败，回退本会话配置: ${err}`);
        }
      }
    }
    const { readEnabledMcps } = await import('./mcp/Config.js');
    return new Set(await readEnabledMcps(this.sessionID));
  }

  /**
   * 本会话启用的 MCP server 集合（按需先组装 prompt 以完成解析）。
   * 供子代理继承父会话的 MCP 启用范围。
   */
  async getEnabledMcpServers(): Promise<ReadonlySet<string>> {
    if (!this.fullSystemPrompt) {
      await this.ensureFullSystemPrompt();
    }
    return this.enabledMcpServers ?? new Set<string>();
  }

  /**
   * 确保完整 system prompt 已按当前实际生效的预设生成。
   * 混合模式首次回复后由 markFirstAssistantReplyCompleted 清空缓存，下次调用会重建为普通模式。
   */
  private async ensureFullSystemPrompt(): Promise<void> {
    const { assembleSystemPrompt } = await import('./prompt/SystemPrompt.js');
    const { getPromptPreset } = await import('./prompt/PromptPreset.js');
    const { getToolsForRole } = await import('./tools/RoleTools.js');
    // MCP 工具按会话过滤：只把本会话勾选过的 server 的工具纳入 prompt / 可用工具
    const enabledMcpServers = await this.resolveEnabledMcpServers();
    this.enabledMcpServers = enabledMcpServers;
    const allTools = getAllTools(enabledMcpServers) as Tool[];
    this.roleTools = getToolsForRole(this.role, enabledMcpServers);
    const preset = getPromptPreset(this.getActivePromptPresetId());
    // 有效工具 = 角色可用工具 ∩ 预设白名单（纯集合运算，无模式分支）
    const roleToolNames = this.roleTools;
    const presetToolNames = preset.toolNames;
    this.effectiveToolNames = roleToolNames === undefined
      ? (presetToolNames === undefined ? undefined : [...presetToolNames])
      : (presetToolNames === undefined ? [...roleToolNames] : roleToolNames.filter(name => presetToolNames.includes(name)));
    const presetTools = this.effectiveToolNames === undefined
      ? allTools
      : allTools.filter(t => this.effectiveToolNames!.includes(t.name));

    // System Prompt 由预设数据驱动组装：核心身份 + 预设声明的区块（工具说明 / 环境等）
    // cwd 用引擎自己的 config.cwd（创建引擎时取自宿主工作区），不再向 UI 回查
    const cwd = this.config.cwd;
    const { getSystemDynamicInfo } = await import('./prompt/SystemEnvironment.js');
    const systemInfo = await getSystemDynamicInfo(cwd);

    this.fullSystemPrompt = this.config.staticSystemPrompt
      ?? await assembleSystemPrompt(preset, { tools: presetTools, systemInfo, cwd });
  }

  /**
   * 供 Query 层在每次 LLM 请求前获取当前 system prompt 和可用工具。
   * 混合模式在首次 LLM 回复后会由 markFirstAssistantReplyCompleted 清空缓存，
   * 因此这里会按需重建普通模式的 system prompt / 工具列表。
   *
   * `enabledMcpServers` 供 Query 层按会话过滤 MCP 工具（即使全局进程仍在运行）。
   */
  async getPromptStateForQuery(): Promise<{
    systemPrompt: string;
    availableTools?: string[];
    enabledMcpServers?: ReadonlySet<string>;
  }> {
    if (!this.fullSystemPrompt) {
      await this.ensureFullSystemPrompt();
    }
    return {
      systemPrompt: this.fullSystemPrompt!,
      availableTools: this.effectiveToolNames ?? this.roleTools,
      enabledMcpServers: this.enabledMcpServers,
    };
  }

  /**
   * 发起一条异步持久化操作，将 Promise 记录到 pendingPersists 中，
   * 完成后自行从数组中移除。
   */
  private startPersist(promise: Promise<void>): void {
    this.pendingPersists.push(promise);
    // 持久化完成后从数组中移除
    promise.finally(() => {
      const idx = this.pendingPersists.indexOf(promise);
      if (idx !== -1) {
        this.pendingPersists.splice(idx, 1);
      }
    });
  }

  /**
   * 等待所有正在进行的持久化操作完成。
   * 用于对话切换前确保消息已全部落盘，避免 meta.json 计数与 jsonl 实际条数不一致。
   */
  async flush(): Promise<void> {
    const promises = [...this.pendingPersists];
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /** 持久化前剥离 reminder 原文，避免落盘。 */
  private prepareForPersist(msg: Message): Message {
    const record = msg as Message & { reminder?: string };
    const content = (msg as any).message?.content;
    if (typeof record.reminder !== 'string' || typeof content !== 'string') {
      return msg;
    }
    const suffix = '\n\n' + record.reminder;
    if (!content.endsWith(suffix)) {
      return msg;
    }
    const clone = JSON.parse(JSON.stringify(msg)) as Message;
    (clone as any).message.content = content.slice(0, -suffix.length);
    (clone as any).reminder = undefined;
    return clone;
  }

  /** 持久化单条消息，并更新 lastPersistedMessageUuid。 */
  private async persistMessage(msg: Message, extra?: { totalContextTokens?: number }): Promise<void> {
    const { appendMessage } = await import('./history/Conversation.js');
    const result = await appendMessage(
      this.prepareForPersist(msg),
      this.sessionID,
      this.resolvePersistParentUuid(msg),
      extra?.totalContextTokens,
    );
    this.lastPersistedMessageUuid = result.uuid;
  }

  /** 链式持久化所有未落盘消息，保证 parentUuid 顺序正确。 */
  private persistUnpersistedMessages(): Promise<void> {
    let chain: Promise<void> = Promise.resolve();
    for (const msg of this.mutableMessages) {
      if (!msg || (msg as any)._persisted) continue;
      (msg as any)._persisted = true;
      chain = chain.then(() => this.persistMessage(msg));
    }
    return chain;
  }

  /**
   * 启动消费循环的公共样板：置运行标记 → 记录会话活动 → （可选）通知 UI 查询开始 →
   * 启动后台消费循环。
   *
   * @param notifyQueryBegin 是否调用 ui.onQueryBegin。
   *   enqueueAgentMessage / resumeAfterCompact 传 true；
   *   submitMessage 的正常路径由 Integration 层管理 UI 状态，传 false。
   */
  private beginConsumer(notifyQueryBegin: boolean): void {
    // spin 模式没有 LLM 消费循环：排队消息由 SpinLoop 读取（子代理 Reply）或直接丢弃，
    // messageConsumer 的 spin 分支不消费队列，启动 consumer 只会空转，
    // 还会让 startBackgroundConsumer 的「队列非空就重启」判断陷入忙等。这里直接忽略。
    if (this.workMode === 'spin') return;

    this.isConsumerRunning = true;
    markQueryRunning(this.sessionID, true);
    if (notifyQueryBegin) {
      emitToUi({ type: 'queryBegin', sessionId: this.sessionID });
    }
    this.startBackgroundConsumer();
  }

  /**
   * 入队 Agent 消息并确保消费循环运行（同步版本）
   *
   * submitMessage 是 async* 生成器函数，直接调用不会执行函数体。
   * 后台任务完成通知等场景需要同步入队 + 启动消费循环。
   * 消息入队后，messageConsumer 的 while 循环会捕获到并触发 flushAgentQueue。
   *
   * @param source 消息来源：默认 `subagent`（子代理回复）；后台 Bash 完成通知传 `bash`，
   *   UI 会以纯文本展示而不是 markdown 代理消息。
   */
  enqueueAgentMessage(content: string, agentId?: string, source: AgentMessageSource = 'subagent'): void {
    this.agentMessageQueue.push({ content, agentId: agentId ?? '', source });

    // 压缩进行中：只入队，不启动消费循环，避免与压缩并发改写上下文。
    // 压缩结束后由 resumeAfterCompact() 统一排空。
    if (isCompacting(this.sessionID)) return;

    if (!this.isConsumerRunning) {
      this.beginConsumer(true);
    }
  }

  private startBackgroundConsumer(): void {
    void (async () => {
      try {
        for await (const _message of this.messageConsumer()) {
          void _message;
        }
      } finally {
        // 收尾期间可能又有消息入队，需要再跑一轮（messageConsumer 退出时队列不保证为空）。
        // spin 模式例外：队列由 SpinLoop 读取/排空，messageConsumer 不消费，
        // 这里若重启会变成纯微任务忙等，饿死事件循环。
        if (this.workMode !== 'spin' && this.hasQueuedMessages()) {
          this.startBackgroundConsumer();
          return;
        }
        await this.flush().catch((e: unknown) => logger.error('QueryEngine', `background consumer flush failed: ${e}`));
        await this.finalizeIdle(true);
      }
    })();
  }

  /**
   * 消费循环退出（会话由"运行中"转为"空闲"）时的统一收尾。
   *
   * 顺序：置空闲标记 → 唤醒等待中的提交者 → 通知 UI 查询结束 → 补判待执行的压缩请求。
   *
   * 之所以要在"已置为空闲"之后再判定压缩：用户可能正好在最后一轮对话进行中点压缩，
   * 之后不会再有下一轮对话，Query.ts 的自动压缩检查不会再被触发；这里补判一次，
   * 否则该压缩请求会一直悬空。此时会话已空闲，任何后续点击压缩都会走立即压缩路径，
   * 因此不存在"请求被漏掉"的窗口。
   */
  private async finalizeIdle(notifyQueryEnd: boolean): Promise<void> {
    this.isConsumerRunning = false;
    this.signalConsumerExited();
    markQueryRunning(this.sessionID, false);
    if (notifyQueryEnd) {
      emitToUi({ type: 'queryEnd', sessionId: this.sessionID });
    }
    await this.runPendingCompactIfNeeded();
    await this.maybeRemindBackgroundTasks();
  }

  /**
   * 查询结束（End）后的兜底提醒：若本会话仍有运行中的后台 Bash 任务，
   * 向 LLM 注入一条 reminder，列出当前后台进程（taskId + pid + 命令），让 LLM 二选一：
   * - 不再需要的 → 执行 reminder 里按当前 OS 生成好的 kill 命令；
   * - 都还需要 → 直接结束本轮等待完成通知，不要 sleep / 轮询。
   *
   * 只发一次：已提醒过的 taskId 记录在 remindedBackgroundTaskIds 中，
   * 后续 finalizeIdle 不会对同一批任务重复提醒，因此即使提醒本身触发了一轮
   * 新的查询（本方法会启动消费循环），也不会出现「提醒 → 查询 → 提醒」的递归。
   */
  private async maybeRemindBackgroundTasks(): Promise<void> {
    // spin 模式没有 LLM 消费循环，提醒不会被读取
    if (this.workMode === 'spin') return;
    // 已有消费循环在跑（如压缩收尾已唤醒）或用户已中止：本次不重复处理
    if (this.isConsumerRunning || this.isAborted()) return;

    let runningTasks: Array<{ taskId: string; description: string; command: string; pid?: number }>;
    try {
      const { getRunningBackgroundTasksForSession } = await import('./tools/bash/LocalShellTask.js');
      runningTasks = getRunningBackgroundTasksForSession(this.sessionID)
        .filter(t => !this.remindedBackgroundTaskIds.has(t.taskId))
        .map(t => ({ taskId: t.taskId, description: t.description, command: t.command, pid: t.pid }));
    } catch (err) {
      logger.warn('QueryEngine', `Failed to inspect background tasks for ${this.sessionID}: ${err}`);
      return;
    }

    if (runningTasks.length === 0) return;

    // 先登记再入队：提醒触发的查询结束后会再次进入 finalizeIdle，
    // 此时同一批 taskId 已在集合中，不会被再次提醒。
    for (const task of runningTasks) {
      this.remindedBackgroundTaskIds.add(task.taskId);
    }

    // 直接按当前 OS 生成可执行的 kill 命令，省得 LLM 自己判断平台。
    // Windows 用 taskkill /T 连子进程树一起杀；其他平台用 kill。
    const isWindows = process.platform === 'win32';
    const buildKillCommand = (pid: number): string =>
      isWindows ? `taskkill /T /F /PID ${pid}` : `kill ${pid}`;

    const lines = runningTasks
      .map(t => {
        const pidPart = t.pid !== undefined ? `pid ${t.pid}` : 'pid unknown';
        const cmdPart = t.command && t.command !== t.description ? ` — \`${t.command}\`` : '';
        const killPart = t.pid !== undefined ? `\n  kill: ${buildKillCommand(t.pid)}` : '';
        return `- ${t.taskId} (${pidPart}): ${t.description}${cmdPart}${killPart}`;
      })
      .join('\n');
    this.pendingReminder = [
      '<reminder>',
      `You still have ${runningTasks.length} background bash command(s) running:`,
      lines,
      '',
      'Review them once and act accordingly:',
      '- If any of them is no longer needed, run the "kill:" command shown next to it (already adapted to this OS).',
      '- If all of them are still needed, do NOT sleep, poll, or repeatedly check their output. Simply finish this turn and wait — you will be notified automatically when a background command completes.',
      '</reminder>',
    ].join('\n');

    // 压缩进行中：只入队，压缩结束后由 resumeAfterCompact() 唤醒消费循环
    if (isCompacting(this.sessionID)) return;

    // 主动投递提醒（与后台任务完成通知一致）：启动消费循环，让 LLM 立即看到。
    //
    // 延后一个宏任务再启动：finalizeIdle 可能由 submitMessage 的 finally 触发，
    // 而 Integration 会在 submitMessage 返回后补发 queryEnd / markQueryRunning(false)；
    // 若同步启动消费循环，会被 Integration 的收尾覆盖成「已空闲」。
    // 延后到宏任务可保证「上一轮先收尾，再开始提醒这一轮」。
    //
    // remindedBackgroundTaskIds 已保证同一批任务只提醒一次，因此不会递归重复提醒。
    const timer = setTimeout(() => {
      // 期间已被别的消费循环接管 / 用户中止 / 会话已释放：交给接管方或直接放弃
      if (this.isConsumerRunning || this.isAborted()) return;
      if (isCompacting(this.sessionID)) return;
      if (this.pendingReminder === null) return;
      if (getSessionEngine(this.sessionID) !== this) return;
      this.beginConsumer(true);
    }, 0);
    // 不因这条提醒阻止进程退出
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * 对话结束后的补判：执行用户此前登记、但一直没有等到"下一轮对话"的压缩请求。
   *
   * 仅在没有并发消费（刚置为空闲）时执行；不满足压缩条件时只清标记、不做任何处理。
   */
  private async runPendingCompactIfNeeded(): Promise<void> {
    // 已有新的消费循环接管：交给其 queryLoop 在下一轮开始时处理。
    if (this.isConsumerRunning) return;
    if (isCompacting(this.sessionID)) return;
    if (!isPendingCompact(this.sessionID)) return;

    // 清掉标记：无论是否真的执行压缩，都不再重复判定。
    unmarkPendingCompact(this.sessionID);

    const { compactAndApplyMessages } = await import('./compact/index.js');

    // 二次确认：等待中的提交者可能在上面 await 期间被唤醒并立即启动了新的消费循环。
    // 此时把标记还回去，交给新消费循环的 queryLoop 在下一轮开始时处理，避免并发压缩。
    if (this.isConsumerRunning || isCompacting(this.sessionID)) {
      markPendingCompact(this.sessionID);
      return;
    }

    try {
      const applied = await compactAndApplyMessages(this.sessionID, this.mutableMessages);
      if (!applied) {
        logger.info('QueryEngine', `Pending compact skipped for ${this.sessionID} (no messages to summarize)`);
        return;
      }

      // 压缩会重建消息数组，把 lastPersistedMessageUuid 指向新的末尾消息。
      const lastMsg = this.mutableMessages[this.mutableMessages.length - 1];
      if (lastMsg && 'uuid' in lastMsg && (lastMsg as any).uuid) {
        this.lastPersistedMessageUuid = (lastMsg as any).uuid;
      }
      logger.info('QueryEngine', `Executed pending compact for ${this.sessionID}`);
    } catch (err) {
      logger.warn('QueryEngine', `Pending compact failed for ${this.sessionID}: ${err}`);
      emitToUi({ type: 'compactEnd', sessionId: this.sessionID, result: { status: 'error' } });
    } finally {
      // 压缩期间入队的消息（用户消息 / Agent 回复）此时才排空。
      this.resumeAfterCompact();
    }
  }

  /**
   * 压缩结束后调用：压缩期间入队的消息（用户消息 / Agent 回复 / Reminder）此时才启动消费循环。
   *
   * 压缩过程中 submitMessage / enqueueAgentMessage 只入队不启动 consumer，
   * 因此必须在压缩收尾时显式唤醒一次，否则消息会一直卡在队列里。
   * 已在消费中（例如自动压缩发生在 query 循环内部）时不重复启动。
   */
  resumeAfterCompact(): void {
    if (isCompacting(this.sessionID)) return;
    if (this.isConsumerRunning) return;
    if (!this.hasQueuedMessages()) return;
    // spin 模式下 beginConsumer 会直接忽略（无 LLM 消费循环）
    this.beginConsumer(true);
  }

  /**
   * 将 agentMessageQueue 中的消息逐条追加到 mutableMessages（可选通知 UI）。
   * @returns 被处理的消息数量
   */
  private consumeAgentMessages(notifyUI: boolean): number {
    const items = this.agentMessageQueue;
    if (items.length === 0) return 0;
    this.agentMessageQueue = [];

    for (const item of items) {
      this.mutableMessages.push(this.buildAgentReplyMessage(item));
      if (notifyUI) {
        this.notifyAgentReplyToUI(item);
      }
    }
    return items.length;
  }

  /**
   * 将 agentMessageQueue 中的消息逐条追加到 mutableMessages
   * 每条消息独立追加，不再拼接合并。
   * @returns 被处理的消息数量
   */
  flushAgentQueue(): number {
    return this.consumeAgentMessages(false);
  }

  /**
   * 计算 Agent 回复的来源位置信息（用于 UI 显示 host:agent:agentId）
   */
  private getAgentSourceInfo(agentId: string): string {
    let sourceInfo = agentId ? `#${agentId}` : '';
    try {
      const os = require('os') as typeof import('os');
      const hostname = os.hostname();
      if (hostname) {
        sourceInfo = `${hostname}:agent:${agentId || ''}`;
      }
    } catch { }
    return sourceInfo;
  }

  /**
   * 构造一条排队消息（user 类型）。
   *
   * - `subagent`：标记 fromSubAgent / agentId / _meta，UI 以「来自子代理」渲染
   *   （markdown + From 头）；
   * - `bash`：后台 Bash 完成通知，只标记 fromBashTask（自动消息，不进用户输入历史），
   *   UI 走普通纯文本消息路径，不渲染 markdown。
   */
  private buildAgentReplyMessage(item: { content: string; agentId: string; source: AgentMessageSource }): Message {
    const agentReplyMsg: Message = {
      type: 'user',
      message: { role: 'user', content: item.content },
      uuid: randomId('agent_reply'),
      timestamp: Date.now(),
    };

    if (item.source === 'bash') {
      (agentReplyMsg as any).fromBashTask = true;
    } else {
      // 添加自定义标记，供 UI 层识别为子代理回复
      (agentReplyMsg as any).fromSubAgent = true;
      (agentReplyMsg as any).agentId = item.agentId;
      // 来源位置信息（用于 UI 显示 host:agent:agentId）
      (agentReplyMsg as any)._meta = { param: this.getAgentSourceInfo(item.agentId), type: 'from' };
    }

    if (this.workMode === 'spin') {
      (agentReplyMsg as any).silent = true;
    }
    return agentReplyMsg;
  }

  /**
   * 通知 UI 显示一条排队消息（与 messageConsumer 行为一致）。
   *
   * 只有子代理回复才带 isFromAgent / From 头（UI 按 markdown 渲染）；
   * 后台 Bash 通知按普通 user 消息纯文本展示。
   */
  private notifyAgentReplyToUI(item: { content: string; agentId: string; source: AgentMessageSource }): void {
    if (item.source === 'bash') {
      emitToUi({
        type: 'message',
        sessionId: this.sessionID,
        data: {
          role: 'user',
          content: item.content,
          // 后台任务通知属于系统自动消息：UI 侧与 From 消息一样不参与滚动置顶
          fromBashTask: true,
        } as MessageData,
      });
      return;
    }

    const sourceInfo = this.getAgentSourceInfo(item.agentId);
    emitToUi({
      type: 'message',
      sessionId: this.sessionID,
      data: {
        role: 'user',
        content: item.content,
        param: sourceInfo,
        isFromAgent: true,
        meta: { param: sourceInfo, type: 'from' },
      } as MessageData,
    });
  }

  /**
   * 是否还有待消费的排队消息（Reminder / 用户消息 / Agent 回复）。
   *
   * 「队列是否为空」在消费循环、后台 consumer 收尾、压缩收尾等多处都要判断，
   * 统一收在这里，避免各处手写同一个条件而产生分歧。
   */
  private hasQueuedMessages(): boolean {
    return this.pendingReminder !== null
      || this.pendingUserMessage !== null
      || this.agentMessageQueue.length > 0;
  }

  /**
   * 消费一轮排队消息（Reminder / Agent 回复 / 用户消息），追加到 mutableMessages。
   *
   * 消费优先级：Reminder > (Agent + 用户合并) > 纯用户 > 纯 Agent。
   * 为 messageConsumer 与 flushQueuedMessagesIntoContext 的公共主体；
   * persist（startPersist(persistUnpersistedMessages())）由各调用侧按原条件执行。
   *
   * @param notifyUI 是否向 UI 补发排队消息（messageConsumer 与 flush 均为 true）
   * @returns 被处理的消息数量
   */
  private consumeQueuedOnce(notifyUI: boolean): number {
    let count = 0;

    const hasReminder = this.pendingReminder !== null;
    const hasUserMessage = this.pendingUserMessage !== null;
    const hasAgentMessages = this.agentMessageQueue.length > 0;

    // 消费优先级：Reminder > (Agent + 用户合并) > 纯用户 > 纯 Agent。
    if (hasReminder) {
      if (this.flushReminder()) count++;
      // 若同时有待处理的用户消息，并入同一轮（reminder 在前、用户消息在末尾）。
      // 原因：consumer 空闲时 Integration 会先把用户消息 push 进 mutableMessages，
      // 若这里只 flush reminder，这一轮 LLM 其实已经带上了用户消息并响应一次，
      // 随后用户消息又会被移到末尾单独跑一轮 → 用户消息被重复响应。
      if (hasUserMessage) {
        count += this.consumePendingUserMessage(notifyUI);
      }
    } else if (hasUserMessage && hasAgentMessages) {
      // 合并场景：先追加 agent reply，再把用户消息放到末尾，保证同一轮 LLM 按序看到。
      let userMsg: Message | undefined;
      if (this.pendingUserMsgUuid) {
        const idx = this.mutableMessages.findIndex(m => (m as any).uuid === this.pendingUserMsgUuid);
        if (idx !== -1) userMsg = this.mutableMessages.splice(idx, 1)[0];
        this.pendingUserMsgUuid = null;
      }
      userMsg ??= this.pendingUserMsgData ?? this.buildPendingUserMessage();
      this.pendingUserMsgData = null;

      count += this.consumeAgentMessages(notifyUI);
      if (userMsg) {
        if (notifyUI) this.notifyUserMessageToUI(userMsg);
        this.mutableMessages.push(userMsg);
        count++;
      }
      this.pendingUserMessage = null;
    } else if (hasUserMessage) {
      count += this.consumePendingUserMessage(notifyUI);
    } else {
      count += this.consumeAgentMessages(notifyUI);
    }

    return count;
  }

  /**
   * 消费待处理的用户消息：确保其位于 mutableMessages 末尾（必要时追加），
   * 并清空 pending 状态。
   *
   * 供 consumeQueuedOnce 的「纯用户」与「Reminder + 用户」分支复用。
   * @returns 处理数量（0 或 1）
   */
  private consumePendingUserMessage(notifyUI: boolean): number {
    const userMsgInArray = this.pendingUserMsgUuid !== null;
    this.ensureUserMessageAtEnd();
    let count = 0;
    if (!userMsgInArray) {
      const userMsg = this.pendingUserMsgData ?? this.buildPendingUserMessage();
      this.pendingUserMsgData = null;
      if (userMsg) {
        if (notifyUI) this.notifyUserMessageToUI(userMsg);
        this.mutableMessages.push(userMsg);
        count++;
      }
    } else {
      this.pendingUserMsgData = null;
      count++;
    }
    this.pendingUserMessage = null;
    return count;
  }

  /**
   * 将排队消息（Reminder / Agent 回复 / 用户消息）立即 flush 到 mutableMessages（LLM 上下文）。
   *
   * 调用时机：
   * - queryLoop 每次 LLM 访问前（Query.ts 阶段 0.5）：使排队消息在"下一次 LLM 请求"时立刻进入上下文，
   *   即使当前 query 正处于多轮工具调用循环中（例如 tool use 1 执行期间来了排队消息），
   *   也会在发送给 LLM 生成 tool use 2 之前把排队消息插入上下文（mutableMessages）。
   * - messageConsumer 循环顶部：消费队列后启动新一轮 query()（与原内联消费逻辑等价）。
   *
   * 消费优先级与 messageConsumer 保持一致：Reminder > (Agent + 用户合并) > 纯用户 > 纯 Agent。
   * 被 flush 的消息会同步持久化（标记 _persisted + startPersist），避免 query() 内部 flush 后
   * messageConsumer 的 persist-all 块已执行过导致消息漏持久化。
   * @returns 被 flush 的消息数量
   */
  flushQueuedMessagesIntoContext(): number {
    // 压缩进行中：排队消息不进入 LLM 上下文。
    // 压缩会整体替换 mutableMessages，此时把排队消息插进去会被压缩结果覆盖。
    if (isCompacting(this.sessionID)) return 0;

    const flushedCount = this.consumeQueuedOnce(true);

    if (flushedCount > 0) {
      this.startPersist(this.persistUnpersistedMessages());
    }
    return flushedCount;
  }

  /** 根据 pendingUserMessage 构造用户消息；无 pending 时返回 undefined。 */
  private buildPendingUserMessage(): Message | undefined {
    if (this.pendingUserMessage === null) return undefined;
    return {
      type: 'user',
      message: { role: 'user', content: this.pendingUserMessage },
      uuid: randomId('user'),
      timestamp: Date.now(),
    };
  }

  /**
   * 通知 UI 显示一条“排队后真正进入 LLM 上下文”的用户消息。
   *
   * 排队路径（webview 在 hasActiveQuery 时发 queueMessage）不再立即回显到
   * MessagesView，而是先显示在输入框上方的 queue 中；只有 flushQueuedMessagesIntoContext
   * / messageConsumer 真正把该消息追加到 mutableMessages（下一次 LLM 请求）时，
   * 才通过这里补发 addMessage，让消息在“发送给 LLM”的时机出现在对话流中。
   * 普通 sendMessage 路径已经由 Integration 立即通知过 UI，不会设置 _needsUINotification。
   */
  private notifyUserMessageToUI(userMsg: Message): void {
    const record = userMsg as any;
    if (!record._needsUINotification) return;
    delete record._needsUINotification;

    const fileMsg = userMsg as any;
    const sendFilePath = fileMsg.fileHidden ? undefined : fileMsg.filePath;
    const sendSelectedLines = fileMsg.fileHidden ? undefined : fileMsg.fileSelectedLines;
    const param = sendFilePath
      ? `${sendFilePath.split(/[/\\]/).pop()}${sendSelectedLines ? `:${sendSelectedLines.start}${sendSelectedLines.start !== sendSelectedLines.end ? `~${sendSelectedLines.end}` : ''}` : ''}`
      : undefined;

    const uiMeta: Record<string, unknown> = {};
    if (sendFilePath) {
      uiMeta.filePath = sendFilePath;
      uiMeta.param = param;
    }
    if (sendSelectedLines) {
      uiMeta.fileSelectedLines = sendSelectedLines;
    }

    const userContent = (userMsg as any).message?.content;
    const { text: uiText, images: uiImages } = extractUserContent(userContent);
    emitToUi({
      type: 'message',
      sessionId: this.sessionID,
      data: {
        role: 'user',
        content: uiText,
        images: uiImages.length > 0 ? uiImages : undefined,
        param,
        filePath: sendFilePath,
        fileSelectedLines: sendSelectedLines,
        meta: Object.keys(uiMeta).length > 0 ? uiMeta : undefined,
      } as MessageData,
    });
  }

  constructor(sessionID: string, config: QueryEngineConfig) {
    this.sessionID = sessionID;
    this.config = config;
    // 创建副本而非直接引用，避免 mutableMessages 与 conversationCache 共享同一数组。
    // 若共享同一引用，sendMessage 中 push 用户消息后，messageConsumer 调用
    // appendMessage 会再次向缓存数组 push 同一消息，导致 LLM 上下文中出现重复消息。
    this.mutableMessages = [...(config.initialMessages ?? [])];
    // 恢复已有对话时，如果历史里已经存在 assistant 回复，混合模式直接按普通模式处理。
    this.firstAssistantReplyCompleted = this.mutableMessages.some(m => m.type === 'assistant');
    this.externalAbortController = config.abortController;
    this.sessionTitle = config.title;
    this.parentSessionId = config.parentSessionId;
    this.upstreamSessionId = config.upstreamSessionId;
    this.upstreamHostname = config.upstreamHostname;
    this.upstreamWorkspace = config.upstreamWorkspace;
    // 默认角色为 Master
    this.role = config.role || 'Master';
    this.workMode = config.workMode || 'normal';

    // 注意：不再提前创建会话文件（meta.json + .jsonl）。
    // meta.json 只在第一条消息持久化（appendMessage）时创建，避免没发消息就生成会话文件。
    if (this.sessionTitle) {
      // 通知 UI 新会话已创建（如 webview 预初始化 session 状态）；
      // 子代理会话带 parentSessionId，供 UI 展示树形结构与返回主对话按钮
      emitToUi({
        type: 'sessionCreated',
        sessionId: this.sessionID,
        parentSessionId: this.parentSessionId ?? null,
      });
    }

    // 自动注册到全局引擎池
    registerSessionEngine(sessionID, this);

    // ========== 在构造函数中后台预加载系统动态信息 ==========
    // 系统动态信息已在 extension.ts activate 阶段通过 warmupSystemDynamicInfo() 前置预热，
    // 此处仅做模块预热 import 触发模块级代码（detectAvailableCommandsStart、preloadStaticInfo），
    // 不额外调用 getSystemDynamicInfo，直接由 messageConsumer 读取模块级缓存。
    this._warmupSystemEnv = import('./prompt/SystemEnvironment.js').catch(() => { });
  }

  /**
   * 创建新的 AbortController（每次查询前调用）
   */
  private createAbortController(): AbortControllerLike {
    // 已请求中止：后续任何新建的 controller 都必须处于 aborted 状态，
    // 避免 abort 后仍启动新的 LLM 请求或子代理。
    if (this.abortRequested) {
      const controller = createAbortController();
      controller.abort();
      this.activeAbortController = controller;
      if (this.externalAbortController && !this.externalAbortController.signal?.aborted) {
        this.externalAbortController.abort();
      }
      return controller;
    }
    if (this.externalAbortController) {
      // 如果 externalAbortController 已被 abort，说明用户已中止了当前查询。
      // 创建一个新的 controller 但立即 abort 它，使后续 LLM 请求立即失败，
      // 避免因重新创建未 abort 的 controller 导致"僵尸"LLM 请求继续执行。
      if (this.externalAbortController.signal?.aborted) {
        logger.warn('QueryEngine', `externalAbortController already aborted for ${this.sessionID}, creating aborted controller`);
        const controller = createAbortController();
        controller.abort();
        this.activeAbortController = controller;
        this.externalAbortController = controller;
        return controller;
      }
      this.activeAbortController = this.externalAbortController;
      return this.externalAbortController;
    }
    const controller = createAbortController();
    this.activeAbortController = controller;
    return controller;
  }

  /**
   * 提交消息并启动新的对话轮次
   * 这是与用户交互的主入口
   *
   * @param prompt - 消息内容
   * @param type - 消息类型：'user'（用户消息，替换队列中已有用户消息）| 'agent'（Agent回复，追加到队列）
   * @param agentId - Agent ID
   * @param options.manageQueryUI - 是否由本调用负责 onQueryBegin/onQueryEnd UI 状态。
   *   正常 sendMessage 路径由 Integration 层管理；排队消息（handleQueueMessage）绕过
   *   sendMessage 直接入队，需要自行管理查询开始/结束状态（与 enqueueAgentMessage 一致）。
   */
  async *submitMessage(
    _prompt: string | unknown[], // ContentBlockParam[]
    type: 'user' | 'agent' | 'reminder' = 'user',
    agentId?: string,
    options?: { manageQueryUI?: boolean; userMsgUuid?: string; userMsgData?: Message },
  ): AsyncGenerator<unknown, void, unknown> { // SDKMessage

    const manageQueryUI = options?.manageQueryUI === true;
    const promptStr = typeof _prompt === 'string' ? _prompt : String(_prompt);

    if (type === 'user') {
      // 用户发起新一轮消息：清除上一次 abort 标记，恢复正常可执行状态
      this.abortRequested = false;
      this.silentAbortRequested = false;
    }

    if (type === 'reminder') {
      this.pendingReminder = promptStr;
    } else if (type === 'agent') {
      this.agentMessageQueue.push({ content: promptStr, agentId: agentId ?? '', source: 'subagent' });
    } else {
      this.pendingUserMessage = promptStr;
      this.pendingUserMsgData = options?.userMsgData ?? null;
      if (options?.userMsgUuid) {
        this.pendingUserMsgUuid = options.userMsgUuid;
      } else if (options?.userMsgData) {
        this.pendingUserMsgUuid = null;
      } else {
        const matchedMsg = [...this.mutableMessages].reverse().find(m =>
          (m as any).type === 'user' && !(m as any).fromSubAgent && !(m as any).fromBashTask
          && typeof (m as any).message?.content === 'string'
          && (m as any).message.content === promptStr
        );
        this.pendingUserMsgUuid = matchedMsg ? (matchedMsg as any).uuid : null;
      }
    }

    if (this.isConsumerRunning) {
      await this.waitForIdle();
      if (this.isConsumerRunning) return;
      // 等待期间已有 consumer 把本次消息消费掉了
      if (!this.hasQueuedMessages()) return;
    }

    // 压缩进行中：消息只入队，不启动消费循环。
    // 压缩会整体替换 mutableMessages，此时并发跑一轮 query 会让两者互相踩踏
    // （新消息可能被压缩掉，或压缩结果被后续 query 覆盖）。
    // 压缩结束后由 resumeAfterCompact() 统一排空队列。
    if (isCompacting(this.sessionID)) return;

    this.isConsumerRunning = true;
    markQueryRunning(this.sessionID, true);
    if (manageQueryUI) {
      emitToUi({ type: 'queryBegin', sessionId: this.sessionID });
    }
    try {
      // messageConsumer 内部会一直消费到队列排空（含收尾竞态），这里调用一次即可。
      yield* this.messageConsumer();
    } finally {
      await this.flush().catch((e: unknown) => logger.error('QueryEngine', `submitMessage flush failed: ${e}`));
      await this.finalizeIdle(manageQueryUI);
    }
  }

  /**
   * 注入一个 Agent tool_use 到消息队列中执行（不经过 LLM 生成）
   * 构造一条 assistant 消息，包含 tool_use block，然后执行 runTools
   */
  async submitToolUse(toolUseInput: { name: string; input: Record<string, unknown> }): Promise<void> {
    // 已请求中止时不再启动新的工具调用（例如 SpinLoop 的 Agent 子任务），
    // 避免 abort 与 submitToolUse 之间的竞态留下仍在运行的子代理。
    if (this.isAborted()) {
      logger.info('QueryEngine', `submitToolUse skipped because session ${this.sessionID} is aborted`);
      return;
    }

    const toolUseId = randomId('tooluse');

    await this.persistUnpersistedMessages().catch((err: unknown) => {
      logger.warn('QueryEngine', `submitToolUse: failed to persist initial messages: ${err}`);
    });

    // 构造 assistant 消息
    const assistantMsg: any = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: toolUseInput.name,
            input: toolUseInput.input,
          },
        ],
      },
      uuid: `assistant_${Date.now()}`,
      timestamp: Date.now(),
    };

    // 添加到 mutableMessages
    this.mutableMessages.push(assistantMsg);

    // 构造 ToolUseContext
    const abortController = this.createAbortController();
    const toolUseContext = {
      abortController,
      cwd: this.config.cwd,
      getAppState: () => this.internalAppState,
      setAppState: (updater: (prev: unknown) => unknown) => {
        this.internalAppState = updater(this.internalAppState) as Record<string, unknown>;
      },
      messages: this.mutableMessages,
      sessionId: this.sessionID,
      toolUseId,
    };

    // 执行工具
    const { runTools } = await import('./tools/RunTools.js');
    for await (const update of runTools(this.sessionID, [{
      id: toolUseId,
      name: toolUseInput.name,
      input: toolUseInput.input,
    }], toolUseContext as any)) {
      if (update.message) {
        this.mutableMessages.push(update.message);
      }
    }

    // spin 模式下 flush agent 回复，保证恢复时 waitForAgentReply 可见。
    if (this.workMode === 'spin' && this.agentMessageQueue.length > 0) {
      this.flushAgentQueue();
    }

    const msgIndex = this.mutableMessages.indexOf(assistantMsg);
    for (const msg of [assistantMsg, ...this.mutableMessages.slice(msgIndex + 1)]) {
      if ((msg as any)._persisted) continue;
      (msg as any)._persisted = true;
      await this.persistMessage(msg).catch((err: unknown) => {
        logger.warn('QueryEngine', `submitToolUse: failed to persist message: ${err}`);
      });
    }
  }

  /**
   * 等待 consumer 退出（当前对话结束）。
   * 若 consumer 正在运行，返回一个 Promise，在 isConsumerRunning 变为 false 时 resolve；
   * 若 consumer 未在运行，立即 resolve。
   */
  waitForIdle(): Promise<void> {
    if (!this.isConsumerRunning) return Promise.resolve();
    return new Promise((resolve) => {
      this.consumerExitResolvers.push(resolve);
    });
  }

  /**
   * 通知所有等待 consumer 退出的调用方（isConsumerRunning 已变为 false）。
   * 必须与 isConsumerRunning=false 配对调用。
   */
  private signalConsumerExited(): void {
    const resolvers = this.consumerExitResolvers;
    this.consumerExitResolvers = [];
    for (const r of resolvers) {
      try {
        r();
      } catch (e) {
        logger.warn('QueryEngine', `signalConsumerExited resolver error: ${e}`);
      }
    }
  }

  /**
   * 消息消费者 - 从队列中取出消息并依次执行查询
   *
   * 一次调用会把队列消费干净：内部循环「消费一批 → 跑 query → 再判断队列」，
   * 退出时队列保证为空（除 spin 模式外，见下），调用方无需再补跑。
   *
   * 消费优先级：用户消息 > Agent消息
   * - 用户消息已由 Integration.ts 添加到 mutableMessages，无需重复添加
   * - Agent消息通过 flushAgentQueue 逐条追加到 mutableMessages
   *
   * spin 模式例外：主会话不跑 LLM，只清空 pending 消息后立即结束；
   * agentMessageQueue 保留给 SpinLoop.waitForAgentReply 读取。
   */
  private async *messageConsumer(): AsyncGenerator<unknown, void, unknown> {

    const {
      maxTurns,
    } = this.config;

    // 每次查询创建新的 AbortController，避免 signal 被永久标记为 aborted
    const abortController = this.createAbortController();

    // 如果是首次运行，标记 initialized（持久化由下方通用持久化块统一处理）
    if (!this.initialized) {
      this.initialized = true;
    }

    // 注意：用户消息已经在 Integration.sendMessage 中创建并添加到 mutableMessages
    // 这里不需要再次添加，避免重复

    // ========== System Prompt 惰性生成并缓存（仅首次构建，后续复用） ==========
    // 混合模式在首次 LLM 回复后由 markFirstAssistantReplyCompleted 清空缓存，
    // query() 下一次获取 prompt 状态时会自动重建为普通模式。
    if (!this.fullSystemPrompt) {
      await this.getPromptStateForQuery();
    }

    // ========== 消息消费主循环 ==========
    // 这是唯一的消费循环：消费一批排队消息 → 跑一轮 query（可能多轮工具调用）
    // → 回到顶部重新判断，直到队列真正为空才退出。

    while (true) {
      // spin 模式：主会话不跑 LLM，这里只清空 pending 消息后结束本次消费。
      // agentMessageQueue 必须保留——子代理 Reply 要留给 SpinLoop.waitForAgentReply
      // 读取（takeCurrentQueueReply），因此绝不能进入下面的「队列为空」判断：
      // 否则队列永远非空 → 纯微任务忙等，饿死事件循环（定时器/IO 无法推进，
      // SpinLoop 轮询的 setTimeout 不再触发，Reply 永远读不到）。
      if (this.workMode === 'spin') {
        this.pendingReminder = null;
        this.pendingUserMessage = null;
        this.pendingUserMsgData = null;
        this.pendingUserMsgUuid = null;
        await this.flush();
        break;
      }

      if (!this.hasQueuedMessages()) {
        await this.flush();
        // flush 期间可能又有消息入队：此时 isConsumerRunning 仍为 true，
        // 入队方（enqueueAgentMessage / submitMessage）不会再另起 consumer，
        // 必须再确认一次队列为空才能退出，否则消息会一直悬空到下一次用户消息。
        if (!this.hasQueuedMessages()) break;
        continue;
      }

      this.consumeQueuedOnce(true);

      this.startPersist(this.persistUnpersistedMessages());

      // ---- 执行查询循环 ----
      const messagesBeforeQuery = this.mutableMessages.length;

      for await (const message of query({
        sessionID: this.sessionID,
        messages: this.mutableMessages,
        staticSystemPrompt: this.fullSystemPrompt!,
        getPromptState: () => this.getPromptStateForQuery(),
        getModelConfig: () => this.getEffectiveModelConfig(),
        toolUseContext: {
          abortController,
          cwd: this.config.cwd,
          getAppState: () => this.internalAppState,
          setAppState: (updater: (prev: unknown) => unknown) => {
            this.internalAppState = updater(this.internalAppState) as Record<string, unknown>;
          },
          messages: this.mutableMessages,
          sessionId: this.sessionID,
          role: this.role,
        },
        querySource: 'sdk',
        maxTurns,
        silent: false,
        // 静默中止判定：spin 子代理 Reply 后主动停止自身时不回显中断消息
        silentAbort: () => this.silentAbortRequested,
      })) {
        const shouldPersist = message.type === 'assistant'
          || (message.type === 'user' && Array.isArray(message.message?.content))
          || message.type === 'system';

        if (message.type === 'assistant') {
          this.markFirstAssistantReplyCompleted();
        }

        if (shouldPersist && !(message as any)._persisted) {
          (message as any)._persisted = true;
          const usage = message.type === 'assistant'
            ? (message as any).message?.usage as { input_tokens?: number; output_tokens?: number } | undefined
            : undefined;
          const totalContextTokens = usage?.input_tokens !== undefined && usage?.output_tokens !== undefined
            ? usage.input_tokens + usage.output_tokens
            : undefined;
          this.startPersist(
            this.persistMessage(message, totalContextTokens !== undefined ? { totalContextTokens } : undefined)
              .catch(err => logger.warn('QueryEngine', `Failed to persist message: ${err}`))
          );
        }
        yield message;
      }

      if (abortController.signal?.aborted) {
        break;
      }

      const newMsgsAfterQuery = this.mutableMessages.length - messagesBeforeQuery;

      if (newMsgsAfterQuery > 0) {
        const lastAssistantMsg = this.mutableMessages.slice(messagesBeforeQuery).reverse()
          .find((m: any) => m.type === 'assistant');
        if (lastAssistantMsg) {
          const stopReason = (lastAssistantMsg as any).message?.stop_reason;
          const contentBlocks = (lastAssistantMsg as any).message?.content as Array<{ type: string; text?: string }> | undefined;
          const hasToolUse = Array.isArray(contentBlocks) && contentBlocks.some((b: any) => b.type === 'tool_use');

          if (!hasToolUse && stopReason && stopReason !== 'end_turn') {
            this.pendingReminder = `<reminder>Your previous response stopped (stop_reason: ${stopReason}), and did not complete fully. Please continue from where you left off, including any incomplete tool calls or text.</reminder>`;
          } else if (!hasToolUse && stopReason === 'end_turn') {
            const lastText = Array.isArray(contentBlocks)
              ? [...contentBlocks].reverse().find(b => b.type === 'text')?.text ?? ''
              : '';
            if (lastText.trimEnd().endsWith(':') || lastText.trimEnd().endsWith('：')) {
              this.pendingReminder = `<reminder>You ended your response with a colon (":" or "："), which suggests you intended to continue with a tool call, but didn't actually invoke any tool. Please think about what tool you need to call next and make the appropriate tool call to complete the user's request.</reminder>`;
            }
          }

        }
      }
    }
    if (this.externalAbortController && this.externalAbortController.signal?.aborted) {
      this.externalAbortController = createAbortController();
      this.activeAbortController = null;
    }
  }

  /**
   * 追加一条 Reminder 消息到 mutableMessages，LLM 可见但 UI 不可见。
   * 用于子代理完成后未 Reply 时，给主 LLM 一个隐式提醒。
   */
  public appendReminder(content: string): void {
    this.pendingReminder = content;
  }

  /**
   * 将 pendingReminder 处理为 silent user message 追加到 mutableMessages
   * @returns 如果有 Reminder 被处理返回 true，否则 false
   */
  private flushReminder(): boolean {
    if (this.pendingReminder === null) {
      return false;
    }

    const content = this.pendingReminder;
    this.pendingReminder = null;

    const reminderMsg: Message = {
      type: 'user',
      message: { role: 'user', content },
      uuid: `reminder_${Date.now()}`,
      timestamp: Date.now(),
    };
    // 标记为 silent：追加到 mutableMessages 但不通知 UI
    (reminderMsg as any).silent = true;
    (reminderMsg as any).fromSubAgent = true;

    this.mutableMessages.push(reminderMsg);
    return true;
  }

  /**
   * 确保待处理的用户消息位于 mutableMessages 末尾。
   *
   * 用户消息由 Integration.sendMessage push 到 mutableMessages 后，
   * 若当前 consumer 仍在执行查询，其 tool_result / assistant 回复可能被追加到
   * 用户消息之后，导致用户消息不再位于末尾。在处理用户消息前将其移动到末尾，
   * 保证 LLM 上下文顺序正确（用户消息应紧跟在已有对话之后）。
   */
  private ensureUserMessageAtEnd(): void {
    if (!this.pendingUserMsgUuid) return;
    const idx = this.mutableMessages.findIndex(m => (m as any).uuid === this.pendingUserMsgUuid);
    if (idx !== -1 && idx !== this.mutableMessages.length - 1) {
      this.mutableMessages.push(this.mutableMessages.splice(idx, 1)[0]);
    }
    this.pendingUserMsgUuid = null;
  }

  /**
   * 当前引擎是否已被用户中止。
   * 用于 SpinLoop 等待子代理回复时及时退出，避免无限等待。
   */
  isAborted(): boolean {
    return this.abortRequested || !!(
      this.activeAbortController?.signal?.aborted ||
      this.externalAbortController?.signal?.aborted
    );
  }

  /**
   * 当前会话是否处于“静默中止”状态（业务主动结束，不回显中断消息）。
   */
  isSilentAbort(): boolean {
    return this.silentAbortRequested;
  }

  /**
   * 静默中止当前会话：复用 interrupt() 的完整中止逻辑（终止当前查询、后台任务、
   * 递归中止子会话），但标记为静默中止，使查询循环不再向 UI 回显
   * "*User Interrupted*" 等中断消息。
   *
   * 使用场景：spin 模式下子代理首次 Reply 后立即停止自身，避免其继续消耗 token、
   * 产生多余消息；主循环仍会正常读取该 Reply 并推进后续节点。
   */
  requestSilentAbort(): void {
    this.silentAbortRequested = true;
    this.interrupt();
  }

  /**
   * 丢弃尚未消费的后台 Bash 任务完成通知。
   * 用户 abort 后，已排队但未进入 LLM 上下文的后台任务结果不应再被消费。
   *
   * 直接按队列项的 source 判定，不再嗅探通知正文（正文格式可自由调整）。
   */
  private discardBackgroundTaskNotifications(): void {
    for (let i = this.agentMessageQueue.length - 1; i >= 0; i--) {
      if (this.agentMessageQueue[i]?.source === 'bash') {
        this.agentMessageQueue.splice(i, 1);
      }
    }
  }

  /**
   * 中止当前会话所属的所有运行中后台 Bash 任务。
   * 被中止任务的结果会被 LocalShellTask 直接丢弃，不再通知 LLM。
   */
  private abortBackgroundTasksForCurrentSession(): void {
    try {
      const { abortBackgroundTasksForSession } = require('./tools/bash/LocalShellTask.js') as typeof import('./tools/bash/LocalShellTask.js');
      const count = abortBackgroundTasksForSession(this.sessionID);
      if (count > 0) {
        logger.info('QueryEngine', `Aborted ${count} background task(s) for ${this.sessionID}`);
      }
    } catch (err) {
      logger.warn('QueryEngine', `Failed to abort background tasks for ${this.sessionID}: ${err}`);
    }
  }

  /**
   * 递归中止当前会话及其所有子对话。
   * 子对话的后台 Bash 任务同样会被中止，结果直接丢弃。
   */
  private interruptRecursive(visited: Set<string>): void {
    if (visited.has(this.sessionID)) return;
    visited.add(this.sessionID);
    this.abortRequested = true;

    // 1. 丢弃已排队但未消费的后台任务完成通知
    this.discardBackgroundTaskNotifications();
    // 1.5 丢弃尚未被消费的排队用户消息：abort 后不应再把它发给 LLM。
    //     该消息仍记录在 webview 的 queuedMessageRef 中，会在 queryEnd 时
    //     回填到输入框（与用户当前草稿用 \n 连接），由用户决定是否重发。
    //     仅处理排队消息（_needsUINotification），普通消息已进入 mutableMessages 且已回显。
    if (this.pendingUserMessage !== null && (this.pendingUserMsgData as any)?._needsUINotification) {
      this.pendingUserMessage = null;
      this.pendingUserMsgData = null;
      this.pendingUserMsgUuid = null;
    }
    // 1.6 丢弃尚未消费的 reminder：abort 会同时中止后台任务，之前排队的
    //     「后台任务仍在运行」提醒已经过期，不应在下一轮再发给 LLM。
    this.pendingReminder = null;
    // 2. 中止本会话的后台 Bash 任务
    this.abortBackgroundTasksForCurrentSession();

    // 3. 中止当前查询
    if (this.activeAbortController) {
      this.activeAbortController.abort();
    } else {
      logger.warn('QueryEngine', 'No active query to interrupt');
      // 如果 activeAbortController 为空但 externalAbortController 存在，尝试 abort 它
      if (this.externalAbortController && !this.externalAbortController.signal?.aborted) {
        logger.warn('QueryEngine', 'Falling back to externalAbortController');
        this.activeAbortController = this.externalAbortController;
        this.externalAbortController.abort();
      }
    }

    // 4. 递归中止子对话（包括其后台任务）
    try {
      const { subAgentRegistry } = require('./tools/agent/SubAgentRegistry.js') as typeof import('./tools/agent/SubAgentRegistry.js');
      for (const childId of subAgentRegistry.listForCreator(this.sessionID)) {
        const record = subAgentRegistry.get(childId);
        if (record?.engine) {
          record.engine.interruptRecursive(visited);
        }
      }
    } catch (err) {
      logger.warn('QueryEngine', `Failed to interrupt child sessions for ${this.sessionID}: ${err}`);
    }
  }

  /**
   * 中断当前查询，并递归中止所有子对话及其后台 Bash 任务。
   */
  interrupt(): void {
    this.interruptRecursive(new Set<string>());
  }

  /**
   * 获取当前消息历史
   */
  getMessages(): Message[] {
    return this.mutableMessages;
  }

  /**
   * 追加一条"已发送"消息到当前对话并持久化（不经过 LLM）
   * 用于记录 @ 发送消息的操作日志
   */
  public appendSelfMessage(msg: Message): void {
    this.mutableMessages.push(msg);
    // 立即持久化
    (async () => {
      try {
        const { appendMessage } = await import('./history/Conversation.js');
        const result = await appendMessage(msg, this.sessionID, this.resolvePersistParentUuid(msg));
        this.lastPersistedMessageUuid = result.uuid;
        (msg as any)._persisted = true;
      } catch (err) {
        logger.warn('QueryEngine', `appendSelfMessage: failed to persist: ${err}`);
      }
    })();
  }
}

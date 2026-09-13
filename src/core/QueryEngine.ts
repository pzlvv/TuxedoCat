/**
 * QueryEngine - 管理会话状态和消息处理的主引擎
 */

import type { Message } from './types.js';
import { extractUserContent } from './utils/contentBlocks.js';
import { query } from './Query.js';
import type { AbortControllerLike } from './tools/Tool.js';
import type { AssistantUI } from './AssistantUI.js';
import type { Tool } from './tools/Tool.js';
import type { LLMConfig } from './llm/config.js';
import type { PromptPresetId } from './prompt/PromptPreset.js';
import { getAllTools } from './tools/index.js';
import { logger } from './Logger.js';
import { noteSessionActivity } from './sessionIdle.js';
import { isCompacting } from './compact/state.js';

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
  ui: AssistantUI;
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

export class QueryEngine {
  private sesssionID: string;
  private config: QueryEngineConfig;
  private mutableMessages: Message[];
  private externalAbortController: AbortControllerLike | undefined;
  // 存储当前活动的 AbortController，供 interrupt() 使用
  private activeAbortController: AbortControllerLike | null = null;
  /** 用户已请求中止；用于覆盖“中止发生在两次查询之间”的竞态 */
  private abortRequested = false;
  /** 用户界面的 thinking mode 覆盖值（'off' | 'low' | 'high' | 'max'），覆盖配置文件 */
  public thinkingModeOverride?: 'off' | 'low' | 'high' | 'max';
  /** 会话关联的 Web Search 覆盖值（即使 modelConfig 尚未初始化也记录，供查询时合并） */
  private webSearchOverride?: boolean;
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
  /** 会话关联的提示词预设（运行时值；持久化由 VSCodeUI/meta.json 负责） */
  public promptPresetId: PromptPresetId = 'normal';
  /** 混合模式是否已完成首次 LLM 回复；完成后从极简切换为普通 */
  private firstAssistantReplyCompleted = false;
  /** 缓存的有效工具名（角色 ∩ 预设白名单），由组装 prompt 时计算 */
  private effectiveToolNames: string[] | undefined;
  /** 完整的系统提示词（缓存，首次生成后复用；混合模式切换时清空重建） */
  private fullSystemPrompt: string | null = null;
  /** 缓存的角色可用工具列表 */
  private roleTools?: string[];
  /** SystemEnvironment 模块预热 Promise（构造函数中提前 import，触发模块级预加载） */
  private _warmupSystemEnv: Promise<any> | undefined;
  private initialized = false;
  /** 待处理的用户消息（最多一条，新消息替换旧消息） */
  private pendingUserMessage: string | null = null;
  /** 待处理用户消息在 mutableMessages 中的 uuid（处理时用于确保其位于消息末尾） */
  private pendingUserMsgUuid: string | null = null;
  /** 待处理用户消息的完整 Message 对象（排队路径未 push 时暂存，consumer 处理时现场追加） */
  private pendingUserMsgData: Message | null = null;
  /** 子代理回复消息队列（多条，追加） */
  public agentMessageQueue: Array<{ content: string; agentId: string }> = [];
  /** 消息消费者是否正在运行 */
  public isConsumerRunning: boolean = false;
  /** 等待 consumer 退出的 Promise 解析器（用于 submitMessage 排队等待） */
  private consumerExitResolvers: Array<() => void> = [];
  /** 待处理的 Reminder 消息（LLM 可见，UI 不可见） */
  private pendingReminder: string | null = null;
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
   * 持久化由上层（VSCodeUI/meta.json）负责。
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
  }

  /**
   * 更新会话关联的 Web Search 开关（覆盖 settings.json 中的默认值）
   * 即使 modelConfig 尚未初始化也会记录覆盖值，避免引擎由 createEngine
   * 预创建（无 modelConfig）时，会话级 webSearch 开关丢失
   */
  public updateWebSearch(webSearch: boolean): void {
    this.webSearchOverride = webSearch;
    // 极简模式不使用联网搜索：无论传入值如何，实际写入 modelConfig 的开关都强制为 false。
    // 混合模式在首次 LLM 回复前也按极简处理，回复后 getEffectiveModelConfig 会恢复用户设置。
    // Anthropic（非 Responses）协议不支持内置 web_search，同样视为关闭。
    const activePresetId = this.getActivePromptPresetId();
    const apiType = this.config.modelConfig?.apiType;
    const effectiveWebSearch = (activePresetId === 'minimal' || (apiType && apiType !== 'Responses'))
      ? false
      : webSearch;
    if (this.config.modelConfig) {
      this.config.modelConfig = { ...this.config.modelConfig, webSearch: effectiveWebSearch };
    }
  }

  /**
   * 获取当前实际生效的 modelConfig：
   * - 极简模式不使用联网搜索：无论 settings.json / 会话覆盖如何，都强制关闭
   * - 已有 modelConfig 时，将会话关联的 webSearch 覆盖值合并进去
   * - 没有 modelConfig（如 createEngine 预创建）但设置了 webSearchOverride 时，
   *   返回仅含 webSearch 的部分配置，由 callRealLLM 与 settings.json 全量配置合并
   * - 该值与每次 query() 发给 LLM 的配置保持一致，供 AgentTool/SpinRunner 创建子代理时继承。
   */
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
   * 确保完整 system prompt 已按当前实际生效的预设生成。
   * 混合模式首次回复后由 markFirstAssistantReplyCompleted 清空缓存，下次调用会重建为普通模式。
   */
  private async ensureFullSystemPrompt(): Promise<void> {
    const { assembleSystemPrompt } = await import('./prompt/SystemPrompt.js');
    const { getPromptPreset } = await import('./prompt/PromptPreset.js');
    const { getToolsForRole } = await import('./tools/RoleTools.js');
    const allTools = getAllTools() as Tool[];
    this.roleTools = getToolsForRole(this.role);
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
    const uiDynamicInfo = await this.config.ui.getUIDynamicInfo(this.sesssionID);
    const { getSystemDynamicInfo } = await import('./prompt/SystemEnvironment.js');
    const systemInfo = await getSystemDynamicInfo(uiDynamicInfo.cwd);
    const cwd = uiDynamicInfo.cwd;

    this.fullSystemPrompt = this.config.staticSystemPrompt
      ?? await assembleSystemPrompt(preset, { tools: presetTools, systemInfo, cwd });
  }

  /**
   * 供 Query 层在每次 LLM 请求前获取当前 system prompt 和可用工具。
   * 混合模式在首次 LLM 回复后会由 markFirstAssistantReplyCompleted 清空缓存，
   * 因此这里会按需重建普通模式的 system prompt / 工具列表。
   */
  async getPromptStateForQuery(): Promise<{ systemPrompt: string; availableTools?: string[] }> {
    if (!this.fullSystemPrompt) {
      await this.ensureFullSystemPrompt();
    }
    return {
      systemPrompt: this.fullSystemPrompt!,
      availableTools: this.effectiveToolNames ?? this.roleTools,
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
      this.sesssionID,
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
   * 判断当前会话是否处于空闲状态，即没有活跃的后台工作。
   *
   * 空闲 = 无活跃后台 Bash 任务 + 无活跃 Sub-Agent（递归检查）
   * 非空闲时不应触发 todo reminder 等操作，因为后台工作完成后会自动通知 LLM。
   */
  async isIdle(): Promise<boolean> {
    // 1. 检查当前 session 是否有活跃的后台 Bash 任务
    try {
      const { getAllBackgroundTasks } = await import('./tools/bash/LocalShellTask.js');
      const tasks = getAllBackgroundTasks();
      const hasActiveBgTask = tasks.some(
        (t: any) => t.status === 'running' && t.sessionID === this.sesssionID
      );
      if (hasActiveBgTask) return false;
    } catch { }

    // 2. 检查当前 session 是否有活跃的 Sub-Agent（递归）
    try {
      const { subAgentRegistry } = await import('./tools/agent/SubAgentRegistry.js');
      const activeSubAgents = subAgentRegistry.listForCreator(this.sesssionID);
      for (const subId of activeSubAgents) {
        const record = subAgentRegistry.get(subId);
        if (!record) continue;
        // 递归检查子代理是否空闲
        const isSubIdle = await record.engine.isIdle();
        if (!isSubIdle) return false;
      }
    } catch { }

    return true;
  }

  /**
   * 入队 Agent 消息并确保消费循环运行（同步版本）
   *
   * submitMessage 是 async* 生成器函数，直接调用不会执行函数体。
   * 后台任务完成通知等场景需要同步入队 + 启动消费循环。
   * 消息入队后，messageConsumer 的 while 循环会捕获到并触发 flushAgentQueue。
   */
  enqueueAgentMessage(content: string, agentId?: string): void {
    this.agentMessageQueue.push({ content, agentId: agentId ?? '' });

    // 压缩进行中：只入队，不启动消费循环，避免与压缩并发改写上下文。
    // 压缩结束后由 resumeAfterCompact() 统一排空。
    if (isCompacting(this.sesssionID)) return;

    if (!this.isConsumerRunning) {
      this.isConsumerRunning = true;
      noteSessionActivity(this.sesssionID);
      this.config.ui?.onQueryBegin(this.sesssionID);
      this.startBackgroundConsumer();
    }
  }

  private startBackgroundConsumer(): void {
    void (async () => {
      try {
        for await (const _message of this.messageConsumer()) {
          void _message;
        }
      } finally {
        if (this.agentMessageQueue.length > 0 || this.pendingUserMessage !== null || this.pendingReminder !== null) {
          this.startBackgroundConsumer();
          return;
        }
        await this.flush().catch((e: unknown) => logger.error('QueryEngine', `background consumer flush failed: ${e}`));
        this.isConsumerRunning = false;
        this.signalConsumerExited();
        this.config.ui?.onQueryEnd(this.sesssionID);
      }
    })();
  }

  /**
   * 压缩结束后调用：压缩期间入队的消息（用户消息 / Agent 回复 / Reminder）此时才启动消费循环。
   *
   * 压缩过程中 submitMessage / enqueueAgentMessage 只入队不启动 consumer，
   * 因此必须在压缩收尾时显式唤醒一次，否则消息会一直卡在队列里。
   * 已在消费中（例如自动压缩发生在 query 循环内部）时不重复启动。
   */
  resumeAfterCompact(): void {
    if (isCompacting(this.sesssionID)) return;
    if (this.isConsumerRunning) return;
    if (this.pendingUserMessage === null && this.agentMessageQueue.length === 0 && this.pendingReminder === null) {
      return;
    }
    this.isConsumerRunning = true;
    noteSessionActivity(this.sesssionID);
    this.config.ui?.onQueryBegin(this.sesssionID);
    this.startBackgroundConsumer();
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
   * 构造一条 Agent 回复消息（user 类型，标记 fromSubAgent / agentId / _meta）
   */
  private buildAgentReplyMessage(item: { content: string; agentId: string }): Message {
    const agentReplyMsg: Message = {
      type: 'user',
      message: { role: 'user', content: item.content },
      uuid: `agent_reply_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      timestamp: Date.now(),
    };
    // 添加自定义标记，供 UI 层识别为子代理回复
    (agentReplyMsg as any).fromSubAgent = true;
    (agentReplyMsg as any).agentId = item.agentId;
    if (this.workMode === 'spin') {
      (agentReplyMsg as any).silent = true;
    }
    // 来源位置信息（用于 UI 显示 host:agent:agentId）
    (agentReplyMsg as any)._meta = { param: this.getAgentSourceInfo(item.agentId), type: 'from' };
    return agentReplyMsg;
  }

  /**
   * 通知 UI 显示一条 Agent 回复消息（与 messageConsumer 行为一致）
   */
  private notifyAgentReplyToUI(item: { content: string; agentId: string }): void {
    const sourceInfo = this.getAgentSourceInfo(item.agentId);
    this.config.ui?.onMessage(this.sesssionID, {
      role: 'user',
      content: item.content,
      param: sourceInfo,
      isFromAgent: true,
      meta: { param: sourceInfo, type: 'from' },
    });
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
    if (isCompacting(this.sesssionID)) return 0;

    const hasReminder = this.pendingReminder !== null;
    const hasUserMessage = this.pendingUserMessage !== null;
    const hasAgentMessages = this.agentMessageQueue.length > 0;

    if (!hasReminder && !hasUserMessage && !hasAgentMessages) {
      return 0;
    }

    let flushedCount = 0;

    if (hasReminder) {
      if (this.flushReminder()) flushedCount++;
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

      flushedCount += this.consumeAgentMessages(true);
      if (userMsg) {
        this.notifyUserMessageToUI(userMsg);
        this.mutableMessages.push(userMsg);
        flushedCount++;
      }
      this.pendingUserMessage = null;
    } else if (hasUserMessage) {
      const userMsgInArray = this.pendingUserMsgUuid !== null;
      this.ensureUserMessageAtEnd();
      if (!userMsgInArray) {
        const userMsg = this.pendingUserMsgData ?? this.buildPendingUserMessage();
        this.pendingUserMsgData = null;
        if (userMsg) {
          this.notifyUserMessageToUI(userMsg);
          this.mutableMessages.push(userMsg);
          flushedCount++;
        }
      } else {
        this.pendingUserMsgData = null;
        flushedCount++;
      }
      this.pendingUserMessage = null;
    } else {
      flushedCount += this.consumeAgentMessages(true);
    }

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
      uuid: `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
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
    this.config.ui?.onMessage(this.sesssionID, {
      role: 'user',
      content: uiText,
      images: uiImages.length > 0 ? uiImages : undefined,
      param,
      filePath: sendFilePath,
      fileSelectedLines: sendSelectedLines,
      meta: Object.keys(uiMeta).length > 0 ? uiMeta : undefined,
    });
  }

  constructor(sessionID: string, config: QueryEngineConfig) {
    this.sesssionID = sessionID;
    if (!config.ui) {
      throw new Error('QueryEngine config requires ui to be provided');
    }
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
      // 通知 UI 新会话已创建（如 webview 预初始化 session 状态）
      config.ui?.onSessionCreated?.(this.sesssionID);
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
        logger.warn('QueryEngine', `externalAbortController already aborted for ${this.sesssionID}, creating aborted controller`);
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
    }

    if (type === 'reminder') {
      this.pendingReminder = promptStr;
    } else if (type === 'agent') {
      this.agentMessageQueue.push({ content: promptStr, agentId: agentId ?? '' });
    } else {
      this.pendingUserMessage = promptStr;
      this.pendingUserMsgData = options?.userMsgData ?? null;
      if (options?.userMsgUuid) {
        this.pendingUserMsgUuid = options.userMsgUuid;
      } else if (options?.userMsgData) {
        this.pendingUserMsgUuid = null;
      } else {
        const matchedMsg = [...this.mutableMessages].reverse().find(m =>
          (m as any).type === 'user' && !(m as any).fromSubAgent
          && typeof (m as any).message?.content === 'string'
          && (m as any).message.content === promptStr
        );
        this.pendingUserMsgUuid = matchedMsg ? (matchedMsg as any).uuid : null;
      }
    }

    if (this.isConsumerRunning) {
      await this.waitForIdle();
      if (this.isConsumerRunning) return;
      if (this.pendingUserMessage === null && this.agentMessageQueue.length === 0 && this.pendingReminder === null) {
        return;
      }
    }

    // 压缩进行中：消息只入队，不启动消费循环。
    // 压缩会整体替换 mutableMessages，此时并发跑一轮 query 会让两者互相踩踏
    // （新消息可能被压缩掉，或压缩结果被后续 query 覆盖）。
    // 压缩结束后由 resumeAfterCompact() 统一排空队列。
    if (isCompacting(this.sesssionID)) return;

    this.isConsumerRunning = true;
    noteSessionActivity(this.sesssionID);
    if (manageQueryUI) {
      this.config.ui?.onQueryBegin(this.sesssionID);
    }
    try {
      yield* this.messageConsumer();
    } finally {
      await this.flush().catch((e: unknown) => logger.error('QueryEngine', `submitMessage flush failed: ${e}`));

      if (this.agentMessageQueue.length > 0 || this.pendingUserMessage !== null || this.pendingReminder !== null) {
        try {
          yield* this.messageConsumer();
        } finally {
          await this.flush().catch((e: unknown) => logger.error('QueryEngine', `submitMessage flush failed: ${e}`));
          this.isConsumerRunning = false;
          this.signalConsumerExited();
        }
        if (manageQueryUI) {
          this.config.ui?.onQueryEnd(this.sesssionID);
        }
        return;
      }

      this.isConsumerRunning = false;
      this.signalConsumerExited();
      if (manageQueryUI) {
        this.config.ui?.onQueryEnd(this.sesssionID);
      }
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
      logger.info('QueryEngine', `submitToolUse skipped because session ${this.sesssionID} is aborted`);
      return;
    }

    const toolUseId = `tooluse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

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
      getAppState: () => this.internalAppState,
      setAppState: (updater: (prev: unknown) => unknown) => {
        this.internalAppState = updater(this.internalAppState) as Record<string, unknown>;
      },
      messages: this.mutableMessages,
      sessionId: this.sesssionID,
      toolUseId,
    };

    // 执行工具
    const { runTools } = await import('./tools/RunTools.js');
    for await (const update of runTools(this.sesssionID, [{
      id: toolUseId,
      name: toolUseInput.name,
      input: toolUseInput.input,
    }], toolUseContext as any, this.config.ui as any)) {
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
    // 会话从「非空闲」回到「空闲」：从这里开始重新计算空闲关闭计时
    noteSessionActivity(this.sesssionID);
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
   * 消费优先级：用户消息 > Agent消息
   * - 用户消息已由 Integration.ts 添加到 mutableMessages，无需重复添加
   * - Agent消息通过 flushAgentQueue 逐条追加到 mutableMessages
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

    while (true) {
      if (this.workMode === 'spin') {
        this.pendingReminder = null;
        this.pendingUserMessage = null;
        this.pendingUserMsgData = null;
        this.pendingUserMsgUuid = null;
        await this.flush();
        break;
      }

      const hasReminder = this.pendingReminder !== null;
      const hasUserMessage = this.pendingUserMessage !== null;
      const hasAgentMessages = this.agentMessageQueue.length > 0;

      if (!hasReminder && !hasUserMessage && !hasAgentMessages) {
        await this.flush();
        break;
      }

      // 消费优先级：Reminder > (Agent + 用户合并) > 纯用户 > 纯 Agent。
      if (hasReminder) {
        this.flushReminder();
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

        this.consumeAgentMessages(true);
        if (userMsg) {
          this.notifyUserMessageToUI(userMsg);
          this.mutableMessages.push(userMsg);
        }
        this.pendingUserMessage = null;
      } else if (hasUserMessage) {
        const userMsgInArray = this.pendingUserMsgUuid !== null;
        this.ensureUserMessageAtEnd();
        if (!userMsgInArray) {
          const userMsg = this.pendingUserMsgData ?? this.buildPendingUserMessage();
          this.pendingUserMsgData = null;
          if (userMsg) {
            this.notifyUserMessageToUI(userMsg);
            this.mutableMessages.push(userMsg);
          }
        } else {
          this.pendingUserMsgData = null;
        }
        this.pendingUserMessage = null;
      } else {
        this.consumeAgentMessages(true);
      }

      this.startPersist(this.persistUnpersistedMessages());

      // ---- 执行查询循环 ----
      const messagesBeforeQuery = this.mutableMessages.length;

      for await (const message of query({
        sessionID: this.sesssionID,
        messages: this.mutableMessages,
        staticSystemPrompt: this.fullSystemPrompt!,
        getPromptState: () => this.getPromptStateForQuery(),
        getModelConfig: () => this.getEffectiveModelConfig(),
        toolUseContext: {
          abortController,
          getAppState: () => this.internalAppState,
          setAppState: (updater: (prev: unknown) => unknown) => {
            this.internalAppState = updater(this.internalAppState) as Record<string, unknown>;
          },
          messages: this.mutableMessages,
          sessionId: this.sesssionID,
          role: this.role,
        },
        querySource: 'sdk',
        maxTurns,
        ui: this.config.ui,
        silent: false,
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
   * 丢弃尚未消费的后台 Bash 任务完成通知。
   * 用户 abort 后，已排队但未进入 LLM 上下文的后台任务结果不应再被消费。
   */
  private discardBackgroundTaskNotifications(): void {
    for (let i = this.agentMessageQueue.length - 1; i >= 0; i--) {
      const content = this.agentMessageQueue[i]?.content ?? '';
      if (content.includes('**Background task completed**')) {
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
      const count = abortBackgroundTasksForSession(this.sesssionID);
      if (count > 0) {
        logger.info('QueryEngine', `Aborted ${count} background task(s) for ${this.sesssionID}`);
      }
    } catch (err) {
      logger.warn('QueryEngine', `Failed to abort background tasks for ${this.sesssionID}: ${err}`);
    }
  }

  /**
   * 递归中止当前会话及其所有子对话。
   * 子对话的后台 Bash 任务同样会被中止，结果直接丢弃。
   */
  private interruptRecursive(visited: Set<string>): void {
    if (visited.has(this.sesssionID)) return;
    visited.add(this.sesssionID);
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
      for (const childId of subAgentRegistry.listForCreator(this.sesssionID)) {
        const record = subAgentRegistry.get(childId);
        if (record?.engine) {
          record.engine.interruptRecursive(visited);
        }
      }
    } catch (err) {
      logger.warn('QueryEngine', `Failed to interrupt child sessions for ${this.sesssionID}: ${err}`);
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
        const result = await appendMessage(msg, this.sesssionID, this.resolvePersistParentUuid(msg));
        this.lastPersistedMessageUuid = result.uuid;
        (msg as any)._persisted = true;
      } catch (err) {
        logger.warn('QueryEngine', `appendSelfMessage: failed to persist: ${err}`);
      }
    })();
  }
}

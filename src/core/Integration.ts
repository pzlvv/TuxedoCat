/**
 * VSCode 扩展与 QueryEngine 的桥接层
 */

import { QueryEngine, getSessionEngine } from './QueryEngine.js';
import { getAllTools } from './tools/index.js';
import type { Message, MessageData } from './types.js';
import type { Tool } from './tools/Tool.js';
import type { PromptPresetId } from './prompt/PromptPreset.js';
import type { LLMConfig } from './llm/config.js';
import { sameModelRef, type ModelRef } from './llm/modelRef.js';
import { requireEventBus, type CoreEvent, type UiEvent } from './AssistantEventBus.js';
import type { UserMessage } from './types.js';
import { buildUserContent } from './utils/contentBlocks.js';
import { markSessionWaiting } from './sessionRuntime.js';
import { getMCPHost } from './mcp/MCPHost.js';
import { getSettings } from './settings.js';
import { logger } from './Logger.js';
import { getProjectRoot } from './history/Config.js';
import { sessionQueue } from './SessionQueue.js';
import { userChoiceQueue } from './UserChoiceQueue.js';
import { isCompacting, isPendingCompact, markPendingCompact, unmarkPendingCompact } from './compact/state.js';

/**
 * 初始化会话队列回调
 * 必须在扩展激活时调用一次
 */
export function initializeSessionQueue(): void {
  sessionQueue.setCallbacks({
    onDisplayMessage: (sessionId: string, data: MessageData) => {
      emitToUi({ type: 'message', sessionId, data });
    },
    onProcessUserMessage: async () => {
      // 由 sendMessage 路径处理
    },
  });
}

/** core → UI 单向事件的发送侧封装（Integration 内统一走它，便于 grep 对照第 4.1 节允许清单） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/** `UiEvent.userMessageSubmitted` 的载荷 */
export type UserMessageSubmission = Extract<UiEvent, { type: 'userMessageSubmitted' }>;

/**
 * 用户消息进入引擎的唯一入口（core 侧）。
 *
 * 宿主只发 `userMessageSubmitted`；这里负责取 / 建引擎、应用本次消息携带的会话覆盖、
 * 组装待处理消息对象并交给引擎队列。命令解析与 Skill 注入发生在引擎的消费循环
 * （轮次边界，见 `docs/user-message-pipeline.md`）。
 */
export async function submitUserMessage(payload: UserMessageSubmission): Promise<void> {
  const { sessionId, content, uuid } = payload;
  const images = payload.images;

  const engine = getSessionEngine(sessionId) ?? createEngine(sessionId, '');

  if (payload.agentMode) {
    // agentMode 归 core（取代原 UI 层 Map）；随消息路径同步进 core 存储
    const { setSessionAgentMode } = await import('./tools/PermissionPolicy.js');
    setSessionAgentMode(sessionId, payload.agentMode);
  }

  if (payload.thinkingMode) {
    engine.thinkingModeOverride = payload.thinkingMode;
  }

  if (payload.model) {
    const ref = payload.model;
    if (
      engine.modelRefOverride?.provider !== ref.provider ||
      engine.modelRefOverride?.model !== ref.model
    ) {
      try {
        engine.modelRefOverride = ref;
        engine.updateModelConfig({ model: ref.model } as LLMConfig);
        const { getConfigForProvider } = await import('./llm/config.js');
        const config = await getConfigForProvider(ref);
        engine.updateModelConfig(config);
        const { updateConversationContext } = await import('./history/index.js');
        await updateConversationContext(sessionId, { model: ref.model, provider: ref.provider });
      } catch (error) {
        logger.warn(
          'Integration',
          `Failed to apply model "${ref.model}" for session ${sessionId}: ${error}`,
        );
      }
    }
  }

  if (typeof payload.webSearch === 'boolean') {
    engine.updateWebSearch(payload.webSearch);
  }

  const selectedLines = payload.fileSelectedLines;
  const userContent = buildUserContent(content, images);

  // 落盘格式：文件信息同时写入顶层字段与 _meta，
  // 避免只带顶层字段导致历史加载/压缩展开时无法还原文件标签。
  const persistMeta: Record<string, unknown> = {};
  if (payload.filePath) {
    const fileName = payload.filePath.split(/[/\\]/).pop();
    const range = selectedLines
      ? `:${selectedLines.start}${selectedLines.start !== selectedLines.end ? `~${selectedLines.end}` : ''}`
      : '';
    persistMeta.filePath = payload.filePath;
    persistMeta.param = `${fileName}${range}`;
  }
  if (selectedLines) {
    persistMeta.fileSelectedLines = selectedLines;
  }

  const userMsg: UserMessage = {
    type: 'user',
    message: { role: 'user', content: userContent },
    uuid,
    timestamp: Date.now(),
    // 只有用户主动发送的消息才更新 meta.json 的 updatedAt（列表按最后一条用户消息排序）
    _userInitiated: true,
    ...(payload.filePath && { filePath: payload.filePath }),
    ...(selectedLines && { fileSelectedLines: selectedLines }),
    ...(payload.fileHidden && { fileHidden: true }),
  };
  if (Object.keys(persistMeta).length > 0) {
    userMsg._meta = persistMeta;
  }
  if (payload.deferEcho) {
    // 命令消息：宿主不乐观回显，由 QueryEngine 在真正进入上下文时补发 addMessage；
    // 内置命令就地执行、不进入上下文，因此不会留下幽灵气泡。
    (userMsg as UserMessage & { _needsUINotification?: boolean })._needsUINotification = true;
  }

  // 提交到引擎队列：设置 pendingUserMessage，使消息在下次 LLM 请求时被带上。
  // 若 consumer 正在运行，submitMessage 会等待其退出（消息已被现有 consumer
  // 在 while 循环中消费）；若已退出，则启动新的 consumer 处理该消息。
  for await (const _ of engine.submitMessage(content, 'user', undefined, {
    manageQueryUI: true,
    // 消息未 push 到 mutableMessages，consumer 处理时用此对象现场追加
    userMsgData: userMsg,
  })) {
    void _;
  }
}

/**
 * 中止指定会话的整棵工作树（引擎 + 后台 Bash + 递归子代理）。
 * @param sessionId - 要中止的会话 ID
 */
export function abortCurrentQuery(sessionId: string): void {
  void abortSessionScope(sessionId, new Set<string>());
}

/**
 * 中止一个会话及其递归子代理的运行中工作。
 *
 * abort 按钮的可用性是「会话非空闲」（见 `isSessionIdle`），而不是「引擎在消费」——
 * 所以这里必须递归覆盖三类残留工作，任一类还在都能被立刻停掉（幂等）：
 * - 引擎在池里 → `engine.interrupt()`（内部已递归中止子对话的后台 Bash 与子代理）
 * - 该会话的后台 Bash 任务 → 无论引擎在不在都直接中止（引擎已释放时只有这条路）
 * - 子代理 → 递归 `abortSessionScope`（父引擎已释放但子代理还在跑时兜底）
 */
async function abortSessionScope(sessionId: string, visited: Set<string>): Promise<void> {
  if (!sessionId || visited.has(sessionId)) return;
  visited.add(sessionId);

  // 1. 引擎在池里 → interrupt()（内部递归覆盖子会话的后台 Bash 与子代理）
  const engine = getSessionEngine(sessionId);
  if (engine) {
    engine.interrupt();
  } else {
    logger.warn('Integration', `No query engine found for session ${sessionId} to abort; aborting background tasks`);
  }

  // 2. 无论引擎在不在，都直接中止该会话的后台 Bash 任务（引擎已释放时只有这条路；
  //    引擎在时 interrupt() 已覆盖，这里是幂等兜底）。
  try {
    const { abortBackgroundTasksForSession } = await import('./tools/bash/LocalShellTask.js');
    abortBackgroundTasksForSession(sessionId);
  } catch (err: unknown) {
    logger.warn('Integration', `Failed to abort background tasks for session ${sessionId}: ${err}`);
  }

  // 3. 递归子代理：父引擎还在时 interrupt() 已覆盖，这里兜底「父引擎已释放但子代理还在跑」的情况
  try {
    const { subAgentRegistry } = await import('./tools/agent/SubAgentRegistry.js');
    for (const childId of subAgentRegistry.listForCreator(sessionId)) {
      await abortSessionScope(childId, visited);
    }
  } catch (err: unknown) {
    logger.warn('Integration', `Failed to abort sub-agents for session ${sessionId}: ${err}`);
  }
}

/**
 * 待应用的 thinking mode 覆盖值（引擎尚未创建时缓存，引擎创建后应用）
 * 场景：从历史加载对话时，webview 在 restoreConversationEngine 完成前
 * 就会发送 setThinkingMode 消息，此时引擎尚不存在，若直接丢弃会导致
 * 引擎的 thinkingModeOverride 缺失，LLM 请求会回退到 'off' 而不是
 * settings.json 中配置的默认值。
 */
const pendingSessionThinkingModes = new Map<string, 'off' | 'low' | 'high' | 'max'>();

/**
 * 将缓存的 thinking mode 覆盖值应用到刚创建的引擎（如果有）
 * 在 createEngine / restoreConversationEngine 创建引擎后调用
 */
function applyPendingThinkingMode(sessionId: string, engine: QueryEngine): void {
  const pending = pendingSessionThinkingModes.get(sessionId);
  if (pending !== undefined) {
    engine.thinkingModeOverride = pending;
    pendingSessionThinkingModes.delete(sessionId);
  }
}

/**
 * 设置指定会话的 thinking mode 覆盖值
 * 供 core 在收到 setThinkingMode 消息时调用
 */
export function setSessionThinkingMode(sessionId: string, mode: 'off' | 'low' | 'high' | 'max'): void {
  const engine = getSessionEngine(sessionId);
  if (engine) {
    engine.thinkingModeOverride = mode;
  } else {
    // 引擎尚未创建（如历史对话恢复中），缓存覆盖值，等引擎创建后应用
    pendingSessionThinkingModes.set(sessionId, mode);
  }
}

/**
 * 获取指定会话的 thinking mode 覆盖值
 * 供 Query 层在调用 LLM API 时使用
 */
export function getSessionThinkingMode(sessionId: string): 'off' | 'low' | 'high' | 'max' | undefined {
  const engine = getSessionEngine(sessionId);
  return engine?.thinkingModeOverride;
}

/**
 * 待应用的 prompt 模式（引擎尚未创建时缓存，引擎创建后应用）
 * 场景：切换会话时 webview 先发送 setPromptMode，而 restoreConversationEngine
 * 尚未完成（引擎异步创建），若直接丢弃会导致该会话的模式丢失。
 */
const pendingSessionPromptModes = new Map<string, PromptPresetId>();

/**
 * 将缓存的 prompt 模式应用到刚创建的引擎（如果有）
 * 在 createEngine / restoreConversationEngine 创建引擎后调用
 */
function applyPendingPromptMode(sessionId: string, engine: QueryEngine): void {
  const pending = pendingSessionPromptModes.get(sessionId);
  if (pending !== undefined) {
    engine.setPromptPreset(pending);
    pendingSessionPromptModes.delete(sessionId);
  }
}

/**
 * 设置指定会话的提示词预设（普通 / 极简 / 混合）
 * 供 core 在收到 setPromptMode 消息时调用；
 * meta.json 的持久化由 core 的会话配置处理负责。
 */
export function setSessionPromptPreset(sessionId: string, presetId: PromptPresetId): void {
  const engine = getSessionEngine(sessionId);
  if (engine) {
    engine.setPromptPreset(presetId);
  } else {
    // 引擎尚未创建（如历史对话恢复中），缓存覆盖值，等引擎创建后应用
    pendingSessionPromptModes.set(sessionId, presetId);
  }
}

/**
 * 待应用的模型切换（引擎尚未创建时缓存，引擎创建后应用）
 * 场景：新对话在发送第一条消息前切换模型，此时 engine/meta.json 都不存在；
 * 如果只依赖 setSessionModel 直接更新 engine，模型选择会丢失并回退到默认模型。
 */
const pendingSessionModels = new Map<string, ModelRef>();

/**
 * 用模型身份构造完整 LLMConfig 并写入引擎。
 *
 * 竞态保护：等待读盘期间用户可能又切换了模型，过期结果不得覆盖最新选择。
 * 这里比较完整的 (provider, model)：只比 model 会在「同名模型换 provider」时失效
 * （旧 provider 的 baseURL/apiKey 会覆盖掉新 provider 的）。
 */
async function applySessionModelConfig(engine: QueryEngine, ref: ModelRef): Promise<void> {
  const { getConfigForProvider } = await import('./llm/config.js');
  const config = await getConfigForProvider(ref);
  if (engine.modelRefOverride && !sameModelRef(engine.modelRefOverride, ref)) return;
  engine.modelRefOverride = ref;
  engine.updateModelConfig(config);
}

/**
 * 将缓存的模型覆盖值应用到刚创建的引擎（如果有）
 * 在 createEngine / restoreConversationEngine 创建引擎后调用
 */
function applyPendingModel(sessionId: string, engine: QueryEngine): void {
  const pending = pendingSessionModels.get(sessionId);
  if (pending === undefined) return;
  pendingSessionModels.delete(sessionId);
  // 先同步写入 model 字段；随后异步加载该 provider 的全量配置（baseURL/apiKey/modelConfigs）。
  engine.modelRefOverride = pending;
  engine.updateModelConfig({ model: pending.model } as LLMConfig);
  void applySessionModelConfig(engine, pending).catch((e) => {
    logger.warn('Integration', `Failed to apply pending model config: ${e}`);
  });
}

/**
 * 当前 active provider 的默认模型身份（core 内部回退用）。
 *
 * 只读配置快照：宿主已经把默认值补好，core 不做任何补默认的动作。
 * 未配置 activeProvider / provider 缺 baseURL 时返回 undefined。
 */
function activeModelRefFromSnapshot(): ModelRef | undefined {
  const llm = getSettings().llm;
  const provider = llm.activeProvider ? llm.providers[llm.activeProvider] : undefined;
  if (!provider?.baseURL) return undefined;
  return { provider: llm.activeProvider, model: provider.defaultModel };
}

/**
 * 设置指定会话的模型身份（provider + model）
 * 供 core 在收到 setModel 消息时调用；
 * meta.json 的持久化由 core 的会话配置处理负责。
 */
export function setSessionModel(sessionId: string, ref: ModelRef): void {
  const engine = getSessionEngine(sessionId);
  if (engine) {
    // 先同步写入 model 字段，避免异步加载全量配置时被后续切换覆盖；
    // 随后异步加载该 provider 的全量配置（baseURL/apiKey/modelConfigs）。
    engine.modelRefOverride = ref;
    engine.updateModelConfig({ model: ref.model } as LLMConfig);
    void applySessionModelConfig(engine, ref).catch((e) => {
      logger.warn('Integration', `Failed to apply session model config: ${e}`);
    });
  } else {
    // 引擎尚未创建（如新对话发送首条消息前、历史对话恢复中），缓存模型身份，
    // 等引擎创建后由 applyPendingModel / sendMessage 应用。
    pendingSessionModels.set(sessionId, ref);
  }
}

/**
 * 预热会话工作目录的系统动态信息（git 信息 / 技能清单等）。
 *
 * 缓存按 cwd 分桶，同一目录的多个会话只算一次；预热只是性能优化——失败只记日志，
 * 未预热时 `getSystemDynamicInfo` 会在使用时现算。
 */
function warmupSessionWorkspace(sessionId: string): void {
  let cwd: string;
  try {
    cwd = getProjectRoot(sessionId);
  } catch {
    // 会话尚未登记工作目录：无从预热（此时也不会创建引擎）
    return;
  }
  void import('./prompt/SystemEnvironment.js')
    .then(({ warmupSystemDynamicInfo }) => warmupSystemDynamicInfo(cwd))
    .catch((err: unknown) => {
      logger.warn('Integration', `Failed to warm up system info for ${cwd}: ${err}`);
    });
}

/**
 * 为指定会话创建 QueryEngine（预初始化）
 *
 * 在用户发消息前预先创建 engine，确保：
 * - 会话元数据（meta.json）预创建，webview 加载时文件已存在
 * - @ workspace 远程消息时 source engine 已存在，appendSelfMessage 能正常执行
 *
 * @param sessionId - 会话 ID
 * @param title - 会话标题
 * @param role - 可选，会话角色（默认 'Master'）
 * @returns 创建的 QueryEngine 实例，或已存在的实例
 */
export function createEngine(sessionId: string, title: string, role?: string): QueryEngine {
  const existing = getSessionEngine(sessionId);
  if (existing) {
    return existing;
  }
  // 会话被创建/打开：MCP 引用按该会话启用列表建立（幂等）
  void getMCPHost().onSessionOpened(sessionId).catch((err: unknown) => {
    logger.warn('Integration', `MCP onSessionOpened failed: ${err}`);
  });
  warmupSessionWorkspace(sessionId);

  const engine = new QueryEngine(sessionId, {
    cwd: getProjectRoot(sessionId),
    tools: getAllTools() as Tool[],
    getAppState: () => ({}),
    setAppState: () => { },
    initialMessages: [],
    title,
    role: role || 'Master',
  });

  // 应用之前缓存下来的 thinking mode 覆盖值（若引擎创建前用户已切换过模式）
  applyPendingThinkingMode(sessionId, engine);
  // 应用之前缓存下来的 prompt 模式覆盖值（若引擎创建前用户已切换过模式）
  applyPendingPromptMode(sessionId, engine);
  // 应用之前缓存下来的模型切换值（若引擎创建前用户已切换过模型）
  applyPendingModel(sessionId, engine);
  return engine;
}

/**
 * 请求用户选择 - 供 RunTools 权限确认和 AskUserQuestion 工具调用
 * 权限决策已经算完（RunTools / PermissionPolicy），这里只处理用户确认对话框
 *
 * 该函数会把用户选择请求登记到 UserChoiceQueue（per-session 状态），而不是直接弹出对话框：
 * - 会话已 open 时立即投递，由该会话自己的视图 / webview 弹出（多视图下即使该视图
 *   未被选中也会显示在那里，切过去即可看到；单视图下 open == 当前会话）
 * - 会话未 open 时保留 pending，不切换会话；等该会话 open 后由 onSessionLoaded 重新投递
 *
 * 入队即把该会话标记为「等待用户」（sessionRuntime.waiting）：UI 据此提醒用户
 * （Single View 历史对话按钮呼吸效果 / Electron 侧栏黄灯 / 托盘状态点）。
 */
export async function requestUserChoice(
  sessionID: string,
  toolName: string,
  permResult: { behavior: 'ask'; message?: string; choices?: Array<{ label: string; description?: string }> } & Record<string, unknown>,
): Promise<{ index: number; reply?: string }> {
  // 构建用户选择选项
  const options = {
    toolName,
    message: permResult.message || '请确认是否执行此操作',
    choices: permResult.choices || [
      { label: '允许', description: '继续执行' },
      { label: '拒绝', description: '取消操作' },
    ],
    showPreview: permResult.showPreview as boolean | undefined,
    previewContent: permResult.previewContent as string | undefined,
    previewTitle: permResult.previewTitle as string | undefined,
    beforeContent: permResult.beforeContent as string | undefined,
    afterContent: permResult.afterContent as string | undefined,
    contextBefore: permResult.contextBefore as string[] | undefined,
    contextAfter: permResult.contextAfter as string[] | undefined,
  };

  // 未初始化 UserChoiceQueue 时（宿主未注册队列回调），退化为直接发总线请求，
  // 避免登记 pending 后没有回调投递导致 Promise 永远不会 resolve。
  // 该路径由 UserChoiceManager.requestUserChoice 标记 waiting（弹出时才标记）。
  if (!userChoiceQueue.isInitialized()) {
    return requireEventBus().request({ type: 'userChoice', sessionId: sessionID, options });
  }

  // 入队即视为「该会话等待用户」：即使请求尚未投递（会话未 open），
  // 会话运行时状态也立即变 waiting，供 UI 提醒用户（不自动切换会话）。
  // 用户响应后由 UserChoiceManager 的 resolve 回调解除。
  markSessionWaiting(sessionID, true);

  // 登记请求；返回的 Promise 会在用户做出选择后 resolve
  const userChoice = await userChoiceQueue.enqueue(sessionID, options);

  return userChoice;
}

/**
 * 从历史记录恢复 QueryEngine
 * 当从历史记录加载对话时调用，将历史消息注入引擎
 * 这样后续 sendMessage 时无需重新创建引擎，历史消息直接可用
 */
export async function restoreConversationEngine(sessionID: string, messages: Message[], role?: string): Promise<void> {
  if (getSessionEngine(sessionID)) {
    return;
  }
  // 会话被打开（加载历史 / 恢复引擎）：MCP 引用建立（幂等）
  void getMCPHost().onSessionOpened(sessionID).catch((err: unknown) => {
    logger.warn('Integration', `MCP onSessionOpened failed: ${err}`);
  });
  warmupSessionWorkspace(sessionID);

  // 如果调用方没有传入 role，尝试从 meta 中读取
  let conversation: any = undefined;
  if (role === undefined) {
    try {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
      role = conversation.metadata.role;
    } catch (e) {
      logger.error('Integration', `读取对话 role 失败: ${e}`);
    }
  }

  const engine = new QueryEngine(sessionID, {
    cwd: getProjectRoot(sessionID),
    tools: getAllTools() as Tool[],
    getAppState: () => ({}),
    setAppState: () => { },
    initialMessages: messages,
    role,
  });

  // 为恢复的对话设置 per-session modelConfig：优先使用 meta.json 中保存的模型身份，
  // 未记录 provider 时取 settings.json 的 active provider（唯一回退来源）。
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const { getConversationModelRef } = await import('./history/index.js');
    const { getConfigForProvider } = await import('./llm/config.js');
    const ref = getConversationModelRef(conversation?.metadata) ?? activeModelRefFromSnapshot();
    if (!ref) {
      logger.warn('Integration', `No usable model for restored session ${sessionID} (provider 未配置)`);
    } else {
      engine.modelRefOverride = ref;
      const config = await getConfigForProvider(ref);
      engine.updateModelConfig(config);
    }
  } catch (e) {
    logger.warn('Integration', `Failed to set per-session model config for restored engine: ${e}`);
  }

  // 如果用户在恢复过程中已经切换过模型，则用最新选择覆盖 meta.json 中保存的模型
  applyPendingModel(sessionID, engine);

  // 为恢复的对话设置 thinking mode 覆盖值：
  // 优先使用 meta.json 中保存的 thinkingMode（用户在该对话中的显式选择），
  // 未配置时回退到 settings.json 中的默认值（llm.thinking_effort）。
  // 否则引擎的 thinkingModeOverride 为 undefined，LLM 请求会被当作 'off' 处理，
  // 与"从历史加载的对话，未配置 thinking effort 时回退到配置默认值"的行为不一致。
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const perSessionThinkingMode = conversation?.metadata?.context?.thinkingMode as 'off' | 'low' | 'high' | 'max' | undefined;
    if (perSessionThinkingMode) {
      engine.thinkingModeOverride = perSessionThinkingMode;
    } else {
      const { getDefaultThinkingEffort } = await import('./llm/config.js');
      engine.thinkingModeOverride = await getDefaultThinkingEffort();
    }
  } catch (e) {
    logger.warn('Integration', `Failed to set thinking mode for restored engine: ${e}`);
  }

  // 为恢复的对话设置会话关联的 Web Search 开关：
  // 优先使用 meta.json 中保存的 webSearch（用户在该对话中的显式选择），
  // 未配置时回退到 settings.json 中的默认值（llm.webSearch）
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const perSessionWebSearch = conversation?.metadata?.context?.webSearch as boolean | undefined;
    const { getDefaultWebSearch } = await import('./llm/config.js');
    const defaultWebSearch = await getDefaultWebSearch();
    const effectiveWebSearch = typeof perSessionWebSearch === 'boolean' ? perSessionWebSearch : defaultWebSearch;
    engine.updateWebSearch(effectiveWebSearch);
  } catch (e) {
    logger.warn('Integration', `Failed to set webSearch for restored engine: ${e}`);
  }

  // 为恢复的对话设置提示词预设：
  // 优先使用 meta.json 中保存的 promptMode（用户在该对话中的显式选择），
  // 未配置时取配置快照的默认值（默认值的唯一来源，见 `docs/webview-facts.md` 第 2 节）。
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const perSessionPromptMode = conversation?.metadata?.context?.promptMode as 'normal' | 'minimal' | 'mixed' | undefined;
    const { isPromptPresetId } = await import('./prompt/PromptPreset.js');
    const effectivePromptMode = isPromptPresetId(perSessionPromptMode)
      ? perSessionPromptMode
      : getSettings().defaultPromptMode;
    engine.setPromptPreset(effectivePromptMode);
  } catch (e) {
    logger.warn('Integration', `Failed to set prompt mode for restored engine: ${e}`);
  }

  // 应用之前缓存下来的 thinking mode 覆盖值（若引擎创建前 webview 已发送过 setThinkingMode）
  applyPendingThinkingMode(sessionID, engine);

  // 应用之前缓存下来的 prompt 模式覆盖值（若引擎创建前 webview 已发送过 setPromptMode）
  applyPendingPromptMode(sessionID, engine);

  // 设置 lastPersistedMessageUuid，确保后续新增消息的 parentUuid 正确链接到最后一条历史消息
  // 从 messages 中找到最后一条带有 uuid 的消息
  // 注意：跳过 tool_recovered_* 合成消息。这类消息由 ensureToolResults 在恢复时生成，
  // 如果它位于 messages 末尾，会被误选为 lastPersistedMessageUuid，导致后续持久化时
  // 出现自引用 parentUuid（parentUuid === 自身），使消息链在 BFS 遍历时断裂。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg.uuid && typeof msg.uuid === 'string' && !msg.uuid.startsWith('tool_recovered_')) {
      engine.setLastPersistedMessageUuid(msg.uuid);
      break;
    }
  }

}

/**
 * 请求手动压缩对话
 * 从 webview 触发，压缩历史消息并保留摘要
 *
 * 分两种情况：
 * - 会话空闲：直接开始压缩（原行为）。
 * - 会话非空闲（consumer 运行中 / 有后台任务或子代理）：立即压缩会与运行中的查询
 *   并发改写 mutableMessages（新消息被压缩掉 / 压缩结果被覆盖），因此只登记"待压缩"，
 *   视为"已达到需要压缩的条件"，由下一轮对话开始时（Query.ts 的自动压缩检查）执行；
 *   若之后不再有下一轮对话（例如用户在最后一轮点了压缩），则由 QueryEngine 在消费循环
 *   退出时补判一次并执行。
 *
 * 不满足压缩条件（边界之后的消息不足 maxMessagesToKeep，没有可摘要的内容）时不做任何处理。
 */
export async function requestCompact(sessionId: string): Promise<void> {
  const engine = getSessionEngine(sessionId);
  if (!engine) {
    logger.warn('Integration', `No engine found for session: ${sessionId}`);
    return;
  }

  // 不满足压缩条件：不做任何处理（不排队、不通知 UI、不替换消息）。
  {
    const { hasCompactableMessages } = await import('./compact/index.js');
    if (!hasCompactableMessages(engine.getMessages())) {
      logger.info('Integration', `No compactable messages for session ${sessionId}, ignoring compress request`);
      return;
    }
  }

  // 已在压缩中：忽略重复请求，避免并发压缩互相覆盖上下文。
  if (isCompacting(sessionId)) {
    logger.info('Integration', `Compact already in progress for session ${sessionId}, ignoring request`);
    return;
  }

  // 非空闲判定走 sessionResources.isSessionIdle（唯一入口）：
  // 消费循环 / 后台任务 / 子代理 / 压缩 / 等用户确认任一是真，都不能就地压缩
  // （压缩会整体替换 mutableMessages，与运行中的查询并发会互相覆盖）。
  let busy = false;
  try {
    const { isSessionIdle } = await import('./sessionResources.js');
    busy = !(await isSessionIdle(sessionId));
  } catch {
    busy = false;
  }
  if (busy) {
    if (!isPendingCompact(sessionId)) {
      markPendingCompact(sessionId);
      logger.info('Integration', `Session ${sessionId} is busy, compact deferred to next turn`);
      emitToUi({
        type: 'message',
        sessionId,
        data: { role: 'system', content: '当前会话正在处理中，压缩已排队，将在本轮对话结束后执行。' },
      });
    } else {
      logger.info('Integration', `Session ${sessionId} already has a pending compact request`);
    }
    return;
  }

  try {
    // 立即压缩：清掉可能存在的"待压缩"标记，避免本轮压缩完成后下一轮又重复压缩一次。
    unmarkPendingCompact(sessionId);
    const { compactAndApplyMessages } = await import('./compact/index.js');

    // 就地替换消息 + 落盘 + 更新 meta + 通知 UI 重放，统一由 compactAndApplyMessages 处理。
    const applied = await compactAndApplyMessages(sessionId, engine.getMessages());

    // 不满足压缩条件（消息在检查后发生变化）：不做任何处理。
    if (!applied) {
      logger.info('Integration', `Compact skipped for session ${sessionId} (no messages to summarize)`);
      return;
    }

    // 重置引擎中的 lastPersistedMessageUuid，指向压缩后最后一条消息的 uuid
    const messages = engine.getMessages();
    const lastMsg = messages[messages.length - 1];
    const lastUuid = lastMsg && 'uuid' in lastMsg ? (lastMsg as any).uuid : null;
    if (lastUuid) {
      engine.lastPersistedMessageUuid = lastUuid;
    }

  } catch (error) {
    logger.error('Integration', `Compact failed for session ${sessionId}:`, error);

    emitToUi({ type: 'compactEnd', sessionId, result: { status: 'error' } });

    emitToUi({
      type: 'message',
      sessionId,
      data: { role: 'system', content: `压缩失败: ${error instanceof Error ? error.message : String(error)}` },
    });
  } finally {
    // 压缩期间新发的消息只入队不消费（见 compact/state.ts），这里统一唤醒一次，
    // 否则用户压缩时发的消息会一直卡在队列里没人处理。
    engine.resumeAfterCompact();
  }
}

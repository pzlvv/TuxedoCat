/**
 * VSCode 扩展与 QueryEngine 的桥接层
 */

import { QueryEngine, getSessionEngine } from './QueryEngine.js';
import { getAllTools } from './tools/index.js';
import type { Message } from './types.js';
import type { Tool } from './tools/Tool.js';
import type { PromptPresetId } from './prompt/PromptPreset.js';
import type { LLMConfig } from './llm/config.js';
import type { AssistantUI } from './AssistantUI.js';
import { getGlobalUI } from './AssistantUI.js';
import { logger } from './Logger.js';
import { addToHistory, registerCleanup, setProjectRootProvider, replaceConversationMessages, updateConversationContext } from './history/index.js';
import { getProjectRoot } from './history/Config.js';
import { sessionQueue } from './SessionQueue.js';
import { userChoiceQueue } from './UserChoiceQueue.js';
import { replayMessagesToUI } from './utils/replayMessages.js';
import { buildUserContent, extractUserContent } from './utils/contentBlocks.js';

/**
 * 初始化会话队列回调
 * 必须在扩展激活时调用一次
 */
export function initializeSessionQueue(): void {
  const ui = getUI();
  const { setGlobalUI } = require('./AssistantUI.js');
  setGlobalUI(ui);
  sessionQueue.setCallbacks({
    onDisplayMessage: (sessionId: string, data: import('./AssistantUI.js').MessageData) => {
      ui.onMessage(sessionId, data);
    },
    onProcessUserMessage: async () => {
      // 由 sendMessage 路径处理
    },
  });
}

// 注册进程退出时的历史清理
registerCleanup();

// 当前活跃的查询引擎（用于中止）
let currentQueryEngine: QueryEngine | null = null;

/**
 * 中止当前查询
 * @param sessionId - 可选，指定要中止的会话 ID；不指定则中止 currentQueryEngine
 */
export function abortCurrentQuery(sessionId?: string): void {
  if (sessionId) {
    const engine = getSessionEngine(sessionId);
    if (engine) {
      engine.interrupt();
    } else {
      logger.warn('Integration', `No query engine found for session ${sessionId} to abort`);
    }
    return;
  }
  if (currentQueryEngine) {
    currentQueryEngine.interrupt();
    currentQueryEngine = null;
  } else {
    logger.warn('Integration', 'No query engine to abort');
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
 * 供 VSCodeUI 在收到 setThinkingMode 消息时调用
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
 * 供 VSCodeUI 在收到 setPromptMode 消息时调用；
 * meta.json 的持久化由 VSCodeUI 负责。
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
 * 如果只依赖 handleSetModel 直接更新 engine，模型选择会丢失并回退到默认模型。
 */
const pendingSessionModels = new Map<string, string>();

/**
 * 将缓存的模型覆盖值应用到刚创建的引擎（如果有）
 * 在 createEngine / restoreConversationEngine 创建引擎后调用
 */
function applyPendingModel(sessionId: string, engine: QueryEngine): void {
  const pending = pendingSessionModels.get(sessionId);
  if (pending !== undefined) {
    pendingSessionModels.delete(sessionId);
    // 这里只需先写入 model 字段；sendMessage/LLM 调用会与 settings.json 的全量配置合并。
    engine.updateModelConfig({ model: pending } as LLMConfig);
  }
}

/**
 * 设置指定会话的模型覆盖值
 * 供 VSCodeUI 在收到 setModel 消息时调用；
 * meta.json 的持久化由 VSCodeUI 负责。
 */
export function setSessionModel(sessionId: string, model: string): void {
  const engine = getSessionEngine(sessionId);
  if (engine) {
    // 先同步写入 model 字段，避免异步加载全量配置时被后续切换覆盖；
    // LLM 请求时会与 settings.json 的全量配置合并。
    engine.updateModelConfig({ model } as LLMConfig);
  } else {
    // 引擎尚未创建（如新对话发送首条消息前、历史对话恢复中），缓存覆盖值，
    // 等引擎创建后由 applyPendingModel / sendMessage 应用。
    pendingSessionModels.set(sessionId, model);
  }
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

  const ui = getUI();
  const engine = new QueryEngine(sessionId, {
    cwd: getProjectRoot(),
    tools: getAllTools() as Tool[],
    getAppState: () => ({}),
    setAppState: () => { },
    initialMessages: [],
    ui,
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
 * 初始化历史记录系统
 * 应在扩展激活时调用，传入 VSCodeUI 实例以获取 workspace 路径
 */
export function initializeHistory(ui?: { getWorkspacePath(): string | undefined }): void {
  if (ui && 'getWorkspacePath' in ui) {
    setProjectRootProvider(() => ui.getWorkspacePath());
  } else {
    logger.warn(
      'Integration',
      'History system initialized without workspace provider. ' +
      'getProjectRoot() will throw an error until a provider is set.'
    );
  }
}

/**
 * 获取 UI 实例
 */
function getUI(): AssistantUI {
  const ui = getGlobalUI();
  if (!ui) throw new Error('UI not initialized. Call setGlobalUI() first.');
  return ui;
}

/**
 * 请求用户选择 - 供 RunTools 权限确认和 AskUserQuestion 工具调用
 * onPreToolCall 已经计算了权限结果，这里只处理用户确认对话框
 *
 * 该函数会将用户选择请求加入全局队列，而不是直接弹出对话框。
 * UserChoiceQueue 维护一个 FIFO 队列 + per-session 状态：
 * - 如果当前活跃 session 没有 user choice，自动从队列头部取一个，
 *   跳转到对应 session 并弹出选择框
 * - 如果当前活跃 session 已有 user choice，排队等待，等当前 choice
 *   响应后再自动跳转处理下一个
 * - 用户做出选择后自动消费队列中的下一个
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
    showDiff: permResult.showDiff as boolean | undefined,
    beforeContent: permResult.beforeContent as string | undefined,
    afterContent: permResult.afterContent as string | undefined,
    diffTitle: permResult.diffTitle as string | undefined,
    contextBefore: permResult.contextBefore as string[] | undefined,
    contextAfter: permResult.contextAfter as string[] | undefined,
  };

  // 未初始化 UserChoiceQueue 时（如 CLI 单次执行模式），退化为直接调用 UI，
  // 避免入队后没有回调消费队列导致 Promise 永远不会 resolve。
  if (!userChoiceQueue.isInitialized()) {
    const ui = getUI();
    return ui.requestUserChoice(sessionID, options);
  }

  // 将请求加入全局队列，返回的 Promise 会在用户做出选择后 resolve
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
  const ui = getUI();

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
    cwd: getProjectRoot(),
    tools: getAllTools() as Tool[],
    getAppState: () => ({}),
    setAppState: () => { },
    initialMessages: messages,
    role,
    ui,
  });

  // 为恢复的对话设置 per-session modelConfig（从 meta.json 读取，回退到 settings.json 默认值）
  // 始终设置 modelConfig，保证后续会话关联的 webSearch 能正常覆盖
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const perSessionModel = conversation?.metadata?.model || conversation?.metadata?.context?.model;
    const { getDefaultModel, getConfig: getLLMConfig } = await import('./llm/config.js');
    const globalConfig = await getLLMConfig(sessionID);
    const effectiveModel = perSessionModel || await getDefaultModel();
    engine.updateModelConfig({
      ...globalConfig,
      model: effectiveModel,
    });
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
  // 未配置时回退到普通模式。
  try {
    if (!conversation) {
      const { loadConversation } = await import('./history/index.js');
      conversation = await loadConversation(sessionID);
    }
    const perSessionPromptMode = conversation?.metadata?.context?.promptMode as 'normal' | 'minimal' | 'mixed' | undefined;
    const { isPromptPresetId } = await import('./prompt/PromptPreset.js');
    const effectivePromptMode = isPromptPresetId(perSessionPromptMode) ? perSessionPromptMode : 'normal';
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
 * 发送消息并处理响应
 */
export async function* sendMessage(
  prompt: string,
  sessionId: string,
  fileInfo?: { filePath?: string; selectedLines?: { start: number; end: number }; fileHidden?: boolean; thinkingMode?: 'off' | 'low' | 'high' | 'max'; webSearch?: boolean; model?: string; reminder?: string; upstreamSessionId?: string; upstreamHostname?: string; upstreamWorkspace?: string; promptPreset?: PromptPresetId; images?: Array<{ dataUrl: string; mediaType?: string }> },
): AsyncGenerator<Message, void, unknown> {
  const ui = getUI();

  // 创建用户消息（需要在创建 QueryEngine 之前，因为需要传入初始消息）
  const fullPrompt = fileInfo?.reminder ? prompt + '\n\n' + fileInfo.reminder : prompt;
  const userContent = buildUserContent(fullPrompt, fileInfo?.images);

  // 构建 _meta：将文件信息、参数等元数据统一存放
  const meta: Record<string, unknown> = {};
  if (fileInfo?.filePath) {
    meta.filePath = fileInfo.filePath;
    meta.param = `${fileInfo.filePath.split(/[/\\]/).pop()}${fileInfo.selectedLines ? `:${fileInfo.selectedLines.start}${fileInfo.selectedLines.start !== fileInfo.selectedLines.end ? `~${fileInfo.selectedLines.end}` : ''}` : ''}`;
  }
  if (fileInfo?.selectedLines) {
    meta.fileSelectedLines = fileInfo.selectedLines;
  }

  const userMsg: Message = {
    type: 'user',
    message: { role: 'user', content: userContent },
    uuid: `user_${Date.now()}`,
    timestamp: Date.now(),
    ...(fileInfo?.filePath && { filePath: fileInfo.filePath }),
    ...(fileInfo?.selectedLines && { fileSelectedLines: fileInfo.selectedLines }),
    ...(fileInfo?.fileHidden && { fileHidden: true }),
    ...(fileInfo?.reminder && { reminder: fileInfo.reminder }),
    ...(Object.keys(meta).length > 0 && { _meta: meta }),
  };

  // 在创建/获取 engine 之前，先通过 CommandDispatcher 检查命令类型
  const { dispatch } = await import('./CommandDispatcher.js');
  const dispatchResult = await dispatch(prompt, {
    sessionId,
    ui,
    cwd: getProjectRoot(),
  });

  if (dispatchResult.result === 'handled') {
    // 内置命令已被处理，不需要走 LLM 流程
    // 仍然 yield userMsg 让调用方知道消息已被接收
    yield userMsg;
    return;
  }

  // 获取或创建 QueryEngine（传入初始消息）
  // userMsgInContext 记录用户消息是否已加入 mutableMessages：
  // 已加入时 submitMessage 传 userMsgUuid，consumer 按 uuid 定位/重排；
  // 未加入时仅传 userMsgData，由 consumer 处理 pendingUserMessage 时现场追加。
  let userMsgInContext = false;
  const isNewSession = !getSessionEngine(sessionId);
  let engine = getSessionEngine(sessionId);
  if (!engine) {
    // 主对话（非子代理）默认 Master 角色
    engine = new QueryEngine(sessionId, {
      cwd: getProjectRoot(),
      tools: getAllTools() as Tool[],
      getAppState: () => ({}),
      setAppState: () => { },
      initialMessages: [userMsg],
      ui,
      upstreamSessionId: fileInfo?.upstreamSessionId,
      upstreamHostname: fileInfo?.upstreamHostname,
      upstreamWorkspace: fileInfo?.upstreamWorkspace,
    });
    userMsgInContext = true; // initialMessages 已包含 userMsg

    // 为新对话设置 modelConfig（从 meta.json 读取，回退到 settings.json 默认值）
    try {
      const { getDefaultModel, getConfig: getLLMConfig } = await import('./llm/config.js');
      const { loadConversation } = await import('./history/index.js');
      let conversation: any;
      try {
        conversation = await loadConversation(sessionId);
      } catch {
        // meta.json 尚不存在（新会话未初始化），使用 settings.json 默认值
      }
      const perSessionModel = conversation?.metadata?.model || conversation?.metadata?.context?.model;
      const effectiveModel = perSessionModel || await getDefaultModel();
      const globalConfig = await getLLMConfig(sessionId);
      engine.updateModelConfig({
        ...globalConfig,
        model: effectiveModel,
      });
    } catch (e) {
      logger.warn('Integration', `Failed to set per-session model config: ${e}`);
    }

    // 应用之前缓存下来的 thinking mode 覆盖值（若引擎创建前 webview 已发送过 setThinkingMode）
    applyPendingThinkingMode(sessionId, engine);
  } else {
    // 检查是否在 spin 模式
    if (engine.workMode === 'spin') {
      yield userMsg;
      return;
    }
    // 已有引擎：等待之前的持久化完成，再追加新消息
    await engine.flush().catch((e: any) => {
      logger.error('Integration', `引擎 flush 失败: ${e}`);
    });
    // 仅当 consumer 空闲时 push 到 mutableMessages：
    // - consumer 空闲：消息会在本次新启动的 consumer 的第一次 query() 中被带上；
    // - consumer 运行中：不 push，由 queryLoop 阶段 0.5（flushQueuedMessagesIntoContext）
    //   在"下一次 LLM 请求"时用 userMsgData 现场追加，使排队消息立刻进入上下文，
    //   无需等整个多轮 query 结束。
    if (!engine.isConsumerRunning) {
      engine.getMessages().push(userMsg);
      userMsgInContext = true;
    }
  }

  // 保存当前查询引擎引用（用于中止）
  currentQueryEngine = engine;

  // 应用模型切换：优先使用本次发送消息携带的模型（避免 setModel 消息尚未处理时丢失），
  // 其次使用引擎创建前缓存的模型切换；如果 meta.json 已存在则同步持久化。
  const pendingModel = pendingSessionModels.get(sessionId);
  const sendModel = fileInfo?.model || pendingModel;
  if (sendModel) {
    if (pendingModel !== undefined) {
      pendingSessionModels.delete(sessionId);
    }
    try {
      // 先同步写入 model，确保即使后续读取全量配置失败，请求仍会使用该模型。
      engine.updateModelConfig({ model: sendModel } as LLMConfig);
      const { getConfig } = await import('./llm/config.js');
      const globalConfig = await getConfig(sessionId);
      engine.updateModelConfig({ ...globalConfig, model: sendModel });
      await updateConversationContext(sessionId, { model: sendModel });
    } catch (e) {
      logger.warn('Integration', `Failed to fully apply model "${sendModel}" for session ${sessionId}: ${e}`);
    }
  }

  // 设置 thinking mode 覆盖值（'off' 也需要显式设置，以覆盖之前的高/最大值）
  if (fileInfo?.thinkingMode !== undefined) {
    engine.thinkingModeOverride = fileInfo.thinkingMode;
  }

  // 设置会话关联的提示词预设（meta.json 持久化由 VSCodeUI 的 setPromptMode 路径负责）
  if (fileInfo?.promptPreset !== undefined) {
    engine.setPromptPreset(fileInfo.promptPreset);
  }

  // 设置会话关联的 Web Search 开关（覆盖 settings.json 默认值，webview 每次发送都会带上当前值）
  if (fileInfo?.webSearch !== undefined) {
    engine.updateWebSearch(fileInfo.webSearch);
  }

  // 通知查询开始
  ui.onQueryBegin(sessionId);

  // 添加到历史记录
  if (prompt.trim()) {
    addToHistory(prompt);
  }

  // 如果是新对话，设置标题（使用消息内容的前 50 个字符）
  if (isNewSession) {
    const title = prompt.substring(0, 50);
    ui.setTitle(sessionId, title);
  }

  // 通知 UI 用户消息，包含文件信息（只显示文件名+行号，不显示 "File:" 前缀）
  // 如果 fileHidden 为 true，不发送文件信息到 UI
  const sendFilePath = fileInfo?.fileHidden ? undefined : fileInfo?.filePath;
  const sendSelectedLines = fileInfo?.fileHidden ? undefined : fileInfo?.selectedLines;
  const param = sendFilePath
    ? `${sendFilePath.split(/[/\\]/).pop()}${sendSelectedLines ? `:${sendSelectedLines.start}${sendSelectedLines.start !== sendSelectedLines.end ? `~${sendSelectedLines.end}` : ''}` : ''}`
    : undefined;

  // 构建发送到 UI 的 meta（排除 fileHidden 的情况）
  const uiMeta: Record<string, unknown> = {};
  if (sendFilePath) {
    uiMeta.filePath = sendFilePath;
    uiMeta.param = param;
  }
  if (sendSelectedLines) {
    uiMeta.fileSelectedLines = sendSelectedLines;
  }

  const { text: uiText, images: uiImages } = extractUserContent(userContent);
  ui.onMessage(sessionId, {
    role: 'user',
    content: uiText,
    images: uiImages.length > 0 ? uiImages : undefined,
    param,
    filePath: sendFilePath,
    fileSelectedLines: sendSelectedLines,
    meta: Object.keys(uiMeta).length > 0 ? uiMeta : undefined,
  });

  yield userMsg;

  // 如果是 Skill 命令（如 /archive），在用户消息已通知 UI 后、
  // submitMessage 前插入 submitToolUse，注入 Skill tool call。
  // submitToolUse 会往 mutableMessages 中添加 assistant(tool_use) + tool_result(Skill prompt)，
  // 后续 LLM query 能读到这些消息，按 Skill 指令执行。
  if (dispatchResult.result === 'skill' && dispatchResult.skillInfo) {
    const { skillName, skillArgs } = dispatchResult.skillInfo;

    try {
      await engine.submitToolUse({
        name: 'Skill',
        input: {
          skill: skillName,
          args: skillArgs || undefined,
        },
      });
    } catch (error) {
      logger.error('Integration', 'Skill tool call error:', error);
      // 不中断流程，继续走 LLM query 让 LLM 尝试处理
    }
  }

  // 执行查询（query 层会自动通知 UI）
  try {
    for await (const message of engine.submitMessage(prompt, 'user', undefined, {
      userMsgUuid: userMsgInContext ? userMsg.uuid : undefined,
      userMsgData: userMsg,
    }) as AsyncIterable<Message>) {
      yield message;
    }

    // 查询完成后清除引擎引用
    currentQueryEngine = null;
  } catch (error) {
    logger.error('Integration', 'Query error:', error);
    throw error;
  } finally {
    ui.onQueryEnd(sessionId);
    currentQueryEngine = null;
  }
}

/**
 * 请求手动压缩对话
 * 从 webview 触发，压缩历史消息并保留摘要
 */
export async function requestCompact(sessionId: string): Promise<void> {
  const engine = getSessionEngine(sessionId);
  if (!engine) {
    logger.warn('Integration', `No engine found for session: ${sessionId}`);
    return;
  }

  try {
    const { compactConversation } = await import('./compact/index.js');
    const messages = engine.getMessages();


    const result = await compactConversation(sessionId, messages);

    // 替换引擎中的消息
    const { buildPostCompactMessages } = await import('./compact/index.js');
    const postCompactMessages = buildPostCompactMessages(result);

    // 清空并重新设置消息
    engine.getMessages().length = 0;
    engine.getMessages().push(...postCompactMessages);

    // 持久化压缩后的消息到磁盘
    await replaceConversationMessages(sessionId, postCompactMessages);

    // 标记压缩产生的消息为已持久化：
    // boundaryMarker / summaryMessage 是 compactConversation 新建的对象，没有 _persisted 标记，
    // 若不标记，下一次 QueryEngine 的 persist-all 循环会把它们再次 appendMessage 到 JSONL 末尾，
    // 产生相同 uuid 的重复消息，导致 loadConversation 的 messageMap 覆盖根节点、整条消息链断开、
    // 对话加载后空白。
    for (const msg of postCompactMessages) {
      (msg as any)._persisted = true;
    }

    // 标记 meta 中的压缩状态
    await updateConversationContext(sessionId, {
      isCompacted: true,
      isExpanded: false,
    }).catch((err: unknown) => {
      logger.warn('Integration', `Failed to update compact context: ${err}`);
    });

    // 重置引擎中的 lastPersistedMessageUuid，指向压缩后最后一条消息的 uuid
    const lastMsg = postCompactMessages[postCompactMessages.length - 1];
    const lastUuid = lastMsg && 'uuid' in lastMsg ? (lastMsg as any).uuid : null;
    if (lastUuid) {
      engine.lastPersistedMessageUuid = lastUuid;
    }

    // 通知 UI 压缩完成：清空旧消息并推送压缩后的内容
    replayMessagesToUI(getUI(), sessionId, postCompactMessages);

  } catch (error) {
    logger.error('Integration', `Compact failed for session ${sessionId}:`, error);

    const ui = getUI();
    ui.onCompressProgress?.(sessionId, 'error');

    ui.onMessage(sessionId, {
      role: 'system',
      content: `压缩失败: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

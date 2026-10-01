/**
 * initializeCoreEvents - core 侧 UiEvent 订阅的注册入口（阶段 2 全量版）
 *
 * 属 bootstrap 序列，在 setGlobalEventBus(bus) 之后调用一次。
 *
 * 按 core 模块分注册函数（Integration / history / sessionResources / mcp），
 * 每个模块订阅自己关心的少数几个事件（DEVELOPMENT.md 第 3.6 / 4.3 节）。
 * 不做成映射表穷尽检查：core 侧漏订阅是「该动作暂无 core 消费方」的合法中间态，
 * 由第 4.3 节的「core 侧消费方」列在评审时对照兜底。
 *
 * 事件 handler 内部不直接持有跨模块状态：只调用对应模块自己的导出函数
 * （abortCurrentQuery / updateSessionModel …），保持与原直接函数调用相同的内聚度。
 */

import type { AssistantEventBus } from './AssistantEventBus.js';
import { logger, setLogToConsole } from './Logger.js';
import { applySettingsSnapshot } from './settings.js';
import { requireEventBus } from './AssistantEventBus.js';
import {
  setExtensionPath,
  setSessionWorkspace,
  clearSessionWorkspace,
} from './history/Config.js';
import { markSessionWaiting } from './sessionRuntime.js';

// ==================== 宿主环境 ====================

/**
 * 宿主环境：连接建立后由 UI 发一次。
 *
 * **必须同步注册**：调用方紧接着就 `emitToCore`，异步注册（动态 import）会让这条
 * 一次性事件在处理器就位前到达，被总线按「暂无订阅者」静默丢弃。
 */
/**
 * 上一次应用快照时的 MCP 默认启用列表。
 *
 * 用来判断「这次快照是否改变了默认启用列表」：只有变了才需要让已注册会话重同步连接。
 * 首次（`null`）不算变化——会话还没注册，`syncAllSessions()` 本来就没活干。
 */
let lastMcpEnabled: readonly string[] | null = null;

function registerHostEnvironmentUiEvents(bus: AssistantEventBus): void {
  bus.onUiEvent(
    'hostEnvironmentProvided',
    ({ extensionPath, logToConsole, settings, mcpServers }) => {
      setExtensionPath(extensionPath);
      setLogToConsole(logToConsole);
      // 配置快照（唯一写入入口）：core 侧所有配置读取都从这里取值，
      // 不再读 `settings.json` / `mcp.json`（`docs/core-ui-separation.md` 第 4.4 节）。
      applySettingsSnapshot(settings, mcpServers);
      // 快照就是就绪判据：应用完才算就绪（第 7 节）。宿主据此判定
      // 「Core 已跟上最新配置」，每次重新推送快照后都会再收到一次。
      requireEventBus().emitToUi({ type: 'coreReady' });

      // MCP 全局默认启用列表变了：让所有已注册会话按新的默认值重同步连接。
      // 配置变更只经快照到达 core（第 4.5 节），没有单独的通知事件；
      // 每个会话自己的勾选存在各自的 meta.json，走 `mcpEnabledChanged`。
      const enabled = settings.mcp.enabled;
      const changed = lastMcpEnabled !== null && !sameStringList(lastMcpEnabled, enabled);
      lastMcpEnabled = enabled;
      if (changed) {
        void import('./mcp/Manager.js')
          .then(({ getMcpManager }) => getMcpManager().syncAllSessions())
          .catch((error: unknown) => {
            logger.error('initializeCoreEvents', `Failed to resync MCP sessions: ${String(error)}`);
          });
      }
    },
  );
}

/** 两个字符串列表是否逐项相同（顺序有意义：面板按顺序保存） */
function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * 会话工作目录：多工作目录宿主在打开 / 切换 / 重命名会话时登记。
 *
 * Embedded 下宿主本来可以直接调 `setSessionWorkspace()`（同一张表、同一进程），
 * 这里保留事件通路是为了两种装配共用同一套宿主代码：Standalone 下这张表在 Core
 * 进程内，只有事件能过去。
 */
function registerSessionWorkspaceUiEvents(bus: AssistantEventBus): void {
  bus.onUiEvent('sessionWorkspaceAssigned', ({ sessionId, workspacePath }) => {
    // 清除（null / 空串）走 clearSessionWorkspace：setSessionWorkspace 对空值
    // 是 no-op，留着旧值会让后续解析用到已经关闭的工作目录。
    if (!workspacePath) clearSessionWorkspace(sessionId);
    else setSessionWorkspace(sessionId, workspacePath);
  });
}

/**
 * 用户选择：宿主在 webview 里弹出 / 应答时上报，core 据此维护 `sessionRuntime.waiting`。
 *
 * 同步注册：与另外两条宿主事件同理——事件由宿主在任意时刻发出，注册晚于第一次上报
 * 就会丢掉那次状态变更。
 */
function registerUserChoiceUiEvents(bus: AssistantEventBus): void {
  bus.onUiEvent('userChoicePendingChanged', ({ sessionId, pending }) => {
    markSessionWaiting(sessionId, pending);
  });
}

// ==================== Integration：消息 / 压缩 / 配置 / 生命周期 ====================

async function registerIntegrationUiEvents(bus: AssistantEventBus): Promise<void> {
  const {
    requestCompact,
    setSessionModel,
    setSessionThinkingMode,
    setSessionPromptPreset,
    createEngine,
  } = await import('./Integration.js');
  const { updateConversationContext } = await import('./history/index.js');
  const { getSessionEngine } = await import('./QueryEngine.js');
  const { abortCurrentQuery } = await import('./Integration.js');
  const { setSessionAgentMode } = await import('./tools/PermissionPolicy.js');
  const { createConversationMetadataSync, updateConversationMetadataTitle } = await import('./history/Conversation.js');
  const { loadConversation } = await import('./history/index.js');
  const { hasProjectRoot } = await import('./history/Config.js');

  bus.onUiEvent('abortRequested', ({ sessionId }) => {
    abortCurrentQuery(sessionId);
  });

  // ===== 用户消息 =====
  // 宿主只发 userMessageSubmitted；取 / 建引擎、应用会话覆盖、入队都在 core 侧完成。
  const { submitUserMessage } = await import('./Integration.js');
  bus.onUiEvent('userMessageSubmitted', (payload) => {
    void submitUserMessage(payload).catch((error: unknown) => {
      logger.error('initializeCoreEvents', `submitUserMessage failed: ${String(error)}`);
    });
  });

  // ===== 压缩 =====
  bus.onUiEvent('compactRequested', ({ sessionId }) => {
    void requestCompact(sessionId);
  });

  // ===== 会话生命周期 =====
  // conversationStarted：用户点「新建对话」，会话还没有任何内容。
  // core 侧动作：预创建引擎（引擎在第一轮查询时才建）。
  bus.onUiEvent('conversationStarted', ({ sessionId }) => {
    // 没有工作目录时不预创建引擎：引擎的 cwd、历史落盘、工具路径都依赖工作目录，
    // 此时建引擎会直接抛错。无工作目录的会话不会落盘（webview 只显示引导），
    // 等宿主打开工作目录后再建（新建对话走 conversationStarted 的正常路径）。
    if (!hasProjectRoot(sessionId)) return;
    // 预创建引擎（幂等）：engine 不存在时创建；存在则返回已有实例。
    // 空标题：标题在第一条消息时由 appendMessage / sendMessage 生成。
    createEngine(sessionId, '', undefined);
  });

  // conversationOpened：core 在 restoreConversationEngine 中处理（由 webviewMessageHandler
  // 的加载流程直接调用）；该事件本身在阶段 3 的「宿主编排」收编，此处暂不消费。
  void loadConversation;

  // ===== 会话配置类 =====
  const persistAndBroadcast = async (
    sessionId: string,
    key: 'model' | 'thinkingEffort' | 'promptMode' | 'agentMode' | 'webSearch' | 'mcpEnabled',
    apply: () => Promise<void> | void,
  ): Promise<void> => {
    try {
      await apply();
      // 广播 CoreEvent.sessionConfigChanged → WebViewUI.onSessionConfigChanged → 多端同步
      // （value 由调用方语义决定，这里不重复取值；各分支内已显式广播）
      void key;
      void sessionId;
    } catch (err) {
      logger.warn('Integration', `session config change failed (${key}): ${err}`);
    }
  };

  bus.onUiEvent('modelChanged', ({ sessionId, ref }) => {
    void persistAndBroadcast(sessionId, 'model', async () => {
      // provider + model 一起表征一个模型：两者都要写入引擎配置与 meta.json。
      setSessionModel(sessionId, ref);
      // meta.json 保持扁平字段（model / provider 分开写）
      await updateConversationContext(sessionId, { model: ref.model, provider: ref.provider });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'model', ref } });
    });
  });

  bus.onUiEvent('thinkingEffortChanged', ({ sessionId, mode }) => {
    void persistAndBroadcast(sessionId, 'thinkingEffort', async () => {
      setSessionThinkingMode(sessionId, mode);
      // 落盘字段仍是 thinkingMode（meta.json 的既有字段名）
      await updateConversationContext(sessionId, { thinkingMode: mode });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'thinkingEffort', value: mode } });
    });
  });

  bus.onUiEvent('promptModeChanged', ({ sessionId, mode }) => {
    void persistAndBroadcast(sessionId, 'promptMode', async () => {
      setSessionPromptPreset(sessionId, mode);
      await updateConversationContext(sessionId, { promptMode: mode });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'promptMode', value: mode } });
    });
  });

  // agentMode 归 core（取代原 UI 层 sessionAgentModes Map）：
  // - 会话级覆盖写入 core 存储（PermissionPolicy.sessionAgentModes）
  // - meta.json 持久化（context.agentMode）
  // - 广播 sessionConfigChanged
  bus.onUiEvent('agentModeChanged', ({ sessionId, mode }) => {
    void persistAndBroadcast(sessionId, 'agentMode', async () => {
      setSessionAgentMode(sessionId, mode);
      await updateConversationContext(sessionId, { agentMode: mode });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'agentMode', value: mode } });
    });
  });

  bus.onUiEvent('webSearchChanged', ({ sessionId, enabled }) => {
    void persistAndBroadcast(sessionId, 'webSearch', async () => {
      const engine = getSessionEngine(sessionId);
      engine?.updateWebSearch(enabled);
      await updateConversationContext(sessionId, { webSearch: enabled });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'webSearch', value: enabled } });
    });
  });

  // ===== 其它 =====
  // editRolledBack：Edit/Write 文件回滚（core 业务，原 webviewMessageHandler.handleRollbackEdit 迁入）
  bus.onUiEvent('editRolledBack', ({ sessionId, toolUseId, direction, filePath }) => {
    void (async () => {
      try {
        const { rollbackEdit } = await import('./history/rollback.js');
        const dir: 'before' | 'after' = direction === 'after' ? 'after' : 'before';
        // filePath 是 UI 侧归一化后的兜底路径：磁盘上的 tool_use.input 若被
        // double-encode 成字符串，core 取不到 input.file_path，需要它兜底。
        await rollbackEdit(sessionId, toolUseId, dir, filePath);
      } catch (err) {
        logger.warn('Integration', `editRolledBack handling failed: ${err}`);
      }
    })();
  });

  void createConversationMetadataSync;
  void updateConversationMetadataTitle;
}

// ==================== history：重命名 / 删除 / 上下文 / 空间 ====================

async function registerHistoryUiEvents(bus: AssistantEventBus): Promise<void> {
  const {
    updateConversationContext,
    deleteConversation,
  } = await import('./history/index.js');
  const {
    collectConversationClosure,
    updateConversationMetadataTitle,
  } = await import('./history/Conversation.js');
  const {
    releaseSessionResources,
  } = await import('./sessionResources.js');
  const { clearConversationSpace, getConversationSpaces } = await import('./history/ConversationSpace.js');

  bus.onUiEvent('conversationRenamed', ({ sessionId, title }) => {
    void (async () => {
      try {
        await updateConversationMetadataTitle(sessionId, title);
        requireEventBus().emitToUi({ type: 'titleChanged', sessionId, title });
        // 标题已落盘：广播列表变化，让 ConversationManager.refresh() 重新读盘分发
        requireEventBus().emitToUi({ type: 'conversationListChanged' });
      } catch (err) {
        logger.warn('history', `conversationRenamed handling failed: ${err}`);
      }
    })();
  });

  // conversationDeleted：core 消费方负责「删除即关闭」+ 算受影响闭包 + 删盘。
  // 编排（abort → close 视图 → delete）的阶段 6 形态：多视图宿主（Electron）先对
  // 每个受影响会话调 WebViewUI.closeConversation(sid)（卸内存 + 销毁视图），再发本
  // 事件——此时 releaseSessionResources 幂等，无副作用。单视图宿主（VS Code）没有
  // 可销毁的会话视图，webview 删除当前对话后直接新建对话跳转，运行中查询的
  // abort / MCP 引用释放 / runtime 状态清理统一由这里的「删除即关闭」兜底；
  // 本订阅最后删盘并广播列表变化。
  bus.onUiEvent('conversationDeleted', ({ sessionId }) => {
    void (async () => {
      try {
        const { getProjectRoot } = await import('./history/Config.js');
        const { readProjectConversationMetadata } = await import('./history/Conversation.js');
        const closure = collectConversationClosure(
          sessionId,
          await readProjectConversationMetadata(getProjectRoot(sessionId)),
        );
        for (const sid of closure) {
          await releaseSessionResources(sid);
        }
        await deleteConversation(sessionId);
        requireEventBus().emitToUi({ type: 'conversationListChanged' });
      } catch (err) {
        logger.warn('history', `conversationDeleted handling failed: ${err}`);
      }
    })();
  });

  bus.onUiEvent('conversationContextUpdated', ({ sessionId, changes }) => {
    void (async () => {
      try {
        const patch: Record<string, unknown> = {};
        for (const change of changes) {
          patch[change.key] = change.value;
        }
        await updateConversationContext(sessionId, patch as never);
      } catch (err) {
        logger.warn('history', `conversationContextUpdated handling failed: ${err}`);
      }
    })();
  });

  bus.onUiEvent('conversationSpaceCleared', ({ sessionId }) => {
    void (async () => {
      try {
        const result = await clearConversationSpace(sessionId);
        requireEventBus().emitToUi({
          type: 'message',
          sessionId,
          data: {
            role: 'system',
            content: `对话空间已清空（${result.removedFiles} 个文件）`,
          },
        });
        const spaces = await getConversationSpaces();
        void spaces;
        requireEventBus().emitToUi({ type: 'conversationListChanged' });
      } catch (err) {
        logger.warn('history', `conversationSpaceCleared handling failed: ${err}`);
      }
    })();
  });
}

// ==================== sessionResources：conversationClosed ====================

async function registerSessionResourcesUiEvents(bus: AssistantEventBus): Promise<void> {
  const { releaseSessionResources } = await import('./sessionResources.js');

  bus.onUiEvent('conversationClosed', ({ sessionId }) => {
    void (async () => {
      try {
        await releaseSessionResources(sessionId);
      } catch (err) {
        logger.warn('sessionResources', `conversationClosed handling failed: ${err}`);
      }
    })();
  });
}

// ==================== mcp：mcpEnabledChanged ====================

async function registerMcpUiEvents(bus: AssistantEventBus): Promise<void> {
  const { setSessionMcpEnabled } = await import('./mcp/Config.js');
  const { getMCPHost } = await import('./mcp/MCPHost.js');

  bus.onUiEvent('mcpEnabledChanged', ({ sessionId, name, enabled }) => {
    void (async () => {
      try {
        await setSessionMcpEnabled(sessionId, name, enabled);
        // 连接/断开差量同步（唯一入口 MCPHost）；同步结束后由 MCPHost 广播
        // sessionConfigChanged(mcpEnabled)，UI 据此重新读取运行时状态并回推给 webview。
        await getMCPHost().onSessionEnabledChanged(sessionId);
      } catch (err) {
        logger.warn('mcp', `mcpEnabledChanged handling failed: ${err}`);
      }
    })();
  });
}

/**
 * 注册 core 侧全部 UiEvent 订阅。由 bootstrap 在 setGlobalEventBus 之后调用一次。
 */
export function initializeCoreEvents(bus: AssistantEventBus): void {
  // UI 语言不在这里：`uiLanguage` 是宿主自己的字段，由宿主读 `SettingsStore` 后
  // 收敛到宿主进程内的 i18n（`src/host/i18n.ts`），core 不感知语言。

  // 宿主事件：同步注册，避免事件在处理器就位前到达、被总线按「暂无订阅者」丢弃
  registerHostEnvironmentUiEvents(bus);
  registerSessionWorkspaceUiEvents(bus);
  registerUserChoiceUiEvents(bus);

  void registerIntegrationUiEvents(bus);
  void registerHistoryUiEvents(bus);
  void registerSessionResourcesUiEvents(bus);
  void registerMcpUiEvents(bus);
}

/**
 * initializeCoreEvents - core 侧 UiEvent 订阅的注册入口（阶段 2 全量版）
 *
 * 与 initializeHistory 同属 bootstrap 序列，在 setGlobalEventBus(bus) 之后调用一次。
 *
 * 按 core 模块分注册函数（Integration / history / sessionIdle / mcp），
 * 每个模块订阅自己关心的少数几个事件（DEVELOPMENT.md 第 3.7 / 4.3 节）。
 * 不做成映射表穷尽检查：core 侧漏订阅是「该动作暂无 core 消费方」的合法中间态，
 * 由第 4.3 节的「core 侧消费方」列在评审时对照兜底。
 *
 * 事件 handler 内部不直接持有跨模块状态：只调用对应模块自己的导出函数
 * （abortCurrentQuery / updateSessionModel …），保持与原直接函数调用相同的内聚度。
 */

import type { AssistantEventBus } from './AssistantEventBus.js';
import { logger } from './Logger.js';
import { requireEventBus } from './AssistantEventBus.js';

// ==================== Integration：消息 / 压缩 / 配置 / 生命周期 ====================

async function registerIntegrationUiEvents(bus: AssistantEventBus): Promise<void> {
  const {
    sendMessage,
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
  const { noteSessionActivity } = await import('./sessionIdle.js');

  // ===== 消息 =====
  bus.onUiEvent('messageQueued', (e) => {
    // 「新消息」与「排队消息」在 core 侧是同一条路径（Integration.sendMessage）。
    // fileInfo 携带的 thinking/webSearch/promptPreset 沿原 sendMessage 的可选项传入。
    void (async () => {
      try {
        const images = e.images ?? undefined;
        let promptPreset: import('./prompt/PromptPreset.js').PromptPresetId | undefined;
        if (e.fileInfo?.promptMode) {
          const { isPromptPresetId } = await import('./prompt/PromptPreset.js');
          if (isPromptPresetId(e.fileInfo.promptMode)) {
            promptPreset = e.fileInfo.promptMode;
          }
        }
        for await (const _ of sendMessage(e.content, e.sessionId, {
          filePath: e.fileInfo?.filePath ?? undefined,
          selectedLines: e.fileInfo?.selectedLines ?? undefined,
          fileHidden: e.fileInfo?.fileHidden,
          thinkingMode: e.fileInfo?.thinkingMode,
          webSearch: e.fileInfo?.webSearch,
          promptPreset,
          images,
        })) {
          void _;
        }
      } catch (err) {
        logger.error('Integration', `messageQueued handling failed: ${err}`);
      }
    })();
  });

  bus.onUiEvent('abortRequested', ({ sessionId }) => {
    abortCurrentQuery(sessionId);
  });

  // ===== 压缩 =====
  bus.onUiEvent('compactRequested', ({ sessionId }) => {
    void requestCompact(sessionId);
  });

  // ===== 会话生命周期 =====
  // conversationStarted：用户点「新建对话」，会话还没有任何内容。
  // core 侧动作：预创建引擎（引擎在第一轮查询时才建），刷新空闲计时。
  bus.onUiEvent('conversationStarted', ({ sessionId }) => {
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

  bus.onUiEvent('modelChanged', ({ sessionId, model }) => {
    void persistAndBroadcast(sessionId, 'model', async () => {
      setSessionModel(sessionId, model);
      await updateConversationContext(sessionId, { model });
      requireEventBus().emitToUi({ type: 'sessionConfigChanged', sessionId, change: { key: 'model', value: model } });
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
  bus.onUiEvent('editRolledBack', ({ sessionId, toolUseId, direction }) => {
    void (async () => {
      try {
        const { rollbackEdit } = await import('./history/rollback.js');
        const dir: 'before' | 'after' = direction === 'after' ? 'after' : 'before';
        await rollbackEdit(sessionId, toolUseId, dir);
      } catch (err) {
        logger.warn('Integration', `editRolledBack handling failed: ${err}`);
      }
    })();
  });

  // llmConfigSaved：全局 LLM 配置已保存 → 清除 core 配置缓存，
  // 下次 getConfig 重新读盘（settings.json 的写入由 UI 侧收编清单承担）。
  bus.onUiEvent('llmConfigSaved', () => {
    void (async () => {
      try {
        const { clearConfigCache } = await import('./llm/config.js');
        clearConfigCache();
      } catch (err) {
        logger.warn('Integration', `llmConfigSaved handling failed: ${err}`);
      }
    })();
  });

  void createConversationMetadataSync;
  void updateConversationMetadataTitle;
  void noteSessionActivity;
}

// ==================== history：重命名 / 删除 / 清空 / 上下文 / 空间 ====================

async function registerHistoryUiEvents(bus: AssistantEventBus): Promise<void> {
  const {
    updateConversationContext,
    deleteConversation,
  } = await import('./history/index.js');
  const {
    updateConversationMetadataTitle,
  } = await import('./history/Conversation.js');
  const { clearConversationData } = await import('./history/ops.js');
  const { clearConversationSpace, getConversationSpaces } = await import('./history/ConversationSpace.js');

  bus.onUiEvent('conversationRenamed', ({ sessionId, title }) => {
    void (async () => {
      try {
        await updateConversationMetadataTitle(sessionId, title);
        requireEventBus().emitToUi({ type: 'titleChanged', sessionId, title });
      } catch (err) {
        logger.warn('history', `conversationRenamed handling failed: ${err}`);
      }
    })();
  });

  // conversationDeleted：core 消费方负责算受影响闭包 + 删盘。
  // 编排（abort → close 视图 → delete）的阶段 6 形态：宿主先对每个受影响会话调
  // WebViewUI.closeConversation(sid)，再对 root 发本事件；本订阅只删盘并广播列表变化。
  bus.onUiEvent('conversationDeleted', ({ sessionId }) => {
    void (async () => {
      try {
        await deleteConversation(sessionId);
        requireEventBus().emitToUi({ type: 'conversationListChanged' });
      } catch (err) {
        logger.warn('history', `conversationDeleted handling failed: ${err}`);
      }
    })();
  });

  bus.onUiEvent('conversationCleared', ({ sessionId }) => {
    void (async () => {
      try {
        await clearConversationData(sessionId);
        await updateConversationContext(sessionId, { totalContextTokens: 0 });
        requireEventBus().emitToUi({ type: 'conversationListChanged' });
      } catch (err) {
        logger.warn('history', `conversationCleared handling failed: ${err}`);
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

// ==================== sessionIdle：conversationClosed ====================

async function registerSessionIdleUiEvents(bus: AssistantEventBus): Promise<void> {
  const { releaseSessionResources } = await import('./sessionIdle.js');
  const { clearSessionIdleState } = await import('./sessionIdle.js');

  bus.onUiEvent('conversationClosed', ({ sessionId }) => {
    void (async () => {
      try {
        await releaseSessionResources(sessionId);
      } catch (err) {
        logger.warn('sessionIdle', `conversationClosed handling failed: ${err}`);
      }
    })();
  });
  void clearSessionIdleState;
}

// ==================== mcp：mcpEnabledChanged ====================

async function registerMcpUiEvents(bus: AssistantEventBus): Promise<void> {
  const { setSessionMcpEnabled } = await import('./mcp/Config.js');
  const { getMcpManager } = await import('./mcp/Manager.js');

  bus.onUiEvent('mcpEnabledChanged', ({ sessionId, name, enabled }) => {
    void (async () => {
      try {
        await setSessionMcpEnabled(sessionId, name, enabled);
        // 连接/断开差量同步；完成后由 CoreEvent.conversationListChanged /
        // pushMcpServers 的读取路径回推状态（UI 侧轮询读取）
        await getMcpManager().syncSession(sessionId);
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
  void registerIntegrationUiEvents(bus);
  void registerHistoryUiEvents(bus);
  void registerSessionIdleUiEvents(bus);
  void registerMcpUiEvents(bus);
}

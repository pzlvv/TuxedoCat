import type { HandlerContext } from './handlerContext';
import { modelRefOf } from '../../../shared/llm/modelRef';
import { HostToWebviewWire } from '../../../host/webviewMessages';
import { profileLog } from '../../debug';
import { resolveTitle } from '../../i18n';
import { createSessionState } from '../../sessionState';
import { AgentMode, QueuedMessagePayload, SessionRuntimeState } from '../../types';
import { setConversationListOwner } from '../../webviewEnv';
import { applyLoadedConversationState, replayBufferedToolStatusIntoMessages, restoreMessagesFromConversation, toUiMessage } from './shared';

/**
 * webview 消息处理的 conversation 域 handler。
 *
 * 由 useMessageHandler 的 switch 转发：msg 是判别收窄后的 wire 消息，
 * ctx 是 hook 注入的共享上下文（props / 各 ref / 当前会话判定）。
 * handler 保持同步纯转发语义，不自行订阅事件。
 */
export function handleConversationInitSessionState(
  msg: Extract<HostToWebviewWire, { type: 'initSessionState' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef } = ctx;
          const wire = msg;
          // 预初始化 session 状态（子代理创建时调用，使后续 thinking 动画能正确显示）
          if (msg.sessionId && !props.sessionStates.has(msg.sessionId)) {
            props.sessionStates.set(msg.sessionId, createSessionState({
              animationMode: 'thinking',
              promptMode: propsRef.current.settingsDefaults.promptMode,
              // wire 消息是扁平的 model / provider，组装成模型身份
              modelRef: modelRefOf(wire.provider, wire.model),
            }));
          }
          return;
}

export function handleConversationSetConversationListOwner(
  msg: Extract<HostToWebviewWire, { type: 'setConversationListOwner' }>,
  _ctx: HandlerContext,
): void {
          // 运行时校验：非法值直接忽略，不能静默当 host —— 那会把悬浮窗顶栏切成
          // 「无历史列表、无新建、有关闭按钮」的错误形态。
          if (msg.owner === 'host' || msg.owner === 'webview') setConversationListOwner(msg.owner);
          else console.warn('[webview] setConversationListOwner: 非法 owner', msg.owner);
}

export function handleConversationSetCurrentFile(
  msg: Extract<HostToWebviewWire, { type: 'setCurrentFile' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          props.setCurrentFile(msg.filePath || '');
          props.setSelectedLines(msg.selectedLines || null);
          return;
        // 会话级设置的多端同步：同一会话在其它端被修改时同步本端 UI。
        // 值相同时 React 会跳过更新，不会再次上报，因此不会形成回环。
}

export function handleConversationSetTitle(
  msg: Extract<HostToWebviewWire, { type: 'setTitle' }>,
  ctx: HandlerContext,
): void {
          const { props } = ctx;
          if (msg.sessionId === props.currentSessionIdRef.current) {
            props.setConversationTitle(resolveTitle(msg.title));
          }
}

export function handleConversationSetWorkMode(
  msg: Extract<HostToWebviewWire, { type: 'setWorkMode' }>,
  ctx: HandlerContext,
): void {
          // 会话工作模式变化（core workModeChanged 的投影）：只认当前会话的消息，
          // 非当前会话的变化由该会话自己的视图接收（多视图宿主逐会话投递）。
          const { props } = ctx;
          if (msg.sessionId === props.currentSessionIdRef.current) {
            props.setWorkMode(msg.workMode);
          }
}

export function handleConversationConversationsData(
  msg: Extract<HostToWebviewWire, { type: 'conversationsData' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          const convs = msg.conversations || [];
          props.setConversations(convs);
          props.setConversationsLoading(false);
          // 新列表到达时回到默认分页大小，避免旧会话的滚动位置/可见数量串到新列表
          props.setVisibleConversationCount(50);
          props.listLoadedOnceRef.current = true;
          // 如果修改的对话是当前对话，同步更新顶部标题
          const sid = props.currentSessionIdRef.current;
          if (sid) {
            const currentConv = convs.find((c: any) => c.sessionId === sid);
            if (currentConv?.title) {
              props.setConversationTitle(resolveTitle(currentConv.title));
            }
            // 自动展开当前对话的祖先链，确保选中子对话时父对话可见。
            // 只写祖先：选中对话**自身**的子代理列表是否展开交给默认规则
            // （App.tsx 消费 conversationTreeDefaults 的阈值）与用户显式状态，
            // 否则每次列表刷新都会把用户折叠过的子代理列表重新撑开。
            props.setExpandedSubSessions(prev => {
              const next = { ...prev };
              // 建立 sessionId -> conversation 索引，避免祖先链循环内反复 find()
              const convById = new Map(convs.map((c: any) => [c.sessionId, c]));
              let id: string | null = convById.get(sid)?.parentSessionId ?? null;
              while (id && convById.has(id)) {
                next[id] = true;
                id = convById.get(id)!.parentSessionId;
              }
              return next;
            });
          }
          // 如果正在删除对话，保持面板打开
          if (props.isDeletingRef.current) {
            props.setConversationDropdownOpen(true);
            props.isDeletingRef.current = false;
          }
          return;
}

export function handleConversationSessionRuntimeStates(
  msg: Extract<HostToWebviewWire, { type: 'sessionRuntimeStates' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          // core 的会话运行时状态全量推送：对话树流水灯与 abort 按钮的唯一数据源
          // （不再从 queryBegin / queryEnd 推导）。根事实原样透传，表现由消费者推导。
          const runtime = new Map<string, SessionRuntimeState>();
          for (const s of msg.states || []) {
            if (s?.sessionId) runtime.set(s.sessionId, {
              idle: s.idle !== false,
              waiting: !!s.waiting,
              queryRunning: !!s.queryRunning,
              compacting: !!s.compacting,
              pendingCompact: !!s.pendingCompact,
              backgroundRunning: !!s.backgroundRunning,
              // specs/019 FR-001：缺字段按空清单 / null 判定（旧宿主 / 假宿主未带新字段）
              backgroundTasks: Array.isArray(s.backgroundTasks) ? s.backgroundTasks : [],
              subAgentRunning: !!s.subAgentRunning,
              subAgentDescription: s.subAgentDescription ?? null,
              parentSessionId: s.parentSessionId ?? null,
              creator: s.creator,
            });
          }
          props.sessionRuntimeStatesRef.current = runtime;
          // 强制对话列表重渲染，使流水灯即时出现 / 消失 / 变黄
          props.setSessionIdleVersion(v => v + 1);
          return;
}

export function handleConversationSessionCompletionAttention(
  msg: Extract<HostToWebviewWire, { type: 'sessionCompletionAttention' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
  // 未读完成的会话集合（「任务完成」绿色呼吸，Electron 宿主专用）：主进程判定好
  // 推送时机（窗口聚焦）才下发，这里只负责挂灯条——呼吸一次后常亮，集合里消失
  // （该对话被打开 / 会话被删除）时由后续推送熄灭。已有条目保留原到达时刻，
  // 重复推送不给已亮的灯条重播呼吸。
  const incoming = new Set((msg.sessionIds || []).filter((sid) => typeof sid === 'string' && sid));
  props.setCompletionAttention(prev => {
    const next = new Map<string, number>();
    for (const sid of incoming) {
      next.set(sid, prev.get(sid) ?? Date.now());
    }
    return next;
  });
}

export function handleConversationConversationLoaded(
  msg: Extract<HostToWebviewWire, { type: 'conversationLoaded' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, sessionMessagesCacheRef, scrollToBottomBeforeRender } = ctx;
          const wire = msg;
          const _t_convLoaded = performance.now();
          const _convLoadedSessionId = msg.conversation?.metadata?.sessionId;
          profileLog(`[Profile] conversationLoaded收到 | session=${(_convLoadedSessionId || '').substring(0, 20)} | t=${_t_convLoaded.toFixed(2)}ms`);
          // 标记会话正在加载（此期间的 updateToolStatus 进入缓冲，避免时序竞态）
          props.conversationLoadingRef.current = true;
          // 设置当前会话 ID
          if (msg.conversation && msg.conversation.metadata && msg.conversation.metadata.sessionId) {
            const loadedSessionId = msg.conversation.metadata.sessionId;
            props.setCurrentSessionIdRef(loadedSessionId);
            props.setCurrentSessionId(loadedSessionId);
            // 恢复该会话的排队消息横幅（若有）
            props.setQueuedMessage(props.queuedMessageRef.current.get(loadedSessionId) ?? null);
            // 设置压缩状态
            props.setHasCompactArchive(wire.hasCompactArchive === true);
            props.setIsCompactExpanded(false);
            // 记录父会话 ID（本地子对话时有值；跨工作区对话无父会话，specs/025 FR-002）
            props.setParentSessionId(wire.parentSessionId || null);
            // 会话创建者（specs/025 FR-002）：返回按钮按它跳发起方（跨工作区）或父会话（本地）
            props.setCreator(wire.creator ?? null);
            // 记录子代理角色（specs/020 FR-005）：meta.json 的 role 事实，普通会话为 null；
            // 选项菜单置灰判据（非 Master 子代理锁定提示词模式 / 联网搜索 / MCP）
            props.setSubAgentRole(msg.conversation.metadata.role ?? null);
            // 恢复会话工作模式（spin 会话加载后输入框保持禁用；specs/016 FR-005）
            props.setWorkMode(wire.workMode);
            // 恢复该会话的 UI 状态（input, userChoiceRequest, userChoiceInput, showThinkingAnimation）
            const savedState = props.sessionStates.get(loadedSessionId);
            if (savedState) {
              props.inputAreaRef.current?.setValue(savedState.input);
              props.inputAreaRef.current?.setPastedImages?.(savedState.pastedImages ?? []);
              // 使用特殊值标记：恢复状态，不要在 onChange 中移动光标
              // 在 setTimeout 中会正确恢复光标位置
              props.cursorPositionRef.current = -1; // -1 表示恢复状态，不移动光标
              props.choiceCursorPositionRef.current = -1;
              // 如果恢复的会话有 userChoiceRequest，同时保存其对应的主输入框内容
              // 注意：userChoiceRequest 通过 userChoiceQueue.onSessionLoaded 由扩展端恢复，
              // 不使用本地保存的 state，避免 choiceId 过期导致 respondUserChoice 找不到对应记录
              if (savedState.userChoiceRequest) {
                props.savedMainInputRef.current = savedState.input || '';
              }
              // 不恢复 userChoiceRequest（由扩展端 onSessionLoaded 发送新 requestUserChoice）
              props.setUserChoiceRequest(null);
              // 恢复用户选择输入到 ref（组件内部使用自己的本地状态）
              props.userChoiceInputRef.current = savedState.userChoiceInput || '';
              // showThinkingAnimation 和 hasActiveQuery 是运行时状态，不依赖 session state 快照。
              // conversationLoaded 消息中扩展端已根据引擎实时状态提供 hasActiveQuery 和 activityPhase。
              // activityPhase 精确表示当前是 thinking / text / tool / idle，不能仅凭 hasActiveQuery 推断。
              // 压缩是独立于 QueryEngine 的异步任务，hasActiveQuery 可能为 false，
              // 因此压缩中必须优先使用 savedState 的 compacting 状态来恢复动画和流水灯。
              const activityPhase = wire.activityPhase as string | undefined;
              const isCompacting = savedState.animationMode === 'compacting' && savedState.showThinkingAnimation === true;
              // 除了扩展端上报的 hasActiveQuery/activityPhase，本地 savedState 中记录的
              // showThinkingAnimation 也是可靠来源（后台查询/子代理场景可能未同步 hasActiveQuery）。
              // 只要不是 tool/text 阶段，恢复会话后应立刻显示 thinking 动画。
              const savedAnimating = savedState.showThinkingAnimation === true;
              const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
              const runtimeActive = savedAnimating || wire.hasActiveQuery === true || phaseActive;
              const showThinking = isCompacting || (
                runtimeActive &&
                (activityPhase
                  ? activityPhase !== 'tool' && activityPhase !== 'text'
                  : true)
              );
              props.setShowThinkingAnimation(showThinking);
              props.setHasActiveQuery(isCompacting || runtimeActive);
              // 恢复该会话自己的动画类型，避免把其他会话的 compacting 动画带过来
              props.setAnimationMode(isCompacting ? 'compacting' : 'thinking');
              // 同步到 session 状态，确保对话列表的流水灯与引擎实时状态一致
              savedState.hasActiveQuery = isCompacting || runtimeActive;
              // 两分支相同的 setter 序列（agentMode、promptMode、thinkingMode、webSearch、model）收敛到辅助函数
              const common = applyLoadedConversationState(msg, props, propsRef.current, savedState);
              if (common.savedCtxPromptMode) savedState.promptMode = common.savedCtxPromptMode;
              // 优先使用 savedContext.totalContextTokens（meta.json 中持久化的最新值），
              // 回退到 savedState.contextLength（内存中保存的快照值）。
              // 取两者的最大值以处理以下场景：
              // - subagent 在后台运行时，message_delta 已更新 meta.json 但 webview 的 savedState 未同步
              // - savedState 可能保存了切换时的旧值，而 meta.json 中有更新的 token 计数
              // 优先使用服务端/meta.json 持久化的最新值，避免本地旧快照把压缩后的值重新抬回 max 旧值
              const restoredContextLength = common.savedCtxToken ?? savedState.contextLength ?? 0;
              profileLog(`[TokenDebug] conversationLoaded(savedState): restoredContextLength=${restoredContextLength} savedCtxToken=${common.savedCtxToken} savedState.contextLength=${savedState.contextLength}`);
              props.setContextLength(restoredContextLength);
              // 延迟恢复焦点和光标位置，等待 DOM 渲染完成
              setTimeout(() => {
                if (savedState.userChoiceRequest) {
                  props.choiceInputRef.current?.focus();
                  const pos = Math.min(savedState.choiceCursorPosition ?? 0, savedState.userChoiceInput?.length ?? 0);
                  props.choiceInputRef.current?.setSelectionRange(pos, pos);
                  props.choiceCursorPositionRef.current = null;
                } else {
                  props.mainInputRef.current?.focus();
                  const pos = Math.min(savedState.inputCursorPosition ?? 0, savedState.input?.length ?? 0);
                  props.mainInputRef.current?.setSelectionRange(pos, pos);
                  props.cursorPositionRef.current = null;
                }
              }, 0);
            } else {
              props.inputAreaRef.current?.setValue('');
              props.inputAreaRef.current?.setPastedImages?.([]);
              props.cursorPositionRef.current = null;
              props.choiceCursorPositionRef.current = null;
              props.setUserChoiceRequest(null);
              props.userChoiceInputRef.current = '';
              props.savedMainInputRef.current = '';
              // showThinkingAnimation 和 hasActiveQuery 由扩展端根据引擎实时状态提供
              // activityPhase 精确表示当前是 thinking / text / tool / idle，不能仅凭 hasActiveQuery 推断。
              const activityPhase = wire.activityPhase as string | undefined;
              const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
              const runtimeActive = wire.hasActiveQuery === true || phaseActive;
              props.setShowThinkingAnimation(
                runtimeActive && activityPhase !== 'tool' && activityPhase !== 'text'
              );
              props.setHasActiveQuery(runtimeActive);
              props.setAnimationMode('thinking');
              const common = applyLoadedConversationState(msg, props, propsRef.current, undefined);
              // 从 savedContext 中恢复 totalContextTokens（meta.json 中持久化的值），
              // 用于 webview 显示进度条。savedState 不存在说明是首次加载，此时应该从 meta 恢复。
              const restoredVal = common.savedCtxToken ?? 0;
              profileLog(`[TokenDebug] conversationLoaded(no savedState): restoredContextLength=${restoredVal} savedCtx.totalContextTokens=${common.savedCtxToken}`);
              props.setContextLength(restoredVal);
              // 确保 sessionStates 中有该会话的状态。首次从历史加载的对话此前没有
              // 状态条目，若不在此时创建，后续 queryBegin 会因找不到 targetState 而无法
              // 标记 hasActiveQuery，导致对话列表的流水灯不显示。
              if (!props.sessionStates.has(loadedSessionId)) {
                props.sessionStates.set(loadedSessionId, createSessionState({
                  showThinkingAnimation: runtimeActive
                    && activityPhase !== 'tool'
                    && activityPhase !== 'text',
                  animationMode: 'thinking',
                  hasActiveQuery: runtimeActive,
                  // 询问模式 / 提示词模式：宿主未下发时保持未到达（不写猜测值）
                  agentMode: wire.agentMode as AgentMode | undefined,
                  promptMode: common.savedCtxPromptMode,
                  thinkingMode: common.savedCtxThinkingMode || propsRef.current.thinkingMode,
                  webSearch: typeof common.savedCtxWebSearch === 'boolean' ? common.savedCtxWebSearch : propsRef.current.settingsDefaults.webSearch,
                  contextLength: restoredVal,
                  // 模型身份：消息顶层（扁平字段组装）→ settings.json 默认值
                  modelRef: modelRefOf(wire.provider ?? wire.savedContext?.provider, wire.model)
                    ?? propsRef.current.settingsDefaults.modelRef,
                }));
              }
              // 聚焦输入框（当没有保存的 state 时）
              setTimeout(() => {
                props.mainInputRef.current?.focus();
              }, 0);
            }
          } else {
            // sessionId 无效（消息结构异常）时才立即清除 loading 标记。
            // 正常路径的标记复位由下方 rAF 回调与 catch 统一负责：
            // 若在这里同步清空，"加载期间 updateToolStatus 进入缓冲"的防竞态机制
            // 会失效，加载中的工具状态更新会写进旧 messages 后被覆盖丢失。
            props.conversationLoadingRef.current = false;
          }
          // 设置对话标题
          if (msg.conversation && msg.conversation.metadata?.title) {
            props.setConversationTitle(resolveTitle(msg.conversation.metadata.title));
          }
          // 恢复对话消息
          if (msg.conversation && msg.conversation.messages) {
            try {
              // 有消息体时复位 loading 标记的责任交给下方 rAF 回调（setMessages 后）与
              // catch 分支；此期间 updateToolStatus 会进入缓冲，保证回放不丢。
              // 历史消息解析抽到模块级 restoreMessagesFromConversation（纯函数）
              const restoredMessages = restoreMessagesFromConversation(msg);
              const _t_beforeRaf = performance.now();
              profileLog(`[Profile] conversationLoaded 消息解析完成 | session=${(_convLoadedSessionId || '').substring(0, 20)} | 消息数=${restoredMessages.length} | 解析耗时=${(_t_beforeRaf - _t_convLoaded).toFixed(2)}ms`);
              // 在设置新消息前，先强制收起所有 details 元素
              // 避免切换对话时展开状态互相影响
              requestAnimationFrame(() => {
                const _t_rafStart = performance.now();
                const container = props.messagesContainerRef.current;
                if (container) {
                  container.querySelectorAll('details[open]').forEach((details) => {
                    details.removeAttribute('open');
                  });
                }
                // 回放跨会话缓冲的 updateToolStatus：如果缓冲中有与恢复消息匹配的更新，
                // 优先使用最新状态（工具在会话切换期间已完成，但 updateToolStatus 被 sessionId 过滤丢失了）
                replayBufferedToolStatusIntoMessages(restoredMessages, props.bufferedToolStatusRef);
                // 根据扩展端实时维护的 activityPhase 修正 thinking 动画状态；
                // 旧版本消息没有 activityPhase 时，退化为从恢复的消息内容推断当前阶段。
                // 不能用 hasActiveQuery 直接推断 thinking：查询进行中可能正处于
                // 工具执行/文本流式输出阶段，此时应显示工具卡片或文本而不是 thinking 动画。
                const activityPhase = wire.activityPhase as string | undefined;
                const hasRunningTool = restoredMessages.some(m =>
                  m.role === 'toolcall' && m.status === 'running'
                );
                const hasStreamingAssistant = restoredMessages.some(m =>
                  m.role === 'assistant' && m.isStreaming === true
                );
                const loadedState = props.sessionStates.get(_convLoadedSessionId || '');
                // 压缩任务不经过 QueryEngine，hasActiveQuery 可能为 false；
                // 因此压缩中要直接沿用 savedState 的 compacting 状态，而不是被 hasActiveQuery 关掉。
                const isCompacting = loadedState?.animationMode === 'compacting' && loadedState?.showThinkingAnimation === true;
                // 同样地，后台/子代理等场景可能让扩展端 hasActiveQuery 为 false，
                // 但本地 savedState.showThinkingAnimation / activityPhase 仍记录了“该会话正在运行”。
                const savedAnimating = loadedState?.showThinkingAnimation === true;
                const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
                const runtimeActive = savedAnimating || wire.hasActiveQuery === true || phaseActive;
                const shouldShowThinking =
                  isCompacting ||
                  (runtimeActive &&
                    (activityPhase
                      ? activityPhase !== 'tool' && activityPhase !== 'text'
                      : !hasRunningTool && !hasStreamingAssistant));
                const shouldCompact = isCompacting;
                props.setShowThinkingAnimation(shouldShowThinking);
                props.setAnimationMode(shouldCompact ? 'compacting' : 'thinking');
                if (loadedState) {
                  loadedState.showThinkingAnimation = shouldShowThinking;
                  loadedState.animationMode = shouldCompact ? 'compacting' : 'thinking';
                  if (shouldCompact || runtimeActive) {
                    loadedState.hasActiveQuery = true;
                  }
                }

                // 然后再设置新消息
                const _t_setMsgStart = performance.now();
                // 历史消息渲染前预滚动，避免大量代码/diff 先渲染再滚动
                scrollToBottomBeforeRender();
                // 加载完成，关闭 loading 动画（与 setMessages 同批次提交，避免空状态闪烁）
                props.finishConversationLoad(_convLoadedSessionId);
                // 已打开的会话：把内存缓存里的 streamId 关联回重新加载的消息，
                // 使流式性能统计（Thinking for / chars / tokens）切回来后不丢失。
                // 这些数据只在内存里，不写磁盘。
                {
                  const cachedMsgs = sessionMessagesCacheRef.current.get(_convLoadedSessionId || '');
                  if (cachedMsgs && cachedMsgs.length > 0) {
                    for (let i = 0; i < restoredMessages.length; i++) {
                      const c = cachedMsgs[i];
                      const r = restoredMessages[i];
                      if (!c || !r || r.streamId || !c.streamId) continue;
                      // 位置 + 角色 + 内容都对得上才关联，避免消息结构变化时串数据
                      if (c.role !== r.role || c.content !== r.content) continue;
                      restoredMessages[i] = { ...r, streamId: c.streamId };
                    }
                  }
                }
                props.setMessages(restoredMessages);
                // 触发强制滚动到底部：加载历史对话时，即使上一会话用户曾向上滚动
                // （userScrolledAwayRef 为 true），也要让新会话的消息滚动到最底部。
                props.setForceScrollKey((prev) => prev + 1);
                // 会话加载完成，清除 loading 标记
                props.conversationLoadingRef.current = false;
                const _t_setMsgEnd = performance.now();
                profileLog(`[Profile] setMessages同步完成 | session=${(_convLoadedSessionId || '').substring(0, 20)} | setMessages耗时=${(_t_setMsgEnd - _t_setMsgStart).toFixed(2)}ms | RAF中总耗时=${(_t_setMsgEnd - _t_rafStart).toFixed(2)}ms`);
                // 使用 requestAnimationFrame 回调完成时记录；setMessages 是批量更新，
                // 实际 React commit 在下一个 rAF 或 microtask 中，所以再等一帧
                requestAnimationFrame(() => {
                  profileLog(`[Profile] setMessages提交(首次渲染) | session=${(_convLoadedSessionId || '').substring(0, 20)} | 从收到消息到首次RAF渲染=${(performance.now() - _t_convLoaded).toFixed(2)}ms`);
                  // 再等一帧，让 React commit 和布局完成
                  requestAnimationFrame(() => {
                    profileLog(`[Profile] 渲染稳定(第二帧) | session=${(_convLoadedSessionId || '').substring(0, 20)} | 总耗时=${(performance.now() - _t_convLoaded).toFixed(2)}ms`);
                  });
                });
              });
            } catch (error) {
              console.error('[App] 恢复对话时出错:', error);
              props.conversationLoadingRef.current = false;
              // 恢复失败也必须结束 loading，否则遮罩会永久留在页面上
              props.finishConversationLoad(_convLoadedSessionId);
            }
          } else {
            // 没有消息体（异常/空载荷）：同样结束 loading，避免遮罩卡死
            props.finishConversationLoad(_convLoadedSessionId);
          }
          return;
}

export function handleConversationMessagesReplaced(
  msg: Extract<HostToWebviewWire, { type: 'messagesReplaced' }>,
  ctx: HandlerContext,
): void {
  const { props, scrollToBottomBeforeRender, sessionId } = ctx;
          // 整批替换本地消息列表（core 的压缩后重建 / 宿主的展开归档共用这一条）。
          // 与 addMessage 的差别：这里不追加、不处理排队消息与 token 累加，
          // 只把整批历史消息铺成当前列表。
          if (msg.sessionId && msg.sessionId !== sessionId) {
            return;
          }
          scrollToBottomBeforeRender();
          props.setMessages(msg.messages.map(toUiMessage));
          props.setContextLength(0);
}

export function handleConversationQueuedMessage(
  msg: Extract<HostToWebviewWire, { type: 'queuedMessage' }>,
  ctx: HandlerContext,
): void {
  const { props, sessionId } = ctx;
          const wire = msg;
          // 按会话存储排队消息（绑定 sessionId），切换会话后仍能正确归属
          if (msg.sessionId) {
            const payload: QueuedMessagePayload = {
              sessionId: msg.sessionId,
              uuid: wire.uuid,
              content: msg.content,
              images: msg.images,
              filePath: wire.filePath,
              selectedLines: wire.selectedLines,
              fileHidden: wire.fileHidden,
            };
            props.queuedMessageRef.current.set(msg.sessionId, payload);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(payload);
              // 排队消息出现时触发自动滚动，让用户看到排队提示
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
          return;
}

export function handleConversationClearQueuedMessage(
  msg: Extract<HostToWebviewWire, { type: 'clearQueuedMessage' }>,
  ctx: HandlerContext,
): void {
  const { props, sessionId } = ctx;
          // 仅清除指定会话的排队消息，不影响其他会话的排队项
          if (msg.sessionId) {
            props.queuedMessageRef.current.delete(msg.sessionId);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(null);
              // 排队消息清除时触发自动滚动
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
}

export function handleConversationSmartNamingResult(
  msg: Extract<HostToWebviewWire, { type: 'smartNamingResult' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          const wire = msg;
          profileLog('[App] smartNamingResult received', msg);
          // 只清「命名中」标记：标题与列表不由本地改——core 落盘后广播
          // titleChanged / conversationListChanged，webview 只消费那两条消息
          {
            const namingSessionId = wire.sessionId;
            props.setNamingSessions(prev => {
              const next = new Set(prev);
              next.delete(namingSessionId);
              return next;
            });
          }
          return;
}

export function handleConversationExpandCompactDone(
  msg: Extract<HostToWebviewWire, { type: 'expandCompactDone' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          // 展开完成，隐藏展开按钮
          props.setHasCompactArchive(false);
          props.setIsCompactExpanded(true);
}

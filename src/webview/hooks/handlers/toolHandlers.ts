import type { HandlerContext } from './handlerContext';
import { HostToWebviewWire } from '../../../host/webviewMessages';
import { profileLog } from '../../debug';
import { accumulateUsageToState, ensureSessionStateWithUsage } from '../../sessionState';
import { Message } from '../../types';
import { TOOL_STATUS_PRIORITY, stripOnce, toToolStatusEntry, toUiMessage } from './shared';

/**
 * webview 消息处理的 tool 域 handler。
 *
 * 由 useMessageHandler 的 switch 转发：msg 是判别收窄后的 wire 消息，
 * ctx 是 hook 注入的共享上下文（props / 各 ref / 当前会话判定）。
 * handler 保持同步纯转发语义，不自行订阅事件。
 */
export function handleToolAddMessage(
  msg: Extract<HostToWebviewWire, { type: 'addMessage' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, lastActivityBySessionRef, scrollToBottomBeforeRender, sessionId } = ctx;
          const wire = msg;
          profileLog(`[Webview] addMessage: role=${msg.role} toolName=${msg.toolName || '-'} sessionMatch=${msg.sessionId === sessionId} origin=${msg.origin || 'user'} isCompactSummary=${!!msg.isCompactSummary} contentStart=${(msg.content || '').substring(0, 50)}`);
          // 排队消息被后端真正消费并显示后，清除该会话的排队状态：
          // 入队消息已进入引擎队列，会在下次 LLM 请求时被带上，
          // 不需要等待 queryEnd 重新投递（避免重复发送）。
          // 按消息 uuid 配对清除（文本相同的两条消息互不影响）。
          // 放在 session 过滤之前，即使消息属于非当前会话也清除对应排队项。
          if (msg.role === 'user' && msg.sessionId && msg.messageUuid) {
            const queued = props.queuedMessageRef.current.get(msg.sessionId);
            if (queued !== undefined && queued.uuid === msg.messageUuid) {
              props.queuedMessageRef.current.delete(msg.sessionId);
              if (msg.sessionId === sessionId) {
                props.setQueuedMessage(null);
              }
            }
          }
          // 记录活动时间：下一个 thinking block 从这条消息算起
          if (msg.sessionId) {
            lastActivityBySessionRef.current.set(msg.sessionId, Date.now());
          }
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId && msg.sessionId !== sessionId) {
            return;
          }

          const newMessage: Message = toUiMessage(msg);

          // 新消息渲染前先把滚动容器预滚到底部，避免 Bash/Write/Edit 等
          // 工具卡片先渲染出来、再被滚动到视野内。
          scrollToBottomBeforeRender();

          // 用户消息直接追加（无本地占位）；追加前剥除 once 通知（specs/014）
          if (msg.role === 'user') {
            props.setMessages((prev) => {
              const next = [...stripOnce(prev), newMessage];
              profileLog(`[Webview] addMessage USER APPEND | msgs.length ${prev.length}->${next.length} | contentStart=${(msg.content || '').substring(0, 50)}`);
              return next;
            });
          } else if (msg.role === 'toolcall' && (msg.toolName || '').toLowerCase().replace(/[-_]/g, '') === 'websearch') {
            // WebSearch 卡片：按时间顺序增量追加到末尾。
            // 之前的"插入到第一条 assistant 文本之前"逻辑在单轮多文本块场景下会失效：
            // Responses API 可在一轮内输出"思考→文字→搜索→思考→文字→搜索…"，
            // 若每次都插到第一条文本前，所有卡片会堆在一起且顺序错乱。
            // 与 thinking/text 流式消息一致，工具卡片也应增量追加，保持 chronological 顺序。
            props.setMessages((prev) => {
              const next = [...stripOnce(prev), newMessage];
              profileLog(`[Webview] addMessage WebSearch APPEND | msgs.length ${prev.length}->${next.length}`);
              return next;
            });
          } else {
            props.setMessages((prev) => {
              // 工具卡片按 toolCallId 去重：历史恢复（conversationLoaded）已经用 tool_use
              // block 建过卡片的场景下，实时 addMessage 不能再追加一张，否则同一个工具会
              // 渲染两次。命中已有卡片时就地更新，并保留历史恢复时的时间戳。
              if (msg.role === 'toolcall' && newMessage.toolCallId) {
                const idx = prev.findIndex(
                  (m) => m.role === 'toolcall' && m.toolCallId === newMessage.toolCallId,
                );
                if (idx >= 0) {
                  const existing = prev[idx];
                  const next = [...prev];
                  next[idx] = {
                    ...existing,
                    ...newMessage,
                    timestamp: existing.timestamp,
                    // 不把已经推进到 success/fail 的卡片降级回 normal/running
                    status: (TOOL_STATUS_PRIORITY[newMessage.status || ''] ?? 0)
                      >= (TOOL_STATUS_PRIORITY[existing.status || ''] ?? 0)
                      ? newMessage.status
                      : existing.status,
                    toolArgs: { ...(existing.toolArgs || {}), ...(newMessage.toolArgs || {}) },
                  };
                  profileLog(`[Webview] addMessage toolcall DEDUP: ${newMessage.toolCallId} | msgs.length ${prev.length}`);
                  return next;
                }
              }
              // 追加新节点：先剥除 once 通知（specs/014 后继即删）
              const next = [...stripOnce(prev), newMessage];
              profileLog(`[Webview] addMessage APPEND: role=${msg.role} origin=${msg.origin || 'user'} | msgs.length ${prev.length}->${next.length} | contentStart=${(msg.content || '').substring(0, 50)}`);
              return next;
            });
          }

          // 当收到工具调用消息时，强制关闭 thinking 动画
          // 例外：WebSearch（模型内置联网搜索）搜索发生在 LLM 流内且耗时较长，
          // 工具卡片本身没有动态反馈，若关闭动画界面会显得"卡死"，
          // 因此搜索期间保留（甚至重新打开）thinking 动画，待 onAIEnd 时再统一隐藏。
          if (msg.role === 'toolcall') {
            const toolNameNorm = (msg.toolName || '').toLowerCase().replace(/[-_]/g, '');
            if (toolNameNorm === 'websearch') {
              props.setShowThinkingAnimation(true);
            } else {
              props.setShowThinkingAnimation(false);
            }
          }

          // 更新 context length（仅对 thinking 和 assistant 消息，它们携带 token 数据）
          if (msg.role === 'thinking' || msg.role === 'assistant') {
            // contextLength = API 返回的 input_tokens（当前对话的输入 token 数）
            // outputTokens  = API 返回的 output_tokens（本次 LLM 输出的 token 数）
            // totalTokens   = input + output（当前对话累计到此刻的总 token 数）
            const inputTokens = wire.contextLength || 0;
            const outputTokens = wire.outputTokens || 0;
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = wire.cacheReadInputTokens || 0;
            const cacheCreationTokens = wire.cacheCreationInputTokens || 0;
            profileLog(`[TokenDebug] addMessage: role=${msg.role} contextLength=${wire.contextLength} outputTokens=${wire.outputTokens} totalTokens=${totalTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
            if (totalTokens > 0) {
              // 直接使用服务端返回的 input+output，不取 max；压缩后服务端会返回更小的数值，
              // 如果继续 max 会导致压缩后的 context 显示仍然停留在压缩前的旧值。
              props.setContextLength(totalTokens);
              // 同时保存到当前 session 的 state 中
              if (props.currentSessionIdRef.current) {
                const state = props.sessionStates.get(props.currentSessionIdRef.current);
                if (state) {
                  // 只在 assistant 消息上累加缓存（避免 thinking 和 assistant 重复）
                  accumulateUsageToState(state, msg.role, totalTokens, inputTokens, cacheReadTokens, cacheCreationTokens);
                } else {
                  ensureSessionStateWithUsage(
                    props.sessionStates,
                    props.currentSessionIdRef.current,
                    msg.role,
                    totalTokens,
                    inputTokens,
                    cacheReadTokens,
                    cacheCreationTokens,
                    {
                      promptMode: propsRef.current.settingsDefaults.promptMode,
                      modelRef: propsRef.current.modelRef,
                    },
                  );
                }
              }
            }
          }

          // Hide thinking animation when we receive an assistant message
          if (msg.role === 'assistant') {
            props.setShowThinkingAnimation(false);
          }
          return;
}

export function handleToolUpdateToolArgs(
  msg: Extract<HostToWebviewWire, { type: 'updateToolArgs' }>,
  ctx: HandlerContext,
): void {
  const { props, scrollToBottomBeforeRender, sessionId } = ctx;
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            return;
          }
          // 工具参数（如 Edit beforeContent/afterContent、Write preview）更新前预滚动
          scrollToBottomBeforeRender();
          // 更新消息中工具调用的参数
          props.setMessages((prevMessages) => {
            return prevMessages.map((m) => {
              if (m.role === 'toolcall' && (m as any).toolCallId === msg.toolCallId) {
                const existingArgs = (m as any).toolArgs || {};
                const updatedMsg = { ...m };
                (updatedMsg as any).toolArgs = {
                  ...existingArgs,
                  // 通用参数更新：WebSearch 等工具在完成后补全 action/queries/url
                  ...(msg.toolArgs || {}),
                  contextBefore: msg.contextBefore || [],
                  contextAfter: msg.contextAfter || [],
                  beforeContent: msg.beforeContent !== undefined ? msg.beforeContent : existingArgs.beforeContent || '',
                  afterContent: msg.afterContent !== undefined ? msg.afterContent : existingArgs.afterContent || '',
                  diffHunks: msg.diffHunks !== undefined ? msg.diffHunks : existingArgs.diffHunks,
                  startLine: msg.startLine,
                  endLine: msg.endLine,
                };
                return updatedMsg;
              }
              return m;
            });
          });
          // 工具参数变化可能导致 Edit/Write 预览高度变化，触发一次滚动同步。
          props.setStreamingVersion(v => v + 1);
}

export function handleToolUpdateToolStatus(
  msg: Extract<HostToWebviewWire, { type: 'updateToolStatus' }>,
  ctx: HandlerContext,
): void {
  const { props, lastActivityBySessionRef, scrollToBottomBeforeRender, sessionId } = ctx;
          // 记录活动时间：工具完成后的下一个 thinking block 从这里算起
          if (msg.sessionId && (msg.status === 'success' || msg.status === 'fail')) {
            lastActivityBySessionRef.current.set(msg.sessionId, Date.now());
          }
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            // 不是当前会话的更新：存入跨会话缓冲区，供 conversationLoaded 时回放
            props.bufferedToolStatusRef.current.set(msg.toolCallId, toToolStatusEntry(msg));
            return;
          }
          // 🔴 conversationLoading 期间，所有 updateToolStatus（即使是当前会话的消息）
          // 也进入缓冲，由 conversationLoaded 的 rAF 回调统一回放。
          // 避免正常 rAF 路径（pendingToolStatusRef）与 props.setMessages(restoredMessages)
          // 之间的时序竞态导致状态丢失。
          if (props.conversationLoadingRef.current) {
            props.bufferedToolStatusRef.current.set(msg.toolCallId, toToolStatusEntry(msg));
            return;
          }
          // 使用函数式更新 + 防抖：将频繁的 status 更新合并到下一次 rAF 中
          if (!props.toolStatusRafRef.current) {
            props.toolStatusRafRef.current = requestAnimationFrame(() => {
              props.toolStatusRafRef.current = null;
              // 消费缓冲队列中的所有更新
              const pending = props.pendingToolStatusRef.current;
              props.pendingToolStatusRef.current = new Map();
              if (pending.size === 0) return;

              // 工具结果渲染前预滚动（Bash 输出等）
              scrollToBottomBeforeRender();

              props.setMessages((prev) => {
                // 一次性应用所有缓冲的更新：使用下标替换避免全量 map 遍历
                let changed = false;
                const next = prev.slice(); // 浅拷贝一次
                for (let i = 0; i < next.length; i++) {
                  const m = next[i];
                  if (m.role !== 'toolcall') continue;
                  const update = pending.get(m.toolCallId!);
                  if (!update) continue;
                  changed = true;
                  // 工具完成（success/fail）时清除流式标记；running 时保留已有标记
                  const updated = {
                    ...m,
                    content: update.output || m.content,
                    status: update.status as any,
                    isStreaming: update.status === 'success' || update.status === 'fail' ? false : m.isStreaming,
                  };

                  if (update.startLine !== undefined || update.endLine !== undefined) {
                    const toolArgs = { ...((m as any).toolArgs || {}) };
                    if (update.startLine !== undefined) toolArgs.startLine = update.startLine;
                    if (update.endLine !== undefined) toolArgs.endLine = update.endLine;
                    (updated as any).toolArgs = toolArgs;
                  }
                  if (update.toolResultTimestamp) (updated as any).toolResultTimestamp = update.toolResultTimestamp;
                  if (update.toolStartTimestamp) (updated as any).toolStartTimestamp = update.toolStartTimestamp;
                  next[i] = updated;
                }
                // 未匹配的更新（toolCallId 不在当前 messages 中）重新导向 buffered 备用
                for (const [toolCallId, update] of pending) {
                  if (!next.some(m => m.role === 'toolcall' && m.toolCallId === toolCallId)) {
                    props.bufferedToolStatusRef.current.set(toolCallId, { ...update });
                  }
                }
                return changed ? next : prev;
              });
              // 工具状态变更（如运行中→完成）更新了消息内容/状态时，
              // 递增 streamingVersion 触发 MessagesView 的 useLayoutEffect 重新执行，
              // 确保自动滚动到最新输出位置。
              // 注意：不能依赖 setMessages 的 updater 返回值来判断是否有变化——
              // React 18 的函数式 updater 在 render 阶段才执行，此时读取 hasChanges
              // 永远是 false，会导致 streamingVersion 从不递增、自动滚动失效。
              // 既然 rAF 批次只有在 pending 有数据时才存在，直接无条件递增即可
              // （内容未变化时 scrollToBottom 是幂等操作，无副作用）。
              props.setStreamingVersion(v => v + 1);
            });
          }
          // 将更新压入缓冲队列（Map 直接覆盖相同 key）
          props.pendingToolStatusRef.current.set(msg.toolCallId, toToolStatusEntry(msg));
}

export function handleToolToolProgress(
  msg: Extract<HostToWebviewWire, { type: 'toolProgress' }>,
  ctx: HandlerContext,
): void {
  const { props, scrollToBottomBeforeRender, sessionId } = ctx;
          // Bash 流式输出：过滤非当前 session 的消息
          if (msg.sessionId && msg.sessionId !== sessionId) {
            return;
          }
          // 使用 rAF throttle 合并高频进度更新，仅保留每个工具的最新累积输出
          if (!props.toolProgressRafRef.current) {
            props.toolProgressRafRef.current = requestAnimationFrame(() => {
              props.toolProgressRafRef.current = null;
              const pending = props.pendingToolProgressRef.current;
              props.pendingToolProgressRef.current = new Map();
              if (pending.size === 0) return;

              // Bash 流式输出渲染前预滚动
              scrollToBottomBeforeRender();

              props.setMessages(prev => {
                let changed = false;
                let next = prev;
                for (let i = 0; i < prev.length; i++) {
                  const m = prev[i];
                  if (m.role !== 'toolcall' || !m.toolCallId) continue;
                  const update = pending.get(m.toolCallId);
                  if (!update) continue;
                  if (!changed) {
                    next = prev.slice();
                    changed = true;
                  }
                  next[i] = {
                    ...m,
                    content: update.output,
                    isStreaming: true,
                    toolStartTimestamp: m.toolStartTimestamp ?? Date.now(),
                  };
                }
                return changed ? next : prev;
              });
              // 同 updateToolStatus：不能依赖 updater 内部的 hasChanges 判断
              // （React 18 函数式 updater 在 render 阶段才执行），否则 streamingVersion
              // 永不递增，Bash 流式输出增长时 MessagesView 不会自动滚动到底部。
              // rAF 批次只在 pending 有数据时存在，直接无条件递增即可。
              props.setStreamingVersion(v => v + 1);
            });
          }
          // 记录最新累积输出（Map 直接覆盖相同 key，只保留最新）
          props.pendingToolProgressRef.current.set(msg.toolCallId, {
            toolCallId: msg.toolCallId,
            output: msg.output || '',
            elapsedTimeSeconds: msg.elapsedTimeSeconds,
            totalLines: msg.totalLines,
            totalBytes: msg.totalBytes,
          });
}

export function handleToolRequestUserChoice(
  msg: Extract<HostToWebviewWire, { type: 'requestUserChoice' }>,
  ctx: HandlerContext,
): void {
  const { props, sessionId } = ctx;
          // 存储到当前 session 的状态中
          if (props.sessionStates.has(msg.sessionId)) {
            const state = props.sessionStates.get(msg.sessionId)!;
            state.userChoiceRequest = {
              choiceId: msg.choiceId,
              toolName: msg.toolName,
              message: msg.message,
              choices: msg.choices !== undefined && msg.choices.length > 0 ? msg.choices : undefined,
            };
          }
          if (msg.sessionId === sessionId) {
            // 保存主输入框内容和光标位置，关闭时需要恢复
            props.cursorPositionRef.current = props.mainInputRef.current?.selectionStart ?? props.inputAreaRef.current?.getValue()?.length ?? 0;
            props.savedMainInputRef.current = props.inputAreaRef.current?.getValue() ?? '';
            // 同时更新全局状态以显示对话框
            props.setUserChoiceRequest({
              choiceId: msg.choiceId,
              toolName: msg.toolName,
              message: msg.message,
              choices: msg.choices !== undefined && msg.choices.length > 0 ? msg.choices : undefined,
            });
          }
}

export function handleToolToolMetaData(
  msg: Extract<HostToWebviewWire, { type: 'toolMetaData' }>,
  ctx: HandlerContext,
): void {
  const { props, scrollToBottomBeforeRender } = ctx;
          // EditFile 等工具异步加载完 diff 内容后，容器高度可能发生变化。
          // 先在渲染前预滚动，避免 diff 先出现在视野内再被滚动。
          scrollToBottomBeforeRender();
          // 递增 streamingVersion 触发 MessagesView 的 useLayoutEffect 重新执行，
          // 从而调用 scrollToBottom()，避免概率性出现 diff 展开但未自动滚到底的问题。
          // 使用 requestAnimationFrame 确保 React 已完成 diff DOM 的渲染和布局，
          // 避免在 useLayoutEffect 执行时 diff DOM 尚未渲染到布局中。
          requestAnimationFrame(() => {
            props.setStreamingVersion((prev) => prev + 1);
          });
}

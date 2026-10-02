import type { HandlerContext } from './handlerContext';
import { HostToWebviewWire } from '../../../host/webviewMessages';
import { profileLog } from '../../debug';
import { createSessionState, ensureSessionStateWithUsage } from '../../sessionState';
import { beginThinkingStream, endStream, endStreamsForSession, hasStreamStats, updateStreamChars } from '../../streamStatsStore';
import { postMessage } from '../../webviewEnv';

/**
 * webview 消息处理的 stream 域 handler。
 *
 * 由 useMessageHandler 的 switch 转发：msg 是判别收窄后的 wire 消息，
 * ctx 是 hook 注入的共享上下文（props / 各 ref / 当前会话判定）。
 * handler 保持同步纯转发语义，不自行订阅事件。
 */
export function handleStreamShowThinkingAnimation(
  msg: Extract<HostToWebviewWire, { type: 'showThinkingAnimation' }>,
  ctx: HandlerContext,
): void {
  const { props, sessionId } = ctx;
          // 存储到当前 session 的状态中
          if (msg.sessionId && props.sessionStates.has(msg.sessionId)) {
            const state = props.sessionStates.get(msg.sessionId)!;
            state.showThinkingAnimation = msg.show !== false;
            state.animationMode = 'thinking';
          }
          if (msg.sessionId === sessionId) {
            // 更新全局状态
            props.setShowThinkingAnimation(msg.show !== false);
            // 非压缩场景下的 thinking 动画
            props.setAnimationMode('thinking');
          }
}

export function handleStreamAiEnd(
  _msg: Extract<HostToWebviewWire, { type: 'aiBegin' }> | Extract<HostToWebviewWire, { type: 'aiEnd' }>,
  _ctx: HandlerContext,
): void {
          // 扩展端用于同步 thinking 动画的辅助消息；webview 侧的动画已由
          // queryBegin/queryEnd 与 showThinkingAnimation 驱动，这里显式忽略，
          // 避免每轮 LLM 调用都刷 "Unknown message type" 警告。
}

export function handleStreamQueryBegin(
  msg: Extract<HostToWebviewWire, { type: 'queryBegin' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, queryStartBySessionRef, lastActivityBySessionRef } = ctx;
          // 记录该 session 本轮 query 的起始时间（用于 TTFT）。
          // 放在 session 过滤之前：即使该会话当前不在前台，也要记录，切回来时才有 TTFT。
          if (msg.sessionId) {
            const now = Date.now();
            queryStartBySessionRef.current.set(msg.sessionId, now);
            lastActivityBySessionRef.current.set(msg.sessionId, now);
            // 新一轮查询开始：清除可能残留的 abort 标记（例如在空闲态误点 abort，
            // 后端不会发出 queryEnd，标记需要在这里兜底清理）。
            props.abortedSessionsRef.current.delete(msg.sessionId);
          }
          // 即使被当前 session 过滤，也更新目标 session 的状态（供后续 conversationLoaded 恢复）
          if (msg.sessionId) {
            const targetState = props.sessionStates.get(msg.sessionId);
            if (targetState) {
              targetState.hasActiveQuery = true;
              // 同步动画状态到会话快照，确保之后切换回该会话时能立即恢复 thinking 动画
              targetState.showThinkingAnimation = true;
              targetState.animationMode = 'thinking';
            } else {
              // 会话状态不存在（例如从历史记录加载后首次发消息的对话）时创建，
              // 否则 queryBegin 无法标记 hasActiveQuery，对话列表的流水灯不会显示。
              props.sessionStates.set(msg.sessionId, createSessionState({
                showThinkingAnimation: true,
                animationMode: 'thinking',
                hasActiveQuery: true,
                agentMode: propsRef.current.settingsDefaults.agentMode ?? propsRef.current.agentMode,
                promptMode: propsRef.current.settingsDefaults.promptMode,
                thinkingMode: propsRef.current.settingsDefaults.thinkingMode,
                webSearch: propsRef.current.settingsDefaults.webSearch,
                modelRef: propsRef.current.modelRef,
              }));
            }
            // 对话树流水灯不在这里刷新：它只读 core 推送的 sessionRuntimeStates
          }
          // 只有当前 session 的消息才更新 UI
          // 如果当前没有 session（props.currentSessionIdRef.current 为 null），也接受 queryBegin
          if (msg.sessionId && props.currentSessionIdRef.current && msg.sessionId !== props.currentSessionIdRef.current) {
            return;
          }
          props.setHasActiveQuery(true);
          // 查询开始即显示 thinking 动画；即使扩展端先发的 showThinkingAnimation
          // 因时序问题未更新到 UI，这里也保证动画能立刻出现。
          props.setShowThinkingAnimation(true);
          props.setAnimationMode('thinking');
}

export function handleStreamQueryEnd(
  msg: Extract<HostToWebviewWire, { type: 'queryEnd' }>,
  ctx: HandlerContext,
): void {
  const { props, queryStartBySessionRef, lastActivityBySessionRef, restoreQueuedMessageToInput } = ctx;
          // 即使被当前 session 过滤，也更新目标 session 的状态
          const endedSessionId = msg.sessionId;
          if (endedSessionId) {
            // 查询结束（含 abort）：冻结该会话所有仍在流式的统计，保留 abort 前最后一次的值
            endStreamsForSession(endedSessionId);
            // 清理该会话本轮 query 起始时间（无论是否当前会话）
            queryStartBySessionRef.current.delete(endedSessionId);
            lastActivityBySessionRef.current.delete(endedSessionId);
            const targetState = props.sessionStates.get(endedSessionId);
            if (targetState) {
              targetState.hasActiveQuery = false;
              // 查询结束（含中断）时同步关闭 thinking 动画，避免残留
              targetState.showThinkingAnimation = false;
              targetState.animationMode = 'thinking';
            }
            // 对话树流水灯不在这里刷新：它只读 core 推送的 sessionRuntimeStates
          }
          // 用户主动 abort 的会话：排队消息不再重新投递，而是回填到输入框，
          // 与用户当前草稿用 \n 连接，交给用户自行修改/重发。
          const abortedByUser = endedSessionId
            ? props.abortedSessionsRef.current.delete(endedSessionId)
            : false;
          // 查询结束后，如果该会话仍有排队消息（未被后端消费，如入队失败/引擎缺失），
          // 将消息投递到"该会话"（而不是当前会话），保证排队消息与会话绑定。
          if (endedSessionId) {
            const queued = props.queuedMessageRef.current.get(endedSessionId);
            if (queued) {
              props.queuedMessageRef.current.delete(endedSessionId);
              if (endedSessionId === props.currentSessionIdRef.current) {
                props.setQueuedMessage(null);
              }
              if (abortedByUser) {
                // abort：不回发排队消息，回填到输入框等待用户确认
                restoreQueuedMessageToInput(endedSessionId, queued);
              } else {
                postMessage({
                  type: 'sendMessage',
                  sessionId: endedSessionId,
                  content: queued.content,
                  images: queued.images,
                  filePath: queued.filePath,
                  selectedLines: queued.selectedLines,
                  fileHidden: queued.fileHidden,
                });
              }
            }
          }
          // 只有当前 session 的消息才更新 UI
          // 如果当前没有 session（props.currentSessionIdRef.current 为 null），也接受 queryEnd
          if (endedSessionId && props.currentSessionIdRef.current && endedSessionId !== props.currentSessionIdRef.current) {
            return;
          }
          props.setHasActiveQuery(false);
          // 查询结束（含中断）时同步关闭 thinking 动画，避免残留
          props.setShowThinkingAnimation(false);
          props.setAnimationMode('thinking');
          // abort 时服务端不会为未完成的流发 streamEnd，这里兜底把仍在流式的消息标记完成，
          // 避免 isStreaming 永远为 true（自动滚动轮询停不下来）。
          props.setMessages(prev => {
            if (!prev.some(m => m.isStreaming)) return prev;
            return prev.map(m => (m.isStreaming ? { ...m, isStreaming: false } : m));
          });
          return;
}

export function handleStreamStreamMessage(
  msg: Extract<HostToWebviewWire, { type: 'streamMessage' }>,
  ctx: HandlerContext,
): void {
  const { props, queryStartBySessionRef, lastActivityBySessionRef, scrollToBottomBeforeRender, sessionId } = ctx;
          const wire = msg;
          // streamId 由 RealApi.ts 保证每次 LLM 调用生成唯一 ID，不会为 undefined
          const streamId = wire.streamId!;
          const accumulated = msg.accumulated;
          const role = msg.role;
          const msgSessionId = msg.sessionId || sessionId || '';
          const now = Date.now();
          // 全局流式统计：所有会话都更新（切换走后仍继续刷新，只是不渲染）
          if (role === 'thinking' && streamId) {
            if (!hasStreamStats(streamId)) {
              // 首个 delta：登记统计。起始时间取「该 block 开始前最后一次活动」，
              // 而不是 query 起点，避免多 block（思考→工具→思考…）时时间累计。
              const startAt = lastActivityBySessionRef.current.get(msgSessionId)
                ?? queryStartBySessionRef.current.get(msgSessionId)
                ?? null;
              beginThinkingStream({
                streamId,
                sessionId: msgSessionId,
                firstTokenAt: now,
                thinkingStartAt: startAt,
              });
            }
            updateStreamChars(streamId, accumulated.length);
          }
          // 记录活动时间，供下一个 thinking block 计算自己的首 token 耗时
          lastActivityBySessionRef.current.set(msgSessionId, now);
          // 过滤：只有当前 session 的消息才渲染
          if (msg.sessionId && msg.sessionId !== sessionId) {
            return;
          }
          // thinking 流式消息到达时确保 thinking 动画处于显示状态。
          // 覆盖“切换会话后恢复失败”或 showThinkingAnimation 消息丢失的时序问题。
          if (role === 'thinking') {
            props.setShowThinkingAnimation(true);
            props.setAnimationMode('thinking');
            if (sessionId) {
              const currentState = props.sessionStates.get(sessionId);
              if (currentState) {
                currentState.showThinkingAnimation = true;
                currentState.animationMode = 'thinking';
              }
            }
          }
          const mapKey = streamId + ':' + role;
          props.pendingStreamRef.current.set(mapKey, { role, accumulated, streamId });
          if (!props.streamRafRef.current) {
            props.streamRafRef.current = requestAnimationFrame(() => {
              props.streamRafRef.current = null;
              const buffer = props.pendingStreamRef.current;
              props.pendingStreamRef.current = new Map();
              if (buffer.size === 0) return;

              // 流式文本/代码渲染前预滚动
              scrollToBottomBeforeRender();

              props.setMessages(prev => {
                let next = prev;
                for (const [, { role: r, accumulated: acc, streamId: sid }] of buffer) {
                  // 用 streamId + role 精确匹配已有消息
                  let lastIdx = -1;
                  for (let i = prev.length - 1; i >= 0; i--) {
                    const m = prev[i] as any;
                    if (m.streamId === sid && m.role === r) {
                      lastIdx = i;
                      break;
                    }
                  }
                  if (lastIdx >= 0) {
                    // 下标直写，避免全量 map 遍历 O(n)
                    next = next === prev ? next.slice() : next;
                    next[lastIdx] = { ...next[lastIdx], content: acc, isStreaming: true };
                  } else {
                    next = next.concat({
                      role: r as any,
                      content: acc,
                      isStreaming: true,
                      streamId: sid,
                      timestamp: Date.now(),
                    } as any);
                  }
                }
                return next;
              });
              props.setStreamingVersion(v => v + 1);
            });
          }
          return;
}

export function handleStreamStreamEnd(
  msg: Extract<HostToWebviewWire, { type: 'streamEnd' }>,
  ctx: HandlerContext,
): void {
  const { props, propsRef, contextLengthRef, lastActivityBySessionRef, scrollToBottomBeforeRender, sessionId } = ctx;
          const wire = msg;
          // 更新 token 用量：即使 sessionId 不匹配也要累加到对应 session 的 state 中，
          // 否则子代理（Agent Tool）在后台运行时，其 cache token 数据会丢失，
          // 导致切换到子代理后 Cache 命中率不显示。
          const streamEndSessionId = msg.sessionId || sessionId;
          // 全局流式统计：所有会话都结束（非当前会话切换走后也要收敛）
          const streamEndStreamId = wire.streamId;
          if (streamEndStreamId) {
            endStream(streamEndStreamId, {
              outputTokens: wire.usage?.output_tokens,
              reasoningTokens: wire.usage?.reasoning_tokens,
            });
          }
          // 记录活动时间：下一个 thinking block 从这次结束算起
          if (streamEndSessionId) {
            lastActivityBySessionRef.current.set(streamEndSessionId, Date.now());
          }
          if (streamEndSessionId !== sessionId) {
            profileLog(`[TokenDebug] streamEnd: session mismatch, updating session state for ${(streamEndSessionId || '').substring(0,20)} (current=${(sessionId || '').substring(0,20)})`);
            // 仍然更新非当前 session 的 cache token 数据到 sessionStates
            if (streamEndSessionId && wire.usage) {
              const usage = wire.usage;
              const cacheReadTokens = usage.cache_read_input_tokens || 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
              const inputTokens = usage.input_tokens || 0;
              const outputTokens = usage.output_tokens || 0;
              const totalTokens = inputTokens + outputTokens;
              const role = msg.role;
              if (totalTokens > 0) {
                ensureSessionStateWithUsage(
                  props.sessionStates,
                  streamEndSessionId,
                  role,
                  totalTokens,
                  inputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  {
                    promptMode: propsRef.current.settingsDefaults.promptMode,
                    modelRef: propsRef.current.modelRef,
                  },
                );
                profileLog('[TokenDebug] streamEnd(sessionMismatch): updated/created session state for', streamEndSessionId);
              }
            }
            return;
          }
          const streamId = wire.streamId!;
          const accumulated = msg.accumulated;
          const role = msg.role;
          const mapKey = streamId + ':' + role;
          profileLog(`[TokenDebug] streamEnd: role=${role} streamId=${streamId} hasUsage=${!!wire.usage} usage=${JSON.stringify(wire.usage)}`);
          // 取出缓冲中的目标 stream（streamId+role 精确匹配）参与本次收尾；
          // 其它仍在流式的 stream（如 thinking 与 text 并发）留在缓冲里，
          // 等它们自己的 rAF/streamEnd 处理，否则会被提前标记为 isStreaming:false 造成闪烁。
          const bufferedThis = props.pendingStreamRef.current.get(mapKey);
          props.pendingStreamRef.current.delete(mapKey);
          const finalBuffer = new Map([[mapKey, bufferedThis ?? { role, accumulated, streamId }]]);
          // 剩余仍在流式的条目保留在 pendingStreamRef，不取消它们的 rAF：
          // 只有当缓冲被本次完全清空（没有其它流）时才取消。
          if (props.pendingStreamRef.current.size === 0 && props.streamRafRef.current) {
            cancelAnimationFrame(props.streamRafRef.current);
            props.streamRafRef.current = null;
          }
          if (finalBuffer.size > 0) {
            // 流式结束的最终内容渲染前预滚动
            scrollToBottomBeforeRender();
            // 服务端在流结束时返回精确的 token 数，写入消息供 ThinkingMessage
            // 完成后显示真实 token（流式期间只有字符数可用）。
            // - output_tokens：本次调用的总输出 token（thinking + 正文）
            // - reasoning_tokens：其中思考部分（Responses API 才有），优先用于 thinking 消息
            const usageOutputTokens = wire.usage?.output_tokens;
            const usageReasoningTokens = wire.usage?.reasoning_tokens;
            props.setMessages(prev => {
              let next = prev;
              for (const [, { role: r, accumulated: acc, streamId: sid }] of finalBuffer) {
                let lastIdx = -1;
                for (let i = prev.length - 1; i >= 0; i--) {
                  const m = prev[i] as any;
                  if (m.streamId === sid && m.role === r) {
                    lastIdx = i;
                    break;
                  }
                }
                const tokenPatch = {
                  ...(typeof usageOutputTokens === 'number' && usageOutputTokens > 0 ? { outputTokens: usageOutputTokens } : {}),
                  ...(r === 'thinking' && typeof usageReasoningTokens === 'number' && usageReasoningTokens > 0
                    ? { reasoningTokens: usageReasoningTokens }
                    : {}),
                };
                if (lastIdx >= 0) {
                  // 下标直写，避免全量 map 遍历 O(n)
                  next = next === prev ? next.slice() : next;
                  next[lastIdx] = { ...next[lastIdx], content: acc, isStreaming: false, ...tokenPatch };
                } else {
                  next = next.concat({ role: r as any, content: acc, isStreaming: false, streamId: sid, timestamp: Date.now(), ...tokenPatch } as any);
                }
              }
              return next;
            });
            props.setStreamingVersion(v => v + 1);
          }
          // 更新 token 用量（累加 output_tokens，不替换）
          if (wire.usage) {
            const usage = wire.usage;
            const outputTokens = usage.output_tokens || 0;
            const inputTokens = usage.input_tokens || 0;
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
            profileLog(`[TokenDebug] streamEnd: role=${role} updating contextLength prev=${contextLengthRef.current} inputTokens=${inputTokens} outputTokens=${outputTokens} totalTokens=${totalTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
            if (totalTokens > 0) {
              // 直接使用服务端返回的 input+output，不取 max；压缩后服务端会返回更小的数值，
              // 如果继续 max 会导致压缩后的 context 显示仍然停留在压缩前的旧值。
              props.setContextLength(totalTokens);
              profileLog(`[TokenDebug] streamEnd: setContextLength ${contextLengthRef.current} -> ${totalTokens}`);
              // 同步更新到当前 session 的 state 中，确保切换会话后能正确恢复
              const currentSid = props.currentSessionIdRef.current;
              if (currentSid) {
                // streamEnd 到达时 state 可能尚未初始化（例如子代理会话首次 LLM 回复），
                // 此时需要创建初始 state 并写入 token/cache 数据，否则 Cache 命中率不会显示。
                // 参考 addMessage 处理器中 role===thinking/assistant 分支的初始化逻辑。
                ensureSessionStateWithUsage(
                  props.sessionStates,
                  currentSid,
                  role,
                  totalTokens,
                  inputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                  {
                    promptMode: propsRef.current.settingsDefaults.promptMode,
                    modelRef: propsRef.current.modelRef,
                  },
                );
                profileLog('[TokenDebug] streamEnd: updated/created session state for', currentSid);
              }
            }
          }
          return;
}

export function handleStreamCompressProgress(
  msg: Extract<HostToWebviewWire, { type: 'compressProgress' }>,
  ctx: HandlerContext,
): void {
  const { props } = ctx;
          // Handle compress progress notifications
          const targetSessionId = msg.sessionId || props.currentSessionIdRef.current;
          const isCurrentTarget = !msg.sessionId || msg.sessionId === props.currentSessionIdRef.current;
          let restoredActiveQuery: boolean | undefined;

          // 始终更新目标会话的动画状态，切换会话后可以恢复正确的动画类型
          if (targetSessionId) {
            const targetState = props.sessionStates.get(targetSessionId);
            if (targetState) {
              if (msg.status === 'start') {
                // 记录压缩前是否有活跃查询：自动压缩发生在大查询中时，
                // 压缩结束后仍应保持 hasActiveQuery=true；手动压缩则恢复为 false。
                targetState.preCompressHasActiveQuery = targetState.hasActiveQuery;
                targetState.hasActiveQuery = true;
                targetState.showThinkingAnimation = true;
                targetState.animationMode = 'compacting';
              } else if (msg.status === 'complete' || msg.status === 'error') {
                restoredActiveQuery = targetState.preCompressHasActiveQuery ?? false;
                targetState.hasActiveQuery = restoredActiveQuery;
                targetState.preCompressHasActiveQuery = undefined;
                targetState.showThinkingAnimation = false;
                targetState.animationMode = 'thinking';
              }
            }
          }

          // 非当前会话的压缩进度不更新全局动画，避免串到其他会话
          if (!isCurrentTarget) return;

          if (msg.status === 'start') {
            props.setAnimationMode('compacting');
            props.setShowThinkingAnimation(true);
            props.setHasActiveQuery(true);
          } else if (msg.status === 'complete') {
            props.setShowThinkingAnimation(false);
            props.setAnimationMode('thinking');
            // 恢复压缩前的查询状态（自动压缩仍在查询中时保持 true，手动压缩恢复 false）
            props.setHasActiveQuery(restoredActiveQuery ?? false);
            // 只有压缩成功才写出了归档文件，此时才显示「展开压缩」按钮
            props.setHasCompactArchive(true);
            // 刷新 token 使用量显示为压缩后的值
            if (msg.postCompactTokenCount !== undefined) {
              props.setContextLength(msg.postCompactTokenCount);
            }
          } else if (msg.status === 'error') {
            // 压缩失败（多见于网络问题）：静默——不置 hasCompactArchive，避免出现一个
            // 点了没反应的「展开压缩」按钮。core 侧已记录错误日志，用户或后续循环会重新触发压缩。
            props.setShowThinkingAnimation(false);
            props.setAnimationMode('thinking');
            props.setHasActiveQuery(restoredActiveQuery ?? false);
            console.warn(`[Webview] compact failed for session ${targetSessionId}（详见 core 日志与对话内的系统消息）`);
          }
          return;
}

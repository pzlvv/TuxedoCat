import React, { useEffect, useRef } from 'react';
import type { WebviewMessage, McpServerInfo, ProviderModels } from '../../core/webviewTypes';
import type { MessageData } from '../../core/types';
import { extractUserContent } from '../../core/utils/contentBlocks';
import { getMessageOrigin } from '../../core/utils/messageOrigin';
import { normalizeToolInput } from '../../core/utils/toolInput';
import { modelRefOf, sameModelRef, type ModelRef } from '../../core/llm/modelRef';
import type { DiffHunk } from '../../core/utils/editDiff';
import type { Message, QueuedMessagePayload, UserChoiceRequest, SessionState, AgentMode, PromptMode, ThinkingMode, SettingsDefaults, Theme, LlmConfigPanelPayload } from '../types';
import { postMessage, setViewMode } from '../webviewEnv';
import { createSessionState, ensureSessionStateWithUsage, accumulateUsageToState } from '../sessionState';
import { profileLog } from '../debug';
import { resolveTitle, setUiLanguage, type UiLanguage } from '../i18n';
import { beginThinkingStream, updateStreamChars, endStream, endStreamsForSession, hasStreamStats } from '../streamStatsStore';

// Profiling helper
const profileTag = '[Profile]';

/** 已提示过的未知消息类型：避免宿主重复发送时把控制台刷爆（同类只提示一次） */
const warnedUnknownMessageTypes = new Set<string>();

/**
 * 工具卡片状态优先级：success/fail > running > normal。
 * 用于「恢复的历史卡片」与「实时状态更新」合并时，避免把已经推进的状态降级回去。
 */
const TOOL_STATUS_PRIORITY: Record<string, number> = { success: 3, fail: 3, running: 2, normal: 1 };

/**
 * 解析 conversationLoaded 携带的历史消息为当前 Message 格式（纯函数，不依赖 props）：
 * - toolResultMap：tool_use_id -> tool_result（含时间戳）；
 * - canceledToolResults：被取消的工具 ID -> 提示内容（渲染为失败状态）；
 * - 系统消息压缩边界标记跳过、silent 消息跳过；
 * - 用户消息 _meta/顶层 filePath 双来源兼容、fileHidden 语义保留；
 * - tool_use 消息从 toolMetaMap 回填裁剪掉的 diff/_meta 大字段。
 */
function restoreMessagesFromConversation(msg: Extract<WebviewMessage, { type: 'conversationLoaded' }>): Message[] {
  // 首先扫描所有消息，建立 tool_use_id 到 tool_result 的映射（含时间戳）
  const toolResultMap = new Map<string, { content: string; exitCode: number; timestamp?: number }>();
  // 记录被取消的工具 ID 及其提示内容（未执行被取消的工具需要渲染为失败状态）
  const canceledToolResults = new Map<string, string>();

  // 历史消息结构来自 core 层持久化格式，字段以 any 处理
  const rawMessages = msg.conversation.messages as Array<any>;
  for (const convMsg of rawMessages) {
    if (convMsg.type === 'user' && Array.isArray(convMsg.message?.content)) {
      const toolResults = convMsg.message.content.filter((block: any) => block.type === 'tool_result');
      for (const result of toolResults) {
        // 被取消的工具：记录 tool_use_id -> 提示内容，后续渲染为失败（红色）
        if (result.is_canceled === true) {
          if (result.tool_use_id) {
            canceledToolResults.set(result.tool_use_id, result.content || '');
          }
          continue;
        }
        toolResultMap.set(result.tool_use_id, {
          content: Array.isArray(result.content) ? '[Image]' : (result.content || ''),
          exitCode: result.exit_code ?? 0,
          timestamp: typeof (convMsg as any).timestamp === 'number' ? (convMsg as any).timestamp : undefined,
        });
      }
    }
  }

  // 将历史消息转换为当前格式
  const restoredMessages: Message[] = [];

  for (const convMsg of rawMessages) {
    // 跳过流控制消息
    if (convMsg.type === 'stream_request_start') {
      continue;
    }

    // 消息时间戳：优先使用存储的时间戳，否则使用当前时间
    const msgTimestamp = typeof (convMsg as any).timestamp === 'number' ? (convMsg as any).timestamp : Date.now();

    // 转换系统消息
    if (convMsg.type === 'system') {
      // 跳过压缩边界标记（内部标记，无需展示）
      if ((convMsg as any).subtype === 'compact_boundary') {
        continue;
      }
      const content = convMsg.content || '';
      restoredMessages.push({
        role: 'system' as const,
        content,
        timestamp: msgTimestamp,
      });
      continue;
    }

    // 转换用户消息
    if (convMsg.type === 'user') {
      const content = convMsg.message?.content;
      // 检查是否是工具结果（content 是数组）
      if (Array.isArray(content)) {
        const toolResult = content.find((block: any) => block.type === 'tool_result');
        if (toolResult) {
          // 工具结果已经通过 toolcall 消息的 content 显示，跳过单独的 tool_result 消息
          continue;
        }
      }

      // 从 _meta 与消息顶层读取元信息。部分发送路径（如引擎已存在时的普通消息）
      // 只持久化了顶层 filePath/fileSelectedLines，未写 _meta，因此这里两者都要兼容。
      const msgMeta = (convMsg as any)._meta as Record<string, unknown> | undefined;
      // 消息来源：agent（子代理）/ bash（后台任务通知）/ undefined（用户真实输入）
      const origin = getMessageOrigin(convMsg);
      // 跳过 silent 消息（仅 LLM 可见，UI 不可见）
      if ((convMsg as any).silent === true) {
        continue;
      }

      // 恢复用户消息上的文件标签。
      // 旧逻辑刻意不展示历史文件信息，但用户消息本身携带的上下文仍应可见。
      // 需要保留 fileHidden 语义：发送时用户主动隐藏的消息，加载后仍不显示。
      const rawFilePath = (convMsg as any).filePath || (msgMeta?.filePath as string | undefined) || undefined;
      const rawFileSelectedLines = (convMsg as any).fileSelectedLines
        || (msgMeta?.fileSelectedLines as { start: number; end: number } | undefined)
        || undefined;
      const wasFileHidden = (convMsg as any).fileHidden === true;
      const showFileInfo = !wasFileHidden && !!rawFilePath;

      const msgMetaClean = msgMeta ? { ...msgMeta } : undefined;
      if (msgMetaClean) {
        if (showFileInfo) {
          // 保证 meta 与顶层字段一致，UserMessage 无论读哪个来源都能拿到
          msgMetaClean.filePath = rawFilePath;
          if (rawFileSelectedLines) {
            msgMetaClean.fileSelectedLines = rawFileSelectedLines;
          }
        } else {
          delete msgMetaClean.filePath;
          delete msgMetaClean.fileSelectedLines;
          // 非子代理的 param 只是文件展示文本；子代理 from/to 的 param 用于跳转/来源展示
          if (origin !== 'agent') {
            delete msgMetaClean.param;
          }
        }
      }
      const msgParam = origin === 'agent' ? (msgMeta?.param as string | undefined) : undefined;

      const { text: userText, images: userImages } = extractUserContent(content as string | unknown[]);
      restoredMessages.push({
        role: 'user' as const,
        content: userText,
        images: userImages.length > 0 ? userImages : undefined,
        param: msgParam,
        filePath: showFileInfo ? rawFilePath : undefined,
        fileSelectedLines: showFileInfo ? rawFileSelectedLines : undefined,
        isCompactSummary: (convMsg as any).isCompactSummary === true,
        origin,
        meta: msgMetaClean,
        timestamp: msgTimestamp,
      });
      continue;
    }

    // 转换助手消息
    if (convMsg.type === 'assistant') {
      // 跳过 spin 模式下的 silent 消息
      if ((convMsg as any).silent === true) {
        continue;
      }
      const blocks = convMsg.message?.content || [];

      // 同一 assistant 消息内是否已出现「等待用户确认」的 tool_use。
      // 工具按顺序逐个授权，一个工具在等用户确认时，它后面的 tool_use 都还没轮到，
      // 恢复时不能提前渲染（否则一次会看到多个待确认工具）。等它们真正被授权时，
      // 由实时 addMessage 建卡片。
      let sawPendingToolUse = false;

      // 按照 blocks 的原始顺序处理
      for (const block of blocks) {
        if ((block as any).type === 'thinking') {
          // thinking 消息：转换为 thinking 角色显示
          restoredMessages.push({
            role: 'thinking' as const,
            content: (block as any).thinking || '',
            timestamp: msgTimestamp,
          });
        } else if ((block as any).type === 'text') {
          // 文本消息
          restoredMessages.push({
            role: 'assistant' as const,
            content: (block as any).text,
            timestamp: msgTimestamp,
          });
        } else if ((block as any).type === 'tool_use') {
          // 工具调用
          const toolUse = block as any;
          const toolUseId = toolUse.id;

          // 被取消的工具调用：渲染为失败（红色），而不是跳过
          const canceledContent = canceledToolResults.get(toolUseId);
          if (canceledContent !== undefined) {
            restoredMessages.push({
              role: 'toolcall' as const,
              content: canceledContent,
              param: `⚙️ ${toolUse.name}`,
              toolName: toolUse.name,
              toolArgs: normalizeToolInput(toolUse.input),
              toolCallId: toolUseId,
              status: 'fail',
              timestamp: msgTimestamp,
            });
            continue;
          }

          const result = toolResultMap.get(toolUseId);
          const hasResult = result !== undefined;
          const isPending = (msg.pendingToolUseIds || []).includes(toolUseId);

          // 排在前一个「等待确认」工具之后的 tool_use 还没轮到授权：本次恢复不渲染，
          // 避免同一批的多个工具同时出现在界面上（确认完前一个，后一个被授权时才建卡片）。
          if (sawPendingToolUse && !hasResult) {
            continue;
          }

          // 根据保存的状态判断工具执行结果
          // 没有 result 且在 pendingToolUseIds 中 = 正在等待用户授权，显示 normal
          // 没有 result 但不在 pendingToolUseIds 中 = 正在执行/已中断，显示 running
          let status: 'success' | 'fail' | 'normal' | 'running' = 'running';
          if (hasResult) {
            status = result.exitCode !== 0 ? 'fail' : 'success';
          } else if (isPending) {
            status = 'normal';
          }

          // 从 _meta 中提取 diff 信息，由 EditFile组件在渲染时使用
          // _meta 存储在 tool_use block 顶层（不在 input 内部），由 updateToolUseMeta 写入
          const blockMeta = (toolUse as any)._meta as Record<string, unknown> | undefined;
          const metaTrimmed = (toolUse as any)._metaTrimmed === true;
          // 从 conversationLoaded 附带的 toolMetaMap 中查找裁剪掉的 _meta 大字段
          const preloadedMeta = (msg as any).toolMetaMap?.[toolUseId as string] as
            { beforeContent?: string; afterContent?: string; diffHunks?: DiffHunk[] } | undefined;
          // 归一化入参：历史记录里可能存在被 double-encode 成字符串的 input
          // （例如 AskUserQuestion），直接写属性会抛 TypeError，这里统一解包成对象。
          const toolArgs = normalizeToolInput(toolUse.input);

          // Write 工具：补充 webview 展示所需的 contentPreview / totalLines / isTruncated
          // （这些字段在实时工具调用时由 requestToolPermission 添加，但不会持久化到历史记录中）
          if (toolUse.name === 'Write' && toolArgs.content) {
            const content = String(toolArgs.content);
            if (!toolArgs.contentPreview) {
              (toolArgs as any).contentPreview = content;
            }
            if (!toolArgs.totalLines) {
              (toolArgs as any).totalLines = content.split('\n').length;
            }
            if (toolArgs.isTruncated === undefined) {
              (toolArgs as any).isTruncated = false;
            }
          }

          if (blockMeta || preloadedMeta) {
            if (metaTrimmed) {
              // 优先使用 preloadedMeta（扩展端随 conversationLoaded 一次性发送），
              // 避免每个 EditFile/UpdateWiki 组件单独触发 requestToolMeta
              (toolArgs as any).contextBefore = (blockMeta as any)?.contextBefore || [];
              (toolArgs as any).contextAfter = (blockMeta as any)?.contextAfter || [];
              (toolArgs as any).startLine = (blockMeta as any)?.startLine;
              (toolArgs as any).endLine = (blockMeta as any)?.endLine;

              if (toolUse.name === 'Edit') {
                // Edit 使用紧凑 diff：只包含 diff 相关行
                const diffHunks = preloadedMeta?.diffHunks || (blockMeta as any)?.diffHunks || [];
                (toolArgs as any).diffHunks = diffHunks;

                // 旧数据兜底：还没有紧凑 diff，但 _meta 里是全量 before/after 时，
                // 保留旧字段让 EditFile 自行计算。
                if (diffHunks.length === 0) {
                  const bc = (blockMeta as any)?.beforeContent || '';
                  const ac = (blockMeta as any)?.afterContent || '';
                  if (bc || ac) {
                    (toolArgs as any).beforeContent = bc;
                    (toolArgs as any).afterContent = ac;
                  } else if (!preloadedMeta) {
                    // 仅当 preloadedMeta 和 _meta 中都没有数据时才标记需要按需请求
                    (toolArgs as any)._needsMeta = true;
                    (toolArgs as any)._toolUseId = (toolUse as any)._toolUseId || toolUseId;
                  }
                }
              } else {
                // Write 等工具继续使用 beforeContent/afterContent
                const bc = preloadedMeta?.beforeContent || (blockMeta as any)?.beforeContent || '';
                const ac = preloadedMeta?.afterContent || (blockMeta as any)?.afterContent || '';
                (toolArgs as any).beforeContent = bc;
                (toolArgs as any).afterContent = ac;
                if (!preloadedMeta && !bc && !ac) {
                  (toolArgs as any)._needsMeta = true;
                  (toolArgs as any)._toolUseId = (toolUse as any)._toolUseId || toolUseId;
                }
              }
            } else {
              // 完整 _meta（旧数据，兼容）
              (toolArgs as any).beforeContent = (blockMeta as any)?.beforeContent || '';
              (toolArgs as any).afterContent = (blockMeta as any)?.afterContent || '';
              (toolArgs as any).contextBefore = (blockMeta as any)?.contextBefore || [];
              (toolArgs as any).contextAfter = (blockMeta as any)?.contextAfter || [];
              (toolArgs as any).startLine = (blockMeta as any)?.startLine;
              (toolArgs as any).endLine = (blockMeta as any)?.endLine;
            }
          }

          restoredMessages.push({
            role: 'toolcall' as const,
            content: result?.content || '',
            param: `⚙️ ${toolUse.name}`,
            toolName: toolUse.name,
            toolArgs,
            toolCallId: toolUseId,
            status,
            timestamp: msgTimestamp,
            toolResultTimestamp: result?.timestamp,
          });

          // 这个工具确实在等用户确认（还没出结果）：它之后的 tool_use 都还没轮到授权
          if (isPending && !hasResult) {
            sawPendingToolUse = true;
          }
        }
      }
    }
  }

  return restoredMessages;
}

/**
 * 把跨会话缓冲的 updateToolStatus 回放进刚恢复的消息列表：
 * 只在缓冲状态比当前状态「更新」（success/fail > running > normal）时覆盖；
 * 无论是否覆盖都消费掉缓冲条目（避免后续重复应用）。
 */
function replayBufferedToolStatusIntoMessages(
  restoredMessages: Message[],
  bufferedToolStatusRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
    toolResultTimestamp?: number;
  }>>,
): void {
  if (bufferedToolStatusRef.current.size === 0) return;
  const statusPriority = TOOL_STATUS_PRIORITY;
  for (let i = 0; i < restoredMessages.length; i++) {
    const m = restoredMessages[i];
    if (m.role !== 'toolcall' || !m.toolCallId) continue;
    const buffered = bufferedToolStatusRef.current.get(m.toolCallId);
    if (!buffered) continue;
    const currentPrio = statusPriority[m.status || ''] ?? 0;
    const bufferedPrio = statusPriority[buffered.status] ?? 0;
    if (bufferedPrio > currentPrio) {
      restoredMessages[i] = { ...m, status: buffered.status as any, content: buffered.output || m.content };
    }
    bufferedToolStatusRef.current.delete(m.toolCallId);
  }
}

interface LoadedConversationCommonContext {
  savedCtxPromptMode: PromptMode | undefined;
  savedCtxThinkingMode: ThinkingMode | undefined;
  savedCtxWebSearch: boolean | undefined;
  savedCtxToken: number | undefined;
}

/**
 * conversationLoaded 恢复时两个分支（有/无 savedState）完全相同的 setter 序列：
 * agentMode、promptMode、thinkingMode（savedState 分支多一层回退，见调用点）、
 * webSearch、model（同上）。
 * thinkingMode / model / webSearch 的回退链在两分支间差一层 savedState，
 * 由调用点传入分支语义：无 savedState 分支传回退基线值（与原实现一致）。
 *
 * 回退链的末端是 `undefined`（尚未到达）而不是某个默认值：宿主把 `settings.json` 的
 * 默认值已经解析进消息里，webview 不再自备兜底（`docs/webview-facts.md` 第 3 节）。
 * 返回解析出的 savedContext 关键字段供调用点继续计算 contextLength / 新建 state。
 */
function applyLoadedConversationState(
  msg: Extract<WebviewMessage, { type: 'conversationLoaded' }>,
  props: UseMessageHandlerProps,
  currentProps: UseMessageHandlerProps,
  savedState: SessionState | undefined,
): LoadedConversationCommonContext {
  const savedCtxPromptMode = (msg as any).savedContext?.promptMode as PromptMode | undefined;
  const savedCtxThinkingMode = (msg as any).savedContext?.thinkingMode as ThinkingMode | undefined;
  const savedCtxWebSearch = (msg as any).savedContext?.webSearch as boolean | undefined;
  const savedCtxToken = (msg as any).savedContext?.totalContextTokens as number | undefined;
  const savedCtxProvider = (msg as any).savedContext?.provider as string | undefined;
  // 模型身份：wire 消息是扁平字段（model / provider），这里组装成 ModelRef。
  // 优先消息顶层（宿主已按当前 settings 校验过），其次用 savedContext.provider 与消息 model 组合
  // （旧数据兼容），都没有时由调用点继续回退到会话快照 / settings.json 默认值。
  const msgModelRef = modelRefOf((msg as any).provider ?? savedCtxProvider, (msg as any).model);
  // 询问模式：宿主已解析（会话记录 → settings.json 默认值）；消息未带时保持未到达
  const msgAgentMode = (msg as any).agentMode as AgentMode | undefined;
  if (msgAgentMode) props.setAgentMode(msgAgentMode);
  // 会话级配置（model / thinking / prompt）已随对话加载下发：解除发送按钮禁用
  props.setConfigReady(true);
  // 提示词模式：优先使用 meta.json 中保存的 savedContext.promptMode；未保存时保持未到达
  if (savedCtxPromptMode) props.setPromptMode(savedCtxPromptMode);
  if (savedState) {
    // savedState 分支：thinkingMode 优先 savedContext，回退 savedState，再回退当前对话 effort
    props.setThinkingMode(savedCtxThinkingMode || savedState.thinkingMode || currentProps.thinkingMode);
    // webSearch：优先 savedContext，回退 savedState，再回退新对话默认值（未到达则为 undefined）
    props.setWebSearch(
      typeof savedCtxWebSearch === 'boolean'
        ? savedCtxWebSearch
        : (savedState.webSearch ?? currentProps.settingsDefaults.webSearch)
    );
    // 模型身份整体恢复：消息顶层 → 会话快照 → settings.json 默认值
    props.setModelRef(msgModelRef ?? savedState.modelRef ?? currentProps.settingsDefaults.modelRef);
  } else {
    // 无 savedState：thinkingMode 没有 savedContext 时继承当前对话 effort
    props.setThinkingMode(savedCtxThinkingMode || currentProps.thinkingMode);
    // webSearch：优先 savedContext，回退新对话默认值（未到达则为 undefined）
    props.setWebSearch(
      typeof savedCtxWebSearch === 'boolean'
        ? savedCtxWebSearch
        : currentProps.settingsDefaults.webSearch
    );
    // 模型身份整体恢复：消息顶层 → settings.json 默认值
    props.setModelRef(msgModelRef ?? currentProps.settingsDefaults.modelRef);
  }
  return { savedCtxPromptMode, savedCtxThinkingMode, savedCtxWebSearch, savedCtxToken };
}

/**
 * 设置面板载荷的必填字段校验：返回缺失 / 非法的字段名列表。
 *
 * 载荷由宿主一次给齐（`docs/webview-facts.md` 第 6 节），缺字段即协议错误；
 * 此时不打开面板，避免用空值把用户误导去重配。
 */
function missingPanelFields(payload: LlmConfigPanelPayload): string[] {
  const problems: string[] = [];
  if (payload.thinkingEffort !== 'off' && payload.thinkingEffort !== 'low'
    && payload.thinkingEffort !== 'high' && payload.thinkingEffort !== 'max') {
    problems.push('thinkingEffort');
  }
  if (payload.defaultAgentMode !== 'manual' && payload.defaultAgentMode !== 'risk'
    && payload.defaultAgentMode !== 'auto') {
    problems.push('defaultAgentMode');
  }
  if (payload.defaultPromptMode !== 'normal' && payload.defaultPromptMode !== 'minimal'
    && payload.defaultPromptMode !== 'mixed') {
    problems.push('defaultPromptMode');
  }
  if (payload.language !== 'auto' && payload.language !== 'zh' && payload.language !== 'en') {
    problems.push('language');
  }
  return problems;
}

/** updateToolStatus 缓冲条目的形状（pendingToolStatusRef / bufferedToolStatusRef 共用） */
interface ToolStatusEntry {
  toolCallId: string;
  status: string;
  output?: string;
  startLine?: number;
  endLine?: number;
  toolStartTimestamp?: number;
  toolResultTimestamp?: number;
}

/**
 * 从 updateToolStatus 消息构造缓冲条目：
 * - running：记录开始时间戳（用户确认后工具开始执行）；
 * - success / fail：记录结果返回时间戳。
 */
function toToolStatusEntry(msg: {
  toolCallId: string;
  status?: 'normal' | 'success' | 'running' | 'fail';
  output?: string;
  startLine?: number;
  endLine?: number;
}): ToolStatusEntry {
  return {
    toolCallId: msg.toolCallId,
    status: msg.status || 'running',
    output: msg.output,
    startLine: msg.startLine,
    endLine: msg.endLine,
    toolStartTimestamp: msg.status === 'running' ? Date.now() : undefined,
    toolResultTimestamp: (msg.status === 'success' || msg.status === 'fail') ? Date.now() : undefined,
  };
}

/**
 * 把 wire 上的一条消息（`addMessage` / `messagesReplaced` 的单项）构造成 UI 侧 `Message`。
 * 两条通道共用，避免「增量追加」与「整批替换」的消息形状漂移。
 */
function toUiMessage(msg: MessageData): Message {
  return {
    role: msg.role,
    content: msg.content || '',
    param: msg.param,
    filePath: msg.filePath,
    fileSelectedLines: msg.fileSelectedLines,
    toolName: msg.toolName,
    // 统一归一化为对象：compact 归档展开等路径可能直接透传历史 input，
    // 其中可能存在被 double-encode 成字符串的入参。
    toolArgs: msg.role === 'toolcall' ? normalizeToolInput(msg.toolArgs) : msg.toolArgs,
    status: msg.status,
    toolCallId: msg.toolCallId || (msg.role === 'toolcall' ? `tool-${Date.now()}-${Math.random()}` : undefined),
    isCompactSummary: msg.isCompactSummary,
    hasBorder: msg.hasBorder,
    origin: msg.origin,
    images: msg.images,
    meta: msg.meta as Record<string, unknown> | undefined,
    timestamp: Date.now(),
    cacheReadInputTokens: msg.cacheReadInputTokens,
    cacheCreationInputTokens: msg.cacheCreationInputTokens,
  };
}

export interface UseMessageHandlerProps {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setShowThinkingAnimation: (v: boolean) => void;
  setAnimationMode: (v: 'thinking' | 'compacting') => void;
  setHasActiveQuery: (v: boolean) => void;
  setHasCompactArchive: (v: boolean) => void;
  setIsCompactExpanded: (v: boolean) => void;
  setConversations: React.Dispatch<React.SetStateAction<any[]>>;
  setConversationsLoading: (v: boolean) => void;
  /** 插件模式对话列表当前可见条数（滚动到底时追加一页） */
  setVisibleConversationCount: (v: number | ((prev: number) => number)) => void;
  /** 收到某会话的 conversationLoaded 数据：结束对话自身的 loading */
  finishConversationLoad: (sessionId?: string | null) => void;
  /** 进入无需加载的新对话：清除对话自身的 loading */
  resetConversationLoad: () => void;
  setTheme: (v: Theme) => void;
  setThemeInitialized: (v: boolean) => void;
  setCurrentFile: (v: string) => void;
  setSelectedLines: (v: { start: number; end: number } | null) => void;
  setConversationTitle: (v: string) => void;
  setMaxContextTokens: (v: number | null) => void;
  setSkills: (v: Array<{ name: string; description: string; isBuiltin?: boolean }>) => void;
  /** 呈现一条 core 产出的瞬时提示（键 + 参数，`docs/core-ui-separation.md` 第 4.9 节） */
  pushNotice: (key: string, params: Record<string, string | number>, level: 'info' | 'warn' | 'error') => void;
  /** MCP 服务器列表（含启用状态），由 extension 读取 mcp.json + settings.json 后下发 */
  setMcpServers: (v: McpServerInfo[]) => void;
  setConversationDropdownOpen: (v: boolean) => void;
  setCurrentSessionId: (v: string | null) => void;
  setParentSessionId: (v: string | null) => void;
  setAgentMode: (v: AgentMode) => void;
  setPromptMode: (v: PromptMode | undefined) => void;
  setThinkingMode: (v: ThinkingMode | undefined) => void;
  /** undefined = 尚未从宿主获取到（保持等待态，不写猜测值） */
  setWebSearch: (v: boolean | undefined) => void;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  setModelRef: (v: ModelRef | undefined) => void;
  setContextLength: (v: number | ((prev: number) => number)) => void;
  setQueuedMessage: (v: QueuedMessagePayload | null) => void;
  setUserChoiceRequest: (v: UserChoiceRequest | null) => void;
  setNamingSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
  setStreamingVersion: (v: number | ((prev: number) => number)) => void;
  setForceScrollKey: (v: number | ((prev: number) => number)) => void;
  /** core 推来会话运行时状态时递增，强制对话列表重渲染以刷新流水灯与 abort 按钮 */
  setSessionIdleVersion: (v: number | ((prev: number) => number)) => void;
  setExpandedSubSessions: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  /** 全部 provider 及其模型列表（菜单三级子菜单数据源）；空数组 = 宿主答了「没有配置模型」 */
  setProviderModels: (v: ProviderModels[]) => void;
  setBalance: (v: number | undefined) => void;
  setBalanceCurrency: (v: string | undefined) => void;
  setIsUnlimited: (v: boolean | undefined) => void;
  setCurrentSessionIdRef: (sid: string | null) => void;
  /**
   * LLM 配置面板载荷：宿主随 `showLLMConfig` 一次给齐；`null` 表示关闭面板。
   * 载荷到达即面板打开，webview 不补默认值（`docs/webview-facts.md` 第 6 节）。
   */
  setLlmConfigPayload: (v: LlmConfigPanelPayload | null) => void;
  /** 服务商配置完成状态：未完成时输入框禁用并引导打开设置；null 表示尚未探测到配置 */
  setProviderConfigured: (v: boolean | null) => void;
  /** 会话配置（模型 / 思考强度 / 提示词模式等）是否已从宿主获取到 */
  setConfigReady: (v: boolean) => void;
  /** 当前会话的消息列表（用于判断是否为未发送消息的新对话） */
  messages: Message[];
  /** 界面语言变化时递增，App 通过 key 重挂载内容区刷新所有文案 */
  setLocaleVersion: React.Dispatch<React.SetStateAction<number>>;
  /** settings.json 默认值（model / thinkingMode / agentMode / promptMode） */
  setSettingsDefaults: React.Dispatch<React.SetStateAction<SettingsDefaults>>;
  /** settings.json 默认值（当前值，供新会话初始化使用） */
  settingsDefaults: SettingsDefaults;
  /** 当前会话的实时状态值（切换会话保存快照时使用） */
  userChoiceRequest: UserChoiceRequest | null;
  showThinkingAnimation: boolean;
  animationMode: 'thinking' | 'compacting';
  hasActiveQuery: boolean;
  /** 会话询问模式；undefined = 尚未从宿主获取到 */
  agentMode: AgentMode | undefined;
  promptMode: PromptMode | undefined;
  thinkingMode: ThinkingMode | undefined;
  currentFile: string;
  selectedLines: { start: number; end: number } | null;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  sessionStatesRef: React.MutableRefObject<Map<string, SessionState>>;
  /** core 推送的会话运行时状态（idle / waiting）：对话树流水灯与 abort 按钮的唯一数据源 */
  sessionRuntimeStatesRef: React.MutableRefObject<Map<string, { idle: boolean; waiting: boolean }>>;
  userChoiceRequestRef: React.MutableRefObject<UserChoiceRequest | null>;
  userChoiceInputRef: React.MutableRefObject<string>;
  savedMainInputRef: React.MutableRefObject<string>;
  queuedMessageRef: React.MutableRefObject<Map<string, QueuedMessagePayload>>;
  /** 用户主动 abort 的会话集合，queryEnd 时用于把排队消息回填到输入框 */
  abortedSessionsRef: React.MutableRefObject<Set<string>>;
  /** 按会话缓存的 MCP 列表（含连接中状态），用于区分会话、避免异步回推串台 */
  mcpServersBySessionRef: React.MutableRefObject<Map<string, McpServerInfo[]>>;
  cursorPositionRef: React.MutableRefObject<number | null>;
  choiceCursorPositionRef: React.MutableRefObject<number | null>;
  /** 由"+"或启动时新建、尚未发送过消息的会话 id */
  newChatSessionRef: React.MutableRefObject<string | null>;
  mainInputRef: React.RefObject<HTMLTextAreaElement | null>;
  choiceInputRef: React.RefObject<HTMLTextAreaElement | null>;
  messagesContainerRef: React.RefObject<HTMLDivElement>;
  /** 用户是否已主动滚离底部；为 true 时预滚动逻辑必须立刻停止，避免与用户上滚冲突 */
  userScrolledAwayRef: React.MutableRefObject<boolean>;
  streamRafRef: React.MutableRefObject<number | null>;
  toolStatusRafRef: React.MutableRefObject<number | null>;
  pendingStreamRef: React.MutableRefObject<Map<string, { role: string; accumulated: string; streamId?: string }>>;
  pendingToolStatusRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
    toolResultTimestamp?: number;
  }>>;
  bufferedToolStatusRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    status: string;
    output?: string;
    startLine?: number;
    endLine?: number;
    toolStartTimestamp?: number;
    toolResultTimestamp?: number;
  }>>;
  /** 工具流式输出批量更新：rAF throttle 合并高频 toolProgress 消息 */
  toolProgressRafRef: React.MutableRefObject<number | null>;
  pendingToolProgressRef: React.MutableRefObject<Map<string, {
    toolCallId: string;
    output: string;
    elapsedTimeSeconds?: number;
    totalLines?: number;
    totalBytes?: number;
  }>>;
  conversationLoadingRef: React.MutableRefObject<boolean>;
  isDeletingRef: React.MutableRefObject<boolean>;
  listLoadedOnceRef: React.MutableRefObject<boolean>;
  _appMountTime: React.MutableRefObject<number | null>;
  /** 当前选择的模型身份（provider + model）；undefined = 尚未选择 / 未配置 */
  modelRef: ModelRef | undefined;
  contextLength: number;
  inputAreaRef: React.RefObject<any>;
}

export function useMessageHandler(props: UseMessageHandlerProps): void {
  // 消息监听 effect 只挂载一次（deps 为 []），handleMessage 闭包捕获的是首次渲染的 props。
  // 值类型的 props（settingsDefaults / model / currentFile 等）会随后续渲染更新，
  // 直接读取永远是初始值（会导致会话快照保存错误状态、新建会话用错默认值等）。
  // 统一通过 propsRef 读取最新值；ref 类 props 本身不变，但读取路径保持一致也无副作用。
  const propsRef = useRef(props);
  propsRef.current = props;
  // 使用 ref 追踪 contextLength 的最新值，避免 useEffect 闭包捕获过期值
  const contextLengthRef = useRef(props.contextLength);
  contextLengthRef.current = props.contextLength;
  // 使用 ref 追踪 messages 的最新值，便于在消息事件回调中判断当前会话是否已有消息
  const messagesRef = useRef(props.messages);
  messagesRef.current = props.messages;
  // 每个 session 本轮 query 的起始时间（用于计算首 token 耗时 TTFT）。
  // queryBegin 时写入、queryEnd 时删除。
  const queryStartBySessionRef = useRef<Map<string, number>>(new Map());

  // 每个 session 最近一次「模型产出活动」的时间（流式 delta / streamEnd / 工具完成 / 新消息）。
  // 每个 thinking block 的 "Thinking for Xs" 从这里算起，而不是从 query 起点累计：
  // 思考→工具→思考… 时，后一个 block 只统计「它自己开始前」到首 token 的耗时。
  const lastActivityBySessionRef = useRef<Map<string, number>>(new Map());

  // 已打开会话的消息缓存（仅内存，不持久化）。
  // 切换对话时 webview 会清空消息并从磁盘重新加载，实时字段（streamId 等）会丢失，
  // 导致流式性能统计（Thinking for / chars / tokens）消失。这里按 session 缓存最近一次
  // 的消息对象，重新加载时把 streamId 关联回去，保证同一 webview 内切走再切回不丢数据。
  //
  // 不设上限：所有已打开的对话都保留。
  // 释放时机：Electron 下每个对话是独立 WebContentsView，关闭（或 LRU 淘汰）时整个
  // 渲染进程销毁，缓存随之释放；VS Code 侧没有「关闭对话」操作，故不额外清理。
  const sessionMessagesCacheRef = useRef<Map<string, Message[]>>(new Map());

  // 把当前会话的最新消息写入内存缓存。
  // 注意：切换对话瞬间 setMessages([]) 会先触发一次空数组，此时不能覆盖缓存，
  // 否则切走时就把缓存清掉了（旧会话的消息仍在缓存里，等切回来时用）。
  useEffect(() => {
    const sid = props.currentSessionIdRef.current;
    if (!sid || props.messages.length === 0) return;
    const cache = sessionMessagesCacheRef.current;
    cache.delete(sid);
    cache.set(sid, props.messages);
  }, [props.messages]);

  useEffect(() => {
    /**
     * 在 React 渲染/提交新内容前，先把滚动容器预滚到底部。
     *
     * 背景：Bash/Write/Edit 等工具的 preview（代码、bash 结果、diff）往往在
     * 工具消息之后异步出现。如果只在 MessagesView 的 useLayoutEffect 里滚动，
     * 用户会先看到新内容在下方渲染出来、再被滚动到视野内。这里在 setMessages/
     * setStreamingVersion 之前同步滚动一次，确保“先滚动、后渲染”的顺序。
     *
     * 只有用户本来就靠近底部时才预滚动，避免打断用户主动向上翻阅历史。
     */
    const scrollToBottomBeforeRender = () => {
      const container = props.messagesContainerRef.current;
      if (!container) return;
      // 用户已通过滚轮/触摸/键盘主动滚离底部时，任何渲染前预滚动都必须停止，
      // 否则新节点出现时会把用户刚上滚的位置强行拉回底部。
      if (props.userScrolledAwayRef.current) return;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom <= 50) {
        container.scrollTop = container.scrollHeight;
      }
    };

    /**
     * 把排队消息回填到输入框：与用户当前草稿用 \n 连接（草稿为空时直接使用排队内容）。
     * 目标会话为当前会话时写入实时输入框；否则写入该会话的状态快照，
     * 保证切换回去后仍能看到回填的草稿。
     */
    const restoreQueuedMessageToInput = (targetSessionId: string, queued: QueuedMessagePayload) => {
      const queuedText = queued.content ?? '';
      const queuedImages = queued.images ?? [];
      const joinWithDraft = (draft: string) => (draft ? `${queuedText}\n${draft}` : queuedText);

      const state = props.sessionStatesRef.current.get(targetSessionId);
      if (state) {
        state.queuedMessage = null;
      }

      if (targetSessionId === props.currentSessionIdRef.current) {
        const draft = props.inputAreaRef.current?.getValue() ?? '';
        const draftImages = props.inputAreaRef.current?.getPastedImages?.() ?? [];
        const nextText = joinWithDraft(draft);
        props.inputAreaRef.current?.setValue(nextText);
        if (queuedImages.length > 0) {
          props.inputAreaRef.current?.setPastedImages?.([...queuedImages, ...draftImages]);
        }
        // 光标移到末尾，方便用户继续编辑（若期间已切换会话则跳过，避免抢焦点）
        setTimeout(() => {
          if (props.currentSessionIdRef.current !== targetSessionId) return;
          const el = props.mainInputRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(nextText.length, nextText.length);
          }
        }, 0);
        return;
      }

      if (state) {
        state.input = joinWithDraft(state.input ?? '');
        if (queuedImages.length > 0) {
          state.pastedImages = [...queuedImages, ...(state.pastedImages ?? [])];
        }
      }
    };

    const handleMessage = (event: MessageEvent<WebviewMessage>) => {
      const msg = event.data as WebviewMessage;
      const sessionId = props.currentSessionIdRef.current;
      // 会话级同步消息（setModel / setAgentMode 等）只作用于当前展示的会话
      const hostSessionId = (msg as any).sessionId as string | undefined;
      const fromCurrentSession = !hostSessionId || hostSessionId === sessionId;
      profileLog(`[Webview] handleMessage: type=${msg.type} sessionId=${((msg as any).sessionId || '').substring(0, 20)} currentSessionId=${(sessionId || '').substring(0, 20)}`);

      switch (msg.type) {
        case 'addMessage':
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
            break;
          }

          const newMessage: Message = toUiMessage(msg);

          // 新消息渲染前先把滚动容器预滚到底部，避免 Bash/Write/Edit 等
          // 工具卡片先渲染出来、再被滚动到视野内。
          scrollToBottomBeforeRender();

          // 用户消息直接追加（无本地占位）
          if (msg.role === 'user') {
            props.setMessages((prev) => {
              profileLog(`[Webview] addMessage USER APPEND | msgs.length ${prev.length}->${prev.length + 1} | contentStart=${(msg.content || '').substring(0, 50)}`);
              return [...prev, newMessage];
            });
          } else if (msg.role === 'toolcall' && (msg.toolName || '').toLowerCase().replace(/[-_]/g, '') === 'websearch') {
            // WebSearch 卡片：按时间顺序增量追加到末尾。
            // 之前的"插入到第一条 assistant 文本之前"逻辑在单轮多文本块场景下会失效：
            // Responses API 可在一轮内输出"思考→文字→搜索→思考→文字→搜索…"，
            // 若每次都插到第一条文本前，所有卡片会堆在一起且顺序错乱。
            // 与 thinking/text 流式消息一致，工具卡片也应增量追加，保持 chronological 顺序。
            props.setMessages((prev) => {
              const next = [...prev, newMessage];
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
              const next = [...prev, newMessage];
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
            const inputTokens = (msg as any).contextLength || 0;
            const outputTokens = (msg as any).outputTokens || 0;
            const totalTokens = inputTokens + outputTokens;
            const cacheReadTokens = (msg as any).cacheReadInputTokens || 0;
            const cacheCreationTokens = (msg as any).cacheCreationInputTokens || 0;
            profileLog(`[TokenDebug] addMessage: role=${msg.role} contextLength=${(msg as any).contextLength} outputTokens=${(msg as any).outputTokens} totalTokens=${totalTokens} cacheRead=${cacheReadTokens} cacheCreation=${cacheCreationTokens}`);
            if (totalTokens > 0) {
              // 直接使用服务端返回的 input+output，不取 max；压缩后服务端会返回更小的数值，
              // 如果继续 max 会导致压缩后的 context 显示仍然停留在压缩前的旧值。
              props.setContextLength(totalTokens);
              // 同时保存到当前 session 的 state 中
              if (props.currentSessionIdRef.current) {
                const state = props.sessionStatesRef.current.get(props.currentSessionIdRef.current);
                if (state) {
                  // 只在 assistant 消息上累加缓存（避免 thinking 和 assistant 重复）
                  accumulateUsageToState(state, msg.role, totalTokens, inputTokens, cacheReadTokens, cacheCreationTokens);
                } else {
                  ensureSessionStateWithUsage(
                    props.sessionStatesRef,
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
          break;
        case 'showThinkingAnimation':
          // 存储到当前 session 的状态中
          if (msg.sessionId && props.sessionStatesRef.current.has(msg.sessionId)) {
            const state = props.sessionStatesRef.current.get(msg.sessionId)!;
            state.showThinkingAnimation = msg.show !== false;
            state.animationMode = 'thinking';
          }
          if (msg.sessionId === sessionId) {
            // 更新全局状态
            props.setShowThinkingAnimation(msg.show !== false);
            // 非压缩场景下的 thinking 动画
            props.setAnimationMode('thinking');
          }
          break;
        case 'initSessionState':
          // 预初始化 session 状态（子代理创建时调用，使后续 thinking 动画能正确显示）
          if (msg.sessionId && !props.sessionStatesRef.current.has(msg.sessionId)) {
            props.sessionStatesRef.current.set(msg.sessionId, createSessionState({
              animationMode: 'thinking',
              promptMode: propsRef.current.settingsDefaults.promptMode,
              // wire 消息是扁平的 model / provider，组装成模型身份
              modelRef: modelRefOf((msg as any).provider, (msg as any).model),
            }));
          }
          break;
        case 'setTheme':
          props.setTheme(msg.theme);
          props.setThemeInitialized(true);
          profileLog(`${profileTag} setTheme 收到 | 从挂载到收到=${(performance.now() - props._appMountTime.current!).toFixed(2)}ms`);
          break;
        // 视图模式运行期切换（Electron 悬浮窗：隐藏原生侧栏后列表改由顶栏渲染）。
        // App 订阅了 webviewEnv 的模式变化，这里只需写进 store。
        case 'setConversationListMode':
          // 运行时校验：非法值直接忽略，不能静默当 multi —— 那会把悬浮窗顶栏切成
          // 「无历史列表、无新建、有关闭按钮」的错误形态。
          if (msg.mode === 'single' || msg.mode === 'multi') setViewMode(msg.mode);
          else console.warn('[webview] setConversationListMode: 非法 mode', msg.mode);
          break;
        case 'setCurrentFile':
          props.setCurrentFile(msg.filePath || '');
          props.setSelectedLines(msg.selectedLines || null);
          break;
        // 会话级设置的多端同步：同一会话在其它端被修改时同步本端 UI。
        // 值相同时 React 会跳过更新，不会再次上报，因此不会形成回环。
        case 'setModel': {
          // 多端同步：wire 消息是扁平的 model / provider，这里组装成模型身份。
          // provider 缺失（空串非法）时忽略本次同步，避免只改一半造成漂移。
          const ref = modelRefOf((msg as any).provider, (msg as any).model);
          if (fromCurrentSession && ref) {
            props.setModelRef(ref);
          }
          break;
        }
        case 'setAgentMode':
          if (fromCurrentSession && (msg as any).mode) {
            props.setAgentMode((msg as any).mode);
          }
          break;
        case 'setThinkingMode':
          if (fromCurrentSession && (msg as any).mode) {
            props.setThinkingMode((msg as any).mode);
          }
          break;
        case 'setWebSearch':
          if (fromCurrentSession) {
            props.setWebSearch(!!(msg as any).webSearch);
          }
          break;
        case 'setPromptMode':
          if (fromCurrentSession && (msg as any).mode) {
            props.setPromptMode((msg as any).mode);
          }
          break;
        case 'focusInput': {
          // 全局唤醒快捷键把窗口唤到前台后，聚焦输入框，用户可直接开始输入。
          // 等待一帧：窗口刚显示时 DOM 焦点可能还在同步中，立即 focus 会被覆盖。
          const focus = () => {
            if (propsRef.current.userChoiceRequest) {
              props.choiceInputRef.current?.focus();
            } else {
              props.mainInputRef.current?.focus();
            }
          };
          requestAnimationFrame(() => {
            focus();
            // 兜底再补一次，覆盖窗口从托盘恢复时的焦点竞争
            setTimeout(focus, 50);
          });
          break;
        }
        case 'activatePrewarmedView':
          // 预热视图的启动初始化由 App.tsx 自己的监听处理（需要 onStartup 等组件级能力），
          // 这里只做登记，避免落到 default 分支打「未知消息类型」告警。
          break;
        case 'setTitle':
          if (msg.sessionId === props.currentSessionIdRef.current) {
            props.setConversationTitle(resolveTitle(msg.title));
          }
          break;
        case 'contextLimitUpdated':
          profileLog(`[TokenDebug] contextLimitUpdated: maxContextTokens=${msg.maxContextTokens}`);
          if (msg.maxContextTokens) {
            props.setMaxContextTokens(msg.maxContextTokens);
          } else {
            console.warn(`[TokenDebug] contextLimitUpdated: maxContextTokens is falsy, not setting`);
          }
          break;
        case 'setSkills':
          props.setSkills(msg.skills);
          break;
        case 'notice':
          props.pushNotice(msg.key, msg.params, msg.level);
          break;
        case 'setMcpServers': {
          // MCP 状态按会话区分：异步回推可能晚于会话切换，
          // 因此先写入该会话的缓存，只有属于当前会话时才更新可见状态。
          const targetSessionId = (msg as any).sessionId as string | undefined;
          if (targetSessionId) {
            props.mcpServersBySessionRef.current.set(targetSessionId, msg.servers);
            if (targetSessionId !== props.currentSessionIdRef.current) break;
          }
          props.setMcpServers(msg.servers);
          break;
        }
        case 'aiBegin':
        case 'aiEnd':
          // 扩展端用于同步 thinking 动画的辅助消息；webview 侧的动画已由
          // queryBegin/queryEnd 与 showThinkingAnimation 驱动，这里显式忽略，
          // 避免每轮 LLM 调用都刷 "Unknown message type" 警告。
          break;
        case 'queryBegin':
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
            const targetState = props.sessionStatesRef.current.get(msg.sessionId);
            if (targetState) {
              targetState.hasActiveQuery = true;
              // 同步动画状态到会话快照，确保之后切换回该会话时能立即恢复 thinking 动画
              targetState.showThinkingAnimation = true;
              targetState.animationMode = 'thinking';
            } else {
              // 会话状态不存在（例如从历史记录加载后首次发消息的对话）时创建，
              // 否则 queryBegin 无法标记 hasActiveQuery，对话列表的流水灯不会显示。
              props.sessionStatesRef.current.set(msg.sessionId, createSessionState({
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
            break;
          }
          props.setHasActiveQuery(true);
          // 查询开始即显示 thinking 动画；即使扩展端先发的 showThinkingAnimation
          // 因时序问题未更新到 UI，这里也保证动画能立刻出现。
          props.setShowThinkingAnimation(true);
          props.setAnimationMode('thinking');
          break;
        case 'queryEnd': {
          // 即使被当前 session 过滤，也更新目标 session 的状态
          const endedSessionId = msg.sessionId;
          if (endedSessionId) {
            // 查询结束（含 abort）：冻结该会话所有仍在流式的统计，保留 abort 前最后一次的值
            endStreamsForSession(endedSessionId);
            // 清理该会话本轮 query 起始时间（无论是否当前会话）
            queryStartBySessionRef.current.delete(endedSessionId);
            lastActivityBySessionRef.current.delete(endedSessionId);
            const targetState = props.sessionStatesRef.current.get(endedSessionId);
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
            break;
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
          break;
        }
        case 'updateToolArgs':
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            break;
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
          break;
        case 'requestUserChoice':
          // 存储到当前 session 的状态中
          if (props.sessionStatesRef.current.has(msg.sessionId)) {
            const state = props.sessionStatesRef.current.get(msg.sessionId)!;
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
          break;
        case 'updateToolStatus':
          // 记录活动时间：工具完成后的下一个 thinking block 从这里算起
          if (msg.sessionId && (msg.status === 'success' || msg.status === 'fail')) {
            lastActivityBySessionRef.current.set(msg.sessionId, Date.now());
          }
          // 过滤：只有当前 session 的消息才处理
          if (msg.sessionId !== sessionId) {
            // 不是当前会话的更新：存入跨会话缓冲区，供 conversationLoaded 时回放
            props.bufferedToolStatusRef.current.set(msg.toolCallId, toToolStatusEntry(msg));
            break;
          }
          // 🔴 conversationLoading 期间，所有 updateToolStatus（即使是当前会话的消息）
          // 也进入缓冲，由 conversationLoaded 的 rAF 回调统一回放。
          // 避免正常 rAF 路径（pendingToolStatusRef）与 props.setMessages(restoredMessages)
          // 之间的时序竞态导致状态丢失。
          if (props.conversationLoadingRef.current) {
            props.bufferedToolStatusRef.current.set(msg.toolCallId, toToolStatusEntry(msg));
            break;
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
          break;
        case 'toolProgress':
          // Bash 流式输出：过滤非当前 session 的消息
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
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
          break;
        case 'sessionRuntimeStates': {
          // core 的会话运行时状态（idle / waiting）全量推送：
          // 这是对话树流水灯与 abort 按钮的唯一数据源（不再从 queryBegin / queryEnd 推导）。
          const runtime = new Map<string, { idle: boolean; waiting: boolean }>();
          for (const s of msg.states || []) {
            if (s?.sessionId) runtime.set(s.sessionId, { idle: s.idle !== false, waiting: !!s.waiting });
          }
          props.sessionRuntimeStatesRef.current = runtime;
          // 强制对话列表重渲染，使流水灯即时出现 / 消失 / 变黄
          props.setSessionIdleVersion(v => v + 1);
          break;
        }
        case 'conversationsData': {
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
            // 自动展开当前对话的祖先链，确保选中子对话时父对话可见
            props.setExpandedSubSessions(prev => {
              const next = { ...prev };
              // 建立 sessionId -> conversation 索引，避免祖先链循环内反复 find()
              const convById = new Map(convs.map((c: any) => [c.sessionId, c]));
              let id: string | null = sid;
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
          break;
        }
        case 'conversationLoaded': {
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
            props.setHasCompactArchive((msg as any).hasCompactArchive === true);
            props.setIsCompactExpanded(false);
            // 记录父会话 ID（子对话时有值）
            props.setParentSessionId((msg as any).parentSessionId || null);
            // 恢复该会话的 UI 状态（input, userChoiceRequest, userChoiceInput, showThinkingAnimation）
            const savedState = props.sessionStatesRef.current.get(loadedSessionId);
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
              const activityPhase = (msg as any).activityPhase as string | undefined;
              const isCompacting = savedState.animationMode === 'compacting' && savedState.showThinkingAnimation === true;
              // 除了扩展端上报的 hasActiveQuery/activityPhase，本地 savedState 中记录的
              // showThinkingAnimation 也是可靠来源（后台查询/子代理场景可能未同步 hasActiveQuery）。
              // 只要不是 tool/text 阶段，恢复会话后应立刻显示 thinking 动画。
              const savedAnimating = savedState.showThinkingAnimation === true;
              const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
              const runtimeActive = savedAnimating || (msg as any).hasActiveQuery === true || phaseActive;
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
              const activityPhase = (msg as any).activityPhase as string | undefined;
              const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
              const runtimeActive = (msg as any).hasActiveQuery === true || phaseActive;
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
              // 确保 sessionStatesRef 中有该会话的状态。首次从历史加载的对话此前没有
              // 状态条目，若不在此时创建，后续 queryBegin 会因找不到 targetState 而无法
              // 标记 hasActiveQuery，导致对话列表的流水灯不显示。
              if (!props.sessionStatesRef.current.has(loadedSessionId)) {
                props.sessionStatesRef.current.set(loadedSessionId, createSessionState({
                  showThinkingAnimation: runtimeActive
                    && activityPhase !== 'tool'
                    && activityPhase !== 'text',
                  animationMode: 'thinking',
                  hasActiveQuery: runtimeActive,
                  // 询问模式 / 提示词模式：宿主未下发时保持未到达（不写猜测值）
                  agentMode: (msg as any).agentMode as AgentMode | undefined,
                  promptMode: common.savedCtxPromptMode,
                  thinkingMode: common.savedCtxThinkingMode || propsRef.current.thinkingMode,
                  webSearch: typeof common.savedCtxWebSearch === 'boolean' ? common.savedCtxWebSearch : propsRef.current.settingsDefaults.webSearch,
                  contextLength: restoredVal,
                  // 模型身份：消息顶层（扁平字段组装）→ settings.json 默认值
                  modelRef: modelRefOf((msg as any).provider ?? (msg as any).savedContext?.provider, (msg as any).model)
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
                const activityPhase = (msg as any).activityPhase as string | undefined;
                const hasRunningTool = restoredMessages.some(m =>
                  m.role === 'toolcall' && m.status === 'running'
                );
                const hasStreamingAssistant = restoredMessages.some(m =>
                  m.role === 'assistant' && m.isStreaming === true
                );
                const loadedState = props.sessionStatesRef.current.get(_convLoadedSessionId || '');
                // 压缩任务不经过 QueryEngine，hasActiveQuery 可能为 false；
                // 因此压缩中要直接沿用 savedState 的 compacting 状态，而不是被 hasActiveQuery 关掉。
                const isCompacting = loadedState?.animationMode === 'compacting' && loadedState?.showThinkingAnimation === true;
                // 同样地，后台/子代理等场景可能让扩展端 hasActiveQuery 为 false，
                // 但本地 savedState.showThinkingAnimation / activityPhase 仍记录了“该会话正在运行”。
                const savedAnimating = loadedState?.showThinkingAnimation === true;
                const phaseActive = activityPhase === 'thinking' || activityPhase === 'text' || activityPhase === 'tool';
                const runtimeActive = savedAnimating || (msg as any).hasActiveQuery === true || phaseActive;
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
          break;
        }
        case 'messagesReplaced':
          // 整批替换本地消息列表（core 的压缩后重建 / 宿主的展开归档共用这一条）。
          // 与 addMessage 的差别：这里不追加、不处理排队消息与 token 累加，
          // 只把整批历史消息铺成当前列表。
          if (msg.sessionId && msg.sessionId !== sessionId) {
            break;
          }
          scrollToBottomBeforeRender();
          props.setMessages(msg.messages.map(toUiMessage));
          props.setContextLength(0);
          break;
        case 'compressProgress': {
          // Handle compress progress notifications
          const targetSessionId = msg.sessionId || props.currentSessionIdRef.current;
          const isCurrentTarget = !msg.sessionId || msg.sessionId === props.currentSessionIdRef.current;
          let restoredActiveQuery: boolean | undefined;

          // 始终更新目标会话的动画状态，切换会话后可以恢复正确的动画类型
          if (targetSessionId) {
            const targetState = props.sessionStatesRef.current.get(targetSessionId);
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
          if (!isCurrentTarget) break;

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
          break;
        }
        case 'queuedMessage':
          // 按会话存储排队消息（绑定 sessionId），切换会话后仍能正确归属
          if (msg.sessionId) {
            const payload: QueuedMessagePayload = {
              sessionId: msg.sessionId,
              uuid: (msg as any).uuid,
              content: msg.content,
              images: msg.images,
              filePath: (msg as any).filePath,
              selectedLines: (msg as any).selectedLines || (msg as any).fileSelectedLines,
              fileHidden: (msg as any).fileHidden,
            };
            props.queuedMessageRef.current.set(msg.sessionId, payload);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(payload);
              // 排队消息出现时触发自动滚动，让用户看到排队提示
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
          break;
        case 'clearQueuedMessage':
          // 仅清除指定会话的排队消息，不影响其他会话的排队项
          if (msg.sessionId) {
            props.queuedMessageRef.current.delete(msg.sessionId);
            if (msg.sessionId === sessionId) {
              props.setQueuedMessage(null);
              // 排队消息清除时触发自动滚动
              props.setForceScrollKey((prev) => prev + 1);
            }
          }
          break;
        case 'smartNamingResult':
          profileLog('[App] smartNamingResult received', msg);
          // 更新命名中状态
          {
            const namingSessionId = (msg as any).sessionId;
            const newTitle = (msg as any).title;
            props.setNamingSessions(prev => {
              const next = new Set(prev);
              next.delete(namingSessionId);
              return next;
            });
            // 如果重命名的是当前对话，同步更新顶部标题显示
            if (namingSessionId === props.currentSessionIdRef.current) {
              props.setConversationTitle(resolveTitle(newTitle));
            }
            // 同步更新对话列表中的标题（即时刷新，无需等待后端返回）
            props.setConversations(prev => prev.map(c =>
              c.sessionId === namingSessionId ? { ...c, title: newTitle } : c
            ));
          }
          break;
        case 'streamMessage': {
          // streamId 由 RealApi.ts 保证每次 LLM 调用生成唯一 ID，不会为 undefined
          const streamId = (msg as any).streamId!;
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
            break;
          }
          // thinking 流式消息到达时确保 thinking 动画处于显示状态。
          // 覆盖“切换会话后恢复失败”或 showThinkingAnimation 消息丢失的时序问题。
          if (role === 'thinking') {
            props.setShowThinkingAnimation(true);
            props.setAnimationMode('thinking');
            if (sessionId) {
              const currentState = props.sessionStatesRef.current.get(sessionId);
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
          break;
        }
        case 'streamEnd': {
          // 更新 token 用量：即使 sessionId 不匹配也要累加到对应 session 的 state 中，
          // 否则子代理（Agent Tool）在后台运行时，其 cache token 数据会丢失，
          // 导致切换到子代理后 Cache 命中率不显示。
          const streamEndSessionId = msg.sessionId || sessionId;
          // 全局流式统计：所有会话都结束（非当前会话切换走后也要收敛）
          const streamEndStreamId = (msg as any).streamId;
          if (streamEndStreamId) {
            endStream(streamEndStreamId, {
              outputTokens: (msg as any).usage?.output_tokens,
              reasoningTokens: (msg as any).usage?.reasoning_tokens,
            });
          }
          // 记录活动时间：下一个 thinking block 从这次结束算起
          if (streamEndSessionId) {
            lastActivityBySessionRef.current.set(streamEndSessionId, Date.now());
          }
          if (streamEndSessionId !== sessionId) {
            profileLog(`[TokenDebug] streamEnd: session mismatch, updating session state for ${(streamEndSessionId || '').substring(0,20)} (current=${(sessionId || '').substring(0,20)})`);
            // 仍然更新非当前 session 的 cache token 数据到 sessionStatesRef
            if (streamEndSessionId && (msg as any).usage) {
              const usage = (msg as any).usage;
              const cacheReadTokens = usage.cache_read_input_tokens || 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
              const inputTokens = usage.input_tokens || 0;
              const outputTokens = usage.output_tokens || 0;
              const totalTokens = inputTokens + outputTokens;
              const role = msg.role;
              if (totalTokens > 0) {
                ensureSessionStateWithUsage(
                  props.sessionStatesRef,
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
            break;
          }
          const streamId = (msg as any).streamId!;
          const accumulated = msg.accumulated;
          const role = msg.role;
          const mapKey = streamId + ':' + role;
          profileLog(`[TokenDebug] streamEnd: role=${role} streamId=${streamId} hasUsage=${!!(msg as any).usage} usage=${JSON.stringify((msg as any).usage)}`);
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
            const usageOutputTokens = (msg as any).usage?.output_tokens;
            const usageReasoningTokens = (msg as any).usage?.reasoning_tokens;
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
          if ((msg as any).usage) {
            const usage = (msg as any).usage;
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
                  props.sessionStatesRef,
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
          break;
        }
        case 'expandCompactDone':
          // 展开完成，隐藏展开按钮
          props.setHasCompactArchive(false);
          props.setIsCompactExpanded(true);
          break;
        case 'setModels':
          // 全量 provider 分组列表（三级子菜单数据源）；模型名与 provider 分开，不拼接
          if (Array.isArray((msg as any).providers)) {
            props.setProviderModels((msg as any).providers);
          }
          break;
        case 'providerModelsResult':
          // 由 LLMConfigPanel 内部监听处理，这里只需要避免 Unknown message 日志
          break;
        case 'settingsDefaults':
          // 从扩展端接收 settings.json 中的默认值（model / thinkingMode / agentMode / promptMode），
          // 供新对话创建时一次性使用，避免先显示 manual 再跳变
          {
            const defaults = msg as { model?: string; provider?: string; thinkingMode?: 'off' | 'low' | 'high' | 'max'; agentMode?: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch?: boolean; language?: UiLanguage; providerConfigured?: boolean };
            // wire 消息是扁平的 model / provider，这里组装成模型身份（provider 为空 → undefined = 未配置）
            const defaultsModelRef = modelRefOf(defaults.provider, defaults.model);
            profileLog(`[Webview] settingsDefaults received: model=${defaults.model}, provider=${defaults.provider}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, language=${defaults.language}, providerConfigured=${defaults.providerConfigured}`);
            props.setSettingsDefaults({
              modelRef: defaultsModelRef,
              thinkingMode: defaults.thinkingMode,
              agentMode: defaults.agentMode,
              // 不做 'normal' 兜底：未配置时保持 undefined，由调用方决定
              promptMode: defaults.promptMode,
              webSearch: defaults.webSearch,
            });
            // 会话配置已从宿主获取到：解除发送按钮禁用（复用 MCP 连接中的效果）
            props.setConfigReady(true);
            if (typeof defaults.providerConfigured === 'boolean') {
              props.setProviderConfigured(defaults.providerConfigured);
            }
            // onStartup（500ms 延迟）可能早于本消息执行，导致当前会话的
            // model / thinkingMode / promptMode 仍为空。此时若当前会话是尚未发送
            // 消息的新对话，则用 settings.json 默认值补齐，避免停留在空配置。
            if (messagesRef.current.length === 0) {
              const sid = props.currentSessionIdRef.current;
              const st = sid ? props.sessionStatesRef.current.get(sid) : undefined;
              // 模型身份整体补齐（仅在尚未设置时）：provider + model 一起，避免只补一半造成漂移
              if (!propsRef.current.modelRef && defaultsModelRef) {
                props.setModelRef(defaultsModelRef);
                if (st) st.modelRef = defaultsModelRef;
              }
              if (!propsRef.current.thinkingMode && defaults.thinkingMode) {
                props.setThinkingMode(defaults.thinkingMode);
                if (st) st.thinkingMode = defaults.thinkingMode;
              }
              if (!propsRef.current.promptMode && defaults.promptMode) {
                props.setPromptMode(defaults.promptMode);
                if (st) st.promptMode = defaults.promptMode;
              }
              if (typeof defaults.webSearch === 'boolean') {
                props.setWebSearch(defaults.webSearch);
                if (st) st.webSearch = defaults.webSearch;
              }
            }
            // 注意：settingsDefaults 只代表“新对话默认值”，不代表当前会话已有的 agentMode，
            // 因此这里不直接切换 agentMode/退出 loading；等 conversationLoaded 或
            // setNewConversationDefaults 下发会话级具体值后再显示菜单。
            // 应用界面语言（与 HTML 注入的 __uiLocale 一致，仅在极少数不一致时触发重渲染）
            if (defaults.language === 'zh' || defaults.language === 'en' || defaults.language === 'auto') {
              const changed = setUiLanguage(defaults.language);
              if (changed) {
                props.setLocaleVersion((v) => v + 1);
              }
            }
          }
          break;
        case 'llmConfigSaved':
          // LLM 配置保存成功：更新本地默认值。
          // 如果当前对话是未发送消息的新对话，则模型/提示词模式等默认值也立刻生效；
          // 工作模式/思考强度/联网搜索保持原有“保存后应用到当前对话”的行为。
          {
            const saved = msg as { defaultModel?: string; defaultModelProvider?: string; activeModel?: string; activeModelProvider?: string; thinkingEffort?: 'off' | 'low' | 'high' | 'max'; defaultAgentMode?: 'manual' | 'risk' | 'auto'; defaultPromptMode?: PromptMode; webSearch?: boolean };
            // 保存成功即说明至少有一个可用的服务商
            props.setProviderConfigured(true);
            // 配置已可用：解除发送按钮禁用
            props.setConfigReady(true);
            if (saved.defaultModel || saved.thinkingEffort || saved.defaultAgentMode || saved.defaultPromptMode || typeof saved.webSearch === 'boolean') {
              // wire 消息是扁平的 defaultModel / defaultModelProvider，组装成模型身份整体更新
              const nextDefaultModelRef = modelRefOf(saved.defaultModelProvider, saved.defaultModel) ?? propsRef.current.settingsDefaults.modelRef;
              props.setSettingsDefaults(prev => ({
                modelRef: nextDefaultModelRef,
                thinkingMode: saved.thinkingEffort || prev.thinkingMode,
                agentMode: saved.defaultAgentMode || prev.agentMode,
                promptMode: saved.defaultPromptMode || prev.promptMode,
                webSearch: typeof saved.webSearch === 'boolean' ? saved.webSearch : prev.webSearch,
              }));
            }
            // 默认工作模式 / 思考强度 / 联网搜索保持原有行为：保存后应用到当前对话
            if (saved.defaultAgentMode) {
              props.setAgentMode(saved.defaultAgentMode);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.agentMode = saved.defaultAgentMode;
                }
              }
            }
            if (saved.thinkingEffort) {
              props.setThinkingMode(saved.thinkingEffort);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.thinkingMode = saved.thinkingEffort;
                }
              }
            }
            if (typeof saved.webSearch === 'boolean') {
              props.setWebSearch(saved.webSearch);
              const curSid = props.currentSessionIdRef.current;
              if (curSid) {
                const state = props.sessionStatesRef.current.get(curSid);
                if (state) {
                  state.webSearch = saved.webSearch;
                }
              }
            }
            // 切换 provider 后，扩展端会返回当前对话应使用的模型 activeModel
            // （已校验是否属于新 provider 的模型列表，不在列表中则回退到 provider 默认模型）。
            // 该值对已有消息的对话同样生效，避免当前对话保留新 provider 不支持的模型。
            const curSid = props.currentSessionIdRef.current;
            const state = curSid ? props.sessionStatesRef.current.get(curSid) : undefined;
            // wire 消息是扁平字段（activeModel/activeModelProvider 等），组装成模型身份整体更新
            const activeModelRef = modelRefOf(saved.activeModelProvider, saved.activeModel);
            if (activeModelRef) {
              props.setModelRef(activeModelRef);
              if (state) state.modelRef = activeModelRef;
            }
            // 当前对话是未发送消息的新对话时，模型与提示词模式也立即使用新默认值
            if (messagesRef.current.length === 0) {
              const defaultModelRef = modelRefOf(saved.defaultModelProvider, saved.defaultModel);
              if (!activeModelRef && defaultModelRef) {
                props.setModelRef(defaultModelRef);
                if (state) state.modelRef = defaultModelRef;
              }
              if (saved.defaultPromptMode) {
                props.setPromptMode(saved.defaultPromptMode);
                if (state) state.promptMode = saved.defaultPromptMode;
              }
            }
            // 应用界面语言：变更时递增 localeVersion 重挂载内容区，所有文案立即按新语言渲染
            const savedLanguage = (saved as { language?: UiLanguage }).language;
            if (savedLanguage === 'zh' || savedLanguage === 'en' || savedLanguage === 'auto') {
              const changed = setUiLanguage(savedLanguage);
              if (changed) {
                props.setLocaleVersion((v) => v + 1);
              }
            }
          }
          break;
        case 'setNewConversationDefaults':
          // 从扩展端接收新对话的默认 model、thinkingMode、agentMode、promptMode 和 webSearch（来自 settings.json）
          {
            const defaults = msg as { sessionId: string; model: string; provider?: string; thinkingMode: 'off' | 'low' | 'high' | 'max'; agentMode?: 'manual' | 'risk' | 'auto'; promptMode?: PromptMode; webSearch?: boolean };
            profileLog(`[Webview] setNewConversationDefaults received: model=${defaults.model}, provider=${defaults.provider}, thinkingMode=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, promptMode=${defaults.promptMode}, webSearch=${defaults.webSearch}, currentSessionId=${props.currentSessionIdRef.current}`);
            // 会话级默认值已下发：解除发送按钮禁用
            props.setConfigReady(true);
            // 如果用户已经手动切换过模型，不要再用 settings.json 的默认模型覆盖用户选择。
            // settingsDefaults 尚未获取到（undefined）时不视为用户修改，正常应用默认模型。
            // wire 消息是扁平的 model / provider，组装成模型身份整体应用。
            const defaultsModelRef = modelRefOf(defaults.provider, defaults.model);
            const sdModelRef = propsRef.current.settingsDefaults.modelRef;
            const modelChangedByUser = sdModelRef !== undefined && !sameModelRef(sdModelRef, propsRef.current.modelRef);
            if (!modelChangedByUser) {
              props.setModelRef(defaultsModelRef);
            }
            props.setThinkingMode(defaults.thinkingMode);
            if (defaults.agentMode) {
              props.setAgentMode(defaults.agentMode);
            }
            if (defaults.promptMode === 'normal' || defaults.promptMode === 'minimal' || defaults.promptMode === 'mixed') {
              props.setPromptMode(defaults.promptMode);
            }
            if (typeof defaults.webSearch === 'boolean') {
              props.setWebSearch(defaults.webSearch);
            }
            // 同步更新 session state
            const curSid = props.currentSessionIdRef.current;
            if (curSid) {
              const state = props.sessionStatesRef.current.get(curSid);
              if (state) {
                if (!modelChangedByUser) {
                  state.modelRef = defaultsModelRef;
                }
                state.thinkingMode = defaults.thinkingMode;
                if (defaults.agentMode) {
                  state.agentMode = defaults.agentMode;
                }
                if (defaults.promptMode === 'normal' || defaults.promptMode === 'minimal' || defaults.promptMode === 'mixed') {
                  state.promptMode = defaults.promptMode;
                }
                if (typeof defaults.webSearch === 'boolean') {
                  state.webSearch = defaults.webSearch;
                }
              }
            }
            // 回传诊断日志到扩展端，确认 webview 已应用默认值
            postMessage({ type: 'debugLog', message: `[webview] setNewConversationDefaults APPLIED: model=${defaults.model}, thinking=${defaults.thinkingMode}, agentMode=${defaults.agentMode}, webSearch=${defaults.webSearch}` });
          }
          break;
        case 'toolMetaData':
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
          break;
        case 'balanceUpdate':
          // 更新全局余额信息（与会话无关）；获取失败时消息字段为 null，此时清空余额隐藏显示
          {
            const totalBalance = (msg as any).totalBalance;
            const currency = (msg as any).currency;
            const unlimited = (msg as any).isUnlimited;
            props.setBalance(typeof totalBalance === 'number' ? totalBalance : undefined);
            props.setBalanceCurrency(typeof currency === 'string' ? currency : undefined);
            props.setIsUnlimited(typeof unlimited === 'boolean' ? unlimited : undefined);
          }
          break;
        case 'showLLMConfig': {
          // 显示 LLM 配置面板（启动时 apiKey 为空或用户点击设置时触发）。
          // 面板载荷由宿主一次给齐，webview 不补默认值（`docs/webview-facts.md` 第 6 节）；
          // 载荷字段缺失即协议错误，这里逐字段校验后组装，缺字段时不打开面板。
          const raw = msg as Record<string, any>;
          const rawProviders = raw.providers;
          const payload: LlmConfigPanelPayload = {
            baseURL: String(raw.baseURL ?? ''),
            webSearch: !!raw.webSearch,
            thinkingEffort: raw.thinkingEffort,
            defaultAgentMode: raw.defaultAgentMode,
            defaultPromptMode: raw.defaultPromptMode,
            apiKey: String(raw.apiKey ?? ''),
            language: raw.language,
            activeProvider: String(raw.activeProvider ?? ''),
            providers: Array.isArray(rawProviders)
              ? rawProviders.map((p: any) => ({
                  key: String(p?.key || ''),
                  baseURL: String(p?.baseURL || ''),
                  apiKey: String(p?.apiKey || ''),
                  models: Array.isArray(p?.models)
                    ? (p.models as unknown[])
                        .filter((m): m is string => typeof m === 'string' && !!m.trim())
                        .map((m) => m.trim())
                    : [],
                  defaultModel: String(p?.defaultModel || ''),
                  // apiType 已下放到模型级：随 modelConfigs 一起回传
                  modelConfigs: (p?.modelConfigs && typeof p.modelConfigs === 'object' && !Array.isArray(p.modelConfigs))
                    ? p.modelConfigs
                    : {},
                }))
              : [],
            mcpServers: Array.isArray(raw.mcpServers)
              ? raw.mcpServers.map((s: any) => ({
                  name: String(s?.name || ''),
                  type: String(s?.type || 'local'),
                  command: Array.isArray(s?.command) ? (s.command as unknown[]).filter((c): c is string => typeof c === 'string') : [],
                  environment: (s?.environment && typeof s.environment === 'object' && !Array.isArray(s.environment)) ? s.environment as Record<string, string> : {},
                  url: typeof s?.url === 'string' ? s.url : '',
                  headers: (s?.headers && typeof s.headers === 'object' && !Array.isArray(s.headers)) ? s.headers as Record<string, string> : {},
                  enabled: !!s?.enabled,
                })).filter((s) => !!s.name)
              : [],
          };
          const problems = missingPanelFields(payload);
          if (problems.length > 0) {
            // 载荷不完整：不打开面板（避免用空值把用户误导去重配），记一条日志
            console.warn(`[Webview] showLLMConfig 载荷字段缺失：${problems.join(', ')}`);
            break;
          }
          props.setProviderConfigured(!!payload.activeProvider && !!payload.apiKey);
          props.setLlmConfigPayload(payload);
          break;
        }
        default:
          // 未知消息类型只提示一次：宿主可能在每轮/每次流式事件里都发同一条消息，
          // 逐条 console.warn 会瞬间刷满控制台，掩盖真正有价值的日志。
          if (!warnedUnknownMessageTypes.has(msg.type)) {
            warnedUnknownMessageTypes.add(msg.type);
            console.warn(`[Webview] Unknown message type: ${msg.type}（同类消息仅提示一次）`);
          }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);
}

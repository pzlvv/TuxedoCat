/**
 * webview 消息 handler 的共享纯函数（域 handler 与主 hook 共用）。
 *
 * 从 useMessageHandler.ts 原样搬移：会话恢复解析（restoreMessagesFromConversation）、
 * 工具状态回放（replayBufferedToolStatusIntoMessages）、加载状态应用
 * （applyLoadedConversationState）、配置面板字段校验（missingPanelFields）、
 * 工具状态条目与 UI 消息映射（toToolStatusEntry / toUiMessage）。
 */
import { modelRefOf } from '../../../shared/llm/modelRef';
import { MessageData } from '../../../shared/types';
import { extractUserContent } from '../../../shared/utils/contentBlocks';
import { DiffHunk } from '../../../shared/utils/editDiff';
import { getMessageOrigin } from '../../../shared/utils/messageOrigin';
import { normalizeToolInput } from '../../../shared/utils/toolInput';
import { HostToWebviewMessage } from '../../../host/webviewMessages';
import { AgentMode, LlmConfigPanelPayload, Message, PromptMode, SessionState, ThinkingMode } from '../../types';
import { UseMessageHandlerProps } from '../useMessageHandler';

/**
 * 工具卡片状态优先级：success/fail > running > normal。
 * 用于「恢复的历史卡片」与「实时状态更新」合并时，避免把已经推进的状态降级回去。
 */
export const TOOL_STATUS_PRIORITY: Record<string, number> = { success: 3, fail: 3, running: 2, normal: 1 };

/**
 * 解析 conversationLoaded 携带的历史消息为当前 Message 格式（纯函数，不依赖 props）：
 * - toolResultMap：tool_use_id -> tool_result（含时间戳）；
 * - canceledToolResults：被取消的工具 ID -> 提示内容（渲染为失败状态）；
 * - 系统消息压缩边界标记跳过、silent 消息跳过；
 * - 用户消息 _meta/顶层 filePath 双来源兼容、fileHidden 语义保留；
 * - tool_use 消息从 toolMetaMap 回填裁剪掉的 diff/_meta 大字段。
 */
export function restoreMessagesFromConversation(msg: Extract<HostToWebviewMessage, { type: 'conversationLoaded' }>): Message[] {
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

  // 末位一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：core 只记最后一条
  // （meta.json 的 `onceMessage`），恢复到时间线末位——与实时到达的 once 节点同一条
  // 通路，后继节点追加时由 `stripOnce` 移除。
  const onceMessage = msg.conversation.metadata?.onceMessage;
  if (onceMessage && typeof onceMessage.content === 'string' && onceMessage.content !== '') {
    restoredMessages.push({
      role: 'system' as const,
      content: onceMessage.content,
      once: true,
      timestamp: Date.now(),
    });
  }

  return restoredMessages;
}

/**
 * 把跨会话缓冲的 updateToolStatus 回放进刚恢复的消息列表：
 * 只在缓冲状态比当前状态「更新」（success/fail > running > normal）时覆盖；
 * 无论是否覆盖都消费掉缓冲条目（避免后续重复应用）。
 */
export function replayBufferedToolStatusIntoMessages(
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

export interface LoadedConversationCommonContext {
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
 * 默认值已经解析进消息里，webview 不再自备兜底（`docs/hosts/webview-facts.md` 第 3 节）。
 * 返回解析出的 savedContext 关键字段供调用点继续计算 contextLength / 新建 state。
 */
export function applyLoadedConversationState(
  msg: Extract<HostToWebviewMessage, { type: 'conversationLoaded' }>,
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
 * 载荷由宿主一次给齐（`docs/hosts/webview-facts.md` 第 6 节），缺字段即协议错误；
 * 此时不打开面板，避免用空值把用户误导去重配。
 */
export function missingPanelFields(payload: LlmConfigPanelPayload): string[] {
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
  if (payload.fontSize !== 'medium' && payload.fontSize !== 'large' && payload.fontSize !== 'xlarge') {
    problems.push('fontSize');
  }
  return problems;
}

/** updateToolStatus 缓冲条目的形状（pendingToolStatusRef / bufferedToolStatusRef 共用） */
export interface ToolStatusEntry {
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
export function toToolStatusEntry(msg: {
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
export function toUiMessage(msg: MessageData): Message {
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
    // 一次性通知标记（specs/014-once-notification-message）：随载荷透传
    once: msg.once,
    images: msg.images,
    meta: msg.meta as Record<string, unknown> | undefined,
    timestamp: Date.now(),
    cacheReadInputTokens: msg.cacheReadInputTokens,
    cacheCreationInputTokens: msg.cacheCreationInputTokens,
  };
}

/**
 * 剥除一次性通知节点（`docs/hosts/webview-ui.md` 第 11 节）。
 *
 * 「后继即删」的唯一实现：任何**追加新节点**的入口在追加前先过本函数——时间线至多
 * 一条 once 且总在末位；就地更新（工具进度 / 参数 / 状态、流式增量）不经过它，
 * once 节点保留。多数调用点没有 once 节点，原引用返回避免无谓复制。
 */
export function stripOnce(messages: Message[]): Message[] {
  return messages.some((m) => m.once) ? messages.filter((m) => !m.once) : messages;
}

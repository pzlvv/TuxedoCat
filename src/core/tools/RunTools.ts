/**
 * 执行工具调用
 * 负责并发/串行执行工具，收集结果
 *
 * 执行策略（v2）：
 * 每个工具按「授权 → 执行 → 结果」的顺序逐个处理，不再使用「先全部授权、再统一执行」的两阶段设计。
 * 两阶段设计的问题：如果批次中后一个工具在授权阶段被拒绝，函数直接 return 跳过执行阶段，
 * 导致前面已批准但尚未执行的工具既不会执行、也不会生成 tool_result，在对话中留下孤儿 tool_use，
 * 后续 LLM API 调用会报 "tool_use ids were found without tool_result blocks" 错误。
 *
 * v2 规则：
 * - 非并发安全工具（Edit/Write/TodoWrite）：完整走完「preview(授权) → finish(执行) → result」后再处理下一个，
 *   保证 preview 始终基于最新文件状态，且任一工具被拒时，前面的工具都已有完整结果。
 * - 并发安全工具（Read/Grep/Glob/Agent/Reply/只读 Bash）：收集连续的工具成批并行执行，保留并行优化。
 */

import { randomUUID } from 'crypto';
import type { Message } from '../types.js';
import { getAllTools } from './index.js';
import type { ToolUseContext, Tool, ToolProgressData } from './Tool.js';
import type { AssistantUI } from '../AssistantUI.js';
import { logger } from '../Logger.js';
import { persistLargeOutput, buildLargeToolResultMessage } from './toolResultStorage.js';

/**
 * 生成全局唯一的 tool_result uuid
 * 使用 crypto.randomUUID() 保证即使在同一毫秒内也不会冲突
 */
function generateToolUuid(): string {
  return `tool_${randomUUID()}`;
}

export interface ToolExecutionUpdate {
  message?: Message;
  shouldPreventContinuation?: boolean;
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: unknown;
}

/**
 * 已批准待执行的工具条目（并发批 / 串行执行用）
 */
interface ApprovedToolItem {
  toolUse: ToolUseBlock;
  tool: Tool;
  parsedInput: Record<string, unknown>;
  toolUseContext: ToolUseContext;
  childAbortController?: AbortController; // 每个并行工具独立的子 AbortController
}

/**
 * 跟踪正在等待用户授权的 tool_use ID（内存中，非持久化）
 */
const pendingToolUseIds = new Set<string>();

export function getPendingToolUseIds(): Set<string> {
  return pendingToolUseIds;
}

/**
 * 授权结果
 * - skip: 工具不存在 / 输入校验失败，已 yield 错误结果，跳过该工具
 * - stop: 工具被拒绝，已 yield 拒绝结果 + 后续剩余工具的取消结果，终止整个批次
 * - approve: 授权通过，携带待执行条目
 */
type AuthorizeOutcome =
  | { action: 'skip' }
  | { action: 'stop'; shouldPreventContinuation?: boolean }
  | { action: 'approve'; item: ApprovedToolItem };

/**
 * 构造一条 tool_result user 消息
 * permission 可选，用于携带 deny 路径的 diff 上下文（beforeContent/afterContent 等）
 */
function buildToolResultMessage(
  toolUseId: string,
  content: string | unknown[],
  exitCode: number,
  isCanceled: boolean,
  permission?: any,
): Message {
  const toolResultMessage: any = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    exit_code: exitCode,
    is_canceled: isCanceled,
  };
  if (permission) {
    if (permission.beforeContent !== undefined) toolResultMessage.beforeContent = permission.beforeContent;
    if (permission.afterContent !== undefined) toolResultMessage.afterContent = permission.afterContent;
    if (permission.contextBefore !== undefined) toolResultMessage.contextBefore = permission.contextBefore;
    if (permission.contextAfter !== undefined) toolResultMessage.contextAfter = permission.contextAfter;
  }
  return {
    type: 'user',
    message: { role: 'user', content: [toolResultMessage as unknown] },
    uuid: generateToolUuid(),
    timestamp: Date.now(),
  };
}

/**
 * 取消 toolUseBlocks 中 currentIndex 之后的剩余工具（被拒工具之后的工具不执行）
 */
async function* cancelRemainingTools(
  sessionID: string,
  toolUseBlocks: ToolUseBlock[],
  currentIndex: number,
  ui: AssistantUI | undefined,
  cancelMsg: string,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  if (currentIndex >= 0 && currentIndex < toolUseBlocks.length - 1) {
    for (const remainingTool of toolUseBlocks.slice(currentIndex + 1) as ToolUseBlock[]) {
      ui?.onToolResult(sessionID, remainingTool.id, remainingTool.name, cancelMsg, 'error');
      yield { message: buildToolResultMessage(remainingTool.id, cancelMsg, -1, true) };
    }
  }
}

/**
 * 取消一批已批准但尚未执行的工具（发生在并发批收集过程中遇到后续工具被拒时）
 * 必须为它们生成 tool_result，否则会在对话中留下孤儿 tool_use
 */
async function* cancelApprovedItems(
  sessionID: string,
  items: ApprovedToolItem[],
  ui: AssistantUI | undefined,
  cancelMsg = 'Tool was canceled because a later tool in the batch was denied',
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  for (const item of items) {
    ui?.onToolResult(sessionID, item.toolUse.id, item.toolUse.name, cancelMsg, 'error');
    yield { message: buildToolResultMessage(item.toolUse.id, cancelMsg, -1, true) };
  }
}

/**
 * 执行工具调用
 *
 * 主循环：逐个工具处理，每个工具「授权 → 执行 → 结果」。
 * 并发安全工具连续出现时收集成批并行执行。
 */
export async function* runTools(
  sessionID: string,
  toolUseBlocks: unknown[],
  toolUseContext: ToolUseContext,
  ui?: AssistantUI,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  const tools = getAllTools();
  const toolMap = new Map(tools.map(t => [t.name, t]));

  // 检查 abort signal
  const signal = (toolUseContext.abortController as any)?.signal as AbortSignal | null;

  const blocks = toolUseBlocks as ToolUseBlock[];
  let i = 0;
  const total = blocks.length;

  while (i < total) {
    const toolUse = blocks[i];
    const tool = toolMap.get(toolUse.name);

    // ---- 验证 + 授权（可能 yield 错误/拒绝/取消消息）----
    const authResult = yield* authorizeOne(sessionID, toolUse, tool, toolUseContext, ui, signal, blocks, i);

    if (authResult.action === 'stop') {
      // authorizeOne 已 yield 拒绝结果并取消剩余工具；前面工具均已执行完成，不会产生孤儿 tool_use
      if (authResult.shouldPreventContinuation) {
        yield { shouldPreventContinuation: true };
      }
      return;
    }
    if (authResult.action === 'skip') {
      i++;
      continue;
    }

    const item = authResult.item;

    // ---- 非并发安全工具：立即完整执行（执行完再进入下一个工具）----
    if (!tool!.isConcurrencySafe(item.parsedInput)) {
      yield* executeSingleItem(sessionID, item, ui, signal);
      i++;
      continue;
    }

    // ---- 并发安全工具：收集后续连续的并发安全工具成批并行执行 ----
    const batch: ApprovedToolItem[] = [item];
    let j = i + 1;
    let shouldStop = false;
    let stopFlag: boolean | undefined;

    while (j < total) {
      const nextUse = blocks[j];
      const nextTool = toolMap.get(nextUse.name);
      // 遇到不存在 / 非并发安全工具时停止收集，交由主循环处理
      if (!nextTool || !nextTool.isConcurrencySafe(nextUse.input as any)) {
        break;
      }
      const nextAuth = yield* authorizeOne(sessionID, nextUse, nextTool, toolUseContext, ui, signal, blocks, j);
      if (nextAuth.action === 'stop') {
        // 后续工具被拒：为当前 batch 中已批准但尚未执行的工具补发取消结果，避免孤儿 tool_use
        yield* cancelApprovedItems(sessionID, batch, ui);
        stopFlag = nextAuth.shouldPreventContinuation;
        shouldStop = true;
        break;
      }
      if (nextAuth.action === 'skip') {
        j++;
        continue;
      }
      batch.push(nextAuth.item);
      j++;
    }

    if (shouldStop) {
      if (stopFlag) {
        yield { shouldPreventContinuation: true };
      }
      return;
    }

    // 并行执行本批次
    yield* executeParallelBatch(sessionID, batch, ui, signal);
    i = j;
  }
}

/**
 * 单个工具：验证输入 + 用户授权
 * 通过 generator yield 错误 / 拒绝 / 取消消息，最终返回 AuthorizeOutcome
 */
async function* authorizeOne(
  sessionID: string,
  toolUse: ToolUseBlock,
  tool: Tool | undefined,
  toolUseContext: ToolUseContext,
  ui: AssistantUI | undefined,
  signal: AbortSignal | null,
  toolUseBlocks: ToolUseBlock[],
  currentIndex: number,
): AsyncGenerator<ToolExecutionUpdate, AuthorizeOutcome, unknown> {
  void signal;

  // --- 工具不存在 ---
  if (!tool) {
    const errorMsg = `Error: Tool "${toolUse.name}" not found`;
    logger.error('runTools', errorMsg);

    await ui?.onPreToolCall(sessionID, toolUse.id, toolUse.name, toolUse.input as Record<string, any>, null);
    ui?.onToolResult(sessionID, toolUse.id, toolUse.name, errorMsg, 'error');

    yield { message: buildToolResultMessage(toolUse.id, errorMsg, -1, false) };
    return { action: 'skip' };
  }

  // --- 输入验证 ---
  let parsedInput = tool.inputSchema.safeParse(toolUse.input);
  let usedInput = toolUse.input;

  logger.info('runTools', `Input validation for ${toolUse.name}: success=${parsedInput.success}, input=${JSON.stringify(toolUse.input)}`);

  if (!parsedInput.success) {
    logger.info('runTools', `Input validation error for ${toolUse.name}: ${parsedInput.error.message}`);
    const fixedInput = fixToolInput(toolUse.input);
    if (fixedInput !== toolUse.input) {
      parsedInput = tool.inputSchema.safeParse(fixedInput);
      if (parsedInput.success) {
        usedInput = fixedInput;
      }
    }
  }

  if (!parsedInput.success) {
    const errorMsg = `InputValidationError: ${parsedInput.error.message}`;
    logger.error('runTools', `Tool ${toolUse.name} input validation failed: ${errorMsg}`);

    await ui?.onPreToolCall(sessionID, toolUse.id, toolUse.name, toolUse.input as Record<string, any>, tool);
    ui?.onToolResult(sessionID, toolUse.id, toolUse.name, errorMsg, 'error');

    yield { message: buildToolResultMessage(toolUse.id, errorMsg, -1, false) };
    return { action: 'skip' };
  }

  if (usedInput !== toolUse.input) {
    (toolUse as any).input = usedInput;
  }

  // --- 语义验证 ---
  if (typeof tool.validateInput === 'function') {
    const validationResult = await tool.validateInput(parsedInput.data, toolUseContext);
    if (!validationResult.result) {
      const errorMsg = `InputValidationError: ${validationResult.message}`;
      logger.error('runTools', `Tool ${toolUse.name} input validation failed: ${errorMsg}`);

      await ui?.onPreToolCall(sessionID, toolUse.id, toolUse.name, toolUse.input as Record<string, any>, tool);
      ui?.onToolResult(sessionID, toolUse.id, toolUse.name, errorMsg, 'error');

      yield { message: buildToolResultMessage(toolUse.id, errorMsg, -1, false) };
      return { action: 'skip' };
    }
  }

  // --- 用户授权 ---
  pendingToolUseIds.add(toolUse.id);
  logger.info('runTools', `Added pending tool: ${toolUse.id}, current pending: ${Array.from(pendingToolUseIds)}`);

  // 传入 schema 解析后的输入，保证 checkPermissions 与 call 使用的是同一份规范化数据
  let permission = await ui?.onPreToolCall(sessionID, toolUse.id, toolUse.name, parsedInput.data as Record<string, any>, tool);
  if (!permission) {
    permission = { behavior: 'allow' };
  }

  const updatedInput = (permission as any).updatedInput as Record<string, unknown> | undefined;
  if (updatedInput) {
    const inputChanged = JSON.stringify((toolUse as any).input) !== JSON.stringify(updatedInput);
    (toolUse as any).input = updatedInput;
    // updatedInput 可能由 UI/权限层修改（例如把 replace_all 从字符串规范化为布尔值），
    // 必须重新解析，确保后续 call 使用的 parsedInput 与 checkPermissions/preview 一致。
    const reParsedInput = tool.inputSchema.safeParse(updatedInput);
    if (reParsedInput.success) {
      parsedInput = reParsedInput;
    } else {
      logger.warn('runTools', `Updated input for ${toolUse.name} failed schema validation: ${reParsedInput.error.message}`);
    }
    // 只有 input 真的变化时才追加更新记录；没变化时跳过，避免无意义的 JSONL 增长。
    if (inputChanged) {
      const { updateToolUseInput } = await import('../history/index.js');
      await updateToolUseInput(sessionID, toolUse.id, updatedInput);
    }
  }

  // 处理 ask / deny
  if (permission.behavior === 'ask') {
    // ask 需要在用户响应后再移除 pendingToolUseIds，
    // 这样切换会话时 webview 能正确显示为 "等待确认"（normal）状态
    const { requestUserChoice } = await import('../Integration.js');
    const userChoice = await requestUserChoice(sessionID, toolUse.name, permission as any);

    // 用户响应后移除 pending 状态
    pendingToolUseIds.delete(toolUse.id);

    if (!userChoice || userChoice.index === 1) {
      // 用户拒绝
      let denyMessage = '用户拒绝操作';
      const reply = userChoice?.reply || '';
      const hasReply = reply.trim().length > 0;
      if (hasReply) denyMessage += `，原因：${reply.trim()}`;
      const shouldTerminate = !hasReply;

      ui?.onToolResult(sessionID, toolUse.id, toolUse.name, denyMessage, 'error');
      yield { message: buildToolResultMessage(toolUse.id, denyMessage, -1, false, permission as any) };

      // 取消后续剩余工具
      yield* cancelRemainingTools(
        sessionID,
        toolUseBlocks,
        currentIndex,
        ui,
        `Tool "${toolUse.name}" was canceled because a previous tool in the batch was denied`,
      );
      return { action: 'stop', shouldPreventContinuation: shouldTerminate };
    }
    // 用户允许
    logger.info('runTools', `User allowed tool "${toolUse.name}"`);
    permission = { behavior: 'allow' as const, updatedInput: toolUse.input as Record<string, unknown> };
  } else {
    // 非 ask 路径（allow/deny）：直接移除 pending 状态
    pendingToolUseIds.delete(toolUse.id);
  }

  if (permission.behavior === 'deny') {
    const denyReason = permission.message || `Tool "${toolUse.name}" was denied by permission check`;
    ui?.onToolResult(sessionID, toolUse.id, toolUse.name, denyReason, 'error');

    yield { message: buildToolResultMessage(toolUse.id, denyReason, -1, false, permission as any) };

    // 取消后续剩余工具
    yield* cancelRemainingTools(
      sessionID,
      toolUseBlocks,
      currentIndex,
      ui,
      `Tool "${toolUse.name}" was canceled because a previous tool in the batch was denied`,
    );
    return { action: 'stop', shouldPreventContinuation: (permission as any).shouldTerminate === true };
  }

  // --- 授权通过，返回待执行条目 ---
  return {
    action: 'approve',
    item: {
      toolUse,
      tool,
      parsedInput: parsedInput.data as Record<string, unknown>,
      toolUseContext,
    },
  };
}

/**
 * 并行执行一批已批准的工具（并发安全工具）
 */
async function* executeParallelBatch(
  sessionID: string,
  batch: ApprovedToolItem[],
  ui?: AssistantUI,
  signal?: AbortSignal | null,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  // 如果信号已经中止，直接返回取消结果
  if (signal?.aborted) {
    logger.warn('executeParallelBatch', 'Signal already aborted, skipping execution');
    yield* cancelApprovedItems(sessionID, batch, ui, 'Command was aborted before execution');
    yield { shouldPreventContinuation: true };
    return;
  }

  // 通知 UI 本批次的所有工具开始运行
  for (const b of batch) {
    const confirmNow = Date.now();
    // 直接修改内存中的 block._meta，确保 mutableMessages 同步后能读到 confirmTimestamp
    // （此时 assistant 消息尚未 push 到 mutableMessages，updateToolUseMeta 无法回填内存）
    if (!(b.toolUse as any)._meta || typeof (b.toolUse as any)._meta !== 'object') {
      (b.toolUse as any)._meta = {};
    }
    (b.toolUse as any)._meta.confirmTimestamp = confirmNow;
    const inp = b.parsedInput;
    if (inp && typeof inp === 'object') {
      const { updateToolUseMeta } = await import('../history/index.js');
      await updateToolUseMeta(sessionID, b.toolUse.id, { confirmTimestamp: confirmNow });
    }
    ui?.onToolCall(sessionID, b.toolUse.id, b.toolUse.name);
  }

  // 为每个工具创建子 AbortController，隔离各自的 abort 信号
  for (const b of batch) {
    b.childAbortController = new AbortController();
    // 父 signal 被 abort 时，同步 abort 所有子 controller
    signal?.addEventListener('abort', () => {
      b.childAbortController?.abort(signal.reason);
    }, { once: true });
  }

  // 并行执行
  const parallelStart = Date.now();
  logger.info('executeParallelBatch', `Promise.allSettled START for ${batch.length} tools [${batch.map(b => `${b.toolUse.name}(${b.toolUse.id})`).join(', ')}]`);
  const results = await Promise.allSettled(
    batch.map(b => executeSingleTool(sessionID, b, ui))
  );
  logger.info('executeParallelBatch', `Promise.allSettled END for ${batch.length} tools, elapsed=${Date.now() - parallelStart}ms`);

  // 按原顺序 yield 结果
  let hasAborted = false;
  for (let k = 0; k < batch.length; k++) {
    const b = batch[k];
    const result = results[k];

    // 如果信号已中止，后续未处理的工具结果标记为取消（不执行的实际跳过）
    if (hasAborted) {
      yield* cancelApprovedItems(sessionID, [b], ui, 'Tool was canceled due to abort');
      continue;
    }

    if (result.status === 'fulfilled') {
      yield* formatAndEmitResult(sessionID, b, result.value, ui, signal);
      if (signal?.aborted && !hasAborted) {
        hasAborted = true;
      }
    } else {
      // Promise rejected
      const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error('executeParallelBatch', `Tool ${b.toolUse.name} failed: ${errorMessage}`);
      ui?.onToolResult(sessionID, b.toolUse.id, b.toolUse.name, errorMessage, 'error');

      yield {
        message: buildToolResultMessage(
          b.toolUse.id,
          `Error executing ${b.toolUse.name}: ${errorMessage}`,
          -1,
          false,
        ),
      };
    }
  }

  if (hasAborted) {
    logger.warn('executeParallelBatch', 'Signal was aborted during parallel execution');
    yield { shouldPreventContinuation: true };
    return;
  }
}

/**
 * 串行执行单个已批准的工具（非并发安全工具），执行完立即产出结果
 */
async function* executeSingleItem(
  sessionID: string,
  item: ApprovedToolItem,
  ui?: AssistantUI,
  signal?: AbortSignal | null,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  // 如果信号已经中止，直接返回取消结果
  if (signal?.aborted) {
    logger.warn('executeSingleItem', 'Signal already aborted, skipping execution');
    ui?.onToolResult(sessionID, item.toolUse.id, item.toolUse.name, 'Command was aborted before execution', 'error');
    yield { message: buildToolResultMessage(item.toolUse.id, 'Command was aborted before execution', -1, true) };
    yield { shouldPreventContinuation: true };
    return;
  }

  const confirmNow = Date.now();
  // 直接修改内存中的 block._meta，确保 mutableMessages 同步后能读到 confirmTimestamp
  if (!(item.toolUse as any)._meta || typeof (item.toolUse as any)._meta !== 'object') {
    (item.toolUse as any)._meta = {};
  }
  (item.toolUse as any)._meta.confirmTimestamp = confirmNow;
  const inp = item.parsedInput;
  if (inp && typeof inp === 'object') {
    const { updateToolUseMeta } = await import('../history/index.js');
    await updateToolUseMeta(sessionID, item.toolUse.id, { confirmTimestamp: confirmNow });
  }
  ui?.onToolCall(sessionID, item.toolUse.id, item.toolUse.name);

  try {
    const result = await executeSingleTool(sessionID, item, ui);
    yield* formatAndEmitResult(sessionID, item, result, ui, signal);
    if (signal?.aborted) {
      yield { shouldPreventContinuation: true };
      return;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('executeSingleItem', `Tool ${item.toolUse.name} failed: ${errorMessage}`);
    ui?.onToolResult(sessionID, item.toolUse.id, item.toolUse.name, errorMessage, 'error');

    yield {
      message: buildToolResultMessage(
        item.toolUse.id,
        `Error executing ${item.toolUse.name}: ${errorMessage}`,
        -1,
        false,
      ),
    };
  }
}

/**
 * 执行单个工具并返回原始结果
 * 如果有 childAbortController，使用其创建隔离的 context 以避免影响其他并行工具
 */
async function executeSingleTool(
  sessionID: string,
  item: ApprovedToolItem,
  ui?: AssistantUI,
): Promise<unknown> {
  const onProgress = (progress: unknown) => {
    // 将 Bash 等工具的流式进度转发给 UI（实时更新输出，而非等完整输出）
    const p = progress as { toolUseID?: string; data?: ToolProgressData } | undefined;
    if (p?.data?.type === 'bash_progress') {
      ui?.onToolProgress?.(sessionID, item.toolUse.id, p.data);
    }
  };

  // 如果设置了 childAbortController，创建隔离的 context
  // 这样工具的 abort 操作（如超时转后台）不会影响其他并行工具
  const context = item.childAbortController
    ? {
      ...item.toolUseContext,
      abortController: {
        ...item.toolUseContext.abortController,
        signal: item.childAbortController.signal,
        abort: (reason?: unknown) => {
          // 子 controller 的 abort 只影响自己，不影响父和其他兄弟工具
          item.childAbortController?.abort(reason);
        },
      },
    }
    : item.toolUseContext;

  const singleStart = Date.now();
  logger.info('executeSingleTool', `START tool="${item.toolUse.name}"(${item.toolUse.id})`);
  return item.tool.call(
    item.parsedInput,
    context,
    undefined,
    onProgress,
  ).finally(() => {
    logger.info('executeSingleTool', `END tool="${item.toolUse.name}"(${item.toolUse.id}) elapsed=${Date.now() - singleStart}ms`);
  });
}

/**
 * 格式化工具执行结果并 yield 消息
 */
async function* formatAndEmitResult(
  sessionID: string,
  item: ApprovedToolItem,
  toolResult: unknown,
  ui?: AssistantUI,
  _signal?: AbortSignal | null,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  const toolUse = item.toolUse;
  const tool = item.tool;

  let output: string | unknown[] = '';
  let exitCode = 0;
  let interrupted = false;
  let formattedResult: any = undefined;

  if (toolResult && typeof toolResult === 'object' && 'data' in toolResult) {
    const data = toolResult.data as { stdout?: string; stderr?: string; exitCode?: number; interrupted?: boolean; content?: string };

    // [ReplyToolDebug] 打印 Reply 工具返回的完整 data 结构
    if (toolUse.name === 'Reply') {
      logger.info('[ReplyToolDebug]', `formatAndEmitResult for Reply tool:` +
        ` data=${JSON.stringify(data)}` +
        ` has_mapToolResult=${typeof tool.mapToolResultToToolResultBlockParam === 'function'}` +
        ` stdout=${typeof data.stdout}, exitCode=${data.exitCode}`);
    }

    if (typeof tool.mapToolResultToToolResultBlockParam === 'function') {
      formattedResult = tool.mapToolResultToToolResultBlockParam(toolResult.data, toolUse.id);
      const formattedContent = formattedResult.content;
      const dataExitCode = data.exitCode ?? 0;
      const isArrayContent = Array.isArray(formattedContent);
      if ((!isArrayContent && typeof formattedContent !== 'string') || (formattedContent === '' && dataExitCode !== 0)) {
        throw new Error(`Tool ${toolUse.name} returned empty content`);
      }

      // --- 全局大结果持久化机制 ---
      // 检查输出是否超过工具定义的 maxResultSizeChars，
      // 且该工具尚未自行处理持久化（通过 persistedOutputPath 标记）。
      // 如果满足条件，RunTools 自动将结果持久化到磁盘并替换为带 preview 的消息。
      // 多模态 content block 数组（如图片）不参与文本持久化。
      const alreadyPersistedByTool = (data as any)?.persistedOutputPath !== undefined;
      let finalOutputContent = formattedContent;
      if (!alreadyPersistedByTool && typeof formattedContent === 'string' && formattedContent.length > (tool.maxResultSizeChars ?? Infinity)) {
        try {
          const persistTaskId = `tool-${toolUse.name}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const persisted = await persistLargeOutput(formattedContent, persistTaskId);
          if (persisted) {
            // 将 formattedResult.content 替换为持久化预览消息
            const previewMsg = buildLargeToolResultMessage(
              persisted.filepath,
              persisted.originalSize,
              persisted.preview,
              persisted.hasMore,
            );
            formattedResult.content = previewMsg;
            finalOutputContent = previewMsg;
          }
        } catch (err) {
          logger.error('formatAndEmitResult', `Failed to persist large output for ${toolUse.name}:`, err);
          // 持久化失败时继续使用原内容（不阻塞工具执行）
        }
      }

      output = finalOutputContent;
      exitCode = dataExitCode;
      interrupted = data.interrupted ?? false;
      if (interrupted) {
        const autoBackgrounded = (toolResult as any).data?.assistantAutoBackgrounded === true;
        if (!autoBackgrounded && typeof output === 'string') {
          output += '\nCommand was interrupted';
        }
      }
    } else {
      if (!data.stdout && !data.stderr) {
        if (data.exitCode === 0) {
          output = 'Command completed successfully (no output)';
        } else {
          throw new Error(`Tool ${toolUse.name} returned no output`);
        }
      } else {
        output = data.stdout || '';
        if (data.stderr) output += (output ? '\n' : '') + data.stderr;
      }
      if (data.exitCode !== undefined) {
        exitCode = data.exitCode;
        if (exitCode !== 0) output += `\nExit code: ${exitCode}`;
      }
      if (data.interrupted) {
        const autoBackgrounded = (toolResult as any).data?.assistantAutoBackgrounded === true;
        if (!autoBackgrounded) {
          output += '\nCommand was interrupted';
        }
      }
      interrupted = data.interrupted ?? false;
    }
  } else {
    throw new Error(`Tool ${toolUse.name} returned invalid result: ${JSON.stringify(toolResult)}`);
  }

  const assistantAutoBackgrounded = (toolResult as any).data?.assistantAutoBackgrounded === true;
  const status = (exitCode !== 0 || interrupted) && !assistantAutoBackgrounded ? 'error' : 'success';
  const outputForUI = typeof output === 'string' ? output : '[Image]';

  // [ReplyToolDebug] 打印最终状态
  if (toolUse.name === 'Reply') {
    logger.info('[ReplyToolDebug]', `formatAndEmitResult final: sessionID=${sessionID}, toolUseId=${toolUse.id}, output.length=${Array.isArray(output) ? output.length : output.length}, exitCode=${exitCode}, status=${status}, onToolResult=${typeof ui?.onToolResult}`);
  }

  logger.info('runTools', '=== Tool Execution ===');
  logger.info('runTools', `Tool: ${toolUse.name}`);
  logger.info('runTools', `Input: ${JSON.stringify(toolUse.input, null, 2)}`);
  logger.info('runTools', `Output (${Array.isArray(output) ? output.length + ' blocks' : output.length + ' chars'}): ${typeof output === 'string' ? output : '[Image content blocks]'}`);
  logger.info('runTools', `ExitCode: ${exitCode}`);
  logger.info('runTools', `Status: ${status}`);
  logger.info('runTools', '=====================');

  ui?.onToolResult(sessionID, toolUse.id, toolUse.name, outputForUI, status);

  const toolResultMessage: any = {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: output,
    exit_code: exitCode,
    is_canceled: false,
  };

  if (formattedResult && typeof formattedResult === 'object') {
    Object.keys(formattedResult).forEach(key => {
      if (key !== 'type' && key !== 'tool_use_id' && key !== 'content' && key !== 'exit_code') {
        toolResultMessage[key] = (formattedResult as any)[key];
      }
    });
  }

  const resultMsg: Message = {
    type: 'user',
    message: { role: 'user', content: [toolResultMessage as unknown] },
    uuid: generateToolUuid(),
    timestamp: Date.now(),
  };

  yield { message: resultMsg };

  // 如果工具返回了 newMessages（如 SkillTool 注入 skill prompt 为 silent user message），
  // 也将这些消息 yield 到对话中，使后续 LLM 调用能读到它们
  if (toolResult && typeof toolResult === 'object' && 'newMessages' in (toolResult as Record<string, unknown>)) {
    const newMsgs = (toolResult as Record<string, unknown>).newMessages;
    if (Array.isArray(newMsgs)) {
      for (const newMsg of newMsgs) {
        yield { message: newMsg as Message };
      }
    }
  }
}

/**
 * 修复 LLM 返回的常见输入格式错误
 *
 * LLM 有时会返回格式不正确的输入，例如：
 * - string 类型的数组: `"[\"xx\": \"abc\"]"`（本应是 array，却被序列化成 string）
 * - 字段值中的格式错误
 *
 * 此函数尝试修复这些常见问题，修复后返回新对象，无法修复则返回原输入。
 */
function fixToolInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return input;
  }

  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  let hasFix = false;

  for (const [key, value] of Object.entries(obj)) {
    result[key] = tryFixStringValue(value);
    if (result[key] !== value) {
      hasFix = true;
    }
  }

  return hasFix ? result : input;
}

/**
 * 尝试修复字符串类型的值，这些值本该是 array 或 object
 * 例如: `"[\"xx\": \"abc\"]"` → 尝试解析为数组
 *       `"{\"x\": 1}"` → 已经是正确 JSON，JSON.parse 即可
 */
function tryFixStringValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  // 尝试直接 JSON.parse（标准情况：字符串被额外序列化了一层）
  try {
    const parsed = JSON.parse(value);
    // 如果解析后是数组或对象，说明是个 JSON 字符串包了一层
    if (Array.isArray(parsed) || (typeof parsed === 'object' && parsed !== null)) {
      return parsed;
    }
    // 解析后仍是基本类型（string/number），说明这个字符串本身就是个普通字符串，不处理
    return value;
  } catch {
    // JSON.parse 失败，尝试修复常见格式问题
  }

  const trimmed = value.trim();

  // 情况 1: 看起来像是数组但不是合法 JSON
  // 例如: "[xx: abc, yy: def]" 或 '["xx": "abc"]' 或 '["xx: abc"]'
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    // 尝试先修复为合法 JSON 再解析
    const fixedJson = trimmed
      .replace(/(['"])?\b([a-zA-Z_]\w*)\b(['"])?\s*:/g, '"$2":')  // key 加引号
      .replace(/'/g, '"');                                         // 单引号转双引号
    try {
      const parsed = JSON.parse(fixedJson);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 修复后仍不是合法 JSON，尝试按字符串数组提取
    }

    // 提取数组内容，按逗号分割
    const inner = trimmed.slice(1, -1).trim();
    if (inner) {
      const items = splitByComma(inner);
      if (items.length > 0) {
        // 判断是否全是 "key: value" 格式
        const keyValueItems = items.filter(item => /^\s*['"]?\w+['"]?\s*:/.test(item));
        if (keyValueItems.length === items.length && items.length > 0) {
          // 所有项都是 key:value 格式，转为对象数组
          return items.map(item => {
            const cleaned = item.trim().replace(/^["']|["']$/g, '');
            const parts = cleaned.split(/:(.+)/s).map(s => s.trim().replace(/^["']|["']$/g, ''));
            if (parts.length >= 2) {
              return { [parts[0]]: parts[1] };
            }
            return cleaned;
          });
        }
        // 否则当成字符串数组
        return items.map(item => item.trim().replace(/^["']|["']$/g, ''));
      }
    }
    return value;
  }

  // 情况 2: 看起来像是对象但不是合法 JSON
  // 例如: "{xx: abc, yy: def}" — key 没加引号
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      // 尝试给 key 加引号
      const fixed = trimmed.replace(/(['"])?([a-zA-Z_]\w*)(['"])?\s*:/g, '"$2":');
      return JSON.parse(fixed);
    } catch {
      return value;
    }
  }

  return value;
}

/**
 * 按逗号分割字符串，但忽略引号内的逗号
 */
function splitByComma(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let depth = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (char === '"' || char === "'") {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
        current += char;
      } else if (char === quoteChar && (i === 0 || str[i - 1] !== '\\')) {
        inQuote = false;
        current += char;
      } else {
        current += char;
      }
    } else if (char === '{' || char === '[') {
      depth++;
      current += char;
    } else if (char === '}' || char === ']') {
      depth--;
      current += char;
    } else if (char === ',' && !inQuote && depth === 0) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    result.push(current.trim());
  }
  return result;
}

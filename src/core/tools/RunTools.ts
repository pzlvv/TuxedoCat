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
 * - 并发安全工具（Read/Grep/Glob/Agent/Reply/只读 Bash）：**批准一个就立即启动一个**，
 *   连续的工具因此仍然并行执行（保留并行优化），但不会「等整批都授权完才开始」：
 *   - 用户确认（ask）一个 Agent 后它立刻开跑，不必等后面还在等确认的工具；
 *   - 后面某个工具被拒时，只会取消尚未启动的工具，已启动的继续执行并回收结果，
 *     不会把前面已批准的工具一起取消。
 */

import { randomUUID } from 'crypto';
import type { Message } from '../types.js';
import { getAllTools } from './index.js';
import type { ToolUseContext, Tool, ToolProgressData } from './Tool.js';
import { MAX_RESULT_SIZE_CHARS } from './Tool.js';
import type { CoreEvent } from '../AssistantEventBus.js';
import { requireEventBus } from '../AssistantEventBus.js';
import { logger } from '../Logger.js';
import { persistLargeOutput, buildLargeToolResultMessage } from './toolResultStorage.js';
import { unwrapToolInput, normalizeToolInput } from '../utils/toolInput.js';

/** core → UI 单向事件的发送侧封装（RunTools 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/**
 * 生成随机 id 后缀（默认 9 位 base36），统一各处 uuid 生成模式。
 * N 统一为 9：相比部分调用点原来的 8 位，碰撞风险只减不增。
 */
export function randomId(prefix: string, len = 9): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 2 + len)}`;
}

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
 * 已启动（执行中）的工具条目：promise 是 executeSingleTool 的未决结果，
 * 由 drainStartedItems 按批准顺序回收。
 */
interface StartedToolItem {
  item: ApprovedToolItem;
  promise: Promise<unknown>;
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

/** tool_result block 的附加标记（is_error / is_canceled / exit_code 等错误路径字段） */
export interface ToolResultFlags {
  is_error?: boolean;
  is_canceled?: boolean;
  exit_code?: number;
}

/**
 * 构造一条 tool_result user 消息
 * permission 可选，用于携带 deny 路径的 diff 上下文（beforeContent/afterContent 等）
 * flags 可选，用于错误路径覆盖默认的 exit_code(-1) / is_canceled(false)，或追加 is_error
 */
export function buildToolResultMessage(
  toolUseId: string,
  content: string | unknown[],
  exitCode: number,
  isCanceled: boolean,
  permission?: any,
  flags?: ToolResultFlags,
): Message {
  const toolResultMessage: any = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    exit_code: exitCode,
    is_canceled: isCanceled,
  };
  if (flags?.is_error !== undefined) toolResultMessage.is_error = flags.is_error;
  if (flags?.is_canceled !== undefined) toolResultMessage.is_canceled = flags.is_canceled;
  if (flags?.exit_code !== undefined) toolResultMessage.exit_code = flags.exit_code;
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
  cancelMsg: string,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  if (currentIndex >= 0 && currentIndex < toolUseBlocks.length - 1) {
    for (const remainingTool of toolUseBlocks.slice(currentIndex + 1) as ToolUseBlock[]) {
      emitToUi({
        type: 'toolResult',
        sessionId: sessionID,
        toolUseId: remainingTool.id,
        toolName: remainingTool.name,
        output: cancelMsg,
        status: 'error',
      });
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
  cancelMsg = 'Tool was canceled because a later tool in the batch was denied',
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  for (const item of items) {
    emitToUi({
      type: 'toolResult',
      sessionId: sessionID,
      toolUseId: item.toolUse.id,
      toolName: item.toolUse.name,
      output: cancelMsg,
      status: 'error',
    });
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
    const authResult = yield* authorizeOne(sessionID, toolUse, tool, toolUseContext, blocks, i);

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
      yield* executeSingleItem(sessionID, item, signal);
      i++;
      continue;
    }

    // ---- 并发安全工具：批准一个就立即启动一个 ----
    // 启动（而不是先收集完再统一执行）是本轮的关键：用户确认一个工具后它立刻开跑，
    // 不必等后面还在等用户确认的工具；后面某个工具被拒时，也不会连累已启动的工具。
    const started: StartedToolItem[] = [];
    if (signal?.aborted) {
      logger.warn('runTools', 'Signal already aborted, skipping execution');
      yield* cancelApprovedItems(sessionID, [item], 'Command was aborted before execution');
      yield { shouldPreventContinuation: true };
      return;
    }
    started.push({ item, promise: startApprovedItem(sessionID, item, signal) });

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
      const nextAuth = yield* authorizeOne(sessionID, nextUse, nextTool, toolUseContext, blocks, j);
      if (nextAuth.action === 'stop') {
        // 后续工具被拒：已启动的工具继续执行（下面统一回收结果，不会留下孤儿 tool_use）；
        // 本批次没有「已批准但未启动」的工具，无需补取消结果。
        stopFlag = nextAuth.shouldPreventContinuation;
        shouldStop = true;
        break;
      }
      if (nextAuth.action === 'skip') {
        j++;
        continue;
      }
      started.push({ item: nextAuth.item, promise: startApprovedItem(sessionID, nextAuth.item, signal) });
      j++;
    }

    // 回收本批已启动工具的结果（按批准顺序产出 tool_result）
    yield* drainStartedItems(sessionID, started, signal);

    if (shouldStop) {
      if (stopFlag) {
        yield { shouldPreventContinuation: true };
      }
      return;
    }

    i = j;
  }
}

/**
 * 单个工具：验证输入 + 用户授权
 * 通过 generator yield 错误 / 拒绝 / 取消消息，最终返回 AuthorizeOutcome
 */

/** 通知 UI 工具以 error 结束（卡片置为失败态） */
function emitToolResultError(sessionID: string, toolUseId: string, toolName: string, output: string): void {
  emitToUi({
    type: 'toolResult',
    sessionId: sessionID,
    toolUseId,
    toolName,
    output,
    status: 'error',
  });
}

/**
 * 发送 toolPermissionRequested 请求并等待 UI 返回权限决策。
 * UI 侧只负责展示（工具卡片 / 确认框），决策本身已由 PermissionPolicy 加工完。
 *
 * **不设超时**：权限确认的耗时取决于用户（可能正在看 diff），没有合理的上界。
 * 只有请求本身失败（无订阅者 / 处理器异常）才按 deny 兜底——那是调用链坏了，
 * 不是用户还在犹豫。
 */
async function emitToolPermissionRequest(
  sessionID: string,
  toolUseId: string,
  toolName: string,
  args: Record<string, any>,
  tool: unknown,
): Promise<import('../AssistantEventBus.js').CoreRequestResultMap['toolPermissionRequested']> {
  const { resolveToolPermission } = await import('./PermissionPolicy.js');
  const { permResult, displayArgs, agentMode } = await resolveToolPermission(sessionID, toolName, args, tool);
  try {
    return await requireEventBus().request({
      type: 'toolPermissionRequested',
      sessionId: sessionID,
      toolUseId,
      toolName,
      permResult,
      displayArgs,
      agentMode,
    });
  } catch (err) {
    // 总线请求失败（无订阅者 / 处理器异常）按 deny 处理
    logger.warn('runTools', `toolPermissionRequested request failed: ${err}`);
    return { behavior: 'deny' as const, message: `Permission request failed: ${err}` };
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
  toolUseBlocks: ToolUseBlock[],
  currentIndex: number,
): AsyncGenerator<ToolExecutionUpdate, AuthorizeOutcome, unknown> {
  // --- 工具不存在 ---
  if (!tool) {
    const errorMsg = `Error: Tool "${toolUse.name}" not found`;
    logger.error('runTools', errorMsg);

    await emitToolPermissionRequest(sessionID, toolUse.id, toolUse.name, normalizeToolInput(toolUse.input), null);
    emitToolResultError(sessionID, toolUse.id, toolUse.name, errorMsg);

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

    // 非对象入参（典型：LLM 返回的非法 JSON 参数解析失败后残留的原文 string）在这里
    // 收敛成空对象并落一条 tool_use_update：否则该字符串随历史在后续每轮请求中原样
    // 回传给 Provider，严格校验 arguments 的服务商会一直 400，表现为「此后所有输入
    // 都失败」。对象型入参即使校验失败也可安全序列化，保持原样。
    if (typeof toolUse.input !== 'object' || toolUse.input === null || Array.isArray(toolUse.input)) {
      (toolUse as any).input = {};
      try {
        const { updateToolUseInput } = await import('../history/index.js');
        await updateToolUseInput(sessionID, toolUse.id, {});
      } catch (e) {
        logger.warn('runTools', `Failed to persist normalized input for ${toolUse.name}: ${e}`);
      }
    }

    await emitToolPermissionRequest(sessionID, toolUse.id, toolUse.name, normalizeToolInput(toolUse.input), tool);
    emitToolResultError(sessionID, toolUse.id, toolUse.name, errorMsg);

    yield { message: buildToolResultMessage(toolUse.id, errorMsg, -1, false) };
    return { action: 'skip' };
  }

  if (usedInput !== toolUse.input) {
    (toolUse as any).input = usedInput;
    // 同步修正已落盘的 tool_use.input：模型 / Provider 偶尔会把整个入参 double-encode
    // 成字符串，如果只修内存，历史对话恢复时仍会拿到字符串，UI 层对其写属性会抛
    // "Cannot create property 'xxx' on string"。这里追加一条 tool_use_update 记录，
    // 让后续加载历史时回放为修正后的对象。
    if (usedInput && typeof usedInput === 'object') {
      try {
        const { updateToolUseInput } = await import('../history/index.js');
        await updateToolUseInput(sessionID, toolUse.id, usedInput as Record<string, unknown>);
      } catch (e) {
        logger.warn('runTools', `Failed to persist fixed input for ${toolUse.name}: ${e}`);
      }
    }
  }

  // --- 语义验证 ---
  if (typeof tool.validateInput === 'function') {
    const validationResult = await tool.validateInput(parsedInput.data, toolUseContext);
    if (!validationResult.result) {
      const errorMsg = `InputValidationError: ${validationResult.message}`;
      logger.error('runTools', `Tool ${toolUse.name} input validation failed: ${errorMsg}`);

      await emitToolPermissionRequest(sessionID, toolUse.id, toolUse.name, toolUse.input as Record<string, any>, tool);
      emitToolResultError(sessionID, toolUse.id, toolUse.name, errorMsg);

      yield { message: buildToolResultMessage(toolUse.id, errorMsg, -1, false) };
      return { action: 'skip' };
    }
  }

  // --- 用户授权 ---
  pendingToolUseIds.add(toolUse.id);
  logger.info('runTools', `Added pending tool: ${toolUse.id}, current pending: ${Array.from(pendingToolUseIds)}`);

  // 传入 schema 解析后的输入，保证权限决策与 call 使用的是同一份规范化数据。
  // 发送前先发 toolCall 事件：UI 收到后立即上架 running 卡片，
  // 避免「权限决策期间既没有 thinking 也没有 running」的空窗（见 `docs/architecture/events.md` 第 2.1 节的 toolCall 行）。
  emitToUi({ type: 'toolCall', sessionId: sessionID, toolUseId: toolUse.id, toolName: toolUse.name });
  let permission = await emitToolPermissionRequest(sessionID, toolUse.id, toolUse.name, parsedInput.data as Record<string, any>, tool);

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
    let userChoice: { index: number; reply?: string } | undefined;
    try {
      userChoice = await requestUserChoice(sessionID, toolUse.name, permission as any);
    } catch (err) {
      // 请求失败（如会话在等待期间被关闭，UserChoiceQueue.rejectPending）按 deny 处理，
      // 与 toolPermissionRequested 的失败兜底同一口径：不弹框就不执行。
      logger.warn('runTools', `userChoice request failed: ${err}`);
      userChoice = undefined;
    }

    // 用户响应后移除 pending 状态
    pendingToolUseIds.delete(toolUse.id);

    if (!userChoice || userChoice.index === 1) {
      // 用户拒绝
      let denyMessage = '用户拒绝操作';
      const reply = userChoice?.reply || '';
      const hasReply = reply.trim().length > 0;
      if (hasReply) denyMessage += `，原因：${reply.trim()}`;
      const shouldTerminate = !hasReply;

      emitToolResultError(sessionID, toolUse.id, toolUse.name, denyMessage);
      yield { message: buildToolResultMessage(toolUse.id, denyMessage, -1, false, permission as any) };

      // 取消后续剩余工具
      yield* cancelRemainingTools(
        sessionID,
        toolUseBlocks,
        currentIndex,
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
    emitToolResultError(sessionID, toolUse.id, toolUse.name, denyReason);

    yield { message: buildToolResultMessage(toolUse.id, denyReason, -1, false, permission as any) };

    // 取消后续剩余工具
    yield* cancelRemainingTools(
      sessionID,
      toolUseBlocks,
      currentIndex,
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
 * 启动一个已批准的工具：上架 running 卡片（写 confirmTimestamp）、准备独立的子
 * AbortController，然后立即开始执行，返回未决的执行结果 Promise。
 *
 * 刻意不在这里 await 执行结果：调用方拿到 Promise 后可以继续授权后续工具，
 * 让「已批准的工具」立刻开跑，而不必等整批都授权完（见 runTools 的并发安全分支）。
 */
function startApprovedItem(
  sessionID: string,
  item: ApprovedToolItem,
  signal?: AbortSignal | null,
): Promise<unknown> {
  const confirmNow = Date.now();
  // 直接修改内存中的 block._meta，确保 mutableMessages 同步后能读到 confirmTimestamp
  // （此时 assistant 消息尚未 push 到 mutableMessages，updateToolUseMeta 无法回填内存）
  if (!(item.toolUse as any)._meta || typeof (item.toolUse as any)._meta !== 'object') {
    (item.toolUse as any)._meta = {};
  }
  (item.toolUse as any)._meta.confirmTimestamp = confirmNow;

  const inp = item.parsedInput;
  const metaReady = inp && typeof inp === 'object'
    ? import('../history/index.js').then(({ updateToolUseMeta }) =>
      updateToolUseMeta(sessionID, item.toolUse.id, { confirmTimestamp: confirmNow }))
    : Promise.resolve();

  // 每个工具独立的子 AbortController，隔离各自的 abort 信号：
  // 父 signal 被 abort 时只同步 abort 自己的子 controller。
  item.childAbortController = new AbortController();
  signal?.addEventListener('abort', () => {
    item.childAbortController?.abort(signal.reason);
  }, { once: true });

  // 通知 UI 该工具开始运行
  emitToUi({ type: 'toolCall', sessionId: sessionID, toolUseId: item.toolUse.id, toolName: item.toolUse.name });

  return metaReady.then(() => executeSingleTool(sessionID, item));
}

/**
 * 回收一批已启动工具的结果：等待所有 Promise 落定，再按启动顺序产出 tool_result。
 */
async function* drainStartedItems(
  sessionID: string,
  started: StartedToolItem[],
  signal?: AbortSignal | null,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  const batchStart = Date.now();
  logger.info('drainStartedItems', `Promise.allSettled START for ${started.length} tools [${started.map(s => `${s.item.toolUse.name}(${s.item.toolUse.id})`).join(', ')}]`);
  const results = await Promise.allSettled(started.map(s => s.promise));
  logger.info('drainStartedItems', `Promise.allSettled END for ${started.length} tools, elapsed=${Date.now() - batchStart}ms`);

  // 按启动顺序 yield 结果
  let hasAborted = false;
  for (let k = 0; k < started.length; k++) {
    const item = started[k].item;
    const result = results[k];

    // 如果信号已中止，后续未处理的工具结果标记为取消（不执行的实际跳过）
    if (hasAborted) {
      yield* cancelApprovedItems(sessionID, [item], 'Tool was canceled due to abort');
      continue;
    }

    if (result.status === 'fulfilled') {
      yield* formatAndEmitResult(sessionID, item, result.value, signal);
      if (signal?.aborted && !hasAborted) {
        hasAborted = true;
      }
    } else {
      // Promise rejected
      const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.error('drainStartedItems', `Tool ${item.toolUse.name} failed: ${errorMessage}`);
      emitToolResultError(sessionID, item.toolUse.id, item.toolUse.name, errorMessage);

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

  if (hasAborted) {
    logger.warn('drainStartedItems', 'Signal was aborted during parallel execution');
    yield { shouldPreventContinuation: true };
  }
}

/**
 * 串行执行单个已批准的工具（非并发安全工具），执行完立即产出结果
 */
async function* executeSingleItem(
  sessionID: string,
  item: ApprovedToolItem,
  signal?: AbortSignal | null,
): AsyncGenerator<ToolExecutionUpdate, void, unknown> {
  // 如果信号已经中止，直接返回取消结果
  if (signal?.aborted) {
    logger.warn('executeSingleItem', 'Signal already aborted, skipping execution');
    emitToolResultError(sessionID, item.toolUse.id, item.toolUse.name, 'Command was aborted before execution');
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
  emitToUi({ type: 'toolCall', sessionId: sessionID, toolUseId: item.toolUse.id, toolName: item.toolUse.name });

  try {
    const result = await executeSingleTool(sessionID, item);
    yield* formatAndEmitResult(sessionID, item, result, signal);
    if (signal?.aborted) {
      yield { shouldPreventContinuation: true };
      return;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('executeSingleItem', `Tool ${item.toolUse.name} failed: ${errorMessage}`);
    emitToolResultError(sessionID, item.toolUse.id, item.toolUse.name, errorMessage);

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
): Promise<unknown> {
  const onProgress = (progress: unknown) => {
    // 将 Bash 等工具的流式进度转发给 UI（实时更新输出，而非等完整输出）
    const p = progress as { toolUseID?: string; data?: ToolProgressData } | undefined;
    if (p?.data?.type === 'bash_progress') {
      emitToUi({
        type: 'toolProgress',
        sessionId: sessionID,
        toolUseId: item.toolUse.id,
        progress: p.data,
      });
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

      // --- 全局大结果持久化机制（唯一的结果上限入口）---
      // 所有工具共用 MAX_RESULT_SIZE_CHARS（4K）：超过即把完整结果持久化到磁盘，
      // 上下文 / UI 只保留「前 2K + 后 2K」预览。工具自身不再另设阈值。
      // 多模态 content block 数组（如图片）不参与文本持久化。
      const alreadyPersistedByTool = (data as any)?.persistedOutputPath !== undefined;
      let finalOutputContent = formattedContent;
      if (!alreadyPersistedByTool && typeof formattedContent === 'string' && formattedContent.length > (tool.maxResultSizeChars ?? MAX_RESULT_SIZE_CHARS)) {
        try {
          const persistTaskId = `tool-${toolUse.name}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const persisted = await persistLargeOutput(formattedContent, sessionID, persistTaskId);
          if (persisted) {
            // 将 formattedResult.content 替换为持久化预览消息
            const previewMsg = buildLargeToolResultMessage(
              persisted.filepath,
              persisted.originalSize,
              persisted.preview,
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
    logger.info('[ReplyToolDebug]', `formatAndEmitResult final: sessionID=${sessionID}, toolUseId=${toolUse.id}, output.length=${Array.isArray(output) ? output.length : output.length}, exitCode=${exitCode}, status=${status}`);
  }

  logger.info('runTools', '=== Tool Execution ===');
  logger.info('runTools', `Tool: ${toolUse.name}`);
  logger.info('runTools', `Input: ${JSON.stringify(toolUse.input, null, 2)}`);
  logger.info('runTools', `Output (${Array.isArray(output) ? output.length + ' blocks' : output.length + ' chars'}): ${typeof output === 'string' ? output : '[Image content blocks]'}`);
  logger.info('runTools', `ExitCode: ${exitCode}`);
  logger.info('runTools', `Status: ${status}`);
  logger.info('runTools', '=====================');

  emitToUi({
    type: 'toolResult',
    sessionId: sessionID,
    toolUseId: toolUse.id,
    toolName: toolUse.name,
    output: outputForUI,
    status: status as 'success' | 'error',
  });

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
export function fixToolInput(input: unknown): unknown {
  // 顶层是 JSON 字符串时先解包：模型 / Provider 有时会把整个 input 再 JSON.stringify
  // 一次（double-encode），例如 AskUserQuestion 的入参变成 "{\"question\":...}"。
  // 不处理的话 safeParse 必然失败，后续还会把原始字符串传给 UI 层。
  if (typeof input === 'string') {
    return tryParseJsonString(input);
  }

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
 * 尝试把（可能多层嵌套的）JSON 字符串解包成对象 / 数组。
 * 只有最终解出对象或数组才认为修复成功，否则返回原字符串，
 * 避免把普通字符串（如 "hello"）误改语义。
 */
function tryParseJsonString(value: string): unknown {
  return unwrapToolInput(value);
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

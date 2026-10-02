/**
 * SpinLoop - Spin Design 主循环
 *
 * 读取 spin.json，按拓扑序逐个执行未通过的节点，
 * 每个节点起子 agent 执行，完成后由 LLM 根据 note 判断是否通过。
 */

import { logger } from '../Logger.js';
import type { QueryEngine } from '../QueryEngine.js';
import type { CoreEvent } from '../AssistantEventBus.js';
import { requireEventBus } from '../AssistantEventBus.js';
import type { MessageData } from '../types.js';
import { getMessageOrigin } from '../utils/messageOrigin.js';
import { CoreNoticeKeys } from '../coreText.js';

/** core → UI 单向事件的发送侧封装（SpinLoop 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}
import { getAllSkills } from '../skills/loadSkillsDir.js';
import { substituteBuiltinVariables } from '../skills/variableResolver.js';
import {
  readSpinJson,
  validateSpinDesign,
  getNextNode,
  topologicalSort,
  buildRunPrompt,
  substituteSpinVariables,
  normalizeRolloutCount,
  normalizeRolloutPassed,
  splitForEachRows,
  updateNodeMeta,
} from './Engine.js';
import { SpinJudger } from './SpinJudger.js';
import type { SpinNode } from './Types.js';
import type { Message } from '../types.js';

const MAX_ATTEMPTS = 100;

/**
 * 获取当前 spin 子代理 ID。
 *
 * AgentTool 在创建子代理后会立即将其注册到 subAgentRegistry（不会延迟），
 * spinLoop 顺序执行，因此该 creator 最近注册的子代理就是当前节点刚启动的子代理。
 */
async function getCurrentSpinAgentId(sessionId: string): Promise<string | undefined> {
  try {
    const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
    const ids = subAgentRegistry.listForCreator(sessionId);
    return ids.length > 0 ? ids[ids.length - 1] : undefined;
  } catch {
    return undefined;
  }
}

async function waitForAgentReply(
  engine: QueryEngine,
  pollIntervalMs: number = 1000,
  expectedAgentId?: string,
): Promise<string | null> {
  const queue = (engine as any).agentMessageQueue;
  const messages = engine.getMessages();

  /**
   * 父会话或当前子代理被 abort 时立即结束等待。
   * 返回 null 表示 spin 执行已被用户中止，调用方应停止主循环。
   */
  const checkAborted = async (): Promise<boolean> => {
    if (typeof (engine as any).isAborted === 'function' && (engine as any).isAborted()) {
      return true;
    }
    if (!expectedAgentId) {
      return false;
    }
    try {
      const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
      const record = subAgentRegistry.get(expectedAgentId);
      const childEngine = record?.engine as any;
      if (typeof childEngine?.isAborted !== 'function' || !childEngine.isAborted()) {
        return false;
      }
      // 子代理的“静默中止”是其在首次 Reply 后主动停止自身，并非用户中止；
      // 此时仍需继续读取其 Reply，否则会把正常完成误判为中止而终止整个 spin。
      if (typeof childEngine.isSilentAbort === 'function' && childEngine.isSilentAbort()) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  if (await checkAborted()) {
    logger.info('SpinLoop', 'Spin aborted before waiting for sub-agent Reply');
    return null;
  }

  /**
   * 只取当前子代理的回复，并清空整个队列。
   * 清空整列可以避免上一轮/同一子代理多余的 Reply 残留在队列中，
   * 干扰后续节点的 waitForAgentReply。
   */
  const takeCurrentQueueReply = (): string | null => {
    if (!queue || queue.length === 0) return null;
    // 只认子代理回复：后台 Bash 完成通知（source='bash'）不是 Reply，不能当结果消费
    const items = queue.filter((item: any) =>
      item.source !== 'bash' && (!expectedAgentId || item.agentId === expectedAgentId));
    queue.length = 0;
    if (items.length === 0) return null;
    // spin 模式下只接受该子代理最后一次 Reply（通常是最终结果），
    // 之前若有多余的进度/重复回复直接丢弃。
    const content = items[items.length - 1].content as string;
    logger.info('SpinLoop', `Found sub-agent Reply (agent=${expectedAgentId ?? 'any'}): "${content.substring(0, 100)}..."`);
    return content;
  };

  // Step 1: 先在 mutableMessages 中查找从磁盘恢复的 agent reply。
  // 恢复场景：spin 模式重启后，agentMessageQueue 为空，但已持久化的消息中
  // 可能包含子 agent 的回复（agent_reply_* 或 origin=agent 且 silent 的 user 消息）。
  // 必须按 expectedAgentId 过滤，避免上一轮子代理的旧回复被当成当前节点结果。
  let persistedReply: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    // 查找 origin=agent 且 silent 的 user 消息（spin 模式下 agent reply 的标记）
    if (msg.type === 'user' && getMessageOrigin(msg) === 'agent' && msg.silent === true && typeof msg.message?.content === 'string') {
      if (expectedAgentId && msg.agentId !== expectedAgentId) continue;
      persistedReply = msg.message.content as string;
      logger.info('SpinLoop', `Found persisted agent reply in mutableMessages (agent=${expectedAgentId ?? 'any'}): "${persistedReply.substring(0, 100)}..."`);
      break;
    }
  }

  // Step 2: 检查是否已有当前子代理的消息在队列中
  const existingReply = takeCurrentQueueReply();
  if (existingReply) return existingReply;

  // 没有 expectedAgentId（恢复/兜底场景）时，直接使用已持久化的回复。
  if (!expectedAgentId && persistedReply !== null) return persistedReply;

  // 有 expectedAgentId 且子代理已经结束（或不在注册表中）时，
  // 已持久化的回复就是最终回复，无需再等一轮轮询。
  if (expectedAgentId && persistedReply !== null) {
    try {
      const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
      const record = subAgentRegistry.get(expectedAgentId);
      if (!record || !record.engine.isConsumerRunning) {
        return persistedReply;
      }
    } catch {
      return persistedReply;
    }
  }

  logger.info('SpinLoop', `Waiting for sub-agent Reply (no timeout, agent=${expectedAgentId ?? 'any'})`);

  while (true) {
    if (await checkAborted()) {
      logger.info('SpinLoop', 'Spin aborted while waiting for sub-agent Reply');
      return null;
    }
    if (expectedAgentId) {
      // 等待子代理完全结束（consumer idle）后再取最终 Reply。
      // 这确保子代理若先发送进度/中间反馈、随后才发送最终结果时，
      // 不会把中间反馈误当成节点结论，也不会把多余 Reply 留给下一个节点。
      try {
        const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
        const record = subAgentRegistry.get(expectedAgentId);
        const agentFinished = !record || !record.engine.isConsumerRunning;
        if (agentFinished) {
          const reply = takeCurrentQueueReply();
          if (reply) return reply;
          if (persistedReply !== null) return persistedReply;
          // 子代理已结束但仍无 Reply 时，继续等待（与旧行为一致：无超时，
          // 避免把“缺失 Reply”误判为成功）。
        }
      } catch {
        // registry 不可用时退化为直接读队列
        const reply = takeCurrentQueueReply();
        if (reply) return reply;
        if (persistedReply !== null) return persistedReply;
      }
    } else {
      const reply = takeCurrentQueueReply();
      if (reply) return reply;
      if (persistedReply !== null) return persistedReply;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * 按顺序加载节点勾选的 Skill，并拼接为 Prompt 片段
 */
async function loadNodeSkillsPrompt(
  skillNames: string[] | undefined,
  cwd: string,
  sessionId: string,
): Promise<string> {
  if (!skillNames || skillNames.length === 0) return '';

  const skills = await getAllSkills(cwd);
  const parts: string[] = [];

  for (const name of skillNames) {
    const skill = skills.find(
      s => s.name === name || s.aliases?.includes(name),
    );
    if (!skill) {
      logger.warn('SpinLoop', `Skill '${name}' not found, skipping`);
      continue;
    }

    try {
      const blocks = await skill.getPromptForCommand('');
      const text = blocks
        .filter(b => b.type === 'text')
        .map(b => b.text as string)
        .join('\n');
      const finalContent = substituteBuiltinVariables(
        text,
        skill.skillRoot,
        sessionId,
      );
      parts.push(`### ${name}\n${finalContent}`);
    } catch (err) {
      logger.warn('SpinLoop', `Failed to load skill '${name}': ${err}`);
    }
  }

  return parts.join('\n\n');
}

/**
 * Spin Design 主循环
 */
export async function spinLoop(
  engine: QueryEngine,
  cwd: string,
  sessionId: string,
): Promise<void> {
  let currentNodeId: number | undefined;
  let attempts = 0;

  logger.info('SpinLoop', `Starting spin design loop`);

  /**
   * 刷新已打开的 Spin 设计器，让页面上的完成标记与磁盘上的 spin.json 同步。
   * 不刷新的话页面会一直停留在旧状态，直到整个 Spin 循环结束才更新
   * （用户看到的就是“结果不同步”）。刷新失败不影响主循环。
   */
  const refreshDesigner = async (): Promise<void> => {
    try {
      emitToUi({ type: 'spinDesignDataChanged' });
    } catch (err) {
      logger.warn('SpinLoop', `spinDesignDataChanged failed: ${err}`);
    }
  };

  while (true) {
    // 用户中止后立即停止主循环，不再读取/执行后续节点
    if (typeof (engine as any).isAborted === 'function' && (engine as any).isAborted()) {
      logger.info('SpinLoop', 'Spin aborted, stopping loop');
      break;
    }

    // 1. 读取 spin.json，获取下一个未完成的节点
    const config = await readSpinJson(cwd);
    if (!config) {
      // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
      const errorMsg = 'Cannot read spin.json: file is missing or invalid JSON.';
      logger.warn('SpinLoop', errorMsg);
      emitToUi({ type: 'message', sessionId, data: {
        role: 'user',
        content: errorMsg,
      } as MessageData });
      {
        const errorMsgObj: Message = {
          type: 'user',
          message: { role: 'user', content: errorMsg },
          uuid: `spin_error_${Date.now()}`,
          timestamp: Date.now(),
        };
        (engine as any).mutableMessages.push(errorMsgObj);
      }
      break;
    }

    const validationError = validateSpinDesign(config);
    if (validationError) {
      logger.warn('SpinLoop', `spin.json validation failed: ${validationError}`);
      emitToUi({ type: 'message', sessionId, data: {
        role: 'user',
        content: validationError,
      } as MessageData });
      {
        const errorMsgObj: Message = {
          type: 'user',
          message: { role: 'user', content: validationError },
          uuid: `spin_error_${Date.now()}`,
          timestamp: Date.now(),
        };
        (engine as any).mutableMessages.push(errorMsgObj);
      }
      break;
    }

    const next = getNextNode(config);
    if (!next) {
      logger.info('SpinLoop', 'All nodes completed');
      // 瞬时状态通知：只发 UI、不落盘（不 push mutableMessages）。
      // 文案键化，由 UI 翻译（`docs/core-ui-separation.md` 第 4.9 节）。
      emitToUi({
        type: 'notice',
        sessionId,
        key: CoreNoticeKeys.spinAllCompleted,
        params: {},
        level: 'info',
      });
      break;
    }

    // 获取拓扑序号
    const order = topologicalSort(config.nodes, config.edges);
    const currentSeq = order.indexOf(next.id) + 1;

    // 计算 For Each + rollout 迭代信息：
    // - For Each 优先级高于 rollout：每一行内先完成所有 rollout，再进入下一行
    // - 未配置 For Each 时按单行处理
    const rolloutCount = normalizeRolloutCount(next.rollout);
    const forEachVar = typeof next.forEach === 'string' ? next.forEach.trim() : '';
    const forEachRows = forEachVar ? splitForEachRows(config.variables?.[forEachVar]) : [''];
    const totalIterations = forEachRows.length * rolloutCount;
    const completedIterations = normalizeRolloutPassed(config.meta?.[String(next.id)]?.rolloutPassed);
    if (completedIterations >= totalIterations) {
      // 数据异常兜底；For Each 变量没有可遍历行时也直接完成该节点
      if (forEachVar && forEachRows.length === 0) {
        logger.warn('SpinLoop', `Task ${currentSeq}: For Each variable "${forEachVar}" has no rows, marking as passed`);
      }
      await updateNodeMeta(cwd, next.id, true, '', { rolloutPassed: totalIterations });
      // 兜底补齐 passed 也是一次完成状态变化，同样要同步到设计器页面
      await refreshDesigner();
      continue;
    }
    const currentRowIndex = Math.floor(completedIterations / rolloutCount);
    const rolloutId = completedIterations % rolloutCount;
    const currentRowValue = forEachRows[currentRowIndex] ?? '';
    const iterationLabel = (
      forEachRows.length > 1 && rolloutCount > 1
        ? ` [row ${currentRowIndex + 1}/${forEachRows.length}, rollout ${rolloutId + 1}/${rolloutCount}]`
        : forEachRows.length > 1
          ? ` [row ${currentRowIndex + 1}/${forEachRows.length}]`
          : rolloutCount > 1
            ? ` [rollout ${rolloutId + 1}/${rolloutCount}]`
            : ''
    );

    // 重置或递增尝试计数
    if (currentNodeId !== next.id) {
      currentNodeId = next.id;
      attempts = 0;
    }

    if (attempts >= MAX_ATTEMPTS) {
      logger.info('SpinLoop', `Task ${currentSeq}${iterationLabel} failed after ${MAX_ATTEMPTS} attempts, stopping spin mode`);
      // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
      const stopMsgContent =
        `Task ${currentSeq} failed after ${MAX_ATTEMPTS} attempts, stopping the entire Spin mode`;
      emitToUi({ type: 'message', sessionId, data: {
        role: 'user',
        content: stopMsgContent,
      } as MessageData });
      {
        const stopMsg: Message = {
          type: 'user',
          message: { role: 'user', content: stopMsgContent },
          uuid: `spin_stop_${Date.now()}`,
          timestamp: Date.now(),
        };
        (engine as any).mutableMessages.push(stopMsg);
      }
      await updateNodeMeta(cwd, next.id, false, `failed after ${MAX_ATTEMPTS} attempts`);
      break;
    }

    attempts++;

    // 获取之前的 note（如果有）；同一 rollout 失败重试时作为上一轮反馈
    const prevNote = config.meta?.[String(next.id)]?.note || undefined;
    // 依次加载该节点勾选的 Skill
    const skillsPrompt = await loadNodeSkillsPrompt(next.skills, cwd, sessionId);
    // 解析用户变量，并注入内置变量 ${ROLLOUT_ID}（每次 rollout 从 0 开始递增）；
    // For Each 生效时，用当前行覆盖被遍历的变量，使 ${变量名} 在任务中指向当前行
    const spinVariables: Record<string, string> = Object.assign(
      {},
      config.variables || {},
      { ROLLOUT_ID: String(rolloutId), LINE: forEachVar ? currentRowValue : '' },
    );
    if (forEachVar) spinVariables[forEachVar] = currentRowValue;
    const resolvedTask = substituteSpinVariables(next.task, spinVariables);
    // rollout > 1 或填写 For Each 时验收标准不可用：不注入 prompt，也不进行结果验收
    const useCriteria = rolloutCount <= 1 && !forEachVar;
    const resolvedCriteria = useCriteria
      ? (next.criteria || [])
          .map(ac => substituteSpinVariables(ac, spinVariables))
          .filter(ac => ac.trim() !== '')
      : [];
    // 没有验收条件时不会重试，因此不展示 [attempt/MAX_ATTEMPTS]
    const hasAcceptanceCriteria = resolvedCriteria.length > 0;
    const attemptPrefix = hasAcceptanceCriteria ? `[${attempts}/${MAX_ATTEMPTS}]` : '';
    const attemptSuffix = hasAcceptanceCriteria ? ` (${attempts}/${MAX_ATTEMPTS})` : '';
    const resolvedNode: SpinNode = { ...next, task: resolvedTask, criteria: resolvedCriteria };
    const nodePrompt = buildRunPrompt(resolvedNode, prevNote, skillsPrompt);

    logger.info('SpinLoop', `Executing Task ${currentSeq}${iterationLabel} - ${resolvedTask}${attemptSuffix}`);
    // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
    const startMsgContent =
      `${attemptPrefix}${iterationLabel} Starting: Task ${currentSeq} - ${resolvedTask}`;
    emitToUi({ type: 'message', sessionId, data: {
      role: 'user',
      content: startMsgContent,
    } as MessageData });
    {
      const startMsg: Message = {
        type: 'user',
        message: { role: 'user', content: startMsgContent },
        uuid: `spin_user_${Date.now()}`,
        timestamp: Date.now(),
      };
      (engine as any).mutableMessages.push(startMsg);
    }

    // 执行 Agent 工具
    // 先丢弃上一轮子代理遗留的未消费回复，避免旧 Reply 被当前节点误读。
    (engine as any).agentMessageQueue.length = 0;
    await engine.submitToolUse({
      name: 'Agent',
      input: {
        prompt: nodePrompt,
        agentRole: 'Master',
        description: `Task ${currentSeq}${iterationLabel} - ${resolvedTask}`,
      },
    });

    // 等待子 agent 的 Reply
    const currentAgentId = await getCurrentSpinAgentId(sessionId);
    const reply = await waitForAgentReply(engine, 1000, currentAgentId);
    if (reply === null) {
      logger.info('SpinLoop', 'Spin aborted by user, stopping loop');
      break;
    }

    // 判断是否通过；没有验收标准时直接通过，不调用 LLM 评审
    let accept: boolean;
    if (resolvedCriteria.length === 0) {
      logger.info('SpinLoop', `Task ${currentSeq}${iterationLabel} has no acceptance criteria, marking as passed`);
      accept = true;
    } else {
      // 先将 sub-agent 的 note 写入 meta（暂标记为未通过，等 LLM 判断）
      await updateNodeMeta(cwd, next.id, false, reply);
      const judgeResult = await SpinJudger.judge(
        resolvedTask,
        resolvedCriteria,
        reply,
      );
      accept = judgeResult.accept;
    }
    logger.info('SpinLoop', `Task ${currentSeq}${iterationLabel} accept judgment: ${accept}`);

    // 更新最终结果到 meta：
    // 只有最后一个迭代通过时才把节点标记为完成；中间的迭代通过后清空 note，
    // 避免把上一次成功反馈误当作下一次迭代的“上一轮反馈”。
    const nextCompleted = accept ? completedIterations + 1 : completedIterations;
    const nodePassed = accept && nextCompleted >= totalIterations;
    const metaNote = accept && !nodePassed ? '' : reply;
    await updateNodeMeta(cwd, next.id, nodePassed, metaNote, { rolloutPassed: nextCompleted });

    // 会落盘：文案一律英文，不走本地化（落盘文本统一英文）
    const resultMsgContent =
      `${attemptPrefix}${iterationLabel} ${accept ? 'Passed' : 'Failed'}: Task ${currentSeq} - ${resolvedTask}`;
    emitToUi({ type: 'message', sessionId, data: {
      role: 'user',
      content: resultMsgContent,
    } as MessageData });
    {
      const resultMsg: Message = {
        type: 'user',
        message: { role: 'user', content: resultMsgContent },
        uuid: `spin_result_${Date.now()}`,
        timestamp: Date.now(),
      };
      (engine as any).mutableMessages.push(resultMsg);
      // 立即持久化到磁盘/缓存，不依赖后续 submitToolUse 的遍历
      // 最后一个 Task 完成后不会再有下一次 submitToolUse，如果不持久化会丢失
      try {
        const { appendMessage } = await import('../history/Conversation.js');
        await appendMessage(resultMsg, sessionId, engine.getLastPersistedMessageUuid() ?? undefined);
      } catch {}
    }

    // 本节点已完成（spin.json 的 meta 已落盘）：立刻刷新设计器页面，
    // 不要等到整个循环结束才更新，否则执行过程中页面上的完成标记一直是旧的。
    if (nodePassed) {
      await refreshDesigner();
    }

    if (!accept) {
      continue; // 重试当前 rollout
    }

    attempts = 0;
  }

  logger.info('SpinLoop', 'Spin design loop finished');
}

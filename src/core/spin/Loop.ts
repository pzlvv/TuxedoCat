/**
 * SpinLoop - Spin Design 主循环
 *
 * 读取 spin.json，按拓扑序逐个执行未通过的节点，
 * 每个节点起子 agent 执行，完成后由 LLM 根据 note 判断是否通过。
 */

import { logger } from '../Logger.js';
import { tt } from '../i18n.js';
import type { QueryEngine } from '../QueryEngine.js';
import type { AssistantUI, MessageData } from '../AssistantUI.js';
import { getAllSkills } from '../skills/loadSkillsDir.js';
import { substituteBuiltinVariables } from '../skills/variableResolver.js';
import {
  readSpinJson,
  validateSpinDesign,
  getNextNode,
  topologicalSort,
  buildRunPrompt,
  substituteSpinVariables,
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
): Promise<string> {
  const queue = (engine as any).agentMessageQueue;
  const messages = engine.getMessages();

  /**
   * 只取当前子代理的回复，并清空整个队列。
   * 清空整列可以避免上一轮/同一子代理多余的 Reply 残留在队列中，
   * 干扰后续节点的 waitForAgentReply。
   */
  const takeCurrentQueueReply = (): string | null => {
    if (!queue || queue.length === 0) return null;
    const items = queue.filter((item: any) => !expectedAgentId || item.agentId === expectedAgentId);
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
  // 可能包含子 agent 的回复（agent_reply_* 或 silent=fromSubAgent 的 user 消息）。
  // 必须按 expectedAgentId 过滤，避免上一轮子代理的旧回复被当成当前节点结果。
  let persistedReply: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    // 查找 fromSubAgent 且 silent 的 user 消息（spin 模式下 agent reply 的标记）
    if (msg.type === 'user' && msg.fromSubAgent === true && msg.silent === true && typeof msg.message?.content === 'string') {
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
  ui: AssistantUI,
  sessionId: string,
): Promise<void> {
  let currentNodeId: number | undefined;
  let attempts = 0;

  logger.info('SpinLoop', `Starting spin design loop`);

  while (true) {
    // 1. 读取 spin.json，获取下一个未完成的节点
    const config = await readSpinJson(cwd);
    if (!config) {
      const errorMsg = tt(
        '无法读取 spin.json，文件不存在或 JSON 格式不正确。',
        'Cannot read spin.json: file is missing or invalid JSON.'
      );
      logger.warn('SpinLoop', errorMsg);
      ui.onMessage(sessionId, {
        role: 'user',
        content: errorMsg,
      } as MessageData);
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
      ui.onMessage(sessionId, {
        role: 'user',
        content: validationError,
      } as MessageData);
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
      ui.onMessage(sessionId, {
        role: 'system',
        content: tt('所有任务已完成！', 'All tasks completed!'),
      } as MessageData);
      break;
    }

    // 获取拓扑序号
    const order = topologicalSort(config.nodes, config.edges);
    const currentSeq = order.indexOf(next.id) + 1;

    // 2. 重置或递增尝试计数
    if (currentNodeId !== next.id) {
      currentNodeId = next.id;
      attempts = 0;
    }

    if (attempts >= MAX_ATTEMPTS) {
      logger.info('SpinLoop', `Task ${currentSeq} failed after ${MAX_ATTEMPTS} attempts, stopping spin mode`);
      const stopMsgContent = tt(
        `任务 ${currentSeq} 连续失败 ${MAX_ATTEMPTS} 次，已停止整个 Spin 模式执行`,
        `Task ${currentSeq} failed after ${MAX_ATTEMPTS} attempts, stopping the entire Spin mode`
      );
      ui.onMessage(sessionId, {
        role: 'user',
        content: stopMsgContent,
      } as MessageData);
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
    const attemptSuffix = ` (${attempts}/${MAX_ATTEMPTS})`;

    // 获取之前的 note（如果有）
    const prevNote = config.meta?.[String(next.id)]?.note || undefined;
    // 依次加载该节点勾选的 Skill
    const skillsPrompt = await loadNodeSkillsPrompt(next.skills, cwd, sessionId);
    // 解析用户定义的变量（$KEY -> value，$$ -> 字面量 $）
    const spinVariables = config.variables || {};
    const resolvedTask = substituteSpinVariables(next.task, spinVariables);
    const resolvedCriteria = (next.criteria || [])
      .map(ac => substituteSpinVariables(ac, spinVariables))
      .filter(ac => ac.trim() !== '');
    const resolvedNode: SpinNode = { ...next, task: resolvedTask, criteria: resolvedCriteria };
    const nodePrompt = buildRunPrompt(resolvedNode, prevNote, skillsPrompt);

    logger.info('SpinLoop', `Executing Task ${currentSeq} - ${resolvedTask}${attemptSuffix}`);
    const startMsgContent = tt(
      `[${attempts}/${MAX_ATTEMPTS}] 开始: 任务 ${currentSeq} - ${resolvedTask}`,
      `[${attempts}/${MAX_ATTEMPTS}] Starting: Task ${currentSeq} - ${resolvedTask}`
    );
    ui.onMessage(sessionId, {
      role: 'user',
      content: startMsgContent,
    } as MessageData);
    {
      const startMsg: Message = {
        type: 'user',
        message: { role: 'user', content: startMsgContent },
        uuid: `spin_user_${Date.now()}`,
        timestamp: Date.now(),
      };
      (engine as any).mutableMessages.push(startMsg);
    }

    // 3. 执行 Agent 工具
    // 先丢弃上一轮子代理遗留的未消费回复，避免旧 Reply 被当前节点误读。
    (engine as any).agentMessageQueue.length = 0;
    await engine.submitToolUse({
      name: 'Agent',
      input: {
        prompt: nodePrompt,
        agentRole: next.role || 'Master',
        description: `Task ${currentSeq} - ${resolvedTask}`,
      },
    });

    // 4. 等待子 agent 的 Reply
    const currentAgentId = await getCurrentSpinAgentId(sessionId);
    const reply = await waitForAgentReply(engine, 1000, currentAgentId);

    // 5. 判断是否通过；没有验收标准时直接通过，不调用 LLM 评审
    let accept: boolean;
    if (resolvedCriteria.length === 0) {
      logger.info('SpinLoop', `Task ${currentSeq} has no acceptance criteria, marking as passed`);
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
    logger.info('SpinLoop', `Task ${currentSeq} accept judgment: ${accept}`);

    // 更新最终结果到 meta
    await updateNodeMeta(cwd, next.id, accept, reply);

    const resultMsgContent = tt(
      `[${attempts}/${MAX_ATTEMPTS}] ${accept ? '通过' : '失败'}: 任务 ${currentSeq} - ${resolvedTask}`,
      `[${attempts}/${MAX_ATTEMPTS}] ${accept ? 'Passed' : 'Failed'}: Task ${currentSeq} - ${resolvedTask}`
    );
    ui.onMessage(sessionId, {
      role: 'user',
      content: resultMsgContent,
    } as MessageData);
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
        await appendMessage(resultMsg, sessionId, (engine as any).lastPersistedMessageUuid);
      } catch {}
    }

    if (!accept) {
      continue; // 重试当前节点
    }

    attempts = 0;
  }

  logger.info('SpinLoop', 'Spin design loop finished');
}

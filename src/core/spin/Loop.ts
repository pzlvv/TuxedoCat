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
  getNextNode,
  topologicalSort,
  buildRunPrompt,
  updateNodeMeta,
} from './Engine.js';
import { SpinJudger } from './SpinJudger.js';
import type { Message } from '../types.js';

const MAX_ATTEMPTS = 100;

async function waitForAgentReply(
  engine: QueryEngine,
  pollIntervalMs: number = 1000,
): Promise<string> {
  const queue = (engine as any).agentMessageQueue;

  // Step 1: 先在 mutableMessages 中查找从磁盘恢复的 agent reply
  // 恢复场景：spin 模式重启后，agentMessageQueue 为空，但已持久化的消息中
  // 可能包含子 agent 的回复（agent_reply_* 或 silent=fromSubAgent 的 user 消息）
  const messages = engine.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    // 查找 fromSubAgent 且 silent 的 user 消息（spin 模式下 agent reply 的标记）
    if (msg.type === 'user' && msg.fromSubAgent === true && msg.silent === true && typeof msg.message?.content === 'string') {
      const content = msg.message.content as string;
      logger.info('SpinLoop', `Found persisted agent reply in mutableMessages: "${content.substring(0, 100)}..."`);
      return content;
    }
  }

  // Step 2: 检查是否已有 agent 消息在队列中
  if (queue && queue.length > 0) {
    const contents = queue.map((item: any) => item.content);
    queue.length = 0;
    const combined = contents.join('\n\n----\n\n');
    logger.info('SpinLoop', `Found existing agent reply: "${combined}"`);
    return combined;
  }

  logger.info('SpinLoop', `Waiting for sub-agent Reply (no timeout)`);

  while (true) {
    if (queue && queue.length > 0) {
      const contents = queue.map((item: any) => item.content);
      queue.length = 0;
      const combined = contents.join('\n\n----\n\n');
      logger.info('SpinLoop', `Found sub-agent Reply: "${combined}"`);
      return combined;
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
      logger.info('SpinLoop', 'spin.json disappeared, stopping');
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
    const nodePrompt = buildRunPrompt(next, prevNote, skillsPrompt);

    logger.info('SpinLoop', `Executing Task ${currentSeq} - ${next.task}${attemptSuffix}`);
    const startMsgContent = tt(
      `开始: 任务 ${currentSeq} - ${next.task}（第 ${attempts} / ${MAX_ATTEMPTS}）`,
      `Starting: Task ${currentSeq} - ${next.task} (attempt ${attempts}/${MAX_ATTEMPTS})`
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
    await engine.submitToolUse({
      name: 'Agent',
      input: {
        prompt: nodePrompt,
        agentRole: next.role || 'Master',
        description: `Task ${currentSeq} - ${next.task}`,
      },
    });

    // 4. 等待子 agent 的 Reply
    const reply = await waitForAgentReply(engine);

    // 5. 将 sub-agent 的 note 写入 meta（暂标记为未通过，等 LLM 判断）
    await updateNodeMeta(cwd, next.id, false, reply);

    // 6. 使用 SpinJudger 判断是否通过
    const { accept } = await SpinJudger.judge(
      next.task,
      next.criteria,
      reply,
    );
    logger.info('SpinLoop', `Task ${currentSeq} accept judgment: ${accept}`);

    // 更新最终结果到 meta
    await updateNodeMeta(cwd, next.id, accept, reply);

    const resultMsgContent = tt(
      `${accept ? '通过' : '失败'}: 任务 ${currentSeq} - ${next.task}（第 ${attempts} / ${MAX_ATTEMPTS}）`,
      `${accept ? 'Passed' : 'Failed'}: Task ${currentSeq} - ${next.task} (attempt ${attempts}/${MAX_ATTEMPTS})`
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

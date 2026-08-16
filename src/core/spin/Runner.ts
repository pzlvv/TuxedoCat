/**
 * Spin Runner - 子任务执行器
 *
 * 负责通过创建子 Agent（Master 角色）来执行 spin.json 中的单个子任务。
 * 子 Agent 拥有完整的文件操作工具，独立对话环境。
 * 完成后通过 Reply 工具报告结果。
 */

import { QueryEngine } from '../QueryEngine.js';
import { getAllTools } from '../tools/index.js';
import { getToolsForRole } from '../tools/RoleTools.js';
import { getGlobalUI } from '../AssistantUI.js';
import type { SpinDesign, SpinNode } from './Types.js';
import { logger } from '../Logger.js';
import { generateCoreSystemPrompt } from '../prompt/SystemPrompt.js';

/**
 * 创建子 Agent 执行一个 story
 * @returns 子 Agent 的最后回复内容
 */
export async function createSubAgent(
  parentSessionId: string,
  prompt: string,
  config: SpinDesign,
  node: SpinNode,
): Promise<string> {
  const subSessionID = `spin-runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ui = getGlobalUI();
  if (!ui) throw new Error('UI not initialized');

  const abortController = new AbortController();

  const role = node.role || 'Master';
  // 根据角色获取工具集
  let tools;
  if (role === 'Master') {
    tools = getAllTools();
  } else {
    const toolNames = getToolsForRole(role);
    if (!toolNames) {
      tools = getAllTools();
    } else {
      tools = getAllTools().filter(t => toolNames.includes(t.name));
    }
  }

	  // 构建子 Agent 的系统提示词 = 主对话的核心系统提示 + Reply 指令
	  const subAgentSystemPrompt = generateCoreSystemPrompt() + `

## Communication
When you complete your task, use the **Reply** tool to send a JSON result to the conversation that created you.

The JSON format must be:
\`\`\`json
{"passes": true/false, "note": "brief summary of the result"}
\`\`\`

- \`passes\`: \`true\` for success, \`false\` for failure
- \`note\`: brief explanation of what was accomplished or why it failed
- Do not include any other text in the Reply message, only the JSON object without markdown formatting`;

  const taskMessage: any = {
    type: 'user',
    message: {
      role: 'user',
      content: prompt,
    },
    uuid: `user_${Date.now()}`,
    timestamp: Date.now(),
  };

  const subTitle = `[Spin] Node ${node.id}: ${node.task}`;

  // 创建子引擎
  const subEngine = new QueryEngine(subSessionID, {
    cwd: process.cwd(), // 子 Agent 的 cwd；由 VSCodeUI 确保子进程被调用时在工作区
    tools,
    role: role,
    getAppState: () => ({}),
    setAppState: () => {},
    ui: ui as any,
    abortController: abortController as any,
    initialMessages: [taskMessage],
    maxTurns: 1000,
    staticSystemPrompt: subAgentSystemPrompt,
    title: subTitle,
    parentSessionId,
  });

  // 注册
  const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
  subAgentRegistry.register(subSessionID, subEngine, null as any, parentSessionId);

  // ========== 持久化子会话元数据（meta.json）==========
  // 与 AgentTool 保持一致：写入 parentSessionId，使 spin 子代理对话在
  // 对话树中正确关联到主对话，进入子会话后能显示"返回主对话"按钮。
  try {
    const { createConversationMetadataSync } = await import('../history/Conversation.js');
    createConversationMetadataSync(subSessionID, subTitle, parentSessionId, role, undefined);
    logger.info('SpinRunner', `Pre-created conversation metadata for sub-agent ${subSessionID} (parent=${parentSessionId}, role=${role})`);
  } catch (err) {
    logger.warn('SpinRunner', `Failed to pre-create conversation metadata for sub-agent ${subSessionID}: ${err}`);
  }

  // 通知 UI 子代理开始
  ui.onQueryBegin(subSessionID);

  let result = '';

  try {
    logger.info('SpinRunner', `Sub-agent ${subSessionID} started for node ${node.id}`);
    const generator = subEngine.submitMessage(prompt);
    let res = await generator.next();
    while (!res.done) {
      res = await generator.next();
    }
    logger.info('SpinRunner', `Sub-agent ${subSessionID} completed`);

    // 从子引擎消息中提取最后的 Reply
    const subMessages = subEngine.getMessages();
    for (let i = subMessages.length - 1; i >= 0; i--) {
      const msg = subMessages[i];
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'tool_use' && (block as any).name === 'Reply') {
            result = (block as any).input?.message || '';
            break;
          }
        }
      }
      if (result) break;
    }
  } catch (err) {
    logger.error('SpinRunner', `Sub-agent ${subSessionID} error: ${err}`);
    result = `Error: ${err}`;
  } finally {
    ui.onQueryEnd(subSessionID);
  }

  return result;
}



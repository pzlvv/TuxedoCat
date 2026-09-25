/**
 * Spin Runner - 子任务执行器
 *
 * 负责通过创建子 Agent（Master 角色）来执行 spin.json 中的单个子任务。
 * 子 Agent 拥有完整的文件操作工具，独立对话环境。
 * 完成后通过 Reply 工具报告结果。
 */

import { QueryEngine, getSessionEngine } from '../QueryEngine.js';
import { getProjectRoot, setSessionWorkspace } from '../history/Config.js';
import { getAllTools } from '../tools/index.js';
import type { CoreEvent } from '../AssistantEventBus.js';
import { requireEventBus } from '../AssistantEventBus.js';
import type { SpinDesign, SpinNode } from './Types.js';
import { logger } from '../Logger.js';
import { generateCoreSystemPrompt } from '../prompt/SystemPrompt.js';

/** core → UI 单向事件的发送侧封装（SpinRunner 统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

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

  const abortController = new AbortController();

  // Spin Design 节点统一使用 Master 角色（完整工具集）
  const role = 'Master';
  const tools = getAllTools();

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

  // 继承父会话（query engine）实际生效的模型配置，避免子代理 fallback 到其他模型
  const parentEngine = getSessionEngine(parentSessionId);
  const modelConfig = parentEngine?.getEffectiveModelConfig();

  // 子 Agent 继承父会话的工作目录，不要用 process.cwd()（那是宿主进程启动目录）
  const subCwd = parentEngine?.getCwd() ?? getProjectRoot(parentSessionId);

  // 子代理归属父会话的工作目录：登记后，子代理的历史读写 / 工具结果等按会话解析
  // 工作目录时与父会话一致，不再回退到「当时的活动工作目录」
  // （与 AgentTool 同一口径；否则多工作目录下子对话会写到别的目录）
  setSessionWorkspace(subSessionID, subCwd);

  // 创建子引擎
  const subEngine = new QueryEngine(subSessionID, {
    cwd: subCwd,
    tools,
    role: role,
    getAppState: () => ({}),
    setAppState: () => {},
    abortController: abortController as any,
    initialMessages: [taskMessage],
    maxTurns: Number.MAX_SAFE_INTEGER,
    modelConfig,
    staticSystemPrompt: subAgentSystemPrompt,
    title: subTitle,
    parentSessionId,
  });

  // 继承父会话的模型身份（provider + model；meta.json 也要记录）
  const parentModelRef = parentEngine?.modelRefOverride;
  if (parentModelRef) {
    subEngine.modelRefOverride = parentModelRef;
  }

  // 注册
  const { subAgentRegistry } = await import('../tools/agent/SubAgentRegistry.js');
  subAgentRegistry.register(subSessionID, subEngine, null as any, parentSessionId);

  // ========== 持久化子会话元数据（meta.json）==========
  // 与 AgentTool 保持一致：写入 parentSessionId，使 spin 子代理对话在
  // 对话树中正确关联到主对话，进入子会话后能显示"返回主对话"按钮。
  try {
    const { createConversationMetadataSync } = await import('../history/Conversation.js');
    createConversationMetadataSync(subSessionID, subTitle, parentSessionId, role, parentModelRef);
    logger.info('SpinRunner', `Pre-created conversation metadata for sub-agent ${subSessionID} (parent=${parentSessionId}, role=${role}, model=${modelConfig?.model ?? 'inherit'})`);
  } catch (err) {
    logger.warn('SpinRunner', `Failed to pre-create conversation metadata for sub-agent ${subSessionID}: ${err}`);
  }

  // 通知 UI 子代理开始
  emitToUi({ type: 'queryBegin', sessionId: subSessionID });

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
    emitToUi({ type: 'queryEnd', sessionId: subSessionID });
  }

  return result;
}



/**
 * AgentTool 工具实现
 * 子代理工具 - 委托复杂任务给专用子代理
 *
 * 工作原理：
 * 1. 接收用户的任务描述（prompt）和可选的 agentRole
 * 2. 创建一个独立的子会话 session（有自己的 meta.json 和 .jsonl）
 * 3. 子会话标题格式: "[sub] <Task描述> - <父session标题>"
 * 4. 通过 QueryEngine 执行完整查询生命周期（多轮对话、auto-compact 等）
 * 5. 子代理工具受限（通过 availableTools 控制）
 * 6. 收集输出并返回给主会话
 * 7. 子会话会出现在历史对话面板中，可供查看
 */

import { z } from 'zod';
import type { ToolUseContext, ToolResult, PermissionResult } from '../Tool.js';
import { buildTool } from '../Tool.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';
import { generateCoreSystemPrompt } from '../../prompt/SystemPrompt.js';
import { getAvailableCommands } from '../../prompt/SystemEnvironment.js';
import type { AgentToolInput, AgentToolOutput } from './Types.js';
import { inputSchema, outputSchema } from './Types.js';
import { logger } from '../../Logger.js';
import { subAgentRegistry } from './SubAgentRegistry.js';

/**
 * 检查子代理引擎的消息中，在最后一个"真正的用户输入"之后是否有 Reply 工具调用。
 * 
 * 用于判断 Reminder 是否生效。
 * 
 * 查找策略：从后往前找到最后一个符合以下条件的 user 消息作为基准：
 *   1. 非 silent（排除 Reminder 消息）
 *   2. message.content 为字符串（排除 tool_result 消息，其 content 为数组）
 * 这样可以确保找到的是原始用户输入，避免被工具结果或隐式消息干扰。
 */
function checkSubAgentHasReply(engine: any): boolean {
  const messages = engine.getMessages();

  // 从后往前找最后一个"真正的用户输入"消息
  let latestUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg.type === 'user'
      && !(msg as any).silent
      && typeof msg.message?.content === 'string'
    ) {
      latestUserIdx = i;
      break;
    }
  }
  if (latestUserIdx < 0) return false;

  // 在基准消息之后查找 Reply tool_use
  for (let i = latestUserIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if ((block as any).type === 'tool_use' && (block as any).name === 'Reply') {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 根据重试次数构建 Reminder 内容，每次递增提示粒度，逐步引导 agent 正确使用 tool call。
 * 注意：agent 未回复通常是误解了指令（生成了文本而非 tool_use），而非有意不听话，
 * 因此避免催促/威胁语气，改为递进式引导。
 */
function buildReminderContent(retry: number, creatorSessionId?: string): string {
  // 基础提示：所有轮次都保留
  const baseLines = [
    'You have completed your processing but have not yet sent a reply using the Reply tool.',
    '',
    'You need to generate a tool call (a "tool_use" block) with the name "Reply" to send your results back.',
    creatorSessionId ? `When calling the Reply tool, set targetSessionId to "${creatorSessionId}" to ensure the reply reaches the correct session.` : '',
  ].filter(Boolean);

  // 逐轮递增的引导信息
  const guidanceByRetry: Record<number, string[]> = {
    1: [
      'No `Reply` tool_use detected in parent, did you generate `reply` tool call?'
    ],
    2: [
      'Make sure the tool_use block is in your response, NOT as plain text.',
    ],
    3: [
      'You only generated text, which means the parent cannot see it. The system requires you to use a specific format to invoke tools for proper processing. Please try using the correct tool call format without any JSON markers.',
    ],
  };

  const lines = [
    '<Reminder>',
    ...baseLines,
    '',
    ...(guidanceByRetry[retry] ?? guidanceByRetry[3]),
    '</Reminder>',
  ];

  return lines.join('\n');
}

export const AgentTool = buildTool({
  name: TOOL_NAME,
  aliases: ['subagent', 'delegate'],
  searchHint: 'delegate work to a sub-agent',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema() {
    return inputSchema as z.ZodType<AgentToolInput>;
  },

  get outputSchema() {
    return outputSchema as z.ZodType<AgentToolOutput>;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return getPrompt();
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    return false;
  },

  userFacingName(input?: AgentToolInput) {
    if (input?.agentRole) {
      return `Agent(${input.agentRole})`;
    }
    return 'Agent';
  },

  getToolUseSummary(input?: AgentToolInput) {
    const role = input?.agentRole ? ` (${input.agentRole})` : '';
    return input?.prompt ? `Agent${role}: "${input.prompt.substring(0, 60)}${input.prompt.length > 60 ? '...' : ''}"` : null;
  },

  getActivityDescription(input?: AgentToolInput) {
    const role = input?.agentRole ? ` [${input.agentRole}]` : '';
    return `Running sub-agent${role}`;
  },

  async checkPermissions(
    input: AgentToolInput,
    context: ToolUseContext,
  ): Promise<PermissionResult> {
    // 基础参数校验：确保 prompt 和 agentRole 不为空
    const { prompt, agentRole } = input;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return {
        behavior: 'deny',
        message: 'Agent 工具需要提供任务描述(prompt)。',
        shouldTerminate: false,
      };
    }
    if (!agentRole) {
      return {
        behavior: 'deny',
        message: '需要指定 agentRole 参数。支持的角色: Master。',
        shouldTerminate: false,
      };
    }

    // 禁止嵌套调用：AgentTool 不允许在子代理中调用（即 sessionId 以 "sub_" 开头表示已经是一个子代理）
    if (context.sessionId && context.sessionId.startsWith('sub_')) {
      return {
        behavior: 'deny',
        message: `The Agent tool does not support nested calls within sub-agents. The current session "${context.sessionId}" is already a sub-agent and cannot create new sub-agents. Please complete the task directly within the current sub-agent.`,
        shouldTerminate: true,
      };
    }

    // Master 角色无需额外检查
    logger.info('AgentTool', `Master agent role accepted, skipping role-specific checks`);

    return { behavior: 'ask' };
  },
  async call(
    input: AgentToolInput,
    context: ToolUseContext,
  ): Promise<ToolResult<AgentToolOutput>> {
    const { prompt, agentRole } = input;
    const agentDesc = input.description || (agentRole ? `Agent: ${agentRole}` : 'Sub-agent task');

    if (!prompt || typeof prompt !== 'string') {
      throw new Error('prompt is required and must be a string');
    }

    // 验证 agentRole 必须为合法角色
    const { isValidRole } = await import('../RoleTools.js');
    if (!agentRole || !isValidRole(agentRole)) {
      throw new Error(`agentRole is required and must be: Master. Got: ${agentRole}`);
    }

    logger.info('AgentTool', `Creating sub-agent [role: ${agentRole}]: ${agentDesc}`);

    // ========== 获取系统环境信息（通用，所有角色都需要） ==========

    let environmentInfoSection = '';
    try {
      const availableCommands = await getAvailableCommands() || [];
      if (availableCommands.length > 0) {
        // 构建 Operating System、Shell 和 CWD 信息
        const { default: os } = await import('os');
        const platform = os.platform();
        const osType = os.type();
        const osRelease = os.release();
        const shell = process.env.SHELL || process.env.ComSpec || 'unknown';
        const cwd = process.cwd();

        environmentInfoSection = `
	## Environment
	You are running in the following environment:
	- **Operating System**: ${platform} (${osType} ${osRelease})
	- **Shell**: ${shell}
	- **Working Directory**: ${cwd}
	- **Git Repository**: Yes (branch: unknown)

	**Available Commands**:
	- ${availableCommands.join(', ')}

	`;
        logger.info('AgentTool', `Environment info: ${availableCommands.length} commands detected`);
      }
    } catch (e) {
      logger.warn('AgentTool', `Failed to detect environment commands: ${e}`);
    }

    // ========== 1. 创建子会话 session ==========

    const subSessionID = `sub_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // 获取创建会话 ID
    const creatorSessionId: string = context.sessionId!;

    // 在环境信息中注入 parent session ID
    if (environmentInfoSection) {
      environmentInfoSection += `\n## Parent Session\nThe creator session ID is: ${creatorSessionId}. When calling the Reply tool, set targetSessionId to this value.\n`;
    }

    const subTitle = agentDesc;

    // 任务消息，作为 initialMessages 传入 QueryEngine，由 QueryEngine.submitMessage() 完成持久化
    const taskMessage = {
      type: 'user',
      message: { role: 'user', content: prompt },
      uuid: `subtask_${Date.now()}`,
      timestamp: Date.now(),
    };

    // ========== 2. 获取 UI 实例 ==========

    const { getGlobalUI } = await import('../../AssistantUI.js');
    const ui = getGlobalUI();

    // ========== 3. 创建 QueryEngine  ==========

    const { QueryEngine, getSessionEngine } = await import('../../QueryEngine.js');

    // 创建新的 AbortController（链接到父 abortController）
    const parentSignal = (context.abortController as any)?.signal as AbortSignal | undefined;
    const abortController = new AbortController();

    if (parentSignal) {
      if (parentSignal.aborted) {
        // 父会话在子代理创建前已被中止：立即同步中止子代理，
        // 避免 addEventListener 对已 abort 的 signal 不触发导致子代理继续运行。
        abortController.abort();
      } else {
        parentSignal.addEventListener('abort', () => {
          abortController.abort();
        }, { once: true });
      }
    }

    // 从主会话继承 thinking effort
    // 优先从 context 获取（如果 ToolUseContext 提供了），否则从主会话引擎读取
    let parentThinkingEffort = (context as any).thinkingEffort;
    if (!parentThinkingEffort) {
      try {
        const { getSessionThinkingMode } = await import('../../Integration.js');
        parentThinkingEffort = getSessionThinkingMode(creatorSessionId);
      } catch (e) {
        logger.error('AgentTool', `获取主会话 thinking mode 失败: ${e}`);
      }
    }
    // 如果主会话没有设置 thinking，回退到默认 thinking effort（与主会话新建对话时的默认值一致）
    if (!parentThinkingEffort) {
      const { getDefaultThinkingEffort } = await import('../../llm/config.js');
      parentThinkingEffort = await getDefaultThinkingEffort();
    }

    // 生成子代理身份说明 prompt（作为 staticSystemPrompt 替换默认的核心身份）
    // 注意：只包含核心身份 + Communication 段，不包含工具描述和系统环境信息，
    // 因为这些由 QueryEngine.messageConsumer() 内部自动生成并拼接。
    const subAgentSystemPrompt = `${generateCoreSystemPrompt()}

## Communication
You are a sub-agent created by the main conversation. When you complete your task (or need to provide progress updates), use the **Reply** tool to send a message back to the conversation that created you.

Important guidelines:
- Work autonomously and complete the assigned task
- Keep the conversation that created you informed of your progress
- When done, send a clear summary of what you accomplished using the Reply tool
- When calling the Reply tool, set \`targetSessionId\` to \`${creatorSessionId}\` to ensure the reply reaches the correct session`;

    // [SystemPromptDump] 打印子代理的完整 system prompt
    logger.info('[SystemPromptDump]', `=== SUBAGENT SYSTEM PROMPT START (role=${agentRole}, session=${subSessionID}, chars=${subAgentSystemPrompt.length}) ===`);
    logger.info('[SystemPromptDump]', subAgentSystemPrompt);
    logger.info('[SystemPromptDump]', `=== SUBAGENT SYSTEM PROMPT END (role=${agentRole}, session=${subSessionID}) ===`);

    // 继承父会话（query engine）实际生效的模型配置，避免子代理重新读取全局配置而 fallback 到其他模型
    const parentEngine = getSessionEngine(creatorSessionId);
    const modelConfig = parentEngine?.getEffectiveModelConfig();
    logger.info('AgentTool', `Model config for role=${agentRole}: ${modelConfig ? `model=${modelConfig.model}` : 'inherited from parent (no explicit model config, will use same fallback as parent)'}`);

    // 创建子代理的 QueryEngine
    const subEngine = new QueryEngine(subSessionID, {
      cwd: process.cwd(),
      tools: [],
      role: agentRole || undefined,
      getAppState: () => context.getAppState(),
      setAppState: (updater: (prev: unknown) => unknown) => {
        context.setAppState(updater);
      },
      ui: ui as any,
      abortController: abortController as any,
      initialMessages: [taskMessage as any],
      maxTurns: Number.MAX_SAFE_INTEGER,
      modelConfig,
      staticSystemPrompt: subAgentSystemPrompt,
      title: subTitle,
      parentSessionId: creatorSessionId,
    });

    // 继承父对话的 thinking effort
    subEngine.thinkingModeOverride = parentThinkingEffort;

    // ========== 持久化子会话元数据（meta.json）==========
    // 子代理会话必须把 parentSessionId（关联主对话）、role、model 写入 meta.json，
    // 否则对话列表/树形结构无法正确关联到主对话，
    // 且点击进入子会话后 webview 拿不到 parentSessionId，不会显示"返回主对话"按钮。
    // createConversationMetadataSync 在文件不存在时同步创建（messageCount=0），
    // 之后第一条消息持久化（appendMessage -> updateMetadataForNewMessage）会读取
    // 现有 meta.json 并保留这些字段，仅递增 messageCount 和更新标题。
    try {
      const { createConversationMetadataSync } = await import('../../history/Conversation.js');
      createConversationMetadataSync(subSessionID, subTitle, creatorSessionId, agentRole, modelConfig?.model);
      logger.info('AgentTool', `Pre-created conversation metadata for sub-agent ${subSessionID} (parent=${creatorSessionId}, role=${agentRole}, model=${modelConfig?.model ?? 'inherit'})`);
    } catch (err) {
      logger.warn('AgentTool', `Failed to pre-create conversation metadata for sub-agent ${subSessionID}: ${err}`);
    }

    // 注册到全局注册表
    subAgentRegistry.register(subSessionID, subEngine, context, creatorSessionId);

    // 继承父会话的 agent mode
    if (ui && typeof (ui as any).onSetAgentMode === 'function') {
      (ui as any).onSetAgentMode(creatorSessionId, subSessionID);
    }

    // 在后台启动子代理处理初始消息（不阻塞）
    (async () => {
      logger.info('AgentTool', `Sub-agent ${subSessionID} started in background`);
      // 通知 UI 子代理开始查询（使 abort 按钮可用）
      if (ui) {
        logger.info('AgentTool', `Calling ui.onQueryBegin for sub-agent ${subSessionID}`);
        ui.onQueryBegin(subSessionID);
      }
      try {
        const generator = subEngine.submitMessage(prompt);
        let result = await generator.next();
        while (!result.done) {
          result = await generator.next();
        }
        logger.info('AgentTool', `Sub-agent ${subSessionID} completed background processing`);

        // ========== 等待消息消费者完全 idle ==========
        // subEngine.submitMessage() 的 generator 消耗完毕只表示消息已入队，
        // 但底层的 messageConsumer 可能仍在处理 LLM 调用和 tool 执行。
        // 必须等 isConsumerRunning=false 后才能确认所有 tool 调用已完成，
        // 此时再去检查是否有 Reply，才能避免竞态条件。
        logger.info('AgentTool', `Sub-agent ${subSessionID} waiting for consumer idle`);
        await subEngine.waitForIdle();
        logger.info('AgentTool', `Sub-agent ${subSessionID} consumer is idle`);

        // ========== 检查是否已取消（用户中止） ==========
        // 如果是用户中止，跳过 Reply 检查和 Reminder 重试，不再打扰子代理
        if (abortController.signal.aborted) {
          logger.info('AgentTool', `Sub-agent ${subSessionID} was aborted by user, skipping Reply check and Reminder`);
          // 不再在此调用 onQueryEnd：finally 块已统一负责，避免同一 sub-session 触发两次 queryEnd
          return;
        }

        // ========== 检查子代理最近是否有 Reply ==========
        // 遍历子引擎的 messages，找最近的 assistant 消息，
        // 检查其中是否有 Reply 工具调用
        const subMessages = subEngine.getMessages();
        let latestUserIdx = -1;
        for (let i = subMessages.length - 1; i >= 0; i--) {
          if (subMessages[i].type === 'user') {
            latestUserIdx = i;
            break;
          }
        }

        let hasReplyAfterLatestUser = false;
        if (latestUserIdx >= 0) {
          // 从最近的 UserMessage 之后查找 Reply tool_use
          for (let i = latestUserIdx + 1; i < subMessages.length; i++) {
            const msg = subMessages[i];
            if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
              for (const block of msg.message.content) {
                if ((block as any).type === 'tool_use' && (block as any).name === 'Reply') {
                  hasReplyAfterLatestUser = true;
                  break;
                }
              }
              if (hasReplyAfterLatestUser) break;
            }
          }
        }

        if (!hasReplyAfterLatestUser) {
          logger.info('AgentTool', `Sub-agent ${subSessionID} has no Reply after last UserMessage, starting Reminder retry loop`);

          // ========== Reminder 重试循环 ==========
          // 如果 LLM 误解了 Reminder（例如输出文本而非 Reply tool_use），
          // 发送 Reminder 后再次检查，最多重试 MAX_RETRIES 次。
          const MAX_REMINDER_RETRIES = 3;
          const RETRY_DELAY_MS = 1500; // 每次重试之间的等待时间

          for (let retry = 1; retry <= MAX_REMINDER_RETRIES; retry++) {
            // 检查是否已被用户中止。如果 abortController 已被 abort，
            // 立即停止 Reminder 重试，不再发送新的 LLM 请求。
            if (abortController.signal.aborted) {
              logger.info('AgentTool', `Sub-agent ${subSessionID} was aborted during Reminder retry loop, stopping`);
              break;
            }

            // 先检查是否已有 Reply（可能在上一次 Reminder 处理过程中被调用）
            if (checkSubAgentHasReply(subEngine)) {
              logger.info('AgentTool', `Sub-agent ${subSessionID} has Reply after reminder (retry=${retry}), done`);
              break;
            }

            logger.info('AgentTool', `Sub-agent ${subSessionID} Reminder attempt ${retry}/${MAX_REMINDER_RETRIES}`);

            // 构建 Reminder 内容：措辞随重试次数逐渐加强
            const reminderContent = buildReminderContent(retry, creatorSessionId);

            logger.info('[ReminderDebug]', `AgentTool: calling subEngine.submitMessage(reminder) attempt ${retry}` +
              ` | reminderContent.length=${reminderContent.length}`);

            const reminderGenerator = subEngine.submitMessage(reminderContent, 'reminder');
            let reminderConsumerStarted = false;
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _unused of reminderGenerator) {
              if (!reminderConsumerStarted) {
                reminderConsumerStarted = true;
                logger.info('[ReminderDebug]', `AgentTool: reminder generator started yielding (attempt ${retry})`);
              }
            }

            logger.info('[ReminderDebug]', `AgentTool: reminder generator fully consumed (attempt ${retry})` +
              ` | isConsumerRunning=${subEngine.isConsumerRunning}` +
              ` | pendingReminder=${subEngine['pendingReminder'] !== null}`);

            // 等待一小段时间，让子代理有机会处理 Reminder 的响应
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));

            // 检查是否有新的 assistant 消息包含 Reply tool_use
            if (checkSubAgentHasReply(subEngine)) {
              logger.info('AgentTool', `Sub-agent ${subSessionID} has Reply after Reminder attempt ${retry}`);
              break;
            }

            logger.info('AgentTool', `Sub-agent ${subSessionID} still no Reply after Reminder attempt ${retry}`);

            // 最后一次重试仍无 Reply，记录警告
            if (retry === MAX_REMINDER_RETRIES) {
              logger.warn('AgentTool', `Sub-agent ${subSessionID} failed to call Reply after ${MAX_REMINDER_RETRIES} Reminders`);
            }
          }
        }
      } catch (err) {
        logger.error('AgentTool', `Sub-agent ${subSessionID} background error: ${err}`);
      } finally {
        if (ui) {
          logger.info('AgentTool', `Calling ui.onQueryEnd for sub-agent ${subSessionID}`);
          ui.onQueryEnd(subSessionID);
        }
        // 刷新对话列表：此时子代理的消息已持久化（messageCount >= 1），
        // 确保新子会话能在对话树中正确显示并关联到主对话。
        if (ui && typeof (ui as any).refreshConversationList === 'function') {
          (ui as any).refreshConversationList();
        }
      }
    })();

    // ========== 4. 立即返回子代理 ID ==========

    logger.info('AgentTool', `Sub-agent created: ${subSessionID} (${agentDesc})`);

    // 通知 UI 刷新对话列表（尽早刷新一次；若此时首条消息尚未落盘导致列表未包含
    // 子会话，后台任务 finally 中的刷新会兜底确保最终可见）
    if (ui && typeof (ui as any).refreshConversationList === 'function') {
      (ui as any).refreshConversationList();
    }

    return {
      data: {
        summary: `Sub-agent created with ID: ${subSessionID}. Task: ${agentDesc}`,
        subAgentId: subSessionID,
        role: agentRole,
        messageCount: 0,
        exitCode: 0,
      },
    };
  },

  mapToolResultToToolResultBlockParam(
    data: AgentToolOutput,
    toolUseID: string,
  ) {
    const { exitCode, summary, role, subAgentId } = data;
    const success = exitCode === 0;

    const statusEmoji = success ? '✓' : '✗';
    const roleInfo = role ? ` [${role}]` : '';
    const header = `${statusEmoji} Agent${roleInfo} ${success ? 'created' : 'failed'}`;

    let content = `${header}\n\n${summary}`;

    if (subAgentId) {
      content += `\n\n**Sub-agent ID**: \`${subAgentId}\``;
      content += `\nThe sub-agent will reply directly when done.`;
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      exit_code: exitCode ?? (success ? 0 : -1),
    };
  },
});

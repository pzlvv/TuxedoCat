/**
 * ReplyTool - 代理间消息通信工具
 *
 * 用于在代理之间发送消息，支持双向通信：
 * - 子代理回复消息给创建它的代理（默认行为）
 * - 代理主动发送消息给指定会话的代理
 */

import { z } from 'zod';
import type { ToolUseContext, ToolResult } from '../Tool.js';
import { buildTool } from '../Tool.js';
import { logger } from '../../Logger.js';

export const TOOL_NAME = 'Reply';

const inputSchema = z.strictObject({
  message: z.string().describe('The reply message to send back'),
  targetSessionId: z.string().optional().describe('Target session ID to send the message to. If omitted, sends to the session that created this agent.'),
});

const outputSchema = z.object({
  success: z.boolean().describe('Whether the reply was sent successfully'),
  exitCode: z.number().optional().describe('Exit code (0 success, non-zero failure)'),
  error: z.string().optional().describe('Error message if the reply failed'),
});

type ReplyInput = z.infer<typeof inputSchema>;
type ReplyOutput = z.infer<typeof outputSchema>;

const DESCRIPTION = `Send a message to a target session.`;

export const ReplyTool = buildTool({
  name: TOOL_NAME,
  aliases: ['agent-reply'],
  searchHint: 'send a reply message to a target session',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema() {
    return inputSchema as z.ZodType<ReplyInput>;
  },

  get outputSchema() {
    return outputSchema as z.ZodType<ReplyOutput>;
  },

  async description() {
    return DESCRIPTION;
  },

  async prompt() {
    return `## Reply Tool

Sends a message to a target session.

**Available to sub-agents** to communicate results, progress, or responses back to the session that created them.

**Parameters:**
- \`message\` (string, required): The reply content to send
- \`targetSessionId\` (string, optional): Target session to receive the message. Defaults to the session that created this agent.

**Usage:**
- After completing your assigned task, use Reply to send the result
- Use Reply to provide progress updates during long-running tasks
- The target session will receive your reply as a message`;
  },

  isConcurrencySafe() {
    return true;
  },

  isReadOnly() {
    return true;
  },

  userFacingName() {
    return 'Reply';
  },

  getToolUseSummary(input?: ReplyInput) {
    if (!input?.message) return null;
    let target = '';
    if (input.targetSessionId) {
      target = ` -> ${input.targetSessionId.substring(0, 20)}`;
    }
    return `Reply${target}: "${input.message.substring(0, 60)}${input.message.length > 60 ? '...' : ''}"`;
  },

  getActivityDescription() {
    return 'Sending reply to target session';
  },

  async call(
    input: ReplyInput,
    context: ToolUseContext,
  ): Promise<ToolResult<ReplyOutput>> {
    const { message, targetSessionId } = input;
    const subAgentId = (context as any).sessionId;

    logger.info('[ReplyToolDebug]', `call() invoked. subAgentId=${subAgentId}, targetSessionId=${targetSessionId}, message.length=${message?.length}`);

    if (!message || typeof message !== 'string') {
      const errMsg = 'Reply 工具需要提供一个有效的 message 字符串参数';
      logger.info('[ReplyToolDebug]', `call() returning early: invalid message. message=${typeof message}`);
      return {
        data: { success: false, exitCode: -1, error: errMsg },
      };
    }

    // 确定目标会话 ID
    let targetId: string;

    const { subAgentRegistry } = await import('./SubAgentRegistry.js');

    if (targetSessionId && targetSessionId !== 'current_session') {
      // 显式指定了目标会话（排除 'current_session' 占位符）
      targetId = targetSessionId;
      logger.info('[ReplyToolDebug]', `Using explicit targetSessionId: ${targetId}`);
    } else {
      logger.info('[ReplyToolDebug]', `targetSessionId="${targetSessionId}", falling back to creator session`);
      // 默认行为：子代理回复给创建者
      if (!subAgentId) {
        const errMsg = '当前 session 未设置 sessionId，且未指定 targetSessionId。请提供 targetSessionId 或确认当前会话有正确的 sessionId';
        logger.warn('[ReplyToolDebug]', 'No sessionId found in context and no targetSessionId specified');
        return {
          data: { success: false, exitCode: -1, error: errMsg },
        };
      }

      const record = subAgentRegistry.get(subAgentId);
      if (!record) {
        // 不在 subAgentRegistry 中，尝试读取 engine 的 upstreamSessionId（发起方会话 ID）
        const { getSessionEngine } = await import('../../QueryEngine.js');
        const engine = getSessionEngine(subAgentId);
        const upsId = engine ? (engine as any).upstreamSessionId : undefined;
        if (engine && upsId) {
          targetId = upsId;
          logger.info('[ReplyToolDebug]', `Sub-agent ${subAgentId} not found, using upstreamSessionId: ${targetId}`);
        } else {
          const errMsg = `当前会话 ${subAgentId} 不是子代理且没有上游会话（upstreamSessionId），请通过 targetSessionId 显式指定回复目标`;
          logger.warn('[ReplyToolDebug]', errMsg);
          return {
            data: { success: false, exitCode: -1, error: errMsg },
          };
        }
      } else {
        targetId = record.creatorSessionId;
        logger.info('[ReplyToolDebug]', `Using creatorSessionId from registry: ${targetId}`);
      }
    }

    // 通过 submitMessage(type='agent') 将消息投递到目标引擎
    try {
      const { getSessionEngine } = await import('../../QueryEngine.js');
      const targetEngine = getSessionEngine(targetId);

      if (!targetEngine) {
        const errorMsg = `目标会话 ${targetId} 不存在。如果回复给创建者，请不要设置 targetSessionId 参数，默认会回复到创建者会话。当前 subAgentId=${subAgentId}`;
        logger.warn('[ReplyToolDebug]', `Target engine not found for session ${targetId}`);
        return {
          data: { success: false, exitCode: -1, error: errorMsg },
        };
      }

      const generator = targetEngine.submitMessage(message, 'agent', subAgentId);

      logger.info('[ReplyToolDebug]', `submitMessage returned, isConsumerRunning=${targetEngine.isConsumerRunning}`);

      // 在后台异步消费 generator (不阻塞 Reply 返回)
      (async () => {
        try {
          logger.info('[ReplyToolDebug]', 'Background consumer started');
          let yieldCount = 0;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _unused of generator) {
            yieldCount++;
          }
          logger.info('[ReplyToolDebug]', `Background consumer finished, total yields=${yieldCount}`);
        } catch (err) {
          logger.warn('[ReplyToolDebug]', `Background consumer error: ${err}`);
        }
      })();

      logger.info('[ReplyToolDebug]', `Returning success. targetId=${targetId}, message.length=${message.length}`);

      return {
        data: { stdout: message || 'Reply sent to target session.', exitCode: 0, success: true, message } as any,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[ReplyToolDebug]', `Failed to post reply to target: ${errorMessage}`);
      return {
        data: { stdout: '', exitCode: -1, success: false, error: `发送回复时发生异常: ${errorMessage}` } as any,
      };
    }
  },

  mapToolResultToToolResultBlockParam(
    data: ReplyOutput,
    toolUseID: string,
  ) {
    const { success } = data;
    const message = (data as any).message;

    // [ReplyToolDebug] 打印 mapToolResultToToolResultBlockParam 收到的 data
    logger.info('[ReplyToolDebug]', `mapToolResultToToolResultBlockParam: toolUseID=${toolUseID}, success=${success}, hasMessage=${typeof message}, dataKeys=${Object.keys(data).join(',')}`);

    const error = (data as any).error;
    let content = '';
    if (success && message) {
      content = message;
    } else if (success) {
      content = 'Reply sent to target session.';
    } else if (error) {
      content = `Reply 失败: ${error}`;
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
      exit_code: success ? 0 : -1,
    };
  },
});

/**
 * AskUserQuestion 工具
 *
 * 允许 LLM 在执行过程中向用户提问，等待用户回答后再继续。
 * 通过 ui.requestUserChoice 弹出选择/输入对话框，阻塞等待用户响应。
 */

import { buildTool } from '../Tool.js';
import { TOOL_NAME, DESCRIPTION, getPrompt } from './Prompt.js';
import { inputSchema, outputSchema } from './Types.js';
import type { AskUserQuestionOutput } from './Types.js';
import { logger } from '../../Logger.js';

export const AskUserQuestionTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'ask the user a question',
  maxResultSizeChars: 1000,

  get inputSchema(): typeof inputSchema {
    return inputSchema;
  },

  get outputSchema(): typeof outputSchema {
    return outputSchema;
  },

  description: async () => DESCRIPTION,

  prompt: async () => getPrompt(),

  async validateInput(input, _context) {
    if (!input.question || !input.question.trim()) {
      return {
        result: false,
        message: 'Question cannot be empty',
        errorCode: 1,
      };
    }

    if (input.choices && input.choices.length > 9) {
      return {
        result: false,
        message: 'Maximum 9 choices allowed',
        errorCode: 2,
      };
    }

    return { result: true };
  },

  async checkPermissions(_input, _context) {
    // 直接放行，因为 AskUserQuestion 获取用户输入的方式是在 call() 中
    // 通过 ui.requestUserChoice 弹出提问对话框，不需要双重确认。
    return { behavior: 'allow' };
  },

  async call(
    { question, choices },
    context,
    _parentMessage?,
    _onProgress?,
  ): Promise<import('../Tool.js').ToolResult<AskUserQuestionOutput>> {
    const sessionId = context.sessionId || '';
    const ui = await getUI();

    logger.info('AskUserQuestion', `Asking user: ${question} (choices: ${choices?.length ?? 0})`);

	    // 通过 UI 的 requestUserChoice 弹出选择框
	    // 没有 choices 时不传选项数组，UI 只显示输入框
	    const userChoice = await ui.requestUserChoice(sessionId, {
	      toolName: 'AskUserQuestion',
	      message: question,
	      choices: choices?.map((c: { label: string; description?: string }) => ({
	        label: c.label,
	        description: c.description || undefined,
	      })),
	    });

    const replyText = userChoice.reply?.trim() || '';

    if (choices && choices.length > 0) {
      // 选择题模式：用户可能选了选项，也可能输入了自定义文本
      if (userChoice.index >= 0 && userChoice.index < choices.length) {
        const selected = choices[userChoice.index];
        return {
          data: {
            index: userChoice.index,
            reply: replyText || selected.label,
          },
        };
      }
    }

    // 开放题模式或用户输入了自定义文本
    return {
      data: {
        index: userChoice.index >= 0 ? userChoice.index : undefined,
        reply: replyText || '',
      },
    };
  },

  mapToolResultToToolResultBlockParam(result) {
    const replyText = result.reply || '';
    let content = `User response: ${replyText}`;
    if (result.index !== undefined) {
      content += ` (selected option index: ${result.index})`;
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: '',
      content,
    };
  },
});

/**
 * 获取 UI 实例
 */
async function getUI(): Promise<import('../../AssistantUI.js').AssistantUI> {
  const { getGlobalUI } = await import('../../AssistantUI.js');
  const ui = getGlobalUI();
  if (!ui) throw new Error('UI not initialized');
  return ui;
}

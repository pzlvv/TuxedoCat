/**
 * SkillTool 工具实现
 *
 * 执行 Skill 的核心工具。工作流程：
 * 1. validateInput() -> 验证 skill 名称合法、存在
 * 2. checkPermissions() -> 权限校验
 * 3. call() -> 获取 skill prompt -> 包装为 user message -> 注入对话
 */

import type { ToolResult, ValidationResult, PermissionResult } from '../Tool.js';
import { buildTool } from '../Tool.js';
import type { SkillCommand } from '../../skills/Types.js';
import { getAllSkills } from '../../skills/loadSkillsDir.js';
import { TOOL_NAME, getPrompt } from './Prompt.js';
import type { SkillToolOutput } from './Types.js';
import { inputSchema, outputSchema } from './Types.js';
import { logger } from '../../Logger.js';
import type { Message } from '../../types.js';

/**
 * 按名称查找 Skill
 */
async function findSkill(name: string, cwd: string): Promise<SkillCommand | undefined> {
  const skills = await getAllSkills(cwd);
  const trimmed = name.trim().replace(/^\//, ''); // 去掉前导 /
  return skills.find(
    s => s.name === trimmed || s.aliases?.includes(trimmed),
  );
}

export const SkillTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'invoke a slash-command skill',
  maxResultSizeChars: 100_000,

  get inputSchema(): typeof inputSchema {
    return inputSchema;
  },

  get outputSchema(): typeof outputSchema {
    return outputSchema;
  },

  description: async (_input) => {
    const skillName = _input && typeof _input === 'object' && 'skill' in _input
      ? (_input as any).skill
      : '';
    return skillName ? `Execute skill: ${skillName}` : 'Execute a skill (slash command)';
  },

  prompt: async () => {
    // 静态 stub：不加载本地技能文件，具体技能列表在 Environment 动态 prompt 中注入
    return getPrompt();
  },

  async validateInput(input, context): Promise<ValidationResult> {
    const trimmed = input.skill.trim();
    if (!trimmed) {
      return {
        result: false,
        message: `Invalid skill format: ${trimmed}`,
        errorCode: 1,
      };
    }

    const skill = await findSkill(trimmed, context.cwd);
    if (!skill) {
      return {
        result: false,
        message: `Unknown skill: ${trimmed}`,
        errorCode: 2,
      };
    }

    return { result: true };
  },

  async checkPermissions(_input, _context): Promise<PermissionResult> {
    // Skill 仅注入 prompt，无破坏性，自动放行
    return { behavior: 'allow' };
  },

  async call(
    { skill, args },
    context,
    _parentMessage?,
    _onProgress?,
  ): Promise<ToolResult<SkillToolOutput>> {
    const trimmed = skill.trim().replace(/^\//, '');

    const command = await findSkill(trimmed, context.cwd);
    if (!command) {
      throw new Error(`Skill '${trimmed}' not found`);
    }

    // 获取 session ID
    const sessionId = context.sessionId || '';
    const skillRoot = command.skillRoot;

    // 获取 Prompt 内容
    const contentBlocks = await command.getPromptForCommand(args || '');

    // 提取文本内容
    const textContent = contentBlocks
      .filter(b => b.type === 'text')
      .map(b => b.text as string)
      .join('\n');

    // 替换内置变量（${SKILL_DIR}, ${SESSION_ID}）
    const { substituteBuiltinVariables } = await import('../../skills/variableResolver.js');
    const finalContent = substituteBuiltinVariables(textContent, skillRoot, sessionId);

    // 包装为 UserMessage（isMeta=true 表示不被 UI 直接显示）
    const userMessage: Message = {
      type: 'user',
      message: {
        role: 'user',
        content: finalContent,
      },
      uuid: `skill_${Date.now()}`,
      timestamp: Date.now(),
      isMeta: true,
    };

    logger.info('SkillTool', `Injecting skill '${trimmed}' prompt (${finalContent.length} chars)`);

    return {
      data: {
        success: true,
        skillName: trimmed,
        result: `Skill "${trimmed}" has been loaded. Follow the instructions in the skill content above.`,
      },
      newMessages: [userMessage],
    };
  },

  mapToolResultToToolResultBlockParam(
    result: SkillToolOutput,
    toolUseID: string,
  ) {
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: result.result || `Skill "${result.skillName}" completed`,
    };
  },
});

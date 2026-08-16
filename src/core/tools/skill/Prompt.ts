/**
 * SkillTool 提示词
 */

import type { SkillCommand } from '../../skills/Types.js';

export const TOOL_NAME = 'Skill';

export function getPrompt(): string {
  return `## Skill Tool

Execute a skill (slash command). Available skills are listed in the Environment section above.

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review"), they are referring to a skill. Use this tool to invoke it.

**How to invoke:**
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "commit" - invoke the commit skill
  - skill: "commit", args: "-m 'Fix bug'" - invoke with arguments

**Important:**
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running`;
}

/**
 * 生成 Skill 列表提示词
 * 将可用 Skill 列表格式化为可用的系统提示
 */
export function formatSkillListing(skills: SkillCommand[]): string {
  if (skills.length === 0) return '';

  return skills
    .filter(s => !s.isHidden && s.userInvocable)
    .map(s => {
      const whenToUse = s.whenToUse ? ` - ${s.whenToUse}` : '';
      return `- ${s.name}: ${s.description}${whenToUse}`;
    })
    .join('\n');
}

/**
 * 获取 Skill 列表的提示词（注入到 system prompt 中）
 */
export function getSkillListPrompt(skills: SkillCommand[]): string {
  const listing = formatSkillListing(skills);
  if (!listing) return '';

  return `## Available Skills

You have access to the following skills. Use the Skill tool to invoke them.

${listing}

To invoke a skill, use the Skill tool with the skill name and optional arguments.
Example: \`{ "skill": "commit", "args": "-m 'message'" }\``;
}

/**
 * 工具管理 - 工具注册和访问
 */

import type { Tool, Tools } from './Tool.js';
import { BashTool } from './bash/Bash.js';
import { ReadTool } from './read/Read.js';
import { WriteTool } from './write/Write.js';
import { EditTool } from './edit/Edit.js';
import { GrepTool } from './grep/Grep.js';
import { GlobTool } from './glob/Glob.js';
import { TodoWriteTool } from './todowrite/TodoWrite.js';
import { AgentTool } from './agent/AgentTool.js';
import { ReplyTool } from './agent/ReplyTool.js';
import { SkillTool } from './skill/SkillTool.js';
import { AskUserQuestionTool } from './askuser/AskUserQuestion.js';


/**
 * 默认工具列表
 * 使用 as const 确保类型为 readonly
 *
 * 注意：SkillTool 必须保持为最后一项，用于 generate-prompt.ts 排除动态 Skill 内容
 */
const DEFAULT_TOOLS: Tools = [
  // Bash 工具
  BashTool,

  // 文件操作工具
  ReadTool,
  WriteTool,
  EditTool,

  // 搜索工具
  GrepTool,
  GlobTool,

  // Todo 任务管理
  TodoWriteTool,

  // 子代理工具
  AgentTool,
  ReplyTool,

  // 用户问答工具
  AskUserQuestionTool,

  // Skill 工具（必须保持为最后一项，用于 generate-prompt.ts 排除）
  SkillTool,
] as const;

// ----- 运行时校验：确保 SkillTool 是 DEFAULT_TOOLS 的最后一项 -----
// 如果后续有人在最后加入新工具，模块加载时立即抛错，阻止构建继续
const _lastTool = DEFAULT_TOOLS[DEFAULT_TOOLS.length - 1];
if (!_lastTool || _lastTool.name !== 'Skill') {
  throw new Error(
    `DEFAULT_TOOLS must end with SkillTool (last tool: '${_lastTool?.name ?? '?'}'). ` +
    `Add new tools before SkillTool, or update generate-prompt.ts MASTER_EXCLUDED_TOOLS`
  );
}

/**
 * 获取所有工具
 */
export function getAllTools(): Tools {
  return DEFAULT_TOOLS;
}

/**
 * 根据名称查找工具
 */
export function getToolByName(name: string): Tool | undefined {
  return DEFAULT_TOOLS.find((tool) =>
    tool.name === name || tool.aliases?.includes(name),
  );
}

/**
 * 过滤启用的工具
 */
export function getEnabledTools(): Tools {
  return DEFAULT_TOOLS.filter((tool) => tool.isEnabled());
}

export { getPendingToolUseIds } from './RunTools.js';

/**
 * System Prompt 生成器
 * 为产品（PRODUCT_NAME）生成 LLM 系统提示词
 *
 * 分为三层结构：
 * 1. 静态部分 - 核心原则、工具使用指南等（可缓存）
 * 2. 系统动态部分 - OS、Shell、Git 等（core 层获取）
 * 3. UI 动态部分 - 当前文件、选中行（VSCode 扩展提供）
 */

import type { Tool } from '../tools/Tool.js';
import type { PromptPreset, PromptRenderContext } from './PromptPreset.js';

/**
 * 生成核心系统提示词（不含工具描述部分）
 * 返回 You are a helpful software engineer assistant. 开头的核心原则、文件操作、输出风格等固定内容
 */
export function generateCoreSystemPrompt(): string {
  return `You are a helpful software engineer assistant.

## Core Principles
- Respond in the same language the user uses.
- Do not use emojis in your responses.
- When the sub-agent provides feedback or requests additional information, use the \`Reply\` tool to send messages back. Ordinary text output will not reach the sub-agent, only \`Reply\` can deliver messages to it.`
}

/**
 * 生成工具使用提示词（工具描述 + 详细用法）
 */
export async function generateToolUsagePrompt(tools: Tool[]): Promise<string> {
  // 获取工具描述（简短）
  const toolDescriptions = await Promise.all(
    tools.map(async (tool) => {
      const desc = await getToolDescription(tool);
      return `- **${tool.name}**: ${desc}`;
    })
  );

  // 获取工具详细提示词
  const toolPrompts = await Promise.all(
    tools.map(async (tool) => {
      try {
        const prompt = await tool.prompt({
          getToolPermissionContext: async () => ({}),
          tools,
        });
        return `### ${tool.name}\n${prompt}`;
      } catch (error) {
        // 如果工具没有实现 prompt() 方法，跳过
        console.warn(`[SystemPrompt] Failed to get prompt for tool ${tool.name}:`, error);
        return null;
      }
    })
  );

  // 过滤掉 null 值
  const validToolPrompts = toolPrompts.filter((p): p is string => p !== null);

  return `## Tool Usage
${toolDescriptions.join('\n')}

## Tool Details
${validToolPrompts.join('\n\n')}`;
}

/**
 * 生成静态系统提示词（兼容旧接口）
 * 这部分内容可以缓存，不会频繁变化
 */
export async function generateStaticSystemPrompt(tools: Tool[]): Promise<string> {
  const corePrompt = generateCoreSystemPrompt();
  const toolPrompt = await generateToolUsagePrompt(tools);
  return `${corePrompt}\n\n${toolPrompt}`;
}

/**
 * 系统动态环境信息
 * 由 core 层获取，包括 OS、Shell、Git 等系统级信息
 */
export interface SystemDynamicInfo {
  /** 是否在 Git 仓库中 */
  isGit: boolean;
  /** 当前 Git 分支（如果在 Git 仓库中） */
  gitBranch?: string;
  /** 操作系统平台 */
  platform: string;
  /** 操作系统类型和版本 */
  osType: string;
  osRelease: string;
  /** Shell 类型 */
  shell: string;
  /** Shell 具体名称（如 "Git Bash", "WSL bash"），用于精确判断环境 */
  shellName?: string;
  /** 当前环境可用的命令列表（如 python3, node 等） */
  availableCommands?: string[];
  /** 可用的 Skill 列表描述 */
  availableSkills?: string;
}

/**
 * 生成系统动态提示词
 * 这部分内容由 core 层获取，每轮重新计算
 */
export async function generateSystemDynamicPrompt(info: SystemDynamicInfo, cwd: string): Promise<string> {
  const parts: string[] = [];

  const shellDisplay = info.shellName
    ? `${info.shell} (${info.shellName})`
    : info.shell;

  parts.push(`## Environment
You are running in the following environment:
- **Operating System**: ${info.platform} (${info.osType} ${info.osRelease})
- **Shell**: ${shellDisplay}
- **Working Directory**: ${cwd}`);

  // Git 信息
  if (info.isGit) {
    parts.push(`- **Git Repository**: Yes${info.gitBranch ? ` (branch: ${info.gitBranch})` : ''}`);
  } else {
    parts.push('- **Git Repository**: No');
  }

  // Git Bash 环境提示
  const isGitBash = !!info.shellName?.toLowerCase().includes('git bash');
  if (isGitBash) {
    parts.push(`
**Git Bash Path Tips**:
- Use forward slashes with drive letters: \`cd /e/workspace/project\` (maps to E:\\workspace\\project)
- The working directory above uses Git Bash path style (e.g. \`${cwd}\`)
- Drive letters: \`/c/\` = C:, \`/d/\` = D:, \`/e/\` = E:, etc.
- Use \`pwd\` to show current directory path`);
  }

  // 可用命令列表
  if (info.availableCommands && info.availableCommands.length > 0) {
    parts.push(`
**Available Commands**:
- ${info.availableCommands.join(', ')}`);
  }

  // 可用的 Skill 列表
  if (info.availableSkills) {
    parts.push(`
${info.availableSkills}`);
  }

  return parts.join('\n');
}

/**
 * 生成完整的系统提示词
 * @deprecated 使用 generateStaticSystemPrompt、generateSystemDynamicPrompt 分别生成
 */
export async function generateSystemPrompt(tools: Tool[]): Promise<string[]> {
  const staticPrompt = await generateStaticSystemPrompt(tools);
  return [staticPrompt];
}

/**
 * 获取工具描述
 */
async function getToolDescription(tool: Tool): Promise<string> {
  return await tool.description(
    {} as never,
    {
      isNonInteractiveSession: false,
      toolPermissionContext: {},
      tools: [],
    },
  );
}

/**
 * 按预设组装完整 system prompt。
 *
 * 纯数据驱动：核心身份 + 预设声明的区块（工具说明 / 环境等）依次渲染拼接，
 * 组装处不关心预设是普通还是极简——极简模式只是 sections 为空数组。
 * @param preset - 提示词预设
 * @param ctx - 渲染上下文（工具、系统动态信息、工作目录）
 */
export async function assembleSystemPrompt(
  preset: PromptPreset,
  ctx: PromptRenderContext,
): Promise<string> {
  const renderedSections = await Promise.all(
    preset.sections.map(section => section.render(ctx)),
  );
  return [preset.corePrompt, ...renderedSections]
    .filter(part => part.length > 0)
    .join('\n\n');
}

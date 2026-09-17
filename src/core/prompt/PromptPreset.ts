/**
 * PromptPreset - 提示词预设抽象
 *
 * system prompt 的组织完全由 preset 数据驱动：
 * - `corePrompt`：必选的核心身份提示词（system prompt 开头）
 * - `sections`：可选的附加区块（工具说明、环境信息等），由区块 provider 自行渲染
 * - `toolNames`：工具白名单（undefined = 全部工具）
 *
 * 组装处不再按模式 if/else 分支，只对 preset.sections 做统一 map + join。
 * 新增模式 = 在 PROMPT_PRESETS 注册表里加一条，不改组装逻辑。
 */

import type { Tool } from '../tools/Tool.js';
import {
  generateCoreSystemPrompt,
  generateSystemDynamicPrompt,
  generateToolUsagePrompt,
  type SystemDynamicInfo,
} from './SystemPrompt.js';
import { readAgentsMd } from './AgentsMd.js';

/** 预设 ID */
export type PromptPresetId = 'normal' | 'minimal' | 'mixed';

/** prompt 渲染上下文，供各区块 provider 按需取用 */
export interface PromptRenderContext {
  readonly tools: readonly Tool[];
  readonly systemInfo: SystemDynamicInfo;
  readonly cwd: string;
}

/** 一个可选的 system prompt 区块（如工具说明、环境信息） */
export interface PromptSectionProvider {
  readonly key: string;
  render(ctx: PromptRenderContext): Promise<string>;
}

/** 一份提示词预设的全部差异点 */
export interface PromptPreset {
  readonly id: PromptPresetId;
  /** 核心身份提示词（必选，system prompt 开头） */
  readonly corePrompt: string;
  /** 附加区块，按声明顺序渲染并拼接（极简模式为空数组） */
  readonly sections: readonly PromptSectionProvider[];
  /** 工具白名单，undefined 表示全部工具 */
  readonly toolNames?: readonly string[];
}

/** 工具使用说明区块（## Tool Usage / ## Tool Details） */
export const TOOL_USAGE_SECTION: PromptSectionProvider = {
  key: 'tool-usage',
  render(ctx) {
    return generateToolUsagePrompt(ctx.tools as Tool[]);
  },
};

/** 环境信息区块（## Environment） */
export const ENVIRONMENT_SECTION: PromptSectionProvider = {
  key: 'environment',
  render(ctx) {
    return generateSystemDynamicPrompt(ctx.systemInfo, ctx.cwd);
  },
};

/** 工作目录 AGENTS.md 区块（原样追加，不加任何修饰） */
export const AGENTS_MD_SECTION: PromptSectionProvider = {
  key: 'agents-md',
  async render(ctx) {
    return (await readAgentsMd(ctx.cwd)) ?? '';
  },
};

/** 预设注册表：新增模式只在这里加条目 */
export const PROMPT_PRESETS: Readonly<Record<PromptPresetId, PromptPreset>> = {
  normal: {
    id: 'normal',
    corePrompt: generateCoreSystemPrompt(),
    // AGENTS_MD_SECTION 放最后：项目上下文原样追加到 system prompt 末尾
    sections: [TOOL_USAGE_SECTION, ENVIRONMENT_SECTION, AGENTS_MD_SECTION],
  },
  minimal: {
    id: 'minimal',
    corePrompt: 'You are a helpful software engineer assistant.',
    sections: [],
    toolNames: ['Bash', 'Edit'],
  },
  // mixed 本身不是最终渲染预设；QueryEngine 会先按 minimal 渲染，
  // 首次 LLM 回复完成后切换为 normal。这里提供初始 minimal 定义以保持注册表完整。
  mixed: {
    id: 'mixed',
    corePrompt: 'You are a helpful software engineer assistant.',
    sections: [],
    toolNames: ['Bash', 'Edit'],
  },
};

/** 默认预设：meta.json 未保存时回退到普通模式 */
export const DEFAULT_PROMPT_PRESET: PromptPresetId = 'normal';

/** 按 ID 解析预设，未知/未提供时回退默认普通模式 */
export function getPromptPreset(id: string | undefined): PromptPreset {
  return PROMPT_PRESETS[id as PromptPresetId] ?? PROMPT_PRESETS[DEFAULT_PROMPT_PRESET];
}

/** 判断字符串是否为合法预设 ID */
export function isPromptPresetId(value: string | undefined): value is PromptPresetId {
  return value === 'normal' || value === 'minimal' || value === 'mixed';
}

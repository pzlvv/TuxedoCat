/**
 * Skill 系统类型定义
 *
 * 整个 Skill 系统的数据契约，定义了：
 * - SkillCommand：Skill 命令对象的运行时表现形态
 * - BundledSkillDefinition：注册内置 Skill 时需提供的定义
 * - SkillSource / LoadedFrom：来源标记
 * - ParsedSkillFrontmatter：SKILL.md 解析结果
 */

/** Skill 来源类型 */
export type SkillSource = 'bundled' | 'project' | 'user' | 'managed'

/** Skill 加载位置标记 */
export type LoadedFrom = 'skills' | 'bundled'

/** 内容块（与 LLM API 兼容） */
export interface ContentBlock {
  type: 'text' | 'tool_use' | 'thinking' | 'tool_result'
  [key: string]: unknown
}

/**
 * Skill 命令对象
 * 一个 Skill 在运行时的完整表现形态
 */
export interface SkillCommand {
  type: 'prompt'

  /** Skill 名称（用于查找和调用，如 "commit"、"review"） */
  name: string

  /** 描述（简短说明 Skill 做什么） */
  description: string

  /** 别名（用于兼容旧名称） */
  aliases?: string[]

  /** 参数名称列表（当使用位置参数 $0, $1 时映射） */
  argNames?: string[]

  /** 何时使用此 Skill 的说明（用于工具列表中的提示） */
  whenToUse?: string

  /** 模型覆盖（如 "claude-sonnet-4-20250514"） */
  model?: string

  /** 用户是否可主动触发（/skill 命令） */
  userInvocable: boolean

  /** Skill 文件所在目录路径 */
  skillRoot?: string

  /** 来源标记 */
  source: SkillSource

  /** 加载位置标记 */
  loadedFrom: LoadedFrom

  /** 是否隐藏（不在技能列表中展示） */
  isHidden: boolean

  /** 版本号 */
  version?: string

  /**
   * 获取 Skill 的 Prompt 内容
   * @param args 用户传入的参数
   * @returns 内容块数组（通常是 [{ type: 'text', text: '...' }]）
   */
  getPromptForCommand: (args: string) => Promise<ContentBlock[]>
}

/**
 * 注册内置 Skill 时需提供的定义
 */
export interface BundledSkillDefinition {
  /** Skill 名称 */
  name: string

  /** 描述 */
  description: string

  /** 别名 */
  aliases?: string[]

  /** 何时使用 */
  whenToUse?: string

  /** 模型覆盖 */
  model?: string

  /** 用户是否可主动触发 */
  userInvocable?: boolean

  /** 是否启用 */
  isEnabled?: () => boolean

  /**
   * 参考文件
   * key=相对路径, value=内容
   * 首次调用时自动提取到磁盘，方便模型读取
   */
  files?: Record<string, string>

  /**
   * 获取 Skill Prompt 内容的工厂函数
   * @param args 用户传入的参数
   */
  getPromptForCommand: (args: string) => Promise<ContentBlock[]>
}

/**
 * SKILL.md 解析结果
 */
export interface ParsedSkillFrontmatter {
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  userInvocable: boolean
  paths: string[] | undefined
}

/**
 * 创建 SkillCommand 所需的参数
 */
export interface CreateSkillCommandParams {
  skillName: string
  displayName: string | undefined
  description: string
  hasUserSpecifiedDescription: boolean
  markdownContent: string
  argumentNames: string[]
  whenToUse: string | undefined
  version: string | undefined
  model: string | undefined
  userInvocable: boolean
  source: SkillCommand['source']
  baseDir: string | undefined
  loadedFrom: LoadedFrom
  paths: string[] | undefined
}

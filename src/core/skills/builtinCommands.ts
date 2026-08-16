/**
 * 内置命令系统
 *
 * 内置命令（BuiltinCommand）是与 Skill 并行的 / 触发机制。
 * 与 Skill 的区别：
 * - 内置命令由 WebView 直接处理（不经过 LLM）
 * - 内置命令可以有客户端副作用（如清空对话、切换设置等）
 * - 内置命令名称与 Skill 冲突时，记录 WARNING 并忽略冲突的 Skill
 *
 * 注册方式：在模块加载时通过 registerBuiltinCommand() 注册
 */

import { logger } from '../Logger.js';

/** 命令执行上下文 */
export interface CommandContext {
  /** 当前会话 ID */
  sessionId: string
  /** 工作目录 */
  cwd: string
  /** 命令名称（如 'clear', 'spin'），由 dispatch 自动填充 */
  commandName?: string
  /** UI 实例，用于发送消息显示 */
  ui: import('../AssistantUI.js').AssistantUI
}

/**
 * 命令描述。
 * 可以是静态字符串，也可以是延迟求值的函数（用于按当前 locale 国际化）。
 * 函数形式会在 getBuiltinCommands() 时求值。
 */
export type CommandDescription = string | (() => string);

/** 内置命令定义 */
export interface BuiltinCommandDefinition {
  /** 命令名称（不含 / 前缀） */
  name: string

  /** 描述（用于斜杠补全列表） */
  description: CommandDescription

  /** 别名 */
  aliases?: string[]

  /**
   * 执行回调
   * @param args 命令参数（如 /clear all 中的 "all"）
   * @param context 执行上下文
   * @returns 执行结果描述（可选，用于通知用户）
   */
  execute: (args: string, context: CommandContext) => void | string | Promise<void | string>
}

/** 内置命令运行时对象 */
export interface BuiltinCommand {
  name: string
  description: CommandDescription
  aliases?: string[]
  execute: (args: string, context: CommandContext) => void | string | Promise<void | string>
}

/** 内部注册表 */
const builtinCommands: BuiltinCommand[] = []

/** 已注册名称集合（用于冲突检测） */
const registeredNames = new Set<string>()

/**
 * 注册一个内置命令
 * @param definition 内置命令定义
 */
export function registerBuiltinCommand(definition: BuiltinCommandDefinition): void {
  const names = [definition.name, ...(definition.aliases ?? [])]
  for (const n of names) {
    registeredNames.add(n)
  }

  builtinCommands.push({
    name: definition.name,
    description: definition.description,
    aliases: definition.aliases,
    execute: definition.execute,
  })
}

/**
 * 获取所有已注册的内置命令
 * 函数形式的 description 在此时求值，保证返回的是当前 locale 的文案。
 */
export function getBuiltinCommands(): BuiltinCommand[] {
  return builtinCommands.map((c) => ({
    ...c,
    description: typeof c.description === 'function' ? (c.description as () => string)() : c.description,
  }));
}

/**
 * 检查指定名称是否与已注册的内置命令冲突
 */
export function isBuiltinCommandName(name: string): boolean {
  return registeredNames.has(name)
}

/**
 * 获取所有内置命令名称的集合（含别名）
 */
export function getBuiltinCommandNames(): Set<string> {
  return new Set(registeredNames)
}

/**
 * 记录冲突警告
 * @param skillName 与内置命令冲突的 Skill 名称
 * @param commandName 冲突的内置命令名称
 */
export function logConflictWarning(skillName: string, commandName: string): void {
  logger.warn(
    'BuiltinCommands',
    `Skill "${skillName}" conflicts with built-in command "${commandName}". ` +
    `The Skill will be ignored. Use a different skill name to avoid conflict.`,
  )
}

/**
 * 检查 Skill 名称是否与内置命令冲突，如果冲突则记录警告
 * @param skillNames Skill 的名称和别名列表
 * @returns true 如果有冲突
 */
export function checkSkillConflict(skillName: string, aliases?: string[]): boolean {
  const namesToCheck = [skillName, ...(aliases ?? [])]
  for (const name of namesToCheck) {
    if (registeredNames.has(name)) {
      logConflictWarning(skillName, name)
      return true
    }
  }
  return false
}

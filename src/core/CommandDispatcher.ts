/**
 * CommandDispatcher - 统一的内置命令调度层
 *
 * 负责在消息进入 LLM 之前，拦截并处理以 / 开头的命令。
 * 处理优先级：
 *   1. 内置命令（如 /clear, /spin）：由对应的 handler 直接处理
 *   2. Skill 命令（如 /archive, /commit）：匹配到 Skill 名称时，
 *      返回 'skill' 结果，由上层（Integration）生成 Skill tool call 注入引擎
 *   3. 其他 / 命令：走正常 LLM 流程
 *
 * 工作流程：
 *   webview 发消息
 *     -> VSCodeUI.handleWebviewMessage (透明透传，不处理任何命令)
 *       -> Integration.sendMessage
 *         -> CommandDispatcher.dispatch  (检查命令类型)
 *           -> 内置命令: 执行 handler，返回 'handled'
 *           -> Skill 匹配: 返回 'skill' (携带 skill 名称和参数)
 *           -> 其他: 返回 'passthrough'，继续正常 LLM 流程
 */

import { logger } from './Logger.js';
import type { MessageData } from './AssistantUI.js';
import { getBuiltinCommands } from './skills/builtinCommands.js';
import type { CommandContext } from './skills/builtinCommands.js';

/** 派遣结果 */
export type DispatchResult = 'handled' | 'passthrough' | 'skill';

/**
 * Skill 匹配结果（当 DispatchResult 为 'skill' 时携带）
 */
export interface SkillDispatchInfo {
  skillName: string;
  skillArgs: string;
}

/**
 * 派遣消息
 * 检查 prompt 是否以 / 开头且匹配已注册的内置命令。
 * 匹配则执行命令 handler，返回 'handled'。
 * 不匹配则返回 'passthrough'。
 *
 * @param prompt - 用户消息
 * @param context - 执行上下文
 * @returns DispatchResult
 */
export async function dispatch(
  prompt: string,
  context: CommandContext,
): Promise<{ result: DispatchResult; skillInfo?: SkillDispatchInfo }> {
  // 只处理以 / 开头的消息
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return { result: 'passthrough' };
  }

  // 解析命令名和参数
  const match = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!match) {
    return { result: 'passthrough' };
  }

  const cmdName = match[1];
  const cmdArgs = match[2] ?? '';

  // 1. 查找匹配的内置命令（含别名）
  const commands = getBuiltinCommands();
  const cmd = commands.find(
    c => c.name === cmdName || (c.aliases && c.aliases.includes(cmdName)),
  );

  if (cmd) {
    logger.info('CommandDispatcher', `Dispatching builtin command: /${cmdName} ${cmdArgs}`);

    // 构建带 commandName 的执行上下文
    const cmdContext: CommandContext = {
      ...context,
      commandName: cmd.name,
    };

    try {
      // 先通知 UI 层执行客户端操作（如清空消息列表）
      if (context.ui.onCommandSend) {
        await context.ui.onCommandSend(cmd.name, cmdArgs, context.sessionId);
      }

      // 执行命令
      const result = await cmd.execute(cmdArgs, cmdContext);
      if (result) {
        context.ui.onMessage(context.sessionId, {
          role: 'system',
          content: String(result),
        } as MessageData);
      }
    } catch (err) {
      logger.error('CommandDispatcher', `Command /${cmdName} failed: ${err}`);
      context.ui.onMessage(context.sessionId, {
        role: 'system',
        content: `Command /${cmdName} failed: ${err}`,
      } as MessageData);
    }

    return { result: 'handled' };
  }

  // 2. 检查是否匹配 Skill 名称（非内置命令的 / 命令）
  try {
    const { getBundledSkills } = await import('./skills/bundledSkills.js');
    const { getSkillDirCommands } = await import('./skills/loadSkillsDir.js');
    const allSkills = [
      ...getBundledSkills(),
      ...(await getSkillDirCommands(context.cwd)),
    ];

    const trimmedName = cmdName.replace(/^\//, '');
    const matchedSkill = allSkills.find(
      s => s.name === trimmedName || (s.aliases && s.aliases.includes(trimmedName)),
    );

    if (matchedSkill) {
      logger.info('CommandDispatcher', `Matched skill: /${cmdName}, returning 'skill' result`);
      return {
        result: 'skill',
        skillInfo: {
          skillName: matchedSkill.name,
          skillArgs: cmdArgs,
        },
      };
    }
  } catch (err) {
    logger.warn('CommandDispatcher', `Failed to check skill match: ${err}`);
  }

  // 3. 不是内置命令也不是 Skill，走正常 LLM 流程
  return { result: 'passthrough' };
}

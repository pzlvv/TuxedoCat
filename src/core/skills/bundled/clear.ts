/**
 * /clear 内置命令
 *
 * 清空当前对话的所有消息。
 * UI 层操作由 CommandDispatcher -> VSCodeUI.onCommandSend 处理，
 * 此处只返回描述文本。
 */

import type { BuiltinCommandDefinition } from '../builtinCommands.js';

/**
 * 获取 clear 命令的定义
 */
export function getClearCommandDefinition(): BuiltinCommandDefinition {
  return {
    name: 'clear',
    description: 'Clear the current conversation',
    execute: async (_args: string) => {
      // UI 侧操作（清空消息列表 + 清除文件）由 CommandDispatcher 在调用 execute 前
      // 通过 onCommandSend 通知 VSCodeUI 处理，此处不返回任何内容。
      return '';
    },
  };
}

/**
 * /spin 内置命令（清单定义）
 *
 * Spin Design 流程图式任务编排执行系统。使用方式：
 *   /spin        - 自动检测：无 spin.json 则打开设计器，有则开始执行
 *   /spin design - 打开流程图编辑器
 *
 * 命令的执行归 Core 进程（core-rs）：本文件只保留名称 / 描述 / 别名，
 * 供宿主侧内置命令注册表与技能清单展示使用。
 */

import type { BuiltinCommandDefinition } from '../builtinCommands.js';
import { CoreCommandDescriptionKeys } from '../../coreText.js';

export function getSpinCommandDefinition(): BuiltinCommandDefinition {
  return {
    name: 'spin',
    description: () => CoreCommandDescriptionKeys.spin,
    aliases: ['sprint'],
    execute: async () => {
      // TS 侧注册表只服务清单展示；执行路径在 Core 进程内，这里不可达
      throw new Error('/spin is executed by the standalone Core process.');
    },
  };
}

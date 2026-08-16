/**
 * /spin 内置命令
 *
 * Spin Design 流程图式任务编排执行系统。
 * 使用方式：
 *   /spin        - 自动检测：无 spin.json 则打开设计器，有则开始执行
 *   /spin design - 打开流程图编辑器
 */

import type { BuiltinCommandDefinition } from '../builtinCommands.js';
import type { CommandContext } from '../builtinCommands.js';
import { tt } from '../../i18n.js';

export function getSpinCommandDefinition(): BuiltinCommandDefinition {
  return {
    name: 'spin',
    description: () => tt('执行 Spin 任务', 'Execute Spin tasks'),
    aliases: ['sprint'],
    execute: async (args: string, context: CommandContext) => {
      const { sessionId, cwd, ui } = context;
      const trimmed = args.trim() || 'auto';

      if (trimmed === 'design') {
        // UI 层通过 onCommandSend 打开设计器
        return '';
      }

      const { detectProjectState } = await import('../../spin/Engine.js');
      const state = await detectProjectState(cwd);

      if (state === 'init') {
        // 没有 spin.json，打开 Spin Design 编辑器
        const { sendMessage } = await import('../../Integration.js');
        const prompt = tt(
          '请打开 Spin Design 流程图编辑器，创建一个新的流程图并保存为 spin.json。',
          'Please open the Spin Design flow editor, create a new flow, and save it as spin.json.'
        );
        for await (const _msg of sendMessage(prompt, sessionId, {
          filePath: undefined,
          selectedLines: undefined,
          fileHidden: undefined,
          thinkingMode: 'off',
        })) {
          void _msg;
          // 等待处理完成
        }
        return '';
      }

      // 有 spin.json，开始执行
      const { readSpinJson } = await import('../../spin/Engine.js');
      const { getSessionEngine, QueryEngine } = await import('../../QueryEngine.js');
      const { getAllTools } = await import('../../tools/index.js');

      const currentCfg = await readSpinJson(cwd);
      if (!currentCfg) {
        return tt('无法读取 spin.json。', 'Cannot read spin.json.');
      }

      const spinTitle = tt('Spin 设计', 'Spin Design');

      // 创建或获取主 session 的 engine（workMode = spin）
      let engine = getSessionEngine(sessionId);
      if (!engine) {
        const userMsg: any = {
          type: 'user',
          message: { role: 'user', content: '/spin run' },
          uuid: `user_${Date.now()}`,
          timestamp: Date.now(),
        };
        ui.onMessage(sessionId, {
          role: 'user',
          content: '/spin run',
        });
        engine = new QueryEngine(sessionId, {
          cwd,
          tools: getAllTools() as any[],
          getAppState: () => ({}),
          setAppState: () => {},
          initialMessages: [userMsg],
          ui: ui as any,
          title: spinTitle,
          workMode: 'spin',
        });
        ui.setTitle?.(sessionId, spinTitle);
      }
      // 确保引擎为 spin 模式（无论是否新创建的）
      (engine as any).workMode = 'spin';

      const { updateConversationMetadataTitle } = await import('../../history/Conversation.js');
      await updateConversationMetadataTitle(sessionId, spinTitle);

      // 启动 spinLoop
      const { spinLoop } = await import('../../spin/Loop.js');
      await spinLoop(engine, cwd, ui, sessionId);
      // spinLoop 结束后恢复为 normal 模式
      (engine as any).workMode = 'normal';
      // 冲洗所有未持久化的消息
      await (engine as any).flush();
      return '';
    },
  };
}

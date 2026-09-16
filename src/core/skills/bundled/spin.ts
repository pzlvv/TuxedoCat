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
import type { CoreEvent } from '../../AssistantEventBus.js';
import { requireEventBus } from '../../AssistantEventBus.js';
import type { MessageData } from '../../types.js';
import { tt } from '../../i18n.js';

/** core → UI 单向事件的发送侧封装（spin 命令统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

export function getSpinCommandDefinition(): BuiltinCommandDefinition {
  return {
    name: 'spin',
    description: () => tt('执行 Spin 任务', 'Execute Spin tasks'),
    aliases: ['sprint'],
    execute: async (args: string, context: CommandContext) => {
      const { sessionId, cwd } = context;
      const trimmed = args.trim() || 'auto';

      if (trimmed === 'design') {
        // UI 层通过 onCommandSend 打开设计器
        return '';
      }

      const { detectProjectState, readSpinJson: readSpinJsonForState, getVariablesWithoutValue } = await import('../../spin/Engine.js');
      const state = await detectProjectState(cwd);

      if (state === 'invalid' || state === 'empty-node' || state === 'not-dag' || state === 'variable-no-value') {
        let errorMsg: string;
        if (state === 'empty-node') {
          errorMsg = tt(
            '存在空节点（缺少任务描述），请完善节点后重试。',
            'There are empty nodes (missing task descriptions), please complete them and retry.'
          );
        } else if (state === 'not-dag') {
          errorMsg = tt(
            '流程图不是有效的无环有向图（DAG），请检查连线后重试。',
            'The flow is not a valid directed acyclic graph (DAG), please check the edges and retry.'
          );
        } else if (state === 'variable-no-value') {
          const cfgForState = await readSpinJsonForState(cwd);
          const names = cfgForState ? getVariablesWithoutValue(cfgForState) : [];
          errorMsg = names.length > 0
            ? tt(
              `存在未赋值的变量（${names.join(', ')}），请在 Spin 设计器中填写变量值后重试。`,
              `Variables without a value (${names.join(', ')}), please fill in their values in the Spin Designer and retry.`
            )
            : tt(
              '存在未赋值的变量，请在 Spin 设计器中填写变量值后重试。',
              'There are variables without a value, please fill in their values in the Spin Designer and retry.'
            );
        } else {
          errorMsg = tt(
            'spin.json 格式不合法，请检查文件内容。',
            'spin.json is invalid, please check the file content.'
          );
        }
        emitToUi({
          type: 'message',
          sessionId,
          data: { role: 'user', content: errorMsg } as MessageData,
        });
        return '';
      }

      if (state === 'init') {
        // 没有 spin.json：直接提示用户创建设计文件
        const errorMsg = tt(
          '未找到 spin.json 设计文件，请先创建并保存 Spin 设计。',
          'spin.json design file not found, please create and save a Spin design first.'
        );
        emitToUi({
          type: 'message',
          sessionId,
          data: { role: 'user', content: errorMsg } as MessageData,
        });
        return '';
      }

      // 有 spin.json，开始执行
      const { readSpinJson } = await import('../../spin/Engine.js');
      const { getSessionEngine, QueryEngine } = await import('../../QueryEngine.js');
      const { getAllTools } = await import('../../tools/index.js');

      const currentCfg = await readSpinJson(cwd);
      if (!currentCfg) {
        const errorMsg = tt('无法读取 spin.json。', 'Cannot read spin.json.');
        emitToUi({
          type: 'message',
          sessionId,
          data: { role: 'user', content: errorMsg } as MessageData,
        });
        return '';
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
        emitToUi({
          type: 'message',
          sessionId,
          data: { role: 'user', content: '/spin run' } as MessageData,
        });
        engine = new QueryEngine(sessionId, {
          cwd,
          tools: getAllTools() as any[],
          getAppState: () => ({}),
          setAppState: () => {},
          initialMessages: [userMsg],
          title: spinTitle,
          workMode: 'spin',
        });
        emitToUi({ type: 'titleChanged', sessionId, title: spinTitle });
      }
      // 确保引擎为 spin 模式（无论是否新创建的）
      (engine as any).workMode = 'spin';

      const { updateConversationMetadataTitle } = await import('../../history/Conversation.js');
      await updateConversationMetadataTitle(sessionId, spinTitle);

      // 启动 spinLoop
      const { spinLoop } = await import('../../spin/Loop.js');
      try {
        await spinLoop(engine, cwd, sessionId);
      } finally {
        // spinLoop 结束后恢复为 normal 模式
        (engine as any).workMode = 'normal';
        // 冲洗所有未持久化的消息
        await (engine as any).flush().catch(() => {});
        // 刷新已打开的 Spin 设计器，避免其旧缓存覆盖执行结果
        try {
          emitToUi({ type: 'spinDesignDataChanged' });
        } catch {
          // 刷新失败不影响 /spin 命令返回
        }
      }
      return '';
    },
  };
}

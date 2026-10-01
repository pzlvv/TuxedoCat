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
import { CoreCommandDescriptionKeys, CoreNoticeKeys, type NoticeLevel } from '../../coreText.js';

/** core → UI 单向事件的发送侧封装（spin 命令统一走它） */
function emitToUi(event: CoreEvent): void {
  requireEventBus().emitToUi(event);
}

/** 发一条瞬时提示（键 + 参数，由 UI 翻译） */
function emitNotice(
  sessionId: string,
  key: string,
  level: NoticeLevel,
  params: Record<string, string> = {},
): void {
  emitToUi({ type: 'notice', sessionId, key, params, level });
}

export function getSpinCommandDefinition(): BuiltinCommandDefinition {
  return {
    name: 'spin',
    description: () => CoreCommandDescriptionKeys.spin,
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
        if (state === 'empty-node') {
          emitNotice(sessionId, CoreNoticeKeys.spinEmptyNode, 'error');
        } else if (state === 'not-dag') {
          emitNotice(sessionId, CoreNoticeKeys.spinNotDag, 'error');
        } else if (state === 'variable-no-value') {
          const cfgForState = await readSpinJsonForState(cwd);
          const names = cfgForState ? getVariablesWithoutValue(cfgForState) : [];
          if (names.length > 0) {
            emitNotice(sessionId, CoreNoticeKeys.spinVariableNoValueWithNames, 'error', {
              names: names.join(', '),
            });
          } else {
            emitNotice(sessionId, CoreNoticeKeys.spinVariableNoValue, 'error');
          }
        } else {
          emitNotice(sessionId, CoreNoticeKeys.spinInvalid, 'error');
        }
        return '';
      }

      if (state === 'init') {
        // 没有 spin.json：直接提示用户创建设计文件
        emitNotice(sessionId, CoreNoticeKeys.spinDesignMissing, 'warn');
        return '';
      }

      // 有 spin.json，开始执行
      const { readSpinJson } = await import('../../spin/Engine.js');
      const { getSessionEngine, QueryEngine } = await import('../../QueryEngine.js');
      const { getAllTools } = await import('../../tools/index.js');

      const currentCfg = await readSpinJson(cwd);
      if (!currentCfg) {
        emitNotice(sessionId, CoreNoticeKeys.spinCannotRead, 'error');
        return '';
      }

      // 落盘文本统一英文（`docs/core-ui-separation.md` 第 4.8 节）：标题写进 meta.json。
      const spinTitle = 'Spin Design';

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

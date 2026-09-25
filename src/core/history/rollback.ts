/**
 * editRollback - Edit / Write 文件回滚（core 业务）
 *
 * 从 UI 侧 webviewMessageHandler.handleRollbackEdit 迁入（DEVELOPMENT.md 第 4.3 节 #41）：
 * 「回滚历史编辑」改的是磁盘文件，属 core 业务；UI 只发 UiEvent.editRolledBack，
 * 结果作为一条普通消息（CoreEvent.message）回传 webview 展示。
 */

import { requireEventBus } from '../AssistantEventBus.js';
import type { MessageData } from '../types.js';
import { expandPath } from '../utils/path.js';
import { getProjectRoot } from './Config.js';
import { logger } from '../Logger.js';

/** 回滚方向：before = 回到修改前；after = 回到修改后（保留目标自身改动） */
export type RollbackDirection = 'before' | 'after';

/**
 * 回滚会话历史中的 Edit / Write 操作。
 *
 * @param sessionId 会话 ID
 * @param toolUseId 目标 tool_use 的 ID
 * @param direction 回滚方向
 * @param fallbackFilePath 目标 tool_use.input.file_path 缺失时的兜底路径
 */
export async function rollbackEdit(
  sessionId: string,
  toolUseId: string,
  direction: RollbackDirection,
  fallbackFilePath?: string,
): Promise<void> {
  const emit = (data: MessageData): void => {
    requireEventBus().emitToUi({ type: 'message', sessionId, data });
  };

  try {
    const { loadConversation } = await import('./index.js');
    const conversation = await loadConversation(sessionId);

    // 回滚的相对路径以该会话自己的工作目录为基准：多工作目录下若用进程级项目根，
    // 会话切到后台（活动目录已变）时会解析到别的目录，可能改错文件。
    // loadConversation 已按 meta.json 的 project 登记会话工作目录，此处可稳定解析。
    const sessionCwd = getProjectRoot(sessionId);

    // 收集所有 Edit/Write tool_use block（按消息出现的顺序排列）
    const allToolUses: Array<{ id: string; name: string; _meta: Record<string, unknown>; input: Record<string, unknown> }> = [];
    // 收集 tool_result 中的 beforeContent，按 tool_use_id 索引
    const toolResultBeforeContent = new Map<string, string | null>();
    for (const msg of conversation.messages) {
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'tool_use' && (b.name === 'Edit' || b.name === 'Write')) {
            allToolUses.push({
              id: typeof b.id === 'string' ? b.id : '',
              name: typeof b.name === 'string' ? b.name : '',
              _meta: b._meta && typeof b._meta === 'object' ? b._meta as Record<string, unknown> : {},
              input: b.input && typeof b.input === 'object' ? b.input as Record<string, unknown> : {},
            });
          }
        }
      }
      // 从 tool_result 消息中收集 beforeContent（_meta 可能因异步写入时序未持久化）
      if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          const b = block as Record<string, unknown>;
          const before = b.beforeContent;
          if (b.type === 'tool_result' && (typeof before === 'string' || before === null)) {
            toolResultBeforeContent.set(typeof b.tool_use_id === 'string' ? b.tool_use_id : '', before);
          }
        }
      }
    }

    // 找到目标 tool_use 的索引
    const targetIndex = allToolUses.findIndex(t => t.id === toolUseId);
    if (targetIndex === -1) {
      logger.warn('editRollback', `toolUseId ${toolUseId} not found among ${allToolUses.length} tool calls`);
      emit({ role: 'system', content: '未找到指定的编辑操作，可能历史记录已被压缩' });
      return;
    }

    const target = allToolUses[targetIndex];
    const asContentOrNull = (value: unknown): string | null | undefined =>
      typeof value === 'string' || value === null ? value : undefined;
    // 先从 _meta 读，如果不在则从 tool_result 的 beforeContent 读（Write 新建文件可能为 null）
    let targetBeforeContent = asContentOrNull(target._meta.beforeContent);
    if (targetBeforeContent === undefined) {
      targetBeforeContent = toolResultBeforeContent.has(target.id) ? toolResultBeforeContent.get(target.id) : undefined;
    }
    const targetAfterContent = asContentOrNull(target._meta.afterContent);
    const targetFilePath = typeof target.input.file_path === 'string' ? target.input.file_path : (fallbackFilePath || '');
    if (!targetFilePath) {
      logger.warn('editRollback', 'target Edit has no file_path');
      emit({ role: 'system', content: '目标编辑操作缺少文件路径，无法回滚' });
      return;
    }

    if (direction === 'before' && (targetBeforeContent === undefined || targetBeforeContent === '')) {
      logger.warn('editRollback', 'target Edit has no beforeContent in _meta');
      emit({ role: 'system', content: '目标编辑操作缺少备份内容（beforeContent），无法回滚' });
      return;
    }
    if (direction === 'after' && !targetAfterContent) {
      logger.warn('editRollback', 'target Edit has no afterContent in _meta');
      emit({ role: 'system', content: '目标编辑操作缺少备份内容（afterContent），无法回滚到修改后' });
      return;
    }

    const filesToRestore = new Map<string, string | null>(); // filePath -> content to restore to (null = delete file)

    // 两个方向的差异只在目标文件写回的内容：
    // - before：回滚到目标修改**前**（用目标的 beforeContent 写回，并撤销该目标之后所有后续修改）
    // - after：回滚到目标修改**后**（用目标的 afterContent 写回，并撤销该目标之后的所有后续修改，
    //   但保留目标自身的改动，即不撤销目标的修改）
    // 对其他文件的处理两个方向逐字相同：恢复到它们在目标时刻的状态（即它们第一次被 Edit 前的状态）。
    filesToRestore.set(targetFilePath, (direction === 'before' ? targetBeforeContent : targetAfterContent) ?? null);
    for (let i = targetIndex + 1; i < allToolUses.length; i++) {
      const edit = allToolUses[i];
      const fp = typeof edit.input.file_path === 'string' ? edit.input.file_path : '';
      if (fp && !filesToRestore.has(fp)) {
        const bc = asContentOrNull(edit._meta.beforeContent);
        if (bc !== undefined) {
          filesToRestore.set(fp, bc);
        }
      }
    }

    logger.info('editRollback', `restoring ${filesToRestore.size} files...`);
    const { writeFile, unlink, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    let restoredCount = 0;
    for (const [fp, content] of filesToRestore) {
      try {
        const fullPath = expandPath(fp, sessionCwd);

        if (content === null) {
          // beforeContent 为 null 表示文件原本不存在，删除它
          try {
            await unlink(fullPath);
            logger.info('editRollback', `deleted ${fp}`);
            restoredCount++;
          } catch (err: any) {
            if (err.code !== 'ENOENT') {
              logger.warn('editRollback', `failed to delete ${fp}: ${err.message}`);
            } else {
              logger.info('editRollback', `${fp} already deleted, skipped`);
              restoredCount++;
            }
          }
        } else {
          // 向前回滚（after 方向）时目标可能不存在，需先创建目录和文件
          try {
            await mkdir(dirname(fullPath), { recursive: true });
          } catch {
            // 目录已存在或创建失败，继续尝试写文件
          }
          await writeFile(fullPath, content, 'utf-8');
          logger.info('editRollback', `restored ${fp} (${content.length} chars)`);
          restoredCount++;
        }
      } catch (err: any) {
        logger.warn('editRollback', `failed to restore ${fp}: ${err.message}`);
      }
    }

    emit({
      role: 'system',
      content: `已回滚到目标修改${direction === 'before' ? '前' : '后'}：${restoredCount > 0 ? `恢复了 ${restoredCount} 个文件` : '没有文件需要恢复'}`,
    });
  } catch (err: any) {
    logger.error('editRollback', `rollback failed: ${err.message}`);
    emit({ role: 'system', content: `回滚失败：${err.message}` });
  }
}

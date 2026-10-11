/**
 * 单测：标签页右键菜单的批量关闭判定（`electron/workspaceBatchClose.ts`）。
 *
 * 锁三类口径漂移：
 * - 「关闭所有空闲会话」范围＝右键工作区内、忙碌不动、**当前选中的对话空闲也包含在内**；
 * - 「关闭其它所有工作区」＝任一他区忙碌需**一次**汇总确认、取消则全部不动；
 * - 置灰判据＝无可关会话 / 无其它工作区时清单为空（菜单项 enabled: false）。
 *
 * 运行方式：npm run test:all -- workspace-batch-close
 */

import { selectClosableIdleSessions, summarizeOtherWorkspaces } from '../../electron/workspaceBatchClose';
import type { WorkspaceSessionFacts } from '../../electron/workspaceBatchClose';
import { createChecker, runTests } from './helpers/harness';

function facts(sessionId: string, busy: boolean): WorkspaceSessionFacts {
  return { sessionId, busy };
}

runTests('workspaceBatchClose', () => {
  const { check, finish } = createChecker();

  // ---------- selectClosableIdleSessions ----------
  // 忙碌不动、空闲可关
  const closable = selectClosableIdleSessions([facts('a', false), facts('b', true), facts('c', false)]);
  check('空闲会话入选、忙碌会话不动', closable.length === 2 && closable[0] === 'a' && closable[1] === 'c');

  // 当前选中的对话只要空闲也包含在内（与其它空闲会话同口径）
  const withShown = selectClosableIdleSessions([facts('shown', false), facts('hidden', false)]);
  check('当前选中的对话空闲也入选', withShown.length === 2 && withShown.includes('shown'));

  // 全部忙碌（含等待用户）时无可关会话：清单为空 → 菜单项置灰
  check('全部忙碌时清单为空', selectClosableIdleSessions([facts('a', true), facts('b', true)]).length === 0);
  check('无会话时清单为空', selectClosableIdleSessions([]).length === 0);

  // ---------- summarizeOtherWorkspaces ----------
  // 任一他区忙碌 → 需要一次汇总确认；目标清单含全部他区（含忙碌的——确认语义是整批关闭）
  const withBusy = summarizeOtherWorkspaces([
    { id: 'w1', hasBusySession: false },
    { id: 'w2', hasBusySession: true },
  ]);
  check('任一他区忙碌需汇总确认', withBusy.needsConfirm === true && withBusy.ids.length === 2 && withBusy.ids[1] === 'w2');

  // 全闲 → 免确认直接关
  const allIdle = summarizeOtherWorkspaces([
    { id: 'w1', hasBusySession: false },
    { id: 'w2', hasBusySession: false },
  ]);
  check('全闲免确认', allIdle.needsConfirm === false && allIdle.ids.length === 2);

  // 无其它工作区（只有一张标签）→ 清单为空 → 菜单项置灰
  const none = summarizeOtherWorkspaces([]);
  check('单标签时清单为空', none.needsConfirm === false && none.ids.length === 0);

  finish();
});

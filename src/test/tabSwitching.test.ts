/**
 * 单测：标签页相邻切换判定（`electron/tabSwitching.ts`）与录制冲突判定
 * （`electron/shortcut.ts` 的 `findShortcutConflict`，specs/021）。
 *
 * 锁四类口径漂移：
 * - 相邻切换按标签页顺序取相邻项，末项向后环绕回首项、首项向前环绕到末项；
 * - 集合不足 2 项 / 活动项不在集合中时无相邻项（返回 null，主进程 no-op）；
 * - 两条标签快捷键的默认值就是 Ctrl+Tab / Ctrl+Shift+Tab；
 * - 冲突判定按规范化比较（别名不误报），与被录制行自身现行值相同不算冲突。
 *
 * 运行方式：npm run test:all -- tabSwitching
 */

import { selectAdjacentWorkspace } from '../../electron/tabSwitching';
import type { TabSwitchDirection } from '../../electron/tabSwitching';
import {
  DEFAULT_NEXT_TAB_SHORTCUT,
  DEFAULT_PREV_TAB_SHORTCUT,
  findShortcutConflict,
} from '../../electron/shortcut';
import { createChecker, runTests } from './helpers/harness';

function next(ids: string[], activeId: string | null): string | null {
  return selectAdjacentWorkspace(ids, activeId, 'next' as TabSwitchDirection);
}

function prev(ids: string[], activeId: string | null): string | null {
  return selectAdjacentWorkspace(ids, activeId, 'prev' as TabSwitchDirection);
}

runTests('tabSwitching', () => {
  const { check, finish } = createChecker();

  // ---------- selectAdjacentWorkspace：相邻与环绕 ----------
  const ids = ['a', 'b', 'c'];
  check('中间项的下一项是右邻', next(ids, 'b') === 'c');
  check('中间项的上一项是左邻', prev(ids, 'b') === 'a');
  check('末项向后环绕回首项', next(ids, 'c') === 'a');
  check('首项向前环绕到末项', prev(ids, 'a') === 'c');

  // ---------- 无相邻项：null（主进程 no-op） ----------
  check('空集合返回 null', next([], null) === null && prev([], null) === null);
  check('单标签无相邻项', next(['a'], 'a') === null && prev(['a'], 'a') === null);
  check('活动项不在集合中返回 null', next(ids, 'x') === null && prev(ids, 'x') === null);
  check('无活动项返回 null', next(ids, null) === null && prev(ids, null) === null);

  // 拖拽重排后的新顺序即刻生效（顺序由调用方传入，纯函数只看给定顺序）
  const reordered = ['c', 'a', 'b'];
  check('重排后按新顺序取相邻', next(reordered, 'c') === 'a' && prev(reordered, 'c') === 'b');

  // ---------- 默认组合（FR-002） ----------
  check('下一标签默认 Ctrl+Tab', DEFAULT_NEXT_TAB_SHORTCUT === 'Ctrl+Tab');
  check('上一标签默认 Ctrl+Shift+Tab', DEFAULT_PREV_TAB_SHORTCUT === 'Ctrl+Shift+Tab');

  // ---------- findShortcutConflict：规范化比较与冲突类别 ----------
  const registered = {
    wake: 'Ctrl+Alt+X',
    nextTab: 'Ctrl+Tab',
    prevTab: 'Ctrl+Shift+Tab',
    menuAccelerators: ['CmdOrCtrl+O', 'CmdOrCtrl+Shift+O', 'CmdOrCtrl+Shift+I'],
  };
  check('与另一标签行相同报 prevTab', findShortcutConflict('nextTab', 'Ctrl+Shift+Tab', registered) === 'prevTab');
  check('与另一标签行相同报 nextTab', findShortcutConflict('prevTab', 'Ctrl+Tab', registered) === 'nextTab');
  check('与唤醒快捷键相同报 wake', findShortcutConflict('nextTab', 'Ctrl+Alt+X', registered) === 'wake');
  check('与菜单既有组合相同报 menu', findShortcutConflict('nextTab', 'Ctrl+O', registered) === 'menu');
  check('别名指同一组合时不误报为可用（规范化比较）', findShortcutConflict('nextTab', 'Control+O', registered) === 'menu');
  check('与自身现行值相同不算冲突', findShortcutConflict('nextTab', 'Ctrl+Tab', registered) === null);
  check('无冲突返回 null', findShortcutConflict('nextTab', 'Ctrl+J', registered) === null);
  check('非法组合直接视为无冲突（合法性由录制管线另行判定）', findShortcutConflict('nextTab', 'J', registered) === null);

  finish();
});

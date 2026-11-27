/**
 * 模态对话框的焦点圈定（specs/059 FR-007 的 AC-16）。
 *
 * 纯函数判据：`Tab` / `Shift+Tab` 在框内循环，不逃到被遮罩的界面。
 *
 * 运行方式：npm run test:unit -- focus-trap
 */

import { nextFocusIndex } from '../webview/components/focusTrap';
import { createChecker, runTests } from './helpers/harness';

runTests('focusTrap', () => {
  const { check, finish } = createChecker();

  // ── 正向循环 ──
  check('Tab 前进一格', nextFocusIndex(0, 3, false) === 1);
  check('Tab 到末位回绕到首位', nextFocusIndex(2, 3, false) === 0);
  check('单元素时 Tab 停在原地', nextFocusIndex(0, 1, false) === 0);

  // ── 反向循环 ──
  check('Shift+Tab 后退一格', nextFocusIndex(2, 3, true) === 1);
  check('Shift+Tab 在首位回绕到末位', nextFocusIndex(0, 3, true) === 2);
  check('单元素时 Shift+Tab 停在原地', nextFocusIndex(0, 1, true) === 0);

  // ── 焦点不在框内（-1 = 没找到 / 还没进来）──
  check('焦点不在框内时 Tab 从头开始', nextFocusIndex(-1, 3, false) === 0);
  check('焦点不在框内时 Shift+Tab 从末位开始', nextFocusIndex(-1, 3, true) === 2);

  // ── 空框与越界 ──
  check('没有可聚焦元素时不动作', nextFocusIndex(0, 0, false) === -1);
  check('越界下标按「从头 / 从末」处理', nextFocusIndex(99, 3, false) === 0
    && nextFocusIndex(99, 3, true) === 2);

  // ── 圈定是循环而不是夹取（模态框里不该被卡在两端）──
  {
    let at = 0;
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      at = nextFocusIndex(at, 3, false);
      seen.push(at);
    }
    check('连按五次 Tab 走完两圈', JSON.stringify(seen) === JSON.stringify([1, 2, 0, 1, 2]));
  }

  finish();
});

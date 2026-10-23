/**
 * 标签页相邻切换的目标计算（纯数据，无任何 import——主进程菜单动作与 src/test 单测共用）。
 *
 * 「下一标签 / 上一标签」按标签页顺序（即打开集合顺序，含拖拽重排后）把活动项移向
 * 相邻一项：末项向后环绕回首项、首项向前环绕到末项（浏览器惯例，不做边界停驻）。
 * 打开集合不足 2 项或活动项不在集合中时无相邻项可去，返回 null（调用方 no-op——
 * 设计允许的瞬时状态）。判定在这里收敛为纯函数：主进程只负责收集标签页 id 与执行，
 * 口径漂了会红在 src/test/tabSwitching.test.ts。
 */

/** 切换方向：下一张 / 上一张（沿标签页顺序） */
export type TabSwitchDirection = 'next' | 'prev';

/**
 * 计算相邻标签页的目标 id。
 *
 * @param ids      打开集合的标签页 id（`workspaceRefKey`），按标签页顺序排列
 * @param activeId 当前活动标签页 id；无活动项（集合为空态）传 null
 * @returns 目标标签页 id；无相邻项（不足 2 项 / 活动项不在集合中）时为 null
 */
export function selectAdjacentWorkspace(
  ids: readonly string[],
  activeId: string | null,
  direction: TabSwitchDirection,
): string | null {
  if (ids.length < 2) return null;
  const index = activeId === null ? -1 : ids.indexOf(activeId);
  if (index < 0) return null;
  const step = direction === 'next' ? 1 : -1;
  // 环绕：加 ids.length 再取模，保证负下标落到末项
  return ids[(index + step + ids.length) % ids.length];
}

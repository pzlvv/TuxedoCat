/**
 * 模态对话框的焦点圈定（specs/059 FR-007）。
 *
 * 纯函数，组件与测试共用一份实现（与 `host/abortButtonState.ts`、`inputAreaState.ts`
 * 同模式）：焦点从哪一个格点走到哪一个格点只看序号算术，不在组件里另写一遍 `if`。
 *
 * 为什么要圈定：部署确认框是应用级模态——它一打开，界面就只剩这一件可做的事（needs
 * 用户确认提权，误按 Enter 不该开始装）。焦点逃到框外会让后续按键落到被遮罩的输入区与
 * 对话列表上，那正是「模态」要禁止的形态。
 */

/**
 * 一次 `Tab` / `Shift+Tab` 之后焦点应落到第几个可聚焦元素（0 基下标）。
 *
 * 循环而不是夹取：模态对话框里 Tab 在最后一个元素上继续往后应回到第一个（用户不需要
 * 先 Shift+Tab 绕回来）。`current < 0`（焦点还在框外 / 还没找到）按「从头开始」处理——
 * `Tab` 进第一个、`Shift+Tab` 进最后一个，与浏览器的默认直觉一致。
 *
 * @param current 当前焦点所在的格点下标；-1 表示焦点不在框内
 * @param count 可聚焦元素个数（0 时空框不动作，返回 -1）
 * @param shift 是否是 `Shift+Tab`（反向）
 */
export function nextFocusIndex(current: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

/**
 * 可聚焦元素的选择器（模态框内）。
 *
 * 只认**用户能操作**的控件：禁用项与 `tabindex="-1"` 不参与 Tab 循环（浏览器本就不把
 * 它们放进 tab 序列，圈定时若算进去，Tab 会落在不可聚焦的元素上、看起来像卡住）。
 */
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 在给定容器里算出当前焦点下标（供 `nextFocusIndex` 用）。
 *
 * 返回 -1 表示焦点不在容器内（含容器内没有任何可聚焦元素）。
 */
export function currentFocusIndex(container: Element, active: Element | null): number {
  if (!active) return -1;
  const items = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
  return items.indexOf(active);
}

/**
 * 拖拽期宽度冻结：改窗口 / 面板尺寸的过程中内容保持原样，停手后一次性重排。
 *
 * 背景：浏览器对视口宽度的每一步变化都实时做文本折行重排，消息区的共享
 * ResizeObserver（measureTruncation）与自动滚动观察器也逐帧跟着重测 / 滚动，
 * 长会话拖拽时重排开销可观且视觉上持续抖动。做法是首个 resize 事件把
 * .app-viewport 锁定在当前像素宽度，冻结期内容宽度不变、折行不重算、
 * 观察器不逐帧回调；resize 事件停歇后解锁，内容一次性重排到最终尺寸，
 * 各观察器每元素只回调一次（收尾的批量测量由 measureTruncation 自带）。
 *
 * 只锁宽度：文本折行只由宽度驱动，锁高度会在视口缩小时把输入框挤出屏幕；
 * 软键盘等纯高度变化走 --app-vh 覆盖（viewport.ts），与本模块互不干扰，
 * 高度方向的重排（无折行、只有 flex 让位）保持实时、开销很小。
 * 冻结期视口变宽露出的空档由 html/body 背景填充：独立宿主的兜底背景与
 * 应用主题色同源（standalone-host 与 getColors），VS Code 宿主内容区本就是
 * 透明底、露出即 iframe 底色，因此无需垫色。
 */

/** 判定拖拽结束：最后一个 resize 事件后经过该毫秒数仍无新事件即解锁重排 */
const RESIZE_SETTLE_MS = 200;

/** 冻结标记类与锁定宽度变量挂在 documentElement 上；.app-viewport 是 React
 * 管理的节点，不能写它的内联样式，且类选择器在 React 换渲染分支（如
 * loading → 主界面）后仍命中新节点 */
const FREEZE_CLASS = 'resize-freeze';
const FREEZE_WIDTH_VAR = '--resize-freeze-width';

export function setupResizeFreeze(): void {
  let releaseTimer: number | undefined;

  window.addEventListener('resize', () => {
    const root = document.documentElement;
    if (!root.classList.contains(FREEZE_CLASS)) {
      // 拖拽开始：锁住当前宽度（0 保护：视口尚未完成布局时不锁成 0px）
      const viewport = document.querySelector<HTMLElement>('.app-viewport');
      if (viewport && viewport.clientWidth > 0) {
        root.classList.add(FREEZE_CLASS);
        root.style.setProperty(FREEZE_WIDTH_VAR, `${viewport.clientWidth}px`);
      }
    }
    window.clearTimeout(releaseTimer);
    releaseTimer = window.setTimeout(() => {
      root.classList.remove(FREEZE_CLASS);
      root.style.removeProperty(FREEZE_WIDTH_VAR);
    }, RESIZE_SETTLE_MS);
  });
}

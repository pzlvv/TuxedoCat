/**
 * 移动端可见视口高度适配。
 *
 * 背景：
 * 1. 地址栏遮挡：100vh 等于「地址栏隐藏后」的大视口（large viewport）。地址栏显示时实际可见区域更矮，
 *    页面底部（输入框）会被地址栏挡住，要滚动一下（地址栏自动隐藏）才露出来。
 *    → 由 CSS 的 dvh 解决（见 styles/index.css），随地址栏显隐实时变化。
 * 2. 软键盘遮挡：Chrome 108+ 可用 viewport meta 的 interactive-widget=resizes-content 让布局视口随键盘收缩，
 *    但 iOS Safari 不支持该属性，键盘弹出时布局视口高度不变，输入框会被键盘盖住。
 *    → 这里用 visualViewport 检测键盘，并临时把 --app-vh 覆盖为键盘上方的真实可见高度。
 *
 * 只在「视觉视口明显小于布局视口」时生效（判定为键盘弹出），
 * 地址栏显隐造成的几十像素差值不会触发覆盖，因此桌面端 / Electron / VS Code 中该函数为空操作。
 */

/** 判定键盘弹出的高度差阈值（px）：键盘通常远高于该值，而地址栏显隐差值约 50~60px */
const KEYBOARD_DETECT_THRESHOLD_PX = 100;

/** CSS 变量名：设置后覆盖 html/body/#root 与 .app-viewport 的高度 */
const APP_VH_VAR = '--app-vh';

export function setupAppViewportHeight(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const root = document.documentElement;
  /** 上次写入的像素高度；-1 表示当前未覆盖（使用 CSS dvh） */
  let lastHeight = -1;

  const apply = (): void => {
    // 双指缩放时 visualViewport 尺寸会按缩放比例变化，忽略，避免布局被缩放带偏
    if (vv.scale && vv.scale !== 1) return;

    const keyboardVisible = vv.height < window.innerHeight - KEYBOARD_DETECT_THRESHOLD_PX;
    if (!keyboardVisible) {
      if (lastHeight !== -1) {
        lastHeight = -1;
        root.style.removeProperty(APP_VH_VAR);
      }
      return;
    }

    const height = Math.round(vv.height);
    if (height === lastHeight) return;
    lastHeight = height;
    root.style.setProperty(APP_VH_VAR, `${height}px`);
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

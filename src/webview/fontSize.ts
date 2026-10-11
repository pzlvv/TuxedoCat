/**
 * 界面字号档位（`settings.json` 的 `uiFontSize`）。
 *
 * 与 i18n 同口径：取值由宿主在页面首帧前注入 `window.__uiFontSize`，webview 不持有
 * 默认值；缺失或非法即启动期报错（`docs/hosts/webview-facts.md` 第 3 节）。
 *
 * 档位 → 字号偏移：medium = 0px / large = 2px / xlarge = 4px。受影响的字号统一写成
 * `calc(<基准>px + var(--ui-font-offset))`（CSS 见 `styles/index.css` 的 `ui-fs-*`），
 * 因此切换档位只需重设一个 CSS 变量即可整体生效；antd 菜单项的 fontSize token 是 JS
 * 取值，需要订阅重渲染（`useUiFontOffset`）。
 */

import { useSyncExternalStore } from 'react';

/** 界面字号档位（与宿主 `SettingsStore.UiFontSize` 一致） */
export type UiFontSize = 'medium' | 'large' | 'xlarge';

/** 档位 → 相对 `medium` 基准的字号偏移（px） */
const FONT_OFFSET_PX: Record<UiFontSize, number> = { medium: 0, large: 2, xlarge: 4 };

/**
 * 初始档位：读取宿主注入的 `window.__uiFontSize`（来自 `settings.json`）。
 *
 * 这是**同步注入**的事实（`docs/hosts/webview-facts.md` 第 3 节）：页面首帧之前由宿主写入，
 * 不存在「尚未到达」的窗口。缺失或取值非法说明宿主接线不完整，直接抛错，不猜默认值。
 */
function readInitialUiFontSize(): UiFontSize {
  const v = (window as { __uiFontSize?: unknown }).__uiFontSize;
  if (v === 'medium' || v === 'large' || v === 'xlarge') return v;
  throw new Error(
    `window.__uiFontSize 未注入或取值非法（${String(v)}）：宿主必须在 webview 启动前写入界面字号（'medium' | 'large' | 'xlarge'）。`,
  );
}

let uiFontSize: UiFontSize = readInitialUiFontSize();
const listeners = new Set<() => void>();

/** 当前档位 */
export function getUiFontSize(): UiFontSize {
  return uiFontSize;
}

/** 当前档位对应的字号偏移（px） */
export function getUiFontOffset(): number {
  return FONT_OFFSET_PX[uiFontSize];
}

/**
 * 把基准 px 转成随档位偏移的 CSS 字号值（内联 `style.fontSize` 用）。
 *
 * 与 `styles/index.css` 的 `ui-fs-*` 同源，都是 `calc(<基准>px + var(--ui-font-offset))`。
 */
export function uiFontSizePx(base: number): string {
  return `calc(${base}px + var(--ui-font-offset))`;
}

/**
 * 把当前档位的偏移写到根元素 CSS 变量。
 *
 * 所有 `ui-fs-*` 字号都消费该变量，写一次即整体生效；模块加载时先写一次，
 * 保证首帧就是正确字号。
 */
export function applyUiFontOffset(): void {
  document.documentElement.style.setProperty('--ui-font-offset', `${FONT_OFFSET_PX[uiFontSize]}px`);
}

/** 切换档位；返回是否发生变化（消费 antd token 的组件据此重渲染） */
export function setUiFontSize(size: UiFontSize): boolean {
  if (size === uiFontSize) return false;
  uiFontSize = size;
  applyUiFontOffset();
  for (const listener of listeners) listener();
  return true;
}

/** 订阅档位变化（React `useSyncExternalStore` 用） */
export function subscribeUiFontSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 渲染期读取当前字号偏移的 hook（antd fontSize token 消费方使用） */
export function useUiFontOffset(): number {
  return useSyncExternalStore(subscribeUiFontSize, getUiFontOffset);
}

// 模块加载即写一次：首帧渲染前 CSS 变量就已就位（不依赖任何组件挂载顺序）。
applyUiFontOffset();

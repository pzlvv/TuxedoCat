/**
 * 远程终端的 xterm 配色（docs/hosts/electron-multi-workspace.md 第 14.8 节样式基线）。
 *
 * 深色取 MobaXterm 默认配色原值（`MobaXterm.ini` 的 `[Colors]`：底色 30,30,30、前景
 * 236,236,236、光标 180,180,192 与十六色）；浅色是同色相在白底上的加深版——MobaXterm 没有
 * 白底默认方案，原值（如 green 14,177,108）在白底上对比度不足。两套里的 white / brightWhite
 * 都保持浅灰：它们是底色 / 反显用的，当正文时由下面的对比度兜底救回来。
 *
 * 十六色只决定「用哪个颜色」，不保证任意前后景组合都看得清：`ls` 对 777 目录发的是蓝字绿底
 * （dircolors 的 `ow=34;42`），而蓝绿亮度接近，光换配色表救不回来。这类组合交给 xterm 的
 * `minimumContrastRatio`（`TERMINAL_MINIMUM_CONTRAST_RATIO`）在渲染时把前景色向黑 / 白收敛到
 * 可读，因此配色表不为了对比度牺牲 MobaXterm 的原色。
 */

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_DARK_BACKGROUND = '#1e1e1e';
export const TERMINAL_LIGHT_BACKGROUND = '#ffffff';

/**
 * 前景色与所在单元格底色的最小对比度（WCAG AA 正文 4.5:1）。
 * 彩色前后景组合（`ls` 的 777 目录、粘滞位目录等）靠它在渲染时兜底可读性。
 */
export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

/** 终端配色：底色必填（页面用它与 xterm 保持同一底色，不留缝） */
export type TerminalTheme = ITheme & { background: string };

/**
 * 滚动条滑块配色：取 electron/ui/scrollbar.css 统一滚动条的同一组值（该文件管原生
 * 滚动条；xterm 6 的 DOM 滑块不认 CSS 变量，只能在这份配色表里同步维护，改这里时
 * 那边一并改）。xterm 主题没有独立的 active 态与 hover 分开取值，点击态沿用 hover 色。
 */
const SCROLLBAR_SLIDER_DARK = { background: '#3a3a44', hover: '#4a4a55' };
const SCROLLBAR_SLIDER_LIGHT = { background: '#c9c9d1', hover: '#aeaeb9' };

/** 深浅两套 ANSI 十六色 */
export const XTERM_THEMES: Record<'dark' | 'light', TerminalTheme> = {
  dark: {
    background: TERMINAL_DARK_BACKGROUND,
    foreground: '#ececec',
    cursor: '#b4b4c0',
    cursorAccent: TERMINAL_DARK_BACKGROUND,
    selectionBackground: 'rgba(180, 180, 192, 0.3)',
    scrollbarSliderBackground: SCROLLBAR_SLIDER_DARK.background,
    scrollbarSliderHoverBackground: SCROLLBAR_SLIDER_DARK.hover,
    scrollbarSliderActiveBackground: SCROLLBAR_SLIDER_DARK.hover,
    black: '#1e1e1e',
    red: '#ff6060',
    green: '#0eb16c',
    yellow: '#bebe12',
    blue: '#1296be',
    magenta: '#ff4dff',
    cyan: '#54ccef',
    white: '#cccccc',
    brightBlack: '#808080',
    brightRed: '#ff8080',
    brightGreen: '#18ed93',
    brightYellow: '#dedc12',
    brightBlue: '#1bbae9',
    brightMagenta: '#ff7dff',
    brightCyan: '#8eddf4',
    brightWhite: '#cccccc',
  },
  light: {
    background: TERMINAL_LIGHT_BACKGROUND,
    foreground: '#1e1e1e',
    cursor: '#1e1e1e',
    cursorAccent: TERMINAL_LIGHT_BACKGROUND,
    selectionBackground: 'rgba(30, 30, 30, 0.18)',
    scrollbarSliderBackground: SCROLLBAR_SLIDER_LIGHT.background,
    scrollbarSliderHoverBackground: SCROLLBAR_SLIDER_LIGHT.hover,
    scrollbarSliderActiveBackground: SCROLLBAR_SLIDER_LIGHT.hover,
    black: '#1e1e1e',
    red: '#c0392b',
    green: '#0a8550',
    yellow: '#7a6c00',
    blue: '#0b5c8a',
    magenta: '#a3249b',
    cyan: '#0b7285',
    white: '#cccccc',
    brightBlack: '#6b6b6b',
    brightRed: '#d13b3b',
    brightGreen: '#078048',
    brightYellow: '#857100',
    brightBlue: '#1273a8',
    brightMagenta: '#b52fae',
    brightCyan: '#0d7a8f',
    brightWhite: '#f5f5f7',
  },
};

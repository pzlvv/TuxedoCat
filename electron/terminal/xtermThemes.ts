/**
 * 远程终端的 xterm 配色（docs/hosts/electron-multi-workspace.md 第 14.8 节样式基线，
 * 视觉基准 specs/022-remote-ssh-terminal/demo.html）。
 *
 * 深色终端底色 = 主窗口外壳 #16161b，浅色 = #ffffff；光标 / 选中用应用 accent
 * （#6366f1）；红 / 绿 / 黄语义色与应用 colors.ts 的 success / running / error 对齐。
 */

import type { ITheme } from '@xterm/xterm';

export const TERMINAL_DARK_BACKGROUND = '#16161b';
export const TERMINAL_LIGHT_BACKGROUND = '#ffffff';

/** 深浅两套 ANSI 十六色（demo 定稿） */
export const XTERM_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: {
    background: TERMINAL_DARK_BACKGROUND,
    foreground: '#c1c1c6',
    cursor: '#6366f1',
    cursorAccent: TERMINAL_DARK_BACKGROUND,
    selectionBackground: 'rgba(99, 102, 241, 0.32)',
    black: '#3f3f46',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#eab308',
    blue: '#60a5fa',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#c1c1c6',
    brightBlack: '#71717a',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#facc15',
    brightBlue: '#93c5fd',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#fafafa',
  },
  light: {
    background: TERMINAL_LIGHT_BACKGROUND,
    foreground: '#27272a',
    cursor: '#6366f1',
    cursorAccent: TERMINAL_LIGHT_BACKGROUND,
    selectionBackground: 'rgba(99, 102, 241, 0.25)',
    black: '#3f3f46',
    red: '#dc2626',
    green: '#16a34a',
    yellow: '#d97706',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: '#e4e4e7',
    brightBlack: '#71717a',
    brightRed: '#ef4444',
    brightGreen: '#22c55e',
    brightYellow: '#eab308',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: '#fafafa',
  },
};

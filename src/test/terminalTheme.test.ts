/**
 * 单测：远程终端配色（`electron/terminal/xtermThemes.ts`，docs/hosts/electron-multi-workspace.md 第 14.8 节）。
 *
 * 锁三件事：
 * - 深浅两套底色 / 前景与 MobaXterm 默认配色对齐（深色 30,30,30 + 236,236,236，浅色白底）；
 * - 每个文本色在底色上够读（正文按 WCAG AA 4.5:1，其余文本色至少 3:1）；
 * - `ls` 的彩色前后景组合（777 目录 = 蓝字绿底、粘滞位 = 白字蓝底…）在
 *   `minimumContrastRatio` 兜底后一定够读——这是「777 目录看不清」的回归测试。
 *
 * 运行方式：npm run test:all -- terminal-theme
 */

import { createChecker, runTests } from './helpers/harness';
import {
  TERMINAL_DARK_BACKGROUND,
  TERMINAL_LIGHT_BACKGROUND,
  TERMINAL_MINIMUM_CONTRAST_RATIO,
  XTERM_THEMES,
  type TerminalTheme,
} from '../../electron/terminal/xtermThemes';

type ThemeName = 'dark' | 'light';
type AnsiName =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

const ANSI_NAMES: readonly AnsiName[] = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

/** 作为底色 / 反显用、不当正文色的成员：深色主题的 black 就是底色本身，浅色主题的 white 系是底色 */
const BACKGROUND_ISH: Record<ThemeName, readonly AnsiName[]> = {
  dark: ['black'],
  light: ['white', 'brightWhite'],
};

/** dircolors 默认库里「文字压在彩色底上」的条目（SGR 的 fg + bg 组合） */
const LS_COLOR_PAIRS: readonly { label: string; fg: AnsiName; bg: AnsiName }[] = [
  { label: 'other-writable 目录（777）', fg: 'blue', bg: 'green' },
  { label: '粘滞位 + other-writable 目录（1777）', fg: 'black', bg: 'green' },
  { label: '粘滞位目录（1755）', fg: 'white', bg: 'blue' },
  { label: '断链 orphan', fg: 'red', bg: 'black' },
];

/** dircolors 默认库里「文件类型前景色」，都压在终端底色上 */
const LS_FILE_COLORS: readonly { label: string; name: AnsiName }[] = [
  { label: '目录 di=01;34', name: 'brightBlue' },
  { label: '符号链接 ln=01;36', name: 'brightCyan' },
  { label: '可执行 ex=01;32', name: 'brightGreen' },
  { label: '归档 *.tar=01;31', name: 'brightRed' },
  { label: '套接字 so=01;35', name: 'brightMagenta' },
  { label: '块设备 bd=01;33', name: 'brightYellow' },
];

const THEME_NAMES: readonly ThemeName[] = ['dark', 'light'];

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`配色值不是 #rrggbb：${hex}`);
  const value = Number.parseInt(match[1], 16);
  return (
    0.2126 * channel((value >> 16) & 0xff) +
    0.7152 * channel((value >> 8) & 0xff) +
    0.0722 * channel(value & 0xff)
  );
}

/** WCAG 对比度（1:1 ~ 21:1） */
function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * 某个底色上还能达到的最大对比度：xterm 的 `minimumContrastRatio` 只把前景色向黑 / 白收敛，
 * 所以「能不能救到 4.5:1」由底色决定，与配色表选的前景色无关。
 */
function maxReachableContrast(background: string): number {
  return Math.max(contrast('#000000', background), contrast('#ffffff', background));
}

function ansiColor(theme: TerminalTheme, name: AnsiName): string {
  const value = theme[name];
  if (typeof value !== 'string') throw new Error(`${name} 未定义`);
  return value;
}

function run(): void {
  const { check, finish } = createChecker();

  // —— 与 MobaXterm 默认配色对齐 ——
  check('深色底色 = MobaXterm 默认 BackgroundColour 30,30,30', TERMINAL_DARK_BACKGROUND === '#1e1e1e');
  check('深色前景 = MobaXterm 默认 ForegroundColour 236,236,236', XTERM_THEMES.dark.foreground === '#ececec');
  check('深色光标 = MobaXterm 默认 CursorColour 180,180,192', XTERM_THEMES.dark.cursor === '#b4b4c0');
  check('浅色底色 = 白底', TERMINAL_LIGHT_BACKGROUND === '#ffffff');
  for (const name of THEME_NAMES) {
    const expected = name === 'dark' ? TERMINAL_DARK_BACKGROUND : TERMINAL_LIGHT_BACKGROUND;
    check(`${name} 配色表底色与导出常量一致`, XTERM_THEMES[name].background === expected);
  }

  // —— 正文对比度 ——
  for (const name of THEME_NAMES) {
    const theme = XTERM_THEMES[name];
    const foreground = theme.foreground;
    if (typeof foreground !== 'string') throw new Error('foreground 未定义');
    const ratio = contrast(foreground, theme.background);
    check(`${name} 正文对比度 ${ratio.toFixed(2)}:1 ≥ 4.5`, ratio >= 4.5);
  }

  // —— 每个文本色压在底色上至少 3:1（不靠兜底也不至于糊成一片）——
  for (const name of THEME_NAMES) {
    const theme = XTERM_THEMES[name];
    const excluded = BACKGROUND_ISH[name];
    for (const ansi of ANSI_NAMES) {
      if (excluded.includes(ansi)) continue;
      const ratio = contrast(ansiColor(theme, ansi), theme.background);
      check(`${name} ${ansi} 在底色上 ${ratio.toFixed(2)}:1 ≥ 3`, ratio >= 3);
    }
  }

  // —— ls 的文件类型前景色压在底色上：AA 4.5:1 ——
  for (const name of THEME_NAMES) {
    const theme = XTERM_THEMES[name];
    for (const entry of LS_FILE_COLORS) {
      const ratio = contrast(ansiColor(theme, entry.name), theme.background);
      check(`${name} ${entry.label} 对比度 ${ratio.toFixed(2)}:1 ≥ 4.5`, ratio >= 4.5);
    }
  }

  // —— 文字压在彩色底上：对比度兜底必须能救到 AA（「777 目录看不清」的回归点）——
  check('minimumContrastRatio = 4.5（WCAG AA 正文）', TERMINAL_MINIMUM_CONTRAST_RATIO === 4.5);
  for (const name of THEME_NAMES) {
    const theme = XTERM_THEMES[name];
    for (const entry of LS_COLOR_PAIRS) {
      const foreground = ansiColor(theme, entry.fg);
      const background = ansiColor(theme, entry.bg);
      const raw = contrast(foreground, background);
      const reachable = maxReachableContrast(background);
      check(
        `${name} ${entry.label}：原样 ${raw.toFixed(2)}:1 → 兜底后可达 ${reachable.toFixed(2)}:1 ≥ 4.5`,
        reachable >= TERMINAL_MINIMUM_CONTRAST_RATIO,
      );
    }
  }

  finish();
}

runTests('terminal-theme', run);

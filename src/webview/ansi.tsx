import React, { memo, useMemo } from 'react';

/* eslint-disable no-control-regex -- ANSI 转义序列本身包含控制字符，必须使用 \x1b 匹配 */

/**
 * ANSI 颜色解析与渲染工具。
 *
 * 只负责 UI 展示层的颜色还原，不会修改原始内容：
 * 解析 `\x1b[...m` 等 SGR 控制序列，把可见文本包上对应的颜色/样式 span；
 * 其余光标移动、清屏等 CSI 序列直接忽略（不渲染）。
 */

const ANSI_COLORS = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510',
  '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543',
  '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];

interface AnsiStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
  fg?: string;
  bg?: string;
}

function ansi256ToHex(n: number): string {
  if (n < 16) return ANSI_COLORS[n];
  if (n < 232) {
    const value = n - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const channel = (c: number) => (c === 0 ? 0 : 55 + c * 40);
    return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
  }
  const gray = 8 + (n - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyExtendedColor(
  codes: string[],
  index: number,
  style: AnsiStyle,
  isForeground: boolean,
): number {
  const mode = codes[index + 1];
  if (mode === '5' && codes[index + 2] !== undefined) {
    const color = ansi256ToHex(parseInt(codes[index + 2], 10));
    if (isForeground) style.fg = color;
    else style.bg = color;
    return index + 2;
  }
  if (mode === '2' && codes[index + 2] !== undefined && codes[index + 3] !== undefined && codes[index + 4] !== undefined) {
    const r = parseInt(codes[index + 2], 10);
    const g = parseInt(codes[index + 3], 10);
    const b = parseInt(codes[index + 4], 10);
    const color = `rgb(${r}, ${g}, ${b})`;
    if (isForeground) style.fg = color;
    else style.bg = color;
    return index + 4;
  }
  return index;
}

function applySgr(style: AnsiStyle, params: string): void {
  const codes = params ? params.split(';') : ['0'];
  let i = 0;
  while (i < codes.length) {
    const raw = codes[i];
    if (raw === '') {
      i++;
      continue;
    }
    const code = parseInt(raw, 10);
    if (Number.isNaN(code)) {
      i++;
      continue;
    }

    switch (code) {
      case 0:
        style.bold = false;
        style.dim = false;
        style.italic = false;
        style.underline = false;
        style.inverse = false;
        style.strikethrough = false;
        style.fg = undefined;
        style.bg = undefined;
        break;
      case 1:
        style.bold = true;
        break;
      case 2:
        style.dim = true;
        break;
      case 3:
        style.italic = true;
        break;
      case 4:
        style.underline = true;
        break;
      case 7:
        style.inverse = true;
        break;
      case 9:
        style.strikethrough = true;
        break;
      case 22:
        style.bold = false;
        style.dim = false;
        break;
      case 23:
        style.italic = false;
        break;
      case 24:
        style.underline = false;
        break;
      case 27:
        style.inverse = false;
        break;
      case 29:
        style.strikethrough = false;
        break;
      case 30: case 31: case 32: case 33:
      case 34: case 35: case 36: case 37:
        style.fg = ANSI_COLORS[code - 30];
        break;
      case 38:
        i = applyExtendedColor(codes, i, style, true);
        break;
      case 39:
        style.fg = undefined;
        break;
      case 40: case 41: case 42: case 43:
      case 44: case 45: case 46: case 47:
        style.bg = ANSI_COLORS[code - 40];
        break;
      case 48:
        i = applyExtendedColor(codes, i, style, false);
        break;
      case 49:
        style.bg = undefined;
        break;
      case 90: case 91: case 92: case 93:
      case 94: case 95: case 96: case 97:
        style.fg = ANSI_COLORS[code - 90 + 8];
        break;
      case 100: case 101: case 102: case 103:
      case 104: case 105: case 106: case 107:
        style.bg = ANSI_COLORS[code - 100 + 8];
        break;
      default:
        break;
    }
    i++;
  }
}

function styleToCss(style: AnsiStyle): React.CSSProperties {
  const css: React.CSSProperties = {};
  if (style.bold) css.fontWeight = 'bold';
  if (style.dim) css.opacity = 0.65;
  if (style.italic) css.fontStyle = 'italic';

  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) css.textDecoration = decorations.join(' ');

  if (style.inverse) {
    css.backgroundColor = style.fg || '#cccccc';
    css.color = style.bg || '#000000';
  } else {
    if (style.fg) css.color = style.fg;
    if (style.bg) css.backgroundColor = style.bg;
  }
  return css;
}

/** 判断字符串是否包含 ANSI 转义序列 */
export function hasAnsi(text: string): boolean {
  return /\x1b\[[0-9;:?>=]*[A-Za-z]/.test(text);
}

/** 将含 ANSI 转义序列的文本解析为 React 节点数组（不含 ANSI 时原样返回字符串） */
export function renderAnsiToNodes(text: string): React.ReactNode[] {
  if (!hasAnsi(text)) return [text];

  const nodes: React.ReactNode[] = [];
  const regex = /\x1b\[([0-9;:?>=]*)([A-Za-z])/g;
  let lastIndex = 0;
  let key = 0;
  const style: AnsiStyle = {};
  let match: RegExpExecArray | null;

  const pushSegment = (segment: string) => {
    if (!segment) return;
    const css = styleToCss(style);
    if (Object.keys(css).length > 0) {
      nodes.push(<span key={key++} style={css}>{segment}</span>);
    } else {
      nodes.push(segment);
    }
  };

  while ((match = regex.exec(text)) !== null) {
    const [full, params, code] = match;
    pushSegment(text.slice(lastIndex, match.index));
    if (code === 'm') {
      applySgr(style, params);
    }
    // 非 SGR 的 CSI 序列（光标移动/清屏等）不参与渲染，直接忽略
    lastIndex = match.index + full.length;
  }
  pushSegment(text.slice(lastIndex));
  return nodes;
}

/** 渲染 ANSI 文本的 React 组件 */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const nodes = useMemo(() => renderAnsiToNodes(text), [text]);
  return <>{nodes}</>;
});

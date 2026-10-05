/**
 * 底部编辑器的纯状态机（docs/tui.md 第 7.2 节）。
 *
 * 从 `render/components/Composer.tsx` 抽出为纯逻辑：按键 → 新状态，可单测；
 * 组件层只持有状态并调用这里。键位语义与能力边界见 Composer.tsx 头注。
 */

export interface EditorState {
  lines: string[];
  row: number;
  col: number;
}

export function initialEditor(): EditorState {
  return { lines: [''], row: 0, col: 0 };
}

/** useInput 解析后的按键形状（ink 的 key 子集；测试里手写同构对象） */
export interface EditorKey {
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  tab?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

/** 编辑器状态机：一个按键 → 新状态（纯函数） */
export function applyInput(state: EditorState, chunk: string, key: EditorKey): EditorState {
  // 只处理无修饰的功能键；ctrl/alt 组合留给全局快捷键（Ctrl+O/Ctrl+J 除外，见下）
  if (key.return) return state;
  if (key.escape) return state;
  if (key.backspace) {
    const { lines, row, col } = state;
    if (col > 0) {
      const line = lines[row];
      const next = [...lines];
      next[row] = line.slice(0, col - 1) + line.slice(col);
      return { ...state, lines: next, col: col - 1 };
    }
    if (row > 0) {
      const next = [...lines];
      next[row - 1] = next[row - 1] + lines[row];
      next.splice(row, 1);
      return { lines: next, row: row - 1, col: lines[row - 1].length };
    }
    return state;
  }
  if (key.delete) {
    const { lines, row, col } = state;
    const line = lines[row];
    if (col < line.length) {
      const next = [...lines];
      next[row] = line.slice(0, col) + line.slice(col + 1);
      return { ...state, lines: next };
    }
    if (row < lines.length - 1) {
      const next = [...lines];
      next[row] = line + lines[row + 1];
      next.splice(row + 1, 1);
      return { ...state, lines: next };
    }
    return state;
  }
  if (key.leftArrow) {
    const { row, col } = state;
    if (col > 0) return { ...state, col: col - 1 };
    if (row > 0) return { ...state, row: row - 1, col: state.lines[row - 1].length };
    return state;
  }
  if (key.rightArrow) {
    const { row, col } = state;
    if (col < state.lines[row].length) return { ...state, col: col + 1 };
    if (row < state.lines.length - 1) return { ...state, row: row + 1, col: 0 };
    return state;
  }
  if (key.upArrow) {
    if (state.row > 0) return { ...state, row: state.row - 1, col: Math.min(state.col, state.lines[state.row - 1].length) };
    return state;
  }
  if (key.downArrow) {
    if (state.row < state.lines.length - 1) {
      return { ...state, row: state.row + 1, col: Math.min(state.col, state.lines[state.row + 1].length) };
    }
    return state;
  }
  if (key.tab) {
    return insertText(state, '  ');
  }
  if (chunk.length > 0 && !key.ctrl && !key.meta) {
    // 粘贴的多行文本（chunk 含 \n / \r\n）原样插入
    const normalized = chunk.replace(/\r\n?/g, '\n');
    return insertText(state, normalized);
  }
  return state;
}

/** 在光标处插入文本（含多行；纯函数） */
export function insertText(state: EditorState, text: string): EditorState {
  const { lines, row, col } = state;
  const line = lines[row];
  const incoming = text.split('\n');
  if (incoming.length === 1) {
    const next = [...lines];
    next[row] = line.slice(0, col) + text + line.slice(col);
    return { ...state, lines: next, col: col + text.length };
  }
  const next = [...lines];
  next.splice(row, 1, ...[
    line.slice(0, col) + incoming[0],
    ...incoming.slice(1, -1),
    incoming[incoming.length - 1] + line.slice(col),
  ]);
  return { lines: next, row: row + incoming.length - 1, col: incoming[incoming.length - 1].length };
}

/** Ctrl+O（以及无法区分时的 Ctrl+J）插入换行 */
export function insertNewline(state: EditorState): EditorState {
  const { lines, row, col } = state;
  const line = lines[row];
  const next = [...lines];
  next.splice(row, 1, line.slice(0, col), line.slice(col));
  return { lines: next, row: row + 1, col: 0 };
}

/** 编辑器全文（发送内容） */
export function editorText(state: EditorState): string {
  return state.lines.join('\n');
}

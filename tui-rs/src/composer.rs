//! 底部编辑器的纯状态机（docs/tui.md 第 7.2 节；`src/tui/composerState.ts` 的移植）。
//!
//! 按键 → 新状态，纯函数可单测；渲染与键盘解析在 `app.rs`。
//! 键位的现实约束：多数终端里 Shift+Enter 与 Enter 同码（无法区分），换行用
//! Ctrl+O（Ctrl+J 同理按换行兜底）；IME / 撤销 / 富编辑不在 v1 范围。

/// 编辑器状态：多行文本 + 光标（row/col）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorState {
    pub lines: Vec<String>,
    pub row: usize,
    pub col: usize,
}

/// 解析后的按键形状（crossterm 事件的投影；测试里手写同构值）。
#[derive(Debug, Clone, Default)]
pub struct EditorKey {
    pub backspace: bool,
    pub delete: bool,
    pub left: bool,
    pub right: bool,
    pub up: bool,
    pub down: bool,
    pub tab: bool,
    pub ctrl: bool,
    pub alt: bool,
}

pub fn initial_editor() -> EditorState {
    EditorState { lines: vec![String::new()], row: 0, col: 0 }
}

impl EditorState {
    pub fn is_empty(&self) -> bool {
        self.lines.iter().all(|line| line.is_empty())
    }

    /// 编辑器全文（发送内容）。
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }
}

/// 编辑器状态机：一个按键 → 新状态（纯函数）。
/// Enter / Esc 不在这里处理（发送与清空/abort 语义由 App 决定）。
pub fn apply_key(state: &EditorState, chunk: &str, key: &EditorKey) -> EditorState {
    if key.backspace {
        let line = &state.lines[state.row];
        if state.col > 0 {
            let mut next = state.clone();
            let byte = char_boundary_left(line, state.col);
            next.lines[state.row] = format!("{}{}", &line[..byte], &line[char_boundary_right(line, byte)..]);
            next.col = state.col - 1;
            return next;
        }
        if state.row > 0 {
            let mut next = state.clone();
            let previous_len = next.lines[state.row - 1].chars().count();
            let current = next.lines[state.row].clone();
            next.lines[state.row - 1].push_str(&current);
            next.lines.remove(state.row);
            next.row = state.row - 1;
            next.col = previous_len;
            return next;
        }
        return state.clone();
    }
    if key.delete {
        let line = &state.lines[state.row];
        if state.col < line.chars().count() {
            let mut next = state.clone();
            let byte = char_offset(line, state.col);
            let after = char_boundary_right(line, byte);
            next.lines[state.row] = format!("{}{}", &line[..byte], &line[after..]);
            return next;
        }
        if state.row < state.lines.len() - 1 {
            let mut next = state.clone();
            let following = next.lines[state.row + 1].clone();
            next.lines[state.row].push_str(&following);
            next.lines.remove(state.row + 1);
            return next;
        }
        return state.clone();
    }
    if key.left {
        if state.col > 0 {
            return EditorState { col: state.col - 1, ..state.clone() };
        }
        if state.row > 0 {
            return EditorState {
                row: state.row - 1,
                col: state.lines[state.row - 1].chars().count(),
                ..state.clone()
            };
        }
        return state.clone();
    }
    if key.right {
        if state.col < state.lines[state.row].chars().count() {
            return EditorState { col: state.col + 1, ..state.clone() };
        }
        if state.row < state.lines.len() - 1 {
            return EditorState { row: state.row + 1, col: 0, ..state.clone() };
        }
        return state.clone();
    }
    if key.up {
        if state.row > 0 {
            return EditorState {
                row: state.row - 1,
                col: state.col.min(state.lines[state.row - 1].chars().count()),
                ..state.clone()
            };
        }
        return state.clone();
    }
    if key.down {
        if state.row < state.lines.len() - 1 {
            return EditorState {
                row: state.row + 1,
                col: state.col.min(state.lines[state.row + 1].chars().count()),
                ..state.clone()
            };
        }
        return state.clone();
    }
    if key.tab {
        return insert_text(state, "  ");
    }
    if !chunk.is_empty() && !key.ctrl && !key.alt {
        // 粘贴的多行文本（chunk 含 \n / \r\n）原样插入
        let normalized = chunk.replace("\r\n", "\n").replace('\r', "\n");
        return insert_text(state, &normalized);
    }
    state.clone()
}

/// 在光标处插入文本（含多行；纯函数）。
pub fn insert_text(state: &EditorState, text: &str) -> EditorState {
    let line = state.lines[state.row].clone();
    let before: String = line.chars().take(state.col).collect();
    let after: String = line.chars().skip(state.col).collect();
    let incoming: Vec<&str> = text.split('\n').collect();
    if incoming.len() == 1 {
        let mut next = state.clone();
        next.lines[state.row] = format!("{before}{}{after}", incoming[0]);
        next.col = state.col + incoming[0].chars().count();
        return next;
    }
    let mut next = state.clone();
    let mut replacement: Vec<String> = Vec::with_capacity(incoming.len());
    replacement.push(format!("{}{}", before, incoming[0]));
    for middle in &incoming[1..incoming.len() - 1] {
        replacement.push((*middle).to_string());
    }
    replacement.push(format!("{}{}", incoming[incoming.len() - 1], after));
    let row = state.row;
    next.lines.splice(row..=row, replacement);
    EditorState {
        lines: next.lines,
        row: state.row + incoming.len() - 1,
        col: incoming[incoming.len() - 1].chars().count(),
    }
}

/// Ctrl+O（以及无法区分时的 Ctrl+J）插入换行。
pub fn insert_newline(state: &EditorState) -> EditorState {
    let line = state.lines[state.row].clone();
    let before: String = line.chars().take(state.col).collect();
    let after: String = line.chars().skip(state.col).collect();
    let mut next = state.clone();
    next.lines[state.row] = before;
    next.lines.insert(state.row + 1, after);
    next.row = state.row + 1;
    next.col = 0;
    next
}

/// Ctrl+U 清行。
pub fn clear_line(state: &EditorState) -> EditorState {
    let mut next = state.clone();
    next.lines[state.row] = String::new();
    next.col = 0;
    next
}

/// 字符列 → 字节偏移（列按 char 计，避免多字节字符切坏 UTF-8）。
fn char_offset(line: &str, col: usize) -> usize {
    line.char_indices().nth(col).map(|(byte, _)| byte).unwrap_or(line.len())
}

fn char_boundary_left(line: &str, col: usize) -> usize {
    char_offset(line, col - 1)
}

fn char_boundary_right(line: &str, byte: usize) -> usize {
    line[byte..]
        .chars()
        .next()
        .map(|character| byte + character.len_utf8())
        .unwrap_or(byte)
}

#[cfg(test)]
#[path = "composer_tests.rs"]
mod tests;

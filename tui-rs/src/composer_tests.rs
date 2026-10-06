//! 编辑器状态机测试（对齐 src/test/tuiHost.test.ts 的 composerState 覆盖）。

use super::*;

fn key(backspace: bool) -> EditorKey {
    EditorKey { backspace, ..Default::default() }
}

#[test]
fn typing_and_backspace() {
    let mut state = initial_editor();
    state = apply_key(&state, "abc", &EditorKey::default());
    assert_eq!(state.lines, vec!["abc"]);
    assert_eq!(state.col, 3);
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec!["ab"]);
    assert_eq!(state.col, 2);
}

#[test]
fn backspace_joins_lines() {
    let mut state = initial_editor();
    state = insert_text(&state, "ab\ncd");
    assert_eq!(state.lines, vec!["ab", "cd"]);
    assert_eq!((state.row, state.col), (1, 2));
    // 行内退格先删字符
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec!["ab", "c"]);
    // 到行首再退格：与上一行合并
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec!["abc"]);
    assert_eq!((state.row, state.col), (0, 2));
}

#[test]
fn delete_merges_forward() {
    let mut state = initial_editor();
    state = insert_text(&state, "ab\ncd");
    // ↑ 到上一行行尾（0,2）
    state = apply_key(&state, "", &EditorKey { up: true, ..Default::default() });
    assert_eq!((state.row, state.col), (0, 2));
    // 行尾 Delete：与下一行合并
    state = apply_key(&state, "", &EditorKey { delete: true, ..Default::default() });
    assert_eq!(state.lines, vec!["abcd"]);
    assert_eq!(state.col, 2);
    // 行内 Delete 删光标处字符（col=1 的 'b'）
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    state = apply_key(&state, "", &EditorKey { delete: true, ..Default::default() });
    assert_eq!(state.lines, vec!["acd"]);
}

#[test]
fn arrows_move_across_lines() {
    let mut state = initial_editor();
    state = insert_text(&state, "ab\ncdef");
    // ↑ 到上一行行尾（列被夹到上一行长度内）
    state = apply_key(&state, "", &EditorKey { up: true, ..Default::default() });
    assert_eq!((state.row, state.col), (0, 2));
    // ↓ 回来，列保持 2（目标行更长，不夹）
    state = apply_key(&state, "", &EditorKey { down: true, ..Default::default() });
    assert_eq!((state.row, state.col), (1, 2));
    // 行首 ← 跳到上一行行尾
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    assert_eq!((state.row, state.col), (0, 2));
}

#[test]
fn multiline_paste_inserted_verbatim() {
    let mut state = initial_editor();
    // 粘贴的多行文本（含 \r\n）原样插入
    state = apply_key(&state, "第一行\r\n第二行", &EditorKey::default());
    assert_eq!(state.lines, vec!["第一行", "第二行"]);
    assert_eq!((state.row, state.col), (1, 3));
}

#[test]
fn ctrl_chunks_are_ignored_by_the_state_machine() {
    // ctrl/alt 组合留给全局快捷键，状态机不吃
    let state = initial_editor();
    let next = apply_key(&state, "x", &EditorKey { ctrl: true, ..Default::default() });
    assert_eq!(next, state);
}

#[test]
fn tab_inserts_two_spaces() {
    let mut state = initial_editor();
    state = apply_key(&state, "", &EditorKey { tab: true, ..Default::default() });
    assert_eq!(state.lines, vec!["  "]);
}

#[test]
fn insert_newline_and_clear_line() {
    let mut state = initial_editor();
    state = insert_text(&state, "hello");
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    state = apply_key(&state, "", &EditorKey { left: true, ..Default::default() });
    // Ctrl+O：光标处断行
    state = insert_newline(&state);
    assert_eq!(state.lines, vec!["hel", "lo"]);
    assert_eq!((state.row, state.col), (1, 0));
    // Ctrl+U：清当前行
    state = clear_line(&state);
    assert_eq!(state.lines, vec!["hel", ""]);
    assert_eq!(state.col, 0);
}

#[test]
fn cjk_characters_stay_whole() {
    let mut state = initial_editor();
    state = insert_text(&state, "你好");
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec!["你"]);
    assert_eq!(state.col, 1);
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec![""]);
    // 空编辑器再退格是无操作
    state = apply_key(&state, "", &key(true));
    assert_eq!(state.lines, vec![""]);
}

#[test]
fn text_joins_lines() {
    let mut state = initial_editor();
    state = insert_text(&state, "a\nb\nc");
    assert_eq!(state.text(), "a\nb\nc");
    assert!(!state.is_empty());
    assert!(initial_editor().is_empty());
}

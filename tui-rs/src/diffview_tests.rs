//! diff 组装测试：增删着色、等值折叠、结尾换行口径。

use super::*;
use crate::store::OverlayColor;

#[test]
fn added_removed_and_context_colored() {
    let lines = diff_overlay_lines("a\nb\nc", "a\nB\nc", 1);
    assert_eq!(lines[0], OverlayLine { text: "  a".into(), color: OverlayColor::Gray });
    assert_eq!(lines[1], OverlayLine { text: "- b".into(), color: OverlayColor::Red });
    assert_eq!(lines[2], OverlayLine { text: "+ B".into(), color: OverlayColor::Green });
    assert_eq!(lines[3], OverlayLine { text: "  c".into(), color: OverlayColor::Gray });
}

#[test]
fn trailing_newline_does_not_add_empty_row() {
    let lines = diff_lines("a\n", "a\nb\n");
    let added: Vec<&str> = lines.iter().filter(|(added, ..)| *added).map(|(_, _, text)| text.as_str()).collect();
    assert_eq!(added, vec!["b"]);
}

#[test]
fn empty_before_is_pure_addition() {
    let lines = diff_overlay_lines("", "新文件\n", 2);
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].color, OverlayColor::Green);
    assert_eq!(lines[0].text, "+ 新文件");
}

#[test]
fn trim_unchanged_folds_far_context() {
    // 10 行等值 + 1 行变更 + 10 行等值；context=1 时等值只留变更附近各 1 行
    let mut lines: Vec<OverlayLine> = (0..10)
        .map(|index| OverlayLine { text: format!("c{index}"), color: OverlayColor::Gray })
        .collect();
    lines.push(OverlayLine { text: "+ x".into(), color: OverlayColor::Green });
    lines.extend((0..10).map(|index| OverlayLine { text: format!("d{index}"), color: OverlayColor::Gray }));
    let trimmed = trim_unchanged(&lines, 1);
    // 2 行折叠占位 + 变更行 + 前后各 1 行等值
    assert_eq!(trimmed.len(), 5);
    assert!(trimmed[0].text.contains('⋯'));
    assert_eq!(trimmed[2].color, OverlayColor::Green);
}

#[test]
fn long_inputs_degrade_to_replacement() {
    let long_before: String = (0..5000).map(|index| format!("old {index}\n")).collect();
    let long_after: String = (0..5000).map(|index| format!("new {index}\n")).collect();
    let lines = diff_lines(&long_before, &long_after);
    let removed = lines.iter().filter(|(_, removed, _)| *removed).count();
    let added = lines.iter().filter(|(added, ..)| *added).count();
    assert_eq!(removed, 5000);
    assert_eq!(added, 5000);
}

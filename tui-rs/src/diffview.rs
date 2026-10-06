//! 终端 diff 覆盖层的行级对比（`TuiUIHost.showDiff` + `trimUnchanged` 的移植）。
//!
//! Edit / Write 的 before / after 渲染为带色统一 diff（新增绿 / 删除红 / 等值灰），
//! 等值上下文每侧折叠到 3 行——长 diff 不淹没终端。在权限确认覆盖层弹出**之前**展示。

use crate::store::{OverlayColor, OverlayLine};

/// 行级 LCS 对比：产出 (标记, 行) 序列；等值块保持原顺序。
///
/// 超长输入（> 4000 行/侧）时退化为整侧替换：diff 表是 O(n²) 内存，
/// 权限预览不需要为极端大文件付出这个代价。
pub fn diff_lines(before: &str, after: &str) -> Vec<(bool, bool, String)> {
    // (added, removed, text)
    let a: Vec<&str> = if before.is_empty() { Vec::new() } else { split_lines(before) };
    let b: Vec<&str> = if after.is_empty() { Vec::new() } else { split_lines(after) };
    const MAX: usize = 4000;
    if a.len() > MAX || b.len() > MAX {
        let mut out: Vec<(bool, bool, String)> =
            a.into_iter().map(|line| (false, true, line.to_string())).collect();
        out.extend(b.into_iter().map(|line| (true, false, line.to_string())));
        return out;
    }

    // LCS 长度表（u32 够用：行数 ≤ 4000）
    let rows = a.len();
    let cols = b.len();
    let mut table = vec![0u32; (rows + 1) * (cols + 1)];
    let width = cols + 1;
    for i in (0..rows).rev() {
        for j in (0..cols).rev() {
            table[i * width + j] = if a[i] == b[j] {
                table[(i + 1) * width + j + 1] + 1
            } else {
                table[i * width + j + 1].max(table[(i + 1) * width + j])
            };
        }
    }

    let mut out: Vec<(bool, bool, String)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < rows && j < cols {
        if a[i] == b[j] {
            out.push((false, false, a[i].to_string()));
            i += 1;
            j += 1;
        } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
            out.push((false, true, a[i].to_string()));
            i += 1;
        } else {
            out.push((true, false, b[j].to_string()));
            j += 1;
        }
    }
    for line in &b[j..] {
        out.push((true, false, (*line).to_string()));
    }
    for line in &a[i..] {
        out.push((false, true, (*line).to_string()));
    }
    out
}

fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line)).collect();
    // 与 TS `part.value.replace(/\n$/, '').split('\n')` 的口径一致：结尾换行不产生空尾行
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// 等值上下文行折叠：每个变更块前后只保留 `context` 行（`trimUnchanged` 移植）。
pub fn trim_unchanged(lines: &[OverlayLine], context: usize) -> Vec<OverlayLine> {
    let keep: Vec<bool> = lines
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if line.color != OverlayColor::Gray {
                return true;
            }
            // 等值行只在邻近变更时保留
            let start = index.saturating_sub(context);
            let end = (index + context).min(lines.len() - 1);
            lines[start..=end].iter().any(|near| near.color != OverlayColor::Gray)
        })
        .collect();

    let mut out: Vec<OverlayLine> = Vec::new();
    let mut skipped = 0usize;
    for (index, line) in lines.iter().enumerate() {
        if keep[index] {
            out.push(line.clone());
            skipped = 0;
        } else {
            skipped += 1;
            if skipped == 1 && index < lines.len() - 1 {
                out.push(OverlayLine {
                    text: "  ⋯ (省略等值上下文)".to_string(),
                    color: OverlayColor::Gray,
                });
            }
        }
    }
    out
}

/// before / after → 带色 diff 覆盖层行（`TuiUIHost.showDiff` 的组装逻辑）。
pub fn diff_overlay_lines(before: &str, after: &str, context: usize) -> Vec<OverlayLine> {
    let mut lines: Vec<OverlayLine> = Vec::new();
    for (added, removed, text) in diff_lines(before, after) {
        let (color, sign) = if added {
            (OverlayColor::Green, '+')
        } else if removed {
            (OverlayColor::Red, '-')
        } else {
            (OverlayColor::Gray, ' ')
        };
        lines.push(OverlayLine { text: format!("{sign} {text}"), color });
    }
    trim_unchanged(&lines, context)
}

#[cfg(test)]
#[path = "diffview_tests.rs"]
mod tests;

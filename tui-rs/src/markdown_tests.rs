//! markdown 子集渲染测试：块级结构与行内样式。

use super::*;

fn text_of(line: &MdLine) -> String {
    line.plain_text()
}

#[test]
fn headings_colored_by_depth() {
    let lines = render("# 一级\n## 二级\n### 三级");
    assert_eq!(lines.len(), 3);
    assert_eq!(text_of(&lines[0]), "一级");
    assert_eq!(lines[0].spans[0].style.color, MdColor::Green);
    assert!(lines[0].spans[0].style.bold);
    assert_eq!(lines[1].spans[0].style.color, MdColor::Cyan);
    assert_eq!(lines[2].spans[0].style.color, MdColor::White);
}

#[test]
fn fenced_code_is_cyan_and_verbatim() {
    let lines = render("```rust\nfn main() {}\n```\n之后");
    assert_eq!(lines.len(), 2);
    assert_eq!(text_of(&lines[0]), "│ fn main() {}");
    assert_eq!(lines[0].spans[1].style.color, MdColor::Cyan);
    assert_eq!(text_of(&lines[1]), "之后");
}

#[test]
fn inline_styles_nest() {
    let spans = inline("**粗** 和 `码` 和 [链](https://x.y) 和 ~~删~~", MdStyle::default());
    assert_eq!(spans[0].style.bold, true);
    assert_eq!(spans[0].text, "粗");
    assert_eq!(spans[1].text, " 和 ");
    assert_eq!(spans[2].style.color, MdColor::Cyan);
    assert_eq!(spans[2].text, "码");
    let link: String = spans.iter().skip(4).take(2).map(|span| span.text.as_str()).collect();
    assert_eq!(link, "链 (https://x.y)");
    assert!(spans[4].style.underline);
    assert_eq!(spans.last().unwrap().style.strikethrough, true);
}

#[test]
fn unterminated_markers_stay_literal() {
    let spans = inline("a **b c", MdStyle::default());
    assert_eq!(spans.iter().map(|span| span.text.as_str()).collect::<String>(), "a **b c");
}

#[test]
fn lists_ordered_and_unordered() {
    let lines = render("- 第一\n- 第二\n1. 有序\n  - 嵌套");
    assert_eq!(text_of(&lines[0]), "• 第一");
    assert_eq!(lines[0].spans[0].style.color, MdColor::Yellow);
    assert_eq!(text_of(&lines[2]), "1. 有序");
    assert_eq!(text_of(&lines[3]), "  • 嵌套");
}

#[test]
fn blockquote_prefixes_gray_bar() {
    let lines = render("> 引用一句");
    assert_eq!(lines[0].spans[0].text, "▏ ");
    assert_eq!(lines[0].spans[0].style.color, MdColor::Gray);
    assert_eq!(lines[0].spans[1].text, "引用一句");
}

#[test]
fn table_pads_and_separates() {
    let lines = render("| A | B |\n|---|---|\n| 1 | 2 |");
    assert_eq!(lines.len(), 3);
    let header = text_of(&lines[0]);
    assert!(header.starts_with(&format!("{:<14}", "A")));
    assert!(header.contains(" │ "));
    assert!(lines[0].spans[0].style.bold);
    assert_eq!(lines[1].spans[0].style.color, MdColor::Gray);
    assert!(text_of(&lines[2]).starts_with(&format!("{:<14}", "1")));
}

#[test]
fn html_shows_literally_dimmed() {
    let lines = render("<br>换行");
    assert_eq!(text_of(&lines[0]), "<br>换行");
    assert!(lines[0].spans[0].style.dim);
}

#[test]
fn horizontal_rule() {
    let lines = render("上\n---\n下");
    assert_eq!(lines[1].spans[0].text, "─".repeat(40));
}

#[test]
fn images_render_as_placeholder() {
    let spans = inline("前 ![alt](https://img) 后", MdStyle::default());
    assert_eq!(spans[1].text, "[img] https://img");
    assert_eq!(spans[2].text, " 后");
}

#[test]
fn escapes_keep_literals() {
    let spans = inline("\\*不是斜体\\*", MdStyle::default());
    assert_eq!(spans.iter().map(|span| span.text.as_str()).collect::<String>(), "*不是斜体*");
    assert!(!spans[0].style.italic);
}

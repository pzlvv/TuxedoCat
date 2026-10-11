//! Markdown 子集渲染（`src/tui/render/markdown.tsx` 的移植，无 marked 依赖）。
//!
//! v1 控制在常用子集：标题 / 强调 / 行内代码 / 围栏代码 / 列表 / 引用 / 表格 /
//! 链接 / 分隔线；原生 HTML 片段按字面文本展示（终端无 DOM）；shiki ANSI 高亮不在
//! v1（待定项，见 docs/hosts/tui.md 第 11.2 节）。产出带样式的行，渲染层直接消费。

/// 行内样式（渲染层映射到 ratatui Style）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MdStyle {
    pub bold: bool,
    pub italic: bool,
    pub dim: bool,
    pub strikethrough: bool,
    pub underline: bool,
    pub color: MdColor,
}

/// 渲染映射表保持全色板完整（Red / Magenta 供扩展 token 使用）。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MdColor {
    #[default]
    None,
    Green,
    Cyan,
    Yellow,
    Gray,
    Blue,
    White,
    Red,
    Magenta,
}

#[derive(Debug, Clone)]
pub struct MdSpan {
    pub text: String,
    pub style: MdStyle,
}

#[derive(Debug, Clone, Default)]
pub struct MdLine {
    pub spans: Vec<MdSpan>,
}

impl MdLine {
    fn single(text: impl Into<String>, style: MdStyle) -> MdLine {
        MdLine { spans: vec![MdSpan { text: text.into(), style }] }
    }
    #[allow(dead_code)] // 测试辅助（markdown_tests 的 text_of）
    pub fn plain_text(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }
}

/// 解析 markdown 文本为带样式行（纯函数；无缓存——调用方按原文自行缓存）。
pub fn render(text: &str) -> Vec<MdLine> {
    let mut lines: Vec<MdLine> = Vec::new();
    let source: Vec<&str> = text.lines().collect();
    let mut index = 0;
    while index < source.len() {
        let line = source[index];

        // 围栏代码块
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            index += 1;
            while index < source.len() && !source[index].trim_start().starts_with("```") {
                lines.push(code_line(source[index]));
                index += 1;
            }
            index += 1; // 跳过收尾围栏（缺失时跳到末尾）
            continue;
        }

        // 表格：连续的 `|` 行
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            let mut table_rows: Vec<Vec<&str>> = Vec::new();
            while index < source.len() {
                let row = source[index].trim();
                if !(row.starts_with('|') && row.ends_with('|')) {
                    break;
                }
                table_rows.push(parse_table_row(row));
                index += 1;
            }
            push_table(&mut lines, &table_rows);
            continue;
        }

        // 分隔线
        if is_horizontal_rule(trimmed) {
            lines.push(MdLine::single("─".repeat(40), MdStyle { color: MdColor::Gray, ..Default::default() }));
            index += 1;
            continue;
        }

        // 标题
        if let Some(depth) = heading_depth(trimmed) {
            let color = match depth {
                1 => MdColor::Green,
                2 => MdColor::Cyan,
                _ => MdColor::White,
            };
            let style = MdStyle { bold: true, color, ..Default::default() };
            lines.push(MdLine { spans: inline(trimmed[depth..].trim_start(), style) });
            index += 1;
            continue;
        }

        // 引用
        if let Some(rest) = trimmed.strip_prefix('>') {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            let mut spans = vec![MdSpan { text: "▏ ".into(), style: MdStyle { color: MdColor::Gray, ..Default::default() } }];
            spans.extend(inline(rest, MdStyle::default()));
            lines.push(MdLine { spans });
            index += 1;
            continue;
        }

        // 列表（支持两级缩进嵌套；有序列表的序号沿用原文）
        if let Some((indent, marker)) = list_marker(line) {
            let item_text = line[indent + marker.len()..].trim_start();
            let bullet_style = MdStyle { color: MdColor::Yellow, ..Default::default() };
            let bullet = match marker.as_str() {
                "-" | "*" | "+" => "• ".to_string(),
                _ => format!("{marker} "),
            };
            let mut spans = vec![MdSpan {
                text: format!("{}{}", " ".repeat(indent / 2 * 2), bullet),
                style: bullet_style,
            }];
            spans.extend(inline(item_text, MdStyle::default()));
            lines.push(MdLine { spans });
            index += 1;
            continue;
        }

        // 空行
        if trimmed.is_empty() {
            lines.push(MdLine::default());
            index += 1;
            continue;
        }

        // 段落（含行内样式）
        lines.push(MdLine { spans: inline(line, MdStyle::default()) });
        index += 1;
    }
    lines
}

fn code_line(text: &str) -> MdLine {
    let style = MdStyle { color: MdColor::Cyan, ..Default::default() };
    let mut spans = vec![MdSpan { text: "│ ".into(), style }];
    spans.push(MdSpan { text: text.to_string(), style });
    MdLine { spans }
}

fn heading_depth(line: &str) -> Option<usize> {
    let depth = line.chars().take_while(|character| *character == '#').count();
    if (1..=6).contains(&depth) && line[depth..].starts_with(' ') {
        Some(depth)
    } else {
        None
    }
}

fn is_horizontal_rule(line: &str) -> bool {
    let compact: String = line.chars().filter(|character| !character.is_whitespace()).collect();
    (compact.starts_with("---") && compact.chars().all(|c| c == '-'))
        || (compact.starts_with("***") && compact.chars().all(|c| c == '*'))
}

fn list_marker(line: &str) -> Option<(usize, String)> {
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    for bullet in ["-", "*", "+"] {
        if rest.starts_with(bullet) && rest[1..].starts_with(' ') {
            return Some((indent, (*bullet).to_string()));
        }
    }
    // 有序列表：`12. `
    let digits = rest.chars().take_while(|character| character.is_ascii_digit()).count();
    if digits > 0 {
        let after = &rest[digits..];
        if after.starts_with(". ") {
            return Some((indent, rest[..digits + 1].to_string()));
        }
    }
    None
}

fn parse_table_row(row: &str) -> Vec<&str> {
    row[1..row.len() - 1].split('|').map(|cell| cell.trim()).collect()
}

fn push_table(lines: &mut Vec<MdLine>, rows: &[Vec<&str>]) {
    if rows.is_empty() {
        return;
    }
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    let render_row = |cells: &[&str], style: MdStyle| -> MdLine {
        let text: Vec<String> = (0..width)
            .map(|index| format!("{:<14}", cells.get(index).copied().unwrap_or("")))
            .collect();
        MdLine { spans: vec![MdSpan { text: text.join(" │ "), style }] }
    };
    let mut data_rows = rows;
    // 首行是表头；紧随的 `---` 分隔行跳过
    let header_style = MdStyle { bold: true, ..Default::default() };
    let header = data_rows.first().cloned().unwrap_or_default();
    lines.push(render_row(&header, header_style));
    data_rows = &data_rows[1..];
    if data_rows.first().map(|row| row.iter().all(|cell| cell.chars().all(|c| c == '-' || c == ':'))).unwrap_or(false) {
        lines.push(MdLine::single(
            "─".repeat(width * 16),
            MdStyle { color: MdColor::Gray, ..Default::default() },
        ));
        data_rows = &data_rows[1..];
    }
    for row in data_rows {
        lines.push(render_row(row, MdStyle::default()));
    }
}

// ==================== 行内解析 ====================

/// 行内解析：`**粗**` / `*斜*` / `~~删~~` / `` `码` `` / `[文](址)` / 图片 / HTML。
/// 未闭合的标记按字面文本处理（不丢内容）。
pub fn inline(text: &str, base: MdStyle) -> Vec<MdSpan> {
    let mut spans: Vec<MdSpan> = Vec::new();
    let mut plain = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut position = 0;

    while position < chars.len() {
        let rest: String = chars[position..].iter().collect();
        match next_token(&rest) {
            Some(Token::Code(content, consumed)) => {
                if !plain.is_empty() {
                    spans.push(MdSpan { text: std::mem::take(&mut plain), style: base });
                }
                spans.push(MdSpan { text: content, style: MdStyle { color: MdColor::Cyan, ..base } });
                position += consumed;
            }
            Some(Token::Delimited(marker, content, consumed)) => {
                if !plain.is_empty() {
                    spans.push(MdSpan { text: std::mem::take(&mut plain), style: base });
                }
                let style = match marker {
                    "**" => MdStyle { bold: true, ..base },
                    "~~" => MdStyle { strikethrough: true, dim: true, ..base },
                    _ => MdStyle { italic: true, ..base },
                };
                spans.extend(inline(&content, style));
                position += consumed;
            }
            Some(Token::Image(href, consumed)) => {
                if !plain.is_empty() {
                    spans.push(MdSpan { text: std::mem::take(&mut plain), style: base });
                }
                spans.push(MdSpan {
                    text: format!("[img] {href}"),
                    style: MdStyle { color: MdColor::Blue, underline: true, ..base },
                });
                position += consumed;
            }
            Some(Token::Link(label, href, consumed)) => {
                if !plain.is_empty() {
                    spans.push(MdSpan { text: std::mem::take(&mut plain), style: base });
                }
                let style = MdStyle { color: MdColor::Blue, underline: true, ..base };
                spans.extend(inline(&label, style));
                spans.push(MdSpan { text: format!(" ({href})"), style });
                position += consumed;
            }
            Some(Token::Html(tag, consumed)) => {
                if !plain.is_empty() {
                    spans.push(MdSpan { text: std::mem::take(&mut plain), style: base });
                }
                spans.push(MdSpan { text: tag, style: MdStyle { dim: true, ..base } });
                position += consumed;
            }
            Some(Token::Escaped(character, consumed)) => {
                plain.push(character);
                position += consumed;
            }
            None => {
                plain.push(chars[position]);
                position += 1;
            }
        }
    }
    if !plain.is_empty() {
        spans.push(MdSpan { text: plain, style: base });
    }
    spans
}

/// 行内记号（含消耗的 char 数；未闭合 / 非记号返回 None）。
enum Token {
    Code(String, usize),
    Delimited(&'static str, String, usize),
    Image(String, usize),
    Link(String, String, usize),
    Html(String, usize),
    Escaped(char, usize),
}

fn next_token(rest: &str) -> Option<Token> {
    // 转义（`\*` 等按字面取下一字符）
    let mut chars = rest.chars();
    if chars.next() == Some('\\') {
        let next = chars.next()?;
        return Some(Token::Escaped(next, 1 + next.len_utf8()));
    }
    // 行内代码（内部不再嵌套解析）
    if rest.starts_with('`') {
        if let Some((content, consumed)) = fenced_span(rest, '`') {
            return Some(Token::Code(content, consumed));
        }
    }
    for marker in ["**", "~~", "*"] {
        if let Some((content, consumed)) = delimited(rest, marker) {
            return Some(Token::Delimited(marker, content, consumed));
        }
    }
    if rest.starts_with("![") {
        if let Some((_, href, consumed)) = link_tag(rest) {
            return Some(Token::Image(href, consumed));
        }
    }
    if rest.starts_with('[') {
        if let Some((label, href, consumed)) = link_tag(rest) {
            return Some(Token::Link(label, href, consumed));
        }
    }
    if rest.starts_with('<') {
        if let Some(end) = rest.find('>') {
            return Some(Token::Html(rest[..=end].to_string(), rest[..=end].chars().count()));
        }
    }
    None
}

/// 取成对围栏（如 `` `code` ``）；未闭合返回 None。返回 (内容, 消耗的 char 数)。
fn fenced_span(text: &str, fence: char) -> Option<(String, usize)> {
    let mut chars = text.chars();
    if chars.next()? != fence {
        return None;
    }
    let mut content = String::new();
    let mut consumed = fence.len_utf8();
    for character in chars {
        if character == fence {
            return Some((content, consumed + fence.len_utf8()));
        }
        content.push(character);
        consumed += character.len_utf8();
    }
    None
}

/// 取成对标记（如 `**bold**`）；未闭合返回 None。返回 (内容, 消耗的 char 数)。
fn delimited(text: &str, marker: &str) -> Option<(String, usize)> {
    let rest = text.strip_prefix(marker)?;
    let end = rest.find(marker)?;
    if end == 0 {
        // 空内容不是强调（"**" 后紧跟同名标记应按字面处理）
        return None;
    }
    Some((rest[..end].to_string(), marker.chars().count() * 2 + rest[..end].chars().count()))
}

/// `[text](href)`；返回 (label, href, 消耗 char 数)。
fn link_tag(text: &str) -> Option<(String, String, usize)> {
    let close_label = text.find(']')?;
    if !text[close_label + 1..].starts_with('(') {
        return None;
    }
    let close_href = text[close_label + 2..].find(')')? + close_label + 2;
    Some((
        text[1..close_label].to_string(),
        text[close_label + 2..close_href].to_string(),
        text[..=close_href].chars().count(),
    ))
}

#[cfg(test)]
#[path = "markdown_tests.rs"]
mod tests;

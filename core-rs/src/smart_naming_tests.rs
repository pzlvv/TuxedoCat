//! `smart_naming.rs` 的用例。
//!
//! 覆盖三块纯逻辑：命名依据的收集（条数 / 截断 / 类型过滤）、标题解析的三级回退、
//! 以及「最后一个 JSON 对象」的反向扫描（模型先输出一段含花括号的思考是真实场景）。
//! LLM 调用本身由 `standaloneCoreEngine` 类的端到端测试覆盖。

use serde_json::json;

use super::*;

// ==================== 命名依据收集 ====================

#[test]
fn collects_user_and_assistant_text() {
    let messages = vec![
        json!({ "type": "user", "message": { "role": "user", "content": "帮我写个排序函数" } }),
        json!({ "type": "assistant", "message": { "content": [
            { "type": "thinking", "thinking": "先想一下" },
            { "type": "text", "text": "以下是实现" },
        ] } }),
    ];
    assert_eq!(
        collect_smart_naming_context(&messages),
        vec!["[用户]: 帮我写个排序函数".to_string(), "[助手]: 以下是实现".to_string()],
    );
}

#[test]
fn stops_after_five_entries() {
    let mut messages = Vec::new();
    for index in 0..8 {
        messages.push(json!({
            "type": "user",
            "message": { "role": "user", "content": format!("第 {index} 条") },
        }));
    }
    let collected = collect_smart_naming_context(&messages);
    assert_eq!(collected.len(), MAX_CONTENT_MESSAGES);
    assert_eq!(collected[0], "[用户]: 第 0 条");
    assert_eq!(collected[4], "[用户]: 第 4 条");
}

#[test]
fn counts_one_assistant_message_once_even_with_many_text_blocks() {
    let messages = vec![json!({ "type": "assistant", "message": { "content": [
        { "type": "text", "text": "a" },
        { "type": "text", "text": "b" },
        { "type": "text", "text": "c" },
    ] } })];
    // 每条 text block 各占一个名额
    assert_eq!(
        collect_smart_naming_context(&messages),
        vec!["[助手]: a".to_string(), "[助手]: b".to_string(), "[助手]: c".to_string()],
    );
}

#[test]
fn truncates_each_entry_to_five_hundred_utf16_units() {
    let long = "字".repeat(600);
    let messages = vec![json!({ "type": "user", "message": { "role": "user", "content": long } })];
    let collected = collect_smart_naming_context(&messages);
    // "[用户]: " 是 6 个 code unit，正文截到 500
    assert_eq!(crate::util::utf16_len(&collected[0]), 6 + MAX_CONTENT_CHARS);
}

#[test]
fn truncation_does_not_split_surrogate_pairs() {
    // 每个 emoji 是 2 个 UTF-16 code unit；上限 500 落在第 250 个 emoji 的边界上
    let text = "😀".repeat(300);
    let messages = vec![json!({ "type": "user", "message": { "role": "user", "content": text } })];
    let collected = collect_smart_naming_context(&messages);
    assert_eq!(crate::util::utf16_len(&collected[0]), 6 + MAX_CONTENT_CHARS);
    assert!(collected[0].chars().all(|ch| ch != '\u{fffd}'));
}

#[test]
fn ignores_non_text_and_empty_entries() {
    let messages = vec![
        json!({ "type": "system", "message": { "content": "系统提示" } }),
        json!({ "type": "user", "message": { "role": "user", "content": ["数组内容"] } }),
        json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "" },
            { "type": "tool_use", "name": "Bash" },
        ] } }),
    ];
    assert!(collect_smart_naming_context(&messages).is_empty());
}

// ==================== 标题解析 ====================

#[test]
fn parses_the_title_from_a_json_object() {
    assert_eq!(parse_smart_naming_title(r#"{"title": "Python排序函数"}"#), "Python排序函数");
}

#[test]
fn parses_the_title_from_a_fenced_json_block() {
    assert_eq!(
        parse_smart_naming_title("好的：\n```json\n{\"title\": \"查询天气\"}\n```"),
        "查询天气",
    );
}

#[test]
fn an_invalid_json_object_falls_through_to_the_last_line() {
    // 值里有未转义的引号：整段不是合法 JSON，正则也要求值后面直接跟 `}`，两条都不中
    assert_eq!(
        parse_smart_naming_title(r#"{"title": "a"b"}"#),
        r#"{"title": "a"b"}"#,
    );
}

#[test]
fn title_pattern_tolerates_loose_whitespace() {
    // `extract_title_pattern` 是 JSON 解析失败后的兜底（近乎不可达），
    // 这里直接断言它的匹配口径：键 / 冒号 / 值前后的空白都容忍，值不能为空。
    assert_eq!(
        extract_title_pattern("xx {  \"title\"  :  \"查询天气\"  } yy").unwrap(),
        "查询天气",
    );
    assert_eq!(extract_title_pattern(r#"{"title": ""}"#), None);
    assert_eq!(extract_title_pattern(r#"{"title": "x", }"#), None);
    assert_eq!(extract_title_pattern("没有 title"), None);
}

#[test]
fn title_pattern_uses_js_whitespace() {
    // TS 正则的 `\s` 是 ECMAScript WhiteSpace + LineTerminator：含 U+FEFF、不含 U+0085。
    // Rust `char::is_whitespace()` 恰好相反，因此这里必须用 `util::is_js_whitespace`。
    assert_eq!(extract_title_pattern("{\u{FEFF}\"title\": \"x\"}").unwrap(), "x");
    assert_eq!(extract_title_pattern("{\u{0085}\"title\": \"x\"}"), None);
}

#[test]
fn title_pattern_takes_the_first_match() {
    // TS 用的是非全局正则 + `String.prototype.match` → 取**第一个**匹配。
    assert_eq!(
        extract_title_pattern("{\"title\": \"A\"} {\"title\": \"B\"}").unwrap(),
        "A",
    );
}

#[test]
fn feff_prefixed_json_falls_back_to_the_title_pattern() {
    // `extractLastJsonObject` 用 serde_json 解析，U+FEFF 不是合法 JSON 空白 → 整段失败；
    // 随后正则兜底（JS 空白口径）能取到 title。Rust 若用 `is_whitespace` 会漏掉。
    assert_eq!(parse_smart_naming_title("{\u{FEFF}\"title\": \"x\"}"), "x");
    // 多个候选时取第一个（对齐 TS 的非全局正则）。
    assert_eq!(
        parse_smart_naming_title("{\u{FEFF}\"title\": \"A\"} {\u{FEFF}\"title\": \"B\"}"),
        "A",
    );
}

#[test]
fn falls_back_to_the_last_non_empty_line() {
    assert_eq!(parse_smart_naming_title("思考中\n\n  最终标题  \n"), "最终标题");
}

#[test]
fn falls_back_to_the_placeholder_for_empty_output() {
    assert_eq!(parse_smart_naming_title(""), FALLBACK_TITLE);
    assert_eq!(parse_smart_naming_title("   \n\n  "), FALLBACK_TITLE);
}

#[test]
fn last_line_fallback_truncates_to_fifty_units() {
    let line = "题".repeat(80);
    assert_eq!(crate::util::utf16_len(&parse_smart_naming_title(&line)), 50);
}

#[test]
fn ignores_a_json_object_without_a_string_title() {
    // title 不是字符串 → `extractLastJsonObject` 不认，退到最后一行
    assert_eq!(parse_smart_naming_title(r#"{"title": 42}"#), r#"{"title": 42}"#);
}

// ==================== 最后一个 JSON 对象 ====================

#[test]
fn takes_the_last_json_object() {
    let text = r#"先看 {"title": "旧的"} 再输出 {"title": "新的"}"#;
    assert_eq!(extract_last_json_object(text).unwrap(), r#"{"title": "新的"}"#);
}

#[test]
fn skips_braces_inside_strings() {
    let text = r#"{"note": "含 { 花括号", "title": "对"}"#;
    assert_eq!(extract_last_json_object(text).unwrap(), text);
}

#[test]
fn falls_back_to_an_earlier_object_when_the_last_is_unbalanced() {
    let text = r#"{"title": "可用的"} 后面是 { 没配平"#;
    assert_eq!(extract_last_json_object(text).unwrap(), r#"{"title": "可用的"}"#);
}

#[test]
fn returns_none_without_any_object() {
    assert!(extract_last_json_object("没有花括号").is_none());
    assert!(extract_last_json_object("").is_none());
}

// ==================== prompt ====================

#[test]
fn system_prompt_is_not_localized() {
    // 给模型的指令不随界面语言变化（固定中文 prompt）
    assert!(SMART_NAMING_SYSTEM_PROMPT.contains("你是一个对话标题生成器"));
    assert!(SMART_NAMING_SYSTEM_PROMPT.ends_with("只输出 JSON："));
}

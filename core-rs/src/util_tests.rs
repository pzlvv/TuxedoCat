//! `util` 的单元测试。
use super::*;

    #[test]
    fn hide_console_accepts_any_command() {
        // Windows 上设置 CREATE_NO_WINDOW，其它平台是空实现；只要不 panic 即可
        let mut command = Command::new("cmd.exe");
        command.arg("/c").arg("echo");
        hide_console(&mut command);
    }

    #[test]
    fn now_millis_is_a_recent_unix_timestamp() {
        // 2020-09-13 之后
        assert!(now_millis() > 1_600_000_000_000);
    }

    #[test]
    fn random_suffix_differs_between_calls() {
        let first = random_suffix();
        let second = random_suffix();
        assert_ne!(first, second);
        assert!(!first.is_empty());
        assert!(first.chars().all(|ch| ch.is_ascii_hexdigit()));
    }

    #[test]
    fn unique_id_has_prefix_and_timestamp() {
        let id = unique_id("msg");
        assert!(id.starts_with("msg_"), "got {id}");
        let parts: Vec<&str> = id.splitn(3, '_').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[1].parse::<u64>().unwrap() > 1_600_000_000_000);
    }

    #[test]
    fn truncate_chars_keeps_short_text_untouched() {
        assert_eq!(truncate_chars("hello", 10), "hello");
        assert_eq!(truncate_chars("hello", 5), "hello");
    }

    #[test]
    fn truncate_chars_counts_characters_not_bytes() {
        assert_eq!(truncate_chars("你好世界", 2), "你好");
        assert_eq!(truncate_chars("abc", 0), "");
    }

    #[test]
    fn truncate_bytes_keeps_short_text_untouched() {
        assert_eq!(truncate_bytes("hello", 10), "hello");
        assert_eq!(truncate_bytes("hello", 5), "hello");
    }

    #[test]
    fn truncate_bytes_stops_at_utf8_boundary() {
        // 每个汉字 3 字节，边界落在 0/3/6/9/12
        assert_eq!(truncate_bytes("你好世界", 7), "你好");
        assert_eq!(truncate_bytes("你好世界", 6), "你好");
        assert_eq!(truncate_bytes("你好世界", 0), "");
    }

    #[test]
    fn clamp_output_returns_text_within_budget() {
        assert_eq!(clamp_output("abcdef", 4, 4), "abcdef");
        assert_eq!(clamp_output("abcdefgh", 4, 4), "abcdefgh");
    }

    #[test]
    fn clamp_output_keeps_head_and_tail_with_omitted_count() {
        let text = format!("{}{}", "a".repeat(10), "b".repeat(10));
        assert_eq!(
            clamp_output(&text, 4, 4),
            "aaaa\n... (12 chars omitted) ...\nbbbb"
        );
    }

    #[test]
    fn clamp_output_counts_chars_not_bytes() {
        // 10 个汉字：按字符计 10，按字节计 30。头尾各 4 字符，省略 2 字符。
        let text = "你".repeat(10);
        let clamped = clamp_output(&text, 4, 4);
        assert_eq!(clamped, "你你你你\n... (2 chars omitted) ...\n你你你你");
        assert_eq!(clamped.chars().filter(|ch| *ch == '你').count(), 8);
    }

    #[test]
    fn clamp_output_drops_whole_surrogate_pair_at_boundary() {
        // 头 4 个 code unit 落在「a + 第 2 个 emoji」的中间：第 2 个 emoji 整对丢掉，
        // 实际头部只有 3 个 code unit，省略数要按实际边界算（不是 4+4）。
        let text = format!("a{}", "😀".repeat(10)); // 1 + 20 code unit
        let clamped = clamp_output(&text, 4, 4);
        assert_eq!(clamped, "a😀\n... (14 chars omitted) ...\n😀😀");
    }

    #[test]
    fn sanitize_json_surrogates_replaces_lone_escapes() {
        // 孤立低位 / 高位代理项 → U+FFFD
        assert_eq!(sanitize_json_surrogates(r#""\ude00""#), "\"\u{FFFD}\"");
        assert_eq!(sanitize_json_surrogates(r#""a\ud83db""#), "\"a\u{FFFD}b\"");
        // 合法代理对原样保留
        assert_eq!(
            sanitize_json_surrogates(r#""\ud83d\ude00""#),
            r#""\ud83d\ude00""#
        );
        // 字面量文本（`\\ude00`，前导反斜杠是奇数个）不能动
        assert_eq!(sanitize_json_surrogates(r#""\\ude00""#), r#""\\ude00""#);
        // 非代理项的 `\uXXXX` 转义不受影响
        assert_eq!(sanitize_json_surrogates(r#""\u0041\n""#), r#""\u0041\n""#);
        // 未闭合 / 非法 hex 不 panic
        assert_eq!(sanitize_json_surrogates(r#""\u00""#), r#""\u00""#);
        assert_eq!(sanitize_json_surrogates(r#""\uZZZZ""#), r#""\uZZZZ""#);
    }

    #[test]
    fn sanitize_json_surrogates_borrows_when_clean() {
        let text = r#"{"a":"普通文本","b":[1,2]}"#;
        assert!(matches!(
            sanitize_json_surrogates(text),
            std::borrow::Cow::Borrowed(_)
        ));
        // 含孤立代理项时才会分配
        assert!(matches!(
            sanitize_json_surrogates(r#""\ude00""#),
            std::borrow::Cow::Owned(_)
        ));
    }

    #[test]
    fn sanitized_json_is_parseable_by_serde_json() {
        // 宿主写坏的行：清洗后必须能被严格解析器读出来
        let broken = r#"{"text":"emoji 尾巴 \ude00","n":1}"#;
        assert!(serde_json::from_str::<serde_json::Value>(broken).is_err());
        let fixed = sanitize_json_surrogates(broken);
        let value: serde_json::Value = serde_json::from_str(&fixed).unwrap();
        assert_eq!(value["n"], 1);
        assert!(value["text"].as_str().unwrap().ends_with('\u{FFFD}'));
    }

    // ==================== 请求 token 估算（对齐 tokenEstimate.ts） ====================

    #[test]
    fn estimate_text_tokens_matches_table() {
        // 期望值锁定 `estimateTextTokens` 的既定判定表
        let cases: &[(&str, u64)] = &[
            ("", 0),
            ("abc", 1),
            ("hello world", 4),
            ("你好世界", 5),
            ("こんにちは", 6),
            ("a你b好c", 4),
            ("，。！？", 5),
            ("日本語のテキストです", 12),
            ("你你你你你你你你你你", 12),
        ];
        for (text, expected) in cases {
            assert_eq!(estimate_text_tokens(text), *expected, "text={text:?}");
        }
        // 100 个 ASCII：ceil(100/3) = 34
        assert_eq!(estimate_text_tokens(&"x".repeat(100)), 34);
    }

    #[test]
    fn estimate_request_tokens_matches_table() {
        // 期望值锁定 `estimateRequestTokens` 的既定输出
        let value = estimate_request_tokens(
            Some(&serde_json::json!([{ "role": "user", "content": "你好" }])),
            "sys",
            Some(&serde_json::json!([{ "name": "t" }])),
        );
        assert_eq!(value, 19);

        // Anthropic 内联图片：base64 数据被替换成占位符，只按固定成本补回
        let anthropic_image = serde_json::json!([{
            "type": "image",
            "source": { "type": "base64", "data": "A".repeat(2000) },
        }]);
        assert_eq!(
            estimate_request_tokens(Some(&anthropic_image), "", Some(&serde_json::json!([]))),
            1519
        );

        // OpenAI 的 image_url 是嵌套对象（url 字段），replacer 不替换，
        // 因此按整段 base64 估长——这里保持同口径
        let openai_image = serde_json::json!([{
            "role": "user",
            "content": [{ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", "B".repeat(3000)) } }],
        }]);
        assert_eq!(
            estimate_request_tokens(Some(&openai_image), "", None),
            1032
        );

        assert_eq!(estimate_request_tokens(None, "abc", None), 1);

        // JSON 序列化走 JS `JSON.stringify` 口径：整数值浮点写 `1`（不是 `1.0`），
        // 非 ASCII 长度按 UTF-16 code unit 计。期望值锁定 `estimateRequestTokens` 的既定输出。
        assert_eq!(
            estimate_request_tokens(
                Some(&serde_json::json!([{ "role": "user", "content": "中文" }])),
                "",
                None
            ),
            13
        );
        assert_eq!(
            estimate_request_tokens(
                Some(&serde_json::json!([
                    { "role": "user", "meta": { "temperature": 1.0, "top_p": 0.95 } }
                ])),
                "",
                Some(&serde_json::json!([]))
            ),
            19
        );
        assert_eq!(
            estimate_request_tokens(
                Some(&serde_json::json!([{ "role": "user", "content": "abc" }])),
                "系统提示",
                None
            ),
            16
        );
    }

#[test]
fn js_trim_follows_ecmascript_whitespace() {
    // U+0085（NEL）不在 ECMAScript WhiteSpace / LineTerminator 里：trim 不去
    assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
    assert_eq!(js_trim_end("x\u{85}"), "x\u{85}");
    // U+FEFF（ZWNBSP）在 JS 里算空白：trim 去掉
    assert_eq!(js_trim("\u{feff}x\u{feff}"), "x");
    assert_eq!(js_trim_end("x\u{feff}"), "x");
    // 常见空白
    assert_eq!(js_trim(" \t\n\r x \t\n\r "), "x");
    assert_eq!(js_trim("\u{a0}x\u{3000}"), "x");
    assert!(is_js_whitespace('\u{feff}'));
    assert!(is_js_whitespace('\u{00a0}'));
    assert!(!is_js_whitespace('\u{85}'));
}

#[test]
fn js_to_fixed_1_matches_ecmascript_to_fixed() {
    // 平局远离零进位（Rust `{:.1}` 用「四舍六入五成双」，1.25 会给 1.2）
    assert_eq!(js_to_fixed_1(1.25), "1.3");
    assert_eq!(js_to_fixed_1(2.25), "2.3");
    assert_eq!(js_to_fixed_1(1.75), "1.8");
    assert_eq!(js_to_fixed_1(-1.25), "-1.3");
    // 1.15 / 1.45 的 double 略小于十进制字面量，按实际值舍入
    assert_eq!(js_to_fixed_1(1.15), "1.1");
    assert_eq!(js_to_fixed_1(1.45), "1.4");
    assert_eq!(js_to_fixed_1(1.0), "1.0");
    assert_eq!(js_to_fixed_1(256.25), "256.3");
    assert_eq!(js_to_fixed_1(0.0), "0.0");
    // `|x| >= 1e21` 时 JS `toFixed` 退化成 `ToString(x)`
    assert_eq!(js_to_fixed_1(1e21), "1e+21");
    assert_eq!(js_to_fixed_1(-1.5e21), "-1.5e+21");
}

#[test]
fn js_string_joins_arrays_like_javascript() {
    // `Array.prototype.join` 把 null / undefined 元素变成空串（不是 "null" 字面量）
    let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap();
    assert_eq!(js_string(&parse("[1, null, 2]")), "1,,2");
    assert_eq!(js_string(&parse("[null]")), "");
    assert_eq!(js_string(&parse("[1, [2, null]]")), "1,2,");
    // 顶层 null 仍是 "null"（`String(null)`）
    assert_eq!(js_string(&parse("null")), "null");
    assert_eq!(js_string(&parse("{\"a\":1}")), "[object Object]");
}

#[test]
fn js_number_string_matches_ecmascript_number_to_string() {
    // JSON 文本里的 `1.0` / `1e2` 解析成 serde_json 的 Float，Display 会给 `1.0` /
    // `100.0`；JS 只有 double，`String(1.0)` 是 `1`。整数值的浮点必须走 ryu_js。
    let parse = |text: &str| serde_json::from_str::<Value>(text).unwrap();
    assert_eq!(js_string(&parse("1.0")), "1");
    assert_eq!(js_string(&parse("100.0")), "100");
    assert_eq!(js_json_stringify(&parse("1.0")), "1");
    assert_eq!(js_json_stringify(&parse("{\"n\":1.0}")), "{\"n\":1}");
    // 整数 / 普通浮点 / 指数阈值与 JS `Number.prototype.toString` 一致
    assert_eq!(js_string(&parse("1")), "1");
    assert_eq!(js_string(&parse("1.5")), "1.5");
    assert_eq!(js_string(&parse("1e21")), "1e+21");
    assert_eq!(js_string(&parse("1e-7")), "1e-7");
    assert_eq!(js_string(&parse("0.000001")), "0.000001");
    assert_eq!(js_string(&parse("-3")), "-3");
    // `String(-0)` 是 `"0"`（ECMAScript 规定 ±0 都返回 "0"）
    assert_eq!(js_string(&parse("-0.0")), "0");
}

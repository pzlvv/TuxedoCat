use serde_json::{json, Value};

use super::*;
    use crate::util::IMAGE_TOKEN_ESTIMATE;

/// 行为对照表（数据见 core-rs/fixtures/）。
const FIXTURE: &str = include_str!("../fixtures/responses.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("responsesParity.json 解析失败")
}

// ==================== 对照表 ====================

mod parity_tests {
    use super::*;

    #[test]
    fn responses_url_parity() {
        let fixture = fixture();
        for case in fixture["urls"].as_array().unwrap() {
            let base = case["baseURL"].as_str().unwrap();
            assert_eq!(
                build_responses_url(base),
                case["result"].as_str().unwrap(),
                "URL 不一致: {base}"
            );
        }
    }

    #[test]
    fn tool_conversion_parity() {
        let fixture = fixture();
        for case in fixture["tools"].as_array().unwrap() {
            let input = case["input"].as_array().unwrap();
            assert_eq!(
                Value::Array(convert_tools_to_responses_format(input)),
                case["result"],
                "工具转换不一致: {:?}",
                case["input"]
            );
        }
    }

    #[test]
    fn message_conversion_parity() {
        let fixture = fixture();
        for case in fixture["messages"].as_array().unwrap() {
            let input = case["input"].as_array().unwrap();
            assert_eq!(
                Value::Array(convert_messages_to_responses_input(input)),
                case["result"],
                "消息转换不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn status_mapping_parity() {
        let fixture = fixture();
        for case in fixture["statuses"].as_array().unwrap() {
            let status = case["status"].as_str();
            let reason = case["reason"].as_str();
            assert_eq!(
                map_responses_status(status, reason),
                case["result"].as_str().unwrap(),
                "status 映射不一致: {:?}",
                case["status"]
            );
        }
    }

    #[test]
    fn usage_extraction_parity() {
        let fixture = fixture();
        for case in fixture["usages"].as_array().unwrap() {
            let input = &case["input"];
            let expected = if case["result"].is_null() {
                None
            } else {
                Some(case["result"].clone())
            };
            let actual = extract_usage(if input.is_null() { None } else { Some(input) })
                .map(|usage| usage.to_json());
            assert_eq!(actual, expected, "usage 提取不一致: {input:?}");
        }
    }

    #[test]
    fn local_input_estimate_parity() {
        let fixture = fixture();
        for case in fixture["estimates"].as_array().unwrap() {
            let input = case["input"].as_array().unwrap();
            let system = case["system"].as_str();
            let tools = case["tools"].as_array().unwrap();
            assert_eq!(
                estimate_local_input_tokens(input, system, tools),
                case["result"].as_u64().unwrap(),
                "本地估算不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn usage_trust_parity() {
        let fixture = fixture();
        for case in fixture["skipUsage"].as_array().unwrap() {
            assert_eq!(
                should_skip_usage_for_context(
                    case["webSearchUsed"].as_bool().unwrap(),
                    case["inputTokens"].as_u64().unwrap(),
                    case["contextWindow"].as_u64().unwrap(),
                ),
                case["result"]["skip"].as_bool().unwrap(),
                "usage 可信度不一致: {case}"
            );
        }
    }

    #[test]
    fn output_sync_parity() {
        let fixture = fixture();
        for case in fixture["syncOutput"].as_array().unwrap() {
            let output = &case["output"];
            let blocks = sync_content_blocks_from_output(if output.is_null() {
                None
            } else {
                Some(output)
            });
            assert_eq!(
                Value::Array(blocks),
                case["result"],
                "output 校准不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }
}

// ==================== 单测 ====================

mod unit_tests {
    use super::*;

    #[test]
    fn assistant_max_text_chars_matches_spec() {
        assert_eq!(assistant_max_text_chars(), 40_000);
    }

    #[test]
    fn convert_messages_skips_null_and_unknown_blocks() {
        let messages = vec![json!({
            "role": "user",
            "content": [null, { "type": "unknown" }, { "type": "text", "text": "keep" }],
        })];
        let items = convert_messages_to_responses_input(&messages);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["content"].as_array().unwrap().len(), 1);
        assert_eq!(items[0]["content"][0]["text"], "keep");
    }

    #[test]
    fn convert_messages_handles_null_tool_result_content() {
        let messages = vec![json!({
            "role": "user",
            "content": [{ "type": "tool_result", "tool_use_id": "c1", "content": null }],
        })];
        let items = convert_messages_to_responses_input(&messages);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["type"], "function_call_output");
        // `JSON.stringify(content ?? '')`：null 先补成空串，stringify 后是 `""`（两个引号）
        assert_eq!(items[0]["output"], "\"\"");
    }

    #[test]
    fn convert_messages_tolerates_null_elements_in_tool_result_content() {
        // 单个 null 元素按 `JSON.stringify(null ?? '')` 处理，不让坏元素废掉整轮请求
        // 。
        let messages = vec![json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": "c1",
                "content": [null, { "type": "text", "text": "x" }],
            }],
        })];
        let items = convert_messages_to_responses_input(&messages);
        let output = items[0]["output"].as_array().expect("output 是数组");
        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["type"], "input_text");
        assert_eq!(output[0]["text"], "\"\"");
        assert_eq!(output[1]["text"], "x");
    }

    #[test]
    fn estimate_strips_every_image_data_url() {
        let input = vec![json!({
            "role": "user",
            "content": [
                { "type": "input_image", "image_url": "data:image/png;base64,AAAA" },
                { "type": "input_image", "image_url": "data:image/png;base64,BBBB" },
            ],
        })];
        let estimate = estimate_local_input_tokens(&input, None, &[]);
        // 两张图各按固定成本计；base64 本体不参与字符长度
        assert!(estimate >= 2 * IMAGE_TOKEN_ESTIMATE, "got {estimate}");
        assert!(estimate < 2 * IMAGE_TOKEN_ESTIMATE + 100, "got {estimate}");
    }

    #[test]
    fn skip_usage_boundary_is_inclusive_at_cap() {
        // 恰好等于 cap（60%）不算超限；多 1 才算
        assert!(!should_skip_usage_for_context(false, 60_000, 100_000));
        assert!(should_skip_usage_for_context(false, 60_001, 100_000));
        // web search 轮次一律跳过
        assert!(should_skip_usage_for_context(true, 1, 100_000));
        // 窗口为 0 时 cap 为 0，非零 input 即超限
        assert!(should_skip_usage_for_context(false, 1, 0));
        assert!(!should_skip_usage_for_context(false, 0, 0));
    }

    #[test]
    fn url_builder_handles_trailing_slashes() {
        assert_eq!(
            build_responses_url("https://x.dev/v1/"),
            "https://x.dev/v1/responses"
        );
        assert_eq!(
            build_responses_url("https://x.dev/"),
            "https://x.dev/v1/responses"
        );
        // 只有以 /v1 结尾才不再补 /v1
        assert_eq!(
            build_responses_url("https://x.dev/v1beta"),
            "https://x.dev/v1beta/v1/responses"
        );
    }

    #[test]
    fn parse_tool_arguments_keeps_raw_string_on_broken_json() {
        assert_eq!(
            parse_tool_arguments("{\"command\":\"ls\"}"),
            json!({ "command": "ls" })
        );
        assert_eq!(parse_tool_arguments("{broken"), json!("{broken"));
    }
}

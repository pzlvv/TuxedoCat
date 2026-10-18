use serde_json::{json, Value};

use super::*;
use crate::test_support::serial;

/// 行为对照表（数据见 core-rs/fixtures/）。
const FIXTURE: &str = include_str!("../fixtures/compact.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("compactParity.json 解析失败")
}

// ==================== 对照表 ====================

mod parity_tests {
    use super::*;

    #[test]
    fn format_messages_parity() {
        let fixture = fixture();
        for case in fixture["formatted"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            assert_eq!(
                format_messages_for_compact(messages),
                case["result"].as_str().unwrap(),
                "格式化不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn user_input_history_parity() {
        let fixture = fixture();
        for case in fixture["userHistory"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let history = get_user_input_history(messages);
            assert_eq!(
                Value::Array(history.clone()),
                case["history"],
                "用户输入历史不一致: {}",
                case["name"].as_str().unwrap()
            );
            assert_eq!(
                format_user_input_history(&history),
                case["result"].as_str().unwrap(),
                "用户输入历史格式化不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn user_input_entries_parity() {
        let fixture = fixture();
        for case in fixture["userInputEntries"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let entries = to_user_input_entries(&get_user_input_history(messages));
            assert_eq!(
                Value::Array(entries),
                case["result"],
                "用户输入条目不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn user_input_entry_formatting_parity() {
        let fixture = fixture();
        for case in fixture["userInputEntryFormatting"].as_array().unwrap() {
            let entries = case["entries"].as_array().unwrap();
            assert_eq!(
                format_user_input_entries(entries),
                case["result"].as_str().unwrap(),
                "用户输入条目格式化不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn user_input_history_selection_parity() {
        let fixture = fixture();
        for case in fixture["userInputHistorySelection"].as_array().unwrap() {
            let previous = case["previous"].as_array().unwrap();
            let region_inputs = case["regionInputs"].as_array().unwrap();
            let selected = select_user_input_history(
                previous,
                region_inputs,
                USER_INPUT_HISTORY_MAX,
                USER_INPUT_HISTORY_HEAD,
                USER_INPUT_HISTORY_TAIL,
            );
            assert_eq!(
                Value::Array(selected),
                case["result"],
                "用户输入历史选择不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn compact_user_input_history_parity() {
        let fixture = fixture();
        for case in fixture["compactUserInputHistory"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            assert_eq!(
                Value::Array(read_compact_user_input_history(messages)),
                case["result"],
                "读取摘要持久化历史不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn summary_prompt_parity() {
        let fixture = fixture();
        for case in fixture["summaryPrompts"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let custom = case["custom"].as_str();
            assert_eq!(
                generate_compact_summary_prompt(messages, custom),
                case["result"].as_str().unwrap(),
                "摘要 prompt 不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn compact_user_message_parity() {
        let fixture = fixture();
        for case in fixture["compactUserMessages"].as_array().unwrap() {
            assert_eq!(
                generate_compact_user_message(
                    case["summary"].as_str().unwrap(),
                    case["transcriptPath"].as_str(),
                    case["userInputHistory"].as_str(),
                ),
                case["result"].as_str().unwrap(),
                "压缩后 user 消息不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn auto_compact_threshold_parity() {
        let fixture = fixture();
        for case in fixture["thresholds"].as_array().unwrap() {
            let context_window = case["contextWindow"].as_u64().unwrap();
            let max_output = case["maxOutputTokens"].as_u64().unwrap();
            let expected = case["result"].as_f64().unwrap();
            let actual = get_auto_compact_threshold(context_window, max_output);
            assert!(
                (actual - expected).abs() < 1e-9,
                "阈值不一致: context={context_window} output={max_output} 期望 {expected} 实际 {actual}"
            );
        }
    }

    #[test]
    fn has_compactable_messages_parity() {
        let fixture = fixture();
        for case in fixture["compactable"].as_array().unwrap() {
            let messages = case["messages"].as_array().unwrap();
            let keep = case["keep"].as_u64().unwrap() as usize;
            assert_eq!(
                has_compactable_messages(messages, keep),
                case["result"].as_bool().unwrap(),
                "可压缩判定不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn build_post_compact_messages_parity() {
        let fixture = fixture();
        for case in fixture["postCompact"].as_array().unwrap() {
            let source = &case["result"];
            let result = CompactionResult {
                boundary_marker: source["boundaryMarker"].clone(),
                summary_messages: source["summaryMessages"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                messages_to_keep: source["messagesToKeep"]
                    .as_array()
                    .cloned(),
            };
            assert_eq!(
                Value::Array(build_post_compact_messages(&result)),
                case["messages"],
                "压缩后消息组装不一致: {}",
                case["name"].as_str().unwrap()
            );
        }
    }
}

// ==================== 单测 ====================

mod unit_tests {
    use super::*;

    fn assistant_with_tool_use(id: &str) -> Value {
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": id, "name": "Bash", "input": {} }],
            },
            "uuid": format!("a-{id}"),
        })
    }

    fn user_with_tool_result(id: &str, canceled: bool) -> Value {
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "ok",
                    "is_canceled": canceled,
                }],
            },
            "uuid": format!("r-{id}"),
        })
    }

    #[test]
    fn sanitize_keeps_paired_tools_untouched() {
        let messages = vec![assistant_with_tool_use("call_1"), user_with_tool_result("call_1", false)];
        assert_eq!(sanitize_tool_pairing(&messages), messages);
    }

    #[test]
    fn sanitize_drops_orphan_tool_result() {
        // 保留区里只剩 tool_result（其 tool_use 被截断到归档区）→ 整条消息丢弃
        let messages = vec![
            json!({ "type": "user", "message": { "role": "user", "content": "hi" }, "uuid": "u-1" }),
            user_with_tool_result("call_gone", false),
        ];
        let result = sanitize_tool_pairing(&messages);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0]["uuid"], "u-1");
    }

    #[test]
    fn sanitize_keeps_non_tool_result_blocks_in_orphan_message() {
        let messages = vec![json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    { "type": "tool_result", "tool_use_id": "call_gone", "content": "x" },
                    { "type": "text", "text": "keep me" },
                ],
            },
            "uuid": "u-1",
        })];
        let result = sanitize_tool_pairing(&messages);
        assert_eq!(result.len(), 1);
        let blocks = result[0]["message"]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["text"], "keep me");
    }

    #[test]
    fn sanitize_adds_canceled_result_for_orphan_tool_use() {
        let messages = vec![assistant_with_tool_use("call_open")];
        let result = sanitize_tool_pairing(&messages);
        assert_eq!(result.len(), 2, "应当补一条合成 tool_result");
        let block = &result[1]["message"]["content"][0];
        assert_eq!(block["type"], "tool_result");
        assert_eq!(block["tool_use_id"], "call_open");
        assert_eq!(block["is_canceled"], true);
        assert_eq!(
            block["content"],
            "[Compact interrupted] Tool execution was canceled during compaction."
        );
        assert!(result[1]["uuid"]
            .as_str()
            .unwrap()
            .starts_with("tool_compact_"));
    }

    #[test]
    fn clear_message_usage_only_touches_assistant_usage() {
        let with_usage = json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [], "usage": { "input_tokens": 10 } },
            "uuid": "a-1",
        });
        let cleared = clear_message_usage(&with_usage);
        assert!(cleared["message"]["usage"].is_null());

        let plain = json!({ "type": "user", "message": { "role": "user", "content": "hi" } });
        assert_eq!(clear_message_usage(&plain), plain);
    }

    #[test]
    fn boundary_content_matches_shape() {
        let text = generate_compact_boundary_content("auto", 0, Some("u-9"), "2024-01-02T03:04:05.006Z");
        assert_eq!(
            text,
            "[Auto compaction boundary] 2024-01-02T03:04:05.006Z | ~0 tokens before compaction | last message: u-9"
        );
        let manual = generate_compact_boundary_content("manual", 1234, None, "2024-01-02T03:04:05.006Z");
        assert_eq!(manual, "[Manual compaction boundary] 2024-01-02T03:04:05.006Z | ~1234 tokens before compaction");
    }

    #[test]
    fn iso_now_is_a_valid_iso_string() {
        let text = iso_now();
        assert_eq!(text.len(), 24, "got {text}");
        assert!(text.ends_with('Z'));
        assert_eq!(&text[4..5], "-");
        assert_eq!(&text[10..11], "T");
    }

    #[test]
    fn auto_compact_gate_checks_env_circuit_breaker_and_threshold() {
        let _guard = serial();
        // 阈值：1M 上下文 - min(50K, 0.3*384K=115.2K) = 1M - 50K
        let context = 1024 * 1024;
        let output = 384 * 1024;
        let threshold = get_auto_compact_threshold(context, output) as u64;

        assert!(!should_auto_compact(None, None, context, output), "缺 token 数不触发");
        assert!(!should_auto_compact(None, Some(threshold - 1), context, output));
        assert!(should_auto_compact(None, Some(threshold), context, output));

        let broken = AutoCompactTracking {
            consecutive_failures: MAX_CONSECUTIVE_FAILURES,
            ..Default::default()
        };
        assert!(
            !should_auto_compact(Some(&broken), Some(threshold + 1), context, output),
            "熔断后不再触发"
        );

        std::env::set_var("DISABLE_AUTO_COMPACT", "true");
        assert!(!is_auto_compact_enabled());
        assert!(!should_auto_compact(None, Some(threshold + 1), context, output));
        std::env::remove_var("DISABLE_AUTO_COMPACT");
        assert!(is_auto_compact_enabled());
    }

    #[test]
    fn compacting_registry_tracks_sessions() {
        let _guard = serial();
        reset_for_test();
        assert!(!is_compacting("s1"));
        mark_compacting("s1");
        assert!(is_compacting("s1"));
        assert!(!is_compacting("s2"));
        // 重复标记不产生重复条目
        mark_compacting("s1");
        assert_eq!(COMPACTING.lock().unwrap().len(), 1);
        unmark_compacting("s1");
        assert!(!is_compacting("s1"));

        assert!(!is_pending_compact("s1"));
        mark_pending_compact("s1");
        mark_pending_compact("s1");
        assert!(is_pending_compact("s1"));
        assert_eq!(PENDING_COMPACT.lock().unwrap().len(), 1);
        unmark_pending_compact("s1");
        assert!(!is_pending_compact("s1"));
    }

    #[test]
    fn reminder_detection_is_case_insensitive() {
        assert!(is_reminder_text(""));
        assert!(is_reminder_text("   "));
        assert!(is_reminder_text("<reminder>hi</reminder>"));
        assert!(is_reminder_text("text <REMINDER>"));
        assert!(is_reminder_text("</Reminder>"));
        assert!(!is_reminder_text("普通文本"));
        assert!(!is_reminder_text("a < b"));
    }

    #[test]
    fn extract_user_content_handles_strings_arrays_and_nulls() {
        let message = json!({ "message": { "content": "plain" } });
        assert_eq!(extract_user_content(&message), "plain");

        let message = json!({
            "message": {
                "content": [
                    { "type": "text", "text": "a" },
                    { "type": "tool_result", "content": "ignored" },
                    { "type": "text", "text": "b" },
                ],
            }
        });
        assert_eq!(extract_user_content(&message), "a\nb");

        let message = json!({ "message": { "content": null } });
        assert_eq!(extract_user_content(&message), "");
        let message = json!({ "message": {} });
        assert_eq!(extract_user_content(&message), "");
    }
}

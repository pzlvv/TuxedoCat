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
                    case["runningTasks"].as_str(),
                    case["loadedSkills"].as_str(),
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
                messages_to_keep: source["messagesToKeep"].as_array().cloned(),
                post_compact_tokens: 0,
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
        let messages = vec![
            assistant_with_tool_use("call_1"),
            user_with_tool_result("call_1", false),
        ];
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
        let text =
            generate_compact_boundary_content("auto", 0, Some("u-9"), "2024-01-02T03:04:05.006Z");
        assert_eq!(
            text,
            "[Auto compaction boundary] 2024-01-02T03:04:05.006Z | ~0 tokens before compaction | last message: u-9"
        );
        let manual =
            generate_compact_boundary_content("manual", 1234, None, "2024-01-02T03:04:05.006Z");
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

        assert!(
            !should_auto_compact(None, None, context, output),
            "缺 token 数不触发"
        );
        assert!(!should_auto_compact(
            None,
            Some(threshold - 1),
            context,
            output
        ));
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
        assert!(!should_auto_compact(
            None,
            Some(threshold + 1),
            context,
            output
        ));
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
        // 取走是原子的一步：第一次成功、第二次（另一消费方）失败
        assert!(take_pending_compact("s1"));
        assert!(!is_pending_compact("s1"));
        assert!(!take_pending_compact("s1"));
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

// ==================== 运行中任务章节的剥离 ====================

mod strip_running_tasks_tests {
    use super::*;

    /// 章节从「用户输入历史」之后、固定尾注之前剥掉，其余正文逐字保留。
    #[test]
    fn strips_the_section_between_history_and_the_trailer() {
        let section =
            crate::bash_task::build_running_tasks_section(&[crate::bash_task::RunningTask {
                task_id: "bg-1".to_string(),
                description: "跑测试".to_string(),
                command: "npm test".to_string(),
                pid: 1,
                start_time: 0,
            }])
            .expect("非空集应有章节");
        let summary =
            generate_compact_user_message("SUM", None, Some("1. hi"), Some(&section), None);

        let stripped = strip_running_tasks_section(&summary);
        assert!(!stripped.contains("### 后台任务"), "{stripped}");
        assert!(
            !stripped.contains("bg-1"),
            "陈旧 taskId 不应留下: {stripped}"
        );
        // 摘要正文、用户输入历史、固定尾注都还在
        assert!(stripped.contains("SUM"), "{stripped}");
        assert!(stripped.contains("### 用户输入历史"), "{stripped}");
        assert!(stripped.contains("1. hi"), "{stripped}");
        assert!(stripped.contains("请基于以上摘要继续工作"), "{stripped}");
    }

    #[test]
    fn leaves_text_without_the_section_unchanged() {
        let plain = generate_compact_user_message("SUM", None, Some("1. hi"), None, None);
        assert_eq!(strip_running_tasks_section(&plain), plain);
    }

    /// 只有章节、没有其它正文时剥成空串，不留孤立的空行。
    #[test]
    fn strips_the_section_when_it_is_the_whole_body() {
        let section =
            crate::bash_task::build_running_tasks_section(&[crate::bash_task::RunningTask {
                task_id: "bg-1".to_string(),
                description: "跑测试".to_string(),
                command: "跑测试".to_string(),
                pid: 1,
                start_time: 0,
            }])
            .expect("非空集应有章节");
        assert_eq!(strip_running_tasks_section(&section), "");
    }
}

// ==================== 已加载技能随压缩携带（FR-007） ====================

mod loaded_skills_tests {
    use super::*;
    use std::path::Path;

    /// 在 `<cwd>/.agents/skills/<name>/SKILL.md` 写一个技能
    fn write_skill(cwd: &Path, name: &str, body: &str) {
        let dir = cwd.join(".agents").join("skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("SKILL.md"),
            format!("---\ndescription: {name} 的描述\n---\n\n{body}\n"),
        )
        .unwrap();
    }

    fn skill_tool_use(name: &str, args: Option<&str>, uuid: &str) -> Value {
        let input = match args {
            Some(args) => json!({ "skill": name, "args": args }),
            None => json!({ "skill": name }),
        };
        json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": format!("tu-{uuid}"), "name": "Skill", "input": input }
            ] },
            "uuid": uuid,
            "timestamp": 1,
        })
    }

    fn skill_body_message(name: &str) -> Value {
        json!({
            "type": "user",
            "message": { "role": "user", "content": "技能正文" },
            "uuid": format!("body-{name}"),
            "timestamp": 2,
            "isMeta": true,
            "skillName": name,
        })
    }

    #[test]
    fn records_are_collected_from_skill_tool_uses_in_order() {
        let region = vec![skill_tool_use("alpha", None, "a-1")];
        let keep = vec![skill_tool_use("beta", Some("x y"), "b-1")];
        let records = collect_loaded_skill_records(&[], &region, &keep);
        assert_eq!(
            records,
            vec![
                LoadedSkillRecord {
                    name: "alpha".to_string(),
                    args: String::new()
                },
                LoadedSkillRecord {
                    name: "beta".to_string(),
                    args: "x y".to_string()
                },
            ]
        );
    }

    /// 同名技能跨代 / 跨区段只留最近一次，且参数取最近那次的。
    #[test]
    fn records_dedupe_by_name_keeping_the_latest() {
        let persisted = vec![json!({ "name": "alpha", "args": "old" })];
        let region = vec![skill_tool_use("alpha", Some("mid"), "a-1")];
        let keep = vec![skill_tool_use("alpha", Some("new"), "a-2")];
        let records = collect_loaded_skill_records(&persisted, &region, &keep);
        assert_eq!(records.len(), 1, "{records:?}");
        assert_eq!(records[0].args, "new");
    }

    /// 持久化字段形态非法（缺 name / 类型不对）逐条忽略，等价于「无历史记录」。
    #[test]
    fn malformed_persisted_entries_are_ignored() {
        let messages = vec![json!({
            "type": "user",
            "isCompactSummary": true,
            "message": { "role": "user", "content": "摘要" },
            "compactLoadedSkills": [
                { "args": "缺名字" },
                { "name": 42 },
                { "name": "  " },
                { "name": "ok", "args": "a" },
                "不是对象",
            ],
        })];
        let values = read_compact_loaded_skills(&messages);
        assert_eq!(values, vec![json!({ "name": "ok", "args": "a" })]);
    }

    #[test]
    fn absent_field_reads_as_empty_history() {
        let messages = vec![json!({
            "type": "user",
            "isCompactSummary": true,
            "message": { "role": "user", "content": "摘要" },
        })];
        assert!(read_compact_loaded_skills(&messages).is_empty());
    }

    /// 保留区判据只看 `skillName` 标记，不比对内容。
    #[test]
    fn keep_region_names_come_from_the_injection_marker() {
        let keep = vec![
            skill_body_message("alpha"),
            json!({ "type": "user", "message": { "role": "user", "content": "x" } }),
            skill_body_message("alpha"),
        ];
        assert_eq!(keep_region_skill_names(&keep), vec!["alpha".to_string()]);
    }

    fn records(names: &[&str]) -> Vec<LoadedSkillRecord> {
        names
            .iter()
            .map(|name| LoadedSkillRecord {
                name: (*name).to_string(),
                args: String::new(),
            })
            .collect()
    }

    /// 没有记录 / 全部仍在保留区 → 不出章节（摘要正文逐字节不变）。
    #[test]
    fn section_is_absent_without_reloadable_records() {
        let cwd = std::path::PathBuf::from(".");
        assert_eq!(build_loaded_skills_section(&[], &[], ".", "s1"), None);
        assert_eq!(
            build_loaded_skills_section(&records(&["alpha"]), &["alpha".to_string()], ".", "s1"),
            None
        );
        let _ = cwd;
    }

    /// 章节按「最近调用优先」排列，标题与前言在里面，正文来自磁盘。
    #[test]
    fn section_lists_recent_skills_first_with_body_from_disk() {
        let sandbox = crate::test_support::Sandbox::new("compact-loaded-skills");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        write_skill(&sandbox.workspace, "alpha", "ALPHA 正文");
        write_skill(&sandbox.workspace, "beta", "BETA 正文");

        let section = build_loaded_skills_section(&records(&["alpha", "beta"]), &[], &cwd, "s1")
            .expect("有记录就应有章节");
        assert!(section.starts_with(LOADED_SKILLS_HEADING), "{section}");
        let beta_at = section.find("#### beta").expect("beta 应在章节里");
        let alpha_at = section.find("#### alpha").expect("alpha 应在章节里");
        assert!(beta_at < alpha_at, "最近调用的排前面: {section}");
        assert!(section.contains("ALPHA 正文"), "{section}");
        assert!(section.contains("BETA 正文"), "{section}");
    }

    /// 磁盘内容改了，重挂取新版（不是调用时的旧副本）。
    #[test]
    fn section_renders_the_current_file_content() {
        let sandbox = crate::test_support::Sandbox::new("compact-loaded-skills-fresh");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        write_skill(&sandbox.workspace, "alpha", "旧正文");
        write_skill(&sandbox.workspace, "alpha", "新正文");

        let section = build_loaded_skills_section(&records(&["alpha"]), &[], &cwd, "s1")
            .expect("有记录就应有章节");
        assert!(section.contains("新正文"), "{section}");
        assert!(!section.contains("旧正文"), "{section}");
    }

    /// 技能被删 / 解析不到：不进正文，但点名说明，压缩不失败。
    #[test]
    fn missing_skill_is_named_instead_of_silently_dropped() {
        let sandbox = crate::test_support::Sandbox::new("compact-loaded-skills-missing");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        write_skill(&sandbox.workspace, "alpha", "ALPHA 正文");

        let section = build_loaded_skills_section(&records(&["alpha", "gone"]), &[], &cwd, "s1")
            .expect("有一个能读出来就应有章节");
        assert!(section.contains("ALPHA 正文"), "{section}");
        assert!(section.contains("无法重新读取"), "{section}");
        assert!(section.contains("gone"), "缺席技能要点名: {section}");
        assert!(!section.contains("#### gone"), "{section}");
    }

    /// 单项超限：保留开头 + 截断说明行（不静默截断）。
    #[test]
    fn oversized_skill_is_truncated_with_a_note() {
        let sandbox = crate::test_support::Sandbox::new("compact-loaded-skills-truncate");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        // 20_000 个汉字 ≈ 24_000 token，远超单项上限
        write_skill(&sandbox.workspace, "huge", &"长".repeat(20_000));

        let section =
            build_loaded_skills_section(&records(&["huge"]), &[], &cwd, "s1").expect("应有章节");
        assert!(section.contains("已截断"), "{section}");
        assert!(section.contains("单项上限"), "{section}");
        // 正文被截到单项上限以内
        let body_start = section.find("#### huge").unwrap();
        assert!(
            crate::util::estimate_text_tokens(&section[body_start..]) <= COMPACT_SKILL_MAX_TOKENS,
            "单项正文应落在上限内"
        );
    }

    /// 总量溢出：整项放弃最旧的，并把被放弃的技能逐个点名。
    #[test]
    fn budget_overflow_drops_the_oldest_and_names_them() {
        let sandbox = crate::test_support::Sandbox::new("compact-loaded-skills-budget");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        // 每个技能 ~4_700 token（汉字按 1.2 计）：6 个超总量，最旧的应被挤掉
        for name in ["s1", "s2", "s3", "s4", "s5", "s6"] {
            write_skill(&sandbox.workspace, name, &"内".repeat(3_900));
        }
        let names: Vec<&str> = vec!["s1", "s2", "s3", "s4", "s5", "s6"];
        let section =
            build_loaded_skills_section(&records(&names), &[], &cwd, "s1").expect("应有章节");
        assert!(
            section.contains("总量预算"),
            "溢出要有说明行: {}",
            &section[..200.min(section.len())]
        );
        // 最近调用的一定在，最旧的被点名
        assert!(section.contains("#### s6"), "最近调用的必须重挂");
        assert!(section.contains("s1"), "被挤出的最旧技能要点名");
    }
}

mod strip_loaded_skills_tests {
    use super::*;

    fn summary_with_loaded_skills() -> String {
        let section = format!(
            "{LOADED_SKILLS_HEADING}\n\n{LOADED_SKILLS_PREAMBLE}\n\n#### fix\n\n正文里有\n\n## 自带标题\n\n与\n\n---\n\n分隔线"
        );
        generate_compact_user_message("SUM", None, Some("1. hi"), None, Some(&section))
    }

    /// 章节是最后一个：从标题一直剥到尾注，正文里自带的标题 / 分隔线不提前收手。
    #[test]
    fn strips_the_whole_section_keeping_the_footer() {
        let stripped = strip_loaded_skills_section(&summary_with_loaded_skills());
        assert!(!stripped.contains(LOADED_SKILLS_HEADING), "{stripped}");
        assert!(
            !stripped.contains("自带标题"),
            "技能正文不该残留: {stripped}"
        );
        assert!(!stripped.contains("正文里有"), "{stripped}");
        assert!(stripped.contains("SUM"), "{stripped}");
        assert!(stripped.contains("### 用户输入历史"), "{stripped}");
        assert!(stripped.contains("请基于以上摘要继续工作"), "{stripped}");
    }

    #[test]
    fn absent_section_leaves_text_unchanged() {
        let plain = generate_compact_user_message("SUM", None, Some("1. hi"), None, None);
        assert_eq!(strip_loaded_skills_section(&plain), plain);
    }

    /// 正文里偶然提到标题文字（不在行首）不算章节。
    #[test]
    fn inline_mention_is_not_treated_as_the_section() {
        let text = format!(
            "以下是之前对话的摘要：\n\n提到 {LOADED_SKILLS_HEADING} 这串字\n\n{COMPACT_FOOTER}"
        );
        assert_eq!(strip_loaded_skills_section(&text), text);
    }
}

//! `history` 的单元测试：会话文件读写、消息回放、标题推导。

use super::*;
use crate::test_support::Sandbox;
use serde_json::json;

const PROJECT: &str = "D:/repo/demo";

fn user_message(text: &str, uuid: &str) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": { "role": "user", "content": text },
    })
}

#[test]
fn session_paths_live_in_the_project_directory() {
    let sandbox = Sandbox::new("history-paths");
    let dir = sandbox.conversation_dir(PROJECT);
    assert_eq!(metadata_path("s1", PROJECT).unwrap(), dir.join("s1.meta.json"));
    assert_eq!(messages_path("s1", PROJECT).unwrap(), dir.join("s1.jsonl"));
}

#[test]
fn session_ids_with_separators_or_dots_are_rejected() {
    let _sandbox = Sandbox::new("history-bad-session-id");
    for bad in ["../evil", "a/b", "a\\b", "..", "."] {
        assert!(metadata_path(bad, PROJECT).is_err(), "metadata_path({bad})");
        assert!(messages_path(bad, PROJECT).is_err(), "messages_path({bad})");
        assert!(delete_conversation(bad, PROJECT).is_err(), "delete({bad})");
    }
    assert!(metadata_path("ok-id", PROJECT).is_ok());
}

#[test]
fn update_metadata_coerces_non_object_metadata_instead_of_panicking() {
    let sandbox = Sandbox::new("history-non-object-meta");
    let dir = sandbox.conversation_dir(PROJECT);
    std::fs::write(dir.join("weird.meta.json"), "[]").unwrap();
    let updated = update_metadata(
        "weird",
        PROJECT,
        || json!({ "sessionId": "weird" }),
        |metadata| {
            metadata["title"] = json!("ok");
        },
    )
    .unwrap();
    assert_eq!(updated["title"], "ok");
    assert_eq!(load_metadata("weird", PROJECT).unwrap()["title"], "ok");
}

#[test]
fn load_metadata_returns_none_for_missing_or_broken_files() {
    let sandbox = Sandbox::new("history-load-meta");
    assert!(load_metadata("missing", PROJECT).is_none());

    let dir = sandbox.conversation_dir(PROJECT);
    std::fs::write(dir.join("broken.meta.json"), "{ not json").unwrap();
    assert!(load_metadata("broken", PROJECT).is_none());

    std::fs::write(dir.join("ok.meta.json"), json!({ "sessionId": "ok" }).to_string()).unwrap();
    assert_eq!(load_metadata("ok", PROJECT).unwrap()["sessionId"], "ok");
}

#[test]
fn update_metadata_seeds_from_fallback_then_reads_modify_writes() {
    let _sandbox = Sandbox::new("history-update-meta");
    let created = update_metadata(
        "s1",
        PROJECT,
        || json!({ "sessionId": "s1", "title": "" }),
        |metadata| metadata["messageCount"] = json!(1),
    )
    .unwrap();
    assert_eq!(created["sessionId"], "s1");
    assert_eq!(created["messageCount"], 1);

    // 第二次调用沿用盘上的内容（fallback 不再生效）
    let updated = update_metadata(
        "s1",
        PROJECT,
        || json!({ "sessionId": "SHOULD-NOT-BE-USED" }),
        |metadata| metadata["title"] = json!("新标题"),
    )
    .unwrap();
    assert_eq!(updated["sessionId"], "s1");
    assert_eq!(updated["title"], "新标题");
    assert_eq!(load_metadata("s1", PROJECT).unwrap()["messageCount"], 1);
}

#[test]
fn create_conversation_writes_meta_and_keeps_existing_messages() {
    let sandbox = Sandbox::new("history-create");
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "title": "" })).unwrap();
    let dir = sandbox.conversation_dir(PROJECT);
    assert!(dir.join("s1.meta.json").is_file());
    assert_eq!(std::fs::read_to_string(dir.join("s1.jsonl")).unwrap(), "");

    std::fs::write(dir.join("s1.jsonl"), "existing\n").unwrap();
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "title": "again" })).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("s1.jsonl")).unwrap(), "existing\n");
    assert_eq!(load_metadata("s1", PROJECT).unwrap()["title"], "again");
}

#[test]
fn delete_conversation_removes_all_related_files() {
    let sandbox = Sandbox::new("history-delete");
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1" })).unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();
    let dir = sandbox.conversation_dir(PROJECT);
    std::fs::write(dir.join("s1.compact_archive.jsonl"), "archived").unwrap();

    delete_conversation("s1", PROJECT).unwrap();
    assert!(!dir.join("s1.meta.json").exists());
    assert!(!dir.join("s1.jsonl").exists());
    assert!(!dir.join("s1.compact_archive.jsonl").exists());
    // 删除不存在的会话不报错
    delete_conversation("s1", PROJECT).unwrap();
}

#[test]
fn delete_conversation_also_removes_sub_conversations() {
    // 对齐 Embedded `deleteConversation`：沿 `parentSessionId` 递归删除子孙对话
    // （子代理可以再起子代理，链可以任意深）。
    let sandbox = Sandbox::new("history-delete-closure");
    let dir = sandbox.conversation_dir(PROJECT);
    for (id, parent) in [
        ("root", None),
        ("child", Some("root")),
        ("grandchild", Some("child")),
        ("unrelated", None),
    ] {
        let mut metadata = json!({ "sessionId": id });
        if let Some(parent) = parent {
            metadata["parentSessionId"] = json!(parent);
        }
        create_conversation(id, PROJECT, metadata).unwrap();
        append_message(id, PROJECT, &user_message("hi", "u1"), None).unwrap();
    }

    delete_conversation("root", PROJECT).unwrap();

    for id in ["root", "child", "grandchild"] {
        assert!(!dir.join(format!("{id}.meta.json")).exists(), "{id} meta 未删除");
        assert!(!dir.join(format!("{id}.jsonl")).exists(), "{id} jsonl 未删除");
    }
    // 与 root 无父子关系的会话必须保留
    assert!(dir.join("unrelated.meta.json").exists());
    assert!(dir.join("unrelated.jsonl").exists());
}

#[test]
fn clear_conversation_keeps_metadata_but_drops_messages() {
    let sandbox = Sandbox::new("history-clear");
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "title": "标题" })).unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();
    clear_conversation("s1", PROJECT).unwrap();

    assert!(load_messages("s1", PROJECT).is_empty());
    assert_eq!(load_metadata("s1", PROJECT).unwrap()["title"], "标题");
    assert!(sandbox.conversation_dir(PROJECT).join("s1.jsonl").is_file());
}

#[test]
fn append_message_records_uuid_parent_and_timestamp() {
    let _sandbox = Sandbox::new("history-append");
    let first = append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();
    assert_eq!(first, "u1");

    let second = append_message("s1", PROJECT, &user_message("again", "u2"), Some(&first)).unwrap();
    assert_eq!(second, "u2");

    let records: Vec<Value> = std::fs::read_to_string(messages_path("s1", PROJECT).unwrap())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records.len(), 2);
    assert!(records[0]["parentUuid"].is_null());
    assert_eq!(records[1]["parentUuid"], "u1");
    assert!(records[0]["timestamp"].as_u64().unwrap() > 1_600_000_000_000);
    // 落盘是「信封 + 消息」两层：信封带 uuid/parentUuid/timestamp，消息是内部消息本体
    assert_eq!(records[0]["message"]["uuid"], "u1");
    assert_eq!(records[0]["message"]["message"]["content"], "hi");

    // 读回来的是内部消息本体（与 Embedded 的 loadConversation 一致）
    let loaded = load_messages("s1", PROJECT);
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0]["uuid"], "u1");
    assert_eq!(loaded[0]["message"]["content"], "hi");
    assert_eq!(loaded[1]["message"]["content"], "again");
}

#[test]
fn append_message_generates_a_uuid_when_absent() {
    let _sandbox = Sandbox::new("history-append-uuid");
    let message = json!({ "type": "user", "message": { "role": "user", "content": "hi" } });
    let uuid = append_message("s1", PROJECT, &message, None).unwrap();
    assert!(uuid.starts_with("s1_"), "got {uuid}");
    // 生成的 uuid 落在信封上；入参没有 uuid 时内部消息本体不带
    let raw: Value = serde_json::from_str(
        std::fs::read_to_string(messages_path("s1", PROJECT).unwrap()).unwrap().trim(),
    )
    .unwrap();
    assert_eq!(raw["uuid"], uuid);
}

#[test]
fn load_messages_returns_empty_without_a_file() {
    let _sandbox = Sandbox::new("history-load-empty");
    assert!(load_messages("nope", PROJECT).is_empty());
}

#[test]
fn load_messages_skips_blank_and_malformed_lines() {
    let sandbox = Sandbox::new("history-load-lines");
    let dir = sandbox.conversation_dir(PROJECT);
    let record = json!({
        "uuid": "u1",
        "parentUuid": Value::Null,
        "timestamp": 1,
        "message": { "type": "user", "message": { "role": "user", "content": "hi" } },
    });
    std::fs::write(
        dir.join("s1.jsonl"),
        format!("{record}\n\n   \n{{ broken\n"),
    )
    .unwrap();

    let messages = load_messages("s1", PROJECT);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["message"]["content"], "hi");
}

#[test]
fn load_messages_replays_tool_use_updates_in_order() {
    let sandbox = Sandbox::new("history-replay");
    let dir = sandbox.conversation_dir(PROJECT);
    let assistant = json!({
        "uuid": "a1",
        "timestamp": 1,
        "message": {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "old" } },
                    { "type": "tool_use", "id": "t2", "name": "Read", "input": {} }
                ]
            }
        }
    });
    let update_one = json!({
        "type": "tool_use_update", "toolUseId": "t1",
        "input": { "command": "new" }, "meta": { "status": "running" }
    });
    let update_two = json!({
        "type": "tool_use_update", "toolUseId": "t2",
        "input": { "file_path": "a.txt" }
    });
    // tool_use_update 出现在消息之后，仍要覆盖前面的 block
    let lines = format!("{assistant}\n{update_one}\n{update_two}\n");
    std::fs::write(dir.join("s1.jsonl"), lines).unwrap();

    let messages = load_messages("s1", PROJECT);
    assert_eq!(messages.len(), 1, "更新记录本身不是消息: {messages:?}");
    let blocks = messages[0]["message"]["content"].as_array().unwrap();
    assert_eq!(blocks[0]["input"]["command"], "new");
    assert_eq!(blocks[0]["_meta"]["status"], "running");
    assert_eq!(blocks[1]["input"]["file_path"], "a.txt");
}

#[test]
fn load_messages_rebuilds_the_chain_by_parent_uuid() {
    let sandbox = Sandbox::new("history-chain-bfs");
    let dir = sandbox.conversation_dir(PROJECT);
    // 行序与链序不同：b 先于父节点 a 写入
    let lines = [
        json!({ "uuid": "b", "parentUuid": "a", "timestamp": 2, "message": { "type": "assistant", "marker": "b" } }),
        json!({ "uuid": "a", "parentUuid": Value::Null, "timestamp": 1, "message": { "type": "user", "marker": "a" } }),
        json!({ "uuid": "c", "parentUuid": "b", "timestamp": 3, "message": { "type": "user", "marker": "c" } }),
    ];
    std::fs::write(
        dir.join("s1.jsonl"),
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let loaded = load_messages("s1", PROJECT);
    let markers: Vec<&str> = loaded
        .iter()
        .map(|message| message["marker"].as_str().unwrap())
        .collect();
    assert_eq!(markers, ["a", "b", "c"]);
}

#[test]
fn load_messages_orders_siblings_by_timestamp_in_breadth_first_order() {
    let sandbox = Sandbox::new("history-chain-siblings");
    let dir = sandbox.conversation_dir(PROJECT);
    let lines = [
        json!({ "uuid": "a", "parentUuid": Value::Null, "timestamp": 1, "message": { "marker": "a" } }),
        json!({ "uuid": "c", "parentUuid": "a", "timestamp": 3, "message": { "marker": "c" } }),
        json!({ "uuid": "b", "parentUuid": "a", "timestamp": 2, "message": { "marker": "b" } }),
        json!({ "uuid": "d", "parentUuid": "b", "timestamp": 4, "message": { "marker": "d" } }),
    ];
    std::fs::write(
        dir.join("s1.jsonl"),
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let loaded = load_messages("s1", PROJECT);
    let markers: Vec<&str> = loaded
        .iter()
        .map(|message| message["marker"].as_str().unwrap())
        .collect();
    // BFS：a → b、c（按时间）→ d；若按文件序会得到 a、c、b、d
    assert_eq!(markers, ["a", "b", "c", "d"]);
}

#[test]
fn load_messages_degrades_missing_parents_to_roots() {
    let sandbox = Sandbox::new("history-chain-missing-parent");
    let dir = sandbox.conversation_dir(PROJECT);
    let lines = [
        json!({ "uuid": "a", "parentUuid": Value::Null, "timestamp": 1, "message": { "marker": "a" } }),
        json!({ "uuid": "x", "parentUuid": "ghost", "timestamp": 2, "message": { "marker": "x" } }),
        json!({ "uuid": "b", "parentUuid": "x", "timestamp": 3, "message": { "marker": "b" } }),
    ];
    std::fs::write(
        dir.join("s1.jsonl"),
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let loaded = load_messages("s1", PROJECT);
    let markers: Vec<&str> = loaded
        .iter()
        .map(|message| message["marker"].as_str().unwrap())
        .collect();
    assert_eq!(markers, ["a", "x", "b"]);
}

#[test]
fn load_messages_repairs_self_referencing_recovered_tool_results() {
    let sandbox = Sandbox::new("history-chain-self-ref");
    let dir = sandbox.conversation_dir(PROJECT);
    let assistant = json!({
        "uuid": "a1",
        "parentUuid": Value::Null,
        "timestamp": 1,
        "message": {
            "type": "assistant",
            "marker": "a1",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "call_1", "name": "Bash", "input": {} }]
            }
        }
    });
    // 旧版本 bug：恢复消息落盘时 parentUuid === 自身 uuid，BFS 到不了
    let recovered = json!({
        "uuid": "r1",
        "parentUuid": "r1",
        "timestamp": 2,
        "message": {
            "type": "user",
            "marker": "r1",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "call_1", "content": "ok" }]
            }
        }
    });
    std::fs::write(dir.join("s1.jsonl"), format!("{assistant}\n{recovered}\n")).unwrap();

    let messages = load_messages("s1", PROJECT);
    let markers: Vec<&str> = messages
        .iter()
        .map(|message| message["marker"].as_str().unwrap())
        .collect();
    assert_eq!(markers, ["a1", "r1"], "自引用修复后应能从根节点到达");
}

#[test]
fn load_messages_keeps_first_position_for_duplicate_uuids() {
    let sandbox = Sandbox::new("history-chain-duplicate-uuid");
    let dir = sandbox.conversation_dir(PROJECT);
    let lines = [
        json!({ "uuid": "a", "parentUuid": Value::Null, "timestamp": 1, "message": { "marker": "a-old" } }),
        json!({ "uuid": "b", "parentUuid": "a", "timestamp": 2, "message": { "marker": "b" } }),
        json!({ "uuid": "a", "parentUuid": Value::Null, "timestamp": 3, "message": { "marker": "a-new" } }),
    ];
    std::fs::write(
        dir.join("s1.jsonl"),
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let loaded = load_messages("s1", PROJECT);
    let markers: Vec<&str> = loaded
        .iter()
        .map(|message| message["marker"].as_str().unwrap())
        .collect();
    assert_eq!(markers, ["a-new", "b"]);
}

/// 与 Embedded 共用同一份对照表（`src/test/fixtures/historyChainParity.json`）：
/// 两侧用同一组 jsonl 行跑链重建，断言消息顺序逐项一致。
/// 运行方式：`npm run test:all -- history-chain-parity`。
#[test]
fn load_messages_matches_the_embedded_chain_fixture() {
    const FIXTURE: &str = include_str!("../../src/test/fixtures/historyChainParity.json");
    let fixture: Value = serde_json::from_str(FIXTURE).expect("parse historyChainParity.json");
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap_or("");
        let mut text = String::new();
        for line in case["lines"].as_array().expect("lines") {
            match line {
                Value::String(raw) => text.push_str(raw),
                other => text.push_str(&serde_json::to_string(other).unwrap()),
            }
            text.push('\n');
        }
        let messages = parse_messages(&text);
        let markers: Vec<String> = messages
            .iter()
            .map(|message| {
                message
                    .get("marker")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        let expected: Vec<String> = case["expected"]
            .as_array()
            .expect("expected")
            .iter()
            .map(|value| value.as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(markers, expected, "case: {name}");
    }
}

#[test]
fn tool_use_updates_merge_meta_instead_of_replacing_it() {
    let sandbox = Sandbox::new("history-replay-meta-merge");
    let dir = sandbox.conversation_dir(PROJECT);
    let assistant = json!({
        "uuid": "a1",
        "timestamp": 1,
        "message": {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use", "id": "t1", "name": "Bash", "input": {},
                        "_meta": { "toolCallTimestamp": 111 }
                    }
                ]
            }
        }
    });
    // 第二条只带 confirmTimestamp：必须与已有 toolCallTimestamp 合并而不是覆盖
    let first = json!({
        "type": "tool_use_update", "toolUseId": "t1", "meta": { "status": "running" }
    });
    let second = json!({
        "type": "tool_use_update", "toolUseId": "t1", "meta": { "confirmTimestamp": 222 }
    });
    std::fs::write(
        dir.join("s1.jsonl"),
        format!("{assistant}\n{first}\n{second}\n"),
    )
    .unwrap();

    let messages = load_messages("s1", PROJECT);
    let meta = &messages[0]["message"]["content"][0]["_meta"];
    assert_eq!(meta["toolCallTimestamp"], 111);
    assert_eq!(meta["status"], "running");
    assert_eq!(meta["confirmTimestamp"], 222);
}

#[test]
fn tool_use_update_without_id_is_ignored() {
    let sandbox = Sandbox::new("history-replay-no-id");
    let dir = sandbox.conversation_dir(PROJECT);
    std::fs::write(
        dir.join("s1.jsonl"),
        format!("{}\n{}\n", json!({ "type": "tool_use_update", "input": {} }), json!({ "type": "tool_use_update" })),
    )
    .unwrap();
    assert!(load_messages("s1", PROJECT).is_empty());
}

#[test]
fn ensure_tool_results_backfills_missing_tool_results_in_memory() {
    // 对齐 Embedded `ensureToolResults`：assistant 已落盘 tool_use，但进程崩溃导致
    // tool_result 缺失时，恢复出的消息必须补一条「会话中断」的取消结果，否则下一轮
    // Anthropic 请求会因 tool_use 没有配对 tool_result 而 400。
    let mut messages = vec![
        user_message("hi", "u1"),
        json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "查一下" },
                    { "type": "tool_use", "id": "call_1", "name": "Bash", "input": { "command": "ls" } },
                ],
            },
        }),
    ];
    ensure_tool_results(&mut messages);
    assert_eq!(messages.len(), 3);
    let recovered = &messages[2];
    assert_eq!(recovered["type"], "user");
    assert_eq!(recovered["parentUuid"], "a1");
    assert!(recovered["uuid"].as_str().unwrap().starts_with("tool_recovered_"));
    let block = &recovered["message"]["content"][0];
    assert_eq!(block["type"], "tool_result");
    assert_eq!(block["tool_use_id"], "call_1");
    assert_eq!(block["is_canceled"], true);
    assert_eq!(
        block["content"],
        "[Previous session interrupted] Tool \"Bash\" was canceled before execution."
    );
}

#[test]
fn ensure_tool_results_keeps_completed_tool_uses_untouched() {
    let mut messages = vec![
        json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "call_1", "name": "Bash", "input": {} },
                    { "type": "tool_use", "id": "call_2", "name": "Read", "input": {} },
                ],
            },
        }),
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "call_1", "content": "ok" }],
            },
        }),
    ];
    ensure_tool_results(&mut messages);
    // 只补缺失的 call_2
    assert_eq!(messages.len(), 3);
    let block = &messages[2]["message"]["content"][0];
    assert_eq!(block["tool_use_id"], "call_2");
    assert_eq!(messages[2]["parentUuid"], "a1");
}

#[test]
fn ensure_tool_results_dedupes_repeated_tool_use_ids() {
    // 对齐 Embedded 的 `Map<string, ...>`：同一 id 重复出现只补一条 tool_result，
    // name / parentUuid 取最后一次写入，顺序仍按第一次出现的位置。
    let mut messages = vec![
        json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "call_1", "name": "Bash", "input": {} }],
            },
        }),
        json!({
            "type": "assistant",
            "uuid": "a2",
            "message": {
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "call_1", "name": "Read", "input": {} }],
            },
        }),
    ];
    ensure_tool_results(&mut messages);
    assert_eq!(messages.len(), 3, "重复 id 只补一条: {messages:?}");
    let recovered = &messages[2];
    assert_eq!(recovered["parentUuid"], "a2");
    assert_eq!(
        recovered["message"]["content"][0]["content"],
        "[Previous session interrupted] Tool \"Read\" was canceled before execution."
    );
}

#[test]
fn touch_metadata_refreshes_timestamp_and_count() {    let _sandbox = Sandbox::new("history-touch");
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "messageCount": 0 })).unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();
    append_message("s1", PROJECT, &user_message("again", "u2"), None).unwrap();

    touch_metadata("s1", PROJECT, true, None).unwrap();
    let metadata = load_metadata("s1", PROJECT).unwrap();
    assert_eq!(metadata["messageCount"], 2);
    assert!(metadata["updatedAt"].as_u64().unwrap() > 1_600_000_000_000);
    // 缺省 promptMode 补写 normal（对齐 `updateMetadataForNewMessage` 的补写分支）
    assert_eq!(metadata["context"]["promptMode"], "normal");
}

#[test]
fn touch_metadata_keeps_updated_at_for_background_messages() {
    // 对齐 Embedded `updateMetadataForNewMessage`：只有用户主动发送的消息（`_userInitiated`）
    // 才刷新 updatedAt，后台自动消息（reminder / 子代理回复）不得把旧会话顶到列表最前。
    let _sandbox = Sandbox::new("history-touch-background");
    create_conversation(
        "s1",
        PROJECT,
        json!({ "sessionId": "s1", "messageCount": 0, "updatedAt": 111 }),
    )
    .unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();

    touch_metadata("s1", PROJECT, false, Some("minimal")).unwrap();
    let metadata = load_metadata("s1", PROJECT).unwrap();
    assert_eq!(metadata["messageCount"], 1);
    assert_eq!(metadata["updatedAt"], 111);
    assert_eq!(metadata["context"]["promptMode"], "minimal");
}

#[test]
fn derive_title_uses_the_first_user_text() {
    let messages = vec![
        json!({ "type": "assistant", "message": { "content": "ignored" } }),
        json!({ "type": "user", "isMeta": true, "message": { "content": "跳过" } }),
        json!({ "type": "user", "message": { "content": "  修复登录 bug  " } }),
        json!({ "type": "user", "message": { "content": "第二条" } }),
    ];
    assert_eq!(derive_title(&messages).as_deref(), Some("修复登录 bug"));
}

#[test]
fn derive_title_joins_text_blocks_and_skips_empty_candidates() {
    // 对齐 Embedded `extractUserContent`：多个 text block 用 `\n` 拼接（不是空格）。
    let messages = vec![
        json!({ "type": "user", "message": { "content": [] } }),
        json!({ "type": "user", "message": { "content": [{ "type": "image" }] } }),
        json!({ "type": "user", "message": { "content": [
            { "type": "text", "text": "第一段" },
            { "type": "image", "source": {} },
            { "type": "text", "text": "第二段" }
        ] } }),
    ];
    assert_eq!(derive_title(&messages).as_deref(), Some("第一段\n第二段"));
    assert!(derive_title(&[]).is_none());
    assert!(derive_title(&[json!({ "type": "assistant", "message": { "content": "x" } })]).is_none());
}

#[test]
fn derive_title_falls_back_to_image_for_image_only_messages() {
    // 对齐 Embedded `buildConversationTitle`：纯图片（无文本）时兜底 `Image`。
    let messages = vec![json!({ "type": "user", "message": { "content": [
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
    ] } })];
    assert_eq!(derive_title(&messages).as_deref(), Some("Image"));

    // 没有可解析 dataUrl 的 image block 不算图片，标题取不到
    let bogus = vec![json!({ "type": "user", "message": { "content": [
        { "type": "image", "source": { "type": "url", "url": "x" } }
    ] } })];
    assert!(derive_title(&bogus).is_none());
}

#[test]
fn derive_title_uses_image_size_for_image_only_messages() {
    // 对齐 Embedded `buildConversationTitle`：仅图片时优先用消息顶层 `imageSizes`
    // 里第一张有宽高的图片生成 `Image[<w>*<h>]`。
    let messages = vec![json!({
        "type": "user",
        "message": { "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
        ] },
        "imageSizes": [{ "width": 800, "height": 600 }],
    })];
    assert_eq!(derive_title(&messages).as_deref(), Some("Image[800*600]"));

    // 宽高缺失（或为假值）时退化为 `Image`
    let no_size = vec![json!({
        "type": "user",
        "message": { "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
        ] },
        "imageSizes": [{ "width": 0, "height": 0 }],
    })];
    assert_eq!(derive_title(&no_size).as_deref(), Some("Image"));

    // `imageSizes` 只与**有效图片**（能解析出 dataUrl 的块）按顺序对应：
    // 第一个块没有 dataUrl，不占位；有效图片是第 1 张 → 用 `imageSizes[0]`。
    let aligned = vec![json!({
        "type": "user",
        "message": { "content": [
            { "type": "image", "source": { "type": "url", "url": "x" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
        ] },
        "imageSizes": [{ "width": 10, "height": 20 }, { "width": 800, "height": 600 }],
    })];
    assert_eq!(derive_title(&aligned).as_deref(), Some("Image[10*20]"));

    // `imageSizes[0]` 缺失/为 null 时，有效图片的第 1 张没有尺寸 → 退化 `Image`
    // （下标按有效图片对齐，不能拿 `imageSizes[1]` 去配第 1 张图）
    let misaligned = vec![json!({
        "type": "user",
        "message": { "content": [
            { "type": "image", "source": { "type": "url", "url": "x" } },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
        ] },
        "imageSizes": [null, { "width": 800, "height": 600 }],
    })];
    assert_eq!(derive_title(&misaligned).as_deref(), Some("Image"));

    // 文本优先于图片尺寸
    let with_text = vec![json!({
        "type": "user",
        "message": { "content": [
            { "type": "text", "text": "看这张图" },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "aGk=" } }
        ] },
        "imageSizes": [{ "width": 800, "height": 600 }],
    })];
    assert_eq!(derive_title(&with_text).as_deref(), Some("看这张图"));
}

#[test]
fn derive_title_truncates_to_fifty_characters() {
    let text = "字".repeat(80);
    let messages = vec![json!({ "type": "user", "message": { "content": text } })];
    let title = derive_title(&messages).unwrap();
    assert_eq!(title.chars().count(), 50);
}

#[test]
fn count_messages_excludes_stream_events_and_tool_use_updates() {
    // `tool_use_update` 只回放更新、不算消息（对齐 Embedded loadConversation 的
    // `metadata.messageCount = messages.length` 与 appendMessage 的 +1 口径）。
    let messages = vec![
        json!({ "type": "user" }),
        json!({ "type": "assistant" }),
        json!({ "type": "stream_event" }),
        json!({ "type": "stream_request_start" }),
        json!({ "type": "tombstone" }),
        json!({ "type": "tool_use_update" }),
        json!({}),
    ];
    assert_eq!(count_messages(&messages), 3);
    assert_eq!(count_messages(&[]), 0);
}

#[test]
fn project_of_session_scans_the_conversation_directories() {
    let sandbox = Sandbox::new("history-project-of");
    assert!(project_of_session("s1").is_none());

    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "project": PROJECT })).unwrap();
    assert_eq!(project_of_session("s1").as_deref(), Some(PROJECT));

    // meta 存在但没有 project 字段
    create_conversation("s2", PROJECT, json!({ "sessionId": "s2" })).unwrap();
    assert_eq!(project_of_session("s2"), None);
    assert!(sandbox.home.exists());
}

#[test]
fn model_ref_reads_flat_fields_then_context() {
    let _sandbox = Sandbox::new("history-model-ref");
    assert_eq!(model_ref_of_session("missing", PROJECT), (None, None));

    create_conversation(
        "s1",
        PROJECT,
        json!({ "sessionId": "s1", "model": "m-flat", "provider": "p-flat" }),
    )
    .unwrap();
    assert_eq!(
        model_ref_of_session("s1", PROJECT),
        (Some("p-flat".to_string()), Some("m-flat".to_string()))
    );

    create_conversation(
        "s2",
        PROJECT,
        json!({ "sessionId": "s2", "context": { "model": "m-ctx", "provider": "p-ctx" } }),
    )
    .unwrap();
    assert_eq!(
        model_ref_of_session("s2", PROJECT),
        (Some("p-ctx".to_string()), Some("m-ctx".to_string()))
    );

    // 只有 model、没有 provider：对齐 `modelRefOf`——整个模型身份视为未登记
    // （否则会拿旧模型去配当前活动 provider，与 Embedded 的默认模型回退不一致）
    create_conversation(
        "s3",
        PROJECT,
        json!({ "sessionId": "s3", "model": "m-only" }),
    )
    .unwrap();
    assert_eq!(model_ref_of_session("s3", PROJECT), (None, None));

    // provider 为空串 / 只有空白同样未登记；provider 有值、model 缺省时 model 为空串
    create_conversation(
        "s4",
        PROJECT,
        json!({ "sessionId": "s4", "provider": "  ", "model": "m-only" }),
    )
    .unwrap();
    assert_eq!(model_ref_of_session("s4", PROJECT), (None, None));

    create_conversation(
        "s5",
        PROJECT,
        json!({ "sessionId": "s5", "provider": "  p-trim  ", "model": "  m-trim  " }),
    )
    .unwrap();
    assert_eq!(
        model_ref_of_session("s5", PROJECT),
        (Some("p-trim".to_string()), Some("m-trim".to_string()))
    );

    create_conversation(
        "s6",
        PROJECT,
        json!({ "sessionId": "s6", "provider": "p-only" }),
    )
    .unwrap();
    assert_eq!(
        model_ref_of_session("s6", PROJECT),
        (Some("p-only".to_string()), Some(String::new()))
    );
}

#[test]
fn update_context_writes_nested_context_and_flattens_model_identity() {
    let _sandbox = Sandbox::new("history-update-context");
    // 没有 meta.json 时静默跳过
    update_context("missing", PROJECT, &[json!({ "key": "model", "value": "m" })]).unwrap();
    assert!(load_metadata("missing", PROJECT).is_none());

    create_conversation("s1", PROJECT, json!({ "sessionId": "s1" })).unwrap();
    update_context(
        "s1",
        PROJECT,
        &[
            json!({ "key": "model", "value": "m1" }),
            json!({ "key": "provider", "value": "p1" }),
            json!({ "key": "agentMode", "value": "auto" }),
            json!({ "value": "no key" }),
            json!({ "key": "noValue" }),
        ],
    )
    .unwrap();

    let metadata = load_metadata("s1", PROJECT).unwrap();
    assert_eq!(metadata["context"]["model"], "m1");
    assert_eq!(metadata["context"]["provider"], "p1");
    assert_eq!(metadata["context"]["agentMode"], "auto");
    assert_eq!(metadata["context"]["noValue"], Value::Null);
    // 模型身份在顶层保持扁平，供会话列表直接读取
    assert_eq!(metadata["model"], "m1");
    assert_eq!(metadata["provider"], "p1");
    assert!(metadata.get("agentMode").is_none());
}

#[test]
fn update_context_creates_the_context_object_when_absent() {
    let _sandbox = Sandbox::new("history-update-context-new");
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1" })).unwrap();
    update_context("s1", PROJECT, &[json!({ "key": "currentFile", "value": "a.ts" })]).unwrap();
    assert_eq!(load_metadata("s1", PROJECT).unwrap()["context"]["currentFile"], "a.ts");
}

/// 宿主（Embedded Core）用 JS 的 `String.slice` 截断工具输出预览时可能切开代理对，
/// 于是历史行里出现 `"\ude00"`。serde_json 是严格解析器，不清洗会**整行丢弃**——
/// 表现为 Rust Core 打开会话后少消息 / 元数据读不出来。
#[test]
fn load_messages_reads_lines_with_lone_surrogate_escapes() {
    let sandbox = Sandbox::new("history-lone-surrogate");
    let dir = sandbox.conversation_dir(PROJECT);
    // 直接写原始文本：合法行 + 带 `\ude00` 的行（等价于 JSON.stringify 的输出）
    let broken = concat!(
        r#"{"uuid":"u1","parentUuid":null,"timestamp":1,"#,
        r#""message":{"type":"user","message":{"role":"user","content":"hi"}}}"#,
        "\n",
        r#"{"uuid":"u2","parentUuid":"u1","timestamp":2,"#,
        r#""message":{"type":"user","message":{"role":"user","content":"emoji \ude00"}}}"#,
        "\n",
    );
    std::fs::write(dir.join("s1.jsonl"), broken).unwrap();

    // 严格解析器单独看第二行会失败（这就是不加清洗时的行为）
    assert!(serde_json::from_str::<Value>(broken.lines().nth(1).unwrap()).is_err());

    let messages = load_messages("s1", PROJECT);
    assert_eq!(messages.len(), 2, "坏行不应被丢掉：{messages:?}");
    assert_eq!(messages[0]["message"]["content"], "hi");
    let content = messages[1]["message"]["content"].as_str().unwrap();
    assert!(content.starts_with("emoji "), "got {content:?}");
    assert!(content.ends_with('\u{FFFD}'), "got {content:?}");
}

#[test]
fn load_metadata_reads_files_with_lone_surrogate_escapes() {
    let sandbox = Sandbox::new("history-lone-surrogate-meta");
    let dir = sandbox.conversation_dir(PROJECT);
    let broken = concat!(
        r#"{"sessionId":"s1","title":"带 emoji \ude00 的标题","#,
        r#""project":"D:/repo/demo"}"#,
    );
    std::fs::write(dir.join("s1.meta.json"), broken).unwrap();

    let metadata = load_metadata("s1", PROJECT).expect("清洗后应能读出元数据");
    assert_eq!(metadata["sessionId"], "s1");
    assert_eq!(metadata["title"], "带 emoji \u{FFFD} 的标题");
}

/// 会话文件由多进程共写，异常退出可能留下半截多字节序列（无效 UTF-8 字节）。
/// Embedded 侧 Node `readFile(path, 'utf8')` 宽松解码只损失一个替换字符；
/// Rust 侧 `read_to_string` 严格校验会让**整个会话**被当成空——这里锁住宽松口径。
#[test]
fn load_messages_replaces_invalid_utf8_bytes_instead_of_dropping_the_file() {
    let sandbox = Sandbox::new("history-invalid-utf8");
    let dir = sandbox.conversation_dir(PROJECT);
    // 第二行 content 里塞一个孤立的 0xE4（三字节序列的头，后面没跟续字节）
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(
        br#"{"uuid":"u1","parentUuid":null,"timestamp":1,"message":{"type":"user","message":{"role":"user","content":"ok"}}}"#,
    );
    bytes.push(b'\n');
    bytes.extend_from_slice(
        br#"{"uuid":"u2","parentUuid":"u1","timestamp":2,"message":{"type":"user","message":{"role":"user","content":"a"#,
    );
    bytes.push(0xE4);
    bytes.extend_from_slice(br#"b"}}}"#);
    bytes.push(b'\n');
    std::fs::write(dir.join("s1.jsonl"), bytes).unwrap();

    // 严格解码单独看这个文件会失败（这就是 read_to_string 的行为）
    let raw = std::fs::read(dir.join("s1.jsonl")).unwrap();
    assert!(String::from_utf8(raw).is_err());

    let messages = load_messages("s1", PROJECT);
    assert_eq!(messages.len(), 2, "无效字节只损失一个替换字符，不该丢整个会话：{messages:?}");
    assert_eq!(messages[0]["message"]["content"], "ok");
    assert_eq!(messages[1]["message"]["content"], "a\u{FFFD}b");
}

#[test]
fn load_metadata_replaces_invalid_utf8_bytes() {
    let sandbox = Sandbox::new("history-invalid-utf8-meta");
    let dir = sandbox.conversation_dir(PROJECT);
    let mut bytes: Vec<u8> = Vec::new();
    bytes.extend_from_slice(br#"{"sessionId":"s1","title":"a"#);
    bytes.push(0xFF);
    bytes.extend_from_slice(br#"b","project":"D:/repo/demo"}"#);
    std::fs::write(dir.join("s1.meta.json"), bytes).unwrap();

    let metadata = load_metadata("s1", PROJECT).expect("宽松解码后应能读出元数据");
    assert_eq!(metadata["sessionId"], "s1");
    assert_eq!(metadata["title"], "a\u{FFFD}b");
}

#[test]
fn conversation_list_excludes_workspace_manifest() {
    // 对齐 Embedded loadConversationList：工作区清单（workspace.meta.json）不是会话，
    // 混进列表会渲染成「(未命名对话) NaN/NaN/NaN」的幽灵条目
    let sandbox = Sandbox::new("history-list-manifest");
    // 调用只为触发 ensure 写入 workspace.meta.json，路径本身用不上
    sandbox.conversation_dir(PROJECT);
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1", "title": "s1" })).unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();
    // messageCount 由引擎在 append 后刷新（append_message 本身不写 meta）；
    // messageCount == 0 的空对话不进列表
    touch_metadata("s1", PROJECT, true, None).unwrap();

    let list = load_conversation_list(Some(PROJECT));
    assert_eq!(list.len(), 1, "清单不能混进会话列表：{list:?}");
    assert_eq!(list[0]["sessionId"], "s1");
}

#[test]
fn delete_conversation_keeps_workspace_manifest() {
    // 对齐 Embedded readProjectConversationMetadata：闭包输入不含工作区清单——
    // 它没有 sessionId，混进闭包只会被当成名为 "workspace" 的会话删掉
    let sandbox = Sandbox::new("history-delete-manifest");
    let dir = sandbox.conversation_dir(PROJECT);
    create_conversation("s1", PROJECT, json!({ "sessionId": "s1" })).unwrap();
    append_message("s1", PROJECT, &user_message("hi", "u1"), None).unwrap();

    delete_conversation("s1", PROJECT).unwrap();
    assert!(!dir.join("s1.meta.json").exists());
    assert!(dir.join("workspace.meta.json").exists(), "清单不是会话，不能被删");
}

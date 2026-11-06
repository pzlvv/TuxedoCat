use serde_json::{json, Value};

use super::*;

/// 行为对照表数据在 `core-rs/fixtures/compact.json` 的 `replay` 段。
const FIXTURE: &str = include_str!("../fixtures/compact.json");

#[test]
fn replay_message_data_parity() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("compactParity.json 解析失败");
    for case in fixture["replay"].as_array().unwrap() {
        let messages = case["messages"].as_array().unwrap();
        assert_eq!(
            Value::Array(build_replay_message_data(messages)),
            case["result"],
            "重放数据不一致: {}",
            case["name"].as_str().unwrap()
        );
    }
}

#[test]
fn parse_data_url_handles_plain_base64() {
    assert_eq!(
        parse_data_url("data:image/png;base64,AAAA"),
        ("image/png".to_string(), "AAAA".to_string())
    );
    assert_eq!(
        parse_data_url("data:image/jpeg;base64,/9j/4A=="),
        ("image/jpeg".to_string(), "/9j/4A==".to_string())
    );
    // 非标准 data URL → 视为纯 base64，media type 兜底 image/png
    assert_eq!(
        parse_data_url("AAAA"),
        ("image/png".to_string(), "AAAA".to_string())
    );
}

#[test]
fn image_block_to_data_url_requires_base64_source() {
    assert_eq!(
        image_block_to_data_url(&json!({
            "type": "image",
            "source": { "type": "base64", "media_type": "image/webp", "data": "X" },
        }))
        .as_deref(),
        Some("data:image/webp;base64,X")
    );
    // 缺 media_type → 兜底 image/png
    assert_eq!(
        image_block_to_data_url(&json!({
            "type": "image",
            "source": { "type": "base64", "data": "X" },
        }))
        .as_deref(),
        Some("data:image/png;base64,X")
    );
    // 非 base64 source / 非 image 块
    assert!(image_block_to_data_url(&json!({ "type": "image", "source": { "type": "url" } })).is_none());
    assert!(image_block_to_data_url(&json!({ "type": "text", "text": "x" })).is_none());
}

#[test]
fn message_origin_falls_back_to_legacy_flags() {
    assert_eq!(message_origin(&json!({ "origin": "agent" })), Some("agent"));
    assert_eq!(message_origin(&json!({ "origin": "bash" })), Some("bash"));
    assert_eq!(message_origin(&json!({ "origin": "user" })), Some("user"));
    assert_eq!(message_origin(&json!({ "origin": "other" })), None);
    assert_eq!(message_origin(&json!({ "fromSubAgent": true })), Some("agent"));
    assert_eq!(message_origin(&json!({ "fromBashTask": true })), Some("bash"));
    assert_eq!(message_origin(&json!({})), None);
}

/// `Edit` 的 `diffHunks` 分支：有意改发
/// `beforeContent` / `afterContent`，由 webview 回退计算。
#[test]
fn edit_tool_use_sends_before_and_after_instead_of_diff_hunks() {
    let messages = vec![
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "call_e",
                    "name": "Edit",
                    "input": { "file_path": "/tmp/a.ts", "replace_all": false },
                    "_meta": { "beforeContent": "old line", "afterContent": "new line", "startLine": 1, "endLine": 1 },
                }],
            },
            "uuid": "a-e",
            "timestamp": 1,
        }),
    ];
    let out = build_replay_message_data(&messages);
    assert_eq!(out.len(), 1);
    let args = &out[0]["toolArgs"];
    assert_eq!(args["beforeContent"], "old line");
    assert_eq!(args["afterContent"], "new line");
    assert!(args.get("diffHunks").is_none(), "Standalone 不下发 diffHunks");
    assert_eq!(out[0]["status"], "running");
    assert_eq!(out[0]["param"], "⚙️ Edit");
}

/// `Write` 的 `beforeContent` / `afterContent` 原样进 `toolArgs`。
#[test]
fn write_tool_use_keeps_before_and_after() {
    let messages = vec![json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": "call_w",
                "name": "Write",
                "input": { "file_path": "/tmp/b.ts" },
                "_meta": { "beforeContent": Value::Null, "afterContent": "content" },
            }],
        },
        "uuid": "a-w",
        "timestamp": 1,
    })];
    let out = build_replay_message_data(&messages);
    let args = &out[0]["toolArgs"];
    assert!(args["beforeContent"].is_null());
    assert_eq!(args["afterContent"], "content");
}

#[test]
fn tool_result_map_skips_canceled_and_keeps_last() {
    let messages = vec![
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    { "type": "tool_result", "tool_use_id": "a", "content": "first", "exit_code": 0 },
                    { "type": "tool_result", "tool_use_id": "a", "content": "second", "exit_code": 3 },
                    { "type": "tool_result", "tool_use_id": "b", "content": "canceled", "is_canceled": true },
                ],
            },
        }),
    ];
    let (map, canceled) = build_tool_result_maps(&messages);
    assert_eq!(map.len(), 1, "后写覆盖先写 + 已取消的不入结果表");
    assert_eq!(map[0].0, "a");
    assert_eq!(map[0].1.content, "second");
    assert_eq!(map[0].1.exit_code, 3);
    // 取消单独登记：调用方据此把对应 tool_use 落成 fail + 说明文本
    assert_eq!(canceled.len(), 1);
    assert_eq!(canceled[0].0, "b");
    assert_eq!(canceled[0].1, "canceled");
}

/// specs/defects/replay-drops-canceled-tool-results.md RT-1 / RT-2 / RT-3
#[test]
fn canceled_tool_use_renders_as_failed_not_running() {
    let messages = vec![
        json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "ls" } },
                    { "type": "tool_use", "id": "c2", "name": "Bash", "input": {} },
                    { "type": "tool_use", "id": "c3", "name": "Bash", "input": {} },
                ],
            },
            "uuid": "a-1",
            "timestamp": 1,
        }),
        json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    // 被取消：落成 fail + 取消说明
                    { "type": "tool_result", "tool_use_id": "c1", "content": "Tool was canceled before execution.", "is_canceled": true, "exit_code": -1 },
                    // 正常失败：仍按 exit_code 落成 fail
                    { "type": "tool_result", "tool_use_id": "c2", "content": "boom", "exit_code": 2 },
                    // 没有对应 tool_use 的取消结果：不产出额外卡片（c3 仍是 running）
                    { "type": "tool_result", "tool_use_id": "ghost", "content": "gone", "is_canceled": true },
                ],
            },
            "uuid": "r-1",
            "timestamp": 2,
        }),
    ];
    let out = build_replay_message_data(&messages);
    assert_eq!(out.len(), 3, "取消结果不额外产出 toolcall 项");
    assert_eq!(out[0]["toolCallId"], "c1");
    assert_eq!(out[0]["status"], "fail");
    assert_eq!(out[0]["content"], "Tool was canceled before execution.");
    assert_eq!(out[1]["toolCallId"], "c2");
    assert_eq!(out[1]["status"], "fail");
    assert_eq!(out[1]["content"], "boom");
    assert_eq!(out[2]["toolCallId"], "c3");
    assert_eq!(out[2]["status"], "running");
}

#[test]
fn empty_content_user_message_is_skipped() {
    let messages = vec![
        json!({ "type": "user", "message": { "role": "user", "content": "" }, "uuid": "u-1" }),
        json!({ "type": "user", "message": { "role": "user", "content": [] }, "uuid": "u-2" }),
        json!({ "type": "user", "message": { "role": "user", "content": "hi" }, "uuid": "u-3" }),
    ];
    let out = build_replay_message_data(&messages);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["content"], "hi");
}

/// 节点身份载体（specs/039 FR-001）：三类展示消息都透传 JSONL 的 `uuid`；
/// 没有 `uuid` 的老数据落 `null`（webview 据此禁用回退）。
#[test]
fn replay_messages_carry_message_uuid() {
    let messages = vec![
        json!({"type": "system", "content": "note", "uuid": "s-1"}),
        json!({"type": "assistant", "uuid": "a-1", "message": {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "想"}, {"type": "text", "text": "说"},
                        {"type": "tool_use", "id": "t-1", "name": "Read", "input": {}}]
        }}),
        json!({"type": "user", "uuid": "u-1", "message": {"role": "user", "content": "问"}}),
    ];
    let out = build_replay_message_data(&messages);
    assert_eq!(out.len(), 5, "system + thinking + text + toolcall + user");
    for item in &out {
        let uuid = item.get("messageUuid").expect("展示消息必须带 messageUuid");
        assert!(uuid.is_string(), "有 uuid 的源消息必须透传");
    }
    let roles: Vec<&str> = out.iter().filter_map(|m| m["role"].as_str()).collect();
    assert_eq!(roles, vec!["system", "thinking", "assistant", "toolcall", "user"]);

    // 缺 uuid 的源消息：字段仍在，值为 null（不是缺键）
    let legacy = build_replay_message_data(&[json!({"type": "system", "content": "old"})]);
    assert!(legacy[0].get("messageUuid").is_some());
    assert!(legacy[0]["messageUuid"].is_null());
}

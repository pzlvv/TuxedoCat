//! `rewind` 的单元测试：截断规则、守卫、文件恢复与回执（specs/039 AC-4 ～ AC-8 的 core 判定层）。

use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::config;
use crate::engine::SessionState;
use crate::history;
use crate::test_support::Sandbox;

/// 会话内存状态的空实例（回退要更新 messages / persisted_count / last_uuid）。
///
/// 走引擎的真实构造入口（`Core::session`），避免在这里复制一份字段默认值。
fn state_for() -> (crate::test_support::EngineHarness, Arc<Mutex<SessionState>>) {
    let harness = crate::test_support::EngineHarness::allow_all();
    let state = harness.core.session("s1");
    (harness, state)
}

/// 写一份 JSONL 会话（每条消息按顺序带 uuid）
fn write_conversation(session_id: &str, project: &str, messages: Vec<Value>) {
    history::replace_messages(session_id, project, &messages).expect("write conversation");
}

/// assistant 行：一条 tool_use（带 `_meta` 备份）
fn assistant_tool(
    uuid: &str,
    tool_id: &str,
    name: &str,
    path: &str,
    before: Option<&str>,
    after: Option<&str>,
) -> Value {
    let mut meta = serde_json::Map::new();
    meta.insert(
        "beforeContent".to_string(),
        before.map(|t| json!(t)).unwrap_or(Value::Null),
    );
    meta.insert(
        "afterContent".to_string(),
        after.map(|t| json!(t)).unwrap_or(Value::Null),
    );
    json!({
        "type": "assistant",
        "uuid": uuid,
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": tool_id,
                "name": name,
                "input": { "file_path": path },
                "_meta": meta,
            }],
        },
    })
}

/// user 行：一条文本消息
fn user_text(uuid: &str, text: &str) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": { "role": "user", "content": text },
    })
}

/// user 行：一条 tool_result
fn tool_result(uuid: &str, tool_id: &str, before: Option<&str>) -> Value {
    json!({
        "type": "user",
        "uuid": uuid,
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_id,
                "content": "ok",
                "beforeContent": before.map(|t| json!(t)).unwrap_or(Value::Null),
            }],
        },
    })
}

// ==================== 截断规则（FR-003） ====================

#[test]
fn truncate_keeps_the_target_user_message() {
    let messages = vec![user_text("u1", "一"), user_text("u2", "二")];
    // 用户消息保留自身：从这条「继续」，这条输入应该还在
    assert_eq!(truncate_index(&messages, "u2"), Some(2));
}

#[test]
fn truncate_drops_the_target_assistant_row() {
    let messages = vec![
        user_text("u1", "一"),
        assistant_tool("a1", "t1", "Edit", "a.txt", Some("old"), Some("new")),
        tool_result("r1", "t1", Some("old")),
        user_text("u2", "二"),
    ];
    // assistant 行是产出物：从它之前继续，该行与其 tool_result 一起删除
    assert_eq!(truncate_index(&messages, "a1"), Some(1));
}

/// 保留区末尾不能留下孤立的 `tool_use`：回放按「没有结果 = running」渲染，
/// 回退后工具卡片会停在跑动状态，下一轮请求也会因缺 `tool_result` 被拒。
#[test]
fn truncate_never_leaves_an_orphan_tool_use() {
    let messages = vec![
        user_text("u1", "一"),
        assistant_tool("a1", "t1", "Bash", "x", Some("old"), Some("new")),
        tool_result("r1", "t1", Some("old")),
        user_text("u2", "二"),
    ];
    // 以 assistant 行（Bash 卡片所属）为目标：旧实现保留该行却删掉 tool_result，
    // 恰好制造孤儿；现在整体前移到该行之前
    let cut = truncate_index(&messages, "a1").expect("a1 存在");
    assert_eq!(cut, 1, "工具调用是原子单位，从它之前继续");
    let kept_tool_uses: Vec<&str> = messages[..cut]
        .iter()
        .filter(|message| message.get("type").and_then(Value::as_str) == Some("assistant"))
        .flat_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .map(|blocks| blocks.as_slice())
                .unwrap_or(&[])
        })
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|block| block.get("id").and_then(Value::as_str))
        .collect();
    assert!(
        kept_tool_uses.is_empty(),
        "保留区不能剩孤立 tool_use：{kept_tool_uses:?}"
    );
}

/// 目标是 system、且它前面是带工具调用的 assistant 行：截断点整体前移到该行之前。
#[test]
fn truncate_moves_before_a_tool_use_row_when_target_is_a_system_message() {
    let messages = vec![
        user_text("u1", "一"),
        assistant_tool("a1", "t1", "Bash", "x", Some("old"), Some("new")),
        json!({"type": "system", "uuid": "s1", "content": "提示"}),
        tool_result("r1", "t1", Some("old")),
    ];
    assert_eq!(truncate_index(&messages, "s1"), Some(1));
}

#[test]
fn truncate_drops_the_target_system_message() {
    let messages = vec![
        user_text("u1", "一"),
        json!({"type": "system", "uuid": "s1", "content": "提示"}),
    ];
    // system 是产出物：从它之前继续
    assert_eq!(truncate_index(&messages, "s1"), Some(1));
}

/// 工具卡片在实时流式期还没有 JSONL uuid：用 tool_use id 也能定位到所属 assistant 行，
/// 截断到该行之前（工具调用是原子单位）。
#[test]
fn truncate_accepts_a_tool_use_id_as_target() {
    let messages = vec![
        user_text("u1", "一"),
        assistant_tool("a1", "t1", "Edit", "a.txt", Some("old"), Some("new")),
        tool_result("r1", "t1", Some("old")),
    ];
    assert_eq!(truncate_index(&messages, "t1"), Some(1));
}

#[test]
fn truncate_returns_none_for_unknown_target() {
    let messages = vec![user_text("u1", "一")];
    assert_eq!(truncate_index(&messages, "nope"), None);
}

// ==================== 守卫（FR-005） ====================

#[test]
fn rewind_rejects_unknown_target_without_touching_files() {
    let sandbox = Sandbox::new("rewind-unknown");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "CURRENT\n");
    write_conversation("s1", &project, vec![user_text("u1", "一")]);

    let error = rewind("s1", "nope", &state_for().1)
        .err()
        .expect("should fail");
    assert!(error.contains("target node not found"), "got {error}");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "CURRENT\n",
        "找不到目标时不动文件"
    );
}

#[test]
fn rewind_rejects_target_of_the_last_node() {
    let sandbox = Sandbox::new("rewind-last");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    write_conversation(
        "s1",
        &project,
        vec![user_text("u1", "一"), user_text("u2", "二")],
    );

    // 末节点是 user：截断点 = 下标 + 1 = len，其后没有可删内容
    let error = rewind("s1", "u2", &state_for().1)
        .err()
        .expect("should fail");
    assert!(error.contains("no messages after"), "got {error}");
}

/// 回退到某个工具卡片时，磁盘上不能留下没有结果的 `tool_use`——否则回放把它渲染成
/// running，卡片在回退后一直转圈（spec 039 FR-003 的不变量）。
///
/// 复现原缺陷：右键 Bash 卡片回退（目标 = `tool_use.id`），旧实现截断到该 assistant 行
/// **之后**，保留了 `tool_use` 却删掉它的 `tool_result`。
#[test]
fn rewind_leaves_no_orphan_tool_use_in_history() {
    let sandbox = Sandbox::new("rewind-orphan");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            assistant_tool("a1", "t1", "Bash", "x", Some("old"), Some("new")),
            tool_result("r1", "t1", Some("old")),
            user_text("u2", "二"),
        ],
    );

    // 目标是 Bash 卡片本身（tool_use id）：该工具调用整体删除
    rewind("s1", "t1", &state_for().1).expect("rewind ok");
    let remaining = history::load_messages("s1", &project);
    let tool_use_ids: Vec<&str> = remaining
        .iter()
        .filter(|message| message.get("type").and_then(Value::as_str) == Some("assistant"))
        .flat_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .map(|blocks| blocks.as_slice())
                .unwrap_or(&[])
        })
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter_map(|block| block.get("id").and_then(Value::as_str))
        .collect();
    let tool_result_ids: Vec<&str> = remaining
        .iter()
        .filter(|message| message.get("type").and_then(Value::as_str) == Some("user"))
        .flat_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .map(|blocks| blocks.as_slice())
                .unwrap_or(&[])
        })
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter_map(|block| block.get("tool_use_id").and_then(Value::as_str))
        .collect();
    assert!(
        tool_use_ids.is_empty(),
        "Bash 卡片应整体删除，实际残留 {tool_use_ids:?}"
    );
    for id in tool_use_ids {
        assert!(
            tool_result_ids.contains(&id),
            "回退后的历史里 {id} 没有 tool_result：卡片会渲染成 running"
        );
    }
    // 落盘只剩 u1（Bash 卡片及其结果都删除）
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["uuid"], "u1");
}

// ==================== 文件恢复（FR-004） ====================

#[test]
fn rewind_restores_files_and_truncates_the_conversation() {
    let sandbox = Sandbox::new("rewind-restore");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW\n");
    sandbox.write_file("b.txt", "B2\n");
    let messages = vec![
        user_text("u1", "一"),
        assistant_tool("a1", "t1", "Edit", "a.txt", Some("OLD\n"), Some("NEW\n")),
        tool_result("r1", "t1", Some("OLD\n")),
        user_text("u2", "二"),
        assistant_tool("a2", "t2", "Write", "b.txt", Some("B1\n"), Some("B2\n")),
        tool_result("r2", "t2", Some("B1\n")),
    ];
    write_conversation("s1", &project, messages.clone());

    let outcome = rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert_eq!(outcome.removed, 5, "u1 之后的 5 条");
    assert_eq!(outcome.files.len(), 2);
    assert!(outcome.files.iter().all(|file| file.ok));
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD\n"
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("b.txt")).unwrap(),
        "B1\n"
    );
    // 落盘也截断了：只剩 u1
    let remaining = history::load_messages("s1", &project);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["uuid"], "u1");
}

#[test]
fn rewind_deletes_files_created_in_the_range() {
    let sandbox = Sandbox::new("rewind-created");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("born.txt", "hello\n");
    // beforeContent 为 null = 文件原本不存在 → 删除
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            assistant_tool("a1", "t1", "Write", "born.txt", None, Some("hello\n")),
            tool_result("r1", "t1", None),
        ],
    );

    let outcome = rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert_eq!(outcome.files.len(), 1);
    assert!(outcome.files[0].ok);
    assert!(
        !sandbox.workspace.join("born.txt").exists(),
        "新建的文件被删除"
    );
}

#[test]
fn rewind_uses_the_earliest_backup_per_file() {
    let sandbox = Sandbox::new("rewind-earliest");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "V3\n");
    // 区间内同一文件被改两次：回退到区间第一次改之前（V1），不是第二次的 V2
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            assistant_tool("a1", "t1", "Edit", "a.txt", Some("V1\n"), Some("V2\n")),
            tool_result("r1", "t1", Some("V1\n")),
            assistant_tool("a2", "t2", "Edit", "a.txt", Some("V2\n"), Some("V3\n")),
            tool_result("r2", "t2", Some("V2\n")),
        ],
    );

    rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "V1\n",
        "回到节点时刻的状态，不是逐次倒放"
    );
}

#[test]
fn rewind_falls_back_to_tool_result_backup() {
    let sandbox = Sandbox::new("rewind-result-backup");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW\n");
    // `_meta` 缺失（旧数据 / 写入时序），备份落在 tool_result.beforeContent 上
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            json!({
                "type": "assistant",
                "uuid": "a1",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "t1", "name": "Edit",
                    "input": {"file_path": "a.txt"},
                }]},
            }),
            tool_result("r1", "t1", Some("OLD\n")),
        ],
    );

    let outcome = rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert_eq!(outcome.files.len(), 1);
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD\n"
    );
}

#[test]
fn rewind_skips_files_without_backup() {
    let sandbox = Sandbox::new("rewind-skip");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("no-backup.txt", "current\n");
    sandbox.write_file("a.txt", "NEW\n");
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            // 真正的「没有备份」：`_meta` 缺 beforeContent 键、tool_result 也没有
            // （JSON 里写 `null` 是「文件原本不存在」，那是有效备份，不是缺失）
            json!({
                "type": "assistant",
                "uuid": "a1",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "t1", "name": "Edit",
                    "input": {"file_path": "no-backup.txt"},
                    "_meta": {"afterContent": "current
            "},
                }]},
            }),
            json!({
                "type": "user",
                "uuid": "r1",
                "message": {"role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": "t1", "content": "ok",
                }]},
            }),
            assistant_tool("a2", "t2", "Edit", "a.txt", Some("OLD\n"), Some("NEW\n")),
            tool_result("r2", "t2", Some("OLD\n")),
        ],
    );

    let outcome = rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert_eq!(outcome.skipped, vec!["no-backup.txt".to_string()]);
    assert_eq!(outcome.files.len(), 1);
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD\n"
    );
}

#[test]
fn rewind_marks_bash_in_the_range() {
    let sandbox = Sandbox::new("rewind-bash");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    write_conversation(
        "s1",
        &project,
        vec![
            user_text("u1", "一"),
            json!({
                "type": "assistant",
                "uuid": "a1",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use", "id": "t1", "name": "Bash",
                    "input": {"command": "rm x"},
                }]},
            }),
            tool_result("r1", "t1", None),
        ],
    );

    let outcome = rewind("s1", "u1", &state_for().1).expect("rewind ok");
    assert!(outcome.had_bash, "Bash 造成的改动不回滚，只在回执里提示");
    assert!(receipt_text(&outcome).contains("Bash changed files"));
}

// ==================== 回执（FR-006） ====================

#[test]
fn receipt_lists_counts_files_and_skips() {
    let outcome = RewindOutcome {
        removed: 3,
        target: "u1".to_string(),
        files: vec![
            RewindFile {
                path: "a.txt".to_string(),
                ok: true,
                error: None,
            },
            RewindFile {
                path: "b.txt".to_string(),
                ok: false,
                error: Some("denied".to_string()),
            },
        ],
        skipped: vec!["c.txt".to_string()],
        had_bash: false,
    };
    let text = receipt_text(&outcome);
    assert!(text.contains("removed 3 message(s)"));
    assert!(text.contains("Restored 1 file(s): a.txt"));
    assert!(text.contains("Failed to restore b.txt: denied"));
    assert!(text.contains("Skipped 1 file(s) without a before-edit backup"));
}

#[test]
fn receipt_says_nothing_to_roll_back_when_clean() {
    let outcome = RewindOutcome {
        removed: 1,
        target: "u1".to_string(),
        files: Vec::new(),
        skipped: Vec::new(),
        had_bash: false,
    };
    assert!(receipt_text(&outcome).contains("No files needed to be rolled back"));
}

#[test]
fn receipt_message_is_excluded_from_context() {
    let outcome = RewindOutcome {
        removed: 1,
        target: "u1".to_string(),
        files: Vec::new(),
        skipped: Vec::new(),
        had_bash: false,
    };
    let message = receipt_message(&outcome);
    assert_eq!(message["role"], "system");
    assert_eq!(message["_meta"]["excludeFromContext"], true);
}

/// 回退守卫读会话的 `idle`（spec FR-005）：只有空闲对话能回退，与 UI 侧置灰同一口径。
#[test]
fn rewind_guard_requires_an_idle_session() {
    let (harness, state) = state_for();
    assert!(harness.core.is_session_idle("s1"), "空闲时可回退");
    {
        let mut guard = state.lock().unwrap();
        guard.running = true;
    }
    assert!(!harness.core.is_session_idle("s1"), "跑查询时拒绝");
    {
        let mut guard = state.lock().unwrap();
        guard.running = false;
        guard.compacting = true;
    }
    assert!(!harness.core.is_session_idle("s1"), "压缩时拒绝");
    {
        let mut guard = state.lock().unwrap();
        guard.compacting = false;
        guard.background = true;
    }
    assert!(
        !harness.core.is_session_idle("s1"),
        "后台任务运行时不拒绝就不一致了"
    );
    {
        let mut guard = state.lock().unwrap();
        guard.background = false;
        guard.pending_user_message = Some(crate::engine::QueuedUserMessage::plain(json!({})));
    }
    assert!(
        !harness.core.is_session_idle("s1"),
        "排队中的用户消息同样算未空闲"
    );
    assert!(
        harness.core.is_session_idle("nope"),
        "不存在的会话按空闲处理"
    );
}

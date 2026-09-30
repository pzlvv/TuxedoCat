//! `rollback` 的单元测试：Edit / Write 回滚（对齐 `history/rollback.ts`）。

use super::*;
use crate::test_support::Sandbox;
use serde_json::json;

/// 写一份可被 `history::load_messages` 还原的会话文件
fn write_conversation(session_id: &str, project: &str, records: Vec<Value>) {
    let path = history::messages_path(session_id, project).expect("messages path");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create conversation dir");
    }
    let body: String = records
        .iter()
        .map(|record| format!("{}\n", serde_json::to_string(record).unwrap()))
        .collect();
    std::fs::write(&path, body).expect("write conversation");
}

fn assistant_record(uuid: &str, tool_use_id: &str, name: &str, input: Value, meta: Value) -> Value {
    json!({
        "uuid": uuid,
        "parentUuid": null,
        "timestamp": 1,
        "message": {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": name,
                    "input": input,
                    "_meta": meta,
                }],
            },
            "uuid": uuid,
        },
    })
}

fn tool_result_record(uuid: &str, tool_use_id: &str, before: Value) -> Value {
    json!({
        "uuid": uuid,
        "parentUuid": null,
        "timestamp": 2,
        "message": {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": "ok",
                    "beforeContent": before,
                }],
            },
            "uuid": uuid,
        },
    })
}

#[test]
fn rolls_back_to_before_content_from_meta() {
    let sandbox = Sandbox::new("rollback-before");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW CONTENT\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({ "file_path": "a.txt" }),
            json!({ "beforeContent": "OLD CONTENT\n", "afterContent": "NEW CONTENT\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "已回滚到目标修改前：恢复了 1 个文件");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD CONTENT\n"
    );
}

#[test]
fn rolls_back_to_after_content_from_meta() {
    let sandbox = Sandbox::new("rollback-after");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "SOMETHING ELSE\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({ "file_path": "a.txt" }),
            json!({ "beforeContent": "OLD CONTENT\n", "afterContent": "NEW CONTENT\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "after", None);
    assert_eq!(message, "已回滚到目标修改后：恢复了 1 个文件");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "NEW CONTENT\n"
    );
}

#[test]
fn falls_back_to_tool_result_before_content() {
    let sandbox = Sandbox::new("rollback-tool-result");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW CONTENT\n");
    write_conversation(
        "s1",
        &project,
        vec![
            assistant_record(
                "a1",
                "toolu_1",
                "Edit",
                json!({ "file_path": "a.txt" }),
                json!({}),
            ),
            tool_result_record("u1", "toolu_1", json!("OLD CONTENT\n")),
        ],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "已回滚到目标修改前：恢复了 1 个文件");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD CONTENT\n"
    );
}

#[test]
fn deletes_file_when_before_content_is_null() {
    let sandbox = Sandbox::new("rollback-delete");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    let created = sandbox.write_file("created.txt", "NEW FILE\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Write",
            json!({ "file_path": "created.txt" }),
            json!({ "beforeContent": null, "afterContent": "NEW FILE\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "已回滚到目标修改前：恢复了 1 个文件");
    assert!(!created.exists(), "beforeContent 为 null 应删除文件");
}

#[test]
fn restores_subsequent_edits_to_their_first_before_content() {
    let sandbox = Sandbox::new("rollback-subsequent");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "SECOND\n");
    sandbox.write_file("b.txt", "B2\n");
    write_conversation(
        "s1",
        &project,
        vec![
            assistant_record(
                "a1",
                "toolu_1",
                "Edit",
                json!({ "file_path": "a.txt" }),
                json!({ "beforeContent": "FIRST\n", "afterContent": "SECOND\n" }),
            ),
            assistant_record(
                "a2",
                "toolu_2",
                "Edit",
                json!({ "file_path": "b.txt" }),
                json!({ "beforeContent": "B1\n", "afterContent": "B2\n" }),
            ),
            assistant_record(
                "a3",
                "toolu_3",
                "Edit",
                json!({ "file_path": "a.txt" }),
                json!({ "beforeContent": "SECOND\n", "afterContent": "THIRD\n" }),
            ),
        ],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "已回滚到目标修改前：恢复了 2 个文件");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "FIRST\n"
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("b.txt")).unwrap(),
        "B1\n"
    );
}

#[test]
fn uses_fallback_file_path_when_input_is_double_encoded() {
    // Provider 把整个入参 double-encode 成字符串：input.file_path 取不到，
    // 必须靠 UiEvent 的 filePath 兜底（对齐 editRollback.test.ts 的关键回归）。
    let sandbox = Sandbox::new("rollback-fallback-path");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW CONTENT\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!("{\"file_path\":\"a.txt\"}"),
            json!({ "beforeContent": "OLD CONTENT\n", "afterContent": "NEW CONTENT\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "before", Some("a.txt"));
    assert_eq!(message, "已回滚到目标修改前：恢复了 1 个文件");
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "OLD CONTENT\n"
    );
}

#[test]
fn reports_missing_target() {
    let sandbox = Sandbox::new("rollback-missing-target");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({ "file_path": "a.txt" }),
            json!({ "beforeContent": "OLD\n", "afterContent": "NEW\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_missing", "before", None);
    assert_eq!(message, "未找到指定的编辑操作，可能历史记录已被压缩");
}

#[test]
fn reports_missing_file_path() {
    let sandbox = Sandbox::new("rollback-missing-path");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({}),
            json!({ "beforeContent": "OLD\n", "afterContent": "NEW\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "目标编辑操作缺少文件路径，无法回滚");
}

#[test]
fn reports_missing_before_content() {
    let sandbox = Sandbox::new("rollback-missing-before");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({ "file_path": "a.txt" }),
            json!({ "afterContent": "NEW\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "before", None);
    assert_eq!(message, "目标编辑操作缺少备份内容（beforeContent），无法回滚");
}

#[test]
fn reports_missing_after_content() {
    let sandbox = Sandbox::new("rollback-missing-after");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s1", Some(project.clone()));
    sandbox.write_file("a.txt", "NEW\n");
    write_conversation(
        "s1",
        &project,
        vec![assistant_record(
            "a1",
            "toolu_1",
            "Edit",
            json!({ "file_path": "a.txt" }),
            json!({ "beforeContent": "OLD\n" }),
        )],
    );

    let message = rollback_edit("s1", "toolu_1", "after", None);
    assert_eq!(message, "目标编辑操作缺少备份内容（afterContent），无法回滚到修改后");
}

//! Edit / Write 文件回滚（对齐 `history/rollback.ts`）。
//!
//! `UiEvent.editRolledBack` 的 core 侧实现：从会话历史里找到目标 tool_use，按其
//! `_meta` / `tool_result.beforeContent` 备份把磁盘文件恢复到修改前 / 修改后，
//! 并把结果作为一条 `system` 消息回传（返回值即消息文案，由调用方 emit）。

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::config;
use crate::history;
use crate::tools;

/// `asContentOrNull`：只有字符串 / null 才算「有记录」，其余（含缺失）视为未记录。
fn content_or_null(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(Value::Null) => Some(None),
        _ => None,
    }
}

/// 历史里一次 Edit / Write 调用的备份信息
struct EditCall {
    id: String,
    input: Value,
    /// `_meta.beforeContent`（`None` = 未记录，`Some(None)` = 文件原本不存在）
    before: Option<Option<String>>,
    /// `_meta.afterContent`
    after: Option<Option<String>>,
}

/// 回滚会话历史中的 Edit / Write 操作，返回回传给 webview 的系统消息文案。
pub fn rollback_edit(
    session_id: &str,
    tool_use_id: &str,
    direction: &str,
    fallback_file_path: Option<&str>,
) -> String {
    match rollback_inner(session_id, tool_use_id, direction, fallback_file_path) {
        Ok(content) => content,
        Err(message) => format!("Rollback failed: {message}"),
    }
}

fn rollback_inner(
    session_id: &str,
    tool_use_id: &str,
    direction: &str,
    fallback_file_path: Option<&str>,
) -> Result<String, String> {
    // 回滚的相对路径以「会话自己的工作目录」为基准：多工作目录下若用进程级项目根，
    // 会话切到后台（活动目录已变）时会解析到别的目录，可能改错文件。
    let project = config::project_root(session_id)?;
    let messages = history::load_messages(session_id, &project);

    // 按消息顺序收集所有 Edit / Write tool_use
    let mut calls: Vec<EditCall> = Vec::new();
    // tool_result 的 beforeContent 按 tool_use_id 索引（`_meta` 可能因写入时序未持久化）
    let mut result_before: HashMap<String, Option<String>> = HashMap::new();

    for message in &messages {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        if kind == "assistant" {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                if name != "Edit" && name != "Write" {
                    continue;
                }
                let meta = block.get("_meta");
                calls.push(EditCall {
                    id: block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    input: block.get("input").cloned().unwrap_or(Value::Null),
                    before: content_or_null(meta.and_then(|meta| meta.get("beforeContent"))),
                    after: content_or_null(meta.and_then(|meta| meta.get("afterContent"))),
                });
            }
        } else if kind == "user" {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                if let Some(before) = content_or_null(block.get("beforeContent")) {
                    result_before.insert(
                        block
                            .get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        before,
                    );
                }
            }
        }
    }

    let Some(target_index) = calls.iter().position(|call| call.id == tool_use_id) else {
        return Ok("Edit operation not found; the history may have been compacted".to_string());
    };

    // 先从 `_meta` 读，缺失时从 tool_result 的 beforeContent 读
    // （Write 新建文件可能为 null）
    let target = &calls[target_index];
    let target_before = match target.before.clone() {
        Some(value) => Some(value),
        None => result_before.get(&target.id).cloned(),
    };
    let target_after = target.after.clone();

    let target_file_path = match target.input.get("file_path") {
        Some(Value::String(text)) => text.clone(),
        _ => fallback_file_path.unwrap_or("").to_string(),
    };
    if target_file_path.is_empty() {
        return Ok("Target edit has no file_path; cannot roll back".to_string());
    }

    if direction == "before" {
        // `null` 合法（文件原本不存在 → 删除）；`undefined` 与空串视为缺少备份
        let missing = match &target_before {
            None => true,
            Some(Some(text)) => text.is_empty(),
            Some(None) => false,
        };
        if missing {
            return Ok("Target edit has no beforeContent backup; cannot roll back".to_string());
        }
    }
    if direction == "after" {
        let missing = match &target_after {
            None | Some(None) => true,
            Some(Some(text)) => text.is_empty(),
        };
        if missing {
            return Ok("Target edit has no afterContent backup; cannot roll back to post-edit state".to_string());
        }
    }

    // 两个方向的差异只在目标文件写回的内容：
    // - before：回滚到目标修改**前**（用目标的 beforeContent 写回）
    // - after：回滚到目标修改**后**（用目标的 afterContent 写回，保留目标自身改动）
    // 其它文件两个方向一致：恢复到它们在目标时刻的状态（第一次被 Edit 前的状态）。
    let target_content = if direction == "before" {
        target_before.clone().unwrap_or(None)
    } else {
        target_after.clone().unwrap_or(None)
    };

    let mut files: Vec<(String, Option<String>)> = vec![(target_file_path.clone(), target_content)];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(target_file_path.clone());
    for call in calls.iter().skip(target_index + 1) {
        let file_path = match call.input.get("file_path") {
            Some(Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        if file_path.is_empty() || seen.contains(&file_path) {
            continue;
        }
        if let Some(before) = &call.before {
            files.push((file_path.clone(), before.clone()));
            seen.insert(file_path);
        }
    }

    let mut restored = 0usize;
    for (file_path, content) in files {
        let full_path = tools::expand_path(&project, &file_path);
        match content {
            // beforeContent 为 null 表示文件原本不存在，删除它
            None => match std::fs::remove_file(&full_path) {
                Ok(()) => restored += 1,
                // 已经不存在也算恢复完成（对齐 Embedded 的 ENOENT 分支）
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => restored += 1,
                Err(_) => {}
            },
            Some(text) => {
                if let Some(parent) = full_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::write(&full_path, text).is_ok() {
                    restored += 1;
                }
            }
        }
    }

    let detail = if restored > 0 {
        format!("restored {restored} file(s)")
    } else {
        "no files to restore".to_string()
    };
    let label = if direction == "before" { "before" } else { "after" };
    Ok(format!("Rolled back to {label} the target edit: {detail}"))
}

#[cfg(test)]
#[path = "rollback_tests.rs"]
mod tests;

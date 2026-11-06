//! 时间线节点「从这里继续」（specs/039，`docs/features/user-stories/dialog-core.md`）。
//!
//! 把对话回退到某个节点之前：截断该节点之后的全部消息、把区间内被 Edit / Write 改过的
//! 文件恢复到「区间内第一次改之前」，并给出一条系统回执。截断与恢复都在 core 里做——
//! webview 只上报目标节点 id（JSONL 行的 `uuid`），不自己算新消息序列
//! （[docs/architecture/principles.md 第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)）。
//!
//! 文件备份复用 `rollback.rs` 的 `beforeContent` 口径与 `restore_before` 写盘实现：
//! 不新建快照机制，两者只是「选哪一份 beforeContent」不同。

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::config;
use crate::history;
use crate::rollback;
use crate::util;

/// 一次对话级回退的结果（组装 `conversationRewoundDone` 用）
pub struct RewindOutcome {
    /// 删除的 JSONL 行数
    pub removed: usize,
    /// 目标节点 uuid
    pub target: String,
    /// 已恢复的文件（`ok: false` 时带错误文案）
    pub files: Vec<RewindFile>,
    /// 区间内改过但没有 `beforeContent` 备份、因而跳过的文件
    pub skipped: Vec<String>,
    /// 区间内是否有 Bash 调用（它的文件改动不回滚，只在回执里提示）
    pub had_bash: bool,
}

/// 单个文件的恢复结果
pub struct RewindFile {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// 截断点（specs/039 FR-003）：返回保留到哪个下标（不含）。
///
/// - 目标是 `user` 消息：**保留**该条（用户想从这条重来），截断点 = 下标 + 1；
/// - 目标是 `assistant` / `toolcall`（`tool_use` 来自 assistant 行）：保留到该 assistant
///   行（含），紧随其后的 `tool_result` 属于同一次调用，一并删除；
/// - 目标是 `system` / `thinking`：它们是产出物，不是「从这里继续」的起点，截断点 = 下标。
///
/// 找不到目标返回 `None`（调用方转错误回执，不动任何文件）。
pub fn truncate_index(messages: &[Value], target_uuid: &str) -> Option<usize> {
    let index = match messages
        .iter()
        .position(|message| message.get("uuid").and_then(Value::as_str) == Some(target_uuid))
    {
        Some(index) => index,
        // 工具卡片的节点身份可能是 tool_use id（实时流式期还没有 JSONL uuid，
        // specs/039 FR-001）：按 tool_use 块反查它所属的 assistant 行
        None => messages.iter().position(|message| {
            message.get("type").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("message")
                    .and_then(|inner| inner.get("content"))
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_use")
                                && block.get("id").and_then(Value::as_str) == Some(target_uuid)
                        })
                    })
        })?,
    };
    let kind = messages[index].get("type").and_then(Value::as_str).unwrap_or("");
    Some(match kind {
        // 用户消息保留自身：重来时这条输入仍在输入框的语义位
        "user" => index + 1,
        // assistant 行承载 tool_use：保留该行，其后的 tool_result 一并删除
        "assistant" => index + 1,
        // system / thinking 是产出物：从它之前继续
        _ => index,
    })
}

/// 区间 `[cut, ..)` 内出现过的 Edit / Write 调用：按路径取**最早**那次修改前的备份。
///
/// 多个 tool_use 改同一文件时只用最早的 before（spec FR-004 第 3 条）：那次之前的内容
/// 才是「回退到该节点时刻」的状态。
fn collect_restores(messages: &[Value], cut: usize) -> (HashMap<String, Option<String>>, Vec<String>, bool) {
    // tool_result 里的 beforeContent 按 tool_use_id 索引（`_meta` 可能因写入时序未持久化）
    let mut result_before: HashMap<String, Option<String>> = HashMap::new();
    for message in messages {
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            if let Some(before) = content_or_null(block.get("beforeContent")) {
                result_before.insert(
                    block.get("tool_use_id").and_then(Value::as_str).unwrap_or("").to_string(),
                    before,
                );
            }
        }
    }

    // 按消息顺序遍历区间：路径 → 最早那份 beforeContent
    let mut restores: HashMap<String, Option<String>> = HashMap::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut had_bash = false;
    for message in messages.iter().skip(cut) {
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        if message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let name = block.get("name").and_then(Value::as_str).unwrap_or("");
            if name == "Bash" {
                had_bash = true;
                continue;
            }
            if name != "Edit" && name != "Write" {
                continue;
            }
            let path = block
                .get("input")
                .and_then(|input| input.get("file_path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if path.is_empty() {
                continue;
            }
            if restores.contains_key(path) {
                // 区间内已经记录过更早的备份：后来的那次不覆盖（回到节点时刻的状态）
                continue;
            }
            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
            let from_meta = content_or_null(block.get("_meta").and_then(|meta| meta.get("beforeContent")));
            let before = match from_meta {
                Some(value) => Some(value),
                None => result_before.get(id).cloned(),
            };
            match before {
                Some(value) => {
                    restores.insert(path.to_string(), value);
                }
                // 没有备份：跳过并如实列出（不阻止其余文件恢复）
                None => skipped.push(path.to_string()),
            }
        }
    }
    (restores, skipped, had_bash)
}

/// `asContentOrNull`：只有字符串 / null 才算「有记录」，其余（含缺失）视为未记录。
fn content_or_null(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        Some(Value::String(text)) => Some(Some(text.clone())),
        Some(Value::Null) => Some(None),
        _ => None,
    }
}

/// 回执文案（specs/039 FR-006）：删了多少条、恢复了哪些、跳过了哪些。
///
/// 作为一条 `role: "system"` 消息落盘，与 `editRolledBack` 的回执同形态；
/// `excludeFromContext` 让它不进 LLM 上下文（与单次回滚回执同一口径）。
pub fn receipt_text(outcome: &RewindOutcome) -> String {
    let restored: Vec<&str> = outcome
        .files
        .iter()
        .filter(|file| file.ok)
        .map(|file| file.path.as_str())
        .collect();
    let failed: Vec<&RewindFile> = outcome.files.iter().filter(|file| !file.ok).collect();
    let mut lines = vec![format!(
        "Rewound the conversation from this point: removed {} message(s).",
        outcome.removed
    )];
    if restored.is_empty() && failed.is_empty() {
        lines.push("No files needed to be rolled back.".to_string());
    } else {
        if !restored.is_empty() {
            lines.push(format!("Restored {} file(s): {}", restored.len(), restored.join(", ")));
        }
        for file in failed {
            lines.push(format!(
                "Failed to restore {}: {}",
                file.path,
                file.error.clone().unwrap_or_else(|| "unknown error".to_string())
            ));
        }
    }
    if !outcome.skipped.is_empty() {
        lines.push(format!(
            "Skipped {} file(s) without a before-edit backup: {}",
            outcome.skipped.len(),
            outcome.skipped.join(", ")
        ));
    }
    if outcome.had_bash {
        lines.push("Note: Bash changed files in this range; those changes were not rolled back.".to_string());
    }
    lines.join("\n")
}

/// 执行回退：截断 + 文件恢复。`state` 为会话内存状态（`None` = 会话不存在）。
///
/// 守卫（spec FR-005）：会话非空闲 → `Err`；目标 id 找不到 → `Err`（不动文件）。
pub fn rewind(
    session_id: &str,
    target_uuid: &str,
    state: &std::sync::Arc<std::sync::Mutex<crate::engine::SessionState>>,
) -> Result<RewindOutcome, String> {
    let project = config::project_root(session_id)?;
    let messages = history::load_messages(session_id, &project);
    let cut = truncate_index(&messages, target_uuid)
        .ok_or_else(|| "target node not found; the history may have been compacted".to_string())?;
    if cut >= messages.len() {
        return Err("no messages after the target node to remove".to_string());
    }

    let (restores, skipped, had_bash) = collect_restores(&messages, cut);
    let removed = messages.len() - cut;

    // 先截断对话再恢复文件：用户看到的是「对话已经回到该点」，文件恢复失败在回执里列明。
    // 落盘与内存三字段同一次更新（与 `persist_message` 之后的权�衡同款）。
    history::replace_messages(session_id, &project, &messages[..cut])?;
    {
        let mut state = state.lock().unwrap();
        state.messages.truncate(cut);
        state.persisted_count = cut;
        state.last_uuid = messages[..cut]
            .last()
            .and_then(|message| message.get("uuid").and_then(Value::as_str))
            .map(str::to_string);
    }

    let mut files: Vec<RewindFile> = Vec::new();
    for (path, before) in restores {
        match rollback::restore_before(&project, &path, before.as_deref()) {
            Ok(()) => files.push(RewindFile { path, ok: true, error: None }),
            Err(error) => files.push(RewindFile { path, ok: false, error: Some(error) }),
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(RewindOutcome {
        removed,
        target: target_uuid.to_string(),
        files,
        skipped,
        had_bash,
    })
}

/// 回执消息（判别联合：成功带 outcome、失败带文案），由调用方落盘并 emit。
pub fn receipt_message(outcome: &RewindOutcome) -> Value {
    json!({
        "role": "system",
        "content": receipt_text(outcome),
        "type": "system",
        "uuid": format!("rewind_{}", util::now_millis()),
        "timestamp": util::now_millis(),
        "_meta": { "excludeFromContext": true },
    })
}

#[cfg(test)]
#[path = "rewind_tests.rs"]
mod tests;

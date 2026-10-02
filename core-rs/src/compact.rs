//! 对话压缩（对齐 Embedded `src/core/compact/*`）。
//!
//! 模块划分与 Embedded 一致：
//! - `types.ts` → 阈值常量 / [`get_auto_compact_threshold`] / `COMPACT_SYSTEM_PROMPT`
//! - `prompt.ts` → [`format_messages_for_compact`] / [`generate_compact_summary_prompt`] 等
//! - `autoCompact.ts` → [`is_auto_compact_enabled`] / [`should_auto_compact`]
//! - `state.ts` → 「正在压缩」/「待压缩」注册表
//! - `compact.ts` → [`compact_conversation`] / [`compact_and_apply_messages`] /
//!   [`sanitize_tool_pairing`] / [`build_post_compact_messages`]
//!
//! 压缩会**整体替换**会话消息（先清空再重新 push），因此期间必须挡住并发消费：
//! 用户新消息只入队不启动消费循环，压缩收尾时由 `engine::resume_after_compact`
//! 统一唤醒。

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::config;
use crate::engine::{Core, SessionState};
use crate::history;
use crate::llm;
use crate::replay;
use crate::util;

// ==================== types.ts ====================

/// 自动压缩预留缓冲上限（token）
pub const AUTOCOMPACT_MAX_BUFFER: u64 = 50_000;
/// 自动压缩预留缓冲比例（相对 maxOutputTokens）
pub const AUTOCOMPACT_OUTPUT_BUFFER_RATIO: f64 = 0.3;
/// 熔断：连续失败上限
pub const MAX_CONSECUTIVE_FAILURES: u64 = 3;

/// 压缩 / 摘要 LLM 调用的 system prompt
pub const COMPACT_SYSTEM_PROMPT: &str = "你是一个专业的对话摘要助手。请简洁准确地总结对话内容。";

/// 自动压缩阈值（可用输入上限）：`contextWindow - min(50K, 0.3 * maxOutputTokens)`。
///
/// 返回 `f64`：Embedded 是纯 JS 浮点运算，`0.3 * 8192 = 2457.6` 这类非整数值
/// 会原样参与比较（截断成整数会在阈值恰好落在边界时改变判定结果）。
pub fn get_auto_compact_threshold(context_window: u64, max_output_tokens: u64) -> f64 {
    let buffer =
        AUTOCOMPACT_OUTPUT_BUFFER_RATIO * (max_output_tokens.max(0) as f64);
    let buffer = (AUTOCOMPACT_MAX_BUFFER as f64).min(buffer);
    (context_window as f64 - buffer).max(0.0)
}

// ==================== autoCompact.ts ====================

/// 自动压缩是否启用（`DISABLE_AUTO_COMPACT=true` 关闭）
pub fn is_auto_compact_enabled() -> bool {
    if std::env::var("DISABLE_AUTO_COMPACT").ok().as_deref() == Some("true") {
        return false;
    }
    true
}

/// 自动压缩跟踪状态（`AutoCompactTrackingState`）。
///
/// 只有 `consecutive_failures` 参与判定；`compacted` / `turn_id` / `turn_counter`
/// 是数据契约字段（Embedded 也只写不读），保留以便后续接入告警 / 遥测。
#[derive(Clone, Debug, Default)]
#[allow(dead_code)]
pub struct AutoCompactTracking {
    pub consecutive_failures: u64,
    pub compacted: bool,
    pub turn_id: String,
    pub turn_counter: u64,
}

/// 是否应当触发自动压缩。
///
/// 条件：已启用 + 未熔断 + 已给出 token 数且达到阈值。
pub fn should_auto_compact(
    tracking: Option<&AutoCompactTracking>,
    token_count: Option<u64>,
    context_window: u64,
    max_output_tokens: u64,
) -> bool {
    if !is_auto_compact_enabled() {
        return false;
    }
    if let Some(tracking) = tracking {
        if tracking.consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            return false;
        }
    }
    let Some(token_count) = token_count else {
        return false;
    };
    let threshold = get_auto_compact_threshold(context_window, max_output_tokens);
    token_count as f64 >= threshold
}

// ==================== state.ts ====================

/// 正在压缩的会话
static COMPACTING: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// 待压缩的会话（非空闲时手动触发，延后到下一轮对话开始执行）
static PENDING_COMPACT: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn mark_compacting(session_id: &str) {
    let mut sessions = COMPACTING.lock().unwrap();
    if !sessions.iter().any(|id| id == session_id) {
        sessions.push(session_id.to_string());
    }
}

pub fn unmark_compacting(session_id: &str) {
    COMPACTING.lock().unwrap().retain(|id| id != session_id);
}

pub fn is_compacting(session_id: &str) -> bool {
    COMPACTING.lock().unwrap().iter().any(|id| id == session_id)
}

pub fn mark_pending_compact(session_id: &str) {
    let mut sessions = PENDING_COMPACT.lock().unwrap();
    if !sessions.iter().any(|id| id == session_id) {
        sessions.push(session_id.to_string());
    }
}

pub fn unmark_pending_compact(session_id: &str) {
    PENDING_COMPACT.lock().unwrap().retain(|id| id != session_id);
}

pub fn is_pending_compact(session_id: &str) -> bool {
    PENDING_COMPACT.lock().unwrap().iter().any(|id| id == session_id)
}

/// 仅测试用：清空两个注册表
#[cfg(test)]
pub fn reset_for_test() {
    COMPACTING.lock().unwrap().clear();
    PENDING_COMPACT.lock().unwrap().clear();
}

// ==================== prompt.ts ====================

/// 把消息格式化成摘要输入文本（`formatMessagesForCompact`）
pub fn format_messages_for_compact(messages: &[Value]) -> String {
    let mut formatted: Vec<String> = Vec::new();
    for message in messages {
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                let content = message.get("message").and_then(|inner| inner.get("content"));
                let text = match content {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(blocks)) => format_content_blocks(blocks),
                    _ => String::new(),
                };
                formatted.push(format!("[User]: {text}"));
            }
            Some("assistant") => {
                let content = message.get("message").and_then(|inner| inner.get("content"));
                let text = match content {
                    Some(Value::Array(blocks)) => format_assistant_content(blocks),
                    _ => String::new(),
                };
                formatted.push(format!("[Assistant]: {text}"));
            }
            Some("system") => {
                let text = message
                    .get("content")
                    .map(util::js_string)
                    .unwrap_or_default();
                formatted.push(format!("[System]: {text}"));
            }
            _ => {}
        }
    }
    formatted.join("\n\n")
}

/// 用户消息的内容块（`formatContentBlocks`）
fn format_content_blocks(blocks: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        let Some(object) = block.as_object() else {
            let text = util::js_string(block);
            if !text.is_empty() {
                parts.push(text);
            }
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" => object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "tool_result" => {
                let result_content = match object.get("content") {
                    Some(Value::Array(inner)) => inner
                        .iter()
                        .map(|part| match part.as_object() {
                            Some(object) => match object.get("type").and_then(Value::as_str) {
                                Some("text") => object
                                    .get("text")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string(),
                                Some("image") => "[Image]".to_string(),
                                _ => util::js_string(part),
                            },
                            None => util::js_string(part),
                        })
                        .filter(|text| !text.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    Some(other) => util::js_string(other),
                    None => String::new(),
                };
                format!("[Tool Result]: {result_content}")
            }
            "image" => "[Image]".to_string(),
            _ => {
                if let Some(source) = object.get("source").and_then(Value::as_object) {
                    match source.get("file_path").and_then(Value::as_str) {
                        Some(path) => format!("[File: {path}]"),
                        None => "[Source]".to_string(),
                    }
                } else {
                    // 对齐 `prompt.ts` 的 `JSON.stringify(block)`（JS 数字口径）
                    util::js_json_stringify(block)
                }
            }
        };
        if !text.is_empty() {
            parts.push(text);
        }
    }
    parts.join("\n")
}

/// assistant 消息的内容块（`formatAssistantContent`）
fn format_assistant_content(blocks: &[Value]) -> String {
    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        let Some(object) = block.as_object() else {
            let text = util::js_string(block);
            if !text.is_empty() {
                parts.push(text);
            }
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" => object
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "thinking" => {
                // 对齐 `b.thinking?.substring(0, 200)`：缺失时模板插值成 `undefined`
                let thinking = object
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(|text| util::utf16_take(text, 200))
                    .unwrap_or_else(|| "undefined".to_string());
                format!("[Thinking]: {thinking}...")
            }
            "tool_use" => format!(
                "[Tool: {}]",
                object.get("name").and_then(Value::as_str).unwrap_or("")
            ),
            _ => String::new(),
        };
        if !text.is_empty() {
            parts.push(text);
        }
    }
    parts.join("\n")
}

/// 从用户消息里提取纯文本（对齐 `compact/prompt.ts` 的**局部** `extractUserContent`：
/// 它收的是整条消息、返回字符串，与 `utils/contentBlocks.ts` 的同名函数不同）。
pub fn extract_user_content(message: &Value) -> String {
    let content = message.get("message").and_then(|inner| inner.get("content"));
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<String> = Vec::new();
            for block in blocks {
                match block {
                    Value::Object(object) => {
                        if object.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(text) = object.get("text").and_then(Value::as_str) {
                                parts.push(text.to_string());
                            }
                        }
                    }
                    Value::String(text) => parts.push(text.clone()),
                    _ => {}
                }
            }
            parts.join("\n")
        }
        // `String(content ?? '')`：null / undefined 都归空串
        Some(Value::Null) | None => String::new(),
        Some(other) => util::js_string(other),
    }
}

/// 文本是否像系统自动产生的提醒（`isReminderText`）
fn is_reminder_text(content: &str) -> bool {
    let trimmed = util::js_trim(content);
    if trimmed.is_empty() {
        return true;
    }
    // 匹配 `<reminder>` / `<Reminder>` / `</reminder>` 等标记
    let lower = trimmed.to_lowercase();
    let mut rest = lower.as_str();
    while let Some(index) = rest.find("<") {
        rest = &rest[index..];
        let candidate = rest.strip_prefix("</").or_else(|| rest.strip_prefix('<'));
        if let Some(candidate) = candidate {
            if candidate.starts_with("reminder>") {
                return true;
            }
        }
        rest = &rest[1..];
    }
    false
}

/// 提取用户真实输入的消息（`getUserInputHistory`）
pub fn get_user_input_history(messages: &[Value]) -> Vec<Value> {
    let mut history_messages: Vec<Value> = Vec::new();
    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if message.get("silent").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if is_auto_message(message) {
            continue;
        }
        if message.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if message.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if message.get("reminder").is_some() {
            continue;
        }
        let content = extract_user_content(message);
        if util::js_trim(&content).is_empty() || is_reminder_text(&content) {
            continue;
        }
        history_messages.push(message.clone());
    }
    history_messages
}

/// 消息来源是否属于系统自动消息（对齐 `getMessageOrigin` + `isAutoMessage`）
pub fn is_auto_message(message: &Value) -> bool {
    match message.get("origin").and_then(Value::as_str) {
        Some("agent") | Some("bash") => true,
        Some(_) => false,
        None => {
            message.get("fromSubAgent").and_then(Value::as_bool) == Some(true)
                || message.get("fromBashTask").and_then(Value::as_bool) == Some(true)
        }
    }
}

/// 把用户输入历史格式化成编号列表（`formatUserInputHistory`）
pub fn format_user_input_history(messages: &[Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut index = 0u64;
    for message in messages {
        let content = util::js_trim(&extract_user_content(message)).to_string();
        if content.is_empty() {
            continue;
        }
        index += 1;
        lines.push(format!("{index}. {content}"));
    }
    lines.join("\n\n")
}

/// 摘要生成 prompt（`generateCompactSummaryPrompt`）
pub fn generate_compact_summary_prompt(
    messages: &[Value],
    custom_instructions: Option<&str>,
) -> String {
    let formatted = format_messages_for_compact(messages);
    let base = format!(
        "请总结以下对话的要点，创建一个简洁但全面的摘要。\n\n\
         对话内容：\n{formatted}\n\n\
         请按照以下格式生成摘要：\n\n\
         ## 对话摘要\n\n\
         ### 主要话题\n[1-3句话概括主要讨论内容]\n\n\
         ### 关键决策\n- [列出做出的重要决定]\n- [或者: 无]\n\n\
         ### 重要信息\n- [需要记住的重要信息，如文件路径、配置值等]\n- [或者: 无]\n\n\
         ### 未完成事项\n- [如果有未完成的任务或需要继续的工作]\n- [或者: 无]\n\n\
         ### 后续建议\n[1-2句话建议如何继续]"
    );
    match custom_instructions {
        Some(instructions) => format!("{base}\n\n\n\n额外指示：{instructions}"),
        None => base,
    }
}

/// 压缩后注入的 user 消息正文（`generateCompactUserMessage`）
pub fn generate_compact_user_message(
    summary: &str,
    transcript_path: Option<&str>,
    user_input_history: Option<&str>,
) -> String {
    let mut content = format!("以下是之前对话的摘要：\n\n{summary}");
    if let Some(path) = transcript_path {
        content.push_str(&format!("\n\n完整对话记录保存在: {path}"));
    }
    if let Some(history) = user_input_history {
        content.push_str(&format!("\n\n### 用户输入历史\n\n{history}"));
    }
    content.push_str("\n\n---\n\n请基于以上摘要继续工作。如有需要，我可以提供更多细节。");
    content
}

/// 边界标记正文（`generateCompactBoundaryContent`）。
///
/// `date` 由调用方传入（Embedded 用 `new Date().toISOString()`）。
pub fn generate_compact_boundary_content(
    trigger: &str,
    pre_compact_token_count: u64,
    last_message_uuid: Option<&str>,
    date: &str,
) -> String {
    let trigger_text = if trigger == "auto" { "Auto" } else { "Manual" };
    let suffix = match last_message_uuid {
        Some(uuid) => format!(" | last message: {uuid}"),
        None => String::new(),
    };
    format!("[{trigger_text} compaction boundary] {date} | ~{pre_compact_token_count} tokens before compaction{suffix}")
}

// ==================== compact.ts ====================

/// 压缩结果（`CompactionResult`）
#[derive(Clone)]
pub struct CompactionResult {
    pub boundary_marker: Value,
    pub summary_messages: Vec<Value>,
    pub messages_to_keep: Option<Vec<Value>>,
}

/// 边界标记之后的消息（`getMessagesAfterCompactBoundary`）
fn messages_after_compact_boundary(messages: &[Value]) -> Vec<Value> {
    let last_boundary = messages.iter().rposition(|message| {
        message.get("type").and_then(Value::as_str) == Some("system")
            && message.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
    });
    match last_boundary {
        Some(index) => messages[index + 1..].to_vec(),
        None => messages.to_vec(),
    }
}

/// 是否有可压缩的消息（`hasCompactableMessages`）：
/// 边界之后的消息数必须**严格大于** `max_messages_to_keep`。
pub fn has_compactable_messages(messages: &[Value], max_messages_to_keep: usize) -> bool {
    messages_after_compact_boundary(messages).len() > max_messages_to_keep
}

/// 压缩后的消息数组（`buildPostCompactMessages`）
pub fn build_post_compact_messages(result: &CompactionResult) -> Vec<Value> {
    let mut messages = vec![result.boundary_marker.clone()];
    messages.extend(result.summary_messages.iter().cloned());
    if let Some(keep) = &result.messages_to_keep {
        messages.extend(keep.iter().cloned());
    }
    messages
}

/// 清掉 assistant 消息上的 `usage`（`clearMessageUsage`），避免压缩后残留旧 token 数据
fn clear_message_usage(message: &Value) -> Value {
    let is_assistant = message.get("type").and_then(Value::as_str) == Some("assistant");
    let has_usage = message
        .get("message")
        .and_then(|inner| inner.get("usage"))
        .is_some();
    if !is_assistant || !has_usage {
        return message.clone();
    }
    let mut cloned = message.clone();
    if let Some(inner) = cloned.get_mut("message").and_then(Value::as_object_mut) {
        inner.insert("usage".to_string(), Value::Null);
    }
    cloned
}

/// 修复压缩截断导致的 `tool_use` / `tool_result` 配对断裂（`sanitizeToolPairing`）。
///
/// 1. 保留区里孤立的 `tool_result`（其 `tool_use` 不在保留区）→ 删除该块；
///    整条消息只剩孤儿 `tool_result` 时丢弃该消息。
/// 2. 保留区里孤立的 `tool_use` → 补一条 `is_canceled: true` 的合成 `tool_result`。
pub fn sanitize_tool_pairing(messages: &[Value]) -> Vec<Value> {
    let mut tool_use_ids: Vec<String> = Vec::new();
    let mut tool_result_ids: Vec<String> = Vec::new();
    for message in messages {
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("assistant") => {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                        if let Some(id) = block.get("id").and_then(Value::as_str) {
                            tool_use_ids.push(id.to_string());
                        }
                    }
                }
            }
            Some("user") => {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                            tool_result_ids.push(id.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut result: Vec<Value> = Vec::new();
    for message in messages {
        if message.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(blocks) = message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
            {
                let has_tool_result = blocks
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"));
                if has_tool_result {
                    let kept: Vec<Value> = blocks
                        .iter()
                        .filter(|block| {
                            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                                return true;
                            }
                            block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .map(|id| tool_use_ids.iter().any(|known| known == id))
                                .unwrap_or(false)
                        })
                        .cloned()
                        .collect();
                    if kept.is_empty() {
                        // 整条消息只剩孤儿 tool_result，整条丢弃
                        continue;
                    }
                    if kept.len() != blocks.len() {
                        let mut cloned = message.clone();
                        if let Some(inner) = cloned.get_mut("message").and_then(Value::as_object_mut)
                        {
                            inner.insert("content".to_string(), Value::Array(kept));
                        }
                        result.push(cloned);
                        continue;
                    }
                }
            }
        }
        result.push(message.clone());

        // 为保留区中缺少 tool_result 的 tool_use 生成 is_canceled 结果
        if message.get("type").and_then(Value::as_str) == Some("assistant") {
            let Some(blocks) = message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            let orphans: Vec<String> = blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .filter_map(|block| block.get("id").and_then(Value::as_str))
                .filter(|id| !tool_result_ids.iter().any(|known| known == id))
                .map(str::to_string)
                .collect();
            if !orphans.is_empty() {
                let content: Vec<Value> = orphans
                    .iter()
                    .map(|id| {
                        json!({
                            "type": "tool_result",
                            "tool_use_id": id,
                            "content": "[Compact interrupted] Tool execution was canceled during compaction.",
                            "is_canceled": true,
                        })
                    })
                    .collect();
                result.push(json!({
                    "type": "user",
                    "message": { "role": "user", "content": content },
                    "uuid": format!("tool_compact_{}_{}", util::now_millis(), util::random_suffix()),
                    "timestamp": util::now_millis(),
                }));
                tool_result_ids.extend(orphans);
            }
        }
    }

    result
}

/// 压缩一次会话；不满足条件时返回 `None`（调用方据此什么都不做）。
///
/// 整个压缩过程（含提前返回与异常）都持有「正在压缩」标记：压缩会整体替换
/// 消息数组，期间不能并发消费排队消息。
#[allow(clippy::too_many_arguments)]
pub fn compact_conversation(
    core: &Arc<Core>,
    session_id: &str,
    provider: Option<&config::ProviderConfig>,
    state: &Arc<Mutex<SessionState>>,
    messages: &[Value],
    custom_instructions: Option<&str>,
    is_auto_compact: bool,
    max_messages_to_keep: usize,
) -> Option<CompactionResult> {
    if !has_compactable_messages(messages, max_messages_to_keep) {
        return None;
    }

    mark_compacting(session_id);
    {
        let mut state = state.lock().unwrap();
        state.compacting = true;
    }
    core.emit_runtime();
    let result = compact_conversation_inner(
        core,
        session_id,
        provider,
        messages,
        custom_instructions,
        is_auto_compact,
        max_messages_to_keep,
    );
    unmark_compacting(session_id);
    {
        let mut state = state.lock().unwrap();
        state.compacting = false;
    }
    core.emit_runtime();
    result
}

#[allow(clippy::too_many_arguments)]
fn compact_conversation_inner(
    core: &Arc<Core>,
    session_id: &str,
    provider: Option<&config::ProviderConfig>,
    messages: &[Value],
    custom_instructions: Option<&str>,
    is_auto_compact: bool,
    max_messages_to_keep: usize,
) -> Option<CompactionResult> {
    // 通知 UI：压缩开始
    core.emit(json!({ "type": "compactBegin", "sessionId": session_id }));

    let messages_for_compact = messages_after_compact_boundary(messages);

    // 保留最近 N 条；截断后必须修复 tool_use / tool_result 配对
    let keep_from = messages_for_compact.len().saturating_sub(max_messages_to_keep);
    let recent_messages: Vec<Value> = sanitize_tool_pairing(
        &messages_for_compact[keep_from..]
            .iter()
            .map(clear_message_usage)
            .collect::<Vec<_>>(),
    );
    let messages_to_summarize: Vec<Value> = messages_for_compact[..keep_from].to_vec();

    if messages_to_summarize.is_empty() {
        // 兜底：调用方已通过 `has_compactable_messages` 提前拦截
        return None;
    }

    let (summary, summary_output_tokens) =
        generate_summary(provider, &messages_to_summarize, custom_instructions, session_id);

    // 提取用户输入历史，追加为摘要消息的一个章节
    let user_input_history = format_user_input_history(&get_user_input_history(&messages_to_summarize));
    let user_input_history = if user_input_history.is_empty() {
        None
    } else {
        Some(user_input_history)
    };

    let last_message_uuid = messages_for_compact
        .last()
        .and_then(|message| message.get("uuid"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let trigger = if is_auto_compact { "auto" } else { "manual" };
    let boundary_marker = json!({
        "type": "system",
        "subtype": "compact_boundary",
        "content": generate_compact_boundary_content(
            trigger,
            0, // token 数在移除本地估算后不可得
            last_message_uuid.as_deref(),
            &iso_now(),
        ),
        "uuid": format!("compact_{}", util::now_millis()),
        "timestamp": util::now_millis(),
        "compactMetadata": {
            "trigger": trigger,
            "preCompactTokenCount": 0,
            "postCompactTokenCount": 0,
            "timestamp": util::now_millis(),
        },
    });

    let summary_message = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": generate_compact_user_message(
                &summary,
                None,
                user_input_history.as_deref(),
            ),
        },
        "uuid": format!("summary_{}", util::now_millis()),
        "timestamp": util::now_millis(),
        "isCompactSummary": true,
    });

    // 通知 UI：压缩完成（带上摘要生成的真实 output tokens）
    core.emit(json!({
        "type": "compactEnd",
        "sessionId": session_id,
        "result": { "status": "complete", "postCompactTokenCount": summary_output_tokens },
    }));

    // 归档：被摘要掉的消息 + 新摘要（保留区不进归档，展开时与归档一起重放）
    if let Ok(project) = core.project_of(session_id) {
        let mut archive = messages_to_summarize.clone();
        archive.push(summary_message.clone());
        if let Err(error) = history::save_compact_archive(session_id, &project, &archive) {
            eprintln!("[core] compact: failed to save compact archive: {error}");
        }
    }

    Some(CompactionResult {
        boundary_marker,
        summary_messages: vec![summary_message],
        messages_to_keep: if recent_messages.is_empty() {
            None
        } else {
            Some(recent_messages)
        },
    })
}

/// 调用 LLM 生成摘要（`generateSummary`）；失败时返回空摘要 + 0 tokens。
fn generate_summary(
    provider: Option<&config::ProviderConfig>,
    messages: &[Value],
    custom_instructions: Option<&str>,
    session_id: &str,
) -> (String, u64) {
    // 对齐 Embedded `generateSummary`：LLM 配置缺失 / 请求失败都在这里吞掉，
    // 返回空摘要 + 0 tokens（压缩流程照常收尾，不把整个压缩判为失败）。
    let Some(provider) = provider else {
        eprintln!("[core] compact: Failed to generate summary: LLM config unavailable");
        return (String::new(), 0);
    };
    let prompt = generate_compact_summary_prompt(messages, custom_instructions);
    let cancel = std::sync::atomic::AtomicBool::new(false);
    let request = llm::LlmRequest {
        provider,
        system_prompt: COMPACT_SYSTEM_PROMPT,
        messages: &[json!({ "role": "user", "content": prompt })],
        tools: &[],
        session_id,
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: llm::DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: llm::DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };

    let mut summary = String::new();
    let mut output_tokens = 0u64;
    let mut failure: Option<String> = None;
    let result = llm::stream(&request, &mut |event| match event {
        llm::LlmEvent::TextDelta(delta) => summary.push_str(&delta),
        llm::LlmEvent::Usage(usage) => {
            if usage.output_tokens > 0 {
                output_tokens = usage.output_tokens;
            }
        }
        _ => {}
    });
    if let Err(error) = result {
        failure = Some(error);
    }
    if let Some(error) = failure {
        eprintln!("[core] compact: Failed to generate summary: {error}");
        return (String::new(), 0);
    }
    (util::js_trim(&summary).to_string(), output_tokens)
}

/// 执行压缩并把结果应用到消息数组（`compactAndApplyMessages`）。
///
/// 就地替换 `messages`（保持与 `SessionState.messages` 的同一份数据）、落盘、
/// 更新 `meta.json` 的压缩状态、通知 UI 重放。
///
/// 返回 `false` 表示不满足压缩条件，未做任何处理。
pub fn compact_and_apply_messages(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    is_auto_compact: bool,
    custom_instructions: Option<&str>,
) -> bool {
    // 先取快照：`compact_conversation` 内部会锁 `state`（写 `compacting`），
    // 不能持锁调用。
    let messages = state.lock().unwrap().messages.clone();
    let provider = session_provider(state);
    let Some(result) = compact_conversation(
        core,
        session_id,
        provider.as_ref(),
        state,
        &messages,
        custom_instructions,
        is_auto_compact,
        30,
    ) else {
        return false;
    };

    let post_compact_messages = build_post_compact_messages(&result);

    // 落盘（整文件重写）
    if let Err(error) = history::replace_messages(session_id, project, &post_compact_messages) {
        eprintln!("[core] compact: failed to replace conversation messages: {error}");
    }

    // 整体替换内存消息，并把「已落盘」计数与 `last_uuid` 指向新的末尾消息：
    // 否则下一次 persist-all 会把压缩新建的 boundary / summary 再 append 一遍，
    // 产生相同 uuid 的重复记录。
    {
        let mut state = state.lock().unwrap();
        state.messages = post_compact_messages.clone();
        state.persisted_count = post_compact_messages.len();
        state.last_uuid = post_compact_messages
            .last()
            .and_then(|message| message.get("uuid"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    // meta.json 的压缩状态
    if let Err(error) = history::update_context(
        session_id,
        project,
        &[
            json!({ "key": "isCompacted", "value": true }),
            json!({ "key": "isExpanded", "value": false }),
        ],
    ) {
        eprintln!("[core] compact: failed to update compact context: {error}");
    }

    // 通知 UI：整批替换
    replay::replay_messages_to_ui(core, session_id, &post_compact_messages);

    true
}

/// 按会话解析 LLM 连接配置（与 `run_turn` 同口径：会话级 model / provider 优先）。
/// 解析失败返回 `None`（摘要退化为空摘要，与 Embedded 的 `generateSummary` 一致）。
fn session_provider(state: &Arc<Mutex<SessionState>>) -> Option<config::ProviderConfig> {
    let (model, provider) = {
        let state = state.lock().unwrap();
        (state.model.clone(), state.provider.clone())
    };
    let mut resolved = match config::resolve_provider(provider.as_deref(), model.as_deref()) {
        Ok(resolved) => resolved,
        Err(error) => {
            eprintln!("[core] compact: resolve provider failed: {error}");
            return None;
        }
    };
    {
        let state = state.lock().unwrap();
        if let Some(effort) = &state.thinking_effort {
            resolved.thinking_effort = effort.clone();
        }
        if let Some(enabled) = state.web_search {
            resolved.web_search = enabled;
        }
    }
    Some(resolved)
}

/// `new Date().toISOString()` 的近似实现（UTC，毫秒 3 位 + `Z`）
fn iso_now() -> String {
    let millis = util::now_millis();
    let seconds = millis / 1000;
    let remainder = millis % 1000;
    let days = seconds / 86_400;
    let time_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = time_of_day / 3600;
    let minute = (time_of_day % 3600) / 60;
    let second = time_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{remainder:03}Z")
}

/// 天数（1970-01-01 起）→ 公历年月日（Howard Hinnant 的 civil_from_days）
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
#[path = "compact_tests.rs"]
mod tests;

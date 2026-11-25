//! 对话压缩。
//!
//! 模块划分：
//! - 阈值常量 / [`get_auto_compact_threshold`] / `COMPACT_SYSTEM_PROMPT`
//! - [`format_messages_for_compact`] / [`generate_compact_summary_prompt`] 等提示词组装
//! - [`is_auto_compact_enabled`] / [`should_auto_compact`]
//! - 「正在压缩」/「待压缩」注册表
//! - [`compact_conversation`] / [`compact_and_apply_messages`] /
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
/// 返回 `f64`：阈值按浮点比较，`0.3 * 8192 = 2457.6` 这类非整数值
/// 会原样参与比较（截断成整数会在阈值恰好落在边界时改变判定结果）。
pub fn get_auto_compact_threshold(context_window: u64, max_output_tokens: u64) -> f64 {
    let buffer = AUTOCOMPACT_OUTPUT_BUFFER_RATIO * (max_output_tokens.max(0) as f64);
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
/// 是数据契约字段（只写不读），保留以便后续接入告警 / 遥测。
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
/// 待压缩的会话（前台仍在工作时手动触发，等前台收尾后执行——
/// `docs/features/compaction.md` FR-002）
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
    PENDING_COMPACT
        .lock()
        .unwrap()
        .retain(|id| id != session_id);
}

/// 原子取走待压缩标记：返回 true 表示本次调用是唯一消费方。
///
/// 「取走」必须是原子的：消费循环的轮次边界与 `Core::request_compact` 的立即压缩
/// 路径都会尝试消费同一条登记，各自「先查再清」会让同一次请求压两遍。
pub fn take_pending_compact(session_id: &str) -> bool {
    let mut sessions = PENDING_COMPACT.lock().unwrap();
    match sessions.iter().position(|id| id == session_id) {
        Some(index) => {
            sessions.remove(index);
            true
        }
        None => false,
    }
}

pub fn is_pending_compact(session_id: &str) -> bool {
    PENDING_COMPACT
        .lock()
        .unwrap()
        .iter()
        .any(|id| id == session_id)
}

/// 仅测试用：清空两个注册表
#[cfg(test)]
pub fn reset_for_test() {
    COMPACTING.lock().unwrap().clear();
    PENDING_COMPACT.lock().unwrap().clear();
}

// ==================== prompt.ts ====================

/// 把消息格式化成摘要输入文本（`formatMessagesForCompact`）
///
/// 上一次压缩产出的摘要消息里带的「运行中后台任务」章节是**当时的**时点快照，此刻
/// 可能早已全部结束。原样喂给摘要模型，它会把这些陈旧 taskId 抄进「未完成事项」，
/// 与本次新算的章节自相矛盾；因此这一节在进摘要输入前剥掉，正文其余部分照常保留
/// （`docs/features/compaction.md` FR-006）。
pub fn format_messages_for_compact(messages: &[Value]) -> String {
    let mut formatted: Vec<String> = Vec::new();
    for message in messages {
        match message.get("type").and_then(Value::as_str) {
            Some("user") => {
                let content = message
                    .get("message")
                    .and_then(|inner| inner.get("content"));
                let text = match content {
                    Some(Value::String(text)) => text.clone(),
                    Some(Value::Array(blocks)) => format_content_blocks(blocks),
                    _ => String::new(),
                };
                let text = if message.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
                {
                    // 两个章节都是「当时」的快照：后台任务是那次压缩开始时的任务表，
                    // 技能正文是那次的磁盘内容。原样喂给摘要模型，它会抄进「未完成事项」
                    // 或压成一段似是而非的规则，与本次新算的章节自相矛盾。
                    strip_loaded_skills_section(&strip_running_tasks_section(&text))
                } else {
                    text
                };
                formatted.push(format!("[User]: {text}"));
            }
            Some("assistant") => {
                let content = message
                    .get("message")
                    .and_then(|inner| inner.get("content"));
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

/// 从摘要正文里剥掉「运行中后台任务」章节（纯函数）。
///
/// 章节从标题那一行的行首起，到下一个章节边界或正文末尾为止。边界是 Markdown 标题行
/// 或一条 `---` 分隔线——摘要正文的固定尾注正是 `---` + 「请基于以上摘要继续工作」，
/// 章节在它之前，尾注必须留下。章节内部允许空行：本模块生成的章节用空行分隔列表与说明。
///
/// 找不到标题时原样返回：正文里本来就没有这段（首次压缩，或旧会话的摘要）。
fn strip_running_tasks_section(text: &str) -> String {
    let Some(heading_at) = text.find(crate::bash_task::RUNNING_TASKS_HEADING) else {
        return text.to_string();
    };
    // 标题前可能有 `\n\n` 分隔：章节从标题所在行的行首算起。
    let section_start = text[..heading_at].rfind('\n').map(|at| at + 1).unwrap_or(0);
    let body_at = heading_at + crate::bash_task::RUNNING_TASKS_HEADING.len();
    let mut next_boundary = None;
    let mut line_at = body_at;
    while line_at < text.len() {
        let line_end = text[line_at..]
            .find('\n')
            .map(|at| line_at + at + 1)
            .unwrap_or(text.len());
        if is_markdown_heading(&text[line_at..line_end])
            || is_horizontal_rule(&text[line_at..line_end])
        {
            next_boundary = Some(line_at);
            break;
        }
        line_at = line_end;
    }
    let head = util::js_trim_end(&text[..section_start]);
    let tail = util::js_trim_start(&text[next_boundary.unwrap_or(text.len())..]);
    match (head.is_empty(), tail.is_empty()) {
        (true, true) => String::new(),
        (true, false) => tail.to_string(),
        (false, true) => head.to_string(),
        (false, false) => format!("{head}\n\n{tail}"),
    }
}

/// 是否是 Markdown ATX 标题行（`#` 到 `######`，后接空格或行尾）。
///
/// 与正文里偶然以 `#` 开头的词区分开（那不算标题）。
fn is_markdown_heading(line: &str) -> bool {
    let trimmed = line.trim_start().trim_end_matches(['\r', '\n']);
    let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&hashes) {
        return false;
    }
    match trimmed[hashes..].chars().next() {
        None => true,
        Some(ch) => ch == ' ',
    }
}

/// 是否是水平分隔线（`---` / `***` / `___`，至少三个，其余字符只能是空白）。
fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    for marker in ['-', '*', '_'] {
        let count = trimmed.chars().filter(|ch| *ch == marker).count();
        if count >= 3 && trimmed.chars().all(|ch| ch == marker || ch.is_whitespace()) {
            return true;
        }
    }
    false
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
                                Some("image") => util::IMAGE_PLACEHOLDER.to_string(),
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
            "image" => util::IMAGE_PLACEHOLDER.to_string(),
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
    let content = message
        .get("message")
        .and_then(|inner| inner.get("content"));
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

/// 摘要中「用户输入历史」章节最多保留的条数
pub const USER_INPUT_HISTORY_MAX: usize = 12;
/// 超限时保留的最早条数
pub const USER_INPUT_HISTORY_HEAD: usize = 4;
/// 超限时保留的最后条数（与 HEAD 相加不超过 MAX）
pub const USER_INPUT_HISTORY_TAIL: usize = 8;

/// 把用户输入消息提取成历史条目（`toUserInputEntries`）：`{ uuid, content }`。
///
/// 只保留 `extract_user_content` 得到的文本块，跳过图片 / 工具结果等系统内容；
/// 空内容条目直接丢弃。
pub fn to_user_input_entries(messages: &[Value]) -> Vec<Value> {
    let mut entries: Vec<Value> = Vec::new();
    for message in messages {
        let content = util::js_trim(&extract_user_content(message)).to_string();
        if content.is_empty() {
            continue;
        }
        let uuid = message.get("uuid").and_then(Value::as_str).unwrap_or("");
        entries.push(json!({ "uuid": uuid, "content": content }));
    }
    entries
}

/// 读取上一次压缩摘要持久化的用户输入历史（`readCompactUserInputHistory`）。
///
/// 取消息数组里最后一条 `isCompactSummary` 消息上的 `compactUserInputHistory`；
/// 压缩总是整体替换消息，所以同一时刻至多一条摘要消息。
pub fn read_compact_user_input_history(messages: &[Value]) -> Vec<Value> {
    for message in messages.iter().rev() {
        if message.get("isCompactSummary").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if let Some(history) = message
            .get("compactUserInputHistory")
            .and_then(Value::as_array)
        {
            return history.clone();
        }
    }
    Vec::new()
}

/// 组装摘要里的「用户输入历史」（`selectUserInputHistory`）：
/// 把 `previous`（上次摘要持久化的历史）与 `region_inputs`（本次归档区里的真实用户输入）
/// 按时间顺序合并去重，再取最早 `head` 条 + 最后 `tail` 条；不超过 `max` 条时全留。
///
/// 两次压缩之间没有重叠：`previous` 里的条目在上次压缩时已从消息里移除，不会出现在
/// 本次的 `region_inputs`；去重只是防御性兜底。
pub fn select_user_input_history(
    previous: &[Value],
    region_inputs: &[Value],
    max: usize,
    head: usize,
    tail: usize,
) -> Vec<Value> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut merged: Vec<Value> = Vec::new();
    for entry in previous.iter().chain(region_inputs.iter()) {
        let uuid = entry.get("uuid").and_then(Value::as_str).unwrap_or("");
        if !seen.insert(uuid.to_string()) {
            continue;
        }
        merged.push(entry.clone());
    }
    if merged.len() <= max {
        return merged;
    }
    let mut result: Vec<Value> = merged[..head].to_vec();
    result.extend_from_slice(&merged[merged.len() - tail..]);
    result
}

/// 把用户输入历史条目格式化成编号列表（`formatUserInputEntries`）。
pub fn format_user_input_entries(entries: &[Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut index = 0u64;
    for entry in entries {
        let content =
            util::js_trim(entry.get("content").and_then(Value::as_str).unwrap_or("")).to_string();
        if content.is_empty() {
            continue;
        }
        index += 1;
        lines.push(format!("{index}. {content}"));
    }
    lines.join("\n\n")
}

/// 把用户输入消息格式化成编号列表（`formatUserInputHistory`，`formatUserInputEntries` 的便捷封装）。
///
/// 生产路径已改用 `to_user_input_entries` + `format_user_input_entries`（需要保留 uuid 去重），
/// 这里只给对等对照表测试用，避免 bin 目标出现 dead_code 警告。
#[cfg(test)]
pub fn format_user_input_history(messages: &[Value]) -> String {
    format_user_input_entries(&to_user_input_entries(messages))
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

/// 压缩后注入的 user 消息正文的固定尾注。
///
/// 生成侧（[`generate_compact_user_message`]）与剥离侧（[`strip_loaded_skills_section`]）
/// 共用同一份：重挂章节是正文的最后一个章节，剥离要从它的标题一直切到这条尾注之前，
/// 两处各写一份字符串就会在改动时静默错位。
pub const COMPACT_FOOTER: &str = "---\n\n请基于以上摘要继续工作。如有需要，我可以提供更多细节。";

/// 重挂章节标题（`docs/features/compaction.md` FR-007）
pub const LOADED_SKILLS_HEADING: &str = "### 已加载技能";

/// 单个已加载技能重挂正文的 token 上限（含该技能的标题行与来源行）
pub const COMPACT_SKILL_MAX_TOKENS: u64 = 5_000;

/// 重挂章节整体的 token 上限（含标题、前言与说明行）
pub const COMPACT_SKILL_TOTAL_TOKENS: u64 = 25_000;

/// 重挂章节的前言：点明时点与来源，避免模型把旧规则当成本轮新指令
/// （Codex 的 world_state 全量重放就踩过这个坑）。
const LOADED_SKILLS_PREAMBLE: &str =
    "以下技能是本会话较早时候加载的，不是当前轮次的要求；其中的指令按既有优先级继续生效。";

/// 一条「本会话调用过某技能」的记录。
///
/// **不含正文**：正文是磁盘内容的投影，随文件变化；把它存进落盘会让过期规则继续生效
/// （`docs/features/compaction.md` FR-007）。数组顺序即调用先后，末尾最近。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedSkillRecord {
    pub name: String,
    pub args: String,
}

/// 从消息里的 `Skill` 工具调用提取记录（按出现顺序）
fn skill_tool_uses(messages: &[Value]) -> Vec<LoadedSkillRecord> {
    let mut records: Vec<LoadedSkillRecord> = Vec::new();
    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if block.get("name").and_then(Value::as_str) != Some("Skill") {
                continue;
            }
            let input = block.get("input");
            let raw = input
                .and_then(|value| value.get("skill"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let trimmed = util::js_trim(raw);
            let name = trimmed.strip_prefix('/').unwrap_or(trimmed);
            if name.is_empty() {
                continue;
            }
            let args = input
                .and_then(|value| value.get("args"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            records.push(LoadedSkillRecord {
                name: name.to_string(),
                args,
            });
        }
    }
    records
}

/// 读取上一次压缩摘要持久化的技能调用记录（`compactLoadedSkills`）。
///
/// 与 [`read_compact_user_input_history`] 同口径：取消息数组里最后一条
/// `isCompactSummary` 消息上的字段。形态非法的条目逐条忽略——旧会话没有该字段、
/// 外部工具可能改坏 JSONL，按「无历史记录」继续而不是让整次压缩失败。
pub fn read_compact_loaded_skills(messages: &[Value]) -> Vec<Value> {
    for message in messages.iter().rev() {
        if message.get("isCompactSummary").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(entries) = message.get("compactLoadedSkills").and_then(Value::as_array) else {
            return Vec::new();
        };
        return entries
            .iter()
            .filter_map(|entry| {
                let name = entry.get("name").and_then(Value::as_str)?;
                let name = util::js_trim(name);
                if name.is_empty() {
                    return None;
                }
                let args = entry
                    .get("args")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                Some(json!({ "name": name, "args": args }))
            })
            .collect();
    }
    Vec::new()
}

/// 把持久化条目解析成记录（非法条目忽略）
fn records_from_values(values: &[Value]) -> Vec<LoadedSkillRecord> {
    values
        .iter()
        .filter_map(|entry| {
            let name = entry.get("name").and_then(Value::as_str)?;
            let name = util::js_trim(name);
            if name.is_empty() {
                return None;
            }
            Some(LoadedSkillRecord {
                name: name.to_string(),
                args: entry
                    .get("args")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// 按「上一代字段 → 本次归档区 → 本次保留区」合并记录，同名只留最近一次。
///
/// 三段顺序就是时间顺序，所以「先删旧同名再追加」天然实现「取最近一次」；一条技能
/// 在数组里只出现一次，重挂章节里也只出现一次（`docs/features/compaction.md` FR-007）。
pub fn collect_loaded_skill_records(
    persisted: &[Value],
    region: &[Value],
    keep: &[Value],
) -> Vec<LoadedSkillRecord> {
    let mut merged: Vec<LoadedSkillRecord> = Vec::new();
    let sources = [
        records_from_values(persisted),
        skill_tool_uses(region),
        skill_tool_uses(keep),
    ];
    for source in sources {
        for record in source {
            merged.retain(|existing| existing.name != record.name);
            merged.push(record);
        }
    }
    merged
}

/// 保留区里仍带着完整技能正文的技能名。
///
/// 判据只看注入消息上的 `skillName` 标记，**不比对内容**：内容随磁盘改动立刻失效，
/// 拿它判断会得出「还在」的错误结论。
pub fn keep_region_skill_names(keep: &[Value]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for message in keep {
        if message.get("isMeta").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(name) = message.get("skillName").and_then(Value::as_str) else {
            continue;
        };
        let name = util::js_trim(name);
        if name.is_empty() || names.iter().any(|known| known == name) {
            continue;
        }
        names.push(name.to_string());
    }
    names
}

/// 渲染重挂章节（`docs/features/compaction.md` FR-007）。
///
/// 填充顺序是**最近调用优先**：预算先给最近的，最旧的先被整项放弃。返回 `None` 表示
/// 不该出章节（没有记录，或全部记录都还在保留区里）。
pub fn build_loaded_skills_section(
    records: &[LoadedSkillRecord],
    skip_names: &[String],
    cwd: &str,
    session_id: &str,
) -> Option<String> {
    if records.is_empty() {
        return None;
    }

    let frame = format!("{LOADED_SKILLS_HEADING}\n\n{LOADED_SKILLS_PREAMBLE}");
    let mut total = util::estimate_text_tokens(&frame);
    let mut items: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();
    // 预算一旦不够，更旧的记录（本循环后面才遇到）一律整项放弃：这是「最近优先」
    // 的直接推论，也让结果与遍历顺序无关地可复现。
    let mut exhausted = false;

    for record in records.iter().rev() {
        if skip_names.iter().any(|name| name == &record.name) {
            continue;
        }
        if exhausted {
            dropped.push(record.name.clone());
            continue;
        }
        let Some(command) = crate::skills::find_skill(&record.name, cwd) else {
            eprintln!(
                "[core] compact: skill '{}' not found; omitted from reloaded skills section",
                record.name
            );
            failed.push(record.name.clone());
            continue;
        };
        let body = crate::skills::render_skill_body(&command, &record.args, session_id);
        if util::js_trim(&body).is_empty() {
            eprintln!(
                "[core] compact: skill '{}' rendered empty; omitted from reloaded skills section",
                record.name
            );
            failed.push(record.name.clone());
            continue;
        }

        let mut header = format!("#### {}\n", command.name);
        if let Some(dir) = command.skill_root.as_deref() {
            header.push_str(&format!("技能目录：{}\n", dir.replace('\\', "/")));
        }
        let header_cost = util::estimate_text_tokens(&header);
        // 截断说明行也占预算：单项上限约束的是「这个技能在章节里占的全部 token」，
        // 只扣正文的额度会让加了说明行的条目顶穿上限（估算与断言口径都会露出来）。
        let truncation_note = format!(
            "\n\n（已截断：{} 的正文超过单项上限 {COMPACT_SKILL_MAX_TOKENS} token，\
             仅保留开头；需要全文请重新调用 /{}）",
            command.name, command.name
        );
        let note_cost = util::estimate_text_tokens(&truncation_note);
        let body_capacity = COMPACT_SKILL_MAX_TOKENS.saturating_sub(header_cost);
        let body_cost = util::estimate_text_tokens(&body);
        let (body, truncated) = if body_cost > body_capacity {
            (
                util::take_prefix_within_tokens(&body, body_capacity.saturating_sub(note_cost)),
                true,
            )
        } else {
            (body, false)
        };

        let mut item = format!("{header}\n{body}");
        if truncated {
            item.push_str(&truncation_note);
        }

        let cost = util::estimate_text_tokens(&item);
        if total + cost > COMPACT_SKILL_TOTAL_TOKENS {
            exhausted = true;
            dropped.push(record.name.clone());
            continue;
        }
        total += cost;
        items.push(item);
    }

    // 一条都没挂上、也没有读不出的记录时不出章节。注意 `dropped` 非空时仍要出——
    // 「所有技能都因预算被放弃」必须让模型与用户看见那句话，不能静默变成没有章节。
    if items.is_empty() && failed.is_empty() && dropped.is_empty() {
        return None;
    }

    let mut blocks: Vec<String> = Vec::new();
    if !items.is_empty() {
        blocks.push(LOADED_SKILLS_PREAMBLE.to_string());
        blocks.extend(items.iter().cloned());
    }
    if !dropped.is_empty() {
        blocks.push(format!(
            "（以下技能因总量预算 {COMPACT_SKILL_TOTAL_TOKENS} token 未重挂：{}）",
            dropped.join("、")
        ));
    }
    if !failed.is_empty() {
        blocks.push(format!(
            "（以下技能无法重新读取，未重挂：{}；请确认 SKILL.md 是否仍在）",
            failed.join("、")
        ));
    }
    let section = format!("{LOADED_SKILLS_HEADING}\n\n{}", blocks.join("\n\n"));

    // 说明行是唯一可能在预算之外再加一段的块。真顶穿了就退化为「只留技能正文」，
    // 被省略的名单改记 core 日志——绝不静默丢技能正文。
    if util::estimate_text_tokens(&section) > COMPACT_SKILL_TOTAL_TOKENS {
        eprintln!(
            "[core] compact: reloaded skills notes exceed the {COMPACT_SKILL_TOTAL_TOKENS} token \
             budget; dropped: [{}], unreadable: [{}]",
            dropped.join(", "),
            failed.join(", ")
        );
        let mut kept = vec![LOADED_SKILLS_PREAMBLE.to_string()];
        kept.extend(items.clone());
        return Some(format!("{LOADED_SKILLS_HEADING}\n\n{}", kept.join("\n\n")));
    }

    Some(section)
}

/// 从摘要正文里剥掉「已加载技能」章节（`docs/features/compaction.md` FR-007）。
///
/// 该章节是正文的**最后一个**章节，所以剥离范围就是「标题行首 → 固定尾注起点」。
/// 不走「遇到下一个 Markdown 标题即止」的通用逻辑：技能正文自己带标题与 `---`，
/// 通用逻辑会在章节内部提前收手，把半段旧技能正文喂给摘要模型。
pub fn strip_loaded_skills_section(text: &str) -> String {
    // 用「标题 + 前言」整段定位，而不是只找标题：技能正文自己也可能有一行
    // `### 已加载技能`，只按标题定位会从章节内部开刀，把半段正文留在摘要输入里。
    let marker = format!("{LOADED_SKILLS_HEADING}\n\n{LOADED_SKILLS_PREAMBLE}");
    let Some(marker_at) = text.rfind(&marker) else {
        // 前言被预算挤掉时退化为只认标题
        let Some(heading_at) = text.rfind(LOADED_SKILLS_HEADING) else {
            return text.to_string();
        };
        return strip_from_heading(text, heading_at);
    };
    strip_from_heading(text, marker_at)
}

/// 从 `at` 所在行的行首起、切到固定尾注之前。
fn strip_from_heading(text: &str, at: usize) -> String {
    let line_start = text[..at].rfind('\n').map(|index| index + 1).unwrap_or(0);
    // 标题必须在行首（正文里偶然提到这串字的不算章节）
    if !util::js_trim(&text[line_start..at]).is_empty() {
        return text.to_string();
    }
    let footer_at = text
        .find(COMPACT_FOOTER)
        .filter(|index| *index > line_start);
    let Some(footer_at) = footer_at else {
        // 没有尾注：章节吞掉到末尾
        let head = util::js_trim_end(&text[..line_start]);
        return if head.is_empty() {
            String::new()
        } else {
            head.to_string()
        };
    };
    let head = util::js_trim_end(&text[..line_start]);
    let tail = util::js_trim_start(&text[footer_at..]);
    match (head.is_empty(), tail.is_empty()) {
        (true, true) => String::new(),
        (true, false) => tail.to_string(),
        (false, true) => head.to_string(),
        (false, false) => format!("{head}\n\n{tail}"),
    }
}

/// 压缩后注入的 user 消息正文（`generateCompactUserMessage`）
///
/// `running_tasks` 是压缩开始时仍在运行的后台任务章节（
/// [`crate::bash_task::build_running_tasks_section`] 的产物，空集为 `None`）。
/// 它不是「历史摘要」的一部分：后台任务的提示文字寄生在 `tool_result` 正文里，
/// 压缩会把它摊平、截断或替换成合成结果，任务仍在跑而模型那一侧的事实已经消失
/// （`docs/features/compaction.md` FR-006）。放在摘要正文里而不是单开一条消息，
/// 是为了让压缩产物保持 `[边界标记, 摘要, ...保留区]` 的三段形态。
///
/// `loaded_skills` 是同样的道理（`docs/features/compaction.md` FR-007）：技能正文一次性
/// 加载、随后被压缩吃掉，模型不会自觉重新调用。它是正文的最后一个章节。
pub fn generate_compact_user_message(
    summary: &str,
    transcript_path: Option<&str>,
    user_input_history: Option<&str>,
    running_tasks: Option<&str>,
    loaded_skills: Option<&str>,
) -> String {
    let mut content = format!("以下是之前对话的摘要：\n\n{summary}");
    if let Some(path) = transcript_path {
        content.push_str(&format!("\n\n完整对话记录保存在: {path}"));
    }
    if let Some(history) = user_input_history {
        content.push_str(&format!("\n\n### 用户输入历史\n\n{history}"));
    }
    if let Some(tasks) = running_tasks {
        content.push_str(&format!("\n\n{tasks}"));
    }
    // 已加载技能是最后一个章节：剥离侧（`strip_loaded_skills_section`）据此只需
    // 「标题行首 → 尾注起点」一段切法，不必猜章节边界。
    if let Some(skills) = loaded_skills {
        content.push_str(&format!("\n\n{skills}"));
    }
    content.push_str(&format!("\n\n{COMPACT_FOOTER}"));
    content
}

/// 边界标记正文（`generateCompactBoundaryContent`）。
///
/// `date` 由调用方传入。
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
    /// 压缩后上下文占用的重算值（[`util::estimate_request_tokens`] 作用在压缩后消息上）。
    /// `compactEnd.postCompactTokenCount` 与 `meta.json` 的 `totalContextTokens` 写回
    /// 都取这个值——压缩清空了保留区 usage，没有真实锚点，估算是此刻能给出的最好
    /// 事实，下一轮真实 usage 落盘后照常覆盖（specs/defects/compact-context-facts-stale-across-views）。
    pub post_compact_tokens: u64,
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
                        if let Some(inner) =
                            cloned.get_mut("message").and_then(Value::as_object_mut)
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
    cwd: &str,
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
        cwd,
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
    cwd: &str,
) -> Option<CompactionResult> {
    // 通知 UI：压缩开始
    core.emit(json!({ "type": "compactBegin", "sessionId": session_id }));

    let messages_for_compact = messages_after_compact_boundary(messages);

    // 保留最近 N 条；截断后必须修复 tool_use / tool_result 配对
    let keep_from = messages_for_compact
        .len()
        .saturating_sub(max_messages_to_keep);
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

    // 摘要生成那次调用的 output tokens 不再外发：`compactEnd.postCompactTokenCount`
    // 的载荷语义是「压缩后上下文占用」（压缩完成后按压缩产物重算，见下方
    // `post_compact_tokens`），摘要自身的 output 只是中间量。
    let (summary, _summary_output_tokens) = generate_summary(
        provider,
        &messages_to_summarize,
        custom_instructions,
        session_id,
    );

    // 提取用户输入历史，追加为摘要消息的一个章节。
    // 历史 = 上次摘要持久化的历史（含会话最初的用户输入，见 `docs/features/compaction.md`）
    //      + 本次归档区里的真实用户输入；合并后只保留首尾两端，避免摘要无限膨胀。
    // 保留区里的用户输入不进这里，避免与仍在上下文中的消息重复。
    let previous_user_input_history = read_compact_user_input_history(&messages_for_compact);
    let region_user_inputs = to_user_input_entries(&get_user_input_history(&messages_to_summarize));
    let selected_user_input_history = select_user_input_history(
        &previous_user_input_history,
        &region_user_inputs,
        USER_INPUT_HISTORY_MAX,
        USER_INPUT_HISTORY_HEAD,
        USER_INPUT_HISTORY_TAIL,
    );
    let user_input_history = format_user_input_entries(&selected_user_input_history);
    let user_input_history = if user_input_history.is_empty() {
        None
    } else {
        Some(user_input_history)
    };

    // 压缩开始时仍在运行的后台任务：按注册表现算一份写进摘要消息
    // （`docs/features/compaction.md` FR-006）。取快照的时机是压缩开始、消息数组被
    // 整体替换之前——之后完成任务的通知会陆续进入保留区，晚于这条摘要，顺序天然正确。
    let running_tasks = crate::bash_task::build_running_tasks_section(
        &crate::bash_task::running_tasks_for_session(session_id),
    );

    // 本会话调用过的技能（`docs/features/compaction.md` FR-007）：记录只从消息派生，
    // 正文在下面按磁盘重渲染。保留区里仍带着完整正文的技能不重复重挂——它还在上下文里，
    // 再挂一份只是白花预算。
    let previous_loaded_skills = read_compact_loaded_skills(&messages_for_compact);
    let loaded_skill_records = collect_loaded_skill_records(
        &previous_loaded_skills,
        &messages_to_summarize,
        &recent_messages,
    );
    let loaded_skills_section = build_loaded_skills_section(
        &loaded_skill_records,
        &keep_region_skill_names(&recent_messages),
        cwd,
        session_id,
    );
    // 落盘字段只留名字与参数：正文是磁盘投影，存进来自证「一份事实一个写入点」
    // 被破坏（过期规则会继续生效）。
    let persisted_loaded_skills: Vec<Value> = loaded_skill_records
        .iter()
        .map(|record| json!({ "name": record.name, "args": record.args }))
        .collect();

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

    let mut summary_message = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": generate_compact_user_message(
                &summary,
                None,
                user_input_history.as_deref(),
                running_tasks.as_deref(),
                loaded_skills_section.as_deref(),
            ),
        },
        "uuid": format!("summary_{}", util::now_millis()),
        "timestamp": util::now_millis(),
        "isCompactSummary": true,
        // 跨多次压缩保留全局用户输入历史：下次压缩据此恢复会话最初的用户输入。
        "compactUserInputHistory": selected_user_input_history,
    });
    // 跨多次压缩保留「本会话调用过哪些技能」：正文每次压缩按磁盘重渲染，字段只记
    // 名字与参数（`docs/features/compaction.md` FR-007）。空集不写字段——旧会话与新会话
    // 的摘要消息形态因此只差「有没有这条」，不引入 `null` 语义。
    if !persisted_loaded_skills.is_empty() {
        if let Some(object) = summary_message.as_object_mut() {
            object.insert(
                "compactLoadedSkills".to_string(),
                Value::Array(persisted_loaded_skills),
            );
        }
    }

    // 压缩后上下文占用：与运行时估算同一套口径重算（`build_llm_messages_from` 转换后
    // 交给 `estimate_request_tokens`；system prompt / tools 不在压缩产物里，按消息体
    // 估算）。清空保留区 usage（`clear_message_usage`）后没有真实锚点可用，不重算的话
    // `totalContextTokens` 停留在压缩前的旧值——用量条从 meta 恢复的视图拿旧值，core
    // 自己的估算兜底（与 meta 取 max）也拿旧值，手动压缩后的下一轮会被误判为仍超阈值
    // 而立即再压一次（specs/defects/compact-context-facts-stale-across-views）。
    let mut result = CompactionResult {
        boundary_marker,
        summary_messages: vec![summary_message],
        messages_to_keep: if recent_messages.is_empty() {
            None
        } else {
            Some(recent_messages)
        },
        post_compact_tokens: 0,
    };
    result.post_compact_tokens = util::estimate_request_tokens(
        Some(&Value::Array(crate::engine::build_llm_messages_from(
            &build_post_compact_messages(&result),
        ))),
        "",
        None,
    );

    // 通知 UI：压缩完成（带上压缩后上下文占用的重算值，webview / TUI 的用量显示据此刷新）
    core.emit(json!({
        "type": "compactEnd",
        "sessionId": session_id,
        "result": { "status": "complete", "postCompactTokenCount": result.post_compact_tokens },
    }));

    // 归档：被摘要掉的消息 + 新摘要（保留区不进归档，展开时与归档一起重放）。
    // 按代次追加而不是覆盖：多次压缩后每次展开都还能看到更早的原文
    // （`docs/features/compaction.md` FR-005）。
    if let Ok(project) = core.project_of(session_id) {
        let mut archive = messages_to_summarize.clone();
        archive.push(result.summary_messages[0].clone());
        if let Err(error) = history::append_compact_archive(session_id, &project, &archive) {
            eprintln!("[core] compact: failed to append compact archive: {error}");
        }
    }

    Some(result)
}

/// 调用 LLM 生成摘要（`generateSummary`）；失败时返回空摘要 + 0 tokens。
fn generate_summary(
    provider: Option<&config::ProviderConfig>,
    messages: &[Value],
    custom_instructions: Option<&str>,
    session_id: &str,
) -> (String, u64) {
    // LLM 配置缺失 / 请求失败都在这里吞掉，
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
        // 重挂要按会话工作目录解析技能：与 `/name` 派发同一套发现与仲裁
        project,
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

    // meta.json 的压缩状态 + 压缩后上下文占用写回：
    // `totalContextTokens` 的写入方仍是 core（一个字段一个写入点），压缩是 usage 落盘
    // 之外的第二个写入时机——不写回的话切回视图的用量条（webview / TUI 的
    // `conversationLoaded` 恢复路径）与 core 自己的估算兜底都拿压缩前的旧值
    // （specs/defects/compact-context-facts-stale-across-views）。
    if let Err(error) = history::update_context(
        session_id,
        project,
        &[
            json!({ "key": "isCompacted", "value": true }),
            json!({ "key": "isExpanded", "value": false }),
            json!({ "key": "totalContextTokens", "value": result.post_compact_tokens }),
        ],
    ) {
        eprintln!("[core] compact: failed to update compact context: {error}");
    }

    // 通知 UI：整批替换
    replay::replay_messages_to_ui(core, session_id, &post_compact_messages);

    true
}

/// 按会话解析 LLM 连接配置（与 `run_turn` 同口径：会话级 model / provider 优先）。
/// 解析失败返回 `None`（摘要退化为空摘要）。
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

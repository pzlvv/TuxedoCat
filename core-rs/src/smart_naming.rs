//! 智能命名：从对话消息生成标题（「core 侧事实 + LLM 调用」组合）。
//!
//! 读会话消息 → 拼命名依据 → 调 LLM → 解析标题 → 改名，
//! 这几步都在 Core 侧完成（宿主既读不到会话文件，也拿不到 LLM 配置），
//! 宿主经 `UiRequest.smartNamingRequested` 取回标题。

use std::sync::atomic::AtomicBool;

use serde_json::{json, Value};

use crate::{config, history, llm, util};

/// 取最近多少条用户 / 助手文本消息作为命名依据
pub const MAX_CONTENT_MESSAGES: usize = 5;
/// 单条消息参与命名的最大字符数（UTF-16 code unit，对齐 JS `substring`）
pub const MAX_CONTENT_CHARS: usize = 500;
/// 兜底标题（无任何可用内容时）
pub const FALLBACK_TITLE: &str = "智能命名";

/// 智能命名共用的 system prompt（示例 + 输出格式约束）。
///
/// **不本地化**——它是给模型的指令，不是界面文案。
pub const SMART_NAMING_SYSTEM_PROMPT: &str = "你是一个对话标题生成器。\n\n\
示例1:\n对话内容：[用户]: 帮我写一个Python排序函数\n[助手]: 以下是冒泡排序实现...\n\
输出：{\"title\": \"Python排序函数\"}\n\n\
示例2:\n对话内容：[用户]: 今天天气怎么样\n[助手]: 今天北京晴转多云...\n\
输出：{\"title\": \"查询天气\"}\n\n\
现在请为以下对话生成标题（不超过20个字），只输出 JSON：";

/// 从对话消息中取最近 `MAX_CONTENT_MESSAGES` 条用户 / 助手文本，
/// 组装成 `[用户]: ...` / `[助手]: ...` 的命名依据文本。
pub fn collect_smart_naming_context(messages: &[Value]) -> Vec<String> {
    let mut content_messages: Vec<String> = Vec::new();
    for raw in messages {
        let message_type = raw.get("type").and_then(Value::as_str).unwrap_or("");
        if message_type == "user" {
            if let Some(text) = raw.get("message").and_then(|m| m.get("content")).and_then(Value::as_str) {
                content_messages.push(format!(
                    "[用户]: {}",
                    util::utf16_take(text, MAX_CONTENT_CHARS)
                ));
                if content_messages.len() >= MAX_CONTENT_MESSAGES {
                    break;
                }
            }
        } else if message_type == "assistant" {
            let blocks = raw
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array);
            if let Some(blocks) = blocks {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                content_messages.push(format!(
                                    "[助手]: {}",
                                    util::utf16_take(text, MAX_CONTENT_CHARS)
                                ));
                                if content_messages.len() >= MAX_CONTENT_MESSAGES {
                                    break;
                                }
                            }
                        }
                    }
                }
                if content_messages.len() >= MAX_CONTENT_MESSAGES {
                    break;
                }
            }
        }
    }
    content_messages
}

/// 从 LLM 原始输出中解析标题。
///
/// 优先级：最后一个 JSON 对象的 `title` 字段 → `{ "title": "..." }` 正则 →
/// 最后一行非空文本截断 50 字符 → `智能命名`。
pub fn parse_smart_naming_title(raw_result: &str) -> String {
    let mut title = String::new();
    if let Some(json_str) = extract_last_json_object(raw_result) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&json_str) {
            if let Some(found) = parsed.get("title").and_then(Value::as_str) {
                title = found.to_string();
            }
        }
    }
    if title.is_empty() {
        if let Some(found) = extract_title_pattern(raw_result) {
            title = found;
        } else {
            let last_line = raw_result
                .split('\n')
                .map(util::js_trim)
                .filter(|line| !line.is_empty())
                .next_back()
                .unwrap_or("");
            title = if last_line.is_empty() {
                FALLBACK_TITLE.to_string()
            } else {
                util::utf16_take(last_line, 50)
            };
        }
    }
    title
}

/// 取字符串里最后一个完整 JSON 对象（须含 string 类型的 `title` 字段）。
///
/// 反向找最后一个不在字符串字面量里的
/// `{`，从它开始做括号配对；配平后若 JSON 合法**且** `title` 是字符串则返回；
/// 否则退到该 `{` 之前的部分**递归**再找（模型可能先输出一段含花括号的思考）。
fn extract_last_json_object(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();

    // 反向扫描：跳过字符串字面量里的花括号，定位最后一个 `{`
    let mut last_brace: i64 = -1;
    let mut in_string = false;
    let mut index = chars.len() as i64 - 1;
    while index >= 0 {
        let ch = chars[index as usize];
        if ch == '\\' && in_string {
            // 连续两个反斜杠时多跳一格
            if index > 0 && chars[(index - 1) as usize] == '\\' {
                index -= 2;
                continue;
            }
            index -= 1;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            index -= 1;
            continue;
        }
        if !in_string && ch == '{' {
            last_brace = index;
            break;
        }
        index -= 1;
    }
    if last_brace < 0 {
        return None;
    }

    // 从 last_brace 正向配对到第一个深度归零的 `}`
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut index = last_brace;
    while index < chars.len() as i64 {
        let ch = chars[index as usize];
        if escaped {
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && in_string {
            escaped = true;
            index += 1;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            index += 1;
            continue;
        }
        if !in_string {
            if ch == '{' {
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    let json_str: String =
                        chars[last_brace as usize..=(index as usize)].iter().collect();
                    if let Ok(parsed) = serde_json::from_str::<Value>(&json_str) {
                        if parsed.get("title").map(Value::is_string).unwrap_or(false) {
                            return Some(json_str);
                        }
                    }
                    break;
                }
            }
        }
        index += 1;
    }

    let remaining: String = chars[..last_brace as usize].iter().collect();
    if remaining.is_empty() {
        return None;
    }
    extract_last_json_object(&remaining)
}

/// `/\{\s*"title"\s*:\s*"([^"]+)"\s*\}/` 的等价物：取**第一个**匹配的 title 值。
///
/// 手写扫描而不是引入正则依赖：`{`、`"title"`、`:`、字符串值四段都是固定字面量，
/// 扫描一遍即可。TS 用的是**非全局**正则 + `String.prototype.match`，因此命中
/// **第一个**匹配（不是最后一个）——这里命中即返回，与之逐字对齐。
fn extract_title_pattern(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] != '{' {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < chars.len() && util::is_js_whitespace(chars[cursor]) {
            cursor += 1;
        }
        let key: String = chars[cursor..].iter().take(7).collect();
        if key != "\"title\"" {
            index += 1;
            continue;
        }
        cursor += 7;
        while cursor < chars.len() && util::is_js_whitespace(chars[cursor]) {
            cursor += 1;
        }
        if cursor >= chars.len() || chars[cursor] != ':' {
            index += 1;
            continue;
        }
        cursor += 1;
        while cursor < chars.len() && util::is_js_whitespace(chars[cursor]) {
            cursor += 1;
        }
        if cursor >= chars.len() || chars[cursor] != '"' {
            index += 1;
            continue;
        }
        cursor += 1;
        let mut value = String::new();
        while cursor < chars.len() && chars[cursor] != '"' {
            value.push(chars[cursor]);
            cursor += 1;
        }
        // `[^"]+`：空值不算匹配
        if cursor < chars.len() && !value.is_empty() {
            // `\s*\}` 收尾：闭引号之后必须只剩空白再接 `}`
            let mut tail = cursor + 1;
            while tail < chars.len() && util::is_js_whitespace(chars[tail]) {
                tail += 1;
            }
            if tail < chars.len() && chars[tail] == '}' {
                return Some(value);
            }
        }
        index += 1;
    }
    None
}

/// 调一次 LLM 生成标题；失败时返回 `None`（调用方保留原标题）。
///
/// **不带 tools**、**不开思考**（`callLLM` 不传 `thinkingEffort`
/// 时默认关闭），整段 prompt 作为一条 user 消息发出。
pub fn generate_title(session_id: &str, messages: &[Value]) -> Option<String> {
    let context = collect_smart_naming_context(messages);
    let provider = config::resolve_provider(None, None).ok()?;
    let prompt = format!(
        "{SMART_NAMING_SYSTEM_PROMPT}\n\n对话内容：\n{}",
        context.join("\n\n")
    );
    let request_messages = vec![json!({ "role": "user", "content": prompt })];
    let cancel = AtomicBool::new(false);
    let request = llm::LlmRequest {
        provider: &provider,
        system_prompt: "",
        messages: &request_messages,
        tools: &[],
        session_id,
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: llm::DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: llm::DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };

    let mut raw = String::new();
    let outcome = llm::stream(&request, &mut |event| {
        if let llm::LlmEvent::TextDelta(text) = event {
            raw.push_str(&text);
        }
    });
    if outcome.is_err() {
        return None;
    }
    Some(parse_smart_naming_title(&raw))
}

/// `UiRequest.smartNamingRequested`：读会话消息 → 生成标题。
///
/// 只负责**生成**标题，不写 `meta.json`、不广播：改名由宿主随后发
/// `UiEvent.conversationRenamed` 完成——本函数只负责生成，
/// 后续动作由调用方决定，两种装配下宿主代码相同。
pub fn smart_name_session(session_id: &str) -> Result<Value, String> {
    let project = history::project_of_session(session_id)
        .ok_or_else(|| format!("session {session_id} has no project registered"))?;
    let messages = history::load_messages(session_id, &project);
    let title = generate_title(session_id, &messages)
        .ok_or_else(|| "smart naming failed: no title generated".to_string())?;
    Ok(json!({ "title": title }))
}

#[cfg(test)]
#[path = "smart_naming_tests.rs"]
mod tests;

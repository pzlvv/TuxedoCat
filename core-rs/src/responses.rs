//! OpenAI Responses API 适配器（对齐 Embedded `src/core/llm/ResponsesApi.ts`）。
//!
//! 把内部统一的 Anthropic 风格消息 / 工具格式转成 Responses API 格式并调用：
//!   `POST {baseURL}/responses`（baseURL 以 `/v1` 结尾时用 `{baseURL}/v1/responses`）
//!
//! 产出的 `LlmEvent` 与 Anthropic / Chat Completions 两条适配器**完全一致**，
//! 因此引擎（`engine.rs`）与上层无需任何改动。
//!
//! **已知缺口**：内置 `web_search` 工具与搜索卡片事件（`web_search_call` /
//! `_update` / `_done`）尚未迁入，见 `TODO.md`；因此本模块不下发 `web_search`
//! 工具，`webSearchUsed` 恒为 false（`shouldSkipUsageForContext` 只剩「超过上下文
//! 窗口 60%」那道闸门）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use serde_json::{json, Map, Value};

use crate::llm::{
    api_error_message, error_body, is_retryable_status, read_sse, BlockKind, LlmEvent, LlmRequest,
    RepetitionDetector, StreamFailure, Usage,
};
use crate::util;

/// 单条 assistant 回复文本的最大字符数（字符数，非 token）。
///
/// Embedded 超过此值时把完整文本持久化到磁盘、消息里只留文件路径 + 预览；
/// Standalone 侧的超长文本兜底统一由 `tools::cap_tool_result` 那一套承担
/// （助手回复本身尚未接同类兜底，见 `DIFF.md`）。
const ASSISTANT_MAX_TEXT_CHARS: usize = 40_000;

/// 供 `ASSISTANT_MAX_TEXT_CHARS` 的说明引用（避免 dead_code 警告）
#[allow(dead_code)]
pub fn assistant_max_text_chars() -> usize {
    ASSISTANT_MAX_TEXT_CHARS
}

/// 估算本地输入 token 时每张图片的固定成本（见 `estimate_local_input_tokens`）
const IMAGE_TOKEN_ESTIMATE: u64 = 1_500;

// ==================== 纯函数（对等面） ====================

/// `{base}/v1/responses`；base 已以 `/v1` 结尾时用 `{base}/responses`（`joinV1Path`）
pub fn build_responses_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/responses")
    } else {
        format!("{base}/v1/responses")
    }
}

/// 内部 Anthropic 风格工具（`input_schema`）→ Responses API 工具格式。
///
/// 非 `function` 类型（如内置 `web_search`）原样透传。
pub fn convert_tools_to_responses_format(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .map(|tool| {
            // 非 function 工具原样透传
            if let Some(kind) = tool.get("type").and_then(Value::as_str) {
                if kind != "function" {
                    return tool.clone();
                }
            }
            json!({
                "type": "function",
                "name": tool.get("name").and_then(Value::as_str).unwrap_or("unknown"),
                "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                "parameters": tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object", "properties": {}, "required": [] })),
            })
        })
        .collect()
}

/// 内部 Anthropic 风格消息 → Responses API 的 input items。
///
/// 注意工具调用是**顶层 item**（不是 content part）：部分服务端（如 DeepSeek）
/// 不接受 content part 里的 `output_tool_call`。
pub fn convert_messages_to_responses_input(messages: &[Value]) -> Vec<Value> {
    let mut items: Vec<Value> = Vec::new();

    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let content = message.get("content").cloned().unwrap_or(Value::Null);

        if role == "user" {
            match &content {
                Value::String(text) => {
                    items.push(json!({
                        "role": "user",
                        "content": [{ "type": "input_text", "text": text }],
                    }));
                }
                Value::Array(blocks) => {
                    let mut tool_outputs: Vec<Value> = Vec::new();
                    let mut user_parts: Vec<Value> = Vec::new();
                    for block in blocks {
                        let Some(object) = block.as_object() else {
                            continue;
                        };
                        match object.get("type").and_then(Value::as_str) {
                            Some("tool_result") => {
                                let call_id = object
                                    .get("tool_use_id")
                                    .or_else(|| object.get("tool_call_id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let raw_output =
                                    object.get("content").cloned().unwrap_or(Value::Null);
                                let output = match &raw_output {
                                    Value::Array(parts) => Value::Array(
                                        parts.iter().map(to_tool_output_part).collect(),
                                    ),
                                    Value::String(text) => json!(text),
                                    other => json!(js_json_string(other)),
                                };
                                tool_outputs.push(json!({
                                    "type": "function_call_output",
                                    "call_id": call_id,
                                    "output": output,
                                }));
                            }
                            Some("text") => {
                                if let Some(text) = object.get("text").and_then(Value::as_str) {
                                    user_parts
                                        .push(json!({ "type": "input_text", "text": text }));
                                }
                            }
                            Some("input_text") => {
                                if let Some(text) = object.get("text").and_then(Value::as_str) {
                                    user_parts
                                        .push(json!({ "type": "input_text", "text": text }));
                                }
                            }
                            Some("image") => {
                                if let Some(part) = to_image_part(block) {
                                    user_parts.push(part);
                                }
                            }
                            _ => {}
                        }
                    }
                    // 先输出 function_call_output（紧跟 assistant 的 function_call），
                    // 再输出 user 文本 / 图片
                    items.extend(tool_outputs);
                    if !user_parts.is_empty() {
                        items.push(json!({ "role": "user", "content": user_parts }));
                    }
                }
                _ => {}
            }
        } else if role == "assistant" {
            match &content {
                Value::String(text) => {
                    items.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": text }],
                    }));
                }
                Value::Array(blocks) => {
                    let mut text_parts: Vec<Value> = Vec::new();
                    let mut reasoning_items: Vec<Value> = Vec::new();
                    let mut function_calls: Vec<Value> = Vec::new();
                    for block in blocks {
                        let Some(object) = block.as_object() else {
                            continue;
                        };
                        match object.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(text) = object.get("text").and_then(Value::as_str) {
                                    text_parts
                                        .push(json!({ "type": "output_text", "text": text }));
                                }
                            }
                            Some("thinking") => {
                                // thinking 必须传回（thinking 模式下 API 会校验）；空占位跳过。
                                // 不生成随机 id：保持请求前缀字节一致，避免破坏缓存命中。
                                if let Some(thinking) =
                                    object.get("thinking").and_then(Value::as_str)
                                {
                                    if !thinking.is_empty() {
                                        reasoning_items.push(json!({
                                            "type": "reasoning",
                                            "content": [{ "type": "reasoning_text", "text": thinking }],
                                        }));
                                    }
                                }
                            }
                            Some("tool_use") => {
                                let call_id = object
                                    .get("id")
                                    .or_else(|| object.get("call_id"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                let arguments = match object.get("input") {
                                    Some(Value::String(text)) => text.clone(),
                                    Some(other) => js_json_string(other),
                                    None => "{}".to_string(),
                                };
                                function_calls.push(json!({
                                    "type": "function_call",
                                    "id": call_id,
                                    "call_id": call_id,
                                    "name": object.get("name").and_then(Value::as_str).unwrap_or(""),
                                    "arguments": arguments,
                                }));
                            }
                            _ => {}
                        }
                    }
                    // 先 reasoning，再 assistant 文本，最后顶层 function_call
                    items.extend(reasoning_items);
                    if !text_parts.is_empty() {
                        items.push(json!({ "role": "assistant", "content": text_parts }));
                    }
                    items.extend(function_calls);
                }
                _ => {}
            }
        }
    }

    items
}

fn to_image_part(block: &Value) -> Option<Value> {
    let source = block.get("source")?;
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    let data = source.get("data").and_then(Value::as_str).unwrap_or("");
    Some(json!({
        "type": "input_image",
        "image_url": format!("data:{media_type};base64,{data}"),
        "detail": "auto",
    }))
}

fn to_tool_output_part(block: &Value) -> Value {
    let kind = block.get("type").and_then(Value::as_str);
    // TS 只在 `type === 'text'` **且** `text` 是字符串时才走 text 分支；
    // 否则落到末尾的 `JSON.stringify(block ?? '')`（例如 `{ type: 'text' }` 缺 text）。
    if kind == Some("text") {
        if let Some(text) = block.get("text").and_then(Value::as_str) {
            return json!({ "type": "input_text", "text": text });
        }
    }
    if kind == Some("image") {
        // TS 直接返回 `toImagePart(block)`，缺 source 时是 `null`（数组里出现 null）
        return to_image_part(block).unwrap_or(Value::Null);
    }
    json!({
        "type": "input_text",
        "text": match block {
            Value::String(text) => text.clone(),
            other => js_json_string(other),
        },
    })
}

/// `JSON.stringify(value ?? '')`。
///
/// `null` / 缺失时 `?? ''` 先补成空串，`JSON.stringify('')` 的结果是**两个引号**
/// `""`（不是空串）；其余值走 JS `JSON.stringify` 口径（数字见
/// [`util::js_json_stringify`]）。
fn js_json_string(value: &Value) -> String {
    match value {
        Value::Null => "\"\"".to_string(),
        other => util::js_json_stringify(other),
    }
}

/// Responses API 的 `status` / `incomplete_details` → 内部 `stop_reason`
pub fn map_responses_status(status: Option<&str>, incomplete_reason: Option<&str>) -> String {
    match status {
        Some("completed") => "end_turn".to_string(),
        Some("incomplete") => match incomplete_reason {
            Some("max_output_tokens") => "max_tokens".to_string(),
            _ => "incomplete".to_string(),
        },
        Some("failed") => "error".to_string(),
        Some("cancelled") => "cancelled".to_string(),
        Some(other) => other.to_string(),
        None => "end_turn".to_string(),
    }
}

/// 从 Responses API 的 usage 提取内部 usage（字段名与 Chat Completions 不同）。
///
/// `input_tokens` 已包含缓存命中部分（OpenAI 语义：`cached_tokens` 是子集），
/// 不再加回，否则会双重计数。
pub fn extract_usage(resp_usage: Option<&Value>) -> Option<Usage> {
    let usage = resp_usage?;
    // 对齐 `extractUsageFields` 的 `if (!u) return undefined`：JS 假值（null / 0 /
    // 空串 / false）返回 undefined，**空对象是对象**、会返回一份全 0 的 usage。
    if !crate::history::js_truthy(Some(usage)) {
        return None;
    }
    Some(Usage {
        input_tokens: usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: usage
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        // `cached_tokens || 0` / `cache_creation_input_tokens: 0`：两个键**恒有值**
        cache_read_input_tokens: Some(
            usage
                .get("input_tokens_details")
                .and_then(|details| details.get("cached_tokens"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        ),
        cache_creation_input_tokens: Some(0),
        reasoning_tokens: usage
            .get("output_tokens_details")
            .and_then(|details| details.get("reasoning_tokens"))
            .and_then(Value::as_u64),
    })
}

/// 估算本轮实际发送的输入 token 数（只用于诊断日志与异常兜底）。
///
/// 关键：先把图片 base64 换成占位符再算长度，最后按固定成本补回图片 token——
/// 否则 base64 的字符数会把估算值抬到远高于真实 `input_tokens`。
pub fn estimate_local_input_tokens(
    responses_input: &[Value],
    system_prompt: Option<&str>,
    responses_tools: &[Value],
) -> u64 {
    let mut image_count = 0u64;
    let stripped = replace_data_urls(
        &Value::Array(responses_input.to_vec()),
        &mut image_count,
    );
    // 与 `JSON.stringify` 逐字对齐：数字走 JS 口径（`1.0` 写 `1`），长度按 **UTF-16
    // code unit** 计（TS 的 `.length`），不能用 UTF-8 字节数——system prompt 含中文时
    // 两者会差出整倍数。
    let input_json = util::js_json_stringify(&stripped);
    let tools_json = util::js_json_stringify(&Value::Array(responses_tools.to_vec()));
    let total = util::utf16_len(&input_json)
        + system_prompt.map(util::utf16_len).unwrap_or(0)
        + util::utf16_len(&tools_json);
    (total as f64 / 4.0).ceil() as u64 + image_count * IMAGE_TOKEN_ESTIMATE
}

/// 递归替换 `image_url` 里的 data URL 为占位符（对齐 `JSON.stringify` 的 replacer）
fn replace_data_urls(value: &Value, image_count: &mut u64) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if key == "image_url" {
                    if let Value::String(text) = item {
                        if text.starts_with("data:") {
                            *image_count += 1;
                            out.insert(key.clone(), json!("data:image/omitted;base64,"));
                            continue;
                        }
                    }
                }
                out.insert(key.clone(), replace_data_urls(item, image_count));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| replace_data_urls(item, image_count))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// 本轮 usage 是否可信（`shouldSkipUsageForContext`）
pub fn should_skip_usage_for_context(
    web_search_used: bool,
    input_tokens: u64,
    context_window: u64,
) -> bool {
    if web_search_used {
        return true;
    }
    let cap = (context_window as f64 * 0.6).floor() as u64;
    input_tokens > cap
}

/// 用 `response.completed` 里权威的 `response.output` 校准内容块
/// （`syncContentBlocksFromOutput`）：服务端可能只发终止事件、不发 `*_delta`。
pub fn sync_content_blocks_from_output(output: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(items)) = output else {
        return Vec::new();
    };
    if items.is_empty() {
        return Vec::new();
    }
    let mut blocks: Vec<Value> = Vec::new();
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("message") => {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if part.get("type").and_then(Value::as_str) == Some("output_text") {
                            blocks.push(json!({
                                "type": "text",
                                "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
                            }));
                        }
                    }
                }
            }
            Some("reasoning") => {
                // 优先 content（reasoning_text），其次 summary：
                // DeepSeek 的 summary 常为空数组，推理内容在 content[].reasoning_text
                let content_text: String = item
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter(|part| {
                                part.get("type").and_then(Value::as_str) == Some("reasoning_text")
                            })
                            .map(|part| {
                                part.get("text").and_then(Value::as_str).unwrap_or("")
                            })
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                let summary_text: String = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts
                            .iter()
                            .map(|part| part.get("text").and_then(Value::as_str).unwrap_or(""))
                            .collect::<Vec<_>>()
                            .join("")
                    })
                    .unwrap_or_default();
                let thinking_text = if content_text.is_empty() {
                    summary_text
                } else {
                    content_text
                };
                if !thinking_text.is_empty() {
                    blocks.push(json!({ "type": "thinking", "thinking": thinking_text }));
                }
            }
            Some("function_call") => {
                let arguments = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let input = match serde_json::from_str::<Value>(arguments) {
                    Ok(parsed) => crate::engine::unwrap_tool_input_for_adapter(parsed),
                    Err(_) => json!(arguments),
                };
                blocks.push(json!({
                    "type": "tool_use",
                    "id": item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    "name": item.get("name").and_then(Value::as_str).unwrap_or(""),
                    "input": input,
                }));
            }
            _ => {}
        }
    }
    blocks
}

// ==================== 流式请求 ====================

/// 一次 Responses API 流式请求（对齐 `executeRequest`）。
///
/// 返回 `Err(StreamFailure)` 时由 `llm::stream` 的外层循环决定重试 / 失败。
pub fn stream_responses(
    req: &LlmRequest,
    emit: &mut dyn FnMut(LlmEvent),
) -> Result<(), StreamFailure> {
    let provider = req.provider;
    let responses_input = convert_messages_to_responses_input(req.messages);
    let mut responses_tools = convert_tools_to_responses_format(req.tools);
    // 已知缺口：内置 web_search 工具尚未迁入，这里不下发（见模块头）
    responses_tools.retain(|tool| tool.get("type").and_then(Value::as_str) != Some("web_search"));

    let local_input_estimate = estimate_local_input_tokens(
        &responses_input,
        if req.system_prompt.is_empty() {
            None
        } else {
            Some(req.system_prompt)
        },
        &responses_tools,
    );

    let mut body = Map::new();
    body.insert("model".to_string(), json!(provider.model));
    body.insert("input".to_string(), Value::Array(responses_input.clone()));
    body.insert("stream".to_string(), json!(true));
    body.insert("max_output_tokens".to_string(), json!(provider.max_tokens));
    body.insert("temperature".to_string(), json!(1.0));
    body.insert("top_p".to_string(), json!(0.95));
    // reasoning.effort 支持 none | low | high | max；`off` 必须显式传 none
    // （服务端默认开启思考，不传无法关闭）
    if !provider.thinking_effort.is_empty() {
        let effort = if provider.thinking_effort == "off" {
            "none"
        } else {
            provider.thinking_effort.as_str()
        };
        body.insert("reasoning".to_string(), json!({ "effort": effort }));
    }
    if !req.system_prompt.is_empty() {
        body.insert("instructions".to_string(), json!(req.system_prompt));
    }
    if !responses_tools.is_empty() {
        body.insert("tools".to_string(), Value::Array(responses_tools.clone()));
    }

    let client = crate::llm::http_client().map_err(StreamFailure::Fatal)?;
    let url = build_responses_url(&provider.base_url);
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("x-session-id", req.session_id)
        // JS `JSON.stringify` 口径（对齐 `ResponsesApi.ts` 的 `stringifyJsonSafe`）
        .body(crate::util::js_json_stringify(&Value::Object(body.clone())))
        .send()
        .map_err(|err| StreamFailure::Retryable(format!("request failed: {err}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = error_body(response);
        let message = api_error_message(status, &detail);
        return Err(if is_retryable_status(status.as_u16()) {
            StreamFailure::Retryable(message)
        } else {
            StreamFailure::Fatal(message)
        });
    }

    let cancel = req.cancel;
    let mut text_repetition = RepetitionDetector::new();
    let mut thinking_repetition = RepetitionDetector::new();

    // 内容块累积（与 Embedded 的 `contentBlocks` 对应）
    let mut text = String::new();
    let mut thinking = String::new();
    let mut thinking_summary = String::new();
    let mut tool_calls: HashMap<String, Value> = HashMap::new();
    let mut tool_order: Vec<String> = Vec::new();
    let mut usage: Option<Usage> = None;
    let mut stop_reason: Option<String> = None;
    let mut output_item_added = 0u64;
    let mut output_item_done = 0u64;
    // 当前打开的项（`currentItemState`）
    let mut current_kind: Option<&'static str> = None;
    let mut current_open = false;
    let mut current_tool_id: Option<String> = None;
    let mut current_partial = String::new();
    let mut message_delta_emitted = false;

    read_sse(
        response,
        cancel,
        req.first_byte_timeout_ms,
        req.idle_timeout_ms,
        &mut |payload| {
            let Ok(event) = serde_json::from_str::<Value>(&util::sanitize_json_surrogates(payload))
            else {
                return Ok(false);
            };
            let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
            if !event_type.starts_with("response.") {
                return Ok(false);
            }

            match event_type {
                "response.output_item.added" => {
                    let Some(item) = event.get("item") else {
                        return Ok(true);
                    };
                    output_item_added += 1;
                    // 新项开始时先关闭上一个未关闭的块（防御异常顺序）
                    if current_open {
                        emit(LlmEvent::BlockStop);
                        current_open = false;
                    }
                    match item.get("type").and_then(Value::as_str) {
                        Some("reasoning") => {
                            current_kind = Some("reasoning");
                            current_open = true;
                            thinking.clear();
                            // 预存 summary：部分服务端只在 added 携带完整 summary
                            thinking_summary = item
                                .get("summary")
                                .and_then(Value::as_array)
                                .map(|parts| {
                                    parts
                                        .iter()
                                        .map(|part| {
                                            part.get("text").and_then(Value::as_str).unwrap_or("")
                                        })
                                        .collect::<Vec<_>>()
                                        .join("")
                                })
                                .unwrap_or_default();
                            emit(LlmEvent::BlockStart(BlockKind::Thinking));
                        }
                        Some("function_call") => {
                            current_kind = Some("function_call");
                            current_open = true;
                            let call_id = item
                                .get("call_id")
                                .or_else(|| item.get("id"))
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let name = item
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            current_tool_id = Some(call_id.clone());
                            current_partial.clear();
                            if !tool_calls.contains_key(&call_id) {
                                tool_order.push(call_id.clone());
                            }
                            tool_calls.insert(
                                call_id.clone(),
                                json!({ "type": "tool_use", "id": call_id, "name": name, "input": {} }),
                            );
                            emit(LlmEvent::ToolUseStart {
                                id: call_id,
                                name,
                                input: item.get("arguments").cloned().unwrap_or(json!({})),
                            });
                        }
                        _ => {
                            // message / web_search_call 等：message 的 content part 由
                            // `response.content_part.added` 处理
                            current_kind = None;
                        }
                    }
                }
                "response.content_part.added" => {
                    let Some(part) = event.get("part") else {
                        return Ok(true);
                    };
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if current_open {
                            emit(LlmEvent::BlockStop);
                        }
                        current_kind = Some("message");
                        current_open = true;
                        text.clear();
                        emit(LlmEvent::BlockStart(BlockKind::Text));
                    }
                }
                "response.output_text.delta" => {
                    let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                    crate::llm::check_repetition(
                        &mut text_repetition,
                        delta,
                        "text",
                    )?;
                    text.push_str(delta);
                    emit(LlmEvent::TextDelta(delta.to_string()));
                }
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                    crate::llm::check_repetition(
                        &mut thinking_repetition,
                        delta,
                        "thinking",
                    )?;
                    thinking.push_str(delta);
                    emit(LlmEvent::ThinkingDelta(delta.to_string()));
                }
                "response.function_call_arguments.delta" => {
                    let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
                    current_partial.push_str(delta);
                    emit(LlmEvent::ToolUseInputDelta(delta.to_string()));
                }
                "response.output_text.done" => {
                    let final_text = event
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(&text)
                        .to_string();
                    text = final_text;
                    if current_open {
                        emit(LlmEvent::BlockStop);
                        current_open = false;
                    }
                }
                "response.reasoning_summary_text.done" | "response.reasoning_text.done" => {
                    let final_text = event
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(&thinking)
                        .to_string();
                    thinking = final_text;
                    if current_open {
                        emit(LlmEvent::BlockStop);
                        current_open = false;
                    }
                }
                "response.function_call_arguments.done" => {
                    let args = event
                        .get("arguments")
                        .and_then(Value::as_str)
                        .unwrap_or(&current_partial)
                        .to_string();
                    if let Some(id) = &current_tool_id {
                        if let Some(call) = tool_calls.get_mut(id) {
                            call["input"] = parse_tool_arguments(&args);
                        }
                    }
                    current_partial.clear();
                    if current_open {
                        emit(LlmEvent::BlockStop);
                        current_open = false;
                    }
                }
                "response.output_item.done" => {
                    let item = event.get("item").cloned().unwrap_or(Value::Null);
                    output_item_done += 1;
                    match current_kind {
                        Some("reasoning") => {
                            // 没有 delta 且 added 带了 summary → 用 summary 兜底
                            if thinking.is_empty() && !thinking_summary.is_empty() {
                                thinking = thinking_summary.clone();
                                emit(LlmEvent::ThinkingDelta(thinking_summary.clone()));
                            }
                            if current_open {
                                emit(LlmEvent::BlockStop);
                                current_open = false;
                            }
                        }
                        Some("message") => {
                            if text.is_empty() {
                                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                                    let joined: String = parts
                                        .iter()
                                        .filter(|part| {
                                            part.get("type").and_then(Value::as_str)
                                                == Some("output_text")
                                        })
                                        .map(|part| {
                                            part.get("text").and_then(Value::as_str).unwrap_or("")
                                        })
                                        .collect::<Vec<_>>()
                                        .join("");
                                    if !joined.is_empty() {
                                        text = joined.clone();
                                        emit(LlmEvent::TextDelta(joined));
                                    }
                                }
                            }
                            if current_open {
                                emit(LlmEvent::BlockStop);
                                current_open = false;
                            }
                        }
                        Some("function_call") => {
                            // 没有 arguments.done 时从 item.arguments 或累积的 partial 兜底
                            let args = item
                                .get("arguments")
                                .and_then(Value::as_str)
                                .filter(|text| !text.is_empty())
                                .map(str::to_string)
                                .unwrap_or_else(|| current_partial.clone());
                            if !args.is_empty() {
                                if let Some(id) = &current_tool_id {
                                    if let Some(call) = tool_calls.get_mut(id) {
                                        call["input"] = parse_tool_arguments(&args);
                                    }
                                }
                            }
                            current_partial.clear();
                            if current_open {
                                emit(LlmEvent::BlockStop);
                                current_open = false;
                            }
                        }
                        _ => {}
                    }
                    current_kind = None;
                    current_tool_id = None;
                }
                "response.completed" | "response.incomplete" => {
                    let response = event.get("response").cloned().unwrap_or(Value::Null);
                    let status = response.get("status").and_then(Value::as_str);
                    let incomplete = response
                        .get("incomplete_details")
                        .and_then(|details| details.get("reason"))
                        .and_then(Value::as_str);
                    let status = if event_type == "response.incomplete" {
                        Some("incomplete")
                    } else {
                        status
                    };
                    stop_reason = Some(map_responses_status(status, incomplete));
                    if let Some(parsed) = extract_usage(response.get("usage")) {
                        // 本轮 usage 不可信（web search 污染 / 超过上下文窗口 60%）时不发
                        // `Usage` 事件：引擎因此不会把它写进消息，上下文显示与命中率统计
                        // 都跳过本轮（对齐 `emitMessageDelta` 的 `serverSessionRotated`）。
                        if !should_skip_usage_for_context(
                            false,
                            parsed.input_tokens,
                            provider.context_window as u64,
                        ) {
                            emit(LlmEvent::Usage(parsed.clone()));
                        }
                        usage = Some(parsed);
                    }
                    let authoritative =
                        sync_content_blocks_from_output(response.get("output"));
                    if !authoritative.is_empty() {
                        emit(LlmEvent::AuthoritativeBlocks(authoritative));
                    }
                    if current_open {
                        emit(LlmEvent::BlockStop);
                        current_open = false;
                    }
                    if !message_delta_emitted {
                        message_delta_emitted = true;
                        emit(LlmEvent::MessageDelta);
                    }
                }
                "response.failed" => {
                    let response = event.get("response").cloned().unwrap_or(Value::Null);
                    let message = response
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            let error = response.get("error").cloned().unwrap_or(Value::Null);
                            match error {
                                Value::Null => "unknown error".to_string(),
                                other => util::js_json_stringify(&other),
                            }
                        });
                    return Err(StreamFailure::Fatal(format!(
                        "Responses API failed: {message}"
                    )));
                }
                _ => {}
            }
            Ok(true)
        },
    )?;

    // ===== 截断检测：流结束但未收到终止事件 =====
    if stop_reason.is_none() {
        // 用户主动取消（abort）：流是本端提前掐断的，服务端不会补终止事件，
        // 因此「无终止事件」不是截断，不重试、也不补 `message_delta` / `stop_reason`。
        // 对齐 Embedded `checkAborted` 抛 AbortError 的路径，也与 Chat Completions
        // 适配器的 `!req.cancel` 判定同一口径；引擎据 `cancel` 走「用户中断」收尾。
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let all_items_done = output_item_added > 0
            && output_item_done >= output_item_added
            && current_kind.is_none();
        if all_items_done {
            // 所有 output item 都已完整返回（服务端只是漏发 completed）→ 当作正常结束
            stop_reason = Some("end_turn".to_string());
        } else {
            // 已返回的内容不完整，不应进入上下文：丢弃并重试
            return Err(StreamFailure::Retryable(
                "stream ended without terminal event (stopReason=undefined)".to_string(),
            ));
        }
    }

    if !message_delta_emitted {
        // 兜底补发一次（服务端未发 completed / incomplete）；usage 缺省由引擎填
        emit(LlmEvent::MessageDelta);
    }
    if let Some(reason) = stop_reason {
        emit(LlmEvent::StopReason(reason));
    }
    // `local_input_estimate` 只服务诊断日志（Embedded 用它做 usage 可信度判断的
    // 旁证）；Rust 侧保留计算以便后续接日志，这里显式忽略。
    let _ = local_input_estimate;
    Ok(())
}

/// 解析工具入参 JSON 字符串（失败时保留原字符串，对齐 Embedded 的 try/catch）
fn parse_tool_arguments(args: &str) -> Value {
    match serde_json::from_str::<Value>(args) {
        Ok(parsed) => crate::engine::unwrap_tool_input_for_adapter(parsed),
        Err(_) => json!(args),
    }
}

#[cfg(test)]
#[path = "responses_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "responses_stream_tests.rs"]
mod stream_tests;

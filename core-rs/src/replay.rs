//! 历史消息 → UI 显示消息。
//!
//! 这是「历史消息 → 显示消息」的**唯一转换点**：压缩后重建（`messagesReplaced`）
//! 与宿主展开归档共用它，`_meta` 裁剪与 Edit 的 diff 字段处理都收敛在这里。

use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::engine::Core;
use crate::util;

/// 一条 `tool_result` 的展示信息
#[derive(Clone, Debug)]
pub struct ToolResultInfo {
    pub content: String,
    pub exit_code: i64,
}

/// 从 `dataUrl` 解析 media type 与 base64 数据（`parseDataUrl`）
pub fn parse_data_url(data_url: &str) -> (String, String) {
    // `/^data:([^;,]+);base64,(.*)$/s`
    if let Some(rest) = data_url.strip_prefix("data:") {
        if let Some(separator) = rest.find(";base64,") {
            let media_type = &rest[..separator];
            if !media_type.is_empty() && !media_type.contains([';', ',']) {
                return (
                    media_type.to_string(),
                    rest[separator + ";base64,".len()..].to_string(),
                );
            }
        }
    }
    // 不是标准 data URL 时视为纯 base64
    ("image/png".to_string(), data_url.to_string())
}

/// 图片块 → UI 用的 dataUrl（`imageBlockToDataUrl`）
pub fn image_block_to_data_url(block: &Value) -> Option<String> {
    if block.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let source = block.get("source")?;
    if source.get("type").and_then(Value::as_str) != Some("base64") {
        return None;
    }
    let data = source.get("data").and_then(Value::as_str)?;
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{media_type};base64,{data}"))
}

/// 用户消息 content → UI 展示内容（`extractUserContent`）。
///
/// `tool_result` 等工具相关块不会显示在普通用户消息里。
pub fn extract_user_content(content: Option<&Value>) -> (String, Vec<Value>) {
    let mut images: Vec<Value> = Vec::new();
    match content {
        Some(Value::String(text)) => return (text.clone(), images),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<String> = Vec::new();
            for block in blocks {
                let Some(object) = block.as_object() else {
                    continue;
                };
                match object.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = object.get("text").and_then(Value::as_str) {
                            parts.push(text.to_string());
                        }
                    }
                    Some("image") => {
                        if let Some(data_url) = image_block_to_data_url(block) {
                            let (media_type, _) = parse_data_url(&data_url);
                            images.push(json!({ "dataUrl": data_url, "mediaType": media_type }));
                        }
                    }
                    _ => {}
                }
            }
            (parts.join("\n"), images)
        }
        // `String(content ?? '')`：null / undefined 都归空串
        Some(Value::Null) | None => (String::new(), images),
        Some(other) => (util::js_string(other), images),
    }
}

/// 消息来源（`getMessageOrigin`）：`user` / `agent` / `bash`，未标记为 `None`
pub fn message_origin(message: &Value) -> Option<&'static str> {
    match message.get("origin").and_then(Value::as_str) {
        Some("user") => Some("user"),
        Some("agent") => Some("agent"),
        Some("bash") => Some("bash"),
        Some(_) => None,
        None => {
            if message.get("fromSubAgent").and_then(Value::as_bool) == Some(true) {
                Some("agent")
            } else if message.get("fromBashTask").and_then(Value::as_bool) == Some(true) {
                Some("bash")
            } else {
                None
            }
        }
    }
}

/// 收集 tool_result 的展示信息（`buildToolResultMap`），跳过已取消的结果
pub fn build_tool_result_map(messages: &[Value]) -> Vec<(String, ToolResultInfo)> {
    let mut map: Vec<(String, ToolResultInfo)> = Vec::new();
    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("user") {
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
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            if block.get("is_canceled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let content = match block.get("content") {
                Some(Value::Array(_)) => "[Image]".to_string(),
                Some(other) => util::js_string(other),
                None => String::new(),
            };
            let exit_code = block.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
            map.retain(|(id, _)| id != tool_use_id);
            map.push((
                tool_use_id.to_string(),
                ToolResultInfo { content, exit_code },
            ));
        }
    }
    map
}

/// 持久化格式的历史消息 → UI 显示用的 `MessageData[]`（`buildReplayMessageData`）
pub fn build_replay_message_data(messages: &[Value]) -> Vec<Value> {
    let tool_results = build_tool_result_map(messages);
    let mut out: Vec<Value> = Vec::new();

    for message in messages {
        let is_meta = message.get("isMeta").and_then(Value::as_bool) == Some(true);
        let is_silent = message.get("silent").and_then(Value::as_bool) == Some(true);
        if is_meta || is_silent {
            continue;
        }
        let origin = message_origin(message);

        match message.get("type").and_then(Value::as_str) {
            Some("system") => {
                if message.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
                    continue;
                }
                out.push(json!({
                    "role": "system",
                    "content": message.get("content").cloned().unwrap_or(Value::Null),
                }));
            }
            Some("user") => {
                let content = message.get("message").and_then(|inner| inner.get("content"));
                let (text, images) = extract_user_content(content);
                if text.is_empty() && images.is_empty() {
                    continue;
                }

                // 发送时用户主动隐藏的文件标签，重放时也不能显示。
                // 文件信息可能落在顶层，也可能在 `_meta` 中，统一兼容。
                let inner_meta = message.get("_meta").and_then(Value::as_object);
                let raw_file_path = message
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        inner_meta
                            .and_then(|meta| meta.get("filePath"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                let raw_selected_lines = message
                    .get("fileSelectedLines")
                    .cloned()
                    .or_else(|| inner_meta.and_then(|meta| meta.get("fileSelectedLines")).cloned());
                let was_file_hidden =
                    message.get("fileHidden").and_then(Value::as_bool) == Some(true);
                let show_file_info = !was_file_hidden && raw_file_path.is_some();

                let replay_meta = inner_meta.map(|meta| {
                    let mut cloned = meta.clone();
                    if show_file_info {
                        if let Some(path) = &raw_file_path {
                            cloned.insert("filePath".to_string(), json!(path));
                        }
                        if let Some(lines) = &raw_selected_lines {
                            cloned.insert("fileSelectedLines".to_string(), lines.clone());
                        }
                    } else {
                        cloned.remove("filePath");
                        cloned.remove("fileSelectedLines");
                        // 子代理 from/to 的 param 仍用于跳转 / 来源展示
                        if origin != Some("agent") {
                            cloned.remove("param");
                        }
                    }
                    cloned
                });

                let mut data = Map::new();
                data.insert("role".to_string(), json!("user"));
                data.insert("content".to_string(), json!(text));
                if !images.is_empty() {
                    data.insert("images".to_string(), Value::Array(images));
                }
                if show_file_info {
                    if let Some(path) = &raw_file_path {
                        data.insert("filePath".to_string(), json!(path));
                    }
                    if let Some(lines) = &raw_selected_lines {
                        data.insert("fileSelectedLines".to_string(), lines.clone());
                    }
                }
                // 恒存在（`meta.isCompactSummary === true` 的布尔结果）
                data.insert(
                    "isCompactSummary".to_string(),
                    json!(message.get("isCompactSummary").and_then(Value::as_bool) == Some(true)),
                );
                if let Some(origin) = origin {
                    data.insert("origin".to_string(), json!(origin));
                }
                if let Some(meta) = replay_meta {
                    data.insert("meta".to_string(), Value::Object(meta));
                }
                out.push(Value::Object(data));
            }
            Some("assistant") => {
                let Some(blocks) = message
                    .get("message")
                    .and_then(|inner| inner.get("content"))
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for block in blocks {
                    let Some(object) = block.as_object() else {
                        continue;
                    };
                    match object.get("type").and_then(Value::as_str) {
                        Some("thinking") => {
                            out.push(json!({
                                "role": "thinking",
                                "content": object
                                    .get("thinking")
                                    .and_then(Value::as_str)
                                    .unwrap_or(""),
                            }));
                        }
                        Some("text") => {
                            out.push(json!({
                                "role": "assistant",
                                "content": object.get("text").and_then(Value::as_str).unwrap_or(""),
                            }));
                        }
                        Some("tool_use") => {
                            let tool_use_id = object
                                .get("id")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let tool_name = object
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let result = tool_results
                                .iter()
                                .find(|(id, _)| *id == tool_use_id)
                                .map(|(_, info)| info.clone());

                            let mut tool_args = object
                                .get("input")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            let block_meta = object.get("_meta").and_then(Value::as_object);

                            // Edit 不预计算 diffHunks，
                            // 改为下发 beforeContent / afterContent，让 webview 用同一份
                            // `buildEditDiffHunks` 回退计算（渲染一致，代价是帧体积更大）。
                            if let Some(meta) = block_meta {
                                let before = meta.get("beforeContent").and_then(Value::as_str);
                                let after = meta.get("afterContent").and_then(Value::as_str);
                                if tool_name == "Edit" && before.is_some() && after.is_some() {
                                    tool_args.insert(
                                        "beforeContent".to_string(),
                                        json!(before.unwrap_or("")),
                                    );
                                    tool_args.insert(
                                        "afterContent".to_string(),
                                        json!(after.unwrap_or("")),
                                    );
                                } else if meta.get("beforeContent").is_some()
                                    || meta.get("afterContent").is_some()
                                {
                                    tool_args.insert(
                                        "beforeContent".to_string(),
                                        meta.get("beforeContent").cloned().unwrap_or(Value::Null),
                                    );
                                    tool_args.insert(
                                        "afterContent".to_string(),
                                        meta.get("afterContent").cloned().unwrap_or(Value::Null),
                                    );
                                }
                            }

                            let status = match &result {
                                Some(info) => {
                                    if info.exit_code != 0 {
                                        "fail"
                                    } else {
                                        "success"
                                    }
                                }
                                None => "running",
                            };
                            out.push(json!({
                                "role": "toolcall",
                                "content": result.as_ref().map(|info| info.content.clone()).unwrap_or_default(),
                                "param": format!("⚙️ {}", if tool_name.is_empty() { "tool" } else { &tool_name }),
                                "toolName": tool_name,
                                "toolArgs": Value::Object(tool_args),
                                "toolCallId": tool_use_id,
                                "status": status,
                            }));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    out
}

/// 把历史消息整批替换到 UI（压缩后重建 / 展开归档共用）。
///
/// 只发一条 `messagesReplaced`，不再「先清空再逐条补」——两步动作会让 UI 的
/// 中间态（列表空着）暴露，也让「替换」在事件流里看不出边界。
pub fn replay_messages_to_ui(core: &Arc<Core>, session_id: &str, messages: &[Value]) {
    core.emit(json!({
        "type": "messagesReplaced",
        "sessionId": session_id,
        "messages": build_replay_message_data(messages),
    }));
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;

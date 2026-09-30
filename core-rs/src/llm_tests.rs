//! `llm` 的单元测试：协议转换、URL 拼接、以及两条流式解析链路（走本地假服务）。

use super::*;
use crate::test_support::{anthropic_sse, openai_text_sse, openai_thinking_sse, openai_tool_sse, FakeLlm};
use serde_json::json;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

fn provider(base_url: &str, api_type: &str) -> ProviderConfig {
    ProviderConfig {
        api_key: "sk-test".to_string(),
        base_url: base_url.to_string(),
        model: "test-model".to_string(),
        api_type: api_type.to_string(),
        max_tokens: 1024,
        thinking_budget_tokens: 256,
        thinking_effort: "high".to_string(),
        context_window: 1024 * 1024,
        web_search: false,
    }
}

/// 跑一次 `stream`，返回收集到的事件
fn collect(
    provider: &ProviderConfig,
    messages: &[Value],
    tools: &[Value],
    thinking_enabled: bool,
) -> (Result<(), String>, Vec<LlmEvent>) {
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider,
        system_prompt: "你是助手",
        messages,
        tools,
        session_id: "sess-llm",
        thinking_enabled,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    let result = stream(&request, &mut |event| events.push(event));
    (result, events)
}

/// 跑一次 `stream`（自定义看门狗超时，供超时用例使用）
fn collect_with_timeouts(
    provider: &ProviderConfig,
    first_byte_timeout_ms: u64,
    idle_timeout_ms: u64,
) -> (Result<(), String>, Vec<LlmEvent>) {
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider,
        system_prompt: "你是助手",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "sess-llm",
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms,
        idle_timeout_ms,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    let result = stream(&request, &mut |event| events.push(event));
    (result, events)
}

/// 起一个「接受请求后按脚本写 SSE，然后挂住连接」的假服务。
///
/// 返回 base_url 与请求计数（断言重试次数）。脚本在独立线程里跑，避免挂住测试线程；
/// 连接保持到脚本结束（脚本里 sleep 模拟停滞）。
fn start_stalling_server<F>(script: F) -> (String, Arc<AtomicUsize>)
where
    F: Fn(usize, &mut std::net::TcpStream) + Send + Sync + 'static,
{
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind stalling server");
    let addr = listener.local_addr().expect("local addr");
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_thread = Arc::clone(&hits);
    let script = Arc::new(script);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let index = hits_thread.fetch_add(1, Ordering::SeqCst);
            let script = Arc::clone(&script);
            std::thread::spawn(move || {
                // 先读到请求头结束，保证客户端把请求体写完
                let mut reader = std::io::BufReader::new(stream.try_clone().expect("clone stream"));
                let mut line = String::new();
                loop {
                    line.clear();
                    if std::io::BufRead::read_line(&mut reader, &mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line == "\r\n" {
                        break;
                    }
                }
                script(index, &mut stream);
            });
        }
    });
    (format!("http://{addr}"), hits)
}

/// 起一个「读完整 HTTP 请求（头 + 体）、把**原始请求体**存进 `captured`，然后回一段
/// 固定 SSE」的假服务。用于断言请求体字节（如 JS 数字格式）。
fn start_body_capture_server(
    captured: Arc<std::sync::Mutex<Vec<String>>>,
    response: String,
) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind capture server");
    let addr = listener.local_addr().expect("local addr");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            // 逐字节读头，直到空行
            let mut head: Vec<u8> = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                match stream.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        head.push(byte[0]);
                        if head.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                }
            }
            let head_text = String::from_utf8_lossy(&head).to_string();
            let length = head_text
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    if name.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            let mut filled = 0usize;
            while filled < length {
                match stream.read(&mut body[filled..]) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => filled += read,
                }
            }
            captured
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&body).to_string());
            let response = response.clone();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{response}",
                    response.len()
                )
                .as_bytes(),
            );
            let _ = stream.flush();
        }
    });
    format!("http://{addr}")
}

fn write_sse_headers(stream: &mut std::net::TcpStream) {
    use std::io::Write;
    stream
        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
        .expect("write headers");
    stream.flush().expect("flush headers");
}

fn write_sse_event(stream: &mut std::net::TcpStream, payload: &str) {
    use std::io::Write;
    stream
        .write_all(format!("data: {payload}\n\n").as_bytes())
        .expect("write event");
    stream.flush().expect("flush event");
}

fn text_of(events: &[LlmEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::TextDelta(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn thinking_of(events: &[LlmEvent]) -> String {
    events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ThinkingDelta(text) => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

// ==================== 纯函数 ====================

#[test]
fn usage_json_always_carries_cache_keys_and_omits_absent_reasoning() {
    let minimal = Usage {
        input_tokens: 10,
        output_tokens: 20,
        ..Usage::default()
    }
    .to_json();
    assert_eq!(minimal["input_tokens"], 10);
    assert_eq!(minimal["output_tokens"], 20);
    // 对齐 Embedded `extractUsageFields` / `applyMessageDelta`：cache 两键恒存在（缺省 0）
    assert_eq!(minimal["cache_read_input_tokens"], 0);
    assert_eq!(minimal["cache_creation_input_tokens"], 0);
    assert!(minimal.get("reasoning_tokens").is_none());

    let full = Usage {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: Some(3),
        cache_creation_input_tokens: Some(4),
        reasoning_tokens: Some(5),
    }
    .to_json();
    assert_eq!(full["cache_read_input_tokens"], 3);
    assert_eq!(full["cache_creation_input_tokens"], 4);
    assert_eq!(full["reasoning_tokens"], 5);
}

#[test]
fn join_url_trims_the_base_trailing_slashes() {
    // 约定：suffix 自带前导斜杠，base 的尾斜杠被吃掉
    assert_eq!(join_url("https://x", "/v1/messages"), "https://x/v1/messages");
    assert_eq!(join_url("https://x/", "/v1/messages"), "https://x/v1/messages");
    assert_eq!(join_url("https://x//", "/v1/messages"), "https://x/v1/messages");
    assert_eq!(join_url("https://x", "/"), "https://x/");
}

#[test]
fn protocol_urls_handle_v1_suffixed_bases() {
    assert_eq!(
        chat_completions_url("https://api.example.com"),
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(
        chat_completions_url("https://api.example.com/v1"),
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(
        chat_completions_url("https://api.example.com/v1/"),
        "https://api.example.com/v1/chat/completions"
    );
    assert_eq!(
        messages_url("https://api.example.com"),
        "https://api.example.com/v1/messages"
    );
    assert_eq!(
        messages_url("https://api.example.com/v1"),
        "https://api.example.com/v1/messages"
    );
}

#[test]
fn chat_messages_pass_through_plain_text() {
    let messages = vec![
        json!({ "role": "user", "content": "你好" }),
        json!({ "role": "assistant", "content": [{ "type": "text", "text": "在的" }] }),
    ];
    let out = to_chat_messages(&messages);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0], json!({ "role": "user", "content": "你好" }));
    assert_eq!(out[1], json!({ "role": "assistant", "content": "在的" }));
}

#[test]
fn chat_messages_convert_images_to_data_urls() {
    let messages = vec![json!({ "role": "user", "content": [
        { "type": "text", "text": "看图" },
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }
    ] })];
    let out = to_chat_messages(&messages);
    assert_eq!(out.len(), 1);
    let blocks = out[0]["content"].as_array().unwrap();
    assert_eq!(blocks[0], json!({ "type": "text", "text": "看图" }));
    assert_eq!(blocks[1]["type"], "image_url");
    assert_eq!(blocks[1]["image_url"]["url"], "data:image/png;base64,AAAA");

    // media_type 缺省时按 png 处理
    let fallback = to_chat_messages(&[json!({ "role": "user", "content": [
        { "type": "image", "source": { "data": "BBBB" } }
    ] })]);
    assert_eq!(
        fallback[0]["content"][0]["image_url"]["url"],
        "data:image/png;base64,BBBB"
    );
}

#[test]
fn chat_messages_split_tool_results_into_tool_role_entries() {
    let messages = vec![json!({ "role": "user", "content": [
        { "type": "tool_result", "tool_use_id": "call_1", "content": "第一行" },
        { "type": "tool_result", "tool_use_id": "call_2", "content": "第二行" }
    ] })];
    let out = to_chat_messages(&messages);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0], json!({ "role": "tool", "tool_call_id": "call_1", "content": "第一行" }));
    assert_eq!(out[1], json!({ "role": "tool", "tool_call_id": "call_2", "content": "第二行" }));
}

#[test]
fn chat_messages_convert_tool_use_and_thinking() {
    let messages = vec![json!({ "role": "assistant", "content": [
        { "type": "thinking", "thinking": "先看看" },
        { "type": "text", "text": "我来查一下" },
        { "type": "tool_use", "id": "call_9", "name": "Bash", "input": { "command": "ls" } }
    ] })];
    let out = to_chat_messages(&messages);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["role"], "assistant");
    assert_eq!(out[0]["content"], "我来查一下");
    // thinking block 不回传（部分 Chat Completions 服务商拒绝 reasoning_content）
    assert!(out[0].get("reasoning_content").is_none());
    let call = &out[0]["tool_calls"][0];
    assert_eq!(call["id"], "call_9");
    assert_eq!(call["type"], "function");
    assert_eq!(call["function"]["name"], "Bash");
    // 入参序列化成 JSON 字符串（Chat Completions 的约定）
    let arguments: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
    assert_eq!(arguments["command"], "ls");
}

#[test]
fn chat_messages_match_embedded_empty_and_unknown_entries() {
    // Embedded `convertMessagesToChatCompletions` 对字符串 content 原样透传（含空串）
    assert_eq!(
        to_chat_messages(&[json!({ "role": "user", "content": "" })]),
        vec![json!({ "role": "user", "content": "" })]
    );
    // 空数组 content 不产生条目
    assert!(to_chat_messages(&[json!({ "role": "user", "content": [] })]).is_empty());
    // 其它 role（system / developer）原样透传
    assert_eq!(
        to_chat_messages(&[json!({ "role": "system", "content": "x" })]),
        vec![json!({ "role": "system", "content": "x" })]
    );
    // 无 role 的裸消息：JS 里 `{ role: undefined, content }` 序列化后只剩 content
    assert_eq!(
        to_chat_messages(&[json!({ "content": "no role" })]),
        vec![json!({ "content": "no role" })]
    );
    // 空 assistant（只有 thinking / 未知 block 被忽略时）不产生条目
    assert!(to_chat_messages(&[json!({ "role": "assistant", "content": [
        { "type": "unknown" }
    ] })]).is_empty());
}

#[test]
fn chat_tools_wrap_input_schema_as_parameters() {
    let tools = crate::tools::definitions();
    let converted = to_chat_tools(&tools);
    assert_eq!(converted.len(), tools.len());
    assert_eq!(converted[0]["type"], "function");
    assert_eq!(converted[0]["function"]["name"], "Bash");
    assert!(converted[0]["function"]["description"].as_str().is_some_and(|t| !t.is_empty()));
    assert_eq!(converted[0]["function"]["parameters"]["type"], "object");

    // 对齐 Embedded：缺 name 退化为 "unknown"，缺 / null input_schema 退化为
    // `{ type: "object", properties: {}, required: [] }`，非 function 类型的工具被丢弃
    let partial = to_chat_tools(&[json!({ "description": "无名字" }), json!({ "name": "X" })]);
    assert_eq!(partial.len(), 2);
    assert_eq!(partial[0]["function"]["name"], "unknown");
    assert_eq!(partial[1]["function"]["name"], "X");
    assert_eq!(
        partial[1]["function"]["parameters"],
        json!({ "type": "object", "properties": {}, "required": [] })
    );
    assert!(to_chat_tools(&[json!({ "name": "web", "type": "web_search_preview" })]).is_empty());
}

// ==================== OpenAI 流式 ====================

#[test]
fn openai_stream_emits_text_deltas_and_stop_reason() {
    let llm = FakeLlm::fixed(openai_text_sse(&["你好", "，世界"]));
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);

    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "你好，世界");
    // finish_reason `stop` 映射为内部 `end_turn`
    assert!(events.iter().any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "end_turn")));
}

#[test]
fn sse_parsing_uses_js_trim_before_the_data_prefix() {
    // 对齐 `parseSSELines` 的 `line.trim().startsWith('data:')`：整行先按 JS 空白
    // 口径 trim，前导空格 / U+FEFF 都要容忍（U+FEFF 是 JS 空白，Rust `trim` 不去）。
    let mut body = String::new();
    body.push_str(&format!(
        "  data: {}\n\n",
        json!({ "choices": [{ "delta": { "content": "A" } }] })
    ));
    body.push_str(&format!(
        "\u{FEFF}data: {}\n\n",
        json!({ "choices": [{ "delta": { "content": "B" } }] })
    ));
    body.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })
    ));
    body.push_str("data: [DONE]\n\n");

    let llm = FakeLlm::fixed(body);
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);

    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "AB");
}

#[test]
fn request_bodies_use_js_json_number_format() {
    // Embedded 用 `JSON.stringify`（`stringifyJsonSafe`）：`temperature: 1.0` 序列化成
    // `1`。Rust 必须用 `util::js_json_stringify`，不能落到 serde_json 的 `1.0`。
    for api_type in ["OpenAI", "Anthropic"] {
        let captured: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let base = start_body_capture_server(Arc::clone(&captured), openai_text_sse(&["hi"]));
        let provider = provider(&base, api_type);
        let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
        assert!(result.is_ok(), "api_type={api_type} got {result:?}");
        let raw = captured.lock().unwrap().pop().expect("captured body");
        assert!(raw.contains("\"temperature\":1"), "api_type={api_type} raw={raw}");
        assert!(!raw.contains("\"temperature\":1.0"), "api_type={api_type} raw={raw}");
        assert!(raw.contains("\"top_p\":0.95"), "api_type={api_type} raw={raw}");
    }
}

#[test]
fn openai_stream_emits_tool_calls_split_across_chunks() {
    let arguments = r#"{"command":"echo hi","description":"greet"}"#;
    let llm = FakeLlm::fixed(openai_tool_sse("call_1", "Bash", arguments));
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");

    let starts: Vec<(&String, &String)> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseStart { id, name, .. } => Some((id, name)),
            _ => None,
        })
        .collect();
    assert_eq!(starts.len(), 1);
    assert_eq!(starts[0].0, "call_1");
    assert_eq!(starts[0].1, "Bash");

    let joined: String = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseInputDelta(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(joined, arguments, "分片参数应能拼回完整 JSON");
    let parsed: Value = serde_json::from_str(&joined).unwrap();
    assert_eq!(parsed["command"], "echo hi");
}

#[test]
fn openai_stream_generates_fallback_tool_ids_like_embedded() {
    // 对齐 Embedded `OpenAiApi`：`tc.id || \`call_${streamMessageId}_${idx}\``。
    // streamMessageId 的形态是 `msg_${Date.now()}_${random}`，因此兜底 id 必须形如
    // `call_msg_<millis>_<random>_<index>`（而不是旧的 `call_<millis>_<suffix>`）。
    let mut sse = String::new();
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "name": "Bash", "arguments": "{\"command\":\"ls\"}" } }
        ] } }] })
    ));
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
    ));
    sse.push_str("data: [DONE]\n\n");

    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");

    let id = events
        .iter()
        .find_map(|event| match event {
            LlmEvent::ToolUseStart { id, .. } => Some(id.clone()),
            _ => None,
        })
        .expect("tool use start");
    assert!(id.starts_with("call_msg_"), "got {id}");
    assert!(id.ends_with("_0"), "got {id}");
    let middle = id
        .trim_start_matches("call_msg_")
        .trim_end_matches("_0")
        .to_string();
    assert!(!middle.is_empty(), "got {id}");
    assert_eq!(middle.matches('_').count(), 1, "got {id}");
}

#[test]
fn openai_stream_emits_thinking_and_usage() {
    let llm = FakeLlm::fixed(openai_thinking_sse("先想想", "答案是 42"));
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(thinking_of(&events), "先想想");
    assert_eq!(text_of(&events), "答案是 42");

    let usage = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::Usage(usage) if usage.input_tokens > 0 || usage.output_tokens > 0 => Some(usage),
            _ => None,
        })
        .next()
        .expect("usage event");
    assert_eq!(usage.input_tokens, 11);
    assert_eq!(usage.output_tokens, 22);
}

#[test]
fn openai_stream_merges_interleaved_parallel_tool_calls_by_index() {
    // 两个并行工具调用，arguments 交错分片：必须按 index 归并，不能把后一个的参数拼进前一个
    let mut sse = String::new();
    for delta in [
        json!({ "tool_calls": [{ "index": 0, "id": "call_a",
            "function": { "name": "Bash", "arguments": "{\"comm" } }] }),
        json!({ "tool_calls": [{ "index": 1, "id": "call_b",
            "function": { "name": "Read", "arguments": "{\"file" } }] }),
        json!({ "tool_calls": [{ "index": 0, "function": { "arguments": "and\":\"ls\"}" } }] }),
        json!({ "tool_calls": [{ "index": 1, "function": { "arguments": "_path\":\"a.txt\"}" } }] }),
    ] {
        sse.push_str(&format!(
            "data: {}\n\n",
            json!({ "choices": [{ "delta": delta }] })
        ));
    }
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
    ));
    sse.push_str("data: [DONE]\n\n");

    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(
        &provider,
        &[json!({ "role": "user", "content": "hi" })],
        &[],
        true,
    );
    assert!(result.is_ok(), "got {result:?}");

    let starts: Vec<(String, String)> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseStart { id, name, .. } => Some((id.clone(), name.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        vec![
            ("call_a".to_string(), "Bash".to_string()),
            ("call_b".to_string(), "Read".to_string()),
        ],
        "工具调用应按首次出现顺序、且 id/name 取首个非空值"
    );

    // 每个 start 之后的 input delta 属于该工具（事件顺序：start a → input a → start b → input b）
    let mut current: Option<usize> = None;
    let mut joined = vec![String::new(), String::new()];
    for event in &events {
        match event {
            LlmEvent::ToolUseStart { .. } => {
                current = Some(current.map_or(0, |value| value + 1));
            }
            LlmEvent::ToolUseInputDelta(delta) => {
                if let Some(index) = current {
                    joined[index].push_str(delta);
                }
            }
            _ => {}
        }
    }
    assert_eq!(joined[0], "{\"command\":\"ls\"}");
    assert_eq!(joined[1], "{\"file_path\":\"a.txt\"}");
}

#[test]
fn openai_stream_falls_back_to_reasoning_when_reasoning_content_is_empty() {
    // 对齐 Embedded：`reasoning_content` 只有非空时才优先，空串回退到 `reasoning`
    let mut sse = String::new();
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "reasoning_content": "", "reasoning": "回退思考" } }] })
    ));
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "content": "答" } }] })
    ));
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })
    ));
    sse.push_str("data: [DONE]\n\n");

    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(
        &provider,
        &[json!({ "role": "user", "content": "hi" })],
        &[],
        true,
    );
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(thinking_of(&events), "回退思考");
}

#[test]
fn openai_stream_surfaces_http_errors_with_the_body() {
    let llm = FakeLlm::start(|_, _| "{\"error\":\"model not found\"}".to_string());
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    // 假服务总是回 200，因此这里拿到的是「流里没有内容」而不是 HTTP 错误
    assert!(result.is_ok(), "got {result:?}");
}

#[test]
fn openai_stream_reports_transport_failures() {
    // 指向一个没有监听的端口
    let provider = provider("http://127.0.0.1:1", "OpenAI");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    let error = result.unwrap_err();
    assert!(error.contains("request failed"), "got {error}");
}

#[test]
fn openai_stream_errors_when_the_server_reports_one() {
    let body = "data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n";
    let llm = FakeLlm::fixed(body.to_string());
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.unwrap_err().contains("quota exceeded"));
}

#[test]
fn openai_stream_error_without_message_serializes_the_error_object() {
    // 对齐 `OpenAiApi`：`` `Chat Completions failed: ${err?.message || JSON.stringify(err)}` ``。
    // 服务商只回错误码（没有 message 字段）时，Embedded 会把整个 error 对象显示给用户，
    // 而不是 `unknown error`。
    let llm = FakeLlm::fixed(
        "data: {\"error\":{\"code\":\"rate_limit\",\"type\":\"server_error\"}}\n\n".to_string(),
    );
    let provider_a = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider_a, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert_eq!(
        result.unwrap_err(),
        "Chat Completions failed: {\"code\":\"rate_limit\",\"type\":\"server_error\"}"
    );

    // message 为空串（JS 假值）时同样退化为整个对象
    let llm = FakeLlm::fixed("data: {\"error\":{\"message\":\"\",\"code\":\"x\"}}\n\n".to_string());
    let provider_b = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider_b, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert_eq!(
        result.unwrap_err(),
        "Chat Completions failed: {\"message\":\"\",\"code\":\"x\"}"
    );

    // message 是对象（JS 真值）时按 `String(value)` 拼接 → `[object Object]`
    let llm = FakeLlm::fixed(
        "data: {\"error\":{\"message\":{\"detail\":\"x\"}}}\n\n".to_string(),
    );
    let provider_c = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider_c, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert_eq!(
        result.unwrap_err(),
        "Chat Completions failed: [object Object]"
    );

    // `"error": null`（JS 假值）不算错误帧：对齐 Embedded 的 `if (parsed.error)`，
    // 该帧被忽略，流按「有内容 / 无 finish_reason」正常收尾。
    let llm = FakeLlm::fixed(
        "data: {\"error\":null,\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"
            .to_string(),
    );
    let provider_d = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider_d, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "ok");
}

#[test]
fn openai_stream_keeps_the_fallback_tool_id_when_a_later_chunk_carries_one() {
    // 对齐 Embedded：id 在 block **创建时**定死（`tc.id || call_${streamMessageId}_${idx}`），
    // 后续分片补上的 id 不会替换兜底 id（`if (tc.id && !block.id)` 永不成立）。
    let mut sse = String::new();
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "name": "Bash", "arguments": "{\"command\":" } }
        ] } }] })
    ));
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "tool_calls": [
            { "id": "call_late", "index": 0, "function": { "arguments": "\"ls\"}" } }
        ] } }] })
    ));
    sse.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
    ));
    sse.push_str("data: [DONE]\n\n");

    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");

    let (id, name) = events
        .iter()
        .find_map(|event| match event {
            LlmEvent::ToolUseStart { id, name, .. } => Some((id.clone(), name.clone())),
            _ => None,
        })
        .expect("tool use start");
    assert!(id.starts_with("call_msg_"), "got {id}");
    assert!(id.ends_with("_0"), "got {id}");
    assert_eq!(name, "Bash");
    // 参数仍按分片累积（id 是否被替换不影响 arguments 归并）
    let joined: String = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseInputDelta(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(joined, "{\"command\":\"ls\"}");
}

#[test]
fn openai_stream_ignores_malformed_and_irrelevant_lines() {
    let body = ": keep-alive comment\n\
                \n\
                data: not-json\n\n\
                data: {\"choices\":[]}\n\n\
                data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n\
                data: [DONE]\n\n";
    let llm = FakeLlm::fixed(body.to_string());
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "ok");
}

#[test]
fn openai_request_body_carries_system_prompt_and_tools() {
    let llm = FakeLlm::start(|_, body| {
        // 断言由闭包完成：body 里必须有 system 消息与 tools
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["stream"], true);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["messages"][0]["content"], "你是助手");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["tools"][0]["function"]["name"], "Bash");
        openai_text_sse(&["ok"])
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let tools = crate::tools::definitions();
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &tools, true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "ok");
}

#[test]
fn openai_request_omits_system_prompt_when_empty() {
    let llm = FakeLlm::start(|_, body| {
        assert_eq!(body["messages"][0]["role"], "user");
        assert!(body.get("tools").is_none());
        openai_text_sse(&["ok"])
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "s",
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    assert!(stream(&request, &mut |_| {}).is_ok());
}

// ==================== Anthropic 流式 ====================

#[test]
fn anthropic_stream_parses_thinking_text_and_usage() {
    let llm = FakeLlm::fixed(anthropic_sse("思考中", "答案", None));
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(thinking_of(&events), "思考中");
    assert_eq!(text_of(&events), "答案");

    let usage = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::Usage(usage) if usage.input_tokens > 0 => Some(usage),
            _ => None,
        })
        .next()
        .expect("message_start usage");
    // 对齐 Embedded：input_tokens 把两个 cache 计数加回（5 + 3 + 2）
    assert_eq!(usage.input_tokens, 10);
    assert_eq!(usage.cache_read_input_tokens, Some(3));
    assert_eq!(usage.cache_creation_input_tokens, Some(2));

    assert!(events
        .iter()
        .any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "end_turn")));
}

#[test]
fn anthropic_stream_parses_thinking_signature() {
    // signature_delta 必须被解析并保留，否则带工具调用的第二轮请求会被 Anthropic 拒绝
    let sse = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"想\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-abc\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
    )
    .to_string();
    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    let signature: String = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ThinkingSignatureDelta(signature) => Some(signature.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(signature, "sig-abc");
}

#[test]
fn anthropic_stream_keeps_signature_from_content_block_start() {
    // 对齐 Embedded `RealApi` 的 `content_block_start` 分支：thinking 块自带非空
    // signature 时要保留（部分网关只在这一帧给完整签名，不再发 signature_delta）。
    let sse = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig-start\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"想\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
    )
    .to_string();
    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    let signatures: Vec<&str> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ThinkingSignatureStart(signature) => Some(signature.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(signatures, vec!["sig-start"]);
}

#[test]
fn anthropic_stream_uses_content_block_start_input_when_no_delta() {
    // 对齐 Embedded `RealApi`：`content_block_start` 自带 input、且没有
    // `input_json_delta` 时，input 就是最终入参（部分网关不逐字流式传参）。
    let sse = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Bash\",\"input\":{\"command\":\"echo hi\"}}}\n\n",
        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
    )
    .to_string();
    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    let starts: Vec<(String, String, Value)> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseStart { id, name, input } => {
                Some((id.clone(), name.clone(), input.clone()))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        starts,
        vec![(
            "toolu_1".to_string(),
            "Bash".to_string(),
            json!({ "command": "echo hi" })
        )]
    );
}

#[test]
fn anthropic_empty_stop_reason_keeps_the_previous_one() {
    // 对齐 Embedded `RealApi.applyMessageDelta`：
    // `stopReason = msgDelta.stop_reason as string || stopReason`——空串是假值，
    // 不能把已经收到的 `tool_use` 覆盖成空（否则落盘 assistant 丢掉 stop_reason，
    // 引擎按「没有工具调用」收尾，工具结果不会再回 LLM）。
    let sse = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1},\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"\"}}\n\n",
    )
    .to_string();
    let llm = FakeLlm::fixed(sse);
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");

    let reasons: Vec<String> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::StopReason(reason) => Some(reason.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(reasons, vec!["tool_use".to_string()], "空 stop_reason 不得覆盖已有值");
}

#[test]
fn anthropic_stream_parses_tool_use_blocks() {
    let llm = FakeLlm::fixed(anthropic_sse("", "", Some(("toolu_1", "Read", r#"{"file_path":"a.ts"}"#))));
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");

    let starts: Vec<(String, String)> = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseStart { id, name, .. } => Some((id.clone(), name.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(starts, vec![("toolu_1".to_string(), "Read".to_string())]);

    let joined: String = events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::ToolUseInputDelta(delta) => Some(delta.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(joined, r#"{"file_path":"a.ts"}"#);
}

#[test]
fn anthropic_request_body_enables_or_disables_thinking() {
    let llm = FakeLlm::start(|_, body| {
        // 与 Embedded 一致：思考开启用 chat_template_kwargs + thinking_token_budget
        assert_eq!(body["chat_template_kwargs"]["thinking"], true);
        assert_eq!(body["chat_template_kwargs"]["reasoning_effort"], "high");
        assert_eq!(body["thinking_token_budget"], 256);
        assert!(body["thinking"].is_null(), "开启时不应发送 thinking 对象");
        assert_eq!(body["system"], "你是助手");
        anthropic_sse("", "ok", None)
    });
    let config = self::provider(&llm.base_url, "Anthropic");
    let (result, _) = collect(&config, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");

    let llm_disabled = FakeLlm::start(|_, body| {
        assert_eq!(body["thinking"]["type"], "disabled");
        anthropic_sse("", "ok", None)
    });
    let config = self::provider(&llm_disabled.base_url, "Anthropic");
    let (result, _) = collect(&config, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
}

#[test]
fn anthropic_stream_propagates_error_events() {
    let body = "data: {\"type\":\"error\",\"error\":{\"message\":\"overloaded\"}}\n\n";
    let llm = FakeLlm::fixed(body.to_string());
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.unwrap_err().contains("overloaded"));
}

#[test]
fn anthropic_stream_errors_without_a_message() {
    let body = "data: {\"type\":\"error\"}\n\n";
    let llm = FakeLlm::fixed(body.to_string());
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.unwrap_err().contains("unknown error"));
}

// ==================== 取消 ====================

#[test]
fn stream_stops_early_when_cancelled() {
    // 先发一条文本，随后取消标志已置位，后续行不再处理
    let body = format!(
        "data: {}\n\ndata: {}\n\n",
        json!({ "choices": [{ "delta": { "content": "first" } }] }),
        json!({ "choices": [{ "delta": { "content": "second" } }] })
    );
    let llm = FakeLlm::fixed(body);
    let provider = provider(&llm.base_url, "OpenAI");

    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "s",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "s",
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut deltas: Vec<String> = Vec::new();
    let result = stream(&request, &mut |event| {
        if let LlmEvent::TextDelta(text) = &event {
            deltas.push(text.clone());
        }
        // 第一个事件到达后立刻置位取消标志：后续数据帧不再处理
        cancel.store(true, Ordering::Relaxed);
    });
    assert!(result.is_ok(), "got {result:?}");
    // 只看文本增量：`block_start` / `block_stop` / `message_delta` 是收尾事件，
    // 不受取消影响；关键是第二帧的 "second" 不再产生文本增量。
    assert_eq!(deltas, vec!["first".to_string()], "取消后不再产生新事件");
}

#[test]
fn api_error_message_matches_the_embedded_format() {
    // 对齐 Embedded `API request failed: ${status} ${statusText}\n${errorText}`（正文不截断）
    assert_eq!(
        api_error_message(reqwest::StatusCode::BAD_REQUEST, "{\"error\":\"bad\"}"),
        "API request failed: 400 Bad Request\n{\"error\":\"bad\"}"
    );
    assert_eq!(
        api_error_message(reqwest::StatusCode::UNAUTHORIZED, ""),
        "API request failed: 401 Unauthorized\n"
    );
}

/// 两侧共用 `src/test/fixtures/chatCompletionParity.json`：
/// - `src/test/chatCompletionParity.test.ts` 断言「对照表 == `convertMessagesToChatCompletions` 的真实输出」；
/// - 这里断言「`to_chat_messages` == 对照表」（含空串透传、纯文本合并、tool_result 压平、
///   assistant tool_calls 的 `content: null`、其它 role 透传等 TS 分支）。
mod chat_completion_parity_tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../src/test/fixtures/chatCompletionParity.json");

    #[test]
    fn matches_the_shared_chat_completion_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture json");
        let cases = fixture.get("cases").and_then(Value::as_array).expect("cases");
        assert!(!cases.is_empty(), "对照表非空");
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("");
            let input = case.get("input").and_then(Value::as_array).expect("input");
            let expected = case.get("output").cloned().unwrap_or_else(|| json!([]));
            let actual = Value::Array(to_chat_messages(input));
            assert_eq!(actual, expected, "case {name}");
        }

        let tools = fixture.get("tools").and_then(Value::as_array).expect("tools");
        assert!(!tools.is_empty(), "工具对照表非空");
        for case in tools {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("");
            let input = case.get("input").and_then(Value::as_array).expect("input");
            let expected = case.get("output").cloned().unwrap_or_else(|| json!([]));
            let actual = Value::Array(to_chat_tools(input));
            assert_eq!(actual, expected, "tool case {name}");
        }
    }
}

// ==================== 退化重复检测（对齐 repetitionDetector.ts） ====================

fn feed_repetition(chunks: &[String]) -> Option<RepetitionHit> {
    let mut detector = RepetitionDetector::new();
    for chunk in chunks {
        if let Some(hit) = detector.append(chunk) {
            return Some(hit);
        }
    }
    None
}

#[test]
fn repetition_detector_matches_embedded_table() {
    // 期望值与 Embedded `RepetitionDetector` 逐字一致（TS 侧用例 llmStreamParity 同表）
    let cases: Vec<(Vec<String>, Option<(usize, usize, usize, &str, usize)>)> = vec![
        (vec!["a".repeat(6000)], Some((1, 6000, 6000, "a", 6000))),
        (
            vec!["hello world ".repeat(500)],
            Some((12, 500, 6000, "hello world ", 6000)),
        ),
        // 低于 minCheckLength=5000，不检测
        (vec!["a".repeat(4000)], None),
        (vec!["abc".repeat(1000)], None),
        (
            vec!["I'll check the file. ".repeat(300)],
            Some((21, 300, 6300, "I'll check the file. ", 6300)),
        ),
        (vec!["\n\n".repeat(3000)], Some((1, 6000, 6000, "\n", 6000))),
        // 循环前混入正常内容：只比对尾部窗口
        (
            vec![format!("{}{}", "hello world ".repeat(300), "ab".repeat(3000))],
            Some((2, 3000, 6000, "ab", 9600)),
        ),
        // 代理对：重复单元按 UTF-16 code unit 计（emoji = 2）
        (vec!["😀".repeat(3000)], Some((2, 3000, 6000, "😀", 6000))),
        // 逐字符喂入：首次检测发生在累计 5000 字符
        (
            (0..6000).map(|_| "a".to_string()).collect(),
            Some((1, 5000, 5000, "a", 5000)),
        ),
    ];
    for (chunks, expected) in cases {
        let hit = feed_repetition(&chunks);
        match expected {
            None => assert!(hit.is_none(), "不应命中：{:?}", hit),
            Some((unit, count, span, preview, total)) => {
                let hit = hit.unwrap_or_else(|| panic!("应命中 unit={unit}"));
                assert_eq!(
                    (hit.unit_length, hit.repeat_count, hit.span_length, hit.unit_preview.as_str(), hit.total_length),
                    (unit, count, span, preview, total)
                );
            }
        }
    }
}

#[test]
fn repetition_error_message_matches_embedded_wording() {
    let mut detector = RepetitionDetector::new();
    let error = check_repetition(&mut detector, &"a".repeat(6000), "text").unwrap_err();
    assert_eq!(
        error.message(),
        "检测到模型循环输出：正文中长度 1 的片段连续重复 6000 次（共 6000 字符），判定为服务端异常"
    );
    let mut thinking = RepetitionDetector::new();
    let error = check_repetition(&mut thinking, &"a".repeat(6000), "thinking").unwrap_err();
    assert!(error.message().starts_with("检测到模型循环输出：思考中长度 1"));
}

// ==================== 重试（对齐 shared.ts / 两个适配器） ====================

#[test]
fn retryable_status_codes_match_embedded() {
    assert!(is_retryable_status(502));
    assert!(is_retryable_status(503));
    assert!(!is_retryable_status(500));
    assert!(!is_retryable_status(400));
    assert!(!is_retryable_status(429));
    assert_eq!(RETRY_DELAY_MS, 1000);
    assert_eq!(MAX_RETRIES, 3);
}

#[test]
fn stream_retries_on_retryable_status() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start_with_status(move |index, _| {
        counter.fetch_add(1, Ordering::Relaxed);
        if index == 0 {
            (503, "service unavailable".to_string())
        } else {
            (200, openai_text_sse(&["重试成功"]))
        }
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(calls.load(Ordering::Relaxed), 2, "503 应当重试一次");
    // 重试即重建累积（对齐 Embedded `executeRequest` 内的 `contentBlocks`）
    assert!(events.iter().any(|event| matches!(event, LlmEvent::Reset)));
    assert!(events.iter().any(|event| matches!(event, LlmEvent::TextDelta(text) if text == "重试成功")));
}

#[test]
fn stream_gives_up_after_max_retries() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start_with_status(move |_index, _| {
        counter.fetch_add(1, Ordering::Relaxed);
        (502, "bad gateway".to_string())
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, _) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    let error = result.unwrap_err();
    assert!(error.contains("502"), "got {error}");
    // 初次 + MAX_RETRIES 次重试
    assert_eq!(calls.load(Ordering::Relaxed), (MAX_RETRIES + 1) as usize);
}

#[test]
fn openai_stream_retries_when_it_ends_without_finish_reason_or_content() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start(move |index, _| {
        counter.fetch_add(1, Ordering::Relaxed);
        if index == 0 {
            // 只有 usage，没有 choices、没有 finish_reason
            "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":0}}\n\ndata: [DONE]\n\n".to_string()
        } else {
            openai_text_sse(&["补齐"])
        }
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(calls.load(Ordering::Relaxed), 2, "无内容且无结束原因应重试一次");
    assert!(events.iter().any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "end_turn")));
}

#[test]
fn openai_stream_accepts_content_without_finish_reason_as_end_turn() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start(move |_index, _| {
        counter.fetch_add(1, Ordering::Relaxed);
        // 有内容、无 finish_reason
        "data: {\"choices\":[{\"delta\":{\"content\":\"半截\"}}]}\n\ndata: [DONE]\n\n".to_string()
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(calls.load(Ordering::Relaxed), 1, "有内容时不应重试");
    assert!(events.iter().any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "end_turn")));
}

#[test]
fn stream_retries_once_after_detecting_repetition_and_resets_output() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start(move |index, _| {
        counter.fetch_add(1, Ordering::Relaxed);
        if index == 0 {
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({ "choices": [{ "delta": { "content": "a".repeat(6000) }, "finish_reason": "stop" }] })
            )
        } else {
            openai_text_sse(&["正常回复"])
        }
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(calls.load(Ordering::Relaxed), 2, "退化重复应重试一次");
    // 重试前发 Reset，且重复内容从未作为增量发给上层
    let reset_at = events
        .iter()
        .position(|event| matches!(event, LlmEvent::Reset))
        .expect("应当发出 Reset");
    assert!(
        !events[..reset_at]
            .iter()
            .any(|event| matches!(event, LlmEvent::TextDelta(_))),
        "重复内容不应作为增量发出"
    );
    assert!(events.iter().any(|event| matches!(event, LlmEvent::TextDelta(text) if text == "正常回复")));
}

/// 服务商不认识 `stream_options.include_usage`（400）时：去掉该字段重试一次，
/// 且本次调用内的后续请求不再带它（对齐 `OpenAiApi` 的 `includeStreamUsage` 闭包变量）。
#[test]
fn openai_stream_drops_stream_options_when_provider_rejects_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let counter = Arc::clone(&calls);
    let seen = Arc::clone(&bodies);
    let llm = FakeLlm::start_with_status(move |index, payload| {
        counter.fetch_add(1, Ordering::Relaxed);
        seen.lock().unwrap().push(payload.clone());
        if index == 0 {
            (400, "unknown field stream_options".to_string())
        } else {
            (200, openai_text_sse(&["去掉后成功"]))
        }
    });
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(
        &provider,
        &[json!({ "role": "user", "content": "hi" })],
        &[],
        false,
    );
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        calls.load(Ordering::Relaxed),
        2,
        "400 stream_options 应当去掉该字段重试一次"
    );
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies[0]["stream_options"], json!({ "include_usage": true }));
    assert!(
        bodies[1].get("stream_options").is_none(),
        "重试请求不应再带 stream_options: {}",
        bodies[1]
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, LlmEvent::TextDelta(text) if text == "去掉后成功")));
}

// ==================== 流式看门狗（streamTimeout.ts） ====================

#[test]
fn stream_watchdog_times_out_on_first_byte_and_retries_once() {
    // 服务端接受连接、返回 200 响应头与 SSE 注释心跳，然后静默挂住：
    // 注释行不算有效事件，首个有效事件超时后按独立预算重试一次。
    let (base_url, hits) = start_stalling_server(|_index, stream| {
        write_sse_headers(stream);
        use std::io::Write;
        stream.write_all(b": keep-alive\n\n").expect("write comment");
        stream.flush().expect("flush comment");
        std::thread::sleep(Duration::from_millis(800));
    });
    let provider = provider(&base_url, "OpenAI");
    let (result, events) = collect_with_timeouts(&provider, 200, 200);
    let error = result.expect_err("应当超时报错");
    assert!(
        error.contains("未收到任何有效输出事件"),
        "首字节超时文案不对: {error}"
    );
    assert!(
        error.contains("0s") || error.contains("1s"),
        "应带超时秒数: {error}"
    );
    // 首次 + 超时重试一次；重试前发 Reset 丢弃本轮输出
    assert_eq!(hits.load(Ordering::SeqCst), 2, "超时应只重试一次");
    assert!(events.iter().any(|event| matches!(event, LlmEvent::Reset)));
}

#[test]
fn stream_watchdog_does_not_treat_anthropic_ping_as_progress() {
    // Anthropic 的 `ping` 心跳不算进展（对齐 `isProgressEvent` 的 exclude=['ping']）：
    // 持续 ping 的网关不能无限期绕过首字节超时。
    let (base_url, hits) = start_stalling_server(|_index, stream| {
        write_sse_headers(stream);
        use std::io::Write;
        stream
            .write_all(b"event: ping\ndata: {\"type\":\"ping\"}\n\n")
            .expect("write ping");
        stream.flush().expect("flush ping");
        std::thread::sleep(Duration::from_millis(800));
    });
    let provider = provider(&base_url, "Anthropic");
    let (result, _events) = collect_with_timeouts(&provider, 200, 200);
    let error = result.expect_err("ping 不应算进展，应当超时");
    assert!(
        error.contains("未收到任何有效输出事件"),
        "ping 后的文案不对: {error}"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 2);
}

#[test]
fn stream_watchdog_times_out_after_idle_gap_and_retries_once() {
    // 已收到有效事件 → 切到空闲计时；随后停滞超过 idle 超时。
    let (base_url, hits) = start_stalling_server(|_index, stream| {
        write_sse_headers(stream);
        write_sse_event(
            stream,
            &json!({ "choices": [{ "delta": { "content": "部分" } }] }).to_string(),
        );
        std::thread::sleep(Duration::from_millis(800));
    });
    let provider = provider(&base_url, "OpenAI");
    let (result, _events) = collect_with_timeouts(&provider, 2000, 200);
    let error = result.expect_err("应当空闲超时");
    assert!(
        error.contains("流已停滞"),
        "空闲超时文案不对: {error}"
    );
    assert_eq!(hits.load(Ordering::SeqCst), 2, "空闲超时应只重试一次");
}

#[test]
fn stream_watchdog_resets_idle_timer_on_progress() {
    // 两条有效事件间隔小于 idle 超时 → 不误报；流正常结束后拿到全部增量。
    let (base_url, _hits) = start_stalling_server(|_index, stream| {
        write_sse_headers(stream);
        write_sse_event(
            stream,
            &json!({ "choices": [{ "delta": { "content": "hi" } }] }).to_string(),
        );
        std::thread::sleep(Duration::from_millis(100));
        write_sse_event(
            stream,
            &json!({ "choices": [{ "delta": { "content": "ho" } }] }).to_string(),
        );
        write_sse_event(stream, "[DONE]");
        // 连接在脚本结束后关闭（无 Content-Length，靠 EOF 收尾）
    });
    let provider = provider(&base_url, "OpenAI");
    let (result, events) = collect_with_timeouts(&provider, 500, 500);
    assert!(result.is_ok(), "不应误报超时: {result:?}");
    assert_eq!(text_of(&events), "hiho");
}

// ==================== 内容块边界（block_start / block_stop / message_delta） ====================

/// 把事件流里的块边界事件抽成可读序列
fn block_boundaries(events: &[LlmEvent]) -> Vec<&'static str> {
    events
        .iter()
        .filter_map(|event| match event {
            LlmEvent::BlockStart(BlockKind::Thinking) => Some("start:thinking"),
            LlmEvent::BlockStart(BlockKind::Text) => Some("start:text"),
            LlmEvent::BlockStart(BlockKind::ToolUse) => Some("start:tool_use"),
            LlmEvent::BlockStop => Some("stop"),
            LlmEvent::MessageDelta => Some("message_delta"),
            _ => None,
        })
        .collect()
}

#[test]
fn anthropic_stream_emits_block_boundaries() {
    // Anthropic 的块边界直接来自 `content_block_start` / `content_block_stop`
    let llm = FakeLlm::fixed(anthropic_sse("想一想", "完成", None));
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        block_boundaries(&events),
        vec!["start:thinking", "stop", "start:text", "stop", "message_delta"]
    );
}

#[test]
fn anthropic_stream_emits_a_tool_use_block() {
    let llm = FakeLlm::fixed(anthropic_sse("想一想", "", Some(("toolu_1", "Read", "{}"))));
    let provider = provider(&llm.base_url, "Anthropic");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], true);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        block_boundaries(&events),
        vec![
            "start:thinking",
            "stop",
            "start:tool_use",
            "stop",
            "message_delta",
        ]
    );
}

#[test]
fn openai_stream_synthesizes_block_boundaries() {
    // Chat Completions 没有显式块边界：适配器在角色切换时补 block_stop + block_start，
    // 流结束时再关掉仍打开的块（对齐 Embedded `OpenAiApi` 的 `emitBlockStop()`）。
    let llm = FakeLlm::fixed(openai_thinking_sse("想", "答"));
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        block_boundaries(&events),
        vec!["start:thinking", "stop", "start:text", "stop", "message_delta"]
    );
}

#[test]
fn openai_tool_calls_get_their_own_block() {
    let llm = FakeLlm::fixed(openai_tool_sse("call_1", "Bash", r#"{"command":"ls"}"#));
    let provider = provider(&llm.base_url, "OpenAI");
    let (result, events) = collect(&provider, &[json!({ "role": "user", "content": "hi" })], &[], false);
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(
        block_boundaries(&events),
        vec!["start:tool_use", "stop", "message_delta"]
    );
}

//! Responses API 的流式端到端用例（假 Responses 服务）。
//!
//! 纯函数对等由 `responses_tests.rs` 覆盖；这里验证 SSE 状态机本身。

use serde_json::json;
use serde_json::Value;

use crate::config::ProviderConfig;
use crate::llm::{
    stream, BlockKind, LlmEvent, LlmRequest, DEFAULT_FIRST_BYTE_TIMEOUT_MS,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS,
};
use crate::test_support::{responses_text_sse, responses_thinking_tool_sse, FakeLlm};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

fn provider() -> ProviderConfig {
    ProviderConfig {
        api_key: "sk-test".to_string(),
        // 占位：`collect` 会换成假服务地址
        base_url: "http://127.0.0.1:1".to_string(),
        model: "test-model".to_string(),
        api_type: "Responses".to_string(),
        max_tokens: 1024,
        thinking_budget_tokens: 256,
        thinking_effort: "high".to_string(),
        context_window: 1024 * 1024,
        web_search: false,
        multimodal: true,
    }
}

/// 起一个假 Responses 服务，跑一次 `stream`，返回事件列表
fn collect(body: String) -> (Result<(), String>, Vec<LlmEvent>) {
    let llm = FakeLlm::fixed(body);
    let mut provider = provider();
    provider.base_url = llm.base_url.clone();
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "你是助手",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "sess-responses",
        thinking_enabled: true,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    let result = stream(&request, &mut |event| events.push(event));
    (result, events)
}

fn text_of(events: &[LlmEvent]) -> String {
    let mut text = String::new();
    for event in events {
        if let LlmEvent::TextDelta(delta) = event {
            text.push_str(delta);
        }
    }
    text
}

fn thinking_of(events: &[LlmEvent]) -> String {
    let mut thinking = String::new();
    for event in events {
        if let LlmEvent::ThinkingDelta(delta) = event {
            thinking.push_str(delta);
        }
    }
    thinking
}

fn authoritative(events: &[LlmEvent]) -> Option<Vec<Value>> {
    events.iter().find_map(|event| match event {
        LlmEvent::AuthoritativeBlocks(blocks) => Some(blocks.clone()),
        _ => None,
    })
}

#[test]
fn responses_stream_emits_text_usage_and_stop_reason() {
    let (result, events) = collect(responses_text_sse(&["你好", "，世界"]));
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(text_of(&events), "你好，世界");

    // `completed` → `end_turn`
    assert!(
        events
            .iter()
            .any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "end_turn")),
        "events: {events:?}"
    );

    let usage = events
        .iter()
        .find_map(|event| match event {
            LlmEvent::Usage(usage) => Some(usage.clone()),
            _ => None,
        })
        .expect("应当有 usage 事件");
    assert_eq!(usage.input_tokens, 11);
    assert_eq!(usage.output_tokens, 22);
    assert_eq!(usage.cache_read_input_tokens, Some(5));
    assert_eq!(usage.reasoning_tokens, Some(3));

    // 块边界：text 块 start / stop 各一次
    assert!(events
        .iter()
        .any(|event| matches!(event, LlmEvent::BlockStart(BlockKind::Text))));
    assert!(events
        .iter()
        .any(|event| matches!(event, LlmEvent::BlockStop)));
    // 终止事件里给出的权威输出会整体覆盖（内容一致，因此文本不变）
    assert!(authoritative(&events).is_some());
    assert!(events
        .iter()
        .any(|event| matches!(event, LlmEvent::MessageDelta)));
}

#[test]
fn responses_stream_emits_thinking_and_tool_call() {
    let arguments = r#"{"command":"echo hi"}"#;
    let (result, events) = collect(responses_thinking_tool_sse(
        "想一想", "好的", "call_1", "Bash", arguments,
    ));
    assert!(result.is_ok(), "got {result:?}");
    assert_eq!(thinking_of(&events), "想一想");
    assert_eq!(text_of(&events), "好的");

    let mut tool_id = None;
    let mut tool_name = None;
    let mut tool_input = String::new();
    for event in &events {
        match event {
            LlmEvent::ToolUseStart { id, name, .. } => {
                tool_id = Some(id.clone());
                tool_name = Some(name.clone());
            }
            LlmEvent::ToolUseInputDelta(delta) => tool_input.push_str(delta),
            _ => {}
        }
    }
    assert_eq!(tool_id.as_deref(), Some("call_1"));
    assert_eq!(tool_name.as_deref(), Some("Bash"));
    assert_eq!(tool_input, arguments);

    // 权威输出覆盖后 tool_use 仍在（顺序：reasoning → text → function_call）
    let blocks = authoritative(&events).expect("应当有权威输出");
    let kinds: Vec<&str> = blocks
        .iter()
        .filter_map(|block| block.get("type").and_then(Value::as_str))
        .collect();
    assert_eq!(kinds, vec!["thinking", "text", "tool_use"]);
    assert_eq!(blocks[0]["thinking"], "想一想");
    assert_eq!(blocks[1]["text"], "好的");
    assert_eq!(blocks[2]["name"], "Bash");
    assert_eq!(blocks[2]["input"]["command"], "echo hi");
}

/// 服务端只发终止事件、不发任何 `*_delta`：内容由 `response.output` 兜底
#[test]
fn responses_stream_recovers_content_from_terminal_event_only() {
    let body = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": { "type": "message" },
        }),
        json!({
            "type": "response.completed",
            "response": {
                "id": "resp_3",
                "status": "completed",
                "output": [{
                    "id": "msg_3",
                    "type": "message",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "只有终止事件" }],
                }],
                "usage": { "input_tokens": 1, "output_tokens": 2 },
            },
        })
    );
    let (result, events) = collect(body);
    assert!(result.is_ok(), "got {result:?}");
    let blocks = authoritative(&events).expect("应当有权威输出");
    assert_eq!(blocks[0]["text"], "只有终止事件");
    // 没有任何 delta 事件
    assert!(events
        .iter()
        .all(|event| !matches!(event, LlmEvent::TextDelta(_))));
}

/// `response.failed` → 致命错误，文案逐字锁定
#[test]
fn responses_stream_reports_failed_response() {
    let body = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({
            "type": "response.failed",
            "response": { "id": "resp_4", "status": "failed", "error": { "message": "boom" } },
        })
    );
    let (result, _events) = collect(body);
    assert_eq!(result, Err("Responses API failed: boom".to_string()));
}

/// `incomplete` + `max_output_tokens` → `max_tokens`
#[test]
fn responses_stream_maps_incomplete_max_tokens() {
    let body = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({
            "type": "response.incomplete",
            "response": {
                "id": "resp_5",
                "status": "incomplete",
                "incomplete_details": { "reason": "max_output_tokens" },
                "output": [{
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "截断" }],
                }],
                "usage": { "input_tokens": 5, "output_tokens": 6 },
            },
        })
    );
    let (result, events) = collect(body);
    assert!(result.is_ok(), "got {result:?}");
    assert!(
        events
            .iter()
            .any(|event| matches!(event, LlmEvent::StopReason(reason) if reason == "max_tokens")),
        "events: {events:?}"
    );
}

/// 请求体：`input` / `instructions` / `reasoning.effort` / 工具转换
#[test]
fn responses_request_body_matches_the_protocol() {
    let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = std::sync::Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        responses_text_sse(&["ok"])
    });
    let mut provider = provider();
    provider.base_url = llm.base_url.clone();
    let tools = vec![json!({
        "name": "Bash",
        "description": "Execute Bash",
        "input_schema": { "type": "object", "properties": {} },
    })];
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "SYS",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &tools,
        session_id: "sess-body",
        thinking_enabled: true,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    assert!(stream(&request, &mut |event| events.push(event)).is_ok());

    let body = bodies.lock().unwrap().pop().expect("应当收到请求");
    assert_eq!(body["model"], "test-model");
    assert_eq!(body["stream"], true);
    assert_eq!(body["max_output_tokens"], 1024);
    assert_eq!(body["temperature"], 1.0);
    assert_eq!(body["top_p"], 0.95);
    assert_eq!(body["instructions"], "SYS");
    assert_eq!(body["reasoning"]["effort"], "high");
    assert_eq!(body["input"][0]["role"], "user");
    assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "Bash");
    assert_eq!(body["tools"][0]["parameters"]["type"], "object");
    // 已知缺口：不下发内置 web_search
    assert!(
        body["tools"]
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["type"] != "web_search"),
        "不应下发 web_search: {}",
        body["tools"]
    );
}

/// `thinkingEffort = 'off'` → 显式传 `reasoning.effort = 'none'`；
/// 空 system prompt 不下发 `instructions`；无工具不下发 `tools`
#[test]
fn responses_request_maps_off_to_none() {
    let bodies: std::sync::Arc<std::sync::Mutex<Vec<Value>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = std::sync::Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        responses_text_sse(&["ok"])
    });
    let mut provider = provider();
    provider.base_url = llm.base_url.clone();
    provider.thinking_effort = "off".to_string();
    let cancel = AtomicBool::new(false);
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "sess-off",
        thinking_enabled: false,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    assert!(stream(&request, &mut |event| events.push(event)).is_ok());
    let body = bodies.lock().unwrap().pop().expect("应当收到请求");
    assert_eq!(body["reasoning"]["effort"], "none");
    assert!(body.get("instructions").is_none());
    assert!(body.get("tools").is_none());
}

/// 用户主动取消（abort）：流是本端提前掐断的，服务端不会补终止事件——这不是
/// 「截断」，不得走重试 / 报错路径，也不得补发 `message_delta`
/// 。
#[test]
fn responses_stream_abort_is_not_a_truncation_error() {
    let cancel = Arc::new(AtomicBool::new(false));
    let canceller = Arc::clone(&cancel);
    // 分段写：先写一个未完成的 output_item，在两次写之间置位 cancel（模拟用户点
    // abort），再写后续事件——此时服务端永远不会补 `response.completed`。
    let llm = FakeLlm::start_gated(
        |_index, _body| {
            let first = format!(
                "data: {}\n\n",
                json!({
                    "type": "response.output_item.added",
                    "item": { "type": "reasoning", "id": "rs_1", "summary": [] },
                })
            );
            let second = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({ "type": "response.output_text.delta", "delta": "取消后不应到达" })
            );
            (first, second)
        },
        move || canceller.store(true, Ordering::Relaxed),
    );
    let mut provider = provider();
    provider.base_url = llm.base_url.clone();
    let request = LlmRequest {
        provider: &provider,
        system_prompt: "你是助手",
        messages: &[json!({ "role": "user", "content": "hi" })],
        tools: &[],
        session_id: "sess-abort",
        thinking_enabled: true,
        cancel: &cancel,
        first_byte_timeout_ms: DEFAULT_FIRST_BYTE_TIMEOUT_MS,
        idle_timeout_ms: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    };
    let mut events: Vec<LlmEvent> = Vec::new();
    let result = stream(&request, &mut |event| events.push(event));
    assert!(result.is_ok(), "取消不应报错：{result:?}");
    assert!(text_of(&events).is_empty(), "取消后不应再产出内容：{events:?}");
    assert!(
        events
            .iter()
            .all(|event| !matches!(event, LlmEvent::MessageDelta)),
        "取消时不得补发 message_delta：{events:?}"
    );
}

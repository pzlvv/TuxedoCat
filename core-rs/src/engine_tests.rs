//! `engine` 的单元测试：消息组装、会话状态、事件时序、以及走假 LLM 的完整轮次。

use super::*;
use crate::test_support::{
    anthropic_sse, minimal_png_bytes, openai_text_sse, openai_tool_sse, EngineHarness, FakeLlm,
    Sandbox,
};
use serde_json::json;
use std::sync::Arc;

/// 让 `resolve_provider` 指向假 LLM，并登记活动工作目录
fn prepare(sandbox: &Sandbox, base_url: &str, agent_mode: &str) {
    sandbox.write_llm_settings(base_url, agent_mode);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
}

fn submit(harness: &EngineHarness, session_id: &str, content: &str, uuid: &str) {
    harness.core.on_user_message(&json!({
        "sessionId": session_id,
        "content": content,
        "uuid": uuid,
        "workspacePath": null,
    }));
}

// ==================== 消息组装 ====================

#[test]
fn tool_use_block_parses_json_arguments() {
    let block = tool_use_block("call_1", "Bash", r#"{"command":"ls"}"#, &json!({}));
    assert_eq!(block["type"], "tool_use");
    assert_eq!(block["id"], "call_1");
    assert_eq!(block["name"], "Bash");
    assert_eq!(block["input"]["command"], "ls");
}

#[test]
fn tool_use_block_falls_back_to_empty_input_on_broken_json() {
    // 流式参数被截断时不能丢工具调用，只是入参退化为初始 input（缺省空对象）
    let block = tool_use_block("call_1", "Bash", "{\"command\":", &json!({}));
    assert_eq!(block["input"], json!({}));
}

#[test]
fn tool_use_block_keeps_content_block_start_input_without_delta() {
    // 没有 input_json_delta 时用 content_block_start 的初始 input；
    // 解析失败时同样回退到初始 input。
    let initial = json!({ "command": "echo hi" });
    let block = tool_use_block("call_1", "Bash", "", &initial);
    assert_eq!(block["input"], initial);
    let block = tool_use_block("call_1", "Bash", "{broken", &initial);
    assert_eq!(block["input"], initial);
}

#[test]
fn build_user_message_carries_uuid_timestamp_and_editor_context() {
    let message = build_user_message(&json!({
        "content": "看看这个文件",
        "uuid": "u-1",
        "filePath": "src/a.ts",
        "fileSelectedLines": { "start": 1, "end": 3 },
        "fileHidden": false,
        "unrelated": "ignored",
    }));
    assert_eq!(message["type"], "user");
    assert_eq!(message["uuid"], "u-1");
    assert_eq!(message["message"]["role"], "user");
    assert_eq!(message["message"]["content"], "看看这个文件");
    assert_eq!(message["_userInitiated"], true);
    assert_eq!(message["filePath"], "src/a.ts");
    assert_eq!(message["fileSelectedLines"]["start"], 1);
    // fileHidden 只在 true 时落盘
    assert!(message.get("fileHidden").is_none());
    // 文件信息同时写入 _meta（含展示用 param），保证历史加载能还原文件标签
    assert_eq!(message["_meta"]["filePath"], "src/a.ts");
    assert_eq!(message["_meta"]["param"], "a.ts:1~3");
    assert_eq!(message["_meta"]["fileSelectedLines"]["end"], 3);
    assert!(message.get("unrelated").is_none());
    assert!(message["timestamp"].as_u64().unwrap() > 1_600_000_000_000);
}

#[test]
fn build_user_message_generates_uuid_and_skips_null_fields() {
    let message = build_user_message(&json!({
        "content": "hi",
        "filePath": Value::Null,
        "fileSelectedLines": Value::Null,
        "fileHidden": Value::Null,
    }));
    let uuid = message["uuid"].as_str().unwrap();
    assert!(uuid.starts_with("user_"), "got {uuid}");
    assert!(message.get("filePath").is_none());
    assert!(message.get("fileSelectedLines").is_none());
    assert!(message.get("fileHidden").is_none());
    // 缺 content 时退化为空串而不是报错
    assert_eq!(build_user_message(&json!({}))["message"]["content"], "");
}

#[test]
fn build_user_message_attaches_images_as_content_blocks() {
    let message = build_user_message(&json!({
        "content": "看图",
        "uuid": "u-2",
        "images": [
            { "dataUrl": "data:image/png;base64,AAAA" },
            { "dataUrl": "data:image/jpeg;base64,BBBB" },
            { "noDataUrl": true }
        ]
    }));
    let blocks = message["message"]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0], json!({ "type": "text", "text": "看图" }));
    assert_eq!(blocks[1]["type"], "image");
    assert_eq!(blocks[1]["source"]["media_type"], "image/png");
    assert_eq!(blocks[1]["source"]["data"], "AAAA");
    assert_eq!(blocks[2]["source"]["media_type"], "image/jpeg");

    // 全部图片都不可解析时保留纯文本形态
    let plain = build_user_message(&json!({ "content": "hi", "images": [{ "broken": 1 }] }));
    assert_eq!(plain["message"]["content"], "hi");

    let empty = build_user_message(&json!({ "content": "hi", "images": [] }));
    assert_eq!(empty["message"]["content"], "hi");
}

#[test]
fn build_user_message_skips_falsy_file_path_and_data_url() {
    // 空串 filePath / 空串 dataUrl 都是假值，不落盘、也不产出 image block。
    let message = build_user_message(&json!({
        "content": "hi",
        "filePath": "",
        "fileSelectedLines": { "start": 1, "end": 1 },
        "images": [
            { "dataUrl": "" },
            { "dataUrl": "data:image/png;base64,AAAA" }
        ]
    }));
    assert!(message.get("filePath").is_none());
    // fileSelectedLines 仍然落盘（与 filePath 独立判定）
    assert_eq!(message["fileSelectedLines"]["start"], 1);
    // `_meta` 里不应出现空 filePath / param（fileSelectedLines 仍按真值判定落盘）
    assert!(message["_meta"].get("filePath").is_none());
    assert!(message["_meta"].get("param").is_none());
    assert_eq!(message["_meta"]["fileSelectedLines"]["end"], 1);
    let blocks = message["message"]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0], json!({ "type": "text", "text": "hi" }));
    assert_eq!(blocks[1]["source"]["data"], "AAAA");

    // 只有空 dataUrl 的图片 → 保留纯文本形态
    let plain = build_user_message(&json!({ "content": "hi", "images": [{ "dataUrl": "" }] }));
    assert_eq!(plain["message"]["content"], "hi");
}

#[test]
fn split_data_url_handles_missing_prefix_and_base64_marker() {
    assert_eq!(
        split_data_url("data:image/png;base64,AAAA"),
        ("image/png".to_string(), "AAAA".to_string())
    );
    // 没有 `data:` 前缀：不匹配正则，整串当纯 base64、类型兜底 png（对齐 parseDataUrl）
    assert_eq!(
        split_data_url("image/webp;base64,BBBB"),
        ("image/png".to_string(), "image/webp;base64,BBBB".to_string())
    );
    // 没有 ;base64, 分隔符：整串当数据，类型按 png
    assert_eq!(
        split_data_url("CCCC"),
        ("image/png".to_string(), "CCCC".to_string())
    );
}

#[test]
fn build_assistant_message_orders_thinking_text_and_tool_uses() {
    let tools = vec![tool_use_block("call_1", "Bash", r#"{"command":"ls"}"#, &json!({}))];
    let message = build_assistant_message(
        "正文",
        "思考",
        "sig-1",
        &tools,
        "end_turn",
        &llm::Usage {
            input_tokens: 10,
            output_tokens: 5,
            ..Default::default()
        },
    );
    assert_eq!(message["type"], "assistant");
    assert_eq!(message["message"]["role"], "assistant");
    assert_eq!(message["message"]["stop_reason"], "end_turn");
    assert_eq!(message["message"]["usage"]["input_tokens"], 10);
    assert_eq!(message["message"]["usage"]["output_tokens"], 5);
    let blocks = message["message"]["content"].as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["type"], "thinking");
    assert_eq!(blocks[0]["thinking"], "思考");
    // 思考签名必须随历史 thinking block 原样保留
    assert_eq!(blocks[0]["signature"], "sig-1");
    assert_eq!(blocks[1]["type"], "text");
    assert_eq!(blocks[2]["type"], "tool_use");
    // tool_use block 顶层记录调用时间戳
    assert!(blocks[2]["_meta"]["toolCallTimestamp"].as_u64().is_some());
    assert!(message["uuid"].as_str().unwrap().starts_with("assistant_"));
}

#[test]
fn build_assistant_message_skips_empty_sections() {
    let message = build_assistant_message("", "", "", &[], "", &llm::Usage::default());
    assert_eq!(message["message"]["content"], json!([]));
    assert!(message["message"].get("stop_reason").is_none());
    // usage 恒存在且恒带四个键（`{0,0,0,0}` 兜底）
    assert_eq!(
        message["message"]["usage"],
        json!({
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        })
    );
}

#[test]
fn message_text_flattens_string_and_block_contents() {
    assert_eq!(message_text(&json!({ "message": { "content": "纯文本" } })), "纯文本");
    assert_eq!(
        message_text(&json!({ "message": { "content": [
            { "type": "text", "text": "第一行" },
            { "type": "image", "source": {} },
            { "type": "text", "text": "第二行" }
        ] } })),
        "第一行\n第二行"
    );
    assert_eq!(message_text(&json!({})), "");
    assert_eq!(message_text(&json!({ "message": { "content": 42 } })), "");
}

#[test]
fn build_llm_messages_keeps_only_conversation_turns() {
    let state = Arc::new(Mutex::new(SessionState::new("risk".to_string(), None)));
    {
        let mut state = state.lock().unwrap();
        state.messages = vec![
            json!({ "type": "user", "message": { "role": "user", "content": "问题" } }),
            json!({ "type": "stream_event", "message": { "role": "user", "content": "丢弃" } }),
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "call_1", "name": "Bash", "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "call_1", "content": "输出" }
            ] } }),
            json!({ "type": "user" }),
            json!({ "message": { "role": "user", "content": "没有 type" } }),
        ];
    }
    let messages = build_llm_messages(&state);
    assert_eq!(messages.len(), 3, "got {messages:?}");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
    // 缺少 thinking block 的 assistant 消息会补一个空 thinking（对齐 ensureThinkingBlocks）
    assert_eq!(messages[1]["content"][0]["type"], "thinking");
    assert_eq!(messages[1]["content"][0]["thinking"], "");
    assert_eq!(messages[1]["content"][1]["type"], "tool_use");
    assert_eq!(messages[2]["content"][0]["tool_use_id"], "call_1");
}

#[test]
fn build_llm_messages_strips_ui_only_block_fields() {
    // `_meta` / `beforeContent` 等只服务 UI，不能进请求载荷
    // （`beforeContent` 可能是整份文件内容，会把上下文撑大若干倍）
    let state = Arc::new(Mutex::new(SessionState::new("risk".to_string(), None)));
    {
        let mut state = state.lock().unwrap();
        state.messages = vec![
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "call_1", "name": "Edit",
                  "_meta": { "toolCallTimestamp": 1, "confirmTimestamp": 2 },
                  "input": {} }
            ] } }),
            json!({ "type": "user", "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "call_1", "content": "ok",
                  "beforeContent": "整份文件内容", "afterContent": "改后", "_partialJson": "{}" }
            ] } }),
        ];
    }
    let messages = build_llm_messages(&state);
    let tool_use = &messages[0]["content"][1];
    assert_eq!(tool_use["type"], "tool_use");
    assert!(tool_use.get("_meta").is_none(), "got {tool_use:?}");
    let tool_result = &messages[1]["content"][0];
    assert!(tool_result.get("beforeContent").is_none(), "got {tool_result:?}");
    assert!(tool_result.get("afterContent").is_none(), "got {tool_result:?}");
    assert!(tool_result.get("_partialJson").is_none(), "got {tool_result:?}");
    assert_eq!(tool_result["content"], "ok");
}

#[test]
fn build_raw_api_messages_prefixes_current_file_context() {
    let messages = build_raw_api_messages(&[
        json!({ "type": "user", "filePath": "src/a.ts",
                "fileSelectedLines": { "start": 3, "end": 3 },
                "message": { "role": "user", "content": "看看这里" } }),
        json!({ "type": "user", "filePath": "src/b.ts",
                "fileSelectedLines": { "start": 1, "end": 4 },
                "message": { "role": "user", "content": "选中多行" } }),
        json!({ "type": "user", "filePath": "src/c.ts",
                "message": { "role": "user", "content": "整份文件" } }),
        json!({ "type": "user", "filePath": "src/d.ts", "fileHidden": true,
                "message": { "role": "user", "content": "隐藏文件" } }),
        json!({ "type": "user", "filePath": "src/e.ts",
                "message": { "role": "user", "content": "[Current File: src/e.ts]\n\n已有前缀" } }),
        // 文件信息挂在 assistant 上时（历史脏数据）不加前缀
        json!({ "type": "assistant", "filePath": "src/f.ts",
                "message": { "role": "assistant", "content": "回答" } }),
        // filePath 为空串（JS 假值）时不加前缀
        json!({ "type": "user", "filePath": "",
                "message": { "role": "user", "content": "空路径" } }),
    ]);
    assert_eq!(
        messages[0]["content"],
        "[Current File: src/a.ts (line 3)]\n\n看看这里"
    );
    assert_eq!(
        messages[1]["content"],
        "[Current File: src/b.ts (lines 1-4)]\n\n选中多行"
    );
    assert_eq!(messages[2]["content"], "[Current File: src/c.ts]\n\n整份文件");
    // fileHidden 为 true 时不加前缀
    assert_eq!(messages[3]["content"], "隐藏文件");
    // 已有前缀时不重复添加
    assert_eq!(messages[4]["content"], "[Current File: src/e.ts]\n\n已有前缀");
    assert_eq!(messages[5]["content"], "回答");
    // filePath 为空串时不加前缀
    assert_eq!(messages[6]["content"], "空路径");
}

#[test]
fn build_raw_api_messages_skips_once_notices() {
    // 一次性通知只记 meta.json（`docs/hosts/webview-ui.md` 第 11 节），不进消息列表；
    // 即使误入列表也不得进 LLM 上下文——组装只收 user / assistant。
    let messages = build_raw_api_messages(&[
        json!({ "type": "user", "message": { "role": "user", "content": "问题" } }),
        json!({ "type": "system", "content": "*User Interrupted*", "once": true }),
        json!({ "type": "assistant", "message": { "role": "assistant", "content": "回答" } }),
    ]);
    assert_eq!(messages.len(), 2, "system 通知不得进上下文：{messages:?}");
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[1]["role"], "assistant");
}

#[test]
fn build_llm_messages_merges_consecutive_same_role_messages() {
    // Anthropic 要求严格 user/assistant 交替：连续同角色的多条 tool_result 必须合并
    let state = Arc::new(Mutex::new(SessionState::new("risk".to_string(), None)));
    {
        let mut state = state.lock().unwrap();
        state.messages = vec![
            json!({ "type": "user", "message": { "role": "user", "content": "问题" } }),
            json!({ "type": "user", "message": { "role": "user", "content": "追加问题" } }),
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [
                { "type": "text", "text": "回答" }
            ] } }),
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "call_1", "name": "Bash", "input": {} }
            ] } }),
        ];
    }
    let messages = build_llm_messages(&state);
    assert_eq!(messages.len(), 2, "got {messages:?}");
    // 两条 user 的字符串 content 各自包成 text block 后合并
    assert_eq!(
        messages[0]["content"],
        json!([
            { "type": "text", "text": "问题" },
            { "type": "text", "text": "追加问题" },
        ])
    );
    assert_eq!(messages[1]["role"], "assistant");
    // 补空 thinking 在合并之前，因此合并结果里每条原消息各带一个 thinking
    assert_eq!(messages[1]["content"][0]["type"], "thinking");
    assert_eq!(messages[1]["content"][1]["text"], "回答");
    assert_eq!(messages[1]["content"][2]["type"], "thinking");
    assert_eq!(messages[1]["content"][3]["type"], "tool_use");
}

#[test]
fn collect_fence_languages_scans_string_and_block_contents() {
    // 字符串 content：去重、忽略非围栏行、忽略超长语言标识符
    let languages = collect_fence_languages(&json!({
        "type": "assistant",
        "message": { "role": "assistant", "content":
            "说明\n```ts\nconst a = 1;\n```\n再一段\n  ~~~python\nprint(1)\n~~~\n```\n```rust\n```\n行内 ```js 不算\n" },
    }));
    assert_eq!(languages, vec!["ts", "python", "rust"]);

    // 数组 content：text / thinking / tool_result 都扫，其他 block 忽略
    let languages = collect_fence_languages(&json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": [
            { "type": "thinking", "thinking": "```go\n" },
            { "type": "text", "text": "```js\n" },
            { "type": "tool_use", "id": "c1", "name": "Bash", "input": { "command": "```bash" } },
            { "type": "tool_result", "tool_use_id": "c1", "content": "```sh\n" },
            { "type": "text", "text": "```averyveryverylonglanguagename0123456789\n" },
        ] },
    }));
    assert_eq!(languages, vec!["go", "js", "sh"]);

    // Read 输出的行号前缀（`N|```ts`）不算围栏开头
    assert!(collect_fence_languages(&json!({
        "type": "user",
        "message": { "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": "c1", "content": "12|```ts\n" }
        ] },
    }))
    .is_empty());

    // 非 user / assistant 消息不扫
    assert!(collect_fence_languages(&json!({
        "type": "system",
        "message": { "role": "user", "content": "```ts\n" },
    }))
    .is_empty());
}

#[test]
fn highlight_languages_reports_every_message_without_deduping_or_writing() {
    // Core 只上报「本条消息用到了哪些语言」：不维护「已记录」集合、也不写 settings.json。
    // `highlightLanguages` 是 UI 专属字段，去重与落盘由宿主的 `highlightLanguagesMutator`
    // 承担（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
    let sandbox = Sandbox::new("engine-highlight-languages");
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "看这段
```ts
const a = 1;
```", "u-1");
    assert!(harness.wait_query_end());

    let events = harness.sink.events_of("highlightLanguagesUsed");
    assert_eq!(events.len(), 1, "got {:?}", harness.sink.event_types());
    assert_eq!(events[0]["languages"], json!(["ts"]));
    // 事件不带 sessionId（对齐 AssistantEventBus 的声明）
    assert!(events[0].get("sessionId").is_none(), "got {}", events[0]);
    // Core 不落盘
    assert!(
        sandbox.read_settings().get("highlightLanguages").is_none(),
        "Core 不应写 highlightLanguages：{:?}",
        sandbox.read_settings()
    );

    // 同一门语言再次出现仍会上报（去重是宿主的事，宿主按幂等处理）
    let harness = EngineHarness::allow_all();
    submit(&harness, "s2", "再看
```ts
const b = 2;
```", "u-2");
    assert!(harness.wait_query_end());
    let events = harness.sink.events_of("highlightLanguagesUsed");
    assert_eq!(events.len(), 1, "got {:?}", harness.sink.event_types());
    assert_eq!(events[0]["languages"], json!(["ts"]));
}

// ==================== 会话状态 ====================

#[test]
fn session_state_reports_idle_only_without_work() {
    let mut state = SessionState::new("risk".to_string(), None);
    assert!(state.is_idle());

    state.running = true;
    assert!(!state.is_idle());
    state.running = false;
    state.waiting = true;
    assert!(!state.is_idle());
    state.waiting = false;
    state.pending_user_message = Some(json!({}));
    assert!(!state.is_idle());
}

#[test]
fn sessions_are_created_on_demand_and_can_be_dropped() {
    let sandbox = Sandbox::new("engine-sessions");
    sandbox.write_settings(json!({ "defaultAgentMode": "manual" }));
    let harness = EngineHarness::allow_all();

    assert!(harness.core.session_if_exists("s1").is_none());
    let state = harness.core.session("s1");
    assert_eq!(state.lock().unwrap().agent_mode, "manual", "默认模式来自 settings.json");
    assert!(harness.core.session_if_exists("s1").is_some());
    // 同一个会话拿到同一个实例
    assert!(Arc::ptr_eq(&state, &harness.core.session("s1")));

    harness.core.drop_session("s1");
    assert!(harness.core.session_if_exists("s1").is_none());
    // 删除不存在的会话是空操作
    harness.core.drop_session("s1");
}

#[test]
fn project_of_prefers_session_then_metadata_then_active_workspace() {
    let sandbox = Sandbox::new("engine-project");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let harness = EngineHarness::allow_all();

    // 都没有 → 报错
    assert!(harness.core.project_of("s1").is_err());

    // 活动工作目录兜底
    config::set_active_workspace(Some(workspace.clone()));
    assert_eq!(harness.core.project_of("s1").unwrap(), workspace);

    // meta.json 里的 project 优先于活动工作目录
    history::create_conversation(
        "s1",
        "D:/from-meta",
        json!({ "sessionId": "s1", "project": "D:/from-meta" }),
    )
    .unwrap();
    assert_eq!(harness.core.project_of("s1").unwrap(), "D:/from-meta");

    // 会话运行时状态最优先
    harness.core.session("s1").lock().unwrap().project = Some("D:/from-state".to_string());
    assert_eq!(harness.core.project_of("s1").unwrap(), "D:/from-state");
}

#[test]
fn workspace_and_host_environment_updates_are_recorded() {
    let sandbox = Sandbox::new("engine-env");
    let harness = EngineHarness::allow_all();

    harness.core.on_workspace_changed(Some(sandbox.workspace.to_string_lossy().to_string()));
    assert_eq!(config::project_root("s1").unwrap(), sandbox.workspace.to_string_lossy());

    harness.core.on_host_environment(config::HostEnvironment {
        extension_path: "D:/ext".to_string(),
        log_to_console: true,
        config_dir_name: sandbox.config_dir_name.clone(),
    });
    assert_eq!(config::host_environment().unwrap().extension_path, "D:/ext");
    // 会创建 conversations 目录并记一条日志
    assert!(config::conversations_root().unwrap().is_dir());
    let log = harness.sink.event_of("log").expect("log event");
    assert!(
        log["message"].as_str().unwrap().contains("Standalone Core ready"),
        "got {log}"
    );

    harness.core.on_workspace_changed(None);
    assert!(config::project_root("s1").is_err());
}

#[test]
fn emit_runtime_reports_idle_and_waiting_flags() {
    let sandbox = Sandbox::new("engine-runtime");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace));
    let harness = EngineHarness::allow_all();

    let state = harness.core.session("s1");
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    assert_eq!(runtime["states"][0]["sessionId"], "s1");
    assert_eq!(runtime["states"][0]["idle"], true);
    assert_eq!(runtime["states"][0]["waiting"], false);
    // 根事实与派生 idle 一起进快照
    assert_eq!(runtime["states"][0]["queryRunning"], false);
    assert_eq!(runtime["states"][0]["compacting"], false);
    assert_eq!(runtime["states"][0]["backgroundRunning"], false);
    assert_eq!(runtime["states"][0]["subAgentRunning"], false);

    state.lock().unwrap().waiting = true;
    harness.sink.clear();
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    assert_eq!(runtime["states"][0]["idle"], false);
    assert_eq!(runtime["states"][0]["waiting"], true);
}

/// 快照按根事实分列：查询 / 压缩各自驱动 `idle`，子代理非 idle 时父会话的
/// `subAgentRunning` 为真（`docs/features/abort-button.md` FR-001）。
#[test]
fn emit_runtime_reports_root_facts_and_busy_subagents() {
    let sandbox = Sandbox::new("engine-runtime-facts");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace));
    crate::subagent::reset_for_test();
    let harness = EngineHarness::allow_all();

    let parent = harness.core.session("p1");
    parent.lock().unwrap().running = true;
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    let entry = &runtime["states"][0];
    assert_eq!(entry["queryRunning"], true);
    assert_eq!(entry["compacting"], false);
    assert_eq!(entry["backgroundRunning"], false);
    assert_eq!(entry["subAgentRunning"], false);
    assert_eq!(entry["idle"], false);

    // 父自身停下，只留一个非 idle 子代理：queryRunning=false、subAgentRunning=true
    parent.lock().unwrap().running = false;
    let child = harness.core.session("c1");
    child.lock().unwrap().running = true;
    child.lock().unwrap().parent_session_id = Some("p1".to_string());
    crate::subagent::register("c1", "p1");
    harness.sink.clear();
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    let states = runtime["states"].as_array().unwrap();
    let parent_entry = states
        .iter()
        .find(|state| state["sessionId"] == "p1")
        .expect("parent entry");
    assert_eq!(parent_entry["queryRunning"], false);
    assert_eq!(parent_entry["subAgentRunning"], true);
    assert_eq!(parent_entry["idle"], false);
    // parentSessionId 根事实：普通会话为 null、子代理会话带父 id
    // （spawn 时落 `parent_session_id`）
    assert_eq!(parent_entry["parentSessionId"], Value::Null);
    let child_entry = states
        .iter()
        .find(|state| state["sessionId"] == "c1")
        .expect("child entry");
    assert_eq!(child_entry["parentSessionId"], "p1");

    // 子代理空闲后父会话回到空闲（登记仍在，不算「有子代理在跑」）
    child.lock().unwrap().running = false;
    harness.sink.clear();
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    let states = runtime["states"].as_array().unwrap();
    let parent_entry = states
        .iter()
        .find(|state| state["sessionId"] == "p1")
        .expect("parent entry");
    assert_eq!(parent_entry["subAgentRunning"], false);
    assert_eq!(parent_entry["idle"], true);

    crate::subagent::reset_for_test();
}

/// RT-1（`specs/defects/subagent-start-missing-runtime-emit`）：子代理创建即 running，
/// 首次出现在 `sessionRuntimeChanged` 里就必须是 `queryRunning: true`——对话树流水灯 /
/// 托盘 / abort 按钮只读这份快照，不允许先推一份 idle 再补 running（否则要等第一轮结束，
/// spin 下就是整个节点结束，灯才亮）。
///
/// 用 gated 假 LLM 把子代理第一轮卡住；之后让它用 `Reply` 收尾，避免后台线程跨用例残留。
#[test]
fn sub_agent_start_emits_running_runtime_snapshot() {
    let sandbox = Sandbox::new("engine-subagent-runtime-entry");
    // 第一段先写一个文本增量，卡住 3s 再写 `Reply`：测试在这段窗口里查快照。
    let llm = FakeLlm::start_gated(
        |_, _| {
            let first = format!(
                "data: {}\n\n",
                json!({ "choices": [{ "delta": { "content": "工作中" } }] })
            );
            let second = openai_tool_sse("call_reply", "Reply", r#"{"message":"完成"}"#);
            (first, second)
        },
        || std::thread::sleep(std::time::Duration::from_millis(3000)),
    );
    prepare(&sandbox, &llm.base_url, "auto");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let harness = EngineHarness::allow_all();
    let creator = "s-subagent-runtime-entry";
    history::create_conversation(creator, &project, json!({ "sessionId": creator })).unwrap();
    // 父会话按 spin 主会话处理：Reply 只进上下文并落盘，不触发父会话消费循环，
    // 用例结束时不留下第二轮 LLM 请求。
    harness.core.session(creator).lock().unwrap().work_mode = WorkMode::Spin;

    // 与 `CoreSpinHost::run_sub_agent` 同一条路径：submit_tool_use("Agent")
    harness
        .core
        .submit_tool_use(
            creator,
            "Agent",
            &json!({ "prompt": "任务", "agentRole": "Master", "description": "节点 1" }),
        )
        .expect("Agent 工具应当起子代理");
    let child = crate::subagent::list_for_creator(creator)
        .last()
        .cloned()
        .expect("子代理应当登记");

    // 取「第一条包含该子会话的运行时快照」——它必须是 running，不允许 idle 中间态。
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1500);
    let mut first_snapshot = None;
    while std::time::Instant::now() < deadline {
        first_snapshot = harness
            .sink
            .events_of("sessionRuntimeChanged")
            .into_iter()
            .find(|event| {
                event["states"]
                    .as_array()
                    .map(|states| states.iter().any(|state| state["sessionId"] == child.as_str()))
                    .unwrap_or(false)
            });
        if first_snapshot.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let snapshot = first_snapshot.unwrap_or_else(|| {
        panic!(
            "子代理创建后 1.5s 内应出现在 sessionRuntimeChanged 快照里；实际事件: {:?}",
            harness.sink.event_types()
        )
    });
    let states = snapshot["states"].as_array().unwrap();
    let child_entry = states
        .iter()
        .find(|state| state["sessionId"] == child.as_str())
        .expect("子会话条目");
    assert_eq!(
        child_entry["queryRunning"], true,
        "子代理首次进入快照就应是 running（创建即 running，不允许 idle 中间态）"
    );
    let parent_entry = states
        .iter()
        .find(|state| state["sessionId"] == creator)
        .expect("父会话条目");
    assert_eq!(parent_entry["subAgentRunning"], true, "父会话应看到子代理在跑");
    assert_eq!(parent_entry["idle"], false, "父会话不应显示空闲");

    // 等子代理收尾（`Reply` → queryEnd），避免后台线程跨用例残留。
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while std::time::Instant::now() < deadline
        && !harness
            .sink
            .events_of("queryEnd")
            .iter()
            .any(|event| event["sessionId"] == child.as_str())
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// abort 两阶段：
/// 前台有工作时只置 `cancel`，后台 Bash 任务保留；前台停下后再次 abort 才中止后台。
#[test]
fn abort_request_stops_foreground_before_background() {
    let sandbox = Sandbox::new("engine-abort-phases");
    let previous_tmpdir = std::env::var("TMPDIR").ok();
    std::env::set_var("TMPDIR", sandbox.root.join("tmp"));
    let llm = FakeLlm::start(|_index, _body| openai_text_sse(&["ok"]));
    prepare(&sandbox, &llm.base_url, "auto");
    crate::bash_task::reset_for_test();

    let harness = EngineHarness::allow_all();
    let core = Arc::clone(&harness.core);
    // 先建会话，`sync_background` 钩子才找得到它（对齐真实链路：会话先被打开）
    core.session("s1");
    let _task_id = crate::bash_task::spawn_background(
        "sleep 30",
        &sandbox.workspace.to_string_lossy(),
        "Sleep",
        "s1",
        Some(core.background_hooks()),
    )
    .expect("spawn background");
    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("sessionRuntimeChanged")
                .last()
                .map(|event| event["states"][0]["backgroundRunning"] == json!(true))
                .unwrap_or(false),
            Duration::from_secs(10),
        ),
        "后台任务应进入快照: {:?}",
        harness.sink.events_of("sessionRuntimeChanged")
    );

    // 前台有工作：第一次 abort 只中止前台，后台任务保留
    core.session("s1").lock().unwrap().running = true;
    core.on_abort("s1");
    assert!(
        core.session("s1").lock().unwrap().cancel.load(Ordering::Relaxed),
        "第一阶段应置 cancel"
    );
    assert_eq!(
        crate::bash_task::running_count_for_session("s1"),
        1,
        "第一阶段不应中止后台任务"
    );

    // 前台停下：第二次 abort 命中后台阶段
    {
        let state = core.session("s1");
        let mut state = state.lock().unwrap();
        state.running = false;
        state.cancel.store(false, Ordering::Relaxed);
    }
    core.on_abort("s1");
    assert_eq!(
        crate::bash_task::running_count_for_session("s1"),
        0,
        "第二阶段应中止后台任务"
    );

    crate::bash_task::reset_for_test();
    match previous_tmpdir {
        Some(value) => std::env::set_var("TMPDIR", value),
        None => std::env::remove_var("TMPDIR"),
    }
}

#[test]
fn conversation_lifecycle_updates_state_and_metadata() {
    let sandbox = Sandbox::new("engine-lifecycle");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
        None,
    )
    .unwrap();

    // 打开：从磁盘载入消息
    harness.core.on_conversation_opened("s1");
    let state = harness.core.session("s1");
    assert_eq!(state.lock().unwrap().messages.len(), 1);
    assert_eq!(state.lock().unwrap().last_uuid.as_deref(), Some("u1"));

    // 重命名：先 titleChanged（宿主据此更新标题栏），再 conversationListChanged
    harness.core.on_conversation_renamed("s1", "新名字");
    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "新名字");
    let title = harness.sink.event_of("titleChanged").expect("titleChanged");
    assert_eq!(title["sessionId"], "s1");
    assert_eq!(title["title"], "新名字");
    assert!(harness.sink.event_of("conversationListChanged").is_some());

    // 上下文更新
    harness.core.on_context_updated("s1", &[json!({ "key": "currentFile", "value": "a.ts" })]);
    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["context"]["currentFile"],
        "a.ts"
    );

    // 关闭：置取消位并丢掉运行时状态
    harness.core.on_conversation_closed("s1");
    assert!(harness.core.session_if_exists("s1").is_none());

    // 删除：连文件一起清掉
    harness.core.on_conversation_deleted("s1");
    assert!(history::load_metadata("s1", &workspace).is_none());
}

#[test]
fn deleting_a_conversation_aborts_the_query_and_clears_its_tool_results() {
    let sandbox = Sandbox::new("engine-delete-cleanup");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
        None,
    )
    .unwrap();

    // 造两个大工具结果文件：一个属于 s1（要删），一个属于别的会话（要留）
    let dir = config::ensure_project_conversation_dir(&workspace)
        .unwrap()
        .join("tool-results");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("s1__tool-Bash-1.txt"), "big").unwrap();
    std::fs::write(dir.join("s2__tool-Bash-1.txt"), "big").unwrap();

    // 会话正在跑（cancel 未置）时删除：必须先中止，否则运行中的轮次会把文件写回来
    let state = harness.core.session("s1");
    state.lock().unwrap().running = true;

    harness.core.on_conversation_deleted("s1");

    assert!(
        state.lock().unwrap().cancel.load(Ordering::Relaxed),
        "删除会话必须先中止在跑的查询（对齐 releaseSessionResources → abortSessionTree）"
    );
    assert!(harness.core.session_if_exists("s1").is_none());
    assert!(history::load_metadata("s1", &workspace).is_none());
    assert!(!history::messages_path("s1", &workspace).unwrap().exists());
    assert!(!dir.join("s1__tool-Bash-1.txt").exists(), "会话的大工具结果应一并清理");
    assert!(dir.join("s2__tool-Bash-1.txt").exists(), "别的会话的文件不能动");
}

#[test]
fn deleting_a_conversation_releases_its_sub_conversations_too() {
    // `conversationDeleted` 先对**闭包里每个会话**跑
    // `releaseSessionResources`（中止 + 卸引擎 + 丢运行时状态），再删盘。
    let sandbox = Sandbox::new("engine-delete-closure");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    for (id, parent) in [("root", None), ("child", Some("root")), ("unrelated", None)] {
        let mut metadata = json!({ "sessionId": id });
        if let Some(parent) = parent {
            metadata["parentSessionId"] = json!(parent);
        }
        history::create_conversation(id, &workspace, metadata).unwrap();
    }
    // 三个会话都在内存里注册过（模拟子代理运行过 / 会话打开过）
    let child = harness.core.session("child");
    child.lock().unwrap().running = true;
    harness.core.session("unrelated");

    harness.core.on_conversation_deleted("root");

    assert!(
        child.lock().unwrap().cancel.load(Ordering::Relaxed),
        "子对话的查询也必须先中止"
    );
    assert!(harness.core.session_if_exists("root").is_none());
    assert!(harness.core.session_if_exists("child").is_none(), "子对话要一并卸掉");
    assert!(harness.core.session_if_exists("unrelated").is_some(), "无关会话不能动");
    assert!(history::load_metadata("root", &workspace).is_none());
    assert!(history::load_metadata("child", &workspace).is_none());
    assert!(history::load_metadata("unrelated", &workspace).is_some());
}

#[test]
fn run_consumer_does_not_resurrect_a_dropped_session() {
    let sandbox = Sandbox::new("engine-consumer-no-resurrect");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    let state = harness.core.session("s1");
    state.lock().unwrap().pending_user_message = Some(json!({
        "type": "user",
        "uuid": "u1",
        "message": { "role": "user", "content": "hi" },
    }));
    state.lock().unwrap().running = true;
    // 会话被关闭 / 删除：运行时状态已丢弃
    harness.core.drop_session("s1");

    run_consumer(Arc::clone(&harness.core), "s1".to_string());

    assert!(
        harness.core.session_if_exists("s1").is_none(),
        "消费循环不得把已丢弃的会话重新建出来"
    );
    assert!(
        harness.sink.events_of("queryBegin").is_empty(),
        "不该再跑任何轮次"
    );
    assert!(
        harness.sink.events_of("queryEnd").is_empty(),
        "没有 queryBegin 就不应有 queryEnd"
    );
}

#[test]
fn rename_and_context_updates_are_noops_without_a_project() {
    let _sandbox = Sandbox::new("engine-no-project");
    let harness = EngineHarness::allow_all();
    harness.core.on_conversation_renamed("ghost", "标题");
    harness.core.on_context_updated("ghost", &[json!({ "key": "model", "value": "m" })]);
    harness.core.on_conversation_deleted("ghost");
    assert!(harness.sink.event_of("conversationListChanged").is_some());
}

#[test]
fn session_config_changes_update_state_and_persist_model_identity() {
    let sandbox = Sandbox::new("engine-session-config");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    let harness = EngineHarness::allow_all();

    harness.core.on_session_config_changed(
        "s1",
        &json!({ "key": "model", "value": { "provider": "p1", "model": "m1" } }),
    );
    let state = harness.core.session("s1");
    assert_eq!(state.lock().unwrap().model.as_deref(), Some("m1"));
    assert_eq!(state.lock().unwrap().provider.as_deref(), Some("p1"));
    let metadata = history::load_metadata("s1", &workspace).unwrap();
    assert_eq!(metadata["model"], "m1");
    assert_eq!(metadata["context"]["provider"], "p1");

    harness.core.on_session_config_changed("s1", &json!({ "key": "agentMode", "value": "auto" }));
    assert_eq!(state.lock().unwrap().agent_mode, "auto");

    // 未知 key 只上报不落盘
    harness.core.on_session_config_changed("s1", &json!({ "key": "thinkingEffort", "value": "off" }));
    assert!(harness.sink.events_of("sessionConfigChanged").len() == 3);

    // 没有 key 的变更直接丢弃
    harness.sink.clear();
    harness.core.on_session_config_changed("s1", &json!({ "value": "x" }));
    assert!(harness.sink.events().is_empty());

    // model 变更里缺 provider / model 字段时按 None 处理
    harness
        .core
        .on_session_config_changed("s1", &json!({ "key": "model", "value": {} }));
    assert!(state.lock().unwrap().model.is_none());

    // agentMode 非字符串时退化为 manual
    harness
        .core
        .on_session_config_changed("s1", &json!({ "key": "agentMode", "value": 3 }));
    assert_eq!(state.lock().unwrap().agent_mode, "manual");
}

#[test]
fn ensure_loaded_reads_messages_and_session_metadata() {
    let sandbox = Sandbox::new("engine-ensure-loaded");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "agentMode": "auto", "model": "m9", "provider": "p9" }),
    )
    .unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
        None,
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    harness.core.ensure_loaded("s1").unwrap();
    let state = harness.core.session("s1");
    let state = state.lock().unwrap();
    assert_eq!(state.messages.len(), 1);
    assert_eq!(state.last_uuid.as_deref(), Some("u1"));
    assert_eq!(state.agent_mode, "auto", "meta.json 的 agentMode 覆盖默认值");
    assert_eq!(state.model.as_deref(), Some("m9"));
    assert_eq!(state.provider.as_deref(), Some("p9"));
    assert_eq!(state.project.as_deref(), Some(workspace.as_str()));
}

#[test]
fn ensure_loaded_without_any_workspace_fails() {
    let _sandbox = Sandbox::new("engine-ensure-loaded-error");
    let harness = EngineHarness::allow_all();
    assert!(harness.core.ensure_loaded("s1").is_err());
}

// ==================== 消费循环 ====================

#[test]
fn user_message_without_session_id_is_dropped() {
    let _sandbox = Sandbox::new("engine-no-session");
    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({ "content": "hi" }));
    let log = harness.sink.event_of("log").expect("log event");
    assert!(log["message"].as_str().unwrap().contains("without sessionId"), "got {log}");
}

#[test]
fn run_consumer_stops_when_cancelled() {
    let _sandbox = Sandbox::new("engine-consumer-cancel");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    {
        let mut state = state.lock().unwrap();
        state.pending_user_message = Some(json!({ "type": "user" }));
        state.running = true;
        state.cancel.store(true, Ordering::Relaxed);
    }

    run_consumer(Arc::clone(&harness.core), "s1".to_string());

    let state = state.lock().unwrap();
    assert!(state.pending_user_message.is_none(), "取消时清空待处理队列");
    assert!(!state.running);
    // 消费循环一旦启动就发一对 queryBegin / queryEnd，中止也照发。
    assert_eq!(harness.sink.events_of("queryBegin").len(), 1);
    assert_eq!(harness.sink.events_of("queryEnd").len(), 1);
}

// ==================== 排队消息撤回（`queuedMessageDiscarded`）====================

/// 撤回排队中的用户消息（webview 排队项的
/// 「编辑 / 删除」，`docs/features/user-message-pipeline.md` FR-003）。
#[test]
fn queued_message_is_discarded_by_uuid() {
    let _sandbox = Sandbox::new("engine-discard-queued");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    {
        let mut state = state.lock().unwrap();
        state.pending_user_message = Some(json!({
            "type": "user",
            "message": { "role": "user", "content": "排队消息" },
            "uuid": "u1",
            "timestamp": 1,
        }));
        state.pending_skill_injection = Some(SkillInjection {
            skill_name: "spin".to_string(),
            skill_args: String::new(),
        });
        state.running = true;
    }

    harness.core.on_queued_message_discarded("s1", "u1");

    let state = state.lock().unwrap();
    assert!(state.pending_user_message.is_none(), "uuid 配对时丢弃排队消息");
    // Skill 待注入与排队消息同生共死
    assert!(state.pending_skill_injection.is_none(), "Skill 待注入一并清除");
    // 不置 cancel：撤回排队项不打断正在运行的查询（区别于 abort 第一阶段）
    assert!(!state.cancel.load(Ordering::Relaxed), "撤回不置 cancel");
}

#[test]
fn queued_message_discard_is_a_noop_on_uuid_mismatch() {
    let _sandbox = Sandbox::new("engine-discard-queued-mismatch");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    {
        let mut state = state.lock().unwrap();
        state.pending_user_message = Some(json!({
            "type": "user",
            "message": { "role": "user", "content": "排队消息" },
            "uuid": "u1",
            "timestamp": 1,
        }));
    }

    // uuid 不匹配（已被消费 / 被更新的排队消息替换）与未知会话：都不动
    harness.core.on_queued_message_discarded("s1", "u-other");
    harness.core.on_queued_message_discarded("s-missing", "u1");

    let state = state.lock().unwrap();
    assert!(state.pending_user_message.is_some(), "uuid 不匹配时不动");
}

#[test]
fn run_consumer_reports_turn_failures_as_system_messages() {
    let _sandbox = Sandbox::new("engine-consumer-error");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    {
        let mut state = state.lock().unwrap();
        state.project = Some("D:/repo".to_string());
        state.pending_user_message = Some(json!({
            "type": "user",
            "uuid": "u1",
            "message": { "role": "user", "content": "hi" },
        }));
        state.running = true;
    }

    run_consumer(Arc::clone(&harness.core), "s1".to_string());

    let message = harness.sink.event_of("message").expect("system message");
    assert_eq!(message["data"]["role"], "system");
    // LLM 错误模板逐字锁定
    let content = message["data"]["content"].as_str().unwrap();
    assert!(content.contains("❌ **LLM API Error**"), "got {message}");
    assert!(content.contains("```"), "got {message}");
    assert!(content.contains("settings.json"), "got {message}");
    // 一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：记进 meta.json 的
    // `onceMessage`，`<sid>.jsonl` 无记录
    assert_eq!(message["data"]["once"], true);
    let metadata = history::load_metadata("s1", "D:/repo").expect("meta");
    assert_eq!(metadata["onceMessage"]["role"], "system");
    assert_eq!(metadata["onceMessage"]["content"], content);
    assert!(
        !history::load_messages("s1", "D:/repo")
            .iter()
            .any(|message| message["type"] == "system"),
        "LLM 错误提示不得写进 jsonl"
    );
    assert!(!state.lock().unwrap().running);
}

#[test]
fn compact_requested_while_busy_emits_once_notice() {
    // 会话非空闲时请求压缩：登记「待压缩」并上报一次性提示
    // （`docs/hosts/webview-ui.md` 第 11 节：once = true，只记 meta.json 的 `onceMessage`）
    let sandbox = Sandbox::new("engine-compact-queued");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace));
    let harness = EngineHarness::allow_all();

    {
        let session = harness.core.session("s1");
        let mut state = session.lock().unwrap();
        // 可压缩：边界之后的消息数必须超过保留阈值（30）
        state.messages.push(json!({
            "type": "user",
            "message": { "role": "user", "content": "你好" },
            "uuid": "u-1",
        }));
        for index in 0..31 {
            state.messages.push(json!({
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("m{index}") }],
                },
                "uuid": format!("a-{index}"),
            }));
        }
        state.persisted_count = state.messages.len();
        // 非空闲：命中「登记待压缩」分支
        state.running = true;
    }
    harness.core.request_compact("s1");

    let message = harness.sink.event_of("message").expect("queued notice");
    assert!(
        message["data"]["content"]
            .as_str()
            .unwrap()
            .contains("压缩已排队"),
        "got {message}"
    );
    assert_eq!(message["data"]["once"], true);
    assert!(compact::is_pending_compact("s1"));
    // 一次性通知只记 meta.json 的 `onceMessage`，不落 jsonl（`docs/hosts/webview-ui.md` 第 11 节）
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let metadata = history::load_metadata("s1", &workspace).expect("meta");
    assert!(
        metadata["onceMessage"]["content"]
            .as_str()
            .unwrap_or("")
            .contains("压缩已排队"),
        "got {metadata}"
    );
    assert!(
        !history::load_messages("s1", &workspace)
            .iter()
            .any(|message| message["type"] == "system"
                && message["content"].as_str().unwrap_or("").contains("压缩已排队")),
        "压缩排队提示不得落盘"
    );
    // 待压缩标记是进程级静态状态：清理掉，不泄漏给同二进制的其它用例
    compact::unmark_pending_compact("s1");
}

// ==================== 完整轮次（假 LLM）====================

#[test]
fn full_turn_with_a_tool_call_emits_events_and_persists_messages() {
    let sandbox = Sandbox::new("engine-turn-tool");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo tool-ok"}"#)
        } else {
            openai_text_sse(&["完成"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1", "title": "" }))
        .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let types = harness.sink.event_types();
    for expected in [
        "queryBegin", "aiBegin", "toolCall", "toolArgsUpdated", "toolResult", "aiEnd", "queryEnd",
    ] {
        assert!(types.iter().any(|kind| kind == expected), "缺少 {expected}: {types:?}");
    }

    let call = harness.sink.event_of("toolCall").unwrap();
    assert_eq!(call["toolName"], "Bash");
    assert_eq!(call["toolUseId"], "call_1");
    let args = harness.sink.event_of("toolArgsUpdated").unwrap();
    assert_eq!(args["args"]["command"], "echo tool-ok");

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "success");
    assert!(result["output"].as_str().unwrap().contains("tool-ok"), "got {result}");

    // 落盘：用户消息 + assistant(tool_use) + tool_result + assistant(文本)
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages.len(), 4, "got {messages:?}");
    assert_eq!(messages[0]["uuid"], "u-1");
    assert_eq!(messages[1]["message"]["content"][0]["type"], "tool_use");
    assert_eq!(messages[2]["message"]["content"][0]["type"], "tool_result");
    assert_eq!(messages[3]["message"]["content"][0]["text"], "完成");

    // 标题由首条用户消息推导
    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "跑一下");
    // 只在改名（conversationRenamed）时发 titleChanged，新消息推导标题不发
    assert!(harness.sink.event_of("titleChanged").is_none());
    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["messageCount"], 4);
    // `conversationListChanged` 每条消息落盘后各发一次（用户 + assistant + tool_result
    // + assistant = 4 次）
    assert_eq!(
        harness.sink.events_of("conversationListChanged").len(),
        4,
        "每条消息落盘各发一次"
    );
}

/// 未预建会话文件时，第一条用户消息负责创建 `meta.json` + `.jsonl`，
/// 并用首条用户消息生成标题（`conversationStarted` 不再预先建档）。
#[test]
fn first_user_message_creates_the_conversation_files() {
    let sandbox = Sandbox::new("engine-first-message-creates-files");
    let llm = FakeLlm::start(|_index, _| openai_text_sse(&["收到"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    assert!(
        history::load_metadata("s1", &workspace).is_none(),
        "测试前提：会话尚未建档"
    );

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "帮我看看这个文件", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let metadata = history::load_metadata("s1", &workspace).expect("meta.json 应被创建");
    assert_eq!(metadata["title"], "帮我看看这个文件");
    assert_eq!(metadata["sessionId"], "s1");
    assert_eq!(metadata["project"], workspace);
    // 对齐 `updateMetadataForNewMessage`：新 meta.json 的 context.promptMode 缺省补 normal
    assert_eq!(metadata["context"]["promptMode"], "normal");
    assert!(history::messages_path("s1", &workspace).unwrap().is_file());
    // 用户消息 + assistant 回复
    assert_eq!(history::load_messages("s1", &workspace).len(), 2);
    // 不再产生 sessionCreated（那是 conversationStarted 旧行为）
    assert!(harness.sink.event_of("sessionCreated").is_none());
    // 也不产生 titleChanged：落盘只发 `conversationListChanged`，`titleChanged` 仅在改名时发。
    assert!(harness.sink.event_of("titleChanged").is_none());
}

/// 首条消息取不到文本时，标题兜底 `New Conversation`。
#[test]
fn first_user_message_without_text_falls_back_to_new_conversation() {
    let sandbox = Sandbox::new("engine-first-message-empty-title");
    let llm = FakeLlm::start(|_index, _| openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["title"],
        "New Conversation"
    );
}

/// 已建档但还没有消息（messageCount === 0）时，首条用户消息**不**覆盖已有标题
/// （对齐 `updateMetadataForNewMessage`：meta.json 已有标题——用户重命名 /
/// 智能命名 / spin 改名先落盘——则保留，首条消息只在尚无标题时生成推导标题）。
#[test]
fn first_user_message_preserves_preexisting_title() {
    let sandbox = Sandbox::new("engine-first-message-preserves-title");
    let llm = FakeLlm::start(|_index, _| openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "title": "旧标题", "messageCount": 0 }),
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "帮我看看这个文件", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["title"],
        "旧标题"
    );
}

/// 已经有消息的会话（messageCount > 0）改名后，后续消息不得覆盖标题
/// （对齐 `updateMetadataForNewMessage`：已有消息或有显式标题时都不更新）。
#[test]
fn rename_after_messages_is_preserved_on_later_turns() {
    let sandbox = Sandbox::new("engine-rename-preserved");
    let llm = FakeLlm::start(|_index, _| openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "title": "新名字", "messageCount": 2 }),
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "再来一轮", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["title"],
        "新名字"
    );
}

/// Read 图片：tool_result 的 `content` 是 image content block 数组（不是 base64 文本），
/// 模型才能直接看到图片。
#[test]
fn image_read_is_returned_as_an_image_content_block() {
    let sandbox = Sandbox::new("engine-image-read");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_img", "Read", r#"{"file_path":"pic.png"}"#)
        } else {
            openai_text_sse(&["看到了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let bytes = minimal_png_bytes();
    std::fs::write(sandbox.workspace.join("pic.png"), &bytes).unwrap();
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1", "title": "" }))
        .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "看图", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["status"], "success");
    // UI 事件的 `output` 是 string：数组 content 上报 `'[Image]'`
    // （图片本体只进 tool_result block）。
    assert_eq!(result["output"], "[Image]", "图片的 UI 输出应为 [Image]: {result}");

    // 落盘的 tool_result block 同样是数组（LLM 上下文里就是 image block）
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages[2]["message"]["content"][0]["type"], "tool_result");
    assert_eq!(messages[2]["message"]["content"][0]["content"][0]["type"], "image");
}

#[test]
fn orphan_tool_use_is_backfilled_with_a_cancelled_tool_result_on_load() {
    // 崩溃恢复：磁盘上只有 assistant 的 tool_use、没有 tool_result 时，
    // `ensure_loaded` 必须补一条「会话中断」的取消结果，否则下一轮 Anthropic 请求会因 tool_use 未配对而 400。
    let sandbox = Sandbox::new("engine-orphan-tool-use");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["好的"])
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1", "title": "t" }))
        .unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "call_orphan", "name": "Bash", "input": { "command": "ls" } },
                ],
            },
        }),
        None,
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "继续", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    let messages = bodies[0]["messages"].as_array().unwrap();
    let recovered = messages
        .iter()
        .find(|message| message["role"] == "tool" && message["tool_call_id"] == "call_orphan")
        .unwrap_or_else(|| panic!("缺少补发的 tool_result: {messages:?}"));
    assert!(
        recovered["content"]
            .as_str()
            .unwrap()
            .contains("[Previous session interrupted] Tool \"Bash\" was canceled before execution."),
        "got {recovered}"
    );
}

#[test]
fn crash_recovered_tool_results_are_persisted_before_the_next_user_message() {
    // 崩溃恢复补出的合成 tool_result 不能只停在内存：
    // 下一次持久化时机按序补写，且 parentUuid
    // 指向包含 tool_use 的 assistant（不能自引用，否则 BFS 建链时整条链被孤立）。
    let sandbox = Sandbox::new("engine-recovered-persist");
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "title": "t" }),
    )
    .unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "tool_use", "id": "call_orphan", "name": "Bash", "input": { "command": "ls" } },
                ],
            },
        }),
        None,
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "继续", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let dir = sandbox.conversation_dir(&workspace);
    let lines: Vec<Value> = std::fs::read_to_string(dir.join("s1.jsonl"))
        .unwrap()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let uuids: Vec<&str> = lines
        .iter()
        .map(|line| line["uuid"].as_str().unwrap())
        .collect();
    // 磁盘顺序：assistant(tool_use) → 恢复结果 → 用户消息 → assistant 回复
    assert_eq!(uuids.len(), 4, "got {uuids:?}");
    assert_eq!(uuids[0], "a1");
    assert!(uuids[1].starts_with("tool_recovered_"), "got {uuids:?}");
    assert_eq!(uuids[2], "u-1");
    assert_eq!(
        lines[1]["parentUuid"], "a1",
        "恢复结果必须挂到包含 tool_use 的 assistant"
    );
    assert_eq!(
        lines[2]["parentUuid"], uuids[1],
        "用户消息的 parentUuid 应接在恢复结果之后"
    );
    let metadata = history::load_metadata("s1", &workspace).unwrap();
    assert_eq!(metadata["messageCount"], 4, "恢复结果要计入 messageCount");
    // 对齐 `Conversation.appendMessage`：每落盘一条消息各发一次列表变化——
    // 恢复结果 + 用户消息 + assistant 回复 = 3 次。
    assert_eq!(
        harness
            .sink
            .events_of("conversationListChanged")
            .len(),
        3,
        "恢复结果也要各发一次 conversationListChanged"
    );
}

#[test]
fn second_llm_round_sees_the_tool_result() {    let sandbox = Sandbox::new("engine-round-two");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            openai_tool_sse("call_1", "Read", r#"{"file_path":"a.txt"}"#)
        } else {
            openai_text_sse(&["看到了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    sandbox.write_file("a.txt", "文件内容\n");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "读一下", "u-1");
    assert!(harness.wait_query_end());

    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "应当有两次 LLM 调用");
    let second = &bodies[1];
    let messages = second["messages"].as_array().unwrap();
    let tool_message = messages
        .iter()
        .find(|message| message["role"] == "tool")
        .unwrap_or_else(|| panic!("第二轮缺少 tool 结果: {messages:?}"));
    assert_eq!(tool_message["tool_call_id"], "call_1");
    assert!(
        tool_message["content"].as_str().unwrap().contains("文件内容"),
        "got {tool_message}"
    );
    // 第一轮里工具还没执行，不应有 tool 消息
    assert!(bodies[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .all(|message| message["role"] != "tool"));
}

/// 手工转后台（`UiEvent.bashBackgroundRequested`，Bash 卡片「转后台」按钮）：
///
/// 1. 前台 Bash 跑起来后触发转后台 → toolResult 落盘（success）、消费循环收尾
///    （queryEnd，等待用户输入），**没有**第二次 LLM 请求——下一轮 agent 循环暂停；
/// 2. 消费循环收尾不为触发暂停的任务补兜底 reminder：暂停信号携带的 `source_task`
///    在暂停出口被登记为「已兜底」（`fallback_reminded`），3 分钟门槛与 sleep 豁免
///    都不再命中，否则 `sleep 30` 会立刻 qualify，暂停等于失效；
/// 3. 下一条用户消息（队列消息）立刻拉起新一轮：第二轮 LLM 请求的上下文里
///    带着转后台的 tool_result——接续由队列消息触发，与转后台结果无关。

#[test]
fn manual_background_pauses_the_loop_until_a_queued_message_arrives() {
    let sandbox = Sandbox::new("engine-manual-background");
    let previous_tmpdir = std::env::var("TMPDIR").ok();
    std::env::set_var("TMPDIR", sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Bash",
                r#"{"command":"sleep 30","description":"Long sleep"}"#,
            )
        } else {
            openai_text_sse(&["继续"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1", "title": "" }))
        .unwrap();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑个长命令", "u-1");

    // 等前台 Bash 真正跑起来（注册表登记完成）再触发手工转后台
    assert!(
        harness.wait_for(
            |_| crate::tools::is_foreground_bash_running("call_1"),
            Duration::from_secs(10),
        ),
        "前台 Bash 未登记: {:?}",
        harness.sink.event_types()
    );
    assert!(crate::tools::request_manual_background("call_1"));

    // 转换完成 → 工具批收尾 → 暂停出口 → 消费循环收尾（queryEnd）
    assert!(
        harness.wait_query_end(),
        "轮次未结束: {:?}",
        harness.sink.event_types()
    );
    {
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 1, "手工转后台后不应发起第二次 LLM 请求");
    }

    // 后台任务仍在跑；消费循环收尾（未为刚注册的任务补兜底 reminder）；会话回到「等待用户输入」
    let running = crate::bash_task::running_tasks_for_session("s1");
    assert_eq!(running.len(), 1, "转后台后应有 1 个运行中的后台任务");
    {
        let state = harness.core.session("s1");
        let state = state.lock().unwrap();
        assert!(!state.running, "消费循环应收尾（等待用户输入）");
    }
    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["status"], "success", "转后台不是失败: {result}");
    assert!(
        result["output"]
            .as_str()
            .unwrap_or("")
            .contains("Command moved to the background"),
        "got {result}"
    );

    // 队列消息（新用户消息）立刻拉起新一轮：第二轮请求上下文里带转后台的 tool_result
    harness.sink.clear();
    submit(&harness, "s1", "继续", "u-2");
    assert!(
        harness.wait_query_end(),
        "第二轮未结束: {:?}",
        harness.sink.event_types()
    );
    {
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2, "用户消息应拉起新一轮 LLM 请求");
        let tool_message = bodies[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["role"] == "tool")
            .unwrap_or_else(|| panic!("第二轮缺少 tool 结果: {:?}", bodies[1]["messages"]));
        assert!(
            tool_message["content"]
                .as_str()
                .unwrap_or("")
                .contains("Command moved to the background"),
            "got {tool_message}"
        );
        // 第二轮里最后一条用户消息是新的「继续」
        let user_texts: Vec<&str> = bodies[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "user")
            .filter_map(|message| message["content"].as_str())
            .collect();
        assert!(user_texts.contains(&"继续"), "got {user_texts:?}");
    }

    crate::bash_task::abort_tasks_for_session("s1");
    crate::bash_task::reset_for_test();
    match previous_tmpdir {
        Some(value) => std::env::set_var("TMPDIR", value),
        None => std::env::remove_var("TMPDIR"),
    }
}

/// 写一份带 `features.maxTurns` 的 settings（沿用 `write_llm_settings` 的连接信息）
/// 联网搜索开关注入 WebSearch / WebFetch：settings 默认开 → 工具在清单里；
/// 关 → 不在。会话级覆盖（context.webSearch）优先于 settings。
#[test]
fn web_tools_follow_the_web_search_flag() {
    let run_query_and_collect_tools = |sandbox_name: &str, web_search: Option<bool>| -> Vec<String> {
        let sandbox = Sandbox::new(sandbox_name);
        let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bodies);
        let llm = FakeLlm::start(move |_, body| {
            captured.lock().unwrap().push(body.clone());
            openai_text_sse(&["好"])
        });
        let mut settings = json!({
            "llm": {
                "maxTokens": 4096,
                "activeProvider": "fake",
                "providers": {
                    "fake": {
                        "baseURL": llm.base_url,
                        "apiKey": "test-key",
                        "models": ["fake-model"],
                        "defaultModel": "fake-model",
                        "modelConfigs": { "fake-model": { "apiType": "OpenAI", "output": 4096 } }
                    }
                }
            }
        });
        if let Some(enabled) = web_search {
            settings["llm"]["webSearch"] = json!(enabled);
        }
        sandbox.write_settings(settings);
        config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

        let harness = EngineHarness::allow_all();
        submit(&harness, "s1", "搜一下", "u-1");
        assert!(harness.wait_query_end());
        let bodies = bodies.lock().unwrap();
        assert!(!bodies.is_empty(), "应当发出 LLM 请求");
        tool_names(&bodies[0])
    };

    // 缺省（settings 未写 webSearch）= 开
    let on = run_query_and_collect_tools("engine-web-tools-on", None);
    assert!(on.contains(&"WebSearch".to_string()), "默认开：{on:?}");
    assert!(on.contains(&"WebFetch".to_string()), "默认开：{on:?}");

    // settings 显式关
    let off = run_query_and_collect_tools("engine-web-tools-off", Some(false));
    assert!(!off.contains(&"WebSearch".to_string()), "关：{off:?}");
    assert!(!off.contains(&"WebFetch".to_string()), "关：{off:?}");
    // 其余内置工具不受影响
    assert!(off.contains(&"Bash".to_string()) && off.contains(&"Read".to_string()));
}

/// 联网搜索切换必须同步变换工具清单与 system prompt：关闭后下一轮请求两工具
/// 不在清单里，`## Tool Details` 的 WebSearch / WebFetch 段也随之消失
/// （specs/defects/web-search-off-still-usable）。
#[test]
fn web_search_toggle_syncs_tool_list_and_prompt_details() {
    let sandbox = Sandbox::new("engine-web-search-toggle");
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["好"])
    });
    sandbox.write_settings(json!({
        "llm": {
            "maxTokens": 4096,
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "test-key",
                    "models": ["fake-model"],
                    "defaultModel": "fake-model",
                    "modelConfigs": { "fake-model": { "apiType": "OpenAI", "output": 4096 } }
                }
            }
        }
    }));
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    // OpenAI 协议的 system prompt 是 messages 里 role=system 的首条
    let system_prompt_of = |body: &Value| -> String {
        body["messages"]
            .as_array()
            .and_then(|messages| {
                messages
                    .iter()
                    .find(|message| message["role"] == "system")
            })
            .and_then(|message| message["content"].as_str())
            .unwrap_or_default()
            .to_string()
    };

    let harness = EngineHarness::allow_all();

    // 第一轮：默认开 → 工具与 Tool Details 段都在
    submit(&harness, "s1", "第一问", "u-1");
    assert!(harness.wait_query_end(), "第一轮未结束");
    {
        let bodies = bodies.lock().unwrap();
        assert!(!bodies.is_empty(), "应当发出 LLM 请求");
        let names = tool_names(&bodies[0]);
        assert!(
            names.contains(&"WebSearch".to_string())
                && names.contains(&"WebFetch".to_string()),
            "默认开工具清单：{names:?}"
        );
        let prompt = system_prompt_of(&bodies[0]);
        assert!(prompt.contains("## WebSearch Tool"), "默认开提示词应含 WebSearch 段");
        assert!(prompt.contains("## WebFetch Tool"), "默认开提示词应含 WebFetch 段");
    }

    // 会话内关闭联网搜索（与 UI setWebSearch 同路径：配置事件）
    harness
        .core
        .on_session_config_changed("s1", &json!({ "key": "webSearch", "value": false }));

    // 第二轮：关 → 工具清单与 Tool Details 同步消失，其余工具说明不受影响
    harness.sink.clear();
    submit(&harness, "s1", "第二问", "u-2");
    assert!(harness.wait_query_end(), "第二轮未结束");
    {
        let bodies = bodies.lock().unwrap();
        assert_eq!(bodies.len(), 2, "切换后应发出第二轮请求");
        let names = tool_names(&bodies[1]);
        assert!(!names.contains(&"WebSearch".to_string()), "关：{names:?}");
        assert!(!names.contains(&"WebFetch".to_string()), "关：{names:?}");
        let prompt = system_prompt_of(&bodies[1]);
        assert!(
            !prompt.contains("## WebSearch Tool"),
            "关：提示词不应再含 WebSearch 段"
        );
        assert!(
            !prompt.contains("## WebFetch Tool"),
            "关：提示词不应再含 WebFetch 段"
        );
        assert!(
            prompt.contains("## Skill Tool") && prompt.contains("### Bash"),
            "其余工具说明不受影响"
        );
    }
}

/// 随消息携带的 webSearch 负载只承担新会话种子职责，不得覆盖已确立的会话状态：
/// 配置事件置 ON 后，负载 `false` 不得把工具从下一轮请求里剔除
/// （specs/defects/websearch-recheck-clobbered-by-payload）。
#[test]
fn message_payload_does_not_override_established_web_search() {
    let sandbox = Sandbox::new("engine-web-search-payload-seed");
    let bodies: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["好"])
    });
    sandbox.write_settings(json!({
        "llm": {
            "maxTokens": 4096,
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "test-key",
                    "models": ["fake-model"],
                    "defaultModel": "fake-model",
                    "modelConfigs": { "fake-model": { "apiType": "OpenAI", "output": 4096 } }
                }
            }
        }
    }));
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    let submit_with_web_search = |harness: &EngineHarness, session_id: &str, content: &str, uuid: &str, web_search: bool| {
        harness.core.on_user_message(&json!({
            "sessionId": session_id,
            "content": content,
            "uuid": uuid,
            "workspacePath": null,
            "webSearch": web_search,
        }));
    };

    let harness = EngineHarness::allow_all();

    // 会话 A：配置事件先置 ON（与输入区重新勾选同路径），随后消息负载带 false
    // （webview 本地状态与 core 发散时的旧值）
    harness
        .core
        .on_session_config_changed("s-a", &json!({ "key": "webSearch", "value": true }));
    submit_with_web_search(&harness, "s-a", "问一", "u-a1", false);
    assert!(harness.wait_query_end(), "会话 A 未结束");
    {
        let bodies = bodies.lock().unwrap();
        let names = tool_names(&bodies.last().unwrap());
        assert!(
            names.contains(&"WebSearch".to_string()) && names.contains(&"WebFetch".to_string()),
            "已确立的 ON 不被负载 false 覆盖：{names:?}"
        );
    }

    // 会话 B：全新会话（无任何配置事件），首条消息负载带 false——种子语义保持。
    // 不能用 wait_query_end：它只判断「capture 里出现过 queryEnd + conversationListChanged」，
    // s-a 已发过这两帧，会让等待立刻通过、断言在 s-b 的请求发出前读到 s-a 的请求体
    // （bodies.last()）；这里按次数等到 s-b 自己的轮次结束帧。
    submit_with_web_search(&harness, "s-b", "问二", "u-b1", false);
    assert!(
        harness.wait_for(
            |sink| {
                let types = sink.event_types();
                types.iter().filter(|kind| *kind == "queryEnd").count() >= 2
                    && types
                        .iter()
                        .filter(|kind| *kind == "conversationListChanged")
                        .count() >= 2
            },
            std::time::Duration::from_secs(30),
        ),
        "会话 B 未结束"
    );
    {
        let bodies = bodies.lock().unwrap();
        let names = tool_names(&bodies.last().unwrap());
        assert!(
            !names.contains(&"WebSearch".to_string()) && !names.contains(&"WebFetch".to_string()),
            "新会话首条消息的负载 false 仍生效：{names:?}"
        );
    }
}

fn write_settings_with_features_max_turns(sandbox: &Sandbox, base_url: &str, agent_mode: &str, max_turns: u64) {
    sandbox.write_settings(json!({
        "defaultAgentMode": agent_mode,
        "features": { "maxTurns": max_turns },
        "llm": {
            "maxTokens": 4096,
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": base_url,
                    "apiKey": "test-key",
                    "models": ["fake-model"],
                    "defaultModel": "fake-model",
                    "modelConfigs": { "fake-model": { "apiType": "OpenAI", "output": 4096 } }
                }
            }
        }
    }));
}

#[test]
fn tool_loop_has_no_default_turn_limit() {
    // 未配置 `features.maxTurns` 时不能有隐藏上限：这里跑满 45 轮工具循环，证明没有硬编码的 40 轮截断。
    let sandbox = Sandbox::new("engine-no-turn-limit");
    let calls = Arc::new(Mutex::new(0usize));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start(move |index, _| {
        *counter.lock().unwrap() = index + 1;
        if index < 45 {
            openai_tool_sse(
                &format!("call_{index}"),
                "Bash",
                r#"{"command":"echo hi"}"#,
            )
        } else {
            openai_text_sse(&["收工"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑起来", "u-1");
    assert!(harness.wait_query_end());

    assert_eq!(*calls.lock().unwrap(), 46, "45 轮工具调用后还应有收尾的一轮");
    assert_eq!(harness.sink.events_of("aiBegin").len(), 46);
    // 未超限时不应有错误提示
    let has_error = harness.sink.events_of("message").iter().any(|event| {
        event["data"]["role"] == "system"
            && event["data"]["content"]
                .as_str()
                .map(|text| text.contains("请求失败"))
                .unwrap_or(false)
    });
    assert!(!has_error, "不应上报轮次上限错误");
}

#[test]
fn settings_features_max_turns_is_ignored() {
    // `settings.json` 的 `features.maxTurns` **没有任何消费方**（只有类型声明），
    // 普通会话不设轮次上限。
    // 这里写 `features.maxTurns = 1`，断言它不会截断 2 轮工具循环。
    let sandbox = Sandbox::new("engine-features-max-turns");
    let calls = Arc::new(Mutex::new(0usize));
    let counter = Arc::clone(&calls);
    let llm = FakeLlm::start(move |index, _| {
        *counter.lock().unwrap() = index + 1;
        if index < 2 {
            openai_tool_sse(&format!("call_{index}"), "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["收工"])
        }
    });
    write_settings_with_features_max_turns(&sandbox, &llm.base_url, "auto", 1);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑起来", "u-1");
    assert!(harness.wait_query_end());

    assert_eq!(
        *calls.lock().unwrap(),
        3,
        "features.maxTurns 不应截断普通会话（2 轮工具 + 1 轮收尾）"
    );
    assert_eq!(harness.sink.events_of("aiBegin").len(), 3);
    assert_eq!(harness.sink.events_of("aiEnd").len(), 3);
    let has_error = harness.sink.events_of("message").iter().any(|event| {
        event["data"]["role"] == "system"
            && event["data"]["content"]
                .as_str()
                .map(|text| text.contains("请求失败") || text.contains("turn limit"))
                .unwrap_or(false)
    });
    assert!(!has_error, "不应上报轮次上限错误");
}

#[test]
fn permission_denied_turns_the_tool_result_into_an_error() {
    let sandbox = Sandbox::new("engine-permission-denied");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            // 破坏性命令是 risk 模式下唯一仍会 ask 的一类
            openai_tool_sse("call_1", "Bash", r#"{"command":"dd if=/dev/zero of=x"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "risk");

    // 权限请求保持 ask → 确认框选「拒绝」
    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "ask" })),
        "userChoice" => Some(json!({ "index": 1, "reply": "太危险了" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "执行危险命令", "u-1");
    assert!(harness.wait_query_end());

    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1, "风险命令应当先上架工具卡片");
    assert_eq!(requests[0]["toolName"], "Bash");
    assert_eq!(requests[0]["permResult"]["behavior"], "ask");
    assert!(requests[0]["permResult"]["message"].is_string());

    let choices = harness.sink.requests_of("userChoice");
    assert_eq!(choices.len(), 1, "ask 之后应当弹确认框");
    assert_eq!(choices[0]["options"]["toolName"], "Bash");
    // 假宿主回的是不带 choices 的 `{ behavior: "ask" }`，引擎按缺省选项兜底
    assert_eq!(choices[0]["options"]["choices"][0]["label"], "允许");

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    let output = result["output"].as_str().unwrap();
    assert!(output.contains("用户拒绝操作"), "got {output}");
    assert!(output.contains("太危险了"), "拒绝原因应当带上: {output}");
}

#[test]
fn ask_user_question_round_trips_through_the_user_choice_request() {
    let sandbox = Sandbox::new("engine-ask-user-question");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "AskUserQuestion",
                r#"{"question":"选哪个？","choices":[{"label":"A"},{"label":"B"}]}"#,
            )
        } else {
            openai_text_sse(&["收到"])
        }
    });
    // auto 模式下 AskUserQuestion 被权限层直接 deny（对齐 PermissionPolicy.ts 的
    // auto 分支）；本测试验证的是 userChoice 的问答回环，用 manual 模式让工具放行。
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        // AskUserQuestion 的 checkPermissions 直接放行：回传 permResult 本身
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        "userChoice" => Some(json!({ "index": 1, "reply": "" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "问个问题", "u-1");
    assert!(harness.wait_query_end());

    // 权限：AskUserQuestion 放行，且**不**带 updatedInput（区别于 buildTool 默认实现）
    let permissions = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(permissions.len(), 1);
    assert_eq!(permissions[0]["toolName"], "AskUserQuestion");
    assert_eq!(permissions[0]["permResult"]["behavior"], "allow");
    assert!(
        permissions[0]["permResult"].get("updatedInput").is_none(),
        "AskUserQuestion 不应带 updatedInput: {}",
        permissions[0]["permResult"]
    );

    // 用户问答：请求载荷带 toolName / message / choices
    let choices = harness.sink.requests_of("userChoice");
    assert_eq!(choices.len(), 1);
    assert_eq!(choices[0]["options"]["toolName"], "AskUserQuestion");
    assert_eq!(choices[0]["options"]["message"], "选哪个？");
    assert_eq!(choices[0]["options"]["choices"][0]["label"], "A");
    assert_eq!(choices[0]["options"]["choices"][1]["label"], "B");

    // tool_result：命中选项时用 label 兜底空 reply，并带上选项下标
    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "success");
    assert_eq!(result["output"], "User response: B (selected option index: 1)");
}

#[test]
fn permission_denied_without_a_reason_uses_the_default_message() {
    let sandbox = Sandbox::new("engine-permission-denied-default");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            // 破坏性命令是 risk 模式下唯一仍会 ask 的一类
            openai_tool_sse("call_1", "Bash", r#"{"command":"dd if=/dev/zero of=x"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "risk");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "ask" })),
        "userChoice" => Some(json!({ "index": 2 })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "执行危险命令", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["output"], "用户拒绝操作");
}

#[test]
fn permission_layer_can_rewrite_the_tool_input() {
    let sandbox = Sandbox::new("engine-permission-rewrite");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["好了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({
            "behavior": "allow",
            "updatedInput": { "command": "echo rewritten" }
        })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "success");
    assert!(result["output"].as_str().unwrap().contains("rewritten"), "got {result}");
    // 确认框不应出现（权限层直接放行）
    assert!(harness.sink.requests_of("userChoice").is_empty());
}

#[test]
fn permission_deny_short_circuits_the_tool() {
    let sandbox = Sandbox::new("engine-permission-deny");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "deny", "message": "策略禁止" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["output"], "策略禁止");
}

#[test]
fn permission_result_that_is_neither_allow_nor_deny_is_rejected() {
    let sandbox = Sandbox::new("engine-permission-unknown");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "maybe" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["output"], "Permission request failed.");
}

#[test]
fn permission_request_failure_is_reported() {
    let sandbox = Sandbox::new("engine-permission-failure");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    // 宿主回失败应答（respond 返回 None → harness 回 ok:false）
    let harness = EngineHarness::start(|_| None);
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["output"], "Permission request failed.");
}

#[test]
fn llm_failures_surface_as_system_messages() {
    let sandbox = Sandbox::new("engine-llm-error");
    let llm = FakeLlm::fixed("data: {\"error\":{\"message\":\"boom\"}}\n\n".to_string());
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "你好", "u-1");
    // 失败提示由 run_consumer 在 run_turn 返回之后、queryEnd 之前发出
    // （错误 message 在 query 内发出，queryEnd 由收尾路径补发）。
    // 这里等系统消息本身，不依赖两个事件的先后竞争。
    assert!(harness.wait_for(
        |sink| sink
            .events_of("message")
            .iter()
            .any(|event| event["data"]["role"] == "system"),
        std::time::Duration::from_secs(30)
    ));

    let message = harness.sink.event_of("message").expect("system message");
    assert_eq!(message["data"]["role"], "system");
    assert!(
        message["data"]["content"].as_str().unwrap().contains("boom"),
        "got {message}"
    );
}

#[test]
fn anthropic_provider_runs_the_same_turn() {
    let sandbox = Sandbox::new("engine-anthropic");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            anthropic_sse("想一想", "", Some(("toolu_1", "Bash", r#"{"command":"echo anthropic"}"#)))
        } else {
            anthropic_sse("", "完成", None)
        }
    });
    sandbox.write_settings(json!({
        "defaultAgentMode": "auto",
        "llm": {
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "k",
                    "defaultModel": "m",
                    "modelConfigs": { "m": { "apiType": "Anthropic" } }
                }
            }
        }
    }));
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    assert_eq!(harness.sink.event_of("toolResult").unwrap()["status"], "success");
    let thinking = harness
        .sink
        .events_of("streamMessage")
        .into_iter()
        .find(|event| event["data"]["role"] == "thinking")
        .expect("thinking stream");
    assert_eq!(thinking["data"]["accumulated"], "想一想");

    // 取带 usage 的那条（`block_stop` 那条 usage 缺省）
    let stream_end = harness
        .sink
        .events_of("streamEnd")
        .into_iter()
        .find(|event| {
            event["data"]["role"] == "assistant" && event["data"].get("usage").is_some()
        })
        .expect("assistant streamEnd");
    assert_eq!(stream_end["data"]["accumulated"], "完成");
    // input = message_start 的 input_tokens + 两个 cache 计数（5 + 3 + 2），
    assert_eq!(stream_end["data"]["usage"]["input_tokens"], 10);
    assert_eq!(stream_end["data"]["usage"]["output_tokens"], 7);
}

#[test]
fn anthropic_start_signature_is_persisted_in_thinking_block() {
    // `content_block_start` 里的初始 signature 与后续
    // `signature_delta` 都要进落盘 assistant 的 thinking block（初始值 + 增量），
    // 否则「思考 + 工具调用」的第二轮请求会因历史 thinking 缺 signature 被拒。
    let sandbox = Sandbox::new("engine-anthropic-start-signature");
    let sse = concat!(
        "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"sig-start\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"想一想\"}}\n\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"-delta\"}}\n\n",
        "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
    )
    .to_string();
    let llm = FakeLlm::fixed(sse);
    sandbox.write_settings(json!({
        "defaultAgentMode": "auto",
        "llm": {
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "k",
                    "defaultModel": "m",
                    "modelConfigs": { "m": { "apiType": "Anthropic" } }
                }
            }
        }
    }));
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    let assistant = messages
        .iter()
        .find(|message| message["type"] == "assistant")
        .expect("assistant message");
    let thinking = assistant["message"]["content"]
        .as_array()
        .expect("content array")
        .iter()
        .find(|block| block["type"] == "thinking")
        .expect("thinking block");
    assert_eq!(thinking["thinking"], "想一想");
    assert_eq!(
        thinking["signature"], "sig-start-delta",
        "初始 signature + 增量都要保留"
    );
}

#[test]
fn anthropic_content_block_start_input_is_persisted_without_delta() {
    // `content_block_start` 自带完整 input、且没有
    // `input_json_delta` 时，tool_use 的 input 就是这一帧给出的对象。
    let sandbox = Sandbox::new("engine-anthropic-start-input");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            concat!(
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Bash\",\"input\":{\"command\":\"echo start-input\"}}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2},\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
            )
            .to_string()
        } else {
            anthropic_sse("", "完成", None)
        }
    });
    sandbox.write_settings(json!({
        "defaultAgentMode": "auto",
        "llm": {
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "k",
                    "defaultModel": "m",
                    "modelConfigs": { "m": { "apiType": "Anthropic" } }
                }
            }
        }
    }));
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());
    assert_eq!(harness.sink.event_of("toolResult").unwrap()["status"], "success");

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    let tool_use = messages
        .iter()
        .filter(|message| message["type"] == "assistant")
        .flat_map(|message| message["message"]["content"].as_array().cloned().unwrap_or_default())
        .find(|block| block["type"] == "tool_use")
        .expect("tool_use block");
    assert_eq!(tool_use["input"], json!({ "command": "echo start-input" }));
}

#[test]
fn stream_end_usage_carries_cache_keys_even_without_details() {
    // OpenAI 侧 usage 恒带 cache 两键（缺省 0），
    // `streamEnd` 事件的 usage 不能省略它们（WebView 读同一份字段集合）。
    let sandbox = Sandbox::new("engine-usage-cache-keys");
    let llm = FakeLlm::fixed(crate::test_support::openai_thinking_sse("想", "答"));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    // 块级收尾：`block_stop` 那条 usage 缺省，带 usage 的是 `message_delta` 那条
    let stream_end = harness
        .sink
        .events_of("streamEnd")
        .into_iter()
        .find(|event| {
            event["data"]["role"] == "assistant" && event["data"].get("usage").is_some()
        })
        .expect("assistant streamEnd");
    assert_eq!(stream_end["data"]["accumulated"], "答");
    let usage = &stream_end["data"]["usage"];
    assert_eq!(usage["input_tokens"], 11);
    assert_eq!(usage["output_tokens"], 22);
    assert_eq!(usage["cache_read_input_tokens"], 0);
    assert_eq!(usage["cache_creation_input_tokens"], 0);
    assert!(usage.get("reasoning_tokens").is_none(), "got {usage}");
}

/// `streamEnd` 的 `(role, accumulated, 是否带 usage, streamId)`
type StreamEndShape = (String, String, bool, String);

fn stream_end_shapes(capture: &crate::test_support::Capture) -> Vec<StreamEndShape> {
    capture
        .events_of("streamEnd")
        .iter()
        .map(|event| {
            (
                event["data"]["role"].as_str().unwrap_or("").to_string(),
                event["data"]["accumulated"].as_str().unwrap_or("").to_string(),
                event["data"].get("usage").is_some(),
                event["data"]["streamId"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect()
}

/// 断言「每个内容块结束各发一条 usage 缺省的 `streamEnd`，流结束再按角色各发一条
/// 带 usage 的」，且 `streamId` 为块级、同一块内一致、不同块不同。
fn assert_block_granular_stream_ends(harness: &EngineHarness, thinking: &str, text: &str) {
    let shapes = stream_end_shapes(&harness.sink);
    let summary: Vec<(String, String, bool)> = shapes
        .iter()
        .map(|(role, accumulated, has_usage, _)| {
            (role.clone(), accumulated.clone(), *has_usage)
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("thinking".to_string(), thinking.to_string(), false),
            ("assistant".to_string(), text.to_string(), false),
            ("thinking".to_string(), thinking.to_string(), true),
            ("assistant".to_string(), text.to_string(), true),
        ],
        "streamEnd 序列: {shapes:?}"
    );

    let (_, _, _, thinking_id) = &shapes[0];
    let (_, _, _, text_id) = &shapes[1];
    assert!(thinking_id.starts_with("blk_"), "got {thinking_id}");
    assert!(text_id.starts_with("blk_"), "got {text_id}");
    assert_ne!(thinking_id, text_id, "不同块必须用不同 streamId");
    assert_eq!(&shapes[2].3, thinking_id, "同一块的两条 streamEnd 共用 streamId");
    assert_eq!(&shapes[3].3, text_id);

    // `streamMessage` 与对应块的 `streamEnd` 共用同一个块级 streamId
    let messages = harness.sink.events_of("streamMessage");
    let thinking_msg = messages
        .iter()
        .find(|event| event["data"]["role"] == "thinking")
        .expect("thinking streamMessage");
    let text_msg = messages
        .iter()
        .find(|event| event["data"]["role"] == "assistant")
        .expect("assistant streamMessage");
    assert_eq!(thinking_msg["data"]["streamId"].as_str().unwrap(), thinking_id);
    assert_eq!(text_msg["data"]["streamId"].as_str().unwrap(), text_id);
}

#[test]
fn anthropic_stream_end_granularity() {
    // Anthropic 的 `content_block_stop` 发一条 usage 缺省的
    // `streamEnd`，`message_delta` 再发一条带 usage 的；`streamId` 为块级。
    let sandbox = Sandbox::new("engine-anthropic-block-granularity");
    let llm = FakeLlm::fixed(crate::test_support::anthropic_sse("想一想", "完成", None));
    sandbox.write_llm_settings_with_api_type(&llm.base_url, "auto", "Anthropic");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    assert_block_granular_stream_ends(&harness, "想一想", "完成");
}

#[test]
fn openai_stream_end_granularity() {
    // Chat Completions 没有显式块边界，适配器按角色切换合成 block_start / block_stop；
    // 引擎侧的 `streamEnd` 粒度与 Anthropic 路径一致。
    let sandbox = Sandbox::new("engine-openai-block-granularity");
    let llm = FakeLlm::fixed(crate::test_support::openai_thinking_sse("想", "答"));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    assert_block_granular_stream_ends(&harness, "想", "答");
}

#[test]
fn pure_tool_use_turn_emits_one_usage_carrying_stream_end() {
    // 纯 tool_use 轮次：没有 thinking / text，仍要补一条 `accumulated` 为空、
    // 带 usage 的 assistant `streamEnd`（`streamId` 回退到轮次级 `msg_*`）。
    let sandbox = Sandbox::new("engine-pure-tool-use-stream-end");
    // 第一轮纯 tool_use，第二轮给文本收尾（否则假 LLM 会无限重复工具调用）
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            crate::test_support::anthropic_sse(
                "",
                "",
                Some(("toolu_1", "Bash", r#"{"command":"echo hi"}"#)),
            )
        } else {
            crate::test_support::anthropic_sse("", "完成", None)
        }
    });
    sandbox.write_llm_settings_with_api_type(&llm.base_url, "auto", "Anthropic");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    // 第一轮（纯 tool_use）只有一条 streamEnd；第二轮给文本收尾，另有自己的事件
    let shapes = stream_end_shapes(&harness.sink);
    let (role, accumulated, has_usage, stream_id) = &shapes[0];
    assert_eq!(role, "assistant");
    assert!(accumulated.is_empty(), "纯 tool_use 轮次的 accumulated 为空");
    assert!(has_usage, "纯 tool_use 轮次的 streamEnd 必须带 usage");
    assert!(stream_id.starts_with("msg_"), "got {stream_id}");
}

#[test]
fn queued_message_is_flushed_before_the_next_llm_round() {
    // 多轮工具调用期间到达的用户消息，必须在**下一次 LLM 请求前**进入上下文
    // 而不是等整轮结束再单独起一轮。这里让假 LLM 在处理第一轮请求时就提交第二条消息。
    let sandbox = Sandbox::new("engine-queue");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let submitter = Arc::clone(&slot);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            if let Some(core) = submitter.lock().unwrap().as_ref() {
                core.on_user_message(&json!({
                    "sessionId": "s1",
                    "content": "第二条",
                    "uuid": "u-2",
                    "workspacePath": null,
                }));
            }
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["收到"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "第一条", "u-1");

    assert!(
        harness.wait_for(
            |sink| sink.events_of("queryEnd").len() >= 1,
            std::time::Duration::from_secs(30),
        ),
        "轮次应当跑完: {:?}",
        harness.sink.event_types()
    );

    let requests = bodies.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "排队消息应并入第一轮的第二次请求，而不是另起一轮"
    );
    let second = requests[1]["messages"].as_array().unwrap();
    let queued_index = second
        .iter()
        .position(|message| message["role"] == "user" && message["content"] == "第二条")
        .unwrap_or_else(|| panic!("第二次请求缺少排队消息: {second:?}"));
    // 排队消息在 tool_result 之后（下一次请求的末尾）
    assert!(
        second
            .iter()
            .take(queued_index)
            .any(|message| message["role"] == "tool"),
        "排队消息应排在 tool_result 之后: {second:?}"
    );
    drop(requests);

    // 落盘顺序：用户 → assistant(tool_use) → tool_result → 排队用户 → assistant
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages[0]["uuid"], "u-1");
    assert_eq!(messages[1]["type"], "assistant");
    assert_eq!(messages[2]["type"], "user");
    assert_eq!(messages[3]["uuid"], "u-2");
    assert_eq!(messages[4]["type"], "assistant");
}

#[test]
fn agent_reply_is_flushed_before_the_next_llm_round() {
    // 子代理 Reply（UI 上的 From 消息）与用户消息同一口径：多轮工具调用期间到达的
    // 自动消息必须在**下一次 LLM 请求前**进入上下文，
    // 而不是等整轮结束再单独起一轮。
    let sandbox = Sandbox::new("engine-agent-queue");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let submitter = Arc::clone(&slot);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            if let Some(core) = submitter.lock().unwrap().as_ref() {
                core.enqueue_agent_message("s1", "子代理回复", "agent", "sub-1");
            }
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["收到"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "第一条", "u-1");

    assert!(
        harness.wait_for(
            |sink| sink.events_of("queryEnd").len() >= 1,
            std::time::Duration::from_secs(30),
        ),
        "轮次应当跑完: {:?}",
        harness.sink.event_types()
    );

    let requests = bodies.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "自动消息应并入第一轮的第二次请求，而不是另起一轮"
    );
    let second = requests[1]["messages"].as_array().unwrap();
    let agent_index = second
        .iter()
        .position(|message| message["role"] == "user" && message["content"] == "子代理回复")
        .unwrap_or_else(|| panic!("第二次请求缺少子代理回复: {second:?}"));
    // 自动消息在 tool_result 之后（下一次请求的末尾）
    assert!(
        second
            .iter()
            .take(agent_index)
            .any(|message| message["role"] == "tool"),
        "子代理回复应排在 tool_result 之后: {second:?}"
    );
    drop(requests);

    // 落盘顺序：用户 → assistant(tool_use) → tool_result → 子代理回复 → assistant
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages[0]["uuid"], "u-1");
    assert_eq!(messages[1]["type"], "assistant");
    assert_eq!(messages[2]["type"], "user");
    assert_eq!(messages[3]["origin"], "agent");
    assert_eq!(messages[4]["type"], "assistant");
}

#[test]
fn queued_user_message_merges_with_agent_replies_in_one_round() {
    // 用户消息与自动消息同时排队时并入同一轮（对齐 `consumeQueuedOnce` 的
    // 「Agent + 用户合并」分支）：自动消息先追加、用户消息放末尾。
    let sandbox = Sandbox::new("engine-queue-merge");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let submitter = Arc::clone(&slot);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            if let Some(core) = submitter.lock().unwrap().as_ref() {
                core.enqueue_agent_message("s1", "子代理回复", "agent", "sub-1");
                core.on_user_message(&json!({
                    "sessionId": "s1",
                    "content": "第二条",
                    "uuid": "u-2",
                    "workspacePath": null,
                }));
            }
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["收到"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "第一条", "u-1");

    assert!(
        harness.wait_for(
            |sink| sink.events_of("queryEnd").len() >= 1,
            std::time::Duration::from_secs(30),
        ),
        "轮次应当跑完: {:?}",
        harness.sink.event_types()
    );

    let requests = bodies.lock().unwrap();
    assert_eq!(requests.len(), 2, "两条排队消息应并入同一轮，而不是各自起一轮");
    let second = requests[1]["messages"].as_array().unwrap();
    // 两条都是 user 角色、且相邻，请求组装时被 `merge_consecutive_same_role` 合并成
    // 一条 user 消息：自动消息在前、用户消息在末尾。
    let merged = second
        .iter()
        .filter_map(|message| message["content"].as_str())
        .find(|content| content.contains("子代理回复") && content.contains("第二条"))
        .unwrap_or_else(|| panic!("第二次请求缺少合并后的排队消息: {second:?}"));
    assert!(
        merged.find("子代理回复") < merged.find("第二条"),
        "自动消息应排在排队用户消息之前: {merged}"
    );
    drop(requests);

    // 落盘顺序：用户 → assistant(tool_use) → tool_result → 子代理回复 → 排队用户 → assistant
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages[3]["origin"], "agent");
    assert_eq!(messages[4]["uuid"], "u-2");
}

#[test]
fn message_submitted_after_a_turn_starts_a_new_turn() {
    let sandbox = Sandbox::new("engine-queue-sequential");
    let llm = FakeLlm::fixed(openai_text_sse(&["收到"]));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "第一条", "u-1");
    assert!(harness.wait_query_end());
    submit(&harness, "s1", "第二条", "u-2");
    assert!(harness.wait_for(
        |sink| sink.events_of("queryEnd").len() == 2,
        std::time::Duration::from_secs(30)
    ), "两条消息都应当各自跑完一轮: {:?}", harness.sink.event_types());

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    assert_eq!(messages[0]["uuid"], "u-1");
    assert_eq!(messages[1]["message"]["content"][0]["text"], "收到");
    assert_eq!(messages[2]["uuid"], "u-2");
    assert_eq!(messages[3]["message"]["content"][0]["text"], "收到");
}

#[test]
fn user_message_carries_the_workspace_path() {
    let sandbox = Sandbox::new("engine-workspace-path");
    let llm = FakeLlm::fixed(openai_text_sse(&["好"]));
    sandbox.write_llm_settings(&llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({
        "sessionId": "s1",
        "content": "hi",
        "uuid": "u-1",
        "workspacePath": format!("{workspace}/"),
    }));
    assert!(harness.wait_query_end());

    // 尾部分隔符被归一化，且会话状态记住了工作目录
    assert_eq!(config::session_workspace("s1").as_deref(), Some(workspace.as_str()));
    assert_eq!(
        harness.core.session("s1").lock().unwrap().project.as_deref(),
        Some(workspace.as_str())
    );
}

#[test]
fn abort_marks_the_session_for_cancellation() {
    let _sandbox = Sandbox::new("engine-abort");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    assert!(!state.lock().unwrap().cancel.load(Ordering::Relaxed));

    // 完全空闲：按钮为灰，abort 是空操作（只兜住渲染到点击之间的竞态）
    harness.core.on_abort("s1");
    assert!(!state.lock().unwrap().cancel.load(Ordering::Relaxed));

    // 前台在跑：第一阶段置 cancel（对齐 `QueryEngine.interruptForeground`）
    state.lock().unwrap().running = true;
    harness.core.on_abort("s1");
    assert!(state.lock().unwrap().cancel.load(Ordering::Relaxed));

    // 不存在的会话是空操作
    harness.core.on_abort("ghost");
}

#[test]
fn abort_with_pending_tool_uses_backfills_tool_results_and_reports_interruption() {
    // 流式期间被中止：assistant 消息已带 tool_use 落盘，必须补 tool_result
    // （is_canceled=true），并追加 `*User Interrupted*` 系统消息，
    // 否则历史里留下孤儿 tool_use，下一轮请求会被 Anthropic 拒绝。
    let sandbox = Sandbox::new("engine-abort-pending-tool");
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let aborter = Arc::clone(&slot);
    // 分段写：先写完整的 tool_call（Core 会解析出 tool_use），再在两次写之间中止，
    // 最后写 finish_reason / [DONE]。这样 `cancelled == true` 且 `tool_uses` 非空，
    // 精确复现「assistant 已落盘带 tool_use，但工具未执行」的中断窗口。
    let llm = FakeLlm::start_gated(
        |_, _| {
            let first = format!(
                "data: {}\n\n",
                json!({ "choices": [{ "delta": { "tool_calls": [
                    { "index": 0, "id": "call_1", "function": {
                        "name": "Bash", "arguments": "{\"command\":\"touch should-not-run\"}" } }
                ] } }] })
            );
            let second = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
            );
            (first, second)
        },
        move || {
            // 等 Core 把 `first` 里的 tool_call 解析完（此时它阻塞在下一行读上，
            // 而 cancel 只在「读下一行之前」被检查），再置 cancel。
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Some(core) = aborter.lock().unwrap().as_ref() {
                core.on_abort("s1");
            }
        },
    );
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    // 工具不应真的执行
    assert!(!sandbox.workspace.join("should-not-run").exists());

    // tool_result 事件 + 落盘的 tool_result block
    let results = harness.sink.events_of("toolResult");
    assert_eq!(results.len(), 1, "got {results:?}");
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[0]["output"], "Command was interrupted");

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    let blocks = messages
        .iter()
        .filter(|message| message["type"] == "user")
        .filter_map(|message| message["message"]["content"].as_array().cloned())
        .flatten()
        .filter(|block| block["type"] == "tool_result")
        .collect::<Vec<_>>();
    assert_eq!(blocks.len(), 1, "got {messages:?}");
    assert_eq!(blocks[0]["tool_use_id"], "call_1");
    assert_eq!(blocks[0]["content"], "Command was interrupted");
    assert_eq!(blocks[0]["exit_code"], -1);
    assert_eq!(blocks[0]["is_canceled"], true);

    // `*User Interrupted*`：UI 事件带 once 标记；记 meta.json 的 `onceMessage`，
    // 不落 jsonl（`docs/hosts/webview-ui.md` 第 11 节）
    let message = harness.sink.event_of("message").expect("interrupted message");
    assert_eq!(message["data"]["role"], "system");
    assert_eq!(message["data"]["content"], "*User Interrupted*");
    assert_eq!(message["data"]["once"], true);
    let metadata = history::load_metadata("s1", &workspace).expect("meta");
    assert_eq!(metadata["onceMessage"]["content"], "*User Interrupted*");
    assert!(
        !messages
            .iter()
            .any(|message| message["type"] == "system"
                && message["content"] == "*User Interrupted*"),
        "中断提示不得落盘：got {messages:?}"
    );
}

#[test]
fn abort_during_responses_stream_reports_interruption_not_api_error() {
    // 远程 Core 走 Responses API 时，用户 abort 会让本端提前掐断流，服务端不会补
    // `response.completed`。这属于「用户中断」，不得按 LLM 故障回显
    let sandbox = Sandbox::new("engine-abort-responses");
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let aborter = Arc::clone(&slot);
    // 分段写：先写一个未完成的 output_item，在两次写之间 abort，最后写 [DONE]。
    let llm = FakeLlm::start_gated(
        |_, _| {
            let first = format!(
                "data: {}\n\n",
                json!({
                    "type": "response.output_item.added",
                    "item": { "type": "reasoning", "id": "rs_1", "summary": [] },
                })
            );
            let second = "data: [DONE]\n\n".to_string();
            (first, second)
        },
        move || {
            if let Some(core) = aborter.lock().unwrap().as_ref() {
                core.on_abort("s1");
            }
        },
    );
    sandbox.write_llm_settings_with_api_type(&llm.base_url, "auto", "Responses");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "你好", "u-1");
    assert!(harness.wait_query_end());

    let messages = harness.sink.events_of("message");
    assert!(
        !messages.iter().any(|event| event["data"]["content"]
            .as_str()
            .unwrap_or("")
            .contains("LLM API Error")),
        "abort 不得按 LLM 故障回显：{messages:?}"
    );
    assert!(
        messages.iter().any(|event| {
            event["data"]["role"] == "system"
                && event["data"]["content"] == "*User Interrupted*"
        }),
        "应当上报 *User Interrupted*：{messages:?}"
    );
}

#[test]
fn bash_streams_tool_progress_frames() {
    // Bash 的流式输出经 `toolProgress` 帧实时推给 UI（而不是等命令结束）。
    let sandbox = Sandbox::new("engine-tool-progress");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hello-progress"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let events = harness.sink.events_of("toolProgress");
    assert!(!events.is_empty(), "应上报 toolProgress：{:?}", harness.sink.event_types());
    let event = &events[0];
    assert_eq!(event["sessionId"], "s1");
    assert_eq!(event["toolUseId"], "call_1");
    assert_eq!(event["progress"]["type"], "bash_progress");
    assert_eq!(event["progress"]["timeoutMs"], 60_000);
    // `taskId` 不应出现（序列化时会被丢掉）
    assert!(
        event["progress"].get("taskId").is_none(),
        "got {}",
        event["progress"]
    );
    assert!(event["progress"]["elapsedTimeSeconds"].as_f64().is_some());
    assert!(event["progress"]["totalLines"].as_u64().is_some());
    let joined: String = events
        .iter()
        .map(|event| event["progress"]["output"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(joined.contains("hello-progress"), "got {joined:?}");
}

#[test]
fn failed_tool_results_get_the_executing_prefix() {
    // `call()` 抛错的 tool_result 内容加 `Error executing <Tool>: `，
    // 但 UI 的 `toolResult.output` 用裸消息。
    let sandbox = Sandbox::new("engine-tool-error-prefix");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Read", r#"{"file_path":"missing.txt"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "读一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["status"], "error");
    let bare = result["output"].as_str().unwrap();
    assert!(bare.starts_with("File not found:"), "got {result}");
    assert!(!bare.starts_with("Error executing"), "UI 用裸消息: {result}");

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    let content = messages
        .iter()
        .filter_map(|message| message["message"]["content"].as_array().cloned())
        .flatten()
        .find(|block| block["type"] == "tool_result")
        .map(|block| block["content"].as_str().unwrap().to_string())
        .expect("tool_result block");
    assert!(
        content.starts_with("Error executing Read: File not found:"),
        "got {content}"
    );
}

#[test]
fn unknown_tools_are_reported_without_the_executing_prefix() {
    let sandbox = Sandbox::new("engine-unknown-tool");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "NoSuchTool", r#"{}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "试试", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["output"], "Error: Tool \"NoSuchTool\" not found");
    assert_eq!(result["status"], "error");
}

#[test]
fn abort_during_the_tool_loop_skips_the_next_llm_round() {
    let sandbox = Sandbox::new("engine-cancel-mid-turn");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_, body| {
        captured.lock().unwrap().push(body.clone());
        openai_tool_sse("call_1", "Bash", r#"{"command":"touch should-not-run"}"#)
    });
    prepare(&sandbox, &llm.base_url, "manual");

    // 权限确认时顺手取消：工具**不执行**，补 `Command was aborted before execution` 的取消结果，
    // 并且不再回到 LLM 要第二轮。
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let responder_slot = Arc::clone(&slot);
    let harness = EngineHarness::start(move |request| {
        if request["type"] == "toolPermissionRequested" {
            if let Some(core) = responder_slot.lock().unwrap().as_ref() {
                core.on_abort("s1");
            }
            return Some(json!({ "behavior": "allow" }));
        }
        Some(json!({}))
    });
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));

    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    assert_eq!(
        bodies.lock().unwrap().len(),
        1,
        "取消后不应再发起第二轮 LLM 调用"
    );
    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["status"], "error");
    assert_eq!(result["output"], "Command was aborted before execution");
    assert_eq!(harness.sink.events_of("toolResult").len(), 1);
    // 工具没有真的执行
    assert!(!sandbox.workspace.join("should-not-run").exists());

    // 落盘：tool_result 带 exit_code -1 / is_canceled true，并补一条 `*User Interrupted*`
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let messages = history::load_messages("s1", &workspace);
    let tool_result = messages
        .iter()
        .find(|message| {
            message.get("type").and_then(Value::as_str) == Some("user")
                && message
                    .get("message")
                    .and_then(|inner| inner.get("content"))
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_result")
                        })
                    })
                    .unwrap_or(false)
        })
        .expect("persisted tool_result");
    let block = &tool_result["message"]["content"][0];
    assert_eq!(block["content"], "Command was aborted before execution");
    assert_eq!(block["exit_code"], -1);
    assert_eq!(block["is_canceled"], true);

    let system = harness
        .sink
        .events_of("message")
        .into_iter()
        .find(|event| event["data"]["role"] == "system")
        .expect("interrupted system message");
    assert_eq!(system["data"]["content"], "*User Interrupted*");
    // 一次性通知：UI 事件带 once 标记；记 meta.json 的 `onceMessage`，不落 jsonl
    // （`docs/hosts/webview-ui.md` 第 11 节）
    assert_eq!(system["data"]["once"], true);
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    assert_eq!(
        history::load_metadata("s1", &workspace).expect("meta")["onceMessage"]["content"],
        "*User Interrupted*"
    );
    assert!(
        !history::load_messages("s1", &workspace)
            .iter()
            .any(|message| message["type"] == "system"
                && message["content"] == "*User Interrupted*"),
        "中断提示不得落盘"
    );
}

#[test]
fn abort_during_tool_execution_reports_interruption() {
    // 工具**已开始执行**后才中止：Bash 子进程被杀 → tool_result 为
    // `Command was interrupted`，且本轮收尾必须上报 `*User Interrupted*`
    let sandbox = Sandbox::new("engine-abort-mid-execution");
    // 先建标记文件证明工具已开跑，再长睡等待 abort（cwd 即 workspace）。
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Bash",
                r#"{"command":"touch started.marker && sleep 30"}"#,
            )
        } else {
            openai_text_sse(&["不应到达第二轮"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");

    // 等工具真的开始执行再中止，确保命中「执行中到达」的窗口
    let marker = sandbox.workspace.join("started.marker");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !marker.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(marker.exists(), "工具未开始执行，无法复现执行中中止");
    harness.core.on_abort("s1");

    assert!(harness.wait_query_end());

    let results = harness.sink.events_of("toolResult");
    assert_eq!(results.len(), 1, "got {results:?}");
    assert_eq!(results[0]["status"], "error");
    assert!(
        results[0]["output"]
            .as_str()
            .unwrap_or("")
            .contains("Command was interrupted"),
        "got {results:?}"
    );
    // 中止后不再回到 LLM
    let system = harness
        .sink
        .events_of("message")
        .into_iter()
        .find(|event| event["data"]["role"] == "system")
        .expect("interrupted system message");
    assert_eq!(system["data"]["content"], "*User Interrupted*");
    // 一次性通知：UI 事件带 once 标记；记 meta.json 的 `onceMessage`，不落 jsonl
    // （`docs/hosts/webview-ui.md` 第 11 节）
    assert_eq!(system["data"]["once"], true);
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    assert_eq!(
        history::load_metadata("s1", &workspace).expect("meta")["onceMessage"]["content"],
        "*User Interrupted*"
    );
    assert!(
        !history::load_messages("s1", &workspace)
            .iter()
            .any(|message| message["type"] == "system"
                && message["content"] == "*User Interrupted*"),
        "中断提示不得落盘"
    );
}

// ==================== 权限请求：允许路径也要上架卡片 ====================

/// **允许**的工具也要发一次
/// `toolPermissionRequested`（UI 借此上架工具卡片；Edit / Write 还靠它写 `_meta`），
/// 而不是只在 `ask` 时才发。
#[test]
fn allowed_tool_still_emits_the_permission_request() {
    let sandbox = Sandbox::new("engine-allow-permission-request");
    std::fs::write(sandbox.workspace.join("sample.txt"), "hello\n").unwrap();
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Read", r#"{"file_path":"sample.txt"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    // 真实 UI 的 ToolHandler 原样回传 permResult；allow 不再弹确认框
    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "读一下", "u-1");
    assert!(harness.wait_query_end());

    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1, "允许的工具也要请求一次权限（上架卡片）");
    let request = &requests[0];
    assert_eq!(request["toolName"], "Read");
    assert_eq!(request["permResult"]["behavior"], "allow");
    // `buildTool` 默认 checkPermissions 返回 updatedInput = 规范化入参
    assert_eq!(request["permResult"]["updatedInput"]["file_path"], "sample.txt");
    // displayArgs 展开为会话工作目录下的绝对路径
    let expected = sandbox
        .workspace
        .join("sample.txt")
        .to_string_lossy()
        .to_string();
    assert_eq!(request["displayArgs"]["file_path"], expected);
    assert!(
        harness.sink.requests_of("userChoice").is_empty(),
        "allow 不应再弹确认框"
    );

    let result = harness.sink.event_of("toolResult").expect("toolResult");
    assert_eq!(result["status"], "success");

    // 授权前一次、执行前再一次 toolCall
    assert_eq!(
        harness.sink.events_of("toolCall").len(),
        2,
        "授权前 / 执行前各发一次 toolCall"
    );

    // 执行前追加 `_meta.confirmTimestamp`，历史回放时与 toolCallTimestamp 合并
    let messages = crate::history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let block = messages
        .iter()
        .flat_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .expect("assistant tool_use block");
    assert!(
        block["_meta"]["toolCallTimestamp"].as_u64().is_some(),
        "toolCallTimestamp 应保留"
    );
    assert!(
        block["_meta"]["confirmTimestamp"].as_u64().is_some(),
        "confirmTimestamp 应写入并回放"
    );
}

/// Edit 的权限请求要带上 diff 预览字段（宿主据此写 tool_use 的 `_meta`、
/// webview 据此渲染卡片 diff），路径展开为绝对路径。
#[test]
fn edit_permission_request_carries_the_diff_preview() {
    let sandbox = Sandbox::new("engine-edit-permission-preview");
    std::fs::write(sandbox.workspace.join("a.txt"), "alpha\nbeta\ngamma\n").unwrap();
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Edit",
                r#"{"file_path":"a.txt","old_string":"beta","new_string":"BETA"}"#,
            )
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    // allow_all：权限结果保持 ask（用户选择框 index 0 = 允许）
    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "改一下", "u-1");
    assert!(harness.wait_query_end());

    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1);
    let perm = &requests[0]["permResult"];
    assert_eq!(perm["behavior"], "ask");
    assert_eq!(perm["beforeContent"], "alpha\nbeta\ngamma\n");
    assert_eq!(perm["afterContent"], "alpha\nBETA\ngamma\n");
    assert_eq!(perm["contextBefore"], json!(["alpha"]));
    assert_eq!(perm["contextAfter"], json!(["gamma"]));
    assert_eq!(perm["startLine"], 2);
    assert_eq!(perm["endLine"], 2);
    assert_eq!(perm["lineEndings"], "LF");

    let display = &requests[0]["displayArgs"];
    let expected_path = sandbox.workspace.join("a.txt").to_string_lossy().to_string();
    assert_eq!(display["file_path"], expected_path);
    assert_eq!(display["old_string"], "beta");
    assert_eq!(display["new_string"], "BETA");
    assert_eq!(display["replace_all"], false);
    assert_eq!(display["startLine"], 2);
    assert_eq!(display["endLine"], 2);

    // 用户允许后真的写盘
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "alpha\nBETA\ngamma\n"
    );
}

/// auto 模式把 Edit 的 ask 自动放行为 allow，但 diff 字段必须保留
/// （否则「无授权流程」的用户看不到自动应用的改动）。
#[test]
fn auto_mode_edit_keeps_the_diff_in_the_allowed_permission_result() {
    let sandbox = Sandbox::new("engine-edit-auto-diff");
    std::fs::write(sandbox.workspace.join("a.txt"), "alpha\nbeta\n").unwrap();
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Edit",
                r#"{"file_path":"a.txt","old_string":"beta","new_string":"BETA"}"#,
            )
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "改一下", "u-1");
    assert!(harness.wait_query_end());

    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["permResult"]["behavior"], "allow");
    assert_eq!(requests[0]["permResult"]["beforeContent"], "alpha\nbeta\n");
    assert_eq!(requests[0]["permResult"]["afterContent"], "alpha\nBETA\n");
    assert_eq!(requests[0]["displayArgs"]["beforeContent"], "alpha\nbeta\n");
    assert_eq!(requests[0]["displayArgs"]["afterContent"], "alpha\nBETA\n");
    assert!(
        harness.sink.requests_of("userChoice").is_empty(),
        "auto 模式不应弹确认框"
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "alpha\nBETA\n"
    );
}

/// Write 新建文件：permResult.beforeContent = null（回滚时删除文件），
/// displayArgs 带 content / contentPreview / totalLines。
#[test]
fn write_permission_request_carries_the_preview_fields() {
    let sandbox = Sandbox::new("engine-write-permission-preview");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Write",
                r#"{"file_path":"new.txt","content":"hello\nworld"}"#,
            )
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "写个文件", "u-1");
    assert!(harness.wait_query_end());

    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1);
    let perm = &requests[0]["permResult"];
    assert_eq!(perm["behavior"], "ask");
    assert!(perm["beforeContent"].is_null(), "新建文件 beforeContent 必须是 null");
    assert_eq!(perm["afterContent"], "hello\nworld");

    let display = &requests[0]["displayArgs"];
    let expected_path = sandbox.workspace.join("new.txt").to_string_lossy().to_string();
    assert_eq!(display["file_path"], expected_path);
    assert_eq!(display["content"], "hello\nworld");
    assert_eq!(display["contentPreview"], "hello\nworld");
    assert_eq!(display["totalLines"], 2);
    assert_eq!(display["isTruncated"], false);
    assert!(display["beforeContent"].is_null());
    assert_eq!(display["afterContent"], "hello\nworld");

    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("new.txt")).unwrap(),
        "hello\nworld"
    );
}

/// 默认 checkPermissions 回传的 `updatedInput`
/// 是 zod 规范化产物；与当前内存入参不同（如 `offset: "2"` 被 coerce 成 `2`）时，
/// 追加一条 `tool_use_update`，保证历史恢复后拿到规范化入参。
#[test]
fn updated_input_coercion_is_persisted_as_a_tool_use_update() {
    let sandbox = Sandbox::new("engine-updated-input-coercion");
    std::fs::write(sandbox.workspace.join("sample.txt"), "l1\nl2\nl3\n").unwrap();
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "Read",
                r#"{"file_path":"sample.txt","offset":"2"}"#,
            )
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "读一下", "u-1");
    assert!(harness.wait_query_end());

    // permResult.updatedInput 是规范化后的数字 offset
    let request = &harness.sink.requests_of("toolPermissionRequested")[0];
    assert_eq!(request["permResult"]["updatedInput"]["offset"], 2);

    // 历史恢复时 tool_use 的 input 被回放为数字 offset（不是原始字符串）
    let messages = crate::history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let block = messages
        .iter()
        .flat_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        .expect("assistant tool_use block");
    assert_eq!(
        block["input"]["offset"], 2,
        "coerce 后的 offset 应落盘并回放: {block}"
    );
}

// ==================== 权限拒绝：剩余工具取消 / 本轮终止 ====================

/// 一条 OpenAI SSE 里返回**多个** tool_call（并行工具调用）。
fn openai_multi_tool_sse(calls: &[(&str, &str, &str)]) -> String {
    let mut out = String::new();
    for (index, (id, name, arguments)) in calls.iter().enumerate() {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "choices": [{ "delta": { "tool_calls": [
                { "index": index, "id": id, "function": { "name": name, "arguments": arguments } }
            ] } }] })
        ));
    }
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

#[test]
fn permission_deny_cancels_the_remaining_tools_in_the_batch() {
    // 一个工具被 deny 时，
    // 剩余工具不再执行、也不请求权限，而是逐条补发取消结果（is_canceled=true）。
    let sandbox = Sandbox::new("engine-permission-cancel-remaining");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_multi_tool_sse(&[
                ("call_1", "Bash", r#"{"command":"touch first.txt"}"#),
                ("call_2", "Bash", r#"{"command":"touch second.txt"}"#),
            ])
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => {
            if request["toolUseId"] == "call_1" {
                Some(json!({ "behavior": "deny", "message": "策略禁止" }))
            } else {
                Some(json!({ "behavior": "allow" }))
            }
        }
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑两条", "u-1");
    assert!(harness.wait_query_end());

    let results = harness.sink.events_of("toolResult");
    assert_eq!(results.len(), 2, "被拒工具 + 剩余工具都要有 toolResult");
    assert_eq!(results[0]["toolUseId"], "call_1");
    assert_eq!(results[0]["output"], "策略禁止");
    assert_eq!(results[0]["status"], "error");
    assert_eq!(results[1]["toolUseId"], "call_2");
    assert_eq!(
        results[1]["output"],
        "Tool \"Bash\" was canceled because a previous tool in the batch was denied"
    );
    assert_eq!(results[1]["status"], "error");

    // 剩余工具既不请求权限也不执行
    assert_eq!(harness.sink.requests_of("toolPermissionRequested").len(), 1);
    assert!(!sandbox.workspace.join("first.txt").exists());
    assert!(!sandbox.workspace.join("second.txt").exists());

    // 落盘的 tool_result block：被拒 exit_code=-1/is_canceled=false，取消 exit_code=-1/is_canceled=true
    let messages = crate::history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let blocks = messages
        .iter()
        .find_map(|message| {
            let content = message.get("message")?.get("content")?.as_array()?;
            if content
                .first()
                .and_then(|block| block.get("type"))
                .and_then(Value::as_str)
                == Some("tool_result")
            {
                Some(content.clone())
            } else {
                None
            }
        })
        .expect("应当落盘一条 tool_result 消息");
    assert_eq!(blocks[0]["is_canceled"], false);
    assert_eq!(blocks[0]["exit_code"], -1);
    assert_eq!(blocks[1]["is_canceled"], true);
    assert_eq!(blocks[1]["exit_code"], -1);

    // checkPermissions / UI deny 不设置 shouldTerminate：结果仍交回 LLM
    assert_eq!(harness.sink.events_of("aiBegin").len(), 2);
}

#[test]
fn permission_refusal_without_a_reason_terminates_the_turn() {
    // `shouldTerminate = !hasReply`——不带原因地拒绝 → 本轮直接结束，
    // 补发 `*User Interrupted*` 且不再回 LLM。
    let sandbox = Sandbox::new("engine-permission-terminate");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["不该被调用"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "ask" })),
        "userChoice" => Some(json!({ "index": 1 })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["output"], "用户拒绝操作");
    assert!(!sandbox.workspace.join("marker.txt").exists());
    assert_eq!(
        harness.sink.events_of("aiBegin").len(),
        1,
        "不带原因地拒绝后不应再发起 LLM 请求"
    );
    let interrupted = harness
        .sink
        .events_of("message")
        .iter()
        .any(|event| {
            event["data"]["role"] == "system" && event["data"]["content"] == "*User Interrupted*"
        });
    assert!(interrupted, "应当上报 *User Interrupted* 系统消息");
}

#[test]
fn permission_refusal_with_a_reason_continues_the_turn() {
    // 带了拒绝原因说明用户还想继续对话 → 结果交回 LLM 再问一轮。
    let sandbox = Sandbox::new("engine-permission-refusal-reason");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"touch marker.txt"}"#)
        } else {
            openai_text_sse(&["换个方式"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "ask" })),
        "userChoice" => Some(json!({ "index": 1, "reply": "换个方式" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["output"], "用户拒绝操作，原因：换个方式");
    assert_eq!(harness.sink.events_of("aiBegin").len(), 2);
    let interrupted = harness
        .sink
        .events_of("message")
        .iter()
        .any(|event| {
            event["data"]["role"] == "system" && event["data"]["content"] == "*User Interrupted*"
        });
    assert!(!interrupted, "带原因的拒绝不应上报 *User Interrupted*");
}

#[test]
fn rename_without_a_metadata_file_creates_it_and_broadcasts_title_changed() {
    // 显式改标题必须
    // 落盘（meta.json 缺失时建档），再广播事件——UI 只消费真实数据变更后的事件，
    // 否则重启 / 刷新列表后标题回到「未命名」。
    let sandbox = Sandbox::new("engine-rename-no-metadata");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    assert!(history::load_metadata("ghost", &workspace).is_none(), "测试前提：无 meta.json");
    harness.core.on_conversation_renamed("ghost", "标题");
    let title = harness.sink.event_of("titleChanged").expect("titleChanged");
    assert_eq!(title["sessionId"], "ghost");
    assert_eq!(title["title"], "标题");
    assert!(harness.sink.event_of("conversationListChanged").is_some());
    let metadata = history::load_metadata("ghost", &workspace).expect("meta.json 已建档");
    assert_eq!(metadata["title"], "标题");
    assert_eq!(metadata["messageCount"], 0, "无消息时计数为 0");
    assert!(
        history::messages_path("ghost", &workspace)
            .map(|path| path.exists())
            .unwrap_or(false),
        "补空 .jsonl"
    );
}

// ==================== 工具入参 double-encode 解包 ====================

#[test]
fn tool_use_block_unwraps_double_encoded_input() {
    // Provider 把整个入参再 JSON.stringify 一次：`"{\"command\":\"ls\"}"`
    let inner = r#"{"command":"ls -la"}"#;
    let double = serde_json::to_string(inner).unwrap();
    let block = tool_use_block("call_1", "Bash", &double, &json!({}));
    assert_eq!(block["input"]["command"], "ls -la");
    // 普通字符串不能被误改成对象
    let plain = tool_use_block("call_2", "Bash", r#""hello""#, &json!({}));
    assert_eq!(plain["input"], "hello");
}

#[test]
fn double_encoded_tool_input_still_executes_and_is_persisted_as_an_update() {
    let sandbox = Sandbox::new("engine-double-encoded-input");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            let inner = r#"{"command":"touch marker.txt"}"#;
            let double = serde_json::to_string(inner).unwrap();
            openai_tool_sse("call_1", "Bash", &double)
        } else {
            openai_text_sse(&["完成"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "success");
    assert!(sandbox.workspace.join("marker.txt").exists(), "命令应当真的执行");

    // 落盘：assistant 消息里的 input 仍是 double-encode 的原样，
    // 但 `tool_use_update` 记录会在加载历史时把入参还原成对象。
    let messages = history::load_messages("s1", &workspace);
    let tool_use = messages
        .iter()
        .find_map(|message| {
            message
                .get("message")?
                .get("content")?
                .as_array()?
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .cloned()
        })
        .expect("应当落盘 tool_use block");
    assert_eq!(tool_use["input"]["command"], "touch marker.txt");
}

#[test]
fn field_level_json_string_input_is_unwrapped_and_persisted_as_an_update() {
    // `todos` 被 Provider 序列化成字符串（字段级 double-encode）：
    // 内存里要能解包执行，落盘后也要能靠 `tool_use_update` 还原成数组。
    let sandbox = Sandbox::new("engine-field-encoded-input");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            let todos = serde_json::to_string(&json!([
                { "content": "写测试", "activeForm": "写测试中", "status": "pending" }
            ]))
            .unwrap();
            let args = serde_json::to_string(&json!({ "todos": todos })).unwrap();
            openai_tool_sse("call_1", "TodoWrite", &args)
        } else {
            openai_text_sse(&["完成"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "建个清单", "u-1");
    assert!(harness.wait_query_end());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "success");
    assert!(
        result["output"].as_str().unwrap().contains("1 items"),
        "got {result}"
    );

    // 原始 jsonl 里的 assistant tool_use.input.todos 仍是字符串
    let raw = std::fs::read_to_string(history::messages_path("s1", &workspace).unwrap()).unwrap();
    let raw_tool_use = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|record| {
            record
                .get("message")?
                .get("message")?
                .get("content")?
                .as_array()?
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .cloned()
        })
        .expect("应当落盘 tool_use block");
    assert!(raw_tool_use["input"]["todos"].is_string());
    assert!(raw.contains("\"type\":\"tool_use_update\""), "应当追加 tool_use_update 记录");

    // 加载历史后入参已被回放成数组
    let messages = history::load_messages("s1", &workspace);
    let loaded = messages
        .iter()
        .find_map(|message| {
            message
                .get("message")?
                .get("content")?
                .as_array()?
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
                .cloned()
        })
        .expect("加载后应当有 tool_use block");
    assert_eq!(loaded["input"]["todos"][0]["content"], "写测试");
}


/// 工具不存在：不发 toolCall、不执行，但仍发一次 toolPermissionRequested
/// （permResult 默认 allow），
/// 随后补 `Error: Tool "X" not found` 并跳过该工具。
#[test]
fn unknown_tool_is_reported_and_skipped_without_executing() {
    let sandbox = Sandbox::new("engine-unknown-tool");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_x", "Nope", r#"{"a":1}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(result["output"], "Error: Tool \"Nope\" not found");
    // TS 的 `!tool` 分支在 `emitToUi(toolCall)` 之前 return
    assert!(harness.sink.event_of("toolCall").is_none());

    // 仍发一次 toolPermissionRequested（UI 上架失败卡片），且不弹确认框
    let requests = harness.sink.requests_of("toolPermissionRequested");
    assert_eq!(requests.len(), 1, "got {requests:?}");
    assert_eq!(requests[0]["permResult"]["behavior"], "allow");
    assert!(harness.sink.requests_of("userChoice").is_empty());

    // 落盘 block：exit_code=-1 / is_canceled=false
    let messages = history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let block = messages
        .iter()
        .find_map(|message| {
            message
                .get("message")?
                .get("content")?
                .as_array()?
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                .cloned()
        })
        .expect("应当有 tool_result block");
    assert_eq!(block["exit_code"], -1);
    assert_eq!(block["is_canceled"], false);
    assert_eq!(block["content"], "Error: Tool \"Nope\" not found");
}

/// Bash 语义校验失败（空白命令 / 超长命令）：
/// 产出 `InputValidationError: ...` 并跳过该工具（不执行、不发 toolCall）。
#[test]
fn bash_input_validation_failure_is_reported_and_skipped() {
    let sandbox = Sandbox::new("engine-bash-validation");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"   "}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    assert_eq!(
        result["output"],
        "InputValidationError: Command cannot be empty"
    );
    // 校验在 `emitToUi(toolCall)` 之前返回
    assert!(harness.sink.event_of("toolCall").is_none());
    // 命令没有被执行（工作目录里没有副作用）；tool_result 仍是错误块
    let messages = history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let block = messages
        .iter()
        .find_map(|message| {
            message
                .get("message")?
                .get("content")?
                .as_array()?
                .iter()
                .find(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
                .cloned()
        })
        .expect("应当有 tool_result block");
    assert_eq!(block["exit_code"], -1);
    assert_eq!(block["is_canceled"], false);
}

// ==================== JS 语义对等（parseDataUrl / String()） ====================

/// 两侧共用 `core-rs/fixtures/jsValue.json`：TS 侧 `jsValueParity.test.ts`
/// 断言 `parseDataUrl` / `String()` 产出该表，这里断言 `split_data_url` / `js_string`
/// 产出同结果。
#[test]
fn js_value_parity_tests() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/jsValue.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()));
    let fixture: Value = serde_json::from_str(&raw).expect("对照表不是合法 JSON");

    let data_urls = fixture["dataUrls"].as_array().expect("dataUrls 不是数组");
    assert!(!data_urls.is_empty(), "dataUrls 为空");
    for case in data_urls {
        let input = case["input"].as_str().unwrap_or("");
        let (media_type, data) = split_data_url(input);
        assert_eq!(
            media_type,
            case["mediaType"].as_str().unwrap_or(""),
            "mediaType 不一致：{input}"
        );
        assert_eq!(
            data,
            case["data"].as_str().unwrap_or(""),
            "data 不一致：{input}"
        );
    }

    let stringify = fixture["stringify"].as_array().expect("stringify 不是数组");
    assert!(!stringify.is_empty(), "stringify 为空");
    for case in stringify {
        let actual = crate::util::js_string(&case["input"]);
        assert_eq!(
            actual,
            case["expected"].as_str().unwrap_or(""),
            "String({}) 不一致",
            case["input"]
        );
    }
}

// ==================== max output 预留（对齐 getAvailableOutputTokens） ====================

#[test]
fn available_output_tokens_matches_the_formula() {
    const WINDOW: u64 = 1_000_000;
    const OUTPUT: u64 = 384 * 1024;

    // 上下文很空：输出预算取配置值
    assert_eq!(available_output_tokens(WINDOW, OUTPUT, 0), OUTPUT as u32);
    // 上下文占用 90%：只剩窗口的 10%
    assert_eq!(
        available_output_tokens(WINDOW, OUTPUT, WINDOW - 1000),
        1000
    );
    // 输出上限小于剩余空间时取输出上限
    assert_eq!(available_output_tokens(WINDOW, 50, 0), 50);
    // 已超出窗口：至少留 1 个 token（对齐 `Math.max(1, ...)`）
    assert_eq!(available_output_tokens(WINDOW, OUTPUT, WINDOW + 5_000), 1);
    assert_eq!(available_output_tokens(0, OUTPUT, 0), 1);
}

/// 构造一条带 usage 的 assistant 消息
fn assistant_with_usage(input: u64, output: Value) -> Value {
    json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{ "type": "text", "text": "ok" }],
            "usage": { "input_tokens": input, "output_tokens": output },
        },
        "uuid": "a-usage",
        "timestamp": 1,
    })
}

#[test]
fn exact_context_tokens_prefers_the_last_assistant_usage() {
    let sandbox = Sandbox::new("engine-exact-tokens");
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));

    // 没有任何消息、meta.json 也不存在 → None
    assert_eq!(exact_context_tokens(&state, "s1", &sandbox.workspace.to_string_lossy()), None);

    {
        let mut state = state.lock().unwrap();
        state.messages.push(assistant_with_usage(1000, json!(200)));
        // 没有 usage 的 assistant / 非 assistant 消息不参与
        state.messages.push(json!({
            "type": "assistant",
            "message": { "role": "assistant", "content": [] },
            "uuid": "a-2",
        }));
        state.messages.push(json!({ "type": "user", "message": { "role": "user", "content": "hi" } }));
    }
    assert_eq!(
        exact_context_tokens(&state, "s1", &sandbox.workspace.to_string_lossy()),
        Some(1200)
    );

    // input_tokens 为 0 的消息被跳过（对齐 `usage?.input_tokens > 0`）
    {
        let mut state = state.lock().unwrap();
        state.messages.push(assistant_with_usage(0, json!(7)));
        state.messages.push(assistant_with_usage(3000, json!(500)));
    }
    assert_eq!(
        exact_context_tokens(&state, "s1", &sandbox.workspace.to_string_lossy()),
        Some(3500)
    );
}

#[test]
fn exact_context_tokens_falls_back_to_metadata_total_context_tokens() {
    let sandbox = Sandbox::new("engine-exact-tokens-meta");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));

    // 只有 meta.json 记录了上下文占用时用它兜底
    history::create_conversation("s1", &project, json!({ "sessionId": "s1", "project": project }))
        .expect("create conversation");
    history::update_context("s1", &project, &[json!({ "key": "totalContextTokens", "value": 4321 })])
        .expect("write metadata");
    assert_eq!(exact_context_tokens(&state, "s1", &project), Some(4321));

    // meta.json 的 0 视为「不可信」，不参与
    history::update_context("s1", &project, &[json!({ "key": "totalContextTokens", "value": 0 })])
        .expect("write metadata");
    assert_eq!(exact_context_tokens(&state, "s1", &project), None);

    // 内存里有 usage 时优先于 meta.json
    history::update_context("s1", &project, &[json!({ "key": "totalContextTokens", "value": 999 })])
        .expect("write metadata");
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_with_usage(10, json!(5)));
    assert_eq!(exact_context_tokens(&state, "s1", &project), Some(15));
}

// ==================== pendingReminder（对齐 QueryEngine 的收尾提醒） ====================

/// 构造一条「本轮刚产出」的 assistant 消息
fn assistant_reply(blocks: Value, stop_reason: &str) -> Value {
    json!({
        "type": "assistant",
        "message": { "role": "assistant", "content": blocks, "stop_reason": stop_reason },
        "uuid": "a-1",
        "timestamp": 1,
    })
}

#[test]
fn pending_reminder_covers_stop_reason_colon_and_skips_tool_use() {
    // stop_reason 非 end_turn → 「回复未完成」提醒
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "被截断" }]), "max_tokens"));
    update_pending_reminder(&state, 0);
    let reminder = state.lock().unwrap().pending_reminder.clone().unwrap();
    // 逐字对齐 `QueryEngine.runQuery` 的 pendingReminder 文案
    assert_eq!(
        reminder,
        "<reminder>Your previous response stopped (stop_reason: max_tokens), and did not \
         complete fully. Please continue from where you left off, including any incomplete tool \
         calls or text.</reminder>"
    );

    // end_turn + 正文以半角冒号结尾 → 「像是要调用工具却没调用」提醒
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "让我先读一下：" }]), "end_turn"));
    update_pending_reminder(&state, 0);
    let reminder = state.lock().unwrap().pending_reminder.clone().unwrap();
    assert_eq!(
        reminder,
        "<reminder>You ended your response with a colon (\":\" or \"：\"), which suggests you \
         intended to continue with a tool call, but didn't actually invoke any tool. Please think \
         about what tool you need to call next and make the appropriate tool call to complete the \
         user's request.</reminder>"
    );

    // 全角冒号同样命中
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "先看看：" }]), "end_turn"));
    update_pending_reminder(&state, 0);
    assert!(state.lock().unwrap().pending_reminder.is_some());

    // end_turn + 无冒号 → 不注入
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "完成了。" }]), "end_turn"));
    update_pending_reminder(&state, 0);
    assert!(state.lock().unwrap().pending_reminder.is_none());

    // 带 tool_use → 不注入（工具轮次由查询循环继续，不靠 reminder）
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state.lock().unwrap().messages.push(assistant_reply(
        json!([
            { "type": "text", "text": "先读文件：" },
            { "type": "tool_use", "id": "call_1", "name": "Read", "input": {} }
        ]),
        "end_turn",
    ));
    update_pending_reminder(&state, 0);
    assert!(state.lock().unwrap().pending_reminder.is_none());

    // 用户中断 → 不注入
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "让我读一下：" }]), "end_turn"));
    state.lock().unwrap().cancel.store(true, Ordering::Relaxed);
    update_pending_reminder(&state, 0);
    assert!(state.lock().unwrap().pending_reminder.is_none());

    // 只看本轮新增的消息：messages_before_query 之前的历史 assistant 不参与判定
    let state = Arc::new(Mutex::new(SessionState::new("auto".to_string(), None)));
    state
        .lock()
        .unwrap()
        .messages
        .push(assistant_reply(json!([{ "type": "text", "text": "上一轮：" }]), "end_turn"));
    update_pending_reminder(&state, 1);
    assert!(state.lock().unwrap().pending_reminder.is_none());
}

#[test]
fn assistant_reply_ending_with_a_colon_triggers_a_silent_reminder_follow_up() {
    let sandbox = Sandbox::new("engine-reminder-colon");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            openai_text_sse(&["让我先读一下这个文件："])
        } else {
            openai_text_sse(&["读完了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "看看", "u-1");
    assert!(
        harness.wait_for(
            |_| bodies.lock().unwrap().len() >= 2,
            Duration::from_secs(30),
        ),
        "以冒号结尾的回复应当触发 reminder 的第二轮 LLM 调用"
    );

    let bodies = bodies.lock().unwrap();
    let second = bodies[1]["messages"].as_array().unwrap();
    let reminder = second
        .iter()
        .find(|message| {
            message["role"] == "user"
                && message["content"]
                    .as_str()
                    .map(|text| text.contains("ended your response with a colon"))
                    .unwrap_or(false)
        })
        .unwrap_or_else(|| panic!("第二轮请求缺少 reminder: {second:?}"));
    // reminder 是 silent 系统自动消息，正文以 `<reminder>` 开头
    assert!(
        reminder["content"].as_str().unwrap().starts_with("<reminder>"),
        "got {reminder}"
    );
    // 原始用户消息仍在上下文里（reminder 是另一条 user 消息，不是替换）
    assert!(
        second
            .iter()
            .any(|message| message["role"] == "user" && message["content"] == "看看"),
        "原始用户消息不应被 reminder 顶掉: {second:?}"
    );
    // reminder 落盘：
    // 它是一条 silent / origin=agent 的 user 消息，
    // UI 不展示，但会写进 jsonl 并计入 messageCount。
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "reminder 轮次也应当跑完: {:?}",
        harness.sink.event_types()
    );
    // `queryBegin` / `queryEnd` 是消费循环级：reminder 追问与首个用户消息同属一次
    // consumer（同一次消费会继续消费 pendingReminder），
    // 只应有一对，不能按 LLM 轮次各发一对。
    assert_eq!(
        harness.sink.events_of("queryBegin").len(),
        1,
        "reminder 追问不应另起一次 consumer: {:?}",
        harness.sink.event_types()
    );
    assert_eq!(
        harness.sink.events_of("queryEnd").len(),
        1,
        "reminder 追问不应多发 queryEnd: {:?}",
        harness.sink.event_types()
    );
    let dir = sandbox.conversation_dir(&sandbox.workspace.to_string_lossy());
    let text = std::fs::read_to_string(dir.join("s1.jsonl")).unwrap();
    assert!(
        text.contains("ended your response with a colon"),
        "reminder 应当落盘: {text}"
    );
    let messages = history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let reminder_record = messages
        .iter()
        .find(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_str)
                .map(|text| text.starts_with("<reminder>"))
                .unwrap_or(false)
        })
        .unwrap_or_else(|| panic!("jsonl 缺少 reminder 消息: {messages:?}"));
    assert_eq!(reminder_record["silent"], json!(true));
    assert_eq!(reminder_record["origin"], json!("agent"));
    // messageCount = 首条用户消息 + assistant + reminder + assistant
    let metadata = history::load_metadata("s1", &sandbox.workspace.to_string_lossy()).unwrap();
    assert_eq!(metadata["messageCount"], json!(4));
}

/// 后台任务提醒投递：同一 tick 多个任务到点时**追加**而不是覆盖。
///
#[test]
fn background_reminder_appends_to_pending_reminder() {
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s-rem");
    // 假装消费循环在跑：投递只入队，不 spawn 消费者线程（避免真跑 LLM）
    state.lock().unwrap().running = true;

    harness.core.deliver_background_reminder("s-rem", "A");
    harness.core.deliver_background_reminder("s-rem", "B");

    let pending = state.lock().unwrap().pending_reminder.clone();
    assert_eq!(pending.as_deref(), Some("A\n\nB"));
    // 投递即「由 reminder 拉起的一轮」：消费循环收尾不再补兜底提醒。
    assert!(state.lock().unwrap().reminder_driven_run);
}

/// 查询结束兜底提醒的门槛：
/// 非 sleep 的刚注册任务不进列表；含 `sleep` 的刚注册即兜底一次，登记
/// `fallback_reminded` + 刷新 `last_accessed_ms` 后不再命中。
#[test]
fn fallback_reminder_gate() {
    // 用沙箱取进程级串行锁：本用例直接读全局任务注册表，不能被并行的
    // `reset_for_test()` 清掉。
    let sandbox = Sandbox::new("engine-fallback-reminder-gate");
    crate::bash_task::reset_for_test();
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s-fb");

    crate::bash_task::register_running("bg-plain", "Watcher", "build --watch", "s-fb", 111, None);
    crate::bash_task::register_running("bg-sleep", "Sleep", "sleep 600", "s-fb", 222, None);

    {
        let mut guard = state.lock().unwrap();
        let text = background_reminder("s-fb", &mut guard).expect("sleep 豁免应兜底");
        assert!(text.contains("bg-sleep"), "got {text}");
        assert!(!text.contains("bg-plain"), "非 sleep 刚注册不该进列表: {text}");
    }
    {
        let mut guard = state.lock().unwrap();
        assert!(
            background_reminder("s-fb", &mut guard).is_none(),
            "登记已兜底 + 上次访问刷新后不该再兜底"
        );
    }

    crate::bash_task::abort_tasks_for_session("s-fb");
    crate::bash_task::reset_for_test();
    // `sandbox` 与 `harness` 在函数末尾按声明逆序析构（harness 先、sandbox 后），
    // 串行锁在全部清理完成后才释放。
    drop(sandbox);
}

#[test]
fn truncated_stop_reason_triggers_a_reminder_follow_up() {
    let sandbox = Sandbox::new("engine-reminder-stop-reason");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            // finish_reason=length → 内部 stop_reason=max_tokens
            let mut out = String::new();
            out.push_str(&format!(
                "data: {}\n\n",
                json!({ "choices": [{ "delta": { "content": "被截断" }, "finish_reason": "length" }] })
            ));
            out.push_str("data: [DONE]\n\n");
            out
        } else {
            openai_text_sse(&["补齐了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "写一段", "u-1");
    assert!(
        harness.wait_for(
            |_| bodies.lock().unwrap().len() >= 2,
            Duration::from_secs(30),
        ),
        "stop_reason=max_tokens 应当触发 reminder 的第二轮 LLM 调用"
    );
    let bodies = bodies.lock().unwrap();
    let second = bodies[1]["messages"].as_array().unwrap();
    assert!(
        second.iter().any(|message| {
            message["content"]
                .as_str()
                .map(|text| text.contains("stop_reason: max_tokens"))
                .unwrap_or(false)
        }),
        "第二轮请求缺少 stop_reason reminder: {second:?}"
    );
}

#[test]
fn first_message_creates_meta_json_with_the_session_model_only_when_chosen() {
    // 新会话的 meta.json
    // 只在会话运行时已有模型身份（engine.modelRefOverride）时才写 `model` / `provider`，
    // 否则不写该键（也不能写 `null`），让宿主回退到活动 provider 的默认模型。
    let sandbox = Sandbox::new("engine-meta-model");
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    sandbox.write_settings(json!({
        "defaultAgentMode": "auto",
        "llm": {
            "maxTokens": 4096,
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": llm.base_url,
                    "apiKey": "test-key",
                    "models": ["fake-model", "other-model"],
                    "defaultModel": "fake-model",
                    "modelConfigs": {
                        "fake-model": { "apiType": "OpenAI", "output": 4096 },
                        "other-model": { "apiType": "OpenAI", "output": 4096 }
                    }
                }
            }
        }
    }));
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));

    // 未选模型：meta.json 不写 model / provider
    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "你好", "u-1");
    assert!(harness.wait_query_end());
    let metadata = history::load_metadata("s1", &workspace).unwrap();
    assert_eq!(metadata["title"], "你好");
    assert!(
        !metadata.as_object().unwrap().contains_key("model"),
        "未选模型不应写 model 键: {metadata}"
    );
    assert!(
        !metadata.as_object().unwrap().contains_key("provider"),
        "未选模型不应写 provider 键: {metadata}"
    );

    // 首条消息前已选模型：meta.json 记录会话级 model + provider（不是 settings 默认值）
    let harness = EngineHarness::allow_all();
    harness.core.on_session_config_changed(
        "s2",
        &json!({ "key": "model", "value": { "provider": "fake", "model": "other-model" } }),
    );
    submit(&harness, "s2", "你好", "u-2");
    assert!(harness.wait_query_end());
    let metadata = history::load_metadata("s2", &workspace).unwrap();
    assert_eq!(metadata["model"], "other-model");
    assert_eq!(metadata["provider"], "fake");
}

// ==================== 上下文余量钳制（对齐 Query.ts 的 getAvailableOutputTokens） ====================

/// 跑一轮并返回第一次 LLM 请求的正文
fn capture_first_request_body(sandbox: &Sandbox, settings: Value) -> Value {
    let bodies: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["收到"])
    });
    let mut settings = settings;
    settings["llm"]["providers"]["fake"]["baseURL"] = json!(llm.base_url);
    sandbox.write_settings(settings);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "你好", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());
    let captured = bodies.lock().unwrap();
    captured.first().cloned().expect("应当发出一次 LLM 请求")
}

fn settings_with_model_config(model_config: Value) -> Value {
    json!({
        "defaultAgentMode": "auto",
        "llm": {
            "maxTokens": 4096,
            "activeProvider": "fake",
            "providers": {
                "fake": {
                    "baseURL": "",
                    "apiKey": "test-key",
                    "models": ["fake-model"],
                    "defaultModel": "fake-model",
                    "modelConfigs": { "fake-model": model_config }
                }
            }
        }
    })
}

#[test]
fn request_max_tokens_is_clamped_by_the_context_window() {
    // 上下文窗口压到 1000：system prompt 已远超窗口，剩余空间为负 → 可用输出取下限 1
    let sandbox = Sandbox::new("engine-max-tokens-clamp");
    let body = capture_first_request_body(
        &sandbox,
        settings_with_model_config(json!({ "apiType": "OpenAI", "output": 4096, "context": 1000 })),
    );
    assert_eq!(
        body["max_tokens"], 1,
        "超出上下文窗口时应把 max_tokens 钳到下限 1，实际 {}",
        body["max_tokens"]
    );
}

#[test]
fn request_max_tokens_keeps_configured_value_within_the_window() {
    // 默认 1M 上下文窗口下，4096 的配置值原样发出
    let sandbox = Sandbox::new("engine-max-tokens-keep");
    let body = capture_first_request_body(
        &sandbox,
        settings_with_model_config(json!({ "apiType": "OpenAI", "output": 4096, "context": 1024 * 1024 })),
    );
    assert_eq!(body["max_tokens"], 4096);
}

// ==================== 提示词预设 ====================

/// 启动假 LLM 并捕获每次请求体。
fn capture_requests(sandbox: &Sandbox) -> (Arc<std::sync::Mutex<Vec<Value>>>, FakeLlm) {
    let bodies: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["收到"])
    });
    let mut settings = settings_with_model_config(
        json!({ "apiType": "OpenAI", "output": 4096, "context": 1024 * 1024 }),
    );
    settings["llm"]["providers"]["fake"]["baseURL"] = json!(llm.base_url);
    sandbox.write_settings(settings);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    (bodies, llm)
}

fn tool_names(body: &Value) -> Vec<String> {
    body["tools"]
        .as_array()
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn minimal_prompt_mode_exposes_only_bash_and_edit() {
    let sandbox = Sandbox::new("engine-prompt-minimal");
    let (bodies, _llm) = capture_requests(&sandbox);
    let harness = EngineHarness::allow_all();
    // 首条消息前切换预设：ensure_loaded 不得把它覆盖回 normal
    harness.core.on_session_config_changed(
        "s1",
        &json!({ "key": "promptMode", "value": "minimal" }),
    );
    submit(&harness, "s1", "你好", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let bodies = bodies.lock().unwrap();
    let body = bodies.first().expect("应当发出一次 LLM 请求");
    assert_eq!(
        body["messages"][0]["content"], "You are a helpful software engineer assistant.",
        "minimal 只有单行核心身份提示"
    );
    assert_eq!(tool_names(body), vec!["Bash".to_string(), "Edit".to_string()]);
    // 落盘的 meta.json 记录会话级 promptMode（对齐 updateMetadataForNewMessage）
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["context"]["promptMode"],
        "minimal"
    );
}

#[test]
fn mixed_prompt_mode_switches_to_normal_after_first_reply() {
    let sandbox = Sandbox::new("engine-prompt-mixed");
    let (bodies, _llm) = capture_requests(&sandbox);
    let harness = EngineHarness::allow_all();
    harness.core.on_session_config_changed("s1", &json!({ "key": "promptMode", "value": "mixed" }));

    submit(&harness, "s1", "你好", "u-1");
    assert!(harness.wait_query_end());
    submit(&harness, "s1", "继续", "u-2");
    assert!(
        harness.wait_for(
            |sink| sink.events_of("queryEnd").len() >= 2,
            std::time::Duration::from_secs(30)
        ),
        "第二轮未结束: {:?}",
        harness.sink.event_types()
    );

    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies.len(), 2, "应当发出两次 LLM 请求");
    // 第一轮：首次 assistant 回复前 → minimal
    assert_eq!(
        bodies[0]["messages"][0]["content"],
        "You are a helpful software engineer assistant."
    );
    assert_eq!(tool_names(&bodies[0]), vec!["Bash".to_string(), "Edit".to_string()]);
    // 第二轮：已有 assistant 回复 → normal
    let second = bodies[1]["messages"][0]["content"].as_str().unwrap();
    assert!(second.contains("## Core Principles"), "got {second}");
    assert!(second.contains("## Tool Usage"), "got {second}");
    assert!(tool_names(&bodies[1]).len() > 2);
}

#[test]
fn prompt_mode_is_restored_from_metadata() {
    let sandbox = Sandbox::new("engine-prompt-restore");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "context": { "promptMode": "minimal" } }),
    )
    .unwrap();
    history::create_conversation(
        "s2",
        &workspace,
        json!({ "sessionId": "s2", "context": { "promptMode": "bogus" } }),
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    harness.core.ensure_loaded("s1").unwrap();
    harness.core.ensure_loaded("s2").unwrap();
    assert_eq!(
        harness.core.session("s1").lock().unwrap().prompt_mode.as_deref(),
        Some("minimal")
    );
    // 非法值回退 normal（对齐 isPromptPresetId 白名单）
    assert_eq!(
        harness.core.session("s2").lock().unwrap().prompt_mode.as_deref(),
        Some("normal")
    );
}

/// 空的 thinkingMode 是假值：请求体不得带 `reasoning_effort`（对齐
/// `if (effectiveThinkingEffort && effectiveThinkingEffort !== 'off')`）。
#[test]
fn empty_thinking_effort_disables_reasoning_in_the_request() {
    let sandbox = Sandbox::new("engine-thinking-empty");
    let (bodies, _llm) = capture_requests(&sandbox);
    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({
        "sessionId": "s1",
        "content": "你好",
        "uuid": "u-1",
        "thinkingMode": "",
    }));
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let bodies = bodies.lock().unwrap();
    let body = bodies.first().expect("应当发出一次 LLM 请求");
    assert!(
        body.get("reasoning_effort").is_none(),
        "空 thinkingMode 不应带 reasoning_effort，实际 {body}"
    );
}

/// 随消息携带的会话覆盖必须**后于** meta.json 恢复应用（对齐 submitUserMessage 顺序）。
/// agentMode / thinkingMode 的负载覆盖语义不变；webSearch 只承担新会话种子职责——
/// 已确立的值（含 meta.json 恢复）不被负载覆盖，配置事件是唯一持续写入口
/// （specs/defects/websearch-recheck-clobbered-by-payload）。
#[test]
fn message_payload_overrides_apply_after_metadata_except_established_web_search() {
    let sandbox = Sandbox::new("engine-payload-override");
    let llm = FakeLlm::start(|_index, _body| openai_text_sse(&["收到"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &workspace,
        json!({
            "sessionId": "s1",
            "context": { "agentMode": "manual", "thinkingMode": "off", "webSearch": false }
        }),
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({
        "sessionId": "s1",
        "content": "hi",
        "uuid": "u-1",
        "agentMode": "auto",
        "thinkingMode": "max",
        "webSearch": true,
    }));
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let state = harness.core.session("s1");
    let state = state.lock().unwrap();
    assert_eq!(state.agent_mode, "auto");
    assert_eq!(state.thinking_effort.as_deref(), Some("max"));
    // meta.json 恢复的 false 已确立，负载 true 不得覆盖
    assert_eq!(state.web_search, Some(false));
}

// ==================== 事件粒度 ====================

/// 内部 diff：状态没变不发事件。
#[test]
fn emit_runtime_is_silent_when_nothing_changed() {
    let sandbox = Sandbox::new("engine-runtime-diff");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    let harness = EngineHarness::allow_all();

    harness.core.session("s1");
    harness.core.emit_runtime();
    assert_eq!(harness.sink.events_of("sessionRuntimeChanged").len(), 1);

    // 连续调用、状态未变：不再发
    harness.core.emit_runtime();
    harness.core.emit_runtime();
    assert_eq!(
        harness.sink.events_of("sessionRuntimeChanged").len(),
        1,
        "无变化不应重发 sessionRuntimeChanged"
    );

    // 状态变化后恢复发送
    harness.core.session("s1").lock().unwrap().waiting = true;
    harness.core.emit_runtime();
    assert_eq!(harness.sink.events_of("sessionRuntimeChanged").len(), 2);
}

/// states 按会话创建顺序输出。
#[test]
fn session_runtime_states_follow_insertion_order() {
    let sandbox = Sandbox::new("engine-runtime-order");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    let harness = EngineHarness::allow_all();

    for id in ["s-b", "s-a", "s-c"] {
        harness.core.session(id);
    }
    harness.core.emit_runtime();
    let runtime = harness.sink.event_of("sessionRuntimeChanged").expect("runtime");
    let order: Vec<&str> = runtime["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|state| state["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(order, vec!["s-b", "s-a", "s-c"]);

    // 关闭中间会话后顺序保持，且被关闭的会话不再出现
    harness.core.on_conversation_closed("s-a");
    let runtime = harness.sink.events_of("sessionRuntimeChanged").pop().unwrap();
    let order: Vec<&str> = runtime["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|state| state["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(order, vec!["s-b", "s-c"]);
}

/// 只在 `conversationRenamed` / Spin 改名时发 `titleChanged`；
/// 新消息推导出的标题只通过 `conversationListChanged` 通知宿主。
#[test]
fn title_changed_is_only_emitted_for_renames() {
    let sandbox = Sandbox::new("engine-title-event");
    let llm = FakeLlm::start(|_index, _| openai_text_sse(&["收到"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "帮我改个名字", "u-1");
    assert!(harness.wait_query_end());
    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "帮我改个名字");
    assert!(harness.sink.event_of("titleChanged").is_none(), "新消息不发 titleChanged");

    harness.core.on_conversation_renamed("s1", "手动标题");
    let title = harness.sink.event_of("titleChanged").expect("改名应发 titleChanged");
    assert_eq!(title["title"], "手动标题");
}

// ==================== 工具入参修复对等（fixToolInput） ====================

/// 两侧共用 `core-rs/fixtures/toolInputRepair.json`：TS 侧
/// `toolInputRepairParity.test.ts` 断言 `RunTools.fixToolInput` 产出该表，这里断言
/// `fix_tool_input` 产出同结果（`output` 与 `input` 深度相等表示「未修复」）。
///
/// 覆盖：顶层 double-encode 解包、字段值合法 JSON 字符串解包、以及畸形数组 / 对象
/// 的抢救（key 缺引号、单引号、按逗号拆分、嵌套括号、引号内逗号）。
#[test]
fn fix_tool_input_parity_tests() {
    const FIXTURE: &str = include_str!("../fixtures/toolInputRepair.json");
    let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表不是合法 JSON");
    let cases = fixture["cases"].as_array().expect("cases 不是数组");
    assert!(!cases.is_empty(), "cases 为空");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let output = &case["output"];
        let fixed = fix_tool_input(input);
        if output == input {
            assert!(fixed.is_none(), "{name}: 不应修复，实际 {fixed:?}");
        } else {
            assert_eq!(fixed.as_ref(), Some(output), "{name}: 修复结果不一致");
        }
    }
}

// ==================== 工具入参序列化对等（serializeToolArguments） ====================

/// 两侧共用 `core-rs/fixtures/toolArguments.json`：TS 侧
/// `toolArgumentsParity.test.ts` 断言 `serializeToolArguments` /
/// `sanitizeAnthropicMessages` 产出该表，这里断言 Rust 侧同名函数产出同结果。
///
/// 背景：LLM 生成的工具参数解析失败时，非法 JSON 原文残留在 `tool_use.input`（string），
/// 原样发给 Provider 会让严格校验 arguments / input 的服务商 400，且毒化上下文后
/// 此后的每一轮请求都失败。序列化层必须保证输出永远是合法 JSON / 对象。
#[test]
fn tool_arguments_parity_tests() {
    const FIXTURE: &str = include_str!("../fixtures/toolArguments.json");
    let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表不是合法 JSON");
    let cases = fixture["cases"].as_array().expect("cases 不是数组");
    assert!(!cases.is_empty(), "cases 为空");
    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let input = &case["input"];
        let expected_arguments = case["arguments"].as_str().expect("arguments 不是字符串");
        assert_eq!(
            crate::engine::serialize_tool_arguments(Some(input)),
            expected_arguments,
            "{name}: arguments 不一致"
        );
        // 包成 assistant tool_use 消息再消毒，对照归一后的 input
        let message = json!({
            "role": "assistant",
            "content": [{ "type": "tool_use", "id": "t-1", "name": "Bash", "input": input }],
        });
        let sanitized = crate::engine::sanitize_anthropic_messages(&[message])
            .into_iter()
            .next()
            .unwrap();
        let block = &sanitized["content"][0];
        assert_eq!(
            block["input"], case["objectInput"],
            "{name}: Anthropic input 不一致"
        );
    }

    // input 缺失（None）的口径：arguments 空对象、Anthropic input 空对象
    assert_eq!(crate::engine::serialize_tool_arguments(None), "{}");
    let message = json!({
        "role": "assistant",
        "content": [{ "type": "tool_use", "id": "t-2", "name": "Bash" }],
    });
    let sanitized = crate::engine::sanitize_anthropic_messages(&[message])
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(sanitized["content"][0]["input"], json!({}));

    // 对象型 tool_use 不被改写（保持原值）
    let object_block = json!({ "type": "tool_use", "id": "t-3", "name": "Bash", "input": { "command": "ls" } });
    let message = json!({
        "role": "assistant",
        "content": [object_block.clone(), { "type": "text", "text": "ok" }],
    });
    let sanitized = crate::engine::sanitize_anthropic_messages(&[message])
        .into_iter()
        .next()
        .unwrap();
    assert_eq!(sanitized["content"][0], object_block, "对象型 tool_use 应保持原值");
}

// ==================== 后台 Bash 任务通知 ====================

/// 后台任务完成通知（`LocalShellTask.notifyEngine` → `enqueueAgentMessage(..., 'bash')`）：
/// 会话空闲时唤醒消费循环，通知以一条 `origin='bash'` 的 user 消息进上下文 + 进 UI。
#[test]
fn background_completion_notification_wakes_the_consumer_as_a_bash_message() {
    let sandbox = Sandbox::new("engine-background-notify");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["收到"])
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "hi", "u-1");
    assert!(harness.wait_query_end(), "首轮应当跑完: {:?}", harness.sink.event_types());

    let notification = "Background task completed\n\
                        Task: bg-1-2\n\
                        Description: Background command \"ls\" completed (exit code 0)\n\
                        Duration: 1.2s";
    harness.sink.clear();
    harness.core.enqueue_bash_notification("s1", notification);

    assert!(
        harness.wait_for(
            |_| bodies.lock().unwrap().len() >= 2,
            Duration::from_secs(30),
        ),
        "通知应当唤醒消费循环再跑一轮"
    );

    // 1) 通知作为一条 user 消息进了 LLM 上下文（不是 silent reminder）
    let bodies = bodies.lock().unwrap();
    let second = bodies[1]["messages"].as_array().unwrap();
    let injected = second
        .iter()
        .find(|message| {
            message["role"] == "user"
                && message["content"]
                    .as_str()
                    .map(|text| text.contains("Background task completed"))
                    .unwrap_or(false)
        })
        .unwrap_or_else(|| panic!("第二轮请求缺少后台通知: {second:?}"));
    assert_eq!(injected["content"], notification);

    // 2) UI 收到一条 `origin='bash'` 的 user 消息（UI 走纯文本渲染）
    let message = harness
        .sink
        .events_of("message")
        .into_iter()
        .find(|event| event["data"]["origin"] == "bash")
        .unwrap_or_else(|| panic!("缺少 origin=bash 的 message 事件: {:?}", harness.sink.events()));
    assert_eq!(message["sessionId"], "s1");
    assert_eq!(message["data"]["role"], "user");
    assert_eq!(message["data"]["content"], notification);

    // 3) 会话重新起了消费循环（新的一对 queryBegin / queryEnd）
    assert!(harness.wait_query_end(), "通知轮次应当跑完");
    assert_eq!(harness.sink.events_of("queryBegin").len(), 1);
    assert_eq!(harness.sink.events_of("queryEnd").len(), 1);
}

/// 有运行中的后台任务时该会话不算空闲（`sessionRuntime.background` → `idle=false`）。
#[test]
fn running_background_tasks_keep_the_session_out_of_idle() {
    let sandbox = Sandbox::new("engine-background-idle");
    let previous_tmpdir = std::env::var("TMPDIR").ok();
    std::env::set_var("TMPDIR", sandbox.root.join("tmp"));
    let llm = FakeLlm::start(|_index, _body| openai_text_sse(&["ok"]));
    prepare(&sandbox, &llm.base_url, "auto");
    crate::bash_task::reset_for_test();

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "hi", "u-1");
    assert!(harness.wait_query_end(), "首轮应当跑完");
    assert!(
        harness
            .sink
            .events_of("sessionRuntimeChanged")
            .last()
            .map(|event| event["states"][0]["idle"] == json!(true))
            .unwrap_or(false),
        "首轮结束后会话应当空闲: {:?}",
        harness.sink.events_of("sessionRuntimeChanged")
    );

    let core = Arc::clone(&harness.core);
    let task_id = crate::bash_task::spawn_background(
        "sleep 30",
        &sandbox.workspace.to_string_lossy(),
        "Sleep",
        "s1",
        Some(core.background_hooks()),
    )
    .expect("spawn background");

    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("sessionRuntimeChanged")
                .last()
                .map(|event| event["states"][0]["idle"] == json!(false))
                .unwrap_or(false),
            Duration::from_secs(10),
        ),
        "有后台任务时不应空闲: {:?}",
        harness.sink.events_of("sessionRuntimeChanged")
    );

    // 中止后回到空闲（对齐 `abortBackgroundTasksForSession` → `syncBackgroundState`）
    core.abort_background_tasks("s1");
    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("sessionRuntimeChanged")
                .last()
                .map(|event| event["states"][0]["idle"] == json!(true))
                .unwrap_or(false),
            Duration::from_secs(10),
        ),
        "中止后应当回到空闲: {:?}",
        harness.sink.events_of("sessionRuntimeChanged")
    );
    assert_eq!(crate::bash_task::running_count_for_session("s1"), 0);
    assert_eq!(crate::bash_task::task_status(&task_id), None, "记录已被移除");

    crate::bash_task::reset_for_test();
    match previous_tmpdir {
        Some(value) => std::env::set_var("TMPDIR", value),
        None => std::env::remove_var("TMPDIR"),
    }
}

// ==================== 并行工具批 ====================

/// 连续出现的并发安全工具攒成一批**并行**执行。
///
/// 可观测契约：批内所有工具的 `toolCall`（授权一次 + 执行前一次）先发完，再**按原顺序**
/// 发 `toolResult`。串行实现下 `result(call_1)` 会插在 `call_2` 之前，这里必须不是。
#[test]
fn consecutive_concurrency_safe_tools_run_as_one_parallel_batch() {
    let sandbox = Sandbox::new("engine-parallel-batch");
    sandbox.write_file("a.txt", "alpha\n");
    sandbox.write_file("b.txt", "beta\n");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_multi_tool_sse(&[
                ("call_1", "Read", r#"{"file_path":"a.txt"}"#),
                ("call_2", "Read", r#"{"file_path":"b.txt"}"#),
            ])
        } else {
            openai_text_sse(&["读完了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "读两个文件", "u-1");
    assert!(harness.wait_query_end(), "轮次应当跑完");

    let sequence: Vec<String> = harness
        .sink
        .events()
        .iter()
        .filter_map(|event| {
            let kind = event["type"].as_str()?;
            if kind != "toolCall" && kind != "toolResult" {
                return None;
            }
            Some(format!("{kind}({})", event["toolUseId"].as_str().unwrap_or("")))
        })
        .collect();
    assert_eq!(
        sequence,
        [
            "toolCall(call_1)",
            "toolCall(call_1)",
            "toolCall(call_2)",
            "toolCall(call_2)",
            "toolResult(call_1)",
            "toolResult(call_2)",
        ],
        "并发安全工具应当攒成一批：批内 toolCall 全部先发，toolResult 再按原顺序发"
    );

    // 两个工具都真的执行了（读到了各自文件的内容）
    let outputs: Vec<String> = harness
        .sink
        .events_of("toolResult")
        .into_iter()
        .map(|event| event["output"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(outputs[0].contains("alpha"), "got {outputs:?}");
    assert!(outputs[1].contains("beta"), "got {outputs:?}");
}

/// 非并发安全工具会把前面攒下的批先冲刷掉（批边界 = 连续段），
/// 之后再开新的一批。`[Read, Bash, Read]` 的期望时序见断言。
#[test]
fn a_non_concurrency_safe_tool_flushes_the_pending_batch() {
    let sandbox = Sandbox::new("engine-parallel-batch-flush");
    sandbox.write_file("a.txt", "alpha\n");
    sandbox.write_file("b.txt", "beta\n");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_multi_tool_sse(&[
                ("call_1", "Read", r#"{"file_path":"a.txt"}"#),
                // `echo` 是只读命令 → Bash 也并发安全；换成 `touch`（非只读）切开批次
                ("call_2", "Bash", r#"{"command":"touch marker.txt"}"#),
                ("call_3", "Read", r#"{"file_path":"b.txt"}"#),
            ])
        } else {
            openai_text_sse(&["好了"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "混合", "u-1");
    assert!(harness.wait_query_end(), "轮次应当跑完");

    let sequence: Vec<String> = harness
        .sink
        .events()
        .iter()
        .filter_map(|event| {
            let kind = event["type"].as_str()?;
            if kind != "toolCall" && kind != "toolResult" {
                return None;
            }
            Some(format!("{kind}({})", event["toolUseId"].as_str().unwrap_or("")))
        })
        .collect();
    assert_eq!(
        sequence,
        [
            "toolCall(call_1)",
            "toolCall(call_1)",
            "toolCall(call_2)",
            "toolCall(call_2)",
            "toolResult(call_1)",
            "toolResult(call_2)",
            "toolCall(call_3)",
            "toolCall(call_3)",
            "toolResult(call_3)",
        ],
        "Bash（非只读）应当切开批次：先把 Read 批跑完，再串行执行 Bash，最后再开新批"
    );
    assert!(sandbox.workspace.join("marker.txt").exists());
}

// ==================== 子代理（Agent / Reply） ====================

/// 完整链路：父会话调 `Agent` → 建子会话并后台跑 → 子代理调 `Reply` 投递回父会话
/// → 父会话收到一条 `origin='agent'` 的 user 消息并再跑一轮。
#[test]
fn agent_tool_spawns_a_sub_agent_that_replies_to_the_creator() {
    let sandbox = Sandbox::new("engine-agent-reply");
    crate::subagent::reset_for_test();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        if is_sub_agent_request(body) {
            // 子代理第一轮就调用 Reply 回报
            return openai_multi_tool_sse(&[(
                "call_reply",
                "Reply",
                r#"{"message":"子代理已完成任务"}"#,
            )]);
        }
        if !parent_saw_agent_tool_use(body) {
            return openai_multi_tool_sse(&[(
                "call_agent",
                "Agent",
                r#"{"prompt":"帮我查一下 sub-agent 相关代码","description":"Look into sub-agent","agentRole":"Master"}"#,
            )]);
        }
        openai_text_sse(&["好"])
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "派个子代理", "u-1");

    // 子代理的回复最终会作为 `origin='agent'` 的消息上报 UI
    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("message")
                .iter()
                .any(|event| event["data"]["origin"] == "agent"),
            Duration::from_secs(30),
        ),
        "应当收到子代理回复: {:?}",
        harness.sink.event_types()
    );
    let reply_event = harness
        .sink
        .events_of("message")
        .into_iter()
        .find(|event| event["data"]["origin"] == "agent")
        .expect("agent message");
    assert_eq!(reply_event["sessionId"], "s1");
    assert_eq!(reply_event["data"]["content"], "子代理已完成任务");
    // From 头：`host:agent:<sub session id>`
    let param = reply_event["data"]["param"].as_str().unwrap_or("");
    assert!(param.contains(":agent:sub_"), "got {param}");
    assert_eq!(reply_event["data"]["meta"]["type"], "from");

    // Agent 工具的 tool_result 文案（对齐 `AgentTool.mapToolResultToToolResultBlockParam`）
    let agent_result = harness
        .sink
        .events_of("toolResult")
        .into_iter()
        .find(|event| event["toolName"] == "Agent")
        .expect("Agent toolResult");
    let agent_output = agent_result["output"].as_str().unwrap_or("");
    assert!(agent_output.starts_with("✓ Agent [Master] created\n\n"), "got {agent_output}");
    assert!(
        agent_output.contains("Task: Look into sub-agent"),
        "got {agent_output}"
    );
    assert!(
        agent_output.contains("**Sub-agent ID**: `sub_")
            && agent_output.ends_with("The sub-agent will reply directly when done."),
        "got {agent_output}"
    );
    assert_eq!(agent_result["status"], "success");

    // 子会话落盘：meta.json 带 parentSessionId / role
    let project = sandbox.workspace.to_string_lossy().to_string();
    let sub_ids = crate::subagent::list_for_creator("s1");
    assert_eq!(sub_ids.len(), 1, "应当登记 1 个子代理");
    let metadata = crate::history::load_metadata(&sub_ids[0], &project).expect("子会话 meta.json");
    assert_eq!(metadata["parentSessionId"], "s1");
    assert_eq!(metadata["role"], "Master");
    assert!(metadata["messageCount"].as_u64().unwrap_or(0) >= 2);

    // 子会话的消息里有 Reply 的 tool_use
    let sub_messages = crate::history::load_messages(&sub_ids[0], &project);
    assert!(
        sub_messages.iter().any(has_reply_tool_use),
        "子代理应当调用过 Reply: {sub_messages:?}"
    );

    // 父会话的后续请求里带上了这条子代理回复
    assert!(
        harness.wait_for(
            |_| bodies.lock().unwrap().iter().any(|body| {
                body["messages"]
                    .as_array()
                    .map(|messages| {
                        messages.iter().any(|message| {
                            message.get("content").and_then(Value::as_str)
                                == Some("子代理已完成任务")
                        })
                    })
                    .unwrap_or(false)
            }),
            Duration::from_secs(30),
        ),
        "子代理回复应当进入父会话上下文"
    );
    crate::subagent::reset_for_test();
}

/// specs/005：一轮 6 个 `Agent` 调用最多 4 个子代理并行——先启动的 4 个子代理
/// 首请求都早于其中一个的完成时刻，其余 2 个（排队者，身份由线程竞速决定）
/// 必须等槽位释放才启动；最终 6 个全部启动并回报。
#[test]
fn agent_tool_caps_concurrent_sub_agents_and_queues_the_rest() {
    let sandbox = Sandbox::new("engine-agent-concurrency-cap");
    // 不调用 `subagent::reset_for_test()`：并行用例共享注册表 / 槽位，
    // 本用例用独立 creator id 隔离（与既有 Agent 用例同一约定）
    let creator = "sc1";

    struct Book {
        /// 子代理首请求到达顺序（task 编号）
        order: Vec<u32>,
        /// task → 首请求开始时刻（epoch 毫秒）
        starts: std::collections::HashMap<u32, u128>,
        /// (task, 追问轮到达时刻)：追问轮 = 该子代理即将收尾释放槽位
        finishes: Vec<(u32, u128)>,
    }
    let book = Arc::new(Mutex::new(Book {
        order: Vec::new(),
        starts: std::collections::HashMap::new(),
        finishes: Vec::new(),
    }));
    let epoch = std::time::Instant::now();

    let handler_book = Arc::clone(&book);
    let llm = FakeLlm::start(move |_index, body| {
        if is_sub_agent_request(body) {
            let task = (1..=6u32).find(|n| {
                body["messages"]
                    .as_array()
                    .map(|messages| {
                        messages.iter().any(|message| {
                            message
                                .get("content")
                                .and_then(Value::as_str)
                                .map(|text| text.contains(&format!("并发任务{n}：")))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            });
            let Some(task) = task else {
                return openai_text_sse(&["好"]);
            };
            // 消费循环在 Reply 之后还会追问：只有该子代理的**首请求**慢速应答并调用
            // Reply（槽位时序的可观测点），追问轮记录收尾时刻并文本终轮，
            // 避免无限循环
            {
                let mut book = handler_book.lock().unwrap();
                if book.starts.contains_key(&task) {
                    book.finishes.push((task, epoch.elapsed().as_millis()));
                    drop(book);
                    return openai_text_sse(&["好"]);
                }
                book.starts.insert(task, epoch.elapsed().as_millis());
                book.order.push(task);
            }
            // 慢速子代理请求：拉长「直取 4 槽」的占位窗口
            std::thread::sleep(Duration::from_millis(200));
            let reply = format!(r#"{{"message":"并发任务{task}完成"}}"#);
            return openai_multi_tool_sse(&[("reply", "Reply", &reply)]);
        }
        if !parent_saw_agent_tool_use(body) {
            let calls: Vec<(String, String, String)> = (1..=6u32)
                .map(|n| {
                    (
                        format!("agent_{n}"),
                        "Agent".to_string(),
                        format!(
                            r#"{{"prompt":"并发任务{n}：慢慢回答","agentRole":"Master","description":"任务{n}"}}"#
                        ),
                    )
                })
                .collect();
            let refs: Vec<(&str, &str, &str)> = calls
                .iter()
                .map(|(id, name, args)| (id.as_str(), name.as_str(), args.as_str()))
                .collect();
            return openai_multi_tool_sse(&refs);
        }
        openai_text_sse(&["全部完成"])
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();

    // 槽位峰值轮询：接线正确时 6 个调用里恰 4 个直取，active 峰值必达 4 且不超
    let poll_stop = Arc::new(AtomicBool::new(false));
    let max_active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    {
        let poll_stop = Arc::clone(&poll_stop);
        let max_active = Arc::clone(&max_active);
        std::thread::spawn(move || {
            while !poll_stop.load(Ordering::Relaxed) {
                let (active, _) = crate::subagent::slot_stats_for_test(creator);
                max_active.fetch_max(active, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(15));
            }
        });
    }

    submit(&harness, creator, "派6个并发子代理", "u-1");

    // 6 个子代理全部回报（排队者最终都拿到槽位并完成）
    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("message")
                .iter()
                .filter(|event| event["data"]["origin"] == "agent")
                .count()
                >= 6,
            Duration::from_secs(60),
        ),
        "6 个子代理都应完成回报: {:?}",
        harness.sink.event_types()
    );
    poll_stop.store(true, Ordering::Relaxed);

    let book = book.lock().unwrap();
    assert_eq!(book.order.len(), 6, "6 个子代理都应发起首请求: {:?}", book.order);
    // 槽位峰值恰为 4：低于 4 说明接线缺失，高于 4 说明上限失效
    assert_eq!(
        max_active.load(Ordering::Relaxed),
        4,
        "并行子代理槽位峰值应为 4"
    );
    // 排队者只能在槽位释放后启动：首请求晚于最早的追问轮（该子代理即将释放槽位）
    let first_finish = book
        .finishes
        .iter()
        .map(|(_, at)| *at)
        .min()
        .expect("子代理应有追问轮");
    for (task, start) in &book.starts {
        if book.order.get(4) != Some(task) && book.order.get(5) != Some(task) {
            continue;
        }
        assert!(
            *start > first_finish,
            "排队者只能在槽位释放后启动: task={task} start={start} first_finish={first_finish}"
        );
    }
    // 注册表累计登记全部 6 个子代理
    assert_eq!(crate::subagent::list_for_creator(creator).len(), 6);
}

/// 子代理完整继承主对话的 agent mode：manual / risk / auto 一律照搬（不能把
/// manual 降级成 risk 造成越权），并落盘到子会话
/// meta.json 的 context，重启后重开子会话仍显示继承来的模式。
#[test]
fn sub_agent_inherits_parent_agent_mode() {
    let sandbox = Sandbox::new("engine-sub-agent-inherit-mode");
    // 不调用 `subagent::reset_for_test()`：注册表是进程级全局状态，本用例改用独立的
    // creator id，避免与并行的 Agent 用例互相清空 / 误判 `list_for_creator`。
    let llm = FakeLlm::start(|_index, body| {
        if is_sub_agent_request(body) {
            return openai_multi_tool_sse(&[(
                "call_reply",
                "Reply",
                r#"{"message":"子代理已完成任务"}"#,
            )]);
        }
        openai_text_sse(&["好"])
    });
    // 默认 risk：子代理取到的应是父会话的值，而不是 settings 的默认值
    prepare(&sandbox, &llm.base_url, "risk");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let harness = EngineHarness::allow_all();
    let creator = "s-inherit";
    history::create_conversation(creator, &project, json!({ "sessionId": creator })).unwrap();

    for mode in ["manual", "risk", "auto"] {
        let parent = harness.core.session(creator);
        parent.lock().unwrap().agent_mode = mode.to_string();
        let sub_id = harness
            .core
            .create_sub_agent(tools::SubAgentRequest {
                creator_session_id: creator.to_string(),
                prompt: format!("任务 {mode}"),
                description: format!("inherit {mode}"),
                role: "Master".to_string(),
            })
            .expect("create sub agent");

        assert_eq!(
            harness.core.session(&sub_id).lock().unwrap().agent_mode,
            mode,
            "子代理应当原样继承父会话的 agent mode"
        );
        let metadata = history::load_metadata(&sub_id, &project).expect("子会话 meta.json");
        assert_eq!(
            metadata["context"]["agentMode"], mode,
            "继承来的 agent mode 应当落盘到子会话 meta.json"
        );
    }
}

/// 子代理继承主对话的提示词预设：system prompt = 主对话同款（按继承的预设组装）+
/// 开头 `## Communication` 段；预设仍决定工具白名单（minimal 只有 Bash / Edit）。
#[test]
fn sub_agent_inherits_parent_prompt_mode() {
    let sandbox = Sandbox::new("engine-sub-agent-inherit-prompt");
    // 与 agent mode 用例同理：用独立 creator id，避免与并行的 Agent 用例互相清空注册表。
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        if is_sub_agent_request(body) {
            return openai_multi_tool_sse(&[(
                "call_reply",
                "Reply",
                r#"{"message":"子代理已完成任务"}"#,
            )]);
        }
        openai_text_sse(&["好"])
    });
    prepare(&sandbox, &llm.base_url, "risk");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let harness = EngineHarness::allow_all();
    let creator = "s-inherit-prompt";
    history::create_conversation(creator, &project, json!({ "sessionId": creator })).unwrap();

    for mode in ["minimal", "normal"] {
        harness.core.session(creator).lock().unwrap().prompt_mode = Some(mode.to_string());
        let sub_id = harness
            .core
            .create_sub_agent(tools::SubAgentRequest {
                creator_session_id: creator.to_string(),
                prompt: format!("任务 {mode}"),
                description: format!("inherit prompt {mode}"),
                role: "Master".to_string(),
            })
            .expect("create sub agent");

        assert_eq!(
            harness
                .core
                .session(&sub_id)
                .lock()
                .unwrap()
                .prompt_mode
                .as_deref(),
            Some(mode),
            "子代理应当原样继承父会话的提示词预设"
        );
    }

    assert!(
        harness.wait_for(
            |_| {
                let bodies = bodies.lock().unwrap();
                let has_normal = bodies.iter().any(|body| {
                    is_sub_agent_request(body)
                        && body["messages"][0]["content"]
                            .as_str()
                            .map(|system| system.contains("## Core Principles"))
                            .unwrap_or(false)
                });
                let has_minimal = bodies.iter().any(|body| {
                    is_sub_agent_request(body)
                        && body["messages"][0]["content"]
                            .as_str()
                            .map(|system| !system.contains("## Core Principles"))
                            .unwrap_or(false)
                });
                has_normal && has_minimal
            },
            Duration::from_secs(30),
        ),
        "两个子代理（minimal / normal）的 LLM 请求都应当到达"
    );

    let bodies = bodies.lock().unwrap();
    let mut minimal_prompt: Option<String> = None;
    let mut normal_prompt: Option<String> = None;
    let mut minimal_tools: Vec<String> = Vec::new();
    let mut normal_tools: Vec<String> = Vec::new();
    for body in bodies.iter().filter(|body| is_sub_agent_request(body)) {
        let system = body["messages"][0]["content"].as_str().unwrap_or("");
        // 注意：normal 的核心身份也以 "You are a helpful software engineer assistant." 开头，
        // 因此先用 `## Core Principles` 区分 normal，再落到 minimal。
        if system.contains("## Core Principles") {
            normal_prompt = Some(system.to_string());
            normal_tools = tool_names(body);
        } else if system.contains("You are a helpful software engineer assistant.") {
            minimal_prompt = Some(system.to_string());
            minimal_tools = tool_names(body);
        }
    }

    // minimal：Communication 前缀 + 极简单行核心身份，无工具说明区块；工具仅 Bash / Edit
    let minimal_prompt = minimal_prompt.expect("应当有 minimal 子代理请求");
    assert!(
        minimal_prompt.starts_with("## Communication"),
        "minimal 子代理 prompt 应当以 Communication 开头: {minimal_prompt}"
    );
    assert!(
        !minimal_prompt.contains("## Tool Usage"),
        "minimal 子代理 prompt 不应带工具说明: {minimal_prompt}"
    );
    assert_eq!(minimal_tools, vec!["Bash".to_string(), "Edit".to_string()]);

    // normal：Communication 前缀 + 完整核心身份 + 工具说明 / 环境区块；工具全量
    let normal_prompt = normal_prompt.expect("应当有 normal 子代理请求");
    assert!(
        normal_prompt.starts_with("## Communication"),
        "normal 子代理 prompt 应当以 Communication 开头: {normal_prompt}"
    );
    assert!(
        normal_prompt.contains("## Tool Usage"),
        "normal 子代理 prompt 应当带工具说明: {normal_prompt}"
    );
    assert!(
        normal_prompt.contains("## Environment"),
        "normal 子代理 prompt 应当带环境区块: {normal_prompt}"
    );
    assert!(normal_tools.len() > 2, "normal 子代理应当拿到全量工具");
}

/// 子代理没调用 `Reply` 时注入 Reminder（最多 3 次），措辞随重试次数递进。
#[test]
fn sub_agent_without_reply_gets_reminders() {
    let sandbox = Sandbox::new("engine-agent-reminder");
    crate::subagent::reset_for_test();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        if is_sub_agent_request(body) {
            // 子代理始终只回文本、不调 Reply
            return openai_text_sse(&["我做完了"]);
        }
        if !parent_saw_agent_tool_use(body) {
            return openai_multi_tool_sse(&[(
                "call_agent",
                "Agent",
                r#"{"prompt":"查 sub-agent 代码","agentRole":"Master"}"#,
            )]);
        }
        openai_text_sse(&["好"])
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "派个子代理", "u-1");

    // 子代理会话应当收到 3 条 Reminder（每次都是一轮完整查询）
    assert!(
        harness.wait_for(
            |_| bodies.lock().unwrap().iter().filter(|body| is_sub_agent_request(body)).count() >= 4,
            Duration::from_secs(30),
        ),
        "子代理应当在首轮 + 3 次 Reminder 后停止"
    );

    let bodies = bodies.lock().unwrap();
    let sub_bodies: Vec<&Value> = bodies
        .iter()
        .filter(|body| is_sub_agent_request(body))
        .collect();
    // 第 2 个子代理请求（首次 Reminder 之后）应当带第 1 档引导文案
    let reminder_seen = sub_bodies.iter().skip(1).any(|body| {
        body["messages"]
            .as_array()
            .map(|messages| {
                messages.iter().any(|message| {
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .map(|text| text.contains("did you generate `reply` tool call?"))
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false)
    });
    assert!(reminder_seen, "首个 Reminder 应当带第 1 档引导文案");
    crate::subagent::reset_for_test();
}

/// 子代理请求的判据：首条 system 消息带 `## Communication` 段
fn is_sub_agent_request(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .and_then(|messages| messages.first())
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(|text| text.contains("## Communication"))
        .unwrap_or(false)
}

/// 父会话是否已经拿到过 Agent 的工具结果（结果文案里带 "Sub-agent created"）
fn parent_saw_agent_tool_use(body: &Value) -> bool {
    body["messages"]
        .as_array()
        .map(|messages| {
            messages.iter().any(|message| {
                message
                    .get("content")
                    .and_then(Value::as_str)
                    .map(|text| text.contains("Sub-agent created with ID: sub_"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn has_reply_tool_use(message: &Value) -> bool {
    message
        .get("message")
        .and_then(|inner| inner.get("content"))
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks.iter().any(|block| {
                block.get("type").and_then(Value::as_str) == Some("tool_use")
                    && block.get("name").and_then(Value::as_str) == Some("Reply")
            })
        })
        .unwrap_or(false)
}

/// 用户消息是**单槽位**：查询中途连发两条时，后一条替换前一条，
/// 只有最后一条进入上下文并落盘。
#[test]
fn a_second_user_message_replaces_the_pending_one() {
    let sandbox = Sandbox::new("engine-queue-replace");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let slot: Arc<Mutex<Option<Arc<Core>>>> = Arc::new(Mutex::new(None));
    let submitter = Arc::clone(&slot);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            if let Some(core) = submitter.lock().unwrap().as_ref() {
                for content in ["第二条", "第三条"] {
                    core.on_user_message(&json!({
                        "sessionId": "s1",
                        "content": content,
                        "uuid": format!("u-{content}"),
                        "workspacePath": null,
                    }));
                }
            }
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["收到"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    *slot.lock().unwrap() = Some(Arc::clone(&harness.core));
    submit(&harness, "s1", "第一条", "u-1");
    assert!(
        harness.wait_for(
            |sink| sink.events_of("queryEnd").len() >= 1,
            std::time::Duration::from_secs(30),
        ),
        "轮次应当跑完: {:?}",
        harness.sink.event_types()
    );

    let bodies = bodies.lock().unwrap();
    let second = bodies[1]["messages"].as_array().expect("messages");
    let texts: Vec<&str> = second
        .iter()
        .filter_map(|message| message.get("content").and_then(Value::as_str))
        .collect();
    assert!(texts.contains(&"第三条"), "最后一条应当进入上下文: {texts:?}");
    assert!(
        !texts.contains(&"第二条"),
        "被替换掉的那条不应进入上下文: {texts:?}"
    );

    // 落盘口径一致：只有最后一条
    let messages = crate::history::load_messages("s1", &sandbox.workspace.to_string_lossy());
    let persisted: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    assert!(persisted.iter().any(|text| text == "第三条"), "{persisted:?}");
    assert!(!persisted.iter().any(|text| text == "第二条"), "{persisted:?}");
}

// ==================== 斜杠命令 / Skill 注入 ====================

/// `/commit -m 'x'`：命中 Skill → 用户消息照常进上下文 → 注入 Skill tool_use
/// （assistant tool_use + tool_result 携带技能正文）→ 技能正文作为 `isMeta` 的
/// user 消息落盘。
#[test]
fn slash_skill_command_injects_the_skill_tool_use() {
    let sandbox = Sandbox::new("engine-skill-command");
    crate::skills::reset_registries();
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "/commit -m 'Fix bug'", "u-1");

    assert!(
        harness.wait_for(
            |sink| sink.events_of("toolResult").iter().any(|event| event["toolName"] == "Skill"),
            Duration::from_secs(30),
        ),
        "应当收到 Skill 的 toolResult: {:?}",
        harness.sink.event_types()
    );
    let skill_result = harness
        .sink
        .events_of("toolResult")
        .into_iter()
        .find(|event| event["toolName"] == "Skill")
        .expect("Skill toolResult");
    assert_eq!(skill_result["status"], "success");
    assert_eq!(
        skill_result["output"],
        "Skill \"commit\" has been loaded. Follow the instructions in the skill content above."
    );

    // UI 上架 Skill 卡片：授权前 / 执行前各发一次 `toolCall`；
    // 缺了它们，`/<skill>` 在 UI 上没有任何可见的触发痕迹（`toolResult` 只能更新已存在的卡片）。
    let skill_calls = harness
        .sink
        .events_of("toolCall")
        .into_iter()
        .filter(|event| event["toolName"] == "Skill")
        .count();
    assert_eq!(
        skill_calls,
        2,
        "授权 / 执行各一次 toolCall: {:?}",
        harness.sink.event_types()
    );
    // 卡片由 `toolPermissionRequested` 上架：Skill 的 checkPermissions 恒 allow，
    // 不弹确认框，但请求本身必须发（携带 displayArgs）。
    let permission = harness
        .sink
        .requests_of("toolPermissionRequested")
        .into_iter()
        .find(|request| request["toolName"] == "Skill")
        .expect("应当发一次 Skill 的 toolPermissionRequested");
    assert_eq!(permission["permResult"]["behavior"], "allow");
    assert_eq!(permission["displayArgs"]["skill"], "commit");

    // 消费循环跑完（`queryEnd`）后再读盘：注入消息的落盘发生在 toolResult 事件之后，
    // 只等 toolResult 会与落盘赛跑
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "消费循环应当收尾: {:?}",
        harness.sink.event_types()
    );

    let project = sandbox.workspace.to_string_lossy().to_string();
    let messages = crate::history::load_messages("s1", &project);

    // 1) 用户消息原样在上下文里（Skill 命令不吞消息）
    assert!(
        messages.iter().any(|message| {
            message.get("type").and_then(Value::as_str) == Some("user")
                && message["message"]["content"] == json!("/commit -m 'Fix bug'")
        }),
        "用户消息应当进上下文: {messages:?}"
    );

    // 2) assistant 侧有 `Skill` 的 tool_use，入参含 skill + args
    let skill_tool_use = messages
        .iter()
        .flat_map(|message| {
            message["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .find(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("Skill")
        })
        .expect("assistant 侧应当有 Skill tool_use");
    assert_eq!(skill_tool_use["input"]["skill"], "commit");
    assert_eq!(skill_tool_use["input"]["args"], "-m 'Fix bug'");

    // 3) tool_result 是**短文案**（对齐 `mapToolResultToToolResultBlockParam` 返回
    //    `result.result`）：技能正文走 newMessages，不塞进 tool_result
    let skill_result_text = messages
        .iter()
        .flat_map(|message| {
            message["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .find(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_result")
                && block.get("tool_use_id") == skill_tool_use.get("id")
        })
        .and_then(|block| block["content"].as_str().map(str::to_string))
        .expect("Skill 的 tool_result");
    assert_eq!(
        skill_result_text,
        "Skill \"commit\" has been loaded. Follow the instructions in the skill content above."
    );

    // 4) 技能正文另作为 `isMeta: true` 的 user 消息注入（UI 不展示，模型能读到）
    let injected = messages
        .iter()
        .find(|message| message.get("isMeta").and_then(Value::as_bool) == Some(true))
        .unwrap_or_else(|| panic!("应当有 isMeta 的注入消息，实际: {messages:?}"));
    assert_eq!(injected["type"], "user");
    assert_eq!(injected["message"]["role"], "user");
    let injected_text = injected["message"]["content"].as_str().unwrap_or("");
    assert!(
        injected_text.starts_with("## Context\n\n- Current git status: run `git status`"),
        "注入内容应当是技能正文: {}",
        &injected_text[..injected_text.len().min(120)]
    );
    // 用户附加说明已拼进正文
    assert!(
        injected_text.ends_with("## Additional instructions from user\n\n-m 'Fix bug'"),
        "用户参数应当追加到技能正文末尾"
    );
    // 注入消息紧随该批 tool_result 之后（对齐 RunTools 的 yield 顺序）
    let injected_index = messages
        .iter()
        .position(|message| message.get("isMeta").and_then(Value::as_bool) == Some(true))
        .unwrap();
    let result_index = messages
        .iter()
        .position(|message| {
            message["message"]["content"]
                .as_array()
                .map(|blocks| {
                    blocks.iter().any(|block| {
                        block.get("type").and_then(Value::as_str) == Some("tool_result")
                            && block.get("tool_use_id") == skill_tool_use.get("id")
                    })
                })
                .unwrap_or(false)
        })
        .unwrap();
    assert_eq!(injected_index, result_index + 1, "注入消息应紧随 tool_result");

    crate::skills::reset_registries();
}

/// `/commit` 延迟回显（`deferEcho`）：命令消息真正进入上下文时补发用户 `message`
/// （宿主不乐观回显），且 `_needsUINotification` 是 UI 专用标记、不落盘。
#[test]
fn deferred_skill_command_reemits_the_user_message() {
    let sandbox = Sandbox::new("engine-skill-deferred");
    crate::skills::reset_registries();
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({
        "sessionId": "s1",
        "content": "/commit",
        "uuid": "u-deferred",
        "deferEcho": true,
    }));

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "消费循环应当收尾: {:?}",
        harness.sink.event_types()
    );

    // 进入上下文 → 补发用户气泡（带同一个 uuid，供 webview 配对排队项）
    let user_message = harness
        .sink
        .events_of("message")
        .into_iter()
        .find(|event| {
            event["data"]["role"] == "user" && event["data"]["messageUuid"] == "u-deferred"
        })
        .unwrap_or_else(|| {
            panic!("应当补发用户气泡: {:?}", harness.sink.event_types());
        });
    assert_eq!(user_message["data"]["content"], "/commit");

    // UI 专用标记不落盘
    let project = sandbox.workspace.to_string_lossy().to_string();
    let messages = crate::history::load_messages("s1", &project);
    assert!(
        messages
            .iter()
            .all(|message| message.get("_needsUINotification").is_none()),
        "UI 专用标记不该落盘: {messages:?}"
    );

    crate::skills::reset_registries();
}

/// `/spin`（内置命令）即使延迟回显也**不该**补发用户气泡：消息就地执行、被丢弃，
/// 补发会留下一个刷新后消失的「幽灵」气泡。
#[test]
fn deferred_builtin_command_does_not_reemit_the_user_message() {
    let sandbox = Sandbox::new("engine-builtin-deferred");
    crate::skills::reset_registries();
    let llm = FakeLlm::fixed(openai_text_sse(&["好的"]));
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    harness.core.on_user_message(&json!({
        "sessionId": "s1",
        "content": "/spin",
        "uuid": "u-spin-deferred",
        "deferEcho": true,
    }));

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "消费循环应当收尾: {:?}",
        harness.sink.event_types()
    );

    assert!(
        !harness
            .sink
            .events_of("message")
            .iter()
            .any(|event| event["data"]["messageUuid"] == "u-spin-deferred"),
        "内置命令不该补发用户气泡: {:?}",
        harness.sink.event_types()
    );

    crate::skills::reset_registries();
}

/// `/spin design`：内置命令就地执行 → 该消息**不进** LLM 上下文，也不发起查询；
/// 执行前发一次 `commandDispatched` 让 UI 打开设计器。
#[test]
fn slash_builtin_command_is_handled_without_an_llm_round() {
    let sandbox = Sandbox::new("engine-builtin-command");
    crate::skills::reset_registries();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["不应被调用"])
    });
    prepare(&sandbox, &llm.base_url, "auto");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "/spin design", "u-1");

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("commandDispatched").is_empty(),
            Duration::from_secs(30),
        ),
        "应当收到 commandDispatched: {:?}",
        harness.sink.event_types()
    );
    let dispatched = &harness.sink.events_of("commandDispatched")[0];
    assert_eq!(dispatched["sessionId"], "s1");
    assert_eq!(dispatched["commandName"], "spin");
    assert_eq!(dispatched["args"], "design");

    // 内置命令被就地执行：没有发起任何 LLM 请求。
    // 注意 `queryBegin` / `queryEnd` 仍会成对出现——它们归**消费循环**所有
    // ，与是否真的调 LLM 无关。
    assert!(bodies.lock().unwrap().is_empty(), "内置命令不应发起 LLM 请求");
    assert_eq!(harness.sink.events_of("queryBegin").len(), 1);
    assert_eq!(harness.sink.events_of("queryEnd").len(), 1);

    // 会话上下文里没有这条命令消息
    let project = sandbox.workspace.to_string_lossy().to_string();
    let messages = crate::history::load_messages("s1", &project);
    assert!(
        !messages.iter().any(|message| {
            message["message"]["content"] == json!("/spin design")
        }),
        "内置命令消息不应进上下文: {messages:?}"
    );

    crate::skills::reset_registries();
}

// ==================== MCP 工具接线 ====================

#[test]
fn mcp_tool_names_are_recognized_as_known_tools() {
    let _sandbox = Sandbox::new("engine-mcp-known");
    // MCP 工具由服务器动态提供，不在内置工具表里，但**是**已注册的工具：
    // 判成「工具不存在」会让 MCP 工具永远走不到执行分支。
    assert!(!crate::tools::is_known("mcp__demo__echo"));
    assert!(crate::engine::is_known_tool("mcp__demo__echo"));
    assert!(crate::engine::is_known_tool("Bash"));
    assert!(!crate::engine::is_known_tool("Nope"));
}

#[test]
fn mcp_tools_are_appended_to_the_session_tool_list() {
    let _sandbox = Sandbox::new("engine-mcp-tools");
    let definitions = crate::engine::all_tool_definitions("no-such-session");
    // 没有 MCP 连接时清单就是内置工具表本身（顺序不变）
    assert_eq!(definitions, crate::tools::definitions());
}

#[test]
fn mcp_tools_are_concurrency_safe_per_their_annotations() {
    let _sandbox = Sandbox::new("engine-mcp-concurrency");
    // 未连接 / 未注册的 MCP 工具读不到注解 → 按「不安全」处理（与 Tool 默认实现一致）
    assert!(!crate::engine::is_tool_concurrency_safe("mcp__demo__echo", &json!({})));
    // 内置工具的口径不受影响
    assert!(crate::engine::is_tool_concurrency_safe("Read", &json!({})));
    assert!(!crate::engine::is_tool_concurrency_safe("Write", &json!({})));
}

// ==================== 权限往返期间的 waiting（RT-1 / RT-2） ====================
//
// 缺陷：`toolPermissionRequested` 的往返（工具卡片上架 / 权限结果回传）曾被
// `waiting_request` 一并标成 `waiting`，于是**每次工具调用**都凭空多出一次
// `running → waiting` 迁移——托盘「任务结束提醒」闪一下（毫秒级、看不见）并响一声，
// 侧栏黄灯同样闪：权限确认往返不碰 `sessionRuntime`，只有选择框请求才标记。
// 行为口径见 `docs/core/session-runtime.md` 第 1 节。

/// 统计快照序列里 `waiting` 为真的推送条数（只算目标会话）
fn waiting_snapshots(harness: &EngineHarness, session_id: &str) -> usize {
    harness
        .sink
        .events_of("sessionRuntimeChanged")
        .iter()
        .filter(|event| {
            event["states"]
                .as_array()
                .map(|states| {
                    states
                        .iter()
                        .any(|state| state["sessionId"] == session_id && state["waiting"] == true)
                })
                .unwrap_or(false)
        })
        .count()
}

/// RT-1：auto 免确认的工具调用全程不产生 `waiting`（工具卡片往返不算等用户）
#[test]
fn auto_approved_tool_permission_never_marks_the_session_waiting() {
    let sandbox = Sandbox::new("engine-waiting-auto");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "auto");

    // auto 模式：权限结果已是 allow，宿主只是渲染卡片
    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(json!({ "behavior": "allow" })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑个命令", "u-1");
    assert!(harness.wait_query_end());

    // 卡片确实上架过（否则这条用例会因「压根没走到权限」而空转）
    assert_eq!(harness.sink.requests_of("toolPermissionRequested").len(), 1);
    assert_eq!(harness.sink.requests_of("userChoice").len(), 0, "auto 模式不弹确认框");
    assert_eq!(
        waiting_snapshots(&harness, "s1"),
        0,
        "工具卡片往返不该把会话标成等待用户"
    );
}

/// RT-2：manual 模式下 `waiting` 只在真确认框（`userChoice`）在途期间为真
#[test]
fn manual_tool_permission_marks_waiting_only_while_the_choice_is_pending() {
    let sandbox = Sandbox::new("engine-waiting-manual");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "Bash", r#"{"command":"echo hi"}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        // 上架卡片 → 保持 ask（真确认框随后由 userChoice 弹）
        "toolPermissionRequested" => Some(json!({ "behavior": "ask" })),
        "userChoice" => Some(json!({ "index": 0 })),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "跑个命令", "u-1");
    assert!(harness.wait_query_end());

    assert_eq!(harness.sink.requests_of("toolPermissionRequested").len(), 1);
    assert_eq!(harness.sink.requests_of("userChoice").len(), 1);
    // 快照序列应为：(running,waiting=false) → (running,waiting=true) → (running,waiting=false) → idle
    // 即 waiting 只在真确认框在途期间为真（1 条）；卡片往返若也标记会变成 2 条
    assert_eq!(
        waiting_snapshots(&harness, "s1"),
        1,
        "只有真确认框在途期间才算等待用户"
    );
}

// ==================== 失败卡片的 waiting（specs/defects/tool-card-roundtrip-marks-waiting.md） ====================
//
// 缺陷：入参校验失败与未知工具两条分支同样用 `waiting_request` 发 `toolPermissionRequested`，
// 在途期间把会话标成 waiting → 托盘黄点闪一下、窗口在后台时响一声提醒音，而界面上
// 只有一张失败卡片、没有任何要用户回答的东西。口径见 `docs/core/session-runtime.md` 第 1 节：
// 该往返由 `plain_request` 承担，不碰 `sessionRuntime`。

/// RT-1：结构非法（`choices` 项带多余字段）的 AskUserQuestion 只产出 `InputValidationError`，
/// 全程不标记 waiting、不弹提问框。
#[test]
fn invalid_ask_user_question_schema_never_marks_the_session_waiting() {
    let sandbox = Sandbox::new("engine-ask-user-invalid-schema");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse(
                "call_1",
                "AskUserQuestion",
                r#"{"question":"选哪个？","choices":[{"label":"A","color":"red"}]}"#,
            )
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "问个问题", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["status"], "error");
    let output = result["output"].as_str().unwrap();
    assert!(output.starts_with("InputValidationError:"), "got {output}");
    // 校验在 `emitToUi(toolCall)` 之前返回：UI 拿不到可渲染的提问卡片
    assert!(harness.sink.event_of("toolCall").is_none());
    // 仍上架一张失败卡片，但不弹提问框
    assert_eq!(harness.sink.requests_of("toolPermissionRequested").len(), 1);
    assert!(harness.sink.requests_of("userChoice").is_empty());
    // 关键断言：没有任何要用户回答的东西，就不该出现 waiting 快照
    assert_eq!(
        waiting_snapshots(&harness, "s1"),
        0,
        "入参校验失败的卡片往返不该把会话标成等待用户"
    );
}

/// RT-2：语义非法（`question` 纯空白）同上。
#[test]
fn blank_ask_user_question_never_marks_the_session_waiting() {
    let sandbox = Sandbox::new("engine-ask-user-blank-question");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_1", "AskUserQuestion", r#"{"question":"   "}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::start(|request| match request["type"].as_str().unwrap() {
        "toolPermissionRequested" => Some(request["permResult"].clone()),
        _ => Some(json!({})),
    });
    submit(&harness, "s1", "问个问题", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(
        result["output"],
        "InputValidationError: Question cannot be empty"
    );
    assert!(harness.sink.requests_of("userChoice").is_empty());
    assert_eq!(
        waiting_snapshots(&harness, "s1"),
        0,
        "语义校验失败的卡片往返不该把会话标成等待用户"
    );
}

/// RT-3：未知工具（模型幻觉出的名字）同样只上架失败卡片，不标记 waiting。
#[test]
fn unknown_tool_never_marks_the_session_waiting() {
    let sandbox = Sandbox::new("engine-unknown-tool-waiting");
    let llm = FakeLlm::start(|index, _| {
        if index == 0 {
            openai_tool_sse("call_x", "Nope", r#"{"a":1}"#)
        } else {
            openai_text_sse(&["好的"])
        }
    });
    prepare(&sandbox, &llm.base_url, "manual");

    let harness = EngineHarness::allow_all();
    submit(&harness, "s1", "跑一下", "u-1");
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());

    let result = harness.sink.event_of("toolResult").unwrap();
    assert_eq!(result["output"], "Error: Tool \"Nope\" not found");
    assert!(harness.sink.requests_of("userChoice").is_empty());
    assert_eq!(
        waiting_snapshots(&harness, "s1"),
        0,
        "未知工具的卡片往返不该把会话标成等待用户"
    );
}

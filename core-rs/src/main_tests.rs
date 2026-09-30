//! `main` 的单元测试：UiEvent 分发与 `conversationStarted` 的会话建档。

use super::*;
use crate::test_support::{EngineHarness, Sandbox};
use serde_json::json;

fn dispatch(harness: &EngineHarness, event: Value) {
    dispatch_ui_event(&harness.core, &harness.bus, event);
}

fn system_message(harness: &EngineHarness) -> String {
    harness.sink.event_of("message").expect("system message")["data"]["content"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn host_environment_event_populates_config() {
    let sandbox = Sandbox::new("main-host-env");
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({
            "type": "hostEnvironmentProvided",
            "locale": "en-US",
            "extensionPath": "D:/ext",
            "logToConsole": true,
            "configDirName": sandbox.config_dir_name,
        }),
    );

    let env = config::host_environment().expect("host env");
    assert_eq!(env.locale, "en-US");
    assert_eq!(env.extension_path, "D:/ext");
    assert!(env.log_to_console);
    assert!(config::conversations_root().unwrap().is_dir());
}

#[test]
fn host_environment_defaults_are_used_for_missing_fields() {
    let _sandbox = Sandbox::new("main-host-env-defaults");
    let harness = EngineHarness::allow_all();
    dispatch(&harness, json!({ "type": "hostEnvironmentProvided" }));

    let env = config::host_environment().expect("host env");
    assert_eq!(env.locale, "en");
    assert_eq!(env.extension_path, "");
    assert!(!env.log_to_console);
    assert_eq!(env.config_dir_name, ".tuxedo-cat", "缺省值对齐默认配置目录名");
}

#[test]
fn workspace_changed_event_updates_the_active_workspace() {
    let sandbox = Sandbox::new("main-workspace");
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "workspaceChanged", "workspacePath": sandbox.workspace.to_string_lossy() }),
    );
    assert_eq!(config::project_root("s1").unwrap(), sandbox.workspace.to_string_lossy());

    dispatch(&harness, json!({ "type": "workspaceChanged", "workspacePath": null }));
    assert!(config::project_root("s1").is_err());
}

/// `userChoicePendingChanged`：宿主上报选择框弹出 / 应答，core 据此更新
/// `sessionRuntime.waiting`（对齐 Embedded `initializeCoreEvents` 的 `markSessionWaiting`）。
#[test]
fn user_choice_pending_updates_the_waiting_runtime_state() {
    let _sandbox = Sandbox::new("main-user-choice-pending");
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "userChoicePendingChanged", "sessionId": "s1", "pending": true }),
    );
    let states = harness.sink.events_of("sessionRuntimeChanged");
    let latest = states.last().expect("runtime event");
    assert_eq!(latest["states"][0]["sessionId"], "s1");
    assert_eq!(latest["states"][0]["waiting"], true);
    assert_eq!(latest["states"][0]["idle"], false);

    dispatch(
        &harness,
        json!({ "type": "userChoicePendingChanged", "sessionId": "s1", "pending": false }),
    );
    let states = harness.sink.events_of("sessionRuntimeChanged");
    let latest = states.last().expect("runtime event");
    assert_eq!(latest["states"][0]["waiting"], false);
    assert_eq!(latest["states"][0]["idle"], true);
}

/// 对齐 Embedded：`conversationStarted` 只登记工作目录（内存态），**不建档、不广播**。
/// `meta.json` / `.jsonl` 只在第一条消息持久化时创建，避免空对话出现在列表里。
#[test]
fn conversation_started_only_registers_the_workspace() {
    let sandbox = Sandbox::new("main-conversation-started");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    sandbox.write_settings(json!({ "defaultModel": "gpt-x" }));
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "conversationStarted", "sessionId": "s1", "workspacePath": workspace }),
    );

    // 不落盘
    assert!(history::load_metadata("s1", &workspace).is_none(), "不应预建 meta.json");
    assert!(!history::messages_path("s1", &workspace).unwrap().exists(), "不应预建 .jsonl");
    // 不广播会话创建 / 列表变化
    assert!(harness.sink.event_of("sessionCreated").is_none());
    assert!(harness.sink.event_of("conversationListChanged").is_none());
    // 运行时状态照常上报（Standalone 下宿主靠它知道会话存在）
    assert!(harness.sink.event_of("sessionRuntimeChanged").is_some());
    // 会话运行时状态记住了工作目录
    assert_eq!(
        harness.core.session("s1").lock().unwrap().project.as_deref(),
        Some(workspace.as_str())
    );
}

#[test]
fn conversation_started_keeps_existing_metadata() {
    let sandbox = Sandbox::new("main-conversation-started-existing");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &workspace,
        json!({ "sessionId": "s1", "project": workspace, "title": "老标题" }),
    )
    .unwrap();
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "conversationStarted", "sessionId": "s1", "workspacePath": workspace }),
    );

    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "老标题");
    assert!(harness.sink.event_of("sessionCreated").is_none());
}

#[test]
fn conversation_started_without_a_session_id_is_ignored() {
    let sandbox = Sandbox::new("main-conversation-started-no-id");
    let harness = EngineHarness::allow_all();
    dispatch(
        &harness,
        json!({
            "type": "conversationStarted",
            "sessionId": "",
            "workspacePath": sandbox.workspace.to_string_lossy()
        }),
    );
    assert!(harness.sink.events().is_empty());
}

/// 对齐 Embedded：没有工作目录时 `conversationStarted` 静默返回（不报错、不广播）。
#[test]
fn conversation_started_without_a_workspace_is_silent() {
    let _sandbox = Sandbox::new("main-conversation-started-no-workspace");
    let harness = EngineHarness::allow_all();
    dispatch(&harness, json!({ "type": "conversationStarted", "sessionId": "s1" }));

    assert!(harness.sink.events().is_empty());
    assert!(harness.core.session_if_exists("s1").is_none());
}

#[test]
fn conversation_started_falls_back_to_the_active_workspace() {
    let sandbox = Sandbox::new("main-conversation-started-fallback");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    let harness = EngineHarness::allow_all();

    dispatch(&harness, json!({ "type": "conversationStarted", "sessionId": "s1" }));
    assert_eq!(
        harness.core.session("s1").lock().unwrap().project.as_deref(),
        Some(workspace.as_str())
    );
    assert!(history::load_metadata("s1", &workspace).is_none());
}

#[test]
fn conversation_lifecycle_events_are_dispatched() {
    let sandbox = Sandbox::new("main-lifecycle");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    let harness = EngineHarness::allow_all();

    dispatch(&harness, json!({ "type": "conversationOpened", "sessionId": "s1" }));
    assert!(harness.core.session_if_exists("s1").is_some());

    dispatch(&harness, json!({ "type": "conversationRenamed", "sessionId": "s1", "title": "改名" }));
    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "改名");

    dispatch(
        &harness,
        json!({ "type": "conversationContextUpdated", "sessionId": "s1",
                "changes": [{ "key": "currentFile", "value": "a.ts" }] }),
    );
    assert_eq!(
        history::load_metadata("s1", &workspace).unwrap()["context"]["currentFile"],
        "a.ts"
    );

    // 缺 changes 字段时按空列表处理，不应 panic
    dispatch(&harness, json!({ "type": "conversationContextUpdated", "sessionId": "s1" }));

    dispatch(&harness, json!({ "type": "conversationClosed", "sessionId": "s1" }));
    assert!(harness.core.session_if_exists("s1").is_none());

    dispatch(&harness, json!({ "type": "conversationDeleted", "sessionId": "s1" }));
    assert!(history::load_metadata("s1", &workspace).is_none());
}

#[test]
fn conversation_space_cleared_removes_space_files_and_resets_state() {
    let sandbox = Sandbox::new("main-space-cleared");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1", "title": "留标题" }))
        .unwrap();
    history::append_message(
        "s1",
        &workspace,
        &json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
        None,
    )
    .unwrap();

    let harness = EngineHarness::allow_all();
    harness.core.on_conversation_opened("s1");
    assert_eq!(harness.core.session("s1").lock().unwrap().messages.len(), 1);

    // conversationSpaceCleared 的 sessionId 是「对话空间目录名」，不是会话 id
    let dir_name = config::project_conversation_dir(&workspace)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    dispatch(
        &harness,
        json!({ "type": "conversationSpaceCleared", "sessionId": dir_name }),
    );

    let state = harness.core.session("s1");
    assert!(state.lock().unwrap().messages.is_empty());
    assert!(state.lock().unwrap().last_uuid.is_none());
    // 空间内的 .jsonl 与 .meta.json 一并删除
    assert!(history::load_messages("s1", &workspace).is_empty());
    assert!(history::load_metadata("s1", &workspace).is_none());
    assert!(harness.sink.event_of("conversationListChanged").is_some());
    assert!(harness.sink.event_of("message").is_some(), "应上报清空提示");
}

#[test]
fn session_config_events_are_dispatched() {
    let sandbox = Sandbox::new("main-session-config");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "modelChanged", "sessionId": "s1",
                "ref": { "provider": "p1", "model": "m1" } }),
    );
    let state = harness.core.session("s1");
    assert_eq!(state.lock().unwrap().model.as_deref(), Some("m1"));

    // model 的 change 用 `ref` 承载身份（与 TS 契约逐字段一致）
    let model_change = harness
        .sink
        .events_of("sessionConfigChanged")
        .into_iter()
        .find(|event| event["change"]["key"] == "model")
        .expect("model change event");
    assert_eq!(model_change["change"]["ref"]["model"], "m1");
    assert_eq!(model_change["change"]["ref"]["provider"], "p1");
    assert!(model_change["change"].get("value").is_none());

    dispatch(&harness, json!({ "type": "agentModeChanged", "sessionId": "s1", "mode": "auto" }));
    assert_eq!(state.lock().unwrap().agent_mode, "auto");

    // 会话级开关：应用到 SessionState 并广播 sessionConfigChanged（不再静默丢弃）
    dispatch(&harness, json!({ "type": "thinkingEffortChanged", "sessionId": "s1", "mode": "low" }));
    dispatch(&harness, json!({ "type": "promptModeChanged", "sessionId": "s1", "mode": "minimal" }));
    dispatch(&harness, json!({ "type": "webSearchChanged", "sessionId": "s1", "enabled": false }));
    {
        let state = state.lock().unwrap();
        assert_eq!(state.thinking_effort.as_deref(), Some("low"));
        assert_eq!(state.prompt_mode.as_deref(), Some("minimal"));
        assert_eq!(state.web_search, Some(false));
    }
    let keys: Vec<String> = harness
        .sink
        .events_of("sessionConfigChanged")
        .iter()
        .filter_map(|event| event["change"]["key"].as_str().map(|key| key.to_string()))
        .collect();
    for key in ["thinkingEffort", "promptMode", "webSearch"] {
        assert!(keys.contains(&key.to_string()), "missing {key} in {keys:?}");
    }

    // MCP 尚未迁入：只记录，不广播
    let before = harness.sink.events().len();
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledChanged", "sessionId": "s1", "name": "x", "enabled": true }),
    );
    assert_eq!(harness.sink.events().len(), before);
}

#[test]
fn compact_requested_is_wired_to_the_engine() {
    let sandbox = Sandbox::new("main-compact-requested");
    let harness = EngineHarness::allow_all();

    // 没有可压缩的消息 → 什么都不做（不再有「尚未实现」占位消息）
    dispatch(&harness, json!({ "type": "compactRequested", "sessionId": "s1" }));
    assert!(
        harness.sink.event_of("message").is_none(),
        "无可压缩消息时不发任何消息: {:?}",
        harness.sink.event_types()
    );
    assert!(!crate::compact::is_pending_compact("s1"));

    // 有可压缩的消息 → 触发压缩（走 LLM，这里只断言发出了 compactBegin）
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("s2", Some(project.clone()));
    for index in 0..40 {
        crate::history::append_message(
            "s2",
            &project,
            &json!({
                "type": "user",
                "message": { "role": "user", "content": format!("消息 {index}") },
                "uuid": format!("u-{index}"),
                "timestamp": index as u64,
            }),
            None,
        )
        .unwrap();
    }
    harness.core.ensure_loaded("s2").unwrap();
    dispatch(&harness, json!({ "type": "compactRequested", "sessionId": "s2" }));
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("compactBegin").is_empty(),
            std::time::Duration::from_secs(30),
        ),
        "应当触发压缩: {:?}",
        harness.sink.event_types()
    );

    crate::compact::reset_for_test();
}

/// `editRolledBack` 已接线到 `rollback::rollback_edit`：找不到目标时回传提示文案，
/// 而不是「尚未实现」占位。
#[test]
fn edit_rolled_back_dispatches_to_rollback() {
    let sandbox = Sandbox::new("main-edit-rolled-back");
    let harness = EngineHarness::allow_all();
    config::set_session_workspace(
        "s1",
        Some(sandbox.workspace.to_string_lossy().to_string()),
    );

    dispatch(
        &harness,
        json!({
            "type": "editRolledBack",
            "sessionId": "s1",
            "toolUseId": "toolu_missing",
            "direction": "before",
        }),
    );
    assert!(system_message(&harness).contains("未找到指定的编辑操作"));
}

#[test]
fn abort_requested_sets_the_cancel_flag() {
    let _sandbox = Sandbox::new("main-abort");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    dispatch(&harness, json!({ "type": "abortRequested", "sessionId": "s1" }));
    assert!(state.lock().unwrap().cancel.load(std::sync::atomic::Ordering::Relaxed));
}

#[test]
fn llm_config_saved_invalidates_the_settings_cache() {
    let sandbox = Sandbox::new("main-llm-config-saved");
    sandbox.write_settings(json!({ "defaultAgentMode": "manual" }));
    let harness = EngineHarness::allow_all();
    assert_eq!(config::default_agent_mode(), "manual");

    std::fs::write(config::settings_path().unwrap(), json!({ "defaultAgentMode": "auto" }).to_string())
        .unwrap();
    dispatch(&harness, json!({ "type": "llmConfigSaved" }));
    assert_eq!(config::default_agent_mode(), "auto");
}

#[test]
fn user_message_submitted_runs_a_turn() {
    let sandbox = Sandbox::new("main-user-message");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    let llm = crate::test_support::FakeLlm::fixed(crate::test_support::openai_text_sse(&["收到"]));
    sandbox.write_llm_settings(&llm.base_url, "auto");
    config::set_active_workspace(Some(workspace.clone()));

    let harness = EngineHarness::allow_all();
    dispatch(
        &harness,
        json!({ "type": "userMessageSubmitted", "sessionId": "s1",
                "content": "你好", "uuid": "u-1" }),
    );
    assert!(harness.wait_query_end(), "轮次未结束: {:?}", harness.sink.event_types());
    assert!(harness.sink.event_of("queryEnd").is_some());
    assert_eq!(history::load_messages("s1", &workspace).len(), 2);
}

#[test]
fn events_without_a_type_and_unknown_types_are_dropped() {
    let _sandbox = Sandbox::new("main-unknown-event");
    let harness = EngineHarness::allow_all();

    dispatch(&harness, json!({ "sessionId": "s1" }));
    dispatch(&harness, json!({ "type": "somethingNew", "sessionId": "s1" }));
    assert!(harness.sink.events().is_empty());
}

#[test]
fn emit_writes_a_single_event_frame() {
    let _sandbox = Sandbox::new("main-emit");
    let harness = EngineHarness::allow_all();
    emit(&harness.core, json!({ "type": "aiBegin", "sessionId": "s1" }));

    let frames = harness.sink.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["kind"], "event");
    assert_eq!(frames[0]["event"]["type"], "aiBegin");
}

#[test]
fn ui_events_are_counted_on_the_bus() {
    let sandbox = Sandbox::new("main-event-count");
    let harness = EngineHarness::allow_all();
    dispatch(&harness, json!({ "type": "workspaceChanged", "workspacePath": null }));
    dispatch(
        &harness,
        json!({ "type": "workspaceChanged", "workspacePath": sandbox.workspace.to_string_lossy() }),
    );
    assert_eq!(harness.bus.lock().unwrap().ui_event_count("workspaceChanged"), 2);
}

#[test]
fn project_conversation_dir_ready_is_emitted_through_the_bus() {
    // 对齐 Embedded `ensureProjectConversationDir` → `notifyProjectConversationDirReady`：
    // core 建目录后上报一次 `projectConversationDirReady`，宿主据此写目录里的 settings.json。
    let sandbox = Sandbox::new("main-dir-ready");
    let harness = EngineHarness::allow_all();
    install_project_dir_ready_sink(&harness.bus);
    let project = sandbox.workspace.to_string_lossy().to_string();

    config::ensure_project_conversation_dir(&project).unwrap();
    // 第二次 ensure 不重复上报
    config::ensure_project_conversation_dir(&project).unwrap();

    let events = harness.sink.events_of("projectConversationDirReady");
    assert_eq!(events.len(), 1, "got {events:?}");
    assert_eq!(events[0]["workspacePath"], project);
    assert_eq!(
        events[0]["projectDir"],
        config::project_conversation_dir(&project)
            .unwrap()
            .to_string_lossy()
            .to_string()
    );

    // 清掉出口，避免影响后续测试
    config::set_project_dir_ready_sink(std::sync::Arc::new(|_, _| {}));
}

// ==================== 帧循环 ====================

use std::io::{BufRead, Cursor};

fn run_loop(harness: &EngineHarness, input: &str) -> i32 {
    run_frame_loop(Cursor::new(input.to_string()), &harness.core, &harness.bus)
}

/// 与 Core 同版本的 `hello` 帧（协议版本升版时不必改每个用例）
fn hello_frame() -> String {
    format!(
        "{{\"kind\":\"hello\",\"protocol\":{}}}\n",
        crate::frame::CORE_PROTOCOL_VERSION
    )
}

#[test]
fn frame_loop_answers_hello_with_ready() {
    let _sandbox = Sandbox::new("main-loop-hello");
    let harness = EngineHarness::allow_all();
    assert_eq!(run_loop(&harness, &hello_frame()), 0);

    let frames = harness.sink.frames();
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0]["kind"], "ready");
}

#[test]
fn frame_loop_rejects_a_protocol_mismatch() {
    let _sandbox = Sandbox::new("main-loop-protocol");
    let harness = EngineHarness::allow_all();
    let mismatched = format!(
        "{{\"kind\":\"hello\",\"protocol\":{}}}\n",
        crate::frame::CORE_PROTOCOL_VERSION + 1
    );
    assert_eq!(run_loop(&harness, &mismatched), 2);
    assert!(harness.sink.frames().is_empty(), "版本不匹配时不应回 ready");
}

#[test]
fn frame_loop_skips_blank_and_malformed_lines() {
    let _sandbox = Sandbox::new("main-loop-malformed");
    let harness = EngineHarness::allow_all();
    let input = format!("\n   \n{{ not json\n{{\"kind\":\"nope\"}}\n{}", hello_frame());
    assert_eq!(run_loop(&harness, &input), 0);

    let frames = harness.sink.frames();
    assert_eq!(frames.len(), 1, "只有合法帧应当被处理: {frames:?}");
    assert_eq!(frames[0]["kind"], "ready");
}

#[test]
fn frame_loop_dispatches_ui_events_and_responses() {
    let sandbox = Sandbox::new("main-loop-events");
    let harness = EngineHarness::allow_all();
    let input = format!(
        "{}\n{}\n{}\n",
        json!({ "kind": "hello", "protocol": crate::frame::CORE_PROTOCOL_VERSION }),
        json!({ "kind": "uiEvent", "event": {
            "type": "workspaceChanged",
            "workspacePath": sandbox.workspace.to_string_lossy()
        } }),
        json!({ "kind": "response", "id": 1, "ok": true, "result": { "index": 0 } })
    );
    assert_eq!(run_loop(&harness, &input), 0);

    assert_eq!(config::project_root("s1").unwrap(), sandbox.workspace.to_string_lossy());
    // 没有待应答请求时，迟到 / 未知的应答被忽略
    assert_eq!(harness.bus.lock().unwrap().pending_count(), 0);
    assert_eq!(harness.bus.lock().unwrap().ui_event_count("workspaceChanged"), 1);
}

#[test]
fn frame_loop_stops_on_shutdown() {
    let _sandbox = Sandbox::new("main-loop-shutdown");
    let harness = EngineHarness::allow_all();
    let input = format!(
        "{}{{\"kind\":\"shutdown\"}}\n{}",
        hello_frame(),
        hello_frame()
    );
    assert_eq!(run_loop(&harness, &input), 0);

    // shutdown 之后的帧不再处理
    assert_eq!(harness.sink.frames().len(), 1);
}

#[test]
fn frame_loop_exits_on_eof() {
    let _sandbox = Sandbox::new("main-loop-eof");
    let harness = EngineHarness::allow_all();
    assert_eq!(run_loop(&harness, ""), 0);
    assert!(harness.sink.frames().is_empty());
}

/// 读标准输入失败（宿主异常退出）
struct BrokenReader;

impl std::io::Read for BrokenReader {
    fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("pipe broke"))
    }
}

impl BufRead for BrokenReader {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        Err(std::io::Error::other("pipe broke"))
    }

    fn consume(&mut self, _amount: usize) {}
}

#[test]
fn frame_loop_survives_a_broken_stdin() {
    let _sandbox = Sandbox::new("main-loop-broken-stdin");
    let harness = EngineHarness::allow_all();
    assert_eq!(run_frame_loop(BrokenReader, &harness.core, &harness.bus), 0);
}

#[test]
fn frame_loop_drops_frames_it_cannot_write() {
    let _sandbox = Sandbox::new("main-loop-broken-stdout");
    let bus: crate::engine::SharedBus = Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(
        Box::new(crate::test_support::FailingWriter),
    )));
    let core = Arc::new(Core::new(Arc::clone(&bus)));

    // 回 ready 失败（宿主已退出）→ 立刻收摊，不进入下一轮
    let input = format!("{}{{\"kind\":\"shutdown\"}}\n", hello_frame());
    assert_eq!(run_frame_loop(Cursor::new(input.to_string()), &core, &bus), 0);
}

/// 宿主序列化帧时可能带孤立代理项转义（历史里被切坏的 emoji 预览）。
/// serde_json 严格解析会拒绝整帧，`decode_frame` 必须先清洗再解析。
#[test]
fn decode_frame_tolerates_lone_surrogate_escapes() {
    // 严格解析器单独看这行会失败
    let broken = r#"{"kind":"response","id":1,"ok":true,"result":"emoji \ude00"}"#;
    assert!(serde_json::from_str::<UiToCoreFrame>(broken).is_err());

    match decode_frame(broken).expect("清洗后应能解出帧") {
        UiToCoreFrame::Response { id, ok, result, .. } => {
            assert_eq!(id, 1);
            assert!(ok);
            assert!(result.as_str().unwrap().ends_with('\u{FFFD}'));
        }
        other => panic!("unexpected frame: {other:?}"),
    }

    // 正常帧不受影响
    assert!(matches!(
        decode_frame(r#"{"kind":"shutdown"}"#).unwrap(),
        UiToCoreFrame::Shutdown
    ));
    // 真正的坏 JSON 仍然报错
    assert!(decode_frame("{oops").is_err());
}

#[test]
fn settings_json_update_requested_writes_the_global_config() {
    // Standalone 下全局 settings.json 的唯一写入点在 Core：宿主把「要改的字段」
    // 作为 JSON Merge Patch 交过来（`docs/standalone-core.md` 第 8 节）。
    let sandbox = Sandbox::new("main-settings-update");
    let harness = EngineHarness::allow_all();
    sandbox.write_settings(json!({ "llm": { "webSearch": true }, "uiLanguage": "zh" }));

    dispatch(
        &harness,
        json!({
            "type": "settingsJsonUpdateRequested",
            "patch": { "llm": { "webSearch": false }, "defaultAgentMode": "auto" },
        }),
    );

    assert_eq!(
        sandbox.read_settings(),
        json!({
            "llm": { "webSearch": false },
            "uiLanguage": "zh",
            "defaultAgentMode": "auto",
        })
    );
    // 写盘后 Core 的读缓存已失效
    assert_eq!(config::settings_json()["defaultAgentMode"], "auto");
    // 正常路径不产生日志事件
    assert!(harness.sink.event_of("log").is_none());
}

#[test]
fn settings_json_update_requested_accepts_null_to_delete_a_key() {
    let sandbox = Sandbox::new("main-settings-delete");
    let harness = EngineHarness::allow_all();
    sandbox.write_settings(json!({ "uiLanguage": "en", "defaultAgentMode": "manual" }));

    dispatch(
        &harness,
        json!({ "type": "settingsJsonUpdateRequested", "patch": { "uiLanguage": null } }),
    );

    assert_eq!(sandbox.read_settings(), json!({ "defaultAgentMode": "manual" }));
}

// ==================== UI → core 请求 ====================

#[test]
fn ui_request_reports_the_config_home_dir() {
    let sandbox = Sandbox::new("main-ui-request-home");
    let home = dispatch_ui_request(&json!({ "type": "configHomeDirRequested" })).unwrap();
    assert_eq!(
        home.as_str().unwrap(),
        sandbox.home.join(&sandbox.config_dir_name).to_string_lossy(),
    );
}

#[test]
fn ui_request_reports_the_ui_language() {
    let sandbox = Sandbox::new("main-ui-request-language");
    // 缺省 / 非法值都收敛到 auto
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "uiLanguageRequested" })).unwrap(),
        json!("auto"),
    );
    sandbox.write_settings(json!({ "uiLanguage": "zh" }));
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "uiLanguageRequested" })).unwrap(),
        json!("zh"),
    );
    sandbox.write_settings(json!({ "uiLanguage": "fr" }));
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "uiLanguageRequested" })).unwrap(),
        json!("auto"),
    );
}

#[test]
fn ui_request_lists_conversations_of_the_requested_workspace() {
    let sandbox = Sandbox::new("main-ui-request-list");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let dir = config::ensure_project_conversation_dir(&project).unwrap();
    let write = |session_id: &str, message_count: u64, updated_at: u64, cleared: bool| {
        let mut meta = json!({
            "sessionId": session_id,
            "project": project,
            "title": session_id,
            "createdAt": 1,
            "updatedAt": updated_at,
            "messageCount": message_count,
        });
        if cleared {
            meta["clearedAt"] = json!(updated_at);
        }
        std::fs::write(
            dir.join(format!("{session_id}.meta.json")),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
    };
    write("older", 3, 100, false);
    write("newer", 1, 200, false);
    // 空对话（messageCount=0 且没有 clearedAt）不进列表
    write("empty", 0, 300, false);
    // 清空过的会话保留条目
    write("cleared", 0, 400, true);

    let listed = dispatch_ui_request(&json!({
        "type": "conversationListRequested",
        "workspacePath": project,
    }))
    .unwrap();
    let ids: Vec<String> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["sessionId"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["cleared", "newer", "older"]);
}

#[test]
fn ui_request_list_falls_back_to_the_active_workspace() {
    let sandbox = Sandbox::new("main-ui-request-list-active");
    // 没有活动工作目录 → 空表而不是报错
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "conversationListRequested" })).unwrap(),
        json!([]),
    );
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "conversationListRequested" })).unwrap(),
        json!([]),
    );
}

#[test]
fn ui_request_without_an_archive_returns_null() {
    let sandbox = Sandbox::new("main-ui-request-archive");
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    assert_eq!(
        dispatch_ui_request(&json!({ "type": "compactArchiveRequested", "sessionId": "s1" })).unwrap(),
        Value::Null,
    );
}

#[test]
fn ui_request_unknown_type_is_an_error() {
    let _sandbox = Sandbox::new("main-ui-request-unknown");
    assert!(dispatch_ui_request(&json!({ "type": "nope" })).is_err());
    assert!(dispatch_ui_request(&json!({})).is_err());
}

#[test]
fn ui_request_requires_a_session_id_where_needed() {
    let _sandbox = Sandbox::new("main-ui-request-session");
    assert!(dispatch_ui_request(&json!({ "type": "smartNamingRequested" })).is_err());
    assert!(dispatch_ui_request(&json!({ "type": "compactArchiveRequested" })).is_err());
}

#[test]
fn session_workspace_assigned_registers_and_clears() {
    let sandbox = Sandbox::new("main-session-workspace");
    let harness = EngineHarness::allow_all();
    let workspace = sandbox.workspace.to_string_lossy().to_string();

    dispatch(
        &harness,
        json!({
            "type": "sessionWorkspaceAssigned",
            "sessionId": "s1",
            "workspacePath": workspace,
        }),
    );
    assert_eq!(config::session_workspace("s1"), Some(workspace.clone()));

    // null / 空串都表示清除登记
    dispatch(
        &harness,
        json!({ "type": "sessionWorkspaceAssigned", "sessionId": "s1", "workspacePath": null }),
    );
    assert_eq!(config::session_workspace("s1"), None);

    dispatch(
        &harness,
        json!({ "type": "sessionWorkspaceAssigned", "sessionId": "s1", "workspacePath": workspace }),
    );
    dispatch(
        &harness,
        json!({ "type": "sessionWorkspaceAssigned", "sessionId": "s1", "workspacePath": "" }),
    );
    assert_eq!(config::session_workspace("s1"), None);
}

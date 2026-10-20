//! `main` 的单元测试：UiEvent 分发与 `conversationStarted` 的会话建档。

use super::*;
use crate::test_support::{EngineHarness, Sandbox};
use serde_json::json;

fn dispatch(harness: &EngineHarness, event: Value) {
    dispatch_ui_event(&harness.core, &harness.bus, event);
}

/// 给 `dispatch_ui_request` 提供一个空 Core：这些请求只读磁盘与会话状态，
/// 不经总线发事件（bus 只需存在）。
fn test_core() -> Core {
    let sink = crate::test_support::Capture::new();
    Core::new(Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(
        sink.writer(),
    ))))
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
            "extensionPath": "D:/ext",
            "logToConsole": true,
            "configDirName": sandbox.config_dir_name,
        }),
    );

    let env = config::host_environment().expect("host env");
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
    assert_eq!(env.extension_path, "");
    assert!(!env.log_to_console);
    assert_eq!(env.config_dir_name, config::DEFAULT_CONFIG_DIR_NAME, "缺省值对齐默认配置目录名");
}

/// 一份最小的合法快照（与 `settings_tests` 的同名构造同口径）
fn minimal_snapshot() -> Value {
    json!({
        "llm": {
            "activeProvider": "p",
            "webSearch": false,
            "thinkingEffort": "low",
            "model": "",
            "maxTokens": 2048,
            "providers": {
                "p": {
                    "baseURL": "https://p",
                    "apiKey": "sk-p",
                    "models": ["m1"],
                    "defaultModel": "m1",
                    "modelLimits": {},
                }
            },
            "modelLimitsFallback": {
                "context": 9,
                "output": 8,
                "apiType": "OpenAI",
                "thinkingTokenBudget": 7,
                "multimodal": true,
            }
        },
        "mcp": { "enabled": [] },
        "defaultAgentMode": "auto",
        "defaultPromptMode": "mixed",
    })
}

fn minimal_host_environment(config_dir_name: &str, snapshot: Value) -> Value {
    json!({
        "type": "hostEnvironmentProvided",
        "extensionPath": "D:/ext",
        "logToConsole": false,
        "configDirName": config_dir_name,
        "settings": snapshot,
        "mcpServers": [],
    })
}

#[test]
fn ui_events_before_the_host_environment_are_rejected() {
    let _sandbox = Sandbox::new("main-not-ready");
    let harness = EngineHarness::allow_all();
    // 沙箱默认注入一份空快照（模拟「宿主已连接」）；这里显式回到「还没连上」的状态。
    settings::reset_settings_snapshot();

    dispatch(&harness, json!({ "type": "workspaceChanged", "workspacePath": "D:/repo" }));

    // 事件被拒绝：core 侧状态不变，且记一条 log 暴露顺序错误
    assert!(config::project_root("s1").is_err());
    assert!(!settings::has_settings_snapshot());
    let log = harness.sink.event_of("log").expect("log event");
    let message = log["message"].as_str().unwrap();
    assert!(message.contains("before the Core is ready"), "{message}");
}

#[test]
fn host_environment_emits_core_ready_and_repeats_on_every_push() {
    let sandbox = Sandbox::new("main-core-ready");
    let harness = EngineHarness::allow_all();
    let environment = minimal_host_environment(&sandbox.config_dir_name, minimal_snapshot());

    dispatch(&harness, environment.clone());
    assert_eq!(harness.sink.events_of("coreReady").len(), 1);
    assert!(settings::has_settings_snapshot());

    // 配置变更后重推整份快照：就绪状态不变，但再发一次（宿主据此判定「已跟上」）
    dispatch(&harness, environment);
    assert_eq!(harness.sink.events_of("coreReady").len(), 2);
}

#[test]
fn mcp_defaults_change_resyncs_registered_sessions() {
    let sandbox = Sandbox::new("main-mcp-defaults");
    let harness = EngineHarness::allow_all();

    let mut first = minimal_snapshot();
    first["mcp"]["enabled"] = json!(["a"]);
    dispatch(&harness, minimal_host_environment(&sandbox.config_dir_name, first));

    // 默认启用列表不变：不重同步（幂等，不产生额外工作）
    let unchanged = settings::apply_from_host_environment(&minimal_host_environment(
        &sandbox.config_dir_name,
        json!({
            "llm": minimal_snapshot()["llm"].clone(),
            "mcp": { "enabled": ["a"] },
            "defaultAgentMode": "auto",
            "defaultPromptMode": "mixed",
        }),
    ))
    .expect("apply");
    assert!(!unchanged);

    // 列表变了：报告变化，由调用方让已注册会话重同步连接
    let changed = settings::apply_from_host_environment(&minimal_host_environment(
        &sandbox.config_dir_name,
        json!({
            "llm": minimal_snapshot()["llm"].clone(),
            "mcp": { "enabled": ["a", "b"] },
            "defaultAgentMode": "auto",
            "defaultPromptMode": "mixed",
        }),
    ))
    .expect("apply");
    assert!(changed);
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
/// `sessionRuntime.waiting`。
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

/// `conversationStarted` 只登记工作目录（内存态），**不建档、不广播**。
/// `meta.json` / `.jsonl` 只在第一条消息持久化时创建，避免空对话出现在列表里。
#[test]
fn conversation_started_only_registers_the_workspace() {
    let sandbox = Sandbox::new("main-conversation-started");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    sandbox.write_settings(json!({ "defaultModel": "gpt-x" }));
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "sessionWorkspaceAssigned", "sessionId": "s1", "workspacePath": workspace }),
    );
    dispatch(&harness, json!({ "type": "conversationStarted", "sessionId": "s1" }));

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
        json!({ "type": "sessionWorkspaceAssigned", "sessionId": "s1", "workspacePath": workspace }),
    );
    dispatch(&harness, json!({ "type": "conversationStarted", "sessionId": "s1" }));

    assert_eq!(history::load_metadata("s1", &workspace).unwrap()["title"], "老标题");
    assert!(harness.sink.event_of("sessionCreated").is_none());
}

#[test]
fn conversation_started_without_a_session_id_is_ignored() {
    let _sandbox = Sandbox::new("main-conversation-started-no-id");
    let harness = EngineHarness::allow_all();
    dispatch(
        &harness,
        json!({ "type": "conversationStarted", "sessionId": "" }),
    );
    assert!(harness.sink.events().is_empty());
}

/// 没有工作目录时 `conversationStarted` 静默返回（不报错、不广播）。
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

    // conversationSpaceCleared 的 dirName 是「对话空间目录名」，不是会话 id
    let dir_name = config::project_conversation_dir(&workspace)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    dispatch(
        &harness,
        json!({ "type": "conversationSpaceCleared", "dirName": dir_name }),
    );

    let state = harness.core.session("s1");
    assert!(state.lock().unwrap().messages.is_empty());
    assert!(state.lock().unwrap().last_uuid.is_none());
    // 空间内的 .jsonl 与 .meta.json 一并删除
    assert!(history::load_messages("s1", &workspace).is_empty());
    assert!(history::load_metadata("s1", &workspace).is_none());
    assert!(harness.sink.event_of("conversationListChanged").is_some());

    // 完成回执：webview 的「删除中」按钮靠它解除（此前只发 conversationListChanged，
    // 面板不知道何时完成）。回执带判别联合结果与删除统计。
    let receipt = harness
        .sink
        .event_of("conversationSpaceCleared")
        .expect("应发 conversationSpaceCleared 回执");
    assert_eq!(receipt["dirName"], dir_name);
    assert_eq!(receipt["result"]["status"], "complete");
    let removed_files = receipt["result"]["removedFiles"].as_u64().expect("removedFiles");
    assert!(removed_files >= 2, "至少删掉 .jsonl 与 .meta.json：{removed_files}");
    assert!(receipt["result"]["removedBytes"].as_u64().expect("removedBytes") > 0);
    // 完成事实走专用回执：不再向「空间目录名」这个非会话 id 发 phantom message
    assert!(
        harness.sink.event_of("message").is_none(),
        "清空提示应走 conversationSpaceCleared 回执，而不是 phantom message"
    );
}

#[test]
fn conversation_space_cleared_reports_error_for_missing_space() {
    let _sandbox = Sandbox::new("main-space-cleared-missing");
    let harness = EngineHarness::allow_all();

    dispatch(
        &harness,
        json!({ "type": "conversationSpaceCleared", "dirName": "no-such-space" }),
    );

    let receipt = harness
        .sink
        .event_of("conversationSpaceCleared")
        .expect("失败也必须回执，否则设置面板的「删除中」永远无法解除");
    assert_eq!(receipt["dirName"], "no-such-space");
    assert_eq!(receipt["result"]["status"], "error");
    assert!(receipt["result"]["message"].as_str().is_some());
    // 没有任何东西被删：不发 conversationListChanged
    assert!(harness.sink.event_of("conversationListChanged").is_none());
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

    // MCP 单开关：把这次勾选合并进
    // 该会话的启用列表并写盘。广播由 MCP 的 `notifyServersChanged` 出口在差量同步
    // 结束后发出，因此这里断言写盘结果而不是 `sessionConfigChanged`。
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledChanged", "sessionId": "s1", "name": "x", "enabled": true }),
    );
    assert_eq!(
        crate::mcp_config::read_session_enabled_mcps(Some("s1")),
        Some(vec!["x".to_string()])
    );
    let metadata = history::load_metadata("s1", &workspace).expect("metadata");
    assert_eq!(metadata["context"]["mcpEnabled"], json!(["x"]));

    // 再次勾选其它 server：差量合并，不清空已有勾选
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledChanged", "sessionId": "s1", "name": "y", "enabled": true }),
    );
    assert_eq!(
        crate::mcp_config::read_session_enabled_mcps(Some("s1")),
        Some(vec!["x".to_string(), "y".to_string()])
    );

    // 取消勾选：从列表移除
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledChanged", "sessionId": "s1", "name": "x", "enabled": false }),
    );
    assert_eq!(
        crate::mcp_config::read_session_enabled_mcps(Some("s1")),
        Some(vec!["y".to_string()])
    );

    // 整表覆盖：直接覆盖，不做增量；
    // 宿主保存默认配置前用它在写盘前把当前对话钉住。去重且保留首次出现顺序。
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledListChanged", "sessionId": "s1", "names": ["z", "y", "z"] }),
    );
    assert_eq!(
        crate::mcp_config::read_session_enabled_mcps(Some("s1")),
        Some(vec!["z".to_string(), "y".to_string()])
    );
    let metadata = history::load_metadata("s1", &workspace).expect("metadata");
    assert_eq!(metadata["context"]["mcpEnabled"], json!(["z", "y"]));

    // 空列表 = 显式「该会话全部禁用」（与「没有覆盖」区分开）
    dispatch(
        &harness,
        json!({ "type": "mcpEnabledListChanged", "sessionId": "s1", "names": [] }),
    );
    assert_eq!(crate::mcp_config::read_session_enabled_mcps(Some("s1")), Some(vec![]));

    // 会话覆盖与 MCP 管理器都是进程级静态状态，必须清理干净：
    // 先丢弃管理器（Drop 会 join 工作线程，让排队的差量同步按本沙箱配置跑完），
    // 再清会话覆盖——顺序不能反：同步任务会从 meta.json 重新读回覆盖并写进缓存。
    crate::mcp::reset_manager();
    crate::mcp_config::clear_session_mcp_override("s1");
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
    assert!(system_message(&harness).contains("Edit operation not found"));
}

#[test]
fn abort_requested_sets_the_cancel_flag() {
    let _sandbox = Sandbox::new("main-abort");
    let harness = EngineHarness::allow_all();
    let state = harness.core.session("s1");
    // 前台在跑：第一阶段置 cancel（对齐 `Integration.abortCurrentQuery`）
    state.lock().unwrap().running = true;
    dispatch(&harness, json!({ "type": "abortRequested", "sessionId": "s1" }));
    assert!(state.lock().unwrap().cancel.load(std::sync::atomic::Ordering::Relaxed));
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
fn project_conversation_dir_meta_is_written_by_core() {
    // core 建目录后自己写项目清单
    // `workspace.meta.json`，不再上报事件、宿主不参与写盘。
    let sandbox = Sandbox::new("main-dir-ready");
    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();

    config::ensure_project_conversation_dir(&project).unwrap();
    // 第二次 ensure 幂等（不重复写盘，不产生事件）
    config::ensure_project_conversation_dir(&project).unwrap();

    let dir = config::project_conversation_dir(&project).unwrap();
    let meta = std::fs::read_to_string(dir.join("workspace.meta.json")).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&meta).unwrap();
    assert_eq!(parsed["workspacePath"], project);
    assert!(!dir.join("settings.json").exists());
    assert!(harness.sink.events_of("projectConversationDirReady").is_empty());
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

// ==================== UI → core 请求 ====================

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

    let listed = dispatch_ui_request(&test_core(), &json!({
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
        dispatch_ui_request(&test_core(), &json!({ "type": "conversationListRequested" })).unwrap(),
        json!([]),
    );
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    assert_eq!(
        dispatch_ui_request(&test_core(), &json!({ "type": "conversationListRequested" })).unwrap(),
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
        dispatch_ui_request(&test_core(), &json!({ "type": "compactArchiveRequested", "sessionId": "s1" })).unwrap(),
        Value::Null,
    );
}

#[test]
fn ui_request_mcp_servers_merges_config_and_runtime() {
    let sandbox = Sandbox::new("main-ui-request-mcp");
    sandbox.write_settings(json!({ "mcp": { "enabled": ["alpha"] } }));
    sandbox.write_mcp_json(json!({
        "mcp": {
            "alpha": { "type": "local", "command": ["npx", "alpha"] },
            "beta": { "type": "remote", "url": "https://beta.example" },
        }
    }));

    let listed = dispatch_ui_request(&test_core(), &json!({
        "type": "mcpServersRequested",
        "sessionId": "s1",
    }))
    .unwrap();
    let servers = listed.as_array().unwrap();
    assert_eq!(servers.len(), 2);

    let alpha = servers.iter().find(|item| item["name"] == "alpha").unwrap();
    assert_eq!(alpha["enabled"], true, "全局默认启用列表生效");
    assert_eq!(alpha["running"], false, "未连接时补运行时缺省值");
    assert_eq!(alpha["toolCount"], 0);
    assert!(alpha["error"].is_null());
    assert_eq!(alpha["refCount"], 0);

    let beta = servers.iter().find(|item| item["name"] == "beta").unwrap();
    assert_eq!(beta["enabled"], false);
}

#[test]
fn ui_request_conversation_spaces_counts_files_and_projects() {
    let sandbox = Sandbox::new("main-ui-request-spaces");
    let project = sandbox.workspace.to_string_lossy().to_string();
    let dir = config::ensure_project_conversation_dir(&project).unwrap();
    std::fs::write(dir.join("s1.meta.json"), "{}").unwrap();
    std::fs::write(dir.join("s1.jsonl"), "{\"uuid\":\"u\"}
").unwrap();

    // 项目目录已删除的空间：统计顺带核实「目录不存在」这个事实
    let gone_dir = config::conversations_root().unwrap().join("gone-ws");
    std::fs::create_dir_all(&gone_dir).unwrap();
    std::fs::write(
        gone_dir.join("workspace.meta.json"),
        json!({ "workspacePath": "/nonexistent/workspace" }).to_string(),
    )
    .unwrap();

    let spaces = dispatch_ui_request(&test_core(), &json!({ "type": "conversationSpacesRequested" })).unwrap();
    let spaces = spaces.as_array().unwrap();
    assert_eq!(spaces.len(), 2);
    let space = spaces
        .iter()
        .find(|space| space["projectPath"] == project.as_str())
        .expect("existing space");
    let dir_name = config::project_conversation_dir(&project)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert_eq!(space["dirName"], dir_name);
    assert_eq!(space["projectPath"], project);
    assert_eq!(space["conversationCount"], 1, "只数 *.meta.json");
    assert!(space["sizeBytes"].as_u64().unwrap() > 0);
    assert!(space["fileCount"].as_u64().unwrap() >= 2);
    assert_eq!(space["workspaceMissing"], false, "存在的项目目录不标记缺失");

    let gone = spaces
        .iter()
        .find(|space| space["projectPath"] == "/nonexistent/workspace")
        .expect("missing workspace space");
    assert_eq!(gone["workspaceMissing"], true, "已删除的项目目录标记缺失");
}

#[test]
fn conversation_space_cleared_remove_mode_deletes_the_directory() {
    let sandbox = Sandbox::new("main-space-removed");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    let dir_name = config::project_conversation_dir(&workspace)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let dir = config::conversations_root().unwrap().join(&dir_name);
    assert!(dir.is_dir());

    let harness = EngineHarness::allow_all();
    dispatch(
        &harness,
        json!({ "type": "conversationSpaceCleared", "sessionId": dir_name, "mode": "remove" }),
    );

    // 整目录删除：workspace.meta.json 也一并消失，列表不再显示该空间
    assert!(!dir.exists(), "空间目录应整体删除");
    let receipt = harness.sink.event_of("conversationSpaceCleared").expect("回执");
    assert_eq!(receipt["result"]["status"], "complete");
    assert!(harness.sink.event_of("conversationListChanged").is_some());
}

#[test]
fn conversation_space_cleared_without_mode_defaults_to_clear() {
    let sandbox = Sandbox::new("main-space-default-clear");
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    config::set_active_workspace(Some(workspace.clone()));
    history::create_conversation("s1", &workspace, json!({ "sessionId": "s1" })).unwrap();
    let dir_name = config::project_conversation_dir(&workspace)
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let dir = config::conversations_root().unwrap().join(&dir_name);

    let harness = EngineHarness::allow_all();
    // 旧宿主不带 mode：按 clear 处理（跨版本窗口期兜底）
    dispatch(&harness, json!({ "type": "conversationSpaceCleared", "sessionId": dir_name }));

    assert!(dir.is_dir(), "clear 模式保留空间目录");
    assert!(history::load_metadata("s1", &workspace).is_none(), "对话数据被清空");
}

#[test]
fn ui_request_flush_session_validates_session_id() {
    let _sandbox = Sandbox::new("main-ui-request-flush");
    assert!(dispatch_ui_request(&test_core(), &json!({ "type": "flushSessionRequested" })).is_err());
    assert_eq!(
        dispatch_ui_request(&test_core(), &json!({ "type": "flushSessionRequested", "sessionId": "s1" })).unwrap(),
        Value::Null,
    );
}

#[test]
fn ui_request_conversation_load_returns_messages_metadata_and_facts() {
    let sandbox = Sandbox::new("main-ui-request-load");
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    history::append_message(
        "s1",
        &project,
        &json!({ "type": "user", "uuid": "u1", "message": { "role": "user", "content": "hi" } }),
        None,
    )
    .unwrap();

    let loaded = dispatch_ui_request(&test_core(), &json!({
        "type": "conversationLoadRequested",
        "sessionId": "s1",
    }))
    .unwrap();
    assert_eq!(loaded["messages"].as_array().unwrap().len(), 1);
    assert_eq!(loaded["messages"][0]["uuid"], "u1");
    assert_eq!(loaded["metadata"]["title"], "t");
    assert_eq!(loaded["pendingToolUseIds"], json!([]), "Standalone 恒为空");
    assert_eq!(loaded["hasCompactArchive"], false);
    assert!(
        loaded["agentMode"].is_string(),
        "agentMode 取 meta.json / 默认值：{}",
        loaded["agentMode"]
    );

    // 一次性通知槽位随 meta.json 整份下发：webview 加载时恢复到时间线末位
    // （`docs/hosts/webview-ui.md` 第 11 节）
    history::save_once_message(
        "s1",
        &project,
        &json!({ "role": "system", "content": "压缩已排队" }),
    )
    .unwrap();
    let with_once = dispatch_ui_request(&test_core(), &json!({
        "type": "conversationLoadRequested",
        "sessionId": "s1",
    }))
    .unwrap();
    assert_eq!(with_once["metadata"]["onceMessage"]["content"], "压缩已排队");
    assert_eq!(with_once["metadata"]["onceMessage"]["role"], "system");
    assert_eq!(with_once["messages"].as_array().unwrap().len(), 1, "通知不进消息列表");

    // 会话不存在：空消息 + null 元数据，不报错
    let missing = dispatch_ui_request(&test_core(), &json!({
        "type": "conversationLoadRequested",
        "sessionId": "no-such",
    }))
    .unwrap();
    assert_eq!(missing["messages"], json!([]));
    assert!(missing["metadata"].is_null());

    assert!(dispatch_ui_request(&test_core(), &json!({ "type": "conversationLoadRequested" })).is_err());
}

/// 崩溃残留的孤儿 tool_use（无配对 tool_result）：空闲会话加载时补「会话中断」
/// 取消结果（webview 据此渲染失败而非 running），运行中的会话不伪造
/// 。
#[test]
fn ui_request_conversation_load_recovers_interrupted_tool_use_for_idle_session() {
    let sandbox = Sandbox::new("main-ui-request-load-recover");
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    history::append_message(
        "s1",
        &project,
        &json!({
            "type": "assistant",
            "uuid": "a1",
            "message": { "role": "assistant", "content": [
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } }
            ]},
        }),
        None,
    )
    .unwrap();

    // 空闲会话：补出取消结果，消息数 1 → 2
    let idle = dispatch_ui_request(
        &test_core(),
        &json!({ "type": "conversationLoadRequested", "sessionId": "s1" }),
    )
    .unwrap();
    let messages = idle["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "空闲会话应补取消结果");
    assert_eq!(messages[1]["type"], "user");
    let block = &messages[1]["message"]["content"][0];
    assert_eq!(block["type"], "tool_result");
    assert_eq!(block["tool_use_id"], "t1");
    assert_eq!(block["is_canceled"], true);

    // 运行中的会话：原样返回，不伪造
    let busy_core = test_core();
    let state = busy_core.session("s1");
    state.lock().unwrap().running = true;
    let busy = dispatch_ui_request(
        &busy_core,
        &json!({ "type": "conversationLoadRequested", "sessionId": "s1" }),
    )
    .unwrap();
    assert_eq!(
        busy["messages"].as_array().unwrap().len(),
        1,
        "运行中的会话不补取消结果"
    );
}

#[test]
fn ui_request_skills_lists_builtins_and_project_skills() {
    let sandbox = Sandbox::new("main-ui-request-skills");
    let project = sandbox.workspace.to_string_lossy().to_string();
    // 没有会话工作目录：只列内置命令与内置技能
    let without_session = dispatch_ui_request(&test_core(), &json!({ "type": "skillsRequested" })).unwrap();
    let skills = without_session["skills"].as_array().unwrap();
    assert!(!skills.is_empty());
    assert!(skills.iter().any(|skill| skill["isBuiltin"] == true));
    assert!(skills.iter().any(|skill| skill["isBuiltin"] == false));
    assert!(skills.iter().all(|skill| skill["name"].is_string()));

    // 项目技能目录：`<workspace>/<configDirName>/skills/<name>/SKILL.md`
    let skill_dir = sandbox
        .workspace
        .join(&sandbox.config_dir_name)
        .join("skills")
        .join("demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo\ndescription: demo skill\n---\nbody\n",
    )
    .unwrap();
    config::set_session_workspace("s1", Some(project));
    let with_session = dispatch_ui_request(&test_core(), &json!({
        "type": "skillsRequested",
        "sessionId": "s1",
    }))
    .unwrap();
    let skills = with_session["skills"].as_array().unwrap();
    assert!(
        skills.iter().any(|skill| skill["name"] == "demo"),
        "项目技能应出现在列表里：{skills:?}"
    );
}

#[test]
fn ui_request_spin_design_reads_and_saves_in_core_data_dir() {
    let sandbox = Sandbox::new("main-ui-request-spin-design");
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace("spin-s1", Some(project.clone()));

    let sink = crate::test_support::Capture::new();
    let core = Core::new(Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(
        sink.writer(),
    ))));

    // 无设计文件 → data: null（新设计），技能数组存在
    let missing = dispatch_ui_request(
        &core,
        &json!({ "type": "spinDesignRequested", "sessionId": "spin-s1" }),
    )
    .unwrap();
    assert_eq!(missing["status"], json!("ok"));
    assert_eq!(missing["data"], Value::Null);
    assert!(missing["skills"].is_array());

    // 保存 → Core 数据目录出现 spin.json；保存不广播 spinDesignDataChanged
    let design = json!({ "nodes": [ { "id": 1, "task": "A" } ], "edges": [], "meta": {} });
    let saved = dispatch_ui_request(
        &core,
        &json!({
            "type": "spinDesignSaveRequested",
            "sessionId": "spin-s1",
            "data": design.clone(),
        }),
    )
    .unwrap();
    assert_eq!(saved["status"], json!("ok"));
    let path = config::project_conversation_dir(&project)
        .unwrap()
        .join(spin::SPIN_FILE);
    assert!(
        path.is_file(),
        "spin.json 应落在 Core 数据目录：{}",
        path.display()
    );
    assert!(
        sink.event_types().iter().all(|kind| kind != "spinDesignDataChanged"),
        "保存不广播 spinDesignDataChanged"
    );

    // 再读 → 内容与保存一致
    let read = dispatch_ui_request(
        &core,
        &json!({ "type": "spinDesignRequested", "sessionId": "spin-s1" }),
    )
    .unwrap();
    assert_eq!(read["data"], design);
}

#[test]
fn ui_request_spin_design_reports_missing_session_and_invalid_json() {
    let sandbox = Sandbox::new("main-ui-request-spin-design-errors");
    let project = sandbox.workspace.to_string_lossy().to_string();

    // 未登记会话 → status error（不是空画布）
    let missing = dispatch_ui_request(
        &test_core(),
        &json!({ "type": "spinDesignRequested", "sessionId": "unregistered" }),
    )
    .unwrap();
    assert_eq!(missing["status"], json!("error"));
    assert!(
        missing["message"]
            .as_str()
            .unwrap()
            .contains("not registered"),
        "错误消息应指出会话未登记：{missing:?}"
    );

    // 非法 JSON → status error
    config::set_session_workspace("spin-bad", Some(project.clone()));
    let dir = config::ensure_project_conversation_dir(&project).unwrap();
    std::fs::write(dir.join(spin::SPIN_FILE), "{ not json").unwrap();
    let invalid = dispatch_ui_request(
        &test_core(),
        &json!({ "type": "spinDesignRequested", "sessionId": "spin-bad" }),
    )
    .unwrap();
    assert_eq!(invalid["status"], json!("error"));

    // 保存缺 data / 缺 sessionId → 请求错误
    assert!(dispatch_ui_request(
        &test_core(),
        &json!({ "type": "spinDesignSaveRequested", "sessionId": "spin-bad" }),
    )
    .is_err());
    assert!(dispatch_ui_request(
        &test_core(),
        &json!({ "type": "spinDesignSaveRequested", "data": { "nodes": [] } }),
    )
    .is_err());
}

#[test]
fn ui_request_unknown_type_is_an_error() {
    let _sandbox = Sandbox::new("main-ui-request-unknown");
    assert!(dispatch_ui_request(&test_core(), &json!({ "type": "nope" })).is_err());
    assert!(dispatch_ui_request(&test_core(), &json!({})).is_err());
}

#[test]
fn ui_request_requires_a_session_id_where_needed() {
    let _sandbox = Sandbox::new("main-ui-request-session");
    assert!(dispatch_ui_request(&test_core(), &json!({ "type": "smartNamingRequested" })).is_err());
    assert!(dispatch_ui_request(&test_core(), &json!({ "type": "compactArchiveRequested" })).is_err());
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

/// 事件词汇对照：`dispatch_ui_event` 的 match 必须给 `eventTypesParity.json` 里的
/// 每个 UiEvent type 一个显式分支（TS 侧 eventTypeParity.test.ts 以编译期穷尽检查
/// 锁 AssistantEventBus 的联合类型；Rust 侧事件载荷是裸 Value，只能在分发点锁
/// 「每个 type 都有分支」，防止联合新增成员后 Rust 侧静默落入 `_` 兜底）。
/// 局限：这是对源码文本的断言——match 重写为别的分发结构时，本测试要跟着改。
#[test]
fn dispatch_ui_event_covers_every_ui_event_type() {
    let fixture: serde_json::Value = serde_json::from_str(
        include_str!("../fixtures/eventTypes.json"),
    )
    .expect("parse eventTypesParity.json");

    let src = include_str!("main.rs");
    let start = src.find("fn dispatch_ui_event").expect("dispatch_ui_event in main.rs");
    let end = src[start..].find("fn emit").expect("fn emit after dispatch_ui_event") + start;
    let dispatch_src = &src[start..end];

    for event_type in fixture["uiEvents"].as_array().expect("uiEvents") {
        let t = event_type.as_str().expect("type string");
        let branch = format!("\"{t}\" =>");
        assert!(
            dispatch_src.contains(&branch),
            "dispatch_ui_event 缺少 UiEvent 分支: {t}"
        );
    }
}

// ==================== eventTypesParity.json 的 Rust 侧双向锁定 ====================
//
// 此前本文件只消费 uiEvents 一张数组，coreEvents / coreRequests / uiRequests 在 Rust
// 侧没有任何消费者——Rust 侧新增 / 删除事件时 fixture 不会红（「半张表」）。这里补齐：
//
// - 正向：coreEvents / coreRequests 的每个名字（除 `coreEventsDivergences` 登记的
//   有意差异外）都必须作为 `"type": "<name>"` 出现在非测试
//   Rust 源码里（emit 位点）；
// - 反向：非测试 Rust 源码里所有 camelCase 的 `"type": "…"` 字面量都必须登记进
//   fixture 的某个数组（或 `rustTypeLiteralExemptions`）——Rust 新增 emit 而忘了登记
//   词汇表时在此失败。LLM / MCP 协议的 snake_case 与全小写字面量天然不满足 camelCase
//   判定，无需豁免；
// - uiRequests：`dispatch_ui_request` 对每个名字都有显式分支（与 dispatch_ui_event 同型）。
//
// 局限（与 dispatch_ui_event 的断言同理）：这是对源码文本的断言，不校验载荷；分发结构
// 重写时本节测试要跟着改。

/// 非 `*_tests.rs` 的 Rust 源码（文件路径 → 内容）。
/// cargo test 的工作目录是 crate 根（core-rs/），故相对 `src/` 遍历。
fn non_test_rs_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).expect("read core-rs/src") {
            // entry.path() 已含目录前缀（dir 是相对路径时它也是相对路径），不能再 join 一次
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs")
                && !path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .ends_with("_tests.rs")
            {
                let content = std::fs::read_to_string(&path).expect("read source file");
                out.push((path.to_string_lossy().to_string(), content));
            }
        }
    }
    let mut out = Vec::new();
    walk(std::path::Path::new("src"), &mut out);
    assert!(!out.is_empty(), "src/ 下没有找到 Rust 源码（工作目录应为 crate 根）");
    out
}

/// camelCase 判定：首字母小写且其余部分含大写字母。LLM / MCP 协议的 snake_case
/// （`tool_result`）与全小写字面量（`text` / `image`）不满足，天然被排除。
fn is_camel_case_type(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() => chars.any(|c| c.is_ascii_uppercase()),
        _ => false,
    }
}

fn event_parity_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../fixtures/eventTypes.json"))
        .expect("parse eventTypesParity.json")
}

#[test]
fn fixture_core_events_and_requests_exist_in_rust_emit_sites() {
    let fixture = event_parity_fixture();
    let divergences: std::collections::HashSet<String> = fixture["coreEventsDivergences"]
        .as_array()
        .expect("coreEventsDivergences")
        .iter()
        .map(|v| v.as_str().expect("type string").to_string())
        .collect();
    let sources = non_test_rs_sources();

    for group in ["coreEvents", "coreRequests"] {
        for name in fixture[group].as_array().expect(group) {
            let t = name.as_str().expect("type string");
            if divergences.contains(t) {
                continue; // 有意差异（coreEventsDivergences 登记的例外）：不广播
            }
            let needle = format!("\"type\": \"{t}\"");
            assert!(
                sources.iter().any(|(_, content)| content.contains(&needle)),
                "{group} 的 `{t}` 在 Rust 非 test 源码里没有 emit 位点（`\"type\": \"{t}\"`）；\
                 若为有意差异，登记进 coreEventsDivergences 并写明理由"
            );
        }
    }
}

#[test]
fn rust_type_literals_are_registered_in_the_fixture() {
    let fixture = event_parity_fixture();
    let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
    for group in ["coreEvents", "coreRequests", "uiEvents", "uiRequests"] {
        for name in fixture[group].as_array().expect(group) {
            known.insert(name.as_str().expect("type string").to_string());
        }
    }
    for exemption in fixture["rustTypeLiteralExemptions"]
        .as_array()
        .expect("rustTypeLiteralExemptions")
    {
        known.insert(exemption.as_str().expect("type string").to_string());
    }

    for (file, content) in non_test_rs_sources() {
        let mut rest = content.as_str();
        while let Some(at) = rest.find("\"type\": \"") {
            rest = &rest[at + "\"type\": \"".len()..];
            let end = rest.find('"').expect("unterminated type literal");
            let t = &rest[..end];
            if is_camel_case_type(t) && !known.contains(t) {
                panic!(
                    "{file} 里的 \"type\": \"{t}\" 未登记进 eventTypesParity.json——\
                     Rust 侧新增了 CoreEvent / CoreRequest 而事件词汇表没跟上"
                );
            }
        }
    }
}

#[test]
fn dispatch_ui_request_covers_every_ui_request_type() {
    let fixture = event_parity_fixture();
    let src = include_str!("main.rs");
    let start = src.find("fn dispatch_ui_request").expect("dispatch_ui_request in main.rs");
    // 取到下一个顶级声明为止（列位 0 的 `fn ` / `pub fn ` / `const `；属性行不影响定位）
    let offset = src[start + 1..]
        .find("\nfn ")
        .or_else(|| src[start + 1..].find("\npub fn "))
        .or_else(|| src[start + 1..].find("\nconst "))
        .unwrap_or(src.len() - start - 1);
    let dispatch_src = &src[start..start + 1 + offset];

    for request_type in fixture["uiRequests"].as_array().expect("uiRequests") {
        let t = request_type.as_str().expect("type string");
        let branch = format!("\"{t}\" =>");
        assert!(
            dispatch_src.contains(&branch),
            "dispatch_ui_request 缺少 UiRequest 分支: {t}"
        );
    }
}

// ==================== runtimeStateParity.json：运行时快照字段集合的双向锁定 ====================

/// `SessionRuntimeState` 快照字段没有任何跨端类型共享（TS 接口 / Rust 手写 JSON /
/// webview 投影各自维护）。fixture 锁字段集合：改 `runtime_state_json` 的字段而没同步
/// fixture 与 TS 测试时，这里失败。
#[test]
fn runtime_state_fields_match_parity_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/runtimeState.json"
    ))
    .expect("parse runtimeStateParity.json");
    let sample = crate::engine::Core::runtime_state_json("s", false, false, false, false, false, false, None);
    let mut actual: Vec<String> = sample
        .as_object()
        .expect("runtime state object")
        .keys()
        .cloned()
        .collect();
    actual.sort();
    let mut expected: Vec<String> = fixture["fields"]
        .as_array()
        .expect("fields")
        .iter()
        .map(|v| v.as_str().expect("field name").to_string())
        .collect();
    expected.sort();
    assert_eq!(actual, expected, "runtime_state_json 字段集与 runtimeStateParity.json 不一致");
}

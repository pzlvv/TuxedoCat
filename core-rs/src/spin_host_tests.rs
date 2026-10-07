//! `spin_host.rs` 的用例。
//!
//! 覆盖 `/spin` 命令的**分支选择**（结构问题 / 缺文件 / ready）与「阻塞跑完整循环 +
//! 收尾发 `spinDesignDataChanged`」这条主线。子代理本身由 `spin_tests.rs` 的假
//! `SpinHost` 端到端覆盖；这里用真 `CoreSpinHost`，但节点数保持为 0 或 1，
//! 且不依赖真实 LLM（判定失败不阻塞流程）。

use serde_json::{json, Value};

use crate::test_support::{
    EngineHarness, FakeLlm, Sandbox, openai_text_sse, openai_tool_sse,
};

use super::*;

/// 写一份可执行的 `spin.json`（单节点、无验收标准 → 判定必然通过）
fn write_ready_design(sandbox: &Sandbox, node_task: &str) {
    let dir = config::ensure_project_conversation_dir(&sandbox.workspace.to_string_lossy())
        .expect("project dir");
    std::fs::write(
        dir.join("spin.json"),
        serde_json::to_string_pretty(&json!({
            "nodes": [{ "id": 1, "x": 0, "y": 0, "task": node_task, "criteria": [] }],
            "edges": [],
            "meta": {},
        }))
        .unwrap(),
    )
    .unwrap();
}

/// 取 harness 里 `notice` 事件（键 + 参数）
fn notices(harness: &EngineHarness) -> Vec<(String, Value)> {
    harness
        .sink
        .events_of("notice")
        .iter()
        .map(|event| {
            (
                event["key"].as_str().unwrap_or("").to_string(),
                event["params"].clone(),
            )
        })
        .collect()
}

fn run(sandbox: &Sandbox, harness: &EngineHarness, args: &str) -> Option<String> {
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    run_spin_command(&harness.core, "s1", &workspace, args)
}

#[test]
fn missing_spin_json_reports_an_error() {
    let sandbox = Sandbox::new("spin-host-missing");
    let harness = EngineHarness::allow_all();
    assert!(run(&sandbox, &harness, "auto").is_none());
    let notices = notices(&harness);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].0, crate::core_text::SPIN_DESIGN_MISSING);
}

#[test]
fn invalid_spin_json_reports_an_error() {
    let sandbox = Sandbox::new("spin-host-invalid");
    let dir = config::ensure_project_conversation_dir(&sandbox.workspace.to_string_lossy())
        .expect("project dir");
    std::fs::write(dir.join("spin.json"), "{ not json").unwrap();
    let harness = EngineHarness::allow_all();
    run(&sandbox, &harness, "auto");
    let notices = notices(&harness);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].0, crate::core_text::SPIN_INVALID);
}

#[test]
fn empty_node_reports_an_error() {
    let sandbox = Sandbox::new("spin-host-empty-node");
    let dir = config::ensure_project_conversation_dir(&sandbox.workspace.to_string_lossy())
        .expect("project dir");
    std::fs::write(
        dir.join("spin.json"),
        serde_json::to_string(&json!({
            "nodes": [{ "id": 1, "x": 0, "y": 0, "task": "  ", "criteria": [] }],
            "edges": [],
            "meta": {},
        }))
        .unwrap(),
    )
    .unwrap();
    let harness = EngineHarness::allow_all();
    run(&sandbox, &harness, "auto");
    let notices = notices(&harness);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].0, crate::core_text::SPIN_EMPTY_NODE);
}

#[test]
fn variable_without_value_names_the_variable() {
    let sandbox = Sandbox::new("spin-host-variable");
    let dir = config::ensure_project_conversation_dir(&sandbox.workspace.to_string_lossy())
        .expect("project dir");
    std::fs::write(
        dir.join("spin.json"),
        serde_json::to_string(&json!({
            "nodes": [{ "id": 1, "x": 0, "y": 0, "task": "做事", "criteria": [] }],
            "edges": [],
            "meta": {},
            "variables": { "NAME": "" },
        }))
        .unwrap(),
    )
    .unwrap();
    let harness = EngineHarness::allow_all();
    run(&sandbox, &harness, "auto");
    let notices = notices(&harness);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].0, crate::core_text::SPIN_VARIABLE_NO_VALUE_WITH_NAMES);
    assert_eq!(notices[0].1["names"], "NAME");
}

#[test]
fn not_dag_reports_an_error() {
    let sandbox = Sandbox::new("spin-host-not-dag");
    let dir = config::ensure_project_conversation_dir(&sandbox.workspace.to_string_lossy())
        .expect("project dir");
    std::fs::write(
        dir.join("spin.json"),
        serde_json::to_string(&json!({
            "nodes": [
                { "id": 1, "x": 0, "y": 0, "task": "a", "criteria": [] },
                { "id": 2, "x": 0, "y": 0, "task": "b", "criteria": [] },
            ],
            "edges": [{ "from": 1, "to": 2 }, { "from": 2, "to": 1 }],
            "meta": {},
        }))
        .unwrap(),
    )
    .unwrap();
    let harness = EngineHarness::allow_all();
    run(&sandbox, &harness, "auto");
    let notices = notices(&harness);
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(notices[0].0, crate::core_text::SPIN_NOT_DAG);
}

#[test]
fn ready_design_updates_the_title_and_refreshes_the_designer() {
    let sandbox = Sandbox::new("spin-host-ready");
    write_ready_design(&sandbox, "把 README 补一段说明");
    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "旧标题" }),
    )
    .unwrap();

    // 节点会起一个子代理（Master），没有真 LLM 时它跑不出结果；
    // 这里只断言「进入执行分支」这件事，用 abort 让子代理等待立即结束。
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    harness.core.session("s1").lock().unwrap().cancel.store(true, Ordering::Relaxed);
    let result = run_spin_command(&harness.core, "s1", &workspace, "auto");

    assert!(result.is_none(), "内置命令不该返回 system 消息");
    // 标题已写进 meta.json 并广播 `titleChanged`（webview 靠它刷新打开中对话的
    // 标题栏；事件表的来源包含 skills/bundled/spin）。
    let metadata = history::load_metadata("s1", &project).expect("meta.json 应当存在");
    assert_eq!(metadata["title"], "Spin Design");
    let title_events = harness.sink.events_of("titleChanged");
    assert_eq!(title_events.len(), 1, "{:?}", harness.sink.event_types());
    assert_eq!(title_events[0]["sessionId"], "s1");
    assert_eq!(title_events[0]["title"], "Spin Design");
    // 收尾一定发设计器刷新
    assert_eq!(harness.sink.events_of("spinDesignDataChanged").len(), 1);
    // 结构问题路径不该发这条
    assert!(notices(&harness).is_empty(), "{:?}", notices(&harness));
}

#[test]
fn ready_design_creates_missing_metadata_and_broadcasts_the_list_refresh() {
    // 新会话直接 /spin：此前 meta.json 不存在时标题静默不落盘（webview 显示
    // 「Spin Design」、磁盘仍是「未命名」）。现在标题写盘建档，并按重命名同口径
    // 广播 conversationListChanged 让宿主重读磁盘刷新列表。
    let sandbox = Sandbox::new("spin-host-ready-no-meta");
    write_ready_design(&sandbox, "补一段说明");
    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();
    // 新会话尚无 meta.json，工作目录只能走活动工作目录兜底（daemon 内由
    // UiEvent.workspaceChanged 写入）
    config::set_active_workspace(Some(project.clone()));
    assert!(history::load_metadata("s1", &project).is_none(), "测试前提：无 meta.json");

    harness.core.session("s1").lock().unwrap().cancel.store(true, Ordering::Relaxed);
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    run_spin_command(&harness.core, "s1", &workspace, "auto");

    let metadata = history::load_metadata("s1", &project).expect("meta.json 已建档");
    assert_eq!(metadata["title"], "Spin Design");
    assert_eq!(harness.sink.events_of("titleChanged").len(), 1);
    assert!(
        harness.sink.events_of("conversationListChanged").len() >= 1,
        "标题落盘后广播列表变化：{:?}",
        harness.sink.event_types()
    );
}

#[test]
fn ready_design_emits_the_refresh_even_when_the_loop_fails() {
    let sandbox = Sandbox::new("spin-host-ready-fail");
    write_ready_design(&sandbox, "任务");
    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    // 立即中止：主循环会以 Aborted 收尾，但设计器刷新仍要发
    harness.core.session("s1").lock().unwrap().cancel.store(true, Ordering::Relaxed);
    let workspace = sandbox.workspace.to_string_lossy().to_string();
    run_spin_command(&harness.core, "s1", &workspace, "auto");
    assert_eq!(harness.sink.events_of("spinDesignDataChanged").len(), 1);
}

#[test]
fn spin_command_without_a_hook_reports_that_it_is_not_wired() {
    let _guard = crate::test_support::serial();
    let (emit, events) = {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink = std::sync::Arc::clone(&events);
        (
            std::sync::Arc::new(move |event: Value| sink.lock().unwrap().push(event))
                as std::sync::Arc<dyn Fn(Value) + Send + Sync>,
            events,
        )
    };
    let context = crate::commands::CommandContext {
        session_id: "s1".to_string(),
        cwd: ".".to_string(),
        command_name: None,
        emit,
        start_spin: None,
    };
    // 命令本身就地执行（提示不进 LLM 上下文），提示以 notice 事件发出
    assert_eq!(
        crate::commands::dispatch("/spin auto", &context),
        crate::commands::DispatchOutcome::Handled,
    );
    let events = events.lock().unwrap();
    // 先发 commandDispatched（UI 据此打开设计器），再发瞬时提示
    let key = events
        .iter()
        .find(|event| event["type"] == "notice")
        .and_then(|event| event["key"].as_str())
        .unwrap_or_else(|| panic!("no notice event in {events:?}"));
    assert_eq!(key, crate::core_text::SPIN_ENGINE_NOT_WIRED);
}

#[test]
fn spin_run_feeds_replies_to_the_loop_not_the_main_llm() {
    // spin 模式下主对话不参与 agent 循环：子代理的 Reply 由 SpinLoop 消费
    // （只落 silent 消息进上下文），Spin 结束后消费循环不得拿它跑主对话的 LLM 轮次。
    let sandbox = Sandbox::new("spin-host-reply-no-llm");
    let bodies = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let captured = std::sync::Arc::clone(&bodies);
    let llm = FakeLlm::start(move |index, body| {
        captured.lock().unwrap().push(body.clone());
        if index == 0 {
            // 子代理第一轮：调用 Reply 交回执行反馈
            openai_tool_sse("call_1", "Reply", r#"{"message":"节点已完成"}"#)
        } else {
            // Reply 后子代理会被静默中止，第二轮不应发生；万一走到（回归），
            // 返回纯文本让它自然收尾
            openai_text_sse(&["完成"])
        }
    });
    sandbox.write_llm_settings(&llm.base_url, "auto");
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    write_ready_design(&sandbox, "把 README 补一段说明");
    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();
    history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    // 生产路径里 /spin 在消费循环内执行，会话必然已存在；测试里先触发建档
    harness.core.session("s1");

    let workspace = sandbox.workspace.to_string_lossy().to_string();
    run_spin_command(&harness.core, "s1", &workspace, "auto");

    // 等子代理彻底收尾：它的 queryEnd 之后不会再有投递到主会话的消息
    assert!(
        harness.wait_for(
            |sink| sink
                .events_of("queryEnd")
                .iter()
                .any(|event| event["sessionId"]
                    .as_str()
                    .map_or(false, |id| id.starts_with("sub_"))),
            std::time::Duration::from_secs(30),
        ),
        "子代理应当收尾: {:?}",
        harness.sink.event_types()
    );
    let sub_session_id = harness
        .sink
        .events_of("queryBegin")
        .iter()
        .find(|event| {
            event["sessionId"]
                .as_str()
                .map_or(false, |id| id.starts_with("sub_"))
        })
        .and_then(|event| event["sessionId"].as_str())
        .expect("子代理 queryBegin")
        .to_string();

    // LLM 请求只有子代理的任务轮这一次：Reply 送达后子代理被静默中止，
    // 不再产生第二轮请求；主对话（spin 模式）全程零请求
    let captured_bodies = bodies.lock().unwrap();
    assert_eq!(
        captured_bodies.len(),
        1,
        "只应有子代理任务轮这一次 LLM 请求: {:?}",
        captured_bodies
            .iter()
            .map(|body| body.to_string())
            .take(3)
            .collect::<Vec<_>>()
    );
    assert!(
        !captured_bodies
            .iter()
            .any(|body| body.to_string().contains("Starting: Task 1")),
        "主对话不应发起 LLM 请求"
    );
    drop(captured_bodies);

    {
        let state = harness.core.session("s1");
        let state = state.lock().unwrap();
        // work_mode 已恢复 normal
        assert_eq!(state.work_mode, WorkMode::Normal);
        // 消费队列没有残留的子代理 Reply
        assert!(
            state.agent_messages.is_empty(),
            "{:?}",
            state
                .agent_messages
                .iter()
                .map(|message| &message.content)
                .collect::<Vec<_>>()
        );
    }

    // 主对话历史：spin 进度消息 + Agent tool_use 卡片 + silent Reply；
    // assistant 消息只允许是 Loop 注入的 Agent tool_use（没有 LLM 生成的轮次）
    let messages = history::load_messages("s1", &project);
    assert!(
        messages
            .iter()
            .any(|message| message["origin"] == "agent" && message["silent"] == true),
        "Reply 应落 silent 消息: {messages:?}"
    );
    assert!(
        messages.iter().all(|message| message["type"] != "assistant"
            || message["message"]["content"][0]["name"] == "Agent"),
        "主对话不应有 LLM 轮次（assistant 只能是 Agent tool_use 注入）: {messages:?}"
    );
    // Agent 卡片：Starting 与 Passed 之间应有 assistant tool_use(Agent) + tool_result
    assert!(
        messages.iter().any(|message| message["type"] == "assistant"
            && message["message"]["content"][0]["name"] == "Agent"
            && message["message"]["content"][0]["input"]["agentRole"] == "Master"
            && message["message"]["content"][0]["input"]["description"]
                == "Task 1 - 把 README 补一段说明"),
        "缺 Agent tool_use 卡片: {messages:?}"
    );
    assert!(
        messages.iter().any(|message| message["type"] == "user"
            && message["message"]["content"].as_array().map_or(false, |blocks| blocks
                .iter()
                .any(|block| block["type"] == "tool_result" && block["is_canceled"] == false))),
        "Agent tool_result 应落盘: {messages:?}"
    );
    // UI 事件：toolCall（授权前 + 执行前各一次）与 toolResult
    assert!(
        harness
            .sink
            .events_of("toolCall")
            .iter()
            .filter(|event| event["sessionId"] == "s1")
            .filter(|event| event["toolName"] == "Agent")
            .count()
            >= 2,
        "Agent 卡片应有 toolCall 事件: {:?}",
        harness.sink.event_types()
    );
    assert!(
        harness
            .sink
            .events_of("toolResult")
            .iter()
            .any(|event| event["sessionId"] == "s1" && event["toolName"] == "Agent"),
        "Agent 卡片应有 toolResult 事件"
    );
    // silent Reply 不上报 UI message 事件
    assert!(
        !harness
            .sink
            .events_of("message")
            .iter()
            .any(|event| event["data"]["content"] == "节点已完成"),
        "silent Reply 不该发 message 事件: {:?}",
        harness.sink.events_of("message")
    );

    // 节点已通过：Reply 内容经 emit_reply_delivered 被 SpinLoop 消费并判定
    let spin_config = spin::read_spin_json(&workspace).expect("spin.json");
    assert_eq!(spin_config["meta"]["1"]["passed"], json!(true));

    // 子代理被静默中止：无 `*User Interrupted*` 回显（对齐 Embedded silentAbort），
    // Reply 的 tool_result 正常落盘（不标 is_canceled）
    let sub_messages = history::load_messages(&sub_session_id, &project);
    assert!(
        !sub_messages
            .iter()
            .any(|message| message.to_string().contains("User Interrupted")),
        "静默中止不该回显中断消息: {sub_messages:?}"
    );
    assert!(
        sub_messages.iter().any(|message| message["type"] == "user"
            && message["message"]["content"]
                .as_array()
                .map_or(false, |blocks| blocks.iter().any(|block| block["type"]
                    == "tool_result"
                    && block["tool_use_id"] == "call_1"
                    && block["is_canceled"] == false))),
        "Reply 的 tool_result 应正常落盘: {sub_messages:?}"
    );
}

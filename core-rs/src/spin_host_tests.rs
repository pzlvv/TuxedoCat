//! `spin_host.rs` 的用例。
//!
//! 覆盖 `/spin` 命令的**分支选择**（结构问题 / 缺文件 / ready）与「阻塞跑完整循环 +
//! 收尾发 `spinDesignDataChanged`」这条主线。子代理本身由 `spin_tests.rs` 的假
//! `SpinHost` 端到端覆盖；这里用真 `CoreSpinHost`，但节点数保持为 0 或 1，
//! 且不依赖真实 LLM（判定失败不阻塞流程）。

use serde_json::{json, Value};

use crate::test_support::{EngineHarness, Sandbox};

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
    // 标题已写进 meta.json（落盘文本一律英文常量，Core 不感知语言）；
    // 对齐 TS `bundled/spin.ts` 的 `updateConversationMetadataTitle`：**不发**事件。
    let metadata = history::load_metadata("s1", &project).expect("meta.json 应当存在");
    assert_eq!(metadata["title"], "Spin Design");
    assert!(
        harness.sink.events_of("titleChanged").is_empty(),
        "内部改标题不该广播 titleChanged: {:?}",
        harness.sink.event_types()
    );
    // 收尾一定发设计器刷新
    assert_eq!(harness.sink.events_of("spinDesignDataChanged").len(), 1);
    // 结构问题路径不该发这条
    assert!(notices(&harness).is_empty(), "{:?}", notices(&harness));
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

//! 压缩的引擎级端到端用例（假 LLM）：手动 / 自动触发、延后执行、并发保护、
//! 运行时状态上报。纯函数对等由 `compact_tests.rs` 覆盖。

use super::*;
use crate::test_support::{openai_text_sse, EngineHarness, FakeLlm, Sandbox};

/// 让 `resolve_provider` 指向假 LLM，并登记活动工作目录
fn prepare(sandbox: &Sandbox, base_url: &str, agent_mode: &str) {
    sandbox.write_llm_settings(base_url, agent_mode);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    // 会话工作目录也显式登记：`project_of` 先查会话表，避免落到全局活动工作目录
    config::set_session_workspace("s1", Some(sandbox.workspace.to_string_lossy().to_string()));
}

fn submit(harness: &EngineHarness, session_id: &str, content: &str, uuid: &str) {
    harness.core.on_user_message(&json!({
        "sessionId": session_id,
        "content": content,
        "uuid": uuid,
        "workspacePath": null,
    }));
}

/// 预置 `count` 条用户消息：整文件写入 + 直接装进内存。
///
/// 不依赖 `ensure_loaded` 的「按 `project_of` 解析目录再读盘」路径——那会让
/// 「会话工作目录」这个全局状态参与判定，测试之间容易互相干扰。
fn seed_messages(harness: &EngineHarness, session_id: &str, project: &str, count: usize) {
    config::set_session_workspace(session_id, Some(project.to_string()));
    let messages: Vec<Value> = (0..count)
        .map(|index| {
            json!({
                "type": "user",
                "message": { "role": "user", "content": format!("消息 {index}") },
                "uuid": format!("u-{index}"),
                "timestamp": index as u64,
            })
        })
        .collect();
    crate::history::replace_messages(session_id, project, &messages).unwrap();
    let state = harness.core.session(session_id);
    let mut state = state.lock().unwrap();
    state.project = Some(project.to_string());
    state.messages = messages.clone();
    state.persisted_count = messages.len();
    state.last_uuid = messages
        .last()
        .and_then(|message| message.get("uuid"))
        .and_then(Value::as_str)
        .map(str::to_string);
}

/// 在当前会话末尾追加 `count` 条用户消息（从 `start` 开始编号），并落盘。
fn append_messages(
    harness: &EngineHarness,
    session_id: &str,
    project: &str,
    start: usize,
    count: usize,
) {
    let state = harness.core.session(session_id);
    let messages = {
        let mut state = state.lock().unwrap();
        for index in start..start + count {
            state.messages.push(json!({
                "type": "user",
                "message": { "role": "user", "content": format!("消息 {index}") },
                "uuid": format!("u-{index}"),
                "timestamp": index as u64,
            }));
        }
        state.persisted_count = state.messages.len();
        let last_uuid = state
            .messages
            .last()
            .and_then(|message| message.get("uuid"))
            .and_then(Value::as_str)
            .map(str::to_string);
        state.last_uuid = last_uuid;
        state.messages.clone()
    };
    crate::history::replace_messages(session_id, project, &messages).unwrap();
}

/// 手动压缩：`compactBegin` / `compactEnd` / `messagesReplaced`，jsonl 被整文件重写，
/// 归档写出被摘要掉的部分，`meta.json` 标记 `isCompacted`。
#[test]
fn manual_compact_rewrites_the_conversation_and_archives_the_rest() {
    let sandbox = Sandbox::new("engine-compact-manual");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    harness.core.request_compact("s1");

    // 事件：compactBegin → compactEnd(complete) → messagesReplaced
    let begins = harness.sink.events_of("compactBegin");
    assert_eq!(
        begins.len(),
        1,
        "事件: {:?} / log: {:?}",
        harness.sink.event_types(),
        harness.sink.events_of("log")
    );
    assert_eq!(begins[0]["sessionId"], "s1");
    let ends = harness.sink.events_of("compactEnd");
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0]["result"]["status"], "complete");

    let replaced = harness.sink.events_of("messagesReplaced");
    assert_eq!(replaced.len(), 1, "事件: {:?}", harness.sink.event_types());
    let replaced_messages = replaced[0]["messages"].as_array().unwrap();
    // 边界标记不进重放；摘要 + 30 条保留区 = 31 条
    assert_eq!(replaced_messages.len(), 31);
    assert_eq!(replaced_messages[0]["isCompactSummary"], json!(true));
    assert_eq!(replaced_messages[1]["content"], json!("消息 10"));

    // jsonl：边界 + 摘要 + 30 条保留区 = 32 条
    let messages = crate::history::load_messages("s1", &project);
    assert_eq!(messages.len(), 32, "jsonl 应当被整文件重写");
    assert_eq!(messages[0]["type"], "system");
    assert_eq!(messages[0]["subtype"], "compact_boundary");
    assert_eq!(messages[0]["compactMetadata"]["trigger"], "manual");
    assert!(messages[0]["content"]
        .as_str()
        .unwrap()
        .starts_with("[Manual compaction boundary] "));
    assert_eq!(messages[1]["isCompactSummary"], true);
    let summary = messages[1]["message"]["content"].as_str().unwrap();
    assert!(summary.starts_with("以下是之前对话的摘要：\n\n## 对话摘要"));
    // 用户输入历史章节（被摘要掉的前 10 条）
    assert!(summary.contains("### 用户输入历史"), "got {summary}");
    assert!(summary.contains("1. 消息 0"), "got {summary}");
    assert_eq!(messages[2]["message"]["content"], "消息 10");

    // 归档：被摘要的 10 条 + 摘要本身 = 11 条
    let archive =
        std::fs::read_to_string(crate::history::compact_archive_path("s1", &project).unwrap())
            .unwrap();
    let archive_messages: Vec<Value> = archive
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect();
    assert_eq!(archive_messages.len(), 11);
    assert_eq!(archive_messages[0]["message"]["message"]["content"], "消息 0");

    // meta.json 的压缩状态 + 消息数
    let metadata = crate::history::load_metadata("s1", &project).unwrap();
    assert_eq!(metadata["context"]["isCompacted"], true);
    assert_eq!(metadata["context"]["isExpanded"], false);
    assert_eq!(metadata["messageCount"], 32);

    // 内存里的消息也已替换，且压缩标记复位
    let state = harness.core.session_if_exists("s1").unwrap();
    assert_eq!(state.lock().unwrap().messages.len(), 32);
    assert!(!state.lock().unwrap().compacting, "压缩结束后应当复位");

    crate::compact::reset_for_test();
}

/// 多次压缩：摘要里的用户输入历史头部来自上一次持久化的历史，
/// 会话最初的用户输入不会因为再次压缩而丢失（见 `docs/features/compaction.md`）。
#[test]
fn repeated_compact_keeps_the_global_user_input_head() {
    let sandbox = Sandbox::new("engine-compact-repeat");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    // 第一次压缩：归档区是「消息 0」..「消息 9」，10 条 ≤ 12 全部保留。
    harness.core.request_compact("s1");
    let after_first = crate::history::load_messages("s1", &project);
    let first_history = after_first[1]["compactUserInputHistory"].as_array().unwrap();
    assert_eq!(first_history.len(), 10, "首次压缩保留归档区全部 10 条");
    assert_eq!(first_history[0]["content"], json!("消息 0"));
    assert_eq!(first_history[9]["content"], json!("消息 9"));

    // 追加 40 条新消息，让会话再次超过压缩阈值后压缩第二次。
    append_messages(&harness, "s1", &project, 40, 40);
    harness.core.request_compact("s1");

    let after_second = crate::history::load_messages("s1", &project);
    let summary = after_second[1]["message"]["content"].as_str().unwrap();
    let second_history = after_second[1]["compactUserInputHistory"].as_array().unwrap();
    // 头部 = 会话最早的 4 条（从上次持久化历史沿用，不因再次压缩而丢失）；
    // 尾部 = 本次归档区最近 8 条（「消息 42」..「消息 49」）。
    assert_eq!(second_history.len(), 12, "got {second_history:?}");
    assert_eq!(second_history[0]["content"], json!("消息 0"));
    assert_eq!(second_history[3]["content"], json!("消息 3"));
    assert_eq!(second_history[11]["content"], json!("消息 49"));
    assert!(summary.contains("1. 消息 0"), "got {summary}");
    assert!(summary.contains("12. 消息 49"), "got {summary}");

    crate::compact::reset_for_test();
}

/// 手动压缩：没有可压缩的消息时**什么都不做**（不发事件、不替换、不排队）。
#[test]
fn manual_compact_is_a_noop_without_compactable_messages() {
    let sandbox = Sandbox::new("engine-compact-noop");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["摘要"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 5);

    harness.core.request_compact("s1");

    assert!(harness.sink.events_of("compactBegin").is_empty());
    assert!(harness.sink.events_of("messagesReplaced").is_empty());
    assert!(!crate::compact::is_pending_compact("s1"));
    assert_eq!(crate::history::load_messages("s1", &project).len(), 5);

    crate::compact::reset_for_test();
}

/// 自动压缩：上下文 token 超过阈值时，在**本轮请求之前**压缩。
#[test]
fn auto_compact_triggers_when_the_context_exceeds_the_threshold() {
    let sandbox = Sandbox::new("engine-compact-auto");
    crate::compact::reset_for_test();
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&bodies);
    let llm = FakeLlm::start(move |_index, body| {
        captured.lock().unwrap().push(body.clone());
        openai_text_sse(&["摘要"])
    });
    // 上下文窗口压到 2000、输出上限压到 1000 → 阈值 = 2000 - min(50K, 300) = 1700，
    // 随便几条消息就会超。
    sandbox.write_llm_settings(&llm.base_url, "auto");
    let mut settings = sandbox.read_settings();
    settings["llm"]["maxTokens"] = json!(1000);
    settings["llm"]["providers"]["fake"]["modelConfigs"]["fake-model"]["context"] = json!(2000);
    settings["llm"]["providers"]["fake"]["modelConfigs"]["fake-model"]["output"] = json!(1000);
    sandbox.write_settings(settings);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));

    let harness = EngineHarness::allow_all();
    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    submit(&harness, "s1", "继续", "u-100");

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("compactBegin").is_empty(),
            Duration::from_secs(30),
        ),
        "应当触发自动压缩: {:?}",
        harness.sink.event_types()
    );
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("messagesReplaced").is_empty(),
            Duration::from_secs(30),
        ),
        "压缩后应当重放消息: {:?}",
        harness.sink.event_types()
    );

    let messages = crate::history::load_messages("s1", &project);
    assert_eq!(messages[0]["subtype"], "compact_boundary");
    assert_eq!(messages[0]["compactMetadata"]["trigger"], "auto");
    assert!(messages[0]["content"]
        .as_str()
        .unwrap()
        .starts_with("[Auto compaction boundary] "));

    // 等本轮收尾，再看请求顺序
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "本轮应当收尾: {:?}",
        harness.sink.event_types()
    );

    // 压缩发生在**本轮请求之前**：第 1 次请求是摘要，之后才是真正的对话请求
    let bodies = bodies.lock().unwrap();
    assert!(bodies.len() >= 2, "应当有摘要请求 + 对话请求，实际 {}", bodies.len());
    assert!(
        bodies[0]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["content"]
                .as_str()
                .map(|text| text.contains("请总结以下对话的要点"))
                .unwrap_or(false)),
        "第 1 次请求应当是摘要"
    );

    crate::compact::reset_for_test();
}

/// 会话非空闲时手动压缩只登记「待压缩」，并提示用户；下一轮对话开始时执行。
#[test]
fn manual_compact_is_deferred_while_the_session_is_busy() {
    let sandbox = Sandbox::new("engine-compact-deferred");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["摘要"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    // 伪造「正在跑一轮」：`running` 为真即视为非空闲
    let state = harness.core.session_if_exists("s1").unwrap();
    state.lock().unwrap().running = true;

    harness.core.request_compact("s1");
    assert!(crate::compact::is_pending_compact("s1"));
    assert!(harness.sink.events_of("compactBegin").is_empty());
    assert!(
        harness.sink.events_of("message").is_empty(),
        "排队提示不再走 message 事件"
    );
    let runtime = harness
        .sink
        .events_of("sessionRuntimeChanged")
        .into_iter()
        .last()
        .expect("runtime snapshot");
    let entry = runtime["states"]
        .as_array()
        .expect("states")
        .iter()
        .find(|state| state["sessionId"] == "s1")
        .expect("s1 in runtime snapshot");
    assert_eq!(entry["pendingCompact"], true, "待压缩进运行时快照");

    // 重复请求不重复登记、不重复推送
    let snapshots = harness.sink.events_of("sessionRuntimeChanged").len();
    harness.core.request_compact("s1");
    assert_eq!(
        harness.sink.events_of("sessionRuntimeChanged").len(),
        snapshots,
        "重复请求不应再次推送快照"
    );

    // 放回空闲 → 下一轮对话开始时执行延后的压缩
    state.lock().unwrap().running = false;
    submit(&harness, "s1", "继续", "u-100");
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("messagesReplaced").is_empty(),
            Duration::from_secs(30),
        ),
        "延后的压缩应当在本轮开始时执行: {:?}",
        harness.sink.event_types()
    );
    assert!(!crate::compact::is_pending_compact("s1"), "标记应当被清掉");
    let runtime = harness
        .sink
        .events_of("sessionRuntimeChanged")
        .into_iter()
        .last()
        .expect("runtime snapshot");
    let entry = runtime["states"]
        .as_array()
        .expect("states")
        .iter()
        .find(|state| state["sessionId"] == "s1")
        .expect("s1 in runtime snapshot");
    assert_eq!(entry["pendingCompact"], false, "消费后快照应当清除待压缩");
    let messages = crate::history::load_messages("s1", &project);
    assert_eq!(messages[0]["compactMetadata"]["trigger"], "manual");

    crate::compact::reset_for_test();
}

/// 待压缩被消费但消息不足（不可压缩）：清除标记并推送快照，不进入压缩。
#[test]
fn pending_compact_is_cleared_when_there_is_nothing_to_summarize() {
    let sandbox = Sandbox::new("engine-compact-pending-skip");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["不应被调用"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 5);
    crate::compact::mark_pending_compact("s1");
    harness.core.emit_runtime();
    let snapshots_before = harness.sink.events_of("sessionRuntimeChanged").len();

    submit(&harness, "s1", "继续", "u-100");
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("aiBegin").is_empty(),
            Duration::from_secs(30),
        ),
        "本轮应当正常开始: {:?}",
        harness.sink.event_types()
    );
    assert!(!crate::compact::is_pending_compact("s1"), "标记应当被清掉");
    assert!(
        harness.sink.events_of("compactBegin").is_empty(),
        "不可压缩时不进入压缩"
    );
    assert!(
        harness.sink.events_of("sessionRuntimeChanged").len() > snapshots_before,
        "清除待压缩应当推送快照: {:?}",
        harness.sink.event_types()
    );
    let runtime = harness
        .sink
        .events_of("sessionRuntimeChanged")
        .into_iter()
        .last()
        .expect("runtime snapshot");
    let entry = runtime["states"]
        .as_array()
        .expect("states")
        .iter()
        .find(|state| state["sessionId"] == "s1")
        .expect("s1 in runtime snapshot");
    assert_eq!(
        entry["pendingCompact"], false,
        "跳过压缩后快照应当清除待压缩"
    );

    crate::compact::reset_for_test();
}

/// 当前轮次最后一次 LLM 往返期间请求压缩：轮次结束后应当自动执行，
/// 不能等到用户再发一条消息（specs/defects/queued-compact-waits-for-next-round.md RT-1）。
#[test]
fn pending_compact_runs_when_the_current_turn_ends() {
    let sandbox = Sandbox::new("engine-compact-turn-end");
    crate::compact::reset_for_test();
    let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let gated = Arc::new(AtomicBool::new(false));
    let worker_gated = Arc::clone(&gated);
    let llm = FakeLlm::start(move |_index, body| {
        let is_compact = body.to_string().contains("请总结以下对话的要点");
        if !is_compact && !worker_gated.swap(true, Ordering::SeqCst) {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
        }
        openai_text_sse(&["回复"])
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    submit(&harness, "s1", "最后一条", "u-100");
    assert!(
        started_rx.recv_timeout(Duration::from_secs(10)).is_ok(),
        "查询应当发出 LLM 请求"
    );
    // 会话正在跑最后一次往返：请求压缩只会登记待压缩
    harness.core.request_compact("s1");
    assert!(crate::compact::is_pending_compact("s1"), "应当登记待压缩");
    release_tx.send(()).expect("release llm");

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "本轮应当结束: {:?}",
        harness.sink.event_types()
    );
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("messagesReplaced").is_empty(),
            Duration::from_secs(10),
        ),
        "轮次结束后应当执行排队的压缩: {:?}",
        harness.sink.event_types()
    );
    assert!(!crate::compact::is_pending_compact("s1"), "标记应当被清掉");

    // 轮次末尾到压缩开始之间不允许出现 idle：间隙仍属同一段连续任务
    let events = harness.sink.events();
    let compact_at = events
        .iter()
        .position(|event| event["type"] == "compactBegin")
        .expect("compactBegin");
    let idle_before_compact = events[..compact_at].iter().any(|event| {
        event["type"] == "sessionRuntimeChanged"
            && event["states"]
                .as_array()
                .map(|states| {
                    states
                        .iter()
                        .any(|state| state["sessionId"] == "s1" && state["idle"] == true)
                })
                .unwrap_or(false)
    });
    assert!(
        !idle_before_compact,
        "压缩开始前会话不应进入 idle: {:?}",
        harness.sink.event_types()
    );
    let replaced_at = events
        .iter()
        .position(|event| event["type"] == "messagesReplaced")
        .expect("messagesReplaced");
    let query_end_at = events
        .iter()
        .position(|event| event["type"] == "queryEnd")
        .expect("queryEnd");
    assert!(replaced_at < query_end_at, "queryEnd 应当在压缩完成之后");

    crate::compact::reset_for_test();
}

/// 中止时清除待压缩：中止后不补跑压缩（specs/defects/queued-compact-waits-for-next-round.md RT-2）。
#[test]
fn abort_clears_pending_compact() {
    let sandbox = Sandbox::new("engine-compact-abort-pending");
    crate::compact::reset_for_test();
    let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let gated = Arc::new(AtomicBool::new(false));
    let worker_gated = Arc::clone(&gated);
    let llm = FakeLlm::start(move |_index, body| {
        let is_compact = body.to_string().contains("请总结以下对话的要点");
        if !is_compact && !worker_gated.swap(true, Ordering::SeqCst) {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
        }
        openai_text_sse(&["回复"])
    });
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    submit(&harness, "s1", "最后一条", "u-100");
    assert!(
        started_rx.recv_timeout(Duration::from_secs(10)).is_ok(),
        "查询应当发出 LLM 请求"
    );
    harness.core.request_compact("s1");
    assert!(crate::compact::is_pending_compact("s1"), "应当登记待压缩");
    harness.core.on_abort("s1");
    release_tx.send(()).expect("release llm");

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "本轮应当结束: {:?}",
        harness.sink.event_types()
    );
    assert!(
        !crate::compact::is_pending_compact("s1"),
        "中止后应当清除待压缩"
    );
    assert!(
        harness.sink.events_of("compactBegin").is_empty(),
        "中止后不应补跑压缩"
    );

    crate::compact::reset_for_test();
}

/// 压缩期间到达的用户消息只入队不启动消费循环；压缩收尾时唤醒。
#[test]
fn messages_arriving_during_compact_are_queued_then_resumed() {
    let sandbox = Sandbox::new("engine-compact-resume");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["摘要"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    // 模拟压缩进行中
    let state = harness.core.session_if_exists("s1").unwrap();
    crate::compact::mark_compacting("s1");
    state.lock().unwrap().compacting = true;

    submit(&harness, "s1", "压缩期间发的消息", "u-200");
    assert!(!state.lock().unwrap().running, "压缩期间不应启动消费循环");
    assert!(state.lock().unwrap().pending_user_message.is_some());

    // 压缩结束 → 唤醒
    crate::compact::unmark_compacting("s1");
    state.lock().unwrap().compacting = false;
    harness.core.resume_after_compact("s1");
    assert!(state.lock().unwrap().running, "应当启动消费循环");

    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "排队消息应当被消费: {:?}",
        harness.sink.event_types()
    );
    let messages = crate::history::load_messages("s1", &project);
    assert!(
        messages
            .iter()
            .any(|message| message["message"]["content"] == json!("压缩期间发的消息")),
        "排队消息应当进上下文，实际 {} 条: {messages:?}",
        messages.len()
    );

    crate::compact::reset_for_test();
}

/// 压缩期间会话不算空闲（`compacting` 是内部记账位，只通过 `idle` 体现）。
#[test]
fn runtime_snapshot_reports_compacting() {
    let sandbox = Sandbox::new("engine-compact-runtime");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["摘要"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    let state = harness.core.session_if_exists("s1").unwrap();
    state.lock().unwrap().compacting = true;
    harness.core.emit_runtime();

    let snapshot = harness.sink.events_of("sessionRuntimeChanged");
    let latest = snapshot.last().expect("应当有运行时快照");
    let entry = latest["states"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["sessionId"] == "s1")
        .expect("应当有 s1");
    // 快照导出根事实 + 派生 `idle`：
    // `compacting` 既是根事实，也通过 `idle` 体现
    assert_eq!(entry["idle"], false, "压缩中不算空闲");
    assert_eq!(entry["compacting"], true, "compacting 进快照");

    state.lock().unwrap().compacting = false;
    harness.core.emit_runtime();
    let latest = harness
        .sink
        .events_of("sessionRuntimeChanged")
        .pop()
        .unwrap();
    let entry = latest["states"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["sessionId"] == "s1")
        .unwrap();
    assert_eq!(entry["idle"], true);

    crate::compact::reset_for_test();
}

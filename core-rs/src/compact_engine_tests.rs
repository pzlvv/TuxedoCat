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

/// 压缩后上下文占用事实被产出（specs/defects/compact-context-facts-stale-across-views）：
/// `compactEnd.postCompactTokenCount` 是压缩产物按运行时同款口径的重算值（不再取摘要
/// 生成调用的 output tokens），`meta.json` 的 `context.totalContextTokens` 同步写回——
/// 不写回的话切回视图的用量条与 core 自己的估算兜底都拿压缩前旧值。
#[test]
fn manual_compact_writes_post_compact_context_tokens() {
    let sandbox = Sandbox::new("engine-compact-tokens");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let project = sandbox.workspace.to_string_lossy().to_string();
    seed_messages(&harness, "s1", &project, 40);

    // 造一个压缩前的大占用（模拟逼近阈值的真实用量），压缩后不得停留该值
    crate::history::update_context(
        "s1",
        &project,
        &[json!({ "key": "totalContextTokens", "value": 999_999 })],
    )
    .unwrap();

    harness.core.request_compact("s1");

    let ends = harness.sink.events_of("compactEnd");
    assert_eq!(ends.len(), 1);
    assert_eq!(ends[0]["result"]["status"], "complete");
    let post_compact = ends[0]["result"]["postCompactTokenCount"]
        .as_u64()
        .expect("postCompactTokenCount is a number");
    assert!(post_compact > 0, "压缩产物估算应大于 0");
    assert_ne!(post_compact, 999_999, "不得停留在压缩前旧值");

    let metadata = crate::history::load_metadata("s1", &project).unwrap();
    assert_eq!(
        metadata["context"]["totalContextTokens"],
        json!(post_compact),
        "meta.json 写回与 compactEnd 同一值"
    );

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

// ==================== Todo 表 × 压缩（specs/027） ====================
//
// Todo 表由 Core 持有（`docs/features/todo-list.md` FR-001）：压缩重写的是消息数组与
// 会话文件，与表无关。这组用例锁住三件事——① 压缩（含多次压缩）不动表；② 压缩把
// `TodoWrite` 调用从文件里摘要掉之后，表仍然是唯一事实；③ 进程重启（表清空）后重建
// 只能重建到「还在保留区里的最后一条成功调用」。

/// 造一个只带 `session_id` 的工具上下文（TodoWrite 不读 cwd，但字段必填）
fn todo_ctx(sandbox: &Sandbox, session_id: &str) -> crate::tools::ToolContext {
    crate::tools::ToolContext {
        session_id: session_id.to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
        transfer: None,
    }
}

/// 走真实的 `TodoWrite` 执行路径（写表 + 返回 `SuccessWithTodos`）
fn write_todos(sandbox: &Sandbox, session_id: &str, todos: Value) -> crate::tools::ToolOutcome {
    let outcome = crate::tools::execute(
        "TodoWrite",
        &json!({ "todos": todos }),
        &todo_ctx(sandbox, session_id),
    );
    assert!(!outcome.is_error(), "TodoWrite 应当成功: {}", outcome.text());
    outcome
}

/// 往会话末尾追加「assistant TodoWrite tool_use + user tool_result」一对消息
/// （同步内存与落盘，`exit_code` 0 = 成功、非 0 = 失败）
fn append_todo_call(
    harness: &EngineHarness,
    session_id: &str,
    project: &str,
    id: &str,
    todos: Value,
    exit_code: i64,
) {
    let state = harness.core.session(session_id);
    let messages = {
        let mut state = state.lock().unwrap();
        state.messages.push(json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": id,
                    "name": "TodoWrite",
                    "input": { "todos": todos },
                }],
            },
            "uuid": format!("a-{id}"),
            "timestamp": 10_000,
        }));
        state.messages.push(json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": "Todos have been modified successfully",
                    "exit_code": exit_code,
                }],
            },
            "uuid": format!("r-{id}"),
            "timestamp": 10_001,
        }));
        state.persisted_count = state.messages.len();
        state.last_uuid = Some(format!("r-{id}"));
        state.messages.clone()
    };
    crate::history::replace_messages(session_id, project, &messages).unwrap();
}

/// 会话文件里是否还留着某次 `TodoWrite` 调用
fn file_has_todo_call(project: &str, session_id: &str, id: &str) -> bool {
    crate::history::load_messages(session_id, project)
        .iter()
        .filter_map(|message| message["message"]["content"].as_array())
        .flatten()
        .any(|block| block["type"] == json!("tool_use") && block["id"] == json!(id))
}

/// 准备「早期写过 Todo、之后又堆了很多消息」的会话：TodoWrite 落在保留区之外
fn seed_with_early_todo(harness: &EngineHarness, sandbox: &Sandbox) -> (String, Value) {
    let project = sandbox.workspace.to_string_lossy().to_string();
    let todos = json!([
        { "content": "改代码", "activeForm": "改代码中", "status": "completed" },
        { "content": "跑测试", "activeForm": "跑测试中", "status": "in_progress" },
        { "content": "写文档", "activeForm": "写文档中", "status": "pending" },
        { "content": "收敛", "activeForm": "收敛中", "status": "pending" }
    ]);
    seed_messages(harness, "s1", &project, 5);
    append_todo_call(harness, "s1", &project, "tu-early", todos.clone(), 0);
    // 再堆 40 条：压缩只保留末尾 30 条，早期这对消息会被摘要掉
    append_messages(harness, "s1", &project, 5, 40);
    (project, todos)
}

#[test]
fn todo_table_survives_manual_compact() {
    let sandbox = Sandbox::new("engine-compact-todo-manual");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let (project, todos) = seed_with_early_todo(&harness, &sandbox);
    // 真实写入路径：表里有这份清单
    write_todos(&sandbox, "s1", todos);
    let before = crate::tools::session_todos("s1").expect("表里应有该会话");

    harness.core.request_compact("s1");

    // ① 表不变
    assert_eq!(crate::tools::session_todos("s1"), Some(before));
    // ② 文件里那条调用已被摘要掉——证明状态不是从文件推出来的
    assert!(
        !file_has_todo_call(&project, "s1", "tu-early"),
        "早期 TodoWrite 应当已被摘要替换"
    );
    // ③ 压缩确实发生了
    let messages = crate::history::load_messages("s1", &project);
    assert_eq!(messages[0]["subtype"], json!("compact_boundary"));

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

#[test]
fn todo_table_survives_repeated_compaction() {
    let sandbox = Sandbox::new("engine-compact-todo-repeat");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let (project, todos) = seed_with_early_todo(&harness, &sandbox);
    write_todos(&sandbox, "s1", todos);
    let before = crate::tools::session_todos("s1").expect("表里应有该会话");

    harness.core.request_compact("s1");
    assert_eq!(crate::tools::session_todos("s1"), Some(before.clone()));

    // 追加消息让会话再次超阈值，压第二次
    append_messages(&harness, "s1", &project, 45, 40);
    harness.core.request_compact("s1");

    assert_eq!(
        crate::tools::session_todos("s1"),
        Some(before),
        "多次压缩后表仍是最初写入的那份清单"
    );
    assert_eq!(
        crate::history::load_messages("s1", &project)[0]["subtype"],
        json!("compact_boundary")
    );

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

#[test]
fn todo_table_survives_compaction_after_new_write() {
    let sandbox = Sandbox::new("engine-compact-todo-rewrite");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let (project, todos) = seed_with_early_todo(&harness, &sandbox);
    write_todos(&sandbox, "s1", todos);
    harness.core.request_compact("s1");

    // 压缩之后再写一次（真实写入路径）
    let second = json!([
        { "content": "只剩一件", "activeForm": "做这一件", "status": "in_progress" }
    ]);
    write_todos(&sandbox, "s1", second);
    // 再压一次：第二次的清单不受影响
    append_messages(&harness, "s1", &project, 85, 40);
    harness.core.request_compact("s1");

    assert_eq!(
        crate::tools::session_todos("s1"),
        Some(json!([
            { "content": "只剩一件", "status": "in_progress", "activeForm": "做这一件" }
        ]))
    );

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

#[test]
fn todo_rebuild_after_compaction_and_restart_returns_empty() {
    let sandbox = Sandbox::new("engine-compact-todo-restart-empty");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let (_project, todos) = seed_with_early_todo(&harness, &sandbox);
    write_todos(&sandbox, "s1", todos);
    harness.core.request_compact("s1");

    // 模拟进程重启：表清空
    crate::tools::clear_session_todos("s1");
    assert_eq!(crate::tools::session_todos("s1"), None);

    // 重建：最后一条成功调用已被摘要替换 → 视为没有 Todo
    assert_eq!(crate::tools::ensure_session_todos("s1"), json!([]));

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

#[test]
fn todo_rebuild_after_compaction_and_restart_uses_surviving_write() {
    let sandbox = Sandbox::new("engine-compact-todo-restart-survive");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    prepare(&sandbox, &llm.base_url, "auto");
    let harness = EngineHarness::allow_all();

    let (project, todos) = seed_with_early_todo(&harness, &sandbox);
    write_todos(&sandbox, "s1", todos);
    harness.core.request_compact("s1");

    // 压缩后再写一次：这次落在保留区里
    let survivor = json!([
        { "content": "压缩后写的", "activeForm": "压缩后写", "status": "pending" }
    ]);
    write_todos(&sandbox, "s1", survivor.clone());
    append_todo_call(&harness, "s1", &project, "tu-survivor", survivor, 0);

    // 模拟进程重启：表清空后重建
    crate::tools::clear_session_todos("s1");
    assert_eq!(
        crate::tools::ensure_session_todos("s1"),
        json!([
            { "content": "压缩后写的", "status": "pending", "activeForm": "压缩后写" }
        ]),
        "保留区里的最后一条成功调用可以被重建出来"
    );

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

#[test]
fn todo_table_survives_auto_compact() {
    let sandbox = Sandbox::new("engine-compact-todo-auto");
    crate::compact::reset_for_test();
    let llm = FakeLlm::fixed(openai_text_sse(&["## 对话摘要\n\n摘要正文"]));
    // 上下文窗口压到 2000、输出上限压到 1000 → 阈值 1700，随便几条消息就会超
    sandbox.write_llm_settings(&llm.base_url, "auto");
    let mut settings = sandbox.read_settings();
    settings["llm"]["maxTokens"] = json!(1000);
    settings["llm"]["providers"]["fake"]["modelConfigs"]["fake-model"]["context"] = json!(2000);
    settings["llm"]["providers"]["fake"]["modelConfigs"]["fake-model"]["output"] = json!(1000);
    sandbox.write_settings(settings);
    config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    let harness = EngineHarness::allow_all();

    let (_project, todos) = seed_with_early_todo(&harness, &sandbox);
    write_todos(&sandbox, "s1", todos);
    let before = crate::tools::session_todos("s1").expect("表里应有该会话");

    // 自动压缩由本轮请求前的阈值判定触发
    submit(&harness, "s1", "继续", "u-100");
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("messagesReplaced").is_empty(),
            Duration::from_secs(30),
        ),
        "应当触发自动压缩: {:?}",
        harness.sink.event_types()
    );
    assert!(
        harness.wait_for(
            |sink| !sink.events_of("queryEnd").is_empty(),
            Duration::from_secs(30),
        ),
        "本轮应当收尾: {:?}",
        harness.sink.event_types()
    );

    assert_eq!(
        crate::tools::session_todos("s1"),
        Some(before),
        "自动压缩路径同样不动表"
    );

    crate::tools::clear_session_todos("s1");
    crate::compact::reset_for_test();
}

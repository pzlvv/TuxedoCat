//! `bash_task` 单测：任务注册表、输出文件、完成通知文案、进程生命周期。

use super::*;
use crate::test_support::Sandbox;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

/// 把 `TMPDIR` 指到沙箱里，让输出文件落在临时目录而不是真实 `%TEMP%`。
/// 退出时还原（`bash_task::task_output_dir` 每次调用都读环境变量）。
struct TmpDirGuard {
    previous: Option<String>,
}

impl TmpDirGuard {
    fn set(path: &Path) -> TmpDirGuard {
        let previous = std::env::var("TMPDIR").ok();
        std::fs::create_dir_all(path).expect("create tmp dir");
        std::env::set_var("TMPDIR", path);
        TmpDirGuard { previous }
    }
}

impl Drop for TmpDirGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("TMPDIR", value),
            None => std::env::remove_var("TMPDIR"),
        }
    }
}

/// 钩子捕获到的调用
#[derive(Default)]
struct Captured {
    notifications: Mutex<Vec<(String, String)>>,
    background_syncs: Mutex<Vec<String>>,
}

fn hooks(captured: &Arc<Captured>) -> Hooks {
    let notify = Arc::clone(captured);
    let sync = Arc::clone(captured);
    Hooks {
        notify: Arc::new(move |session_id: &str, content: &str| {
            notify
                .notifications
                .lock()
                .unwrap()
                .push((session_id.to_string(), content.to_string()));
        }),
        sync_background: Arc::new(move |session_id: &str| {
            sync.background_syncs
                .lock()
                .unwrap()
                .push(session_id.to_string());
        }),
    }
}

fn wait_for_notification(captured: &Captured, timeout_ms: u64) -> Option<(String, String)> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if let Some(item) = captured.notifications.lock().unwrap().first().cloned() {
            return Some(item);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn finished(status: TaskStatus, exit_code: i32, duration_ms: u64) -> FinishedTask {
    FinishedTask {
        task_id: "bg-1700000000000-abc".to_string(),
        description: "List files in current directory".to_string(),
        session_id: "s-bg".to_string(),
        status,
        exit_code,
        duration_ms,
    }
}

// ==================== 文案 ====================

#[test]
fn format_duration_matches_embedded() {
    assert_eq!(format_duration(0), "0ms");
    assert_eq!(format_duration(999), "999ms");
    assert_eq!(format_duration(1000), "1.0s");
    assert_eq!(format_duration(1500), "1.5s");
    // `toFixed(1)` 的平局远离零进位：1.25 → "1.3"（Rust `{:.1}` 会给 "1.2"）；
    // 1.15 的 double 略小于 1.15，仍是 "1.1"
    assert_eq!(format_duration(1250), "1.3s");
    assert_eq!(format_duration(2250), "2.3s");
    assert_eq!(format_duration(1150), "1.1s");
    assert_eq!(format_duration(1750), "1.8s");
    assert_eq!(format_duration(59_999), "60.0s");
    assert_eq!(format_duration(60_000), "1m 0s");
    assert_eq!(format_duration(95_000), "1m 35s");
}

#[test]
fn task_id_uses_the_embedded_shape() {
    let task_id = generate_task_id();
    assert!(task_id.starts_with("bg-"), "{task_id}");
    assert_eq!(task_id.matches('-').count(), 2, "{task_id}");
    assert_ne!(generate_task_id(), generate_task_id());
}

#[test]
fn completion_notification_matches_embedded_text() {
    let completed = finished(TaskStatus::Completed, 0, 1500);
    assert_eq!(
        build_completion_notification(&completed, ""),
        "Background task completed\n\
         Task: bg-1700000000000-abc\n\
         Description: Background command \"List files in current directory\" completed (exit code 0)\n\
         Duration: 1.5s"
    );

    assert_eq!(
        build_completion_notification(&completed, "hello\n"),
        "Background task completed\n\
         Task: bg-1700000000000-abc\n\
         Description: Background command \"List files in current directory\" completed (exit code 0)\n\
         Duration: 1.5s\n\
         Output (first 500 chars):\n\
         hello\n"
    );

    let failed = finished(TaskStatus::Failed, 3, 200);
    assert!(build_completion_notification(&failed, "")
        .contains("Description: Background command \"List files in current directory\" failed with exit code 3"));
    assert!(build_completion_notification(&failed, "").contains("Duration: 200ms"));

    let stopped = finished(TaskStatus::Killed, 1, 200);
    assert!(build_completion_notification(&stopped, "")
        .contains("Description: Background command \"List files in current directory\" was stopped"));
}

#[test]
fn completion_notification_truncates_output_at_five_hundred_chars() {
    let completed = finished(TaskStatus::Completed, 0, 1000);
    let long = "x".repeat(600);
    let notification = build_completion_notification(&completed, &long);
    assert!(notification.ends_with(&format!("{}\n...", "x".repeat(500))));

    // 恰好 500 字符：不追加省略号（对齐 Embedded 的 `stdout.length > 500`）
    let exact = "y".repeat(500);
    let notification = build_completion_notification(&completed, &exact);
    assert!(notification.ends_with(&exact));
    assert!(!notification.ends_with("..."));
}

// ==================== 输出路径 ====================

#[test]
fn output_path_follows_tmpdir() {
    let sandbox = Sandbox::new("bash-task-paths");
    let tmp = sandbox.root.join("tmp");
    let _guard = TmpDirGuard::set(&tmp);
    assert_eq!(task_output_dir(), tmp.join(TASK_OUTPUT_DIR_NAME));
    assert_eq!(
        task_output_path("bg-1-2"),
        tmp.join(TASK_OUTPUT_DIR_NAME).join("bg-1-2.output")
    );
}

// ==================== 注册表与进程 ====================

#[test]
fn spawn_background_writes_output_and_notifies() {
    let sandbox = Sandbox::new("bash-task-spawn");
    let _guard = TmpDirGuard::set(&sandbox.root.join("tmp"));
    reset_for_test();

    let captured = Arc::new(Captured::default());
    let task_id = spawn_background(
        "echo hello",
        &sandbox.workspace.to_string_lossy(),
        "Say hello",
        "s-bg",
        Some(hooks(&captured)),
    )
    .expect("spawn background");

    assert_eq!(running_count_for_session("s-bg"), 1);
    assert_eq!(running_count_for_session("s-other"), 0);

    let (session_id, notification) = wait_for_notification(&captured, 10_000).expect("完成通知");
    assert_eq!(session_id, "s-bg");
    assert!(notification.contains("Background task completed"), "{notification}");
    assert!(notification.contains(&format!("Task: {task_id}")), "{notification}");
    assert!(
        notification.contains("Description: Background command \"Say hello\" completed (exit code 0)"),
        "{notification}"
    );
    assert!(notification.contains("Output (first 500 chars):\nhello"), "{notification}");

    // 输出文件就是子进程的 stdout（file mode）
    let path = task_output_path(&task_id);
    assert_eq!(std::fs::read_to_string(&path).unwrap().trim_end(), "hello");
    assert_eq!(task_status(&task_id), Some(TaskStatus::Completed));
    assert_eq!(running_count_for_session("s-bg"), 0);

    // 增减各同步一次 background 事实（注册时 + 完成时）
    assert_eq!(captured.background_syncs.lock().unwrap().len(), 2);
    reset_for_test();
}

#[test]
fn background_failure_reports_a_non_zero_exit_code() {
    let sandbox = Sandbox::new("bash-task-failure");
    let _guard = TmpDirGuard::set(&sandbox.root.join("tmp"));
    reset_for_test();

    let captured = Arc::new(Captured::default());
    spawn_background(
        "exit 7",
        &sandbox.workspace.to_string_lossy(),
        "Fail",
        "s-bg",
        Some(hooks(&captured)),
    )
    .expect("spawn background");

    let (_, notification) = wait_for_notification(&captured, 10_000).expect("完成通知");
    assert!(
        notification.contains("failed with exit code 7"),
        "{notification}"
    );
    reset_for_test();
}

#[test]
fn aborting_a_session_drops_the_completion_notification() {
    let sandbox = Sandbox::new("bash-task-abort");
    let _guard = TmpDirGuard::set(&sandbox.root.join("tmp"));
    reset_for_test();

    let captured = Arc::new(Captured::default());
    spawn_background(
        "sleep 30",
        &sandbox.workspace.to_string_lossy(),
        "Sleep",
        "s-bg",
        Some(hooks(&captured)),
    )
    .expect("spawn background");
    assert_eq!(running_count_for_session("s-bg"), 1);

    // 对齐 `abortBackgroundTasksForSession`：先移除记录再 kill，
    // 因此完成回调查不到记录，被中止的任务不会发通知。
    assert_eq!(abort_tasks_for_session("s-bg"), 1);
    assert_eq!(abort_tasks_for_session("s-bg"), 0);
    assert_eq!(running_count_for_session("s-bg"), 0);
    assert!(wait_for_notification(&captured, 500).is_none(), "被中止的任务不应发通知");
    reset_for_test();
}

#[test]
fn completing_tasks_fire_the_completed_event() {
    let sandbox = Sandbox::new("bash-task-event");
    let _guard = TmpDirGuard::set(&sandbox.root.join("tmp"));
    reset_for_test();

    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let subscription = on_task_completed(Arc::new(move |task: &FinishedTask| {
        sink.lock().unwrap().push(task.task_id.clone());
    }));

    let captured = Arc::new(Captured::default());
    let task_id = spawn_background(
        "echo done",
        &sandbox.workspace.to_string_lossy(),
        "Echo",
        "s-bg",
        Some(hooks(&captured)),
    )
    .expect("spawn background");
    wait_for_notification(&captured, 10_000).expect("完成通知");

    let deadline = Instant::now() + Duration::from_millis(2000);
    while seen.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(seen.lock().unwrap().as_slice(), std::slice::from_ref(&task_id));

    // 取消订阅后不再收到事件
    off_task_completed(subscription);
    let before = seen.lock().unwrap().len();
    let captured = Arc::new(Captured::default());
    spawn_background(
        "echo again",
        &sandbox.workspace.to_string_lossy(),
        "Echo again",
        "s-bg",
        Some(hooks(&captured)),
    )
    .expect("spawn background");
    wait_for_notification(&captured, 10_000).expect("完成通知");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(seen.lock().unwrap().len(), before);
    reset_for_test();
}

/// 完成收尾的钩子顺序：注册时 `sync`；任务结束时必须 **`notify`（唤醒引擎置
/// running）先于 `sync_background`（清 background）**。顺序反了会先推出一份
/// 「running=false 且 background=false」的瞬时 idle 运行时快照，被宿主差分成
/// running → idle 而误武装「任务完成」绿灯——完成通知触发的接续查询其实还在继续
/// （见 `handle_finish` 的顺序注释；对齐 Embedded 侧
/// `backgroundCompletionOrder.test.ts`）。
#[test]
fn completion_notifies_the_engine_before_clearing_background() {
    let sandbox = Sandbox::new("bash-task-finish-order");
    let _guard = TmpDirGuard::set(&sandbox.root.join("tmp"));
    reset_for_test();

    let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let notify_events = Arc::clone(&events);
    let sync_events = Arc::clone(&events);
    let ordered_hooks = Hooks {
        notify: Arc::new(move |_session_id: &str, _content: &str| {
            notify_events.lock().unwrap().push("notify");
        }),
        sync_background: Arc::new(move |_session_id: &str| {
            sync_events.lock().unwrap().push("sync");
        }),
    };
    spawn_background(
        "echo order",
        &sandbox.workspace.to_string_lossy(),
        "Echo order",
        "s-bg",
        Some(ordered_hooks),
    )
    .expect("spawn background");

    let deadline = Instant::now() + Duration::from_millis(10_000);
    while events.lock().unwrap().len() < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        events.lock().unwrap().as_slice(),
        ["sync", "notify", "sync"].as_slice(),
        "注册时 sync 一次；完成收尾必须 notify 先于 sync_background"
    );
    reset_for_test();
}

/// 后台任务提醒对等测试：与 Embedded 共用 `src/test/fixtures/backgroundReminderParity.json`。
///
/// 对齐 `src/test/backgroundReminderParity.test.ts`：间隔档位（5 / 10 / 20 / 30 / 30…）、
/// 提醒时钟推进（空闲累加 / 暂停不累加 / 一次跨多档）、提醒文案逐字一致、
/// 兜底提醒门槛（距上次访问满 3 分钟）逐条一致。
#[test]
fn background_reminder_parity() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../src/test/fixtures/backgroundReminderParity.json"
    ))
    .expect("parse backgroundReminderParity.json");

    let intervals: Vec<u64> = fixture["intervalsMin"]
        .as_array()
        .expect("intervalsMin")
        .iter()
        .map(|value| value.as_u64().expect("interval"))
        .collect();
    assert_eq!(intervals, BACKGROUND_REMINDER_INTERVALS_MIN.to_vec());

    assert_eq!(
        fixture["fallbackMinIntervalMs"]
            .as_u64()
            .expect("fallbackMinIntervalMs"),
        BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS,
        "兜底门槛的最小提醒间隔与对照表一致"
    );

    assert_eq!(
        fixture["firstLabel"].as_str().expect("firstLabel"),
        background_reminder_interval_label(0)
    );

    for case in fixture["intervalLabelCases"].as_array().expect("intervalLabelCases") {
        let round = case["round"].as_u64().expect("round") as usize;
        assert_eq!(
            background_reminder_interval_min(round),
            case["min"].as_u64().expect("min"),
            "round {round}"
        );
        assert_eq!(
            background_reminder_interval_label(round),
            case["label"].as_str().expect("label"),
            "round {round}"
        );
    }

    for case in fixture["clockCases"].as_array().expect("clockCases") {
        let mut clock = ReminderClock::default();
        for step in case["steps"].as_array().expect("steps") {
            let awake_ms = step["awakeMs"].as_u64().expect("awakeMs");
            let expected: Vec<usize> = step["fired"]
                .as_array()
                .expect("fired")
                .iter()
                .map(|value| value.as_u64().expect("round") as usize)
                .collect();
            assert_eq!(
                advance_reminder_clock(&mut clock, awake_ms),
                expected,
                "case: {}",
                case["name"]
            );
        }
    }

    for case in fixture["textCases"].as_array().expect("textCases") {
        let text = build_background_reminder_text(
            case["taskId"].as_str().expect("taskId"),
            case["description"].as_str().expect("description"),
            case["command"].as_str().expect("command"),
            case["elapsedMs"].as_u64().expect("elapsedMs"),
            case["output"].as_str().expect("output"),
            case["nextIntervalLabel"].as_str().expect("nextIntervalLabel"),
            case["killCommand"].as_str().expect("killCommand"),
        );
        assert_eq!(
            text,
            case["expected"].as_str().expect("expected"),
            "case: {}",
            case["name"]
        );
    }

    // 兜底门槛：now 固定，上次访问时刻按 sinceLastAccessMs 倒推，结果与对照表逐条一致
    let fallback_now_ms: u64 = 10 * 60_000;
    for case in fixture["fallbackQualifyCases"]
        .as_array()
        .expect("fallbackQualifyCases")
    {
        let since_last_access_ms = case["sinceLastAccessMs"]
            .as_u64()
            .expect("sinceLastAccessMs");
        assert_eq!(
            qualifies_fallback_reminder(fallback_now_ms - since_last_access_ms, fallback_now_ms),
            case["expected"].as_bool().expect("expected"),
            "case: {}",
            case["name"]
        );
    }
}

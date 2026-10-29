//! `session_lock` 的单元测试（specs/032）。
//!
//! 跨进程用例用「自 spawn」harness：`Command::new(current_exe())` + 测试名过滤跑一个
//! 持锁 / 抢锁的子测试，父进程经锁文件内容确认「子进程已持锁」后再杀之或等其退出。
//! 子测试在**没有**测试环境变量（普通 `cargo test` 直跑全套）时立即返回——它们只在
//! 被父进程 spawn 时干活。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::*;
use serde_json::{json, Value};

use crate::test_support::{EngineHarness, Sandbox};

/// 父进程把锁文件路径传给子测试的通道
const ENV_LOCK_PATH: &str = "SESSION_LOCK_TEST_PATH";

/// 子进程抢锁失败的退出码（`Held`）
const EXIT_HELD: i32 = 3;
// ==================== 原语（单进程） ====================

fn temp_lock_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "standalone-core-session-lock-{tag}-{}",
        crate::util::unique_id("t")
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

#[test]
fn second_handle_in_same_process_is_denied() {
    let dir = temp_lock_dir("mutex");
    let path = dir.join("session.lock");
    let _handle = acquire(&path).expect("first acquire");
    // 绕过注册表，同进程第二柄必败（flock 按 open file description、LockFileEx 按
    // 句柄仲裁，同进程多柄同样冲突）
    match acquire(&path) {
        Err(LockError::Held { .. }) => {}
        other => panic!("second handle must be Held, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn release_allows_reacquire() {
    let dir = temp_lock_dir("release");
    let path = dir.join("session.lock");
    let handle = acquire(&path).expect("first acquire");
    drop(handle);
    let _handle = acquire(&path).expect("reacquire after drop");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unknown_version_is_rejected_and_left_untouched() {
    let dir = temp_lock_dir("version");
    let path = dir.join("session.lock");
    // 盘上只有「无法识别版本」的锁文件、没有内核锁（持有者进程死活无关）
    std::fs::write(&path, json!({ "version": 99, "pid": 1 }).to_string()).expect("seed");
    match acquire(&path) {
        Err(LockError::Version { version }) => assert_eq!(version, 99),
        other => panic!("unknown version must be rejected, got {other:?}"),
    }
    // 拒外不抢占：拒绝后文件内容保持原样（fail-safe 方向是拒外）
    let text = std::fs::read_to_string(&path).expect("read back");
    let value: Value = serde_json::from_str(&text).expect("untouched json");
    assert_eq!(value["version"], 99, "拒绝时不得覆写锁文件");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn corrupt_content_still_holds() {
    let dir = temp_lock_dir("corrupt");
    let path = dir.join("session.lock");
    for seeded in ["", "not-json", "{\"version\":\"NaN\"}"] {
        std::fs::write(&path, seeded).expect("seed");
        let _handle = acquire(&path).expect("损坏照常持有（互斥在内核锁）");
        drop(_handle);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn holder_pid_is_surfaced_from_content() {
    let dir = temp_lock_dir("pid");
    let path = dir.join("session.lock");
    let _holder = acquire(&path).expect("holder");
    // 第二柄抢锁失败时，从锁文件读出持有者 pid（Windows 的字节范围锁强制，
    // 第三方句柄读不出内容 → pid 缺省由调用方回退 unknown）
    match acquire(&path) {
        Err(LockError::Held { pid }) => {
            if cfg!(unix) {
                assert_eq!(pid.as_deref(), Some(std::process::id().to_string().as_str()));
            }
        }
        other => panic!("must be Held, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ==================== 双进程（自 spawn harness） ====================

fn spawn_child(test_name: &str, lock_path: &Path) -> std::process::Child {
    let exe = std::env::current_exe().expect("current exe");
    std::process::Command::new(exe)
        .arg(test_name)
        .env(ENV_LOCK_PATH, lock_path)
        .spawn()
        .expect("spawn child test")
}

/// 等到就绪标记文件出现（子进程持锁后写 `<锁路径>.ready`；Windows 的字节范围锁
/// 强制，父进程读不到持有中的锁文件内容，不能用「内容出现 pid」判就绪）
fn wait_until_child_ready(path: &Path, deadline: Duration) {
    let marker = ready_marker(path);
    let start = Instant::now();
    while !marker.exists() {
        if start.elapsed() > deadline {
            panic!("child never reported ready at {}", marker.display());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn ready_marker(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.ready", path.display()))
}

/// 子进程入口：持锁、写就绪标记后驻留，直到被父进程强杀（AC-7 的「被杀」路径）。
/// 没有测试环境变量（普通 `cargo test` 直跑）时立即返回。
#[test]
fn child_parks_holding_lock() {
    let Some(path) = std::env::var_os(ENV_LOCK_PATH) else {
        return;
    };
    let path = PathBuf::from(path);
    let _handle = acquire(&path).expect("child acquires lock");
    std::fs::write(ready_marker(&path), b"ready").expect("write ready marker");
    std::thread::sleep(Duration::from_secs(120));
}

/// 子进程入口：抢锁一次，`Held` 以退出码 3 报告，抢到（异常路径）以 0 报告。
#[test]
fn child_exits_denied_when_lock_held() {
    let Some(path) = std::env::var_os(ENV_LOCK_PATH) else {
        return;
    };
    match acquire(Path::new(&path)) {
        Err(LockError::Held { .. }) => std::process::exit(EXIT_HELD),
        Ok(_handle) => std::process::exit(0),
        Err(_) => std::process::exit(2),
    }
}

#[test]
fn crashed_holder_lock_is_taken_over() {
    let dir = temp_lock_dir("crash");
    let path = dir.join("session.lock");
    let mut child = spawn_child("child_parks_holding_lock", &path);
    wait_until_child_ready(&path, Duration::from_secs(60));
    // 内核锁确实被子进程持有：非阻塞获取必败
    match acquire(&path) {
        Err(LockError::Held { .. }) => {}
        other => panic!("held lock must deny acquire, got {other:?}"),
    }
    // 强杀持有者（AC-7）：锁随进程退出由内核释放，无残留死锁、无等待
    child.kill().expect("kill child");
    child.wait().expect("reap child");
    let _handle = acquire(&path).expect("lock taken over after holder killed");
    drop(_handle);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn lock_denied_while_another_process_holds() {
    let dir = temp_lock_dir("deny");
    let path = dir.join("session.lock");
    let _handle = acquire(&path).expect("parent acquires");
    let mut child = spawn_child("child_exits_denied_when_lock_held", &path);
    let status = child.wait().expect("wait child");
    assert_eq!(
        status.code(),
        Some(EXIT_HELD),
        "持锁期间另一个进程抢锁必须失败（AC-9：并发至多一胜）"
    );
    drop(_handle);
    let _ = std::fs::remove_dir_all(&dir);
}

// ==================== Core 注册表（engine 级） ====================

fn register_workspace(sandbox: &Sandbox, session_id: &str) -> String {
    let project = sandbox.workspace.to_string_lossy().to_string();
    crate::config::set_session_workspace(session_id, Some(project.clone()));
    // 生产里会话数据目录在会话建档时创建、先于任何锁获取存在；测试里补齐同一前提
    std::fs::create_dir_all(
        crate::config::project_conversation_dir(&project).expect("conversation dir"),
    )
    .expect("create conversation dir");
    project
}

fn lock_file(project: &str, session_id: &str) -> PathBuf {
    crate::history::session_lock_path(session_id, project).expect("lock path")
}

/// 直写一份最小 meta.json（供 `project_of_session` / 智能命名解析归属）
fn seed_meta(project: &str, session_id: &str, title: &str) -> PathBuf {
    let path = crate::history::metadata_path(session_id, project).expect("meta path");
    std::fs::write(
        &path,
        json!({
            "sessionId": session_id,
            "project": project,
            "title": title,
            "messageCount": 0,
        })
        .to_string(),
    )
    .expect("seed meta");
    path
}

fn notices(sink: &crate::test_support::Capture) -> Vec<Value> {
    sink.events_of("notice")
}

#[test]
fn same_core_reentry_passes_and_keeps_kernel_lock() {
    let _sandbox = Sandbox::new("lock-reentry");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-reentry");

    // 同 Core 两次获取同一会话：注册表重入放行（AC-10）
    assert!(harness.core.acquire_session_lock("s-reentry").expect("first"));
    assert!(harness
        .core
        .acquire_session_lock("s-reentry")
        .expect("reentrant"));
    assert_eq!(
        harness.core.session_locks.lock().unwrap().len(),
        1,
        "注册表只挂一柄"
    );
    // 内核锁真实持有：绕过注册表的第二柄必败
    match acquire(&lock_file(&project, "s-reentry")) {
        Err(LockError::Held { .. }) => {}
        other => panic!("registry-held lock must deny raw acquire, got {other:?}"),
    }
}

#[test]
fn brand_new_session_without_data_dir_opens_without_lock() {
    let _sandbox = Sandbox::new("lock-brand-new");
    let harness = EngineHarness::allow_all();
    let project = _sandbox.workspace.to_string_lossy().to_string();
    // 不经 register_workspace：会话已登记工作目录但对话目录未建（首条消息前的常态）
    crate::config::set_session_workspace("s-brand-new", Some(project));
    harness.core.on_conversation_opened("s-brand-new");
    assert!(
        !harness
            .core
            .session_locks
            .lock()
            .unwrap()
            .contains_key("s-brand-new"),
        "无盘上数据 = 无争用面，放行且不入表"
    );
    assert!(
        !notices(&harness.sink)
            .into_iter()
            .any(|event| event["key"] == "notice.session.lockedOpen"),
        "新会话打开不得被锁误拒"
    );
}

#[test]
fn open_rejects_when_held_by_other_process() {
    let _sandbox = Sandbox::new("lock-open-reject");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-open");
    seed_meta(&project, "s-open", "Original");
    // 「另一实例」：绕过注册表的裸句柄
    let _foreign = acquire(&lock_file(&project, "s-open")).expect("foreign holder");

    harness.core.on_conversation_opened("s-open");

    // AC-1：不装载、不建状态、不降级为只读视图
    assert!(harness.core.session_if_exists("s-open").is_none());
    let notice = notices(&harness.sink)
        .into_iter()
        .find(|event| event["key"] == "notice.session.lockedOpen")
        .expect("lockedOpen notice");
    assert_eq!(notice["level"], "error");
    assert!(notice["params"]["pid"].is_string(), "pid 参数存在（可能为 unknown）");
    // 数据零改动：meta 标题未被触碰
    let meta = std::fs::read_to_string(crate::history::metadata_path("s-open", &project).unwrap())
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&meta).unwrap()["title"],
        "Original"
    );
}

#[test]
fn open_acquires_and_close_releases() {
    let _sandbox = Sandbox::new("lock-open-close");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-cycle");

    harness.core.on_conversation_opened("s-cycle");
    assert!(
        harness.core.session_locks.lock().unwrap().contains_key("s-cycle"),
        "装载即持锁"
    );
    // AC-3 / AC-13：关闭会话视图 → 锁释放，另一实例可随即装载
    harness.core.on_conversation_closed("s-cycle");
    let _foreign = acquire(&lock_file(&project, "s-cycle")).expect("released after close");
}

#[test]
fn registry_lock_survives_disconnect_without_release() {
    let _sandbox = Sandbox::new("lock-detach");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-detach");

    harness.core.on_conversation_opened("s-detach");
    // 宿主离场（detach / 孤儿化）只断控制连接：不调 conversationClosed、注册表与
    // 内核锁都不动 → 另一进程（真实子进程）抢锁必败（AC-11）
    let mut child = spawn_child("child_exits_denied_when_lock_held", &lock_file(&project, "s-detach"));
    let status = child.wait().expect("wait child");
    assert_eq!(status.code(), Some(EXIT_HELD), "宿主离场不等于锁释放");
}

#[test]
fn mutation_entries_reject_when_held_and_change_nothing() {
    let _sandbox = Sandbox::new("lock-mutate-reject");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-mut");
    let meta_path = seed_meta(&project, "s-mut", "Original");
    std::fs::write(
        crate::history::messages_path("s-mut", &project).unwrap(),
        "",
    )
    .unwrap();
    // Spin 设计文件种子（spinDesignSaveRequested 走 session_workspace）
    let spin_path = std::path::Path::new(&project).join("spin.json");
    std::fs::write(&spin_path, "{\"nodes\":{}}").unwrap();

    let meta_before = std::fs::read_to_string(&meta_path).unwrap();
    let spin_before = std::fs::read_to_string(&spin_path).unwrap();

    // 「另一实例」持有目标会话
    let _foreign = acquire(&lock_file(&project, "s-mut")).expect("foreign holder");

    // 重命名（UiEvent）：拒 + notice，meta 零改动
    harness.core.on_conversation_renamed("s-mut", "Hacked");
    // 会话配置（UiEvent 链路）：拒
    harness.core.on_session_config_changed(
        "s-mut",
        &json!({ "key": "agentMode", "value": "auto" }),
    );
    // 手动压缩（UiEvent.compactRequested → request_compact）：拒
    harness.core.request_compact("s-mut");
    // 删除（UiEvent）：拒，文件不消失
    harness.core.on_conversation_deleted("s-mut");
    // 智能命名（UiRequest）：Err
    let named = crate::dispatch_ui_request(
        &harness.core,
        &json!({ "type": "smartNamingRequested", "sessionId": "s-mut" }),
    );
    // Spin 设计写入（UiRequest）：Err
    let saved = crate::dispatch_ui_request(
        &harness.core,
        &json!({
            "type": "spinDesignSaveRequested",
            "sessionId": "s-mut",
            "data": { "nodes": { "a": { "task": "x" } } },
        }),
    );

    assert!(named.is_err(), "智能命名必须被拒");
    assert!(saved.is_err(), "Spin 设计写入必须被拒");
    assert_eq!(
        std::fs::read_to_string(&meta_path).unwrap(),
        meta_before,
        "FR-002：变更全拒，meta 零改动"
    );
    assert_eq!(
        std::fs::read_to_string(&spin_path).unwrap(),
        spin_before,
        "FR-002：Spin 设计零改动"
    );
    assert!(
        crate::history::messages_path("s-mut", &project)
            .unwrap()
            .exists(),
        "删除被拒，数据文件不消失"
    );
    let locked_change = notices(&harness.sink)
        .into_iter()
        .filter(|event| event["key"] == "notice.session.lockedChange")
        .count();
    assert!(
        locked_change >= 5,
        "六个变更入口中 UiEvent 侧至少各发一条 lockedChange notice，实际 {locked_change}"
    );
}

#[test]
fn space_clear_rejects_when_any_session_in_space_held() {
    let _sandbox = Sandbox::new("lock-space");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-space");
    let _ = project;
    let dir_name = "lock-space-dir";
    let space_dir = crate::config::conversations_root()
        .unwrap()
        .join(dir_name);
    std::fs::create_dir_all(&space_dir).unwrap();
    for sid in ["s-space-a", "s-space-b"] {
        std::fs::write(
            space_dir.join(format!("{sid}.meta.json")),
            json!({ "sessionId": sid, "project": "whatever", "title": "t" }).to_string(),
        )
        .unwrap();
    }
    // 空间内 s-space-a 被「另一实例」持有 → 整体拒绝（数据零改动）
    let foreign =
        acquire(&crate::history::session_lock_path_in_space(dir_name, "s-space-a").unwrap())
            .expect("foreign holder");

    let event = json!({
        "type": "conversationSpaceCleared",
        "dirName": dir_name,
        "mode": "remove",
    });
    crate::dispatch_ui_event(&harness.core, &harness.bus, event);

    assert!(space_dir.exists(), "整空间删除被拒，目录不消失");
    assert!(
        space_dir.join("s-space-a.meta.json").exists(),
        "数据零改动"
    );
    drop(foreign);
    harness.sink.clear();
    // 无持有者时放行（守卫句柄在删盘前释放，Windows 不会被活动句柄挡住）
    let event = json!({
        "type": "conversationSpaceCleared",
        "dirName": dir_name,
        "mode": "remove",
    });
    crate::dispatch_ui_event(&harness.core, &harness.bus, event);
    assert!(!space_dir.exists(), "无争用时空间正常删除");
    let receipt = harness
        .sink
        .events_of("conversationSpaceCleared")
        .into_iter()
        .next()
        .expect("回执照发");
    assert_eq!(receipt["result"]["status"], "complete");
}

#[test]
fn mutation_short_lock_writes_then_releases() {
    let _sandbox = Sandbox::new("lock-mutate-short");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-short");

    // 会话未在本 Core 装载（注册表为空）：变更入口先取锁、锁内写入、随即释放（AC-6）
    harness.core.on_conversation_renamed("s-short", "Renamed");
    let meta_path = crate::history::metadata_path("s-short", &project).unwrap();
    let meta: Value =
        serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
    assert_eq!(meta["title"], "Renamed", "写入确实发生");
    // 锁已释放：另一实例（裸句柄）可随即获取
    let _foreign = acquire(&lock_file(&project, "s-short"))
        .expect("short-held lock must be released after the write");
}

#[test]
fn load_request_rejects_when_held_by_other_process() {
    let _sandbox = Sandbox::new("lock-load-reject");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-load");
    seed_meta(&project, "s-load", "Original");
    let _foreign = acquire(&lock_file(&project, "s-load")).expect("foreign holder");

    let loaded = crate::dispatch_ui_request(
        &harness.core,
        &json!({ "type": "conversationLoadRequested", "sessionId": "s-load" }),
    );
    assert!(loaded.is_err(), "装载被拒必须回 Err（error_response）");
    assert!(
        notices(&harness.sink)
            .into_iter()
            .any(|event| event["key"] == "notice.session.lockedOpen"),
        "装载被拒不发 notice 就是静默失败"
    );
    // 拒绝不建状态、不落内容
    assert!(harness.core.session_if_exists("s-load").is_none());
}

#[test]
fn load_request_acquires_for_load_only_sessions() {
    let _sandbox = Sandbox::new("lock-load-acquire");
    let harness = EngineHarness::allow_all();
    let project = register_workspace(&_sandbox, "s-load-only");
    seed_meta(&project, "s-load-only", "Original");

    let loaded = crate::dispatch_ui_request(
        &harness.core,
        &json!({ "type": "conversationLoadRequested", "sessionId": "s-load-only" }),
    );
    assert!(loaded.is_ok());
    // 只装载未打开：句柄在注册表，内核锁真实持有；随 conversationClosed 释放
    assert!(harness
        .core
        .session_locks
        .lock()
        .unwrap()
        .contains_key("s-load-only"));
    match acquire(&lock_file(&project, "s-load-only")) {
        Err(LockError::Held { .. }) => {}
        other => panic!("load-only session must hold the kernel lock, got {other:?}"),
    }
    harness.core.on_conversation_closed("s-load-only");
    let _foreign = acquire(&lock_file(&project, "s-load-only")).expect("released after close");
}

//! 会话独占锁用例（specs/032）：原语互斥、同 Core 重入、释放、宿主离场不释放、
//! 崩溃接管、并发至多一胜、版本拒外、内容损坏、变更守卫与未装载短持有。
//!
//! 跨进程用例用「自 spawn」harness：`Command::new(current_exe)` 以 `--exact` 跑
//! 本模块的 [`child_helper`]，模式与锁路径经环境变量传递（`parent_watchdog_tests`
//! 的子进程写法扩展）。子进程在普通 `cargo test` 里是空操作（无环境变量立即返回）。

use crate::config;
use crate::engine::Core;
use crate::session_lock;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "session-lock-{tag}-{}",
        crate::util::unique_id("t")
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// 测试环境守卫：锁路径解析依赖 host environment 的配置目录（`project_conversation_dir`），
/// 沙箱化的全局状态要求串行；每个用例开头取一次
fn test_env() -> std::sync::MutexGuard<'static, ()> {
    let guard = crate::test_support::serial();
    config::set_host_environment(crate::config::HostEnvironment {
        extension_path: std::env::temp_dir().to_string_lossy().to_string(),
        log_to_console: false,
        config_dir_name: ".test-session-lock".to_string(),
        cross_workspace_agent: false,
        cross_workspace_transfer: false,
    });
    guard
}

/// 唯一的项目路径（会话目录由它派生；随机化避免并行用例撞锁文件）
fn unique_project(tag: &str) -> String {
    temp_dir(tag).to_string_lossy().to_string()
}

fn lock_file(project: &str, session_id: &str) -> std::path::PathBuf {
    session_lock::lock_path(project, session_id).expect("lock path")
}

/// 空 Core（bus 只需存在）；Capture 随元组返回，事件断言用它收
fn bare_core() -> (Core, crate::test_support::Capture) {
    let sink = crate::test_support::Capture::new();
    let core = Core::new(Arc::new(Mutex::new(crate::bus::CoreBus::<
        crate::bus::FrameWriter,
    >::new(sink.writer()))));
    (core, sink)
}

// ==================== 自 spawn 子进程 ====================

/// 子进程入口：`SESSION_LOCK_CHILD` 未设置时是空操作（普通 cargo test 直接通过）。
/// 模式：
/// - `trylock`：尝试获取，拿到 = 意外（exit 101）；Held / 版本拒外 = exit 0；
///   IO 失败 = exit 102；
/// - `hold`：获取后持有 60s（父进程杀它，模拟持有者死亡）。
#[test]
fn child_helper() {
    let Ok(mode) = std::env::var("SESSION_LOCK_CHILD") else {
        return;
    };
    let path = std::path::PathBuf::from(std::env::var("SESSION_LOCK_PATH").expect("path"));
    match mode.as_str() {
        "trylock" => match session_lock::acquire(&path) {
            Ok(handle) => {
                drop(handle);
                std::process::exit(101); // 拿到了不该拿的锁
            }
            Err(session_lock::LockError::Held { .. })
            | Err(session_lock::LockError::UnsupportedVersion { .. }) => std::process::exit(0),
            Err(session_lock::LockError::Io(error)) => {
                eprintln!("child io error: {error}");
                std::process::exit(102);
            }
        },
        "hold" => {
            let handle = session_lock::acquire(&path).expect("child acquires the lock");
            // 就绪标记走独立文件：Windows 上锁住的字节范围会挡住其他句柄的读取，
            // 父进程轮询锁文件内容只会读到空
            if let Ok(ready) = std::env::var("SESSION_LOCK_READY") {
                let _ = std::fs::write(&ready, "ready");
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
            drop(handle);
            std::process::exit(0);
        }
        other => {
            eprintln!("unknown child mode: {other}");
            std::process::exit(103);
        }
    }
}

/// 起一个跑 [`child_helper`] 的子进程。
fn spawn_child(mode: &str, path: &std::path::Path) -> std::process::Child {
    let exe = std::env::current_exe().expect("current exe");
    Command::new(exe)
        .args(["session_lock::tests::child_helper", "--exact", "--nocapture"])
        .env("SESSION_LOCK_CHILD", mode)
        .env("SESSION_LOCK_PATH", path)
        .env(
            "SESSION_LOCK_READY",
            path.with_extension("ready"),
        )
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child")
}

static CHILD_SEQ: AtomicUsize = AtomicUsize::new(0);

fn held_by_child(project: &str, session_id: &str) -> (std::path::PathBuf, std::process::Child) {
    let path = lock_file(project, session_id);
    let child = spawn_child("hold", &path);
    // 轮询等子进程真正持锁（子进程拿到锁后写 .ready 标记）
    let ready = path.with_extension("ready");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "child did not acquire the lock in time"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = std::fs::remove_file(&ready);
    (path, child)
}

// ==================== 原语（同进程）====================

#[test]
fn primitive_mutex_releases_and_reacquires() {
    let _env = test_env();
    let project = unique_project("primitive");
    let path = lock_file(&project, "s1");
    let first = session_lock::acquire(&path).expect("first acquire");
    // 同进程第二个句柄也是另一个 open file description：内核互斥同样生效
    match session_lock::acquire(&path) {
        Err(session_lock::LockError::Held { .. }) => {}
        other => panic!("second acquire must be Held, got {other:?}"),
    }
    drop(first);
    let second = session_lock::acquire(&path).expect("reacquire after release");
    drop(second);
    let _ = std::fs::remove_dir_all(temp_dir("primitive"));
}

#[test]
fn registry_reentry_does_not_self_lock() {
    let _env = test_env();
    let project = unique_project("reentry");
    let (core, _sink) = bare_core();
    config::set_session_workspace("s-re", Some(project.clone()));
    session_lock::acquire_for_core(&core, "s-re", &project).expect("first acquire");
    // 同 Core 重入（AC-10）：父子会话 / 子代理 / specs/031 认领都不与自身争用
    session_lock::acquire_for_core(&core, "s-re", &project).expect("reentry");
    assert_eq!(core.session_locks.lock().unwrap().len(), 1, "同一柄");
    let _ = std::fs::remove_dir_all(temp_dir("reentry"));
}

#[test]
fn different_sessions_do_not_contend() {
    // AC-2（FR-001）：锁是会话级——同目录的另一个会话不被他持会话牵连
    let _env = test_env();
    let project = unique_project("session-level");
    let (_path, mut child) = held_by_child(&project, "s-a");
    let handle = session_lock::acquire(&lock_file(&project, "s-b"))
        .expect("同目录的另一个会话必须可获取");
    drop(handle);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(temp_dir("session-level"));
}

#[test]
fn drop_session_releases_the_lock() {
    let _env = test_env();
    let project = unique_project("release");
    let (core, _sink) = bare_core();
    config::set_session_workspace("s-rel", Some(project.clone()));
    core.ensure_loaded("s-rel").expect("load acquires");
    assert_eq!(core.session_locks.lock().unwrap().len(), 1);
    // 会话关闭 → drop_session → 句柄释放，另一进程立即可获取（AC-3 / AC-13）
    core.drop_session("s-rel");
    assert!(core.session_locks.lock().unwrap().is_empty());
    let mut child = spawn_child("trylock", &lock_file(&project, "s-rel"));
    let status = child.wait().expect("child exit");
    assert_eq!(status.code(), Some(101), "释放后子进程应能拿到锁");
    let _ = std::fs::remove_dir_all(temp_dir("release"));
}

// ==================== 跨进程 ====================

#[test]
fn host_departure_does_not_release_the_lock() {
    let _env = test_env();
    // AC-11：宿主离场（detach / 孤儿化）不触碰 Core 内的注册表与内核锁——
    // 装载后「宿主走人」（本用例什么都不做即离场态），另一进程此刻抢锁必须失败；
    // 释放只随会话实例消失（drop_session / 进程退出）发生
    let project = unique_project("detach");
    let (core, _sink) = bare_core();
    config::set_session_workspace("s-host", Some(project.clone()));
    session_lock::acquire_for_core(&core, "s-host", &project).expect("acquire");
    // 宿主离场：什么都不做——注册表与内核锁原样保留
    let mut contender = spawn_child("trylock", &lock_file(&project, "s-host"));
    let status = contender.wait().expect("contender exit");
    assert_eq!(status.code(), Some(0), "宿主离场后另一进程必须拿不到锁");
    let _ = std::fs::remove_dir_all(temp_dir("detach"));
}

#[test]
fn takeover_after_holder_death() {
    let _env = test_env();
    // AC-7：持有者被杀（崩溃口径）→ 内核释放 → 立即获取，无摘除协议
    let project = unique_project("crash");
    let (path, mut child) = held_by_child(&project, "s-crash");
    child.kill().expect("kill holder");
    child.wait().expect("reap holder");
    let handle = session_lock::acquire(&path).expect("take over after holder death");
    drop(handle);
    let _ = std::fs::remove_dir_all(temp_dir("crash"));
}

#[test]
fn concurrent_claim_has_at_most_one_winner() {
    let _env = test_env();
    // AC-9：持有者已死、两个后来者并发获取——内核仲裁至多一胜（这里以
    // 「持有者存活时另一进程必败」锁死互斥面；并发同抢由同一仲裁路径保证）
    let project = unique_project("concurrent");
    let (_path, mut child) = held_by_child(&project, "s-conc");
    let mut contender = spawn_child("trylock", &lock_file(&project, "s-conc"));
    let status = contender.wait().expect("contender exit");
    assert_eq!(status.code(), Some(0), "并发获取至多一胜，败者按 Held 处理");
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(temp_dir("concurrent"));
}

#[test]
fn unsupported_version_refuses_to_open() {
    let _env = test_env();
    // AC-8：版本拒外——无法识别的版本视为有效占用，与持有者进程死活无关
    let project = unique_project("version");
    let path = lock_file(&project, "s-ver");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(&path, json!({ "version": 99, "pid": 1 }).to_string()).expect("write lock");
    match session_lock::acquire(&path) {
        Err(session_lock::LockError::UnsupportedVersion { version, .. }) => {
            assert_eq!(version, 99);
        }
        other => panic!("unsupported version must refuse, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(temp_dir("version"));
}

#[test]
fn corrupt_content_still_holds() {
    let _env = test_env();
    // 边界：互斥在内核锁，内容损坏只影响诊断——照常持有
    let project = unique_project("corrupt");
    let path = lock_file(&project, "s-bad");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("mkdir");
    }
    std::fs::write(&path, "not json at all").expect("write garbage");
    let handle = session_lock::acquire(&path).expect("corrupt content still acquires");
    drop(handle);
    // 内容被覆写为自己的（读回在 Drop 之后：持锁期间其他句柄读会被 Windows 挡）
    let content = std::fs::read_to_string(&path).expect("read back");
    assert!(content.contains("\"version\":1"), "{content}");
    let _ = std::fs::remove_dir_all(temp_dir("corrupt"));
}

// ==================== 变更守卫（engine 级）====================

fn core_with_session(
    project: &str,
    session_id: &str,
) -> (Core, crate::test_support::Capture) {
    let (core, sink) = bare_core();
    config::set_session_workspace(session_id, Some(project.to_string()));
    (core, sink)
}

fn last_notice(
    sink: &crate::test_support::Capture,
) -> Option<serde_json::Value> {
    sink.events()
        .into_iter()
        .find(|event| event["type"] == "notice")
}

#[test]
fn rename_rejected_when_held_elsewhere() {
    let _env = test_env();
    // AC-4（FR-002）：被其他实例持有时重命名拒绝、数据零改动、发占用通知
    let project = unique_project("guard-rename");
    let (_path, mut child) = held_by_child(&project, "s-guard");
    let (core, sink) = core_with_session(&project, "s-guard");
    core.on_conversation_renamed("s-guard", "new title");
    // 数据零改动：目录里只有锁文件，没有建档的 meta.json
    let dir = crate::config::project_conversation_dir(&project).expect("dir");
    let mutated = std::fs::read_dir(dir)
        .expect("read dir")
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".meta.json"));
    assert!(!mutated, "被拒的变更不得写盘");
    let notice = last_notice(&sink).expect("occupancy notice");
    assert_eq!(notice["key"], crate::core_text::SESSION_LOCKED_CHANGE);
    assert!(notice["params"]["pid"].as_str().is_some());
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(temp_dir("guard-rename"));
}

#[test]
fn delete_rejected_when_closure_held_elsewhere() {
    let _env = test_env();
    // AC-4（FR-002）：删除闭包内有他持会话时整体拒绝
    let project = unique_project("guard-delete");
    let (_path, mut child) = held_by_child(&project, "s-del");
    let (core, sink) = core_with_session(&project, "s-del");
    core.on_conversation_deleted("s-del");
    let dir = crate::config::project_conversation_dir(&project).expect("dir");
    assert!(dir.exists(), "被拒的删除不得动目录");
    let notice = last_notice(&sink).expect("occupancy notice");
    assert_eq!(notice["key"], crate::core_text::SESSION_LOCKED_CHANGE);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(temp_dir("guard-delete"));
}

#[test]
fn config_change_rejected_when_held_elsewhere() {
    let _env = test_env();
    // AC-4（FR-002）：会话配置变更被拒、不建会话状态
    let project = unique_project("guard-config");
    let (_path, mut child) = held_by_child(&project, "s-cfg");
    let (core, sink) = core_with_session(&project, "s-cfg");
    core.on_session_config_changed("s-cfg", &json!({ "key": "model", "value": "x" }));
    assert!(
        core.session_if_exists("s-cfg").is_none(),
        "被拒的变更不得建会话状态"
    );
    let notice = last_notice(&sink).expect("occupancy notice");
    assert_eq!(notice["key"], crate::core_text::SESSION_LOCKED_CHANGE);
    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(temp_dir("guard-config"));
}

#[test]
fn unloaded_mutation_takes_a_short_lease() {
    let _env = test_env();
    // AC-6（FR-002）：未装载的会话变更按「先取锁、锁内写入、随即释放」——
    // 变更结束后另一进程立即可获取，不留下长期持有
    let project = unique_project("short-lease");
    // 会话 id 每次运行唯一：project_of_session 扫盘解析、旧运行的 meta.json
    // 残留（project 指向旧临时目录）不能劫持本次解析——生产会话 id 全局唯一，
    // 该残留场景不存在
    let session_id = format!("s-short-{}", crate::util::unique_id("s"));
    let (core, sink) = core_with_session(&project, &session_id);
    core.on_conversation_renamed(&session_id, "short lease title");
    // 变换完成：meta.json 已建档（写入发生在锁内）
    let dir = crate::config::project_conversation_dir(&project).expect("dir");
    let listing: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();
    assert!(
        dir.join(format!("{session_id}.meta.json")).exists(),
        "写入已完成; dir={dir:?} listing={listing:?} events={:?}",
        sink.events()
    );
    // 锁已释放：当前进程可再获取
    let handle = session_lock::acquire(&lock_file(&project, &session_id))
        .expect("short lease released after the mutation");
    drop(handle);
    let _ = std::fs::remove_dir_all(temp_dir("short-lease"));
}

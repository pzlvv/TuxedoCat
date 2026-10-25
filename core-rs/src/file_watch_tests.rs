//! `file_watch` 单元测试（specs/018 FR-002 / FR-005 / FR-006）。
//!
//! 用真实临时目录 + 真实 `notify`（该模块的职责就是平台文件事件，mock 掉没有意义）；
//! 断言用带超时的轮询，避免固定 sleep 在不同平台上的抖动。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::bus::{CoreBus, FrameWriter};
use crate::engine::SharedBus;
use crate::file_watch::FileWatchRegistry;
use crate::test_support::Capture;
use crate::util;

fn capture_bus() -> (SharedBus, Capture) {
    let capture = Capture::new();
    let bus: SharedBus = Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(capture.writer())));
    (bus, capture)
}

fn temp_workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("core-file-watch-{name}-{}", util::unique_id("t")));
    fs::create_dir_all(&dir).expect("create workspace");
    dir
}

fn wait_for(mut predicate: impl FnMut() -> bool, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if predicate() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    predicate()
}

fn changed_events(capture: &Capture) -> Vec<Value> {
    capture
        .events_of("workspaceFileChanged")
        .into_iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("changed"))
        .collect()
}

fn atomic_replace(target: &Path, content: &str) {
    let temp = target.with_extension("tmp");
    fs::write(&temp, content).expect("write temp");
    // Windows 的 rename 不能覆盖已存在目标；先删再 rename，模拟编辑器的原子保存。
    #[cfg(windows)]
    {
        let _ = fs::remove_file(target);
    }
    fs::rename(&temp, target).expect("rename temp over target");
}

#[test]
fn rejects_path_outside_workspace() {
    let workspace = temp_workspace("outside-workspace");
    let outside = temp_workspace("outside-target").join("note.txt");
    fs::write(&outside, "x").expect("write outside");

    let (bus, _capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    let error = registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            outside.to_str().unwrap(),
        )
        .expect_err("outside path must be rejected");
    assert!(error.contains("escapes the workspace root"), "{error}");

    let _ = fs::remove_dir_all(&workspace);
    let _ = fs::remove_dir_all(outside.parent().unwrap());
}

#[test]
fn watch_missing_target_waits_for_recreate() {
    // 断线期间目标被删后的重注册形态（specs/018 FR-006）：注册要成功且等待重建，
    // 否则 Core 侧永远没有监听、文件重建后查看器停在「自动刷新不可用」。
    let workspace = temp_workspace("missing-target");
    let target = workspace.join("note.txt");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            target.to_str().unwrap(),
        )
        .expect("register watch on missing target");

    fs::write(&target, "created").expect("recreate target");
    assert!(
        wait_for(
            || !changed_events(&capture).is_empty(),
            Duration::from_secs(5)
        ),
        "expected a changed event after recreate"
    );

    registry.unwatch("w1").expect("unwatch");
    let _ = fs::remove_dir_all(&workspace);
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escaping_workspace() {
    // 目标存在时的越界口径不变：符号链接指向根外仍然拒绝。
    let workspace = temp_workspace("symlink-workspace");
    let outside_dir = temp_workspace("symlink-outside");
    let outside = outside_dir.join("real.txt");
    fs::write(&outside, "x").expect("write outside");
    let link = workspace.join("link.txt");
    std::os::unix::fs::symlink(&outside, &link).expect("create symlink");

    let (bus, _capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    let error = registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            link.to_str().unwrap(),
        )
        .expect_err("symlink escaping the workspace must be rejected");
    assert!(error.contains("escapes the workspace root"), "{error}");

    let _ = fs::remove_dir_all(&workspace);
    let _ = fs::remove_dir_all(&outside_dir);
}

#[test]
fn emits_single_changed_after_atomic_save() {
    let workspace = temp_workspace("atomic-save");
    let target = workspace.join("note.txt");
    fs::write(&target, "one").expect("write target");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            target.to_str().unwrap(),
        )
        .expect("register watch");

    atomic_replace(&target, "two");
    assert!(
        wait_for(
            || !changed_events(&capture).is_empty(),
            Duration::from_secs(5)
        ),
        "expected a changed event"
    );
    // 去抖窗口后再确认没有第二条：一次保存只上报一次。
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(changed_events(&capture).len(), 1);
    let event = changed_events(&capture).remove(0);
    assert_eq!(event["watchId"], "w1");
    assert_eq!(event["error"], Value::Null);

    registry.unwatch("w1").expect("unwatch");
    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn emits_deleted_then_changed_after_recreate() {
    let workspace = temp_workspace("delete-recreate");
    let target = workspace.join("note.txt");
    fs::write(&target, "one").expect("write target");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            target.to_str().unwrap(),
        )
        .expect("register watch");

    fs::remove_file(&target).expect("remove target");
    assert!(
        wait_for(
            || capture
                .events_of("workspaceFileChanged")
                .iter()
                .any(|event| event.get("kind").and_then(Value::as_str) == Some("deleted")),
            Duration::from_secs(5)
        ),
        "expected a deleted event"
    );

    fs::write(&target, "two").expect("recreate target");
    assert!(
        wait_for(
            || !changed_events(&capture).is_empty(),
            Duration::from_secs(5)
        ),
        "expected a changed event after recreate"
    );

    registry.unwatch("w1").expect("unwatch");
    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn unwatch_stops_events() {
    let workspace = temp_workspace("unwatch");
    let target = workspace.join("note.txt");
    fs::write(&target, "one").expect("write target");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            target.to_str().unwrap(),
        )
        .expect("register watch");
    registry.unwatch("w1").expect("unwatch");

    fs::write(&target, "two").expect("write after unwatch");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        capture.events_of("workspaceFileChanged").is_empty(),
        "unwatch must stop events"
    );
    // 未知 watchId 幂等。
    registry.unwatch("w1").expect("unwatch is idempotent");

    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn same_watch_id_replaces_previous() {
    let workspace = temp_workspace("replace-watch");
    let first = workspace.join("first.txt");
    let second = workspace.join("second.txt");
    fs::write(&first, "one").expect("write first");
    fs::write(&second, "two").expect("write second");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus.clone(),
            "w1".to_string(),
            workspace.to_str().unwrap(),
            first.to_str().unwrap(),
        )
        .expect("register first");
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            second.to_str().unwrap(),
        )
        .expect("register second");

    fs::write(&first, "three").expect("write first after replace");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        capture.events_of("workspaceFileChanged").is_empty(),
        "replaced watch must stop observing the old file"
    );

    fs::write(&second, "four").expect("write second");
    assert!(
        wait_for(
            || !changed_events(&capture).is_empty(),
            Duration::from_secs(5)
        ),
        "expected a changed event for the new target"
    );
    let event = changed_events(&capture).remove(0);
    assert!(event["path"].as_str().unwrap_or("").ends_with("second.txt"));

    registry.unwatch("w1").expect("unwatch");
    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn watches_directory_children() {
    // 目录目标（文档视图哨兵：`.git` / `.git/refs/heads`）：目录内任何变化都要上报，
    // 目录外的同名 / 其它变化不算。
    let workspace = temp_workspace("dir-target");
    let git_dir = workspace.join(".git");
    fs::create_dir_all(&git_dir).expect("create dir target");
    let index = git_dir.join("index");
    fs::write(&index, "v1").expect("seed child");

    let (bus, capture) = capture_bus();
    let registry = FileWatchRegistry::new();
    registry
        .watch(
            bus,
            "w1".to_string(),
            workspace.to_str().unwrap(),
            git_dir.to_str().unwrap(),
        )
        .expect("register directory watch");

    // 目录外的兄弟文件：不在监听范围内
    fs::write(workspace.join("outside.txt"), "x").expect("write sibling");
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        capture.events_of("workspaceFileChanged").is_empty(),
        "events outside the directory target must not fire"
    );

    // 目录内替换子文件（git 的 index / refs 更新形态）
    atomic_replace(&index, "v2");
    assert!(
        wait_for(
            || !changed_events(&capture).is_empty(),
            Duration::from_secs(5)
        ),
        "expected a changed event for the directory target"
    );
    let event = changed_events(&capture).remove(0);
    assert!(
        event["path"].as_str().unwrap_or("").ends_with(".git"),
        "event path is the directory target itself: {event}"
    );

    registry.unwatch("w1").expect("unwatch");
    let _ = fs::remove_dir_all(&workspace);
}

//! `parent_watchdog` 的单元测试。

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn watchdog_reports_dead_when_probe_says_missing() {
    let calls = Arc::new(AtomicUsize::new(0));
    let dead = Arc::new(AtomicBool::new(false));
    let probe_calls = Arc::clone(&calls);
    let flag = Arc::clone(&dead);

    watch_with(
        move || {
            let n = probe_calls.fetch_add(1, Ordering::SeqCst) + 1;
            // 前两次存活，第三次消失
            n < 3
        },
        Duration::from_millis(1),
        move || flag.store(true, Ordering::SeqCst),
    );

    assert!(dead.load(Ordering::SeqCst), "probe 报死亡时必须回调");
    assert_eq!(calls.load(Ordering::SeqCst), 3, "回调后不再探测");
}

#[test]
fn watchdog_keeps_watching_while_probe_is_alive() {
    let calls = Arc::new(AtomicUsize::new(0));
    let dead = Arc::new(AtomicBool::new(false));
    let probe_calls = Arc::clone(&calls);
    let flag = Arc::clone(&dead);

    watch_with(
        move || {
            let n = probe_calls.fetch_add(1, Ordering::SeqCst) + 1;
            // 第 4 次才消失：验证存活期间不会提前回调
            n < 4
        },
        Duration::from_millis(1),
        move || flag.store(true, Ordering::SeqCst),
    );

    assert!(dead.load(Ordering::SeqCst));
    assert_eq!(calls.load(Ordering::SeqCst), 4);
}

#[cfg(unix)]
#[test]
fn parent_alive_is_false_for_missing_pid() {
    // 超过 Linux pid_max 上限，一定不存在（不能用 u32::MAX：转 i32 会变成 -1，
    // kill(-1, 0) 是「探测全部进程」）
    assert!(!platform::is_alive(999_999_999));
}

#[cfg(unix)]
#[test]
fn parent_alive_is_true_for_own_parent() {
    let parent = platform::parent_pid().expect("unix 上应能取到父进程 PID");
    assert!(platform::is_alive(parent), "自己的父进程必须判为存活");
}

#[cfg(windows)]
#[test]
fn parent_pid_is_available() {
    // 进程快照能定位到自己的条目并取到父 PID
    assert!(platform::parent_pid().is_some());
}

#[cfg(windows)]
#[test]
fn parent_alive_is_false_after_child_exits() {
    let mut child = std::process::Command::new("cmd")
        .args(["/c", "exit"])
        .spawn()
        .expect("spawn cmd");
    let pid = child.id();
    child.wait().expect("wait cmd");
    assert!(!platform::is_alive(pid), "已退出的子进程必须判为死亡");
}

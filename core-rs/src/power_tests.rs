//! `power` 的单元测试：判定纯函数与阻断状态机的幂等性。
//!
//! 不碰真实平台 API：`Guard` 的平台入口是注入的函数指针，测试用替身句柄断言
//! 「申请 / 释放各发生一次」，以及平台入口失败后不再重试。
use super::*;

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

/// 一份运行时快照条目（只填判定读的字段）
fn session(idle: bool) -> Value {
    json!({ "sessionId": "s1", "idle": idle })
}

#[test]
fn should_prevent_sleep_only_when_some_session_is_busy() {
    assert!(!should_prevent_sleep(&[]));
    assert!(!should_prevent_sleep(&[session(true), session(true)]));
    assert!(should_prevent_sleep(&[session(true), session(false)]));
    // 快照形状不对（缺 `idle`）按「不阻断」处理：本函数只回答「有没有非 idle 会话」
    assert!(!should_prevent_sleep(&[json!({ "sessionId": "s1" })]));
}

static STARTS: AtomicUsize = AtomicUsize::new(0);
static DROPS: AtomicUsize = AtomicUsize::new(0);

struct FakeHandle;

impl Drop for FakeHandle {
    fn drop(&mut self) {
        DROPS.fetch_add(1, Ordering::SeqCst);
    }
}

fn start_fake() -> Option<FakeHandle> {
    STARTS.fetch_add(1, Ordering::SeqCst);
    Some(FakeHandle)
}

#[test]
fn guard_acquires_once_while_busy_and_releases_when_idle() {
    let mut guard = Guard::new(start_fake);

    // 重复推送「忙」不重复申请（全量快照高频重复推送）
    guard.sync(true);
    guard.sync(true);
    guard.sync(true);
    assert_eq!(STARTS.load(Ordering::SeqCst), 1);
    assert!(guard.active.is_some());

    // 重复推送「闲」不重复释放
    guard.sync(false);
    guard.sync(false);
    assert_eq!(DROPS.load(Ordering::SeqCst), 1);

    // 再次变忙 → 重新申请
    guard.sync(true);
    assert_eq!(STARTS.load(Ordering::SeqCst), 2);
    guard.sync(false);
    assert_eq!(DROPS.load(Ordering::SeqCst), 2);
}

static FAILED_STARTS: AtomicUsize = AtomicUsize::new(0);

fn start_unavailable() -> Option<FakeHandle> {
    FAILED_STARTS.fetch_add(1, Ordering::SeqCst);
    None
}

#[test]
fn guard_stops_retrying_when_the_platform_entry_fails() {
    let mut guard = Guard::new(start_unavailable);

    guard.sync(true);
    guard.sync(true);
    guard.sync(false);
    guard.sync(true);

    assert_eq!(FAILED_STARTS.load(Ordering::SeqCst), 1);
    assert!(guard.active.is_none());
}

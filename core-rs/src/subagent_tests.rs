//! `subagent` 注册表与并发槽位单测（specs/005）。
//!
//! 两份状态都是进程级静态且 `reset_for_test` 一并清空：用例一律持 `serial()`
//! 互斥，避免并行走底互相踩踏。

use super::*;
use crate::test_support::serial;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn registry_tracks_creator_and_membership() {
    let _guard = serial();
    reset_for_test();
    register("sub_1", "s1");
    register("sub_2", "s1");
    register("sub_3", "s2");

    assert_eq!(creator_of("sub_1").as_deref(), Some("s1"));
    assert_eq!(creator_of("sub_2").as_deref(), Some("s1"));
    assert_eq!(creator_of("sub_3").as_deref(), Some("s2"));
    assert_eq!(creator_of("missing"), None);

    assert!(has_active_for_creator("s1"));
    assert!(has_active_for_creator("s2"));
    assert!(!has_active_for_creator("s3"));

    assert_eq!(list_for_creator("s1"), ["sub_1", "sub_2"]);
    assert_eq!(list_for_creator("s2"), ["sub_3"]);
    assert!(list_for_creator("s3").is_empty());

    // 重复登记同一 id：覆盖而不是追加（对齐 `Map.set`）
    register("sub_1", "s9");
    assert_eq!(creator_of("sub_1").as_deref(), Some("s9"));
    assert_eq!(list_for_creator("s1"), ["sub_2"]);

    unregister("sub_2");
    assert!(!has_active_for_creator("s1"));
    assert_eq!(creator_of("sub_2"), None);

    assert!(created_at("sub_3").is_some());
    assert_eq!(created_at("missing"), None);
    reset_for_test();
}

#[test]
fn generated_ids_use_the_embedded_shape() {
    let id = generate_sub_session_id();
    assert!(id.starts_with("sub_"), "{id}");
    assert_ne!(generate_sub_session_id(), generate_sub_session_id());
}

// ==================== 并发槽位（specs/005） ====================

const CREATOR: &str = "parent-1";

/// 在独立线程取槽位：返回结果接收端与线程句柄（排队用例用它阻塞 acquire）
fn spawn_acquirer(
    creator: &str,
    cancel: Arc<AtomicBool>,
) -> (mpsc::Receiver<bool>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel();
    let creator = creator.to_string();
    let handle = std::thread::spawn(move || {
        let granted = acquire_slot(&creator, &cancel);
        tx.send(granted).expect("接收端存活");
    });
    (rx, handle)
}

/// 主线程占满该创建者的全部槽位
fn hold_all_slots() {
    let cancel = AtomicBool::new(false);
    for _ in 0..SUBAGENT_CONCURRENCY_LIMIT {
        assert!(acquire_slot(CREATOR, &cancel));
    }
}

#[test]
fn direct_take_up_to_limit_then_release() {
    let _guard = serial();
    reset_for_test();
    hold_all_slots();
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 0));
    // 无排队者时释放 = 真正归还
    release_slot(CREATOR);
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT - 1, 0));
    reset_for_test();
}

#[test]
fn release_without_acquire_panics() {
    let _guard = serial();
    reset_for_test();
    let result = std::panic::catch_unwind(|| release_slot(CREATOR));
    assert!(result.is_err(), "未持有却释放必须 panic（配对破坏）");
    reset_for_test();
}

#[test]
fn call_beyond_limit_queues_until_release() {
    let _guard = serial();
    reset_for_test();
    hold_all_slots();
    let (rx, handle) = spawn_acquirer(CREATOR, Arc::new(AtomicBool::new(false)));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 1));
    // 槽位未释放前排队者不得被唤醒
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    release_slot(CREATOR);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)), Ok(true));
    handle.join().unwrap();
    // 预留即转移：active 回到满额
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 0));
    reset_for_test();
}

#[test]
fn waiters_wake_in_fifo_order() {
    let _guard = serial();
    reset_for_test();
    hold_all_slots();
    let mut receivers = Vec::new();
    let mut handles = Vec::new();
    for _ in 0..3 {
        let (rx, handle) = spawn_acquirer(CREATOR, Arc::new(AtomicBool::new(false)));
        receivers.push(rx);
        handles.push(handle);
        // 间隔入队，保证队列顺序与启动顺序一致
        std::thread::sleep(Duration::from_millis(40));
    }
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 3));
    // 逐个释放：最早排队者先获得，其余保持等待
    for i in 0..3 {
        release_slot(CREATOR);
        assert_eq!(
            receivers[i].recv_timeout(Duration::from_secs(2)),
            Ok(true),
            "第 {} 次释放应唤醒第 {} 个排队者（FIFO）",
            i + 1,
            i + 1
        );
        for receiver in receivers.iter().skip(i + 1) {
            assert!(
                receiver.recv_timeout(Duration::from_millis(120)).is_err(),
                "未轮到的排队者不得被唤醒"
            );
        }
    }
    for handle in handles {
        handle.join().unwrap();
    }
    reset_for_test();
}

#[test]
fn cancel_before_acquire_returns_false() {
    let _guard = serial();
    reset_for_test();
    let cancel = AtomicBool::new(true);
    assert!(!acquire_slot(CREATOR, &cancel));
    assert_eq!(slot_stats_for_test(CREATOR), (0, 0));
    reset_for_test();
}

#[test]
fn cancel_while_queued_returns_false() {
    let _guard = serial();
    reset_for_test();
    hold_all_slots();
    let cancel = Arc::new(AtomicBool::new(false));
    let (rx, handle) = spawn_acquirer(CREATOR, Arc::clone(&cancel));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 1));
    // 100ms 轮询内退出等待
    cancel.store(true, Ordering::Relaxed);
    assert_eq!(rx.recv_timeout(Duration::from_secs(2)), Ok(false));
    handle.join().unwrap();
    // 未获预留即出队：active 不变
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 0));
    reset_for_test();
}

#[test]
fn cancelled_queued_call_does_not_block_following_waiter() {
    let _guard = serial();
    reset_for_test();
    hold_all_slots();
    // W1 排队后被取消，W2 继续排队：W1 让出的位置由后续 release 直接给 W2
    let cancel1 = Arc::new(AtomicBool::new(false));
    let (rx1, handle1) = spawn_acquirer(CREATOR, Arc::clone(&cancel1));
    std::thread::sleep(Duration::from_millis(40));
    let (rx2, handle2) = spawn_acquirer(CREATOR, Arc::new(AtomicBool::new(false)));
    std::thread::sleep(Duration::from_millis(40));
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 2));
    cancel1.store(true, Ordering::Relaxed);
    assert_eq!(rx1.recv_timeout(Duration::from_secs(2)), Ok(false));
    handle1.join().unwrap();
    assert_eq!(slot_stats_for_test(CREATOR), (SUBAGENT_CONCURRENCY_LIMIT, 1));
    release_slot(CREATOR);
    assert_eq!(rx2.recv_timeout(Duration::from_secs(2)), Ok(true));
    handle2.join().unwrap();
    reset_for_test();
}

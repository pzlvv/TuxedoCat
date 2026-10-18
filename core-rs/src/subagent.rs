//! 子代理注册表。
//!
//! 记录「子会话 → 创建它的会话」，供三处使用：
//! - `Reply` 工具在未显式给 `targetSessionId` 时反查创建者；
//! - `sessionRuntime` 的 `idle` 判定递归到子代理（子代理在跑 → 父会话不空闲）；
//! - 会话中止 / 关闭时递归覆盖子孙会话。
//!
//! **只注册不注销**（`unregister` 没有任何生产调用方）。
//! 子代理跑完后它自己的 `SessionState` 回到空闲，父会话的 `idle` 也随之恢复；
//! 保留登记是为了让「稍后再中止该会话」仍能覆盖到子代理。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;

struct SubAgentRecord {
    id: String,
    creator_session_id: String,
    created_at: u64,
}

static AGENTS: Mutex<Vec<SubAgentRecord>> = Mutex::new(Vec::new());

/// 登记一个子代理（重复登记同一 id 时覆盖，与 `Map.set` 一致）
pub fn register(id: &str, creator_session_id: &str) {
    let mut agents = AGENTS.lock().unwrap();
    agents.retain(|record| record.id != id);
    agents.push(SubAgentRecord {
        id: id.to_string(),
        creator_session_id: creator_session_id.to_string(),
        created_at: crate::util::now_millis(),
    });
}

/// 注销（当前没有生产调用方，供测试与将来的清理逻辑用）
#[cfg_attr(not(test), allow(dead_code))]
pub fn unregister(id: &str) {
    AGENTS.lock().unwrap().retain(|record| record.id != id);
}

/// 子代理的创建者会话（`Reply` 的默认投递目标）
pub fn creator_of(id: &str) -> Option<String> {
    AGENTS
        .lock()
        .unwrap()
        .iter()
        .find(|record| record.id == id)
        .map(|record| record.creator_session_id.clone())
}

/// 该创建者是否还有活跃子代理（对齐 `hasActiveForCreator`）
#[cfg_attr(not(test), allow(dead_code))]
pub fn has_active_for_creator(creator_session_id: &str) -> bool {
    AGENTS
        .lock()
        .unwrap()
        .iter()
        .any(|record| record.creator_session_id == creator_session_id)
}

/// 该创建者的所有子代理 ID（对齐 `listForCreator`，按登记顺序）
pub fn list_for_creator(creator_session_id: &str) -> Vec<String> {
    AGENTS
        .lock()
        .unwrap()
        .iter()
        .filter(|record| record.creator_session_id == creator_session_id)
        .map(|record| record.id.clone())
        .collect()
}

/// 登记时间（`createdAt`；供展示 / 将来按时间清理）
#[cfg_attr(not(test), allow(dead_code))]
pub fn created_at(id: &str) -> Option<u64> {
    AGENTS
        .lock()
        .unwrap()
        .iter()
        .find(|record| record.id == id)
        .map(|record| record.created_at)
}

// ==================== 并发槽位（specs/005） ====================

/// 同一创建者会话并行子代理上限（`SUBAGENT_CONCURRENCY_LIMIT`，specs/005 子代理条目）。
pub const SUBAGENT_CONCURRENCY_LIMIT: usize = 4;

/// 排队等待者：`granted` 是释放方的预留标记——置位即代表「一个空位已为你保留」，
/// 唤醒者占有（active 不变）或放弃（取消优先，预留顺延给下一个 / 真正归还）。
struct SlotWaiter {
    granted: Mutex<bool>,
    cv: Condvar,
}

impl Default for SlotWaiter {
    fn default() -> Self {
        Self {
            granted: Mutex::new(false),
            cv: Condvar::new(),
        }
    }
}

#[derive(Default)]
struct SlotState {
    /// 当前被持有的槽位数（acquire 成功到 release / 放弃预留之间）
    active: usize,
    /// FIFO 等待队列（含已获预留、尚未唤醒占有的等待者）
    waiters: VecDeque<Arc<SlotWaiter>>,
}

static SLOTS: LazyLock<Mutex<HashMap<String, SlotState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 槽位表的容毒访问：前一个用例 panic 毒化锁后恢复而不是连锁 panic
/// （对齐 `test_support::serial` 的手法）
fn slots() -> std::sync::MutexGuard<'static, HashMap<String, SlotState>> {
    SLOTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 把一个空闲预留顺延给队列中最早尚未获预留的等待者（FIFO）；
/// 无人接手时真正归还（active 减一）。调用方持有 SLOTS 锁。
fn hand_off_reservation(state: &mut SlotState) {
    for waiter in state.waiters.iter() {
        let mut granted = waiter.granted.lock().unwrap();
        if !*granted {
            *granted = true;
            waiter.cv.notify_one();
            return; // 预留转移，active 不变
        }
    }
    state.active -= 1;
}

/// 取一个槽位：有空位且无排队者时立即返回 true（无排队者才直取，保证 FIFO 公平）；
/// 否则入队等待，直到获得预留（true）或取消标记先到（false）。
/// 取消与预留并发时取消优先——已获预留仍先查标记，取消则把预留顺延给下一个排队者。
/// 返回 true 的调用方必须以 `release_slot` 配对，否则槽位泄露。
///
/// 取消侧（引擎线程）不感知队列，等待以 100ms 轮询取消标记实现，
/// 中止延迟在人类操作粒度下可忽略（parity 测试不锁时延）。
pub fn acquire_slot(creator_session_id: &str, cancel: &AtomicBool) -> bool {
    if cancel.load(Ordering::Relaxed) {
        return false;
    }
    let waiter = {
        let mut slots = slots();
        let state = slots
            .entry(creator_session_id.to_string())
            .or_default();
        if state.active < SUBAGENT_CONCURRENCY_LIMIT && state.waiters.is_empty() {
            state.active += 1;
            return true;
        }
        let waiter = Arc::new(SlotWaiter::default());
        state.waiters.push_back(Arc::clone(&waiter));
        waiter
    };
    let mut granted = waiter.granted.lock().unwrap();
    loop {
        if *granted {
            // 锁序约定：动 SLOTS 前先放开 granted（释放方按 SLOTS → granted 加锁）
            drop(granted);
            if cancel.load(Ordering::Relaxed) {
                // 已获预留但取消：预留顺延给下一个，自己出队
                let mut slots = slots();
                if let Some(state) = slots.get_mut(creator_session_id) {
                    state.waiters.retain(|w| !Arc::ptr_eq(w, &waiter));
                    hand_off_reservation(state);
                }
                return false;
            }
            // 占有预留（预留即转移，active 不变），出队
            let mut slots = slots();
            if let Some(state) = slots.get_mut(creator_session_id) {
                state.waiters.retain(|w| !Arc::ptr_eq(w, &waiter));
            }
            return true;
        }
        if cancel.load(Ordering::Relaxed) {
            drop(granted);
            // 未获预留即取消：仅出队（无预留可放弃，active 不变）
            let mut slots = slots();
            if let Some(state) = slots.get_mut(creator_session_id) {
                state.waiters.retain(|w| !Arc::ptr_eq(w, &waiter));
            }
            return false;
        }
        let (guard, _) = waiter
            .cv
            .wait_timeout(granted, Duration::from_millis(100))
            .unwrap();
        granted = guard;
    }
}

/// 释放一个槽位：优先把空位预留给队列中最早尚未获预留的等待者（预留即转移，
/// active 不变）；无排队者时真正归还（active 减一）。
/// 与 `acquire_slot` 成对使用，配对被破坏（未持有却释放）直接 panic，不静默降级。
pub fn release_slot(creator_session_id: &str) {
    let mut slots = slots();
    let state = slots.get_mut(creator_session_id).unwrap_or_else(|| {
        panic!("release_slot: creator {creator_session_id} 没有槽位状态（acquire/release 配对被破坏）")
    });
    if state.active == 0 {
        panic!("release_slot: creator {creator_session_id} 没有在握的槽位（acquire/release 配对被破坏）");
    }
    hand_off_reservation(state);
}

/// 槽位状态快照（测试断言用）：(持有数, 排队数)
#[cfg(test)]
pub fn slot_stats_for_test(creator_session_id: &str) -> (usize, usize) {
    let slots = slots();
    match slots.get(creator_session_id) {
        Some(state) => (state.active, state.waiters.len()),
        None => (0, 0),
    }
}

// ==================== Reply 投递事件 ====================

/// 子代理 Reply 投递事件的监听器（对齐 `tools/bash/NotifyEvents.ts` 的
/// `onAgentReplyDelivered`）。参数是 `(目标会话, 来源子会话, Reply 内容)`。
///
/// 前台 `sleep` 命令只关心前两项（据此在等待期间转入后台）；Spin 的
/// `waitForAgentReply` 需要第三项（Reply 正文参与验收判定）。
pub type ReplyDeliveredListener = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

static REPLY_LISTENERS: Mutex<Vec<(u64, ReplyDeliveredListener)>> = Mutex::new(Vec::new());
static REPLY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 订阅 Reply 投递事件，返回订阅号
pub fn on_reply_delivered(listener: ReplyDeliveredListener) -> u64 {
    let id = REPLY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    REPLY_LISTENERS.lock().unwrap().push((id, listener));
    id
}

/// 取消订阅
pub fn off_reply_delivered(id: u64) {
    REPLY_LISTENERS.lock().unwrap().retain(|(key, _)| *key != id);
}

/// 触发 Reply 投递事件（目标会话、来源子会话、Reply 正文）
pub fn emit_reply_delivered(target_session_id: &str, from_session_id: &str, message: &str) {
    // 先复制监听器列表再回调，回调里可能再次操作订阅表
    let listeners: Vec<ReplyDeliveredListener> = REPLY_LISTENERS
        .lock()
        .unwrap()
        .iter()
        .map(|(_, listener)| Arc::clone(listener))
        .collect();
    for listener in listeners {
        listener(target_session_id, from_session_id, message);
    }
}

/// 生成子会话 ID：`sub_<millis>_<suffix>`（对齐 AgentTool 的 `sub_${Date.now()}_${rand}`）
pub fn generate_sub_session_id() -> String {
    format!("sub_{}_{}", crate::util::now_millis(), crate::util::random_suffix())
}

/// 清空注册表与并发槽位（单测隔离用）
#[cfg(test)]
pub fn reset_for_test() {
    AGENTS.lock().unwrap().clear();
    slots().clear();
}

#[cfg(test)]
#[path = "subagent_tests.rs"]
mod tests;

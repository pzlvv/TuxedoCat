//! 子代理注册表（对齐 Embedded `tools/agent/SubAgentRegistry.ts`）。
//!
//! 记录「子会话 → 创建它的会话」，供三处使用：
//! - `Reply` 工具在未显式给 `targetSessionId` 时反查创建者；
//! - `sessionRuntime` 的 `idle` 判定递归到子代理（子代理在跑 → 父会话不空闲）；
//! - 会话中止 / 关闭时递归覆盖子孙会话。
//!
//! 与 Embedded 一致：**只注册不注销**（`unregister` 在 TS 里没有任何调用方）。
//! 子代理跑完后它自己的 `SessionState` 回到空闲，父会话的 `idle` 也随之恢复；
//! 保留登记是为了让「稍后再中止该会话」仍能覆盖到子代理。

use std::sync::{Arc, Mutex};

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

/// 注销（Embedded 的 `unregister`；当前没有生产调用方，供测试与将来的清理逻辑用）
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

/// 清空注册表（单测隔离用）
#[cfg(test)]
pub fn reset_for_test() {
    AGENTS.lock().unwrap().clear();
}

#[cfg(test)]
#[path = "subagent_tests.rs"]
mod tests;

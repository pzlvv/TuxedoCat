//! 会话列表与运行时状态的宿主缓存（`src/host/ConversationManager.ts` 的单工作区移植）。
//!
//! 两条互相独立的流（docs/architecture/contracts.md 第 4 节）：
//! - 列表：磁盘元数据（title/messageCount），低频，由 `conversationListChanged` 触发
//!   重读（经 `UiRequest.conversationListRequested`，宿主不直接读 core 的磁盘）；
//! - 运行态：idle / waiting 等根事实，高频，由 `sessionRuntimeChanged` 全量推送。
//!
//! 单工作区宿主只有一份列表快照，无多目录的脏标记（那是 Electron 多标签页的 stale-
//! while-revalidate 优化）。

use crate::store::{ConversationSummary, RuntimeState};
use serde_json::Value;

#[derive(Default)]
pub struct ConversationCache {
    list: Vec<ConversationSummary>,
    states: Vec<RuntimeState>,
}

impl ConversationCache {
    pub fn update_list(&mut self, list: Vec<ConversationSummary>) {
        self.list = list;
    }

    pub fn update_states(&mut self, states: Vec<RuntimeState>) {
        self.states = states;
    }

    /// 最近一次会话运行时状态快照（消息排队判定 / 选择框投递判定共用）。
    pub fn states(&self) -> &[RuntimeState] {
        &self.states
    }

    pub fn state_of(&self, session_id: &str) -> Option<&RuntimeState> {
        self.states.iter().find(|state| state.session_id == session_id)
    }
}

/// 解析 `conversationListRequested` 的应答（`ConversationMetadata[]`）。
pub fn parse_conversation_list(value: &Value) -> Vec<ConversationSummary> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|metadata| {
                    let session_id = metadata.get("sessionId").and_then(Value::as_str)?;
                    Some(ConversationSummary {
                        session_id: session_id.to_string(),
                        title: metadata.get("title").and_then(Value::as_str).unwrap_or("（无标题）").to_string(),
                        updated_at: metadata.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0),
                        message_count: metadata.get("messageCount").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_conversation_metadata_list() {
        let list = parse_conversation_list(&json!([
            { "sessionId": "s1", "title": "对话一", "updatedAt": 100, "messageCount": 3 },
            { "sessionId": "s2", "title": "对话二", "updatedAt": 200, "messageCount": 0 },
            { "title": "缺 sessionId，跳过" }
        ]));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].session_id, "s1");
        assert_eq!(list[1].updated_at, 200.0);
    }

    #[test]
    fn empty_or_invalid_payload_yields_empty_list() {
        assert!(parse_conversation_list(&Value::Null).is_empty());
        assert!(parse_conversation_list(&json!("nope")).is_empty());
    }
}

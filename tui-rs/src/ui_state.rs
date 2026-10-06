//! 按会话的 UI 运行时状态（`src/host/SessionUiState.ts` 的移植）。
//!
//! 活动阶段（idle / thinking / text / tool）：切换对话时恢复 thinking 用；
//! 工具并发计数：并发工具全部结束才回到 idle；查询计数：同一会话嵌套 begin/end
//! 去重，保证只发一次 queryBegin/queryEnd 的表现。只保存状态与纯逻辑。

use std::collections::HashMap;

/// 活动阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ActivityPhase {
    #[default]
    Idle,
    Thinking,
    Text,
    Tool,
}

#[derive(Default)]
pub struct SessionUiState {
    activity_phases: HashMap<String, ActivityPhase>,
    active_tool_counts: HashMap<String, usize>,
    query_active_counts: HashMap<String, usize>,
}

impl SessionUiState {
    #[allow(dead_code)] // 测试使用；阶段恢复动画随 conversationLoaded v1 简化
    pub fn activity_phase(&self, session_id: &str) -> ActivityPhase {
        self.activity_phases.get(session_id).copied().unwrap_or(ActivityPhase::Idle)
    }

    /// 进入 thinking 阶段（LLM 思考 / 等待开始）。
    pub fn mark_thinking(&mut self, session_id: &str) {
        self.activity_phases.insert(session_id.to_string(), ActivityPhase::Thinking);
    }

    /// 进入 text 阶段（assistant 文本流式输出）。
    pub fn mark_text(&mut self, session_id: &str) {
        self.activity_phases.insert(session_id.to_string(), ActivityPhase::Text);
    }

    pub fn mark_idle(&mut self, session_id: &str) {
        self.activity_phases.insert(session_id.to_string(), ActivityPhase::Idle);
    }

    /// 工具开始（权限检查 / 工具调用）：递增并发计数并进入 tool 阶段。
    pub fn begin_tool_phase(&mut self, session_id: &str) {
        *self.active_tool_counts.entry(session_id.to_string()).or_insert(0) += 1;
        self.activity_phases.insert(session_id.to_string(), ActivityPhase::Tool);
    }

    /// 工具阶段中（不改变并发计数）。
    pub fn mark_tool_phase(&mut self, session_id: &str) {
        self.activity_phases.insert(session_id.to_string(), ActivityPhase::Tool);
    }

    /// 工具结束：递减并发计数，全部结束后回到 idle；计数为 0 时是重复结束，忽略。
    pub fn end_tool_phase(&mut self, session_id: &str) {
        let count = self.active_tool_counts.get(session_id).copied().unwrap_or(0);
        if count == 0 {
            return;
        }
        if count == 1 {
            self.active_tool_counts.remove(session_id);
            self.activity_phases.insert(session_id.to_string(), ActivityPhase::Idle);
        } else {
            self.active_tool_counts.insert(session_id.to_string(), count - 1);
        }
    }

    /// 查询开始。返回 true 表示这是该会话本轮的第一次 begin。
    pub fn begin_query(&mut self, session_id: &str) -> bool {
        let count = self.query_active_counts.entry(session_id.to_string()).or_insert(0);
        *count += 1;
        *count == 1
    }

    /// 查询结束。返回 true 表示这是该会话本轮的最后一个 end；没有对应的 begin 返回 false。
    pub fn end_query(&mut self, session_id: &str) -> bool {
        let count = self.query_active_counts.get(session_id).copied().unwrap_or(0);
        if count == 0 {
            return false;
        }
        if count == 1 {
            self.query_active_counts.remove(session_id);
            true
        } else {
            self.query_active_counts.insert(session_id.to_string(), count - 1);
            false
        }
    }

    /// 该会话自己的查询是否在跑（收到 queryBegin、尚未收到 queryEnd）。
    ///
    /// 与 activity_phase 的区别：活动阶段在轮次之间会短暂回到 idle（每轮 aiEnd 之后、
    /// 下一次 aiBegin / 工具阶段之前），本方法在整个查询生命周期内恒为 true。不能用
    /// core 的 sessionRuntime.idle——那是「会话非空闲」口径，包含后台子代理 / 压缩。
    pub fn is_query_active(&self, session_id: &str) -> bool {
        self.query_active_counts.get(session_id).copied().unwrap_or(0) > 0
    }

    /// 会话关闭 / 删除：移除该会话的全部 per-session 状态（防长期运行累积）。
    pub fn drop_session(&mut self, session_id: &str) {
        self.activity_phases.remove(session_id);
        self.active_tool_counts.remove(session_id);
        self.query_active_counts.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_counting_deduplicates_nested_begin_end() {
        let mut state = SessionUiState::default();
        assert!(state.begin_query("s1"), "第一次 begin 应发 queryBegin");
        assert!(!state.begin_query("s1"), "嵌套 begin 不重复发");
        assert!(state.is_query_active("s1"));
        assert!(!state.end_query("s1"), "还有未配对的 end");
        assert!(state.end_query("s1"), "最后一次 end 应发 queryEnd");
        assert!(!state.is_query_active("s1"));
        assert!(!state.end_query("s1"), "重复 end 返回 false");
    }

    #[test]
    fn tool_phase_counts_concurrent_calls() {
        let mut state = SessionUiState::default();
        state.begin_tool_phase("s1");
        state.begin_tool_phase("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Tool);
        state.end_tool_phase("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Tool, "并发工具未全部结束仍处于 tool 阶段");
        state.end_tool_phase("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Idle);
        // 计数为 0 的重复结束是 no-op
        state.end_tool_phase("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Idle);
    }

    #[test]
    fn activity_phase_transitions() {
        let mut state = SessionUiState::default();
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Idle);
        state.mark_thinking("s1");
        state.mark_text("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Text);
        state.mark_idle("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Idle);
        state.drop_session("s1");
        assert_eq!(state.activity_phase("s1"), ActivityPhase::Idle);
    }
}

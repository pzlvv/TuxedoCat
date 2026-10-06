//! store reducer 测试：动作序列 → 状态断言（对齐 src/test/tuiStore.test.ts 的覆盖面）。

use super::*;

fn step(state: &TuiState, ids: &mut Ids, action: &Action) -> TuiState {
    reduce(state, ids, action)
}

fn add_user(session_id: &str, content: &str, uuid: Option<&str>) -> Action {
    Action::AddMessage(AddMessageData {
        session_id: session_id.into(),
        role: Some(Role::User),
        content: content.into(),
        message_uuid: uuid.map(str::to_string),
        ..Default::default()
    })
}

#[test]
fn activate_and_empty_states() {
    let mut ids = Ids::new();
    let state = initial_state();
    let state = step(&state, &mut ids, &Action::Local(LocalAction::ActivateSession(Some("s1".into()))));
    assert_eq!(state.active_session_id.as_deref(), Some("s1"));
    // 会话投影只含被打开过 / 收到过消息的会话；激活本身不建
    assert!(active_session(&state).is_none());
    let state = step(&state, &mut ids, &add_user("s1", "hi", None));
    // 空会话投影：配置字段都是等待态（None），不猜默认值
    let session = active_session(&state).unwrap();
    assert!(session.model.is_none() && session.agent_mode.is_none() && session.web_search.is_none());
}

#[test]
fn message_flow_and_stream_convergence() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::Local(LocalAction::ActivateSession(Some("s1".into()))));
    state = step(&state, &mut ids, &add_user("s1", "你好", Some("u1")));
    state = step(&state, &mut ids, &Action::StreamMessage {
        session_id: "s1".into(),
        role: Role::Assistant,
        text: "正在回答".into(),
        stream_id: "blk1".into(),
    });
    state = step(&state, &mut ids, &Action::StreamEnd {
        session_id: "s1".into(),
        role: Role::Assistant,
        accumulated: "正在回答".into(),
        total_tokens: 150.0,
        stream_id: "blk1".into(),
    });

    let session = state.sessions.get("s1").unwrap();
    // 流式定稿与消息追加：同内容相邻去重
    assert_eq!(session.messages.len(), 2);
    assert_eq!(session.messages[1].role, Role::Assistant);
    assert_eq!(session.messages[1].content, "正在回答");
    // token 用量 = input + output（服务端值直接采用）
    assert_eq!(session.context_tokens, 150.0);
    // streamEnd 收敛流式缓冲
    assert!(session.stream.is_none());
}

#[test]
fn stream_end_double_delivery_converges_by_stream_id() {
    // 单轮多块（思考→文字）时序：同一块的 streamEnd 到两条（block_stop 缺 usage +
    // message_delta 带 usage），且两条收尾与另一块交错——按 (role, streamId) 收敛，
    // 不得重复追加（webview 同语义）
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &add_user("s1", "hello", None));
    let stream_end = |role: Role, accumulated: &str, total_tokens: f64, stream_id: &str| Action::StreamEnd {
        session_id: "s1".into(),
        role,
        accumulated: accumulated.into(),
        total_tokens,
        stream_id: stream_id.into(),
    };
    // block_stop：两条流式消息落下
    state = step(&state, &mut ids, &stream_end(Role::Thinking, "想到啦", 0.0, "blk1"));
    state = step(&state, &mut ids, &stream_end(Role::Assistant, "你好！", 0.0, "blk2"));
    // message_delta：带 usage 的收尾，角色与本块交错
    state = step(&state, &mut ids, &stream_end(Role::Thinking, "想到啦", 120.0, "blk1"));
    state = step(&state, &mut ids, &stream_end(Role::Assistant, "你好！", 120.0, "blk2"));

    let session = state.sessions.get("s1").unwrap();
    assert_eq!(session.messages.len(), 3, "同块的第二次 streamEnd 不得追加重复消息");
    assert_eq!(session.messages[1].role, Role::Thinking);
    assert_eq!(session.messages[2].role, Role::Assistant);
    assert_eq!(session.messages[2].content, "你好！");
    // usage 由 message_delta 那条收尾记账
    assert_eq!(session.context_tokens, 120.0);
    assert!(session.stream.is_none());
}

#[test]
fn adjacent_duplicate_messages_not_appended() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &add_user("s1", "hi", None));
    state = step(&state, &mut ids, &add_user("s1", "hi", None));
    assert_eq!(state.sessions["s1"].messages.len(), 1);
}

#[test]
fn tool_card_dedup_and_status_monotonic() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    let card = |status: Option<ToolStatus>| {
        Action::AddMessage(AddMessageData {
            session_id: "s1".into(),
            role: Some(Role::ToolCall),
            tool_name: Some("Bash".into()),
            tool_call_id: Some("t1".into()),
            status,
            ..Default::default()
        })
    };
    state = step(&state, &mut ids, &card(Some(ToolStatus::Normal)));
    state = step(&state, &mut ids, &card(Some(ToolStatus::Running)));
    state = step(&state, &mut ids, &card(Some(ToolStatus::Success)));
    // 迟到的 normal 不能把 success 拉回去
    state = step(&state, &mut ids, &card(Some(ToolStatus::Normal)));
    let messages = &state.sessions["s1"].messages;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].status, ToolStatus::Success);
}

#[test]
fn tool_call_closes_thinking_except_web_search() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::AiBegin { session_id: "s1".into() });
    assert!(state.sessions["s1"].show_thinking);

    let bash = Action::AddMessage(AddMessageData {
        session_id: "s1".into(),
        role: Some(Role::ToolCall),
        tool_name: Some("Bash".into()),
        tool_call_id: Some("t1".into()),
        ..Default::default()
    });
    state = step(&state, &mut ids, &bash);
    assert!(!state.sessions["s1"].show_thinking, "工具调用强制关闭 thinking 动画");

    state = step(&state, &mut ids, &Action::AiBegin { session_id: "s1".into() });
    let web = Action::AddMessage(AddMessageData {
        session_id: "s1".into(),
        role: Some(Role::ToolCall),
        tool_name: Some("WebSearch".into()),
        tool_call_id: Some("t2".into()),
        ..Default::default()
    });
    state = step(&state, &mut ids, &web);
    assert!(state.sessions["s1"].show_thinking, "WebSearch 发生在 LLM 流内，保留动画");
}

#[test]
fn queued_message_cleared_by_uuid() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::QueuedMessage {
        session_id: "s1".into(),
        uuid: Some("u9".into()),
        content: "排队中".into(),
    });
    assert!(state.sessions["s1"].queued.is_some());

    // uuid 不匹配：不清除
    state = step(&state, &mut ids, &add_user("s1", "别的", Some("u8")));
    assert!(state.sessions["s1"].queued.is_some());

    // uuid 配对：清除排队项
    state = step(&state, &mut ids, &add_user("s1", "消费了", Some("u9")));
    assert!(state.sessions["s1"].queued.is_none());
}

#[test]
fn query_end_converges_hanging_stream() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::AiBegin { session_id: "s1".into() });
    state = step(&state, &mut ids, &Action::StreamMessage {
        session_id: "s1".into(),
        role: Role::Thinking,
        text: "想了一半".into(),
        stream_id: "blk1".into(),
    });
    // abort 路径没有 streamEnd，queryEnd 必须收敛悬挂缓冲
    state = step(&state, &mut ids, &Action::QueryEnd { session_id: "s1".into() });
    let session = &state.sessions["s1"];
    assert!(session.stream.is_none() && !session.show_thinking);
}

#[test]
fn conversation_loaded_projects_history() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    let history = vec![
        TuiMessage {
            id: 1,
            role: Role::User,
            content: "问".into(),
            tool_name: None,
            tool_call_id: None,
            status: ToolStatus::Normal,
            context_tokens: 0.0,
            message_uuid: None,
            is_compact_summary: false,
            stream_id: None,
        },
        TuiMessage {
            id: 2,
            role: Role::Assistant,
            content: "答".into(),
            tool_name: None,
            tool_call_id: None,
            status: ToolStatus::Normal,
            context_tokens: 15.0,
            message_uuid: None,
            is_compact_summary: false,
            stream_id: None,
        },
    ];
    state = step(&state, &mut ids, &Action::ConversationLoaded(ConversationLoadedData {
        session_id: "hist".into(),
        messages: history,
        title: Some("历史会话".into()),
        model: Some("m2".into()),
        provider: Some("p2".into()),
        agent_mode: Some("risk".into()),
        thinking_mode: Some("low".into()),
        prompt_mode: Some("normal".into()),
        web_search: Some(false),
        context_tokens: 15.0,
        has_active_query: false,
    }));
    let session = &state.sessions["hist"];
    assert_eq!(session.messages.len(), 2);
    assert_eq!(session.title.as_deref(), Some("历史会话"));
    assert_eq!(session.model.as_deref(), Some("m2"));
    assert_eq!(session.agent_mode.as_deref(), Some("risk"));
    assert_eq!(session.context_tokens, 15.0);
}

#[test]
fn notices_ring_buffer_and_dismiss() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    for index in 0..7 {
        state = step(&state, &mut ids, &Action::Local(LocalAction::Notice {
            text: format!("n{index}"),
            level: NoticeLevel::Info,
        }));
    }
    // 只保留最近 5 条
    assert_eq!(state.notices.len(), 5);
    let first = state.notices[0].id;
    state = step(&state, &mut ids, &Action::Local(LocalAction::DismissNotice(first)));
    assert_eq!(state.notices.len(), 4);
}

#[test]
fn runtime_labels_and_dots() {
    let idle = RuntimeState {
        session_id: "s".into(),
        idle: true,
        waiting: false,
        query_running: false,
        compacting: false,
        background_running: false,
        sub_agent_running: false,
    };
    assert_eq!(idle.label(), "idle");
    assert_eq!(runtime_dot(None), "○");
    let waiting = RuntimeState { waiting: true, idle: false, ..idle.clone() };
    assert_eq!(waiting.label(), "waiting");
    assert_eq!(runtime_dot(Some(&waiting)), "◑");
    let compacting = RuntimeState { compacting: true, idle: false, ..idle };
    assert_eq!(runtime_dot(Some(&compacting)), "◍");
}

#[test]
fn close_conversation_view_only_when_active() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::Local(LocalAction::ActivateSession(Some("s1".into()))));
    state = step(&state, &mut ids, &Action::Local(LocalAction::CloseConversationView("s2".into())));
    assert_eq!(state.active_session_id.as_deref(), Some("s1"));
    state = step(&state, &mut ids, &Action::Local(LocalAction::CloseConversationView("s1".into())));
    assert_eq!(state.active_session_id, None);
}

#[test]
fn balance_update_discards_incomplete_values() {
    let mut ids = Ids::new();
    let mut state = initial_state();
    state = step(&state, &mut ids, &Action::BalanceUpdate {
        total_balance: Some(12.5),
        currency: Some("CNY".into()),
    });
    assert_eq!(state.balance, Some((12.5, "CNY".into())));
    // 获取余额失败时清空余额，避免继续显示旧值
    state = step(&state, &mut ids, &Action::BalanceUpdate { total_balance: None, currency: None });
    assert_eq!(state.balance, None);
}

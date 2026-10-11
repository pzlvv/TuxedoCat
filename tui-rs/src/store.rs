//! TUI 渲染事实的唯一来源（docs/hosts/tui.md 第 4 节；`src/tui/store.ts` 的移植）。
//!
//! 模式对齐 webview 侧的 `src/webview/sessionState.ts`：core 推来的事实经译层
//! （`host.rs`）转成本模块的动作，store 是只读投影——不反推、不猜默认值
//! （docs/architecture/principles.md）；事实未到达用 `None` 表达等待态，不填默认值。
//!
//! 动作里既有译层转发的 core 事实，也有 `Tui:` 前缀的本地动作（激活会话、开关
//! 覆盖层、本地通知）——它们是终端 UI 自己拥有的事实（不来自 core），与 core 事实
//! 同走一个 reducer，保证「一份渲染事实只有一个写入点」。

use std::collections::HashMap;

use serde_json::Value;

// ── 状态形状 ──

/// 消息角色（wire `MessageData.role` 子集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Thinking,
    ToolCall,
    System,
    Assistant,
}

impl Role {
    pub fn parse(value: &str) -> Option<Role> {
        match value {
            "user" => Some(Role::User),
            "thinking" => Some(Role::Thinking),
            "toolcall" => Some(Role::ToolCall),
            "system" => Some(Role::System),
            "assistant" => Some(Role::Assistant),
            _ => None,
        }
    }
}

/// 工具卡片状态；只升不降（success/fail 是终态，迟到的 normal 不回退）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ToolStatus {
    Normal,
    Running,
    Success,
    Fail,
}

impl ToolStatus {
    pub fn parse(value: &str) -> Option<ToolStatus> {
        match value {
            "normal" => Some(ToolStatus::Normal),
            "running" => Some(ToolStatus::Running),
            "success" => Some(ToolStatus::Success),
            "fail" => Some(ToolStatus::Fail),
            _ => None,
        }
    }
}

/// 消息流里的一条（wire `addMessage` / `streamEnd` / 会话加载的共同形状）。
///
/// `context_tokens` / `message_uuid` / `is_compact_summary` 是状态投影的一部分，
/// 渲染层 v1 尚未消费（与 TS store 同口径保留）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TuiMessage {
    pub id: u64,
    pub role: Role,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub status: ToolStatus,
    /// 当前上下文 token 数（input + output；仅 thinking / assistant 携带）
    pub context_tokens: f64,
    /// 用户消息的 uuid（与排队项配对清除）
    pub message_uuid: Option<String>,
    pub is_compact_summary: bool,
    /// 本消息来自的 LLM 块 streamId（仅 streamEnd 落下的 thinking / assistant 有）；
    /// 同一块的第二次 streamEnd（message_delta 带 usage）按它就地收敛，不重复追加
    pub stream_id: Option<String>,
}

/// 流式缓冲：streamMessage 累积、streamEnd / queryEnd 收敛。
#[derive(Debug, Clone)]
pub struct StreamBlock {
    pub role: Role, // Thinking | Assistant
    pub text: String,
    /// 本块的 streamId（wire `streamMessage.streamId`）；streamEnd 按它精确收敛
    pub stream_id: String,
}

/// 会话级投影（每会话一份；只在会话被打开 / 收到消息时存在）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SessionState {
    pub session_id: String,
    pub title: Option<String>,
    pub messages: Vec<TuiMessage>,
    pub stream: Option<StreamBlock>,
    pub show_thinking: bool,
    pub queued: Option<QueuedMessage>,
    pub context_tokens: f64,
    /// 会话配置（None = 事实未到达，显示等待态，不猜默认值）
    pub model: Option<String>,
    pub provider: Option<String>,
    pub agent_mode: Option<String>,
    pub thinking_mode: Option<String>,
    pub prompt_mode: Option<String>,
    pub web_search: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct QueuedMessage {
    pub uuid: Option<String>,
    pub content: String,
}

/// 瞬时提示（core notice 翻译后的文本 / TUI 本地提示）。
#[derive(Debug, Clone)]
pub struct Notice {
    pub id: u64,
    pub text: String,
    pub level: NoticeLevel,
    pub at_ms: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Warn,
    Error,
}

impl NoticeLevel {
    pub fn parse(value: &str) -> NoticeLevel {
        match value {
            "warn" => NoticeLevel::Warn,
            "error" => NoticeLevel::Error,
            _ => NoticeLevel::Info,
        }
    }
}

/// 待回答的用户选择 / 权限确认。
#[derive(Debug, Clone)]
pub struct PendingChoice {
    pub session_id: String,
    pub choice_id: String,
    pub tool_name: String,
    pub message: String,
    pub choices: Vec<ChoiceItem>,
}

#[derive(Debug, Clone)]
pub struct ChoiceItem {
    pub label: String,
    pub description: Option<String>,
}

/// 全屏只读覆盖层（虚拟文档 / diff；带色行由宿主层组装）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Overlay {
    pub kind: OverlayKind,
    pub title: String,
    pub lines: Vec<OverlayLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayKind {
    #[allow(dead_code)] // 虚拟文档覆盖层（showVirtualDocument 通路，TUI v1 未触发）
    Document,
    Diff,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayLine {
    pub text: String,
    pub color: OverlayColor,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayColor {
    Green,
    Red,
    Cyan,
    Yellow,
    Gray,
    White,
}

/// 会话列表条目（磁盘元数据投影）。
#[derive(Debug, Clone)]
pub struct ConversationSummary {
    pub session_id: String,
    pub title: String,
    pub updated_at: f64,
    pub message_count: u64,
}

/// 会话运行时状态（core `SessionRuntimeState` 的根事实；`idle` 是其余的合取）。
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeState {
    pub session_id: String,
    pub idle: bool,
    pub waiting: bool,
    pub query_running: bool,
    pub compacting: bool,
    pub background_running: bool,
    pub sub_agent_running: bool,
}

impl RuntimeState {
    pub fn from_value(value: &Value) -> Option<RuntimeState> {
        let object = value.as_object()?;
        let flag = |key: &str| object.get(key).and_then(Value::as_bool).unwrap_or(false);
        Some(RuntimeState {
            session_id: object.get("sessionId")?.as_str()?.to_string(),
            idle: flag("idle"),
            waiting: flag("waiting"),
            query_running: flag("queryRunning"),
            compacting: flag("compacting"),
            background_running: flag("backgroundRunning"),
            sub_agent_running: flag("subAgentRunning"),
        })
    }

    /// 运行态 → 状态栏 / abort 语义的展示名（对齐侧栏流水灯的词汇）。
    pub fn label(&self) -> &'static str {
        if self.compacting {
            "compacting"
        } else if self.sub_agent_running {
            "subagent"
        } else if self.background_running {
            "background"
        } else if self.query_running {
            "running"
        } else if self.waiting {
            "waiting"
        } else {
            "idle"
        }
    }
}

/// 技能 / 斜杠命令条目。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SkillItem {
    pub name: String,
    pub description: String,
    pub is_builtin: bool,
}

/// 模型菜单数据（settings.json 的 provider 投影）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ModelsState {
    pub providers: Vec<(String, Vec<String>)>,
    pub active_provider: String,
}

/// settings.json 的会话级默认值；None = 未到达（启动期转圈）。
///
/// 除 model 外的字段 v1 渲染未消费（新会话默认值由 core 沿用，与 TS store 同口径）。
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SettingsDefaults {
    pub model: String,
    pub provider: Option<String>,
    pub thinking_mode: Option<String>,
    pub agent_mode: Option<String>,
    pub prompt_mode: Option<String>,
    pub web_search: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct TuiState {
    /// 会话投影表（key = sessionId）；只含被打开过 / 收到过消息的会话
    pub sessions: HashMap<String, SessionState>,
    pub active_session_id: Option<String>,
    pub conversations: Vec<ConversationSummary>,
    pub runtime_states: Vec<RuntimeState>,
    pub notices: Vec<Notice>,
    pub settings_defaults: Option<SettingsDefaults>,
    pub models: Option<ModelsState>,
    pub skills: Vec<SkillItem>,
    pub mcp_servers: Option<Vec<(String, bool)>>,
    pub pending_choice: Option<PendingChoice>,
    pub overlay: Option<Overlay>,
    pub max_context_tokens: Option<f64>,
    pub balance: Option<(f64, String)>,
}

// ── 动作 ──

/// 终端 UI 自己拥有的事实（不来自 core，不进 wire 协议）。
#[derive(Debug, Clone)]
pub enum LocalAction {
    ActivateSession(Option<String>),
    /// 只在正查看该会话时切出（回到「选择 / 新建」空态）；其余情况无显示变化。
    /// TUI 单视图没有视图关闭事件，v1 未触发（契约动作保留）。
    #[allow(dead_code)]
    CloseConversationView(String),
    Notice { text: String, level: NoticeLevel },
    DismissNotice(u64),
    ShowOverlay(Overlay),
    CloseOverlay,
    /// 待答的选择框随 core 断开一起消失（core 重启后会重新请求）
    ClearPendingChoice,
}

/// reducer 的输入：core 事实（译层转发）+ 本地动作。
#[derive(Debug, Clone)]
pub enum Action {
    Local(LocalAction),

    // ===== 消息流 =====
    AddMessage(AddMessageData),
    StreamMessage { session_id: String, role: Role, text: String, stream_id: String },
    StreamEnd { session_id: String, role: Role, accumulated: String, total_tokens: f64, stream_id: String },
    ShowThinkingAnimation { session_id: String, show: bool },
    AiBegin { session_id: String },
    AiEnd { session_id: String },
    QueryEnd { session_id: String },
    UpdateToolStatus { session_id: String, tool_call_id: String, status: Option<ToolStatus>, output: Option<String> },
    ToolProgress { session_id: String, tool_call_id: String, output: String },

    // ===== 排队 =====
    QueuedMessage { session_id: String, uuid: Option<String>, content: String },
    ClearQueuedMessage { session_id: String },

    // ===== 会话生命周期 =====
    ConversationLoaded(ConversationLoadedData),
    MessagesReplaced { session_id: String, messages: Vec<TuiMessage> },
    SetTitle { session_id: String, title: String },
    SmartNamingResult { session_id: String, title: String },
    ConversationsData(Vec<ConversationSummary>),
    SessionRuntimeStates(Vec<RuntimeState>),

    // ===== 用户选择 / 权限确认 =====
    RequestUserChoice(PendingChoice),

    // ===== 配置面 =====
    SettingsDefaults(SettingsDefaults),
    SetModels(ModelsState),
    SetSkills(Vec<SkillItem>),
    SetMcpServers(Vec<(String, bool)>),
    ContextLimitUpdated(f64),
    BalanceUpdate { total_balance: Option<f64>, currency: Option<String> },

    // ===== 会话配置确认（core 收敛结果广播） =====
    SetModel { session_id: String, model: String, provider: Option<String> },
    SetAgentMode { session_id: String, mode: String },
    SetThinkingMode { session_id: String, mode: String },
    SetPromptMode { session_id: String, mode: String },
    SetWebSearch { session_id: String, enabled: bool },
}

/// wire `addMessage` 的投影字段（译层从 MessageData / 乐观回显构造）。
#[derive(Debug, Clone, Default)]
pub struct AddMessageData {
    pub session_id: String,
    pub role: Option<Role>,
    pub content: String,
    pub tool_name: Option<String>,
    pub tool_call_id: Option<String>,
    pub status: Option<ToolStatus>,
    pub context_tokens: f64,
    pub output_tokens: f64,
    pub message_uuid: Option<String>,
    pub is_compact_summary: bool,
}

/// `conversationLoaded` 的投影字段（译层已完成 raw 历史 → 消息列表的映射）。
#[derive(Debug, Clone)]
pub struct ConversationLoadedData {
    pub session_id: String,
    pub messages: Vec<TuiMessage>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    pub agent_mode: Option<String>,
    pub thinking_mode: Option<String>,
    pub prompt_mode: Option<String>,
    pub web_search: Option<bool>,
    pub context_tokens: f64,
    pub has_active_query: bool,
}

// ── 初始状态与工具 ──

pub fn initial_state() -> TuiState {
    TuiState::default()
}

/// id 发放器（消息 / 提示的全局序号；帧率约束下的渲染 key）。
#[derive(Default)]
pub struct Ids {
    next_message_id: u64,
    next_notice_id: u64,
}

impl Ids {
    pub fn new() -> Self {
        Self::default()
    }
    fn next_message(&mut self) -> u64 {
        self.next_message_id += 1;
        self.next_message_id
    }
    fn next_notice(&mut self) -> u64 {
        self.next_notice_id += 1;
        self.next_notice_id
    }
    /// 消息序号（host 侧历史映射使用；reducer 内部走 next_message）。
    pub fn next_message_id(&mut self) -> u64 {
        self.next_message()
    }
}

fn empty_session(session_id: &str) -> SessionState {
    SessionState {
        session_id: session_id.to_string(),
        title: None,
        messages: Vec::new(),
        stream: None,
        show_thinking: false,
        queued: None,
        context_tokens: 0.0,
        model: None,
        provider: None,
        agent_mode: None,
        thinking_mode: None,
        prompt_mode: None,
        web_search: None,
    }
}

/// 工具卡片状态只升不降（success/fail 是终态，迟到的 normal 不回退）。
fn status_rank(status: ToolStatus) -> u8 {
    match status {
        ToolStatus::Normal => 0,
        ToolStatus::Running => 1,
        ToolStatus::Success | ToolStatus::Fail => 2,
    }
}

fn now_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn push_notice(state: &TuiState, ids: &mut Ids, text: String, level: NoticeLevel) -> TuiState {
    let mut notices = state.notices.clone();
    notices.push(Notice { id: ids.next_notice(), text, level, at_ms: now_ms() });
    // 只保留最近 5 条（旧提示不再占行；UI 层再按时效消散）
    if notices.len() > 5 {
        notices.drain(..notices.len() - 5);
    }
    TuiState { notices, ..state.clone() }
}

/// reducer。纯函数：状态 + 动作 → 新状态；未知动作在译层就不会产生，
/// 这里不做丢弃分支（与 TS 的 `'unhandled'` 相比，Rust 的动作枚举本身就是封闭词汇表）。
pub fn reduce(state: &TuiState, ids: &mut Ids, action: &Action) -> TuiState {
    match action {
        // ===== 本地动作 =====
        Action::Local(local) => match local {
            LocalAction::ActivateSession(session_id) => {
                TuiState { active_session_id: session_id.clone(), ..state.clone() }
            }
            LocalAction::CloseConversationView(session_id) => {
                // 只在正查看该会话时切出（回到「选择 / 新建」空态）；其余情况无显示变化
                if state.active_session_id.as_deref() == Some(session_id.as_str()) {
                    TuiState { active_session_id: None, ..state.clone() }
                } else {
                    state.clone()
                }
            }
            LocalAction::Notice { text, level } => push_notice(state, ids, text.clone(), *level),
            LocalAction::DismissNotice(id) => {
                let mut next = state.clone();
                next.notices.retain(|notice| notice.id != *id);
                next
            }
            LocalAction::ShowOverlay(overlay) => TuiState { overlay: Some(overlay.clone()), ..state.clone() },
            LocalAction::CloseOverlay => TuiState { overlay: None, ..state.clone() },
            LocalAction::ClearPendingChoice => TuiState { pending_choice: None, ..state.clone() },
        },

        // ===== 消息流 =====
        Action::AddMessage(data) => reduce_add_message(state, ids, data),
        Action::StreamMessage { session_id, role, text, stream_id } => {
            with_session(state, session_id, |session| {
                session.stream = Some(StreamBlock {
                    role: *role,
                    text: text.clone(),
                    stream_id: stream_id.clone(),
                });
            })
        }
        Action::StreamEnd { session_id, role, accumulated, total_tokens, stream_id } => {
            with_session(state, session_id, |session| {
                // 流式缓冲按 (role, streamId) 收敛：只有本块自己的收尾才清掉，
                // 跨块 / 跨角色的迟到收尾不误清别的块
                let converged = matches!(
                    session.stream.as_ref(),
                    Some(stream) if stream.role == *role && stream.stream_id == *stream_id
                );
                if converged {
                    session.stream = None;
                }
                // 同一块的 streamEnd 到两条（block_stop 一条 usage 缺省 + message_delta
                // 一条带 usage）：按 (role, streamId) 匹配本块已落的消息就地收敛，不重复
                // 追加。相邻同内容去重在多块轮次（思考→文字）里会失效——message_delta
                // 的两条收尾与 block_stop 落下的消息角色交错，比对「最后一条」必然失配
                // （对齐 webview 的 streamId + role 精确匹配语义）。
                if let Some(index) = session.messages.iter().rposition(|message| {
                    message.role == *role && message.stream_id.as_deref() == Some(stream_id.as_str())
                }) {
                    let existing = &session.messages[index];
                    session.messages[index] = TuiMessage {
                        content: accumulated.clone(),
                        ..existing.clone()
                    };
                } else {
                    let last = session.messages.last();
                    let duplicate = matches!(last, Some(message)
                        if message.role == *role && message.content == *accumulated);
                    if !duplicate {
                        session.messages.push(TuiMessage {
                            stream_id: Some(stream_id.clone()),
                            ..message_from_wire(ids, *role, accumulated, None, None, None, *total_tokens, None, false)
                        });
                    }
                }
                if *total_tokens > 0.0 {
                    session.context_tokens = *total_tokens;
                }
            })
        }
        Action::ShowThinkingAnimation { session_id, show } => {
            with_session(state, session_id, |session| {
                session.show_thinking = *show;
            })
        }
        Action::AiBegin { session_id } => with_session(state, session_id, |session| {
            session.show_thinking = true;
        }),
        Action::AiEnd { session_id } => with_session(state, session_id, |session| {
            session.show_thinking = false;
            session.stream = None;
        }),
        Action::QueryEnd { session_id } => {
            // abort 等路径没有 streamEnd：收敛悬挂的流式缓冲，避免永久「转圈」
            with_session(state, session_id, |session| {
                session.stream = None;
                session.show_thinking = false;
            })
        }
        Action::UpdateToolStatus { session_id, tool_call_id, status, output } => {
            with_session(state, session_id, |session| {
                let Some(index) = session.messages.iter().position(|message| {
                    message.role == Role::ToolCall && message.tool_call_id.as_deref() == Some(tool_call_id.as_str())
                }) else {
                    return;
                };
                let existing = &session.messages[index];
                // 状态只升不降：迟到的 normal 不能把 success/fail 拉回去
                let next_status = match status {
                    Some(next) if status_rank(*next) >= status_rank(existing.status) => *next,
                    _ => existing.status,
                };
                session.messages[index] = TuiMessage {
                    status: next_status,
                    content: output.clone().unwrap_or_else(|| existing.content.clone()),
                    ..existing.clone()
                };
            })
        }
        Action::ToolProgress { session_id, tool_call_id, output } => {
            with_session(state, session_id, |session| {
                if let Some(index) = session.messages.iter().position(|message| {
                    message.role == Role::ToolCall && message.tool_call_id.as_deref() == Some(tool_call_id.as_str())
                }) {
                    session.messages[index].content = output.clone();
                }
            })
        }

        // ===== 排队 =====
        Action::QueuedMessage { session_id, uuid, content } => {
            with_session(state, session_id, |session| {
                session.queued = Some(QueuedMessage { uuid: uuid.clone(), content: content.clone() });
            })
        }
        Action::ClearQueuedMessage { session_id } => with_session(state, session_id, |session| {
            session.queued = None;
        }),

        // ===== 会话生命周期 =====
        Action::ConversationLoaded(data) => with_session(state, &data.session_id, |session| {
            session.messages = data.messages.clone();
            session.stream = None;
            session.show_thinking = data.has_active_query;
            if let Some(title) = &data.title {
                session.title = Some(title.clone());
            }
            session.model = data.model.clone().or_else(|| session.model.clone());
            session.provider = data.provider.clone().or_else(|| session.provider.clone());
            session.agent_mode = data.agent_mode.clone().or(session.agent_mode.clone());
            session.thinking_mode = data.thinking_mode.clone();
            session.prompt_mode = data.prompt_mode.clone();
            session.web_search = data.web_search;
            session.context_tokens = data.context_tokens;
        }),
        Action::MessagesReplaced { session_id, messages } => with_session(state, session_id, |session| {
            session.messages = messages.clone();
        }),
        Action::SetTitle { session_id, title } => with_session(state, session_id, |session| {
            session.title = Some(title.clone());
        }),
        Action::SmartNamingResult { session_id, title } => with_session(state, session_id, |session| {
            session.title = Some(title.clone());
        }),
        Action::ConversationsData(conversations) => {
            TuiState { conversations: conversations.clone(), ..state.clone() }
        }
        Action::SessionRuntimeStates(states) => {
            TuiState { runtime_states: states.clone(), ..state.clone() }
        }

        // ===== 用户选择 / 权限确认 =====
        Action::RequestUserChoice(choice) => {
            TuiState { pending_choice: Some(choice.clone()), ..state.clone() }
        }

        // ===== 配置面 =====
        Action::SettingsDefaults(defaults) => {
            TuiState { settings_defaults: Some(defaults.clone()), ..state.clone() }
        }
        Action::SetModels(models) => TuiState { models: Some(models.clone()), ..state.clone() },
        Action::SetSkills(skills) => TuiState { skills: skills.clone(), ..state.clone() },
        Action::SetMcpServers(servers) => {
            TuiState { mcp_servers: Some(servers.clone()), ..state.clone() }
        }
        Action::ContextLimitUpdated(max) => {
            TuiState { max_context_tokens: Some(*max), ..state.clone() }
        }
        Action::BalanceUpdate { total_balance, currency } => {
            TuiState {
                balance: match (total_balance, currency) {
                    (Some(total), Some(currency)) => Some((*total, currency.clone())),
                    _ => None,
                },
                ..state.clone()
            }
        }

        // ===== 会话配置确认（core 收敛结果广播） =====
        Action::SetModel { session_id, model, provider } => with_session(state, session_id, |session| {
            session.model = Some(model.clone());
            if provider.is_some() {
                session.provider = provider.clone();
            }
        }),
        Action::SetAgentMode { session_id, mode } => with_session(state, session_id, |session| {
            session.agent_mode = Some(mode.clone());
        }),
        Action::SetThinkingMode { session_id, mode } => with_session(state, session_id, |session| {
            session.thinking_mode = Some(mode.clone());
        }),
        Action::SetPromptMode { session_id, mode } => with_session(state, session_id, |session| {
            session.prompt_mode = Some(mode.clone());
        }),
        Action::SetWebSearch { session_id, enabled } => with_session(state, session_id, |session| {
            session.web_search = Some(*enabled);
        }),
    }
}

fn reduce_add_message(state: &TuiState, ids: &mut Ids, data: &AddMessageData) -> TuiState {
    let session_id = &data.session_id;
    let mut next = state.clone();

    // 排队消息被后端消费后按 uuid 清除（在会话过滤之前，别的会话也要清）
    if data.role == Some(Role::User) {
        if let Some(uuid) = &data.message_uuid {
            if let Some(session) = state.sessions.get(session_id) {
                if session.queued.as_ref().map(|queued| &queued.uuid) == Some(&Some(uuid.clone())) {
                    if let Some(session) = next.sessions.get_mut(session_id) {
                        session.queued = None;
                    }
                }
            }
        }
    }

    with_session(&next, session_id, |session| {
        // 工具卡片按 toolCallId 去重（历史恢复已建卡片时，实时 addMessage 就地更新）
        if data.role == Some(Role::ToolCall) {
            if let Some(tool_call_id) = &data.tool_call_id {
                if let Some(index) = session.messages.iter().position(|message| {
                    message.role == Role::ToolCall && message.tool_call_id.as_deref() == Some(tool_call_id.as_str())
                }) {
                    let existing = session.messages[index].clone();
                    let status = match data.status {
                        Some(next) if status_rank(next) >= status_rank(existing.status) => next,
                        _ => existing.status,
                    };
                    session.messages[index] = TuiMessage {
                        content: if data.content.is_empty() { existing.content.clone() } else { data.content.clone() },
                        status,
                        ..existing
                    };
                    // 工具调用强制关闭 thinking 动画（WebSearch 例外：发生在 LLM 流内，保留动画）
                    if is_tool_call(data) && !is_web_search(data) {
                        session.show_thinking = false;
                    }
                    return;
                }
            }
        }

        // 流式定稿（streamEnd）与持久化回放（addMessage）可能相邻重复：同角色同内容且
        // 紧邻时不再追加（与 TS store 的相邻去重同语义）
        let candidate_role = data.role.unwrap_or(Role::System);
        let last = session.messages.last();
        let duplicate = matches!(last, Some(message)
            if message.role == candidate_role && message.content == data.content);
        if !duplicate {
            let context_tokens = data.context_tokens + data.output_tokens;
            session.messages.push(message_from_wire(
                ids,
                candidate_role,
                &data.content,
                data.tool_name.clone(),
                data.tool_call_id.clone(),
                data.status,
                context_tokens,
                data.message_uuid.clone(),
                data.is_compact_summary,
            ));
        }
        // token 用量：input + output（服务端值直接采用，不取 max——压缩后数值会变小）
        let context_tokens = data.context_tokens + data.output_tokens;
        if context_tokens > 0.0 {
            session.context_tokens = context_tokens;
        }
        // 工具调用强制关闭 thinking 动画（WebSearch 例外：发生在 LLM 流内，保留动画）
        if is_tool_call(data) && !is_web_search(data) {
            session.show_thinking = false;
        }
    })
}

fn is_tool_call(data: &AddMessageData) -> bool {
    data.role == Some(Role::ToolCall)
}

fn is_web_search(data: &AddMessageData) -> bool {
    data.tool_name
        .as_deref()
        .unwrap_or("")
        .to_lowercase()
        .replace(['-', '_'], "")
        == "websearch"
}

#[allow(clippy::too_many_arguments)]
fn message_from_wire(
    ids: &mut Ids,
    role: Role,
    content: &str,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    status: Option<ToolStatus>,
    context_tokens: f64,
    message_uuid: Option<String>,
    is_compact_summary: bool,
) -> TuiMessage {
    TuiMessage {
        id: ids.next_message(),
        role,
        content: content.to_string(),
        tool_name,
        tool_call_id,
        status: status.unwrap_or(ToolStatus::Normal),
        context_tokens,
        message_uuid,
        is_compact_summary,
        // addMessage 通路不带 streamId；streamEnd 落下的消息由调用方补上
        stream_id: None,
    }
}

/// 就地会话写入（不存在则先建空会话）。
fn with_session(state: &TuiState, session_id: &str, mutate: impl FnOnce(&mut SessionState)) -> TuiState {
    let mut next = state.clone();
    let mut session = next.sessions.get(session_id).cloned().unwrap_or_else(|| empty_session(session_id));
    mutate(&mut session);
    next.sessions.insert(session_id.to_string(), session);
    next
}

// ── 选择器（纯函数；渲染层只经它们读状态） ──

pub fn active_session<'a>(state: &'a TuiState) -> Option<&'a SessionState> {
    let id = state.active_session_id.as_deref()?;
    state.sessions.get(id)
}

/// 会话运行态（sessionRuntimeStates 的单项投影；没有记录视为空闲）。
pub fn runtime_of<'a>(state: &'a TuiState, session_id: Option<&str>) -> Option<&'a RuntimeState> {
    let id = session_id?;
    state.runtime_states.iter().find(|state| state.session_id == id)
}

/// 运行态点符号（○空闲 ●运行 ◑等待 ◍后台类）。
pub fn runtime_dot(state: Option<&RuntimeState>) -> &'static str {
    match state {
        None => "○",
        Some(state) if state.compacting || state.background_running || state.sub_agent_running => "◍",
        Some(state) if state.query_running => "●",
        Some(state) if state.waiting => "◑",
        Some(_) => "○",
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

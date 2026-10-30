//! UI 侧译层：core 帧 ↔ 渲染动作（`src/host/WebViewUI.ts` + `ui/webviewMessageHandler.ts`
//! + `ui/toolHandler.ts` 的移植）。
//!
//! TS 版 TUI 复用 WebViewUI 以保证「宿主逻辑只存在一份」；Rust TUI 直连帧通道，
//! 这一层的行为就在本模块重建（docs/hosts/tui.md 第 1 节第 2 条为 TS 版口径，Rust 版以此模块
//! 为唯一事实翻译点）。职责：
//! - CoreEvent → 渲染动作（流式 / 工具卡片 / 排队 / 配置回写 / notice 翻译）；
//! - CoreRequest → 交互（权限卡片先出、diff 预览、用户选择覆盖层）并应答；
//! - 用户输入 → UiEvent / UiRequest（uuid 生成、乐观回显、排队 deferEcho）；
//! - 宿主自有事实（settings 默认值 / 模型菜单 / 上下文上限 / 余额转发）。
//!
//! 边界语义（docs/architecture/events.md 第 6 节）：request 无内置超时——core 掉线时由
//! `reset_connection()` 以错误收场全部挂起请求，不静默挂死。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::choices::{ChoiceDelivery, ChoiceManager, ChoiceOptions, DiffSnapshot};
use crate::conversations::{parse_conversation_list, ConversationCache};
use crate::protocol::{CoreToUiFrame, UiToCoreFrame};
use crate::settings::{
    resolve_model_ref, snapshot_to_payload, McpServerDefinition, SettingsStore,
};
use crate::store::{
    Action, AddMessageData, ConversationLoadedData, Ids, LocalAction, NoticeLevel,
    Overlay, OverlayKind, Role, RuntimeState, TuiMessage, ToolStatus,
};
use crate::ui_state::SessionUiState;
use crate::i18n;

// ==================== 日志 ====================

/// 日志出口：文件 + `--verbose` 时的 stderr；**绝不写 stdout**（stdout 是渲染面，
/// docs/hosts/tui.md 第 11.1 节风险 3）。
pub struct Logger {
    file: Mutex<Option<std::fs::File>>,
    verbose: bool,
}

impl Logger {
    pub fn new(path: Option<PathBuf>, verbose: bool) -> Logger {
        let file = path.and_then(|path| std::fs::OpenOptions::new().create(true).append(true).open(path).ok());
        Logger { file: Mutex::new(file), verbose }
    }

    pub fn log(&self, line: &str) {
        if self.verbose {
            eprintln!("{line}");
        }
        use std::io::Write;
        if let Ok(mut slot) = self.file.lock() {
            if let Some(file) = slot.as_mut() {
                let _ = writeln!(file, "{line}");
            }
        }
    }
}

// ==================== 待应答请求 ====================

/// 宿主发出的 UiRequest 的「等回包后做什么」。
enum PendingReply {
    ConversationList,
    Skills,
    Balance { session_id: String },
    ConversationLoad { session_id: String },
    SmartNaming { session_id: String },
    McpServers,
    /// 切换会话前等旧会话落盘收尾（`flushSessionRequested`），回包后继续加载新会话
    FlushThenLoad { session_id: String },
}

/// `sendMessage` 携带的会话覆盖（app 从 store 的活动会话投影读出；未到达的不猜）。
#[derive(Debug, Clone, Default)]
pub struct SessionOverrides {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub agent_mode: Option<String>,
    pub thinking_mode: Option<String>,
    pub web_search: Option<bool>,
}

// ==================== Host ====================

pub struct Host {
    pub log: std::sync::Arc<Logger>,
    pub ids: Ids,
    settings: SettingsStore,
    ui_state: SessionUiState,
    choices: ChoiceManager,
    runtime: ConversationCache,
    tracked_active_session: Option<String>,
    workspace_path: String,
    core_root: PathBuf,
    outbox: Vec<UiToCoreFrame>,
    next_request_id: u64,
    pending: HashMap<u64, PendingReply>,
    ready: bool,
}

impl Host {
    pub fn new(
        log: std::sync::Arc<Logger>,
        mut settings: SettingsStore,
        workspace_path: String,
        core_root: PathBuf,
    ) -> Host {
        settings.load();
        Host {
            log,
            ids: Ids::new(),
            settings,
            ui_state: SessionUiState::default(),
            choices: ChoiceManager::default(),
            runtime: ConversationCache::default(),
            tracked_active_session: None,
            workspace_path,
            core_root,
            outbox: Vec::new(),
            next_request_id: 1,
            pending: HashMap::new(),
            ready: false,
        }
    }

    /// Core 是否已就绪（`ready` 帧已到；挂载序列的触发条件）。
    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn workspace_path(&self) -> &str {
        &self.workspace_path
    }

    /// 收集并清空上行帧（main 循环写入 core 的 stdin）。
    pub fn drain_outbox(&mut self) -> Vec<UiToCoreFrame> {
        std::mem::take(&mut self.outbox)
    }

    fn emit(&mut self, event: Value) {
        self.outbox.push(UiToCoreFrame::UiEvent(event));
    }

    fn request(&mut self, request: Value, pending: PendingReply) {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.pending.insert(id, pending);
        self.outbox.push(UiToCoreFrame::Request { id, request });
    }

    fn respond(&mut self, id: u64, result: Value) {
        self.outbox.push(UiToCoreFrame::Response { id, ok: true, result, error: None });
    }

    fn respond_error(&mut self, id: u64, error: impl Into<String>) {
        self.outbox.push(UiToCoreFrame::Response {
            id,
            ok: false,
            result: Value::Null,
            error: Some(error.into()),
        });
    }

    fn notice(&self, text: String, level: NoticeLevel) -> Action {
        Action::Local(LocalAction::Notice { text, level })
    }

    // ==================== 握手与快照 ====================

    /// Core 就绪（`ready` 帧）：推送宿主环境与配置快照（core 的就绪判据，
    /// docs/core/standalone-core.md 第 6 节；必须在其它 UiEvent 之前）。
    pub fn on_ready(&mut self) {
        self.ready = true;
        self.emit_host_environment();
    }

    /// 宿主环境与配置快照（`hostEnvironmentProvided`）：整份快照，没有增量语义
    /// （docs/architecture/core-ui-separation.md 第 4.5 节）。配置写盘后重推走同一条路径。
    pub fn emit_host_environment(&mut self) {
        let snapshot = self.settings.snapshot();
        let mcp_servers: Vec<Value> = self
            .settings
            .mcp_servers()
            .iter()
            .map(serialize_mcp_definition)
            .collect();
        self.emit(json!({
            "type": "hostEnvironmentProvided",
            "extensionPath": self.core_root.display().to_string(),
            "logToConsole": false,
            "configDirName": crate::settings::CONFIG_DIR_NAME,
            "settings": snapshot_to_payload(snapshot),
            "mcpServers": mcp_servers,
            // TUI 是单工作区宿主：不提供跨工作区代理（specs/022 FR-009）
            "crossWorkspaceAgent": false,
        }));
    }

    /// core 掉线 / 重启：以错误收场全部挂起请求，不静默挂死
    /// （对齐 StandaloneEventBus「断开时以错误结束挂起的请求」）。
    pub fn reset_connection(&mut self) -> Vec<Action> {
        self.pending.clear();
        // 选择框与查询计数随 core 一起消失：重启后的 core 是全新状态
        self.choices = ChoiceManager::default();
        self.ui_state = SessionUiState::default();
        self.log.log("[host] connection lost; pending requests discarded");
        vec![
            Action::Local(LocalAction::ClearPendingChoice),
            Action::Local(LocalAction::CloseOverlay),
            self.notice(
                i18n::tt("Core 已断开，请重启 TUI。", "Core disconnected, please restart the TUI."),
                NoticeLevel::Error,
            ),
        ]
    }

    // ==================== 帧入口 ====================

    /// 处理一帧 core → UI 的帧，产出渲染动作。
    pub fn handle_frame(&mut self, frame: CoreToUiFrame) -> Vec<Action> {
        match frame {
            CoreToUiFrame::Ready => {
                self.on_ready();
                Vec::new()
            }
            CoreToUiFrame::Event(event) => self.handle_event(&event),
            CoreToUiFrame::Request { id, request } => self.handle_core_request(id, &request),
            CoreToUiFrame::Response { id, ok, result, error } => {
                let Some(pending) = self.pending.remove(&id) else {
                    self.log.log(&format!("[host] response for unknown request id={id}"));
                    return Vec::new();
                };
                if !ok {
                    let message = error.unwrap_or_else(|| "request failed".into());
                    self.log.log(&format!("[host] request id={id} failed: {message}"));
                    return self.handle_failed_reply(pending, message);
                }
                self.handle_reply(pending, &result)
            }
        }
    }

    fn handle_failed_reply(&mut self, pending: PendingReply, message: String) -> Vec<Action> {
        match pending {
            PendingReply::FlushThenLoad { session_id } => {
                // 切换会话被落盘收尾失败挡住：仍然继续加载（尽力而为），错误只记日志
                self.log.log(&format!("[host] flush failed, continuing load: {message}"));
                self.start_load(&session_id)
            }
            PendingReply::ConversationLoad { .. } => {
                vec![self.notice(
                    i18n::tt(
                        &format!("加载会话失败：{message}"),
                        &format!("Failed to load conversation: {message}"),
                    ),
                    NoticeLevel::Error,
                )]
            }
            PendingReply::ConversationList => Vec::new(),
            PendingReply::Skills | PendingReply::McpServers | PendingReply::SmartNaming { .. } => Vec::new(),
            PendingReply::Balance { session_id } => vec![clear_balance(&session_id)],
        }
    }

    fn handle_reply(&mut self, pending: PendingReply, result: &Value) -> Vec<Action> {
        match pending {
            PendingReply::ConversationList => {
                let list = parse_conversation_list(result);
                self.runtime.update_list(list.clone());
                vec![Action::ConversationsData(list)]
            }
            PendingReply::Skills => {
                let skills = parse_skills(result);
                vec![Action::SetSkills(skills)]
            }
            PendingReply::Balance { session_id } => {
                vec![balance_action(&session_id, result)]
            }
            PendingReply::SmartNaming { session_id } => {
                let title = result.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                // 标题写盘走总线（core 落盘 + 广播 titleChanged）；列表刷新由
                // conversationListChanged 统一驱动
                self.emit(json!({ "type": "conversationRenamed", "sessionId": session_id, "title": title }));
                vec![
                    Action::SetTitle { session_id: session_id.clone(), title: title.clone() },
                    Action::SmartNamingResult { session_id, title },
                ]
            }
            PendingReply::McpServers => {
                let servers = parse_mcp_servers(result);
                vec![Action::SetMcpServers(servers)]
            }
            PendingReply::FlushThenLoad { session_id } => self.start_load(&session_id),
            PendingReply::ConversationLoad { session_id } => {
                self.complete_conversation_load(&session_id, result)
            }
        }
    }

    // ==================== CoreEvent 翻译（WebViewUI 的 handler 表） ====================

    fn handle_event(&mut self, event: &Value) -> Vec<Action> {
        let Some(kind) = event.get("type").and_then(Value::as_str) else {
            self.log.log("[host] dropped CoreEvent without a type field");
            return Vec::new();
        };
        let session = |event: &Value| {
            event.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string()
        };
        match kind {
            // ===== 渲染 =====
            "message" => {
                let session_id = session(event);
                let Some(data) = event.get("data") else { return Vec::new() };
                let Some(mut data) = add_message_data(data) else {
                    self.log.log(&format!("[host] dropped message event with unknown shape: {data:?}"));
                    return Vec::new();
                };
                data.session_id = session_id;
                let role = data.role;
                let actions = vec![Action::AddMessage(data)];
                // 用户消息已进入持久化流程：刷新对话列表，使列表的 messageCount 同步
                if role == Some(Role::User) {
                    self.refresh_conversations();
                }
                actions
            }
            "streamMessage" => {
                let session_id = session(event);
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                let role = data.get("role").and_then(Value::as_str).and_then(Role::parse);
                let accumulated = data.get("accumulated").and_then(Value::as_str).unwrap_or("");
                let stream_id = data.get("streamId").and_then(Value::as_str).unwrap_or("").to_string();
                // 流式阶段决定当前是 thinking 还是 assistant 文本输出
                match role {
                    Some(Role::Assistant) => {
                        if accumulated.trim().is_empty() {
                            return Vec::new();
                        }
                        self.ui_state.mark_text(&session_id);
                    }
                    Some(_) => self.ui_state.mark_thinking(&session_id),
                    None => return Vec::new(),
                }
                let role = role.unwrap_or(Role::Assistant);
                vec![Action::StreamMessage { session_id, role, text: accumulated.to_string(), stream_id }]
            }
            "streamEnd" => {
                let session_id = session(event);
                let data = event.get("data").cloned().unwrap_or(Value::Null);
                let Some(role) = data.get("role").and_then(Value::as_str).and_then(Role::parse) else {
                    return Vec::new();
                };
                let accumulated = data.get("accumulated").and_then(Value::as_str).unwrap_or("").to_string();
                let stream_id = data.get("streamId").and_then(Value::as_str).unwrap_or("").to_string();
                let usage = data.get("usage").cloned().unwrap_or(Value::Null);
                let input = usage.get("input_tokens").and_then(Value::as_f64).unwrap_or(0.0);
                let output = usage.get("output_tokens").and_then(Value::as_f64).unwrap_or(0.0);
                vec![Action::StreamEnd { session_id, role, accumulated, total_tokens: input + output, stream_id }]
            }
            "toolCall" => {
                let session_id = session(event);
                let tool_call_id = event.get("toolUseId").and_then(Value::as_str).unwrap_or("").to_string();
                self.ui_state.mark_tool_phase(&session_id);
                vec![Action::UpdateToolStatus {
                    session_id,
                    tool_call_id,
                    status: Some(ToolStatus::Running),
                    output: None,
                }]
            }
            "toolResult" => {
                let session_id = session(event);
                let tool_call_id = event.get("toolUseId").and_then(Value::as_str).unwrap_or("").to_string();
                let output = event.get("output").and_then(Value::as_str).unwrap_or("").to_string();
                let status = match event.get("status").and_then(Value::as_str) {
                    Some("error") => ToolStatus::Fail,
                    _ => ToolStatus::Success,
                };
                self.ui_state.end_tool_phase(&session_id);
                vec![Action::UpdateToolStatus { session_id, tool_call_id, status: Some(status), output: Some(output) }]
            }
            "toolArgsUpdated" => {
                // 文件引用 chips 与紧凑 diff 的数据面，TUI v1 不渲染（原样忽略）
                Vec::new()
            }
            "toolProgress" => {
                let session_id = session(event);
                let tool_call_id = event.get("toolUseId").and_then(Value::as_str).unwrap_or("").to_string();
                let progress = event.get("progress").cloned().unwrap_or(Value::Null);
                // 内容已由工具层按统一上限（4K，前 2K + 后 2K）裁剪，原样转发
                let streamed = progress
                    .get("fullOutput")
                    .or_else(|| progress.get("output"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                vec![Action::ToolProgress { session_id, tool_call_id, output: streamed }]
            }
            "aiBegin" => {
                let session_id = session(event);
                self.ui_state.mark_thinking(&session_id);
                vec![
                    Action::ShowThinkingAnimation { session_id: session_id.clone(), show: true },
                    Action::AiBegin { session_id },
                ]
            }
            "aiEnd" => {
                let session_id = session(event);
                self.ui_state.mark_idle(&session_id);
                self.fetch_balance(&session_id);
                vec![
                    Action::ShowThinkingAnimation { session_id: session_id.clone(), show: false },
                    Action::AiEnd { session_id },
                ]
            }
            "messagesReplaced" => {
                let session_id = session(event);
                let empty = Vec::new();
                let records = event.get("messages").and_then(Value::as_array).unwrap_or(&empty);
                let messages = self.map_message_data_list(records);
                vec![Action::MessagesReplaced { session_id, messages }]
            }

            // ===== 控制面 =====
            "queryBegin" => {
                let session_id = session(event);
                // 同一 session 可能被多个调用方同时标记 begin，由查询计数去重，
                // 保证一次查询只表现一次开始
                if !self.ui_state.begin_query(&session_id) {
                    self.log.log(&format!("[host] ignoring nested queryBegin for session: {session_id}"));
                    return Vec::new();
                }
                self.ui_state.mark_thinking(&session_id);
                vec![Action::ShowThinkingAnimation { session_id, show: true }]
            }
            "queryEnd" => {
                let session_id = session(event);
                if !self.ui_state.end_query(&session_id) {
                    self.log.log(&format!("[host] ignoring redundant queryEnd for session: {session_id}"));
                    return Vec::new();
                }
                self.ui_state.mark_idle(&session_id);
                // 查询结束必须关闭 thinking 动画：中断（尤其子代理中断）可能没有 aiEnd
                // 查询结束代表消息已持久化完成：推送最新对话列表
                self.refresh_conversations();
                vec![
                    Action::ShowThinkingAnimation { session_id: session_id.clone(), show: false },
                    Action::QueryEnd { session_id },
                ]
            }
            "titleChanged" => {
                let session_id = session(event);
                let title = event.get("title").and_then(Value::as_str).unwrap_or("").to_string();
                vec![Action::SetTitle { session_id, title }]
            }
            "sessionCreated" => Vec::new(), // initSessionState：TUI 无需初始化动作
            "conversationListChanged" => {
                self.refresh_conversations();
                Vec::new()
            }
            "conversationSpaceCleared" => Vec::new(), // 对话空间管理页（webview 专属）
            "sessionRuntimeChanged" => {
                let empty = Vec::new();
                let states = event
                    .get("states")
                    .and_then(Value::as_array)
                    .unwrap_or(&empty)
                    .iter()
                    .filter_map(RuntimeState::from_value)
                    .collect::<Vec<_>>();
                self.runtime.update_states(states.clone());
                vec![Action::SessionRuntimeStates(states)]
            }
            "spinDesignDataChanged" => {
                // 设计器是自包含 HTML，终端不承载：显式提示（设计允许的能力差异）
                vec![self.notice(
                    i18n::tt(
                        "Spin 设计器仅在 VS Code / Electron 宿主提供",
                        "The Spin designer is only available in the VS Code / Electron hosts",
                    ),
                    NoticeLevel::Info,
                )]
            }
            "highlightLanguagesUsed" => {
                self.record_highlight_languages(event.get("languages"));
                Vec::new()
            }
            "compactBegin" => {
                let session_id = session(event);
                vec![self.compress_notice("start", None, &session_id)]
            }
            "compactEnd" => {
                let session_id = session(event);
                let result = event.get("result").cloned().unwrap_or(Value::Null);
                match result.get("status").and_then(Value::as_str) {
                    Some("complete") => {
                        let tokens = result.get("postCompactTokenCount").and_then(Value::as_f64);
                        // 压缩替换了整份上下文：状态栏 tokens 直接采用 core 重算的
                        // postCompactTokenCount，不停留旧值等到下一轮 streamEnd
                        // （specs/defects/compact-context-facts-stale-across-views）
                        let mut actions = Vec::new();
                        if let Some(tokens) = tokens {
                            actions.push(Action::SetContextTokens { session_id: session_id.clone(), tokens });
                        }
                        actions.push(self.compress_notice("complete", tokens, &session_id));
                        actions
                    }
                    _ => vec![self.compress_notice("error", None, &session_id)],
                }
            }
            "commandDispatched" => {
                let session_id = session(event);
                let command = event.get("commandName").and_then(Value::as_str).unwrap_or("");
                // 内置命令就地执行、不进入 LLM 上下文：显式清除排队项，避免 queryEnd 时
                // 把它当成「未被消费」而重复投递
                let mut actions = vec![Action::ClearQueuedMessage { session_id }];
                if command == "spin" {
                    actions.push(self.notice(
                        i18n::tt(
                            "Spin 设计器仅在 VS Code / Electron 宿主提供",
                            "The Spin designer is only available in the VS Code / Electron hosts",
                        ),
                        NoticeLevel::Info,
                    ));
                }
                actions
            }
            "sessionConfigChanged" => {
                let session_id = session(event);
                let change = event.get("change").cloned().unwrap_or(Value::Null);
                let key = change.get("key").and_then(Value::as_str).unwrap_or("");
                match key {
                    // wire 协议保持扁平：模型身份拆成 model / provider 两个字段。
                    // model 键的身份字段是 `ref`（events.md 词汇表；TS 宿主同口径），
                    // 读 `value` 会拿到 null、模型名显示回落 `…`。
                    "model" => {
                        let r = change.get("ref").cloned().unwrap_or(Value::Null);
                        vec![Action::SetModel {
                            session_id,
                            model: r.get("model").and_then(Value::as_str).unwrap_or("").to_string(),
                            provider: r.get("provider").and_then(Value::as_str).map(str::to_string),
                        }]
                    }
                    "thinkingEffort" => vec![Action::SetThinkingMode {
                        session_id,
                        mode: change.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                    }],
                    "promptMode" => vec![Action::SetPromptMode {
                        session_id,
                        mode: change.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                    }],
                    "agentMode" => vec![Action::SetAgentMode {
                        session_id,
                        mode: change.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
                    }],
                    "webSearch" => vec![Action::SetWebSearch {
                        session_id,
                        enabled: change.get("value").and_then(Value::as_bool).unwrap_or(false),
                    }],
                    // 重新读取该会话的 MCP 配置 + 运行时状态并回推（连接同步完成后 core 才广播）
                    "mcpEnabled" => {
                        self.request_mcp_servers(self.tracked_active_session.clone());
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            "notice" => {
                let key = event.get("key").and_then(Value::as_str).unwrap_or("");
                let params = event.get("params").cloned().unwrap_or(Value::Null);
                let level = NoticeLevel::parse(event.get("level").and_then(Value::as_str).unwrap_or("info"));
                // core 只给「键 + 参数」，翻译与呈现由 UI 承担；键缺失回显键本身
                vec![self.notice(i18n::notice_text(key, &params), level)]
            }
            "log" => {
                let message = event.get("message").and_then(Value::as_str).unwrap_or("");
                self.log.log(&format!("[core] {message}"));
                Vec::new()
            }
            "coreReady" => Vec::new(), // 重新推送快照后的回执；宿主侧只记录，不触发渲染
            other => {
                self.log.log(&format!("[host] dropped unknown CoreEvent type: {other}"));
                Vec::new()
            }
        }
    }

    fn compress_notice(&self, status: &str, tokens: Option<f64>, _session: &str) -> Action {
        // 压缩进度走瞬时提示（start / complete / error 三态都是一次性事件）
        let (text, level) = match status {
            "start" => (i18n::tt("开始压缩上下文…", "Compacting context…"), NoticeLevel::Info),
            "complete" => (
                match tokens {
                    Some(tokens) => i18n::tt(
                        &format!("压缩完成（{} tokens）", format_tokens(tokens)),
                        &format!("Compacted ({} tokens)", format_tokens(tokens)),
                    ),
                    None => i18n::tt("压缩完成", "Compacted"),
                },
                NoticeLevel::Info,
            ),
            _ => (i18n::tt("压缩失败", "Compact failed"), NoticeLevel::Error),
        };
        self.notice(text, level)
    }

    /// 消息里出现了新的高亮语言 → 并入 settings.json 的 highlightLanguages 字段
    /// （UI 专属字段，Core 不感知；写盘后重推快照，与 TS 的订阅链同语义）。
    fn record_highlight_languages(&mut self, languages: Option<&Value>) {
        let Some(list) = languages.and_then(Value::as_array) else { return };
        let incoming: Vec<String> = list
            .iter()
            .filter_map(Value::as_str)
            .filter(|language| !language.is_empty())
            .map(str::to_string)
            .collect();
        if incoming.is_empty() {
            return;
        }
        let result = self.settings.update_settings(|cfg| {
            const FIELD: &str = "highlightLanguages";
            const MAX: usize = 60;
            let Some(object) = cfg.as_object_mut() else { return };
            let mut current: Vec<String> = object
                .get(FIELD)
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect())
                .unwrap_or_default();
            let mut changed = false;
            for language in &incoming {
                if !current.iter().any(|existing| existing == language) {
                    current.push(language.clone());
                    changed = true;
                }
            }
            if !changed {
                return;
            }
            // 超出上限时丢弃最早记录，保持字段体积可控
            if current.len() > MAX {
                current.drain(..current.len() - MAX);
            }
            object.insert(FIELD.into(), json!(current));
        });
        match result {
            Ok(_) => self.emit_host_environment(),
            Err(error) => self.log.log(&format!("[host] failed to record highlight languages: {error}")),
        }
    }

    // ==================== CoreRequest 翻译（权限 / 用户选择） ====================

    fn handle_core_request(&mut self, id: u64, request: &Value) -> Vec<Action> {
        let Some(kind) = request.get("type").and_then(Value::as_str) else {
            self.respond_error(id, "request without a type field");
            return Vec::new();
        };
        match kind {
            "toolPermissionRequested" => self.handle_tool_permission(id, request),
            "userChoice" => self.handle_user_choice_request(id, request),
            other => {
                self.log.log(&format!("[host] unknown CoreRequest type: {other}"));
                self.respond_error(id, format!("unknown CoreRequest type: {other}"));
                Vec::new()
            }
        }
    }

    /// 权限请求：上架工具卡片；permResult 原样返回（'ask' 的确认框由 core 随后的
    /// userChoice 请求发出，这里提前弹框会造成双重确认）。
    fn handle_tool_permission(&mut self, id: u64, request: &Value) -> Vec<Action> {
        let session_id = request.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let tool_use_id = request.get("toolUseId").and_then(Value::as_str).unwrap_or("").to_string();
        let tool_name = request.get("toolName").and_then(Value::as_str).unwrap_or("").to_string();
        let perm_result = request.get("permResult").cloned().unwrap_or(Value::Null);
        let agent_mode = request.get("agentMode").and_then(Value::as_str).unwrap_or("");
        let display_args = request.get("displayArgs").cloned().unwrap_or(Value::Null);

        // 进入工具阶段（包括等待用户授权），thinking 动画应让位于工具卡片
        self.ui_state.begin_tool_phase(&session_id);

        // 保存 Edit / Write 的 diff 信息（只在本次权限结果确实携带 diff 字段时——
        // 否则会把上一次 Edit/Write 的 diff 错挂到本次的失败卡片上）
        let before = perm_result.get("beforeContent");
        let has_perm_diff = (tool_name == "Edit" || tool_name == "Write") && before.is_some();
        if has_perm_diff {
            self.choices.save_diff_snapshot(
                &session_id,
                DiffSnapshot {
                    // Write 新建文件时 beforeContent 为 null：diff 按空原文处理
                    before_content: before.and_then(Value::as_str).unwrap_or("").to_string(),
                    after_content: perm_result.get("afterContent").and_then(Value::as_str).unwrap_or("").to_string(),
                    context_before: string_list(perm_result.get("contextBefore")),
                    context_after: string_list(perm_result.get("contextAfter")),
                    start_line: perm_result.get("startLine").and_then(Value::as_f64),
                    end_line: perm_result.get("endLine").and_then(Value::as_f64),
                },
            );
        }

        // 授权前先显示这次改动：工具卡片（normal 状态，等待授权/执行）
        let mut actions = vec![Action::AddMessage(AddMessageData {
            session_id: session_id.clone(),
            role: Some(Role::ToolCall),
            content: String::new(),
            tool_name: Some(tool_name.clone()),
            tool_call_id: Some(tool_use_id),
            status: Some(ToolStatus::Normal),
            ..Default::default()
        })];

        // 只有 manual 模式才弹终端 diff 覆盖层：auto / risk 下改动是自动放行的，
        // 再弹只会打扰用户
        if has_perm_diff && agent_mode == "manual" {
            let snapshot = self.choices.diff_snapshot().clone();
            let title = display_args
                .get("file_path")
                .and_then(Value::as_str)
                .unwrap_or(&tool_name)
                .to_string();
            let lines = crate::diffview::diff_overlay_lines(&snapshot.before_content, &snapshot.after_content, 3);
            actions.push(Action::Local(LocalAction::ShowOverlay(Overlay {
                kind: OverlayKind::Diff,
                title,
                lines,
            })));
        }

        self.respond(id, perm_result);
        actions
    }

    /// 用户选择请求：按会话入队，open（== 当前显示的会话）时立即弹出。
    fn handle_user_choice_request(&mut self, id: u64, request: &Value) -> Vec<Action> {
        let session_id = request.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
        let options = ChoiceOptions::from_value(request);
        // ask user 请求自带 diff 字段时更新当前快照（与 TS showUserChoice 同语义；
        // 权限请求已写过的场景下两者取值一致）
        if options.before_content.is_some() {
            self.choices.save_diff_snapshot(
                &session_id,
                DiffSnapshot {
                    before_content: options.before_content.clone().unwrap_or_default(),
                    after_content: options.after_content.clone().unwrap_or_default(),
                    context_before: options.context_before.clone(),
                    context_after: options.context_after.clone(),
                    start_line: options.start_line,
                    end_line: options.end_line,
                },
            );
        }
        let choice_id = format!("choice-{}-{}", now_millis(), random_suffix());
        let is_open = self.tracked_active_session.as_deref() == Some(session_id.as_str());
        match self.choices.request(&session_id, options, id, choice_id, is_open) {
            ChoiceDelivery::Replaced { replaced_frames, delivery } => {
                for frame in replaced_frames {
                    self.respond_error(frame, "User choice was replaced by a new request");
                }
                self.deliver_choice(delivery)
            }
            delivery => self.deliver_choice(Box::new(delivery)),
        }
    }

    fn deliver_choice(&mut self, delivery: Box<ChoiceDelivery>) -> Vec<Action> {
        match *delivery {
            ChoiceDelivery::Show(choice) => {
                // 会话运行时状态：等待用户操作 → 状态栏黄点
                self.emit(json!({
                    "type": "userChoicePendingChanged",
                    "sessionId": choice.session_id,
                    "pending": true,
                }));
                vec![Action::RequestUserChoice(choice)]
            }
            ChoiceDelivery::Held | ChoiceDelivery::Replaced { .. } => Vec::new(),
        }
    }

    /// 用户应答（覆盖层提交）：解除 waiting 并回帧。
    pub fn respond_choice(&mut self, choice_id: &str, index: i64, reply: Option<String>) -> Vec<Action> {
        let Some(shown) = self.choices.respond(choice_id) else {
            self.log.log(&format!("[host] no pending choice found for {choice_id}"));
            return Vec::new();
        };
        self.emit(json!({
            "type": "userChoicePendingChanged",
            "sessionId": shown.choice.session_id,
            "pending": false,
        }));
        let mut result = json!({ "index": index });
        if let Some(reply) = reply {
            result["reply"] = json!(reply);
        }
        self.respond(shown.frame_id, result);
        // 用户已响应：关闭当前覆盖层（与 TS closePreview 同语义）
        vec![Action::Local(LocalAction::CloseOverlay)]
    }

    // ==================== 启动拉取（App 挂载序列） ====================

    /// App 挂载序列（对齐 webview 挂载行为：拉取全局事实）。
    pub fn startup_fetches(&mut self) -> Vec<Action> {
        self.refresh_conversations();
        self.request_skills();
        // 会话运行时状态快照：状态流只在「变化」时推，主动拉一次避免新视图失明
        let mut actions = self.push_models();
        actions.extend(self.push_settings_defaults());
        actions.extend(self.push_context_limit());
        actions.push(Action::SessionRuntimeStates(self.runtime.states().to_vec()));
        actions
    }

    pub fn refresh_conversations(&mut self) {
        self.request(
            json!({ "type": "conversationListRequested", "workspacePath": self.workspace_path }),
            PendingReply::ConversationList,
        );
    }

    pub fn request_skills(&mut self) {
        // 项目技能基于会话自己的工作目录扫描；没有 tracked 会话时只列内置项
        let mut request = json!({ "type": "skillsRequested" });
        if let Some(session) = &self.tracked_active_session {
            request["sessionId"] = json!(session);
        }
        self.request(request, PendingReply::Skills);
    }

    pub fn request_mcp_servers(&mut self, session_id: Option<String>) {
        let mut request = json!({ "type": "mcpServersRequested" });
        if let Some(session) = session_id {
            request["sessionId"] = json!(session);
        }
        self.request(request, PendingReply::McpServers);
    }

    /// 模型菜单数据源：只读 settings.json，不访问网关。
    pub fn push_models(&mut self) -> Vec<Action> {
        let raw = self.settings.raw_settings().clone();
        let providers = raw
            .get("llm")
            .and_then(|llm| llm.get("providers"))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let active_key = raw
            .get("llm")
            .and_then(|llm| llm.get("activeProvider"))
            .and_then(Value::as_str)
            .filter(|key| {
                providers
                    .get(*key)
                    .and_then(|provider| provider.get("baseURL"))
                    .and_then(Value::as_str)
                    .map(|url| !url.is_empty())
                    .unwrap_or(false)
            })
            .unwrap_or("")
            .to_string();

        // 按 settings.json 的定义顺序收集全部 provider（baseURL 非空）；默认模型被删掉时
        // 补回列表头部，保证当前选中项在菜单里可见
        let groups: Vec<(String, Vec<String>)> = providers
            .into_iter()
            .filter(|(_, provider)| {
                provider.get("baseURL").and_then(Value::as_str).map(str::trim).map(str::len).unwrap_or(0) > 0
            })
            .map(|(key, provider)| {
                let mut models: Vec<String> = Vec::new();
                if let Some(list) = provider.get("models").and_then(Value::as_array) {
                    for model in list {
                        if let Some(model) = model.as_str() {
                            let model = model.trim();
                            if !model.is_empty() && !models.iter().any(|existing| existing == model) {
                                models.push(model.to_string());
                            }
                        }
                    }
                }
                if let Some(default_model) = provider.get("defaultModel").and_then(Value::as_str) {
                    let default_model = default_model.trim();
                    if !default_model.is_empty() && !models.iter().any(|existing| existing == default_model) {
                        models.insert(0, default_model.to_string());
                    }
                }
                (key, models)
            })
            .collect();

        vec![Action::SetModels(crate::store::ModelsState { providers: groups, active_provider: active_key })]
    }

    /// settings.json 的会话级默认值（先重读一次磁盘：手工恢复 / 编辑 settings.json 后
    /// 不必重启；快照变化时重推给 core，与 TS 的订阅链同语义）。
    pub fn push_settings_defaults(&mut self) -> Vec<Action> {
        if let Some(_) = self.settings.refresh_from_disk() {
            self.emit_host_environment();
        }
        let snapshot = self.settings.snapshot();
        let (model, provider) = match snapshot.active_model_ref() {
            Some((provider, model)) => (model, Some(provider)),
            None => (String::new(), None),
        };
        vec![Action::SettingsDefaults(crate::store::SettingsDefaults {
            model,
            provider,
            thinking_mode: Some(snapshot.thinking_effort.clone()),
            agent_mode: Some(snapshot.default_agent_mode.clone()),
            prompt_mode: Some(snapshot.default_prompt_mode.clone()),
            web_search: Some(snapshot.web_search),
        })]
    }

    /// 当前上下文上限（active provider 默认模型；模型切换的回包暂由菜单流程拉取）。
    pub fn push_context_limit(&mut self) -> Vec<Action> {
        let limit = self.settings.read_context_limit(None, None);
        vec![Action::ContextLimitUpdated(limit)]
    }

    fn fetch_balance(&mut self, session_id: &str) {
        self.request(
            json!({ "type": "balanceRequested", "sessionId": session_id }),
            PendingReply::Balance { session_id: session_id.to_string() },
        );
    }

    // ==================== 会话生命周期 ====================

    /// 新建会话（App 已把 store 的活动会话切到新 id）。
    pub fn new_conversation(&mut self, session_id: &str) -> Vec<Action> {
        self.tracked_active_session = Some(session_id.to_string());
        // 先登记工作目录：core 收到 conversationStarted 后要按会话解析目录建引擎
        self.emit(json!({
            "type": "sessionWorkspaceAssigned",
            "sessionId": session_id,
            "workspacePath": self.workspace_path,
        }));
        // 预创建引擎（内存态；meta.json / jsonl 只在第一条消息落盘时创建）
        self.emit(json!({
            "type": "conversationStarted",
            "sessionId": session_id,
            "workspacePath": self.workspace_path,
        }));
        // 登记为「已打开会话」：Core 重启后据此重放 conversationOpened
        self.emit(json!({ "type": "conversationOpened", "sessionId": session_id }));
        self.fetch_balance(session_id);
        // 新对话默认标题（空串 = 未命名，与 webview 的 defaultTitle 同约定）
        vec![Action::SetTitle { session_id: session_id.to_string(), title: String::new() }]
    }

    /// 打开会话：切换前等旧会话的挂起持久化收尾（引擎归 core，宿主只发请求）。
    pub fn load_conversation(&mut self, session_id: &str) -> Vec<Action> {
        if let Some(old) = self.tracked_active_session.as_deref() {
            if old != session_id {
                self.request(
                    json!({ "type": "flushSessionRequested", "sessionId": old }),
                    PendingReply::FlushThenLoad { session_id: session_id.to_string() },
                );
                return Vec::new();
            }
        }
        self.start_load(session_id)
    }

    fn start_load(&mut self, session_id: &str) -> Vec<Action> {
        // 先登记该会话的工作目录：core 加载要按它定位 meta.json / jsonl
        self.emit(json!({
            "type": "sessionWorkspaceAssigned",
            "sessionId": session_id,
            "workspacePath": self.workspace_path,
        }));
        self.request(
            json!({ "type": "conversationLoadRequested", "sessionId": session_id }),
            PendingReply::ConversationLoad { session_id: session_id.to_string() },
        );
        Vec::new()
    }

    /// 会话加载完成：登记打开、余额、MCP、标题、默认值补齐、模型身份校验、
    /// agentMode 回退链、历史映射一次完成。
    fn complete_conversation_load(&mut self, session_id: &str, loaded: &Value) -> Vec<Action> {
        self.tracked_active_session = Some(session_id.to_string());
        self.emit(json!({ "type": "conversationOpened", "sessionId": session_id }));
        self.fetch_balance(session_id);
        self.request_mcp_servers(Some(session_id.to_string()));

        let metadata = loaded.get("metadata").cloned().unwrap_or(Value::Null);
        let context = metadata.get("context").cloned().unwrap_or(Value::Null);

        // 标题
        let title = metadata.get("title").and_then(Value::as_str).unwrap_or("").to_string();

        // meta.json 未保存的配置回退配置快照默认值（默认值只有一处来源）
        let snapshot = self.settings.snapshot().clone();
        let thinking_mode = context
            .get("thinkingMode")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(snapshot.thinking_effort.clone()));
        let web_search = context
            .get("webSearch")
            .and_then(Value::as_bool)
            .or(Some(snapshot.web_search));
        let prompt_mode = context
            .get("promptMode")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some(snapshot.default_prompt_mode.clone()));

        // 切换对话后校验模型身份：失效时解析出可用身份并写回 core（modelChanged）。
        // 只在 meta.json 确实记录过身份时才回写（与 TS 的 `stored && !same` 同口径）
        let stored_provider = metadata
            .get("provider")
            .and_then(Value::as_str)
            .or_else(|| context.get("provider").and_then(Value::as_str))
            .unwrap_or("");
        let stored_model = metadata
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| context.get("model").and_then(Value::as_str))
            .unwrap_or("");
        let resolved = resolve_model_ref(&snapshot, stored_provider, stored_model);
        let mut actions = Vec::new();
        let stored_recorded = !stored_provider.is_empty() || !stored_model.is_empty();
        if let Some((provider, model)) = &resolved {
            let differs = stored_provider != provider.as_str() || stored_model != model.as_str();
            if differs && stored_recorded {
                self.log.log(&format!(
                    "[host] session model (provider=\"{stored_provider}\", model=\"{stored_model}\") invalid, resolved to (provider=\"{provider}\", model=\"{model}\")"
                ));
                self.emit(json!({
                    "type": "modelChanged",
                    "sessionId": session_id,
                    "ref": { "provider": provider, "model": model },
                }));
            }
        }

        // 会话询问模式归 core：core 的权威取值未记录时回退 meta.json / settings.json
        let agent_mode = loaded
            .get("agentMode")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| context.get("agentMode").and_then(Value::as_str).map(str::to_string))
            .or_else(|| Some(snapshot.default_agent_mode.clone()));

        let messages = loaded
            .get("messages")
            .and_then(Value::as_array)
            .map(|records| self.map_history(records))
            .unwrap_or_default();

        let has_active_query = self.ui_state.is_query_active(session_id);
        let context_tokens = context.get("totalContextTokens").and_then(Value::as_f64).unwrap_or(0.0);

        actions.push(Action::ConversationLoaded(ConversationLoadedData {
            session_id: session_id.to_string(),
            messages,
            title: if title.is_empty() { None } else { Some(title) },
            model: resolved.as_ref().map(|(_, model)| model.clone()),
            provider: resolved.as_ref().map(|(provider, _)| provider.clone()),
            agent_mode,
            thinking_mode,
            prompt_mode,
            web_search,
            context_tokens,
            has_active_query,
        }));

        // 会话打开后重新投递 pending 的用户选择（core 在等它）；被清理的旧帧错误应答
        let choice_id = format!("choice-{}-{}", now_millis(), random_suffix());
        let (shown, stale_frames) = self.choices.on_session_loaded(session_id, choice_id);
        for frame in stale_frames {
            self.respond_error(frame, "User choice was replaced by a new request");
        }
        if let Some(shown) = shown {
            self.emit(json!({
                "type": "userChoicePendingChanged",
                "sessionId": session_id,
                "pending": true,
            }));
            actions.push(Action::RequestUserChoice(shown.choice));
        }
        actions
    }

    pub fn delete_conversation(&mut self, session_id: &str) -> Vec<Action> {
        self.emit(json!({ "type": "conversationDeleted", "sessionId": session_id }));
        self.drop_session(session_id)
    }

    /// 会话的 UI 侧状态已释放（删除）：挂起的选择以错误帧收场，等待状态解除。
    fn drop_session(&mut self, session_id: &str) -> Vec<Action> {
        self.ui_state.drop_session(session_id);
        let (frames, had_shown) = self.choices.drop_session(session_id);
        for frame in frames {
            self.respond_error(frame, format!("Session {session_id} closed before user choice was answered"));
        }
        let mut actions = Vec::new();
        if had_shown {
            self.emit(json!({
                "type": "userChoicePendingChanged",
                "sessionId": session_id,
                "pending": false,
            }));
            actions.push(Action::Local(LocalAction::ClearPendingChoice));
        }
        actions
    }

    pub fn rename_conversation(&mut self, session_id: &str, title: &str) {
        self.emit(json!({ "type": "conversationRenamed", "sessionId": session_id, "title": title }));
    }

    /// 智能命名：读会话消息 + 调 LLM + 解析标题；回包后经 conversationRenamed 落盘。
    pub fn request_smart_naming(&mut self, session_id: &str) {
        self.emit(json!({
            "type": "sessionWorkspaceAssigned",
            "sessionId": session_id,
            "workspacePath": self.workspace_path,
        }));
        self.request(
            json!({ "type": "smartNamingRequested", "sessionId": session_id }),
            PendingReply::SmartNaming { session_id: session_id.to_string() },
        );
    }

    // ==================== 会话配置 ====================

    pub fn set_model(&mut self, session_id: &str, model: &str, provider: &str) {
        // provider 缺失或为空串即非法：不猜测/回退到其它 provider
        if provider.is_empty() {
            self.log.log(&format!("[host] setModel: provider 为空（非法），忽略 model=\"{model}\""));
            return;
        }
        self.emit(json!({
            "type": "modelChanged",
            "sessionId": session_id,
            "ref": { "provider": provider, "model": model },
        }));
    }

    pub fn set_thinking_mode(&mut self, session_id: &str, mode: &str) {
        self.emit(json!({ "type": "thinkingEffortChanged", "sessionId": session_id, "mode": mode }));
    }

    pub fn set_prompt_mode(&mut self, session_id: &str, mode: &str) {
        self.emit(json!({ "type": "promptModeChanged", "sessionId": session_id, "mode": mode }));
    }

    pub fn set_agent_mode(&mut self, session_id: &str, mode: &str) {
        self.emit(json!({ "type": "agentModeChanged", "sessionId": session_id, "mode": mode }));
    }

    pub fn set_mcp_enabled(&mut self, session_id: &str, name: &str, enabled: bool) {
        self.emit(json!({ "type": "mcpEnabledChanged", "sessionId": session_id, "name": name, "enabled": enabled }));
    }

    pub fn request_compress(&mut self, session_id: &str) {
        self.emit(json!({ "type": "compactRequested", "sessionId": session_id }));
    }

    pub fn abort(&mut self, session_id: &str) {
        self.emit(json!({ "type": "abortRequested", "sessionId": session_id }));
    }

    // ==================== 用户消息 ====================

    /// 用户消息的唯一入口（`handleUserMessage` 移植）：生成 uuid、乐观回显 / 排队、
    /// 组装载荷发给 core。命令解析与消费都在 core 侧。
    pub fn submit_message(&mut self, session_id: &str, content: &str, overrides: &SessionOverrides) -> Vec<Action> {
        if session_id.is_empty() || (content.trim().is_empty()) {
            return Vec::new();
        }
        let uuid = format!("user_{}_{}", now_millis(), random_suffix());

        // 命令消息（`/xxx`）不做乐观回显：内置命令就地执行、不落盘，立刻画气泡会留下
        // 一个刷新后消失的「幽灵」用户消息
        let is_command = content.trim().starts_with('/');

        // 引擎是否仍在忙：读 core 推送的运行时状态快照（ConversationCache）。忙碌时该
        // 消息要等下一次 LLM 请求才进入上下文：登记排队项并置 deferEcho 让 core 真正
        // 并入上下文时补发用户气泡（docs/features/user-message-pipeline.md 第 5 节）
        let is_queued = self
            .runtime
            .state_of(session_id)
            .map(|state| !state.idle)
            .unwrap_or(false);
        let defer_echo = is_queued || is_command;

        let mut actions = Vec::new();
        if is_queued {
            actions.push(Action::QueuedMessage {
                session_id: session_id.to_string(),
                uuid: Some(uuid.clone()),
                content: content.to_string(),
            });
        }
        if !defer_echo {
            // 立即回显用户气泡（乐观渲染）：core 落盘时沿用同一个 uuid
            actions.push(Action::AddMessage(AddMessageData {
                session_id: session_id.to_string(),
                role: Some(Role::User),
                content: content.to_string(),
                message_uuid: Some(uuid.clone()),
                ..Default::default()
            }));
        }

        let mut event = json!({
            "type": "userMessageSubmitted",
            "sessionId": session_id,
            "content": content,
            "uuid": uuid,
            "workspacePath": self.workspace_path,
        });
        if let Some(model) = &overrides.model {
            if let Some(provider) = &overrides.provider {
                if !model.trim().is_empty() && !provider.trim().is_empty() {
                    event["model"] = json!({ "provider": provider, "model": model });
                }
            }
        }
        if let Some(mode) = &overrides.agent_mode {
            event["agentMode"] = json!(mode);
        }
        if let Some(mode) = &overrides.thinking_mode {
            event["thinkingMode"] = json!(mode);
        }
        if let Some(enabled) = overrides.web_search {
            event["webSearch"] = json!(enabled);
        }
        if defer_echo {
            event["deferEcho"] = json!(true);
        }
        self.emit(event);
        actions
    }

    // ==================== 历史映射 ====================

    /// CoreEvent `messagesReplaced` 的 MessageData 数组 → 消息列表。
    fn map_message_data_list(&mut self, records: &[Value]) -> Vec<TuiMessage> {
        let mapped: Vec<Option<AddMessageData>> = records.iter().map(add_message_data).collect();
        mapped
            .into_iter()
            .flatten()
            .map(|data| TuiMessage {
                id: self.ids.next_message_id(),
                role: data.role.unwrap_or(Role::System),
                content: data.content,
                tool_name: data.tool_name,
                tool_call_id: data.tool_call_id,
                status: data.status.unwrap_or(ToolStatus::Normal),
                context_tokens: data.context_tokens + data.output_tokens,
                message_uuid: data.message_uuid,
                is_compact_summary: data.is_compact_summary,
                stream_id: None,
            })
            .collect()
    }

    /// 磁盘历史（Anthropic 风格记录）→ 消息列表（对齐 webview 的渲染口径）：
    /// - 过滤 isMeta / silent（Skill 注入的 prompt 不显示）；
    /// - assistant 的 text / thinking / tool_use 块分别映射为 assistant / thinking / 工具卡片；
    /// - user 的 tool_result 块回填对应工具卡片的终态与输出。
    pub fn map_history(&mut self, records: &[Value]) -> Vec<TuiMessage> {
        let mut out: Vec<TuiMessage> = Vec::new();
        for record in records {
            if record.get("isMeta").and_then(Value::as_bool).unwrap_or(false)
                || record.get("silent").and_then(Value::as_bool).unwrap_or(false)
            {
                continue;
            }
            let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
            let message = record.get("message").cloned().unwrap_or(Value::Null);
            let is_compact_summary = record.get("isCompactSummary").and_then(Value::as_bool).unwrap_or(false);
            match kind {
                "user" => {
                    let uuid = record.get("uuid").and_then(Value::as_str).map(str::to_string);
                    match message.get("content") {
                        Some(Value::String(content)) => {
                            out.push(self.history_message(Role::User, content, uuid, is_compact_summary));
                        }
                        Some(Value::Array(blocks)) => {
                            let mut text = String::new();
                            for block in blocks {
                                match block.get("type").and_then(Value::as_str) {
                                    Some("text") => {
                                        if let Some(piece) = block.get("text").and_then(Value::as_str) {
                                            text.push_str(piece);
                                        }
                                    }
                                    Some("tool_result") => {
                                        self.attach_tool_result(&mut out, block);
                                    }
                                    _ => {}
                                }
                            }
                            if !text.is_empty() {
                                out.push(self.history_message(Role::User, &text, uuid, is_compact_summary));
                            }
                        }
                        _ => {}
                    }
                }
                "assistant" => {
                    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
                        continue;
                    };
                    let mut text = String::new();
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(piece) = block.get("text").and_then(Value::as_str) {
                                    text.push_str(piece);
                                }
                            }
                            Some("thinking") => {
                                let thinking = block
                                    .get("thinking")
                                    .and_then(Value::as_str)
                                    .or_else(|| block.get("text").and_then(Value::as_str))
                                    .unwrap_or("");
                                if !thinking.is_empty() {
                                    out.push(self.history_message(Role::Thinking, thinking, None, false));
                                }
                            }
                            Some("tool_use") => {
                                out.push(TuiMessage {
                                    id: self.ids.next_message_id(),
                                    role: Role::ToolCall,
                                    content: String::new(),
                                    tool_name: block.get("name").and_then(Value::as_str).map(str::to_string),
                                    tool_call_id: block.get("id").and_then(Value::as_str).map(str::to_string),
                                    status: ToolStatus::Normal,
                                    context_tokens: 0.0,
                                    message_uuid: None,
                                    is_compact_summary: false,
                                    stream_id: None,
                                });
                            }
                            _ => {}
                        }
                    }
                    if !text.is_empty() {
                        out.push(self.history_message(Role::Assistant, &text, None, false));
                    }
                }
                "system" => {
                    if let Some(content) = message.get("content").and_then(Value::as_str) {
                        out.push(self.history_message(Role::System, content, None, is_compact_summary));
                    }
                }
                _ => {}
            }
        }
        out
    }

    fn history_message(&mut self, role: Role, content: &str, uuid: Option<String>, is_compact_summary: bool) -> TuiMessage {
        TuiMessage {
            id: self.ids.next_message_id(),
            role,
            content: content.to_string(),
            tool_name: None,
            tool_call_id: None,
            status: ToolStatus::Normal,
            context_tokens: 0.0,
            message_uuid: uuid,
            is_compact_summary,
            stream_id: None,
        }
    }

    /// user 记录里的 tool_result 块 → 回填对应工具卡片的终态与输出
    /// （与实时路径的 toolResult 事件同语义）。
    fn attach_tool_result(&mut self, out: &mut [TuiMessage], block: &Value) {
        let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
            return;
        };
        let status = if block.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
            ToolStatus::Fail
        } else {
            ToolStatus::Success
        };
        let output = match block.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(items)) => items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        };
        if let Some(index) = out
            .iter()
            .position(|message| message.role == Role::ToolCall && message.tool_call_id.as_deref() == Some(tool_use_id))
        {
            out[index].status = status;
            out[index].content = output;
        }
    }
}

// ==================== 纯函数工具 ====================

/// wire `MessageData` → 渲染动作的载荷；形状不对（role 不认识等）返回 None 丢弃。
fn add_message_data(data: &Value) -> Option<AddMessageData> {
    let role = Role::parse(data.get("role").and_then(Value::as_str)?)?;
    Some(AddMessageData {
        session_id: String::new(),
        role: Some(role),
        content: data.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        tool_name: data.get("toolName").and_then(Value::as_str).map(str::to_string),
        tool_call_id: data.get("toolCallId").and_then(Value::as_str).map(str::to_string),
        status: data.get("status").and_then(Value::as_str).and_then(ToolStatus::parse),
        context_tokens: data.get("contextLength").and_then(Value::as_f64).unwrap_or(0.0),
        output_tokens: data.get("outputTokens").and_then(Value::as_f64).unwrap_or(0.0),
        message_uuid: data.get("messageUuid").and_then(Value::as_str).map(str::to_string),
        is_compact_summary: data.get("isCompactSummary").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// `skillsRequested` 应答 → 技能列表。
fn parse_skills(value: &Value) -> Vec<crate::store::SkillItem> {
    value
        .get("skills")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|skill| crate::store::SkillItem {
                    name: skill.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    description: skill.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                    is_builtin: skill.get("isBuiltin").and_then(Value::as_bool).unwrap_or(false),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `mcpServersRequested` 应答 → (name, enabled) 列表。
fn parse_mcp_servers(value: &Value) -> Vec<(String, bool)> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|server| {
                    let name = server.get("name").and_then(Value::as_str)?;
                    Some((name.to_string(), server.get("enabled").and_then(Value::as_bool).unwrap_or(false)))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 余额应答 → BalanceUpdate 动作（null → 清空余额，避免显示旧值）。
fn balance_action(_session_id: &str, value: &Value) -> Action {
    if value.is_null() {
        return Action::BalanceUpdate { total_balance: None, currency: None };
    }
    Action::BalanceUpdate {
        total_balance: value.get("totalBalance").and_then(Value::as_f64),
        currency: value.get("currency").and_then(Value::as_str).map(str::to_string),
    }
}

fn clear_balance(_session_id: &str) -> Action {
    Action::BalanceUpdate { total_balance: None, currency: None }
}

fn serialize_mcp_definition(definition: &McpServerDefinition) -> Value {
    json!({
        "name": definition.name,
        "type": definition.kind,
        "command": definition.command,
        "environment": definition.environment,
        "url": definition.url,
        "headers": definition.headers,
    })
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|line| match line {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn now_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

static RANDOM_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 短随机后缀（uuid 的廉价替代；uuid crate 只在会话 id 上使用）。
pub fn random_suffix() -> String {
    let counter = RANDOM_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}", now_millis() as u64 ^ (counter.wrapping_mul(0x9E37_79B9_7F4A_7C15)))
}

fn format_tokens(tokens: f64) -> String {
    if tokens >= 1000.0 {
        format!("{:.1}k", tokens / 1000.0)
    } else {
        format!("{}", tokens as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 空配置目录的 Host：settings.json / mcp.json 缺失按「未配置」继续，不碰真实用户目录。
    fn test_host(tag: &str) -> Host {
        let dir = std::env::temp_dir().join(format!(
            "tui-host-tests-{}-{tag}",
            std::process::id()
        ));
        Host::new(
            std::sync::Arc::new(Logger::new(None, false)),
            SettingsStore::with_dir(dir),
            "C:/work/alpha".to_string(),
            PathBuf::from("."),
        )
    }

    /// sessionConfigChanged 的 model 键带身份字段 `ref`（events.md 词汇表 / TS 宿主同口径）：
    /// 译层必须读 `ref`；读 `value` 会拿到 null、模型名显示回落 `…`
    /// （specs/defects/tui-sessionconfig-model-ref-mismatch）。
    #[test]
    fn session_config_model_reads_ref_field() {
        let mut host = test_host("model-ref");
        let actions = host.handle_event(&json!({
            "type": "sessionConfigChanged",
            "sessionId": "s1",
            "change": { "key": "model", "ref": { "model": "glm-4.7", "provider": "zhipu" } }
        }));
        match actions.as_slice() {
            [Action::SetModel { session_id, model, provider }] => {
                assert_eq!(session_id, "s1");
                assert_eq!(model, "glm-4.7");
                assert_eq!(provider.as_deref(), Some("zhipu"));
            }
            other => panic!("expected SetModel, got {other:?}"),
        }
    }

    /// 压缩完成后状态栏 tokens 采用 core 重算的 postCompactTokenCount（通知保留）。
    #[test]
    fn compact_end_updates_context_tokens() {
        let mut host = test_host("compact-tokens");
        let actions = host.handle_event(&json!({
            "type": "compactEnd",
            "sessionId": "s1",
            "result": { "status": "complete", "postCompactTokenCount": 30720 }
        }));
        assert!(
            actions.iter().any(|action| matches!(action,
                Action::SetContextTokens { session_id, tokens }
                    if session_id == "s1" && *tokens == 30_720.0
            )),
            "expected SetContextTokens, got {actions:?}"
        );
        // 压缩完成通知保留（带 tokens 数）
        assert!(actions.iter().any(|action| matches!(action, Action::Local(LocalAction::Notice { .. }))));
    }
}

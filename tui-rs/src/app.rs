//! 终端渲染与键盘路由（`src/tui/render/App.tsx` + `components/*` 的移植，ratatui 实现）。
//!
//! 职责收敛在三件事：
//! - 把 store（唯一渲染事实）投影成布局：通知条 / 消息流 / 状态栏 / 覆盖层 / 编辑器；
//! - 键盘路由：同一时刻只有一个交互面接键（优先级：文档/diff > 用户选择 > 菜单 > 编辑器）；
//! - 把用户操作翻译成 `Host` 的方法调用（上行进 core）。
//!
//! 覆盖层 / 菜单的导航状态（光标、过滤词、滚动偏移）是 UI 自己拥有的局部事实，
//! 不进 store；pending 的事实（待答选择、diff 内容）都在 store / host。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::composer::{self, EditorKey, EditorState};
use crate::host::{Host, SessionOverrides};
use crate::i18n::tt;
use crate::markdown::{self, MdColor, MdLine, MdSpan};
use crate::store::{
    active_session, runtime_dot, runtime_of, Action, LocalAction, NoticeLevel, Overlay,
    OverlayColor, Role, TuiMessage, TuiState, ToolStatus,
};

/// 渲染上限：超过后头部折叠（终端整帧重绘，超长历史会拖慢流式帧率）。
const MAX_RENDERED_MESSAGES: usize = 150;
/// 通知条最多显示条数 / 消散时限。
const MAX_NOTICES: usize = 3;
const NOTICE_TTL: Duration = Duration::from_millis(8000);
/// 文档 / diff 覆盖层的可见行数。
const OVERLAY_VISIBLE: usize = 24;
/// 编辑器最多渲染的行数（更早的行折叠）。
const COMPOSER_VISIBLE: usize = 6;
/// 列表菜单最多显示项数。
const MENU_VISIBLE: usize = 12;

/// 覆盖层栈以外的菜单状态（本地导航事实，不进 store）。
#[derive(Debug, Clone)]
enum Menu {
    Sessions,
    DeleteConfirm { session_id: String },
    Rename { session_id: String, value: String },
    Providers,
    Models { provider: String },
    Config,
    AgentMode,
    ThinkingMode,
    PromptMode,
    Mcp,
    Slash,
}

pub struct App {
    pub state: TuiState,
    pub host: Host,
    ids: crate::store::Ids,
    composer: EditorState,
    menu: Option<Menu>,
    menu_cursor: usize,
    menu_filter: String,
    choice_cursor: usize,
    choice_free_input: Option<String>,
    overlay_offset: usize,
    /// 斜杠菜单选择后回填编辑器的待注入文本（下一次 draw 消费）。
    preset: Option<String>,
    markdown_cache: HashMap<u64, (String, Vec<MdLine>)>,
    started: bool,
    exiting: bool,
}

impl App {
    pub fn new(host: Host) -> App {
        App {
            state: crate::store::initial_state(),
            host,
            ids: crate::store::Ids::new(),
            composer: composer::initial_editor(),
            menu: None,
            menu_cursor: 0,
            menu_filter: String::new(),
            choice_cursor: 0,
            choice_free_input: None,
            overlay_offset: 0,
            preset: None,
            markdown_cache: HashMap::new(),
            started: false,
            exiting: false,
        }
    }

    pub fn is_exiting(&self) -> bool {
        self.exiting
    }

    pub fn exit(&mut self) {
        self.exiting = true;
    }

    fn dispatch(&mut self, action: Action) {
        self.state = crate::store::reduce(&self.state, &mut self.ids, &action);
    }

    // ==================== 事件入口 ====================

    /// core 帧入口：译层产出动作 → store。
    pub fn handle_frame(&mut self, frame: crate::protocol::CoreToUiFrame) {
        let actions = self.host.handle_frame(frame);
        for action in actions {
            self.dispatch(action);
        }
        // Core 就绪之后执行挂载序列（拉全局事实 + 建立「新对话」会话）
        if !self.started && self.host.is_ready() {
            self.start();
        }
    }

    fn start(&mut self) {
        self.started = true;
        let actions = self.host.startup_fetches();
        for action in actions {
            self.dispatch(action);
        }
        self.start_new_conversation();
    }

    /// core 进程退出。
    pub fn handle_core_exited(&mut self) {
        let actions = self.host.reset_connection();
        for action in actions {
            self.dispatch(action);
        }
    }

    /// 定时器：通知按时效消散。
    pub fn tick(&mut self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let expired: Vec<u64> = self
            .state
            .notices
            .iter()
            .filter(|notice| now.saturating_sub(notice.at_ms) > NOTICE_TTL.as_millis())
            .map(|notice| notice.id)
            .collect();
        for id in expired {
            self.dispatch(Action::Local(LocalAction::DismissNotice(id)));
        }
        // 斜杠菜单选择后回填编辑器（外部注入文本）
        if let Some(text) = self.preset.take() {
            self.composer = composer::insert_text(&self.composer, &text);
        }
    }

    // ==================== 键盘路由 ====================

    pub fn handle_key(&mut self, key: KeyEvent) {
        // Ctrl+C 退出（Ink 的 exitOnCtrlC 同语义；退出路径由 main 发 shutdown 帧）
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.exit();
            return;
        }

        let focus = if self.state.overlay.is_some() {
            Focus::Overlay
        } else if self.state.pending_choice.is_some() {
            Focus::Choice
        } else if self.menu.is_some() {
            Focus::Menu
        } else {
            Focus::Composer
        };

        match focus {
            Focus::Overlay => self.handle_overlay_key(key),
            Focus::Choice => self.handle_choice_key(key),
            Focus::Menu => self.handle_menu_key(key),
            Focus::Composer => self.handle_composer_key(key),
        }
    }

    /// Ctrl+L / Ctrl+M / Ctrl+K 在任何焦点下都可呼出菜单（文档/diff 覆盖层除外）。
    fn try_global_menu_shortcut(&mut self, key: KeyEvent) -> bool {
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('l') => {
                    self.open_menu(Menu::Sessions);
                    return true;
                }
                KeyCode::Char('m') => {
                    self.open_menu(Menu::Providers);
                    return true;
                }
                KeyCode::Char('k') => {
                    self.open_menu(Menu::Config);
                    return true;
                }
                _ => {}
            }
        }
        false
    }

    fn open_menu(&mut self, menu: Menu) {
        let pulls_mcp = matches!(menu, Menu::Mcp);
        self.menu = Some(menu);
        self.menu_cursor = 0;
        self.menu_filter.clear();
        // 打开 MCP 菜单时拉取一次服务器列表（按会话解析启用状态）
        if pulls_mcp {
            self.host.request_mcp_servers(self.state.active_session_id.clone());
        }
    }

    fn handle_overlay_key(&mut self, key: KeyEvent) {
        let Some(overlay) = self.state.overlay.clone() else { return };
        let max_offset = overlay.lines.len().saturating_sub(OVERLAY_VISIBLE);
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => self.dispatch(Action::Local(LocalAction::CloseOverlay)),
            KeyCode::Down | KeyCode::Char('j') => {
                self.overlay_offset = (self.overlay_offset + 1).min(max_offset);
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.overlay_offset = self.overlay_offset.saturating_sub(1);
            }
            KeyCode::PageDown => {
                self.overlay_offset = (self.overlay_offset + OVERLAY_VISIBLE).min(max_offset);
            }
            KeyCode::PageUp => {
                self.overlay_offset = self.overlay_offset.saturating_sub(OVERLAY_VISIBLE);
            }
            _ => {}
        }
    }

    fn handle_choice_key(&mut self, key: KeyEvent) {
        let Some(choice) = self.state.pending_choice.clone() else { return };
        if self.choice_free_input.is_none() {
            match key.code {
                KeyCode::Esc => self.choice_free_input = Some(String::new()),
                KeyCode::Enter => self.respond_choice(choice.choice_id.clone(), self.choice_cursor as i64, None),
                KeyCode::Up => {
                    self.choice_cursor = if self.choice_cursor > 0 {
                        self.choice_cursor - 1
                    } else {
                        choice.choices.len().saturating_sub(1)
                    };
                }
                KeyCode::Down => {
                    self.choice_cursor = if self.choice_cursor < choice.choices.len().saturating_sub(1) {
                        self.choice_cursor + 1
                    } else {
                        0
                    };
                }
                KeyCode::Char(character)
                    if !key.modifiers.contains(KeyModifiers::CONTROL)
                        && !key.modifiers.contains(KeyModifiers::ALT) =>
                {
                    // 数字选择（1..n）
                    if let Some(digit) = character.to_digit(10) {
                        let index = digit as usize;
                        if index >= 1 && index <= choice.choices.len() {
                            self.respond_choice(choice.choice_id.clone(), (index - 1) as i64, None);
                        }
                    }
                }
                _ => {}
            }
            return;
        }
        // 自由输入模式：Esc 转回选项；Enter 提交 `{ index: -1, reply }`（与 webview 同语义）
        let input = self.choice_free_input.as_mut().unwrap();
        match key.code {
            KeyCode::Esc => self.choice_free_input = None,
            KeyCode::Enter => {
                let text = input.trim().to_string();
                if !text.is_empty() {
                    self.respond_choice(choice.choice_id.clone(), -1, Some(text));
                }
            }
            KeyCode::Backspace => {
                input.pop();
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                input.push(character);
            }
            _ => {}
        }
    }

    fn respond_choice(&mut self, choice_id: String, index: i64, reply: Option<String>) {
        self.choice_free_input = None;
        self.choice_cursor = 0;
        let actions = self.host.respond_choice(&choice_id, index, reply);
        for action in actions {
            self.dispatch(action);
        }
    }

    fn handle_menu_key(&mut self, key: KeyEvent) {
        // 重命名走单行输入，不吃菜单的导航键
        if matches!(self.menu, Some(Menu::Rename { .. })) {
            self.handle_rename_key(key);
            return;
        }

        if self.try_global_menu_shortcut(key) {
            return;
        }

        let items = self.menu_items();
        let filtered = filter_items(&items, &self.menu_filter);
        match key.code {
            KeyCode::Esc => self.menu_escape(),
            KeyCode::Enter => {
                if let Some(item) = filtered.get(self.menu_cursor.min(filtered.len().saturating_sub(1))) {
                    self.select_menu_item(item.clone());
                }
            }
            KeyCode::Up => {
                self.menu_cursor = if self.menu_cursor > 0 {
                    self.menu_cursor - 1
                } else {
                    filtered.len().saturating_sub(1)
                };
            }
            KeyCode::Down => {
                self.menu_cursor = if self.menu_cursor < filtered.len().saturating_sub(1) {
                    self.menu_cursor + 1
                } else {
                    0
                };
            }
            KeyCode::Backspace => {
                self.menu_filter.pop();
                self.menu_cursor = 0;
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                self.menu_filter.push(character);
                self.menu_cursor = 0;
            }
            _ => {}
        }
    }

    fn handle_rename_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.close_menu(),
            KeyCode::Enter => {
                if let Some(Menu::Rename { session_id, value }) = self.menu.clone() {
                    self.host.rename_conversation(&session_id, &value);
                    self.close_menu();
                }
            }
            KeyCode::Backspace => {
                if let Some(Menu::Rename { value, .. }) = self.menu.as_mut() {
                    value.pop();
                }
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && !key.modifiers.contains(KeyModifiers::ALT) =>
            {
                if let Some(Menu::Rename { value, .. }) = self.menu.as_mut() {
                    value.push(character);
                }
            }
            _ => {}
        }
    }

    fn menu_escape(&mut self) {
        // 二级菜单 Esc 逐级返回
        match self.menu.clone() {
            Some(Menu::Models { .. })
            | Some(Menu::AgentMode)
            | Some(Menu::ThinkingMode)
            | Some(Menu::PromptMode)
            | Some(Menu::Mcp) => self.open_menu(Menu::Config),
            _ => self.close_menu(),
        }
    }

    fn close_menu(&mut self) {
        self.menu = None;
        self.menu_cursor = 0;
        self.menu_filter.clear();
    }

    fn select_menu_item(&mut self, item: MenuItem) {
        let Some(menu) = self.menu.clone() else { return };
        match menu {
            Menu::Sessions => match item.key.as_str() {
                "__new__" => self.start_new_conversation(),
                "__rename__" => {
                    let session_id = self.state.active_session_id.clone().unwrap_or_default();
                    let initial = active_session(&self.state)
                        .and_then(|session| session.title.clone())
                        .unwrap_or_default();
                    self.menu = Some(Menu::Rename { session_id, value: initial });
                    self.menu_cursor = 0;
                    self.menu_filter.clear();
                }
                "__smart__" => {
                    if let Some(session_id) = self.state.active_session_id.clone() {
                        self.host.request_smart_naming(&session_id);
                    }
                    self.close_menu();
                }
                "__delete__" => {
                    if let Some(session_id) = self.state.active_session_id.clone() {
                        self.menu = Some(Menu::DeleteConfirm { session_id });
                        self.menu_cursor = 0;
                        self.menu_filter.clear();
                    }
                }
                _ => self.open_conversation(&item.key),
            },
            Menu::DeleteConfirm { session_id } => {
                if item.key == "delete" {
                    let actions = self.host.delete_conversation(&session_id);
                    for action in actions {
                        self.dispatch(action);
                    }
                    if self.state.active_session_id.as_deref() == Some(session_id.as_str()) {
                        self.close_menu();
                        self.start_new_conversation();
                        return;
                    }
                }
                self.close_menu();
            }
            Menu::Rename { .. } => {}
            Menu::Providers => {
                self.menu = Some(Menu::Models { provider: item.key });
                self.menu_cursor = 0;
                self.menu_filter.clear();
            }
            Menu::Models { provider } => {
                if let Some(session_id) = self.state.active_session_id.clone() {
                    self.host.set_model(&session_id, &item.key, &provider);
                }
                self.close_menu();
            }
            Menu::Config => match item.key.as_str() {
                "compact" => {
                    if let Some(session_id) = self.state.active_session_id.clone() {
                        self.host.request_compress(&session_id);
                    }
                    self.close_menu();
                }
                // webSearch 只是状态展示项（TS 同口径），其余四项开二级菜单
                "agentMode" | "thinkingMode" | "promptMode" | "mcp" => {
                    self.menu = Some(match item.key.as_str() {
                        "agentMode" => Menu::AgentMode,
                        "thinkingMode" => Menu::ThinkingMode,
                        "promptMode" => Menu::PromptMode,
                        _ => Menu::Mcp,
                    });
                    self.menu_cursor = 0;
                    self.menu_filter.clear();
                    if matches!(self.menu, Some(Menu::Mcp)) {
                        self.host.request_mcp_servers(self.state.active_session_id.clone());
                    }
                }
                _ => self.close_menu(),
            },
            Menu::AgentMode => {
                if let Some(session_id) = self.state.active_session_id.clone() {
                    self.host.set_agent_mode(&session_id, &item.key);
                }
                self.close_menu();
            }
            Menu::ThinkingMode => {
                if let Some(session_id) = self.state.active_session_id.clone() {
                    self.host.set_thinking_mode(&session_id, &item.key);
                }
                self.close_menu();
            }
            Menu::PromptMode => {
                if let Some(session_id) = self.state.active_session_id.clone() {
                    self.host.set_prompt_mode(&session_id, &item.key);
                }
                self.close_menu();
            }
            Menu::Mcp => {
                if let Some(session_id) = self.state.active_session_id.clone() {
                    let enabled = item.hint.as_deref() != Some("[✓]");
                    self.host.set_mcp_enabled(&session_id, &item.key, enabled);
                    self.host.request_mcp_servers(self.state.active_session_id.clone());
                }
                // 保持菜单开着，连续切换
            }
            Menu::Slash => {
                // 选择后回填 `/name `（发送时按普通消息交给 core 分发）
                self.preset = Some(format!("{} ", item.key));
                self.close_menu();
            }
        }
    }

    fn start_new_conversation(&mut self) {
        let session_id = uuid::Uuid::new_v4().to_string();
        self.dispatch(Action::Local(LocalAction::ActivateSession(Some(session_id.clone()))));
        let actions = self.host.new_conversation(&session_id);
        for action in actions {
            self.dispatch(action);
        }
    }

    fn open_conversation(&mut self, session_id: &str) {
        self.dispatch(Action::Local(LocalAction::ActivateSession(Some(session_id.to_string()))));
        let actions = self.host.load_conversation(session_id);
        for action in actions {
            self.dispatch(action);
        }
        self.close_menu();
    }

    fn handle_composer_key(&mut self, key: KeyEvent) {
        if self.try_global_menu_shortcut(key) {
            return;
        }
        match key.code {
            KeyCode::Enter => self.submit_message(),
            KeyCode::Esc => {
                // 编辑器有内容时清空；无内容时中止当前会话查询
                if self.composer.is_empty() {
                    if let Some(session_id) = self.state.active_session_id.clone() {
                        self.host.abort(&session_id);
                    }
                } else {
                    self.composer = composer::initial_editor();
                }
            }
            KeyCode::Backspace => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { backspace: true, ..Default::default() })
            }
            KeyCode::Delete => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { delete: true, ..Default::default() })
            }
            KeyCode::Left => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { left: true, ..Default::default() })
            }
            KeyCode::Right => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { right: true, ..Default::default() })
            }
            KeyCode::Up => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { up: true, ..Default::default() })
            }
            KeyCode::Down => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { down: true, ..Default::default() })
            }
            KeyCode::Tab => {
                self.composer =
                    composer::apply_key(&self.composer, "", &EditorKey { tab: true, ..Default::default() })
            }
            KeyCode::Char(character) => {
                let control = key.modifiers.contains(KeyModifiers::CONTROL);
                let alt = key.modifiers.contains(KeyModifiers::ALT);
                if control && (character == 'o' || character == 'j') {
                    self.composer = composer::insert_newline(&self.composer);
                    return;
                }
                if control && character == 'u' {
                    self.composer = composer::clear_line(&self.composer);
                    return;
                }
                // 空编辑器按 '/'：打开斜杠命令菜单（菜单选择后回填）
                if character == '/' && !control && !alt && self.composer.is_empty() {
                    self.composer = composer::insert_text(&self.composer, "/");
                    self.open_menu(Menu::Slash);
                    return;
                }
                let chunk = if control || alt { String::new() } else { character.to_string() };
                self.composer = composer::apply_key(
                    &self.composer,
                    &chunk,
                    &EditorKey { ctrl: control, alt, ..Default::default() },
                );
            }
            _ => {}
        }
    }

    /// 粘贴（bracketed paste）：多行文本原样插入。
    pub fn handle_paste(&mut self, text: &str) {
        self.composer = composer::apply_key(&self.composer, text, &EditorKey::default());
    }

    fn submit_message(&mut self) {
        let text = self.composer.text();
        if text.trim().is_empty() {
            return;
        }
        let Some(session_id) = self.state.active_session_id.clone() else { return };
        // 会话配置带上已到达的事实；未到达的字段不猜（None 即不覆盖）
        let overrides = active_session(&self.state)
            .map(|session| SessionOverrides {
                model: session.model.clone().filter(|model| !model.trim().is_empty()),
                provider: session
                    .provider
                    .clone()
                    .filter(|_| session.model.as_deref().map(str::trim).map(str::len).unwrap_or(0) > 0)
                    .filter(|provider| !provider.trim().is_empty()),
                agent_mode: session.agent_mode.clone(),
                thinking_mode: session.thinking_mode.clone(),
                web_search: session.web_search,
            })
            .unwrap_or_default();
        self.composer = composer::initial_editor();
        let actions = self.host.submit_message(&session_id, &text, &overrides);
        for action in actions {
            self.dispatch(action);
        }
    }

    // ==================== 菜单项构造 ====================

    fn menu_items(&self) -> Vec<MenuItem> {
        match self.menu.as_ref() {
            Some(Menu::Sessions) => {
                let mut items =
                    vec![MenuItem { key: "__new__".into(), label: tt("＋ 新建对话", "+ New conversation"), hint: None }];
                let mut sorted = self.state.conversations.clone();
                sorted.sort_by(|a, b| b.updated_at.partial_cmp(&a.updated_at).unwrap_or(std::cmp::Ordering::Equal));
                for conversation in sorted.iter().take(30) {
                    let runtime = self
                        .state
                        .runtime_states
                        .iter()
                        .find(|state| state.session_id == conversation.session_id);
                    let dot = match runtime {
                        Some(state) if state.query_running => "● ",
                        Some(state) if state.waiting => "◑ ",
                        _ => "",
                    };
                    items.push(MenuItem {
                        key: conversation.session_id.clone(),
                        label: format!("{dot}{}", conversation.title),
                        hint: Some(format!(
                            "{} · {}",
                            format_date(conversation.updated_at),
                            conversation.message_count
                        )),
                    });
                }
                items.push(MenuItem { key: "__rename__".into(), label: tt("重命名当前会话", "Rename current session"), hint: None });
                items.push(MenuItem { key: "__smart__".into(), label: tt("智能命名当前会话", "Smart-name current session"), hint: None });
                items.push(MenuItem { key: "__delete__".into(), label: tt("删除当前会话", "Delete current session"), hint: None });
                items
            }
            Some(Menu::DeleteConfirm { .. }) => vec![
                MenuItem { key: "cancel".into(), label: tt("取消", "Cancel"), hint: None },
                MenuItem { key: "delete".into(), label: tt("删除", "Delete"), hint: None },
            ],
            Some(Menu::Providers) => self
                .state
                .models
                .as_ref()
                .map(|models| {
                    models
                        .providers
                        .iter()
                        .map(|(key, provider_models)| MenuItem {
                            key: key.clone(),
                            label: key.clone(),
                            hint: Some(provider_models.len().to_string()),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Some(Menu::Models { provider }) => self
                .state
                .models
                .as_ref()
                .and_then(|models| models.providers.iter().find(|(key, _)| key == provider))
                .map(|(_, provider_models)| {
                    provider_models
                        .iter()
                        .map(|model| MenuItem { key: model.clone(), label: model.clone(), hint: None })
                        .collect()
                })
                .unwrap_or_default(),
            Some(Menu::Config) => {
                let session = active_session(&self.state);
                let mode_value = |value: Option<&String>| value.map(|text| text.to_string()).unwrap_or_else(|| "-".to_string());
                vec![
                    MenuItem {
                        key: "agentMode".into(),
                        label: format!(
                            "{}: {}",
                            tt("代理模式", "Agent mode"),
                            mode_value(session.and_then(|session| session.agent_mode.as_ref()))
                        ),
                        hint: Some("manual/risk/auto".into()),
                    },
                    MenuItem {
                        key: "thinkingMode".into(),
                        label: format!(
                            "{}: {}",
                            tt("思考强度", "Thinking"),
                            mode_value(session.and_then(|session| session.thinking_mode.as_ref()))
                        ),
                        hint: Some("off/low/high/max".into()),
                    },
                    MenuItem {
                        key: "promptMode".into(),
                        label: format!(
                            "{}: {}",
                            tt("提示词模式", "Prompt mode"),
                            mode_value(session.and_then(|session| session.prompt_mode.as_ref()))
                        ),
                        hint: Some("normal/minimal/mixed".into()),
                    },
                    MenuItem {
                        key: "webSearch".into(),
                        label: format!(
                            "{}: {}",
                            tt("联网搜索", "Web search"),
                            session
                                .and_then(|session| session.web_search)
                                .map(|enabled| if enabled { "on".to_string() } else { "off".to_string() })
                                .unwrap_or_else(|| "-".into())
                        ),
                        hint: None,
                    },
                    MenuItem { key: "mcp".into(), label: tt("MCP 服务器", "MCP servers"), hint: None },
                    MenuItem { key: "compact".into(), label: tt("压缩上下文", "Compact context"), hint: None },
                ]
            }
            Some(Menu::AgentMode) => ["manual", "risk", "auto"]
                .iter()
                .map(|mode| MenuItem { key: (*mode).into(), label: (*mode).into(), hint: None })
                .collect(),
            Some(Menu::ThinkingMode) => ["off", "low", "high", "max"]
                .iter()
                .map(|mode| MenuItem { key: (*mode).into(), label: (*mode).into(), hint: None })
                .collect(),
            Some(Menu::PromptMode) => ["normal", "minimal", "mixed"]
                .iter()
                .map(|mode| MenuItem { key: (*mode).into(), label: (*mode).into(), hint: None })
                .collect(),
            Some(Menu::Mcp) => self
                .state
                .mcp_servers
                .as_ref()
                .map(|servers| {
                    servers
                        .iter()
                        .map(|(name, enabled)| MenuItem {
                            key: name.clone(),
                            label: name.clone(),
                            hint: Some(if *enabled { "[✓]".into() } else { "[ ]".into() }),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            Some(Menu::Slash) => self
                .state
                .skills
                .iter()
                .map(|skill| MenuItem {
                    key: skill.name.clone(),
                    label: format!("/{}", skill.name),
                    hint: Some(skill.description.clone()),
                })
                .collect(),
            Some(Menu::Rename { .. }) | None => Vec::new(),
        }
    }

    // ==================== 渲染 ====================

    pub fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();

        let notice_count = self.state.notices.len().min(MAX_NOTICES);
        let composer_height = self.composer_height();
        let overlay_height = self.overlay_height(area.height);

        let chunks = Layout::vertical([
            Constraint::Length(notice_count as u16),
            Constraint::Min(0),
            Constraint::Length(1),
            Constraint::Length(overlay_height),
            Constraint::Length(composer_height),
        ])
        .split(area);

        self.draw_notices(frame, chunks[0]);
        self.draw_messages(frame, chunks[1]);
        self.draw_status_bar(frame, chunks[2]);
        if overlay_height > 0 {
            self.draw_overlay(frame, chunks[3]);
        }
        self.draw_composer(frame, chunks[4]);
    }

    fn composer_height(&self) -> u16 {
        if self.composer.is_empty() {
            4 // 边框 2 + 占位 1 + 提示 1
        } else {
            let visible = self.composer.lines.len().min(COMPOSER_VISIBLE);
            let hidden = self.composer.lines.len().saturating_sub(COMPOSER_VISIBLE);
            (visible as u16) + 2 + 1 + u16::from(hidden > 0)
        }
    }

    fn overlay_height(&self, total: u16) -> u16 {
        let height = match self.menu.as_ref() {
            Some(Menu::Rename { .. }) => 5,
            Some(_) => {
                let items = self.menu_items();
                let filtered = filter_items(&items, &self.menu_filter).len();
                let filter_line = u16::from(!self.menu_filter.is_empty());
                let more_line = u16::from(filtered > MENU_VISIBLE);
                filtered.min(MENU_VISIBLE) as u16 + 2 /* 标题+帮助 */ + filter_line + more_line + 2 /* 边框 */
            }
            None => 0,
        };
        // 消息流至少留 1 行
        height.min(total.saturating_sub(6))
    }

    fn draw_notices(&mut self, frame: &mut Frame, area: Rect) {
        if area.height == 0 {
            return;
        }
        let lines: Vec<Line> = self
            .state
            .notices
            .iter()
            .rev()
            .take(MAX_NOTICES)
            .rev()
            .map(|notice| {
                let color = match notice.level {
                    NoticeLevel::Info => Color::Green,
                    NoticeLevel::Warn => Color::Yellow,
                    NoticeLevel::Error => Color::Red,
                };
                Line::from(Span::styled(format!("≡ {}", notice.text), Style::new().fg(color)))
            })
            .collect();
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn draw_messages(&mut self, frame: &mut Frame, area: Rect) {
        let mut lines: Vec<Line> = Vec::new();
        match self.state.active_session_id.as_deref().and_then(|id| self.state.sessions.get(id)) {
            None => {
                lines.push(dim_line(tt("尚未打开会话。", "No conversation open yet.")));
                lines.push(dim_line(tt("Ctrl+L 选择 / 新建会话", "Ctrl+L to pick / start a conversation")));
            }
            Some(session) => {
                // 先拷贝渲染窗口所需的数据：markdown 渲染要走缓存（&mut），不与
                // store 的不可变借用重叠
                let skip = session.messages.len().saturating_sub(MAX_RENDERED_MESSAGES);
                let window: Vec<TuiMessage> = session.messages[skip..].to_vec();
                let stream = session.stream.clone();
                let show_thinking = session.show_thinking;
                let queued = session.queued.clone();

                if skip > 0 {
                    lines.push(dim_line(format!("… (+{skip} {})", tt("更早的消息", "earlier messages"))));
                }
                for message in &window {
                    lines.extend(self.message_lines(message));
                }
                // 流式块
                if let Some(stream) = stream {
                    match stream.role {
                        Role::Thinking => {
                            let last = stream.text.lines().last().unwrap_or("");
                            lines.push(Line::from(vec![
                                Span::styled(format!("{} ", tt("· 思考中…", "· thinking…")), dim_italic()),
                                Span::styled(last.to_string(), dim_style()),
                            ]));
                        }
                        _ => lines.extend(markdown_lines_uncached(&stream.text)),
                    }
                } else if show_thinking {
                    lines.push(Line::from(vec![
                        Span::styled(spinner_char().to_string(), Style::new().fg(Color::Cyan)),
                        Span::raw(format!(" {}", tt("思考中…", "Thinking…"))),
                    ]));
                }
                if let Some(queued) = queued {
                    lines.push(Line::from(vec![
                        Span::styled(format!("{}: ", tt("排队中", "Queued")), Style::new().fg(Color::Magenta)),
                        Span::styled(queued.content, dim_style()),
                    ]));
                }
            }
        }

        // 只渲染尾部（消息流追加式增长，Ink 同为「最新内容可见」）
        let visible_lines = area.height as usize;
        let skip_lines = lines.len().saturating_sub(visible_lines);
        let shown: Vec<Line> = lines.into_iter().skip(skip_lines).collect();
        frame.render_widget(Paragraph::new(shown), area);
    }

    /// 单条消息 → 终端行（按角色分形；组件是 store 的纯投影）。
    fn message_lines(&mut self, message: &TuiMessage) -> Vec<Line<'static>> {
        match message.role {
            Role::User => vec![Line::from(vec![
                Span::styled(
                    format!("{}: ", tt("你", "You")),
                    Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                Span::raw(message.content.clone()),
            ])],
            Role::Assistant => markdown_lines_cached(&message.content, &mut self.markdown_cache, message.id),
            Role::Thinking => {
                let first_line = message.content.lines().next().unwrap_or("");
                let preview: String = if first_line.chars().count() > 80 {
                    let truncated: String = first_line.chars().take(80).collect();
                    format!("{truncated}…")
                } else {
                    first_line.to_string()
                };
                vec![Line::from(vec![
                    Span::styled(format!("{} ", tt("· 思考", "· thinking")), dim_italic()),
                    Span::styled(preview, dim_style()),
                ])]
            }
            Role::System => vec![Line::from(vec![
                Span::styled(format!("{}: ", tt("系统", "system")), Style::new().fg(Color::Yellow)),
                Span::styled(message.content.clone(), Style::new().fg(Color::Yellow)),
            ])],
            Role::ToolCall => {
                let mut lines: Vec<Line> = Vec::new();
                let icon = match message.status {
                    ToolStatus::Running => Span::styled(spinner_char().to_string(), Style::new().fg(Color::Cyan)),
                    ToolStatus::Success => Span::styled("✓ ", Style::new().fg(Color::Green)),
                    ToolStatus::Fail => Span::styled("✗ ", Style::new().fg(Color::Red)),
                    ToolStatus::Normal => Span::styled("· ", Style::new().fg(Color::Gray)),
                };
                let name_color = if message.status == ToolStatus::Fail { Color::Red } else { Color::White };
                lines.push(Line::from(vec![
                    icon,
                    Span::styled(
                        message.tool_name.clone().unwrap_or_else(|| "tool".into()),
                        Style::new().fg(name_color).add_modifier(Modifier::BOLD),
                    ),
                ]));
                let content_lines: Vec<&str> = message.content.lines().filter(|line| !line.is_empty()).collect();
                let shown = content_lines.len().min(4);
                for line in &content_lines[..shown] {
                    lines.push(Line::from(Span::styled(format!("  {line}"), dim_style())));
                }
                let hidden = content_lines.len() - shown;
                if hidden > 0 {
                    lines.push(dim_line(format!("  … (+{} {})", hidden, tt("行", "lines"))));
                }
                lines
            }
        }
    }

    fn draw_status_bar(&mut self, frame: &mut Frame, area: Rect) {
        let session = self
            .state
            .active_session_id
            .as_deref()
            .and_then(|id| self.state.sessions.get(id));
        let runtime = runtime_of(&self.state, self.state.active_session_id.as_deref());
        let runtime_name = runtime.map(|state| state.label()).unwrap_or("");
        let dir_name = self
            .host
            .workspace_path()
            .rsplit(['\\', '/'])
            .find(|piece| !piece.is_empty())
            .unwrap_or("")
            .to_string();
        let model = session
            .and_then(|session| session.model.clone())
            .or_else(|| self.state.settings_defaults.as_ref().map(|defaults| defaults.model.clone()))
            .filter(|model| !model.is_empty())
            .unwrap_or_else(|| "…".into());

        let mut spans: Vec<Span> = vec![
            Span::styled(dir_name, Style::new().fg(Color::Blue)),
            Span::styled(" │ ", dim_style()),
            Span::raw(model),
        ];
        if let Some(session) = session {
            if let Some(mode) = &session.agent_mode {
                let color = match mode.as_str() {
                    "auto" => Color::Red,
                    "risk" => Color::Yellow,
                    _ => Color::Green,
                };
                spans.push(Span::styled(format!(" {mode}"), Style::new().fg(color)));
            }
            if let Some(mode) = &session.thinking_mode {
                if mode != "off" {
                    spans.push(Span::styled(format!(" ✦{mode}"), Style::new().fg(Color::Magenta)));
                }
            }
            if session.web_search == Some(true) {
                spans.push(Span::styled(" ⌕web", Style::new().fg(Color::Cyan)));
            }
        }
        spans.push(Span::styled(" │ ", dim_style()));
        let dot_color = match runtime_name {
            "waiting" => Color::Yellow,
            "running" => Color::Cyan,
            "compacting" | "background" | "subagent" => Color::Magenta,
            _ => Color::Green,
        };
        spans.push(Span::styled(runtime_dot(runtime).to_string(), Style::new().fg(dot_color)));
        if !runtime_name.is_empty() {
            spans.push(Span::styled(format!(" {runtime_name}"), dim_style()));
        }
        spans.push(Span::styled(" │ ", dim_style()));
        let context = session.map(|session| session.context_tokens).unwrap_or(0.0);
        let max = self
            .state
            .max_context_tokens
            .map(|max| format!("/{}", format_tokens(max)))
            .unwrap_or_default();
        spans.push(Span::styled(format!("{}{max} tok", format_tokens(context)), dim_style()));
        if let Some((total, _)) = &self.state.balance {
            spans.push(Span::styled(format!(" │ ${total:.2}"), dim_style()));
        }

        let bar = Paragraph::new(Line::from(spans)).block(
            Block::new()
                .borders(Borders::TOP)
                .border_style(Style::new().fg(Color::Gray)),
        );
        frame.render_widget(bar, area);
    }

    fn draw_overlay(&mut self, frame: &mut Frame, area: Rect) {
        // 优先级：文档/diff 覆盖层 > 用户选择 > 菜单（同一时刻只有一个交互面接键）
        if let Some(overlay) = self.state.overlay.clone() {
            self.draw_document_overlay(frame, area, &overlay);
            return;
        }
        if let Some(choice) = self.state.pending_choice.clone() {
            self.draw_choice_overlay(frame, area, &choice);
            return;
        }
        self.draw_menu_overlay(frame, area);
    }

    fn draw_document_overlay(&mut self, frame: &mut Frame, area: Rect, overlay: &Overlay) {
        let total = overlay.lines.len();
        let offset = self.overlay_offset.min(total.saturating_sub(OVERLAY_VISIBLE));
        let end = (offset + OVERLAY_VISIBLE).min(total);
        let mut lines: Vec<Line> = overlay.lines[offset..end]
            .iter()
            .map(|line| {
                let color = match line.color {
                    OverlayColor::Green => Some(Color::Green),
                    OverlayColor::Red => Some(Color::Red),
                    OverlayColor::Cyan => Some(Color::Cyan),
                    OverlayColor::Yellow => Some(Color::Yellow),
                    OverlayColor::Gray => Some(Color::Gray),
                    OverlayColor::White => None,
                };
                let mut style = Style::new();
                if let Some(color) = color {
                    style = style.fg(color);
                }
                Line::from(Span::styled(
                    if line.text.is_empty() { " ".to_string() } else { line.text.clone() },
                    style,
                ))
            })
            .collect();
        // 底部帮助行占一行（内容区少一行）
        if let Some(help) = lines.last_mut() {
            let _ = help;
        }
        lines.push(Line::from(Span::styled(
            tt("j/k/↑↓ 滚动 · PgUp/PgDn 翻页 · q/Esc 关闭", "j/k/↑↓ scroll · PgUp/PgDn page · q/Esc close"),
            dim_style(),
        )));
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Color::Magenta))
            .title(Span::styled(
                format!("{}  ({}/{})", overlay.title, (offset + 1).min(total.max(1)), total),
                Style::new().fg(Color::Magenta).add_modifier(Modifier::BOLD),
            ));
        frame.render_widget(Paragraph::new(lines).block(block).wrap(Wrap { trim: false }), area);
    }

    fn draw_choice_overlay(&mut self, frame: &mut Frame, area: Rect, choice: &crate::store::PendingChoice) {
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Line::from(Span::styled(
            format!(
                "{}{}",
                if choice.tool_name.is_empty() {
                    String::new()
                } else {
                    format!("[{}] ", choice.tool_name)
                },
                choice.message
            ),
            Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
        )));
        if self.choice_free_input.is_none() {
            for (index, item) in choice.choices.iter().enumerate() {
                let selected = index == self.choice_cursor;
                let mut spans = vec![
                    Span::styled(
                        if selected { "❯ " } else { "  " },
                        Style::new().fg(if selected { Color::Yellow } else { Color::Gray }),
                    ),
                    Span::styled(
                        item.label.clone(),
                        Style::new().fg(if selected { Color::White } else { Color::Gray }),
                    ),
                ];
                if let Some(description) = &item.description {
                    spans.push(Span::styled(format!("  {description}"), dim_style()));
                }
                lines.push(Line::from(spans));
            }
            lines.push(Line::from(Span::styled(
                tt("↑↓/数字 选择 · Enter 确认 · Esc 转自由输入", "↑↓/digit select · Enter confirm · Esc free input"),
                dim_style(),
            )));
        } else {
            let input = self.choice_free_input.clone().unwrap_or_default();
            lines.push(Line::from(vec![
                Span::raw(input),
                Span::styled("▌", Style::new().fg(Color::Yellow)),
            ]));
            lines.push(Line::from(Span::styled(
                tt("Enter 提交 · Esc 返回选项", "Enter submit · Esc back to options"),
                dim_style(),
            )));
        }
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Color::Yellow));
        frame.render_widget(Paragraph::new(lines).block(block), area);
    }

    fn draw_menu_overlay(&mut self, frame: &mut Frame, area: Rect) {
        let Some(menu) = self.menu.clone() else { return };
        if matches!(menu, Menu::Rename { .. }) {
            if let Menu::Rename { value, .. } = &menu {
                let lines = vec![
                    Line::from(Span::styled(
                        tt("重命名会话", "Rename conversation"),
                        Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                    )),
                    Line::from(vec![
                        Span::raw(value.clone()),
                        Span::styled("▌", Style::new().fg(Color::Cyan)),
                    ]),
                    Line::from(Span::styled(tt("Enter 提交 · Esc 取消", "Enter submit · Esc cancel"), dim_style())),
                ];
                let block = Block::new()
                    .borders(Borders::ALL)
                    .border_type(BorderType::Rounded)
                    .border_style(Style::new().fg(Color::Cyan));
                frame.render_widget(Paragraph::new(lines).block(block), area);
            }
            return;
        }
        let title = match &menu {
            Menu::Sessions => tt("会话", "Sessions"),
            Menu::DeleteConfirm { .. } => tt("确认删除该会话？（不可恢复）", "Delete this conversation? (irrecoverable)"),
            Menu::Rename { .. } => String::new(),
            Menu::Providers => tt("选择服务商", "Choose provider"),
            Menu::Models { provider } => format!("{} · {provider}", tt("模型", "Model")),
            Menu::Config => tt("会话配置", "Session config"),
            Menu::AgentMode => tt("代理模式", "Agent mode"),
            Menu::ThinkingMode => tt("思考强度", "Thinking effort"),
            Menu::PromptMode => tt("提示词模式", "Prompt mode"),
            Menu::Mcp => tt("MCP 服务器", "MCP servers"),
            Menu::Slash => tt("斜杠命令 / 技能", "Slash commands / skills"),
        };
        let items = self.menu_items();
        let filtered = filter_items(&items, &self.menu_filter);

        let mut lines: Vec<Line> = Vec::new();
        lines.push(Line::from(Span::styled(
            title,
            Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
        )));
        if !self.menu_filter.is_empty() {
            lines.push(Line::from(Span::styled(
                format!("{}: {}", tt("过滤", "filter"), self.menu_filter),
                dim_style(),
            )));
        }
        if filtered.is_empty() {
            lines.push(Line::from(Span::styled(tt("（无匹配项）", "(no matches)"), dim_style())));
        }
        let cursor = self.menu_cursor.min(filtered.len().saturating_sub(1));
        for (index, item) in filtered.iter().take(MENU_VISIBLE).enumerate() {
            let selected = index == cursor;
            let mut spans = vec![
                Span::styled(
                    if selected { "❯ " } else { "  " },
                    Style::new().fg(if selected { Color::Cyan } else { Color::Gray }),
                ),
                Span::styled(
                    item.label.clone(),
                    Style::new().fg(if selected { Color::White } else { Color::Gray }),
                ),
            ];
            if let Some(hint) = &item.hint {
                spans.push(Span::styled(format!("  {hint}"), dim_style()));
            }
            lines.push(Line::from(spans));
        }
        if filtered.len() > MENU_VISIBLE {
            lines.push(Line::from(Span::styled(
                format!("… (+{})", filtered.len() - MENU_VISIBLE),
                dim_style(),
            )));
        }
        lines.push(Line::from(Span::styled(
            tt("↑↓ 选择 · Enter 确认 · 输入过滤 · Esc 取消", "↑↓ select · Enter confirm · type to filter · Esc cancel"),
            dim_style(),
        )));
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(Color::Cyan));
        frame.render_widget(Paragraph::new(lines).block(block), area);
    }

    fn draw_composer(&mut self, frame: &mut Frame, area: Rect) {
        let active = self.state.overlay.is_none()
            && self.state.pending_choice.is_none()
            && self.menu.is_none();
        let mut lines: Vec<Line> = Vec::new();
        if self.composer.is_empty() {
            let placeholder = if self.state.active_session_id.is_none() {
                tt("Ctrl+L 选择 / 新建会话", "Ctrl+L to pick / start a conversation")
            } else {
                tt("输入消息，Enter 发送；/ 查看斜杠命令", "Type a message, Enter to send; / for slash commands")
            };
            lines.push(Line::from(Span::styled(placeholder, dim_style())));
        } else {
            let total = self.composer.lines.len();
            let hidden = total.saturating_sub(COMPOSER_VISIBLE);
            let rendered = &self.composer.lines[total - total.min(COMPOSER_VISIBLE)..];
            for (index, line) in rendered.iter().enumerate() {
                let is_cursor_row = active && index + hidden == self.composer.row;
                let mut spans = vec![Span::raw(line.clone())];
                if is_cursor_row {
                    spans.push(Span::styled("▌", Style::new().fg(Color::Cyan)));
                } else if line.is_empty() {
                    spans.push(Span::raw(" "));
                }
                lines.push(Line::from(spans));
            }
            if hidden > 0 {
                lines.push(Line::from(Span::styled(format!("… (+{hidden})"), dim_style())));
            }
        }
        lines.push(Line::from(Span::styled(
            tt(
                "Enter 发送 · Ctrl+O 换行 · Ctrl+L 会话 · Ctrl+M 模型 · Ctrl+K 配置 · Esc 中止/清空",
                "Enter send · Ctrl+O newline · Ctrl+L sessions · Ctrl+M model · Ctrl+K config · Esc abort/clear",
            ),
            dim_style(),
        )));
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(if active { Color::Cyan } else { Color::Gray }));
        frame.render_widget(Paragraph::new(lines).block(block), area);
    }
}

enum Focus {
    Overlay,
    Choice,
    Menu,
    Composer,
}

#[derive(Clone)]
struct MenuItem {
    key: String,
    label: String,
    hint: Option<String>,
}

fn filter_items(items: &[MenuItem], filter: &str) -> Vec<MenuItem> {
    if filter.is_empty() {
        return items.to_vec();
    }
    let needle = filter.to_lowercase();
    items
        .iter()
        .filter(|item| {
            item.label.to_lowercase().contains(&needle) || item.key.to_lowercase().contains(&needle)
        })
        .cloned()
        .collect()
}

fn dim_style() -> Style {
    Style::new().fg(Color::DarkGray)
}

fn dim_italic() -> Style {
    Style::new().fg(Color::DarkGray).add_modifier(Modifier::ITALIC)
}

fn dim_line(text: impl Into<String>) -> Line<'static> {
    Line::from(Span::styled(text.into(), dim_style()))
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn spinner_char() -> char {
    const FRAMES: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let start = START.get_or_init(Instant::now);
    let elapsed = start.elapsed().as_millis() as usize;
    FRAMES[(elapsed / 80) % FRAMES.len()]
}

fn format_tokens(tokens: f64) -> String {
    if tokens <= 0.0 {
        return "-".into();
    }
    if tokens >= 1000.0 {
        format!("{:.1}k", tokens / 1000.0)
    } else {
        format!("{}", tokens as i64)
    }
}

fn format_date(ms: f64) -> String {
    // 只取日期部分（列表提示用；不引 chrono，按 UTC 日期简化）
    let days = (ms / 86_400_000.0) as i64;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// 天数 → 公历日期（Howard Hinnant 的 civil_from_days 算法；避免引入 chrono）。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ==================== markdown → 终端行 ====================

/// markdown 渲染结果缓存（key = 消息 id；流式重渲染不重复解析）。
fn markdown_lines_cached(
    text: &str,
    cache: &mut HashMap<u64, (String, Vec<MdLine>)>,
    message_id: u64,
) -> Vec<Line<'static>> {
    if let Some((cached_text, lines)) = cache.get(&message_id) {
        if cached_text == text {
            return md_lines_to_widget(lines);
        }
    }
    let rendered = markdown::render(text);
    if cache.len() > 64 {
        cache.clear(); // 粗粒度上限：防止长会话无限增长（与 TS 的 parseCache 同口径）
    }
    cache.insert(message_id, (text.to_string(), rendered.clone()));
    md_lines_to_widget(&rendered)
}

/// 流式块渲染（无缓存：内容每帧都在变）。
fn markdown_lines_uncached(text: &str) -> Vec<Line<'static>> {
    md_lines_to_widget(&markdown::render(text))
}

fn md_color(color: MdColor) -> Option<Color> {
    match color {
        MdColor::None => None,
        MdColor::Green => Some(Color::Green),
        MdColor::Cyan => Some(Color::Cyan),
        MdColor::Yellow => Some(Color::Yellow),
        MdColor::Gray => Some(Color::Gray),
        MdColor::Blue => Some(Color::Blue),
        MdColor::White => Some(Color::White),
        MdColor::Red => Some(Color::Red),
        MdColor::Magenta => Some(Color::Magenta),
    }
}

fn md_span_to_widget(span: &MdSpan) -> Span<'static> {
    let mut style = Style::new();
    if let Some(color) = md_color(span.style.color) {
        style = style.fg(color);
    }
    let mut modifiers = Modifier::empty();
    if span.style.bold {
        modifiers |= Modifier::BOLD;
    }
    if span.style.italic {
        modifiers |= Modifier::ITALIC;
    }
    if span.style.dim {
        modifiers |= Modifier::DIM;
    }
    if span.style.strikethrough {
        modifiers |= Modifier::CROSSED_OUT;
    }
    if span.style.underline {
        modifiers |= Modifier::UNDERLINED;
    }
    if !modifiers.is_empty() {
        style = style.add_modifier(modifiers);
    }
    Span::styled(span.text.clone(), style)
}

fn md_lines_to_widget(lines: &[MdLine]) -> Vec<Line<'static>> {
    lines
        .iter()
        .map(|line| Line::from(line.spans.iter().map(md_span_to_widget).collect::<Vec<_>>()))
        .collect()
}

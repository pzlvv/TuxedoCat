//! 会话引擎：查询循环、工具执行、事件上报、落盘。
//!
//! 一个会话同一时刻只有一个消费循环；用户消息进队列，循环在轮次边界取用。
//! 循环跑在独立线程上，通过 `SharedBus` 上报 `CoreEvent`。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::bash_task;
use crate::bus::{self, CoreBus, FrameWriter};
use crate::compact;
use crate::config;
use crate::history;
use crate::llm::{self, LlmEvent, LlmRequest, Usage};
use crate::permission;
use crate::power;
use crate::prompt;
use crate::tool_input;
use crate::tools::{self, ToolContext, ToolOutcome};
use crate::util;

pub type SharedBus = Arc<Mutex<CoreBus<FrameWriter>>>;

/// 子代理 Reply 兜底提醒的最大重试次数（对齐 `AgentTool` 的 `MAX_REMINDER_RETRIES`）
const SUB_AGENT_MAX_REMINDER_RETRIES: usize = 3;

/// 压缩保留的最近消息条数（对齐 `compactConversation` 的 `maxMessagesToKeep = 30`）
const COMPACT_MAX_MESSAGES_TO_KEEP: usize = 30;


/// 子代理的后台驱动（对齐 `AgentTool.call` 里那个立即执行的后台 async IIFE）。
///
/// 一对 `queryBegin` / `queryEnd` 覆盖**整个**子代理生命周期（含 Reminder 重试），
/// `AgentTool` 手动 emit，消费循环不重复发。
fn run_sub_agent(
    core: Arc<Core>,
    sub_session_id: String,
    creator_session_id: String,
    prompt_text: String,
) {
    core.emit(json!({ "type": "queryBegin", "sessionId": sub_session_id }));

    // 首条任务消息：对齐 `AgentTool` 的 `initialMessages: [taskMessage]`
    {
        let state = core.session(&sub_session_id);
        let mut state = state.lock().unwrap();
        state.pending_user_message = Some(json!({
            "type": "user",
            "message": { "role": "user", "content": prompt_text },
            "uuid": util::unique_id("subtask"),
            "timestamp": util::now_millis(),
        }));
        state.running = true;
        state.cancel.store(false, Ordering::Relaxed);
        state.silent_abort = false;
    }

    let mut retries = 0usize;
    loop {
        run_consumer_with_ui(Arc::clone(&core), sub_session_id.clone(), false);

        let Some(state) = core.session_if_exists(&sub_session_id) else {
            break;
        };
        // 用户中止：跳过 Reply 检查与 Reminder，直接收尾（对齐 `abortController.signal.aborted`）
        if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
            break;
        }
        if sub_agent_has_reply(&state) {
            break;
        }
        if retries >= SUB_AGENT_MAX_REMINDER_RETRIES {
            core.log(&format!(
                "Sub-agent {sub_session_id} failed to call Reply after {SUB_AGENT_MAX_REMINDER_RETRIES} Reminders"
            ));
            break;
        }
        retries += 1;
        // Reminder 经 `pending_reminder` 入队：消费循环的 Reminder 批走 `persist_reminder`
        // （`silent` / `origin=agent` 的 user 消息——进上下文、落盘，UI 消息流不展示，
        // 回放与 conversationLoaded 都过滤 `silent`）。子代理会话的 UI 侧输入已禁用
        // （specs/025 FR-004），系统注入的催办对用户不可见；LLM 照常看到。
        // `sub_agent_has_reply` 的基准是最后一个非 silent 用户消息——Reminder 不成为
        // 基准，判定回到「任务消息之后是否调用过 Reply」，与本循环「一检出 Reply 即
        // 收尾」的语义一致。
        let reminder = sub_agent_reminder(retries, &creator_session_id);
        let mut state = state.lock().unwrap();
        state.pending_reminder = Some(reminder);
        state.running = true;
        state.cancel.store(false, Ordering::Relaxed);
        state.silent_abort = false;
    }

    core.emit(json!({ "type": "queryEnd", "sessionId": sub_session_id }));
    // 刷新对话列表：此时子代理消息已持久化，新子会话能正确出现在对话树里
    core.emit(json!({ "type": "conversationListChanged" }));
    core.emit_runtime();
    // specs/023 FR-010：跨工作区子代理的运行时在目标工作区，结束要通知发起方 Core
    // 注销远程登记并释放槽位；本进程从未取过槽位，不释放。
    // 用进程级登记判断而不是会话状态：会话可能已被用户关闭（状态已释放）。
    if let Some(origin_session_id) = crate::subagent::remote_origin_of(&sub_session_id) {
        core.emit(json!({
            "type": "crossWorkspaceAgentEnded",
            "sessionId": origin_session_id,
            "subSessionId": sub_session_id,
        }));
        return;
    }
    // specs/005：子代理后台任务的唯一退出点——循环内各 break（完成 / 中止 /
    // Reminder 耗尽 / 会话消失）都落到这里，并发槽位在此释放并唤醒最早排队者
    crate::subagent::release_slot(&creator_session_id);
}

/// 子代理最近一轮里是否调用过 `Reply`（对齐 `AgentTool.checkSubAgentHasReply`）。
///
/// 基准是最后一个「真正的用户输入」：`type=user`、非 `silent`、且
/// `message.content` 是字符串（排除 tool_result 那种数组 content 的消息）。
fn sub_agent_has_reply(state: &Arc<Mutex<SessionState>>) -> bool {
    let state = state.lock().unwrap();
    let messages = &state.messages;
    let start = messages.iter().rposition(|message| {
        message.get("type").and_then(Value::as_str) == Some("user")
            && !history::js_truthy(message.get("silent"))
            && message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .map(Value::is_string)
                .unwrap_or(false)
    });
    let Some(start) = start else {
        return false;
    };
    messages[start + 1..].iter().any(|message| {
        message.get("type").and_then(Value::as_str) == Some("assistant")
            && message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks.iter().any(|block| {
                        block.get("type").and_then(Value::as_str) == Some("tool_use")
                            && block.get("name").and_then(Value::as_str) == Some("Reply")
                    })
                })
                .unwrap_or(false)
    })
}

/// 子代理「没调用 Reply」的兜底提醒文案（对齐 `AgentTool.buildReminderContent`）：
/// 措辞随重试次数递进，不催促、不威胁。
fn sub_agent_reminder(retry: usize, creator_session_id: &str) -> String {
    let mut lines = vec![
        "<Reminder>".to_string(),
        "You have completed your processing but have not yet sent a reply using the Reply tool."
            .to_string(),
        String::new(),
        "You need to generate a tool call (a \"tool_use\" block) with the name \"Reply\" to send your results back."
            .to_string(),
    ];
    if !creator_session_id.is_empty() {
        lines.push(format!(
            "When calling the Reply tool, set targetSessionId to \"{creator_session_id}\" to ensure the reply reaches the correct session."
        ));
    }
    lines.push(String::new());
    lines.push(
        match retry {
            1 => "No `Reply` tool_use detected in parent, did you generate `reply` tool call?",
            2 => "Make sure the tool_use block is in your response, NOT as plain text.",
            _ => "You only generated text, which means the parent cannot see it. The system requires you to use a specific format to invoke tools for proper processing. Please try using the correct tool call format without any JSON markers.",
        }
        .to_string(),
    );
    lines.push("</Reminder>".to_string());
    lines.join("\n")
}

/// 一条待消费的自动消息（对齐 `QueryEngine.agentMessageQueue` 的
/// `{ content, agentId, source }`）。
#[derive(Clone)]
pub struct AgentMessage {
    pub content: String,
    /// `bash` = 后台 Bash 完成通知（纯文本渲染）；`agent` = 子代理 Reply
    /// （markdown + From 头）。
    pub origin: String,
    /// 来源会话：子代理 Reply 是子会话 id；后台任务通知为空串。
    pub from_session_id: String,
}

/// 会话工作模式。
///
/// `spin`：主会话不参与 LLM 消费循环，只由 SpinLoop 循环起子代理
/// 。由 `spin_host.rs` 在 `/spin` 进入时设置；**单向**——SpinLoop 结束（完成 /
/// 中止 / 失败）也不恢复 `Normal`，会话此后一直停留在 spin 态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkMode {
    Normal,
    Spin,
}

/// `WorkMode` 的落盘 / 事件文本（`meta.json` 的 `workMode` 字段与
/// `workModeChanged` 载荷共用；specs/016 FR-005）
pub fn work_mode_text(mode: WorkMode) -> &'static str {
    match mode {
        WorkMode::Normal => "normal",
        WorkMode::Spin => "spin",
    }
}

/// 从落盘文本恢复 `WorkMode`；非法 / 缺失值按 `Normal`（存量会话没有该字段）
pub fn work_mode_from_text(text: &str) -> WorkMode {
    if text == "spin" {
        WorkMode::Spin
    } else {
        WorkMode::Normal
    }
}

/// 单个会话的运行时状态
pub struct SessionState {
    pub cancel: Arc<AtomicBool>,
    /// 手工转后台（`UiEvent.bashBackgroundRequested`）的循环暂停标记
    /// 。置位方：前台 Bash 手工
    /// 转后台成功；消费方：`run_query_loop` 在工具批收尾、下一轮 LLM 请求发起前。
    /// 新用户消息与中止都会清除残留标记（暂停只对「当时那轮查询」有意义）。
    pub pause_loop: crate::tools::LoopPauseSignal,
    pub running: bool,
    pub waiting: bool,
    /// 静默中止标记：本次中止是
    /// 业务主动结束（spin 子代理首次 Reply 后停止自身），查询循环收尾时**不回显**
    /// `*User Interrupted*`（见 `emit_user_interrupted`）。新的消费循环启动时随
    /// `cancel` 一并复位。
    pub silent_abort: bool,
    /// 工作模式（`QueryEngine.workMode`）：`spin` 期间子代理 Reply 不进消费队列
    /// （见 `deliver_agent_reply` 的 spin 分支），由 SpinLoop 消费。单向：进入后
    /// 不再写回 `Normal`。
    pub work_mode: WorkMode,
    /// 本会话在 spin 运行期间由 SpinLoop 起的子代理（`from_session_id`）。
    ///
    /// 登记后这些子代理的 Reply 始终按 spin 语义处理（只落 silent 上下文、交给
    /// SpinLoop 判定），即使 Reply 在 SpinLoop 结束之后才到达，也不会被当成普通
    /// 自动消息喂给父对话的 LLM。
    pub spin_sub_agents: HashSet<String>,
    /// 已经在 spin 语义下消费过首条 Reply 的子代理。
    ///
    /// 同一子代理只响应一次：重复 / 迟到的 Reply 直接忽略，不再落盘、不再触发
    /// `emit_reply_delivered`，也不会进入父对话的消费队列。
    pub spin_replied: HashSet<String>,
    /// 待消费的用户消息（`QueryEngine.pendingUserMessage`）。
    ///
    /// **单槽位**：新消息直接
    /// **替换**排队中的旧消息，
    /// 不是追加（Agent 回复才追加，见 `agent_messages`）。
    pub pending_user_message: Option<Value>,
    /// 内存中的消息（含尚未落盘的）
    pub messages: Vec<Value>,
    /// `messages` 中前多少条已经落盘。
    /// 崩溃恢复补出的合成 `tool_result` 只在内存里，下一次持久化时机按序补写。
    pub persisted_count: usize,
    pub last_uuid: Option<String>,
    pub agent_mode: String,
    pub project: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    /// 会话级思考强度覆盖（`thinkingEffortChanged` / 消息随带）
    pub thinking_effort: Option<String>,
    /// 会话级 Web Search 覆盖（`webSearchChanged` / 消息随带）
    pub web_search: Option<bool>,
    /// 会话级提示词预设（`promptModeChanged`；提示词本身尚未按预设切换）
    pub prompt_mode: Option<String>,
    /// 待注入的 Reminder（`QueryEngine.pendingReminder`）：上一轮 LLM 回复「像话没说完」
    /// 时（stop_reason 非 end_turn，或正文以冒号结尾）自动补一条 silent 用户消息再跑一轮。
    pub pending_reminder: Option<String>,
    /// 待消费的自动消息（`QueryEngine.agentMessageQueue`）：后台 Bash 完成通知与
    /// 子代理 Reply。与用户消息分开存放：自动消息不占用「用户消息」的消费语义
    /// （见 `run_consumer` 的消费优先级）。
    pub agent_messages: Vec<AgentMessage>,
    /// 本会话是否有运行中的后台 Bash 任务（`sessionRuntime.background`）。
    /// 参与 `idle` 判定：有后台任务时该会话不算空闲。
    pub background: bool,
    /// 本会话是否正在压缩（`sessionRuntime.compacting`）。
    ///
    /// 与 `compact::is_compacting` 是两件事：前者是跨层可见的运行时事实（对话树 /
    /// 侧栏流水灯 / 空闲回收），后者给消费循环判断能否并发消费。参与 `idle` 判定。
    pub compacting: bool,
    /// 自动压缩的连续失败计数与轮次（`AutoCompactTrackingState`）
    pub auto_compact_tracking: Option<crate::compact::AutoCompactTracking>,
    /// 后台任务的周期性提醒时钟（`taskId -> 时钟`）。只在会话空闲时前进；
    /// 任务结束 / 会话关闭后清理。时钟项同时记着「上次访问时刻」，
    /// 查询结束的兜底提醒据此冷却。
    pub reminder_entries: HashMap<String, ReminderEntry>,
    /// 当前这轮消费是否由后台任务的 reminder 拉起（`deliver_background_reminder` 置位，
    /// 消费循环收尾消费后清零）。为真时收尾不再补兜底提醒：否则「提醒 → 查询 → 提醒」
    /// 会互相接力。
    pub reminder_driven_run: bool,
    /// 子代理会话的创建者（`AgentTool` 写入；普通会话为 None）。
    pub parent_session_id: Option<String>,
    /// 子代理会话的静态系统提示词（`AgentTool` 的 `staticSystemPrompt`）。
    /// 非空时**整体替换**按预设组装的提示词。
    pub static_system_prompt: Option<String>,
    /// system prompt 前缀（`QueryEngine.systemPromptPrefix`）：非空时拼在组装结果开头
    /// （Master 子代理 = 主对话同款提示词 + 开头 `## Communication` 段）。
    pub system_prompt_prefix: Option<String>,
    /// 子代理角色（`Master`），落进 `meta.json` 的 `role`。
    pub sub_agent_role: Option<String>,
    /// 子代理创建时 Agent 工具调用的 description（specs/019 FR-001）：随
    /// `sessionRuntimeChanged` 快照暴露给宿主，abort 按钮悬停明细据此显示。
    /// 普通会话与恢复路径取不到时为 `None`（快照为 `null`，UI 显示回退文案）。
    pub sub_agent_description: Option<String>,
    /// 待注入的 Skill（`QueryEngine.pendingSkillInjection`）：出队时解析出的
    /// `/skill` 命令。用户消息照常进上下文，随后注入一条 Skill tool_use +
    /// tool_result（技能正文），供本轮 LLM 读取。
    pub pending_skill_injection: Option<SkillInjection>,
    /// 待注入的 `@` 工作区提醒（specs/023 FR-008）：轮次边界解析出 `@<身份>` 后置位，
    /// `run_turn` 在用户消息之后落一条 silent reminder。
    pub pending_mention_reminder: Option<String>,
    /// 跨工作区子代理的来源已并入 creator（specs/025 FR-002），字段随其删除。
    pub creator: SessionCreator,
}

/// 会话创建者（specs/025 FR-002）：归属的唯一根事实。用户 prompt 发起为 `User`；
/// Agent 创建（本地子代理 / 跨工作区派发）携带创建方工作区身份与创建方会话 id——
/// 本地创建 `workspace_id` 为 `None`（工作区身份算法唯一落点是宿主
/// `workspaceIdentity.ts`，Core 不持该事实）。托盘完成抑制、未读绿灯武装、输入
/// 禁用、`Reply` 回传路由与跨工作区跳转都是它的只读投影；TS 镜像
/// `src/shared/sessionCreator.ts`，meta.json 落盘形态两侧一致。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionCreator {
    /// 用户 prompt 发起
    User,
    /// Agent 创建
    #[serde(rename_all = "camelCase")]
    Agent {
        /// 创建方工作区身份；本地创建为 `None`
        workspace_id: Option<String>,
        /// 创建方会话 id（本地子代理 = 父会话 id）
        session_id: String,
    },
}

/// 出队时解析出的 Skill 命令（对齐 `SkillDispatchInfo`）
#[derive(Clone, Debug)]
pub struct SkillInjection {
    pub skill_name: String,
    pub skill_args: String,
}

/// 一个后台任务的提醒调度项：
/// 纯时钟 + 上次推进时刻 + 上次访问时刻 + 已兜底标记。任务描述 / 命令 / 开始时间在
/// 推进时从注册表读取。
#[derive(Clone, Debug)]
pub struct ReminderEntry {
    pub clock: crate::bash_task::ReminderClock,
    pub last_tick_ms: u64,
    /// 上次「访问」该任务的时刻（周期提醒投递 / 查询结束）：查询结束兜底门槛据此冷却。
    /// 登记时取任务开始时间（任务刚起不算「已访问」）。
    pub last_accessed_ms: u64,
    /// 是否已经兜底提醒过（含手工转后台时预置的抑制标记）：sleep 豁免据此只生效一次
    /// 。
    pub fallback_reminded: bool,
}

impl SessionState {
    fn new(agent_mode: String, project: Option<String>) -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            pause_loop: crate::tools::LoopPauseSignal::default(),
            running: false,
            waiting: false,
            silent_abort: false,
            work_mode: WorkMode::Normal,
            spin_sub_agents: HashSet::new(),
            spin_replied: HashSet::new(),
            pending_user_message: None,
            messages: Vec::new(),
            persisted_count: 0,
            last_uuid: None,
            agent_mode,
            project,
            model: None,
            provider: None,
            thinking_effort: None,
            web_search: None,
            prompt_mode: None,
            pending_reminder: None,
            agent_messages: Vec::new(),
            background: false,
            compacting: false,
            auto_compact_tracking: None,
            reminder_entries: HashMap::new(),
            reminder_driven_run: false,
            parent_session_id: None,
            static_system_prompt: None,
            system_prompt_prefix: None,
            sub_agent_role: None,
            sub_agent_description: None,
            pending_skill_injection: None,
            pending_mention_reminder: None,
            creator: SessionCreator::User,
        }
    }

    fn is_idle(&self) -> bool {
        // 对齐 `sessionRuntime.isIdleInSnapshot`：`query`(running) / `waiting` /
        // `compacting` / `background` 任一为真都不算空闲。
        !self.running
            && !self.waiting
            && !self.compacting
            && self.pending_user_message.is_none()
            && !self.background
    }
}

pub struct Core {
    pub bus: SharedBus,
    pub sessions: Mutex<HashMap<String, Arc<Mutex<SessionState>>>>,
    /// 远程工作区文件监听注册表（specs/018 FR-002）：按 watchId 持有 watcher。
    pub file_watch: crate::file_watch::FileWatchRegistry,
    /// 会话创建顺序：
    /// `sessionRuntimeChanged.states` 必须按插入序输出，HashMap 迭代序不保证。
    session_order: Mutex<Vec<String>>,
    /// 上一次已推送的运行时快照；无变化时不重发（对齐 `pushIfChanged` 的 diff）。
    last_runtime: Mutex<Vec<Value>>,
}

impl Core {
    pub fn new(bus: SharedBus) -> Self {
        Self {
            bus,
            sessions: Mutex::new(HashMap::new()),
            file_watch: crate::file_watch::FileWatchRegistry::new(),
            session_order: Mutex::new(Vec::new()),
            last_runtime: Mutex::new(Vec::new()),
        }
    }

    // ==================== 会话 ====================

    pub fn session(&self, session_id: &str) -> Arc<Mutex<SessionState>> {
        let mut sessions = self.sessions.lock().unwrap();
        if !sessions.contains_key(session_id) {
            let agent_mode = config::default_agent_mode();
            sessions.insert(
                session_id.to_string(),
                Arc::new(Mutex::new(SessionState::new(agent_mode, None))),
            );
            self.session_order.lock().unwrap().push(session_id.to_string());
        }
        sessions.get(session_id).unwrap().clone()
    }

    pub fn session_if_exists(&self, session_id: &str) -> Option<Arc<Mutex<SessionState>>> {
        self.sessions.lock().unwrap().get(session_id).cloned()
    }

    /// 会话当前是否空闲（未登记视为空闲）。
    /// 运行中的会话不伪造「会话中断」的取消结果。
    pub fn session_is_idle(&self, session_id: &str) -> bool {
        match self.session_if_exists(session_id) {
            None => true,
            Some(state) => state.lock().unwrap().is_idle(),
        }
    }

    pub fn drop_session(&self, session_id: &str) {
        // 会话已从快照移除；进程级待压缩注册表也要清理，避免 id 复用时残留
        compact::unmark_pending_compact(session_id);
        // 该会话作为子代理的登记条目随会话终结注销（只注销自身、不级联：
        // 存活的子孙会话仍靠登记保持递归中止可达，见
        // specs/defects/subagent-registry-outlives-dropped-sessions 的不变量）
        crate::subagent::unregister(session_id);
        self.sessions.lock().unwrap().remove(session_id);
        self.session_order.lock().unwrap().retain(|id| id != session_id);
    }

    /// 当前登记的全部会话 id（按创建序）。
    ///
    /// 只服务测试 harness 收尾清场（见 `test_support.rs` 的 `EngineHarness::drop`），
    /// 不是 Core 契约的一部分，因此只在测试构建里编译，避免生产构建的 dead_code 告警。
    #[cfg(test)]
    pub fn session_ids(&self) -> Vec<String> {
        self.session_order.lock().unwrap().clone()
    }

    /// 会话工作目录：会话级登记优先，其次 `meta.json` 的 `project`，最后活动工作目录
    pub fn project_of(&self, session_id: &str) -> Result<String, String> {
        if let Some(state) = self.session_if_exists(session_id) {
            if let Some(project) = state.lock().unwrap().project.clone() {
                return Ok(project);
            }
        }
        if let Some(project) = history::project_of_session(session_id) {
            return Ok(project);
        }
        config::project_root(session_id)
    }

    // ==================== 事件上报 ====================

    pub(crate) fn emit(&self, event: Value) {
        let mut bus = self.bus.lock().unwrap();
        bus.emit(event);
    }

    fn log(&self, message: &str) {
        let mut bus = self.bus.lock().unwrap();
        bus.log(message);
    }

    /// 推全量会话运行时状态（根事实 + 派生 `idle`）。
    ///
    /// 状态没变时不发事件；
    /// 有变化时按会话插入序推全量快照（消费者不维护状态表）。
    ///
    /// 快照字段（``docs/architecture/principles.md` 第 8 节）：暴露
    /// `queryRunning` / `waiting` / `compacting` / `pendingCompact` /
    /// `backgroundRunning` / `subAgentRunning` 根事实，`idle` 是其余根事实的合取
    /// （`pendingCompact` 不参与——排队不是正在执行的工作）。流水灯 / 托盘读 `idle`；
    /// abort 按钮按根事实推导三态（`docs/features/abort-button.md`）。
    pub fn emit_runtime(&self) {
        let order = self.session_order.lock().unwrap().clone();
        // 先读待压缩注册表再锁 sessions：`drop_session` 的顺序是
        // 「PENDING_COMPACT → sessions」，这里反序会形成锁序倒置。
        let pending_compact: HashMap<String, bool> = order
            .iter()
            .map(|session_id| (session_id.clone(), compact::is_pending_compact(session_id)))
            .collect();
        let sessions = self.sessions.lock().unwrap();
        let states: Vec<Value> = order
            .iter()
            .filter_map(|session_id| sessions.get(session_id).map(|state| (session_id, state)))
            .map(|(session_id, state)| {
                let (running, pending, waiting, compacting, background, parent, sub_agent_desc, creator) = {
                    let state = state.lock().unwrap();
                    (
                        state.running,
                        state.pending_user_message.is_some(),
                        state.waiting,
                        state.compacting,
                        state.background,
                        state.parent_session_id.clone(),
                        state.sub_agent_description.clone(),
                        state.creator.clone(),
                    )
                };
                // 运行中后台任务清单（specs/019 FR-001）：`TASKS` 锁在此处短暂获取，
                // 锁序单向 `sessions → TASKS`——bash_task 的引擎回调都在释放 `TASKS`
                // 锁之后才发生，无反向路径。
                let background_tasks = crate::bash_task::running_tasks_for_session(session_id);
                // 待压缩登记在进程级注册表（`compact.rs` 的 `PENDING_COMPACT`），
                // 快照只做投影，不在 `SessionState` 里再存一份。
                let pending_compact = pending_compact.get(session_id).copied().unwrap_or(false);
                // `pending_user_message` 是「已入队、消费循环即将接手」的窗口，与
                // 入队即 markQueryRunning(true)。
                let query_running = running || pending;
                // 对齐 `sessionRuntime.toSnapshot`：递归判定——自身不忙**且**所有已登记
                // 子代理都空闲，父会话才算空闲。
                let idle = Core::is_idle_deep(&sessions, session_id, &mut HashSet::new());
                let sub_agent_running = Core::has_busy_subagent(&sessions, session_id);
                Core::runtime_state_json(
                    session_id,
                    idle,
                    waiting,
                    query_running,
                    compacting,
                    pending_compact,
                    background,
                    sub_agent_running,
                    parent.as_deref(),
                    &creator,
                    &background_tasks,
                    sub_agent_desc.as_deref(),
                )
            })
            .collect();
        drop(sessions);
        {
            let mut last = self.last_runtime.lock().unwrap();
            if *last == states {
                return;
            }
            *last = states.clone();
        }
        // 任一会话非 idle → 阻断本进程所在机器的睡眠（宿主侧另有 Electron 的实现，
        // 见 power 模块头注释）。放在 diff 之后：快照没变则忙闲也没变，阻断状态已是对的。
        power::set_prevent_sleep(power::should_prevent_sleep(&states));
        self.emit(json!({ "type": "sessionRuntimeChanged", "states": states }));
    }

    /// 单个会话的运行时快照 JSON。
    ///
    /// 字段集合由 `core-rs/fixtures/runtimeState.json` 锁定（Rust 侧
    /// `main_tests` 的 `runtime_state_fields_match_parity_fixture`；TS 侧无自动锁定，
    /// 镜像类型在 `src/shared/AssistantEventBus.ts` 与 `src/webview/types.ts`）——
    /// 增删字段必须同步 fixture 与两侧类型。
    pub(crate) fn runtime_state_json(
        session_id: &str,
        idle: bool,
        waiting: bool,
        query_running: bool,
        compacting: bool,
        pending_compact: bool,
        background: bool,
        sub_agent_running: bool,
        parent_session_id: Option<&str>,
        creator: &SessionCreator,
        background_tasks: &[crate::bash_task::RunningTask],
        sub_agent_description: Option<&str>,
    ) -> Value {
        json!({
            "sessionId": session_id,
            "idle": idle,
            "waiting": waiting,
            "queryRunning": query_running,
            "compacting": compacting,
            // 手动压缩已登记、等待下一轮开始时执行（`compact.rs` 的 `PENDING_COMPACT`）。
            // 不参与 `idle` 派生：排队不是正在执行的工作。
            "pendingCompact": pending_compact,
            "backgroundRunning": background,
            "subAgentRunning": sub_agent_running,
            // 父会话 id（本地子代理会话才有；普通会话与跨工作区对话为 `null`，
            // specs/025 FR-002）。树事实，归属语义读 `creator`。
            "parentSessionId": parent_session_id,
            // 会话创建者（specs/025 FR-002）：归属根事实，完成提醒 / 未读绿灯的
            // 抑制与输入禁用据此判定（TS 镜像 `sessionCreator.ts` 判别联合）。
            "creator": creator,
            // 运行中后台 Bash 任务清单（specs/019 FR-001，注册序；空集为 `[]`）。
            // pid / start_time 不进契约——abort 悬停明细只展示身份（描述 + 命令）。
            "backgroundTasks": background_tasks
                .iter()
                .map(|task| {
                    json!({
                        "taskId": task.task_id,
                        "description": task.description,
                        "command": task.command,
                    })
                })
                .collect::<Vec<Value>>(),
            // 子代理创建时的 Agent 工具 description（specs/019 FR-001）；
            // 普通会话与恢复路径为 `null`，UI 显示回退文案。
            "subAgentDescription": sub_agent_description,
        })
    }

    // ==================== UiEvent 入口 ====================

    /// 递归判定会话是否空闲（对齐 `sessionRuntime.isIdleInSnapshot`）。
    ///
    /// 自身 `query`(running) / `waiting` / `background` 任一为真 → 不空闲；
    /// 再看它登记的子代理是否都空闲（子代理自己也可能有后台 Bash / 更下层子代理）。
    /// 未登记的会话按空闲处理；`visiting` 做环保护。
    ///
    /// 每次只持有一把 `SessionState` 锁（递归前先释放），避免与
    /// `run_consumer` 的「持 SessionState → 取子代理表」顺序交叉成死锁。
    fn is_idle_deep(
        sessions: &HashMap<String, Arc<Mutex<SessionState>>>,
        session_id: &str,
        visiting: &mut HashSet<String>,
    ) -> bool {
        if !visiting.insert(session_id.to_string()) {
            return true;
        }
        if let Some(state) = sessions.get(session_id) {
            if !state.lock().unwrap().is_idle() {
                return false;
            }
        }
        for child in crate::subagent::list_for_creator(session_id) {
            // specs/023 FR-006：跨工作区子代理没有本地会话状态，`is_idle_deep` 会把它
            // 当空闲；结束事件到达前一律按「运行中」计入。
            if crate::subagent::is_remote(&child) {
                return false;
            }
            if !Self::is_idle_deep(sessions, &child, visiting) {
                return false;
            }
        }
        true
    }

    /// 该会话是否有非 idle 的已登记子代理（递归）。
    ///
    /// 对每个已登记子代理单独判定它
    /// 自己的子树是否空闲。子代理完成一轮后可能仍留在注册表里等 Reply，此时它空闲，
    /// 父会话的 `subAgentRunning` 为假（`docs/features/abort-button.md` FR-001）。
    fn has_busy_subagent(
        sessions: &HashMap<String, Arc<Mutex<SessionState>>>,
        session_id: &str,
    ) -> bool {
        for child in crate::subagent::list_for_creator(session_id) {
            // specs/023 FR-006：远程子代理在结束事件到达前一直算忙
            if crate::subagent::is_remote(&child) {
                return true;
            }
            if !Self::is_idle_deep(sessions, &child, &mut HashSet::new()) {
                return true;
            }
        }
        false
    }

    pub fn on_workspace_changed(&self, workspace: Option<String>) {
        config::set_active_workspace(workspace);
    }

    pub fn on_host_environment(&self, env: config::HostEnvironment) {
        config::set_host_environment(env);
        let _ = config::ensure_config_dirs();
        // Core 不感知语言（`docs/architecture/core-ui-separation.md` 第 4.8 节）：宿主环境里没有
        // locale 字段，面向界面的文本以「键 + 参数」经 `CoreEvent.notice` 交给 UI 翻译。
        self.log("Standalone Core ready.");
    }

    pub fn on_conversation_opened(&self, session_id: &str) {
        let _ = self.ensure_loaded(session_id);
        // MCP：会话被打开 → 按该会话的启用列表建立引用（幂等，后台串行执行）。
        // MCP 的生命周期由 core 的会话生命周期驱动，
        // 不绑在 UI 的视图生命周期上。
        crate::mcp::on_session_opened(session_id);
        self.emit_runtime();
    }

    /// `UiEvent.userChoicePendingChanged`：宿主上报「该会话的用户选择框是否在
    /// webview 里等待应答」。
    ///
    /// 这是宿主侧
    /// 「已弹出 / 已应答 / 已释放」的事实，与 core 自己发 `CoreRequest` 期间置位的
    /// `waiting` 共同决定 `sessionRuntime.waiting`。core 发请求时先置 true，应答后
    /// 置 false；宿主这条事件在弹出 / 应答 / 视图销毁时补一次，两边最终一致。
    pub fn on_user_choice_pending(&self, session_id: &str, pending: bool) {
        let state = self.session(session_id);
        state.lock().unwrap().waiting = pending;
        // `emit_runtime` 内部按快照 diff，无变化时不发事件（对齐 `pushIfChanged`）
        self.emit_runtime();
    }

    pub fn on_conversation_closed(&self, session_id: &str) {
        // 对齐 `releaseSessionResources` 的第 1 步（`Integration.abortSessionTree`）：
        // 会话关闭时中止整棵工作树（前台查询 + 后台 Bash + 递归子代理），
        // 避免孤儿进程 / 子代理继续跑。
        self.abort_session_scope(session_id, &mut HashSet::new());
        self.drop_session(session_id);
        tools::clear_session_todos(session_id);
        // MCP：会话关闭 → 释放该会话的全部引用（归零的 server 进延迟回收）
        crate::mcp::on_session_closed(session_id);
        self.emit_runtime();
    }

    /// `UiEvent.abortRequested`：abort 按钮点击（`docs/features/abort-button.md` FR-002）。
    ///
    /// 按该会话的运行时事实决定中止范围——
    /// - spin 模式：父会话没有 query engine，abort 只中止运行中的子代理（递归含其后台
    ///   任务与下层子代理），并置 `cancel` 让 SpinLoop 在下一个检查点退出；spin 是
    ///   单向模式，循环停下后会话仍保持 spin（完全空闲时点击为空操作）；
    /// - 前台有工作（`running` / `compacting`）→ 只中止前台查询（置 `cancel`），
    ///   后台 Bash 任务与子代理保持运行，等待用户再次点击；
    /// - 前台空闲但仍有后台 Bash 任务或子代理 → 中止它们（含递归子代理）。
    ///
    /// 阶段判定读与 `sessionRuntimeChanged` 同一批事实，与 UI 按钮三态同源。
    pub fn on_abort(&self, session_id: &str) {
        if let Some(state) = self.session_if_exists(session_id) {
            let work_mode = state.lock().unwrap().work_mode;
            if work_mode == WorkMode::Spin {
                // spin 单向：无论循环在跑还是已结束都不退出 spin 模式。
                if !self.is_session_idle(session_id) {
                    // 运行中的 spin：没有 query engine 可中止，范围只含子代理与后台任务。
                    // 父会话的 `cancel` 由 `abort_session_scope` 一并置位，SpinLoop 据此
                    // 在下一个检查点停下；`work_mode` 保持 Spin。
                    self.abort_session_scope(session_id, &mut HashSet::new());
                }
                return;
            }
        }
        // 会话已登记且完全空闲：无事可做（按钮此时为灰色，这里只兜住渲染到点击之间的竞态）。
        if self.session_if_exists(session_id).is_some() && self.is_session_idle(session_id) {
            return;
        }
        let foreground_busy = self
            .session_if_exists(session_id)
            .map(|state| {
                let state = state.lock().unwrap();
                state.running || state.compacting || state.pending_user_message.is_some()
            })
            .unwrap_or(false);
        if foreground_busy {
            self.abort_foreground(session_id);
        } else {
            self.abort_session_scope(session_id, &mut HashSet::new());
        }
    }

    /// 只中止前台查询（abort 第一阶段）：置 `cancel`，让消费循环清空队列并退出。
    /// 不动后台 Bash 任务与子代理（对齐 `QueryEngine.interruptForeground`）。
    fn abort_foreground(&self, session_id: &str) {
        if let Some(state) = self.session_if_exists(session_id) {
            let state = state.lock().unwrap();
            state.cancel.store(true, Ordering::Relaxed);
            // 中止让暂停标记失效：被中止的那轮查询不会再走到工具批收尾的暂停
            // 出口，残留标记否则会在下一轮查询的工具批后错误地暂停循环。
            state.pause_loop.clear();
        }
    }

    /// `UiEvent.bashBackgroundRequested`：用户把某台**正在前台运行**的 Bash 命令
    /// 转入后台（Bash 卡片「转后台」按钮）。
    ///
    /// 只触发转换（`tools::request_manual_background` 按 tool_use_id 查注册表）；
    /// 暂停标记由 `auto_background_command(manual = true)` 的成功路径回写
    /// `SessionState.pause_loop`。没有匹配的前台执行时幂等忽略。
    pub fn on_bash_background_requested(&self, _session_id: &str, tool_use_id: &str) {
        if !crate::tools::request_manual_background(tool_use_id) {
            self.log(&format!(
                "bashBackgroundRequested: no foreground bash running for tool_use {tool_use_id}; ignored"
            ));
        }
    }

    /// `UiEvent.queuedMessageDiscarded`：webview 排队项的「编辑 / 删除」撤回排队消息
    /// 。
    ///
    /// 按 uuid 配对：引擎队列里没有该 uuid 的待消费消息（已被消费、被更新的排队
    /// 消息替换，或本来就不存在）时不动，也不置 `cancel`——撤回排队项不打断正在
    /// 运行的查询。
    pub fn on_queued_message_discarded(&self, session_id: &str, uuid: &str) {
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        let mut state = state.lock().unwrap();
        let matches = state
            .pending_user_message
            .as_ref()
            .and_then(|message| message.get("uuid").and_then(Value::as_str))
            .map(|pending| pending == uuid)
            .unwrap_or(false);
        if matches {
            state.pending_user_message = None;
            // Skill 命令的待注入信息与排队消息同生共死：消息撤回后注入不再发生。
            state.pending_skill_injection = None;
        }
    }

    /// 中止会话及其递归子代理的运行中工作（abort 第二阶段 / 会话关闭）。
    ///
    /// 前台查询、后台 Bash 任务、
    /// 子代理三条路径都走，幂等。
    fn abort_session_scope(&self, session_id: &str, visited: &mut HashSet<String>) {
        if session_id.is_empty() || !visited.insert(session_id.to_string()) {
            return;
        }
        self.abort_foreground(session_id);
        self.abort_background_tasks(session_id);
        for child in crate::subagent::list_for_creator(session_id) {
            // specs/023 FR-006：跨工作区子代理的运行时在目标工作区，本地没有它的会话
            // 状态；发中止事件由宿主转发，不递归本地（递归只会 no-op）。
            if crate::subagent::is_remote(&child) {
                self.emit(json!({
                    "type": "crossWorkspaceAgentAbortRequested",
                    "sessionId": child,
                }));
                continue;
            }
            self.abort_session_scope(&child, visited);
        }
    }

    /// 静默中止一个会话：复用 [`Self::abort_session_scope`]
    /// 的完整中止逻辑（前台查询、后台 Bash 任务、递归子代理），但先标记
    /// `silent_abort`，让查询循环收尾时不再向 UI 回显 `*User Interrupted*`。
    ///
    /// 使用场景：spin 模式下子代理首次 Reply 后立即停止自身，避免其继续消耗
    /// token、产生多余消息；主循环仍会正常读取该 Reply 并推进后续节点。
    /// 会话已被中止（用户 abort）时不动——回显语义交给原中止路径
    /// 。
    fn request_silent_abort(&self, session_id: &str) {
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        {
            let mut state = state.lock().unwrap();
            if state.cancel.load(Ordering::Relaxed) {
                return;
            }
            state.silent_abort = true;
        }
        self.abort_session_scope(session_id, &mut HashSet::new());
    }

    /// 中止某会话所有运行中的后台 Bash 任务，并同步 `background` 事实。
    ///
    /// 被中止任务的记录会先从注册表移除，等待线程收尾时查不到记录，
    /// 因此不会再给 LLM 发完成通知（对齐 `abortBackgroundTasksForSession`）。
    pub fn abort_background_tasks(&self, session_id: &str) {
        if bash_task::abort_tasks_for_session(session_id) > 0 {
            self.sync_session_background(session_id);
        }
    }

    /// 后台 Bash 任务的引擎钩子（注入 `ToolContext`）。
    ///
    /// - `notify`：任务完成 → 注入一条 `origin='bash'` 的自动消息并唤醒消费循环
    ///   （对齐 `LocalShellTask.notifyEngine` → `enqueueAgentMessage(..., 'bash')`）；
    /// - `sync_background`：任务增减 → 重算 `background`（对齐 `syncBackgroundState`）。
    pub fn background_hooks(self: &Arc<Self>) -> bash_task::Hooks {
        let notify_core = Arc::clone(self);
        let sync_core = Arc::clone(self);
        bash_task::Hooks {
            notify: Arc::new(move |session_id: &str, content: &str| {
                notify_core.enqueue_bash_notification(session_id, content);
            }),
            sync_background: Arc::new(move |session_id: &str| {
                sync_core.sync_session_background(session_id);
            }),
        }
    }

    /// 注入一条后台 Bash 完成通知（`QueryEngine.enqueueAgentMessage(content, _, 'bash')`）。
    pub fn enqueue_bash_notification(self: &Arc<Self>, session_id: &str, content: &str) {
        self.enqueue_agent_message(session_id, content, "bash", "");
    }

    /// 注入一条自动消息（`QueryEngine.enqueueAgentMessage`）。
    ///
    /// 消费循环空闲时立刻起一个（`queryBegin` → 消息进上下文 → LLM 回应 → `queryEnd`）；
    /// 正在跑时只入队，由当前循环在轮次边界取用。
    pub fn enqueue_agent_message(
        self: &Arc<Self>,
        session_id: &str,
        content: &str,
        origin: &str,
        from_session_id: &str,
    ) {
        // 会话已关闭 / 被删除：丢弃消息。
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        let should_start = {
            let mut state = state.lock().unwrap();
            // spin 期间父对话完全由 SpinLoop 程序驱动，不跑 LLM 消费循环：
            // 后台通知 / 普通自动消息不得入队，否则 Spin 结束后会被消费循环当成
            // 下一轮 LLM 的输入（docs/features/user-message-pipeline.md 第 3.3 节）。
            if state.work_mode == WorkMode::Spin {
                return;
            }
            state.agent_messages.push(AgentMessage {
                content: content.to_string(),
                origin: origin.to_string(),
                from_session_id: from_session_id.to_string(),
            });
            if state.running {
                false
            } else {
                state.running = true;
                state.cancel.store(false, Ordering::Relaxed);
                state.silent_abort = false;
                true
            }
        };
        self.emit_runtime();
        if should_start {
            let core = Arc::clone(self);
            let worker_session = session_id.to_string();
            std::thread::spawn(move || {
                run_consumer(core, worker_session);
            });
        }
    }

    /// 启动后台任务的周期性提醒调度线程（进程级，只调一次）。
    ///
    /// 线程每秒推进一次所有会话的提醒时钟（`tick_background_reminders`）；持 `Weak`
    /// 引用，`Core` 释放后线程自行退出。
    pub fn start_background_reminder_scheduler(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(
                bash_task::BACKGROUND_REMINDER_TICK_MS,
            ));
            let Some(core) = weak.upgrade() else {
                break;
            };
            core.tick_background_reminders(util::now_millis());
        });
    }

    /// 推进一次所有会话的后台任务提醒时钟。
    ///
    /// 时钟只在会话空闲（`running` / `compacting` 均为假，即 abort 按钮为黄）时前进；
    /// 到点则投递一条 reminder（会启动消费循环让 LLM 立即看到）。
    pub fn tick_background_reminders(self: &Arc<Self>, now_ms: u64) {
        let session_ids: Vec<String> = self.session_order.lock().unwrap().clone();
        for session_id in session_ids {
            let Some(state) = self.session_if_exists(&session_id) else {
                continue;
            };
            // 先取运行中任务快照，再锁会话状态：避免与 `handle_finish`
            // （先锁任务表、后经钩子锁会话状态）形成锁序倒置。
            let running = bash_task::running_tasks_for_session(&session_id);
            if running.is_empty() {
                let mut guard = state.lock().unwrap();
                guard.reminder_entries.clear();
                continue;
            }
            let mut due: Vec<(String, usize)> = Vec::new();
            {
                let mut guard = state.lock().unwrap();
                let awake = !guard.running && !guard.compacting;
                let running_ids: HashSet<&str> =
                    running.iter().map(|task| task.task_id.as_str()).collect();
                guard
                    .reminder_entries
                    .retain(|task_id, _| running_ids.contains(task_id.as_str()));
                for task in &running {
                    let entry = guard
                        .reminder_entries
                        .entry(task.task_id.clone())
                        .or_insert_with(|| ReminderEntry {
                            clock: bash_task::ReminderClock::default(),
                            last_tick_ms: now_ms,
                            last_accessed_ms: task.start_time,
                            fallback_reminded: false,
                        });
                    let delta = now_ms.saturating_sub(entry.last_tick_ms);
                    entry.last_tick_ms = now_ms;
                    if !awake || delta == 0 {
                        continue;
                    }
                    let fired = bash_task::advance_reminder_clock(&mut entry.clock, delta);
                    if let Some(round) = fired.last().copied() {
                        // 投递即一次「访问」：它拉起的那轮查询结束时，
                        // 兜底门槛不会再为同一任务触发。
                        entry.last_accessed_ms = now_ms;
                        due.push((task.task_id.clone(), round));
                    }
                }
            }

            for (task_id, round) in due {
                let Some(task) = running.iter().find(|task| task.task_id == task_id) else {
                    continue;
                };
                let content = bash_task::build_background_reminder_text(
                    &task.task_id,
                    &task.description,
                    &task.command,
                    now_ms.saturating_sub(task.start_time),
                    &bash_task::read_output_tail(
                        &task.task_id,
                        bash_task::BACKGROUND_REMINDER_OUTPUT_CHARS,
                    ),
                    &bash_task::background_reminder_interval_label(round + 1),
                    &bash_task::background_reminder_kill_command(task.pid),
                );
                self.deliver_background_reminder(&session_id, &content);
            }
        }
    }

    /// 投递一条后台任务的周期性提醒：写进 `pending_reminder` 并唤醒消费循环。
    ///
    /// 提醒是 silent 的 user 消息（LLM 可见、UI 不可见）。压缩期间只丢弃：
    /// 调度线程下一轮会再发一次。
    pub fn deliver_background_reminder(self: &Arc<Self>, session_id: &str, content: &str) {
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        let should_start = {
            let mut guard = state.lock().unwrap();
            if guard.cancel.load(Ordering::Relaxed) {
                return;
            }
            // 压缩会整体替换消息数组，此时注入会被覆盖；交给下一轮调度。
            if guard.compacting {
                return;
            }
            // 同一 tick 可能有多个任务同时到点：追加而不是覆盖，否则先到点的会被顶掉。
            guard.pending_reminder = Some(match guard.pending_reminder.take() {
                Some(existing) => format!("{existing}\n\n{content}"),
                None => content.to_string(),
            });
            // 这一轮由 reminder 拉起（或 reminder 已并入当前这轮）：收尾不再补兜底提醒。
            guard.reminder_driven_run = true;
            if guard.running {
                false
            } else {
                guard.running = true;
                guard.cancel.store(false, Ordering::Relaxed);
                guard.silent_abort = false;
                true
            }
        };
        self.emit_runtime();
        if should_start {
            let core = Arc::clone(self);
            let worker_session = session_id.to_string();
            std::thread::spawn(move || {
                run_consumer(core, worker_session);
            });
        }
    }

    /// 子代理工具钩子（注入 `ToolContext`）。
    ///
    /// `spawn` 对应 `AgentTool.call` 的建会话 + 起后台查询；`deliver` 对应
    /// `ReplyTool.call` 的 `targetEngine.submitMessage(message, 'agent', subAgentId)`。
    pub fn subagent_hooks(self: &Arc<Self>) -> tools::SubAgentHooks {
        let spawn_core = Arc::clone(self);
        let spawn_remote_core = Arc::clone(self);
        let deliver_core = Arc::clone(self);
        tools::SubAgentHooks {
            spawn: Arc::new(move |request: tools::SubAgentRequest| {
                spawn_core.create_sub_agent(request)
            }),
            spawn_remote: Arc::new(move |request: tools::SubAgentRequest| {
                spawn_remote_core.spawn_remote_agent(request)
            }),
            deliver: Arc::new(
                move |target: &str, content: &str, from: &str| -> Result<(), String> {
                    deliver_core.deliver_agent_reply(target, content, from)
                },
            ),
        }
    }

    /// 跨工作区派发子代理（specs/023 FR-002）：经宿主在目标工作区建会话。
    ///
    /// 阻塞等宿主应答：失败（目标未打开 / 歧义 / 目标 Core 不可达）直接返回工具错误，
    /// 不创建任何会话。成功后把子会话登记进本地注册表，使 `subAgentRunning`、
    /// `abort_session_scope` 与槽位释放覆盖它。
    pub fn spawn_remote_agent(
        self: &Arc<Self>,
        request: tools::SubAgentRequest,
    ) -> Result<String, String> {
        let Some(target) = request.target.clone() else {
            return Err("target is required for a cross-workspace agent".to_string());
        };
        // specs/024 FR-004：发起方会话的**生效设置**随派发请求携带——子对话继承
        // 发起方，不再取目标工作区默认值。生效值与查询路径同一口径：model / provider 经
        // `config::resolve_provider` 解析为具体值，thinking / webSearch 取会话级
        // 覆盖、缺省回落全局默认，MCP 启用名单取 `read_enabled_mcps` 的会话生效名单
        // （契约成员必选，目标侧不再回落默认值）。提示词模式**不随派发携带**（specs/025
        // FR-005：跨工作区会话恒 normal）。
        let origin_session = self.session(&request.creator_session_id);
        let (agent_mode, model, provider, thinking_effort, web_search, mcp_servers) = {
            let state = origin_session.lock().unwrap();
            let provider_config =
                config::resolve_provider(state.provider.as_deref(), state.model.as_deref())?;
            let provider_key = state
                .provider
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| {
                    crate::settings::settings_snapshot()
                        .map(|snapshot| snapshot.llm.active_provider)
                        .unwrap_or_default()
                });
            (
                state.agent_mode.clone(),
                provider_config.model,
                provider_key,
                state
                    .thinking_effort
                    .clone()
                    .unwrap_or_else(config::default_thinking_effort),
                state.web_search.unwrap_or_else(config::default_web_search),
                crate::mcp_config::read_enabled_mcps(Some(&request.creator_session_id)),
            )
        };
        let payload = json!({
            "type": "crossWorkspaceAgentRequested",
            "sessionId": request.creator_session_id.clone(),
            "targetWorkspaceId": target,
            "role": request.role.clone(),
            "prompt": request.prompt.clone(),
            "description": request.description.clone(),
            "agentMode": agent_mode,
            "thinkingEffort": thinking_effort,
            "model": model,
            "provider": provider,
            "webSearch": web_search,
            "mcpServers": mcp_servers,
        });
        let Some(result) = self.plain_request(HostRenderRequest::new(payload)) else {
            return Err("cross-workspace agent request failed: host did not respond".to_string());
        };
        if result.get("local").and_then(Value::as_bool) == Some(true) {
            // target 就是当前工作区：按缺省策略建本机子代理（specs/023 FR-002）
            return self.create_sub_agent(request);
        }
        if let Some(error) = result.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        let Some(sub_session_id) = result.get("sessionId").and_then(Value::as_str) else {
            return Err("cross-workspace agent response is missing sessionId".to_string());
        };
        crate::subagent::register(sub_session_id, &request.creator_session_id);
        crate::subagent::register_remote(sub_session_id, &request.creator_session_id, &target);
        self.emit_runtime();
        Ok(sub_session_id.to_string())
    }

    /// 创建子代理会话并启动它的消费循环（对齐 `AgentTool.call` 的 1–4 步）。
    ///
    /// 返回子会话 id；调用方立刻把结果交回 LLM，子代理在后台跑。
    pub fn create_sub_agent(
        self: &Arc<Self>,
        request: tools::SubAgentRequest,
    ) -> Result<String, String> {
        let creator = request.creator_session_id.clone();
        let project = self.project_of(&creator)?;
        let sub_session_id = crate::subagent::generate_sub_session_id();
        config::set_session_workspace(&sub_session_id, Some(project.clone()));

        // 继承创建者的会话级配置：agent mode（`inheritAgentMode`：完整继承父会话的
        // manual / risk / auto，子代理只是主对话的执行延伸，权限策略必须与主对话一致，
        // 否则会出现「主对话 manual 逐条确认、子代理却自动放行非危险操作」这类越权行为；
        // 父会话未记录时 `session()` 已按 settings 的 `defaultAgentMode` 兜底）、
        // model / provider、thinking effort、提示词预设（`promptMode`；缺省即 normal，
        // 子代理 system prompt 因此与主对话同款）。
        let (agent_mode, model, provider, thinking_effort, prompt_mode, web_search) = {
            let state = self.session(&creator);
            let state = state.lock().unwrap();
            (
                state.agent_mode.clone(),
                state.model.clone(),
                state.provider.clone(),
                state.thinking_effort.clone(),
                state.prompt_mode.clone(),
                state.web_search.clone(),
            )
        };
        // specs/020 FR-003：会话级配置的继承按角色区分——Master 维持继承创建者；
        // 非 Master 角色（见 `tools::sub_agent_role_tools`）一律固定：提示词预设恒
        // normal、联网搜索恒关、MCP 恒空（工具清单在 `run_query_loop` 按白名单过滤）。
        // 固定值在创建时一次确定，生命周期内不受迟到的会话级覆盖事件影响。
        let role_tools = crate::tools::sub_agent_role_tools(&request.role);
        let (prompt_mode, web_search) = if role_tools.is_some() {
            (None, Some(false))
        } else {
            (prompt_mode, web_search)
        };

        let sub_state = self.session(&sub_session_id);
        {
            let mut state = sub_state.lock().unwrap();
            state.project = Some(project.clone());
            state.agent_mode = agent_mode.clone();
            state.model = model.clone();
            state.provider = provider.clone();
            state.thinking_effort = thinking_effort;
            state.prompt_mode = prompt_mode;
            state.web_search = web_search;
            state.parent_session_id = Some(creator.clone());
            state.sub_agent_role = Some(request.role.clone());
            state.sub_agent_description = Some(request.description.clone());
            // 子代理 system prompt = 主对话同款提示词（按生效预设组装；非 Master 角色
            // 固定 normal）+ 开头 `## Communication` 段。
            state.system_prompt_prefix = Some(prompt::sub_agent_communication_section(&creator));
            // 子代理创建即进入 running：登记后立刻由 `run_sub_agent` 消费，没有 idle 阶段。
            // 必须在下面的 `emit_runtime()` **之前**置位，否则首次出现在快照里是 idle，
            // 流水灯 / 托盘 / abort 按钮要等第一轮结束才看到「子代理在跑」
            // （`specs/defects/subagent-start-missing-runtime-emit.md`）。
            state.running = true;
        }

        // 预建 meta.json：parentSessionId / role / model 必须落盘，
        // 否则对话树关联不上、点进子会话也拿不到「返回主对话」。
        let _ = history::create_sub_agent_metadata(
            &sub_session_id,
            &project,
            &request.description,
            &creator,
            &request.role,
            model.as_deref(),
            provider.as_deref(),
        );
        // 同步把继承来的 agent mode 落进子会话 meta.json 的 context：
        // 重启后重新打开子会话，UI 仍显示继承自主对话的模式。
        self.persist_context(&sub_session_id, json!({ "key": "agentMode", "value": agent_mode }));

        crate::subagent::register(&sub_session_id, &creator);
        self.emit_runtime();
        // 尽早刷新一次对话列表；子代理收尾时还会再刷一次兜底
        self.emit(json!({ "type": "conversationListChanged" }));

        let core = Arc::clone(self);
        let worker_session = sub_session_id.clone();
        let worker_creator = creator.clone();
        let task = request.prompt.clone();
        std::thread::spawn(move || {
            run_sub_agent(core, worker_session, worker_creator, task);
        });

        Ok(sub_session_id)
    }

    /// 在目标工作区创建跨工作区子代理会话并立即开始执行（specs/023 FR-003）。
    ///
    /// 由宿主经 `UiEvent.remoteSubAgentStarted` 下发到目标工作区 Core。会话级配置
    /// 全量继承发起方（specs/025 FR-005：agentMode / thinking / 模型 provider 成对 /
    /// 联网 / MCP 名单），例外是提示词模式恒 normal（不继承，理由见赋值处注释）；
    /// 角色仅决定工具白名单（`run_query_loop` 过滤）。
    pub fn start_remote_sub_agent(self: &Arc<Self>, event: &Value) -> Result<(), String> {
        let field = |key: &str| -> String {
            event
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let session_id = field("sessionId");
        let workspace_path = field("workspacePath");
        let role = field("role");
        let prompt = field("prompt");
        let description = field("description");
        let origin_workspace_id = field("originWorkspaceId");
        let origin_session_id = field("originSessionId");
        // specs/024 FR-004：继承的会话级设置（发起方 Core 解析出的生效值）。契约成员
        // 必选，缺失按接线错误拒绝；`model` 允许空串（provider 未配置默认模型时合法，
        // 见 `config::resolve_provider`），`mcpServers` 允许空名单。
        for key in ["agentMode", "thinkingEffort", "model", "provider"] {
            if event.get(key).and_then(Value::as_str).is_none() {
                return Err("remoteSubAgentStarted is missing required fields".to_string());
            }
        }
        let Some(mcp_servers) = event
            .get("mcpServers")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect::<Vec<String>>()
            })
        else {
            return Err("remoteSubAgentStarted is missing required fields".to_string());
        };
        let Some(web_search) = event.get("webSearch").and_then(Value::as_bool) else {
            return Err("remoteSubAgentStarted is missing required fields".to_string());
        };
        let agent_mode = field("agentMode");
        let thinking_effort = field("thinkingEffort");
        let model = field("model");
        let provider = field("provider");
        if session_id.is_empty() || workspace_path.is_empty() || origin_session_id.is_empty() {
            return Err("remoteSubAgentStarted is missing required fields".to_string());
        }
        if !tools::SUB_AGENT_ROLES.contains(&role.as_str()) {
            return Err(format!("remoteSubAgentStarted has an unknown role: {role}"));
        }
        config::set_session_workspace(&session_id, Some(workspace_path.clone()));

        let state = self.session(&session_id);
        {
            let mut state = state.lock().unwrap();
            state.project = Some(workspace_path.clone());
            // 会话级配置全量继承发起方（specs/025 FR-005）：载荷携带的就是发起方 Core
            // 解析出的生效值，目标侧不回落默认值、也不按角色裁剪（角色仅决定工具
            // 白名单，`run_query_loop` 过滤）。
            state.agent_mode = agent_mode.clone();
            state.model = Some(model.clone());
            state.provider = Some(provider.clone());
            state.thinking_effort = Some(thinking_effort.clone());
            // 提示词模式恒 normal、不继承发起方（specs/025 FR-005）：minimal / mixed 的
            // 首轮按 minimal 预设把工具清单裁成 Bash / Edit，`Reply` 是子代理生命周期
            // 设施（`sub_agent_has_reply` / Reminder 以它为基准），被裁掉后子代理无法
            // 主动回传，只能靠 Reminder 兜底（minimal 更是全程无 Reply）。
            state.prompt_mode = Some("normal".to_string());
            state.web_search = Some(web_search);
            // 跨工作区对话是顶层普通会话：不写 parent_session_id（specs/025 FR-001），
            // 归属由 creator 承载（specs/025 FR-002）
            state.creator = SessionCreator::Agent {
                workspace_id: Some(origin_workspace_id.clone()),
                session_id: origin_session_id.clone(),
            };
            state.sub_agent_role = Some(role.clone());
            state.sub_agent_description = Some(description.clone());
            // SystemPrompt 由目标 Core 按固定模板组装（specs/025 FR-006）：身份取
            // 派发载荷的 origin 字段（宿主填充，不经模型工具入参），内容含创建方
            // 工作区身份 + 会话 id 与 `Reply` 回传要求
            state.system_prompt_prefix = Some(prompt::remote_sub_agent_system_prompt(
                &origin_workspace_id,
                &origin_session_id,
            ));
            state.running = true;
        }

        history::create_remote_sub_agent_metadata(
            &session_id,
            &workspace_path,
            &description,
            &role,
            &origin_workspace_id,
            &origin_session_id,
            Some(&model),
            Some(&provider),
        )?;
        // 继承的会话级设置落进 meta.json 的 context（与 agentMode 的持久化动机相同）：
        // 重启后重新打开子会话，UI 仍显示继承自容器的配置
        self.persist_context(&session_id, json!({ "key": "agentMode", "value": agent_mode }));
        self.persist_context(&session_id, json!({ "key": "thinkingMode", "value": thinking_effort }));
        // 提示词模式恒 normal（specs/025 FR-005，不随派发继承）——落盘让重启重开仍显示
        self.persist_context(&session_id, json!({ "key": "promptMode", "value": "normal" }));
        self.persist_context(&session_id, json!({ "key": "webSearch", "value": web_search }));
        // MCP 启用名单全量继承发起方（specs/025 FR-005）。写成子会话的启用覆盖，
        // 名单里目标 Core 无同名定义的 server 不建立连接（定义是机器本地资源）。
        crate::mcp_config::write_session_enabled(&session_id, &mcp_servers);

        crate::subagent::register(&session_id, &origin_session_id);
        crate::subagent::mark_remote_origin(&session_id, &origin_session_id);
        self.emit_runtime();
        self.emit(json!({ "type": "conversationListChanged" }));

        let core = Arc::clone(self);
        let worker_session = session_id.clone();
        let worker_origin = origin_session_id.clone();
        std::thread::spawn(move || {
            run_sub_agent(core, worker_session, worker_origin, prompt);
        });
        Ok(())
    }

    /// 该会话的跨工作区来源（普通会话为 `None`）
    /// 跨工作区子代理的 Reply 到达发起方会话（specs/023 FR-003）：按普通 agent 消息入队。
    pub fn on_agent_reply_received(
        self: &Arc<Self>,
        session_id: &str,
        from_session_id: &str,
        content: &str,
    ) {
        if let Err(error) = self.deliver_agent_reply(session_id, content, from_session_id) {
            self.log(&format!(
                "cross-workspace reply delivery failed ({session_id}): {error}"
            ));
        }
    }

    /// 跨工作区子代理结束（specs/023 FR-010）：注销远程登记、释放并发槽位、刷新运行时。
    pub fn on_cross_workspace_agent_completed(
        self: &Arc<Self>,
        origin_session_id: &str,
        sub_session_id: &str,
    ) {
        crate::subagent::unregister_remote(sub_session_id);
        crate::subagent::unregister(sub_session_id);
        crate::subagent::release_slot_if_held(origin_session_id);
        self.emit_runtime();
    }

    /// 登记一个由 SpinLoop 起的子代理（`from_session_id`）。
    ///
    /// 登记后它的 Reply 始终按 spin 语义处理（见 [`Self::deliver_agent_reply`]）：
    /// 只落 silent 上下文并交给 SpinLoop 判定，Spin 结束后到达的迟到 Reply 也不会
    /// 进入父对话的消费队列。`spin_host.rs` 在 `run_sub_agent` 拿到子会话 id 后调用。
    pub fn register_spin_sub_agent(&self, parent_session_id: &str, sub_session_id: &str) {
        if let Some(state) = self.session_if_exists(parent_session_id) {
            state
                .lock()
                .unwrap()
                .spin_sub_agents
                .insert(sub_session_id.to_string());
        }
    }

    /// 把子代理的回复投递给目标会话（对齐 `ReplyTool.call` 的 `submitMessage` 分支）。
    ///
    /// spin 语义（docs/features/user-message-pipeline.md 第 3.3 节）：
    /// - 父会话处于 spin，或来源子代理由 SpinLoop 创建时，Reply 只落 silent 上下文并
    ///   经 `emit_reply_delivered` 交给 SpinLoop 做验收判定，绝不进入 `agent_messages`；
    /// - 同一来源子代理只响应一次，重复 / 迟到的 Reply 直接忽略；
    /// - 迟到 Reply 即使到达时 SpinLoop 已结束，也按 spin 语义处理，
    ///   避免父对话被它拉起一轮 LLM。
    pub fn deliver_agent_reply(
        self: &Arc<Self>,
        target_session_id: &str,
        content: &str,
        from_session_id: &str,
    ) -> Result<(), String> {
        let Some(state) = self.session_if_exists(target_session_id) else {
            // specs/023 FR-003：跨工作区子代理的 Reply 目标是发起方会话——它在另一个
            // Core 里。目标等于本会话 creator 指向的会话时交给宿主回投，不当作
            // 「会话不存在」（specs/025 FR-002：归属读 creator）。
            let creator_target = self.session_if_exists(from_session_id).and_then(|state| {
                let guard = state.lock().unwrap();
                match &guard.creator {
                    SessionCreator::Agent { session_id, .. } => Some(session_id.clone()),
                    SessionCreator::User => None,
                }
            });
            if creator_target.as_deref() == Some(target_session_id) {
                self.emit(json!({
                    "type": "crossWorkspaceAgentReplyRequested",
                    "sessionId": target_session_id,
                    "fromSessionId": from_session_id,
                    "content": content,
                }));
                return Ok(());
            }
            return Err(format!("目标会话 {target_session_id} 不存在"));
        };

        // 在同一把锁里判定语义并占位「首条 Reply」：并发的重复 Reply 只有一个能通过。
        let spin_reply = {
            let mut guard = state.lock().unwrap();
            let from_spin = from_session_id != target_session_id
                && (guard.work_mode == WorkMode::Spin
                    || guard.spin_sub_agents.contains(from_session_id));
            if from_spin {
                if !guard.spin_replied.insert(from_session_id.to_string()) {
                    return Ok(());
                }
                true
            } else if guard.spin_replied.contains(from_session_id) {
                // 曾在 spin 语义下消费过该来源：后续 Reply 一律忽略
                return Ok(());
            } else {
                false
            }
        };

        if spin_reply {
            persist_spin_reply(self, target_session_id, &state, content, from_session_id);
            // 供前台 `sleep` 命令监听：等待期间收到子代理 Reply 时立刻转入后台。
            // 必须先于静默中止：监听器（SpinLoop / sleep 检测）要先拿到 Reply。
            crate::subagent::emit_reply_delivered(
                target_session_id,
                from_session_id,
                content,
            );
            // 子代理首次 Reply 后立即
            // 静默中止其自身引擎——否则它会拿到 Reply 的 tool_result 后再跑一轮
            // LLM（多余 token，还可能重复 Reply）。
            if from_session_id != target_session_id {
                self.request_silent_abort(from_session_id);
            }
        } else {
            self.enqueue_agent_message(
                target_session_id,
                content,
                "agent",
                from_session_id,
            );
            // 供前台 `sleep` 命令监听：等待期间收到子代理 Reply 时立刻转入后台
            crate::subagent::emit_reply_delivered(
                target_session_id,
                from_session_id,
                content,
            );
        }
        Ok(())
    }

    /// 无 LLM 直连执行一次工具。
    ///
    /// 构造一条 assistant tool_use 消息并执行工具，把 tool_result 落盘 + 进上下文；
    /// 供 SpinLoop 起子代理使用。不走 LLM、不消费队列。
    ///
    /// 事件序列对齐 `inject_skill_tool_use`：
    /// `toolCall`（授权前）→ `toolPermissionRequested` → `toolCall`（执行前）→ `toolResult`。
    /// webview 收到 `toolCall` 会关掉 thinking 动画——Spin 的父对话不跑 LLM，
    /// 动画本就不该持续亮着。
    pub fn submit_tool_use(
        self: &Arc<Self>,
        session_id: &str,
        tool_name: &str,
        input: &Value,
    ) -> Result<(), String> {
        let state = self.session(session_id);
        // 已请求中止时不再执行
        if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let project = self.project_of(session_id)?;

        let tool_use_id = util::unique_id("tooluse");
        let assistant_message = json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": tool_use_id,
                    "name": tool_name,
                    "input": input,
                }],
            },
            "uuid": format!("assistant_{}", util::now_millis()),
            "timestamp": util::now_millis(),
        });
        persist_message(self, session_id, &project, &state, &assistant_message)?;
        // 每条落盘消息各发一次 `conversationListChanged`（对齐 `Conversation.appendMessage`）
        announce_message_appended(self, session_id, &project, false);

        // 授权前先发一次 `toolCall`（UI 上架 running 卡片）
        self.emit(json!({
            "type": "toolCall",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "toolName": tool_name,
        }));
        let agent_mode = state.lock().unwrap().agent_mode.clone();
        match self.resolve_permission(session_id, &tool_use_id, tool_name, input, &agent_mode, &project)
        {
            PermissionOutcome::Allowed { .. } => {
                // 执行前再发一次 `toolCall`（卡片转「执行中」）
                self.emit(json!({
                    "type": "toolCall",
                    "sessionId": session_id,
                    "toolUseId": tool_use_id,
                    "toolName": tool_name,
                }));
            }
            PermissionOutcome::Denied { message, .. } => {
                // 拒绝分支：卡片置 error，补一条 error tool_result，不执行工具
                self.emit(json!({
                    "type": "toolResult",
                    "sessionId": session_id,
                    "toolUseId": tool_use_id,
                    "toolName": tool_name,
                    "output": message,
                    "status": "error",
                }));
                let result_message = json!({
                    "type": "user",
                    "message": { "role": "user", "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": message,
                        "exit_code": -1,
                        "is_canceled": false,
                    }] },
                    "uuid": util::unique_id("tool_result"),
                    "timestamp": util::now_millis(),
                });
                persist_message(self, session_id, &project, &state, &result_message)?;
                emit_highlight_languages(self, &result_message);
                announce_message_appended(self, session_id, &project, false);
                return Ok(());
            }
        }

        let outcome = execute_tool(self, session_id, &project, &state, &tool_use_id, tool_name, input);
        let block = emit_tool_outcome(self, session_id, &project, &tool_use_id, tool_name, &outcome);
        let result_message = json!({
            "type": "user",
            "message": { "role": "user", "content": [block] },
            "uuid": util::unique_id("tool_result"),
            "timestamp": util::now_millis(),
        });
        persist_message(self, session_id, &project, &state, &result_message)?;
        emit_highlight_languages(self, &result_message);
        announce_message_appended(self, session_id, &project, false);
        Ok(())
    }

    /// 重算并同步会话的 `background` 事实（`markSessionBackground`）。
    pub fn sync_session_background(&self, session_id: &str) {
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        let background = bash_task::running_count_for_session(session_id) > 0;
        {
            let mut state = state.lock().unwrap();
            if state.background == background {
                return;
            }
            state.background = background;
        }
        self.emit_runtime();
    }

    pub fn on_conversation_deleted(&self, session_id: &str) {
        // conversationDeleted 对闭包里每个会话先中止、释放资源再删盘：
        // **先**中止在跑的查询，再删盘。否则运行中的轮次会在删除后继续
        // `append_message`，把 `<sid>.jsonl` / `<sid>.meta.json` 重新建出来，会话"复活"。
        // 受影响闭包与 `deleteConversation` 相同：会话自身 + 所有层级的子孙对话。
        let project = self.project_of(session_id).ok();
        let closure = project
            .as_deref()
            .map(|project| history::conversation_closure(session_id, project))
            .unwrap_or_else(|| vec![session_id.to_string()]);
        for id in &closure {
            self.abort_session_scope(id, &mut HashSet::new());
            self.drop_session(id);
            tools::clear_session_todos(id);
            // MCP：释放引用 + 清掉会话级启用覆盖（对齐 `clearSessionMcpOverride`）
            crate::mcp::on_session_closed(id);
            crate::mcp_config::clear_session_mcp_override(id);
        }
        if let Some(project) = project {
            let _ = history::delete_conversation(session_id, &project);
        }
        self.emit(json!({ "type": "conversationListChanged" }));
    }

    /// 只写 `meta.json` 的标题，不发任何事件。
    ///
    /// `meta.json` 缺失时**建档**：显式改标题（用户重命名 / 智能命名 / spin 改名）
    /// 必须落到磁盘，否则广播出去的 `titleChanged` 与磁盘不一致——重启 / 刷新列表后
    /// 标题回到「未命名」。`messageCount` 从已落盘的 `.jsonl` 数出（口径同
    /// `touch_metadata`），并补空 `.jsonl`（加载要求文件存在）。
    /// 返回 `false` 表示会话没有工作目录（标题没写成）。
    fn write_conversation_title(&self, session_id: &str, title: &str) -> bool {
        let Ok(project) = self.project_of(session_id) else {
            return false;
        };
        let count = history::count_messages(&history::load_messages(session_id, &project));
        let title = title.to_string();
        let title_for_fallback = title.clone();
        let _ = history::update_metadata(
            session_id,
            &project,
            || {
                json!({
                    "sessionId": session_id,
                    "project": project,
                    "title": title_for_fallback,
                    "createdAt": util::now_millis(),
                    "updatedAt": util::now_millis(),
                    "messageCount": count,
                })
            },
            |metadata| {
                metadata["title"] = json!(title);
            },
        );
        if let Ok(path) = history::messages_path(session_id, &project) {
            if !path.exists() {
                let _ = std::fs::write(&path, "");
            }
        }
        true
    }

    /// `/spin` 等「内部改标题」路径：写 `meta.json` 并广播 `titleChanged`
    /// `titleChanged` 的事件表来源包含 skills/bundled/spin，
    /// webview 靠它刷新打开中对话的标题栏。
    /// 不涉及 `conversationRenamed`——那是 UI 发起重命名的 UiEvent，方向不同。
    /// 列表变化与重命名同口径：标题已落盘，广播 `conversationListChanged` 让宿主
    /// 重读磁盘分发。返回 `false` 表示会话没有工作目录（标题没写成）。
    pub fn update_conversation_title(&self, session_id: &str, title: &str) -> bool {
        if !self.write_conversation_title(session_id, title) {
            return false;
        }
        self.emit(json!({ "type": "titleChanged", "sessionId": session_id, "title": title }));
        self.emit(json!({ "type": "conversationListChanged" }));
        true
    }

    /// 工作模式切换的唯一写入点（specs/016 FR-004 / FR-005）：改
    /// `SessionState.work_mode`、写 `meta.json` 的 `workMode`、广播 `workModeChanged`。
    /// 调用方：`spin_host.rs` 的进入点。spin 单向，生产路径不写回 `Normal`
    /// （`Normal` 只作为缺省值与存量会话的恢复值）。
    /// 会话已删除（`session_if_exists` 为空）时整体跳过——不复活会话、不落盘、不发事件。
    pub fn set_work_mode(&self, session_id: &str, mode: WorkMode) {
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        state.lock().unwrap().work_mode = mode;
        let Ok(project) = self.project_of(session_id) else {
            return;
        };
        let mode_text = work_mode_text(mode);
        let _ = history::update_metadata(
            session_id,
            &project,
            || json!({ "sessionId": session_id, "project": project }),
            |metadata| {
                metadata["workMode"] = json!(mode_text);
            },
        );
        self.emit(json!({
            "type": "workModeChanged",
            "sessionId": session_id,
            "workMode": mode_text,
        }));
    }

    pub fn on_conversation_renamed(&self, session_id: &str, title: &str) {
        // meta.json 缺失时建档
        // （标题先落盘），再照常广播事件——UI 只消费真实数据变更后的事件。
        if !self.write_conversation_title(session_id, title) {
            return;
        }
        // 对齐 `initializeCoreEvents` 的 conversationRenamed：
        // 先广播 titleChanged（宿主据此更新标题栏），再广播列表变化。
        self.emit(json!({ "type": "titleChanged", "sessionId": session_id, "title": title }));
        self.emit(json!({ "type": "conversationListChanged" }));
    }

    pub fn on_context_updated(&self, session_id: &str, changes: &[Value]) {
        let Ok(project) = self.project_of(session_id) else {
            return;
        };
        let _ = history::update_context(session_id, &project, changes);
    }

    pub fn on_session_config_changed(&self, session_id: &str, change: &Value) {
        let Some(key) = change.get("key").and_then(Value::as_str) else {
            return;
        };
        let value = change.get("value").cloned().unwrap_or(Value::Null);
        let state = self.session(session_id);
        // 广播给 UI 的 change 与 TS 契约逐字段对齐：model 用 `ref` 承载身份，其余用 `value`。
        let emitted: Value = match key {
            "model" => {
                let model = value
                    .get("model")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string());
                let provider = value
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string());
                {
                    let mut state = state.lock().unwrap();
                    state.model = model.clone();
                    state.provider = provider.clone();
                }
                if let Ok(project) = self.project_of(session_id) {
                    let _ = history::update_context(
                        session_id,
                        &project,
                        &[json!({ "key": "model", "value": model }),
                          json!({ "key": "provider", "value": provider })],
                    );
                }
                json!({
                    "key": "model",
                    "ref": { "model": model, "provider": provider },
                })
            }
            "agentMode" => {
                let mode = value.as_str().unwrap_or("manual").to_string();
                state.lock().unwrap().agent_mode = mode.clone();
                self.persist_context(session_id, json!({ "key": "agentMode", "value": mode }));
                json!({ "key": "agentMode", "value": mode })
            }
            "thinkingEffort" => {
                let mode = value.as_str().unwrap_or("off").to_string();
                state.lock().unwrap().thinking_effort = Some(mode.clone());
                // 落盘字段沿用既有名字 thinkingMode
                self.persist_context(session_id, json!({ "key": "thinkingMode", "value": mode }));
                json!({ "key": "thinkingEffort", "value": mode })
            }
            "promptMode" => {
                let mode = value.as_str().unwrap_or("normal").to_string();
                state.lock().unwrap().prompt_mode = Some(mode.clone());
                self.persist_context(session_id, json!({ "key": "promptMode", "value": mode }));
                json!({ "key": "promptMode", "value": mode })
            }
            "webSearch" => {
                let enabled = value.as_bool().unwrap_or(false);
                state.lock().unwrap().web_search = Some(enabled);
                self.persist_context(session_id, json!({ "key": "webSearch", "value": enabled }));
                json!({ "key": "webSearch", "value": enabled })
            }
            "mcpEnabled" => {
                // `value` 是**该会话启用后的完整 server 名列表**。写入 meta.json 的会话覆盖，
                // 再让 MCPHost 按新列表差量同步连接。
                let names: Vec<String> = value
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                crate::mcp_config::write_session_enabled(session_id, &names);
                crate::mcp::on_session_enabled_changed(session_id);
                json!({ "key": "mcpEnabled", "value": names })
            }
            _ => change.clone(),
        };
        self.emit(json!({
            "type": "sessionConfigChanged",
            "sessionId": session_id,
            "change": emitted,
        }));
    }

    /// 把一条会话级配置写进 `meta.json` 的 context
    fn persist_context(&self, session_id: &str, change: Value) {
        if let Ok(project) = self.project_of(session_id) {
            let _ = history::update_context(session_id, &project, &[change]);
        }
    }

    // ==================== 用户消息 ====================

    /// `UiEvent.userMessageSubmitted`：消息进队列，必要时拉起消费循环
    pub fn on_user_message(self: &Arc<Self>, payload: &Value) {
        let Some(session_id) = payload.get("sessionId").and_then(Value::as_str) else {
            self.log("userMessageSubmitted without sessionId; dropped");
            return;
        };
        let session_id = session_id.to_string();

        // 快照兜底：Core 重启后会话工作目录表（内存态）丢失，宿主随消息带的活动
        // 工作目录据此恢复登记。仅在该会话**尚未登记**时生效——正规登记入口是
        // `sessionWorkspaceAssigned`（一份事实一个写入点），不在这里覆盖既有登记
        // （活动目录未必是该会话归属的目录）。
        if config::session_workspace(&session_id).is_none() {
            if let Some(project) = payload.get("workspacePath").and_then(Value::as_str) {
                let project = config::normalize_workspace(project);
                config::set_session_workspace(&session_id, Some(project.clone()));
                let state = self.session(&session_id);
                let mut state = state.lock().unwrap();
                if state.project.is_none() {
                    state.project = Some(project);
                }
            }
        }

        // 先把磁盘上的历史 / 会话配置载入内存，再应用随消息携带的会话覆盖。
        // 顺序：先按 meta.json 恢复引擎，
        // 之后才把 payload 的 agentMode / thinkingMode / webSearch /
        // model 应用到引擎——否则 payload 覆盖会被 meta.json 的旧值反向覆盖。
        let _ = self.ensure_loaded(&session_id);

        // spin 期间父对话完全由 SpinLoop 程序控制，禁止用户输入：UI 已禁用输入框，
        // 这里在 Core 侧兜底，丢弃任何到达的 `userMessageSubmitted`——不入队、不拉起
        // 消费循环，避免 Spin 结束后把这条消息当成下一轮 LLM 输入
        // （docs/features/user-message-pipeline.md 第 3.3 节）。
        {
            let state = self.session(&session_id);
            if state.lock().unwrap().work_mode == WorkMode::Spin {
                self.log("userMessageSubmitted while spin; dropped");
                return;
            }
        }

        // 随消息携带的会话覆盖：
        // agentMode / thinkingMode / webSearch / model 由宿主按会话解析后带上。
        let mut model_changed: Option<(String, String)> = None;
        {
            let state = self.session(&session_id);
            let mut state = state.lock().unwrap();
            if let Some(mode) = payload.get("agentMode").and_then(Value::as_str) {
                state.agent_mode = mode.to_string();
            }
            if let Some(mode) = payload.get("thinkingMode").and_then(Value::as_str) {
                state.thinking_effort = Some(mode.to_string());
            }
            // webSearch 只由消息负载承担**新会话种子**职责：会话已确立（配置事件
            // 写入、meta.json 恢复值、settings 默认种子都算）时负载不得覆盖——
            // webview 本地值一旦与 core 发散，每条消息都会把勾选拉回旧值
            // （specs/defects/websearch-recheck-clobbered-by-payload，架构原则 4）。
            if state.web_search.is_none() {
                if let Some(enabled) = payload.get("webSearch").and_then(Value::as_bool) {
                    state.web_search = Some(enabled);
                }
            }
            if let Some(model_ref) = payload.get("model") {
                let model = model_ref.get("model").and_then(Value::as_str).map(|s| s.to_string());
                let provider = model_ref
                    .get("provider")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string());
                if state.model != model || state.provider != provider {
                    state.model = model.clone();
                    state.provider = provider.clone();
                    if let (Some(model), Some(provider)) = (model, provider) {
                        model_changed = Some((model, provider));
                    }
                }
            }
        }
        if let Some((model, provider)) = model_changed {
            self.persist_context(&session_id, json!({ "key": "model", "value": model }));
            self.persist_context(&session_id, json!({ "key": "provider", "value": provider }));
        }

        let state = self.session(&session_id);
        let message = build_user_message(payload);
        let should_start = {
            let mut state = state.lock().unwrap();
            // **替换**排队中的旧消息
            state.pending_user_message = Some(message);
            if state.running || state.compacting {
                // 压缩期间只入队不启动消费循环：
                // 压缩会整体替换消息数组，与运行中的查询并发会互相踩踏）
                false
            } else {
                state.running = true;
                state.cancel.store(false, Ordering::Relaxed);
                state.silent_abort = false;
                // 手工转后台的暂停标记只对「当时那轮查询」有意义：新用户消息
                // 开启新一轮，清掉残留标记。
                state.pause_loop.clear();
                true
            }
        };
        self.emit_runtime();
        if should_start {
            let core = Arc::clone(self);
            let worker_session = session_id.clone();
            std::thread::spawn(move || {
                run_consumer(core, worker_session);
            });
        }
    }

    // ==================== 压缩 ====================

    /// 会话是否空闲（`sessionResources.isSessionIdle` 的唯一入口）：
    /// 自身不忙**且**所有已登记子代理都空闲。
    pub fn is_session_idle(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().unwrap();
        Core::is_idle_deep(&sessions, session_id, &mut HashSet::new())
    }

    /// 用户手动触发压缩（对齐 `Integration.requestCompact`）。
    ///
    /// - 没有可压缩的消息：什么都不做（不排队、不通知 UI、不替换消息）
    /// - 已在压缩中：忽略重复请求
    /// - 会话非空闲：登记「待压缩」，经运行时快照的 `pendingCompact` 告知 UI，
    ///   交由下一轮对话开始时执行
    /// - 否则：立即压缩，收尾时唤醒压缩期间入队的消息
    pub fn request_compact(self: &Arc<Self>, session_id: &str) {
        let Some(state) = self.session_if_exists(session_id) else {
            self.log("compactRequested for unknown session; dropped");
            return;
        };
        let messages = state.lock().unwrap().messages.clone();
        if !compact::has_compactable_messages(&messages, COMPACT_MAX_MESSAGES_TO_KEEP) {
            self.log("no compactable messages, ignoring compress request");
            return;
        }
        if compact::is_compacting(session_id) {
            self.log("compact already in progress, ignoring request");
            return;
        }
        if !self.is_session_idle(session_id) {
            if !compact::is_pending_compact(session_id) {
                compact::mark_pending_compact(session_id);
                // 排队事实经运行时快照推给 UI（`pendingCompact`），不再发 once 通知
                self.emit_runtime();
            }
            return;
        }

        // 立即压缩：清掉可能存在的「待压缩」标记，避免本轮压缩完成后下一轮又压一次
        compact::unmark_pending_compact(session_id);
        let Ok(project) = self.project_of(session_id) else {
            // 标记已清除但没有压缩流程会推送，补一次快照让 UI 还原用量文本
            self.emit_runtime();
            return;
        };
        let applied =
            compact::compact_and_apply_messages(self, session_id, &project, &state, false, None);
        if !applied {
            // 无可摘要内容：`compact_conversation` 提前返回、不会推送 compacting 快照
            self.emit_runtime();
            self.log("compact skipped (no messages to summarize)");
            return;
        }
        self.resume_after_compact(session_id);
    }

    /// 压缩结束后调用：压缩期间入队的消息此时才启动消费循环。
    ///
    /// 压缩过程中 `on_user_message` 只入队不启动 consumer，因此必须在压缩收尾时
    /// 显式唤醒一次，否则消息会一直卡在队列里。已在消费中时不重复启动。
    pub fn resume_after_compact(self: &Arc<Self>, session_id: &str) {
        if compact::is_compacting(session_id) {
            return;
        }
        let Some(state) = self.session_if_exists(session_id) else {
            return;
        };
        let should_start = {
            let mut state = state.lock().unwrap();
            if state.running {
                return;
            }
            let has_queued = state.pending_user_message.is_some()
                || state.pending_reminder.is_some()
                || !state.agent_messages.is_empty();
            if !has_queued {
                return;
            }
            state.running = true;
            state.cancel.store(false, Ordering::Relaxed);
            state.silent_abort = false;
            true
        };
        if should_start {
            let core = Arc::clone(self);
            let worker_session = session_id.to_string();
            std::thread::spawn(move || {
                run_consumer(core, worker_session);
            });
        }
    }

    /// 载入会话消息（首次打开时从磁盘读）
    pub fn ensure_loaded(&self, session_id: &str) -> Result<(), String> {
        let project = self.project_of(session_id)?;
        let state = self.session(session_id);
        let mut state = state.lock().unwrap();
        if state.project.is_none() {
            state.project = Some(project.clone());
        }
        if state.messages.is_empty() {
            let mut messages = history::load_messages(session_id, &project);
            // `last_uuid` 取**落盘**的最后一条消息：从后往前找
            // 第一条非 `tool_recovered_*` 的消息，避免后续新消息的 parentUuid 挂到
            // 合成恢复消息上（其自身 parentUuid 指向 tool_use 所属 assistant）。
            state.last_uuid = messages.iter().rev().find_map(|message| {
                let uuid = message.get("uuid").and_then(Value::as_str)?;
                if uuid.starts_with("tool_recovered_") {
                    None
                } else {
                    Some(uuid.to_string())
                }
            });
            // 磁盘上的消息都视为已落盘；下面补的合成 tool_result 等下一次持久化时机补写
            state.persisted_count = messages.len();
            // 崩溃恢复：给缺失 tool_result 的 tool_use 补取消结果（内存）
            history::ensure_tool_results(&mut messages);
            state.messages = messages;
        }
        if let Some(metadata) = history::load_metadata(session_id, &project) {
            state.agent_mode = prompt::agent_mode_of(&metadata);
            // 恢复创建者归属（specs/025 FR-002）：缺失 / 形态不对是数据异常，加载失败
            // 不回退（未发布无兼容义务）
            state.creator = history::creator_of_metadata(&metadata)?;
            let (provider, model) = history::model_ref_of_session(session_id, &project);
            state.provider = provider;
            state.model = model;
            // 恢复会话级 thinkingMode / webSearch（meta.json 优先，其次 settings 默认）
            let context = metadata.get("context");
            state.thinking_effort = context
                .and_then(|value| value.get("thinkingMode"))
                .and_then(Value::as_str)
                .map(|value| value.to_string())
                .or_else(|| Some(config::default_thinking_effort()));
            state.web_search = context
                .and_then(|value| value.get("webSearch"))
                .and_then(Value::as_bool)
                .or_else(|| Some(config::default_web_search()));
            // 会话级提示词预设：meta.json 的 context.promptMode 优先，非法 / 缺省回退 normal。
            // 只在本会话尚未有预设时写入，避免覆盖用户在首条消息前刚做的选择
            // （对齐 `restoreConversationEngine` 先读 meta、`applyPendingPromptMode` 再覆盖）。
            if state.prompt_mode.is_none() {
                state.prompt_mode = Some(
                    prompt::normalize_prompt_mode(
                        context
                            .and_then(|value| value.get("promptMode"))
                            .and_then(Value::as_str),
                    )
                    .to_string(),
                );
            }
            // 恢复工作模式（specs/016 FR-005）：应用中断在 spin 执行中时 meta 停在
            // spin，重启加载后保持 spin 态（UI 禁用输入）。spin 单向，恢复出的会话
            // 同样不退出（abort 也不恢复 Normal）。
            if let Some(text) = metadata.get("workMode").and_then(Value::as_str) {
                state.work_mode = work_mode_from_text(text);
            }
        }
        Ok(())
    }

    // ==================== 权限 ====================

    /// 工具权限：按 agentMode 加工后决定放行 / 拒绝。
    ///
    /// `ask` **不等于拒绝**：它表示「需要弹确认框」，因此再发一次
    /// `CoreRequest.userChoice` 拿用户的选择。
    fn resolve_permission(
        &self,
        session_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        input: &Value,
        agent_mode: &str,
        cwd: &str,
    ) -> PermissionOutcome {
        // 无论 allow / deny / ask，都先发一次
        // `toolPermissionRequested`（UI 借此上架工具卡片、写 Edit / Write 的 `_meta`、
        // 在 manual 模式下打开宿主 diff），再按回传的 behavior 决定执行 / 拒绝 / 弹框。
        let (perm_result, display_args) =
            permission::resolve_tool_permission(tool_name, input, agent_mode, cwd, session_id);
        let perm_result = self.request_tool_permission(
            session_id,
            tool_use_id,
            tool_name,
            &perm_result,
            &display_args,
            agent_mode,
        );
        let Some(perm_result) = perm_result else {
            return PermissionOutcome::Denied {
                message: "Permission request failed.".to_string(),
                terminate: false,
            };
        };
        match perm_result.get("behavior").and_then(Value::as_str) {
            Some("allow") => PermissionOutcome::Allowed {
                updated_input: perm_result.get("updatedInput").cloned(),
            },
            // `checkPermissions` 直接 deny（入参非法 / old_string 找不到或匹配多处）：
            // 权限层未要求终止时只结束本批工具，
            // 结果仍交回 LLM；AgentTool 的嵌套调用拒绝显式带 `shouldTerminate: true`。
            Some("deny") => PermissionOutcome::Denied {
                message: perm_result
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Permission denied.")
                    .to_string(),
                // AgentTool 的嵌套调用拒绝带 `shouldTerminate: true`（拒绝后直接结束本轮）
                terminate: perm_result
                    .get("shouldTerminate")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            },
            // 权限结果保持 ask：由用户选择框决定
            Some("ask") => self.request_user_choice(session_id, tool_name, &perm_result),
            _ => PermissionOutcome::Denied {
                message: "Permission request failed.".to_string(),
                terminate: false,
            },
        }
    }

    /// `CoreRequest.toolPermissionRequested`：UI 上架工具卡片并回传权限结果
    ///
    /// 走 `plain_request`：这段往返不算「等用户」（真确认框由随后的 `userChoice` 弹），
    /// 否则每次工具调用都会凭空多出一次 `running → waiting` 迁移——托盘 / 侧栏会闪一下，
    /// （`docs/core/session-runtime.md` 第 1 节）。
    fn request_tool_permission(
        &self,
        session_id: &str,
        tool_use_id: &str,
        tool_name: &str,
        perm_result: &Value,
        display_args: &Value,
        agent_mode: &str,
    ) -> Option<Value> {
        self.plain_request(HostRenderRequest::new(json!({
            "type": "toolPermissionRequested",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "toolName": tool_name,
            "permResult": perm_result,
            "displayArgs": display_args,
            "agentMode": agent_mode,
        })))
    }

    /// `CoreRequest.userChoice`：弹确认框，index 0 = 允许，其余 = 拒绝
    fn request_user_choice(
        &self,
        session_id: &str,
        tool_name: &str,
        perm_result: &Value,
    ) -> PermissionOutcome {
        let choices = perm_result.get("choices").cloned().unwrap_or_else(|| {
            json!([
                { "label": "允许", "description": "继续执行" },
                { "label": "拒绝", "description": "取消操作" },
            ])
        });
        let mut options = Map::new();
        options.insert("toolName".to_string(), json!(tool_name));
        options.insert(
            "message".to_string(),
            json!(perm_result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("请确认是否执行此操作")),
        );
        options.insert("choices".to_string(), choices);
        for key in [
            "showPreview",
            "previewContent",
            "previewTitle",
            "beforeContent",
            "afterContent",
            "contextBefore",
            "contextAfter",
        ] {
            if let Some(value) = perm_result.get(key) {
                if !value.is_null() {
                    options.insert(key.to_string(), value.clone());
                }
            }
        }
        let Some(result) = self.waiting_request(UserBlockingRequest::user_choice(
            session_id,
            Value::Object(options),
        )) else {
            // 请求失败（无订阅者 / 超时）按「用户不带原因地拒绝」处理（终止本轮）。
            return PermissionOutcome::Denied {
                message: "用户拒绝操作".to_string(),
                terminate: true,
            };
        };
        if result.get("index").and_then(Value::as_i64) == Some(0) {
            return PermissionOutcome::Allowed {
                updated_input: None,
            };
        }
        let mut message = "用户拒绝操作".to_string();
        let mut has_reply = false;
        if let Some(reply) = result.get("reply").and_then(Value::as_str) {
            let reply = crate::util::js_trim(reply);
            if !reply.is_empty() {
                message.push_str(&format!("，原因：{reply}"));
                has_reply = true;
            }
        }
        // `shouldTerminate = !hasReply`——带了拒绝原因说明用户还想继续对话，
        // 否则直接结束本轮（不再把 tool_result 交回 LLM）。
        PermissionOutcome::Denied {
            message,
            terminate: !has_reply,
        }
    }

    /// 把请求交给总线（无订阅者时返回 `None`，由各调用点按自己的口径兜底）
    fn send_request(&self, request: Value) -> Option<(u64, Receiver<Value>)> {
        let mut bus = self.bus.lock().unwrap();
        bus.request(request)
    }

    /// 等一次应答；超时从 pending 表移除，避免反复超时导致无界增长
    fn await_response(&self, id: u64, receiver: Receiver<Value>) -> Option<Value> {
        let response = bus::wait_response(receiver, Duration::from_secs(3_600));
        if response.is_none() {
            let mut bus = self.bus.lock().unwrap();
            bus.cancel_request(id);
        }
        response
    }

    /// 发一次 `CoreRequest` 并等待应答，**不改变**会话的 `waiting`
    ///
    /// 只接受 `HostRenderRequest`：给「宿主只是渲染 / 回传」的请求用
    /// （`toolPermissionRequested`：上架工具卡片、写 Edit / Write 的 `_meta`、manual 下
    /// 打开宿主 diff）——宿主拿到 `permResult` 就返回，`ask` 也直接返回（真确认框随后由
    /// `userChoice` 弹），这段往返里并没有在等用户：
    /// `docs/core/session-runtime.md` 第 1 节。
    fn plain_request(&self, request: HostRenderRequest) -> Option<Value> {
        let (id, receiver) = self.send_request(request.0)?;
        self.await_response(id, receiver)
    }

    /// 发一次 `CoreRequest` 并等待应答；在途期间把会话标记为 `waiting`
    ///
    /// 只接受 `UserBlockingRequest`：真的在等用户的请求（`userChoice`）。用户选择框的
    /// 弹出 / 应答由 `userChoicePendingChanged` 与这里共同决定 `waiting`
    /// （`docs/core/session-runtime.md` 第 1 节）。
    fn waiting_request(&self, request: UserBlockingRequest) -> Option<Value> {
        let (id, receiver) = self.send_request(request.payload)?;
        if let Some(state) = self.session_if_exists(&request.session_id) {
            state.lock().unwrap().waiting = true;
        }
        self.emit_runtime();
        let response = self.await_response(id, receiver);
        if let Some(state) = self.session_if_exists(&request.session_id) {
            state.lock().unwrap().waiting = false;
        }
        self.emit_runtime();
        response
    }
}

/// 宿主只是渲染 / 回传的请求（`CoreRequest.toolPermissionRequested` 一族）。
///
/// 往返期间不改变 `sessionRuntime.waiting`。与 [`UserBlockingRequest`] 分成两个类型，
/// 是为了让「这次请求算不算在等用户」由载荷类型承载，而不是由发起点记不记得换 helper
/// 决定——渲染往返在类型上就拿不到标记 `waiting` 的入口
/// （`docs/core/session-runtime.md` 第 1 节）。
struct HostRenderRequest(Value);

impl HostRenderRequest {
    fn new(payload: Value) -> Self {
        Self(payload)
    }
}

/// 真的在等用户的请求（`CoreRequest.userChoice`）：往返期间把会话标记为 `waiting`。
///
/// 只能由 `user_choice` 构造：`type` / `sessionId` / `options` 三字段在这一处组装，
/// 调用方无法把别的请求类型塞进标记 `waiting` 的路径。
struct UserBlockingRequest {
    session_id: String,
    payload: Value,
}

impl UserBlockingRequest {
    fn user_choice(session_id: &str, options: Value) -> Self {
        Self {
            session_id: session_id.to_string(),
            payload: json!({
                "type": "userChoice",
                "sessionId": session_id,
                "options": options,
            }),
        }
    }
}

/// 权限决策结果。`updated_input` 只在 UI / 权限层改写了入参时出现，
/// 缺省表示沿用原始入参。
///
/// `terminate` 对应 `shouldPreventContinuation`：
/// 用户在确认框里**不带原因地拒绝**时，本批工具全部收尾后直接结束本轮查询
/// （不再把 tool_result 交回 LLM）；`checkPermissions` 直接 deny 则只结束本批工具，
/// 仍把结果交回 LLM 让它换一种方式重试。
enum PermissionOutcome {
    Allowed { updated_input: Option<Value> },
    Denied { message: String, terminate: bool },
}

// ==================== 消费循环 ====================

fn run_consumer(core: Arc<Core>, session_id: String) {
    run_consumer_with_ui(core, session_id, true);
}

/// 消费循环；`emit_ui` 控制是否由本函数发 `queryBegin` / `queryEnd`。
///
/// 子代理由 `AgentTool` 自己管一对（手动 emit、不重复发），因此传 `false`。
fn run_consumer_with_ui(core: Arc<Core>, session_id: String, emit_ui: bool) {
    // `queryBegin` / `queryEnd` 是**消费循环**级：
    // queryBegin 在启动 consumer 时发一次，`finalizeIdle` 在队列彻底排空 / 中止时
    // 发一次 queryEnd）。一轮用户消息内部可能包含「reminder 追问」「排队消息并入」
    // 等多个 LLM 轮次，它们同属一次 consumer，只应有一对 queryBegin / queryEnd；
    // 不能按 `run_turn` 逐轮发，否则 reminder 追问会让 UI 看到「结束又立即开始」。
    if core.session_if_exists(&session_id).is_none() {
        // 会话已被关闭 / 删除：不跑任何轮次，也不发 queryBegin / queryEnd
        return;
    }
    if emit_ui {
        core.emit(json!({ "type": "queryBegin", "sessionId": session_id }));
    }
    loop {
        // 用 `session_if_exists` 而不是 `session`：会话被关闭 / 删除（`drop_session`）
        // 后消费循环必须立刻退出，否则会「复活」一个刚删除的会话，
        // 并且与宿主重新拉起的新循环抢同一个会话的队列。
        let Some(state) = core.session_if_exists(&session_id) else {
            break;
        };
        // 命令消息（`/xxx`）在**轮次边界**解析（对齐 `resolvePendingCommand` 在
        // `messageConsumer` 里的位置）：内置命令就地执行、该消息不进 LLM 上下文；
        // Skill 命令记下待注入信息，用户消息照常进上下文。
        //
        // 放在消费之前、且不放进 `flush_queued_messages`，保证命令不会在
        // 「多步工具调用进行到一半」时被注入。
        match resolve_pending_command(&core, &session_id, &state) {
            CommandResolution::Handled => {
                core.emit_runtime();
                continue;
            }
            CommandResolution::Skill => {}
            CommandResolution::None => {}
        }
        // specs/023 FR-008：`@` 工作区命令与 `/` 命令同口径在轮次边界解析；
        // reminder 在 `run_turn` 里紧跟用户消息落盘。
        resolve_pending_mention(&state);
        // 取消（`abortRequested`）：清空队列并退出消费循环。
        {
            let mut guard = state.lock().unwrap();
            if guard.cancel.load(Ordering::Relaxed) {
                guard.pending_user_message = None;
                guard.pending_reminder = None;
                guard.pending_mention_reminder = None;
                // reminder 已被丢弃：标记一并清掉，否则会顺延抑制下一轮的兜底提醒。
                guard.reminder_driven_run = false;
                guard.agent_messages.clear();
                guard.running = false;
                drop(guard);
                // 中止同时取消排队中的手动压缩：避免中止后补跑压缩
                compact::unmark_pending_compact(&session_id);
                core.emit_runtime();
                break;
            }
        }
        // 取一批排队消息：优先级与 `flush_queued_messages` 共用同一实现
        // （消费循环与 `flushQueuedMessagesIntoContext` 都走 `consumeQueuedOnce`）。
        // 轮次边界消费命令消息（`include_command_user_message = true`）。
        let step = match take_queued_batch(&state, true) {
            Some(batch) => Some(batch),
            None => {
                // 用户排队的压缩：本轮结束、队列排空时立即执行，不再等下一轮用户消息。
                // `running` 保持 true——轮次末尾到压缩开始之间的间隙仍属同一段连续任务，
                // 压缩完成后才允许进入 idle。
                if compact::is_pending_compact(&session_id) {
                    compact::unmark_pending_compact(&session_id);
                    match core.project_of(&session_id) {
                        Ok(project) => {
                            let applied = compact::compact_and_apply_messages(
                                &core,
                                &session_id,
                                &project,
                                &state,
                                false,
                                None,
                            );
                            if !applied {
                                // 无可摘要内容：压缩提前返回、不会推送 compacting 快照
                                core.emit_runtime();
                            }
                        }
                        Err(_) => {
                            // 项目解析失败：标记已清除，补一次快照让 UI 还原
                            core.emit_runtime();
                        }
                    }
                    // 压缩期间可能有新消息入队：回到循环顶部重新取
                    continue;
                }
                let mut guard = state.lock().unwrap();
                // 本轮由 reminder 拉起：收尾不再补兜底提醒，避免「提醒 → 查询 → 提醒」接力
                // （标记取走即清除，只对刚结束的这一轮有意义）。
                let reminder_driven = std::mem::take(&mut guard.reminder_driven_run);
                let reminder = if reminder_driven {
                    None
                } else {
                    background_reminder(&session_id, &mut guard)
                };
                if reminder.is_some() {
                    // 兜底提醒拉起的这一轮同样算「由 reminder 拉起」：收尾不再补兜底。
                    guard.reminder_driven_run = true;
                }
                match reminder {
                    // 队列即将排空、但本会话仍有满足门槛的后台任务：补一条 reminder 再跑一轮
                    // （对齐 `finalizeIdle` → `maybeRemindBackgroundTasks`）。
                    Some(content) => Some(QueuedBatch::Reminder {
                        content,
                        user_message: None,
                    }),
                    None => {
                        // 队列排空：会话转空闲。后台任务的周期性提醒由进程级调度线程
                        // （`tick_background_reminders`）在空闲满一个间隔后另行投递。
                        guard.running = false;
                        None
                    }
                }
            }
        };
        let Some(step) = step else {
            break;
        };

        // 出队时解析出的 Skill 注入（若有）：随本轮一起消费，注入发生在
        // 用户消息进上下文之后、query 之前（见 `run_turn` 的 1.5 步）。
        let skill_injection = state.lock().unwrap().pending_skill_injection.take();
        // specs/023 FR-008：`@` 命令的 reminder 与 Skill 注入同一位置消费。
        let mention_reminder = state.lock().unwrap().pending_mention_reminder.take();

        let result = match step {
            QueuedBatch::Reminder {
                content,
                user_message,
            } => {
                // Reminder 与普通用户消息一样落盘：
                // 它是一条 `silent` / `origin=agent` 的 user 消息，UI 不展示，但会写进
                // `<sid>.jsonl`、计入 `meta.json` 的 `messageCount`，并刷新对话列表。
                persist_reminder(&core, &session_id, &state, &content);
                run_turn(
                    &core,
                    &session_id,
                    &state,
                    user_message.as_ref(),
                    skill_injection,
                    mention_reminder,
                )
            }
            QueuedBatch::Message(message) => run_turn(
                &core,
                &session_id,
                &state,
                Some(&message),
                skill_injection,
                mention_reminder,
            ),
            QueuedBatch::AutoMessages {
                messages,
                user_message,
            } => {
                for item in &messages {
                    persist_auto_message(&core, &session_id, &state, item);
                }
                run_turn(
                    &core,
                    &session_id,
                    &state,
                    user_message.as_ref(),
                    skill_injection,
                    mention_reminder,
                )
            }
        };

        if let Err(error) = result {
            // 一次性通知：记 meta + 时间线末位显示，下一轮新节点追加前被移除
            emit_once_notice(&core, &session_id, &llm_error_message(&error));
        }
        core.emit_runtime();
    }
    // 消费循环退出（队列排空 / 中止 / 会话被关闭）时发一次 queryEnd。
    // `running` 已在退出判定里置 false，再发 queryEnd。
    // MCP：查询结束后把会话级启用选择补写进 `meta.json`——设置时它可能还不存在
    // （新会话的第一条消息尚未落盘），此刻一定有了。对齐 `flushSessionMcpToMeta`。
    crate::mcp_config::flush_session_mcp_to_meta(&session_id);
    if emit_ui {
        // 顺序：先把会话标回空闲并广播状态，再发 queryEnd
        // （`sessionRuntime` 的推送在 `queryEnd` 之前）。
        // 反过来的话 UI 会先收到 queryEnd、后收到「空闲」，托盘/流水灯的收尾晚一拍。
        core.emit_runtime();
        core.emit(json!({ "type": "queryEnd", "sessionId": session_id }));
    }
}

/// 已批准、等待并行执行的工具
struct PendingTool {
    tool_use_id: String,
    tool_name: String,
    input: Value,
}

/// 补一条取消结果（对齐 `RunTools.cancelApprovedItems` / `cancelRemainingTools`）：
/// UI 卡片是 error 态、tool_result 带 `is_canceled: true`。
fn emit_cancel_result(
    core: &Arc<Core>,
    session_id: &str,
    tool_use_id: &str,
    tool_name: &str,
    message: &str,
    results: &mut Vec<Value>,
) {
    core.emit(json!({
        "type": "toolResult",
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "toolName": tool_name,
        "output": message,
        "status": "error",
    }));
    results.push(json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": message,
        "exit_code": -1,
        "is_canceled": true,
    }));
}

/// 丢弃尚未执行的批并补取消结果（权限拒绝路径）。
fn cancel_pending_batch(
    core: &Arc<Core>,
    session_id: &str,
    pending: &mut Vec<PendingTool>,
    results: &mut Vec<Value>,
) {
    for item in std::mem::take(pending) {
        emit_cancel_result(
            core,
            session_id,
            &item.tool_use_id,
            &item.tool_name,
            "Tool was canceled because a later tool in the batch was denied",
            results,
        );
    }
}

/// 并行执行一批已批准的并发安全工具。
///
/// 顺序契约：批内所有工具的 `toolCall` 已在授权阶段发完，这里先**并发执行**，
/// 再**按原顺序**逐条上报 `toolResult`——因此 tool_result 的顺序与内容与串行实现
/// 完全一致，差别只在耗时与 `toolCall` 的时序（整批发完才开始执行）。
fn flush_pending_batch(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    pending: &mut Vec<PendingTool>,
    results: &mut Vec<Value>,
    new_messages: &mut Vec<Value>,
    terminate_after_batch: &mut bool,
) {
    if pending.is_empty() {
        return;
    }
    let batch = std::mem::take(pending);

    // 执行前会话已被中止：整批补取消结果（对齐 `executeParallelBatch` 的
    // `signal?.aborted` 分支），不再执行任何工具。
    if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
        for item in &batch {
            emit_cancel_result(
                core,
                session_id,
                &item.tool_use_id,
                &item.tool_name,
                "Command was aborted before execution",
                results,
            );
        }
        *terminate_after_batch = true;
        return;
    }

    // 并发执行：每个工具一个线程（`tools::execute` 是阻塞调用）
    let handles: Vec<std::thread::JoinHandle<ToolOutcome>> = batch
        .iter()
        .map(|item| {
            let core = Arc::clone(core);
            let session_id = session_id.to_string();
            let project = project.to_string();
            let state = Arc::clone(state);
            let tool_use_id = item.tool_use_id.clone();
            let tool_name = item.tool_name.clone();
            let input = item.input.clone();
            std::thread::spawn(move || {
                execute_tool(
                    &core,
                    &session_id,
                    &project,
                    &state,
                    &tool_use_id,
                    &tool_name,
                    &input,
                )
            })
        })
        .collect();

    for (position, handle) in handles.into_iter().enumerate() {
        let item = &batch[position];
        match handle.join() {
            Ok(outcome) => {
                // `newMessages`（当前只有 Skill 的技能正文）按批内原顺序收集，
                // 由调用方在 tool_result 消息之后逐条注入（对齐 RunTools 的 yield 顺序）
                new_messages.extend(outcome.new_messages());
                results.push(emit_tool_outcome(
                    core,
                    session_id,
                    project,
                    &item.tool_use_id,
                    &item.tool_name,
                    &outcome,
                ))
            }
            // 线程 panic：同样按失败分支收尾
            Err(_) => {
                let message = format!("Error executing {}: tool thread panicked", item.tool_name);
                core.emit(json!({
                    "type": "toolResult",
                    "sessionId": session_id,
                    "toolUseId": item.tool_use_id,
                    "toolName": item.tool_name,
                    "output": message,
                    "status": "error",
                }));
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": item.tool_use_id,
                    "content": message,
                    "exit_code": -1,
                    "is_canceled": false,
                }));
            }
        }
    }
    // 整批执行完成后会话才被中止：本批收尾后不再回到 LLM，由调用方的
    // `terminate_after_batch` 分支上报 `*User Interrupted*`。
    // 中止若在整批开始**之前**到达，已由上面的取消分支处理，不会走到这里。
    if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
        *terminate_after_batch = true;
    }
}

/// 执行一个已批准的工具。
///
/// 与调用方解耦成独立函数是为了让「并行工具批」能把多个工具丢进各自的线程：
/// 这里只碰 `core` / `state`（都是 `Arc`）与入参，不持有外层循环的可变状态。
fn execute_tool(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    tool_use_id: &str,
    tool_name: &str,
    effective_input: &Value,
) -> ToolOutcome {
    // specs/020 FR-002：非 Master 角色的执行侧防线——LLM 工具清单虽已按角色白名单
    // 过滤，模型仍可能幻觉调用清单外工具（含 `mcp__*`）：这里直接拒绝并点名可用工具，
    // 不执行、不静默降级、不中止会话。所有工具执行路径（串行 / 并行批 / Skill 注入）
    // 都经过本入口；压缩不走工具执行，不受影响。Master 与普通会话白名单为 None，直通。
    let role_allow = {
        let state = state.lock().unwrap();
        state
            .sub_agent_role
            .clone()
            .and_then(|role| crate::tools::sub_agent_role_tools(&role).map(|allow| (role, allow)))
    };
    if let Some((role, allow)) = role_allow {
        if !allow.contains(&tool_name) {
            return ToolOutcome::Error(format!(
                "{role} 子代理只有 {} 工具，{tool_name} 不可用",
                allow.join(" / ")
            ));
        }
    }
    // AskUserQuestion 的问答回调：把已组装的 `UserChoiceOptions` 经
    // `CoreRequest.userChoice` 发给宿主并阻塞等待应答。
    let user_choice_session = session_id.to_string();
    let user_choice_core = Arc::clone(core);
    let user_choice: tools::UserChoiceFn = Arc::new(move |options: &Value| {
        user_choice_core.waiting_request(UserBlockingRequest::user_choice(
            &user_choice_session,
            options.clone(),
        ))
    });
    // 取共享句柄必须在字面量之外：字段表达式产生的临时 guard 存活到整条
    // let 语句结束，两个字段各写一次 state.lock() 会让第二个与第一个尚未
    // 释放的 guard 互斥，自死锁。
    let (cancel, pause_loop) = {
        let state = state.lock().unwrap();
        (state.cancel.clone(), state.pause_loop.clone())
    };
    let context = ToolContext {
        session_id: session_id.to_string(),
        cwd: project.to_string(),
        // 手工转后台按 tool_use_id 登记（Bash 卡片「转后台」按钮）
        tool_use_id: Some(tool_use_id.to_string()),
        // 工具流式进度 → `toolProgress` 帧
        on_progress: Some(tool_progress_emitter(
            Arc::clone(core),
            session_id.to_string(),
            tool_use_id.to_string(),
        )),
        // 会话取消标记：Bash 等待子进程时轮询它，命中即杀子进程
        cancel: Some(cancel),
        // 手工转后台的循环暂停信号：前台 Bash 转后台成功后置位
        pause: Some(pause_loop),
        user_choice: Some(user_choice),
        // 后台 Bash 任务钩子：完成通知注入 + `background` 事实同步
        background: Some(core.background_hooks()),
        // 子代理工具钩子（Agent 建会话 / Reply 投递）
        subagent: Some(core.subagent_hooks()),
    };
    // MCP 工具（`mcp__<server>__<tool>`）不在内置工具表里：必须先分流，
    // 否则会落到 `tools::execute` 的兜底分支被报成「工具不存在」。
    if crate::mcp::is_mcp_tool(tool_name) {
        return crate::mcp::execute_tool(tool_name, effective_input);
    }
    tools::execute(tool_name, effective_input, &context)
}

/// 工具清单：内置工具 + 该会话启用列表里的 MCP 工具。
///
/// MCP 工具的启用列表按会话解析
/// （会话覆盖 → 全局默认），因此同一个 Core 进程里不同会话看到不同的 MCP 工具。
pub fn all_tool_definitions(session_id: &str) -> Vec<Value> {
    let mut definitions = tools::definitions();
    definitions.extend(crate::mcp::tools_for_session(session_id));
    definitions
}

/// 是否是「已注册的工具」：内置工具或 MCP 工具。
///
/// 用于区分「工具不存在」与「工具执行失败」两条错误通道——MCP 工具由服务器
/// 动态提供，不在内置工具表里，但**是**已注册的工具。
pub fn is_known_tool(name: &str) -> bool {
    tools::is_known(name) || crate::mcp::is_mcp_tool(name)
}

/// 工具能否与相邻同类工具并行执行：MCP 工具按服务器给的 `readOnlyHint` 注解判定
/// 。
pub fn is_tool_concurrency_safe(name: &str, input: &Value) -> bool {
    if crate::mcp::is_mcp_tool(name) {
        return crate::mcp::is_concurrency_safe(name);
    }
    tools::is_concurrency_safe(name, input)
}

/// 上报工具结果（`toolResult` 帧）并产出 tool_result block。
///
/// 串行与并行两条路径共用：并行批必须**按原顺序**逐条上报。
fn emit_tool_outcome(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    tool_use_id: &str,
    tool_name: &str,
    outcome: &ToolOutcome,
) -> Value {
    let status = if outcome.is_status_error() {
        "error"
    } else {
        "success"
    };
    // 结构化 block（Read 的图片）：content 原样透传，不走文本裁剪
    // 。
    //
    // UI 的 `toolResult.output` 是 `string`：数组 content 一律
    // 上报 `'[Image]'`（图片本体只进 tool_result block，不进 UI 事件）。
    let (output, block_content) = match outcome {
        ToolOutcome::SuccessBlocks(blocks) => (json!("[Image]"), blocks.clone()),
        _ => {
            // UI 的 `toolResult.output` 用裸消息；只有 **工具执行本身失败**
            // （`call()` 抛错）的 tool_result 内容才加 `Error executing <Tool>: `
            // 前缀。
            // 工具不存在（`is_known` 为假）与权限拒绝都不加。
            let raw = outcome.text();
            let tool_result_text = if matches!(outcome, ToolOutcome::Error(_))
                && is_known_tool(tool_name)
            {
                format!("Error executing {tool_name}: {raw}")
            } else {
                raw.to_string()
            };
            (
                json!(tools::cap_tool_result(raw, session_id, project, tool_name)),
                json!(tools::cap_tool_result(
                    &tool_result_text,
                    session_id,
                    project,
                    tool_name
                )),
            )
        }
    };
    core.emit(json!({
        "type": "toolResult",
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "toolName": tool_name,
        "output": output,
        "status": status,
    }));
    // tool_result block 口径：始终带 exit_code / is_canceled；
    // 工具执行失败（含权限拒绝）**不**写 is_error（只有模型错误兜底才写）。
    // is_canceled 仅「排队等待期间被中止」为真。
    let mut block = json!({
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": block_content,
        "exit_code": outcome.exit_code(),
        "is_canceled": matches!(outcome, ToolOutcome::Canceled(_)),
    });
    // `mapToolResultToToolResultBlockParam` 的多余键原样拷进 block
    // （Edit 的 startLine / endLine / beforeContent、Write 的 beforeContent）。
    // 它们只服务 UI 的 diff 与回滚，请求载荷里会被 NON_LLM_BLOCK_FIELDS 剔除。
    if let Some(extra) = outcome.extra() {
        if let Some(object) = block.as_object_mut() {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    block
}

// ==================== 命令解析与 Skill 注入 ====================

/// `resolvePendingCommand` 的三种结果
enum CommandResolution {
    /// 内置命令已就地执行：该消息不进 LLM 上下文
    Handled,
    /// 命中 Skill：用户消息照常进上下文，随后注入 Skill tool_use
    Skill,
    /// 普通消息 / 未匹配的 `/` 文本
    None,
}

/// 待处理的用户消息是否是 `/` 命令（对齐 `isPendingUserCommand`）
fn is_pending_user_command(state: &Arc<Mutex<SessionState>>) -> bool {
    state
        .lock()
        .unwrap()
        .pending_user_message
        .as_ref()
        .map(|message| util::js_trim(&message_text(message)).starts_with('/'))
        .unwrap_or(false)
}

/// 解析 `@` 工作区命令的身份（specs/023 FR-008）。
///
/// 语法：去首尾空白后以 `@` 开头。身份两种形态——
/// - 引号形态 `@"..."`：到下一个 `"` 止（支持含空格的路径）；
/// - 非引号形态：到第一个空白（空格 / 制表 / 换行）止。
///
/// 身份之后的内容（可多行）是任务正文。
fn parse_mention_identity(text: &str) -> Option<String> {
    let trimmed = util::js_trim(text);
    let rest = trimmed.strip_prefix('@')?;
    let identity = if let Some(inner) = rest.strip_prefix('"') {
        let end = inner.find('"')?;
        &inner[..end]
    } else {
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        &rest[..end]
    };
    if identity.is_empty() {
        None
    } else {
        Some(identity.to_string())
    }
}

/// `@` 命令的 reminder 文案（specs/023 FR-008）：点名目标身份与 `Agent.target`。
fn build_mention_reminder(identity: &str) -> String {
    format!(
        "<Reminder>\n\
         The user addressed workspace \"{identity}\" with @. Delegate this task to that workspace: \
         call the Agent tool with target=\"{identity}\", prompt set to the user's task text, and an \
         agentRole that fits the task. Do not execute the task in the current workspace.\n\
         </Reminder>"
    )
}

/// 轮次边界：待处理用户消息是 `@` 命令时，把 reminder 文案挂到会话状态上
/// （`run_turn` 在用户消息之后落一条 silent reminder）。
///
/// 只在宿主声明支持跨工作区代理时生效（FR-009）；身份是否存在不在这里校验——
/// 不存在时由 `Agent.target` 执行时报错（FR-008）。
fn resolve_pending_mention(state: &Arc<Mutex<SessionState>>) {
    if !crate::config::cross_workspace_agent() {
        return;
    }
    let mut guard = state.lock().unwrap();
    if guard.pending_mention_reminder.is_some() {
        return;
    }
    let Some(message) = guard.pending_user_message.as_ref() else {
        return;
    };
    let Some(identity) = parse_mention_identity(&message_text(message)) else {
        return;
    };
    guard.pending_mention_reminder = Some(build_mention_reminder(&identity));
}

/// 解析队首的命令消息（`"/<skill|command> args"`）。
///
/// 命令在**出队时**才解析，而不是消息一发出就生效：这样即使当前正在跑一轮多步
/// 工具调用，Skill 也不会被中途注入、内置命令也不会被中途执行。
fn resolve_pending_command(
    core: &Arc<Core>,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
) -> CommandResolution {
    if !is_pending_user_command(state) {
        return CommandResolution::None;
    }

    let text = {
        let state = state.lock().unwrap();
        state
            .pending_user_message
            .as_ref()
            .map(message_text)
            .unwrap_or_default()
    };

    let Ok(cwd) = core.project_of(session_id) else {
        return CommandResolution::None;
    };

    let emitter = Arc::clone(core);
    let spin_core = Arc::clone(core);
    let spin_session = session_id.to_string();
    let spin_cwd = cwd.clone();
    let context = crate::commands::CommandContext {
        session_id: session_id.to_string(),
        cwd,
        command_name: None,
        emit: Arc::new(move |event| emitter.emit(event)),
        start_spin: Some(Arc::new(move |args: &str| {
            crate::spin_host::run_spin_command(&spin_core, &spin_session, &spin_cwd, args)
        })),
    };

    match crate::commands::dispatch(&text, &context) {
        crate::commands::DispatchOutcome::Handled => {
            // 丢弃该消息（命令已就地执行）
            let mut state = state.lock().unwrap();
            state.pending_user_message = None;
            state.pending_skill_injection = None;
            CommandResolution::Handled
        }
        crate::commands::DispatchOutcome::Skill {
            skill_name,
            skill_args,
        } => {
            state.lock().unwrap().pending_skill_injection = Some(SkillInjection {
                skill_name,
                skill_args,
            });
            CommandResolution::Skill
        }
        crate::commands::DispatchOutcome::Passthrough => CommandResolution::None,
    }
}

/// 注入 Skill tool_use（assistant tool_use + tool_result 携带技能正文）。
///
/// 不走 LLM，
/// 直接构造一条 assistant 消息（单个 tool_use block）并执行 `Skill` 工具，
/// 把 tool_result 与工具注入的 `newMessages` 落盘 + 进上下文。
///
/// 事件序列：
/// `toolCall`（授权前）→ `toolPermissionRequested`（UI 借此上架 Skill 卡片并拿
/// `displayArgs`）→ `toolCall`（执行前）→ `toolResult`；每条落盘消息各发一次
/// `conversationListChanged`（对齐 `Conversation.appendMessage`）。
fn inject_skill_tool_use(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    injection: &SkillInjection,
) -> Result<(), String> {
    // 已请求中止时不再注入（对齐 `submitToolUse` 的 `isAborted()` 早退）
    if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    let tool_use_id = util::unique_id("tooluse");
    // 对齐 `submitToolUse({ input: { skill, args: skillArgs || undefined } })`
    let mut input = json!({ "skill": injection.skill_name });
    if !injection.skill_args.is_empty() {
        input["args"] = json!(injection.skill_args);
    }

    let assistant_message = json!({
        "type": "assistant",
        "message": {
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": tool_use_id,
                "name": "Skill",
                "input": input,
            }],
        },
        "uuid": format!("assistant_{}", util::now_millis()),
        "timestamp": util::now_millis(),
    });
    persist_message(core, session_id, project, state, &assistant_message)?;
    // 每条落盘消息各发一次 `conversationListChanged` 并计入 `meta.json.messageCount`
    // （Skill 注入一次落 3 条消息）。
    announce_message_appended(core, session_id, project, false);

    // 授权前先发一次 `toolCall`（UI 上架 running
    // 卡片），再发一次 `toolPermissionRequested`——UI 的 ToolHandler 借此上架 Skill
    // 卡片并拿到 `displayArgs`。缺了这一步，Standalone 下 `/<skill>` 在 UI 上没有任何
    // 可见的触发痕迹（`toolResult` / `toolArgsUpdated` 只能更新**已存在**的卡片）。
    core.emit(json!({
        "type": "toolCall",
        "sessionId": session_id,
        "toolUseId": tool_use_id,
        "toolName": "Skill",
    }));
    // Skill 的 checkPermissions 恒 allow（见 `permission::base_check`），不会弹确认框；
    // 这里的往返只为让 UI 上架卡片，与授权路径同序。
    let agent_mode = state.lock().unwrap().agent_mode.clone();
    match core.resolve_permission(session_id, &tool_use_id, "Skill", &input, &agent_mode, project) {
        PermissionOutcome::Allowed { .. } => {
            // 对齐 `executeSingleItem`：执行前再发一次 `toolCall`（卡片转「执行中」）
            core.emit(json!({
                "type": "toolCall",
                "sessionId": session_id,
                "toolUseId": tool_use_id,
                "toolName": "Skill",
            }));
        }
        PermissionOutcome::Denied { message, .. } => {
            // 拒绝分支：卡片置 error，补一条 error tool_result，不执行工具
            core.emit(json!({
                "type": "toolResult",
                "sessionId": session_id,
                "toolUseId": tool_use_id,
                "toolName": "Skill",
                "output": message,
                "status": "error",
            }));
            let result_message = json!({
                "type": "user",
                "message": { "role": "user", "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": message,
                    "exit_code": -1,
                    "is_canceled": false,
                }] },
                "uuid": util::unique_id("tool_result"),
                "timestamp": util::now_millis(),
            });
            persist_message(core, session_id, project, state, &result_message)?;
            emit_highlight_languages(core, &result_message);
            announce_message_appended(core, session_id, project, false);
            return Ok(());
        }
    }

    let outcome = execute_tool(
        core,
        session_id,
        project,
        state,
        &tool_use_id,
        "Skill",
        &input,
    );
    let new_messages = outcome.new_messages();
    let block = emit_tool_outcome(core, session_id, project, &tool_use_id, "Skill", &outcome);

    let result_message = json!({
        "type": "user",
        "message": { "role": "user", "content": [block] },
        "uuid": util::unique_id("tool_result"),
        "timestamp": util::now_millis(),
    });
    persist_message(core, session_id, project, state, &result_message)?;
    emit_highlight_languages(core, &result_message);
    announce_message_appended(core, session_id, project, false);

    for message in new_messages {
        persist_message(core, session_id, project, state, &message)?;
        emit_highlight_languages(core, &message);
        // 技能正文（`isMeta` 的 user 消息）同样计入 messageCount 并刷新列表
        announce_message_appended(core, session_id, project, false);
    }
    Ok(())
}

fn run_turn(
    core: &Arc<Core>,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    user_message: Option<&Value>,
    skill_injection: Option<SkillInjection>,
    mention_reminder: Option<String>,
) -> Result<(), String> {
    let project = core.project_of(session_id)?;
    let (agent_mode, model, provider) = {
        let state = state.lock().unwrap();
        (
            state.agent_mode.clone(),
            state.model.clone(),
            state.provider.clone(),
        )
    };
    let mut provider_config = config::resolve_provider(provider.as_deref(), model.as_deref())?;
    // 会话级覆盖（消息随带 / 配置事件）优先于全局 settings
    {
        let state = state.lock().unwrap();
        if let Some(effort) = &state.thinking_effort {
            provider_config.thinking_effort = effort.clone();
        }
        if let Some(enabled) = state.web_search {
            provider_config.web_search = enabled;
        }
    }

    // 1. 用户消息落盘 + 通知 UI（Reminder 轮次没有用户消息，只跑查询）
    if let Some(user_message) = user_message {
        persist_user_message(core, session_id, &project, state, user_message, true)?;
    }

    // 1.5 Skill 注入：`/skill` 命令的用户消息已进上下文，紧接着注入 Skill tool_use
    // （assistant tool_use + tool_result 携带技能正文），供本轮 LLM 读取。
    // 位置：队列消费之后、query 之前。
    if let Some(injection) = skill_injection {
        if let Err(error) = inject_skill_tool_use(core, session_id, &project, state, &injection) {
            // 注入失败不中断流程，继续走 LLM query
            eprintln!("[core] Skill tool call error: {error}");
        }
    }

    // 1.6 `@` 工作区 reminder（specs/023 FR-008）：用户消息之后紧跟一条 silent 消息，
    // 点名目标身份与 `Agent.target`，让模型把事项代理给目标工作区。
    if let Some(reminder) = mention_reminder {
        persist_reminder(core, session_id, state, &reminder);
    }

    // 2. 轮次循环（`aiBegin` / `aiEnd` 每轮各一次，见 run_query_loop）。
    // `queryBegin` / `queryEnd` 归消费循环（`run_consumer`）所有：一轮用户消息里
    // 可能包含多个 LLM 轮次（含 reminder 追问），它们同属一次 consumer，只发一对。
    let messages_before_query = state.lock().unwrap().messages.len();
    let result = run_query_loop(
        core,
        session_id,
        &project,
        state,
        &provider_config,
        &agent_mode,
    );
    // 对齐 `QueryEngine.runQuery` 收尾：本轮最后一条 assistant 回复「像话没说完」时，
    // 记一条 pendingReminder，下一轮消费循环把它作为 silent 用户消息注入。
    if result.is_ok() {
        update_pending_reminder(state, messages_before_query);
    }
    // `conversationListChanged` 已由每次落盘（`announce_message_appended`）发出，
    // 这里不再补发（收尾不发该事件）。
    result
}

/// Reminder 消息（对齐 `QueryEngine.flushReminder` 的 `reminderMsg`）：
/// `silent` / `origin=agent`，只进内存上下文、不落盘、不通知 UI。
fn build_reminder_message(content: &str) -> Value {
    json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "uuid": format!("reminder_{}", util::now_millis()),
        "timestamp": util::now_millis(),
        "silent": true,
        "origin": "agent",
    })
}

/// 自动消息（后台 Bash 完成通知 / 子代理 Reply）对应的 user 消息
/// （对齐 `QueryEngine.buildAgentReplyMessage`）。
///
/// 与 reminder 不同：它会**展示**在 UI 上，也会落盘进 `<sid>.jsonl`，
/// 因此不带 `silent` 标记。
fn build_auto_message(item: &AgentMessage) -> Value {
    let mut message = json!({
        "type": "user",
        "message": { "role": "user", "content": item.content },
        "uuid": util::unique_id("agent_reply"),
        "timestamp": util::now_millis(),
    });
    if let Some(object) = message.as_object_mut() {
        object.insert("origin".to_string(), json!(item.origin));
        if item.origin != "bash" {
            // 子代理回复额外带 agentId 与 From 头（UI 显示 host:agent:<id>）
            object.insert("agentId".to_string(), json!(item.from_session_id));
            // specs/023：跨工作区子代理的 From 头用目标工作区身份（本进程不知道那台机器），
            // 并带上 `workspaceId` 供 UI 跨工作区跳转。
            let remote_workspace = crate::subagent::remote_workspace_of(&item.from_session_id);
            let source = match &remote_workspace {
                Some(workspace) => format!("{workspace}:agent:{}", item.from_session_id),
                None => agent_source_info(&item.from_session_id),
            };
            let mut meta = json!({ "param": source, "type": "from" });
            if let Some(workspace) = remote_workspace {
                meta["workspaceId"] = json!(workspace);
            }
            object.insert("_meta".to_string(), meta);
        }
    }
    message
}

/// 子代理回复的来源位置（对齐 `QueryEngine.getAgentSourceInfo`）：
/// `hostname:agent:<agentId>`；拿不到主机名时退化为 `#<agentId>`。
fn agent_source_info(agent_id: &str) -> String {
    let hostname = std::env::var("COMPUTERNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|value| !value.is_empty()));
    match hostname {
        Some(hostname) => format!("{hostname}:agent:{agent_id}"),
        None => format!("#{agent_id}"),
    }
}

/// 消费循环即将空转时的兜底提醒（对齐 `QueryEngine.maybeRemindBackgroundTasks`）：
/// 本会话仍有满足门槛的运行中后台任务
/// （`bash_task::qualifies_fallback_reminder`：距上次访问满 3 分钟，或命令含 sleep
/// 且本任务还没兜底过）→ 生成一条 reminder 让 LLM 二选一（不再需要的执行 kill 命令 /
/// 都还需要就直接结束本轮等通知，不要 sleep 轮询）。
/// 不满门槛的任务不进列表（刚起 / 刚被周期提醒报告过）；全部不满足时本次不投递
/// （任务留着，后续查询结束再按当时距上次访问的时长判定）。
///
/// 消费循环收尾本身也是一次「访问」：无论本次是否兜底，都把本会话运行中任务的
/// `last_accessed_ms` 刷成当前时刻（`ReminderEntry.last_accessed_ms`）；本次投递的任务
/// 同时登记 `fallback_reminded`，sleep 豁免不再重复命中。
///
/// 另外，由 reminder 拉起的那一轮消费（`SessionState.reminder_driven_run`）直接跳过本
/// 函数：提醒不再接力。
///
/// 与周期提醒（`deliver_background_reminder` / `tick_background_reminders`）的分工：
/// 本条是查询刚结束时的一次性兜底；周期提醒在空闲满 5min 后按 5 / 10 / 20 / 30min
/// 档位持续汇报进度。
fn background_reminder(session_id: &str, state: &mut SessionState) -> Option<String> {
    let now_ms = util::now_millis();
    let running = bash_task::running_tasks_for_session(session_id);
    let mut tasks: Vec<bash_task::RunningTask> = Vec::new();
    for task in &running {
        let entry = state
            .reminder_entries
            .entry(task.task_id.clone())
            .or_insert_with(|| ReminderEntry {
                clock: bash_task::ReminderClock::default(),
                last_tick_ms: now_ms,
                last_accessed_ms: task.start_time,
                fallback_reminded: false,
            });
        if bash_task::qualifies_fallback_reminder(
            entry.last_accessed_ms,
            &task.command,
            entry.fallback_reminded,
            now_ms,
        ) {
            tasks.push(task.clone());
        }
    }
    // 查询结束即一次「访问」：先刷新再入队，提醒触发的查询结束后不会被再次兜底。
    for task in &running {
        if let Some(entry) = state.reminder_entries.get_mut(&task.task_id) {
            entry.last_accessed_ms = now_ms;
        }
    }
    // 本次投递的任务登记「已兜底」：sleep 豁免每个任务只走一次。
    for task in &tasks {
        if let Some(entry) = state.reminder_entries.get_mut(&task.task_id) {
            entry.fallback_reminded = true;
        }
    }
    if tasks.is_empty() {
        return None;
    }

    // 直接按当前 OS 生成可执行的 kill 命令，省得 LLM 自己判断平台
    // （Windows 用 taskkill /T 连子进程树一起杀）。
    let lines = tasks
        .iter()
        .map(|task| {
            let command_part = if !task.command.is_empty() && task.command != task.description {
                format!(" — `{}`", task.command)
            } else {
                String::new()
            };
            let kill_part = if cfg!(windows) {
                format!("\n  kill: taskkill /T /F /PID {}", task.pid)
            } else {
                format!("\n  kill: kill {}", task.pid)
            };
            format!(
                "- {} (pid {}): {}{}{}",
                task.task_id, task.pid, task.description, command_part, kill_part
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    Some(
        [
            "<reminder>".to_string(),
            format!(
                "You still have {} background bash command(s) running:",
                tasks.len()
            ),
            lines,
            String::new(),
            "Review them once and act accordingly:".to_string(),
            "- If any of them is no longer needed, run the \"kill:\" command shown next to it (already adapted to this OS).".to_string(),
            "- If all of them are still needed, do NOT sleep, poll, or repeatedly check their output. Simply finish this turn and wait — you will be notified automatically when a background command completes.".to_string(),
            "</reminder>".to_string(),
        ]
        .join("\n"),
    )
}

/// 本轮结束后计算 `pendingReminder`（对齐 `QueryEngine.runQuery` 的收尾判定）。
///
/// - 最后一条 assistant 没有 tool_use 且 `stop_reason` 非空且不是 `end_turn` →
///   「回复未完成」提醒；
/// - 最后一条 assistant 没有 tool_use 且 `stop_reason === 'end_turn'`，正文以冒号
///   （半角 `:` / 全角 `：`）结尾 → 「像是要调用工具却没调用」提醒。
///
/// 用户中断时不注入（abort 后直接 break，收尾判定不执行）。
fn update_pending_reminder(state: &Arc<Mutex<SessionState>>, messages_before_query: usize) {
    let mut state = state.lock().unwrap();
    if state.cancel.load(Ordering::Relaxed) {
        return;
    }
    let start = messages_before_query.min(state.messages.len());
    let assistant = state.messages[start..]
        .iter()
        .rev()
        .find(|message| message.get("type").and_then(Value::as_str) == Some("assistant"))
        .cloned();
    let Some(assistant) = assistant else {
        return;
    };
    let content = assistant
        .get("message")
        .and_then(|inner| inner.get("content"))
        .and_then(Value::as_array);
    let has_tool_use = content
        .map(|blocks| {
            blocks
                .iter()
                .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"))
        })
        .unwrap_or(false);
    if has_tool_use {
        return;
    }
    let stop_reason = assistant
        .get("message")
        .and_then(|inner| inner.get("stop_reason"))
        .and_then(Value::as_str);
    match stop_reason {
        Some(reason) if !reason.is_empty() && reason != "end_turn" => {
            state.pending_reminder = Some(format!(
                "<reminder>Your previous response stopped (stop_reason: {reason}), and did not \
                 complete fully. Please continue from where you left off, including any incomplete \
                 tool calls or text.</reminder>"
            ));
        }
        Some("end_turn") => {
            let last_text = content
                .and_then(|blocks| {
                    blocks
                        .iter()
                        .rev()
                        .find(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                })
                .and_then(|block| block.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("");
            // JS trim 去的是 ECMAScript 空白
            // （含 U+FEFF、不含 U+0085），不能用 Rust `str::trim_end`。
            let trimmed = crate::util::js_trim_end(last_text);
            if trimmed.ends_with(':') || trimmed.ends_with('：') {
                state.pending_reminder = Some(
                    "<reminder>You ended your response with a colon (\":\" or \"：\"), which \
                     suggests you intended to continue with a tool call, but didn't actually invoke \
                     any tool. Please think about what tool you need to call next and make the \
                     appropriate tool call to complete the user's request.</reminder>"
                        .to_string(),
                );
            }
        }
        _ => {}
    }
}

/// 被中断的工具结果文案
const INTERRUPTED_MESSAGE: &str = "Command was interrupted";

/// 用户中断文案
const USER_INTERRUPTED_MESSAGE: &str = "*User Interrupted*";

/// 构造工具流式进度回调：把 `BashProgress` 转成 `toolProgress` 帧
/// 。
fn tool_progress_emitter(
    core: Arc<Core>,
    session_id: String,
    tool_use_id: String,
) -> Arc<dyn Fn(tools::BashProgress) + Send + Sync> {
    Arc::new(move |progress: tools::BashProgress| {
        core.emit(json!({
            "type": "toolProgress",
            "sessionId": session_id,
            "toolUseId": tool_use_id,
            "progress": {
                "type": "bash_progress",
                "output": progress.output,
                "fullOutput": progress.full_output,
                "elapsedTimeSeconds": progress.elapsed_time_seconds,
                "totalLines": progress.total_lines,
                "totalBytes": progress.total_bytes,
                // `taskId` 键不写（序列化时它会被丢掉）
                "timeoutMs": progress.timeout_ms,
            },
        }));
    })
}

/// LLM 调用失败时给用户看的系统消息（模板逐字锁定）
fn llm_error_message(error: &str) -> String {
    // 宿主环境未就绪时的兜底目录名用 `DEFAULT_CONFIG_DIR_NAME`（project.json 的
    // `configDir`，自带前导点）：换成一个不带点的名字，文案里的路径会缺前导点。
    let config_dir = config::host_environment()
        .map(|env| env.config_dir_name)
        .unwrap_or_else(|| config::DEFAULT_CONFIG_DIR_NAME.to_string());
    format!(
        "❌ **LLM API Error**\n\n```\n{error}\n```\n\nPlease check your API configuration in `~/{config_dir}/settings.json`."
    )
}

/// 上报一条一次性通知（`docs/hosts/webview-ui.md` 第 11 节）：先记进 `meta.json`
/// 的 `onceMessage`（一个对话至多一条，后到的覆盖先到的），再发 `message` 事件。
///
/// 通知本体不进 `<sid>.jsonl`、内存消息列表与 LLM 上下文——它只是时间线末位的提示，
/// 重开对话时由 UI 从 meta 追加回末位。meta 写入失败只记日志：提示本身仍要到达 UI，
/// 落盘是「重开还能看到」的尽力而为，不是事件的前置条件。
fn emit_once_notice(core: &Arc<Core>, session_id: &str, content: &str) {
    let message = json!({ "role": "system", "content": content });
    match core.project_of(session_id) {
        Ok(project) => {
            if let Err(error) = history::save_once_message(session_id, &project, &message) {
                eprintln!("[core] save once message failed: {error}");
            }
        }
        Err(error) => eprintln!("[core] save once message skipped: {error}"),
    }
    let mut data = message;
    data["once"] = json!(true);
    core.emit(json!({ "type": "message", "sessionId": session_id, "data": data }));
}

/// 上报 `*User Interrupted*` 一次性通知（`docs/hosts/webview-ui.md` 第 11 节）。
///
/// 只记 meta 与 UI 事件，不落 `<sid>.jsonl`、不进内存消息列表：中断提示是
/// 「本轮收尾」的瞬时事实，用户看到即可；重开 / 刷新会话由 meta 恢复到末位，
/// 历史里不该出现它（不推进 `last_uuid`，不影响下一轮请求的上下文组装）。
fn emit_user_interrupted(core: &Arc<Core>, session_id: &str, state: &Arc<Mutex<SessionState>>) {
    // 静默中止（业务主动结束，如 spin 子代理首次 Reply 后停止自身）：
    // 不向 UI 回显中断消息、不落盘系统消息，直接结束：
    // 回显收敛在本函数，一处检查覆盖全部收尾点。
    if state.lock().unwrap().silent_abort {
        return;
    }
    emit_once_notice(core, session_id, USER_INTERRUPTED_MESSAGE);
}

/// 把内存中尚未落盘的消息按顺序补写。
///
/// 目前只有崩溃恢复补出的合成 `tool_result` 会走这里：`ensure_tool_results` 把它加进
/// 内存但不落盘，下一次持久化时机（用户消息 / 排队消息 / reminder / 下一轮请求前）
/// 按原始顺序补写，且使用消息自带的 `parentUuid`（指向包含对应 tool_use 的 assistant），
/// 避免合成恢复消息落盘后成为自引用节点、在 BFS 建链时把后续消息整条孤立。
fn persist_unpersisted_messages(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
) -> Result<(), String> {
    loop {
        let message = {
            let state = state.lock().unwrap();
            if state.persisted_count >= state.messages.len() {
                None
            } else {
                Some(state.messages[state.persisted_count].clone())
            }
        };
        let Some(message) = message else {
            break;
        };
        // 消息自带 parentUuid 时优先（对齐 `resolvePersistParentUuid`）
        let own_parent = message
            .get("parentUuid")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let parent = {
            let state = state.lock().unwrap();
            own_parent.or_else(|| state.last_uuid.clone())
        };
        let uuid = history::append_message(session_id, project, &message, parent.as_deref())?;
        let mut state = state.lock().unwrap();
        state.last_uuid = Some(uuid);
        state.persisted_count += 1;
        drop(state);
        // 每落盘一条消息各发一次列表变化，
        // 并刷新 `meta.json` 的 `messageCount`（补写的是自动消息，不刷 `updatedAt`）。
        announce_message_appended(core, session_id, project, false);
    }
    Ok(())
}

/// 追加一条消息到内存与磁盘（不发事件、不刷 `meta.json`）。
///
/// 写入前先补写内存里尚未落盘的消息，保证磁盘顺序：恢复消息在前、新消息在后。
fn persist_message(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    message: &Value,
) -> Result<String, String> {
    persist_unpersisted_messages(core, session_id, project, state)?;
    let parent = state.lock().unwrap().last_uuid.clone();
    let uuid = history::append_message(session_id, project, message, parent.as_deref())?;
    {
        let mut state = state.lock().unwrap();
        state.messages.push(message.clone());
        state.last_uuid = Some(uuid.clone());
        state.persisted_count = state.messages.len();
    }
    Ok(uuid)
}

/// 落盘一条消息后的统一收尾：
/// 更新 `meta.json` 的 `messageCount`（`userInitiated` 时同时刷 `updatedAt`），
/// 并广播 `conversationListChanged`——每追加一条消息就发一次，让侧栏
/// 消息数在对话进行中实时更新（不是每轮只发一次）。
fn announce_message_appended(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    user_initiated: bool,
) {
    let (prompt_mode, creator) = {
        match core.session_if_exists(session_id) {
            Some(state) => {
                let state = state.lock().unwrap();
                (state.prompt_mode.clone(), state.creator.clone())
            }
            // 会话状态不存在（尚无引擎）按用户会话兜底：touch 兜底建档只可能命中
            // 用户路径（子代理 meta 由创建方预建，不会走到 ENOENT）
            None => (None, SessionCreator::User),
        }
    };
    if let Err(error) =
        history::touch_metadata(session_id, project, user_initiated, prompt_mode.as_deref(), &creator)
    {
        eprintln!("[core] touch metadata failed: {error}");
    }
    core.emit(json!({ "type": "conversationListChanged" }));
}

/// 落盘一条用户消息。
///
/// 命令消息（`/xxx`）宿主不乐观回显，由这里在「真正进入上下文」时补发气泡；
/// `_needsUINotification` 只服务这次补发，先摘掉再落盘，避免 UI 专用标记写进 JSONL
/// 。
fn persist_user_message(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    user_message: &Value,
    user_initiated: bool,
) -> Result<(), String> {
    let mut stripped = None;
    if user_message.get("_needsUINotification").and_then(Value::as_bool) == Some(true) {
        let mut owned = user_message.clone();
        if let Some(object) = owned.as_object_mut() {
            object.remove("_needsUINotification");
        }
        stripped = Some(owned);
    }
    let user_message = stripped.as_ref().unwrap_or(user_message);
    if stripped.is_some() {
        emit_user_message_to_ui(core, session_id, user_message);
    }
    persist_message(core, session_id, project, state, user_message)?;
    emit_highlight_languages(core, user_message);
    // 标题 / `meta.json` 建档必须先于 `touch_metadata`：后者在 meta 缺失时
    // 会用不含 title 的兜底对象建档，抢先建档会让首条消息的标题丢失。
    update_title_if_needed(core, session_id, project);
    announce_message_appended(core, session_id, project, user_initiated);
    Ok(())
}

/// 落盘一条 Reminder（silent / `origin=agent` 的自动消息）。
///
/// 落盘失败不阻塞本轮：仍然进内存上下文。
fn persist_reminder(
    core: &Arc<Core>,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    content: &str,
) {
    let reminder = build_reminder_message(content);
    match core.project_of(session_id) {
        Ok(project) => match persist_message(core, session_id, &project, state, &reminder) {
            Ok(_) => {
                emit_highlight_languages(core, &reminder);
                // 系统自动消息：不刷新 `updatedAt`
                announce_message_appended(core, session_id, &project, false);
            }
            Err(error) => {
                state.lock().unwrap().messages.push(reminder);
                eprintln!("[core] persist reminder failed: {error}");
            }
        },
        Err(error) => {
            state.lock().unwrap().messages.push(reminder);
            eprintln!("[core] resolve project for reminder failed: {error}");
        }
    }
}

/// 落盘一条自动消息（子代理 Reply / 后台 Bash 完成通知）并上报 UI
/// 。
///
/// 落盘失败不阻塞本轮：仍然进内存上下文。
fn persist_auto_message(
    core: &Arc<Core>,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    item: &AgentMessage,
) {
    let message = build_auto_message(item);
    match core.project_of(session_id) {
        Ok(project) => match persist_message(core, session_id, &project, state, &message) {
            Ok(_) => {
                emit_highlight_languages(core, &message);
                // 系统自动消息：不刷新 `updatedAt`
                announce_message_appended(core, session_id, &project, false);
            }
            Err(error) => {
                state.lock().unwrap().messages.push(message);
                eprintln!("[core] persist agent message failed: {error}");
            }
        },
        Err(error) => {
            state.lock().unwrap().messages.push(message);
            eprintln!("[core] resolve project for agent message failed: {error}");
        }
    }
    // UI 上报（对齐 `QueryEngine.notifyAgentReplyToUI`）：
    // - `bash`：纯文本（含 ANSI 颜色），不渲染 markdown；
    // - `agent`：markdown + From 头（`param` 是 `host:agent:<id>`）。
    let data = if item.origin == "bash" {
        json!({ "role": "user", "content": item.content, "origin": "bash" })
    } else {
        let source = agent_source_info(&item.from_session_id);
        json!({
            "role": "user",
            "content": item.content,
            "param": source,
            "origin": "agent",
            "meta": { "param": source, "type": "from" },
        })
    };
    core.emit(json!({ "type": "message", "sessionId": session_id, "data": data }));
}

/// spin 模式下把子代理 Reply 写进主会话上下文并落盘。
///
/// 消息带 `silent` 标记：进上下文、写 `<sid>.jsonl`，但**不发** `message` 事件、
/// 回放时不展示（`replay.rs` 过滤 `silent`）、不通知 UI。落盘失败不阻塞：仍进内存上下文。
fn persist_spin_reply(
    core: &Arc<Core>,
    session_id: &str,
    state: &Arc<Mutex<SessionState>>,
    content: &str,
    from_session_id: &str,
) {
    let item = AgentMessage {
        content: content.to_string(),
        origin: "agent".to_string(),
        from_session_id: from_session_id.to_string(),
    };
    let mut message = build_auto_message(&item);
    if let Some(object) = message.as_object_mut() {
        object.insert("silent".to_string(), json!(true));
    }
    match core.project_of(session_id) {
        Ok(project) => match persist_message(core, session_id, &project, state, &message) {
            Ok(_) => {
                emit_highlight_languages(core, &message);
                // 系统自动消息：不刷新 `updatedAt`
                announce_message_appended(core, session_id, &project, false);
            }
            Err(error) => {
                state.lock().unwrap().messages.push(message);
                eprintln!("[core] persist spin reply failed: {error}");
            }
        },
        Err(error) => {
            state.lock().unwrap().messages.push(message);
            eprintln!("[core] resolve project for spin reply failed: {error}");
        }
    }
}

/// 一批排队消息。
enum QueuedBatch {
    /// Reminder 优先；同时有待处理用户消息时并入同一轮（reminder 在前、用户消息在末尾）。
    Reminder {
        content: String,
        user_message: Option<Value>,
    },
    /// 自动消息（子代理 Reply / 后台 Bash 通知）+ 用户消息合并：自动消息先追加、
    /// 用户消息放末尾，保证同一轮 LLM 按序看到。
    AutoMessages {
        messages: Vec<AgentMessage>,
        user_message: Option<Value>,
    },
    /// 纯用户消息。
    Message(Value),
}

/// 从队列取一批待消费消息（消费优先级）：
/// Reminder > (Agent + 用户合并) > 纯用户 > 纯 Agent。
///
/// `include_command_user_message = false`（查询中途 flush）时不消费命令消息（`/xxx`）：
/// 命令只在轮次边界生效，不能在多步工具调用进行到一半时注入 Skill / 执行内置命令。
fn take_queued_batch(
    state: &Arc<Mutex<SessionState>>,
    include_command_user_message: bool,
) -> Option<QueuedBatch> {
    let mut guard = state.lock().unwrap();
    let has_user_message = guard
        .pending_user_message
        .as_ref()
        .map(|message| {
            include_command_user_message || !util::js_trim(&message_text(message)).starts_with('/')
        })
        .unwrap_or(false);
    let has_agent_messages = !guard.agent_messages.is_empty();

    if let Some(content) = guard.pending_reminder.take() {
        // 若同时有待处理的用户消息，并入同一轮（reminder 在前、用户消息在末尾）：
        // 只 flush reminder 会让这一轮 LLM 已经带上用户消息并响应一次，随后用户消息
        // 又被移到末尾单独跑一轮 → 用户消息被重复响应。
        let user_message = if has_user_message {
            guard.pending_user_message.take()
        } else {
            None
        };
        return Some(QueuedBatch::Reminder {
            content,
            user_message,
        });
    }
    if has_user_message && has_agent_messages {
        let user_message = guard.pending_user_message.take();
        let messages = guard.agent_messages.drain(..).collect();
        return Some(QueuedBatch::AutoMessages {
            messages,
            user_message,
        });
    }
    if has_user_message {
        return guard.pending_user_message.take().map(QueuedBatch::Message);
    }
    if has_agent_messages {
        let messages = guard.agent_messages.drain(..).collect();
        return Some(QueuedBatch::AutoMessages {
            messages,
            user_message: None,
        });
    }
    None
}

/// 把排队中的消息并入上下文。
///
/// **每次 LLM 请求前**都会 flush 排队消息：多轮工具
/// 调用期间到达的用户消息 / 子代理回复 / Reminder，会在生成下一个 tool_use 之前进入
/// `mutableMessages`，而不是等整轮结束再单独起一轮。被 flush 的消息同步落盘
/// （`persistUnpersistedMessages`），因此这里逐条走与普通消息相同的落盘 / 标题 / 列表刷新路径
/// （用户消息的 `_userInitiated` 为真）。
fn flush_queued_messages(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
) -> Result<(), String> {
    while let Some(batch) = take_queued_batch(state, false) {
        match batch {
            QueuedBatch::Reminder {
                content,
                user_message,
            } => {
                persist_reminder(core, session_id, state, &content);
                if let Some(user_message) = user_message {
                    persist_user_message(core, session_id, project, state, &user_message, true)?;
                }
            }
            QueuedBatch::AutoMessages {
                messages,
                user_message,
            } => {
                for item in &messages {
                    persist_auto_message(core, session_id, state, item);
                }
                if let Some(user_message) = user_message {
                    persist_user_message(core, session_id, project, state, &user_message, true)?;
                }
            }
            QueuedBatch::Message(user_message) => {
                persist_user_message(core, session_id, project, state, &user_message, true)?;
            }
        }
    }
    Ok(())
}

fn run_query_loop(
    core: &Arc<Core>,
    session_id: &str,
    project: &str,
    state: &Arc<Mutex<SessionState>>,
    provider: &config::ProviderConfig,
    agent_mode: &str,
) -> Result<(), String> {
    // 工具清单 = 内置工具 + 该会话启用列表里的 MCP 服务器工具。
    // 联网搜索生效值（会话覆盖 → settings 默认，已并入 `provider.web_search`）
    // 决定 WebSearch / WebFetch 是否注入；MCP 工具不受影响。
    // specs/020 FR-002：非 Master 角色的会话在此之上按角色白名单过滤——
    // 一处过滤同时落实「无 `mcp__*`、不联网、预设不叠加」（白名单不在 minimal 的
    // Bash / Edit 里）；Master 与普通会话白名单为 None，清单不变。
    let role_tools = state
        .lock()
        .unwrap()
        .sub_agent_role
        .as_deref()
        .and_then(crate::tools::sub_agent_role_tools);
    let all_tools: Vec<Value> = {
        let base: Vec<Value> = all_tool_definitions(session_id)
            .into_iter()
            .filter(|tool| {
                provider.web_search
                    || !matches!(
                        tool.get("name").and_then(Value::as_str),
                        Some("WebSearch") | Some("WebFetch")
                    )
            })
            .collect();
        match role_tools {
            Some(allow) => base
                .into_iter()
                .filter(|tool| {
                    tool.get("name")
                        .and_then(Value::as_str)
                        .map(|name| allow.contains(&name))
                        .unwrap_or(false)
                })
                .collect(),
            None => base,
        }
    };
    // 轮次上限：**普通会话恒为不限**。
    //
    // `settings.json` 里虽然声明了 `features.maxTurns`，但没有任何消费方
    // （只有类型声明）。因此不读该配置、不设上限。
    // 保留下面的 `max_turns` 判定，供后续迁入 Spin / Agent 时按子会话传入。
    let max_turns: Option<u64> = None;
    let mut turn_count: u64 = 0;
    loop {
        // 上一轮工具批收尾之后才到达的中止：
        // 这里在发起请求前拦下，同样上报 `*User Interrupted*`，不再进入下一轮。
        if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
            emit_user_interrupted(core, session_id, state);
            return Ok(());
        }
        // 排队消息在**下一次 LLM 请求前**并入上下文：多轮工具调用期间到达的用户消息，
        // 会在生成下一个 tool_use 之前插入上下文，而不是等整轮结束再单独起一轮。
        flush_queued_messages(core, session_id, project, state)?;
        // 每轮 LLM 往返各发一次 aiBegin / aiEnd
        // 提示词预设按轮计算：`mixed` 在首次 assistant 回复前用 minimal，之后切 normal
        // （对齐 `QueryEngine.getActivePromptPresetId`——它在 query 循环每轮重新取状态）。
        let (prompt_mode, has_assistant_reply) = {
            let state = state.lock().unwrap();
            (
                state.prompt_mode.clone(),
                state
                    .messages
                    .iter()
                    .any(|message| message.get("type").and_then(Value::as_str) == Some("assistant")),
            )
        };
        // specs/020 FR-003：非 Master 角色固定 normal 预设（不随 mixed→minimal 切换，
        // 也不受迟到的会话级覆盖影响）；工具清单已按角色白名单过滤，预设白名单不叠加。
        let preset = match role_tools {
            Some(_) => "normal",
            None => prompt::active_preset(prompt_mode.as_deref(), has_assistant_reply),
        };
        // minimal / mixed 只把 Bash / Edit 暴露给 LLM（`PromptPreset.toolNames`）
        let tools = prompt::filter_tools_by_preset(all_tools.clone(), preset);
        // `static_system_prompt` 整体替换组装结果；`system_prompt_prefix` 只在组装结果前
        // 加一段：Master 子代理 = 主对话同款提示词 +
        // 开头 `## Communication` 段。
        let (static_prompt, prompt_prefix) = {
            let state = state.lock().unwrap();
            (
                state.static_system_prompt.clone(),
                state.system_prompt_prefix.clone(),
            )
        };
        let base_prompt = match static_prompt {
            Some(prompt) => prompt,
            // PATH 解析失败会在这里成为整轮查询的错误（`docs/core/standalone-core.md` 第 3.2 节）
            None => prompt::build_system_prompt_with_preset(preset, project, &tools)?,
        };
        let system_prompt = match prompt_prefix {
            Some(prefix) => format!("{prefix}\n\n{base_prompt}"),
            None => base_prompt,
        };

        // Auto compact 检查（含手动触发但被延后的压缩）。
        //
        // 位置：在**本轮读取消息之前**、`aiBegin` 之前。
        // 手动触发压缩时会话若非空闲会登记「待压缩」，这里把它当作「已达到需要压缩
        // 的条件」，与自动压缩走同一条安全路径。
        //
        // 上下文占用口径同样对齐：`max(exactTokenCount ?? 0, estimate(messages, systemPrompt))`
        // —— 注意**不含** tools。
        {
            let estimate = util::estimate_request_tokens(
                Some(&Value::Array(build_llm_messages(state))),
                &system_prompt,
                None,
            );
            let context_token_count = exact_context_tokens(state, session_id, project)
                .unwrap_or(0)
                .max(estimate);
            let pending_compact = compact::is_pending_compact(session_id);
            let tracking = state.lock().unwrap().auto_compact_tracking.clone();
            let should_compact = pending_compact
                || compact::should_auto_compact(
                    tracking.as_ref(),
                    Some(context_token_count),
                    provider.context_window as u64,
                    provider.max_tokens as u64,
                );
            if should_compact {
                if pending_compact {
                    compact::unmark_pending_compact(session_id);
                }
                // 延后的手动压缩按 manual 记录边界（trigger = 'manual'）；自动压缩保持 'auto'
                let applied = compact::compact_and_apply_messages(
                    core,
                    session_id,
                    project,
                    state,
                    !pending_compact,
                    None,
                );
                if applied {
                    // 压缩会重建消息数组，`last_uuid` / `persisted_count` 已由
                    // `compact_and_apply_messages` 指向新的末尾消息
                    eprintln!("[core] compact: applied for session {session_id}");
                } else if pending_compact {
                    // 待压缩标记已清除但压缩提前返回（无可摘要内容）：补一次快照，
                    // 让 UI 从「准备压缩」还原为用量文本
                    core.emit_runtime();
                }
            }
        }

        // 每轮 LLM 往返各发一次 aiBegin / aiEnd
        core.emit(json!({ "type": "aiBegin", "sessionId": session_id }));
        let llm_messages = build_llm_messages(state);
        let cancel = state.lock().unwrap().cancel.clone();

        // 落盘消息的累积内容（整轮所有块拼接）
        let mut text = String::new();
        let mut thinking = String::new();
        // UI 流式累积：**每个块重置**（block_stop / message_delta
        // 时用它们作为 `streamEnd.accumulated`，多块时只反映最后一个块）。
        let mut streamed_text = String::new();
        let mut streamed_thinking = String::new();
        let mut thinking_signature = String::new();
        let mut tool_uses: Vec<Value> = Vec::new();
        // (id, name, 累积的 input JSON, content_block_start 里的初始 input)
        let mut current_tool: Option<(String, String, String, Value)> = None;
        let mut usage = Usage::default();
        let mut stop_reason = String::new();
        // 轮次级 id：纯 tool_use 轮次的 `streamEnd` 与块级 id 缺失时的兜底都用它
        // 。
        let stream_id = util::unique_id("msg");
        // 块级 id（`blk_*`）。
        // 同一个块内的 `streamMessage` / `streamEnd` 共用，跨块互不覆盖。
        let mut current_thinking_stream_id: Option<String> = None;
        let mut current_text_stream_id: Option<String> = None;
        let mut current_block_type: Option<llm::BlockKind> = None;
        // 对齐三个适配器的 `if (effectiveThinkingEffort && effectiveThinkingEffort !== 'off')`：
        // 空串是假值，同样视为关闭思考。
        let thinking_enabled =
            !provider.thinking_effort.is_empty() && provider.thinking_effort != "off";
        let mut error: Option<String> = None;

        // 本次请求的 max output：min(output, context - current_context)（对齐 Query.ts
        // 的 `getAvailableOutputTokens`）。输出预留不能超过上下文窗口的剩余空间，
        // 否则「输入 + 输出」会超出窗口导致请求失败。
        //
        // 当前上下文占用取 `Math.max(exactTokenCount ?? 0, 估算值)`：
        // - `exactTokenCount` 是上一轮 API 返回的真实用量（最近一条带 usage 的 assistant
        //   消息的 input + output），没有时回退 `meta.json` 的 `context.totalContextTokens`；
        // - 估算值覆盖本轮新增的消息 / system prompt / 工具 schema，口径见 `tokenEstimate.ts`。
        // 只取估算值时，真实上下文大于估算值的场景（多模态图片等）会把输出空间留大，
        // 导致 `input + max_tokens` 超出窗口被服务端拒绝。
        let estimate = util::estimate_request_tokens(
            Some(&Value::Array(llm_messages.clone())),
            &system_prompt,
            Some(&Value::Array(tools.clone())),
        );
        let current_context_tokens = exact_context_tokens(state, session_id, project)
            .unwrap_or(0)
            .max(estimate);
        let available_output = available_output_tokens(
            provider.context_window as u64,
            provider.max_tokens as u64,
            current_context_tokens,
        );
        let mut turn_provider = provider.clone();
        turn_provider.max_tokens = turn_provider.max_tokens.min(available_output);
        // 极简 / 混合（极简阶段）不使用联网搜索（对齐 `getEffectiveModelConfig`）
        if preset == "minimal" {
            turn_provider.web_search = false;
        }

        {
            let request = LlmRequest {
                provider: &turn_provider,
                system_prompt: &system_prompt,
                messages: &llm_messages,
                tools: &tools,
                session_id,
                thinking_enabled,
                cancel: &cancel,
                first_byte_timeout_ms: llm::DEFAULT_FIRST_BYTE_TIMEOUT_MS,
                idle_timeout_ms: llm::DEFAULT_STREAM_IDLE_TIMEOUT_MS,
            };
            let core_ref = Arc::clone(core);
            let session = session_id.to_string();
            let stream_id_ref = stream_id.clone();
            let mut emit = |event: LlmEvent| match event {
                // 块开始：分配块级 streamId，并重置该角色的流式累积
                // 。
                LlmEvent::BlockStart(kind) => match kind {
                    llm::BlockKind::Thinking => {
                        streamed_thinking.clear();
                        current_thinking_stream_id = Some(util::unique_id("blk"));
                        current_block_type = Some(llm::BlockKind::Thinking);
                    }
                    llm::BlockKind::Text => {
                        streamed_text.clear();
                        current_text_stream_id = Some(util::unique_id("blk"));
                        current_block_type = Some(llm::BlockKind::Text);
                    }
                    llm::BlockKind::ToolUse => {
                        current_block_type = Some(llm::BlockKind::ToolUse);
                    }
                },
                // 块结束：立刻补一条 `usage` 缺省的 `streamEnd`，把对应流式消息
                // 标记为完成。
                // 只有 thinking / text 块、且块内有内容时才发。
                LlmEvent::BlockStop => {
                    let finished = match current_block_type {
                        Some(llm::BlockKind::Thinking) if !streamed_thinking.is_empty() => {
                            Some((
                                "thinking",
                                streamed_thinking.clone(),
                                current_thinking_stream_id.clone(),
                            ))
                        }
                        Some(llm::BlockKind::Text) if !streamed_text.is_empty() => {
                            Some((
                                "assistant",
                                streamed_text.clone(),
                                current_text_stream_id.clone(),
                            ))
                        }
                        _ => None,
                    };
                    if let Some((role, accumulated, block_id)) = finished {
                        let id = block_id.unwrap_or_else(|| stream_id_ref.clone());
                        core_ref.emit(json!({
                            "type": "streamEnd",
                            "sessionId": session,
                            "data": { "role": role, "accumulated": accumulated, "streamId": id },
                        }));
                    }
                    current_block_type = None;
                }
                // 流接近结束：带 usage 的收尾 `streamEnd`。每个有内容的角色一条；
                // 纯 tool_use 轮次补一条 `accumulated` 为空的 assistant 事件，
                // 把 usage 带给 UI。
                LlmEvent::MessageDelta => {
                    let usage_json = usage.to_json();
                    if !streamed_thinking.is_empty() {
                        let id = current_thinking_stream_id
                            .clone()
                            .unwrap_or_else(|| stream_id_ref.clone());
                        core_ref.emit(json!({
                            "type": "streamEnd",
                            "sessionId": session,
                            "data": { "role": "thinking", "accumulated": streamed_thinking, "usage": usage_json, "streamId": id },
                        }));
                    }
                    if !streamed_text.is_empty() {
                        let id = current_text_stream_id
                            .clone()
                            .unwrap_or_else(|| stream_id_ref.clone());
                        core_ref.emit(json!({
                            "type": "streamEnd",
                            "sessionId": session,
                            "data": { "role": "assistant", "accumulated": streamed_text, "usage": usage_json, "streamId": id },
                        }));
                    }
                    if streamed_thinking.is_empty() && streamed_text.is_empty() {
                        core_ref.emit(json!({
                            "type": "streamEnd",
                            "sessionId": session,
                            "data": { "role": "assistant", "accumulated": "", "usage": usage_json, "streamId": stream_id_ref },
                        }));
                    }
                }
                LlmEvent::TextDelta(delta) => {
                    text.push_str(&delta);
                    streamed_text.push_str(&delta);
                    let id = current_text_stream_id
                        .clone()
                        .unwrap_or_else(|| stream_id_ref.clone());
                    core_ref.emit(json!({
                        "type": "streamMessage",
                        "sessionId": session,
                        "data": { "role": "assistant", "delta": delta, "accumulated": streamed_text, "streamId": id },
                    }));
                }
                LlmEvent::ThinkingDelta(delta) => {
                    thinking.push_str(&delta);
                    streamed_thinking.push_str(&delta);
                    let id = current_thinking_stream_id
                        .clone()
                        .unwrap_or_else(|| stream_id_ref.clone());
                    core_ref.emit(json!({
                        "type": "streamMessage",
                        "sessionId": session,
                        "data": { "role": "thinking", "delta": delta, "accumulated": streamed_thinking, "streamId": id },
                    }));
                }
                LlmEvent::ThinkingSignatureStart(signature) => {
                    // 设置语义：覆盖本轮已累积的签名（`content_block_start` 里的初始值）
                    thinking_signature = signature;
                }
                LlmEvent::ThinkingSignatureDelta(delta) => {
                    thinking_signature.push_str(&delta);
                }
                LlmEvent::ToolUseStart { id, name, input } => {
                    if let Some((prev_id, prev_name, prev_json, prev_input)) = current_tool.take() {
                        tool_uses.push(tool_use_block(
                            &prev_id,
                            &prev_name,
                            &prev_json,
                            &prev_input,
                        ));
                    }
                    current_tool = Some((id, name, String::new(), input));
                }
                LlmEvent::ToolUseInputDelta(delta) => {
                    if let Some((_, _, json_text, _)) = current_tool.as_mut() {
                        json_text.push_str(&delta);
                    }
                }
                LlmEvent::Usage(delta) => {
                    if delta.input_tokens > 0 {
                        usage.input_tokens = delta.input_tokens;
                    }
                    if delta.output_tokens > 0 {
                        usage.output_tokens = delta.output_tokens;
                    }
                    if delta.cache_read_input_tokens.is_some() {
                        usage.cache_read_input_tokens = delta.cache_read_input_tokens;
                    }
                    if delta.cache_creation_input_tokens.is_some() {
                        usage.cache_creation_input_tokens = delta.cache_creation_input_tokens;
                    }
                    if delta.reasoning_tokens.is_some() {
                        usage.reasoning_tokens = delta.reasoning_tokens;
                    }
                }
                LlmEvent::StopReason(reason) => stop_reason = reason,
                // 服务端在终止事件里给出的权威输出：整体替换本轮累积
                // （对齐 `syncContentBlocksFromOutput`）
                LlmEvent::AuthoritativeBlocks(blocks) => {
                    text.clear();
                    thinking.clear();
                    tool_uses.clear();
                    current_tool = None;
                    for block in &blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("text") => text.push_str(
                                block.get("text").and_then(Value::as_str).unwrap_or(""),
                            ),
                            Some("thinking") => thinking.push_str(
                                block.get("thinking").and_then(Value::as_str).unwrap_or(""),
                            ),
                            Some("tool_use") => tool_uses.push(block.clone()),
                            _ => {}
                        }
                    }
                }
                // 退化重复被检出、即将重试：丢弃本次尝试已产生的全部输出
                // 。
                LlmEvent::Reset => {
                    text.clear();
                    thinking.clear();
                    streamed_text.clear();
                    streamed_thinking.clear();
                    thinking_signature.clear();
                    tool_uses.clear();
                    current_tool = None;
                    usage = Usage::default();
                    stop_reason.clear();
                    current_thinking_stream_id = None;
                    current_text_stream_id = None;
                    current_block_type = None;
                }
            };
            if let Err(err) = llm::stream(&request, &mut emit) {
                error = Some(err);
            }
        }
        if let Some((id, name, json_text, input)) = current_tool.take() {
            tool_uses.push(tool_use_block(&id, &name, &json_text, &input));
        }

        // 流式收尾的 `streamEnd`（`block_stop` 一条 usage 缺省 + `message_delta`
        // 一条带 usage）由上面的 `emit` 闭包在处理 `LlmEvent::BlockStop` /
        // `LlmEvent::MessageDelta` 时发出，这里不再补发。

        if let Some(error) = error {
            core.emit(json!({ "type": "aiEnd", "sessionId": session_id }));
            // 用户主动取消（abort）导致的失败不是 LLM 故障——上报 `*User Interrupted*` 并正常
            // 结束本轮，而不是把错误文案当 API 失败回显给用户。
            if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
                emit_user_interrupted(core, session_id, state);
                return Ok(());
            }
            return Err(error);
        }
        let cancelled = state.lock().unwrap().cancel.load(Ordering::Relaxed);

        // 组装 assistant 消息并落盘（带 stop_reason 与 usage）
        let assistant = build_assistant_message(
            &text,
            &thinking,
            &thinking_signature,
            &tool_uses,
            &stop_reason,
            &usage,
        );
        let _ = persist_message(core, session_id, project, state, &assistant)?;
        emit_highlight_languages(core, &assistant);
        announce_message_appended(core, session_id, project, false);
        // 上下文占用（input + output）写回 meta.json（对齐 QueryEngine 的 totalContextTokens）。
        // 只在 `totalContextTokens > 0` 时更新（0 视为「本轮 usage 不可信」）。
        let total = usage.input_tokens + usage.output_tokens;
        if total > 0 {
            let _ = history::update_context(
                session_id,
                project,
                &[json!({ "key": "totalContextTokens", "value": total })],
            );
        }

        if cancelled || tool_uses.is_empty() {
            if cancelled {
                // assistant 消息已经带 tool_use 落盘，
                // 必须为每个未执行的 tool_use 补一条 `Command was interrupted` 的 tool_result
                // （`is_canceled: true` / `exit_code: -1`），否则历史里留下孤儿 tool_use，
                // 下一轮请求会被 Anthropic 以「tool_use ids were found without tool_result
                // blocks」拒绝。随后再补一条 `*User Interrupted*` 系统消息。
                let interrupted: Vec<Value> = tool_uses
                    .iter()
                    .map(|tool_use| {
                        let tool_use_id = tool_use
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let tool_name = tool_use
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        core.emit(json!({
                            "type": "toolResult",
                            "sessionId": session_id,
                            "toolUseId": tool_use_id,
                            "toolName": tool_name,
                            "output": INTERRUPTED_MESSAGE,
                            "status": "error",
                        }));
                        json!({
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": INTERRUPTED_MESSAGE,
                            "exit_code": -1,
                            "is_canceled": true,
                        })
                    })
                    .collect();
                if !interrupted.is_empty() {
                    let result_message = json!({
                        "type": "user",
                        "message": { "role": "user", "content": interrupted },
                        "uuid": util::unique_id("tool_result"),
                        "timestamp": util::now_millis(),
                    });
                    let _ = persist_message(core, session_id, project, state, &result_message)?;
                    announce_message_appended(core, session_id, project, false);
                }
                emit_user_interrupted(core, session_id, state);
            }
            core.emit(json!({ "type": "aiEnd", "sessionId": session_id }));
            return Ok(());
        }

        // 执行工具
        let mut results: Vec<Value> = Vec::new();
        // 工具额外注入对话的消息（`toolResult.newMessages`，当前只有 Skill）：
        // 在该批 tool_result 消息**之后**按序注入
        let mut new_messages: Vec<Value> = Vec::new();
        // 用户在确认框里**不带原因地**拒绝：本批工具收尾后直接结束本轮
        // 。
        let mut terminate_after_batch = false;
        // 已批准、等待并行执行的并发安全工具：
        // 连续出现的并发安全工具攒成一批，遇到非并发安全工具 / 批末时统一并行执行。
        let mut pending: Vec<PendingTool> = Vec::new();
        let mut index = 0;
        while index < tool_uses.len() {
            let tool_use = &tool_uses[index];
            let tool_use_id = tool_use
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tool_name = tool_use
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let raw_input = tool_use.get("input").cloned().unwrap_or(json!({}));

            // 工具不存在：
            // 不执行、不弹确认框；仍发一次 `toolPermissionRequested`（`permResult`
            // 默认 `allow`，UI 借此上架失败卡片），随后补 `Error: Tool "X" not found`
            // 并**跳过**该工具（skip 而非 stop：后面的工具继续）。
            if !is_known_tool(&tool_name) {
                // 工具不存在时不跑工具自身权限校验，
                // permResult 恒为 allow，displayArgs 仍按工具名做路径展开。
                // 复用 `request_tool_permission`（内部走 `plain_request`）：这段往返只是让
                // UI 上架失败卡片，没有在等用户（`docs/core/session-runtime.md` 第 1 节）。
                let _ = core.request_tool_permission(
                    session_id,
                    &tool_use_id,
                    &tool_name,
                    &json!({ "behavior": "allow" }),
                    &permission::display_args_for_unknown(&tool_name, &raw_input, project),
                    agent_mode,
                );
                let message = format!("Error: Tool \"{tool_name}\" not found");
                core.emit(json!({
                    "type": "toolResult",
                    "sessionId": session_id,
                    "toolUseId": tool_use_id,
                    "toolName": tool_name,
                    "output": message,
                    "status": "error",
                }));
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": message,
                    "exit_code": -1,
                    "is_canceled": false,
                }));
                index += 1;
                continue;
            }

            // 入参 schema 校验：
            // 先按原样 `safeParse`；失败时用 `fixToolInput` 修字段级 double-encode，
            // 再校验一次（仍失败则用修复后的错误文案）。校验通过后使用**规范化**数据
            // （zod 的 coerce / default 产物）。
            let mut input = raw_input.clone();
            // 实际被采纳的修复入参：只有它真的不同
            // 才落 `tool_use_update`。
            let mut used_input: Option<Value> = None;
            let mut schema_error: Option<String> = None;
            match tool_input::parse_input(&tool_name, &input) {
                Ok(parsed) => input = parsed,
                Err(first_error) => {
                    if let Some(fixed) = fix_tool_input(&raw_input) {
                        match tool_input::parse_input(&tool_name, &fixed) {
                            Ok(parsed) => {
                                input = parsed;
                                used_input = Some(fixed);
                            }
                            Err(fixed_error) => schema_error = Some(fixed_error),
                        }
                    } else {
                        schema_error = Some(first_error);
                    }
                }
            }
            // 只有确实用了修复后的入参才落 `tool_use_update`。
            if let Some(fixed) = &used_input {
                let _ = history::append_tool_use_update(
                    session_id,
                    project,
                    &tool_use_id,
                    &json!({ "input": fixed }),
                );
            }

            // 语义校验：
            // 失败时先发一次 `toolPermissionRequested`（permResult 取权限层判定，
            // UI 上架卡片），再补 `InputValidationError: ...` 并跳过该工具。
            let validation_message =
                schema_error.or_else(|| tools::validate_input(&tool_name, &input, project));
            if let Some(validation_message) = validation_message {
                // 非对象入参（典型：LLM 返回的非法 JSON 参数解析失败后残留的原文
                // string）在这里收敛成空对象并落一条 `tool_use_update`：
                // 否则该字符串随历史在后续每轮请求中原样
                // 回传给 Provider，严格校验 arguments 的服务商会一直 400，表现为
                // 「此后所有输入都失败」。对象型入参即使校验失败也可安全序列化，保持原样。
                if !raw_input.is_object() {
                    let _ = history::append_tool_use_update(
                        session_id,
                        project,
                        &tool_use_id,
                        &json!({ "input": {} }),
                    );
                }
                // 验证失败时同样先发一次 toolPermissionRequested
                // （工具实例在场，checkPermissions 会跑；displayArgs 照常展开）。
                let (perm_result, display_args) =
                    permission::resolve_tool_permission(
                        &tool_name,
                        &input,
                        agent_mode,
                        project,
                        session_id,
                    );
                // 同样只是让 UI 上架失败卡片：复用 `request_tool_permission`（内部走
                // `plain_request`），不标记 `waiting`（`docs/core/session-runtime.md` 第 1 节）。
                let _ = core.request_tool_permission(
                    session_id,
                    &tool_use_id,
                    &tool_name,
                    &perm_result,
                    &display_args,
                    agent_mode,
                );
                let message = format!("InputValidationError: {validation_message}");
                core.emit(json!({
                    "type": "toolResult",
                    "sessionId": session_id,
                    "toolUseId": tool_use_id,
                    "toolName": tool_name,
                    "output": message,
                    "status": "error",
                }));
                results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": message,
                    "exit_code": -1,
                    "is_canceled": false,
                }));
                index += 1;
                continue;
            }

            core.emit(json!({
                "type": "toolCall",
                "sessionId": session_id,
                "toolUseId": tool_use_id,
                "toolName": tool_name,
            }));
            core.emit(json!({
                "type": "toolArgsUpdated",
                "sessionId": session_id,
                "toolUseId": tool_use_id,
                "args": input,
            }));

            let outcome = match core.resolve_permission(
                session_id,
                &tool_use_id,
                &tool_name,
                &input,
                agent_mode,
                project,
            ) {
                PermissionOutcome::Allowed { updated_input } => {
                    // 执行前会话已被中止：不执行工具，
                    // 补一条 `Command was aborted before execution` 的取消结果，
                    // 并结束本批（`shouldPreventContinuation` → 不再回到 LLM）。
                    if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
                        // 已批准的并发安全批先收尾（同样按中止取消），再取消当前工具：
                        // 这样结果顺序仍是「批内按原顺序 + 当前工具」。
                        flush_pending_batch(
                            core,
                            session_id,
                            project,
                            state,
                            &mut pending,
                            &mut results,
                            &mut new_messages,
                            &mut terminate_after_batch,
                        );
                        emit_cancel_result(
                            core,
                            session_id,
                            &tool_use_id,
                            &tool_name,
                            "Command was aborted before execution",
                            &mut results,
                        );
                        terminate_after_batch = true;
                        index += 1;
                        continue;
                    }
                    // 权限层回传 `updatedInput`
                    // （`buildTool` 默认 checkPermissions 的规范化产物）时，若与当前内存
                    // 入参不同则追加一条 `tool_use_update`（zod coerce / default 的差异）。
                    if let Some(updated) = updated_input.as_ref() {
                        let current_input = used_input.clone().unwrap_or_else(|| raw_input.clone());
                        let changed = serde_json::to_string(&current_input).ok()
                            != serde_json::to_string(updated).ok();
                        if changed {
                            let _ = history::append_tool_use_update(
                                session_id,
                                project,
                                &tool_use_id,
                                &json!({ "input": updated }),
                            );
                        }
                    }
                    let effective_input = updated_input.unwrap_or_else(|| input.clone());
                    // 执行前追加 `_meta.confirmTimestamp`（宿主 UI 不读，但历史回放要用），
                    // 并**再发一次** `toolCall` 表示开始执行。
                    let confirm_now = crate::util::now_millis();
                    let _ = history::append_tool_use_update(
                        session_id,
                        project,
                        &tool_use_id,
                        &json!({ "meta": { "confirmTimestamp": confirm_now } }),
                    );
                    core.emit(json!({
                        "type": "toolCall",
                        "sessionId": session_id,
                        "toolUseId": tool_use_id,
                        "toolName": tool_name,
                    }));
                    // 并发安全工具：先攒批（`toolCall` 已在上面的授权阶段发完，
                    // 整批发完 toolCall 后再执行）。
                    if is_tool_concurrency_safe(&tool_name, &effective_input) {
                        pending.push(PendingTool {
                            tool_use_id: tool_use_id.clone(),
                            tool_name: tool_name.clone(),
                            input: effective_input,
                        });
                        index += 1;
                        continue;
                    }
                    // 非并发安全工具：先把攒下的批跑完，再串行执行本工具
                    flush_pending_batch(
                        core,
                        session_id,
                        project,
                        state,
                        &mut pending,
                        &mut results,
                        &mut new_messages,
                        &mut terminate_after_batch,
                    );
                    execute_tool(
                        core,
                        session_id,
                        project,
                        state,
                        &tool_use_id,
                        &tool_name,
                        &effective_input,
                    )
                }
                // 权限拒绝：文案原样进 tool_result，
                // 随后把**剩余**工具一并标记为取消并结束本批，剩余工具不再执行。
                PermissionOutcome::Denied { message, terminate } => {
                    core.emit(json!({
                        "type": "toolResult",
                        "sessionId": session_id,
                        "toolUseId": tool_use_id,
                        "toolName": tool_name,
                        "output": message,
                        "status": "error",
                    }));
                    results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": message,
                        "exit_code": -1,
                        "is_canceled": false,
                    }));
                    for remaining in tool_uses.iter().skip(index + 1) {
                        let remaining_id = remaining
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let remaining_name = remaining
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        let cancel = format!(
                            "Tool \"{remaining_name}\" was canceled because a previous tool in the batch was denied"
                        );
                        core.emit(json!({
                            "type": "toolResult",
                            "sessionId": session_id,
                            "toolUseId": remaining_id,
                            "toolName": remaining_name,
                            "output": cancel,
                            "status": "error",
                        }));
                        results.push(json!({
                            "type": "tool_result",
                            "tool_use_id": remaining_id,
                            "content": cancel,
                            "exit_code": -1,
                            "is_canceled": true,
                        }));
                    }
                    // 已批准但尚未执行的并发安全批：补取消结果
                    // （注意顺序在取消剩余工具之后）
                    cancel_pending_batch(core, session_id, &mut pending, &mut results);
                    terminate_after_batch = terminate;
                    break;
                }
            };
            new_messages.extend(outcome.new_messages());
            results.push(emit_tool_outcome(
                core,
                session_id,
                project,
                &tool_use_id,
                &tool_name,
                &outcome,
            ));
            // 工具执行完成后会话才被中止：本批收尾后不再回到 LLM，由下面的
            // `terminate_after_batch` 分支上报 `*User Interrupted*`。
            // 中止若在执行**之前**到达，已由上面的取消分支处理，不会走到这里。
            if state.lock().unwrap().cancel.load(Ordering::Relaxed) {
                terminate_after_batch = true;
            }
            index += 1;
        }
        // 批末收尾：把最后一段并发安全工具跑完
        flush_pending_batch(
            core,
            session_id,
            project,
            state,
            &mut pending,
            &mut results,
            &mut new_messages,
            &mut terminate_after_batch,
        );

        let result_message = json!({
            "type": "user",
            "message": { "role": "user", "content": results },
            "uuid": util::unique_id("tool_result"),
            "timestamp": util::now_millis(),
        });
        let _ = persist_message(core, session_id, project, state, &result_message)?;
        emit_highlight_languages(core, &result_message);
        announce_message_appended(core, session_id, project, false);

        // 工具额外注入的消息（Skill 的技能正文）：紧随该批 tool_result 之后落盘 +
        // 进上下文。`isMeta: true` → UI 不展示；
        // 每条同样计入 `messageCount` 并各发一次 `conversationListChanged`
        // （对齐 `Conversation.appendMessage`，与 `inject_skill_tool_use` 同一口径）。
        for message in new_messages {
            let _ = persist_message(core, session_id, project, state, &message)?;
            emit_highlight_languages(core, &message);
            announce_message_appended(core, session_id, project, false);
        }

        if cancelled {
            core.emit(json!({ "type": "aiEnd", "sessionId": session_id }));
            return Ok(());
        }
        if terminate_after_batch {
            // 清掉本轮排队中的用户消息 → 上报 `*User Interrupted*` → 不再回 LLM
            // （该分支不补发 `aiEnd`）。
            state.lock().unwrap().pending_user_message = None;
            emit_user_interrupted(core, session_id, state);
            return Ok(());
        }
        // 手工转后台（`UiEvent.bashBackgroundRequested`）：本批工具结果照常进上下文，
        // 但不再发起下一轮 LLM 请求。
        // 会话由消费循环按队列状态收尾——队列为空 → 结束本轮等用户输入；队列有消息
        // （用户消息 / 后台完成通知 / 提醒）→ 立刻拉起新一轮，性质与用户触发的查询
        // 一致（接续由队列消息触发，与转后台结果无关）。
        if state.lock().unwrap().pause_loop.take() {
            // 触发暂停的任务登记「已兜底」：消费收尾的兜底提醒不再为它立刻补 reminder
            // （否则等于转后台结果自己触发了接续循环，违背暂停语义）。
            let source_task = state.lock().unwrap().pause_loop.take_source_task();
            if let Some(task_id) = source_task {
                let now_ms = util::now_millis();
                let mut guard = state.lock().unwrap();
                let entry = guard
                    .reminder_entries
                    .entry(task_id)
                    .or_insert_with(|| ReminderEntry {
                        clock: bash_task::ReminderClock::default(),
                        last_tick_ms: now_ms,
                        last_accessed_ms: now_ms,
                        fallback_reminded: true,
                    });
                entry.fallback_reminded = true;
            }
            core.emit(json!({ "type": "aiEnd", "sessionId": session_id }));
            return Ok(());
        }
        // 本轮结束
        core.emit(json!({ "type": "aiEnd", "sessionId": session_id }));
        turn_count += 1;
        // 自动压缩跟踪（对齐 `Query.ts` 的 `nextTracking`）：只推进轮次计数，
        // 连续失败计数保持原值（从不递增，熔断实际靠 `shouldAutoCompact`）。
        {
            let mut state = state.lock().unwrap();
            let previous = state.auto_compact_tracking.clone().unwrap_or_default();
            state.auto_compact_tracking = Some(compact::AutoCompactTracking {
                consecutive_failures: previous.consecutive_failures,
                compacted: true,
                turn_id: session_id.to_string(),
                turn_counter: turn_count,
            });
        }
        if let Some(limit) = max_turns {
            if turn_count > limit {
                // 超出 `maxTurns` 时静默停止（`max_turns_reached`
                // attachment 既不落盘也不上报，`aiEnd` 已在上面发过）。
                return Ok(());
            }
        }
    }
}

// ==================== 消息组装 ====================

/// 循环解包可能被多层 JSON 编码的字符串（对齐 `utils/toolInput.ts` 的
/// `unwrapJsonString`：最多 3 层，解析结果与当前值相同则停止）。
fn unwrap_json_string(value: Value) -> Value {
    let mut current = value;
    for _ in 0..3 {
        let Value::String(text) = &current else {
            break;
        };
        let trimmed = crate::util::js_trim(text);
        if trimmed.is_empty() {
            break;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(parsed) => {
                if parsed == current {
                    break;
                }
                current = parsed;
            }
            Err(_) => break,
        }
    }
    current
}

/// 解包 `tool_use.input`：字符串 → 对象 / 数组；只有最终解出对象 / 数组才替换，
/// 否则原样返回（对齐 `unwrapToolInput`，避免把普通字符串误改语义）。
/// 供 Responses API 适配器复用（`syncContentBlocksFromOutput` 的 `unwrapToolInput`）
pub(crate) fn unwrap_tool_input_for_adapter(value: Value) -> Value {
    unwrap_tool_input(value)
}

fn unwrap_tool_input(value: Value) -> Value {
    let unwrapped = unwrap_json_string(value.clone());
    if unwrapped.is_object() || unwrapped.is_array() {
        unwrapped
    } else {
        value
    }
}

/// 序列化 `tool_use.input` 为「字符串型 arguments」协议（OpenAI Chat Completions /
/// Responses）要求的 JSON 文本，保证输出一定是合法 JSON。
///
/// LLM 生成的工具参数解析失败时，非法 JSON 原文会残留在 `tool_use.input`（string）；
/// 原样发给严格校验 arguments 的服务商会 400，且毒化上下文后此后的每一轮请求都
/// 失败。合法 JSON 字符串原样保留（兼容 double-encode），非法字符串降级为
/// `JSON.stringify` 的字符串字面量。
pub(crate) fn serialize_tool_arguments(input: Option<&Value>) -> String {
    match input {
        None | Some(Value::Null) => "{}".to_string(),
        Some(Value::String(text)) => {
            if serde_json::from_str::<Value>(text).is_ok() {
                text.clone()
            } else {
                serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
            }
        }
        Some(other) => crate::util::js_json_stringify(other),
    }
}

/// 归一化 `tool_use.input` 为对象：
/// 字符串（含 double-encode）解出对象时用解出值，其余非对象一律空对象。
fn normalize_tool_input(value: &Value) -> Value {
    let unwrapped = unwrap_tool_input(value.clone());
    if unwrapped.is_object() {
        unwrapped
    } else {
        json!({})
    }
}

/// 归一化发给 Anthropic 协议的消息：`tool_use.input` 非对象（典型：非法 JSON 参数
/// 解析失败后残留的原文 string）时替换为归一化对象。只复制被改写的块，不动原消息。
pub(crate) fn sanitize_anthropic_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            if message.get("role").and_then(Value::as_str) != Some("assistant") {
                return message.clone();
            }
            let Some(Value::Array(blocks)) = message.get("content") else {
                return message.clone();
            };
            let mut changed = false;
            let sanitized: Vec<Value> = blocks
                .iter()
                .map(|block| {
                    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                        return block.clone();
                    }
                    if matches!(block.get("input"), Some(Value::Object(_))) {
                        return block.clone();
                    }
                    changed = true;
                    let mut map = block.as_object().cloned().unwrap_or_default();
                    map.insert(
                        "input".to_string(),
                        normalize_tool_input(block.get("input").unwrap_or(&Value::Null)),
                    );
                    Value::Object(map)
                })
                .collect();
            if changed {
                let mut map = message.as_object().cloned().unwrap_or_default();
                map.insert("content".to_string(), Value::Array(sanitized));
                Value::Object(map)
            } else {
                message.clone()
            }
        })
        .collect()
}

/// JS `\w`（正则）：ASCII 字母 / 数字 / 下划线。
fn is_word_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// JS 正则 `[a-zA-Z_]`：标识符首字符。
fn is_ident_start(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

/// JS 正则 `\b`：位置 `index` 处是否为单词边界（前后「是否单词字符」不同）。
fn is_word_boundary(characters: &[char], index: usize) -> bool {
    let before = index
        .checked_sub(1)
        .and_then(|position| characters.get(position))
        .map(|character| is_word_char(*character))
        .unwrap_or(false);
    let after = characters
        .get(index)
        .map(|character| is_word_char(*character))
        .unwrap_or(false);
    before != after
}

/// 在 `characters[start]` 处尝试匹配 `(['"])?\b?([a-zA-Z_]\w*)\b?(['"])?\s*:`，
/// 命中返回 `(冒号之后的下标, key)`。
///
/// `require_word_boundary` 对应两个 JS 正则的唯一差异：数组分支的 key 补引号带 `\b`
/// （`(['"])?\b([a-zA-Z_]\w*)\b(['"])?\s*:`），对象分支不带
/// （`(['"])?([a-zA-Z_]\w*)(['"])?\s*:`）。
fn match_quoted_key(
    characters: &[char],
    start: usize,
    require_word_boundary: bool,
) -> Option<(usize, String)> {
    let mut index = start;
    if matches!(characters.get(index), Some('\'') | Some('"')) {
        index += 1;
    }
    if require_word_boundary && !is_word_boundary(characters, index) {
        return None;
    }
    if !characters
        .get(index)
        .map(|value| is_ident_start(*value))
        .unwrap_or(false)
    {
        return None;
    }
    let key_start = index;
    while index < characters.len() && is_word_char(characters[index]) {
        index += 1;
    }
    let key: String = characters[key_start..index].iter().collect();
    if require_word_boundary && !is_word_boundary(characters, index) {
        return None;
    }
    if matches!(characters.get(index), Some('\'') | Some('"')) {
        index += 1;
    }
    while index < characters.len() && crate::util::is_js_whitespace(characters[index]) {
        index += 1;
    }
    if characters.get(index) != Some(&':') {
        return None;
    }
    Some((index + 1, key))
}

/// JS `str.replace(/(['"])?\b?([a-zA-Z_]\w*)\b?(['"])?\s*:/g, '"$2":')`：
/// 给对象的裸 key 补双引号（顺带吃掉 key 两侧的引号与冒号前的空白）。
fn quote_object_keys(text: &str, require_word_boundary: bool) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0usize;
    while index < characters.len() {
        match match_quoted_key(&characters, index, require_word_boundary) {
            Some((end, key)) => {
                out.push('"');
                out.push_str(&key);
                out.push_str("\":");
                index = end;
            }
            None => {
                out.push(characters[index]);
                index += 1;
            }
        }
    }
    out
}

/// JS `str.trim().replace(/^["']|["']$/g, '')`：去首尾空白，再去掉最外层的一对引号。
fn strip_quotes(text: &str) -> String {
    let characters: Vec<char> = crate::util::js_trim(text).chars().collect();
    let mut start = 0usize;
    let mut end = characters.len();
    if matches!(characters.first(), Some('\'') | Some('"')) {
        start += 1;
    }
    if end > start && matches!(characters.get(end - 1), Some('\'') | Some('"')) {
        end -= 1;
    }
    characters[start..end].iter().collect()
}

/// JS `String.prototype.split(/:(.+)/s)`：在第一个冒号处切开并保留冒号后的整段；
/// 冒号后没有字符时（`(.+)` 至少匹配 1 个）不切分。
fn split_capture_colon(text: &str) -> Vec<String> {
    if let Some(position) = text.find(':') {
        let rest = &text[position + ':'.len_utf8()..];
        if !rest.is_empty() {
            return vec![text[..position].to_string(), rest.to_string()];
        }
    }
    vec![text.to_string()]
}

/// JS `splitByComma`：按逗号切分，忽略引号内与括号内的逗号；
/// 逗号处**无条件**压入（可能是空串），结尾只有非空残余才压入。
fn split_by_comma(text: &str) -> Vec<String> {
    let characters: Vec<char> = text.chars().collect();
    let mut result: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = '\0';
    let mut depth: i64 = 0;
    for (index, character) in characters.iter().enumerate() {
        if *character == '"' || *character == '\'' {
            if !in_quote {
                in_quote = true;
                quote_char = *character;
                current.push(*character);
            } else if *character == quote_char && (index == 0 || characters[index - 1] != '\\') {
                in_quote = false;
                current.push(*character);
            } else {
                current.push(*character);
            }
        } else if *character == '{' || *character == '[' {
            depth += 1;
            current.push(*character);
        } else if *character == '}' || *character == ']' {
            depth -= 1;
            current.push(*character);
        } else if *character == ',' && !in_quote && depth == 0 {
            result.push(crate::util::js_trim(&current).to_string());
            current.clear();
        } else {
            current.push(*character);
        }
    }
    let tail = crate::util::js_trim(&current);
    if !tail.is_empty() {
        result.push(tail.to_string());
    }
    result
}

/// JS `/^\s*['"]?\w+['"]?\s*:/`：判断一项是否形如 `key: ...`。
fn is_key_value_item(item: &str) -> bool {
    let characters: Vec<char> = item.chars().collect();
    let mut index = 0usize;
    while index < characters.len() && crate::util::is_js_whitespace(characters[index]) {
        index += 1;
    }
    if matches!(characters.get(index), Some('\'') | Some('"')) {
        index += 1;
    }
    let start = index;
    while index < characters.len() && is_word_char(characters[index]) {
        index += 1;
    }
    if index == start {
        return false;
    }
    if matches!(characters.get(index), Some('\'') | Some('"')) {
        index += 1;
    }
    while index < characters.len() && crate::util::is_js_whitespace(characters[index]) {
        index += 1;
    }
    characters.get(index) == Some(&':')
}

/// 字段级修复（对齐 `RunTools.tryFixStringValue`）：
/// 1. 是合法 JSON 且解出对象 / 数组 → 直接用解出的值；
/// 2. 形似数组 / 对象但 JSON 畸形 → 补引号 / 单引号转双引号 / 按逗号拆分抢救；
/// 3. 其余情况原样返回。
fn try_fix_string_value(value: &Value) -> Value {
    let Value::String(text) = value else {
        return value.clone();
    };

    // 标准情况：字符串被额外序列化了一层
    if let Ok(parsed) = serde_json::from_str::<Value>(text) {
        if parsed.is_array() || parsed.is_object() {
            return parsed;
        }
        // 解析后仍是基本类型（string / number），说明它本身就是普通字符串
        return value.clone();
    }

    let trimmed = crate::util::js_trim(text);
    let characters: Vec<char> = trimmed.chars().collect();

    // 情况 1：看起来像数组但不是合法 JSON（key 缺引号 / 单引号 / 逗号分隔的裸串）
    if characters.first() == Some(&'[') && characters.last() == Some(&']') {
        // 先补 key 引号并转换单引号，尝试修成合法 JSON
        let fixed = quote_object_keys(trimmed, true).replace('\'', "\"");
        if let Ok(parsed) = serde_json::from_str::<Value>(&fixed) {
            if parsed.is_array() {
                return parsed;
            }
        }

        // 取出方括号内容，按逗号拆分
        let inner: String = characters
            .iter()
            .skip(1)
            .take(characters.len().saturating_sub(2))
            .collect();
        let inner = crate::util::js_trim(&inner);
        if !inner.is_empty() {
            let items = split_by_comma(inner);
            if !items.is_empty() {
                // 所有项都是 `key: value` 格式 → 转成对象数组
                if items.iter().all(|item| is_key_value_item(item)) {
                    let mapped: Vec<Value> = items
                        .iter()
                        .map(|item| {
                            let cleaned = strip_quotes(crate::util::js_trim(item));
                            // 对齐 JS：`cleaned.split(/:(.+)/s).map(s => s.trim().replace(/^["']|["']$/g, ''))`
                            let parts: Vec<String> = split_capture_colon(&cleaned)
                                .iter()
                                .map(|part| strip_quotes(part))
                                .collect();
                            if parts.len() >= 2 {
                                let mut object = Map::new();
                                object.insert(parts[0].clone(), Value::String(parts[1].clone()));
                                Value::Object(object)
                            } else {
                                Value::String(cleaned)
                            }
                        })
                        .collect();
                    return Value::Array(mapped);
                }
                // 否则当成字符串数组
                return Value::Array(
                    items
                        .iter()
                        .map(|item| Value::String(strip_quotes(crate::util::js_trim(item))))
                        .collect(),
                );
            }
        }
        return value.clone();
    }

    // 情况 2：看起来像对象但不是合法 JSON（例如 key 没加引号）
    if characters.first() == Some(&'{') && characters.last() == Some(&'}') {
        let fixed = quote_object_keys(trimmed, false);
        if let Ok(parsed) = serde_json::from_str::<Value>(&fixed) {
            return parsed;
        }
        return value.clone();
    }

    value.clone()
}

/// 字段级入参修复（对齐 `RunTools.fixToolInput`）：解包 double-encode 的入参，
/// 并抢救字段值里畸形的 JSON 字符串。返回 `None` 表示无需修复。
fn fix_tool_input(input: &Value) -> Option<Value> {
    match input {
        // 顶层是 JSON 字符串：解包成对象 / 数组（`tryParseJsonString` = `unwrapToolInput`）
        Value::String(_) => {
            let unwrapped = unwrap_tool_input(input.clone());
            if unwrapped.is_object() || unwrapped.is_array() {
                Some(unwrapped)
            } else {
                None
            }
        }
        // `Object.entries` 对数组会展开成下标键：命中修复时返回对象（对齐 JS）
        Value::Array(items) => {
            let mut fixed = Map::new();
            let mut changed = false;
            for (index, value) in items.iter().enumerate() {
                let next = try_fix_string_value(value);
                if &next != value {
                    changed = true;
                }
                fixed.insert(index.to_string(), next);
            }
            if changed {
                Some(Value::Object(fixed))
            } else {
                None
            }
        }
        Value::Object(object) => {
            let mut fixed = Map::new();
            let mut changed = false;
            for (key, value) in object {
                let next = try_fix_string_value(value);
                if &next != value {
                    changed = true;
                }
                fixed.insert(key.clone(), next);
            }
            if changed {
                Some(Value::Object(fixed))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn tool_use_block(id: &str, name: &str, json_text: &str, initial_input: &Value) -> Value {
    // 有 `input_json_delta` 时解析累积 JSON，
    // 解析失败或没有增量时保留 `content_block_start` 的初始 input。
    let input = if json_text.is_empty() {
        initial_input.clone()
    } else {
        match serde_json::from_str::<Value>(json_text) {
            Ok(parsed) => {
                // Provider 偶尔把整个入参再 JSON.stringify 一次（double-encode），
                // LLM 适配层统一用 `unwrapToolInput` 解包。
                unwrap_tool_input(parsed)
            }
            Err(_) => initial_input.clone(),
        }
    };
    json!({ "type": "tool_use", "id": id, "name": name, "input": input })
}

fn build_user_message(payload: &Value) -> Value {
    let content = payload
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let uuid = payload
        .get("uuid")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .unwrap_or_else(|| util::unique_id("user"));
    let mut message = Map::new();
    message.insert("type".to_string(), json!("user"));
    message.insert("message".to_string(), json!({ "role": "user", "content": content }));
    message.insert("uuid".to_string(), json!(uuid));
    message.insert("timestamp".to_string(), json!(util::now_millis()));
    message.insert("_userInitiated".to_string(), json!(true));
    // 命令消息由宿主延迟回显（`deferEcho`）：真正进入上下文时由
    // `emit_user_message_to_ui` 补发用户气泡；内置命令就地执行、该消息被丢弃，
    // 因此不会补发。标记只服务这一次补发，落盘前必须摘掉。
    if payload.get("deferEcho").and_then(Value::as_bool) == Some(true) {
        message.insert("_needsUINotification".to_string(), json!(true));
    }

    // filePath / selectedLines 都按 JS 真值判定：
    // 空串 filePath 不落盘（也不进 `_meta`）。
    let file_path_value = payload.get("filePath");
    let file_path = file_path_value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let selected_lines = payload.get("fileSelectedLines").filter(|value| !value.is_null());
    if history::js_truthy(file_path_value) {
        if let Some(value) = file_path_value {
            message.insert("filePath".to_string(), value.clone());
        }
    }
    if history::js_truthy(selected_lines) {
        if let Some(value) = selected_lines {
            message.insert("fileSelectedLines".to_string(), value.clone());
        }
    }
    // fileHidden 只在 true 时落盘
    if payload.get("fileHidden").and_then(Value::as_bool) == Some(true) {
        message.insert("fileHidden".to_string(), json!(true));
    }

    // 落盘格式：文件信息同时写入顶层字段与 `_meta`（含展示用的 `param`），
    // 保证历史加载 / 压缩能还原文件标签。
    let mut persist_meta = Map::new();
    if let Some(path) = file_path {
        let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let range = selected_lines
            .and_then(|lines| {
                let start = lines.get("start").and_then(Value::as_u64)?;
                let end = lines.get("end").and_then(Value::as_u64);
                Some(match end {
                    Some(end) if end != start => format!(":{start}~{end}"),
                    _ => format!(":{start}"),
                })
            })
            .unwrap_or_default();
        persist_meta.insert("filePath".to_string(), json!(path));
        persist_meta.insert("param".to_string(), json!(format!("{file_name}{range}")));
    }
    if let Some(lines) = selected_lines {
        persist_meta.insert("fileSelectedLines".to_string(), lines.clone());
    }
    if !persist_meta.is_empty() {
        message.insert("_meta".to_string(), Value::Object(persist_meta));
    }

    if let Some(images) = payload.get("images").and_then(Value::as_array) {
        let blocks: Vec<Value> = images
            .iter()
            .filter_map(|image| {
                // images 按真值过滤（`img && img.dataUrl`）：
                // 空串 dataUrl 是假值，直接丢弃（否则会产出一个空的 image block 被 API 拒绝）。
                let data_url = image
                    .get("dataUrl")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())?;
                let (url_media_type, data) = split_data_url(data_url);
                // 显式 mediaType 优先于 dataUrl 前缀
                let media_type = image
                    .get("mediaType")
                    .and_then(Value::as_str)
                    .unwrap_or(&url_media_type)
                    .to_string();
                Some(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": media_type, "data": data },
                }))
            })
            .collect();
        if !blocks.is_empty() {
            // 文本为空时不插入空 text 块
            let mut content_blocks: Vec<Value> = Vec::new();
            if !content.is_empty() {
                content_blocks.push(json!({ "type": "text", "text": content }));
            }
            content_blocks.extend(blocks);
            message.insert(
                "message".to_string(),
                json!({ "role": "user", "content": content_blocks }),
            );
        }
    }
    Value::Object(message)
}

/// 命令消息真正进入上下文时补发用户气泡。
///
/// 宿主对 `/` 开头的命令消息不做乐观回显（`deferEcho`）：内置命令就地执行、该消息被
/// 丢弃，不会走到这里；Skill 命令进入上下文，由调用方在摘掉 `_needsUINotification`
/// 后调用本函数补发 `message` 事件让气泡出现。普通消息由宿主立即回显、不带该标记，
/// 调用方不会调用本函数。
///
/// 落盘 / 进上下文前调用方必须先摘掉 `_needsUINotification`，避免该 UI 专用标记写进 JSONL。
fn emit_user_message_to_ui(core: &Arc<Core>, session_id: &str, message: &Value) {
    let Some(object) = message.as_object() else {
        return;
    };

    // 文件信息按 `fileHidden` 决定是否展示
    let file_hidden = object.get("fileHidden").and_then(Value::as_bool) == Some(true);
    let file_path = if file_hidden {
        None
    } else {
        object.get("filePath").and_then(Value::as_str).map(str::to_string)
    };
    let selected_lines = if file_hidden {
        None
    } else {
        object.get("fileSelectedLines").cloned()
    };

    // 展示用 `param`：`<文件名>:<start>[~<end>]`（对齐 `notifyUserMessageToUI`）
    let param = file_path.as_ref().map(|path| {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let Some(lines) = selected_lines.as_ref() else {
            return name.to_string();
        };
        let start = lines.get("start").and_then(Value::as_u64);
        let end = lines.get("end").and_then(Value::as_u64);
        match (start, end) {
            (Some(start), Some(end)) if start != end => format!("{name}:{start}~{end}"),
            (Some(start), _) => format!("{name}:{start}"),
            _ => name.to_string(),
        }
    });

    // content 可能是字符串，也可能是 text / image block 数组
    let content = object.get("message").and_then(|inner| inner.get("content"));
    let (text, images) = crate::replay::extract_user_content(content);

    let mut data = Map::new();
    data.insert("role".to_string(), json!("user"));
    data.insert(
        "messageUuid".to_string(),
        object.get("uuid").cloned().unwrap_or(Value::Null),
    );
    data.insert("content".to_string(), json!(text));
    if !images.is_empty() {
        data.insert("images".to_string(), Value::Array(images));
    }
    if let Some(param) = &param {
        data.insert("param".to_string(), json!(param));
    }
    if let Some(path) = &file_path {
        data.insert("filePath".to_string(), json!(path));
    }
    if let Some(lines) = &selected_lines {
        data.insert("fileSelectedLines".to_string(), lines.clone());
    }
    // `meta` 与宿主乐观回显同形（`{ filePath, param, fileSelectedLines }`）
    let mut meta = Map::new();
    if let Some(path) = &file_path {
        meta.insert("filePath".to_string(), json!(path));
        if let Some(param) = &param {
            meta.insert("param".to_string(), json!(param));
        }
    }
    if let Some(lines) = &selected_lines {
        meta.insert("fileSelectedLines".to_string(), lines.clone());
    }
    if !meta.is_empty() {
        data.insert("meta".to_string(), Value::Object(meta));
    }

    core.emit(json!({
        "type": "message",
        "sessionId": session_id,
        "data": Value::Object(data),
    }));
}

/// 解析 data URL（对齐 `src/core/utils/contentBlocks.ts` 的 `parseDataUrl`）：
/// 只接受 `^data:([^;,]+);base64,(.*)$`（media type 非空且不含 `;`/`,`，
/// 紧跟 `;base64,`）。不匹配时视为纯 base64，media type 兜底 `image/png`。
fn split_data_url(data_url: &str) -> (String, String) {
    if let Some(rest) = data_url.strip_prefix("data:") {
        let mut media_end = 0usize;
        for (index, ch) in rest.char_indices() {
            if ch == ';' || ch == ',' {
                break;
            }
            media_end = index + ch.len_utf8();
        }
        if media_end > 0 && rest[media_end..].starts_with(";base64,") {
            let media_type = rest[..media_end].to_string();
            let data = rest[media_end + ";base64,".len()..].to_string();
            return (media_type, data);
        }
    }
    ("image/png".to_string(), data_url.to_string())
}

fn build_assistant_message(
    text: &str,
    thinking: &str,
    thinking_signature: &str,
    tool_uses: &[Value],
    stop_reason: &str,
    usage: &llm::Usage,
) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    if !thinking.is_empty() {
        // Anthropic 要求历史 thinking block 原样带回 signature
        if thinking_signature.is_empty() {
            blocks.push(json!({ "type": "thinking", "thinking": thinking }));
        } else {
            blocks.push(json!({
                "type": "thinking",
                "thinking": thinking,
                "signature": thinking_signature,
            }));
        }
    }
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    let now = util::now_millis();
    for tool_use in tool_uses {
        let mut block = tool_use.clone();
        // tool_use block 顶层记录 AI 发出调用的时间戳
        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
            let mut meta = block
                .get("_meta")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            meta.insert("toolCallTimestamp".to_string(), json!(now));
            block["_meta"] = Value::Object(meta);
        }
        blocks.push(block);
    }

    let mut message = Map::new();
    message.insert("role".to_string(), json!("assistant"));
    message.insert("content".to_string(), Value::Array(blocks));
    if !stop_reason.is_empty() {
        message.insert("stop_reason".to_string(), json!(stop_reason));
    }
    // usage 恒存在（流结束时有 `{0,0,0,0}` 兜底），因此恒写 usage。
    message.insert("usage".to_string(), usage.message_usage());
    json!({
        "type": "assistant",
        "message": Value::Object(message),
        "uuid": util::unique_id("assistant"),
        "timestamp": now,
    })
}

fn message_text(message: &Value) -> String {
    match message.get("message").and_then(|inner| inner.get("content")) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// content block 上「只服务 UI / 内部流程、不参与 LLM 请求」的字段
/// （对齐 `src/core/Query.ts` 的 `NON_LLM_BLOCK_FIELDS`）。
///
/// `_meta` / `_partialJson` 是 UI 历史恢复与流式累积字段；`beforeContent` 等是
/// Edit / Write 的 diff 展示字段，`beforeContent` 可能是**整份文件内容**，
/// 留在请求里会把上下文撑大若干倍。只在请求载荷里剔除，落盘消息保持原样。
const NON_LLM_BLOCK_FIELDS: [&str; 6] = [
    "_meta",
    "_partialJson",
    "beforeContent",
    "afterContent",
    "contextBefore",
    "contextAfter",
];

/// 剔除 block 上的 UI 专用字段；没有可剔除字段时原样返回（对齐 `stripNonLlmBlockFields`）
fn strip_non_llm_block_fields(block: &Value) -> Value {
    let Some(object) = block.as_object() else {
        return block.clone();
    };
    if !NON_LLM_BLOCK_FIELDS
        .iter()
        .any(|key| object.contains_key(*key))
    {
        return block.clone();
    }
    let mut clean = object.clone();
    for key in NON_LLM_BLOCK_FIELDS {
        clean.remove(key);
    }
    Value::Object(clean)
}

/// 内部消息 → API 请求载荷（对齐 `buildRawApiMessages`）。
///
/// - 只保留 `user` / `assistant` 类型；
/// - 字符串 content 且带文件上下文时补 `[Current File: ...]` 前缀；
/// - 数组 content 剔除 block 上的 UI 专用字段。
fn build_raw_api_messages(messages: &[Value]) -> Vec<Value> {
    let mut raw: Vec<Value> = Vec::new();
    for message in messages {
        let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let Some(content) = message.get("message").and_then(|inner| inner.get("content")) else {
            continue;
        };
        let role = if kind == "user" { "user" } else { "assistant" };

        let formatted = match content {
            Value::String(text) => {
                let mut text = text.clone();
                // `filePath` 为**真值**（非空串）才补前缀
                let file_path = message
                    .get("filePath")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty());
                let file_hidden = message.get("fileHidden").and_then(Value::as_bool) == Some(true);
                if kind == "user"
                    && file_path.is_some()
                    && !file_hidden
                    && !text.starts_with("[Current File:")
                {
                    let file_path = file_path.unwrap_or_default();
                    let mut info = format!("[Current File: {file_path}");
                    let selected = message.get("fileSelectedLines");
                    let start = selected
                        .and_then(|value| value.get("start"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let end = selected
                        .and_then(|value| value.get("end"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    if start > 0 && end > 0 {
                        if start == end {
                            info.push_str(&format!(" (line {start})]"));
                        } else {
                            info.push_str(&format!(" (lines {start}-{end})]"));
                        }
                    } else {
                        info.push(']');
                    }
                    text = format!("{info}\n\n{text}");
                }
                Value::String(text)
            }
            Value::Array(blocks) => {
                Value::Array(blocks.iter().map(strip_non_llm_block_fields).collect())
            }
            other => Value::String(util::js_string(other)),
        };

        raw.push(json!({ "role": role, "content": formatted }));
    }
    raw
}

/// 为 content 为数组但缺少 thinking block 的 assistant 消息补空 thinking
/// （对齐 `ensureThinkingBlocks`）。
///
/// 原因：thinking 模式下历史 assistant 消息必须带 `type=thinking` 的 block，
/// 否则「工具执行中途把 thinking 从 off 切成 max」会导致 API 报错
/// `The content[].thinking in the thinking mode must be passed back to the API.`。
/// 因此不管当前是否开启 thinking，统一补一个空 thinking block。
fn ensure_thinking_blocks(messages: &mut [Value]) {
    for message in messages.iter_mut() {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = message.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        let has_thinking = blocks
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("thinking"));
        if !has_thinking {
            blocks.insert(0, json!({ "type": "thinking", "thinking": "" }));
        }
    }
}

/// 合并连续同角色消息（对齐 `mergeConsecutiveSameRole`）。
///
/// Anthropic 要求严格的 user/assistant 交替：每个 `tool_use` block 必须在紧邻的
/// 下一条消息里有对应的 `tool_result`。不合并时，多条各自带一个 tool_result 的
/// user 消息会违反该要求。
fn merge_consecutive_same_role(raw: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    for message in raw {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let same_role = merged
            .last()
            .and_then(|last| last.get("role").and_then(Value::as_str))
            .map(|last_role| last_role == role)
            .unwrap_or(false);
        if !same_role {
            merged.push(message);
            continue;
        }
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        let last = merged.last_mut().expect("merged 非空");
        let previous = last.get("content").cloned().unwrap_or(Value::Null);
        let mut blocks = to_content_blocks(&previous);
        blocks.extend(to_content_blocks(&content));
        last["content"] = Value::Array(blocks);
    }
    merged
}

/// 把字符串 content 包装成 `[{type:"text", text}]`，数组原样返回
/// （对齐 `mergeConsecutiveSameRole` 里对字符串 content 的包装）
fn to_content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Array(blocks) => blocks.clone(),
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        other => vec![json!({ "type": "text", "text": other.to_string() })],
    }
}

/// 从一行里取出围栏语言（对齐 `collectFenceLanguages` 的正则
/// `(?:^|\n)[ \t]*(?:```|~~~)[ \t]*([A-Za-z0-9_+#-]+)`）：
/// 行首（可带缩进）是 ``` 或 ~~~，其后（可带空格/制表符）是语言标识符。
fn fence_language_of_line(line: &str) -> Option<String> {
    let trimmed = line.trim_start_matches([' ', '\t']);
    let rest = trimmed
        .strip_prefix("```")
        .or_else(|| trimmed.strip_prefix("~~~"))?;
    let rest = rest.trim_start_matches([' ', '\t']);
    let language: String = rest
        .chars()
        .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '+' | '#' | '-'))
        .collect();
    // 只接受 1..=32 个字符的语言标识符
    if language.is_empty() || language.chars().count() > 32 {
        None
    } else {
        Some(language)
    }
}

/// 扫描一条消息里的围栏代码块语言（去重，保持出现顺序）。
///
/// 对齐 `collectFenceLanguages`：只扫 user / assistant 消息的字符串 content，
/// 数组 content 则看 text / thinking / tool_result 三类 block。
fn collect_fence_languages(message: &Value) -> Vec<String> {
    let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
    if kind != "user" && kind != "assistant" {
        return Vec::new();
    }
    let Some(content) = message.get("message").and_then(|inner| inner.get("content")) else {
        return Vec::new();
    };

    let mut languages: Vec<String> = Vec::new();
    let mut scan = |text: &str| {
        for line in text.split('\n') {
            if let Some(language) = fence_language_of_line(line) {
                if !languages.contains(&language) {
                    languages.push(language);
                }
            }
        }
    };

    match content {
        Value::String(text) => scan(text),
        Value::Array(blocks) => {
            for block in blocks {
                let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            scan(text);
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                            scan(text);
                        }
                    }
                    "tool_result" => {
                        if let Some(text) = block.get("content").and_then(Value::as_str) {
                            scan(text);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    languages
}

/// 消息落盘后上报「新出现的围栏代码块语言」（对齐 `Conversation.appendMessage`）。
///
/// 只上报 `settings.json` 的 `highlightLanguages` 里尚未记录过的语言，
fn emit_highlight_languages(core: &Arc<Core>, message: &Value) {
    let languages = collect_fence_languages(message);
    if languages.is_empty() {
        return;
    }
    // core 只上报「本条消息用到了哪些语言」，不维护「已记录」集合：`highlightLanguages`
    // 是 UI 专属字段，去重与落盘由宿主的 `highlightLanguagesMutator` 承担，因此同一门
    // 语言可能被重复上报，宿主按幂等处理（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
    core.emit(json!({ "type": "highlightLanguagesUsed", "languages": languages }));
}

/// 本次请求可用的 max output（对齐 `getAvailableOutputTokens` + `Query.ts` 的 min 口径）。
///
///   `available = Math.max(1, Math.min(getMaxOutputTokens(model), contextWindow - current))`
///   `configured = baseModelConfig.maxTokens > 0 ? baseModelConfig.maxTokens : available`
///   `maxTokens  = Math.min(configured, available)`
/// `configured_max_tokens` 是 provider 解析后的 `max_tokens`（已按 `llm.maxTokens` 与
/// 注册表 / 环境变量的输出上限收敛），因此结果等价于
/// `max(1, min(configured_max_tokens, contextWindow - current))`。
fn available_output_tokens(
    context_window: u64,
    configured_max_tokens: u64,
    current_context_tokens: u64,
) -> u32 {
    context_window
        .saturating_sub(current_context_tokens)
        .min(configured_max_tokens)
        .max(1)
        .min(u32::MAX as u64) as u32
}

/// 当前上下文占用的「精确」token 数（对齐 `Query.ts` 的 `exactTokenCount`）。
///
/// 取最近一条带 `usage` 的 assistant 消息的 `input_tokens + output_tokens`
/// （判定口径：`usage.input_tokens > 0 && usage.output_tokens !== undefined`，
/// 从后往前找第一条命中的）；内存里找不到时回退 `meta.json` 的
/// `context.totalContextTokens`（> 0 才算），两者都没有返回 `None`。
fn exact_context_tokens(
    state: &Arc<Mutex<SessionState>>,
    session_id: &str,
    project: &str,
) -> Option<u64> {
    let from_messages = {
        let state = state.lock().unwrap();
        state.messages.iter().rev().find_map(|message| {
            if message.get("type").and_then(Value::as_str) != Some("assistant") {
                return None;
            }
            let usage = message.get("message").and_then(|inner| inner.get("usage"))?;
            let input = usage.get("input_tokens").and_then(Value::as_u64)?;
            if input == 0 {
                return None;
            }
            let output = usage.get("output_tokens").and_then(Value::as_u64)?;
            Some(input + output)
        })
    };
    from_messages.or_else(|| {
        history::load_metadata(session_id, project)
            .and_then(|metadata| {
                metadata
                    .get("context")
                    .and_then(|context| context.get("totalContextTokens"))
                    .and_then(Value::as_u64)
            })
            .filter(|value| *value > 0)
    })
}

/// 内部消息 → LLM 消息（Anthropic 风格：`{role, content}`）
fn build_llm_messages(state: &Arc<Mutex<SessionState>>) -> Vec<Value> {
    let messages = {
        let state = state.lock().unwrap();
        state.messages.clone()
    };
    let mut raw = build_raw_api_messages(&messages);
    ensure_thinking_blocks(&mut raw);
    merge_consecutive_same_role(raw)
}

/// 首条用户消息落盘后生成标题。
///
/// 会话文件（`meta.json`）也在这里按需创建：`meta.json` 只在第一条消息持久化时创建，
/// 未发消息的会话不落盘（`conversationStarted` 不再预先建档）。
/// 文本取不到时兜底 `New Conversation`。
fn update_title_if_needed(core: &Arc<Core>, session_id: &str, project: &str) {
    let metadata = history::load_metadata(session_id, project);
    let meta_missing = metadata.is_none();
    // 对齐 `updateMetadataForNewMessage`：`prevMessageCount` 取自 meta.json 的
    // messageCount（缺省 0）；清空过的会话保留原标题。
    let prev_count = metadata
        .as_ref()
        .and_then(|value| value.get("messageCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cleared = metadata
        .as_ref()
        .map(|value| value.get("clearedAt").is_some())
        .unwrap_or(false);
    // 已有显式标题（用户重命名 / 智能命名 / spin 改名先落了标题）时首条消息不覆盖。
    let has_title = metadata
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    // 只有「meta 缺失」或「未清空且此前没有消息且尚无标题」才用首条用户消息生成标题；
    // 否则（已有消息 / 已显式命名的会话）保持现有标题，改名 / 首条标题不被后续消息覆盖。
    if !meta_missing && (cleared || prev_count > 0 || has_title) {
        return;
    }

    let (messages, session_model, session_provider, session_creator) = {
        let state = core.session(session_id);
        let state = state.lock().unwrap();
        (
            state.messages.clone(),
            state.model.clone(),
            state.provider.clone(),
            state.creator.clone(),
        )
    };
    // 取「刚追加的那条 message」；调用点只处理用户消息，等价于首条用户消息。
    let derived = messages
        .iter()
        .find(|message| message.get("type").and_then(Value::as_str) == Some("user"))
        .and_then(|message| history::derive_title(std::slice::from_ref(message)));

    if meta_missing {
        let title = derived.unwrap_or_else(|| "New Conversation".to_string());
        let message_count = history::count_messages(&messages);
        // 对齐 `updateMetadataForNewMessage` 的 ENOENT 分支：模型身份取**会话运行时**
        // （engine.modelRefOverride），只有非空时才写 `model` / `provider`。
        // 会话未选模型时不写该键（也不写 null），让宿主回退到活动 provider 的默认模型。
        let mut created = json!({
            "sessionId": session_id,
            "project": project,
            "title": title,
            "createdAt": util::now_millis(),
            "updatedAt": util::now_millis(),
            "messageCount": message_count,
            // 归属在创建时一次写定（specs/025 FR-002）：用户路径的会话状态默认 User
            "creator": session_creator,
        });
        if let Some(model) = session_model.filter(|value| !value.is_empty()) {
            created["model"] = json!(model);
        }
        if let Some(provider) = session_provider.filter(|value| !value.is_empty()) {
            created["provider"] = json!(provider);
        }
        let fallback = created.clone();
        // 注意：这里**不**广播 `titleChanged`：落盘只发 `conversationListChanged`
        // （宿主据此刷新列表与标题），
        // `titleChanged` 仅在 `conversationRenamed` 与 Spin 改名时发出。
        let _ = history::update_metadata(
            session_id,
            project,
            || fallback.clone(),
            |metadata| {
                metadata["title"] = json!(title);
            },
        );
    } else if let Some(title) = derived {
        // meta 已存在但还没有消息（例如宿主预建 / 新建后先改名）：
        // 首条用户消息能取到标题时覆盖（取不到则保留原标题）。
        let _ = history::update_metadata(
            session_id,
            project,
            || json!({ "sessionId": session_id, "project": project }),
            |metadata| {
                metadata["title"] = json!(title);
            },
        );
    }
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;

/// 压缩的引擎级端到端用例单独成文件（`engine_tests.rs` 已经很长）
#[cfg(test)]
#[path = "compact_engine_tests.rs"]
mod compact_engine_tests;

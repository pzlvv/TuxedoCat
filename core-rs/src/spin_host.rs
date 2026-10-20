//! `SpinHost` 的 Core 实现：把 Spin 主循环接到引擎上。
//!
//! `spin.rs` 只依赖 [`SpinHost`] 这个回调边界，不引用引擎内部类型；本模块是那条
//! 边界的具体实现，职责有三块：
//! - **子代理**：`run_sub_agent` 走 `Core::create_sub_agent` 起子会话，然后阻塞等它
//!   的 Reply 投递回父会话（对齐 `createSubAgent` + `waitForAgentReply`）；
//! - **事件**：`emit_event` 直接转发给 `Core::emit`（`spinDesignDataChanged` 等）；
//! - **进度消息**：`push_message` 把 spin 的进度写进会话上下文并落盘（对齐 TS 的
//!   `mutableMessages.push` + `appendMessage`），否则消息只到 UI、模型看不到。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine::{Core, WorkMode};
use crate::spin::{self, SpinHost, SpinJudgerResult, SpinSubAgentRequest};
use crate::{config, history, subagent, util};

/// 等待子代理 Reply 的轮询间隔（中止要能及时生效，不能一次性阻塞到天荒地老）
const REPLY_POLL_MS: u64 = 100;

pub struct CoreSpinHost {
    core: Arc<Core>,
    /// 主对话会话 id（SpinLoop 的宿主会话）
    session_id: String,
    /// 与 `SpinHandle::abort()` 共享的中止标记
    abort: Arc<AtomicBool>,
}

impl CoreSpinHost {
    pub fn new(core: Arc<Core>, session_id: impl Into<String>) -> Self {
        CoreSpinHost {
            core,
            session_id: session_id.into(),
            abort: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 与 SpinLoop 共享的中止标记
    pub fn abort_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.abort)
    }

    /// 主对话会话 id（当前无调用方，保留以对齐宿主契约）
    #[allow(dead_code)]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
}

impl SpinHost for CoreSpinHost {
    fn run_sub_agent(&self, request: SpinSubAgentRequest) -> Result<String, String> {
        // 先把「期望的子会话 id」放在共享槽里：子代理在另一个线程上跑，Reply 可能
        // 早于会话登记可查，监听器必须在起会话**之前**就注册好。
        let expected: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let expected_for_listener = Arc::clone(&expected);
        let parent = self.session_id.clone();
        let (sender, receiver) = mpsc::channel::<String>();
        let sender = Arc::new(Mutex::new(sender));
        let listener = subagent::on_reply_delivered(Arc::new(
            move |target: &str, from: &str, message: &str| {
                if target != parent {
                    return;
                }
                let matches = expected_for_listener
                    .lock()
                    .unwrap()
                    .as_deref()
                    .map(|id| id == from)
                    .unwrap_or(false);
                if matches {
                    let _ = sender.lock().unwrap().send(message.to_string());
                }
            },
        ));

        let description = spin::sub_agent_description(
            request.sequence,
            &request.iteration_label,
            &request.node.task,
        );
        // `submitToolUse({ name: 'Agent', input: { prompt, agentRole, description } })`：
        // 走完整的工具执行路径（assistant tool_use 落盘 + toolCall/toolResult 事件），
        // 父对话上能看到 Agent 卡片；webview 收到 `toolCall` 会关掉 thinking 动画。
        let input = json!({
            "prompt": request.prompt,
            "agentRole": "Master",
            "description": description,
        });
        let registered_before = subagent::list_for_creator(&self.session_id).len();
        if let Err(error) = self.core.submit_tool_use(&self.session_id, "Agent", &input) {
            subagent::off_reply_delivered(listener);
            return Err(error);
        }
        // 子代理 id 从注册表反查（对齐 `getCurrentSpinAgentId` 取最近登记的一个）。
        // 没有新增登记说明 Agent 工具没起会话（被拒绝 / 入参非法）：返回 Err 让主循环
        // 把失败当作节点反馈参与验收判定，而不是无限等 Reply。
        let registered = subagent::list_for_creator(&self.session_id);
        let sub_session_id = match registered.last() {
            Some(id) if registered.len() > registered_before => id.clone(),
            _ => {
                subagent::off_reply_delivered(listener);
                return Err("Agent tool did not spawn a sub-agent".to_string());
            }
        };
        *expected.lock().unwrap() = Some(sub_session_id.clone());
        // 登记为 spin 子代理：它的 Reply 只作节点验收结果，重复 / 迟到的 Reply
        // 由 `deliver_agent_reply` 的 spin 语义忽略，绝不拉起父对话的 LLM 循环
        // （docs/features/user-message-pipeline.md 第 3.3 节）。
        self.core
            .register_spin_sub_agent(&self.session_id, &sub_session_id);

        let result = loop {
            if self.is_aborted() {
                break Err("spin sub-agent aborted".to_string());
            }
            match receiver.recv_timeout(Duration::from_millis(REPLY_POLL_MS)) {
                Ok(message) => break Ok(message),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err("spin sub-agent reply channel closed".to_string())
                }
            }
        };
        subagent::off_reply_delivered(listener);
        result
    }

    fn emit_event(&self, event: Value) {
        self.core.emit(event);
    }

    fn is_aborted(&self) -> bool {
        if self.abort.load(Ordering::Relaxed) {
            return true;
        }
        // 用户在 UI 上按了 abort：会话的 cancel 标记同样要能停下 Spin 循环
        self.core
            .session_if_exists(&self.session_id)
            .map(|state| state.lock().unwrap().cancel.load(Ordering::Relaxed))
            .unwrap_or(true)
    }

    fn push_message(&self, session_id: &str, role: &str, content: &str) {
        let message = json!({
            "type": role,
            "uuid": util::unique_id("spin"),
            "timestamp": util::now_millis(),
            "message": { "role": role, "content": content },
        });
        let project = self.core.project_of(session_id).ok();
        if let Some(project) = &project {
            let _ = history::append_message(session_id, project, &message, None);
        }
        if let Some(state) = self.core.session_if_exists(session_id) {
            let mut state = state.lock().unwrap();
            state.messages.push(message);
            state.persisted_count = state.messages.len();
        }
        self.core.emit(json!({
            "type": "message",
            "sessionId": session_id,
            "data": { "role": role, "content": content },
        }));
        // 每落盘一条消息各发一次（对齐 `Conversation.appendMessage` 的粒度）
        self.core.emit(json!({ "type": "conversationListChanged" }));
    }

    fn judge(&self, task: &str, criteria: &[String], reply: &str) -> SpinJudgerResult {
        // 用**会话实际生效的模型**判定（父会话可能切过模型 / provider）；
        // 取不到会话级覆盖时回落到全局 active provider（与默认实现一致）。
        let (provider, model) = self
            .core
            .session_if_exists(&self.session_id)
            .map(|state| {
                let state = state.lock().unwrap();
                (state.provider.clone(), state.model.clone())
            })
            .unwrap_or((None, None));
        let resolved = config::resolve_provider(provider.as_deref(), model.as_deref())
            .or_else(|_| config::resolve_provider(None, None))
            .ok();
        spin::judge_with_provider(resolved.as_ref(), task, criteria, reply)
    }
}

/// `/spin` 非 `design` 分支：检测 `spin.json` 状态，必要时跑完整个 Spin 主循环。
///
/// - 结构有问题（`invalid` / `empty-node` / `not-dag` / `variable-no-value`）→ 发一条
///   说明消息，不执行；
/// - 没有 `spin.json`（`init`）→ 发一条「先创建设计」的消息，不执行；
/// - `ready` → 把会话标题改成「Spin 设计」，**在当前线程跑完整个循环**，收尾时发
///   `spinDesignDataChanged` 让打开着的设计器刷新（否则它的旧缓存会覆盖执行结果）。
///
/// **阻塞**是有意的：TS 侧 `await spinLoop(...)` 同样阻塞 `resolvePendingCommand`，
/// 因此整个 Spin 期间消费循环不排空队列、用户后续消息排队等待、`queryEnd` 在 Spin
/// 结束后才发出。命令执行点（消费循环线程）不持有会话锁，阻塞不会死锁。
pub fn run_spin_command(
    core: &Arc<Core>,
    session_id: &str,
    cwd: &str,
    _args: &str,
) -> Option<String> {
    let state = spin::detect_project_state(cwd);
    match state {
        spin::SpinProjectState::Ready => {}
        spin::SpinProjectState::Init => {
            emit_spin_notice(
                core,
                session_id,
                crate::core_text::SPIN_DESIGN_MISSING,
                json!({}),
                "warn",
            );
            return None;
        }
        issue => {
            let (key, params) = spin_issue_notice(cwd, &issue);
            emit_spin_notice(core, session_id, key, params, "error");
            return None;
        }
    }

    let Some(_design) = spin::read_spin_json(cwd) else {
        emit_spin_notice(
            core,
            session_id,
            crate::core_text::SPIN_CANNOT_READ,
            json!({}),
            "error",
        );
        return None;
    };

    // 标题改成「Spin Design」：写 `meta.json` 并广播 `titleChanged`（webview 靠它
    // 刷新打开中对话的标题栏；`titleChanged` 事件表的来源包含 skills/bundled/spin）。
    // 落盘文本统一英文（`docs/architecture/core-ui-separation.md` 第 4.8 节）。
    core.update_conversation_title(session_id, "Spin Design");

    let host = Arc::new(CoreSpinHost::new(Arc::clone(core), session_id));
    let abort = host.abort_flag();
    let runner: Arc<dyn SpinHost> = host;
    // spin 模式：主会话不参与 LLM 消费循环。期间投递到本会话的子代理 Reply
    // 走 `deliver_agent_reply` 的 spin 分支——只落 silent 消息进上下文，不进消费队列，
    // 消费循环也就不会在 Spin 结束后拿它跑主对话的 agent 循环。
    // 工作模式经 `set_work_mode` 唯一写入点：内存 + meta.json + `workModeChanged`
    // 广播（UI 据此禁用主输入框，specs/016 FR-004 / FR-005）。spin 单向：进入后
    // 不再写回 `Normal`，循环结束（完成 / 中止 / 失败）会话仍保持 spin。
    core.set_work_mode(session_id, WorkMode::Spin);
    // 进入 spin 前清掉排队中的自动消息与 Reminder：Spin 期间父对话只由程序驱动，
    // 这些消息若留到 Spin 结束后会被消费循环当成下一轮 LLM 输入
    // （docs/features/user-message-pipeline.md 第 3.3 节）。
    if let Some(state) = core.session_if_exists(session_id) {
        let mut state = state.lock().unwrap();
        state.agent_messages.clear();
        state.pending_reminder = None;
        state.reminder_driven_run = false;
    }
    let outcome = spin::SpinLoop::with_abort_flag(runner, cwd, session_id, abort).run();
    // 单向模式：不恢复 `Normal`（会话可能已被删除，这里也不需要 `set_work_mode`）。
    // 循环停下后会话仍是 spin，输入框保持禁用；meta.json 的 `workMode` 停在 spin。
    if let spin::SpinOutcome::Failed(message) = &outcome {
        emit_spin_message(core, session_id, message);
    }

    // 设计器可能开着：通知它磁盘上的 meta 已经变了
    core.emit(json!({ "type": "spinDesignDataChanged" }));
    None
}

/// 结构问题的文案键与参数（`variable-no-value` 带上具体变量名）
///
/// Core 只给「键 + 参数」，翻译在 UI（`docs/architecture/core-ui-separation.md` 第 4.9 节）。
fn spin_issue_notice(cwd: &str, issue: &spin::SpinProjectState) -> (&'static str, Value) {
    match issue {
        spin::SpinProjectState::EmptyNode => (crate::core_text::SPIN_EMPTY_NODE, json!({})),
        spin::SpinProjectState::NotDag => (crate::core_text::SPIN_NOT_DAG, json!({})),
        spin::SpinProjectState::VariableNoValue => {
            let names = spin::read_spin_json(cwd)
                .map(|config| spin::get_variables_without_value(&config))
                .unwrap_or_default();
            if names.is_empty() {
                (crate::core_text::SPIN_VARIABLE_NO_VALUE, json!({}))
            } else {
                (
                    crate::core_text::SPIN_VARIABLE_NO_VALUE_WITH_NAMES,
                    json!({ "names": names.join(", ") }),
                )
            }
        }
        _ => (crate::core_text::SPIN_INVALID, json!({})),
    }
}

/// 发一条瞬时提示（键 + 参数，`docs/architecture/core-ui-separation.md` 第 4.9 节）
fn emit_spin_notice(core: &Arc<Core>, session_id: &str, key: &str, params: Value, level: &str) {
    core.emit(json!({
        "type": "notice",
        "sessionId": session_id,
        "key": key,
        "params": params,
        "level": level,
    }));
}

/// 发一条 role=user 的会话消息（对齐 TS 里 `emitToUi({type:'message', data:{role:'user'}})`）
fn emit_spin_message(core: &Arc<Core>, session_id: &str, content: &str) {
    core.emit(json!({
        "type": "message",
        "sessionId": session_id,
        "data": { "role": "user", "content": content },
    }));
}

#[cfg(test)]
#[path = "spin_host_tests.rs"]
mod tests;

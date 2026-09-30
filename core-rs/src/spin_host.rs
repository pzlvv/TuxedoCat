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

use crate::engine::Core;
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
        // 早于 create_sub_agent 返回，监听器必须在起会话**之前**就注册好。
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
        let spawn_result = self.core.create_sub_agent(crate::tools::SubAgentRequest {
            creator_session_id: self.session_id.clone(),
            prompt: request.prompt.clone(),
            description,
            // Spin Design 的节点统一用 Master 角色（完整工具集），对齐 `Runner.ts`
            role: "Master".to_string(),
        });
        let sub_session_id = match spawn_result {
            Ok(id) => id,
            Err(err) => {
                subagent::off_reply_delivered(listener);
                return Err(err);
            }
        };
        *expected.lock().unwrap() = Some(sub_session_id.clone());

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
/// 对齐 Embedded `bundled/spin.ts`：
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
            emit_spin_message(
                core,
                session_id,
                &crate::i18n::tt(
                    "未找到 spin.json 设计文件，请先创建并保存 Spin 设计。",
                    "spin.json design file not found, please create and save a Spin design first.",
                ),
            );
            return None;
        }
        issue => {
            let message = spin_issue_message(cwd, &issue);
            emit_spin_message(core, session_id, &message);
            return None;
        }
    }

    let Some(_design) = spin::read_spin_json(cwd) else {
        emit_spin_message(
            core,
            session_id,
            &crate::i18n::tt("无法读取 spin.json。", "Cannot read spin.json."),
        );
        return None;
    };

    // 标题改成「Spin 设计」（对齐 TS 的 `updateConversationMetadataTitle` + titleChanged）
    let title = crate::i18n::tt("Spin 设计", "Spin Design");
    core.on_conversation_renamed(session_id, &title);

    let host = Arc::new(CoreSpinHost::new(Arc::clone(core), session_id));
    let abort = host.abort_flag();
    let runner: Arc<dyn SpinHost> = host;
    let outcome = spin::SpinLoop::with_abort_flag(runner, cwd, session_id, abort).run();
    if let spin::SpinOutcome::Failed(message) = &outcome {
        emit_spin_message(core, session_id, message);
    }

    // 设计器可能开着：通知它磁盘上的 meta 已经变了
    core.emit(json!({ "type": "spinDesignDataChanged" }));
    None
}

/// 结构问题的用户可读文案（`variable-no-value` 带上具体变量名）
fn spin_issue_message(cwd: &str, issue: &spin::SpinProjectState) -> String {
    match issue {
        spin::SpinProjectState::EmptyNode => crate::i18n::tt(
            "存在空节点（缺少任务描述），请完善节点后重试。",
            "There are empty nodes (missing task descriptions), please complete them and retry.",
        ),
        spin::SpinProjectState::NotDag => crate::i18n::tt(
            "流程图不是有效的无环有向图（DAG），请检查连线后重试。",
            "The flow is not a valid directed acyclic graph (DAG), please check the edges and retry.",
        ),
        spin::SpinProjectState::VariableNoValue => {
            let names = spin::read_spin_json(cwd)
                .map(|config| spin::get_variables_without_value(&config))
                .unwrap_or_default();
            if names.is_empty() {
                crate::i18n::tt(
                    "存在未赋值的变量，请在 Spin 设计器中填写变量值后重试。",
                    "There are variables without a value, please fill in their values in the Spin Designer and retry.",
                )
            } else {
                let joined = names.join(", ");
                crate::i18n::tt(
                    &format!("存在未赋值的变量（{joined}），请在 Spin 设计器中填写变量值后重试。"),
                    &format!(
                        "Variables without a value ({joined}), please fill in their values in the Spin Designer and retry."
                    ),
                )
            }
        }
        _ => crate::i18n::tt(
            "spin.json 格式不合法，请检查文件内容。",
            "spin.json is invalid, please check the file content.",
        ),
    }
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

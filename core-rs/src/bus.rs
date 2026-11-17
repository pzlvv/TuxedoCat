//! Core 侧的帧总线（见 docs/core/standalone-core.md 第 5、6、7 节）。
//!
//! 职责：帧写出、`CoreEvent` 上报、`CoreRequest` 发起与应答匹配、`UiEvent` 分发。
//! 写出目标泛型化，便于测试捕获帧内容。
//!
//! 线程模型：总线由 `Arc<Mutex<CoreBus<Stdout>>>` 共享；查询线程通过
//! `request()` 拿到应答通道并阻塞等待，主线程在收到 `response` 帧时投递结果。

use std::collections::HashMap;
use std::io::Write;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use serde_json::{json, Value};

use crate::frame::CoreToUiFrame;

/// 帧写出口。发布构建用 `std::io::stdout()`，测试用可捕获的共享缓冲。
pub type FrameWriter = Box<dyn Write + Send>;

/// 一条已发出、尚未收到应答的请求的元数据。
///
/// `session_id` / `choice_request_id` 只在对应用途上有值（`userChoice` 两者都有，
/// `crossWorkspaceAgentRequested` 只有 `session_id`）：中止某一会话的在途请求时按它们
/// 精确挑选，而不是「把所有 pending 都清掉」。
pub struct PendingRequest {
    /// `request.type`，用于超时诊断（`request 502 timed out`）
    pub request_type: String,
    /// 请求载荷里的 `sessionId`（该字段缺失时为 `None`）
    pub session_id: Option<String>,
    /// `CoreRequest.userChoice` 的请求标识（specs/050 FR-001）；其它请求类型为 `None`
    pub choice_request_id: Option<String>,
}

pub struct CoreBus<W: Write> {
    out: W,
    next_request_id: u64,
    /// 已发出、尚未收到应答的请求：id → (请求元数据, 应答通道)
    pending: HashMap<u64, (PendingRequest, Sender<Value>)>,
    /// 收到的 UiEvent 计数（按类型）
    ui_event_counts: HashMap<String, u64>,
}

impl<W: Write> CoreBus<W> {
    pub fn new(out: W) -> Self {
        Self {
            out,
            next_request_id: 1,
            pending: HashMap::new(),
            ui_event_counts: HashMap::new(),
        }
    }

    /// 写出一帧并 flush。宿主已退出（管道断开）时返回 false。
    pub fn send(&mut self, frame: &CoreToUiFrame) -> bool {
        let line = match frame.encode() {
            Ok(line) => line,
            Err(err) => {
                eprintln!("[core] failed to encode frame: {err}");
                return false;
            }
        };
        if let Err(err) = self
            .out
            .write_all(line.as_bytes())
            .and_then(|()| self.out.flush())
        {
            eprintln!("[core] failed to write frame: {err}");
            return false;
        }
        true
    }

    /// 上报一条 `CoreEvent`。
    pub fn emit(&mut self, event: Value) -> bool {
        self.send(&CoreToUiFrame::Event { event })
    }

    /// 上报一行日志（`CoreEvent.log`）。
    pub fn log(&mut self, message: &str) -> bool {
        self.emit(json!({ "type": "log", "message": message }))
    }

    /// 发起一次 `CoreRequest`，返回请求 id 与应答通道。
    pub fn request(&mut self, request: Value) -> Option<(u64, Receiver<Value>)> {
        let request_type = request
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let session_id = request
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        // `userChoice` 的请求标识在 options 内层（specs/050 FR-001）
        let choice_request_id = request
            .get("options")
            .and_then(|options| options.get("choiceRequestId"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = self.next_request_id;
        self.next_request_id += 1;
        let (sender, receiver) = channel();
        // **先登记、后发帧**：宿主可能在帧写出后的极短时间内就应答（测试里的自动应答器、
        // 真实的本地回环），也可能在应答的同时发起 abort。若先发后登记，`handle_response`
        // / `abort_pending_user_choice` 就有机会在条目尚不存在时到达——应答被丢、
        // abort 找不到可打断的请求，两条路径都静默失效。
        self.pending.insert(
            id,
            (
                PendingRequest {
                    request_type,
                    session_id,
                    choice_request_id,
                },
                sender,
            ),
        );
        if !self.send(&CoreToUiFrame::Request { id, request }) {
            // 帧没写出去（宿主已退出）：把刚登记的条目撤掉，不留永远等不到的 pending
            self.pending.remove(&id);
            return None;
        }
        Some((id, receiver))
    }

    /// 发一条 `CoreRequest` 但**不登记 pending**（发后不等）。
    ///
    /// 展示同步类请求（`toolPermissionRequested`）用：core 不以应答为执行前置，
    /// 宿主的应答回来时 `handle_response` 查不到条目，静默丢弃。
    /// 请求 id 照常递增，保持 wire 上 id 唯一。
    pub fn request_detached(&mut self, request: Value) -> bool {
        let id = self.next_request_id;
        self.next_request_id += 1;
        self.send(&CoreToUiFrame::Request { id, request })
    }

    /// 放弃一个未决请求（等待超时）；避免 `pending` 表无界增长。
    pub fn cancel_request(&mut self, id: u64) {
        if self.pending.remove(&id).is_some() {
            eprintln!("[core] request {id} timed out; dropped from pending");
        }
    }

    /// 主动打断指定会话的在途 `userChoice`（specs/050 FR-001）。
    ///
    /// 做法是**移除条目并 drop 它的 `Sender`**：等待方阻塞在 `recv_timeout` 上，
    /// sender 一断就立刻返回 `Err(Disconnected)`，不需要轮询会话的取消标记。
    ///
    /// 只挑 `userChoice` 且 `session_id` 匹配的条目：同会话的其它请求
    /// （`crossWorkspaceAgentRequested` 等）有各自的收敛语义，不在这里一起打断。
    ///
    /// @returns 被中止的请求 id（调用方据此诊断）
    pub fn abort_pending_user_choice(&mut self, session_id: &str) -> Vec<u64> {
        let ids: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, (meta, _))| {
                meta.request_type == "userChoice" && meta.session_id.as_deref() == Some(session_id)
            })
            .map(|(id, _)| *id)
            .collect();
        for id in &ids {
            // `remove` 取回条目，`Sender` 随 tuple 一起 drop —— 这就是中断信号
            self.pending.remove(id);
            eprintln!("[core] userChoice request {id} aborted with the session");
        }
        ids
    }

    /// 处理 `CoreRequest` 的应答。
    pub fn handle_response(&mut self, id: u64, ok: bool, result: Value, error: Option<String>) {
        let entry = self.pending.remove(&id);
        let request_type = entry
            .as_ref()
            .map(|(meta, _)| meta.request_type.clone())
            .unwrap_or_else(|| "unknown".to_string());
        if !ok {
            eprintln!(
                "[core] response {id} ({request_type}) failed: {}",
                error.as_deref().unwrap_or("unknown error")
            );
        }
        if let Some((_, sender)) = entry {
            let payload = if ok {
                result
            } else {
                json!({ "error": error.unwrap_or_default() })
            };
            let _ = sender.send(payload);
        }
    }

    /// 处理一条 `UiEvent`（统计 + 诊断）。
    pub fn handle_ui_event(&mut self, event: &Value) -> Option<String> {
        let event_type = event.get("type").and_then(Value::as_str)?;
        *self
            .ui_event_counts
            .entry(event_type.to_string())
            .or_insert(0) += 1;
        Some(event_type.to_string())
    }

    /// 尚未收到应答的请求数。
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    /// 收到的 UiEvent 计数（按类型）。
    #[allow(dead_code)]
    pub fn ui_event_count(&self, event_type: &str) -> u64 {
        self.ui_event_counts.get(event_type).copied().unwrap_or(0)
    }
}

/// 阻塞等待一次请求的应答；超时或通道关闭返回 None。
pub fn wait_response(receiver: Receiver<Value>, timeout: Duration) -> Option<Value> {
    receiver.recv_timeout(timeout).ok()
}

#[cfg(test)]
#[path = "bus_tests.rs"]
mod tests;

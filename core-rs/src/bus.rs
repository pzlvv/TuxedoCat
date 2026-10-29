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

pub struct CoreBus<W: Write> {
    out: W,
    next_request_id: u64,
    /// 已发出、尚未收到应答的请求：id → (请求类型, 应答通道)
    pending: HashMap<u64, (String, Sender<Value>)>,
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
        let id = self.next_request_id;
        self.next_request_id += 1;
        let (sender, receiver) = channel();
        if !self.send(&CoreToUiFrame::Request { id, request }) {
            return None;
        }
        self.pending.insert(id, (request_type, sender));
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

    /// 处理 `CoreRequest` 的应答。
    pub fn handle_response(&mut self, id: u64, ok: bool, result: Value, error: Option<String>) {
        let entry = self.pending.remove(&id);
        let request_type = entry
            .as_ref()
            .map(|(request_type, _)| request_type.clone())
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
        *self.ui_event_counts.entry(event_type.to_string()).or_insert(0) += 1;
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

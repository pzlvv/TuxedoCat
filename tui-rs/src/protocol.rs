//! 帧协议客户端（对齐 `core-rs/src/frame.rs` 与 `src/host/standalone/protocol.ts`，
//! 见 docs/core/standalone-core.md 第 6 节）。
//!
//! 编码：UTF-8，换行（`\n`）分隔的 JSON，一行一帧；帧内换行以 JSON 转义表达。
//! 本模块只做编解码与信封类型；事件 / 请求的载荷以 `serde_json::Value` 透传，
//! 词汇表见 `src/core/AssistantEventBus.ts`（parity 由 eventTypesParity.json 锁定）。

use std::io::BufRead;

use serde_json::Value;

/// 协议版本；握手时由 Core 校验（协议 2：双向 request/response 通道）。
pub const CORE_PROTOCOL_VERSION: u32 = 2;

/// UI → Core 的帧。
#[derive(Debug, Clone, PartialEq)]
pub enum UiToCoreFrame {
    /// 握手请求
    Hello,
    /// `CoreRequest` 的应答
    Response {
        id: u64,
        ok: bool,
        result: Value,
        error: Option<String>,
    },
    /// 单向事件
    UiEvent(Value),
    /// UI → core 的请求；Core 以 `Response` 帧回同 id
    Request { id: u64, request: Value },
    /// 优雅关闭
    Shutdown,
}

/// Core → UI 的帧。
#[derive(Debug, Clone, PartialEq)]
pub enum CoreToUiFrame {
    /// 握手通过
    Ready,
    /// 单向事件
    Event(Value),
    /// 请求-响应（权限确认 / 用户问答）
    Request { id: u64, request: Value },
    /// 应答：UI → core 请求的响应
    Response { id: u64, ok: bool, result: Value, error: Option<String> },
}

impl UiToCoreFrame {
    /// 编码为一帧（含结尾换行）。
    pub fn encode(&self) -> Result<String, serde_json::Error> {
        let value = match self {
            UiToCoreFrame::Hello => serde_json::json!({ "kind": "hello", "protocol": CORE_PROTOCOL_VERSION }),
            UiToCoreFrame::Response { id, ok, result, error } => {
                let mut frame = serde_json::json!({ "kind": "response", "id": id, "ok": ok });
                let object = frame.as_object_mut().expect("frame is an object");
                if *ok {
                    object.insert("result".into(), result.clone());
                }
                if let Some(error) = error {
                    object.insert("error".into(), Value::String(error.clone()));
                }
                frame
            }
            UiToCoreFrame::UiEvent(event) => serde_json::json!({ "kind": "uiEvent", "event": event }),
            UiToCoreFrame::Request { id, request } => {
                serde_json::json!({ "kind": "request", "id": id, "request": request })
            }
            UiToCoreFrame::Shutdown => serde_json::json!({ "kind": "shutdown" }),
        };
        let mut line = serde_json::to_string(&value)?;
        line.push('\n');
        Ok(line)
    }
}

/// 解码一行 JSON 为 Core → UI 的帧；不是帧结构时返回 None（调用方记日志丢弃）。
pub fn decode_frame(line: &str) -> Option<CoreToUiFrame> {
    let value: Value = serde_json::from_str(line).ok()?;
    let kind = value.get("kind")?.as_str()?;
    match kind {
        "ready" => Some(CoreToUiFrame::Ready),
        "event" => Some(CoreToUiFrame::Event(value.get("event")?.clone())),
        "request" => Some(CoreToUiFrame::Request {
            id: value.get("id")?.as_u64()?,
            request: value.get("request")?.clone(),
        }),
        "response" => Some(CoreToUiFrame::Response {
            id: value.get("id")?.as_u64()?,
            ok: value.get("ok")?.as_bool()?,
            result: value.get("result").cloned().unwrap_or(Value::Null),
            error: value.get("error").and_then(Value::as_str).map(str::to_string),
        }),
        _ => None,
    }
}

/// 增量解码器：输入任意切分的字节块，按 `\n` 切帧（空行跳过；坏行跳过不中断）。
///
/// 当前宿主按行阻塞读（`read_from`）；本结构保留给流式复用与测试场景。
#[allow(dead_code)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    /// 收到一帧
    pub frames: Vec<CoreToUiFrame>,
    /// 坏行计数（诊断用；单行失败不影响后续行）
    pub bad_lines: u64,
}

// 保留给流式复用与测试场景；生产路径走 read_from
#[allow(dead_code)]
impl FrameDecoder {
    pub fn new() -> Self {
        Self { buffer: Vec::new(), frames: Vec::new(), bad_lines: 0 }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }

    /// 追加一段字节并解码出完整帧。
    pub fn push(&mut self, chunk: &[u8]) {
        self.buffer.extend_from_slice(chunk);
        loop {
            let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') else {
                return;
            };
            let line: Vec<u8> = self.buffer.drain(..=index).collect();
            let mut text = String::from_utf8_lossy(&line[..index]).into_owned();
            if text.ends_with('\r') {
                text.pop();
            }
            if text.trim().is_empty() {
                continue;
            }
            match decode_frame(&text) {
                Some(frame) => self.frames.push(frame),
                None => self.bad_lines += 1,
            }
        }
    }

    /// 从 `BufRead` 拉取一帧（阻塞）；输入结束返回 None。
    pub fn read_from(reader: &mut impl BufRead) -> std::io::Result<Option<CoreToUiFrame>> {
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line)?;
            if read == 0 {
                return Ok(None);
            }
            let trimmed = line.trim_end_matches(['\n', '\r']);
            if trimmed.is_empty() {
                continue;
            }
            if let Some(frame) = decode_frame(trimmed) {
                return Ok(Some(frame));
            }
            // 坏行：跳过继续（与 Core 对 malformed frame 的口径一致）
        }
    }
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;

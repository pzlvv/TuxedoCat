//! MCP 远程客户端（HTTP 传输）。
//!
//! 支持两种远程传输，二者共用同一个 JSON-RPC 能力集：
//!
//! 1. **Streamable HTTP**（协议 2025-03-26 / 2025-06-18）
//!    - 每个 JSON-RPC 请求都是一次独立的 POST
//!    - 响应可能是 `application/json`，也可能是 `text/event-stream`（SSE）
//!    - initialize 的响应头 `Mcp-Session-Id` 需在后续请求中回传
//!    - 握手后的请求需带 `MCP-Protocol-Version` 头
//!
//! 2. **旧版 HTTP+SSE**（协议 2024-11-05）
//!    - 先 GET 建立 SSE 长连接，服务器以 `event: endpoint` 下发 POST 地址
//!    - 请求经 POST 发出，响应从 SSE 长连接上回流
//!
//! 连接时先按 Streamable HTTP 握手，失败后自动回退旧版 SSE —— 用户只需在 `mcp.json`
//! 里写 `"type": "remote"` + `"url"`，无需关心服务器实现哪一版。
//!
//! 固有限制（阻塞式实现）：`reqwest::blocking` 没有对外暴露中止句柄，`stop()` 只能
//! 置停止标记，读线程会在服务器关闭连接 / 下一次收到事件时退出。Streamable HTTP
//! 的每个请求都有独立的 `timeout`，不受影响。

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::mcp::{
    list_mcp_tools, normalize_mcp_call_result, ExitCallback, McpCallResult, McpClient,
    McpToolDefinition, CALL_TIMEOUT_MS, CONTROL_TIMEOUT_MS, PROTOCOL_VERSION,
};

/// 握手对「本机软件瞬时掐断连接」的重试次数与起始退避（共 3 次尝试）。
/// 与 LLM 客户端的网络错误重试次数一致（llm.rs 的 MAX_RETRIES）。
const START_MAX_ATTEMPTS: u32 = 3;
const START_RETRY_DELAY_MS: u64 = 200;

/// POST 发送阶段的重试次数与退避。只在 `send()` 本身失败时重试——此时请求未被
/// 服务器受理，不存在重复执行工具的歧义；超时（等待预算耗尽）是确定性行为，不重试。
const SEND_MAX_ATTEMPTS: u32 = 3;
const SEND_RETRY_DELAY_MS: u64 = 150;

/// 握手失败是否属于网络层瞬时错误（可重试）。
///
/// 与本文件产出的错误文案耦合：网络层错误统一落成「网络错误」（`wrap_network_error`
/// / `post_legacy` 的映射）或「SSE 连接已关闭」（`legacy_sse_reader` 的连接中断）；
/// 其余——HTTP 状态、超时、endpoint 未下发——是服务端的确定性行为，不重试。
fn is_transient_network_error(message: &str) -> bool {
    message.contains("网络错误") || message.contains("SSE 连接已关闭")
}

/// POST 的发送阶段对瞬时网络错误做有界重试：本机安全软件（过滤驱动）会间歇性
/// 掐断刚建立的连接（WSAECONNRESET / WSAECONNABORTED，reqwest 报
/// 「error sending request」），与 LLM 客户端对网络错误的处理约定一致（llm.rs 重试 3 次）。
fn send_post_with_retry(
    name: &str,
    build: impl Fn() -> reqwest::blocking::RequestBuilder,
) -> Result<reqwest::blocking::Response, reqwest::Error> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match build().send() {
            Ok(response) => return Ok(response),
            Err(err) => {
                let transient =
                    (err.is_request() || err.is_connect() || err.is_body()) && !err.is_timeout();
                if !transient || attempt >= SEND_MAX_ATTEMPTS {
                    return Err(err);
                }
                eprintln!(
                    "[core] mcp: [{name}] 请求被瞬时中断，{SEND_RETRY_DELAY_MS}ms 后重试（{attempt}/{SEND_MAX_ATTEMPTS}）：{err}"
                );
                std::thread::sleep(Duration::from_millis(SEND_RETRY_DELAY_MS));
            }
        }
    }
}

/// 解析出的 SSE 事件
#[derive(Clone, Debug, PartialEq)]
struct SseEvent {
    event: String,
    data: String,
}

/// 传输模式
#[derive(Clone, Copy, Debug, PartialEq)]
enum Mode {
    Streamable,
    Legacy,
}

struct HttpState {
    tools: Vec<McpToolDefinition>,
    running: bool,
    initialized: bool,
    /// initialize 是否已完成（决定后续请求是否回传协议版本头）
    handshake_done: bool,
    exit_reason: Option<String>,
    /// 实际协商到的协议版本（initialize 响应为准）
    protocol_version: String,
    /// Streamable HTTP 会话 ID（initialize 响应头下发）
    session_id: Option<String>,
    /// 旧版 SSE 模式下用于发送请求的端点（endpoint 事件下发）
    legacy_endpoint: Option<String>,
    /// 旧版 SSE 长连接的停止标记
    legacy_stop: Option<Arc<AtomicBool>>,
    /// 等待 endpoint 事件期间的出口
    endpoint_tx: Option<Sender<Result<String, String>>>,
    /// 进行中的请求（仅旧版 SSE 模式使用；Streamable 模式为独立 POST）
    pending: HashMap<u64, Sender<Result<Value, String>>>,
    next_id: u64,
    mode: Mode,
    on_exit: Option<ExitCallback>,
}

struct HttpShared {
    name: String,
    url: String,
    headers: Vec<(String, String)>,
    state: Mutex<HttpState>,
}

/// MCP 远程客户端（对齐 `McpHttpClient`）
pub struct McpHttpClient {
    shared: Arc<HttpShared>,
}

impl McpHttpClient {
    pub fn new(name: &str, url: &str, headers: &[(String, String)]) -> McpHttpClient {
        McpHttpClient {
            shared: Arc::new(HttpShared {
                name: name.to_string(),
                url: url.to_string(),
                headers: headers.to_vec(),
                state: Mutex::new(HttpState {
                    tools: Vec::new(),
                    running: false,
                    initialized: false,
                    handshake_done: false,
                    exit_reason: None,
                    protocol_version: PROTOCOL_VERSION.to_string(),
                    session_id: None,
                    legacy_endpoint: None,
                    legacy_stop: None,
                    endpoint_tx: None,
                    pending: HashMap::new(),
                    next_id: 1,
                    mode: Mode::Streamable,
                    on_exit: None,
                }),
            }),
        }
    }

    fn name(&self) -> &str {
        &self.shared.name
    }

    fn set_mode(&self, mode: Mode) {
        self.shared.state.lock().unwrap().mode = mode;
    }

    fn initialize_params(&self) -> Value {
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": crate::mcp::EXTENSION_NAME, "version": "1.0.0" },
        })
    }

    fn apply_initialize_result(&self, result: &Value) {
        if let Some(version) = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|version| !version.is_empty())
        {
            self.shared.state.lock().unwrap().protocol_version = version.to_string();
        }
    }

    /// 切换传输前清理上一轮尝试留下的状态（对齐 `resetTransientState`）
    fn reset_transient_state(&self) {
        let (pending, stop) = {
            let mut state = self.shared.state.lock().unwrap();
            state.session_id = None;
            state.legacy_endpoint = None;
            state.handshake_done = false;
            state.endpoint_tx = None;
            let stop = state.legacy_stop.take();
            (std::mem::take(&mut state.pending), stop)
        };
        let error = format!("MCP server \"{}\" 传输回退", self.name());
        for (_, sender) in pending {
            let _ = sender.send(Err(error.clone()));
        }
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
    }

    // ── JSON-RPC 收发 ────────────────────────────────────────────

    /// 发送带 id 的请求，返回 `result`（error 时抛错）
    fn rpc(&self, method: &str, params: &Value, timeout_ms: u64) -> Result<Value, String> {
        let id = {
            let mut state = self.shared.state.lock().unwrap();
            let id = state.next_id;
            state.next_id += 1;
            id
        };
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mode = self.shared.state.lock().unwrap().mode;
        let response = match mode {
            Mode::Legacy => self.request_legacy(&message, timeout_ms)?,
            Mode::Streamable => self.request_streamable(&message, timeout_ms)?,
        };

        let Some(response) = response else {
            return Err(format!("MCP server \"{}\" 对 {method} 未返回响应", self.name()));
        };
        if let Some(error) = response.get("error").filter(|value| !value.is_null()) {
            let code = error
                .get("code")
                .map(crate::util::js_string)
                .unwrap_or_else(|| "undefined".to_string());
            let text = error
                .get("message")
                .map(crate::util::js_string)
                .unwrap_or_else(|| "undefined".to_string());
            return Err(format!("MCP 错误 {code}: {text}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// 发送通知（无 id，服务器不返回结果体）
    fn notify(&self, method: &str, params: Option<&Value>) -> Result<(), String> {
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), json!("2.0"));
        message.insert("method".to_string(), json!(method));
        if let Some(params) = params {
            message.insert("params".to_string(), params.clone());
        }
        let message = Value::Object(message);
        let mode = self.shared.state.lock().unwrap().mode;
        match mode {
            Mode::Legacy => {
                post_legacy(&self.shared, &message)?;
                Ok(())
            }
            Mode::Streamable => {
                self.request_streamable(&message, CONTROL_TIMEOUT_MS)?;
                Ok(())
            }
        }
    }

    /// Streamable HTTP：独立 POST，响应可能直接是 JSON，也可能是 SSE 流
    fn request_streamable(
        &self,
        message: &Value,
        timeout_ms: u64,
    ) -> Result<Option<Value>, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .map_err(|err| self.wrap_network_error(&err, timeout_ms))?;
        let headers = self.build_headers(true);
        // 按 JS `JSON.stringify` 逐字序列化（数字走 JS 口径）
        let body = crate::util::js_json_stringify(message);
        let response = send_post_with_retry(self.name(), || {
            client
                .post(&self.shared.url)
                .headers(headers.clone())
                .body(body.clone())
        })
        .map_err(|err| self.wrap_network_error(&err, timeout_ms))?;
        let expect_id = message.get("id").cloned().unwrap_or(Value::Null);
        self.read_streamable_response(response, &expect_id)
    }

    fn read_streamable_response(
        &self,
        mut response: reqwest::blocking::Response,
        expect_id: &Value,
    ) -> Result<Option<Value>, String> {
        let status = response.status();
        // 202 Accepted：通知已受理，没有响应体
        if status.as_u16() == 202 || status.as_u16() == 204 {
            return Ok(None);
        }

        if let Some(session_id) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
        {
            self.shared.state.lock().unwrap().session_id = Some(session_id.to_string());
        }

        if !status.is_success() {
            let mut text = String::new();
            let _ = response.read_to_string(&mut text);
            let preview: String = text.chars().take(500).collect();
            return Err(format!(
                "HTTP {} {}{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                if preview.is_empty() {
                    String::new()
                } else {
                    format!(": {preview}")
                }
            ));
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        if content_type.contains("text/event-stream") {
            return self.read_sse_for_response(response, expect_id);
        }

        let mut text = String::new();
        response
            .read_to_string(&mut text)
            .map_err(|err| self.wrap_io_error(&err, 0))?;
        // 对齐 `HttpClient.ts` 的 `text.trim()`（JS 空白口径）
        if crate::util::js_trim(&text).is_empty() {
            return Ok(None);
        }
        match serde_json::from_str::<Value>(&text) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                let preview: String = text.chars().take(300).collect();
                Err(format!("无法解析 MCP 响应: {preview}"))
            }
        }
    }

    /// 读取 POST 返回的 SSE 流，取到 id 匹配的消息后即可返回
    fn read_sse_for_response(
        &self,
        mut response: reqwest::blocking::Response,
        expect_id: &Value,
    ) -> Result<Option<Value>, String> {
        let mut buffer = String::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = match response.read(&mut chunk) {
                Ok(read) => read,
                Err(err) => return Err(self.wrap_io_error(&err, 0)),
            };
            if read == 0 {
                break;
            }
            buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
            buffer = buffer.replace("\r\n", "\n");
            let (events, rest) = drain_sse_events(&buffer);
            buffer = rest;
            for event in events {
                let Some(message) = parse_sse_data(&event.data) else {
                    continue;
                };
                if expect_id.is_null() {
                    return Ok(Some(message));
                }
                // 对齐 TS 的 `String(message.id) === String(expectId)`：数字 / 字符串 id 都认
                let message_id = message
                    .get("id")
                    .map(crate::util::js_string)
                    .unwrap_or_default();
                if message_id == crate::util::js_string(expect_id) {
                    return Ok(Some(message));
                }
            }
        }
        Ok(None)
    }

    /// 旧版 SSE：POST 到 endpoint，等待长连接回流的响应
    fn request_legacy(&self, message: &Value, timeout_ms: u64) -> Result<Option<Value>, String> {
        let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
        self.shared
            .state
            .lock()
            .unwrap()
            .pending
            .insert(id, sender);

        // POST 在独立线程上跑；响应从 SSE 长连接回流（对齐 `void this.postLegacy(...)`）
        {
            let shared = Arc::clone(&self.shared);
            let message = message.clone();
            std::thread::spawn(move || {
                if let Err(err) = post_legacy(&shared, &message) {
                    let sender = shared.state.lock().unwrap().pending.remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(Err(err));
                    }
                }
            });
        }

        match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(result) => result.map(Some),
            Err(RecvTimeoutError::Timeout) => {
                self.shared.state.lock().unwrap().pending.remove(&id);
                Err(format!(
                    "MCP server \"{}\" 请求 {method} 超时（{timeout_ms}ms）",
                    self.name()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(format!("MCP server \"{}\" 进程已退出", self.name()))
            }
        }
    }

    /// 构造 Streamable HTTP 请求头（对齐 `buildHeaders`）
    fn build_headers(&self, json_body: bool) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        insert_header(&mut headers, "Accept", "application/json, text/event-stream");
        for (key, value) in &self.shared.headers {
            insert_header(&mut headers, key, value);
        }
        if json_body {
            insert_header(&mut headers, "Content-Type", "application/json");
        }
        let state = self.shared.state.lock().unwrap();
        if let Some(session_id) = &state.session_id {
            insert_header(&mut headers, "Mcp-Session-Id", session_id);
        }
        // 2025-03-26 起要求 initialize 之后的请求回传协议版本；旧版服务器不认识该头，直接不发
        if state.handshake_done && !state.protocol_version.starts_with("2024") {
            insert_header(&mut headers, "MCP-Protocol-Version", &state.protocol_version);
        }
        headers
    }

    /// 尽力结束 Streamable HTTP 会话，失败不影响调用方（对齐 `deleteSession`）
    fn delete_session(&self, session_id: &str) -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(5_000))
            .build()
            .map_err(|err| err.to_string())?;
        let mut headers = reqwest::header::HeaderMap::new();
        insert_header(&mut headers, "Mcp-Session-Id", session_id);
        for (key, value) in &self.shared.headers {
            insert_header(&mut headers, key, value);
        }
        let _ = client.delete(&self.shared.url).headers(headers).send();
        Ok(())
    }

    // ── 旧版 SSE 长连接 ──────────────────────────────────────────

    /// 建立 SSE 长连接，返回服务器下发的 POST endpoint（对齐 `openLegacySse`）
    fn open_legacy_sse(&self) -> Result<String, String> {
        let (endpoint_tx, endpoint_rx) = mpsc::channel::<Result<String, String>>();
        let stop = Arc::new(AtomicBool::new(false));
        {
            let mut state = self.shared.state.lock().unwrap();
            state.endpoint_tx = Some(endpoint_tx);
            state.legacy_stop = Some(Arc::clone(&stop));
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(24 * 3600))
            .build()
            .map_err(|err| self.wrap_network_error(&err, CONTROL_TIMEOUT_MS))?;
        let mut headers = reqwest::header::HeaderMap::new();
        insert_header(&mut headers, "Accept", "text/event-stream");
        for (key, value) in &self.shared.headers {
            insert_header(&mut headers, key, value);
        }
        let response = client
            .get(&self.shared.url)
            .headers(headers)
            .send()
            .map_err(|err| self.wrap_network_error(&err, CONTROL_TIMEOUT_MS))?;
        if !response.status().is_success() {
            let status = response.status();
            let mut text = String::new();
            let mut response = response;
            let _ = response.read_to_string(&mut text);
            let preview: String = text.chars().take(200).collect();
            return Err(format!(
                "SSE 连接失败: HTTP {} {}{}",
                status.as_u16(),
                status.canonical_reason().unwrap_or(""),
                if preview.is_empty() {
                    String::new()
                } else {
                    format!(": {preview}")
                }
            ));
        }

        {
            let shared = Arc::clone(&self.shared);
            std::thread::spawn(move || legacy_sse_reader(shared, response, stop));
        }

        match endpoint_rx.recv_timeout(Duration::from_millis(CONTROL_TIMEOUT_MS)) {
            Ok(Ok(endpoint)) => Ok(endpoint),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(format!(
                "MCP server \"{}\" 未在 {CONTROL_TIMEOUT_MS}ms 内下发 SSE endpoint 事件",
                self.name()
            )),
        }
    }

    fn wrap_network_error(&self, err: &reqwest::Error, timeout_ms: u64) -> String {
        if err.is_timeout() {
            return if timeout_ms > 0 {
                format!("MCP server \"{}\" 请求超时（{timeout_ms}ms）", self.name())
            } else {
                format!("MCP server \"{}\" 请求已被中止", self.name())
            };
        }
        format!("MCP server \"{}\" 网络错误: {err}", self.name())
    }

    /// 读流过程中的 `io::Error`（连接中断 / 被中止）
    fn wrap_io_error(&self, err: &std::io::Error, timeout_ms: u64) -> String {
        if err.kind() == std::io::ErrorKind::TimedOut {
            return if timeout_ms > 0 {
                format!("MCP server \"{}\" 请求超时（{timeout_ms}ms）", self.name())
            } else {
                format!("MCP server \"{}\" 请求已被中止", self.name())
            };
        }
        format!("MCP server \"{}\" 网络错误: {err}", self.name())
    }

    fn connect_streamable(&self) -> Result<(), String> {
        self.set_mode(Mode::Streamable);
        let init_result = self.rpc("initialize", &self.initialize_params(), CONTROL_TIMEOUT_MS)?;
        self.apply_initialize_result(&init_result);
        self.shared.state.lock().unwrap().handshake_done = true;
        self.notify("notifications/initialized", None)?;
        let tools = list_mcp_tools(|method, params, timeout| {
            self.rpc(method, params, timeout)
        })?;
        self.shared.state.lock().unwrap().tools = tools;
        Ok(())
    }

    fn connect_legacy(&self) -> Result<(), String> {
        self.set_mode(Mode::Legacy);
        let endpoint = self.open_legacy_sse()?;
        self.shared.state.lock().unwrap().legacy_endpoint = Some(endpoint);
        let init_result = self.rpc("initialize", &self.initialize_params(), CONTROL_TIMEOUT_MS)?;
        self.apply_initialize_result(&init_result);
        self.shared.state.lock().unwrap().handshake_done = true;
        self.notify("notifications/initialized", None)?;
        let tools = list_mcp_tools(|method, params, timeout| {
            self.rpc(method, params, timeout)
        })?;
        self.shared.state.lock().unwrap().tools = tools;
        Ok(())
    }

    /// 一次完整的握手尝试：先 Streamable HTTP，失败回退旧版 SSE。
    /// 失败时返回合并了两种传输错误的信息（能否重试由 `start` 判定）。
    fn handshake(&self) -> Result<(), String> {
        let streamable_error = match self.connect_streamable() {
            Ok(()) => return Ok(()),
            Err(err) => {
                eprintln!(
                    "[core] mcp: [{}] Streamable HTTP 握手失败，回退旧版 SSE: {err}",
                    self.name()
                );
                self.reset_transient_state();
                err
            }
        };

        match self.connect_legacy() {
            Ok(()) => Ok(()),
            Err(legacy_error) => Err(format!(
                "启动 MCP server \"{}\" ({}) 失败: Streamable HTTP: {streamable_error}；旧版 SSE: {legacy_error}",
                self.name(),
                self.shared.url
            )),
        }
    }
}

impl McpClient for McpHttpClient {
    fn name(&self) -> &str {
        &self.shared.name
    }

    fn set_on_exit(&self, callback: ExitCallback) {
        self.shared.state.lock().unwrap().on_exit = Some(callback);
    }

    fn get_tools(&self) -> Vec<McpToolDefinition> {
        self.shared.state.lock().unwrap().tools.clone()
    }

    fn is_running(&self) -> bool {
        self.shared.state.lock().unwrap().running
    }

    fn get_exit_reason(&self) -> Option<String> {
        self.shared.state.lock().unwrap().exit_reason.clone()
    }

    fn is_initialized(&self) -> bool {
        self.shared.state.lock().unwrap().initialized
    }

    fn start(&self) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        if self.shared.url.is_empty() {
            return Err(format!("MCP server \"{}\" 缺少 url", self.name()));
        }
        if reqwest::Url::parse(&self.shared.url).is_err() {
            return Err(format!(
                "MCP server \"{}\" 的 url 非法: {}",
                self.name(),
                self.shared.url
            ));
        }

        {
            let mut state = self.shared.state.lock().unwrap();
            state.exit_reason = None;
            state.running = true;
            state.initialized = false;
        }

        // 本机安全软件（杀毒 / 防火墙的过滤驱动）会间歇性掐断刚建立的回环连接
        // （WSAECONNRESET / WSAECONNABORTED，reqwest 报「error sending request」）。
        // 与 LLM 客户端对网络错误的处理约定一致（llm.rs 重试 3 次）：握手失败且属于
        // 网络层瞬时错误时退避后整体重来；协议层失败（HTTP 状态、服务器沉默）是
        // 服务端的确定性行为，一次定论不重试。
        let mut attempt = 0u32;
        let mut delay = START_RETRY_DELAY_MS;
        loop {
            attempt += 1;
            match self.handshake() {
                Ok(()) => {
                    self.shared.state.lock().unwrap().initialized = true;
                    return Ok(());
                }
                Err(combined) => {
                    if attempt >= START_MAX_ATTEMPTS || !is_transient_network_error(&combined) {
                        self.stop();
                        return Err(combined);
                    }
                    eprintln!(
                        "[core] mcp: [{}] 连接被瞬时中断，{delay}ms 后重试（{attempt}/{START_MAX_ATTEMPTS}）：{combined}",
                        self.name()
                    );
                    // 清掉失败尝试的残留（SSE 读取线程、半截握手状态）再重来
                    self.reset_transient_state();
                    std::thread::sleep(Duration::from_millis(delay));
                    delay *= 2;
                }
            }
        }
    }

    fn stop(&self) {
        let (was_running, session_id, stop) = {
            let mut state = self.shared.state.lock().unwrap();
            let was_running = state.running;
            state.running = false;
            state.initialized = false;
            state.handshake_done = false;
            state.endpoint_tx = None;
            let session_id = state.session_id.take();
            state.legacy_endpoint = None;
            let stop = state.legacy_stop.take();
            (was_running, session_id, stop)
        };
        if let Some(stop) = stop {
            stop.store(true, Ordering::SeqCst);
        }
        reject_all_pending(
            &self.shared,
            &format!("MCP server \"{}\" 已停止", self.name()),
        );

        // Streamable HTTP 建议用 DELETE 主动结束会话，best-effort 即可
        if was_running {
            if let Some(session_id) = session_id {
                let _ = self.delete_session(&session_id);
            }
        }
    }

    fn call_tool(&self, tool_name: &str, args: &Value) -> Result<McpCallResult, String> {
        if !self.is_running() {
            let reason = self.get_exit_reason();
            return Err(format!(
                "MCP server \"{}\" 未运行{}",
                self.name(),
                reason.map(|reason| format!("（{reason}）")).unwrap_or_default()
            ));
        }
        let result = self.rpc(
            "tools/call",
            &json!({ "name": tool_name, "arguments": args }),
            CALL_TIMEOUT_MS,
        )?;
        Ok(normalize_mcp_call_result(&result))
    }
}

// ==================== SSE 解析 ====================

/// 拆出完整的 SSE 事件块（以空行分隔），返回事件列表与残留 buffer
fn drain_sse_events(buffer: &str) -> (Vec<SseEvent>, String) {
    let mut events = Vec::new();
    let mut rest = buffer.to_string();
    while let Some(index) = rest.find("\n\n") {
        let block = rest[..index].to_string();
        rest = rest[index + 2..].to_string();
        if let Some(event) = parse_sse_block(&block) {
            events.push(event);
        }
    }
    (events, rest)
}

/// 解析单个 SSE 事件块（多行 data 用 `\n` 拼接）
fn parse_sse_block(block: &str) -> Option<SseEvent> {
    let mut event = "message".to_string();
    let mut data_lines: Vec<String> = Vec::new();

    for line in block.split('\n') {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let colon = line.find(':');
        let field = match colon {
            Some(index) => &line[..index],
            None => line,
        };
        let mut value = match colon {
            Some(index) => &line[index + 1..],
            None => "",
        };
        if let Some(stripped) = value.strip_prefix(' ') {
            value = stripped;
        }
        if field == "event" {
            event = value.to_string();
        } else if field == "data" {
            data_lines.push(value.to_string());
        }
    }

    if data_lines.is_empty() {
        return None;
    }
    Some(SseEvent {
        event,
        data: data_lines.join("\n"),
    })
}

/// 把 SSE 的 data 字段解析为 JSON-RPC 消息，非 JSON 时返回 None
fn parse_sse_data(data: &str) -> Option<Value> {
    let text = crate::util::js_trim(data);
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) if value.is_object() => Some(value),
        _ => None,
    }
}

// ==================== 旧版 SSE 长连接 ====================

fn legacy_sse_reader(
    shared: Arc<HttpShared>,
    mut response: reqwest::blocking::Response,
    stop: Arc<AtomicBool>,
) {
    let mut buffer = String::new();
    let mut chunk = [0u8; 8192];
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        match response.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
                buffer = buffer.replace("\r\n", "\n");
                let (events, rest) = drain_sse_events(&buffer);
                buffer = rest;
                for event in events {
                    handle_legacy_sse_event(&shared, event);
                }
            }
            Err(_) => break,
        }
    }

    let should_fail = {
        let state = shared.state.lock().unwrap();
        !stop.load(Ordering::SeqCst) && state.running && state.mode == Mode::Legacy
    };
    if should_fail {
        fail_legacy(&shared, "SSE 连接已关闭");
    }
}

fn handle_legacy_sse_event(shared: &Arc<HttpShared>, event: SseEvent) {
    if event.event == "endpoint" {
        let raw = crate::util::js_trim(&event.data);
        if raw.is_empty() {
            return;
        }
        let endpoint = match reqwest::Url::parse(&shared.url).and_then(|base| base.join(raw)) {
            Ok(endpoint) => endpoint.to_string(),
            Err(_) => {
                fail_legacy(shared, &format!("SSE endpoint 非法: {raw}"));
                return;
            }
        };
        let sender = {
            let mut state = shared.state.lock().unwrap();
            state.legacy_endpoint = Some(endpoint.clone());
            state.endpoint_tx.take()
        };
        if let Some(sender) = sender {
            let _ = sender.send(Ok(endpoint));
        }
        return;
    }

    let Some(message) = parse_sse_data(&event.data) else {
        return;
    };

    // 服务器反向请求：回绝，避免其一直等待
    if let Some(method) = message.get("method").and_then(Value::as_str) {
        if let Some(id) = message.get("id").filter(|value| !value.is_null()) {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id.clone(),
                "error": { "code": -32601, "message": format!("Method not found: {method}") },
            });
            let _ = post_legacy(shared, &reply);
            return;
        }
        return;
    }

    let Some(id) = message.get("id") else {
        return;
    };
    if id.is_null() {
        return;
    }
    let numeric_id = match id {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => crate::util::js_trim(text).parse::<u64>().ok(),
        _ => None,
    };
    let Some(numeric_id) = numeric_id else {
        return;
    };
    let sender = shared.state.lock().unwrap().pending.remove(&numeric_id);
    if let Some(sender) = sender {
        let _ = sender.send(Ok(message));
    }
}

/// 旧版 SSE：把消息 POST 到 endpoint（结果走长连接，不在此处读取）
fn post_legacy(shared: &Arc<HttpShared>, message: &Value) -> Result<(), String> {
    let endpoint = {
        let state = shared.state.lock().unwrap();
        state.legacy_endpoint.clone()
    };
    let Some(endpoint) = endpoint else {
        return Err(format!("MCP server \"{}\" 的 SSE endpoint 尚未就绪", shared.name));
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(CONTROL_TIMEOUT_MS))
        .build()
        .map_err(|err| format!("MCP server \"{}\" 网络错误: {err}", shared.name))?;
    let mut headers = reqwest::header::HeaderMap::new();
    insert_header(&mut headers, "Accept", "application/json, text/event-stream");
    insert_header(&mut headers, "Content-Type", "application/json");
    for (key, value) in &shared.headers {
        insert_header(&mut headers, key, value);
    }
    // 按 JS `JSON.stringify` 逐字序列化（数字走 JS 口径）
    let body = crate::util::js_json_stringify(message);
    let response = send_post_with_retry(&shared.name, || {
        client
            .post(&endpoint)
            .headers(headers.clone())
            .body(body.clone())
    })
    .map_err(|err| {
        if err.is_timeout() {
            format!(
                "MCP server \"{}\" 请求超时（{CONTROL_TIMEOUT_MS}ms）",
                shared.name
            )
        } else {
            format!("MCP server \"{}\" 网络错误: {err}", shared.name)
        }
    })?;
    if !response.status().is_success() {
        let status = response.status();
        let mut response = response;
        let mut text = String::new();
        let _ = response.read_to_string(&mut text);
        let preview: String = text.chars().take(200).collect();
        return Err(format!(
            "SSE 连接失败: HTTP {} {}{}",
            status.as_u16(),
            status.canonical_reason().unwrap_or(""),
            if preview.is_empty() {
                String::new()
            } else {
                format!(": {preview}")
            }
        ));
    }
    Ok(())
}

/// SSE 连接不可用：标记退出并回调上层（对齐 `failLegacy`）
fn fail_legacy(shared: &Arc<HttpShared>, reason: &str) {
    let sender = {
        let mut state = shared.state.lock().unwrap();
        state.endpoint_tx.take()
    };
    if let Some(sender) = sender {
        let _ = sender.send(Err(reason.to_string()));
    }

    let (was_running, callback) = {
        let mut state = shared.state.lock().unwrap();
        let was_running = state.running;
        state.exit_reason = Some(reason.to_string());
        state.running = false;
        state.initialized = false;
        state.handshake_done = false;
        (was_running, state.on_exit.clone())
    };

    reject_all_pending(shared, &format!("MCP server \"{}\" {reason}", shared.name));
    if was_running {
        if let Some(callback) = callback {
            callback(Some(reason.to_string()));
        }
    }
}

fn reject_all_pending(shared: &Arc<HttpShared>, error: &str) {
    let pending: Vec<Sender<Result<Value, String>>> = {
        let mut state = shared.state.lock().unwrap();
        state.pending.drain().map(|(_, sender)| sender).collect()
    };
    for sender in pending {
        let _ = sender.send(Err(error.to_string()));
    }
}

fn insert_header(headers: &mut reqwest::header::HeaderMap, key: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        reqwest::header::HeaderName::try_from(key),
        reqwest::header::HeaderValue::try_from(value),
    ) {
        headers.insert(name, value);
    }
}

#[cfg(test)]
#[path = "mcp_http_tests.rs"]
mod tests;

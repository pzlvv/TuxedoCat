//! MCP（Model Context Protocol）客户端、管理器与工具注入。
//!
//! - stdio 客户端：[`McpStdioClient`] / [`list_mcp_tools`] / [`normalize_mcp_call_result`]
//! - HTTP 客户端：[`crate::mcp_http::McpHttpClient`]
//! - 服务器配置：[`crate::mcp_config`]
//! - 工具定义：[`build_mcp_tool_name`] / [`create_mcp_tool_definition`]
//! - 管理器 [`McpManager`]（连接池 / 会话引用 / 延迟回收 / 运行时状态）
//! - 宿主接口：[`on_session_opened`] / [`on_session_closed`] /
//!   [`on_session_enabled_changed`] / [`prune`] / [`shutdown`]
//!
//! 进程模型：整仓是**阻塞式多线程**、没有 async 运行时。
//! stdio 传输用 `std::process::Command` + 读线程 + `mpsc` 做请求-响应配对与超时；
//! HTTP 传输用 `reqwest::blocking`。管理器把 acquire / release / sync / prune
//! 串行排进一个后台工作线程，因此这些入口都是
//! 非阻塞的、可随时从任意线程调用。

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::mcp_config::{self, McpServerInfo};
use crate::mcp_http::McpHttpClient;
use crate::util;

// ==================== Client.ts：公共契约与常量 ====================

/// 与服务器协商的协议版本（stdio 固定使用；HTTP 以服务器返回为准）
pub const PROTOCOL_VERSION: &str = "2024-11-05";
/// 握手 / 列表类请求超时
pub const CONTROL_TIMEOUT_MS: u64 = 30_000;
/// tools/call 超时（工具可能耗时较长）
pub const CALL_TIMEOUT_MS: u64 = 300_000;
/// `clientInfo.name`（同一配置来源：`src/config/project.json` 的 `extensionName`，
/// build.rs 构建期烧入，源码不持有产品字面量）
pub const EXTENSION_NAME: &str = env!("TC_EXTENSION_NAME");

/// MCP 服务器返回的工具定义
#[derive(Clone, Debug, PartialEq)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: Option<String>,
    /// 参数 JSON Schema（原样透传给 LLM）
    pub input_schema: Option<Value>,
    /// MCP 工具注解（readOnlyHint / destructiveHint 等）
    pub annotations: Option<Value>,
}

/// `tools/call` 的结果
#[derive(Clone, Debug, PartialEq)]
pub struct McpCallResult {
    /// 展平后的文本输出
    pub text: String,
    /// 服务器是否标记为错误
    pub is_error: bool,
}

/// 进程意外退出（崩溃 / 被 kill）时的回调；主动 `stop()` 不触发。
pub type ExitCallback = Arc<dyn Fn(Option<String>) + Send + Sync>;

/// MCP 客户端公共契约：stdio 与 HTTP/SSE 传输都实现它，管理器无需关心底层差异。
pub trait McpClient: Send + Sync {
    fn name(&self) -> &str;
    /// 注册连接意外断开时的回调
    fn set_on_exit(&self, callback: ExitCallback);
    fn get_tools(&self) -> Vec<McpToolDefinition>;
    fn is_running(&self) -> bool;
    fn get_exit_reason(&self) -> Option<String>;
    /// 是否已完成 initialize 握手（对等测试断言用，生产路径尚未消费）
    #[cfg_attr(not(test), allow(dead_code))]
    fn is_initialized(&self) -> bool;
    /// 建立连接并完成 initialize 握手 + tools/list
    fn start(&self) -> Result<(), String>;
    /// 主动断开连接
    fn stop(&self);
    /// 调用某个工具
    fn call_tool(&self, tool_name: &str, args: &Value) -> Result<McpCallResult, String>;
}

/// JS `JSON.stringify` 口径的序列化（实现已收敛到 `util::js_json_stringify`，
/// 这里保留同名入口，MCP 单测与调用点无需改动）。
pub use crate::util::js_json_stringify;

/// 把 `tools/call` 的返回展平为文本，供各传输复用（对齐 `normalizeMcpCallResult`）。
pub fn normalize_mcp_call_result(result: &Value) -> McpCallResult {
    // `result ?? {}`：JS 的 null / undefined 都落空
    let empty = Value::Object(Map::new());
    let as_record = if result.is_null() { &empty } else { result };
    let is_error = as_record.get("isError") == Some(&Value::Bool(true));

    let blocks: &[Value] = as_record
        .get("content")
        .and_then(Value::as_array)
        .map(|array| array.as_slice())
        .unwrap_or(&[]);

    let mut parts: Vec<String> = Vec::new();
    for block in blocks {
        // JS `typeof block !== 'object'` 会把数组也放进来（数组的 typeof 是 'object'）
        if !is_js_object(block) {
            continue;
        }
        let item = block;
        match item.get("type").and_then(Value::as_str) {
            Some("text") if item.get("text").map(Value::is_string).unwrap_or(false) => {
                parts.push(item.get("text").and_then(Value::as_str).unwrap_or("").to_string());
            }
            Some("image") => {
                let mime = item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                parts.push(format!("[image {mime}]"));
            }
            Some("resource") => {
                let resource = item.get("resource");
                let text = resource
                    .filter(|resource| resource.is_object())
                    .and_then(|resource| resource.get("text"))
                    .and_then(Value::as_str);
                if let Some(text) = text {
                    parts.push(text.to_string());
                } else {
                    let uri = resource
                        .and_then(|resource| resource.get("uri"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    parts.push(format!("[resource {uri}]"));
                }
            }
            _ => parts.push(js_json_stringify(item)),
        }
    }

    // 没有标准 content 时兜底序列化整个结果，避免返回空内容触发上游 "empty content" 报错
    let text = if parts.is_empty() {
        js_json_stringify(if result.is_null() { &Value::Null } else { result })
    } else {
        parts.join("\n")
    };
    McpCallResult { text, is_error }
}

/// JS `typeof value === 'object'` 且非 `null`（数组也算对象）。
///
/// `listMcpTools` 用 `item.inputSchema && typeof item.inputSchema === 'object'`
/// 判断，数组同样放行（JS 里数组的 `typeof` 是 `'object'`）。
fn is_js_object(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

/// 把一条 JSON-RPC 响应解析为工具列表（含分页），供各传输复用（对齐 `listMcpTools`）。
///
/// `request(method, params, timeoutMs)` 由调用方提供（stdio / HTTP 各自实现）。
/// 分页最多 50 页，防御服务器返回环状 cursor。
pub fn list_mcp_tools<F>(mut request: F) -> Result<Vec<McpToolDefinition>, String>
where
    F: FnMut(&str, &Value, u64) -> Result<Value, String>,
{
    let mut collected: Vec<McpToolDefinition> = Vec::new();
    let mut cursor: Option<String> = None;

    for _page in 0..50 {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let result = request("tools/list", &params, CONTROL_TIMEOUT_MS)?;
        let empty = Value::Object(Map::new());
        let as_record = if result.is_null() { &empty } else { &result };
        let tools = as_record
            .get("tools")
            .and_then(Value::as_array)
            .map(|array| array.as_slice())
            .unwrap_or(&[]);
        for raw in tools {
            if !raw.is_object() {
                continue;
            }
            let Some(name) = raw.get("name").and_then(Value::as_str) else {
                continue;
            };
            if name.is_empty() {
                continue;
            }
            collected.push(McpToolDefinition {
                name: name.to_string(),
                description: raw
                    .get("description")
                    .and_then(Value::as_str)
                    .map(|text| text.to_string()),
                input_schema: raw.get("inputSchema").filter(|value| is_js_object(value)).cloned(),
                annotations: raw
                    .get("annotations")
                    .filter(|value| is_js_object(value))
                    .cloned(),
            });
        }
        match as_record.get("nextCursor").and_then(Value::as_str) {
            Some(next) if !next.is_empty() => cursor = Some(next.to_string()),
            _ => break,
        }
    }

    Ok(collected)
}

/// Windows cmd 下对单个参数加引号（对齐 `quoteWindowsArg`）。
///
/// Node 在 `shell: true` 时把参数直接拼接后交给 cmd.exe，含空格的路径
/// （如 `C:\Program Files\...`）必须自行加引号，否则会被拆成多个参数。
/// 非 Windows 的产品路径用不到它，但单测（parity 对照）在所有平台都跑，因此保留定义。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn quote_windows_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    // 空白判定用 JS 正则 `\s` 口径（ECMAScript WhiteSpace + LineTerminator）：
    // Rust 的 `char::is_whitespace()` 含 U+0085 却不含 U+FEFF，与 `quoteWindowsArg`
    // 的 `/[\s"&|<>^()]/` 恰好相反。
    let needs_quote = value.chars().any(|ch| {
        crate::util::is_js_whitespace(ch) || matches!(ch, '"' | '&' | '|' | '<' | '>' | '^' | '(' | ')')
    });
    if !needs_quote {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}

// ==================== Client.ts：stdio 传输 ====================

struct StdioState {
    running: bool,
    initialized: bool,
    exit_reason: Option<String>,
    next_id: u64,
    pending: HashMap<u64, Sender<Result<Value, String>>>,
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    child: Option<Child>,
    on_exit: Option<ExitCallback>,
    tools: Vec<McpToolDefinition>,
}

struct StdioShared {
    name: String,
    state: Mutex<StdioState>,
}

/// stdio 传输客户端（对齐 `McpStdioClient`）
pub struct McpStdioClient {
    shared: Arc<StdioShared>,
    command: Vec<String>,
    environment: Vec<(String, String)>,
}

impl McpStdioClient {
    pub fn new(name: &str, command: &[String], environment: &[(String, String)]) -> McpStdioClient {
        McpStdioClient {
            shared: Arc::new(StdioShared {
                name: name.to_string(),
                state: Mutex::new(StdioState {
                    running: false,
                    initialized: false,
                    exit_reason: None,
                    next_id: 1,
                    pending: HashMap::new(),
                    stdin: None,
                    child: None,
                    on_exit: None,
                    tools: Vec::new(),
                }),
            }),
            command: command.to_vec(),
            environment: environment.to_vec(),
        }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        // JSON-RPC 帧按 JS `JSON.stringify` 逐字序列化（数字走 JS 口径）
        let text = format!("{}\n", js_json_stringify(message));
        let stdin = {
            let state = self.shared.state.lock().unwrap();
            state.stdin.as_ref().map(Arc::clone)
        };
        let Some(stdin) = stdin else {
            return Err(format!("MCP server \"{}\" 的 stdin 不可写", self.name()));
        };
        let mut stdin = stdin.lock().unwrap();
        stdin
            .write_all(text.as_bytes())
            .map_err(|err| format!("MCP server \"{}\" 写入失败: {err}", self.name()))?;
        stdin
            .flush()
            .map_err(|err| format!("MCP server \"{}\" 写入失败: {err}", self.name()))?;
        Ok(())
    }

    fn send_notification(&self, method: &str, params: Option<&Value>) -> Result<(), String> {
        let mut message = Map::new();
        message.insert("jsonrpc".to_string(), json!("2.0"));
        message.insert("method".to_string(), json!(method));
        if let Some(params) = params {
            message.insert("params".to_string(), params.clone());
        }
        self.write(&Value::Object(message))
    }

    fn send_request(&self, method: &str, params: &Value, timeout_ms: u64) -> Result<Value, String> {
        let id = {
            let mut state = self.shared.state.lock().unwrap();
            let id = state.next_id;
            state.next_id += 1;
            id
        };
        let (sender, receiver) = mpsc::channel::<Result<Value, String>>();
        {
            let mut state = self.shared.state.lock().unwrap();
            state.pending.insert(id, sender);
        }

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(err) = self.write(&message) {
            self.shared.state.lock().unwrap().pending.remove(&id);
            return Err(err);
        }

        match receiver.recv_timeout(Duration::from_millis(timeout_ms)) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.shared.state.lock().unwrap().pending.remove(&id);
                Err(format!(
                    "MCP server \"{}\" 请求 {method} 超时（{timeout_ms}ms）",
                    self.name()
                ))
            }
            Err(RecvTimeoutError::Disconnected) => Err(format!(
                "MCP server \"{}\" 进程已退出",
                self.name()
            )),
        }
    }

    fn initialize(&self) -> Result<(), String> {
        self.send_request(
            "initialize",
            &json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": EXTENSION_NAME, "version": "1.0.0" },
            }),
            CONTROL_TIMEOUT_MS,
        )?;
        // 握手完成的确认通知（无 id，不需要响应）
        self.send_notification("notifications/initialized", None)?;
        self.shared.state.lock().unwrap().initialized = true;
        Ok(())
    }
}

impl McpClient for McpStdioClient {
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
        let Some(program) = self.command.first() else {
            return Err(format!("MCP server \"{}\" 的 command 为空", self.name()));
        };
        if program.is_empty() {
            return Err(format!("MCP server \"{}\" 的 command 为空", self.name()));
        }

        let mut command = build_stdio_command(&self.command, &self.environment);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        util::hide_console(&mut command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                return Err(format!(
                    "启动 MCP server \"{}\" ({}) 失败: 进程启动失败: {err}",
                    self.name(),
                    self.command.join(" ")
                ));
            }
        };

        let stdin = child.stdin.take().expect("child stdin piped");
        let stdout = child.stdout.take().expect("child stdout piped");
        let stderr = child.stderr.take().expect("child stderr piped");

        {
            let mut state = self.shared.state.lock().unwrap();
            state.exit_reason = None;
            state.stdin = Some(Arc::new(Mutex::new(stdin)));
            state.child = Some(child);
            state.running = true;
            state.initialized = false;
            state.tools.clear();
        }

        // stderr 逐行记日志
        {
            let name = self.shared.name.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    let text = util::js_trim(&line);
                    if !text.is_empty() {
                        eprintln!("[core] mcp: [{name}] stderr: {text}");
                    }
                }
            });
        }

        // stdout 读线程：逐行处理 JSON-RPC 消息，EOF 时收尾
        {
            let shared = Arc::clone(&self.shared);
            std::thread::spawn(move || reader_loop(shared, stdout));
        }

        let result = (|| -> Result<(), String> {
            self.initialize()?;
            let tools = list_mcp_tools(|method, params, timeout| {
                self.send_request(method, params, timeout)
            })?;
            self.shared.state.lock().unwrap().tools = tools;
            Ok(())
        })();

        if let Err(err) = result {
            self.stop();
            // 带上 command，便于用户在菜单里直接看出是哪个 MCP 起不来
            return Err(format!(
                "启动 MCP server \"{}\" ({}) 失败: {err}",
                self.name(),
                self.command.join(" ")
            ));
        }
        Ok(())
    }

    /// 停止子进程。Windows 下连同子进程树一起结束，避免留下孤儿进程。
    fn stop(&self) {
        let child = {
            let mut state = self.shared.state.lock().unwrap();
            state.running = false;
            state.initialized = false;
            state.stdin = None;
            state.child.take()
        };
        reject_all_pending(&self.shared, &format!("MCP server \"{}\" 已停止", self.name()));

        let Some(mut child) = child else {
            return;
        };

        #[cfg(windows)]
        {
            // shell:true 时 child 是 cmd.exe，直接 kill 不会结束真正的服务器进程
            if let Ok(pid) = child.id().to_string().parse::<u32>() {
                let mut taskkill = Command::new("taskkill");
                taskkill.args(["/pid", &pid.to_string(), "/T", "/F"]);
                util::hide_console(&mut taskkill);
                let _ = taskkill.status();
            }
        }

        let _ = child.kill();
        let _ = child.wait();
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
        let result = self.send_request(
            "tools/call",
            &json!({ "name": tool_name, "arguments": args }),
            CALL_TIMEOUT_MS,
        )?;
        Ok(normalize_mcp_call_result(&result))
    }
}

/// 构造 stdio 子进程命令（Windows 走 `cmd /d /s /c "..."`，与 Node `shell: true` 同形）
fn build_stdio_command(command: &[String], environment: &[(String, String)]) -> Command {
    #[cfg(windows)]
    let mut child = {
        use std::os::windows::process::CommandExt;
        let joined = command
            .iter()
            .map(|arg| quote_windows_arg(arg))
            .collect::<Vec<_>>()
            .join(" ");
        let mut cmd = Command::new("cmd");
        cmd.raw_arg("/d")
            .raw_arg("/s")
            .raw_arg("/c")
            .raw_arg(format!("\"{joined}\""));
        cmd
    };
    #[cfg(not(windows))]
    let mut child = {
        let mut cmd = Command::new(&command[0]);
        cmd.args(&command[1..]);
        cmd
    };
    // `spawnEnv = { ...process.env, ...this.environment }`：继承父进程环境再叠加
    for (key, value) in environment {
        child.env(key, value);
    }
    // 与其它子进程一致地隐藏控制台窗口：Windows 下 MCP 服务器每起一次都闪一个黑框。
    crate::util::hide_console(&mut child);
    child
}

fn reader_loop(shared: Arc<StdioShared>, stdout: std::process::ChildStdout) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let text = util::js_trim(&line);
                if !text.is_empty() {
                    handle_line(&shared, text);
                }
            }
            Err(_) => break,
        }
    }
    handle_exit(&shared);
}

fn handle_line(shared: &StdioShared, line: &str) {
    let message: Value = match serde_json::from_str(line) {
        Ok(message) => message,
        Err(_) => {
            let preview: String = line.chars().take(200).collect();
            eprintln!("[core] mcp: [{}] 忽略非 JSON 输出: {preview}", shared.name);
            return;
        }
    };

    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id");

    if let Some(method) = method {
        // 服务器反向请求：回绝，避免其一直等待
        if let Some(id) = id.filter(|value| !value.is_null()) {
            let reply = json!({
                "jsonrpc": "2.0",
                "id": id.clone(),
                "error": { "code": -32601, "message": format!("Method not found: {method}") },
            });
            let stdin = {
                let state = shared.state.lock().unwrap();
                state.stdin.as_ref().map(Arc::clone)
            };
            if let Some(stdin) = stdin {
                let mut stdin = stdin.lock().unwrap();
                let _ = stdin.write_all(format!("{reply}\n").as_bytes());
                let _ = stdin.flush();
            }
            return;
        }
        // 通知：无需处理
        return;
    }

    let Some(id) = id else {
        return;
    };
    let numeric_id = match id {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => util::js_trim(text).parse::<u64>().ok(),
        _ => None,
    };
    let Some(numeric_id) = numeric_id else {
        return;
    };
    let sender = shared.state.lock().unwrap().pending.remove(&numeric_id);
    let Some(sender) = sender else {
        return;
    };

    if let Some(error) = message.get("error").filter(|value| !value.is_null()) {
        let code = error
            .get("code")
            .map(util::js_string)
            .unwrap_or_else(|| "undefined".to_string());
        let text = error
            .get("message")
            .map(util::js_string)
            .unwrap_or_else(|| "undefined".to_string());
        let _ = sender.send(Err(format!("MCP 错误 {code}: {text}")));
    } else {
        let _ = sender.send(Ok(message.get("result").cloned().unwrap_or(Value::Null)));
    }
}

fn reject_all_pending(shared: &StdioShared, error: &str) {
    let senders: Vec<Sender<Result<Value, String>>> = {
        let mut state = shared.state.lock().unwrap();
        state.pending.drain().map(|(_, sender)| sender).collect()
    };
    for sender in senders {
        let _ = sender.send(Err(error.to_string()));
    }
}

fn handle_exit(shared: &Arc<StdioShared>) {
    let (was_running, child, callback) = {
        let mut state = shared.state.lock().unwrap();
        let was_running = state.running;
        state.running = false;
        state.initialized = false;
        state.stdin = None;
        let child = state.child.take();
        let callback = state.on_exit.clone();
        (was_running, child, callback)
    };

    if !was_running {
        // 主动 stop()：不触发 onExit，也不重复 reject
        return;
    }

    let reason = reap_exit_reason(child);
    shared.state.lock().unwrap().exit_reason = Some(reason.clone());
    reject_all_pending(shared, &format!("MCP server \"{}\" 进程已退出", shared.name));
    if let Some(callback) = callback {
        callback(Some(reason));
    }
}

/// 读取子进程退出码（有界等待，避免 stdout 已关闭但进程迟迟不退出时卡住）
fn reap_exit_reason(mut child: Option<Child>) -> String {
    let Some(child) = child.as_mut() else {
        return "exit code unknown".to_string();
    };
    for _ in 0..200 {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status
                    .code()
                    .map(|code| format!("exit code {code}"))
                    .unwrap_or_else(|| "exit code unknown".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break,
        }
    }
    "exit code unknown".to_string()
}

// ==================== McpTool.ts ====================

/// LLM API 允许的工具名字符集，其余字符替换为下划线（对齐 `sanitizeNamePart`）。
///
/// 按 **UTF-16 code unit** 替换，与 JS 正则 `[^a-zA-Z0-9_-]` 的 `g` 语义一致
/// （非 BMP 字符会被替换成两个下划线）。
pub fn sanitize_name_part(value: &str) -> String {
    value
        .encode_utf16()
        .map(|unit| match char::from_u32(unit as u32) {
            Some(ch) if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' => ch,
            _ => '_',
        })
        .collect()
}

/// 生成暴露给 LLM 的工具名：`mcp__<server>__<tool>`（对齐 `buildMcpToolName`）
pub fn build_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        sanitize_name_part(server_name),
        sanitize_name_part(tool_name)
    )
}

/// 把一个 MCP 工具定义包装成内部工具契约（对齐 `createMcpTool`）。
///
/// Rust 侧的工具是 JSON 定义（`{ name, description, input_schema }`），
/// 与 `tools::definitions()` 的形状一致，可直接注入 `getAllTools`。
pub fn create_mcp_tool_definition(
    server_name: &str,
    exposed_name: &str,
    definition: &McpToolDefinition,
) -> Value {
    let description = definition
        .description
        .as_deref()
        .map(util::js_trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
        .unwrap_or_else(|| {
            format!(
                "Tool \"{}\" provided by MCP server \"{server_name}\".",
                definition.name
            )
        });
    let input_schema = definition
        .input_schema
        .clone()
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
    json!({
        "name": exposed_name,
        "description": description,
        "input_schema": input_schema,
    })
}

/// MCP 工具注解里的 `readOnlyHint === true`（对齐 `createMcpTool` 的 `isReadOnly`）
pub fn annotations_read_only(definition: &McpToolDefinition) -> bool {
    definition
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("readOnlyHint"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// MCP 工具注解里的 `destructiveHint === true`
pub fn annotations_destructive(definition: &McpToolDefinition) -> bool {
    definition
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("destructiveHint"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

// ==================== Manager.ts ====================

/// 引用归零后延迟回收的宽限期（毫秒）
pub const RECLAIM_GRACE_MS: u64 = 1500;

/// 仅测试用：覆盖延迟回收宽限期，避免单测真的等 1.5s
#[cfg(test)]
static TEST_RECLAIM_GRACE_MS: Mutex<Option<u64>> = Mutex::new(None);

#[cfg(test)]
pub fn set_test_reclaim_grace_ms(grace_ms: Option<u64>) {
    *TEST_RECLAIM_GRACE_MS.lock().unwrap() = grace_ms;
}

fn reclaim_grace_ms() -> u64 {
    #[cfg(test)]
    {
        if let Some(grace) = *TEST_RECLAIM_GRACE_MS.lock().unwrap() {
            return grace;
        }
    }
    RECLAIM_GRACE_MS
}

/// 单个 MCP 服务器的运行时状态
///
/// 供 MCP 面板展示（对齐 `pushMcpServers` 的 `mcpServers` 契约），
/// 经 `servers_with_runtime` 应答 `UiRequest.mcpServersRequested`。
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerRuntimeStatus {
    pub running: bool,
    pub tool_count: usize,
    pub error: Option<String>,
    /// 当前引用该服务器的会话数
    pub ref_count: usize,
}

/// 暴露工具名 → 所属 server / 原始工具名 / 注解
#[derive(Clone, Debug)]
struct ToolRoute {
    server: String,
    tool: String,
    read_only: bool,
    destructive: bool,
}

/// 单个 MCP server 的运行时条目
struct ServerRuntime {
    name: String,
    client: Option<Arc<dyn McpClient>>,
    /// 引用该服务器的会话 ID 集合（替代计数器，天然幂等）
    refs: Vec<String>,
    /// 是否使用远程（HTTP/SSE）传输
    remote: bool,
    /// 期望的启动命令（来自最近一次同步；远程传输为空）
    command: Vec<String>,
    /// 期望的环境变量（来自最近一次同步；远程传输为空）
    environment: Vec<(String, String)>,
    /// 期望的远程端点（来自最近一次同步；本地传输为空）
    url: String,
    /// 期望的远程请求头（来自最近一次同步；本地传输为空）
    headers: Vec<(String, String)>,
    /// 期望的配置签名
    desired_signature: String,
    /// 当前 client 实际对应的配置签名；空串表示尚未成功启动
    active_signature: String,
    /// 引用归零后的延迟回收截止时间（None 表示无待回收）
    reclaim_deadline: Option<Instant>,
    error: Option<String>,
}

#[derive(Default)]
struct ManagerState {
    /// 按插入顺序排列的 server 条目（对齐 JS Map 的迭代顺序）
    servers: Vec<ServerRuntime>,
    /// sessionId -> 该会话当前持有的 server 名集合，release 时据此精确回退
    session_refs: HashMap<String, Vec<String>>,
    /// 已连接 MCP 服务器的工具定义（同步返回，供 getAllTools 使用）
    tools: Vec<Value>,
    /// 暴露工具名 -> 所属 MCP server 名（用于按会话过滤）
    tool_servers: HashMap<String, String>,
    /// 暴露工具名 -> 路由与注解
    tool_routes: HashMap<String, ToolRoute>,
    /// 上次重建时的工具名签名
    tools_signature: String,
}

impl ManagerState {
    fn server(&self, name: &str) -> Option<&ServerRuntime> {
        self.servers.iter().find(|runtime| runtime.name == name)
    }

    fn server_mut(&mut self, name: &str) -> Option<&mut ServerRuntime> {
        self.servers
            .iter_mut()
            .find(|runtime| runtime.name == name)
    }

    fn remove_server(&mut self, name: &str) -> Option<ServerRuntime> {
        let index = self
            .servers
            .iter()
            .position(|runtime| runtime.name == name)?;
        Some(self.servers.remove(index))
    }
}

/// 把 string -> string 映射归一化为可比较的片段（key 排序，避免顺序影响签名）
fn map_signature(map: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = map.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    sorted
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\u{1}")
}

/// 把传输类型 + 命令 / 环境 / url / 请求头归一化为可比较的配置签名
fn build_signature(
    remote: bool,
    command: &[String],
    environment: &[(String, String)],
    url: &str,
    headers: &[(String, String)],
) -> String {
    let transport = if remote {
        format!("remote\u{3}{url}\u{3}{}", map_signature(headers))
    } else {
        "local".to_string()
    };
    format!(
        "{transport}\u{2}{}\u{2}{}",
        command.join("\u{1}"),
        map_signature(environment)
    )
}

/// 判断两个字符串集合是否相等（元素相同，与顺序无关）
fn same_string_set(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().all(|value| b.iter().any(|other| other == value))
}

type Task = Box<dyn FnOnce() + Send>;

/// MCP 管理器（进程级单例，引用计数模型，对齐 `McpManager`）
pub struct McpManager {
    state: Arc<Mutex<ManagerState>>,
    sender: Mutex<Sender<Task>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Drop for McpManager {
    fn drop(&mut self) {
        // 丢掉 Sender 让工作线程退出，再 join，避免残留任务在下一个用例里读配置
        if let Ok(sender) = self.sender.get_mut() {
            let (replacement, _receiver) = mpsc::channel::<Task>();
            *sender = replacement;
        }
        if let Ok(worker) = self.worker.get_mut() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }
}

impl McpManager {
    fn new() -> McpManager {
        let state = Arc::new(Mutex::new(ManagerState::default()));
        let (sender, receiver) = mpsc::channel::<Task>();
        let worker_state = Arc::clone(&state);
        let worker = std::thread::spawn(move || worker_loop(receiver, worker_state));
        McpManager {
            state,
            sender: Mutex::new(sender),
            worker: Mutex::new(Some(worker)),
        }
    }

    /// 把一次状态变更排入串行链
    fn enqueue(&self, task: impl FnOnce() + Send + 'static) {
        let _ = self.sender.lock().unwrap().send(Box::new(task));
    }

    /// 排入串行链并等待完成（`callTool` 需要先确保 server 已启动）
    fn enqueue_wait(&self, task: impl FnOnce() + Send + 'static) {
        let (sender, receiver) = mpsc::channel::<()>();
        self.enqueue(move || {
            task();
            let _ = sender.send(());
        });
        let _ = receiver.recv();
    }

    /// 会话打开：按该会话当前的启用列表建立引用（幂等）
    ///
    /// MCP 会话生命周期尚未接入生产路径（见 `main.rs` 的 MCP 迁移缺口），
    /// 当前由对等测试驱动。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn acquire(&self, session_id: &str) {
        self.sync_session(session_id);
    }

    /// 会话启用列表变化：对该会话做差量同步
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn sync_session(&self, session_id: &str) {
        let state = Arc::clone(&self.state);
        let session_id = session_id.to_string();
        self.enqueue(move || sync_session_internal(&state, &session_id));
    }

    /// 会话关闭 / 删除：释放该会话持有的全部引用
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn release(&self, session_id: &str) {
        let state = Arc::clone(&self.state);
        let session_id = session_id.to_string();
        self.enqueue(move || release_internal(&state, &session_id));
    }

    /// 重新同步所有已注册会话（全局默认配置变化时使用）
    pub fn sync_all_sessions(&self) {
        let state = Arc::clone(&self.state);
        self.enqueue(move || {
            let sessions: Vec<String> = state.lock().unwrap().session_refs.keys().cloned().collect();
            for session_id in sessions {
                sync_session_internal(&state, &session_id);
            }
        });
    }

    /// 启动时清理：不主动启动任何 server，只回收无引用的残留并重新对齐已注册会话
    pub fn prune(&self) {
        let state = Arc::clone(&self.state);
        self.enqueue(move || prune_internal(&state));
    }

    /// 转发一次工具调用到对应服务器（进程崩溃后若仍有引用会自动重启）
    pub fn call_tool(
        &self,
        server_name: &str,
        tool_name: &str,
        args: &Value,
    ) -> Result<McpCallResult, String> {
        let running = {
            let state = self.state.lock().unwrap();
            state
                .server(server_name)
                .and_then(|runtime| runtime.client.as_ref())
                .map(|client| client.is_running())
                .unwrap_or(false)
        };
        if !running {
            let state = Arc::clone(&self.state);
            let server_name = server_name.to_string();
            self.enqueue_wait(move || {
                if state.lock().unwrap().server(&server_name).is_none() {
                    return;
                }
                ensure_started(&state);
                if rebuild_tools(&state) {
                    invalidate_prompt_caches();
                }
            });
        }

        let client = {
            let state = self.state.lock().unwrap();
            state
                .server(server_name)
                .and_then(|runtime| runtime.client.clone())
        };
        let Some(client) = client else {
            let error = {
                let state = self.state.lock().unwrap();
                state
                    .server(server_name)
                    .and_then(|runtime| runtime.error.clone())
            };
            return Err(format!(
                "MCP server \"{server_name}\" 未运行{}",
                error.map(|error| format!("（{error}）")).unwrap_or_default()
            ));
        };
        if !client.is_running() {
            let error = {
                let state = self.state.lock().unwrap();
                state
                    .server(server_name)
                    .and_then(|runtime| runtime.error.clone())
            };
            return Err(format!(
                "MCP server \"{server_name}\" 未运行{}",
                error.map(|error| format!("（{error}）")).unwrap_or_default()
            ));
        }
        client.call_tool(tool_name, args)
    }

    /// 各服务器的运行时状态，供 UI 展示
    pub fn get_server_status(&self) -> Vec<(String, McpServerRuntimeStatus)> {
        let state = self.state.lock().unwrap();
        state
            .servers
            .iter()
            .map(|runtime| {
                (
                    runtime.name.clone(),
                    McpServerRuntimeStatus {
                        running: runtime
                            .client
                            .as_ref()
                            .map(|client| client.is_running())
                            .unwrap_or(false),
                        tool_count: runtime
                            .client
                            .as_ref()
                            .map(|client| client.get_tools().len())
                            .unwrap_or(0),
                        error: runtime.error.clone(),
                        ref_count: runtime.refs.len(),
                    },
                )
            })
            .collect()
    }

    /// 停止所有 MCP 进程（宿主退出时调用）
    pub fn shutdown(&self) {
        let runtimes: Vec<ServerRuntime> = {
            let mut state = self.state.lock().unwrap();
            state.session_refs.clear();
            state.tools.clear();
            state.tool_servers.clear();
            state.tool_routes.clear();
            state.tools_signature.clear();
            std::mem::take(&mut state.servers)
        };
        for runtime in runtimes {
            if let Some(client) = runtime.client {
                client.stop();
            }
        }
    }

    /// 当前已连接 MCP 服务器的工具（同步）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn get_tools(&self) -> Vec<Value> {
        self.state.lock().unwrap().tools.clone()
    }

    /// 只返回属于给定 server 集合的 MCP 工具
    pub fn get_tools_for_servers(&self, enabled_servers: &HashSet<String>) -> Vec<Value> {
        let state = self.state.lock().unwrap();
        state
            .tools
            .iter()
            .filter(|tool| {
                let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
                state
                    .tool_servers
                    .get(name)
                    .map(|server| enabled_servers.contains(server))
                    .unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    /// 暴露工具名 → `(server, tool)`；未注册时返回 None
    pub fn resolve_tool(&self, exposed_name: &str) -> Option<(String, String)> {
        let state = self.state.lock().unwrap();
        state
            .tool_routes
            .get(exposed_name)
            .map(|route| (route.server.clone(), route.tool.clone()))
    }

    /// 暴露工具名对应的注解（readOnly / destructive）
    pub fn tool_annotations(&self, exposed_name: &str) -> Option<(bool, bool)> {
        let state = self.state.lock().unwrap();
        state
            .tool_routes
            .get(exposed_name)
            .map(|route| (route.read_only, route.destructive))
    }

    /// 会话打开 → 同步引用 + 广播事实（对齐 `MCPHost.onSessionOpened`）
    pub fn host_session_opened(&self, session_id: &str) {
        let state = Arc::clone(&self.state);
        let session_id = session_id.to_string();
        self.enqueue(move || {
            sync_session_internal(&state, &session_id);
            notify_servers_changed(&session_id);
        });
    }

    /// 会话关闭 → 释放引用（对齐 `MCPHost.onSessionClosed`）
    pub fn host_session_closed(&self, session_id: &str) {
        let state = Arc::clone(&self.state);
        let session_id = session_id.to_string();
        self.enqueue(move || release_internal(&state, &session_id));
    }

    /// 会话启用列表变化 → 差量同步 + 广播事实（对齐 `MCPHost.onSessionEnabledChanged`）
    pub fn host_session_enabled_changed(&self, session_id: &str) {
        let state = Arc::clone(&self.state);
        let session_id = session_id.to_string();
        self.enqueue(move || {
            sync_session_internal(&state, &session_id);
            notify_servers_changed(&session_id);
        });
    }
}

fn worker_loop(receiver: Receiver<Task>, state: Arc<Mutex<ManagerState>>) {
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(task) => task(),
            Err(RecvTimeoutError::Timeout) => run_due_reclaims(&state),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 处理到期的延迟回收（宽限期结束后真正停进程）
fn run_due_reclaims(state: &Arc<Mutex<ManagerState>>) {
    let due: Vec<String> = {
        let state = state.lock().unwrap();
        let now = Instant::now();
        state
            .servers
            .iter()
            .filter(|runtime| {
                runtime.refs.is_empty()
                    && runtime
                        .reclaim_deadline
                        .map(|deadline| deadline <= now)
                        .unwrap_or(false)
            })
            .map(|runtime| runtime.name.clone())
            .collect()
    };
    for name in due {
        reclaim_internal(state, &name);
    }
}

/// 按该会话当前配置，差量调整其引用集合（对齐 `syncSessionInternal`）
fn sync_session_internal(state: &Arc<Mutex<ManagerState>>, session_id: &str) {
    // 过滤空值与历史遗留的字符串 'undefined'，避免建立无效引用导致无法回收
    if session_id.is_empty() || session_id == "undefined" {
        return;
    }

    let servers = mcp_config::read_mcp_servers(Some(session_id));
    let enabled: Vec<McpServerInfo> = servers.into_iter().filter(|server| server.enabled).collect();
    let desired: HashMap<String, McpServerInfo> = enabled
        .iter()
        .map(|server| (server.name.clone(), server.clone()))
        .collect();

    let prev = state
        .lock()
        .unwrap()
        .session_refs
        .get(session_id)
        .cloned()
        .unwrap_or_default();

    // 1. 释放该会话不再启用的 server
    for name in &prev {
        if !desired.contains_key(name) {
            detach_ref(state, name, session_id);
        }
    }
    // 2. 新增 / 更新该会话启用的 server（含配置变更检测）
    for (name, info) in &desired {
        attach_ref(state, name, session_id, info);
    }

    let next: Vec<String> = desired.keys().cloned().collect();
    let session_changed = !same_string_set(&prev, &next);
    state
        .lock()
        .unwrap()
        .session_refs
        .insert(session_id.to_string(), next);

    // 3. 确保所有仍有引用的 server 都已启动
    ensure_started(state);
    // 4. 重建工具列表；只有工具集合真的变化时才清空 prompt 缓存
    if rebuild_tools(state) {
        invalidate_prompt_caches();
    }
    // 5. 本会话启用集合变化：单独失效该会话的 prompt / 工具缓存
    if session_changed {
        invalidate_session_prompt_cache(session_id);
    }
}

/// 释放该会话持有的全部引用（对齐 `releaseInternal`）
fn release_internal(state: &Arc<Mutex<ManagerState>>, session_id: &str) {
    let refs = state
        .lock()
        .unwrap()
        .session_refs
        .remove(session_id)
        .unwrap_or_default();
    if refs.is_empty() {
        return;
    }
    eprintln!(
        "[core] mcp: 释放会话 {session_id} 的 {} 个 MCP 引用",
        refs.len()
    );
    for name in refs {
        detach_ref(state, &name, session_id);
    }
}

/// 给某会话增加对某个 server 的引用，并更新期望配置（对齐 `attachRef`）
fn attach_ref(state: &Arc<Mutex<ManagerState>>, name: &str, session_id: &str, info: &McpServerInfo) {
    let remote = info.is_remote();
    let signature = build_signature(
        remote,
        &info.command,
        &info.environment,
        &info.url,
        &info.headers,
    );

    let mut guard = state.lock().unwrap();
    if guard.server(name).is_none() {
        guard.servers.push(ServerRuntime {
            name: name.to_string(),
            client: None,
            refs: Vec::new(),
            remote,
            command: info.command.clone(),
            environment: info.environment.clone(),
            url: info.url.clone(),
            headers: info.headers.clone(),
            desired_signature: signature.clone(),
            active_signature: String::new(),
            reclaim_deadline: None,
            error: None,
        });
    }
    let runtime = guard.server_mut(name).expect("just inserted");
    runtime.remote = remote;
    runtime.command = info.command.clone();
    runtime.environment = info.environment.clone();
    runtime.url = info.url.clone();
    runtime.headers = info.headers.clone();
    runtime.desired_signature = signature;

    // 宽限期内被重新引用：取消回收
    if runtime.reclaim_deadline.take().is_some() {
        eprintln!("[core] mcp: MCP \"{name}\" 在回收宽限期内被重新引用，保留进程");
    }

    if !runtime.refs.iter().any(|existing| existing == session_id) {
        runtime.refs.push(session_id.to_string());
    }
}

/// 移除某会话对某个 server 的引用，归零时安排延迟回收（对齐 `detachRef`）
fn detach_ref(state: &Arc<Mutex<ManagerState>>, name: &str, session_id: &str) {
    let empty = {
        let mut guard = state.lock().unwrap();
        let Some(runtime) = guard.server_mut(name) else {
            return;
        };
        runtime.refs.retain(|existing| existing != session_id);
        runtime.refs.is_empty()
    };
    if empty {
        schedule_reclaim(state, name);
    }
}

/// 引用归零：延迟 `RECLAIM_GRACE_MS` 后回收，容忍切换抖动（对齐 `scheduleReclaim`）
fn schedule_reclaim(state: &Arc<Mutex<ManagerState>>, name: &str) {
    let mut guard = state.lock().unwrap();
    let Some(runtime) = guard.server_mut(name) else {
        return;
    };
    runtime.reclaim_deadline = Some(Instant::now() + Duration::from_millis(reclaim_grace_ms()));
    eprintln!("[core] mcp: MCP \"{name}\" 引用归零，{}ms 后回收", reclaim_grace_ms());
}

/// 真正停止引用归零的 server 进程（对齐 `reclaimInternal`）
fn reclaim_internal(state: &Arc<Mutex<ManagerState>>, name: &str) {
    let client = {
        let mut guard = state.lock().unwrap();
        let Some(runtime) = guard.server_mut(name) else {
            return;
        };
        // 宽限期内又被引用：不回收
        if !runtime.refs.is_empty() {
            runtime.reclaim_deadline = None;
            return;
        }
        runtime.reclaim_deadline = None;
        let client = runtime.client.take();
        runtime.active_signature.clear();
        runtime.error = None;
        guard.remove_server(name);
        client
    };

    if let Some(client) = client {
        eprintln!("[core] mcp: 停止 MCP \"{name}\"（引用归零）");
        client.stop();
    }

    if rebuild_tools(state) {
        invalidate_prompt_caches();
    }
}

/// 启动所有仍有引用但尚未运行的 server（对齐 `ensureStarted`）
fn ensure_started(state: &Arc<Mutex<ManagerState>>) {
    let names: Vec<String> = {
        let guard = state.lock().unwrap();
        guard
            .servers
            .iter()
            .filter(|runtime| !runtime.refs.is_empty())
            .filter(|runtime| {
                !runtime
                    .client
                    .as_ref()
                    .map(|client| {
                        client.is_running() && runtime.active_signature == runtime.desired_signature
                    })
                    .unwrap_or(false)
            })
            .map(|runtime| runtime.name.clone())
            .collect()
    };
    for name in names {
        start_runtime(state, &name);
    }
}

/// 启动单个 server；配置变化或进程已退出时会先停掉旧进程再重启（对齐 `startRuntime`）
fn start_runtime(state: &Arc<Mutex<ManagerState>>, name: &str) {
    let snapshot = {
        let mut guard = state.lock().unwrap();
        let Some(runtime) = guard.server_mut(name) else {
            return;
        };
        if let Some(client) = runtime.client.take() {
            client.stop();
        }
        runtime.active_signature.clear();
        // 新一轮启动开始：清掉上一次的失败信息，让 UI 显示「连接中」而不是旧的「连接失败」
        runtime.error = None;
        (
            runtime.remote,
            runtime.command.clone(),
            runtime.environment.clone(),
            runtime.url.clone(),
            runtime.headers.clone(),
            runtime.desired_signature.clone(),
        )
    };
    let (remote, command, environment, url, headers, start_signature) = snapshot;

    let client: Arc<dyn McpClient> = if remote {
        Arc::new(McpHttpClient::new(name, &url, &headers))
    } else {
        Arc::new(McpStdioClient::new(name, &command, &environment))
    };

    // 连接意外断开时保留引用集合，等待下次 ensureStarted / callTool 重启
    {
        let state_for_exit = Arc::clone(state);
        let name_for_exit = name.to_string();
        client.set_on_exit(Arc::new(move |reason| {
            let count = state_for_exit
                .lock()
                .unwrap()
                .server(&name_for_exit)
                .map(|runtime| runtime.refs.len())
                .unwrap_or(0);
            eprintln!(
                "[core] mcp: MCP \"{name_for_exit}\" 连接已断开{}，保留 {count} 个引用",
                reason.map(|reason| format!("（{reason}）")).unwrap_or_default()
            );
        }));
    }

    {
        let mut guard = state.lock().unwrap();
        if let Some(runtime) = guard.server_mut(name) {
            runtime.client = Some(Arc::clone(&client));
        } else {
            // server 已被回收（极端并发）：放弃本次启动
            client.stop();
            return;
        }
    }

    match client.start() {
        Ok(()) => {
            let tool_count = client.get_tools().len();
            let mut guard = state.lock().unwrap();
            if let Some(runtime) = guard.server_mut(name) {
                runtime.active_signature = start_signature;
                runtime.error = None;
            }
            eprintln!("[core] mcp: MCP \"{name}\" 已连接，发现 {tool_count} 个工具");
        }
        Err(err) => {
            eprintln!("[core] mcp: MCP \"{name}\" 启动失败: {err}");
            client.stop();
            let mut guard = state.lock().unwrap();
            if let Some(runtime) = guard.server_mut(name) {
                runtime.error = Some(err);
                runtime.active_signature.clear();
                if runtime
                    .client
                    .as_ref()
                    .map(|existing| Arc::ptr_eq(existing, &client))
                    .unwrap_or(false)
                {
                    runtime.client = None;
                }
            }
        }
    }
}

/// 启动时清理：重新对齐已注册会话，并回收无引用的残留（对齐 `pruneInternal`）
fn prune_internal(state: &Arc<Mutex<ManagerState>>) {
    let sessions: Vec<String> = state.lock().unwrap().session_refs.keys().cloned().collect();
    for session_id in sessions {
        sync_session_internal(state, &session_id);
    }

    let stale: Vec<String> = {
        let guard = state.lock().unwrap();
        guard
            .servers
            .iter()
            .filter(|runtime| runtime.refs.is_empty() && runtime.reclaim_deadline.is_none())
            .map(|runtime| runtime.name.clone())
            .collect()
    };
    for name in stale {
        schedule_reclaim(state, &name);
    }
}

/// 重建工具列表；返回工具集合是否发生变化（对齐 `rebuildTools`）
fn rebuild_tools(state: &Arc<Mutex<ManagerState>>) -> bool {
    let mut tools: Vec<Value> = Vec::new();
    let mut routes: HashMap<String, ToolRoute> = HashMap::new();
    let mut tool_servers: HashMap<String, String> = HashMap::new();

    {
        let guard = state.lock().unwrap();
        for runtime in &guard.servers {
            let Some(client) = runtime.client.as_ref() else {
                continue;
            };
            if !client.is_running() {
                continue;
            }
            for definition in client.get_tools() {
                let exposed_name = build_mcp_tool_name(&runtime.name, &definition.name);
                if routes.contains_key(&exposed_name) {
                    eprintln!("[core] mcp: 工具名冲突，跳过 {exposed_name}");
                    continue;
                }
                routes.insert(
                    exposed_name.clone(),
                    ToolRoute {
                        server: runtime.name.clone(),
                        tool: definition.name.clone(),
                        read_only: annotations_read_only(&definition),
                        destructive: annotations_destructive(&definition),
                    },
                );
                tool_servers.insert(exposed_name.clone(), runtime.name.clone());
                tools.push(create_mcp_tool_definition(
                    &runtime.name,
                    &exposed_name,
                    &definition,
                ));
            }
        }
    }

    let signature = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("|");

    let mut guard = state.lock().unwrap();
    let changed = signature != guard.tools_signature;
    guard.tools = tools;
    guard.tool_servers = tool_servers;
    guard.tool_routes = routes;
    guard.tools_signature = signature;
    changed
}

/// 引擎每轮重新组装 system prompt / 工具列表，没有 prompt 缓存，
/// 因此这两个失效入口是空实现。
fn invalidate_prompt_caches() {}

fn invalidate_session_prompt_cache(_session_id: &str) {}

// ==================== 单例与 MCPHost 入口 ====================

static MANAGER: Mutex<Option<Arc<McpManager>>> = Mutex::new(None);

/// 获取 MCP 管理器单例
pub fn manager() -> Arc<McpManager> {
    let mut guard = MANAGER.lock().unwrap();
    if guard.is_none() {
        *guard = Some(Arc::new(McpManager::new()));
    }
    guard.as_ref().unwrap().clone()
}

/// 管理器是否已创建（未创建时同步查询走空表，避免无谓初始化）
fn manager_if_created() -> Option<Arc<McpManager>> {
    MANAGER.lock().unwrap().clone()
}

/// 仅测试用：停掉并丢弃单例，让下一个用例从干净状态开始
#[cfg(test)]
pub fn reset_manager() {
    let previous = MANAGER.lock().unwrap().take();
    if let Some(manager) = previous {
        manager.shutdown();
    }
}

/// 「该会话的 MCP 服务器状态已变化」的上报出口（由引擎接线注入）。
///
/// 参数为 `(sessionId, 该会话启用的 server 名列表)`；对齐 `MCPHost.notifyServersChanged`
/// 里 `emitToUi({ type: 'sessionConfigChanged', ... })` 的载荷。
pub type ServersChangedSink = Arc<dyn Fn(&str, Vec<String>) + Send + Sync>;

static SERVERS_CHANGED_SINK: Mutex<Option<ServersChangedSink>> = Mutex::new(None);

/// 注册「服务器状态变化」上报出口
pub fn set_servers_changed_sink(sink: ServersChangedSink) {
    *SERVERS_CHANGED_SINK.lock().unwrap() = Some(sink);
}

fn notify_servers_changed(session_id: &str) {
    let sink = SERVERS_CHANGED_SINK.lock().unwrap().clone();
    let Some(sink) = sink else {
        return;
    };
    let servers = mcp_config::read_mcp_servers(Some(session_id));
    let names: Vec<String> = servers
        .iter()
        .filter(|server| server.enabled)
        .map(|server| server.name.clone())
        .collect();
    sink(session_id, names);
}

/// 会话被打开 → 建立引用（幂等）
pub fn on_session_opened(session_id: &str) {
    if session_id.is_empty() || session_id == "undefined" {
        return;
    }
    manager().host_session_opened(session_id);
}

/// 会话被关闭 → 释放引用（归零的 server 进入延迟回收）
pub fn on_session_closed(session_id: &str) {
    if session_id.is_empty() || session_id == "undefined" {
        return;
    }
    manager().host_session_closed(session_id);
}

/// 该会话的启用列表变化（勾选 / 取消 / 全局默认变更）→ 差量同步
pub fn on_session_enabled_changed(session_id: &str) {
    if session_id.is_empty() || session_id == "undefined" {
        return;
    }
    manager().host_session_enabled_changed(session_id);
}

/// 启动时清理没有任何会话引用的残留进程
pub fn prune() {
    manager().prune();
}

/// 宿主退出：结束全部 MCP 子进程，避免留下孤儿进程
pub fn shutdown() {
    if let Some(manager) = manager_if_created() {
        manager.shutdown();
    }
}

/// 同步获取当前已连接的 MCP 工具（全局）。
/// 管理器尚未创建（从未 acquire）时返回空数组，避免无谓的初始化。
#[cfg_attr(not(test), allow(dead_code))]
pub fn get_tools() -> Vec<Value> {
    manager_if_created()
        .map(|manager| manager.get_tools())
        .unwrap_or_default()
}

/// 同步获取「某个会话启用的 server」对应的 MCP 工具。
pub fn get_tools_for_servers(enabled_servers: &HashSet<String>) -> Vec<Value> {
    manager_if_created()
        .map(|manager| manager.get_tools_for_servers(enabled_servers))
        .unwrap_or_default()
}

/// 同步获取某个会话应暴露的 MCP 工具（读该会话的启用列表后过滤）
pub fn tools_for_session(session_id: &str) -> Vec<Value> {
    let enabled: HashSet<String> = mcp_config::read_enabled_mcps(Some(session_id))
        .into_iter()
        .collect();
    get_tools_for_servers(&enabled)
}

/// 各服务器的运行时状态（供 UI 展示）
pub fn get_server_status() -> Vec<(String, McpServerRuntimeStatus)> {
    manager_if_created()
        .map(|manager| manager.get_server_status())
        .unwrap_or_default()
}

/// 重新同步所有已注册会话（全局默认配置变化时使用）
pub fn sync_all_sessions() {
    manager().sync_all_sessions();
}

/// 读 `mcp.json` + 会话启用状态（转发 Config 的读取路径，UI 面板用）。
///
/// [`servers_with_runtime`] 复用它。
pub fn read_servers(session_id: Option<&str>) -> Vec<McpServerInfo> {
    mcp_config::read_mcp_servers(session_id)
}

/// 组装 UI 的 `mcpServers` 列表：配置（`mcp.json`）+ 启用状态 + 运行时状态。
///
/// 对齐 `webviewMessageHandler.pushMcpServers`：未连接的服务器补
/// `running=false / toolCount=0 / error=null / refCount=0`。
/// 经 `UiRequest.mcpServersRequested` 应答宿主。
pub fn servers_with_runtime(session_id: Option<&str>) -> Vec<Value> {
    let status: HashMap<String, McpServerRuntimeStatus> =
        get_server_status().into_iter().collect();
    read_servers(session_id)
        .into_iter()
        .map(|server| {
            let runtime = status.get(&server.name);
            let mut value = server.to_json();
            if let Some(object) = value.as_object_mut() {
                object.insert(
                    "running".to_string(),
                    json!(runtime.map(|status| status.running).unwrap_or(false)),
                );
                object.insert(
                    "toolCount".to_string(),
                    json!(runtime.map(|status| status.tool_count).unwrap_or(0)),
                );
                object.insert(
                    "error".to_string(),
                    runtime
                        .and_then(|status| status.error.clone())
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                );
                object.insert(
                    "refCount".to_string(),
                    json!(runtime.map(|status| status.ref_count).unwrap_or(0)),
                );
            }
            value
        })
        .collect()
}

/// 该工具名是否是 MCP 暴露的工具（`mcp__` 前缀）
pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__")
}

/// 该 MCP 工具是否可并发执行（对齐 `isConcurrencySafe: () => readOnlyHint`）
pub fn is_concurrency_safe(name: &str) -> bool {
    manager_if_created()
        .and_then(|manager| manager.tool_annotations(name))
        .map(|(read_only, _)| read_only)
        .unwrap_or(false)
}

/// 该 MCP 工具是否具破坏性（对齐 `isDestructive: () => destructiveHint`）。
///
/// MCP 工具接入权限判定前保留该契约入口，暂无生产调用方。
#[allow(dead_code)]
pub fn is_destructive(name: &str) -> bool {
    manager_if_created()
        .and_then(|manager| manager.tool_annotations(name))
        .map(|(_, destructive)| destructive)
        .unwrap_or(false)
}

/// 执行一个 MCP 工具调用，返回与内置工具同形的 [`crate::tools::ToolOutcome`]。
///
/// 工具调用的行为契约：
/// - 成功 / `isError` 都走「成功」通道（`mapToolResultToToolResultBlockParam` 只给
///   错误内容加 `[MCP error] ` 前缀，不设 `is_error`）；空文本兜底 `(no output)`；
/// - 转发失败（服务器未运行 / 超时等）走错误通道。
pub fn execute_tool(name: &str, input: &Value) -> crate::tools::ToolOutcome {
    use crate::tools::ToolOutcome;

    let args = if input.is_object() {
        input.clone()
    } else {
        json!({})
    };
    let Some(manager) = manager_if_created() else {
        return ToolOutcome::Error(format!("MCP tool \"{name}\" 未注册"));
    };
    let Some((server, tool)) = manager.resolve_tool(name) else {
        return ToolOutcome::Error(format!("MCP tool \"{name}\" 未注册"));
    };
    match manager.call_tool(&server, &tool, &args) {
        Ok(result) => {
            let text = if result.text.is_empty() {
                "(no output)".to_string()
            } else {
                result.text
            };
            let content = if result.is_error {
                format!("[MCP error] {text}")
            } else {
                text
            };
            let content = if content.is_empty() {
                "(no output)".to_string()
            } else {
                content
            };
            ToolOutcome::Success(content)
        }
        Err(err) => ToolOutcome::Error(err),
    }
}

#[cfg(test)]
#[path = "mcp_tests.rs"]
mod tests;

//! `mcp_http` 单测：Streamable HTTP 握手 / 头回传 / SSE 响应，以及旧版 HTTP+SSE 回退。
//!
//! 自己写了一个可编程的假 HTTP 服务器（比 `FakeLlm` 更通用：能自定义状态码、响应头、
//! 流式 SSE，并把收到的请求交给闭包），因为 MCP 需要断言 `Mcp-Session-Id` /
//! `MCP-Protocol-Version` 这类请求头，以及「POST 返回 SSE 流」这种响应形态。

use super::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

// ==================== 可编程假 HTTP 服务器 ====================

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub struct FakeHttp {
    pub base_url: String,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl Drop for FakeHttp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl FakeHttp {
    fn start<F>(respond: F) -> FakeHttp
    where
        F: Fn(&Request, &mut TcpStream) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake http");
        let port = listener.local_addr().expect("local addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let respond = Arc::new(respond);
        let handle = std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let respond = Arc::clone(&respond);
                        // 每连接一个线程：旧版 SSE 的长连接不能堵住 accept 循环
                        std::thread::spawn(move || {
                            let request = read_http_request(&mut stream);
                            respond(&request, &mut stream);
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        FakeHttp {
            base_url: format!("http://127.0.0.1:{port}"),
            stop,
            handle: Some(handle),
        }
    }
}

fn read_http_request(stream: &mut TcpStream) -> Request {
    let mut reader = BufReader::new(stream.try_clone().expect("clone stream"));
    let mut request_line = String::new();
    let _ = reader.read_line(&mut request_line);
    let mut parts = request_line.trim_end().split(' ');
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        let _ = reader.read_exact(&mut body);
    }
    Request {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).to_string(),
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "Status",
    }
}

fn write_response(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &str) {
    let mut head = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    let mut has_length = false;
    for (key, value) in headers {
        if key.eq_ignore_ascii_case("content-length") {
            has_length = true;
        }
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    if !has_length {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

fn write_json(stream: &mut TcpStream, status: u16, headers: &[(&str, &str)], body: &Value) {
    write_response(stream, status, headers, &body.to_string());
}

// ==================== Streamable HTTP ====================

#[test]
fn http_streamable_handshake_headers_and_sse_response() {
    let captured: Arc<Mutex<Vec<Request>>> = Arc::new(Mutex::new(Vec::new()));
    let captured_handler = Arc::clone(&captured);

    let server = FakeHttp::start(move |request, stream| {
        captured_handler.lock().unwrap().push(request.clone());
        if request.method == "DELETE" {
            write_response(stream, 200, &[], "");
            return;
        }
        let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
        let method = body.get("method").and_then(Value::as_str).unwrap_or("");
        let id = body.get("id").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => write_json(
                stream,
                200,
                &[("Mcp-Session-Id", "sess-1")],
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "serverInfo": { "name": "fake", "version": "1" },
                    }
                }),
            ),
            "notifications/initialized" => write_response(stream, 202, &[], ""),
            "tools/list" => write_json(
                stream,
                200,
                &[],
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "tools": [{ "name": "echo", "description": "Echo" }] }
                }),
            ),
            "tools/call" => {
                // 响应走 text/event-stream
                let frame = format!(
                    "event: message\ndata: {}\n\n",
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "content": [{ "type": "text", "text": "hi" }] }
                    })
                );
                write_response(
                    stream,
                    200,
                    &[("Content-Type", "text/event-stream"), ("Connection", "close")],
                    &frame,
                );
            }
            _ => write_json(
                stream,
                200,
                &[],
                &json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            ),
        }
    });

    let headers = vec![("Authorization".to_string(), "Bearer t".to_string())];
    let client = McpHttpClient::new("remote", &server.base_url, &headers);
    client.start().expect("streamable start");
    assert!(client.is_running());
    assert!(client.is_initialized());
    assert_eq!(client.get_tools().len(), 1);
    assert_eq!(client.get_tools()[0].name, "echo");

    let result = client.call_tool("echo", &json!({})).expect("call");
    assert_eq!(result.text, "hi");
    assert!(!result.is_error);

    client.stop();
    assert!(!client.is_running());

    let requests = captured.lock().unwrap();
    let find = |needle: &str| {
        requests
            .iter()
            .find(|request| request.body.contains(needle))
            .cloned()
            .unwrap_or_else(|| panic!("no request containing {needle}: {requests:?}"))
    };

    let initialize = find("\"method\":\"initialize\"");
    assert_eq!(
        initialize.headers.get("authorization").map(String::as_str),
        Some("Bearer t")
    );
    assert_eq!(
        initialize.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    assert!(initialize.headers.get("mcp-session-id").is_none());
    assert!(initialize.headers.get("mcp-protocol-version").is_none());

    let list = find("\"method\":\"tools/list\"");
    assert_eq!(
        list.headers.get("mcp-session-id").map(String::as_str),
        Some("sess-1")
    );
    assert_eq!(
        list.headers.get("mcp-protocol-version").map(String::as_str),
        Some("2025-03-26")
    );

    // stop() 会尽力 DELETE 会话
    assert!(requests.iter().any(|request| request.method == "DELETE"));
}

#[test]
fn http_streamable_json_error_response_is_reported() {
    let server = FakeHttp::start(move |request, stream| {
        if request.method == "DELETE" {
            write_response(stream, 200, &[], "");
            return;
        }
        let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
        let id = body.get("id").cloned().unwrap_or(Value::Null);
        write_json(
            stream,
            200,
            &[],
            &json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": -32000, "message": "boom" }
            }),
        )
    });

    let client = McpHttpClient::new("remote", &server.base_url, &[]);
    let error = client.start().unwrap_err();
    assert!(error.contains("-32000"), "{error}");
    assert!(error.contains("boom"), "{error}");
    // 两种传输都失败时给出合并错误
    assert!(error.contains("Streamable HTTP"), "{error}");
    assert!(error.contains("旧版 SSE"), "{error}");
}

#[test]
fn http_rejects_missing_or_invalid_url() {
    let client = McpHttpClient::new("remote", "", &[]);
    let error = client.start().unwrap_err();
    assert!(error.contains("缺少 url"), "{error}");

    let client = McpHttpClient::new("remote", "not a url", &[]);
    let error = client.start().unwrap_err();
    assert!(error.contains("url 非法"), "{error}");
}

// ==================== 旧版 HTTP + SSE 回退 ====================

#[test]
fn http_falls_back_to_legacy_sse() {
    // 旧版 SSE 长连接的推送通道
    let sse_sender: Arc<Mutex<Option<mpsc::Sender<String>>>> = Arc::new(Mutex::new(None));
    let sse_handler = Arc::clone(&sse_sender);
    let sse_handler_for_test = Arc::clone(&sse_sender);

    let server = FakeHttp::start(move |request, stream| {
        if request.method == "GET" {
            // 建立 SSE 长连接，下发 endpoint 事件，之后按需推送 message 事件
            let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(b"event: endpoint\ndata: /messages\n\n");
            let _ = stream.flush();

            let (sender, receiver) = mpsc::channel::<String>();
            *sse_handler.lock().unwrap() = Some(sender);
            while let Ok(message) = receiver.recv() {
                let frame = format!("event: message\ndata: {message}\n\n");
                if stream.write_all(frame.as_bytes()).is_err() || stream.flush().is_err() {
                    break;
                }
            }
            return;
        }
        if request.method == "DELETE" {
            write_response(stream, 200, &[], "");
            return;
        }

        let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
        let method = body.get("method").and_then(Value::as_str).unwrap_or("");
        let id = body.get("id").cloned().unwrap_or(Value::Null);

        if request.path == "/" {
            // Streamable 尝试直接失败 → 触发旧版 SSE 回退
            write_response(stream, 500, &[], "nope");
            return;
        }

        // 旧版：POST 到 endpoint，立刻 202，结果走 SSE 长连接
        write_response(stream, 202, &[], "");
        let sender = sse_sender.lock().unwrap().clone();
        let Some(sender) = sender else {
            return;
        };
        let message = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "serverInfo": { "name": "fake", "version": "1" }
                }
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "tools": [{ "name": "echo" }] }
            }),
            "tools/call" => json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": { "content": [{ "type": "text", "text": "legacy hi" }] }
            }),
            _ => return,
        };
        let _ = sender.send(message.to_string());
    });

    let client = McpHttpClient::new("legacy", &server.base_url, &[]);
    client.start().expect("legacy start");
    assert!(client.is_running());
    assert!(client.is_initialized());
    assert_eq!(client.get_tools().len(), 1);

    let result = client.call_tool("echo", &json!({})).expect("legacy call");
    assert_eq!(result.text, "legacy hi");

    client.stop();
    // 关掉推送通道，让假服务器的 SSE 连接线程退出
    *sse_handler_for_test.lock().unwrap() = None;
}

// ==================== SSE 解析纯函数 ====================

#[test]
fn sse_block_parsing_matches_spec() {
    assert_eq!(
        parse_sse_block("event: endpoint\ndata: /messages"),
        Some(SseEvent {
            event: "endpoint".to_string(),
            data: "/messages".to_string(),
        })
    );
    assert_eq!(
        parse_sse_block("data: line1\ndata: line2"),
        Some(SseEvent {
            event: "message".to_string(),
            data: "line1\nline2".to_string(),
        })
    );
    // 注释行 / 无 data 的行都被忽略
    assert_eq!(parse_sse_block(": ping"), None);
    assert_eq!(parse_sse_block("event: x"), None);
    // 冒号后可选的单个空格被剥掉，其它空白保留
    assert_eq!(
        parse_sse_block("data:  two"),
        Some(SseEvent {
            event: "message".to_string(),
            data: " two".to_string(),
        })
    );
}

#[test]
fn drain_sse_events_keeps_trailing_buffer() {
    let (events, rest) = drain_sse_events("data: a\n\ndata: b\n\ndata: par");
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].data, "a");
    assert_eq!(events[1].data, "b");
    assert_eq!(rest, "data: par");
}

#[test]
fn parse_sse_data_rejects_non_object_json() {
    assert_eq!(parse_sse_data("{\"a\":1}"), Some(json!({ "a": 1 })));
    assert_eq!(parse_sse_data("  "), None);
    assert_eq!(parse_sse_data("nope"), None);
    assert_eq!(parse_sse_data("[1]"), None);
}

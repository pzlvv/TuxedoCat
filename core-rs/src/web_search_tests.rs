//! `web_search.rs` 的用例。
//!
//! 公开入口（`run_web_search` / `run_web_fetch`）的 Key 解析走配置快照、端点固定为
//! DeepSeek 官方，无法指向假服务器；因此用两层覆盖：
//! - 纯函数（校验 / 拼装 / 错误映射）直接单测；
//! - 执行路径经 `post_tool_request` 打本地 `TcpListener` 一_shot 假服务器
//!   （200 / 402 / 429 / 超时），不打外网。
//! 公开入口另测「未配置服务商不发请求」与参数校验两条不发请求的分支。

use std::io::{Read, Write};
use std::net::TcpListener;

use serde_json::json;

use super::*;
use crate::test_support::Sandbox;
use crate::tools::ToolOutcome;

// ---------- 参数校验 ----------

#[test]
fn search_query_must_be_a_non_blank_string() {
    assert!(validate_search_query(&json!({ "query": "DeepSeek V4" })).is_ok());
    assert_eq!(
        validate_search_query(&json!({ "query": "   " })).unwrap_err(),
        "WebSearch: \"query\" must not be blank"
    );
    assert_eq!(
        validate_search_query(&json!({})).unwrap_err(),
        "WebSearch: \"query\" is required and must be a string"
    );
    // 非字符串（数字 / null）同缺参
    assert!(validate_search_query(&json!({ "query": 42 })).is_err());
}

#[test]
fn search_query_length_uses_unicode_chars() {
    let long = "字".repeat(129);
    assert!(validate_search_query(&json!({ "query": long })).is_err());
    let exact = "字".repeat(128);
    assert!(validate_search_query(&json!({ "query": exact })).is_ok());
    // 首尾空白在长度判定前去掉
    let padded = format!("  {}  ", "x".repeat(128));
    assert!(validate_search_query(&json!({ "query": padded })).is_ok());
}

#[test]
fn fetch_url_validation() {
    assert!(validate_fetch_url("https://example.com/article").is_ok());
    assert!(validate_fetch_url("http://example.com").is_ok());
    // 非 HTTP(S)
    assert!(validate_fetch_url("ftp://example.com/x").is_err());
    // 无 host（注意：url crate 按 WHATWG 把 `https:///path` 归一成 host="path"，
    // 不算无 host；真正无 host 的是 `https://`）
    assert!(validate_fetch_url("https://").is_err());
    // 带凭证
    assert!(validate_fetch_url("https://user:pass@example.com/x").is_err());
    // 非法
    assert!(validate_fetch_url("not a url").is_err());
    // 超长
    let long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS));
    assert!(validate_fetch_url(&long).is_err());
}

// ---------- 结果拼装 ----------

#[test]
fn search_results_render_meta_and_summaries() {
    let data = json!({
        "results": [
            {
                "rerank_score": 2.4,
                "title": "DeepSeek V4 模型发布",
                "url": "https://example.com/v4",
                "snippet": "已上线",
                "summary": "V4 改进工具调用与长上下文。",
                "site_name": "Example News",
                "date": "2026-06-01T00:00:00+00:00"
            },
            {
                "title": "Bare",
                "url": "https://example.com/bare"
            }
        ]
    });
    let text = format_search_results(&data);
    assert!(text.contains("- DeepSeek V4 模型发布 — https://example.com/v4 (score 2.4, Example News, 2026-06-01T00:00:00+00:00)"));
    assert!(text.contains("  summary: V4 改进工具调用与长上下文。"));
    // 缺失的可选字段全部省略
    assert!(text.contains("- Bare — https://example.com/bare"));
}

#[test]
fn empty_search_results_render_a_notice() {
    assert_eq!(format_search_results(&json!({ "results": [] })), "No results found.");
    // results 缺失 / 非数组同「无结果」
    assert_eq!(format_search_results(&json!({})), "No results found.");
}

#[test]
fn fetch_result_renders_title_and_content() {
    let data = json!({ "title": "Example article", "content": "# Example article\n\nBody." });
    assert_eq!(
        format_fetch_result(&data),
        "# Example article\n\n# Example article\n\nBody."
    );
    // title 缺失：只给正文
    assert_eq!(
        format_fetch_result(&json!({ "content": "Body." })),
        "Body."
    );
}

// ---------- 错误映射 ----------

#[test]
fn http_error_mapping_by_status() {
    let map = |status: Option<u16>, message: &str| {
        map_http_error(&HttpToolError {
            status,
            message: message.to_string(),
        })
    };
    let e400 = map(Some(400), "'count' must be between 1 and 50");
    assert!(e400.contains("HTTP 400") && e400.contains("'count' must be between 1 and 50"));
    assert!(!e400.contains("retry"), "非可重试 4xx 不附重试提示: {e400}");

    let e402 = map(Some(402), "balance insufficient");
    assert!(e402.contains("HTTP 402") && e402.contains("insufficient DeepSeek account balance"));

    let e429 = map(Some(429), "rate limited");
    assert!(e429.contains("HTTP 429") && e429.contains("wait and retry later"));

    let e500 = map(Some(500), "internal error");
    assert!(e500.contains("HTTP 500") && e500.contains("wait and retry later"));

    let e408 = map(Some(408), "timeout");
    assert!(e408.contains("wait and retry later"));

    let network = map(None, "connection reset");
    assert!(network.contains("network error or timeout"));
}

// ---------- 执行路径（本地一_shot 假服务器） ----------

/// 起一个只服务一次请求的 HTTP 假服务器，返回其 base url 与响应句柄。
fn one_shot_server(response: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind one-shot http");
    let url = format!("http://{}", listener.local_addr().expect("local addr"));
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // 读完请求头（读到空行）再回响应，避免 RST 掐断
            let mut buf = [0u8; 4096];
            let mut received = Vec::new();
            loop {
                match stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        received.extend_from_slice(&buf[..n]);
                        if received.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    url
}

#[test]
fn post_request_parses_success_json() {
    let url = one_shot_server(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 27\r\nConnection: close\r\n\r\n{\"results\":[{\"title\":\"t\"}]}".to_string(),
    );
    let value = post_tool_request(&format!("{url}/v1/tools/search"), "key", &json!({ "query": "q" }), 5)
        .expect("success response");
    assert_eq!(
        value.get("results").and_then(|r| r.get(0)).and_then(|e| e.get("title")),
        Some(&json!("t"))
    );
}

#[test]
fn post_request_maps_error_body_message() {
    let body = "{\"error\":{\"message\":\"'count' must be between 1 and 50\",\"type\":\"invalid_request_error\"}}";
    let url = one_shot_server(format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    ));
    let error = post_tool_request(&format!("{url}/v1/tools/search"), "key", &json!({}), 5)
        .expect_err("400 must be an error");
    assert_eq!(error.status, Some(400));
    assert_eq!(error.message, "'count' must be between 1 and 50");
}

#[test]
fn post_request_times_out_on_silent_socket() {
    // 只接受连接、永不回包：1 秒超时必须以网络层错误返回
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind silent server");
    let url = format!("http://{}", listener.local_addr().expect("local addr"));
    std::thread::spawn(move || {
        let hold = listener.accept();
        std::thread::sleep(std::time::Duration::from_secs(3));
        drop(hold);
    });
    let error = post_tool_request(&format!("{url}/v1/tools/fetch"), "key", &json!({ "url": "https://x" }), 1)
        .expect_err("silent socket must time out");
    assert!(error.status.is_none());
    assert!(map_http_error(&error).contains("network error or timeout"));
}

// ---------- 公开入口 ----------

#[test]
fn run_web_search_without_provider_errors_without_request() {
    let _sandbox = Sandbox::new("web-search-no-provider");
    match run_web_search(&json!({ "query": "q" })) {
        ToolOutcome::Error(message) => {
            assert!(message.contains("no api.deepseek.com provider is configured"), "{message}");
        }
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn run_web_search_validates_query_before_key_lookup() {
    // 无 provider 也先拦参数错误：参数校验在 Key 解析之前
    let _sandbox = Sandbox::new("web-search-blank-query");
    match run_web_search(&json!({ "query": "  " })) {
        ToolOutcome::Error(message) => assert!(message.contains("must not be blank")),
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn run_web_fetch_validates_url() {
    let _sandbox = Sandbox::new("web-fetch-bad-url");
    match run_web_fetch(&json!({ "url": "ftp://example.com" })) {
        ToolOutcome::Error(message) => assert!(message.contains("http or https")),
        other => panic!("expected error, got {other:?}"),
    }
    match run_web_fetch(&json!({})) {
        ToolOutcome::Error(message) => assert!(message.contains("\"url\" is required")),
        other => panic!("expected error, got {other:?}"),
    }
}

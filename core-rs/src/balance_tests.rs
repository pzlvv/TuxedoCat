//! `balance.rs` 的用例。
//!
//! 余额接口的地址固定为 DeepSeek 官方，无法在测试里改指向假服务器，因此这里覆盖
//! 可测的两半：provider 查找（纯 settings 读取）与 hostname 归一化。
//! HTTP 分支靠「没配 provider 时不发请求」这条不变式间接保证。

use serde_json::json;

use super::*;
use crate::test_support::Sandbox;

#[test]
fn base_url_hostname_lowercases_and_strips_paths() {
    assert_eq!(base_url_hostname(&json!("https://API.DeepSeek.com/v1")), "api.deepseek.com");
    assert_eq!(base_url_hostname(&json!("  https://api.deepseek.com  ")), "api.deepseek.com");
    assert_eq!(base_url_hostname(&json!("not a url")), "");
    assert_eq!(base_url_hostname(&json!("")), "");
    assert_eq!(base_url_hostname(&json!(null)), "");
    assert_eq!(base_url_hostname(&json!(42)), "");
}

#[test]
fn base_url_hostname_trims_with_js_whitespace() {
    // 对齐 `baseUrlHostname` 的 `baseURL.trim()`（JS 口径）：U+FEFF 去掉、U+0085 保留。
    assert_eq!(
        base_url_hostname(&json!("\u{FEFF}https://api.deepseek.com\u{FEFF}")),
        "api.deepseek.com",
    );
    // U+0085 不被 JS trim 去掉，URL 解析失败 → 空串
    assert_eq!(base_url_hostname(&json!("\u{0085}https://api.deepseek.com")), "");
}

#[test]
fn provider_key_and_api_key_trim_with_js_whitespace() {
    let sandbox = Sandbox::new("balance-js-whitespace");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                // provider key 前后带 U+FEFF：JS trim 后就是域名
                "\u{FEFF}api.deepseek.com\u{FEFF}": { "apiKey": "\u{FEFF}deepseek-key\u{FEFF}" },
            },
        },
    }));
    // apiKey 也必须用 JS 口径 trim（Rust `str::trim` 不去 U+FEFF）
    assert_eq!(deepseek_provider_api_key(), Some("deepseek-key".to_string()));
}

#[test]
fn no_provider_means_no_api_key() {
    let _sandbox = Sandbox::new("balance-no-provider");
    assert_eq!(deepseek_provider_api_key(), None);
}

#[test]
fn finds_the_deepseek_provider_by_hostname() {
    let sandbox = Sandbox::new("balance-by-host");
    sandbox.write_settings(json!({
        "llm": {
            "activeProvider": "gateway",
            "providers": {
                "gateway": { "baseURL": "https://opencode.ai/v1", "apiKey": "gateway-key" },
                // 带路径 / 大写域名也要认出来
                "official": { "baseURL": "https://API.DeepSeek.com/v1", "apiKey": "deepseek-key" },
            },
        },
    }));
    assert_eq!(deepseek_provider_api_key(), Some("deepseek-key".to_string()));
}

#[test]
fn finds_the_deepseek_provider_by_key_name() {
    let sandbox = Sandbox::new("balance-by-key");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                // key 恰好是域名、baseURL 缺失
                "api.deepseek.com": { "apiKey": "key-from-name" },
            },
        },
    }));
    assert_eq!(deepseek_provider_api_key(), Some("key-from-name".to_string()));
}

#[test]
fn a_matching_provider_without_a_key_falls_through() {
    let sandbox = Sandbox::new("balance-empty-key");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                "official": { "baseURL": "https://api.deepseek.com", "apiKey": "   " },
            },
        },
    }));
    // 只有空白 apiKey 时视为没配：不要拿空白 Key 去打接口
    assert_eq!(deepseek_provider_api_key(), None);
}

#[test]
fn active_provider_is_ignored() {
    let sandbox = Sandbox::new("balance-active-provider");
    sandbox.write_settings(json!({
        "llm": {
            "activeProvider": "official",
            "providers": {
                "official": { "baseURL": "https://api.deepseek.com", "apiKey": "deepseek-key" },
                "gateway": { "baseURL": "https://opencode.ai/v1", "apiKey": "gateway-key" },
            },
        },
    }));
    // 只认域名，不认 activeProvider（activeProvider 是网关时不能拿它的 Key）
    assert_eq!(deepseek_provider_api_key(), Some("deepseek-key".to_string()));
}

#[test]
fn balance_url_is_the_official_endpoint() {
    assert_eq!(balance_url(), "https://api.deepseek.com/user/balance");
}

/// 超时上限 3 秒（specs/defects/balance-fetch-blocks-frame-loop）：状态条装饰性
/// 信息，挂住的请求不值得让任何等待方等更久。
#[test]
fn balance_timeout_is_three_seconds() {
    assert_eq!(BALANCE_TIMEOUT_SECS, 3);
}

/// HTTP 分支：假服务器返回合法响应体时解析成余额；超时 / 非 2xx / 缺字段回 None。
#[test]
fn fetch_balance_parses_a_served_response() {
    let sandbox = Sandbox::new("balance-served");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                "official": { "baseURL": "https://api.deepseek.com", "apiKey": "deepseek-key" },
            },
        },
    }));
    let base = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n\
         {\"balance_infos\":[{\"total_balance\":\"12.34\",\"currency\":\"CNY\"}],\
         \"is_available\":true,\"is_unlimited\":false}",
    );
    set_base_url_for_test(Some(&base));

    let balance = fetch_balance().expect("合法响应应解析出余额");
    set_base_url_for_test(None);
    assert_eq!(balance["totalBalance"], json!(12.34));
    assert_eq!(balance["currency"], json!("CNY"));
    assert_eq!(balance["isUnlimited"], json!(false));
    assert!(balance["fetchedAt"].as_u64().unwrap() > 0);
}

#[test]
fn fetch_balance_returns_none_when_the_server_fails() {
    let sandbox = Sandbox::new("balance-server-error");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                "official": { "baseURL": "https://api.deepseek.com", "apiKey": "deepseek-key" },
            },
        },
    }));
    // 非 2xx：按失败处理（宿主清空旧余额）
    let base = serve_once("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    set_base_url_for_test(Some(&base));
    assert!(fetch_balance().is_none());
    set_base_url_for_test(None);
}

/// 起一个只应答一次的 HTTP 假服务器，返回其 base url。
///
/// 读到请求头结束（空行）后一次性写出 `response` 并关闭连接——
/// 与 `web_search_tests` 的假服务器同一手法。
fn serve_once(response: &'static str) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind one-shot server");
    let url = format!("http://{}", listener.local_addr().expect("local addr"));
    std::thread::spawn(move || {
        let Ok((mut socket, _)) = listener.accept() else {
            return;
        };
        let mut buf = [0u8; 1024];
        // 读到请求头结束即可应答（不看请求体）
        loop {
            match socket.read(&mut buf) {
                Ok(0) => return,
                Ok(_) => {
                    if buf.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => return,
            }
        }
        let _ = socket.write_all(response.as_bytes());
    });
    url
}

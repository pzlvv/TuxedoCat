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

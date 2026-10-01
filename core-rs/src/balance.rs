//! DeepSeek 账户余额查询（对齐 Embedded `src/core/utils/balance.ts`）。
//!
//! 服务地址固定为 DeepSeek 官方（`DEEPSEEK_BASE_URL`），Key 取 `settings.json` 里
//! 「hostname 是 `api.deepseek.com`」那个 provider 的 `apiKey`——**与 active provider
//! 无关**。active provider 通常是第三方网关，拿它的 Key 打官方余额接口只会拿到 401。
//! 没有该 provider（或它没配 apiKey）时直接返回 `None`，不发请求。
//!
//! Standalone 下宿主不读 `settings.json`（core 的事实），因此余额查询整体在 Core 侧
//! 完成；宿主经 `UiRequest.balanceRequested` 取结果。

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::util;

/// DeepSeek 官方 baseURL（对齐 `DEEPSEEK_BASE_URL`）
pub const DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";

/// 余额接口（路径挂在 baseURL 下）
fn balance_url() -> String {
    format!("{DEEPSEEK_BASE_URL}/user/balance")
}

/// 取 baseURL 的 hostname（小写）；解析失败或为空返回空串
/// （对齐 `baseUrlHostname`，用 `reqwest::Url` 而不是手写解析）。
fn base_url_hostname(base_url: &Value) -> String {
    let Some(raw) = base_url.as_str() else {
        return String::new();
    };
    let trimmed = util::js_trim(raw);
    if trimmed.is_empty() {
        return String::new();
    }
    reqwest::Url::parse(trimmed)
        .ok()
        .and_then(|url| url.host_str().map(|host| host.to_lowercase()))
        .unwrap_or_default()
}

/// 「api.deepseek.com」这个 provider 的 API Key；找不到时为 `None`。
///
/// provider 表来自配置快照（Core 不读 `settings.json`）。
pub fn deepseek_provider_api_key() -> Option<String> {
    let snapshot = crate::settings::settings_snapshot().ok()?;
    let target = base_url_hostname(&json!(DEEPSEEK_BASE_URL));
    for (key, provider) in &snapshot.llm.providers {
        let matches = base_url_hostname(&json!(provider.base_url)) == target
            || (!util::js_trim(key).is_empty() && util::js_trim(key).to_lowercase() == target);
        if !matches {
            continue;
        }
        let api_key = util::js_trim(&provider.api_key);
        if !api_key.is_empty() {
            return Some(api_key.to_string());
        }
    }
    None
}

/// 当前毫秒时间戳（对齐 `Date.now()`）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 查询余额。
///
/// 返回 `{ totalBalance, currency, isUnlimited, fetchedAt }`；未配置
/// `api.deepseek.com` provider、请求失败或响应里没有 `balance_infos` 时返回 `None`
/// （调用方据此清空 UI 上的旧余额）。
pub fn fetch_balance() -> Option<Value> {
    let api_key = deepseek_provider_api_key()?;

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .ok()?;
    let response = client
        .get(balance_url())
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data: Value = response.json().ok()?;

    // 响应格式：{ "balance_infos": [{ "total_balance": "xxx", "currency": "xxx" }],
    //            "is_available": true, "is_unlimited": false }
    let balance_infos = data.get("balance_infos").and_then(Value::as_array)?;
    let first = balance_infos.first()?;
    // `parseFloat(String(x || '0'))`：字段缺失 / 非数字都回落到 0
    let total_balance = match first.get("total_balance") {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => util::js_trim(text).parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    let currency = match first.get("currency") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => "CNY".to_string(),
    };
    Some(json!({
        "totalBalance": total_balance,
        "isUnlimited": data.get("is_unlimited").map(|value| value == &Value::Bool(true)).unwrap_or(false),
        "currency": currency,
        "fetchedAt": now_ms(),
    }))
}

#[cfg(test)]
#[path = "balance_tests.rs"]
mod tests;

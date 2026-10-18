//! 联网搜索与网页抓取工具（DeepSeek Search / Fetch API）。
//!
//! 两个只读工具的执行与错误映射：
//! - `WebSearch`：`POST {DEEPSEEK_BASE_URL}/v1/tools/search`，按 query 搜索网页，
//!   返回逐条 `rerank_score / title / url / snippet / summary / site_name / date`
//!   （正文不返回——需要正文用 `WebFetch`）；
//! - `WebFetch`：`POST {DEEPSEEK_BASE_URL}/v1/tools/fetch`，抓取单个网页，返回
//!   `title` 与 Markdown 正文；超长正文由 `tools::cap_tool_result` 的统一上限承担。
//!
//! 鉴权与余额查询同一口径：Key 取配置快照里 baseURL host 为 `api.deepseek.com`
//! 的 provider（`balance.rs::deepseek_provider_api_key`），与 active provider 无关。
//! 工具是否下发由引擎按会话的联网搜索生效值过滤（`engine.rs`）。
//!
//! 错误口径（不自动重试；错误文本附提示，由模型决定是否再次调用）：
//! - 未配置 DeepSeek 服务商 / 参数非法：直接工具错误，不发请求；
//! - HTTP 402：注明账户余额不足；
//! - HTTP 408 / 429 / 5xx、网络与超时错误：附「稍后可重试」提示；
//! - 其余 4xx：透传状态码与 `error.message`，不附重试提示。
//! API Key 只进请求头，不进错误文本。

use serde_json::{json, Value};

use crate::balance::{deepseek_provider_api_key, DEEPSEEK_BASE_URL};
use crate::tools::ToolOutcome;
use crate::util;

/// 请求整体超时
const REQUEST_TIMEOUT_SECS: u64 = 30;
/// `query` 上限（Unicode 字符数，API 口径 1–128）
const MAX_QUERY_CHARS: usize = 128;
/// `url` 上限（API 口径 ≤8192）
const MAX_URL_CHARS: usize = 8192;

/// Search 接口路径（挂在 DEEPSEEK_BASE_URL 下）
fn search_url() -> String {
    format!("{DEEPSEEK_BASE_URL}/v1/tools/search")
}

/// Fetch 接口路径
fn fetch_url() -> String {
    format!("{DEEPSEEK_BASE_URL}/v1/tools/fetch")
}

/// `WebSearch` 工具入口：校验 → 解析 Key → 执行 → 拼装结果。
pub fn run_web_search(input: &Value) -> ToolOutcome {
    let query = match validate_search_query(input) {
        Ok(query) => query,
        Err(message) => return ToolOutcome::Error(message),
    };
    let count = input.get("count").cloned();
    let Some(api_key) = deepseek_provider_api_key() else {
        return ToolOutcome::Error(no_provider_error("WebSearch"));
    };
    // count 未提供时整体省略（写成 null 可能被接口判为非法值），取接口默认 10
    let mut body = json!({
        "query": query,
        // 正文不随搜索返回：summary 已足够模型判断，需要正文再调 WebFetch
        "need_content": false,
    });
    if let Some(count) = count {
        body["count"] = count;
    }
    match execute_tool_request(&search_url(), &api_key, &body) {
        Ok(data) => ToolOutcome::Success(format_search_results(&data)),
        Err(message) => ToolOutcome::Error(message),
    }
}

/// `WebFetch` 工具入口：校验 URL → 解析 Key → 执行 → 拼装结果。
pub fn run_web_fetch(input: &Value) -> ToolOutcome {
    let url = match input_get_string(input, "url") {
        Some(url) if !url.is_empty() => url,
        _ => {
            return ToolOutcome::Error("WebFetch: \"url\" is required and must be a string".to_string())
        }
    };
    if let Err(message) = validate_fetch_url(&url) {
        return ToolOutcome::Error(message);
    }
    let Some(api_key) = deepseek_provider_api_key() else {
        return ToolOutcome::Error(no_provider_error("WebFetch"));
    };
    match execute_tool_request(&fetch_url(), &api_key, &json!({ "url": url })) {
        Ok(data) => ToolOutcome::Success(format_fetch_result(&data)),
        Err(message) => ToolOutcome::Error(message),
    }
}

/// 未配置 DeepSeek 服务商时的错误（指明配置路径，不静默）
fn no_provider_error(tool: &str) -> String {
    format!(
        "{tool}: no api.deepseek.com provider is configured. \
Add a provider with baseURL {DEEPSEEK_BASE_URL} (and its apiKey) in settings.json to enable web tools."
    )
}

/// 取字符串字段（缺失 / 非字符串 → None）
fn input_get_string(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(|text| text.to_string())
}

/// `query` 校验：必填字符串、去首尾空白后非空、≤128 个 Unicode 字符。
fn validate_search_query(input: &Value) -> Result<String, String> {
    let Some(query) = input_get_string(input, "query") else {
        return Err("WebSearch: \"query\" is required and must be a string".to_string());
    };
    let trimmed = util::js_trim(&query).to_string();
    if trimmed.is_empty() {
        return Err("WebSearch: \"query\" must not be blank".to_string());
    }
    if trimmed.chars().count() > MAX_QUERY_CHARS {
        return Err(format!(
            "WebSearch: \"query\" must be at most {MAX_QUERY_CHARS} characters"
        ));
    }
    Ok(trimmed)
}

/// `WebSearch` 的语义校验（供 `tools::validate_input` 与工具入口共用）。
pub fn validate_search_input(input: &Value) -> Result<String, String> {
    validate_search_query(input)
}

/// `WebFetch` 的语义校验（供 `tools::validate_input` 与工具入口共用）：
/// url 必填 + URL 形态校验。
pub fn validate_fetch_input(input: &Value) -> Result<(), String> {
    let Some(url) = input_get_string(input, "url") else {
        return Err("WebFetch: \"url\" is required and must be a string".to_string());
    };
    if url.is_empty() {
        return Err("WebFetch: \"url\" must not be empty".to_string());
    }
    validate_fetch_url(&url)
}

/// `url` 校验：HTTP/HTTPS、含 host、不带用户名密码、≤8192 字符。
fn validate_fetch_url(url: &str) -> Result<(), String> {
    if url.chars().count() > MAX_URL_CHARS {
        return Err(format!(
            "WebFetch: \"url\" must be at most {MAX_URL_CHARS} characters"
        ));
    }
    let parsed = reqwest::Url::parse(url).map_err(|err| {
        format!("WebFetch: invalid url ({err})")
    })?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("WebFetch: \"url\" must be an http or https url".to_string());
    }
    if parsed.host_str().map_or(true, |host| host.is_empty()) {
        return Err("WebFetch: \"url\" must include a host".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("WebFetch: \"url\" must not carry credentials".to_string());
    }
    Ok(())
}

/// HTTP 层错误：状态码（网络层错误没有）+ 已拼好的面向模型的错误文本。
#[derive(Debug)]
struct HttpToolError {
    status: Option<u16>,
    message: String,
}

/// 执行一次工具 POST：Bearer 鉴权、30s 超时、错误按模块口径映射。
fn execute_tool_request(url: &str, api_key: &str, body: &Value) -> Result<Value, String> {
    match post_tool_request(url, api_key, body, REQUEST_TIMEOUT_SECS) {
        Ok(value) => Ok(value),
        Err(error) => Err(map_http_error(&error)),
    }
}

/// 发请求并解析 JSON 响应；HTTP 非 2xx / 网络 / 解析失败都走 `HttpToolError`。
fn post_tool_request(
    url: &str,
    api_key: &str,
    body: &Value,
    timeout_secs: u64,
) -> Result<Value, HttpToolError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .build()
        .map_err(|err| HttpToolError {
            status: None,
            message: err.to_string(),
        })?;
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(body)
        .send()
        .map_err(|err| HttpToolError {
            status: None,
            message: err.to_string(),
        })?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        // OpenAI 兼容错误格式：{ "error": { "message": "...", ... } }
        let body_text = response.text().unwrap_or_default();
        let api_message = serde_json::from_str::<Value>(&body_text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| body_text.trim().to_string());
        return Err(HttpToolError {
            status: Some(status),
            message: api_message,
        });
    }
    response
        .json::<Value>()
        .map_err(|err| HttpToolError {
            status: None,
            message: err.to_string(),
        })
}

/// 错误映射：402 专述、可重试类附提示；key 不出现在文本里（本函数只拿状态与消息）。
fn map_http_error(error: &HttpToolError) -> String {
    let retryable = match error.status {
        None => true, // 网络 / 超时 / 响应解析失败
        Some(status) => status == 408 || status == 429 || status >= 500,
    };
    match error.status {
        Some(402) => format!(
            "request failed (HTTP 402): {} — insufficient DeepSeek account balance; top up before retrying.",
            error.message
        ),
        Some(status) if retryable => format!(
            "request failed (HTTP {status}): {} — transient error; wait and retry later.",
            error.message
        ),
        Some(status) => format!("request failed (HTTP {status}): {}", error.message),
        None => format!(
            "request failed: {} — network error or timeout; wait and retry later.",
            error.message
        ),
    }
}

/// 拼装搜索结果文本：逐条一行元信息 + summary；空结果给「无结果」。
fn format_search_results(data: &Value) -> String {
    let results = data.get("results").and_then(|value| value.as_array().cloned()).unwrap_or_default();
    if results.is_empty() {
        return "No results found.".to_string();
    }
    let mut lines: Vec<String> = Vec::with_capacity(results.len());
    for entry in results {
        let title = entry.get("title").and_then(Value::as_str).unwrap_or("");
        let url = entry.get("url").and_then(Value::as_str).unwrap_or("");
        let score = entry.get("rerank_score");
        let site = entry.get("site_name").and_then(Value::as_str);
        let date = entry.get("date").and_then(Value::as_str);
        let meta: Vec<String> = [
            score.map(|value| format!("score {value}")),
            site.filter(|text| !text.is_empty()).map(|text| text.to_string()),
            date.filter(|text| !text.is_empty()).map(|text| text.to_string()),
        ]
        .into_iter()
        .flatten()
        .collect();
        let meta_text = if meta.is_empty() {
            String::new()
        } else {
            format!(" ({})", meta.join(", "))
        };
        lines.push(format!("- {title} — {url}{meta_text}"));
        if let Some(snippet) = entry.get("snippet").and_then(Value::as_str) {
            if !snippet.is_empty() {
                lines.push(format!("  snippet: {snippet}"));
            }
        }
        if let Some(summary) = entry.get("summary").and_then(Value::as_str) {
            if !summary.is_empty() {
                lines.push(format!("  summary: {summary}"));
            }
        }
    }
    lines.join("\n")
}

/// 拼装抓取结果文本：`# title` + Markdown 正文（title 缺失为空行省略）。
/// 超长正文不在这一层截断——`tools::cap_tool_result` 的统一上限在引擎侧承担。
fn format_fetch_result(data: &Value) -> String {
    let title = data.get("title").and_then(Value::as_str).unwrap_or("");
    let content = data.get("content").and_then(Value::as_str).unwrap_or("");
    if title.is_empty() {
        content.to_string()
    } else {
        format!("# {title}\n\n{content}")
    }
}

#[cfg(test)]
#[path = "web_search_tests.rs"]
mod tests;

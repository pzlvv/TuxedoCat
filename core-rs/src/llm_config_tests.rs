//! `llm_config.rs` 的用例。
//!
//! 覆盖三块：`providerKeyFromBaseURL` 的两种口径（合法 URL / 退化字符串）、
//! `normalizeModelTokenLimits` 的保留与补齐规则、以及整段 `apply_llm_config_save`
//! 对 `settings.json` 的读-改-写（含「保留用户手填的 context/output」这条关键不变式）。

use serde_json::json;

use super::*;
use crate::test_support::Sandbox;

// ==================== provider key ====================

#[test]
fn provider_key_takes_the_hostname() {
    assert_eq!(provider_key_from_base_url("https://opencode.ai/zen/go"), "opencode.ai");
    assert_eq!(provider_key_from_base_url("https://api.deepseek.com"), "api.deepseek.com");
    // 端口不进 key
    assert_eq!(provider_key_from_base_url("http://127.0.0.1:8080/v1"), "127.0.0.1");
    // 首尾空白
    assert_eq!(provider_key_from_base_url("  https://z.ai  "), "z.ai");
}

#[test]
fn provider_key_trims_with_js_whitespace() {
    // `providerKeyFromBaseURL` 用 JS `String.prototype.trim`：去 U+FEFF、不去 U+0085。
    // Rust 的 `str::trim` 恰好相反，这里用 `util::js_trim` 对齐。
    assert_eq!(provider_key_from_base_url("\u{FEFF}https://z.ai"), "z.ai");
    assert_eq!(provider_key_from_base_url("https://z.ai\u{FEFF}"), "z.ai");
    assert_eq!(provider_key_from_base_url("\u{FEFF}"), "");
    assert_eq!(provider_key_from_base_url("  \u{FEFF}https://z.ai\u{FEFF}  "), "z.ai");
}

#[test]
fn provider_key_falls_back_for_invalid_urls() {
    assert_eq!(provider_key_from_base_url("opencode.ai/zen"), "opencode.ai");
    assert_eq!(provider_key_from_base_url("opencode.ai:8443/zen"), "opencode.ai");
    assert_eq!(provider_key_from_base_url(""), "");
    assert_eq!(provider_key_from_base_url("   "), "");
    // 非法协议名不当作协议剥掉
    assert_eq!(provider_key_from_base_url("1://host"), "1");
}

// ==================== modelConfigs 归一化 ====================

#[test]
fn normalize_models_trims_with_js_whitespace() {
    // `normalizeProviderModels` 的 `m.trim()` 是 JS 口径：U+FEFF 去掉、U+0085 保留。
    let models = normalize_models(Some(&json!([
        "\u{FEFF}m1",
        "\u{0085}m2",
        "   ",
        "\u{FEFF}m1\u{FEFF}",
    ])));
    assert_eq!(models, vec!["m1".to_string(), "\u{0085}m2".to_string()]);
}

#[test]
fn normalize_keeps_valid_existing_limits() {
    let next = normalize_model_token_limits(
        &["m1".to_string()],
        Some(&json!({ "m1": { "context": 200000, "output": 8000 } })),
        None,
    );
    assert_eq!(next["m1"]["context"], json!(200000));
    assert_eq!(next["m1"]["output"], json!(8000));
}

#[test]
fn normalize_drops_invalid_limits_and_fills_from_the_registry() {
    let next = normalize_model_token_limits(
        &["m1".to_string()],
        // 0 / 负数 / 非数字都不算「已存在」
        Some(&json!({ "m1": { "context": 0, "output": -1 } })),
        None,
    );
    assert_eq!(next["m1"]["context"], json!(FALLBACK_CONTEXT_WINDOW));
    assert_eq!(next["m1"]["output"], json!(FALLBACK_MAX_OUTPUT_TOKENS));
}

#[test]
fn normalize_keeps_historical_entries_not_in_the_model_list() {
    let next = normalize_model_token_limits(
        &["m1".to_string()],
        Some(&json!({ "old": { "context": 1234 } })),
        None,
    );
    assert_eq!(next["old"]["context"], json!(1234));
    assert_eq!(next["m1"]["context"], json!(FALLBACK_CONTEXT_WINDOW));
}

#[test]
fn normalize_does_not_invent_an_api_type() {
    // apiType 只接受显式来源：自动填充会让「自动获取」探测被跳过
    let next = normalize_model_token_limits(&["m1".to_string()], None, None);
    assert!(next["m1"].get("apiType").is_none());

    let next = normalize_model_token_limits(
        &["m1".to_string(), "m2".to_string()],
        None,
        Some(&json!({ "m1": "Responses", "m2": "bogus" })),
    );
    assert_eq!(next["m1"]["apiType"], json!("Responses"));
    // 非法取值回落到默认协议
    assert_eq!(next["m2"]["apiType"], json!("OpenAI"));
    // 不在模型列表里的覆盖项不会凭空造条目（与 TS 的循环结构一致）
    let next = normalize_model_token_limits(
        &["m1".to_string()],
        None,
        Some(&json!({ "m3": "Responses" })),
    );
    assert!(next.get("m3").is_none());
}

#[test]
fn normalize_panel_value_overrides_the_stored_one() {
    let next = normalize_model_token_limits(
        &["m1".to_string()],
        Some(&json!({ "m1": { "context": 100, "apiType": "OpenAI" } })),
        Some(&json!({ "m1": "Anthropic" })),
    );
    assert_eq!(next["m1"]["apiType"], json!("Anthropic"));
    assert_eq!(next["m1"]["context"], json!(100));
}

// ==================== resolveModelRef ====================

#[test]
fn resolve_model_ref_falls_back_to_the_active_provider() {
    let cfg = json!({
        "llm": {
            "activeProvider": "a",
            "providers": {
                "a": { "baseURL": "https://a.example", "models": ["m1"], "defaultModel": "m1" },
            },
        },
    });
    // provider 不存在 → 回落 active
    assert_eq!(
        resolve_model_ref(&cfg, "gone", "x"),
        Some(("a".to_string(), "m1".to_string())),
    );
    // 模型不在列表里 → 用该 provider 的默认模型
    assert_eq!(
        resolve_model_ref(&cfg, "a", "nope"),
        Some(("a".to_string(), "m1".to_string())),
    );
    // 模型在列表里 → 原样保留
    assert_eq!(
        resolve_model_ref(&cfg, "a", "m1"),
        Some(("a".to_string(), "m1".to_string())),
    );
}

// ==================== 整段保存 ====================

#[test]
fn save_writes_providers_and_returns_the_saved_state() {
    let sandbox = Sandbox::new("llm-config-save");
    sandbox.write_settings(json!({ "llm": { "maxTokens": 4096 } }));

    let saved = apply_llm_config_save(&json!({
        "saveProviders": true,
        "providers": [
            {
                "baseURL": "https://api.deepseek.com/v1",
                "apiKey": "k1",
                "models": ["deepseek-v4-pro", "deepseek-v4-pro"],
                "defaultModel": "deepseek-v4-pro",
                "modelApiTypes": { "deepseek-v4-pro": "Responses" },
            },
            // 缺 apiKey 的条目整条跳过
            { "baseURL": "https://z.ai", "models": ["glm"] },
        ],
        "activeProvider": "api.deepseek.com",
        "webSearch": false,
        "thinkingEffort": "low",
        "defaultAgentMode": "manual",
        "defaultPromptMode": "minimal",
        "language": "zh",
    }))
    .unwrap();

    let written = sandbox.read_settings();
    let providers = &written["llm"]["providers"];
    assert!(providers.get("api.deepseek.com").is_some());
    assert!(providers.get("z.ai").is_none(), "缺 apiKey 的条目不该写入");
    // 模型去重
    assert_eq!(providers["api.deepseek.com"]["models"], json!(["deepseek-v4-pro"]));
    // modelConfigs 补齐 + 面板给的 apiType
    assert_eq!(
        providers["api.deepseek.com"]["modelConfigs"]["deepseek-v4-pro"]["apiType"],
        json!("Responses"),
    );
    assert_eq!(
        providers["api.deepseek.com"]["modelConfigs"]["deepseek-v4-pro"]["context"],
        json!(FALLBACK_CONTEXT_WINDOW),
    );
    assert_eq!(written["llm"]["webSearch"], json!(false));
    assert_eq!(written["llm"]["thinking_effort"], json!("low"));
    assert_eq!(written["defaultAgentMode"], json!("manual"));
    assert_eq!(written["defaultPromptMode"], json!("minimal"));
    assert_eq!(written["uiLanguage"], json!("zh"));

    // 返回值：宿主组装 webview 回复用的事实
    assert_eq!(saved["model"], json!("deepseek-v4-pro"));
    assert_eq!(saved["activeProvider"], json!("api.deepseek.com"));
    assert_eq!(saved["agentMode"], json!("manual"));
    assert_eq!(saved["promptMode"], json!("minimal"));
    assert_eq!(saved["webSearch"], json!(false));
    assert_eq!(saved["providers"][0]["key"], json!("api.deepseek.com"));
}

#[test]
fn save_preserves_user_edited_limits() {
    let sandbox = Sandbox::new("llm-config-preserve");
    sandbox.write_settings(json!({
        "llm": {
            "providers": {
                "api.deepseek.com": {
                    "baseURL": "https://api.deepseek.com",
                    "apiKey": "old",
                    "models": ["m1"],
                    "modelConfigs": { "m1": { "context": 64000, "output": 4096 } },
                },
            },
        },
    }));

    apply_llm_config_save(&json!({
        "saveProviders": true,
        "providers": [
            { "baseURL": "https://api.deepseek.com", "apiKey": "new", "models": ["m1", "m2"] },
        ],
        "activeProvider": "api.deepseek.com",
    }))
    .unwrap();

    let configs = &sandbox.read_settings()["llm"]["providers"]["api.deepseek.com"]["modelConfigs"];
    // 手填的限值必须保留（这正是 mutation 必须在 Core 侧做的原因）
    assert_eq!(configs["m1"]["context"], json!(64000));
    assert_eq!(configs["m1"]["output"], json!(4096));
    // 新模型补兜底
    assert_eq!(configs["m2"]["context"], json!(FALLBACK_CONTEXT_WINDOW));
}

#[test]
fn save_without_save_providers_still_backfills_model_configs() {
    let sandbox = Sandbox::new("llm-config-backfill");
    sandbox.write_settings(json!({
        "llm": {
            "activeProvider": "a",
            "providers": { "a": { "baseURL": "https://a.example", "apiKey": "k", "models": ["m1"] } },
        },
    }));

    apply_llm_config_save(&json!({ "webSearch": true })).unwrap();

    let configs = &sandbox.read_settings()["llm"]["providers"]["a"]["modelConfigs"];
    assert_eq!(configs["m1"]["context"], json!(FALLBACK_CONTEXT_WINDOW));
}

#[test]
fn save_auto_language_removes_the_key() {
    let sandbox = Sandbox::new("llm-config-auto-language");
    sandbox.write_settings(json!({ "uiLanguage": "zh" }));

    apply_llm_config_save(&json!({ "language": "auto" })).unwrap();

    // auto 是默认值：删掉显式配置而不是写一个 "auto"
    assert!(sandbox.read_settings().get("uiLanguage").is_none());
}

#[test]
fn save_applies_the_mcp_default_list() {
    let sandbox = Sandbox::new("llm-config-mcp");
    sandbox.write_settings(json!({ "mcp": { "enabled": ["old"] } }));

    apply_llm_config_save(&json!({ "mcpServers": ["a", "b", "a"] })).unwrap();

    assert_eq!(sandbox.read_settings()["mcp"]["enabled"], json!(["a", "b"]));
}

#[test]
fn save_without_mcp_servers_leaves_the_default_list_alone() {
    let sandbox = Sandbox::new("llm-config-mcp-untouched");
    sandbox.write_settings(json!({ "mcp": { "enabled": ["keep"] } }));

    apply_llm_config_save(&json!({ "webSearch": true })).unwrap();

    assert_eq!(sandbox.read_settings()["mcp"]["enabled"], json!(["keep"]));
}

#[test]
fn save_reports_the_resolved_session_model() {
    let sandbox = Sandbox::new("llm-config-session-model");
    let project = sandbox.workspace.to_string_lossy().to_string();
    sandbox.write_settings(json!({
        "llm": {
            "activeProvider": "a",
            "providers": {
                "a": { "baseURL": "https://a.example", "apiKey": "k", "models": ["m1"], "defaultModel": "m1" },
            },
        },
    }));
    crate::history::create_conversation(
        "s1",
        &project,
        json!({ "sessionId": "s1", "project": project, "title": "t" }),
    )
    .unwrap();
    crate::config::set_session_workspace("s1", Some(project.clone()));

    // 会话存的 provider 已经不存在 → 解析回 active provider
    let saved = apply_llm_config_save(&json!({
        "sessionId": "s1",
        "currentProvider": "gone",
        "currentModel": "x",
    }))
    .unwrap();
    assert_eq!(saved["activeModel"], json!("m1"));
    assert_eq!(saved["activeModelProvider"], json!("a"));

    // 解析结果与旧身份不同 → 已写回会话 meta.json
    let (provider, model) = crate::history::model_ref_of_session("s1", &project);
    assert_eq!(provider, Some("a".to_string()));
    assert_eq!(model, Some("m1".to_string()));
}

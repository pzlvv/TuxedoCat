//! 配置快照与存储测试：默认值补齐 / 规范化 / 模型身份校验 / mcp.json 解析 / 写入纪律。

use std::fs;

use serde_json::{json, Value};

use super::*;

fn snapshot_of(raw: Value) -> SettingsSnapshot {
    resolve_settings_snapshot(&raw)
}

#[test]
fn empty_settings_fall_back_to_defaults() {
    let snapshot = snapshot_of(json!({}));
    assert_eq!(snapshot.active_provider, "");
    assert!(snapshot.web_search);
    assert_eq!(snapshot.thinking_effort, "high");
    assert_eq!(snapshot.default_agent_mode, "risk");
    assert_eq!(snapshot.default_prompt_mode, "normal");
    assert_eq!(snapshot.max_tokens, FALLBACK_MAX_OUTPUT_TOKENS);
    assert_eq!(snapshot.model_limits_fallback.context, FALLBACK_CONTEXT_WINDOW);
}

#[test]
fn registry_matches_exact_and_substring() {
    let raw = json!({ "llm": { "providers": { "deepseek": {
        "baseURL": "https://api.deepseek.com", "apiKey": "k",
        "models": ["deepseek-v4-pro", "unknown-model"]
    } } } });
    let snapshot = snapshot_of(raw);
    let provider = snapshot.providers.get("deepseek").unwrap();
    // 注册表命中（子串）：deepseek-v4-pro 的限值
    let pro = provider.model_limits.get("deepseek-v4-pro").unwrap();
    assert_eq!(pro.context, 1024.0 * 1024.0);
    assert_eq!(pro.output, 384.0 * 1024.0);
    // 未命中：兜底限值 + 默认协议
    let unknown = provider.model_limits.get("unknown-model").unwrap();
    assert_eq!(unknown.context, FALLBACK_CONTEXT_WINDOW);
    assert_eq!(unknown.api_type, ApiType::OpenAi);
    // 默认模型回落 models[0]
    assert_eq!(provider.default_model, "deepseek-v4-pro");
}

#[test]
fn user_overrides_win_over_registry() {
    let raw = json!({ "llm": { "providers": { "p": {
        "baseURL": "https://x", "models": ["m1"],
        "modelConfigs": { "m1": { "context": 123, "output": 45, "apiType": "Anthropic" } }
    } } } });
    let snapshot = snapshot_of(raw);
    let limits = snapshot.providers["p"].model_limits.get("m1").unwrap();
    assert_eq!(limits.context, 123.0);
    assert_eq!(limits.output, 45.0);
    assert_eq!(limits.api_type, ApiType::Anthropic);
}

#[test]
fn active_provider_requires_base_url() {
    let raw = json!({ "llm": { "activeProvider": "p", "providers": { "p": { "baseURL": "" } } } });
    assert_eq!(snapshot_of(raw).active_provider, "");

    let raw = json!({ "llm": { "activeProvider": "p", "providers": { "p": { "baseURL": "https://x", "models": ["m"], "defaultModel": "m" } } } });
    let snapshot = snapshot_of(raw);
    assert_eq!(snapshot.active_provider, "p");
    assert_eq!(snapshot.active_model_ref(), Some(("p".into(), "m".into())));
}

#[test]
fn whitelist_values_fall_back_to_defaults() {
    let raw = json!({ "llm": { "thinking_effort": "turbo" }, "defaultAgentMode": "yolo", "defaultPromptMode": "fancy" });
    let snapshot = snapshot_of(raw);
    assert_eq!(snapshot.thinking_effort, "high");
    assert_eq!(snapshot.default_agent_mode, "risk");
    assert_eq!(snapshot.default_prompt_mode, "normal");
}

#[test]
fn resolve_model_ref_chain() {
    let snapshot = snapshot_of(json!({ "llm": { "activeProvider": "a", "providers": {
        "a": { "baseURL": "https://a", "models": ["m-a"], "defaultModel": "m-a" },
        "b": { "baseURL": "https://b", "models": ["m-b"], "defaultModel": "m-b" },
    } } }));
    // 未记录 provider → active 默认
    assert_eq!(resolve_model_ref(&snapshot, "", ""), Some(("a".into(), "m-a".into())));
    // 合法身份原样返回
    assert_eq!(resolve_model_ref(&snapshot, "b", "m-b"), Some(("b".into(), "m-b".into())));
    // provider 已移除 → active 默认
    assert_eq!(resolve_model_ref(&snapshot, "gone", "m"), Some(("a".into(), "m-a".into())));
    // provider 在、模型不在列表 → 该 provider 的默认模型
    assert_eq!(resolve_model_ref(&snapshot, "b", "gone"), Some(("b".into(), "m-b".into())));
}

#[test]
fn mcp_json_parsing() {
    let raw = json!({ "mcpServers": {
        "local": { "command": "npx", "args": ["-y", "x"] },
        "remote": { "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer t" } },
        "broken": "not-an-object"
    } });
    let servers = parse_mcp_server_definitions(Some(&raw));
    assert_eq!(servers.len(), 2);
    let local = servers.iter().find(|server| server.name == "local").unwrap();
    assert_eq!(local.kind, "local");
    assert_eq!(local.command, vec!["npx".to_string()]);
    let remote = servers.iter().find(|server| server.name == "remote").unwrap();
    assert_eq!(remote.kind, "remote");
    assert_eq!(remote.headers.get("Authorization").map(String::as_str), Some("Bearer t"));
}

#[test]
fn snapshot_payload_round_shape() {
    let snapshot = snapshot_of(json!({ "llm": { "activeProvider": "p", "providers": { "p": {
        "baseURL": "https://x", "apiKey": "k", "models": ["m"]
    } } } }));
    let payload = snapshot_to_payload(&snapshot);
    assert_eq!(payload["llm"]["activeProvider"], "p");
    assert_eq!(payload["llm"]["providers"]["p"]["defaultModel"], "m");
    assert_eq!(payload["llm"]["providers"]["p"]["modelLimits"]["m"]["apiType"], "OpenAI");
    assert_eq!(payload["defaultAgentMode"], "risk");
}

#[test]
fn store_load_write_and_guards() {
    let dir = std::env::temp_dir().join(format!("tui-rs-settings-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut store = SettingsStore::with_dir(dir.clone());

    // 未配置：空快照
    let snapshot = store.load();
    assert_eq!(snapshot.active_provider, "");

    // 写入（update_settings 走读-改-写）
    let snapshot = store
        .update_settings(|cfg| {
            *cfg = json!({ "llm": { "activeProvider": "p", "providers": { "p": {
                "baseURL": "https://x", "apiKey": "k", "models": ["m"], "defaultModel": "m"
            } } }, "uiLanguage": "zh" });
        })
        .unwrap();
    assert_eq!(snapshot.active_provider, "p");

    // 写入保留未知字段（读-改-写不丢）且保留键序
    store
        .update_settings(|cfg| {
            let object = cfg.as_object_mut().unwrap();
            object.insert("theme".into(), Value::String("dark".into()));
        })
        .unwrap();
    let text = fs::read_to_string(dir.join("settings.json")).unwrap();
    assert!(text.contains("\"theme\""));
    assert!(text.starts_with("{\n  \"llm\"")); // preserve_order：键序不乱

    // 读不出来的文件：拒绝写入（不能拿 {} 覆盖用户配置）
    fs::write(dir.join("settings.json"), "{broken").unwrap();
    let error = store
        .update_settings(|cfg| {
            *cfg = json!({});
        })
        .unwrap_err();
    assert!(error.contains("拒绝覆盖"));

    // 磁盘内容未变 → refresh_from_disk 返回 None（不重推快照）
    fs::write(dir.join("settings.json"), "{\n  \"llm\": {\n    \"activeProvider\": \"p\"\n  }\n}\n").unwrap();
    store.load();
    assert!(store.refresh_from_disk().is_none());

    let _ = fs::remove_dir_all(&dir);
}

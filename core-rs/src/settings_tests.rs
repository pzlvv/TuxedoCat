//! `settings` 模块单测：快照的解析、必选字段校验与查表语义。

use super::*;
use crate::test_support::serial;
use serde_json::json;

/// 一份最小的合法快照
fn sample_snapshot() -> Value {
    json!({
        "llm": {
            "activeProvider": "p",
            "webSearch": false,
            "thinkingEffort": "low",
            "model": "legacy-model",
            "maxTokens": 2048,
            "providers": {
                "p": {
                    "baseURL": "https://p",
                    "apiKey": "sk-p",
                    "models": ["m1", "m2"],
                    "defaultModel": "m1",
                    "modelLimits": {
                        "m1": {
                            "context": 1000,
                            "output": 100,
                            "apiType": "Responses",
                            "thinkingTokenBudget": 50,
                        }
                    }
                }
            },
            "modelLimitsFallback": {
                "context": 9,
                "output": 8,
                "apiType": "OpenAI",
                "thinkingTokenBudget": 7,
            }
        },
        "mcp": { "enabled": ["s1"] },
        "defaultAgentMode": "auto",
        "defaultPromptMode": "mixed",
    })
}

fn host_environment(settings: Value, mcp_servers: Value) -> Value {
    json!({
        "type": "hostEnvironmentProvided",
        "extensionPath": "/ext",
        "logToConsole": false,
        "configDirName": ".tuxedo-cat",
        "settings": settings,
        "mcpServers": mcp_servers,
    })
}

#[test]
fn applies_snapshot_and_serves_lookups() {
    let _guard = serial();
    reset_settings_snapshot();
    assert!(!has_settings_snapshot());
    assert!(settings_snapshot().is_err());
    assert!(mcp_server_definitions().is_err());

    let event = host_environment(
        sample_snapshot(),
        json!([{
            "name": "s1",
            "type": "local",
            "command": ["uvx", "s1"],
            "environment": { "A": "1" },
            "url": "",
            "headers": {},
        }]),
    );
    apply_from_host_environment(&event).expect("apply");

    assert!(has_settings_snapshot());
    let snapshot = settings_snapshot().expect("snapshot");
    assert_eq!(snapshot.llm.active_provider, "p");
    assert_eq!(snapshot.llm.web_search, false);
    assert_eq!(snapshot.llm.thinking_effort, "low");
    assert_eq!(snapshot.llm.model, "legacy-model");
    assert_eq!(snapshot.llm.max_tokens, 2048);
    assert_eq!(snapshot.mcp.enabled, vec!["s1".to_string()]);
    assert_eq!(snapshot.default_agent_mode, "auto");
    assert_eq!(snapshot.default_prompt_mode, "mixed");

    let servers = mcp_server_definitions().expect("servers");
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].name, "s1");
    assert_eq!(servers[0].command, vec!["uvx".to_string(), "s1".to_string()]);
    assert_eq!(
        servers[0].environment.iter().find(|(key, _)| key == "A").map(|(_, value)| value.as_str()),
        Some("1"),
    );

    reset_settings_snapshot();
}

#[test]
fn missing_or_invalid_fields_are_protocol_errors() {
    let _guard = serial();
    reset_settings_snapshot();

    // 缺 settings
    let event = json!({ "type": "hostEnvironmentProvided", "mcpServers": [] });
    let err = apply_from_host_environment(&event).expect_err("missing settings");
    assert!(err.contains("settings"), "{err}");

    // 缺 mcpServers
    let event = json!({ "type": "hostEnvironmentProvided", "settings": sample_snapshot() });
    let err = apply_from_host_environment(&event).expect_err("missing mcpServers");
    assert!(err.contains("mcpServers"), "{err}");

    // 快照内部缺字段（`llm.modelLimitsFallback`）
    let mut broken = sample_snapshot();
    broken["llm"].as_object_mut().unwrap().remove("modelLimitsFallback");
    let event = host_environment(broken, json!([]));
    let err = apply_from_host_environment(&event).expect_err("missing fallback");
    assert!(err.contains("modelLimitsFallback"), "{err}");

    // 失败的写入不留下半份快照
    assert!(!has_settings_snapshot());

    reset_settings_snapshot();
}

#[test]
fn reapplying_replaces_the_whole_snapshot() {
    let _guard = serial();
    reset_settings_snapshot();
    apply_from_host_environment(&host_environment(sample_snapshot(), json!([{
        "name": "s1", "type": "local", "command": [], "environment": {}, "url": "", "headers": {},
    }]))).expect("first");

    let mut next = sample_snapshot();
    next["mcp"]["enabled"] = json!([]);
    apply_from_host_environment(&host_environment(next, json!([]))).expect("second");

    let snapshot = settings_snapshot().expect("snapshot");
    assert!(snapshot.mcp.enabled.is_empty());
    assert!(mcp_server_definitions().expect("servers").is_empty());

    reset_settings_snapshot();
}

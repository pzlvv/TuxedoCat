//! `mcp_config` 单测：`mcp.json` 解析与归一化、启用状态合并、会话覆盖与 meta.json 回写、
//! 以及配置解析对照表断言（数据见 `core-rs/fixtures/mcp.json`）。

use super::*;
use crate::config;
use crate::test_support::Sandbox;
use serde_json::json;

fn write_mcp_json(servers: Value) {
    let path = mcp_config_path().expect("mcp path");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create config dir");
    }
    std::fs::write(&path, serde_json::to_string(&servers).unwrap()).expect("write mcp.json");
}

// ==================== 归一化纯函数 ====================

#[test]
fn normalize_command_accepts_string_or_array() {
    assert_eq!(normalize_command(&json!("  uvx  ")), vec!["uvx".to_string()]);
    assert_eq!(normalize_command(&json!("   ")), Vec::<String>::new());
    assert_eq!(
        normalize_command(&json!(["npx", 3, "tool"])),
        vec!["npx".to_string(), "tool".to_string()]
    );
    assert_eq!(normalize_command(&json!(null)), Vec::<String>::new());
    assert_eq!(normalize_command(&json!(7)), Vec::<String>::new());
}

#[test]
fn normalize_string_map_uses_js_string_and_skips_nulls() {
    let map = normalize_string_map(&json!({
        "A": "x",
        "B": 3,
        "C": true,
        "D": null,
        "E": [1, 2],
        "F": { "k": 1 },
    }));
    assert_eq!(
        map,
        vec![
            ("A".to_string(), "x".to_string()),
            ("B".to_string(), "3".to_string()),
            ("C".to_string(), "true".to_string()),
            ("E".to_string(), "1,2".to_string()),
            ("F".to_string(), "[object Object]".to_string()),
        ]
    );
    assert_eq!(normalize_string_map(&json!(["a"])), Vec::<(String, String)>::new());
    assert_eq!(normalize_string_map(&json!("x")), Vec::<(String, String)>::new());
}

#[test]
fn normalize_url_trims_strings_only() {
    assert_eq!(normalize_url(&json!(" https://x/y ")), "https://x/y");
    assert_eq!(normalize_url(&json!(42)), "");
    assert_eq!(normalize_url(&json!(null)), "");
}

#[test]
fn normalize_type_derives_remote_from_url_without_command() {
    assert_eq!(normalize_type(&json!(" sse "), "", &[]), "sse");
    assert_eq!(normalize_type(&json!(""), "https://x", &[]), "remote");
    assert_eq!(
        normalize_type(&json!(null), "https://x", &["npx".to_string()]),
        "local"
    );
    assert_eq!(normalize_type(&json!(null), "", &[]), "local");
}

#[test]
fn is_remote_type_is_case_insensitive() {
    assert!(is_remote_type(" HTTP "));
    assert!(is_remote_type("streamable-http"));
    assert!(!is_remote_type("local"));
    assert!(!is_remote_type(""));
}

#[test]
fn is_remote_server_tolerates_mislabeled_local() {
    assert!(is_remote_server("remote", "", &[]));
    assert!(is_remote_server("local", "https://x", &[]));
    assert!(!is_remote_server("local", "https://x", &["npx".to_string()]));
    assert!(!is_remote_server("local", "", &["npx".to_string()]));
}

#[test]
fn extract_enabled_list_only_accepts_arrays() {
    assert_eq!(
        extract_enabled_list(&json!({ "mcp": { "enabled": ["a", 3, "b"] } })),
        Some(vec!["a".to_string(), "b".to_string()])
    );
    assert_eq!(extract_enabled_list(&json!({ "mcp": { "enabled": [] } })), Some(vec![]));
    assert_eq!(extract_enabled_list(&json!({ "mcp": {} })), None);
    assert_eq!(extract_enabled_list(&json!({ "mcp": { "enabled": "a" } })), None);
    assert_eq!(extract_enabled_list(&json!(null)), None);
}

#[test]
fn extract_server_map_prefers_wrapper_then_root() {
    assert_eq!(
        extract_server_map(&json!({ "mcp": { "a": {} }, "b": {} })),
        &json!({ "a": {} })
    );
    assert_eq!(
        extract_server_map(&json!({ "mcpServers": { "a": {} } })),
        &json!({ "a": {} })
    );
    assert_eq!(
        extract_server_map(&json!({ "a": {} })),
        &json!({ "a": {} })
    );
    // 包裹层不是对象时回退到根对象
    assert_eq!(
        extract_server_map(&json!({ "mcp": "nope", "a": {} })),
        &json!({ "mcp": "nope", "a": {} })
    );
}

#[test]
fn parse_server_definitions_handles_fallbacks_and_skips() {
    let raw = json!({
        "mcp": {
            "local": {
                "type": "stdio",
                "command": ["uvx", "x"],
                "environment": { "A": "1" }
            },
            "url-first": { "url": " https://a ", "headers": { "Authorization": "Bearer t" } },
            "endpoint-fallback": { "endpoint": "https://b" },
            "server-url-fallback": { "serverUrl": "https://c" },
            "env-fallback": { "command": "npx", "env": { "B": 2 } },
            "null-url-falls-through": { "url": null, "endpoint": "https://d" },
            "not-object": 5,
        }
    });
    let servers = parse_mcp_server_definitions(&raw);
    let names: Vec<&str> = servers.iter().map(|server| server.name.as_str()).collect();
    assert_eq!(
        names,
        vec![
            "local",
            "url-first",
            "endpoint-fallback",
            "server-url-fallback",
            "env-fallback",
            "null-url-falls-through",
        ]
    );

    let local = &servers[0];
    assert_eq!(local.r#type, "stdio");
    assert_eq!(local.command, vec!["uvx".to_string(), "x".to_string()]);
    assert_eq!(local.environment, vec![("A".to_string(), "1".to_string())]);
    assert_eq!(local.url, "");

    assert_eq!(servers[1].url, "https://a");
    assert_eq!(servers[1].r#type, "remote");
    assert_eq!(servers[2].url, "https://b");
    assert_eq!(servers[3].url, "https://c");
    assert_eq!(servers[4].r#type, "local");
    assert_eq!(servers[4].environment, vec![("B".to_string(), "2".to_string())]);
    assert_eq!(servers[5].url, "https://d");

    // 根对象不是普通对象 → 空
    assert!(parse_mcp_server_definitions(&json!([1, 2])).is_empty());
}

#[test]
fn with_enabled_marks_matching_names() {
    let servers = parse_mcp_server_definitions(&json!({
        "mcp": { "a": { "command": "npx" }, "b": { "command": "npx" } }
    }));
    let infos = with_enabled(&servers, &["b".to_string()]);
    assert!(!infos[0].enabled);
    assert!(infos[1].enabled);
    assert_eq!(
        infos[1].to_json(),
        json!({
            "name": "b",
            "type": "local",
            "command": ["npx"],
            "environment": {},
            "url": "",
            "headers": {},
            "enabled": true,
        })
    );
}

// ==================== 读盘 / 会话覆盖 ====================

#[test]
fn read_mcp_servers_merges_global_default() {
    let sandbox = Sandbox::new("mcp-config-global");
    reset_session_overrides();
    write_mcp_json(json!({
        "mcp": {
            "a": { "command": "npx" },
            "b": { "url": "https://b" },
        }
    }));
    sandbox.write_settings(json!({ "mcp": { "enabled": ["b"] } }));

    let servers = read_mcp_servers(None);
    assert_eq!(servers.len(), 2);
    assert_eq!(servers[0].name, "a");
    assert!(!servers[0].enabled);
    assert!(servers[1].enabled);
    assert!(servers[1].is_remote());

    // 默认列表（设置面板用）与无会话的生效值一致
    assert_eq!(read_mcp_servers_for_defaults(), servers);
}

#[test]
fn read_mcp_servers_missing_file_returns_empty() {
    let _sandbox = Sandbox::new("mcp-config-missing");
    reset_session_overrides();
    assert!(read_mcp_servers(None).is_empty());
}

#[test]
fn session_override_wins_and_flushes_to_meta() {
    let sandbox = Sandbox::new("mcp-config-session");
    reset_session_overrides();
    write_mcp_json(json!({
        "mcp": { "a": { "command": "npx" }, "b": { "command": "npx" } }
    }));
    sandbox.write_settings(json!({ "mcp": { "enabled": ["a"] } }));

    let session = "mcp-config-session-1";
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace(session, Some(project.clone()));

    // 无会话覆盖 → 全局默认
    assert_eq!(read_enabled_mcps(Some(session)), vec!["a".to_string()]);
    assert_eq!(read_session_enabled_mcps(Some(session)), None);

    // 会话级：取消 a、启用 b
    set_session_mcp_enabled(Some(session), "a", false);
    set_session_mcp_enabled(Some(session), "b", true);
    assert_eq!(read_enabled_mcps(Some(session)), vec!["b".to_string()]);
    assert_eq!(
        read_session_enabled_mcps(Some(session)),
        Some(vec!["b".to_string()])
    );
    let servers = read_mcp_servers(Some(session));
    assert!(!servers[0].enabled);
    assert!(servers[1].enabled);

    // meta.json 存在后 flush 补写
    let dir = sandbox.conversation_dir(&project);
    std::fs::write(
        dir.join(format!("{session}.meta.json")),
        serde_json::to_string(&json!({ "sessionId": session, "project": project })).unwrap(),
    )
    .expect("write meta");
    flush_session_mcp_to_meta(session);
    let metadata = crate::history::load_metadata(session, &project).expect("metadata");
    assert_eq!(metadata["context"]["mcpEnabled"], json!(["b"]));

    // 清掉内存缓存后从 meta.json 恢复
    reset_session_overrides();
    assert_eq!(
        read_session_enabled_mcps(Some(session)),
        Some(vec!["b".to_string()])
    );

    // 会话删除清理缓存
    clear_session_mcp_override(session);
    reset_session_overrides();
}

#[test]
fn flush_skips_when_no_override_or_no_meta() {
    let sandbox = Sandbox::new("mcp-config-flush");
    reset_session_overrides();
    let session = "mcp-config-flush-1";
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace(session, Some(project));

    // 没有内存覆盖 → 什么也不做
    flush_session_mcp_to_meta(session);

    // 有覆盖但 meta.json 不存在 → 静默跳过（不 panic、不建文件）
    set_session_mcp_enabled(Some(session), "a", true);
    flush_session_mcp_to_meta(session);
    let dir = config::project_conversation_dir(&sandbox.workspace.to_string_lossy()).unwrap();
    assert!(!dir.join(format!("{session}.meta.json")).exists());
    reset_session_overrides();
}

// ==================== 对照表断言 ====================

const FIXTURE: &str = include_str!("../fixtures/mcp.json");

mod parity_tests {
    use super::*;

    #[test]
    fn config_parse_parity() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("parse mcpParity.json");
        let sandbox = Sandbox::new("mcp-config-parity");
        for case in fixture["configParse"].as_array().expect("configParse") {
            let name = case["name"].as_str().unwrap_or("");
            reset_session_overrides();
            write_mcp_json(case["mcpJson"].clone());
            sandbox.write_settings(case["settingsJson"].clone());
            let actual: Vec<Value> = read_mcp_servers(None)
                .iter()
                .map(|server| server.to_json())
                .collect();
            assert_eq!(
                actual,
                case["servers"].as_array().unwrap().clone(),
                "configParse: {name}"
            );
        }
    }
}

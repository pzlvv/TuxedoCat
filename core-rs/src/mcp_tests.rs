//! `mcp` 单测：stdio 真实子进程端到端、纯函数、管理器（连接池 / 引用 / 延迟回收）、
//! 以及纯函数对照表断言（数据见 `core-rs/fixtures/mcp.json`）。

use super::*;
use crate::config;
use crate::test_support::Sandbox;
use serde_json::json;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

// ==================== 夹具：假 MCP 服务器 ====================

/// 一个最小 MCP 服务器（单行 Node 脚本）：
/// - `initialize` / `notifications/initialized` 握手
/// - `tools/list` 两页（第一页带 `nextCursor`）
/// - `tools/call`：`echo` 正常返回；`reverse` 先反向发一条 sampling 请求，
///   再把客户端回绝的 `-32601` 原样带回来；`die` 直接退出进程
const FAKE_SERVER: &str = r#"
let pr;
const rl=require('readline').createInterface({input:process.stdin});
const send=(o)=>process.stdout.write(JSON.stringify(o)+'\n');
rl.on('line',(l)=>{let m;try{m=JSON.parse(l)}catch(e){return}
if(m.id===99){send({jsonrpc:'2.0',id:pr,result:{content:[{type:'text',text:'reverse-code:'+m.error.code}]}});return}
if(m.method==='initialize'){send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fake',version:'1'}}});return}
if(m.method==='notifications/initialized'){return}
if(m.method==='tools/list'){if(m.params&&m.params.cursor){send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'second',description:'Second'}]}})}else{send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'reverse'}],nextCursor:'c2'}})};return}
if(m.method==='tools/call'){const n=m.params.name;
if(n==='echo'){send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'called '+n}]}});return}
if(n==='reverse'){pr=m.id;send({jsonrpc:'2.0',id:99,method:'sampling/createMessage',params:{}});return}
if(n==='die'){process.exit(0)}
send({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'unknown'}],isError:true}});return}
});
"#;

fn node_command(script: &str) -> Vec<String> {
    vec![
        "node".to_string(),
        "-e".to_string(),
        script.replace('\n', " "),
    ]
}

fn fake_server_command() -> Vec<String> {
    node_command(FAKE_SERVER)
}

fn wait_until<F: Fn() -> bool>(timeout_ms: u64, predicate: F) -> bool {
    let start = Instant::now();
    loop {
        if predicate() {
            return true;
        }
        if start.elapsed().as_millis() as u64 >= timeout_ms {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

// ==================== stdio 传输：真实子进程端到端 ====================

#[test]
fn stdio_handshake_paging_call_and_reverse_request() {
    let client = McpStdioClient::new("fake", &fake_server_command(), &[]);
    client.start().expect("start handshake");

    assert!(client.is_running());
    assert!(client.is_initialized());

    // 分页：第一页 2 个 + 第二页 1 个
    let tools = client.get_tools();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, vec!["echo", "reverse", "second"], "{tools:?}");
    assert_eq!(tools[0].description.as_deref(), Some("Echo"));
    assert_eq!(tools[0].input_schema, Some(json!({ "type": "object" })));
    assert_eq!(
        tools[0].annotations,
        Some(json!({ "readOnlyHint": true }))
    );
    assert!(annotations_read_only(&tools[0]));
    assert!(!annotations_destructive(&tools[0]));

    // tools/call 正常返回
    let result = client.call_tool("echo", &json!({})).expect("call echo");
    assert_eq!(result.text, "called echo");
    assert!(!result.is_error);

    // 服务器反向请求被回绝为 -32601（服务器把收到的 code 原样带回）
    let result = client
        .call_tool("reverse", &json!({}))
        .expect("call reverse");
    assert_eq!(result.text, "reverse-code:-32601", "{result:?}");

    client.stop();
    assert!(!client.is_running());
}

#[test]
fn stdio_process_exit_rejects_pending_and_fires_on_exit() {
    let exited = Arc::new(AtomicBool::new(false));
    let client = McpStdioClient::new("fake-die", &fake_server_command(), &[]);
    {
        let exited = Arc::clone(&exited);
        client.set_on_exit(Arc::new(move |_reason| {
            exited.store(true, Ordering::SeqCst);
        }));
    }
    client.start().expect("start");

    // 服务器不回应直接退出 → 在途请求被 reject
    let error = client.call_tool("die", &json!({})).unwrap_err();
    assert!(error.contains("进程已退出"), "{error}");

    // onExit 由读线程异步触发
    assert!(wait_until(2_000, || exited.load(Ordering::SeqCst)));
    assert!(!client.is_running());
    assert_eq!(client.get_exit_reason().as_deref(), Some("exit code 0"));
}

#[test]
fn stdio_active_stop_does_not_fire_on_exit() {
    let exited = Arc::new(AtomicBool::new(false));
    let client = McpStdioClient::new("fake-stop", &fake_server_command(), &[]);
    {
        let exited = Arc::clone(&exited);
        client.set_on_exit(Arc::new(move |_reason| {
            exited.store(true, Ordering::SeqCst);
        }));
    }
    client.start().expect("start");
    client.stop();

    std::thread::sleep(Duration::from_millis(400));
    assert!(!exited.load(Ordering::SeqCst), "主动 stop 不应触发 onExit");
    assert!(!client.is_running());
    // 停止后调用工具直接报「未运行」
    let error = client.call_tool("echo", &json!({})).unwrap_err();
    assert!(error.contains("未运行"), "{error}");
}

// ==================== 纯函数 ====================

#[test]
fn normalize_call_result_flattens_blocks() {
    let result = normalize_mcp_call_result(&json!({
        "content": [
            { "type": "text", "text": "hello" },
            { "type": "image", "mimeType": "image/png" },
            { "type": "image" },
            { "type": "resource", "resource": { "uri": "file:///a", "text": "file body" } },
            { "type": "resource", "resource": { "uri": "file:///b" } },
            { "type": "resource", "resource": {} },
            { "type": "custom", "value": 1 },
            [1, 2],
        ],
        "isError": true,
    }));
    assert_eq!(
        result.text,
        "hello\n[image image/png]\n[image unknown]\nfile body\n[resource file:///b]\n[resource unknown]\n{\"type\":\"custom\",\"value\":1}\n[1,2]"
    );
    assert!(result.is_error);
}

#[test]
fn normalize_call_result_falls_back_to_serialized_result() {
    let result = normalize_mcp_call_result(&json!({ "content": [], "isError": false }));
    assert_eq!(result.text, "{\"content\":[],\"isError\":false}");
    assert!(!result.is_error);

    // `null` / 缺失 → `JSON.stringify(null)` = "null"
    assert_eq!(normalize_mcp_call_result(&Value::Null).text, "null");

    // 只有 isError === true 才算错误
    assert!(!normalize_mcp_call_result(&json!({ "isError": 1 })).is_error);
    assert!(normalize_mcp_call_result(&json!({ "isError": true })).is_error);
}

#[test]
fn list_tools_pages_until_empty_cursor() {
    let pages = vec![
        json!({ "tools": [{ "name": "a" }], "nextCursor": "c1" }),
        json!({ "tools": [{ "name": "b" }], "nextCursor": "" }),
    ];
    let mut index = 0usize;
    let mut calls: Vec<Value> = Vec::new();
    let tools = list_mcp_tools(|method, params, timeout| {
        calls.push(json!({ "method": method, "params": params.clone(), "timeout": timeout }));
        let page = pages.get(index).cloned().unwrap_or_else(|| json!({}));
        index += 1;
        Ok(page)
    })
    .expect("list");
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].name, "a");
    assert_eq!(tools[1].name, "b");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["params"], json!({}));
    assert_eq!(calls[1]["params"], json!({ "cursor": "c1" }));
    assert_eq!(calls[0]["timeout"], json!(CONTROL_TIMEOUT_MS));
}

#[test]
fn list_tools_defends_against_cyclic_cursor() {
    let mut calls = 0usize;
    let tools = list_mcp_tools(|_method, _params, _timeout| {
        calls += 1;
        Ok(json!({ "tools": [{ "name": "loop" }], "nextCursor": "again" }))
    })
    .expect("list");
    assert_eq!(calls, 50, "环状 cursor 最多 50 页");
    assert_eq!(tools.len(), 50);
}

#[test]
fn list_tools_skips_invalid_items() {
    let tools = list_mcp_tools(|_method, _params, _timeout| {
        Ok(json!({
            "tools": [
                { "name": "ok", "description": 5, "inputSchema": "nope", "annotations": [] },
                { "name": "" },
                { "name": 3 },
                "not-an-object",
                null,
            ]
        }))
    })
    .expect("list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "ok");
    assert_eq!(tools[0].description, None);
    assert_eq!(tools[0].input_schema, None);
    // 数组也算 `typeof === 'object'`，会被保留
    assert_eq!(tools[0].annotations, Some(json!([])));
}

#[test]
fn build_tool_name_sanitizes_both_parts() {
    assert_eq!(build_mcp_tool_name("my server", "do.it"), "mcp__my_server__do_it");
    assert_eq!(build_mcp_tool_name("a-b_c", "x/y"), "mcp__a-b_c__x_y");
    // 非 BMP 字符按 UTF-16 code unit 各替换一个下划线
    assert_eq!(sanitize_name_part("a😀b"), "a__b");
}

#[test]
fn create_tool_definition_falls_back_to_generated_description() {
    let definition = McpToolDefinition {
        name: "do".to_string(),
        description: Some("   ".to_string()),
        input_schema: None,
        annotations: None,
    };
    let value = create_mcp_tool_definition("srv", "mcp__srv__do", &definition);
    assert_eq!(value["name"], "mcp__srv__do");
    assert_eq!(
        value["description"],
        "Tool \"do\" provided by MCP server \"srv\"."
    );
    assert_eq!(value["input_schema"], json!({ "type": "object", "properties": {} }));
}

#[test]
fn quote_windows_arg_matches_node_shell_semantics() {
    assert_eq!(quote_windows_arg(""), "\"\"");
    assert_eq!(quote_windows_arg("node"), "node");
    assert_eq!(quote_windows_arg("a b"), "\"a b\"");
    assert_eq!(quote_windows_arg("a\"b"), "\"a\"\"b\"");
    assert_eq!(quote_windows_arg("C:\\Program Files\\x"), "\"C:\\Program Files\\x\"");
}

#[test]
fn js_json_stringify_matches_ecmascript_number_format() {
    assert_eq!(js_json_stringify(&json!(1.0)), "1");
    assert_eq!(js_json_stringify(&json!([1.5, true, null, "x"])), "[1.5,true,null,\"x\"]");
    assert_eq!(js_json_stringify(&json!({"a": 1, "b": [2]})), "{\"a\":1,\"b\":[2]}");
}

// ==================== 管理器：连接池 / 引用 / 延迟回收 ====================

fn write_mcp_json(servers: Value) {
    let path = crate::mcp_config::mcp_config_path().expect("mcp path");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create config dir");
    }
    std::fs::write(&path, serde_json::to_string(&servers).unwrap()).expect("write mcp.json");
}

#[test]
fn manager_acquire_exposes_tools_and_release_reclaims() {
    let sandbox = Sandbox::new("mcp-manager");
    reset_manager();
    set_test_reclaim_grace_ms(Some(150));
    crate::mcp_config::reset_session_overrides();

    write_mcp_json(json!({
        "mcp": { "fake": { "type": "local", "command": fake_server_command() } }
    }));
    sandbox.write_settings(json!({ "mcp": { "enabled": ["fake"] } }));

    let session = "mcp-manager-session";
    let project = sandbox.workspace.to_string_lossy().to_string();
    config::set_session_workspace(session, Some(project.clone()));

    let manager = manager();
    manager.acquire(session);

    assert!(
        wait_until(20_000, || get_tools().len() == 3),
        "tools did not appear: {:?}",
        get_server_status()
    );
    let names: Vec<String> = get_tools()
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(
        names,
        vec!["mcp__fake__echo", "mcp__fake__reverse", "mcp__fake__second"]
    );

    // 按会话启用集合过滤
    let mut enabled = HashSet::new();
    enabled.insert("fake".to_string());
    assert_eq!(get_tools_for_servers(&enabled).len(), 3);
    let mut other = HashSet::new();
    other.insert("other".to_string());
    assert_eq!(get_tools_for_servers(&other).len(), 0);

    // 运行时状态
    let status = get_server_status();
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].0, "fake");
    assert!(status[0].1.running);
    assert_eq!(status[0].1.tool_count, 3);
    assert_eq!(status[0].1.ref_count, 1);
    assert_eq!(status[0].1.error, None);

    // UI 列表：配置 + 运行时状态合并
    let with_runtime = servers_with_runtime(Some(session));
    assert_eq!(with_runtime.len(), 1);
    assert_eq!(with_runtime[0]["name"], "fake");
    assert_eq!(with_runtime[0]["enabled"], true);
    assert_eq!(with_runtime[0]["running"], true);
    assert_eq!(with_runtime[0]["toolCount"], 3);
    assert_eq!(with_runtime[0]["refCount"], 1);
    assert_eq!(with_runtime[0]["error"], Value::Null);

    // 工具调用
    match execute_tool("mcp__fake__echo", &json!({})) {
        crate::tools::ToolOutcome::Success(text) => assert_eq!(text, "called echo"),
        other => panic!("unexpected outcome: {}", other.text()),
    }
    assert!(is_mcp_tool("mcp__fake__echo"));
    assert!(!is_mcp_tool("Bash"));
    assert!(is_concurrency_safe("mcp__fake__echo"));

    // 释放 → 宽限期后回收（`rebuild_tools` 在 client.stop() 之后才清空工具表，
    // 因此以「工具表清空」为准等待）
    manager.release(session);
    assert!(
        wait_until(5_000, || get_tools().is_empty()),
        "tools were not cleared after reclaim"
    );
    assert!(get_server_status().is_empty());

    shutdown();
    reset_manager();
    set_test_reclaim_grace_ms(None);
    let _ = project;
}

#[test]
fn manager_prune_schedules_reclaim_without_starting() {
    let sandbox = Sandbox::new("mcp-prune");
    reset_manager();
    set_test_reclaim_grace_ms(Some(150));
    crate::mcp_config::reset_session_overrides();

    write_mcp_json(json!({
        "mcp": { "fake": { "type": "local", "command": fake_server_command() } }
    }));
    sandbox.write_settings(json!({ "mcp": { "enabled": ["fake"] } }));

    // 从未 acquire：prune 只对齐已注册会话（没有），不启动任何 server
    prune();
    std::thread::sleep(Duration::from_millis(300));
    assert!(get_server_status().is_empty());
    assert!(get_tools().is_empty());

    shutdown();
    reset_manager();
    set_test_reclaim_grace_ms(None);
}

#[test]
fn manager_sync_session_detaches_disabled_server() {
    let sandbox = Sandbox::new("mcp-sync");
    reset_manager();
    set_test_reclaim_grace_ms(Some(10_000));
    crate::mcp_config::reset_session_overrides();

    write_mcp_json(json!({
        "mcp": { "fake": { "type": "local", "command": fake_server_command() } }
    }));
    sandbox.write_settings(json!({ "mcp": { "enabled": ["fake"] } }));

    let session = "mcp-sync-session";
    config::set_session_workspace(session, Some(sandbox.workspace.to_string_lossy().to_string()));

    let manager = manager();
    manager.acquire(session);
    assert!(wait_until(20_000, || get_tools().len() == 3));

    // 会话级取消勾选 → 引用归零。宽限期（10s）内进程仍存活，**全局工具集合不变**，
    // 但该会话的启用集合已空 → 过滤后看不到任何 MCP 工具（对齐 Manager 的注释：
    // 「即使进程因其它会话仍存活，本会话也必须重新组装工具列表」）。
    crate::mcp_config::set_session_mcp_enabled(Some(session), "fake", false);
    manager.sync_session(session);
    assert!(
        wait_until(5_000, || {
            let status = get_server_status();
            status.len() == 1 && status[0].1.ref_count == 0
        }),
        "ref count should drop to zero"
    );
    assert!(tools_for_session(session).is_empty(), "该会话不应再看到 MCP 工具");
    assert_eq!(get_tools().len(), 3, "进程仍存活时全局工具集合不变");

    shutdown();
    reset_manager();
    set_test_reclaim_grace_ms(None);
    crate::mcp_config::reset_session_overrides();
}

// ==================== 对照表断言 ====================

/// 行为对照表（数据见 core-rs/fixtures/）。
const FIXTURE: &str = include_str!("../fixtures/mcp.json");

mod parity_tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).expect("parse mcpParity.json")
    }

    #[test]
    fn normalize_call_result_parity() {
        let fixture = fixture();
        for case in fixture["callResults"].as_array().expect("callResults") {
            let name = case["name"].as_str().unwrap_or("");
            let result = normalize_mcp_call_result(&case["result"]);
            assert_eq!(result.text, case["text"].as_str().unwrap(), "text: {name}");
            assert_eq!(
                result.is_error,
                case["isError"].as_bool().unwrap(),
                "isError: {name}"
            );
        }
    }

    #[test]
    fn list_tools_parity() {
        let fixture = fixture();
        for case in fixture["toolLists"].as_array().expect("toolLists") {
            let name = case["name"].as_str().unwrap_or("");
            let pages: Vec<Value> = case["pages"].as_array().unwrap().clone();
            let expected_calls: Vec<Value> = case["calls"].as_array().unwrap().clone();
            let mut index = 0usize;
            let mut calls: Vec<Value> = Vec::new();
            let tools = list_mcp_tools(|method, params, _timeout| {
                calls.push(json!({ "method": method, "params": params.clone() }));
                let page = pages.get(index).cloned().unwrap_or_else(|| json!({}));
                index += 1;
                Ok(page)
            })
            .expect("list");
            assert_eq!(calls, expected_calls, "calls: {name}");
            let actual: Vec<Value> = tools
                .iter()
                .map(|tool| {
                    let mut object = serde_json::Map::new();
                    object.insert("name".to_string(), json!(tool.name));
                    if let Some(description) = &tool.description {
                        object.insert("description".to_string(), json!(description));
                    }
                    if let Some(schema) = &tool.input_schema {
                        object.insert("inputSchema".to_string(), schema.clone());
                    }
                    if let Some(annotations) = &tool.annotations {
                        object.insert("annotations".to_string(), annotations.clone());
                    }
                    Value::Object(object)
                })
                .collect();
            assert_eq!(actual, case["tools"].as_array().unwrap().clone(), "tools: {name}");
        }
    }

    #[test]
    fn tool_name_parity() {
        let fixture = fixture();
        for case in fixture["toolNames"].as_array().expect("toolNames") {
            assert_eq!(
                build_mcp_tool_name(case["server"].as_str().unwrap(), case["tool"].as_str().unwrap()),
                case["result"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn quote_windows_arg_parity() {
        let fixture = fixture();
        for case in fixture["quoteWindowsArgs"].as_array().expect("quoteWindowsArgs") {
            assert_eq!(
                quote_windows_arg(case["input"].as_str().unwrap()),
                case["result"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn is_remote_type_parity() {
        let fixture = fixture();
        for case in fixture["isRemoteType"].as_array().expect("isRemoteType") {
            assert_eq!(
                crate::mcp_config::is_remote_type(case["type"].as_str().unwrap()),
                case["result"].as_bool().unwrap(),
                "type: {}",
                case["type"]
            );
        }
    }

    #[test]
    fn is_remote_server_parity() {
        let fixture = fixture();
        for case in fixture["isRemoteServer"].as_array().expect("isRemoteServer") {
            let command: Vec<String> = case["command"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect();
            assert_eq!(
                crate::mcp_config::is_remote_server(
                    case["type"].as_str().unwrap(),
                    case["url"].as_str().unwrap(),
                    &command
                ),
                case["result"].as_bool().unwrap(),
                "case: {case}"
            );
        }
    }
}

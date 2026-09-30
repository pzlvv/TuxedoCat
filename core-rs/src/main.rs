//! Standalone Core（见 docs/standalone-core.md）。
//!
//! 进程模型：由宿主（VS Code 扩展宿主 / Electron 主进程）启动，标准输入 / 标准输出
//! 为帧通道，标准错误为诊断输出。一个 Core 进程服务一个宿主实例。
//!
//! 启动顺序：读 `hello` 帧 → 校验协议版本 → 回 `ready` → 进入帧循环。
//! 退出：收到 `shutdown` 帧或标准输入 EOF（宿主退出）。

// 发布构建在 Windows 上不弹控制台；调试构建保留控制台便于诊断。
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod balance;
mod bash_task;
mod bus;
mod commands;
mod compact;
mod config;
mod engine;
mod frame;
mod history;
mod i18n;
mod llm;
mod llm_config;
mod mcp;
mod mcp_config;
mod mcp_http;
mod permission;
mod prompt;
mod replay;
mod responses;
mod rollback;
mod shell;
mod skills;
mod smart_naming;
mod spin;
mod spin_host;
mod subagent;
mod tool_input;
mod tools;
mod util;

#[cfg(test)]
mod test_support;

use std::io::{BufRead, BufReader};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use bus::{CoreBus, FrameWriter};
use engine::Core;
use frame::{CoreToUiFrame, UiToCoreFrame, CORE_PROTOCOL_VERSION};
use util::sanitize_json_surrogates;

fn main() {
    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let shared_bus: engine::SharedBus = Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(
        Box::new(std::io::stdout()),
    )));
    install_project_dir_ready_sink(&shared_bus);
    install_mcp_servers_changed_sink(&shared_bus);
    // MCP：清掉没有任何会话引用的残留进程（上一次 Core 崩溃留下的孤儿）
    crate::mcp::prune();
    let core = Arc::new(Core::new(Arc::clone(&shared_bus)));

    let code = run_frame_loop(reader, &core, &shared_bus);

    // 宿主退出：结束全部 MCP 子进程，避免留下孤儿进程
    crate::mcp::shutdown();

    {
        let bus = shared_bus.lock().unwrap();
        if bus.pending_count() > 0 {
            eprintln!(
                "[core] exiting with {} pending request(s)",
                bus.pending_count()
            );
        }
    }
    eprintln!("[core] exited");
    if code != 0 {
        std::process::exit(code);
    }
}

/// 解码一行帧。
///
/// 宿主（TS）用 `JSON.stringify` 序列化帧，而它可能带**孤立代理项**转义（`\ude00`）——
/// 例如历史里那条被按 UTF-16 code unit 切坏的「前 2K + 后 2K」工具输出预览。
/// serde_json 是严格解析器，遇到这种转义会报错，不清洗就会**整帧丢弃**
/// （表现为 Core 收不到消息 / 卡住）。这里先清洗再解析。
fn decode_frame(line: &str) -> Result<UiToCoreFrame, serde_json::Error> {
    serde_json::from_str(&sanitize_json_surrogates(line))
}

/// 注册「项目对话目录已就绪」上报出口。
///
/// 目录本身由 core 创建，其中的 `settings.json`（记录完整 workspacePath）由宿主写，
/// 因此 core 只在目录首次就绪时上报一次 `CoreEvent.projectConversationDirReady`
/// （对齐 Embedded `ensureProjectConversationDir` → `notifyProjectConversationDirReady`）。
fn install_project_dir_ready_sink(shared_bus: &engine::SharedBus) {
    config::set_project_dir_ready_sink({
        let bus = Arc::clone(shared_bus);
        Arc::new(move |project_dir: String, workspace_path: String| {
            let mut bus = bus.lock().unwrap();
            bus.emit(json!({
                "type": "projectConversationDirReady",
                "projectDir": project_dir,
                "workspacePath": workspace_path,
            }));
        })
    });
}

/// 注册 MCP「服务器集合已变化」的上报出口。
///
/// 对齐 Embedded `MCPHost.notifyServersChanged`：会话的 MCP 引用刚建立 / 启用列表
/// 刚变化时，把该会话**当前启用**的 server 名列表广播出去，UI 据此把「连接中」
/// 刷新为已连接 / 失败。走 `sessionConfigChanged` 而不是新造事件——它与
/// `UiEvent.mcpEnabledChanged` 是同一条事实的两个方向。
fn install_mcp_servers_changed_sink(shared_bus: &engine::SharedBus) {
    crate::mcp::set_servers_changed_sink({
        let bus = Arc::clone(shared_bus);
        Arc::new(move |session_id: &str, names: Vec<String>| {
            let mut bus = bus.lock().unwrap();
            bus.emit(json!({
                "type": "sessionConfigChanged",
                "sessionId": session_id,
                "change": { "key": "mcpEnabled", "value": names },
            }));
        })
    });
}

/// 帧循环：读一帧、处理一帧，直到标准输入关闭或收到 `shutdown`。
///
/// 返回进程退出码（0 正常；协议不匹配为 2）。独立成函数是为了让
/// 协议层能在进程内被测试（真实宿主由 TS 侧的集成测试覆盖）。
fn run_frame_loop(
    mut reader: impl BufRead,
    core: &Arc<Core>,
    shared_bus: &engine::SharedBus,
) -> i32 {
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // 标准输入关闭：宿主退出，Core 随之退出
            Ok(_) => {}
            Err(err) => {
                eprintln!("[core] stdin error: {err}");
                break;
            }
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let frame: UiToCoreFrame = match decode_frame(trimmed) {
            Ok(frame) => frame,
            Err(err) => {
                eprintln!("[core] malformed frame: {err}");
                continue;
            }
        };

        match frame {
            UiToCoreFrame::Hello { protocol } => {
                if protocol != CORE_PROTOCOL_VERSION {
                    eprintln!(
                        "[core] protocol mismatch: host={protocol} core={CORE_PROTOCOL_VERSION}"
                    );
                    return 2;
                }
                let mut bus = shared_bus.lock().unwrap();
                if !bus.send(&CoreToUiFrame::Ready) {
                    break;
                }
            }
            UiToCoreFrame::UiEvent { event } => {
                dispatch_ui_event(core, shared_bus, event);
            }
            UiToCoreFrame::Response {
                id,
                ok,
                result,
                error,
            } => {
                let mut bus = shared_bus.lock().unwrap();
                bus.handle_response(id, ok, result, error);
            }
            UiToCoreFrame::Request { id, request } => {
                let response = match dispatch_ui_request(&request) {
                    Ok(result) => CoreToUiFrame::response(id, result),
                    Err(error) => CoreToUiFrame::error_response(id, error),
                };
                let mut bus = shared_bus.lock().unwrap();
                if !bus.send(&response) {
                    break;
                }
            }
            UiToCoreFrame::Shutdown => {
                eprintln!("[core] shutdown requested");
                break;
            }
        }
    }
    0
}

/// UI → core 请求的分发（对齐 `UiRequest`，见 `src/core/AssistantEventBus.ts`）。
///
/// 宿主不直接读 core 的磁盘数据（`docs/standalone-core.md` 第 10 节）：
/// 需要「core 的事实」时经帧通道请求，这里应答。未知类型一律报错而不是回空值——
/// 静默的空结果会让宿主把「契约漂移」误当成「确实没有数据」。
fn dispatch_ui_request(request: &Value) -> Result<Value, String> {
    let request_type = request
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "UI request without a type field".to_string())?;
    match request_type {
        "conversationListRequested" => {
            let workspace = request.get("workspacePath").and_then(Value::as_str);
            Ok(Value::Array(history::load_conversation_list(workspace)))
        }
        "uiLanguageRequested" => Ok(json!(config::read_ui_language())),
        // 系统语言是 OS 事实而不是磁盘事实；Standalone 下由 Core 统一探测，
        // 宿主不再自己起 PowerShell（Embedded 由宿主进程内的 `getSystemLocale()` 提供）。
        "systemLocaleRequested" => Ok(json!(i18n::get_system_locale())),
        "configHomeDirRequested" => config::config_home()
            .map(|path| json!(path.to_string_lossy())),
        "smartNamingRequested" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "smartNamingRequested without sessionId".to_string())?;
            smart_naming::smart_name_session(session_id)
        }
        "balanceRequested" => Ok(balance::fetch_balance().unwrap_or(Value::Null)),
        "llmConfigSaveRequested" => {
            let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
            llm_config::apply_llm_config_save(&payload)
        }
        "compactArchiveRequested" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "compactArchiveRequested without sessionId".to_string())?;
            Ok(compact_archive_display(session_id))
        }
        other => Err(format!("unknown UI request type: {other}")),
    }
}

/// 展开压缩归档时要显示的完整消息序列（对齐 `handleExpandCompact` 的合并口径）。
///
/// - 没有归档 → `null`（宿主据此提示「没有可展开的内容」）；
/// - 归档里已带摘要（新格式）→ `归档 + 当前保留区`；
/// - 归档里没有摘要（旧格式）→ `归档 + 主 JSONL 里的摘要 + 当前保留区`。
fn compact_archive_display(session_id: &str) -> Value {
    let Some(project) = history::project_of_session(session_id) else {
        return Value::Null;
    };
    let archived = history::load_compact_archive(session_id, &project);
    if archived.is_empty() {
        return Value::Null;
    }
    let is_summary = |message: &Value| {
        message.get("type").and_then(Value::as_str) == Some("user")
            && message.get("isCompactSummary").and_then(Value::as_bool) == Some(true)
    };
    let summary_count = archived.iter().filter(|message| is_summary(message)).count();

    let current = history::load_messages(session_id, &project);
    let compressed_summaries: Vec<Value> = current
        .iter()
        .filter(|message| is_summary(message))
        .cloned()
        .collect();
    // 只保留 user / assistant 且非压缩摘要的消息；`compact_boundary` 是 system 消息，
    // 已被类型条件排除。
    let retained: Vec<Value> = current
        .iter()
        .filter(|message| {
            let kind = message.get("type").and_then(Value::as_str).unwrap_or("");
            (kind == "user" || kind == "assistant") && !is_summary(message)
        })
        .cloned()
        .collect();

    let mut display = archived;
    if summary_count == 0 && !compressed_summaries.is_empty() {
        display.extend(compressed_summaries);
    }
    display.extend(retained);
    Value::Array(display)
}

/// UiEvent 分发（见 `src/core/initializeCoreEvents.ts` 的订阅清单）
fn dispatch_ui_event(core: &Arc<Core>, bus: &engine::SharedBus, event: Value) {
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        eprintln!("[core] dropped UiEvent without a type field");
        return;
    };
    {
        let mut bus = bus.lock().unwrap();
        bus.handle_ui_event(&event);
    }

    let session_id = event
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match event_type {
        // ===== 宿主环境 =====
        "hostEnvironmentProvided" => {
            core.on_host_environment(config::HostEnvironment {
                locale: event
                    .get("locale")
                    .and_then(Value::as_str)
                    .unwrap_or("en")
                    .to_string(),
                extension_path: event
                    .get("extensionPath")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                log_to_console: event
                    .get("logToConsole")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                config_dir_name: event
                    .get("configDirName")
                    .and_then(Value::as_str)
                    .unwrap_or(".tuxedo-cat")
                    .to_string(),
            });
        }
        "sessionWorkspaceAssigned" => {
            // 多工作目录宿主登记「会话 → 工作目录」；`null` / 空串表示清除登记。
            let workspace = event
                .get("workspacePath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty());
            config::set_session_workspace(&session_id, workspace.map(str::to_string));
        }
        "workspaceChanged" => {
            core.on_workspace_changed(
                event
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .map(|value| value.to_string()),
            );
        }

        // ===== 会话生命周期 =====
        "conversationStarted" => {
            start_conversation(core, &session_id, &event);
        }
        "conversationOpened" => {
            core.on_conversation_opened(&session_id);
        }
        "conversationClosed" => {
            core.on_conversation_closed(&session_id);
        }
        "conversationRenamed" => {
            let title = event.get("title").and_then(Value::as_str).unwrap_or("");
            core.on_conversation_renamed(&session_id, title);
        }
        "conversationDeleted" => {
            core.on_conversation_deleted(&session_id);
        }
        "conversationSpaceCleared" => {
            // 与 Embedded 一致：`sessionId` 在这里是**对话空间目录名**，清空整个空间。
            match history::clear_conversation_space(&session_id) {
                Ok((removed_files, _removed_bytes)) => {
                    // 清掉归属该空间的内存会话，避免 UI 继续显示已删除的对话
                    clear_memory_sessions_of_space(core, &session_id);
                    emit(
                        core,
                        json!({
                            "type": "message",
                            "sessionId": session_id,
                            "data": {
                                "role": "system",
                                "content": format!("对话空间已清空（{removed_files} 个文件）"),
                            },
                        }),
                    );
                    core.emit_runtime();
                    emit(core, json!({ "type": "conversationListChanged" }));
                }
                Err(err) => eprintln!("[core] conversationSpaceCleared failed: {err}"),
            }
        }
        "conversationContextUpdated" => {
            let changes = event
                .get("changes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            core.on_context_updated(&session_id, &changes);
        }

        // ===== 会话配置 =====
        "modelChanged" => {
            core.on_session_config_changed(
                &session_id,
                &json!({ "key": "model", "value": event.get("ref").cloned().unwrap_or(Value::Null) }),
            );
        }
        "agentModeChanged" => {
            core.on_session_config_changed(
                &session_id,
                &json!({ "key": "agentMode", "value": event.get("mode").cloned().unwrap_or(Value::Null) }),
            );
        }
        "thinkingEffortChanged" => {
            core.on_session_config_changed(
                &session_id,
                &json!({ "key": "thinkingEffort", "value": event.get("mode").cloned().unwrap_or(Value::Null) }),
            );
        }
        "promptModeChanged" => {
            core.on_session_config_changed(
                &session_id,
                &json!({ "key": "promptMode", "value": event.get("mode").cloned().unwrap_or(Value::Null) }),
            );
        }
        "webSearchChanged" => {
            core.on_session_config_changed(
                &session_id,
                &json!({ "key": "webSearch", "value": event.get("enabled").cloned().unwrap_or(Value::Null) }),
            );
        }
        "mcpEnabledChanged" => {
            // MCP 尚未迁入（见 TODO.md 已知缺口）：本阶段只记录，不广播，
            // 避免 UI 触发尚未接线的 MCP 面板刷新。
            eprintln!("[core] mcpEnabledChanged ignored (MCP not migrated): session={session_id}");
        }

        // ===== 用户选择 =====
        // 宿主上报「该会话的用户选择框是否在 webview 里等待应答」
        // （弹出 / 应答 / 视图销毁时各一次），对齐 `markSessionWaiting`。
        "userChoicePendingChanged" => {
            let pending = event.get("pending").and_then(Value::as_bool).unwrap_or(false);
            core.on_user_choice_pending(&session_id, pending);
        }

        // ===== 消息 =====
        "userMessageSubmitted" => {
            core.on_user_message(&event);
        }
        "abortRequested" => {
            core.on_abort(&session_id);
        }
        "compactRequested" => {
            // 对齐 Embedded `Integration.requestCompact`：空闲时立即压缩，非空闲时
            // 登记「待压缩」交由下一轮对话开始时执行。
            //
            // 压缩要发一次 LLM 摘要请求（阻塞），放后台线程跑，避免卡住帧通道。
            let core = Arc::clone(core);
            let worker_session = session_id.clone();
            std::thread::spawn(move || {
                core.request_compact(&worker_session);
            });
        }

        // ===== 其它 =====
        "editRolledBack" => {
            // 对齐 Embedded `history/rollback.rollbackEdit`：按会话历史里的
            // `_meta` / `tool_result.beforeContent` 备份恢复磁盘文件，结果作为一条
            // system 消息回传 webview。
            let tool_use_id = event
                .get("toolUseId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let direction = event
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("before");
            let file_path = event.get("filePath").and_then(Value::as_str);
            let content = rollback::rollback_edit(&session_id, tool_use_id, direction, file_path);
            emit(
                core,
                json!({
                    "type": "message",
                    "sessionId": session_id,
                    "data": { "role": "system", "content": content },
                }),
            );
        }
        "llmConfigSaved" => {
            config::reset_settings_cache();
        }
        "settingsJsonUpdateRequested" => {
            // Standalone 下全局 `settings.json` 的唯一写入点（`docs/standalone-core.md`
            // 第 8 节）：宿主把「要改的字段」作为 JSON Merge Patch 交过来，Core 串行化
            // 「读-改-写」并清掉自己的读缓存。
            let patch = event.get("patch").cloned().unwrap_or_else(|| json!({}));
            if let Err(err) = config::update_settings_json(&patch) {
                emit(
                    core,
                    json!({
                        "type": "log",
                        "message": format!("Failed to update settings.json: {err}"),
                    }),
                );
            }
            // 语言设置变了就重新收敛 core locale（对齐 Embedded 保存配置后的
            // `setCoreUiLanguage`）；其它字段不影响。
            if let Some(language) = patch.get("uiLanguage").and_then(Value::as_str) {
                core.on_ui_language_changed(language);
            }
            // MCP 全局默认启用列表变了：让所有已注册会话按新的默认值重同步连接
            // （对齐 Embedded `syncAllSessions`）。
            if patch.get("mcp").is_some() {
                crate::mcp::sync_all_sessions();
            }
        }
        other => {
            eprintln!("[core] uiEvent: {other}");
        }
    }
}

fn emit(core: &Arc<Core>, event: Value) {
    let mut bus = core.bus.lock().unwrap();
    bus.emit(event);
}

/// 清掉 project 归属指定对话空间（目录名）的内存会话
fn clear_memory_sessions_of_space(core: &Arc<Core>, dir_name: &str) {
    let sessions: Vec<Arc<Mutex<engine::SessionState>>> = {
        let map = core.sessions.lock().unwrap();
        map.values().map(Arc::clone).collect()
    };
    for state in sessions {
        let belongs = {
            let project = state.lock().unwrap().project.clone();
            project
                .and_then(|project| config::project_conversation_dir(&project).ok())
                .and_then(|dir| {
                    dir.file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
                .map(|name| name == dir_name)
                .unwrap_or(false)
        };
        if belongs {
            let mut state = state.lock().unwrap();
            state.messages.clear();
            state.last_uuid = None;
        }
    }
}

/// `conversationStarted`：登记会话归属的工作目录。
///
/// 对齐 Embedded 的 `initializeCoreEvents`：该事件只做 `createEngine`（内存态），
/// **不创建会话文件、不广播 `sessionCreated` / `conversationListChanged`**——
/// `meta.json` / `.jsonl` 只在第一条消息持久化（`appendMessage`）时创建，
/// 否则「点了新建但没发消息」会在磁盘上留下一个空对话并出现在列表里。
/// 没有工作目录时 Embedded 直接返回（不报错），这里同样静默返回。
fn start_conversation(core: &Arc<Core>, session_id: &str, event: &Value) {
    if session_id.is_empty() {
        return;
    }
    let project = event
        .get("workspacePath")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .or_else(|| config::project_root(session_id).ok())
        .unwrap_or_default();
    if project.is_empty() {
        return;
    }

    let state = core.session(session_id);
    state.lock().unwrap().project = Some(project);
    core.emit_runtime();
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;

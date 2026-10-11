//! Standalone Core（见 docs/standalone-core.md）。
//!
//! 进程模型：由宿主（VS Code 扩展宿主 / Electron 主进程）启动，标准输入 / 标准输出
//! 为帧通道，标准错误为诊断输出。一个 Core 进程服务一个宿主实例。
//!
//! 启动顺序：读 `hello` 帧 → 校验协议版本 → 回 `ready` → 进入帧循环。
//! 退出：收到 `shutdown` 帧或标准输入 EOF（宿主退出）。

// 保留控制台子系统：这样部署后的 Core 二进制在终端里跑 `--help` / `start` 时输出
// 可见（独立运行的前提）。宿主与 daemon 起本进程时分别用 `windowsHide` /
// `CREATE_NO_WINDOW` 隐藏控制台窗口（`src/host/standalone/CoreDaemon.ts`、
// `util::hide_console`），因此不会出现窗口闪烁。
mod balance;
mod bash_task;
mod bus;
mod cli;
mod commands;
mod compact;
mod config;
mod core_text;
mod daemon;
mod daemon_protocol;
mod engine;
mod frame;
mod history;
mod llm;
mod mcp;
mod mcp_config;
mod mcp_http;
mod permission;
mod power;
mod prompt;
mod remote;
mod replay;
mod responses;
mod rollback;
mod settings;
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
    // 崩溃诊断先于一切动作安装：daemon 与 Core 两种模式都可能异常退出，
    // panic 位置 + 调用栈必须落进日志（见 `util::install_panic_hook`）
    util::install_panic_hook();
    // 动作选择（`docs/core-daemon.md` 第 3 节）：`stdio` 是单进程 Core（stdio 是帧通道）；
    // `start`（缺省）是远程服务的启动器（确保后台 daemon 在跑、打印就绪信息后退出），
    // `kill` 结束它，daemon 实体走隐藏动作 `start-daemon`（`docs/core-daemon.md` 第 12 节）。
    // `--help` / `--version` 与参数错误都在 `cli::parse` 里收口。
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        cli::Command::Help => print!("{}", cli::usage()),
        cli::Command::Version => println!("{}", cli::version()),
        cli::Command::Error(message) => {
            let program = cli::program_name();
            eprintln!("{program}: {message}");
            eprintln!("用 `{program} --help` 查看用法。");
            std::process::exit(2);
        }
        cli::Command::Start(options) => std::process::exit(remote::run_start(options)),
        cli::Command::StartDaemon(options) => {
            std::process::exit(remote::run_start_daemon(options))
        }
        cli::Command::Kill => std::process::exit(remote::run_kill()),
        cli::Command::Stdio => run_core(),
    }
}

/// 单进程 Core 模式：读 `hello` → 回 `ready` → 进入帧循环。
fn run_core() {
    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let shared_bus: engine::SharedBus = Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(
        Box::new(std::io::stdout()),
    )));
    install_mcp_servers_changed_sink(&shared_bus);
    // MCP：清掉没有任何会话引用的残留进程（上一次 Core 崩溃留下的孤儿）
    crate::mcp::prune();
    let core = Arc::new(Core::new(Arc::clone(&shared_bus)));
    // 后台任务周期性提醒：进程级调度线程，空闲满一个间隔后向 LLM 投递 reminder
    core.start_background_reminder_scheduler();

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
                let response = match dispatch_ui_request(core, &request) {
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
fn dispatch_ui_request(core: &Core, request: &Value) -> Result<Value, String> {
    let request_type = request
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "UI request without a type field".to_string())?;
    match request_type {
        "conversationListRequested" => {
            let workspace = request.get("workspacePath").and_then(Value::as_str);
            Ok(Value::Array(history::load_conversation_list(workspace)))
        }
        "smartNamingRequested" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "smartNamingRequested without sessionId".to_string())?;
            smart_naming::smart_name_session(session_id)
        }
        "balanceRequested" => Ok(balance::fetch_balance().unwrap_or(Value::Null)),
        "compactArchiveRequested" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "compactArchiveRequested without sessionId".to_string())?;
            Ok(compact_archive_display(session_id))
        }
        // MCP 面板列表：配置（快照）+ 会话生效的启用状态 + 运行时状态
        // （对齐 Embedded `pushMcpServers` 的合并口径）。
        "mcpServersRequested" => {
            let session_id = request.get("sessionId").and_then(Value::as_str);
            Ok(Value::Array(crate::mcp::servers_with_runtime(session_id)))
        }
        // 对话空间统计：数据在 Core 的数据目录内，宿主不直接读盘。
        "conversationSpacesRequested" => Ok(Value::Array(history::conversation_spaces())),
        // 等待某会话的挂起持久化完成。Rust 侧的会话写盘是同步的（写锁串行），
        // 请求到达时没有「未完成的持久化」，校验字段后直接应答。
        "flushSessionRequested" => {
            request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "flushSessionRequested without sessionId".to_string())?;
            Ok(Value::Null)
        }
        // 会话内容与派生事实：宿主渲染对话 / 工具元数据 / 模型身份用。
        "conversationLoadRequested" => {
            let session_id = request
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "conversationLoadRequested without sessionId".to_string())?;
            Ok(conversation_load_payload(core, session_id))
        }
        // 斜杠命令与技能列表（内置命令 + 内置技能 + 会话工作目录下的技能）。
        "skillsRequested" => {
            let session_id = request.get("sessionId").and_then(Value::as_str);
            let cwd = session_id
                .and_then(|id| config::project_root(id).ok())
                .unwrap_or_default();
            Ok(skills_payload(&cwd))
        }
        other => Err(format!("unknown UI request type: {other}")),
    }
}

/// 会话加载结果：消息 + 元数据 + 派生事实（对齐 Embedded `loadConversationForHost`）。
///
/// - 会话文件不存在 → 空消息 + `metadata: null`（宿主据此走「新对话」路径）；
/// - 会话空闲时给缺失 tool_result 的 tool_use 补「会话中断」取消结果（对齐 Embedded
///   `loadConversation` 的 `ensureToolResults` + `workingSessions` 守卫）：否则上次
///   崩溃时正在执行的 tool_use 没有 tool_result，webview 按「无结果且非待确认」推导为
///   running，永远显示运行中；运行中的会话不伪造；
/// - `pendingToolUseIds` 恒为空：Standalone 的工具执行状态不落盘，进程重启后不存在
///   进程内待执行表（中断的工具经上一条补取消结果渲染为失败）；
/// - `agentMode` 取 meta.json 的权威值（缺失为 null，由宿主回退默认值）。
fn conversation_load_payload(core: &Core, session_id: &str) -> Value {
    let Some(project) = history::project_of_session(session_id) else {
        return json!({
            "messages": [],
            "metadata": Value::Null,
            "pendingToolUseIds": [],
            "hasCompactArchive": false,
            "agentMode": Value::Null,
        });
    };
    let mut messages = history::load_messages(session_id, &project);
    if core.session_is_idle(session_id) {
        history::ensure_tool_results(&mut messages);
    }
    let metadata = history::load_metadata(session_id, &project);
    let has_compact_archive = !history::load_compact_archive(session_id, &project).is_empty();
    let agent_mode = metadata
        .as_ref()
        .map(|metadata| json!(prompt::agent_mode_of(metadata)))
        .unwrap_or(Value::Null);
    json!({
        "messages": messages,
        "metadata": metadata,
        "pendingToolUseIds": [],
        "hasCompactArchive": has_compact_archive,
        "agentMode": agent_mode,
    })
}

/// 斜杠命令与技能列表：内置命令（`isBuiltin=true`）+ 内置技能 + 工作目录下的技能。
fn skills_payload(cwd: &str) -> Value {
    let mut skills: Vec<Value> = Vec::new();
    for command in commands::builtin_commands() {
        skills.push(json!({
            "name": command.name,
            "description": command.description,
            "isBuiltin": true,
        }));
    }
    for skill in skills::bundled_skills() {
        skills.push(json!({
            "name": skill.name,
            "description": skill.description,
            "isBuiltin": false,
        }));
    }
    if !cwd.is_empty() {
        for skill in skills::get_skill_dir_commands(cwd) {
            skills.push(json!({
                "name": skill.name,
                "description": skill.description,
                "isBuiltin": false,
            }));
        }
    }
    json!({ "skills": skills })
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

    // 就绪前只接受宿主环境与配置快照（`docs/core-ui-separation.md` 第 7 节）：
    // 其它 UiEvent 说明宿主接线顺序错了，记一条 log 暴露而不是静默生效。
    // 快照就是 core 的就绪判据（`settings.rs`），不需要额外的状态位。
    if event_type != "hostEnvironmentProvided" && !settings::has_settings_snapshot() {
        emit(
            core,
            json!({
                "type": "log",
                "message": format!(
                    "UiEvent.{event_type} arrived before the Core is ready;                      the host must send hostEnvironmentProvided first",
                ),
            }),
        );
        return;
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
                    .unwrap_or(config::DEFAULT_CONFIG_DIR_NAME)
                    .to_string(),
            });
            // 配置快照：与宿主环境同一条事件一次给齐。缺字段是协议错误，
            // 记一条 log 事件暴露，不静默回落（`docs/core-ui-separation.md` 第 4.4 节）。
            match settings::apply_from_host_environment(&event) {
                Ok(mcp_defaults_changed) => {
                    // 快照就是就绪判据：应用完才算就绪（`docs/core-ui-separation.md` 第 7 节）。宿主据此判定
                    // 「Core 已跟上最新配置」，每次重新推送快照后都会再收到一次。
                    emit(core, json!({ "type": "coreReady" }));
                    // MCP 全局默认启用列表变了：让所有已注册会话按新的默认值重同步连接。
                    // 配置变更只经快照到达 core（`docs/core-ui-separation.md` 第 4.5 节），没有单独的通知事件。
                    if mcp_defaults_changed {
                        crate::mcp::sync_all_sessions();
                    }
                }
                Err(err) => emit(
                    core,
                    json!({ "type": "log", "message": format!("Failed to apply settings snapshot: {err}") }),
                ),
            }
        }
        "sessionWorkspaceAssigned" => {
            // 多工作目录宿主登记「会话 → 工作目录」；`null` / 空串表示清除登记。
            let workspace = event
                .get("workspacePath")
                .and_then(Value::as_str)
                .filter(|path| !path.is_empty());
            config::set_session_workspace(&session_id, workspace.map(str::to_string));
        }
        // 旧多工作目录模型的活动工作目录入口：`UiEvent` 词汇表已无此事件
        // （工作目录按会话登记，见 `sessionWorkspaceAssigned`）。保留为测试 /
        // 兜底路径：`conversationListRequested` 不带 workspacePath 时回退到它。
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
            // 与 Embedded 一致：`dirName` 是**对话空间目录名**，清空整个空间。
            // mode 决定清理深度（对齐 UiEvent 契约）：`clear` 清内容保留空间目录
            // （workspace 还在，项目映射要留着）；`remove` 整目录删除（workspace 已
            // 不存在，清掉后列表不再显示）。旧宿主不带 mode（两侧同包分发，跨版本
            // 窗口期）按 clear 处理。
            let mode = event.get("mode").and_then(Value::as_str).unwrap_or("clear");
            let dir_name = event
                .get("dirName")
                .and_then(Value::as_str)
                .unwrap_or(&session_id)
                .to_string();
            let outcome = if mode == "remove" {
                history::remove_conversation_space(&dir_name)
            } else {
                history::clear_conversation_space(&dir_name)
            };
            // 成功与失败都必须发 `conversationSpaceCleared` 回执（判别联合）：
            // webview 设置面板的「删除中」按钮靠它解除——UiEvent 是 fire-and-forget，
            // 这是唯一的完成信号，静默失败（此前只 eprintln!）会让面板永远停在「删除中」。
            match outcome {
                Ok((removed_files, removed_bytes)) => {
                    // 清掉归属该空间的内存会话，避免 UI 继续显示已删除的对话
                    clear_memory_sessions_of_space(core, &dir_name);
                    core.emit_runtime();
                    emit(
                        core,
                        json!({
                            "type": "conversationSpaceCleared",
                            "dirName": dir_name,
                            "result": {
                                "status": "complete",
                                "removedFiles": removed_files,
                                "removedBytes": removed_bytes,
                            },
                        }),
                    );
                    emit(core, json!({ "type": "conversationListChanged" }));
                }
                Err(err) => {
                    emit(
                        core,
                        json!({
                            "type": "conversationSpaceCleared",
                            "dirName": dir_name,
                            "result": { "status": "error", "message": err },
                        }),
                    );
                }
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
            // 单开关语义（对齐 Embedded `Config.setSessionMcpEnabled`）：把这次勾选
            // 合并进该会话的启用列表（内存覆盖 + 尽力写 meta.json），再让 MCPHost
            // 按新列表做差量同步。同步完成后由 `notifyServersChanged` 出口广播
            // `sessionConfigChanged(mcpEnabled)`，UI 据此把「连接中」刷新为最终状态，
            // 因此这里不再单独广播（否则会多发一次未收敛的列表）。
            let name = event.get("name").and_then(Value::as_str).unwrap_or("");
            let enabled = event.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            crate::mcp_config::set_session_mcp_enabled(Some(session_id.as_str()), name, enabled);
            crate::mcp::on_session_enabled_changed(&session_id);
        }
        "mcpEnabledListChanged" => {
            // 整表覆盖语义（对齐 Embedded `Config.setSessionMcpEnabledList`）：`names`
            // 是该会话启用后的完整列表，直接覆盖（去重、保留首次出现顺序），不做增量。
            // 内存覆盖同步生效——宿主保存默认配置时先发本事件把当前对话钉住，
            // 紧接着的配置写盘触发的 `sync_all_sessions` 必须能读到这个覆盖。
            let names: Vec<String> = event
                .get("names")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            crate::mcp_config::write_session_enabled(&session_id, &names);
            crate::mcp::on_session_enabled_changed(&session_id);
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
        // 用户把正在前台运行的 Bash 命令转入后台（Bash 卡片「转后台」按钮）：
        // 触发转换 + 暂停下一轮 LLM 请求（见 `tools.rs` 的手工转后台注册表）。
        "bashBackgroundRequested" => {
            let tool_use_id = event
                .get("toolUseId")
                .and_then(Value::as_str)
                .unwrap_or("");
            core.on_bash_background_requested(&session_id, tool_use_id);
        }
        "queuedMessageDiscarded" => {
            // 对齐 Embedded `QueryEngine.discardPendingUserMessage`：webview 排队项的
            // 「编辑 / 删除」撤回排队消息。按 uuid 配对，未消费才丢弃。
            let uuid = event.get("uuid").and_then(Value::as_str).unwrap_or("");
            core.on_queued_message_discarded(&session_id, uuid);
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
fn start_conversation(core: &Arc<Core>, session_id: &str, _event: &Value) {
    if session_id.is_empty() {
        return;
    }
    // 会话工作目录的登记入口是 `sessionWorkspaceAssigned`（事件载荷不携带目录，
    // 与 Embedded 的 `createEngine` 同口径：只按会话解析）。
    let project = config::project_root(session_id)
        .ok()
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

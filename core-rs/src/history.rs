//! 会话数据：`<sessionId>.meta.json` 与 `<sessionId>.jsonl`。
//!
//! 落盘格式：Core 写入、宿主读取同一份目录。
//! JSONL 每行一条 `StoredMessage`（`uuid` / `parentUuid` / `timestamp` / `message`），
//! `tool_use_update` 记录按顺序回放覆盖已写入的 tool_use block。


use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Map, Value};

use crate::config;
use crate::util;

/// 同一会话文件的写操作串行化
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 校验会话 id。id 由宿主生成并经帧通道传入（信任边界），
/// 它会直接拼进文件名，因此禁止路径分隔符与 `.` / `..`，避免越出会话目录。
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty() {
        return Err("session id is empty".to_string());
    }
    if session_id == "." || session_id == ".." || session_id.contains(['/', '\\', '\0']) {
        return Err(format!("invalid session id: {session_id:?}"));
    }
    Ok(())
}

/// 会话文件名 `<sessionId><suffix>`（先校验 id）
fn session_file_name(session_id: &str, suffix: &str) -> Result<String, String> {
    validate_session_id(session_id)?;
    Ok(format!("{session_id}{suffix}"))
}

pub fn metadata_path(session_id: &str, project: &str) -> Result<PathBuf, String> {
    Ok(config::project_conversation_dir(project)?.join(session_file_name(session_id, ".meta.json")?))
}

/// 读取压缩归档：返回归档里的 `message` 对象。
///
/// 文件不存在或读取失败时返回空表（调用方据此判定「没有归档」）。
pub fn load_compact_archive(session_id: &str, project: &str) -> Vec<Value> {
    let Ok(path) = compact_archive_path(session_id, project) else {
        return Vec::new();
    };
    let Ok(text) = util::read_to_string_lossy(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            // 与 `parse_messages` 同口径：宿主写入的行可能带孤立代理项转义，清洗后再解析
            serde_json::from_str::<Value>(&util::sanitize_json_surrogates(line))
                .ok()
                .and_then(|stored| stored.get("message").cloned())
        })
        .collect()
}

/// 对话列表元数据。
///
/// - `workspace_path` 为 `Some` 时读该工作目录的列表；`None` 时用活动工作目录；
///   宿主未打开工作目录（活动目录为空）时返回**空表**而不是报错——异常会一路冒泡到
///   webview 消息回调，变成 "rejected promise not handled within 1 second"。
/// - 只认 `<projectDir>/*.meta.json`；`messageCount === 0` 且没有 `clearedAt` 的空对话
///   跳过（清空过的会话保留条目）；单条损坏只跳过该条。
/// - 按 `updatedAt ?? createdAt` 倒序排序。
///
/// 这里不做列表缓存：core 是磁盘的唯一写入方，
/// 每次现读磁盘拿到的就是最新事实；宿主侧另有自己的快照缓存。
pub fn load_conversation_list(workspace_path: Option<&str>) -> Vec<Value> {
    let project = match workspace_path.filter(|path| !path.is_empty()) {
        Some(path) => path.to_string(),
        None => match config::active_workspace() {
            Some(path) => path,
            None => return Vec::new(),
        },
    };

    let Ok(dir) = config::project_conversation_dir(&project) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        // 目录不存在（ENOENT）与其它读取失败一样返回空表：列表读取不该抛错
        return Vec::new();
    };

    let mut conversations: Vec<Value> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 工作区清单（workspace.meta.json）也以 .meta.json 结尾，但它不是会话，
        // 混进列表会渲染成幽灵条目，必须排除。
        if !name.ends_with(".meta.json") || name == "workspace.meta.json" {
            continue;
        }
        let Ok(text) = util::read_to_string_lossy(&entry.path()) else {
            continue;
        };
        let Ok(metadata) = serde_json::from_str::<Value>(&util::sanitize_json_surrogates(&text))
        else {
            continue;
        };
        if !metadata.is_object() {
            continue;
        }
        let message_count = metadata.get("messageCount").and_then(Value::as_u64).unwrap_or(0);
        let cleared = metadata.get("clearedAt").map(|value| !value.is_null()).unwrap_or(false);
        if message_count == 0 && !cleared {
            continue;
        }
        conversations.push(metadata);
    }

    // 跨工作区子代理的占位父对话派生已随容器概念删除（specs/025 FR-001）：派发的
    // 对话本身是顶层普通会话，无 `crossWorkspaceOrigin`、无 `ph_` 条目。

    let sort_key = |value: &Value| -> i64 {
        value
            .get("updatedAt")
            .and_then(Value::as_f64)
            .or_else(|| value.get("createdAt").and_then(Value::as_f64))
            .unwrap_or(0.0) as i64
    };
    // 稳定排序：`updatedAt` 相同时保持目录读取顺序
    conversations.sort_by(|a, b| sort_key(b).cmp(&sort_key(a)));
    conversations
}

pub fn messages_path(session_id: &str, project: &str) -> Result<PathBuf, String> {
    Ok(config::project_conversation_dir(project)?.join(session_file_name(session_id, ".jsonl")?))
}

/// 压缩归档路径 `<sessionId>.compact_archive.jsonl`
pub fn compact_archive_path(session_id: &str, project: &str) -> Result<PathBuf, String> {
    Ok(config::project_conversation_dir(project)?
        .join(session_file_name(session_id, ".compact_archive.jsonl")?))
}

// ==================== 元数据 ====================

/// 读取 `meta.json`；缺失或解析失败返回 None
pub fn load_metadata(session_id: &str, project: &str) -> Option<Value> {
    let path = metadata_path(session_id, project).ok()?;
    let text = util::read_to_string_lossy(&path).ok()?;
    // 宿主可能写入孤立代理项（`\ude00`），serde_json 严格解析会整行失败
    serde_json::from_str(&util::sanitize_json_surrogates(&text)).ok()
}

/// 从 `meta.json` 解析 `creator`（specs/025 FR-002）：缺失 / 形态不对是数据异常，
/// 报错不回退——静默当 `User` 会把 Agent 会话误判成可输入 / 会提醒的正常对话。
/// 形态与 TS 侧 `parseSessionCreator` 同一口径。
pub fn creator_of_metadata(metadata: &Value) -> Result<crate::engine::SessionCreator, String> {
    let value = metadata
        .get("creator")
        .ok_or_else(|| "meta.json is missing creator".to_string())?;
    serde_json::from_value(value.clone())
        .map_err(|err| format!("meta.json has an invalid creator: {err}"))
}

/// `meta.json` 里记录「最后一条一次性通知」的字段名（`docs/hosts/webview-ui.md` 第 11 节）。
///
/// 一个对话至多一条：once 通知只是时间线末位的提示，后到的覆盖先到的；
/// 任何新消息落盘（`touch_metadata`）或整批替换（`replace_messages`）即清空。
pub const ONCE_MESSAGE_KEY: &str = "onceMessage";

/// 把一次性通知记进 `meta.json`（覆盖上一条，恒只有一个槽位）。
///
/// 通知本体**不**写进 `<sid>.jsonl`、不进内存消息列表与 LLM 上下文：它只在
/// 时间线末位显示，重开对话时由 UI 从 meta 追加回末位。
pub fn save_once_message(session_id: &str, project: &str, message: &Value) -> Result<(), String> {
    update_metadata(
        session_id,
        project,
        || json!({ "sessionId": session_id, "project": project }),
        |metadata| {
            if let Some(object) = metadata.as_object_mut() {
                object.insert(ONCE_MESSAGE_KEY.to_string(), message.clone());
            }
        },
    )?;
    Ok(())
}

/// 读-改-写 `meta.json`；不存在时用 `fallback` 初始化
pub fn update_metadata(
    session_id: &str,
    project: &str,
    fallback: impl FnOnce() -> Value,
    mutator: impl FnOnce(&mut Value),
) -> Result<Value, String> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let dir = config::ensure_project_conversation_dir(project)?;
    let path = dir.join(session_file_name(session_id, ".meta.json")?);
    let mut metadata = util::read_to_string_lossy(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&util::sanitize_json_surrogates(&text)).ok())
        .unwrap_or_else(fallback);
    // 磁盘上的 meta.json 可能是合法 JSON 但非对象（如 `[]` / `"x"`）。
    // serde_json 的 `IndexMut` 对非对象会 panic，这里先规整为对象。
    if !metadata.is_object() {
        metadata = Value::Object(Map::new());
    }
    mutator(&mut metadata);
    let text = serde_json::to_string_pretty(&metadata).map_err(|err| err.to_string())?;
    std::fs::write(&path, text).map_err(|err| format!("write {} failed: {err}", path.display()))?;
    Ok(metadata)
}

/// 创建会话文件（`meta.json` + 空 `.jsonl`）
///
/// 生产路径**不再**调用它：`meta.json` / `.jsonl` 只在第一条消息时创建
/// （见 `engine::update_title_if_needed` 与 `history::append_message`），
/// 避免「点了新建但没发消息」留下空对话。保留给测试与后续「预建会话」场景。
#[allow(dead_code)]
pub fn create_conversation(
    session_id: &str,
    project: &str,
    metadata: Value,
) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let dir = config::ensure_project_conversation_dir(project)?;
    let meta_path = dir.join(session_file_name(session_id, ".meta.json")?);
    let messages_path = dir.join(session_file_name(session_id, ".jsonl")?);
    let text = serde_json::to_string_pretty(&metadata).map_err(|err| err.to_string())?;
    std::fs::write(&meta_path, text)
        .map_err(|err| format!("write {} failed: {err}", meta_path.display()))?;
    if !messages_path.exists() {
        std::fs::write(&messages_path, "")
            .map_err(|err| format!("write {} failed: {err}", messages_path.display()))?;
    }
    Ok(())
}

/// 预建子代理会话的 `meta.json`（+ 空 `.jsonl`）。
///
/// 子代理会话必须**先**把 `parentSessionId` / `role` / `model` 写进 `meta.json`：
/// 否则对话列表 / 树形结构无法关联到主对话，点进子会话也拿不到 `parentSessionId`。
/// 之后第一条消息落盘时 `touch_metadata` 会读取既有 meta 并保留这些字段，
/// 只递增 `messageCount` 与更新标题。
pub fn create_sub_agent_metadata(
    session_id: &str,
    project: &str,
    title: &str,
    parent_session_id: &str,
    role: &str,
    model: Option<&str>,
    provider: Option<&str>,
) -> Result<(), String> {
    let now = util::now_millis();
    let mut metadata = Map::new();
    metadata.insert("sessionId".to_string(), json!(session_id));
    metadata.insert("project".to_string(), json!(project));
    metadata.insert("title".to_string(), json!(title));
    metadata.insert("createdAt".to_string(), json!(now));
    metadata.insert("updatedAt".to_string(), json!(now));
    metadata.insert("messageCount".to_string(), json!(0));
    metadata.insert("parentSessionId".to_string(), json!(parent_session_id));
    metadata.insert("role".to_string(), json!(role));
    // 本地子代理：creator 为 agent 形态、workspaceId 为 null（创建方在本工作区，
    // specs/025 FR-002；身份算法唯一落点是宿主 workspaceIdentity.ts，Core 不持该事实）
    metadata.insert(
        "creator".to_string(),
        json!({ "kind": "agent", "workspaceId": null, "sessionId": parent_session_id }),
    );
    // 空值不写该键
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        metadata.insert("model".to_string(), json!(model));
    }
    if let Some(provider) = provider.filter(|value| !value.is_empty()) {
        metadata.insert("provider".to_string(), json!(provider));
    }
    create_conversation(session_id, project, Value::Object(metadata))
}

/// 预建跨工作区子代理会话的 `meta.json`（specs/023 FR-003；specs/025 FR-001 / FR-002）。
///
/// 跨工作区对话是顶层普通会话：不写 `parentSessionId`（无占位父对话），归属由
/// `creator` 承载（agent 形态，携带发起方工作区身份与会话 id）。
pub fn create_remote_sub_agent_metadata(
    session_id: &str,
    project: &str,
    title: &str,
    role: &str,
    origin_workspace_id: &str,
    origin_session_id: &str,
    model: Option<&str>,
    provider: Option<&str>,
) -> Result<(), String> {
    let now = util::now_millis();
    let mut metadata = Map::new();
    metadata.insert("sessionId".to_string(), json!(session_id));
    metadata.insert("project".to_string(), json!(project));
    metadata.insert("title".to_string(), json!(title));
    metadata.insert("createdAt".to_string(), json!(now));
    metadata.insert("updatedAt".to_string(), json!(now));
    metadata.insert("messageCount".to_string(), json!(0));
    metadata.insert("role".to_string(), json!(role));
    metadata.insert(
        "creator".to_string(),
        json!({
            "kind": "agent",
            "workspaceId": origin_workspace_id,
            "sessionId": origin_session_id,
        }),
    );
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        metadata.insert("model".to_string(), json!(model));
    }
    if let Some(provider) = provider.filter(|value| !value.is_empty()) {
        metadata.insert("provider".to_string(), json!(provider));
    }
    create_conversation(session_id, project, Value::Object(metadata))
}

/// 删除会话（`meta.json` + `.jsonl` + 压缩归档 + `tool-results/<sid>__*`）。
///
/// 递归删除该会话及其**所有层级的子孙对话**
/// （`parentSessionId` 链传递闭包，先删子孙再删自己，中途失败不留孤儿）。
pub fn delete_conversation(session_id: &str, project: &str) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let dir = config::project_conversation_dir(project)?;
    for id in conversation_closure_in(&dir, session_id) {
        delete_single_conversation(&dir, &id)?;
    }
    Ok(())
}

/// 受影响闭包（按项目目录名解析目录）：`session_id` 自身 + 所有层级的子孙对话。
///
/// 与 `collectConversationClosure` 同一规则；供 `delete_conversation` 与
/// `Core::on_conversation_deleted`（逐个释放运行时状态）共用。
pub fn conversation_closure(session_id: &str, project: &str) -> Vec<String> {
    match config::project_conversation_dir(project) {
        Ok(dir) => conversation_closure_in(&dir, session_id),
        Err(_) => vec![session_id.to_string()],
    }
}

/// 受影响闭包：`session_id` 自身 + 所有层级的子孙对话（对齐 `collectConversationClosure`）。
///
/// 输入是项目对话目录下的全部 `*.meta.json`。子对话可能自己未登记工作目录，
/// 但一定与父对话同属一个项目目录，因此只扫当前目录即可。
fn conversation_closure_in(dir: &std::path::Path, session_id: &str) -> Vec<String> {
    let mut pairs: Vec<(String, Option<String>)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            // 工作区清单不是会话，不进闭包输入
            if name == "workspace.meta.json" {
                continue;
            }
            let Some(id) = name.strip_suffix(".meta.json") else {
                continue;
            };
            let parent = util::read_to_string_lossy(&entry.path())
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&util::sanitize_json_surrogates(&text)).ok())
                .and_then(|metadata| {
                    metadata
                        .get("parentSessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            pairs.push((id.to_string(), parent));
        }
    }

    let mut affected: Vec<String> = vec![session_id.to_string()];
    let mut grew = true;
    while grew {
        grew = false;
        for (id, parent) in &pairs {
            let Some(parent) = parent else { continue };
            if affected.iter().any(|value| value == parent) && !affected.iter().any(|value| value == id) {
                affected.push(id.clone());
                grew = true;
            }
        }
    }
    // 先删子孙再删自己
    affected.retain(|id| id != session_id);
    affected.push(session_id.to_string());
    affected
}

/// 删除单个会话的落盘数据（**不处理子对话**，对齐 `deleteSingleConversation` 的落盘部分）
fn delete_single_conversation(dir: &std::path::Path, session_id: &str) -> Result<(), String> {
    for suffix in [".meta.json", ".jsonl", ".compact_archive.jsonl"] {
        let path = dir.join(session_file_name(session_id, suffix)?);
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|err| format!("remove {} failed: {err}", path.display()))?;
        }
    }
    delete_session_tool_results(dir, session_id);
    Ok(())
}

/// 删除 `tool-results/<sessionId>__*`。
///
/// 大工具结果按 `<sessionId>__<taskId>.txt` 命名（见 `tools::persist_large_output`），
/// 会话删除后这些文件不再有任何引用方，必须一并清掉，否则项目对话目录会持续膨胀。
fn delete_session_tool_results(dir: &std::path::Path, session_id: &str) {
    let tool_results_dir = dir.join("tool-results");
    let Ok(entries) = std::fs::read_dir(&tool_results_dir) else {
        return;
    };
    let prefix = format!("{session_id}__");
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 清空会话内容（保留 meta 与标题）
#[allow(dead_code)]
pub fn clear_conversation(session_id: &str, project: &str) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let dir = config::ensure_project_conversation_dir(project)?;
    let path = dir.join(session_file_name(session_id, ".jsonl")?);
    std::fs::write(&path, "").map_err(|err| format!("write {} failed: {err}", path.display()))?;
    Ok(())
}

/// 递归统计目录内的文件数与总字节数
fn dir_size(path: &std::path::Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                let (child_files, child_bytes) = dir_size(&child);
                files += child_files;
                bytes += child_bytes;
            } else {
                files += 1;
                if let Ok(meta) = std::fs::metadata(&child) {
                    bytes += meta.len();
                }
            }
        }
    }
    (files, bytes)
}

/// 清空一个「对话空间」（`conversations/<dirName>/`）：删除其中的
/// `.jsonl` / `.meta.json` 与 `tool-results/`，保留空间级配置。
///
/// 对齐 `clearConversationSpace`：`dir_name` 是对话空间目录名（宿主把
/// `conversationSpaceCleared.dirName` 就是空间目录名），返回 (文件数, 字节数)。
pub fn clear_conversation_space(dir_name: &str) -> Result<(u64, u64), String> {
    let safe_base = std::path::Path::new(dir_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if dir_name.is_empty() || safe_base != dir_name || dir_name == "." || dir_name == ".." {
        return Err("Invalid conversation space directory name".to_string());
    }
    let dir = config::conversations_root()?.join(dir_name);
    let entries = std::fs::read_dir(&dir)
        .map_err(|err| format!("Conversation space not found: {dir_name} ({err})"))?;

    let mut removed_files = 0u64;
    let mut removed_bytes = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_tool_results = name == "tool-results";
        let is_jsonl = path.is_file() && name.ends_with(".jsonl");
        // workspace.meta.json 也以 .meta.json 结尾，但它是空间级配置（保留，
        // 对齐 conversation_spaces 的计数口径）
        let is_meta =
            path.is_file() && name.ends_with(".meta.json") && name != "workspace.meta.json";
        if !is_tool_results && !is_jsonl && !is_meta {
            continue;
        }
        if is_tool_results {
            let (files, bytes) = dir_size(&path);
            removed_files += files;
            removed_bytes += bytes;
            let _ = std::fs::remove_dir_all(&path);
        } else {
            if let Ok(meta) = std::fs::metadata(&path) {
                removed_bytes += meta.len();
            }
            if std::fs::remove_file(&path).is_ok() {
                removed_files += 1;
            }
        }
    }
    Ok((removed_files, removed_bytes))
}

/// 删除整个对话空间目录（连 `workspace.meta.json` 一起）。
///
/// 项目目录已不存在时空间级配置再无意义，
/// 只有把目录整个删掉，列表才不会再显示它。删除前先统计（回执要带删除量）。
pub fn remove_conversation_space(dir_name: &str) -> Result<(u64, u64), String> {
    let safe_base = std::path::Path::new(dir_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if dir_name.is_empty() || safe_base != dir_name || dir_name == "." || dir_name == ".." {
        return Err("Invalid conversation space directory name".to_string());
    }
    let dir = config::conversations_root()?.join(dir_name);
    if !dir.is_dir() {
        return Err(format!("Conversation space not found: {dir_name}"));
    }
    let (files, bytes) = dir_size(&dir);
    std::fs::remove_dir_all(&dir)
        .map_err(|err| format!("failed to remove conversation space {dir_name}: {err}"))?;
    Ok((files, bytes))
}

// ==================== 消息 ====================

/// 追加一条消息；返回写入的 `uuid`
pub fn append_message(
    session_id: &str,
    project: &str,
    message: &Value,
    parent_uuid: Option<&str>,
) -> Result<String, String> {
    let uuid = message
        .get("uuid")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        // 记录形态：`${sessionId}_${Date.now()}_${random}`（`randomId` 形态）
        .unwrap_or_else(|| crate::util::unique_id(session_id));
    let record = json!({
        "uuid": uuid,
        "parentUuid": parent_uuid,
        "timestamp": crate::util::now_millis(),
        "message": message,
    });
    append_record(session_id, project, &record)?;
    Ok(uuid)
}

/// 追加一条 `tool_use_update` 记录：加载历史时按顺序回放到对应的 `tool_use` block 上。
///
/// 典型用途：Provider 把整个工具入参 double-encode 成字符串，内存里已解包，
/// 但落盘的 assistant 消息仍是字符串；追加一条记录让「恢复历史后」也是对象。
pub fn append_tool_use_update(
    session_id: &str,
    project: &str,
    tool_use_id: &str,
    update: &Value,
) -> Result<(), String> {
    let mut record = serde_json::Map::new();
    record.insert("type".to_string(), json!("tool_use_update"));
    record.insert("toolUseId".to_string(), json!(tool_use_id));
    if let Some(object) = update.as_object() {
        for (key, value) in object {
            record.insert(key.clone(), value.clone());
        }
    }
    record.insert("timestamp".to_string(), json!(crate::util::now_millis()));
    append_record(session_id, project, &Value::Object(record))
}

/// 整文件重写会话消息。
///
/// 压缩 / 清空用：按数组顺序重新分配 `uuid` / `parentUuid` 链，并同步
/// `meta.json` 的 `messageCount`（空数组时额外打 `clearedAt`）。
///
/// 注意：压缩 / 清空属于后台或命令操作，**不**刷新 `updatedAt`
/// （它只反映用户发消息的时间）。
pub fn replace_messages(session_id: &str, project: &str, messages: &[Value]) -> Result<(), String> {
    validate_session_id(session_id)?;
    let dir = config::ensure_project_conversation_dir(project)?;
    let path = dir.join(session_file_name(session_id, ".jsonl")?);

    let mut lines = String::new();
    let mut previous_uuid: Option<String> = None;
    for message in messages {
        let uuid = message
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| crate::util::unique_id(session_id));
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or_else(crate::util::now_millis);
        let record = json!({
            "uuid": uuid,
            "parentUuid": previous_uuid,
            "timestamp": timestamp,
            "message": message,
        });
        lines.push_str(&serde_json::to_string(&record).map_err(|err| err.to_string())?);
        lines.push('\n');
        previous_uuid = Some(uuid);
    }

    {
        let _guard = WRITE_LOCK.lock().unwrap();
        std::fs::write(&path, lines)
            .map_err(|err| format!("write {} failed: {err}", path.display()))?;
    }

    // `meta.json` 的 `messageCount`（缺失时建档；已有则只改计数）
    let cleared_at = if messages.is_empty() {
        Some(crate::util::now_millis())
    } else {
        None
    };
    update_metadata(
        session_id,
        project,
        || {
            json!({
                "sessionId": session_id,
                "project": project,
                "title": "Compressed Conversation",
                "createdAt": crate::util::now_millis(),
                "updatedAt": crate::util::now_millis(),
                "messageCount": messages.len(),
            })
        },
        |metadata| {
            if let Some(object) = metadata.as_object_mut() {
                object.insert("messageCount".to_string(), json!(messages.len()));
                // 整批替换后时间线不再有末位提示：`onceMessage` 一并清掉
                object.remove(ONCE_MESSAGE_KEY);
                if let Some(cleared_at) = cleared_at {
                    object.insert("clearedAt".to_string(), json!(cleared_at));
                }
            }
        },
    )?;

    Ok(())
}

/// 保存压缩归档：被摘要掉的消息 + 新摘要。
///
/// 保留区（最近 N 条）**不**进归档——它们仍在会话文件里，展开时与归档一起重放。
pub fn save_compact_archive(
    session_id: &str,
    project: &str,
    messages: &[Value],
) -> Result<(), String> {
    validate_session_id(session_id)?;
    config::ensure_project_conversation_dir(project)?;
    let path = compact_archive_path(session_id, project)?;

    let mut lines = String::new();
    let mut previous_uuid: Option<String> = None;
    for message in messages {
        let uuid = message
            .get("uuid")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| crate::util::unique_id(session_id));
        let timestamp = message
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or_else(crate::util::now_millis);
        let record = json!({
            "uuid": uuid,
            "parentUuid": previous_uuid,
            "timestamp": timestamp,
            "message": message,
        });
        lines.push_str(&serde_json::to_string(&record).map_err(|err| err.to_string())?);
        lines.push('\n');
        previous_uuid = Some(uuid);
    }

    let _guard = WRITE_LOCK.lock().unwrap();
    std::fs::write(&path, lines).map_err(|err| format!("write {} failed: {err}", path.display()))
}

/// 追加一行 JSONL 到该会话的消息文件
fn append_record(session_id: &str, project: &str, record: &Value) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap();
    let dir = config::ensure_project_conversation_dir(project)?;
    let path = dir.join(session_file_name(session_id, ".jsonl")?);
    let line = serde_json::to_string(record).map_err(|err| err.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("open {} failed: {err}", path.display()))?;
    writeln!(file, "{line}").map_err(|err| format!("append {} failed: {err}", path.display()))
}

/// 读取消息文件，按 `parentUuid` 链还原为 `Message` 列表
pub fn load_messages(session_id: &str, project: &str) -> Vec<Value> {
    let Ok(path) = messages_path(session_id, project) else {
        return Vec::new();
    };
    let Ok(text) = util::read_to_string_lossy(&path) else {
        return Vec::new();
    };
    parse_messages(&text)
}

/// 解析 JSONL 文本并按 `parentUuid` 链重建消息顺序。
///
/// 口径：
/// - 单条损坏行 / 缺 `uuid` 的行只跳过，不影响整体加载；
/// - 重复 `uuid` 后写覆盖先写，但保留首次出现的顺序位置（`Map.set` 语义）；
/// - `tool_use_update` 按文件顺序回放到对应的 tool_use block；
/// - 自引用 `parentUuid` 的合成恢复消息改挂到包含对应 tool_use 的 assistant；
/// - 父节点缺失时退化为根节点，保证子树仍能加载；
/// - 根与兄弟节点按 `timestamp` **稳定**排序后做 BFS（先根后子、同层按时间）。
pub fn parse_messages(text: &str) -> Vec<Value> {
    struct Stored {
        uuid: String,
        parent_uuid: Option<String>,
        timestamp: f64,
        message: Value,
    }

    // 第一遍：解析所有消息；`order` 保留首次出现顺序（HashMap 迭代序不保证）
    let mut order: Vec<Stored> = Vec::new();
    let mut by_uuid: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    // 追加式 tool_use 更新记录，按文件顺序回放
    let mut updates: Vec<(String, Value)> = Vec::new();
    for line in text.lines() {
        // 过滤口径是 **JS** 空白（含 U+FEFF、不含 U+0085），且过滤后仍按**原始行**
        // 解析（行本身不 trim；serde_json 与 JSON.parse
        // 都接受 ASCII 空白，但对 U+FEFF / U+0085 都会拒绝）。
        if util::js_trim(line).is_empty() {
            continue;
        }
        // 宿主写的历史行可能带孤立代理项转义，清洗后再交给严格解析器
        let Ok(value) = serde_json::from_str::<Value>(&util::sanitize_json_surrogates(line)) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("tool_use_update") {
            let tool_use_id = value
                .get("toolUseId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            updates.push((tool_use_id, value));
            continue;
        }
        // 没有字符串 uuid 的记录直接忽略
        let Some(uuid) = value.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        let stored = Stored {
            uuid: uuid.to_string(),
            parent_uuid: value
                .get("parentUuid")
                .and_then(Value::as_str)
                .map(|parent| parent.to_string()),
            timestamp: value
                .get("timestamp")
                .and_then(Value::as_f64)
                // 缺失时按 NaN：JS 排序比较器返回 NaN 时视为相等（稳定排序保留原序），
                // 不能当 0 处理，否则会排到所有正常时间戳前面。
                .unwrap_or(f64::NAN),
            message: value.get("message").cloned().unwrap_or(Value::Null),
        };
        if let Some(index) = by_uuid.get(uuid).copied() {
            // 重复 uuid：后写覆盖先写，位置仍是首次出现的下标
            order[index] = stored;
        } else {
            by_uuid.insert(uuid.to_string(), order.len());
            order.push(stored);
        }
    }

    // 1.5 遍：修复历史数据中自引用 parentUuid 的合成恢复消息
    // （旧版本 bug：tool_recovered_* 落盘时 parentUuid === 自身 uuid，BFS 无法到达）
    let mut assistant_by_tool_use_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for stored in &order {
        if stored.message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = stored
            .message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if let Some(id) = block.get("id").and_then(Value::as_str) {
                assistant_by_tool_use_id.insert(id.to_string(), stored.uuid.clone());
            }
        }
    }
    for stored in order.iter_mut() {
        if stored.parent_uuid.as_deref() != Some(stored.uuid.as_str()) {
            continue;
        }
        let mut repaired: Option<String> = None;
        if stored.message.get("type").and_then(Value::as_str) == Some("user") {
            if let Some(blocks) = stored
                .message
                .get("message")
                .and_then(|inner| inner.get("content"))
                .and_then(Value::as_array)
            {
                for block in blocks {
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    if let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) {
                        if let Some(assistant_uuid) = assistant_by_tool_use_id.get(tool_use_id) {
                            repaired = Some(assistant_uuid.clone());
                            break;
                        }
                    }
                }
            }
        }
        // 找不到对应 assistant 时退化为根节点，避免整条链被孤立
        stored.parent_uuid = repaired;
    }

    // 第二遍：按 parentUuid 建立 children 索引与根节点集合
    let mut children: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    let mut roots: Vec<usize> = Vec::new();
    for (index, stored) in order.iter().enumerate() {
        match &stored.parent_uuid {
            Some(parent) if by_uuid.contains_key(parent) => {
                children.entry(parent.clone()).or_default().push(index);
            }
            _ => roots.push(index),
        }
    }
    let sort_by_timestamp = |a: &usize, b: &usize| {
        order[*a]
            .timestamp
            .partial_cmp(&order[*b].timestamp)
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    roots.sort_by(sort_by_timestamp);

    // 广度优先遍历链（真正的 BFS）：根按时间升序入队，同层兄弟按时间升序入队
    let mut queue: std::collections::VecDeque<usize> = roots.into_iter().collect();
    let mut messages: Vec<Value> = Vec::new();
    while let Some(index) = queue.pop_front() {
        messages.push(order[index].message.clone());
        let uuid = order[index].uuid.clone();
        if let Some(list) = children.get_mut(&uuid) {
            list.sort_by(sort_by_timestamp);
            for child in list.iter() {
                queue.push_back(*child);
            }
        }
    }

    // 回放追加式 tool_use 更新记录（保持文件顺序，后写覆盖先写）
    apply_tool_use_updates(&mut messages, &updates);
    messages
}

/// 把 `tool_use_update` 记录回放到消息上（覆盖 input / meta）
fn apply_tool_use_updates(messages: &mut [Value], updates: &[(String, Value)]) {
    for (tool_use_id, update) in updates {
        for message in messages.iter_mut() {
            let Some(content) = message
                .get_mut("message")
                .and_then(|inner| inner.get_mut("content"))
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            for block in content.iter_mut() {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                if block.get("id").and_then(Value::as_str) != Some(tool_use_id.as_str()) {
                    continue;
                }
                if let Some(input) = update.get("input") {
                    block["input"] = input.clone();
                }
                if let Some(meta) = update.get("meta").and_then(Value::as_object) {
                    // 合并进已有 _meta（Object.assign 语义），不整体替换，
                    // 否则只带一个字段的更新会抹掉 toolCallTimestamp 等其它字段。
                    let mut merged = block
                        .get("_meta")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    for (key, value) in meta {
                        merged.insert(key.clone(), value.clone());
                    }
                    block["_meta"] = Value::Object(merged);
                }
            }
        }
    }
}

/// 确保所有 `tool_use` 都有对应的 `tool_result`。
///
/// 处理进程崩溃等异常：assistant 消息（含 `tool_use`）已落盘，但 tool_result 未生成。
/// 恢复时给缺失的 `tool_use` 补一条「会话中断」的取消结果，否则下一轮 Anthropic
/// 请求会因 `tool_use ids were found without tool_result blocks` 直接 400。
///
/// 只在**内存**里补，不落盘：下次加载会重新生成。
pub fn ensure_tool_results(messages: &mut Vec<Value>) {
    // 收集所有 tool_use，记录所属 assistant 消息的 uuid（恢复消息的 parentUuid）。
    // **同一个 id 只补一条**，重复出现时后写的
    // name / parentUuid 覆盖先写的，但顺序仍按第一次出现的位置（Map 迭代顺序）。
    let mut order: Vec<String> = Vec::new();
    let mut info: std::collections::HashMap<String, (String, Option<String>)> =
        std::collections::HashMap::new();
    for message in messages.iter() {
        if message.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let parent = message
            .get("uuid")
            .and_then(Value::as_str)
            .map(|value| value.to_string());
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let id = block
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !info.contains_key(&id) {
                order.push(id.clone());
            }
            info.insert(id, (name, parent.clone()));
        }
    }

    // 已完成的 tool_use（存在对应的 tool_result）
    let mut completed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for message in messages.iter() {
        if message.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                completed.insert(id.to_string());
            }
        }
    }

    for tool_use_id in order {
        if completed.contains(&tool_use_id) {
            continue;
        }
        let Some((name, parent)) = info.get(&tool_use_id).cloned() else {
            continue;
        };
        let mut message = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": format!(
                        "[Previous session interrupted] Tool \"{name}\" was canceled before execution."
                    ),
                    "is_canceled": true,
                }],
            },
            "uuid": crate::util::unique_id("tool_recovered"),
            "timestamp": crate::util::now_millis(),
        });
        if let Some(parent) = parent {
            message["parentUuid"] = json!(parent);
        }
        messages.push(message);
    }
}

/// 追加消息后刷新 `meta.json` 的 `messageCount`（并在用户主动发消息时刷新 `updatedAt`）。
///
/// `updatedAt` **只**由用户主动发送的消息
/// 刷新（`_userInitiated`），后台自动消息（reminder / 子代理回复等）不把旧会话顶到列表最前。
///
/// 同时按 `updateMetadataForNewMessage` 的 `if (!metadata.context?.promptMode)` 分支
/// 补写会话级提示词预设（`prompt_mode` 缺省时用 `normal`），使「首条消息前已切换预设」
/// 的会话在落盘时保留该选择。
pub fn touch_metadata(
    session_id: &str,
    project: &str,
    user_initiated: bool,
    prompt_mode: Option<&str>,
    creator: &crate::engine::SessionCreator,
) -> Result<(), String> {
    let count = count_messages(&load_messages(session_id, project));
    let prompt_mode = prompt_mode.unwrap_or("normal").to_string();
    update_metadata(
        session_id,
        project,
        // 兜底建档（meta 缺失）一并写 creator（specs/025 FR-002）：归属取会话状态，
        // 由调用方传入——子代理 meta 由创建方预建，兜底只可能命中用户路径
        || json!({ "sessionId": session_id, "project": project, "creator": creator }),
        |metadata| {
            // 新消息落盘即越过末位提示：清掉 `onceMessage`（后继即删，
            // 与 UI 侧 `stripOnce` 同一语义，`docs/hosts/webview-ui.md` 第 11 节）。
            if let Some(object) = metadata.as_object_mut() {
                object.remove(ONCE_MESSAGE_KEY);
            }
            if user_initiated {
                metadata["updatedAt"] = json!(crate::util::now_millis());
            }
            metadata["messageCount"] = json!(count);
            // 只在缺失 / 非法时补写：保留 meta.json 里已有的显式选择
            // （对齐 `if (!metadata.context?.promptMode)` 的 JS 真值判定）
            let existing_valid = metadata
                .get("context")
                .and_then(|context| context.get("promptMode"))
                .and_then(Value::as_str)
                .map(|value| !value.is_empty())
                .unwrap_or(false);
            if !existing_valid {
                if matches!(metadata.get("context"), Some(Value::Object(_))) {
                    if let Some(Value::Object(map)) = metadata.get_mut("context") {
                        map.insert("promptMode".to_string(), json!(prompt_mode));
                    }
                } else if let Some(object) = metadata.as_object_mut() {
                    object.insert(
                        "context".to_string(),
                        json!({ "promptMode": prompt_mode }),
                    );
                }
            }
        },
    )?;
    Ok(())
}

/// 从消息列表里找出第一条用户文本，作为标题（对齐 `titleFromUserMessage` +
/// `buildConversationTitle`：文本优先，前 50 个 UTF-16 code unit；纯图片兜底
/// `Image[<width>*<height>]`，宽高缺失时退化 `Image`）。
pub fn derive_title(messages: &[Value]) -> Option<String> {
    for message in messages {
        if message.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        if message.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(content) = message.get("message").and_then(|inner| inner.get("content")) else {
            continue;
        };
        let (text, image_title) = match content {
            Value::String(text) => (text.clone(), None),
            Value::Array(blocks) => {
                // 对齐 `extractUserContent`：text block 之间用 `\n` 拼接（不是空格）
                let text = blocks
                    .iter()
                    .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n");
                // 对齐 `extractUserContent`：只有可解析出 dataUrl 的 image block 才算
                // （`imageBlockToDataUrl`：type=image + source.type=base64 + data 是字符串）。
                let image_count = blocks.iter().filter(|block| is_user_image_block(block)).count();
                // `buildConversationTitle`：仅图片时优先用消息顶层 `imageSizes` 里
                // 第一张「有 dataUrl 且宽高为真值」的图片生成 `Image[<w>*<h>]`。
                // `imageSizes` 与有效图片按出现顺序一一对应。
                let image_title = if image_count == 0 {
                    None
                } else {
                    image_size_title(message, image_count)
                        .or_else(|| Some("Image".to_string()))
                };
                (text, image_title)
            }
            _ => continue,
        };
        // 对齐 `buildConversationTitle` 的 `(text || '').trim()`（JS 空白口径）
        let text = crate::util::js_trim(&text);
        if !text.is_empty() {
            // 对齐 `substring(0, 50)`（UTF-16 code unit）
            return Some(crate::util::utf16_take(text, 50));
        }
        // 仅图片：`buildConversationTitle` 的兜底标题
        if let Some(title) = image_title {
            return Some(title);
        }
    }
    None
}

/// 可解析出 dataUrl 的用户可见图片 block（`imageBlockToDataUrl` 的等价判定）
fn is_user_image_block(block: &Value) -> bool {
    block.get("type").and_then(Value::as_str) == Some("image")
        && block
            .get("source")
            .and_then(|source| source.get("type"))
            .and_then(Value::as_str)
            == Some("base64")
        && block
            .get("source")
            .and_then(|source| source.get("data"))
            .and_then(Value::as_str)
            .is_some()
}

/// 从消息顶层的 `imageSizes` 取第一张「宽高为真值」的图片尺寸，生成
/// `Image[<width>*<height>]`（对齐 `buildConversationTitle` 的 `Image[...]` 分支）。
///
/// `imageSizes` 与**有效图片**（能解析出 dataUrl 的 image block）按出现顺序一一对应：
/// 第 `i` 张有效图片用 `imageSizes[i]`（缺项视为 `{}`）。因此这里只遍历
/// `0..image_count`，不能直接遍历 `imageSizes`（下标会错位）。
fn image_size_title(message: &Value, image_count: usize) -> Option<String> {
    let sizes = message.get("imageSizes").and_then(Value::as_array);
    for index in 0..image_count {
        let Some(size) = sizes.and_then(|sizes| sizes.get(index)) else {
            continue;
        };
        let width = size.get("width");
        let height = size.get("height");
        if js_truthy(width) && js_truthy(height) {
            return Some(format!(
                "Image[{}*{}]",
                js_template_text(width.unwrap_or(&Value::Null)),
                js_template_text(height.unwrap_or(&Value::Null))
            ));
        }
    }
    None
}

/// JS 真值判定（`0` / `""` / `null` / `undefined` / `NaN` 为假）
pub fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number
            .as_f64()
            .map(|value| value != 0.0 && !value.is_nan())
            .unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// JS 模板字符串插值（`` `${value}` ``）：数字不带多余小数位
fn js_template_text(value: &Value) -> String {
    match value {
        // JS `String(800.0) === '800'`：统一走 ECMAScript 数字格式化口径
        Value::Number(number) => util::js_number_string(number),
        Value::String(text) => text.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// 统计消息数（用于 `meta.json` 的 `messageCount`）。
///
/// 口径：`tool_use_update` 记录只当更新回放、
/// **不**计入 `messages`（因此 `metadata.messageCount = messages.length` 也不含它），
/// 而 `appendMessage` 的 `messageCount += 1` 同样只数真实消息。若把它算进来，
/// 每修一次 double-encode 的 tool 入参就会让 `messageCount` 多 1。
pub fn count_messages(messages: &[Value]) -> usize {
    messages
        .iter()
        .filter(|message| {
            !matches!(
                message.get("type").and_then(Value::as_str),
                Some("stream_event")
                    | Some("stream_request_start")
                    | Some("tombstone")
                    | Some("tool_use_update")
            )
        })
        .count()
}

/// 会话 id → 项目根目录（从 `meta.json` 的 `project` 字段读取）
pub fn project_of_session(session_id: &str) -> Option<String> {
    let file_name = session_file_name(session_id, ".meta.json").ok()?;
    let root = config::conversations_root().ok()?;
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file_name);
        if !candidate.exists() {
            continue;
        }
        let text = util::read_to_string_lossy(&candidate).ok()?;
        let metadata: Value = serde_json::from_str(&util::sanitize_json_surrogates(&text)).ok()?;
        if let Some(project) = metadata.get("project").and_then(Value::as_str) {
            return Some(project.to_string());
        }
    }
    None
}

/// 会话 id → 已登记的模型身份（对齐 `modelRefOf` + `getConversationModelRef`）。
///
/// `modelRefOf` 的口径：`provider` 必须是非空字符串（trim 后），否则整个模型身份
/// 视为未登记（返回 `(None, None)`）；`model` 可以缺省 / 为空串（trim 后）。
/// 返回 `Some("")` 与 `None` 在下游等价（配置解析会把空模型回退到 provider 默认模型），
/// 但「只有 model、没有 provider」的旧 meta.json 必须整体回退，不能拿旧模型配当前 provider。
pub fn model_ref_of_session(session_id: &str, project: &str) -> (Option<String>, Option<String>) {
    let Some(metadata) = load_metadata(session_id, project) else {
        return (None, None);
    };
    let provider = metadata
        .get("provider")
        .and_then(Value::as_str)
        .or_else(|| metadata.get("context").and_then(|c| c.get("provider")).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let Some(provider) = provider else {
        return (None, None);
    };
    let model = metadata
        .get("model")
        .and_then(Value::as_str)
        .or_else(|| metadata.get("context").and_then(|c| c.get("model")).and_then(Value::as_str))
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    (Some(provider), Some(model))
}

/// 会话上下文的部分更新（写回 `meta.json` 顶层扁平字段）
pub fn update_context(
    session_id: &str,
    project: &str,
    changes: &[Value],
) -> Result<(), String> {
    if !metadata_path(session_id, project)?.exists() {
        return Ok(());
    }
    update_metadata(
        session_id,
        project,
        || json!({ "sessionId": session_id, "project": project }),
        |metadata| {
            // 模型身份在 meta.json 顶层保持扁平：先收集，再单独写回，避免同一对象两次可变借用
            let mut flat: Vec<(String, Value)> = Vec::new();
            {
                if let Some(object) = metadata.as_object_mut() {
                    let context = object
                        .entry("context".to_string())
                        .or_insert_with(|| Value::Object(Map::new()));
                    if let Some(context) = context.as_object_mut() {
                        for change in changes {
                            let Some(key) = change.get("key").and_then(Value::as_str) else {
                                continue;
                            };
                            let value = change.get("value").cloned().unwrap_or(Value::Null);
                            context.insert(key.to_string(), value.clone());
                            if key == "model" || key == "provider" {
                                flat.push((key.to_string(), value));
                            }
                        }
                    }
                }
            }
            if let Some(object) = metadata.as_object_mut() {
                for (key, value) in flat {
                    object.insert(key, value);
                }
            }
        },
    )?;
    Ok(())
}

// ==================== 对话空间统计 ====================

/// 对话空间的项目路径：优先读目录里的 `workspace.meta.json`，
/// 读不到时退回目录名的百分号解码。
fn read_workspace_path(dir_path: &std::path::Path, dir_name: &str) -> String {
    if let Ok(content) = util::read_to_string_lossy(&dir_path.join("workspace.meta.json")) {
        if let Ok(settings) = serde_json::from_str::<Value>(&content) {
            if let Some(workspace) = settings.get("workspacePath").and_then(Value::as_str) {
                let trimmed = workspace.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    config::decode_project_dir_name(dir_name).unwrap_or_else(|| dir_name.to_string())
}

/// 对话空间内的会话数（`<sessionId>.meta.json`；空间清单不算会话）
///
/// `workspace.meta.json` 是空间级清单，
/// 不是会话。
fn count_conversations(dir_path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir_path) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.ends_with(".meta.json") && name != "workspace.meta.json"
        })
        .count() as u64
}

/// 统计全部对话空间：
/// 每个空间目录的字节数 / 文件数 / 会话数 + 项目路径，按字节数降序。
pub fn conversation_spaces() -> Vec<Value> {
    let Ok(root) = config::conversations_root() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut spaces: Vec<(u64, Value)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let dir_path = entry.path();
        // 既有 `dir_size` 返回 (文件数, 字节数)，这里按统计契约换序
        let (file_count, size_bytes) = dir_size(&dir_path);
        let project_path = read_workspace_path(&dir_path, &dir_name);
        let conversation_count = count_conversations(&dir_path);
        // 项目目录已不存在（project_path 为空时无从判定，恒 false）：
        // 事实在 core 侧核实
        let workspace_missing =
            !project_path.is_empty() && !std::path::Path::new(&project_path).exists();
        spaces.push((
            size_bytes,
            json!({
                "dirName": dir_name,
                "projectPath": project_path,
                "sizeBytes": size_bytes,
                "fileCount": file_count,
                "conversationCount": conversation_count,
                "workspaceMissing": workspace_missing,
            }),
        ));
    }
    // 按空间大小降序（数值相等时保持目录读取顺序）
    spaces.sort_by(|a, b| b.0.cmp(&a.0));
    spaces.into_iter().map(|(_, value)| value).collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

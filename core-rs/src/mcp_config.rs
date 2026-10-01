//! MCP 服务器配置（对齐 Embedded `src/core/mcp/Config.ts`）。
//!
//! `mcp.json` 与 `settings.json` 同目录（`~/<CONFIG_DIR_NAME>/mcp.json`），声明可用
//! 的 MCP 服务器；**声明里不含 enabled** —— 启用状态统一记录在 `settings.json` 的
//! `mcp.enabled` 列表（全局默认）与会话 `meta.json` 的 `context.mcpEnabled`
//! （会话覆盖）里，未记录的一律视为 disable。
//!
//! ```json
//! {
//!   "mcp": {
//!     "blender-mcp": {
//!       "type": "local",
//!       "command": ["uvx", "blender-mcp"],
//!       "environment": { "BLENDER_HOST": "localhost" }
//!     },
//!     "parallel-search": {
//!       "type": "remote",
//!       "url": "https://search.parallel.ai/mcp",
//!       "headers": { "Authorization": "Bearer <token>" }
//!     }
//!   }
//! }
//! ```
//!
//! `type` 语义：`local` / `stdio`（默认）走子进程 stdio；`remote` / `http` / `sse` 等
//! 走远程传输（先 Streamable HTTP，失败回退旧版 HTTP+SSE）；未写 `type` 但给了 `url`
//! 同样按远程处理。
//!
//! 生效值 = 会话设置过就用它（空数组表示「该会话全部禁用」），否则回退全局默认。
//! 新对话的 `meta.json` 要等第一条消息落盘时才创建，因此菜单勾选先记在内存覆盖
//! （`sessionOverrides`，进程内权威）里，等查询结束后由
//! [`flush_session_mcp_to_meta`] 补写进 `meta.json`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

use crate::config;
use crate::history;
use crate::util;

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// `mcp.json` 路径（与全局 `settings.json` 同目录）
pub fn mcp_config_path() -> Result<PathBuf, String> {
    Ok(config::config_home()?.join("mcp.json"))
}

// ==================== 纯函数（对照表覆盖） ====================

/// 是否为普通对象（排除 null / 数组）——对齐 `isPlainObject`
pub fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 从任意 settings 对象里取出 `mcp.enabled`；字段缺失 / 类型不合法时返回 `None`。
///
/// 对齐 `extractEnabledList`：只有 `Array` 才认，元素里非字符串的被过滤掉
/// （`[]` 是合法结果，代表显式「全部禁用」）。
pub fn extract_enabled_list(settings: &Value) -> Option<Vec<String>> {
    let enabled = settings.get("mcp").and_then(|mcp| mcp.get("enabled"));
    let array = enabled?.as_array()?;
    Some(
        array
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
    )
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 取出服务器映射：优先 `mcp` / `mcpServers` 包裹层，否则把根对象本身当作映射。
///
/// 对齐 `extractServerMap`（返回引用；非对象时返回根对象本身，由调用方再判对象）。
pub fn extract_server_map(root: &Value) -> &Value {
    if root.get("mcp").map(is_plain_object).unwrap_or(false) {
        return root.get("mcp").unwrap();
    }
    if root.get("mcpServers").map(is_plain_object).unwrap_or(false) {
        return root.get("mcpServers").unwrap();
    }
    root
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 把任意 `command` 值规范化为字符串数组（兼容 string / string[]）。
///
/// 对齐 `normalizeCommand`：字符串先 trim，空串得空数组；数组只保留字符串元素
/// （**不** trim 元素）；其它类型得空数组。
pub fn normalize_command(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => {
            let trimmed = util::js_trim(text);
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_string()]
            }
        }
        Value::Array(items) => items
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
        _ => Vec::new(),
    }
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 把任意 `environment` / `headers` 值规范化为 `string -> string` 映射。
///
/// 对齐 `normalizeStringMap`：非对象 / 数组得空映射；`null` / `undefined` 值跳过；
/// 非字符串值走 JS `String(value)` 口径（[`util::js_string`]）。
/// 用 `Vec<(String, String)>` 保留插入顺序（与 JS `Object.entries` 一致）。
pub fn normalize_string_map(value: &Value) -> Vec<(String, String)> {
    let Some(object) = value.as_object() else {
        return Vec::new();
    };
    object
        .iter()
        .filter(|(_, val)| !val.is_null())
        .map(|(key, val)| {
            let text = match val {
                Value::String(text) => text.clone(),
                other => util::js_string(other),
            };
            (key.clone(), text)
        })
        .collect()
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 把任意 `url` 值规范化为去掉首尾空白的字符串（对齐 `normalizeUrl`）。
pub fn normalize_url(value: &Value) -> String {
    match value {
        Value::String(text) => util::js_trim(text).to_string(),
        _ => String::new(),
    }
}

/// 远程传输的 type 取值集合（大小写不敏感）
const REMOTE_TYPES: &[&str] = &[
    "remote",
    "http",
    "https",
    "sse",
    "http-sse",
    "streamable",
    "streamable-http",
    "streamablehttp",
];

/// 该 type 是否表示远程传输（对齐 `isRemoteType`）
pub fn is_remote_type(type_name: &str) -> bool {
    let normalized = util::js_trim(type_name).to_lowercase();
    REMOTE_TYPES.contains(&normalized.as_str())
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 归一化传输类型（对齐 `normalizeType`）。
///
/// 显式写了 type 即为该值（trim 后原样返回）；未写 type 但有 url 且没有 command
/// 时按 `remote`，否则 `local`。
pub fn normalize_type(value: &Value, url: &str, command: &[String]) -> String {
    let raw = match value {
        Value::String(text) => util::js_trim(text).to_string(),
        _ => String::new(),
    };
    if !raw.is_empty() {
        return raw;
    }
    if !url.is_empty() && command.is_empty() {
        return "remote".to_string();
    }
    "local".to_string()
}

/// 判断某个服务器定义是否使用远程传输（对齐 `isRemoteServer`）。
///
/// 兼容 `type: "local"` + `url` 这类书写错误：只要没有 command 且有 url 就走远程。
pub fn is_remote_server(type_name: &str, url: &str, command: &[String]) -> bool {
    if is_remote_type(type_name) {
        return true;
    }
    !url.is_empty() && command.is_empty()
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 模拟 JS 的 `a ?? b ?? c`（只在 `null` / `undefined` 时落空；缺失键等同 undefined）。
fn first_defined(value: &Value, keys: &[&str]) -> Value {
    for key in keys {
        match value.get(*key) {
            Some(Value::Null) | None => continue,
            Some(other) => return other.clone(),
        }
    }
    Value::Null
}

/// `mcp.json` 中的单个服务器定义（不含启用状态，对齐 `Omit<McpServerInfo, 'enabled'>`）。
///
/// 类型定义在 `settings`（它是配置契约的一部分，经快照下发）；这里只补一个
/// 转 UI JSON 的方法。
pub use crate::settings::McpServerDefinition;

impl McpServerDefinition {
    /// 转成 UI 契约里的 JSON（字段顺序与 `McpServerInfo` 声明一致）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("name".to_string(), Value::String(self.name.clone()));
        object.insert("type".to_string(), Value::String(self.r#type.clone()));
        object.insert(
            "command".to_string(),
            Value::Array(self.command.iter().cloned().map(Value::String).collect()),
        );
        object.insert(
            "environment".to_string(),
            string_map_to_json(&self.environment),
        );
        object.insert("url".to_string(), Value::String(self.url.clone()));
        object.insert("headers".to_string(), string_map_to_json(&self.headers));
        Value::Object(object)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn string_map_to_json(map: &[(String, String)]) -> Value {
    let mut object = Map::new();
    for (key, value) in map {
        object.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(object)
}

/// 服务器定义 + 启用状态（对齐 `McpServerInfo`）
#[derive(Clone, Debug, PartialEq)]
pub struct McpServerInfo {
    pub name: String,
    pub r#type: String,
    pub command: Vec<String>,
    pub environment: Vec<(String, String)>,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub enabled: bool,
}

impl McpServerInfo {
    /// 是否使用远程传输（`isRemoteServer`）
    pub fn is_remote(&self) -> bool {
        is_remote_server(&self.r#type, &self.url, &self.command)
    }

    /// 转成 UI 契约里的 JSON（含 `enabled`）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn to_json(&self) -> Value {
        let mut value = McpServerDefinition {
            name: self.name.clone(),
            r#type: self.r#type.clone(),
            command: self.command.clone(),
            environment: self.environment.clone(),
            url: self.url.clone(),
            headers: self.headers.clone(),
        }
        .to_json();
        if let Some(object) = value.as_object_mut() {
            object.insert("enabled".to_string(), Value::Bool(self.enabled));
        }
        value
    }
}

// 过渡期：读取路径已迁到配置快照，本函数/常量只剩测试在用；
// 契约清理时连同调用点一起删除（`docs/core-ui-separation.md` 第 4 节）。
#[allow(dead_code)]
/// 解析 `mcp.json` 的**纯函数**部分（对齐 `readMcpServerDefinitions` 的对象遍历）。
///
/// 非对象根 → 空；每个 value 非对象 → 跳过；按 `Object.entries` 顺序产出定义。
pub fn parse_mcp_server_definitions(raw: &Value) -> Vec<McpServerDefinition> {
    if !is_plain_object(raw) {
        return Vec::new();
    }
    let server_map = extract_server_map(raw);
    let Some(object) = server_map.as_object() else {
        return Vec::new();
    };

    let mut servers = Vec::new();
    for (name, value) in object {
        if !is_plain_object(value) {
            continue;
        }
        let command = normalize_command(value.get("command").unwrap_or(&Value::Null));
        let url = normalize_url(&first_defined(value, &["url", "endpoint", "serverUrl"]));
        servers.push(McpServerDefinition {
            name: name.clone(),
            r#type: normalize_type(value.get("type").unwrap_or(&Value::Null), &url, &command),
            command,
            environment: normalize_string_map(&first_defined(value, &["environment", "env"])),
            url,
            headers: normalize_string_map(value.get("headers").unwrap_or(&Value::Null)),
        });
    }
    servers
}

/// 按给定的启用名列表给服务器定义打上 `enabled` 标记（对齐 `withEnabled`）
pub fn with_enabled(
    servers: &[McpServerDefinition],
    enabled_names: &[String],
) -> Vec<McpServerInfo> {
    servers
        .iter()
        .map(|server| McpServerInfo {
            name: server.name.clone(),
            r#type: server.r#type.clone(),
            command: server.command.clone(),
            environment: server.environment.clone(),
            url: server.url.clone(),
            headers: server.headers.clone(),
            enabled: enabled_names.iter().any(|name| name == &server.name),
        })
        .collect()
}

// ==================== 会话级覆盖 ====================

/// 进程内的会话级覆盖（权威值）。
///
/// 新对话的 `meta.json` 尚未创建时，勾选结果先记在这里（对齐 `sessionOverrides`）。
static SESSION_OVERRIDES: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

fn overrides() -> std::sync::MutexGuard<'static, Option<HashMap<String, Vec<String>>>> {
    SESSION_OVERRIDES.lock().unwrap()
}

/// 读取会话覆盖的启用列表。
///
/// 返回 `None` 表示该会话**没有**设置过（应回退全局默认）；返回空数组表示显式设置为
/// 「该会话全部禁用」。对齐 `readSessionEnabledMcps`：命中内存缓存直接返回；
/// 无工作目录（`hasProjectRoot` 为假）视为未设置过。
pub fn read_session_enabled_mcps(session_id: Option<&str>) -> Option<Vec<String>> {
    let session_id = session_id.filter(|id| !id.is_empty())?;

    if let Some(cached) = overrides().as_ref().and_then(|map| map.get(session_id)) {
        return Some(cached.clone());
    }

    // 宿主未打开工作目录时没有项目目录，视为「未设置过」
    let project = config::project_root(session_id).ok()?;
    let metadata = history::load_metadata(session_id, &project)?;
    let enabled = metadata
        .get("context")
        .and_then(|context| context.get("mcpEnabled"))?;
    let array = enabled.as_array()?;
    let list: Vec<String> = array
        .iter()
        .filter_map(|item| item.as_str().map(|text| text.to_string()))
        .collect();

    let mut guard = overrides();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), list.clone());
    Some(list)
}

/// 全局默认启用列表（`settings.json` 的 `mcp.enabled`，经配置快照下发）。
/// 快照未到达时返回空数组。
pub fn read_default_enabled_mcps() -> Vec<String> {
    crate::settings::settings_snapshot()
        .map(|snapshot| snapshot.mcp.enabled)
        .unwrap_or_default()
}

/// 生效的启用列表：会话覆盖优先，其次全局默认（对齐 `readEnabledMcps`）。
pub fn read_enabled_mcps(session_id: Option<&str>) -> Vec<String> {
    if let Some(session) = read_session_enabled_mcps(session_id) {
        return session;
    }
    read_default_enabled_mcps()
}

/// 把某个 MCP 的启用状态写入**当前会话**（输入框菜单用）。
///
/// 同时更新内存覆盖并尽力写入 `meta.json`；`meta.json` 还不存在时写入静默跳过，
/// 等查询结束后由 [`flush_session_mcp_to_meta`] 补写。
#[cfg_attr(not(test), allow(dead_code))]
pub fn set_session_mcp_enabled(session_id: Option<&str>, name: &str, enabled: bool) {
    let Some(session_id) = session_id.filter(|id| !id.is_empty()) else {
        return;
    };
    if name.is_empty() {
        return;
    }

    let current = read_session_enabled_mcps(Some(session_id)).unwrap_or_else(read_default_enabled_mcps);
    // Set 语义：去重且保留首次出现顺序（对齐 `Array.from(new Set(...))`）
    let mut next: Vec<String> = Vec::new();
    for item in current {
        if !next.iter().any(|existing| existing == &item) {
            next.push(item);
        }
    }
    if enabled {
        if !next.iter().any(|existing| existing == name) {
            next.push(name.to_string());
        }
    } else {
        next.retain(|existing| existing != name);
    }

    overrides()
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), next.clone());
    persist_session_mcp(session_id, &next);
}

/// 整表覆盖某个会话的启用列表（`UiEvent.sessionConfigChanged(mcpEnabled)` 用）。
///
/// 与 [`set_session_mcp_enabled`] 的单开关语义不同：这里拿到的是**完整列表**，
/// 直接覆盖（去重、保留首次出现顺序），不做增量。
pub fn write_session_enabled(session_id: &str, names: &[String]) {
    if session_id.is_empty() {
        return;
    }
    let mut next: Vec<String> = Vec::new();
    for item in names {
        if item.is_empty() || next.iter().any(|existing| existing == item) {
            continue;
        }
        next.push(item.clone());
    }
    overrides()
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), next.clone());
    persist_session_mcp(session_id, &next);
}

/// 把内存中的会话级 MCP 选择补写进 `meta.json`。
/// 查询结束时调用 —— 此时第一条消息已落盘，`meta.json` 一定存在。
pub fn flush_session_mcp_to_meta(session_id: &str) {
    let pending = overrides()
        .as_ref()
        .and_then(|map| map.get(session_id).cloned());
    let Some(pending) = pending else {
        return;
    };
    persist_session_mcp(session_id, &pending);
}

/// 会话被删除时清理内存覆盖，避免泄漏（对齐 `clearSessionMcpOverride`）
pub fn clear_session_mcp_override(session_id: &str) {
    if let Some(map) = overrides().as_mut() {
        map.remove(session_id);
    }
}

/// 仅测试用：清空进程内的会话覆盖缓存
#[cfg(test)]
pub fn reset_session_overrides() {
    *overrides() = None;
}

fn persist_session_mcp(session_id: &str, enabled: &[String]) {
    // `updateConversationContext` 内部用 `getProjectRoot(sessionId)`，拿不到就抛错；
    // `persistSessionMcp` 把该异常吞掉并记一条 info 日志。
    let Ok(project) = config::project_root(session_id) else {
        eprintln!("[core] mcp: 会话 {session_id} 的 MCP 设置暂未写入 meta.json: 无工作目录");
        return;
    };
    let changes = vec![serde_json::json!({
        "key": "mcpEnabled",
        "value": enabled,
    })];
    if let Err(err) = history::update_context(session_id, &project, &changes) {
        eprintln!("[core] mcp: 会话 {session_id} 的 MCP 设置暂未写入 meta.json: {err}");
    }
}

// ==================== 读盘 ====================

/// MCP 服务器定义（不含启用状态）。
///
/// 来自配置快照：UI 在连接建立时读一次 `mcp.json`、解析后随 `hostEnvironmentProvided`
/// 下发；Core 不感知文件路径，中途修改不通知（`docs/core-ui-separation.md` 第 4.7 节）。
/// 快照未到达时返回空数组。
pub fn read_mcp_server_definitions() -> Vec<McpServerDefinition> {
    crate::settings::mcp_server_definitions().unwrap_or_default()
}

/// 读取 `mcp.json`，并合并**生效**的启用状态（会话覆盖优先，其次全局默认）。
/// 供输入框菜单与 MCP 管理器使用。
pub fn read_mcp_servers(session_id: Option<&str>) -> Vec<McpServerInfo> {
    with_enabled(
        &read_mcp_server_definitions(),
        &read_enabled_mcps(session_id),
    )
}

/// 读取 `mcp.json`，并合并**全局默认**的启用状态（设置面板「默认配置」用）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_mcp_servers_for_defaults() -> Vec<McpServerInfo> {
    with_enabled(&read_mcp_server_definitions(), &read_default_enabled_mcps())
}

#[cfg(test)]
#[path = "mcp_config_tests.rs"]
mod tests;

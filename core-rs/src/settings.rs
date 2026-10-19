//! 配置快照：Core 消费的配置形态（契约与 TS 侧 `src/core/settingsSnapshot.ts` 一致）。
//!
//! 磁盘上的 `settings.json` 与 `mcp.json` 归 UI 所有（`docs/architecture/core-ui-separation.md` 第 4 节）：UI 读盘后补默认值、规范化，产出一份快照，随
//! `UiEvent.hostEnvironmentProvided` 一次下发。本模块是 Core 侧的**唯一入口**：
//!
//! - 写入只有 [`apply_settings_snapshot`]；
//! - 读取只有 [`settings_snapshot`] 与 [`mcp_server_definitions`]。
//!
//! Core 侧其它模块一律从这里取值，不得出现这两个文件的路径与文件读取。
//! 快照未到达时读取入口报错，与 `extension_path()` 同一口径：接线缺失必须在启动期
//! 暴露，不做静默回落。Core 不提供默认值——默认值与规范化在 UI 侧执行。
//!
//! 字段全部必选：反序列化缺字段即协议错误（`serde` 默认行为）。
//!
//! 消费点（`config` / `mcp_config` / `balance` / `engine`）全部从本模块取值；
//! Core 侧不再有任何 `settings.json` / `mcp.json` 的路径与文件读取。
//!
//! `apply_from_host_environment` 会报告「MCP 默认启用列表是否变化」：配置变更只经
//! 快照到达 Core（`docs/architecture/core-ui-separation.md` 第 4.5 节），没有单独的通知事件，因此这个判断在这里做。

use std::sync::Mutex;

use std::collections::HashMap;

use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// 单个模型的**已解析**限值（内置注册表 + 用户覆盖合并后的结果）
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct ModelLimits {
    /// 上下文窗口（token 数）
    pub context: u64,
    /// 最大输出 token 数
    pub output: u64,
    /// LLM API 协议（`Anthropic` / `Responses` / `OpenAI`）
    #[serde(rename = "apiType")]
    pub api_type: String,
    /// thinking token 预算
    #[serde(rename = "thinkingTokenBudget")]
    pub thinking_token_budget: u64,
    /// 该模型是否多模态（可携带图片）；`false` 时请求出口过滤全部图片
    /// （`specs/012-multimodal-model-filter`）。缺字段即协议错误，与快照
    /// 「字段全部必选」同一口径。
    pub multimodal: bool,
}

/// provider 的规范化配置
#[derive(Clone, Debug, Deserialize)]
pub struct SettingsProvider {
    #[serde(rename = "baseURL")]
    pub base_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
    pub models: Vec<String>,
    #[serde(rename = "defaultModel")]
    pub default_model: String,
    /// 已解析的模型限值，键为模型名
    #[serde(rename = "modelLimits")]
    pub model_limits: HashMap<String, ModelLimits>,
}

impl SettingsProvider {
    /// 取某模型的限值：命中 `model_limits`，否则用 `fallback`
    pub fn limits_for<'a>(&'a self, model: &str, fallback: &'a ModelLimits) -> &'a ModelLimits {
        self.model_limits.get(model).unwrap_or(fallback)
    }
}

/// `llm` 段
#[derive(Clone, Debug, Deserialize)]
pub struct LlmSettings {
    #[serde(rename = "activeProvider")]
    pub active_provider: String,
    #[serde(rename = "webSearch")]
    pub web_search: bool,
    #[serde(rename = "thinkingEffort")]
    pub thinking_effort: String,
    /// 顶层遗留模型名（`llm.model`）；只在没有会话级 provider 覆盖时优先
    #[serde(default)]
    pub model: String,
    /// 配置级输出上限（`llm.maxTokens`）
    #[serde(rename = "maxTokens")]
    pub max_tokens: u64,
    pub providers: HashMap<String, SettingsProvider>,
    /// 模型限值的全局兜底（未配置 provider、或模型未命中任何 `model_limits`）
    #[serde(rename = "modelLimitsFallback")]
    pub model_limits_fallback: ModelLimits,
}

/// `mcp` 段
#[derive(Clone, Debug, Deserialize)]
pub struct McpSettings {
    /// 全局默认启用的 MCP 服务器名列表
    pub enabled: Vec<String>,
}

/// 配置快照
#[derive(Clone, Debug, Deserialize)]
pub struct SettingsSnapshot {
    pub llm: LlmSettings,
    pub mcp: McpSettings,
    #[serde(rename = "defaultAgentMode")]
    pub default_agent_mode: String,
    /// 默认提示词模式。
    ///
    /// 会话级预设的落点在各自 `meta.json`（缺省回落 `normal`，与 TS 侧一致）；
    /// 这个字段供宿主决定新对话的界面默认值，Core 侧暂时没有消费点——保留是为了让
    /// 快照契约两侧字段一致（缺字段在反序列化时就暴露为协议错误）。
    #[allow(dead_code)]
    #[serde(rename = "defaultPromptMode")]
    pub default_prompt_mode: String,
}

/// 一个 MCP 服务器定义（来自 `mcp.json`；不含启用状态与运行时字段）。
///
/// `environment` / `headers` 用有序键值对而不是 `HashMap`：`serde_json` 开了
/// `preserve_order`，对象的迭代顺序就是 `mcp.json` 里的书写顺序，UI 侧的字段顺序
/// 因此保持稳定（与 TS 侧的 `Record<string, string>` 一致）。
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct McpServerDefinition {
    pub name: String,
    /// 传输类型，如 local / stdio / remote / http / sse
    #[serde(rename = "type")]
    pub r#type: String,
    /// 启动命令（统一为数组形式；远程传输时为空数组）
    pub command: Vec<String>,
    /// 环境变量（仅 local 传输）
    #[serde(default, deserialize_with = "deserialize_string_pairs")]
    pub environment: Vec<(String, String)>,
    /// 远程 MCP 端点（仅 remote 传输）
    pub url: String,
    /// 远程请求附带的 HTTP 头（仅 remote 传输）
    #[serde(default, deserialize_with = "deserialize_string_pairs")]
    pub headers: Vec<(String, String)>,
}

/// 把 JSON 对象反序列化为有序的 `(key, value)` 列表。
///
/// 与 TS 的 `normalizeStringMap` 同口径：`null` / 缺失一律跳过，非字符串按
/// `String(v)` 转写（复用 `util::js_string`）。
fn deserialize_string_pairs<'de, D>(deserializer: D) -> Result<Vec<(String, String)>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let Some(object) = value.as_object() else {
        return Ok(Vec::new());
    };
    Ok(object
        .iter()
        .filter(|(_, item)| !item.is_null())
        .map(|(key, item)| {
            let text = match item {
                Value::String(text) => text.clone(),
                other => crate::util::js_string(other),
            };
            (key.clone(), text)
        })
        .collect())
}

static SETTINGS: Mutex<Option<SettingsSnapshot>> = Mutex::new(None);
static MCP_SERVERS: Mutex<Option<Vec<McpServerDefinition>>> = Mutex::new(None);

/// 写入配置快照（唯一写入入口）。
///
/// 由 `hostEnvironmentProvided` 的处理器调用；重复调用视为「重新同步」，
/// 整体替换而不是合并——快照是完整的，没有增量语义。
pub fn apply_settings_snapshot(snapshot: SettingsSnapshot, mcp_servers: Vec<McpServerDefinition>) {
    *SETTINGS.lock().unwrap() = Some(snapshot);
    *MCP_SERVERS.lock().unwrap() = Some(mcp_servers);
}

/// 快照是否已到达（就绪判据的一部分）
pub fn has_settings_snapshot() -> bool {
    SETTINGS.lock().unwrap().is_some()
}

/// 读取配置快照；未到达时报错
pub fn settings_snapshot() -> Result<SettingsSnapshot, String> {
    SETTINGS
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            "settings snapshot is not available (hostEnvironmentProvided has not arrived)".to_string()
        })
}

/// 读取 MCP 服务器定义；未到达时报错
pub fn mcp_server_definitions() -> Result<Vec<McpServerDefinition>, String> {
    MCP_SERVERS
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            "MCP server definitions are not available (hostEnvironmentProvided has not arrived)"
                .to_string()
        })
}

/// 上一次应用快照时的 MCP 默认启用列表。
///
/// 用来判断「这次快照是否改变了默认启用列表」：只有变了才需要让已注册会话重同步连接。
/// 首次（`None`）不算变化——会话还没注册，`sync_all_sessions()` 本来就没活干。
static PREVIOUS_MCP_ENABLED: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// 从 `hostEnvironmentProvided` 的原始事件里取出快照并写入。
///
/// `settings` / `mcpServers` 缺字段即协议错误：返回 `Err`，由调用方暴露
/// （不静默回落，见模块头注释）。
///
/// 返回「MCP 默认启用列表是否发生变化」。
pub fn apply_from_host_environment(event: &Value) -> Result<bool, String> {
    let settings = event
        .get("settings")
        .ok_or_else(|| "hostEnvironmentProvided is missing the settings field".to_string())?;
    let snapshot: SettingsSnapshot = serde_json::from_value(settings.clone())
        .map_err(|err| format!("hostEnvironmentProvided.settings is invalid: {err}"))?;

    let servers = match event.get("mcpServers") {
        Some(value) => serde_json::from_value::<Vec<McpServerDefinition>>(value.clone())
            .map_err(|err| format!("hostEnvironmentProvided.mcpServers is invalid: {err}"))?,
        None => return Err("hostEnvironmentProvided is missing the mcpServers field".to_string()),
    };

    let next_enabled = snapshot.mcp.enabled.clone();
    let changed = {
        let mut previous = PREVIOUS_MCP_ENABLED.lock().unwrap();
        let changed = previous
            .as_ref()
            .is_some_and(|previous| previous != &next_enabled);
        *previous = Some(next_enabled);
        changed
    };

    apply_settings_snapshot(snapshot, servers);
    Ok(changed)
}

/// 清空快照（仅测试与连接重建用）
#[cfg(test)]
pub fn reset_settings_snapshot() {
    *SETTINGS.lock().unwrap() = None;
    *MCP_SERVERS.lock().unwrap() = None;
    *PREVIOUS_MCP_ENABLED.lock().unwrap() = None;
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;

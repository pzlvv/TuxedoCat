//! 配置存储（`src/host/SettingsStore.ts` + `src/core/settingsSnapshot.ts` +
//! `src/core/utils/modelConfig.ts` + `src/core/mcp/parse.ts` 的移植）。
//!
//! 配置归 UI（docs/architecture/core-ui-separation.md 第 4 节）：`settings.json` / `mcp.json` 由
//! 宿主读盘、补默认值、规范化成快照，经 `UiEvent.hostEnvironmentProvided` 下发 Core；
//! Core 侧只消费快照（`core-rs/src/settings.rs`），不持有默认值。
//!
//! 写入纪律（docs/architecture/principles.md规则 9）：跨进程锁 + 读不出拒绝写 + 原子落盘 +
//! 内容未变不落盘（TUI 只写 `highlightLanguages` 一个字段，纪律照旧）。

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

// ==================== 模型注册表（modelConfig.ts 移植） ====================

/// LLM API 协议类型（下放到模型级配置）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiType {
    Anthropic,
    Responses,
    OpenAi,
}

impl ApiType {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiType::Anthropic => "Anthropic",
            ApiType::Responses => "Responses",
            ApiType::OpenAi => "OpenAI",
        }
    }
}

/// 模型未显式配置协议时的默认协议（绝大多数服务商兼容 Chat Completions）。
pub const DEFAULT_API_TYPE: ApiType = ApiType::OpenAi;

/// 把任意输入规范化为合法的 ApiType，非法值回退默认。
pub fn normalize_api_type(value: Option<&str>) -> ApiType {
    match value {
        Some("Anthropic") => ApiType::Anthropic,
        Some("Responses") => ApiType::Responses,
        Some("OpenAI") => ApiType::OpenAi,
        _ => DEFAULT_API_TYPE,
    }
}

/// 未命中注册表时的兜底限值（对齐 `FALLBACK_MODEL_PARAMS`）。
pub const FALLBACK_CONTEXT_WINDOW: f64 = 1024.0 * 1024.0;
pub const FALLBACK_THINKING_BUDGET: f64 = 192.0 * 1024.0;
pub const FALLBACK_MAX_OUTPUT_TOKENS: f64 = 128.0 * 1024.0;

/// 注册表条目（精确匹配 + 子串匹配；对齐 `MODEL_CONFIGS`）。
const MODEL_CONFIGS: [(&str, f64, f64, f64); 3] = [
    // (name, contextWindow, thinking_token_budget, maxOutputTokens)
    ("deepseek-flash", 1024.0 * 1024.0, 192.0 * 1024.0, 384.0 * 1024.0),
    ("deepseek-v4-flash", 1024.0 * 1024.0, 192.0 * 1024.0, 384.0 * 1024.0),
    ("deepseek-v4-pro", 1024.0 * 1024.0, 192.0 * 1024.0, 384.0 * 1024.0),
];

/// 按模型名解析限值（context, thinkingBudget, output, apiType）：
/// 精确匹配 → 子串匹配 → 兜底；用户 context/output 覆盖优先（对齐 `getModelConfig`）。
fn resolve_model_limits(model: &str, overrides: &Map<String, Value>) -> (f64, f64, f64, ApiType) {
    let matched = MODEL_CONFIGS
        .iter()
        .find(|(name, ..)| *name == model)
        .or_else(|| MODEL_CONFIGS.iter().find(|(name, ..)| !model.is_empty() && model.contains(name)));
    let (context, budget, output) = match matched {
        Some((_, context, budget, output)) => (*context, *budget, *output),
        None => (FALLBACK_CONTEXT_WINDOW, FALLBACK_THINKING_BUDGET, FALLBACK_MAX_OUTPUT_TOKENS),
    };
    let override_entry = if model.is_empty() { None } else { overrides.get(model) };
    let override_context = || {
        override_entry
            .and_then(|entry| entry.get("context"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
    };
    let override_output = || {
        override_entry
            .and_then(|entry| entry.get("output"))
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value > 0.0)
    };
    let api_type = override_entry
        .and_then(|entry| entry.get("apiType"))
        .and_then(Value::as_str);
    (override_context().unwrap_or(context), budget, override_output().unwrap_or(output), normalize_api_type(api_type))
}

// ==================== 配置快照（settingsSnapshot.ts 移植） ====================

/// 单个模型的已解析限值：内置注册表与用户覆盖合并后的结果（快照携带结果，
/// Core 不做模型名匹配）。
#[derive(Debug, Clone, PartialEq)]
pub struct ModelLimits {
    pub context: f64,
    pub output: f64,
    pub api_type: ApiType,
    pub thinking_token_budget: f64,
}

/// provider 的规范化配置。
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotProvider {
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub default_model: String,
    pub model_limits: BTreeMap<String, ModelLimits>,
}

/// 配置快照（字段全部必选；磁盘缺字段按默认值补齐，不抛错）。
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsSnapshot {
    pub active_provider: String,
    pub web_search: bool,
    pub thinking_effort: String,
    /// 顶层遗留模型名（`llm.model`）。
    pub model: String,
    pub max_tokens: f64,
    pub enable_usage_stats: bool,
    pub providers: BTreeMap<String, SnapshotProvider>,
    pub model_limits_fallback: ModelLimits,
    pub mcp_enabled: Vec<String>,
    pub default_agent_mode: String,
    pub default_prompt_mode: String,
}

impl SettingsSnapshot {
    /// 活跃 provider 的默认模型身份（provider + defaultModel）；未配置时 None。
    pub fn active_model_ref(&self) -> Option<(String, String)> {
        let provider = self.providers.get(&self.active_provider)?;
        if provider.base_url.is_empty() {
            return None;
        }
        Some((self.active_provider.clone(), provider.default_model.clone()))
    }
}

const DEFAULT_WEB_SEARCH: bool = true;
const DEFAULT_THINKING_EFFORT: &str = "high";
const DEFAULT_AGENT_MODE: &str = "risk";
const DEFAULT_PROMPT_MODE: &str = "normal";
const DEFAULT_ENABLE_USAGE_STATS: bool = true;

fn fallback_limits() -> ModelLimits {
    ModelLimits {
        context: FALLBACK_CONTEXT_WINDOW,
        output: FALLBACK_MAX_OUTPUT_TOKENS,
        api_type: DEFAULT_API_TYPE,
        thinking_token_budget: FALLBACK_THINKING_BUDGET,
    }
}

/// 规范化模型列表：只留非空字符串、trim、去重（保持原顺序）。
fn normalize_models(raw: Option<&Value>) -> Vec<String> {
    let Some(list) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in list {
        if let Some(model) = item.as_str() {
            let model = model.trim();
            if !model.is_empty() && !out.iter().any(|existing| existing == model) {
                out.push(model.to_string());
            }
        }
    }
    out
}

/// 规范化 provider 的 `modelConfigs`（用户覆盖；保留口径与 getModelConfig 一致）。
fn normalize_model_configs(raw: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(entries) = raw.and_then(Value::as_object) else {
        return out;
    };
    for (model, limits) in entries {
        let Some(limits) = limits.as_object() else { continue };
        let mut entry = Map::new();
        if let Some(context) = limits.get("context").and_then(Value::as_f64).filter(|v| v.is_finite()) {
            entry.insert("context".into(), json!(context));
        }
        if let Some(output) = limits.get("output").and_then(Value::as_f64).filter(|v| v.is_finite()) {
            entry.insert("output".into(), json!(output));
        }
        if let Some(api_type) = limits.get("apiType").and_then(Value::as_str) {
            entry.insert("apiType".into(), json!(normalize_api_type(Some(api_type)).as_str()));
        }
        if !entry.is_empty() {
            out.insert(model.clone(), Value::Object(entry));
        }
    }
    out
}

fn resolve_providers(raw: Option<&Value>) -> BTreeMap<String, SnapshotProvider> {
    let mut providers = BTreeMap::new();
    let Some(entries) = raw.and_then(Value::as_object) else {
        return providers;
    };
    for (key, value) in entries {
        let Some(value) = value.as_object() else { continue };
        let base_url = value.get("baseURL").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let models = normalize_models(value.get("models"));
        let model_configs = normalize_model_configs(value.get("modelConfigs"));

        let mut model_limits = BTreeMap::new();
        let mut known: Vec<String> = models.clone();
        for model in model_configs.keys() {
            if !known.iter().any(|existing| existing == model) {
                known.push(model.clone());
            }
        }
        for (name, _, _, _) in MODEL_CONFIGS {
            if !known.iter().any(|existing| existing == name) {
                known.push(name.to_string());
            }
        }
        for model in known {
            let (context, budget, output, api_type) = resolve_model_limits(&model, &model_configs);
            model_limits.insert(model, ModelLimits { context, output, api_type, thinking_token_budget: budget });
        }

        let default_model = value
            .get("defaultModel")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| models.first().cloned().unwrap_or_default());

        providers.insert(
            key.clone(),
            SnapshotProvider {
                base_url,
                api_key: value.get("apiKey").and_then(Value::as_str).unwrap_or("").to_string(),
                models,
                default_model,
                model_limits,
            },
        );
    }
    providers
}

/// 把已 `JSON.parse` 的 `settings.json` 解析为配置快照（纯函数，不做 I/O）。
///
/// 任何字段缺失、类型不对或取值非法都按默认值处理，不抛错（对齐 `resolveSettingsSnapshot`）。
pub fn resolve_settings_snapshot(raw: &Value) -> SettingsSnapshot {
    let root = raw.as_object();
    let llm = root.and_then(|root| root.get("llm")).and_then(Value::as_object);
    let providers = resolve_providers(llm.and_then(|llm| llm.get("providers")));

    let active_raw = llm.and_then(|llm| llm.get("activeProvider")).and_then(Value::as_str).unwrap_or("");
    let active_provider = match providers.get(active_raw) {
        Some(provider) if !provider.base_url.is_empty() => active_raw.to_string(),
        _ => String::new(),
    };

    let thinking_effort = llm
        .and_then(|llm| llm.get("thinking_effort"))
        .and_then(Value::as_str)
        .filter(|mode| matches!(*mode, "off" | "low" | "high" | "max"))
        .unwrap_or(DEFAULT_THINKING_EFFORT);

    let max_tokens = llm
        .and_then(|llm| llm.get("maxTokens"))
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(FALLBACK_MAX_OUTPUT_TOKENS);

    let enable_usage_stats = llm
        .and_then(|llm| llm.get("enableUsageStats"))
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_ENABLE_USAGE_STATS);

    let web_search = llm
        .and_then(|llm| llm.get("webSearch"))
        .and_then(Value::as_bool)
        .unwrap_or(DEFAULT_WEB_SEARCH);

    let model = llm
        .and_then(|llm| llm.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();

    let mcp_enabled = root
        .and_then(|root| root.get("mcp"))
        .and_then(Value::as_object)
        .and_then(|mcp| mcp.get("enabled"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    let default_agent_mode = root
        .and_then(|root| root.get("defaultAgentMode"))
        .and_then(Value::as_str)
        .filter(|mode| *mode == "manual" || *mode == "auto")
        .unwrap_or(DEFAULT_AGENT_MODE);

    let default_prompt_mode = root
        .and_then(|root| root.get("defaultPromptMode"))
        .and_then(Value::as_str)
        .filter(|mode| *mode == "minimal" || *mode == "mixed")
        .unwrap_or(DEFAULT_PROMPT_MODE);

    SettingsSnapshot {
        active_provider,
        web_search,
        thinking_effort: thinking_effort.to_string(),
        model,
        max_tokens,
        enable_usage_stats,
        providers,
        model_limits_fallback: fallback_limits(),
        mcp_enabled,
        default_agent_mode: default_agent_mode.to_string(),
        default_prompt_mode: default_prompt_mode.to_string(),
    }
}

/// 令牌数出线必须是整数：core 按 u64 收（TS 侧 JSON 整数同口径），内部用 f64 做
/// 算术没问题，但 f64 直接序列化会写出 `131072.0`，core 解析整个 settings 时报
/// `invalid type: floating point` 拒收快照（hostEnvironmentProvided 失败 → Core
/// 永不 ready，宿主后续所有 UiEvent 全被拒）。`f64 as u64` 是饱和转换，负数 /
/// NaN 落 0，令牌数取值下不会出现。
fn token_count(value: f64) -> u64 {
    value as u64
}

/// 快照 → `hostEnvironmentProvided.settings` 载荷（字段名与 TS 快照逐项一致）。
pub fn snapshot_to_payload(snapshot: &SettingsSnapshot) -> Value {
    let mut providers = Map::new();
    for (key, provider) in &snapshot.providers {
        let mut limits = Map::new();
        for (model, limits_entry) in &provider.model_limits {
            limits.insert(
                model.clone(),
                json!({
                    "context": token_count(limits_entry.context),
                    "output": token_count(limits_entry.output),
                    "apiType": limits_entry.api_type.as_str(),
                    "thinkingTokenBudget": token_count(limits_entry.thinking_token_budget),
                }),
            );
        }
        providers.insert(
            key.clone(),
            json!({
                "baseURL": provider.base_url,
                "apiKey": provider.api_key,
                "models": provider.models,
                "defaultModel": provider.default_model,
                "modelLimits": Value::Object(limits),
            }),
        );
    }
    json!({
        "llm": {
            "activeProvider": snapshot.active_provider,
            "webSearch": snapshot.web_search,
            "thinkingEffort": snapshot.thinking_effort,
            "model": snapshot.model,
            "maxTokens": token_count(snapshot.max_tokens),
            "enableUsageStats": snapshot.enable_usage_stats,
            "providers": Value::Object(providers),
            "modelLimitsFallback": {
                "context": token_count(snapshot.model_limits_fallback.context),
                "output": token_count(snapshot.model_limits_fallback.output),
                "apiType": snapshot.model_limits_fallback.api_type.as_str(),
                "thinkingTokenBudget": token_count(snapshot.model_limits_fallback.thinking_token_budget),
            },
        },
        "mcp": { "enabled": snapshot.mcp_enabled },
        "defaultAgentMode": snapshot.default_agent_mode,
        "defaultPromptMode": snapshot.default_prompt_mode,
    })
}

/// 校验模型身份是否仍然有效，失效时解析出可用身份（`resolveModelRef` 移植）。
pub fn resolve_model_ref(snapshot: &SettingsSnapshot, provider: &str, model: &str) -> Option<(String, String)> {
    let active = snapshot.active_model_ref();
    if provider.is_empty() {
        return active;
    }
    let Some(entry) = snapshot.providers.get(provider) else {
        return active;
    };
    if entry.base_url.is_empty() {
        return active;
    }
    if entry.models.is_empty() {
        return Some((
            provider.to_string(),
            if model.is_empty() { entry.default_model.clone() } else { model.to_string() },
        ));
    }
    if !model.is_empty() && entry.models.iter().any(|candidate| candidate == model) {
        return Some((provider.to_string(), model.to_string()));
    }
    Some((
        provider.to_string(),
        if !entry.default_model.is_empty() {
            entry.default_model.clone()
        } else {
            entry.models.first().cloned().unwrap_or_default()
        },
    ))
}

// ==================== mcp.json 解析（mcp/parse.ts 移植） ====================

/// 一个 MCP 服务器定义（来自 `mcp.json`；不含启用状态与运行时字段）。
#[derive(Debug, Clone, PartialEq)]
pub struct McpServerDefinition {
    pub name: String,
    pub kind: String,
    pub command: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

fn normalize_string_map(raw: Option<&Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(entries) = raw.and_then(Value::as_object) else {
        return out;
    };
    for (key, value) in entries {
        if value.is_null() {
            continue;
        }
        let text = match value.as_str() {
            Some(text) => text.to_string(),
            None => value.to_string(),
        };
        out.insert(key.clone(), text);
    }
    out
}

/// 解析 `mcp.json` 的根对象为服务器定义列表；解析失败返回空列表，不抛错。
pub fn parse_mcp_server_definitions(raw: Option<&Value>) -> Vec<McpServerDefinition> {
    let Some(root) = raw.and_then(Value::as_object) else {
        return Vec::new();
    };
    let server_map = root
        .get("mcp")
        .and_then(Value::as_object)
        .or_else(|| root.get("mcpServers").and_then(Value::as_object))
        .unwrap_or(root);

    let mut servers = Vec::new();
    for (name, value) in server_map {
        let Some(value) = value.as_object() else { continue };
        let command: Vec<String> = match value.get("command") {
            Some(Value::String(text)) => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    Vec::new()
                } else {
                    vec![trimmed.to_string()]
                }
            }
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
            _ => Vec::new(),
        };
        let url = value
            .get("url")
            .or_else(|| value.get("endpoint"))
            .or_else(|| value.get("serverUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let kind = match value.get("type").and_then(Value::as_str).map(str::trim) {
            Some("") | None => {
                if !url.is_empty() && command.is_empty() {
                    "remote".to_string()
                } else {
                    "local".to_string()
                }
            }
            Some(raw) => raw.to_string(),
        };
        servers.push(McpServerDefinition {
            name: name.clone(),
            kind,
            command,
            environment: normalize_string_map(value.get("environment").or_else(|| value.get("env"))),
            url,
            headers: normalize_string_map(value.get("headers")),
        });
    }
    servers
}

// ==================== 配置存储（SettingsStore 移植） ====================

/// 家目录：`USERPROFILE` → `HOME`（与 `core-rs/src/config.rs` 的 `home_dir()` 同序，
/// 保证宿主与 Core 落在同一配置目录；口径见 `src/config/configDir.ts`）。
pub fn home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return PathBuf::from(profile);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    // 两个变量都缺失时退到系统 API（Windows 上 USERPROFILE 恒存在，这里只是兜底）
    std::env::temp_dir()
}

/// 配置目录名（`src/config/project.json` 的 `configDir`，经 tui-rs/build.rs 构建期
/// 烧入——源码不持有产品字面量，企业版改名只动 project.json）。
pub const CONFIG_DIR_NAME: &str = env!("TC_CONFIG_DIR");

/// 全局配置目录：`<home>/<CONFIG_DIR_NAME>`。
pub fn config_dir() -> PathBuf {
    home_dir().join(CONFIG_DIR_NAME)
}

/// 读盘结果的三态（`SettingsReadResult`）：「不存在」与「读不出来」必须区分——
/// 读不出来绝不能当空配置，否则下一次写入会用 `{}` 覆盖用户全部配置。
enum ReadResult {
    Missing,
    Ok(Value),
    Invalid(String),
}

fn read_json_file(path: &Path) -> ReadResult {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ReadResult::Missing,
        Err(error) => return ReadResult::Invalid(format!("read {} failed: {error}", path.display())),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(_)) => ReadResult::Ok(serde_json::from_str(&text).unwrap_or(Value::Null)),
        Ok(_) => ReadResult::Invalid(format!("{} 的顶层不是对象", path.display())),
        Err(error) => ReadResult::Invalid(format!("{} 解析失败: {error}", path.display())),
    }
}

/// 配置存储：全局 `settings.json` 与 `mcp.json` 的唯一读写点。
pub struct SettingsStore {
    dir: PathBuf,
    raw_settings: Value,
    mcp_servers: Vec<McpServerDefinition>,
    snapshot: Option<SettingsSnapshot>,
}

impl SettingsStore {
    pub fn new() -> Self {
        Self::with_dir(config_dir())
    }

    pub fn with_dir(dir: PathBuf) -> Self {
        Self { dir, raw_settings: Value::Object(Map::new()), mcp_servers: Vec::new(), snapshot: None }
    }

    pub fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    pub fn mcp_config_path(&self) -> PathBuf {
        self.dir.join("mcp.json")
    }

    /// 读盘并产出快照（启动期一次；`mcp.json` 也只在这里读一次）。
    pub fn load(&mut self) -> SettingsSnapshot {
        match read_json_file(&self.settings_path()) {
            ReadResult::Invalid(error) => {
                // 读不出来：按「未配置」继续，磁盘内容不会被覆盖（写入侧再拦一道）
                eprintln!("[settings] {error}；按未配置继续，磁盘内容不会被覆盖");
                if self.snapshot.is_none() {
                    self.raw_settings = Value::Object(Map::new());
                    self.snapshot = Some(resolve_settings_snapshot(&self.raw_settings));
                }
            }
            ReadResult::Missing => {
                self.raw_settings = Value::Object(Map::new());
                self.snapshot = Some(resolve_settings_snapshot(&self.raw_settings));
            }
            ReadResult::Ok(value) => {
                self.raw_settings = value;
                self.snapshot = Some(resolve_settings_snapshot(&self.raw_settings));
            }
        }
        let mcp_raw = read_json_file(&self.mcp_config_path());
        let mcp_value = match mcp_raw {
            ReadResult::Ok(value) => Some(value),
            _ => None,
        };
        self.mcp_servers = parse_mcp_server_definitions(mcp_value.as_ref());
        self.snapshot.clone().expect("load() always produces a snapshot")
    }

    /// 重新读盘并刷新快照（打开菜单前手工编辑过 settings.json 的收敛入口）。
    /// 与 `load` 的差别：只有内容真的变化才返回新快照（None 表示没变）。
    pub fn refresh_from_disk(&mut self) -> Option<SettingsSnapshot> {
        match read_json_file(&self.settings_path()) {
            ReadResult::Invalid(_) => None, // 读不出来保持现有快照
            ReadResult::Missing => {
                let empty = Value::Object(Map::new());
                if self.raw_settings == empty {
                    return None;
                }
                self.raw_settings = empty;
                let snapshot = resolve_settings_snapshot(&self.raw_settings);
                Some(snapshot)
            }
            ReadResult::Ok(value) => {
                if self.loaded() && value == self.raw_settings {
                    return None;
                }
                self.raw_settings = value;
                let snapshot = resolve_settings_snapshot(&self.raw_settings);
                Some(snapshot)
            }
        }
    }

    fn loaded(&self) -> bool {
        self.snapshot.is_some()
    }

    /// 当前快照；未 load 时抛错（接线缺失在启动期暴露，不静默给默认值）。
    pub fn snapshot(&self) -> &SettingsSnapshot {
        self.snapshot.as_ref().expect("SettingsStore.snapshot() called before load()")
    }

    pub fn mcp_servers(&self) -> &[McpServerDefinition] {
        &self.mcp_servers
    }

    /// 原始 settings 对象（模型菜单数据源）。
    pub fn raw_settings(&self) -> &Value {
        &self.raw_settings
    }

    /// 界面语言（`settings.json` 的 `uiLanguage`）；只有 UI 消费，不进快照。
    pub fn ui_language(&self) -> &'static str {
        match self.raw_settings.get("uiLanguage").and_then(Value::as_str) {
            Some("zh") | Some("en") | Some("auto") => match self.raw_settings.get("uiLanguage").and_then(Value::as_str) {
                Some("zh") => "zh",
                Some("en") => "en",
                _ => "auto",
            },
            _ => "auto",
        }
    }

    /// 某模型身份的上下文上限（快照里已解析的限值；未命中用全局兜底）。
    pub fn read_context_limit(&self, provider: Option<&str>, model: Option<&str>) -> f64 {
        let snapshot = self.snapshot();
        let provider_key = provider.filter(|key| snapshot.providers.contains_key(*key));
        let provider_key = provider_key.unwrap_or(&snapshot.active_provider);
        let Some(entry) = snapshot.providers.get(provider_key) else {
            return snapshot.model_limits_fallback.context;
        };
        let model_name = model.filter(|model| !model.is_empty()).map(str::to_string);
        let model_name = model_name.unwrap_or_else(|| entry.default_model.clone());
        entry
            .model_limits
            .get(&model_name)
            .map(|limits| limits.context)
            .unwrap_or(snapshot.model_limits_fallback.context)
    }

    /// 执行对 `settings.json` 的读-改-写，随后重新解析快照。
    ///
    /// 三层保护（docs/architecture/principles.md规则 9）：跨进程锁内整体执行、读不出拒绝写、
    /// 原子落盘 + 内容未变不落盘。TUI 目前只写 `highlightLanguages`。
    pub fn update_settings(
        &mut self,
        mutator: impl FnOnce(&mut Value),
    ) -> Result<SettingsSnapshot, String> {
        fs::create_dir_all(&self.dir).map_err(|error| format!("create config dir failed: {error}"))?;
        let lock_path = self.settings_path().with_extension("json.lock");
        let _lock = FileLock::acquire(&lock_path)?;

        match read_json_file(&self.settings_path()) {
            ReadResult::Invalid(error) => {
                return Err(format!("拒绝覆盖 settings.json：{error}（文件存在但读不出来，按空配置写入会丢失用户配置）"));
            }
            ReadResult::Missing => {}
            ReadResult::Ok(value) => self.raw_settings = value,
        }
        mutator(&mut self.raw_settings);
        let text = format!("{}\n", serde_json::to_string_pretty(&self.raw_settings).map_err(|error| error.to_string())?);
        write_atomic(&self.settings_path(), &text)?;
        let snapshot = resolve_settings_snapshot(&self.raw_settings);
        self.snapshot = Some(snapshot.clone());
        Ok(snapshot)
    }
}

/// 跨进程互斥锁：`O_CREAT | O_EXCL` 抢锁文件，持锁者 pid 写入其中；
/// 残留锁按 pid 存活判断接管（与 `src/core/utils/fileLock.ts` 同一口径的简化实现）。
struct FileLock {
    path: PathBuf,
}

impl FileLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        for _ in 0..50 {
            match fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(mut file) => {
                    let _ = writeln!(file, "{}", std::process::id());
                    return Ok(Self { path: path.to_path_buf() });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // 残留锁（进程已死）直接接管；活着则等 20ms 再试
                    let stale = fs::read_to_string(path)
                        .ok()
                        .and_then(|text| text.trim().parse::<u32>().ok())
                        .map(|pid| !pid_alive(pid))
                        .unwrap_or(false);
                    if stale {
                        let _ = fs::remove_file(path);
                        continue;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(error) => return Err(format!("acquire lock {} failed: {error}", path.display())),
            }
        }
        Err(format!("acquire lock {} timed out", path.display()))
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // tasklist 精确匹配 PID；失败按「活着」处理，宁可等待也不误删活跃锁
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(true)
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// 原子写入：写临时文件后改名（读者不会看到半截文件）。
fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|error| format!("create {} failed: {error}", tmp.display()))?;
        file.write_all(text.as_bytes()).map_err(|error| format!("write {} failed: {error}", tmp.display()))?;
        file.sync_all().ok();
    }
    fs::rename(&tmp, path).map_err(|error| format!("rename {} → {} failed: {error}", tmp.display(), path.display()))
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;

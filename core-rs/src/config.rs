//! 配置：配置目录、`settings.json`、会话工作目录表。
//!
//! 配置目录名由宿主经 `hostEnvironmentProvided` 传入（产品名不进入 Rust 侧）。
//! 读缓存在本模块；写盘后的失效由写入口调用 `reset_settings_cache()`。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::util::sanitize_json_surrogates;

/// 宿主环境（连接建立后由 `hostEnvironmentProvided` 写入一次）
#[derive(Clone, Debug)]
pub struct HostEnvironment {
    pub locale: String,
    pub extension_path: String,
    /// 帧契约字段：日志出口开关由宿主决定，Core 侧只记录
    #[allow(dead_code)]
    pub log_to_console: bool,
    /// 配置目录名（`~/<configDirName>`）
    pub config_dir_name: String,
}

static HOST_ENV: Mutex<Option<HostEnvironment>> = Mutex::new(None);
static ACTIVE_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);
static SESSION_WORKSPACES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
static SETTINGS_CACHE: Mutex<Option<Value>> = Mutex::new(None);

pub fn set_host_environment(env: HostEnvironment) {
    *HOST_ENV.lock().unwrap() = Some(env);
    // 宿主环境决定 settings.json 的位置；重放 / 更换环境后旧缓存必须作废，
    // 否则首次读失败缓存的 Null 会永久生效。
    *SETTINGS_CACHE.lock().unwrap() = None;
}

pub fn host_environment() -> Option<HostEnvironment> {
    HOST_ENV.lock().unwrap().clone()
}

pub fn extension_path() -> Result<String, String> {
    host_environment()
        .map(|env| env.extension_path)
        .ok_or_else(|| "extension path is not provided yet (hostEnvironmentProvided)".to_string())
}

/// 用户主目录（Windows 优先 `USERPROFILE`，其余用 `HOME`）
fn home_dir() -> Result<PathBuf, String> {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return Ok(PathBuf::from(profile));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    Err("cannot resolve the user home directory".to_string())
}

/// 配置目录：`~/<configDirName>`
pub fn config_home() -> Result<PathBuf, String> {
    let env = host_environment()
        .ok_or_else(|| "host environment is not provided yet".to_string())?;
    Ok(home_dir()?.join(env.config_dir_name))
}

/// 对话目录根：`<configHome>/conversations`
pub fn conversations_root() -> Result<PathBuf, String> {
    Ok(config_home()?.join("conversations"))
}

/// `encodeURIComponent` 等价实现：保留 `A-Za-z0-9-_.!~*'()`
fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let ch = *byte as char;
        let keep = ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')');
        if keep {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 项目对话目录：`<conversationsRoot>/<encoded project path>`
///
/// 单级目录名超过 255 字符（Windows NTFS 限制）时改用
/// `sha256 前 16 位 + "_" + 末级路径编码前 32 字符`。
pub fn project_conversation_dir(project_path: &str) -> Result<PathBuf, String> {
    let encoded = encode_uri_component(project_path);
    if encoded.chars().count() <= 255 {
        return Ok(conversations_root()?.join(encoded));
    }
    let mut hasher = Sha256::new();
    hasher.update(project_path.as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let trimmed = project_path.trim_end_matches(['\\', '/']);
    let last = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    let encoded_last: String = encode_uri_component(last).chars().take(32).collect();
    Ok(conversations_root()?.join(format!("{hash}_{encoded_last}")))
}

/// 确保项目对话目录存在，返回其路径
///
/// 目录首次创建（或首次被 ensure）时写一次目录里的 `settings.json`（记录完整
/// workspacePath），并上报 `projectConversationDirReady`（对齐 Embedded
/// `ensureProjectConversationDir` → `notifyProjectConversationDirReady`；差异只在
/// 写盘归属：Standalone 下清单文件归 Core，Embedded 下归宿主）。
pub fn ensure_project_conversation_dir(project_path: &str) -> Result<PathBuf, String> {
    let dir = project_conversation_dir(project_path)?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("mkdir {} failed: {err}", dir.display()))?;
    announce_project_dir_ready(project_path, &dir);
    Ok(dir)
}

/// 确保配置目录存在
///
/// 同时为 `conversations/` 下已存在的旧项目目录补一次「目录已就绪」，
/// 补写其中的 `settings.json`（对齐 Embedded `ensureConfigDirs` →
/// `backfillProjectSettings`）。
pub fn ensure_config_dirs() -> Result<(), String> {
    let root = conversations_root()?;
    std::fs::create_dir_all(&root).map_err(|err| format!("mkdir conversations failed: {err}"))?;
    backfill_project_settings(&root);
    Ok(())
}

/// 「项目对话目录已就绪」上报出口（由 main 在建立总线后注入；测试可不注入）
type ProjectDirReadySink = std::sync::Arc<dyn Fn(String, String) + Send + Sync>;

static PROJECT_DIR_READY_SINK: Mutex<Option<ProjectDirReadySink>> = Mutex::new(None);
static ANNOUNCED_PROJECT_DIRS: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// 注册上报出口；重复注册以最后一次为准并清空「已上报」集合（重启握手时重放）
pub fn set_project_dir_ready_sink(sink: ProjectDirReadySink) {
    *PROJECT_DIR_READY_SINK.lock().unwrap() = Some(sink);
    *ANNOUNCED_PROJECT_DIRS.lock().unwrap() = None;
}

/// 每个目录只处理一次（对齐 Embedded 的 `ensuredProjectDirs` 缓存）：
/// 先写目录里的 `settings.json`（记录完整 workspacePath），再上报「目录已就绪」。
///
/// Standalone 下清单文件由 **Core** 读写（`docs/standalone-core.md` 第 8 节）；
/// Embedded 下写盘在宿主（`UIHost.ensureProjectSettings`），Core 只上报事实。
fn announce_project_dir_ready(project_path: &str, dir: &std::path::Path) {
    let key = dir.to_string_lossy().to_string();
    {
        let mut announced = ANNOUNCED_PROJECT_DIRS.lock().unwrap();
        let set = announced.get_or_insert_with(Default::default);
        if !set.insert(key.clone()) {
            return;
        }
    }
    if let Err(err) = write_project_settings(dir, project_path) {
        eprintln!("[core] write project settings failed: {err}");
    }
    let sink = PROJECT_DIR_READY_SINK.lock().unwrap().clone();
    let Some(sink) = sink else {
        return;
    };
    sink(key, project_path.to_string());
}

/// 百分号解码（对齐 JS `decodeURIComponent`：非法序列返回 None）
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 目录名 → 原始项目路径；仅当目录名是完整的 `encodeURIComponent` 结果时返回
/// （超长路径的哈希目录名无法反解，返回 None）
fn decode_project_dir_name(dir_name: &str) -> Option<String> {
    let decoded = percent_decode(dir_name)?;
    if encode_uri_component(&decoded) == dir_name {
        Some(decoded)
    } else {
        None
    }
}

fn backfill_project_settings(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(workspace) = decode_project_dir_name(&name) else {
            continue;
        };
        let _ = ensure_project_conversation_dir(&workspace);
    }
}

// ==================== 工作目录 ====================

pub fn set_active_workspace(workspace: Option<String>) {
    *ACTIVE_WORKSPACE.lock().unwrap() = workspace.filter(|path| !path.is_empty());
}

pub fn set_session_workspace(session_id: &str, workspace: Option<String>) {
    let mut table = SESSION_WORKSPACES.lock().unwrap();
    let table = table.get_or_insert_with(HashMap::new);
    match workspace.filter(|path| !path.is_empty()) {
        Some(path) => {
            table.insert(session_id.to_string(), path);
        }
        None => {
            table.remove(session_id);
        }
    }
}

/// 仅测试用：清空会话工作目录表（静态表跨用例残留会互相干扰）
#[cfg(test)]
pub fn reset_session_workspaces() {
    *SESSION_WORKSPACES.lock().unwrap() = None;
}

pub fn session_workspace(session_id: &str) -> Option<String> {
    SESSION_WORKSPACES
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|table| table.get(session_id).cloned())
}

/// 活动工作目录；宿主未打开工作目录时为 `None`
/// （对齐 Embedded `hasProjectRoot()` 的语义：`None` = 没有项目对话目录）。
pub fn active_workspace() -> Option<String> {
    ACTIVE_WORKSPACE.lock().unwrap().clone()
}

/// 会话工作目录；未登记时回退到活动工作目录。两者皆无时返回 Err。
pub fn project_root(session_id: &str) -> Result<String, String> {
    if let Some(path) = session_workspace(session_id) {
        return Ok(path);
    }
    ACTIVE_WORKSPACE
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| {
            "Project root is not configured. The active workspace is written by \
             UiEvent.workspaceChanged."
                .to_string()
        })
}

// ==================== settings.json ====================

/// 全局 `settings.json` 路径
pub fn settings_path() -> Result<PathBuf, String> {
    Ok(config_home()?.join("settings.json"))
}

/// 读取全局 `settings.json`（带缓存）；文件缺失或解析失败时返回空对象
pub fn settings_json() -> Value {
    {
        let cache = SETTINGS_CACHE.lock().unwrap();
        if let Some(value) = cache.as_ref() {
            return value.clone();
        }
    }
    let value = settings_json_uncached();
    *SETTINGS_CACHE.lock().unwrap() = Some(value.clone());
    value
}

/// 读取全局 `settings.json`（**绕过缓存**）。
///
/// 宿主会自己写 `settings.json`（例如把 `highlightLanguages` 并进去）且不会每次都发
/// `llmConfigSaved` 清缓存；Embedded 在这些点上用 `readFileSync` 现读现用，
/// 这里保持一致，避免缓存命中导致重复上报。
pub fn settings_json_uncached() -> Value {
    // 缺失 / 解析失败一律返回空对象（对齐 Embedded `readSettingsJson` 的 `{}` 兜底）
    match settings_path() {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&sanitize_json_surrogates(&text)).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        },
        Err(_) => json!({}),
    }
}

/// 清空读缓存（写盘后调用）
pub fn reset_settings_cache() {
    *SETTINGS_CACHE.lock().unwrap() = None;
}

/// 界面语言（`settings.json` 的 `uiLanguage`）：`auto` / `zh` / `en`。
///
/// 读取失败、字段缺失或取值非法时回落到 `auto`（对齐 Embedded `readUiLanguageSync`）。
/// 走**绕过缓存**的读取：Embedded 侧每次 `readFileSync` 现读现用，宿主可能刚刚自己
/// 改过 `settings.json` 而没有清 core 的读缓存。
pub fn read_ui_language() -> String {
    match settings_json_uncached().get("uiLanguage").and_then(Value::as_str) {
        Some("zh") => "zh".to_string(),
        Some("en") => "en".to_string(),
        _ => "auto".to_string(),
    }
}

// ==================== settings.json 写入 ====================

/// `settings.json` 的写操作串行队列（对齐 `src/host/settingsFile.ts` 的 `writeChain`）。
///
/// 所有写操作按调用顺序排队，避免并发「读-改-写」造成文件被截断或字段丢失
/// （Windows 下 `write` 非原子）。
static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 全局 `settings.json` 中记录 Shiki 已用语言的字段名
pub const HIGHLIGHT_LANGUAGES_FIELD: &str = "highlightLanguages";
/// 高亮语言记录上限（对齐 Embedded `HIGHLIGHT_LANGUAGES_MAX`）
const HIGHLIGHT_LANGUAGES_MAX: usize = 60;

/// JSON Merge Patch（RFC 7386）：对象递归合并、`null` 删除该键、其余整体替换。
///
/// 数组与标量不做元素级合并（与「读-改-写」的 mutator 语义一致：整段赋值）。
pub fn merge_json_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch_map) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(serde_json::Map::new());
    }
    let target_map = target.as_object_mut().expect("target is an object");
    for (key, value) in patch_map {
        if value.is_null() {
            target_map.remove(key);
            continue;
        }
        let merge = matches!(target_map.get(key), Some(existing) if existing.is_object())
            && value.is_object();
        if merge {
            let existing = target_map.get_mut(key).expect("checked above");
            merge_json_patch(existing, value);
        } else {
            target_map.insert(key.clone(), value.clone());
        }
    }
}

/// 写入全局 `settings.json`：串行化「读-改-写」+ 合并补丁 + 清读缓存。
///
/// 返回是否真的改动了内容（补丁为空或补丁不产生变化时为 `false`，不写盘）。
/// Standalone 下这是全局配置的**唯一写入点**（`docs/standalone-core.md` 第 8 节）。
pub fn update_settings_json(patch: &Value) -> Result<bool, String> {
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    let path = settings_path()?;
    let before = read_settings_file(&path);
    let mut next = before.clone();
    merge_json_patch(&mut next, patch);
    let before_text = serde_json::to_string_pretty(&before).map_err(|err| err.to_string())?;
    let next_text = serde_json::to_string_pretty(&next).map_err(|err| err.to_string())?;
    if before_text == next_text {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("mkdir {} failed: {err}", parent.display()))?;
    }
    std::fs::write(&path, next_text).map_err(|err| format!("write {} failed: {err}", path.display()))?;
    // 写盘完成：让读缓存失效，下次读取拿到新值
    reset_settings_cache();
    Ok(true)
}

/// 用给定对象**整体替换**全局 `settings.json`（串行化 + 清读缓存）。
///
/// 与 [`update_settings_json`] 的合并补丁语义不同：这里按调用方给的完整对象落盘，
/// 因此**能表达删除**（键不在新对象里就是删除）。供「Core 侧承担整段读-改-写」的
/// 入口使用（LLM 配置保存），补丁语义表达不了「删掉 `uiLanguage`」这类改动。
///
/// 返回是否真的改动了内容（文本完全相同则不写盘）。
pub fn replace_settings_json(cfg: &Value) -> Result<bool, String> {
    let _guard = SETTINGS_WRITE_LOCK.lock().unwrap();
    let path = settings_path()?;
    let before = read_settings_file(&path);
    let before_text = serde_json::to_string_pretty(&before).map_err(|err| err.to_string())?;
    let next_text = serde_json::to_string_pretty(cfg).map_err(|err| err.to_string())?;
    if before_text == next_text {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("mkdir {} failed: {err}", parent.display()))?;
    }
    std::fs::write(&path, next_text)
        .map_err(|err| format!("write {} failed: {err}", path.display()))?;
    reset_settings_cache();
    Ok(true)
}

/// 把 `languages` 并入全局 `settings.json` 的 `highlightLanguages` 字段。
///
/// 对齐 Embedded `highlightLanguagesMutator`：字段内去重、超出上限时丢弃最早记录；
/// 无新增时不写盘。Standalone 下由 Core 自己落盘（宿主不再写 settings.json）。
pub fn merge_highlight_languages(languages: &[String]) -> Result<bool, String> {
    if languages.is_empty() {
        return Ok(false);
    }
    let current = settings_json_uncached();
    let mut list: Vec<String> = current
        .get(HIGHLIGHT_LANGUAGES_FIELD)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut changed = false;
    for language in languages {
        if language.is_empty() || list.iter().any(|item| item == language) {
            continue;
        }
        list.push(language.clone());
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    if list.len() > HIGHLIGHT_LANGUAGES_MAX {
        list.drain(..list.len() - HIGHLIGHT_LANGUAGES_MAX);
    }
    update_settings_json(&json!({ HIGHLIGHT_LANGUAGES_FIELD: list }))
}

/// 读取文件为 JSON 对象（缺失 / 解析失败 / 非对象一律返回空对象）
fn read_settings_file(path: &std::path::Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&sanitize_json_surrogates(&text))
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({})),
        Err(_) => json!({}),
    }
}

/// 写项目对话目录的 `settings.json`（记录该目录对应的 workspacePath）。
///
/// 目录由 Core 创建，清单文件也归 Core 读写（`docs/standalone-core.md` 第 8 节）；
/// 与 Embedded `writeProjectSettings` 一致：`workspacePath` 未变化时不重写（幂等）。
pub fn write_project_settings(project_dir: &std::path::Path, workspace_path: &str) -> Result<(), String> {
    let path = project_dir.join("settings.json");
    let mut settings = read_settings_file(&path);
    if settings.get("workspacePath").and_then(Value::as_str) == Some(workspace_path) {
        return Ok(());
    }
    settings["workspacePath"] = json!(workspace_path);
    std::fs::create_dir_all(project_dir)
        .map_err(|err| format!("mkdir {} failed: {err}", project_dir.display()))?;
    let text = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    std::fs::write(&path, text).map_err(|err| format!("write {} failed: {err}", path.display()))
}

/// 读项目清单里记录的 workspacePath。
///
/// 对齐 Embedded `history/ConversationSpace.readWorkspacePath`：清单里的值优先，
/// 拿不到时由调用方回退到目录名解码（`decode_project_dir_name`）。
/// 目前只有单测直接调用：对话空间列表（`getConversationSpaces`）尚未迁入
/// Standalone，届时经总线接入。
#[cfg_attr(not(test), allow(dead_code))]
pub fn project_settings_workspace_path(project_dir: &std::path::Path) -> Option<String> {
    read_settings_file(&project_dir.join("settings.json"))
        .get("workspacePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// ==================== LLM 配置解析 ====================

/// 一次 LLM 调用所需的连接信息
#[derive(Clone, Debug, Default)]
pub struct ProviderConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
    /// `OpenAI` / `Anthropic` / `Responses`
    pub api_type: String,
    pub max_tokens: u32,
    pub thinking_budget_tokens: u32,
    pub thinking_effort: String,
    /// 上下文窗口（对齐 `getContextWindow`）：注册表条目与兜底同为 1M，
    /// 仅 `llm.providers[].modelConfigs[model].context` 会覆盖。
    pub context_window: u32,
    /// 帧契约字段：Web Search 仅 Responses 协议生效，本阶段未接入
    #[allow(dead_code)]
    pub web_search: bool,
}

/// 输出上限的全局兜底（对齐 `FALLBACK_MODEL_PARAMS.maxOutputTokens` / 注册表，
/// 注册表内所有条目与兜底同值）
const DEFAULT_MAX_TOKENS: u32 = 384 * 1024;
/// 输出上限的绝对上限（对齐 `MAX_OUTPUT_TOKENS_UPPER_LIMIT`）
const MAX_OUTPUT_TOKENS_UPPER_LIMIT: u32 = 384 * 1024;
/// 思考预算兜底（对齐 `FALLBACK_MODEL_PARAMS.thinking_token_budget`）
const DEFAULT_THINKING_BUDGET: u32 = 192 * 1024;
/// 上下文窗口兜底（对齐 `FALLBACK_MODEL_PARAMS.contextWindow`，注册表条目同值）
const DEFAULT_CONTEXT_WINDOW: u32 = 1024 * 1024;
/// 环境变量：最高优先级的输出上限覆盖（`project.json` 的 `envMaxOutputTokens`）
const ENV_MAX_OUTPUT_TOKENS: &str = "TUXEDO_CAT_MAX_OUTPUT_TOKENS";

/// apiKey 未配置时给用户看的文案（逐字对齐 `llm/config.ts` 的 `getConfig` /
/// `getConfigForProvider`：两条路径抛的是同一段文本）。
fn missing_api_key_message() -> String {
    let config_dir = host_environment()
        .map(|env| env.config_dir_name)
        .unwrap_or_else(|| ".tuxedo-cat".to_string());
    format!(
        "API Key 未配置，无法调用 LLM。\n请在「设置 → LLM 配置」中填写 API Key，\n或编辑 ~/{config_dir}/settings.json 中对应 provider 的 apiKey 字段。"
    )
}

/// 解析当前生效的 provider 配置。
///
/// `model_override` / `provider_override` 来自会话（meta.json）；缺省时用
/// `settings.json` 的 `llm.activeProvider` 与该 provider 的默认模型。
///
/// 错误口径对齐 Embedded：
/// - 会话显式指定了 provider 但它不存在 / 没有 baseURL → `provider "X" 不存在或未配置 baseURL`
///   （`getConfigForProvider` 不做回退，必须暴露）；
/// - 其余「没有可用 provider / 没有 apiKey」→ 与 `getConfig` 一致地抛 API Key 未配置文案
///   （Embedded 在 activeProvider 缺失或无效时回退到空 apiKey 的兜底配置，最终都落到这条）。
pub fn resolve_provider(
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<ProviderConfig, String> {
    let settings = settings_json();
    let llm = settings.get("llm").cloned().unwrap_or(Value::Null);
    let providers = llm
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let override_key = provider_override
        .map(|key| key.to_string())
        .filter(|key| !key.is_empty());
    let active_key = override_key.clone().or_else(|| {
        llm.get("activeProvider")
            .and_then(Value::as_str)
            .filter(|key| !key.is_empty())
            .map(|key| key.to_string())
    });
    let Some(active_key) = active_key else {
        return Err(missing_api_key_message());
    };

    let provider = match providers.get(&active_key) {
        Some(provider) => provider,
        None if override_key.is_some() => {
            return Err(format!("provider \"{active_key}\" 不存在或未配置 baseURL"));
        }
        None => return Err(missing_api_key_message()),
    };

    let base_url = provider
        .get("baseURL")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        if override_key.is_some() {
            return Err(format!("provider \"{active_key}\" 不存在或未配置 baseURL"));
        }
        return Err(missing_api_key_message());
    }

    let model = model_override
        .map(|value| crate::util::js_trim(value).to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            // `llm.model`（顶层，遗留字段）优先于 provider 的默认模型，但**只在没有
            // 会话级 provider 覆盖时**生效：对齐 `getDefaultConfig` 的
            // `configFile.llm.model || getProviderDefaultModelFromConfig(...)`；
            // 会话显式指定 provider 时 Embedded 走 `getConfigForProvider`，
            // 那条路径不读 `llm.model`（只按 provider 的默认模型）。
            if override_key.is_some() {
                return None;
            }
            llm.get("model")
                .and_then(Value::as_str)
                .map(|value| crate::util::js_trim(value).to_string())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            provider
                .get("defaultModel")
                .and_then(Value::as_str)
                .map(|value| crate::util::js_trim(value).to_string())
                .filter(|value| !value.is_empty())
        })
        .or_else(|| {
            provider
                .get("models")
                .and_then(Value::as_array)
                .and_then(|models| models.first())
                .and_then(Value::as_str)
                .map(|value| value.to_string())
        })
        .unwrap_or_default();
    // 注意：模型为空**不**在这里报错。Embedded 的 `getConfig` / `getConfigForProvider`
    // 允许 `model` 为空串（settings.json 未配置默认模型时），由服务端返回错误；
    // 这里继续往下走，保证「provider 有 baseURL 但没配模型」时报的是 API Key 文案
    // （`apiKey` 为空时）或把空模型原样带进请求（`apiKey` 已配置时），与 Embedded 一致。

    let api_key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if api_key.is_empty() {
        return Err(missing_api_key_message());
    }

    let model_config = provider
        .get("modelConfigs")
        .and_then(|configs| configs.get(&model))
        .cloned()
        .unwrap_or(Value::Null);

    let api_type = model_config
        .get("apiType")
        .and_then(Value::as_str)
        .unwrap_or("OpenAI")
        .to_string();

    // 输出上限：与 Embedded 的 `getMaxOutputTokens` + Query 的 min 口径一致。
    //   effective = env > modelConfigs[model].output > 注册表/兜底(384K)
    //   最终     = min(llm.maxTokens || 384K, effective)
    let effective_max = std::env::var(ENV_MAX_OUTPUT_TOKENS)
        .ok()
        .and_then(|value| crate::util::js_trim(&value).parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_OUTPUT_TOKENS_UPPER_LIMIT))
        .or_else(|| {
            model_config
                .get("output")
                .and_then(Value::as_u64)
                .map(|value| (value as u32).min(MAX_OUTPUT_TOKENS_UPPER_LIMIT))
        })
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let configured_max = llm
        .get("maxTokens")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let max_tokens = configured_max.min(effective_max);

    // 上下文窗口：注册表 / 兜底恒为 1M，只有 provider 的 modelConfigs[model].context
    // 会覆盖（对齐 `getModelConfig` 的 override 分支）。
    let context_window = model_config
        .get("context")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_CONTEXT_WINDOW);

    Ok(ProviderConfig {
        api_key,
        base_url,
        model,
        api_type,
        max_tokens,
        // 对齐 `RealApi` / `OpenAiApi`：请求体的 `thinking_token_budget` 恒取模型注册表的
        // 192K（`thinkingTokenBudget` 选项从未被 Query 传入），`settings.json` 里的
        // `llm.thinking_budget_tokens` 只进日志，不影响请求。
        thinking_budget_tokens: DEFAULT_THINKING_BUDGET,
        thinking_effort: llm
            .get("thinking_effort")
            .and_then(Value::as_str)
            .unwrap_or("high")
            .to_string(),
        context_window,
        web_search: llm.get("webSearch").and_then(Value::as_bool).unwrap_or(true),
    })
}

/// `settings.json` 的默认思考强度（`llm.thinking_effort`，缺省 `high`）
pub fn default_thinking_effort() -> String {
    settings_json()
        .get("llm")
        .and_then(|llm| llm.get("thinking_effort"))
        .and_then(Value::as_str)
        .unwrap_or("high")
        .to_string()
}

/// `settings.json` 的默认 Web Search 开关（`llm.webSearch`，缺省 true）
pub fn default_web_search() -> bool {
    settings_json()
        .get("llm")
        .and_then(|llm| llm.get("webSearch"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// 新对话的默认 agent mode（`settings.json` 顶层 `defaultAgentMode`）。
///
/// 非法值一律回退到 `risk`（对齐 `getDefaultAgentMode` 的白名单校验）。
pub fn default_agent_mode() -> String {
    match settings_json()
        .get("defaultAgentMode")
        .and_then(Value::as_str)
    {
        Some("auto") => "auto".to_string(),
        Some("manual") => "manual".to_string(),
        _ => "risk".to_string(),
    }
}

/// 新对话的默认模型（`settings.json` 顶层 `defaultModel`）。
///
/// Embedded 的 `HarnessConfig.defaultModel` 已无消费方（模型完全走
/// `llm.providers[].defaultModel` / 会话级 `modelRefOverride`），因此这里也**不**参与
/// 新会话 meta.json 的创建（对齐 `updateMetadataForNewMessage`）。保留读取器供设置面板 /
/// 旧数据使用。
#[allow(dead_code)]
pub fn default_model() -> Option<String> {
    settings_json()
        .get("defaultModel")
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty())
}

/// 解析某个文件路径所属的项目根（用于把会话工作目录表落盘前归一化）
pub fn normalize_workspace(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    if trimmed.is_empty() {
        path.to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

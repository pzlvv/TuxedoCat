//! 配置：配置目录、宿主环境、会话工作目录表。
//!
//! 配置目录名由宿主经 `hostEnvironmentProvided` 传入（产品名不进入 Rust 侧）。
//!
//! **全局 `settings.json` 不在这里**：它归宿主所有，Core 侧没有任何读入口或写入口，
//! 只消费经 `hostEnvironmentProvided` 下发的配置快照（`crate::settings`）。
//! 本模块保留的是「Core 数据目录内的项目清单」（`<projectDir>/settings.json`，
//! 记录该目录对应的 workspacePath），它归 Core 读写。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::settings;
use sha2::{Digest, Sha256};

use crate::util::sanitize_json_surrogates;

/// 宿主环境（连接建立后由 `hostEnvironmentProvided` 写入一次）
#[derive(Clone, Debug)]
pub struct HostEnvironment {
    pub extension_path: String,
    /// 帧契约字段：日志出口开关由宿主决定，Core 侧只记录
    #[allow(dead_code)]
    pub log_to_console: bool,
    /// 配置目录名（`~/<configDirName>`）
    pub config_dir_name: String,
    /// 宿主是否支持跨工作区代理（specs/023 FR-009）：Electron true，VS Code / TUI false。
    pub cross_workspace_agent: bool,
    /// 宿主是否支持跨工作区文件传输（specs/028 FR-005）：Electron true，
    /// VS Code / TUI false。只作用于 `Transfer` 工具的执行；工具定义与提示词恒定注入。
    pub cross_workspace_transfer: bool,
}

static HOST_ENV: Mutex<Option<HostEnvironment>> = Mutex::new(None);
static ACTIVE_WORKSPACE: Mutex<Option<String>> = Mutex::new(None);
static SESSION_WORKSPACES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn set_host_environment(env: HostEnvironment) {
    *HOST_ENV.lock().unwrap() = Some(env);
}

pub fn host_environment() -> Option<HostEnvironment> {
    HOST_ENV.lock().unwrap().clone()
}

/// 宿主是否支持跨工作区代理（specs/023 FR-009）；快照未到达时按不支持处理。
pub fn cross_workspace_agent() -> bool {
    HOST_ENV
        .lock()
        .unwrap()
        .as_ref()
        .map(|env| env.cross_workspace_agent)
        .unwrap_or(false)
}

/// 宿主是否支持跨工作区文件传输（specs/028 FR-005）；快照未到达时按不支持处理。
pub fn cross_workspace_transfer() -> bool {
    HOST_ENV
        .lock()
        .unwrap()
        .as_ref()
        .map(|env| env.cross_workspace_transfer)
        .unwrap_or(false)
}

pub fn extension_path() -> Result<String, String> {
    host_environment()
        .map(|env| env.extension_path)
        .ok_or_else(|| "extension path is not provided yet (hostEnvironmentProvided)".to_string())
}

/// 配置目录名的兜底值：宿主还没下发 `hostEnvironmentProvided` 时用。
///
/// 来源是 `src/config/project.json` 的 `configDir`（build.rs 构建期烧入，源码不持有
/// 产品字面量；与 TS 侧 `CONFIG_DIR_NAME` 同一配置来源，企业版改名只动 project.json）。
pub const DEFAULT_CONFIG_DIR_NAME: &str = env!("TC_CONFIG_DIR");

/// 用户主目录（Windows 优先 `USERPROFILE`，其余用 `HOME`）
///
/// 跨工具共享目录（如 `.agents/skills`）挂在主目录下，所以这个口径是 pub 的：
/// 调用方拿主目录、再拼自己的子路径，不各自读 `USERPROFILE` / `HOME`。
pub fn home_dir() -> Result<PathBuf, String> {
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
///
/// Windows 下同一目录的分隔符两种写法（`D:\a\b` 与 `D:/a/b`）会各自编码成不同的
/// 对话空间目录；归一成反斜杠后再编码，且按历史写法编码的目录已存在时沿用
/// （两种写法解析到同一份对话数据，不再裂成两个空间）。
#[cfg(windows)]
fn normalize_workspace_path(project_path: &str) -> String {
    project_path.replace('/', "\\")
}

#[cfg(not(windows))]
fn normalize_workspace_path(project_path: &str) -> String {
    project_path.to_string()
}

pub fn project_conversation_dir(project_path: &str) -> Result<PathBuf, String> {
    let normalized = normalize_workspace_path(project_path);
    let root = conversations_root()?;
    let mut candidates = vec![normalized.clone()];
    if project_path != normalized {
        candidates.push(project_path.to_string());
    }
    for candidate in &candidates {
        let encoded = encode_uri_component(candidate);
        if encoded.chars().count() <= 255 {
            let dir = root.join(&encoded);
            if dir.is_dir() {
                return Ok(dir);
            }
        }
    }
    let encoded = encode_uri_component(&normalized);
    if encoded.chars().count() <= 255 {
        return Ok(root.join(encoded));
    }
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    let trimmed = normalized.trim_end_matches(['\\', '/']);
    let last = trimmed.rsplit(['\\', '/']).next().unwrap_or("");
    let encoded_last: String = encode_uri_component(last).chars().take(32).collect();
    Ok(root.join(format!("{hash}_{encoded_last}")))
}

/// 确保项目对话目录存在，返回其路径
///
/// 目录首次创建（或首次被 ensure）时写一次目录里的 `workspace.meta.json`（记录完整
/// workspacePath）。目录与清单都由 Core
/// 创建与写入，宿主不参与写盘。
pub fn ensure_project_conversation_dir(project_path: &str) -> Result<PathBuf, String> {
    let dir = project_conversation_dir(project_path)?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("mkdir {} failed: {err}", dir.display()))?;
    write_project_meta_once(project_path, &dir);
    Ok(dir)
}

/// 确保配置目录存在
///
/// 同时为 `conversations/` 下已存在的项目目录补写一次项目清单
pub fn ensure_config_dirs() -> Result<(), String> {
    let root = conversations_root()?;
    std::fs::create_dir_all(&root).map_err(|err| format!("mkdir conversations failed: {err}"))?;
    backfill_project_settings(&root);
    Ok(())
}

static ANNOUNCED_PROJECT_DIRS: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// 每个目录只处理一次：写目录里的
/// `workspace.meta.json`（记录完整 workspacePath）。
fn write_project_meta_once(project_path: &str, dir: &std::path::Path) {
    let key = dir.to_string_lossy().to_string();
    {
        let mut announced = ANNOUNCED_PROJECT_DIRS.lock().unwrap();
        let set = announced.get_or_insert_with(Default::default);
        if !set.insert(key) {
            return;
        }
    }
    if let Err(err) = write_workspace_meta(dir, project_path) {
        eprintln!("[core] write workspace meta failed: {err}");
    }
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
pub(crate) fn decode_project_dir_name(dir_name: &str) -> Option<String> {
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
/// （`None` = 没有项目对话目录）。
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

/// 写项目对话目录的 `workspace.meta.json`（记录该目录对应的 workspacePath）。
///
/// 目录与清单都由 Core 创建与写入（`docs/architecture/core-ui-separation.md` 第 4.1 节）；
/// `workspacePath` 未变化时不重写（幂等）。
pub fn write_workspace_meta(project_dir: &std::path::Path, workspace_path: &str) -> Result<(), String> {
    let path = project_dir.join("workspace.meta.json");
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
/// 清单里的值优先，
/// 拿不到时由调用方回退到目录名解码（`decode_project_dir_name`）。
/// 目前只有单测直接调用：对话空间列表（`getConversationSpaces`）尚未迁入
/// Standalone，届时经总线接入。
#[cfg_attr(not(test), allow(dead_code))]
pub fn workspace_meta_workspace_path(project_dir: &std::path::Path) -> Option<String> {
    read_settings_file(&project_dir.join("workspace.meta.json"))
        .get("workspacePath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

// ==================== md 修改记录（specs/030 FR-004） ====================

/// 记录写盘的进程内串行锁（并行工具线程同时改多个 md 时串行合并写盘）
static MD_RECORD_LOCK: Mutex<()> = Mutex::new(());

/// 「工作区是否 git 仓」的进程级缓存（失败结果同样入表，写法照 prompt.rs 的 GIT_CACHE）
static GIT_WORKSPACE_CACHE: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

/// 工作区根是否位于 git 仓内（含祖先目录）。探测失败的口径是「非 git」：
/// 连 git 都找不到的机器上没有可用的 git 口径，记录语义按非 git 走。
fn workspace_is_git(root: &str) -> bool {
    {
        let cache = GIT_WORKSPACE_CACHE.lock().unwrap();
        if let Some(hit) = cache.as_ref().and_then(|table| table.get(root)) {
            return *hit;
        }
    }
    let mut command = std::process::Command::new("git");
    command
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(root);
    crate::util::hide_console(&mut command);
    let inside = crate::shell_env::apply_native(&mut command)
        .ok()
        .and_then(|()| command.output().ok())
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "true")
        .unwrap_or(false);
    GIT_WORKSPACE_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(root.to_string(), inside);
    inside
}

/// 绝对路径 → 工作区根相对的 posix 路径；非 md 文档或不在根内时返回 None。
/// 两侧 canonicalize 后再比较（`D:/a` 与 `D:\a` 两种写法解析到同一条记录）。
fn workspace_relative_doc(root: &str, abs_path: &std::path::Path) -> Option<String> {
    let name = abs_path.file_name()?.to_string_lossy().to_lowercase();
    if !(name.ends_with(".md") || name.ends_with(".markdown")) {
        return None;
    }
    let root_canon = std::fs::canonicalize(root).ok()?;
    let path_canon = std::fs::canonicalize(abs_path).ok()?;
    let rel = path_canon.strip_prefix(&root_canon).ok()?;
    let mut out = String::new();
    for component in rel.components() {
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&component.as_os_str().to_string_lossy());
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 工具成功修改工作区内 md 文档后登记进项目对话目录的 `workspace.meta.json`
/// （specs/030 FR-004，仅非 git 工作区；宿主侧只读，格式见 `src/shared/workspaceMeta.ts`）。
///
/// 前置条件任一不满足（非 md / 根外 / git 仓）直接返回——「不记录」是口径本身，不是
/// 错误。写盘遵循共享文件写安全：进程内串行 + 锁文件跨进程互斥 + 持锁重读合并（集合
/// 并集语义）+ 临时文件 rename 原子替换 + 无新增条目不落盘；读得出但解析失败时拒绝
/// 写入（不覆盖原文件）。
pub fn record_md_modification(root: &str, abs_path: &std::path::Path) {
    let Some(rel) = workspace_relative_doc(root, abs_path) else {
        return;
    };
    if workspace_is_git(root) {
        return;
    }
    let _guard = MD_RECORD_LOCK.lock().unwrap();
    let project_dir = match ensure_project_conversation_dir(root) {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("[core] record md modification: ensure project dir failed: {err}");
            return;
        }
    };
    if let Err(err) = append_modified_doc(&project_dir, &rel) {
        eprintln!("[core] record md modification failed: {err}");
    }
}

/// 读取 `workspace.meta.json` 为 JSON 对象；文件缺失返回空对象，读得出但解析失败 /
/// 非对象返回 Err（记录写入侧据此拒绝覆盖——「读不出拒绝写」）。
fn read_settings_file_strict(path: &std::path::Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&sanitize_json_surrogates(&text))
            .ok()
            .filter(Value::is_object)
            .ok_or_else(|| format!("{} is not a valid JSON object", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("read {}: {err}", path.display())),
    }
}

/// 持锁守卫：Drop 时先关句柄再摘锁文件——任何路径（含错误返回）都不留陈旧锁
struct MetaLockGuard {
    file: Option<std::fs::File>,
    path: PathBuf,
}

impl Drop for MetaLockGuard {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 锁文件独占创建（跨进程互斥）。约 1 秒拿不到时：锁龄超过 30 秒视为持锁方崩溃的
/// 陈旧锁，摘除后重试一轮；仍拿不到返回 None（放弃本次登记——集合并集语义下不破坏
/// 口径，该文件的下一次修改会重新合并写入）。
fn acquire_meta_lock(project_dir: &std::path::Path) -> Result<Option<MetaLockGuard>, String> {
    let lock_path = project_dir.join("workspace.meta.json.lock");
    for attempt in 0..2 {
        for _ in 0..50 {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(file) => {
                    return Ok(Some(MetaLockGuard { file: Some(file), path: lock_path }));
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(err) => return Err(format!("open {}: {err}", lock_path.display())),
            }
        }
        if attempt == 0 {
            let stale = std::fs::metadata(&lock_path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| at.elapsed().ok())
                .map(|age| age.as_secs() > 30)
                .unwrap_or(true);
            if !stale {
                break;
            }
            let _ = std::fs::remove_file(&lock_path);
        }
    }
    eprintln!("[core] record md modification: meta lock busy, skip");
    Ok(None)
}

/// 持锁读-合并-原子写：把一条相对路径并进 `modifiedDocs`（数组、去重、字典序稳定输出）。
fn append_modified_doc(project_dir: &std::path::Path, rel: &str) -> Result<(), String> {
    let Some(_lock) = acquire_meta_lock(project_dir)? else {
        return Ok(());
    };
    let path = project_dir.join("workspace.meta.json");
    let mut settings = read_settings_file_strict(&path)?;
    let existing_docs = match settings.get("modifiedDocs") {
        None => Vec::new(),
        Some(Value::Array(items)) => {
            let mut docs = Vec::with_capacity(items.len());
            for item in items {
                let doc = item
                    .as_str()
                    .ok_or_else(|| format!("modifiedDocs in {} is corrupt", path.display()))?;
                docs.push(doc.to_string());
            }
            docs
        }
        Some(_) => return Err(format!("modifiedDocs in {} is corrupt", path.display())),
    };
    if existing_docs.iter().any(|doc| doc == rel) {
        return Ok(()); // 无新增条目不落盘（幂等）
    }
    let mut docs = existing_docs;
    docs.push(rel.to_string());
    docs.sort();
    docs.dedup();
    settings["modifiedDocs"] = json!(docs);
    let text = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    let tmp = project_dir.join(format!("workspace.meta.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, &text).map_err(|err| format!("write {}: {err}", tmp.display()))?;
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("rename {} failed: {err}", path.display()));
    }
    Ok(())
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
    /// 联网搜索生效值（会话覆盖优先，缺省回 `llm.webSearch`）：
    /// 决定 WebSearch / WebFetch 两个工具是否注入本轮工具清单
    pub web_search: bool,
    /// 该模型是否多模态；`false` 时 `llm::stream` 在请求出口过滤全部图片
    /// （`specs/012-multimodal-model-filter`）
    pub multimodal: bool,
}

/// 输出上限的绝对上限（对齐 `MAX_OUTPUT_TOKENS_UPPER_LIMIT`）
const MAX_OUTPUT_TOKENS_UPPER_LIMIT: u32 = 384 * 1024;
/// 环境变量：最高优先级的输出上限覆盖（名字取 `project.json` 的 `envMaxOutputTokens`，
/// build.rs 构建期烧入；与 TS 侧同一配置来源）
const ENV_MAX_OUTPUT_TOKENS: &str = env!("TC_ENV_MAX_OUTPUT_TOKENS");

/// apiKey 未配置时给用户看的文案（逐字对齐 `llm/config.ts` 的 `getConfig` /
/// `getConfigForProvider`：两条路径抛的是同一段文本）。
fn missing_api_key_message() -> String {
    let config_dir = host_environment()
        .map(|env| env.config_dir_name)
        .unwrap_or_else(|| DEFAULT_CONFIG_DIR_NAME.to_string());
    format!(
        "API Key 未配置，无法调用 LLM。\n请在「设置 → LLM 配置」中填写 API Key，\n或编辑 ~/{config_dir}/settings.json 中对应 provider 的 apiKey 字段。"
    )
}

/// 解析当前生效的 provider 配置。
///
/// `model_override` / `provider_override` 来自会话（meta.json）；缺省时用配置快照的
/// `llm.activeProvider` 与该 provider 的默认模型。
///
/// 错误口径：
/// - 会话显式指定了 provider 但它不存在 / 没有 baseURL → `provider "X" 不存在或未配置 baseURL`
///   （`getConfigForProvider` 不做回退，必须暴露）；
/// - 其余「没有可用 provider / 没有 apiKey」→ 与 `getConfig` 一致地抛 API Key 未配置文案
///   （activeProvider 缺失或无效时按空 apiKey 的兜底配置处理，最终都落到这条）。
///
/// 模型限值取自快照里**已解析**的结果（注册表归 UI），Core 侧不做模型名匹配。
pub fn resolve_provider(
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<ProviderConfig, String> {
    let snapshot = settings::settings_snapshot()?;
    let llm = &snapshot.llm;

    let override_key = provider_override
        .map(|key| key.to_string())
        .filter(|key| !key.is_empty());
    let active_key = override_key
        .clone()
        .unwrap_or_else(|| llm.active_provider.clone());
    if active_key.is_empty() {
        return Err(missing_api_key_message());
    }

    let Some(provider) = llm.providers.get(&active_key) else {
        return Err(if override_key.is_some() {
            format!("provider \"{active_key}\" 不存在或未配置 baseURL")
        } else {
            missing_api_key_message()
        });
    };

    let base_url = provider.base_url.trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err(if override_key.is_some() {
            format!("provider \"{active_key}\" 不存在或未配置 baseURL")
        } else {
            missing_api_key_message()
        });
    }

    let model = model_override
        .map(|value| crate::util::js_trim(value).to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            // 顶层遗留 `llm.model` 只在没有会话级 provider 覆盖时生效
            // （对齐 `getDefaultConfig` 与 `getConfigForProvider` 的分叉）
            if override_key.is_some() {
                return None;
            }
            let legacy = crate::util::js_trim(&llm.model);
            if legacy.is_empty() {
                None
            } else {
                Some(legacy.to_string())
            }
        })
        .or_else(|| {
            let default_model = provider.default_model.trim();
            if default_model.is_empty() {
                None
            } else {
                Some(default_model.to_string())
            }
        })
        .or_else(|| provider.models.first().cloned())
        .unwrap_or_default();
    // 注意：模型为空**不**在这里报错：允许 `model` 为空串（未配置默认模型时），
    // 由服务端返回错误。这里继续往下走，
    // 保证「provider 有 baseURL 但没配模型」时报的是 API Key 文案（`api_key` 为空时）
    // 或把空模型原样带进请求（`api_key` 已配置时）。

    let api_key = provider.api_key.clone();
    if api_key.is_empty() {
        return Err(missing_api_key_message());
    }

    let limits = provider.limits_for(&model, &llm.model_limits_fallback);

    // 输出上限：env > 模型限值；与 TS 的 `effectiveMaxOutputTokens` 同口径。
    let effective_max = std::env::var(ENV_MAX_OUTPUT_TOKENS)
        .ok()
        .and_then(|value| crate::util::js_trim(&value).parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_OUTPUT_TOKENS_UPPER_LIMIT))
        .unwrap_or_else(|| (limits.output as u32).min(MAX_OUTPUT_TOKENS_UPPER_LIMIT));
    // 配置级上限（`llm.maxTokens`）与模型限值取更严的那个
    let configured_max = (llm.max_tokens as u32).min(MAX_OUTPUT_TOKENS_UPPER_LIMIT);
    let max_tokens = configured_max.min(effective_max);

    Ok(ProviderConfig {
        api_key,
        base_url,
        model,
        api_type: limits.api_type.clone(),
        max_tokens,
        thinking_budget_tokens: limits.thinking_token_budget as u32,
        thinking_effort: llm.thinking_effort.clone(),
        context_window: limits.context as u32,
        web_search: llm.web_search,
        multimodal: limits.multimodal,
    })
}

/// 新对话的默认思考强度（快照的 `llm.thinkingEffort`；白名单外的取值已由 UI 回落）
pub fn default_thinking_effort() -> String {
    settings::settings_snapshot()
        .map(|snapshot| snapshot.llm.thinking_effort)
        .unwrap_or_else(|_| "high".to_string())
}

/// 新对话的默认 Web Search 开关（快照的 `llm.webSearch`）
pub fn default_web_search() -> bool {
    settings::settings_snapshot()
        .map(|snapshot| snapshot.llm.web_search)
        .unwrap_or(true)
}

/// 新对话的默认 agent mode（快照的 `defaultAgentMode`；白名单外的取值已由 UI 回落）
pub fn default_agent_mode() -> String {
    settings::settings_snapshot()
        .map(|snapshot| snapshot.default_agent_mode)
        .unwrap_or_else(|_| "risk".to_string())
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

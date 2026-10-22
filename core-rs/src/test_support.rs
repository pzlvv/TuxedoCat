//! 测试支撑（仅 `cargo test` 编译）。
//!
//! 三类工具：
//! - `serial()` / `Sandbox`：`config` / `prompt` / `tools` 有进程级静态缓存，
//!   触碰它们的用例必须串行，并各自在临时目录里跑，退出时清理环境变量与缓存；
//! - `Capture`：把帧写出到内存缓冲，便于断言 Core 实际发了什么；
//! - `FakeLlm` / `EngineHarness`：本地 HTTP 假 LLM + 自动应答 `CoreRequest`，
//!   让查询循环能在进程内跑完整轮次。
#![allow(dead_code)]

use std::collections::HashSet;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::bus::{CoreBus, FrameWriter};
use crate::config::{self, HostEnvironment};
use crate::engine::{Core, SharedBus};
use crate::settings::{self, McpServerDefinition, SettingsSnapshot};
use crate::util;

/// 触碰全局静态状态的用例串行闸门
static SERIAL: Mutex<()> = Mutex::new(());

pub fn serial() -> MutexGuard<'static, ()> {
    // 前一个用例 panic 时锁会被污染，这里恢复而不是继续 panic
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ==================== 沙箱 ====================

/// 独立主目录 + 工作目录 + 宿主环境；退出时还原环境变量并清缓存
pub struct Sandbox {
    pub root: PathBuf,
    pub home: PathBuf,
    pub workspace: PathBuf,
    pub config_dir_name: String,
    guard: MutexGuard<'static, ()>,
    env_backup: Vec<(&'static str, Option<String>)>,
}

impl Sandbox {
    pub fn new(name: &str) -> Sandbox {
        let guard = serial();
        let root = std::env::temp_dir().join(format!("standalone-core-{name}-{}", util::unique_id("t")));
        let home = root.join("home");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&home).expect("create home");
        std::fs::create_dir_all(&workspace).expect("create workspace");

        let mut env_backup = Vec::new();
        for key in ["USERPROFILE", "HOME"] {
            env_backup.push((key, std::env::var(key).ok()));
            std::env::set_var(key, &home);
        }
        // 工具命令的 PATH 由 `shell_env` 探测用户 shell 得到；用例不跑真实的启动文件，
        // 直接钉成「沙箱目录 + 继承来的 PATH」——首位目录是用例断言 PATH 已注入的标记
        // （`docs/core/standalone-core.md` 第 3.2.1 节）。两种形式钉成同一份：用例只看
        // 沙箱目录出现在子进程 `$PATH` 里，不区分 shell 形式与原生形式。
        let mut forced_path = root.join("bin").into_os_string();
        if let Some(inherited) = std::env::var_os("PATH") {
            if !inherited.is_empty() {
                forced_path.push(if cfg!(windows) { ";" } else { ":" });
                forced_path.push(inherited);
            }
        }
        crate::shell_env::force_path_for_test(forced_path.clone(), forced_path);

        let config_dir_name = ".test-core".to_string();
        config::set_host_environment(HostEnvironment {
            extension_path: root.join("extension").to_string_lossy().to_string(),
            log_to_console: false,
            config_dir_name: config_dir_name.clone(),
        });
        // 沙箱默认「宿主已连接、配置为空」：真实路径上 `hostEnvironmentProvided`
        // 永远先于任何其它 UiEvent（`docs/architecture/core-ui-separation.md` 第 7 节），
        // 就绪前收到其它事件会被 Core 拒绝。需要「快照尚未到达」状态的用例
        // 自己调 `settings::reset_settings_snapshot()`。
        settings::apply_settings_snapshot(build_test_snapshot(&json!({})), Vec::new());
        config::set_active_workspace(None);
        config::reset_session_workspaces();

        Sandbox {
            root,
            home,
            workspace,
            config_dir_name,
            guard,
            env_backup,
        }
    }

    /// 写 `settings.json` **并**把等价的配置快照注入 Core 侧唯一入口。
    ///
    /// 测试里由本函数扮演 **Host** 的角色：UI 读盘后补默认值、规范化，产出一份快照
    /// 随 `hostEnvironmentProvided` 下发（`docs/architecture/core-ui-separation.md` 第 4 节）。
    /// 因此这里复刻 Host 的规范化口径（白名单回落、缺字段补默认、无 `baseURL` 的
    /// provider 不进快照）。
    ///
    /// `modelLimits` **留空**：注册表归 UI，Core 侧不再做模型名匹配，未命中的模型一律
    /// 走 `modelLimitsFallback`。需要特定模型限值的用例在 `settings` 里显式写
    /// `llm.providers.<key>.modelLimits`。
    pub fn write_settings(&self, settings: Value) {
        let path = self.settings_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create config dir");
        }
        std::fs::write(&path, serde_json::to_string_pretty(&settings).unwrap()).expect("write settings");
        self.refresh_settings_snapshot();
    }

    /// 写 `mcp.json` 并刷新快照（顺序敏感的用例应在 `write_settings` 之后调用）
    pub fn write_mcp_json(&self, servers: Value) {
        let path = config::config_home().expect("config home").join("mcp.json");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create config dir");
        }
        std::fs::write(&path, serde_json::to_string(&servers).unwrap()).expect("write mcp.json");
        self.refresh_settings_snapshot();
    }

    /// 按当前磁盘上的 `settings.json` / `mcp.json` 重新产出快照并注入
    pub fn refresh_settings_snapshot(&self) {
        let snapshot = build_test_snapshot(&self.read_settings());
        settings::apply_settings_snapshot(snapshot, self.read_mcp_servers());
    }

    /// 读回 `mcp.json`（不存在时返回空对象）
    pub fn read_mcp_json(&self) -> Value {
        let path = config::config_home().expect("config home").join("mcp.json");
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(|| json!({}))
    }

    /// 读回 `mcp.json` 并解析为服务器定义（与 Host 的 `parseMcpServerDefinitions` 同口径）
    fn read_mcp_servers(&self) -> Vec<McpServerDefinition> {
        crate::mcp_config::parse_mcp_server_definitions(&self.read_mcp_json())
    }

    /// 全局 `settings.json` 路径。
    ///
    /// 生产代码里这个路径归宿主（Core 不感知），测试沙箱里由本函数按沙箱 HOME 现算：
    /// 测试自己扮演 Host，需要知道往哪写。
    pub fn settings_path(&self) -> std::path::PathBuf {
        config::config_home().expect("config home").join("settings.json")
    }

    /// 读回 `settings.json`（不存在时返回空对象），用于在原配置上打补丁
    pub fn read_settings(&self) -> Value {
        let path = self.settings_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_else(|| json!({}))
    }

    /// 写一份指向假 LLM 的 `settings.json`
    pub fn write_llm_settings(&self, base_url: &str, agent_mode: &str) {
        self.write_llm_settings_with_api_type(base_url, agent_mode, "OpenAI");
    }

    /// 同上，但指定 `apiType`（`OpenAI` / `Anthropic`）
    pub fn write_llm_settings_with_api_type(&self, base_url: &str, agent_mode: &str, api_type: &str) {
        self.write_settings(json!({
            "defaultAgentMode": agent_mode,
            "llm": {
                "maxTokens": 4096,
                "activeProvider": "fake",
                "providers": {
                    "fake": {
                        "baseURL": base_url,
                        "apiKey": "test-key",
                        "models": ["fake-model"],
                        "defaultModel": "fake-model",
                        "modelConfigs": { "fake-model": { "apiType": api_type, "output": 4096 } }
                    }
                }
            }
        }));
    }

    /// 会话文件所在目录（会创建目录）
    pub fn conversation_dir(&self, project: &str) -> PathBuf {
        config::ensure_project_conversation_dir(project).expect("conversation dir")
    }

    /// 把宿主扩展目录指到仓库根：`ripgrep_path()` 因此能解析到
    /// `dist/resources/ripgrep/<arch>-<platform>/rg.exe`（用例进程的可执行文件在
    /// `core-rs/target/` 下，旁边没有 Core 自带的 `ripgrep/`）
    pub fn point_extension_at_repo(&self) {
        let current = config::host_environment().expect("host env");
        config::set_host_environment(HostEnvironment {
            extension_path: repo_root().to_string_lossy().to_string(),
            ..current
        });
    }

    pub fn write_file(&self, relative: &str, content: &str) -> PathBuf {
        let path = self.workspace.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(&path, content).expect("write file");
        path
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        for (key, value) in &self.env_backup {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        settings::reset_settings_snapshot();
        config::set_active_workspace(None);
        config::reset_session_workspaces();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// 把磁盘形状的 `provider.modelConfigs` 合并成快照形状的 `modelLimits`。
///
/// Host 侧的 `resolveSettingsSnapshot` 会做同一件事：注册表匹配 → 用户 context/output
/// 覆盖 → 补 apiType。测试快照的注册表等价物就是全局兜底（当前注册表每条与兜底同值），
/// 因此这里只需要「兜底 + 用户覆盖」两步。
fn build_test_model_limits(configs: Option<&Value>) -> Value {
    let mut out = serde_json::Map::new();
    let Some(map) = configs.and_then(Value::as_object) else {
        return Value::Object(out);
    };
    let fallback = test_fallback_limits();
    for (model, limits) in map {
        let context = limits
            .get("context")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| fallback["context"].as_u64().unwrap_or(0));
        let output = limits
            .get("output")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| fallback["output"].as_u64().unwrap_or(0));
        let api_type = limits
            .get("apiType")
            .and_then(Value::as_str)
            .unwrap_or("OpenAI");
        let multimodal = limits
            .get("multimodal")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        out.insert(
            model.clone(),
            json!({
                "context": context,
                "output": output,
                "apiType": api_type,
                "thinkingTokenBudget": fallback["thinkingTokenBudget"],
                "multimodal": multimodal,
            }),
        );
    }
    Value::Object(out)
}

// ==================== 测试里的「Host」角色 ====================

/// 测试快照的全局兜底限值（与 Host 的 `FALLBACK_MODEL_PARAMS` 同值）。
///
/// 生产里这份兜底由 UI 产出；注册表归 UI，Core 侧不再做模型名匹配，因此测试快照的
/// `modelLimits` 一律留空，所有未显式配置的模型都走这里。
fn test_fallback_limits() -> Value {
    json!({
        "context": 1024 * 1024,
        "output": 128 * 1024,
        "apiType": "OpenAI",
        "thinkingTokenBudget": 192 * 1024,
        "multimodal": true,
    })
}

/// 测试用：把原始 `settings.json` 规范化成配置快照。
///
/// 复刻 `src/core/settingsSnapshot.ts` 的 `resolveSettingsSnapshot`：白名单外的取值回落
/// 默认、缺字段补默认、没有 `baseURL` 的 provider 不进快照。改动 Host 口径时这里要跟着改。
fn build_test_snapshot(raw: &Value) -> SettingsSnapshot {
    let llm = raw.get("llm").cloned().unwrap_or_else(|| json!({}));

    let mut providers = serde_json::Map::new();
    if let Some(map) = llm.get("providers").and_then(Value::as_object) {
        for (key, provider) in map {
            let base_url = provider
                .get("baseURL")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let models: Vec<String> = provider
                .get("models")
                .and_then(Value::as_array)
                .map(|items| {
                    let mut out: Vec<String> = Vec::new();
                    for item in items {
                        let Some(model) = item.as_str() else { continue };
                        let model = model.trim();
                        if model.is_empty() || out.iter().any(|existing| existing == model) {
                            continue;
                        }
                        out.push(model.to_string());
                    }
                    out
                })
                .unwrap_or_default();
            let explicit_default = provider
                .get("defaultModel")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let default_model = if explicit_default.is_empty() {
                models.first().cloned().unwrap_or_default()
            } else {
                explicit_default
            };
            providers.insert(
                key.clone(),
                json!({
                    "baseURL": base_url,
                    "apiKey": provider.get("apiKey").and_then(Value::as_str).unwrap_or(""),
                    "models": models,
                    "defaultModel": default_model,
                    "modelLimits": build_test_model_limits(provider.get("modelConfigs")),
                }),
            );
        }
    }

    let active_raw = llm.get("activeProvider").and_then(Value::as_str).unwrap_or("");
    let active_provider = if providers
        .get(active_raw)
        .and_then(|provider| provider.get("baseURL"))
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        active_raw.to_string()
    } else {
        String::new()
    };

    let snapshot = json!({
        "llm": {
            "activeProvider": active_provider,
            "webSearch": llm.get("webSearch").and_then(Value::as_bool).unwrap_or(true),
            "thinkingEffort": match llm.get("thinking_effort").and_then(Value::as_str) {
                Some("off") => "off",
                Some("low") => "low",
                Some("max") => "max",
                _ => "high",
            },
            "model": llm.get("model").and_then(Value::as_str).unwrap_or("").trim(),
            "maxTokens": llm
                .get("maxTokens")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0)
                .unwrap_or(128 * 1024),
            "enableUsageStats": llm.get("enableUsageStats").and_then(Value::as_bool).unwrap_or(true),
            "providers": providers,
            "modelLimitsFallback": test_fallback_limits(),
        },
        "mcp": {
            "enabled": raw
                .get("mcp")
                .and_then(|mcp| mcp.get("enabled"))
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default(),
        },
        "defaultAgentMode": match raw.get("defaultAgentMode").and_then(Value::as_str) {
            Some("manual") => "manual",
            Some("auto") => "auto",
            _ => "risk",
        },
        "defaultPromptMode": match raw.get("defaultPromptMode").and_then(Value::as_str) {
            Some("minimal") => "minimal",
            Some("mixed") => "mixed",
            _ => "normal",
        },
    });

    serde_json::from_value(snapshot).expect("test settings snapshot")
}

/// 仓库根目录（`core-rs` 的上一级）
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// 随应用分发的 ripgrep 产物；未构建 `dist` 时返回 None
pub fn bundled_ripgrep() -> Option<PathBuf> {
    let platform = if cfg!(windows) { "win32" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    let exe = if cfg!(windows) { "rg.exe" } else { "rg" };
    let candidate = repo_root()
        .join("dist/resources/ripgrep")
        .join(format!("{arch}-{platform}"))
        .join(exe);
    candidate.is_file().then_some(candidate)
}

/// Grep / Glob 用例是否具备运行条件（需要 rg 产物）
pub fn ripgrep_available() -> bool {
    bundled_ripgrep().is_some()
}

/// 对照表 `core-rs/fixtures/imageValidation.json` 里的最小合法
/// PNG（`png-valid`，签名 + IHDR + IDAT + IEND）。
///
/// Read 的图片用例（`tools_tests` / `engine_tests`）共用这一份：hex 只有对照表一处
/// 来源，不会出现「测试用的假 PNG 与对照表漂移」。
pub fn minimal_png_bytes() -> Vec<u8> {
    let fixture: Value =
        serde_json::from_str(include_str!("../fixtures/imageValidation.json"))
            .expect("imageValidation.json 必须是合法 JSON");
    let hex = fixture["cases"]
        .as_array()
        .and_then(|cases| cases.iter().find(|case| case["name"] == "png-valid"))
        .and_then(|case| case["hex"].as_str())
        .expect("对照表缺少 png-valid");
    hex.as_bytes()
        .chunks(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex 是 ASCII"), 16).expect("hex")
        })
        .collect()
}

// ==================== 帧捕获 ====================

/// 可共享的帧缓冲，实现 `Write` 后可直接当 `CoreBus` 的出站目标
#[derive(Clone, Default)]
pub struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    pub fn new() -> Capture {
        Capture::default()
    }

    pub fn writer(&self) -> FrameWriter {
        Box::new(self.clone())
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).to_string()
    }

    /// 已写出的全部帧
    pub fn frames(&self) -> Vec<Value> {
        self.text()
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect()
    }

    /// `kind == "event"` 的载荷
    pub fn events(&self) -> Vec<Value> {
        self.frames()
            .into_iter()
            .filter(|frame| frame.get("kind").and_then(Value::as_str) == Some("event"))
            .filter_map(|frame| frame.get("event").cloned())
            .collect()
    }

    pub fn event_types(&self) -> Vec<String> {
        self.events()
            .iter()
            .filter_map(|event| event.get("type").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    /// 第一个指定类型的事件
    pub fn event_of(&self, event_type: &str) -> Option<Value> {
        self.events()
            .into_iter()
            .find(|event| event.get("type").and_then(Value::as_str) == Some(event_type))
    }

    pub fn events_of(&self, event_type: &str) -> Vec<Value> {
        self.events()
            .into_iter()
            .filter(|event| event.get("type").and_then(Value::as_str) == Some(event_type))
            .collect()
    }

    /// `kind == "request"` 的 `(id, request)`
    pub fn requests(&self) -> Vec<(u64, Value)> {
        self.frames()
            .into_iter()
            .filter(|frame| frame.get("kind").and_then(Value::as_str) == Some("request"))
            .filter_map(|frame| {
                let id = frame.get("id").and_then(Value::as_u64)?;
                Some((id, frame.get("request").cloned().unwrap_or(Value::Null)))
            })
            .collect()
    }

    /// 指定类型的请求载荷
    pub fn requests_of(&self, request_type: &str) -> Vec<Value> {
        self.requests()
            .into_iter()
            .filter(|(_, request)| request.get("type").and_then(Value::as_str) == Some(request_type))
            .map(|(_, request)| request)
            .collect()
    }

    pub fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 写入必定失败的出口（覆盖「宿主已退出」分支）
pub struct FailingWriter;

impl Write for FailingWriter {
    fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "host gone"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "host gone"))
    }
}

// ==================== 假 LLM ====================

/// 本地 HTTP 服务，按请求次序返回预置的 SSE 响应体
pub struct FakeLlm {
    pub base_url: String,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FakeLlm {
    /// `respond(第几次请求, 请求体)` 返回该次响应的 SSE 正文
    pub fn start<F>(mut respond: F) -> FakeLlm
    where
        F: FnMut(usize, &Value) -> String + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake llm");
        let port = listener.local_addr().expect("local addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut index = 0usize;
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let body = read_http_request(&mut stream);
                        let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
                        let response = respond(index, &payload);
                        index += 1;
                        let _ = write_http_response(&mut stream, 200, &response);
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    // Windows 上客户端在 accept 前重置连接时，accept 会瞬时返回
                    // WSAECONNRESET。这里绝不能退出：线程一退 listener 就关了，
                    // 后续所有请求都会被拒连（测试里表现为 LLM 请求三次重试全失败）。
                    // accept 错误都是单连接级的，睡一下继续轮询；线程只经 stop 退出。
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        });
        FakeLlm {
            base_url: format!("http://127.0.0.1:{port}"),
            stop,
            handle: Some(handle),
        }
    }

    /// 固定返回同一个 SSE 正文
    pub fn fixed(body: String) -> FakeLlm {
        FakeLlm::start(move |_, _| body.clone())
    }

    /// `respond(第几次请求, 请求体)` 返回 `(HTTP 状态码, 正文)`；用于构造 502/503 重试场景
    pub fn start_with_status<F>(mut respond: F) -> FakeLlm
    where
        F: FnMut(usize, &Value) -> (u16, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake llm");
        let port = listener.local_addr().expect("local addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            let mut index = 0usize;
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let body = read_http_request(&mut stream);
                        let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
                        let (status, response) = respond(index, &payload);
                        index += 1;
                        let _ = write_http_response(&mut stream, status, &response);
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    // 同 `start`：accept 的瞬时错误（Windows 的 WSAECONNRESET）
                    // 不能退出线程，否则 listener 关闭、后续请求全部拒连。
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        });
        FakeLlm {
            base_url: format!("http://127.0.0.1:{port}"),
            stop,
            handle: Some(handle),
        }
    }

    /// 分段写响应：写完 `first` 后调用 `between`，再写 `second`。
    ///
    /// `start` 一次性写完整个正文，插不进「流中途」的动作；构造
    /// 「已解析出 tool_use，随后被中止」这类确定性时序必须分两次写。
    pub fn start_gated<F, G>(mut respond: F, between: G) -> FakeLlm
    where
        F: FnMut(usize, &Value) -> (String, String) + Send + 'static,
        G: Fn() + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake llm");
        let port = listener.local_addr().expect("local addr").port();
        listener.set_nonblocking(true).expect("nonblocking");
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let between = Arc::new(between);
        let handle = std::thread::spawn(move || {
            let mut index = 0usize;
            while !worker_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let body = read_http_request(&mut stream);
                        let payload = serde_json::from_str::<Value>(&body).unwrap_or(Value::Null);
                        let (first, second) = respond(index, &payload);
                        index += 1;
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n",
                            first.len() + second.len()
                        );
                        let _ = stream.write_all(head.as_bytes());
                        let _ = stream.write_all(first.as_bytes());
                        let _ = stream.flush();
                        between();
                        let _ = stream.write_all(second.as_bytes());
                        let _ = stream.flush();
                    }
                    Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    // 同 `start`：accept 的瞬时错误（Windows 的 WSAECONNRESET）
                    // 不能退出线程，否则 listener 关闭、后续请求全部拒连。
                    Err(_) => {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            }
        });
        FakeLlm {
            base_url: format!("http://127.0.0.1:{port}"),
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for FakeLlm {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn read_http_request(stream: &mut TcpStream) -> String {
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut expected: Option<usize> = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(head_end) = find_subslice(&buffer, b"\r\n\r\n") {
            if expected.is_none() {
                let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
                expected = Some(
                    head.lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0),
                );
            }
            if let Some(length) = expected {
                if buffer.len() >= head_end + 4 + length {
                    return String::from_utf8_lossy(&buffer[head_end + 4..head_end + 4 + length])
                        .to_string();
                }
            }
        }
        if Instant::now() >= deadline {
            return String::new();
        }
        match stream.read(&mut chunk) {
            Ok(0) => return String::new(),
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => return String::new(),
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn write_http_response(stream: &mut TcpStream, status: u16, body: &str) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: text/event-stream\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

// ==================== SSE 响应构造 ====================

/// OpenAI 协议：文本增量 + 结束
pub fn openai_text_sse(chunks: &[&str]) -> String {
    let mut out = String::new();
    for chunk in chunks {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "choices": [{ "delta": { "content": chunk } }] })
        ));
    }
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

/// OpenAI 协议：一次工具调用（参数按两片到达）+ 结束
pub fn openai_tool_sse(id: &str, name: &str, arguments: &str) -> String {
    // 参数含多字节 UTF-8（中文入参等）时按字节对半切会切进字符内部并 panic：
    // 回退到最近的字符边界，ASCII 参数行为不变
    let mut split = arguments.len() / 2;
    while split > 0 && !arguments.is_char_boundary(split) {
        split -= 1;
    }
    let (first, second) = arguments.split_at(split);
    let mut out = String::new();
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "id": id, "function": { "name": name, "arguments": first } }
        ] } }] })
    ));
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "tool_calls": [
            { "index": 0, "function": { "arguments": second } }
        ] } }] })
    ));
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

/// OpenAI 协议：思考增量 + 文本 + 用量
pub fn openai_thinking_sse(thinking: &str, text: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "reasoning_content": thinking } }] })
    ));
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": { "content": text } }] })
    ));
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }],
                "usage": { "prompt_tokens": 11, "completion_tokens": 22 } })
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

/// Responses API 协议：文本消息的完整流（含终止事件与 usage）
///
/// 事件顺序对齐真实服务：`response.created` → `output_item.added`(message) →
/// `content_part.added` → `output_text.delta` xN → `output_text.done` →
/// `output_item.done` → `response.completed`。
pub fn responses_text_sse(chunks: &[&str]) -> String {
    let mut out = String::new();
    let mut push = |value: serde_json::Value| {
        out.push_str(&format!("data: {value}

"));
    };
    push(json!({ "type": "response.created", "response": { "id": "resp_1", "status": "in_progress" } }));
    push(json!({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": { "id": "msg_item_1", "type": "message", "role": "assistant", "content": [] },
    }));
    push(json!({
        "type": "response.content_part.added",
        "item_id": "msg_item_1",
        "output_index": 0,
        "content_index": 0,
        "part": { "type": "output_text", "text": "" },
    }));
    for chunk in chunks {
        push(json!({
            "type": "response.output_text.delta",
            "item_id": "msg_item_1",
            "output_index": 0,
            "content_index": 0,
            "delta": chunk,
        }));
    }
    let full: String = chunks.concat();
    push(json!({
        "type": "response.output_text.done",
        "item_id": "msg_item_1",
        "output_index": 0,
        "content_index": 0,
        "text": full,
    }));
    push(json!({
        "type": "response.output_item.done",
        "output_index": 0,
        "item": {
            "id": "msg_item_1",
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": full }],
        },
    }));
    push(json!({
        "type": "response.completed",
        "response": {
            "id": "resp_1",
            "status": "completed",
            "output": [{
                "id": "msg_item_1",
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": full }],
            }],
            "usage": {
                "input_tokens": 11,
                "output_tokens": 22,
                "input_tokens_details": { "cached_tokens": 5 },
                "output_tokens_details": { "reasoning_tokens": 3 },
            },
        },
    }));
    out.push_str("data: [DONE]

");
    out
}

/// Responses API 协议：思考 + 文本 + 一次工具调用（参数分两片）
pub fn responses_thinking_tool_sse(thinking: &str, text: &str, id: &str, name: &str, arguments: &str) -> String {
    let mut out = String::new();
    let mut push = |value: serde_json::Value| {
        out.push_str(&format!("data: {value}

"));
    };
    push(json!({ "type": "response.created", "response": { "id": "resp_2", "status": "in_progress" } }));
    // 思考项
    push(json!({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": { "id": "rs_1", "type": "reasoning", "summary": [] },
    }));
    push(json!({
        "type": "response.reasoning_text.delta",
        "item_id": "rs_1",
        "output_index": 0,
        "delta": thinking,
    }));
    push(json!({
        "type": "response.reasoning_text.done",
        "item_id": "rs_1",
        "output_index": 0,
        "text": thinking,
    }));
    push(json!({
        "type": "response.output_item.done",
        "output_index": 0,
        "item": { "id": "rs_1", "type": "reasoning", "summary": [] },
    }));
    // 文本项
    push(json!({
        "type": "response.output_item.added",
        "output_index": 1,
        "item": { "id": "msg_2", "type": "message", "role": "assistant", "content": [] },
    }));
    push(json!({
        "type": "response.content_part.added",
        "item_id": "msg_2",
        "output_index": 1,
        "content_index": 0,
        "part": { "type": "output_text", "text": "" },
    }));
    push(json!({
        "type": "response.output_text.delta",
        "item_id": "msg_2",
        "output_index": 1,
        "content_index": 0,
        "delta": text,
    }));
    push(json!({
        "type": "response.output_text.done",
        "item_id": "msg_2",
        "output_index": 1,
        "content_index": 0,
        "text": text,
    }));
    push(json!({
        "type": "response.output_item.done",
        "output_index": 1,
        "item": {
            "id": "msg_2",
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text }],
        },
    }));
    // 工具调用项（参数分两片）
    push(json!({
        "type": "response.output_item.added",
        "output_index": 2,
        "item": { "id": id, "type": "function_call", "call_id": id, "name": name, "arguments": "" },
    }));
    let split = arguments.len() / 2;
    let (first, second) = arguments.split_at(split);
    push(json!({
        "type": "response.function_call_arguments.delta",
        "item_id": id,
        "output_index": 2,
        "delta": first,
    }));
    push(json!({
        "type": "response.function_call_arguments.delta",
        "item_id": id,
        "output_index": 2,
        "delta": second,
    }));
    push(json!({
        "type": "response.function_call_arguments.done",
        "item_id": id,
        "output_index": 2,
        "arguments": arguments,
    }));
    push(json!({
        "type": "response.output_item.done",
        "output_index": 2,
        "item": { "id": id, "type": "function_call", "call_id": id, "name": name, "arguments": arguments },
    }));
    push(json!({
        "type": "response.completed",
        "response": {
            "id": "resp_2",
            "status": "completed",
            "output": [
                { "id": "rs_1", "type": "reasoning", "content": [{ "type": "reasoning_text", "text": thinking }] },
                { "id": "msg_2", "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": text }] },
                { "id": id, "type": "function_call", "call_id": id, "name": name, "arguments": arguments },
            ],
            "usage": { "input_tokens": 30, "output_tokens": 40 },
        },
    }));
    out.push_str("data: [DONE]

");
    out
}

/// Anthropic 协议：思考 + 文本 + 工具调用 + 用量 + 结束
///
/// 每个内容块都带完整的 `content_block_start` / `content_block_stop` 帧
/// （对齐真实 Anthropic 流），因此引擎侧会按块边界发出 `streamEnd`。
pub fn anthropic_sse(thinking: &str, text: &str, tool: Option<(&str, &str, &str)>) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "type": "message_start", "message": { "usage": {
            "input_tokens": 5, "output_tokens": 0,
            "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2
        } } })
    ));
    let mut index = 0u64;
    if !thinking.is_empty() {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_start", "index": index,
                    "content_block": { "type": "thinking", "thinking": "" } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_delta", "index": index,
                    "delta": { "type": "thinking_delta", "thinking": thinking } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_stop", "index": index })
        ));
        index += 1;
    }
    if !text.is_empty() {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_start", "index": index,
                    "content_block": { "type": "text", "text": "" } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_delta", "index": index,
                    "delta": { "type": "text_delta", "text": text } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_stop", "index": index })
        ));
        index += 1;
    }
    if let Some((id, name, arguments)) = tool {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_start", "index": index,
                    "content_block": { "type": "tool_use", "id": id, "name": name } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_delta", "index": index,
                    "delta": { "type": "input_json_delta", "partial_json": arguments } })
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "type": "content_block_stop", "index": index })
        ));
    }
    out.push_str(&format!(
        "data: {}\n\n",
        json!({ "type": "message_delta", "usage": { "output_tokens": 7 },
                "delta": { "stop_reason": "end_turn" } })
    ));
    out
}

// ==================== 引擎测试夹具 ====================

/// 进程内驱动 `Core`：捕获帧，并自动应答 `CoreRequest`
pub struct EngineHarness {
    pub core: Arc<Core>,
    pub bus: SharedBus,
    pub sink: Capture,
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl EngineHarness {
    /// `respond` 收到请求载荷，返回应答内容；返回 None 表示回失败应答
    pub fn start<F>(respond: F) -> EngineHarness
    where
        F: Fn(&Value) -> Option<Value> + Send + 'static,
    {
        Self::start_with(Capture::new(), respond)
    }

    pub fn start_with<F>(sink: Capture, respond: F) -> EngineHarness
    where
        F: Fn(&Value) -> Option<Value> + Send + 'static,
    {
        let bus: SharedBus = Arc::new(Mutex::new(CoreBus::<FrameWriter>::new(sink.writer())));
        let core = Arc::new(Core::new(Arc::clone(&bus)));
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker_sink = sink.clone();
        let worker_bus = Arc::clone(&bus);
        let handle = std::thread::spawn(move || {
            let mut answered: HashSet<u64> = HashSet::new();
            while !worker_stop.load(Ordering::Relaxed) {
                for (id, request) in worker_sink.requests() {
                    if !answered.insert(id) {
                        continue;
                    }
                    let result = respond(&request);
                    let mut bus = worker_bus.lock().unwrap();
                    match result {
                        Some(value) => bus.handle_response(id, true, value, None),
                        None => bus.handle_response(
                            id,
                            false,
                            Value::Null,
                            Some("harness: no response".to_string()),
                        ),
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        EngineHarness {
            core,
            bus,
            sink,
            stop,
            handle: Some(handle),
        }
    }

    /// 默认应答：权限请求保持 `ask`（触发确认框），确认框选「允许」
    pub fn allow_all() -> EngineHarness {
        EngineHarness::start(|request| match request.get("type").and_then(Value::as_str) {
            Some("toolPermissionRequested") => Some(json!({ "behavior": "ask" })),
            Some("userChoice") => Some(json!({ "index": 0 })),
            _ => Some(json!({})),
        })
    }

    /// 等待条件成立
    pub fn wait_for(&self, predicate: impl Fn(&Capture) -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if predicate(&self.sink) {
                return true;
            }
            if Instant::now() >= deadline {
                return predicate(&self.sink);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// 等到一轮彻底结束。
    ///
    /// `queryEnd` 之后 Core 还会刷新 `meta.json` 并上报 `conversationListChanged`，
    /// 断言落盘结果前必须等后者，否则会读到写入前的快照。
    pub fn wait_query_end(&self) -> bool {
        self.wait_for(
            |sink| {
                let types = sink.event_types();
                types.iter().any(|kind| kind == "queryEnd")
                    && types.iter().any(|kind| kind == "conversationListChanged")
            },
            Duration::from_secs(30),
        )
    }

    pub fn request(&self, request: Value) -> Option<Value> {
        let (_, receiver) = {
            let mut bus = self.bus.lock().unwrap();
            bus.request(request)?
        };
        crate::bus::wait_response(receiver, Duration::from_secs(5))
    }
}

impl Drop for EngineHarness {
    fn drop(&mut self) {
        // 收尾必须把还活着的轮次（尤其是后台子代理会话）全部中止并等静默：
        // 测试函数一返回，`Sandbox` 持有的进程级串行锁就释放了，下一个用例会立刻
        // 重置全局 settings / 活动工作目录。此时若本用例的后台轮次还在跑，它会读走
        // 下一个用例的 FakeLlm base_url 与工作目录——既污染对方 FakeLlm 的应答序号，
        // 也让本方会话把下一个用例的沙箱写进落盘（满载跑全量时稳定复现）。
        for session_id in self.core.session_ids() {
            self.core.on_abort(&session_id);
        }
        // 轮次线程是分离的，只能等：深度空闲判断沿子代理注册表覆盖子会话
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            let busy = self
                .core
                .session_ids()
                .iter()
                .any(|id| !self.core.is_session_idle(id));
            if !busy {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        for session_id in self.core.session_ids() {
            self.core.drop_session(&session_id);
        }
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

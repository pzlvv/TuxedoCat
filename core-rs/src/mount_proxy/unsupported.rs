//! 非 Linux 的占位实现（specs/051 FR-001 AC-3）。
//!
//! 挂载命名空间、overlayfs、setuid 语义都是 Linux 的：Windows / macOS 上装代理也解决
//! 不了，因此 `deployable: false`，界面整块入口不渲染（FR-002 / AC-5）。
//!
//! 保持同签名：上层（`work_view::capabilities` / 能力应答）不按平台分支。

/// 能力探测的结果（平台无关的载体）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProbe {
    /// 常驻代理是否就绪（已安装 + 协议匹配 + 自检通过）
    pub ready: bool,
    /// 代理报回的 overlay 实测是否可挂
    pub overlay_ok: bool,
    /// 本平台**可能**通过装代理获得能力（Linux 且内核有 overlayfs）
    pub overlay_usable: bool,
    /// 不可用的原因（就绪且可挂时为空串）
    pub reason: String,
}

/// 探测能力。非 Linux 恒回「平台不支持，装代理也解决不了」。
pub fn probe_capabilities() -> CapabilityProbe {
    CapabilityProbe {
        ready: false,
        overlay_ok: false,
        overlay_usable: false,
        reason: format!(
            "对话工作视图只在 Linux Core 上可用：当前平台是 {}，装挂载代理也解决不了",
            std::env::consts::OS
        ),
    }
}

/// 挂载代理的状态：非 Linux 恒 `Absent`
pub fn state_of(_probe: &CapabilityProbe) -> crate::mount_proxy::MountProxyState {
    crate::mount_proxy::MountProxyState::Absent
}

/// 一次 spawn 的入参（与 Linux 侧同形；非 Linux 上没有调用方）
#[derive(Debug)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: std::path::PathBuf,
    pub env: Vec<String>,
    pub stdin: Option<Vec<u8>>,
}

/// 一次 spawn 的结论（与 Linux 侧同形）
pub struct SpawnOutcome {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

/// 视图路径参数
#[derive(Clone, Debug, Default)]
pub struct ViewPaths {
    pub lower: std::path::PathBuf,
    pub upper: std::path::PathBuf,
    pub work: std::path::PathBuf,
    pub merged: std::path::PathBuf,
    pub workspace: std::path::PathBuf,
}
/// 视图路径参数的对外名（与 Linux 侧同名）
pub type View = ViewPaths;

/// 会话代理句柄：非 Linux 恒构造不出来。
///
/// 保留方法签名让 `ToolContext` 的代执行原语不必按平台分叉——非 Linux 上这些方法永远
/// 走不到（`session_proxy` 恒回错误），因此全部直接报错而不是假装成功。
pub struct SessionProxy;

/// 一个路径的事实（与 Linux 侧同形）
pub struct PathFacts {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

impl SessionProxy {
    pub fn is_alive(&self) -> bool {
        false
    }

    pub fn mount_point(&self) -> &std::path::Path {
        std::path::Path::new("")
    }

    pub fn read_file(&self, _path: &std::path::Path, _max: Option<u64>) -> Result<Vec<u8>, String> {
        Err(not_linux())
    }

    pub fn write_file(&self, _path: &std::path::Path, _bytes: &[u8]) -> Result<(), String> {
        Err(not_linux())
    }

    pub fn mkdir_all(&self, _path: &std::path::Path) -> Result<(), String> {
        Err(not_linux())
    }

    pub fn stat(&self, _path: &std::path::Path) -> Result<PathFacts, String> {
        Err(not_linux())
    }

    pub fn list_dir(&self, _path: &std::path::Path) -> Result<Vec<(String, bool)>, String> {
        Err(not_linux())
    }

    pub fn git_show(
        &self,
        _repo: &std::path::Path,
        _rev: &str,
        _path: &str,
    ) -> Result<Vec<u8>, String> {
        Err(not_linux())
    }

    pub fn start_spawn(&self, _spec: SpawnSpec) -> Result<u64, String> {
        Err(not_linux())
    }

    pub fn wait_spawn(
        &self,
        _id: u64,
        _timeout: std::time::Duration,
        _cancel: Option<&std::sync::atomic::AtomicBool>,
        _on_chunk: impl FnMut(&[u8], &[u8]),
    ) -> Result<SpawnOutcome, String> {
        Err(not_linux())
    }

    pub fn kill(&self, _target: u64) -> Result<(), String> {
        Err(not_linux())
    }
}

fn not_linux() -> String {
    format!(
        "Overlay 对话只在 Linux Core 上可用：当前平台是 {}",
        std::env::consts::OS
    )
}

/// 取某会话的代理。非 Linux 上建不了命名空间，直接报错而不是退回真实磁盘。
pub fn session_proxy(
    session_id: &str,
    _paths: ViewPaths,
) -> Result<std::sync::Arc<SessionProxy>, String> {
    Err(format!(
        "会话 {session_id} 的 Overlay 视图只在 Linux Core 上可用：当前平台是 {}",
        std::env::consts::OS
    ))
}

/// 已登记的代理：非 Linux 恒 `None`
pub fn existing_proxy(_session_id: &str) -> Option<std::sync::Arc<SessionProxy>> {
    None
}

/// 丢弃某会话的代理：非 Linux 上没有代理可回收
pub fn release_session(_session_id: &str) {}

/// 结束代理连接。非 Linux 上没有代理可回收——保留同签名让调用点不必按平台分支。
pub fn shutdown() {}

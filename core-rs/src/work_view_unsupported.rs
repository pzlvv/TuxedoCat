//! 非 Linux 平台：对话级 overlay 工作视图不可用（specs/043）。
//!
//! overlayfs 与非特权用户命名空间只在 Linux 上存在。这里编译出同签名类型，能力恒回
//! 不可用，让界面给出明确原因而不是静默降级。

use super::Capabilities;
use std::path::Path;

/// 非 Linux：不需要进命名空间，no-op。
pub fn enter() {}

/// 能力恒不可用，原因点名平台。
pub fn capabilities() -> Capabilities {
    Capabilities::unavailable("对话工作视图只在 Linux Core 上可用")
}

/// 占位类型：非 Linux 上不可构造。
pub struct WorkView;

impl WorkView {
    pub fn register(_workspace: &str, _session_id: &str) -> Result<Self, String> {
        Err("对话工作视图只在 Linux Core 上可用".to_string())
    }

    pub fn reopen(_workspace: &str, _session_id: &str) -> Result<Self, String> {
        Err("对话工作视图只在 Linux Core 上可用".to_string())
    }

    pub fn ensure_mounted(&mut self) -> Result<(), String> {
        Err("对话工作视图只在 Linux Core 上可用".to_string())
    }

    /// 只在测试与 Linux 实现里用；非 Linux 上 `ensure_mounted` 恒失败，没有调用方。
    #[allow(dead_code)]
    pub fn mount_point(&self) -> Option<std::path::PathBuf> {
        None
    }
}

/// 占位句柄：非 Linux 上永远取不到（`of` 恒 `None`），因此下面几个方法都没有调用方。
/// 保留是为了让两个平台实现同一组符号，`ToolContext` 的字段类型不必按平台分叉。
pub struct WorkViewHandle;

impl WorkViewHandle {
    pub fn of(_session_id: &str) -> Option<Self> {
        None
    }

    #[allow(dead_code)]
    pub fn to_view_path(&self, real: &Path) -> Result<std::path::PathBuf, String> {
        Ok(real.to_path_buf())
    }

    #[allow(dead_code)]
    pub fn to_real_path(&self, view: &Path) -> Result<std::path::PathBuf, String> {
        Ok(view.to_path_buf())
    }

    pub fn map_into_view(&self, real: &Path) -> Result<std::path::PathBuf, String> {
        Ok(real.to_path_buf())
    }

    pub fn mount_point(&self) -> std::path::PathBuf {
        std::path::PathBuf::new()
    }
}

pub fn release(_workspace: &str, _session_id: &str) {}

pub fn remove(_workspace: &str, _session_id: &str) -> Result<(), String> {
    Ok(())
}

/// 非 Linux 上永远不会被调用：`capabilities()` 恒回不可用，因此不会有会话归属为
/// `isolated`，Bash 的 bind 分支（`tools.rs` 的 `#[cfg(target_os = "linux")]`）也就
/// 走不到。保留这个签名是为了让两个平台实现同一组符号，调用方不必到处 `cfg`。
#[allow(dead_code)]
pub fn bind_view_onto_workspace(
    _mount_point: &Path,
    _workspace: &Path,
) -> Result<(), String> {
    Err("对话工作视图只在 Linux Core 上可用".to_string())
}


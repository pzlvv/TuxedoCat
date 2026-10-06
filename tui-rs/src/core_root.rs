//! Core 产物根目录定位（`src/tui/coreRoot.ts` + `src/host/standalone/coreBinary.ts` 的移植）。
//!
//! Core 的部署不在 TUI 里（独立安装程序，docs/tui-installer.md）。候选顺序（第一个能
//! 解析出 Core 二进制的胜出）：
//! 1. 环境变量 `TUXEDO_CAT_TUI_ROOT`（显式指定安装前缀）；
//! 2. 默认安装前缀 `~/.tuxedo-cat/tui`（安装程序的默认落点）；
//! 3. 可执行文件所在目录（自定义前缀下就地运行）；
//! 4. 可执行文件上一级（开发期：`target/release/` → 仓库根的 `resources/core/`）。
//!
//! 全部落空直接报错并给出安装指引——接线缺失不静默降级（DEVELOPMENT.md 第 12 章规则 1）。

use std::path::{Path, PathBuf};

use crate::settings::home_dir;

/// 显式指定安装前缀的环境变量（与 TUXEDO_CAT_CORE 同一命名族）。
pub const TUI_ROOT_ENV: &str = "TUXEDO_CAT_TUI_ROOT";

/// Core 可执行文件名（`src/config/project.json` 的 `core.binaryName`；Windows 带 `.exe`）。
pub fn core_binary_file_name() -> &'static str {
    if cfg!(windows) {
        "tuxedo-cat-core.exe"
    } else {
        "tuxedo-cat-core"
    }
}

/// 产物目录名：`<arch>-<platform>`（与 `corePlatformDir` 一致；Windows 带 `.exe` 的
/// 平台记为 win32）。
pub fn core_platform_dir() -> Option<&'static str> {
    if cfg!(target_arch = "x86_64") && cfg!(windows) {
        Some("x64-win32")
    } else if cfg!(target_arch = "aarch64") && cfg!(windows) {
        Some("arm64-win32")
    } else if cfg!(target_arch = "x86_64") && cfg!(target_os = "linux") {
        Some("x64-linux")
    } else if cfg!(target_arch = "aarch64") && cfg!(target_os = "linux") {
        Some("arm64-linux")
    } else {
        None
    }
}

/// 安装程序的默认安装前缀：`~/.tuxedo-cat/tui`。
pub fn default_install_prefix() -> PathBuf {
    home_dir().join(crate::settings::CONFIG_DIR_NAME).join("tui")
}

/// 候选根目录列表（可测试的纯函数；exe_dir 传入以便单测注入）。
pub fn root_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(from_env) = std::env::var(TUI_ROOT_ENV) {
        if !from_env.is_empty() {
            candidates.push(PathBuf::from(from_env));
        }
    }
    candidates.push(default_install_prefix());
    candidates.push(exe_dir.to_path_buf());
    candidates.push(exe_dir.parent().map(Path::to_path_buf).unwrap_or_else(|| exe_dir.to_path_buf()));
    candidates.dedup();
    candidates
}

/// 产物目录里的 Core 二进制路径（存在性不校验；`coreBinaryCandidates` 的简化版——
/// TUI 自身不在 asar 里，没有解包目录变体）。
pub fn core_binary_in(root: &Path) -> Option<PathBuf> {
    let dir = core_platform_dir()?;
    let path = root.join("resources").join("core").join(dir).join(core_binary_file_name());
    path.is_file().then_some(path)
}

/// 解析 Core 产物根：返回第一个含 Core 二进制的候选根与二进制路径。
/// 找不到时报错（附候选列表与安装指引）。
pub fn resolve_core_root(exe_dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let mut tried: Vec<String> = Vec::new();
    for candidate in root_candidates(exe_dir) {
        if !candidate.exists() {
            tried.push(format!("{} (不存在)", candidate.display()));
            continue;
        }
        match core_binary_in(&candidate) {
            Some(binary) => return Ok((candidate, binary)),
            None => tried.push(format!("{} (无 Core 产物)", candidate.display())),
        }
    }
    Err(format!(
        "未找到 Standalone Core 产物，TUI 无法启动。\n已尝试：{}\n请先运行安装程序（默认前缀 {}），或设置 {} 指向安装前缀；\n开发环境请先执行 npm run build:core。",
        tried.join("；"),
        default_install_prefix().display(),
        TUI_ROOT_ENV,
    ))
}

#[cfg(test)]
#[path = "core_root_tests.rs"]
mod tests;

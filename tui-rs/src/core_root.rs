//! Core 产物定位（部署布局：`<prefix>/share/<产品名>/<指纹>/`）。
//!
//! Core 的部署不在 TUI 里（独立安装程序，docs/features/tui-installer.md）。安装布局由
//! 安装器落位，前缀是**应用根**（unix 默认 `~/.local`，Windows `~/<configDir>`，
//! `configDir` 取 `src/config/project.json`）：
//!
//! ```text
//! <prefix>/share/<产品名>/<core.binaryName>[.exe] + fingerprint   # 按指纹的槽位
//! <prefix>/share/<产品名>/ripgrep/rg[.exe]                        # 全部槽位共享
//! <prefix>/share/<产品名>/tui[.exe]                               # 本程序
//! <prefix>/bin/<产品名> → ../share/<产品名>/tui                   # unix 启动链接
//! ```
//!
//! unix 上产品目录即 `~/.local/share/<产品名>/`（XDG 数据目录）。
//!
//! 候选根顺序（第一个能解析出 Core 二进制的胜出）：
//! 1. 环境变量 `<envPrefix>_TUI_ROOT`（显式指定部署前缀或仓库根）；
//! 2. 默认部署前缀（安装程序的默认落点）；
//! 3. 可执行文件所在目录（就地运行：本程序就在产品目录里）；
//! 4. 可执行文件的各级上级目录（开发期：`tui-rs/target/<profile>/` → 仓库根的
//!    `resources/core/<pkg>/`）。
//!
//! 每个候选根按两种形态解析，部署布局优先：`share/<产品名>/` 下任一「`fingerprint`
//! + Core 二进制都齐」的指纹槽位；否则当开发期仓库根（`resources/core/<pkg>/`）。
//! 全部落空直接报错并给出安装指引——接线缺失不静默降级（docs/architecture/principles.md规则 1）。

use std::path::{Path, PathBuf};

use crate::settings::home_dir;

/// 显式指定部署前缀的环境变量：名称取 `src/config/project.json` 的 `envPrefix`
/// （tui-rs/build.rs 构建期烧入），与 `CORE_ENV_VAR`（`<envPrefix>_CORE`）同一命名族。
pub const TUI_ROOT_ENV: &str = concat!(env!("TC_ENV_PREFIX"), "_TUI_ROOT");

/// 部署布局的产品目录名（`src/config/project.json` 的 `core.deployPrefix`，经
/// tui-rs/build.rs 构建期烧入——源码不持有产品字面量，企业版改名只动 project.json）。
pub const DEPLOY_PRODUCT_NAME: &str = env!("TC_DEPLOY_PREFIX");

/// 候选根向上回溯的层数上限：覆盖 `tui-rs/target/<profile>/`（2 层到仓库根）
/// 这类开发期路径，不无限上翻。
const MAX_ANCESTORS: usize = 5;

/// Core 可执行文件名（`src/config/project.json` 的 `core.binaryName`，经
/// tui-rs/build.rs 烧入；Windows 带 `.exe`）。
pub fn core_binary_file_name() -> &'static str {
    if cfg!(windows) {
        concat!(env!("TC_CORE_BINARY_NAME"), ".exe")
    } else {
        env!("TC_CORE_BINARY_NAME")
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

/// 部署布局的产品目录：`<部署前缀>/share/<产品名>/`。
pub fn product_dir_in(prefix: &Path) -> PathBuf {
    prefix.join("share").join(DEPLOY_PRODUCT_NAME)
}

/// 部署布局的共享 ripgrep：`<部署前缀>/share/<产品名>/ripgrep/rg[.exe]`。
///
/// Core 自己按「所在槽位的上一级目录里的 `ripgrep`」定位（core-rs/src/tools.rs），
/// TUI 运行时不消费这份路径，只在测试里断言布局；`#[cfg(test)]` 免得正常构建报
/// dead code。
#[cfg(test)]
pub(crate) fn shared_ripgrep_in(prefix: &Path) -> PathBuf {
    product_dir_in(prefix).join("ripgrep").join(ripgrep_file_name())
}

#[cfg(test)]
fn ripgrep_file_name() -> &'static str {
    if cfg!(windows) {
        "rg.exe"
    } else {
        "rg"
    }
}

/// 默认部署前缀（应用根，与安装程序同一落点：unix `~/.local`——产品目录即
/// `~/.local/share/<产品名>/`；Windows `~/<configDir>`，`configDir` 经
/// tui-rs/build.rs 从 `project.json` 烧入）。
pub fn default_install_prefix() -> PathBuf {
    let mut prefix = home_dir();
    if cfg!(windows) {
        prefix.push(env!("TC_CONFIG_DIR"));
    } else {
        prefix.push(".local");
    }
    prefix
}

/// 产品目录里可用的指纹槽位：`fingerprint` 与 Core 二进制都齐的子目录。
///
/// 多个版本并存时取排序最大的一员（指纹之间没有新旧语义，取哪个都正确，
/// 排序只为确定——同一台机器上两次启动不因目录遍历顺序漂移）。
pub fn core_slot_in(product_dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(product_dir).ok()?;
    let mut slots: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.is_dir()
                && path.join("fingerprint").is_file()
                && path.join(core_binary_file_name()).is_file()
        })
        .collect();
    slots.sort();
    slots.pop()
}

/// 候选根目录列表（可测试的纯函数；exe_dir 传入以便单测注入）。
///
/// 环境变量最前（显式指定压过一切默认），其后是默认前缀、exe 所在目录、exe 的
/// 各级上级（就地运行的两种形态 + 开发期回溯到仓库根）。重复路径去重。
pub fn root_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(from_env) = std::env::var(TUI_ROOT_ENV) {
        if !from_env.is_empty() {
            candidates.push(PathBuf::from(from_env));
        }
    }
    candidates.push(default_install_prefix());
    candidates.push(exe_dir.to_path_buf());
    let mut ancestor = exe_dir.to_path_buf();
    for _ in 0..MAX_ANCESTORS {
        match ancestor.parent() {
            Some(parent) => {
                candidates.push(parent.to_path_buf());
                ancestor = parent.to_path_buf();
            }
            None => break,
        }
    }
    candidates.dedup();
    candidates
}

/// 候选根里的 Core 二进制（两种形态，部署布局优先；可测试的纯读函数）。
fn core_binary_in(root: &Path) -> Option<PathBuf> {
    // 部署布局：`<root>/share/<产品名>/<指纹>/<core.binaryName>[.exe]`
    if let Some(core) = core_slot_in(&product_dir_in(root)) {
        return Some(core.join(core_binary_file_name()));
    }
    // 开发期仓库布局：`<root>/resources/core/<arch-platform>/<core.binaryName>[.exe]`
    let dir = core_platform_dir()?;
    let path = root.join("resources").join("core").join(dir).join(core_binary_file_name());
    path.is_file().then_some(path)
}

/// 解析 Core 产物：返回命中的候选根与二进制路径。
///
/// 找不到时报错（附候选列表与安装指引）。命中部署布局时候选根是部署前缀
/// （传给 Core 作 `extensionPath`，Core 自带 ripgrep 优先，不依赖这个根）；命中
/// 开发期布局时候选根是仓库根（Core 据此兜底仓库里的 ripgrep 产物）。
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
        "未找到 Standalone Core 产物，TUI 无法启动。\n已尝试：{}\n请先运行安装程序（默认前缀 {}），或设置 {} 指向部署前缀；\n开发环境请先执行 npm run build:core。",
        tried.join("；"),
        default_install_prefix().display(),
        TUI_ROOT_ENV,
    ))
}

#[cfg(test)]
#[path = "core_root_tests.rs"]
mod tests;

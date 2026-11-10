//! 随 Core 分发的内置搜索工具：`rg`（ripgrep）与 `fd`。
//!
//! 两份产物都与 Core 可执行文件一起分发（`docs/core/standalone-core.md` 第 3.1 节），
//! 消费方有三处，全部走本模块的同一份解析（铁律 4.5：派生逻辑一份纯函数）：
//!
//! 1. `Grep` / `Glob` 以绝对路径 spawn `rg`（`tools.rs::ripgrep_path`）；
//! 2. 工具 shell 的 PATH 前置这两个工具所在目录（`shell_env.rs`），模型因此能直接
//!    在 `Bash` 里用 `rg` / `fd`（`docs/core/standalone-core.md` 第 3.2.1 节）；
//! 3. 本机与远端部署共享同一套目录名（`src/host/standalone/coreBinary.ts` 是 TS 侧的同源登记表）。
//!
//! 为什么单独成模块：`tools.rs` 已经依赖 `shell_env`（注入 PATH 给子进程），若
//! `shell_env` 反过来依赖 `tools` 就形成环形概念依赖。本模块只依赖 `std` 与
//! `config::extension_path()`，两个消费者各自 `use` 它。

use std::path::{Path, PathBuf};

use crate::config;

/// 一件随 Core 分发的内置工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BundledTool {
    /// 产物目录名：仓库里是 `resources/<dir>/<arch>-<platform>/`，Core 产物里是
    /// `<Core exe 目录>/<dir>/`，部署布局里是 `share/<产品名>/<dir>/`
    pub dir: &'static str,
    /// 可执行名（不含平台扩展名）
    pub stem: &'static str,
}

/// 全部内置工具，顺序即 PATH 前置顺序（`rg` 在前：它是 `Grep` / `Glob` 的运行时依赖）。
pub const BUNDLED_TOOLS: [BundledTool; 2] = [
    BundledTool {
        dir: "ripgrep",
        stem: "rg",
    },
    BundledTool {
        dir: "fd",
        stem: "fd",
    },
];

/// 当前平台 / 架构的产物目录名（`<arch>-<platform>`，与 `resources/ripgrep/` 一致）。
pub fn platform_dir() -> String {
    let platform = if cfg!(windows) { "win32" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{arch}-{platform}")
}

/// 可执行文件名（Windows 加 `.exe`）
pub fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Core 可执行文件所在目录：部署槽位（自带共享资源的定位基准）。
///
/// 部署单元是「指纹槽位里的 Core 可执行文件 + 产品目录里与全部槽位共享的工具目录」——
/// 安装器 / SSH 引导把 `rg` / `fd` 落在 `share/<产品名>/<dir>/`，Core 从自己所在槽位的
/// 上一级目录定位它们（`docs/core/standalone-core.md` 第 3.1 节）。Core 因此不依赖宿主的
/// `extensionPath` 定位自己的产物。
pub fn core_executable_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// 某工具的候选路径，按优先级排列（纯函数，便于用例锁死顺序）：
/// 1. Core 自己槽位里的自带位（`<Core 可执行文件目录>/<dir>/`）：本地打包布局，
///    构建脚本把工具与可执行文件落在一起（`resources/<core.resourceDir>/<dir>/<tool>/`，
///    打包后随 asarUnpack 解包，Rust 的 `Path::exists` 看不进 asar，只有这条能用）；
/// 2. 部署布局的共享位（`<Core 可执行文件目录>/../<dir>/`：槽位上一级的产品目录里，
///    全部指纹槽位共享一份）；
/// 3. 宿主 `extensionPath`（本机开发期兜底：直接用 `cargo run` / `cargo test` 的 Core
///    进程、或从仓库里跑宿主时，产物在 `resources/` / `dist/resources/`）。
pub fn tool_candidates(
    tool: BundledTool,
    core_dir: Option<&Path>,
    extension_path: Option<&str>,
) -> Vec<PathBuf> {
    let exe = exe_name(tool.stem);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = core_dir {
        // 本地打包布局：工具与 Core 可执行文件同目录下的 `<dir>/` 子目录
        candidates.push(dir.join(tool.dir).join(&exe));
        // 槽位上一级：`share/<产品名>/<指纹>/` 的上一级是产品目录，共享工具在那里
        if let Some(parent) = dir.parent() {
            candidates.push(parent.join(tool.dir).join(&exe));
        }
    }
    if let Some(extension_path) = extension_path {
        // 逐段 join（不要用 `"dist/resources/ripgrep"` 这种含 `/` 的单段字符串）：
        // Windows 上 `path.join` 产出的是反斜杠，错误文案里的命令行才能与
        // `path.join(...)` 的产物完全一致。
        let sub_dir = platform_dir();
        let base = Path::new(extension_path);
        candidates.push(
            base.join("dist")
                .join("resources")
                .join(tool.dir)
                .join(&sub_dir)
                .join(&exe),
        );
        candidates.push(
            base.join("resources")
                .join(tool.dir)
                .join(&sub_dir)
                .join(&exe),
        );
    }
    candidates
}

/// 解析某工具的产物路径；候选都不存在时返回 `None`（调用方决定回退或跳过）。
pub fn resolve_tool(
    tool: BundledTool,
    core_dir: Option<&Path>,
    extension_path: Option<&str>,
) -> Option<PathBuf> {
    tool_candidates(tool, core_dir, extension_path)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// 当前进程视角下某工具的产物路径（读进程自己的可执行文件目录与宿主 `extensionPath`）。
pub fn resolve(tool: BundledTool) -> Option<PathBuf> {
    let core_dir = core_executable_dir();
    let extension_path = config::extension_path().ok();
    resolve_tool(tool, core_dir.as_deref(), extension_path.as_deref())
}

/// 工具 shell 的 PATH 前置目录（按 [`BUNDLED_TOOLS`] 顺序，同目录去重）。
///
/// 缺失的工具**整条跳过**：注入侧若在这里报错，整条 `Bash` 命令都会失败，连带上百条与
/// 搜索无关的命令一起用不了，真正的问题反而被埋在后面。缺工具的失败信号由命令本身发出
/// （`rg: command not found` 直接进工具结果，模型与用户立刻可见），属故障暴露路径而非
/// 回退路径（`docs/core/standalone-core.md` 第 3.2.1 节）。
pub fn search_path_dirs(core_dir: Option<&Path>, extension_path: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for tool in BUNDLED_TOOLS {
        let Some(resolved) = resolve_tool(tool, core_dir, extension_path) else {
            continue;
        };
        let Some(parent) = resolved.parent() else {
            continue;
        };
        let parent = parent.to_path_buf();
        if !dirs.contains(&parent) {
            dirs.push(parent);
        }
    }
    dirs
}

/// 当前进程视角下的 PATH 前置目录（`shell_env` 的注入源）。
pub fn search_path_dirs_now() -> Vec<PathBuf> {
    let core_dir = core_executable_dir();
    let extension_path = config::extension_path().ok();
    search_path_dirs(core_dir.as_deref(), extension_path.as_deref())
}

/// 把一个目录表达成 shell 自己的 PATH 形式。
///
/// 只有 Windows 需要转换：Git Bash / MSYS2 / Cygwin 认 POSIX 列表（`/c/Users/...`），
/// 把 `C:\Users\...` 直接塞进去会被当成「一个含冒号的怪条目」，`command -v rg` 找不到。
/// 规则：盘符路径 `C:\a\b` → `/c/a/b`；UNC `\\server\share\x` → `//server/share/x`；
/// 已是 POSIX 形式的原样返回（用户的启动文件里就写着这种）。
///
/// 转不了的条目返回 `None`——调用方跳过它，不把坏条目注入 PATH。
pub fn shell_form(dir: &Path) -> Option<String> {
    let text = dir.to_string_lossy();
    if !cfg!(windows) {
        return Some(text.to_string());
    }
    let bytes = text.as_bytes();
    // 盘符前缀：`C:\` / `C:/`
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = text[2..].replace('\\', "/");
        let rest = if rest.starts_with('/') {
            rest
        } else {
            format!("/{rest}")
        };
        return Some(format!("/{drive}{rest}"));
    }
    // UNC：`\\server\share\x` → `//server/share/x`
    if text.starts_with(r"\\") {
        return Some(text.replace('\\', "/"));
    }
    // 已是 POSIX 形式
    if text.starts_with('/') {
        return Some(text.to_string());
    }
    None
}

/// 把一个目录表达成原生进程的 PATH 形式（Windows 分隔符、无 POSIX 前缀）。
///
/// 非 Windows 上原生形式就是 POSIX 形式，直接原样返回；Windows 上把已经是 POSIX
/// 形式的条目（`/c/Users/...`）还原成 `C:\Users\...`，还原不了的条目返回 `None`。
pub fn native_form(dir: &Path) -> Option<String> {
    let text = dir.to_string_lossy();
    if !cfg!(windows) {
        return Some(text.to_string());
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b'/' && bytes[1].is_ascii_alphabetic() {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = text[2..].replace('/', "\\");
        return Some(format!("{drive}:{rest}"));
    }
    Some(text.to_string())
}

#[cfg(test)]
#[path = "bundled_tools_tests.rs"]
mod tests;

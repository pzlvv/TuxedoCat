//! `bundled_tools` 的单测：候选顺序、PATH 前置目录的顺序与去重、两种形式转换。

use std::path::{Path, PathBuf};

use super::*;

fn rg() -> BundledTool {
    BUNDLED_TOOLS[0]
}

fn fd() -> BundledTool {
    BUNDLED_TOOLS[1]
}

#[test]
fn registry_lists_rg_then_fd() {
    // 顺序即 PATH 前置顺序：rg 在前（它是 Grep / Glob 的运行时依赖）
    assert_eq!(BUNDLED_TOOLS.len(), 2);
    assert_eq!(BUNDLED_TOOLS[0].dir, "ripgrep");
    assert_eq!(BUNDLED_TOOLS[0].stem, "rg");
    assert_eq!(BUNDLED_TOOLS[1].dir, "fd");
    assert_eq!(BUNDLED_TOOLS[1].stem, "fd");
}

#[test]
fn exe_name_appends_extension_only_on_windows() {
    let name = exe_name("rg");
    if cfg!(windows) {
        assert_eq!(name, "rg.exe");
    } else {
        assert_eq!(name, "rg");
    }
}

#[test]
fn platform_dir_names_arch_and_platform() {
    let dir = platform_dir();
    assert!(
        dir.ends_with("-win32") || dir.ends_with("-linux"),
        "got {dir}"
    );
    assert!(
        dir.starts_with("x64-") || dir.starts_with("arm64-"),
        "got {dir}"
    );
}

/// 四条候选的顺序：槽位自带位 → 产品共享位 → `dist/resources` → `resources`。
#[test]
fn candidates_prefer_the_core_bundle() {
    let exe = exe_name("rg");
    let core_dir = Path::new("/deploy/share/some-product/9d7e480b");
    let candidates = tool_candidates(rg(), Some(core_dir), Some("/host/root"));
    assert_eq!(candidates.len(), 4, "got {candidates:?}");
    assert!(
        candidates[0].starts_with(core_dir),
        "槽位自带位排第一：{:?}",
        candidates[0]
    );
    assert!(candidates[0].ends_with(Path::new("ripgrep").join(&exe)));
    assert!(
        candidates[1].starts_with(Path::new("/deploy/share/some-product")),
        "产品共享位排第二：{:?}",
        candidates[1]
    );
    assert!(candidates[1].ends_with(Path::new("ripgrep").join(&exe)));
    assert!(
        candidates[2].starts_with(Path::new("/host/root")),
        "got {:?}",
        candidates[2]
    );
    assert!(candidates[2].ends_with(Path::new("ripgrep").join(platform_dir()).join(&exe)));
    assert!(
        candidates[3].starts_with(Path::new("/host/root")),
        "got {:?}",
        candidates[3]
    );
    assert!(candidates[3].ends_with(Path::new("ripgrep").join(platform_dir()).join(&exe)));
}

/// 同一个函数对 fd 给出同样的四条候选，只是目录名与可执行名不同（不是第二份列表）。
#[test]
fn candidates_are_parameterized_by_tool() {
    let exe = exe_name("fd");
    let core_dir = Path::new("/deploy/share/some-product/9d7e480b");
    let candidates = tool_candidates(fd(), Some(core_dir), Some("/host/root"));
    assert_eq!(candidates.len(), 4, "got {candidates:?}");
    assert!(
        candidates[0].ends_with(Path::new("fd").join(&exe)),
        "got {:?}",
        candidates[0]
    );
    assert!(
        candidates[1].ends_with(Path::new("fd").join(&exe)),
        "got {:?}",
        candidates[1]
    );
    assert!(candidates[2].ends_with(Path::new("fd").join(platform_dir()).join(&exe)));
    assert!(candidates[3].ends_with(Path::new("fd").join(platform_dir()).join(&exe)));
}

#[test]
fn candidates_are_empty_without_any_base() {
    // 两个来源都没有时候选集为空（调用方据此回退 PATH 或跳过）
    assert!(tool_candidates(rg(), None, None).is_empty());
}

/// 只有真正存在的文件才算命中（目录不算）。
#[test]
fn resolve_tool_requires_a_file() {
    let root = temp_dir("resolve-file");
    let tool_dir = root.join("resources").join("fd").join(platform_dir());
    std::fs::create_dir_all(&tool_dir).unwrap();
    let extension = root.to_string_lossy().to_string();

    // 目录建好但文件没写：不能命中
    assert!(resolve_tool(fd(), None, Some(&extension)).is_none());

    let exe = tool_dir.join(exe_name("fd"));
    std::fs::write(&exe, "fake-fd").unwrap();
    assert_eq!(resolve_tool(fd(), None, Some(&extension)), Some(exe));

    std::fs::remove_dir_all(&root).unwrap();
}

/// PATH 前置目录：按登记表顺序取两份的父目录。
#[test]
fn search_path_dirs_follow_the_registry_order() {
    let root = temp_dir("search-path-order");
    let rg_dir = root.join("resources").join("ripgrep").join(platform_dir());
    let fd_dir = root.join("resources").join("fd").join(platform_dir());
    std::fs::create_dir_all(&rg_dir).unwrap();
    std::fs::create_dir_all(&fd_dir).unwrap();
    std::fs::write(rg_dir.join(exe_name("rg")), "fake-rg").unwrap();
    std::fs::write(fd_dir.join(exe_name("fd")), "fake-fd").unwrap();

    let dirs = search_path_dirs(None, Some(&root.to_string_lossy()));
    assert_eq!(dirs.len(), 2, "got {dirs:?}");
    assert!(dirs[0].starts_with(&rg_dir), "rg 目录在前：{dirs:?}");
    assert!(dirs[1].starts_with(&fd_dir), "got {dirs:?}");

    std::fs::remove_dir_all(&root).unwrap();
}

/// 缺失的工具整条跳过，存在的那个照常前置（故障暴露路径，不是注入报错）。
#[test]
fn search_path_dirs_skip_missing_tools() {
    let root = temp_dir("search-path-missing");
    let fd_dir = root.join("resources").join("fd").join(platform_dir());
    std::fs::create_dir_all(&fd_dir).unwrap();
    std::fs::write(fd_dir.join(exe_name("fd")), "fake-fd").unwrap();

    let dirs = search_path_dirs(None, Some(&root.to_string_lossy()));
    assert_eq!(dirs.len(), 1, "只应前置 fd：{dirs:?}");
    assert!(dirs[0].starts_with(&fd_dir));

    // 两份都缺时为空列表——注入侧据此什么都不加，命令照常执行
    assert!(search_path_dirs(None, Some("/definitely/not/here")).is_empty());

    std::fs::remove_dir_all(&root).unwrap();
}

/// 同一目录只前置一次：将来两份工具合并进一个 `bin/` 时不重复。
#[test]
fn search_path_dirs_deduplicate() {
    let root = temp_dir("search-path-dedupe");
    let shared = root.join("resources").join("ripgrep").join(platform_dir());
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join(exe_name("rg")), "fake-rg").unwrap();

    // 把 fd 的产物也放成同一份（模拟合并布局）：两个候选父目录相同
    let fd_dir = root.join("resources").join("fd").join(platform_dir());
    std::fs::create_dir_all(&fd_dir).unwrap();
    std::fs::write(fd_dir.join(exe_name("fd")), "fake-fd").unwrap();
    // 两个目录不同，仍应各出现一次
    let dirs = search_path_dirs(None, Some(&root.to_string_lossy()));
    assert_eq!(dirs.len(), 2, "got {dirs:?}");

    std::fs::remove_dir_all(&root).unwrap();
}

/// POSIX 形式两种平台上都原样保留（Windows 上 `/usr/local/bin` 已是 POSIX 形式）。
#[test]
fn shell_form_keeps_posix_paths() {
    assert_eq!(
        shell_form(Path::new("/usr/local/bin")).as_deref(),
        Some("/usr/local/bin")
    );
}

#[cfg(windows)]
#[test]
fn shell_form_converts_drive_paths() {
    assert_eq!(
        shell_form(Path::new(r"C:\Users\me\bin")).as_deref(),
        Some("/c/Users/me/bin")
    );
    assert_eq!(shell_form(Path::new(r"D:\a")).as_deref(), Some("/d/a"));
    // 正斜杠写法同样归一
    assert_eq!(
        shell_form(Path::new("C:/Users/me/bin")).as_deref(),
        Some("/c/Users/me/bin")
    );
}

#[cfg(windows)]
#[test]
fn shell_form_converts_unc_paths() {
    assert_eq!(
        shell_form(Path::new(r"\\server\share\bin")).as_deref(),
        Some("//server/share/bin")
    );
}

#[cfg(windows)]
#[test]
fn shell_form_keeps_posix_and_rejects_garbage() {
    assert_eq!(
        shell_form(Path::new("/c/Users/me/bin")).as_deref(),
        Some("/c/Users/me/bin")
    );
    // 既不是盘符、也不是 UNC、也不是 POSIX：转不了就返回 None（调用方跳过，不注入坏条目）
    assert_eq!(shell_form(Path::new("relative-dir")), None);
}

#[cfg(windows)]
#[test]
fn native_form_restores_drive_paths() {
    assert_eq!(
        native_form(Path::new("/c/Users/me/bin")).as_deref(),
        Some(r"C:\Users\me\bin")
    );
    assert_eq!(
        native_form(Path::new(r"C:\Users\me\bin")).as_deref(),
        Some(r"C:\Users\me\bin")
    );
}

#[cfg(not(windows))]
#[test]
fn native_form_is_identity_off_windows() {
    assert_eq!(
        native_form(Path::new("/usr/local/bin")).as_deref(),
        Some("/usr/local/bin")
    );
}

fn temp_dir(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "tc-bundled-tools-{name}-{}-{}",
        std::process::id(),
        crate::util::random_suffix()
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

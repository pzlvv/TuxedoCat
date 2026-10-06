//! 产物定位测试：候选顺序与平台目录名。

use std::path::PathBuf;

use super::*;

#[test]
fn platform_dir_matches_build_matrix() {
    let expected = if cfg!(target_arch = "x86_64") && cfg!(windows) {
        Some("x64-win32")
    } else if cfg!(target_arch = "aarch64") && cfg!(windows) {
        Some("arm64-win32")
    } else if cfg!(target_arch = "x86_64") && cfg!(target_os = "linux") {
        Some("x64-linux")
    } else if cfg!(target_arch = "aarch64") && cfg!(target_os = "linux") {
        Some("arm64-linux")
    } else {
        None
    };
    assert_eq!(core_platform_dir(), expected);
}

#[test]
fn candidates_follow_documented_order() {
    let exe_dir = PathBuf::from("/opt/tui");
    let candidates = root_candidates(&exe_dir);
    // 环境变量候选在最前（本测试进程没设它），其次是默认前缀、exe 目录、上一级
    assert!(!candidates.is_empty());
    assert!(candidates.contains(&default_install_prefix()));
    assert!(candidates.contains(&exe_dir));
    assert!(candidates.contains(&PathBuf::from("/opt")));
}

#[test]
fn resolve_reports_all_candidates_on_failure() {
    // 指向一个不存在的根：报错要列出候选与指引，不静默降级
    std::env::set_var(TUI_ROOT_ENV, "/definitely/not/here");
    let error = resolve_core_root(&PathBuf::from("/also/not/here")).unwrap_err();
    std::env::remove_var(TUI_ROOT_ENV);
    assert!(error.contains("未找到 Standalone Core 产物"));
    assert!(error.contains("/definitely/not/here"));
    assert!(error.contains("npm run build:core"));
}

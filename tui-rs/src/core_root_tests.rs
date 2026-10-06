//! 产物定位测试：候选顺序、部署布局的槽位解析与开发期仓库布局回退。

use std::path::{Path, PathBuf};

use super::*;

/// 建一个一次性临时目录（测试自清理交给系统临时目录策略，不互相干扰）
fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tuxedo-core-root-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 布一个指纹槽位：`fingerprint` + Core 二进制都齐
fn write_slot(product_dir: &Path, fingerprint: &str) {
    let slot = product_dir.join(fingerprint);
    std::fs::create_dir_all(&slot).unwrap();
    std::fs::write(slot.join("fingerprint"), format!("{fingerprint}\n")).unwrap();
    std::fs::write(slot.join(core_binary_file_name()), "fake-core").unwrap();
}

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
    // 环境变量候选在最前（本测试进程没设它），其次是默认前缀、exe 目录、各级上级
    assert!(!candidates.is_empty());
    assert!(candidates.contains(&default_install_prefix()));
    assert!(candidates.contains(&exe_dir));
    // 上级逐层回溯（有上限）：`/opt`、`/` 都在候选里
    assert!(candidates.contains(&PathBuf::from("/opt")));
    assert!(candidates.contains(&PathBuf::from("/")));
    // 去重：exe_dir 若恰是默认前缀不重复出现
    let unique_len = candidates.len();
    let mut sorted = candidates.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(unique_len, sorted.len());
}

#[test]
fn slot_resolution_requires_complete_artifacts() {
    let root = temp_root("slot");
    let product_dir = product_dir_in(&root);
    // 缺指纹的目录不是槽位（半截产物不接）
    let half = product_dir.join("deadbeef");
    std::fs::create_dir_all(&half).unwrap();
    std::fs::write(half.join(core_binary_file_name()), "fake-core").unwrap();
    assert_eq!(core_slot_in(&product_dir), None);
    // 补上指纹即成槽位
    write_slot(&product_dir, "deadbeef");
    let slot = core_slot_in(&product_dir).unwrap();
    assert_eq!(slot, product_dir.join("deadbeef"));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn slot_resolution_is_deterministic_across_versions() {
    let root = temp_root("slot-multi");
    let product_dir = product_dir_in(&root);
    write_slot(&product_dir, "aaaa");
    write_slot(&product_dir, "ffff");
    let slot = core_slot_in(&product_dir).unwrap();
    assert_eq!(slot, product_dir.join("ffff"));
    // 再读一遍结果一致（目录遍历顺序不漂移）
    assert_eq!(core_slot_in(&product_dir).unwrap(), slot);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn deployment_layout_wins_over_repo_layout() {
    let root = temp_root("both");
    // 同一根下两种形态都布好：部署布局（share/<产品名>/<指纹>）优先
    let product_dir = product_dir_in(&root);
    write_slot(&product_dir, "9d7e480b");
    let repo_dir = root.join("resources").join("core").join(core_platform_dir().unwrap());
    std::fs::create_dir_all(&repo_dir).unwrap();
    std::fs::write(repo_dir.join(core_binary_file_name()), "fake-core").unwrap();
    assert_eq!(core_binary_in(&root).unwrap(), product_dir.join("9d7e480b").join(core_binary_file_name()));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn repo_layout_resolves_for_development() {
    let root = temp_root("repo");
    let repo_dir = root.join("resources").join("core").join(core_platform_dir().unwrap());
    std::fs::create_dir_all(&repo_dir).unwrap();
    std::fs::write(repo_dir.join(core_binary_file_name()), "fake-core").unwrap();
    assert_eq!(core_binary_in(&root).unwrap(), repo_dir.join(core_binary_file_name()));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn shared_ripgrep_lives_beside_slots() {
    let prefix = Path::new("/usr/local/bin");
    let rg = shared_ripgrep_in(prefix);
    assert!(rg.starts_with(product_dir_in(prefix)));
    assert!(rg.to_string_lossy().contains("ripgrep"));
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

//! 依赖目录与单文件本地配置策略（specs/037 FR-010）

use std::path::{Path, PathBuf};

use crate::branch::deps::{
    describe_local_configs, link_local_configs, probe_dep_strategy, ConfigLink, DepStrategy,
    MountedDep, SkipDeps, KNOWN_DEP_DIRS, LOCAL_CONFIG_FILES,
};
use crate::test_support::GitSandbox;

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("branch-deps-{name}-{}", crate::util::unique_id("t")));
    std::fs::create_dir_all(&root).expect("create temp root");
    root
}

/// `SkipDeps` 装配是空操作，`describe()` 报 skip 档（全平台）
#[test]
fn skip_deps_is_a_no_op() {
    let root = temp_root("skip");
    let repo = root.join("repo");
    let worktree = root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&repo).expect("repo");
    std::fs::create_dir_all(&worktree).expect("worktree");
    std::fs::create_dir_all(repo.join("node_modules")).expect("node_modules");

    let strategy = SkipDeps;
    let mounted = strategy
        .install(&repo, &worktree, "ellen-k3f")
        .expect("skip install never fails");
    assert!(mounted.is_empty(), "SkipDeps must not mount anything");
    assert!(
        !worktree.join("node_modules").exists(),
        "SkipDeps must not create dependency directories"
    );
    strategy.uninstall(&mounted).expect("skip uninstall never fails");
    let policy = strategy.describe(&mounted);
    assert_eq!(policy.strategy, "skip");
    assert!(policy.mounted.is_empty());
    assert!(
        policy.prompt_line().contains("not installed"),
        "skip 档提示应说明需自行安装：{}",
        policy.prompt_line()
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// 已知依赖目录表与配置名单非空且不重复（模块契约的一行断言）
#[test]
fn known_tables_are_sane() {
    assert!(!KNOWN_DEP_DIRS.is_empty());
    assert!(!LOCAL_CONFIG_FILES.is_empty());
    let mut deps = KNOWN_DEP_DIRS.to_vec();
    deps.sort_unstable();
    deps.dedup();
    assert_eq!(deps.len(), KNOWN_DEP_DIRS.len(), "duplicate dependency dir names");
    let mut files = LOCAL_CONFIG_FILES.to_vec();
    files.sort_unstable();
    files.dedup();
    assert_eq!(files.len(), LOCAL_CONFIG_FILES.len(), "duplicate config names");
}

/// 装配是进程内一次判定（非特权的测试进程必然得到 `SkipDeps`，
/// 有 `CAP_SYS_ADMIN` / userns root 时得到 `OverlayDeps`）
#[test]
fn probe_assembles_a_strategy_once() {
    let strategy = probe_dep_strategy();
    let policy = strategy.describe(&[]);
    assert!(
        policy.strategy == "skip" || policy.strategy == "overlay",
        "unknown strategy {}",
        policy.strategy
    );
    let again = probe_dep_strategy();
    assert_eq!(
        again.describe(&[]).strategy,
        policy.strategy,
        "probe must be cached (one judgement per process)"
    );
}

// ==================== 单文件本地配置（全平台） ====================

/// 被 `.gitignore` 忽略的 `.env`：worktree 内共享，内容与主工作区一致
///
/// 共享有两种落法：**符号链接**（正常路径）或**创建时复制**（符号链接失败时的一档
/// 回退——Windows 未启用开发者模式 / 非管理员时 `symlink_file` 返回
/// `ERROR_PRIVILEGE_NOT_HELD`）。两者都是设计允许的档位，所以断言按实际档位分支，
/// 而不是硬要求符号链接；两条分支各自的独有性质分开断。
#[test]
fn ignored_local_config_is_linked() {
    let sandbox = GitSandbox::new("deps-link");
    sandbox.write(".gitignore", ".env\n");
    sandbox.commit_all("ignore env");
    sandbox.write(".env", "TOKEN=1\n");
    let worktree = sandbox.root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&worktree).expect("worktree");

    let linked = link_local_configs(&sandbox.workspace, &worktree);
    let entry = linked
        .iter()
        .find(|entry| entry.name == ".env")
        .expect(".env should be shared");
    let content = std::fs::read_to_string(worktree.join(".env")).expect("read shared .env");
    assert_eq!(content, "TOKEN=1\n");

    let meta = worktree.join(".env").symlink_metadata().expect("lstat");
    match entry.mode {
        ConfigLink::Linked => {
            assert!(meta.file_type().is_symlink(), "Linked means a real symlink");
            // 链接的独有性质：主工作区原子替换（tmp + rename）后，分支立刻读到新值
            let temp = sandbox.workspace.join(".env.tmp");
            std::fs::write(&temp, "TOKEN=2\n").expect("write temp");
            std::fs::rename(&temp, sandbox.workspace.join(".env")).expect("atomic replace");
            let updated =
                std::fs::read_to_string(worktree.join(".env")).expect("read updated link");
            assert_eq!(updated, "TOKEN=2\n", "symlink must follow atomic replacement");
        }
        ConfigLink::Copied => {
            assert!(
                !meta.file_type().is_symlink(),
                "Copied means a plain file, not a link"
            );
            // 复制的独有性质：分支拿到的是创建时的快照，主工作区后续改动**不**跟进来
            // （这正是回退档位的代价，写进系统提示让模型知道，不假装它是链接）
            std::fs::write(sandbox.workspace.join(".env"), "TOKEN=3\n").expect("edit main .env");
            let stale = std::fs::read_to_string(worktree.join(".env")).expect("read copied .env");
            assert_eq!(
                stale, "TOKEN=1\n",
                "copied config is a snapshot; it must not track later main-workspace edits"
            );
        }
    }

    // 该分支 worktree 内 `git status` 不出现该名字（链接与复制都成立）
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args(["status", "--porcelain"])
        .env("GIT_CONFIG_GLOBAL", &sandbox.config_stub)
        .env("GIT_CONFIG_SYSTEM", &sandbox.config_stub)
        .output()
        .expect("git status in worktree");
    let status = String::from_utf8_lossy(&status.stdout);
    assert!(
        !status.contains(".env"),
        "linked config must stay out of the branch status: {status}"
    );
}

/// 未被 `.gitignore` 忽略的配置不链接（会以未跟踪文件污染分支 `git status`）
#[test]
fn non_ignored_local_config_is_skipped() {
    let sandbox = GitSandbox::new("deps-not-ignored");
    sandbox.write(".env", "TOKEN=1\n");
    let worktree = sandbox.root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&worktree).expect("worktree");

    let linked = link_local_configs(&sandbox.workspace, &worktree);
    assert!(
        linked.iter().all(|entry| entry.name != ".env"),
        "non-ignored config must not be linked: {linked:?}"
    );
    assert!(!worktree.join(".env").exists(), "nothing should land in the worktree");
}

/// 已被 git 跟踪的配置不链接（worktree 里本来就有）
#[test]
fn tracked_local_config_is_skipped() {
    let sandbox = GitSandbox::new("deps-tracked");
    sandbox.write(".gitignore", ".env\n");
    sandbox.write(".env", "TOKEN=1\n");
    sandbox.git(&["add", "-f", ".env"]);
    sandbox.commit_all("track env");
    let worktree = sandbox.root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&worktree).expect("worktree");
    // 模拟「worktree 里本就有该文件」（git worktree add 会带出已跟踪内容）
    sandbox.write(".env", "TOKEN=1\n");
    std::fs::write(worktree.join(".env"), "TOKEN=1\n").expect("copy tracked env");

    let linked = link_local_configs(&sandbox.workspace, &worktree);
    assert!(
        linked.iter().all(|entry| entry.name != ".env"),
        "tracked config must not be linked: {linked:?}"
    );
    let meta = worktree.join(".env").symlink_metadata().expect("lstat");
    assert!(!meta.file_type().is_symlink(), "tracked file must stay a regular file");
}

/// 主工作区没有该文件时不处理
#[test]
fn missing_local_config_is_skipped() {
    let sandbox = GitSandbox::new("deps-missing");
    let worktree = sandbox.root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&worktree).expect("worktree");
    let linked = link_local_configs(&sandbox.workspace, &worktree);
    assert!(linked.is_empty(), "nothing to share: {linked:?}");
}

/// 档位进系统提示（链接 / 复制分开说明）
#[test]
fn describe_reports_link_and_copy_modes() {
    assert_eq!(describe_local_configs(&[]), None);
    let linked = describe_local_configs(&[crate::branch::deps::LinkedConfig {
        name: ".env".to_string(),
        mode: ConfigLink::Linked,
    }])
    .expect("linked description");
    assert!(linked.contains(".env"));
    assert!(linked.contains("symlink"));
    let copied = describe_local_configs(&[crate::branch::deps::LinkedConfig {
        name: ".npmrc".to_string(),
        mode: ConfigLink::Copied,
    }])
    .expect("copied description");
    assert!(copied.contains(".npmrc"));
    assert!(copied.contains("copied"));
}

// ==================== overlay 真挂载（仅 Linux） ====================

/// overlay 可用性探测：非特权进程预期失败（这是设计允许的 `SkipDeps` 档）
#[cfg(target_os = "linux")]
fn overlay_available() -> bool {
    probe_dep_strategy().describe(&[]).strategy == "overlay"
}

/// 真实挂载用例：only-existing-dirs / upper 隔离 / 卸载
///
/// 不可用时按仓库既有 `skip:` 口径打印原因（不算通过）。
#[cfg(target_os = "linux")]
#[test]
fn overlay_mounts_only_existing_dependency_dirs() {
    if !overlay_available() {
        println!("skip: overlayfs 不可用（Core 进程无 CAP_SYS_ADMIN 或内核不支持）");
        return;
    }
    let sandbox = GitSandbox::new("deps-overlay");
    let worktree = sandbox.root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&worktree).expect("worktree");
    // 只有 node_modules 存在：target 不该被挂（不创建空 lower，AC-27）
    std::fs::create_dir_all(sandbox.workspace.join("node_modules")).expect("node_modules");
    std::fs::write(
        sandbox.workspace.join("node_modules").join("left-pad.txt"),
        "from-main\n",
    )
    .expect("write dep file");

    let strategy = crate::branch::deps::OverlayDeps;
    let mounted = strategy
        .install(&sandbox.workspace, &worktree, "ellen-k3f")
        .expect("overlay install");
    let names: Vec<String> = mounted
        .iter()
        .filter_map(|entry: &MountedDep| {
            entry.target.file_name().map(|name| name.to_string_lossy().to_string())
        })
        .collect();
    assert_eq!(names, vec!["node_modules".to_string()], "only existing dirs are mounted");
    assert!(!worktree.join("target").exists(), "missing lower => no mount");

    // lower 内容可见
    let read = std::fs::read_to_string(worktree.join("node_modules").join("left-pad.txt"))
        .expect("read through the overlay");
    assert_eq!(read, "from-main\n");

    // 分支的写入只落 upper：主工作区目录不变
    std::fs::write(worktree.join("node_modules").join("branch-only.txt"), "branch\n")
        .expect("write into overlay");
    assert!(
        !sandbox.workspace.join("node_modules").join("branch-only.txt").exists(),
        "writes through the overlay must not reach the main workspace"
    );
    let upper = crate::branch::deps::deps_root_for(&worktree, "ellen-k3f")
        .expect("deps root")
        .join("node_modules");
    assert!(
        upper.join("branch-only.txt").exists(),
        "the write should land in the upper layer at {}",
        upper.display()
    );

    strategy.uninstall(&mounted).expect("uninstall");
    // 卸载后挂载点退回空目录（upper 内容不再可见）
    assert!(
        !worktree.join("node_modules").join("left-pad.txt").exists(),
        "after unmount the lower content must not be visible"
    );
}

/// 非 Linux 平台不参与编译 overlay 用例（不是跳过，是排除——避免假绿）
#[cfg(not(target_os = "linux"))]
#[test]
fn overlay_is_unavailable_off_linux() {
    let strategy = probe_dep_strategy();
    assert_eq!(
        strategy.describe(&[]).strategy,
        "skip",
        "non-Linux platforms must assemble SkipDeps"
    );
}

/// `OverlayDeps` 在非 Linux 上直接报错（装配被绕过时暴露，不静默返回空）
#[cfg(not(target_os = "linux"))]
#[test]
fn overlay_install_fails_loudly_off_linux() {
    let root = temp_root("overlay-off-linux");
    let repo = root.join("repo");
    let worktree = root.join("worktrees").join("ellen-k3f");
    std::fs::create_dir_all(&repo).expect("repo");
    std::fs::create_dir_all(&worktree).expect("worktree");
    let error = crate::branch::deps::OverlayDeps
        .install(&repo, &worktree, "ellen-k3f")
        .expect_err("overlay is Linux-only");
    assert!(error.contains("Linux"), "{error}");
    let _ = std::fs::remove_dir_all(&root);
}

/// `deps_root_for` 落在 worktree 之外（FR-010 的三个理由依赖这一点）
#[test]
fn deps_root_sits_outside_the_worktree() {
    let worktree = Path::new("/core/worktrees/ellen-k3f");
    let root = crate::branch::deps::deps_root_for(worktree, "ellen-k3f").expect("deps root");
    assert_eq!(root, PathBuf::from("/core/worktrees/deps/ellen-k3f"));
    assert!(!root.starts_with(worktree), "deps root must be outside the worktree");
}

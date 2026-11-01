//! 仓库探测与脏工作区判定（specs/037 FR-003）

use std::path::Path;

use crate::branch::repo::{
    current_branch, detect_repo, is_dirty, is_ignored, is_tracked, list_worktrees,
    parse_worktree_list, precheck, short_head, trim_commit,
};
use crate::test_support::GitSandbox;

#[test]
fn detects_a_repository_from_its_root() {
    let sandbox = GitSandbox::new("repo-root");
    let facts = detect_repo(&sandbox.workspace).expect("workspace is a repository");
    assert_eq!(
        Path::new(&facts.root).canonicalize().ok(),
        sandbox.workspace.canonicalize().ok(),
        "root should be the workspace itself"
    );
    assert_eq!(facts.head, sandbox.head());
    assert!(!facts.git_dir.is_empty());
}

/// 子目录也归属于同一仓库（`--show-toplevel` 负责上溯）
#[test]
fn detects_a_repository_from_a_subdirectory() {
    let sandbox = GitSandbox::new("repo-subdir");
    sandbox.write("nested/deep/file.txt", "x");
    let nested = sandbox.workspace.join("nested").join("deep");
    let facts = detect_repo(&nested).expect("nested dir belongs to the repository");
    assert_eq!(
        Path::new(&facts.root).canonicalize().ok(),
        sandbox.workspace.canonicalize().ok()
    );
}

/// 非 git 目录 / 不存在的目录都返回 Err（调用方翻成 `not-git`）
#[test]
fn rejects_non_repository_directories() {
    let temp = std::env::temp_dir().join(format!(
        "branch-repo-plain-{}",
        crate::util::unique_id("t")
    ));
    std::fs::create_dir_all(&temp).expect("create temp dir");
    let error = detect_repo(&temp).expect_err("plain dir is not a repository");
    assert!(!error.is_empty(), "error detail must not be empty");
    let missing = temp.join("does-not-exist");
    let error = detect_repo(&missing).expect_err("missing dir is not a repository");
    assert!(!error.is_empty());
    let _ = std::fs::remove_dir_all(&temp);
}

/// 脏工作区判定覆盖未跟踪 / 已修改 / 已暂存三种形态
#[test]
fn detects_dirty_workspaces() {
    let sandbox = GitSandbox::new("repo-dirty");
    let root = sandbox.workspace_text();
    assert!(!is_dirty(&root).expect("status works"), "fresh repo is clean");

    // 未跟踪文件
    sandbox.write("untracked.txt", "new");
    assert!(is_dirty(&root).expect("status works"), "untracked file makes it dirty");
    sandbox.git(&["add", "untracked.txt"]);
    sandbox.git(&["commit", "-m", "add untracked"]);
    assert!(!is_dirty(&root).expect("status works"));

    // 已修改（未暂存）
    sandbox.dirty("README.md", "# changed\n");
    assert!(is_dirty(&root).expect("status works"), "modified file makes it dirty");
    sandbox.git(&["add", "README.md"]);
    // 已暂存
    assert!(is_dirty(&root).expect("status works"), "staged change makes it dirty");
    sandbox.git(&["commit", "-m", "modify readme"]);
    assert!(!is_dirty(&root).expect("status works"));
}

/// 短 id 与提交 id 的兜底截断口径一致
#[test]
fn short_head_matches_the_fallback_trim() {
    let sandbox = GitSandbox::new("repo-short-head");
    let root = sandbox.workspace_text();
    let full = sandbox.head();
    let short = short_head(&root).expect("short head");
    assert!(full.starts_with(&short), "{short} should prefix {full}");
    assert_eq!(trim_commit(&full), &full[..7]);
}

#[test]
fn current_branch_reads_head_branch() {
    let sandbox = GitSandbox::new("repo-branch");
    assert_eq!(
        current_branch(&sandbox.workspace_text()).expect("branch"),
        "main"
    );
}

/// `branchPrecheckRequested` 两态应答（FR-003 / FR-008）
#[test]
fn precheck_reports_ok_for_a_repository() {
    let sandbox = GitSandbox::new("repo-precheck-ok");
    sandbox.write("notes.txt", "dirty\n");
    let answer = precheck(&sandbox.workspace);
    assert_eq!(answer["ok"], serde_json::json!(true), "precheck: {answer}");
    assert_eq!(answer["dirty"], serde_json::json!(true), "precheck: {answer}");
    assert_eq!(answer["baseBranch"], serde_json::json!("main"));
    let head = answer["head"].as_str().expect("head is a string");
    assert!(sandbox.head().starts_with(head), "{head} should prefix HEAD");
    // 视图只带最小事实：不出现 commits / peers / deps 之类的扩展字段
    assert!(answer.get("commits").is_none());
    assert!(answer.get("peers").is_none());
    assert!(answer.get("deps").is_none());
}

#[test]
fn precheck_reports_not_git() {
    let temp = std::env::temp_dir().join(format!(
        "branch-precheck-plain-{}",
        crate::util::unique_id("t")
    ));
    std::fs::create_dir_all(&temp).expect("create temp dir");
    let answer = precheck(&temp);
    assert_eq!(answer["ok"], serde_json::json!(false), "precheck: {answer}");
    assert_eq!(answer["reason"], serde_json::json!("not-git"));
    assert!(
        answer["detail"].as_str().map(|text| !text.is_empty()).unwrap_or(false),
        "detail must explain why: {answer}"
    );
    let _ = std::fs::remove_dir_all(&temp);
}

/// `.gitignore` 判定（单文件本地配置的准入条件，FR-010）
#[test]
fn ignore_and_tracking_detection() {
    let sandbox = GitSandbox::new("repo-ignore");
    sandbox.write(".gitignore", ".env\n");
    sandbox.commit_all("ignore env");
    sandbox.write(".env", "TOKEN=1\n");
    sandbox.write("package.json", "{}\n");
    let root = sandbox.workspace_text();
    assert!(is_ignored(&root, ".env"), ".env should be ignored");
    assert!(!is_ignored(&root, "package.json"), "package.json is not ignored");
    sandbox.git(&["add", "-f", ".env"]);
    sandbox.git(&["commit", "-m", "track env"]);
    assert!(is_tracked(&root, ".env"), ".env should be tracked now");
    assert!(!is_tracked(&root, "missing.txt"));
}

/// `git worktree list --porcelain` 的解析（只认公开字段，未知键忽略）
#[test]
fn parses_worktree_list_output() {
    let text = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n\
                worktree /core/worktrees/ellen-k3f\nHEAD def456\nbranch refs/heads/tuxedo/ellen-k3f\nlocked reason\n\n\
                worktree /detached\nHEAD 001122\ndetached\n";
    let entries = parse_worktree_list(text);
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].path, "/repo");
    assert_eq!(entries[0].branch_name(), Some("main"));
    assert_eq!(entries[1].branch_name(), Some("tuxedo/ellen-k3f"));
    assert_eq!(entries[1].head.as_deref(), Some("def456"));
    assert_eq!(entries[2].branch_name(), None);
    assert_eq!(entries[2].head.as_deref(), Some("001122"));
}

/// 真实仓库的 worktree 列表（创建前后各一次）
#[test]
fn lists_real_worktrees() {
    let sandbox = GitSandbox::new("repo-worktree-list");
    let root = sandbox.workspace_text();
    let before = list_worktrees(&root).expect("list worktrees");
    assert_eq!(before.len(), 1, "a fresh repo has exactly the main worktree");
    assert_eq!(before[0].branch_name(), Some("main"));
}

/// 空仓库（没有任何提交）不能建分支：探测返回 Err 而不是给出一个空 base
#[test]
fn empty_repository_has_no_head() {
    let sandbox = GitSandbox::new("repo-empty");
    let empty = sandbox.root.join("empty");
    std::fs::create_dir_all(&empty).expect("create empty dir");
    let command = std::process::Command::new("git")
        .arg("-C")
        .arg(&empty)
        .args(["init", "-b", "main"])
        .env("GIT_CONFIG_GLOBAL", &sandbox.config_stub)
        .env("GIT_CONFIG_SYSTEM", &sandbox.config_stub)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("git init");
    assert!(command.success());
    let error = detect_repo(&empty).expect_err("a repository without commits has no base");
    assert!(!error.is_empty());
}

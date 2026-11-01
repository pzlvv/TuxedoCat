//! worktree 生命周期（specs/037 FR-002 / FR-005 / FR-010）

use std::path::Path;

use crate::branch::repo;
use crate::branch::state::{BranchFacts, BranchView, UnavailableReason};
use crate::branch::worktree::{
    check_available, create_or_reuse, remove, reconcile_on_start, work_summary, worktree_path,
    worktrees_root,
};
use crate::test_support::GitSandbox;

/// worktree 建在 Core 数据目录下（**不在仓库里**，FR-002 / FR-011）
#[test]
fn worktree_lives_in_the_core_data_directory() {
    let sandbox = GitSandbox::new("wt-layout");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let worktree = Path::new(&setup.facts.worktree);
    assert!(worktree.is_dir(), "worktree should exist at {}", worktree.display());
    let repo_root = sandbox.workspace.canonicalize().expect("canonical repo");
    let worktree_canonical = worktree.canonicalize().expect("canonical worktree");
    assert!(
        !worktree_canonical.starts_with(&repo_root),
        "worktree {} must live outside the repository {}",
        worktree_canonical.display(),
        repo_root.display()
    );
    // 仓库里没有任何新增文件（AC-35）
    assert_eq!(sandbox.status().trim(), "", "main workspace must stay clean");
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// 创建 = 目录 + 真实分支一步到位（FR-002 / AC-5）
#[test]
fn create_makes_a_directory_and_a_real_branch() {
    let sandbox = GitSandbox::new("wt-create");
    sandbox.register_workspace();
    let head_before = sandbox.head();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    assert!(!setup.reused, "first creation is not a reuse");
    assert_eq!(setup.facts.base_commit, head_before);
    assert_eq!(setup.facts.base_branch, "main");
    let branches = sandbox.branches();
    assert!(
        branches.contains(&format!("tuxedo/{}", setup.facts.name)),
        "branch list {branches:?} should contain tuxedo/{}",
        setup.facts.name
    );
    assert!(crate::branch::naming::is_valid_name(&setup.facts.name));
    // 系统提示段（FR-004 的「模型自己管检查点」全部实现）
    let prompt = setup.prompt_section();
    assert!(prompt.contains(&format!("tuxedo/{}", setup.facts.name)));
    assert!(prompt.contains("git merge"));
    assert!(prompt.contains("git commit"));
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// 分支指针随 `git commit` 自动前移（真实分支，AC-5）
#[test]
fn commits_advance_the_branch_pointer() {
    let sandbox = GitSandbox::new("wt-commit");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let worktree = setup.facts.worktree.clone();
    let branch = setup.facts.branch_ref();
    let before = repo::git_in(Path::new(&worktree), &["rev-parse", "HEAD"]);
    assert!(before.ok(), "worktree HEAD readable");

    std::fs::write(Path::new(&worktree).join("branch.txt"), "hi\n").expect("write in worktree");
    let config = |args: &[&str]| {
        repo::git_in(Path::new(&worktree), args)
    };
    assert!(config(&["add", "-A"]).ok());
    assert!(config(&["commit", "-m", "branch work"]).ok());

    let tip = repo::git_in(
        Path::new(&sandbox.workspace_text()),
        &["rev-parse", &branch],
    );
    assert!(tip.ok(), "branch {branch} must exist");
    let after = repo::git_in(Path::new(&worktree), &["rev-parse", "HEAD"]);
    assert_eq!(tip.stdout.trim(), after.stdout.trim(), "commit advances {branch}");
    assert_ne!(before.stdout.trim(), after.stdout.trim());
    // 主工作区看不到这次提交的内容
    assert!(!sandbox.workspace.join("branch.txt").exists());
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// 复用已存在的 worktree：不重建、不丢未提交改动（AC-4）
#[test]
fn reuse_keeps_uncommitted_changes() {
    let sandbox = GitSandbox::new("wt-reuse");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let worktree = setup.facts.worktree.clone();
    std::fs::write(Path::new(&worktree).join("draft.txt"), "work in progress\n")
        .expect("write draft");

    let reused = create_or_reuse(&sandbox.workspace_text(), Some(&setup.facts.name))
        .expect("reuse branch");
    assert!(reused.reused, "second call must reuse");
    assert_eq!(reused.facts.worktree, setup.facts.worktree);
    assert_eq!(reused.facts.name, setup.facts.name);
    let content = std::fs::read_to_string(Path::new(&worktree).join("draft.txt"))
        .expect("draft survives reuse");
    assert_eq!(content, "work in progress\n");
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// 复用失败：worktree 被用户手工删掉 → 报错而不是静默重建（AC-14）
#[test]
fn reuse_fails_when_the_worktree_disappeared() {
    let sandbox = GitSandbox::new("wt-missing");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    std::fs::remove_dir_all(&setup.facts.worktree).expect("delete worktree");

    let error = create_or_reuse(&sandbox.workspace_text(), Some(&setup.facts.name))
        .expect_err("missing worktree must not be recreated");
    assert!(error.contains("missing"), "{error}");

    let view = check_available(&setup.facts, Some(&sandbox.workspace_text()));
    match view {
        BranchView::Unavailable { reason, detail } => {
            assert_eq!(reason, UnavailableReason::WorktreeMissing);
            assert!(detail.contains("no longer exists"), "{detail}");
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    let _ = repo::git_in(
        Path::new(&sandbox.workspace_text()),
        &["branch", "-D", &setup.facts.branch_ref()],
    );
}

/// 复用失败：分支被用户手工删除 → `git-failed`（边界表）
#[test]
fn reuse_fails_when_the_branch_was_deleted() {
    let sandbox = GitSandbox::new("wt-branch-gone");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    // 用户手工 `git worktree remove` 后再删分支（等于边界表里「用户手动 prune」那两条）
    let worktree = setup.facts.worktree.clone();
    let output = repo::git_in(
        Path::new(&sandbox.workspace_text()),
        &["worktree", "remove", "--force", &worktree],
    );
    assert!(output.ok(), "{}", output.error_text());
    let output = repo::git_in(
        Path::new(&sandbox.workspace_text()),
        &["branch", "-D", &setup.facts.branch_ref()],
    );
    assert!(output.ok(), "{}", output.error_text());
    // worktree 目录也没了：这里走的是 `worktree-missing`（先撞到的那个事实）
    let error = create_or_reuse(&sandbox.workspace_text(), Some(&setup.facts.name))
        .expect_err("deleted worktree must surface as an error");
    assert!(error.contains("missing"), "{error}");
    let view = check_available(&setup.facts, Some(&sandbox.workspace_text()));
    assert!(matches!(
        view,
        BranchView::Unavailable {
            reason: UnavailableReason::WorktreeMissing,
            ..
        }
    ));
}

/// 删除：worktree 目录与分支一并清理（AC-12）
#[test]
fn remove_cleans_worktree_and_branch() {
    let sandbox = GitSandbox::new("wt-remove");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let worktree = setup.facts.worktree.clone();
    let branch = setup.facts.branch_ref();
    std::fs::write(Path::new(&worktree).join("dirty.txt"), "uncommitted\n").expect("write");
    let (commits, files) = work_summary(&setup.facts, &sandbox.workspace_text());
    assert_eq!(commits, Some(0), "no commits yet");
    assert_eq!(files, Some(0), "no differences yet");

    remove(&sandbox.workspace_text(), &setup.facts, &[]).expect("remove branch resources");
    assert!(!Path::new(&worktree).exists(), "worktree directory must be gone");
    assert!(
        !sandbox.branches().contains(&branch),
        "branch {branch} must be deleted"
    );
    // 主工作区不受影响
    assert_eq!(sandbox.status().trim(), "");
}

/// 删除前计数写诊断日志（提交数 + 差异文件数，specs/037 FR-005）
#[test]
fn work_summary_counts_commits_and_files() {
    let sandbox = GitSandbox::new("wt-summary");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let worktree = setup.facts.worktree.clone();
    std::fs::write(Path::new(&worktree).join("a.txt"), "a\n").expect("write a");
    std::fs::write(Path::new(&worktree).join("b.txt"), "b\n").expect("write b");
    assert!(repo::git_in(Path::new(&worktree), &["add", "-A"]).ok());
    assert!(repo::git_in(Path::new(&worktree), &["commit", "-m", "two files"]).ok());

    let (commits, files) = work_summary(&setup.facts, &sandbox.workspace_text());
    assert_eq!(commits, Some(1));
    assert_eq!(files, Some(2));
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// 撞名：同名分支已存在时换名重试（AC-23）
#[test]
fn name_collisions_are_retried() {
    let sandbox = GitSandbox::new("wt-collide");
    sandbox.register_workspace();
    let first = create_or_reuse(&sandbox.workspace_text(), None).expect("first branch");
    let second = create_or_reuse(&sandbox.workspace_text(), None).expect("second branch");
    assert_ne!(
        first.facts.name, second.facts.name,
        "two live branches must not share a name"
    );
    assert_ne!(first.facts.worktree, second.facts.worktree);
    let branches = sandbox.branches();
    assert!(branches.contains(&first.facts.branch_ref()));
    assert!(branches.contains(&second.facts.branch_ref()));
    let _ = remove(&sandbox.workspace_text(), &first.facts, &[]);
    let _ = remove(&sandbox.workspace_text(), &second.facts, &[]);
}

/// 并行：三份 worktree 互不可见对方的未提交改动（AC-11）
#[test]
fn parallel_worktrees_are_isolated() {
    let sandbox = GitSandbox::new("wt-parallel");
    sandbox.register_workspace();
    let mut setups = Vec::new();
    for _ in 0..3 {
        setups.push(create_or_reuse(&sandbox.workspace_text(), None).expect("create branch"));
    }
    for (index, setup) in setups.iter().enumerate() {
        std::fs::write(
            Path::new(&setup.facts.worktree).join(format!("only-{index}.txt")),
            format!("branch {index}\n"),
        )
        .expect("write own file");
    }
    for (index, setup) in setups.iter().enumerate() {
        let status = repo::git_in(
            Path::new(&setup.facts.worktree),
            &["status", "--porcelain"],
        );
        let status = status.stdout;
        assert!(
            status.contains(&format!("only-{index}.txt")),
            "own file must show up: {status}"
        );
        for other in 0..setups.len() {
            if other == index {
                continue;
            }
            assert!(
                !status.contains(&format!("only-{other}.txt")),
                "branch {index} must not see branch {other}'s changes: {status}"
            );
        }
    }
    for setup in &setups {
        let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
    }
}

/// 非 git 目录：创建直接失败（FR-003「仓库前置」，不降级为「无隔离的分支对话」）
#[test]
fn non_git_workspace_is_rejected() {
    let temp = std::env::temp_dir().join(format!("branch-wt-plain-{}", crate::util::unique_id("t")));
    std::fs::create_dir_all(&temp).expect("create temp");
    let sandbox = GitSandbox::new("wt-plain-core");
    sandbox.register_workspace();
    let error = create_or_reuse(&temp.to_string_lossy(), None)
        .expect_err("non-git directory cannot host a branch conversation");
    assert!(!error.is_empty());
    let _ = std::fs::remove_dir_all(&temp);
}

/// 启动对账：有效 worktree 保留、孤儿只记日志（AC-13）
#[test]
fn reconcile_keeps_valid_worktrees_and_reports_orphans() {
    let sandbox = GitSandbox::new("wt-reconcile");
    sandbox.register_workspace();
    let kept = create_or_reuse(&sandbox.workspace_text(), None).expect("kept branch");
    let orphan = create_or_reuse(&sandbox.workspace_text(), None).expect("orphan branch");

    // 只有 kept 有会话登记：orphan 就是「git 登记了但没有会话引用」
    let sessions = vec![("s-kept".to_string(), kept.facts.clone())];
    let report = reconcile_on_start(&sessions, &[sandbox.workspace_text()]);
    assert_eq!(report.kept, vec![kept.facts.worktree.clone()]);
    assert_eq!(report.orphans, vec![orphan.facts.worktree.clone()]);
    assert!(report.missing.is_empty());
    // 孤儿不自动删
    assert!(Path::new(&orphan.facts.worktree).is_dir());

    // 会话还在但 worktree 消失 → missing
    std::fs::remove_dir_all(&kept.facts.worktree).expect("delete kept worktree");
    let report = reconcile_on_start(&sessions, &[sandbox.workspace_text()]);
    assert_eq!(report.missing, vec!["s-kept".to_string()]);
    let _ = remove(&sandbox.workspace_text(), &orphan.facts, &[]);
    let _ = repo::git_in(
        Path::new(&sandbox.workspace_text()),
        &["branch", "-D", &kept.facts.branch_ref()],
    );
}

/// worktree / deps 路径布局（FR-002 / FR-010）
#[test]
fn paths_follow_the_documented_layout() {
    let sandbox = GitSandbox::new("wt-paths");
    sandbox.register_workspace();
    let workspace = sandbox.workspace_text();
    let root = worktrees_root(&workspace).expect("worktrees root");
    let path = worktree_path(&workspace, "ellen-k3f").expect("worktree path");
    assert_eq!(path, root.join("ellen-k3f"));
    assert_eq!(
        path.parent().expect("parent"),
        root,
        "worktree sits directly under worktrees/"
    );
    let deps_root = crate::branch::deps::deps_root_for(&path, "ellen-k3f").expect("deps root");
    assert_eq!(deps_root, root.join("deps").join("ellen-k3f"));
}

/// 单文件本地配置随创建一起共享（AC-36 的创建侧入口）
#[test]
fn creation_links_local_configs() {
    let sandbox = GitSandbox::new("wt-config");
    sandbox.write(".gitignore", ".env\n");
    sandbox.commit_all("ignore env");
    sandbox.write(".env", "TOKEN=1\n");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    assert!(
        setup.configs.iter().any(|entry| entry.name == ".env"),
        "creation should share .env: {:?}",
        setup.configs
    );
    let content = std::fs::read_to_string(Path::new(&setup.facts.worktree).join(".env"))
        .expect("read shared env");
    assert_eq!(content, "TOKEN=1\n");
    assert!(
        setup.prompt_section().contains(".env"),
        "system prompt should mention the shared config: {}",
        setup.prompt_section()
    );
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// `check_available` 正常态返回 ready（会话每轮开始的核对）
#[test]
fn availability_check_reports_ready() {
    let sandbox = GitSandbox::new("wt-available");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    match check_available(&setup.facts, Some(&sandbox.workspace_text())) {
        BranchView::Ready(facts) => assert_eq!(facts, setup.facts),
        other => panic!("expected ready, got {other:?}"),
    }
    // 仓库消失 → not-git
    match check_available(&setup.facts, None) {
        BranchView::Unavailable { reason, .. } => {
            assert_eq!(reason, UnavailableReason::NotGit);
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    // worktree 还在但分支指针没了 → git-failed（边界表「用户手动 git branch -D」）
    let orphan_facts = BranchFacts {
        name: "ellen-k3f".to_string(),
        worktree: setup.facts.worktree.clone(),
        base_commit: setup.facts.base_commit.clone(),
        base_branch: setup.facts.base_branch.clone(),
    };
    match check_available(&orphan_facts, Some(&sandbox.workspace_text())) {
        BranchView::Unavailable { reason, detail } => {
            assert_eq!(reason, UnavailableReason::GitFailed);
            assert!(detail.contains("tuxedo/ellen-k3f"), "{detail}");
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

/// worktree 内 `git worktree remove` 自身被拒绝（FR-004 防自毁）
#[test]
fn self_destruction_commands_are_rejected() {
    let sandbox = GitSandbox::new("wt-self-destruct");
    sandbox.register_workspace();
    let setup = create_or_reuse(&sandbox.workspace_text(), None).expect("create branch");
    let facts = BranchFacts::from_meta(Some(&setup.facts.to_meta())).expect("meta roundtrip");
    assert_eq!(facts.branch_ref(), setup.facts.branch_ref());

    // 拦截判定发生在 engine 的 Bash 前置校验（tools.rs 的 `block_self_destructive_git`），
    // 这里只断言判定函数本身认得出这两种命令
    for command in [
        format!("git worktree remove {}", setup.facts.worktree),
        "git worktree remove --force ../x".to_string(),
        format!("git branch -D {}", setup.facts.branch_ref()),
        format!("git branch --delete --force {}", setup.facts.branch_ref()),
    ] {
        assert!(
            crate::branch::worktree::is_self_destructive(&command, &setup.facts.name),
            "{command} should be recognized as self-destructive"
        );
    }
    for allowed in [
        "git branch -D feature/x".to_string(),
        "git status".to_string(),
        "git commit -m 'work'".to_string(),
        "git worktree list".to_string(),
    ] {
        assert!(
            !crate::branch::worktree::is_self_destructive(&allowed, &setup.facts.name),
            "{allowed} should be allowed"
        );
    }
    let _ = remove(&sandbox.workspace_text(), &setup.facts, &[]);
}

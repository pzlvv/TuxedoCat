//! worktree 生命周期（specs/037 FR-002 / FR-005 / FR-010）。
//!
//! 布局（全部在 Core 数据目录内，**不在仓库里**——这是「分支不可见」的全部机制）：
//!
//! ```text
//! <Core 数据目录>/worktrees/<工作区短名>/<branch>/       ← worktree 工作目录
//! <Core 数据目录>/worktrees/<工作区短名>/deps/<branch>/  ← 依赖 overlay 的 upper 与 workdir
//! refs/heads/tuxedo/<branch>                           ← 真实分支（成果出口）
//! ```
//!
//! `<工作区短名>` 是 `w-<sha256 前 12 位>`，**不复用** `conversations/<URI 编码的完整
//! 工作区路径>/` 那层：那层目录名随工作区路径长度线性增长，再拼 `<branch>/` 后很容易
//! 越过 Windows 的 260 字符 `MAX_PATH`（worktree 里还要建 `.git`，超限时 git 报
//! `'$GIT_DIR' too big` / `Filename too long`）。工作区全路径由 `meta.json` 的
//! `branch.worktree` 承载，不在目录名里重复编码。
//!
//! 创建序列（`specs/037-branch-conversation/plan.md` 的「worktree 布局与 git 交互」一节）：探测仓库 → 脏工作区判定 → `git worktree add
//! <path> -b tuxedo/<name> HEAD` → 装配依赖策略 → 链接单文件本地配置。任一步失败即
//! 回滚已做的步（卸载挂载 → `worktree remove --force` → `branch -D`）。

use std::path::{Path, PathBuf};

use crate::branch::deps::{self, DepPolicy, DepStrategy, LinkedConfig, MountedDep};
use crate::branch::naming;
use crate::branch::repo::{self, RepoFacts};
use crate::branch::state::{BranchFacts, BranchView, UnavailableReason};

/// 一次成功创建 / 复用的结果
#[derive(Debug, Clone)]
pub struct BranchSetup {
    pub facts: BranchFacts,
    /// 依赖策略档位事实（只喂系统提示，不进事件载荷）
    pub deps: DepPolicy,
    /// 经链接或复制的本地配置文件
    pub configs: Vec<LinkedConfig>,
    /// 该 worktree 上现存的挂载点（删除时按它卸载；生产路径按 `deps::mounted_under`
    /// 从 `/proc/self/mountinfo` 重算，本字段服务装配时的即时诊断与测试断言）
    #[cfg_attr(not(test), allow(dead_code))]
    pub mounted: Vec<MountedDep>,
    /// 是否是复用的既有 worktree（`false` 表示本次新建）
    pub reused: bool,
}

impl BranchSetup {
    /// 系统提示里的分支段（英文常量：进 LLM 上下文，不参与键化）
    pub fn prompt_section(&self) -> String {
        let mut lines = vec![
            format!(
                "You are working in an isolated git worktree on branch `{}`, forked from commit {}.",
                self.facts.branch_ref(),
                repo::trim_commit(&self.facts.base_commit)
            ),
            "- Your file changes only land in the current directory; the user's main workspace is untouched.".to_string(),
            "- Use `git commit` to leave checkpoints (the repository is already set up — no init or config needed).".to_string(),
            "- You cannot see the user's uncommitted changes (a worktree starts from committed content only).".to_string(),
            format!(
                "- The user picks up your work with `git merge {}` in the main workspace; do not write to the main workspace yourself.",
                self.facts.branch_ref()
            ),
            format!("- {}", self.deps.prompt_line()),
        ];
        if let Some(configs) = deps::describe_local_configs(&self.configs) {
            lines.push(format!("- {configs}"));
        }
        lines.join("\n")
    }
}

/// 工作区在 worktree 根下的短目录名：`w-<sha256 前 12 位>`。
///
/// 为什么不复用对话空间目录（`conversations/<URI 编码的完整工作区路径>/`）：那一层的
/// 目录名随工作区路径长度线性增长，`<branch>/` 再拼两级之后很容易越过 Windows 的
/// 260 字符 `MAX_PATH`。git 在 worktree 里要写 `.git` 文件，超限时各版本报出的文案
/// 不同（`fatal: '$GIT_DIR' too big` / `Filename too long`），但成因同一个。
///
/// 固定 12 位十六进制的目录名与工作区路径长度无关，`worktrees/` 这一层因此恒短；
/// 工作区全路径仍然可查——由 `meta.json` 的 `branch.worktree` 承载（唯一事实源，
/// FR-001），不在目录名里重复编码。
fn workspace_slug(workspace: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    // 归一：Windows 上 `D:\a` 与 `D:/a` 是同一目录，不能让它们落到两个 slug
    let normalized = workspace.replace('\\', "/");
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let hash: String = digest.iter().take(6).map(|byte| format!("{byte:02x}")).collect();
    format!("w-{hash}")
}

/// worktree 根目录：`<Core 数据目录>/worktrees/<工作区短名>/`
///
/// **与 `conversations/` 平级**，不挂在会话空间目录下：会话空间那层目录名由工作区
/// 完整路径编码而来，长度随路径增长；worktree 里面还要建 `.git`，挂在那层之下会撞
/// Windows 的 `MAX_PATH`（specs/defects/branch-worktree-path-exceeds-windows-max-path.md）。
///
/// 目录创建失败直接返回错误（不静默退回仓库内路径——那会破坏可见性边界，铁律 1）。
pub fn worktrees_root(workspace: &str) -> Result<PathBuf, String> {
    Ok(crate::config::config_home()?.join("worktrees").join(workspace_slug(workspace)))
}

/// worktree 目录：`<Core 数据目录>/worktrees/<工作区短名>/<branch>/`
pub fn worktree_path(workspace: &str, branch: &str) -> Result<PathBuf, String> {
    Ok(worktrees_root(workspace)?.join(branch))
}

/// 创建（或复用）分支对话的 worktree。
///
/// `branch_hint` 为 `Some` 时用它（复用既有会话），否则生成新名字并在撞名时重试。
/// 返回的 `facts` 是**本次建立的事实**，调用方负责写 `meta.json` 与推事件。
pub fn create_or_reuse(
    workspace: &str,
    branch_hint: Option<&str>,
) -> Result<BranchSetup, String> {
    let repo_facts = repo::detect_repo(Path::new(workspace))?;
    match branch_hint {
        Some(name) => reuse(&repo_facts.root, workspace, name),
        None => create_new(&repo_facts, workspace),
    }
}

/// 复用既有 worktree（会话重开：不重建、不丢失未提交改动，specs/037 AC-4）。
fn reuse(repo_root: &str, workspace: &str, name: &str) -> Result<BranchSetup, String> {
    let worktree = worktree_path(workspace, name)?;
    if !worktree.is_dir() {
        return Err(format!(
            "worktree {} is missing (removed outside the app?)",
            worktree.display()
        ));
    }
    let branch = naming::branch_ref(name);
    if !repo::branch_exists(repo_root, &branch) {
        return Err(format!("branch {branch} no longer exists"));
    }
    // 校验 HEAD 与 meta 记录一致：不解析 `.git/worktrees/` 内部格式，只经
    // `git worktree list --porcelain` 读（specs/037 FR-001 / AC-32）
    let entries = repo::list_worktrees(repo_root)?;
    let expected = worktree.to_string_lossy().to_string();
    let entry = entries
        .iter()
        .find(|entry| same_path(&entry.path, &expected))
        .ok_or_else(|| format!("{expected} is not registered as a worktree of {repo_root}"))?;
    if entry.branch_name() != Some(branch.as_str()) {
        return Err(format!(
            "worktree {expected} is on branch {:?}, expected {branch}",
            entry.branch_name()
        ));
    }
    let head = entry
        .head
        .clone()
        .ok_or_else(|| format!("worktree {expected} has no HEAD in `git worktree list`"))?;
    let base_branch = repo::current_branch(repo_root).unwrap_or_else(|_| "HEAD".to_string());
    let facts = BranchFacts {
        name: name.to_string(),
        worktree: expected,
        base_commit: head,
        base_branch,
    };
    let (policy, mounted) = install_deps(Path::new(repo_root), &worktree, name);
    let configs = deps::link_local_configs(Path::new(repo_root), &worktree);
    Ok(BranchSetup {
        facts,
        deps: policy,
        configs,
        mounted,
        reused: true,
    })
}

/// 新建 worktree + 真实分支（撞名重试只作用于名字生成，此时 worktree 尚未建出）
fn create_new(repo_facts: &RepoFacts, workspace: &str) -> Result<BranchSetup, String> {
    let root = repo_facts.root.as_str();
    let base_branch = repo::current_branch(root)?;
    let base_commit = repo_facts.head.clone();
    let mut last_error = String::new();
    // 撞名概率极低（角色名 24 个 × 36^3 后缀），重试上限只为防死循环
    for _ in 0..32 {
        let name = naming::generate_name();
        let branch = naming::branch_ref(&name);
        if repo::branch_exists(root, &branch) {
            last_error = format!("branch {branch} already exists");
            continue;
        }
        let worktree = match worktree_path(workspace, &name) {
            Ok(path) => path,
            Err(error) => return Err(error),
        };
        if worktree.exists() {
            last_error = format!("worktree path {} already exists", worktree.display());
            continue;
        }
        if let Some(parent) = worktree.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("mkdir {} failed: {err}", parent.display()))?;
        }
        let worktree_text = worktree.to_string_lossy().to_string();
        // 一步建出目录 + 真实分支：`-b` 指定全新名字，已存在时 git 报错
        let output = repo::git_in(
            Path::new(root),
            &["worktree", "add", &worktree_text, "-b", &branch, "HEAD"],
        );
        if !output.ok() {
            let text = output.error_text();
            // 分支已存在（并发创建同名）/ 目录已存在：换名重试；其余错误直接透出
            if text.contains("already exists") {
                last_error = text;
                continue;
            }
            return Err(text);
        }
        let facts = BranchFacts {
            name: name.clone(),
            worktree: worktree_text,
            base_commit,
            base_branch: base_branch.clone(),
        };
        let (policy, mounted) = install_deps(Path::new(root), &worktree, &name);
        let configs = deps::link_local_configs(Path::new(root), &worktree);
        return Ok(BranchSetup {
            facts,
            deps: policy,
            configs,
            mounted,
            reused: false,
        });
    }
    Err(format!(
        "could not allocate a unique branch name after 32 attempts: {last_error}"
    ))
}

/// 装配依赖策略并挂载；单目录挂载失败退化为「该目录不挂」并记诊断日志
/// （specs/037 边界表：依赖目录挂载失败 → 该目录退化为 SkipDeps，其余能力不受影响）。
fn install_deps(repo_root: &Path, worktree: &Path, branch: &str) -> (DepPolicy, Vec<MountedDep>) {
    let strategy: Box<dyn DepStrategy> = deps::probe_dep_strategy();
    match strategy.install(repo_root, worktree, branch) {
        Ok(mounted) => (strategy.describe(&mounted), mounted),
        Err(error) => {
            eprintln!("[core] branch deps install failed: {error}");
            (strategy.describe(&[]), Vec::new())
        }
    }
}

/// 删除分支对话的资源：卸载挂载 → `git worktree remove --force` → `git branch -D`。
///
/// 顺序是硬要求（specs/037 FR-010「卸载顺序」）：挂载点还在 worktree 里时删目录会
/// 留下悬挂挂载。upper 目录（`worktrees/deps/<branch>/`）随 worktree 一并删除。
pub fn remove(repo_root: &str, facts: &BranchFacts, mounted: &[MountedDep]) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    let strategy: Box<dyn DepStrategy> = deps::probe_dep_strategy();
    if let Err(error) = strategy.uninstall(mounted) {
        failures.push(error);
    }
    let worktree = Path::new(&facts.worktree);
    if worktree.exists() {
        let output = repo::git_in(
            Path::new(repo_root),
            &["worktree", "remove", "--force", &facts.worktree],
        );
        if !output.ok() {
            failures.push(output.error_text());
        }
    }
    // 分支删除：worktree 摘除后分支才可删
    let branch = facts.branch_ref();
    let output = repo::git_in(Path::new(repo_root), &["branch", "-D", &branch]);
    if !output.ok() {
        let text = output.error_text();
        // 分支已不存在（用户手工删过）：删除目标达成，不算失败
        if !text.contains("not found") {
            failures.push(text);
        }
    }
    // upper / workdir 目录（在 worktree 之外）
    if let Some(deps_root) = deps::deps_root_for(worktree, &facts.name) {
        if deps_root.exists() {
            if let Err(error) = std::fs::remove_dir_all(&deps_root) {
                failures.push(format!("remove {} failed: {error}", deps_root.display()));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

/// 删除前的定性计数（只进诊断日志——view 已收窄，不为确认框恢复计数字段）。
///
/// 返回 `(提交数, 差异文件数)`；命令失败时对应项为 `None`（日志里记成 `?`）。
/// 范围的两端都显式写成 ref：`<base>..<branch>` 而不是 `<base>..HEAD`——主工作区的
/// HEAD 指向它自己的分支，用 HEAD 会数到主分支上。
pub fn work_summary(facts: &BranchFacts, repo_root: &str) -> (Option<usize>, Option<usize>) {
    let range = format!("{}..{}", facts.base_commit, facts.branch_ref());
    let commits = repo::git_in(Path::new(repo_root), &["rev-list", "--count", &range]);
    let commits = if commits.ok() {
        commits.stdout.trim().parse::<usize>().ok()
    } else {
        None
    };
    let files = repo::git_in(
        Path::new(repo_root),
        &["diff", "--name-only", &range],
    );
    let files = if files.ok() {
        Some(
            files
                .stdout
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count(),
        )
    } else {
        None
    };
    (commits, files)
}

/// 分支会话里拒绝作用于**自身**的 `git worktree remove` 与 `git branch -D tuxedo/<自身分支>`
/// （specs/037 FR-004「拒绝的操作」）。
///
/// 执行后会话立刻变 `unavailable` 且未提交改动不可恢复，所以是防自毁而非权限控制。
/// 判定口径是「git 子命令 + 参数」的字符串匹配，不做独立 AST 解析——误伤面极小
/// （`specs/037-branch-conversation/plan.md` 的「worktree 布局与 git 交互」一节）。
pub fn is_self_destructive(command: &str, branch_name: &str) -> bool {
    if !command.contains("git") {
        return false;
    }
    let tokens: Vec<&str> = command
        .split(['|', ';', '&', '\n'])
        .flat_map(|segment| segment.split_whitespace())
        .collect();
    let self_ref = naming::branch_ref(branch_name);
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        // 定位 `git ... worktree remove` / `git ... branch -D`
        if token != "git" && !token.ends_with("/git") {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        // 跳过 git 的全局选项（如 `-C <dir>` / `--git-dir=<x>`）
        while cursor < tokens.len() && tokens[cursor].starts_with('-') {
            cursor += if tokens[cursor] == "-C" || tokens[cursor] == "-c" { 2 } else { 1 };
        }
        if cursor >= tokens.len() {
            break;
        }
        match tokens[cursor] {
            "worktree" if tokens.get(cursor + 1) == Some(&"remove") => {
                // 分支会话里一律拒绝：模型的合法用途里没有「拆别人的工作树」，而
                // 「拆自己的」等于自毁（会话立刻 unavailable、未提交改动不可恢复）。
                // 目标路径算不算自身取决于解析后的绝对路径，字符串匹配判不准，
                // 于是按「整条子命令拒绝」收口（specs/037 边界表）。
                return true;
            }
            "branch" => {
                let flags_force = tokens[cursor + 1..]
                    .iter()
                    .any(|arg| *arg == "-D" || *arg == "--delete");
                if flags_force
                    && tokens
                        .iter()
                        .any(|arg| *arg == self_ref.as_str() || *arg == branch_name)
                {
                    return true;
                }
            }
            _ => {}
        }
        index = cursor + 1;
    }
    false
}

/// 会话下一轮开始时核对 worktree 是否仍然可用（specs/037 AC-14 与边界表）。
/// 不可用时返回 `unavailable` 视图——**不静默重建**（未提交改动已丢失）。
pub fn check_available(facts: &BranchFacts, repo_root: Option<&str>) -> BranchView {
    let worktree = Path::new(&facts.worktree);
    if !worktree.is_dir() {
        return BranchView::Unavailable {
            reason: UnavailableReason::WorktreeMissing,
            detail: format!("worktree {} no longer exists", facts.worktree),
        };
    }
    let Some(root) = repo_root else {
        return BranchView::Unavailable {
            reason: UnavailableReason::NotGit,
            detail: "the workspace is no longer inside a git repository".to_string(),
        };
    };
    let branch = facts.branch_ref();
    if !repo::branch_exists(root, &branch) {
        return BranchView::Unavailable {
            reason: UnavailableReason::GitFailed,
            detail: format!("branch {branch} no longer exists"),
        };
    }
    BranchView::Ready(facts.clone())
}

/// 启动对账结果
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    /// 仍有效（`meta.json` 里登记的会话 + worktree 都在）的 worktree 路径
    pub kept: Vec<String>,
    /// 孤儿 worktree：git 登记了、但没有会话引用它——只写诊断日志，不自动删也不推 UI
    pub orphans: Vec<String>,
    /// 会话还在但 worktree 已消失的会话 id
    pub missing: Vec<String>,
}

/// Core 启动对账（specs/037 FR-005 / AC-13）。
///
/// `sessions` 是 `meta.json` 里登记的分支会话 `(sessionId, facts)`，`workspaces` 是
/// 本次启动涉及的工作目录。比对 `git worktree list --porcelain` 的结果：
/// 有效会话的 worktree 保留，孤儿 worktree 只写诊断日志。
pub fn reconcile_on_start(
    sessions: &[(String, BranchFacts)],
    workspaces: &[String],
) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let mut referenced: Vec<String> = Vec::new();
    for (session_id, facts) in sessions {
        if Path::new(&facts.worktree).is_dir() {
            report.kept.push(facts.worktree.clone());
            referenced.push(facts.worktree.clone());
        } else {
            report.missing.push(session_id.clone());
        }
    }
    for workspace in workspaces {
        let Ok(root) = repo::detect_repo(Path::new(workspace)) else {
            continue;
        };
        let Ok(entries) = repo::list_worktrees(&root.root) else {
            continue;
        };
        for entry in entries {
            // 只关心本能力建的命名空间
            if entry
                .branch_name()
                .map(|name| name.starts_with(&format!("{}/", naming::BRANCH_NAMESPACE)))
                .unwrap_or(false)
                == false
            {
                continue;
            }
            let is_referenced = referenced
                .iter()
                .any(|path| same_path(path, &entry.path));
            if !is_referenced && !report.orphans.iter().any(|path| same_path(path, &entry.path)) {
                report.orphans.push(entry.path);
            }
        }
    }
    for orphan in &report.orphans {
        eprintln!("[core] branch reconcile: orphan worktree {orphan} (no session references it; left untouched)");
    }
    report
}

/// 路径比较（Windows 上盘符大小写与分隔符差异不该判成不同路径）
fn same_path(a: &str, b: &str) -> bool {
    normalize_path(a) == normalize_path(b)
}

fn normalize_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
#[path = "worktree_tests.rs"]
mod tests;

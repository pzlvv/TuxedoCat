//! 仓库探测与脏工作区判定（specs/037 FR-003）。
//!
//! 全部事实来自 git 命令的真实输出：
//! - 仓库判定：`git rev-parse --show-toplevel`（失败即「不在仓库内」）；
//! - 未提交改动：`git status --porcelain` 非空；
//! - 基准提交：`git rev-parse --short HEAD`。
//!
//! 不解析 `.git/` 内部格式（git 私有实现，跨版本会变，specs/037 FR-001）。

use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{json, Value};

/// 单条 git 命令的超时（毫秒）。
///
/// git 正常在毫秒级返回；这里靠 `wait_timeout` 轮询而不是无限等待——仓库锁被占、
/// 网络文件系统挂住时不能让 Core 的会话建立链跟着挂死。
pub const GIT_TIMEOUT_MS: u64 = 10_000;

/// 一次 git 调用的结果（stdout / stderr 原文，不做解析式判定）
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    /// 退出码为 0
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }

    /// 失败时的诊断文本（stderr 优先，空则 stdout，再空则退出码）——原样透出，
    /// 不猜原因（specs/037 plan「git 调用方式」）。
    pub fn error_text(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_string();
        }
        let stdout = self.stdout.trim();
        if !stdout.is_empty() {
            return stdout.to_string();
        }
        match self.status {
            Some(code) => format!("git exited with code {code}"),
            None => "git did not exit (timeout)".to_string(),
        }
    }
}

/// 在 `dir` 里执行一条 git 命令。
///
/// 固定 `-C <dir>`：不依赖 Core 进程的 cwd（宿主启动 Core 时 cwd 不可控）。
pub fn git_in(dir: &Path, args: &[&str]) -> GitOutput {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    run_with_timeout(command, GIT_TIMEOUT_MS)
}

/// 执行命令并按超时轮询收尾；超时即 kill 并返回 `status: None`。
fn run_with_timeout(mut command: Command, timeout_ms: u64) -> GitOutput {
    crate::util::hide_console(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return GitOutput {
                status: None,
                stdout: String::new(),
                stderr: format!("failed to spawn git: {err}"),
            };
        }
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return GitOutput {
                    status: None,
                    stdout: String::new(),
                    stderr: format!("git timed out after {timeout_ms}ms"),
                };
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(err) => {
                return GitOutput {
                    status: None,
                    stdout: String::new(),
                    stderr: format!("failed to wait for git: {err}"),
                };
            }
        }
    }
    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(err) => {
            return GitOutput {
                status: None,
                stdout: String::new(),
                stderr: format!("failed to collect git output: {err}"),
            };
        }
    };
    GitOutput {
        status: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// 仓库事实：根目录、git 目录、当前 HEAD 提交。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoFacts {
    /// 工作树根（`git rev-parse --show-toplevel` 的绝对路径）
    pub root: String,
    /// git 目录（普通仓库是 `<root>/.git`；worktree 里是 `<root>/.git/worktrees/<id>`）
    pub git_dir: String,
    /// `git rev-parse HEAD` 的完整提交 id
    pub head: String,
}

/// 探测 `dir` 所在的 git 仓库。
///
/// 判定完全是 git 的口径：不在仓库内 / 不是目录 / git 不可用都返回 `Err(detail)`，
/// 由调用方翻译成 `not-git`（specs/037 FR-003「仓库前置」）。
pub fn detect_repo(dir: &Path) -> Result<RepoFacts, String> {
    if !dir.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let top = git_in(dir, &["rev-parse", "--show-toplevel"]);
    if !top.ok() {
        return Err(top.error_text());
    }
    let root = top.stdout.trim();
    if root.is_empty() {
        return Err("git rev-parse --show-toplevel printed nothing".to_string());
    }
    let git_dir = git_in(Path::new(root), &["rev-parse", "--absolute-git-dir"]);
    if !git_dir.ok() {
        return Err(git_dir.error_text());
    }
    let head = git_in(Path::new(root), &["rev-parse", "HEAD"]);
    let head = if head.ok() {
        head.stdout.trim().to_string()
    } else {
        // 空仓库（还没有任何提交）时 `rev-parse HEAD` 失败：分支对话必须从某个提交
        // 起，这里按「无基准则不能建分支」处理，原因原样透出
        return Err(head.error_text());
    };
    Ok(RepoFacts {
        root: root.to_string(),
        git_dir: git_dir.stdout.trim().to_string(),
        head,
    })
}

/// 当前分支名（`git rev-parse --abbrev-ref HEAD`；分离 HEAD 时为 `HEAD`）
pub fn current_branch(root: &str) -> Result<String, String> {
    let output = git_in(Path::new(root), &["rev-parse", "--abbrev-ref", "HEAD"]);
    if !output.ok() {
        return Err(output.error_text());
    }
    Ok(output.stdout.trim().to_string())
}

/// 主工作区是否有未提交改动（含未跟踪文件）。
///
/// 只做「有 / 没有」的判定，不做解析：`git status --porcelain` 的转义规则随版本变，
/// 我们只需要非空这个事实（specs/037 FR-003「未提交改动」）。
pub fn is_dirty(root: &str) -> Result<bool, String> {
    let output = git_in(Path::new(root), &["status", "--porcelain"]);
    if !output.ok() {
        return Err(output.error_text());
    }
    Ok(!output.stdout.trim().is_empty())
}

/// `git rev-parse --short HEAD` 的短 id（创建入口的 `<base>` 展示用）
pub fn short_head(root: &str) -> Result<String, String> {
    let output = git_in(Path::new(root), &["rev-parse", "--short", "HEAD"]);
    if !output.ok() {
        return Err(output.error_text());
    }
    Ok(output.stdout.trim().to_string())
}

/// `git check-ignore <name>`：该路径名是否被 `.gitignore` 忽略。
///
/// 未忽略时 git 以退出码 1 结束且不输出——这是正常的「否」，不是错误。
pub fn is_ignored(root: &str, name: &str) -> bool {
    let output = git_in(Path::new(root), &["check-ignore", "-q", "--", name]);
    output.status == Some(0)
}

/// 该目录是否在 git 的忽略规则外但已被跟踪（判断单文件配置时用：已跟踪的名字
/// worktree 里本来就有，不该再链接）
pub fn is_tracked(root: &str, name: &str) -> bool {
    let output = git_in(Path::new(root), &["ls-files", "--error-unmatch", "--", name]);
    output.status == Some(0)
}

/// `UiRequest.branchPrecheckRequested` 的应答（specs/037 FR-003 / FR-008）。
///
/// 会话建立前没有 `branchStateChanged`，创建入口的数据只有这一条来源：
/// 是否 git 仓库、`<base>` 短 id、脏工作区判定。
pub fn precheck(workspace: &Path) -> Value {
    match detect_repo(workspace) {
        Ok(facts) => {
            let dirty = is_dirty(&facts.root).unwrap_or(false);
            let short = short_head(&facts.root).unwrap_or_else(|_| trim_commit(&facts.head));
            let base_branch = current_branch(&facts.root).unwrap_or_else(|_| "HEAD".to_string());
            json!({
                "ok": true,
                "head": short,
                "dirty": dirty,
                "baseBranch": base_branch,
            })
        }
        Err(detail) => json!({ "ok": false, "reason": "not-git", "detail": detail }),
    }
}

/// 提交 id 的短形态（短形态命令失败时的兜底：取前 7 位，与 git 的默认长度一致）
pub fn trim_commit(commit: &str) -> String {
    commit.chars().take(7).collect()
}

/// `git worktree list --porcelain` 解析结果的一行。
///
/// 只认 `worktree <path>` / `branch refs/heads/<name>` / `HEAD <commit>` 三个字段——
/// 这是 git 的**公开**输出格式（不是 `.git/worktrees/` 的内部文件格式）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
}

impl WorktreeEntry {
    /// 该条目的分支名（去掉 `refs/heads/` 前缀）；分离 HEAD 时为 `None`
    pub fn branch_name(&self) -> Option<&str> {
        self.branch
            .as_deref()
            .and_then(|reference| reference.strip_prefix("refs/heads/"))
    }
}

/// 枚举仓库的全部工作树（含主工作区）。
pub fn list_worktrees(root: &str) -> Result<Vec<WorktreeEntry>, String> {
    let output = git_in(Path::new(root), &["worktree", "list", "--porcelain"]);
    if !output.ok() {
        return Err(output.error_text());
    }
    Ok(parse_worktree_list(&output.stdout))
}

/// 解析 `git worktree list --porcelain` 的输出。
///
/// 格式：每条记录一段，字段行 `key value`，记录之间空一行；未知键忽略（git 后续
/// 版本可能加字段，忽略未知键才是「不解析私有格式」的态度）。
pub fn parse_worktree_list(text: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in text.lines() {
        if line.trim().is_empty() {
            if let Some(entry) = current.take() {
                entries.push(entry);
            }
            continue;
        }
        let mut parts = line.splitn(2, ' ');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("").trim();
        match key {
            "worktree" => {
                if let Some(entry) = current.take() {
                    entries.push(entry);
                }
                current = Some(WorktreeEntry {
                    path: value.to_string(),
                    branch: None,
                    head: None,
                });
            }
            "branch" if current.is_some() => {
                if let Some(entry) = current.as_mut() {
                    entry.branch = Some(value.to_string());
                }
            }
            "HEAD" if current.is_some() => {
                if let Some(entry) = current.as_mut() {
                    entry.head = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    if let Some(entry) = current {
        entries.push(entry);
    }
    entries
}

/// 分支是否存在（`tuxedo/<name>` 或任意名字）
pub fn branch_exists(root: &str, ref_name: &str) -> bool {
    let output = git_in(
        Path::new(root),
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{ref_name}"),
        ],
    );
    output.status == Some(0)
}

#[cfg(test)]
#[path = "repo_tests.rs"]
mod tests;

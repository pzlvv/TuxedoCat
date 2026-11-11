//! Overlay 对话视图里的 git 取数（specs/047 FR-001 / FR-004 / FR-005）。
//!
//! ## 为什么在「绑定后的路径」上跑 git
//!
//! 变更清单要的是「工作区相对 HEAD 的改动」，而 git 需要从 cwd 向上找到 `.git`、再按仓库
//! 口径算相对路径。实测三条路线：
//!
//! | 做法 | 工作区 = 仓库根 | 工作区 = 仓库子目录 |
//! | --- | --- | --- |
//! | 直接在挂载点上跑 `git -C <mount>` | 失败（挂载点父目录不在仓库里） | 失败 |
//! | 加 `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` | 成功 | 失败 |
//! | `--git-dir=<磁盘 .git> --work-tree=<mount>` | 成功 | 成功，但 `diff` 带仓库前缀、`ls-files --others` 不带 |
//!
//! 第三条把「前缀拼接」变成第二份路径逻辑。这里改用 Core 已有的通路：子进程在私有挂载
//! 命名空间里把视图 bind 到**真实工作区路径**上再 chdir 进去
//! （`work_view::bind_view_onto_workspace`，Bash 走的就是它）。bind 之后 git 看到的仍是
//! 「真实工作区路径 + 视图内容」，向上找 `.git` 与磁盘同一套规则，输出的路径也天然是
//! 工作区相对。
//!
//! ## 为什么要有临时索引
//!
//! git 会在 stat 信息陈旧时重写 `.git/index`。视图里的 `upper/.git/index` 一旦出现，
//! 用户的私有层就多出一个自己没改过的条目（对话内 `git status` 也会看到它）。
//! 实测 `--no-optional-locks` **不足以**避免（mtime 陈旧时仍会 copy-up 出 `upper/.git`）。
//! 因此取数前把索引复制到视图外的临时文件并用 `GIT_INDEX_FILE` 指过去，同时关掉
//! `core.untrackedCache` / `core.fsmonitor`：实测后 `upper/` 只剩用户自己改过的文件。
//!
//! ## HEAD 侧
//!
//! `git show HEAD:./<rel>` 用相对 cwd 的路径写法，在仓库根与子目录两种工作区下都成立
//! （实测），不必自己拼仓库前缀。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// 取数临时索引的序号：清单与两侧原文可能并发请求，共用一份索引会让两个 git 写同一个文件。
static SCRATCH_SEQ: AtomicU64 = AtomicU64::new(0);

/// 单条 git 命令的超时。视图取数是只读查询，正常几十毫秒；卡住说明仓库状态异常。
const GIT_TIMEOUT: Duration = Duration::from_secs(20);

/// 变更清单的取数范围（与宿主 `ChangeScope` 同一判别值）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeScope {
    Doc,
    All,
}

impl ChangeScope {
    /// `'doc' | 'all'` → 范围；其余按非法输入拒绝（不猜一个默认范围出来）。
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "doc" => Ok(ChangeScope::Doc),
            "all" => Ok(ChangeScope::All),
            other => Err(format!("scope 只能是 'doc' 或 'all'，收到 {other}")),
        }
    }

    /// pathspec 的唯一定义处：`'--'` 之后为空表示「全匹配」，因此 `All` 返回空数组。
    fn pathspec(self) -> &'static [&'static str] {
        match self {
            ChangeScope::Doc => &["*.md", "*.markdown"],
            ChangeScope::All => &[],
        }
    }
}

/// 一条变更条目（与宿主 `DocEntry` / `WorkViewChangeEntry` 同构）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeEntry {
    pub path: String,
    pub plus: u64,
    pub minus: u64,
}

/// 变更清单的取数结果。`NotAGitWorkspace` 是**事实**而不是界面文案
/// （`docs/architecture/principles.md` 第 6 节）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangesOutcome {
    Ready(Vec<ChangeEntry>),
    NotAGitWorkspace,
}

/// 文件两侧原文的取数结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileDiffOutcome {
    /// 非 git 工作区：只有内容（没有 HEAD 这个概念）
    NotAGitWorkspace { after: String },
    /// `before` 为 `None` = 该文件没有 HEAD 版本（新增）
    Git {
        before: Option<String>,
        after: String,
    },
}

/// 一次取数的执行体：在 bind 后的工作区路径上跑 git。
///
/// `workspace` 是真实工作区路径（bind 的目标）、`mount` 是视图挂载点。内容差异全部来自
/// 视图，`workspace` 只是路径字符串。
pub struct GitView<'a> {
    pub workspace: &'a Path,
    pub mount: &'a Path,
    /// 视图外的临时目录（放索引副本），保证取数不写进视图
    pub scratch: &'a Path,
}

impl<'a> GitView<'a> {
    /// 列视图里相对 HEAD 的改动（含未跟踪，已删除与纯重命名不显示）。
    pub fn changes(&self, scope: ChangeScope) -> Result<ChangesOutcome, String> {
        let mut run = self.prepare_runner()?;
        // 先判「在不在仓库里」：不在时 `rev-parse --verify -q HEAD` 会以非零退出并带 fatal
        // 文案，先判能把它转成「不是 git 工作区」这个事实而不是错误。
        if !run.is_inside_git_work_tree()? {
            return Ok(ChangesOutcome::NotAGitWorkspace);
        }
        if !run.has_head()? {
            // 全新仓（无 HEAD）：索引里的全部按全文新增计
            return Ok(ChangesOutcome::Ready(run.entries_without_head(scope)?));
        }
        run.sync_index_to_head()?;
        Ok(ChangesOutcome::Ready(run.entries_against_head(scope)?))
    }

    /// 取文件两侧原文：`before` 来自视图里的 HEAD，`after` 来自视图内容。
    pub fn file_diff(&self, rel: &str) -> Result<FileDiffOutcome, String> {
        let mut run = self.prepare_runner()?;
        let after = run.read_view_file(rel)?;
        if !run.is_inside_git_work_tree()? {
            return Ok(FileDiffOutcome::NotAGitWorkspace { after });
        }
        if !run.has_head()? {
            return Ok(FileDiffOutcome::Git {
                before: None,
                after,
            });
        }
        // `git show HEAD:./<rel>` 不读索引，因此这里不必 `read-tree`：两侧原文与索引无关。
        let before = run.head_version(rel)?;
        Ok(FileDiffOutcome::Git { before, after })
    }

    /// 建临时索引：所有 git 命令都只写视图外的这份副本，视图与磁盘的索引都不被改动。
    ///
    /// 起点按「视图优先、磁盘兜底」挑一份（`mount/.git/index` → `workspace/.git/index`）：
    /// 工作区是仓库子目录时 git 目录在视图之外，只有磁盘那一份可用；工作区就是仓库根时
    /// 视图里的索引才是对话自己的那份。
    ///
    /// **真正的准头来自 `sync_index_to_head`**：有 HEAD 时一律 `read-tree HEAD` 从视图里的
    /// HEAD 重建索引，因此「对话内自己 commit 过」这类分歧不会靠复制挑对文件来解决
    /// （实测：拿磁盘索引时，对话内 commit 掉的文件仍被当成未跟踪文件列出来）。
    ///
    /// 索引缺失（全新仓还没 `add` 过 / 不在仓库里）时不复制：前者 git 用空索引正常工作，
    /// 后者后续命令会如实回「不是 git 仓库」。
    fn prepare_runner(&self) -> Result<Runner<'a>, String> {
        std::fs::create_dir_all(self.scratch)
            .map_err(|error| format!("建取数临时目录失败：{error}"))?;
        let seq = SCRATCH_SEQ.fetch_add(1, Ordering::Relaxed);
        let index = self
            .scratch
            .join(format!("index-{}-{seq}", std::process::id()));
        let mut probe = Runner {
            workspace: self.workspace,
            mount: self.mount,
            index: None,
        };
        // 索引候选：视图里那份优先（工作区既可以是仓库根也可以是子目录，子目录时只有
        // 磁盘那份存在）。真正的分歧由 `sync_index_to_head` 抹平。
        let candidates = [self.mount.join(".git").join("index"), {
            match probe.git_path_index()? {
                Some(relative) if relative.is_absolute() => relative,
                Some(relative) => self.workspace.join(relative),
                None => self.workspace.join(".git").join("index"),
            }
        }];
        for source in candidates {
            if let Ok(bytes) = std::fs::read(&source) {
                std::fs::write(&index, bytes)
                    .map_err(|error| format!("复制索引到 {} 失败：{error}", index.display()))?;
                break;
            }
        }
        Ok(Runner {
            workspace: self.workspace,
            mount: self.mount,
            index: Some(index),
        })
    }
}

/// 一次取数过程中共享的执行上下文（临时索引与 bind 目标）。
struct Runner<'a> {
    workspace: &'a Path,
    mount: &'a Path,
    /// 视图外的索引副本；`None` = 只跑不改索引的探测命令（解析索引位置时）
    index: Option<PathBuf>,
}

impl<'a> Runner<'a> {
    /// 跑一条 git 命令（在 bind 后的工作区里）。返回 (退出码, stdout, stderr)。
    fn git(&mut self, args: &[&str]) -> Result<(i32, String, String), String> {
        let mut command = Command::new("git");
        command
            .args([
                "--no-optional-locks",
                "-c",
                "core.quotepath=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "core.fsmonitor=false",
            ])
            .args(args)
            .current_dir(self.workspace)
            // 子目录工作区：bind 之后挂载点与仓库祖先不再同一条设备，跨文件系统发现要显式开
            .env("GIT_DISCOVERY_ACROSS_FILESYSTEM", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(index) = &self.index {
            command.env("GIT_INDEX_FILE", index);
        }
        crate::util::hide_console(&mut command);
        crate::shell_env::apply_native(&mut command)?;

        // 必须在**子进程**里取一份私有挂载命名空间副本再 bind：unshare 只影响调用者及其
        // 子孙，放在 Core 进程里会污染它自己的挂载表。
        #[cfg(target_os = "linux")]
        {
            let mount = self.mount.to_path_buf();
            let workspace = self.workspace.to_path_buf();
            unsafe {
                use std::os::unix::process::CommandExt;
                command.pre_exec(move || {
                    crate::work_view::bind_view_onto_workspace(&mount, &workspace)
                        .map_err(|reason| std::io::Error::other(reason))
                });
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            return Err("Overlay 对话只在 Linux Core 上可用".to_string());
        }

        #[cfg(target_os = "linux")]
        {
            let mut child = command
                .spawn()
                .map_err(|error| format!("启动 git 失败：{error}"))?;
            let stdout_handle = child.stdout.take().map(read_async);
            let stderr_handle = child.stderr.take().map(read_async);
            let deadline = Instant::now() + GIT_TIMEOUT;
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(format!(
                                "git {} 超时（{}s）",
                                args.join(" "),
                                GIT_TIMEOUT.as_secs()
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        let _ = child.kill();
                        return Err(format!("等待 git 失败：{error}"));
                    }
                }
            }
            let code = child
                .wait()
                .ok()
                .and_then(|status| status.code())
                .unwrap_or(-1);
            Ok((code, join_reader(stdout_handle), join_reader(stderr_handle)))
        }
    }

    /// `git rev-parse --git-path index`：索引的实际位置（相对 cwd 或绝对）。
    ///
    /// 不在仓库里时回 `None`——调用方随后跑的探测命令会把「不是 git 仓库」如实报出来。
    fn git_path_index(&mut self) -> Result<Option<PathBuf>, String> {
        let (code, stdout, _) = self.git(&["rev-parse", "--git-path", "index"])?;
        if code != 0 {
            return Ok(None);
        }
        let text = stdout.trim();
        if text.is_empty() {
            return Ok(None);
        }
        Ok(Some(PathBuf::from(text)))
    }

    /// 有 HEAD 时把临时索引重建为「视图 HEAD 的内容」。
    ///
    /// 复制哪一份索引都不如直接照 HEAD 重建准：对话内自己 commit / `git add` 之后，视图里
    /// 的索引与磁盘的完全不同——拿磁盘的会让**已在 HEAD 里的文件被当成未跟踪文件**列进变更
    /// 清单（实测过一次 commit 就复现）。`read-tree` 只写临时索引（`GIT_INDEX_FILE`），
    /// 视图与磁盘的 `.git/index` 都不动。
    fn sync_index_to_head(&mut self) -> Result<(), String> {
        let (code, _, stderr) = self.git(&["read-tree", "HEAD"])?;
        if code != 0 {
            return Err(format!("git read-tree HEAD 失败：{}", stderr.trim()));
        }
        Ok(())
    }

    fn is_inside_git_work_tree(&mut self) -> Result<bool, String> {
        let (code, stdout, stderr) = self.git(&["rev-parse", "--is-inside-work-tree"])?;
        if code != 0 {
            // 不在仓库里是**事实**（不是执行失败）：git 以非零退出码报它
            if stderr.contains("not a git repository") {
                return Ok(false);
            }
            return Err(format!("git rev-parse 失败：{}", stderr.trim()));
        }
        Ok(stdout.trim() == "true")
    }

    fn has_head(&mut self) -> Result<bool, String> {
        let (code, _, stderr) = self.git(&["rev-parse", "--verify", "-q", "HEAD"])?;
        if code == 0 {
            return Ok(true);
        }
        if stderr.trim().is_empty() {
            // `--verify -q` 对「没有 HEAD」静默失败（无 stderr），这是合法事实
            return Ok(false);
        }
        Err(format!("git rev-parse HEAD 失败：{}", stderr.trim()))
    }

    /// 有 HEAD：`diff --numstat -M` + 未跟踪文件，过滤已删除与纯重命名。
    fn entries_against_head(&mut self, scope: ChangeScope) -> Result<Vec<ChangeEntry>, String> {
        let pathspec = scope.pathspec();
        // `--relative`：工作区是仓库子目录时把路径前缀去掉，输出与 `ls-files --others`
        // 同一口径（都是「工作区相对」），并顺带把工作区外的改动排除在外。
        let mut args = vec![
            "diff",
            "--numstat",
            "-M",
            "-z",
            "--relative",
            "--diff-filter=d",
            "HEAD",
            "--",
        ];
        args.extend_from_slice(pathspec);
        let (code, stdout, stderr) = self.git(&args)?;
        if code != 0 {
            return Err(format!("git diff 失败：{}", stderr.trim()));
        }
        let mut entries = parse_numstat_z(&stdout);

        for rel in self.untracked(scope)? {
            if entries.iter().any(|entry| entry.path == rel) {
                continue;
            }
            let lines = self
                .read_view_file(&rel)
                .map(|text| count_lines(&text) as u64)
                .unwrap_or(0);
            entries.push(ChangeEntry {
                path: rel,
                plus: lines,
                minus: 0,
            });
        }
        // 已删除的文件不显示（`--diff-filter=d` 已排除，这里兜住「索引里有、视图里没有」）
        entries.retain(|entry| self.view_path_exists(&entry.path));
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// 无 HEAD：索引里的全部按全文新增计。
    fn entries_without_head(&mut self, scope: ChangeScope) -> Result<Vec<ChangeEntry>, String> {
        let mut args = vec!["ls-files", "-z", "--"];
        args.extend_from_slice(scope.pathspec());
        let (code, stdout, stderr) = self.git(&args)?;
        if code != 0 {
            return Err(format!("git ls-files 失败：{}", stderr.trim()));
        }
        let mut entries: Vec<ChangeEntry> = Vec::new();
        for rel in parse_paths_z(&stdout) {
            if !self.view_path_exists(&rel) {
                continue;
            }
            let lines = self
                .read_view_file(&rel)
                .map(|text| count_lines(&text) as u64)
                .unwrap_or(0);
            entries.push(ChangeEntry {
                path: rel,
                plus: lines,
                minus: 0,
            });
        }
        for rel in self.untracked(scope)? {
            if entries.iter().any(|entry| entry.path == rel) {
                continue;
            }
            let lines = self
                .read_view_file(&rel)
                .map(|text| count_lines(&text) as u64)
                .unwrap_or(0);
            entries.push(ChangeEntry {
                path: rel,
                plus: lines,
                minus: 0,
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// 未跟踪文件（遵循 `.gitignore`）。`ls-files --others` 输出的路径已是工作区相对。
    fn untracked(&mut self, scope: ChangeScope) -> Result<Vec<String>, String> {
        let mut args = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
        args.extend_from_slice(scope.pathspec());
        let (code, stdout, stderr) = self.git(&args)?;
        if code != 0 {
            return Err(format!("git ls-files --others 失败：{}", stderr.trim()));
        }
        Ok(parse_paths_z(&stdout))
    }

    /// `git show HEAD:./<rel>`：相对 cwd 的写法在仓库根与子目录两种工作区下都成立。
    fn head_version(&mut self, rel: &str) -> Result<Option<String>, String> {
        let spec = format!("HEAD:./{rel}");
        let (code, stdout, stderr) = self.git(&["show", &spec])?;
        if code == 0 {
            return Ok(Some(stdout));
        }
        // 该路径不在 HEAD 里 = 新增（git 的报错有英文与本地化两版）
        let missing = [
            "does not exist",
            "exists on disk, but not in",
            "不在",
            "不存在",
        ];
        if missing.iter().any(|needle| stderr.contains(needle)) {
            return Ok(None);
        }
        Err(format!("git show 失败：{}", stderr.trim()))
    }

    /// 视图里的文件内容与存在性都经挂载点读——`workspace` 路径在 Core 进程内仍指向磁盘。
    fn read_view_file(&self, rel: &str) -> Result<String, String> {
        let target = self.mount.join(rel);
        std::fs::read_to_string(&target)
            .map_err(|error| format!("读取视图文件 {} 失败：{error}", target.display()))
    }

    fn view_path_exists(&self, rel: &str) -> bool {
        self.mount.join(rel).is_file()
    }
}

/// 读管道：与子进程并发读，避免大输出时双方互等（与 `rg` 同一口径）。
fn read_async(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = pipe.read_to_end(&mut buffer);
        buffer
    })
}

fn join_reader(handle: Option<std::thread::JoinHandle<Vec<u8>>>) -> String {
    let bytes = handle.and_then(|h| h.join().ok()).unwrap_or_default();
    String::from_utf8_lossy(&bytes).to_string()
}

/// `git diff --numstat -z` 的输出解析（实测形态见模块注释与用例）。
///
/// 普通条目：`<add>\t<del>\t<path>\0`；
/// 重命名条目：`<add>\t<del>\t\0<old>\0<new>\0`（路径在第三段之后另起两项）。
///
/// 重命名取新名；纯重命名（0/0）与二进制（`-`）跳过——与宿主侧 `parseNumstat` 同口径。
pub fn parse_numstat_z(stdout: &str) -> Vec<ChangeEntry> {
    let mut entries = Vec::new();
    let mut parts = stdout.split('\0').filter(|part| !part.is_empty());
    while let Some(head) = parts.next() {
        let mut fields = head.splitn(3, '\t');
        let add = fields.next().unwrap_or("");
        let del = fields.next().unwrap_or("");
        let path = fields.next().unwrap_or("");
        if add == "-" || del == "-" {
            continue; // 二进制
        }
        let (Ok(plus), Ok(minus)) = (add.parse::<u64>(), del.parse::<u64>()) else {
            continue;
        };
        let target = if path.is_empty() {
            // 重命名：紧接着的两段是 old / new
            let _old = parts.next();
            match parts.next() {
                Some(new_path) => new_path.to_string(),
                None => continue,
            }
        } else {
            path.to_string()
        };
        if target.is_empty() || (plus == 0 && minus == 0) {
            continue; // 纯重命名 / 仅位置变更
        }
        entries.push(ChangeEntry {
            path: target,
            plus,
            minus,
        });
    }
    entries
}

/// `git ls-files -z` 的输出解析：每段一个路径（原样保留，不 trim——文件名允许首尾空格）。
pub fn parse_paths_z(stdout: &str) -> Vec<String> {
    stdout
        .split('\0')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

/// 计行（git 口径）：末尾换行不另计一行；空文件 0 行（与宿主 `countLines` 同一份口径）。
pub fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let mut lines = text.matches('\n').count();
    if !text.ends_with('\n') {
        lines += 1;
    }
    lines
}

#[cfg(test)]
#[path = "work_view_changes_tests.rs"]
mod tests;

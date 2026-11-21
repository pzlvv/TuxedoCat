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
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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

/// 一条变更条目的状态字母（与宿主 `ChangeStatus` 同一份判别值，specs/055 FR-002）。
///
/// 只有三个：`A` 新增（该路径在 HEAD 里没有版本）、`M` 修改（含已暂存）、`R` 重命名。
/// 已删除的条目不进清单，因此没有 `D`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    Added,
    Modified,
    Renamed,
}

impl ChangeStatus {
    /// 序列化用的单字母（与宿主渲染的字母同一个值）
    pub fn letter(self) -> &'static str {
        match self {
            ChangeStatus::Added => "A",
            ChangeStatus::Modified => "M",
            ChangeStatus::Renamed => "R",
        }
    }
}

/// 一条变更条目（与宿主 `DocEntry` / `WorkViewChangeEntry` 同构）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeEntry {
    pub path: String,
    pub plus: u64,
    pub minus: u64,
    /// 状态字母的来源（specs/055 FR-002）：`git diff --name-status` 的事实
    pub status: ChangeStatus,
    /// 重命名前的旧路径（工作区相对；仅 `Renamed` 有值）
    pub old_path: Option<String>,
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
    /// 真实工作区路径。视图已 bind 到它上面（specs/051），因此 git 在代理里用这条路径
    /// 就能看到叠加结果。
    pub workspace: &'a Path,
    /// 该会话的常驻挂载代理：所有 git 命令与文件读取都由它代执行。
    pub proxy: &'a std::sync::Arc<crate::mount_proxy::SessionProxy>,
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
            proxy: self.proxy,
            index: None,
        };
        // 索引候选：视图里那份优先（工作区既可以是仓库根也可以是子目录，子目录时只有
        // 磁盘那份存在）。真正的分歧由 `sync_index_to_head` 抹平。
        let candidates = [self.workspace.join(".git").join("index"), {
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
            proxy: self.proxy,
            index: Some(index),
        })
    }
}

/// 一次取数过程中共享的执行上下文（临时索引与 bind 目标）。
struct Runner<'a> {
    workspace: &'a Path,
    proxy: &'a std::sync::Arc<crate::mount_proxy::SessionProxy>,
    /// 视图外的索引副本；`None` = 只跑不改索引的探测命令（解析索引位置时）
    index: Option<PathBuf>,
}

impl<'a> Runner<'a> {
    /// 跑一条 git 命令（在视图里，经代理代执行）。返回 (退出码, stdout, stderr)。
    ///
    /// **不能在 Core 里 spawn**：Core 不在命名空间里（ADR-0018），它起的 git 看到的是
    /// 真实磁盘；视图的 bind 只有代理的子孙进程站在上面。
    fn git(&mut self, args: &[&str]) -> Result<(i32, String, String), String> {
        let mut argv: Vec<String> = vec![
            "git".to_string(),
            "--no-optional-locks".to_string(),
            "-c".to_string(),
            "core.quotepath=false".to_string(),
            "-c".to_string(),
            "core.untrackedCache=false".to_string(),
            "-c".to_string(),
            "core.fsmonitor=false".to_string(),
        ];
        argv.extend(args.iter().map(|item| item.to_string()));
        let mut env = crate::shell_env::child_env()?;
        // 子目录工作区：bind 之后挂载点与仓库祖先不再同一条设备，跨文件系统发现要显式开
        env.push("GIT_DISCOVERY_ACROSS_FILESYSTEM=1".to_string());
        // 视图里的 git 不该被系统级配置改变行为（与代理侧 `gitShow` 同一要求）
        env.push("GIT_CONFIG_NOSYSTEM=1".to_string());
        if let Some(index) = &self.index {
            env.push(format!("GIT_INDEX_FILE={}", index.display()));
        }
        let id = self.proxy.start_spawn(crate::mount_proxy::SpawnSpec {
            argv,
            cwd: self.workspace.to_path_buf(),
            env,
            stdin: None,
        })?;
        let outcome = self
            .proxy
            .wait_spawn(id, GIT_TIMEOUT, None, |_out, _err| {})?;
        Ok((
            outcome.code,
            String::from_utf8_lossy(&outcome.stdout).to_string(),
            String::from_utf8_lossy(&outcome.stderr).to_string(),
        ))
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

    /// 有 HEAD：`diff --numstat -M` + 未跟踪文件 + `diff --name-status` 的状态事实，
    /// 过滤已删除；纯重命名保留为 `R` 行（specs/055 FR-003）。
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
        // 状态事实（specs/055 FR-002）：与 numstat 同一份 pathspec、同一 `-M`，
        // 因此条目集一致、按新路径对齐。Core 不在网络往返链路上，多一次同进程 git
        // 不改变宿主的往返次数契约。
        let mut status_args = vec![
            "diff",
            "--name-status",
            "-z",
            "-M",
            "--relative",
            "--diff-filter=d",
            "HEAD",
            "--",
        ];
        status_args.extend_from_slice(pathspec);
        let (status_code, status_stdout, status_stderr) = self.git(&status_args)?;
        if status_code != 0 {
            return Err(format!(
                "git diff --name-status 失败：{}",
                status_stderr.trim()
            ));
        }
        let status_by_path: std::collections::HashMap<String, (ChangeStatus, Option<String>)> =
            parse_name_status_z(&status_stdout)
                .into_iter()
                .map(|entry| (entry.path, (entry.status, entry.old_path)))
                .collect();
        let mut entries = Vec::new();
        for entry in parse_numstat_z(&stdout) {
            let (status, old_path) = status_by_path
                .get(&entry.path)
                .cloned()
                .ok_or_else(|| format!("git 状态事实缺条目：{}", entry.path))?;
            // 仅文件模式变更（0/0 且非重命名）不列——与宿主 `parseNumstat` 同一口径
            if entry.plus == 0 && entry.minus == 0 && status != ChangeStatus::Renamed {
                continue;
            }
            entries.push(ChangeEntry {
                status,
                old_path: if status == ChangeStatus::Renamed {
                    old_path.or(entry.old_path)
                } else {
                    None
                },
                path: entry.path,
                plus: entry.plus,
                minus: entry.minus,
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
                status: ChangeStatus::Added,
                old_path: None,
            });
        }
        // 已删除的文件不显示（`--diff-filter=d` 已排除，这里兜住「索引里有、视图里没有」）
        entries.retain(|entry| self.view_path_exists(&entry.path));
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    /// 无 HEAD：索引里的全部按全文新增计（状态一律 `A`——相对空树全是新增）。
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
                status: ChangeStatus::Added,
                old_path: None,
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
                status: ChangeStatus::Added,
                old_path: None,
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

    /// 视图里的文件内容经代理读——`workspace` 路径在 Core 进程内仍指向磁盘，
    /// 只有代理的命名空间里它才是叠加结果。
    fn read_view_file(&self, rel: &str) -> Result<String, String> {
        let target = self.workspace.join(rel);
        let bytes = self
            .proxy
            .read_file(&target, None)
            .map_err(|error| format!("读取视图文件 {} 失败：{error}", target.display()))?;
        Ok(String::from_utf8_lossy(&bytes).to_string())
    }

    fn view_path_exists(&self, rel: &str) -> bool {
        let target = self.workspace.join(rel);
        self.proxy
            .stat(&target)
            .map(|facts| facts.is_file)
            .unwrap_or(false)
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

/// `git diff --numstat -z` 的一行（状态还没判，由调用方与 `--name-status` 合并）。
///
/// 与宿主 `NumstatEntry` 同构：`0/0` 不再在这里丢——纯重命名要作为 `R` 行显示
/// （specs/055 FR-003），该不该丢取决于 name-status 给的是不是 `R`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumstatRow {
    pub path: String,
    pub plus: u64,
    pub minus: u64,
    /// 重命名行在 numstat 里自带旧路径（`<add>\t<del>\t\0<old>\0<new>\0`）
    pub old_path: Option<String>,
}

/// `git diff --numstat -z` 的输出解析（实测形态见模块注释与用例）。
///
/// 普通条目：`<add>\t<del>\t<path>\0`；
/// 重命名条目：`<add>\t<del>\t\0<old>\0<new>\0`（路径在第三段之后另起两项）。
///
/// 重命名取新名并带上旧名；二进制（`-`）跳过。`0/0` 保留——见 `NumstatRow`。
pub fn parse_numstat_z(stdout: &str) -> Vec<NumstatRow> {
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
        let (target, old_path) = if path.is_empty() {
            // 重命名：紧接着的两段是 old / new
            let old = parts.next().map(str::to_string);
            match parts.next() {
                Some(new_path) => (new_path.to_string(), old.filter(|path| !path.is_empty())),
                None => continue,
            }
        } else {
            (path.to_string(), None)
        };
        if target.is_empty() {
            continue;
        }
        entries.push(NumstatRow {
            path: target,
            plus,
            minus,
            old_path,
        });
    }
    entries
}

/// `git diff --name-status -z` 的一条（specs/055 FR-002 的状态事实）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NameStatusRow {
    pub path: String,
    pub status: ChangeStatus,
    pub old_path: Option<String>,
}

/// `git diff --name-status -z -M` 的输出解析。
///
/// 形态：`<状态>\0<新路径>\0`，重命名 / 复制多一段旧路径：`R<score>\0<旧路径>\0<新路径>\0`。
/// 只认 `A` / `M` / `R`：`D` 已由 `--diff-filter=d` 剔掉，`C`（复制）按「新增」处理
/// （对用户来说是多了个文件），其它状态不进清单。
pub fn parse_name_status_z(stdout: &str) -> Vec<NameStatusRow> {
    let mut entries = Vec::new();
    let parts: Vec<&str> = stdout.split('\0').collect();
    let mut index = 0;
    while index < parts.len() {
        let raw_status = parts[index].trim_end_matches('\r');
        index += 1;
        if raw_status.is_empty() {
            continue;
        }
        let letter = raw_status.as_bytes()[0];
        if letter == b'R' || letter == b'C' {
            let old_path = parts.get(index).copied().unwrap_or("");
            let new_path = parts.get(index + 1).copied().unwrap_or("");
            index += 2;
            if new_path.is_empty() {
                continue;
            }
            entries.push(NameStatusRow {
                path: new_path.to_string(),
                status: if letter == b'C' {
                    ChangeStatus::Added
                } else {
                    ChangeStatus::Renamed
                },
                old_path: if old_path.is_empty() {
                    None
                } else {
                    Some(old_path.to_string())
                },
            });
            continue;
        }
        let path = parts.get(index).copied().unwrap_or("");
        index += 1;
        if path.is_empty() {
            continue;
        }
        match letter {
            b'A' => entries.push(NameStatusRow {
                path: path.to_string(),
                status: ChangeStatus::Added,
                old_path: None,
            }),
            // `T` = 类型变更（文件 ↔ 符号链接），按内容改动呈现
            b'M' | b'T' => entries.push(NameStatusRow {
                path: path.to_string(),
                status: ChangeStatus::Modified,
                old_path: None,
            }),
            _ => {}
        }
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

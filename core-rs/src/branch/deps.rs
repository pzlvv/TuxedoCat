//! 依赖目录与单文件配置策略（specs/037 FR-010）。
//!
//! 依赖目录（被 `.gitignore` 排除、体积大、路径敏感）不进 worktree。策略抽象成
//! [`DepStrategy`]，按平台与能力装配两档：
//!
//! | 实现 | 装配条件 | 行为 |
//! | --- | --- | --- |
//! | [`OverlayDeps`] | Linux 且 Core 进程**内**试挂 overlay 成功 | 只叠加主工作区里已存在的已知依赖目录 |
//! | [`SkipDeps`] | Windows / macOS / 探测失败 | 不搬，系统提示告知模型「依赖需自行安装」 |
//!
//! 探测失败不重试、不降级为符号链接（link 会让分支的安装直写主工作区，隔离失效，
//! specs/037 plan 被否决方案第 3 条）。退到 `SkipDeps` 是设计允许的档位，不是静默降级。
//!
//! 单文件本地配置（`.env` 等）**不走挂载**：在 worktree 内建符号链接指向主工作区原
//! 文件（按路径共享，主工作区一侧的原子替换保存也能实时跟上），链接失败退化为复制。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 已知依赖目录名（只叠加主工作区里**已存在**的那些，specs/037 FR-010）。
pub const KNOWN_DEP_DIRS: [&str; 7] = [
    "node_modules",
    "target",
    ".venv",
    "venv",
    "vendor",
    ".gradle",
    "build",
];

/// 单文件本地配置名单（符号链接共享，specs/037 FR-010）。
pub const LOCAL_CONFIG_FILES: [&str; 4] = [".env", ".env.local", ".npmrc", "local.properties"];

/// 依赖策略事实（供系统提示组装；**不进** `branchStateChanged` 载荷）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DepPolicy {
    /// 已挂载的依赖目录名义（相对主工作区根）
    pub mounted: Vec<String>,
    /// 装配档位：`overlay` / `skip`
    pub strategy: &'static str,
}

impl DepPolicy {
    /// 系统提示里那句依赖事实（英文常量：进 LLM 上下文，不参与键化）
    pub fn prompt_line(&self) -> String {
        if self.strategy == "overlay" && !self.mounted.is_empty() {
            format!(
                "Dependencies ({}): already available, shared with the user's main workspace; \
                 your installs only affect this branch (upper layer).",
                self.mounted.join(", ")
            )
        } else {
            "Dependencies: not installed in this worktree — install what you need \
             (global caches are present, so it is usually fast)."
                .to_string()
        }
    }
}

/// 一处已挂载的依赖目录
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountedDep {
    /// 挂载点（`<worktree>/<dir>`）
    pub target: PathBuf,
}

/// 依赖策略（两档实现的共同接口，`specs/037-branch-conversation/plan.md` 的「依赖目录：overlay 只叠加依赖子目录」一节）
pub trait DepStrategy: Send + Sync {
    /// 把主工作区的依赖目录叠进 worktree；返回实际挂上的挂载点
    fn install(&self, repo: &Path, worktree: &Path, branch: &str) -> Result<Vec<MountedDep>, String>;
    /// 卸载（必须在 `git worktree remove` **之前**调用）
    fn uninstall(&self, mounted: &[MountedDep]) -> Result<(), String>;
    /// 供系统提示组装的档位事实
    fn describe(&self, mounted: &[MountedDep]) -> DepPolicy;
}

// ==================== SkipDeps ====================

/// 不搬依赖（Windows / macOS / overlay 不可用）
#[derive(Debug, Default, Clone, Copy)]
pub struct SkipDeps;

impl DepStrategy for SkipDeps {
    fn install(
        &self,
        _repo: &Path,
        _worktree: &Path,
        _branch: &str,
    ) -> Result<Vec<MountedDep>, String> {
        Ok(Vec::new())
    }

    fn uninstall(&self, _mounted: &[MountedDep]) -> Result<(), String> {
        Ok(())
    }

    fn describe(&self, _mounted: &[MountedDep]) -> DepPolicy {
        DepPolicy {
            mounted: Vec::new(),
            strategy: "skip",
        }
    }
}

// ==================== OverlayDeps ====================

/// Linux overlayfs 只叠加依赖子目录（lower = 主工作区那份，upper = 分支自己的增量）。
///
/// upper 与 workdir 放在 **worktree 之外**的 `worktrees/deps/<branch>/`（specs/037
/// FR-010 的三个理由：不污染分支自己的 `git status`、不撞 `git worktree remove`、
/// upper 与 workdir 同一文件系统）。
#[derive(Debug, Default, Clone, Copy)]
pub struct OverlayDeps;

impl DepStrategy for OverlayDeps {
    fn install(&self, repo: &Path, worktree: &Path, branch: &str) -> Result<Vec<MountedDep>, String> {
        install_overlay_deps(repo, worktree, branch)
    }

    fn uninstall(&self, mounted: &[MountedDep]) -> Result<(), String> {
        uninstall_mounts(mounted)
    }

    fn describe(&self, mounted: &[MountedDep]) -> DepPolicy {
        DepPolicy {
            mounted: mounted
                .iter()
                .filter_map(|entry| {
                    entry
                        .target
                        .file_name()
                        .map(|name| name.to_string_lossy().to_string())
                })
                .collect(),
            strategy: "overlay",
        }
    }
}

/// upper / workdir 根：`<worktree 的父目录>/deps/<branch>/`
///
/// worktree 在 `<Core 数据目录>/<工作区>/worktrees/<branch>/`，父目录是
/// `<Core 数据目录>/<工作区>/worktrees/`，因此 upper 落在 `.../worktrees/deps/<branch>/`
/// ——与 worktree 平级、在 worktree 目录之外。
pub fn deps_root_for(worktree: &Path, branch: &str) -> Option<PathBuf> {
    worktree.parent().map(|parent| parent.join("deps").join(branch))
}

#[cfg(target_os = "linux")]
fn install_overlay_deps(repo: &Path, worktree: &Path, branch: &str) -> Result<Vec<MountedDep>, String> {
    let Some(root) = deps_root_for(worktree, branch) else {
        return Err(format!(
            "cannot derive deps root: {} has no parent",
            worktree.display()
        ));
    };
    let mut mounted: Vec<MountedDep> = Vec::new();
    for dir in KNOWN_DEP_DIRS {
        let lower = repo.join(dir);
        // 只叠加已存在的目录：不创建空 lower（specs/037 FR-010 / AC-27）
        if !lower.is_dir() {
            continue;
        }
        let target = worktree.join(dir);
        if target.exists() {
            // worktree 里已经有同名目录（被跟踪的目录 / 上次遗留）：不叠加，避免把
            // git 里的真实内容藏起来
            continue;
        }
        let upper = root.join(dir);
        let work = root.join(".work").join(dir);
        std::fs::create_dir_all(&upper)
            .map_err(|err| format!("mkdir {} failed: {err}", upper.display()))?;
        std::fs::create_dir_all(&work)
            .map_err(|err| format!("mkdir {} failed: {err}", work.display()))?;
        std::fs::create_dir_all(&target)
            .map_err(|err| format!("mkdir {} failed: {err}", target.display()))?;
        mount_overlay(&lower, &upper, &work, &target)?;
        mounted.push(MountedDep { target });
    }
    Ok(mounted)
}

#[cfg(not(target_os = "linux"))]
fn install_overlay_deps(_repo: &Path, _worktree: &Path, _branch: &str) -> Result<Vec<MountedDep>, String> {
    // 非 Linux 平台由 `probe_dep_strategy` 装配 `SkipDeps`，走到这里说明装配逻辑被
    // 绕过——直接报错而不是静默返回空（铁律 1）
    Err("overlay deps are only supported on Linux".to_string())
}

/// 挂一个 overlay（`mount -t overlay overlay -olowerdir=…,upperdir=…,workdir=… <target>`）
#[cfg(target_os = "linux")]
fn mount_overlay(lower: &Path, upper: &Path, work: &Path, target: &Path) -> Result<(), String> {
    let options = format!(
        "lowerdir={},upperdir={},workdir={}",
        lower.display(),
        upper.display(),
        work.display()
    );
    let output = run_mount(&["-t", "overlay", "overlay", "-o", &options], target)?;
    if output.status.code() == Some(0) {
        Ok(())
    } else {
        Err(format!(
            "mount overlay on {} failed: {}",
            target.display(),
            mount_error(&output)
        ))
    }
}

#[cfg(target_os = "linux")]
fn run_mount(args: &[&str], target: &Path) -> Result<std::process::Output, String> {
    let mut command = std::process::Command::new("mount");
    command
        .args(args)
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::util::hide_console(&mut command);
    command
        .output()
        .map_err(|err| format!("failed to run mount: {err}"))
}

#[cfg(target_os = "linux")]
fn mount_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    match output.status.code() {
        Some(code) => format!("mount exited with code {code}"),
        None => "mount did not exit".to_string(),
    }
}

/// 卸载所有挂载点（逆序，失败收集后一并报错）
fn uninstall_mounts(mounted: &[MountedDep]) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    for entry in mounted.iter().rev() {
        if let Err(error) = umount(&entry.target) {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(target_os = "linux")]
fn umount(target: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new("umount");
    command
        .arg(target)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::util::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|err| format!("failed to run umount: {err}"))?;
    if output.status.code() == Some(0) {
        Ok(())
    } else {
        Err(format!(
            "umount {} failed: {}",
            target.display(),
            mount_error(&output)
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn umount(_target: &Path) -> Result<(), String> {
    // 非 Linux 上不会有挂载点（装配的是 `SkipDeps`）
    Ok(())
}

// ==================== 装配与探测 ====================

static PROBED: Mutex<Option<bool>> = Mutex::new(None);

/// 装配依赖策略：进程内**一次**判定，结果缓存，失败不重试。
///
/// 探测方式是**在本进程内**实际试挂一个临时 overlay 再卸载（读 `/proc/filesystems`
/// 只看模块存在；`unshare` 子进程在独立命名空间里成功不代表多线程的 Core 进程自己
/// 能挂，specs/037 FR-010「探测时机」）。
pub fn probe_dep_strategy() -> Box<dyn DepStrategy> {
    let mut guard = PROBED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let usable = match *guard {
        Some(cached) => cached,
        None => {
            let probed = probe_overlay_support();
            *guard = Some(probed);
            probed
        }
    };
    if usable {
        Box::new(OverlayDeps)
    } else {
        Box::new(SkipDeps)
    }
}

/// 仅测试用：清掉探测缓存（换环境后重新判定）
#[cfg(test)]
pub fn reset_probe_cache() {
    *PROBED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// 进程内试挂一个临时 overlay（成功即卸载并返回 true）
#[cfg(target_os = "linux")]
fn probe_overlay_support() -> bool {
    let base = std::env::temp_dir().join(format!("tc-overlay-probe-{}", crate::util::random_suffix()));
    let lower = base.join("l");
    let upper = base.join("u");
    let work = base.join("w");
    let mount_point = base.join("m");
    let cleanup = || {
        let _ = std::fs::remove_dir_all(&base);
    };
    for dir in [&lower, &upper, &work, &mount_point] {
        if let Err(err) = std::fs::create_dir_all(dir) {
            eprintln!("[core] overlay probe: mkdir {} failed: {err}", dir.display());
            cleanup();
            return false;
        }
    }
    let result = match mount_overlay(&lower, &upper, &work, &mount_point) {
        Ok(()) => match umount(&mount_point) {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[core] overlay probe: {error}");
                false
            }
        },
        Err(error) => {
            eprintln!("[core] overlay probe: {error}");
            false
        }
    };
    cleanup();
    result
}

#[cfg(not(target_os = "linux"))]
fn probe_overlay_support() -> bool {
    // 无 overlay 等价物（specs/037 FR-010 的平台档位）
    false
}

// ==================== 单文件本地配置 ====================

/// 单文件本地配置的共享方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLink {
    /// 建了符号链接（按路径共享，主工作区更新实时传播）
    Linked,
    /// 符号链接失败，退化为创建时复制（主工作区后续更新不传播）
    Copied,
}

/// 处理结果：每个成功共享的文件及其方式
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedConfig {
    pub name: String,
    pub mode: ConfigLink,
}

/// 在 worktree 内共享单文件本地配置（specs/037 FR-010 / AC-36 / AC-37）。
///
/// 条件全部满足才处理：主工作区存在该文件、名字被 `.gitignore` 忽略（否则链接进来
/// 会以未跟踪文件污染该分支的 `git status`）、worktree 内不存在该名字。
pub fn link_local_configs(repo: &Path, worktree: &Path) -> Vec<LinkedConfig> {
    let repo_text = repo.to_string_lossy().to_string();
    let mut done: Vec<LinkedConfig> = Vec::new();
    for name in LOCAL_CONFIG_FILES {
        let source = repo.join(name);
        if !source.is_file() {
            continue;
        }
        // 未被忽略 / 已被跟踪：worktree 里本来就有，或链接会污染 `git status`，一律跳过
        if !crate::branch::repo::is_ignored(&repo_text, name) {
            continue;
        }
        if crate::branch::repo::is_tracked(&repo_text, name) {
            continue;
        }
        let target = worktree.join(name);
        if target.symlink_metadata().is_ok() {
            continue;
        }
        match create_symlink(&source, &target) {
            Ok(()) => done.push(LinkedConfig {
                name: name.to_string(),
                mode: ConfigLink::Linked,
            }),
            Err(error) => {
                // 符号链接失败（Windows 未开开发者模式 / 无权限）：退化为创建时复制。
                // 一次判定不重试，档位写诊断日志并进系统提示（AC-37）
                eprintln!("[core] branch config link {name} failed: {error}; falling back to copy");
                match std::fs::copy(&source, &target) {
                    Ok(_) => done.push(LinkedConfig {
                        name: name.to_string(),
                        mode: ConfigLink::Copied,
                    }),
                    Err(copy_error) => {
                        eprintln!("[core] branch config copy {name} failed: {copy_error}");
                    }
                }
            }
        }
    }
    done
}

/// 系统提示里的本地配置事实（英文常量：进 LLM 上下文）
pub fn describe_local_configs(configs: &[LinkedConfig]) -> Option<String> {
    let linked: Vec<&str> = configs
        .iter()
        .filter(|entry| entry.mode == ConfigLink::Linked)
        .map(|entry| entry.name.as_str())
        .collect();
    let copied: Vec<&str> = configs
        .iter()
        .filter(|entry| entry.mode == ConfigLink::Copied)
        .map(|entry| entry.name.as_str())
        .collect();
    if linked.is_empty() && copied.is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if !linked.is_empty() {
        parts.push(format!(
            "shared with the main workspace via symlink (treat as read-only; copy it first if you need to change it): {}",
            linked.join(", ")
        ));
    }
    if !copied.is_empty() {
        parts.push(format!(
            "copied at creation time (later changes in the main workspace do not propagate): {}",
            copied.join(", ")
        ));
    }
    Some(format!("Local config files — {}.", parts.join("; ")))
}

/// 列出 worktree 下**当前已挂载**的依赖目录（删除时按它卸载）。
///
/// 会话重启后内存里的挂载表已丢，只能按目录现状推断：Linux 上读
/// `/proc/self/mountinfo` 找挂载点前缀匹配；其余平台没有挂载，恒空。
pub fn mounted_under(worktree: &Path) -> Vec<MountedDep> {
    #[cfg(target_os = "linux")]
    {
        let prefix = worktree.to_string_lossy().to_string();
        let Ok(mountinfo) = std::fs::read_to_string("/proc/self/mountinfo") else {
            return Vec::new();
        };
        let mut mounted: Vec<MountedDep> = Vec::new();
        for line in mountinfo.lines() {
            let fields: Vec<&str> = line.split(' ').collect();
            if fields.len() < 5 {
                continue;
            }
            let mount_point = fields[4].replace("\\040", " ");
            if !mount_point.starts_with(&prefix) {
                continue;
            }
            mounted.push(MountedDep {
                target: PathBuf::from(mount_point),
            });
        }
        // 卸载逆序（与 install 的顺序相反）
        mounted.reverse();
        mounted
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = worktree;
        Vec::new()
    }
}

#[cfg(unix)]
fn create_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

#[cfg(windows)]
fn create_symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    // Windows 的 file symlink 需要开发者模式 / SeCreateSymbolicLinkPrivilege，
    // 失败由调用方退化为复制
    std::os::windows::fs::symlink_file(source, target)
}

#[cfg(test)]
#[path = "deps_tests.rs"]
mod tests;

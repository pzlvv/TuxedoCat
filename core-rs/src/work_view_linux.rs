//! 对话级 overlay 工作视图的 Linux 实现（specs/043）。
//!
//! 命名空间结构与 specs/043 的 plan 一致：
//!
//! ```text
//! run_core() 最早（单线程）
//!   unshare(CLONE_NEWUSER) + 写 id 映射     ← 拿到命名空间内的 CAP_SYS_ADMIN
//!   unshare(CLONE_NEWNS) + / 设为私有传播    ← 此后本进程的挂载不泄漏给宿主
//!
//! 每次工具 / Bash 子进程
//!   unshare(CLONE_NEWNS)                    ← 取一份私有挂载副本
//!   bind <视图挂载点> → <真实工作区路径>      ← 路径字符串不变，内容换成叠加结果
//!   exec
//! ```
//!
//! `CLONE_NEWUSER` 必须在单线程时执行：内核要求调用者 `mm_users == 1`，进程一旦有第二个
//! 线程就必然 `EINVAL`。

/// 本模块用到的内核接口：直接声明 FFI，不引 `libc` 依赖。
///
/// 理由：新增一个**直接**依赖会改变 cargo 的依赖图指纹，让 Windows 目标上的 C 依赖
/// （`ring`）重新编译，而本机没有 MSVC 的 `lib.exe`——一个纯 Linux 的 syscall 封装
/// 不该让 Windows 出包失败。`libc` 本身仍是传递依赖，但那是别的 crate 的事。
///
/// 常量值与 Linux 内核 ABI 一致（`include/uapi/linux/sched.h` /
/// `include/uapi/linux/mount.h`）。
mod sys {
    pub type CInt = i32;
    pub type CUInt = u32;
    pub type CULong = u64;

    pub const CLONE_NEWNS: CInt = 0x0002_0000;
    pub const CLONE_NEWUSER: CInt = 0x1000_0000;
    pub const MS_REC: CULong = 16384;
    pub const MS_PRIVATE: CULong = 1 << 18;
    pub const MS_BIND: CULong = 4096;

    extern "C" {
        pub fn unshare(flags: CInt) -> CInt;
        pub fn mount(
            source: *const std::os::raw::c_char,
            target: *const std::os::raw::c_char,
            fstype: *const std::os::raw::c_char,
            flags: CULong,
            data: *const std::os::raw::c_void,
        ) -> CInt;
        pub fn umount(target: *const std::os::raw::c_char) -> CInt;
        pub fn getuid() -> CUInt;
        pub fn getgid() -> CUInt;
    }
}

use super::Capabilities;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 已登记的工作视图：`sessionId` → 视图（会话删除 / 关闭按 id 回收）。
fn views() -> &'static Mutex<HashMap<String, WorkView>> {
    static VIEWS: OnceLock<Mutex<HashMap<String, WorkView>>> = OnceLock::new();
    VIEWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 进入命名空间的结果，供能力探测读取。
fn enter_result() -> &'static Mutex<Option<Result<(), String>>> {
    static RESULT: OnceLock<Mutex<Option<Result<(), String>>>> = OnceLock::new();
    RESULT.get_or_init(|| Mutex::new(None))
}

/// 本进程的挂载命名空间是否已建立（`enter` 成功过）。
pub fn entered() -> bool {
    matches!(enter_result().lock().map(|guard| guard.clone()), Ok(Some(Ok(()))))
}

/// 进入用户 + 挂载命名空间。`run_core()` 最早处调用一次；重复调用是 no-op。
///
/// 失败时记录原因而不 panic：能力探测据此回「不可用」，隔离视图对话退回真实磁盘执行
/// （specs/043 FR-007——这是设计允许的降级，必须留痕，不是静默降级）。
pub fn enter() {
    let mut slot = match enter_result().lock() {
        Ok(guard) => guard,
        Err(poison) => poison.into_inner(),
    };
    if slot.is_some() {
        return;
    }
    let result = enter_in_place();
    if let Err(reason) = &result {
        eprintln!("[core] 对话工作视图不可用：{reason}");
    }
    *slot = Some(result);
}

fn enter_in_place() -> Result<(), String> {
    if has_cap_sys_admin() {
        // 已在特权命名空间里（特权容器 / 已有 capabilities）：只补挂载命名空间
        return finish_mount_namespace();
    }
    // 身份必须在 unshare 之前取：进新用户命名空间、映射还没写的窗口里 getuid() 返回
    // 溢出值（65534），拿它写映射会被内核拒为 EPERM。
    let uid = unsafe { sys::getuid() };
    let gid = unsafe { sys::getgid() };
    unshare(sys::CLONE_NEWUSER).map_err(|error| format!("无法创建用户命名空间（{error}）"))?;
    write_id_maps(uid, gid)?;
    finish_mount_namespace()
}

fn finish_mount_namespace() -> Result<(), String> {
    unshare(sys::CLONE_NEWNS).map_err(|error| format!("无法创建挂载命名空间（{error}）"))?;
    // MS_REC | MS_PRIVATE：把 / 设为私有传播，本进程的挂载不会泄漏给宿主
    make_private(Path::new("/"))
        .map_err(|error| format!("无法把 / 设为私有挂载（{error}）"))
}

/// 把当前用户映射成命名空间内的 root。
///
/// 命名空间内 id 取 **0** 才是 `unshare -r` 的等价形态：只有映射成 0，进程在命名空间内
/// 才拿到完整能力集（含挂载所需的 `CAP_SYS_ADMIN`）。
fn write_id_maps(uid: u32, gid: u32) -> Result<(), String> {
    // setgroups 必须在 gid_map 之前禁用，否则写 gid_map 会被内核拒绝；老内核没有该文件
    if let Err(error) = std::fs::write("/proc/self/setgroups", "deny") {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(format!("写 /proc/self/setgroups 失败：{error}"));
        }
    }
    std::fs::write("/proc/self/uid_map", format!("0 {uid} 1"))
        .map_err(|error| format!("写 uid_map 失败：{error}"))?;
    std::fs::write("/proc/self/gid_map", format!("0 {gid} 1"))
        .map_err(|error| format!("写 gid_map 失败：{error}"))
}

/// `unshare(2)` 的薄封装：把 errno 转成可读错误。
fn unshare(flags: sys::CInt) -> Result<(), String> {
    if unsafe { sys::unshare(flags) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

/// `mount(2)` 的薄封装。`source` / `fstype` / `data` 用 `CString` 传，路径按字节原样给内核。
fn mount_fs(
    source: Option<&Path>,
    target: &Path,
    fstype: Option<&str>,
    flags: sys::CULong,
    data: Option<&str>,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let to_cstring = |text: &str| CString::new(text).map_err(|error| error.to_string());
    let source_c = match source {
        Some(path) => Some(CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?),
        None => None,
    };
    let target_c = CString::new(target.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let fstype_c = match fstype {
        Some(name) => Some(to_cstring(name)?),
        None => None,
    };
    let data_c = match data {
        Some(options) => Some(to_cstring(options)?),
        None => None,
    };
    let result = unsafe {
        sys::mount(
            source_c
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            target_c.as_ptr(),
            fstype_c
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            flags,
            data_c
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr() as *const std::os::raw::c_void),
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

/// 把某个挂载点设为私有传播（`MS_REC | MS_PRIVATE`）。
fn make_private(target: &Path) -> Result<(), String> {
    mount_fs(None, target, None, sys::MS_REC | sys::MS_PRIVATE, None)
}

/// `umount(2)` 的薄封装。
fn umount(target: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let target_c = CString::new(target.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    if unsafe { sys::umount(target_c.as_ptr()) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}

/// `CapEff` 的 bit 21 是 `CAP_SYS_ADMIN`。
fn has_cap_sys_admin() -> bool {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return false;
    };
    let Some(line) = status.lines().find(|line| line.starts_with("CapEff:")) else {
        return false;
    };
    let Some(value) = line.split(':').nth(1) else {
        return false;
    };
    u64::from_str_radix(value.trim(), 16)
        .map(|bits| bits & (1 << 21) != 0)
        .unwrap_or(false)
}

/// 能力探测：本机能否为对话建立隔离工作视图（specs/043 FR-001）。
pub fn capabilities() -> Capabilities {
    if !entered() {
        let reason = enter_result()
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None)
            .and_then(|result| result.err())
            .unwrap_or_else(|| "Core 尚未建立用户命名空间".to_string());
        return Capabilities::unavailable(reason);
    }
    // overlay 是否真的可挂：用一次性目录实测一次，失败把内核原因带出去——比只判
    // 命名空间更能解释「为什么勾选框不出现」。
    match probe_overlay() {
        Ok(()) => Capabilities::available(),
        Err(reason) => Capabilities::unavailable(reason),
    }
}

/// 用临时目录实测一次 overlay 挂载（含 `userxattr`）。
fn probe_overlay() -> Result<(), String> {
    let root = std::env::temp_dir().join(format!("tuxedo-overlay-probe-{}", std::process::id()));
    let lower = root.join("lower");
    let upper = root.join("upper");
    let work = root.join("work");
    let mount = root.join("mount");
    for dir in [&lower, &upper, &work, &mount] {
        std::fs::create_dir_all(dir).map_err(|error| format!("建探测目录失败：{error}"))?;
    }
    let result = mount_overlay(&lower, &upper, &work, &mount);
    if result.is_ok() {
        umount(mount.as_path()).ok();
    }
    let _ = std::fs::remove_dir_all(&root);
    result
}

fn mount_overlay(
    lower: &Path,
    upper: &Path,
    work: &Path,
    mount: &Path,
) -> Result<(), String> {
    // `userxattr` 不可省：非特权用户命名空间里不启用它时，删除**目录**会 EIO
    // （overlay 需要写 trusted.overlay.* 而当前用户没有该命名空间的 CAP_SYS_ADMIN）。
    let options = format!(
        "lowerdir={},upperdir={},workdir={},userxattr",
        lower.display(),
        upper.display(),
        work.display()
    );
    mount_fs(
        Some(Path::new("overlay")),
        mount,
        Some("overlay"),
        0,
        Some(options.as_str()),
    )
    .map_err(|error| format!("overlayfs 不可用（{error}）"))?;
    // `mount()` 返回 0 不等于挂载生效：命名空间或传播属性不对时它会静默无效，而
    // 调用方随后把工具路径映射到这个**空目录**上——工具看到的是空工作区，写入落到
    // 一个谁也读不到的地方，全程没有任何报错。读 mountinfo 确认挂载点真的出现在表里，
    // 不在就当作失败（`docs/architecture/principles.md` 铁律 4.1：不静默降级）。
    let mount_text = mount.to_string_lossy();
    let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let mounted = mountinfo
        .lines()
        .any(|line| line.split_whitespace().nth(4) == Some(mount_text.as_ref()));
    if mounted {
        Ok(())
    } else {
        let ns = std::fs::read_link("/proc/self/ns/mnt")
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "?".to_string());
        Err(format!(
            "overlay 挂载未生效（{} 不在 /proc/self/mountinfo 里，ns={ns}）",
            mount.display()
        ))
    }
}

/// 一个对话的工作视图。
#[derive(Clone)]
pub struct WorkView {
    /// 会话 id（登记表的键）。
    session_id: String,
    /// 视图的稳定标识（会话 id + 工作区派生的目录名）。
    key: String,
    /// 真实工作区路径（lowerdir，也是对外可见的路径）。
    workspace: PathBuf,
    /// 视图根目录（`upper` / `work` / `mount` 的父目录）。
    root: PathBuf,
    /// 挂载点（merged）。
    mount: PathBuf,
    /// 是否已挂载（惰性建立：登记 ≠ 已挂）。
    mounted: bool,
}

impl WorkView {
    /// 视图根目录：`<configHome>/work-views/<key>/`。
    pub fn root_of(workspace: &str, session_id: &str) -> Result<PathBuf, String> {
        Ok(crate::config::config_home()?
            .join("work-views")
            .join(session_key(workspace, session_id)))
    }

    /// 登记一个对话的视图（不挂载，首次使用时才建目录并挂）。
    ///
    /// 重复登记返回已有视图（会话重开时不该重建挂载）。
    pub fn register(workspace: &str, session_id: &str) -> Result<Self, String> {
        if !entered() {
            return Err("Core 尚未建立用户命名空间".to_string());
        }
        let mut views = views()
            .lock()
            .map_err(|error| format!("视图登记表损坏：{error}"))?;
        if views.contains_key(session_id) {
            return Err(format!("会话 {session_id} 已有工作视图"));
        }
        let root = Self::root_of(workspace, session_id)?;
        let view = WorkView {
            session_id: session_id.to_string(),
            key: session_key(workspace, session_id),
            workspace: PathBuf::from(workspace),
            mount: root.join("mount"),
            root,
            mounted: false,
        };
        views.insert(session_id.to_string(), view.clone());
        Ok(view)
    }

    /// 取回已登记的视图（会话重开时用；未登记则报错）。
    ///
    /// 与 `register` 的分工：`register` 只登记一次，`reopen` 在建视图失败后重试时用——
    /// 登记表里已有条目，但仍需要（重新）挂载。
    pub fn reopen(workspace: &str, session_id: &str) -> Result<Self, String> {
        let _ = workspace;
        views()
            .lock()
            .map_err(|error| format!("视图登记表损坏：{error}"))?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("会话 {session_id} 没有登记工作视图"))
    }

    /// 确保视图已挂载（首次调用时建目录并挂 overlay）。
    ///
    /// 惰性：登记本身不碰磁盘，纯声明性对话（只发一条消息就关）不会留下视图目录。
    pub fn ensure_mounted(&mut self) -> Result<(), String> {
        if self.mounted {
            return Ok(());
        }
        for name in ["upper", "work", "mount"] {
            std::fs::create_dir_all(self.root.join(name))
                .map_err(|error| format!("建视图目录 {} 失败：{error}", name))?;
        }
        // 挂载点必须可进入
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            self.root.join("mount"),
            std::fs::Permissions::from_mode(0o755),
        );
        mount_overlay(
            &self.workspace,
            &self.root.join("upper"),
            &self.root.join("work"),
            &self.mount,
        )?;
        self.mounted = true;
        // 登记表里那份同步标记（`WorkViewHandle::of` 读的是表）
        if let Ok(mut views) = views().lock() {
            if let Some(entry) = views.get_mut(&self.session_id) {
                entry.mounted = true;
            }
        }
        Ok(())
    }

    /// 视图挂载点（已挂载时可用）；`None` = 尚未建立。
    ///
    /// 只在测试与 `ensure_mounted` 之后确认挂载结果时用：工具层拿的是 `WorkViewHandle`
    /// （它的 `mount_point` 返回 `PathBuf`），不读这个内部记录。
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mount_point(&self) -> Option<PathBuf> {
        self.mounted.then(|| self.mount.clone())
    }
}

/// 工具执行时持有的视图句柄（`ToolContext.work_view`）。
///
/// 只做路径映射与挂载状态查询：文件工具按它的 `to_view_path` 读写，对外仍报真实路径。
/// 路径映射只在这里实现一份——`WorkView` 是登记 / 挂载的内部记录，工具层不碰它。
#[derive(Clone)]
pub struct WorkViewHandle {
    key: String,
    workspace: PathBuf,
    mount: PathBuf,
}

impl WorkViewHandle {
    /// 取某会话的句柄；没有视图（或尚未挂载）时 `None`，工具按真实磁盘执行。
    pub fn of(session_id: &str) -> Option<Self> {
        let views = views().lock().ok()?;
        let view = views.get(session_id)?;
        if !view.mounted {
            return None;
        }
        Some(Self {
            key: view.key.clone(),
            workspace: view.workspace.clone(),
            mount: view.mount.clone(),
        })
    }

    pub fn to_view_path(&self, real: &Path) -> Result<PathBuf, String> {
        let relative = real
            .strip_prefix(&self.workspace)
            .map_err(|_| format!("路径 {} 不在工作区 {} 内", real.display(), self.workspace.display()))?;
        Ok(self.mount.join(relative))
    }

    pub fn to_real_path(&self, view: &Path) -> Result<PathBuf, String> {
        let relative = view
            .strip_prefix(&self.mount)
            .map_err(|_| format!("路径 {} 不在视图 {} 内", view.display(), self.mount.display()))?;
        Ok(self.workspace.join(relative))
    }

    /// 视图挂载点（Bash 在私有命名空间里把工作区 bind 到它上面）。
    pub fn mount_point(&self) -> PathBuf {
        self.mount.clone()
    }

    /// 把真实路径换成视图路径；路径不在工作区内时报错。
    ///
    /// 工具层经 `ToolContext::io_path` 调用它：所有「该读哪个文件」都从这里过，视图因此
    /// 对工具透明——路径字符串对用户仍是真实工作区路径。
    ///
    /// **不降级**（`docs/architecture/principles.md` 铁律 4.1）：越界时若静默退回真实
    /// 路径，隔离对话就会绕过视图直接写磁盘，而工具仍报成功——用户看到的是「勾了隔离，
    /// 改动照样落磁盘」且毫无线索。越界只可能来自接线错误（`cwd` 与视图的工作区不一致），
    /// 必须暴露。
    pub fn map_into_view(&self, real: &Path) -> Result<PathBuf, String> {
        self.to_view_path(real)
    }
}

/// 释放某会话的视图（会话关闭时调用）：卸载挂载，**保留**上层目录——改动要跨 Core 重启
/// 保留（specs/043 FR-006）。
pub fn release(workspace: &str, session_id: &str) {
    let _ = workspace;
    let removed = views()
        .lock()
        .map(|mut views| views.remove(session_id))
        .ok()
        .flatten();
    if let Some(view) = removed {
        if view.mounted {
            umount(view.mount.as_path()).ok();
        }
    }
}

/// 回收某会话的视图（会话删除时调用）：卸载并删掉整个视图目录。
///
/// 失败只记日志不阻塞删除——残留目录可以事后清理，但删除对话本身不能因此失败。
pub fn remove(workspace: &str, session_id: &str) -> Result<(), String> {
    let removed = views()
        .lock()
        .map_err(|error| format!("视图登记表损坏：{error}"))?
        .remove(session_id);
    if let Some(view) = &removed {
        if view.mounted {
            umount(view.mount.as_path()).ok();
        }
    }
    let root = WorkView::root_of(workspace, session_id)?;
    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|error| format!("回收视图目录 {} 失败：{error}", root.display()))?;
    }
    Ok(())
}

/// 视图目录名：工作区 + 会话 id 的稳定短哈希，跨 Core 重启一致。
///
/// 只用 sessionId 不够：同一会话 id 在不同工作区下必须落到不同目录（工作区各自有基线）。
fn session_key(workspace: &str, session_id: &str) -> String {
    let mut safe = String::with_capacity(session_id.len());
    for ch in session_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
            safe.push(ch);
        } else {
            safe.push('-');
        }
    }
    let digest = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(workspace.as_bytes());
        hasher.update([0u8]);
        hasher.update(session_id.as_bytes());
        hasher.finalize()
    };
    let hash: String = digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{hash}-{}", &safe[..safe.len().min(48)])
}

/// 给 Bash 用：把一个视图挂到 `workspace` 上的私有命名空间里。
///
/// 调用方必须已经在**子进程**里（`fork` 之后），因为 `unshare(CLONE_NEWNS)` 只影响调用进程
/// 及其子孙，且这个 bind 不应影响 Core 自身。
pub fn bind_view_onto_workspace(mount_point: &Path, workspace: &Path) -> Result<(), String> {
    unshare(sys::CLONE_NEWNS)
        .map_err(|error| format!("无法创建挂载命名空间副本（{error}）"))?;
    make_private(Path::new("/"))
        .map_err(|error| format!("无法把 / 设为私有挂载（{error}）"))?;
    mount_fs(
        Some(mount_point),
        workspace,
        None,
        sys::MS_BIND | sys::MS_REC,
        None,
    )
    .map_err(|error| {
        format!(
            "无法把视图 {} 挂到工作区 {}（{error}）",
            mount_point.display(),
            workspace.display()
        )
    })?;
    // **必须重设 cwd**：`Command::current_dir` 在 fork 之后、`pre_exec` 之前就已 chdir，
    // 那时工作区还是真实磁盘的 inode。bind 只是给路径换了层，进程的 cwd 仍指向旧
    // inode——脚本里所有相对路径（`gcc -o main main.c` 正是如此）都会落回真实磁盘，
    // 而视图 `upper` 始终为空。重新 chdir 到同一个路径字符串，让 cwd 指向新挂载。
    std::env::set_current_dir(workspace).map_err(|error| {
        format!("bind 后无法进入工作区 {}（{error}）", workspace.display())
    })?;
    Ok(())
}


//! 会话跨实例独占锁（specs/032，`docs/core/standalone-core.md` 第 7 节）。
//!
//! 互斥由 **OS 建议性文件锁** 承担：Unix `flock(LOCK_EX | LOCK_NB)`、Windows
//! `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`，手写 FFI、
//! 零新依赖（与 `parent_watchdog` 的声明风格一致）。锁的生命周期归内核——持有进程
//! 退出（含崩溃、被杀）即释放，接管退化为「再次获取」，无摘除-重建协议。
//!
//! 锁文件（`<会话目录>/<sessionId>.session.lock`）的内容
//! `{"version":1,"pid":…,"started":…}` 只作占用诊断与版本拒外（FR-003），不参与
//! 互斥判定；句柄 Drop 只 unlock + close，**不删文件**——释放期摘文件会让并发的
//! 下一个获取者锁到已脱链 inode，出现双持有；残留文件随会话目录删除自然消失。
//!
//! 锁的持有者是 Core 进程内的会话实例：宿主断开 / detach / 孤儿化（specs/031）
//! 不触碰本模块的注册表与内核锁，认领换宿主是同 Core 重入。

use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::util::diag;

/// 锁文件的格式版本：无法识别的版本视为有效占用、不装载（FR-003 版本拒外，
/// fail-safe 方向是拒外——更高版本的 Core 可能改用其他互斥机制，即使其进程已退出）。
pub const LOCK_FORMAT_VERSION: i64 = 1;

/// 获取失败的分类（错误文案对宿主是技术性诊断；用户可见文案走 `CoreEvent.notice`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    /// 被其他进程持有（内核锁忙）；`pid` 取自锁文件内容，读不出为 `unknown`
    Held { pid: String },
    /// 锁文件版本无法识别（与持有者进程死活无关，见 FR-003）
    UnsupportedVersion { version: i64, pid: String },
    /// 其它 IO / 解析失败：报错不降级（铁律 1）
    Io(String),
}

impl LockError {
    /// 是否为「他持 / 版本拒外」——占用通知只对这两类发；Io 是技术失败不发。
    pub fn is_rejection(&self) -> bool {
        matches!(
            self,
            LockError::Held { .. } | LockError::UnsupportedVersion { .. }
        )
    }
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held { pid } => {
                write!(f, "session is locked by another instance (pid={pid})")
            }
            LockError::UnsupportedVersion { version, pid } => write!(
                f,
                "session lock file version {version} is not recognized (pid={pid}); \
                 refusing to open"
            ),
            LockError::Io(message) => write!(f, "session lock failed: {message}"),
        }
    }
}

/// 锁文件的路径：会话数据目录内、按会话 id 命名（会话级，不是工作区级——
/// 同目录的不同会话互不争用，spec AC-2）。
pub fn lock_path(project: &str, session_id: &str) -> Result<PathBuf, LockError> {
    crate::history::validate_session_id(session_id)
        .map_err(|error| LockError::Io(error.to_string()))?;
    let dir = crate::config::project_conversation_dir(project)
        .map_err(LockError::Io)?;
    Ok(dir.join(format!("{session_id}.session.lock")))
}

// ==================== 进程启动时刻（仅诊断）====================

/// 持有者进程的启动时刻（进程存活期内恒定，免疫 pid 复用）；读不出为 `None`。
/// 只写进锁文件内容做诊断，不参与互斥判定（互斥在内核锁）。
pub fn process_start_time(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // `pid (comm) state ...`：comm 可能含空格与括号，取**最后一个** `)` 之后
        // 的字段； starttime 是第 22 字段（1-based），即剩余字段切片的 index 19
        //（state 是第 3 字段 = 切片 index 0）
        let after = stat.rsplit_once(") ")?.1;
        let fields: Vec<&str> = after.split_whitespace().collect();
        fields.get(19)?.parse::<u64>().ok()
    }
    #[cfg(windows)]
    {
        windows_process_start_time(pid)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn windows_process_start_time(pid: u32) -> Option<u64> {
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: i32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, pid: u32) -> *mut core::ffi::c_void;
        fn GetProcessTimes(
            process: *mut core::ffi::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn CloseHandle(object: *mut core::ffi::c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let ok = GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        Some(((creation.high as u64) << 32) | creation.low as u64)
    }
}

// ==================== 原语 ====================

/// 已持有的会话锁：Drop 时 unlock + close（内核释放），不删锁文件。
pub struct SessionLockHandle {
    file: std::fs::File,
    path: PathBuf,
}

impl std::fmt::Debug for SessionLockHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionLockHandle").field("path", &self.path).finish()
    }
}

fn unlock_file(file: &std::fs::File) {
    #[cfg(unix)]
    {
        const LOCK_UN: i32 = 8;
        // SAFETY: fd 属于调用方持有的 File，进程内合法
        unsafe {
            flock(file.as_raw_fd(), LOCK_UN);
        }
    }
    #[cfg(windows)]
    {
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut core::ffi::c_void,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn UnlockFileEx(
                file: *mut core::ffi::c_void,
                reserved: u32,
                bytes_low: u32,
                bytes_high: u32,
                overlapped: *mut Overlapped,
            ) -> i32;
        }
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        // SAFETY: 句柄合法、区域与加锁时一致（1 字节）
        unsafe {
            UnlockFileEx(
                file.as_raw_handle() as *mut core::ffi::c_void,
                0,
                1,
                0,
                &mut overlapped,
            );
        }
    }
}

impl Drop for SessionLockHandle {
    fn drop(&mut self) {
        unlock_file(&self.file);
        // close 随 File 的 Drop 发生
    }
}

/// 非阻塞独占获取一个会话锁文件（不存在则创建）。
///
/// 成功后把锁文件内容覆写为自己的 `{version, pid, started}`；已有内容的版本无法
/// 识别时立即释放并拒（FR-003）；内容损坏（空 / 坏 JSON）照常持有并落诊断
/// （spec 边界：互斥在内核锁，不依赖文件内容）。
pub fn acquire(path: &Path) -> Result<SessionLockHandle, LockError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| LockError::Io(format!("mkdir {} failed: {error}", parent.display())))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| LockError::Io(format!("open {} failed: {error}", path.display())))?;

    let busy = try_lock_file(&file);
    if busy {
        // 读内容只为诊断（可能与持有者的覆写并发，读出错当 unknown）
        let pid = read_holder_pid(path);
        return Err(LockError::Held { pid });
    }

    // 经持锁句柄读取（Windows 上 LockFileEx 锁住的字节范围会挡住其他句柄的读取，
    // 另开句柄读只会得到空；同一句柄不受自己的锁影响）
    let existing = read_via_handle(&file);
    let parsed: Option<serde_json::Value> =
        serde_json::from_str(existing.trim()).ok();
    match parsed {
        Some(value) => {
            let version = value.get("version").and_then(serde_json::Value::as_i64);
            match version {
                Some(LOCK_FORMAT_VERSION) => {}
                Some(other) => {
                    let pid = value
                        .get("pid")
                        .and_then(serde_json::Value::as_u64)
                        .map(|pid| pid.to_string())
                        .unwrap_or_else(|| "unknown".to_string());
                    return Err(LockError::UnsupportedVersion { version: other, pid });
                }
                None => {
                    diag!(
                        "[session-lock] {} has no version field; treating as ours",
                        path.display()
                    );
                }
            }
        }
        None if existing.trim().is_empty() => {}
        None => {
            diag!(
                "[session-lock] {} is corrupt; treating as ours (mutex is the kernel lock)",
                path.display()
            );
        }
    }

    let started = process_start_time(std::process::id()).unwrap_or(0);
    let content = json!({
        "version": LOCK_FORMAT_VERSION,
        "pid": std::process::id(),
        "started": started,
    });
    let mut write = || -> std::io::Result<()> {
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(content.to_string().as_bytes())?;
        file.flush()
    };
    if let Err(error) = write() {
        // 写不进内容：锁已持有但诊断缺失。释放并报错，不留「锁着但没名分」的句柄
        unlock_file(&file);
        return Err(LockError::Io(format!("write {} failed: {error}", path.display())));
    }
    Ok(SessionLockHandle {
        file,
        path: path.to_path_buf(),
    })
}

/// 经句柄自身读取文件内容（从头读；诊断与版本检查共用）。
fn read_via_handle(file: &std::fs::File) -> String {
    let mut file = file;
    let mut buffer = String::new();
    if file.seek(SeekFrom::Start(0)).is_err() {
        return buffer;
    }
    let _ = std::io::Read::read_to_string(&mut file, &mut buffer);
    buffer
}

/// 读锁文件里的持有者 pid（诊断用；读不出为 `unknown`）。
fn read_holder_pid(path: &Path) -> String {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text.trim()).ok())
        .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
        .map(|pid| pid.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// 非阻塞独占加锁：返回 true 表示锁被他人持有。
fn try_lock_file(file: &std::fs::File) -> bool {
    #[cfg(unix)]
    {
        const LOCK_EX: i32 = 2;
        const LOCK_NB: i32 = 4;
        let result = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        result != 0
    }
    #[cfg(windows)]
    {
        const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x1;
        const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x2;
        const ERROR_LOCK_VIOLATION: u32 = 33;
        #[repr(C)]
        struct Overlapped {
            internal: usize,
            internal_high: usize,
            offset: u32,
            offset_high: u32,
            event: *mut core::ffi::c_void,
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn LockFileEx(
                file: *mut core::ffi::c_void,
                flags: u32,
                reserved: u32,
                bytes_low: u32,
                bytes_high: u32,
                overlapped: *mut Overlapped,
            ) -> i32;
            fn GetLastError() -> u32;
        }
        let mut overlapped = Overlapped {
            internal: 0,
            internal_high: 0,
            offset: 0,
            offset_high: 0,
            event: std::ptr::null_mut(),
        };
        // SAFETY: 句柄合法；同步句柄上 zeroed OVERLAPPED 即同步语义
        let ok = unsafe {
            LockFileEx(
                file.as_raw_handle() as *mut core::ffi::c_void,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if ok != 0 {
            return false;
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_LOCK_VIOLATION {
            return true;
        }
        // 其它错误按「忙」处理会让失败方向变成误拒；这里按不忙处理会让失败方向
        // 变成双持有——宁可误拒（fail-safe 是拒外），落诊断
        diag!("[session-lock] LockFileEx failed with error {error}; treating as held");
        true
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = file;
        // 无内核锁可用的平台不做半吊子互斥：直接报错（铁律 1，不静默降级）
        diag!("[session-lock] no advisory file lock on this platform; refusing");
        true
    }
}

#[cfg(unix)]
use std::os::unix::io::AsRawFd;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

#[cfg(unix)]
extern "C" {
    fn flock(fd: i32, operation: i32) -> i32;
}

// ==================== Core 注册表辅助 ====================

/// 同 Core 重入放行 + 盘上获取并挂入 `Core.session_locks`。
///
/// 注册表命中即返回（同一 Core 内的父子会话、子代理、specs/031 的认领重入都不与
/// 自身争用）；未命中则按 `project` 解析锁文件路径并获取，成功后挂表（持有随
/// `drop_session` 的移除而释放，进程退出由内核兜底）。
pub fn acquire_for_core(
    core: &crate::engine::Core,
    session_id: &str,
    project: &str,
) -> Result<(), LockError> {
    if core.session_locks.lock().unwrap().contains_key(session_id) {
        return Ok(());
    }
    let path = lock_path(project, session_id)?;
    let handle = acquire(&path)?;
    core.session_locks
        .lock()
        .unwrap()
        .insert(session_id.to_string(), handle);
    Ok(())
}

/// 变更租约：`Registered` = 会话已在本 Core 装载（锁长持，写完不用管）；
/// `Acquired` = 未装载的短持有（Drop 即释放），调用方必须让它在写入期间存活。
pub enum MutationLease {
    Registered,
    Acquired(SessionLockHandle),
}

/// 变更入口的守卫（FR-002）：会话被其他实例持有时拒绝；未装载时取短持有租约，
/// 调用方在写入期间持有它，结束即释放、不留下长期持有。
pub fn begin_mutation(
    core: &crate::engine::Core,
    session_id: &str,
) -> Result<MutationLease, LockError> {
    if core.session_locks.lock().unwrap().contains_key(session_id) {
        return Ok(MutationLease::Registered);
    }
    let project = crate::history::project_of_session(session_id)
        .or_else(|| core.project_of(session_id).ok())
        .ok_or_else(|| {
            LockError::Io(format!(
                "cannot resolve the conversation directory of session {session_id}"
            ))
        })?;
    let path = lock_path(&project, session_id)?;
    Ok(MutationLease::Acquired(acquire(&path)?))
}

/// 锁拒绝错误装载入口的统一判别：`ensure_loaded` 等返回 `Err(String)` 的入口用它
/// 区分「被拒」与其它失败，只有前者发占用通知。
pub fn is_lock_rejection(error: &str) -> bool {
    error.starts_with(LOCK_REJECT_PREFIX)
}

pub(crate) const LOCK_REJECT_PREFIX: &str = "session locked:";

#[cfg(test)]
#[path = "session_lock_tests.rs"]
mod tests;

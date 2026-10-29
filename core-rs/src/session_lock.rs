//! 会话独占锁（specs/032-session-exclusive-open FR-001 / FR-003）。
//!
//! 互斥由 OS 建议性文件锁承担（Unix `flock(LOCK_EX | LOCK_NB)` / Windows
//! `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)`，手写 FFI、
//! 零新依赖，风格对齐 `parent_watchdog`）。锁的生命周期归内核——持有进程退出（含
//! 崩溃、被杀）即释放，接管退化为「再次获取」，无摘除-重建协议；并发获取由内核
//! 保证至多一胜。锁文件内容（单行 JSON，版本 / pid / 进程启动时刻）只作占用诊断
//! 与版本拒外，不参与互斥判定。
//!
//! 句柄 Drop 只 unlock + close，**不删锁文件**：释放期摘文件会让并发的下一个获取者
//! 锁到已脱链 inode，另一个获取者在新 inode 上再锁成功，出现双持有；残留文件无害
//! （进程死活由内核锁表达），随会话目录删除自然消失（`history` 的删除清单包含
//! `.session.lock`）。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::engine::Core;
use crate::util::diag;

/// 锁文件格式版本：无法识别的版本视为有效占用（FR-003 版本拒外，
/// fail-safe 方向是拒外不是抢占，持有者进程死活无关）。
const FORMAT_VERSION: u64 = 1;

/// 获取失败的原因。
#[derive(Debug)]
pub enum LockError {
    /// 被其他进程持有；`pid` 从锁文件读出作占用诊断，读不出为 `None`
    /// （Windows 的字节范围锁是强制的，持有期间第三方句柄读不出内容）。
    Held { pid: Option<String> },
    /// 未知格式版本（版本拒外，FR-003）。
    Version { version: u64 },
    /// 锁文件路径推导失败（会话 id 非法等）。
    Path(String),
    /// 其余 IO 错误照常报错不降级（铁律 1）。
    Io(std::io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Held { pid } => {
                write!(f, "held by another instance (pid {})", pid.as_deref().unwrap_or("unknown"))
            }
            LockError::Version { version } => {
                write!(f, "unsupported lock format version {version}")
            }
            LockError::Path(reason) => write!(f, "cannot resolve lock path: {reason}"),
            LockError::Io(error) => write!(f, "session lock io error: {error}"),
        }
    }
}

impl LockError {
    /// 占用者 pid（用于 notice 的 `{pid}` 参数）；拿不到时由调用方回退 `unknown`。
    pub fn holder_pid(&self) -> Option<String> {
        match self {
            LockError::Held { pid } => pid.clone(),
            _ => None,
        }
    }
}

/// 一把已持有的会话锁。Drop 即 unlock + close（互斥由内核仲裁，进程退出兜底）。
#[derive(Debug)]
pub struct SessionLockHandle {
    file: File,
}

impl Drop for SessionLockHandle {
    fn drop(&mut self) {
        // 解锁失败只能吞掉：句柄随即关闭，内核按 fd / 句柄生命周期兜底释放
        platform::unlock(&self.file);
    }
}

/// 非阻塞独占获取。成功后把锁文件内容覆写为自己的诊断信息（版本 / pid / 启动时刻）。
pub fn acquire(path: &Path) -> Result<SessionLockHandle, LockError> {
    let mut file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map_err(LockError::Io)?;
    if let Err(error) = platform::try_lock_exclusive(&file) {
        return Err(match error {
            // 忙：读锁文件内容补占用诊断（Unix flock 是建议性锁、内容可读；Windows
            // 的字节范围锁强制，第三方句柄读不出 → pid 缺省由文案回退 unknown）
            LockError::Held { .. } => LockError::Held {
                pid: std::fs::read_to_string(path)
                    .ok()
                    .as_deref()
                    .and_then(parse_lock_content)
                    .and_then(|parsed| parsed.pid),
            },
            other => other,
        });
    }
    // 已持有内核锁，内容读取与覆写都必须走同一句柄：Windows 的字节范围锁按句柄
    // 强制，另开句柄连自己的锁区间都读不了。
    let content = read_content(&mut file)?;
    match parse_lock_content(&content) {
        // 全新锁文件（空内容）是首次获取的常态，不算损坏；非空但解析不出才是损坏
        // ——照常持有（互斥在内核锁不在内容），落诊断（spec 边界明文）
        None if !content.trim().is_empty() => {
            diag!("[session_lock] {path:?}: unreadable lock content; holding anyway")
        }
        None => {}
        Some(parsed) if parsed.version != FORMAT_VERSION => {
            // 版本拒外：立即返回，句柄 Drop 释放内核锁，文件内容不动（不抢占）
            return Err(LockError::Version {
                version: parsed.version,
            });
        }
        Some(_) => {}
    }
    write_own_content(&mut file);
    Ok(SessionLockHandle { file })
}

/// Core 内的注册表获取（specs/032 FR-001「同 Core 重入放行」）：注册表命中即放行
/// （同一 Core 内的父子会话 / 子代理 / specs/031 认领同 Core 重入，天然不自锁）；
/// 未命中则盘上获取并挂表，句柄随 `drop_session` 释放。
///
/// 会话还没有盘上数据（对话目录未建，新会话首条消息前的常态）没有争用面，放行且
/// 不入表——目录缺席时锁文件无从谈起，也不存在可被并发写的共享数据。
pub fn acquire_for_core(core: &Core, session_id: &str, project: &str) -> Result<(), LockError> {
    if core
        .session_locks
        .lock()
        .expect("session lock registry")
        .contains_key(session_id)
    {
        return Ok(());
    }
    let path = lock_path(session_id, project)?;
    let Some(handle) = acquire_short(core, session_id, path)? else {
        return Ok(());
    };
    core.session_locks
        .lock()
        .expect("session lock registry")
        .insert(session_id.to_string(), handle);
    Ok(())
}

/// 变更守卫用的短持有获取（FR-002「先取锁、锁内写入、随即释放」）：注册表已持有
/// （本 Core 装载中）→ `Ok(None)` 无需再取；会话目录未建（无盘上数据、无争用面）→
/// `Ok(None)`；否则盘上获取，句柄随 Drop 释放、不入表。
pub fn acquire_short(
    core: &Core,
    session_id: &str,
    path: PathBuf,
) -> Result<Option<SessionLockHandle>, LockError> {
    if core
        .session_locks
        .lock()
        .expect("session lock registry")
        .contains_key(session_id)
    {
        return Ok(None);
    }
    if !path
        .parent()
        .is_some_and(|dir| dir.is_dir())
    {
        return Ok(None);
    }
    acquire(&path).map(Some)
}

/// 变更守卫用的短持有获取（project 形态，删除闭包守卫用）：注册表已持有 →
/// `Ok(None)`；否则盘上获取，句柄随 Drop 释放、不入表。
pub fn short_lock_by_project(
    core: &Core,
    session_id: &str,
    project: &str,
) -> Result<Option<SessionLockHandle>, LockError> {
    let path = lock_path(session_id, project)?;
    acquire_short(core, session_id, path)
}

/// 变更类入口的统一守卫（FR-002）：注册表命中放行；未命中走「取锁 → 写入 → 释放」
/// 短持有路径（未装载的会话按先取锁再改处理，不留下长期持有）。
pub fn with_mutation_lock<T>(
    core: &Core,
    session_id: &str,
    project: &str,
    write: impl FnOnce() -> T,
) -> Result<T, LockError> {
    let path = lock_path(session_id, project)?;
    let handle = acquire_short(core, session_id, path)?;
    let result = write();
    drop(handle);
    Ok(result)
}

/// 会话锁文件路径：与会话数据（`.meta.json` / `.jsonl`）同目录，文件名按会话隔离
/// （锁是会话级不是工作区级，AC-2）。路径推导归 `history`（目录布局的所有者）。
fn lock_path(session_id: &str, project: &str) -> Result<PathBuf, LockError> {
    crate::history::session_lock_path(session_id, project).map_err(LockError::Path)
}

/// 读取锁文件内容（同一句柄内，Windows 上持有方读自己的锁区间不受强制锁拦截）。
fn read_content(file: &mut File) -> Result<String, LockError> {
    file.seek(SeekFrom::Start(0)).map_err(LockError::Io)?;
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(LockError::Io)?;
    Ok(text)
}

/// 覆写为自己的诊断信息；失败只落诊断（内容不参与互斥，不值得为它放弃已到手的锁）。
fn write_own_content(file: &mut File) {
    let content = json!({
        "version": FORMAT_VERSION,
        "pid": std::process::id(),
        "started": process_start_time(std::process::id()),
    });
    let line = content.to_string();
    let result = (|| -> std::io::Result<()> {
        file.seek(SeekFrom::Start(0))?;
        file.set_len(0)?;
        file.write_all(line.as_bytes())?;
        file.flush()
    })();
    if let Err(error) = result {
        diag!("[session_lock] failed to write lock content: {error}");
    }
}

/// 解析锁文件内容；解析失败（含空文件、坏 JSON）返回 `None`——视为损坏照常持有。
fn parse_lock_content(text: &str) -> Option<ParsedLockContent> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    Some(ParsedLockContent {
        version: value.get("version").and_then(serde_json::Value::as_u64)?,
        pid: value
            .get("pid")
            .and_then(serde_json::Value::as_u64)
            .map(|pid| pid.to_string()),
    })
}

struct ParsedLockContent {
    version: u64,
    pid: Option<String>,
}

/// 进程启动时刻（仅占用诊断，不参与互斥）：Linux 读 `/proc/<pid>/stat` 第 22 字段
/// （boot 相对时钟滴答，天然免疫墙钟回拨）；Windows `GetProcessTimes` 的创建时刻。
#[cfg(unix)]
fn process_start_time(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm 字段可含空格与括号，从最后一个 ')' 之后取字段；第 22 个整体字段
    // （starttime）在 state（第 3 字段）之后，即剩余部分的第 20 个
    let after_comm = text.rsplit_once(')')?.1;
    after_comm.split_whitespace().nth(19)?.parse().ok()
}

/// Windows 的 `GetProcessTimes`：创建时刻是 100 纳秒单位、自 1601-01-01 起的计数。
#[cfg(windows)]
fn process_start_time(pid: u32) -> Option<u64> {
    use std::ffi::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
        // LPFILETIME 是 2×u32（8 字节）结构，u64 按 ABI 兼容传入
        fn GetProcessTimes(
            process: *mut c_void,
            creation: *mut u64,
            exit: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
    }

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let (mut creation, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    let ok = unsafe {
        GetProcessTimes(
            handle,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    unsafe { CloseHandle(handle) };
    (ok != 0).then_some(creation)
}

/// 平台锁原语。忙（持有冲突）一律映射为 `LockError::Held`；其余 IO 错误照常报错。
#[cfg(unix)]
mod platform {
    use std::fs::File;
    use std::os::unix::io::AsRawFd;

    use super::LockError;

    const LOCK_EX: i32 = 2;
    const LOCK_NB: i32 = 4;
    const LOCK_UN: i32 = 8;

    extern "C" {
        fn flock(fd: i32, operation: i32) -> i32;
    }

    pub fn try_lock_exclusive(file: &File) -> Result<(), LockError> {
        let rc = unsafe { flock(file.as_raw_fd(), LOCK_EX | LOCK_NB) };
        if rc == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            // EWOULDBLOCK：已被持有；pid 由调用方读锁文件内容补（flock 是建议性锁，
            // 持有期间内容可读）
            return Err(LockError::Held { pid: None });
        }
        Err(LockError::Io(error))
    }

    pub fn unlock(file: &File) {
        unsafe { flock(file.as_raw_fd(), LOCK_UN) };
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;

    use super::LockError;

    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
    const ERROR_LOCK_VIOLATION: i32 = 33;

    /// 零填充 `OVERLAPPED`（同步锁不需要偏移与事件，全零即可）。
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        event: *mut c_void,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
        fn UnlockFileEx(
            file: *mut c_void,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }

    /// 锁整个可能的字节范围（`u32::MAX` 低 / 高位各一）：文件在锁后还要覆写，
    /// 范围必须不随文件长度变化。
    fn lock_range_params() -> (u32, u32) {
        (u32::MAX, u32::MAX)
    }

    pub fn try_lock_exclusive(file: &File) -> Result<(), LockError> {
        let mut overlapped: Overlapped = unsafe { std::mem::zeroed() };
        let (low, high) = lock_range_params();
        let ok = unsafe {
            LockFileEx(
                file.as_raw_handle() as *mut c_void,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                low,
                high,
                &mut overlapped,
            )
        };
        if ok != 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION) {
            return Err(LockError::Held { pid: None });
        }
        Err(LockError::Io(error))
    }

    pub fn unlock(file: &File) {
        let mut overlapped: Overlapped = unsafe { std::mem::zeroed() };
        let (low, high) = lock_range_params();
        unsafe {
            UnlockFileEx(
                file.as_raw_handle() as *mut c_void,
                0,
                low,
                high,
                &mut overlapped,
            )
        };
    }
}

#[cfg(test)]
#[path = "session_lock_tests.rs"]
mod tests;

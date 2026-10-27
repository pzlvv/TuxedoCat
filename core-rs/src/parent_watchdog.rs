//! 父进程存活看门狗（缺陷 `specs/defects/orphan-core-processes-after-host-exit.md`）。
//!
//! 本地 stdio Core 由宿主直接 spawn，父进程就是宿主（VS Code 扩展宿主 / Electron
//! 主进程 / daemon）。宿主被强杀、扩展升级替换时 `deactivate` 可能根本不执行，
//! 标准输入 EOF 也可能因主线程正卡在同步处理或退出清理而迟到。启动时记下父 PID，
//! 后台线程周期探测，父进程消失即退出——见 `docs/core/standalone-core.md` 第 5.4 节。
//!
//! 探测口径：只有「进程不存在」算死亡；无权限查询按存活处理，避免误杀。

use std::thread;
use std::time::Duration;

use crate::util::diag;

/// 探测间隔：父进程消失后最多一个周期退出。
pub const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// 启动看门狗；父进程消失时调用 `on_dead`。
///
/// 返回 `None` 表示平台没有实现（或取不到父 PID），此时保持原有退出路径。
pub fn spawn(on_dead: impl FnOnce() + Send + 'static) -> Option<thread::JoinHandle<()>> {
    let parent = platform::parent_pid()?;
    // 武装诊断：测试（parent_watchdog）靠这行确认「看门狗已记录父 PID」这个
    // 前置事实发生——runner 满载时 Core 的启动可慢于测试的任何定时假设，
    // 按顺序观察而不是按时间赌（docs/core/standalone-core.md 第 5.4 节）。
    diag!("[core] watchdog armed on parent {parent}");
    thread::Builder::new()
        .name("parent-watchdog".to_string())
        .spawn(move || watch(parent, POLL_INTERVAL, on_dead))
        .ok()
}

/// 周期探测指定父进程；消失即写诊断并回调。
fn watch(pid: u32, interval: Duration, on_dead: impl FnOnce()) {
    watch_with(
        || platform::is_alive(pid),
        interval,
        move || {
            diag!("[core] parent process {pid} exited; shutting down");
            on_dead();
        },
    );
}

/// 探测循环本体（探测函数与回调可注入，单测用毫秒级间隔）。
fn watch_with(mut probe: impl FnMut() -> bool, interval: Duration, on_dead: impl FnOnce()) {
    loop {
        thread::sleep(interval);
        if !probe() {
            on_dead();
            return;
        }
    }
}

/// Unix：`kill(pid, 0)` 只做存在性探测。
#[cfg(unix)]
mod platform {
    /// 启动时的父进程 PID。
    pub fn parent_pid() -> Option<u32> {
        let pid = std::os::unix::process::parent_id();
        (pid > 0).then_some(pid)
    }

    /// 进程是否存在。`ESRCH` 表示不存在；`EPERM` 等其它错误按存活处理。
    pub fn is_alive(pid: u32) -> bool {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        // ESRCH（3）：没有这个进程
        const ESRCH: i32 = 3;
        let rc = unsafe { kill(pid as i32, 0) };
        if rc == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(ESRCH)
    }
}

/// Windows：`OpenProcess` + `WaitForSingleObject(0)` 判定；父 PID 经进程快照取得。
#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const WAIT_OBJECT_0: u32 = 0;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const INVALID_HANDLE_VALUE: isize = -1;

    /// `PROCESSENTRY32W`（`tlhelp32.h`）。x64 下 `th32DefaultHeapID` 是 `ULONG_PTR`。
    ///
    /// 只读 `th32_process_id` / `th32_parent_process_id`，其余字段是布局占位。
    #[repr(C)]
    #[allow(dead_code)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[allow(non_snake_case)]
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> u32;
        fn GetLastError() -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> *mut c_void;
        fn Process32FirstW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: *mut c_void, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut c_void;
        fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    }

    /// 父进程 PID：遍历进程快照找自己的条目。
    pub fn parent_pid() -> Option<u32> {
        let self_pid = unsafe { GetCurrentProcessId() };
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot as isize == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut found = None;
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while ok {
            if entry.th32_process_id == self_pid {
                found = (entry.th32_parent_process_id != 0).then_some(entry.th32_parent_process_id);
                break;
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        unsafe { CloseHandle(snapshot) };
        found
    }

    /// 进程是否存在：句柄打开成功且尚未 signaled。
    ///
    /// 打开失败时只有 `ERROR_ACCESS_DENIED` 算存活（存在但无权限）；
    /// 其它错误（含 `ERROR_INVALID_PARAMETER` = 不存在）算死亡。
    pub fn is_alive(pid: u32) -> bool {
        let handle =
            unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
        }
        let wait = unsafe { WaitForSingleObject(handle, 0) };
        unsafe { CloseHandle(handle) };
        // WAIT_OBJECT_0 = 已退出；WAIT_TIMEOUT / WAIT_FAILED 等一律按存活处理（保守）
        wait != WAIT_OBJECT_0
    }
}

/// 其余平台：没有实现，不启用看门狗。
#[cfg(not(any(unix, windows)))]
mod platform {
    pub fn parent_pid() -> Option<u32> {
        None
    }

    pub fn is_alive(_pid: u32) -> bool {
        true
    }
}

#[cfg(test)]
#[path = "parent_watchdog_tests.rs"]
mod tests;

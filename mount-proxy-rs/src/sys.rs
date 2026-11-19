//! Linux 系统调用的薄封装（specs/051 FR-006）。
//!
//! 本 crate **零第三方依赖**：带 setuid 位运行的进程，依赖面每多一层就多一份被劫持的
//! 面。`libc` 也不引——常量与结构体按 Linux 内核 ABI 直接声明
//! （`include/uapi/linux/sched.h` / `include/uapi/linux/mount.h` / `prctl(2)`）。
//!
//! 只声明本 crate 真正用到的调用；签名照 `man 2` / `man 7` 抄，不做通用封装。

#![allow(dead_code)]

use std::os::raw::{c_char, c_int, c_uint, c_ulong, c_void};

pub type CInt = c_int;
pub type CUInt = c_uint;
pub type CULong = c_ulong;

// ── clone 标志（include/uapi/linux/sched.h） ──
pub const CLONE_NEWNS: CInt = 0x0002_0000;
pub const CLONE_NEWUSER: CInt = 0x1000_0000;

/// `socketpair(2)` 域 / 类型：A（特权挂载器）与 B（服务本体）之间的双向通道
pub const AF_UNIX: CInt = 1;
pub const SOCK_STREAM: CInt = 1;

// ── mount 标志（include/uapi/linux/mount.h） ──
pub const MS_REC: CULong = 16384;
pub const MS_PRIVATE: CULong = 1 << 18;
pub const MS_BIND: CULong = 4096;

// ── prctl 选项（include/uapi/linux/prctl.h） ──
pub const PR_SET_PDEATHSIG: CInt = 1;
pub const PR_SET_NO_NEW_PRIVS: CInt = 38;
/// 设为 `SIGKILL`
pub const SIGKILL: CInt = 9;

// ── capability（include/uapi/linux/capability.h） ──
pub const CAP_SETUID: CUInt = 7;
pub const CAP_SETGID: CUInt = 6;
pub const CAP_SYS_ADMIN: CUInt = 21;
/// `prctl(PR_CAPBSET_DROP, cap)` 的选项号
pub const PR_CAPBSET_DROP: CInt = 24;

// ── 文件打开 / 权限 ──
pub const O_PATH: CInt = 0o10000000;
pub const O_NOFOLLOW: CInt = 0o400000;
pub const O_CLOEXEC: CInt = 0o2000000;
pub const O_DIRECTORY: CInt = 0o200000;
pub const O_RDONLY: CInt = 0;
pub const O_WRONLY: CInt = 1;
pub const O_CREAT: CInt = 0o100;
pub const O_EXCL: CInt = 0o200;
pub const AT_FDCWD: CInt = -100;
pub const AT_SYMLINK_NOFOLLOW: CInt = 0x100;

/// `struct stat`（x86_64 / aarch64 Linux 的 glibc 布局；本 crate 只关心 st_mode /
/// st_uid / st_gid 三个字段，其余按 ABI 占位）。
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Stat {
    pub st_dev: c_ulong,
    pub st_ino: c_ulong,
    pub st_nlink: c_ulong,
    pub st_mode: c_uint,
    pub st_uid: c_uint,
    pub st_gid: c_uint,
    pub __pad0: c_int,
    pub st_rdev: c_ulong,
    pub st_size: i64,
    pub st_blksize: i64,
    pub st_blocks: i64,
    pub st_atime: i64,
    pub st_atime_nsec: i64,
    pub st_mtime: i64,
    pub st_mtime_nsec: i64,
    pub st_ctime: i64,
    pub st_ctime_nsec: i64,
    pub __unused: [i64; 3],
}

/// `S_IFMT` 掩码与 `S_ISREG` 判据（`include/uapi/linux/stat.h`）
pub const S_IFMT: c_uint = 0o170000;
pub const S_IFREG: c_uint = 0o100000;
pub const S_IFDIR: c_uint = 0o040000;

extern "C" {
    pub fn unshare(flags: CInt) -> CInt;
    pub fn mount(
        source: *const c_char,
        target: *const c_char,
        fstype: *const c_char,
        flags: CULong,
        data: *const c_void,
    ) -> CInt;
    pub fn umount(target: *const c_char) -> CInt;
    pub fn umount2(target: *const c_char, flags: CInt) -> CInt;
    pub fn getuid() -> CUInt;
    pub fn geteuid() -> CUInt;
    pub fn getgid() -> CUInt;
    pub fn getegid() -> CUInt;
    pub fn setresuid(ruid: CUInt, euid: CUInt, suid: CUInt) -> CInt;
    pub fn setresgid(rgid: CUInt, egid: CUInt, sgid: CUInt) -> CInt;
    pub fn getresuid(ruid: *mut CUInt, euid: *mut CUInt, suid: *mut CUInt) -> CInt;
    pub fn getresgid(rgid: *mut CUInt, egid: *mut CUInt, sgid: *mut CUInt) -> CInt;
    pub fn socketpair(domain: CInt, ty: CInt, protocol: CInt, sv: *mut CInt) -> CInt;
    pub fn prctl(option: CInt, arg2: c_ulong, arg3: c_ulong, arg4: c_ulong, arg5: c_ulong) -> CInt;
    pub fn umask(mask: c_uint) -> c_uint;
    pub fn fork() -> c_int;
    pub fn waitpid(pid: c_int, status: *mut c_int, options: c_int) -> c_int;
    pub fn _exit(code: c_int) -> !;
    pub fn kill(pid: c_int, sig: c_int) -> c_int;
    pub fn getppid() -> c_int;
    pub fn getpid() -> c_int;
    pub fn fstat(fd: c_int, buf: *mut Stat) -> c_int;
    // `open` 不能在这里声明：它是 std **自己占用的运行时符号**，重复声明会被 rustc
    // 拒绝（`invalid definition of the runtime open symbol used by the standard library`）。
    // 用 `openat` 替代（同一个系统调用族，且允许显式指定 mode，非 variadic）。
    pub fn openat(dirfd: c_int, path: *const c_char, flags: c_int, mode: CInt) -> c_int;
    pub fn close(fd: c_int) -> c_int;
    pub fn fchmod(fd: c_int, mode: c_uint) -> c_int;
    pub fn fchown(fd: c_int, uid: CUInt, gid: CUInt) -> c_int;
    pub fn fsync(fd: c_int) -> c_int;
    pub fn renameat(
        olddirfd: c_int,
        oldpath: *const c_char,
        newdirfd: c_int,
        newpath: *const c_char,
    ) -> c_int;
    pub fn mkstemp(template: *mut c_char) -> c_int;
    pub fn read(fd: c_int, buf: *mut c_void, count: usize) -> isize;
    pub fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
    pub fn pipe(fds: *mut c_int) -> c_int;
    /// 带 flags 的 `pipe(2)`：`O_CLOEXEC` 一步到位（工具代执行的三条管道要用）
    pub fn pipe2(fds: *mut c_int, flags: c_int) -> c_int;
    /// 复制 fd 到指定编号（工具子进程把管道接到 0 / 1 / 2）
    pub fn dup2(oldfd: c_int, newfd: c_int) -> c_int;
    /// 自立进程组（工具整组被杀的前提）
    pub fn setpgid(pid: c_int, pgid: c_int) -> c_int;
    /// 换掉进程映像：argv / envp 都是以 NULL 结尾的指针数组
    pub fn execve(
        path: *const c_char,
        argv: *const *const c_char,
        envp: *const *const c_char,
    ) -> c_int;
    pub fn chdir(path: *const c_char) -> c_int;
    pub fn freopen(path: *const c_char, mode: *const c_char, stream: *mut c_void) -> *mut c_void;
}

/// `poll(2)` 的 `struct pollfd`（`include/uapi/asm-generic/poll.h`）
#[repr(C)]
pub struct PollFd {
    pub fd: c_int,
    pub events: i16,
    pub revents: i16,
}

/// `POLLIN`
pub const POLLIN: i16 = 0x0001;

/// 等 fd 可读，最多 `timeout_ms` 毫秒；`Ok(true)` = 可读，`Ok(false)` = 超时。
///
/// 用于「子进程等父进程写映射」这类必须有上限的等待（FR-006 第 10 条）：父进程若在
/// 写映射前死掉，不带上限的阻塞读会永远挂着。
pub fn poll_readable(fd: CInt, timeout_ms: i64) -> Result<bool, String> {
    let mut entry = PollFd {
        fd,
        events: POLLIN,
        revents: 0,
    };
    let rc = unsafe { poll(&mut entry, 1, timeout_ms as c_int) };
    if rc < 0 {
        return Err(format!("poll 失败（{}）", last_error()));
    }
    Ok(rc > 0 && entry.revents & (POLLIN | POLLHUP | POLLERR) != 0)
}

/// `POLLHUP` / `POLLERR`（对端关闭时也应立即返回，不能等到超时）
pub const POLLHUP: i16 = 0x0010;
pub const POLLERR: i16 = 0x0008;

/// `mkdir(2)`（直接用内核 ABI，不经 std）
///
/// ## 为什么不用 `std::fs::create_dir`
///
/// 在 musl 静态产物 + 私有用户命名空间的组合下，std 的 `create_dir` 报
/// `EOVERFLOW`，而同一条路径用 `mkdir(2)` 直接调用完全正常（实测：原生 C 成功、
/// Rust `create_dir` 失败，同一进程同一目录）。`EOVERFLOW` 在 `mkdir` 上只可能来自
/// `statx` 之类带结构体的路径，本 crate 需要的是「成功或失败的 errno」，不需要 std 的
/// 额外语义（递归、父目录检查），因此直接 syscall 是更可靠的选择。
///
/// **`mode` 不受 umask 影响**：`mkdir(2)` 的 mode 会被进程 umask 削掉高位，而本程序在
/// 入口就 `umask(077)`，`mkdir(p, 0o755)` 实际落成 `0700`。特权阶段建的目录随后要交给
/// 降权后的服务本体与工具使用（`os error 13: Permission denied`，真机实测），因此这里
/// 建完 `chmod` 一次，把 mode 显式设成调用方要的值。
pub fn make_dir(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("路径含 NUL 字节：{}", path.display()))?;
    // 用 libc 的 `mkdir(2)`（已实测在真机的 musl 静态产物上返回 0）：
    // - `syscall()` 直通在 musl 上返回**未经 errno 转换的原始值**，直接判 `== 0` 会把
    //   `-EEXIST` 当成失败，进而误报到错误的 errno 上（实测踩过）；
    // - std 的 `create_dir` 会额外做父目录检查，在本 crate 的用法里没有必要。
    unsafe { *__errno_location() = 0 };
    let rc = unsafe { mkdir(path_c.as_ptr(), 0o755) };
    if rc == 0 {
        // umask(077) 会把 0755 削成 0700：显式改回来，让降权后的用户与工具进得去。
        // 失败不当错误返回——目录已建成，权限问题会在真正的读写处暴露得更具体。
        unsafe { chmod(path_c.as_ptr(), 0o755) };
        return Ok(());
    }
    let errno = unsafe { *__errno_location() };
    // 已存在：调用方要的「目录存在」状态已满足（与 `create_dir_all` 口径一致）
    if errno == 17 {
        return Ok(());
    }
    Err(format!(
        "mkdir({}) 失败（rc={rc} errno={errno} {}）",
        path.display(),
        std::io::Error::from_raw_os_error(errno)
    ))
}

/// 显式设一个路径的 mode（`chmod(2)`；不受 umask 影响，与建目录时同一需要）
pub fn chmod_path(path: &std::path::Path, mode: u32) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("路径含 NUL 字节：{}", path.display()))?;
    check(
        unsafe { chmod(path_c.as_ptr(), mode) },
        &format!("chmod({} → {mode:04o})", path.display()),
    )
}

// `mkdir(2)` / `chmod(2)`：libc 的包装会正确处理 errno 并做 `-1` 归一，是本 crate
// 需要的语义。
extern "C" {
    fn mkdir(path: *const c_char, mode: c_uint) -> c_int;
    fn chmod(path: *const c_char, mode: c_uint) -> c_int;
}

// `errno` 的取法（`__errno_location()` 在 glibc / musl 上都可用）
extern "C" {
    fn __errno_location() -> *mut c_int;
    fn poll(fds: *mut PollFd, nfds: c_ulong, timeout: c_int) -> c_int;
}

/// 最近一次系统调用的错误串（`"<errno>: <message>"`）
pub fn last_error() -> String {
    let errno = unsafe { *__errno_location() };
    let text = std::io::Error::from_raw_os_error(errno).to_string();
    format!("errno {errno}: {text}")
}

/// 返回 0 视为成功，否则取 `last_error()`
pub fn check(rc: CInt, what: &str) -> Result<(), String> {
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("{what} 失败（{}）", last_error()))
    }
}

/// 把一个路径的属主改成 `uid:gid`（特权阶段建完目录后交给真实用户）。
///
/// 特权阶段建的目录默认归 root；降权后的服务本体与工具以用户身份进去，属主不对就会在
/// 写入处报 `Permission denied`（真机实测）。这里是那条交接的唯一落点。
pub fn chown(path: &std::path::Path, uid: u32, gid: u32) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;
    let path_c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("路径含 NUL 字节：{}", path.display()))?;
    check(
        unsafe { libc_chown(path_c.as_ptr(), uid, gid) },
        &format!("chown({} → {uid}:{gid})", path.display()),
    )
}

// `chown(2)`（避免与 std 的符号冲突，单独取一个本地名）
extern "C" {
    #[link_name = "chown"]
    fn libc_chown(path: *const c_char, owner: CUInt, group: CUInt) -> c_int;
}

/// `getuid()`（调用者的**真实** uid；setuid 位不影响它）
pub fn real_uid() -> u32 {
    unsafe { getuid() }
}

pub fn effective_uid() -> u32 {
    unsafe { geteuid() }
}

pub fn real_gid() -> u32 {
    unsafe { getgid() }
}

pub fn effective_gid() -> u32 {
    unsafe { getegid() }
}

/// 是否持有 `CAP_SYS_ADMIN`（读 `CapEff` 的 bit 21）。
///
/// 只用于**断言**，不作为授权判据：入口的授权判据是 `euid == 0` 与 uid 允许列表。
pub fn has_cap_sys_admin() -> bool {
    let Ok(status) = std::fs::read_to_string("/proc/self/status") else {
        return false;
    };
    let Some(line) = status.lines().find(|line| line.starts_with("CapEff:")) else {
        return false;
    };
    let Some(hex) = line.split_whitespace().nth(1) else {
        return false;
    };
    u64::from_str_radix(hex, 16)
        .map(|caps| caps & (1u64 << CAP_SYS_ADMIN) != 0)
        .unwrap_or(false)
}

/// 把 `/` 设为私有传播（`MS_REC | MS_PRIVATE`）。
///
/// 必须在 `CLONE_NEWNS` **之后**、且用户命名空间的映射已写完（否则挂载命名空间属父
/// userns，本调用会 `EPERM`，specs/051 FR-006 第 6 条）。
pub fn make_private_root() -> Result<(), String> {
    let root = c"/";
    check(
        unsafe {
            mount(
                std::ptr::null(),
                root.as_ptr(),
                std::ptr::null(),
                MS_REC | MS_PRIVATE,
                std::ptr::null(),
            )
        },
        "把 / 设为私有挂载",
    )
}

/// 设置 `PR_SET_PDEATHSIG`（父进程死亡时收到 `SIGKILL`）。
///
/// **必须在凭证变更之后设置**：`prctl(2)` 明确 effective uid 变更会清掉该值。
pub fn set_dumpable() -> Result<(), String> {
    /// `PR_SET_DUMPABLE`
    const PR_SET_DUMPABLE: CInt = 4;
    check(
        unsafe { prctl(PR_SET_DUMPABLE, 1, 0, 0, 0) },
        "prctl(PR_SET_DUMPABLE, 1)",
    )
}

pub fn set_pdeathsig() -> Result<(), String> {
    check(
        unsafe { prctl(PR_SET_PDEATHSIG, SIGKILL as c_ulong, 0, 0, 0) },
        "设置 PR_SET_PDEATHSIG",
    )
}

/// 设置 `PR_SET_NO_NEW_PRIVS`
pub fn set_no_new_privs() -> Result<(), String> {
    check(
        unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) },
        "设置 PR_SET_NO_NEW_PRIVS",
    )
}

/// 从 capability bounding set 里裁掉一个能力
pub fn drop_bounding(cap: CUInt) -> Result<(), String> {
    check(
        unsafe { prctl(PR_CAPBSET_DROP, cap as c_ulong, 0, 0, 0) },
        &format!("裁掉 bounding set 的 cap {cap}"),
    )
}

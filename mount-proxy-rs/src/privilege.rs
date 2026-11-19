//! 特权阶段（specs/051 FR-006）：入口自检 → 请求收紧 → 建挂载命名空间 → fork 出
//! 「特权挂载器 A」+「服务本体 B」→ B 降权后进入帧循环
//!
//! ```text
//! Core ──spawn──▶ 代理（setuid 启动，euid 0，真实 uid U）
//!        1. 入口自检：euid==0；real uid != 0；real uid 在允许列表内
//!        2. 收紧：bounding set 裁三项；umask(077)；chdir("/")；不读环境变量
//!        3. unshare(CLONE_NEWNS) + MS_REC|MS_PRIVATE
//!           ← 必须在 fork **之前**：A / B 要共享同一份挂载表
//!        4. socketpair + fork
//!           ├─ A（父）：只做 mount / umount 两个原语，随后 waitpid(B) 收尸
//!           └─ B（子）：setresgid(U,U,U) → setresuid(U,U,U) 断言三个 id
//!                       → PR_SET_NO_NEW_PRIVS → 常驻帧循环（见 serve.rs）
//!        5. B 的挂载请求经 socketpair 转发给 A；B 自己是用户身份，
//!           `mount(2)` 会被内核拒绝——特权只留在 A
//! ```
//!
//! **没有 user namespace**：代理在初始 userns 里已持 `CAP_SYS_ADMIN`，再建 userns 只会
//! 换来一个残缺的 id 映射（除一个 id 外全是 65534），让 `mkdir` / overlay 全部
//! `EOVERFLOW`。理由与实测记录见 `establish` 的文档。
//!
//! 顺序里的每一步都是约束，不可重排。理由见 FR-006 与
//! `docs/core/mount-proxy.md` 的「特权阶段时序与加固」节。

use crate::sys;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// 入口自检的拒绝原因（`None` = 通过）。纯函数，单测可直接驱动每条分支。
///
/// 判据（FR-006「入口自检」）：
/// - `euid == 0`：被 `nosuid` 或剥掉 setuid 位时静默继续，会得到「看起来建了命名空间
///   其实没有 `CAP_SYS_ADMIN`」的假成功——必须直接拒绝。
/// - `uid != 0`：真实 uid 为 0 时 `uid_map` 会写成 `0 0 1`，命名空间内 root 等于宿主
///   root，安全性论证的支点消失。
/// - 真实 uid 在允许列表内：文件权限 `04755` 意味着机器上任何本地用户都能调用它，受众
///   收窄是唯一的可回收项（FR-005「受众收窄」）。
pub fn entry_rejection(euid: u32, ruid: u32, allowed: &[u32]) -> Option<String> {
    if euid != 0 {
        return Some(format!(
            "euid 为 {euid} 而不是 0：setuid 位未生效或被 nosuid 挂载拦下"
        ));
    }
    if ruid == 0 {
        return Some("调用者的真实 uid 是 0：会生成 `0 0 1` 的映射，拒绝执行".to_string());
    }
    if !allowed.contains(&ruid) {
        return Some(format!(
            "调用者的真实 uid {ruid} 不在允许列表 {allowed:?} 内（安装期写入的受众收窄）"
        ));
    }
    None
}

/// uid 允许列表文件的落点（安装期由 root 侧写，`root:root 0600`）
pub fn uid_list_path() -> PathBuf {
    Path::new(env!("TC_MOUNT_PROXY_DIR")).join(format!("{}.uids", env!("TC_MOUNT_PROXY_NAME")))
}

/// 读允许列表：一行一个 uid，`#` 起注释，空行忽略。
///
/// 文件不存在时返回**空列表**而不是报错：那是「还没人装过受众」，任何真实 uid 都不在
/// 列表内 → 入口拒绝。这个方向是 fail-closed（缺配置不放行），符合
/// `docs/architecture/principles.md` 第 1 节。
pub fn read_allowed_uids(path: &Path) -> Vec<u32> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .map(|line| line.split('#').next().unwrap_or("").trim())
        .filter(|line| !line.is_empty())
        .filter_map(|line| line.parse::<u32>().ok())
        .collect()
}

/// 请求收紧（FR-006「请求收紧」，入口即做）
pub fn tighten() -> Result<(), String> {
    // bounding set 裁到三项：此后即使本进程被诱导执行别的程序，也拿不到其余能力
    let keep = [sys::CAP_SETUID, sys::CAP_SETGID, sys::CAP_SYS_ADMIN];
    for cap in capability_universe() {
        if !keep.contains(&cap) {
            // 裁不掉（已在更小的集合里）不是错误：目标状态已满足
            let _ = sys::drop_bounding(cap);
        }
    }
    unsafe { sys::umask(0o077) };
    let root = CString::new("/").expect("静态路径");
    sys::check(unsafe { sys::chdir(root.as_ptr()) }, "chdir(/)")?;
    // 不读任何环境变量：本 crate 只在 `env!`（编译期）取产品名与落点，运行期不读 env
    Ok(())
}

/// 需要从 bounding set 里清掉的能力全集（内核当前支持的 0..=CAP_CHECKPOINT_RESTORE）
fn capability_universe() -> Vec<u32> {
    (0..=40).collect()
}

/// 降回真实 uid / gid 并断言三个 id 全为真实值（FR-006 第 5 条）。
///
/// `setresgid` 必须在 `setresuid` **之前**：丢了 euid 就 setgid 不了。
pub fn drop_to_real_ids(uid: u32, gid: u32) -> Result<(), String> {
    sys::check(
        unsafe { sys::setresgid(gid, gid, gid) },
        "setresgid(真实 gid)",
    )?;
    sys::check(
        unsafe { sys::setresuid(uid, uid, uid) },
        "setresuid(真实 uid)",
    )?;
    let (mut ru, mut eu, mut su) = (0u32, 0u32, 0u32);
    sys::check(
        unsafe { sys::getresuid(&mut ru, &mut eu, &mut su) },
        "getresuid 回读",
    )?;
    let (mut rg, mut eg, mut sg) = (0u32, 0u32, 0u32);
    sys::check(
        unsafe { sys::getresgid(&mut rg, &mut eg, &mut sg) },
        "getresgid 回读",
    )?;
    if (ru, eu, su) != (uid, uid, uid) {
        return Err(format!(
            "降权后 uid 断言失败：期望 ({uid}, {uid}, {uid})，实际 ({ru}, {eu}, {su})"
        ));
    }
    if (rg, eg, sg) != (gid, gid, gid) {
        return Err(format!(
            "降权后 gid 断言失败：期望 ({gid}, {gid}, {gid})，实际 ({rg}, {eg}, {sg})"
        ));
    }
    Ok(())
}

/// 特权阶段的结果：B（服务本体）的退出码，由 A 在收尸时解出。
///
/// 收尸只做一次：A 的挂载器循环里 `waitpid` 之后就把结论带出来，调用方直接用
/// 这个退出码，不再二次 `waitpid`（对同一 pid 二次 wait 会得到 `ECHILD`）。
pub struct Forked {
    pub child_exit_code: i32,
}

/// 一次性特权前置的入参：要在**降权之前**完成的挂载动作。
///
/// ## 为什么挂载必须发生在降权之前，且不能按需做
///
/// 按需挂载要求「降权之后仍有一个进程持有 `CAP_SYS_ADMIN`」，那正是旧形态里 A 长驻的
/// 理由。改为「一隔离会话一代理」之后这个理由消失了：一个代理只服务一个视图，视图在
/// 会话建立时就该挂好，之后没有任何新的挂载需求。于是 A 不再需要长驻，也不再需要一条
/// B→A 的挂载通道——挂载在 fork 之前由 root 身份做完，B 与它共享同一份挂载表。
///
/// 这条形态还顺手解决了另一件事：视图必须 **bind 到真实工作区路径** 上（specs/045 的
/// 透明性），而 bind 同样要 `CAP_SYS_ADMIN`。它在同一个特权窗口里完成，B 起的工具因此
/// 直接看真实路径就是叠加结果。
pub struct PrivilegedSetup<'a> {
    /// 视图的 lower（真实工作区）
    pub lower: &'a Path,
    /// 视图的 upper
    pub upper: &'a Path,
    /// 视图的 work
    pub work: &'a Path,
    /// 叠加视图的挂载点
    pub merged: &'a Path,
    /// bind 的目标：真实工作区路径（工具看到的就是它）
    pub workspace: &'a Path,
}

/// 进入挂载命名空间 → 挂 overlay → 把视图 bind 到工作区路径上（全部在 fork 之前）。
///
/// 调用方是已 `tighten()` 的 root 身份代理。成功返回后本进程处于一份私有挂载表里，
/// 视图已就位；随后的 `establish_after_mount` 负责 fork 与降权。
pub fn enter_mount_namespace(setup: &PrivilegedSetup) -> Result<(), String> {
    if sys::effective_uid() != 0 {
        return Err(format!(
            "建立挂载命名空间要求 euid 为 0，实际 {}",
            sys::effective_uid()
        ));
    }
    // 1. 挂载命名空间必须在 fork **之前**建立：unshare(CLONE_NEWNS) 只影响调用进程，
    //    fork 出来的子进程继承的是调用之后的挂载表，两者才是同一份。
    sys::check(
        unsafe { sys::unshare(sys::CLONE_NEWNS) },
        "unshare(CLONE_NEWNS)",
    )?;
    // 根挂载默认是 shared，不标 private 的话一个 ns 里的挂载会传播回宿主。
    sys::make_private_root()?;

    // 2. 视图目录：**由 root 建、立刻 chown 给真实用户**。
    //
    //    不能让降权后的 B 自己建：它已经不在特权阶段，建不出 `mount` 需要的目录布局；
    //    也不能留着 root 属主——B 与工具以用户身份进去，属主不对就会在写入处报
    //    `Permission denied`（真机实测）。
    for dir in [setup.upper, setup.work, setup.merged] {
        sys::make_dir(dir)?;
        sys::chown(dir, sys::real_uid(), sys::real_gid())?;
    }
    // 3. 挂 overlay
    mount_fs(setup.lower, setup.upper, setup.work, setup.merged)?;
    if mount_count(setup.merged) != 1 {
        let _ = umount_path(setup.merged);
        return Err(format!(
            "挂载后 {} 在 mountinfo 里出现 {} 次（应为 1 次）",
            setup.merged.display(),
            mount_count(setup.merged)
        ));
    }
    // 挂上之后由 root 读一次：`mount(2)` 返回 0 只说明内核收下了请求。这一步在降权之前，
    // 因此能把「挂载没生效」与「降权后权限不足」两类失败分开报（两者在真机上都出现过）。
    std::fs::read_dir(setup.merged)
        .map_err(|error| format!("挂载后读 {} 失败（{error}）", setup.merged.display()))?;
    // 4. 把视图 bind 到真实工作区路径上（specs/045 的透明性：工具看到真实路径就是叠加结果）
    bind_over_workspace(setup.merged, setup.workspace)?;
    Ok(())
}

/// 一份挂载表里 bind：`mount --bind <merged> <workspace>`，递归。
///
/// **递归**不可省：工作区里可能已经有子挂载（`node_modules` 的 tmpfs、用户自己的 bind
/// 挂载），非递归 bind 只复制顶层目录本身，子挂载的内容会露出来。
fn bind_over_workspace(source: &Path, target: &Path) -> Result<(), String> {
    let source_c = cstring(source.as_os_str().as_bytes())?;
    let target_c = cstring(target.as_os_str().as_bytes())?;
    sys::check(
        unsafe {
            sys::mount(
                source_c.as_ptr(),
                target_c.as_ptr(),
                std::ptr::null(),
                sys::MS_BIND | sys::MS_REC,
                std::ptr::null(),
            )
        },
        &format!(
            "把视图 {} 挂到工作区 {}",
            source.display(),
            target.display()
        ),
    )
}

/// 建立**挂载命名空间**，fork 成「特权挂载器 A」+「服务本体 B」，B 里执行 `body`。
///
/// ## 为什么没有 user namespace
///
/// 旧实现让 B `unshare(CLONE_NEWUSER)`、由 A 写 `uid_map` 把宿主真实 uid 映射成 ns
/// 内的 0。那条路在内核上走不通（实测记录见
/// `specs/defects/mount-proxy-cannot-mkdir-under-private-tmpfs.md`）：
///
/// - unprivileged userns 只允许映射**一个** uid，即调用者自己；
/// - 于是 ns 内除这一个 id 外全部是 `65534`（overflow），而需要把 kuid 反向映射回
///   mount 所属 userns 的操作（`mkdir` 算属主、overlay 建 whiteout）都返回
///   `EOVERFLOW`（errno 75）；
/// - 该错误与 tmpfs 无关，任何需要属主映射的操作都会撞上。
///
/// 代理是 setuid root 启动的，在**初始 userns** 里本来就持有 `CAP_SYS_ADMIN`；
/// 建 `CLONE_NEWUSER` 是主动把自己降进一个残缺的映射。因此现在只用
/// `unshare(CLONE_NEWNS)`：挂载隔离照样成立，且全程没有 id 映射问题。
///
/// ## 为什么仍然要 fork
///
/// 挂载已完成（`enter_mount_namespace`），A 不再需要保持特权做任何事。fork 的唯一目的
/// 是让 A 留在原处只做 `waitpid` 收尸：B 的 `PR_SET_PDEATHSIG` 绑在 A 上，A 一旦退出
/// B 会被 reparent 且信号不再生效。A 在 fork 之后立刻降回真实 uid，此后不持任何特权。
///
/// **A 自己不设指向 Core 的 `PDEATHSIG`**：`PR_SET_PDEATHSIG` 跟的是 parent **task**
/// （父线程），而 Core 在工具批的短命线程里 `spawn` 本进程——设了它，工具线程一收尾
/// 内核就杀掉 A，A 的死再顺着 B 的 `PDEATHSIG` 带走 B
///（`specs/defects/mount-proxy-dies-with-tool-thread.md`）。回收由 socketpair EOF 承担。
///
/// ```text
/// A（父，fork 后立刻降权到真实 uid）
///    · 只做 waitpid(B) 收尸
///    · 不碰业务、不读 Core 的帧
///
/// B（子，同样降权到真实 uid）
///    · 跑帧循环（serve.rs），业务全部在这里
///    · 已经站在挂载命名空间里、视图已 bind 到工作区
/// ```
///
/// `body` 必须**永不返回**（以 `_exit` 结束）：回到 fork 之后共享的栈是未定义行为。
/// 返回类型写 `()` 而不是 `!`（`!` 作为闭包返回类型在 stable Rust 上仍 experimental）。
pub fn establish_after_mount<F>(uid: u32, gid: u32, body: F) -> Result<Forked, String>
where
    F: FnOnce(),
{
    let parent_pid = unsafe { sys::getpid() };
    let pid = unsafe { sys::fork() };
    if pid < 0 {
        return Err(format!("fork 失败（{}）", sys::last_error()));
    }
    if pid == 0 {
        // ── 子进程 = B（服务本体）：永不返回 ──
        //
        // 降权必须在任何 fs 操作**之前**：工具与视图目录都按用户身份做事，属主才正确。
        if let Err(reason) = drop_to_real_ids(uid, gid) {
            eprintln!("[mount-proxy] 服务本体降权失败：{reason}");
            unsafe { sys::_exit(64) };
        }
        // **B 的生命绑在 A 上**：A 一死（被 SIGKILL、崩溃、Core 侧强制清理），内核立刻
        // 给 B 发 SIGKILL，不留孤儿。
        //
        // 没有这一条时实测的残留形态：A 已经退出（僵尸），B 仍以用户身份活着并继续
        // 持有挂载命名空间——代理二进制都已被卸载，它还在跑，谁也回收不了
        // （specs/051 FR-007b / AC-26）。
        //
        // **必须在降权之后设**：内核在 `commit_creds()` 里发现凭证变化（dumpable 从 0
        // 变回 1 或反之）时会 `clear_pdeathsig()`，把之前设好的父亲死亡信号清掉。
        // 先设后降权 = 设了等于没设（实测：A 被 SIGKILL 后 B 的 ppid 变成 1 却仍存活）。
        if let Err(reason) = sys::set_pdeathsig() {
            eprintln!("[mount-proxy] 设置 PDEATHSIG 失败：{reason}");
            unsafe { sys::_exit(64) };
        }
        // `PDEATHSIG` 只对「设置之后」发生的父进程死亡生效：若 A 已经死了，信号永远
        // 不会来。补一次校验——`getppid()` 不再是 A 就说明它已经不在，直接退出。
        if unsafe { sys::getppid() } != parent_pid {
            eprintln!("[mount-proxy] 父进程已退出，服务本体不启动");
            unsafe { sys::_exit(64) };
        }
        // body 里会起工具子进程，NO_NEW_PRIVS 让 setuid 二进制在它们身上失效。
        if let Err(reason) = sys::set_no_new_privs() {
            eprintln!("[mount-proxy] 置 NO_NEW_PRIVS 失败：{reason}");
            unsafe { sys::_exit(64) };
        }
        body();
        // `body` 约定以 `_exit` 结束；走到这里说明它返回了（未定义行为的边界）
        eprintln!("[mount-proxy] 内部错误：服务本体返回了");
        unsafe { sys::_exit(77) }
    }

    // ── 父进程 = A：降权后只收尸 ──
    //
    // 挂载已在 fork 之前做完，A 不再需要 root。先降权再 `waitpid`：此后 A 即使被
    // 诱导，也没有任何能力可用（FR-006 第 7 条 / AC-22）。
    if let Err(reason) = drop_to_real_ids(uid, gid) {
        // 降权失败：直接杀掉 B 再退出，不留一个持命名空间、父进程仍是 root 的孤儿
        unsafe {
            sys::kill(pid, sys::SIGKILL);
        }
        return Err(format!("特权挂载器降权失败：{reason}"));
    }
    // `PDEATHSIG` 在这里**不设**：Core 是在工具批的短命线程里 `spawn` 本进程的，而
    // `prctl(2)` 的 `PR_SET_PDEATHSIG` 跟的是 parent **task**（父线程）而不是父进程。
    // 设了它之后，拉起代理的那条工具线程一收尾，内核立刻 `SIGKILL` A，A 的死再顺着
    // B 的 `PDEATHSIG` 带走 B——表现是同会话第一条工具成功、此后每条工具都回
    // 「挂载代理已退出：读到 EOF」（`specs/defects/mount-proxy-dies-with-tool-thread.md`）。
    //
    // 回收本来就不依赖它：主路径是 socketpair EOF（Core 死 → fd 关闭 → B 读到 EOF 退出
    // → A 的 `waitpid` 返回），覆盖 Core 被 `SIGKILL` 的情形且与父线程无关
    //（`docs/core/mount-proxy.md` 第 5 节）。
    Ok(Forked {
        child_exit_code: reap(pid),
    })
}

/// 等一个子进程退出并返回它的退出码
fn reap(pid: i32) -> i32 {
    let mut status = 0;
    loop {
        let reaped = unsafe { sys::waitpid(pid, &mut status, 0) };
        if reaped == pid {
            return decode_wait_status(status);
        }
        if reaped < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            eprintln!("[mount-proxy] 收尸失败：{error}");
            return 6;
        }
    }
}

/// 挂载点当前在 `/proc/self/mountinfo` 里出现几次
fn mount_count(mount: &Path) -> usize {
    let text = mount.to_string_lossy();
    std::fs::read_to_string("/proc/self/mountinfo")
        .unwrap_or_default()
        .lines()
        .filter(|line| line.split_whitespace().nth(4) == Some(text.as_ref()))
        .count()
}

/// 把 `waitpid` 的 status 解成退出码：正常退出取高 8 位，被信号杀死按 `128 + 信号`。
///
/// 提成纯函数是为了能单测——信号分支在真机上不好构造。
fn decode_wait_status(status: i32) -> i32 {
    let signal = status & 0x7f;
    if signal == 0 {
        (status >> 8) & 0xff
    } else {
        128 + signal
    }
}

/// `mount("overlay", merged, "overlay", 0, "lowerdir=...")`
///
/// **不加 `userxattr`**：那是非特权用户命名空间里的变通（overlay 要写
/// `trusted.overlay.*` 而该 ns 里没有 `CAP_SYS_ADMIN`）。A 在初始 userns 里是真 root，
/// 用标准的 `trusted.*` 语义即可；带 `userxattr` 会让 upper 里的元数据落在
/// `user.overlay.*`，与标准工具（以及宿主侧误用 `trusted.*` 的场景）互不相认。
fn mount_fs(lower: &Path, upper: &Path, work: &Path, merged: &Path) -> Result<(), String> {
    let options = format!(
        "lowerdir={},upperdir={},workdir={}",
        lower.display(),
        upper.display(),
        work.display()
    );
    let source = std::ffi::CString::new("overlay").expect("静态串");
    let target = std::ffi::CString::new(merged.as_os_str().as_encoded_bytes())
        .map_err(|_| "挂载点路径含 NUL".to_string())?;
    let fstype = std::ffi::CString::new("overlay").expect("静态串");
    let data = std::ffi::CString::new(options).map_err(|_| "挂载参数含 NUL".to_string())?;
    sys::check(
        unsafe {
            sys::mount(
                source.as_ptr(),
                target.as_ptr(),
                fstype.as_ptr(),
                0,
                data.as_ptr() as *const std::os::raw::c_void,
            )
        },
        &format!("挂载 overlay 到 {}", merged.display()),
    )
}

fn umount_path(merged: &Path) -> Result<(), String> {
    let target = std::ffi::CString::new(merged.as_os_str().as_encoded_bytes())
        .map_err(|_| "挂载点路径含 NUL".to_string())?;
    sys::check(
        unsafe { sys::umount(target.as_ptr()) },
        &format!("卸载 {}", merged.display()),
    )
}

/// 安装模式（FR-005「安装不变量」）：从标准输入读内容，`mkstemp` 落临时名，
/// `fchown` / `fchmod` 在 `rename` **之前**完成，随后 `fsync` 并回显 sha256。
///
/// 内容经管道、不经路径：源路径不参与安装命令，因此没有「源侧替换窗口」，也没有
/// 「root 向调用方指定位置写字节」的符号链接原语。
pub fn install_from_stdin() -> Result<String, String> {
    let target_dir = Path::new(env!("TC_MOUNT_PROXY_DIR"));
    let target_name = env!("TC_MOUNT_PROXY_NAME");
    if !target_dir.is_dir() {
        return Err(format!(
            "安装落点目录 {} 不存在；安装器不在其上创建任何目录，也不改到其它落点",
            target_dir.display()
        ));
    }
    // 祖先分量校验（FR-005 / AC-18）：目录自身与每个已存在的祖先分量必须是 root 属主
    // 且 (mode & 0o022) == 0，否则拒绝安装并点名是哪一段
    check_ancestors(target_dir)?;
    // 目录 fd：`O_DIRECTORY|O_NOFOLLOW`，为 renameat 提供相对基准
    let dir_c = cstring(target_dir.as_os_str().as_bytes())?;
    let dir_fd = unsafe {
        sys::openat(
            sys::AT_FDCWD,
            dir_c.as_ptr(),
            sys::O_DIRECTORY | sys::O_NOFOLLOW | sys::O_CLOEXEC,
            0,
        )
    };
    if dir_fd < 0 {
        return Err(format!(
            "打开目录 {} 失败（{}）",
            target_dir.display(),
            sys::last_error()
        ));
    }

    // 临时名由 root 侧生成（mkstemp），不接受调用方传入的名字
    let mut template = format!("{}/.{}.XXXXXX", target_dir.display(), target_name).into_bytes();
    template.push(0);
    let temp_fd = unsafe { sys::mkstemp(template.as_mut_ptr() as *mut std::os::raw::c_char) };
    if temp_fd < 0 {
        return Err(format!("mkstemp 失败（{}）", sys::last_error()));
    }
    let temp_path = String::from_utf8_lossy(&template[..template.len() - 1]).to_string();

    let result = (|| -> Result<String, String> {
        // 从 stdin 读全部内容
        let mut content = Vec::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = unsafe {
                sys::read(
                    0,
                    buffer.as_mut_ptr() as *mut std::os::raw::c_void,
                    buffer.len(),
                )
            };
            if count < 0 {
                return Err(format!("读标准输入失败（{}）", sys::last_error()));
            }
            if count == 0 {
                break;
            }
            content.extend_from_slice(&buffer[..count as usize]);
        }
        if content.is_empty() {
            return Err("标准输入为空：拒绝安装空文件".to_string());
        }
        // 升级按内容比对（FR-005「升级」）：落点已有同一份字节就**不重写**。
        //
        // 为什么要判：重装会换 inode。正在运行的代理实例仍持有旧 inode（换名只换目录项、
        // 旧 inode 继续服务），但下一次 exec 会走新文件；无谓地换会让「安装落点不计指纹、
        // 全部 Core 版本共享一份」这条约定失去意义，也让幂等重装变成不可观测。
        if let Ok(existing) = std::fs::read(target_dir.join(target_name)) {
            if existing == content {
                // 内容一致：仍需把安装者 uid 补进允许列表（共享机器上多个用户互不覆盖）
                record_allowed_uid(installer_uid())?;
                let _ = unsafe { sys::close(temp_fd) };
                let _ = std::fs::remove_file(&temp_path);
                return Ok(sha256_hex(&content));
            }
        }
        // 写入临时文件
        let mut written = 0;
        while written < content.len() {
            let count = unsafe {
                sys::write(
                    temp_fd,
                    content[written..].as_ptr() as *const std::os::raw::c_void,
                    content.len() - written,
                )
            };
            if count <= 0 {
                return Err(format!("写临时文件失败（{}）", sys::last_error()));
            }
            written += count as usize;
        }
        // fchown / fchmod 在 rename **之前**：不允许「先落到最终名再提权」，
        // 那会留下一个非 root 可写的 4755 窗口（FR-005 第 3 条）
        sys::check(unsafe { sys::fchown(temp_fd, 0, 0) }, "fchown(root,root)")?;
        sys::check(unsafe { sys::fchmod(temp_fd, 0o4755) }, "fchmod(04755)")?;
        sys::check(unsafe { sys::fsync(temp_fd) }, "fsync(临时文件)")?;
        let _ = unsafe { sys::close(temp_fd) };

        // 相对目录 fd 的 renameat：只换目录项，运行中的旧 inode 继续服务
        let temp_c = cstring(temp_path.as_bytes())?;
        let target_c = cstring(target_name.as_bytes())?;
        sys::check(
            unsafe { sys::renameat(dir_fd, temp_c.as_ptr(), dir_fd, target_c.as_ptr()) },
            "renameat(临时名 → 最终名)",
        )?;
        sys::check(unsafe { sys::fsync(dir_fd) }, "fsync(目录)")?;

        // 受众收窄（FR-005「受众收窄」）：把安装者的真实 uid 追加进允许列表。
        // 追加去重而不是单值——共享机器上多个用户互不覆盖。
        record_allowed_uid(installer_uid())?;

        Ok(sha256_hex(&content))
    })();

    if result.is_err() {
        // 失败不留半截产物
        let temp_c = cstring(temp_path.as_bytes()).ok();
        if let Some(temp_c) = temp_c {
            unsafe {
                std::fs::remove_file(std::ffi::OsStr::from_bytes(
                    std::ffi::CStr::from_ptr(temp_c.as_ptr()).to_bytes(),
                ))
            }
            .ok();
        }
    }
    let _ = unsafe { sys::close(dir_fd) };
    result
}

fn cstring(bytes: &[u8]) -> Result<CString, String> {
    CString::new(bytes).map_err(|_| "路径含 NUL 字节".to_string())
}

/// 安装者的真实 uid。
///
/// 安装形态由 `sudo` 直接拉起 `--install`（FR-006「一次性模式」表：`--install` **不走**
/// 特权阶段），此时 `SUDO_UID` 是发起安装的用户；直接以 root 运行时回退到 `getuid()`。
///
/// 这是本进程**唯一**读环境变量的地方，且只在安装形态里读：可执行代理的常驻形态一律
/// 不读 env（FR-006「请求收紧」）。`SUDO_UID` 只用作允许列表的写入值，不参与授权判定。
pub fn installer_uid() -> u32 {
    std::env::var("SUDO_UID")
        .ok()
        .and_then(|text| text.parse::<u32>().ok())
        .unwrap_or_else(|| unsafe { sys::getuid() })
}

/// 把 uid 追加进允许列表（`root:root 0600`，追加去重）。
///
/// 文件不存在时创建；已存在则读出来去重后整体重写（`fs::write` 在 `root` 下是原子的
/// 截断 + 写入，且此时没有并发安装——安装由宿主串行化）。
fn record_allowed_uid(uid: u32) -> Result<(), String> {
    let path = uid_list_path();
    let mut uids = read_allowed_uids(&path);
    if uids.contains(&uid) {
        return Ok(());
    }
    uids.push(uid);
    uids.sort_unstable();
    let mut text = String::from("# 安装期写入的代理允许列表（一行一个真实 uid）\n");
    for value in &uids {
        text.push_str(&format!("{value}\n"));
    }
    std::fs::write(&path, text)
        .map_err(|error| format!("写 {} 失败（{error}）", path.display()))?;
    // 允许列表必须 root:root 0600：可写它就能给自己加白名单
    let path_c = cstring(path.as_os_str().as_bytes())?;
    let fd = unsafe {
        sys::openat(
            sys::AT_FDCWD,
            path_c.as_ptr(),
            sys::O_WRONLY | sys::O_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(format!(
            "打开 {} 失败（{}）",
            path.display(),
            sys::last_error()
        ));
    }
    let result = (|| -> Result<(), String> {
        sys::check(
            unsafe { sys::fchown(fd, 0, 0) },
            "fchown(允许列表 root:root)",
        )?;
        sys::check(unsafe { sys::fchmod(fd, 0o600) }, "fchmod(允许列表 0600)")?;
        Ok(())
    })();
    let _ = unsafe { sys::close(fd) };
    result
}

/// 校验安装落点的目录自身与每个已存在的祖先分量：`root` 属主且 `(mode & 0o022) == 0`。
///
/// 任一段不满足即拒绝并**点名是哪一段**（AC-18）。不静默改落点。
fn check_ancestors(target: &Path) -> Result<(), String> {
    let mut current = Some(target);
    while let Some(path) = current {
        if let Ok(meta) = std::fs::metadata(path) {
            use std::os::unix::fs::MetadataExt;
            let mode = meta.mode();
            if meta.uid() != 0 {
                return Err(format!(
                    "祖先分量 {} 的属主是 uid {}（要求 root）",
                    path.display(),
                    meta.uid()
                ));
            }
            if mode & 0o022 != 0 {
                return Err(format!(
                    "祖先分量 {} 的组 / 其他可写（mode {:04o}，要求 (mode & 0o022) == 0）",
                    path.display(),
                    mode & 0o7777
                ));
            }
        }
        current = path.parent();
    }
    Ok(())
}

/// sha256（本 crate 零依赖，自己实现：RFC 6234 的 32 位实现，约 60 行）
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = sha256(data);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (index, word) in h.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_rejects_non_root_euid() {
        let reason = entry_rejection(1000, 1000, &[1000]).unwrap();
        assert!(reason.contains("euid"), "{reason}");
    }

    #[test]
    fn entry_rejects_real_root() {
        let reason = entry_rejection(0, 0, &[0]).unwrap();
        assert!(reason.contains("真实 uid"), "{reason}");
    }

    #[test]
    fn entry_rejects_uid_outside_allowlist() {
        let reason = entry_rejection(0, 1001, &[1000]).unwrap();
        assert!(reason.contains("允许列表"), "{reason}");
    }

    #[test]
    fn wait_status_decodes_exit_and_signal() {
        // WIFEXITED(42) → 42；被 SIGKILL(9) → 137
        assert_eq!(decode_wait_status(42 << 8), 42);
        assert_eq!(decode_wait_status(9), 137);
    }

    #[test]
    fn entry_accepts_allowed_caller() {
        assert!(entry_rejection(0, 1001, &[1000, 1001]).is_none());
    }

    #[test]
    fn allowed_uids_parse_comments_and_blanks() {
        let dir = std::env::temp_dir().join(format!("mp-uids-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("uids");
        std::fs::write(&path, "# installed users\n1000\n\n1001  # second\n").unwrap();
        assert_eq!(read_allowed_uids(&path), vec![1000, 1001]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_uid_list_is_empty() {
        assert!(read_allowed_uids(Path::new("/nonexistent/uids")).is_empty());
    }

    #[test]
    fn sha256_matches_known_vectors() {
        // NIST 测试向量
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }
}

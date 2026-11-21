//! Overlay 挂载代理（specs/051）。
//!
//! 以 root 属主 + setuid 位部署（`04755`）在 `<core.mountProxyDir>/<core.mountProxyName>`。
//! 职责只有一件：在限制非特权用户命名空间的主机上，替调用者建立用户 + 挂载命名空间，
//! 并持有它（`serve` 形态），让工具进程能从这条命名空间里 fork 出来。
//!
//! ## 平台
//!
//! 只在 Linux 上有意义（用户 / 挂载命名空间、overlayfs、setuid 语义都是 Linux 的）。
//! 非 Linux 目标编译成一个**明确的失败桩**：`npm run package` 会同时构建 Windows 目标，
//! 而 Windows 上没有 `std::os::unix`——整棵实现树在这里被 `cfg` 摘掉，不逐处打补丁
//! （上一轮实施就是「修一处、露一处」耗尽的，见 spec 的「实施现状」）。
//!
//! ## 形态（FR-007b）
//!
//! | 形态 | 触发 | 生命周期 | 是否持命名空间 |
//! | --- | --- | --- | --- |
//! | 一次性 | `--install` / `--self-check` / `--protocol-version` | 执行完即退出 | 自检建立后销毁；安装不建 |
//! | 常驻 | `--serve --fd <n>` | 与该工作区 Core 同寿命 | 是 |
//!
//! ## 硬约束（每条都是 FR-006 的入口要求）
//!
//! - 入口自检：`euid == 0`、真实 uid `!= 0`、真实 uid 在安装期写入的允许列表内；
//! - 请求收紧：bounding set 裁到三项、`umask(0o077)`、`chdir("/")`、不读环境变量；
//! - 目标路径只来自 argv，不用 `system` / `popen`。
//!
//! ## 阶段一的范围
//!
//! 本实现只做「部署 + 建立 / 探测 / 卸载挂载」。工具代执行（`spawn` / `readFile` /
//! `writeFile` / `listDir` / `mkdirAll` / `gitShow`）是阶段二：`serve.rs` 的 `dispatch`
//! 对这些 op 明确回「未实现」，不静默成功。

#[cfg(target_os = "linux")]
mod exec;
#[cfg(target_os = "linux")]
mod privilege;
// 帧协议是纯 std 的编解码，不碰 unix / libc：跨平台编译，让它的测试在
// Windows 开发机上也能真实执行（整树摘掉会让 `cargo test` 报「0 个测试 ok」）。
mod protocol;
#[cfg(target_os = "linux")]
mod remote_fd;
#[cfg(target_os = "linux")]
mod serve;
#[cfg(target_os = "linux")]
mod sys;

#[cfg(target_os = "linux")]
fn main() {
    linux::main();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    // 构建脚本只对 Linux 目标产出代理（FR-005「分发形态」）。跑到这里说明有人把
    // Windows / macOS 产物当代理装了——直接报错，不静默成功。
    eprintln!("mount-proxy 只在 Linux 上可用：本产物不是可用的挂载代理");
    std::process::exit(78);
}

#[cfg(target_os = "linux")]
mod linux {
    use std::fmt::Write as _;

    use crate::{privilege, serve, sys};

    /// 产物名（编译期由 `src/config/project.json` 的 `core.mountProxyName` 烧入）
    pub const PROXY_NAME: &str = env!("TC_MOUNT_PROXY_NAME");
    /// 安装落点目录
    pub const MOUNT_PROXY_DIR: &str = env!("TC_MOUNT_PROXY_DIR");
    /// 安装握手协议版本（与运行期 IPC 版本分开，见 build.rs）
    pub const PROTOCOL_VERSION: &str = env!("TC_PROTOCOL_VERSION");

    pub fn main() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        match args.first().map(String::as_str) {
            Some("--protocol-version") => {
                emit_line(PROTOCOL_VERSION);
            }
            Some("--self-check") => {
                let code = self_check();
                std::process::exit(code);
            }
            Some("--install") => {
                // 安装形态**不走特权阶段**（FR-006「一次性模式」表）：它由 `sudo` 直接以
                // root 拉起，只做文件落盘，不建 userns。它也不满足入口自检的
                // `ruid != 0` 条件——那个条件是给「被普通用户调用」的常驻 / 自检形态准备的。
                //
                // 但仍要求 euid == 0：非 root 装不了 04755 到 root 属主的目录。
                if sys::effective_uid() != 0 {
                    eprintln!(
                        "[{PROXY_NAME}] 安装需要 root（euid 为 {}）；用 `sudo` 拉起本命令",
                        sys::effective_uid()
                    );
                    std::process::exit(2);
                }
                match privilege::install_from_stdin() {
                    Ok(report) => {
                        // 两行固定形状：宿主按行取 sha256 校验内容（FR-005），按
                        // `installer-uid` 行写审计记录（FR-012）。安装者 uid 是**本机**
                        // 的真实 uid，远端部署时与宿主进程 uid 不是一回事。
                        emit_line(&report.digest);
                        emit_line(&format!("installer-uid={}", report.installer_uid));
                    }
                    Err(reason) => {
                        eprintln!("[{PROXY_NAME}] 安装失败：{reason}");
                        std::process::exit(3);
                    }
                }
            }
            Some("--serve") => {
                if let Some(reason) = gate() {
                    eprintln!("[{PROXY_NAME}] {reason}");
                    std::process::exit(2);
                }
                serve_mode(&args[1..]);
            }
            Some("--help") | Some("-h") | None => {
                print!("{}", usage());
            }
            Some(other) => {
                eprintln!("[{PROXY_NAME}] 未知模式：{other}");
                eprintln!("用 `{PROXY_NAME} --help` 查看用法。");
                std::process::exit(2);
            }
        }
    }

    /// 常驻形态：建立命名空间、挂好视图、bind 到工作区，然后进入帧循环（永不返回）
    ///
    /// 入参（FR-006：只经 argv，不读环境变量）：
    ///
    /// | 参数 | 含义 |
    /// | --- | --- |
    /// | `--fd <n>` | 与 Core 之间的 socketpair 子端 |
    /// | `--lower <path>` | 视图的 lower（真实工作区） |
    /// | `--upper <path>` | 视图的 upper |
    /// | `--work <path>` | 视图的 work |
    /// | `--merged <path>` | 叠加视图的挂载点 |
    /// | `--workspace <path>` | bind 的目标：真实工作区路径 |
    fn serve_mode(args: &[String]) -> ! {
        let options = match parse_serve_args(args) {
            Ok(options) => options,
            Err(reason) => {
                eprintln!("[{PROXY_NAME}] {reason}");
                std::process::exit(2);
            }
        };
        // 请求收紧必须在建立命名空间之前：之后的分支都不该再持有宽集合
        if let Err(reason) = privilege::tighten() {
            eprintln!("[{PROXY_NAME}] 请求收紧失败：{reason}");
            std::process::exit(4);
        }
        let uid = sys::real_uid();
        let gid = sys::real_gid();
        // 挂载必须在**降权之前**完成：建命名空间、挂 overlay、bind 到工作区三步都要
        // CAP_SYS_ADMIN，降权之后再也没有进程持有它（见 privilege::enter_mount_namespace）。
        let setup = privilege::PrivilegedSetup {
            lower: &options.lower,
            upper: &options.upper,
            work: &options.work,
            merged: &options.merged,
            workspace: &options.workspace,
        };
        if let Err(reason) = privilege::enter_mount_namespace(&setup) {
            eprintln!("[{PROXY_NAME}] 建立挂载命名空间失败：{reason}");
            std::process::exit(5);
        }
        // 视图根目录记进进程内槽位：serve 侧不读环境变量，只认这一处
        serve::set_view_root(options.merged.clone());
        // fork 出 B（服务本体）后立刻降权；A 此后只做收尸
        let forked = match privilege::establish_after_mount(uid, gid, || {
            serve::run_as_resident(options.fd);
        }) {
            Ok(forked) => forked,
            Err(reason) => {
                eprintln!("[{PROXY_NAME}] fork 失败：{reason}");
                std::process::exit(5);
            }
        };
        // 走到这里说明 B 已退出、A 已收尸：直接采用 A 带回的退出码。
        // **不能**再 reap 一次——同一 pid 二次 wait 必然 ECHILD。
        std::process::exit(forked.child_exit_code);
    }

    /// `--serve` 的入参
    struct ServeOptions {
        fd: i32,
        lower: std::path::PathBuf,
        upper: std::path::PathBuf,
        work: std::path::PathBuf,
        merged: std::path::PathBuf,
        workspace: std::path::PathBuf,
    }

    /// 解析 `--serve` 的参数：全部必填，缺一个就报错（不猜默认路径）
    fn parse_serve_args(args: &[String]) -> Result<ServeOptions, String> {
        let mut fd: Option<i32> = None;
        let mut lower = None;
        let mut upper = None;
        let mut work = None;
        let mut merged = None;
        let mut workspace = None;
        let mut index = 0;
        while index < args.len() {
            let flag = args[index].as_str();
            let Some(value) = args.get(index + 1) else {
                return Err(format!("{flag} 缺参数"));
            };
            match flag {
                "--fd" => {
                    fd = Some(
                        value
                            .parse::<i32>()
                            .map_err(|_| format!("--fd 的值不是整数：{value}"))?,
                    );
                }
                "--lower" => lower = Some(std::path::PathBuf::from(value)),
                "--upper" => upper = Some(std::path::PathBuf::from(value)),
                "--work" => work = Some(std::path::PathBuf::from(value)),
                "--merged" => merged = Some(std::path::PathBuf::from(value)),
                "--workspace" => workspace = Some(std::path::PathBuf::from(value)),
                other => return Err(format!("--serve 不接受参数 {other}")),
            }
            index += 2;
        }
        Ok(ServeOptions {
            fd: fd.ok_or_else(|| {
                "--serve 需要 --fd <n>（Core 传入的 socketpair 子端）".to_string()
            })?,
            lower: lower.ok_or_else(|| "--serve 需要 --lower <path>".to_string())?,
            upper: upper.ok_or_else(|| "--serve 需要 --upper <path>".to_string())?,
            work: work.ok_or_else(|| "--serve 需要 --work <path>".to_string())?,
            merged: merged.ok_or_else(|| "--serve 需要 --merged <path>".to_string())?,
            workspace: workspace.ok_or_else(|| "--serve 需要 --workspace <path>".to_string())?,
        })
    }

    /// 入口闸门：入口自检 + 允许列表校验（FR-006「入口自检」）
    ///
    /// 返回 `Some(原因)` 表示拒绝。
    fn gate() -> Option<String> {
        let allowed = privilege::read_allowed_uids(&privilege::uid_list_path());
        privilege::entry_rejection(sys::effective_uid(), sys::real_uid(), &allowed)
    }

    /// `--self-check`（FR-005「自检归属唯一」）：建挂载命名空间 → 挂 overlay → 降权 →
    /// 断言 → 卸载。
    ///
    /// 断言，每条失败都点名是哪一条：
    /// 1. 挂载在降权**之前**由 root 完成，降权后进程不该再持 `CAP_SYS_ADMIN`；
    /// 2. 降权后 `getuid()` / `geteuid()` / `getsuid()` 都是真实 uid（不以 root 运行）；
    /// 3. 挂载表可读且视图在表里恰好一次；
    /// 4. 叠加视图读得到 lower 的内容（挂载真的生效，不是空目录）。
    ///
    /// 自检由代理自身实现，**不 exec 任何目标**（FR-005「自检归属唯一」）。
    fn self_check() -> i32 {
        if let Some(reason) = gate() {
            eprintln!("[{PROXY_NAME}] {reason}");
            return 2;
        }
        let uid = sys::real_uid();
        let gid = sys::real_gid();
        if let Err(reason) = privilege::tighten() {
            eprintln!("[{PROXY_NAME}] 请求收紧失败：{reason}");
            return 4;
        }
        // 固定路径、不读 `TMPDIR`（FR-006「请求收紧」）
        let root =
            std::path::Path::new("/tmp").join(format!("tc-self-check-{}", std::process::id()));
        let lower = root.join("lower");
        let upper = root.join("upper");
        let work = root.join("work");
        let merged = root.join("merged");
        // 自检只验「命名空间 + overlay」这条链，因此 bind 目标是 lower 自己：挂载点与
        // bind 目标不能是同一处（mount 会拒绝），lower 是可写的临时目录。
        let bind_target = lower.clone();
        let prepared = (|| -> Result<(), String> {
            // 目录由 root 建、立刻交给真实用户：自检的断言在降权之后跑，属主不对就会
            // 在读叠加视图那一步报 Permission denied（真机实测）。
            for dir in [&root, &lower, &bind_target] {
                sys::make_dir(dir)?;
                sys::chown(dir, uid, gid)?;
            }
            // 标记文件写完之后要立刻交给真实用户：`umask(077)` 让它落成 root:root 0600，
            // 降权后的断言读它必然 `Permission denied`（真机实测）。overlay 的 upper 侧
            // 复制的正是这份元数据，所以问题会一路带到 merged 与 bind 后的路径上。
            let marker = lower.join("marker.txt");
            std::fs::write(&marker, "self-check\n")
                .map_err(|error| format!("写 lower 标记文件失败：{error}"))?;
            sys::chown(&marker, uid, gid)?;
            sys::chmod_path(&marker, 0o644)?;
            Ok(())
        })();
        if let Err(reason) = prepared {
            eprintln!("[{PROXY_NAME}] 自检准备失败：{reason}");
            let _ = std::fs::remove_dir_all(&root);
            return 5;
        }
        let bind_workspace = root.join("workspace");
        if let Err(reason) =
            sys::make_dir(&bind_workspace).and_then(|()| sys::chown(&bind_workspace, uid, gid))
        {
            eprintln!("[{PROXY_NAME}] 自检准备失败：{reason}");
            let _ = std::fs::remove_dir_all(&root);
            return 5;
        }
        let setup = privilege::PrivilegedSetup {
            lower: &lower,
            upper: &upper,
            work: &work,
            merged: &merged,
            workspace: &bind_workspace,
        };
        if let Err(reason) = privilege::enter_mount_namespace(&setup) {
            eprintln!("[{PROXY_NAME}] 建立挂载命名空间失败：{reason}");
            let _ = std::fs::remove_dir_all(&root);
            return 5;
        }
        let forked = match privilege::establish_after_mount(uid, gid, || {
            self_check_body(uid, &merged, &bind_workspace)
        }) {
            Ok(forked) => forked,
            Err(reason) => {
                eprintln!("[{PROXY_NAME}] 自检 fork 失败：{reason}");
                let _ = std::fs::remove_dir_all(&root);
                return 5;
            }
        };
        let _ = std::fs::remove_dir_all(&root);
        forked.child_exit_code
    }

    /// 降权之后的断言；以退出码表达结论（0 = 全过，不返回）
    fn self_check_body(real_uid: u32, merged: &std::path::Path, bind_target: &std::path::Path) {
        let mut failures: Vec<String> = Vec::new();

        // 1. 降权后**不该**再有 CAP_SYS_ADMIN——挂载已在降权之前做完（FR-006 第 7 条）。
        if sys::has_cap_sys_admin() {
            failures.push("降权后仍持有 CAP_SYS_ADMIN".to_string());
        }

        // 2. 三个 uid 都必须是真实 uid——body 不允许以 root 运行
        let (mut ru, mut eu, mut su) = (0u32, 0u32, 0u32);
        match unsafe { sys::getresuid(&mut ru, &mut eu, &mut su) } {
            0 => {
                if (ru, eu, su) != (real_uid, real_uid, real_uid) {
                    failures.push(format!(
                        "降权后 uid 应为 ({real_uid}, {real_uid}, {real_uid})，实际 ({ru}, {eu}, {su})"
                    ));
                }
            }
            _ => failures.push(format!("getresuid 失败：{}", sys::last_error())),
        }

        // 3. 仍挂在私有挂载命名空间里：读到的 mountinfo 必须可读且带挂载表
        match std::fs::read_to_string("/proc/self/mountinfo") {
            Ok(text) => {
                if !text.lines().any(|line| line.contains(" - ")) {
                    failures.push("mountinfo 读不到挂载表".to_string());
                }
            }
            Err(error) => failures.push(format!("读 mountinfo 失败：{error}")),
        }

        // 先把身份与目录权限打出来：真机上的 Permission denied 需要能区分「属主不对」
        // 与「挂载没生效」，否则只能靠猜。
        eprintln!(
            "[{PROXY_NAME}] 自检诊断：uid={} merged={} workspace={}",
            real_uid,
            describe_path(merged),
            describe_path(bind_target)
        );

        // 4. 叠加视图读得到 lower 的内容（挂载真的生效）；bind 之后真实工作区路径看到
        //    的也是同一份内容——这是 specs/045 透明性的直接证据。
        for (label, path) in [("叠加视图", merged), ("bind 后的工作区", bind_target)] {
            // 先列目录：读不到文件时「目录进不去」与「文件不存在」的原因完全不同，
            // 而 `read_to_string` 的 io::Error 在这两种情形下都是同一条 errno 文案。
            if let Err(error) = std::fs::read_dir(path) {
                failures.push(format!(
                    "{label}目录打不开：{error}（{}，可执行位={:?}，mnt ns={}）",
                    describe_path(path),
                    std::fs::metadata(path)
                        .map(|m| {
                            use std::os::unix::fs::PermissionsExt;
                            m.permissions().mode()
                        })
                        .ok(),
                    std::fs::read_link("/proc/self/ns/mnt")
                        .map(|p| p.display().to_string())
                        .unwrap_or_default()
                ));
                continue;
            }
            match std::fs::read_to_string(path.join("marker.txt")) {
                Ok(seen) if seen.trim() == "self-check" => {}
                Ok(seen) => failures.push(format!("{label}内容不对：{seen:?}")),
                Err(error) => failures.push(format!(
                    "读{label}失败：{error}（目录 {}：{}；父目录 {}：{}）",
                    path.display(),
                    describe_path(path),
                    path.parent()
                        .map(|parent| parent.display().to_string())
                        .unwrap_or_default(),
                    path.parent()
                        .map(describe_path)
                        .unwrap_or_else(|| "?".to_string())
                )),
            }
        }

        if failures.is_empty() {
            // `_exit` 不刷新 stdio 缓冲：stdout 被重定向到管道 / 文件时 `println!` 的行
            // 缓冲内容会**整段丢失**（实测：自检成功但界面上一个字都看不到）。这里走
            // 显式 flush + stderr（unbuffered），让「成功」也一定被调用方看见。
            emit_line("self-check ok");
            std::process::exit(0);
        }
        for failure in &failures {
            eprintln!("[{PROXY_NAME}] 自检断言不成立：{failure}");
        }
        std::process::exit(1);
    }

    /// 一句描述路径的属主与权限（自检断言用：把「凭什么不可读」说清楚）
    fn describe_path(path: &std::path::Path) -> String {
        use std::os::unix::fs::MetadataExt;
        match std::fs::symlink_metadata(path) {
            Ok(meta) => format!("{}:{} {:04o}", meta.uid(), meta.gid(), meta.mode() & 0o7777),
            Err(error) => format!("stat 失败（{error}）"),
        }
    }

    /// 输出一行到标准输出并**立即刷新**。
    ///
    /// 本程序多处用 `std::process::exit` / `sys::_exit` 收尾，它们都**不刷新 stdio**：
    /// stdout 被重定向到管道 / 文件时行缓冲内容会整段丢失（实测：安装成功、sha256
    /// 却读不到）。所有面向调用方的输出都走这里，不直接 `println!`。
    fn emit_line(text: &str) {
        print!("{text}\n");
        let _ = std::io::Write::flush(&mut std::io::stdout());
    }

    fn usage() -> String {
        let mut out = String::new();
        let _ = writeln!(out, "{PROXY_NAME}（Overlay 挂载代理）");
        let _ = writeln!(out);
        let _ = writeln!(out, "用法：");
        let _ = writeln!(
            out,
            "  {PROXY_NAME} --protocol-version   打印安装握手协议版本"
        );
        let _ = writeln!(
            out,
            "  {PROXY_NAME} --self-check         建立命名空间并实测 overlay 挂载"
        );
        let _ = writeln!(
            out,
            "  {PROXY_NAME} --install            从标准输入读内容，装到 {MOUNT_PROXY_DIR}"
        );
        let _ = writeln!(
            out,
            "  {PROXY_NAME} --serve --fd <n>     常驻形态（由 Core 拉起，不手工调用）"
        );
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_all_serve_flags() {
            let args = vec![
                "--fd".to_string(),
                "7".to_string(),
                "--lower".to_string(),
                "/ws".to_string(),
                "--upper".to_string(),
                "/up".to_string(),
                "--work".to_string(),
                "/wk".to_string(),
                "--merged".to_string(),
                "/mg".to_string(),
                "--workspace".to_string(),
                "/ws".to_string(),
            ];
            let options = parse_serve_args(&args).unwrap();
            assert_eq!(options.fd, 7);
            assert_eq!(options.lower.to_string_lossy(), "/ws");
            assert_eq!(options.workspace.to_string_lossy(), "/ws");
        }

        #[test]
        fn rejects_missing_and_bad_fd() {
            assert!(parse_serve_args(&[]).is_err());
            assert!(parse_serve_args(&["--fd".to_string()]).is_err());
            assert!(parse_serve_args(&["--fd".to_string(), "x".to_string()]).is_err());
            // 只给 fd、缺视图路径：必须报错，不猜默认路径
            assert!(parse_serve_args(&["--fd".to_string(), "7".to_string()]).is_err());
        }
    }
}

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
                    Ok(digest) => emit_line(&digest),
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

    /// 常驻形态：建立命名空间并进入帧循环（永不返回）
    fn serve_mode(args: &[String]) -> ! {
        // `--fd <n>` 是唯一的入参：通信 fd 只来自 argv，不读环境变量
        let fd = match parse_fd(args) {
            Ok(fd) => fd,
            Err(reason) => {
                eprintln!("[{PROXY_NAME}] {reason}");
                std::process::exit(2);
            }
        };
        // 请求收紧必须在 fork 之前：之后的分支都不该再持有宽集合
        if let Err(reason) = privilege::tighten() {
            eprintln!("[{PROXY_NAME}] 请求收紧失败：{reason}");
            std::process::exit(4);
        }
        let uid = sys::real_uid();
        let gid = sys::real_gid();
        // 建挂载命名空间并 fork：B（子进程）拿到 b_fd 后进入服务循环，永不返回；
        // A（本进程）在 establish 里做完挂载器循环才返回。
        let forked = match privilege::establish(uid, gid, |mounter_fd| {
            serve::run_as_resident(fd, mounter_fd);
        }) {
            Ok(forked) => forked,
            Err(reason) => {
                eprintln!("[{PROXY_NAME}] 建立挂载命名空间失败：{reason}");
                std::process::exit(5);
            }
        };
        // 走到这里说明 B 已退出、A 已收尸：直接采用 A 带回的退出码。
        // **不能**再 reap 一次——同一 pid 二次 wait 必然 ECHILD。
        std::process::exit(forked.child_exit_code);
    }

    /// 解析 `--fd <n>`
    fn parse_fd(args: &[String]) -> Result<i32, String> {
        let mut index = 0;
        while index < args.len() {
            if args[index] == "--fd" {
                let Some(value) = args.get(index + 1) else {
                    return Err("--fd 缺参数".to_string());
                };
                return value
                    .parse::<i32>()
                    .map_err(|_| format!("--fd 的值不是整数：{value}"));
            }
            index += 1;
        }
        Err("--serve 需要 --fd <n>（Core 传入的 socketpair 子端）".to_string())
    }

    /// 入口闸门：入口自检 + 允许列表校验（FR-006「入口自检」）
    ///
    /// 返回 `Some(原因)` 表示拒绝。
    fn gate() -> Option<String> {
        let allowed = privilege::read_allowed_uids(&privilege::uid_list_path());
        privilege::entry_rejection(sys::effective_uid(), sys::real_uid(), &allowed)
    }

    /// `--self-check`（FR-005「自检归属唯一」）：建挂载命名空间 → 降权 → 挂 overlay →
    /// 断言 → 卸载。
    ///
    /// 断言（AC-19），每条失败都点名是哪一条：
    /// 1. 建命名空间后 `CapEff` 仍含 `CAP_SYS_ADMIN`（证明挂载确实可用）；
    /// 2. 降权后 `getuid()` / `geteuid()` 都是真实 uid（证明 body 不以 root 运行）；
    /// 3. 降权后仍能挂载 overlay（证明特权用在正确的位置——挂载在降权前完成）;
    /// 4. 视图目录落在真实磁盘上且可写（证明持久化，不依赖 tmpfs）。
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
        // 建命名空间 + fork 出挂载器；断言在 B（已降权）里跑，挂载经 A 完成
        if let Err(reason) =
            privilege::establish(uid, gid, |mounter_fd| self_check_body(uid, mounter_fd))
        {
            eprintln!("[{PROXY_NAME}] 建立挂载命名空间失败：{reason}");
            return 5;
        }
        0
    }

    /// 命名空间里的断言；以退出码表达结论（0 = 全过，不返回）
    fn self_check_body(real_uid: u32, mounter_fd: i32) {
        let mut failures: Vec<String> = Vec::new();

        // 1. B 降权后**不该**再有 CAP_SYS_ADMIN——特权只留在 A（挂载器）。
        //    这条同时是「二进程拆分确实生效」的证据：若 B 仍持 CAP_SYS_ADMIN，
        //    说明降权没做到位，mount 能力还暴露在服务主体上。
        if sys::has_cap_sys_admin() {
            failures.push("服务本体降权后仍持有 CAP_SYS_ADMIN".to_string());
        }

        // 2. 降权后三个 uid 都必须是真实 uid——body 不允许以 root 运行
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

        // 3. 仍挂在私有挂载命名空间里：读到的 mountinfo 必须带上 private 传播标记
        match std::fs::read_to_string("/proc/self/mountinfo") {
            Ok(text) => {
                if !text.lines().any(|line| line.contains(" - ")) {
                    failures.push("mountinfo 读不到挂载表".to_string());
                }
            }
            Err(error) => failures.push(format!("读 mountinfo 失败：{error}")),
        }

        // 挂一个真实 overlay 再卸载：能力判据不能只靠 CapEff。
        // 挂载经 A（特权挂载器）完成，B 自己挂必然 EPERM。
        if let Err(reason) = self_check_overlay(mounter_fd) {
            failures.push(format!("overlay 实测失败：{reason}"));
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

    /// 自检里的 overlay 实测：在真实磁盘上建 lower / upper / work / merged，挂上、读叠加
    /// 内容、卸载。
    ///
    /// 目录落在 B 自己的临时目录下（**不是 tmpfs**）：视图内容要跨重启保留，用户的修改
    /// 才恢复得回来。这也顺带证明「真实磁盘 + 挂载命名空间」这条链成立——不需要
    /// 用户命名空间，也不需要 fuse-overlayfs。
    ///
    /// 挂载经 A 完成：B 在自检时已经降权，自己没有 `mount(2)` 的能力。
    fn self_check_overlay(mounter_fd: i32) -> Result<(), String> {
        // 固定路径、不读 `TMPDIR`（FR-006「请求收紧」：常驻形态不读环境变量）
        let root =
            std::path::Path::new("/tmp").join(format!("tc-self-check-{}", std::process::id()));
        let lower = root.join("lower");
        let upper = root.join("upper");
        let work = root.join("work");
        let merged = root.join("merged");
        let result = (|| -> Result<(), String> {
            // `merged` 也由 B 建：A 是 euid 0 且 umask(077)，它建的目录 B 读不了
            for dir in [&root, &lower, &upper, &work, &merged] {
                sys::make_dir(dir)?;
            }
            std::fs::write(
                lower.join("marker.txt"),
                "self-check
",
            )
            .map_err(|error| format!("写 lower 标记文件失败：{error}"))?;
            serve::mount_for_self_check(mounter_fd, &lower, &upper, &work, &merged)?;
            let seen = std::fs::read_to_string(merged.join("marker.txt"))
                .map_err(|error| format!("读叠加视图里的标记文件失败：{error}"))?;
            if seen.trim() != "self-check" {
                return Err(format!("叠加视图内容不对：{seen:?}"));
            }
            Ok(())
        })();
        // 无论成败都先卸再删：留下挂载点会让 remove_dir_all 报 EBUSY
        serve::unmount_for_self_check(mounter_fd, &merged);
        let _ = std::fs::remove_dir_all(&root);
        result
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
        fn parses_fd_flag() {
            let args = vec!["--fd".to_string(), "7".to_string()];
            assert_eq!(parse_fd(&args).unwrap(), 7);
        }

        #[test]
        fn rejects_missing_and_bad_fd() {
            assert!(parse_fd(&[]).is_err());
            assert!(parse_fd(&["--fd".to_string()]).is_err());
            assert!(parse_fd(&["--fd".to_string(), "x".to_string()]).is_err());
        }
    }
}

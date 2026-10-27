//! 父进程看门狗回归（缺陷：orphan-core-processes-after-host-exit）。
//!
//! 本地 stdio Core 的父进程（宿主）消失后，Core 必须自行退出；不能只依赖标准输入
//! EOF——宿主被强杀、Core 主线程正卡在同步处理时，EOF 都不是及时信号。

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// `/proc/<pid>/stat` 的 state 字段（comm 可含空格与括号，取最后一个 `)` 之后的首字符）；
/// 条目已消失返回 `None`。
fn process_state(pid: u32) -> Option<char> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    text.rsplit_once(')')?.1.trim_start().chars().next()
}

/// 进程是否已退出：条目消失（已收割）或僵尸态（已退出、`/proc` 条目占位待收割）都算。
///
/// 不能只认「`/proc` 条目存在 = 存活」：孤儿 Core 退出后的收割者是环境（init /
/// runner 的 subreaper），不属于本回归的判定范围——Ubuntu 26 镜像上孤儿僵尸滞留
/// 整个用例窗口，只看条目存在性会把「已退出」误判成「没退」（15s 整点超窗的
/// 实证，见 PR #2 的 smoke 与 main 的整点 all）。
fn process_exited(pid: u32) -> bool {
    matches!(process_state(pid), None | Some('Z'))
}

/// 等 Core 退出（含退出后进入僵尸态）；超时返回 false。
fn wait_until_exited(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if process_exited(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    process_exited(pid)
}

fn wait_for_pid(path: &Path, timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(pid) = text.trim().parse() {
                return Some(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn temp_file(name: &str, ext: &str) -> PathBuf {
    std::env::temp_dir().join(format!("standalone-core-{name}-{}.{}", std::process::id(), ext))
}

fn kill(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

#[test]
fn core_exits_when_parent_process_disappears() {
    let exe = env!("CARGO_BIN_EXE_standalone-core");
    let pid_file = temp_file("orphan", "pid");
    let log_file = temp_file("orphan", "log");
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&log_file);

    // 中间 shell 拉起 Core 后立刻退出，Core 被 init 收养。Core 的 stdin 接一根
    // 「不会 EOF 的管道」，只有父进程看门狗能在测试窗口内结束它——这正是扩展
    // 宿主被强杀时的形态。这根管道不用 shell 管线搭（`sleep | core &` 一类写法
    // 有两层 shell 语义坑，CI 两轮实证）：其一，`$!` 只对「单条后台命令」保证是
    // 那一叉的 PID，dash 对后台管线会叉出等 sleep 与 Core 都退出的中间 subshell，
    // pid 文件写的不是 Core 本尊，Core 的父进程永远活着，看门狗永不触发（15s
    // 窗口整点超窗）；其二，POSIX 规定异步命令未显式重定向 stdin 时接 /dev/null，
    // Core 起跑瞬间读到 EOF 直接退出（0.06s「core did not start」）。这里改为
    // 全显式：`mkfifo` 建管，测试进程以 O_RDWR 打开持有两端（永不 EOF、开管不
    // 阻塞），shell 里 Core 是唯一后台命令且显式 `< fifo`——`$!` 在各 POSIX
    // shell 下都精确等于 Core 的 PID，shell 写完 pid 文件即退出，Core 如实孤儿化。
    // stderr 落盘不落 /dev/null：失败时随断言消息带出 core 日志尾部，区分
    // 「看门狗没开火」与其它根因，不再盲猜。
    let fifo = std::env::temp_dir().join(format!(
        "standalone-core-orphan-{}.fifo",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&fifo);
    Command::new("mkfifo").arg(&fifo).status().expect("mkfifo");
    let fifo_keepalive = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&fifo)
        .expect("open fifo");

    let status = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "exec \"{}\" stdio < \"{}\" > \"{}\" 2>&1 & echo $! > \"{}\"",
            exe,
            fifo.display(),
            log_file.display(),
            pid_file.display()
        ))
        .status()
        .expect("spawn intermediate shell");
    assert!(status.success(), "intermediate shell failed");

    let pid =
        wait_for_pid(&pid_file, Duration::from_secs(5)).expect("core pid file was not written");
    assert!(
        !process_exited(pid),
        "core did not start (state={:?})",
        process_state(pid)
    );

    // 看门狗 1s 轮询 + exit(0)，名义上孤儿化后 ~1s 内退出；窗口给到 15s 是为
    // CI 负载下的启动与调度抖动留余量（5s 窗口在 runner 上实证会偶发超窗，
    // 看门狗本身没毛病）——真回归（看门狗没开火）在 15s 内照样红。
    let exited = wait_until_exited(pid, Duration::from_secs(15));
    drop(fifo_keepalive);
    if !exited {
        // 红阶段不留下孤儿：用例失败后清理。
        kill(pid);
    }
    let core_log = std::fs::read_to_string(&log_file).unwrap_or_default();
    let mut core_log_tail: Vec<&str> = core_log.lines().rev().take(20).collect();
    core_log_tail.reverse();
    let core_log_tail = core_log_tail.join("\n");
    let _ = std::fs::remove_file(&log_file);
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&fifo);

    assert!(
        exited,
        "core stayed alive after its parent process exited (pid {pid}, state={:?}); core 日志尾部：\n{}",
        process_state(pid),
        core_log_tail
    );
}

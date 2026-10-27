//! 父进程看门狗回归（缺陷：orphan-core-processes-after-host-exit）。
//!
//! 本地 stdio Core 的父进程（宿主）消失后，Core 必须自行退出；不能只依赖标准输入
//! EOF——宿主被强杀、Core 主线程正卡在同步处理时，EOF 都不是及时信号。

#![cfg(unix)]

use std::path::Path;
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
/// runner 的 subreaper），不属于本回归的判定范围——Ubuntu 26 镜像上僵尸可能滞留
/// 整个用例窗口，只看条目存在性会把「已退出」误判成「没退」。
fn process_exited(pid: u32) -> bool {
    matches!(process_state(pid), None | Some('Z'))
}

/// 等进程退出（含退出后进入僵尸态）；超时返回 false。
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

fn temp_file(name: &str, ext: &str) -> std::path::PathBuf {
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

    // 中间 shell 是 Core 的父进程：拉起 Core 后立刻退出，Core 被 init 收养。
    // Core 的 stdin 接 `sleep` 的 stdout（一根不会 EOF 的管道），因此只有父进程
    // 看门狗能在测试窗口内结束它——这正是扩展宿主被强杀时的形态。
    // stderr 落盘不落 /dev/null：失败时随断言消息带出，区分「看门狗没开火」与
    // 「已退出但僵尸滞留」两类根因。
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "sleep 60 | '{}' stdio >'{}' 2>&1 & echo $! > '{}'",
            exe,
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
    if !exited {
        // 红阶段不留下孤儿：用例失败后清理。
        kill(pid);
    }
    let core_log = std::fs::read_to_string(&log_file).unwrap_or_default();
    let core_log_tail: String = core_log
        .lines()
        .rev()
        .take(20)
        .collect::<Vec<_>>()
        .rev()
        .join("\n");
    let _ = std::fs::remove_file(&log_file);
    let _ = std::fs::remove_file(&pid_file);

    assert!(
        exited,
        "core stayed alive after its parent process exited (pid {pid}, state={:?}); core 日志尾部：\n{}",
        process_state(pid),
        core_log_tail
    );
}

//! 父进程看门狗回归（缺陷：orphan-core-processes-after-host-exit）。
//!
//! 本地 stdio Core 的父进程（宿主）消失后，Core 必须自行退出；不能只依赖标准输入
//! EOF——宿主被强杀、Core 主线程正卡在同步处理时，EOF 都不是及时信号。

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// 等 Core 退出；超时返回 false。
fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !process_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !process_alive(pid)
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

/// `/proc/<pid>` 存在即视为存活（僵尸进程也占位，Core 正常退出后由 init 回收）。
fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn temp_pid_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("standalone-core-{name}-{}.pid", std::process::id()))
}

fn kill(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

#[test]
fn core_exits_when_parent_process_disappears() {
    let exe = env!("CARGO_BIN_EXE_standalone-core");
    let pid_file = temp_pid_file("orphan");
    let _ = std::fs::remove_file(&pid_file);

    // 中间 shell 拉起 Core 后立刻退出，Core 被 init 收养。Core 的 stdin 接 `sleep` 的
    // stdout（一根不会 EOF 的管道），因此只有父进程看门狗能在测试窗口内结束它——
    // 这正是扩展宿主被强杀时的形态。
    //
    // pid 文件必须写 Core 本尊的 PID：`$!` 只对「单条后台命令」保证是那一叉的 PID。
    // 后台管线在 dash（Ubuntu 的 /bin/sh）下会叉出等 sleep 与 Core 都退出的中间
    // subshell，`$!` 落在它头上——Core 的父进程因此永远活着，看门狗永不触发
    // （15s 窗口在 runner 上两轮整点超窗的实证）。内层 `sh -c 'exec … & echo $!'`
    // 把 Core 叉成内层 shell 的唯一后台命令后 exec 顶替，各 POSIX shell 下 `$!` 都
    // 精确等于 Core 的 PID；内层 shell 写完 pid 文件即退出，Core 如实孤儿化。
    // `<&0` 必须显式带上：POSIX 规定异步命令未显式重定向 stdin 时接 /dev/null，
    // Core 会在起跑瞬间读到 EOF 直接退出（runner 上 0.06s「core did not start」的
    // 实证）；显式继承内层 shell 的 stdin（外层管线的读端）才是一根不会 EOF 的管道。
    // 外层管线整体后台化：否则 `status()` 会陪 `sleep` 等满全程。
    let status = Command::new("sh")
        .arg("-c")
        .arg(format!(
            "sleep 60 | sh -c 'exec \"{}\" stdio <&0 >/dev/null 2>&1 & echo $! > \"{}\"' &",
            exe,
            pid_file.display()
        ))
        .status()
        .expect("spawn intermediate shell");
    assert!(status.success(), "intermediate shell failed");

    let pid =
        wait_for_pid(&pid_file, Duration::from_secs(5)).expect("core pid file was not written");
    assert!(process_alive(pid), "core did not start");

    // 看门狗 1s 轮询 + exit(0)，名义上孤儿化后 ~1s 内退出；窗口给到 15s 是为
    // CI 负载下的启动与调度抖动留余量（5s 窗口在 runner 上实证会偶发超窗，
    // 看门狗本身没毛病）——真回归（看门狗没开火）在 15s 内照样红。
    let exited = wait_until_dead(pid, Duration::from_secs(15));
    if !exited {
        // 红阶段不留下孤儿：用例失败后清理。
        kill(pid);
    }
    let _ = std::fs::remove_file(&pid_file);

    assert!(
        exited,
        "core stayed alive after its parent process exited (pid {pid})"
    );
}

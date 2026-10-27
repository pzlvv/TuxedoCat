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

    // 中间 shell 拉起 Core 后**稍后**退出，Core 被 init 收养。Core 的 stdin 接一根
    // 「不会 EOF 的管道」，只有父进程看门狗能在测试窗口内结束它——这正是扩展宿主
    // 被强杀时的形态。
    //
    // 这套装配有三层 shell 语义坑（CI 三轮实证各中一轮），逐一显式化：
    // 其一，父 shell 必须比 Core 的父 PID 记录活得久——Core 要等运行时起来才在
    // `run_core()` 里调 `parent_id()`，shell 写完 pid 文件就退的话记录到的是收养
    // 进程（pid 1），看门狗从此盯着一号进程永不开火（15s 窗口整点超窗的根因）；
    // 尾部 `sleep 2` 给出 ~100 倍余量。其二，`$!` 只对「单条后台命令」保证是那一
    // 叉的 PID，后台管线在 dash 下会叉出等 sleep 与 Core 都退出的中间 subshell，
    // pid 文件会写成 subshell 头上；Core 保持单条后台命令 + `exec` 顶替。其三，
    // POSIX 规定异步命令未显式重定向 stdin 时接 /dev/null，Core 起跑瞬间读到 EOF
    // 直接退出（0.06s「core did not start」）——stdin 显式接 FIFO，且由测试进程
    // O_RDWR 持有（永不 EOF、开管不阻塞）。
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
            "exec \"{}\" stdio < \"{}\" >/dev/null 2>&1 & echo $! > \"{}\"; sleep 2",
            exe,
            fifo.display(),
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
    drop(fifo_keepalive);
    if !exited {
        // 红阶段不留下孤儿：用例失败后清理。
        kill(pid);
    }
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&fifo);

    assert!(
        exited,
        "core stayed alive after its parent process exited (pid {pid})"
    );
}

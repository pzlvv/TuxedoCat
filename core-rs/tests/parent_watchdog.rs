//! 父进程看门狗回归（缺陷：orphan-core-processes-after-host-exit）。
//!
//! 本地 stdio Core 的父进程（宿主）消失后，Core 必须自行退出；不能只依赖标准输入
//! EOF——宿主被强杀、Core 主线程正卡在同步处理时，EOF 都不是及时信号。
//!
//! 时序是本用例的全部难点：Core 在 main 早期（动态链接完成后）才读一次 `getppid`
//! 装看门狗，runner 满载时这段启动可长达数秒——父进程若抢在这之前退出，Core 读到
//! 的就是收养者（init / subreaper），看门狗盯上永生的收养者、永不触发（ubuntu-26
//! 镜像上三种测试构造同以 15s 整点超窗的根因，CI 多轮实证）。因此本用例按
//! **顺序**而不是按时钟构造竞态：等 Core 打出「看门狗已武装」诊断（`[core]
//! watchdog armed on parent`）之后再杀父进程——「先武装、后失父」由观察顺序保证，
//! 与启动耗时无关。

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// `/proc/<pid>/stat` 的 (state, starttime)（comm 可含空格与括号，取最后一个 `)`
/// 之后的部分再按空白切分；state 是第 3 字段、starttime 是第 22 字段）。
/// 条目已消失返回 `None`。
fn process_state_and_start(pid: u32) -> Option<(char, u64)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = text.rsplit_once(')')?.1.split_whitespace().collect::<Vec<_>>();
    let state = fields.first()?.chars().next()?;
    let start: u64 = fields.get(19)?.parse().ok()?;
    Some((state, start))
}

/// 进程是否已退出。判定必须同时比对 pid 与 starttime：
///
/// - 条目消失（已收割）与僵尸态（已退出、`/proc` 条目占位待收割）都算退出——
///   回归意图是「Core 自行退出」，收割是环境职责；
/// - **pid 复用也算退出**：runner 上并行的测试风暴 fork 频繁，进程退出后 PID
///   可能数秒内被无关进程复用，只看「/proc 条目存在且非僵尸」会把复用者误判
///   成 Core（实证：断言时 `state=None` 而 core 日志带 `[core] exited`）。
fn process_exited(pid: u32, core_start: Option<u64>) -> bool {
    match (process_state_and_start(pid), core_start) {
        (None, _) => true,
        (Some((state, _)), _) if state == 'Z' => true,
        (Some((_, start)), Some(core_start)) => start != core_start,
        (Some(_), None) => false,
    }
}

/// 等进程退出（含退出后进入僵尸态）；超时返回 false。
fn wait_until_exited(pid: u32, core_start: Option<u64>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if process_exited(pid, core_start) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    process_exited(pid, core_start)
}

/// 等文件里出现目标行；超时返回 false。
fn wait_for_line(path: &Path, needle: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            if text.lines().any(|line| line.contains(needle)) {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
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
    let parent_file = temp_file("orphan-parent", "pid");
    let log_file = temp_file("orphan", "log");
    for path in [&pid_file, &parent_file, &log_file] {
        let _ = std::fs::remove_file(path);
    }

    // 中间 shell 拉起 Core 后被测试显式杀死，Core 被 init 收养。Core 的 stdin 接
    // 一根「不会 EOF 的管道」，只有父进程看门狗能在测试窗口内结束它——这正是
    // 扩展宿主被强杀时的形态。这根管道不用 shell 管线搭（`sleep | core &` 一类
    // 写法有两层 shell 语义坑，CI 多轮实证）：其一，`$!` 只对「单条后台命令」
    // 保证是那一叉的 PID，dash 对后台管线会叉出等 sleep 与 Core 都退出的中间
    // subshell，pid 文件写的不是 Core 本尊，Core 的父进程永远活着，看门狗永不
    // 触发；其二，POSIX 规定异步命令未显式重定向 stdin 时接 /dev/null，Core
    // 起跑瞬间读到 EOF 直接退出（0.06s「core did not start」）。这里改为全显式：
    // `mkfifo` 建管，测试进程以 O_RDWR 打开持有两端（永不 EOF、开管不阻塞），
    // shell 里 Core 是唯一后台命令且显式 `< fifo`——`$!` 精确等于 Core 的 PID。
    // shell 自身 PID（`$$`，即 Core 的父进程）落盘给测试按需杀死；`sleep 90` 让
    // 父进程活过 Core 的启动与武装，杀死时机由测试按「已武装」诊断决定，不靠
    // 定时赌。stderr 落盘：失败时随断言消息带出，不再盲猜。
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
            "exec \"{}\" stdio < \"{}\" > \"{}\" 2>&1 & echo $! > \"{}\"; echo $$ > \"{}\"; sleep 90",
            exe,
            fifo.display(),
            log_file.display(),
            pid_file.display(),
            parent_file.display()
        ))
        .status()
        .expect("spawn intermediate shell");
    assert!(status.success(), "intermediate shell failed");

    let pid: u32 = wait_for_pid(&pid_file, Duration::from_secs(5))
        .expect("core pid file was not written");
    let parent_pid: u32 = wait_for_pid(&parent_file, Duration::from_secs(5))
        .expect("parent pid file was not written");
    let (state, core_start) =
        process_state_and_start(pid).expect("core exited before arming");
    assert!(state != 'Z', "core did not start (state={state:?})");

    // 等「看门狗已武装」诊断（Core 记录父 PID 之后的第一个动作）：它出现前杀父
    // 进程就是在赌启动耗时。满载下 Core 启动可慢于任何固定时钟，宽限给足 60s
    // （父进程 sleep 90 活得更久，先看武装后杀父的顺序不被打破）。
    assert!(
        wait_for_line(&log_file, "watchdog armed on parent", Duration::from_secs(60)),
        "watchdog never armed; core 日志尾部：\n{}",
        std::fs::read_to_string(&log_file).unwrap_or_default()
    );

    // 已武装 → 杀父进程（孤儿化落地）：看门狗 1s 轮询 + exit(0)，~1s 内退出；
    // 15s 窗口为 CI 负载留余量——真回归（看门狗没开火）在窗口内照样红。
    kill(parent_pid);
    let exited = wait_until_exited(pid, Some(core_start), Duration::from_secs(15));
    drop(fifo_keepalive);
    let core_log = std::fs::read_to_string(&log_file).unwrap_or_default();
    let mut core_log_tail: Vec<&str> = core_log.lines().rev().take(20).collect();
    core_log_tail.reverse();
    let core_log_tail = core_log_tail.join("\n");
    let _ = std::fs::remove_file(&log_file);
    let _ = std::fs::remove_file(&pid_file);
    let _ = std::fs::remove_file(&parent_file);
    let _ = std::fs::remove_file(&fifo);

    assert!(
        exited,
        "core stayed alive after its armed parent (pid {parent_pid}) was killed \
         — core pid {pid}, state={:?}; core 日志尾部：\n{}",
        process_state_and_start(pid).map(|(state, _)| state),
        core_log_tail
    );
    // 看门狗路径的自证：开火时必先打诊断。它在退出之前写就，退出被观测到则
    // 这行必已在日志里。
    assert!(
        core_log.contains("parent process"),
        "看门狗开火诊断缺失；core 日志尾部：\n{core_log_tail}"
    );
}

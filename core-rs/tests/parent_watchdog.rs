//! 父进程看门狗回归（缺陷：orphan-core-processes-after-host-exit）。
//!
//! 本地 stdio Core 的父进程（宿主）消失后，Core 必须自行退出；不能只依赖标准输入
//! EOF——宿主被强杀、Core 主线程正卡在同步处理时，EOF 都不是及时信号。

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// `/proc/<pid>/stat` 的 (state, ppid, starttime)（comm 可含空格与括号，取最后一个
/// `)` 之后的部分再按空白切分；state 是第 3 字段、ppid 是第 4、starttime 是第 22）。
/// 条目已消失返回 `None`。
fn stat_fields(pid: u32) -> Option<(char, u64, u64)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields = text.rsplit_once(')')?.1.split_whitespace().collect::<Vec<_>>();
    let state = fields.first()?.chars().next()?;
    let ppid: u64 = fields.get(1)?.parse().ok()?;
    let start: u64 = fields.get(19)?.parse().ok()?;
    Some((state, ppid, start))
}

/// 进程是否已退出。判定必须同时比对 pid 与 starttime：
///
/// - 条目消失（已收割）与僵尸态（已退出、`/proc` 条目占位待收割）都算退出——
///   回归意图是「Core 自行退出」，收割是环境职责；
/// - **pid 复用也算退出**：runner 上并行的测试风暴 fork 频繁，进程退出后 PID
///   可能数秒内被无关进程复用，只看「/proc 条目存在且非僵尸」会把复用者误判
///   成 Core（实证：断言时 `state=None` 而 core 日志带 `[core] exited`）。
fn process_exited(pid: u32, core_start: Option<u64>) -> bool {
    match (stat_fields(pid), core_start) {
        (None, _) => true,
        (Some((state, _, _)), _) if state == 'Z' => true,
        (Some((_, _, start)), Some(core_start)) => start != core_start,
        (Some(_), None) => false,
    }
}

/// 等 Core 退出（含退出后进入僵尸态）；超时返回 false。
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

fn wait_until(path: &Path, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(text) = std::fs::read_to_string(path) {
            let trimmed = text.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
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

    // 中间 shell 拉起 Core 后立刻退出，Core 被 init 收养。Core 的 stdin 接一根
    // 「不会 EOF 的管道」，只有父进程看门狗能在测试窗口内结束它——这正是扩展
    // 宿主被强杀时的形态。这根管道不用 shell 管线搭（`sleep | core &` 一类写法
    // 有两层 shell 语义坑，CI 多轮实证）：其一，`$!` 只对「单条后台命令」保证是
    // 那一叉的 PID，dash 对后台管线会叉出等 sleep 与 Core 都退出的中间 subshell，
    // pid 文件写的不是 Core 本尊，Core 的父进程永远活着，看门狗永不触发；其二，
    // POSIX 规定异步命令未显式重定向 stdin 时接 /dev/null，Core 起跑瞬间读到
    // EOF 直接退出（0.06s「core did not start」）。这里改为全显式：`mkfifo` 建管，
    // 测试进程以 O_RDWR 打开持有两端（永不 EOF、开管不阻塞），shell 先把**自己的
    // PID**（`$$`，即 Core 的父进程）落盘再起 Core——孤儿化是可观测的前置事实，
    // 不是猜出来的前提。stderr 落盘不落 /dev/null：失败时随断言消息带出。
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
            "echo $$ > \"{}\"; exec \"{}\" stdio < \"{}\" > \"{}\" 2>&1 & echo $! > \"{}\"; sleep 3",
            parent_file.display(),
            exe,
            fifo.display(),
            log_file.display(),
            pid_file.display()
        ))
        .status()
        .expect("spawn intermediate shell");
    assert!(status.success(), "intermediate shell failed");

    let parent_pid: u32 = wait_until(&parent_file, Duration::from_secs(5))
        .expect("parent pid file was not written")
        .parse()
        .expect("parent pid is not a number");
    let pid: u32 = wait_until(&pid_file, Duration::from_secs(5))
        .expect("core pid file was not written")
        .parse()
        .expect("core pid is not a number");
    let (state, ppid, core_start) = stat_fields(pid).expect("core exited immediately");
    assert!(state != 'Z', "core did not start (state={state:?})");
    // Core 在 main 早期读一次 getppid 装看门狗；若 shell 抢先退出（孤儿化先于
    // 取父），看门狗会盯上收养者（init / runner subreaper）永远不触发——ubuntu-26
    // 镜像上启动变慢使此竞态从偶发变必现（三轮 15s 整点超窗、core 日志无看门狗
    // diag 的实证）。shell 末尾的 `sleep 3` 就是为此存在的宽限：Core 的 getppid
    // 必落在父进程存活期。竞态若仍然输掉，在这里以明确信息失败，不进谜之超窗。
    assert_eq!(
        ppid, parent_pid as u64,
        "test infra: core armed its watchdog on the wrong parent (ppid {ppid}, \
         expected {parent_pid})——孤儿化先于取父，宽限期不够"
    );

    // 等中间 shell 退出（孤儿化落地）再开表：这之前看门狗不开火是正确行为。
    // shell 不退出是用例基建故障，与被测逻辑无关，显式失败并带现场。
    assert!(
        wait_until_exited(parent_pid, None, Duration::from_secs(5)),
        "test infra: intermediate shell (parent pid {parent_pid}) never exited; core state={:?}",
        stat_fields(pid)
    );
    let (state, ppid, core_start) = stat_fields(pid).expect("core exited before the window opened");
    assert!(state != 'Z', "core did not start (state={state:?})");

    // 看门狗 1s 轮询 + exit(0)，名义上孤儿化后 ~1s 内退出；窗口给到 15s 是为
    // CI 负载下的启动与调度抖动留余量（5s 窗口在 runner 上实证会偶发超窗，
    // 看门狗本身没毛病）——真回归（看门狗没开火）在 15s 内照样红。
    let exited = wait_until_exited(pid, Some(core_start), Duration::from_secs(15));
    drop(fifo_keepalive);
    if !exited {
        // 红阶段不留下孤儿：用例失败后清理（pid + starttime 判定仍在，不会误杀
        // 复用同一 PID 的无关进程）。
        kill(pid);
    }
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
        "core stayed alive after its parent process (pid {parent_pid}) exited \
         — core pid {pid}, state={:?}, ppid now={:?}, parent alive={:?}; core 日志尾部：\n{}",
        stat_fields(pid).map(|(state, _, _)| state),
        stat_fields(pid).map(|(_, ppid, _)| ppid),
        stat_fields(parent_pid).map(|(state, _, _)| state != 'Z'),
        core_log_tail
    );
}

//! 系统电源阻断：任一会话非 idle 时阻止本进程所在机器进入睡眠 / 休眠。
//!
//! 归属：Electron 宿主用 `powerSaveBlocker` 阻断它所在机器的睡眠
//! （`electron/powerSaveBlocker.ts`）；Standalone Core 是独立进程（本地 `stdio` 单进程 /
//! 远程 daemon 的每个工作区一个进程，见 `docs/standalone-core.md` 第 1 节），跑在宿主
//! 不一定管得到的机器上——远程工作区的长任务在远端执行，宿主那台机器睡不睡与它无关。
//! 因此由 Core 进程自己阻断它所在机器的睡眠。两处判定口径一致：任一会话 `idle == false`
//! （含等待用户确认）即阻断（`docs/host-matrix.md` 第 6 节宿主接线、docs/host-matrix.md 第 12 节宿主固有差异）。
//!
//! 阻断类型与 Electron 侧一致——只要求系统不挂起、允许屏幕熄灭：
//!
//! - **Windows**：`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`。该 API 是
//!   **线程级**的，必须由常驻线程持有，故阻断期间独占一条线程；释放时清标志并回收线程。
//! - **Linux**：`systemd-inhibit --what=idle:sleep --mode=block` 子进程（systemd 提供的
//!   官方抑制入口）。子进程的 stdin 是本进程持有的管道：正常释放时 kill 子进程，本进程被
//!   强杀时管道关闭、子进程读到 EOF 自行退出——不会留下孤儿把机器一直钉醒。
//! - **其余平台**：当前产出矩阵只有 Windows x64 与 Linux x64 / arm64
//!   （`docs/standalone-core.md` 第 1 节），没有实现；保持不阻断并落一条诊断。

use std::sync::Mutex;

use serde_json::Value;

use crate::util::diag;

/// 任一会话非 idle → 需要阻断睡眠。
///
/// `idle` 是引擎推的派生字段（`Core::emit_runtime`，`DEVELOPMENT.md` 第 5.8 节）：自身查询 / 压缩 /
/// 后台 Bash / 子代理 / 等待用户任一为真时 `idle == false`。判定口径与 Electron 侧
/// `shouldPreventSleep` 一致。
pub fn should_prevent_sleep(states: &[Value]) -> bool {
    states
        .iter()
        .any(|state| state.get("idle").and_then(Value::as_bool) == Some(false))
}

/// 阻断句柄：`Drop` 即释放（Windows 清线程标志并回收线程；Linux kill 子进程）。
type Handle = platform::Handle;

/// 进程内唯一的阻断状态机。
///
/// 只保存「当前是否已阻断」这一个事实；`sync` 幂等——全量快照高频重复推送不会重复
/// 申请阻断，也不会误停已在生效的阻断。
struct Guard<H> {
    /// 当前阻断句柄；`None` = 未阻断
    active: Option<H>,
    /// 平台入口：不支持 / 依赖缺失时返回 `None`
    start: fn() -> Option<H>,
    /// 平台入口已试过且失败：不再重试，避免每次状态变化都拉一次注定失败的子进程
    unavailable: bool,
}

impl<H> Guard<H> {
    fn new(start: fn() -> Option<H>) -> Self {
        Self { active: None, start, unavailable: false }
    }

    /// 按「是否需要阻断」同步状态：需要则申请（已有则 no-op），不需要则释放
    /// （本就未阻断则 no-op）。
    fn sync(&mut self, prevent: bool) {
        if !prevent {
            self.active = None;
            return;
        }
        if self.active.is_some() || self.unavailable {
            return;
        }
        self.active = (self.start)();
        if self.active.is_none() {
            self.unavailable = true;
            diag!(
                "[core] power: sleep blocker unavailable \
                 (unsupported platform or missing systemd-inhibit); \
                 a running task may be interrupted by system sleep"
            );
        }
    }
}

/// 进程内唯一的阻断状态。懒初始化：首次同步时才碰平台 API（进程里没有会话在忙时
/// 不产生任何副作用）。
static GUARD: Mutex<Option<Guard<Handle>>> = Mutex::new(None);

/// 按「是否需要阻断」更新阻断（幂等）。
pub fn set_prevent_sleep(prevent: bool) {
    let mut slot = GUARD.lock().unwrap();
    slot.get_or_insert_with(|| Guard::new(Handle::start))
        .sync(prevent);
}

/// 平台阻断实现。
#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{self, Sender};
    use std::thread::{self, JoinHandle};

    /// `SetThreadExecutionState` 标志位（`winbase.h`）：`ES_CONTINUOUS` 让请求持续生效
    /// 直到再次调用，`ES_SYSTEM_REQUIRED` 要求系统保持可用（屏幕仍可熄灭）。
    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        /// 设置当前**线程**的执行状态请求，返回上一个状态（0 = 失败）
        #[allow(non_snake_case)]
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    pub struct Handle {
        /// 释放信号；发送端被丢弃同样唤醒常驻线程
        release: Option<Sender<()>>,
        /// 持有 `ES_SYSTEM_REQUIRED` 的常驻线程
        thread: Option<JoinHandle<()>>,
    }

    impl Handle {
        pub fn start() -> Option<Handle> {
            let (release, released) = mpsc::channel::<()>();
            let thread = thread::Builder::new()
                .name("power-save-blocker".to_string())
                .spawn(move || {
                    // 线程级 API：本线程存活期间系统不挂起。标志由内核持有到清除为止，
                    // 因此线程必须常驻（`recv` 阻塞），不能设完就返回。
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                    let _ = released.recv();
                    // 只置 `ES_CONTINUOUS` = 清除本线程的全部请求
                    unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                })
                .ok()?;
            Some(Handle { release: Some(release), thread: Some(thread) })
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // 先投递释放信号（丢弃发送端等价），再 join：不能只靠线程自行超时，
            // 否则释放是异步的，连续「忙→闲→忙」可能同时存在两条持标志的线程。
            drop(self.release.take());
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Linux：`systemd-inhibit` 子进程（非 systemd 发行版上不存在，按不支持处理）。
#[cfg(target_os = "linux")]
mod platform {
    use std::process::{Child, ChildStdin, Command, Stdio};
    use std::thread;
    use std::time::Duration;

    use crate::cli;

    /// 抑制范围：空闲检测与系统睡眠，对齐 Electron 的 `prevent-app-suspension`
    /// （屏幕仍可熄灭）。
    const WHAT: &str = "idle:sleep";

    /// 观察 `systemd-inhibit` 是否真的取上抑制锁的时长（见 [`Handle::start`]）。
    ///
    /// 这是一次性的固定开销（每个「忙」周期一次），换来的是「失败不被静默吞掉」：
    /// 取锁失败时它立刻退出，`spawn` 本身却会成功。
    const READY_CHECK_DELAY: Duration = Duration::from_millis(100);

    pub struct Handle {
        child: Child,
        /// 子进程的 stdin 写端。本进程存活期间管道不关，`cat` 阻塞在读上；
        /// 本进程被强杀时管道关闭，`cat` 读到 EOF 退出，`systemd-inhibit` 随之释放抑制。
        _liveness: ChildStdin,
    }

    impl Handle {
        pub fn start() -> Option<Handle> {
            // stderr 不重定向：`systemd-inhibit` 的失败原因（无 D-Bus / 无 session /
            // 参数被拒）直接进本进程的诊断输出，宿主会把它落进 core 日志。
            let mut command = Command::new("systemd-inhibit");
            command
                .arg(format!("--what={WHAT}"))
                .arg("--mode=block")
                .arg(format!("--who={}", cli::program_name()))
                .arg("--why=task in progress")
                .arg("cat")
                .stdin(Stdio::piped())
                .stdout(Stdio::null());
            // 与 Core 的全部 spawn 同一口径：统一走 hide_console（非 Windows 是 no-op）
            crate::util::hide_console(&mut command);
            let mut child = command.spawn().ok()?;
            let liveness = child.stdin.take()?;
            // `systemd-inhibit` 先取抑制锁、再 exec 命令：取锁失败时它立刻退出，而
            // `spawn` 仍然成功。隔一小段观察它是否还活着，早退即按「不支持」处理。
            thread::sleep(READY_CHECK_DELAY);
            if child.try_wait().ok().flatten().is_some() {
                return None;
            }
            Some(Handle { child, _liveness: liveness })
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// 其余平台：没有实现（产出矩阵见 `docs/standalone-core.md` 第 1 节）。
#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    #[allow(dead_code)]
    pub struct Handle;

    impl Handle {
        pub fn start() -> Option<Handle> {
            None
        }
    }
}

#[cfg(test)]
#[path = "power_tests.rs"]
mod tests;

//! daemon 进程模型（见 `docs/core-daemon.md`）。
//!
//! 职责：
//! - 一个 endpoint 一个 daemon；一个工作区一个 Core 进程（daemon 持有其 stdio）；
//! - 控制通道上的多路复用：每个 Core 的帧通道是它上面的一条逻辑 channel；
//! - Core 的启动、重启（退避 + 上限）、终止都由 daemon 承担；
//! - 控制通道断开时关闭全部 Core 并退出；`idle_exit` 为真时，活着的 Core 计数归零
//!   后还经 grace 期退出（远程监听不设，见 `remote::remote_daemon_options`）。
//!
//! 线程模型：
//! - 主循环只做状态机与转发，输入事件经 `DaemonEvent` 通道汇聚；
//! - 每个 Core 进程各有一个 stdout 读线程、stderr 诊断线程、stdin 写线程与退出监视
//!   线程：单条 channel 的阻塞不会拖住其它 channel（规格第 7.4 节背压）；
//! - 控制通道出站经 `FrameOutput`：远程实现是加锁串行的 socket 写，越过软水位只
//!   记录诊断，不丢帧。
//!
//! 进程工厂（`CoreSpawner`）与事件汇（`CoreEventSink`）都做了抽象：
//! 单元测试注入假进程，不需要真实可执行文件。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel as mpsc_channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::daemon_protocol::{
    ChannelDescriptor, DaemonToHostFrame, DirectoryFailureReason, HostToDaemonFrame,
    WorkspaceCloseReason,
};

/// 一条控制通道上的 daemon 会话结束原因。
///
/// 远程 daemon 是常驻 server：只有 `Stop` 才结束进程，`Continue` 表示回到 accept
/// 等下一条连接（`remote::run_start_daemon`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelExit {
    /// 结束 daemon：对端发 `shutdown`、空闲到 grace 期，或内部错误
    Stop,
    /// 只是这条控制通道断了：daemon 继续
    Continue,
}

// ==================== 参数 ====================

/// 重启策略（与 TS 侧 `CoreProcess` 的 `restartPolicy` 同口径）
#[derive(Clone, Debug)]
pub struct RestartPolicy {
    /// 时间窗口内允许的重启次数
    pub max_attempts: usize,
    /// 窗口长度
    pub window: Duration,
    /// 首次重启延迟
    pub base_delay: Duration,
    /// 重启延迟上限
    pub max_delay: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            window: Duration::from_secs(60),
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(10),
        }
    }
}

/// daemon 运行参数
#[derive(Clone, Debug)]
pub struct DaemonOptions {
    /// 活着的 Core 计数归零后的 grace 期
    pub grace_period: Duration,
    /// 关闭工作区时等待 Core 优雅退出的上限
    pub shutdown_timeout: Duration,
    pub restart_policy: RestartPolicy,
    /// 计数归零后是否经 grace 期退出。
    ///
    /// - 本地 stdio：`true`。Host 连接着但一个工作区都没开时，daemon 最终退出，
    ///   避免空转进程；
    /// - 远程 daemon：`false`。控制通道本身是生命周期边界：连接在，daemon 就在
    ///   （目录选择期间可能长时间没有工作区）；连接断开走 `HostDisconnected` 退出。
    pub idle_exit: bool,
    /// 第一帧 `auth` 的等待上限（远程控制通道；`docs/core-daemon.md` 第 12.4 节）。
    ///
    /// accept 循环是同步单连接：连接后不发 `auth` 的探活连接 / 端口扫描占着它，
    /// 后续接入全部饿死。超时即关闭这条连接。
    pub auth_timeout: Duration,
    /// 心跳空闲超时（远程控制通道；`docs/core-daemon.md` 第 12.5 节）。
    ///
    /// 见过首个 `ping` 后启用：这么长时间没再收到任何控制帧，按 Host 断开处理
    /// （close_all + 回到 accept）。Host 消失而 TCP 未断（断网 / 休眠 / 进程冻结）
    /// 时这是唯一的回收手段。`None` = 不启用（本地 stdio 没有 ping；旧版 Host
    /// 也不发 ping，保持原有行为）。
    pub heartbeat_timeout: Option<Duration>,
}

/// 远程控制通道的心跳空闲超时：Host 每 1s 发一次 `ping`（daemon 回 `pong`），
/// 沉默 60s 按 Host 断开处理（容大段丢帧与阻塞）。
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);

impl Default for DaemonOptions {
    fn default() -> Self {
        Self {
            grace_period: Duration::from_secs(30),
            shutdown_timeout: Duration::from_secs(5),
            restart_policy: RestartPolicy::default(),
            idle_exit: true,
            auth_timeout: Duration::from_secs(10),
            heartbeat_timeout: None,
        }
    }
}

/// 控制通道出站队列软水位：越过只记录诊断，不丢帧
pub const OUTBOX_WARN_THRESHOLD: usize = 10_000;

// ==================== 输入事件 ====================

/// daemon 主循环收到的事件。
pub enum DaemonEvent {
    /// 控制通道上的一行（原始 JSON）
    Command(String),
    /// 控制通道断开（Host 退出 / 崩溃）
    HostDisconnected,
    /// 某个 channel 的 Core 输出了一行内层帧
    FrameLine { channel: u64, line: String },
    /// 某个 channel 的 Core 退出
    CoreExited { channel: u64, code: Option<i32> },
}

// ==================== 进程抽象 ====================

/// Core 进程句柄：发送一行内层帧（不阻塞调用方）、强制终止。
pub trait CoreProcessHandle: Send + Sync {
    /// 发送一行内层帧（实现内部排队；不含换行，由实现补）
    fn send_line(&self, line: &str) -> std::io::Result<()>;
    /// 强制终止
    fn kill(&self);
}

/// Core 进程工厂（真实实现起子进程；测试注入假进程）。
pub trait CoreSpawner: Send + Sync {
    fn spawn(
        &self,
        channel: u64,
        sink: Arc<dyn CoreEventSink>,
    ) -> std::io::Result<Box<dyn CoreProcessHandle>>;
}

/// 子进程向 daemon 主循环回传事件（读线程 / 退出线程用）。
pub trait CoreEventSink: Send + Sync {
    fn on_line(&self, channel: u64, line: String);
    fn on_exit(&self, channel: u64, code: Option<i32>);
}

/// 控制通道出站口：生产实现带写线程与软水位诊断，测试实现直接进通道。
pub trait FrameOutput: Send + Sync {
    fn write_line(&self, line: String);
}

/// 通道出站口（测试 / 嵌入用）
#[cfg_attr(not(test), allow(dead_code))]
pub struct ChannelOutput {
    pub tx: Sender<String>,
}

impl FrameOutput for ChannelOutput {
    fn write_line(&self, line: String) {
        let _ = self.tx.send(line);
    }
}

/// 把 `DaemonEvent` 转成事件通道的汇（真实进程的读线程用）。
pub struct ChannelSink {
    pub tx: Sender<DaemonEvent>,
}

impl CoreEventSink for ChannelSink {
    fn on_line(&self, channel: u64, line: String) {
        let _ = self.tx.send(DaemonEvent::FrameLine { channel, line });
    }

    fn on_exit(&self, channel: u64, code: Option<i32>) {
        let _ = self.tx.send(DaemonEvent::CoreExited { channel, code });
    }
}

// ==================== 真实进程实现 ====================

/// 以自身路径加 `stdio` 动作启动 Core 进程（不定位第二个可执行文件）。
pub struct SystemCoreSpawner {
    binary: PathBuf,
}

impl SystemCoreSpawner {
    pub fn new(binary: PathBuf) -> SystemCoreSpawner {
        SystemCoreSpawner { binary }
    }

    /// 用当前可执行文件作为 Core 二进制（daemon 与 Core 是同一个文件的两个模式）
    pub fn current_exe() -> std::io::Result<SystemCoreSpawner> {
        Ok(SystemCoreSpawner::new(std::env::current_exe()?))
    }
}

impl CoreSpawner for SystemCoreSpawner {
    fn spawn(
        &self,
        channel: u64,
        sink: Arc<dyn CoreEventSink>,
    ) -> std::io::Result<Box<dyn CoreProcessHandle>> {
        let mut command = Command::new(&self.binary);
        // 动作是**裸词**（`docs/core-daemon.md` 第 3 节）：`--stdio` 会被当成未知选项报错退出。
        command
            .arg("stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Windows：不弹控制台窗口（与 Core 侧同一条规则）
        crate::util::hide_console(&mut command);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "core stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "core stdout missing"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "core stderr missing"))?;

        // stdout：按行读，交给事件汇（每个 Core 一个线程）
        let reader_sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) => {
                        let trimmed = line.trim_end();
                        if !trimmed.is_empty() {
                            reader_sink.on_line(channel, trimmed.to_string());
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // stderr：诊断输出，前缀标注 channel
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[core:{channel}] {line}");
            }
        });

        // stdin：每进程一个写线程 + 有序队列，慢的 channel 不阻塞主循环
        let (out_tx, out_rx) = mpsc_channel::<String>();
        std::thread::spawn(move || {
            let mut stdin = stdin;
            while let Ok(line) = out_rx.recv() {
                if stdin
                    .write_all(line.as_bytes())
                    .and_then(|()| stdin.write_all(b"\n"))
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        // 退出监视：轮询 try_wait，同时接受强制终止请求
        let (kill_tx, kill_rx) = mpsc_channel::<()>();
        let exit_sink = Arc::clone(&sink);
        std::thread::spawn(move || {
            let mut child: Child = child;
            loop {
                if kill_rx.try_recv().is_ok() {
                    let _ = child.kill();
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        exit_sink.on_exit(channel, status.code());
                        return;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        exit_sink.on_exit(channel, None);
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });

        Ok(Box::new(SystemCoreHandle { out: out_tx, kill: kill_tx }))
    }
}

struct SystemCoreHandle {
    out: Sender<String>,
    kill: Sender<()>,
}

impl CoreProcessHandle for SystemCoreHandle {
    fn send_line(&self, line: &str) -> std::io::Result<()> {
        self.out
            .send(line.to_string())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "core writer closed"))
    }

    fn kill(&self) {
        let _ = self.kill.send(());
    }
}

// ==================== 状态机 ====================

struct ChannelState {
    channel: u64,
    handle: Option<Box<dyn CoreProcessHandle>>,
    /// 重启窗口内排队的 Host → Core 帧（新进程起来后按序冲刷）
    pending: Vec<String>,
    /// 重启时刻表（用于退避与上限判定）
    restart_timestamps: Vec<Instant>,
    /// 下一次重启时刻；`None` 表示没有待执行的重启
    restart_at: Option<Instant>,
    /// Host 请求关闭：已发 `shutdown`，等待进程退出
    closing: bool,
    /// 优雅关闭的强制结束时刻
    kill_deadline: Option<Instant>,
}

impl ChannelState {
    fn new(channel: u64) -> ChannelState {
        ChannelState {
            channel,
            handle: None,
            pending: Vec::new(),
            restart_timestamps: Vec::new(),
            restart_at: None,
            closing: false,
            kill_deadline: None,
        }
    }
}

/// 内层帧的一行（不含换行）
fn inner_line(frame: &Value) -> Option<String> {
    serde_json::to_string(frame).ok()
}

fn send_to_host(out: &dyn FrameOutput, frame: &DaemonToHostFrame) {
    match frame.encode() {
        Ok(line) => out.write_line(line),
        Err(err) => eprintln!("[daemon] failed to encode frame: {err}"),
    }
}

/// 回一帧目录操作失败（列举 / 新建 / 删除共用；`reason` 让 Host 区分「非空」这类可继续的失败）
fn send_directory_failed(
    out: &dyn FrameOutput,
    id: u64,
    error: String,
    reason: DirectoryFailureReason,
) {
    send_to_host(
        out,
        &DaemonToHostFrame::DirectoryFailed { id, error, reason },
    );
}

/// 运行 daemon 主循环；返回进程退出码。
///
/// 事件从 `events` 汇聚（控制通道行、子进程输出与退出、Host 断开）；
/// 出站帧写入 `out`。函数返回即这条控制通道的 daemon 会话结束。
pub fn run_daemon(
    events: Receiver<DaemonEvent>,
    out: Arc<dyn FrameOutput>,
    sink: Arc<dyn CoreEventSink>,
    spawner: Arc<dyn CoreSpawner>,
    options: DaemonOptions,
) -> ChannelExit {
    let mut channels: HashMap<u64, ChannelState> = HashMap::new();
    let mut next_channel: u64 = 1;
    let mut grace_deadline: Option<Instant> = None;
    // 心跳空闲超时的到期时刻：`None` = 尚未武装（没见过 ping 或未启用心跳）
    let mut heartbeat_deadline: Option<Instant> = None;

    loop {
        let now = Instant::now();

        // 1. grace 期到期：退出
        if let Some(deadline) = grace_deadline {
            if now >= deadline {
                eprintln!("[daemon] no live cores after grace period; exiting");
                return ChannelExit::Stop;
            }
        }

        // 2. 到期定时器：强制结束 / 重启
        let mut force_kill: Vec<u64> = Vec::new();
        let mut restart: Vec<u64> = Vec::new();
        for state in channels.values_mut() {
            if let Some(deadline) = state.kill_deadline {
                if now >= deadline {
                    state.kill_deadline = None;
                    force_kill.push(state.channel);
                }
            }
            if let Some(at) = state.restart_at {
                if now >= at {
                    state.restart_at = None;
                    restart.push(state.channel);
                }
            }
        }
        for channel in force_kill {
            if let Some(state) = channels.get(&channel) {
                if let Some(handle) = &state.handle {
                    eprintln!("[daemon] channel {channel}: shutdown timed out; killing core");
                    handle.kill();
                }
            }
        }
        for channel in restart {
            respawn_core(&mut channels, channel, &spawner, &sink, &out, &options);
        }
        // 重启失败可能移除了最后一个 channel：按计数归零启动 grace 计时
        maybe_start_grace(&channels, &mut grace_deadline, &options);

        // 3. 等待下一个事件 / 定时器
        let timeout = next_deadline(&channels, grace_deadline, heartbeat_deadline)
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .map(|remaining| remaining.max(Duration::from_millis(1)));
        let event = match timeout {
            Some(timeout) => events.recv_timeout(timeout),
            None => events.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match event {
            Ok(DaemonEvent::Command(line)) => {
                // 收到任何控制帧都证明 Host 活着：心跳已武装就顺延（超时只在
                // 心跳启用后才有意义，未武装的连接不因沉默被回收）
                if let Some(timeout) = options.heartbeat_timeout {
                    if heartbeat_deadline.is_some() {
                        heartbeat_deadline = Some(Instant::now() + timeout);
                    }
                }
                let frame = match serde_json::from_str::<HostToDaemonFrame>(&line) {
                    Ok(frame) => frame,
                    Err(err) => {
                        eprintln!("[daemon] malformed control frame: {err}; dropped");
                        continue;
                    }
                };
                match frame {
                    HostToDaemonFrame::OpenWorkspace { id, workspace_ref } => {
                        open_workspace(
                            &mut channels,
                            &mut next_channel,
                            &spawner,
                            &sink,
                            &out,
                            id,
                            &workspace_ref,
                        );
                        grace_deadline = None;
                    }
                    HostToDaemonFrame::CloseWorkspace { channel } => {
                        begin_close(&mut channels, channel, &options);
                        maybe_start_grace(&channels, &mut grace_deadline, &options);
                    }
                    HostToDaemonFrame::Frame { channel, frame } => {
                        forward_to_core(&mut channels, channel, &frame);
                    }
                    HostToDaemonFrame::ListDirectories { id, path } => {
                        match crate::remote::list_directories(path.as_deref()) {
                            Ok(listing) => send_to_host(
                                out.as_ref(),
                                &DaemonToHostFrame::DirectoriesListed {
                                    id,
                                    path: listing.path,
                                    parent: listing.parent,
                                    entries: listing.entries,
                                },
                            ),
                            Err(error) => send_directory_failed(out.as_ref(), id, error, DirectoryFailureReason::Other),
                        }
                    }
                    HostToDaemonFrame::CreateDirectory { id, path } => {
                        match crate::remote::create_directory(&path) {
                            Ok(created) => send_to_host(
                                out.as_ref(),
                                &DaemonToHostFrame::DirectoryCreated { id, path: created },
                            ),
                            Err(error) => send_directory_failed(out.as_ref(), id, error, DirectoryFailureReason::Other),
                        }
                    }
                    HostToDaemonFrame::RenameDirectory { id, path, name } => {
                        match crate::remote::rename_directory(&path, &name) {
                            Ok(renamed) => send_to_host(
                                out.as_ref(),
                                &DaemonToHostFrame::DirectoryRenamed { id, path: renamed },
                            ),
                            Err(error) => send_directory_failed(out.as_ref(), id, error, DirectoryFailureReason::Other),
                        }
                    }
                    HostToDaemonFrame::DeleteDirectory { id, path, recursive } => {
                        match crate::remote::delete_directory(&path, recursive) {
                            Ok(removed) => send_to_host(
                                out.as_ref(),
                                &DaemonToHostFrame::DirectoryDeleted { id, path: removed },
                            ),
                            // 非空是「还能继续」的失败：Host 据此提示递归删除
                            Err(crate::remote::DeleteDirectoryError::NotEmpty(error)) => {
                                send_directory_failed(out.as_ref(), id, error, DirectoryFailureReason::NotEmpty)
                            }
                            Err(crate::remote::DeleteDirectoryError::Failed(error)) => {
                                send_directory_failed(out.as_ref(), id, error, DirectoryFailureReason::Other)
                            }
                        }
                    }
                    HostToDaemonFrame::Shutdown => {
                        close_all(&channels, &out);
                        return ChannelExit::Stop;
                    }
                    HostToDaemonFrame::Ping => {
                        // 心跳：回 pong（Host 据此武装沉默判定，`docs/core-daemon.md`
                        // 第 12.5 节），并把空闲超时武装 / 顺延（旧版 Host 不发 ping，
                        // 永不武装）
                        send_to_host(out.as_ref(), &DaemonToHostFrame::Pong);
                        if let Some(timeout) = options.heartbeat_timeout {
                            heartbeat_deadline = Some(Instant::now() + timeout);
                        }
                    }
                    // 本地 stdio 通道没有鉴权阶段：收到 auth 只记诊断，不改变状态。
                    HostToDaemonFrame::Auth { .. } => {
                        eprintln!("[daemon] unexpected auth frame on a non-remote channel; ignored");
                    }
                }
            }
            Ok(DaemonEvent::HostDisconnected) => {
                eprintln!("[daemon] control channel disconnected; closing all cores");
                close_all(&channels, &out);
                return ChannelExit::Continue;
            }
            Ok(DaemonEvent::FrameLine { channel, line }) => {
                match serde_json::from_str::<Value>(&line) {
                    Ok(frame) => send_to_host(
                        out.as_ref(),
                        &DaemonToHostFrame::Frame { channel, frame },
                    ),
                    Err(err) => {
                        eprintln!("[daemon] channel {channel}: malformed inner frame: {err}; dropped")
                    }
                }
            }
            Ok(DaemonEvent::CoreExited { channel, code }) => {
                handle_core_exit(&mut channels, channel, code, &spawner, &sink, &out, &options);
                maybe_start_grace(&channels, &mut grace_deadline, &options);
            }
            Err(RecvTimeoutError::Timeout) => {
                // 心跳到期：Host 消失而 TCP 未断（断网 / 休眠 / 进程冻结）时读线程
                // 永远等不到 EOF，只能按沉默判定断开——同 `HostDisconnected` 口径
                if let Some(deadline) = heartbeat_deadline {
                    if Instant::now() >= deadline {
                        eprintln!("[daemon] control channel heartbeat timed out; closing all cores");
                        close_all(&channels, &out);
                        return ChannelExit::Continue;
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                // 事件源关闭（进程内部错误）：按 Host 断开处理
                close_all(&channels, &out);
                return ChannelExit::Continue;
            }
        }
    }
}

/// 最近一个定时器时刻（grace / 重启 / 强制结束 / 心跳空闲）
fn next_deadline(
    channels: &HashMap<u64, ChannelState>,
    grace: Option<Instant>,
    heartbeat: Option<Instant>,
) -> Option<Instant> {
    let mut next = grace;
    if let Some(deadline) = heartbeat {
        next = Some(match next {
            Some(current) => current.min(deadline),
            None => deadline,
        });
    }
    for state in channels.values() {
        for deadline in [state.restart_at, state.kill_deadline].into_iter().flatten() {
            next = Some(match next {
                Some(current) => current.min(deadline),
                None => deadline,
            });
        }
    }
    next
}

fn maybe_start_grace(
    channels: &HashMap<u64, ChannelState>,
    grace_deadline: &mut Option<Instant>,
    options: &DaemonOptions,
) {
    // 远程 daemon：连接在就继续服务，不因没有工作区而退出
    if !options.idle_exit {
        return;
    }
    if channels.is_empty() && grace_deadline.is_none() {
        eprintln!(
            "[daemon] no live cores; exiting in {}s unless a workspace opens",
            options.grace_period.as_secs()
        );
        *grace_deadline = Some(Instant::now() + options.grace_period);
    }
}

fn open_workspace(
    channels: &mut HashMap<u64, ChannelState>,
    next_channel: &mut u64,
    spawner: &Arc<dyn CoreSpawner>,
    sink: &Arc<dyn CoreEventSink>,
    out: &Arc<dyn FrameOutput>,
    id: u64,
    workspace_ref: &Value,
) {
    let channel = *next_channel;
    *next_channel += 1;
    match spawner.spawn(channel, Arc::clone(sink)) {
        Ok(handle) => {
            let mut state = ChannelState::new(channel);
            state.handle = Some(handle);
            channels.insert(channel, state);
            let workspace = workspace_ref
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            eprintln!("[daemon] channel {channel} opened (workspace={workspace})");
            send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::WorkspaceOpened {
                    id,
                    channel,
                    descriptor: ChannelDescriptor::Multiplexed { channel },
                },
            );
        }
        Err(err) => {
            eprintln!("[daemon] failed to start core for workspace request {id}: {err}");
            send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::WorkspaceFailed {
                    id,
                    error: err.to_string(),
                },
            );
        }
    }
}

fn begin_close(
    channels: &mut HashMap<u64, ChannelState>,
    channel: u64,
    options: &DaemonOptions,
) {
    let Some(state) = channels.get_mut(&channel) else {
        eprintln!("[daemon] closeWorkspace for unknown channel {channel}");
        return;
    };
    if state.closing {
        return;
    }
    state.closing = true;
    if let Some(handle) = &state.handle {
        let _ = handle.send_line("{\"kind\":\"shutdown\"}");
    }
    state.kill_deadline = Some(Instant::now() + options.shutdown_timeout);
}

/// Host → Core：把内层帧转发给该 channel 的进程；重启窗口内先排队
fn forward_to_core(channels: &mut HashMap<u64, ChannelState>, channel: u64, frame: &Value) {
    let Some(state) = channels.get_mut(&channel) else {
        eprintln!("[daemon] frame for unknown channel {channel}; dropped");
        return;
    };
    if state.closing {
        eprintln!("[daemon] channel {channel} is closing; frame dropped");
        return;
    }
    let Some(line) = inner_line(frame) else {
        eprintln!("[daemon] channel {channel}: failed to encode inner frame; dropped");
        return;
    };
    match &state.handle {
        Some(handle) => {
            if let Err(err) = handle.send_line(&line) {
                eprintln!("[daemon] channel {channel}: core stdin write failed: {err}");
            }
        }
        None => {
            if state.pending.len() > OUTBOX_WARN_THRESHOLD {
                eprintln!(
                    "[daemon] channel {channel}: {} frames queued while core is restarting",
                    state.pending.len()
                );
            }
            state.pending.push(line);
        }
    }
}

fn handle_core_exit(
    channels: &mut HashMap<u64, ChannelState>,
    channel: u64,
    code: Option<i32>,
    spawner: &Arc<dyn CoreSpawner>,
    sink: &Arc<dyn CoreEventSink>,
    out: &Arc<dyn FrameOutput>,
    options: &DaemonOptions,
) {
    let Some(mut state) = channels.remove(&channel) else {
        eprintln!("[daemon] exit event for unknown channel {channel}");
        return;
    };
    state.handle = None;

    if state.closing {
        eprintln!("[daemon] channel {channel} closed (core exited)");
        send_to_host(
            out.as_ref(),
            &DaemonToHostFrame::WorkspaceClosed {
                channel,
                reason: WorkspaceCloseReason::Closed,
            },
        );
        return;
    }

    eprintln!("[daemon] channel {channel} core exited unexpectedly (code={code:?})");
    if schedule_restart(&mut state, out, options) {
        channels.insert(channel, state);
    }
    let _ = (spawner, sink); // 重启由主循环的定时器执行
}

/// 退避调度：窗口内次数未超上限则登记下一次重启；超限则关闭 channel 并报告。
///
/// 返回 true 表示已登记重启（channel 保留），false 表示放弃（channel 已关闭）。
fn schedule_restart(
    state: &mut ChannelState,
    out: &Arc<dyn FrameOutput>,
    options: &DaemonOptions,
) -> bool {
    let policy = &options.restart_policy;
    let now = Instant::now();
    state
        .restart_timestamps
        .retain(|timestamp| now.duration_since(*timestamp) < policy.window);
    if state.restart_timestamps.len() >= policy.max_attempts {
        eprintln!(
            "[daemon] channel {}: {} restarts within {}s; giving up",
            state.channel,
            state.restart_timestamps.len(),
            policy.window.as_secs()
        );
        send_to_host(
            out.as_ref(),
            &DaemonToHostFrame::ChannelReset {
                channel: state.channel,
                reason: format!(
                    "core exited {} times within {}ms; restart limit exceeded",
                    state.restart_timestamps.len(),
                    policy.window.as_millis()
                ),
            },
        );
        send_to_host(
            out.as_ref(),
            &DaemonToHostFrame::WorkspaceClosed {
                channel: state.channel,
                reason: WorkspaceCloseReason::Failed,
            },
        );
        state.pending.clear();
        return false;
    }
    state.restart_timestamps.push(now);
    let attempt = state.restart_timestamps.len();
    let delay = policy
        .base_delay
        .saturating_mul(2u32.saturating_pow(attempt.saturating_sub(1) as u32))
        .min(policy.max_delay);
    send_to_host(
        out.as_ref(),
        &DaemonToHostFrame::ChannelReset {
            channel: state.channel,
            reason: format!("core exited; restarting in {}ms", delay.as_millis()),
        },
    );
    state.restart_at = Some(now + delay);
    true
}

/// 重启定时器到点：起新进程并冲刷排队帧；失败按一次重启继续退避。
fn respawn_core(
    channels: &mut HashMap<u64, ChannelState>,
    channel: u64,
    spawner: &Arc<dyn CoreSpawner>,
    sink: &Arc<dyn CoreEventSink>,
    out: &Arc<dyn FrameOutput>,
    options: &DaemonOptions,
) {
    let Some(state) = channels.get_mut(&channel) else {
        return;
    };
    match spawner.spawn(channel, Arc::clone(sink)) {
        Ok(handle) => {
            state.handle = Some(handle);
            eprintln!("[daemon] channel {channel} restarted on the same channel");
            // 重启期间排队的帧（含 Host 的重新握手 hello）按序冲刷
            let pending = std::mem::take(&mut state.pending);
            if let Some(handle) = &state.handle {
                for line in pending {
                    if let Err(err) = handle.send_line(&line) {
                        eprintln!("[daemon] channel {channel}: flush failed: {err}");
                        break;
                    }
                }
            }
        }
        Err(err) => {
            eprintln!("[daemon] channel {channel}: failed to restart core: {err}");
            if !schedule_restart(state, out, options) {
                // 放弃重启：channel 已关闭，从表中移除（计数随之递减）
                channels.remove(&channel);
            }
        }
    }
}

/// 关闭全部 channel（Host 断开 / 收到 `shutdown`）。
fn close_all(channels: &HashMap<u64, ChannelState>, out: &Arc<dyn FrameOutput>) {
    for state in channels.values() {
        if let Some(handle) = &state.handle {
            let _ = handle.send_line("{\"kind\":\"shutdown\"}");
            handle.kill();
        }
        if !state.closing {
            send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::WorkspaceClosed {
                    channel: state.channel,
                    reason: WorkspaceCloseReason::Closed,
                },
            );
        }
    }
}

// ==================== 真实模式入口 ====================

/// 在一条控制通道上跑 daemon 主循环：读线程把行送入事件通道，返回 daemon 退出码。
///
/// 生产入口是远程 TCP（`remote::serve_connection`，`start-daemon`）；测试注入
/// 内存 reader / `ChannelOutput`。reader 由 `make_reader` 在读线程里创建。
pub fn run_control_channel<R, F>(
    make_reader: F,
    out: Arc<dyn FrameOutput>,
    options: DaemonOptions,
) -> ChannelExit
where
    R: BufRead,
    F: FnOnce() -> R + Send + 'static,
{
    let (tx, rx) = mpsc_channel::<DaemonEvent>();
    let sink: Arc<dyn CoreEventSink> = Arc::new(ChannelSink { tx: tx.clone() });

    // 控制通道读线程：按行解析成 Command；EOF 视为 Host 断开
    std::thread::spawn(move || {
        let reader = make_reader();
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(DaemonEvent::Command(line)).is_err() {
                        return;
                    }
                }
                Err(err) => {
                    eprintln!("[daemon] control channel read error: {err}");
                    break;
                }
            }
        }
        let _ = tx.send(DaemonEvent::HostDisconnected);
    });

    let spawner: Arc<dyn CoreSpawner> = match SystemCoreSpawner::current_exe() {
        Ok(spawner) => Arc::new(spawner),
        Err(err) => {
            eprintln!("[daemon] cannot resolve own executable: {err}");
            return ChannelExit::Stop;
        }
    };
    run_daemon(rx, out, sink, spawner, options)
}

#[cfg(test)]
#[path = "daemon_tests.rs"]
mod tests;

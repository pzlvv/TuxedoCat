//! daemon 进程模型（见 `docs/core/core-daemon.md`）。
//!
//! 职责：
//! - 一个 endpoint 一个 daemon；每（连接, 工作区）一个 Core 进程（daemon 持有其 stdio）；
//! - 控制通道上的多路复用：每个 Core 的帧通道是它上面的一条逻辑 channel；
//! - Core 的启动、重启（退避 + 上限）、终止都由 daemon 承担；
//! - 控制连接断开时，非 idle 的 Core 孤儿化存活、全 idle 的 Core 照旧终止
//!   （specs/031；本地 stdio 无孤儿表，维持「断开即关闭」）；
//! - `idle_exit` 为真时，活着的 Core 计数归零后还经 grace 期退出（远程监听不设，
//!   见 `remote::remote_daemon_options`）。
//!
//! 线程模型：
//! - 主循环只做状态机与转发，输入事件经 `DaemonEvent` 通道汇聚；
//! - 每个 Core 进程各有一个 stdout 读线程、stderr 诊断线程、stdin 写线程与退出监视
//!   线程：单条 channel 的阻塞不会拖住其它 channel（`docs/core/core-daemon.md` 第 7.4 节背压）；
//!   读线程的输出经 [`RoutableSink`] 路由——channel 活着送本连接事件通道，孤儿化后
//!   送孤儿表（持续排水，Core 不因管道写满而阻塞）；
//! - 控制通道出站经 `FrameOutput`：远程实现是加锁串行的 socket 写，越过软水位只
//!   记录诊断，不丢帧；
//! - 一次 `run_daemon` 调用是一条控制连接的全部状态（channel 表、计数、grace、心跳），
//!   连接之间互不共享（`docs/core/core-remote.md` 第 2.5 节）；跨连接共享的只有
//!   [`OrphanRegistry`]（specs/031 的孤儿表）。
//!
//! 进程工厂（`CoreSpawner`）与事件汇（`CoreEventSink`）都做了抽象：
//! 单元测试注入假进程，不需要真实可执行文件。

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel as mpsc_channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::daemon_protocol::{
    ChannelDescriptor, DaemonToHostFrame, DirectoryFailureReason, HostToDaemonFrame,
    WorkspaceCloseReason,
};
use crate::util::diag;

/// 一条控制通道上的 daemon 会话结束原因。
///
/// 远程 daemon 是常驻 server，同时服务多条控制连接：`Continue` 表示这条连接的会话
/// 结束、服务线程退出，daemon 继续服务其它连接；只有 `Stop` 才由该连接的服务线程
/// 触发整个 daemon 的停机（`remote::DaemonRuntime::begin_stop`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelExit {
    /// 结束整个 daemon：对端发 `shutdown`（`kill` 发的，全局生效）、空闲到 grace 期，
    /// 或内部错误
    Stop,
    /// 只是这条控制连接断了：服务线程退出，daemon 继续
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
    /// 心跳空闲超时（远程控制通道；`docs/core/core-remote.md` 第 2.5 节）。
    ///
    /// 控制通道建立即武装：这么长时间没收到任何控制帧，按 Host 断开处理
    /// （close_all + 本条会话结束）。Host 消失而 TCP 未断（断网 / 休眠 / 进程冻结）
    /// 时这是唯一的回收手段，也顺带回收连上后一直不发帧的连接。`None` = 不启用
    /// （本地 stdio 没有 ping）。
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
            heartbeat_timeout: None,
        }
    }
}

/// 控制通道出站队列软水位：越过只记录诊断，不丢帧
pub const OUTBOX_WARN_THRESHOLD: usize = 10_000;

// ==================== 孤儿表（specs/031）====================

/// 孤儿重放缓冲的上限（帧数）：超过丢最旧并落诊断。无论缓冲内容如何，
/// 最新快照恒在 `OrphanEntry::runtime_line` 单独保留，认领时补放。
const REPLAY_BUFFER_LIMIT: usize = 200;

/// 挂起请求的重放时效，对齐 Core 侧等待应答上限（`engine.rs` 的 3_600s）：
/// 超时的请求 Core 已不再等待，认领时不再重放（spec「边界与错误路径」）。
const PENDING_REQUEST_TTL: Duration = Duration::from_secs(3_600);

/// 全 idle 孤儿 Core 的收尾宽限：转全 idle 满该时长才终止并移出孤儿表
/// （沿 US-33 口径——短暂 idle 可能是「空闲挂起项紧随提交」）。
pub const ORPHAN_IDLE_TTL: Duration = Duration::from_secs(30);

/// 重放缓冲里的一帧：快照或挂起请求，按到达序保存。
struct BufferedFrame {
    line: String,
    /// 入队时刻：请求帧按它对齐 [`PENDING_REQUEST_TTL`]
    at: Instant,
    is_request: bool,
}

/// 孤儿表的一条登记：被 detach / 孤儿化的 Core 进程连同它的帧出口缓存。
///
/// 所有问题（帧喂入、忙闲更新、退出标记）都发生在自己的锁内；表的增删查在
/// [`OrphanRegistry`] 的锁内。锁序恒为 registry → sink.route → entry，
/// 读者线程（route → entry）与认领 / 清扫（registry → route → entry）不构成环。
pub struct OrphanEntry {
    #[allow(dead_code)]
    workspace_path: String,
    /// 存活的 Core 进程句柄；清扫收尾时 take 掉
    handle: Option<Box<dyn CoreProcessHandle>>,
    /// 最近一份 `sessionRuntimeChanged` 快照的 event 载荷（忙闲判据）
    runtime: Option<Value>,
    /// 同上的帧原文（认领时若缓冲里没有更新的快照则补放这帧）
    runtime_line: Option<String>,
    /// 重放缓冲：快照与请求帧按到达序
    replay: VecDeque<BufferedFrame>,
    /// 快照判定的忙闲（`None` 快照按 idle：Core 尚无在跑工作）
    busy: bool,
    /// 转全 idle 的时刻；任何快照转忙即清空
    idle_since: Option<Instant>,
    /// Core 已退出（崩溃 / 自行结束）：不重启，等清扫移出
    exited: bool,
}

/// 孤儿表的键：工作区路径 + 原连接标识。同一 endpoint 上两个客户端各自的孤儿
/// 互不覆盖——纯 path 键会让第二次孤儿化覆盖第一条，被覆盖的 Core 泄漏成无主
/// 进程，它持有的会话锁（specs/032）也不释放。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct OrphanKey {
    path: String,
    connection: u64,
}

struct OrphanSlot {
    /// 登记序：同 path 多条时认领取最早一条
    seq: u64,
    entry: Arc<Mutex<OrphanEntry>>,
    sink: Arc<RoutableSink>,
}

/// 一次孤儿清扫的结论（`wait_for_stop_or_idle` 消费）。
pub struct OrphanSweep {
    /// 转全 idle 满宽限的 Core：调用方负责终止
    pub to_close: Vec<Box<dyn CoreProcessHandle>>,
    /// 是否还有非 idle 的孤儿（空闲退出判定用）
    pub has_busy: bool,
    /// 仍然存活的孤儿数
    pub alive: usize,
    /// 最早的「全 idle 满宽限」时刻（等待时长的上界）
    pub next_idle_close: Option<Instant>,
}

/// 跨连接共享的孤儿表（specs/031）。
///
/// daemon 进程内唯一；连接之间经它移交 Core。登记冲突（同键已存在）拒绝插入——
/// 调用方（detach / 断开收尾）按现行关闭路径兜底，不静默覆盖。
pub struct OrphanRegistry {
    inner: Mutex<OrphanTable>,
}

#[derive(Default)]
struct OrphanTable {
    next_seq: u64,
    entries: HashMap<OrphanKey, OrphanSlot>,
}

impl OrphanRegistry {
    pub fn new() -> OrphanRegistry {
        OrphanRegistry {
            inner: Mutex::new(OrphanTable::default()),
        }
    }

    /// 把一个 Core 登记为孤儿，并把它的帧出口切到孤儿收集器。
    ///
    /// 同键已有登记时拒绝插入（spec FR-005：落诊断、不静默覆盖），句柄原样还给
    /// 调用方按现行关闭路径收尾；此时帧出口未被切换。
    #[allow(clippy::too_many_arguments)]
    fn insert(
        &self,
        connection: u64,
        workspace_path: &str,
        handle: Box<dyn CoreProcessHandle>,
        runtime: Option<Value>,
        runtime_line: Option<String>,
        sink: &Arc<RoutableSink>,
    ) -> Result<(), Box<dyn CoreProcessHandle>> {
        let mut table = self.inner.lock().unwrap();
        let key = OrphanKey {
            path: workspace_path.to_string(),
            connection,
        };
        if table.entries.contains_key(&key) {
            return Err(handle);
        }
        let busy = runtime.as_ref().map(snapshot_has_busy).unwrap_or(false);
        let entry = Arc::new(Mutex::new(OrphanEntry {
            workspace_path: workspace_path.to_string(),
            handle: Some(handle),
            runtime: runtime.clone(),
            runtime_line,
            replay: VecDeque::new(),
            busy,
            idle_since: None,
            exited: false,
        }));
        *sink.route.lock().unwrap() = SinkRoute::Orphan(Arc::clone(&entry));
        table.next_seq += 1;
        let seq = table.next_seq;
        table.entries.insert(
            key,
            OrphanSlot {
                seq,
                entry,
                sink: Arc::clone(sink),
            },
        );
        Ok(())
    }

    /// 摘出该工作区最早登记的孤儿（认领的原子半步）：摘表与句柄移交对并发认领
    /// 至多一胜，败者拿到 `None` 按无孤儿处理（spec FR-006）。
    fn take_earliest(&self, path: &str) -> Option<(OrphanSlot, Arc<Mutex<OrphanEntry>>)> {
        let mut table = self.inner.lock().unwrap();
        let key = table
            .entries
            .iter()
            .filter(|(key, _)| key.path == path)
            .min_by_key(|(_, slot)| slot.seq)
            .map(|(key, _)| key.clone())?;
        let slot = table.entries.remove(&key)?;
        let entry = Arc::clone(&slot.entry);
        Some((slot, entry))
    }

    /// 清扫：移出已退出的孤儿；终止转全 idle 满宽限的孤儿；统计忙闲。
    /// 连接多少与此无关——孤儿不属于任何连接。
    pub(crate) fn sweep(&self, idle_ttl: Duration) -> OrphanSweep {
        let mut table = self.inner.lock().unwrap();
        let mut sweep = OrphanSweep {
            to_close: Vec::new(),
            has_busy: false,
            alive: 0,
            next_idle_close: None,
        };
        let mut dead: Vec<OrphanKey> = Vec::new();
        for (key, slot) in table.entries.iter() {
            let mut entry = slot.entry.lock().unwrap();
            if entry.exited {
                dead.push(key.clone());
                continue;
            }
            if entry.busy {
                entry.idle_since = None;
                sweep.has_busy = true;
                sweep.alive += 1;
                continue;
            }
            let since = *entry.idle_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= idle_ttl {
                if let Some(handle) = entry.handle.take() {
                    sweep.to_close.push(handle);
                }
                dead.push(key.clone());
            } else {
                sweep.alive += 1;
                let deadline = since + idle_ttl;
                sweep.next_idle_close = Some(match sweep.next_idle_close {
                    Some(current) => current.min(deadline),
                    None => deadline,
                });
            }
        }
        for key in dead {
            table.entries.remove(&key);
        }
        sweep
    }

    /// daemon 停机（`kill` / 空闲退出）时收尾全部孤儿：全局停机是孤儿语义的边界，
    /// 孤儿不越过 daemon 的生命周期。
    pub fn shutdown_all(&self) {
        let mut table = self.inner.lock().unwrap();
        for slot in table.entries.values() {
            let mut entry = slot.entry.lock().unwrap();
            if let Some(handle) = entry.handle.take() {
                let _ = handle.send_line("{\"kind\":\"shutdown\"}");
                handle.kill();
            }
        }
        table.entries.clear();
    }
}

// ==================== 帧出口路由（specs/031）====================

/// [`RoutableSink`] 的当前去向。
enum SinkRoute {
    /// 送本连接的事件通道（channel 是当前连接分配的号；认领会改写它）
    Connection { events: Sender<DaemonEvent>, channel: u64 },
    /// 送孤儿表的一条登记（持续排水 + 窥探缓存）
    Orphan(Arc<Mutex<OrphanEntry>>),
}

/// 每个 Core 进程一个的事件汇：读线程的输出按当前路由送连接或孤儿表。
///
/// 进程的一生只有一个 sink——孤儿化 / 认领只改路由，不改读线程的接线
/// （认领时 `Connection.channel` 换成新连接分配的号）。
pub struct RoutableSink {
    route: Mutex<SinkRoute>,
}

impl CoreEventSink for RoutableSink {
    fn on_line(&self, _channel: u64, line: String) {
        let guard = self.route.lock().unwrap();
        match &*guard {
            SinkRoute::Connection { events, channel } => {
                let _ = events.send(DaemonEvent::FrameLine {
                    channel: *channel,
                    line,
                });
            }
            SinkRoute::Orphan(entry) => feed_orphan_line(entry, line),
        }
    }

    fn on_exit(&self, _channel: u64, _code: Option<i32>) {
        let guard = self.route.lock().unwrap();
        match &*guard {
            SinkRoute::Connection { events, channel } => {
                let _ = events.send(DaemonEvent::CoreExited {
                    channel: *channel,
                    code: _code,
                });
            }
            SinkRoute::Orphan(entry) => {
                let mut entry = entry.lock().unwrap();
                entry.exited = true;
            }
        }
    }
}

impl RoutableSink {
    fn to_connection(events: Sender<DaemonEvent>, channel: u64) -> RoutableSink {
        RoutableSink {
            route: Mutex::new(SinkRoute::Connection { events, channel }),
        }
    }
}

/// 孤儿帧喂入：窥探点（快照更新忙闲并进重放缓冲、请求帧暂存），其余帧只丢弃。
fn feed_orphan_line(entry: &Mutex<OrphanEntry>, line: String) {
    let mut entry = entry.lock().unwrap();
    match peek_frame(&line) {
        Some(PeekedFrame::RuntimeSnapshot(event)) => {
            entry.runtime = Some(event);
            entry.runtime_line = Some(line.clone());
            entry.busy = entry
                .runtime
                .as_ref()
                .map(snapshot_has_busy)
                .unwrap_or(false);
            if entry.busy {
                entry.idle_since = None;
            }
            push_replay(&mut entry.replay, BufferedFrame {
                line,
                at: Instant::now(),
                is_request: false,
            });
        }
        Some(PeekedFrame::PendingRequest) => {
            push_replay(&mut entry.replay, BufferedFrame {
                line,
                at: Instant::now(),
                is_request: true,
            });
        }
        None => {}
    }
}

/// 重放缓冲入队：超上限丢最旧（请求帧一起丢——它对应的应答等待反正也有时效）。
fn push_replay(replay: &mut VecDeque<BufferedFrame>, frame: BufferedFrame) {
    if replay.len() >= REPLAY_BUFFER_LIMIT {
        replay.pop_front();
        diag!(
            "[daemon] orphan replay buffer overflow; dropped the oldest frame (limit={})",
            REPLAY_BUFFER_LIMIT
        );
    }
    replay.push_back(frame);
}

/// 认领时清空重放缓冲：按到达序取帧，超过应答时效的请求帧不再重放
/// （Core 已无此待决 id，见 spec「边界与错误路径」）。
fn drain_replay(entry: &mut OrphanEntry) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let now = Instant::now();
    for frame in entry.replay.drain(..) {
        if frame.is_request && now.duration_since(frame.at) >= PENDING_REQUEST_TTL {
            diag!("[daemon] dropping a pending request older than the reply timeout");
            continue;
        }
        lines.push(frame.line);
    }
    lines
}

/// 内层帧的只读窥探结果（daemon 对内层帧仅有的两类解读，见 `docs/adr/0006`）。
enum PeekedFrame {
    /// `sessionRuntimeChanged` 全量快照（event 载荷）
    RuntimeSnapshot(Value),
    /// 用户请求帧（权限确认 / AskUserQuestion 等）
    PendingRequest,
}

fn peek_frame(line: &str) -> Option<PeekedFrame> {
    let frame = serde_json::from_str::<Value>(line).ok()?;
    match frame.get("kind").and_then(Value::as_str) {
        Some("event") => {
            let event = frame.get("event")?;
            if event.get("type").and_then(Value::as_str) == Some("sessionRuntimeChanged") {
                Some(PeekedFrame::RuntimeSnapshot(event.clone()))
            } else {
                None
            }
        }
        Some("request") => Some(PeekedFrame::PendingRequest),
        _ => None,
    }
}

/// 快照里是否存在非 idle 会话。快照形状解不出（契约漂移）按忙 fail-safe 落诊断：
/// 方向是保活（daemon 多陪一会儿，用户可用 `kill` 收场），不静默杀任务。
fn snapshot_has_busy(event: &Value) -> bool {
    match event.get("states").and_then(Value::as_array) {
        Some(states) => states.iter().any(|state| {
            state
                .get("waiting")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || !state.get("idle").and_then(Value::as_bool).unwrap_or(true)
        }),
        None => {
            diag!("[daemon] sessionRuntimeChanged snapshot without states; assuming busy");
            true
        }
    }
}

/// 一次连接的跨连接上下文：孤儿表与本连接的标识（孤儿键的一半）。
/// `None` = 不启用孤儿化（本地 stdio、未升级的测试入口）：断开即关闭全部 Core。
pub struct ConnectionContext {
    pub orphans: Arc<OrphanRegistry>,
    pub connection: u64,
}

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
        // 动作是**裸词**（`docs/core/core-daemon.md` 第 3 节）：`--stdio` 会被当成未知选项报错退出。
        command
            .arg("stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Windows：不弹控制台窗口（与 Core 侧同一条规则）
        crate::util::hide_console(&mut command);
        let mut child = command.spawn()?;
        // 子进程事实先落日志再接线：Core 异常退出（段错误 / 被杀）时日志里得有
        // pid 与启动时刻这一行锚点，才能对上系统侧的进程事件
        diag!("[daemon] channel {channel}: core process started (pid={})", child.id());
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
                diag!("[core:{channel}] {line}");
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
                        // Unix 上 code=None 意味着被信号杀死（段错误是 SIGSEGV=11），
                        // 单独记一行，把「崩溃」与「带退出码退出」区分开
                        #[cfg(unix)]
                        if let Some(signal) =
                            std::os::unix::process::ExitStatusExt::signal(&status)
                        {
                            diag!("[daemon] channel {channel}: core terminated by signal {signal}");
                        }
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
    /// 该 Core 的一生只有一个帧出口（specs/031）：孤儿化 / 认领改路由不换对象
    sink: Arc<RoutableSink>,
    /// `openWorkspace` 携带的工作区路径（孤儿键的一半）
    workspace_path: String,
    /// 最近一份 `sessionRuntimeChanged` 快照（断开时判定孤儿化还是终止；
    /// Core 进程重启即清空——新进程尚无在跑工作）
    last_runtime: Option<Value>,
    /// 同上的帧原文（孤儿登记与认领补放用）
    last_runtime_line: Option<String>,
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
    fn new(channel: u64, sink: Arc<RoutableSink>, workspace_path: String) -> ChannelState {
        ChannelState {
            channel,
            handle: None,
            sink,
            workspace_path,
            last_runtime: None,
            last_runtime_line: None,
            pending: Vec::new(),
            restart_timestamps: Vec::new(),
            restart_at: None,
            closing: false,
            kill_deadline: None,
        }
    }

    /// 最近快照判定是否有非 idle 会话；无快照按 idle（新进程尚无在跑工作）。
    fn has_busy_session(&self) -> bool {
        self.last_runtime
            .as_ref()
            .map(snapshot_has_busy)
            .unwrap_or(false)
    }
}

/// 内层帧的一行（不含换行）
fn inner_line(frame: &Value) -> Option<String> {
    serde_json::to_string(frame).ok()
}

fn send_to_host(out: &dyn FrameOutput, frame: &DaemonToHostFrame) {
    match frame.encode() {
        Ok(line) => out.write_line(line),
        Err(err) => diag!("[daemon] failed to encode frame: {err}"),
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
/// 出站帧写入 `out`。`events_tx` 是同一事件通道的发送端——每个 Core 进程的
/// 帧出口（[`RoutableSink`]）在连接态往这里送帧。`context` 携带跨连接的孤儿表
/// （specs/031）；`None` 表示不启用孤儿化，断开即关闭全部 Core（本地 stdio 语义）。
/// 函数返回即这条控制通道的 daemon 会话结束。
pub fn run_daemon(
    events_tx: Sender<DaemonEvent>,
    events: Receiver<DaemonEvent>,
    out: Arc<dyn FrameOutput>,
    spawner: Arc<dyn CoreSpawner>,
    options: DaemonOptions,
    context: Option<ConnectionContext>,
) -> ChannelExit {
    let mut channels: HashMap<u64, ChannelState> = HashMap::new();
    let mut next_channel: u64 = 1;
    let mut grace_deadline: Option<Instant> = None;
    // 心跳空闲超时的到期时刻：启用心跳（远程控制通道）时从连接建立即武装，
    // 收到任何控制帧都顺延；`None` = 不启用（本地 stdio）
    let mut heartbeat_deadline: Option<Instant> =
        options.heartbeat_timeout.map(|timeout| Instant::now() + timeout);

    loop {
        let now = Instant::now();

        // 1. grace 期到期：退出
        if let Some(deadline) = grace_deadline {
            if now >= deadline {
                diag!("[daemon] no live cores after grace period; exiting");
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
                    diag!("[daemon] channel {channel}: shutdown timed out; killing core");
                    handle.kill();
                }
            }
        }
        for channel in restart {
            respawn_core(&mut channels, channel, &spawner, &events_tx, &out, &options);
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
                // 收到任何控制帧都证明 Host 活着：顺延心跳死线
                if let Some(timeout) = options.heartbeat_timeout {
                    heartbeat_deadline = Some(Instant::now() + timeout);
                }
                let frame = match serde_json::from_str::<HostToDaemonFrame>(&line) {
                    Ok(frame) => frame,
                    Err(err) => {
                        diag!("[daemon] malformed control frame: {err}; dropped");
                        continue;
                    }
                };
                match frame {
                    HostToDaemonFrame::OpenWorkspace { id, workspace_ref } => {
                        open_workspace(
                            &mut channels,
                            &mut next_channel,
                            &events_tx,
                            &spawner,
                            &out,
                            id,
                            &workspace_ref,
                            context.as_ref(),
                        );
                        grace_deadline = None;
                    }
                    HostToDaemonFrame::CloseWorkspace { channel } => {
                        begin_close(&mut channels, channel, &options);
                        maybe_start_grace(&channels, &mut grace_deadline, &options);
                    }
                    HostToDaemonFrame::DetachWorkspace { channel } => match &context {
                        Some(ctx) => {
                            detach_channel(&mut channels, ctx, channel, &out);
                            maybe_start_grace(&channels, &mut grace_deadline, &options);
                        }
                        None => {
                            diag!(
                                "[daemon] detachWorkspace without orphan support; closing channel {channel} instead"
                            );
                            begin_close(&mut channels, channel, &options);
                            maybe_start_grace(&channels, &mut grace_deadline, &options);
                        }
                    },
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
                        // 心跳：回 pong（Host 据此武装沉默判定，`docs/core/core-remote.md` 第 2.5 节）；本帧的空闲顺延由上面「收到控制帧」统一处理
                        send_to_host(out.as_ref(), &DaemonToHostFrame::Pong);
                    }
                }
            }
            Ok(DaemonEvent::HostDisconnected) => {
                match &context {
                    Some(ctx) => {
                        // specs/031：非 idle 的 Core 孤儿化存活，全 idle 的照旧终止
                        orphan_on_disconnect(&mut channels, ctx, &out);
                    }
                    None => {
                        diag!("[daemon] control channel disconnected; closing all cores");
                        close_all(&channels, &out);
                    }
                }
                return ChannelExit::Continue;
            }
            Ok(DaemonEvent::FrameLine { channel, line }) => {
                // 窥探点（连接态）：快照更新该 channel 的忙闲缓存（断开收尾的判据），
                // 其余帧不解读、原样转发
                if let Some(state) = channels.get_mut(&channel) {
                    if let Some(PeekedFrame::RuntimeSnapshot(event)) = peek_frame(&line) {
                        state.last_runtime = Some(event);
                        state.last_runtime_line = Some(line.clone());
                    }
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(frame) => send_to_host(
                        out.as_ref(),
                        &DaemonToHostFrame::Frame { channel, frame },
                    ),
                    Err(err) => {
                        diag!("[daemon] channel {channel}: malformed inner frame: {err}; dropped")
                    }
                }
            }
            Ok(DaemonEvent::CoreExited { channel, code }) => {
                handle_core_exit(&mut channels, channel, code, &spawner, &events_tx, &out, &options);
                maybe_start_grace(&channels, &mut grace_deadline, &options);
            }
            Err(RecvTimeoutError::Timeout) => {
                // 心跳到期：Host 消失而 TCP 未断（断网 / 休眠 / 进程冻结）时读线程
                // 永远等不到 EOF，只能按沉默判定断开——同 `HostDisconnected` 口径
                if let Some(deadline) = heartbeat_deadline {
                    if Instant::now() >= deadline {
                        diag!("[daemon] control channel heartbeat timed out; closing all cores");
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
        diag!(
            "[daemon] no live cores; exiting in {}s unless a workspace opens",
            options.grace_period.as_secs()
        );
        *grace_deadline = Some(Instant::now() + options.grace_period);
    }
}

fn open_workspace(
    channels: &mut HashMap<u64, ChannelState>,
    next_channel: &mut u64,
    events_tx: &Sender<DaemonEvent>,
    spawner: &Arc<dyn CoreSpawner>,
    out: &Arc<dyn FrameOutput>,
    id: u64,
    workspace_ref: &Value,
    context: Option<&ConnectionContext>,
) {
    let channel = *next_channel;
    let workspace_path = workspace_ref
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    // 认领（specs/031）：同 path 的孤儿优先于新进程；摘表与移交原子，败者按无孤儿处理
    if let Some(ctx) = context {
        if !workspace_path.is_empty() {
            if let Some(state) =
                claim_orphan(ctx, &workspace_path, channel, events_tx, out, id)
            {
                *next_channel += 1;
                channels.insert(channel, state);
                return;
            }
        }
    }
    *next_channel += 1;
    let sink = Arc::new(RoutableSink::to_connection(events_tx.clone(), channel));
    match spawner.spawn(channel, Arc::clone(&sink) as Arc<dyn CoreEventSink>) {
        Ok(handle) => {
            let mut state = ChannelState::new(channel, sink, workspace_path.clone());
            state.handle = Some(handle);
            channels.insert(channel, state);
            diag!("[daemon] channel {channel} opened (workspace={workspace_path})");
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
            diag!("[daemon] failed to start core for workspace request {id}: {err}");
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

/// 认领孤儿（specs/031）：命中且进程存活则不开新进程，把句柄移入本连接的
/// channel 表并重放缓存帧；未命中 / 已死返回 `None` 走现行 spawn 路径。
fn claim_orphan(
    ctx: &ConnectionContext,
    workspace_path: &str,
    channel: u64,
    events_tx: &Sender<DaemonEvent>,
    out: &Arc<dyn FrameOutput>,
    id: u64,
) -> Option<ChannelState> {
    let (slot, entry) = ctx.orphans.take_earliest(workspace_path)?;
    let mut entry = entry.lock().unwrap();
    if entry.exited {
        // 孤儿已崩溃：按无孤儿处理（spec AC-13 / FR-005 不重启孤儿），登记已摘除
        diag!("[daemon] orphan for {workspace_path} already exited; spawning a fresh core");
        return None;
    }
    // 摘表成功即移交：把帧出口切回本连接（channel 号换成新连接分配的号），
    // 之后再喂入的帧直接进连接事件通道
    *slot.sink.route.lock().unwrap() = SinkRoute::Connection {
        events: events_tx.clone(),
        channel,
    };
    // 重放缓冲按到达序重放；缓冲没有比最新快照更新的内容时补放最新快照一帧，
    // 保证新宿主拿到全量当前状态（spec FR-006）
    let mut replay = drain_replay(&mut entry);
    if let Some(runtime_line) = &entry.runtime_line {
        if replay.last().map(String::as_str) != Some(runtime_line.as_str()) {
            replay.push(runtime_line.clone());
        }
    }
    let mut state = ChannelState::new(
        channel,
        Arc::clone(&slot.sink),
        workspace_path.to_string(),
    );
    state.handle = entry.handle.take();
    state.last_runtime = entry.runtime.take();
    drop(entry);
    diag!("[daemon] channel {channel} claimed an orphan core (workspace={workspace_path}, replay={} frames)", replay.len());
    send_to_host(
        out.as_ref(),
        &DaemonToHostFrame::WorkspaceOpened {
            id,
            channel,
            descriptor: ChannelDescriptor::Multiplexed { channel },
        },
    );
    for line in replay {
        match serde_json::from_str::<Value>(&line) {
            Ok(frame) => send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::Frame { channel, frame },
            ),
            Err(err) => diag!("[daemon] claimed replay frame malformed: {err}; dropped"),
        }
    }
    Some(state)
}

/// `detachWorkspace`（specs/031）：把该 Core 移入孤儿表继续执行，连接与其余
/// channel 不受影响；回 `workspaceClosed { reason: 'detached' }`。登记冲突
/// （同键已存在）按现行关闭路径兜底，不静默覆盖。
fn detach_channel(
    channels: &mut HashMap<u64, ChannelState>,
    ctx: &ConnectionContext,
    channel: u64,
    out: &Arc<dyn FrameOutput>,
) {
    let Some(mut state) = channels.remove(&channel) else {
        diag!("[daemon] detachWorkspace for unknown channel {channel}");
        return;
    };
    if state.closing {
        // 已在关闭流程中：放回去让既有关闭走完（进程退出时按 closed 报告）
        diag!("[daemon] detachWorkspace for closing channel {channel}; ignored");
        channels.insert(channel, state);
        return;
    }
    let Some(handle) = state.handle.take() else {
        diag!("[daemon] detachWorkspace for channel {channel} without a core; dropped");
        return;
    };
    match ctx.orphans.insert(
        ctx.connection,
        &state.workspace_path,
        handle,
        state.last_runtime.take(),
        state.last_runtime_line.take(),
        &state.sink,
    ) {
        Ok(()) => {
            diag!(
                "[daemon] channel {channel} detached to the orphan table (workspace={})",
                state.workspace_path
            );
            send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::WorkspaceClosed {
                    channel,
                    reason: WorkspaceCloseReason::Detached,
                },
            );
        }
        Err(handle) => {
            diag!(
                "[daemon] orphan table conflict for {}; closing channel {channel} instead",
                state.workspace_path
            );
            let _ = handle.send_line("{\"kind\":\"shutdown\"}");
            handle.kill();
            send_to_host(
                out.as_ref(),
                &DaemonToHostFrame::WorkspaceClosed {
                    channel,
                    reason: WorkspaceCloseReason::Closed,
                },
            );
        }
    }
}

/// 连接断开收尾（specs/031）：逐 channel 按最近快照分叉——存在非 idle 会话的
/// Core 孤儿化存活，全部 idle（或无快照）的 Core 照旧终止。
fn orphan_on_disconnect(
    channels: &mut HashMap<u64, ChannelState>,
    ctx: &ConnectionContext,
    out: &Arc<dyn FrameOutput>,
) {
    diag!("[daemon] control channel disconnected; detaching busy cores, closing idle cores");
    for (_, mut state) in channels.drain() {
        let Some(handle) = state.handle.take() else {
            continue;
        };
        if state.has_busy_session() {
            if let Err(handle) = ctx.orphans.insert(
                ctx.connection,
                &state.workspace_path,
                handle,
                state.last_runtime.take(),
                state.last_runtime_line.take(),
                &state.sink,
            ) {
                diag!(
                    "[daemon] orphan table conflict for {}; killing the core instead",
                    state.workspace_path
                );
                let _ = handle.send_line("{\"kind\":\"shutdown\"}");
                handle.kill();
            } else {
                diag!(
                    "[daemon] channel {} orphaned (workspace={})",
                    state.channel,
                    state.workspace_path
                );
            }
        } else {
            let _ = handle.send_line("{\"kind\":\"shutdown\"}");
            handle.kill();
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
}

fn begin_close(
    channels: &mut HashMap<u64, ChannelState>,
    channel: u64,
    options: &DaemonOptions,
) {
    let Some(state) = channels.get_mut(&channel) else {
        diag!("[daemon] closeWorkspace for unknown channel {channel}");
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
        diag!("[daemon] frame for unknown channel {channel}; dropped");
        return;
    };
    if state.closing {
        diag!("[daemon] channel {channel} is closing; frame dropped");
        return;
    }
    let Some(line) = inner_line(frame) else {
        diag!("[daemon] channel {channel}: failed to encode inner frame; dropped");
        return;
    };
    match &state.handle {
        Some(handle) => {
            if let Err(err) = handle.send_line(&line) {
                diag!("[daemon] channel {channel}: core stdin write failed: {err}");
            }
        }
        None => {
            if state.pending.len() > OUTBOX_WARN_THRESHOLD {
                diag!(
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
    events_tx: &Sender<DaemonEvent>,
    out: &Arc<dyn FrameOutput>,
    options: &DaemonOptions,
) {
    let Some(mut state) = channels.remove(&channel) else {
        diag!("[daemon] exit event for unknown channel {channel}");
        return;
    };
    state.handle = None;
    // Core 进程重启意味着新进程：忙闲缓存清空（新进程尚无在跑工作）
    state.last_runtime = None;
    state.last_runtime_line = None;

    if state.closing {
        diag!("[daemon] channel {channel} closed (core exited)");
        send_to_host(
            out.as_ref(),
            &DaemonToHostFrame::WorkspaceClosed {
                channel,
                reason: WorkspaceCloseReason::Closed,
            },
        );
        return;
    }

    diag!("[daemon] channel {channel} core exited unexpectedly (code={code:?})");
    if schedule_restart(&mut state, out, options) {
        channels.insert(channel, state);
    }
    let _ = (spawner, events_tx); // 重启由主循环的定时器执行
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
        diag!(
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
    events_tx: &Sender<DaemonEvent>,
    out: &Arc<dyn FrameOutput>,
    options: &DaemonOptions,
) {
    let Some(state) = channels.get_mut(&channel) else {
        return;
    };
    // 新进程一个新帧出口（旧出口随旧进程消亡）
    let sink = Arc::new(RoutableSink::to_connection(events_tx.clone(), channel));
    match spawner.spawn(channel, Arc::clone(&sink) as Arc<dyn CoreEventSink>) {
        Ok(handle) => {
            state.handle = Some(handle);
            state.sink = sink;
            diag!("[daemon] channel {channel} restarted on the same channel");
            // 重启期间排队的帧（含 Host 的重新握手 hello）按序冲刷
            let pending = std::mem::take(&mut state.pending);
            if let Some(handle) = &state.handle {
                for line in pending {
                    if let Err(err) = handle.send_line(&line) {
                        diag!("[daemon] channel {channel}: flush failed: {err}");
                        break;
                    }
                }
            }
        }
        Err(err) => {
            diag!("[daemon] channel {channel}: failed to restart core: {err}");
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

/// 在一条控制通道上跑 daemon 主循环：读线程把行送入事件通道，返回会话结束原因。
///
/// 生产入口是远程 TCP（`remote::serve_connection`，`start-daemon`，每条连接一次）；
/// 测试注入内存 reader / `ChannelOutput` / 假进程工厂。reader 由 `make_reader` 在
/// 读线程里创建。
///
/// 事件通道由调用方创建并传入：调用方（每条连接的服务线程）持有 `Sender` 的克隆，
/// 可在会话外注入 `DaemonEvent::HostDisconnected`——停机广播用它让会话自己走
/// 「Host 断开」收尾（关闭自己的全部 Core），不依赖 socket shutdown 唤醒阻塞中的
/// 读线程（Windows 上对自身 socket 的 shutdown 不会取消进行中的 read）。测试不需要
/// 注入：把 `Sender` 直接丢弃即可。
pub fn run_control_channel<R, F>(
    make_reader: F,
    out: Arc<dyn FrameOutput>,
    spawner: Arc<dyn CoreSpawner>,
    options: DaemonOptions,
    events: Sender<DaemonEvent>,
    event_rx: Receiver<DaemonEvent>,
    context: Option<ConnectionContext>,
) -> ChannelExit
where
    R: BufRead,
    F: FnOnce() -> R + Send + 'static,
{
    // 控制通道读线程：按行解析成 Command；EOF 视为 Host 断开
    let reader_events = events.clone();
    std::thread::spawn(move || {
        let reader = make_reader();
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if reader_events.send(DaemonEvent::Command(line)).is_err() {
                        return;
                    }
                }
                Err(err) => {
                    diag!("[daemon] control channel read error: {err}");
                    break;
                }
            }
        }
        let _ = reader_events.send(DaemonEvent::HostDisconnected);
    });

    run_daemon(events, event_rx, out, spawner, options, context)
}

#[cfg(test)]
#[path = "daemon_tests.rs"]
mod tests;

//! 远程 Core 服务（见 `docs/core-daemon.md` 第 12 节）。
//!
//! 两个角色：
//! - `start`（启动器，用户可见）：确保后台 daemon 在跑，打印就绪信息后自己退出；
//!   没有 daemon 就用 `start-daemon` 拉一个到后台。并发 start 由按指纹的互斥锁
//!   串行化：两台机器的客户端同时首次引导同一台服务器，同指纹也只拉起一个 daemon。
//! - `start-daemon`（daemon 实体，启动器的内部实现）：绑回环端口、把实际 endpoint
//!   落盘（`~/<configDir>/run/core-daemon-<指纹>.json`，按构建指纹区分——
//!   `docs/standalone-core.md` 第 4.4 节），然后常驻 accept。
//!
//! daemon 只监听目标机器的回环地址，端口由内核分配：Host 经 SSH 转发接入，端口不出
//! 机器，也不需要用户手工填任何连接信息。回环地址就是访问边界。
//!
//! daemon 同时服务多条控制通道：accept 循环每接受一条连接就交一个线程去服务
//! （thread-per-connection，同步阻塞模型，不引入 async runtime），随即回到 accept；
//! 连接之间互不阻塞（`docs/core-daemon.md` 第 12.5 节）。远程目录列举
//! （`listDirectories`）也在控制通道上完成，Host 据此在连接后立刻弹出远端目录选择器。
//!
//! 「断开」有两条路径：TCP 层的 EOF / 错误，和心跳空闲超时——Host 消失而 TCP 未断
//! （断网 / 休眠 / 进程冻结）时读线程永远等不到 EOF，靠 Host 定期 `ping` 的有无判定
//! （沉默即断开，`docs/core-daemon.md` 第 12.5 节）。断开只结束该连接及其全部 Core，
//! 服务线程退出，daemon 继续接受下一条连接；只有任一连接发 `shutdown`（`kill` 发的）
//! 才结束整个 daemon 进程——停机广播经 [`DaemonRuntime`] 向每条在途连接的会话注入
//! 「Host 断开」事件，各连接走自己的收尾路径（关闭各自的全部 Core）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use socket2::{SockRef, TcpKeepalive};

use crate::daemon::{
    self, ChannelExit, CoreSpawner, DaemonEvent, DaemonOptions, FrameOutput, HEARTBEAT_TIMEOUT,
};
use crate::util::diag;
use crate::daemon_protocol::DirectoryEntry;

/// 远程服务的运行参数（`start` / `start-daemon` 共用）。
#[derive(Clone, Debug, PartialEq, Default)]
pub struct RemoteOptions {
    /// 空闲退出（`--idle-exit <秒>`）：没有任何控制连接持续该时长后 daemon 自行退出。
    /// SSH 引导传 30 秒——客户端异常退出（crash / 断电 / 网络消失）后远端不留常驻进程；
    /// 不给这个选项时 daemon 常驻，只有 `shutdown`（`kill`）结束
    /// （`docs/core-daemon.md` 第 12.5 节）。
    pub idle_exit: Option<Duration>,
}

impl RemoteOptions {
    /// 解析命令行里的远程选项：`--idle-exit <秒>`。
    pub fn from_args(args: &[String]) -> Self {
        let mut options = Self::default();
        let mut index = 0;
        while index < args.len() {
            let arg = args[index].as_str();
            let take_value = |name: &str| -> Option<String> {
                if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                    return Some(value.to_string());
                }
                if arg == name {
                    return args.get(index + 1).cloned();
                }
                None
            };
            if let Some(value) = take_value("--idle-exit") {
                match value.parse::<u64>() {
                    // 0 会让 daemon 在宿主接入前就退出，视为没给
                    Ok(seconds) if seconds > 0 => options.idle_exit = Some(Duration::from_secs(seconds)),
                    _ => diag!("[core] remote: invalid --idle-exit value {value:?}; ignored"),
                }
                index += if arg == "--idle-exit" { 2 } else { 1 };
                continue;
            }
            index += 1;
        }
        options
    }
}

// ==================== 启动输出 ====================

/// 启动输出：daemon 已就绪，并给出它实际监听的端口。
///
/// daemon 只监听回环，Host 经 SSH 转发接入——这里只打印诊断信息。
pub fn ready_message(port: u16) -> String {
    format!("[core] 远程服务已就绪，监听 127.0.0.1:{port}（Host 经 SSH 转发接入）")
}

// ==================== 目录列举 ====================

/// 一次目录列举的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct DirectoryListing {
    /// 被列举的目录绝对路径
    pub path: String,
    /// 上级目录；已在文件系统根时为 `None`
    pub parent: Option<String>,
    /// 子目录（按名字排序）
    pub entries: Vec<DirectoryEntry>,
}

/// 用户主目录：`HOME`（Unix / WSL）优先，其次 `USERPROFILE`（Windows）。
pub fn home_dir() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("HOME") {
        if !home.is_empty() {
            return Some(PathBuf::from(home));
        }
    }
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        if !profile.is_empty() {
            return Some(PathBuf::from(profile));
        }
    }
    None
}

/// 把请求路径收成绝对路径。相对路径直接拒绝：Host 拿到的目录名要能直接当工作区路径用。
fn absolute_path(value: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(value);
    if !target.is_absolute() {
        return Err(format!("path must be absolute: {}", target.display()));
    }
    Ok(target)
}

/// 列举一个目录下的子目录。
///
/// `path` 为 `None` / 空串时从主目录开始（远程选择器的入口）。
pub fn list_directories(path: Option<&str>) -> Result<DirectoryListing, String> {
    let requested = match path {
        Some(value) if !value.trim().is_empty() => absolute_path(value)?,
        _ => home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?,
    };
    let mut entries: Vec<DirectoryEntry> = Vec::new();
    let read = std::fs::read_dir(&requested)
        .map_err(|error| format!("cannot read {}: {error}", requested.display()))?;
    for entry in read.flatten() {
        let entry_path = entry.path();
        // 跟随符号链接：链接到目录的条目也应当能进
        if !entry_path.is_dir() {
            continue;
        }
        entries.push(DirectoryEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry_path.to_string_lossy().to_string(),
        });
    }
    entries.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(DirectoryListing {
        path: requested.to_string_lossy().to_string(),
        parent: requested.parent().map(Path::to_string_lossy).map(|p| p.to_string()),
        entries,
    })
}

/// 新建一个目录（父目录不存在时一并创建），返回实际路径。
pub fn create_directory(path: &str) -> Result<String, String> {
    let target = absolute_path(path)?;
    std::fs::create_dir_all(&target)
        .map_err(|error| format!("cannot create {}: {error}", target.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/// 重命名一个目录：只换同一父目录下的名字，返回新路径。
///
/// 只接受**纯名字**（不含分隔符、不是 `.` / `..`）：改名与移动是两件事，开放移动等于
/// 让一条控制通道能把目录搬到任意位置，没必要。目标已存在时拒绝，不覆盖。
pub fn rename_directory(path: &str, name: &str) -> Result<String, String> {
    let source = absolute_path(path)?;
    let name = name.trim();
    if name.is_empty() {
        return Err("new name must not be empty".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err(format!("new name must not contain a path separator: {name}"));
    }
    if name == "." || name == ".." {
        return Err(format!("new name must not be a path traversal: {name}"));
    }
    let parent = source
        .parent()
        .ok_or_else(|| format!("refusing to rename a filesystem root: {}", source.display()))?;
    let target = parent.join(name);
    if target.exists() {
        return Err(format!("target already exists: {}", target.display()));
    }
    std::fs::rename(&source, &target)
        .map_err(|error| format!("cannot rename {}: {error}", source.display()))?;
    Ok(target.to_string_lossy().to_string())
}

/// `delete_directory` 的失败原因：`NotEmpty` 单独拎出来，Host 据此提示「递归删除」。
#[derive(Debug, PartialEq)]
pub enum DeleteDirectoryError {
    /// 目录非空，且本次没有要求递归删除
    NotEmpty(String),
    /// 其它失败
    Failed(String),
}

/// 删除一个目录，返回实际路径。
///
/// `recursive` 为 `false` 时只接受空目录：非空返回 [`DeleteDirectoryError::NotEmpty`]，
/// 让 Host 先问一次用户「要不要连里面的内容一起删」。为 `true` 时整棵子树删除。
///
/// 无论哪种模式都拒绝文件系统根：删根几乎一定是操作失误，不是「清理刚建错的目录」。
pub fn delete_directory(path: &str, recursive: bool) -> Result<String, DeleteDirectoryError> {
    let target = absolute_path(path).map_err(DeleteDirectoryError::Failed)?;
    if target.parent().is_none() {
        return Err(DeleteDirectoryError::Failed(format!(
            "refusing to delete a filesystem root: {}",
            target.display()
        )));
    }
    if recursive {
        std::fs::remove_dir_all(&target).map_err(|error| {
            DeleteDirectoryError::Failed(format!("cannot remove {}: {error}", target.display()))
        })?;
        return Ok(target.to_string_lossy().to_string());
    }
    let mut entries = std::fs::read_dir(&target).map_err(|error| {
        DeleteDirectoryError::Failed(format!("cannot read {}: {error}", target.display()))
    })?;
    if entries.next().is_some() {
        return Err(DeleteDirectoryError::NotEmpty(format!(
            "directory is not empty: {}",
            target.display()
        )));
    }
    std::fs::remove_dir(&target).map_err(|error| {
        DeleteDirectoryError::Failed(format!("cannot remove {}: {error}", target.display()))
    })?;
    Ok(target.to_string_lossy().to_string())
}

// ==================== 控制通道 ====================

/// TCP 控制通道出站口：一把锁串行化整帧写入。
struct SocketOutput {
    stream: Mutex<TcpStream>,
}

impl SocketOutput {
    fn new(stream: TcpStream) -> Self {
        Self {
            stream: Mutex::new(stream),
        }
    }
}

impl FrameOutput for SocketOutput {
    fn write_line(&self, line: String) {
        let mut stream = match self.stream.lock() {
            Ok(stream) => stream,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Err(error) = stream.write_all(line.as_bytes()).and_then(|_| stream.flush()) {
            diag!("[core] remote control write failed: {error}");
        }
    }
}

/// 远程连接的 daemon 参数：控制通道在，daemon 就在（不因没有工作区而 grace 退出）。
///
/// 心跳空闲回收只在远程启用：Host 定期发 `ping`，沉默即断开
/// （`docs/core-daemon.md` 第 12.5 节）。
pub fn remote_daemon_options() -> DaemonOptions {
    DaemonOptions {
        idle_exit: false,
        heartbeat_timeout: Some(HEARTBEAT_TIMEOUT),
        ..DaemonOptions::default()
    }
}

/// 把控制通道交给 daemon 主循环。返回即这条连接结束。
///
/// 由每条已接受连接自己的服务线程调用（thread-per-connection，
/// `docs/core-daemon.md` 第 12.5 节）。返回值在线程内处理（`serve_accepted`）：
/// `Stop`（对端发 `shutdown`，或本连接内部错误）→ 触发整个 daemon 的停机广播；
/// `Continue`（普通断线）→ 线程自然结束，daemon 继续服务其它连接。
///
/// `session_events` 是这条会话的事件通道（调用方创建，发送端已登记进注册表供停机
/// 广播注入），原样转交 `run_control_channel`。
pub fn serve_connection(
    stream: TcpStream,
    options: DaemonOptions,
    spawner: Arc<dyn CoreSpawner>,
    session_events: (Sender<DaemonEvent>, Receiver<DaemonEvent>),
) -> ChannelExit {
    // 死对端探测（`docs/core-daemon.md` 第 12.5 节）：对端消失后读线程等不到 EOF
    // 时，keepalive 是 socket 层的回收手段（心跳超时兜底控制帧层的沉默）。
    enable_keepalive(&stream);
    let peer = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let write_stream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(error) => {
            diag!("[core] remote: cannot clone control stream for {peer}: {error}");
            return ChannelExit::Continue;
        }
    };
    let out = Arc::new(SocketOutput::new(write_stream));
    // 心跳超时 / 停机广播提前返回时，读线程仍阻塞在这条 socket 上：留一个句柄，
    // 返回前 shutdown 强制它的 read 失败退出，连接与线程都不悬挂
    let shutdown = stream.try_clone().ok();
    let reader = BufReader::new(stream);

    let exit = daemon::run_control_channel(
        move || reader,
        out,
        spawner,
        options,
        session_events.0,
        session_events.1,
    );
    diag!("[core] remote: {peer} disconnected");
    if let Some(handle) = shutdown {
        let _ = handle.shutdown(Shutdown::Both);
    }
    exit
}

/// 控制连接的 TCP keepalive：空闲 45s 起探，每 10s 一次，3 次无应答判死
/// （约 75s 发现死对端；interval / retries 在个别平台没有内核对应项，
/// socket2 会静默忽略，探活仍以系统默认参数发生）。
fn enable_keepalive(stream: &TcpStream) {
    let keepalive = TcpKeepalive::new()
        .with_time(Duration::from_secs(45))
        .with_interval(Duration::from_secs(10))
        .with_retries(3);
    let _ = SockRef::from(stream).set_tcp_keepalive(&keepalive);
}

// ==================== 监听入口 ====================

/// 绑定回环地址 + 内核分配的端口（`docs/core-daemon.md` 第 12.2 节）。
///
/// daemon 端口不出目标机器：Host 经 SSH 转发接入，连接从远端本机发起。端口交给内核
/// 分配，多版本 daemon 在同一台机器上并存时互不抢固定端口；实际端口落盘在状态文件里。
pub fn bind_listener() -> std::io::Result<TcpListener> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
}

// ==================== daemon 状态文件 ====================

/// daemon 落盘文件名的前缀：实际文件按构建指纹区分——
/// 状态 `run/core-daemon-<指纹>.json`（+ 同名 `.lock`）、日志 `logs/core-daemon-<指纹>.log`。
///
/// 一个指纹一个 daemon、一份落盘文件：多版本 Core 在同一台远端机器上各占一个槽位、
/// 各跑一个 daemon 时，各自的 `start` / `kill` / 探测只作用于自己指纹的 daemon，
/// 互不踩踏（`docs/standalone-core.md` 第 4.4 节、`docs/core-daemon.md` 第 12.3 节）。
/// 命名规则与 `src/host/standalone/daemonProtocol.ts` 的 `daemonStateFileName` /
/// `daemonLogFileName` 一致，改动必须同步两侧。
pub const DAEMON_FILE_STEM: &str = "core-daemon";

/// 本二进制的构建指纹（`docs/standalone-core.md` 第 4.4 节）。
///
/// `scripts/build-core.mjs` 在调用 cargo 时设置 `CORE_FINGERPRINT`，`build.rs` 把它
/// 烧进编译期环境；指纹只由源码内容与编译器身份决定，daemon 以它区分自己的落盘
/// 文件并对接宿主的按指纹部署。绕过构建脚本直接 `cargo build`（`cargo test` /
/// `clippy` 走同一路径）没有这个环境变量，取固定标记 `manual-build`：发布产物必经
/// 构建脚本（指纹文件与烧入值同源同值），这个占位值只出现在本机手动构建里，不存在
/// 「拿错误指纹部署到错误槽位」的路径——因此允许缺省占位，不属于静默降级。
pub fn build_fingerprint() -> &'static str {
    match option_env!("CORE_FINGERPRINT") {
        Some(fingerprint) if !fingerprint.is_empty() => fingerprint,
        _ => "manual-build",
    }
}

/// 按构建指纹拼出 daemon 的落盘文件名（状态 `.json` / 日志 `.log`）。
fn daemon_file_name(extension: &str) -> String {
    format!("{}-{}.{}", DAEMON_FILE_STEM, build_fingerprint(), extension)
}

/// 状态文件名（`~/<configDir>/` 下）；宿主侧同名规则见 `daemonProtocol.ts::daemonStateFileName`
pub fn daemon_state_file_name() -> String {
    daemon_file_name("json")
}

/// 后台日志文件名（同目录）：daemon 脱离终端后诊断只能落在这里。
pub fn daemon_log_file_name() -> String {
    daemon_file_name("log")
}

/// 启动器等待 daemon 落盘的时长上限。
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
/// 探测「daemon 是否还活着」的连接超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// daemon 落盘的状态（`~/<configDir>/run/core-daemon-<指纹>.json`）。
///
/// 只有 daemon 自己写这个文件（单一写入点）：它知道实际绑定的端口。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DaemonState {
    /// 实际监听的 `IP:端口`（端口由内核分配，这里存实际值）
    pub endpoint: String,
}

/// 配置目录：与 `settings.json` 同目录（`~/<configDir>/`）。
///
/// 独立运行时还没有 `hostEnvironmentProvided`，用与 `project.json` 一致的兜底名。
fn config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "cannot resolve the user home directory".to_string())?;
    let name = crate::config::host_environment()
        .map(|env| env.config_dir_name)
        .unwrap_or_else(|| crate::config::DEFAULT_CONFIG_DIR_NAME.to_string());
    Ok(home.join(name))
}

/// 状态文件路径；配置目录解析不出来时返回 `Err`（调用方直接报错，不静默降级）。
/// 状态文件路径：配置目录的 `run/` 子目录（运行期事实——daemon 在跑的端口，
/// 与配置 / 日志分开落位；宿主侧同名规则见 `daemonProtocol.ts::daemonStateFileName`）。
pub fn daemon_state_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("run").join(daemon_state_file_name()))
}

/// 后台日志路径：配置目录的 `logs/` 子目录（与 TS 侧宿主日志 `logs/<产品>.log` 的
/// 目录口径一致）；`spawn_daemon` 打开日志前会先建目录。
pub fn daemon_log_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("logs").join(daemon_log_file_name()))
}

/// start 互斥锁路径：状态文件名加 `.lock` 后缀（`core-daemon-<指纹>.json.lock`），
/// 与状态文件同在 `run/` 子目录。名字由状态文件名派生，自动按指纹区分——同版本（同
/// 指纹）才互斥，多版本各锁各的。锁获取前会先建目录（`acquire_start_lock_for`）。
fn daemon_lock_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join("run").join(format!("{}.lock", daemon_state_file_name())))
}

/// 读状态文件：不存在 / 读不出 / 解析失败都当作「没有 daemon」。
pub fn read_daemon_state_at(path: &Path) -> Option<DaemonState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DaemonState>(&text).ok()
}

/// 原子落盘状态文件；Unix 上把权限收到 `0600`。
pub fn write_daemon_state(path: &Path, state: &DaemonState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {} failed: {error}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|error| format!("cannot encode daemon state: {error}"))?;
    let temp = path.with_extension(format!("tmp{}", std::process::id()));
    write_private(&temp, &json)?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("rename to {} failed: {error}", path.display()));
    }
    Ok(())
}

/// 写文件并（Unix 上）限定只有属主可读写。
fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("open {} failed: {error}", path.display()))?;
    file.write_all(contents.as_bytes())
        .and_then(|()| file.flush())
        .map_err(|error| format!("write {} failed: {error}", path.display()))
}

/// 连 endpoint（`IP:端口`）；解析不出或连不上都返回 `Err`。
///
/// endpoint 恒为回环地址（daemon 只绑回环），这里不做通配地址替换。
fn connect_endpoint(endpoint: &str) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    let addrs = endpoint
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve {endpoint}: {error}"))?;
    let mut last: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(format!(
        "cannot connect {endpoint}: {}",
        last.map(|error| error.to_string())
            .unwrap_or_else(|| "no address resolved".to_string())
    ))
}

/// 探测 endpoint 上是否真有东西在监听（`host:port` 解析失败即视为没有）。
fn probe_endpoint(endpoint: &str) -> bool {
    connect_endpoint(endpoint).is_ok()
}

// ==================== start 互斥（同指纹只拉起一个 daemon）====================

/// start 互斥锁的等待上限：覆盖持锁方「检查 → 拉起 → 等就绪」的最长持锁时间
/// （LAUNCH_TIMEOUT）加余量。等不到就报错退出，不静默再拉一个 daemon。
const START_LOCK_WAIT: Duration = Duration::from_secs(15);
/// 锁文件读不出持有者 pid 时的老化宽限：罩住「create_new 成功、pid 还没写入」的
/// 正常窗口，过了它才允许按 mtime 抢占。
const START_LOCK_STALE: Duration = Duration::from_secs(15);
/// 抢不到锁时的重试间隔。
const START_LOCK_RETRY: Duration = Duration::from_millis(100);

/// start 互斥锁的持有标记：Drop 时删锁文件，`run_start` 的全部提前返回路径都释放。
#[derive(Debug)]
struct StartLock {
    path: PathBuf,
}

impl Drop for StartLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 拿 start 互斥锁：锁文件用 `create_new`（O_CREAT | O_EXCL）创建——操作系统层面
/// 原子，同一时刻只有一个进程建得成功，写入自己的 pid 供后来者判活
/// （`docs/core-daemon.md` 第 12.3 节）。
///
/// 锁被占时按持有者状态分流：pid 还活着就等（持锁方最多 LAUNCH_TIMEOUT 就该交锁）；
/// pid 已死立即接管（持有者崩溃不会留下永久锁）；pid 读不出（建文件与写 pid 之间
/// 崩溃）按 mtime 超过 [`START_LOCK_STALE`] 接管。等满 [`START_LOCK_WAIT`] 还拿不到
/// 就报错——宁可让这次接入失败，也不能悄悄拉起同指纹的第二个 daemon。
fn acquire_start_lock(path: &Path) -> Result<StartLock, String> {
    acquire_start_lock_for(path, START_LOCK_WAIT, START_LOCK_STALE)
}

/// [`acquire_start_lock`] 的可注入版：等待预算与老化宽限作参数，供测试用小值。
fn acquire_start_lock_for(
    path: &Path,
    wait: Duration,
    stale_after: Duration,
) -> Result<StartLock, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {} failed: {error}", parent.display()))?;
    }
    let deadline = Instant::now() + wait;
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut file) => {
                let _ = writeln!(file, "{}", std::process::id());
                return Ok(StartLock { path: path.to_path_buf() });
            }
            // 锁被占：持有者已死 / 锁文件超龄就接管，否则等一等再试
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if start_lock_is_abandoned(path, stale_after) {
                    let _ = std::fs::remove_file(path);
                    continue;
                }
            }
            Err(error) => return Err(format!("cannot create lock {}: {error}", path.display())),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "another start holds the lock {}; retry when the other client is done",
                path.display()
            ));
        }
        std::thread::sleep(START_LOCK_RETRY);
    }
}

/// 锁文件是否已废弃（可以安全接管）。
fn start_lock_is_abandoned(path: &Path, stale_after: Duration) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        // 锁文件刚被持有者释放：当废弃处理，立刻回循环抢建
        return true;
    };
    let holder = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok());
    match holder {
        Some(pid) => !process_alive(pid),
        // pid 读不出（持有者建文件后、写 pid 前崩了）：按 mtime 老化判定
        None => metadata_age(&metadata) >= stale_after,
    }
}

/// 持有者进程是否还活着。远程机器只支持 Linux，直接查 `/proc`；其它平台查不了
/// 也不猜：按活着处理，交给 mtime 老化兜底（Windows 本机调试 `start` 的路径）。
fn process_alive(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        true
    }
}

/// 文件 mtime 距今的时长；读不出时间按 0（当新鲜）。
fn metadata_age(metadata: &std::fs::Metadata) -> Duration {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.elapsed().ok())
        .unwrap_or_default()
}

// ==================== 启动器（`start`）====================

/// 打印就绪信息：端口取 daemon 状态文件里**实际**监听的那个（内核分配）。
/// 状态文件里的 endpoint 解析不出端口时按损坏处理，报错不猜。
fn print_ready(state: &DaemonState) -> bool {
    let Some(port) = state
        .endpoint
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
    else {
        diag!("[core] remote: malformed endpoint in state file: {}", state.endpoint);
        return false;
    };
    println!("{}", ready_message(port));
    true
}

/// 状态文件里的 daemon 与本次请求的关系。
#[derive(Debug, PartialEq)]
enum ExistingDaemon {
    /// 在跑：直接复用
    Running(DaemonState),
    /// 没有在跑的 daemon（文件缺失 / 已死）
    None,
}

/// 判断状态文件里的 daemon 是否还在跑。
fn existing_daemon(state_path: &Path) -> ExistingDaemon {
    let Some(state) = read_daemon_state_at(state_path) else {
        return ExistingDaemon::None;
    };
    // 文件在但端口连不上：进程已经没了（崩溃 / 重启过机器），按「没有 daemon」处理
    if !probe_endpoint(&state.endpoint) {
        return ExistingDaemon::None;
    }
    ExistingDaemon::Running(state)
}

/// `start`：确保后台 daemon 在跑，把就绪信息打印出来。
///
/// 已有 daemon 在跑（状态文件里的 endpoint 连得上）就直接复用；否则把 daemon 拉到
/// 后台（`start-daemon`，脱离终端、诊断进日志），等它落盘后再打印。本进程随即退出，
/// daemon 常驻。
pub fn run_start(options: RemoteOptions) -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            diag!("[core] remote: {error}");
            return 1;
        }
    };

    match existing_daemon(&state_path) {
        ExistingDaemon::Running(state) => {
            if !print_ready(&state) {
                return 1;
            }
            return 0;
        }
        ExistingDaemon::None => {}
    }

    // 慢路径持互斥锁（`docs/core-daemon.md` 第 12.3 节）：检查与拉起之间的窗口会让
    // 并发的 start 各拉一个同指纹 daemon——锁内重查后，后到的一方直接复用先到方
    // 拉起的 daemon。
    let _lock = match daemon_lock_path().and_then(|path| acquire_start_lock(&path)) {
        Ok(lock) => lock,
        Err(error) => {
            diag!("[core] remote: {error}");
            return 1;
        }
    };

    // 持锁重查：等锁期间对方可能已把 daemon 拉起。
    match existing_daemon(&state_path) {
        ExistingDaemon::Running(state) => {
            if !print_ready(&state) {
                return 1;
            }
            return 0;
        }
        ExistingDaemon::None => {}
    }

    let log_path = match daemon_log_path() {
        Ok(path) => path,
        Err(error) => {
            diag!("[core] remote: {error}");
            return 1;
        }
    };
    if let Err(error) = spawn_daemon(&options, &log_path) {
        diag!("[core] remote: cannot start daemon: {error}");
        return 1;
    }
    match wait_for_daemon(&state_path) {
        Some(state) => {
            if !print_ready(&state) {
                return 1;
            }
            0
        }
        None => {
            diag!(
                "[core] remote: daemon did not listen within {}s; see {}",
                LAUNCH_TIMEOUT.as_secs(),
                log_path.display()
            );
            if let Some(tail) = log_tail(&log_path, 10) {
                eprint!("{tail}");
            }
            1
        }
    }
}

// ==================== 结束 daemon（`kill`）====================

/// `kill`：结束在跑的 daemon（连上它、发 `shutdown`），并清掉状态文件。
///
/// 幂等：没有状态文件、或文件里的 daemon 已经不在了，都算「目标状态已达成」。
pub fn run_kill() -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            diag!("[core] remote: {error}");
            return 1;
        }
    };
    let Some(state) = read_daemon_state_at(&state_path) else {
        println!("[core] remote: no daemon is running");
        return 0;
    };
    match stop_daemon(&state, STOP_TIMEOUT) {
        StopOutcome::Stopped => {
            remove_state_if_unchanged(&state_path, &state);
            println!("[core] remote: daemon stopped ({})", state.endpoint);
            0
        }
        StopOutcome::Unreachable => {
            // 进程已经没了（崩溃 / 机器重启过）：过期状态文件清掉即可
            diag!("[core] remote: daemon is not running ({})", state.endpoint);
            remove_state_if_unchanged(&state_path, &state);
            0
        }
        StopOutcome::Unresponsive => {
            // 连上了但 `ping` 等不到 `pong`：daemon 进程还在，但整体卡死了。
            // 协议路径走不通，按进程兜底强杀——只匹配本可执行文件 + `start-daemon`，
            // 不会误伤别的进程。
            diag!("[core] remote: daemon at {} is not answering; killing the process", state.endpoint);
            let exe = match std::env::current_exe() {
                Ok(exe) => exe,
                Err(error) => {
                    diag!("[core] remote: cannot resolve the current executable: {error}");
                    return 1;
                }
            };
            let pids = find_daemon_pids(Path::new("/proc"), &exe);
            if pids.is_empty() {
                diag!(
                    "[core] remote: no daemon process found; remove {} manually",
                    state_path.display()
                );
                return 1;
            }
            let mut killed = 0;
            for pid in &pids {
                if kill_process(*pid) {
                    killed += 1;
                }
            }
            if killed == 0 {
                diag!("[core] remote: cannot kill daemon process(es) {pids:?}");
                return 1;
            }
            remove_state_if_unchanged(&state_path, &state);
            println!("[core] remote: daemon process killed ({killed}); state file removed");
            0
        }
        StopOutcome::Refused(error) => {
            diag!("[core] remote: {error}");
            1
        }
    }
}

/// 结束 daemon 时读写控制通道的等待上限。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// `stop_daemon` 的结果分类：`kill` 按类别决定收尾动作。
#[derive(Debug, PartialEq, Eq)]
enum StopOutcome {
    /// 已发送 `shutdown`，daemon 结束
    Stopped,
    /// endpoint 连不上：进程已经没了（崩溃 / 机器重启过）
    Unreachable,
    /// 连上了但协议无应答：daemon 进程还在（端口有人监听）但整体卡死，`ping`
    /// 等不到 `pong`。协议路径走不通时 `kill` 据此兜底强杀进程。
    Unresponsive,
    /// 协议层拒绝（克隆控制流 / 写帧失败 / 应答不是 `pong`）：不能强杀
    Refused(String),
}

/// 连上 daemon，`ping` → `pong` 探活，再发 `shutdown`，等它关掉连接。
/// `wait` 是读写应答的等待上限。
fn stop_daemon(state: &DaemonState, wait: Duration) -> StopOutcome {
    let stream = match connect_endpoint(&state.endpoint) {
        Ok(stream) => stream,
        Err(_) => return StopOutcome::Unreachable,
    };
    stream.set_read_timeout(Some(wait)).ok();
    stream.set_write_timeout(Some(wait)).ok();
    let mut reader = match stream.try_clone() {
        Ok(clone) => BufReader::new(clone),
        Err(error) => return StopOutcome::Refused(format!("cannot clone control stream: {error}")),
    };
    let mut stream = stream;

    if let Err(error) = stream.write_all(b"{\"kind\":\"ping\"}\n") {
        // 写都写不进去：连接刚建立就断了，按「进程不在了」处理
        return if is_connection_lost(&error) {
            StopOutcome::Unreachable
        } else {
            StopOutcome::Refused(format!("cannot send ping: {error}"))
        };
    }
    let mut line = String::new();
    // 连上了却等不到应答（超时 / 连接被掐断 / 直接断开）：daemon 没有在处理这条连接
    match reader.read_line(&mut line) {
        Ok(0) => return StopOutcome::Unresponsive,
        Ok(_) => {}
        Err(_) => return StopOutcome::Unresponsive,
    }
    if !line.contains("pong") {
        return StopOutcome::Refused(format!(
            "daemon at {} answered an unexpected frame; not stopping it",
            state.endpoint
        ));
    }

    if let Err(error) = stream.write_all(b"{\"kind\":\"shutdown\"}\n") {
        return StopOutcome::Refused(format!("cannot send shutdown: {error}"));
    }
    // daemon 收到 shutdown 后关连接；读到 EOF（或超时）即视为已停
    line.clear();
    let _ = reader.read_line(&mut line);
    StopOutcome::Stopped
}

/// 连接层失效（对端没了 / 网络断），区别于协议层的拒绝。
fn is_connection_lost(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::UnexpectedEof
    )
}

/// 扫描 `proc_root`（生产环境是 `/proc`），找出「本可执行文件 + `start-daemon`」的
/// 进程号。daemon 是唯一以这对参数启动的进程（CLI 其它动作都是短命的），精确匹配
/// `argv[0]` 与 `argv[1]`，不靠名字模式，不会误杀。
fn find_daemon_pids(proc_root: &Path, exe: &Path) -> Vec<u32> {
    let entries = match std::fs::read_dir(proc_root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut pids = Vec::new();
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        if matches_daemon_cmdline(&read_cmdline(proc_root, pid), exe) {
            pids.push(pid);
        }
    }
    pids
}

/// `argv[0] == exe && argv[1] == "start-daemon"`（见 `find_daemon_pids`）。
fn matches_daemon_cmdline(argv: &[String], exe: &Path) -> bool {
    argv.len() >= 2 && Path::new(&argv[0]) == exe && argv[1] == "start-daemon"
}

/// 读 `/proc/<pid>/cmdline`（NUL 分隔）；读不出按空处理。
fn read_cmdline(proc_root: &Path, pid: u32) -> Vec<String> {
    let raw = std::fs::read_to_string(proc_root.join(pid.to_string()).join("cmdline"))
        .unwrap_or_default();
    raw.split('\0')
        .filter(|arg| !arg.is_empty())
        .map(|arg| arg.to_string())
        .collect()
}

/// 结束一个进程（`kill -9`）；失败返回 false。
fn kill_process(pid: u32) -> bool {
    let mut command = Command::new("kill");
    command.arg("-9").arg(pid.to_string());
    crate::util::hide_console(&mut command);
    command.status().map(|status| status.success()).unwrap_or(false)
}

/// 等 daemon 把状态文件写成「endpoint 连得上」。
fn wait_for_daemon(state_path: &Path) -> Option<DaemonState> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Some(state) = read_daemon_state_at(state_path) {
            if probe_endpoint(&state.endpoint) {
                return Some(state);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 日志尾部（启动失败时给用户看原因）；读不出返回 `None`。
fn log_tail(path: &Path, lines: usize) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    Some(format!("{}\n", all[start..].join("\n")))
}

/// 把 daemon 拉到后台：脱离当前终端 / 进程组，诊断追加到日志。
fn spawn_daemon(options: &RemoteOptions, log_path: &Path) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("cannot resolve the current executable: {error}"))?;
    let mut command = Command::new(exe);
    command.arg("start-daemon");
    // 空闲退出只在显式给了才转发（SSH 引导传 30s；不给则常驻）。
    if let Some(idle) = options.idle_exit {
        command.arg("--idle-exit").arg(idle.as_secs().to_string());
    }
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {} failed: {error}", parent.display()))?;
    }
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("open {} failed: {error}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|error| format!("clone log handle failed: {error}"))?;
    command.stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
    detach(&mut command);
    // 不等待：daemon 常驻后台，启动器打印连接信息后自己退出。
    command
        .spawn()
        .map(|_child| ())
        .map_err(|error| format!("spawn {} failed: {error}", log_path.display()))
}

/// 脱离当前终端 / 进程组，启动器退出后 daemon 继续跑；同时不显示控制台窗口。
fn detach(command: &mut Command) {
    #[cfg(windows)]
    {
        /// 新进程不继承调用方的控制台
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        /// 自成进程组，不受调用方 Ctrl+C 影响
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // 走共享的隐藏控制台助手：`creation_flags` 是覆盖语义，`CREATE_NO_WINDOW`
        // 与脱离终端所需的两个标志位必须一次给全（见 `util::hide_console_with`）。
        crate::util::hide_console_with(command, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // 新进程组：终端关闭时收不到发给前台进程组的 SIGHUP
        command.process_group(0);
    }
}

// ==================== daemon 实体（`start-daemon`）====================

// ==================== daemon 运行时（连接注册表与停机）====================

/// daemon 进程的全局运行时：连接注册表 + 停机标记（`docs/core-daemon.md` 第 12.5 节）。
///
/// daemon 同时服务多条控制连接，每条连接一个服务线程；线程之间唯一的共享是这个
/// 运行时。登记与停机广播在同一把锁下进行，保证 shutdown 广播不漏掉任何一条在途
/// 连接（先于广播登记的连接收到事件注入与 socket 掐断，晚于广播登记的连接看到
/// 停机位后被直接拒绝）。
struct DaemonRuntime {
    /// 每条在途连接的登记项：停机广播用它让各会话走自己的「Host 断开」收尾
    /// （关闭各自的全部 Core），Core 的归属不变，仍然只有它所在的会话关闭它。
    connections: Mutex<ConnectionTable>,
    /// 停机信号：任一连接发 `shutdown`（或 accept 循环终止）时置位
    stopping: AtomicBool,
    /// 停机 / 连接收尾的信号：主线程等「已停机且全部连接线程退出」后清状态文件
    drained: Condvar,
}

/// 连接表：分配连接 id 并保存每条在途连接的登记项
#[derive(Default)]
struct ConnectionTable {
    next_id: u64,
    entries: HashMap<u64, ConnectionEntry>,
}

/// 一条在途连接的登记项
struct ConnectionEntry {
    /// 会话事件通道的发送端：停机广播注入 `HostDisconnected`，该会话的 `run_daemon`
    /// 随即自己走收尾路径。这是停机的**主机制**——Windows 上对自身 socket 的
    /// shutdown 不会取消进行中的 read，只有事件注入能可靠唤醒会话主循环。
    events: Sender<DaemonEvent>,
    /// socket 副本：广播时顺手掐断（Unix 上让阻塞中的读线程立即退出；Windows 上
    /// 阻塞中的 read 不受影响，随进程退出消亡）
    socket: Option<TcpStream>,
}

impl DaemonRuntime {
    fn new() -> DaemonRuntime {
        DaemonRuntime {
            connections: Mutex::new(ConnectionTable::default()),
            stopping: AtomicBool::new(false),
            drained: Condvar::new(),
        }
    }

    /// 登记一条连接；停机已开始时拒绝（返回 `None`），调用方直接关闭这条连接。
    fn register(&self, entry: ConnectionEntry) -> Option<u64> {
        let mut table = self.connections.lock().unwrap();
        if self.stopping.load(Ordering::SeqCst) {
            return None;
        }
        table.next_id += 1;
        let id = table.next_id;
        table.entries.insert(id, entry);
        Some(id)
    }

    /// 注销一条连接：它的会话已收尾（`run_daemon` 返回，自己的 Core 已被关闭）。
    fn unregister(&self, id: u64) {
        let mut table = self.connections.lock().unwrap();
        table.entries.remove(&id);
        drop(table);
        self.drained.notify_all();
    }

    /// 开始停机：置位并广播——向每条在途连接的会话注入 `HostDisconnected`（各会话的
    /// `run_daemon` 走自己的收尾：关闭自己的全部 Core 后线程退出），并顺手掐断各连接
    /// 的 socket。
    fn begin_stop(&self) {
        let table = self.connections.lock().unwrap();
        // 置位必须在持锁期间：与 `register` 互斥，广播不会漏掉任何一条连接
        self.stopping.store(true, Ordering::SeqCst);
        for entry in table.entries.values() {
            // mpsc send 不阻塞；rx 已随会话结束被丢弃时 send 失败，无需处理
            let _ = entry.events.send(DaemonEvent::HostDisconnected);
            if let Some(socket) = &entry.socket {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
        drop(table);
        self.drained.notify_all();
    }

    fn is_stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }

    /// 主线程：等停机信号，或（给了 `idle_exit` 时）等空闲死线。
    ///
    /// 空闲 = 没有任何控制连接：死线在**首次观察到空表**时起算（daemon 刚启动 /
    /// 最后一条连接刚断开），任何一条连接登记即取消，断开后重新起算。到期返回
    /// `false`，调用方走停机收尾；`shutdown` 先到返回 `true`。同一把锁下判定，
    /// 「到期」与「新连接登记」不会交错——到期后 `begin_stop` 置位，迟到的连接
    /// 会被 `register` 拒绝。
    fn wait_for_stop_or_idle(&self, idle_exit: Option<Duration>) -> bool {
        let mut table = self.connections.lock().unwrap();
        let mut idle_deadline: Option<Instant> = None;
        while !self.stopping.load(Ordering::SeqCst) {
            if table.entries.is_empty() {
                if let Some(idle) = idle_exit {
                    let deadline = *idle_deadline.get_or_insert_with(|| Instant::now() + idle);
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return false;
                    }
                    let (guard, _) = self.drained.wait_timeout(table, remaining).unwrap();
                    table = guard;
                    continue;
                }
            } else {
                // 有连接：取消空闲计时，等最后一条断开再重新起算
                idle_deadline = None;
            }
            table = self.drained.wait(table).unwrap();
        }
        true
    }

    /// 主线程：等全部连接线程收尾——各自的 `run_daemon` 已把该连接的 Core 全部关闭。
    /// 有等待上限：到点仍有连接没收尾就带着诊断退出，不让一条收不动的连接挂死
    /// `kill`（Core 还有 stdin EOF 的兜底：daemon 进程退出后各 Core 读到 EOF 自行退出）。
    fn wait_until_drained(&self, limit: Duration) {
        let deadline = Instant::now() + limit;
        let mut table = self.connections.lock().unwrap();
        while !table.entries.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                diag!(
                    "[core] remote: {} connection(s) still closing at the shutdown deadline",
                    table.entries.len()
                );
                return;
            }
            let (guard, _) = self.drained.wait_timeout(table, remaining).unwrap();
            table = guard;
        }
    }
}

/// accept 循环：每条连接一个服务线程，立即回到 accept——任何一条连接（包括连上后
/// 一直不发帧的探活连接）都不阻塞后续接入（`docs/core-daemon.md` 第 12.5 节）。
fn accept_loop(
    listener: TcpListener,
    options: DaemonOptions,
    runtime: Arc<DaemonRuntime>,
    spawner: Arc<dyn CoreSpawner>,
) {
    for stream in listener.incoming() {
        if runtime.is_stopping() {
            break;
        }
        match stream {
            Ok(stream) => {
                // 连接接入落一行日志：daemon 无预警死掉时，日志里最后一条连接记录
                // 就是定位「哪条连接 / 哪个 Core」的锚点
                let peer = stream
                    .peer_addr()
                    .map(|address| address.to_string())
                    .unwrap_or_else(|_| "<unknown>".to_string());
                diag!("[core] remote: control connection accepted ({peer})");
                let runtime = Arc::clone(&runtime);
                let spawner = Arc::clone(&spawner);
                let options = options.clone();
                std::thread::spawn(move || serve_accepted(stream, options, &runtime, spawner));
            }
            Err(error) => diag!("[core] remote: accept failed: {error}"),
        }
    }
    // accept 不再可用而停机位未置（监听异常等）：补一次停机，避免主线程空等
    if !runtime.is_stopping() {
        diag!("[core] remote: accept loop ended; stopping the daemon");
        runtime.begin_stop();
    }
}

/// 一条已接受连接的完整生命周期：登记 → 服务 → 注销；`shutdown` 帧在这里转成
/// 「结束整个 daemon」。
fn serve_accepted(
    stream: TcpStream,
    options: DaemonOptions,
    runtime: &DaemonRuntime,
    spawner: Arc<dyn CoreSpawner>,
) {
    // 会话事件通道在这里创建：本线程持有 `Sender` 克隆（登记进注册表），停机广播
    // 据此向会话注入 `HostDisconnected`（Windows 上对自身 socket 的 shutdown 不会
    // 取消进行中的 read，事件注入是唯一可靠的唤醒手段）
    let (events, event_rx) = mpsc::channel::<DaemonEvent>();
    // 登记先于服务：停机广播与登记在同一把锁下，不会漏掉任何一条在途连接
    let Some(id) = runtime.register(ConnectionEntry {
        events: events.clone(),
        socket: stream.try_clone().ok(),
    }) else {
        // 停机窗口内新接受的连接不再服务，直接关闭——shutdown 是全局生效的
        // kill 语义，不再受理新客户端（设计允许的瞬时状态）
        diag!("[core] remote: connection dropped; the daemon is stopping");
        return;
    };
    let exit = serve_connection(stream, options, spawner, (events, event_rx));
    runtime.unregister(id);
    diag!("[core] remote: control connection closed (exit={exit:?})");
    if exit == ChannelExit::Stop {
        runtime.begin_stop();
    }
}

/// daemon 实体：绑回环端口、把 `endpoint` 落盘，然后常驻服务。
///
/// 由 `start` 拉起，也可以直接运行（调试用）。
pub fn run_start_daemon(options: RemoteOptions) -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            diag!("[core] remote: {error}");
            return 1;
        }
    };
    let listener = match bind_listener() {
        Ok(listener) => listener,
        Err(error) => {
            diag!("[core] remote: cannot bind 127.0.0.1: {error}");
            return 1;
        }
    };
    let local = match listener.local_addr() {
        Ok(address) => address,
        Err(error) => {
            diag!("[core] remote: cannot resolve local address: {error}");
            return 1;
        }
    };
    // endpoint 存回环地址与内核分配的实际端口；Host 读它开 SSH 转发通道。
    let endpoint = format!("{}:{}", Ipv4Addr::LOCALHOST, local.port());
    let state = DaemonState { endpoint };
    // 落盘先于 accept：启动器按「状态文件可读 + endpoint 连得上」判断就绪。
    if let Err(error) = write_daemon_state(&state_path, &state) {
        diag!("[core] remote: cannot write {}: {error}", state_path.display());
        return 1;
    }
    println!("{}", ready_message(local.port()));
    // 标准输出可能被缓冲；启动器 / 用户要立刻看到就绪行，立即冲刷。
    let _ = std::io::stdout().flush();
    // 启动事实落日志（stdout 的就绪行与 stderr 诊断都进了 daemon 日志文件）：
    // 异常退出时日志里得有「何时、以什么参数起来过」这一行锚点
    diag!(
        "[core] daemon started (pid={}, endpoint={endpoint}, idle-exit={}s, binary={})",
        std::process::id(),
        options.idle_exit.map(|idle| idle.as_secs()).unwrap_or_default(),
        std::env::current_exe()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| "<unknown>".to_string())
    );

    // Core 进程工厂启动时解析一次：解析不出直接失败，不等到第一条连接才暴露
    let spawner: Arc<dyn CoreSpawner> = match daemon::SystemCoreSpawner::current_exe() {
        Ok(spawner) => Arc::new(spawner),
        Err(error) => {
            diag!("[core] remote: cannot resolve own executable: {error}");
            return 1;
        }
    };
    // accept 在自己的线程上跑（每条连接再各一个服务线程）；主线程等停机信号，
    // 收到后无需解除 accept 的阻塞——进程随主线程返回而结束。
    let runtime = Arc::new(DaemonRuntime::new());
    {
        let runtime = Arc::clone(&runtime);
        let spawner = Arc::clone(&spawner);
        std::thread::spawn(move || {
            accept_loop(listener, remote_daemon_options(), runtime, spawner)
        });
    }

    // 空闲退出（`--idle-exit`，SSH 引导传 30s）：没有任何控制连接持续该时长（含启动
    // 后一直没有连接——兜住拉起后无人接入的孤儿 daemon）就自行退出，远端不留常驻
    // 进程；未给该选项则常驻，只有 `shutdown`（`kill` 发的）结束
    // （`docs/core-daemon.md` 第 12.5 节）。
    let stopped = runtime.wait_for_stop_or_idle(options.idle_exit);
    if !stopped {
        diag!(
            "[core] remote: no control connections for {}s; the idle daemon exits",
            options.idle_exit.map(|idle| idle.as_secs()).unwrap_or_default()
        );
        // 置停机位：死线判定与连接登记在同一把锁下，但主线程从等待返回到进程退出
        // 之间仍有窗口，置位让迟到的连接被 `register` 拒绝，不会接在一个将死的
        // daemon 上。
        runtime.begin_stop();
    }
    // 等全部连接线程收尾：各自的 `run_daemon` 已把该连接的全部 Core 关闭（空闲退出
    // 时没有连接，立即通过）。
    runtime.wait_until_drained(STOP_TIMEOUT);
    // 只删自己写的那份：期间可能有新 daemon 覆盖过状态文件
    remove_state_if_unchanged(&state_path, &state);
    diag!("[core] daemon stopped (pid={}, endpoint={endpoint})", std::process::id());
    0
}

/// 删掉状态文件——但只删内容仍是 `state` 的那份。
fn remove_state_if_unchanged(path: &Path, state: &DaemonState) {
    if read_daemon_state_at(path).as_ref() == Some(state) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;

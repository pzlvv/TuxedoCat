//! 远程 Core 服务（见 `docs/core-daemon.md` 第 12 节）。
//!
//! 两个角色：
//! - `start`（启动器，用户可见）：确保后台 daemon 在跑，把「连接串」（`IP:端口#token`）
//!   打印出来，随后自己退出；没有 daemon 就用 `start-daemon` 拉一个到后台。
//! - `start-daemon`（daemon 实体，启动器的内部实现）：绑定端口、把实际 endpoint 与
//!   生效的 token 落盘（`~/<configDir>/core-daemon.json`），然后常驻 accept。
//!
//! Host 连上来后第一帧必须是 `auth`，校验通过才进入 daemon 主循环。一个 endpoint 一条
//! 控制通道：同一时刻只服务一条连接（accept 循环里同步处理），连接断开后回到 accept
//! 等待下一次接入。远程目录列举（`listDirectories`）也在这条控制通道上完成，Host 据此
//! 在连接后立刻弹出远端目录选择器。

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::daemon::{self, ChannelExit, DaemonOptions, FrameOutput};
use crate::daemon_protocol::{DaemonToHostFrame, DirectoryEntry, HostToDaemonFrame};

/// 默认监听端口。取一个高位、非常用服务的端口；冲突时从它开始逐个 +1 重试。
pub const DEFAULT_PORT: u16 = 10975;
/// 默认监听地址：绑全部网卡（跨机接入开箱可用，token 是访问控制的唯一凭证）；
/// 只在本机自测时显式传 `--host 127.0.0.1`。
pub const DEFAULT_HOST: &str = "0.0.0.0";
/// 生成的 token 长度（十六进制字符数），128 位。
pub const TOKEN_HEX_LEN: usize = 32;
/// 端口冲突时最多再试多少个（默认端口起逐个 +1）。
pub const PORT_RETRY_LIMIT: u16 = 20;

/// 远程服务的运行参数（`start` / `start-daemon` 共用）。
#[derive(Clone, Debug, PartialEq)]
pub struct RemoteOptions {
    /// 绑定地址（默认 `0.0.0.0`）
    pub host: String,
    /// 绑定端口（默认 `10975`；被占用时逐个 +1 重试）
    pub port: u16,
    /// token；为空串时用操作系统随机数生成一个
    pub token: String,
}

impl Default for RemoteOptions {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            token: String::new(),
        }
    }
}

impl RemoteOptions {
    /// 解析命令行里的远程选项：`--host <addr>`、`--port <n>`、`--token <token>`。
    /// 未给出的项用默认值（`0.0.0.0:10975`）。
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
            if let Some(value) = take_value("--host") {
                options.host = value;
                index += if arg == "--host" { 2 } else { 1 };
                continue;
            }
            if let Some(value) = take_value("--port") {
                match value.parse::<u16>() {
                    Ok(port) => options.port = port,
                    Err(_) => eprintln!("[core] remote: invalid --port value {value:?}; ignored"),
                }
                index += if arg == "--port" { 2 } else { 1 };
                continue;
            }
            if let Some(value) = take_value("--token") {
                options.token = value;
                index += if arg == "--token" { 2 } else { 1 };
                continue;
            }
            index += 1;
        }
        options
    }
}

// ==================== token ====================

/// 生成一个 128 位 token（十六进制）。
///
/// 熵来自操作系统的安全随机数（`getrandom`）。取不到随机数时直接失败，
/// 不做「时间 + 进程 id」这类可预测的降级——token 是访问控制的唯一凭证。
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_HEX_LEN / 2];
    getrandom::getrandom(&mut bytes)
        .expect("OS randomness unavailable; cannot generate a control-channel token");
    let mut token = String::with_capacity(TOKEN_HEX_LEN);
    for byte in bytes.iter() {
        token.push_str(&format!("{byte:02x}"));
    }
    token
}

/// 定长比较，避免 token 校验在长度 / 前缀上泄漏时序信息。
pub fn token_matches(expected: &str, actual: &str) -> bool {
    let expected = expected.as_bytes();
    let actual = actual.as_bytes();
    if expected.len() != actual.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in expected.iter().zip(actual.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

// ==================== 连接串 ====================

/// 连接串：`<IP>:<端口>#<token>`（`docs/core-daemon.md` 第 12.3 节）。
///
/// 桌面端「打开远程工作区」只有一个输入框，粘贴整串即可接入；字段之间不留空格，
/// 用户双击就能整行选中。
pub fn connection_string(host: &str, port: u16, token: &str) -> String {
    format!("{host}:{port}#{token}")
}

/// 连接串里要列出的主机：绑具体地址时就是它本身，绑通配地址时列出本机全部网卡 IPv4。
pub fn connection_hosts(bind_host: &str) -> Vec<String> {
    if bind_host != "0.0.0.0" && bind_host != "::" {
        return vec![bind_host.to_string()];
    }
    local_ipv4s()
        .into_iter()
        .map(|ip| ip.to_string())
        .collect()
}

/// 启动输出：一行说明 + 每个可达主机一条连接串。
///
/// 连接串单独占一行、不带前缀，用户双击即可整行复制（`docs/core-daemon.md` 第 12.3 节）。
pub fn ready_message(bind_host: &str, port: u16, token: &str) -> String {
    let mut text = String::from(
        "[core] 远程服务已就绪，在桌面端「打开远程工作区」粘贴下面任一连接串：\n",
    );
    for host in connection_hosts(bind_host) {
        text.push_str(&connection_string(&host, port, token));
        text.push('\n');
    }
    text.trim_end().to_string()
}

/// 本机全部网卡的非回环 IPv4（按网卡顺序去重，去掉 `169.254.*` 这类链路本地地址），
/// 末尾固定补一条回环。
///
/// 只探测默认路由那一个 IP 会漏掉多网卡（有线 + 无线 + 虚拟网卡）里的可达地址，
/// 所以这里逐个网卡取。枚举失败时只剩回环——绑通配地址的 daemon 必然在回环上可达，
/// 所以这个结果仍然可用。
pub fn local_ipv4s() -> Vec<Ipv4Addr> {
    let mut ips: Vec<Ipv4Addr> = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if let if_addrs::IfAddr::V4(address) = interface.addr {
                if address.ip.is_loopback() || address.ip.is_link_local() {
                    continue;
                }
                if !ips.contains(&address.ip) {
                    ips.push(address.ip);
                }
            }
        }
    }
    ips.push(Ipv4Addr::LOCALHOST);
    ips
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
            eprintln!("[core] remote control write failed: {error}");
        }
    }
}

/// 远程连接的 daemon 参数：控制通道在，daemon 就在（不因没有工作区而 grace 退出）。
pub fn remote_daemon_options() -> DaemonOptions {
    DaemonOptions {
        idle_exit: false,
        ..DaemonOptions::default()
    }
}

/// 校验第一帧 `auth`，通过后把控制通道交给 daemon 主循环。返回即连接结束。
///
/// 返回值告诉调用方（远程 accept 循环）该不该结束整个 daemon：对端发 `shutdown`
/// 才是结束，普通断线只是这条控制通道用完。
pub fn serve_connection(
    stream: TcpStream,
    token: &str,
    options: DaemonOptions,
) -> ChannelExit {
    let peer = stream
        .peer_addr()
        .map(|address| address.to_string())
        .unwrap_or_else(|_| "unknown".to_string());
    let write_stream = match stream.try_clone() {
        Ok(clone) => clone,
        Err(error) => {
            eprintln!("[core] remote: cannot clone control stream for {peer}: {error}");
            return ChannelExit::Continue;
        }
    };
    let out = Arc::new(SocketOutput::new(write_stream));
    let reader = BufReader::new(stream);

    match authenticate(reader, out.as_ref(), token) {
        Some(reader) => {
            eprintln!("[core] remote: {peer} authenticated");
            let exit = daemon::run_control_channel(move || reader, out, options);
            eprintln!("[core] remote: {peer} disconnected");
            exit
        }
        None => {
            eprintln!("[core] remote: {peer} rejected (bad token)");
            ChannelExit::Continue
        }
    }
}

/// 读取并校验第一帧；通过返回仍可继续读的 reader，失败时回 `authFailed` 并返回 `None`。
fn authenticate(
    mut reader: BufReader<TcpStream>,
    out: &dyn FrameOutput,
    token: &str,
) -> Option<BufReader<TcpStream>> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => return None,
        Ok(_) => {}
        Err(error) => {
            eprintln!("[core] remote: control read failed: {error}");
            return None;
        }
    }
    let accepted = match serde_json::from_str::<HostToDaemonFrame>(line.trim_end()) {
        Ok(HostToDaemonFrame::Auth { token: actual }) => token_matches(token, &actual),
        _ => false,
    };
    if accepted {
        send(out, &DaemonToHostFrame::AuthOk);
        Some(reader)
    } else {
        send(
            out,
            &DaemonToHostFrame::AuthFailed {
                error: "invalid token".to_string(),
            },
        );
        None
    }
}

fn send(out: &dyn FrameOutput, frame: &DaemonToHostFrame) {
    match frame.encode() {
        Ok(line) => out.write_line(line),
        Err(error) => eprintln!("[core] remote: failed to encode frame: {error}"),
    }
}

// ==================== 监听入口 ====================

/// 绑定端口；端口被占用时从该端口起逐个 +1 重试（`--port 0` 交给内核，不重试）。
pub fn bind_listener(host: &str, port: u16) -> std::io::Result<TcpListener> {
    let mut candidate = port;
    let mut retries = 0u16;
    loop {
        match TcpListener::bind((host, candidate)) {
            Ok(listener) => return Ok(listener),
            Err(error)
                if port != 0
                    && retries < PORT_RETRY_LIMIT
                    && error.kind() == std::io::ErrorKind::AddrInUse =>
            {
                eprintln!(
                    "[core] remote: port {candidate} is in use; trying {}",
                    candidate.saturating_add(1)
                );
                candidate = candidate.saturating_add(1);
                retries += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

// ==================== daemon 状态文件 ====================

/// daemon 状态文件名：与 `settings.json` 同目录（`~/<configDir>/`）。
pub const DAEMON_STATE_FILE_NAME: &str = "core-daemon.json";
/// daemon 后台日志文件名（同目录）：daemon 脱离终端后诊断只能落在这里。
pub const DAEMON_LOG_FILE_NAME: &str = "core-daemon.log";
/// token 文件名（同目录）：与状态文件分开存，`kill` 删掉状态文件后 token 仍然留着，
/// 下次 `start` 直接复用它（用户不必每次重新抄连接串）。
pub const DAEMON_TOKEN_FILE_NAME: &str = "core-daemon.token";
/// 启动器等待 daemon 落盘的时长上限。
pub const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
/// 探测「daemon 是否还活着」的连接超时。
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// daemon 落盘的状态（`~/<configDir>/core-daemon.json`）。
///
/// 只有 daemon 自己写这个文件（单一写入点）：它同时知道实际绑定的端口与生效的 token。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DaemonState {
    /// 启动时请求的 `host:port`；用来判断在跑的 daemon 是不是本次请求的那个
    pub requested: String,
    /// 实际监听的 `IP:端口`（端口 +1 重试后是实际端口）
    pub endpoint: String,
    /// 控制通道 token
    pub token: String,
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
pub fn daemon_state_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DAEMON_STATE_FILE_NAME))
}

/// 后台日志路径（与状态文件同目录）。
pub fn daemon_log_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DAEMON_LOG_FILE_NAME))
}

/// token 文件路径（与状态文件、会话数据同目录）。
pub fn daemon_token_path() -> Result<PathBuf, String> {
    Ok(config_dir()?.join(DAEMON_TOKEN_FILE_NAME))
}

/// 读状态文件：不存在 / 读不出 / 解析失败都当作「没有 daemon」。
pub fn read_daemon_state_at(path: &Path) -> Option<DaemonState> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<DaemonState>(&text).ok()
}

/// 原子落盘状态文件；Unix 上把权限收到 `0600`（token 是凭证）。
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

/// 启动参数的规范化键：判断在跑的 daemon 是不是本次请求的那个。
fn requested_key(options: &RemoteOptions) -> String {
    address_text(&options.host, options.port)
}

/// `host:port` 文本：IPv6 主机加方括号（`[::]:10975`），IPv4 / 主机名原样。
/// 端口按最后一个 `:` 解析（`connectable` / `print_ready` 都依赖这一点）。
fn address_text(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// 连 endpoint（`host:port`）；解析不出或连不上都返回 `Err`。
///
/// 通配地址（`0.0.0.0` / `::`）先换成回环：绑通配地址的 daemon 一定在回环上可达，
/// 而直接连 `0.0.0.0` 在 Windows 上会失败（状态文件里存的是绑定的通配地址）。
fn connect_endpoint(endpoint: &str) -> Result<TcpStream, String> {
    use std::net::ToSocketAddrs;
    let target = connectable(endpoint);
    let addrs = target
        .to_socket_addrs()
        .map_err(|error| format!("cannot resolve {target}: {error}"))?;
    let mut last: Option<std::io::Error> = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last = Some(error),
        }
    }
    Err(format!(
        "cannot connect {target}: {}",
        last.map(|error| error.to_string())
            .unwrap_or_else(|| "no address resolved".to_string())
    ))
}

/// 把 `host:port` 里的通配主机换成回环，其余原样返回。
fn connectable(endpoint: &str) -> String {
    let Some((host, port)) = endpoint.rsplit_once(':') else {
        return endpoint.to_string();
    };
    match host {
        "0.0.0.0" | "::" | "[::]" => format!("{}:{port}", Ipv4Addr::LOCALHOST),
        _ => endpoint.to_string(),
    }
}

/// 探测 endpoint 上是否真有东西在监听（`host:port` 解析失败即视为没有）。
fn probe_endpoint(endpoint: &str) -> bool {
    connect_endpoint(endpoint).is_ok()
}

// ==================== 启动器（`start`）====================

/// 打印连接串：端口取 daemon 状态文件里**实际**监听的那个（`--port 0` 或 +1 重试后
/// 与请求值不同）。状态文件里的 endpoint 解析不出端口时按损坏处理，报错不猜。
fn print_ready(bind_host: &str, state: &DaemonState) -> bool {
    let Some(port) = state
        .endpoint
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse::<u16>().ok())
    else {
        eprintln!("[core] remote: malformed endpoint in state file: {}", state.endpoint);
        return false;
    };
    println!("{}", ready_message(bind_host, port, &state.token));
    true
}

/// 状态文件里的 daemon 与本次请求的关系。
#[derive(Debug, PartialEq)]
enum ExistingDaemon {
    /// 在跑，且参数一致：直接复用它的连接信息
    Running(DaemonState),
    /// 在跑，但本次参数与它的不同：报错，不静默忽略用户给的参数
    Mismatch(String),
    /// 没有在跑的 daemon（文件缺失 / 已死）
    None,
}

/// 判断状态文件里的 daemon 是否还在跑，以及本次参数能不能复用它。
fn existing_daemon(state_path: &Path, options: &RemoteOptions) -> ExistingDaemon {
    let Some(state) = read_daemon_state_at(state_path) else {
        return ExistingDaemon::None;
    };
    // 文件在但端口连不上：进程已经没了（崩溃 / 重启过机器），按「没有 daemon」处理
    if !probe_endpoint(&state.endpoint) {
        return ExistingDaemon::None;
    }
    if state.requested != requested_key(options) {
        return ExistingDaemon::Mismatch(format!(
            "daemon already listening on {} (started with {}); \
             stop it before changing --host / --port",
            state.endpoint, state.requested
        ));
    }
    if !options.token.trim().is_empty() && options.token != state.token {
        return ExistingDaemon::Mismatch(format!(
            "daemon already listening on {} with another token; \
             stop it before passing --token",
            state.endpoint
        ));
    }
    ExistingDaemon::Running(state)
}

/// `start`：确保后台 daemon 在跑，把连接信息打印出来。
///
/// 已有 daemon 在跑（状态文件里的 endpoint 连得上）就直接复用；否则把 daemon 拉到
/// 后台（`start-daemon`，脱离终端、诊断进日志），等它落盘后再打印。本进程随即退出，
/// daemon 常驻。
pub fn run_start(options: RemoteOptions) -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[core] remote: {error}");
            return 1;
        }
    };
    let requested = requested_key(&options);

    match existing_daemon(&state_path, &options) {
        ExistingDaemon::Running(state) => {
            if !print_ready(&options.host, &state) {
                return 1;
            }
            return 0;
        }
        ExistingDaemon::Mismatch(message) => {
            eprintln!("[core] remote: {message}");
            return 1;
        }
        ExistingDaemon::None => {}
    }

    let log_path = match daemon_log_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[core] remote: {error}");
            return 1;
        }
    };
    if let Err(error) = spawn_daemon(&options, &log_path) {
        eprintln!("[core] remote: cannot start daemon: {error}");
        return 1;
    }
    match wait_for_daemon(&state_path, &requested) {
        Some(state) => {
            if !print_ready(&options.host, &state) {
                return 1;
            }
            0
        }
        None => {
            eprintln!(
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

/// `kill`：结束在跑的 daemon（连上它、`auth`、发 `shutdown`），并清掉状态文件。
///
/// 幂等：没有状态文件、或文件里的 daemon 已经不在了，都算「目标状态已达成」。
/// 只有「连上了但鉴权失败」才报错——那说明状态文件与实际 daemon 对不上。
pub fn run_kill() -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[core] remote: {error}");
            return 1;
        }
    };
    let Some(state) = read_daemon_state_at(&state_path) else {
        println!("[core] remote: no daemon is running");
        return 0;
    };
    match stop_daemon(&state) {
        Ok(()) => {
            remove_state_if_unchanged(&state_path, &state);
            println!("[core] remote: daemon stopped ({})", state.endpoint);
            0
        }
        Err(error) if error == STOP_UNREACHABLE => {
            // 进程已经没了（崩溃 / 机器重启过）：过期状态文件清掉即可
            eprintln!("[core] remote: daemon is not running ({})", state.endpoint);
            remove_state_if_unchanged(&state_path, &state);
            0
        }
        Err(error) => {
            eprintln!("[core] remote: {error}");
            1
        }
    }
}

/// `stop_daemon` 在连不上时的错误标记（与「鉴权失败」区分开）。
const STOP_UNREACHABLE: &str = "unreachable";
/// 结束 daemon 时读写控制通道的等待上限。
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

/// 连上 daemon，`auth` → `shutdown`，等它关掉连接。
fn stop_daemon(state: &DaemonState) -> Result<(), String> {
    let stream = connect_endpoint(&state.endpoint).map_err(|_| STOP_UNREACHABLE.to_string())?;
    stream.set_read_timeout(Some(STOP_TIMEOUT)).ok();
    stream.set_write_timeout(Some(STOP_TIMEOUT)).ok();
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("cannot clone control stream: {error}"))?,
    );
    let mut stream = stream;

    let auth = serde_json::json!({ "kind": "auth", "token": state.token }).to_string();
    stream
        .write_all(format!("{auth}\n").as_bytes())
        .map_err(|error| format!("cannot send auth: {error}"))?;
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("cannot read auth reply: {error}"))?;
    if !line.contains("authOk") {
        return Err(format!(
            "daemon at {} rejected the stored token; not stopping it",
            state.endpoint
        ));
    }

    stream
        .write_all(b"{\"kind\":\"shutdown\"}\n")
        .map_err(|error| format!("cannot send shutdown: {error}"))?;
    // daemon 收到 shutdown 后关连接；读到 EOF（或超时）即视为已停
    line.clear();
    let _ = reader.read_line(&mut line);
    Ok(())
}

/// 等 daemon 把状态文件写成「本次请求的那个 endpoint 且连得上」。
fn wait_for_daemon(state_path: &Path, requested: &str) -> Option<DaemonState> {
    let deadline = Instant::now() + LAUNCH_TIMEOUT;
    loop {
        if let Some(state) = read_daemon_state_at(state_path) {
            if state.requested == requested && probe_endpoint(&state.endpoint) {
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
    command
        .arg("start-daemon")
        .arg("--host")
        .arg(&options.host)
        .arg("--port")
        .arg(options.port.to_string());
    // token 只在用户显式给了才转发：否则由 daemon 按「文件 > 随机」自己定。
    if !options.token.trim().is_empty() {
        command.arg("--token").arg(&options.token);
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

/// 本次启动用哪个 token：`--token` > token 文件里的 > 新随机。
///
/// token 单独存一份文件（`~/<configDir>/core-daemon.token`，与会话数据同目录），而不是只
/// 依赖状态文件：`kill` 会删掉状态文件，token 却应该留着——否则每次重启 daemon 都要重新
/// 抄一遍连接串。
///
/// 落盘失败只是警告：token 已经生效，文件没写成不该让 daemon 起不来。
fn resolve_token(options: &RemoteOptions, token_path: &Path) -> String {
    let token = if !options.token.trim().is_empty() {
        options.token.clone()
    } else {
        read_token_file(token_path).unwrap_or_else(generate_token)
    };
    if let Err(error) = write_token_file(token_path, &token) {
        eprintln!("[core] remote: cannot persist token: {error}");
    }
    token
}

/// 读 token 文件；缺失 / 读不出 / 空内容都当作「没有」。
fn read_token_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let token = text.trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

/// 原子写 token 文件（Unix 上 `0600`：token 是访问控制的唯一凭证）。
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("mkdir {} failed: {error}", parent.display()))?;
    }
    let temp = path.with_extension(format!("tmp{}", std::process::id()));
    write_private(&temp, token)?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("rename to {} failed: {error}", path.display()));
    }
    Ok(())
}

/// daemon 实体：绑定端口、把 `{requested, endpoint, token}` 落盘，然后常驻服务。
///
/// 由 `start` 拉起，也可以直接运行（调试用）。给了 `--token` 就用它并覆盖状态文件。
pub fn run_start_daemon(options: RemoteOptions) -> i32 {
    let state_path = match daemon_state_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[core] remote: {error}");
            return 1;
        }
    };
    let token_path = match daemon_token_path() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[core] remote: {error}");
            return 1;
        }
    };
    let token = resolve_token(&options, &token_path);
    let listener = match bind_listener(&options.host, options.port) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!(
                "[core] remote: cannot bind {}:{}: {error}",
                options.host, options.port
            );
            return 1;
        }
    };
    let local = match listener.local_addr() {
        Ok(address) => address,
        Err(error) => {
            eprintln!("[core] remote: cannot resolve local address: {error}");
            return 1;
        }
    };
    // endpoint 存**绑定的**主机与实际端口（通配地址原样保留）：连接串按实际端口生成，
    // 连它时由 `connectable()` 把通配主机换成回环。
    let endpoint = address_text(&options.host, local.port());
    let state = DaemonState {
        requested: requested_key(&options),
        endpoint: endpoint.clone(),
        token: token.clone(),
    };
    // 落盘先于 accept：启动器按「状态文件可读 + endpoint 连得上」判断就绪。
    if let Err(error) = write_daemon_state(&state_path, &state) {
        eprintln!("[core] remote: cannot write {}: {error}", state_path.display());
        return 1;
    }
    println!("{}", ready_message(&options.host, local.port(), &token));
    // 标准输出可能被缓冲；启动器 / 用户读连接串才能拿到端口与 token，立即冲刷。
    let _ = std::io::stdout().flush();

    let mut stopping = false;
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                if serve_connection(stream, &token, remote_daemon_options()) == ChannelExit::Stop {
                    stopping = true;
                    break;
                }
            }
            Err(error) => eprintln!("[core] remote: accept failed: {error}"),
        }
    }
    if stopping {
        // 只删自己写的那份：期间可能有新 daemon 覆盖过状态文件
        remove_state_if_unchanged(&state_path, &state);
    }
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

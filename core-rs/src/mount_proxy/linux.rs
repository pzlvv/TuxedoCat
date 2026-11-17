//! Linux 上的代理客户端实现（specs/051 FR-005b / FR-007 / FR-007b）。

use super::{PROXY_DIR, PROXY_NAME};

use std::io::{BufReader, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

/// 能力探测的结果（平台无关的载体）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapabilityProbe {
    pub ready: bool,
    pub overlay_ok: bool,
    pub overlay_usable: bool,
    pub reason: String,
}

/// 常驻代理的连接（进程句柄 + 帧通道）。
struct Connection {
    child: Child,
    stream: UnixStream,
    reader: BufReader<UnixStream>,
}

impl Drop for Connection {
    /// 关闭连接并回收进程。
    ///
    /// **回收主路径是 socketpair EOF**（FR-007b）：`UnixStream` 被丢弃 → Core 这端关闭 →
    /// 代理 B 读到 EOF 自行退出 → A 的 `waitpid` 返回。这里 `kill` 只是兜底，覆盖 B 已
    /// 卡死的情况。
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 全局连接（每个 Core 进程一份：一个常驻代理服务一个 Core，非目标明确不跨工作区复用）。
fn connection() -> &'static Mutex<Option<Connection>> {
    static CONNECTION: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
    CONNECTION.get_or_init(|| Mutex::new(None))
}

/// 本次探测过程中记录的原因（代理没拉起时也能解释为什么）
fn last_reason() -> &'static Mutex<String> {
    static REASON: OnceLock<Mutex<String>> = OnceLock::new();
    REASON.get_or_init(|| Mutex::new(String::new()))
}

fn set_reason(reason: impl Into<String>) {
    if let Ok(mut slot) = last_reason().lock() {
        *slot = reason.into();
    }
}

fn reason() -> String {
    last_reason()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// 内核是否支持 overlayfs
///
/// 不复用 `/proc/self/mountinfo`：能力判据要回答「**能不能**挂」，不是「现在挂没挂」。
fn kernel_has_overlay() -> bool {
    std::fs::read_to_string("/proc/filesystems")
        .map(|text| {
            text.lines()
                .any(|line| line.split_whitespace().last() == Some("overlay"))
        })
        .unwrap_or(false)
}

/// 安装位点是否满足 FR-005b 的三条判据：
/// `st_uid == 0`、`st_mode == 04755`、`(mode & 0o022) == 0`。
///
/// **随包目录里的同名产物永不执行**：槽位里那份只是「上传 / 安装的源」，把它当成可执行
/// 代理会得到 `euid != 0` 的拒绝——上一轮就是这么炸的（spec 的「实施现状」）。
fn locate() -> Result<PathBuf, String> {
    let path = Path::new(PROXY_DIR).join(PROXY_NAME);
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "挂载代理未部署：{} 不存在（需要部署）",
                path.display()
            ));
        }
        Err(error) => {
            return Err(format!("无法读取挂载代理 {}（{error}）", path.display()));
        }
    };
    if meta.uid() != 0 {
        return Err(format!(
            "{} 的属主是 uid {}（要求 root），视为未部署",
            path.display(),
            meta.uid()
        ));
    }
    let mode = meta.mode() & 0o7777;
    if mode != 0o4755 {
        return Err(format!(
            "{} 的模式是 {mode:04o}（要求恰好 04755），视为未部署",
            path.display()
        ));
    }
    if meta.mode() & 0o022 != 0 {
        return Err(format!(
            "{} 的组 / 其他可写（模式 {mode:04o}），视为未部署",
            path.display()
        ));
    }
    Ok(path)
}

/// 拉起常驻代理并完成握手。
///
/// `--fd <n>` 传的是 socketpair 的**子端**；代理按 FR-006 不读环境变量，fd 只经 argv。
fn spawn(proxy: &Path) -> Result<Connection, String> {
    let (core_end, proxy_end) =
        UnixStream::pair().map_err(|error| format!("建 socketpair 失败（{error}）"))?;
    // 子端必须在 exec 时保持打开：`pre_exec` 里清 CLOEXEC 是 Linux 独有的做法，
    // 但更简单的是让 Command 只继承这一个 fd（其余一律 Stdio::null）。
    let proxy_fd = proxy_end.as_raw_fd();
    let mut command = Command::new(proxy);
    command
        .arg("--serve")
        .arg("--fd")
        .arg(proxy_fd.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // 代理的诊断走它自己的 fd 2；这里接给 Core 的 stderr，好让原因进日志
        .stderr(Stdio::inherit());
    // 保留子端 fd：`pre_exec` 在 fork 之后、exec 之前跑
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(move || {
            // **只把通信 fd 的 CLOEXEC 清掉，不遍历 `/proc/self/fd` 去关其它 fd**：
            // `read_dir` 会自己占一个目录 fd，而遍历过程中把它关掉会让 Rust 的迭代器
            // 走进未定义路径（实测症状：代理一启动就 `Connection reset by peer`）。
            //
            // fd 纪律由 `Stdio::null()` 与 Command 的默认 CLOEXEC 保证：父进程的其余
            // fd 全部带 CLOEXEC，exec 后自动消失，不需要逐个 close。
            clear_cloexec(proxy_fd);
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|error| format!("拉起挂载代理 {} 失败（{error}）", proxy.display()))?;
    // Core 这端不需要子端了
    drop(proxy_end);

    let stream = core_end;
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|error| format!("复制代理连接失败（{error}）"))?,
    );
    // 握手：先问运行期协议版本，再确认它能在自己的命名空间里挂 overlay
    let version = request(&stream, &mut reader, "version")?;
    let ipc_version = version
        .get("ipcVersion")
        .and_then(|value| value.as_i64())
        .ok_or_else(|| "代理的 version 应答缺 ipcVersion".to_string())?;
    if ipc_version != CORE_SIDE_IPC_VERSION {
        return Err(format!(
            "代理的运行期协议版本是 {ipc_version}，Core 期望 {CORE_SIDE_IPC_VERSION}：需要重新部署"
        ));
    }
    Ok(Connection {
        child,
        stream,
        reader,
    })
}

/// Core 侧期望的运行期 IPC 协议版本（与 `mount-proxy-rs/src/protocol.rs` 的
/// `IPC_PROTOCOL_VERSION` 必须一致；Agent 侧改动需同步这里）。
const CORE_SIDE_IPC_VERSION: i64 = 1;

extern "C" {
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
}
const F_GETFD: i32 = 1;
const F_SETFD: i32 = 2;
const FD_CLOEXEC: i32 = 1;

/// 清掉一个 fd 的 CLOEXEC 位（让 exec 后的代理能继承它）
fn clear_cloexec(fd: i32) {
    unsafe {
        let flags = fcntl(fd, F_GETFD);
        if flags >= 0 {
            let _ = fcntl(fd, F_SETFD, flags & !FD_CLOEXEC);
        }
    }
}

/// 发一条请求并读一条应答。
///
/// 帧格式与 `mount-proxy-rs/src/protocol.rs` 一致：`<8 位十六进制长度>\n<JSON>`。
fn request(
    mut stream: &UnixStream,
    reader: &mut BufReader<UnixStream>,
    op: &str,
) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({ "op": op }).to_string();
    let frame = format!("{:08x}\n{}", payload.len(), payload);
    stream
        .write_all(frame.as_bytes())
        .map_err(|error| format!("向代理发送 {op} 失败（{error}）"))?;
    stream
        .flush()
        .map_err(|error| format!("刷新代理连接失败（{error}）"))?;
    read_reply(reader, op)
}

/// 读一条应答帧。
fn read_reply(reader: &mut BufReader<UnixStream>, op: &str) -> Result<serde_json::Value, String> {
    let mut header = [0u8; 9];
    reader
        .read_exact(&mut header)
        .map_err(|error| format!("读 {op} 应答的帧头失败（{error}）"))?;
    if header[8] != b'\n' {
        return Err(format!("{op} 应答的帧头缺换行终止符"));
    }
    let len_text =
        std::str::from_utf8(&header[..8]).map_err(|_| format!("{op} 应答的帧头不是 ASCII"))?;
    let len = usize::from_str_radix(len_text.trim(), 16)
        .map_err(|_| format!("{op} 应答的帧头不是十六进制"))?;
    let mut payload = vec![0u8; len];
    reader
        .read_exact(&mut payload)
        .map_err(|error| format!("读 {op} 应答的载荷失败（{error}）"))?;
    serde_json::from_slice(&payload).map_err(|error| format!("{op} 应答不是合法 JSON（{error}）"))
}

/// 探测能力（FR-001 的四个字段都从这里推）。
///
/// 每次都反映**当前**状态，不用启动期缓存：代理随时可能消失（AC-28b / AC-28d）。
pub fn probe_capabilities() -> CapabilityProbe {
    let overlay_usable = kernel_has_overlay();
    // 拿连接（必要时拉起）。失败只记录原因，不 panic、不退出。
    let ready = match ensure_connected() {
        Ok(()) => true,
        Err(reason) => {
            set_reason(reason);
            false
        }
    };
    if !ready {
        let message = reason();
        return CapabilityProbe {
            ready: false,
            overlay_ok: false,
            overlay_usable,
            reason: message,
        };
    }
    // 代理在：让它重新实测一次 overlay（不缓存，与「每次反映当前状态」同一口径）
    //
    // `probeOverlay` 的应答可能是 `{op:"ok"}` 或 `{op:"error", message:"..."}`。两种都要
    // 把**代理给出的原因**透出去：静默把 error 当成「不可用」会让 reason 变成空串，界面
    // 就失去了「为什么勾选框不出现」的解释（`docs/architecture/principles.md` 第 1 节：
    // 不静默降级）。
    let overlay_ok = match with_connection(|conn| {
        let mut reader = BufReader::new(
            conn.stream
                .try_clone()
                .map_err(|error| format!("复制代理连接失败（{error}）"))?,
        );
        request(&conn.stream, &mut reader, "probeOverlay")
    }) {
        Ok(reply) => {
            if reply["op"].as_str() == Some("ok") {
                true
            } else {
                let message = reply["message"]
                    .as_str()
                    .unwrap_or("代理的 probeOverlay 应答既不是 ok 也没有 message");
                set_reason(format!("挂载代理 overlay 实测不成立：{message}"));
                false
            }
        }
        Err(re) => {
            set_reason(format!("代理 overlay 实测请求失败：{re}"));
            false
        }
    };
    CapabilityProbe {
        ready: true,
        overlay_ok,
        overlay_usable,
        reason: if overlay_ok { String::new() } else { reason() },
    }
}

/// 确保连接可用（必要时拉起代理）。
fn ensure_connected() -> Result<(), String> {
    let mut guard = connection()
        .lock()
        .map_err(|error| format!("代理连接表损坏（{error}）"))?;
    if guard.is_some() {
        return Ok(());
    }
    let proxy = locate()?;
    let spawned = spawn(&proxy)?;
    *guard = Some(spawned);
    Ok(())
}

/// 在持有连接的情况下执行一个操作。
fn with_connection<T>(f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    let mut guard = connection()
        .lock()
        .map_err(|error| format!("代理连接表损坏（{error}）"))?;
    let conn = guard
        .as_mut()
        .ok_or_else(|| "挂载代理尚未拉起".to_string())?;
    f(conn)
}

/// 向代理发一条请求（供挂载侧使用）。
pub fn call(op: &str, fields: Vec<(&str, serde_json::Value)>) -> Result<serde_json::Value, String> {
    with_connection(|conn| {
        let mut payload = serde_json::Map::new();
        payload.insert("op".to_string(), serde_json::Value::String(op.to_string()));
        for (key, value) in fields {
            payload.insert(key.to_string(), value);
        }
        let text = serde_json::Value::Object(payload).to_string();
        let frame = format!("{:08x}\n{}", text.len(), text);
        conn.stream
            .write_all(frame.as_bytes())
            .map_err(|error| format!("向代理发送 {op} 失败（{error}）"))?;
        conn.stream
            .flush()
            .map_err(|error| format!("刷新代理连接失败（{error}）"))?;
        read_reply(&mut conn.reader, op)
    })
}

/// 结束代理连接（Core 退出时调用）。
///
/// 丢弃连接 = 关闭 socketpair = 代理读到 EOF 自行退出（FR-007b 的回收主路径）。
pub fn shutdown() {
    if let Ok(mut guard) = connection().lock() {
        *guard = None;
    }
}

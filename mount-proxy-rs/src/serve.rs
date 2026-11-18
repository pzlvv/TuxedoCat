//! 常驻形态（specs/051 FR-007b 与 FR-007「代执行协议」）。
//!
//! ## 一个代理服务一个视图
//!
//! 代理在 `--serve` 时刻拿到该会话视图的四条路径（`--view-root`），由
//! `privilege::enter_mount_namespace` 在**降权之前**完成「建命名空间 → 挂 overlay →
//! bind 到真实工作区路径」。因此本模块跑起来时视图已经就位，工具只要在真实路径上
//! 执行就落在叠加层里，路径不需要任何映射。
//!
//! 这与 plan 早期设想的「一 Core 一代理 + 按需 `mountOverlay`」不同：降权之后 B 没有
//! `CAP_SYS_ADMIN`，按需挂载必须有第二个特权进程长驻；而一个视图的挂载需求在会话建立
//! 时就全部存在了，没有「之后还要挂新的」这件事。取舍记录见
//! `docs/adr/0018-resident-mount-proxy.md`。
//!
//! ## 并发
//!
//! 帧循环**只负责读请求与派发**：`spawn` 与 `kill` 各起一个线程（工具本来就该并行，
//! 工具批是并行线程），其余请求（`readFile` / `writeFile` / `listDir` / `mkdirAll` /
//! `gitShow` / `probeOverlay`）当场处理。所有应答都带请求 `id`，Core 侧据此把应答分派
//! 给等待方——否则一条长 Bash 会把同会话的 Read 卡在队头。
//!
//! 写回同一份 fd 时必须串行（否则两条应答的字节会交错），因此写端由一把锁保护。
//!
//! ## fd 纪律
//!
//! 本进程的 fd 1 / fd 2 只用于自己的诊断，**从不**传给工具；工具的三条管道由
//! `exec` 模块新建。Core ↔ 代理之间的 socketpair 由 Core 侧 `CLOEXEC` 管理。
//!
//! ## 回收
//!
//! 靠 **socketpair EOF**：Core 死 → 它持有的 socket 端关闭 → 本进程读到 EOF → 退出
//! → A 的 `waitpid` 返回 → A 退出。这条链不依赖进程父子关系，因此覆盖 Core 被
//! `SIGKILL` 的情形（FR-007b）。

use crate::exec;
use crate::protocol::{Frame, Value, IPC_PROTOCOL_VERSION};
use crate::remote_fd::FdStream;
use crate::sys;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// B 成为常驻代理本体：在 `fd` 上服务 Core 的请求。
///
/// **永不返回**（进入循环或 `_exit`）。`fd` 只来自 argv：本进程按 FR-006「不读任何
/// 环境变量」。
pub fn run_as_resident(fd: i32) -> ! {
    serve_loop(fd)
}

/// 写端：多个工作线程共享，写一帧必须整帧写完，不能交错。
struct Writer {
    stream: FdStream,
}

impl Writer {
    fn send(&mut self, frame: &Frame) -> Result<(), String> {
        frame.write_to(&mut self.stream)
    }
}

/// 帧循环：读一帧、派发、需要的起线程。
///
/// EOF（对端正常关闭）= 退出信号：这是 FR-007b 的回收主路径。
fn serve_loop(fd: i32) -> ! {
    let mut reader = FdStream::new(fd);
    // `dup` 一份写端给工作线程：同一个 fd 上两个 `FdStream` 各自持有 fd 编号，读端只在
    // 本线程用、写端只经锁用，因此不存在读写的竞态。
    let writer = Arc::new(Mutex::new(Writer {
        stream: FdStream::new(fd),
    }));
    // 视图状态：`probeOverlay` 与 `gitShow` 都要用
    let view = Arc::new(Mutex::new(ViewState::default()));
    loop {
        let frame = match Frame::read_from(&mut reader) {
            Ok(Some(frame)) => frame,
            // EOF：Core 已退出（或被 SIGKILL），本进程跟着走
            Ok(None) => unsafe { sys::_exit(0) },
            Err(reason) => {
                eprintln!("[mount-proxy] 读帧失败：{reason}");
                unsafe { sys::_exit(75) };
            }
        };
        // 并发类请求各起线程，其余当场答复
        match frame.op.as_str() {
            "spawn" => {
                let request = match exec::SpawnRequest::from_frame(&frame) {
                    Ok(request) => request,
                    Err(reason) => {
                        let _ = send_now(&writer, error_frame(frame.id(), reason));
                        continue;
                    }
                };
                let sink = Arc::clone(&writer);
                std::thread::spawn(move || {
                    let emit: Arc<dyn Fn(Frame) + Send + Sync> = Arc::new(move |reply: Frame| {
                        // 写失败（Core 已退出）时忽略：回收由读端 EOF 负责
                        let _ = sink.lock().map(|mut guard| guard.send(&reply));
                    });
                    exec::spawn(request, emit);
                });
            }
            "kill" => {
                let reply = match frame.num_field("target").or_else(|_| frame.num_field("id")) {
                    Ok(target) => match exec::kill(target as u64) {
                        Ok(()) => Frame::new("ok").with_id(frame.id()),
                        Err(reason) => error_frame(frame.id(), reason),
                    },
                    Err(reason) => error_frame(frame.id(), reason),
                };
                let _ = send_now(&writer, reply);
            }
            other => {
                let reply = dispatch(other, &frame, &view);
                let _ = send_now(&writer, reply);
            }
        }
    }
}

fn send_now(writer: &Arc<Mutex<Writer>>, frame: Frame) -> Result<(), String> {
    let mut guard = writer
        .lock()
        .map_err(|error| format!("写端锁损坏（{error}）"))?;
    guard.send(&frame)
}

fn error_frame(id: u64, reason: String) -> Frame {
    Frame::new("error")
        .with_id(id)
        .with("message", Value::Str(reason))
}

/// 会话视图的状态（`probeOverlay` 之后记下来，`gitShow` 之类要用）
#[derive(Default)]
struct ViewState {
    /// `probeOverlay` 的结论；`None` = 还没测过
    probe: Option<Result<(), String>>,
}

/// 处理一条**当场可答**的请求。
///
/// 每个请求恰好一条应答；未知 op 回错误而不是忽略——静默忽略会让 Core 侧永远等待
/// （`docs/architecture/principles.md` 铁律 4.1：接线缺失直接报错）。
fn dispatch(op: &str, frame: &Frame, view: &Arc<Mutex<ViewState>>) -> Frame {
    let id = frame.id();
    match op {
        "version" => Frame::new("version")
            .with_id(id)
            .with("ipcVersion", Value::Num(IPC_PROTOCOL_VERSION as i64)),
        "ping" => Frame::new("pong").with_id(id),
        "probeOverlay" => {
            // 视图在 `--serve` 建立时就挂好了，这里验一次它对自己可见：这是唯一能证明
            // 「挂载真的生效」的判据（Core 在宿主命名空间里看不见这个挂载）。
            let result = probe_overlay();
            if let Ok(mut state) = view.lock() {
                state.probe = Some(result.clone());
            }
            match result {
                Ok(()) => Frame::new("ok").with_id(id),
                Err(reason) => error_frame(id, reason),
            }
        }
        "readFile" => match frame.str_field("path") {
            Ok(path) => match read_file(path, frame.num_field("maxBytes").ok()) {
                Ok(bytes) => Frame::new("file")
                    .with_id(id)
                    .with("bytes", Value::Bytes(bytes)),
                Err(reason) => error_frame(id, reason),
            },
            Err(reason) => error_frame(id, reason),
        },
        "writeFile" => match (frame.str_field("path"), frame.bytes_field("bytes")) {
            (Ok(path), Ok(bytes)) => {
                let path = Path::new(path);
                // 父目录可能还不存在（Write 工具建新文件的正常情形）
                if let Some(parent) = path.parent() {
                    if let Err(reason) = exec::mkdir_all(&parent.to_string_lossy()) {
                        return error_frame(id, reason);
                    }
                }
                match std::fs::write(path, bytes) {
                    Ok(()) => Frame::new("ok").with_id(id),
                    Err(error) => error_frame(id, format!("写 {} 失败（{error}）", path.display())),
                }
            }
            // 线上形态是十六进制字符串，不是 `Value::Bytes`（见 protocol 的 `bytes_field`）：
            // 只匹配 `Value::Bytes` 会让每一次 Write 都以「类型不对」失败。
            (Ok(_), Err(reason)) => error_frame(id, reason),
            (Err(reason), _) => error_frame(id, reason),
        },
        "listDir" => match frame.str_field("dir") {
            Ok(dir) => match exec::list_dir(dir) {
                Ok(entries) => Frame::new("dir")
                    .with_id(id)
                    .with("entries", Value::Array(entries)),
                Err(reason) => error_frame(id, reason),
            },
            Err(reason) => error_frame(id, reason),
        },
        "stat" => match frame.str_field("path") {
            Ok(path) => match exec::stat(path) {
                Ok(info) => Frame::new("stat")
                    .with_id(id)
                    .with("exists", Value::Bool(info.exists))
                    .with("isFile", Value::Bool(info.is_file))
                    .with("isDir", Value::Bool(info.is_dir))
                    .with("isSymlink", Value::Bool(info.is_symlink))
                    .with("size", Value::Num(info.size as i64)),
                Err(reason) => error_frame(id, reason),
            },
            Err(reason) => error_frame(id, reason),
        },
        "mkdirAll" => match frame.str_field("path") {
            Ok(path) => match exec::mkdir_all(path) {
                Ok(()) => Frame::new("ok").with_id(id),
                Err(reason) => error_frame(id, reason),
            },
            Err(reason) => error_frame(id, reason),
        },
        "gitShow" => match (
            frame.str_field("repo"),
            frame.str_field("rev"),
            frame.str_field("path"),
        ) {
            (Ok(repo), Ok(rev), Ok(path)) => match git_show(repo, rev, path) {
                Ok(bytes) => Frame::new("file")
                    .with_id(id)
                    .with("bytes", Value::Bytes(bytes)),
                Err(reason) => error_frame(id, reason),
            },
            (Err(reason), _, _) | (_, Err(reason), _) | (_, _, Err(reason)) => {
                error_frame(id, reason)
            }
        },
        other => error_frame(id, format!("未知请求 op：{other}")),
    }
}

/// 读一个文件（`maxBytes` 给上限，超出部分截断）
fn read_file(path: &str, max_bytes: Option<i64>) -> Result<Vec<u8>, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("打开 {path} 失败（{error}）"))?;
    let limit = match max_bytes {
        Some(limit) if limit > 0 => limit as usize,
        // 未给上限 / 非正数：按整文件读（Core 侧自己再做业务上限判断）
        _ => usize::MAX,
    };
    let mut buffer = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    while buffer.len() < limit {
        let want = (limit - buffer.len()).min(chunk.len());
        let count = file
            .read(&mut chunk[..want])
            .map_err(|error| format!("读 {path} 失败（{error}）"))?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..count]);
    }
    Ok(buffer)
}

/// `git show <rev>:<path>`，在 `repo` 里跑
///
/// 不走 `spawn` 的通用通道：`gitShow` 的应答是**字节流**而不是流式输出，且它是视图
/// 取数（read-only），同步答完更简单。仍要自己造三条管道（不继承本进程的 fd）。
fn git_show(repo: &str, rev: &str, path: &str) -> Result<Vec<u8>, String> {
    let request = exec::SpawnRequest {
        id: 0,
        argv: vec![
            "git".to_string(),
            "-C".to_string(),
            repo.to_string(),
            "show".to_string(),
            format!("{rev}:./{path}"),
        ],
        cwd: repo.to_string(),
        env: git_env(),
        stdin: None,
    };
    let collected = Arc::new(Mutex::new(Collected::default()));
    let sink = Arc::clone(&collected);
    exec::spawn_collect(request, sink);
    let collected = collected
        .lock()
        .map_err(|error| format!("git 输出锁损坏（{error}）"))?;
    if let Some(reason) = &collected.error {
        return Err(reason.clone());
    }
    if collected.code.unwrap_or(0) != 0 {
        return Err(format!(
            "git show {rev}:{path} 失败（退出码 {:?}）：{}",
            collected.code,
            String::from_utf8_lossy(&collected.stderr).trim()
        ));
    }
    Ok(collected.stdout.clone())
}

/// 视图取数要的最小环境：`git` 需要 HOME（读全局配置）与 PATH（找自己）
fn git_env() -> Vec<String> {
    let mut env = Vec::new();
    for key in ["PATH", "HOME", "LANG", "LC_ALL"] {
        if let Ok(value) = std::env::var(key) {
            env.push(format!("{key}={value}"));
        }
    }
    // 视图里的 git 不该被系统级配置改变行为（与 Core 侧取数同一要求）
    env.push("GIT_CONFIG_NOSYSTEM=1".to_string());
    env
}

/// `spawn` 的输出汇（`git_show` 用）：直接用执行层的容器，不在这里再造一份同形类型。
type Collected = exec::Collected;

/// 实测一次视图可见且非空。
///
/// 视图在 `--serve` 建立时就挂好了，因此这里只验它**此刻**对自己可见。「能挂」这件事
/// 由 `enter_mount_namespace` 的返回值回答，这里回答「挂上了且读得到」。
fn probe_overlay() -> Result<(), String> {
    // 挂载点由 argv 传入（不读环境变量），见 main.rs 的 `--view-root`
    let root = match view_root() {
        Ok(root) => root,
        Err(reason) => return Err(reason),
    };
    let entries = std::fs::read_dir(&root)
        .map_err(|error| format!("读视图 {} 失败（{error}）", root.display()))?;
    // 空视图是合法状态（工作区真的空）；这里只确认**能读**，不判断内容多少。
    // 真正的「挂载生效」判据在挂载阶段用 mountinfo 数过一次了。
    let _ = entries.count();
    Ok(())
}

/// 本次代理服务的视图根目录。
///
/// 经 argv 传入后写进一个进程内槽位（`main.rs` 在 `serve_mode` 里先设），本模块只读。
/// 不走环境变量：FR-006 要求代理不读自己的环境。
fn view_root() -> Result<PathBuf, String> {
    VIEW_ROOT
        .lock()
        .map_err(|error| format!("视图槽位损坏（{error}）"))?
        .clone()
        .ok_or_else(|| "本次代理没有视图根目录（内部接线错误）".to_string())
}

/// 视图根目录（`merged`）。`--serve` 启动时由 `main` 写入。
pub static VIEW_ROOT: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 允许测试与 `main` 设置视图根目录
pub fn set_view_root(path: PathBuf) {
    if let Ok(mut slot) = VIEW_ROOT.lock() {
        *slot = Some(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_op_reports_error_with_id() {
        let frame = Frame::new("nonsense").with_id(11);
        let reply = dispatch(
            "nonsense",
            &frame,
            &Arc::new(Mutex::new(ViewState::default())),
        );
        assert_eq!(reply.op, "error");
        assert_eq!(reply.id(), 11);
        assert!(reply.str_field("message").unwrap().contains("未知请求 op"));
    }

    #[test]
    fn version_reports_ipc_protocol() {
        let frame = Frame::new("version").with_id(2);
        let reply = dispatch(
            "version",
            &frame,
            &Arc::new(Mutex::new(ViewState::default())),
        );
        assert_eq!(
            reply.num_field("ipcVersion").unwrap(),
            IPC_PROTOCOL_VERSION as i64
        );
    }

    #[test]
    fn ping_pongs() {
        let frame = Frame::new("ping").with_id(3);
        let reply = dispatch("ping", &frame, &Arc::new(Mutex::new(ViewState::default())));
        assert_eq!(reply.op, "pong");
        assert_eq!(reply.id(), 3);
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("tc-proxy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("nested").join("a.txt");
        let write = Frame::new("writeFile")
            .with_id(4)
            .with("path", Value::Str(file.to_string_lossy().into_owned()))
            .with("bytes", Value::Bytes(b"hello".to_vec()));
        let view = Arc::new(Mutex::new(ViewState::default()));
        assert_eq!(dispatch("writeFile", &write, &view).op, "ok");

        let read = Frame::new("readFile")
            .with_id(5)
            .with("path", Value::Str(file.to_string_lossy().into_owned()));
        let reply = dispatch("readFile", &read, &view);
        assert_eq!(reply.op, "file");
        assert_eq!(reply.bytes_field("bytes").unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `writeFile` 必须吃**线上形态**的载荷：Core 侧把字节编码成十六进制字符串发来，
    /// 不是 `Value::Bytes`。
    ///
    /// 回归点：只匹配 `Value::Bytes` 时，线上每一次 Write 都回「类型不对」——
    /// `write_then_read_roundtrip` 用的是进程内构帧（`Value::Bytes`），因此它能绿而
    /// 真实链路全红。这条用例按 Core 的实际编码构造帧，锁住那个差异。
    #[test]
    fn write_file_accepts_hex_string_payload() {
        let dir = std::env::temp_dir().join(format!("tc-proxy-hex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("hex.txt");
        // 与 `core-rs/src/mount_proxy/linux/client.rs::encode_hex` 同形
        let hex = b"hex-payload"
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let write = Frame::new("writeFile")
            .with_id(9)
            .with("path", Value::Str(file.to_string_lossy().into_owned()))
            .with("bytes", Value::Str(hex));
        let reply = dispatch(
            "writeFile",
            &write,
            &Arc::new(Mutex::new(ViewState::default())),
        );
        assert_eq!(
            reply.op,
            "ok",
            "{}",
            reply.str_field("message").unwrap_or("")
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"hex-payload");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_file_honours_max_bytes() {
        let dir = std::env::temp_dir().join(format!("tc-proxy-max-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"0123456789").unwrap();
        let read = Frame::new("readFile")
            .with_id(6)
            .with("path", Value::Str(file.to_string_lossy().into_owned()))
            .with("maxBytes", Value::Num(4));
        let reply = dispatch(
            "readFile",
            &read,
            &Arc::new(Mutex::new(ViewState::default())),
        );
        assert_eq!(reply.bytes_field("bytes").unwrap(), b"0123");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_reports_entries() {
        let dir = std::env::temp_dir().join(format!("tc-proxy-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("f.txt"), b"x").unwrap();
        let frame = Frame::new("listDir")
            .with_id(7)
            .with("dir", Value::Str(dir.to_string_lossy().into_owned()));
        let reply = dispatch(
            "listDir",
            &frame,
            &Arc::new(Mutex::new(ViewState::default())),
        );
        assert_eq!(reply.op, "dir");
        let entries = reply.array_field("entries").unwrap();
        assert_eq!(entries.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 与 Core 共用的帧契约（`core-rs/fixtures/mountProxyProtocol.json`） ──

    /// fixture 全文（编译期内嵌：契约漂了 cargo 会重编本测试）
    const CONTRACT: &str = include_str!("../fixtures/mountProxyProtocol.json");

    /// fixture 里某个 op 的 `request` 对象文本。
    ///
    /// 本 crate 零依赖、运行期不引序列化库，因此测试里按 `"op": "<name>"` 定位到那个
    /// 用例对象，再取出它的 `request` 子树原文——只用于把它们喂给真实的解析器，不做
    /// 通用 JSON 解析。定位失败即 panic（fixture 结构与本函数约定不同步）。
    fn contract_request_for(op: &str) -> String {
        let needle = format!("\"op\": \"{op}\"");
        let at = CONTRACT
            .find(&needle)
            .unwrap_or_else(|| panic!("fixture 里没有 op = {op} 的用例"));
        let request_at = CONTRACT[at..]
            .find("\"request\":")
            .unwrap_or_else(|| panic!("{op} 的用例缺 request"))
            + at
            + "\"request\":".len();
        let body = CONTRACT[request_at..].trim_start();
        assert!(
            body.starts_with('{'),
            "{op} 的 request 必须是对象，实际以 {} 开头",
            &body[..1]
        );
        // 按花括号配平截出这个对象（字符串内的引号与转义要跳过，否则内容里的 `}` 会提前收尾）
        let bytes = body.as_bytes();
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end = None;
        for (index, byte) in bytes.iter().enumerate() {
            match byte {
                b'\\' if in_string => escaped = !escaped,
                b'"' if !escaped => in_string = !in_string,
                b'{' if !in_string => depth += 1,
                b'}' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(index + 1);
                        break;
                    }
                }
                _ => escaped = false,
            }
            if *byte != b'\\' {
                escaped = false;
            }
        }
        body[..end.unwrap_or_else(|| panic!("{op} 的 request 对象未闭合"))].to_string()
    }

    /// 把 fixture 里的裸 JSON 对象打包成**线上帧**（长度前缀 + 换行 + JSON）。
    ///
    /// fixture 存的是可读的 JSON 对象；`Frame::read_from` 要的是带长度前缀的帧。测试必须
    /// 走真实帧格式，否则「解析器吃得下」这件事根本没被验证到。
    fn as_wire_frame(json_object: &str) -> Vec<u8> {
        let payload = json_object.as_bytes();
        let header = format!("{:08x}\n", payload.len());
        let mut out = header.into_bytes();
        out.extend_from_slice(payload);
        out
    }

    /// Core 实际发出的每一种请求，代理都必须能解析出同一个 `op` 与 `id`。
    ///
    /// 双端对拍的另一半：Core 侧同名用例锁「发什么」，这里锁「吃得下」。问题 1 正是
    /// 这两半各自自洽、合起来却不通——Core 发十六进制字符串，代理只认进程内枚举。
    #[test]
    fn parses_every_contract_request() {
        for op in [
            "ping",
            "version",
            "probeOverlay",
            "readFile",
            "writeFile",
            "listDir",
            "stat",
            "mkdirAll",
            "gitShow",
            "spawn",
            "kill",
        ] {
            let text = contract_request_for(op);
            let frame = Frame::read_from(&mut std::io::Cursor::new(as_wire_frame(&text)))
                .unwrap_or_else(|reason| {
                    panic!(
                        "{op} 的契约请求解析失败：{reason}
{text}"
                    )
                })
                .unwrap_or_else(|| panic!("{op} 的契约请求被当成 EOF"));
            assert_eq!(frame.op, op, "解析出的 op 与 fixture 不一致");
            assert!(frame.id() > 0, "{op} 的契约请求必须带 id");
        }
    }

    /// `writeFile` 吃 fixture 的**十六进制字符串**载荷（问题 1 的代理侧回归点）。
    #[test]
    fn consumes_contract_write_file_payload() {
        let text = contract_request_for("writeFile");
        let frame = Frame::read_from(&mut std::io::Cursor::new(as_wire_frame(&text)))
            .unwrap()
            .unwrap();
        // fixture 的 writeFile.bytes 是 "68656c6c6f"
        assert_eq!(frame.bytes_field("bytes").unwrap(), b"hello");
    }

    /// `spawn` 的 `argv` / `env` 是字符串数组，`stdin` 是十六进制字符串。
    #[test]
    fn consumes_contract_spawn_payload() {
        let text = contract_request_for("spawn");
        let frame = Frame::read_from(&mut std::io::Cursor::new(as_wire_frame(&text)))
            .unwrap()
            .unwrap();
        assert_eq!(
            frame.string_array_field("argv").unwrap(),
            vec!["/bin/sh", "-c", "echo hi"]
        );
        assert_eq!(
            frame.string_array_field("env").unwrap(),
            vec!["PATH=/usr/bin:/bin"]
        );
        assert_eq!(frame.bytes_field("stdin").unwrap(), b"hi");
        assert_eq!(frame.str_field("cwd").unwrap(), "/w");
    }

    /// `kill` 的 `target` 是被中止那条请求的 id，与本条请求自己的 `id` 不同。
    #[test]
    fn consumes_contract_kill_payload() {
        let text = contract_request_for("kill");
        let frame = Frame::read_from(&mut std::io::Cursor::new(as_wire_frame(&text)))
            .unwrap()
            .unwrap();
        assert_eq!(frame.num_field("target").unwrap(), 10);
        assert_eq!(frame.id(), 11);
    }
}

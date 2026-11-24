//! 常驻挂载代理的客户端（specs/051 FR-007 / FR-007b / FR-010）。
//!
//! ## 一个隔离会话一个代理
//!
//! 每个隔离会话拉起一个代理进程：它在**降权之前**建好该会话的挂载命名空间、挂上 overlay、
//! 把视图 bind 到真实工作区路径上（`mount-proxy-rs/src/privilege.rs`）。因此：
//!
//! - Core 侧的路径字符串**不需要任何映射**：工具看到的真实路径就是叠加结果，代执行时把
//!   同一个路径原样发给代理即可；
//! - 也没有「之后还要挂新东西」的需求，代理不再需要第二个特权进程常驻。
//!
//! 会话关闭 → 丢弃 `SessionProxy` → socketpair 关闭 → 代理读到 EOF 自行退出 → 它的父进程
//! `waitpid` 返回（FR-007b 的回收主路径，不依赖信号）。
//!
//! ## 并发与 `id` 关联
//!
//! 工具批本身就是并行线程，因此协议里每个请求带 `id`，应答按 `id` 回到等待它的那一方
//! （plan 的「并发与队头阻塞」）。本模块：读线程独占读端并把应答派发到 pending 表，
//! 每个在途请求在表里有一条记录。没有它，一条长 Bash 会把同会话的 Read 卡在队头。
//!
//! ## 失败只降能力，不带走 Core
//!
//! 代理缺失 / 版本不匹配 / 自检失败 / 命名空间建立失败，任一情形都只让该会话的工具调用
//! 报错、能力回 `absent`：Core 照常服务帧通道，daemon 不观察到退出（ADR-0018）。

use crate::mount_proxy::{PROXY_DIR, PROXY_NAME};

use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// 本模块与 `mount-proxy-rs/src/protocol.rs` 共享的运行期协议版本。
///
/// 与「安装握手版本」（`TC_PROTOCOL_VERSION`）分开：前者是帧语义兼容性，后者是「装的
/// 这份代理能不能被这个 Core 用」。两者任一不匹配都不启用能力。
pub const IPC_PROTOCOL_VERSION: u32 = 1;

/// 单帧长度上限：8 MiB（与代理侧同值）
const MAX_FRAME: usize = 8 * 1024 * 1024;

/// 单条工具输出帧的上限：代理按 64 KiB 分块发，这里留一倍余量
const MAX_CHUNK: usize = 256 * 1024;

// ───────────────────────── 帧编解码 ─────────────────────────

/// 一条协议帧（`{ "op": "...", "id": n, ...字段 }`）
#[derive(Clone, Debug)]
struct Frame {
    op: String,
    fields: serde_json::Map<String, serde_json::Value>,
}

impl Frame {
    fn new(op: &str) -> Self {
        Self {
            op: op.to_string(),
            fields: serde_json::Map::new(),
        }
    }

    fn with_id(mut self, id: u64) -> Self {
        self.fields
            .insert("id".to_string(), serde_json::Value::from(id));
        self
    }

    fn with(mut self, key: &str, value: serde_json::Value) -> Self {
        self.fields.insert(key.to_string(), value);
        self
    }

    fn id(&self) -> u64 {
        self.fields
            .get("id")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    }

    fn str_field(&self, key: &str) -> Result<&str, String> {
        self.fields
            .get(key)
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| format!("应答缺字符串字段 {key}"))
    }

    fn encode(&self) -> Vec<u8> {
        let mut object = serde_json::Map::new();
        object.insert("op".to_string(), serde_json::Value::String(self.op.clone()));
        for (key, value) in &self.fields {
            object.insert(key.clone(), value.clone());
        }
        let payload = serde_json::Value::Object(object).to_string();
        let mut out = format!("{:08x}\n", payload.len()).into_bytes();
        out.extend_from_slice(payload.as_bytes());
        out
    }

    /// 读一帧；`Ok(None)` = 干净 EOF
    fn read_from(reader: &mut impl Read) -> Result<Option<Self>, String> {
        let mut header = [0u8; 9];
        match reader.read_exact(&mut header) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(format!("读帧头失败（{error}）")),
        }
        if header[8] != b'\n' {
            return Err("帧头缺换行终止符".to_string());
        }
        let len_text = std::str::from_utf8(&header[..8]).map_err(|_| "帧头不是 ASCII")?;
        let len = usize::from_str_radix(len_text.trim(), 16)
            .map_err(|_| "帧头不是十六进制".to_string())?;
        if len > MAX_FRAME {
            return Err(format!("帧长 {len} 超过上限 {MAX_FRAME}"));
        }
        let mut payload = vec![0u8; len];
        reader
            .read_exact(&mut payload)
            .map_err(|error| format!("读帧载荷失败（{error}）"))?;
        let value: serde_json::Value = serde_json::from_slice(&payload)
            .map_err(|error| format!("帧不是合法 JSON（{error}）"))?;
        let op = value
            .get("op")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "帧没有 op 字段".to_string())?
            .to_string();
        let fields = value.as_object().cloned().unwrap_or_default();
        Ok(Some(Self { op, fields }))
    }
}

// ───────────────────────── 会话代理 ─────────────────────────

/// 一条在途请求的应答累积区（两种形态共用）。
#[derive(Default)]
struct PendingReply {
    /// `spawn` 的 stdout 累积
    stdout: Vec<u8>,
    /// `spawn` 的 stderr 累积
    stderr: Vec<u8>,
    /// `Some(code)` = 该请求已收尾（`spawn` 收到 `exit`，一次性 op 收到应答）
    exit: Option<i32>,
    /// 代理给的错误（启动失败 / 该 op 不支持 …）
    error: Option<String>,
    /// 一次性 op 的整帧应答（`spawn` 流式应答不用它）
    frame: Option<Frame>,
}

/// 一个隔离会话的常驻代理。
///
/// 内部结构：读线程独占读端、把每条应答按 `id` 送进 pending 表；写端由一把锁串行化
/// （两条应答的字节不能交错，但两条**请求**可以同时在途）。
pub struct SessionProxy {
    session_id: String,
    child: Mutex<Child>,
    writer: Mutex<UnixStream>,
    state: Arc<(Mutex<ProxyState>, Condvar)>,
    next_id: AtomicU64,
    /// 视图的挂载点（诊断与文档用；代执行不需要它）
    merged: PathBuf,
}

#[derive(Default)]
struct ProxyState {
    pending: HashMap<u64, PendingReply>,
    /// 读到 EOF / 出错后置位：此后所有请求立即失败，不再等待
    dead: Option<String>,
}

impl SessionProxy {
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn mount_point(&self) -> &Path {
        &self.merged
    }

    /// 本进程是否还活着（代理被杀 / 崩溃后为 false，能力据此改判 absent）
    pub fn is_alive(&self) -> bool {
        let dead = self
            .state
            .0
            .lock()
            .map(|state| state.dead.is_some())
            .unwrap_or(true);
        if dead {
            return false;
        }
        // 读线程还没看到 EOF，但进程可能已退出：`try_wait` 是更早的事实
        match self.child.lock() {
            Ok(mut child) => !matches!(child.try_wait(), Ok(Some(_))),
            Err(_) => false,
        }
    }

    fn allocate_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 发一条请求并在 pending 表里登记
    fn request(
        &self,
        op: &str,
        id: u64,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        {
            let mut state = self
                .state
                .0
                .lock()
                .map_err(|error| format!("代理状态表损坏（{error}）"))?;
            if let Some(reason) = &state.dead {
                return Err(format!("挂载代理已退出：{reason}"));
            }
            state.pending.insert(id, PendingReply::default());
        }
        let mut frame = Frame::new(op).with_id(id);
        frame.fields.extend(fields);
        let encoded = frame.encode();
        let mut writer = self
            .writer
            .lock()
            .map_err(|error| format!("代理写端损坏（{error}）"))?;
        writer
            .write_all(&encoded)
            .map_err(|error| format!("向代理发送 {op} 失败（{error}）"))?;
        writer
            .flush()
            .map_err(|error| format!("刷新代理连接失败（{error}）"))
    }

    /// 等某条请求收尾（`exit` 到达或超时）
    fn wait_reply(&self, id: u64, timeout: Duration) -> Result<PendingReply, String> {
        let deadline = std::time::Instant::now() + timeout;
        let (lock, cvar) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|error| format!("代理状态表损坏（{error}）"))?;
        loop {
            if let Some(reply) = state.pending.get(&id) {
                if let Some(error) = &reply.error {
                    let error = error.clone();
                    state.pending.remove(&id);
                    return Err(error);
                }
                if reply.exit.is_some() {
                    let taken = state.pending.remove(&id).unwrap_or_default();
                    return Ok(taken);
                }
            } else {
                return Err(format!("请求 {id} 不在 pending 表里"));
            }
            if let Some(reason) = &state.dead {
                return Err(format!("挂载代理已退出：{reason}"));
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                drop(state);
                // 超时后把这条请求从表里摘掉并杀掉对应工具，避免迟到的应答留在表里
                let _ = self.kill(id);
                if let Ok(mut state) = lock.lock() {
                    state.pending.remove(&id);
                }
                return Err(format!("等待 {id} 应答超时（{}ms）", timeout.as_millis()));
            }
            let (guard, _) = cvar
                .wait_timeout(state, deadline - now)
                .map_err(|error| format!("代理状态表损坏（{error}）"))?;
            state = guard;
        }
    }

    /// 一次性请求-应答（`readFile` / `writeFile` / `listDir` / `mkdirAll` / `ping` 等）
    fn call(
        &self,
        op: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) -> Result<Frame, String> {
        let id = self.allocate_id();
        self.request(op, id, fields)?;
        // 一次性 op 的应答只有一帧，`wait_reply` 需要「收到任何应答」就算完成。
        // 用一个很短的轮询：这些 op 都是同步答完的，不需要流式累积。
        let deadline = std::time::Instant::now() + CALL_TIMEOUT;
        let (lock, cvar) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|error| format!("代理状态表损坏（{error}）"))?;
        loop {
            if let Some(slot) = state.pending.get(&id) {
                if let Some(error) = &slot.error {
                    let error = error.clone();
                    state.pending.remove(&id);
                    return Err(error);
                }
                if slot.exit.is_some() {
                    let taken = state.pending.remove(&id).unwrap_or_default();
                    return taken
                        .frame
                        .ok_or_else(|| format!("{op} 的应答丢失（内部错误）"));
                }
            } else {
                return Err(format!("请求 {id} 不在 pending 表里"));
            }
            if let Some(reason) = &state.dead {
                return Err(format!("挂载代理已退出：{reason}"));
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                state.pending.remove(&id);
                return Err(format!("等待 {op} 应答超时"));
            }
            let (guard, _) = cvar
                .wait_timeout(state, deadline - now)
                .map_err(|error| format!("代理状态表损坏（{error}）"))?;
            state = guard;
        }
    }

    // ── 工具侧要用的原语 ──

    /// 读一个文件（`maxBytes` 为上限，超出截断）
    pub fn read_file(&self, path: &Path, max_bytes: Option<u64>) -> Result<Vec<u8>, String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        if let Some(limit) = max_bytes {
            fields.insert("maxBytes".to_string(), serde_json::Value::from(limit));
        }
        let reply = self.call("readFile", fields)?;
        let hex = reply.str_field("bytes")?;
        decode_hex(hex)
    }

    /// 写一个文件
    pub fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        fields.insert(
            "bytes".to_string(),
            serde_json::Value::String(encode_hex(bytes)),
        );
        let reply = self.call("writeFile", fields)?;
        if reply.op == "ok" {
            Ok(())
        } else {
            Err(format!("writeFile 回了 {}", reply.op))
        }
    }

    /// 定向写（specs/056 FR-003）：从 `offset` 写，并把文件截断在写入末尾。
    /// 返回写入后的文件长度。
    pub fn write_range(&self, path: &Path, offset: u64, bytes: &[u8]) -> Result<u64, String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        fields.insert(
            "bytes".to_string(),
            serde_json::Value::String(encode_hex(bytes)),
        );
        fields.insert("offset".to_string(), serde_json::Value::from(offset));
        let reply = self.call("writeFile", fields)?;
        reply
            .fields
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "writeFile 应答缺 size".to_string())
    }

    /// 定向读（specs/056 FR-002）：返回 `(bytes, eof)`，`eof` 由实读字节数判定。
    pub fn read_range(
        &self,
        path: &Path,
        offset: u64,
        length: u64,
    ) -> Result<(Vec<u8>, bool), String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        fields.insert("offset".to_string(), serde_json::Value::from(offset));
        fields.insert("length".to_string(), serde_json::Value::from(length));
        let reply = self.call("readRange", fields)?;
        let bytes = decode_hex(reply.str_field("bytes")?)?;
        let eof = reply
            .fields
            .get("eof")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| "readRange 应答缺 eof".to_string())?;
        Ok((bytes, eof))
    }

    /// 改名（specs/056 FR-003）：目标已存在时按覆盖语义处理。
    pub fn rename_path(&self, from: &Path, to: &Path) -> Result<(), String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "from".to_string(),
            serde_json::Value::String(from.to_string_lossy().into_owned()),
        );
        fields.insert(
            "to".to_string(),
            serde_json::Value::String(to.to_string_lossy().into_owned()),
        );
        let reply = self.call("renamePath", fields)?;
        if reply.op == "ok" {
            Ok(())
        } else {
            Err(format!("renamePath 回了 {}", reply.op))
        }
    }

    /// 删一个文件（specs/056 FR-003）：用于清理传输的暂存件，目标不存在算成功。
    pub fn unlink_path(&self, path: &Path) -> Result<(), String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        let reply = self.call("unlinkPath", fields)?;
        if reply.op == "ok" {
            Ok(())
        } else {
            Err(format!("unlinkPath 回了 {}", reply.op))
        }
    }

    /// 递归建目录
    pub fn mkdir_all(&self, path: &Path) -> Result<(), String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        let reply = self.call("mkdirAll", fields)?;
        if reply.op == "ok" {
            Ok(())
        } else {
            Err(format!("mkdirAll 回了 {}", reply.op))
        }
    }

    /// 路径的事实（存在 / 类型 / 大小）
    pub fn stat(&self, path: &Path) -> Result<super::PathFacts, String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        let reply = self.call("stat", fields)?;
        Ok(super::PathFacts {
            exists: reply
                .fields
                .get("exists")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            is_file: reply
                .fields
                .get("isFile")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            is_dir: reply
                .fields
                .get("isDir")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            is_symlink: reply
                .fields
                .get("isSymlink")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            size: reply
                .fields
                .get("size")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        })
    }

    /// 列目录：`[(name, isDir)]`
    pub fn list_dir(&self, path: &Path) -> Result<Vec<(String, bool)>, String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "dir".to_string(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        let reply = self.call("listDir", fields)?;
        let entries = reply
            .fields
            .get("entries")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| "listDir 应答缺 entries".to_string())?;
        let mut out = Vec::new();
        for entry in entries {
            let name = entry
                .get("name")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| "目录项缺 name".to_string())?
                .to_string();
            let is_dir = entry
                .get("isDir")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            out.push((name, is_dir));
        }
        Ok(out)
    }

    /// `git show`：拿到某个 rev 下某文件的字节内容
    pub fn git_show(&self, repo: &Path, rev: &str, path: &str) -> Result<Vec<u8>, String> {
        let mut fields = serde_json::Map::new();
        fields.insert(
            "repo".to_string(),
            serde_json::Value::String(repo.to_string_lossy().into_owned()),
        );
        fields.insert(
            "rev".to_string(),
            serde_json::Value::String(rev.to_string()),
        );
        fields.insert(
            "path".to_string(),
            serde_json::Value::String(path.to_string()),
        );
        let reply = self.call("gitShow", fields)?;
        decode_hex(reply.str_field("bytes")?)
    }

    /// 发一条 `spawn` 请求，返回请求 id（后续用 `wait_spawn` 收输出）
    pub fn start_spawn(&self, request: SpawnSpec) -> Result<u64, String> {
        let id = self.allocate_id();
        let mut fields = serde_json::Map::new();
        fields.insert(
            "argv".to_string(),
            serde_json::Value::Array(
                request
                    .argv
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            ),
        );
        fields.insert(
            "cwd".to_string(),
            serde_json::Value::String(request.cwd.to_string_lossy().into_owned()),
        );
        fields.insert(
            "env".to_string(),
            serde_json::Value::Array(
                request
                    .env
                    .iter()
                    .map(|item| serde_json::Value::String(item.clone()))
                    .collect(),
            ),
        );
        if let Some(stdin) = &request.stdin {
            fields.insert(
                "stdin".to_string(),
                serde_json::Value::String(encode_hex(stdin)),
            );
        }
        self.request("spawn", id, fields)?;
        Ok(id)
    }

    /// 等一条 `spawn` 收尾，按到达顺序把输出喂给 `on_chunk`
    pub fn wait_spawn(
        &self,
        id: u64,
        timeout: Duration,
        cancel: Option<&std::sync::atomic::AtomicBool>,
        mut on_chunk: impl FnMut(&[u8], &[u8]),
    ) -> Result<SpawnOutcome, String> {
        let deadline = std::time::Instant::now() + timeout;
        let (lock, cvar) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|error| format!("代理状态表损坏（{error}）"))?;
        let mut stdout_seen = 0usize;
        let mut stderr_seen = 0usize;
        loop {
            // 已到达但还没交给调用方的字节
            if let Some(slot) = state.pending.get(&id) {
                let new_out = slot.stdout[stdout_seen..].to_vec();
                let new_err = slot.stderr[stderr_seen..].to_vec();
                stdout_seen = slot.stdout.len();
                stderr_seen = slot.stderr.len();
                if !new_out.is_empty() || !new_err.is_empty() {
                    on_chunk(&new_out, &new_err);
                }
                if let Some(code) = slot.exit {
                    let slot = state.pending.remove(&id).unwrap_or_default();
                    let error = slot.error.clone();
                    drop(state);
                    if let Some(reason) = error {
                        return Err(reason);
                    }
                    return Ok(SpawnOutcome {
                        stdout: slot.stdout,
                        stderr: slot.stderr,
                        code,
                    });
                }
                if let Some(reason) = &slot.error {
                    let reason = reason.clone();
                    state.pending.remove(&id);
                    return Err(reason);
                }
            } else {
                return Err(format!("spawn 请求 {id} 不在 pending 表里"));
            }
            if let Some(reason) = &state.dead {
                return Err(format!("挂载代理已退出：{reason}"));
            }
            // 用户中止：把 kill 发给代理后继续等 `exit`（代理会回一条带 killed 的 exit）
            if let Some(flag) = cancel {
                if flag.load(Ordering::Relaxed) {
                    drop(state);
                    let _ = self.kill(id);
                    state = lock
                        .lock()
                        .map_err(|error| format!("代理状态表损坏（{error}）"))?;
                    continue;
                }
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                drop(state);
                let _ = self.kill(id);
                if let Ok(mut state) = lock.lock() {
                    state.pending.remove(&id);
                }
                return Err(format!("spawn {id} 超时（{}ms）", timeout.as_millis()));
            }
            // 20ms 轮询：既要让中止尽快生效，又不能忙等。数据帧到达时 condvar 会唤醒，
            // 因此正常情形不会等满 20ms。
            let (guard, _) = cvar
                .wait_timeout(state, (deadline - now).min(Duration::from_millis(20)))
                .map_err(|error| format!("代理状态表损坏（{error}）"))?;
            state = guard;
        }
    }

    /// 杀掉某条在跑的工具（整组）
    pub fn kill(&self, target: u64) -> Result<(), String> {
        // `kill` 自己的应答也是同步的，但用一个独立 id，不能覆盖被中止那条的 pending
        let mut fields = serde_json::Map::new();
        fields.insert("target".to_string(), serde_json::Value::from(target));
        let _ = self.call("kill", fields);
        Ok(())
    }
}

/// `call` 的超时：这些 op 都是同步文件操作，正常毫秒级。
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// 一次 `spawn` 的入参
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<String>,
    pub stdin: Option<Vec<u8>>,
}

/// 一次 `spawn` 的结论
pub struct SpawnOutcome {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

/// 读线程：独占读端，把每条应答按 `id` 派发到 pending 表。
fn reader_loop(stream: UnixStream, state: Arc<(Mutex<ProxyState>, Condvar)>) {
    let mut reader = BufReader::new(stream);
    loop {
        let frame = match Frame::read_from(&mut reader) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                mark_dead(&state, "读到 EOF");
                return;
            }
            Err(reason) => {
                mark_dead(&state, &reason);
                return;
            }
        };
        let id = frame.id();
        let (lock, cvar) = &*state;
        let Ok(mut guard) = lock.lock() else {
            return;
        };
        let Some(slot) = guard.pending.get_mut(&id) else {
            // 已被超时 / 中止摘掉的迟到应答：丢弃，不影响其它请求
            continue;
        };
        match frame.op.as_str() {
            "stdout" | "stderr" => {
                let bytes = frame
                    .fields
                    .get("bytes")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|hex| decode_hex(hex).ok())
                    .unwrap_or_default();
                if frame.op == "stdout" {
                    slot.stdout.extend_from_slice(&bytes);
                } else {
                    slot.stderr.extend_from_slice(&bytes);
                }
                cvar.notify_all();
            }
            "exit" => {
                if let Some(error) = frame.fields.get("error").and_then(|value| value.as_str()) {
                    slot.error = Some(error.to_string());
                } else {
                    slot.exit = Some(
                        frame
                            .fields
                            .get("code")
                            .and_then(serde_json::Value::as_i64)
                            .unwrap_or(0) as i32,
                    );
                }
                cvar.notify_all();
            }
            "error" => {
                slot.error = Some(
                    frame
                        .fields
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("代理回了错误但没有 message")
                        .to_string(),
                );
                cvar.notify_all();
            }
            _ => {
                // 一次性 op 的应答：整帧交给等待方，`exit` 标记「已到」
                slot.frame = Some(frame);
                slot.exit = Some(0);
                cvar.notify_all();
            }
        }
    }
}

fn mark_dead(state: &Arc<(Mutex<ProxyState>, Condvar)>, reason: &str) {
    let (lock, cvar) = &**state;
    if let Ok(mut guard) = lock.lock() {
        if guard.dead.is_none() {
            guard.dead = Some(reason.to_string());
        }
        cvar.notify_all();
    }
}

// ───────────────────────── 拉起与定位 ─────────────────────────

/// 一个会话的视图路径（拉起代理时经 argv 传入）
pub struct ViewPaths {
    pub lower: PathBuf,
    pub upper: PathBuf,
    pub work: PathBuf,
    pub merged: PathBuf,
    pub workspace: PathBuf,
}

/// 定位已安装的代理：只认 `<core.mountProxyDir>/<core.mountProxyName>`，且必须
/// `root:root` + 恰好 `04755`（FR-005b：随包槽位里的同名产物永不执行）。
pub fn locate() -> Result<PathBuf, String> {
    verify_installed(&Path::new(PROXY_DIR).join(PROXY_NAME))
}

/// 落点判据的纯实现（`locate` 只提供默认路径）。
///
/// 提出来是为了单测：判据有四条（存在 / root 属主 / 恰好 04755 / 组与其他不可写），
/// 每条都要能单独驱动，而默认落点是 root-owned 的系统目录，测试改不动它。
pub fn verify_installed(path: &Path) -> Result<PathBuf, String> {
    let meta = match std::fs::metadata(path) {
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
    judge_installed_facts(path, meta.uid(), meta.mode())?;
    Ok(path.to_path_buf())
}

/// 落点判据里只吃「属主 uid + 模式」两个事实的那两段（属主 / 恰好 04755）。
///
/// 与读 `metadata` 的那半分开，是为了让每一条判据都能被单独驱动：临时目录造出来的
/// 文件属于跑测试的 uid，在非 root 的机器上（CI runner 是 uid 1001）永远先在属主上
/// 返回，模式那一条根本走不到。
fn judge_installed_facts(path: &Path, uid: u32, mode: u32) -> Result<(), String> {
    if uid != 0 {
        return Err(format!(
            "{} 的属主是 uid {uid}（要求 root），视为未部署",
            path.display()
        ));
    }
    let mode = mode & 0o7777;
    if mode != 0o4755 {
        return Err(format!(
            "{} 的模式是 {mode:04o}（要求恰好 04755），视为未部署",
            path.display()
        ));
    }
    Ok(())
}

/// 拉起一个会话代理并完成握手。
///
/// `--serve` 的五个路径参数都必须给：代理按 FR-006「不读环境变量」，路径只经 argv。
pub fn spawn_session(session_id: &str, view: &ViewPaths) -> Result<SessionProxy, String> {
    let proxy = locate()?;
    let (core_end, proxy_end) =
        UnixStream::pair().map_err(|error| format!("建 socketpair 失败（{error}）"))?;
    let proxy_fd = proxy_end.as_raw_fd();
    let mut command = Command::new(&proxy);
    command
        .arg("--serve")
        .arg("--fd")
        .arg(proxy_fd.to_string())
        .arg("--lower")
        .arg(&view.lower)
        .arg("--upper")
        .arg(&view.upper)
        .arg("--work")
        .arg(&view.work)
        .arg("--merged")
        .arg(&view.merged)
        .arg("--workspace")
        .arg(&view.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    // 子端必须跨 exec 存活：只在 pre_exec 里清掉它自己的 CLOEXEC。
    //
    // 不遍历 `/proc/self/fd` 去关别的 fd：其余 fd 全带 CLOEXEC，exec 后自动消失。
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(move || {
            clear_cloexec(proxy_fd);
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|error| format!("拉起挂载代理失败（{error}）"))?;
    // 父侧仍持有 proxy_end：不关掉它，代理读端永远等不到 EOF，回收链就断了
    drop(proxy_end);

    let writer = core_end
        .try_clone()
        .map_err(|error| format!("复制代理连接失败（{error}）"))?;
    let state = Arc::new((Mutex::new(ProxyState::default()), Condvar::new()));
    let reader_state = Arc::clone(&state);
    let reader_stream = core_end;
    std::thread::spawn(move || reader_loop(reader_stream, reader_state));

    let client = SessionProxy {
        session_id: session_id.to_string(),
        child: Mutex::new(child),
        writer: Mutex::new(writer),
        state,
        next_id: AtomicU64::new(0),
        merged: view.merged.clone(),
    };
    // 握手：先对协议版本，再验一次视图可见。
    //
    // 版本不匹配必须在这里失败而不是等到第一次工具调用：装的是旧代理时，用户会在
    // 「发消息」这一步看不到任何异常，直到某个工具静默跑错。
    let version = client.call("version", serde_json::Map::new())?;
    let ipc = version
        .fields
        .get("ipcVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "代理的 version 应答缺 ipcVersion".to_string())?;
    if ipc != IPC_PROTOCOL_VERSION as u64 {
        return Err(format!(
            "挂载代理的运行期协议版本是 {ipc}，本 Core 要求 {IPC_PROTOCOL_VERSION}"
        ));
    }
    client
        .call("probeOverlay", serde_json::Map::new())
        .map_err(|reason| format!("挂载代理的视图实测不成立：{reason}"))?;
    Ok(client)
}

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

// ───────────────────────── 十六进制 ─────────────────────────

pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

pub fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("十六进制串长度为奇数".to_string());
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for index in (0..text.len()).step_by(2) {
        let byte = u8::from_str_radix(&text[index..index + 2], 16)
            .map_err(|_| "十六进制串含非法字符".to_string())?;
        out.push(byte);
    }
    Ok(out)
}

/// 帧长上限常量在编解码里用；测试也读它
#[cfg_attr(not(test), allow(dead_code))]
pub const FRAME_LIMIT: usize = MAX_FRAME;
/// 单块上限常量；测试读它
#[cfg_attr(not(test), allow(dead_code))]
pub const CHUNK_LIMIT: usize = MAX_CHUNK;

impl Drop for SessionProxy {
    /// 丢弃会话代理 = 关闭 socketpair = 代理读到 EOF 自行退出（FR-007b 的回收主路径）。
    ///
    /// `kill` 只是兜底：覆盖代理卡死、不响应 EOF 的情形。
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// 判据用例里的示例落点：只需要一个「路径」用于拼错误文案，文件不必真的存在。
    ///
    /// 由构建期烧进来的常量拼出，不手抄产品名——那样才与 `locate()` 看向同一个落点。
    fn proxy_slot() -> PathBuf {
        Path::new(PROXY_DIR).join(PROXY_NAME)
    }

    /// 造一个临时"槽位"，按需设置属主与模式
    fn slot(mode: u32) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tc-locate-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("proxy");
        std::fs::write(&file, b"x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).unwrap();
        (dir, file)
    }

    /// RT-1：槽位里有 0755 产物但未安装 → 判据回「未部署」，且原因点名模式不满足。
    ///
    /// 这是上一轮的故障链起点：0755 的随包产物被当成可执行代理。
    ///
    /// 直接驱动纯判据并显式给 `uid = 0`：造出来的临时文件属于跑测试的 uid，非 root 机器上
    /// 会先在属主那一条返回（`rejects_non_root_owner`），模式这一条永远走不到。
    #[test]
    fn rejects_artifact_without_setuid_bit() {
        let error = judge_installed_facts(&proxy_slot(), 0, 0o755).unwrap_err();
        assert!(error.contains("04755"), "{error}");
    }

    /// 不存在时点名「未部署」，而不是回一个笼统的 io 错误
    #[test]
    fn rejects_missing_slot() {
        let error = verify_installed(Path::new("/nonexistent/tc-mount-proxy")).unwrap_err();
        assert!(error.contains("未部署"), "{error}");
    }

    /// 组 / 其他可写视为未部署（04755 之外再多任何写位都不行）
    #[test]
    fn rejects_group_or_other_writable() {
        let error = judge_installed_facts(&proxy_slot(), 0, 0o4757).unwrap_err();
        assert!(error.contains("04755"), "{error}");
    }

    /// 属主判据独立于模式：属主不是 root 时点名 uid，不把原因混成「模式不对」。
    ///
    /// 造不出 root 属主的临时文件，因此这条只能经纯判据驱动。
    #[test]
    fn rejects_non_root_owner() {
        let error = judge_installed_facts(&proxy_slot(), 1001, 0o4755).unwrap_err();
        assert!(error.contains("uid 1001"), "{error}");
        assert!(
            !error.contains("04755"),
            "属主不满足时不该把原因说成模式问题：{error}"
        );
    }

    /// 四条判据全满足才回已部署（`locate` 的成功路径，同样只能经纯判据驱动）
    #[test]
    fn accepts_root_owned_04755() {
        assert!(judge_installed_facts(&proxy_slot(), 0, 0o4755).is_ok());
    }

    /// 真实 metadata 走一遍：临时槽位里的产物一律判「未部署」。
    ///
    /// 不锁定具体是哪一条原因——属主是跑测试的 uid，非 root 的机器（CI runner）命中属主
    /// 判据，root 机器命中模式判据；两条判据各自的拒绝理由由上两条用例逐条锁定。
    #[test]
    fn rejects_temp_slot_whatever_the_runner_uid() {
        let (dir, file) = slot(0o755);
        assert!(verify_installed(&file).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 十六进制编解码：二进制安全（含 0x00 / 0xff）
    #[test]
    fn hex_roundtrips_binary() {
        let bytes = vec![0u8, 1, 0x7f, 0x80, 0xfe, 0xff];
        assert_eq!(decode_hex(&encode_hex(&bytes)).unwrap(), bytes);
    }

    /// 帧编解码：`id` 与字段原样往返（Core ↔ 代理两侧各一份实现，形状必须一致）
    #[test]
    fn frame_roundtrip_keeps_id_and_fields() {
        let frame = Frame::new("readFile")
            .with_id(42)
            .with("path", serde_json::Value::String("/a/b".into()));
        let mut cursor = std::io::Cursor::new(frame.encode());
        let decoded = Frame::read_from(&mut cursor).unwrap().unwrap();
        assert_eq!(decoded.op, "readFile");
        assert_eq!(decoded.id(), 42);
        assert_eq!(decoded.str_field("path").unwrap(), "/a/b");
    }
}

#[cfg(test)]
mod session_tests {

    /// RT-3：能力查询是**唯一**会拉起代理的地方，普通磁盘会话不产生进程。
    ///
    /// 这条用例直接断言注册表的初始状态为空——`session_proxy` 只在被调用时才 `spawn`，
    /// 而它唯一的调用点是 `WorkView::ensure_mounted`。因此「用户从不使用 Overlay 对话
    /// 时不拉起代理」等价于「注册表在没有任何 Overlay 使用时为空」。
    #[test]
    fn no_proxy_before_first_use() {
        assert!(
            crate::mount_proxy::existing_proxy("never-used-session").is_none(),
            "未使用的会话不该有代理"
        );
    }
}

// 契约对拍单独成文件：构建指纹守卫是文本扫描，分不清 `#[cfg(test)]`，
// 而 fixture 的 `include_str!` 必须待在被指纹输入集排除的 `_tests.rs` 里。
#[cfg(test)]
#[path = "client_tests.rs"]
mod contract_tests;

//! 工具代执行（specs/051 FR-007 的「代执行边界」）。
//!
//! ## 为什么工具由代理 fork，而不是 Core 自己 spawn
//!
//! Core 不在任何命名空间里（ADR-0018），因此它 `open()` 看不到叠加视图、它 `spawn` 的
//! 工具也不在视图里。凡是需要看到视图的操作——Bash、Read、Write、Edit、Grep、Glob、
//! `workView*` 三个请求——都必须由持有命名空间的 B 代执行。
//!
//! ## 视图路径为什么不需要映射
//!
//! B 的挂载命名空间在 `privilege::establish` 里建立，且**视图在这一份命名空间里被 bind
//! 到真实工作区路径上**（`bindOverlay`）。因此 B `fork` 出来的工具直接看真实路径就是
//! 叠加结果：脚本里写死的绝对路径、`$PWD`、`cd` 全部照常工作，Core 侧不需要把路径翻译成
//! 挂载点里的另一条路径。这是 specs/045「视图对工具透明」在代执行形态下的延续。
//!
//! ## fd 纪律（FR-007「fd 纪律」）
//!
//! 工具子进程的 stdin / stdout / stderr **全部由本模块新建管道**，绝不继承 B 自己的
//! fd 1 / fd 2 或 Core ↔ 代理的通信 fd——否则工具的输出会直接写进帧流，一帧就废；
//! 工具里的代码也能伪造应答。管道由内核在 `pipe(2)` 时带 `CLOEXEC`，`spawn` 只把工具
//! 自己的三条 dup 到 0 / 1 / 2。
//!
//! ## 控制语义留在 Core
//!
//! 超时、中止、自动转后台都由 Core 决定（FR-007「控制语义留在 Core」）。本模块只提供
//! `kill` 这条原语：Core 发 `kill` 请求带 `id`，代理把该请求的进程组整组杀掉并回
//! `exit`。代理不自己判超时——它是执行方，不是策略方。
//!
//! ## 输出走请求 id
//!
//! `spawn` 的输出是**流式**的：先回若干 `stdout` / `stderr` 片段，最后一条 `exit`。
//! 每条都带同一个 `id`，Core 侧按 id 把片段交给对应请求的读取方。

use crate::protocol::{Frame, Value};
use crate::sys;
use std::collections::HashMap;
use std::ffi::CString;
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};

/// 一条在跑的工具进程。
struct Running {
    /// 进程组 id（= 子进程 pid，因为子进程 `setpgid(0, 0)`）
    pgid: i32,
    /// 置位后输出线程不再回写（请求已被 `kill`）
    killed: Arc<Mutex<bool>>,
}

/// 在跑的工具进程表：请求 id → 进程。
///
/// 请求 id 由 Core 分配且单调递增，一次请求一条记录；`kill` 与 `exit` 都按它回收。
fn running() -> &'static Mutex<HashMap<u64, Running>> {
    static RUNNING: std::sync::OnceLock<Mutex<HashMap<u64, Running>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一次 `spawn` 的入参。
#[derive(Debug)]
pub struct SpawnRequest {
    pub id: u64,
    /// `argv[0]` 是可执行文件，其余是参数
    pub argv: Vec<String>,
    pub cwd: String,
    /// 白名单形式的环境变量：`KEY=VALUE` 的完整列表，代理不读自己的环境
    pub env: Vec<String>,
    /// 写入子进程 stdin 的字节（`None` = `/dev/null`）
    pub stdin: Option<Vec<u8>>,
}

impl SpawnRequest {
    /// 从一帧解析；缺字段直接报错（不猜默认值）
    pub fn from_frame(frame: &Frame) -> Result<Self, String> {
        let argv = frame.string_array_field("argv")?;
        if argv.is_empty() {
            return Err("spawn.argv 不能为空".to_string());
        }
        // stdin 缺失与「显式传空」是两件事：前者接 /dev/null，后者把空串喂进去后关掉。
        let stdin = match frame.get("stdin") {
            Some(Value::Str(text)) => Some(hex_decode(text)?),
            Some(Value::Null) | None => None,
            Some(other) => return Err(format!("spawn.stdin 类型不对：{other:?}")),
        };
        Ok(Self {
            id: frame.id(),
            argv,
            cwd: frame.str_field("cwd")?.to_string(),
            env: match frame.get("env") {
                Some(Value::Array(_)) => frame.string_array_field("env")?,
                Some(Value::Null) | None => Vec::new(),
                Some(other) => return Err(format!("spawn.env 类型不对：{other:?}")),
            },
            stdin,
        })
    }
}

fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    crate::protocol::hex_decode(text)
}

/// 执行一次 `spawn`，输出以帧的形式逐条交给 `emit`（调用方决定怎么并发地写回）。
///
/// 返回时子进程已经收尸：调用方负责把最后一条 `exit` 也交给 `emit`。
///
/// `emit` 收 `Arc` 而不是 `&`：两个输出线程要各自持有它（读线程的生命周期跨出本函数），
/// 引用无法跨线程持有。
pub fn spawn(request: SpawnRequest, emit: Arc<dyn Fn(Frame) + Send + Sync>) {
    let id = request.id;
    // 输出线程与 `kill` 之间的开关：`kill` 置位后读线程不再回写，避免已中止的命令
    // 继续往 Core 推输出（specs/034 的「中止后不再上报进度」同一口径）。
    let killed = Arc::new(Mutex::new(false));
    let pipeline = match spawn_child(&request, id, Arc::clone(&killed)) {
        Ok(pipeline) => pipeline,
        Err(reason) => {
            emit(
                Frame::new("exit")
                    .with_id(id)
                    .with("error", Value::Str(format!("工具进程启动失败：{reason}"))),
            );
            return;
        }
    };
    {
        if let Ok(mut table) = running().lock() {
            table.insert(
                id,
                Running {
                    pgid: pipeline.pid,
                    killed: Arc::clone(&killed),
                },
            );
        }
    }
    // 三个读线程：stdout / stderr 各一个，stdin 写完后关闭（否则命令读 stdin 会挂住）。
    let stdout_thread = pipeline
        .stdout
        .map(|fd| read_stream(fd, id, "stdout", Arc::clone(&killed), Arc::clone(&emit)));
    let stderr_thread = pipeline
        .stderr
        .map(|fd| read_stream(fd, id, "stderr", Arc::clone(&killed), Arc::clone(&emit)));
    if let Some(pipe) = pipeline.stdin {
        write_stdin(
            pipe,
            request.stdin,
            id,
            Arc::clone(&killed),
            Arc::clone(&emit),
        );
    } else {
        request.stdin.map(|bytes| {
            // 没有 stdin 管道却有内容：协议要求 stdin 内容必须真被喂进去，不做静默丢弃
            emit(Frame::new("stderr").with_id(id).with(
                "text",
                Value::Str("内部错误：spawn 带了 stdin 内容但没建 stdin 管道".to_string()),
            ));
            let _ = bytes;
        });
    }
    // 收尸：先等两个读线程读完（它们持有管道读端），再 `waitpid`。
    //
    // 必须让读线程先结束：子进程退出但孙进程仍持有管道写端时，读线程会一直阻塞到
    // EOF；`waitpid` 与读线程的顺序反过来会让输出截断（实测：`sh -c 'x & sleep 0.2'`
    // 的后台输出丢失）。
    if let Some(handle) = stdout_thread {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    let status = wait_child(pipeline.pid);
    if let Ok(mut table) = running().lock() {
        table.remove(&id);
    }
    let was_killed = killed.lock().map(|flag| *flag).unwrap_or(false);
    let mut reply = Frame::new("exit").with_id(id);
    reply = match status {
        Ok(exit_code) => reply.with("code", Value::Num(exit_code as i64)),
        Err(reason) => reply.with("error", Value::Str(reason)),
    };
    if was_killed {
        reply = reply.with("killed", Value::Bool(true));
    }
    emit(reply);
}

/// 同步执行一条命令并**收集**全部输出（`gitShow` 这类取数用）。
///
/// 与 `spawn` 的区别只有「输出去哪」：`spawn` 把输出流式推给 Core，这里攒在内存里
/// 一次交出。共用同一套 `fork` / 管道 / 收尸逻辑，因此 fd 纪律与进程组语义不会两处
/// 各写一份。
pub fn spawn_collect(request: SpawnRequest, sink: std::sync::Arc<std::sync::Mutex<Collected>>) {
    let result = spawn_child(&request, 0, Arc::new(Mutex::new(false)));
    let pipeline = match result {
        Ok(pipeline) => pipeline,
        Err(reason) => {
            if let Ok(mut sink) = sink.lock() {
                sink.error = Some(format!("工具进程启动失败：{reason}"));
            }
            return;
        }
    };
    let stdout_thread = pipeline
        .stdout
        .map(|fd| collect_stream(fd, std::sync::Arc::clone(&sink), true));
    let stderr_thread = pipeline
        .stderr
        .map(|fd| collect_stream(fd, std::sync::Arc::clone(&sink), false));
    if let Some(handle) = stdout_thread {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    let status = wait_child(pipeline.pid);
    if let Ok(mut sink) = sink.lock() {
        match status {
            Ok(code) => sink.code = Some(code),
            Err(reason) => sink.error = Some(reason),
        }
    }
}

/// 收集类输出容器（`serve::Collected` 的镜像；`exec` 不依赖 `serve`，因此各层自带）
#[derive(Default)]
pub struct Collected {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: Option<i32>,
    pub error: Option<String>,
}

fn collect_stream(
    fd: i32,
    sink: std::sync::Arc<std::sync::Mutex<Collected>>,
    is_stdout: bool,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = unsafe {
                sys::read(
                    fd,
                    buffer.as_mut_ptr() as *mut std::os::raw::c_void,
                    buffer.len(),
                )
            };
            if count > 0 {
                if let Ok(mut sink) = sink.lock() {
                    if is_stdout {
                        sink.stdout.extend_from_slice(&buffer[..count as usize]);
                    } else {
                        sink.stderr.extend_from_slice(&buffer[..count as usize]);
                    }
                }
                continue;
            }
            if count == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        unsafe {
            sys::close(fd);
        }
    })
}

/// `kill` 一条在跑的工具：整组杀掉，输出线程随即停写。
pub fn kill(id: u64) -> Result<(), String> {
    let table = running()
        .lock()
        .map_err(|error| format!("工具进程表损坏（{error}）"))?;
    let Some(running) = table.get(&id) else {
        // 已退出 / 从未存在：幂等成功。Core 的中止与超时可能同时到达，两者都调它。
        return Ok(());
    };
    if let Ok(mut flag) = running.killed.lock() {
        *flag = true;
    }
    // 负 pid = 整组。工具在 `spawn` 时 `setpgid(0, 0)`，因此组里没有别人的进程。
    let rc = unsafe { sys::kill(-running.pgid, sys::SIGKILL) };
    if rc != 0 && rc != -1 {
        return Err(format!(
            "kill 进程组 {} 失败（{}）",
            running.pgid,
            sys::last_error()
        ));
    }
    Ok(())
}

/// 子进程与三条管道
struct Pipeline {
    pid: i32,
    stdin: Option<i32>,
    stdout: Option<i32>,
    stderr: Option<i32>,
}

/// 按**请求自带的** `env` 里的 `PATH` 查可执行文件（`execve(2)` 自己不查）。
///
/// 为什么需要：`execve` 把 `argv[0]` 当路径，没有 `execvp` 的 PATH 搜索。裸名
/// （`git` / `rg` / `bash`）会直接 `ENOENT`，子进程以 126 退出且 **stderr 为空**——
/// 调用方只看到「命令失败」而没有任何原因，`workViewChangesRequested` 就是这样报
/// `git rev-parse 失败：`（冒号后为空）的。查表只能用请求带来的 `PATH`（FR-006：
/// 代理不读自己的环境），`argv[0]` 含 `/` 时按调用方给的原样执行。
///
/// 解析必须在 `fork` 之前完成：fork 之后只允许 async-signal-safe 调用，而这里要
/// `stat` 文件与分配字符串。
fn resolve_executable(program: &str, env: &[String]) -> Result<String, String> {
    if program.contains('/') {
        return Ok(program.to_string());
    }
    let path_var = env
        .iter()
        .find_map(|entry| entry.strip_prefix("PATH="))
        .ok_or_else(|| {
            format!("无法执行 {program}：spawn 的 env 里没有 PATH（代理不读自己的环境）")
        })?;
    for dir in path_var.split(':') {
        // 空分量按 POSIX 表示当前目录
        let candidate = if dir.is_empty() {
            std::path::PathBuf::from(program)
        } else {
            std::path::Path::new(dir).join(program)
        };
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // 可执行位：与 `access(X_OK)` 同一判据的可见部分（属主 / 组 / 其它任一可执行）
        if meta.permissions().mode() & 0o111 == 0 {
            continue;
        }
        return Ok(candidate.to_string_lossy().to_string());
    }
    Err(format!(
        "找不到可执行文件 {program}（PATH={path_var}）；工具进程未启动"
    ))
}

/// `fork` + `execve`：子进程只持有自己的三条管道，其余 fd 一律 `CLOEXEC` 自动消失。
///
/// 不用 `std::process::Command`：本 crate 零依赖且要求「只 `execve` 传入的 envp、
/// 不读自己的环境、不跑 `$SHELL -lc`」（FR-007），`Command` 会自己合并环境，正好与
/// 这条要求冲突。PATH 查找由 [`resolve_executable`] 显式做（只在请求带的 `env` 里查）。
fn spawn_child(
    request: &SpawnRequest,
    id: u64,
    killed: Arc<Mutex<bool>>,
) -> Result<Pipeline, String> {
    // 三条管道：`pipe(2)` 的 fd 在 Linux 上默认不带 CLOEXEC，这里逐个手工设。
    let (stdin_read, stdin_write) = make_pipe()?;
    let (stdout_read, stdout_write) = make_pipe()?;
    let (stderr_read, stderr_write) = make_pipe()?;

    // 子进程要 exec 的路径与 cwd 必须在 fork 之前转成 CString：fork 之后只允许
    // async-signal-safe 调用，`CString::new` 会分配内存。
    let program = resolve_executable(&request.argv[0], &request.env)?;
    let mut request_argv = request.argv.clone();
    request_argv[0] = program;
    let argv: Vec<CString> = request_argv
        .iter()
        .map(|item| CString::new(item.as_str()).map_err(|_| "argv 含 NUL".to_string()))
        .collect::<Result<_, _>>()?;
    let env: Vec<CString> = request
        .env
        .iter()
        .map(|item| CString::new(item.as_str()).map_err(|_| "env 含 NUL".to_string()))
        .collect::<Result<_, _>>()?;
    let cwd = CString::new(request.cwd.as_str()).map_err(|_| "cwd 含 NUL".to_string())?;
    let argv_ptrs: Vec<*const std::os::raw::c_char> = argv
        .iter()
        .map(|item| item.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();
    let env_ptrs: Vec<*const std::os::raw::c_char> = env
        .iter()
        .map(|item| item.as_ptr())
        .chain(std::iter::once(std::ptr::null()))
        .collect();

    let pid = unsafe { sys::fork() };
    if pid < 0 {
        close_all(&[
            stdin_read,
            stdin_write,
            stdout_read,
            stdout_write,
            stderr_read,
            stderr_write,
        ]);
        return Err(format!("fork 失败（{}）", sys::last_error()));
    }
    if pid == 0 {
        // ── 子进程（工具本体）：永不返回 ──
        //
        // 进程组自立门户：Core 的中止要能整组杀掉，而不只是 shell 一层
        // （specs/defects/bash-abort-does-not-kill-process-tree.md 同一要求）。
        unsafe { sys::setpgid(0, 0) };
        // 只保留自己的三条管道；其余 fd 全部 `CLOEXEC`，exec 后自动关闭。
        unsafe {
            sys::dup2(stdin_read, 0);
            sys::dup2(stdout_write, 1);
            sys::dup2(stderr_write, 2);
        }
        // 子进程进 cwd 失败就直接退：静默落到 `/` 会让相对路径写错地方
        if unsafe { sys::chdir(cwd.as_ptr()) } != 0 {
            unsafe { sys::_exit(125) };
        }
        unsafe {
            sys::execve(argv_ptrs[0], argv_ptrs.as_ptr(), env_ptrs.as_ptr());
        }
        // execve 只有在失败时才返回
        unsafe { sys::_exit(126) };
    }

    // ── 父进程（B）──
    let _ = killed;
    unsafe {
        sys::close(stdin_read);
        sys::close(stdout_write);
        sys::close(stderr_write);
    }
    let _ = id;
    Ok(Pipeline {
        pid,
        stdin: Some(stdin_write),
        stdout: Some(stdout_read),
        stderr: Some(stderr_read),
    })
}

/// 建一根带 `CLOEXEC` 的管道
fn make_pipe() -> Result<(i32, i32), String> {
    let mut fds = [0i32; 2];
    let rc = unsafe { sys::pipe2(fds.as_mut_ptr(), sys::O_CLOEXEC) };
    if rc != 0 {
        return Err(format!("pipe2 失败（{}）", sys::last_error()));
    }
    Ok((fds[0], fds[1]))
}

fn close_all(fds: &[i32]) {
    for fd in fds {
        unsafe {
            sys::close(*fd);
        }
    }
}

/// 读一个输出管道，把块按 `op` 交给 `emit`
fn read_stream(
    fd: i32,
    id: u64,
    op: &'static str,
    killed: Arc<Mutex<bool>>,
    emit: Arc<dyn Fn(Frame) + Send + Sync>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = unsafe {
                sys::read(
                    fd,
                    buffer.as_mut_ptr() as *mut std::os::raw::c_void,
                    buffer.len(),
                )
            };
            if count > 0 {
                // 已中止：丢弃剩余输出。读到这里是为了把管道排空，让子进程不阻塞在 write。
                if killed.lock().map(|flag| *flag).unwrap_or(false) {
                    continue;
                }
                emit(
                    Frame::new(op)
                        .with_id(id)
                        .with("bytes", Value::Bytes(buffer[..count as usize].to_vec())),
                );
                continue;
            }
            if count == 0 {
                break;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        unsafe {
            sys::close(fd);
        }
    })
}

/// 把 stdin 内容写进管道后关闭写端。
///
/// 同步写：内容来自 Core，量级是命令输入而不是工具输出（后者才是大流），同步写完
/// 再关端即可让子进程立刻读到 EOF。管道缓冲区满时会阻塞在这里，此时子进程正在读，
/// 因此不会死锁。
fn write_stdin(
    fd: i32,
    content: Option<Vec<u8>>,
    id: u64,
    killed: Arc<Mutex<bool>>,
    emit: Arc<dyn Fn(Frame) + Send + Sync>,
) {
    if let Some(bytes) = content {
        let mut written = 0usize;
        while written < bytes.len() {
            if killed.lock().map(|flag| *flag).unwrap_or(false) {
                break;
            }
            let count = unsafe {
                sys::write(
                    fd,
                    bytes[written..].as_ptr() as *const std::os::raw::c_void,
                    bytes.len() - written,
                )
            };
            if count > 0 {
                written += count as usize;
                continue;
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            let _ = id;
            emit(
                Frame::new("stderr")
                    .with_id(id)
                    .with("text", Value::Str(format!("写工具 stdin 失败（{error}）"))),
            );
            break;
        }
    }
    unsafe {
        sys::close(fd);
    }
}

/// 收尸，返回退出码
fn wait_child(pid: i32) -> Result<i32, String> {
    let mut status = 0;
    loop {
        let reaped = unsafe { sys::waitpid(pid, &mut status, 0) };
        if reaped == pid {
            // 被信号杀死：`128 + 信号`，与 shell 口径一致
            let signal = status & 0x7f;
            if signal == 0 {
                return Ok((status >> 8) & 0xff);
            }
            return Ok(128 + signal);
        }
        if reaped < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("waitpid({pid}) 失败（{error}）"));
        }
    }
}

/// `listDir`：列一个目录，返回 `[{name, isDir, size}]`
pub fn list_dir(path: &str) -> Result<Vec<Value>, String> {
    let entries =
        std::fs::read_dir(path).map_err(|error| format!("列目录 {path} 失败（{error}）"))?;
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("读目录项失败（{error}）"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        // 符号链接按链接本身判：跟随后可能指到视图外，也不该把链接报成目录
        let meta = std::fs::symlink_metadata(entry.path())
            .map_err(|error| format!("stat {} 失败（{error}）", entry.path().display()))?;
        out.push(Value::Object(vec![
            ("name".to_string(), Value::Str(name)),
            ("isDir".to_string(), Value::Bool(meta.file_type().is_dir())),
            ("size".to_string(), Value::Num(meta.len() as i64)),
            (
                "isSymlink".to_string(),
                Value::Bool(meta.file_type().is_symlink()),
            ),
        ]));
    }
    Ok(out)
}

/// 一个路径的事实（`stat` 的应答）
pub struct PathInfo {
    pub exists: bool,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
}

/// `stat`：路径的事实。
///
/// 用 `symlink_metadata` 而不是跟随链接：工具侧的「存在 / 是文件 / 是目录」判断要回答
/// 「这个路径本身是什么」——跟随链接会让一个指向视图外的符号链接被当成「文件」，
/// 随后 `readFile` 才失败，报错点离根因很远（`docs/architecture/principles.md` 4.1）。
/// 断链因此是一条正常事实（`exists: true`、`isSymlink: true`）而不是错误。
pub fn stat(path: &str) -> Result<PathInfo, String> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) => Ok(PathInfo {
            exists: true,
            is_file: meta.file_type().is_file(),
            is_dir: meta.file_type().is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            size: meta.len(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PathInfo {
            exists: false,
            is_file: false,
            is_dir: false,
            is_symlink: false,
            size: 0,
        }),
        Err(error) => Err(format!("stat {path} 失败（{error}）")),
    }
}

/// `mkdirAll`：递归建目录
pub fn mkdir_all(path: &str) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|error| format!("建目录 {path} 失败（{error}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_request_requires_argv() {
        let frame = Frame::new("spawn").with_id(3);
        assert!(SpawnRequest::from_frame(&frame).is_err());
        let frame = Frame::new("spawn")
            .with_id(3)
            .with("argv", Value::Array(vec![]));
        assert!(SpawnRequest::from_frame(&frame).is_err());
    }

    #[test]
    fn spawn_request_rejects_non_string_argv() {
        let frame = Frame::new("spawn").with_id(3).with(
            "argv",
            Value::Array(vec![Value::Str("/bin/sh".into()), Value::Num(1)]),
        );
        let error = SpawnRequest::from_frame(&frame).unwrap_err();
        assert!(error.contains("非字符串"), "{error}");
    }

    #[test]
    fn spawn_request_reads_stdin_hex() {
        let frame = Frame::new("spawn")
            .with_id(9)
            .with("argv", Value::Array(vec![Value::Str("/bin/cat".into())]))
            .with("cwd", Value::Str("/tmp".into()))
            .with("stdin", Value::Str("6869".into()));
        let request = SpawnRequest::from_frame(&frame).unwrap();
        assert_eq!(request.id, 9);
        assert_eq!(request.stdin, Some(b"hi".to_vec()));
        assert!(request.env.is_empty());
    }

    /// 裸名要按请求带来的 PATH 解析成绝对路径（`execve(2)` 自己不查 PATH）。
    ///
    /// 不解析时裸名工具一律以 126 退出且 stderr 为空——`workViewChangesRequested`
    /// 的 `git rev-parse 失败：`（冒号后为空）就是这个形态。
    #[test]
    fn resolves_bare_program_through_request_path() {
        let dir = std::env::temp_dir().join(format!("tc-proxy-path-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("probe-tool");
        std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();

        let env = vec![format!("PATH=/nonexistent:{}", dir.display())];
        let resolved = resolve_executable("probe-tool", &env).expect("应能按 PATH 解析");
        assert_eq!(resolved, program.to_string_lossy().to_string());

        // 含 `/` 的原样执行：不查 PATH
        assert_eq!(resolve_executable("/bin/sh", &env).unwrap(), "/bin/sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 找不到时报错并点名 PATH（不静默以 126 退出、也不读代理自己的环境）。
    #[test]
    fn reports_missing_program_with_request_path() {
        let env = vec!["PATH=/nonexistent-tc-proxy".to_string()];
        let error = resolve_executable("no-such-tool", &env).unwrap_err();
        assert!(error.contains("no-such-tool"), "{error}");
        assert!(error.contains("/nonexistent-tc-proxy"), "{error}");

        // 请求不带 PATH：代理不读自己的环境，因此也不能"猜"一个
        let empty: Vec<String> = Vec::new();
        let error = resolve_executable("no-such-tool", &empty).unwrap_err();
        assert!(error.contains("PATH"), "{error}");
    }
}

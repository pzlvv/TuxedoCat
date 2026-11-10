//! 工具 shell 的 PATH 解析（`docs/core/standalone-core.md` 第 3.2 节）。
//!
//! 工具命令由 core 用 `$SHELL -c` 拉起（`shell.rs`），看到的是 core 进程的环境。
//! 宿主从 GUI 启动（macOS 的 launchd 只给最小 PATH）、或远端 daemon 由 SSH exec
//! 拉起（sshd 用 `$SHELL -c` 起进程，非交互非登录）时，用户终端里的 PATH——
//! `.zshrc` / `.bashrc` 里配的那些目录——都不在这个环境里，工具命令于是找不到
//! `node` / `cargo` / `git`。
//!
//! 这里在首次需要时抓一次用户终端里的 PATH（非 Windows 用「登录 + 交互」shell，Windows
//! 只取进程环境），缓存后由 [`apply`] / [`apply_native`] 注入子进程：这两个函数是 PATH
//! 的唯一写入点（`docs/architecture/principles.md` 第 7 节）。
//!
//! **两种形式，同一份来源**：shell 自己看到的形式（Windows 上的 Git Bash / MSYS2 /
//! Cygwin 是 POSIX 列表）给 `$SHELL -c` 拉起的工具命令；原生进程（`rg` / `git` /
//! `where` / `cmd` / MCP server）要 Windows 形式，Windows 上直接取进程环境里的 PATH。
//!
//! Windows 上探测**不读启动文件**（只用 `-c`）：`-l` 会跑 `/etc/profile`，MSYS2 机器上
//! 它按 `MSYS2_PATH_TYPE` / `ORIGINAL_PATH` 重建 PATH，把用户环境变量里的目录（`git`
//! 所在的 Windows 目录等）整套换掉；宿主启动 Core 时已经把用户完整的 Windows PATH
//! 放进了进程环境（`specs/defects/windows-bash-probe-login-resets-path.md`）。
//!
//! 三条刻意的约束：
//!
//! - **不降级**：抓不到就返回错误，由调用方报给模型 / 用户。静默退回继承环境会把
//!   「命令找不到」重新变成难查的谜题（`docs/architecture/principles.md` 第 1 节）。
//! - **不分配 pty**：`-c` 不进入交互循环，结果走管道即可。需要 tty 的命令是另一件事，
//!   不在本模块范围内。
//! - **只取 PATH**：`.zshrc` 里的 alias、函数、`chpwd` 钩子都不搬进来。它们是交互式
//!   shell 的行为，搬进命令执行会改变命令语义，启动文件打印的内容也会混进工具输出。

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

// 只在单测里用：`TEST_FORCED` 是覆盖槽，生产路径不写
#[cfg(test)]
use std::sync::Mutex;

use crate::shell::{self, ShellInfo};
use crate::util;

/// 抓取用户终端 PATH 的上限。`.zshrc` 里跑 nvm / conda / pyenv 常见几百毫秒到数秒，
/// 留足余量；超时就报错，不无限等，也不退化成继承环境。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// 探测输出的标记：启动文件打印的内容排在前面，按标记认自己那行。
const SHELL_FORM_MARKER: &str = "__TC_PATH__";

/// 用户终端里的 PATH，两种形式同一份来源。
#[derive(Debug, Clone)]
pub struct ShellPath {
    /// shell 自己的形式：Windows 上的 Git Bash / MSYS2 / Cygwin 是 POSIX 列表
    shell: OsString,
    /// 交给原生进程的形式：Windows 上就是进程环境里的 PATH（Windows 形式）；
    /// 非 Windows 上与 [`Self::shell`] 相同
    native: OsString,
}

impl ShellPath {
    /// 两种形式相同的场合（非 Windows、PowerShell、cmd.exe）
    fn uniform(path: OsString) -> ShellPath {
        ShellPath {
            shell: path.clone(),
            native: path,
        }
    }

    /// shell 自己的形式（`$SHELL -c` 拉起的工具命令看到的那份）
    pub fn shell(&self) -> &OsStr {
        &self.shell
    }

    /// 交给原生进程的形式（`rg` / `git` / `where` / `cmd` / MCP server）
    pub fn native(&self) -> &OsStr {
        &self.native
    }
}

static RESOLVED: OnceLock<Result<ShellPath, String>> = OnceLock::new();

/// 测试钉的覆盖值（`force_path_for_test` 写入，`apply` 系列优先于 `RESOLVED`）。
///
/// 独立于 `RESOLVED` 存在且随沙箱存亡（`clear_forced_path_for_test` 在 Sandbox::drop
/// 清除）：OnceLock 只能设一次，进程里先建的沙箱会把 PATH 永久钉死，后续沙箱自己
/// 的钉定被静默忽略——用例断言的是「本沙箱目录出现在子进程 $PATH 里」，能否通过
/// 就变成了测试调度的抽签（smoke 车道在 ubuntu 上两次实证）。生产路径不写这个槽，
/// 语义不变。
#[cfg(test)]
static TEST_FORCED: Mutex<Option<ShellPath>> = Mutex::new(None);

/// 测试钉的内置工具目录（`force_bundled_dirs_for_test` 写入，`apply` 系列优先于真实解析）。
///
/// 与 `TEST_FORCED` 同一套存亡口径：沙箱钉空表、销毁即清除，用例不会因为开发机刚好
/// 构建过产物而得到不同结果。
#[cfg(test)]
static TEST_BUNDLED_DIRS: Mutex<Option<Vec<std::path::PathBuf>>> = Mutex::new(None);

/// 当前生效的 PATH：测试覆盖优先，其后是探测缓存。
fn current() -> Result<ShellPath, String> {
    #[cfg(test)]
    if let Some(forced) = TEST_FORCED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return Ok(forced);
    }
    RESOLVED
        .get_or_init(|| probe(&shell::shell()))
        .as_ref()
        .map_err(|error| error.clone())
        .cloned()
}

/// 把解析出的 PATH 注入 shell 子进程（`$SHELL -c` 拉起的工具命令 / 后台任务）。
pub fn apply(command: &mut Command) -> Result<(), String> {
    let user = current()?.shell().to_os_string();
    let dirs = search_path_dirs_for_test_or_now();
    let prefixed = prepend_bundled_dirs(&user, &dirs, shell_form_of(&user));
    apply_value(command, &prefixed);
    Ok(())
}

/// 把解析出的 PATH 注入原生子进程（`rg` / `git` / `where` / `cmd` / MCP server）。
///
/// 原生进程不认 POSIX 列表：Windows 上用逐条派生出来的 Windows 形式；进程环境的 PATH
/// 本身可能是 Git Bash 的混合形态（见 [`native_path_from`]），这里统一归一一次。
pub fn apply_native(command: &mut Command) -> Result<(), String> {
    let native = current()?.native().to_os_string();
    let normalized = native_path_from(&native).unwrap_or(native);
    let dirs = search_path_dirs_for_test_or_now();
    let prefixed = prepend_bundled_dirs(&normalized, &dirs, Form::Windows);
    apply_value(command, &prefixed);
    Ok(())
}

/// PATH 的形式：决定内置目录怎么表达、分隔符怎么取。
///
/// Windows 上两条注入路径的形式可能不同：Git Bash / MSYS2 / Cygwin 的 shell 形式是 POSIX
/// 列表（`:` 分隔、`/c/...` 条目），而 PowerShell / cmd 的 shell 形式是 Windows 列表
/// （`;` 分隔、`C:\...` 条目）。因此不能按「注入目标」猜形式，要按**用户 PATH 本身**的形态定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Form {
    /// POSIX 列表：`:` 分隔，条目是 `/c/...` 这样的形式
    Posix,
    /// Windows 列表：`;` 分隔，条目是 `C:\...` 这样的形式
    Windows,
}

/// 按一份 PATH 的实际形态判定它属于哪种形式（非 Windows 恒 POSIX）。
///
/// 判据：含分号即为 Windows 列表（PowerShell / cmd 与原生形式的进程环境）；Git Bash 的
/// shell 形式用 `:` 分隔且条目是 `/c/...`，落在 POSIX 分支。
fn shell_form_of(user: &OsStr) -> Form {
    if !cfg!(windows) {
        return Form::Posix;
    }
    match user.to_str() {
        Some(text) if text.contains(';') => Form::Windows,
        _ => Form::Posix,
    }
}

/// 内置工具目录的来源（生产路径读进程环境，测试路径读覆盖槽）。
fn search_path_dirs_for_test_or_now() -> Vec<std::path::PathBuf> {
    #[cfg(test)]
    if let Some(forced) = TEST_BUNDLED_DIRS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return forced;
    }
    crate::bundled_tools::search_path_dirs_now()
}

/// 把内置工具目录前置到一份 PATH 前面（`docs/core/standalone-core.md` 第 3.2.1 节）。
///
/// 三条规则：
/// 1. **前置**：内置目录排在用户 PATH 之前，同名命令（用户自己装的 `rg` / `fd`）被遮蔽——
///    模型在工具 shell 里跑到的恒是随产品分发的那一份，行为不随目标机器漂移；
/// 2. **去重但保持前置**：用户 PATH 里已有的同一条目从原位删掉，只保留前置的那一份；
/// 3. **跳过坏条目**：某目录无法表达成目标形式（Windows 上既不是盘符也不是 UNC）时跳过它，
///    不把坏条目注入 PATH。
///
/// 内置目录为空（产物缺失 / 未构建）时原样返回用户 PATH：缺工具的失败信号由命令本身发出
/// （`rg: command not found` 进工具结果），注入侧不报错——注入报错会让整条 `Bash` 命令
/// 失败，把上百条与搜索无关的命令一起挡掉，真正的问题反而被埋在后面。
fn prepend_bundled_dirs(user: &OsStr, dirs: &[std::path::PathBuf], form: Form) -> OsString {
    // 分隔符跟形式走（见 [`Form`] 的说明）
    let separator = match form {
        Form::Posix => ':',
        Form::Windows => ';',
    };
    let mut front: Vec<String> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    for dir in dirs {
        let rendered = match form {
            Form::Posix => crate::bundled_tools::shell_form(dir),
            Form::Windows => crate::bundled_tools::native_form(dir),
        };
        let Some(rendered) = rendered else {
            continue;
        };
        if rendered.is_empty() {
            continue;
        }
        let key = path_key(&rendered);
        if keys.iter().any(|existing| existing == &key) {
            continue;
        }
        keys.push(key);
        front.push(rendered);
    }
    if front.is_empty() {
        return user.to_os_string();
    }
    let mut parts: Vec<String> = front;
    // 用户 PATH 里已在 pref 出现过的条目跳过（去重；顺序仍是「内置在前」）
    if let Some(text) = user.to_str() {
        for entry in text.split(separator) {
            // 空条目（尾随分隔符 / 空串 PATH）原样保留语义上没有意义的段，直接丢弃
            if entry.is_empty() {
                continue;
            }
            // `native_path_from` 归一后的条目可能是 Windows 形式，与内置目录的 key 同口径比较
            if keys.iter().any(|existing| existing == &path_key(entry)) {
                continue;
            }
            // Windows 上归一后再比较一次：用户 PATH 可能写着 `/c/...`，内置目录已渲染成 `C:\...`
            if let Some(normalized_entry) = normalized_entry(entry, form) {
                if keys
                    .iter()
                    .any(|existing| existing == &path_key(&normalized_entry))
                {
                    continue;
                }
            }
            parts.push(entry.to_string());
        }
    } else {
        // 非 UTF-8 的 PATH：原样追加（不做去重，保持旧行为的下限），不丢用户目录
        parts.push(user.to_string_lossy().to_string());
    }
    OsString::from(parts.join(&separator.to_string()))
}

/// 条目的比较键：Windows 上大小写不敏感、正反斜杠视为同一条目；其余平台原样。
fn path_key(entry: &str) -> String {
    if !cfg!(windows) {
        return entry.to_string();
    }
    let unified = entry.replace('/', "\\");
    // 去掉尾随反斜杠（`C:\bin\` 与 `C:\bin` 是同一条目）
    let trimmed = unified.trim_end_matches('\\');
    trimmed.to_lowercase()
}

/// 用户 PATH 的某一条目在另一形式下的写法（用于跨形式比较）；转换不了返回 `None`。
fn normalized_entry(entry: &str, form: Form) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    match form {
        // POSIX 列表：用户写着的 `C:\x` 要换成 `/c/x` 才能与内置目录比
        Form::Posix => crate::bundled_tools::shell_form(std::path::Path::new(entry)),
        Form::Windows => crate::bundled_tools::native_form(std::path::Path::new(entry)),
    }
}

fn apply_value(command: &mut Command, path: &OsStr) {
    command.env("PATH", path);
}

/// 把一份「可能是 Git Bash / MSYS2 混合形态」的 PATH 归一成原生进程认的 Windows 形式。
///
/// 为什么需要：进程环境的 PATH 在从 Git Bash 启动的进程里是**混合**的——前半段是
/// 分号分隔的 Windows 目录，后半段整段塞进一个 `token`，里面又是 `/c/Users/...` 形态
/// 的 POSIX 列表，甚至带着 `%DevEco Studio%` 这种未展开的引用。`cmd /c` 与原生 exe
/// 只认分号分隔的 Windows 目录，混进去的 POSIX 段会让它找不到 `node` / `where`
/// （本机实测：沙箱钉同一份时 `cargo test mcp::tests` 全部红）。
///
/// 规则：分号切段；不含盘符前缀却含 `:` 的段按 POSIX 列表再切一层；
/// `/c/foo/bar` → `C:\foo\bar`；纯 POSIX 目录（`/usr/bin`）丢掉——原生进程本来就不认它。
/// 结果去重（大小写不敏感），保持首次出现顺序。非 Windows 恒返回 `None`（无混合形态）。
#[cfg(windows)]
pub fn native_path_from(raw: &OsStr) -> Option<OsString> {
    let raw = raw.to_string_lossy();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |entry: String| {
        if entry.is_empty() {
            return;
        }
        let key = entry.to_lowercase();
        if seen.insert(key) {
            out.push(entry);
        }
    };
    for token in raw.split(';') {
        // `C:\...` 自带盘符的是单个 Windows 目录；其余含 `:` 的是被塞进一个 token 的
        // POSIX 列表（`/mingw64/bin:/usr/bin:/c/Users/...`）。
        let is_drive_prefixed = token.len() >= 2
            && token.as_bytes()[1] == b':'
            && token.as_bytes()[0].is_ascii_alphabetic();
        let parts: Vec<&str> = if !is_drive_prefixed && token.contains(':') {
            token.split(':').collect()
        } else {
            vec![token]
        };
        for part in parts {
            if part.is_empty() {
                continue;
            }
            let bytes = part.as_bytes();
            let drive_form = part.starts_with('/')
                && bytes.len() >= 2
                && bytes[1].is_ascii_alphabetic()
                && (bytes.len() == 2 || bytes[2] == b'/');
            if drive_form {
                let drive = (bytes[1] as char).to_ascii_uppercase();
                let rest = part[2..].replace('/', "\\");
                push(format!("{drive}:{rest}"));
                continue;
            }
            if part.starts_with('/') {
                // 纯 POSIX 目录（`/usr/bin`、`/mingw64/bin`）：Windows 原生进程不认
                continue;
            }
            push(part.replace('/', "\\"));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(OsString::from(out.join(";")))
    }
}

#[cfg(not(windows))]
pub fn native_path_from(raw: &OsStr) -> Option<OsString> {
    let _ = raw;
    None
}

/// 测试专用：把解析结果钉死，用例不去跑真实的用户 shell。
///
/// `test_support::Sandbox::new` 在串行闸门内调用；重复调用以后一次为准——每个
/// 沙箱钉的都是自己的 PATH。不这么做的话每个跑命令的用例都要先执行用户的启动文件。
#[cfg(test)]
pub fn force_path_for_test(shell: OsString, native: OsString) {
    *TEST_FORCED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ShellPath { shell, native });
}

/// 测试专用：清除钉定（`Sandbox::drop` 调用）——覆盖只随沙箱存亡，沙箱销毁后
/// 恢复探测语义，沙箱外的用例看到的是真实探测结果。
#[cfg(test)]
pub fn clear_forced_path_for_test() {
    *TEST_FORCED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// 测试专用：钉死内置工具目录（`Sandbox::new` 钉空表，`Drop` 清除）。
///
/// 与 `TEST_FORCED` 分开存：PATH 探测与产物解析是两件事，用例可以只钉其中一个。
/// 沙箱钉空表，用例就不会因为开发机刚好构建过产物而得到不同结果。
#[cfg(test)]
pub fn force_bundled_dirs_for_test(dirs: Vec<std::path::PathBuf>) {
    *TEST_BUNDLED_DIRS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(dirs);
}

/// 测试专用：清除内置目录钉定
#[cfg(test)]
pub fn clear_bundled_dirs_for_test() {
    *TEST_BUNDLED_DIRS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

// ==================== 探测 ====================

/// 一次探测要做的事
#[derive(Debug)]
enum Probe {
    /// 用这些参数跑一次 shell，取它打印出来的 shell 形式
    Run {
        args: Vec<String>,
        /// 原生形式取进程环境里的 PATH（Windows 上的 bash：启动文件会把 PATH 重置，
        /// 进程环境里的 Windows PATH 才是用户终端里的那份）
        native_from_env: bool,
    },
    /// 该 shell 没有启动文件：两种形式都是进程环境里的 PATH
    Inherited,
}

fn probe(shell: &ShellInfo) -> Result<ShellPath, String> {
    match probe_plan(shell)? {
        Probe::Inherited => env_path().map(ShellPath::uniform),
        Probe::Run {
            args,
            native_from_env,
        } => {
            let output = run_probe(&shell.path, &args, PROBE_TIMEOUT)?;
            let shell = parse_shell_form(&output, native_from_env)?;
            let native = if native_from_env {
                env_path()?
            } else {
                shell.clone()
            };
            Ok(ShellPath { shell, native })
        }
    }
}

/// 进程环境里的 PATH（Windows 上是用户终端里的那份 Windows 形式）
fn env_path() -> Result<OsString, String> {
    std::env::var_os("PATH").ok_or_else(|| "进程环境里没有 PATH".to_string())
}

/// 各 shell 的探测方式（按可执行文件名分派，不看 `ShellInfo.kind`：
/// Unix 上 `kind` 恒为 `bash`，真正决定启动文件的是 `$SHELL` 指向谁）
fn probe_plan(shell: &ShellInfo) -> Result<Probe, String> {
    match shell_basename(&shell.path).as_str() {
        "bash" | "sh" | "dash" | "ksh" | "zsh" => {
            // 非 Windows 必须 `-l -i`：`-l` 读 login 文件（`.zprofile` / `.zlogin` /
            // `.profile`），`-i` 读 `.zshrc` / `.bashrc`——zsh 的 `.zshrc` 只在交互时
            // 读，少了 `-i` 就拿不到它里面的 PATH（launchd 只给最小 PATH）。
            //
            // Windows 上只用 `-c`：`-l` 会跑 `/etc/profile`，MSYS2 机器上它按
            // `MSYS2_PATH_TYPE` / `ORIGINAL_PATH` 重建 PATH，把用户环境变量里的目录
            // （`git` 所在的 Windows 目录等）整套换掉；而宿主启动 Core 时已经把用户
            // 完整的 Windows PATH 放进进程环境，不需要启动文件再补
            // （`specs/defects/windows-bash-probe-login-resets-path.md`）。
            let mut args: Vec<String> = Vec::new();
            if !cfg!(windows) {
                args.push("-l".to_string());
                args.push("-i".to_string());
            }
            args.push("-c".to_string());
            args.push(format!("printf '{SHELL_FORM_MARKER}%s' \"$PATH\""));
            Ok(Probe::Run {
                args,
                native_from_env: cfg!(windows),
            })
        }
        // PowerShell 的 profile（`$PROFILE`）默认加载，这里**不加** `-NoProfile`：
        // 用户配在 profile 里的 PATH 才是终端里看到的 PATH。它输出的本来就是 Windows
        // 形式，两种形式相同。
        "powershell" | "pwsh" => Ok(Probe::Run {
            args: vec![
                "-Command".to_string(),
                format!("[Console]::Out.Write('{SHELL_FORM_MARKER}' + $env:PATH)"),
            ],
            native_from_env: false,
        }),
        // cmd.exe 不读任何启动文件：它的 PATH 就是父进程给的，探测没有意义。
        "cmd" => Ok(Probe::Inherited),
        other => Err(format!(
            "无法从 {other} 解析 PATH：只覆盖 bash / zsh / sh / dash / ksh / powershell / cmd"
        )),
    }
}

fn shell_basename(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| path.to_lowercase())
}

fn run_probe(path: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    util::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 {path} 失败：{error}"))?;
    let Some(stdout) = child.stdout.take() else {
        return Err(format!("{path} 的标准输出不可读"));
    };
    let stderr = child.stderr.take();
    // 输出由独立线程读：启动文件打印大量内容时管道写满会让子进程阻塞，
    // 主线程还在等它退出，双方互等。缓冲区共享，主线程不必等读线程收尾——
    // 启动文件里起的后台进程会继承管道，读到 EOF 可能永远等不到。
    let out = drain(stdout);
    // stderr 留着给失败信息用：用户的启动文件报错时，那是唯一能定位问题的话
    let err = stderr.map(drain);
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let message = err.as_ref().map(|err| err.text()).unwrap_or_default();
                    return Err(format!(
                        "{path} 退出码 {:?}，没有取到 PATH{}",
                        status.code(),
                        failure_detail(&message)
                    ));
                }
                break;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{path} 在 {}s 内没有返回（启动文件太慢或卡住了）",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let _ = child.kill();
                return Err(format!("等待 {path} 退出失败：{error}"));
            }
        }
    }
    // 子进程已退出：给读线程一小段收尾时间，拿不到就按已读到的内容算
    out.wait_settled(Duration::from_millis(500));
    Ok(out.text())
}

/// 失败信息里的 stderr 尾巴：启动文件报错时它是唯一线索，截断避免刷屏
fn failure_detail(stderr: &str) -> String {
    let text = stderr.trim();
    if text.is_empty() {
        return String::new();
    }
    let tail: String = text
        .chars()
        .rev()
        .take(600)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("：{tail}")
}

/// 子进程的一条输出流：后台线程持续读进共享缓冲，主线程随时可以取当前内容。
///
/// 不 join 读线程——启动文件里起的后台进程会继承管道，EOF 可能永远不来。
struct Drained {
    buffer: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    drained: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drained {
    /// 等到读完（或到宽限时间）再取文本
    fn wait_settled(&self, grace: Duration) {
        let deadline = Instant::now() + grace;
        while !self.drained.load(std::sync::atomic::Ordering::Relaxed) && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn text(&self) -> String {
        let bytes = self
            .buffer
            .lock()
            .map(|buffer| buffer.clone())
            .unwrap_or_default();
        String::from_utf8_lossy(&bytes).to_string()
    }
}

fn drain(mut stream: impl Read + Send + 'static) -> Drained {
    let buffer = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let drained = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let buffer_for_thread = buffer.clone();
    let drained_for_thread = drained.clone();
    std::thread::spawn(move || {
        let mut chunk = [0u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => {
                    if let Ok(mut buffer) = buffer_for_thread.lock() {
                        buffer.extend_from_slice(&chunk[..read]);
                    }
                }
                Err(_) => break,
            }
        }
        drained_for_thread.store(true, std::sync::atomic::Ordering::Relaxed);
    });
    Drained { buffer, drained }
}

/// 从 shell 输出里取 shell 形式：启动文件打印的内容排在前面，按标记行认自己那行，
/// 并校验它像一条 PATH——不像就报错，而不是把垃圾注入环境。
///
/// Windows 上的 bash 输出的是 POSIX 列表（`:` 分隔，`native_from_env` 为真），其余场合
/// 就是平台自己的形式（Windows 是 `;`，POSIX 是 `:`）。
fn parse_shell_form(output: &str, native_from_env: bool) -> Result<OsString, String> {
    let value = marked_value(output, SHELL_FORM_MARKER)
        .ok_or_else(|| "shell 没有输出 PATH（启动文件可能提前退出）".to_string())?;
    let separator = if native_from_env {
        ':'
    } else {
        platform_separator()
    };
    if !looks_like_path(&value, separator) {
        return Err(format!("shell 输出的 PATH 不像 PATH：{value:?}"));
    }
    Ok(OsString::from(value))
}

/// 取最后一个带标记的行里的值（启动文件可能打印任意内容，标记只由探测脚本自己打）
fn marked_value(output: &str, marker: &str) -> Option<String> {
    output
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter_map(|line| line.trim().strip_prefix(marker))
        .last()
        .map(|value| value.trim().to_string())
}

fn platform_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

/// 一条 PATH 是否成立：含该形式的分隔符、是 POSIX 绝对路径，或本身是目录
fn looks_like_path(value: &str, separator: char) -> bool {
    value.contains(separator) || value.starts_with('/') || Path::new(value).is_dir()
}

#[cfg(test)]
#[path = "shell_env_tests.rs"]
mod tests;

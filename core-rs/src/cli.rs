//! 命令行解析（`docs/core-daemon.md` 第 3 节）。
//!
//! Standalone Core 用**动作**（子命令，裸词）选择做什么，`--host` / `--port` 这类
//! **选项**才带 `--`：
//! - `stdio`：单进程 Core，stdio 是帧通道（供宿主接入本地工作区）；
//! - `start`（缺省）：远程服务的启动器——确保后台 daemon 运行（不存在则创建），
//!   输出连接串后退出；
//! - `kill`：终止当前 daemon 及其全部工作区。
//!
//! `start` 是**启动器**：daemon 实体本身由隐藏动作 `start-daemon` 进入，那是启动器的
//! 内部实现，不出现在帮助里。
//!
//! 没有动作时按 `start` 处理（用户直接运行即启动远程服务）。

use crate::remote::RemoteOptions;

/// 解析结果。
#[derive(Debug, PartialEq)]
pub enum Command {
    /// `stdio`：单进程 Core，stdio 是帧通道（宿主默认模式）
    Stdio,
    /// `start`：确保后台 daemon 在跑，打印连接串后退出
    Start(RemoteOptions),
    /// `start-daemon`（隐藏动作，由 `start` 拉起）：TCP 是控制通道，绑定后常驻
    StartDaemon(RemoteOptions),
    /// `kill`：结束在跑的 daemon
    Kill,
    /// 打印帮助
    Help,
    /// 打印版本
    Version,
    /// 参数错误（调用方打印到 stderr 并以非零退出）
    Error(String),
}

/// 全部动作（子命令）；`start-daemon` 是内部动作，不出现在帮助里。
const ACTIONS: [&str; 4] = ["stdio", "start", "start-daemon", "kill"];

/// 吃掉下一个参数的选项（`--host 127.0.0.1` 形式）。
fn takes_value(arg: &str) -> bool {
    matches!(arg, "--host" | "--port" | "--token")
}

/// 程序名：取可执行文件名（打包后是 `tuxedo-cat-core`，开发期是 `standalone-core`）。
///
/// 不硬编码产品名：Rust 侧保持中性，对外展示的名字由分发时的文件名决定。
pub fn program_name() -> String {
    std::env::args()
        .next()
        .and_then(|path| {
            std::path::Path::new(&path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| env!("CARGO_PKG_NAME").to_string())
}

/// 版本行。
pub fn version() -> String {
    format!("{} {}", program_name(), env!("CARGO_PKG_VERSION"))
}

/// 帮助文本。
pub fn usage() -> String {
    let program = program_name();
    format!(
        "\
{version}
Tuxedo Cat 的 Standalone Core（独立进程）。

用法：
  {program} [动作] [选项]

动作（缺省 start）：
  stdio               单进程 Core：stdio 是帧通道（供宿主接入本地工作区）。
  start               确保后台 daemon 运行（不存在则创建），输出连接串后退出；
                      供桌面端接入远程工作区。
  kill                终止当前 daemon 及其全部工作区。

start 选项：
  --host <addr>       绑定地址（默认 0.0.0.0，即全部网卡；仅限本机访问时用
                      127.0.0.1）。
  --port <n>          绑定端口（默认 10975；被占用时从该值起逐个递增重试，
                      最多 20 次；0 表示由内核分配）。
  --token <token>     访问凭证；缺省时复用已保存的 token，缺失则随机生成。

通用选项：
  -h, --help          显示本帮助。
  -V, --version       显示版本号。
",
        version = version(),
        program = program
    )
}

/// 已知的选项名（含 `--name=value` 形式）。
fn is_known_flag(arg: &str) -> bool {
    matches!(
        arg,
        "--host" | "--port" | "--token" | "--help" | "-h" | "--version" | "-V"
    ) || ["--host=", "--port=", "--token="]
        .iter()
        .any(|prefix| arg.starts_with(prefix))
}

/// 解析命令行。`args` 不含程序名。
pub fn parse(args: &[String]) -> Command {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Command::Help;
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        return Command::Version;
    }

    // 动作是裸词、选项带 `--`：逐个走一遍，顺手校验「未知动作 / 未知选项」。
    // 带值的选项要连它的值一起跳过，否则 `--host 127.0.0.1` 的值会被当成动作。
    let mut actions: Vec<&str> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        if let Some(action) = ACTIONS.iter().find(|action| **action == arg) {
            actions.push(action);
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            if !is_known_flag(arg) {
                return Command::Error(format!("未知选项：{arg}"));
            }
            index += if takes_value(arg) { 2 } else { 1 };
            continue;
        }
        return Command::Error(format!("未知动作：{arg}"));
    }

    let mut actions = actions.into_iter();
    let action = actions.next();
    if let Some(extra) = actions.next() {
        return Command::Error(format!(
            "动作互斥：{} 与 {} 不能同时给出",
            action.unwrap_or(""),
            extra
        ));
    }

    match action {
        Some("stdio") => Command::Stdio,
        Some("start") => Command::Start(RemoteOptions::from_args(args)),
        Some("start-daemon") => Command::StartDaemon(RemoteOptions::from_args(args)),
        Some("kill") => Command::Kill,
        // 没有动作：默认 start（远程服务启动器）
        _ => Command::Start(RemoteOptions::from_args(args)),
    }
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;

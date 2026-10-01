//! 命令行解析（`docs/core-daemon.md` 第 3 节）。
//!
//! Standalone Core 用**动作**（子命令，裸词）选择做什么，`--host` / `--port` 这类
//! **选项**才带 `--`：
//! - `serve`（缺省）：单进程 Core，stdio 是帧通道；
//! - `start`：启动远程服务——确保后台 daemon 在跑（没有就拉起），打印连接信息后退出；
//! - `kill`：结束在跑的 daemon。
//!
//! `start` 是**启动器**：daemon 实体本身由隐藏动作 `start-daemon` 进入，那是启动器的
//! 内部实现，不出现在帮助里。
//!
//! 独立运行：直接运行且标准输入是终端时没有宿主喂帧，打印帮助而不是干等 stdin；
//! 从管道 / 宿主进程接入时（stdin 不是终端）仍按 `serve` 启动，保持原行为。

use std::io::IsTerminal;

use crate::remote::RemoteOptions;

/// 解析结果。
#[derive(Debug, PartialEq)]
pub enum Command {
    /// `serve`：单进程 Core，stdio 是帧通道（宿主默认模式）
    Serve,
    /// `start`：确保后台 daemon 在跑，打印 `IP:端口` 与 token 后退出
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
const ACTIONS: [&str; 4] = ["serve", "start", "start-daemon", "kill"];

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

动作（缺省 serve；直接运行且标准输入是终端时打印本帮助）：
  serve                单进程 Core：stdio 是帧通道（宿主拉起本地工作区用）。
  start                启动远程服务：确保后台 daemon 在跑（没有就拉起），打印
                       IP:端口 与 token 后退出，桌面端据此接入远程工作区。
  kill                 结束在跑的 daemon（连同它的全部工作区）。

start 选项：
  --host <addr>        绑定地址（默认 127.0.0.1，只绑回环；跨机接入用 0.0.0.0）。
  --port <n>           绑定端口（默认 10975；被占用时逐个 +1 重试）。
  --token <token>      指定 token（缺省时复用已落盘的 token，没有才随机生成）。

其它：
  -h, --help           打印本帮助。
  -V, --version        打印版本。
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
        Some("serve") => Command::Serve,
        Some("start") => Command::Start(RemoteOptions::from_args(args)),
        Some("start-daemon") => Command::StartDaemon(RemoteOptions::from_args(args)),
        Some("kill") => Command::Kill,
        // 没有动作：宿主经管道接入时是 serve；直接运行（终端）时打印帮助
        _ if std::io::stdin().is_terminal() => Command::Help,
        _ => Command::Serve,
    }
}

#[cfg(test)]
#[path = "cli_tests.rs"]
mod tests;

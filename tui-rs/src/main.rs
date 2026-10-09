//! TUI 入口（docs/tui.md 第 2 节；`src/tui/render/main.ts` 的移植）。
//!
//! 用法：
//!   <本程序> [--workspace <dir>] [--verbose] [--version]
//!
//! - `--workspace`：唯一本地工作区（默认当前目录）；
//! - Core 形态只有 Standalone：本进程按需 spawn `<core-binary> stdio`，stdio 即帧通道
//!   （产物部署由独立安装程序负责，见 `core_root.rs`）——Rust 宿主没有 TS Embedded
//!   形态，`--core` 参数不再存在。
//!
//! 线程模型（与 core-rs 的阻塞模型契合，不用异步运行时）：
//! - 主线程：crossterm 事件循环 + ratatui 整帧重绘；
//! - 读线程：阻塞读 Core 的 stdout，逐帧转发给主循环（mpsc）；
//! - 写入：主线程独占 child stdin（帧从 host 的 outbox 排出）。

mod app;
mod choices;
mod composer;
mod conversations;
mod core_root;
mod diffview;
mod host;
mod i18n;
mod markdown;
mod protocol;
mod settings;
mod store;
mod ui_state;

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::Arc;

use crossterm::event::{Event, KeyEventKind};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen};
use crossterm::{execute, tty::IsTty};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use app::App;
use host::Logger;
use protocol::{CoreToUiFrame, UiToCoreFrame};

const TUI_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 程序名：取可执行文件名（打包后是部署的 `tui`，开发期是 crate 产物名）。
///
/// 不硬编码产品名：Rust 侧保持中性，对外展示的名字由分发时的文件名决定
/// （与 `core-rs/src/cli.rs` 的 `program_name` 同一口径）。
fn program_name() -> String {
    std::env::args()
        .next()
        .and_then(|path| {
            std::path::Path::new(&path)
                .file_stem()
                .map(|stem| stem.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| env!("CARGO_PKG_NAME").to_string())
}

/// 主循环事件（core 帧 / core 退出；键盘事件在主线程直接读）。
enum CoreEvent {
    Frame(CoreToUiFrame),
    Exited,
}

struct CliArgs {
    workspace: std::path::PathBuf,
    verbose: bool,
    version: bool,
}

fn parse_args() -> CliArgs {
    let mut args = CliArgs {
        workspace: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        verbose: false,
        version: false,
    };
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut index = 0;
    while index < argv.len() {
        match argv[index].as_str() {
            "--workspace" | "-w" => {
                index += 1;
                if let Some(dir) = argv.get(index) {
                    args.workspace = std::path::PathBuf::from(dir);
                }
            }
            "--verbose" | "-v" => args.verbose = true,
            "--version" => args.version = true,
            other => {
                eprintln!("未知参数：{other}");
                eprintln!("用法：{} [--workspace <dir>] [--verbose] [--version]", program_name());
                std::process::exit(2);
            }
        }
        index += 1;
    }
    args
}

fn main() {
    let args = parse_args();
    if args.version {
        // 产品名取部署产品目录名（project.json 的 core.deployPrefix，build.rs 烧入）
        println!("{} tui {TUI_VERSION} (core=standalone)", env!("TC_DEPLOY_PREFIX"));
        return;
    }

    // Core 产物根：安装程序的前缀或开发仓库（找不到直接报错，不静默降级）。
    // 放在 TTY 检查之前：非交互环境下「产物缺失 / 装错位置」也能得到可行动的报错。
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let (core_root, core_binary) = match core_root::resolve_core_root(&exe_dir) {
        Ok(resolved) => resolved,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(1);
        }
    };

    // TTY 守卫（docs/tui.md 第 11.1 节风险 1）：raw mode 需要交互式终端；
    // 老 conhost 与重定向管道不支持——渲染前显式拦截，给出可行动的报错。
    if !std::io::stdin().is_tty() || !std::io::stdout().is_tty() {
        eprintln!(
            "TUI 需要交互式终端（raw mode）：请在 Windows Terminal / VS Code 终端等现代终端中运行，不要重定向 stdin/stdout。"
        );
        std::process::exit(1);
    }

    let workspace = args.workspace.canonicalize().unwrap_or(args.workspace.clone());
    let log = Arc::new(Logger::new(
        Some(settings::config_dir().join("tui-rs.log")),
        args.verbose,
    ));
    log.log(&format!(
        "[tui] start workspace={} coreRoot={} core={}",
        workspace.display(),
        core_root.display(),
        core_binary.display()
    ));

    // 配置与语言：启动期同步读盘（webview 首帧要同步取值的同构需求），语言经
    // prime_locale 收敛（settings.uiLanguage → 宿主 locale → 系统语言）
    let mut settings_store = settings::SettingsStore::new();
    settings_store.load();
    i18n::prime_locale(&i18n::system_locale(), settings_store.ui_language());

    let mut child = match spawn_core(&core_binary, &log) {
        Ok(child) => child,
        Err(error) => {
            eprintln!("TUI 启动失败：无法启动 Core（{}）：{error}", core_binary.display());
            std::process::exit(1);
        }
    };

    // 握手：hello → ready（读线程转发 Ready 帧，host 在收到后推 hostEnvironmentProvided）
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    if let Err(error) = stdin.write_all(UiToCoreFrame::Hello.encode().unwrap_or_default().as_bytes()) {
        eprintln!("TUI 启动失败：Core 握手写入失败：{error}");
        let _ = child.kill();
        std::process::exit(1);
    }
    let _ = stdin.flush();

    let (sender, receiver) = std::sync::mpsc::channel::<CoreEvent>();
    let reader = spawn_reader(stdout, sender, Arc::clone(&log));

    let host = host::Host::new(
        Arc::clone(&log),
        settings_store,
        workspace.display().to_string(),
        core_root,
    );
    let mut app = App::new(host);

    let result = run_loop(&mut app, &mut stdin, &mut child, receiver);

    // 退出路径：shutdown 帧 → 关闭 stdin → Core 随 EOF 退出（不等长，直接收尸）
    let _ = stdin.write_all(UiToCoreFrame::Shutdown.encode().unwrap_or_default().as_bytes());
    let _ = stdin.flush();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let _ = reader.join();

    if let Err(error) = result {
        eprintln!("TUI 异常退出：{error}");
        std::process::exit(1);
    }
}

/// 启动 Core 子进程（stdio 是帧通道；Windows 上隐藏控制台窗口）。
fn spawn_core(core_binary: &std::path::Path, log: &Arc<Logger>) -> std::io::Result<Child> {
    let mut command = Command::new(core_binary);
    command.arg("stdio").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不闪控制台窗口（对齐 TS 侧 spawn 的 windowsHide）
        command.creation_flags(0x0800_0000);
    }
    log.log(&format!("[tui] spawning core: {} stdio", core_binary.display()));
    command.spawn()
}

/// 读线程：阻塞读 Core stdout，逐帧转发；EOF（Core 退出）转发 Exited。
fn spawn_reader(
    stdout: std::process::ChildStdout,
    sender: std::sync::mpsc::Sender<CoreEvent>,
    log: Arc<Logger>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        loop {
            match protocol::FrameDecoder::read_from(&mut reader) {
                Ok(Some(frame)) => {
                    if sender.send(CoreEvent::Frame(frame)).is_err() {
                        break; // 主循环已退出
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    log.log(&format!("[tui] core stdout read error: {error}"));
                    break;
                }
            }
        }
        let _ = sender.send(CoreEvent::Exited);
    })
}

/// 主循环：crossterm 事件 + core 帧 → App；每轮全帧重绘。
fn run_loop(
    app: &mut App,
    stdin: &mut std::process::ChildStdin,
    child: &mut Child,
    receiver: Receiver<CoreEvent>,
) -> Result<(), Box<dyn std::error::Error>> {
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    // bracketed paste：多行粘贴作为单个 Paste 事件到达（不支持的终端静默降级，
    // 与 TS/Ink 的能力边界一致）
    let _ = execute!(stdout, EnterAlternateScreen, crossterm::event::EnableBracketedPaste);
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    // panic 时也要恢复终端（否则用户终端坏掉）
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(std::io::stdout(), LeaveAlternateScreen);
        original_hook(info);
    }));

    let result = event_loop(app, stdin, child, receiver, &mut terminal);

    let _ = disable_raw_mode();
    let _ = execute!(terminal.backend_mut(), LeaveAlternateScreen, crossterm::event::DisableBracketedPaste);
    let _ = terminal.show_cursor();
    result
}

fn event_loop(
    app: &mut App,
    stdin: &mut std::process::ChildStdin,
    _child: &mut Child,
    receiver: Receiver<CoreEvent>,
    terminal: &mut Terminal<CrosstermBackend<std::io::Stdout>>,
) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        // 1. core 帧（不等待：非阻塞排空）
        loop {
            match receiver.try_recv() {
                Ok(CoreEvent::Frame(frame)) => app.handle_frame(frame),
                Ok(CoreEvent::Exited) => {
                    app.handle_core_exited();
                    app.exit();
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    app.handle_core_exited();
                    app.exit();
                    break;
                }
            }
        }

        // 2. 键盘 / 粘贴 / 窗口事件（80ms 预算：兼顾帧率与延迟）
        if crossterm::event::poll(std::time::Duration::from_millis(80))? {
            match crossterm::event::read()? {
                Event::Key(key) => {
                    // Windows conpty 会同时发 Press / Release：只吃 Press
                    if key.kind == KeyEventKind::Press {
                        app.handle_key(key);
                    }
                }
                Event::Paste(text) => app.handle_paste(&text),
                _ => {}
            }
        } else {
            // 空闲 tick：通知消散 / spinner 动画 / 斜杠回填
            app.tick();
        }

        // 3. 上行帧（host outbox → core stdin）
        for frame in app.host.drain_outbox() {
            let encoded = frame.encode()?;
            stdin.write_all(encoded.as_bytes())?;
        }
        stdin.flush()?;

        // 4. 重绘
        terminal.draw(|frame| app.draw(frame))?;

        if app.is_exiting() {
            return Ok(());
        }
    }
}

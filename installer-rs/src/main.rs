//! TUI 版安装程序（docs/tui-installer.md）：内嵌 Core / ripgrep / TUI bundle 的自解压安装器。
//!
//! 用法：
//!   tuxedo-cat-tui-installer [--prefix <dir>] [--print-prefix] [--version] [--help]
//!
//! - 默认安装前缀 `~/.tuxedo-cat/tui`（`src/config/project.json` 的 configDir；
//!   TUI 侧 `src/tui/coreRoot.ts` 按同一前缀探测）；
//! - 安装布局与 Electron 应用内一致：`<prefix>/tui.mjs` +
//!   `<prefix>/resources/core/<arch>-<platform>/`——TUI 沿用
//!   `resolveCoreBinary(extensionPath)` 的同一搜索路径，无需特判；
//! - 幂等：内容未变的文件跳过（保留可执行位），重复运行无副作用；
//! - 落盘原子：先写同目录临时文件再改名，中断不会留下半个文件。

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod payload {
    include!(concat!(env!("OUT_DIR"), "/payload.rs"));
}

/// 默认安装前缀：`~/.tuxedo-cat/tui`（与 src/config/project.json 的 configDir 一致）
fn home_dir() -> PathBuf {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .expect("无法确定用户主目录（USERPROFILE / HOME 均未设置）");
    PathBuf::from(home)
}

fn default_prefix() -> PathBuf {
    home_dir().join(".tuxedo-cat").join("tui")
}

fn print_usage() {
    println!(
        "Tuxedo Cat TUI 安装程序（自解压）：把 Standalone Core、捆绑 ripgrep 与 TUI bundle\n\
         安装到本机用户目录。\n\n\
         用法：tuxedo-cat-tui-installer [--prefix <dir>] [--print-prefix] [--version]\n\n\
         --prefix <dir>   安装前缀（默认 ~/.tuxedo-cat/tui）\n\
         --print-prefix   只打印默认前缀并退出\n\
         --version        打印版本与内嵌载荷摘要\n\
         安装后运行：node <prefix>/tui.mjs（需要 Node.js >= 18）"
    );
}

struct Args {
    prefix: Option<PathBuf>,
    print_prefix: bool,
    version: bool,
    help: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args { prefix: None, print_prefix: false, version: false, help: false };
    let mut it = env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--prefix" => {
                let value = it.next().ok_or("--prefix 需要一个目录参数")?;
                args.prefix = Some(PathBuf::from(value));
            }
            "--print-prefix" => args.print_prefix = true,
            "--version" => args.version = true,
            "--help" | "-h" => args.help = true,
            other => return Err(format!("无法识别的参数：{other}（--help 查看用法）")),
        }
    }
    Ok(args)
}

/// 文件内容与内嵌字节是否一致（幂等判断；逐字节比较，载荷只有数 MB）
fn same_content(path: &Path, bytes: &[u8]) -> bool {
    match fs::read(path) {
        Ok(existing) => existing == bytes,
        Err(_) => false,
    }
}

/// unix 下设置可执行位（0o755：可执行文件被改名或首次落盘时统一补齐）
#[cfg(unix)]
fn mark_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)
}

#[cfg(windows)]
fn mark_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn install(prefix: &Path) -> io::Result<()> {
    println!("安装前缀：{}", prefix.display());
    println!("内嵌载荷：{}（Core / ripgrep / TUI bundle）", payload::TARGET_PKG);
    let mut installed = 0usize;
    let mut unchanged = 0usize;
    let mut total_bytes = 0u64;

    for (rel, bytes, executable) in payload::FILES {
        let dest = prefix.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        if same_content(&dest, bytes) {
            // 内容未变：保留现状（不重写，可执行位也保持原样）
            unchanged += 1;
            println!("  未变化：{rel}");
            continue;
        }
        // 同目录临时文件 + 改名：中断不留半个目标文件
        let tmp = dest.with_extension("tmp-install");
        fs::write(&tmp, bytes)?;
        if *executable {
            mark_executable(&tmp)?;
        }
        // Windows 的 rename 不覆盖既有文件：先移除旧文件（内容已确认不同）
        if dest.exists() {
            fs::remove_file(&dest)?;
        }
        fs::rename(&tmp, &dest)?;
        installed += 1;
        total_bytes += bytes.len() as u64;
        println!("  已安装：{rel}（{} 字节）", bytes.len());
    }

    println!(
        "完成：{installed} 个文件更新、{unchanged} 个未变化（{} KB 写入）。",
        total_bytes / 1024
    );
    println!("运行 TUI：node {}", prefix.join("tui.mjs").display());
    Ok(())
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}");
            return ExitCode::from(2);
        }
    };
    if args.help {
        print_usage();
        return ExitCode::SUCCESS;
    }
    if args.print_prefix {
        println!("{}", default_prefix().display());
        return ExitCode::SUCCESS;
    }
    if args.version {
        let total: usize = payload::FILES.iter().map(|(_, bytes, _)| bytes.len()).sum();
        println!(
            "tuxedo-cat-tui-installer {}（载荷 {}，内嵌 {} 个文件 / {} KB）",
            payload::VERSION,
            payload::TARGET_PKG,
            payload::FILES.len(),
            total / 1024
        );
        return ExitCode::SUCCESS;
    }
    let prefix = args.prefix.unwrap_or_else(default_prefix);
    match install(&prefix) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("安装失败：{err}");
            ExitCode::FAILURE
        }
    }
}

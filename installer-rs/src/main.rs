//! TUI 版安装程序（docs/tui-installer.md）：内嵌 Core / ripgrep / TUI 二进制的自解压安装器。
//!
//! 用法：
//!   tuxedo-cat-tui-installer [--prefix <dir>] [--print-prefix] [--version] [--help]
//!
//! - 部署布局（构建期嵌进载荷，见 build.rs）：
//!   `<prefix>/share/<产品名>/<指纹>/tuxedo-cat-core[.exe]`（按指纹的槽位）、
//!   `<prefix>/share/<产品名>/ripgrep/rg[.exe]`（全部槽位共享一份）、
//!   `<prefix>/share/<产品名>/tui[.exe]`；
//! - 默认安装前缀 `~/.local/bin`（PATH 已含的目录，装完即用；Windows 没有这个
//!   惯例，落在 `~/.tuxedo-cat/bin`，自担 PATH）；`--prefix <dir>` 覆盖；
//! - unix 额外建软链接 `~/.local/bin/<产品名>` → 产品目录里的 `tui`（相对目标，
//!   前缀整体挪动不断链）：旧布局的拷贝或指向不同的旧链接会被原子换名替换；
//! - 幂等：内容未变的文件跳过（保留可执行位），链接已指向正确目标时跳过；
//! - 落盘原子：先写同目录临时文件再改名，中断不会留下半个文件。

use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

mod payload {
    include!(concat!(env!("OUT_DIR"), "/payload.rs"));
}

/// 产品命令名（软链接名）：`src/config/project.json` 的 `core.deployPrefix`，
/// 也是载荷里产品目录段（`share/<产品名>`）的来源
fn product_name() -> &'static str {
    payload::PRODUCT_DIR.split_once('/').map(|(_, name)| name).unwrap_or(payload::PRODUCT_DIR)
}

/// 默认安装前缀：unix 是 `~/.local/bin`（PATH 惯例目录）；Windows 没有
/// `~/.local/bin` 惯例，落在 `~/.tuxedo-cat/bin`，加不加 PATH 由用户决定
fn default_prefix() -> PathBuf {
    let dir = if cfg!(windows) {
        [".tuxedo-cat", "bin"]
    } else {
        [".local", "bin"]
    };
    let mut prefix = home_dir();
    for segment in dir {
        prefix.push(segment);
    }
    prefix
}

fn home_dir() -> PathBuf {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .expect("无法确定用户主目录（USERPROFILE / HOME 均未设置）");
    PathBuf::from(home)
}

fn run_hint(prefix: &Path) -> String {
    if cfg!(unix) {
        format!("{}", prefix.join(product_name()).display())
    } else {
        format!("{}", prefix.join(payload::TUI_REL).display())
    }
}

fn print_usage() {
    println!(
        "Tuxedo Cat TUI 安装程序（自解压）：把 Standalone Core、捆绑 ripgrep 与 TUI 二进制\n\
         安装到本机部署布局。\n\n\
         用法：tuxedo-cat-tui-installer [--prefix <dir>] [--print-prefix] [--version]\n\n\
         --prefix <dir>   安装前缀（默认 ~/.local/bin，Windows 为 ~/.tuxedo-cat/bin）\n\
         --print-prefix   只打印默认前缀并退出\n\
         --version        打印版本、构建指纹与内嵌载荷摘要\n\
         安装布局：<prefix>/share/<产品名>/<指纹>/core + ripgrep + tui（构建指纹见 --version）；\n\
         unix 上另有软链接 <prefix>/<产品名> 指向 TUI，装完直接运行（无需 Node.js）。"
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

/// 建软链接 `<prefix>/<产品名>` → 产品目录里的 `tui`（unix；Windows 无此步）。
///
/// 软链接让 `~/.local/bin`（已在 PATH）直接可用：TUI 升级换指纹槽位时链接目标
/// `share/<产品名>/tui` 不变，无需重建。已指向正确目标时跳过（幂等）；旧布局的
/// 拷贝或指向不同的旧链接换成新链接（临时链接 + rename 原子换名）；同名目录
/// 不是本安装器建的东西，报错让用户自己处理，不删除。
#[cfg(unix)]
fn install_launch_link(prefix: &Path) -> io::Result<bool> {
    use std::os::unix::fs::symlink;

    let link = prefix.join(product_name());
    // 相对目标：相对链接所在目录解析，前缀整体挪动不断链
    let target = format!("{}/{}", payload::PRODUCT_DIR, payload::TUI_REL);

    let needs_update = match fs::symlink_metadata(&link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            fs::read_link(&link).is_ok_and(|current| current != Path::new(&target))
        }
        Ok(meta) if meta.is_dir() => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} 已存在且是目录，请手动处理后重装", link.display()),
            ));
        }
        Ok(_) => true, // 旧布局的普通文件拷贝：重建为软链接
        Err(_) => true,
    };
    if !needs_update {
        println!("  未变化：{}", link.display());
        return Ok(false);
    }

    // 临时链接 + 原子换名：并发安装各用各的临时名，rename 只换目录项，
    // 正在通过旧链接跑 TUI 的进程不受影响
    let staging = prefix.join(format!(
        ".{}.{}.new",
        product_name(),
        std::process::id()
    ));
    let _ = fs::remove_file(&staging);
    symlink(&target, &staging)?;
    fs::rename(&staging, &link)?;
    println!("  已安装：{} → {}", link.display(), target);
    Ok(true)
}

/// Windows 没有软链接步骤（符号链接要特权）：TUI 直接以产品目录里的路径运行
#[cfg(windows)]
fn install_launch_link(_prefix: &Path) -> io::Result<bool> {
    Ok(false)
}

fn install(prefix: &Path) -> io::Result<()> {
    println!("安装前缀：{}", prefix.display());
    println!(
        "内嵌载荷：{}（指纹 {}，Core / ripgrep / TUI 二进制）",
        payload::TARGET_PKG,
        payload::FINGERPRINT
    );
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

    if install_launch_link(prefix)? {
        installed += 1;
    } else if cfg!(unix) {
        unchanged += 1;
    }

    println!(
        "完成：{installed} 项更新、{unchanged} 项未变化（{} KB 写入）。",
        total_bytes / 1024
    );
    println!("运行 TUI：{}", run_hint(prefix));
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
            "tuxedo-cat-tui-installer {}（载荷 {}，指纹 {}，内嵌 {} 个文件 / {} KB）",
            payload::VERSION,
            payload::TARGET_PKG,
            payload::FINGERPRINT,
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

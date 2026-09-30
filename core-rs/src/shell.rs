//! Shell 检测（对齐 `src/core/tools/bash/ShellDetector.ts` 的优先级）。
//!
//! Windows：Git Bash > 常见安装路径的 bash > PATH 里的 bash > PowerShell > cmd.exe。
//! 模型按 bash 语法写命令，因此 Windows 上必须优先落到 Git Bash；
//! cmd.exe 只在全部探测失败时兜底。
//!
//! 所有探测都经 `util::hide_console`，不产生可见的控制台窗口。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::util;

#[derive(Clone, Debug)]
pub struct ShellInfo {
    /// `bash` / `powershell` / `cmd`
    #[cfg_attr(not(test), allow(dead_code))]
    pub kind: String,
    pub path: String,
    pub args: Vec<String>,
    /// 展示名（如 `bash (Git Bash)`），进系统提示的环境段
    pub name: String,
}

static CACHED_SHELL: Mutex<Option<ShellInfo>> = Mutex::new(None);

/// 当前 shell（首次调用时探测并缓存）
pub fn shell() -> ShellInfo {
    if let Some(cached) = CACHED_SHELL.lock().unwrap().clone() {
        return cached;
    }
    let detected = detect();
    *CACHED_SHELL.lock().unwrap() = Some(detected.clone());
    detected
}

fn detect() -> ShellInfo {
    if !cfg!(windows) {
        let path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        return ShellInfo {
            kind: "bash".to_string(),
            path,
            args: vec!["-c".to_string()],
            name: "bash".to_string(),
        };
    }

    if let Some(bash) = detect_bash_from_git_dir()
        .or_else(detect_bash_from_common_paths)
        .or_else(detect_bash_from_path)
    {
        return bash;
    }
    if let Some(powershell) = detect_powershell() {
        return powershell;
    }
    ShellInfo {
        kind: "cmd".to_string(),
        path: "cmd.exe".to_string(),
        args: vec!["/s".to_string(), "/c".to_string()],
        name: "cmd".to_string(),
    }
}

// ==================== bash ====================

/// 由 `git.exe` 的安装位置推断 Git Bash（最靠谱的方式）
fn detect_bash_from_git_dir() -> Option<ShellInfo> {
    let git_path = where_first("git")?;
    let git_dir = strip_suffix_ci(&git_path, "\\git.exe")
        .or_else(|| strip_suffix_ci(&git_path, "/git.exe"))
        .unwrap_or(git_path);
    let git_dir = strip_suffix_ci(&git_dir, "\\cmd")
        .or_else(|| strip_suffix_ci(&git_dir, "/cmd"))
        .unwrap_or(git_dir);

    for candidate in [
        Path::new(&git_dir).join("bin").join("bash.exe"),
        Path::new(&git_dir).join("usr").join("bin").join("bash.exe"),
    ] {
        if let Some(shell) = try_bash(&candidate, "bash (Git Bash)") {
            return Some(shell);
        }
    }
    None
}

/// 常见 Git Bash / MSYS2 / Cygwin 安装路径
fn detect_bash_from_common_paths() -> Option<ShellInfo> {
    let username = std::env::var("USERNAME").unwrap_or_default();
    let candidates: Vec<String> = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
        r"C:\Git\bin\bash.exe",
        r"C:\Git\usr\bin\bash.exe",
        r"D:\Git\bin\bash.exe",
        r"D:\Git\usr\bin\bash.exe",
        r"E:\Git\bin\bash.exe",
        r"E:\Git\usr\bin\bash.exe",
        r"C:\Users\%USERNAME%\scoop\apps\git\current\usr\bin\bash.exe",
        r"C:\Users\%USERNAME%\scoop\apps\git\current\bin\bash.exe",
        r"C:\ProgramData\chocolatey\lib\git\tools\usr\bin\bash.exe",
        r"C:\msys64\usr\bin\bash.exe",
        r"C:\msys32\usr\bin\bash.exe",
        r"C:\cygwin64\bin\bash.exe",
        r"C:\cygwin\bin\bash.exe",
        "/bin/bash",
        "/usr/local/bin/bash",
        "/usr/bin/bash",
    ]
    .iter()
    .map(|path| path.replace("%USERNAME%", &username))
    .collect();

    for candidate in candidates {
        let path = PathBuf::from(&candidate);
        if !path.exists() {
            continue;
        }
        if let Some(shell) = try_bash(&path, common_path_bash_name(&candidate)) {
            return Some(shell);
        }
    }
    None
}

/// 常见安装路径的展示名（对齐 Embedded `detectBashFromCommonPaths` 的分支：
/// 含 git → Git Bash，含 msys → MSYS2，含 cygwin → Cygwin，否则 bash）。
fn common_path_bash_name(path_text: &str) -> &'static str {
    let lower = path_text.to_lowercase();
    if lower.contains("git") {
        "bash (Git Bash)"
    } else if lower.contains("msys") {
        "bash (MSYS2)"
    } else if lower.contains("cygwin") {
        "bash (Cygwin)"
    } else {
        "bash"
    }
}

/// PATH 里的 bash
fn detect_bash_from_path() -> Option<ShellInfo> {
    let bash_path = where_first("bash")?;
    // 对齐 Embedded `detectBashFromPath`：只看是否含 `git`，其余一律 `bash`
    let name = if bash_path.to_lowercase().contains("git") {
        "bash (Git Bash)"
    } else {
        "bash"
    };
    try_bash(Path::new(&bash_path), name)
}

fn try_bash(path: &Path, name: &str) -> Option<ShellInfo> {
    if !path.exists() {
        return None;
    }
    let path_text = path.to_string_lossy().to_string();
    if !test_shell(&path_text, &["--version"]) {
        return None;
    }
    Some(ShellInfo {
        kind: "bash".to_string(),
        path: path_text,
        args: vec!["-c".to_string()],
        name: name.to_string(),
    })
}

// ==================== PowerShell ====================

fn detect_powershell() -> Option<ShellInfo> {
    for candidate in ["powershell.exe", "pwsh.exe"] {
        if test_shell(candidate, &["-Command", "echo test"]) {
            return Some(ShellInfo {
                kind: "powershell".to_string(),
                path: candidate.to_string(),
                args: vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                ],
                name: "PowerShell".to_string(),
            });
        }
    }
    None
}

// ==================== 探测工具 ====================

/// `where.exe <name>` 的第一行结果（Windows）
fn where_first(name: &str) -> Option<String> {
    let mut command = Command::new("where.exe");
    command
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    util::hide_console(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // 对齐 `ShellDetector.ts` 的 `stdout.trim().split(/\r?\n/)[0].trim()`（JS 空白口径）
    text.lines()
        .map(util::js_trim)
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

/// 探测 shell 是否可执行（退出码 0 视为可用），5s 上限
fn test_shell(path: &str, args: &[&str]) -> bool {
    let mut command = Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    util::hide_console(&mut command);
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    return false;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return false,
        }
    }
}

/// 大小写不敏感的后缀剥离
fn strip_suffix_ci(value: &str, suffix: &str) -> Option<String> {
    if value.len() < suffix.len() {
        return None;
    }
    let split = value.len() - suffix.len();
    // 用 get() 而不是直接切片：非 ASCII 路径下 split 可能不在字符边界上
    let tail = value.get(split..)?;
    if tail.eq_ignore_ascii_case(suffix) {
        value.get(..split).map(|head| head.to_string())
    } else {
        None
    }
}


#[cfg(test)]
#[path = "shell_tests.rs"]
mod tests;

//! `shell_env` 的单测：探测参数、输出解析、超时与注入点。

use std::ffi::OsString;
use std::time::Duration;

use super::*;
use crate::shell::ShellInfo;

fn shell_at(path: &str) -> ShellInfo {
    ShellInfo {
        kind: "bash".to_string(),
        path: path.to_string(),
        args: vec!["-c".to_string()],
        name: "test".to_string(),
    }
}

/// 与平台一致的一条样例 PATH（`looks_like_path` 要求含分隔符或本身是目录）
fn sample_path() -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    format!("/a/bin{separator}/b/bin")
}

fn probe_args(shell: &ShellInfo) -> Vec<String> {
    match probe_plan(shell).expect("探测计划应当成立") {
        Probe::Run(args) => args,
        Probe::Inherited => panic!("该 shell 应当走探测，而不是沿用进程环境"),
    }
}

#[test]
fn bash_probe_uses_login_and_interactive_shell() {
    let args = probe_args(&shell_at("/bin/zsh"));
    assert_eq!(args[0], "-l", "login：读 .zprofile / .zlogin");
    assert_eq!(args[1], "-i", "interactive：读 .zshrc / .bashrc");
    assert_eq!(args[2], "-c");
    assert!(args[3].contains("$PATH"), "探测脚本要取 PATH：{}", args[3]);
}

#[test]
fn bash_probe_script_matches_platform() {
    let args = probe_args(&shell_at("/bin/bash"));
    assert!(
        args[3].contains(SHELL_FORM_MARKER),
        "探测脚本要打 shell 形式的标记：{}",
        args[3]
    );
    if cfg!(windows) {
        // Git Bash 的 PATH 是 POSIX 形式（shell 子进程直接用这份）；原生子进程要的
        // Windows 形式由逐条 `cygpath -w` 派生，标记行跟在 shell 形式后面。
        assert!(args[3].contains(NATIVE_FORM_MARKER), "{}", args[3]);
        assert!(args[3].contains("cygpath -w --"), "{}", args[3]);
    } else {
        assert!(args[3].contains("printf"), "{}", args[3]);
        assert!(!args[3].contains("cygpath"), "{}", args[3]);
    }
}

#[test]
fn powershell_probe_reads_env_path() {
    let args = probe_args(&shell_at("powershell.exe"));
    assert_eq!(args[0], "-Command");
    assert!(args[1].contains("$env:PATH"));
    assert!(
        !args.contains(&"-NoProfile".to_string()),
        "profile 里的 PATH 才是终端里的 PATH"
    );
}

#[test]
fn cmd_has_no_startup_file() {
    assert!(matches!(
        probe_plan(&shell_at("cmd.exe")).expect("cmd 是已知 shell"),
        Probe::Inherited
    ));
}

#[test]
fn unknown_shell_is_rejected_loudly() {
    let error = probe_plan(&shell_at("/usr/bin/fish")).expect_err("fish 不在覆盖范围内");
    assert!(error.contains("fish"), "{error}");
}

#[test]
fn parse_output_takes_marked_lines() {
    // 启动文件打印的内容排在前面，按标记认探测脚本自己打的那行
    let output = format!(
        "welcome back\n{SHELL_FORM_MARKER}{path}\n",
        path = sample_path()
    );
    let parsed = parse_output(&output).expect("应当解析出 PATH");
    assert_eq!(parsed.shell(), OsString::from(sample_path()).as_os_str());
    assert_eq!(
        parsed.native(),
        parsed.shell(),
        "没有原生形式那一行时两种形式相同"
    );
}

#[test]
fn parse_output_reads_both_forms() {
    let output = format!(
        "{SHELL_FORM_MARKER}/usr/bin:/c/foo\n{NATIVE_FORM_MARKER}C:\\Program Files\\Git\\usr\\bin;C:\\foo"
    );
    let parsed = parse_output(&output).expect("应当解析出两种形式");
    assert_eq!(parsed.shell(), std::ffi::OsStr::new("/usr/bin:/c/foo"));
    assert_eq!(
        parsed.native(),
        std::ffi::OsStr::new(r"C:\Program Files\Git\usr\bin;C:\foo")
    );
}

#[test]
fn parse_output_strips_carriage_return() {
    let output = format!("{SHELL_FORM_MARKER}{}\r\n", sample_path());
    let parsed = parse_output(&output).expect("应当解析出 PATH");
    assert_eq!(parsed.shell(), OsString::from(sample_path()).as_os_str());
}

#[test]
fn parse_output_rejects_empty_output() {
    let error = parse_output("\n\n").expect_err("空输出必须报错，不能降级");
    assert!(error.contains("没有输出"), "{error}");
}

#[test]
fn parse_output_rejects_output_that_is_not_a_path() {
    let error = parse_output(&format!("{SHELL_FORM_MARKER}good morning\n"))
        .expect_err("不像 PATH 就必须报错");
    assert!(error.contains("不像 PATH"), "{error}");
}

#[test]
fn apply_and_apply_native_write_their_own_form() {
    // `RESOLVED` 是进程级状态，先让沙箱把它钉死（同一进程内只有第一次生效），再验两个
    // 注入点各取自己那份形式（`docs/core/standalone-core.md` 第 3.2.1 节）。
    let _sandbox = crate::test_support::Sandbox::new("shell-env-forms");
    let resolved = path().expect("PATH 已由 Sandbox 钉死");
    let mut shell_command = Command::new("noop");
    apply(&mut shell_command).expect("PATH 已由 Sandbox 钉死");
    let mut native_command = Command::new("noop");
    apply_native(&mut native_command).expect("PATH 已由 Sandbox 钉死");
    assert_eq!(
        child_path(&shell_command),
        Some(resolved.shell().to_string_lossy().to_string())
    );
    assert_eq!(
        child_path(&native_command),
        Some(resolved.native().to_string_lossy().to_string())
    );
}

fn child_path(command: &Command) -> Option<String> {
    command
        .get_envs()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().to_string())
}

#[test]
fn apply_value_writes_path_into_child_environment() {
    let mut command = Command::new("noop");
    apply_value(&mut command, std::ffi::OsStr::new("X"));
    assert_eq!(child_path(&command).as_deref(), Some("X"));
}

/// RT-1：Windows 上的 bash 探测逐条转换 PATH，不把整串交给 `cygpath -p`
/// （`specs/defects/windows-bash-path-cygpath-resplit.md`）。
///
/// 整串 `-p` 会把 PATH 里的驱动器冒号当成列表分隔符：`/usr/bin:D:\tools\bin` 变成
/// `C:\Program Files\Git\usr\bin;D;C:\tools\bin`——多出单字母条目，`D:` 盘的目录还被
/// 搬到当前盘下。
#[test]
fn windows_bash_probe_converts_path_entries_one_by_one() {
    let args = probe_args(&shell_at("/bin/bash"));
    let script = &args[3];
    if cfg!(windows) {
        assert!(
            !script.contains("-wp"),
            "整串 -p 转换会把驱动器冒号当列表分隔符：{script}"
        );
        assert!(script.contains("cygpath -w"), "逐条转换仍走 cygpath -w：{script}");
    } else {
        assert!(script.contains("printf"), "{script}");
    }
}

/// RT-2：`$PATH` 里已经有 Windows 形式条目时 shell 形式原样保留；原生形式逐条派生，
/// 一条目录转不动不让整个探测失败
/// （`specs/defects/windows-bash-path-cygpath-resplit.md`）。
///
/// 模拟用户在 `.bashrc` 里写 `export PATH="$PATH:C:\Users\me\bin"` 之后终端里的 PATH。
/// 检测不到 bash 时跳过（Windows 上没装 Git Bash 的环境）。
#[test]
fn windows_bash_probe_keeps_windows_style_entries_intact() {
    if !cfg!(windows) {
        return;
    }
    let detected = crate::shell::shell();
    if detected.kind != "bash" {
        return;
    }
    let script = match probe_plan(&detected).expect("探测计划应当成立") {
        Probe::Run(args) => args.last().cloned().expect("脚本在最后一个参数"),
        Probe::Inherited => panic!("bash 应当走探测，而不是沿用进程环境"),
    };

    // 1. shell 自己的形式原样保留：探测不做 POSIX → Windows 的转换，也不做往返
    let crafted = r"/usr/bin:C:\Users\me\bin";
    let parsed = probe_with(&detected, &script, crafted);
    assert_eq!(
        parsed.shell(),
        std::ffi::OsStr::new(crafted),
        "shell 自己的形式要原样保留（含 Windows 形式条目）"
    );

    // 2. 干净的 POSIX 列表逐条派生：条目一一对应，各自带盘符，不引入垃圾条目
    let clean = r"/usr/bin:/c/Program Files/nodejs";
    let native = probe_with(&detected, &script, clean)
        .native()
        .to_string_lossy()
        .to_string();
    let entries: Vec<&str> = native.split(';').map(|entry| entry.trim()).collect();
    assert_eq!(entries.len(), 2, "逐条派生：{native}");
    assert!(
        entries.iter().all(|entry| entry.contains(":\\")),
        "每条都该是带盘符的 Windows 路径：{native}"
    );
    assert!(native.contains(r"C:\Program Files\nodejs"), "{native}");

    // 3. cygpath 转不动的条目只保留原文，不让整个探测失败（整串 `-p` 会整体报错）
    let odd = "/usr/bin:/c/__tc_no_such_dir__/../bar";
    let native = probe_with(&detected, &script, odd)
        .native()
        .to_string_lossy()
        .to_string();
    assert!(
        native.contains("/c/__tc_no_such_dir__/../bar"),
        "转不动的条目要原样留着：{native}"
    );
}

/// 用给定 PATH 跑一遍真实探测脚本并解析输出
fn probe_with(detected: &ShellInfo, script: &str, crafted: &str) -> ShellPath {
    let output = run_probe(
        &detected.path,
        &["-c".to_string(), format!("PATH='{crafted}'; {script}")],
        Duration::from_secs(10),
    )
    .expect("探测应当成功");
    parse_output(&output).expect("探测输出应当解析出两种形式")
}

/// 真实 shell 上的探测：成功路径与超时路径。检测不到 bash 时跳过
/// （Windows 上没装 Git Bash 的环境）。
#[test]
fn run_probe_reads_stdout_and_times_out() {
    let detected = crate::shell::shell();
    if detected.kind != "bash" {
        return;
    }
    let ok = run_probe(
        &detected.path,
        &["-c".to_string(), r#"printf %s "/x/bin:/y/bin""#.to_string()],
        Duration::from_secs(10),
    )
    .expect("打印 PATH 的探测应当成功");
    assert!(ok.contains("/x/bin"), "{ok}");

    let error = run_probe(
        &detected.path,
        &["-c".to_string(), "sleep 5".to_string()],
        Duration::from_millis(200),
    )
    .expect_err("超时必须报错");
    assert!(error.contains("没有返回"), "{error}");
}

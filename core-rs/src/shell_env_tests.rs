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
    if cfg!(windows) {
        // Git Bash 的 PATH 是 POSIX 形式，必须转成 Windows 形式才能给 CreateProcess 用
        assert!(args[3].contains("cygpath -wp"), "{}", args[3]);
    } else {
        assert!(args[3].contains("printf"), "{}", args[3]);
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
fn parse_path_takes_last_non_empty_line() {
    // 启动文件打印的内容排在 PATH 前面，取最后一行
    let output = format!("welcome back\n{path}\n", path = sample_path());
    assert_eq!(
        parse_path(&output).expect("应当解析出 PATH"),
        OsString::from(sample_path())
    );
}

#[test]
fn parse_path_strips_carriage_return() {
    let output = format!("{}\r\n", sample_path());
    assert_eq!(
        parse_path(&output).expect("应当解析出 PATH"),
        OsString::from(sample_path())
    );
}

#[test]
fn parse_path_rejects_empty_output() {
    let error = parse_path("\n\n").expect_err("空输出必须报错，不能降级");
    assert!(error.contains("没有输出"), "{error}");
}

#[test]
fn parse_path_rejects_output_that_is_not_a_path() {
    let error = parse_path("good morning\n").expect_err("不像 PATH 就必须报错");
    assert!(error.contains("不像 PATH"), "{error}");
}

#[test]
fn apply_value_writes_path_into_child_environment() {
    let mut command = Command::new("noop");
    apply_value(&mut command, std::ffi::OsStr::new("X"));
    let path = command
        .get_envs()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .and_then(|(_, value)| value)
        .map(|value| value.to_string_lossy().to_string());
    assert_eq!(path.as_deref(), Some("X"));
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

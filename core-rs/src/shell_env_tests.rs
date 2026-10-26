//! `shell_env` 的单测：探测参数、输出解析、超时与注入点。

use std::ffi::OsString;
use std::process::Stdio;
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
        Probe::Run { args, .. } => args,
        Probe::Inherited => panic!("该 shell 应当走探测，而不是沿用进程环境"),
    }
}

#[test]
fn bash_probe_uses_login_and_interactive_shell() {
    let args = probe_args(&shell_at("/bin/zsh"));
    // 非 Windows 要登录 + 交互：launchd / sshd 只给最小 PATH，`.zshrc` 里的目录只有
    // 交互 shell 才读得到；Windows 上反过来——启动文件会把用户 PATH 重置掉。
    if cfg!(windows) {
        assert_eq!(args[0], "-c", "Windows 上不读启动文件：{args:?}");
    } else {
        assert_eq!(args[0], "-l", "login：读 .zprofile / .zlogin");
        assert_eq!(args[1], "-i", "interactive：读 .zshrc / .bashrc");
        assert_eq!(args[2], "-c");
    }
    let script = args.last().expect("脚本在最后一个参数");
    assert!(script.contains("$PATH"), "探测脚本要取 PATH：{args:?}");
}

#[test]
fn bash_probe_script_matches_platform() {
    let args = probe_args(&shell_at("/bin/bash"));
    let script = args.last().expect("脚本在最后一个参数");
    assert!(script.contains(SHELL_FORM_MARKER), "探测脚本要打 shell 形式的标记：{script}");
    // 两边都只是把 shell 自己的 `$PATH` 打出来：不做 POSIX → Windows 转换（Windows 的
    // 原生形式直接取进程环境里的 PATH），也不再需要 cygpath。
    assert!(script.contains("printf"), "{script}");
    assert!(!script.contains("cygpath"), "{script}");
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
fn parse_shell_form_takes_marked_line() {
    // 启动文件打印的内容排在前面，按标记认探测脚本自己打的那行
    let output = format!(
        "welcome back\n{SHELL_FORM_MARKER}{path}\n",
        path = sample_path()
    );
    assert_eq!(
        parse_shell_form(&output, false).expect("应当解析出 PATH"),
        OsString::from(sample_path())
    );
}

#[test]
fn parse_shell_form_accepts_posix_list_on_windows() {
    // Windows 上 bash 报的是 POSIX 列表：分隔符按 `:` 认，不能拿 `;` 去校验
    let output = format!("{SHELL_FORM_MARKER}/usr/bin:/c/foo");
    assert_eq!(
        parse_shell_form(&output, true).expect("POSIX 列表应当成立"),
        OsString::from("/usr/bin:/c/foo")
    );
}

#[test]
fn parse_shell_form_strips_carriage_return() {
    let output = format!("{SHELL_FORM_MARKER}{}\r\n", sample_path());
    assert_eq!(
        parse_shell_form(&output, false).expect("应当解析出 PATH"),
        OsString::from(sample_path())
    );
}

#[test]
fn parse_shell_form_rejects_empty_output() {
    let error = parse_shell_form("\n\n", false).expect_err("空输出必须报错，不能降级");
    assert!(error.contains("没有输出"), "{error}");
}

#[test]
fn parse_shell_form_rejects_output_that_is_not_a_path() {
    let error = parse_shell_form(&format!("{SHELL_FORM_MARKER}good morning\n"), false)
        .expect_err("不像 PATH 就必须报错");
    assert!(error.contains("不像 PATH"), "{error}");
}

#[test]
fn apply_and_apply_native_write_their_own_form() {
    // 沙箱把 PATH 钉成「<root>/bin + 继承 PATH」且两种形式同一份（Sandbox::new），
    // 钉定随沙箱存亡（drop 即清除，恢复探测语义）——这里断言两个注入点写出的一致、
    // 都以沙箱 bin 目录开头。
    let sandbox = crate::test_support::Sandbox::new("shell-env-forms");
    let mut shell_command = Command::new("noop");
    apply(&mut shell_command).expect("PATH 已由 Sandbox 钉死");
    let mut native_command = Command::new("noop");
    apply_native(&mut native_command).expect("PATH 已由 Sandbox 钉死");
    let shell_path = child_path(&shell_command).expect("apply 应写入 PATH");
    let native_path = child_path(&native_command).expect("apply_native 应写入 PATH");
    assert_eq!(shell_path, native_path, "钉定是同一份，两个注入点应写出一致");
    let bin_prefix = sandbox.root.join("bin").to_string_lossy().to_string();
    assert!(shell_path.starts_with(&bin_prefix), "got {shell_path}");
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

/// RT-2：`$PATH` 里已经有 Windows 形式条目时 shell 形式原样保留
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
        Probe::Run { args, .. } => args.last().cloned().expect("脚本在最后一个参数"),
        Probe::Inherited => panic!("bash 应当走探测，而不是沿用进程环境"),
    };
    let crafted = r"/usr/bin:C:\Users\me\bin";
    let output = probe_output(&detected, &script, crafted);
    assert_eq!(
        parse_shell_form(&output, true).expect("应当解析出 shell 形式"),
        OsString::from(crafted),
        "shell 自己的形式要原样保留（含 Windows 形式条目）"
    );
}

/// 用给定 PATH 跑一遍真实探测脚本，返回原始输出
fn probe_output(detected: &ShellInfo, script: &str, crafted: &str) -> String {
    run_probe(
        &detected.path,
        &["-c".to_string(), format!("PATH='{crafted}'; {script}")],
        Duration::from_secs(10),
    )
    .expect("探测应当成功")
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

/// RT-1：Windows 上 bash 家族不读启动文件（不带 `-l` / `-i`）
/// （`specs/defects/windows-bash-probe-login-resets-path.md`）。
///
/// `-l` 会跑 `/etc/profile`，MSYS2 上它按 `MSYS2_PATH_TYPE` / `ORIGINAL_PATH` 重建 PATH，
/// 把用户环境变量里的目录（`git` 所在的 Windows 目录等）整套换掉。
#[test]
fn windows_bash_probe_skips_login_startup() {
    let args = probe_args(&shell_at("/bin/bash"));
    if cfg!(windows) {
        assert!(
            !args.contains(&"-l".to_string()),
            "Windows 上不读 login 启动文件：{args:?}"
        );
        assert!(
            !args.contains(&"-i".to_string()),
            "Windows 上不读 .bashrc：{args:?}"
        );
        assert_eq!(args[0], "-c");
    } else {
        assert_eq!(args[0], "-l", "非 Windows 仍要登录 shell：{args:?}");
        assert_eq!(args[1], "-i", "非 Windows 仍要交互 shell：{args:?}");
    }
}

/// RT-2：登录启动文件把 PATH 重置掉时，探测仍要保留进程环境里的目录
/// （`specs/defects/windows-bash-probe-login-resets-path.md`）。
///
/// 用 `MSYS2_PATH_TYPE=strict` 复现 `/etc/profile` 换掉继承 PATH 的分支。
#[test]
fn windows_bash_probe_keeps_the_environment_path() {
    if !cfg!(windows) {
        return;
    }
    let detected = crate::shell::shell();
    if detected.kind != "bash" {
        return;
    }
    let args = probe_args(&detected);
    let marker = r"C:\__tc_probe_marker__";
    // 子进程环境整份换掉：PATH 只由 `shell_env` 写（`src/test/docsLint.test.ts` 第 14 组），
    // 这里是把「用户终端里的 Windows PATH」喂给探测，不是在改 Core 的注入逻辑。
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case("PATH"))
        .collect();
    env.push(("PATH".into(), format!(r"{marker};C:\Windows\System32").into()));
    env.push(("MSYS2_PATH_TYPE".into(), "strict".into()));
    let output = Command::new(&detected.path)
        .args(&args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .expect("探测 shell 应当可执行");
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        text.contains("__tc_probe_marker__"),
        "登录启动文件重置 PATH 后，进程环境里的目录仍要在探测结果里：{text}"
    );

    // 原生形式直接就是进程环境里的 Windows PATH，不再经 cygpath 往返
    let resolved = probe(&detected).expect("探测应当成功");
    assert_eq!(
        resolved.native(),
        std::env::var_os("PATH").expect("测试进程有 PATH").as_os_str(),
        "原生形式就是进程环境里的 Windows PATH"
    );
}

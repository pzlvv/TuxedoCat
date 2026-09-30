//! `shell` 的单元测试：探测优先级、展示名、探测工具的容错。

use super::*;
use crate::test_support::Sandbox;

#[test]
fn strip_suffix_is_case_insensitive() {
    assert_eq!(
        strip_suffix_ci(r"C:\Program Files\Git\cmd\git.exe", "\\git.exe").as_deref(),
        Some(r"C:\Program Files\Git\cmd")
    );
    assert_eq!(
        strip_suffix_ci(r"C:\Program Files\Git\cmd", "\\CMD").as_deref(),
        Some(r"C:\Program Files\Git")
    );
    assert_eq!(strip_suffix_ci("bash", "\\git.exe"), None);
    assert_eq!(strip_suffix_ci("", "\\git.exe"), None);
    assert_eq!(strip_suffix_ci("git.exe", "git.exe").as_deref(), Some(""));
    assert_eq!(strip_suffix_ci("a/b/GIT.EXE", "/git.exe").as_deref(), Some("a/b"));
}

#[test]
fn detection_always_returns_a_shell() {
    let shell = shell();
    assert!(!shell.path.is_empty());
    assert!(!shell.args.is_empty());
    assert!(!shell.name.is_empty());
    assert!(
        matches!(shell.kind.as_str(), "bash" | "powershell" | "cmd"),
        "unexpected kind: {}",
        shell.kind
    );
}

#[test]
fn detection_is_cached_across_calls() {
    let first = shell();
    let second = shell();
    assert_eq!(first.path, second.path);
    assert_eq!(first.name, second.name);
}

#[test]
fn detected_shell_has_kind_and_display_name() {
    let info = shell();
    // 系统提示的 Shell 行是 `{kind} ({name})`，两者都不能为空
    assert!(!info.kind.trim().is_empty());
    assert!(!info.name.trim().is_empty());
}

#[test]
fn where_first_finds_git_and_reports_unknown_binaries() {
    // 与探测逻辑一致：git 必须在 PATH 上（CI/开发机都装 Git）
    if let Some(path) = where_first("git") {
        assert!(!path.trim().is_empty());
        assert!(path.to_lowercase().contains("git"), "got {path}");
    }
    assert!(where_first("definitely-not-a-real-binary-xyzzy").is_none());
}

#[test]
fn test_shell_rejects_missing_programs() {
    assert!(!test_shell("definitely-not-a-real-binary-xyzzy", &["--version"]));
    assert!(!test_shell("", &[]));
}

#[test]
fn test_shell_accepts_runnable_programs() {
    if !cfg!(windows) {
        return;
    }
    // cmd.exe /c exit 0 必然可运行
    assert!(test_shell("cmd.exe", &["/c", "exit 0"]));
    // 非 0 退出码视为不可用
    assert!(!test_shell("cmd.exe", &["/c", "exit 1"]));
}

#[test]
fn bash_detection_returns_a_bash_kind() {
    if !cfg!(windows) {
        return;
    }
    let candidates = [detect_bash_from_git_dir(), detect_bash_from_common_paths(), detect_bash_from_path()];
    for shell in candidates.into_iter().flatten() {
        assert_eq!(shell.kind, "bash");
        assert_eq!(shell.args, vec!["-c".to_string()]);
        assert!(shell.path.to_lowercase().contains("bash"), "got {}", shell.path);
        assert!(!shell.name.is_empty());
    }
}

#[test]
fn bash_display_name_classifies_the_vendor() {
    // 对齐 Embedded `detectBashFromCommonPaths` 的分支：git / msys / cygwin / 普通
    assert_eq!(
        common_path_bash_name(r"C:\Program Files\Git\bin\bash.exe"),
        "bash (Git Bash)"
    );
    assert_eq!(
        common_path_bash_name(r"C:\msys64\usr\bin\bash.exe"),
        "bash (MSYS2)"
    );
    assert_eq!(
        common_path_bash_name(r"C:\cygwin64\bin\bash.exe"),
        "bash (Cygwin)"
    );
    assert_eq!(common_path_bash_name("/usr/bin/bash"), "bash");
}

#[test]
fn try_bash_uses_the_supplied_display_name() {
    if !cfg!(windows) {
        return;
    }
    let Some(real) = detect_bash_from_common_paths().or_else(detect_bash_from_path) else {
        return;
    };
    let path = Path::new(&real.path);

    assert_eq!(
        try_bash(path, "bash (Git Bash)").unwrap().name,
        "bash (Git Bash)"
    );
    assert_eq!(try_bash(path, "bash").unwrap().name, "bash");
    // 不存在的路径返回 None
    assert!(try_bash(Path::new("C:/nope/bash.exe"), "bash").is_none());
}

#[test]
fn detect_returns_bash_on_windows_when_git_bash_exists() {
    if !cfg!(windows) {
        return;
    }
    // 当前开发机上装了 Git，因此必须优先落到 Git Bash 而不是 cmd
    let detected = detect();
    if where_first("git").is_some() {
        assert_eq!(detected.kind, "bash", "detected: {detected:?}");
        assert!(detected.name.contains("Git Bash"), "detected: {detected:?}");
    }
}

#[test]
fn detection_ignores_the_sandbox_home() {
    // 探测依赖 PATH / 常见安装路径，不应受宿主主目录影响
    let _sandbox = Sandbox::new("shell-sandbox");
    let detected = detect();
    assert!(!detected.path.is_empty());
}

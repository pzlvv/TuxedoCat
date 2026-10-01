//! 命令行解析用例（动作 / `--help` / `--version` / 未知选项 / 未知动作 / 动作互斥）。

use super::*;
use std::io::IsTerminal;

use crate::remote::{DEFAULT_HOST, DEFAULT_PORT};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn help_wins_over_everything() {
    assert_eq!(parse(&args(&["--help"])), Command::Help);
    assert_eq!(parse(&args(&["-h"])), Command::Help);
    assert_eq!(parse(&args(&["start", "--help"])), Command::Help);
}

#[test]
fn version_flag() {
    assert_eq!(parse(&args(&["--version"])), Command::Version);
    assert_eq!(parse(&args(&["-V"])), Command::Version);
    assert!(version().contains(env!("CARGO_PKG_VERSION")));
}

#[test]
fn parses_actions() {
    assert_eq!(parse(&args(&["serve"])), Command::Serve);
    assert!(matches!(parse(&args(&["start"])), Command::Start(_)));
    assert_eq!(parse(&args(&["kill"])), Command::Kill);
    // daemon 实体是启动器的内部实现，不出现在帮助里，但要能解析
    assert!(matches!(
        parse(&args(&["start-daemon"])),
        Command::StartDaemon(_)
    ));
}

#[test]
fn rejects_unknown_action() {
    match parse(&args(&["nope"])) {
        Command::Error(message) => assert!(message.contains("未知动作"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn rejects_removed_flag_style_actions() {
    // 动作是裸词：`--serve` 这类写法不再接受（旧写法直接报未知选项）
    match parse(&args(&["--serve"])) {
        Command::Error(message) => assert!(message.contains("未知选项"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn parses_start_with_options() {
    // 默认：回环地址 + 高位端口，token 留空（由 daemon 生成或复用状态文件里的）
    let Command::Start(options) = parse(&args(&["start"])) else {
        panic!("expected start action");
    };
    assert_eq!(options.host, DEFAULT_HOST);
    assert_eq!(options.port, DEFAULT_PORT);
    assert!(options.token.is_empty());

    let Command::Start(options) = parse(&args(&["start", "--port", "8080"])) else {
        panic!("expected start action");
    };
    assert_eq!(options.port, 8080);

    let Command::Start(options) =
        parse(&args(&["start", "--host=0.0.0.0", "--token=abc"]))
    else {
        panic!("expected start action");
    };
    assert_eq!(options.host, "0.0.0.0");
    assert_eq!(options.token, "abc");
}

#[test]
fn rejects_unknown_option() {
    match parse(&args(&["--nope"])) {
        Command::Error(message) => assert!(message.contains("--nope"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
    // 选项值不是动作：`--host 127.0.0.1` 里的值不该被当成未知动作
    assert!(matches!(
        parse(&args(&["start", "--host", "127.0.0.1"])),
        Command::Start(_)
    ));
}

#[test]
fn rejects_conflicting_modes() {
    match parse(&args(&["start-daemon", "start"])) {
        Command::Error(message) => assert!(message.contains("互斥"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn usage_lists_all_modes_and_flags() {
    let text = usage();
    for needle in ["serve", "start", "kill", "--host", "--port", "--token", "--help"] {
        assert!(text.contains(needle), "usage 缺少 {needle}：{text}");
    }
    // daemon 实体是内部实现：不出现在帮助里
    assert!(!text.contains("start-daemon"), "usage 不该出现 start-daemon：{text}");
}

#[test]
fn no_mode_falls_back_to_serve_when_stdin_is_not_a_terminal() {
    // cargo test 的 stdin 不是终端：没有模式时按 --serve 启动（宿主经管道接入）
    if std::io::stdin().is_terminal() {
        return;
    }
    assert_eq!(parse(&[]), Command::Serve);
}

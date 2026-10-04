//! 命令行解析用例（动作 / `--help` / `--version` / 未知选项 / 未知动作 / 动作互斥）。

use super::*;

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
    assert_eq!(parse(&args(&["stdio"])), Command::Stdio);
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
    // 动作是裸词：`--stdio` 这类写法不再接受（旧写法直接报未知选项）
    match parse(&args(&["--stdio"])) {
        Command::Error(message) => assert!(message.contains("未知选项"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
}

#[test]
fn parses_start_with_options() {
    // 默认：不设空闲退出（常驻）
    let Command::Start(options) = parse(&args(&["start"])) else {
        panic!("expected start action");
    };
    assert_eq!(options.idle_exit, None);

    let Command::Start(options) = parse(&args(&["start", "--idle-exit", "30"])) else {
        panic!("expected start action");
    };
    assert_eq!(options.idle_exit, Some(std::time::Duration::from_secs(30)));

    let Command::Start(options) = parse(&args(&["start", "--idle-exit=5"])) else {
        panic!("expected start action");
    };
    assert_eq!(options.idle_exit, Some(std::time::Duration::from_secs(5)));
}

#[test]
fn rejects_unknown_option() {
    match parse(&args(&["--nope"])) {
        Command::Error(message) => assert!(message.contains("--nope"), "{message}"),
        other => panic!("expected error, got {other:?}"),
    }
    // 选项值不是动作：`--idle-exit 30` 里的值不该被当成未知动作
    assert!(matches!(
        parse(&args(&["start", "--idle-exit", "30"])),
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
    for needle in ["stdio", "start", "kill", "--idle-exit", "--help"] {
        assert!(text.contains(needle), "usage 缺少 {needle}：{text}");
    }
    // daemon 实体是内部实现：不出现在帮助里
    assert!(!text.contains("start-daemon"), "usage 不该出现 start-daemon：{text}");
    // daemon 恒绑回环：帮助里不出现绑定地址 / 凭证 / 连接串
    assert!(!text.contains("--host"), "usage 不该出现 --host：{text}");
    assert!(!text.contains("--port"), "usage 不该出现 --port：{text}");
    assert!(!text.contains("--token"), "usage 不该出现 --token：{text}");
    assert!(!text.contains("连接串"), "usage 不该出现连接串：{text}");
}

#[test]
fn no_action_defaults_to_start() {
    // 没有动作时按 start 处理：用户直接运行可执行文件即启动远程服务
    assert!(matches!(parse(&[]), Command::Start(_)));
    // 只有选项、没有动作也一样
    assert!(matches!(parse(&args(&["--idle-exit", "30"])), Command::Start(_)));
}

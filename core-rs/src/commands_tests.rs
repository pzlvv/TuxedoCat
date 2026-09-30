use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::test_support::{serial, Sandbox};

/// 收集 `CommandContext.emit` 发出的事件
fn emitter() -> (Arc<dyn Fn(Value) + Send + Sync>, Arc<Mutex<Vec<Value>>>) {
    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    (
        Arc::new(move |event: Value| sink.lock().unwrap().push(event)),
        events,
    )
}

fn make_context(cwd: &str) -> (CommandContext, Arc<Mutex<Vec<Value>>>) {
    let (emit, events) = emitter();
    (
        CommandContext {
            session_id: "sess-1".to_string(),
            cwd: cwd.to_string(),
            command_name: None,
            emit,
            start_spin: None,
        },
        events,
    )
}

#[test]
fn non_slash_text_passes_through() {
    let _guard = serial();
    let (context, events) = make_context(".");
    assert_eq!(dispatch("hello", &context), DispatchOutcome::Passthrough);
    assert_eq!(dispatch("", &context), DispatchOutcome::Passthrough);
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn bare_slash_passes_through() {
    let _guard = serial();
    let (context, _events) = make_context(".");
    assert_eq!(dispatch("/", &context), DispatchOutcome::Passthrough);
    assert_eq!(dispatch("/  x", &context), DispatchOutcome::Passthrough);
}

#[test]
fn builtin_command_is_handled_and_emits_command_dispatched() {
    let _guard = serial();
    crate::skills::reset_registries();
    crate::skills::ensure_builtins();

    let (context, events) = make_context(".");
    // `/spin design`：只发 `commandDispatched`（UI 据此打开设计器），不产生 system 消息
    assert_eq!(dispatch("/spin design", &context), DispatchOutcome::Handled);

    let events = events.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "事件: {events:?}");
    assert_eq!(events[0]["type"], "commandDispatched");
    assert_eq!(events[0]["sessionId"], "sess-1");
    assert_eq!(events[0]["commandName"], "spin");
    assert_eq!(events[0]["args"], "design");

    crate::skills::reset_registries();
}

#[test]
fn builtin_command_alias_and_args_parsing() {
    let _guard = serial();
    crate::skills::reset_registries();
    crate::skills::ensure_builtins();

    let (context, events) = make_context(".");
    // 别名 `sprint` 命中，且参数保留内部空白 / 换行
    assert_eq!(dispatch("/sprint   auto  now", &context), DispatchOutcome::Handled);
    {
        let events = events.lock().unwrap();
        assert_eq!(events[0]["commandName"], "spin");
        assert_eq!(events[0]["args"], "auto  now");
    }

    crate::skills::reset_registries();
}

#[test]
fn skill_command_returns_skill_with_name_and_args() {
    // `Sandbox::new` 自带串行锁（`serial()` 不可重入，这里不能再取一次）
    let sandbox = Sandbox::new("commands-skill");
    crate::skills::reset_registries();

    let (context, events) = make_context(&sandbox.workspace.to_string_lossy());
    assert_eq!(
        dispatch("/commit -m 'Fix bug'", &context),
        DispatchOutcome::Skill {
            skill_name: "commit".to_string(),
            skill_args: "-m 'Fix bug'".to_string(),
        }
    );
    // 命中 Skill 时**不**发 commandDispatched（由调用方注入 tool_use）
    assert!(events.lock().unwrap().is_empty());

    // 多行参数
    assert_eq!(
        dispatch("/commit 修复 A\n再修 B", &context),
        DispatchOutcome::Skill {
            skill_name: "commit".to_string(),
            skill_args: "修复 A\n再修 B".to_string(),
        }
    );

    // 无参数
    assert_eq!(
        dispatch("/commit", &context),
        DispatchOutcome::Skill {
            skill_name: "commit".to_string(),
            skill_args: String::new(),
        }
    );

    crate::skills::reset_registries();
}

/// 与 `src/test/commandDispatch.test.ts` 同一组用例（同一份输入 / 同一份期望），
/// 防止「`.*` 匹配不到换行 → 多行 Skill 命令退化成普通消息」这类回归。
#[test]
fn dispatch_matches_the_shared_command_table() {
    let sandbox = Sandbox::new("commands-table");
    crate::skills::reset_registries();
    let (context, _events) = make_context(&sandbox.workspace.to_string_lossy());

    let cases: Vec<(&str, DispatchOutcome)> = vec![
        (
            "/commit",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: String::new(),
            },
        ),
        (
            "/commit 修复登录问题",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: "修复登录问题".to_string(),
            },
        ),
        (
            "/commit 修复 A\n再修 B",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: "修复 A\n再修 B".to_string(),
            },
        ),
        (
            "/commit\nfoo",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: "foo".to_string(),
            },
        ),
        (
            "  /commit  多行\n第二行  ",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: "多行\n第二行".to_string(),
            },
        ),
        ("/not-a-skill 多行\n参数", DispatchOutcome::Passthrough),
        ("/", DispatchOutcome::Passthrough),
        ("普通消息", DispatchOutcome::Passthrough),
        ("/usr/bin/env", DispatchOutcome::Passthrough),
        // JS 空白口径（U+FEFF / U+0085）：`prompt.trim()` 必须与 Embedded 一致
        (
            "\u{FEFF}/commit",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: String::new(),
            },
        ),
        (
            "\u{FEFF}/commit \u{FEFF}修复",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: "修复".to_string(),
            },
        ),
        (
            "/commit\u{FEFF}",
            DispatchOutcome::Skill {
                skill_name: "commit".to_string(),
                skill_args: String::new(),
            },
        ),
        ("\u{0085}/commit", DispatchOutcome::Passthrough),
        ("\u{FEFF}\u{0085}/commit", DispatchOutcome::Passthrough),
    ];

    for (input, expected) in cases {
        assert_eq!(dispatch(input, &context), expected, "输入: {input:?}");
    }

    crate::skills::reset_registries();
}

#[test]
fn unknown_slash_command_passes_through() {
    let sandbox = Sandbox::new("commands-unknown");
    crate::skills::reset_registries();

    let (context, _events) = make_context(&sandbox.workspace.to_string_lossy());
    assert_eq!(dispatch("/nope args", &context), DispatchOutcome::Passthrough);
    crate::skills::reset_registries();
}

#[test]
fn registered_command_description_is_resolved() {
    let _guard = serial();
    clear_builtin_commands();
    register_builtin_command(BuiltinCommandDefinition {
        name: "static".to_string(),
        description: Description::Static("A static description".to_string()),
        aliases: Vec::new(),
        execute: Arc::new(|_args, _context| None),
    });
    let commands = builtin_commands();
    let found = commands
        .iter()
        .find(|command| command.name == "static")
        .expect("命令未注册");
    assert_eq!(found.description, "A static description");
    assert!(is_builtin_command_name("static"));
    assert!(builtin_command_names().contains(&"static".to_string()));
    clear_builtin_commands();
}

#[test]
fn command_result_becomes_system_message() {
    let _guard = serial();
    clear_builtin_commands();
    register_builtin_command(BuiltinCommandDefinition {
        name: "echo".to_string(),
        description: Description::Static("echo".to_string()),
        aliases: Vec::new(),
        execute: Arc::new(|args, _context| Some(format!("echoed: {args}"))),
    });

    let (context, events) = make_context(".");
    assert_eq!(dispatch("/echo hi", &context), DispatchOutcome::Handled);
    let events = events.lock().unwrap().clone();
    assert_eq!(events[1]["type"], "message");
    assert_eq!(events[1]["data"]["role"], "system");
    assert_eq!(events[1]["data"]["content"], "echoed: hi");

    // 返回空串 → 不发消息（对齐 `if (result)`）
    let (silent_context, silent_events) = make_context(".");
    register_builtin_command(BuiltinCommandDefinition {
        name: "silent".to_string(),
        description: Description::Static("silent".to_string()),
        aliases: Vec::new(),
        execute: Arc::new(|_args, _context| Some(String::new())),
    });
    assert_eq!(dispatch("/silent", &silent_context), DispatchOutcome::Handled);
    assert_eq!(silent_events.lock().unwrap().len(), 1);

    clear_builtin_commands();
}

#[test]
fn skill_conflict_detection_uses_name_and_aliases() {
    let _guard = serial();
    clear_builtin_commands();
    register_builtin_command(BuiltinCommandDefinition {
        name: "spin".to_string(),
        description: Description::Static("spin".to_string()),
        aliases: vec!["sprint".to_string()],
        execute: Arc::new(|_args, _context| None),
    });
    assert!(check_skill_conflict("spin", &[]));
    assert!(check_skill_conflict("other", &["sprint".to_string()]));
    assert!(!check_skill_conflict("commit", &[]));
    clear_builtin_commands();
}

#[test]
fn spin_command_reports_missing_engine() {
    let _guard = serial();
    crate::skills::reset_registries();
    let definition = spin_command_definition();
    let (context, events) = make_context(".");
    // `auto` 分支：引擎未迁移 → 发一条 user 消息说明，不返回系统消息
    assert_eq!((definition.execute)("auto", &context), None);
    let events = events.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["data"]["role"], "user");
    assert!(events[0]["data"]["content"]
        .as_str()
        .unwrap()
        .contains("Spin"));

    // `design` 分支：不发消息
    let (design_context, design_events) = make_context(".");
    assert_eq!((definition.execute)("design", &design_context), None);
    assert!(design_events.lock().unwrap().is_empty());
}

#[test]
fn spin_description_follows_core_locale() {
    let _guard = serial();
    crate::i18n::reset_core_locale();
    let definition = spin_command_definition();
    assert_eq!(definition.description.resolve(), "Execute Spin tasks");
    crate::i18n::set_core_ui_language("zh");
    assert_eq!(definition.description.resolve(), "执行 Spin 任务");
    crate::i18n::reset_core_locale();
}

#[test]
fn dispatch_ignores_json_input_shapes() {
    let _guard = serial();
    // 消息文本是 JSON 时同样按 `/` 前缀判定（不是对象）
    let (context, _events) = make_context(".");
    assert_eq!(
        dispatch("{\"a\": 1}", &context),
        DispatchOutcome::Passthrough
    );
    assert_eq!(json!({ "x": 1 })["x"], 1);
}

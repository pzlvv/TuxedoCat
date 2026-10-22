//! `tools` 的单元测试：工具定义、入参解析、七个工具的执行分支。

use super::*;

/// `Skill` 工具的位置不变式（见 tools.rs 的加载期校验）：
/// 工具列表的最后一项必须是 `Skill`，否则提示词组装会把
/// 动态技能内容当成静态提示词打进系统提示。
#[test]
fn skill_tool_is_last_in_definitions() {
    assert_skill_tool_is_last();
    let names: Vec<String> = definitions()
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(
        names,
        vec![
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Grep",
            "Glob",
            "TodoWrite",
            "Agent",
            "Reply",
            "AskUserQuestion",
            "WebSearch",
            "WebFetch",
            "Skill"
        ]
    );
}

use crate::test_support::{minimal_png_bytes, repo_root, ripgrep_available, Sandbox};
use serde_json::json;

fn context(sandbox: &Sandbox) -> ToolContext {
    ToolContext {
        session_id: "s-tools".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    }
}

fn text(outcome: &ToolOutcome) -> String {
    outcome.text().to_string()
}

/// 十六进制串 -> 字节（对照表夹具用；两侧 parity 测试共享同一份 hex 写法）
fn decode_hex(text: &str) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        let high = (bytes[index] as char).to_digit(16).expect("hex high");
        let low = (bytes[index + 1] as char).to_digit(16).expect("hex low");
        out.push((high * 16 + low) as u8);
        index += 2;
    }
    out
}

// ==================== 定义与分发 ====================

#[test]
fn definitions_cover_every_builtin_tool() {
    let definitions = definitions();
    let names: Vec<String> = definitions
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(
        names,
        vec![
            "Bash",
            "Read",
            "Write",
            "Edit",
            "Grep",
            "Glob",
            "TodoWrite",
            "Agent",
            "Reply",
            "AskUserQuestion",
            "WebSearch",
            "WebFetch",
            "Skill"
        ]
    );
    for tool in &definitions {
        assert!(
            tool.get("description").and_then(Value::as_str).is_some_and(|text| !text.is_empty()),
            "missing description: {tool}"
        );
        let schema = tool.get("input_schema").expect("input_schema");
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"].is_object());
    }
    // Bash 的 command 是必填项
    let bash = definitions
        .iter()
        .find(|tool| tool["name"] == "Bash")
        .expect("Bash definition");
    assert_eq!(bash["input_schema"]["required"][0], "command");
}

#[test]
fn execute_reports_unknown_tools() {
    let sandbox = Sandbox::new("tools-unknown");
    let outcome = execute("NoSuchTool", &json!({}), &context(&sandbox));
    assert!(outcome.is_error());
    // 工具不存在分支的错误文案
    assert_eq!(text(&outcome), "Error: Tool \"NoSuchTool\" not found");
}

#[test]
fn execute_dispatches_to_the_right_tool() {
    let sandbox = Sandbox::new("tools-dispatch");
    sandbox.write_file("a.txt", "hello\n");
    let ctx = context(&sandbox);

    assert!(!execute("Read", &json!({ "file_path": "a.txt" }), &ctx).is_error());
    assert!(!execute("Write", &json!({ "file_path": "b.txt", "content": "x" }), &ctx).is_error());
    assert!(!execute("Edit", &json!({
        "file_path": "b.txt", "old_string": "x", "new_string": "y"
    }), &ctx).is_error());
    assert!(!execute("Bash", &json!({ "command": "echo ok" }), &ctx).is_error());
    assert!(!execute("TodoWrite", &json!({ "todos": [] }), &ctx).is_error());
}

// ==================== 路径与入参 ====================

#[test]
fn expand_path_keeps_absolute_and_joins_relative() {
    let cwd = "D:/repo";
    assert_eq!(expand_path(cwd, "a/b.txt"), Path::new("D:/repo").join("a/b.txt"));
    let absolute = if cfg!(windows) { "C:/tmp/x.txt" } else { "/tmp/x.txt" };
    assert_eq!(expand_path(cwd, absolute), PathBuf::from(absolute));
}

#[test]
#[cfg(windows)]
fn expand_path_preserves_the_drive_letter_case_for_slash_paths() {
    // 盘符**原样保留**
    // （`path.normalize('c:\\/Users') === 'c:\\Users'`），只有 WSL 的
    // `/mnt/d/...` 才把盘符大写。
    assert_eq!(
        expand_path("D:/repo", "/c/Users/x").to_string_lossy().to_string(),
        "c:\\Users\\x"
    );
    assert_eq!(
        expand_path("D:/repo", "/C/Users/x").to_string_lossy().to_string(),
        "C:\\Users\\x"
    );
    assert_eq!(
        expand_path("D:/repo", "/mnt/d/git/proj").to_string_lossy().to_string(),
        "D:\\git\\proj"
    );
}

#[test]
fn expand_path_handles_multibyte_paths_without_panicking() {
    // 回归：WSL 分支曾用 `path[..5]` 按字节切片比较 `/mnt/`，多字节路径（如中文）
    // 在第 5 个字节不是字符边界时直接 panic，导致 Core 进程崩溃。
    let cwd = "D:/repo";
    assert_eq!(expand_path(cwd, "你你你"), Path::new(cwd).join("你你你"));
    assert_eq!(expand_path(cwd, "目录/文件.txt"), Path::new(cwd).join("目录/文件.txt"));
    // 长度够、但不是 /mnt/ 前缀的多字节路径同样不能 panic
    assert_eq!(expand_path(cwd, "你好世界你好"), Path::new(cwd).join("你好世界你好"));
}

#[test]
fn node_is_absolute_treats_a_leading_separator_as_absolute_on_windows() {
    // 与 Node `path.isAbsolute` 同口径：Linux 上 `/tmp/x` 是普通绝对路径；
    // Windows 上它是「当前盘根路径」，也必须是绝对（Glob 的绝对模式分支据此拆分基准目录）。
    assert!(is_absolute_like_node("/tmp/x"));
    assert!(is_absolute_like_node("\\tmp\\x"));
    assert!(!is_absolute_like_node("a/b"));
    assert!(!is_absolute_like_node(""));
    if cfg!(windows) {
        assert!(is_absolute_like_node("C:/tmp/x"));
        assert!(is_absolute_like_node("\\\\server\\share\\x"));
        // 相对 glob 不能误判成绝对
        assert!(!is_absolute_like_node("*.txt"));
        assert!(!is_absolute_like_node("sub/*.txt"));
    }
}

// ==================== 路径展开对照表 ====================

mod path_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// 断言「Rust 的 `tools::expand_path` == 本表」。对照表里的 `__CWD__` / `__HOME__`
    /// 是占位符，分隔符统一为 `/`。
    const FIXTURE: &str = include_str!("../fixtures/path.json");

    fn current_platform() -> &'static str {
        if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        }
    }

    #[test]
    fn matches_the_shared_path_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");

        let sandbox = Sandbox::new("tools-path-parity");
        let cwd = sandbox.workspace.to_string_lossy().to_string();
        let forward_cwd = cwd.replace('\\', "/");
        let forward_home = home_dir().to_string_lossy().replace('\\', "/");
        let canonicalize = |value: &str| {
            value
                .replace('\\', "/")
                .replace(&forward_cwd, "__CWD__")
                .replace(&forward_home, "__HOME__")
        };

        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            if let Some(platform) = case.get("platform").and_then(Value::as_str) {
                if platform != current_platform() {
                    continue;
                }
            }
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let input = case
                .get("input")
                .and_then(Value::as_str)
                .expect("用例缺少 input")
                .replace("__CWD__", &cwd);
            let expected = case.get("expected").and_then(Value::as_str).expect("用例缺少 expected");
            let actual = canonicalize(&expand_path(&cwd, &input).to_string_lossy());
            if actual != expected {
                failures.push(format!(
                    "{name}: input={input:?} expected={expected:?} actual={actual:?}"
                ));
            }
        }

        assert!(
            failures.is_empty(),
            "路径展开与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

#[test]
fn input_helpers_accept_expected_shapes() {
    let input = json!({ "text": "value", "number": 7, "numberText": "8", "yes": true, "no": "false" });
    assert_eq!(input_str(&input, "text").as_deref(), Some("value"));
    assert_eq!(input_str(&input, "missing"), None);
    assert_eq!(input_str(&input, "number"), None, "数字不是字符串");

    assert_eq!(input_u64(&input, "number"), Some(7));
    assert_eq!(input_u64(&input, "numberText"), Some(8));
    assert_eq!(input_u64(&input, "text"), None);
    assert_eq!(input_u64(&input, "missing"), None);

    assert_eq!(input_bool(&input, "yes"), Some(true));
    assert_eq!(input_bool(&input, "no"), Some(false));
    assert_eq!(input_bool(&json!({ "flag": "true" }), "flag"), Some(true));
    assert_eq!(input_bool(&json!({ "flag": "" }), "flag"), Some(false));
    assert_eq!(input_bool(&json!({ "flag": 1 }), "flag"), None);
}

// ==================== Bash ====================

#[test]
fn bash_requires_a_command() {
    let sandbox = Sandbox::new("tools-bash-missing");
    let outcome = execute("Bash", &json!({}), &context(&sandbox));
    assert!(outcome.is_error());
    assert_eq!(text(&outcome), "Bash: \"command\" is required");
}

#[test]
fn bash_returns_stdout_and_hides_trailing_newline() {
    let sandbox = Sandbox::new("tools-bash-stdout");
    let outcome = execute("Bash", &json!({ "command": "echo hello" }), &context(&sandbox));
    assert!(!outcome.is_error());
    assert_eq!(text(&outcome), "hello");
}

#[test]
fn bash_runs_with_the_resolved_path() {
    // 子进程的 PATH 来自 `shell_env`（沙箱把它钉成「<root>/bin + 继承 PATH」），
    // 不是 core 进程继承来的那份（`docs/core/standalone-core.md` 第 3.2.1 节）。
    let sandbox = Sandbox::new("tools-bash-path");
    let marker = sandbox
        .root
        .file_name()
        .expect("sandbox root has a name")
        .to_string_lossy()
        .to_string();
    let outcome = execute("Bash", &json!({ "command": "printf %s \"$PATH\"" }), &context(&sandbox));
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert!(text(&outcome).contains(&marker), "got {}", text(&outcome));
}

#[test]
fn bash_reports_stderr_and_exit_codes() {
    let sandbox = Sandbox::new("tools-bash-stderr");
    let ctx = context(&sandbox);

    // stderr 直接拼接，不额外加标签
    let stderr = execute("Bash", &json!({ "command": "echo problem 1>&2" }), &ctx);
    assert_eq!(text(&stderr), "problem");

    let failing = execute("Bash", &json!({ "command": "echo partial; exit 3" }), &ctx);
    assert_eq!(text(&failing), "partial\n\nExit code: 3");
    // 非零退出：UI 状态 error，但 tool_result 不带 is_error
    assert!(!failing.is_error());
    assert!(failing.is_status_error());
    assert_eq!(failing.exit_code(), 3);

    let silent = execute("Bash", &json!({ "command": "exit 4" }), &ctx);
    assert_eq!(text(&silent), "Exit code: 4");
}

#[test]
fn bash_timeout_moves_the_command_to_the_background() {
    // 前台命令**不会**因超时被杀，
    // 而是转入后台继续跑（`triggerAutoBackground('timeout')` → `autoBackgroundCommand`）。
    let sandbox = Sandbox::new("tools-bash-timeout");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let outcome = execute(
        "Bash",
        &json!({ "command": "sleep 5", "timeout": 300, "description": "Sleep five" }),
        &context(&sandbox),
    );
    let body = text(&outcome);
    assert!(!outcome.is_error(), "自动转后台不算工具失败: {body}");
    // 自动转后台的结果退出码是 0（UI 状态 success）
    assert!(!outcome.is_status_error(), "got {body}");
    assert_eq!(outcome.exit_code(), 0);
    // 自动转后台的说明只出现一次：taskId / 输出路径 / 完成通知不再重复两遍
    assert!(
        body.contains("Command moved to the background after ")
            && body.contains("ms (task ID: bg-auto-"),
        "got {body}"
    );
    assert!(
        body.contains("Do not poll for the result — you will be notified when it completes."),
        "got {body}"
    );
    assert!(
        body.contains("Continue with other tasks in the meantime; if there is nothing else to do, end this turn."),
        "got {body}"
    );
    // 下次提醒间隔
    assert!(
        body.contains("you will get a progress reminder in 5min."),
        "got {body}"
    );
    // 完成通知只出现一次（taskId 会随输出路径再出现一次，属正常）
    assert_eq!(
        body.matches("you will be notified when it completes.").count(),
        1,
        "完成通知只应出现一次: {body}"
    );

    let task_id = body
        .split("(task ID: ")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(crate::bash_task::running_count_for_session("s-tools"), 1);
    crate::bash_task::abort_tasks_for_session("s-tools");
    assert_eq!(crate::bash_task::task_status(&task_id), None, "被中止后记录已移除");

    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_timeout_reminder_mentions_find_for_find_commands() {
    // 命令里出现 `find` 时，自动转后台的说明追加一条 reminder
    let sandbox = Sandbox::new("tools-bash-timeout-find");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let outcome = execute(
        "Bash",
        &json!({ "command": "find . -name x; sleep 5", "timeout": 300 }),
        &context(&sandbox),
    );
    assert!(
        text(&outcome).contains("[reminder] The command contains `find`"),
        "got {}",
        text(&outcome)
    );
    crate::bash_task::abort_tasks_for_session("s-tools");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_manual_background_converts_and_requests_loop_pause() {
    // 手工转后台（`UiEvent.bashBackgroundRequested`）：前台命令跑起来后由注册表触发，
    // 与自动转后台同一条路径。区别只有两点：转换成功置
    // 循环暂停信号；没有 tool_use_id 的执行不登记（按钮无从触发）。
    let sandbox = Sandbox::new("tools-bash-manual-bg");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let pause = LoopPauseSignal::default();
    let ctx = ToolContext {
        session_id: "s-tools".to_string(),
        tool_use_id: Some("toolu-manual-bg".to_string()),
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        pause: Some(pause.clone()),
        user_choice: None,
        background: None,
        subagent: None,
    };
    let handle = std::thread::spawn(move || {
        execute(
            "Bash",
            &json!({ "command": "sleep 30", "timeout": 60_000, "description": "Long sleep" }),
            &ctx,
        )
    });

    // 等注册表登记完成再触发（触发太早找不到条目，返回 false）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !is_foreground_bash_running("toolu-manual-bg") {
        assert!(
            std::time::Instant::now() < deadline,
            "前台 Bash 未登记到手工转后台注册表"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(request_manual_background("toolu-manual-bg"));
    // 未登记 / 已结束的 tool_use_id：幂等返回 false
    assert!(!request_manual_background("toolu-missing"));

    let outcome = handle.join().unwrap();
    let body = text(&outcome);
    assert!(!outcome.is_status_error(), "手工转后台不算工具失败: {body}");
    assert!(
        body.contains("Command moved to the background after ")
            && body.contains("ms (task ID: bg-auto-"),
        "got {body}"
    );

    // 转换成功：暂停信号置位；注册表条目已注销
    assert!(pause.take(), "转换成功应置循环暂停信号");
    assert!(
        !is_foreground_bash_running("toolu-manual-bg"),
        "收尾后注册表条目应注销"
    );
    // 后台任务真实登记，且属于本会话
    assert_eq!(crate::bash_task::running_count_for_session("s-tools"), 1);
    let running = crate::bash_task::running_tasks_for_session("s-tools");
    assert!(
        running[0].task_id.starts_with("bg-auto-"),
        "got {}",
        running[0].task_id
    );
    // 暂停信号携带触发暂停的任务 id：消费方据此把该任务登记为「已兜底」，
    // 查询收尾的兜底提醒不再为它立刻补 reminder。
    assert_eq!(
        pause.take_source_task().as_deref(),
        Some(running[0].task_id.as_str())
    );

    crate::bash_task::abort_tasks_for_session("s-tools");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn concurrency_safety_matches_spec() {
    // 对齐各工具的 `isConcurrencySafe`（`Tool.ts` 默认 false）
    assert!(is_concurrency_safe("Read", &json!({ "file_path": "a.txt" })));
    assert!(is_concurrency_safe("Grep", &json!({ "pattern": "x" })));
    assert!(is_concurrency_safe("Glob", &json!({ "pattern": "*" })));
    // Bash：等同 `isReadOnly(input)`
    assert!(is_concurrency_safe("Bash", &json!({ "command": "ls -la" })));
    assert!(is_concurrency_safe("Bash", &json!({ "command": "git status --short" })));
    assert!(!is_concurrency_safe("Bash", &json!({ "command": "touch x" })));
    assert!(!is_concurrency_safe("Bash", &json!({ "command": "ls && rm -rf build" })));
    // 缺 command / 非字符串：按假值（JS 的 `undefined` 传给 `isReadOnly` 会走空命令分支）
    assert!(!is_concurrency_safe("Bash", &json!({})));
    assert!(!is_concurrency_safe("Bash", &json!({ "command": 3 })));
    // 恒为假 / 未迁入的工具
    // Agent / Reply 恒为真（`AgentTool` / `ReplyTool` 都声明 true）
    assert!(is_concurrency_safe("Agent", &json!({ "prompt": "x", "agentRole": "Master" })));
    assert!(is_concurrency_safe("Reply", &json!({ "message": "x" })));
    for name in ["Edit", "Write", "TodoWrite", "AskUserQuestion"] {
        assert!(!is_concurrency_safe(name, &json!({})), "{name} 不应并发安全");
    }
}

#[test]
fn find_word_detection_uses_ascii_word_boundaries() {
    // `/\bfind\b/` 词边界判定
    assert!(contains_find_word("find . -name x"));
    assert!(contains_find_word("cd a && find b"));
    assert!(contains_find_word("find"));
    assert!(!contains_find_word("finder ."));
    assert!(!contains_find_word("nosfind"));
    assert!(!contains_find_word("echo 'no match'"));
}

#[test]
fn extract_command_name_matches_sleep_detect() {
    // 去环境变量前缀 → 取首词 → 去包裹引号
    assert_eq!(extract_command_name("sleep 5"), "sleep");
    assert_eq!(extract_command_name("  sleep 5  "), "sleep");
    assert_eq!(extract_command_name("FOO=1 sleep 5"), "sleep");
    assert_eq!(extract_command_name("FOO=\"a b\" sleep 5"), "sleep");
    assert_eq!(extract_command_name("FOO='a b' sleep 5"), "sleep");
    assert_eq!(extract_command_name("A=1 B=2 sleep 5"), "sleep");
    assert_eq!(extract_command_name("'sleep 5'"), "sleep");
    assert_eq!(extract_command_name("\"sleep 5\""), "sleep");
    // 对齐 JS `replace(/^["']|["']$/g, '')`：首尾各最多去掉一个引号
    assert_eq!(extract_command_name("'''sleep 5"), "''sleep");
    assert_eq!(extract_command_name("\"\"sleep 5"), "\"sleep");
    assert_eq!(extract_command_name("/usr/bin/sleep 5"), "/usr/bin/sleep");
    assert_eq!(extract_command_name("nosleep 5"), "nosleep");
    // 不是环境变量前缀（值后没有空白分隔）：整段就是命令
    assert_eq!(extract_command_name("FOO=1"), "FOO=1");
    assert_eq!(extract_command_name(""), "");
}

#[test]
fn contains_sleep_command_splits_on_separators() {
    // `containsSleepCommand(splitBySeparators(command))`
    assert!(contains_sleep_command("sleep 5"));
    assert!(contains_sleep_command("echo a; sleep 5"));
    assert!(contains_sleep_command("echo a && sleep 5"));
    assert!(contains_sleep_command("echo a || sleep 5"));
    assert!(contains_sleep_command("echo a | sleep 5"));
    assert!(contains_sleep_command("FOO=1 sleep 5"));
    // 首词不是 sleep 的段不算
    assert!(!contains_sleep_command("echo 'sleep 5'"));
    assert!(!contains_sleep_command("grep \"a|b\" file.txt"));
    assert!(!contains_sleep_command("nosleep 5"));
    assert!(!contains_sleep_command("echo done"));
}

#[test]
fn bash_sleep_commands_have_no_foreground_timeout() {
    // 命令含 sleep 子命令时不设前台超时
    // （`SLEEP_NO_TIMEOUT_MS = 0`），让 sleep 自然完成；进度事件里的 `timeoutMs` 也是 0。
    let sandbox = Sandbox::new("tools-bash-sleep-timeout");
    let collected: std::sync::Arc<std::sync::Mutex<Vec<BashProgress>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&collected);
    let ctx = ToolContext {
        session_id: "s-sleep".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: Some(std::sync::Arc::new(move |progress: BashProgress| {
            sink.lock().unwrap().push(progress);
        })),
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    };

    let outcome = execute("Bash", &json!({ "command": "printf 'go\\n'; sleep 0.2" }), &ctx);
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert!(text(&outcome).contains("go"), "got {}", text(&outcome));
    assert!(
        !text(&outcome).contains("Command was interrupted"),
        "sleep 不应被超时打断: {}",
        text(&outcome)
    );
    let progress = collected.lock().unwrap();
    assert!(!progress.is_empty(), "printf 的块应上报一次进度");
    assert!(
        progress.iter().all(|item| item.timeout_ms == 0),
        "sleep 轮次的 timeoutMs 应为 0: {progress:?}"
    );
}

#[test]
fn bash_abort_kills_a_sleep_command_without_a_timeout() {
    // `sleep` 轮次不设前台超时，abort 必须能立刻杀掉子进程并收尾
    // 。
    let sandbox = Sandbox::new("tools-bash-abort-sleep");
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ctx = ToolContext {
        session_id: "s-abort".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: Some(std::sync::Arc::clone(&cancel)),
        user_choice: None,
        background: None,
        subagent: None,
    };
    let flag = std::sync::Arc::clone(&cancel);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    });

    let started = std::time::Instant::now();
    let outcome = execute("Bash", &json!({ "command": "printf 'go\\n'; sleep 10" }), &ctx);
    let elapsed = started.elapsed();

    assert!(outcome.is_status_error(), "got {}", text(&outcome));
    assert_eq!(outcome.exit_code(), 130);
    assert!(
        text(&outcome).contains("Command was interrupted"),
        "got {}",
        text(&outcome)
    );
    assert!(
        elapsed < std::time::Duration::from_secs(3),
        "abort 未生效，耗时 {elapsed:?}"
    );
}

#[test]
fn bash_timeout_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe() {
    // 子进程退出不等于管道到达 EOF：`sleep 3 &` 让 bash 立刻退出，但后台 `sleep` 继承了
    // 管道写端，读线程会一直阻塞到它退出（Windows 上部署的 Core 二进制 `start` 拉起的
    // detached daemon 是同一形态，而且永不退出）。
    // 前台超时与子进程是否已退出无关，到点就转后台。
    let sandbox = Sandbox::new("tools-bash-timeout-grandchild-pipe");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let started = std::time::Instant::now();
    let outcome = execute(
        "Bash",
        &json!({
            "command": "echo started; sleep 3 &",
            // 超时死线要给 shell 启动留足余量：满载的测试进程里 Git Bash 冷启动
            // 可能超过几百毫秒，死线太紧时 `echo` 还没落盘就转后台，断言
            // 「已累积输出要带过去」就变成对机器速度的断言而不是对行为的断言。
            "timeout": 1500,
            "description": "Grandchild holds the pipe",
        }),
        &context(&sandbox),
    );
    let elapsed = started.elapsed();
    let body = text(&outcome);

    assert!(!outcome.is_error(), "自动转后台不算工具失败: {body}");
    assert_eq!(outcome.exit_code(), 0);
    assert!(body.contains("(task ID: bg-auto-"), "got {body}");
    assert!(body.contains("started"), "转入后台前的已累积输出要带过去: {body}");
    assert!(
        elapsed < std::time::Duration::from_millis(2800),
        "超时后不该等孙进程（sleep 3）自然退出，实际 {elapsed:?}"
    );

    crate::bash_task::abort_tasks_for_session("s-tools");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_abort_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe() {
    // 同上：子进程已退出、孙进程仍持有管道时，abort 也必须立刻收尾
    // 。
    let sandbox = Sandbox::new("tools-bash-abort-grandchild-pipe");
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let ctx = ToolContext {
        session_id: "s-abort-grandchild".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: Some(std::sync::Arc::clone(&cancel)),
        user_choice: None,
        background: None,
        subagent: None,
    };
    let flag = std::sync::Arc::clone(&cancel);
    // 取消死线留给 shell 启动的余量见 `bash_timeout_applies_after_the_shell_...`：
    // 太紧时 `echo` 还没落盘，「已累积输出要保留」就变成对机器速度的断言。
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    });

    let started = std::time::Instant::now();
    let outcome = execute("Bash", &json!({ "command": "echo started; sleep 3 &" }), &ctx);
    let elapsed = started.elapsed();
    let body = text(&outcome);

    assert!(outcome.is_status_error(), "got {body}");
    assert_eq!(outcome.exit_code(), 130);
    assert!(body.contains("Command was interrupted"), "got {body}");
    assert!(body.contains("started"), "已累积输出要保留: {body}");
    assert!(
        elapsed < std::time::Duration::from_millis(2800),
        "abort 未生效，耗时 {elapsed:?}"
    );
}

#[test]
fn bash_passes_cwd_through_without_expansion() {
    // cwd 原样交给子进程，相对路径按 **Core 进程** cwd 解析（不是会话工作目录），
    // `~` 不展开。
    let sandbox = Sandbox::new("tools-bash-cwd");
    sandbox.write_file("sub/marker.txt", "here\n");

    let absolute = sandbox.workspace.join("sub").to_string_lossy().to_string();
    let outcome = execute(
        "Bash",
        &json!({ "command": "cat marker.txt", "cwd": absolute }),
        &context(&sandbox),
    );
    assert_eq!(text(&outcome), "here");

    // 相对路径不再按会话工作目录展开：会话目录下的 sub/ 不会命中
    let outcome = execute(
        "Bash",
        &json!({ "command": "cat marker.txt", "cwd": "sub" }),
        &context(&sandbox),
    );
    assert!(
        !text(&outcome).contains("here"),
        "相对 cwd 不应按会话工作目录展开，got {}",
        text(&outcome)
    );

    // 空串是假值：回退会话工作目录
    let outcome = execute(
        "Bash",
        &json!({ "command": "cat sub/marker.txt", "cwd": "" }),
        &context(&sandbox),
    );
    assert_eq!(text(&outcome), "here");
}

#[test]
fn bash_spawn_failure_is_reported() {
    let sandbox = Sandbox::new("tools-bash-spawn");
    // 不存在的 cwd 会让 spawn 失败
    let outcome = execute(
        "Bash",
        &json!({ "command": "echo x", "cwd": "no/such/dir" }),
        &context(&sandbox),
    );
    assert!(outcome.is_error());
    assert!(text(&outcome).contains("Bash: spawn failed"), "got {}", text(&outcome));
}

// ==================== 后台 Bash 任务（`run_in_background`） ====================

/// 把 `TMPDIR` 指到沙箱里（后台任务的输出文件落在 `TASK_OUTPUT_DIR_NAME`/）
fn point_tmpdir_at(path: &Path) -> Option<String> {
    let previous = std::env::var("TMPDIR").ok();
    std::fs::create_dir_all(path).expect("create tmp dir");
    std::env::set_var("TMPDIR", path);
    previous
}

fn restore_tmpdir(previous: Option<String>) {
    match previous {
        Some(value) => std::env::set_var("TMPDIR", value),
        None => std::env::remove_var("TMPDIR"),
    }
}

fn background_hooks(captured: &std::sync::Arc<BackgroundCapture>) -> crate::bash_task::Hooks {
    let notify = std::sync::Arc::clone(captured);
    let sync = std::sync::Arc::clone(captured);
    crate::bash_task::Hooks {
        notify: std::sync::Arc::new(move |session_id: &str, content: &str| {
            notify
                .notifications
                .lock()
                .unwrap()
                .push((session_id.to_string(), content.to_string()));
        }),
        sync_background: std::sync::Arc::new(move |session_id: &str| {
            sync.background_syncs
                .lock()
                .unwrap()
                .push(session_id.to_string());
        }),
    }
}

fn background_context(
    sandbox: &Sandbox,
    captured: std::sync::Arc<BackgroundCapture>,
) -> ToolContext {
    ToolContext {
        session_id: "s-bg".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: None,
        background: Some(background_hooks(&captured)),
        subagent: None,
    }
}

#[derive(Default)]
struct BackgroundCapture {
    notifications: std::sync::Mutex<Vec<(String, String)>>,
    background_syncs: std::sync::Mutex<Vec<String>>,
}

fn wait_for_background_notification(
    captured: &BackgroundCapture,
    timeout_ms: u64,
) -> Option<(String, String)> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        if let Some(item) = captured.notifications.lock().unwrap().first().cloned() {
            return Some(item);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

#[test]
fn bash_background_returns_a_task_id_immediately() {
    let sandbox = Sandbox::new("tools-bash-background");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let captured = std::sync::Arc::new(BackgroundCapture::default());
    let ctx = background_context(&sandbox, std::sync::Arc::clone(&captured));
    let outcome = execute(
        "Bash",
        &json!({ "command": "echo bg", "run_in_background": true, "description": "Say bg" }),
        &ctx,
    );
    let body = text(&outcome);
    assert!(!outcome.is_error(), "got {body}");
    assert_eq!(outcome.exit_code(), 0);
    assert!(
        body.starts_with("Command running in background with ID: bg-"),
        "got {body}"
    );
    assert!(body.contains("You will be notified automatically when it completes."), "got {body}");
    assert!(
        body.contains("you will get a progress reminder in 5min."),
        "got {body}"
    );
    // 提示里带上输出文件路径（file mode 的子进程 stdout 直接写该文件）
    let task_id = body
        .trim_start_matches("Command running in background with ID: ")
        .split('.')
        .next()
        .unwrap()
        .to_string();
    assert!(
        body.contains(&format!("Output is being written to: {}", crate::bash_task::task_output_path(&task_id).to_string_lossy())),
        "got {body}"
    );

    // 完成后通知里带上子进程的 stdout
    let (session_id, notification) =
        wait_for_background_notification(&captured, 10_000).expect("完成通知");
    assert_eq!(session_id, "s-bg");
    assert!(notification.contains("Output (first 500 chars):\nbg"), "{notification}");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_background_coerces_truthy_values_like_zod() {
    let sandbox = Sandbox::new("tools-bash-background-coerce");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();
    let ctx = context(&sandbox);

    // `z.coerce.boolean()` 是 JS `Boolean(value)`：字符串 "false" 也是真值
    let truthy = execute(
        "Bash",
        &json!({ "command": "echo x", "run_in_background": "false" }),
        &ctx,
    );
    assert!(
        text(&truthy).starts_with("Command running in background with ID: bg-"),
        "got {}",
        text(&truthy)
    );

    // `false` / 0 / "" / null 是假值：走前台
    for falsy in [json!(false), json!(0), json!(""), json!(null)] {
        let outcome = execute(
            "Bash",
            &json!({ "command": "echo foreground", "run_in_background": falsy }),
            &ctx,
        );
        assert_eq!(text(&outcome), "foreground", "input={falsy}");
    }
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn sleep_moves_to_the_background_when_a_background_task_completes() {
    // sleep 命令不设前台超时，
    // 但 sleep 期间若收到**本会话**的后台任务完成通知，立刻把 sleep 转入后台，
    // 避免阻塞模型处理通知（不设最短运行时长）。
    let sandbox = Sandbox::new("tools-bash-sleep-notify");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let captured = std::sync::Arc::new(BackgroundCapture::default());
    let trigger_captured = std::sync::Arc::clone(&captured);
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        crate::bash_task::spawn_background(
            "echo quick",
            &cwd,
            "Quick",
            "s-bg",
            Some(background_hooks(&trigger_captured)),
        )
        .expect("spawn trigger task");
    });

    let ctx = background_context(&sandbox, std::sync::Arc::clone(&captured));
    let outcome = execute("Bash", &json!({ "command": "sleep 5" }), &ctx);
    let body = text(&outcome);
    assert!(
        body.contains("Command moved to the background after ")
            && body.contains("ms (task ID: bg-auto-"),
        "got {body}"
    );

    crate::bash_task::abort_tasks_for_session("s-bg");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn foreground_command_needs_three_seconds_before_a_completion_notification_backgrounds_it() {
    // `AUTO_BG_MIN_RUNNING_MS`：普通命令（有前台预算）收到后台任务完成
    // 通知时，只有已运行 ≥ 3s 才自动转后台。
    let sandbox = Sandbox::new("tools-bash-auto-bg-min");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let captured = std::sync::Arc::new(BackgroundCapture::default());
    let trigger_captured = std::sync::Arc::clone(&captured);
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    std::thread::spawn(move || {
        // 400ms 就完成：太早，不应触发
        std::thread::sleep(std::time::Duration::from_millis(400));
        crate::bash_task::spawn_background(
            "echo early",
            &cwd,
            "Early",
            "s-bg",
            Some(background_hooks(&trigger_captured)),
        )
        .expect("spawn early task");
        // 再等 3.1s 让第二个任务完成：此时前台命令已跑够 3s，应当触发
        std::thread::sleep(std::time::Duration::from_millis(3100));
        crate::bash_task::spawn_background(
            "echo late",
            &cwd,
            "Late",
            "s-bg",
            Some(background_hooks(&trigger_captured)),
        )
        .expect("spawn late task");
    });

    let ctx = background_context(&sandbox, std::sync::Arc::clone(&captured));
    // 显式前台预算（10s）远大于触发点，保证不是「超时」触发的转后台
    let outcome = execute(
        "Bash",
        &json!({ "command": "sleep 20", "timeout": 10_000 }),
        &ctx,
    );
    let body = text(&outcome);
    assert!(body.contains("(task ID: bg-auto-"), "got {body}");
    let elapsed: u64 = body
        .split("Command moved to the background after ")
        .nth(1)
        .and_then(|rest| rest.split("ms").next())
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| panic!("缺少已运行时长: {body}"));
    assert!(
        elapsed >= 3000,
        "过早的完成通知不应触发转后台（elapsed={elapsed}ms）: {body}"
    );

    crate::bash_task::abort_tasks_for_session("s-bg");
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_background_syncs_the_session_background_fact() {
    let sandbox = Sandbox::new("tools-bash-background-sync");
    let previous = point_tmpdir_at(&sandbox.root.join("tmp"));
    crate::bash_task::reset_for_test();

    let captured = std::sync::Arc::new(BackgroundCapture::default());
    let ctx = background_context(&sandbox, std::sync::Arc::clone(&captured));
    execute(
        "Bash",
        &json!({ "command": "echo sync", "run_in_background": true }),
        &ctx,
    );
    // 注册时同步一次（有运行中的任务），完成后再同步一次（已无运行中任务）
    assert_eq!(captured.background_syncs.lock().unwrap().as_slice(), ["s-bg"]);
    wait_for_background_notification(&captured, 10_000).expect("完成通知");
    assert_eq!(
        captured.background_syncs.lock().unwrap().as_slice(),
        ["s-bg", "s-bg"]
    );
    restore_tmpdir(previous);
    crate::bash_task::reset_for_test();
}

#[test]
fn bash_drains_output_larger_than_the_pipe_buffer() {
    // 输出超过管道缓冲区时，父进程必须并发读取，否则子进程阻塞在 write、双方互等到超时。
    let sandbox = Sandbox::new("tools-bash-large-output");
    let outcome = execute(
        "Bash",
        &json!({ "command": "yes x | head -n 100000", "timeout": 20_000 }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert!(
        !text(&outcome).contains("[timeout]"),
        "大输出不应超时（死锁回归）: {}",
        text(&outcome)
    );
    // 尾部换行会被去掉，因此是 199_999 而不是 200_000
    assert!(text(&outcome).len() >= 100_000, "len={}", text(&outcome).len());
}

#[test]
fn read_with_huge_limit_does_not_panic() {
    let sandbox = Sandbox::new("tools-read-huge-limit");
    sandbox.write_file("a.txt", "one\ntwo\n");
    let outcome = execute(
        "Read",
        &json!({ "file_path": "a.txt", "limit": u64::MAX }),
        &context(&sandbox),
    );
    // limit 不得超过单次最大行数
    assert!(outcome.is_error());
    assert_eq!(
        text(&outcome),
        format!("limit must be less than or equal to {READ_MAX_LINES}")
    );
}

#[test]
fn edit_with_zero_limit_does_not_panic() {
    let sandbox = Sandbox::new("tools-edit-zero-limit");
    sandbox.write_file("a.txt", "one\ntwo\nthree\n");
    // limit=0 且 offset>1 旧实现会算出反向切片并 panic
    let outcome = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "nope", "new_string": "x", "offset": 3, "limit": 0 }),
        &context(&sandbox),
    );
    assert!(outcome.is_error(), "越界搜索区间应返回错误而不是 panic");
}

#[test]
fn bash_reports_streaming_progress() {
    // stdout / stderr 的每个数据块都回调一次进度，
    // `output` 是增量、`fullOutput` 是累计输出的 4K 预览。
    let sandbox = Sandbox::new("tools-bash-progress");
    let collected: std::sync::Arc<std::sync::Mutex<Vec<BashProgress>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&collected);
    let ctx = ToolContext {
        session_id: "s-progress".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: Some(std::sync::Arc::new(move |progress: BashProgress| {
            sink.lock().unwrap().push(progress);
        })),
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    };

    let outcome = execute(
        "Bash",
        &json!({ "command": "printf 'first\\n'; printf 'second\\n' 1>&2" }),
        &ctx,
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));

    let progress = collected.lock().unwrap();
    assert!(!progress.is_empty(), "应至少上报一次进度");
    // 增量拼接后应等于完整输出
    let joined: String = progress.iter().map(|item| item.output.clone()).collect();
    assert!(joined.contains("first"), "got {joined:?}");
    assert!(joined.contains("second"), "got {joined:?}");
    // 累计预览的尾部与最终结果一致；规模按完整输出统计
    let last = progress.last().unwrap();
    assert!(last.full_output.contains("first"), "got {last:?}");
    assert!(last.total_bytes >= joined.chars().count());
    assert!(last.total_lines >= 1);
    assert_eq!(last.timeout_ms, 60_000);
    assert!(last.elapsed_time_seconds >= 0.0);
}

#[test]
fn bash_progress_preview_is_capped_at_four_kilobytes() {
    let sandbox = Sandbox::new("tools-bash-progress-cap");
    let collected: std::sync::Arc<std::sync::Mutex<Vec<BashProgress>>> =
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&collected);
    let ctx = ToolContext {
        session_id: "s-progress-cap".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: Some(std::sync::Arc::new(move |progress: BashProgress| {
            sink.lock().unwrap().push(progress);
        })),
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    };

    // 输出远大于 4K：`fullOutput` 必须带上省略标记，`totalBytes` 仍是完整长度
    let outcome = execute(
        "Bash",
        &json!({ "command": "for i in $(seq 1 2000); do echo line-$i-xxxxxxxx; done" }),
        &ctx,
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));

    let progress = collected.lock().unwrap();
    let last = progress.last().unwrap();
    assert!(
        last.full_output.contains("chars omitted"),
        "got {}",
        last.full_output
    );
    assert!(last.total_bytes > 4096, "got {}", last.total_bytes);
}

// ==================== Read ====================

#[test]
fn read_requires_a_path_and_reports_missing_files() {
    let sandbox = Sandbox::new("tools-read-missing");
    let ctx = context(&sandbox);
    let missing_arg = execute("Read", &json!({}), &ctx);
    assert_eq!(text(&missing_arg), "file_path is required and must be a string");

    let not_found = execute("Read", &json!({ "file_path": "nope.txt" }), &ctx);
    assert!(not_found.is_error());
    assert!(text(&not_found).starts_with("File not found:"), "got {}", text(&not_found));
}

#[test]
fn read_treats_an_empty_file_path_as_missing_and_falls_back_to_path() {
    // 空串是假值，
    // 既算缺参，也会回退到 `path`。
    let sandbox = Sandbox::new("tools-read-empty-path");
    sandbox.write_file("a.txt", "hello\n");
    let ctx = context(&sandbox);

    let empty = execute("Read", &json!({ "file_path": "" }), &ctx);
    assert!(empty.is_error());
    assert_eq!(text(&empty), "file_path is required and must be a string");

    let fallback = execute("Read", &json!({ "file_path": "", "path": "a.txt" }), &ctx);
    assert!(!fallback.is_error(), "got {}", text(&fallback));
    assert_eq!(text(&fallback), "1|hello\n2|");
}

#[test]
fn read_prefixes_lines_with_one_based_numbers() {
    let sandbox = Sandbox::new("tools-read-lines");
    sandbox.write_file("a.txt", "first\nsecond\nthird\n");
    let outcome = execute("Read", &json!({ "file_path": "a.txt" }), &context(&sandbox));
    // 按 `\n` 切分保留末尾空行，因此末尾多一行 `4|`
    assert_eq!(text(&outcome), "1|first\n2|second\n3|third\n4|");
}

#[test]
fn read_supports_offset_and_limit() {
    let sandbox = Sandbox::new("tools-read-window");
    sandbox.write_file("a.txt", "1\n2\n3\n4\n5\n");
    let ctx = context(&sandbox);

    let window = execute("Read", &json!({ "file_path": "a.txt", "offset": 2, "limit": 2 }), &ctx);
    assert_eq!(
        text(&window),
        "2|2\n3|3\n(Showing lines 2-3 of 6. Use offset=4 to continue.)"
    );

    // offset 超出文件长度 → 一行空编号
    let beyond = execute("Read", &json!({ "file_path": "a.txt", "offset": 99 }), &ctx);
    assert_eq!(text(&beyond), "99|");

    // offset 下限是 1
    let clamped = execute("Read", &json!({ "file_path": "a.txt", "offset": 0, "limit": 1 }), &ctx);
    assert_eq!(
        text(&clamped),
        "1|1\n(Showing lines 1-1 of 6. Use offset=2 to continue.)"
    );
}

#[test]
fn read_reports_empty_files_and_directories() {
    let sandbox = Sandbox::new("tools-read-empty");
    sandbox.write_file("empty.txt", "");
    let ctx = context(&sandbox);

    let empty = execute("Read", &json!({ "file_path": "empty.txt" }), &ctx);
    assert_eq!(text(&empty), "1|");

    let directory = execute("Read", &json!({ "file_path": "." }), &ctx);
    assert!(directory.is_error());
    // 非普通文件的报错文案
    assert_eq!(text(&directory), "Path provided was not a file!");
}

#[test]
fn read_returns_images_as_base64() {
    let sandbox = Sandbox::new("tools-read-image");
    let bytes = minimal_png_bytes();
    let path = sandbox.workspace.join("pic.png");
    std::fs::write(&path, &bytes).unwrap();

    let outcome = execute("Read", &json!({ "file_path": "pic.png" }), &context(&sandbox));
    assert!(!outcome.is_error());
    // 图片以 image content block 返回（不是把 base64 拼成文本）
    assert_eq!(
        outcome.blocks(),
        Some(&json!([{
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64_encode(&bytes),
            },
        }]))
    );
}

#[test]
fn read_recognises_every_supported_image_extension() {
    for (name, media_type) in [
        ("a.png", "image/png"),
        ("a.PNG", "image/png"),
        ("a.jpg", "image/jpeg"),
        ("a.jpeg", "image/jpeg"),
        ("a.gif", "image/gif"),
        ("a.webp", "image/webp"),
        ("a.bmp", "image/bmp"),
    ] {
        assert_eq!(
            is_image_extension(Path::new(name)),
            Some(media_type),
            "extension of {name}"
        );
    }
    assert_eq!(is_image_extension(Path::new("a.txt")), None);
    assert_eq!(is_image_extension(Path::new("noext")), None);
}

#[test]
fn read_rejects_image_content_that_does_not_match_its_extension() {
    // 内容是 JPEG，扩展名是 .png：不发非法 image block，直接报错。
    let sandbox = Sandbox::new("tools-read-image-mismatch");
    let bytes = decode_hex("ffd8ffe000104a46494600010100000100010000ffd9");
    std::fs::write(sandbox.workspace.join("bad.png"), &bytes).unwrap();
    let outcome = execute("Read", &json!({ "file_path": "bad.png" }), &context(&sandbox));
    assert_eq!(
        text(&outcome),
        "Invalid image file: bad.png. The content is not a valid image/png image (file signature does not match the format)."
    );
}

#[test]
fn read_rejects_truncated_images() {
    // PNG 块头声明 13 字节数据，文件在中途结束
    let sandbox = Sandbox::new("tools-read-image-truncated");
    let bytes = decode_hex("89504e470d0a1a0a0000000d4948445200000001");
    std::fs::write(sandbox.workspace.join("cut.png"), &bytes).unwrap();
    let outcome = execute("Read", &json!({ "file_path": "cut.png" }), &context(&sandbox));
    assert_eq!(
        text(&outcome),
        "Invalid image file: cut.png. The content is not a valid image/png image (declared length exceeds the actual file size)."
    );
}

#[test]
fn read_truncates_overlong_lines_and_huge_files() {
    let sandbox = Sandbox::new("tools-read-truncate");
    sandbox.write_file("long.txt", &format!("{}\n", "x".repeat(READ_MAX_LINE_CHARS + 500)));
    let outcome = execute("Read", &json!({ "file_path": "long.txt" }), &context(&sandbox));
    let rendered = text(&outcome);
    let marker = format!("... (line truncated to {READ_MAX_LINE_CHARS} chars)");
    let truncated = format!("{}{}", "x".repeat(READ_MAX_LINE_CHARS), marker);
    // 末尾空行也占一行
    assert_eq!(rendered, format!("1|{truncated}\n2|"));

    // 输出超过 50KB 时提前收尾，并给出 `Output capped.` 续读提示。
    // 每行 99 字符 + 换行 = 100 字节，约 512 行后越过 50KB。
    let line = format!("{}\n", "a".repeat(99));
    sandbox.write_file("huge.txt", &line.repeat(3000));
    let huge = execute(
        "Read",
        &json!({ "file_path": "huge.txt", "limit": 2000 }),
        &context(&sandbox),
    );
    let rendered = text(&huge);
    assert!(
        rendered.contains("(Output capped. Showing lines 1-"),
        "缺少 Output capped footer: {}",
        &rendered[rendered.len().saturating_sub(120)..]
    );
    assert!(rendered.ends_with("to continue.)"), "footer 不完整");
    assert!(rendered.len() < 60 * 1024, "输出应被 50KB 上限截住，实际 {}", rendered.len());
}

// ==================== Read：xlsx ====================

/// 单测用的最小 xlsx 单元格
enum XlsxCell {
    Text(&'static str),
    Number(f64),
    Bool(bool),
    /// `t="d"`（ISO 8601 日期）单元格
    Iso(&'static str),
}

fn column_letter(index: usize) -> String {
    let mut n = index;
    let mut out = String::new();
    loop {
        out.insert(0, (b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out
}

/// 现造一个最小 xlsx（inline string，无 sharedStrings），只含一个 sheet。
fn write_minimal_xlsx(path: &std::path::Path, sheet_name: &str, rows: &[Vec<XlsxCell>]) {
    use std::io::Write;

    let mut cell_xml = String::new();
    for (row_index, row) in rows.iter().enumerate() {
        let row_number = row_index + 1;
        cell_xml.push_str(&format!("<row r=\"{row_number}\">"));
        for (col_index, cell) in row.iter().enumerate() {
            let reference = format!("{}{row_number}", column_letter(col_index));
            match cell {
                XlsxCell::Text(value) => cell_xml.push_str(&format!(
                    "<c r=\"{reference}\" t=\"inlineStr\"><is><t>{value}</t></is></c>"
                )),
                XlsxCell::Number(value) => {
                    cell_xml.push_str(&format!("<c r=\"{reference}\"><v>{value}</v></c>"))
                }
                XlsxCell::Bool(value) => cell_xml.push_str(&format!(
                    "<c r=\"{reference}\" t=\"b\"><v>{}</v></c>",
                    if *value { 1 } else { 0 }
                )),
                XlsxCell::Iso(value) => {
                    cell_xml.push_str(&format!("<c r=\"{reference}\" t=\"d\"><v>{value}</v></c>"))
                }
            }
        }
        cell_xml.push_str("</row>");
    }

    let max_col = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let dimension = format!("A1:{}{}", column_letter(max_col - 1), rows.len().max(1));
    let sheet_xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
         <dimension ref=\"{dimension}\"/><sheetData>{cell_xml}</sheetData></worksheet>"
    );
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
         <Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\
         </Types>";
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>\
         </Relationships>";
    let workbook = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
         <sheets><sheet name=\"{sheet_name}\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
    );
    let workbook_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>\
         </Relationships>";

    let file = std::fs::File::create(path).expect("create xlsx");
    let mut archive = zip::ZipWriter::new(file);
    for (name, content) in [
        ("[Content_Types].xml", content_types),
        ("_rels/.rels", root_rels),
        ("xl/workbook.xml", workbook.as_str()),
        ("xl/_rels/workbook.xml.rels", workbook_rels),
        ("xl/worksheets/sheet1.xml", sheet_xml.as_str()),
    ] {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .expect("start_file");
        archive.write_all(content.as_bytes()).expect("write");
    }
    archive.finish().expect("finish xlsx");
}

#[test]
fn read_xlsx_formats_rows_like_spec() {
    let sandbox = Sandbox::new("tools-read-xlsx");
    write_minimal_xlsx(
        &sandbox.workspace.join("a.xlsx"),
        "People",
        &[
            vec![
                XlsxCell::Text("Name"),
                XlsxCell::Text("Age"),
                XlsxCell::Text("Score"),
            ],
            vec![
                XlsxCell::Text("Alice"),
                XlsxCell::Number(30.0),
                XlsxCell::Number(95.5),
            ],
            // 空行被过滤
            vec![],
            vec![
                XlsxCell::Text("Bob"),
                XlsxCell::Number(25.0),
                XlsxCell::Number(88.0),
            ],
        ],
    );
    let outcome = execute("Read", &json!({ "file_path": "a.xlsx" }), &context(&sandbox));
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert_eq!(
        text(&outcome),
        "1|Row 1: Name  | Age | Score\n2|Row 2: Alice | 30  | 95.5 \n3|Row 3: Bob   | 25  | 88   "
    );
}

#[test]
fn read_xlsx_reports_a_missing_sheet() {
    let sandbox = Sandbox::new("tools-read-xlsx-sheet");
    write_minimal_xlsx(
        &sandbox.workspace.join("a.xlsx"),
        "People",
        &[vec![XlsxCell::Text("x")]],
    );
    let outcome = execute(
        "Read",
        &json!({ "file_path": "a.xlsx", "sheet": "Missing" }),
        &context(&sandbox),
    );
    assert_eq!(
        text(&outcome),
        "1|Sheet \"Missing\" not found. Available sheets: People"
    );
}

#[test]
fn read_xlsx_respects_offset_and_limit() {
    let sandbox = Sandbox::new("tools-read-xlsx-window");
    write_minimal_xlsx(
        &sandbox.workspace.join("a.xlsx"),
        "People",
        &[
            vec![
                XlsxCell::Text("Name"),
                XlsxCell::Text("Age"),
                XlsxCell::Text("Score"),
            ],
            vec![
                XlsxCell::Text("Alice"),
                XlsxCell::Number(30.0),
                XlsxCell::Number(95.5),
            ],
            vec![
                XlsxCell::Text("Bob"),
                XlsxCell::Number(25.0),
                XlsxCell::Number(88.0),
            ],
        ],
    );
    let outcome = execute(
        "Read",
        &json!({ "file_path": "a.xlsx", "offset": 2, "limit": 1 }),
        &context(&sandbox),
    );
    // 列宽按**窗口内**的行计算
    assert_eq!(
        text(&outcome),
        "2|Row 2: Alice | 30 | 95.5\n(Showing lines 2-2 of 3. Use offset=3 to continue.)"
    );
}

#[test]
fn read_xlsx_renders_booleans_like_javascript() {
    let sandbox = Sandbox::new("tools-read-xlsx-bool");
    write_minimal_xlsx(
        &sandbox.workspace.join("a.xlsx"),
        "Flags",
        &[vec![XlsxCell::Bool(true), XlsxCell::Bool(false)]],
    );
    let outcome = execute("Read", &json!({ "file_path": "a.xlsx" }), &context(&sandbox));
    assert_eq!(text(&outcome), "1|Row 1: true | false");
}

#[test]
fn read_xlsx_keeps_iso_dates_as_text() {
    // 有意保留的差异：SheetJS 读 `t="d"` 单元格时会带约 43 秒的系统性偏移，
    // 原样输出单元格里的 ISO 文本。
    let sandbox = Sandbox::new("tools-read-xlsx-iso");
    write_minimal_xlsx(
        &sandbox.workspace.join("a.xlsx"),
        "S",
        &[vec![XlsxCell::Iso("2024-01-02T03:04:05Z")]],
    );
    let outcome = execute("Read", &json!({ "file_path": "a.xlsx" }), &context(&sandbox));
    assert_eq!(text(&outcome), "1|Row 1: 2024-01-02T03:04:05Z");
}

#[test]
fn xlsx_cells_and_columns_match_javascript_semantics() {
    // 数字格式化走 ECMAScript 口径
    assert_eq!(js_number_string(30.0), "30");
    assert_eq!(js_number_string(95.5), "95.5");
    assert_eq!(js_number_string(1e21), "1e+21");
    assert_eq!(js_number_string(1e-7), "1e-7");
    assert_eq!(js_number_string(f64::NAN), "NaN");
    // String(cell ?? '')
    assert_eq!(js_cell_string(&json!(true)), "true");
    assert_eq!(js_cell_string(&json!(false)), "false");
    assert_eq!(js_cell_string(&json!(95.5)), "95.5");
    assert_eq!(js_cell_string(&Value::String(String::new())), "");

    // 空行过滤 + 尾部空列裁剪
    let data = vec![
        vec![json!("a"), json!("")],
        vec![json!("b"), json!("")],
        vec![json!(""), json!("")],
    ];
    let (content, line_count, start_line, total_lines, truncated) =
        format_xlsx_data(&data, None, None);
    assert_eq!(start_line, 0);
    assert_eq!(total_lines, 2);
    assert_eq!(line_count, 2);
    assert!(!truncated);
    assert_eq!(content, "Row 1: a\nRow 2: b");
}

#[test]
fn base64_encode_matches_rfc4648() {
    assert_eq!(base64_encode(b""), "");
    assert_eq!(base64_encode(b"f"), "Zg==");
    assert_eq!(base64_encode(b"fo"), "Zm8=");
    assert_eq!(base64_encode(b"foo"), "Zm9v");
    assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
    assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
    assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    assert_eq!(base64_encode(&[0xff, 0xfe, 0xfd]), "//79");
    assert_eq!(base64_encode(&[0x00, 0x00, 0x00]), "AAAA");
}

// ==================== Write ====================

#[test]
fn write_requires_a_path() {
    let sandbox = Sandbox::new("tools-write-missing");
    let outcome = execute("Write", &json!({ "content": "x" }), &context(&sandbox));
    assert_eq!(text(&outcome), "file_path is required and must be a string");
    // 空串与缺参同义
    let empty = execute("Write", &json!({ "file_path": "", "content": "x" }), &context(&sandbox));
    assert_eq!(text(&empty), "file_path is required and must be a string");
}

#[test]
fn write_creates_parent_directories_and_reports_size() {
    let sandbox = Sandbox::new("tools-write");
    let outcome = execute(
        "Write",
        &json!({ "file_path": "nested/deep/a.txt", "content": "hello" }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error());
    assert_eq!(std::fs::read_to_string(sandbox.workspace.join("nested/deep/a.txt")).unwrap(), "hello");
    assert_eq!(text(&outcome), "Created file: nested/deep/a.txt\nLines: 1\nBytes: 5");
}

#[test]
fn write_requires_content_and_overwrites() {
    let sandbox = Sandbox::new("tools-write-empty");
    sandbox.write_file("a.txt", "old");
    let ctx = context(&sandbox);

    let missing = execute("Write", &json!({ "file_path": "a.txt" }), &ctx);
    assert_eq!(text(&missing), "content is required");

    let outcome = execute("Write", &json!({ "file_path": "a.txt", "content": "" }), &ctx);
    assert!(!outcome.is_error());
    assert_eq!(std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(), "");
    assert_eq!(text(&outcome), "Updated file: a.txt\nLines: 1\nBytes: 0");
}

// ==================== Edit ====================

#[test]
fn edit_validates_its_arguments() {
    let sandbox = Sandbox::new("tools-edit-args");
    let ctx = context(&sandbox);
    assert_eq!(
        text(&execute("Edit", &json!({}), &ctx)),
        "file_path is required and must be a string"
    );
    // 空串与缺参同义
    assert_eq!(
        text(&execute("Edit", &json!({ "file_path": "", "old_string": "a", "new_string": "b" }), &ctx)),
        "file_path is required and must be a string"
    );
    assert_eq!(
        text(&execute("Edit", &json!({ "file_path": "a.txt" }), &ctx)),
        "old_string is required"
    );

    // 文件不存在：ENOENT 文案
    let unreadable = execute("Edit", &json!({ "file_path": "nope.txt", "old_string": "a" }), &ctx);
    let expected_path = sandbox.workspace.join("nope.txt");
    assert_eq!(
        text(&unreadable),
        format!(
            "ENOENT: no such file or directory, open '{}'",
            expected_path.display()
        )
    );
}

#[test]
fn edit_replaces_a_unique_occurrence() {
    let sandbox = Sandbox::new("tools-edit-once");
    sandbox.write_file("a.txt", "alpha beta gamma\n");
    let outcome = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "beta", "new_string": "BETA" }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error());
    assert_eq!(
        text(&outcome),
        "Edited file: a.txt\nMade 1 replacement\nEdited line 1\nLines: 2 (+1, -1)"
    );
    assert_eq!(std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(), "alpha BETA gamma\n");
}

#[test]
fn edit_reports_missing_and_ambiguous_needles() {
    let sandbox = Sandbox::new("tools-edit-ambiguous");
    sandbox.write_file("a.txt", "x\nx\nx\n");
    let ctx = context(&sandbox);

    let missing = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "zzz", "new_string": "y" }),
        &ctx,
    );
    assert!(
        text(&missing).starts_with("The specified old_string was not found in the file."),
        "got {}",
        text(&missing)
    );

    let ambiguous = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "x", "new_string": "y" }),
        &ctx,
    );
    assert!(
        text(&ambiguous).contains("The old_string matches 3 locations within the search range."),
        "got {}",
        text(&ambiguous)
    );
    // 文件未被改动
    assert_eq!(std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(), "x\nx\nx\n");
}

#[test]
fn edit_replace_all_rewrites_every_occurrence() {
    let sandbox = Sandbox::new("tools-edit-all");
    sandbox.write_file("a.txt", "x\nx\nx\n");
    let outcome = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "x", "new_string": "y", "replace_all": true }),
        &context(&sandbox),
    );
    assert_eq!(
        text(&outcome),
        "Edited file: a.txt\nMade 3 replacements\nEdited line 1\nLines: 4 (+3, -3)"
    );
    assert_eq!(std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(), "y\ny\ny\n");
}

#[test]
fn edit_scope_limits_the_search_range() {
    let sandbox = Sandbox::new("tools-edit-scope");
    sandbox.write_file("a.txt", "keep\ntarget\nkeep\n");
    let ctx = context(&sandbox);

    // 只搜第 2 行：唯一命中
    let scoped = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "target", "new_string": "hit",
                 "offset": 2, "limit": 1 }),
        &ctx,
    );
    assert_eq!(
        text(&scoped),
        "Edited file: a.txt\nMade 1 replacement\nEdited line 2\nLines: 4 (+1, -1)"
    );
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "keep\nhit\nkeep\n"
    );

    // 范围外的内容不应被匹配到
    let outside = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "keep", "new_string": "gone",
                 "offset": 2, "limit": 1 }),
        &ctx,
    );
    assert!(
        text(&outside)
            .starts_with("The specified old_string was not found within the specified line range."),
        "got {}",
        text(&outside)
    );
}

#[test]
fn edit_carries_diff_fields_for_the_tool_result_block() {
    // `mapToolResultToToolResultBlockParam` 会把 startLine / endLine /
    // beforeContent 原样拷进 tool_result block（UI diff 展示 + 历史恢复重算 diff）
    let sandbox = Sandbox::new("tools-edit-diff-fields");
    sandbox.write_file("a.txt", "one\r\ntwo\r\nthree\r\n");
    let outcome = execute(
        "Edit",
        &json!({ "file_path": "a.txt", "old_string": "two", "new_string": "TWO" }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error());
    let extra = outcome.extra().expect("Edit 应携带额外字段");
    assert_eq!(extra["startLine"], 2);
    assert_eq!(extra["endLine"], 2);
    // beforeContent 是规范化（LF）后的原始内容
    assert_eq!(extra["beforeContent"], "one\ntwo\nthree\n");
    // 写回时仍保留 CRLF
    assert_eq!(
        std::fs::read_to_string(sandbox.workspace.join("a.txt")).unwrap(),
        "one\r\nTWO\r\nthree\r\n"
    );
}

#[test]
fn write_carries_before_content_for_rollback() {
    let sandbox = Sandbox::new("tools-write-before-content");
    let ctx = context(&sandbox);

    // 新建文件：beforeContent 为 null
    let created = execute(
        "Write",
        &json!({ "file_path": "new.txt", "content": "hello\n" }),
        &ctx,
    );
    let extra = created.extra().expect("Write 应携带额外字段");
    assert_eq!(extra["beforeContent"], Value::Null);

    // 覆盖文件：beforeContent 是旧内容
    let updated = execute(
        "Write",
        &json!({ "file_path": "new.txt", "content": "world\n" }),
        &ctx,
    );
    let extra = updated.extra().expect("Write 应携带额外字段");
    assert_eq!(extra["beforeContent"], "hello\n");
}

// ==================== Grep / Glob ====================

fn grep_sandbox(name: &str) -> Sandbox {
    let sandbox = Sandbox::new(name);
    sandbox.point_extension_at_repo();
    sandbox.write_file("src/a.ts", "export const alpha = 1;\nexport const beta = 2;\n");
    sandbox.write_file("src/b.ts", "const gamma = 3;\n");
    sandbox.write_file("notes.md", "alpha\n");
    sandbox
}

#[test]
fn grep_requires_a_pattern() {
    let sandbox = Sandbox::new("tools-grep-missing");
    let outcome = execute("Grep", &json!({}), &context(&sandbox));
    assert_eq!(text(&outcome), "pattern is required and must be a string");

    // 空串与缺参同义
    let empty = execute("Grep", &json!({ "pattern": "" }), &context(&sandbox));
    assert_eq!(text(&empty), "pattern is required and must be a string");
}

#[test]
fn grep_defaults_to_files_with_matches() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-grep-default");
    let outcome = execute("Grep", &json!({ "pattern": "alpha" }), &context(&sandbox));
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    let output = text(&outcome);
    // 默认 files_with_matches：只列文件，不列匹配行
    assert!(output.starts_with("Found "), "got {output}");
    assert!(output.contains("a.ts"), "got {output}");
    assert!(output.contains("notes.md"), "got {output}");
    assert!(!output.contains("export const"), "只应列出文件名: {output}");
}

#[test]
fn grep_lists_matching_lines_with_numbers() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-grep-content");
    let outcome = execute(
        "Grep",
        &json!({ "pattern": "alpha", "output_mode": "content" }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    let output = text(&outcome);
    assert!(output.contains("a.ts"), "got {output}");
    assert!(output.contains(":1:export const alpha"), "got {output}");
}

#[test]
fn grep_treats_dash_prefixed_pattern_as_a_pattern_not_an_option() {
    if !ripgrep_available() {
        return;
    }
    // `--pre=<cmd>` 这类 pattern 若被 rg 当成选项，会变成任意命令执行；
    // 这里必须按字面量匹配，并返回匹配行而不是执行。
    let sandbox = Sandbox::new("tools-grep-dash-pattern");
    sandbox.point_extension_at_repo();
    sandbox.write_file("dash.txt", "alpha\n--pre=boom\nbeta\n");
    let outcome = execute(
        "Grep",
        &json!({ "pattern": "--pre=boom", "path": "dash.txt", "output_mode": "content" }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert!(text(&outcome).contains("--pre=boom"), "got {}", text(&outcome));
}

#[test]
fn grep_supports_count_and_file_list_modes() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-grep-modes");
    let ctx = context(&sandbox);

    let count = execute(
        "Grep",
        &json!({ "pattern": "alpha", "output_mode": "count" }),
        &ctx,
    );
    assert!(text(&count).contains("a.ts:1"), "got {}", text(&count));
    assert!(
        text(&count).contains("Found 2 total occurrences across 2 files."),
        "got {}",
        text(&count)
    );

    let files = execute(
        "Grep",
        &json!({ "pattern": "alpha", "output_mode": "files_with_matches" }),
        &ctx,
    );
    let listed = text(&files);
    assert!(listed.contains("a.ts") && listed.contains("notes.md"), "got {listed}");
    assert!(!listed.contains("beta"), "只应列出文件名: {listed}");
}

#[test]
fn grep_honours_case_insensitive_glob_and_limits() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-grep-flags");
    let ctx = context(&sandbox);

    let insensitive = execute("Grep", &json!({ "pattern": "ALPHA", "-i": true }), &ctx);
    assert!(!insensitive.is_error());
    assert!(text(&insensitive).contains("a.ts"), "got {}", text(&insensitive));

    let sensitive = execute("Grep", &json!({ "pattern": "ALPHA" }), &ctx);
    assert_eq!(text(&sensitive), "No files found");

    let scoped = execute("Grep", &json!({ "pattern": "alpha", "glob": "*.md" }), &ctx);
    let scoped_text = text(&scoped);
    assert!(scoped_text.contains("notes.md"), "got {scoped_text}");
    assert!(!scoped_text.contains("a.ts"), "glob 未生效: {scoped_text}");

    // 截断时附分页说明（files 模式）
    let limited = execute("Grep", &json!({ "pattern": "alpha", "head_limit": 1 }), &ctx);
    assert!(
        text(&limited).contains("limit: 1, offset: 0"),
        "got {}",
        text(&limited)
    );
}

#[test]
fn grep_reports_no_matches_and_search_path() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-grep-path");
    let ctx = context(&sandbox);

    let none = execute("Grep", &json!({ "pattern": "definitely-absent-token" }), &ctx);
    assert_eq!(text(&none), "No files found");

    let scoped = execute(
        "Grep",
        &json!({ "pattern": "gamma", "path": "src/b.ts", "output_mode": "content" }),
        &ctx,
    );
    assert!(text(&scoped).contains("gamma"), "got {}", text(&scoped));
}

#[test]
fn glob_requires_a_pattern_and_lists_sorted_files() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-glob");
    let ctx = context(&sandbox);

    assert_eq!(text(&execute("Glob", &json!({}), &ctx)), "pattern is required and must be a string");
    // 空串与缺参同义
    assert_eq!(
        text(&execute("Glob", &json!({ "pattern": "" }), &ctx)),
        "pattern is required and must be a string"
    );

    let outcome = execute("Glob", &json!({ "pattern": "*.ts" }), &ctx);
    let output = text(&outcome);
    assert!(output.starts_with("Found 2 files"), "got {output}");
    assert!(output.contains("a.ts") && output.contains("b.ts"), "got {output}");
    assert!(!output.contains("notes.md"), "glob 未生效: {output}");

    let none = execute("Glob", &json!({ "pattern": "*.zzz" }), &ctx);
    assert_eq!(text(&none), "No files found");
}

#[test]
fn glob_truncates_long_result_sets() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = Sandbox::new("tools-glob-limit");
    sandbox.point_extension_at_repo();
    for index in 0..305 {
        sandbox.write_file(&format!("many/f{index:03}.txt"), "x");
    }
    let outcome = execute("Glob", &json!({ "pattern": "*.txt" }), &context(&sandbox));
    let output = text(&outcome);
    // 上限 100：只列前 100 个，并附截断提示
    assert!(output.starts_with("Found 100 files"), "got {}", &output[..40.min(output.len())]);
    assert!(
        output.ends_with("(Results are truncated. Consider using a more specific path or pattern.)"),
        "got {}",
        &output[output.len().saturating_sub(120)..]
    );
}

// ==================== TodoWrite ====================

#[test]
fn todo_write_renders_the_checklist() {
    let sandbox = Sandbox::new("tools-todo");
    let outcome = execute(
        "TodoWrite",
        &json!({ "todos": [
            { "content": "已完成", "activeForm": "完成中", "status": "completed" },
            { "content": "进行中", "activeForm": "进行中", "status": "in_progress" },
            { "content": "待办", "activeForm": "待办中", "status": "pending" },
            { "content": "未知状态", "activeForm": "处理中" }
        ] }),
        &context(&sandbox),
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert_eq!(
        text(&outcome),
        "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable\n\n\
         Current todo list: 4 items (1 completed, 1 in progress, 2 pending)\n\n\
         Tasks:\n\n1. [x] 已完成\n2. [~] 进行中\n3. [ ] 待办\n4. [ ] 未知状态"
    );
}

#[test]
fn todo_write_validates_items() {
    let sandbox = Sandbox::new("tools-todo-validate");
    let ctx = context(&sandbox);
    let empty_content = execute(
        "TodoWrite",
        &json!({ "todos": [{ "content": "", "activeForm": "x" }] }),
        &ctx,
    );
    assert!(empty_content.is_error());
    assert!(text(&empty_content).contains("Content cannot be empty"));

    let missing_active = execute(
        "TodoWrite",
        &json!({ "todos": [{ "content": "a" }] }),
        &ctx,
    );
    assert!(missing_active.is_error());
    assert!(text(&missing_active).contains("Active form cannot be empty"));
}

#[test]
fn todo_write_clears_on_empty_or_non_array_input() {
    let sandbox = Sandbox::new("tools-todo-clear");
    let ctx = context(&sandbox);
    let empty_header = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable";
    assert_eq!(
        text(&execute("TodoWrite", &json!({ "todos": [] }), &ctx)),
        format!("{empty_header}\n\nCurrent todo list: 0 items (0 completed, 0 in progress, 0 pending)")
    );
    assert_eq!(
        text(&execute("TodoWrite", &json!({}), &ctx)),
        format!("{empty_header}\n\nCurrent todo list: 0 items (0 completed, 0 in progress, 0 pending)")
    );
    let unparseable = execute("TodoWrite", &json!({ "todos": "nope" }), &ctx);
    assert!(unparseable.is_error());
    assert_eq!(
        text(&unparseable),
        "todos is required and must be an array, but received an unparseable string"
    );
}

#[test]
fn todo_write_clears_storage_when_all_completed() {
    let sandbox = Sandbox::new("tools-todo-alldone");
    let ctx = ToolContext {
        session_id: "session-alldone".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    };
    execute(
        "TodoWrite",
        &json!({ "todos": [{ "content": "a", "activeForm": "b", "status": "completed" }] }),
        &ctx,
    );
    let stored = TODOS.lock().unwrap();
    let table = stored.as_ref().expect("todo table");
    assert_eq!(table["session-alldone"], json!([]));
}

#[test]
fn todo_write_keeps_state_per_session() {
    let sandbox = Sandbox::new("tools-todo-session");
    let first = ToolContext {
        session_id: "session-a".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: None,
        background: None,
        subagent: None,
    };
    execute(
        "TodoWrite",
        &json!({ "todos": [{ "content": "a", "activeForm": "b", "status": "pending" }] }),
        &first,
    );
    let stored = TODOS.lock().unwrap();
    let table = stored.as_ref().expect("todo table");
    assert_eq!(table["session-a"][0]["content"], "a");
    assert!(table.get("session-b").is_none());
}

// ==================== AskUserQuestion ====================

/// 注入固定用户应答的 ToolContext
fn ask_context(sandbox: &Sandbox, response: Value) -> ToolContext {
    ToolContext {
        session_id: "s-ask".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: Some(std::sync::Arc::new(move |_options: &Value| {
            Some(response.clone())
        })),
        background: None,
        subagent: None,
    }
}

#[test]
fn ask_user_question_requires_a_non_empty_question() {
    assert_eq!(
        validate_input("AskUserQuestion", &json!({ "question": "" }), "."),
        Some("Question cannot be empty".to_string())
    );
    assert_eq!(
        validate_input("AskUserQuestion", &json!({ "question": "   " }), "."),
        Some("Question cannot be empty".to_string())
    );
    assert_eq!(
        validate_input("AskUserQuestion", &json!({ "question": "ok" }), "."),
        None
    );
}

#[test]
fn ask_user_question_reports_an_error_without_a_callback() {
    let sandbox = Sandbox::new("tools-ask-nocb");
    let outcome = execute(
        "AskUserQuestion",
        &json!({ "question": "hi" }),
        &context(&sandbox),
    );
    assert!(outcome.is_error());
    assert_eq!(text(&outcome), "Failed to request user choice");
}

#[test]
fn ask_user_question_returns_the_selected_choice_label() {
    let sandbox = Sandbox::new("tools-ask-choice");
    let ctx = ask_context(&sandbox, json!({ "index": 1, "reply": "" }));
    let outcome = execute(
        "AskUserQuestion",
        &json!({ "question": "继续吗？", "choices": [{ "label": "是" }, { "label": "否" }] }),
        &ctx,
    );
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert_eq!(text(&outcome), "User response: 否 (selected option index: 1)");
}

#[test]
fn ask_user_question_prefers_the_free_text_reply() {
    let sandbox = Sandbox::new("tools-ask-free");
    let ctx = ask_context(&sandbox, json!({ "index": 0, "reply": "  自定义  " }));
    let outcome = execute(
        "AskUserQuestion",
        &json!({ "question": "q", "choices": [{ "label": "A" }, { "label": "B" }] }),
        &ctx,
    );
    assert_eq!(
        text(&outcome),
        "User response: 自定义 (selected option index: 0)"
    );
}

#[test]
fn ask_user_question_open_question_keeps_free_text_without_index() {
    let sandbox = Sandbox::new("tools-ask-open");
    let ctx = ask_context(&sandbox, json!({ "index": -1, "reply": "hello" }));
    let outcome = execute("AskUserQuestion", &json!({ "question": "q" }), &ctx);
    assert_eq!(text(&outcome), "User response: hello");
}

#[test]
fn ask_user_question_out_of_range_index_falls_back_to_empty_reply() {
    let sandbox = Sandbox::new("tools-ask-range");
    let ctx = ask_context(&sandbox, json!({ "index": 5, "reply": "" }));
    let outcome = execute(
        "AskUserQuestion",
        &json!({ "question": "q", "choices": [{ "label": "A" }, { "label": "B" }] }),
        &ctx,
    );
    assert_eq!(text(&outcome), "User response: ");
}

#[test]
fn ask_user_question_sends_tool_name_message_and_choices() {
    let sandbox = Sandbox::new("tools-ask-options");
    let captured: std::sync::Arc<std::sync::Mutex<Option<Value>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let sink = std::sync::Arc::clone(&captured);
    let ctx = ToolContext {
        session_id: "s-ask-options".to_string(),
        tool_use_id: None,
        pause: None,
        cwd: sandbox.workspace.to_string_lossy().to_string(),
        on_progress: None,
        cancel: None,
        user_choice: Some(std::sync::Arc::new(move |options: &Value| {
            *sink.lock().unwrap() = Some(options.clone());
            Some(json!({ "index": 0, "reply": "" }))
        })),
        background: None,
        subagent: None,
    };
    execute(
        "AskUserQuestion",
        &json!({
            "question": "选哪个？",
            "choices": [{ "label": "A", "description": "第一" }, { "label": "B" }]
        }),
        &ctx,
    );
    let options = captured.lock().unwrap().clone().expect("captured options");
    assert_eq!(options["toolName"], "AskUserQuestion");
    assert_eq!(options["message"], "选哪个？");
    assert_eq!(
        options["choices"],
        json!([{ "label": "A", "description": "第一" }, { "label": "B" }])
    );
}

// ==================== ripgrep 产物解析 ====================

#[test]
fn ripgrep_path_falls_back_to_path_lookup() {
    let _sandbox = Sandbox::new("tools-rg-fallback");
    // 沙箱的扩展目录里没有 rg 产物 → 回退到 PATH 里的 `rg`
    assert_eq!(ripgrep_path(), "rg");
}

#[test]
fn ripgrep_path_prefers_the_bundled_binary() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = Sandbox::new("tools-rg-bundled");
    sandbox.point_extension_at_repo();
    let resolved = ripgrep_path();
    assert!(
        resolved.ends_with("rg.exe") || resolved.ends_with("rg"),
        "got {resolved}"
    );
    assert_ne!(resolved, "rg");
}

/// ripgrep 的候选顺序：Core 自己槽位里的自带位（可执行文件同目录的 `ripgrep/`，
/// 本地打包布局）与部署布局的共享位（槽位上一级产品目录的 `ripgrep/`）优先，
/// 宿主 `extensionPath` 只作本机开发期兜底（`docs/core/standalone-core.md` 第 4 节）。
///
/// 用纯函数锁顺序：`ripgrep_path()` 的定位基准是进程自己的可执行文件目录，
/// 用例进程在 `core-rs/target/...`，没法在它旁边放产物。
#[test]
fn ripgrep_candidates_prefer_the_core_bundle() {
    let exe = if cfg!(windows) { "rg.exe" } else { "rg" };
    let core_dir = Path::new("/deploy/share/some-product/9d7e480b");
    let candidates = ripgrep_candidates(Some(core_dir), Some("/host/root"));
    assert_eq!(candidates.len(), 4, "got {candidates:?}");
    // 1. 自带位：可执行文件同目录下的 `ripgrep/rg[.exe]`（本地打包布局，
    //    打包后 asarUnpack 解包出来的就是这一层）
    assert!(candidates[0].starts_with(core_dir), "got {:?}", candidates[0]);
    assert!(candidates[0].ends_with(Path::new("ripgrep").join(exe)));
    // 2. 部署布局的共享位：槽位上一级产品目录里的 `ripgrep/rg[.exe]`
    assert!(candidates[1].starts_with(Path::new("/deploy/share/some-product")), "got {:?}", candidates[1]);
    assert!(candidates[1].ends_with(Path::new("ripgrep").join(exe)));
    // 3/4. 宿主 extensionPath：`dist/resources` 优先，其次仓库里的 `resources`
    assert!(candidates[2].starts_with(Path::new("/host/root")), "got {:?}", candidates[2]);
    assert!(candidates[2].ends_with(Path::new("ripgrep").join(platform_dir()).join(exe)));
    assert!(candidates[3].starts_with(Path::new("/host/root")), "got {:?}", candidates[3]);
    assert!(candidates[3].ends_with(Path::new("ripgrep").join(platform_dir()).join(exe)));
    // 宿主环境未下发（独立运行的 Core）时只剩可执行文件相对的两条
    assert_eq!(ripgrep_candidates(Some(core_dir), None).len(), 2);
    // 两个来源都没有时回退 PATH 里的 `rg`（`ripgrep_path` 的返回值）
    assert!(ripgrep_candidates(None, None).is_empty());
}

#[test]
fn ripgrep_exit_code_one_means_no_matches() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = grep_sandbox("tools-rg-no-match");
    let mut args = vec!["definitely-absent-token".to_string()];
    args.push(sandbox.workspace.to_string_lossy().to_string());
    let outcome = run_ripgrep(&args);
    assert_eq!(outcome.unwrap(), "");
}

#[test]
fn ripgrep_reports_failures() {
    // 不传 cwd：继承进程工作目录，非法参数照样报错
    let outcome = run_ripgrep(&["--definitely-not-a-flag".to_string()]);
    assert!(outcome.is_err(), "非法参数应当报错");
}

#[test]
fn ripgrep_lines_matches_stdout_trim_and_split() {
    // `stdout.trim().split('\n').filter((line) => line.length > 0)`：
    // 1. 整个 stdout 先做 JS 口径 trim（最后一行的尾随空格 / CRLF 会去掉）；
    // 2. 按 `\n` 切分，**中间行**的 `\r`（CRLF 文件里的匹配行）原样保留；
    // 3. 过滤空行。
    // 注：rg content 输出会原样带出匹配行的尾随空格（真实二进制验证过）。
    assert_eq!(
        ripgrep_lines("a.txt:1:alpha   \n"),
        vec!["a.txt:1:alpha".to_string()]
    );
    assert_eq!(
        ripgrep_lines("a.txt:1:alpha\r\nb.txt:2:beta\n"),
        vec!["a.txt:1:alpha\r".to_string(), "b.txt:2:beta".to_string()]
    );
    assert_eq!(ripgrep_lines(""), Vec::<String>::new());
    assert_eq!(ripgrep_lines("\n\n"), Vec::<String>::new());
    // JS 空白口径：U+FEFF 算空白（会被 trim），U+0085 不算
    assert_eq!(
        ripgrep_lines("\u{FEFF}a.txt:1:x\u{FEFF}"),
        vec!["a.txt:1:x".to_string()]
    );
    assert_eq!(
        ripgrep_lines("a.txt:1:x\u{0085}"),
        vec!["a.txt:1:x\u{0085}".to_string()]
    );
}

// ==================== 工具定义对照表 ====================

mod schema_parity_tests {
    use super::*;
    use std::collections::HashSet;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// TS 侧测试断言「本表 == `toolToLlmFormat` 的真实输出」；
    /// 这里断言「Rust 的 `definitions()` == 本表」，只有 `divergences` 列出的
    /// 已知缺口（尚未迁入的参数、TS zod 转换的既有偏差）豁免。
    const FIXTURE: &str = include_str!("../fixtures/toolSchema.json");

    /// 已知缺口集合：`"<Tool>.<property>"`。缺口项不参与类型 / 必填比对，
    /// 且允许 Rust 侧缺失（未迁入的参数）。
    fn divergence_keys(fixture: &Value) -> HashSet<String> {
        fixture
            .get("divergences")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|item| {
                        let tool = item.get("tool")?.as_str()?;
                        let property = item.get("property")?.as_str()?;
                        Some(format!("{tool}.{property}"))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn strings(value: Option<&Value>) -> Vec<String> {
        value
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn matches_the_shared_tool_schema_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let gaps = divergence_keys(&fixture);
        let definitions = definitions();
        let cases = fixture
            .get("tools")
            .and_then(Value::as_array)
            .expect("对照表缺少 tools");
        assert!(!cases.is_empty(), "对照表不能为空");
        assert_eq!(
            definitions.len(),
            cases.len(),
            "工具数量不一致：Rust {} / 对照表 {}",
            definitions.len(),
            cases.len()
        );

        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("");
            let Some(definition) = definitions
                .iter()
                .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
            else {
                failures.push(format!("{name}: Rust 侧缺少该工具"));
                continue;
            };
            if definition.get("description") != case.get("description") {
                failures.push(format!("{name}: description 不一致"));
            }

            let schema = definition.get("input_schema").expect("input_schema");
            let expected_required: Vec<String> = strings(case.get("required"))
                .into_iter()
                .filter(|key| !gaps.contains(&format!("{name}.{key}")))
                .collect();
            let actual_required = strings(schema.get("required"));
            if actual_required != expected_required {
                failures.push(format!(
                    "{name}: required 不一致 expected={expected_required:?} actual={actual_required:?}"
                ));
            }

            let expected_properties = case
                .get("properties")
                .and_then(Value::as_object)
                .expect("properties");
            let actual_properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .expect("properties");

            for (key, expected) in expected_properties {
                let gap = gaps.contains(&format!("{name}.{key}"));
                match actual_properties.get(key) {
                    None => {
                        if !gap {
                            failures.push(format!("{name}.{key}: Rust 侧缺少该参数"));
                        }
                    }
                    Some(actual) => {
                        if gap {
                            continue;
                        }
                        if actual.get("type") != expected.get("type") {
                            failures.push(format!(
                                "{name}.{key}: type 不一致 expected={} actual={}",
                                expected.get("type").unwrap_or(&Value::Null),
                                actual.get("type").unwrap_or(&Value::Null)
                            ));
                        }
                        if actual.get("description") != expected.get("description") {
                            failures.push(format!("{name}.{key}: description 不一致"));
                        }
                        if let Some(enum_values) = expected.get("enum") {
                            if actual.get("enum") != Some(enum_values) {
                                failures.push(format!("{name}.{key}: enum 不一致"));
                            }
                        }
                    }
                }
            }
            for key in actual_properties.keys() {
                if !expected_properties.contains_key(key) {
                    failures.push(format!("{name}.{key}: Rust 侧多出该参数"));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "工具定义与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

// ==================== Edit 结果对照表 ====================

mod edit_result_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// TS 侧测试断言「本表 == `EditTool` 的真实输出（`mapToolResultToToolResultBlockParam`）」；
    /// 这里断言「Rust 的 `run_edit` == 本表」。重点是 `(+N, -M)` 必须按 diff 口径计算
    /// （diff 最短编辑脚本口径），而不是「old/new 行数 × 替换次数」。
    const FIXTURE: &str = include_str!("../fixtures/editResult.json");

    #[test]
    fn matches_the_shared_edit_result_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");

        let sandbox = Sandbox::new("tools-edit-parity");
        let ctx = context(&sandbox);
        let mut failures: Vec<String> = Vec::new();

        let workspace = sandbox.workspace.to_string_lossy().to_string();
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let content = case.get("content").and_then(Value::as_str).unwrap_or("");
            let relative = case.get("file").and_then(Value::as_str).unwrap_or("a.txt");
            let missing = case.get("missing").and_then(Value::as_bool).unwrap_or(false);
            if !missing {
                sandbox.write_file(relative, content);
            }
            let mut input = case.get("args").cloned().unwrap_or(json!({}));
            input["file_path"] = json!(relative);
            let outcome = execute("Edit", &input, &ctx);
            // 对照表用 `__CWD__` 占位；错误文案里的绝对路径与分隔符统一归一化
            let actual = text(&outcome)
                .replace(&workspace, "__CWD__")
                .replace('\\', "/");
            let expected = case
                .get("expected")
                .and_then(Value::as_str)
                .or_else(|| case.get("error").and_then(Value::as_str))
                .unwrap_or("<missing expectation>");
            if actual != expected {
                failures.push(format!(
                    "{name}: 输出与对照表不一致\n  期望: {expected:?}\n  实际: {actual:?}"
                ));
                continue;
            }
            // startLine / endLine 也要一致（UI 跳转用）
            if let Some(expected_start) = case.get("expectedStartLine").and_then(Value::as_u64) {
                let extra = outcome.extra();
                let actual_start = extra
                    .as_ref()
                    .and_then(|map| map.get("startLine"))
                    .and_then(Value::as_u64);
                let actual_end = extra
                    .as_ref()
                    .and_then(|map| map.get("endLine"))
                    .and_then(Value::as_u64);
                let expected_end = case.get("expectedEndLine").and_then(Value::as_u64);
                if actual_start != Some(expected_start) || actual_end != expected_end {
                    failures.push(format!(
                        "{name}: startLine/endLine 不一致（期望 {expected_start:?}-{expected_end:?}，实际 {actual_start:?}-{actual_end:?}）"
                    ));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "Edit 结果与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

// ==================== 工具结果对照表 ====================

mod tool_result_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// 断言「Rust 的
    /// `tools::execute` == 本表」。覆盖入参边界（空串视为缺参、Read 的 `path` 回退）、
    /// Read 的窗口 / 行数 / 字节 / 大小上限，与关键成功路径的 tool_result 文本。
    const FIXTURE: &str = include_str!("../fixtures/toolResult.json");

    /// `files` 的值可以是字符串，也可以是 `{ repeat, count, eol, trailingEol }` 生成器
    /// （与 `scripts/gen-tool-result-parity.mjs` 的 `fileContent` 同一规则）：
    /// 大文件不必写进对照表。
    fn fixture_file_content(value: &Value) -> String {
        if let Some(text) = value.as_str() {
            return text.to_string();
        }
        let repeat = value.get("repeat").and_then(Value::as_str).unwrap_or("");
        let count = value.get("count").and_then(Value::as_u64).unwrap_or(0);
        let eol = value.get("eol").and_then(Value::as_str).unwrap_or("\n");
        let trailing_eol = value
            .get("trailingEol")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let mut out = String::new();
        for index in 0..count {
            out.push_str(repeat);
            if index + 1 < count || trailing_eol {
                out.push_str(eol);
            }
        }
        out
    }

    #[test]
    fn matches_the_shared_tool_result_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");

        let has_ripgrep = ripgrep_available();
        let mut failures: Vec<String> = Vec::new();
        let mut skipped = 0usize;

        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let tool = case.get("tool").and_then(Value::as_str).unwrap_or("");
            if !has_ripgrep && (tool == "Grep" || tool == "Glob") {
                skipped += 1;
                continue;
            }

            // 每个用例一个干净的沙箱：写入的临时文件不跨用例污染。
            let sandbox = Sandbox::new("tools-result-parity");
            sandbox.point_extension_at_repo();
            if let Some(files) = case.get("files").and_then(Value::as_object) {
                for (relative, content) in files {
                    sandbox.write_file(relative, &fixture_file_content(content));
                }
            }
            // 二进制夹具（xlsx 等）：按仓库相对路径拷进沙箱
            if let Some(binaries) = case.get("binaryFiles").and_then(Value::as_object) {
                for (relative, source) in binaries {
                    let source = source.as_str().unwrap_or_default();
                    let target = sandbox.workspace.join(relative);
                    if let Some(parent) = target.parent() {
                        std::fs::create_dir_all(parent).expect("create binary parent");
                    }
                    std::fs::copy(repo_root().join(source), &target).expect("copy binary fixture");
                }
            }
            let input = case.get("input").cloned().unwrap_or(json!({}));
            let outcome = execute(tool, &input, &context(&sandbox));
            let actual = text(&outcome).to_string();
            let expected = case
                .get("expected")
                .and_then(Value::as_str)
                .or_else(|| case.get("expectedError").and_then(Value::as_str))
                .unwrap_or("<missing expectation>");
            if actual != expected {
                failures.push(format!(
                    "{name}: 输出与对照表不一致\n  期望: {expected:?}\n  实际: {actual:?}"
                ));
            }
        }

        if skipped > 0 {
            eprintln!("skip {skipped} 条 Grep / Glob 用例（缺少 ripgrep 产物）");
        }
        assert!(
            failures.is_empty(),
            "工具结果与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

/// 起一个「稍后置位」的取消标记（模拟 `abortRequested`）
fn cancel_after(millis: u64) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let setter = std::sync::Arc::clone(&flag);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(millis));
        setter.store(true, Ordering::Relaxed);
    });
    flag
}

#[test]
fn bash_interrupted_with_no_output_keeps_the_empty_marker() {
    // 先把空输出变成 `(无输出)`，随后再追加 `\nCommand was interrupted`。
    // 真正的「被中断」只有会话中止这一条路（前台超时会转后台，不再杀进程）。
    let sandbox = Sandbox::new("tools-bash-abort-empty");
    let mut ctx = context(&sandbox);
    ctx.cancel = Some(cancel_after(200));
    let outcome = execute("Bash", &json!({ "command": "sleep 5" }), &ctx);
    assert_eq!(text(&outcome), "(无输出)\nCommand was interrupted");
    // 会话中止：退出码 130
    assert_eq!(outcome.exit_code(), 130);
}

#[test]
fn bash_interrupted_with_output_appends_the_marker() {
    let sandbox = Sandbox::new("tools-bash-abort-output");
    let mut ctx = context(&sandbox);
    // 1.2s 而不是 200ms：取消死线必须留给 Git Bash 启动 + `echo` 落盘的余量
    // （满载的测试进程里几百毫秒不够，断言会退化成对机器速度的断言）。
    ctx.cancel = Some(cancel_after(1200));
    let outcome = execute("Bash", &json!({ "command": "echo partial; sleep 5" }), &ctx);
    assert_eq!(text(&outcome), "partial\nCommand was interrupted");
    assert_eq!(outcome.exit_code(), 130);
}

#[test]
fn auto_background_failure_falls_back_to_exit_code_124() {
    // 打开输出文件失败时杀掉子进程、按「超时失败」收尾：
    // `{stdout}\n{stderr}`，退出码 124。
    let sandbox = Sandbox::new("tools-bash-auto-background-failure");
    // 把 TMPDIR 指向一个普通文件：`<TMPDIR>/<tmpTaskDirName>` 无法创建
    let blocker = sandbox.root.join("not-a-dir");
    std::fs::write(&blocker, b"x").unwrap();
    let previous = std::env::var("TMPDIR").ok();
    std::env::set_var("TMPDIR", &blocker);

    let outcome = execute(
        "Bash",
        // 超时死线给 shell 启动留余量（同 `bash_timeout_applies_after_the_shell_...`）
        &json!({ "command": "echo partial; sleep 5", "timeout": 1500 }),
        &context(&sandbox),
    );
    let body = text(&outcome);
    assert_eq!(outcome.exit_code(), 124, "got {body}");
    assert!(body.starts_with("partial\n"), "got {body}");
    assert!(
        body.contains("Command timed out after") && body.contains("failed to open output file"),
        "got {body}"
    );
    restore_tmpdir(previous);
}

// ==================== Read 二进制判定对照表 ====================

mod binary_detection_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// TS 侧测试断言「本表 == `isbinaryfile` 的真实结果」；这里断言
    /// 「Rust 的 `is_binary_content` == 本表」。
    const FIXTURE: &str = include_str!("../fixtures/binaryDetection.json");

    #[test]
    fn matches_the_shared_binary_detection_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");
        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let hex = case.get("hex").and_then(Value::as_str).unwrap_or("");
            let expected = case.get("expected").and_then(Value::as_bool).unwrap_or(false);
            let bytes = decode_hex(hex);
            let actual = is_binary_content(&bytes);
            if actual != expected {
                failures.push(format!(
                    "{name}: 期望 binary={expected}，实际 binary={actual}（{} 字节）",
                    bytes.len()
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "二进制判定与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

// ==================== Read 图片合法性校验对照表 ====================

mod image_validation_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// TS 侧测试断言「本表 == `validateImageBytes` 的真实结果」；这里断言
    /// 「Rust 的 `image_validation_failure` == 本表」。
    const FIXTURE: &str = include_str!("../fixtures/imageValidation.json");

    #[test]
    fn matches_the_shared_image_validation_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");
        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let media_type = case.get("mediaType").and_then(Value::as_str).unwrap_or("");
            let hex = case.get("hex").and_then(Value::as_str).unwrap_or("");
            // expected 为 null 表示通过
            let expected = case.get("expected").and_then(Value::as_str);
            let bytes = decode_hex(hex);
            let actual = image_validation_failure(&bytes, media_type);
            if actual != expected {
                failures.push(format!(
                    "{name}: 期望 {expected:?}，实际 {actual:?}（{} 字节）",
                    bytes.len()
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "图片合法性校验与对照表不一致：\n{}",
            failures.join("\n")
        );
    }
}

mod png_text_chunk_strip_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// TS 侧测试断言「本表 == `stripPngTextChunks` 的真实结果」；这里断言
    /// 「Rust 的 `strip_png_text_chunks` == 本表」。
    const FIXTURE: &str = include_str!("../fixtures/pngTextChunkStrip.json");

    #[test]
    fn matches_the_shared_png_text_chunk_strip_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");
        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("<unnamed>");
            let hex = case.get("hex").and_then(Value::as_str).unwrap_or("");
            let expected = decode_hex(case.get("expectedHex").and_then(Value::as_str).unwrap_or(""));
            match strip_png_text_chunks(&decode_hex(hex)) {
                Ok(payload) if payload == expected => {}
                Ok(payload) => failures.push(format!(
                    "{name}: 剥离结果不符（{} 字节，期望 {} 字节）",
                    payload.len(),
                    expected.len()
                )),
                Err(reason) => failures.push(format!("{name}: 剥离失败（{reason}）")),
            }
        }
        assert!(
            failures.is_empty(),
            "PNG 文本块剥离与对照表不一致：\n{}",
            failures.join("\n")
        );
    }

    #[test]
    fn read_strips_png_text_chunks_from_the_image_block() {
        // 工具端到端：Read 发出的 image block 载荷是剥离后的字节，磁盘文件不动
        let sandbox = Sandbox::new("tools-read-png-text-chunk");
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let case = fixture["cases"]
            .as_array()
            .and_then(|cases| cases.iter().find(|case| case["name"] == "png-text-chunk"))
            .expect("对照表缺少 png-text-chunk");
        let input = decode_hex(case["hex"].as_str().expect("hex"));
        let expected = decode_hex(case["expectedHex"].as_str().expect("expectedHex"));
        assert_ne!(input, expected, "用例本身应含可剥离的文本块");

        std::fs::write(sandbox.workspace.join("shot.png"), &input).unwrap();
        let outcome = execute("Read", &json!({ "file_path": "shot.png" }), &context(&sandbox));
        assert_eq!(
            outcome.blocks(),
            Some(&json!([{
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64_encode(&expected),
                },
            }]))
        );
        // 磁盘文件不被改写
        assert_eq!(std::fs::read(sandbox.workspace.join("shot.png")).unwrap(), input);
    }

    #[test]
    fn read_keeps_non_png_payloads_untouched() {
        // 非 PNG 图片（JPEG / GIF / WebP / BMP）的载荷逐字节原样：样本取自
        // `imageValidation.json`（valid 用例），与校验测试同一份字节来源。
        const IMAGE_FIXTURE: &str = include_str!("../fixtures/imageValidation.json");
        let sandbox = Sandbox::new("tools-read-non-png-payload");
        let fixture: Value = serde_json::from_str(IMAGE_FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        for (name, file_name, media_type) in [
            ("jpeg-valid", "photo.jpg", "image/jpeg"),
            ("gif-valid", "anim.gif", "image/gif"),
            ("webp-valid", "shot.webp", "image/webp"),
            ("bmp-valid", "old.bmp", "image/bmp"),
        ] {
            let case = cases
                .iter()
                .find(|case| case["name"] == name)
                .expect("对照表缺少样本");
            let bytes = decode_hex(case["hex"].as_str().expect("hex"));
            std::fs::write(sandbox.workspace.join(file_name), &bytes).unwrap();
            let outcome = execute("Read", &json!({ "file_path": file_name }), &context(&sandbox));
            assert_eq!(
                outcome.blocks(),
                Some(&json!([{
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64_encode(&bytes),
                    },
                }])),
                "{name} 的载荷被改写"
            );
        }
    }
}

#[test]
fn read_treats_text_content_with_an_image_extension_as_text() {
    // 图片分支在 `isbinaryfile` 之内——扩展名像图片但内容是文本时按文本读。
    let sandbox = Sandbox::new("tools-read-image-ext-text");
    sandbox.write_file("notes.png", "just text\nsecond line\n");
    let outcome = execute("Read", &json!({ "file_path": "notes.png" }), &context(&sandbox));
    assert!(!outcome.is_error(), "got {}", text(&outcome));
    assert!(outcome.blocks().is_none(), "不应返回 image block");
    assert_eq!(text(&outcome), "1|just text\n2|second line\n3|");
}

#[test]
fn read_reports_binary_files_that_are_not_images() {
    let sandbox = Sandbox::new("tools-read-binary");
    let bytes: Vec<u8> = vec![0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09];
    std::fs::write(sandbox.workspace.join("blob.bin"), &bytes).unwrap();
    let outcome = execute("Read", &json!({ "file_path": "blob.bin" }), &context(&sandbox));
    assert_eq!(
        text(&outcome),
        "Cannot read binary file: blob.bin. This tool only supports text and common image files."
    );
}

#[test]
fn read_keeps_the_image_size_guard_inside_the_binary_branch() {
    // 图片大小上限（15MB）只在内容确实是二进制时生效；文本内容不触发该上限。
    let sandbox = Sandbox::new("tools-read-image-size");
    let mut bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    bytes.resize((READ_MAX_IMAGE_BYTES + 1) as usize, 0x01);
    std::fs::write(sandbox.workspace.join("huge.png"), &bytes).unwrap();
    let outcome = execute("Read", &json!({ "file_path": "huge.png" }), &context(&sandbox));
    assert!(
        text(&outcome).starts_with("Image file too large to read: huge.png"),
        "got {}",
        text(&outcome)
    );
}

// ==================== JS 口径对等（toFixed / UTF-16） ====================

#[test]
fn format_file_size_matches_javascript_to_fixed() {
    // JS `(1280/1024).toFixed(1) === "1.3"`；Rust 的 `{:.1}` 会给 "1.2"（四舍六入五成双）。
    assert_eq!(format_file_size(1280), "1.3 KB");
    assert_eq!(format_file_size(2304), "2.3 KB");
    assert_eq!(format_file_size(3328), "3.3 KB");
    assert_eq!(format_file_size(262400), "256.3 KB");
    // 非平局值保持四舍五入
    assert_eq!(format_file_size(1536), "1.5 KB");
    assert_eq!(format_file_size(1024), "1.0 KB");
    assert_eq!(format_file_size(1023), "1023 B");
    assert_eq!(format_file_size(1024 * 1024), "1.0 MB");
    assert_eq!(format_file_size(1024 * 1024 + 256 * 1024), "1.3 MB");
}

#[test]
fn validate_input_rejects_empty_and_overlong_bash_commands() {
    // Bash 入参校验文案
    assert_eq!(
        validate_input("Bash", &json!({ "command": "" }), ".").as_deref(),
        Some("Command cannot be empty")
    );
    assert_eq!(
        validate_input("Bash", &json!({ "command": "   " }), ".").as_deref(),
        Some("Command cannot be empty")
    );
    assert_eq!(
        validate_input("Bash", &json!({ "command": "a".repeat(10_001) }), ".").as_deref(),
        Some("Command is too long (max 10000 characters)")
    );
    // 10000 是允许的上界
    assert!(validate_input("Bash", &json!({ "command": "a".repeat(10_000) }), ".").is_none());
    assert!(validate_input("Bash", &json!({ "command": "echo hi" }), ".").is_none());
    // 缺 command 不在这里判（交给权限层的 deny）
    assert!(validate_input("Bash", &json!({}), ".").is_none());
    // 其它工具没有 validateInput
    assert!(validate_input("Read", &json!({}), ".").is_none());
}

#[test]
fn clamp_output_counts_utf16_code_units() {
    // 每个 emoji 是 2 个 UTF-16 code unit（JS `.length` 口径）。
    let emoji = "😀".repeat(10); // 10 字符 / 20 code unit
    let clamped = util::clamp_output(&emoji, 4, 4);
    // 头部 4 code unit = 2 个 emoji，尾部同样；省略 20 - 8 = 12
    assert_eq!(clamped, "😀😀\n... (12 chars omitted) ...\n😀😀");
}

#[test]
fn cap_tool_result_uses_utf16_length_threshold() {
    let sandbox = Sandbox::new("tools-cap-utf16");
    let project = sandbox.workspace.to_string_lossy().to_string();
    // 2000 个 emoji = 4000 code unit ≤ 4096 → 原样返回
    let short = "😀".repeat(2000);
    assert_eq!(cap_tool_result(&short, "s1", &project, "Bash"), short);
    // 2100 个 emoji = 4200 code unit > 4096 → 落盘并返回预览消息
    let long = "😀".repeat(2100);
    let capped = cap_tool_result(&long, "s1", &project, "Bash");
    assert!(capped.starts_with("<persisted-output>"), "got {}", &capped[..40.min(capped.len())]);
    assert!(capped.contains("chars omitted"));
}

// ==================== 入参 schema 校验对等（Zod safeParse） ====================

/// 两侧共用 `core-rs/fixtures/toolInputValidation.json`：
/// TS 侧 `toolInputValidationParity.test.ts` 用真实 Zod schema 产出对照表，
/// 这里用 `tool_input::parse_input` 断言结果（错误文案 + 规范化数据）逐条一致。
#[test]
fn tool_input_validation_parity_tests() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/toolInputValidation.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()));
    let fixture: Value = serde_json::from_str(&raw).expect("对照表不是合法 JSON");
    let cases = fixture["cases"].as_array().expect("cases 不是数组");
    assert!(!cases.is_empty(), "对照表为空");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("");
        let tool = case["tool"].as_str().unwrap_or("");
        let input = &case["input"];
        let result = crate::tool_input::parse_input(tool, input);
        match case["error"].as_str() {
            Some(expected) => {
                let actual = result.err().unwrap_or_else(|| {
                    panic!("{name}（{tool}）：期望校验失败，实际通过")
                });
                assert_eq!(
                    actual, expected,
                    "{name}（{tool}）：错误文案不一致\n实际:\n{actual}\n期望:\n{expected}"
                );
            }
            None => {
                let actual = result.unwrap_or_else(|err| {
                    panic!("{name}（{tool}）：期望校验通过，实际失败:\n{err}")
                });
                assert_eq!(
                    &actual, &case["parsed"],
                    "{name}（{tool}）：规范化数据不一致"
                );
            }
        }
    }
}

// ==================== JS 语义对照表 ====================

mod js_parity_tests {
    use super::*;

    /// 行为对照表数据在 `core-rs/fixtures/js.json`：
    /// 这里断言「Rust 的 `format_file_size` / `clamp_output` / `validate_input`
    /// == 本表」。任一侧偏离都会失败。
    const FIXTURE: &str = include_str!("../fixtures/js.json");

    #[test]
    fn matches_the_shared_js_semantics_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");

        // ---- formatFileSize：`toFixed(1)` 的四舍五入口径 ----
        let file_sizes = fixture["fileSizes"].as_array().expect("缺少 fileSizes");
        assert!(!file_sizes.is_empty(), "fileSizes 不能为空");
        for case in file_sizes {
            let bytes = case["bytes"].as_u64().expect("bytes 必须是整数");
            let expected = case["expected"].as_str().expect("expected 必须是字符串");
            assert_eq!(
                format_file_size(bytes),
                expected,
                "formatFileSize({bytes}) 与对照表不一致"
            );
        }

        // ---- generateHeadTailPreview / capResultContent：UTF-16 code unit 口径 ----
        let clamps = fixture["clamps"].as_array().expect("缺少 clamps");
        assert!(!clamps.is_empty(), "clamps 不能为空");
        for case in clamps {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let text = case["text"].as_str().expect("text 必须是字符串");
            let head = case["head"].as_u64().expect("head") as usize;
            let tail = case["tail"].as_u64().expect("tail") as usize;
            let expected = case["expected"].as_str().expect("expected 必须是字符串");
            let expected_has_more = case["hasMore"].as_bool().expect("hasMore 必须是布尔");
            assert_eq!(
                crate::util::clamp_output(text, head, tail),
                expected,
                "{name}：前 {head} + 后 {tail} 预览与对照表不一致"
            );
            assert_eq!(
                crate::util::utf16_len(text) > head + tail,
                expected_has_more,
                "{name}：hasMore 判定与对照表不一致"
            );
        }

        // ---- Bash validateInput：非空 + 长度上限 ----
        let bash_cases = fixture["bashValidation"].as_array().expect("缺少 bashValidation");
        assert!(!bash_cases.is_empty(), "bashValidation 不能为空");
        for case in bash_cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let command = case["command"].as_str().expect("command 必须是字符串");
            let expected = case["expected"].as_str().map(str::to_string);
            assert_eq!(
                validate_input("Bash", &json!({ "command": command }), "."),
                expected,
                "{name}：Bash validateInput 与对照表不一致"
            );
        }
    }
}


#[test]
fn bash_validate_input_uses_js_whitespace() {
    // U+0085 不是 JS 空白 → 命令合法；U+FEFF 是 JS 空白 → 空命令
    assert_eq!(validate_input("Bash", &json!({ "command": "\u{85}" }), "."), None);
    assert_eq!(
        validate_input("Bash", &json!({ "command": "\u{feff}" }), "."),
        Some("Command cannot be empty".to_string())
    );
}

/// ripgrep 失败时的文案按 Node `execFile` 错误口径：
/// `Command failed: <rg> <args...>\n<stderr>`（参数顺序、`--`/`--color` 都不能多）。
#[test]
fn grep_failure_matches_node_exec_file_message() {
    if !ripgrep_available() {
        return;
    }
    let sandbox = Sandbox::new("tools-grep-error-message");
    sandbox.point_extension_at_repo();
    let outcome = execute("Grep", &json!({ "pattern": "[" }), &context(&sandbox));
    let actual = text(&outcome);
    let search = sandbox.workspace.to_string_lossy().to_string();
    // 不绑定 rg 的绝对路径（`ripgrep_path()` 读全局宿主环境，测试并发下可能被改写），
    // 只锁 Node `execFile` 的格式、参数顺序与搜索根位置。
    assert!(actual.starts_with("Command failed: "), "got {actual}");
    assert!(
        actual.contains(&format!(
            " --hidden --glob !.git --glob !.svn --glob !.hg --glob !.bzr --glob !.jj --glob !.sl --max-columns 500 -l [ {search}\n"
        )),
        "got {actual}"
    );
    assert!(actual.contains("regex parse error"), "got {actual}");
}

/// 中止必须终止**整棵进程树**
/// （`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
///
/// Windows 上 `bash.exe` 可能是启动器：只 `child.kill()` 杀启动器，真正的 shell
/// 与命令继续跑，`sleep 3 && touch late.marker` 的标记文件在 abort 之后仍会出现。
#[test]
fn bash_abort_kills_the_whole_process_tree() {
    let sandbox = Sandbox::new("tools-bash-abort-kills-tree");
    let mut ctx = context(&sandbox);
    // 1.2s 而不是 200ms：取消死线必须留给 Git Bash 启动的余量
    // （同 bash_interrupted_with_output_appends_the_marker）。
    ctx.cancel = Some(cancel_after(1200));
    let outcome = execute("Bash", &json!({ "command": "sleep 3 && touch late.marker" }), &ctx);
    assert!(
        text(&outcome).contains("Command was interrupted"),
        "got {}",
        text(&outcome)
    );
    // 等过命令的自然结束点：中止后命令不得继续执行
    std::thread::sleep(std::time::Duration::from_millis(2500));
    assert!(
        !sandbox.workspace.join("late.marker").exists(),
        "中止后命令仍在继续执行（孙进程未被终止）"
    );
}

/// 中止之后不得再上报该工具的进度
/// （`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
///
/// 工具结果已按「被中断」定稿，迟到的 `toolProgress` 会让 UI 把已结束的卡片
/// 刷成命令的真实输出。
#[test]
fn bash_abort_stops_reporting_progress_after_the_result() {
    let sandbox = Sandbox::new("tools-bash-abort-late-progress");
    let mut ctx = context(&sandbox);
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink = std::sync::Arc::clone(&seen);
    ctx.on_progress = Some(std::sync::Arc::new(move |progress: BashProgress| {
        sink.lock().unwrap().push(progress.full_output);
    }));
    ctx.cancel = Some(cancel_after(1200));
    let outcome = execute("Bash", &json!({ "command": "sleep 3 && echo done" }), &ctx);
    assert!(
        text(&outcome).contains("Command was interrupted"),
        "got {}",
        text(&outcome)
    );
    let before = seen.lock().unwrap().len();
    std::thread::sleep(std::time::Duration::from_millis(2500));
    // 先克隆再断言：assert_eq! 的临时 guard 存活到整条语句结束，
    // 消息里再 lock 同一把锁会自死锁。
    let after = seen.lock().unwrap().clone();
    assert_eq!(after.len(), before, "工具结果之后仍上报了进度：{after:?}");
}

/// 后台任务中止同样终止整棵进程树
/// （`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
///
/// 与前台中止共用 `bash_task::kill_tree`（顺序为先 `taskkill` 后 `child.kill()`）：
/// 护栏用例，锁住「中止后台任务不留孤儿命令」这一既有行为。
#[test]
fn background_task_abort_kills_the_whole_process_tree() {
    let sandbox = Sandbox::new("tools-bash-bg-abort-kills-tree");
    let ctx = context(&sandbox);
    let outcome = execute(
        "Bash",
        &json!({
            "command": "sleep 3 && touch late.marker",
            "run_in_background": true,
            "description": "bg tree kill",
        }),
        &ctx,
    );
    assert!(
        text(&outcome).contains("background with ID:"),
        "后台任务应立刻返回 taskId，got {}",
        text(&outcome)
    );
    assert_eq!(crate::bash_task::abort_tasks_for_session("s-tools"), 1);
    // 等过命令的自然结束点：中止后命令不得继续执行
    std::thread::sleep(std::time::Duration::from_millis(3500));
    assert!(
        !sandbox.workspace.join("late.marker").exists(),
        "后台任务中止后命令仍在继续执行（孙进程未被终止）"
    );
}

// ==================== 子代理角色注册表（specs/020） ====================

/// 合法角色单一落点：Master 无白名单（不限工具，与主对话同款），Explorer 白名单
/// 恰为四件套（Reply 是生命周期设施，见 `sub_agent_role_tools` 的文档注释）。
#[test]
fn sub_agent_role_registry_lists_roles_and_allowlists() {
    assert_eq!(SUB_AGENT_ROLES, &["Master", "Explorer"]);
    assert_eq!(sub_agent_role_tools("Master"), None);
    assert_eq!(
        sub_agent_role_tools("Explorer"),
        Some(["Read", "Glob", "Grep", "Reply"].as_slice())
    );
    // 未知角色没有白名单；角色名精确匹配，大小写变体不合法
    assert_eq!(sub_agent_role_tools("explorer"), None);
    assert_eq!(sub_agent_role_tools(""), None);
}

/// Agent 工具的执行侧校验走注册表：Explorer 合法（继续走到运行时检查），
/// 非法角色（含大小写变体）报注册表全量名单。
#[test]
fn agent_tool_validates_role_against_registry() {
    let sandbox = Sandbox::new("tools-agent-role-registry");
    let ctx = context(&sandbox);
    let outcome = execute("Agent", &json!({ "prompt": "x", "agentRole": "Dev" }), &ctx);
    assert!(
        text(&outcome).contains("must be one of: Master, Explorer"),
        "got {}",
        text(&outcome)
    );
    let outcome = execute("Agent", &json!({ "prompt": "x", "agentRole": "explorer" }), &ctx);
    assert!(
        text(&outcome).contains("must be one of: Master, Explorer"),
        "got {}",
        text(&outcome)
    );
    // Explorer 合法：本测试的 ctx 没挂 subagent 钩子，应走到「无运行时」而非角色报错
    let outcome = execute("Agent", &json!({ "prompt": "x", "agentRole": "Explorer" }), &ctx);
    assert_eq!(text(&outcome), "Agent: no sub-agent runtime available");
}

/// 非法 agentRole 的入参校验文案：多值枚举分支（specs/020 FR-001，与
/// fixtures/toolInputValidation.json 的 Agent 枚举用例同口径）。
#[test]
fn agent_role_input_validation_reports_multi_value_enum() {
    let err = crate::tool_input::parse_input(
        "Agent",
        &json!({ "prompt": "x", "agentRole": "Dev" }),
    )
    .expect_err("非法角色应当校验失败");
    // 错误文案是 issue 数组的 JSON（内嵌引号带转义），按结构比对
    let issues: Value = serde_json::from_str(&err).expect("错误应当是 issue 数组 JSON");
    assert_eq!(
        issues,
        json!([{
            "code": "invalid_value",
            "values": ["Master", "Explorer"],
            "path": ["agentRole"],
            "message": "Invalid option: expected one of \"Master\"|\"Explorer\"",
        }])
    );
    // Explorer 合法且规范化通过
    let parsed = crate::tool_input::parse_input(
        "Agent",
        &json!({ "prompt": "x", "agentRole": "Explorer" }),
    )
    .expect("explorer 应当合法");
    assert_eq!(parsed["agentRole"], "Explorer");
}

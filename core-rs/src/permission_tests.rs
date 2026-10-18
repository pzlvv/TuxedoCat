//! `permission` 的单元测试。

use super::*;
use serde_json::json;

fn bash(command: &str) -> Value {
    json!({ "command": command })
}

/// 权限决策不依赖真实磁盘的用例统一用这个 cwd（`Edit` 的文件存在性检查会读盘）
const CWD: &str = "";

#[test]
fn separators_respect_quotes() {
    assert_eq!(split_by_separators("echo a; echo b").len(), 2);
    assert_eq!(split_by_separators("echo 'a;b'").len(), 1);
    assert_eq!(split_by_separators("echo \"a|b\"").len(), 1);
    assert_eq!(split_by_separators("echo $(a;b)").len(), 1);
    assert_eq!(split_by_separators("ls && pwd").len(), 2);
}

/// **换行不是分隔符**。
///
/// 这条断言是刻意的：`echo a\nrm -rf x` 只有一段（首词 `echo`），
/// risk / manual 模式都会放行。两套实现必须给出同一个决策，因此 Rust 侧不能
/// 额外把换行当分隔符（否则同一个会话换 Core 实现就会弹出确认框）。
#[test]
fn separators_do_not_split_on_newline() {
    assert_eq!(split_by_separators("echo a\nrm -rf build").len(), 1);
    assert!(is_read_only_command("echo a\nrm -rf build"));
    assert_eq!(
        decide("Bash", &bash("echo a\nrm -rf build"), "manual", CWD),
        Decision::Allow
    );
}

#[test]
fn read_only_detection() {
    assert!(is_read_only_command("ls -la"));
    assert!(is_read_only_command("git status --short"));
    assert!(is_read_only_command("echo a && pwd"));
    assert!(!is_read_only_command("rm -rf build"));
    assert!(!is_read_only_command("git commit -m x"));
    assert!(!is_read_only_command("ls && rm -rf build"));
}

#[test]
fn destructive_detection() {
    assert!(is_destructive_command("dd if=/dev/zero of=x"));
    assert!(is_destructive_command("mkfs /dev/sda1"));
    assert!(is_destructive_command("shred -u secret.txt"));
    // 只看第一个词，`mkfs.ext4` 不匹配 `mkfs`
    assert!(!is_destructive_command("mkfs.ext4 /dev/sda1"));
    assert!(!is_destructive_command("rm -rf build"));
}

#[test]
fn risk_mode_allows_safe_commands() {
    // 关键回归：sleep 这类普通命令在 risk 模式下不应弹确认框
    assert_eq!(decide("Bash", &bash("sleep 1"), "risk", CWD), Decision::Allow);
    assert_eq!(decide("Bash", &bash("rm -rf build"), "risk", CWD), Decision::Allow);
    assert_eq!(decide("Bash", &bash("ls -la"), "risk", CWD), Decision::Allow);
}

#[test]
fn risk_mode_intercepts_dangerous_commands() {
    assert_eq!(decide("Bash", &bash("dd if=/dev/zero of=x"), "risk", CWD), Decision::Ask);
    assert_eq!(decide("Bash", &bash("mkfs /dev/sda1"), "risk", CWD), Decision::Ask);
    assert_eq!(decide("Bash", &bash("shred -u secret.txt"), "risk", CWD), Decision::Ask);
    // 破坏性判定只看第一个词：`mkfs.ext4` 不匹配 `mkfs`，risk 放行
    assert_eq!(decide("Bash", &bash("mkfs.ext4 /dev/sda1"), "risk", CWD), Decision::Allow);
}

/// git 写子命令不在危险名单里：risk 模式与 `rm` 同口径自动放行，
/// 只有 manual 模式才逐条询问。
#[test]
fn risk_mode_allows_git_write_subcommands() {
    for command in [
        "git reset --hard HEAD",
        "git checkout main",
        "git push --force",
        "git clean -fd",
        "bash -c 'git reset --hard HEAD'",
        "cd repo&&git checkout main",
        "x=git reset",
    ] {
        assert_eq!(
            decide("Bash", &bash(command), "risk", CWD),
            Decision::Allow,
            "risk 不应拦截：{command}"
        );
        assert_eq!(
            decide("Bash", &bash(command), "manual", CWD),
            Decision::Ask,
            "manual 仍应询问：{command}"
        );
    }
}

#[test]
fn auto_mode_allows_asks_but_not_denies() {
    assert_eq!(decide("Bash", &bash("dd if=/dev/zero of=x"), "auto", CWD), Decision::Allow);
    assert_eq!(
        decide("Bash", &bash(""), "auto", CWD),
        Decision::Deny("Invalid command: command is required and must be a string".to_string())
    );
    assert_eq!(
        decide("Write", &json!({}), "auto", CWD),
        Decision::Deny("Invalid file path: file_path is required and must be a string".to_string())
    );
}

/// 对齐 `PermissionPolicy.ts` 的 auto 分支：auto 模式下 AskUserQuestion 直接 deny
/// （不弹提问框，message 逐字锁定）；manual 保持工具自身的 allow
/// （提问本身在 `call()` 里弹框），risk 不受影响（非 Bash，不参与风险拦截）。
#[test]
fn ask_user_question_denied_in_auto_mode() {
    let args = json!({ "question": "hi", "choices": [{ "label": "A" }, { "label": "B" }] });

    // manual：工具自身 checkPermissions 放行，行为不变
    assert_eq!(decide("AskUserQuestion", &args, "manual", CWD), Decision::Allow);
    // risk：不受影响
    assert_eq!(decide("AskUserQuestion", &args, "risk", CWD), Decision::Allow);
    // auto：deny，message 逐字锁定
    assert_eq!(
        decide("AskUserQuestion", &args, "auto", CWD),
        Decision::Deny(ASK_USER_QUESTION_AUTO_DENY_MESSAGE.to_string())
    );

    // `resolve_tool_permission`（引擎实际路径）下发的形状一致：
    // permResult 只有 behavior + message，displayArgs 原样透传入参
    let (perm_result, display_args) =
        resolve_tool_permission("AskUserQuestion", &args, "auto", CWD, "session-1");
    assert_eq!(
        perm_result,
        json!({ "behavior": "deny", "message": ASK_USER_QUESTION_AUTO_DENY_MESSAGE })
    );
    assert_eq!(display_args, args);
}

#[test]
fn manual_mode_asks_for_writes() {
    assert_eq!(decide("Bash", &bash("sleep 1"), "manual", CWD), Decision::Ask);
    assert_eq!(decide("Bash", &bash("ls -la"), "manual", CWD), Decision::Allow);
    assert_eq!(decide("Read", &json!({}), "manual", CWD), Decision::Allow);
    assert_eq!(
        decide(
            "Write",
            &json!({ "file_path": "out.txt", "content": "x" }),
            "manual",
            CWD
        ),
        Decision::Ask
    );
}

/// 非法入参直接 deny（auto / risk 不加工）。
#[test]
fn write_input_validation_denies() {
    let invalid_path = Decision::Deny(
        "Invalid file path: file_path is required and must be a string".to_string(),
    );
    assert_eq!(decide("Write", &json!({}), "auto", CWD), invalid_path);
    assert_eq!(decide("Write", &json!({ "file_path": "" }), "auto", CWD), invalid_path);
    assert_eq!(
        decide("Write", &json!({ "file_path": "out.txt" }), "auto", CWD),
        Decision::Deny("Invalid content: content is required".to_string())
    );
    assert_eq!(
        decide(
            "Write",
            &json!({ "file_path": "out.txt", "content": Value::Null }),
            "auto",
            CWD
        ),
        Decision::Deny("Invalid content: content is required".to_string())
    );
    // 空串 content 合法（写入空文件）
    assert_eq!(
        decide(
            "Write",
            &json!({ "file_path": "out.txt", "content": "" }),
            "auto",
            CWD
        ),
        Decision::Allow
    );
}

/// 非法入参 / 目标文件缺失都 deny。
#[test]
fn edit_input_validation_denies() {
    assert_eq!(
        decide("Edit", &json!({}), "auto", CWD),
        Decision::Deny("Invalid file path: file_path is required and must be a string".to_string())
    );
    assert_eq!(
        decide("Edit", &json!({ "file_path": "x.txt" }), "auto", CWD),
        Decision::Deny("Invalid old_string: old_string is required".to_string())
    );
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "x.txt", "old_string": "a" }),
            "auto",
            CWD
        ),
        Decision::Deny("Invalid new_string: new_string is required".to_string())
    );
    // 目标文件不存在：deny（提示改用 Write），auto 不加工
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "missing-file.txt", "old_string": "a", "new_string": "b" }),
            "auto",
            CWD
        ),
        Decision::Deny(
            "File does not exist: missing-file.txt. Use Write tool to create new files.".to_string()
        )
    );
}

/// 目标文件存在时 `Edit` 回到 ask（auto 模式下被放行为 allow）。
#[test]
fn edit_existing_file_is_ask() {
    let dir = std::env::temp_dir().join(format!("permission-edit-{}", crate::util::random_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("target.txt");
    std::fs::write(&file, "hello world\n").unwrap();
    let cwd = dir.to_string_lossy().to_string();

    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "hello", "new_string": "hi" }),
            "manual",
            &cwd
        ),
        Decision::Ask
    );
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "hello", "new_string": "hi" }),
            "auto",
            &cwd
        ),
        Decision::Allow
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// 读文件后先跑 `computeEdit` 的匹配校验，
/// `old_string` 找不到 / 多处匹配且未 `replace_all` 时**直接 deny**——不弹确认框，
/// 因此 `auto` / `risk` 也不会把它放行（旧实现会先 ask 再在执行阶段报错）。
#[test]
fn edit_match_failures_are_denied_before_asking() {
    let dir = std::env::temp_dir().join(format!("permission-edit-{}", crate::util::random_suffix()));
    std::fs::create_dir_all(&dir).unwrap();
    let cwd = dir.to_string_lossy().to_string();

    std::fs::write(dir.join("target.txt"), "a\nb\n").unwrap();
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "zzz", "new_string": "y" }),
            "auto",
            &cwd
        ),
        Decision::Deny(
            "The specified old_string was not found in the file. Please read the file first and use the exact text.\nNote: Read output uses | as separator between line number and content. Make sure NOT to include the line number and the separator | in old_string.".to_string()
        )
    );

    std::fs::write(dir.join("target.txt"), "x\nx\n").unwrap();
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "x", "new_string": "y" }),
            "manual",
            &cwd
        ),
        Decision::Deny(
            "The old_string matches 2 locations within the search range. When replace_all is false, old_string must match exactly once. Please include more surrounding context to make old_string unique, or set replace_all to true.".to_string()
        )
    );
    // replace_all=true 时多处匹配合法，回到 ask
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "x", "new_string": "y", "replace_all": true }),
            "manual",
            &cwd
        ),
        Decision::Ask
    );
    // 字符串 "false" 不得当成真值（与 `resolveReplaceAll` 一致）
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "x", "new_string": "y", "replace_all": "false" }),
            "manual",
            &cwd
        ),
        Decision::Deny(
            "The old_string matches 2 locations within the search range. When replace_all is false, old_string must match exactly once. Please include more surrounding context to make old_string unique, or set replace_all to true.".to_string()
        )
    );
    // offset/limit 限定窗口后找不到：文案带 within the specified line range
    std::fs::write(dir.join("target.txt"), "x\ny\n").unwrap();
    assert_eq!(
        decide(
            "Edit",
            &json!({ "file_path": "target.txt", "old_string": "x", "new_string": "y", "offset": 2, "limit": 1 }),
            "manual",
            &cwd
        ),
        Decision::Deny(
            "The specified old_string was not found within the specified line range. Please read the file first and use the exact text.\nNote: Read output uses | as separator between line number and content. Make sure NOT to include the line number and the separator | in old_string.".to_string()
        )
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    use serde_json::json;

    /// 行为对照表数据在 `core-rs/fixtures/permission.json`：
    /// 断言 `decide` 的输出与对照表逐项一致。
    const FIXTURE: &str = include_str!("../fixtures/permission.json");

    #[test]
    fn matches_permission_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");

        // 对照表里的相对路径一律按一个空目录解析，保证「文件不存在」分支可复现。
        // 带 `files` 的用例（Edit 的 old_string 匹配校验）先落盘再决策。
        let dir = std::env::temp_dir().join(format!("permission-parity-{}", crate::util::random_suffix()));
        std::fs::create_dir_all(&dir).expect("create parity dir");
        let cwd = dir.to_string_lossy().to_string();

        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let tool = case.get("tool").and_then(Value::as_str).unwrap_or("");
            let mode = case.get("mode").and_then(Value::as_str).unwrap_or("");
            let args = case.get("args").cloned().unwrap_or_else(|| json!({}));
            let expect = case.get("expect").and_then(Value::as_str).unwrap_or("");
            if let Some(files) = case.get("files").and_then(Value::as_object) {
                for (relative, content) in files {
                    let target = dir.join(relative);
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&target, content.as_str().unwrap_or(""));
                }
            }
            let actual = match decide(tool, &args, mode, &cwd) {
                Decision::Allow => "allow",
                Decision::Ask => "ask",
                Decision::Deny(_) => "deny",
            };
            if actual != expect {
                failures.push(format!("{tool} @{mode} {args} → {actual}（期望 {expect}）"));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            failures.is_empty(),
            "与对照表的权限决策不一致：\n{}",
            failures.join("\n")
        );
    }

    /// 随机对等对照表（`core-rs/fixtures/permissionFuzz.json`）：
    /// 固定种子生成的命令组合，两侧共用同一份期望值。
    const FUZZ_FIXTURE: &str = include_str!("../fixtures/permissionFuzz.json");

    #[test]
    fn matches_permission_fuzz_table() {
        let fixture: Value = serde_json::from_str(FUZZ_FIXTURE).expect("对照表必须是合法 JSON");
        let cases = fixture
            .get("cases")
            .and_then(Value::as_array)
            .expect("对照表缺少 cases");
        assert!(!cases.is_empty(), "对照表不能为空");

        let dir = std::env::temp_dir().join(format!("permission-fuzz-{}", crate::util::random_suffix()));
        std::fs::create_dir_all(&dir).expect("create fuzz dir");
        let cwd = dir.to_string_lossy().to_string();

        let mut failures: Vec<String> = Vec::new();
        for case in cases {
            let mode = case.get("mode").and_then(Value::as_str).unwrap_or("");
            let args = case.get("args").cloned().unwrap_or_else(|| json!({}));
            let expect = case.get("expect").and_then(Value::as_str).unwrap_or("");
            let actual = match decide("Bash", &args, mode, &cwd) {
                Decision::Allow => "allow",
                Decision::Ask => "ask",
                Decision::Deny(_) => "deny",
            };
            if actual != expect {
                failures.push(format!("Bash @{mode} {args} → {actual}（期望 {expect}）"));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            failures.is_empty(),
            "与对照表的随机权限决策不一致：\n{}",
            failures.join("\n")
        );
    }
}


/// 权限加工对照表（`core-rs/fixtures/permissionPolicy.json`）：
/// 与 TS 侧 `permissionPolicyParity.test.ts` 共用同一份期望值，逐字段比对
/// `permResult` 与 `displayArgs`（路径用 `__CWD__` 占位）。
///
/// `displayArgs.diffHunks` 两侧比较前统一剔除：Standalone 不预计算该键，
/// webview 会用同一份 beforeContent / afterContent 调 `buildEditDiffHunks`
/// 得到一致渲染。
#[test]
fn permission_policy_matches_the_fixture() {
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/permissionPolicy.json");
    let raw = std::fs::read_to_string(&fixture_path).expect("读取对照表失败");
    let fixture: Value = serde_json::from_str(&raw).expect("对照表必须是合法 JSON");
    let cases = fixture
        .get("cases")
        .and_then(Value::as_array)
        .expect("对照表缺少 cases");
    assert!(!cases.is_empty(), "对照表不能为空");

    // 与 TS 侧 `permissionPolicyParity.test.ts` 的 `SESSION` 常量一致
    const SESSION: &str = "permission-policy-parity";

    let dir = std::env::temp_dir().join(format!(
        "permission-policy-parity-{}",
        crate::util::random_suffix()
    ));
    std::fs::create_dir_all(&dir).expect("create parity dir");
    let cwd = dir.to_string_lossy().to_string();

    let mut failures: Vec<String> = Vec::new();
    for case in cases {
        // 每个用例前清空目录，避免上一条的文件残留
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        if let Some(files) = case.get("files").and_then(Value::as_object) {
            for (relative, content) in files {
                let target = dir.join(relative);
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&target, content.as_str().unwrap_or(""));
            }
        }

        let tool = case.get("tool").and_then(Value::as_str).unwrap_or("");
        let mode = case.get("mode").and_then(Value::as_str).unwrap_or("");
        let args = case.get("args").cloned().unwrap_or_else(|| json!({}));
        let no_tool = case
            .get("noTool")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (perm_result, mut display_args) = if no_tool {
            (
                json!({ "behavior": "allow" }),
                display_args_for_unknown(tool, &args, &cwd),
            )
        } else {
            let session_id = case
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(SESSION);
            resolve_tool_permission(tool, &args, mode, &cwd, session_id)
        };
        // Edit 的 displayArgs 不预计算 diffHunks，
        // 改为额外下发 beforeContent / afterContent（webview 用同一份
        // buildEditDiffHunks 回退计算，渲染一致）。比较前剔除这三处形状差异，
        // 单独断言 Standalone 的额外字段与 permResult 一致。
        if let Some(map) = display_args.as_object_mut() {
            map.remove("diffHunks");
        }
        if tool == "Edit" {
            if let Some(map) = display_args.as_object_mut() {
                let before = map.remove("beforeContent");
                let after = map.remove("afterContent");
                if let Some(expected_before) = perm_result.get("beforeContent") {
                    let expect = if expected_before.as_str() == Some("") {
                        Value::Null
                    } else {
                        expected_before.clone()
                    };
                    assert_eq!(
                        before.unwrap_or(Value::Null),
                        expect,
                        "{}: Edit displayArgs.beforeContent 应与 permResult.beforeContent 一致",
                        case.get("name").and_then(Value::as_str).unwrap_or("")
                    );
                    assert_eq!(
                        after.unwrap_or(Value::Null),
                        perm_result.get("afterContent").cloned().unwrap_or(Value::Null),
                        "{}: Edit displayArgs.afterContent 应与 permResult.afterContent 一致",
                        case.get("name").and_then(Value::as_str).unwrap_or("")
                    );
                } else {
                    assert!(
                        before.is_none() && after.is_none(),
                        "{}: 无 diff 的 Edit 不应带 beforeContent / afterContent",
                        case.get("name").and_then(Value::as_str).unwrap_or("")
                    );
                }
            }
        }
        let expect_perm = substitute_cwd(
            case.get("expectPermResult").cloned().unwrap_or(Value::Null),
            &cwd,
        );
        let mut expect_display = substitute_cwd(
            case.get("expectDisplayArgs")
                .cloned()
                .unwrap_or(Value::Null),
            &cwd,
        );
        if let Some(map) = expect_display.as_object_mut() {
            map.remove("diffHunks");
        }
        if perm_result != expect_perm || display_args != expect_display {
            failures.push(format!(
                "{}\n  permResult 实际: {perm_result}\n  permResult 期望: {expect_perm}\n  displayArgs 实际: {display_args}\n  displayArgs 期望: {expect_display}",
                case.get("name").and_then(Value::as_str).unwrap_or("")
            ));
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        failures.is_empty(),
        "与对照表不一致：\n\n{}",
        failures.join("\n\n")
    );
}

/// 把对照表里的 `__CWD__` 占位替换为当前测试的会话工作目录
fn substitute_cwd(value: Value, cwd: &str) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("__CWD__", cwd)),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| substitute_cwd(item, cwd))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, substitute_cwd(item, cwd)))
                .collect(),
        ),
        other => other,
    }
}


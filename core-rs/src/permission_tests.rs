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
    // 关键回归：普通命令在 risk 模式下不应弹确认框（`sleep` 已被 restricted 闸门拦下，
    // 见 `restricted_sleep_gate_denies_in_every_agent_mode`，这里用等价的普通命令）
    assert_eq!(
        decide("Bash", &bash("npm test"), "risk", CWD),
        Decision::Allow
    );
    assert_eq!(
        decide("Bash", &bash("rm -rf build"), "risk", CWD),
        Decision::Allow
    );
    assert_eq!(
        decide("Bash", &bash("ls -la"), "risk", CWD),
        Decision::Allow
    );
}

/// `restricted` 闸门的 sleep 分支（`docs/features/background-bash.md` 第 2 节 FR-005）：
/// 三档工作模式给同一个 deny 与同一段文案——闸门不是权限分级，不能因为
/// auto / risk 把 ask 放行就漏过去。
#[test]
fn restricted_sleep_gate_denies_in_every_agent_mode() {
    for command in [
        "sleep 30 && cat a.txt",
        // 单条 sleep 同样命中（闸门收紧后的口径）
        "sleep 30",
        "echo anything; sleep 10",
    ] {
        let args = bash(command);
        for mode in ["manual", "risk", "auto"] {
            assert_eq!(
                decide("Bash", &args, mode, CWD),
                Decision::Deny(crate::tools::BASH_RESTRICTED_SLEEP_MESSAGE.to_string()),
                "command={command} mode={mode}"
            );
        }
        // 闸门不是 ask：ask 会在 auto 模式被放行，也不会给用户弹框
        assert!(
            !matches!(decide("Bash", &args, "manual", CWD), Decision::Ask),
            "{command}"
        );
    }
}

/// 失败文案以「误拦截逃生口」收尾（FR-007）：模型能照着把同一个命令带
/// `restricted: false` 重跑，而不需要去猜这一句的措辞。
#[test]
fn restricted_messages_name_the_escape_hatch() {
    let message = crate::tools::BASH_RESTRICTED_SLEEP_MESSAGE;
    assert!(
        message.ends_with(
            "- If you are certain this is a false positive, re-run the same command with restricted: false."
        ),
        "got {message}"
    );
    assert!(
        message.contains("restricted: false"),
        "逃生口必须点名参数：{message}"
    );
}

/// sleep 判据不误伤「不是命令」的 sleep 字样（FR-002 边界）：引号内、heredoc 正文、
/// 绝对路径与包裹写法（已知边界）都不命中闸门。
#[test]
fn restricted_gate_ignores_quoted_comment_and_heredoc_sleep() {
    for command in [
        "echo 'sleep 10 && cat a.txt'",
        "cat > a.sh <<'EOF'\nsleep 5\nEOF",
        "echo done",
        "/usr/bin/sleep 10 && x",
        "timeout 30 sleep 5 && x",
    ] {
        assert!(
            !matches!(
                decide("Bash", &bash(command), "manual", CWD),
                Decision::Deny(_)
            ),
            "{command}"
        );
    }
}

/// `sed` 读 / 改文件的写法**不被闸门拒绝**（FR-009）：命令照常执行，引导改走 `Read` /
/// `Edit` 是工具结果里的提醒，不是权限判定。`sed` 不在只读白名单，因此按既有权限路径
/// 判定：`manual` 询问、`risk` / `auto` 放行（它不是破坏性命令，也不带 detach）。
#[test]
fn sed_read_commands_follow_the_existing_permission_path() {
    for command in [
        "sed -n '1,40p' f.txt",
        "cd src && sed -n 1p a.ts",
        "cd a; sed -n 1p f; cd b; sed -i 's/x/y/' f",
    ] {
        let args = bash(command);
        assert_eq!(
            decide("Bash", &args, "manual", CWD),
            Decision::Ask,
            "command={command}"
        );
        assert_eq!(
            decide("Bash", &args, "risk", CWD),
            Decision::Allow,
            "command={command}"
        );
        assert_eq!(
            decide("Bash", &args, "auto", CWD),
            Decision::Allow,
            "command={command}"
        );
    }
}

/// `restricted` 只关 sleep 一条限制（FR-005）：`sed` 在任何取值下都走既有权限路径，
/// 开不开 `restricted` 不改变它的判定。
#[test]
fn restricted_false_lifts_the_sleep_gate_only() {
    for command in ["sleep 30", "sleep 30 && cat a.txt"] {
        let args = json!({ "command": command, "restricted": false });
        assert_eq!(
            decide("Bash", &args, "manual", CWD),
            Decision::Ask,
            "{command}"
        );
        assert_eq!(
            decide("Bash", &args, "risk", CWD),
            Decision::Allow,
            "{command}"
        );
    }
    // sed：`restricted` 的真假给出同一结果
    for command in ["cd src && sed -n 1p a.ts"] {
        for restricted in [true, false] {
            let args = json!({ "command": command, "restricted": restricted });
            assert_eq!(
                decide("Bash", &args, "manual", CWD),
                Decision::Ask,
                "{command} restricted={restricted}"
            );
        }
    }
}

/// `restricted` 的 sleep 判据用 deny、不是 ask（FR-005 / AC-5）：ask 在 auto 模式会被
/// 放行、在 manual 下会先弹一次确认框，三档一致性就没了。
#[test]
fn restricted_gate_does_not_use_ask() {
    for command in ["sleep 30 && cat a.txt", "echo anything; sleep 10"] {
        for mode in ["manual", "risk", "auto"] {
            let decision = decide("Bash", &bash(command), mode, CWD);
            assert!(
                matches!(decision, Decision::Deny(_)),
                "command={command} mode={mode} 得到 {decision:?}，必须是 deny"
            );
        }
    }
}

/// `cat` 不是闸门判据（`docs/features/background-bash.md` 第 2 节 FR-005 / FR-008）：
/// 看文件内容改走 `Read` 是提示词规则，权限层照旧把 `cat` 只读放行；
/// `cat > f <<EOF` 这类写形态同样不被闸门拦。
#[test]
fn restricted_gate_does_not_cover_cat() {
    for command in [
        "cat a.txt",
        "cd src && cat a.ts",
        "cat > f.txt <<'EOF'\nhello\nEOF",
        "cat a.txt | head",
    ] {
        for mode in ["manual", "risk", "auto"] {
            let decision = decide("Bash", &bash(command), mode, CWD);
            assert!(
                !matches!(decision, Decision::Deny(_)),
                "command={command} mode={mode} 得到 {decision:?}，cat 不应被闸门拒绝"
            );
        }
    }
}

/// `restricted: false` 不豁免 detach 闸门（FR-004）：两个字段互不豁免，后台化构造仍由
/// `run_bash` 的 detach 闸门拦下，权限层这里只看 `is_detach_escape` 的危险分级照旧。
#[test]
fn restricted_false_keeps_detach_gate() {
    let args = json!({ "command": "nohup server", "restricted": false, "detach": true });
    assert!(is_operation_risky("Bash", &args));
    assert_eq!(decide("Bash", &args, "risk", CWD), Decision::Ask);
}

/// detach 不解除本闸门（FR-004）：`detach: true` 的豁免只覆盖后台化构造，
/// 用 sleep 等结果的命令仍是失败。
#[test]
fn restricted_gate_is_not_lifted_by_detach() {
    let args = json!({ "command": "sleep 10 && nohup x &", "detach": true });
    assert_eq!(
        decide("Bash", &args, "auto", CWD),
        Decision::Deny(crate::tools::BASH_RESTRICTED_SLEEP_MESSAGE.to_string())
    );
}

/// 含 `sed` 的写法命中 sleep 判据时只报 sleep 文案（FR-005）：`sed` 不再参与闸门，
/// 命令的主因是拿 `sleep` 等结果。
#[test]
fn restricted_sleep_gate_reports_sleep_message_for_mixed_commands() {
    assert_eq!(
        decide(
            "Bash",
            &bash("sleep 10; cd src && sed -n 1p a.ts"),
            "manual",
            CWD
        ),
        Decision::Deny(crate::tools::BASH_RESTRICTED_SLEEP_MESSAGE.to_string())
    );
}

/// 双闸门命中顺序（FR-005）：两条都命中时报 `restricted` 闸门的文案——该命令的主因
/// 是用 sleep 等结果，后台化构造只是附带写法。
#[test]
fn restricted_gate_wins_over_detach_gate() {
    assert_eq!(
        decide("Bash", &bash("sleep 10 && nohup x &"), "manual", CWD),
        Decision::Deny(crate::tools::BASH_RESTRICTED_SLEEP_MESSAGE.to_string())
    );
}

/// `restricted` 是可选工具入参、缺省 `true`（FR-001）：不传等于收紧，显式 `false` 才放过。
#[test]
fn restricted_defaults_to_true() {
    assert!(crate::tools::bash_restricted(
        &json!({ "command": "sleep 5" })
    ));
    assert!(crate::tools::bash_restricted(
        &json!({ "command": "sleep 5", "restricted": true })
    ));
    // 给定值走 JS 真值语义（与 detach / run_in_background 同一套）
    assert!(crate::tools::bash_restricted(
        &json!({ "command": "sleep 5", "restricted": "false" })
    ));
    assert!(!crate::tools::bash_restricted(
        &json!({ "command": "sleep 5", "restricted": false })
    ));
    assert!(!crate::tools::bash_restricted(
        &json!({ "command": "sleep 5", "restricted": 0 })
    ));
    assert!(!crate::tools::bash_restricted(
        &json!({ "command": "sleep 5", "restricted": null })
    ));
}

#[test]
fn risk_mode_intercepts_dangerous_commands() {
    assert_eq!(
        decide("Bash", &bash("dd if=/dev/zero of=x"), "risk", CWD),
        Decision::Ask
    );
    assert_eq!(
        decide("Bash", &bash("mkfs /dev/sda1"), "risk", CWD),
        Decision::Ask
    );
    assert_eq!(
        decide("Bash", &bash("shred -u secret.txt"), "risk", CWD),
        Decision::Ask
    );
    // 破坏性判定只看第一个词：`mkfs.ext4` 不匹配 `mkfs`，risk 放行
    assert_eq!(
        decide("Bash", &bash("mkfs.ext4 /dev/sda1"), "risk", CWD),
        Decision::Allow
    );
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
    assert_eq!(
        decide("Bash", &bash("dd if=/dev/zero of=x"), "auto", CWD),
        Decision::Allow
    );
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
    assert_eq!(
        decide("AskUserQuestion", &args, "manual", CWD),
        Decision::Allow
    );
    // risk：不受影响
    assert_eq!(
        decide("AskUserQuestion", &args, "risk", CWD),
        Decision::Allow
    );
    // auto：deny，message 逐字锁定
    assert_eq!(
        decide("AskUserQuestion", &args, "auto", CWD),
        Decision::Deny(ASK_USER_QUESTION_AUTO_DENY_MESSAGE.to_string())
    );

    // `resolve_tool_permission`（引擎实际路径）下发的形状一致：
    // permResult 只有 behavior + message，displayArgs 原样透传入参
    let (perm_result, display_args) = resolve_tool_permission(
        "AskUserQuestion",
        &args,
        "auto",
        CWD,
        "session-1",
        &crate::tools::WorkViewState::workspace(),
    );
    assert_eq!(
        perm_result,
        json!({ "behavior": "deny", "message": ASK_USER_QUESTION_AUTO_DENY_MESSAGE })
    );
    assert_eq!(display_args, args);
}

#[test]
fn manual_mode_asks_for_writes() {
    assert_eq!(
        decide("Bash", &bash("npm test"), "manual", CWD),
        Decision::Ask
    );
    assert_eq!(
        decide("Bash", &bash("ls -la"), "manual", CWD),
        Decision::Allow
    );
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
    let invalid_path =
        Decision::Deny("Invalid file path: file_path is required and must be a string".to_string());
    assert_eq!(decide("Write", &json!({}), "auto", CWD), invalid_path);
    assert_eq!(
        decide("Write", &json!({ "file_path": "" }), "auto", CWD),
        invalid_path
    );
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
            "File does not exist: missing-file.txt. Use Write tool to create new files."
                .to_string()
        )
    );
}

/// 目标文件存在时 `Edit` 回到 ask（auto 模式下被放行为 allow）。
#[test]
fn edit_existing_file_is_ask() {
    let dir =
        std::env::temp_dir().join(format!("permission-edit-{}", crate::util::random_suffix()));
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
    let dir =
        std::env::temp_dir().join(format!("permission-edit-{}", crate::util::random_suffix()));
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
        let dir = std::env::temp_dir().join(format!(
            "permission-parity-{}",
            crate::util::random_suffix()
        ));
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

        let dir =
            std::env::temp_dir().join(format!("permission-fuzz-{}", crate::util::random_suffix()));
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
    let fixture_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/permissionPolicy.json");
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
        let no_tool = case.get("noTool").and_then(Value::as_bool).unwrap_or(false);
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
            resolve_tool_permission(
                tool,
                &args,
                mode,
                &cwd,
                session_id,
                &crate::tools::WorkViewState::workspace(),
            )
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
                        perm_result
                            .get("afterContent")
                            .cloned()
                            .unwrap_or(Value::Null),
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
        // displayArgs 的 file_path 由宿主 fs 拼接（Windows 反斜杠 / posix 正斜杠），
        // 夹具与实际各自生成——比较前把两边的 file_path 分隔符归一到 '/'，其余字段
        // 原样（内容里的反斜杠有正当语义，不做全局替换）
        normalize_file_path(&mut display_args);
        normalize_file_path(&mut expect_display);
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

/// 把 displayArgs 里的 `file_path` 分隔符归一到 '/'（仅该字段；内容里的反斜杠有
/// 正当语义，不做全局替换——比较口径见 edit 用例处的注释）
fn normalize_file_path(value: &mut Value) {
    if let Some(map) = value.as_object_mut() {
        if let Some(Value::String(path)) = map.get_mut("file_path") {
            *path = path.replace('\\', "/");
        }
    }
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

// ==================== detach 逃生（specs/034-bash-detach-field） ====================

/// detach 逃生（FR-003 / AC-9 ～ AC-11）：manual / risk 询问，auto 放行（零可见是
/// 明示决策，与破坏性命令同待遇，见 ADR-0014）。
#[test]
fn detach_escape_asks_in_risk_and_manual_but_not_auto() {
    let escape = || json!({ "command": "nohup server", "detach": true });
    assert_eq!(decide("Bash", &escape(), "risk", CWD), Decision::Ask);
    assert_eq!(decide("Bash", &escape(), "manual", CWD), Decision::Ask);
    assert_eq!(decide("Bash", &escape(), "auto", CWD), Decision::Allow);
}

/// AC-12：`detach: true` 但命令没有后台化构造 → 字段惰性，不算危险。
#[test]
fn detach_true_without_construct_is_not_risky() {
    assert_eq!(
        decide(
            "Bash",
            &json!({ "command": "echo ok", "detach": true }),
            "risk",
            CWD
        ),
        Decision::Allow
    );
}

/// heredoc 体内的字面 `&` 不是后台化构造（缺陷
/// `bash-detach-gate-flags-heredoc-constructs`）：`detach: true` 时不按危险操作分级，
/// 走不到脱离管理确认分支。manual 下的 Ask 来自「写命令逐条询问」的既有口径，与此无关，
/// 因此这里断言危险谓词与确认文案，而不是 manual 的最终决策。
#[test]
fn detach_escape_ignores_heredoc_body_ampersand() {
    let args = json!({
        "command": "cat > a.c <<'EOF'\nint *p = &x;\nEOF",
        "detach": true,
    });
    assert!(
        !is_operation_risky("Bash", &args),
        "heredoc 正文的 & 不是逃生"
    );
    assert_eq!(decide("Bash", &args, "risk", CWD), Decision::Allow);
    assert!(!ask_message(
        "Bash",
        &args,
        CWD,
        &crate::tools::WorkViewState::workspace()
    )
    .starts_with("⚠️ 请求脱离管理执行："));
    // 对照：同样 `detach: true`，真构造仍在 risk 下询问
    let real = json!({ "command": "nohup server", "detach": true });
    assert!(is_operation_risky("Bash", &real));
    assert_eq!(decide("Bash", &real, "risk", CWD), Decision::Ask);
}

/// `detach` 缺省的命令不算危险操作：拦截面在工具闸门（第一轮失败教学），权限
/// 放行——risk 模式的完整体验是「教学 → 带 `detach: true` 重试 → 询问」。
#[test]
fn detach_default_command_is_not_permission_business() {
    assert_eq!(
        decide("Bash", &bash("nohup server"), "risk", CWD),
        Decision::Allow
    );
}

/// detach 逃生的确认文案与选项（FR-003）：⚠️ 专用文案写场景与代价，选项沿用
/// 危险分支的「允许执行 / 拒绝」；普通命令保持原文案与选项不变。
#[test]
fn detach_escape_ask_message_and_choices() {
    let args = json!({ "command": "nohup server", "detach": true });
    let files = crate::tools::WorkViewState::workspace();
    let message = ask_message("Bash", &args, CWD, &files);
    assert!(
        message.starts_with("⚠️ 请求脱离管理执行：nohup server\n"),
        "got {message}"
    );
    assert!(
        message.contains("无完成通知、中止会话不会杀掉它、会话结束后继续运行"),
        "got {message}"
    );
    let choices = ask_choices("Bash", &args, CWD, &files);
    assert_eq!(choices[0]["label"], "允许执行");

    let plain = ask_message("Bash", &bash("sleep 1"), CWD, &files);
    assert_eq!(plain, "请求执行：sleep 1");
}

/// 权限层不得自己读真实磁盘（specs/defects/overlay-edit-and-card-links-read-real-disk.md）。
///
/// Overlay 对话的改动只落该对话私有的叠加视图里，Core 不在挂载命名空间里——它自己
/// `std::fs` 看到的永远是真实磁盘。权限阶段（`base_check` / `write_target_exists`）此前
/// 用 `std::fs::read_to_string` 取「旧内容」、用 `Path::exists` 判「文件是否存在」，于是
/// 对话内新建的文件被判成不存在：`Edit` 在权限阶段就被 deny，提示改用 `Write`。
///
/// 目标文件的事实必须与工具 IO 走同一条通道（`ToolContext::read_bytes` / `stat_path`，
/// 隔离会话由常驻挂载代理代执行）。本用例锁源码面：`permission.rs` 里不允许出现
/// `std::fs::`——那是「权限层另读一份磁盘事实」的唯一入口。
#[test]
fn permission_layer_does_not_read_the_real_disk() {
    let source = include_str!("permission.rs");
    let offenders: Vec<&str> = source
        .lines()
        .filter(|line| line.contains("std::fs::"))
        .collect();
    assert!(
        offenders.is_empty(),
        "权限层不得直接读盘（Overlay 会话里那是真实磁盘，不是对话视图）：{offenders:?}"
    );
}

/// 权限层对文件的判定必须走 `WorkViewState`：视图不可用时报错，而不是退回磁盘。
///
/// 上半条锁源码面（没有 `std::fs::`），这一条锁行为面：`ViewUnavailable` 下 `Edit` 的
/// 文件判定不成立，必须按读失败拒绝；偷读真实磁盘上的同名文件会让它变成 ask / allow，
/// 那是 FR-010 明令禁止的 fail-open（`docs/core/conversation-work-view.md` 第 7 节）。
#[test]
fn permission_edit_fails_closed_when_view_is_unavailable() {
    let dir = std::env::temp_dir().join(format!(
        "permission-view-unavailable-{}",
        crate::util::random_suffix()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    // 真实磁盘上有这个文件：权限层若偷读磁盘，`Edit` 会照常进入 ask
    std::fs::write(dir.join("existing.txt"), "hello world\n").unwrap();
    let cwd = dir.to_string_lossy().to_string();
    let files = crate::tools::WorkViewState::ViewUnavailable("代理缺失".to_string());

    let (perm_result, _) = resolve_tool_permission(
        "Edit",
        &json!({
            "file_path": "existing.txt",
            "old_string": "hello",
            "new_string": "hi",
        }),
        "auto",
        &cwd,
        "session-view-unavailable",
        &files,
    );
    assert_eq!(
        perm_result["behavior"], "deny",
        "视图不可用时 Edit 必须 fail-closed（不读真实磁盘）：{perm_result}"
    );
    let message = perm_result["message"].as_str().unwrap_or("");
    assert!(
        message.contains("Overlay 视图不可用"),
        "拒绝原因要点名视图不可用，而不是「文件不存在」：{message}"
    );
}

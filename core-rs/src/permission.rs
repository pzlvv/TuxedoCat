//! 权限决策（对齐 `src/core/tools/PermissionPolicy.ts` 与
//! `src/core/tools/bash/Validation.ts`）。
//!
//! 三档询问模式：
//! - `manual`：工具自己的判定保持原样（读工具放行，写工具询问）；
//! - `risk`：只拦截危险操作，其余自动放行；
//! - `auto`：`ask` 一律放行。
//!
//! `ask` 不等于拒绝：它表示「需要弹确认框」，由引擎再发一次
//! `CoreRequest.userChoice` 拿用户的选择。

use serde_json::{json, Value};

use crate::util::{is_js_whitespace, js_trim};

/// 权限决策
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Ask,
    Deny(String),
}

/// 只读命令（不修改任何状态、不写盘、不发网络请求）
const READONLY_COMMANDS: &[&str] = &[
    // 文件查看
    "cat", "head", "tail", "wc", "stat", "file", "tree", "du", "ls", "find", "grep", "which",
    "whereis", "locate", "type", "command", "getconf",
    // 文本处理
    "sort", "uniq", "cut", "paste", "join", "tr", "column", "nl", "awk",
    // 输出
    "echo", "printf",
    // 路径工具
    "basename", "dirname", "realpath", "readlink",
    // 数据处理
    "jq", "yq",
    // 校验和
    "sha256sum", "sha1sum", "md5sum", "cksum", "sum",
    // 比较
    "diff", "cmp", "comm",
    // 压缩文件查看
    "zcat", "zgrep", "zless", "bzcat", "xzcat", "zipinfo",
    // 文本生成 / 格式化
    "seq", "shuf", "fold", "fmt", "expand", "unexpand",
    // 二进制查看
    "od", "xxd", "hexdump", "strings",
    // 目录导航
    "cd", "pwd",
    // 进程 / 系统状态
    "ps", "jobs", "uptime", "dmesg", "df", "free", "uname", "hostname", "id", "whoami",
    "printenv", "env", "alias", "last", "history", "date",
    // 设备调试
    "hdc",
    // 低风险写入
    "mkdir",
];

/// 只读多词命令（`git status` 这类需要看子命令）
const MULTI_WORD_READONLY_PAIRS: &[&str] = &[
    "git status",
    "git diff",
    "git log",
    "git show",
    "git branch",
    "git ls-remote",
    "git ls-files",
    "git ls-tree",
    "git rev-parse",
    "git rev-list",
    "git describe",
    "git for-each-ref",
    "git stash list",
    "git stash show",
    "git remote",
    "git config",
    "git submodule",
    "git grep",
    "git blame",
    "git shortlog",
    "git count-objects",
];

/// 破坏性命令（`cp` / `mv` 不算）
const DESTRUCTIVE_COMMANDS: &[&str] = &["dd", "mkfs", "format", "fdisk", "shred", "wipe"];

// ==================== 命令切分 ====================

/// 按 `;` `&&` `||` `|` 切分复合命令；引号内与 `$(...)` 内的分隔符不切。
///
/// 与 Embedded 的 `splitBySeparators`（`tools/bash/TimeoutPolicy.ts`）逐分支对齐：
/// **换行不是分隔符**（`echo a\nrm -rf x` 只有一段，判定只看首个词 `echo`）。
/// 这里刻意保留该行为，两套实现必须给出同一个权限决策。
pub fn split_by_separators(command: &str) -> Vec<String> {
    let bytes: Vec<char> = command.chars().collect();
    let n = bytes.len();
    let mut result: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut i = 0;

    fn push_current(result: &mut Vec<String>, current: &mut String) {
        // 对齐 Embedded `current.trim()`：JS `String.prototype.trim` 去的是
        // WhiteSpace + LineTerminator（含 U+FEFF、不含 U+0085），与 Rust
        // `str::trim`（Unicode White_Space，含 U+0085、不含 U+FEFF）不同。
        let trimmed = js_trim(current);
        if !trimmed.is_empty() {
            result.push(trimmed.to_string());
        }
        current.clear();
    }

    /// 从 `start`（`bytes[start]` 为开引号）扫描到闭合之后；未闭合返回 n
    fn scan_quoted(bytes: &[char], start: usize, open: char) -> usize {
        let n = bytes.len();
        if open == '\'' || open == '`' {
            return match bytes[start + 1..].iter().position(|ch| *ch == open) {
                Some(offset) => start + 1 + offset + 1,
                None => n,
            };
        }
        let mut j = start + 1;
        while j < n {
            if bytes[j] == '\\' {
                j += 2;
                continue;
            }
            if bytes[j] == '"' {
                return j + 1;
            }
            j += 1;
        }
        n
    }

    while i < n {
        let ch = bytes[i];
        if ch == '\'' || ch == '"' || ch == '`' {
            let end = scan_quoted(&bytes, i, ch);
            current.extend(&bytes[i..end]);
            i = end;
            continue;
        }
        if ch == '$' && i + 1 < n && bytes[i + 1] == '(' {
            let mut depth = 1;
            let mut j = i + 2;
            while j < n && depth > 0 {
                let inner = bytes[j];
                if inner == '\'' || inner == '"' || inner == '`' {
                    j = scan_quoted(&bytes, j, inner);
                    continue;
                }
                if inner == '(' {
                    depth += 1;
                } else if inner == ')' {
                    depth -= 1;
                }
                j += 1;
            }
            current.extend(&bytes[i..j.min(n)]);
            i = j;
            continue;
        }
        if ch == '\\' && i + 1 < n {
            current.push(ch);
            current.push(bytes[i + 1]);
            i += 2;
            continue;
        }
        if ch == ';' {
            push_current(&mut result, &mut current);
            i += 1;
            continue;
        }
        if ch == '&' && i + 1 < n && bytes[i + 1] == '&' {
            push_current(&mut result, &mut current);
            i += 2;
            continue;
        }
        if ch == '|' && i + 1 < n && bytes[i + 1] == '|' {
            push_current(&mut result, &mut current);
            i += 2;
            continue;
        }
        if ch == '|' {
            push_current(&mut result, &mut current);
            i += 1;
            continue;
        }
        current.push(ch);
        i += 1;
    }
    push_current(&mut result, &mut current);
    result
}

/// 按 JS 正则 `/\s+/` 分词：只在 ECMAScript 空白集合上切分，连续空白视为一个分隔符。
///
/// 不能用 Rust 的 `split_whitespace()`（Unicode White_Space）：它在 U+0085 上切分
/// 却不认 U+FEFF，而 JS `\s` 恰好相反。权限判定与 Embedded 共用同一套分词口径，
/// 否则 `git<U+0085>status` / `git<U+FEFF>status` 这类命令会得出不同决策。
fn js_split_whitespace(segment: &str) -> Vec<&str> {
    segment
        .split(is_js_whitespace)
        .filter(|part| !part.is_empty())
        .collect()
}

fn first_word(segment: &str) -> String {
    js_split_whitespace(segment)
        .first()
        .map(|part| part.to_string())
        .unwrap_or_default()
}

fn first_pair(segment: &str) -> String {
    let parts = js_split_whitespace(segment);
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_string(),
        _ => format!("{} {}", parts[0], parts[1]),
    }
}

/// 只读：所有子命令都是只读
pub fn is_read_only_command(command: &str) -> bool {
    let segments = split_by_separators(command);
    if segments.is_empty() {
        return false;
    }
    segments.iter().all(|segment| {
        let pair = first_pair(segment);
        if MULTI_WORD_READONLY_PAIRS.contains(&pair.as_str()) {
            return true;
        }
        let word = first_word(segment);
        READONLY_COMMANDS.contains(&word.as_str())
    })
}

/// 破坏性：只看第一个子命令
pub fn is_destructive_command(command: &str) -> bool {
    let segments = split_by_separators(command);
    let Some(first) = segments.first() else {
        return false;
    };
    DESTRUCTIVE_COMMANDS.contains(&first_word(first).as_str())
}

// ==================== 决策 ====================

// ==================== 决策 ====================

/// 工具自身 `checkPermissions` 的结果（对齐 Embedded 各工具返回的 `PermissionResult`）。
struct CheckResult {
    decision: Decision,
    /// `ask` / `deny` 的提示文案（`allow` 时为空串）
    message: String,
    /// `ask` 的选项（`allow` / `deny` 为 null）
    choices: Value,
    /// Edit / Write 的展示字段（仅 `ask` 时存在；deny 不带 diff）
    diff: Option<Value>,
    /// `buildTool` 默认实现 / Bash 只读分支返回的 `updatedInput`（= 规范化入参）
    updated_input: Option<Value>,
    /// 拒绝时是否下发 `shouldTerminate`（AgentTool 的拒绝分支会写明该字段）
    should_terminate: Option<bool>,
    /// `ask` 时是否只下发 `{ behavior: 'ask' }`（AgentTool 不带 message / choices）
    plain_ask: bool,
}

impl CheckResult {
    /// `buildTool` 的默认 `checkPermissions` / Bash 只读分支：
    /// `{ behavior: 'allow', updatedInput: input }`
    fn allow_with_input(input: &Value) -> Self {
        CheckResult {
            decision: Decision::Allow,
            message: String::new(),
            choices: Value::Null,
            diff: None,
            updated_input: Some(input.clone()),
            should_terminate: None,
            plain_ask: false,
        }
    }

    /// 工具自定义 `checkPermissions` 直接放行、且**不带** `updatedInput`
    /// （AskUserQuestion：`{ behavior: 'allow' }`）。
    fn allow_plain() -> Self {
        CheckResult {
            decision: Decision::Allow,
            message: String::new(),
            choices: Value::Null,
            diff: None,
            updated_input: None,
            should_terminate: None,
            plain_ask: false,
        }
    }

    fn deny(message: String) -> Self {
        CheckResult {
            decision: Decision::Deny(message.clone()),
            message,
            choices: Value::Null,
            diff: None,
            updated_input: None,
            should_terminate: None,
            plain_ask: false,
        }
    }

    /// 工具自定义 `checkPermissions` 直接放行、且不带 `updatedInput` / message / choices
    /// （AgentTool 的 `{ behavior: 'ask' }`）。
    fn ask_plain() -> Self {
        CheckResult {
            decision: Decision::Ask,
            message: String::new(),
            choices: Value::Null,
            diff: None,
            updated_input: None,
            should_terminate: None,
            plain_ask: true,
        }
    }

    /// 带显式 `shouldTerminate` 的拒绝（AgentTool 的拒绝分支会写明该字段，
    /// 其余工具的拒绝不写）。
    fn deny_with_terminate(message: String, terminate: bool) -> Self {
        CheckResult {
            decision: Decision::Deny(message.clone()),
            message,
            choices: Value::Null,
            diff: None,
            updated_input: None,
            should_terminate: Some(terminate),
            plain_ask: false,
        }
    }

    fn ask(message: String, choices: Value) -> Self {
        CheckResult {
            decision: Decision::Ask,
            message,
            choices,
            diff: None,
            updated_input: None,
            should_terminate: None,
            plain_ask: false,
        }
    }

    fn ask_with_diff(message: String, choices: Value, diff: Value) -> Self {
        CheckResult {
            decision: Decision::Ask,
            message,
            choices,
            diff: Some(diff),
            updated_input: None,
            should_terminate: None,
            plain_ask: false,
        }
    }
}

/// `PermissionPolicy.normalizeToolArgs`：极端情况下 LLM 会把整个入参 double-encode 成字符串。
fn normalize_tool_args(args: &Value) -> Value {
    match args {
        Value::Object(_) => args.clone(),
        Value::String(text) => {
            // 对齐 `normalizeToolArgs` 的 `args.trim()`（JS 空白口径）
            let trimmed = crate::util::js_trim(text);
            if !trimmed.is_empty() {
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    if parsed.is_object() {
                        return parsed;
                    }
                }
            }
            json!({})
        }
        _ => json!({}),
    }
}

/// 工具自身的判定（相当于各工具的 `checkPermissions`）
///
/// `cwd` 只在需要读盘的判定里使用（`Edit` / `Write` 的文件检查），
/// 其余分支与 `cwd` 无关。
fn base_check(tool_name: &str, args: &Value, cwd: &str, session_id: &str) -> CheckResult {
    match tool_name {
        "Read" | "Grep" | "Glob" | "TodoWrite" => CheckResult::allow_with_input(args),
        // `ReplyTool` 没有自定义 checkPermissions → 走 `buildTool` 默认实现（allow + updatedInput）
        "Reply" => CheckResult::allow_with_input(args),
        // `AgentTool.checkPermissions`：入参缺 prompt / agentRole 时 deny；
        // 且**禁止嵌套**——子代理会话（id 以 `sub_` 开头）里调用 Agent 直接 deny。
        "Agent" => {
            let prompt = args.get("prompt").and_then(Value::as_str).unwrap_or("");
            // 对齐 `AgentTool.checkPermissions` 的 `prompt.trim()`（JS 空白口径）
            if crate::util::js_trim(prompt).is_empty() {
                return CheckResult::deny_with_terminate(
                    "Agent 工具需要提供任务描述(prompt)。".to_string(),
                    false,
                );
            }
            let role = args.get("agentRole").and_then(Value::as_str).unwrap_or("");
            if role.is_empty() {
                return CheckResult::deny_with_terminate(
                    "需要指定 agentRole 参数。支持的角色: Master。".to_string(),
                    false,
                );
            }
            if session_id.starts_with("sub_") {
                return CheckResult::deny_with_terminate(format!(
                    "The Agent tool does not support nested calls within sub-agents. The current session \"{session_id}\" is already a sub-agent and cannot create new sub-agents. Please complete the task directly within the current sub-agent."
                ), true);
            }
            // 对齐 `AgentTool.checkPermissions` 的 `return { behavior: 'ask' }`：
            // 没有 message / choices，由 agentMode 加工（auto / risk 放行，manual 保持 ask）。
            CheckResult::ask_plain()
        }
        // AskUserQuestion 的 `checkPermissions` 直接放行（提问本身就在 `call()` 里弹框），
        // 且不返回 `updatedInput`（区别于 `buildTool` 默认实现）。
        "AskUserQuestion" => CheckResult::allow_plain(),
        "Bash" => {
            // 与 Embedded 的 `Bash.checkPermissions` 一致：只有缺失 / 非字符串 / 空串才非法；
            // 纯空白串是合法输入（会走到 ask）。
            let command = match args.get("command").and_then(Value::as_str) {
                Some(value) if !value.is_empty() => value.to_string(),
                _ => {
                    return CheckResult::deny(
                        "Invalid command: command is required and must be a string".to_string(),
                    )
                }
            };
            if is_read_only_command(&command) {
                return CheckResult::allow_with_input(args);
            }
            CheckResult::ask(
                ask_message(tool_name, args, cwd),
                ask_choices(tool_name, args, cwd),
            )
        }
        // 与 Embedded 的 `Write.checkPermissions` 一致：先校验入参，非法直接 deny
        // （deny 不被 auto / risk 加工，永远弹不出确认框）。
        "Write" => {
            let file_path = match args.get("file_path").and_then(Value::as_str) {
                Some(value) if !value.is_empty() => value,
                _ => {
                    return CheckResult::deny(
                        "Invalid file path: file_path is required and must be a string".to_string(),
                    )
                }
            };
            // `content` 只校验「缺失 / null」：空串是合法输入（写入空文件）
            if args.get("content").map(Value::is_null).unwrap_or(true) {
                return CheckResult::deny("Invalid content: content is required".to_string());
            }
            // 对齐 Embedded：文件存在时读旧内容（overwrite），ENOENT 时 beforeContent = null
            // （create）；其它读取错误走 `权限检查失败` 的兜底 deny。
            //
            // `afterContent` 原样保留 `args.content` 的类型：Embedded 的
            // `Write.checkPermissions` 返回的就是 `input.content`（不 stringify），
            // 数字 / 布尔等非字符串入参也会原样进 permResult；displayArgs 侧才用
            // `String(...)` 文本化（见 `diff_texts`）。
            let content_value = args.get("content").cloned().unwrap_or(Value::Null);
            let path = crate::tools::expand_path(cwd, file_path);
            let before_content = match std::fs::read_to_string(&path) {
                Ok(text) => Value::String(text),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => Value::Null,
                Err(err) => return CheckResult::deny(format!("权限检查失败: {err}")),
            };
            let diff = json!({
                "beforeContent": before_content,
                "afterContent": content_value,
            });
            CheckResult::ask_with_diff(
                ask_message(tool_name, args, cwd),
                ask_choices(tool_name, args, cwd),
                diff,
            )
        }
        // 与 Embedded 的 `Edit.checkPermissions` 一致：先校验入参，再校验目标文件存在，
        // 读文件后跑 `computeEdit` 预览（失败即 deny，成功带 before/after/上下文/行号）。
        "Edit" => {
            let file_path = match args.get("file_path").and_then(Value::as_str) {
                Some(value) if !value.is_empty() => value,
                _ => {
                    return CheckResult::deny(
                        "Invalid file path: file_path is required and must be a string".to_string(),
                    )
                }
            };
            if args.get("old_string").map(Value::is_null).unwrap_or(true) {
                return CheckResult::deny("Invalid old_string: old_string is required".to_string());
            }
            if args.get("new_string").map(Value::is_null).unwrap_or(true) {
                return CheckResult::deny("Invalid new_string: new_string is required".to_string());
            }
            // 文件不存在（或不可读）时 deny，提示改用 Write。
            let path = crate::tools::expand_path(cwd, file_path);
            let content = match std::fs::read_to_string(&path) {
                Ok(content) => content,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    return CheckResult::deny(format!(
                        "File does not exist: {file_path}. Use Write tool to create new files."
                    ))
                }
                Err(err) => return CheckResult::deny(format!("Failed to read file: {err}")),
            };
            let old_string_raw = args
                .get("old_string")
                .and_then(Value::as_str)
                .unwrap_or("");
            let new_string_raw = args
                .get("new_string")
                .and_then(Value::as_str)
                .unwrap_or("");
            let replace_all = crate::tools::resolve_replace_all(args.get("replace_all"));
            let offset = args.get("offset").and_then(Value::as_u64);
            let limit = args.get("limit").and_then(Value::as_u64);
            match crate::tools::edit_permission_preview(
                &content,
                old_string_raw,
                new_string_raw,
                replace_all,
                offset,
                limit,
            ) {
                Err(message) => CheckResult::deny(message),
                Ok(preview) => {
                    let diff = json!({
                        "beforeContent": preview.before_content,
                        "afterContent": preview.after_content,
                        "contextBefore": preview.context_before,
                        "contextAfter": preview.context_after,
                        "lineEndings": preview.line_endings,
                        "startLine": preview.start_line,
                        "endLine": preview.end_line,
                    });
                    CheckResult::ask_with_diff(
                        ask_message(tool_name, args, cwd),
                        ask_choices(tool_name, args, cwd),
                        diff,
                    )
                }
            }
        }
        // 其余写工具与非内置工具：默认询问
        _ => CheckResult::ask(
            ask_message(tool_name, args, cwd),
            ask_choices(tool_name, args, cwd),
        ),
    }
}

/// 按会话询问模式加工最终决策
///
/// 引擎侧现在统一走 `resolve_tool_permission`（拿到加工后的 permResult 与
/// displayArgs）；这里保留纯决策视图给权限对照表的单测使用。
#[cfg(test)]
pub fn decide(tool_name: &str, args: &Value, agent_mode: &str, cwd: &str) -> Decision {
    // 权限对照表单测不涉及会话级判定（Agent 的嵌套调用检查），传空串
    let check = base_check(tool_name, args, cwd, "");
    if check.decision != Decision::Ask {
        return check.decision;
    }
    match agent_mode {
        "auto" => Decision::Allow,
        "risk" => {
            if is_operation_risky(tool_name, args) {
                Decision::Ask
            } else {
                Decision::Allow
            }
        }
        // manual：保持询问
        _ => Decision::Ask,
    }
}

/// 风险模式要拦截的操作
pub fn is_operation_risky(tool_name: &str, args: &Value) -> bool {
    if tool_name != "Bash" {
        return false;
    }
    let command = args.get("command").and_then(Value::as_str).unwrap_or("");
    if is_destructive_command(command) {
        return true;
    }
    contains_risky_git(command)
}

/// JS `\b` 的「词字符」集合：`[A-Za-z0-9_]`（ASCII，不含 Unicode 字母）。
fn is_regex_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

/// 等价于 Embedded `PermissionPolicy.isOperationRisky` 的正则
/// `/\bgit\s+(checkout|reset)\b/`（无 `i` 标志，大小写敏感）。
///
/// 不能按空白分词后要求某个 token 恰为 `git`：正则在**任意词边界**上匹配，
/// `bash -c 'git reset --hard'`、`cd repo&&git checkout main`、`(git reset)`
/// 这些命令里的 `git` 前一个字符是引号 / `&` / `(`，同样命中；只按 token 相等
/// 会漏判，risk 模式下把危险命令误放行。这里逐字符扫描，语义与 JS 正则一致：
/// - `git` 前必须是串首或非词字符（`\b`）；
/// - `git` 后必须是串尾或非词字符（`\b`，由 `\s+` 隐含）；
/// - 其后至少一个 `\s`（JS `\s` 口径，含 Unicode 空白）；
/// - 再匹配 `checkout` / `reset`，且其后是串尾或非词字符（`\b`）。
fn contains_risky_git(command: &str) -> bool {
    let chars: Vec<char> = command.chars().collect();
    let length = chars.len();
    let mut index = 0usize;
    while index < length {
        if chars[index] != 'g' {
            index += 1;
            continue;
        }
        // `\bgit`
        let before_ok = index == 0 || !is_regex_word_char(chars[index - 1]);
        let after_git = index + 3;
        if !before_ok
            || after_git > length
            || chars[index + 1] != 'i'
            || chars[index + 2] != 't'
            || (after_git < length && is_regex_word_char(chars[after_git]))
        {
            index += 1;
            continue;
        }
        // `\s+`
        let mut cursor = after_git;
        if cursor >= length || !is_js_whitespace(chars[cursor]) {
            index += 1;
            continue;
        }
        while cursor < length && is_js_whitespace(chars[cursor]) {
            cursor += 1;
        }
        // `(checkout|reset)\b`
        for word in ["checkout", "reset"] {
            let word_len = word.chars().count();
            let end = cursor + word_len;
            if end > length {
                continue;
            }
            if chars[cursor..end].iter().collect::<String>() != word {
                continue;
            }
            if end == length || !is_regex_word_char(chars[end]) {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// 询问时的提示文案（对齐各工具 `checkPermissions` 返回的 message）
pub fn ask_message(tool_name: &str, args: &Value, cwd: &str) -> String {
    match tool_name {
        "Bash" => {
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            if is_destructive_command(command) {
                format!("⚠️ 请求执行：{command}")
            } else {
                format!("请求执行：{command}")
            }
        }
        "Write" => {
            let file_path = args.get("file_path").and_then(Value::as_str).unwrap_or("");
            let action = if write_target_exists(cwd, file_path) {
                "覆盖现有文件"
            } else {
                "创建新文件"
            };
            format!("请求{action}：{file_path}")
        }
        "Edit" => {
            let file_path = args.get("file_path").and_then(Value::as_str).unwrap_or("");
            format!("请求编辑文件：{file_path}")
        }
        _ => format!("请求执行：{tool_name}"),
    }
}

/// 询问时的选项（对齐各工具 `checkPermissions` 返回的 choices）
pub fn ask_choices(tool_name: &str, args: &Value, cwd: &str) -> Value {
    match tool_name {
        "Bash" => {
            let command = args.get("command").and_then(Value::as_str).unwrap_or("");
            if is_destructive_command(command) {
                json!([
                    { "label": "允许执行", "description": "我知道这个命令的风险，继续执行" },
                    { "label": "拒绝", "description": "取消此操作" },
                ])
            } else {
                json!([
                    { "label": "允许", "description": "执行此命令" },
                    { "label": "拒绝", "description": "取消此操作" },
                ])
            }
        }
        "Write" => {
            let file_path = args.get("file_path").and_then(Value::as_str).unwrap_or("");
            let description = if write_target_exists(cwd, file_path) {
                "覆盖文件"
            } else {
                "创建文件"
            };
            json!([
                { "label": "允许", "description": description },
                { "label": "拒绝", "description": "取消操作" },
            ])
        }
        "Edit" => json!([
            { "label": "允许", "description": "应用编辑" },
            { "label": "拒绝", "description": "取消操作" },
        ]),
        _ => json!([
            { "label": "允许", "description": "继续执行" },
            { "label": "拒绝", "description": "取消操作" },
        ]),
    }
}

/// `PermissionPolicy.resolveToolPermission` 的等价物：
/// 工具自身判定 → 按 agentMode 加工 → 展开展示用参数。
///
/// 返回 `(permResult, displayArgs)`，形状与 Embedded 下发给
/// `CoreRequest.toolPermissionRequested` 的一致。
pub fn resolve_tool_permission(
    tool_name: &str,
    raw_args: &Value,
    agent_mode: &str,
    cwd: &str,
    session_id: &str,
) -> (Value, Value) {
    let args = normalize_tool_args(raw_args);
    let check = base_check(tool_name, &args, cwd, session_id);

    // 改动内容（展示用）取自**工具自己的**权限结果，与下面按 agentMode 做的决策加工无关：
    // auto / risk 把 ask 自动放行为 allow 时，改动内容仍要保留，用户才看得到这次修改。
    let diff_payload = match (&check.decision, &check.diff) {
        (Decision::Ask, Some(diff)) if tool_name == "Edit" || tool_name == "Write" => {
            Some(diff.clone())
        }
        _ => None,
    };

    let perm_result = match &check.decision {
        Decision::Allow => match &check.updated_input {
            Some(input) => json!({ "behavior": "allow", "updatedInput": input }),
            None => json!({ "behavior": "allow" }),
        },
        Decision::Deny(message) => {
            let mut base = json!({ "behavior": "deny", "message": message });
            if let Some(terminate) = check.should_terminate {
                if let Some(object) = base.as_object_mut() {
                    object.insert("shouldTerminate".to_string(), json!(terminate));
                }
            }
            base
        }
        Decision::Ask => {
            let mut base = if check.plain_ask {
                // AgentTool 的 `return { behavior: 'ask' }`：不带 message / choices
                json!({ "behavior": "ask" })
            } else {
                json!({
                    "behavior": "ask",
                    "message": check.message,
                    "choices": check.choices,
                })
            };
            if let Some(diff) = &diff_payload {
                if let (Some(target), Some(source)) = (base.as_object_mut(), diff.as_object()) {
                    for (key, value) in source {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
            match agent_mode {
                // auto 模式：ask → allow（跳过确认）；改动内容照常带上供 UI 展示
                "auto" => allow_with_diff(&diff_payload),
                // 风险拦截模式：只拦截危险操作，普通操作自动放行
                "risk" => {
                    if is_operation_risky(tool_name, &args) {
                        base
                    } else {
                        allow_with_diff(&diff_payload)
                    }
                }
                // manual 模式：保持 ask（无需加工）
                _ => base,
            }
        }
    };

    let display_args =
        build_display_args(tool_name, &args, cwd, diff_payload.as_ref(), &perm_result);
    (perm_result, display_args)
}

/// `{ behavior: 'allow', ...diffPayload }`（对齐 Embedded 的自动放行产物）
fn allow_with_diff(diff_payload: &Option<Value>) -> Value {
    let mut result = json!({ "behavior": "allow" });
    if let Some(diff) = diff_payload {
        if let (Some(target), Some(source)) = (result.as_object_mut(), diff.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    result
}

/// 工具不存在时的展示参数展开（permResult 恒为 allow，对齐 `resolveToolPermission(..., null)`）
pub fn display_args_for_unknown(tool_name: &str, args: &Value, cwd: &str) -> Value {
    build_display_args(
        tool_name,
        &normalize_tool_args(args),
        cwd,
        None,
        &json!({ "behavior": "allow" }),
    )
}

/// `diffPayload` 的 before / after 文本化（对齐 Embedded 的 `diffBeforeContent` /
/// `diffAfterContent`）：`beforeContent` 缺失 → 无 diff；null → 空串。
fn diff_texts(diff_payload: Option<&Value>) -> (String, String) {
    let Some(diff) = diff_payload else {
        return (String::new(), String::new());
    };
    let Some(before_value) = diff.get("beforeContent") else {
        return (String::new(), String::new());
    };
    let before = if before_value.is_null() {
        String::new()
    } else {
        crate::util::js_string(before_value)
    };
    let after = match diff.get("afterContent") {
        Some(value) if !value.is_null() => crate::util::js_string(value),
        _ => String::new(),
    };
    (before, after)
}

/// 展示用参数：路径展开 + Write / Edit 的 diff 字段（对齐 `PermissionPolicy` 的
/// `displayArgs` 展开）。
///
/// `diffHunks` 有意省略：webview 在缺少该键时用同一份 `beforeContent` / `afterContent`
/// 调用 `buildEditDiffHunks`（同一算法、同一入参），渲染结果与 Embedded 一致；
/// 随包下发整份内容会显著放大帧体积，因此这里沿用更紧凑的等价路径。
fn build_display_args(
    tool_name: &str,
    args: &Value,
    cwd: &str,
    diff_payload: Option<&Value>,
    perm_result: &Value,
) -> Value {
    let mut display = match args {
        Value::Object(map) => Value::Object(map.clone()),
        _ => json!({}),
    };
    let display_map = display
        .as_object_mut()
        .expect("displayArgs 必须是对象");

    if matches!(tool_name, "Read" | "Write" | "Edit") {
        // 对齐 Embedded：`args.file_path || args.path`（真值优先），再做类型判断
        let file_path_value = args
            .get("file_path")
            .filter(|value| crate::history::js_truthy(Some(value)))
            .or_else(|| {
                args.get("path")
                    .filter(|value| crate::history::js_truthy(Some(value)))
            });
        if let Some(file_path) = file_path_value
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            let absolute = crate::tools::expand_path(cwd, file_path);
            display_map.insert(
                "file_path".to_string(),
                json!(absolute.to_string_lossy()),
            );
        }

        if tool_name == "Write" {
            if let Some(content_value) = args
                .get("content")
                .filter(|value| crate::history::js_truthy(Some(value)))
            {
                let content = crate::util::js_string(content_value);
                let (diff_before, diff_after) = diff_texts(diff_payload);
                display_map.insert("content".to_string(), content_value.clone());
                display_map.insert("contentPreview".to_string(), json!(content));
                display_map.insert(
                    "totalLines".to_string(),
                    json!(content.split('\n').count()),
                );
                display_map.insert("isTruncated".to_string(), json!(false));
                // 保留 null（新建文件）以便回滚时删除文件
                display_map.insert(
                    "beforeContent".to_string(),
                    if diff_before.is_empty() {
                        Value::Null
                    } else {
                        json!(diff_before)
                    },
                );
                let after = if !diff_after.is_empty() {
                    diff_after
                } else {
                    content.clone()
                };
                display_map.insert("afterContent".to_string(), json!(after));
            }
        }

        if tool_name == "Edit" {
            let old_string = args
                .get("old_string")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .map(crate::util::js_string)
                .unwrap_or_default();
            let new_string = args
                .get("new_string")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .map(crate::util::js_string)
                .unwrap_or_default();
            display_map.insert("old_string".to_string(), json!(old_string));
            display_map.insert("new_string".to_string(), json!(new_string));
            // 对齐 Embedded：`args.replace_all || false`（JS 真值，字符串 "false" 保留原样）
            let replace_all = args
                .get("replace_all")
                .filter(|value| crate::history::js_truthy(Some(value)))
                .cloned()
                .unwrap_or(json!(false));
            display_map.insert("replace_all".to_string(), replace_all);

            // 只有本次权限检查确实携带 diff 信息时才附加 diff 字段
            if let Some(diff) = diff_payload {
                let (diff_before, diff_after) = diff_texts(Some(diff));
                // Embedded 只下发 diffHunks；Standalone 不预计算该键，改为下发
                // beforeContent / afterContent，让 webview 用同一份
                // `buildEditDiffHunks` 回退计算（渲染结果一致，代价是帧体积更大）。
                display_map.insert(
                    "beforeContent".to_string(),
                    if diff_before.is_empty() {
                        Value::Null
                    } else {
                        json!(diff_before)
                    },
                );
                display_map.insert("afterContent".to_string(), json!(diff_after));
                display_map.insert(
                    "contextBefore".to_string(),
                    diff.get("contextBefore")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                display_map.insert(
                    "contextAfter".to_string(),
                    diff.get("contextAfter")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                );
                display_map.insert(
                    "startLine".to_string(),
                    diff.get("startLine").cloned().unwrap_or(Value::Null),
                );
                display_map.insert(
                    "endLine".to_string(),
                    diff.get("endLine").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }

    // previewContent（工具在 checkPermissions 时给出的展示预览）
    if let Some(preview) = perm_result
        .get("previewContent")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        display_map.insert("_preview".to_string(), json!(preview));
    }

    display
}

/// Write 的目标文件是否已存在（决定「创建新文件」还是「覆盖现有文件」）
fn write_target_exists(cwd: &str, file_path: &str) -> bool {
    if file_path.is_empty() {
        return false;
    }
    crate::tools::expand_path(cwd, file_path).exists()
}



#[cfg(test)]
#[path = "permission_tests.rs"]
mod tests;

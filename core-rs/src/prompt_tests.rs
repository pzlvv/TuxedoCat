//! `prompt` 的单元测试：系统提示三层结构、AGENTS.md、上下文段、agent mode 解析。

use super::*;
use crate::test_support::Sandbox;
use serde_json::json;

fn sandbox(name: &str) -> Sandbox {
    let sandbox = Sandbox::new(name);
    crate::config::set_active_workspace(Some(sandbox.workspace.to_string_lossy().to_string()));
    sandbox
}

#[test]
fn system_prompt_has_principles_tools_and_environment() {
    let sandbox = sandbox("prompt-structure");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let prompt = build_system_prompt(&cwd, "risk", &json!({})).expect("PATH 已由 Sandbox 钉死");

    assert!(prompt.contains("## Core Principles"));
    assert!(prompt.contains("## Tool Usage"));
    assert!(prompt.contains("## Environment"));
    // 工具清单来自 tools::definitions()
    for tool in crate::tools::definitions() {
        let name = tool["name"].as_str().unwrap();
        assert!(prompt.contains(&format!("- **{name}**")), "缺少工具 {name}");
    }
    assert!(prompt.contains(&format!("- **Working Directory**: {cwd}")));
    // `{platform} ({osType} {osRelease})`
    assert!(prompt.contains(&format!("- **Operating System**: {} (", os_platform())));
    assert!(prompt.contains(os_type()));
    assert!(prompt.contains("- **Shell**: "));
    assert!(prompt.contains("- **Git Repository**: No"));
    // 环境段不包含 Permission Mode
    assert!(!prompt.contains("- **Permission Mode**:"));
    // 三段之间用空行分隔
    assert!(prompt.contains("\n\n## Tool Usage"));
}

#[test]
fn system_prompt_carries_tool_details_for_every_builtin_tool() {
    // `## Tool Usage` 之后必须紧跟
    // `## Tool Details`，并按 `getAllTools()` 的顺序逐工具渲染 `### <name>` + 详细用法。
    let sandbox = sandbox("prompt-tool-details");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let prompt = build_system_prompt(&cwd, "risk", &json!({})).expect("PATH 已由 Sandbox 钉死");

    assert!(prompt.contains("\n\n## Tool Details\n### Bash\n"), "got {prompt}");
    let order = [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Grep",
        "Glob",
        "TodoWrite",
        "AskUserQuestion",
    ];
    let mut cursor = 0usize;
    for name in order {
        let needle = format!("### {name}\n");
        let index = prompt[cursor..]
            .find(&needle)
            .unwrap_or_else(|| panic!("缺少 {needle}"));
        cursor += index + needle.len();
    }
    // 逐字抽查带特殊字符（反引号 / 引号 / 井号 / 管道）的行，确认没有被转义或改写
    assert!(prompt.contains("**IMPORTANT**: Always use bash/POSIX syntax for commands"));
    assert!(prompt.contains("- Maximum file size for whole-file reads: 256.0 KB"));
    assert!(prompt.contains("- Maximum output bytes per read: 50.0 KB"));
    assert!(prompt.contains("- `replace_all` (boolean, optional): Replace all occurrences"));
    assert!(prompt.contains("- output_mode (optional): \"files_with_matches\" (default), \"content\", or \"count\""));
    assert!(prompt.contains("- pattern (required): The glob pattern to match files against (e.g. \"**/*.js\", \"src/**/*.ts\")"));
    assert!(prompt.contains("1. **Complex multi-step tasks** - When a task requires 3 or more distinct steps or actions"));
    // Tool Details 是最后一个 `###` 段落之前的正文；尾部不能多出换行
    assert!(prompt.contains("When in doubt, use this tool."));
}

#[test]
fn system_prompt_skips_optional_sections_when_absent() {
    let sandbox = sandbox("prompt-optional");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let prompt = build_system_prompt(&cwd, "auto", &Value::Null).expect("PATH 已由 Sandbox 钉死");
    assert!(!prompt.contains("AGENTS.md"));
    assert!(!prompt.contains("## Current File"));
    assert!(!prompt.contains("## Current Selection"));
}

#[test]
fn agents_md_is_inlined_into_the_system_prompt() {
    let sandbox = sandbox("prompt-agents-md");
    sandbox.write_file("AGENTS.md", "  项目约定：只用单引号  \n");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let prompt = build_system_prompt(&cwd, "manual", &json!({})).expect("PATH 已由 Sandbox 钉死");
    // 原样追加，不加标题
    assert!(prompt.contains("项目约定：只用单引号"));
    assert!(!prompt.contains("## Project Instructions"));
    assert!(!prompt.contains("  \n"), "首尾空白应被裁剪");
}

#[test]
fn agents_md_is_ignored_when_blank_or_missing() {
    let sandbox = sandbox("prompt-agents-blank");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    assert!(read_agents_md(&cwd).is_none(), "文件不存在");

    sandbox.write_file("AGENTS.md", "   \n\n");
    assert!(read_agents_md(&cwd).is_none(), "只有空白");

    // cwd 为空时直接返回 null，绝不回退到
    // 进程工作目录下的相对 `AGENTS.md`。
    assert!(read_agents_md("").is_none(), "空 cwd");
}

#[test]
fn agents_md_is_not_truncated() {
    // AGENTS.md 原样注入，不做长度截断
    let sandbox = sandbox("prompt-agents-huge");
    sandbox.write_file("AGENTS.md", &"x".repeat(40 * 1024));
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let content = read_agents_md(&cwd).expect("agents md");
    assert_eq!(content.len(), 40 * 1024);
}

#[test]
fn system_prompt_never_renders_file_context_sections() {
    // preset 只声明「工具说明 / 环境 / AGENTS.md」三个区块，
    // 文件上下文由用户消息的 `[Current File: ...]` 前缀投递（见 Query.ts）。
    // 因此 meta.json 里带 currentFile / selectedLines 时也不应多出系统提示段。
    let sandbox = sandbox("prompt-file-context");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let prompt = build_system_prompt(
        &cwd,
        "risk",
        &json!({ "context": {
            "currentFile": "src/a.ts",
            "selectedLines": { "start": 3, "end": 9 },
            "agentMode": "auto"
        } }),
    )
    .expect("PATH 已由 Sandbox 钉死");
    assert!(!prompt.contains("## Current File"), "got {prompt}");
    assert!(!prompt.contains("## Current Selection"), "got {prompt}");
    assert!(!prompt.contains("src/a.ts"), "got {prompt}");
}

#[test]
fn active_preset_matches_spec_transitions() {
    // 非 mixed 直接返回用户选择；非法 / 缺省回退 normal
    assert_eq!(active_preset(None, false), "normal");
    assert_eq!(active_preset(Some("normal"), true), "normal");
    assert_eq!(active_preset(Some("minimal"), true), "minimal");
    assert_eq!(active_preset(Some("bogus"), false), "normal");
    // mixed：首次 assistant 回复前 minimal，之后 normal（与 QueryEngine 一致）
    assert_eq!(active_preset(Some("mixed"), false), "minimal");
    assert_eq!(active_preset(Some("mixed"), true), "normal");
}

#[test]
fn preset_tool_whitelist_and_minimal_prompt() {
    let sandbox = sandbox("prompt-preset");
    let cwd = sandbox.workspace.to_string_lossy().to_string();
    let all = tools::definitions();

    // normal 暴露全部工具，system prompt 含核心原则 + 工具说明 + 环境
    let normal_tools = filter_tools_by_preset(all.clone(), "normal");
    assert_eq!(normal_tools.len(), all.len());
    let normal = build_system_prompt_with_preset("normal", &cwd, &normal_tools)
        .expect("PATH 已由 Sandbox 钉死");
    assert!(normal.starts_with("You are a helpful software engineer assistant."));
    assert!(normal.contains("## Core Principles"));
    assert!(normal.contains("## Tool Usage"));
    assert!(normal.contains("## Environment"));

    // minimal / mixed 只暴露 Bash / Edit，system prompt 只有一行核心身份
    for preset in ["minimal", "mixed"] {
        let tools = filter_tools_by_preset(all.clone(), preset);
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(names, vec!["Bash", "Edit"], "preset={preset}");
        let prompt = build_system_prompt_with_preset(preset, &cwd, &tools)
            .expect("PATH 已由 Sandbox 钉死");
        assert_eq!(prompt, "You are a helpful software engineer assistant.");
    }
}

#[test]
fn agent_mode_prefers_session_context_then_metadata_then_settings() {
    let sandbox = sandbox("prompt-agent-mode");
    sandbox.write_settings(json!({ "defaultAgentMode": "auto" }));

    assert_eq!(agent_mode_of(&json!({})), "auto");
    assert_eq!(agent_mode_of(&json!({ "agentMode": "manual" })), "manual");
    assert_eq!(
        agent_mode_of(&json!({ "agentMode": "manual", "context": { "agentMode": "risk" } })),
        "risk",
        "会话上下文优先于顶层字段"
    );
    // 非字符串一律回落到默认值
    assert_eq!(agent_mode_of(&json!({ "agentMode": 7 })), "auto");
}

#[test]
fn git_description_reports_the_branch_and_is_cached() {
    let sandbox = sandbox("prompt-git");
    // 注意：结果按目录缓存，同一目录只能问一次，因此两个分支用不同目录
    let plain = sandbox.workspace.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert_eq!(
        git_description(&plain.to_string_lossy()).expect("PATH 已钉死"),
        "No",
        "空目录不是仓库"
    );

    let cwd = sandbox.workspace.to_string_lossy().to_string();

    // 没有 git 就只验证非仓库分支
    if std::process::Command::new("git")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .status()
        .map(|status| !status.success())
        .unwrap_or(true)
    {
        return;
    }
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&cwd)
        .status()
        .expect("git init");
    assert!(init.success());
    let commit = std::process::Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit",
               "--allow-empty", "-q", "-m", "init"])
        .current_dir(&cwd)
        .status()
        .expect("git commit");
    assert!(commit.success());

    let first = git_description(&cwd).expect("PATH 已钉死");
    assert!(first.starts_with("Yes (branch: "), "got {first}");
    // 第二次命中缓存（不再 spawn git）
    assert_eq!(git_description(&cwd).expect("PATH 已钉死"), first);
}

#[test]
fn git_description_falls_back_when_the_directory_is_gone() {
    let _guard = crate::test_support::serial();
    let missing = format!("D:/definitely-missing-{}", crate::util::unique_id("dir"));
    assert_eq!(git_description(&missing).expect("PATH 已钉死"), "No");
}

#[test]
fn windows_release_parsing_matches_node_os_release() {
    // 英文 `ver` 输出
    assert_eq!(parse_windows_release("Version 10.0.26200.9457"), "10.0.26200");
    // 本地化（中文）输出：不能依赖 "Version" 字样
    assert_eq!(parse_windows_release("版本 10.0.26200.9457"), "10.0.26200");
    // 只有三段时原样返回
    assert_eq!(parse_windows_release("Version 6.3.9600"), "6.3.9600");
    // 解析不出来时原样 trim 返回
    assert_eq!(parse_windows_release("  unknown  "), "unknown");
}

// ==================== 系统提示词静态部分对照表 ====================

mod system_prompt_parity_tests {
    use super::*;

    /// 行为对照表（数据见 core-rs/fixtures/）。
    ///
    /// 断言「Rust `core_prompt` / `tool_usage_section` / `preset_core_prompt` == 本表」。
    const FIXTURE: &str = include_str!("../fixtures/systemPrompt.json");

    /// 找首个不同的 UTF-16 code unit，返回带上下文的可读信息（整段提示词太长，不能直接打印）。
    fn describe_difference(expected: &str, actual: &str) -> String {
        let expected_units: Vec<u16> = expected.encode_utf16().collect();
        let actual_units: Vec<u16> = actual.encode_utf16().collect();
        let limit = expected_units.len().min(actual_units.len());
        let index = (0..limit)
            .find(|&i| expected_units[i] != actual_units[i])
            .unwrap_or(limit);
        let start = index.saturating_sub(60);
        let end = (index + 60).min(limit);
        let expected_slice: String = String::from_utf16_lossy(&expected_units[start..end]);
        let actual_slice: String = String::from_utf16_lossy(&actual_units[start..end]);
        format!(
            "首个差异在 UTF-16 下标 {index}（期望 {} / 实际 {} 个 code unit）\n  期望: {expected_slice:?}\n  实际: {actual_slice:?}",
            expected_units.len(),
            actual_units.len(),
        )
    }

    #[test]
    fn system_prompt_static_text_matches_the_shared_table() {
        let fixture: Value = serde_json::from_str(FIXTURE).expect("对照表必须是合法 JSON");

        let expected_core = fixture
            .get("corePrompt")
            .and_then(Value::as_str)
            .expect("对照表缺少 corePrompt");
        assert_eq!(
            core_prompt(),
            expected_core,
            "核心身份提示词与对照表不一致：\n{}",
            describe_difference(expected_core, core_prompt())
        );

        let expected_tool_usage = fixture
            .get("toolUsage")
            .and_then(Value::as_str)
            .expect("对照表缺少 toolUsage");
        let actual_tool_usage = tool_usage_section(&crate::tools::definitions());
        assert_eq!(
            actual_tool_usage,
            expected_tool_usage,
            "工具说明与对照表不一致：\n{}",
            describe_difference(expected_tool_usage, &actual_tool_usage)
        );

        let expected_minimal = fixture
            .get("minimalPrompt")
            .and_then(Value::as_str)
            .expect("对照表缺少 minimalPrompt");
        assert_eq!(
            preset_core_prompt("minimal"),
            expected_minimal,
            "极简预设核心身份与对照表不一致"
        );

        // Master 子代理的 `## Communication` 前缀段
        let expected_communication = fixture
            .get("subAgentCommunicationSection")
            .and_then(Value::as_str)
            .expect("对照表缺少 subAgentCommunicationSection");
        let actual_communication = sub_agent_communication_section("__CREATOR__");
        assert_eq!(
            actual_communication,
            expected_communication,
            "子代理 Communication 前缀与对照表不一致：\n{}",
            describe_difference(expected_communication, &actual_communication)
        );

        // 对照表记录的工具顺序必须与 `tools::definitions()` 一致（顺序会影响提示词前缀）
        let expected_tools: Vec<String> = fixture
            .get("tools")
            .and_then(Value::as_array)
            .expect("对照表缺少 tools")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        let actual_tools: Vec<String> = crate::tools::definitions()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(actual_tools, expected_tools, "内置工具顺序与对照表不一致");
    }
}

/// `## Tool Details` 的 WebSearch / WebFetch 段跟随注入清单：两工具不在清单里
/// （联网搜索关闭）时对应段不出现在提示词，其余工具说明与 Tool Usage bullet 原样
/// （specs/defects/web-search-off-still-usable）。
#[test]
fn tool_usage_details_follow_the_injected_tool_list() {
    let full = crate::tools::definitions();
    let without_web: Vec<Value> = full
        .iter()
        .filter(|tool| {
            !matches!(
                tool.get("name").and_then(Value::as_str),
                Some("WebSearch") | Some("WebFetch")
            )
        })
        .cloned()
        .collect();

    let with = tool_usage_section(&full);
    let without = tool_usage_section(&without_web);

    assert!(with.contains("## WebSearch Tool"), "全量清单应含 WebSearch 段");
    assert!(with.contains("## WebFetch Tool"), "全量清单应含 WebFetch 段");
    assert!(
        !without.contains("## WebSearch Tool"),
        "剔除后不应再含 WebSearch 段"
    );
    assert!(
        !without.contains("## WebFetch Tool"),
        "剔除后不应再含 WebFetch 段"
    );
    // 其余工具说明与清单 bullet 不受影响
    assert!(
        without.contains("## Skill Tool") && without.contains("### Bash"),
        "其余工具说明应原样保留"
    );
    assert!(without.contains("**Bash**"), "其余工具 bullet 应原样保留");
    assert!(!without.contains("**WebSearch**"), "Tool Usage 清单 bullet 应同步消失");
    assert!(with.contains("**WebSearch**"), "全量清单应有 WebSearch bullet");
}

/// Agent 角色表列出全部合法角色（specs/020 FR-001）：提示词正文与
/// `tools::SUB_AGENT_ROLES` 同步——注册表加了角色而提示词漏改时在这里红。
#[test]
fn agent_role_table_lists_all_registered_roles() {
    for role in crate::tools::SUB_AGENT_ROLES {
        assert!(
            TOOL_DETAILS.contains(&format!("\"{role}\":").as_str()),
            "Agent 角色表缺少 {role} 条目"
        );
    }
}

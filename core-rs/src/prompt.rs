//! 系统提示词组装（三层结构：核心原则 / 工具说明 / 环境信息）。

use serde_json::Value;

use crate::config;
use crate::skills;
use crate::tools;

/// 核心原则（与 `src/core/prompt/SystemPrompt.ts` 的 `generateCoreSystemPrompt` 逐字一致）
const CORE_PRINCIPLES: &str = "You are a helpful software engineer assistant.

## Core Principles
- Respond in the same language the user uses.
- Do not use emojis in your responses.
- When the sub-agent provides feedback or requests additional information, use the `Reply` tool to send messages back. Ordinary text output will not reach the sub-agent, only `Reply` can deliver messages to it.";

/// 各内置工具的详细用法（`## Tool Details` 段的常驻部分）。
///
/// 正文逐字沿用；顺序与工具表一致（Bash / Read / Write / Edit / Grep / Glob /
/// TodoWrite / Agent / Reply / AskUserQuestion，其后按注入清单拼接
/// `WEB_SEARCH_TOOL_DETAILS` / `WEB_FETCH_TOOL_DETAILS`，`SKILL_TOOL_DETAILS`
/// 恒在最后）。
const TOOL_DETAILS: &str = r#"### Bash
Execute shell commands.

**IMPORTANT**: Always use bash/POSIX syntax for commands, regardless of the actual shell. This ensures commands work across bash, PowerShell, and cmd.exe.

**Syntax Guidelines**:
- Use forward slashes for paths
- Use unix-style commands: ls, cat, rm, cp, mv, mkdir, touch, sort, grep, find, head, tail, wc, awk, sed, cut, tr, uniq, diff, tar, zip, unzip, curl, wget
- Use pipes and redirection: |, >, >>, <
- Use command chains: &&, ||, ;
- Environment variables: $VAR (not %VAR%)
- Quote handling: Use single quotes for strings with spaces

**Pipes & Command Chains**:
- `|` pipes the output of one command into the next: `grep pattern file.txt | sort | uniq`
- `&&` runs the next command only if the previous succeeded: `npm run build && npm test`
- `||` runs the next command only if the previous failed: `cd dist || mkdir dist`
- `;` runs commands sequentially regardless of success: `cd src; ls -la`
- IMPORTANT: A `|` inside quotes is part of the argument, NOT a separator. For example `grep "a|b" file.txt` searches for the literal text `a|b`. Do not split commands at a `|` that appears inside single or double quotes.

**Common Usage**:
- Run tests: npm test
- Build: npm run build or make build
- List files: ls -la
- Search: grep 'pattern' file.txt
- Sort lines: sort file.txt
- Count lines/words: wc -l file.txt

**Path Handling**:
- Always use forward slashes in paths, even on Windows
- Use relative paths from the current working directory when possible
- Absolute paths should use forward slashes

Commands will be executed in the current working directory unless you specify a different path using cd.

**Background Execution**:
- You can use the `run_in_background` parameter to run commands in the background.
- Use this when you don't need the result immediately and want to continue with other tasks.
- You will be notified when the background command completes — no need to poll or check manually.
- Do not use shell backgrounding operators like `&` or `nohup` — use the `run_in_background` parameter instead.

### Read
## Read Tool

Reads the contents of a file from the local filesystem.

**Parameters:**
- `file_path` (string, required): The absolute path to the file to read
- `offset` (number, optional): The 1-based line number to start reading from (default: 1; 0 is treated as 1)
- `limit` (number, optional): The number of lines to read
- `sheet` (string, optional): For xlsx/xlsm files, specify the sheet name to read. Defaults to the first sheet if not specified.

**Usage:**
- Read entire file: Use just `file_path`
- Read specific range: Use `offset` and `limit` to read a portion of the file
- Read specific sheet: Use `sheet` parameter for Excel files
- Line numbers shown in output are 1-based and separated by `|`; `offset` uses the same 1-based numbering (consistent with the Edit tool)

**Limits:**
- Maximum file size for whole-file reads: 256.0 KB (text files only; xlsx/image files are exempt). Files larger than this require `offset` and `limit`
- Maximum lines per read: 2000
- Maximum characters per line: 2000 (longer lines are truncated)
- Maximum output bytes per read: 50.0 KB (output is capped; use `offset` to continue)
- These limits apply even when `offset` and `limit` are provided

**xlsx/xlsm (Excel) Support:**
- Automatically detects `.xlsx` and `.xlsm` files
- Reads the specified sheet (or first sheet by default) into a text table
- Parses cells into a text table with aligned columns
- Supports `offset`, `limit`, and `sheet` parameters (max 50 rows per read)
- If there are multiple sheets, all sheet names are listed so you can read other sheets

**Image Files (.png / .jpg / .jpeg / .gif / .webp / .bmp) Support:**
- Reads the image and returns it as an image content block, so the model can see the actual image directly.
- The content must match the format its extension declares (signature and end-of-image marker); a mismatch is reported as an invalid image instead of being sent.

**Important:**
- Always read a file before attempting to edit it
- Use offset/limit for large files; the same output caps still apply
- The file path must be absolute, not relative

### Write
## Write Tool

Writes content to a file on the local filesystem. Creates the file if it doesn't exist, or overwrites it if it does.

**Parameters:**
- `file_path` (string, required): The absolute path to the file to write
- `content` (string, required): The content to write to the file

**Usage:**
- Create new file: Provide path and content
- Overwrite existing file: Completely replaces the file contents

**Important:**
- Prefer Edit tool for modifying existing files
- The file path must be absolute, not relative
- This tool will completely replace the file contents

### Edit
## Edit Tool

Edits a file by replacing exact text matches. This is the preferred tool for modifying existing files.

**Parameters:**
- `file_path` (string, required): The absolute path to the file to edit
- `old_string` (string, required): The exact string to replace
- `new_string` (string, required): The new string to replace it with
- `replace_all` (boolean, optional): Replace all occurrences within the search range (default: false)
- `offset` (number, optional): The 1-based line number where the search range starts (default: 1)
- `limit` (number, optional): The number of lines to search within. If provided, `old_string` must match entirely within lines `offset` to `offset+limit-1` (1-based); if omitted, searches to the end of the file

**Usage:**
- Single replacement: Provide exact `old_string` to replace once
- Replace all occurrences: Set `replace_all` to true
- Edit a specific line range: Use `offset` and `limit` to restrict matching to a portion of the file

**Important:**
- The `old_string` must match exactly (including whitespace and indentation).
- When `offset` and/or `limit` are provided, only matches within the specified line range are considered.
- When `replace_all` is false, `old_string` must match exactly once within the search range. If it matches multiple locations, the tool returns an error instead of applying the first match; include more surrounding context to make `old_string` unique, or set `replace_all` to true.
- The tool result includes the edited line numbers (e.g. `Edited lines 10-15`), matching the line numbers shown by the Read tool.
- This tool only modifies the specific matched sections, not the entire file
- For creating new files or complete replacements, use the Write tool instead

### Grep
## Grep Tool
Searches for patterns in file contents using ripgrep (rg).

**When to use:**
- Use this tool when you need to find files containing specific text or patterns
- Prefer this tool over Bash with grep/ripgrep commands
- ALWAYS use this tool for content searching - never use the Bash tool with grep/rg commands

**Parameters:**
- pattern (required): The regular expression pattern to search for
- path (optional): File or directory to search in. Defaults to current working directory
- glob (optional): Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")
- output_mode (optional): "files_with_matches" (default), "content", or "count"
- -C/-B/-A/context (optional): Number of context lines to show
- -i (optional): Case insensitive search
- type (optional): File type to search (js, py, rust, go, java, etc.)
- head_limit (optional): Limit output to first N results. Defaults to 250. Pass 0 for unlimited
- offset (optional): Skip first N results before applying head_limit
- multiline (optional): Enable multiline mode where . matches newlines

**Usage:**
- Search for text: pattern="keyword"
- Search in directory: pattern="TODO", path="src"
- Filter by file type: pattern="import", glob="*.ts"
- Show matching content: pattern="TODO", output_mode="content", -C=2
- Case insensitive: pattern="error", -i=true
- Count matches: pattern="function", output_mode="count"

**Output modes:**
- "files_with_matches" (default): Returns file paths
- "content": Returns matching lines with line numbers
- "count": Returns match counts per file

### Glob
## Glob Tool
Finds files by name pattern or wildcard using ripgrep.

**When to use:**
- Use this tool when you need to find files matching a specific pattern
- Prefer this tool over Bash with find commands
- ALWAYS use this tool for file pattern matching - never use the Bash tool with find commands

**Parameters:**
- pattern (required): The glob pattern to match files against (e.g. "**/*.js", "src/**/*.ts")
- path (optional): The directory to search in. If not specified, the current working directory will be used

**Output:**
- Returns matching file paths sorted by modification time
- Results are limited to 100 files by default

### TodoWrite
## TodoWrite Tool

Use this tool to create and manage a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

### When to Use This Tool
Use this tool proactively in these scenarios:

1. **Complex multi-step tasks** - When a task requires 3 or more distinct steps or actions
2. **Non-trivial and complex tasks** - Tasks that require careful planning or multiple operations
3. **User explicitly requests todo list** - When the user directly asks you to use the todo list
4. **User provides multiple tasks** - When users provide a list of things to be done (numbered or comma-separated)
5. **After receiving new instructions** - Immediately capture user requirements as todos
6. **When you start working on a task** - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. **After completing a task** - Mark it as completed and add any new follow-up tasks discovered during implementation

### When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

### Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

   **IMPORTANT**: Task descriptions must have two forms:
   - content: The imperative form describing what needs to be done (e.g., "Run tests", "Build the project")
   - activeForm: The present continuous form shown during execution (e.g., "Running tests", "Building the project")

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Exactly ONE task must be in_progress at any time (not less, not more)
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names
   - Always provide both forms:
     - content: "Fix authentication bug"
     - activeForm: "Fixing authentication bug"
     - status: "pending"

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.

### Agent
## Agent Tool

Launches a specialized sub-agent to handle complex, multi-step tasks autonomously.

**Parameters:**
- `prompt` (string, required): The task for the agent to perform
- `description` (string, optional): A short (3-5 word) description summarizing what the agent will do
- `agentRole` (string, required): The role of the agent to spawn
- `target` (string, optional): Target workspace agent ID (`hostname:path`). Omit to spawn the sub-agent in the current workspace; pass the identity of another open workspace to delegate there.

Available agent roles (required):
- "Master": Same capabilities as the main Agent (excluding the role capabilities listed above), used for handling tasks in an independent context.
- "Explorer": A file-browsing specialist restricted to read-only tools (Read, Glob, Grep), used for locating and inspecting files without modifying anything.

**Usage:**
- Use when a task requires multiple steps that can be delegated
- Use for research tasks that need independent investigation
- Use for parallelizable work that benefits from isolation
- When the user addresses another workspace with `@`, call this tool with `target` set to that workspace ID instead of doing the task in the current workspace
- The sub-agent has its own isolated context and tool access

**Important:**
- Always include a short description (3-5 words) summarizing what the agent will do
- Provide clear, self-contained task instructions
- The agent's outputs should generally be trusted
- The agent runs synchronously - it returns a single result message
- **Delegate entire sub-agent tasks**: Describe the final goal in the prompt and let the sub-agent handle everything.
- If you have additional requests for the sub-agent, use the **Reply** tool to communicate with it. Otherwise, please wait patiently — the sub-agent will always report its results on its own.
- After creating a sub-agent, you can continue with other tasks. If you depend on the sub-agent's results, you may end the conversation temporarily — do not actively poll the sub-agent for results.

### Reply
## Reply Tool

Sends a message to a target session.

**Available to sub-agents** to communicate results, progress, or responses back to the session that created them.

**Parameters:**
- `message` (string, required): The reply content to send
- `targetSessionId` (string, optional): Target session to receive the message. Defaults to the session that created this agent.

**Usage:**
- After completing your assigned task, use Reply to send the result
- Use Reply to provide progress updates during long-running tasks
- The target session will receive your reply as a message

### AskUserQuestion
## AskUserQuestion Tool

Ask the user a question and get their response. Use this tool when you need input from the user during a task.

**Parameters:**
- `question` (string, required): The question to ask
- `choices` (array, optional): Up to 9 predefined choices for the user to pick from, each `{ label, description? }`

**How to use:**
- Provide a clear question in the "question" field
- Optionally provide choices as an array of { label, description? } objects
- Without choices: user can reply with any text
- With choices: user can pick an option or type free text

**Examples:**
- Ask a yes/no question: `{ question: "Continue with this approach?", choices: [{ label: "Yes" }, { label: "No" }] }`
- Ask for input: `{ question: "What port number should I use?" }`
- Ask with options: `{ question: "Which database?", choices: [{ label: "PostgreSQL" }, { label: "MySQL", description: "Existing project uses MySQL" }] }`

**Important:**
- This tool BLOCKS execution until the user responds
- The user can also type free text even when choices are provided
- Limit choices to 9 or fewer for readability

"#;

/// WebSearch 的 `## Tool Details` 段：只在工具被注入时由 `tool_usage_section`
/// 拼入——联网搜索关闭时两工具不进清单，提示词不得再宣传它们
/// （`docs/features/web-search.md` FR-004、specs/defects/web-search-off-still-usable）。
const WEB_SEARCH_TOOL_DETAILS: &str = r#"### WebSearch
## WebSearch Tool

Search the web for up-to-date information using the DeepSeek Search API.

**Parameters:**
- `query` (string, required): The search query, 1-128 characters. Supports operators: `site:`, `-site:`, `-"..."`, `"..."`, `lang:`, `after:`, `before:`

**Usage:**
- Use this tool when the question needs current information (news, releases, prices, docs changes)
- Results include title, url, snippet and a summary per item; they do NOT include full page content
- `count` (optional, 1-50, default 10) controls how many results to return
- When you need the full text of a specific result, call WebFetch with its url
- An empty result means the search found nothing; refine the query or operators and retry

"#;

/// WebFetch 的 `## Tool Details` 段：注入条件同 `WEB_SEARCH_TOOL_DETAILS`。
const WEB_FETCH_TOOL_DETAILS: &str = r#"### WebFetch
## WebFetch Tool

Fetch a single web page and return its content as Markdown.

**Parameters:**
- `url` (string, required): The http(s) url to fetch. Must include a host and must not carry credentials

**Usage:**
- Use this tool to read the full content of a page found via WebSearch, or any public page
- Prefer WebSearch first, then WebFetch only the promising urls instead of fetching many pages
- The result starts with the page title, followed by the Markdown body

"#;

/// Skill 的 `## Tool Details` 段：恒在且保持最后（分段顺序与拆分前一致）。
const SKILL_TOOL_DETAILS: &str = r#"### Skill
## Skill Tool

Execute a skill (slash command). Available skills are listed in the Environment section above.

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review"), they are referring to a skill. Use this tool to invoke it.

**How to invoke:**
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "commit" - invoke the commit skill
  - skill: "commit", args: "-m 'Fix bug'" - invoke with arguments

**Important:**
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running"#;

/// 提示词预设 ID（对齐 `PromptPreset.ts` 的 `PromptPresetId`）。
///
/// 非法 / 缺省一律回退 `normal`（对齐 `getPromptPreset` / `isPromptPresetId`）。
pub fn normalize_prompt_mode(value: Option<&str>) -> &'static str {
    match value {
        Some("minimal") => "minimal",
        Some("mixed") => "mixed",
        _ => "normal",
    }
}

/// 当前实际生效的预设（对齐 `QueryEngine.getActivePromptPresetId`）。
///
/// `mixed` 在首次 assistant 回复前用 `minimal`，之后切到 `normal`。
pub fn active_preset(prompt_mode: Option<&str>, has_assistant_reply: bool) -> &'static str {
    match normalize_prompt_mode(prompt_mode) {
        "minimal" => "minimal",
        "mixed" => {
            if has_assistant_reply {
                "normal"
            } else {
                "minimal"
            }
        }
        _ => "normal",
    }
}

/// 预设的工具白名单（`None` = 全部工具，对齐 `PromptPreset.toolNames`）。
///
/// `minimal` / `mixed` 只暴露 `Bash` 与 `Edit`（与 `PROMPT_PRESETS` 一致）。
pub fn preset_tool_names(preset: &str) -> Option<[&'static str; 2]> {
    match preset {
        "minimal" | "mixed" => Some(["Bash", "Edit"]),
        _ => None,
    }
}

/// 按预设过滤工具定义（保持 `definitions()` 的原始顺序）。
pub fn filter_tools_by_preset(tools: Vec<Value>, preset: &str) -> Vec<Value> {
    let Some(names) = preset_tool_names(preset) else {
        return tools;
    };
    tools
        .into_iter()
        .filter(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .map(|name| names.contains(&name))
                .unwrap_or(false)
        })
        .collect()
}

/// 预设的核心身份提示词（对齐 `PROMPT_PRESETS[*].corePrompt`）。
fn preset_core_prompt(preset: &str) -> &'static str {
    match preset {
        "minimal" | "mixed" => "You are a helpful software engineer assistant.",
        _ => CORE_PRINCIPLES,
    }
}

/// `normal` 预设的核心身份提示词（对齐 `generateCoreSystemPrompt()`）。
///
/// 供对等测试直接取用，避免测试复制字符串。
#[cfg_attr(not(test), allow(dead_code))]
pub fn core_prompt() -> &'static str {
    CORE_PRINCIPLES
}

/// Master 子代理的 `## Communication` 段（对齐 `AgentTool` 的 `systemPromptPrefix`）。
///
/// 子代理的 system prompt = 主对话同款提示词（按继承的预设组装）+ 本段前缀，
/// 因此这里**不含**核心身份 / 工具说明 / 环境段——那些由预设组装产出。
pub fn sub_agent_communication_section(creator_session_id: &str) -> String {
    format!(
        "## Communication\n\
         You are a sub-agent created by the main conversation. When you complete your task \
         (or need to provide progress updates), use the **Reply** tool to send a message back \
         to the conversation that created you.\n\n\
         Important guidelines:\n\
         - Work autonomously and complete the assigned task\n\
         - Keep the conversation that created you informed of your progress\n\
         - When done, send a clear summary of what you accomplished using the Reply tool\n\
         - When calling the Reply tool, set `targetSessionId` to `{creator_session_id}` to \
         ensure the reply reaches the correct session"
    )
}

/// 工具说明区块（对齐 `generateToolUsagePrompt`）：
/// `## Tool Usage`（一行一个工具）+ 空行 + `## Tool Details`（逐工具详细用法）。
///
/// WebSearch / WebFetch 的详细段跟随传入清单拼接：联网搜索关闭时两工具不进清单，
/// 对应段也不进 Tool Details——提示词与工具清单必须随同一开关同步收敛，否则模型
/// 仍会照提示词调用清单里不存在的工具（`docs/features/web-search.md` FR-004、
/// specs/defects/web-search-off-still-usable）。
pub fn tool_usage_section(tools: &[Value]) -> String {
    let tool_list = tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(Value::as_str)?;
            let description = tool
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(format!("- **{name}**: {description}"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let present = |name: &str| {
        tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
    };
    let mut details = String::from(TOOL_DETAILS);
    if present("WebSearch") {
        details.push_str(WEB_SEARCH_TOOL_DETAILS);
    }
    if present("WebFetch") {
        details.push_str(WEB_FETCH_TOOL_DETAILS);
    }
    details.push_str(SKILL_TOOL_DETAILS);
    format!("## Tool Usage\n{tool_list}\n\n## Tool Details\n{details}")
}

/// 按预设组装 system prompt（对齐 `assembleSystemPrompt`）。
///
/// `minimal` / `mixed` 的 sections 为空数组：只有核心身份提示词，不含工具说明 /
/// 环境 / AGENTS.md。`normal` 依次渲染三个区块。
pub fn build_system_prompt_with_preset(
    preset: &str,
    cwd: &str,
    tools: &[Value],
) -> Result<String, String> {
    let mut parts: Vec<String> = vec![preset_core_prompt(preset).to_string()];

    if preset == "normal" {
        parts.push(tool_usage_section(tools));

        parts.push(environment_section(cwd)?);

        if let Some(agents_md) = read_agents_md(cwd) {
            // 原样追加，不加标题、不截断
            parts.push(agents_md);
        }
    }

    // 注意：preset 只声明三个区块（工具说明 / 环境 / AGENTS.md），
    // **没有**「当前文件 / 选中行」区块——文件上下文由 `build_raw_api_messages`
    // 以 `[Current File: ...]` 前缀注入用户消息（见 `Query.ts:152-172`）。
    // 因此这里不再追加 `## Current File` / `## Current Selection`，
    // 否则同一份文件上下文会被投递两次，且 system prompt 随用户切换文件而变
    // （提示词缓存前缀失效）。
    Ok(parts.join("\n\n"))
}

/// 组装完整 system prompt（`normal` 预设的便捷入口）。
///
/// `agent_mode` 保留在签名里（调用方按会话解析），但**不进**系统提示：
/// 环境段没有这一行（权限模式由 UI 展示）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn build_system_prompt(cwd: &str, _agent_mode: &str, _metadata: &Value) -> Result<String, String> {
    build_system_prompt_with_preset("normal", cwd, &tools::definitions())
}

/// 环境段（对齐 `generateSystemDynamicPrompt` 的文本与字段）
///
/// 段里的 `git` / `which` / `uname` 都用工具命令那份 PATH
/// （`docs/core/standalone-core.md` 第 3.2 节）：提示词报的可执行文件清单必须与
/// 工具真能跑起来的东西一致，所以 PATH 解析失败时这里一并报错，不降级。
fn environment_section(cwd: &str) -> Result<String, String> {
    let shell = shell_description();
    let mut lines = vec![
        "## Environment".to_string(),
        "You are running in the following environment:".to_string(),
        format!("- **Operating System**: {}", os_description()?),
        format!("- **Shell**: {shell}"),
        format!("- **Working Directory**: {cwd}"),
        format!("- **Git Repository**: {}", git_description(cwd)?),
    ];

    if shell.to_lowercase().contains("git bash") {
        lines.push(String::new());
        lines.push("**Git Bash Path Tips**:".to_string());
        lines.push(
            "- Use forward slashes with drive letters: `cd /e/workspace/project` (maps to E:\\workspace\\project)"
                .to_string(),
        );
        lines.push(format!(
            "- The working directory above uses Git Bash path style (e.g. `{cwd}`)"
        ));
        lines.push("- Drive letters: `/c/` = C:, `/d/` = D:, `/e/` = E:, etc.".to_string());
        lines.push("- Use `pwd` to show current directory path".to_string());
    }

    let commands = available_commands()?;
    if !commands.is_empty() {
        lines.push(String::new());
        lines.push("**Available Commands**:".to_string());
        lines.push(format!("- {}", commands.join(", ")));
    }

    // 可用的 Skill 列表（对齐 `SystemEnvironment.ts` 的 `availableSkills`）：
    // 内置 Skill + `<configDir>/skills/` 与 `<cwd>/<configDir>/skills/` 下的
    // `SKILL.md`，只列 `!isHidden && userInvocable` 的条目。
    let skills_section =
        skills::available_skills_section(&skills::get_all_skills(cwd));
    if !skills_section.is_empty() {
        lines.push(String::new());
        lines.push(skills_section);
    }

    Ok(lines.join("\n"))
}

/// 平台名（`os.platform()`）
fn os_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// 系统类型（`os.type()`）
fn os_type() -> &'static str {
    if cfg!(windows) {
        "Windows_NT"
    } else if cfg!(target_os = "macos") {
        "Darwin"
    } else {
        "Linux"
    }
}

/// 系统版本（`os.release()`）：Windows 解析 `cmd /c ver`，其余用 `uname -r`；只探测一次
fn os_release() -> Result<String, String> {
    static OS_RELEASE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    if let Some(cached) = OS_RELEASE.lock().unwrap().clone() {
        return Ok(cached);
    }
    let release = if cfg!(windows) {
        let mut command = std::process::Command::new("cmd");
        command
            .args(["/c", "ver"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::util::hide_console(&mut command);
        crate::shell_env::apply_native(&mut command)?;
        command
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
            .and_then(|text| {
                let start = text.find('[')? + 1;
                let end = text[start..].find(']')? + start;
                Some(parse_windows_release(&text[start..end]))
            })
            .unwrap_or_default()
    } else {
        let mut command = std::process::Command::new("uname");
        command
            .arg("-r")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::util::hide_console(&mut command);
        crate::shell_env::apply_native(&mut command)?;
        command
            .output()
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .unwrap_or_default()
    };
    *OS_RELEASE.lock().unwrap() = Some(release.clone());
    Ok(release)
}

/// 从 `cmd /c ver` 的方括号内容里解析出与 Node `os.release()` 一致的版本号。
///
/// `ver` 的输出是本地化的（英文 `Microsoft Windows [Version 10.0.26200.9457]`、
/// 中文 `... [版本 10.0.26200.9457]`），不能靠 `replace("Version")` 去掉前缀；
/// 只取第一个「数字 + 点」组成的 token，并截到三段（Node 的 `os.release()` 在
/// Windows 上只到 build，不含 UBR 修订号）。
fn parse_windows_release(inner: &str) -> String {
    let version = inner
        .split_whitespace()
        .find(|token| {
            token.chars().next().is_some_and(|ch| ch.is_ascii_digit())
                && token.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
        })
        .map(|token| {
            token
                .split('.')
                .take(3)
                .collect::<Vec<_>>()
                .join(".")
        });
    version.unwrap_or_else(|| inner.trim().to_string())
}

fn os_description() -> Result<String, String> {
    let version = format!("{} {}", os_type(), os_release()?);
    Ok(format!("{} ({})", os_platform(), version.trim()))
}

/// 常见命令是否可用（`where` / `which`），只探测一次（对齐 `detectAvailableCommandsSync`）
fn available_commands() -> Result<Vec<String>, String> {
    static AVAILABLE_COMMANDS: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);
    if let Some(cached) = AVAILABLE_COMMANDS.lock().unwrap().clone() {
        return Ok(cached);
    }
    // 与 `SystemEnvironment.ts` 的 `detectAvailableCommandsSync` 候选表逐项一致
    const CANDIDATES: [&str; 26] = [
        "python3", "python", "node", "npm", "npx", "go", "rustc", "cargo", "java", "javac", "mvn",
        "gradle", "gcc", "g++", "make", "cmake", "php", "ruby", "perl", "dotnet", "deno", "bun",
        "pip", "pip3", "pnpm", "yarn",
    ];
    let which = if cfg!(windows) { "where" } else { "which" };
    let mut found: Vec<String> = Vec::new();
    for candidate in CANDIDATES {
        let mut command = std::process::Command::new(which);
        command
            .arg(candidate)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::util::hide_console(&mut command);
        crate::shell_env::apply_native(&mut command)?;
        if command.status().map(|status| status.success()).unwrap_or(false) {
            found.push(candidate.to_string());
        }
    }
    found.sort();
    *AVAILABLE_COMMANDS.lock().unwrap() = Some(found.clone());
    Ok(found)
}

fn shell_description() -> String {
    // 对齐 `generateSystemDynamicPrompt` 的
    // `shellName ? `${shell} (${shellName})` : shell`：前者是 shell 类型
    // （bash / powershell / cmd），后者是探测到的具体名称（如 `bash (Git Bash)`）。
    let shell = crate::shell::shell();
    format!("{} ({})", shell.kind, shell.name)
}

/// 工作目录 → git 分支描述；按目录缓存，避免每轮都 spawn 一次 git
fn git_description(cwd: &str) -> Result<String, String> {
    {
        let cache = GIT_CACHE.lock().unwrap();
        if let Some(cached) = cache.as_ref().and_then(|map| map.get(cwd)) {
            return Ok(cached.clone());
        }
    }
    let mut command = std::process::Command::new("git");
    command
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(cwd);
    crate::util::hide_console(&mut command);
    crate::shell_env::apply_native(&mut command)?;
    let branch = command
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let description = match branch {
        Some(branch) if !branch.is_empty() => format!("Yes (branch: {branch})"),
        _ => "No".to_string(),
    };
    GIT_CACHE
        .lock()
        .unwrap()
        .get_or_insert_with(std::collections::HashMap::new)
        .insert(cwd.to_string(), description.clone());
    Ok(description)
}

/// 工作目录 → git 状态描述（进程重启后自然失效）
static GIT_CACHE: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> =
    std::sync::Mutex::new(None);

/// 读取工作目录下的 `AGENTS.md`（存在时并入系统提示）
fn read_agents_md(cwd: &str) -> Option<String> {
    // cwd 为空时直接返回 null。
    // 否则 `Path::new("").join("AGENTS.md")` 会退化成进程工作目录下的
    // 相对路径，把无关的 AGENTS.md 注入系统提示。
    if cwd.is_empty() {
        return None;
    }
    let path = std::path::Path::new(cwd).join("AGENTS.md");
    let text = std::fs::read_to_string(path).ok()?;
    // `content.trim()`（JS 空白口径）
    let text = crate::util::js_trim(&text);
    if text.is_empty() {
        None
    } else {
        // 原样返回（已去除首尾空白），不截断
        Some(text.to_string())
    }
}

/// 会话的 agent mode：会话级覆盖优先，其次 `settings.json` 默认值
pub fn agent_mode_of(metadata: &Value) -> String {
    metadata
        .get("context")
        .and_then(|context| context.get("agentMode"))
        .and_then(Value::as_str)
        .or_else(|| metadata.get("agentMode").and_then(Value::as_str))
        .map(|value| value.to_string())
        .unwrap_or_else(config::default_agent_mode)
}

#[cfg(test)]
#[path = "prompt_tests.rs"]
mod tests;

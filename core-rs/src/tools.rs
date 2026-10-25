//! 内置工具：定义、路径展开与执行。
//!
//! 契约锁定部分：工具名、输入 schema 字段、Read 的行号格式、
//! 工具结果上限（前 2K + 后 2K）。搜索类工具复用随 Core 分发的 ripgrep 产物
//! （部署布局里与指纹槽位共享的 `ripgrep/` 目录，见 `ripgrep_path`）。

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::config;
use crate::util;
use crate::web_search;

/// Read 的窗口上限
const READ_MAX_SIZE_BYTES: u64 = 256 * 1024;
const READ_MAX_LINES: usize = 2000;
const READ_MAX_LINE_CHARS: usize = 2000;
const READ_MAX_OUTPUT_BYTES: usize = 50 * 1024;
/// 图片文件上限（15MB，对齐 `Read.ts` 的 `MAX_IMAGE_SIZE_BYTES`）
const READ_MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
/// 工具结果上限：前 2K + 后 2K
pub const TOOL_RESULT_HEAD: usize = 2048;
pub const TOOL_RESULT_TAIL: usize = 2048;
/// 工具结果统一上限
pub const MAX_RESULT_SIZE_CHARS: usize = 4 * 1024;
/// 持久化文件最大大小（对齐 `toolResultStorage.ts` 的 `MAX_PERSISTED_SIZE`，64MB）
const MAX_PERSISTED_SIZE: usize = 64 * 1024 * 1024;
/// 有后台任务完成通知时，当前前台命令至少要已运行这么久才自动转后台
/// （对齐 `Exec.ts` 的 `AUTO_BG_MIN_RUNNING_MS`）
const AUTO_BG_MIN_RUNNING_MS: u64 = 3000;

/// 工具结果裁剪：超过上限时把**完整内容**落盘，返回带「前 2K + 后 2K」预览的
/// `<persisted-output>` 消息；未超过上限时原样返回。
///
/// 对齐 `src/core/tools/RunTools.ts` 的持久化分支与 `toolResultStorage.ts` 的消息格式。
pub fn cap_tool_result(text: &str, session_id: &str, project: &str, tool_name: &str) -> String {
    // 阈值按 JS `.length`（UTF-16 code unit），不是字节数 / 字符数。
    if util::utf16_len(text) <= MAX_RESULT_SIZE_CHARS {
        return text.to_string();
    }
    match persist_large_output(text, session_id, project, tool_name) {
        Ok(filepath) => build_large_tool_result_message(&filepath, text),
        Err(err) => {
            eprintln!("[core] persist large tool output failed: {err}");
            util::clamp_output(text, TOOL_RESULT_HEAD, TOOL_RESULT_TAIL)
        }
    }
}

/// 把完整输出写到 `<projectConversationDir>/tool-results/<sessionId>__<taskId>.txt`。
fn persist_large_output(
    text: &str,
    session_id: &str,
    project: &str,
    tool_name: &str,
) -> Result<String, String> {
    let dir = config::project_conversation_dir(project)?.join("tool-results");
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("mkdir {} failed: {err}", dir.display()))?;
    let task_id = format!("tool-{tool_name}-{}", util::unique_id("").trim_start_matches('_'));
    let filepath = dir.join(format!("{session_id}__{task_id}.txt"));

    // `originalSize = stdout.length`（UTF-16）。
    let total = util::utf16_len(text);
    let content_to_write = if total > MAX_PERSISTED_SIZE {
        let mut truncated: String = util::utf16_take(text, MAX_PERSISTED_SIZE);
        truncated.push_str(&format!(
            "\n... [output truncated to {}MB]",
            MAX_PERSISTED_SIZE / 1024 / 1024
        ));
        truncated
    } else {
        text.to_string()
    };
    std::fs::write(&filepath, content_to_write)
        .map_err(|err| format!("write {} failed: {err}", filepath.display()))?;
    Ok(filepath.to_string_lossy().to_string())
}

/// `<persisted-output>` 预览消息（对齐 `buildLargeToolResultMessage`）。
fn build_large_tool_result_message(filepath: &str, text: &str) -> String {
    let size_kb = (util::utf16_len(text) as f64 / 1024.0).round() as usize;
    let head_k = TOOL_RESULT_HEAD / 1024;
    let tail_k = TOOL_RESULT_TAIL / 1024;
    let preview = util::clamp_output(text, TOOL_RESULT_HEAD, TOOL_RESULT_TAIL);
    format!(
        "<persisted-output>\nOutput too large ({size_kb}KB). Full output saved to: {filepath}\n\n\
         Preview (first {head_k}K + last {tail_k}K):\n{preview}\n</persisted-output>"
    )
}

/// Bash 流式进度。
///
/// `output` 是本次读到的增量（UI 直接追加），`full_output` 是累计输出的
/// 4K 预览（前 2K + 后 2K），规模信息按**完整**输出统计。
#[derive(Clone, Debug)]
pub struct BashProgress {
    pub output: String,
    pub full_output: String,
    pub elapsed_time_seconds: f64,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub timeout_ms: u64,
}

/// 用户问答回调：把已组装好的 `UserChoiceOptions` 发给宿主并阻塞等待应答。
///
/// 返回 `None` 表示请求失败（无订阅者 / 超时 / 会话已关闭）。引擎注入真实实现
/// （走 `CoreRequest.userChoice` 帧），单测可注入桩。
pub type UserChoiceFn = std::sync::Arc<dyn Fn(&Value) -> Option<Value> + Send + Sync>;

/// 手工转后台的循环暂停信号。
///
/// 置位方：前台 Bash 手工转后台成功（`UiEvent.bashBackgroundRequested` →
/// `auto_background_command(manual = true)`）；消费方：查询循环在工具批收尾、
/// 下一轮 LLM 请求发起前（结果照常进上下文，但不再发起下一轮）。
///
/// `source_task` 记录触发暂停的后台任务 id：消费方据此把该任务登记为「已兜底」
/// （`ReminderEntry.fallback_reminded`）——查询收尾的兜底提醒会为满足门槛的运行中任务
/// 补一条 reminder 并拉起新查询，那等于转后台结果自己触发了接续循环，违背暂停语义
/// （`docs/features/background-bash.md` FR-002）。
#[derive(Clone, Default)]
pub struct LoopPauseSignal {
    paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    source_task: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl LoopPauseSignal {
    /// 置暂停标记；`source_task` 是触发暂停的后台任务 id
    pub fn request(&self, source_task: Option<String>) {
        *self.source_task.lock().unwrap() = source_task;
        self.paused.store(true, Ordering::Relaxed);
    }

    /// 取走暂停请求（取走即清除，暂停只生效一次）
    pub fn take(&self) -> bool {
        self.paused.swap(false, Ordering::Relaxed)
    }

    /// 取走触发暂停的后台任务 id（随 `take` 一起消费）
    pub fn take_source_task(&self) -> Option<String> {
        self.source_task.lock().unwrap().take()
    }

    /// 清除残留请求（新用户消息 / 中止时调用；暂停只对「当时那轮查询」有意义）
    pub fn clear(&self) {
        self.paused.store(false, Ordering::Relaxed);
        self.source_task.lock().unwrap().take();
    }
}

// ==================== 手工转后台注册表 ====================

/// 前台 Bash 执行的手工转后台注册表：
/// `tool_use_id -> 请求标记`。`run_bash` spawn 后登记、收尾时注销；
/// `request_manual_background` 置位后由前台等待循环在下一个 30ms 轮询点转入后台。
static MANUAL_BG: Mutex<Vec<(String, std::sync::Arc<std::sync::atomic::AtomicBool>)>> =
    Mutex::new(Vec::new());

fn register_manual_bg(tool_use_id: &str) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    MANUAL_BG
        .lock()
        .unwrap()
        .push((tool_use_id.to_string(), std::sync::Arc::clone(&flag)));
    flag
}

fn unregister_manual_bg(tool_use_id: Option<&str>) {
    let Some(tool_use_id) = tool_use_id else { return };
    let mut registry = MANUAL_BG.lock().unwrap();
    if let Some(position) = registry
        .iter()
        .position(|(id, _)| id == tool_use_id)
    {
        registry.remove(position);
    }
}

/// 该 tool_use_id 是否仍有一台前台执行在跑
/// （供单测等待登记完成）
#[cfg_attr(not(test), allow(dead_code))]
pub fn is_foreground_bash_running(tool_use_id: &str) -> bool {
    MANUAL_BG
        .lock()
        .unwrap()
        .iter()
        .any(|(id, _)| id == tool_use_id)
}

/// 触发手工转后台。不存在匹配的前台执行（命令已结束 / 从未登记）时返回 false，
/// 调用方据此什么都不做（幂等，不过度兜底）。
pub fn request_manual_background(tool_use_id: &str) -> bool {
    let registry = MANUAL_BG.lock().unwrap();
    match registry.iter().find(|(id, _)| id == tool_use_id) {
        Some((_, flag)) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// `Agent` 工具的建会话请求（对齐 `AgentTool.call` 用到的几个入参）
#[derive(Clone, Debug)]
pub struct SubAgentRequest {
    pub creator_session_id: String,
    pub prompt: String,
    /// `input.description || 'Agent: <role>'`（子会话标题）
    pub description: String,
    pub role: String,
    /// 目标工作区代理身份（specs/023）：`None` = 当前策略（本机子代理）；
    /// `Some` = 在目标工作区建子代理会话。
    pub target: Option<String>,
}

/// 子代理工具（`Agent` / `Reply`）的引擎钩子。
///
/// 单测不注入时这两个工具报错（「找不到引擎」）。
pub struct SubAgentHooks {
    /// 建本机子会话 + 起后台查询，返回子会话 id
    pub spawn: std::sync::Arc<dyn Fn(SubAgentRequest) -> Result<String, String> + Send + Sync>,
    /// 建跨工作区子会话（specs/023）：请求宿主在目标工作区创建并返回子会话 id
    pub spawn_remote:
        std::sync::Arc<dyn Fn(SubAgentRequest) -> Result<String, String> + Send + Sync>,
    /// 把回复投递给目标会话：`(target, content, from)`
    pub deliver:
        std::sync::Arc<dyn Fn(&str, &str, &str) -> Result<(), String> + Send + Sync>,
}

/// `Transfer` 的传输请求（specs/028 FR-002）：经
/// `CoreRequest.crossWorkspaceTransferRequested` 交给宿主解析两端并执行。
#[derive(Clone, Debug)]
pub struct TransferRequest {
    pub session_id: String,
    pub source_path: String,
    pub target_path: String,
    /// `None` = 发起会话所属工作区（缺省端）
    pub source_target: Option<String>,
    pub dest_target: Option<String>,
}

/// 传输统计（宿主应答载荷；结果文本由 `run_transfer` 组装）
#[derive(Clone, Debug)]
pub struct TransferSummary {
    pub files: u64,
    pub bytes: u64,
    pub skipped_symlinks: u64,
    pub source_workspace_id: String,
    pub dest_workspace_id: String,
}

/// `Transfer` 的引擎钩子：发 `crossWorkspaceTransferRequested` 给宿主并阻塞等待；
/// 第二参是会话取消标记（切片轮询，命中即提前返回，宿主侧已按 abort 中转取消）。
pub type TransferHook = std::sync::Arc<
    dyn Fn(TransferRequest, &std::sync::atomic::AtomicBool) -> Result<TransferSummary, String>
        + Send
        + Sync,
>;

pub struct ToolContext {
    pub session_id: String,
    pub cwd: String,
    /// 当前工具调用的 tool_use id。
    /// 前台 Bash 用它登记「手工转后台」注册表；缺省（单测 / 未知调用方）时不登记。
    pub tool_use_id: Option<String>,
    /// 流式进度回调（Bash 用）。单测不设置时不上报。
    pub on_progress: Option<std::sync::Arc<dyn Fn(BashProgress) + Send + Sync>>,
    /// 会话取消标记（`abortRequested` 置位）。Bash 在等待子进程时轮询它，
    /// 命中即杀掉子进程并按「被中断」收尾。
    /// 单测不设置时视为「不取消」。
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// 手工转后台的循环暂停信号（`SessionState.pause_loop` 的克隆）。
    /// 前台 Bash 手工转后台成功后置位，查询循环在工具批收尾时消费；
    /// 单测不设置时照常转后台，只是不暂停循环。
    pub pause: Option<LoopPauseSignal>,
    /// 用户问答回调（AskUserQuestion 用）。单测不设置时该工具报错。
    pub user_choice: Option<UserChoiceFn>,
    /// 后台 Bash 任务的引擎钩子（完成通知 / `background` 事实同步）。
    /// 单测不设置时后台任务照常跑，只是不通知引擎。
    pub background: Option<crate::bash_task::Hooks>,
    /// 子代理工具的引擎钩子（`Agent` / `Reply`）。单测不设置时这两个工具报错。
    pub subagent: Option<SubAgentHooks>,
    /// 跨工作区传输钩子（`Transfer`，specs/028）。单测不设置时该工具报错。
    pub transfer: Option<TransferHook>,
}

#[derive(Debug)]
pub enum ToolOutcome {
    Success(String),
    /// 成功，且 tool_result block 需要额外字段。
    ///
    /// `mapToolResultToToolResultBlockParam` 返回的多余键会被原样
    /// 拷进 tool_result block（如 Edit 的 `startLine` / `endLine` / `beforeContent`、
    /// Write 的 `beforeContent`）。这些字段只服务 UI 的 diff 展示与回滚，
    /// **不**参与 4K 裁剪，也**不**进 LLM 请求（见 `engine::NON_LLM_BLOCK_FIELDS`）。
    SuccessWithMeta {
        text: String,
        extra: Map<String, Value>,
    },
    Error(String),
    /// 成功，且 tool_result 的 `content` 是**结构化 block 数组**（当前只有 Read 的图片）。
    ///
    /// 图片以
    /// `[{type:"image", source:{type:"base64", media_type, data}}]` 返回，
    /// 让模型直接看到图片，而不是把 base64 当文本塞进上下文。
    /// 该分支不参与 4K 文本裁剪。
    SuccessBlocks(Value),
    /// 命令执行完成但退出码非零 / 被中断（Bash）。
    ///
    /// UI 的 `toolResult` 状态是 `error`，但 tool_result block
    /// 不带 `is_error`，而是携带真实的 `exit_code`。
    CommandFailed { text: String, exit_code: i32 },
    /// 排队等待期间被中止（specs/005 的 Agent 并发槽位）。
    ///
    /// 排队调用随父会话前台中止而取消——UI `toolResult` 状态
    /// `error`、`exit_code` -1、block `is_canceled: true`，文案与 `RunTools`
    /// 批取消逐字一致（不加 `Error executing` 前缀）。
    Canceled(String),
    /// 成功，且工具额外产出了要注入对话的消息（当前只有 Skill 的 prompt 注入）。
    ///
    /// `toolResult.newMessages` 会在该工具的 tool_result
    /// 消息**之后**逐条 yield 进对话（`{ type: 'user', ..., isMeta: true }`），
    /// 使后续 LLM 调用能读到技能正文。
    SuccessWithMessages {
        text: String,
        new_messages: Vec<Value>,
    },
    /// 成功，且改动了会话 Todo 表（当前只有 `TodoWrite`）。
    ///
    /// engine 在 `emit_tool_outcome` 里据此推送 `todosChanged`——「哪个工具改 Todo」只在
    /// 本模块决定，engine 只负责把它翻译成事件（`docs/features/todo-list.md` FR-002）。
    SuccessWithTodos { text: String, todos: Value },
}

impl ToolOutcome {
    /// tool_result block 的 `is_error`（仅「工具本身失败」为真，非零退出不算）。
    ///
    /// 注意：工具循环并不写 `is_error`，此方法只用于测试与语义判断。
    #[allow(dead_code)]
    pub fn is_error(&self) -> bool {
        matches!(self, ToolOutcome::Error(_))
    }

    /// UI `toolResult` 事件的状态是否为 error
    pub fn is_status_error(&self) -> bool {
        matches!(
            self,
            ToolOutcome::Error(_) | ToolOutcome::CommandFailed { .. } | ToolOutcome::Canceled(_)
        )
    }

    /// tool_result block 的 `exit_code`：成功 0、命令非零退出取真实码、工具失败 -1
    pub fn exit_code(&self) -> i32 {
        match self {
            ToolOutcome::Success(_)
            | ToolOutcome::SuccessWithMeta { .. }
            | ToolOutcome::SuccessBlocks(_)
            | ToolOutcome::SuccessWithTodos { .. }
            | ToolOutcome::SuccessWithMessages { .. } => 0,
            ToolOutcome::Error(_) | ToolOutcome::Canceled(_) => -1,
            ToolOutcome::CommandFailed { exit_code, .. } => *exit_code,
        }
    }

    pub fn text(&self) -> &str {
        match self {
            ToolOutcome::Success(text)
            | ToolOutcome::Error(text)
            | ToolOutcome::Canceled(text)
            | ToolOutcome::CommandFailed { text, .. } => text,
            ToolOutcome::SuccessWithMeta { text, .. } => text,
            ToolOutcome::SuccessWithMessages { text, .. } => text,
            ToolOutcome::SuccessWithTodos { text, .. } => text,
            // 结构化 block 没有文本形态；调用方必须先判 SuccessBlocks（见 engine.rs）
            ToolOutcome::SuccessBlocks(_) => "",
        }
    }

    /// tool_result block 需要额外携带的字段（无则 None）
    pub fn extra(&self) -> Option<&Map<String, Value>> {
        match self {
            ToolOutcome::SuccessWithMeta { extra, .. } => Some(extra),
            _ => None,
        }
    }

    /// 工具额外注入对话的消息（对齐 `toolResult.newMessages`）；无则空
    pub fn new_messages(&self) -> Vec<Value> {
        match self {
            ToolOutcome::SuccessWithMessages { new_messages, .. } => new_messages.clone(),
            _ => Vec::new(),
        }
    }

    /// 本次调用写进会话 Todo 表的新清单（`docs/features/todo-list.md` FR-002）；无则 None
    pub fn todos(&self) -> Option<&Value> {
        match self {
            ToolOutcome::SuccessWithTodos { todos, .. } => Some(todos),
            _ => None,
        }
    }

    /// 结构化 content block（当前只有 Read 的图片）；无则 None
    #[allow(dead_code)]
    pub fn blocks(&self) -> Option<&Value> {
        match self {
            ToolOutcome::SuccessBlocks(value) => Some(value),
            _ => None,
        }
    }
}

// ==================== 工具定义 ====================

/// Bash 工具 `description` 参数的说明文本（与 `src/core/tools/bash/Types.ts` 逐字一致）
const BASH_DESCRIPTION_FIELD: &str = r#"Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements""#;

/// Bash 工具 `run_in_background` 参数的说明文本（与 `Types.ts` 逐字一致）
const BASH_RUN_IN_BACKGROUND_FIELD: &str =
    "设置 true 则在后台运行此命令（不会阻塞后续操作）。后台命令完成后会收到通知，无需主动轮询。";

/// 工具定义（Anthropic 风格：`name` / `description` / `input_schema`）
pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "Bash",
            "description": "Execute Bash shell commands",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "要执行的 shell 命令" },
                    "description": { "type": "string", "description": BASH_DESCRIPTION_FIELD },
                    "cwd": { "type": "string", "description": "工作目录，默认为当前目录" },
                    "run_in_background": { "type": "boolean", "description": BASH_RUN_IN_BACKGROUND_FIELD }
                },
                "required": ["command"]
            }
        }),
        json!({
            "name": "Read",
            "description": "Reads a file from the local filesystem.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The absolute path to the file to read" },
                    "offset": { "type": "number", "description": "The 1-based line number to start reading from (default: 1). 0 is accepted and treated as 1" },
                    "limit": { "type": "number", "description": "The number of lines to read" },
                    "sheet": { "type": "string", "description": "Sheet name to read from Excel file. Defaults to the first sheet if not specified." }
                },
                "required": ["file_path"]
            }
        }),
        json!({
            "name": "Write",
            "description": "Writes content to a file on the local filesystem (creates or overwrites).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The absolute path to the file to write" },
                    "content": { "type": "string", "description": "The content to write to the file" }
                },
                "required": ["file_path", "content"]
            }
        }),
        json!({
            "name": "Edit",
            "description": "Edits a file by replacing exact text matches. Preferred over Write tool for modifying existing files.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file_path": { "type": "string", "description": "The absolute path to the file to edit" },
                    "old_string": { "type": "string", "description": "The exact string to replace" },
                    "new_string": { "type": "string", "description": "The new string to replace it with" },
                    "replace_all": { "type": "boolean", "description": "Replace all occurrences within the search range (default: false)" },
                    "offset": { "type": "number", "description": "The 1-based line number where the search range starts (default: 1)" },
                    "limit": { "type": "number", "description": "The number of lines to search within. If provided, old_string must match entirely within lines offset to offset+limit-1 (1-based); if omitted, searches to the end of the file" }
                },
                "required": ["file_path", "old_string", "new_string"]
            }
        }),
        json!({
            "name": "Grep",
            "description": "Searches for patterns in file contents using ripgrep (rg).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "The regular expression pattern to search for in file contents" },
                    "path": { "type": "string", "description": "File or directory to search in. Defaults to current working directory" },
                    "glob": { "type": "string", "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\")" },
                    "output_mode": { "type": "string", "enum": ["content", "files_with_matches", "count"], "description": "Output mode: \"content\" shows matching lines, \"files_with_matches\" shows file paths, \"count\" shows match counts" },
                    "-B": { "type": "number", "description": "Number of lines to show before each match" },
                    "-A": { "type": "number", "description": "Number of lines to show after each match" },
                    "-C": { "type": "number", "description": "Alias for context" },
                    "context": { "type": "number", "description": "Number of lines to show before and after each match" },
                    "-n": { "type": "boolean", "description": "Show line numbers in output" },
                    "-i": { "type": "boolean", "description": "Case insensitive search" },
                    "type": { "type": "string", "description": "File type to search (js, py, rust, go, java, etc.)" },
                    "head_limit": { "type": "number", "description": "Limit output to first N results. Defaults to 250. Pass 0 for unlimited" },
                    "offset": { "type": "number", "description": "Skip first N results before applying head_limit. Defaults to 0" },
                    "multiline": { "type": "boolean", "description": "Enable multiline mode where . matches newlines" }
                },
                "required": ["pattern"]
            }
        }),
        json!({
            "name": "Glob",
            "description": "Finds files by name pattern or wildcard using ripgrep.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "The glob pattern to match files against" },
                    "path": { "type": "string", "description": "The directory to search in. If not specified, the current working directory will be used" }
                },
                "required": ["pattern"]
            }
        }),
        json!({
            "name": "TodoWrite",
            "description": "Create and manage a structured task list to track progress and organize complex work.",
            // todos 只声明为 array（不展开数组元素）；
            // 元素字段（content / activeForm / status）由运行期校验，见 run_todo_write。
            "input_schema": {
                "type": "object",
                "properties": {
                    "todos": { "type": "array", "description": "The updated todo list" }
                },
                "required": ["todos"]
            }
        }),
        json!({
            "name": "Agent",
            "description": "Create a new sub-agent that runs autonomously in the background.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "The task for the agent to perform" },
                    "description": { "type": "string", "description": "A short (3-5 word) description of the task" },
                    // enum 不展开：agentRole 只声明为 string，
                    // 只产出 string（取值由运行期校验，见 permission::base_check）；
                    // 合法名单见 `SUB_AGENT_ROLES` 与提示词角色表
                    "agentRole": { "type": "string", "description": "The role of the agent to spawn: Master or Explorer" },
                    // specs/023：缺省 = 当前策略（本机子代理）；传入 = 在目标工作区建子代理会话。
                    // 取值是工作区代理身份 `<hostname>:<path>`，由宿主解析。
                    "target": { "type": "string", "description": "Target workspace agent ID (`hostname:path`). Omit to spawn the sub-agent in the current workspace." }
                },
                "required": ["prompt", "agentRole"]
            }
        }),
        json!({
            "name": "Reply",
            "description": "Send a message to a target session.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "description": "The reply message to send back" },
                    "targetSessionId": { "type": "string", "description": "Target session ID to send the message to. If omitted, sends to the session that created this agent." }
                },
                "required": ["message"]
            }
        }),
        // specs/028：跨工作区传输。定义恒定注入所有宿主（FR-005 前缀一致性），
        // 能力位只在 run_transfer 执行时拦截；入参描述不引用模型不可见的记号（FR-006）。
        json!({
            "name": "Transfer",
            "description": "Transfer files or directories between open workspaces, for cross-workspace agent workflows only.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "sourcePath": { "type": "string", "description": "Absolute source path on the source workspace's machine" },
                    "targetPath": { "type": "string", "description": "Absolute target path on the target workspace's machine" },
                    "sourceTarget": { "type": "string", "description": "Source workspace agent ID (`hostname:path`). Omit for the current conversation's workspace" },
                    "destTarget": { "type": "string", "description": "Destination workspace agent ID (`hostname:path`). Omit for the current conversation's workspace" }
                },
                "required": ["sourcePath", "targetPath"]
            }
        }),
        json!({
            "name": "AskUserQuestion",
            "description": "Ask the user one or more questions and wait for their replies.",
            // 形状对齐 dsh：questions[] 每项带 id / question / header? / options? / multi_select?。
            // 元素形状与数量上下限在这里完整写出，运行期校验见 tool_input::check_questions。
            "input_schema": {
                "type": "object",
                "properties": {
                    "questions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 9,
                        "description": "Questions to ask the user (1-9).",
                        "items": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "id": { "type": "string", "description": "Stable id for this question; echoed in the answer." },
                                "question": { "type": "string", "description": "The specific question to ask the user." },
                                "header": { "type": "string", "description": "Optional short heading for the question." },
                                "options": {
                                    "type": "array",
                                    "maxItems": 9,
                                    "description": "Optional choices to show the user. Omit or pass an empty array for a free-text question.",
                                    "items": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "properties": {
                                            "label": { "type": "string", "description": "Short user-facing option label." },
                                            "description": { "type": "string", "description": "One sentence explaining the tradeoff or impact." }
                                        },
                                        "required": ["label"]
                                    }
                                },
                                "multi_select": { "type": "boolean", "description": "Whether the user may select more than one option. Defaults to false." }
                            },
                            "required": ["id", "question"]
                        }
                    }
                },
                "required": ["questions"]
            }
        }),
        json!({
            "name": "WebSearch",
            "description": "Search the web for up-to-date information (DeepSeek Search).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query (1-128 characters). Supports operators like site:, lang:, after:, before: and quoted phrases" },
                    "count": { "type": "number", "description": "Number of results to return (1-50, default 10)" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "WebFetch",
            "description": "Fetch a single web page and return its content as Markdown (DeepSeek Fetch).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The http(s) url to fetch (no credentials in url)" }
                },
                "required": ["url"]
            }
        }),
        // Skill **必须**是最后一项（提示词组装依赖它排除动态 Skill 内容）。
        // 新增工具请插在它前面。
        json!({
            "name": "Skill",
            // 无 `skill` 入参时返回固定文案（**没有**句末句点）
            "description": "Execute a skill (slash command)",
            "input_schema": {
                "type": "object",
                "properties": {
                    "skill": { "type": "string", "description": "The skill name. E.g., \"commit\", \"review\", or \"test\"" },
                    "args": { "type": "string", "description": "Optional arguments for the skill" }
                },
                "required": ["skill"]
            }
        }),
    ]
}

/// `Skill` 工具必须是工具列表的最后一项（模块加载期不变式：
/// 末尾不是 Skill 时直接抛错）。
#[cfg(test)]
pub fn assert_skill_tool_is_last() {
    let tools = definitions();
    let last = tools
        .last()
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str);
    assert_eq!(
        last,
        Some("Skill"),
        "DEFAULT_TOOLS must end with SkillTool (last tool: {last:?})"
    );
}

// ==================== 执行 ====================

pub fn execute(name: &str, input: &Value, ctx: &ToolContext) -> ToolOutcome {
    match name {
        "Bash" => run_bash(input, ctx),
        "Read" => run_read(input, ctx),
        "Write" => run_write(input, ctx),
        "Edit" => run_edit(input, ctx),
        "Grep" => run_grep(input, ctx),
        "Glob" => run_glob(input, ctx),
        "TodoWrite" => run_todo_write(input, &ctx.session_id),
        "Agent" => run_agent(input, ctx),
        "Reply" => run_reply(input, ctx),
        "Transfer" => run_transfer(input, ctx),
        "AskUserQuestion" => run_ask_user_question(input, ctx),
        "WebSearch" => web_search::run_web_search(input),
        "WebFetch" => web_search::run_web_fetch(input),
        "Skill" => run_skill(input, ctx),
        // `Error: Tool "<name>" not found`（不是「执行失败」，不加 `Error executing` 前缀）。
        other => ToolOutcome::Error(format!("Error: Tool \"{other}\" not found")),
    }
}

/// 是否可以与相邻的同类工具**并行**执行（各工具的
/// `isConcurrencySafe`，默认返回 `false`）。
///
/// - `Read` / `Grep` / `Glob`：恒为真（纯读取）；
/// - `Bash`：等同 `isReadOnly(input)`（`bash/Validation.ts::isConcurrencySafe`）；
/// - `Edit` / `Write` / `TodoWrite`：恒为假；
/// - `AskUserQuestion` 未定义该字段 → 走默认的假（要弹确认框，不能并行）；
/// - `Agent` / `Reply`：恒为真（`AgentTool` / `ReplyTool` 都声明 true；`Agent` 的
///   实际执行只是建会话 + 起后台线程，本身不阻塞）。
pub fn is_concurrency_safe(name: &str, input: &Value) -> bool {
    match name {
        "Read" | "Grep" | "Glob" | "Agent" | "Reply" | "WebSearch" | "WebFetch" => true,
        "Bash" => input
            .get("command")
            .and_then(Value::as_str)
            .map(crate::permission::is_read_only_command)
            .unwrap_or(false),
        _ => false,
    }
}

/// 是否是已注册的内置工具（用于区分「工具不存在」与「工具执行失败」两条错误通道）。
///
/// 从 `definitions()` 推导（首次调用后缓存名单）：不手抄第二份名单——新增工具只改
/// `definitions()` 一处，`is_known` 自动跟上，不会出现「definitions 里有、
/// `is_known` 说不认识」的漂移。
pub fn is_known(name: &str) -> bool {
    static KNOWN: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    let known = KNOWN.get_or_init(|| {
        definitions()
            .iter()
            .filter_map(|definition| definition.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect()
    });
    known.iter().any(|known_name| known_name == name)
}

/// 工具的语义校验。
///
/// - Bash（`tools/bash/Validation.ts`）：命令非空 + 长度不超过 10000；
/// - AskUserQuestion（`askuser/AskUserQuestion.ts`）：问题非空（纯空白也算空）；
/// - Skill（`skill/SkillTool.ts`）：`skill` 非空且能在 `cwd` 下解析到（内置 + 文件系统）。
///
/// 返回 `Some(message)` 表示校验失败，调用方应产出
/// `InputValidationError: {message}` 并跳过该工具（不执行）。
pub fn validate_input(name: &str, input: &Value, cwd: &str) -> Option<String> {
    match name {
        "WebSearch" => return web_search::validate_search_input(input).err(),
        "WebFetch" => return web_search::validate_fetch_input(input).err(),
        "Skill" => {
            let trimmed = util::js_trim(
                input.get("skill").and_then(Value::as_str).unwrap_or(""),
            );
            if trimmed.is_empty() {
                return Some(format!("Invalid skill format: {trimmed}"));
            }
            match crate::skills::find_skill(trimmed, cwd) {
                None => return Some(format!("Unknown skill: {trimmed}")),
                // 模型侧开关只在这里拦：`inject_skill_tool_use`（用户 `/name`）不经过本函数
                Some(skill) if !skill.model_invocable => {
                    return Some(format!(
                        "Skill '{trimmed}' cannot be invoked by the model (disable-model-invocation: true)"
                    ));
                }
                Some(_) => {}
            }
        }
        "Bash" => {
            if let Some(command) = input.get("command").and_then(Value::as_str) {
                // 对齐 `input.command.trim().length === 0`（JS trim 口径：含 U+FEFF、
                // 不含 U+0085；用 Rust trim 会把 `"\u{85}"` 误判为空命令）
                if util::js_trim(command).is_empty() {
                    return Some("Command cannot be empty".to_string());
                }
                // 对齐 `input.command.length > 10000`（JS UTF-16 code unit）
                if util::utf16_len(command) > 10_000 {
                    return Some("Command is too long (max 10000 characters)".to_string());
                }
            }
        }
        // specs/028：路径非空语义校验（类型形状由 `parse_input` 的 schema 先行把关）
        "Transfer" => {
            for key in ["sourcePath", "targetPath"] {
                let value = input.get(key).and_then(Value::as_str).unwrap_or("");
                if util::js_trim(value).is_empty() {
                    return Some(format!("{key} must not be empty"));
                }
            }
        }
        "AskUserQuestion" => {
            // schema 已保证 questions 是数组且每项 question 是字符串；这里处理
            // 空串 / 纯空白，以及 id 空串（回复按 id 回传，空 id 无法对应）。
            let Some(questions) = input.get("questions").and_then(Value::as_array) else {
                return Some("Questions cannot be empty".to_string());
            };
            for question in questions {
                let text = question.get("question").and_then(Value::as_str).unwrap_or("");
                if util::js_trim(text).is_empty() {
                    return Some("Question cannot be empty".to_string());
                }
                let id = question.get("id").and_then(Value::as_str).unwrap_or("");
                if util::js_trim(id).is_empty() {
                    return Some("Question id cannot be empty".to_string());
                }
            }
        }
        _ => {}
    }
    None
}

/// 用户主目录（Windows 优先 `USERPROFILE`，其余用 `HOME`）
fn home_dir() -> PathBuf {
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.is_empty() {
            return PathBuf::from(profile);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    PathBuf::from("~")
}

/// 词法规范化：折叠 `.` 与 `..`、去重分隔符（对齐 `path.normalize` 的常见场景）
fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 绝对路径的规范化（对齐 Node `path.normalize`）。
///
/// 与 `normalize_path` 的唯一差别是**保留尾随分隔符**：Node 的
/// `path.normalize('C:\\a\\b\\')` 返回 `C:\a\b\`、`path.normalize('/a/b/')`
/// 返回 `/a/b/`（文档：「Trailing separators are preserved.」）。相对路径走
/// `path.resolve`（不保留尾随分隔符），因此只有绝对路径分支用这个函数。
fn normalize_absolute_path(path: &str) -> PathBuf {
    // `\` 只在 Windows 上是分隔符；POSIX 上是普通字符，不能当尾随分隔符。
    let trailing = path.ends_with('/') || (cfg!(windows) && path.ends_with('\\'));
    with_trailing_separator(normalize_path(Path::new(path)), trailing)
}

/// 需要时给规范化结果补一个尾随分隔符（Node 的 `path.normalize` / `path.join` 语义）。
fn with_trailing_separator(path: PathBuf, trailing: bool) -> PathBuf {
    if !trailing {
        return path;
    }
    let separator = std::path::MAIN_SEPARATOR;
    let mut text = path.to_string_lossy().to_string();
    if !text.ends_with(separator) {
        text.push(separator);
    }
    PathBuf::from(text)
}

/// Windows：Node 视为「当前盘根路径」但没有盘符 / UNC 前缀的路径。
///
/// Node 的 `path.win32.isAbsolute('/tmp/x')` 为真，`path.normalize` 得到 `\tmp\x`；
/// Rust 的 `Path::is_absolute` 只认带盘符 / UNC 前缀的路径，会把这类输入当相对路径
/// 拼上工作目录。返回值是**已折叠前导分隔符**的根路径字符串：
/// - 单个分隔符开头：原样返回（`/tmp/x` / `\tmp\x`）；
/// - 双分隔符及以上：`\\server\share\...` 是合法 UNC，返回 `None`（交给
///   `Path::is_absolute`）；`\\x` / `\\` 这类不完整 UNC 退化成根路径（分隔符折叠成一个）。
#[cfg(windows)]
fn windows_rooted_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if bytes.is_empty() || (bytes[0] != b'/' && bytes[0] != b'\\') {
        return None;
    }
    let mut index = 0;
    while index < bytes.len() && (bytes[index] == b'/' || bytes[index] == b'\\') {
        index += 1;
    }
    if index == 1 {
        return Some(path.to_string());
    }
    // 双分隔符起：Node 把 `\\server\share\...` 当 UNC（交给 `Path::is_absolute`），
    // 而 `\\x` / `\\` 这类不完整 UNC 退化成「当前盘根路径」——分隔符折叠成一个。
    let rest = &path[index..];
    let mut parts = rest
        .split(|ch| ch == '/' || ch == '\\')
        .filter(|part| !part.is_empty());
    parts.next(); // server
    if parts.next().is_some() {
        return None;
    }
    Some(format!("\\{rest}"))
}

#[cfg(windows)]
fn is_windows_rooted(path: &str) -> bool {
    windows_rooted_path(path).is_some()
}

/// Node `path.isAbsolute` 的等价判定。
///
/// Windows 上「单个分隔符开头」的路径（`/tmp/x`）在 Node 里是绝对路径
/// （当前盘根路径），Rust 的 `Path::is_absolute` 认不出来；Glob 的
/// `path.isAbsolute(pattern)` 分支必须用这个判定，否则 `/tmp/*.txt` 这类
/// 模式会被当成相对 glob，两实现搜到不同的文件。
pub fn is_absolute_like_node(path: &str) -> bool {
    if Path::new(path).is_absolute() {
        return true;
    }
    #[cfg(windows)]
    {
        if is_windows_rooted(path) {
            return true;
        }
    }
    false
}

/// Windows：`/mnt/d/xxx` → `D:\xxx`；`/mnt/d` → `D:\`
#[cfg(windows)]
fn wsl_mnt_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    // 用字节比较而不是 `path[..5]`：路径可能含多字节字符，按字节下标切片会 panic
    // （`"你你你"[..5]` 不是字符边界）。
    if bytes.len() < 6 || !bytes[..5].eq_ignore_ascii_case(b"/mnt/") {
        return None;
    }
    let drive = bytes[5] as char;
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    let rest = &path[6..];
    if rest.is_empty() {
        return Some(format!("{}:\\", drive.to_ascii_uppercase()));
    }
    if !rest.starts_with('/') {
        return None;
    }
    Some(format!(
        "{}:\\{}",
        drive.to_ascii_uppercase(),
        rest[1..].replace('/', "\\")
    ))
}

/// Windows：`/c/Users/...` → `c:\Users\...`。
///
/// 与 `expandPath` 的 `/^\/[a-z]\//i` 分支一致：**保留**盘符原始大小写
/// （`path.normalize('c:\\/Users') === 'c:\\Users'`），不做大写化。
/// 只有 WSL 的 `/mnt/d/...` 分支才把盘符大写。
#[cfg(windows)]
fn drive_slash_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'/' || !(bytes[1] as char).is_ascii_alphabetic() || bytes[2] != b'/' {
        return None;
    }
    Some(format!(
        "{}:\\{}",
        bytes[1] as char,
        path[3..].replace('/', "\\")
    ))
}

/// 展开路径（对齐 `src/core/utils/path.ts` 的 `expandPath`）：
/// 空串回退基准目录；支持 `~` / `~/...`；Windows 下支持 WSL `/mnt/d/...` 与 `/c/...`；
/// 相对路径按会话工作目录解析；结果做词法规范化。
pub fn expand_path(cwd: &str, path: &str) -> PathBuf {
    // 对齐 `utils/path.ts` 的 `filePath.trim()`（JS 空白口径）
    let trimmed = crate::util::js_trim(path);
    if trimmed.is_empty() {
        return PathBuf::from(cwd);
    }
    if trimmed == "~" {
        return home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        // 对齐 `path.join(os.homedir(), rest)`：`path.join` 与 `path.normalize` 一样
        // 保留尾随分隔符（`~/sub/` → `<home>/sub/`）。
        let trailing = rest.ends_with('/') || (cfg!(windows) && rest.ends_with('\\'));
        return with_trailing_separator(normalize_path(&home_dir().join(rest)), trailing);
    }
    // Windows 专属展开（WSL `/mnt/d` 与 `/c/` 写法、当前盘根路径）：
    // 必须用 `#[cfg(windows)]` 而不是 `cfg!(windows)`——后者在非 Windows 上也会编译
    // 这段代码，而 `windows_rooted_path` 只在 Windows 下定义。
    #[cfg(windows)]
    {
        if let Some(converted) = wsl_mnt_path(trimmed) {
            return normalize_absolute_path(&converted);
        }
        if let Some(converted) = drive_slash_path(trimmed) {
            return normalize_absolute_path(&converted);
        }
        if let Some(rooted) = windows_rooted_path(trimmed) {
            return normalize_absolute_path(&rooted);
        }
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return normalize_absolute_path(trimmed);
    }
    normalize_path(&Path::new(cwd).join(candidate))
}

fn input_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
}

fn input_u64(input: &Value, key: &str) -> Option<u64> {
    input.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse::<u64>().ok(),
        _ => None,
    })
}

fn input_bool(input: &Value, key: &str) -> Option<bool> {
    input.get(key).and_then(|value| match value {
        Value::Bool(value) => Some(*value),
        Value::String(text) => Some(
            text == "true" || (text != "false" && !crate::util::js_trim(text).is_empty()),
        ),
        _ => None,
    })
}

// ==================== Bash ====================

/// 从单个子命令段提取第一个命令名：
/// 先去掉 `FOO=1` 形式的环境变量前缀，再取第一个空白分隔的词，最后去掉包裹引号。
fn extract_command_name(segment: &str) -> String {
    // 全程用 ECMAScript 空白口径（与 `SleepDetect.extractCommandName` 的
    // `trim()` / `\s` / `split(/\s+/)` 对齐）：Rust 的 `trim` / `is_whitespace`
    // 在 U+0085 与 U+FEFF 上与之相反。
    let mut text = crate::util::js_trim(segment);
    loop {
        // `^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*)\s+`
        let mut chars = text.chars();
        let Some(first) = chars.next() else { break };
        if !(first.is_ascii_alphabetic() || first == '_') {
            break;
        }
        let mut cursor = first.len_utf8();
        let mut valid = true;
        let mut seen_equal = false;
        for ch in chars {
            if ch == '=' {
                seen_equal = true;
                cursor += ch.len_utf8();
                break;
            }
            if ch.is_ascii_alphanumeric() || ch == '_' {
                cursor += ch.len_utf8();
                continue;
            }
            valid = false;
            break;
        }
        if !valid || !seen_equal {
            break;
        }
        // 值：双引号 / 单引号 / 非空白串，随后必须紧跟至少一个空白
        let rest = &text[cursor..];
        let after_value = if let Some(inner) = rest.strip_prefix('"') {
            inner.find('"').map(|offset| offset + 2)
        } else if let Some(inner) = rest.strip_prefix('\'') {
            inner.find('\'').map(|offset| offset + 2)
        } else {
            Some(rest.find(crate::util::is_js_whitespace).unwrap_or(rest.len()))
        };
        let Some(after_value) = after_value else { break };
        let tail = &rest[after_value..];
        let trimmed_tail = tail.trim_start_matches(crate::util::is_js_whitespace);
        if trimmed_tail.len() == tail.len() {
            // 值后面没有空白分隔：不是环境变量前缀
            break;
        }
        text = trimmed_tail;
    }
    let word = text.split(crate::util::is_js_whitespace).next().unwrap_or("");
    // 对齐 JS 的 `replace(/^["']|["']$/g, '')`：首尾各最多去掉**一个**引号
    let mut result = word;
    if let Some(rest) = result.strip_prefix('"').or_else(|| result.strip_prefix('\'')) {
        result = rest;
    }
    if let Some(rest) = result.strip_suffix('"').or_else(|| result.strip_suffix('\'')) {
        result = rest;
    }
    result.to_string()
}

/// 命令是否包含 `sleep` 子命令（按 `;` `&&` `||` `|` 拆分后任一段首词为 `sleep`）。
///
/// 含 `sleep` 的命令**不设前台超时**，
/// 让 `sleep` 自然完成（本阶段无后台任务完成 / 子代理 Reply
/// 通知的自动转后台通道）。
/// 兜底提醒的门槛判定（`bash_task::qualifies_fallback_reminder`）也复用它。
pub(crate) fn contains_sleep_command(command: &str) -> bool {
    crate::permission::split_by_separators(command)
        .iter()
        .any(|segment| extract_command_name(segment) == "sleep")
}

/// 会话是否已请求中止（`abortRequested` 置位）。
fn cancel_requested(cancel: &Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) -> bool {
    cancel
        .as_ref()
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// 前台超时是否已到（`timeout_ms == 0` 表示不设超时，此时 `deadline` 为 `None`）。
fn deadline_passed(deadline: Option<std::time::Instant>) -> bool {
    deadline
        .map(|deadline| std::time::Instant::now() >= deadline)
        .unwrap_or(false)
}

/// 通知驱动的自动转后台判定：
/// - 普通命令：有后台任务完成、且本命令已运行 ≥ `AUTO_BG_MIN_RUNNING_MS` → 转后台；
/// - sleep 命令（不设前台超时）：本会话的后台任务完成 → **立刻**转后台。
fn should_auto_background(
    timeout_ms: u64,
    session_completed: &std::sync::atomic::AtomicBool,
    bg_completed: &std::sync::atomic::AtomicBool,
    started: std::time::Instant,
) -> bool {
    if timeout_ms == 0 {
        session_completed.load(Ordering::Relaxed)
    } else {
        bg_completed.load(Ordering::Relaxed)
            && started.elapsed().as_millis() as u64 >= AUTO_BG_MIN_RUNNING_MS
    }
}

fn run_bash(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let Some(command) = input_str(input, "command") else {
        return ToolOutcome::Error("Bash: \"command\" is required".to_string());
    };
    // `input.cwd` **原样**交给子进程——相对路径由 OS 按 Core 进程的 cwd 解析
    // （不是会话工作目录），`~` 也不展开；空串是假值，回退会话工作目录。
    let cwd = input_str(input, "cwd")
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| ctx.cwd.clone());
    // 前台超时策略：
    // - 命令含 `sleep` 子命令：不设超时（`SLEEP_NO_TIMEOUT_MS = 0`），让 sleep 自然完成；
    // - 其余命令：默认 60s（`DEFAULT_BASH_TIMEOUT_MS`）。
    // `timeout` 不在对外 schema 里，仅保留内部覆盖（测试用），显式给出时优先。
    let timeout_ms = input_u64(input, "timeout")
        .unwrap_or(if contains_sleep_command(&command) { 0 } else { 60_000 });

    // 后台模式（`run_in_background`）：子进程 detached、stdout/stderr 直接写输出文件，
    // 立刻返回 taskId，完成后经 `ToolContext.background.notify` 注入通知
    // 。
    if js_coerce_bool(input.get("run_in_background")) {
        let description = input_str(input, "description")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| command.clone());
        return match crate::bash_task::spawn_background(
            &command,
            &cwd,
            &description,
            &ctx.session_id,
            ctx.background.clone(),
        ) {
            Ok(task_id) => ToolOutcome::Success(background_result_text(&task_id, "", "", false, None)),
            // spawn / 打开输出文件失败时 stdout 为空、退出码 1，
            // 错误文本走普通拼接路径（`Result.ts` 会再补一行 `Exit code: 1`）。
            Err(error) => ToolOutcome::CommandFailed {
                text: format!("{error}\nExit code: 1"),
                exit_code: 1,
            },
        };
    }

    let shell = crate::shell::shell();
    let mut cmd = Command::new(&shell.path);
    cmd.args(&shell.args)
        .arg(&command)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 工具命令看到的是用户终端里的 PATH，而不是 core 进程继承来的那份
    // （`docs/core/standalone-core.md` 第 3.2 节）。解析失败直接报错，不降级。
    if let Err(error) = crate::shell_env::apply(&mut cmd) {
        return ToolOutcome::Error(format!("Bash: {error}"));
    }
    // 隐藏子进程控制台窗口（否则每次执行命令都会闪一个窗口）
    util::hide_console(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => return ToolOutcome::Error(format!("Bash: spawn failed: {err}")),
    };
    // 进程树终止的根 PID：Windows 上 `bash.exe` 可能是启动器，只杀直接子进程
    // 会让真正的 shell 与命令继续跑（`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
    let pid = child.id();

    // 必须与子进程并发读取 stdout / stderr：否则输出超过管道缓冲区时子进程阻塞在
    // write，父进程又等它退出，双方互等（大输出命令如 `git log` / `ls -R` 会挂到超时）。
    //
    // 同时按块上报 `toolProgress`：
    // 两个流共用一份累计缓冲，`fullOutput` 是它的 4K 预览。
    let started = std::time::Instant::now();
    let full_output = std::sync::Arc::new(std::sync::Mutex::new(PipeSink::default()));
    // 中止 / 超时后置位：读线程据此停止继续上报 `toolProgress`
    // （被杀的子进程可能留下持有管道的孙进程，否则会在本轮结束后继续推事件）。
    let stop_readers = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stdout_handle = child.stdout.take().map(|pipe| {
        let full = std::sync::Arc::clone(&full_output);
        let progress = ctx.on_progress.clone();
        let stop = std::sync::Arc::clone(&stop_readers);
        std::thread::spawn(move || read_pipe(pipe, full, progress, started, timeout_ms, stop))
    });
    let stderr_handle = child.stderr.take().map(|pipe| {
        let full = std::sync::Arc::clone(&full_output);
        let progress = ctx.on_progress.clone();
        let stop = std::sync::Arc::clone(&stop_readers);
        std::thread::spawn(move || read_pipe(pipe, full, progress, started, timeout_ms, stop))
    });

    // 通知驱动的自动转后台：
    // - 普通命令：有后台任务完成、且本命令已运行 ≥ `AUTO_BG_MIN_RUNNING_MS` → 转后台；
    // - sleep 命令：本会话的后台任务完成 → **立刻**转后台（不设最短运行时长），
    //   避免 sleep 阻塞模型处理通知。
    // 子代理 Reply 通道尚未迁入，`watchSleepNotifications` 只接了后台任务完成这一半。
    let bg_completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let session_completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let bg_subscription = crate::bash_task::on_task_completed({
        let any = std::sync::Arc::clone(&bg_completed);
        let mine = std::sync::Arc::clone(&session_completed);
        let session_id = ctx.session_id.clone();
        std::sync::Arc::new(move |task: &crate::bash_task::FinishedTask| {
            any.store(true, Ordering::Relaxed);
            if task.session_id == session_id {
                mine.store(true, Ordering::Relaxed);
            }
        })
    });
    // 子代理 Reply 投递到本会话 → 立刻把当前 sleep 转入后台
    // （对齐 `SleepDetect.watchSleepNotifications` 的 `onAgentReplyDelivered` 那一半）
    let reply_subscription = crate::subagent::on_reply_delivered({
        let mine = std::sync::Arc::clone(&session_completed);
        let session_id = ctx.session_id.clone();
        std::sync::Arc::new(move |target: &str, _from: &str, _message: &str| {
            if target == session_id {
                mine.store(true, Ordering::Relaxed);
            }
        })
    });

    // 手工转后台（`UiEvent.bashBackgroundRequested`，Bash 卡片「转后台」按钮）：
    // spawn 成功后按 tool_use_id 登记请求标记，收尾（完成 / 中止 / 已转后台 /
    // 等待出错）时注销。等待循环轮询它，命中即与自动转后台走同一条路径。
    let manual_bg = ctx.tool_use_id.as_deref().map(register_manual_bg);

    // `timeout` 来自工具输入，可能极大；用 checked_add 避免 Instant 溢出 panic。
    // `timeout_ms == 0` 表示不设超时。
    let deadline = if timeout_ms == 0 {
        None
    } else {
        std::time::Instant::now().checked_add(Duration::from_millis(timeout_ms))
    };
    let cancel = ctx.cancel.clone();
    let mut cancelled = false;
    // 子进程退出不等于管道到达 EOF：孙进程可能继承了管道写端（Windows 上 detached 的常驻
    // 进程就是这样——本二进制 `start` 拉起的 daemon 即一例；此时读线程会一直阻塞在
    // `read`，直到孙进程退出）。因此「等子进程退出」与「等管道 EOF」共用同一套判定：
    // 中止、前台超时、通知驱动转后台都不依赖子进程是否还活着。只在前一阶段判定的话，
    // 一条已经退出的命令会让 abort 与前台超时全部失效
    // 。
    loop {
        let child_exited = match child.try_wait() {
            Ok(status) => status.is_some(),
            Err(err) => {
                crate::bash_task::kill_tree(&mut child, pid);
                crate::bash_task::off_task_completed(bg_subscription);
                crate::subagent::off_reply_delivered(reply_subscription);
                unregister_manual_bg(ctx.tool_use_id.as_deref());
                return ToolOutcome::Error(format!("Bash: wait failed: {err}"));
            }
        };
        let readers_done = stdout_handle
            .as_ref()
            .map(|handle| handle.is_finished())
            .unwrap_or(true)
            && stderr_handle
                .as_ref()
                .map(|handle| handle.is_finished())
                .unwrap_or(true);
        if child_exited && readers_done {
            break;
        }
        // 会话被中止（`abortRequested`）：按「被中断」收尾
        // 。
        // 子进程还活着就连树一起杀掉（Windows 上 `bash.exe` 可能是启动器，只杀直接
        // 子进程会让真正的 shell 与命令继续跑）；子进程已退出、只是孙进程仍持有管道时，
        // 停掉读线程、用已累积输出收尾——两种情形都要能让 abort 立刻生效。
        if cancel_requested(&cancel) {
            if !child_exited {
                crate::bash_task::kill_tree(&mut child, pid);
            }
            stop_readers.store(true, Ordering::Relaxed);
            cancelled = true;
            break;
        }
        let manual_requested = manual_bg
            .as_ref()
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false);
        if manual_requested
            || deadline_passed(deadline)
            || should_auto_background(timeout_ms, &session_completed, &bg_completed, started)
        {
            crate::bash_task::off_task_completed(bg_subscription);
            crate::subagent::off_reply_delivered(reply_subscription);
            unregister_manual_bg(ctx.tool_use_id.as_deref());
            return auto_background_command(
                child,
                &command,
                &description_of(input, &command),
                ctx,
                &full_output,
                started,
                manual_requested,
            );
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    crate::bash_task::off_task_completed(bg_subscription);
    crate::subagent::off_reply_delivered(reply_subscription);
    unregister_manual_bg(ctx.tool_use_id.as_deref());

    let status = child.wait().ok().and_then(|value| value.code()).unwrap_or(-1);
    // 被中止：**不等**管道读完。被杀的子进程可能留下仍持有管道的孙进程
    // （Windows 上 `bash -c "sleep 30"` 的 `sleep` 就是孙进程），等待会一直阻塞到
    // 孙进程自己退出——abort 会因此「看起来没生效」。这里用已累积的共享输出快照收尾，
    // abort 路径直接用已累积的 `fullOutput` 收尾。
    let (stdout, stderr) = if cancelled {
        (full_output.lock().unwrap().full.clone(), String::new())
    } else {
        let stdout = stdout_handle
            .map(|handle| handle.join().unwrap_or_default())
            .unwrap_or_default();
        let stderr = stderr_handle
            .map(|handle| handle.join().unwrap_or_default())
            .unwrap_or_default();
        (
            String::from_utf8_lossy(&stdout).to_string(),
            String::from_utf8_lossy(&stderr).to_string(),
        )
    };

    // 输出口径：先 trim 出内容（空则 `(无输出)`），
    //   再对被中断的结果追加 `\nCommand was interrupted`。
    //   因此「空输出 + 被中断」的结果是 `(无输出)\nCommand was interrupted`，
    //   而不是把 `Command was interrupted` 单独当内容。
    let mut output = stdout;
    if !stderr.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&stderr);
    }
    if status != 0 && !cancelled {
        output.push_str(&format!("\nExit code: {status}"));
    }
    // `output.trim()`（JS 空白口径）
    let trimmed = crate::util::js_trim(&output);
    let mut content = if trimmed.is_empty() {
        "(无输出)".to_string()
    } else {
        trimmed.to_string()
    };
    if cancelled {
        content.push_str("\nCommand was interrupted");
    }
    // 非零退出 / 中断：UI 状态为 error（但 tool_result 不带 is_error）。
    // 会话中止：退出码 130。
    //
    // 注意：前台命令**不会**因超时被杀——超时会转入后台继续跑（见 `auto_background_command`），
    // 退出码 124 只出现在「转入后台失败」的分支。
    if status != 0 || cancelled {
        ToolOutcome::CommandFailed {
            text: content,
            exit_code: if cancelled { 130 } else { status },
        }
    } else {
        ToolOutcome::Success(content)
    }
}

/// 前台管道的共享汇。
///
/// `full` 是两个流共用的累计输出（`fullOutput` 按到达顺序拼接）；
/// `file` 在「自动转后台」时置位——之后每个块除了进 `full`，还会**原样字节**追加到
/// 输出文件。
///
/// 二者共用同一把锁是刻意的：转入后台时必须「把已累积输出写进文件」与「挂上文件句柄」
/// 原子完成，否则读取线程在两步之间读到的块会既不在文件里、也不在最终结果里。
#[derive(Default)]
struct PipeSink {
    full: String,
    file: Option<std::fs::File>,
}

/// Bash 工具的 `description`（缺省回退命令本身）
fn description_of(input: &Value, command: &str) -> String {
    input_str(input, "description")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| command.to_string())
}

/// 前台命令转入后台继续执行。
///
/// 触发条件：前台预算超时、（sleep / 普通命令的）后台任务完成通知，或用户在
/// Bash 卡片上点「转后台」（`manual = true`，`UiEvent.bashBackgroundRequested`）。
/// 流程：把已累积输出写进输出文件 → 把文件句柄挂到共享汇（后续输出直接进文件）→
/// 登记为后台任务 → 把子进程交给等待线程 → 立即返回「已转入后台」的结果。
///
/// 返回结果的 `stdout` 是转入后台前已累积的输出，`stderr` 是给模型的说明
/// （由 `background_result_text` 拼进 tool_result）。
///
/// 手工转后台成功时置 `ctx.pause`（下一轮 LLM 请求不发起）；转换失败走早退分支，
/// 不置暂停。查询收尾的兜底提醒不会为该任务立刻补 reminder（任务刚注册，距上次
/// 访问不足最小间隔，见 `docs/features/background-bash.md` 第 4 节）。
fn auto_background_command(
    child: std::process::Child,
    command: &str,
    description: &str,
    ctx: &ToolContext,
    sink: &std::sync::Arc<std::sync::Mutex<PipeSink>>,
    started: std::time::Instant,
    manual: bool,
) -> ToolOutcome {
    use std::io::Write;

    let elapsed = started.elapsed().as_millis() as u64;
    let task_id = crate::bash_task::generate_auto_task_id();
    let path = crate::bash_task::task_output_path(&task_id);

    // 打开输出文件失败：杀掉子进程按「超时失败」收尾
    let mut file = match path
        .parent()
        .map(std::fs::create_dir_all)
        .unwrap_or(Ok(()))
        .map_err(|err| err.to_string())
        .and_then(|_| std::fs::File::create(&path).map_err(|err| err.to_string()))
    {
        Ok(file) => file,
        Err(error) => {
            let mut child = child;
            // 与中止同口径：连树一起杀，避免启动器模式下命令继续跑
            let pid = child.id();
            crate::bash_task::kill_tree(&mut child, pid);
            let stdout = sink.lock().unwrap().full.clone();
            let stderr = format!(
                "Command timed out after {elapsed}ms, and failed to open output file for \
                 auto-background: {error}"
            );
            return ToolOutcome::CommandFailed {
                text: join_stdout_stderr(&stdout, &stderr),
                exit_code: 124,
            };
        }
    };

    // 已累积输出先落文件，再原子地挂上文件句柄
    let (stdout, pid) = {
        let mut sink = sink.lock().unwrap();
        let _ = file.write_all(sink.full.as_bytes());
        let _ = file.flush();
        sink.file = Some(file);
        (sink.full.clone(), child.id())
    };

    let kill = crate::bash_task::register_running(
        &task_id,
        description,
        command,
        &ctx.session_id,
        pid,
        ctx.background.clone(),
    );
    crate::bash_task::watch_backgrounded(child, task_id.clone(), kill, ctx.background.clone());

    // 手工转后台成功：置循环暂停信号（工具结果照常进上下文，下一轮 LLM 请求
    // 不发起）。`source_task` 随暂停信号带给消费方，由它把该任务登记为「已兜底」：
    // 消费收尾的兜底提醒不再为它立刻补 reminder。
    if manual {
        if let Some(pause) = &ctx.pause {
            pause.request(Some(task_id.clone()));
        }
    }

    // `find` 提示（命令里出现 `find` 时提醒模型重新读需求）。
    // 已累积的输出（含命令自身的 stderr）都在 `stdout` 里，这里只回传提示；
    // 「已转入后台」的说明由 `background_result_text` 拼一次。
    let reminder = if contains_find_word(command) {
        "[reminder] The command contains `find` and took longer than expected. Try re-reading \
         the user's request carefully — there is usually a clue about the exact file path or \
         pattern to use, which can help narrow the search scope."
    } else {
        ""
    };

    ToolOutcome::Success(background_result_text(
        &task_id,
        &stdout,
        reminder,
        true,
        Some(elapsed),
    ))
}

/// JS `stdout || ''` + `if (stderr) output += (output ? '\n' : '') + stderr`
/// （对齐 `tools/bash/Result.ts` 的拼接口径）
fn join_stdout_stderr(stdout: &str, stderr: &str) -> String {
    let mut output = stdout.to_string();
    if !stderr.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(stderr);
    }
    output
}

/// JS `/\bfind\b/.test(command)`（`\b` 是 ASCII 词边界）
fn contains_find_word(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut index = 0;
    while let Some(found) = command[index..].find("find") {
        let start = index + found;
        let end = start + 4;
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        index = start + 1;
    }
    false
}

/// JS `\w` 的 ASCII 子集（`[A-Za-z0-9_]`）
fn is_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// JS `Boolean(value)`（对齐 zod 的 `z.coerce.boolean()`）：只有 `false` / `0` /
/// `""` / `null` / `undefined` / `NaN` 为假，其余（含字符串 `"false"`）为真。
fn js_coerce_bool(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// 后台命令的 tool_result 文案（对齐 `tools/bash/Result.ts` 的 `backgroundTaskId` 分支）。
///
/// - `stdout` 是「转入后台前已累积的输出」：必须拼在提示**之前**，否则 Bash 卡片会从
///   流式阶段的高度突变为几行文本；
/// - `auto_backgrounded` 为真时用「已自动转入后台」文案（`elapsed_ms` 是转入后台前
///   已在前台运行的时长），并把 `stderr`（命令自身的错误输出 + `find` 提示）附在末尾。
fn background_result_text(
    task_id: &str,
    stdout: &str,
    stderr: &str,
    auto_backgrounded: bool,
    elapsed_ms: Option<u64>,
) -> String {
    let output_path = crate::bash_task::task_output_path(task_id)
        .to_string_lossy()
        .to_string();
    let mut info = if auto_backgrounded {
        // 自动转后台的说明只在这里拼一次：`auto_background_command` 只回传命令自身的
        // stderr 与 `find` 提示，避免 taskId / 完成通知在同一个 tool_result 里出现两遍。
        let elapsed_note = elapsed_ms
            .map(|ms| format!(" after {ms}ms"))
            .unwrap_or_default();
        let reminder_label = crate::bash_task::background_reminder_interval_label(0);
        format!(
            "Command moved to the background{elapsed_note} (task ID: {task_id}). Output is \
             being written to: {output_path}. Do not poll for the result — you will be notified \
             when it completes. If it is still running, you will get a progress reminder in \
             {reminder_label}. Continue with other tasks in the meantime; if there is nothing \
             else to do, end this turn."
        )
    } else {
        let reminder_label = crate::bash_task::background_reminder_interval_label(0);
        format!(
            "Command running in background with ID: {task_id}. Output is being written to: \
             {output_path}. You will be notified automatically when it completes. If it is still \
             running, you will get a progress reminder in {reminder_label}. Continue with other \
             tasks in the meantime."
        )
    };
    if auto_backgrounded && !stderr.is_empty() {
        info.push('\n');
        info.push_str(stderr);
    }
    // JS `(stdout || '').trimEnd()` 后判空：全空白等同于空串
    let partial = util::js_trim_end(stdout);
    if partial.is_empty() {
        info
    } else {
        format!("{partial}\n{info}")
    }
}

/// 逐块读一个子进程管道：累积到 `full`（stdout / stderr 共用，保证 `fullOutput`
/// 是「按到达顺序拼接」的完整输出），并按块回调进度。
///
/// 返回值是该管道自己的完整字节（最终结果仍按 stdout / stderr 分开拼接）。
/// `stop` 置位后立即停止读取（中止 / 超时收尾），不再上报进度。
fn read_pipe(
    mut pipe: impl Read,
    full: std::sync::Arc<std::sync::Mutex<PipeSink>>,
    progress: Option<std::sync::Arc<dyn Fn(BashProgress) + Send + Sync>>,
    started: std::time::Instant,
    timeout_ms: u64,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Vec<u8> {
    use std::io::Write;

    let mut collected: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                collected.extend_from_slice(&buffer[..size]);
                let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                let snapshot = {
                    let mut full = full.lock().unwrap();
                    full.full.push_str(&chunk);
                    // 已转入后台：原始字节追加到输出文件（不经过 lossy 解码，
                    // 等价于直接写 `data` Buffer）
                    if let Some(file) = full.file.as_mut() {
                        let _ = file.write_all(&buffer[..size]);
                        let _ = file.flush();
                    }
                    full.full.clone()
                };
                // 中止 / 超时置位时，已在途的 `read` 仍会返回数据：字节照常计入快照
                // （中断结果用 `fullOutput` 收尾），但**不再上报进度**——工具结果已经
                // 发出，迟到的 `toolProgress` 会让 UI 把已结束的卡片当成还在执行
                // （`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(callback) = &progress {
                    callback(BashProgress {
                        output: chunk,
                        full_output: util::clamp_output(
                            &snapshot,
                            TOOL_RESULT_HEAD,
                            TOOL_RESULT_TAIL,
                        ),
                        elapsed_time_seconds: started.elapsed().as_secs_f64(),
                        total_lines: snapshot.split('\n').count(),
                        // `totalBytes: fullOutput.length`（UTF-16）
                        total_bytes: util::utf16_len(&snapshot),
                        timeout_ms,
                    });
                }
            }
        }
    }
    collected
}

// ==================== Agent / Reply ====================

/// `Agent` 工具：建子代理会话并把结果立刻交回 LLM（对齐 `AgentTool.call`）。
///
/// 真正的工作在引擎侧的后台线程里（`engine::run_sub_agent`）：跑消费循环 →
/// 检查是否调用过 `Reply` → 必要时注入 Reminder 重试。
/// 排队等待期间被中止的工具结果文案
const CANCEL_RESULT_MESSAGE: &str = "Tool was canceled due to abort";

// ==================== 子代理角色注册表（specs/020） ====================

/// 合法子代理角色（单一落点，specs/020 FR-001）：Agent 工具的执行侧校验、
/// 入参枚举（`tool_input::agent_fields`）、权限 deny 文案（`permission::base_check`）、
/// 系统提示词角色表（`prompt`）都从这里推导，禁止再各自写死名单。
pub const SUB_AGENT_ROLES: &[&str] = &["Master", "Explorer"];

/// 角色的 LLM 工具白名单；`None` = 不限（Master 与普通会话同款全量工具）。
///
/// 白名单含 `Reply`：子代理完成判定与 Reminder 都以「调用过 Reply」为基准
/// （`engine.rs` 的 `sub_agent_has_reply`），Reply 是生命周期设施，不是工作工具。
/// 非 Master 角色由引擎按白名单过滤工具清单（FR-002），并固定 normal 预设 /
/// 不联网 / 无 MCP（FR-003）——工具集在会话创建时由角色一次确定，生命周期不变。
pub fn sub_agent_role_tools(role: &str) -> Option<&'static [&'static str]> {
    match role {
        // TodoWrite 也放行：Explorer 的找文件 / 读代码链路长，清单让它能自报进度
        // （`docs/features/todo-list.md` FR-005）。
        "Explorer" => Some(&["Read", "Glob", "Grep", "Reply", "TodoWrite"]),
        _ => None,
    }
}

/// `Agent` 工具：创建子代理。
fn run_agent(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let Some(prompt) = input.get("prompt").and_then(Value::as_str) else {
        return ToolOutcome::Error("prompt is required and must be a string".to_string());
    };
    let role = input
        .get("agentRole")
        .and_then(Value::as_str)
        .unwrap_or("");
    // 对齐 `isValidRole`：合法名单见 `SUB_AGENT_ROLES`
    if !SUB_AGENT_ROLES.contains(&role) {
        return ToolOutcome::Error(format!(
            "agentRole is required and must be one of: {}. Got: {role}",
            SUB_AGENT_ROLES.join(", ")
        ));
    }
    let Some(hooks) = ctx.subagent.as_ref() else {
        return ToolOutcome::Error("Agent: no sub-agent runtime available".to_string());
    };
    // `target`（specs/023）：缺省沿用当前策略；空串是入参错误，不静默当缺省。
    let target = match input.get("target") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => {
            return ToolOutcome::Error("target must not be empty".to_string())
        }
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => return ToolOutcome::Error("target must be a string".to_string()),
    };
    if target.is_some() && !crate::config::cross_workspace_agent() {
        return ToolOutcome::Error(
            "current host does not support cross-workspace agents".to_string(),
        );
    }
    // 对齐 `input.description || (agentRole ? \`Agent: ${agentRole}\` : 'Sub-agent task')`
    let description = input
        .get("description")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Agent: {role}"));

    // specs/005：并发槽位——建子代理前先取槽位；同父会话并行子代理超过
    // SUBAGENT_CONCURRENCY_LIMIT 时在本调用内排队（FIFO），等待期间随父会话
    // 取消标记退出（文案逐字锁定），不建子代理会话。
    // `ctx.cancel` 缺省（单测 / 未知调用方）时视为不取消。
    let cancel_never = std::sync::atomic::AtomicBool::new(false);
    let cancel = ctx.cancel.as_deref().unwrap_or(&cancel_never);
    if !crate::subagent::acquire_slot(&ctx.session_id, cancel) {
        return ToolOutcome::Canceled(CANCEL_RESULT_MESSAGE.to_string());
    }
    let request = SubAgentRequest {
        creator_session_id: ctx.session_id.clone(),
        prompt: prompt.to_string(),
        description: description.clone(),
        role: role.to_string(),
        target: target.clone(),
    };
    let spawned = match &target {
        Some(_) => (hooks.spawn_remote)(request),
        None => (hooks.spawn)(request),
    };
    match spawned {
        Ok(sub_session_id) => {
            let workspace_line = match &target {
                Some(target) => format!("**Workspace**: `{target}`\n"),
                None => String::new(),
            };
            let text = format!(
                "✓ Agent [{role}] created\n\n\
                 Sub-agent created with ID: {sub_session_id}. Task: {description}\n\n\
                 **Sub-agent ID**: `{sub_session_id}`\n\
                 {workspace_line}\
                 The sub-agent will reply directly when done."
            );
            // specs/028 FR-006：跨工作区派发后注入 Transfer 详细 Usage reminder
            // （isMeta silent 消息，正文复用公共变量、对端 = 本次目标身份）；
            // 本机派发不注入。
            match &target {
                Some(target) => ToolOutcome::SuccessWithMessages {
                    text,
                    new_messages: vec![json!({
                        "type": "user",
                        "message": {
                            "role": "user",
                            "content": crate::prompt::transfer_reminder(target),
                        },
                        "uuid": format!("transfer_reminder_{}", crate::util::now_millis()),
                        "timestamp": crate::util::now_millis(),
                        "isMeta": true,
                    })],
                },
                None => ToolOutcome::Success(text),
            }
        }
        // `call()` 抛错：由引擎补 `Error executing Agent: ` 前缀（对齐 `executeSingleTool`）。
        // spawn 失败时后台任务不会启动，槽位必须在此归还
        Err(error) => {
            crate::subagent::release_slot(&ctx.session_id);
            ToolOutcome::Error(error)
        }
    }
}

/// `Reply` 工具：把子代理的回复投递给目标会话（对齐 `ReplyTool.call`）。
fn run_reply(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let message = match input.get("message").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return reply_failure("Reply 工具需要提供一个有效的 message 字符串参数"),
    };
    let sub_agent_id = ctx.session_id.clone();
    let explicit = input
        .get("targetSessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != "current_session");

    // 目标解析顺序（对齐 ReplyTool）：显式 targetSessionId → 注册表里的创建者
    // → 引擎的 upstreamSessionId（Rust 侧由 `parent_session_id` 承担同一角色）。
    let target_id = match explicit {
        Some(target) => target.to_string(),
        None => {
            if sub_agent_id.is_empty() {
                return reply_failure(
                    "当前 session 未设置 sessionId，且未指定 targetSessionId。请提供 targetSessionId 或确认当前会话有正确的 sessionId",
                );
            }
            match crate::subagent::creator_of(&sub_agent_id) {
                Some(creator) => creator,
                None => {
                    return reply_failure(&format!(
                        "当前会话 {sub_agent_id} 不是子代理且没有上游会话（upstreamSessionId），请通过 targetSessionId 显式指定回复目标"
                    ))
                }
            }
        }
    };

    let Some(hooks) = ctx.subagent.as_ref() else {
        return reply_failure("no sub-agent runtime available");
    };
    match (hooks.deliver)(&target_id, &message, &sub_agent_id) {
        Ok(()) => ToolOutcome::Success(message),
        Err(error) => reply_failure(&format!(
            "目标会话 {target_id} 不存在。如果回复给创建者，请不要设置 targetSessionId 参数，默认会回复到创建者会话。当前 subAgentId={sub_agent_id}（{error}）"
        )),
    }
}

/// `Reply` 失败：tool_result 文案是 `Reply 失败: <err>`、退出码 -1
/// （对齐 `ReplyTool.mapToolResultToToolResultBlockParam`）
fn reply_failure(error: &str) -> ToolOutcome {
    ToolOutcome::CommandFailed {
        text: format!("Reply 失败: {error}"),
        exit_code: -1,
    }
}

// ==================== Transfer（specs/028）====================

/// `Transfer` 工具：跨工作区文件传输。
///
/// Core 只做入参校验、能力位检查与结果文本组装；两端解析守卫与搬运都在宿主
/// （`CoreRequest.crossWorkspaceTransferRequested`，engine 注入的 `TransferHook`）。
/// 取消：钩子在等待宿主期间轮询会话取消标记，命中即按「工具被中止」收尾
/// （FR-007；宿主侧在 abort 中转时已先行取消传输）。
fn run_transfer(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let read_path = |key: &str| -> Result<String, String> {
        match input.get(key) {
            Some(Value::String(value)) if !util::js_trim(value).is_empty() => Ok(value.clone()),
            Some(Value::String(_)) => Err(format!("{key} must not be empty")),
            Some(Value::Null) | None => Err(format!("{key} is required and must be a string")),
            Some(_) => Err(format!("{key} must be a string")),
        }
    };
    let source_path = match read_path("sourcePath") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::Error(error),
    };
    let target_path = match read_path("targetPath") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::Error(error),
    };
    // target 空串与 `Agent.target` 同口径：入参错误，不静默当缺省（FR-001）
    let read_target = |key: &str| -> Result<Option<String>, String> {
        match input.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) if value.is_empty() => {
                Err(format!("{key} must not be empty"))
            }
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(format!("{key} must be a string")),
        }
    };
    let source_target = match read_target("sourceTarget") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::Error(error),
    };
    let dest_target = match read_target("destTarget") {
        Ok(value) => value,
        Err(error) => return ToolOutcome::Error(error),
    };
    // 能力位只作用于执行；定义与提示词恒定注入（FR-005）
    if !crate::config::cross_workspace_transfer() {
        return ToolOutcome::Error(
            "current host does not support cross-workspace transfer".to_string(),
        );
    }
    let Some(hook) = ctx.transfer.as_ref() else {
        return ToolOutcome::Error("Transfer: no transfer runtime available".to_string());
    };
    let cancel_never = std::sync::atomic::AtomicBool::new(false);
    let cancel = ctx.cancel.as_deref().unwrap_or(&cancel_never);
    let request = TransferRequest {
        session_id: ctx.session_id.clone(),
        source_path,
        target_path,
        source_target,
        dest_target,
    };
    match (hook)(request, cancel) {
        Ok(summary) => {
            let skipped = if summary.skipped_symlinks > 0 {
                format!(" (skipped {} symlinks)", summary.skipped_symlinks)
            } else {
                String::new()
            };
            ToolOutcome::Success(format!(
                "✓ Transferred {} files ({}) from `{}` to `{}`{skipped}",
                summary.files,
                format_byte_size(summary.bytes),
                summary.source_workspace_id,
                summary.dest_workspace_id,
            ))
        }
        Err(error) => {
            // 宿主按 abort 中转取消后回 `{ error: "transfer canceled" }`；
            // 此时取消标记已置位，按「工具被中止」收尾（FR-007）
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                ToolOutcome::Canceled(CANCEL_RESULT_MESSAGE.to_string())
            } else {
                ToolOutcome::Error(error)
            }
        }
    }
}

/// 字节数的人类可读形态（结果文本用；B / KB / MB / GB，一位小数）
fn format_byte_size(bytes: u64) -> String {
    const UNIT: f64 = 1024.0;
    let size = bytes as f64;
    if size >= UNIT.powi(3) {
        format!("{:.1} GB", size / UNIT.powi(3))
    } else if size >= UNIT.powi(2) {
        format!("{:.1} MB", size / UNIT.powi(2))
    } else if size >= UNIT {
        format!("{:.1} KB", size / UNIT)
    } else {
        format!("{bytes} B")
    }
}

// ==================== Read ====================

fn is_image_extension(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        _ => None,
    }
}

/// 图片合法性校验。
///
/// Read 按扩展名给图片定 `media_type`，但扩展名不是事实——发给 LLM 的 image
/// content block 一旦不是真图片，provider 会整轮报错。这里补一层「魔数 + 结构
/// 完整性」校验：文件头必须匹配声明的格式，且声明长度 / 结束标记必须自洽。
///
/// 返回 `None` 表示通过，否则是失败原因标识（两侧共享，见
/// 行为对照表 `core-rs/fixtures/imageValidation.json`）。
pub fn image_validation_failure(bytes: &[u8], media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => validate_png(bytes),
        "image/jpeg" => validate_jpeg(bytes),
        "image/gif" => validate_gif(bytes),
        "image/webp" => validate_webp(bytes),
        "image/bmp" => validate_bmp(bytes),
        _ => Some("unsupported"),
    }
}

/// 失败原因标识 -> 工具错误消息里的英文说明（逐字锁定）
fn image_validation_reason_text(reason: &str) -> &'static str {
    match reason {
        "signature" => "file signature does not match the format",
        "truncated" => "declared length exceeds the actual file size",
        "missing-end-marker" => "missing the end-of-image marker",
        "trailing-data" => "extra bytes after the end-of-image marker",
        "malformed" => "malformed image structure",
        _ => "unsupported image type",
    }
}

/// PNG 文件签名（8 字节）
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// PNG 里承载文本注释的块类型（作者 / 生成软件 / 提示词等，与像素无关）
const PNG_TEXT_CHUNK_TYPES: [[u8; 4]; 3] = [*b"tEXt", *b"zTXt", *b"iTXt"];

/// 逐块遍历 PNG（前置：签名已匹配），返回 `(块起点, 块尾后一位, 块类型)` 列表。
///
/// 块格式为「长度(4, BE) + 类型(4) + 数据(length) + CRC(4)」。校验与文本块剥离共用
/// 这一份遍历——「块边界」判断的行为对照表是 `core-rs/fixtures/pngTextChunkStrip.json`。
fn png_chunk_bounds(bytes: &[u8]) -> Result<Vec<(usize, usize, [u8; 4])>, &'static str> {
    let mut chunks = Vec::new();
    let mut offset = PNG_SIGNATURE.len();
    loop {
        // 连块头（长度 + 类型）都不完整：后面不可能再有 IEND
        if offset + 8 > bytes.len() {
            return Err("missing-end-marker");
        }
        let length = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as u64;
        let end = offset as u64 + 12 + length;
        if end > bytes.len() as u64 {
            return Err("truncated");
        }
        let end = end as usize;
        let chunk_type = [
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ];
        if &chunk_type == b"IEND" {
            if length != 0 {
                return Err("malformed");
            }
            if end != bytes.len() {
                return Err("trailing-data");
            }
            chunks.push((offset, end, chunk_type));
            return Ok(chunks);
        }
        chunks.push((offset, end, chunk_type));
        offset = end;
    }
}

/// PNG：签名 + 逐块走到 IEND（块长度自洽、IEND 是最后一块且长度为 0）
fn validate_png(bytes: &[u8]) -> Option<&'static str> {
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Some("signature");
    }
    png_chunk_bounds(bytes).err()
}

/// 剥离 PNG 的文本元数据块（`tEXt` / `zTXt` / `iTXt`），返回发给 LLM 的载荷。
///
/// 这三类块只承载文本注释，对模型看图没有价值，却可能让 base64 载荷膨胀到数百 KB。
/// 整块移除不触碰保留块的字节，因此保留块的 CRC 仍然有效、图片渲染结果不变；块类型
/// 按 ASCII 精确匹配（大小写敏感），与块出现的位置、数量无关；没有可剥离的块时原样
/// 返回输入字节。行为对照表在
/// `core-rs/fixtures/pngTextChunkStrip.json`。
///
/// 前置条件：`bytes` 已通过 [`image_validation_failure`]（结构自洽）。
pub fn strip_png_text_chunks(bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    let chunks = png_chunk_bounds(bytes)?;
    if !chunks
        .iter()
        .any(|(_, _, chunk_type)| PNG_TEXT_CHUNK_TYPES.contains(chunk_type))
    {
        return Ok(bytes.to_vec());
    }

    // 签名不属于任何块，单独保留在最前
    let mut payload = Vec::with_capacity(bytes.len());
    payload.extend_from_slice(&bytes[..PNG_SIGNATURE.len()]);
    for (start, end, chunk_type) in chunks {
        if PNG_TEXT_CHUNK_TYPES.contains(&chunk_type) {
            continue;
        }
        payload.extend_from_slice(&bytes[start..end]);
    }
    Ok(payload)
}

/// JPEG：SOI（FF D8）+ 紧随的标记前缀 FF，且以 EOI（FF D9）收尾
fn validate_jpeg(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[2] != 0xff {
        return Some("signature");
    }
    let end = bytes.len();
    if bytes[end - 2] != 0xff || bytes[end - 1] != 0xd9 {
        return Some("missing-end-marker");
    }
    None
}

/// GIF：GIF87a / GIF89a 头 + 逻辑屏幕描述符 + trailer 0x3B
fn validate_gif(bytes: &[u8]) -> Option<&'static str> {
    if !(bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        return Some("signature");
    }
    // 头之后还有 7 字节逻辑屏幕描述符；不足即结构不完整
    if bytes.len() < 13 {
        return Some("truncated");
    }
    if bytes[bytes.len() - 1] != 0x3b {
        return Some("missing-end-marker");
    }
    None
}

/// WebP：RIFF 容器 + `WEBP` 四字符码，且 RIFF 声明长度与实际文件长度一致
fn validate_webp(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Some("signature");
    }
    // RIFF 的长度字段不含前 8 字节（'RIFF' + 长度本身）
    let declared = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as u64 + 8;
    if declared > bytes.len() as u64 {
        return Some("truncated");
    }
    if declared < bytes.len() as u64 {
        return Some("trailing-data");
    }
    None
}

/// BMP：`BM` 头 + 文件头里声明的文件长度与实际长度一致
fn validate_bmp(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 14 || &bytes[0..2] != b"BM" {
        return Some("signature");
    }
    let declared = u32::from_le_bytes([bytes[2], bytes[3], bytes[4], bytes[5]]) as u64;
    // 文件头本身就有 14 字节，声明比它还短说明结构不合法
    if declared < 14 {
        return Some("malformed");
    }
    if declared > bytes.len() as u64 {
        return Some("truncated");
    }
    if declared < bytes.len() as u64 {
        return Some("trailing-data");
    }
    None
}

/// 文件大小展示（对齐 `limits.ts` 的 `formatFileSize`）
///
/// `toFixed(1)` 走 [`util::js_to_fixed_1`]：`262400 B = 256.25 KB` 必须格式化成
/// `256.3 KB`（Rust 的 `{:.1}` 会给 `256.2`）。
fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{} KB", util::js_to_fixed_1(bytes as f64 / 1024.0))
    } else {
        format!("{} MB", util::js_to_fixed_1(bytes as f64 / (1024.0 * 1024.0)))
    }
}

// ==================== 二进制判定（逐分支移植 `isbinaryfile`） ====================

/// `isbinaryfile` 的扫描窗口
const BINARY_MAX_BYTES: usize = 512;
/// 为 UTF-8 多字节序列预留的额外字节
const BINARY_UTF8_BOUNDARY_RESERVE: usize = 3;

/// 无 BOM 的 UTF-16 探测（对齐 `isbinaryfile` 的 `detectUtf16NoBom`）
fn detect_utf16_no_bom(buffer: &[u8], bytes_read: usize) -> Option<&'static str> {
    if bytes_read < 4 {
        return None;
    }
    let scan = bytes_read.min(BINARY_MAX_BYTES);
    let mut nulls_at_even = 0usize;
    let mut nulls_at_odd = 0usize;
    for (index, byte) in buffer.iter().take(scan).enumerate() {
        if *byte == 0 {
            if index % 2 == 0 {
                nulls_at_even += 1;
            } else {
                nulls_at_odd += 1;
            }
        }
    }
    let total = nulls_at_even + nulls_at_odd;
    if (total as f64) > scan as f64 * 0.3 && (total as f64) < scan as f64 * 0.7 {
        if nulls_at_odd > nulls_at_even * 3 {
            return Some("utf-16le");
        }
        if nulls_at_even > nulls_at_odd * 3 {
            return Some("utf-16be");
        }
    }
    None
}

/// 指定编码下是否为文本（对齐 `isbinaryfile` 的 `isTextWithEncodingHint`；
/// Read 只会在探测到无 BOM 的 UTF-16 时走这里）。
fn is_text_with_encoding_hint(buffer: &[u8], bytes_read: usize, encoding: &str) -> bool {
    let scan = bytes_read.min(BINARY_MAX_BYTES);
    if encoding == "utf-16" || encoding == "utf-16le" || encoding == "utf-16be" {
        let mut index = 0usize;
        while index < scan {
            let byte1 = buffer[index];
            let byte2 = if index + 1 < scan { buffer[index + 1] } else { 0 };
            if encoding == "utf-16le" || encoding == "utf-16" {
                if byte2 == 0
                    && byte1 < 0x20
                    && byte1 != 0x09
                    && byte1 != 0x0A
                    && byte1 != 0x0D
                    && byte1 != 0x00
                {
                    return false;
                }
            }
            if encoding == "utf-16be" || encoding == "utf-16" {
                if byte1 == 0
                    && byte2 < 0x20
                    && byte2 != 0x09
                    && byte2 != 0x0A
                    && byte2 != 0x0D
                    && byte2 != 0x00
                {
                    return false;
                }
            }
            index += 2;
        }
        return true;
    }
    false
}

/// `isbinaryfile` 的 Reader（只保留判定需要的游标语义）
struct BinaryProbeReader<'a> {
    buffer: &'a [u8],
    size: usize,
    offset: usize,
    error: bool,
}

impl<'a> BinaryProbeReader<'a> {
    fn next_byte(&mut self) -> u8 {
        if self.offset == self.size || self.error {
            self.error = true;
            return 0xff;
        }
        let byte = self.buffer[self.offset];
        self.offset += 1;
        byte
    }

    fn skip(&mut self, len: usize) {
        if len > self.size.saturating_sub(self.offset) {
            self.error = true;
            return;
        }
        self.offset += len;
    }

    fn read_var_int(&mut self) -> u32 {
        let mut index = 0u32;
        let mut var_int = 0u32;
        while !self.error {
            let byte = self.next_byte();
            // JS 的 `<<` 取模 32，这里用 wrapping_shl 复刻
            var_int |= ((byte & 0x7f) as u32).wrapping_shl(7 * index);
            if byte & 0x80 == 0 {
                break;
            }
            if index >= 10 {
                self.error = true;
                break;
            }
            index += 1;
        }
        var_int
    }

    fn read_message(&mut self) -> bool {
        let var_int = self.read_var_int();
        match var_int & 0x7 {
            0 => {
                self.read_var_int();
                true
            }
            1 => {
                self.skip(8);
                true
            }
            2 => {
                let len = self.read_var_int() as usize;
                self.skip(len);
                true
            }
            5 => {
                self.skip(4);
                true
            }
            _ => false,
        }
    }
}

/// 看起来像 Google Protobuf 文件（对齐 `isbinaryfile` 的 `isBinaryProto`）
fn is_binary_proto(buffer: &[u8], total_bytes: usize) -> bool {
    let mut reader = BinaryProbeReader {
        buffer,
        size: total_bytes,
        offset: 0,
        error: false,
    };
    let mut messages = 0usize;
    loop {
        if !reader.read_message() && !reader.error {
            return false;
        }
        if reader.error {
            break;
        }
        messages += 1;
    }
    messages > 0
}

/// 二进制判定（逐分支移植 `isbinaryfile` 的 `isBinaryCheck`，只读前 512 字节）。
///
/// 判定项：BOM / `%PDF-` / 无 BOM 的
/// UTF-16 / 可疑字节比例 / protobuf 嗅探。图片分支也在这个判定之内——
/// 扩展名像图片但内容是文本时按文本读。
fn is_binary_content(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let bytes_read = bytes.len().min(BINARY_MAX_BYTES + BINARY_UTF8_BOUNDARY_RESERVE);
    let buffer = &bytes[..bytes_read];
    let total_bytes = bytes_read;
    let scan_bytes = total_bytes.min(BINARY_MAX_BYTES);

    // UTF-8 BOM
    if bytes_read >= 3 && buffer[0] == 0xef && buffer[1] == 0xbb && buffer[2] == 0xbf {
        return false;
    }
    // UTF-32 BOM
    if bytes_read >= 4
        && buffer[0] == 0x00
        && buffer[1] == 0x00
        && buffer[2] == 0xfe
        && buffer[3] == 0xff
    {
        return false;
    }
    // UTF-32 LE BOM
    if bytes_read >= 4
        && buffer[0] == 0xff
        && buffer[1] == 0xfe
        && buffer[2] == 0x00
        && buffer[3] == 0x00
    {
        return false;
    }
    // GB BOM
    if bytes_read >= 4
        && buffer[0] == 0x84
        && buffer[1] == 0x31
        && buffer[2] == 0x95
        && buffer[3] == 0x33
    {
        return false;
    }
    // PDF
    if total_bytes >= 5 && &buffer[..5] == b"%PDF-" {
        return true;
    }
    // UTF-16 BE BOM
    if bytes_read >= 2 && buffer[0] == 0xfe && buffer[1] == 0xff {
        return false;
    }
    // UTF-16 LE BOM
    if bytes_read >= 2 && buffer[0] == 0xff && buffer[1] == 0xfe {
        return false;
    }
    // 无 BOM 的 UTF-16：按探测到的编码校验
    if let Some(encoding) = detect_utf16_no_bom(buffer, bytes_read) {
        return !is_text_with_encoding_hint(buffer, bytes_read, encoding);
    }

    let mut suspicious_bytes = 0usize;
    let mut index = 0usize;
    while index < scan_bytes {
        let byte = buffer[index];
        if byte == 0 {
            return true;
        }
        if (byte < 7 || byte > 14) && (byte < 32 || byte > 127) {
            let continuation = |value: u8| value >= 0x80 && value <= 0xbf;
            if (0xc0..=0xdf).contains(&byte) && index + 1 < total_bytes {
                index += 1;
                if continuation(buffer[index]) {
                    index += 1;
                    continue;
                }
            } else if (0xe0..=0xef).contains(&byte) && index + 2 < total_bytes {
                index += 1;
                if continuation(buffer[index]) && continuation(buffer[index + 1]) {
                    index += 2;
                    continue;
                }
            } else if (0xf0..=0xf7).contains(&byte) && index + 3 < total_bytes {
                index += 1;
                if continuation(buffer[index])
                    && continuation(buffer[index + 1])
                    && continuation(buffer[index + 2])
                {
                    index += 3;
                    continue;
                }
            }
            suspicious_bytes += 1;
            if index >= 32 && suspicious_bytes * 100 / scan_bytes > 10 {
                return true;
            }
        }
        index += 1;
    }
    if suspicious_bytes * 100 / scan_bytes > 10 {
        return true;
    }
    if suspicious_bytes > 1 && is_binary_proto(buffer, scan_bytes) {
        return true;
    }
    false
}

// ==================== Read 窗口与输出格式 ====================

/// `buildBoundedWindow`：maxLines / maxLineLength / maxOutputBytes。
///
/// 返回 `(content, line_count, truncated_by_bytes)`。文本路径与 xlsx 路径共用。
fn build_bounded_window(lines: &[&str]) -> (String, usize, bool) {
    let mut kept: Vec<String> = Vec::new();
    let mut output_bytes = 0usize;
    let mut truncated_by_bytes = false;
    for raw_line in lines {
        if kept.len() >= READ_MAX_LINES {
            break;
        }
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        // 按 JS `.length`（UTF-16 code unit）判定与截断。
        let text = if util::utf16_len(line) > READ_MAX_LINE_CHARS {
            format!(
                "{}... (line truncated to {READ_MAX_LINE_CHARS} chars)",
                util::truncate_chars(line, READ_MAX_LINE_CHARS)
            )
        } else {
            line.to_string()
        };
        // UTF-8 字节数 + 非首行的换行分隔符 1 字节
        let bytes = text.len() + if kept.is_empty() { 0 } else { 1 };
        if output_bytes + bytes > READ_MAX_OUTPUT_BYTES {
            truncated_by_bytes = true;
            break;
        }
        output_bytes += bytes;
        kept.push(text);
    }
    let line_count = kept.len();
    (kept.join("\n"), line_count, truncated_by_bytes)
}

/// `mapToolResultToToolResultBlockParam`：`N|text` 行号 + 续读 footer。
fn format_read_output(
    content: &str,
    start_line: usize,
    line_count: usize,
    total_lines: usize,
    truncated_by_bytes: bool,
) -> String {
    let numbered = content
        .split('\n')
        .enumerate()
        .map(|(index, line)| format!("{}|{line}", start_line + index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let last_shown_line = start_line + line_count;
    let mut result = numbered;
    if line_count > 0 && last_shown_line < total_lines {
        let cap_note = if truncated_by_bytes { "Output capped. " } else { "" };
        result.push_str(&format!(
            "\n({cap_note}Showing lines {}-{last_shown_line} of {total_lines}. Use offset={} to continue.)",
            start_line + 1,
            last_shown_line + 1,
        ));
    }
    result
}

// ==================== xlsx / xlsm ====================

/// xlsx 文件一次最多读取的行数
const XLSX_MAX_LINES: usize = 50;
/// 单列最大宽度（避免极端情况撑爆输出）
const XLSX_MAX_COL_WIDTH: usize = 120;

/// xlsx 读取结果。
///
/// `sheetName` / `sheets` 不进结果结构：
/// UI 渲染与 tool_result 管线都不消费它们，无处承载，故不保留。
struct XlsxReadResult {
    content: String,
    line_count: usize,
    start_line: usize,
    total_lines: usize,
    truncated_by_bytes: bool,
}

/// ECMAScript `Number.prototype.toString()` 口径（ryu-js）。
fn js_number_string(value: f64) -> String {
    let mut buffer = ryu_js::Buffer::new();
    buffer.format(value).to_string()
}

/// f64 → JSON 数字；NaN / ±Infinity 无法表示时退化为 JS `String()` 文本。
fn js_number_value(value: f64) -> Value {
    match serde_json::Number::from_f64(value) {
        Some(number) => Value::Number(number),
        None => Value::String(js_number_string(value)),
    }
}

/// 单元格 → `sheet_to_json({ header: 1, defval: '' })` 的等价 JS 值。
fn xlsx_cell_value(cell: &calamine::Data) -> Value {
    use calamine::Data;
    match cell {
        Data::Empty => Value::String(String::new()),
        Data::String(text) => Value::String(text.clone()),
        Data::Float(value) => js_number_value(*value),
        Data::Int(value) => js_number_value(*value as f64),
        Data::Bool(value) => Value::Bool(*value),
        // 不带 cellDates 读取时 npm 返回日期序列号（数字），`String()` 即序列号文本
        Data::DateTime(value) => js_number_value(value.as_f64()),
        Data::DateTimeIso(text) | Data::DurationIso(text) => Value::String(text.clone()),
        // 观察：npm `sheet_to_json` 对错误单元格返回 ''（等价 defval）
        Data::Error(_) => Value::String(String::new()),
    }
}

/// JS `String(cell ?? '')`
fn js_cell_string(cell: &Value) -> String {
    match cell {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Number(number) => match number.as_f64() {
            Some(value) => js_number_string(value),
            None => number.to_string(),
        },
        Value::Bool(value) => value.to_string(),
        other => util::js_string(other),
    }
}

/// JS `row.every(cell => cell === '' || cell === undefined || cell === null)`
fn is_row_empty(row: &[Value]) -> bool {
    row.iter()
        .all(|cell| cell.is_null() || matches!(cell, Value::String(text) if text.is_empty()))
}

/// JS `getLastNonEmptyColIndex`
fn last_non_empty_col_index(data: &[&Vec<Value>]) -> usize {
    let mut max_col = 0usize;
    for row in data {
        for index in (0..row.len()).rev() {
            if !is_row_empty(std::slice::from_ref(&row[index])) {
                if index > max_col {
                    max_col = index;
                }
                break;
            }
        }
    }
    max_col
}

/// `readXlsxContent` 的格式化部分：过滤空行、去尾部空列、对齐列宽、`Row N:` 文本。
///
/// 返回 `(content, line_count, start_line, total_lines, truncated_by_bytes)`。
fn format_xlsx_data(
    data: &[Vec<Value>],
    offset: Option<u64>,
    limit: Option<u64>,
) -> (String, usize, usize, usize, bool) {
    let non_empty: Vec<&Vec<Value>> = data.iter().filter(|row| !is_row_empty(row)).collect();
    let total_lines = non_empty.len();
    let last_col = last_non_empty_col_index(&non_empty);
    let trimmed: Vec<Vec<Value>> = non_empty
        .iter()
        .map(|row| {
            let end = (last_col + 1).min(row.len());
            row[..end].to_vec()
        })
        .collect();

    // offset 为 1-based 行号（0/1 都映射到第一行）；limit 受 XLSX_MAX_LINES 约束
    let first_line = offset.map(|value| value.saturating_sub(1) as usize).unwrap_or(0);
    let effective_limit = limit
        .map(|value| (value as usize).min(XLSX_MAX_LINES))
        .unwrap_or(XLSX_MAX_LINES);
    let end_line = (first_line + effective_limit).min(total_lines);
    let selected: &[Vec<Value>] = if first_line < total_lines {
        &trimmed[first_line..end_line.max(first_line)]
    } else {
        &[]
    };

    let max_cols = selected.iter().map(Vec::len).max().unwrap_or(0);
    let mut col_widths = vec![0usize; max_cols];
    for col in 0..max_cols {
        let mut max_width = 0usize;
        for row in selected {
            let value = js_cell_string(row.get(col).unwrap_or(&Value::String(String::new())));
            max_width = max_width.max(util::utf16_len(&value));
        }
        col_widths[col] = max_width.min(XLSX_MAX_COL_WIDTH);
    }

    let mut lines: Vec<String> = Vec::with_capacity(selected.len());
    for (index, row) in selected.iter().enumerate() {
        let line_num = first_line + index + 1;
        let cells: Vec<String> = row
            .iter()
            .enumerate()
            .map(|(col, cell)| {
                let value = js_cell_string(cell);
                let width = col_widths.get(col).copied().unwrap_or(0);
                let pad = width.saturating_sub(util::utf16_len(&value));
                format!("{value}{}", " ".repeat(pad))
            })
            .collect();
        lines.push(format!("Row {line_num}: {}", cells.join(" | ")));
    }

    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let (content, line_count, truncated_by_bytes) = build_bounded_window(&refs);
    (content, line_count, first_line, total_lines, truncated_by_bytes)
}

/// 读取 xlsx/xlsm。
fn read_xlsx_content(
    path: &Path,
    offset: Option<u64>,
    limit: Option<u64>,
    sheet_name: Option<&str>,
) -> Result<XlsxReadResult, String> {
    use calamine::{open_workbook_auto, Reader};

    let mut workbook = open_workbook_auto(path).map_err(|err| err.to_string())?;
    let mut all_sheet_names: Vec<String> = workbook.sheet_names();
    all_sheet_names.retain(|name| name != "WpsReserved_CellImgList");

    if all_sheet_names.is_empty() {
        return Ok(XlsxReadResult {
            content: "(Empty workbook - no sheets found)".to_string(),
            line_count: 0,
            start_line: 0,
            total_lines: 0,
            truncated_by_bytes: false,
        });
    }

    let target_sheet = match sheet_name {
        Some(name) if !all_sheet_names.iter().any(|candidate| candidate == name) => {
            return Ok(XlsxReadResult {
                content: format!(
                    "Sheet \"{name}\" not found. Available sheets: {}",
                    all_sheet_names.join(", ")
                ),
                line_count: 0,
                start_line: 0,
                total_lines: 0,
                truncated_by_bytes: false,
            });
        }
        Some(name) => name.to_string(),
        None => all_sheet_names[0].clone(),
    };

    let range = workbook
        .worksheet_range(&target_sheet)
        .map_err(|err| err.to_string())?;
    let data: Vec<Vec<Value>> = range
        .rows()
        .map(|row| row.iter().map(xlsx_cell_value).collect())
        .collect();
    let (content, line_count, start_line, total_lines, truncated_by_bytes) =
        format_xlsx_data(&data, offset, limit);

    Ok(XlsxReadResult {
        content,
        line_count,
        start_line,
        total_lines,
        truncated_by_bytes,
    })
}

fn run_read(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    // 支持 file_path 与 path 两种参数名（空串是假值，会回退到 path）。
    let file_path = input_str(input, "file_path")
        .filter(|value| !value.is_empty())
        .or_else(|| input_str(input, "path").filter(|value| !value.is_empty()));
    let Some(file_path) = file_path else {
        return ToolOutcome::Error("file_path is required and must be a string".to_string());
    };
    let path = expand_path(&ctx.cwd, &file_path);

    let limit = input_u64(input, "limit");
    if let Some(limit) = limit {
        if limit > READ_MAX_LINES as u64 {
            return ToolOutcome::Error(format!(
                "limit must be less than or equal to {READ_MAX_LINES}"
            ));
        }
    }
    let offset = input_u64(input, "offset");
    let media_type = is_image_extension(&path);
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default();
    let is_xlsx = ext == ".xlsx" || ext == ".xlsm";

    // 整文件读取（未传 limit）时先做 256KB 上限检查；xlsx / 图片文件豁免。
    if limit.is_none() && !is_xlsx && media_type.is_none() {
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.is_file() && meta.len() > READ_MAX_SIZE_BYTES {
                return ToolOutcome::Error(format!(
                    "File ({}) exceeds maximum allowed size ({}). Use offset and limit parameters to read specific portions of the file.",
                    format_file_size(meta.len()),
                    format_file_size(READ_MAX_SIZE_BYTES),
                ));
            }
        }
    }

    if !path.exists() {
        return ToolOutcome::Error(format!("File not found: {}", path.display()));
    }

    // `isbinaryfile` 对非普通文件（目录 / 设备等）抛
    // `Path provided was not a file!`。此前直接 `fs::read` 会返回平台相关的
    // 权限 / EISDIR 文案（Windows 是「拒绝访问。(os error 5)」）。
    if !path.is_file() {
        return ToolOutcome::Error("Path provided was not a file!".to_string());
    }

    // xlsx / xlsm：绕过二进制检查与常规文本读取
    if is_xlsx {
        let sheet = input_str(input, "sheet").filter(|value| !value.is_empty());
        return match read_xlsx_content(&path, offset, limit, sheet.as_deref()) {
            Ok(result) => ToolOutcome::Success(format_read_output(
                &result.content,
                result.start_line,
                result.line_count,
                result.total_lines,
                result.truncated_by_bytes,
            )),
            Err(err) => ToolOutcome::Error(err),
        };
    }

    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => return ToolOutcome::Error(format!("Read failed: {err}")),
    };

    if is_binary_content(&bytes) {
        // 只有**内容确实是二进制**的图片才走 image content block；
        // 扩展名像图片但内容是文本时按文本读（图片分支在二进制判定之内）。
        if let Some(media_type) = media_type {
            if bytes.len() as u64 > READ_MAX_IMAGE_BYTES {
                return ToolOutcome::Error(format!(
                    "Image file too large to read: {file_path} ({} bytes, max 15MB)",
                    bytes.len()
                ));
            }
            // 扩展名不是事实：内容与扩展名声明的格式不符时不发 image block，
            // 否则 provider 会因非法图片整轮报错（对照表 `core-rs/fixtures/imageValidation.json`）
            if let Some(reason) = image_validation_failure(&bytes, media_type) {
                return ToolOutcome::Error(format!(
                    "Invalid image file: {file_path}. The content is not a valid {media_type} image ({}).",
                    image_validation_reason_text(reason)
                ));
            }
            // 以 image content block 返回（模型直接看到图片），而不是把 base64 拼成文本。
            // PNG 的文本注释块与像素无关，发送前整块剥离（磁盘文件不动）。
            let payload = if media_type == "image/png" {
                match strip_png_text_chunks(&bytes) {
                    Ok(payload) => payload,
                    // 上方校验已通过，走到这里说明遍历与校验漂移
                    Err(reason) => {
                        return ToolOutcome::Error(format!(
                            "Invalid image file: {file_path}. The content is not a valid {media_type} image ({}).",
                            image_validation_reason_text(reason)
                        ))
                    }
                }
            } else {
                bytes
            };
            return ToolOutcome::SuccessBlocks(json!([{
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": base64_encode(&payload),
                },
            }]));
        }
        return ToolOutcome::Error(format!(
            "Cannot read binary file: {file_path}. This tool only supports text and common image files."
        ));
    }

    // 整体读取后按 `\n` 切分（保留末尾空行），再取 offset/limit 窗口。
    let file_content = String::from_utf8_lossy(&bytes).to_string();
    let lines: Vec<&str> = file_content.split('\n').collect();
    let total_lines = lines.len();
    let first_line = offset.map(|value| value.saturating_sub(1) as usize).unwrap_or(0);
    let end_line = limit
        .map(|value| (first_line + value as usize).min(total_lines))
        .unwrap_or(total_lines);
    let selected: &[&str] = if first_line < total_lines {
        let end = end_line.max(first_line).min(total_lines);
        &lines[first_line..end]
    } else {
        &[]
    };

    let (content, line_count, truncated_by_bytes) = build_bounded_window(selected);
    ToolOutcome::Success(format_read_output(
        &content,
        first_line,
        line_count,
        total_lines,
        truncated_by_bytes,
    ))
}

/// 标准 base64 编码（RFC 4648，带 `=` 补齐）
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ==================== Write ====================

fn run_write(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    // `!file_path` 视为缺参（空串也是假值）
    let Some(file_path) = input_str(input, "file_path").filter(|value| !value.is_empty()) else {
        return ToolOutcome::Error("file_path is required and must be a string".to_string());
    };
    let Some(content) = input.get("content").and_then(Value::as_str) else {
        return ToolOutcome::Error("content is required".to_string());
    };
    let path = expand_path(&ctx.cwd, &file_path);
    let action = if path.exists() { "update" } else { "create" };
    // 写入前的原始内容（文件不存在时为 null），用于 UI 的 diff 展示与回滚
    // 。
    let before_content = std::fs::read_to_string(&path).ok();
    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return ToolOutcome::Error(format!("Write: mkdir failed: {err}"));
        }
    }
    match std::fs::write(&path, content) {
        Ok(()) => {
            // 非 git 工作区内的 md 修改登记（specs/030 FR-004；内部自行判定不满足即返回）
            config::record_md_modification(&ctx.cwd, &path);
            let line_count = content.split('\n').count();
            let bytes_written = content.len();
            let verb = if action == "create" { "Created" } else { "Updated" };
            let mut extra = Map::new();
            extra.insert(
                "beforeContent".to_string(),
                before_content.map(Value::String).unwrap_or(Value::Null),
            );
            ToolOutcome::SuccessWithMeta {
                text: format!(
                    "{verb} file: {file_path}\nLines: {line_count}\nBytes: {bytes_written}"
                ),
                extra,
            }
        }
        Err(err) => ToolOutcome::Error(format!("Write failed: {err}")),
    }
}

// ==================== Edit ====================

/// 把 CRLF 统一成 LF（无 CRLF 时原样返回）
fn normalize_line_endings(text: &str) -> String {
    if text.contains("\r\n") {
        text.replace("\r\n", "\n")
    } else {
        text.to_string()
    }
}

/// 检测文件主换行符是否为 CRLF（CRLF 多于 LF 时为真）
fn uses_crlf(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for index in 0..bytes.len() {
        if bytes[index] == b'\n' {
            if index > 0 && bytes[index - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    crlf > lf
}

/// 按 `\n` 统计行数（空串算 1 行）
fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        1
    } else {
        text.matches('\n').count() + 1
    }
}

/// `replace_all` 入参解析（字符串感知转换）。
///
/// `pub(crate)`：权限阶段的 `Edit` 匹配校验也要用同一口径（见 `edit_match_error`）。
pub(crate) fn resolve_replace_all(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::String(text)) => {
            if text == "false" {
                false
            } else if text == "true" {
                true
            } else {
                !crate::util::js_trim(text).is_empty()
            }
        }
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().map(|value| value != 0.0).unwrap_or(false),
        // JS `Boolean(对象/数组)` 恒为 true（对象字面量也是真值）
        Some(_) => true,
    }
}

/// Edit 的匹配校验（两条
/// 前置错误）：`old_string` 在搜索窗口内找不到、或多处匹配且未 `replace_all` 时，
/// `checkPermissions` 直接 deny（**不弹确认框**，也就不会被 auto / risk 放行）。
///
/// 与 `run_edit` 复用同一套 `normalize_line_endings` / `edit_search_window` 逻辑，
/// 保证「权限阶段拒绝」与「执行阶段报错」的文案、边界完全一致。
pub fn edit_match_error(
    content: &str,
    old_string_raw: &str,
    replace_all: bool,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Option<String> {
    let normalized = normalize_line_endings(content);
    let old_string = normalize_line_endings(old_string_raw);
    let (window_start, window_end) = edit_search_window(&normalized, offset, limit);
    let window = &normalized[window_start..window_end];

    if !window.contains(&old_string) {
        let range_hint = if offset.is_some() || limit.is_some() {
            " within the specified line range"
        } else {
            " in the file"
        };
        return Some(format!(
            "The specified old_string was not found{range_hint}. Please read the file first and use the exact text.\nNote: Read output uses | as separator between line number and content. Make sure NOT to include the line number and the separator | in old_string."
        ));
    }
    let occurrences = if old_string.is_empty() {
        0
    } else {
        window.matches(&old_string).count()
    };
    if !replace_all && occurrences > 1 {
        return Some(format!(
            "The old_string matches {occurrences} locations within the search range. When replace_all is false, old_string must match exactly once. Please include more surrounding context to make old_string unique, or set replace_all to true."
        ));
    }
    None
}

/// `Edit.checkPermissions` 的预览产物。
///
/// 这些字段随 `CoreRequest.toolPermissionRequested` 的 `permResult` 下发：
/// 宿主据此写 tool_use 的 `_meta`（回滚与卡片 diff 用），webview 据此渲染 diff。
pub struct EditPermissionPreview {
    /// 规范化（LF）后的原文件内容
    pub before_content: String,
    /// 还原原始换行符后的编辑结果
    pub after_content: String,
    pub context_before: Vec<String>,
    pub context_after: Vec<String>,
    /// `CRLF` / `LF`
    pub line_endings: &'static str,
    pub start_line: usize,
    pub end_line: usize,
}

/// 上下文行是否有实际内容
fn is_meaningful_context_line(line: &str) -> bool {
    let trimmed = crate::util::js_trim(line);
    !trimmed.is_empty() && trimmed != "undefined"
}

/// 从指定位置向前收集最多 `max_lines` 个有内容的行（对齐 `getContextLinesBefore`）。
///
/// 第一段是匹配所在行里匹配位置**之前**的部分（可能是半个逻辑行），随后逐行向前。
fn get_context_lines_before(content: &str, index: usize, max_lines: usize) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut pos = index;
    while result.len() < max_lines && pos > 0 {
        let line_start = content[..pos].rfind('\n').map_or(0, |idx| idx + 1);
        let line = &content[line_start..pos];
        if is_meaningful_context_line(line) {
            result.push(line.to_string());
        }
        if line_start == 0 {
            break;
        }
        pos = line_start - 1;
    }
    result.reverse();
    result
}

/// 从指定位置向后收集最多 `max_lines` 个有内容的行（对齐 `getContextLinesAfter`）。
fn get_context_lines_after(content: &str, start_index: usize, max_lines: usize) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    let mut pos = start_index.min(content.len());
    while result.len() < max_lines && pos < content.len() {
        let newline_index = content[pos..].find('\n').map(|rel| pos + rel);
        let line_end = newline_index.unwrap_or(content.len());
        let line = &content[pos..line_end];
        if is_meaningful_context_line(line) {
            result.push(line.to_string());
        }
        match newline_index {
            Some(index) => pos = index + 1,
            None => break,
        }
    }
    result
}

/// Edit 的权限预览：
/// 与 `edit_match_error` / `run_edit` 共用同一套匹配、替换、行号口径，只读不写盘。
pub fn edit_permission_preview(
    content: &str,
    old_string_raw: &str,
    new_string_raw: &str,
    replace_all: bool,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<EditPermissionPreview, String> {
    if let Some(message) = edit_match_error(content, old_string_raw, replace_all, offset, limit) {
        return Err(message);
    }
    let normalized = normalize_line_endings(content);
    let old_string = normalize_line_endings(old_string_raw);
    let new_string = normalize_line_endings(new_string_raw);
    let (window_start, window_end) = edit_search_window(&normalized, offset, limit);
    let window = &normalized[window_start..window_end];
    let first_match_local = if old_string.is_empty() {
        0
    } else {
        window.find(&old_string).unwrap_or(0)
    };
    let replaced_window = if old_string.is_empty() {
        if replace_all {
            // JS `searchContent.split('').join(newString)`：在字符之间插入
            let mut joined = String::new();
            for (index, ch) in window.chars().enumerate() {
                if index > 0 {
                    joined.push_str(&new_string);
                }
                joined.push(ch);
            }
            joined
        } else {
            format!("{new_string}{window}")
        }
    } else if replace_all {
        window.replace(&old_string, &new_string)
    } else {
        let index = first_match_local;
        let mut replaced = String::with_capacity(window.len() + new_string.len());
        replaced.push_str(&window[..index]);
        replaced.push_str(&new_string);
        replaced.push_str(&window[index + old_string.len()..]);
        replaced
    };
    let mut new_content = String::with_capacity(normalized.len() + new_string.len());
    new_content.push_str(&normalized[..window_start]);
    new_content.push_str(&replaced_window);
    new_content.push_str(&normalized[window_end..]);

    let first_match_index = window_start + first_match_local;
    let (start_line, end_line) = if old_string.is_empty() {
        let (line, _) = line_range_from_index(&normalized, first_match_index, 0);
        (line, line)
    } else {
        line_range_from_index(&normalized, first_match_index, old_string.len())
    };

    let line_endings = if uses_crlf(content) { "CRLF" } else { "LF" };
    let after_content = if line_endings == "CRLF" {
        new_content.replace('\n', "\r\n")
    } else {
        new_content
    };
    let context_before = get_context_lines_before(&normalized, first_match_index, 4);
    let context_after = get_context_lines_after(
        &normalized,
        first_match_index + old_string.len(),
        4,
    );

    Ok(EditPermissionPreview {
        before_content: normalized,
        after_content,
        context_before,
        context_after,
        line_endings,
        start_line,
        end_line,
    })
}

/// diff 行 token：每行**含**行尾 `\n`，末行无换行时不含
/// （对齐 jsdiff `lineDiff.tokenize` 的 `value.split(/(\n|\r\n)/)` 合并结果）。
///
/// 调用方传入的内容已规范化为 LF，因此这里只需按 `\n` 切。
fn diff_line_tokens(text: &str) -> Vec<&str> {
    if text.is_empty() {
        Vec::new()
    } else {
        text.split_inclusive('\n').collect()
    }
}

/// 两个 token 序列的最长公共子序列长度；超过 `LCS_CELL_LIMIT` 时返回 `None`
/// （调用方回退到按行数近似，避免病态输入把消费线程拖死）。
fn lcs_len(a: &[&str], b: &[&str]) -> Option<usize> {
    let (n, m) = (a.len(), b.len());
    if n == 0 || m == 0 {
        return Some(0);
    }
    if n.saturating_mul(m) > LCS_CELL_LIMIT {
        return None;
    }
    let mut previous = vec![0usize; m + 1];
    let mut current = vec![0usize; m + 1];
    for i in 1..=n {
        current[0] = 0;
        for j in 1..=m {
            current[j] = if a[i - 1] == b[j - 1] {
                previous[j - 1] + 1
            } else {
                previous[j].max(current[j - 1])
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    Some(previous[m])
}

/// LCS DP 的单元数上限（约 4000×4000 行窗口）。
const LCS_CELL_LIMIT: usize = 16_000_000;

/// 按 1-based 行范围截取内容片段。
///
/// 行定义与 diff 库一致：每行包含行尾换行符；文件末尾无换行符时最后一行不含。
fn slice_by_line_range(content: &str, start_line: usize, end_line: usize) -> String {
    let safe_start = start_line.max(1);
    let safe_end = end_line.max(safe_start);
    if content.is_empty() {
        return String::new();
    }
    // 定位 safe_start 行的起始偏移
    let mut line_start = 0usize;
    let mut line = 1usize;
    while line < safe_start {
        match content[line_start..].find('\n') {
            Some(rel) => {
                line_start += rel + 1;
                line += 1;
            }
            None => return String::new(),
        }
    }
    // 定位 safe_end 行的结束偏移（含该行的行尾换行符）
    let mut line_end = line_start;
    let mut current = safe_start;
    while current <= safe_end {
        match content[line_end..].find('\n') {
            Some(rel) => {
                line_end += rel + 1;
                current += 1;
            }
            None => {
                line_end = content.len();
                break;
            }
        }
    }
    content[line_start..line_end].to_string()
}

/// 编辑区域前后各 3 行的上下文窗口（对齐 `diff.ts` 的 `CONTEXT_LINES`）
const DIFF_CONTEXT_LINES: usize = 3;

/// 增删行数（按 diff 的
/// `getPatchFromContents(...) → countLinesChanged(...)`）。
///
/// jsdiff 的 `structuredPatch` 产出**最短编辑脚本**，因此增删行数由最长公共子序列
/// 唯一确定：`additions = newLines - lcs`、`deletions = oldLines - lcs`。
/// 这里复刻同样的窗口切片（编辑区域前后各 3 行）后再做 LCS，
/// 与「按 old_string / new_string 行数 × 替换次数」的近似口径不同。
fn count_lines_changed(
    old_content: &str,
    new_content: &str,
    old_start_line: usize,
    old_end_line: usize,
    new_start_line: usize,
    new_end_line: usize,
    fallback: (usize, usize),
) -> (usize, usize) {
    let old_window = slice_by_line_range(
        old_content,
        old_start_line.saturating_sub(DIFF_CONTEXT_LINES),
        old_end_line + DIFF_CONTEXT_LINES,
    );
    let new_window = slice_by_line_range(
        new_content,
        new_start_line.saturating_sub(DIFF_CONTEXT_LINES),
        new_end_line + DIFF_CONTEXT_LINES,
    );
    if old_window.is_empty() && new_window.is_empty() {
        return (0, 0);
    }
    let old_tokens = diff_line_tokens(&old_window);
    let new_tokens = diff_line_tokens(&new_window);
    match lcs_len(&old_tokens, &new_tokens) {
        Some(lcs) => (new_tokens.len() - lcs, old_tokens.len() - lcs),
        None => fallback,
    }
}

/// Edit 的搜索窗口（字节区间），对齐 `getSearchWindow`
fn edit_search_window(content: &str, offset: Option<u64>, limit: Option<u64>) -> (usize, usize) {
    if offset.is_none() && limit.is_none() {
        return (0, content.len());
    }
    let line_count = count_lines(content);
    let start_line = offset.map(|value| value.saturating_sub(1) as usize).unwrap_or(0);
    let end_line = limit
        .map(|value| start_line + value as usize)
        .unwrap_or(line_count)
        .min(line_count);
    if start_line >= line_count || end_line <= start_line {
        return (content.len(), content.len());
    }
    let mut start_index = 0usize;
    for _ in 0..start_line {
        match content[start_index..].find('\n') {
            Some(rel) => start_index += rel + 1,
            None => {
                start_index = content.len();
                break;
            }
        }
    }
    let mut end_index = content.len();
    if end_line < line_count {
        end_index = start_index;
        for _ in start_line..end_line {
            match content[end_index..].find('\n') {
                Some(rel) => end_index += rel + 1,
                None => {
                    end_index = content.len();
                    break;
                }
            }
        }
    }
    (start_index, end_index)
}

/// 匹配片段所在的 1-based 行范围，对齐 `getLineRangeFromIndex`
fn line_range_from_index(content: &str, start_index: usize, length: usize) -> (usize, usize) {
    let mut start_line = 1usize;
    let mut pos = 0usize;
    while pos < start_index {
        match content[pos..].find('\n') {
            Some(rel) => {
                let newline_index = pos + rel;
                if newline_index >= start_index {
                    break;
                }
                start_line += 1;
                pos = newline_index + 1;
            }
            None => break,
        }
    }
    let end = (start_index + length).min(content.len());
    let mut old_lines = 1usize;
    pos = start_index;
    while pos < end {
        match content[pos..].find('\n') {
            Some(rel) => {
                let newline_index = pos + rel;
                if newline_index >= end {
                    break;
                }
                old_lines += 1;
                pos = newline_index + 1;
            }
            None => break,
        }
    }
    (start_line, start_line + old_lines - 1)
}

fn run_edit(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    // file_path 空串视为缺参（old_string / new_string
    // 允许空串——空 old_string 是「插入」语义）。
    let Some(file_path) = input_str(input, "file_path").filter(|value| !value.is_empty()) else {
        return ToolOutcome::Error("file_path is required and must be a string".to_string());
    };
    let Some(old_string_raw) = input_str(input, "old_string") else {
        return ToolOutcome::Error("old_string is required".to_string());
    };
    let new_string_raw = input_str(input, "new_string").unwrap_or_default();
    // 字符串感知转换，
    // 而不是 Boolean(value)——`Boolean("false") === true` 会让显式传字符串 "false"
    // 的调用变成全量替换。
    let replace_all = resolve_replace_all(input.get("replace_all"));
    let offset = input_u64(input, "offset");
    let limit = input_u64(input, "limit");
    let path = expand_path(&ctx.cwd, &file_path);
    let content = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        // Edit 用 `fs.readFile` 读盘，文件不存在时 Node 抛
        // `ENOENT: no such file or directory, open '<path>'`。此前 Rust 返回
        // 平台相关的 `Edit: read failed: 系统找不到指定的文件。`。
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return ToolOutcome::Error(format!(
                "ENOENT: no such file or directory, open '{}'",
                path.display()
            ))
        }
        Err(err) => return ToolOutcome::Error(format!("Edit: read failed: {err}")),
    };

    // 统一为 LF 后再匹配/替换（CRLF 文件与模型给出的 LF old_string 才能对上），
    // 写盘前还原原始换行风格。
    let crlf = uses_crlf(&content);
    let normalized = normalize_line_endings(&content);
    let old_string = normalize_line_endings(&old_string_raw);
    let new_string = normalize_line_endings(&new_string_raw);

    let (window_start, window_end) = edit_search_window(&normalized, offset, limit);
    let window = &normalized[window_start..window_end];

    if !window.contains(&old_string) {
        let range_hint = if offset.is_some() || limit.is_some() {
            " within the specified line range"
        } else {
            " in the file"
        };
        return ToolOutcome::Error(format!(
            "The specified old_string was not found{range_hint}. Please read the file first and use the exact text.\nNote: Read output uses | as separator between line number and content. Make sure NOT to include the line number and the separator | in old_string."
        ));
    }

    let occurrences = if old_string.is_empty() {
        0
    } else {
        window.matches(&old_string).count()
    };
    if !replace_all && occurrences > 1 {
        return ToolOutcome::Error(format!(
            "The old_string matches {occurrences} locations within the search range. When replace_all is false, old_string must match exactly once. Please include more surrounding context to make old_string unique, or set replace_all to true."
        ));
    }

    let (replaced_window, replacements_made, first_match_local) = if old_string.is_empty() {
        if replace_all {
            // JS `searchContent.split('').join(newString)`：在字符之间插入
            let chars: Vec<char> = window.chars().collect();
            let mut joined = String::new();
            for (index, ch) in chars.iter().enumerate() {
                if index > 0 {
                    joined.push_str(&new_string);
                }
                joined.push(*ch);
            }
            let count = chars.len().saturating_sub(1);
            (joined, count, 0usize)
        } else {
            (format!("{new_string}{window}"), 1usize, 0usize)
        }
    } else if replace_all {
        (
            window.replace(&old_string, &new_string),
            occurrences,
            window.find(&old_string).unwrap_or(0),
        )
    } else {
        let index = window.find(&old_string).unwrap_or(0);
        let mut replaced = String::with_capacity(window.len() + new_string.len());
        replaced.push_str(&window[..index]);
        replaced.push_str(&new_string);
        replaced.push_str(&window[index + old_string.len()..]);
        (replaced, 1usize, index)
    };

    let mut updated = String::with_capacity(normalized.len() + new_string.len());
    updated.push_str(&normalized[..window_start]);
    updated.push_str(&replaced_window);
    updated.push_str(&normalized[window_end..]);

    // 编辑行号（1-based，与 Read 输出一致）
    let first_match_index = window_start + first_match_local;
    let (start_line, end_line) = if old_string.is_empty() {
        let (line, _) = line_range_from_index(&normalized, first_match_index, 0);
        (line, line)
    } else {
        line_range_from_index(&normalized, first_match_index, old_string.len())
    };
    // 换行符还原（先还原再算 diff：CRLF 文件里 oldContent 是 LF、
    // newContent 是 CRLF，diff 因此把整段都算成变化——这里刻意复刻该行为）。
    if crlf {
        updated = updated.replace('\n', "\r\n");
    }
    // 增删行数：diff 口径（见 `count_lines_changed`）。
    // 先按 diff 窗口计算；窗口过大时回退到「按行数 × 替换次数」的近似值。
    let line_delta = count_lines(&new_string) as i64 - count_lines(&old_string) as i64;
    let (old_end_line, new_end_line) = if replacements_made <= 1 {
        (end_line, (end_line as i64 + line_delta).max(0) as usize)
    } else {
        // replaceAll：窗口终点取搜索窗口内**最后一处**匹配所在行
        let last_match_local = if old_string.is_empty() {
            window.len()
        } else {
            window.rfind(&old_string).unwrap_or(0)
        };
        let last_match_index = window_start + last_match_local;
        let last_end_line = line_range_from_index(&normalized, last_match_index, old_string.len()).1;
        (
            last_end_line,
            (last_end_line as i64 + line_delta * replacements_made as i64).max(0) as usize,
        )
    };
    let naive_additions = if new_string.is_empty() {
        0
    } else {
        new_string.split('\n').count() * replacements_made
    };
    let naive_deletions = if old_string.is_empty() {
        0
    } else {
        old_string.split('\n').count() * replacements_made
    };
    let (additions, deletions) = count_lines_changed(
        &normalized,
        &updated,
        start_line,
        old_end_line,
        start_line,
        new_end_line,
        (naive_additions, naive_deletions),
    );

    let line_count = count_lines(&updated);

    match std::fs::write(&path, updated) {
        Ok(()) => {
            // 非 git 工作区内的 md 修改登记（specs/030 FR-004；内部自行判定不满足即返回）
            config::record_md_modification(&ctx.cwd, &path);
            let replacement = if replacements_made == 1 { "replacement" } else { "replacements" };
            let line_note = if start_line == end_line {
                format!("Edited line {start_line}")
            } else {
                format!("Edited lines {start_line}-{end_line}")
            };
            // 额外字段：
            // `startLine` / `endLine` 供 UI 跳转选中，`beforeContent`（规范化后的
            // 原始内容）供历史恢复时重算 diff。只在 beforeContent 为真值时
            // 才写入该键（空文件编辑时省略）。
            let mut extra = Map::new();
            extra.insert("startLine".to_string(), json!(start_line));
            extra.insert("endLine".to_string(), json!(end_line));
            if !normalized.is_empty() {
                extra.insert("beforeContent".to_string(), Value::String(normalized));
            }
            ToolOutcome::SuccessWithMeta {
                text: format!(
                    "Edited file: {file_path}\nMade {replacements_made} {replacement}\n{line_note}\nLines: {line_count} (+{additions}, -{deletions})"
                ),
                extra,
            }
        }
        Err(err) => ToolOutcome::Error(format!("Edit: write failed: {err}")),
    }
}

// ==================== ripgrep ====================

/// 当前平台 / 架构的产物目录名（`<arch>-<platform>`，与 `resources/ripgrep/` 一致）
fn platform_dir() -> String {
    let platform = if cfg!(windows) { "win32" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
    format!("{arch}-{platform}")
}

/// 可执行文件名（Windows 加 `.exe`）
fn exe_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// Core 可执行文件所在目录：部署槽位（自带共享资源的定位基准）。
///
/// 部署单元是「指纹槽位里的 Core 可执行文件 + 产品目录里与全部槽位共享的
/// `ripgrep/`」——安装器 / SSH 引导把 rg 落在 `share/<产品名>/ripgrep/`，Core 从
/// 自己所在槽位的上一级目录定位它（`docs/core/standalone-core.md` 第 4 节）。Core 因此
/// 不依赖宿主的 `extensionPath` 定位自己的产物。
fn core_executable_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// ripgrep 的候选路径，按优先级排列（纯函数，便于用例锁死顺序）：
/// 1. Core 自己槽位里的自带位（`<Core 可执行文件目录>/ripgrep/`）：本地打包布局，
///    构建脚本把 rg 与可执行文件落在一起（`resources/<core.resourceDir>/<dir>/ripgrep/`，
///    打包后随 asarUnpack 解包，Rust 的 `Path::exists` 看不进 asar，只有这条能用）；
/// 2. 部署布局的共享位（`<Core 可执行文件目录>/../ripgrep/`：槽位上一级的产品
///    目录里，全部指纹槽位共享一份）；
/// 3. 宿主 `extensionPath`（本机开发期兜底：直接用 `cargo run` / `cargo test`
///    的 Core 进程、或从仓库里跑宿主时，产物在 `resources/` / `dist/resources/`）。
fn ripgrep_candidates(core_dir: Option<&Path>, extension_path: Option<&str>) -> Vec<PathBuf> {
    let exe = exe_name("rg");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = core_dir {
        // 本地打包布局：rg 与 Core 可执行文件同目录下的 `ripgrep/` 子目录
        candidates.push(dir.join("ripgrep").join(&exe));
        // 槽位上一级：`share/<产品名>/<指纹>/` 的上一级是产品目录，共享 rg 在那里
        if let Some(parent) = dir.parent() {
            candidates.push(parent.join("ripgrep").join(&exe));
        }
    }
    if let Some(extension_path) = extension_path {
        // 逐段 join（不要用 `"dist/resources/ripgrep"` 这种含 `/` 的单段字符串）：
        // Windows 上 `path.join` 产出的是反斜杠，错误文案里的命令行才能与
        // 与 `path.join(...)` 的产物完全一致。
        let sub_dir = platform_dir();
        let base = Path::new(extension_path);
        candidates.push(
            base.join("dist")
                .join("resources")
                .join("ripgrep")
                .join(&sub_dir)
                .join(&exe),
        );
        candidates.push(
            base.join("resources")
                .join("ripgrep")
                .join(&sub_dir)
                .join(&exe),
        );
    }
    candidates
}

/// 解析随 Core 分发的 ripgrep 产物；缺失时回退到宿主产物与 PATH 中的 `rg`。
pub fn ripgrep_path() -> String {
    let core_dir = core_executable_dir();
    let extension_path = config::extension_path().ok();
    for candidate in ripgrep_candidates(core_dir.as_deref(), extension_path.as_deref()) {
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
    }
    "rg".to_string()
}

/// ripgrep 单次搜索上限
const RIPGREP_TIMEOUT: Duration = Duration::from_secs(20);

/// 执行 ripgrep。
///
/// **不设置 `current_dir`**，让 rg 继承
/// Core 进程的工作目录（宿主启动 Core 时也不指定 cwd，因此两边看到同一个 cwd）。
/// 这一点会影响 `--glob` 的语义：ripgrep 对含 `/` 的 glob 模式是相对「当前工作
/// 目录」而非搜索根匹配的。此前把 cwd 设成搜索根，`sub/*.txt` 在 Standalone 能
/// 命中（宿主 cwd 下没有 `sub/`），此前设成搜索根时结果不同。
fn run_ripgrep(args: &[String]) -> Result<String, String> {
    let executable = ripgrep_path();
    let mut cmd = Command::new(&executable);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    util::hide_console(&mut cmd);
    // `rg` 是原生进程（自带产物缺失时还可能来自 PATH）：要 Windows 形式的那份
    crate::shell_env::apply_native(&mut cmd)?;
    let mut child = cmd.spawn().map_err(|err| {
        // 对齐 Node `execFile` 的错误文案（`spawn <path> <UV_ERRNO>`）
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "UNKNOWN",
        };
        format!("spawn {executable} {code}")
    })?;

    // 并发读取，避免大结果集时子进程阻塞在管道写；同时加超时，病态正则不会挂住消费线程。
    let stdout_handle = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_handle = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let deadline = std::time::Instant::now() + RIPGREP_TIMEOUT;
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => {
                let _ = child.kill();
                return Err(format!("ripgrep wait failed: {err}"));
            }
        }
    }
    let code = child.wait().ok().and_then(|status| status.code());
    let stdout = String::from_utf8_lossy(
        &stdout_handle.map(|handle| handle.join().unwrap_or_default()).unwrap_or_default(),
    )
    .to_string();
    let stderr = String::from_utf8_lossy(
        &stderr_handle.map(|handle| handle.join().unwrap_or_default()).unwrap_or_default(),
    )
    .to_string();
    if timed_out {
        return Err(format!("ripgrep timed out after {}s", RIPGREP_TIMEOUT.as_secs()));
    }
    // 退出码 1 = 无匹配，不是错误
    if code == Some(1) {
        return Ok(String::new());
    }
    if code != Some(0) {
        // 对齐 Node `execFile` 的失败文案：`Command failed: <cmd> <args...>\n<stderr>`
        // （stderr 原样保留，包含结尾换行）。
        let mut command_line = executable.clone();
        for arg in args {
            command_line.push(' ');
            command_line.push_str(arg);
        }
        return Err(format!("Command failed: {command_line}\n{stderr}"));
    }
    Ok(stdout)
}

/// 把 ripgrep 的 stdout 解析成行：
/// `stdout.trim().split('\n').filter((line) => line.length > 0)`。
///
/// 两个容易忽略的点：
/// - 先对整个 stdout 做 **JS 口径**的 trim（含最后一行的尾随空格与 CRLF）。
///   rg 的 content 输出会原样带出匹配行的尾随空格；Rust 的 `.lines()` 不会去掉，
///   而 JS 口径的 `.trim()` 会。
/// - 按 `\n` 切分（**不是** `str::lines()`）：中间行的 `\r`（CRLF 文件里的匹配行）
///   JS 口径原样保留，`.lines()` 会把 `\r` 吃掉。
fn ripgrep_lines(stdout: &str) -> Vec<String> {
    crate::util::js_trim(stdout)
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

/// 去掉搜索根前缀，得到相对路径（对齐 `path.relative(searchPath, filePath)`）
fn strip_search_root(search_path: &str, line: &str) -> String {
    let base = search_path.trim_end_matches(['\\', '/']);
    if base.is_empty() {
        return line.to_string();
    }
    let head = line.get(..base.len());
    let is_prefix = match head {
        Some(value) if cfg!(windows) => value.eq_ignore_ascii_case(base),
        Some(value) => value == base,
        None => false,
    };
    if !is_prefix {
        return line.to_string();
    }
    let rest = line[base.len()..].trim_start_matches(['\\', '/']);
    if rest.is_empty() {
        line.to_string()
    } else {
        rest.to_string()
    }
}

/// 把 glob 参数拆成多个 `--glob`（空白分隔，非 `{...}` 再按 `,` 拆）
fn split_glob_patterns(glob: &str) -> Vec<String> {
    let mut out = Vec::new();
    // JS 空白口径（U+0085 / U+FEFF 行为与
    // Rust `split_whitespace` 相反）
    for raw in glob
        .split(crate::util::is_js_whitespace)
        .filter(|part| !part.is_empty())
    {
        if raw.contains('{') && raw.contains('}') {
            out.push(raw.to_string());
        } else {
            for part in raw.split(',') {
                if !part.is_empty() {
                    out.push(part.to_string());
                }
            }
        }
    }
    out
}

/// `applyHeadLimit`：head_limit 缺省 250，0 表示不限；返回是否触发分页
fn apply_head_limit(
    items: &[String],
    head_limit: Option<u64>,
    offset: usize,
) -> (Vec<String>, Option<u64>) {
    if head_limit == Some(0) {
        return (items.iter().skip(offset).cloned().collect(), None);
    }
    let effective = head_limit.unwrap_or(250);
    let sliced: Vec<String> = items
        .iter()
        .skip(offset)
        .take(effective as usize)
        .cloned()
        .collect();
    let was_truncated = items.len().saturating_sub(offset) as u64 > effective;
    (sliced, if was_truncated { Some(effective) } else { None })
}

/// 分页说明串
fn pagination_info(applied_limit: Option<u64>, offset: usize) -> String {
    if applied_limit.is_none() && offset == 0 {
        String::new()
    } else {
        let limit = applied_limit
            .map(|value| value.to_string())
            .unwrap_or_else(|| "unlimited".to_string());
        format!("limit: {limit}, offset: {offset}")
    }
}

fn run_grep(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    // `!pattern` 视为缺参（空串是假值）
    let Some(pattern) = input_str(input, "pattern").filter(|value| !value.is_empty()) else {
        return ToolOutcome::Error("pattern is required and must be a string".to_string());
    };
    let search_path = input_str(input, "path")
        .map(|path| expand_path(&ctx.cwd, &path).to_string_lossy().to_string())
        .unwrap_or_else(|| ctx.cwd.clone());
    // 缺省 files_with_matches
    let mode = input_str(input, "output_mode").unwrap_or_else(|| "files_with_matches".to_string());
    let case_insensitive = input_bool(input, "-i").unwrap_or(false);
    let show_line_numbers = input_bool(input, "-n").unwrap_or(true);
    let multiline = input_bool(input, "multiline").unwrap_or(false);
    let head_limit = input_u64(input, "head_limit");
    let offset = input_u64(input, "offset").unwrap_or(0) as usize;

    // 参数与顺序（`--color` / `--` 都不传：rg 在非 TTY
    // 下本就不上色，且错误文案会带上完整命令行，多一个参数就不一致）。
    let mut args: Vec<String> = vec!["--hidden".into()];
    for dir in [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"] {
        args.push("--glob".into());
        args.push(format!("!{dir}"));
    }
    args.push("--max-columns".into());
    args.push("500".into());
    if multiline {
        args.push("-U".into());
        args.push("--multiline-dotall".into());
    }
    if case_insensitive {
        args.push("-i".into());
    }
    match mode.as_str() {
        "files_with_matches" => args.push("-l".into()),
        "count" => args.push("-c".into()),
        _ => {}
    }
    if show_line_numbers && mode == "content" {
        args.push("-n".into());
    }
    if mode == "content" {
        if let Some(value) = input_u64(input, "context") {
            args.push("-C".into());
            args.push(value.to_string());
        } else if let Some(value) = input_u64(input, "-C") {
            args.push("-C".into());
            args.push(value.to_string());
        } else {
            if let Some(value) = input_u64(input, "-B") {
                args.push("-B".into());
                args.push(value.to_string());
            }
            if let Some(value) = input_u64(input, "-A") {
                args.push("-A".into());
                args.push(value.to_string());
            }
        }
    }
    // 以 `-` 开头的 pattern 会被 rg 当作选项解析（`--pre=<cmd>` 可执行任意程序），
    // 因此加 `-e` 显式声明为模式。
    if pattern.starts_with('-') {
        args.push("-e".into());
        args.push(pattern);
    } else {
        args.push(pattern);
    }
    if let Some(file_type) = input_str(input, "type") {
        args.push("--type".into());
        args.push(file_type);
    }
    if let Some(glob) = input_str(input, "glob") {
        for glob_pattern in split_glob_patterns(&glob) {
            args.push("--glob".into());
            args.push(glob_pattern);
        }
    }
    args.push(search_path.clone());

    match run_ripgrep(&args) {
        Ok(stdout) => {
            let lines = ripgrep_lines(&stdout);
            let (limited, applied_limit) = apply_head_limit(&lines, head_limit, offset);
            let limit_info = pagination_info(applied_limit, offset);
            match mode.as_str() {
                "content" => {
                    // 相对路径：剥掉搜索根前缀（rg 以绝对搜索根返回绝对路径）。
                    //
                    // 不用 `line.indexOf(':')` 截「文件路径」：
                    // 在 Windows 绝对路径（`D:\...`）上会把盘符后的
                    // `:` 当成字段分隔符，再交给 `path.relative` 解析，产出
                    // `D:\<process.cwd>\D:\...\a.txt:1:...` 这类错乱路径（搜索目录与
                    // 进程工作目录不同盘时尤其明显）。count / files 模式用
                    // `lastIndexOf(':')` / 完整路径，没有这个问题。Rust 统一剥前缀，
                    // 得到正确且稳定的相对路径。
                    let final_lines: Vec<String> = limited
                        .iter()
                        .map(|line| strip_search_root(&search_path, line))
                        .collect();
                    let content = final_lines.join("\n");
                    let mut text = if content.is_empty() {
                        "No matches found".to_string()
                    } else {
                        content
                    };
                    if !limit_info.is_empty() {
                        text.push_str(&format!(
                            "\n\n[Showing results with pagination = {limit_info}]"
                        ));
                    }
                    ToolOutcome::Success(text)
                }
                "count" => {
                    let final_lines: Vec<String> = limited
                        .iter()
                        .map(|line| strip_search_root(&search_path, line))
                        .collect();
                    let mut total_matches = 0usize;
                    let mut file_count = 0usize;
                    for line in &final_lines {
                        if let Some(index) = line.rfind(':') {
                            if let Ok(count) = line[index + 1..].trim().parse::<usize>() {
                                total_matches += count;
                                file_count += 1;
                            }
                        }
                    }
                    let content = final_lines.join("\n");
                    let mut text = if content.is_empty() {
                        "No matches found".to_string()
                    } else {
                        content
                    };
                    let occurrence = if total_matches == 1 { "occurrence" } else { "occurrences" };
                    let file_word = if file_count == 1 { "file" } else { "files" };
                    text.push_str(&format!(
                        "\n\nFound {total_matches} total {occurrence} across {file_count} {file_word}."
                    ));
                    if !limit_info.is_empty() {
                        text.push_str(&format!(" with pagination = {limit_info}"));
                    }
                    ToolOutcome::Success(text)
                }
                _ => {
                    let filenames: Vec<String> = limited
                        .iter()
                        .map(|line| strip_search_root(&search_path, line))
                        .collect();
                    if filenames.is_empty() {
                        return ToolOutcome::Success("No files found".to_string());
                    }
                    let num_files = filenames.len();
                    let file_word = if num_files == 1 { "file" } else { "files" };
                    let mut text = format!("Found {num_files} {file_word}");
                    if !limit_info.is_empty() {
                        text.push_str(&format!(" {limit_info}"));
                    }
                    text.push('\n');
                    text.push_str(&filenames.join("\n"));
                    ToolOutcome::Success(text)
                }
            }
        }
        Err(err) => ToolOutcome::Error(err),
    }
}

/// 绝对 glob 模式：拆出静态基准目录与相对模式（对齐 `extractGlobBaseDirectory`）
fn extract_glob_base_directory(pattern: &str) -> (String, String) {
    let glob_index = pattern.find(['*', '?', '[', '{']);
    match glob_index {
        None => {
            let path = Path::new(pattern);
            let dir = path
                .parent()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let file = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            (dir, file)
        }
        Some(index) => {
            let static_prefix = &pattern[..index];
            match static_prefix.rfind(['/', '\\']) {
                None => (String::new(), pattern.to_string()),
                Some(sep) => {
                    let base = &static_prefix[..sep];
                    let rel = &pattern[sep + 1..];
                    let base = if base.is_empty() && sep == 0 { "/" } else { base };
                    (base.to_string(), rel.to_string())
                }
            }
        }
    }
}

fn run_glob(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    // `!pattern` 视为缺参（空串是假值）
    let Some(pattern) = input_str(input, "pattern").filter(|value| !value.is_empty()) else {
        return ToolOutcome::Error("pattern is required and must be a string".to_string());
    };
    let mut search_dir = input_str(input, "path")
        .map(|path| expand_path(&ctx.cwd, &path).to_string_lossy().to_string())
        .unwrap_or_else(|| ctx.cwd.clone());
    let mut search_pattern = pattern.clone();
    if is_absolute_like_node(&pattern) {
        let (base, relative) = extract_glob_base_directory(&pattern);
        if !base.is_empty() {
            search_dir = base;
            search_pattern = relative;
        }
    }

    // 参数与顺序（不传 `--color` / `--`）
    let args: Vec<String> = vec![
        "--files".into(),
        "--glob".into(),
        search_pattern,
        "--sort=modified".into(),
        "--no-ignore".into(),
        "--hidden".into(),
        search_dir.clone(),
    ];
    match run_ripgrep(&args) {
        Ok(stdout) => {
            let lines = ripgrep_lines(&stdout);
            let absolute: Vec<String> = lines
                .iter()
                .map(|path| {
                    if is_absolute_like_node(path) {
                        path.clone()
                    } else {
                        Path::new(&search_dir)
                            .join(path)
                            .to_string_lossy()
                            .to_string()
                    }
                })
                .collect();
            let truncated = absolute.len() > 100;
            let filenames: Vec<String> = absolute
                .iter()
                .take(100)
                .map(|path| strip_search_root(&search_dir, path))
                .collect();
            if filenames.is_empty() {
                return ToolOutcome::Success("No files found".to_string());
            }
            let num_files = filenames.len();
            let file_word = if num_files == 1 { "file" } else { "files" };
            let mut text = format!("Found {num_files} {file_word}\n{}", filenames.join("\n"));
            if truncated {
                text.push_str(
                    "\n(Results are truncated. Consider using a more specific path or pattern.)",
                );
            }
            ToolOutcome::Success(text)
        }
        Err(err) => ToolOutcome::Error(err),
    }
}

// ==================== TodoWrite ====================

/// 会话 Todo 条目（`TodoWrite` 的元素，`docs/features/todo-list.md` FR-001）。
///
/// 字段名与 `src/shared/types.ts` 的 `TodoEntry` 逐字对应（`activeForm` 是 JSON 侧写法）；
/// 三个字段全必选，缺省值由 `run_todo_write` 的校验与 `rebuild_todos_from_history`
/// 的规范化各自补齐。
#[derive(Clone, serde::Serialize)]
pub struct TodoEntry {
    pub content: String,
    pub status: String,
    #[serde(rename = "activeForm")]
    pub active_form: String,
}

/// 会话 Todo 表：`sessionId → 清单`。
///
/// 它是 Todo 状态的**唯一持有者**（`docs/features/todo-list.md` FR-001）：`TodoWrite` 成功
/// 即写表，宿主经 `sessionTodosRequested` 索取，变更时由 `todosChanged` 推送。进程重启后
/// 表为空，首次被索取 / 写入前由 `rebuild_todos_from_history` 从会话文件重建。
static TODOS: std::sync::Mutex<Option<HashMap<String, Vec<TodoEntry>>>> =
    std::sync::Mutex::new(None);

/// 取表锁；锁中毒（持锁线程 panic）时沿用内部数据继续，不让后续每次调用都 panic。
fn lock_todos() -> std::sync::MutexGuard<'static, Option<HashMap<String, Vec<TodoEntry>>>> {
    TODOS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 会话关闭 / 删除时清掉该会话的 Todo 表，避免全局表无界增长。
pub fn clear_session_todos(session_id: &str) {
    if let Some(table) = lock_todos().as_mut() {
        table.remove(session_id);
    }
}

/// 清单 → 契约载荷（`TodoEntry[]`）。空清单也是合法载荷（表示「没有 Todo」）。
fn todos_to_value(entries: &[TodoEntry]) -> Value {
    Value::Array(
        entries
            .iter()
            .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
            .collect(),
    )
}

/// 写表并返回清单载荷；`TodoWrite` 成功与重建共用这一个写入点。
fn store_session_todos(session_id: &str, entries: Vec<TodoEntry>) -> Value {
    let value = todos_to_value(&entries);
    let mut guard = lock_todos();
    guard
        .get_or_insert_with(HashMap::new)
        .insert(session_id.to_string(), entries);
    value
}

/// 会话当前清单；表中没有该会话时返回 `None`（调用方决定是否重建）。
pub fn session_todos(session_id: &str) -> Option<Value> {
    lock_todos()
        .as_ref()
        .and_then(|table| table.get(session_id))
        .map(|entries| todos_to_value(entries))
}

/// 索取会话清单：表里有就直接给，没有就按会话文件重建后写表再给
/// （`docs/features/todo-list.md` FR-002；`sessionTodosRequested` 的应答实现）。
pub fn ensure_session_todos(session_id: &str) -> Value {
    if let Some(value) = session_todos(session_id) {
        return value;
    }
    // 读盘不持锁：重建期间可能有 TodoWrite 并发写表，以写表者为准（后者覆盖前者，
    // 因为 TodoWrite 的入参比文件里的旧快照新）。
    let rebuilt = rebuild_todos_from_history(session_id);
    store_session_todos(session_id, rebuilt)
}

/// 把 `todos` 入参规范化成清单条目；非数组 / 非对象条目按「无效」处理。
///
/// 校验失败的入参不写表（`run_todo_write` 先校验再调本函数），所以这里的宽松口径只服务
/// 重建路径——会话文件里存的是模型原始入参，可能缺 `status` / `activeForm`。
fn normalize_todos(value: &Value) -> Option<Vec<TodoEntry>> {
    let items = value.as_array()?;
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let object = item.as_object()?;
        let content = object.get("content").and_then(Value::as_str)?;
        let status = object
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        let active_form = object
            .get("activeForm")
            .and_then(Value::as_str)
            .unwrap_or("");
        entries.push(TodoEntry {
            content: content.to_string(),
            status: status.to_string(),
            active_form: active_form.to_string(),
        });
    }
    Some(entries)
}

/// 从会话文件重建清单：取**最后一条成功**的 `TodoWrite` 调用的 `todos` 入参。
///
/// 「成功」以该次调用的 `tool_result.exit_code == 0` 为准（缺 `exit_code` 视为成功，与
/// `replayMessages` 的判定同口径）；失败调用与找不到结果的调用都不参与。
/// 文件不存在 / 解析失败 / 没有成功调用时返回空清单，不报错——「该对话没有 Todo」
/// 与「文件读不到」在这一层是同一个可观察结果（`docs/features/todo-list.md` 边界）。
fn rebuild_todos_from_history(session_id: &str) -> Vec<TodoEntry> {
    let Some(project) = crate::history::project_of_session(session_id) else {
        return Vec::new();
    };
    let messages = crate::history::load_messages(session_id, &project);

    // 第一遍：tool_use_id → 是否成功（缺 exit_code 视为成功）
    let mut succeeded: HashMap<String, bool> = HashMap::new();
    for message in &messages {
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(tool_use_id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let exit_code = block.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
            succeeded.insert(tool_use_id.to_string(), exit_code == 0);
        }
    }

    // 第二遍：按文件顺序记最后一条成功的 TodoWrite
    let mut last: Option<Vec<TodoEntry>> = None;
    for message in &messages {
        let Some(blocks) = message
            .get("message")
            .and_then(|inner| inner.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for block in blocks {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            if block.get("name").and_then(Value::as_str) != Some("TodoWrite") {
                continue;
            }
            let tool_use_id = block.get("id").and_then(Value::as_str).unwrap_or("");
            if succeeded.get(tool_use_id) != Some(&true) {
                continue;
            }
            let Some(mut input) = block.get("input").cloned() else {
                continue;
            };
            // 字段级 double-encode：模型把 todos 序列化成字符串时按 JSON 解析
            if let Some(text) = input.get("todos").and_then(Value::as_str) {
                let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                if let Some(object) = input.as_object_mut() {
                    object.insert("todos".to_string(), parsed);
                }
            }
            let Some(todos) = input.get("todos") else {
                continue;
            };
            let Some(entries) = normalize_todos(todos) else {
                continue;
            };
            last = Some(entries);
        }
    }
    last.unwrap_or_default()
}

fn run_todo_write(input: &Value, session_id: &str) -> ToolOutcome {
    let mut todos = input.get("todos").cloned().unwrap_or(json!([]));
    // LLM 有时把 todos 序列化成 JSON 字符串
    if let Some(text) = todos.as_str() {
        match serde_json::from_str::<Value>(text) {
            Ok(parsed) => todos = parsed,
            Err(_) => {
                return ToolOutcome::Error(
                    "todos is required and must be an array, but received an unparseable string"
                        .to_string(),
                )
            }
        }
    }
    let Some(items) = todos.as_array() else {
        return ToolOutcome::Error("todos is required and must be an array".to_string());
    };

    // 运行期校验
    for (index, item) in items.iter().enumerate() {
        let content_ok = item
            .get("content")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        if !content_ok {
            return ToolOutcome::Error(format!(
                "InputValidationError: todos[{index}].content: Content cannot be empty"
            ));
        }
        let active_ok = item
            .get("activeForm")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false);
        if !active_ok {
            return ToolOutcome::Error(format!(
                "InputValidationError: todos[{index}].activeForm: Active form cannot be empty"
            ));
        }
        if let Some(status) = item.get("status") {
            match status.as_str() {
                Some("pending") | Some("in_progress") | Some("completed") => {}
                _ => {
                    return ToolOutcome::Error(format!(
                        "InputValidationError: todos[{index}].status: Invalid enum value"
                    ))
                }
            }
        }
    }

    // 校验通过 → 写表（唯一写入点，`docs/features/todo-list.md` FR-001）。
    // 清空清单用 `todos: []` 表达；不再有「全部完成即清空」的特殊分支——
    // 已完成项要留在表里，进度按钮才显示得出 `4/4`。
    let Some(entries) = normalize_todos(&todos) else {
        return ToolOutcome::Error("todos is required and must be an array".to_string());
    };
    let stored = store_session_todos(session_id, entries);

    fn status_of(item: &Value) -> &str {
        item.get("status").and_then(Value::as_str).unwrap_or("pending")
    }
    let total = items.len();
    let completed = items.iter().filter(|item| status_of(item) == "completed").count();
    let in_progress = items.iter().filter(|item| status_of(item) == "in_progress").count();
    let pending = items.iter().filter(|item| status_of(item) == "pending").count();

    let mut text = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable".to_string();
    text.push_str(&format!(
        "\n\nCurrent todo list: {total} items ({completed} completed, {in_progress} in progress, {pending} pending)"
    ));
    if total > 0 {
        // 标题行自带一个 `\n`
        // （`'\n\nTasks:\n'`），随后每个条目再以 `\n` 开头，因此标题与第 1 条之间
        // 是空行（`Tasks:\n\n1. ...`）。
        text.push_str("\n\nTasks:\n");
        for (index, item) in items.iter().enumerate() {
            let icon = match status_of(item) {
                "completed" => "[x]",
                "in_progress" => "[~]",
                _ => "[ ]",
            };
            let content = item.get("content").and_then(Value::as_str).unwrap_or("");
            text.push_str(&format!("\n{}. {icon} {content}", index + 1));
        }
    }
    // 带上新清单：engine 据此推送 `todosChanged`（`docs/features/todo-list.md` FR-002）
    ToolOutcome::SuccessWithTodos { text, todos: stored }
}

// ==================== AskUserQuestion ====================

/// AskUserQuestion：把 `questions` 经 `CoreRequest.userChoice` 弹给用户，阻塞等待回复。
///
/// - 请求载荷 `{ kind: "question", toolName: "AskUserQuestion", questions }`；
/// - 用户回复 `{ kind: "question", answers: [{ id, selected, custom? }] }` 后，
///   按 dsh 的 `render` 口径产出 `{"answers":[...]}` JSON
///   （`docs/features/ask-user-question.md` FR-005）。
fn run_ask_user_question(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let questions = normalize_questions(input);
    let options = json!({
        "kind": "question",
        "toolName": "AskUserQuestion",
        "questions": questions,
    });

    // 请求失败（无订阅者 / 超时）走 `ToolOutcome::Error`，最终产出
    // `Error executing AskUserQuestion: ...`。
    let Some(callback) = ctx.user_choice.as_ref() else {
        return ToolOutcome::Error("Failed to request user choice".to_string());
    };
    let Some(response) = callback(&options) else {
        return ToolOutcome::Error("Failed to request user choice".to_string());
    };

    let answers = response.get("answers").cloned().unwrap_or_else(|| json!([]));
    ToolOutcome::Success(
        serde_json::to_string(&json!({ "answers": answers }))
            .unwrap_or_else(|_| "{\"answers\":[]}".to_string()),
    )
}

/// 把入参的 `questions` 规范化成内部必选字段形态：
/// `header` 缺失 → null，`options` 缺失 → []，`description` 缺失 → null，
/// `multi_select` 缺失 → false（`docs/features/ask-user-question.md` FR-001）。
fn normalize_questions(input: &Value) -> Vec<Value> {
    let raw = input
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    raw.iter()
        .map(|question| {
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|option| {
                            json!({
                                "label": option.get("label").cloned().unwrap_or(Value::Null),
                                "description": option.get("description").cloned().unwrap_or(Value::Null),
                            })
                        })
                        .collect::<Vec<Value>>()
                })
                .unwrap_or_default();
            json!({
                "id": question.get("id").cloned().unwrap_or(Value::Null),
                "question": question.get("question").cloned().unwrap_or(Value::Null),
                "header": question.get("header").cloned().unwrap_or(Value::Null),
                "options": options,
                "multi_select": question.get("multi_select").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect()
}

/// `Skill` 工具。
///
/// 工作流程：`validateInput` 已保证 skill 可解析 → 取技能正文 → 替换
/// `${SKILL_DIR}` / `${SESSION_ID}` → 包装成 `isMeta: true` 的 user 消息随
/// `newMessages` 注入对话（UI 不直接展示，但模型能读到）。
///
/// 这里**不**校验 `disable-model-invocation`：用户 `/name` 的注入路径
/// （`engine::inject_skill_tool_use`）与模型调用共用本函数，模型侧开关只在校验入口
/// `validate_input` 生效。搬到这里会连带拦掉用户自己的触发（ADR-0011）。
fn run_skill(input: &Value, ctx: &ToolContext) -> ToolOutcome {
    let skill = input.get("skill").and_then(Value::as_str).unwrap_or("");
    let args = input.get("args").and_then(Value::as_str).unwrap_or("");
    let trimmed = crate::util::js_trim(skill);
    let trimmed = trimmed.strip_prefix('/').unwrap_or(trimmed);

    let Some(command) = crate::skills::find_skill(trimmed, &ctx.cwd) else {
        // 对齐 `call()` 的 `throw new Error(\`Skill '${trimmed}' not found\`)`
        return ToolOutcome::Error(format!("Skill '{trimmed}' not found"));
    };

    // 提取文本内容
    let text_content = command
        .prompt_for_command(args)
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");

    // 替换内置变量（`${SKILL_DIR}`, `${SESSION_ID}`）
    let final_content = crate::skills::substitute_builtin_variables(
        &text_content,
        command.skill_root.as_deref(),
        Some(&ctx.session_id),
    );

    eprintln!(
        "[core] SkillTool: Injecting skill '{trimmed}' prompt ({} chars)",
        crate::util::utf16_len(&final_content)
    );

    // 包装为 UserMessage（`isMeta=true` 表示不被 UI 直接显示）
    let user_message = json!({
        "type": "user",
        "message": { "role": "user", "content": final_content },
        "uuid": format!("skill_{}", crate::util::now_millis()),
        "timestamp": crate::util::now_millis(),
        "isMeta": true,
    });

    ToolOutcome::SuccessWithMessages {
        text: format!(
            "Skill \"{trimmed}\" has been loaded. Follow the instructions in the skill content above."
        ),
        new_messages: vec![user_message],
    }
}

#[cfg(test)]
#[path = "tools_tests.rs"]
mod tests;

//! 后台 Bash 任务：注册表、输出文件、完成通知。
//!
//! 未实现的部分（暂无消费方）：
//! - `TaskOutput` 的 pipe mode（内存 buffer + 超限 spill 到磁盘）：前台输出由
//!   `tools::read_pipe` 直接读管道，后台输出由子进程直接写文件 fd，不需要这一层。
//! - 5GB 磁盘看门狗（`SIZE_WATCHDOG_INTERVAL_MS`）：仅在后台输出文件异常膨胀时生效的
//!   保护措施，暂无对应实现。
//! - `TaskOutput` 的进度轮询（`ProgressCallback`）：后台任务不报进度。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::util;

/// 任务输出目录名（`src/config/project.json` 的 `tmpTaskDirName`，build.rs 构建期
/// 烧入——源码不持有产品字面量，与 TS 侧同一配置来源）
pub const TASK_OUTPUT_DIR_NAME: &str = env!("TC_TMP_TASK_DIR_NAME");

/// 子进程退出轮询间隔（与前台 `run_bash` 的等待节奏一致）
const POLL_INTERVAL_MS: u64 = 30;

/// 完成通知里附带的 stdout 预览上限（对齐 `buildCompletionNotification`）
const NOTIFICATION_OUTPUT_CHARS: usize = 500;

/// 后台任务周期性提醒的间隔（分钟）：第 1 次 5min，其后 10 / 20 / 30min，再往后固定 30min。
///
pub const BACKGROUND_REMINDER_INTERVALS_MIN: [u64; 4] = [5, 10, 20, 30];

/// 同一任务两次提醒之间的最小间隔（查询结束兜底门槛）：距上次「访问」不足 3 分钟、
/// 且不满足 sleep 豁免的任务，查询结束时不进兜底提醒列表——它刚被周期提醒报告过，
/// 或本轮查询刚刚看过它。
///
pub const BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS: u64 = 3 * 60_000;

/// 任务是否满足查询结束的兜底门槛：距上次访问满最小间隔，或命令含 `sleep` 子命令、
/// 且本任务还没兜底过（sleep 类任务在等一个定时事件，最需要被提醒「别去轮询，等通知」，
/// 因此刚注册也兜底一次）。
///
/// `last_accessed_ms` 是该任务上次被「访问」的时刻（周期提醒投递 / 查询结束，任务注册时
/// 取开始时间）；`fallback_reminded` 是「已经兜底提醒过」（含手工转后台时预置的抑制标记），
/// sleep 豁免据此只生效一次，否则查询结束会每轮命中。纯函数，供两侧对等测试共用。
pub fn qualifies_fallback_reminder(
    last_accessed_ms: u64,
    command: &str,
    fallback_reminded: bool,
    now_ms: u64,
) -> bool {
    if now_ms.saturating_sub(last_accessed_ms) >= BACKGROUND_FALLBACK_REMINDER_MIN_INTERVAL_MS {
        return true;
    }
    !fallback_reminded && crate::tools::contains_sleep_command(command)
}

/// 提醒里附带的任务输出尾部字符数（与完成通知的 500 保持一致）
pub const BACKGROUND_REMINDER_OUTPUT_CHARS: usize = 500;

/// 提醒调度线程的轮询间隔：1s 粒度足够（最小间隔是分钟级），开销可忽略
pub const BACKGROUND_REMINDER_TICK_MS: u64 = 1000;

/// 第 `round` 次提醒与上一次之间的分钟数（round 从 0 起；越界取最后一档）
pub fn background_reminder_interval_min(round: usize) -> u64 {
    BACKGROUND_REMINDER_INTERVALS_MIN[round.min(BACKGROUND_REMINDER_INTERVALS_MIN.len() - 1)]
}

/// 第 `round` 次提醒的间隔标签（如 `5min` / `30min`）
pub fn background_reminder_interval_label(round: usize) -> String {
    format!("{}min", background_reminder_interval_min(round))
}

/// 按当前 OS 生成可执行的 kill 命令（与提醒文案同一口径）
pub fn background_reminder_kill_command(pid: u32) -> String {
    if cfg!(windows) {
        format!("taskkill /T /F /PID {pid}")
    } else {
        format!("kill {pid}")
    }
}

// ==================== 输出文件 ====================

/// 任务输出目录：`TMPDIR` / `TEMP` / `/tmp` 之下（对齐 `TaskOutput.getTaskOutputDir`）。
///
/// 注意 JS 的 `process.env.TMPDIR || process.env.TEMP || '/tmp'` 是「假值回退」：
/// 空串同样回退，这里用 `filter(!is_empty)` 对齐。
pub fn task_output_dir() -> PathBuf {
    let base = std::env::var("TMPDIR")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("TEMP").ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "/tmp".to_string());
    PathBuf::from(base).join(TASK_OUTPUT_DIR_NAME)
}

/// 任务输出文件路径（对齐 `getTaskOutputPath`）
pub fn task_output_path(task_id: &str) -> PathBuf {
    task_output_dir().join(format!("{task_id}.output"))
}

/// 任务 ID：`bg-<millis>-<suffix>`（对齐 `LocalShellTask.generateTaskId`）
pub fn generate_task_id() -> String {
    format!("bg-{}-{}", util::now_millis(), util::random_suffix())
}

/// 自动转后台的任务 ID：`bg-auto-<millis>-<suffix>`
/// （对齐 `Exec.autoBackgroundCommand` 的 `bg-auto-` 前缀，便于区分两种来源）
pub fn generate_auto_task_id() -> String {
    format!("bg-auto-{}-{}", util::now_millis(), util::random_suffix())
}

// ==================== 引擎钩子 ====================

/// 引擎侧钩子（由 `engine.rs` 注入 `ToolContext`）。
///
/// 单测 / 无引擎场景不注入：后台任务照常跑，只是完成通知与 `background` 事实不同步。
#[derive(Clone)]
pub struct Hooks {
    /// 后台任务完成 → 向 `session_id` 注入一条 `origin='bash'` 的自动消息
    /// （对齐 `LocalShellTask.notifyEngine` → `enqueueAgentMessage(..., 'bash')`）。
    pub notify: Arc<dyn Fn(&str, &str) + Send + Sync>,
    /// 后台任务增减 → 重算该会话的 `background` 事实
    /// （对齐 `syncBackgroundState` → `markSessionBackground`）。
    pub sync_background: Arc<dyn Fn(&str) + Send + Sync>,
}

// ==================== 任务注册表 ====================

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TaskStatus {
    Running,
    Completed,
    Failed,
    /// 被中止（落盘 `status: 'killed'`）。
    ///
    /// 生产路径上取不到该状态：`abort_tasks_for_session` 会**先移除记录再 kill**，
    /// 完成回调因此查不到记录（被中止的任务不发通知）。保留该变体是为了让
    /// 「was stopped」文案分支，并供单测构造。
    #[cfg_attr(not(test), allow(dead_code))]
    Killed,
}

/// 完成的任务快照（完成通知与完成事件共用）
#[derive(Clone, Debug)]
pub struct FinishedTask {
    pub task_id: String,
    pub description: String,
    pub session_id: String,
    pub status: TaskStatus,
    pub exit_code: i32,
    pub duration_ms: u64,
}

/// 运行中的后台任务快照（提醒调度用）
#[derive(Clone, Debug)]
pub struct RunningTask {
    pub task_id: String,
    pub description: String,
    pub command: String,
    pub pid: u32,
    /// 任务开始时间（wall clock，毫秒），用于报告「已执行时间」
    pub start_time: u64,
}

struct TaskRecord {
    task_id: String,
    description: String,
    command: String,
    session_id: String,
    pid: u32,
    start_time: u64,
    status: TaskStatus,
    exit_code: Option<i32>,
    /// kill 请求标记：置位后等待线程杀掉子进程；记录已被移除时结果直接丢弃
    /// （对齐 `abortBackgroundTasksForSession` 的「先移除再 kill」）。
    kill: Arc<AtomicBool>,
}

static TASKS: Mutex<Vec<TaskRecord>> = Mutex::new(Vec::new());

/// 指定会话仍在运行中的后台任务数（`syncBackgroundState` 的判据）
pub fn running_count_for_session(session_id: &str) -> usize {
    TASKS
        .lock()
        .unwrap()
        .iter()
        .filter(|task| task.status == TaskStatus::Running && task.session_id == session_id)
        .count()
}

/// 指定会话仍在运行中的后台任务快照（兜底提醒用）
pub fn running_tasks_for_session(session_id: &str) -> Vec<RunningTask> {
    TASKS
        .lock()
        .unwrap()
        .iter()
        .filter(|task| task.status == TaskStatus::Running && task.session_id == session_id)
        .map(|task| RunningTask {
            task_id: task.task_id.clone(),
            description: task.description.clone(),
            command: task.command.clone(),
            pid: task.pid,
            start_time: task.start_time,
        })
        .collect()
}

/// 任务当前状态（`getBackgroundTaskStatus`）
#[cfg_attr(not(test), allow(dead_code))]
pub fn task_status(task_id: &str) -> Option<TaskStatus> {
    TASKS
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.task_id == task_id)
        .map(|task| task.status)
}

/// 中止指定会话所有运行中的后台任务（对齐 `abortBackgroundTasksForSession`）。
///
/// **先移除记录再置 kill**：等待线程完成时查不到记录，会直接丢弃输出与完成通知，
/// 因此被中止的任务不会给 LLM 发通知。
pub fn abort_tasks_for_session(session_id: &str) -> usize {
    let removed: Vec<TaskRecord> = {
        let mut tasks = TASKS.lock().unwrap();
        let mut removed = Vec::new();
        let mut index = 0;
        while index < tasks.len() {
            if tasks[index].session_id == session_id && tasks[index].status == TaskStatus::Running {
                removed.push(tasks.remove(index));
            } else {
                index += 1;
            }
        }
        removed
    };
    let count = removed.len();
    for task in removed {
        task.kill.store(true, Ordering::Relaxed);
    }
    count
}

/// 清空注册表（单测隔离用）
#[cfg(test)]
pub fn reset_for_test() {
    TASKS.lock().unwrap().clear();
}

/// 把一条记录标记为完成并返回快照；记录已被移除（中止 / 清理）时返回 `None`。
fn finish_task(task_id: &str, exit_code: i32) -> Option<FinishedTask> {
    let mut tasks = TASKS.lock().unwrap();
    let record = tasks.iter_mut().find(|task| task.task_id == task_id)?;
    if record.status != TaskStatus::Running {
        return None;
    }
    record.status = if exit_code == 0 {
        TaskStatus::Completed
    } else {
        TaskStatus::Failed
    };
    record.exit_code = Some(exit_code);
    Some(FinishedTask {
        task_id: record.task_id.clone(),
        description: record.description.clone(),
        session_id: record.session_id.clone(),
        status: record.status,
        exit_code,
        duration_ms: util::now_millis().saturating_sub(record.start_time),
    })
}

// ==================== 完成事件（前台自动转后台的触发源） ====================

type CompletedListener = Arc<dyn Fn(&FinishedTask) + Send + Sync>;

static LISTENERS: Mutex<Vec<(u64, CompletedListener)>> = Mutex::new(Vec::new());
static LISTENER_SEQ: AtomicU64 = AtomicU64::new(0);

/// 订阅后台任务完成事件（对齐 `onBackgroundTaskCompleted`），返回订阅号。
pub fn on_task_completed(listener: CompletedListener) -> u64 {
    let id = LISTENER_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    LISTENERS.lock().unwrap().push((id, listener));
    id
}

/// 取消订阅（对齐 `onBackgroundTaskCompleted` 返回的 unsubscribe）。
pub fn off_task_completed(id: u64) {
    LISTENERS.lock().unwrap().retain(|(key, _)| *key != id);
}

fn emit_task_completed(finished: &FinishedTask) {
    // 先复制出监听器列表再回调：回调里可能再次操作注册表（如置位自动转后台标记）
    let listeners: Vec<CompletedListener> = LISTENERS
        .lock()
        .unwrap()
        .iter()
        .map(|(_, listener)| Arc::clone(listener))
        .collect();
    for listener in listeners {
        listener(finished);
    }
}

// ==================== 完成通知文案 ====================

/// 时长格式化（对齐 `LocalShellTask.formatDuration`）
pub fn format_duration(ms: u64) -> String {
    if ms < 1000 {
        return format!("{ms}ms");
    }
    if ms < 60_000 {
        // `(ms / 1000).toFixed(1)`：`.25` 要进位成 `.3`（Rust `{:.1}` 会给 `.2`）
        return format!("{}s", crate::util::js_to_fixed_1(ms as f64 / 1000.0));
    }
    let minutes = ms / 60_000;
    let seconds = ((ms % 60_000) as f64 / 1000.0).round() as u64;
    format!("{minutes}m {seconds}s")
}

/// 完成通知文案（对齐 `buildCompletionNotification`）。
///
/// 纯文本、不用 markdown：UI 按普通消息渲染（不走 markdown 路径）。
pub fn build_completion_notification(finished: &FinishedTask, stdout: &str) -> String {
    let summary = match finished.status {
        TaskStatus::Completed => format!(
            "Background command \"{}\" completed (exit code {})",
            finished.description, finished.exit_code
        ),
        TaskStatus::Failed => format!(
            "Background command \"{}\" failed with exit code {}",
            finished.description, finished.exit_code
        ),
        _ => format!("Background command \"{}\" was stopped", finished.description),
    };
    let mut lines = vec![
        "Background task completed".to_string(),
        format!("Task: {}", finished.task_id),
        format!("Description: {summary}"),
        format!("Duration: {}", format_duration(finished.duration_ms)),
    ];
    if !stdout.is_empty() {
        lines.push("Output (first 500 chars):".to_string());
        let mut preview = util::utf16_take(stdout, NOTIFICATION_OUTPUT_CHARS);
        if util::utf16_len(stdout) > NOTIFICATION_OUTPUT_CHARS {
            preview.push_str("\n...");
        }
        lines.push(preview);
    }
    lines.join("\n")
}

// ==================== 周期性提醒 ====================

/// 提醒时钟状态：`round` 是下一次提醒的序号，`accumulated_ms` 是自上次提醒以来
/// 累积的「空闲」时长。
#[derive(Clone, Debug, Default)]
pub struct ReminderClock {
    pub round: usize,
    pub accumulated_ms: u64,
}

/// 推进提醒时钟：累加 `awake_ms`，返回本次到点的提醒轮次（从早到晚）。
///
/// 时钟只由调用方在会话空闲时推进；query engine 有任务时调用方不累加，
/// 因此这里不需要知道查询状态。一次推进可能跨过多个间隔（进程被挂起等），
/// 逐档扣减，保证后续轮次不漂移。
pub fn advance_reminder_clock(clock: &mut ReminderClock, awake_ms: u64) -> Vec<usize> {
    let mut fired = Vec::new();
    clock.accumulated_ms = clock.accumulated_ms.saturating_add(awake_ms);
    loop {
        let due = background_reminder_interval_min(clock.round) * 60_000;
        if clock.accumulated_ms < due {
            break;
        }
        clock.accumulated_ms -= due;
        fired.push(clock.round);
        clock.round += 1;
    }
    fired
}

/// 读取任务输出文件的尾部（最多 `max_chars * 4` 字节，按 UTF-8 解码）。
///
/// 后台任务由子进程直接写文件，这里只取尾部做提醒预览，避免把整个输出读进内存。
pub fn read_output_tail(task_id: &str, max_chars: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let Ok(mut file) = std::fs::File::open(task_output_path(task_id)) else {
        return String::new();
    };
    let Ok(size) = file.metadata().map(|meta| meta.len()) else {
        return String::new();
    };
    if size == 0 {
        return String::new();
    }
    let byte_count = size.min((max_chars as u64).saturating_mul(4)) as usize;
    if file
        .seek(SeekFrom::Start(size - byte_count as u64))
        .is_err()
    {
        return String::new();
    }
    let mut buffer = vec![0u8; byte_count];
    let read = file.read(&mut buffer).unwrap_or(0);
    buffer.truncate(read);
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 构造后台任务的提醒文案（纯文本，纯函数）。
///
/// 文案逐字锁定，差异即对照表测试失败。
#[allow(clippy::too_many_arguments)]
pub fn build_background_reminder_text(
    task_id: &str,
    description: &str,
    command: &str,
    elapsed_ms: u64,
    output: &str,
    next_interval_label: &str,
    kill_command: &str,
) -> String {
    let command_part = if !command.is_empty() && command != description {
        format!("\nCommand: {command}")
    } else {
        String::new()
    };
    let mut lines = vec![
        "<reminder>".to_string(),
        format!("Background bash task {task_id} is still running."),
        format!("Description: {description}{command_part}"),
        format!("Elapsed: {}", format_duration(elapsed_ms)),
    ];

    let output = util::js_trim_end(output);
    if !output.is_empty() {
        let preview = if util::utf16_len(output) > BACKGROUND_REMINDER_OUTPUT_CHARS {
            format!(
                "...\n{}",
                util::utf16_tail(output, BACKGROUND_REMINDER_OUTPUT_CHARS)
            )
        } else {
            output.to_string()
        };
        lines.push(format!(
            "Current output (last {BACKGROUND_REMINDER_OUTPUT_CHARS} chars):"
        ));
        lines.push(preview);
    }

    lines.push(format!("Next reminder in {next_interval_label}."));
    lines.push(format!(
        "If this task is no longer needed, kill it: {kill_command}"
    ));
    lines.push("Do not sleep or poll; if there is nothing else to do, end this turn.".to_string());
    lines.push("</reminder>".to_string());
    lines.join("\n")
}

// ==================== 进程 ====================

/// 启动后台命令（对齐 `Exec.execBackground`）：
/// stdout/stderr 直接重定向到输出文件，立即返回 `taskId`；完成后由等待线程
/// 经 `hooks.notify` 注入通知。
pub fn spawn_background(
    command: &str,
    cwd: &str,
    description: &str,
    session_id: &str,
    hooks: Option<Hooks>,
) -> Result<String, String> {
    let task_id = generate_task_id();
    let path = task_output_path(&task_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("mkdir task output dir failed: {err}"))?;
    }
    // file mode：子进程的 stdout/stderr 直接指向同一个文件句柄（三个 fd 共享
    // 同一个文件偏移）。
    let file = std::fs::File::create(&path)
        .map_err(|err| format!("Failed to open output file for background command: {err}"))?;
    let stdout = Stdio::from(
        file.try_clone()
            .map_err(|err| format!("Failed to duplicate output file handle: {err}"))?,
    );
    let stderr = Stdio::from(file);

    let shell = crate::shell::shell();
    let mut cmd = Command::new(&shell.path);
    cmd.args(&shell.args)
        .arg(command)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    util::hide_console(&mut cmd);
    // 后台命令与前台命令看同一份 PATH（`docs/core/standalone-core.md` 第 3.2 节）
    crate::shell_env::apply(&mut cmd)?;

    let child = cmd.spawn().map_err(|err| err.to_string())?;
    let pid = child.id();
    let kill = Arc::new(AtomicBool::new(false));
    TASKS.lock().unwrap().push(TaskRecord {
        task_id: task_id.clone(),
        description: description.to_string(),
        command: command.to_string(),
        session_id: session_id.to_string(),
        pid,
        start_time: util::now_millis(),
        status: TaskStatus::Running,
        exit_code: None,
        kill: Arc::clone(&kill),
    });
    if let Some(hooks) = &hooks {
        (hooks.sync_background)(session_id);
    }
    watch(child, task_id.clone(), pid, kill, hooks);
    Ok(task_id)
}

/// 把一个「已在运行、输出已重定向到文件」的进程登记为后台任务（自动转后台用），
/// 返回它的 kill 标记（交给 `watch_backgrounded`）。
pub fn register_running(
    task_id: &str,
    description: &str,
    command: &str,
    session_id: &str,
    pid: u32,
    hooks: Option<Hooks>,
) -> Arc<AtomicBool> {
    let kill = Arc::new(AtomicBool::new(false));
    TASKS.lock().unwrap().push(TaskRecord {
        task_id: task_id.to_string(),
        description: description.to_string(),
        command: command.to_string(),
        session_id: session_id.to_string(),
        pid,
        start_time: util::now_millis(),
        status: TaskStatus::Running,
        exit_code: None,
        kill: Arc::clone(&kill),
    });
    if let Some(hooks) = &hooks {
        (hooks.sync_background)(session_id);
    }
    kill
}

/// 把已在运行的子进程交给等待线程（自动转后台用）：线程只负责轮询退出 + 收尾通知。
pub fn watch_backgrounded(child: Child, task_id: String, kill: Arc<AtomicBool>, hooks: Option<Hooks>) {
    let pid = child.id();
    watch(child, task_id, pid, kill, hooks);
}

fn watch(mut child: Child, task_id: String, pid: u32, kill: Arc<AtomicBool>, hooks: Option<Hooks>) {
    std::thread::spawn(move || {
        let exit_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None) => {}
                Err(_) => break -1,
            }
            if kill.load(Ordering::Relaxed) {
                kill_tree(&mut child, pid);
                break child
                    .wait()
                    .ok()
                    .and_then(|status| status.code())
                    .unwrap_or(-1);
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        };
        handle_finish(&task_id, exit_code, &hooks);
    });
}

/// 任务结束的统一收尾（对齐 `LocalShellTask` 的 `shellCommand.result.then(...)`）。
///
/// 顺序：慢步骤（读输出文件 / 拼通知 / 完成事件监听器）在前，`notify` 先于
/// `sync_background`。`notify` 唤醒引擎置 `running`（推 idle=false 运行时快照），
/// 随后 `sync_background` 清 `background` 时 `running` 仍真——两份快照的 idle
/// 恒为 false，完成通知触发的接续查询之前不会先推一份「瞬时 idle」被宿主差分成
/// running → idle 而误武装「任务完成」绿灯。引擎不接续（会话已关闭等）时 notify
/// 不置 running，`sync_background` 推出的 idle 才是真实完成，照常武装。
fn handle_finish(task_id: &str, exit_code: i32, hooks: &Option<Hooks>) {
    let Some(finished) = finish_task(task_id, exit_code) else {
        // 记录已被移除（会话中止 / 关闭）：丢弃输出与通知
        return;
    };
    // 完成事件（前台命令据此决定是否自动转后台）
    emit_task_completed(&finished);
    // file mode 的 stdout 就是输出文件内容（对齐 `TaskOutput.getStdout`）
    let stdout = std::fs::read_to_string(task_output_path(task_id)).unwrap_or_default();
    let notification = build_completion_notification(&finished, &stdout);
    if let Some(hooks) = hooks {
        (hooks.notify)(&finished.session_id, &notification);
        (hooks.sync_background)(&finished.session_id);
    }
}

/// 杀掉子进程树（对齐 `ShellCommand._doKill`）。
///
/// Windows 上 `Child::kill` 只终止直接子进程；`bash -c "sleep 30"` 的 `sleep` 是
/// 孙进程，必须用 `taskkill /T` 连树一起杀，否则会留下孤儿进程。
///
/// 顺序是「先 `taskkill` 再 `child.kill()`」：`taskkill /T` 按父 PID 枚举子树，
/// 根进程先被 `child.kill()` 杀掉后进程对象消失，子树枚举可能落空——命令会带着
/// 孤儿继续跑（`specs/defects/bash-abort-does-not-kill-process-tree.md`）。
pub(crate) fn kill_tree(child: &mut Child, pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        util::hide_console(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
    // `taskkill` 不可用 / 根进程已退出时的兜底；已退出时返回 Err，忽略即可。
    let _ = child.kill();
}

#[cfg(test)]
#[path = "bash_task_tests.rs"]
mod tests;

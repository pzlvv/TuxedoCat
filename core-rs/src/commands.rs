//! 内置命令系统与统一调度层（对齐 Embedded `src/core/skills/builtinCommands.ts`
//! 与 `src/core/CommandDispatcher.ts`）。
//!
//! 内置命令（BuiltinCommand）是与 Skill 并行的 `/` 触发机制：
//! - 内置命令由 Core 直接处理（不经过 LLM），可以有客户端副作用
//! - 内置命令名称与 Skill 冲突时，记录 WARNING 并忽略冲突的 Skill
//!
//! 调度优先级（`dispatch`）：
//! 1. 内置命令（如 `/spin`）→ `Handled`
//! 2. Skill 命令（如 `/commit`）→ `Skill { .. }`，由调用方注入 Skill tool_use
//! 3. 其他 `/` 开头文本 → `Passthrough`，按普通消息进 LLM

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::core_text;
use crate::skills;

/// 命令执行上下文
#[derive(Clone)]
pub struct CommandContext {
    /// 当前会话 ID
    pub session_id: String,
    /// 工作目录
    pub cwd: String,
    /// 命令名称（如 `spin`），由 dispatch 自动填充
    pub command_name: Option<String>,
    /// core → UI 事件发送器（对齐 Embedded 的 `requireEventBus().emitToUi`）
    pub emit: Arc<dyn Fn(Value) + Send + Sync>,
    /// `/spin` 非 `design` 分支的执行钩子：由引擎注入（启动 Spin 主循环）。
    ///
    /// 内置命令的实现不引用引擎类型（`commands.rs` 不依赖 `engine.rs`），
    /// 因此这条需要「跑整个 Spin 流程」的分支走注入：参数是命令参数，返回值与
    /// `execute` 一致（`Some(text)` 时 dispatch 上报一条 system 消息）。
    pub start_spin: Option<Arc<dyn Fn(&str) -> Option<String> + Send + Sync>>,
}

impl CommandContext {
    fn emit(&self, event: Value) {
        (self.emit)(event);
    }
}

/// 命令执行回调：返回 `Some(text)` 时由 dispatch 上报一条 system 消息
pub type ExecuteFn = Arc<dyn Fn(&str, &CommandContext) -> Option<String> + Send + Sync>;

/// 内置命令定义
#[derive(Clone)]
pub struct BuiltinCommandDefinition {
    pub name: String,
    /// 文案键（`core_text.rs`）；Core 不拼文案，翻译在 UI
    pub description: String,
    pub aliases: Vec<String>,
    pub execute: ExecuteFn,
}

/// 内置命令运行时对象
#[derive(Clone)]
pub struct BuiltinCommand {
    pub name: String,
    /// 文案键（斜杠补全列表用；宿主侧消费见 M7）
    #[allow(dead_code)]
    pub description: String,
    pub aliases: Vec<String>,
    pub execute: ExecuteFn,
}

/// 内部注册表
static BUILTIN_COMMANDS: Mutex<Vec<BuiltinCommandDefinition>> = Mutex::new(Vec::new());
/// 已注册名称集合（含别名，用于冲突检测）
static REGISTERED_NAMES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 注册一个内置命令
pub fn register_builtin_command(definition: BuiltinCommandDefinition) {
    {
        let mut names = REGISTERED_NAMES.lock().unwrap();
        names.push(definition.name.clone());
        for alias in &definition.aliases {
            names.push(alias.clone());
        }
    }
    BUILTIN_COMMANDS.lock().unwrap().push(definition);
}

/// 获取所有已注册的内置命令
pub fn builtin_commands() -> Vec<BuiltinCommand> {
    skills::ensure_builtins();
    BUILTIN_COMMANDS
        .lock()
        .unwrap()
        .iter()
        .map(|command| BuiltinCommand {
            name: command.name.clone(),
            description: command.description.clone(),
            aliases: command.aliases.clone(),
            execute: Arc::clone(&command.execute),
        })
        .collect()
}

/// 仅测试用：清空注册表
#[cfg(test)]
pub fn clear_builtin_commands() {
    BUILTIN_COMMANDS.lock().unwrap().clear();
    REGISTERED_NAMES.lock().unwrap().clear();
}

/// 指定名称是否与已注册的内置命令冲突
pub fn is_builtin_command_name(name: &str) -> bool {
    REGISTERED_NAMES.lock().unwrap().iter().any(|item| item == name)
}

/// 所有内置命令名称（含别名）
#[allow(dead_code)]
pub fn builtin_command_names() -> Vec<String> {
    REGISTERED_NAMES.lock().unwrap().clone()
}

/// 检查 Skill 名称是否与内置命令冲突，冲突时记 WARNING
pub fn check_skill_conflict(skill_name: &str, aliases: &[String]) -> bool {
    let mut names = vec![skill_name.to_string()];
    names.extend(aliases.iter().cloned());
    for name in names {
        if is_builtin_command_name(&name) {
            eprintln!(
                "[core] BuiltinCommands: Skill \"{skill_name}\" conflicts with built-in command \
                 \"{name}\". The Skill will be ignored. Use a different skill name to avoid conflict."
            );
            return true;
        }
    }
    false
}

// ==================== 派遣 ====================

/// 派遣结果
#[derive(Clone, Debug, PartialEq)]
pub enum DispatchOutcome {
    /// 内置命令已就地执行（消息不进 LLM 上下文）
    Handled,
    /// 命中 Skill：调用方据此注入 Skill tool_use
    Skill { skill_name: String, skill_args: String },
    /// 不是内置命令也不是 Skill，走正常 LLM 流程
    Passthrough,
}

/// 派遣一条用户消息（对齐 `CommandDispatcher.dispatch`）
pub fn dispatch(prompt: &str, context: &CommandContext) -> DispatchOutcome {
    // 只处理以 `/` 开头的消息。
    // `prompt.trim()` 必须用 JS 空白口径（ECMAScript WhiteSpace + LineTerminator）：
    // Rust 的 `str::trim` 含 U+0085 却不含 U+FEFF，会让 `/` 前面带这两种字符的消息
    // 在两侧分别命中 / 落空（对照表 `commandDispatch` 的空白用例）。
    let trimmed = crate::util::js_trim(prompt);
    if !trimmed.starts_with('/') {
        return DispatchOutcome::Passthrough;
    }

    // 解析命令名和参数。参数用 `[\s\S]` 而非 `.`：多行输入
    // （如 `/commit 修复 A\n再修 B`）也必须能匹配到，否则会被判为 passthrough。
    let Some(rest) = trimmed.strip_prefix('/') else {
        return DispatchOutcome::Passthrough;
    };
    let (cmd_name, cmd_args) = match rest.find(crate::util::is_js_whitespace) {
        Some(index) => {
            let name = &rest[..index];
            // 只去前导空白：`\s+` 之后是 `[\s\S]*`，尾随空白属于参数
            let args = rest[index..].trim_start_matches(crate::util::is_js_whitespace);
            (name, args)
        }
        None => (rest, ""),
    };
    // `^\/(\S+)(?:\s+([\s\S]*))?$`：命令名不能含空白；含空白说明首个 token 为空
    if cmd_name.is_empty() {
        return DispatchOutcome::Passthrough;
    }

    // 1. 查找匹配的内置命令（含别名）
    let commands = builtin_commands();
    let matched = commands
        .iter()
        .find(|command| command.name == cmd_name || command.aliases.iter().any(|a| a == cmd_name));

    if let Some(command) = matched {
        eprintln!("[core] CommandDispatcher: Dispatching builtin command: /{cmd_name} {cmd_args}");

        let mut cmd_context = context.clone();
        cmd_context.command_name = Some(command.name.clone());

        // 通知 UI 层执行客户端操作（如 /spin 打开设计器）
        context.emit(json!({
            "type": "commandDispatched",
            "sessionId": context.session_id,
            "commandName": command.name,
            "args": cmd_args,
        }));

        // 对齐 Embedded：`if (result)` 只上报非空返回值
        if let Some(result) = (command.execute)(cmd_args, &cmd_context) {
            if !result.is_empty() {
                context.emit(json!({
                    "type": "message",
                    "sessionId": context.session_id,
                    "data": { "role": "system", "content": result },
                }));
            }
        }

        return DispatchOutcome::Handled;
    }

    // 2. 检查是否匹配 Skill 名称（非内置命令的 / 命令）
    let all_skills = skills::get_all_skills(&context.cwd);
    let trimmed_name = cmd_name.trim_start_matches('/');
    if let Some(skill) = all_skills
        .into_iter()
        .find(|skill| skill.matches(trimmed_name))
    {
        eprintln!(
            "[core] CommandDispatcher: Matched skill: /{cmd_name}, returning 'skill' result"
        );
        return DispatchOutcome::Skill {
            skill_name: skill.name,
            skill_args: cmd_args.to_string(),
        };
    }

    // 3. 不是内置命令也不是 Skill，走正常 LLM 流程
    DispatchOutcome::Passthrough
}

// ==================== 内置命令定义 ====================

/// 内置 `spin` 命令（对齐 `bundled/spin.ts`）。
///
/// `design` 分支返回 `None`（UI 经 `commandDispatched` 打开设计器）；`auto` / 其它
/// 分支由引擎注入的 `start_spin` 钩子在本线程跑完整个 Spin 主循环
/// （`spin_host::run_spin_command` ↔ Embedded `skills/bundled/spin.ts`）。
/// 钩子未注入（单测 / 未接线装配）时发 `notice` 提示不可用，不静默降级。
pub fn spin_command_definition() -> BuiltinCommandDefinition {
    BuiltinCommandDefinition {
        name: "spin".to_string(),
        description: core_text::SPIN_COMMAND_DESCRIPTION.to_string(),
        aliases: vec!["sprint".to_string()],
        execute: Arc::new(|args: &str, context: &CommandContext| {
            // 对齐 `bundled/spin.ts` 的 `args.trim() || 'auto'`（JS 空白口径）
            let trimmed = if crate::util::js_trim(args).is_empty() {
                "auto".to_string()
            } else {
                crate::util::js_trim(args).to_string()
            };

            if trimmed == "design" {
                // UI 层通过 commandDispatched 打开设计器
                return None;
            }

            // 其余分支（`auto` 等）交给引擎注入的钩子：它会检测 spin.json 状态、
            // 必要时跑完整个 Spin 主循环（对齐 Embedded `bundled/spin.ts`）。
            if let Some(start) = &context.start_spin {
                return start(&trimmed);
            }

            // 没有注入钩子（单测 / 未接线的装配）：明确报错而不是静默什么都不做。
            // 瞬时提示只给「键 + 参数」，翻译在 UI（`docs/core-ui-separation.md` 第 4.9 节）。
            context.emit(json!({
                "type": "notice",
                "sessionId": context.session_id,
                "key": core_text::SPIN_ENGINE_NOT_WIRED,
                "params": {},
                "level": "error",
            }));
            None
        }),
    }
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;

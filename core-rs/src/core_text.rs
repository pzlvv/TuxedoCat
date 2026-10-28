//! Core 面向界面的文案键（`docs/architecture/core-ui-separation.md` 第 4.8 / 4.9 节）。
//!
//! Core 不感知语言：瞬时状态提示以「键 + 参数」表达，经 `CoreEvent.notice` 交给 UI
//! 翻译；内置命令的描述同样以键表达。这些键必须在 UI 翻译表里存在，由
//! `src/test/coreTextParity.test.ts` 与 `core_text_tests.rs` 对照同一份
//! `core-rs/fixtures/coreTextKeys.json` 锁定。
//!
//! 落盘文本（进 JSONL / LLM 上下文）不在这里：那部分一律英文常量，不参与键化。

/// `/spin` 未接线（单测 / 未装配的宿主）
pub const SPIN_ENGINE_NOT_WIRED: &str = "notice.spin.engineNotWired";
/// 没有 spin.json 设计文件
pub const SPIN_DESIGN_MISSING: &str = "notice.spin.designMissing";
/// 有设计文件但读不出来
pub const SPIN_CANNOT_READ: &str = "notice.spin.cannotRead";
/// 设计存在空节点
pub const SPIN_EMPTY_NODE: &str = "notice.spin.emptyNode";
/// 设计不是 DAG
pub const SPIN_NOT_DAG: &str = "notice.spin.notDag";
/// 存在未赋值的变量（不带变量名）
pub const SPIN_VARIABLE_NO_VALUE: &str = "notice.spin.variableNoValue";
/// 存在未赋值的变量（`{names}` 为变量名列表）
pub const SPIN_VARIABLE_NO_VALUE_WITH_NAMES: &str = "notice.spin.variableNoValueWithNames";
/// spin.json 格式不合法
pub const SPIN_INVALID: &str = "notice.spin.invalid";
/// Spin 主循环跑完
pub const SPIN_ALL_COMPLETED: &str = "notice.spin.allCompleted";

/// 内置命令描述的键（斜杠补全列表的 `description`）
pub const SPIN_COMMAND_DESCRIPTION: &str = "command.spin.description";
/// 会话被其他实例占用，无法装载（specs/032）；参数 `{pid}` 为持有者
pub const SESSION_LOCKED_OPEN: &str = "notice.session.lockedOpen";
/// 会话被其他实例占用，变更被拒绝（specs/032）；参数 `{pid}` 为持有者
pub const SESSION_LOCKED_CHANGE: &str = "notice.session.lockedChange";

/// Core 用到的全部界面文案键（供对等测试与键表生成；生产路径逐项直接引用常量）
#[cfg_attr(not(test), allow(dead_code))]
pub const CORE_TEXT_KEYS: [&str; 12] = [
    SPIN_ENGINE_NOT_WIRED,
    SPIN_DESIGN_MISSING,
    SPIN_CANNOT_READ,
    SPIN_EMPTY_NODE,
    SPIN_NOT_DAG,
    SPIN_VARIABLE_NO_VALUE,
    SPIN_VARIABLE_NO_VALUE_WITH_NAMES,
    SPIN_INVALID,
    SPIN_ALL_COMPLETED,
    SPIN_COMMAND_DESCRIPTION,
    SESSION_LOCKED_OPEN,
    SESSION_LOCKED_CHANGE,
];

#[cfg(test)]
#[path = "core_text_tests.rs"]
mod tests;

//! `branchStateChanged` 载荷组装（specs/037 FR-008）。
//!
//! 视图只带渲染「标题前分支名」所需的最小事实——分支名、worktree 路径、base：
//!
//! - 不带 `commits` / `dirty`（提交历史不上 UI；回退交给 `git reset`）；
//! - 不带 `peers`（并行分支在对话列表的分支名里看）；
//! - 不带 `deps`（依赖策略不改变用户行为，装了就能用）。
//!
//! 这是刻意的窄口径：多一个字段就多一个要维护、要同步、要对着 docsLint 校验的东西，
//! 而它不改善任何用户可见行为（specs/037 FR-008）。

use serde_json::{json, Value};

/// 分支会话的事实（`meta.json` 的 `branch` 字段与内存态共用这一份形状）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchFacts {
    /// 分支名（不含 `tuxedo/` 前缀）
    pub name: String,
    /// worktree 绝对路径（在 Core 数据目录内，不在仓库里）
    pub worktree: String,
    /// 创建时的基准提交（完整 id）
    pub base_commit: String,
    /// 创建时的基准分支名
    pub base_branch: String,
}

impl BranchFacts {
    /// 落盘形态（`meta.json` 的 `branch` 字段；TS 侧 `ConversationMetadata.branch`
    /// 同名字段读取，两侧同步测试锁定）
    pub fn to_meta(&self) -> Value {
        json!({
            "name": self.name,
            "worktree": self.worktree,
            "baseCommit": self.base_commit,
            "baseBranch": self.base_branch,
        })
    }

    /// 从 `meta.json` 的 `branch` 字段读回；缺失 / 形态不对返回 `None`
    /// （旧会话没有该键一律按普通会话处理，specs/037 AC-30）
    pub fn from_meta(value: Option<&Value>) -> Option<BranchFacts> {
        let value = value?;
        if !value.is_object() {
            return None;
        }
        Some(BranchFacts {
            name: value.get("name").and_then(Value::as_str)?.to_string(),
            worktree: value.get("worktree").and_then(Value::as_str)?.to_string(),
            base_commit: value.get("baseCommit").and_then(Value::as_str)?.to_string(),
            base_branch: value.get("baseBranch").and_then(Value::as_str)?.to_string(),
        })
    }

    /// git 分支名（`tuxedo/<name>`）
    pub fn branch_ref(&self) -> String {
        crate::branch::naming::branch_ref(&self.name)
    }
}

/// `unavailable` 的原因（判别联合，不用可选字段）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnavailableReason {
    /// 目录不是 git 仓库（或不在仓库内）
    NotGit,
    /// worktree 目录不存在（用户手动删除 / `git worktree prune`）
    WorktreeMissing,
    /// git 命令失败（仓库锁 / 分支被删 / 其它）
    GitFailed,
}

impl UnavailableReason {
    /// 契约里的字面量（webview / 宿主按它选文案）
    pub fn as_str(self) -> &'static str {
        match self {
            UnavailableReason::NotGit => "not-git",
            UnavailableReason::WorktreeMissing => "worktree-missing",
            UnavailableReason::GitFailed => "git-failed",
        }
    }
}

/// `branchStateChanged.view` 的三态
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchView {
    /// 不是分支会话
    Plain,
    /// 分支会话就绪
    Ready(BranchFacts),
    /// 分支会话不可用（异常提示，不是常驻状态区）
    Unavailable {
        reason: UnavailableReason,
        detail: String,
    },
}

impl BranchView {
    /// 契约载荷（`CoreEvent.branchStateChanged.view`）
    pub fn to_payload(&self) -> Value {
        match self {
            BranchView::Plain => json!({ "state": "plain" }),
            BranchView::Ready(facts) => json!({
                "state": "ready",
                "branch": facts.name,
                "worktree": facts.worktree,
                "baseCommit": facts.base_commit,
                "baseBranch": facts.base_branch,
            }),
            BranchView::Unavailable { reason, detail } => json!({
                "state": "unavailable",
                "reason": reason.as_str(),
                "detail": detail,
            }),
        }
    }
}

// 事件本身的组装（`{"type": "branchStateChanged", …}` 字面量）落在 `engine.rs` 的
// `Core::emit_branch_view`：emit 位点归会话引擎所有，本模块只负责**载荷**（view）的
// 形态与窄口径。这样 `docsLint` 的 2.1 触发点列对照（只扫 `core-rs/src/*.rs` 顶层
// 模块）仍能对上真实 emit 位点。

#[cfg(test)]
#[path = "state_tests.rs"]
mod tests;

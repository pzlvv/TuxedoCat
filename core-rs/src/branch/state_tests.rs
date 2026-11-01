//! `branchStateChanged` 载荷组装（specs/037 FR-008）

use serde_json::json;

use crate::branch::state::{BranchFacts, BranchView, UnavailableReason};

fn facts() -> BranchFacts {
    BranchFacts {
        name: "ellen-k3f".to_string(),
        worktree: "/core/worktrees/ellen-k3f".to_string(),
        base_commit: "abcdef1234567890".to_string(),
        base_branch: "main".to_string(),
    }
}

/// `plain`：该会话不是分支对话
#[test]
fn plain_view_carries_only_the_state() {
    let view = BranchView::Plain.to_payload();
    assert_eq!(view, json!({ "state": "plain" }));
    assert_eq!(view.as_object().expect("object").len(), 1);
}

/// `ready`：只带分支名 / worktree / base 四个事实
#[test]
fn ready_view_carries_the_minimal_fact_set() {
    let view = BranchView::Ready(facts()).to_payload();
    assert_eq!(view["state"], json!("ready"));
    assert_eq!(view["branch"], json!("ellen-k3f"));
    assert_eq!(view["worktree"], json!("/core/worktrees/ellen-k3f"));
    assert_eq!(view["baseCommit"], json!("abcdef1234567890"));
    assert_eq!(view["baseBranch"], json!("main"));
    // 窄口径断言：**不含** commits / dirty / peers / deps
    for absent in ["commits", "dirty", "peers", "deps"] {
        assert!(
            view.get(absent).is_none(),
            "view must not carry `{absent}` (specs/037 FR-008 窄口径)"
        );
    }
    assert_eq!(view.as_object().expect("object").len(), 5);
}

/// `unavailable`：判别联合的 reason + 原文 detail
#[test]
fn unavailable_view_carries_reason_and_detail() {
    for (reason, expected) in [
        (UnavailableReason::NotGit, "not-git"),
        (UnavailableReason::WorktreeMissing, "worktree-missing"),
        (UnavailableReason::GitFailed, "git-failed"),
    ] {
        let view = BranchView::Unavailable {
            reason,
            detail: "boom".to_string(),
        }
        .to_payload();
        assert_eq!(view["state"], json!("unavailable"));
        assert_eq!(view["reason"], json!(expected));
        assert_eq!(view["detail"], json!("boom"));
        assert_eq!(view.as_object().expect("object").len(), 3);
    }
}

/// `ready` 视图的完整形态（事件字面量在 `engine.rs` 的 emit 位点组装）
#[test]
fn ready_payload_is_the_contract_shape() {
    let view = BranchView::Ready(facts()).to_payload();
    assert_eq!(view["state"], json!("ready"));
    assert_eq!(view["branch"], json!("ellen-k3f"));
}

/// `meta.json` 的 `branch` 字段往返（两侧同步测试的 Rust 一半，AC-29）
#[test]
fn branch_facts_round_trip_through_meta() {
    let original = facts();
    let meta = original.to_meta();
    assert_eq!(meta["name"], json!("ellen-k3f"));
    assert_eq!(meta["worktree"], json!("/core/worktrees/ellen-k3f"));
    assert_eq!(meta["baseCommit"], json!("abcdef1234567890"));
    assert_eq!(meta["baseBranch"], json!("main"));
    assert_eq!(meta.as_object().expect("object").len(), 4);
    let parsed = BranchFacts::from_meta(Some(&meta)).expect("parse back");
    assert_eq!(parsed, original);
}

/// 旧会话没有 `branch` 键：读回 `None`，调用方按普通会话处理（AC-30）
#[test]
fn missing_or_malformed_branch_meta_yields_none() {
    assert_eq!(BranchFacts::from_meta(None), None);
    assert_eq!(BranchFacts::from_meta(Some(&json!(null))), None);
    assert_eq!(BranchFacts::from_meta(Some(&json!("ellen-k3f"))), None);
    // 缺字段视为形态不对（不猜值）
    assert_eq!(BranchFacts::from_meta(Some(&json!({ "name": "ellen-k3f" }))), None);
}

/// 分支名带 `tuxedo/` 命名空间（成果出口）
#[test]
fn branch_ref_uses_the_namespace() {
    assert_eq!(facts().branch_ref(), "tuxedo/ellen-k3f");
}

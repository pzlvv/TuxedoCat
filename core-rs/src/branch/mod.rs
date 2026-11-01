//! 分支对话（git worktree 隔离，specs/037）。
//!
//! 模块划分（单向被 `engine.rs` 调用，不与 `tools.rs` 形成循环依赖）：
//!
//! | 文件 | 职责 |
//! | --- | --- |
//! | [`repo`] | 仓库探测、脏工作区判定、`branchPrecheckRequested` 应答 |
//! | [`worktree`] | worktree 创建 / 复用 / 清理 / 启动对账 |
//! | [`state`] | `branchStateChanged` 载荷组装（`plain` / `ready` / `unavailable`） |
//! | [`deps`] | `DepStrategy` + `OverlayDeps` / `SkipDeps` + 单文件本地配置 |
//! | [`naming`] | 分支命名（角色名 + 3 位随机后缀） |
//!
//! **worktree 在 Core 数据目录、不在仓库里**（specs/037 FR-002）：这是「分支对主工作区
//! 不可见」的全部机制，不靠权限、不靠过滤、不靠监视白名单。成果出口是用户在主工作区
//! 执行 `git merge tuxedo/<name>`——本能力不做发布、不做三方对账。

pub mod deps;
pub mod naming;
pub mod repo;
pub mod state;
pub mod worktree;

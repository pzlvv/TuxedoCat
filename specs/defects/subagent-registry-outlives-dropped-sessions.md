---
status: 已修
---

# 缺陷：子代理注册表条目随会话终结残留，进程生命周期内单调增长

子代理注册表（`core-rs/src/subagent.rs` 的 `AGENTS`）只在创建子代理时 `register`，
会话被关闭 / 删除后它作为子代理的条目无人注销：条目数随进程处理过的子代理总数单调
增长。这正是 [specs/005 归档](../../docs/archive/specs/005-subagent-concurrency-limit/spec.md)
收敛反向对照登记进 TODO.md 的存量缺口。

## 现状

- `AGENTS` 条目的生产写入点只有 `register`（`create_sub_agent` 路径）；`unregister`
  挂着 `#[cfg_attr(not(test), allow(dead_code))]`，没有任何生产调用方。
- `Core::drop_session`（`core-rs/src/engine.rs`）清理 `SessionState`、待压缩注册表、
  会话 todos 与 MCP 引用，唯独不注销该会话自身的子代理条目。会话经
  `on_conversation_closed`（关闭）或 `on_conversation_deleted`（删除，整个闭包逐个
  drop）终结后，条目永久残留。
- 残留条目对注册表的三个使用方（`Reply` 反查创建者、`idle` 递归、中止 / 关闭递归覆盖
  子孙）都不可达——被 drop 的会话已从 `sessions` 移除、不可能再 Reply 或运行，纯泄漏。
- 模块注释把「只注册不注销」登记为现状语义：保留**存活**子代理的条目是为了
  「稍后再中止该会话仍能覆盖到子代理」（子代理一轮结束后可能仍在跑后台任务、也可被
  重新打开）。缺口不在「一轮后不注销」，在「会话终结后仍不注销」。
- TODO.md 原 entry 提到的 TS 侧 `SubAgentRegistry.unregister` 已随重构消失（TS 侧无
  此类，仅 `AssistantEventBus.ts` 的 `parentSessionId` 注释还以概念形式提到）；缺口只在
  Rust 侧。
- 既有用例（`core-rs/src/subagent_tests.rs`）只锁 register / 查询与并发槽位语义，
  没有用例断言「drop_session 后条目释放」。

## 期望

- `Core::drop_session` 注销该会话**自身**的子代理条目（`AGENTS` 中 id 等于被 drop
  会话的记录）。
- 存活会话的条目不受影响：drop 会话 A 时，其它创建者的条目、A 的存活子孙的条目
  原样保留，「稍后再中止仍覆盖到存活子代理」的现状行为不变。

## 不变量

- 注销范围只有被 drop 会话自身的条目，**不做子树级联**：`on_conversation_closed` 只
  drop 顶层会话，子孙会话仍存活（可重开、可能仍在跑后台任务），其条目必须保留，
  否则就改变了递归中止的可达范围。「子代理完成一轮即注销」因同一理由否决——一轮
  结束 ≠ 子代理终结（后台任务、重开继续对话都发生在轮次之后）。
- `register`（重复登记覆盖）与查询函数语义不变。

## 回归测试

- **RT-1**：`register("sub_child", "sess_parent")` 后 `drop_session("sub_child")`，
  `creator_of("sub_child")` 为 `None`（落点：`core-rs/src/subagent_tests.rs`
  `drop_session_unregisters_the_dropped_sessions_subagent_entry`）。
- **RT-2**：`register("sub_survivor", "sess_parent")` 后 `drop_session("sess_parent")`，
  `creator_of("sub_survivor")` 仍为 `Some("sess_parent")`——注销不级联到存活子代理
  （落点：同文件 `drop_session_keeps_surviving_children_registered`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc drop_session_ -- --test-threads=1` | 红 | RT-1 失败在 `creator_of("sub_child")` 断言：实测 `left: Some("sess_parent"), right: None`——drop 后条目确实残留；RT-2（不级联）现状即绿，说明红的只是「自身条目不注销」 |
| 回归用例（修复后） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc drop_session_ -- --test-threads=1` | 绿 | 2 passed / 0 failed：RT-1 / RT-2 全过。修复是 `drop_session` 增加一行 `crate::subagent::unregister(session_id)`（注销自身条目、不级联），`unregister` 同时摘掉 `allow(dead_code)` |
| 既有回归（core 全量） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc -- --test-threads=1` | 绿 | 914 passed / 0 failed（含 specs/005 的递归中止与并发槽位全部用例，注销接线后无回归）。`--target` 同上：本机默认目标在 `ring` 的 build script 上缺 `clang`，显式指定宿主三元组 |
| 文档守卫 | `npm run test:all -- docs-lint` | 部分验证 | 本规格落定后，路径 / 标识符 / 用例落点的存活检查按「落定态落点存活」分档放行全过；全仓 docs-lint 的其余红来自并行会话实施中的 `specs/019-*`、`specs/020-*` 草稿（裸章节引用等，收敛闸门前会清），与本缺陷无关 |

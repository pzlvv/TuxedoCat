---
status: 已修
---

# 缺陷：`@` 工作区命令在查询中途出队时丢失 reminder

`@` 工作区命令的 reminder 只在消费循环的**轮次边界**解析（`resolve_pending_mention`），
而查询中途的排队消息由 `flush_queued_messages` 直接并入下一次 LLM 请求、不经过该解析。
于是同一条 `@` 消息的可见效果取决于用户按下发送的时机：会话空闲或刚好在轮次边界发出时
模型拿到 reminder；在多步工具调用进行中发出时模型只看到裸的 `@HOST:/path 正文`，
不会调用带 `target` 的 `Agent`。同一条规则下还有一处残留：撤回（编辑 / 删除）队列里的
`@` 消息后，已算出的 reminder 留在会话状态上，会挂到下一批用户消息上。

## 现状

- `@` 命令的唯一解析点是 `core-rs/src/engine.rs` 的 `resolve_pending_mention`，唯一调用点
  在 `run_consumer_with_ui` 的轮次边界（`take_queued_batch(&state, true)` 之前）。
- 查询中途的排队消息走另一条出口：`run_query_loop` 每次 LLM 请求前调
  `flush_queued_messages` → `take_queued_batch(state, false)`。该出口只按 `/` 前缀把
  **命令消息**留在队列里等轮次边界（`include_command_user_message || !js_trim(text).starts_with('/')`），
  `@` 开头的消息不在此列，随即被 `persist_user_message` 并入上下文。
- 这条出口不调用 `resolve_pending_mention`，`pending_mention_reminder` 从未置位；消息出队后
  不在队列里，轮次边界也不会再看到它——reminder 永久丢失。
- 撤回路径 `Core::on_queued_message_discarded` 清 `pending_user_message` 与
  `pending_skill_injection`，不清 `pending_mention_reminder`。
- 文档侧：`docs/features/user-message-pipeline.md` 的 `@` 命令条目（FR-002 段末）与
  `docs/features/cross-workspace-agent.md` 的 FR-008 都写「Core 在轮次边界识别 `@` 命令」，
  把上述时机依赖写成了规格；`take_queued_batch` 的过滤条件还只覆盖 `/`。
- 复现（假 LLM）：第 0 次请求返回 `openai_tool_sse` 并在回调里 `on_user_message("@HOST:/b 把这件事做了")`，
  断言第 1 次请求体。现状第 1 次请求只含 `@` 原文、无 `<Reminder>`；落盘消息里也没有 reminder 那条。
- 对照（同一消息在轮次边界出队）：reminder 正常注入并落盘为 `silent` / `origin=agent` 的
  user 消息。

## 期望

统一口径：**一条用户消息的可观察效果由消息自身决定，与它到达 / 出队的时机无关**。

1. `@` 开头的用户消息无论在轮次边界还是查询中途出队，都在该消息之后注入一条 silent
   reminder（点名目标身份、`Agent.target`、`Agent` 工具），并落盘为 `silent` / `origin=agent`
   的 user 消息，顺序为「用户消息 → reminder」。
2. 出队处置统一为一处判定：按消息内容算出它的处置（普通消息 / 带 `@` reminder / 带 Skill
   注入 / 内置命令），消费点不再按「是不是轮次边界」分叉决定是否解析。中途 flush 应用
   与轮次边界相同的注入；只有会改变会话流程、不能在中途生效的内置命令（`/spin` 等）继续
   留到轮次边界。
3. 撤回 / 被新消息替换 / 中止丢弃时，随该消息算出的 reminder 与 Skill 待注入一并清除，
   不得挂到后续消息上。
4. reminder 的身份仍然只在注入时解析、不校验存在性；错误仍由 `Agent` 执行时暴露。
5. 文档按统一口径改写：`docs/features/user-message-pipeline.md` 的 `@` 命令条目与
   `docs/features/cross-workspace-agent.md` FR-008 去掉「只在轮次边界识别」的时机约束。

## 不变量

- 用户消息原文（含 `@` 前缀）不变，不被剥离；reminder 不改写它。
- reminder 仍是 `silent` / `origin=agent`，UI 消息流与回放不展示，`messageCount` 与对话列表
  刷新与今天一致。
- 内置命令仍不进 LLM 上下文、不落盘、不补发用户气泡；`/skill` 的注入顺序仍是
  「用户消息 → `tool_use` → `tool_result`」。
- 宿主能力位 `crossWorkspaceAgent` 为假时（VS Code / TUI）`@` 仍按普通文本处理、不注入。
- 排队语义不变：`take_queued_batch` 仍是唯一出队口，消费优先级、uuid 配对、
  `sub_agent_reply_called` 收尾弃队行为不变。

## 回归测试

- **RT-1**：查询中途追加 `@` 消息 → 下一次请求含 `<Reminder>` 且点名 `target="HOST:/b"`，
  落盘为用户消息紧跟 `silent` / `origin=agent` 的 reminder（落点：
  `core-rs/src/engine_tests.rs` 的 `mention_message_flushed_mid_turn_keeps_its_reminder`）。
- **RT-2**：查询中途追加 `/skill` 命令 → 注入照常发生（Skill tool_use 入参为命令声明的
  技能与参数）；锁定统一后「注入不因中途出队而丢」的同一口径（落点：
  `core-rs/src/engine_tests.rs` 的 `skill_command_flushed_mid_turn_keeps_its_injection`）。
- **RT-3**：撤回队列里的 `@` 消息 → 消息与它的 reminder 一并清除（落点：
  `core-rs/src/engine_tests.rs` 的 `discarded_mention_message_also_drops_its_reminder`）。
- **RT-4**：内置命令与 reminder 同时在队时，轮次边界执行命令不得吞掉 reminder（落点：
  `core-rs/src/engine_tests.rs` 的 `builtin_command_does_not_swallow_a_pending_reminder`）。
- **RT-5**：`@` 处置的宿主能力位门控：`crossWorkspaceAgent` 为假时不算 reminder（落点：
  `core-rs/src/engine_tests.rs` 的 `classify_injection_adds_reminder_only_when_capable`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core mention_message_flushed_mid_turn_keeps_its_reminder` | 红 | 断言「@ 消息的 reminder 不得因为中途出队而丢失」失败：第二次请求体里只有 `@HOST:/b 把这件事做了` 原文，无 `<Reminder>` |
| RT-2（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core skill_command_flushed_mid_turn_keeps_its_injection` | 绿 | 锁定用例：现状 `/` 前缀的消息被留在队列里等轮次边界，注入仍然发生；统一后必须仍绿 |
| RT-3（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core discarded_mention_message_also_drops_its_reminder` | 红 | 断言「撤回的消息其 reminder 不得残留」失败：`on_queued_message_discarded` 只清 `pending_skill_injection` |
| RT-1 / RT-2 / RT-3（修复后） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core -- mention_message_flushed_mid_turn skill_command_flushed_mid_turn discarded_mention_message` | 绿 | 3 passed；reminder 与 Skill 注入均由 `append_user_message` 应用，撤回走同一处清除 |
| RT-4（修复后新增） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core builtin_command_does_not_swallow` | 绿 | 修复中途发现并锁定的顺序缺陷：内置命令改为由 `take_pending_builtin` 在取批次前单独取出，先取批次会连带丢掉并批的 reminder |
| RT-5（修复后新增） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core classify_injection_adds_reminder` | 绿 | 原 `resolve_pending_mention_sets_reminder_only_when_capable` 随侧槽位删除改版为直测分类函数 |
| 既有回归（core 全量） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core` | 部分验证 | 1053 passed / 5 failed，失败全部是 `mcp::tests` 的 stdio 用例；在**无本次改动的干净 HEAD**（临时 worktree，`471b603`）上同样失败，确认为本机 `node -e` 折叠多行脚本导致的环境问题，与本缺陷无关 |
| 既有回归（commands / spin） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core -- commands:: spin_host::` | 绿 | `dispatch` 对照表与 `/spin` 就地执行路径在拆分后行为不变 |
| docs-lint | `npm run compile-tests && node scripts/run-tests.mjs docs-lint` | 绿 | 49 通过 / 0 失败，含 `specs/defects/` 缺陷规格组与反引号标识符存活检查 |
| core 类型检查 | `cargo build --manifest-path core-rs/Cargo.toml --bin standalone-core` | 绿 | 无新增 warning（既有 dead-code warning 与本改动无关） |
| 仓库 rustfmt | `cargo fmt --check` | not-run | 仓库存量代码未按 rustfmt 格式化（`build.rs`、`compact_engine_tests.rs` 等既有差异），本次不引入全库格式化改动 |

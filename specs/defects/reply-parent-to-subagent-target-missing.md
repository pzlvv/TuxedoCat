---
status: 已修
---

# 缺陷：Reply 指向跨工作区子代理时报「会话不存在」，提示词却承诺可追加消息

发起方会话（用户创建的普通会话）调用 `Reply` 并显式传 `targetSessionId` 指向一个**跨工作区**
子代理（`sub_*`）时必然失败，错误文案是「目标会话 `<id>` 不存在」，且把调用者会话 id 标成
`subAgentId`；而系统提示词无条件承诺「可以给子代理追加消息」，模型因此反复踩这条死路。
影响面：多工作区宿主上的所有跨工作区派发场景（US-56），以及任何普通会话看到错误文案后的
后续决策。

## 现状

跨工作区子代理的运行时在目标工作区的 Core 里，发起方 Core 只做 `subagent::register` +
`register_remote` 登记远程记录、**不创建本地会话状态**（`core-rs/src/engine.rs` 的
`spawn_remote_agent`），因此 `Core::deliver_agent_reply` 第一句 `session_if_exists(target)`
取不到目标，兜底分支只覆盖「子代理 → 创建者」方向（读**调用者**的 `creator`，普通会话为
`SessionCreator::User`），命中不了即返回 `目标会话 <id> 不存在`；`run_reply`
（`core-rs/src/tools.rs`）再把这条错误包成「…不存在…当前 subAgentId=<调用者会话 id>」。
同时 `core-rs/src/prompt.rs` 的核心原则与 `Agent` 工具说明两处无条件写明「子代理反馈时用
`Reply` 回消息 / 对子代理有追加要求时用 `Reply` 沟通」，跨工作区子代理运行期间实际收不到。

## 期望

1. 跨工作区子代理作为 `Reply` 目标时，错误文案点明它运行在另一个工作区（`subagent::remote_workspace_of`
   的目标身份）、本机不可投递，并给出可行动作：派发时把要求写全、或等它自己 `Reply`、
   追加任务请新起一个 `Agent`——不再统一说「不存在」。
2. `Reply` 失败文案里调用者会话按其真实语义标注（「当前会话 `<id>`」），不出现
   `subAgentId=<session_*>` 这种错标。
3. 提示词两处收窄承诺：`Reply` 用于回投创建者、以及投递给**本工作区**的子代理；跨工作区
   子代理运行期间收不到追加消息，要求需在派发时写全。

## 不变量

- 「子代理 → 创建者」的跨工作区回投路径不变：目标等于调用者 `creator` 指向的会话时仍发
  `CoreEvent.crossWorkspaceAgentReplyRequested`（`docs/features/cross-workspace-agent.md` FR-003）。
- 本地子代理仍是可投递目标：`deliver_agent_reply` 对本地子会话照常入队 `agent_messages`，
  工具返回成功文本 `message` 原文。
- spin 语义（[docs/features/user-message-pipeline.md FR-007](../../docs/features/user-message-pipeline.md#fr-007spin-模式下的用户输入与-reply-投递)）与 `sub_agent_reply_called`
  置位时机不变。
- 事件词汇表不动：本次不新增事件（反向投递是 L3，候选形态登记进
  `docs/architecture/open-questions.md`）。
- 提示词静态对照表 `core-rs/fixtures/systemPrompt.json` 与 `prompt.rs` 保持逐字一致。

## 回归测试

- **RT-1**：`register_remote` 造态（只有远程登记、无本地会话）后，
  `Core::deliver_agent_reply` 指向该子代理返回错误含「另一个工作区」与目标身份、不含「不存在」
  （落点：`core-rs/src/engine_tests.rs` `reply_to_cross_workspace_subagent_reports_remote_workspace`）。
- **RT-2**：经 `Reply` 工具（`tools::execute` + 引擎 `subagent_hooks`）走同一条路径，
  工具结果点明目标工作区、含「当前会话 <调用者 id>」、不含 `subAgentId=`、不含「不存在」
  （落点：`core-rs/src/engine_tests.rs` `reply_tool_error_for_cross_workspace_target_names_the_remote_workspace`）。
- **RT-3**：本地子代理作目标时 `Reply` 仍投递成功（工具成功文本为 message 原文、
  目标会话 `agent_messages` 收到一条 `origin = agent` 的消息）——先绿，锁住「不要修坏本地路径」
  （落点：`core-rs/src/engine_tests.rs` `reply_to_local_sub_agent_still_delivers`）。
- **RT-4**：提示词两处（核心原则 / `Agent` 工具说明）都点明跨工作区子代理收不到追加消息、
  要求须在派发时写全，且保留「本工作区子代理可投递」的事实
  （落点：`core-rs/src/prompt_tests.rs` `reply_promise_matches_delivery_capability`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml -- reply_` | 红 | RT-1 断言 `error.contains("HOST:/b")` 失败：实测文案是 `目标会话 sub_remote_target 不存在`；RT-2 断言 `text.contains("HOST:/b")` 失败：实测 `Reply 失败: 目标会话 sub_remote_tool 不存在。…当前 subAgentId=session_parent（目标会话 sub_remote_tool 不存在）`（错标同时暴露）；RT-3（本地子代理）现状即绿，说明红的只是跨工作区方向 |
| 回归用例（修复前，提示词） | `cargo test --manifest-path core-rs/Cargo.toml -- reply_promise` | 红 | RT-4 失败在 `核心原则 应点明跨工作区子代理收不到追加消息`——两处提示词都还是无条件承诺 |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml -- reply_to_ reply_promise reply_tool_error` | 绿 | 4 passed / 0 failed：RT-1～RT-4 全过。修复是 `deliver_agent_reply` 在 creator 反向不成立时先查 `remote_workspace_of`（命中即报「运行在另一个工作区 `<身份>`」）、`run_reply` 的 `sub_agent_id` 改名 `caller_session_id` 并改「当前会话」、`prompt.rs` 两处收窄承诺（对照表 `core-rs/fixtures/systemPrompt.json` 同步重生成）。`Reply` 工具结果的实测全文：`Reply 失败: 目标会话 sub_remote_tool 是跨工作区子代理，运行在另一个工作区 HOST:/b：本机无法直接投递消息。请在派发时把要求写全，或等它用 Reply 回传结果；需要追加任务请新起一个 Agent。如果回复给创建者，请不要设置 targetSessionId 参数，默认会回复到创建者会话。当前会话 session_parent` |
| 既有回归（core 全量） | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1065 passed / 0 failed（单测）+ 1 passed / 0 failed（`tests/parent_watchdog.rs`）；跨工作区回投、spin 语义、本地子代理投递全部无回归 |
| 单测入口 | `npm run test:unit` | 部分验证 | 99 通过 / 1 失败；唯一失败是 `brandLiteral`——扫描到本机未入库的 `exp/branch-conversation-demo.html`（`.gitignore` 第 21 行覆盖的本地草稿目录，非本次改动文件），与本次改动无关；docsLint 与 docsLintLocalOnlyPaths 已转绿 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败：缺陷规格五节齐全、验证记录含红与绿、事件表总数 77 与实际 77 一致（本次不新增事件） |
| 类型与风格 | `npm run check-types && npm run lint` | 绿 | 两份命令退出码均为 0，`error TS` 与 eslint 错误计数均为 0 |
| `brandLiteral` | `npm run test:unit -- brandLiteral` | skipped | 命中 `exp/branch-conversation-demo.html:278`——该目录被 `.gitignore` 覆盖（本机草稿），不在本分支改动内（`git status` 无该文件） |

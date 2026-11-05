---
status: 已修
---

# 缺陷：本地子代理在会话运行时快照里 creator 为 user（应为 agent 形态）

Electron 宿主在子代理完成后播放托盘提醒音、并给归属标签页挂绿灯——按基线这两件事只应发生在
用户创建的会话上。根因在 Core 侧：本地子代理创建时只写了树事实 `parentSessionId`，没有写
归属事实 `creator`，而快照的 `creator` 直接取内存 `SessionState.creator`，默认值是 `user`。
落盘侧（`meta.json`）写的是正确的 agent 形态，两者不一致。

## 现状

**1. 本地子代理的内存 `creator` 停留在默认值**

`core-rs/src/engine.rs` 的 `create_sub_agent` 在初始化子会话状态时只写树事实：

```rust
state.parent_session_id = Some(creator.clone());
```

全仓给 `SessionState.creator` 赋值的只有两处：`start_remote_sub_agent`（跨工作区对话）与
`ensure_loaded`（从 `meta.json` 恢复）。本地子代理两条都没走，于是保留
`SessionState::new` 的默认值 `creator: SessionCreator::User`。

落盘侧是对的：`core-rs/src/history.rs` 的 `create_sub_agent_metadata` 写入
`{"kind":"agent","workspaceId":null,"sessionId":<父会话 id>}`，与
[specs/025 归档 FR-002](../../docs/archive/specs/025-cross-workspace-agent-direct-session/spec.md)
的 AC-6 一致。于是同一会话的 `creator` 在磁盘上（agent）与运行时快照里（user）是两个值。

复现路径：任一对话里让模型调用 `Agent` 工具起本地子代理，在子代理运行期间读
`CoreEvent.sessionRuntimeChanged` 的 `states[*].creator`——子会话条目为
`{"kind":"user"}`，同一条目的 `parentSessionId` 为父会话 id、`meta.json` 的 `creator` 为
agent 形态。实测快照（走 `Core::submit_tool_use("Agent")`，与
`specs/defects/subagent-start-missing-runtime-emit.md` 的 RT-1 同一条路径）：

```
sub_1793868611521_1f113b642(idle=false,creator={"kind":"user"},subAgentRunning=false)
```

**2. 消费方按 `creator` 做的抑制因此全部失效**

`creator` 是归属的唯一根事实（[docs/core/session-runtime.md 第 2 节](../../docs/core/session-runtime.md#2-对外快照)），
下列判定都读它，读到 `user` 即失效：

- `electron/trayAttention.ts` 的 `diffSessionEndEvents`：`isAgentCreated` 为假，子会话自身的
  `running → idle` 不再被「子对话完成不提醒」挡下，直接进入 `completedSessions`；`1s` 确认
  窗口后 `shouldFireCompletion` 放行，`startAttention` 启动托盘闪烁并在窗口处于后台时
  `attentionSound.play()`。
- `electron/completionAttention.ts`：武装源头同样按 `creator` 过滤，子代理完成会误武装
  归属标签页绿灯（对话行由 `parentSessionId` 另行处理，但标签页集合照加）；重启后
  `backfillCompletionAttention` 的离场完成过滤同样失效。
- `src/webview/hooks/handlers/streamHandlers.ts`：收尾时的排队消息丢弃判定读运行时快照的
  `creator`，子代理会话会走成用户会话分支。

「仅因子代理在跑而忙」的第二道抑制也挡不住这种情况：子代理会话自身 `queryRunning` 为真，
不满足 `subagentOnlyBusy` 的 `!queryRunning` 条件。因此普通对话里父会话全程 `queryRunning`
（`Agent` 工具同步等待）时，唯一真正落 `running → idle` 的就是子代理会话本身——那一声提示音
即子代理完成所致。

**3. 只有本次运行内新建的本地子代理受影响**

打开子会话会经 `on_conversation_opened` → `ensure_loaded` 从 `meta.json` 恢复 `creator`，
之后快照即变为 agent 形态。所以重启或打开过子会话后症状消失，这也是该缺陷长期未被发现的原因。

**4. 既有测试没拦住**

`src/test/trayAttention.test.ts` 的子代理用例全部手工构造 `creator: { kind: 'agent', … }`，
验证的是判定逻辑而非 Core 的真实产出；Core 侧
`core-rs/src/engine_tests.rs` 的 `sub_agent_start_emits_running_runtime_snapshot` 只断言
`queryRunning` / `subAgentRunning` / `idle`，未断言 `creator`。

## 期望

- 本地子代理创建即携带 agent 形态的 `creator`（`workspaceId` 为 `null`、`sessionId` 为父会话
  id），与其 `meta.json` 同源，满足 [docs/core/session-runtime.md 第 2 节](../../docs/core/session-runtime.md#2-对外快照)
  的字段定义与 specs/025 AC-7「每个条目携带 `creator`，且 `parentSessionId` 与 meta 同源」。
- 子代理会话从 `running` 转 `idle` 时，托盘提醒与标签页绿灯的抑制生效（US-33 验收 2 /
  specs/024 FR-002 / specs/025 FR-003 已定义的行为）。
- 子代理转等待用户（`running → waiting`）不受该抑制影响，照常提醒——现状已正确，保持。
- 跨工作区对话（`start_remote_sub_agent`）与 `ensure_loaded` 恢复路径的 `creator` 取值不变。

## 不变量

- `sessionRuntimeChanged` 仍是全量快照、状态没变不重发（`emit_runtime` 内部 diff）。
- 快照字段集合不变（`core-rs/fixtures/runtimeState.json` 与两侧类型双向锁定）。
- `parentSessionId` 的语义不变：仍是本地子代理的树事实，`creator` 的赋值不改写它。
- `is_sub_agent_session` 的判据不变（`parent_session_id.is_some() || creator 为 agent 形态`），
  修复后两条同时为真，不得因此改变其他调用点的行为。
- 落盘格式（`meta.json` / 对话 JSONL）不变：`create_sub_agent_metadata` 已写 agent 形态，
  本次不改磁盘侧。
- 用户创建的普通会话 `creator` 仍为 `user`。
- 托盘提醒的触发条件、确认窗口、提示音开关与音量偏好逻辑不变。

## 回归测试

缺陷只在 Core 的写入点，宿主侧判定已按 `creator` 实现正确、无需改动（`creator` 是归属唯一根
事实，不得改从 `parentSessionId` 反推——specs/025 FR-002）。因此回归载体是 Core 的快照断言：
只要本地子代理的 `creator` 正确，`electron/trayAttention.ts` 与
`electron/completionAttention.ts` 的既有抑制分支即生效，那两条分支由
`src/test/trayAttention.test.ts` / `src/test/completionAttention.test.ts` 的既有用例锁定。

- **RT-1**：本地子代理首次出现在 `sessionRuntimeChanged` 时，其 `creator` 为
  `{"kind":"agent","workspaceId":null,"sessionId":<父会话 id>}`，且与同会话 `meta.json` 的
  `creator` 一致、`parentSessionId` 不变。
  （落点：`core-rs/src/engine_tests.rs::local_sub_agent_runtime_creator_is_agent_form`）
- **RT-2**：「子代理 → 创建者」的回投分支按 `workspaceId` 区分本地与跨工作区：本地子代理
  （`workspaceId` 为 `null`）的父会话取不到时报「目标不存在」，不发
  `crossWorkspaceAgentReplyRequested`；跨工作区对话（`workspaceId` 有值）的回投行为不变。
  （落点：`core-rs/src/engine_tests.rs::local_sub_agent_reply_to_closed_parent_does_not_spin_cross_workspace_loop`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc local_sub_agent_runtime_creator_is_agent_form -- --nocapture` | 红 | RT-1 失败于首个断言：`left: {"kind":"user"}, right: {"kind":"agent","workspaceId":null,"sessionId":"s-subagent-creator-form"}`——子代理首次进入快照时 `creator` 为默认值 user |
| 回归用例（修复后，RT-1） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc local_sub_agent_runtime_creator_is_agent_form` | 绿 | 1 passed / 0 failed。修复：`create_sub_agent` 在写 `parent_session_id` 的同一处写 agent 形态的 `creator`（`workspaceId` 为 `null`，与 `create_sub_agent_metadata` 落盘一致） |
| 回归用例（修复后，RT-2） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc local_sub_agent_reply_to_closed_parent_does_not_spin_cross_workspace_loop` | 绿 | 1 passed / 0 failed。RT-2 是本次修复**引入风险的回归**：`creator` 写定后本地子代理也指向父会话，`deliver_agent_reply` 的目标缺失分支若只比 `session_id`，父会话已关闭时会发跨工作区回投事件，该事件经宿主 `agentReplyReceived` 原样回灌本 Core 的同一父会话 id，再次落回同一分支形成自激环。修法是该分支只认 `workspaceId` 有值的 agent 形态（本地为 `null`，跨工作区对话才有值） |
| 既有回归（Core 全量） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc -- --test-threads=1` | 部分验证 | 1073 passed / 5 failed，5 条全部在 `mcp::tests`（假 MCP server 启动即退出）。在干净树上单跑 `mcp::tests::stdio_handshake_paging_call_and_reverse_request` 同样失败，与本次改动无关，属本机环境问题。engine / subagent / reply 相关用例全绿 |
| 既有回归（托盘 / 未读绿灯单测） | `npm run test:unit -- trayAttention`、`npm run test:unit -- completionAttention` | 绿 | 14 / 23 通过、0 失败；`creator` 为 agent 形态的抑制分支与 `creator` 为 user 的照常提醒分支均保持绿 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 无输出即通过；本次改动只在 Rust 侧与缺陷规格 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节、RT 编号、验证记录四列表与结果取值均通过 |
| 端到端实测提示音 | — | not-run | 需带声音的 Electron 实机与人工试听；本次以 RT-1 的快照断言为证据，未做人工试听 |



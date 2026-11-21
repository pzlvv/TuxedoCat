# 实施方案：abort 悬停明细显示已执行时间与远程子代理

技术路线：Core 侧把悬停明细所需的三项「开始时刻 + 远程登记身份」作为快照根事实一并
推送（`backgroundTasks[].startedAt` / `subAgentStartedAt` / `remoteSubAgents`），webview
侧用本机时钟推算已执行时长、按浮层可见性起停秒级刷新，并把远程登记合并进子代理组。
需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### 1. Core 快照的三个新事实

- **后台任务开始时刻**：`bash_task::RunningTask` 已有 `start_time`（wall clock 毫秒，
  注册时写定），`engine.rs` 的 `emit_runtime` 投影把它映射成 `backgroundTasks[].startedAt`。
  不新增注册字段，也不改任务注册表。
- **本地子代理创建时刻**：`subagent::created_at(session_id)` 早已存在（`AGENTS` 记录的
  `created_at`，此前只被单测用到）。`emit_runtime` 对每个会话查一次，投影成
  `subAgentStartedAt`；未登记（普通会话 / 恢复路径）为 `null`。锁序 `sessions → AGENTS`
  与 `is_idle_deep` 现有顺序一致，无反向路径。
- **远程子代理清单**：`subagent::RemoteRecord` 补 `description: Option<String>` 与
  `created_at: u64`（登记时 `util::now_millis()`），`register_remote` 增加 description
  入参（唯一生产调用方 `Core::spawn_remote_agent` 传 `request.description`）。新增
  `subagent::remote_sub_agents_for_session(creator_session_id)` 按登记序返回
  `(id, description, target_workspace_id, created_at)`，`emit_runtime` 投影成
  `remoteSubAgents`。移除点仍是 `unregister_remote`（结束事件）与
  `on_cross_workspace_agent_completed`，两者都在 `emit_runtime` 之前完成，因此清单与
  `subAgentRunning` 同源同发。

三个成员都是**稳定的根事实**：时间戳写定后不变，清单只在登记 / 注销时变化——快照 diff
不会因为时间流逝而抖动（这正是拒绝「由 core 推送随时变化的时长」的理由，见 spec 非目标）。

### 2. 契约镜像与缺字段归一

`SessionRuntimeState` 在四处各有镜像（shared 契约、宿主 wire 内联类型、webview 类型、
e2e 假宿主）：全部加 `subAgentStartedAt: number | null` 与
`remoteSubAgents: readonly RemoteSubAgentBrief[]`，`BackgroundTaskBrief` 加
`startedAt: number`。webview 入口 `handleConversationSessionRuntimeStates` 按既有缺字段
口径归一（`?? null` / `Array.isArray ? … : []`），旧宿主与假宿主不会把 `undefined`
带进渲染层（spec AC-11）。

### 3. 子代理聚合的唯一纯函数

`src/shared/sessionRuntime.ts` 的 `collectRunningSubAgents` 仍是一份实现，`RunningSubAgentBrief`
扩成 `{ sessionId, description, startedAt, workspaceId }`（本地条目 `workspaceId` 为
`null`，`startedAt` 可能为 `null`）。聚合规则：

```text
visit(parent):
  对 parent 的每个非 idle 本地子代理 child（快照数组顺序）：输出 child，然后 visit(child)
  对 parent 的 remoteSubAgents（登记序）：输出远程条目（不继续下钻）
```

即「该节点的整棵本地子树之后追加它自己的远程登记」——深先序、层内本地先远程后、
远程条目没有下层（跨工作区子代理不能再派生）。零 import 的结构化签名不变（webview
构建图不含 node 类型链）。

### 4. 时长格式化与秒级刷新

- 纯函数 `formatElapsedTime(durationMs, labels)` 落在新文件 `src/webview/elapsedTime.ts`：
  入参是毫秒与四个单位文案（`day` / `hour` / `minute` / `second`），负值钳 0，向下取整到秒，
  从「天」到「秒」逐个拼接、零单位连同单位一起省略，全部为零输出 `0秒`。单位文案由
  `InputArea` 从 i18n 取（`zh` 天 / 小时 / 分 / 秒，`en` d / h / m / s），格式化函数本身
  不 import i18n——i18n 模块在加载期读 `window`，node 单测里不可用（既有 `inputAreaState`
  同款零依赖先例）。
- `InputArea` 在 `abortTipVisible` 为真时建一个 1s `setInterval`（进入时先取一次当前
  时刻，避免等到下一个整秒），隐藏即清理——浮层不可见时不存在常驻定时器。读数只在该
  组件重渲染时由 `now - startedAt` 现算，不缓存第二份事实。
- 行渲染：后台任务 = 描述 +（`command` 与描述不同时附命令）+ 时长；子代理 = 描述（`null`
  用既有回退文案）+（远程才有 `→ <workspaceId>` 标签）+ 时长。取不到开始时刻（`null`）
  只省略时长文本，其余照旧。

### 5. 宿主失联路径的一致性

`bootstrapCore.ts` 的 `markConnectionSessionsFailed` 把失联会话的运行时来源全量归零，
新增的明细成员跟着一起清（`backgroundTasks: []` / `remoteSubAgents: []`），否则会出现
「`subAgentRunning` 为假但快照里还列着远程子代理」的自相矛盾快照
（[principles.md 第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。
`subAgentStartedAt` 是时间线事实、不是活动来源，保持原值。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/subagent.rs` | 修改 `RemoteRecord` / `register_remote`；新增 `remote_sub_agents_for_session` | 注册表内部事实（description / 登记时刻） |
| `core-rs/src/engine.rs` | 修改 `emit_runtime` 与 `runtime_state_json` | 新增 `subAgentStartedAt`、`remoteSubAgents`；`backgroundTasks` 元素加 `startedAt` |
| `core-rs/fixtures/runtimeState.json` | 修改字段集 | 快照字段清单锁定 |
| `core-rs/src/main_tests.rs` | 修改 parity 测试的样例调用 | — |
| `core-rs/src/engine_tests.rs`、`subagent_tests.rs` | 新增 / 调整用例 | — |
| `src/shared/AssistantEventBus.ts` | 新增 `RemoteSubAgentBrief`；`BackgroundTaskBrief` / `SessionRuntimeState` 加成员 | 契约成员新增 |
| `src/host/webviewMessages.ts` | wire 内联 state 类型同步 | 契约镜像 |
| `src/webview/types.ts` | webview 镜像同步 | 契约镜像 |
| `src/webview/hooks/handlers/conversationHandlers.ts` | 缺字段归一 | — |
| `src/shared/sessionRuntime.ts` | `RunningSubAgentBrief` 扩字段；聚合合并远程清单 | 唯一纯函数（派生） |
| `src/webview/App.tsx` | 悬停明细类型与推导 | — |
| `src/webview/elapsedTime.ts` | 新增时长格式化纯函数 | — |
| `src/webview/InputArea.tsx` | 秒级定时器 + 行内时长与远程身份 | — |
| `src/webview/i18n/{zh,en}.ts` | 新增四个单位文案 | 文案 |
| `src/host/bootstrapCore.ts` | 失联归零时清明细清单 | — |
| `src/test/elapsedTime.test.ts` | 新增 | — |
| `src/test/sessionBusyLevel.test.ts` | 远程合并用例 | — |
| `e2e/webview/conversation.spec.ts` | US-52 用例扩展（时长 / 远程行 / 秒级刷新） | — |
| `docs/core/session-runtime.md`、`docs/features/abort-button.md`、`docs/features/cross-workspace-agent.md`、`docs/hosts/webview-ui.md`、`docs/features/user-stories/dialog-core.md` | 修改 | 见 spec 影响基线 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增代码只在
      core（`core-rs/`）、shared 叶子层（`sessionRuntime.ts` 零 import、契约类型）与 webview；
      `src/host/` 只改 wire 类型与失联归零，不 import 宿主 API，不做 `host.kind` 嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      契约成员全必选（「没有」用 `null` / 空数组，无 `?`）；开始时刻的唯一写入点是各自注册表
      （后台任务 / 子代理 / 远程登记），webview 只做减法；时长是派生值，纯函数只有一份；
      缺字段归一集中在 webview 消息入口（与既有 `?? []` 同口径，属「设计允许的瞬时状态」
      而非静默降级）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：快照字段改动
      在 `core-rs/src/engine.rs` 与 `core-rs/src/subagent.rs`，同步 `fixtures/runtimeState.json`、
      parity 测试与 `engine_tests.rs` / `subagent_tests.rs`；不涉及 `meta.json` / JSONL 落盘
      格式，无需 `history_tests.rs` 对照表变更。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec 影响基线同步
      `session-runtime.md` §2 字段表、`abort-button.md` FR-003 / FR-004 / §4 / §5、
      `cross-workspace-agent.md` FR-006、`webview-ui.md` §8 链路表、US-52 验收标准；
      `events.md` 与 `contracts.md` 经核对不涉及（成员语义单点在 session-runtime.md，
      events.md 行数棘轮不允许加注），实施末尾跑 `npm run test:unit -- docs-lint` 兜底。

## 被否决的替代方案

1. **core 直接推送「已执行时长」字段**：会让快照每秒变化，diff 永远不收敛（所有消费者
   每秒收全量），且时长是表现、不是事实（[principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现) /
   [第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。改为推开始时刻。
2. **webview 用会话级 `queryBegin` 时刻近似开始时刻**：后台任务与子代理各有自己的注册
   时刻，会话级时刻只是「本轮从何时开始」，估出来的读数会偏大且随本轮重启跳变。
3. **远程子代理也进 `collectRunningSubAgents` 的本地递归（靠 `creator` 反推）**：远程子代理
   在本 Core 没有会话条目，`creator` 是归属事实、不是树事实（`parentSessionId` 才是树），
   从它反推会造出第二份派生物。改为由 core 侧远程登记直接投影成清单。
4. **给 `RunningSubAgentBrief` 建判别联合（local / remote）**：两个形态只差一个可空字段，
   判别联合会让 webview 每处渲染都写 `switch`；单形状 + `workspaceId: string | null`
   已能表达「远程才有身份标签」，且与既有 `description: string | null` 同风格。
5. **在 `InputArea` 里用 `requestAnimationFrame` / 每 100ms 刷新**：只有整秒的读数，1s
   `setInterval` 足够；更高频刷新只增加渲染压力。

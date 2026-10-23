# 实施方案：跨工作区容器对话的状态灯与提示音策略

技术路线分两条独立的数据流，对应同目录 `spec.md` 的两组 FR：

1. **状态灯（FR-001 / FR-002 / FR-003）——纯渲染层派生，不触契约面**。容器行的灯不是
   新事实，而是其子代理会话运行时的只读投影：在 `src/shared/sessionRuntime.ts` 新增一个
   零依赖纯函数（与 `collectRunningSubAgents` 同款先例，按 `parentSessionId` 在客户端
   派生），Electron 侧栏渲染容器行时合成 state 注入现有流水灯逻辑。提示音策略是既有
   `trayAttention.ts` 判定在 `parentSessionId: "ph_…"` 形态下的锁定，无代码改动、只补测试。
2. **设置继承链（FR-004）——发起方 Core 解析生效值随派发请求携带**。发起方 Core 在
   `spawn_remote_agent` 按查询路径同一口径解析本会话的生效设置（model / provider 经
   `config::resolve_provider`，thinking / prompt / webSearch 取会话覆盖、缺省回落全局
   默认），进 `CoreRequest.crossWorkspaceAgentRequested` 载荷；宿主 `WebViewUI` 原样透传
   进 `UiEvent.remoteSubAgentStarted`；目标 Core 的 `start_remote_sub_agent` 应用继承
   （替换现行「取目标工作区默认值」口径），继承规则与本地子代理的 specs/020 FR-003
   完全一致。

## 技术方案

### 状态灯派生（FR-001）

- `src/shared/sessionRuntime.ts` 新增纯函数 `deriveContainerBusyLevel(states, containerId)`：
  输入运行时快照数组（结构化字段类型，与文件头的零 import 约定一致）与容器会话 id，
  取 `parentSessionId === containerId` 的直接子代理集合，逐项过 `sessionBusyLevel`，
  返回聚合级别——任一 `waiting` → `waiting`；否则任一非 `idle` → `running`；否则
  `idle`。子代理不在快照里视为 idle（等待态不猜值）。只看直接子代理：跨工作区子代理
  不能再派生（specs/023 既有规则），无更深层级需要递归。
- `electron/sidebar/main.ts`：渲染循环 `collect()` 已持有 `childrenMap` 与
  `sessionStates`。对 `c.placeholder` 非空的行（容器行）用它合成一个
  `{ idle, waiting }` 注入现有 `runningBar` 逻辑（waiting 黄呼吸 / 运行蓝流水 /
  无灯）——`itemHtml` 的渲染分支不动，普通行的取值路径不变。

### 提示音锁定（FR-002）

无代码改动。`src/test/trayAttention.test.ts` 补跨工作区形态用例：`parentSessionId`
指向 `ph_…` 的会话 running → idle 不进 `completedSessions`（完成静默）、running →
waiting 产出 `anyNowWaiting`（等待提醒）。

### 设置继承链（FR-004）

数据流（既有通道加字段，无新事件类型）：

```
发起方 Core spawn_remote_agent        →  解析生效值，写入 crossWorkspaceAgentRequested
宿主 WebViewUI.requestCrossWorkspaceAgent →  原样透传
目标 Core start_remote_sub_agent      →  应用继承（替换目标默认值口径）+ 落盘
```

- **契约**（`src/shared/AssistantEventBus.ts`）：`crossWorkspaceAgentRequested` 与
  `remoteSubAgentStarted` 各新增 6 个必选成员：`agentMode` / `thinkingEffort` /
  `promptMode` / `model` / `provider` / `webSearch`。发起方一律解析为**生效值**
  （不用 null / `?`，铁律 2；避免目标侧再回落默认值造成双源，铁律 6）。
- **发起方 Core**（`core-rs/src/engine.rs` 的 `spawn_remote_agent`）：从
  `self.session(&request.creator_session_id)` 读会话状态；model / provider 经
  `config::resolve_provider` 解析为具体值（查询路径同一函数）；thinking effort /
  prompt mode / web search 取会话级覆盖、缺省回落全局配置默认——即发起方对话此刻
  真正生效的配置。`local: true` 分支（target 等于来源工作区）不受影响：仍走
  `create_sub_agent` 的既有本机继承。
- **宿主透传**（`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceAgent`）：
  `request` 上的新字段原样进 `remoteSubAgentStarted` 载荷，不做任何加工（宿主不是
  设置事实的写入点）。
- **目标 Core**（`core-rs/src/engine.rs` 的 `start_remote_sub_agent`）：
  - 读入载荷新字段（缺失即 `Err`，纳入既有 missing-fields 校验）；
  - Master 角色：六项全部写入会话状态（替换现行「state 默认值」取值）；
  - 非 Master 角色：与 `create_sub_agent` 的角色固定口径一致——`prompt_mode` 恒
    normal、`web_search` 恒关、MCP 恒空（工具白名单过滤已在 `run_query_loop`），
    `agent_mode` / `model` / `provider` / `thinking_effort` 仍继承；
  - 落盘：`create_remote_sub_agent_metadata` 已带 model / provider（现在写入继承值）；
    `persist_context` 扩展为 agentMode（既有）+ thinkingMode / promptMode / webSearch
    （均为既有键，重启重开后 UI 显示继承值，与 agentMode 的持久化动机相同）。
- **文档同步**（随实现同一提交）：`docs/architecture/events.md` 两个事件的载荷列；
  `docs/features/cross-workspace-agent.md` FR-003 配置口径改写 + 3.2 契约成员表；
  [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)
  容器条目；[docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)
  完成呼吸与提醒口径；[docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md)
  US-56 / US-33。`npm run test:all -- docs-lint` 必须绿。

### e2e

`e2e/electron/crossWorkspaceAgent.spec.ts` 扩展：

- 状态灯（AC-1 / AC-3）：派发后容器行出现 `.running-bar`；无子代理运行的容器行无灯。
- 继承（AC-7）：派发落定后读目标工作区子代理 `meta.json`，断言 `context.agentMode` /
  `thinkingMode` / `promptMode` / `webSearch` 与顶层 `model` / `provider` 等于发起方
  会话的设置（不依赖 UI 自动化，读盘断言确定性最高）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/sessionRuntime.ts` | 新增 `deriveContainerBusyLevel` 纯函数 | 无 |
| `electron/sidebar/main.ts` | 渲染循环为容器行合成 state | 无 |
| `src/shared/AssistantEventBus.ts` | 两条载荷各加 6 个必选成员 | `crossWorkspaceAgentRequested` / `remoteSubAgentStarted` 新增 `agentMode` `thinkingEffort` `promptMode` `model` `provider` `webSearch` |
| `src/host/WebViewUI.ts` | `requestCrossWorkspaceAgent` 透传新字段 | 同上（转发面） |
| `core-rs/src/engine.rs` | `spawn_remote_agent` 解析生效值入载荷；`start_remote_sub_agent` 应用继承 + 扩展 `persist_context` | 同上（消费面）；落盘用既有 context 键，无格式变化 |
| `src/test/sessionBusyLevel.test.ts`（或新增同名主题文件） | 容器派生纯函数用例 | 无 |
| `src/test/trayAttention.test.ts` | 跨工作区形态的完成静默 / 等待提醒用例 | 无 |
| `core-rs/src/engine_tests.rs` | `start_remote_sub_agent` 继承用例（Master 全量 / 非 Master 角色固定 / 载荷缺字段报错） | 无 |
| `e2e/electron/crossWorkspaceAgent.spec.ts` | 状态灯 + 继承断言 | 无 |
| `docs/`（events / cross-workspace-agent / electron-multi-workspace / host-matrix / user-stories） | 同步口径与载荷列 | docsLint 校验 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：纯函数落
      `src/shared/sessionRuntime.ts`（零 import，先例 `collectRunningSubAgents`）；`electron/`
      只 import shared；core-rs 经帧通道的 UiEvent JSON 取字段，不 import TS；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      新契约成员全必选（发起方解析为生效值）；设置事实的 owner 是发起方 Core 会话状态、
      容器灯是子代理运行时的只读投影、宿主不维护设置登记表（一份事实一个写入点）；生效值
      解析复用 `config::resolve_provider` 与全局配置默认，不新增默认值来源（默认值单源）；
      载荷缺字段按接线错误 `Err`（不过度 fallback）；容器行无子代理状态时无灯（不猜值）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动全在
      `core-rs/`（继承应用 + 载荷解析），`engine_tests.rs` 同步；落盘沿用 meta.json
      既有 `context` 键（persist_context 已支持 agentMode / thinkingMode / promptMode /
      webSearch）与顶层 model / provider，**无新格式**，不涉及 `src/shared/history/`
      两侧同步；TS 侧无第二套 Core 实现（`remoteSubAgentStarted` 仅 core-rs 消费），
      不涉及 parity。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：上表 docs 清单随实现同一提交更新，
      `npm run test:all -- docs-lint` 作闸；spec 的「影响基线」已逐条登记 delta 目标。

## 被否决的替代方案

- **目标 Core 侧回落默认值（null 语义的可选字段）**：载荷字段可空、目标侧对 null 取
  自己的默认——被否决：契约成员必须全必选（铁律 2），且默认值会出现「发起方默认」与
  「目标默认」两个来源（铁律 6），「全部继承发送方」的语义也无法成立。
- **容器设置在宿主落盘（给 `ph_` 容器建 meta.json）**：容器是派生条目、不落独立文件
  （specs/023 FR-004 的既定口径），为继承链再落一份盘会引入「派生条目有实体文件」的
  双写事实。继承只需要派发瞬间的快照，随请求携带即可，子对话的 meta 已经持久化
  继承结果。
- **容器灯由宿主合成假会话状态推给侧栏（在 `session-states-updated` 里注入 `ph_` 条目）**：
  运行时快照的 owner 是 Core（`docs/core/session-runtime.md`），宿主往状态流里注入
  不存在的会话等于伪造事实，还会污染托盘差分（`ph_` 条目会被 `diffSessionEndEvents`
  当成真实会话）。派生收在渲染层，输入是它已经拿到的两份流。
- **提示音对跨工作区子代理加新的抑制分支**：无需——「子对话完成不提醒 / 转等待照常」
  的既有判定按 `parentSessionId` 判定，跨工作区子代理天然命中；加分支反而制造两套口径。

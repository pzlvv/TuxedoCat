# 实施方案：跨工作区子代理直建普通对话与会话创建者归属

技术路线三条线，对应同目录 `spec.md` 的 FR：

1. **creator 根事实（FR-002）——shared 判别联合，两侧一次写入、处处只读**。新模块
   `src/shared/sessionCreator.ts`（零 import）定义判别联合；Rust 侧同形 enum，`SessionState`
   持有、创建时写入、`ensure_loaded` 恢复、`runtime_state_json` 进快照（fixture 同步）。
   容器删除后，托盘完成抑制、绿灯武装、输入禁用、回传路由、跨工作区跳转全部改读 creator，
   `parentSessionId` 收窄为本地树事实。
2. **容器删除（FR-001）——只删不加**。列表占位派生（Rust 与 TS 两侧同段删除）、占位页、
   宿主 `ph_` 生成、024 的容器灯派生与侧栏容器分支、`crossWorkspaceOrigin` / `originTitle`
   契约成员与 meta 字段。
3. **派发链路（FR-003 ~ FR-007）**。发起方载荷删 `originTitle`；目标 Core 去角色裁剪
   （全量继承）、按固定模板组装 SystemPrompt（身份取载荷既有 origin 字段）；输入禁用与
   安静语义在宿主 / webview 改读 creator。契约面**只删不增**。

## 技术方案

### creator 根事实（FR-002）

- **TS 判别联合**（`src/shared/sessionCreator.ts`，新文件，零 import，`sessionRuntime.ts`
  同款先例）：

  ```ts 示意
  export type SessionCreator =
    | { kind: 'user' }
    | { kind: 'agent'; workspaceId: string | null; sessionId: string };
  ```

  消费方：`AssistantEventBus.ts`（快照 `SessionRuntimeState.creator`）、
  `src/shared/history/Conversation.ts`（meta 读取）、`src/host/webviewMessages.ts`
  （`conversationLoaded` wire）。webview 镜像类型 `src/webview/types.ts` 同步。

- **Rust 侧**（`core-rs/src/engine.rs`）：`SessionCreator` enum（serde `tag = "kind"`、
  camelCase，与 TS 同形）；`SessionState` 增 `creator` 字段，`Core::session()` 创建默认
  `User`；`create_sub_agent` 置 `Agent { workspace_id: None, session_id: 父会话 }`；
  `start_remote_sub_agent` 置 `Agent { workspace_id: Some(origin_workspace_id),
  session_id: origin_session_id }`；`ensure_loaded` 从 meta 恢复（缺 creator 视为数据异常
  报错——未发布无兼容义务）。
- **meta 建档点统一写 creator**（取 `SessionState`，一份事实一个写入点）：
  `update_title_if_needed` 的建档分支（`engine.rs`，用户会话）、`history::touch_metadata`
  的 meta 缺失兜底分支、`history::create_sub_agent_metadata` /
  `create_remote_sub_agent_metadata`（agent 形态）。`create_remote_sub_agent_metadata`
  同时删 `parentSessionId` 与 `crossWorkspaceOrigin` 写入（签名收缩）。
- **快照**：`runtime_state_json` 增 `creator`（从 `SessionState` 取）；parity fixture
  `core-rs/fixtures/runtimeState.json` 加字段（`runtime_state_fields_match_parity_fixture`
  锁定），`AssistantEventBus.ts` 与 `src/webview/types.ts` 镜像同步。

### 容器删除（FR-001）

- `core-rs/src/history.rs` 的 `load_conversation_list`：删除占位父对话派生段（带
  `crossWorkspaceOrigin` 的子代理合成 `ph_` 条目的整块）；TS 侧
  `src/shared/history/Conversation.ts` 的同款派生段与 `ConversationMetadata.placeholder`
  / `crossWorkspaceOrigin` 字段删除。
- `electron/main.ts`：`PLACEHOLDER_SESSION_PREFIX`、`showCrossWorkspacePlaceholder`、
  `jumpToCrossWorkspaceConversation`、`chat:jump-to-origin` IPC、
  `sidebar:open-conversation` 的占位分支删除；`electron/chatPlaceholderHtml.ts` 的
  `crossWorkspaceAgent` kind 删除。
- `electron/sidebar/main.ts`：`containerRowState`、渲染循环 placeholder 分支、容器标题
  后缀（`· 跨工作区容器`）、`openConversation` 的 placeholder 传参删除；
  `src/shared/sessionRuntime.ts` 的 `deriveContainerBusyLevel` 删除（单测同步删）。
- 跨工作区对话成为顶层普通行：行内操作按既有 `depth === 0` 口径自然获得（重命名 / 智能命名
  / 删除），无新增逻辑。

### 消费面改读 creator（FR-003 / FR-004 / FR-007）

- **托盘**（`electron/trayAttention.ts`）：`SessionRuntimeSummary` 增 `creator`；
  `isSubagent = !!item.parentSessionId` 改为 creator agent-form 判定（完成抑制），
  转等待提醒不受抑制的口径不变。
- **绿灯武装**（`electron/completionAttention.ts`）：差分 states 增 `creator`；agent-form
  的 running→idle 不武装对话行、也不武装标签页灯（未读事实的写入源头掐掉，集合与显示
  天然一致）；`pickReadCompletions` 不变。
- **回传路由**（`core-rs/src/engine.rs` 的 `deliver_agent_reply`）：
  `cross_workspace_origin_of` 改读 `state.creator`（agent-form）；`SessionState.cross_workspace_origin`
  字段与 `CrossWorkspaceOrigin` struct 删除。`subagent.rs` 注册表（槽位 / 远程登记）不动
  ——它持有自己的 creator 登记链，与 meta creator 是两层（运行时槽位 / 持久归属）。
- **webview**：`conversationLoaded` wire 的 `crossWorkspaceOrigin` 字段换成 `creator`
  （`src/host/webviewMessages.ts` wire 类型、`src/host/conversationPayload.ts` extra、
  填充点 `src/host/ui/webviewMessageHandler.ts`、webview 接收
  `src/webview/hooks/handlers/conversationHandlers.ts`）；`App.tsx` 的返回按钮改读
  creator（agent-form 且 `workspaceId` 非空 → 跨工作区跳转
  `navigateToSession(sessionId, workspaceId)`，否则按 `parentSessionId` 本地跳）；
  `isSubAgent` 判定改 creator agent-form。

### 派发链路（FR-005 / FR-006）

- **契约删除成员**（`src/shared/AssistantEventBus.ts`）：`CoreRequest.crossWorkspaceAgentRequested.originTitle`；
  `UiEvent.remoteSubAgentStarted.parentSessionId`、`.originTitle`。无新增成员；
  024 的七个设置字段保留。
- **发起方 Core**（`spawn_remote_agent`）：payload 删 `originTitle`（`origin_title` 取值
  代码删除）；其余不动。
- **宿主透传**（`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceAgent`）：删
  `placeholderId` 生成与 `parentSessionId` / `originTitle` 透传（宿主不是提示词与归属的
  写入点，只填 `originWorkspaceId` / `originSessionId`）。
- **目标 Core**（`start_remote_sub_agent`）：
  - 删 `parentSessionId` / `originTitle` 读取与 missing-fields 校验项；`state.parent_session_id`
    不再写（远程对话快照与 meta 均为 `null`）；creator 置 Agent 形态；
  - **角色裁剪删除**：现行 Master / 非 Master 分支取消——`prompt_mode` / `web_search` /
    `mcp_servers` 全量按载荷应用（`persist_context` 与 `write_session_enabled` 照旧）；
    角色仅走 `tools::sub_agent_role_tools` 工具白名单（Explorer 恰为 Read / Glob / Grep /
    `Reply`）；
  - **SystemPrompt 组装**：`prompt.rs` 新增
    `remote_sub_agent_system_prompt(origin_workspace_id, origin_session_id)` 固定模板
    ——身份段（创建方工作区身份 + 会话 id）+ 既有 `## Communication` 段（`Reply` 要求，
    `targetSessionId` 指向创建方会话）；`state.system_prompt_prefix` 用它，本地子代理
    照旧 `sub_agent_communication_section`；
  - `create_remote_sub_agent_metadata` 按 creator 形态落盘（见上）。

### 输入禁用（FR-004）

- `src/webview/inputAreaState.ts`：`InputAreaDisableFacts` 增 `notUserCreated: boolean`；
  `resolveInputDisabled` 改为返回判别原因 `'providerNotConfigured' | 'spinMode' |
  'notUserCreated' | null`（`null` = 可输入）；placeholder 按原因选文案，优先级
  `spinMode` > `notUserCreated` > `providerNotConfigured`（spec FR-004）。
- `src/webview/InputArea.tsx`：disableFacts 接 creator 派生值；placeholder 三态文案换
  新；删除红边框与 `subAgentWarning` 横幅（`isSubAgent` prop 收缩为禁用事实的来源，
  不再进样式）；i18n `zh` / `en` 新增 `inputArea.placeholderNotUserCreated`
  （zh「非用户创建对话无法输入」/ en 同义英文），`inputArea.subAgentWarning` 删除。
- Core 不新增用户消息拦截：Reminder 注入与用户消息走同一入队管线（spec FR-004）。

### 文档同步（随实现同一提交）

`docs/architecture/events.md` 两事件载荷列；`docs/core/session-runtime.md` 快照表
（增 `creator` 行、`parentSessionId` 语义收窄）；`docs/features/cross-workspace-agent.md`
（FR-003 / FR-004 删除 / FR-005、3.1 术语 / 3.2 契约 / 3.3 不变量）；
[docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)；
[docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留)；
`docs/features/user-stories/desktop.md` US-33 / US-56；
`docs/features/user-stories/dialog-core.md` US-51。`npm run test:all -- docs-lint` 作闸。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/sessionCreator.ts` | 新增：判别联合与读取守卫 | 无（被 bus / history / wire 引用） |
| `src/shared/AssistantEventBus.ts` | 快照 `SessionRuntimeState` 增 `creator`；两条派发载荷删成员 | `crossWorkspaceAgentRequested` 删 `originTitle`；`remoteSubAgentStarted` 删 `parentSessionId` / `originTitle`；快照增 `creator` |
| `src/shared/sessionRuntime.ts` | 删 `deriveContainerBusyLevel` | 无 |
| `src/shared/history/Conversation.ts` | meta 读取增 `creator`（缺失报错）；删 `crossWorkspaceOrigin` / `placeholder` 与占位派生段 | meta.json 格式：增 `creator`，删 `crossWorkspaceOrigin` |
| `src/host/WebViewUI.ts` | `requestCrossWorkspaceAgent` 删 `ph_` 生成与两字段透传 | 转发面随契约收缩 |
| `src/host/webviewMessages.ts` / `conversationPayload.ts` / `ui/webviewMessageHandler.ts` | `conversationLoaded` 的 `crossWorkspaceOrigin` → `creator` | wire 消息字段替换 |
| `src/webview/inputAreaState.ts` | 禁用原因判别联合 + 优先级 | 无 |
| `src/webview/InputArea.tsx` / `App.tsx` / `i18n/zh.ts` / `en.ts` / `hooks/handlers/conversationHandlers.ts` / `types.ts` | 输入禁用、返回按钮、isSubAgent、镜像类型 | 无 |
| `electron/main.ts` / `chatPlaceholderHtml.ts` | 占位页 / 跳页 / `ph_` 前缀删除 | 无 |
| `electron/sidebar/main.ts` | 容器行分支 / 标题后缀删除 | 无 |
| `electron/trayAttention.ts` / `completionAttention.ts` | 判定改 creator（agent-form 抑制 / 不武装） | `SessionRuntimeSummary` 结构性增 `creator` |
| `core-rs/src/engine.rs` | `SessionCreator` enum、`SessionState.creator`、建档写 creator、`spawn_remote_agent` 删 `originTitle`、`start_remote_sub_agent` 去裁剪 + SystemPrompt 组装 + creator、`deliver_agent_reply` 改 creator、删 `CrossWorkspaceOrigin`、`ensure_loaded` 恢复 | 快照 JSON 增 `creator`（fixture 同步） |
| `core-rs/src/history.rs` | 列表占位派生删除；`create_sub_agent_metadata` / `create_remote_sub_agent_metadata` 签名与字段；`touch_metadata` 兜底建档写 creator | meta.json 格式同上 |
| `core-rs/src/prompt.rs` | 新增 `remote_sub_agent_system_prompt` | 无 |
| `core-rs/fixtures/runtimeState.json` | 增 `creator` | parity fixture |
| `core-rs/src/engine_tests.rs` | meta 形态 / creator 写入与缺失报错 / 全量继承 / SystemPrompt 内容 / 缺字段校验更新 | 无 |
| `src/test/trayAttention.test.ts` / `completionAttention.test.ts` / `chatPlaceholderReason.test.ts` / `inputAreaState` 单测 / `hostI18n.test.ts` / sessionRuntime 单测（删容器用例） | 按 FR 更新 | 无 |
| `e2e/electron/crossWorkspaceAgent.spec.ts` | 三个用例改造：顶层对话 + 输入禁用 + creator 落盘 + 全量继承 | 无 |
| `docs/`（events / session-runtime / cross-workspace-agent / electron-multi-workspace / host-matrix / user-stories×2） | 同步口径与载荷列 | docsLint 校验 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：判别联合落
      `src/shared/`（零 import，webview 构建
      图不含 node 链）；`electron/` 只 import shared；core-rs 经帧通道 JSON，不 import TS；
      无宿主嗅探——输入禁用与完成静默都由事实（creator / workMode）驱动，不按宿主分支。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：契约只删成员、其余全必选；creator 是归属唯一写入点
      （创建时一次写、`ensure_loaded` 恢复），托盘 / 绿灯 / 输入 / 跳转 / 回传路由全是
      只读投影；继承值复用发起方 Core 的既有解析（024 落地），不新增默认值来源；meta 缺
      `creator` 报错不回退（不过度 fallback）；容器派生删除后不再有「从投影反推事实」。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动全在 `core-rs/`
      （engine / history / prompt）+ `engine_tests.rs` 同步；meta.json 格式变更双侧同步
      （`src/shared/history/Conversation.ts` 与 Rust 写入侧，Rust 侧测试断言 meta 形态、
      TS 侧读取测试）；快照字段经 `core-rs/fixtures/runtimeState.json` 与两侧镜像类型同步；
      TS 侧无第二套 Core 实现（`remoteSubAgentStarted` 仅 core-rs 消费），不涉及 parity。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格清单见上表 docs 行，随实现同一提交
      更新，`npm run test:all -- docs-lint` 作闸；spec 的「影响基线」已逐条登记 delta 目标。

## 被否决的替代方案

- **SystemPrompt 随派发载荷由发起方 Core 构造（spec 初稿 FR-006 的字面方案）**：发起方
  Core 不持有本工作区身份事实（`workspaceAgentId` 的唯一算法在宿主
  `src/host/workspaceIdentity.ts`，FR-001 明确「身份由唯一纯函数计算」），发起方构造需要
  为拼提示词新增一个 bootstrap 身份注入点；而创建方身份（`originWorkspaceId` /
  `originSessionId`）本就随载荷携带且由宿主填充。改由目标 Core 按固定模板组装，内容要求
  不变（身份 + `Reply` 说明），spec FR-006 措辞已随本方案修订。
- **creator 用可空字段或布尔 `isAgent` 表达**：互斥结果用判别联合（铁律 2）；布尔丢掉
  「谁创建的」——跨工作区跳转与回传路由需要 `workspaceId` + `sessionId`，无法从布尔恢复。
- **保留快照 `parentSessionId` 指向发起方会话（现行值）**：跨工作区对话是顶层行，树事实
  为空；快照 `parentSessionId` 指向另一工作区的会话会让父子树消费者把不存在的父当根，且
  维持「meta 指向 `ph_`、快照指向发起方」的双值。归属一律走 creator，`parentSessionId`
  收窄为本地树事实。
- **绿灯在侧栏渲染时按 creator 过滤（不动作装源头）**：`completionAttention` 的武装是
  未读事实的写入点，渲染层过滤会让未读集合与显示脱节（清除迁移照样跑、托盘差分另算一套）；
  在武装源头跳过 agent 形态，集合、侧栏灯、标签页灯、托盘四处在同一份差分上收敛。
- **托盘完成抑制保留 `parentSessionId` 判定并叠加 creator 判定**：两套判据必然漂移；
  一次切换到 creator 单源，旧字段判定与 `ph_` 用例随之删除。

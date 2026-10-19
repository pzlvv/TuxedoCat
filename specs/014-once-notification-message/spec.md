---
status: 实施中
---

# 改动规格：once 一次性通知消息（不落盘、末位显示、后继即删）

为「事件通知」类消息增加 `once` 形态：LLM 请求失败回显、`*User Interrupted*`、
压缩排队提示、宿主侧 Core 失联提示改为 once——不写入会话落盘（`<sid>.jsonl` /
`meta.json` 计数）、不进内存消息列表与 LLM 上下文，只在 MessagesView 时间线末位以
系统消息样式显示；任何新节点追加前先移除已有的 once 节点，同一时间线至多一条。
`*User Interrupted*` 由此从「既回显又落盘」改为纯 once。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2.1 节](../../docs/architecture/events.md#21-coreeventcore--ui单向) | 修改 | `message` 事件的 `data: MessageData` 载荷列补 once 形态（判别联合：通知类消息带一次性标记，其余形态不变）；触发点列不变 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [US-2 中止进行中的回复](../../docs/features/user-stories.md#us-2-中止进行中的回复) | 修改 | 中止回显条目改为「`*User Interrupted*` 以 once 通知显示：本轮结束后停在时间线末位，下一条消息出现即消失、不落盘」 |
| [docs/features/compaction.md](../../docs/features/compaction.md) | [FR-002 手动压缩与延后执行](../../docs/features/compaction.md#fr-002手动压缩与延后执行) | 修改 | 「会话非空闲时登记待压缩」的排队提示补充 once 语义（只提示、不落盘） |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 2 节 内部流程约定](../../docs/hosts/webview-ui.md#2-内部流程约定) | 修改 | `onMessage → addMessage` 映射补 once 载荷分支（once 不触发 `onConversationListChanged`）；时间线「末位 once、后继即删」的渲染规则随实施落在同文档（新增小节） |

## 用户场景与验收标准

- 场景 1：LLM 请求失败
  - **AC-1**（FR-003）：GIVEN 某轮 LLM 请求失败（非用户取消）WHEN 轮次失败收尾 THEN 时间线末位出现一条错误通知节点（系统消息样式，含既有 `❌ LLM API Error` 文案），`<sid>.jsonl` 无对应记录
  - **AC-2**（FR-001）：GIVEN 时间线末位有该错误通知 WHEN 用户发送下一条消息 THEN 通知节点先被移除、再追加用户消息节点
- 场景 2：用户中止
  - **AC-3**（FR-003）：GIVEN 用户点击中止 WHEN 查询收尾 THEN `*User Interrupted*` 以 once 通知显示；`<sid>.jsonl`、内存消息列表、`meta.json` 的 messageCount 均不含它（落盘路径整体取消）
  - **AC-4**（FR-004）：GIVEN 中止后刷新或重开该会话 WHEN 时间线重建 THEN 不含 `*User Interrupted*` 节点
- 场景 3：压缩排队提示
  - **AC-5**（FR-003）：GIVEN 会话非空闲 WHEN 请求压缩 THEN「压缩已排队」提示以 once 显示且落盘无记录
- 场景 4：Core 失联提示（宿主侧）
  - **AC-6**（FR-003）：GIVEN Connection 运行期 fatal 且该会话忙碌 WHEN 失联提示到达 THEN 会话时间线末位出现 once 节点（既有「Core 进程已退出 / 无法恢复」文案）
- 场景 5：时间线不变量
  - **AC-7**（FR-002）：GIVEN 时间线已有 once 节点 WHEN 任何新节点（用户消息、工具卡片、流式 thinking / assistant、新 once）追加 THEN 先移除现有 once 再追加，时间线至多一条 once 且总在末位
  - **AC-8**（FR-002）：GIVEN 时间线已有 once 节点 WHEN 既有节点更新（工具进度、参数更新、状态变更、流式增量）THEN once 节点保留
  - **AC-9**（FR-002）：GIVEN once 通知到达 WHEN 渲染 THEN 使用系统消息的普通节点样式（info 图标 + 文本），不进卡片、不可折叠

## 功能需求

### FR-001：消息事件的 once 形态

- `CoreEvent.message` 的载荷 `data: MessageData` 增加一次性标记 `once`：通知类消息
  显式 `once: true`，其余消息不带（缺省即常规消息）。标记沿 `MessageData` 既有的
  「按角色取值子集」可选成员袋形态表达（与 `toolName` / `status` 等成员同模式；
  该类型不在 `AssistantEventBus` 联合的可选成员冻结范围，联合本体零改动）。
- once 消息不进任何持久化与上下文：不写 `<sid>.jsonl`、不追加内存消息列表
  （`SessionState.messages`）、不推进 `last_uuid` / `persisted_count`、不计入
  `meta.json` 的 messageCount、不触发对话列表刷新（`announce_message_appended`）。
- wire 侧（`addMessage`）与 webview `Message` 类型同步携带该标记。

### FR-002：时间线渲染规则（webview）

- once 消息以系统消息样式渲染（现有 `role: 'system'` 的普通节点形态），位于时间线
  末位。
- 「新节点追加」的定义：向会话消息数组追加任何新消息（用户回显、工具卡片、流式
  thinking / assistant 节点创建、下一条 once）。追加前先移除数组中已有的 once 节点。
- 既有节点的就地更新（进度、参数、状态、流式增量、卡片去重合并）不视为新节点，
  不移除 once。
- 会话加载 / 消息数组整体替换（`conversationLoaded` / `messagesReplaced`）后不含
  once 节点（落盘本来就没有）；多视图各自的时间线独立适用同一规则。

### FR-003：采用 once 的消息集

- LLM 请求失败回显（`core-rs/src/engine.rs` 轮次失败的 `llm_error_message` 上报）。
- `*User Interrupted*`（`emit_user_interrupted` 的全部收尾点；落盘与内存追加一并
  取消，静默中止的既有豁免不变）。
- 压缩排队提示（会话非空闲登记待压缩时的「压缩已排队」上报）。
- 宿主侧 Core 失联提示（`src/host/bootstrapCore.ts` 的
  `markConnectionSessionsFailed` 上报的「Core 进程已退出 / 无法恢复」）。
- 以上消息的文案与触发条件不变，只改投递形态。

### FR-004：恢复与重放

- 崩溃恢复、会话重载、`replay`（落盘 → UI 时间线重建）不产生 once 节点。
- 既有会话落盘里历史写入的 `*User Interrupted*` 系统消息照常重放显示（存量数据
  不清洗、不迁移）。

## 边界与错误路径

- once 消息到达时视图正被销毁 / 会话已切换：沿 `addMessage` 的既有会话过滤丢弃，
  无额外处理。
- 同一会话连续两次失败（重试后再败）：第二条 once 替换第一条（AC-7 的新 once
  分支），时间线不堆积。
- 多视图同时打开同一会话：每个视图各自维护「末位 once、后继即删」，互不同步
  （once 是视图态，不是会话事实）。
- 子代理（spin）消息、命令输出、回滚结果的落盘与显示行为不变（非 once）。

## 非目标

- 不把 slash 命令输出（`commands.rs`）与回滚结果（`main.rs`）改为 once：它们是
  对用户显式命令的应答，内容可能较长、用户可能回看，保持现状（后续有需要另开
  spec）。
- 不把中断工具的 `Command was interrupted` tool_result 改为 once：它是工具卡片的
  事实结果（`is_canceled: true`），参与下一轮请求的上下文完整性。
- 不新增独立的 CoreEvent 类型（复用 `message` 事件的 once 形态）。
- 不清洗存量落盘里的历史 `*User Interrupted*` 记录。

## 对需求基线的影响

- 修改 US-2（中止进行中的回复）：中止回显条目改为 once 表述。
- 修改 `docs/features/compaction.md` FR-002：排队提示补 once 语义。
- 无新增 US（通知形态变化落在既有 US 的验收表述内）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/shared/types.ts`（`MessageData` once 形态）、`core-rs/src/engine.rs`（上报点）、`src/host/WebViewUI.ts``（addMessage 映射） | `core-rs/src/engine_tests.rs`（不落盘 / 不计 messageCount）、`src/test/docsLint.test.ts`（事件表载荷列） | 自动 |
| FR-002 | `src/webview/hooks/handlers/toolHandlers.ts`（末位 once、后继即删）、`src/webview/MessagesView.tsx`（系统消息样式渲染） | webview e2e（末位显示 / 新节点先删 / 就地更新保留） | 自动 |
| FR-003 | `core-rs/src/engine.rs`（`llm_error_message` / `emit_user_interrupted` / 压缩排队）、`src/host/bootstrapCore.ts`（失联提示） | `core-rs/src/engine_tests.rs` 逐消息集用例 | 自动 |
| FR-004 | `core-rs/src/replay.rs`（重放不含 once——落盘无记录的现状锁定） | 重载 / replay 用例断言时间线无 once | 自动 |

## 待澄清

实施前无未决问题（slash 命令输出与回滚结果保持现状的取舍见「非目标」）。

## 收敛记录

收敛时由 /converge 填写。

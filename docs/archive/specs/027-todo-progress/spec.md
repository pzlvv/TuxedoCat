---
status: 已收敛
---

# 改动规格：按对话维护的 Todo 与输入区任务进度

把 Todo 状态收归 Core 持有：Core 按 `sessionId` 维护一份 Todo 表，`TodoWrite` 成功后即时
推送变更，宿主经请求-响应通道索取当前状态，webview 只负责渲染。表在 Core 进程重启后按该
对话的会话文件重建，因此清单跟着对话走——重开应用、重开对话、切换对话都能恢复。在此基础上
给输入区加一个任务进度按钮（`任务进度: 1/4` / `Progress: 1/4`），悬停 100ms 展示当前清单，
点击固定、再点恢复悬停显示；并把 `TodoWrite` 加进 Explorer 角色的工具白名单。范围不含
`TodoWrite` 入参 / 出参契约的扩展，也不含常驻侧栏面板。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 修改 | 新增 `CoreEvent.todosChanged` 与 `UiRequest.sessionTodosRequested`，四组汇总数量随之变化 |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 2 节 宿主侧的 Core 事实读取](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | 宿主侧 `coreFacts` 增加 Todo 索取入口 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 3 节 总线注册](../../docs/hosts/webview-ui.md#3-总线注册) | 修改 | `onCoreEvents` 映射表新增一条 handler，分区数量同步 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节 契约](../../docs/core/standalone-core.md#4-契约) | 修改 | `UiRequest` 的请求清单与数量（十三个 → 十四个） |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [第 3 节 WebviewMessageHandler](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | `buildMessageHandlers()` 的消息类型数量（43 → 44） |
| [docs/features/todo-list.md](../../docs/features/todo-list.md) | — | 新增 | Todo 的完整行为规格：Core 侧持有与恢复、索取与推送、进度按钮的显示与交互、Explorer 的 Todo |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | [EP-2 输入区与会话配置](../../docs/features/user-stories/dialog-core.md#ep-2-输入区与会话配置) | 修改 | 新增 US-59（输入区任务进度按钮） |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | [US-51 子代理角色 Explorer（文件浏览专用）](../../docs/features/user-stories/dialog-core.md#us-51-子代理角色-explorer文件浏览专用) | 修改 | 验收标准 1 的工具清单加入 TodoWrite |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | 登记 US-59 的 e2e 用例 |
| [docs/adr/0009-todo-state-owned-by-core.md](../../docs/adr/0009-todo-state-owned-by-core.md) | — | 新增 | 「Todo 事实由 Core 持有 + 按需索取 + 变更推送」的决策、背景与被否决的替代方案 |
| [docs/README.md](../../docs/README.md) | 地图 | 修改 | 登记新增的特性规格与 ADR |

会话落盘格式不改：重建只读既有 `<sid>.jsonl` 里 `tool_use.input.todos` 与 `tool_result`
的 `exit_code`，不新增字段，`src/shared/history/` 与 core-rs 的格式对照表都不动。

## 用户场景与验收标准

- 场景 1：重开对话后恢复
  - **AC-1**（FR-001）：GIVEN 某对话最后一次成功调用 `TodoWrite` 写入 4 条（1 completed / 1 in_progress / 2 pending）WHEN 关闭应用后重开该对话 THEN 按钮显示 `任务进度: 1/4`（英文界面 `Progress: 1/4`），悬停浮层的条目、顺序与状态与关闭前一致。
  - **AC-2**（FR-001）：GIVEN 对话 A 有 4 条 Todo、对话 B 从未调用 `TodoWrite` WHEN 在两者之间来回切换 THEN A 显示 `1/4` 且浮层为 A 的清单，B 不显示按钮。
  - **AC-3**（FR-001）：GIVEN 同一对话先后两次成功调用 `TodoWrite`（4 条 → 6 条）WHEN 打开该对话 THEN 只按最后一次调用投影（显示 `x/6`），前一次调用不参与。
- 场景 2：变更推送与失败
  - **AC-4**（FR-002）：GIVEN 当前对话已打开且显示 `1/4` WHEN 模型调用 `TodoWrite` 把第 2 条改成 completed THEN 不重新加载对话，按钮在收到推送后变为 `2/4`，浮层条目同步。
  - **AC-5**（FR-001）：GIVEN 最近一次 `TodoWrite` 因入参校验失败返回错误 WHEN 查看进度 THEN 进度等于该次失败之前最后一次成功调用的结果，失败调用的入参不写入表。
  - **AC-6**（FR-002）：GIVEN 最近一次成功调用传入 `todos: []` WHEN 收到推送 THEN 不显示进度按钮。
  - **AC-7**（FR-002）：GIVEN 4 条全部 completed WHEN 渲染 THEN 按钮显示 `4/4`，浮层仍列出这 4 条已完成项。
- 场景 3：悬停显示
  - **AC-8**（FR-003）：GIVEN 指针移入按钮 WHEN 悬停满 100ms THEN 浮层显示当前清单。
  - **AC-9**（FR-003）：GIVEN 指针移入后在 100ms 内移出 WHEN 计时到期 THEN 浮层不出现。
  - **AC-10**（FR-003）：GIVEN 浮层已显示且未固定 WHEN 指针移出按钮 THEN 浮层立即隐藏。
- 场景 4：点击固定
  - **AC-11**（FR-003）：GIVEN 浮层未固定 WHEN 点击按钮 THEN 浮层常驻，指针移出按钮不隐藏。
  - **AC-12**（FR-003）：GIVEN 已固定且指针已移出按钮 WHEN 再次点击按钮 THEN 取消固定，浮层立即隐藏；指针仍在按钮上时取消固定后浮层保持显示。
  - **AC-13**（FR-003）：GIVEN 浮层已显示 WHEN 点击浮层内任意位置 THEN 不产生任何上行消息，固定状态不变。
  - **AC-14**（FR-003）：GIVEN 已固定 WHEN 切换到另一个对话 THEN 固定状态复位为未固定，新对话按悬停规则显示。
- 场景 5：主题
  - **AC-15**（FR-004）：GIVEN dark 与 light 两种主题 WHEN 渲染按钮与浮层 THEN 文字、背景、边框、状态标记都取自主题色，两种主题下都可读，且不出现硬编码色值。
- 场景 6：Explorer 的 Todo
  - **AC-16**（FR-005）：GIVEN `agentRole="Explorer"` 的子代理会话 WHEN 调用 `TodoWrite` THEN 调用成功，写入该子代理自己的会话 Todo 表并可从其会话文件重建。
  - **AC-17**（FR-005）：GIVEN 打开 Explorer 子代理会话视图 WHEN 渲染输入区 THEN 进度按钮按该子代理会话的 Todo 显示，不受父对话影响。
  - **AC-18**（FR-005）：GIVEN Explorer 调用白名单外的工具（如 `Edit`）WHEN 执行 THEN 拒绝，错误文案点名该角色可用的工具且包含 `TodoWrite`。
  - **AC-19**（FR-005）：GIVEN 系统提示里的角色说明 WHEN 读 Explorer 条目 THEN 点名的工具与该角色白名单一致。

## 功能需求

### FR-001：Todo 状态由 Core 按对话持有，可从会话文件重建

Core 进程维护一份按 `sessionId` 索引的 Todo 表，它是 Todo 状态的**唯一持有者**：webview、
宿主侧栏等消费者都只读它，不各自维护副本。

`TodoWrite` 成功后 Core 立即更新该表（入参校验失败不写表）。表在 Core 进程存活期间常驻，
会话关闭 / 删除时清理；上下文压缩不改动表（压缩重写的是消息数组，与表无关）。

重建口径：某对话在表中没有条目时（Core 刚启动、或该对话本次进程内从未写过 Todo），Core 读
该对话的会话文件，取**最后一条成功的 `TodoWrite` 调用**的 `todos` 入参重建并写入表；
「成功」以该次调用的 `tool_result.exit_code == 0` 为准，失败调用不参与。重建结果与
`TodoWrite` 当次入参逐项一致（条目、顺序、状态），且此后以表为准。

### FR-002：宿主索取当前状态，Core 推送变更

宿主向 Core 索取某对话的当前 Todo（请求-响应通道），Core 应答该对话的完整清单；会话文件
不存在时返回空清单，不报错。webview 在切换 / 挂载对话时索取一次。

`TodoWrite` 成功后 Core 主动推送该对话的完整清单（单向事件），webview 收到即更新，不需要
重新加载对话。索取与推送两条路径落到 webview 的同一条渲染路径，进度按钮与浮层只认这一个
数据源。

按钮文案只有两段：中文 `任务进度: <done>/<total>`、英文 `Progress: <done>/<total>`，不附加
图标文字或单位。计数口径：`total` = 清单长度，`done` = 其中 `status` 为 `completed` 的条数
（`in_progress` / `pending` 都不计入 `done`），不做去重、过滤或截断。没有 Todo（`total = 0`）
时不渲染按钮，不出现 `0/0` 或置灰占位。

### FR-003：悬停显示与点击固定

指针在按钮上停留满 100ms 显示浮层；不足 100ms 移出则浮层不出现。未固定时指针移出按钮
浮层立即隐藏。点击按钮固定浮层（常驻，指针移出不隐藏），再次点击取消固定并回到悬停规则。
固定态是 UI 本地状态，切换对话后复位为未固定。

浮层内容是当前清单逐条一行（状态标记 + `content`，`in_progress` 条目附 `activeForm`），
只读：点击浮层不产生任何上行消息，也不改变固定状态。除条目本身外不显示其它文案。

### FR-004：按钮与浮层的配色

按钮文字、浮层背景 / 边框 / 文字与状态标记全部取自既有主题色（dark / light 两套），
两种主题下都可读；不新增硬编码色值。固定态与默认态在按钮本身上有可见区分（底色变化），
不靠新增文字表达。

### FR-005：Explorer 角色加入 TodoWrite

Explorer 子代理的工具白名单为 `Read` / `Glob` / `Grep` / `Reply` / `TodoWrite`：它可以用
TodoWrite 维护自己的清单（便于长链路的找文件 / 读代码任务自报进度），其余内置工具与
`mcp__*` 仍然不可用。系统提示里 Explorer 的角色说明点名的工具与该白名单一致。

Explorer 的 Todo 与其它对话同口径（FR-001 / FR-002）：写进它自己的会话 Todo 表，可从它自己的
会话文件重建，在该子代理会话视图里按同一份事实显示，不受父对话影响。

## 边界与错误路径

- **会话文件不存在 / 会话从未调用过 TodoWrite**：索取返回空清单，按钮不渲染。
- **`todos` 被序列化成字符串**（字段级 double-encode）：重建时按 JSON 数组解析；解析失败
  视为该次调用无效，继续向前找更早的一次成功调用。
- **流式过程中入参不完整**：`TodoWrite` 尚未执行完成时不写表、不推送，避免出现半截清单。
- **压缩**：压缩重写消息数组不影响表，进度在进程存活期间保持不变；进程重启后重建时，若
  最后一条成功 `TodoWrite` 已落在被摘要替换的区间，该对话视为无 Todo（按钮隐藏）。
- **并发**：`TodoWrite` 写表与索取读表串行化，索取返回的是应答时刻的完整快照，不返回半更新
  的清单。
- **表锁中毒**：持锁线程 panic 后表锁进入中毒态，后续读写沿用内部数据继续，不让该会话的
  每次调用都永久失败。
- **清单很长**：浮层内容超出可视高度时内部滚动，按钮文案不变。
- **子代理会话**：Explorer / Master 的 Todo 各占表内一条，互不串。
- **按钮不存在时**：无 Todo 的对话上不响应悬停 / 点击（按钮不渲染，无占位热区）。

## 非目标

- 常驻侧栏面板、跨对话汇总的全局任务视图（去向 [TODO.md](../../TODO.md)）。
- Todo 表落 `meta.json`（跨进程 + 跨压缩的持久快照）（去向 [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。
- `TodoWrite` 入参契约扩展：稳定 id、priority、cancelled、依赖 / 阻塞（去向 [TODO.md](../../TODO.md)）。
- 运行期强制「只有一个 in_progress」（现状只在提示词里约定）。
- 每轮把清单再注入模型上下文。
- 让模型读回清单的只读工具（`todo_read` 之类）：模型侧仍只有 `TodoWrite` 的 tool_result 回显。
- TUI 输入区的进度按钮：本次只落 webview 输入区，`tui-rs/` 不做该按钮。

## 对需求基线的影响

- 新增 US-59「输入区任务进度按钮」（登记在 `docs/features/user-stories/dialog-core.md` 的
  EP-2），e2e 用例 `e2e/webview/todoProgress.spec.ts` 覆盖悬停 100ms、点击固定 / 取消、
  重开对话恢复三组行为。
- 修改 US-51 验收标准 1：Explorer 的工具清单从 `Read / Glob / Grep / Reply` 改为
  `Read / Glob / Grep / Reply / TodoWrite`，并同步 `e2e/electron/subagentExplorer.spec.ts`
  的工具四件套断言。
- 无其它 US 变更。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（会话 Todo 表 + 重建函数）、`core-rs/src/history.rs`（按会话读 tool_use / tool_result）、`core-rs/src/engine.rs`（会话关闭清理） | `core-rs/src/tools_tests.rs`（重建：取最后一次成功 / 跳过失败 / 空清单）、`core-rs/src/engine_tests.rs`（压缩后表不变） | 自动 |
| FR-002 | `src/shared/AssistantEventBus.ts`（`CoreEvent.todosChanged`、`UiRequest.sessionTodosRequested`）、`core-rs/src/main.rs`（`dispatch_ui_request`）、`src/host/coreFacts.ts`、`src/host/ui/webviewMessageHandler.ts`、`src/host/WebViewUI.ts`、`src/host/webviewMessages.ts`、`src/webview/App.tsx`、`src/webview/InputArea.tsx`、`src/webview/i18n/zh.ts`、`src/webview/i18n/en.ts` | `src/test/hostCoreFacts.test.ts`、`core-rs/src/engine_tests.rs`（推送载荷）、`e2e/webview/todoProgress.spec.ts`（文案与计数口径、推送即更新） | 自动 |
| FR-003 | `src/webview/InputArea.tsx`（悬停计时 / 固定状态 / 浮层） | `e2e/webview/todoProgress.spec.ts`（100ms 阈值、固定与取消、切换对话复位） | 自动 |
| FR-004 | `src/webview/colors.ts` 既有主题色 + `InputArea.tsx` 取色 | `e2e/webview/todoProgress.spec.ts`（dark / light 两轮渲染断言） | 自动 |
| FR-005 | `core-rs/src/tools.rs` 的 `sub_agent_role_tools` + `core-rs/src/prompt.rs` 角色说明 | `core-rs/src/tools_tests.rs` / `prompt_tests.rs`（白名单与说明一致）+ `e2e/electron/subagentExplorer.spec.ts` | 自动 |

## 待澄清

## 收敛记录

### 已满足

- **FR-001 / AC-1、AC-2、AC-3、AC-5**（Core 持有 + 从会话文件重建）：`core-rs/src/tools.rs` 的
  `TodoEntry` / `TODOS` / `store_session_todos` / `session_todos` / `ensure_session_todos` /
  `rebuild_todos_from_history`（最后一条 `exit_code == 0` 的 `TodoWrite`、double-encode 解析、
  文件缺失返回空）；会话关闭清理仍在 `engine.rs` 两处 `clear_session_todos`。
  证据：`tools_tests.rs::todo_rebuild_picks_last_successful_write` /
  `todo_rebuild_skips_failed_call_and_keeps_earlier_success` /
  `todo_rebuild_parses_double_encoded_todos` / `todo_rebuild_returns_empty_when_file_missing`；
  `main_tests.rs::ui_request_answers_session_todos`（重建结果写表、未知会话回空）；
  `compact_engine_tests.rs::todo_rebuild_after_compaction_and_restart_*` 两条。
- **FR-002 / AC-4、AC-6、AC-7**（索取 + 推送 + 计数）：契约两个成员
  （`CoreEvent.todosChanged`、`UiRequest.sessionTodosRequested`，`src/shared/AssistantEventBus.ts`）、
  Core 应答 `main.rs::dispatch_ui_request`、推送 `engine.rs::emit_tool_outcome`、
  宿主接线 `coreFacts.ts` / `ui/webviewMessageHandler.ts` / `WebViewUI.onTodosChanged` /
  `webviewMessages.ts`、webview 状态 `App.tsx` + 计数纯函数 `src/host/todoProgress.ts` +
  按钮 `InputArea.tsx`。
  证据：`engine_tests.rs::todo_write_emits_todos_changed`（载荷逐字段 + 事件顺序在 `toolResult` 之后）、
  `tools_tests.rs::todo_write_updates_the_session_table` / `todo_write_empty_list_clears_the_table` /
  `todo_write_failure_keeps_the_previous_table`、`src/test/todoProgress.test.ts`（6 条）、
  e2e `todoProgress.spec.ts` 的「显示 1/4」「推送更新到 2/4」「没有清单不渲染」。
- **FR-003 / AC-8…AC-12**（悬停与固定）：`InputArea.tsx` 的 `TODO_TIP_DELAY_MS = 100`、
  `todoHoveredRef` / `todoTipPinned` / `todoTipVisible`、`sessionId` 变化复位、
  浮层 `pointer-events-none` + `max-h` 内部滚动。
  证据：e2e「悬停满 100ms 才显示」「不足 100ms 移出不出」「点击固定 / 再点取消」「切换对话复位」。
- **FR-004 / AC-13**（配色）：新增块零硬编码色值（全取 `colors.*`）。
  证据：e2e「dark / light 两种主题下都可读」断言按钮文字色随主题变化。
- **FR-005 / AC-14…AC-16**（Explorer）：`tools.rs::sub_agent_role_tools` 加 `TodoWrite`、
  `prompt.rs` 角色说明同步点名。
  证据：`tools_tests.rs::sub_agent_role_registry_lists_roles_and_allowlists`、
  `prompt_tests.rs::explorer_role_description_matches_allowlist`、
  `engine_tests.rs::explorer_sub_agent_gets_role_toolset_and_rejects_others`（含拒绝文案五件套）、
  e2e `subagentExplorer.spec.ts` 2 条。
- **压缩面**（T004）：`compact_engine_tests.rs` 六条——`todo_table_survives_manual_compact`
  （并断言文件里那条调用已被摘要替换）、`todo_table_survives_repeated_compaction`、
  `todo_table_survives_compaction_after_new_write`、
  `todo_rebuild_after_compaction_and_restart_returns_empty` /
  `..._uses_surviving_write`、`todo_table_survives_auto_compact`（覆盖自动压缩分支）。
- **整体验证**：`check-types` / `lint` 绿；`cargo test` 947 通过 0 失败；`npm run test:all`
  72 通过 / 1 跳过（`sidebarFiles` 环境前置）；e2e webview 9 条、electron 2 条全绿；
  `docs-lint` 48 组全绿。

### 偏差

- **影响基线补两行**：实施期 docsLint 的数量对照要求同步 `docs/core/standalone-core.md`
  （`UiRequest` 十三 → 十四个）与 `docs/architecture/host-ui-modules.md`
  （`buildMessageHandlers()` 43 → 44），原影响基线漏列，已补进 spec。
- **边界补一条**：实现把表锁的 `unwrap()` 改成中毒后沿用内部数据（`lock_todos`），原 spec 未写，
  已补进「边界与错误路径」（表锁中毒）。
- **ADR 编号**：原定 `0010`，落库时 0009 未被占用、编号须连续，改为
  `docs/adr/0009-todo-state-owned-by-core.md`；specs/026 落地时需改用 0010。
- **dist 产物**：Electron e2e 读 `dist/resources/core/`，`build:core:host` 只更新 `resources/core/`；
  首次跑 subagentExplorer 因旧二进制失败，手动同步后通过（非代码问题，已记入 tasks.md 备注）。

### 未做

- 无。T001–T015 全部勾选。

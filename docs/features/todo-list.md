---
owner: pzlvv
last_reviewed: 2026-10-30
---

# 规格：Todo 清单与任务进度

本规格界定会话 Todo 清单的事实归属、恢复口径与两个渲染面：输入区的任务进度按钮（悬停 / 固定
浮层）与消息流里的 `TodoWrite` 工具卡片。清单由 Core 持有——`TodoWrite` 成功即写表、变更即
推送、宿主按需索取，进程重启后按会话文件重建。范围不含 `TodoWrite` 入参契约的扩展（id /
priority / cancelled / 依赖），也不含常驻侧栏面板。

交叉引用：契约成员见 [docs/architecture/events.md 第 2 节](../architecture/events.md#2-事件词汇表)；
宿主侧事实读取口径见 [docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)；
按钮与浮层的 webview 侧注册见 [docs/hosts/webview-ui.md 第 3 节](../hosts/webview-ui.md#3-总线注册)；
「core 描述事实，UI 决定表现」见 [principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)、
「派生字段从根字段推导」见 [principles.md 第 8 节](../architecture/principles.md#8-契约只写现状派生字段从根字段推导)；
决策背景见 [ADR-0009](../adr/0009-todo-state-owned-by-core.md)。

## 1. 用户场景与验收标准

- 场景 1：重开对话后恢复
  - **AC-1**（FR-001）：GIVEN 某对话最后一次成功调用 `TodoWrite` 写入 4 条（1 completed / 1 in_progress / 2 pending）WHEN 关闭应用后重开该对话 THEN 按钮显示 `任务进度: 1/4`（英文界面 `Progress: 1/4`），浮层的条目、顺序与状态与关闭前一致。
  - **AC-2**（FR-001）：GIVEN 对话 A 有 4 条 Todo、对话 B 从未调用 `TodoWrite` WHEN 在两者之间来回切换 THEN A 显示 `1/4` 且浮层为 A 的清单，B 不显示按钮。
  - **AC-3**（FR-001）：GIVEN 同一对话先后两次成功调用 `TodoWrite`（4 条 → 6 条）WHEN 重开该对话 THEN 只按最后一次调用显示（`x/6`）。
- 场景 2：变更推送与失败
  - **AC-4**（FR-002）：GIVEN 当前对话显示 `1/4` WHEN 模型调用 `TodoWrite` 把第 2 条改成 completed THEN 不重新加载对话，按钮在收到推送后变为 `2/4`，浮层同步。
  - **AC-5**（FR-001）：GIVEN 最近一次 `TodoWrite` 因入参校验失败返回错误 WHEN 查看进度 THEN 进度等于该次失败之前最后一次成功调用的结果。
  - **AC-6**（FR-002）：GIVEN 最近一次成功调用传入 `todos: []` WHEN 收到推送 THEN 不显示进度按钮。
  - **AC-7**（FR-002）：GIVEN 4 条全部 completed WHEN 渲染 THEN 按钮显示 `4/4`，浮层仍列出这 4 条已完成项。
- 场景 3：悬停与固定
  - **AC-8**（FR-003）：GIVEN 指针移入按钮 WHEN 悬停满 100ms THEN 浮层显示当前清单；GIVEN 指针在 100ms 内移出 WHEN 计时到期 THEN 浮层不出现。
  - **AC-9**（FR-003）：GIVEN 浮层已显示且未固定 WHEN 指针移出按钮 THEN 浮层立即隐藏。
  - **AC-10**（FR-003）：GIVEN 浮层未固定 WHEN 点击按钮 THEN 浮层常驻（指针移出不隐藏）；GIVEN 已固定且指针已移出 WHEN 再次点击 THEN 取消固定并立即隐藏。
  - **AC-11**（FR-003）：GIVEN 浮层已显示 WHEN 点击浮层内任意位置 THEN 不产生任何上行消息，固定状态不变。
  - **AC-12**（FR-003）：GIVEN 已固定 WHEN 切换到另一个对话 THEN 固定状态复位为未固定。
- 场景 4：主题
  - **AC-13**（FR-004）：GIVEN dark 与 light 两种主题 WHEN 渲染按钮与浮层 THEN 文字、背景、边框取自主题色，状态标记与消息流工具卡片同一配色，两种主题下都可读。
- 场景 5：Explorer 的 Todo
  - **AC-14**（FR-005）：GIVEN `agentRole="Explorer"` 的子代理会话 WHEN 调用 `TodoWrite` THEN 调用成功，写入该子代理自己的会话 Todo 表并可从其会话文件重建。
  - **AC-15**（FR-005）：GIVEN 打开 Explorer 子代理会话视图 WHEN 渲染输入区 THEN 进度按钮按该子代理会话的 Todo 显示，不受父对话影响。
  - **AC-16**（FR-005）：GIVEN Explorer 调用白名单外的工具（如 `Edit`）WHEN 执行 THEN 拒绝，错误文案点名该角色可用的工具且包含 `TodoWrite`；GIVEN 系统提示里的角色说明 WHEN 读 Explorer 条目 THEN 点名的工具与该角色白名单一致。

## 2. 功能需求

### FR-001：Core 按对话持有 Todo 表，可从会话文件重建

Core 进程维护一份按 `sessionId` 索引的 Todo 表，它是 Todo 状态的唯一持有者：`TodoWrite` 校验
通过即写表（失败不写），会话关闭 / 删除时清理，上下文压缩不改动表（压缩重写的是消息数组）。

表里没有该会话条目时（Core 刚启动，或该对话本次进程内从未写过 Todo），Core 读该对话的会话
文件，取**最后一条成功的 `TodoWrite`** 的 `todos` 入参重建并写表；「成功」以该次调用的
`tool_result.exit_code == 0` 为准（缺 `exit_code` 视为成功）。重建结果与当次入参逐项一致
（条目、顺序、状态），此后以表为准。

### FR-002：宿主索取与 Core 推送，两条路径合流到同一个渲染状态

宿主经请求-响应通道索取某对话的当前清单（`sessionTodosRequested`），Core 应答完整清单；会话
文件不存在时返回空数组，不报错。`TodoWrite` 成功后 Core 主动推送完整清单（`todosChanged`），
webview 收到即更新，不需要重新加载对话。

webview 在会话加载后索取一次，之后靠推送更新；索取应答与推送写同一个按 `sessionId` 索引的
状态，按钮与浮层只认这一份数据源。

按钮常驻输入区底栏右侧按钮组的最左位、紧挨菜单按钮。文案只有两段：中文
`任务进度: <done>/<total>`、英文 `Progress: <done>/<total>`。计数口径：`total` = 清单长度，
`done` = 其中 `status` 为 `completed` 的条数（`in_progress` / `pending` 都不计入），不做去重、
过滤或截断。清单为空时不渲染按钮，不出现 `0/0` 或置灰占位。

### FR-003：悬停显示与点击固定

指针停留满 100ms 显示浮层，不足 100ms 移出则浮层不出现；未固定时移出立即隐藏。点击按钮固定
浮层（常驻），再次点击取消固定并回到悬停规则。固定态是 UI 本地状态，切换对话后复位。

浮层逐条一行（状态标记 + `content`），条目字号、状态标记配色与消息流里的 `TodoWrite`
工具卡片一致（状态标记色共用 `src/webview/tools/TodoWrite.tsx` 的 `TODO_STATUS_COLOR` 一份
常量）；`in_progress` 条目文字颜色与其它条目一致并加粗，`completed` 条目划线置灰。浮层只读：
点击不产生任何上行消息，也不改变固定状态；除条目本身外不显示其它文案。浮层右边缘与输入区
对齐，宽度随条目内容自适应，最宽不超过输入区宽度。

指针事件的口径按固定态分两档：**悬停态穿透**（`pointer-events: none`，指针移出按钮即按
悬停规则隐藏，不经浮层中转）；**固定态接收指针事件**，条目文字可选中并复制，清单超出一屏
时在浮层内部滚动（见第 4 节「清单很长」）。固定态下的点击 / 拖选 / 滚动都不产生上行消息，
也不改变固定状态。

### FR-004：按钮与浮层的配色

按钮文字、浮层背景 / 边框 / 文字取自既有主题色（dark / light 两套）；状态标记配色是
`src/webview/tools/TodoWrite.tsx` 的 `TODO_STATUS_COLOR` 一份常量，工具卡片与浮层共用，两个
渲染面颜色一致。固定态与默认态在按钮本身上有可见区分（底色变化），不靠新增文字表达。

### FR-005：Explorer 角色加入 TodoWrite

Explorer 子代理的工具白名单为 `Read` / `Glob` / `Grep` / `Reply` / `TodoWrite`，其余内置工具
与 `mcp__*` 仍不可用；系统提示里 Explorer 的角色说明点名的工具与该白名单一致。Explorer 的
Todo 与其它对话同口径（FR-001 / FR-002），写进它自己的会话 Todo 表，不受父对话影响。

## 3. 行为规格

### 3.1 数据流

```text
TodoWrite ──成功──▶ Core 的 sessionId → [TodoEntry] 表（唯一持有者）
                       ├─ UiRequest.sessionTodosRequested ──▶ 宿主索取快照
                       └─ CoreEvent.todosChanged ─────────▶ 变更推送（全量清单）
                               ↓ 两条入径合流
                     webview 的 sessionTodos 状态 ──countTodoProgress()──▶ 按钮 / 浮层
```

「哪个工具改 Todo」只写在 `tools.rs`：`run_todo_write` 成功后返回
`ToolOutcome::SuccessWithTodos`，`engine.rs` 的 `emit_tool_outcome` 在 `toolResult` 之后推送
`todosChanged`（串行与并行两条执行路径共用该函数，推送只接一处）。

### 3.2 计数与派生

`done` / `total` 的唯一实现是 `src/host/todoProgress.ts` 的 `countTodoProgress`：空清单返回
`null`（调用方据此不渲染按钮），否则返回 `{ total, done, items }`，`items` 原样透出供浮层
渲染。Core 不存计数。

### 3.3 失败与流式

`TodoWrite` 校验失败不写表、不推送，进度保持上一次成功的结果。入参在流式过程中不完整时该次
调用尚未执行，因此不会写表。

## 4. 边界与错误路径

- **会话文件不存在 / 从未写过 Todo**：索取返回空清单，按钮不渲染。
- **`todos` 被序列化成字符串**（字段级 double-encode）：重建时按 JSON 解析；解析失败视为该次
  调用无效，继续向前找更早的一次成功调用。
- **压缩**：压缩重写消息数组不影响表，进度在进程存活期间保持不变；进程重启后重建时，若最后
  一条成功 `TodoWrite` 已落在被摘要替换的区间，该对话视为无 Todo（按钮隐藏）。压缩后保住
  进度需要落盘快照，见非目标。
- **并发**：`TodoWrite` 写表与索取读表串行化，索取返回应答时刻的完整快照；重建期间发生的
  写入以写表者为准（写表内容比文件旧快照新）。
- **清单很长**：浮层内容超出可视高度时内部滚动，按钮文案不变。
- **子代理会话**：Explorer / Master 的 Todo 各占表内一条，互不串。

## 5. 非目标

- 常驻侧栏面板、跨对话汇总的全局任务视图（去向 [TODO.md](../../TODO.md)）。
- Todo 表落 `meta.json`（跨进程 + 跨压缩的持久快照）（去向 [docs/architecture/open-questions.md](../architecture/open-questions.md)）。
- `TodoWrite` 入参契约扩展：稳定 id、priority、cancelled、依赖 / 阻塞（去向 [TODO.md](../../TODO.md)）。
- 运行期强制「只有一个 in_progress」（现状只在提示词里约定）。
- 每轮把清单再注入模型上下文；模型侧仍只有 `TodoWrite` 的 tool_result 回显，没有只读工具。
- TUI 输入区的进度按钮（`tui-rs/` 不做）。

## 6. 对需求基线的影响

- 新增 US-59（输入区任务进度按钮），登记在
  [docs/features/user-stories/dialog-core.md](user-stories/dialog-core.md#ep-2-输入区与会话配置) 的 EP-2。
- 修改 US-51 验收标准 1：Explorer 工具清单加 `TodoWrite`。
- 新增契约成员 `CoreEvent.todosChanged` 与 `UiRequest.sessionTodosRequested`（[docs/architecture/events.md 第 2 节](../architecture/events.md#2-事件词汇表)）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（`TodoEntry` / `TODOS` / `ensure_session_todos` / `rebuild_todos_from_history`）、`core-rs/src/engine.rs`（会话关闭清理） | `core-rs/src/tools_tests.rs`（`todo_rebuild_*`）、`core-rs/src/compact_engine_tests.rs`（`todo_table_survives_*`、`todo_rebuild_after_compaction_*`） | 自动 |
| FR-002 | `src/shared/types.ts`（`TodoEntry`）、`src/shared/AssistantEventBus.ts`、`core-rs/src/main.rs`（`dispatch_ui_request`）、`core-rs/src/engine.rs`（`emit_tool_outcome`）、`src/host/coreFacts.ts`、`src/host/ui/webviewMessageHandler.ts`、`src/host/WebViewUI.ts`、`src/host/todoProgress.ts`、`src/webview/App.tsx`、`src/webview/InputArea.tsx` | `core-rs/src/engine_tests.rs`（`todo_write_emits_todos_changed`）、`core-rs/src/main_tests.rs`（`ui_request_answers_session_todos`）、`src/test/todoProgress.test.ts`、`e2e/webview/todoProgress.spec.ts` | 自动 |
| FR-003 | `src/webview/InputArea.tsx`（悬停计时 / 固定状态 / 浮层） | `e2e/webview/todoProgress.spec.ts`（100ms 阈值、固定与取消、切换对话复位） | 自动 |
| FR-004 | `src/webview/colors.ts` 既有主题色 + `src/webview/tools/TodoWrite.tsx`（`TODO_STATUS_COLOR`，卡片与浮层共用）+ `InputArea.tsx` 取色 | `e2e/webview/todoProgress.spec.ts`（dark / light 两轮渲染） | 自动 |
| FR-005 | `core-rs/src/tools.rs`（`sub_agent_role_tools`）、`core-rs/src/prompt.rs`（角色说明） | `core-rs/src/tools_tests.rs`（`sub_agent_role_registry_lists_roles_and_allowlists`）、`core-rs/src/prompt_tests.rs`（`explorer_role_description_matches_allowlist`）、`e2e/electron/subagentExplorer.spec.ts` | 自动 |

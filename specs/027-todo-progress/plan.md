# 实施方案：按对话维护的 Todo 与输入区任务进度

技术路线一句话：**Core 持有按 `sessionId` 索引的 Todo 表**（`TodoWrite` 成功即写表并推送变更，
宿主经 `UiRequest` 索取快照，进程重启后按会话文件重建），webview 只消费这两条路径合流的
一份状态。需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 事实归属与数据流

```text
                      ┌──────────── Core 进程 ────────────┐
TodoWrite ──成功──▶   │ sessionId → [TodoEntry]（唯一持有者）│
                      │        │                │          │
      <sid>.jsonl ──▶ │  重建（表无条目时）      │          │
                      └────────┼────────────────┼──────────┘
                               │                │
                     UiRequest.sessionTodosRequested   CoreEvent.todosChanged
                        （宿主按需索取）        （变更推送）
                               │                │
                               └───────┬────────┘
                                       ▼
                       webview：sessionTodos 状态 ──countTodoProgress()──▶ InputArea
```

两条入径落到 webview 的**同一个**状态与同一个渲染路径：索取应答与推送都用同一条 wire 消息
（`sessionTodos`），webview 不区分来源，也不各自维护副本。

### 2. Core 侧：表、写入、重建、推送

**表**（`core-rs/src/tools.rs`）：把现有 `static TODOS: Mutex<Option<HashMap<String, Value>>>`
改成类型化的 `Mutex<HashMap<String, Vec<TodoEntry>>>`，`TodoEntry { content, status,
active_form }`（serde 序列化为 `content` / `status` / `activeForm`）。它现在是**唯一持有者**，
不再是只写不读的死状态。`clear_session_todos` 保留（会话关闭 / 删除时清理，engine 两处调用不动）。

**写入**：`run_todo_write` 保持现有校验与结果文案；校验通过后写表，并返回新的
`ToolOutcome::SuccessWithTodos { text, todos }`。新增这个变体是为了让「哪个工具改变 Todo」
只在 `tools.rs` 里决定，engine 只负责把它翻译成事件——与既有 `SuccessWithMessages`（Skill
注入正文）同一套路，因此**不需要给 `ToolContext` 加字段**（否则要改 18 处测试字面量）。
`is_status_error` / `exit_code` / `text` / `cap_tool_result` 四处 match 各补一个分支。

**重建**（新增 `tools::ensure_session_todos(session_id) -> Value`）：表里没有该会话条目时，
`history::project_of_session` + `history::load_messages` 读出会话文件，按
`tool_use` / `tool_result` 配对扫描，取**最后一条 `exit_code == 0` 的 `TodoWrite`** 的
`input.todos`，规范化后写表并返回。`todos` 是字符串时先 `JSON.parse` 等价解析，失败视为
该次无效继续向前扫；文件不存在返回空数组（不报错，与 `conversationLoadRequested`
「文件不存在返回空」同口径）。`load_messages` 已经回放 `tool_use_update`，double-encode
修复过的入参也能读到。

**推送**：`engine.rs::emit_tool_outcome` 增加 `SuccessWithTodos` 分支——上报 toolResult 之后
`core.emit({ type: 'todosChanged', sessionId, todos })`。串行与并行两条执行路径共用这个函数，
所以只接一处。

### 3. 契约：一个 UiRequest + 一个 CoreEvent

- `UiRequest.sessionTodosRequested { sessionId }` → `TodoEntry[]`（空数组表示没有 Todo）。
  `UiRequestResultMap` 同步加一条。Core 侧在 `main.rs::dispatch_ui_request` 加分支，
  调 `tools::ensure_session_todos`。
- `CoreEvent.todosChanged { sessionId, todos: TodoEntry[] }`（全量清单，不推增量）。
- `TodoEntry` 放 `src/shared/types.ts`（core 与 webview 共用同一形状），`activeForm` 必选，
  没有 `?`。
- wire 消息：`HostToWebviewMessage` 加 `sessionTodos { sessionId, todos }`；入站
  `WebviewToHostMessage` 加 `requestSessionTodos { sessionId }`。

### 4. 宿主侧接线

| 落点 | 改动 |
| --- | --- |
| `src/host/coreFacts.ts` | 新增 `requestSessionTodos(sessionId)` → `requestCore({ type: 'sessionTodosRequested', sessionId })` |
| `src/host/ui/webviewMessageHandler.ts` | 入站 `requestSessionTodos` → 调 `coreFacts` → 回推 `sessionTodos` |
| `src/host/WebViewUI.ts` | `onCoreEvents` 新增 `onTodosChanged` → `postToWebview(sessionId, { type: 'sessionTodos', todos })` |
| `src/host/webviewMessages.ts` | 两条 wire 消息的类型 |

### 5. webview：状态、纯函数、按钮与浮层

- **状态**：`App.tsx` 新增 `sessionTodos: TodoEntry[]`，由 `sessionTodos` wire 消息写入；
  切换 / 挂载对话时发 `requestSessionTodos`（与既有 `loadConversation` 同一入口时机）。
- **纯函数**：`src/host/todoProgress.ts` 新增 `countTodoProgress(todos): TodoProgress | null`
  ——`total = 长度`、`done = completed 条数`、`items` 原样透出；空数组 → `null`。零依赖，
  风格对齐 `src/host/abortButtonState.ts`（webview import host 纯函数是既有先例）。
- **按钮**：Row 2 右侧按钮组首位（`ToggleMenu` 之前），仅在 `TodoProgress !== null` 时渲染；
  文案 `t('inputArea.todoProgress', { done, total })`，zh `任务进度: {done}/{total}`、
  en `Progress: {done}/{total}`，不加 `title`、不加图标文字。
- **交互**：`hoveredRef` + `todoTipPinned` + `todoTipVisible` + `TODO_TIP_DELAY_MS = 100`
  （写法对齐既有 `ABORT_TIP_DELAY_MS`）：
  - `mouseenter` → 起 100ms 计时；`mouseleave` → 清计时，未固定立即隐藏；
  - `click` → 翻转固定；转固定立即显示，取消固定时指针不在按钮上则隐藏；
  - `sessionId` 变化 → 清计时 + 复位固定态与可见态（沿用 abort 浮层的 `useEffect` 写法）。
- **浮层**：复用 abort 浮层的定位/外观类 + `pointer-events-none`（只读，点击不产生上行）；
  条目行复用 `Icon` 的 `square` / `circle-dot` / `check-square`，`in_progress` 行附
  `activeForm`；超长 `max-h` + 内部滚动。
- **配色**：全取 `colors`——`bgSecondary` / `border` / `textPrimary` / `textSystem` /
  `harness`（进行中）/ `timelineStatusSuccess`（完成）。不新增 hex（既有
  `tools/TodoWrite.tsx` 里的硬编码色值属另一处遗留，本次不动）。
- **可测钩子**：`data-todo-progress` / `data-todo-progress-pinned` / `data-todo-progress-tip`。

### 6. Explorer 加入 TodoWrite

- `tools.rs::sub_agent_role_tools("Explorer")` → `["Read", "Glob", "Grep", "Reply", "TodoWrite"]`
  （数组顺序即拒绝文案里的列举顺序）。
- `prompt.rs` 的 Explorer 角色说明改写：现文案是「restricted to read-only tools (Read, Glob,
  Grep)」，必须点名 TodoWrite，否则模型会以为没有该工具（spec AC-19）。
- 测试：`tools_tests.rs` 的「Explorer 恰为四件套」用例改五件套；`prompt_tests.rs` 补一条断言
  ——Explorer 角色说明点名的工具与 `sub_agent_role_tools("Explorer")` 逐项一致。

### 7. 文档 delta 与落地顺序

1. `docs/architecture/events.md`：2.1 表加 `todosChanged` 行（触发点写 `engine.rs` 的
   `emit_tool_outcome`）、2.4 表加 `sessionTodosRequested` 行、汇总数字随代码校验自动对齐；
2. `docs/core/standalone-core-boundaries.md` 第 2 节表格加一行「会话 Todo 清单」；
3. `docs/hosts/webview-ui.md` 第 3 节：`onCoreEvents` 31 → 32，控制面与事实通知分区同步点名；
4. 新增 `docs/features/todo-list.md`（`docs/features/` 固定七节骨架）与
   `docs/adr/0009-todo-state-owned-by-core.md`；
5. `docs/features/user-stories/dialog-core.md`：EP-2 加 US-59、US-51 验收标准 1 改五件套；
6. `docs/features/user-stories.md` 附录：US-59 → `e2e/webview/todoProgress.spec.ts`；
7. `docs/README.md` 地图登记新规格与 ADR。

顺序约束：**US 映射行与 e2e 文件同一次提交落库**（docsLint 的「US ↔ e2e 映射双向一致」
同时校验 US 标题与 e2e 文件存在）；`events.md` 与契约改动同一次提交（docsLint 的
「事件载荷列与联合类型逐字段一致」「2.1 触发点列与真实 emit 位点一致」）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/types.ts` | 修改 | 新增 `TodoEntry`（`content` / `status` / `activeForm` 全必选） |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `CoreEvent.todosChanged`、`UiRequest.sessionTodosRequested`、`UiRequestResultMap` 一条 |
| `src/host/webviewMessages.ts` | 修改 | 新增 wire `sessionTodos`（下行）与 `requestSessionTodos`（上行） |
| `src/host/coreFacts.ts` | 修改 | 新增 `requestSessionTodos` |
| `src/host/ui/webviewMessageHandler.ts` | 修改 | 入站分支 + 回推 |
| `src/host/WebViewUI.ts` | 修改 | `onCoreEvents` 新增 `onTodosChanged`（映射表 31 → 32） |
| `src/host/todoProgress.ts` | 新增 | 无（纯函数，零依赖） |
| `src/webview/App.tsx` | 修改 | 新增 `sessionTodos` 状态、索取时机、消息处理 |
| `src/webview/InputArea.tsx` | 修改 | 新增 `todoProgress` prop、按钮与浮层 |
| `src/webview/i18n/zh.ts`、`en.ts` | 修改 | 新增 `inputArea.todoProgress` 一条 |
| `core-rs/src/tools.rs` | 修改 | 表类型化 + `ensure_session_todos` + `ToolOutcome::SuccessWithTodos` + Explorer 白名单加 `TodoWrite` |
| `core-rs/src/engine.rs` | 修改 | `emit_tool_outcome` 增 `todosChanged` 推送分支（`clear_session_todos` 两处保留） |
| `core-rs/src/main.rs` | 修改 | `dispatch_ui_request` 增 `sessionTodosRequested` 分支 |
| `core-rs/src/prompt.rs` | 修改 | Explorer 角色说明文案 |
| `core-rs/src/{tools,engine,prompt}_tests.rs` | 修改 | 重建 / 推送 / 白名单 / 说明一致性用例 |
| `e2e/webview/todoProgress.spec.ts` | 新增 | US-59 用例（假宿主下发 `sessionTodos`） |
| `e2e/electron/subagentExplorer.spec.ts` | 修改 | 工具四件套断言改五件套 |
| `docs/**` | 修改 / 新增 | 见技术方案第 7 节 |

落盘格式不变：`<sid>.jsonl` 不新增字段，`src/shared/history/` 与 Rust 侧对照表不动。
`tui-rs/` 不涉及（spec 非目标）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：契约成员只加在
      `src/shared/AssistantEventBus.ts`（core 与 UI 之间唯一的边）；新增纯函数放 `src/host/`
      且零依赖（不 import `vscode` / `electron`、不 import core 类型）；core-rs 只经帧通道通信，
      不 import 宿主；无 `host.kind === '...'` 嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      **一份事实只有一个写入点**——Todo 表只在 Core、只由 `run_todo_write` 写，重建也只写这一处；
      webview / 宿主都不留副本。**core 描述事实，UI 决定表现**——Core 只给清单与状态，计数、
      悬停、固定、配色全在 UI。**派生字段从根字段推导**——`done` / `total` 由
      `countTodoProgress` 单一纯函数算出，Core 不存计数。**契约成员全必选**，无 Todo 用空数组、
      渲染态用 `null`，不用可选字段。**不过度 fallback**——索取遇到不存在的会话返回空数组是
      既定契约（与 `conversationLoadRequested` 同口径），解析失败的入参跳过并在注释里写明理由。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动
      落 `core-rs/` 并同步 Rust 测试；**落盘格式不变**（不新增字段、不改 `<sid>.jsonl` 结构），
      故 `src/shared/history/` 与 Rust 对照表都不动；单一 Rust Core（ADR-0007），无双 Core parity
      义务。新增契约成员的义务是「TS 联合 + Rust `dispatch_ui_request` + `events.md` 表格 + 两侧
      映射表」四处同步，已在受影响模块中逐项列出。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`events.md` 两张表 +
      `standalone-core-boundaries.md` 事实表 + `webview-ui.md` 映射表数字 + 新增特性规格与 ADR +
      US-59 / US-51，全部与代码同一提交；`npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

1. **webview 从 `messages` 里投影（不回 Core）**：一是事实归属错了——Core 才是 Todo 的持有者，
   webview 只是渲染面；二是不可靠——压缩会把旧 `tool_use` 换成摘要，webview 手里可能根本没有
   那条调用；三是多消费者各算一份（TUI / 远程工作区 / 未来侧栏），必然漂移。
2. **每次索取都从会话文件重建，不设内存表**：流式期间 `TodoWrite` 已执行但 assistant 消息可能
   尚未落盘，重建会读到旧值（事实滞后）；压缩后文件里可能已无该调用。内存表 + 文件重建的组合
   才同时满足「即时」与「可恢复」。
3. **只在 `conversationLoaded` 载荷里带 todos**：少一个请求成员，但 webview 重挂载而对话未重载时
   拿不到状态；且会与推送形成两条入径、两套 webview 状态写入，容易漂移。
4. **Core 只推送、不提供索取**：推送是边沿触发，Core 不知道 webview 何时挂载 / 恢复，必然漏。
5. **给 `ToolContext` 加 `on_todos_changed` 钩子**：与 `subagent_hooks` 同构，但要改
   `tools_tests.rs` 里 18 处 `ToolContext` 字面量；`ToolOutcome::SuccessWithTodos` 只需在
   engine 一处翻译，改动面更小且「哪个工具改 Todo」仍只写在 `tools.rs`。
6. **Todo 表落 `meta.json`**：能跨进程 + 跨压缩，但要把落盘格式改成两侧同步并新增 Rust 对照表
   用例；spec 已列非目标（去向 `docs/architecture/open-questions.md`）。
7. **用 `title` 属性做悬停提示**：native title 延迟不可控，做不到 100ms 阈值，也无法点击固定
   （specs/019 已因同一理由否决过 native title）。

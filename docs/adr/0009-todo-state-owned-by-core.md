# ADR-0009：Todo 状态由 Core 持有，宿主按需索取、变更推送

- 状态：已采纳
- 日期：2026-10
- 规格：`docs/features/todo-list.md`、`docs/architecture/events.md`

## 背景

`TodoWrite` 工具原本把清单写进 Core 进程内的一张 `sessionId → todos` 表，但那张表**没有任何
读者**：没有 UI 展示、没有事件推送、模型侧只有工具结果里的一次回显。于是三个问题同时成立：

- 清单跟着进程走，宿主重开、切换对话都看不到；进程重启后彻底丢失；
- 上下文压缩会把旧的 `tool_use` 换成摘要，靠消息回放重建清单在压缩后不可靠；
- 清单是「给人看的进度感」，但界面上除了那条工具卡片以外没有任何进度位置。

需要一个明确的归属：清单是 Core 的事实（它有唯一的写入点，且需要跨消息数组的生命周期），
还是 webview 的派生状态（从消息里算）？

## 决策

**清单由 Core 持有，宿主按需索取，变更时推送。**

- Core 维护 `sessionId → [TodoEntry]` 表，`TodoWrite` 校验通过即写表（唯一写入点），会话关闭 /
  删除时清理；压缩不动表。
- 表里没有该会话时按会话文件重建：取最后一条 `tool_result.exit_code == 0` 的 `TodoWrite`
  入参（`ensure_session_todos`）。
- 宿主经 `UiRequest.sessionTodosRequested` 索取快照（会话加载后索取一次）；
  `TodoWrite` 成功后 Core 推 `CoreEvent.todosChanged`（全量清单）。
- webview 把两条入径合流成一个按会话的状态，`done` / `total` 由
  `src/host/todoProgress.ts` 的纯函数算出，Core 不存计数。

## 替代方案（被否决）与后果

**否决 1：webview 从 `messages` 里投影，Core 不持有。** 事实归属错了——Core 才是清单的写入点，
webview 只是渲染面；而且压缩会把旧 `tool_use` 换成摘要，webview 手里可能根本没有那条调用；
多消费者（TUI / 远程工作区 / 未来的侧栏）各算一份必然漂移。

**否决 2：每次索取都从会话文件重建，不设内存表。** 流式期间 `TodoWrite` 已执行但 assistant
消息可能尚未落盘，重建会读到旧值；压缩后文件里可能已无该调用。内存表 + 文件重建的组合才同时
满足「即时」与「可恢复」。

**否决 3：只在 `conversationLoaded` 载荷里带清单。** 少一个请求成员，但 webview 重挂载而对话
未重载时拿不到状态，且会与推送形成两条入径、两套 webview 状态写入。

**否决 4：Core 只推送、不提供索取。** 推送是边沿触发，Core 不知道 webview 何时挂载 / 恢复，
必然漏掉首次渲染。

**否决 5：给 `ToolContext` 加 `on_todos_changed` 钩子。** 与 `subagent_hooks` 同构，但要改
`tools_tests.rs` 里十几处 `ToolContext` 字面量；`ToolOutcome::SuccessWithTodos` 只需在
`emit_tool_outcome` 一处翻译，且「哪个工具改 Todo」仍只写在 `tools.rs`。

**代价。** 契约面多两个成员（一个 `CoreEvent`、一个 `UiRequest`），要同步 TS 联合、Rust
`dispatch_ui_request`、`events.md` 两张表与两侧映射表；清单不落盘，所以「压缩 + 进程重启」
组合下进度仍会丢（落 `meta.json` 快照列为非目标，见
[docs/architecture/open-questions.md](../architecture/open-questions.md)）。

**好处。** 清单跨对话、跨重启可恢复；压缩不再影响进度；宿主与 webview 都不留副本，多消费者
读同一份事实。

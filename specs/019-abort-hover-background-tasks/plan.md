# 实施方案：abort 按钮黄色态悬停显示运行明细

技术路线：Core 在 `emit_runtime` 组装快照时把「运行中后台任务清单」与「子代理创建时
描述」一并写进 `SessionRuntimeState`（契约新增两个必填成员，随既有全量推送流到达
webview，不加新事件 / 请求）；webview 用一份纯函数从快照聚合「运行中子代理清单」，
`InputArea` 在黄色态按钮上做 1 秒悬停计时，弹只读浮层。需求见同目录
[spec.md](spec.md)。

## 技术方案

### 数据流（自上而下与既有流完全同路）

```
core registries（TASKS / sessions）──emit_runtime──▶ sessionRuntimeChanged.states（全量）
   ConversationManager.updateSessionStates（透传，不剥字段）──▶ webview sessionRuntimeStatesRef
    App: abortHoverDetail（state.backgroundTasks + collectRunningSubAgents 聚合）──props──▶
    InputArea: 悬停 1s ──▶ 只读浮层
```

### Core（core-rs）

1. `engine.rs` 的 `SessionState` 新增 `sub_agent_description: Option<String>`
   （`new()` 初始化 `None`）；`create_sub_agent` 在写 `sub_agent_role` 处一并写
   `request.description`。spin 的子代理走同一条 `create_sub_agent` 路径，自动覆盖。
2. `emit_runtime`：在既有的 per-session 状态锁块内多读 `sub_agent_description`；对每个
   会话调 `bash_task::running_tasks_for_session(session_id)` 取运行中任务（只取
   `task_id` / `description` / `command`，pid / start_time 不进快照）。
   **锁序说明**：`running_tasks_for_session` 短暂锁 `TASKS`，发生在 `emit_runtime` 持
   `sessions` 锁期间——bash_task 的所有引擎回调（`register_running` / `handle_finish`
   的 `notify` / `sync_background` hooks）都在释放 `TASKS` 锁**之后**调用，锁序单向
   `sessions → TASKS`，无死锁。
3. `runtime_state_json` 扩签名（新增 `background_tasks` 与 `sub_agent_description`
   两个参数），输出：
   - `"backgroundTasks": [{"taskId", "description", "command"}, ...]`（注册序，空清单
     为 `[]`）；
   - `"subAgentDescription": <string | null>`。
   快照 diff（`last_runtime`）自动把清单变化当作状态变化（两个任务剩一个时布尔位不变、
   清单变 → 仍推送，spec AC-9）。
4. fixture 与测试：
   - `core-rs/fixtures/runtimeState.json` 的 `fields` 追加 `backgroundTasks` /
     `subAgentDescription`；
   - `main_tests.rs` 的 `runtime_state_fields_match_parity_fixture` 调用点补两个实参；
   - `engine_tests.rs` 新增三个用例：①快照按注册序列出运行中任务、任务结束后清单收敛
     为空（AC-7）；②子代理条目带创建时 description、普通会话为 `null`（AC-8）；③两个
     运行中任务结束其一，布尔位不变仍触发新推送且清单只剩一项（AC-9）。

### 共享层与 webview

5. `src/shared/AssistantEventBus.ts`：`SessionRuntimeState` 追加
   `backgroundTasks: readonly BackgroundTaskBrief[]` 与
   `subAgentDescription: string | null`（全必选，空集用空数组）；新增
   `BackgroundTaskBrief { taskId, description, command }`。
6. `src/webview/types.ts`：镜像同两成员（含注释，指向 session-runtime.md）。
7. `src/shared/sessionRuntime.ts` 新增唯一聚合纯函数
   `collectRunningSubAgents(states, sessionId)`：取 `parentSessionId === sessionId` 且
   `idle === false` 的条目，递归展开下层非空闲子代理，深先序、同层按 `states` 数组顺序
   （core 的 `session_order` 即创建序，宿主与 webview 的 Map 都保序）。只经非空闲节点
   下钻——core 的 `idle` 本就是递归合取，空闲节点的下层不可能在跑。返回
   `{ sessionId, description: string | null }[]`。webview 与单测共用这一份。
8. `src/webview/App.tsx`：仿 `abortButtonState` 的 useMemo 模式（依赖
   `currentSessionId` / `sessionIdleVersion`）计算 `abortHoverDetail =
   { tasks: state.backgroundTasks ?? [], subAgents: collectRunningSubAgents(...) }`——
   `?? []` 是 spec「边界与错误路径」明文豁免的缺字段口径（旧宿主 / 假宿主未带新字段），
   注释引用 spec。新增 prop 传给 `InputArea`（连同 `sessionId`，见下）。
9. `src/webview/InputArea.tsx`：
   - 新增 props：`sessionId: string`（会话切换时重置浮层）、`abortHoverDetail`；
   - abort 按钮外包 `relative` 容器；`onMouseEnter` 仅在
     `abortButtonState === 'background'` 时起 1s 定时器（常量
     `HOVER_TOOLTIP_DELAY_MS = 1000`），`onMouseLeave` 清定时器并隐藏；
   - `useEffect`：`abortButtonState` 离开 `background`、或 `sessionId` 变化 → 清定时器
     并隐藏（spec FR-003「会话切换时浮层隐藏」）；
   - 浮层：`absolute bottom-full` 定位在按钮上方，复用下拉菜单的主题 token
     （`dropdownMenuTheme.ts`），**`pointer-events: none`**——浮层是只读投影，指针事件
     穿透既避免「移入浮层即触发按钮 mouseleave 闪烁」，也让 AC-10（点击条目无上行）
     天然成立；渲染条件 `visible && (tasks.length > 0 || subAgents.length > 0)`
     （两组皆空不弹，含恢复态 spin）；显示期间 props 刷新即内容刷新（React 重渲染），
     双组清空时条件失效自动关闭（AC-11）；
   - 条目渲染：任务项显示 `description`，`command !== description` 时次行等宽字体附
     `command`；子代理项显示 `subAgentDescription`，`null` 显示 i18n 回退文案；
   - native `title`：黄色态不再设置（`undefined`），红 / 灰维持 `t('inputArea.abort')`。
10. i18n（`src/webview/i18n/zh.ts` / `en.ts`）：新增
    `inputArea.abortHoverTasks`（后台任务 / Background tasks）、
    `inputArea.abortHoverSubAgents`（子代理 / Sub-agents）、
    `inputArea.abortHoverSubAgentFallback`（未命名子代理 / Unnamed sub-agent）；
    删除不再被引用的 `inputArea.abortBackground`。

### 测试

11. `src/test/sessionBusyLevel.test.ts`：`collectRunningSubAgents` 用例——直接子代理、
    嵌套深先序、空闲子代理跳过、无子代理返回空、普通会话（无 `parentSessionId` 指向）
    返回空。
12. `e2e/webview/conversation.spec.ts`：既有三态用例旁新增悬停用例（fakeHost 的
    `runtimeStates` 原样透传，无需改 helper）：
    - 注入黄色态 + `backgroundTasks` 一项 + 一对父子会话条目（`parentSessionId` +
      `subAgentDescription`）→ `hover()` 后浮层出现且含 description 文本（AC-1 / AC-2，
      断言超时须 > 1s）；
    - `mouse.move()` 移出 → 浮层消失（AC-4）；悬停红色态 → 无浮层（AC-5）；
    - 两个任务注入后改为一个 → 浮层内容刷新（AC-11 简化版）；点击浮层区域 →
      `host.waitForSent('abort')` 不到达（AC-10）。

### 文档同步（实施提交内完成，`npm run test:all -- docs-lint` 守绿）

13. 按规格「影响基线」表逐处同步：`session-runtime.md` [第 2 节](../../docs/core/session-runtime.md#2-对外快照)字段表加两行；
    `contracts.md` [第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager)成员说明；`events.md` [第 2 节](../../docs/architecture/events.md#2-事件词汇表) `sessionRuntimeChanged` 行备注
    （载荷列仍是 `states`，docsLint 若要求元素结构备注则同步）；`webview-ui.md` [第 8 节](../../docs/hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定)
    链路表 webview 行补浮层；`user-stories.md` 索引 + 分册 dialog-core.md 新增 US-52 + 附录映射表；收敛时
    （/converge）本 spec 的 FR / AC 并入 `abort-button.md`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | `SessionRuntimeState` 新增两成员；新增 `BackgroundTaskBrief` | 契约成员新增：`backgroundTasks` / `subAgentDescription` |
| `src/shared/sessionRuntime.ts` | 新增 `collectRunningSubAgents` 纯函数 | 无 |
| `src/webview/types.ts` | 镜像两成员 | 无（镜像同步） |
| `src/webview/App.tsx` | `abortHoverDetail` useMemo + 传参 | 无 |
| `src/webview/InputArea.tsx` | 悬停计时、浮层、title 调整、新增 `sessionId` / `abortHoverDetail` props | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | 增 3 键、删 `inputArea.abortBackground` | 无 |
| `core-rs/src/engine.rs` | `SessionState.sub_agent_description`；`create_sub_agent` 写入；`emit_runtime` 读任务清单；`runtime_state_json` 扩签名 | 快照字段新增（同上两成员） |
| `core-rs/fixtures/runtimeState.json` | `fields` 追加两项 | fixture 双向锁定 |
| `core-rs/src/main_tests.rs` | fixture 测试调用点补参 | — |
| `core-rs/src/engine_tests.rs` | 新增 3 用例（AC-7 / AC-8 / AC-9） | — |
| `src/test/sessionBusyLevel.test.ts` | `collectRunningSubAgents` 用例 | — |
| `e2e/webview/conversation.spec.ts` | 悬停浮层用例（AC-1~5、AC-10、AC-11） | — |
| `src/host/webviewMessages.ts` | 无代码改动（states 类型引用 shared，注释已写「与 core 一致」） | 无 |
| 宿主（`ConversationManager` / `WebViewUI` / `webviewMessageHandler.ts`） | 无改动（`readonly SessionRuntimeState[]` 透传） | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增代码只落 `src/shared/`（叶子层）、
      `src/webview/`（经 props 注入，不碰宿主 API）与 `core-rs/`（不经总线外通道）；
      webview import shared 有既有先例（`webviewTypes` / `modelRef`）；宿主零改动，
      无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：两个新契约成员全必选（空集用 `[]`、「无」用
      `null`，不引入 `?`）；事实唯一写入点仍是 core 注册表，`emit_runtime` 一次产出
      布尔与清单；子代理聚合只有 `collectRunningSubAgents` 一份纯函数；webview 的
      `?? []` 是 spec 明文豁免的缺字段口径并注释引用，非猜值；无新增默认值来源。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：core-rs 改动同步 Rust 测试
      （`main_tests` fixture 锁 + `engine_tests` 3 用例）与 TS 镜像类型；**落盘格式
      不变**（description 早已由 `create_sub_agent_metadata` 落 `meta.json`，本次只加
      内存字段），`src/shared/history/` 不涉及。本地验证先 `npm run build:core:host`
      再 `npm run test:all`（否则 `standalone*` 静默 skip），加 `npm run test:core`。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格=影响基线表所列 6 处；实施提交内
      同步并以 `npm run test:all -- docs-lint` 守绿（快照字段表不在 docsLint 逐项锁
      范围，由 fixture 测试锁定）；新增 `BackgroundTaskBrief` 成员表若写入 docs 需挂
      对应 lint 组——本期 docs 只写两成员语义、不新设成员清单表，不新增 lint 组。

## 被否决的替代方案

1. **父会话快照聚合子代理清单**（在父条目上放 `subAgents: [...]`）：同一子代理的身份
   会同时出现在它自己的条目与父条目两处，违反「同一事实只写一处」；states 数组本就含
   每个子代理会话的完整条目，按 `parentSessionId` 聚合是纯派生，放 webview 单份纯函数
   即可。够分量，**建议随实施进 `docs/adr/`**（评审时定）。
2. **悬停时拉取**（新增 UiRequest 向 core 索取明细）：为一次悬停新增请求 / 回包契约与
   定向回包链路，1s 延迟后还要等 IPC 往返；推送面已有全量数据，拉取只增加契约面与
   竞态，否决。
3. **native `title` 拼接清单文本**：原生 title 的显示延迟不受控（无法保证悬停 1s）、
   多行与分组样式不可控，AC-1 ~ AC-4 的时序与内容要求满足不了，否决。
4. **删除布尔、以清单为唯一事实**（`backgroundRunning` 改为清单派生）：既有消费面
   （流水灯 / 托盘 / `AbortButtonFacts`）都读布尔，删除是无行为收益的大面积重构；布尔
   与清单同源同发，不构成第二写入点，本期不动。

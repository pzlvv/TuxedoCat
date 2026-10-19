# 实施方案：once 一次性通知消息（不落盘、末位显示、后继即删）

技术路线：`message` 事件的载荷 `MessageData` 增加 `once` 标记（沿该类型既有的
「按角色取值子集」可选成员袋形态，`once: true` 即一次性通知、缺省即常规消息；
`AssistantEventBus.ts` 联合与冻结清单零改动）；core 侧四个通知 emit 点带标记，
`*User Interrupted*` 的落盘与内存追加整体取消；宿主 `onMessage → addMessage` 原样
透传；webview 在**追加新节点**的各入口先剥除已有 once 节点（`stripOnce` 单一纯函数），
就地更新的路径不动。指向同目录 `spec.md`。

**spec 对齐修订**（实施前定稿，随本 plan 落库）：FR-001 原文「契约成员不使用可选语义
（判别联合或必选成员）」修订为「标记沿 `MessageData` 既有可选成员袋形态表达
（`once?: boolean`，通知类显式 `true`、其余缺省）」——`MessageData` 是按 role 取值
子集的既有袋类型（`toolName` / `status` 等十余个可选成员同模式），可选成员冻结 lint
（铁律 4.2）管辖的是 `AssistantEventBus.ts` 联合本体，本次不在其上新增任何成员；
判别联合改造整张 `MessageData` 远超本 spec 范围。

## 技术方案

**core-rs（`core-rs/src/engine.rs`）**：

- `emit_user_interrupted`：保留 UI 事件（`data` 增加 `"once": true`），**删除**落盘段
  （`persist_unpersisted_messages` / `history::append_message` / `state.messages.push` /
  `last_uuid` / `persisted_count` / `announce_message_appended`）；静默中止的既有豁免
  不变。删除落盘后该函数不再失败，签名从 `Result<(), String>` 改为 `()`，4 个调用点
  去掉 `?`。
- LLM 失败回显（消费循环 `llm_error_message` 的 emit）：`data` 增加 `"once": true`
  （本就不落盘，只补标记）。
- 压缩排队提示（会话非空闲登记待压缩的 emit）：`data` 增加 `"once": true`。
- slash 命令输出（`commands.rs`）、回滚结果（`main.rs`）：不动（非目标）。
- `build_raw_api_messages` 只取 user / assistant，once 消息即使误入内存列表也不会进
  LLM 上下文（防御性现状，无需改动）。

**宿主**：

- `src/shared/types.ts`：`MessageData` 增加 `once?: boolean`（注释注明 specs/014 与
  「缺省即常规消息」语义）。
- `src/host/webviewMessages.ts`：`HostToWebviewMessage.addMessage` 增加 `once?: boolean`。
- `src/host/WebViewUI.ts` 的 `onMessage`：`{ type: 'addMessage', ...data }` 展开——
  `once` 随数据透传，无代码改动；`role === 'user'` 分支的 `onConversationListChanged`
  不受影响（once 恒非 user）。
- `src/host/bootstrapCore.ts` 的 `markConnectionSessionsFailed`：`emitToUi` 的 `data`
  增加 `once: true`。

**webview**：

- `src/webview/types.ts`：`Message` 增加 `once?: boolean`。
- `src/webview/hooks/handlers/shared.ts`：`toUiMessage` 透传 `once`；新增导出纯函数
  `stripOnce(messages)`——含 once 节点时返回剔除后的新数组，否则原引用返回
  （单一实现，铁律「派生逻辑只有一份纯函数」）。
- `toolHandlers.handleToolAddMessage` 三个**追加**分支（user 追加 / WebSearch 追加 /
  通用追加）先 `stripOnce` 再追加；toolcall 去重分支是就地更新，不剥除。
- `streamHandlers`：rAF 冲刷里「streamId+role 未命中 → 新建节点」分支先 `stripOnce`
  再 `concat`；命中分支是就地更新，不剥除。`queryEnd` 的 isStreaming 收尾、
  `streamEnd`、工具进度 / 参数 / 状态更新均为就地更新，不动。
- `conversationLoaded` / `messagesReplaced`：整体替换数组，落盘无 once 记录，
  天然不含 once（FR-004 无需代码）。
- `MessagesView`：once 消息 `role: 'system'`，走既有 `SystemMessage`（info 图标 +
  斜体文本）普通节点样式，无卡片无折叠——渲染零改动（AC-9）。

**测试**：

- core-rs `engine_tests.rs`：既有中断用例的「也落盘」断言改为「不落盘」（磁盘消息
  列表无 `*User Interrupted*`、`messageCount` 不含它）+ UI 事件带 `once: true`；
  LLM 失败用例与压缩排队用例补 `once: true` 断言；静默中止豁免的既有用例不回归。
- e2e（`e2e/webview/settings.spec.ts` 同目录的消息域 spec）：经 fakeHost 注入
  `addMessage { once: true }` → 断言系统样式节点出现在时间线末位；随后注入用户消息 →
  once 节点消失；注入工具卡片更新（就地）→ once 节点保留。
- 宿主侧失联提示的 once 标记由 core-lost 既有路径的类型改动覆盖（编译期强制），
  行为断言并入 e2e 注入用例（同一 `stripOnce` 通路）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/engine.rs` | 修改：三个 emit 点加 `once`；`emit_user_interrupted` 摘除落盘、签名改 `()` | `CoreEvent.message` 载荷新增标记（events.md 2.1 载荷列同步） |
| `core-rs/src/engine_tests.rs` | 修改：中断 / 失败 / 排队用例断言 | 无 |
| `src/shared/types.ts` | 修改：`MessageData.once?` | 契约载荷成员（events.md 载荷列描述同步） |
| `src/host/webviewMessages.ts` | 修改：addMessage `once?` | wire 消息字段新增 |
| `src/host/bootstrapCore.ts` | 修改：失联提示 `once: true` | 无 |
| `src/webview/types.ts`、`hooks/handlers/shared.ts`、`toolHandlers.ts`、`streamHandlers.ts` | 修改：透传 + `stripOnce` + 追加点接入 | webview 内部 |
| `docs/architecture/events.md`、`docs/features/user-stories.md`、`docs/features/compaction.md`、`docs/hosts/webview-ui.md` | 文档同步（同 spec 影响基线表） | docsLint 对照项同步 |

不涉及：`AssistantEventBus.ts` 联合与可选成员冻结清单、会话落盘格式（`<sid>.jsonl`
结构不变，只是不再写入中断系统消息；历史文件里的存量记录照常重放）、
`meta.json` 字段。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：
      `stripOnce` 在 webview handler 层；core 只在 emit 载荷加字段，不感知 UI 表现
      （「core 描述事实，UI 决定表现」——末位显示与后继即删全在 webview）；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      不过度 fallback（once 缺省 false 是载荷袋的既有解析模式，见 spec 对齐修订）；
      不在 `AssistantEventBus` 联合上新增可选成员（冻结清单零改动）；once 是视图态
      不是会话事实，`SessionState.messages` 不含它——「一份事实一个写入点」不破。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：
      core 行为改动（中断不再落盘）落 `core-rs/src/engine.rs` + `engine_tests.rs`
      同步；`src/shared/history/` 与 core-rs 共用的落盘格式不变（只是不再出现新记录，
      存量读取路径不变）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：events.md 2.1
      载荷列、US-2、compaction FR-002、[webview-ui 第 2 节](../../docs/hosts/webview-ui.md#2-内部流程约定)随实施同提交修订；
      `npm run test:all -- docs-lint` 必绿。

## 被否决的替代方案

- **新增独立 CoreEvent（如 `notice`）**：语义上与 `message` 的 system 形态重叠，
  webview 需要平行的一整套 handler / 渲染分支；spec 已列为非目标。否决。
- **once 节点由 MessagesView 渲染时过滤（状态里保留）**：`messagesReplaced` /
  加载重建会把 once 从状态里冲掉，与「末位显示」冲突；放 handler 层在数据入口控制
  生命周期更直接。否决。
- **「后继即删」做成定时器超时消失**：时间驱动与用户预期（「有新消息才清」）不符，
  且定时器是 UI 决定的表现逻辑，不该由 core 或数据层持有。否决。
- **`emit_user_interrupted` 保留 `Result` 签名**：摘除落盘后不存在失败路径，保留
  `Result` 会迫使调用点保留无意义的 `?` 与 `Ok(())` 样板。否决。

---
status: 已收敛
---

# 改动规格：abort 按钮黄色态悬停显示运行明细

abort（终止）按钮处于黄色态（spin 模式，或只剩后台 Bash 任务与非 idle 子代理）时，
鼠标悬停满 1 秒显示一个只读浮层，列出该会话正在运行的后台 Bash 任务与子代理，让用户
在决定是否整体中止前能看到「收尾中还剩什么」。为此 `sessionRuntimeChanged` 快照从
「只有布尔根事实」扩展为同时携带任务级明细（后台任务的 id / 描述 / 命令，子代理的
创建时描述）；悬停时机、浮层内容与关闭时机由 webview 表现。按钮三态判定、中止范围
与点击语义一律不变。

定档：L3——新增 FR 与 `SessionRuntimeState` 契约成员（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）。

交叉引用：按钮三态与中止范围见
[docs/features/abort-button.md](../../docs/features/abort-button.md)；运行时快照的
owner 与分发见 [docs/core/session-runtime.md](../../docs/core/session-runtime.md)；
「core 描述事实，UI 决定表现」见
[principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)；
「派生字段从根字段推导」见
[principles.md 第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | [第 2 节 功能需求](../../docs/features/abort-button.md#2-功能需求)、[3.1 数据流](../../docs/features/abort-button.md#31-数据流) | 修改 | 收敛时并入本 spec 的 FR（悬停明细、快照扩展语义），按钮三态与中止范围正文不变 |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | [第 2 节 对外快照](../../docs/core/session-runtime.md#2-对外快照) | 修改 | 字段表补 `backgroundTasks` / `subAgentDescription` 及语义 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager) | 不涉及 | 核对后无需改动：该节只指向快照规格、不列成员表，成员语义单点在 session-runtime.md（同一事实只写一处），docsLint 全绿 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 不涉及 | 核对后无需改动：`sessionRuntimeChanged` 载荷列仍是 `states`，元素结构属 session-runtime.md；events.md 行数棘轮（只降不升）亦不允许加注 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [第 8 节](../../docs/hosts/webview-ui.md#8-abort-按钮读-core-的-sessionruntime不由这里判定) | 修改 | 链路表 webview 行补悬停浮层 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md)（索引） | [EP-13 会话交互增强（分册 dialog-core.md）](../../docs/features/user-stories/dialog-core.md#ep-13-会话交互增强) | 修改 | 新增 US-52；附录 e2e 映射表补登记 |

## 用户场景与验收标准

- 场景 1：黄色态悬停显示明细
  - **AC-1**（FR-002）：GIVEN 黄色态且该会话有运行中的后台 Bash 任务 WHEN 悬停按钮满 1 秒 THEN 浮层显示「后台任务」组，逐项列出任务的描述（描述与命令不同时附命令）
  - **AC-2**（FR-002）：GIVEN 黄色态且有运行中的子代理（含子代理自身的下层运行中子代理） WHEN 悬停满 1 秒 THEN 浮层显示「子代理」组，逐项列出全部运行中子代理的描述
  - **AC-3**（FR-002）：GIVEN 悬停未满 1 秒即移出 WHEN 计时到期 THEN 浮层不出现
  - **AC-4**（FR-002）：GIVEN 浮层已显示 WHEN 指针移出按钮 THEN 浮层立即隐藏
- 场景 2：非黄色态与空态
  - **AC-5**（FR-002）：GIVEN 红色态（前台查询运行中）或灰色态（空闲） WHEN 悬停超过 1 秒 THEN 不显示浮层
  - **AC-6**（FR-002）：GIVEN 恢复态 spin（按钮黄色但两组明细皆空） WHEN 悬停满 1 秒 THEN 不显示浮层
- 场景 3：明细事实进快照
  - **AC-7**（FR-001）：GIVEN 会话有运行中的后台 Bash 任务 WHEN core 推快照 THEN 该会话条目的 `backgroundTasks` 逐项含 `taskId` / `description` / `command` 且按注册序；任务结束或被中止后清单收敛为空
  - **AC-8**（FR-001）：GIVEN 子代理会话已创建 WHEN core 推快照 THEN 该条目 `subAgentDescription` 为创建时 Agent 工具调用的 description；普通会话条目为 `null`
  - **AC-9**（FR-001）：GIVEN 任一明细变化（任务注册 / 结束，子代理创建 / 忙闲跃迁） WHEN core 评估快照 THEN 变化被视作状态变化并推送，不因布尔位不变而吞掉
- 场景 4：只读与刷新
  - **AC-10**（FR-003）：GIVEN 浮层显示中 WHEN 点击浮层内条目 THEN 不产生任何上行消息，该任务 / 子代理继续运行
  - **AC-11**（FR-003）：GIVEN 浮层显示中 WHEN 快照更新到达 THEN 浮层内容跟随刷新；两组皆空时浮层关闭

## 功能需求

### FR-001：快照携带运行明细

`SessionRuntimeState`（`src/shared/AssistantEventBus.ts`，webview 镜像
`src/webview/types.ts`）新增两个**必填**成员：

- `backgroundTasks: readonly BackgroundTaskBrief[]`——该会话名下运行中的后台 Bash
  任务，按注册序；每项含 `taskId` / `description` / `command`。无任务为空数组（空集
  用空数组表达，不引入 `?` 可选语义）。
- `subAgentDescription: string | null`——子代理会话为创建时 Agent 工具调用的
  description（工具侧保证非空，见 `tools.rs` 的 `SubAgentRequest.description` 兜底
  `Agent: <role>`）；普通会话为 `null`；恢复路径取不到时为 `null`，由 UI 显示回退文案，
  不猜值。

约束：

- 既有布尔根事实（`backgroundRunning` / `subAgentRunning` 等）的地位与语义不变，既有
  消费者（流水灯、托盘、`resolveAbortButtonState`）不动。清单与布尔同源：都出自 core
  的同一批注册表（`bash_task.rs` 的 `TASKS`、子代理会话表），在同一次 `emit_runtime`
  里产出，不产生第二个写入点。
- 推送语义不变：全量、按会话插入序、快照无变化不重发；清单与 `subAgentDescription`
  参与快照 diff，其变化必须触发推送。
- webview 侧「运行中子代理清单」是快照的纯派生：直接子代理（`parentSessionId` 指向
  该会话）中 `idle` 为假的条目，递归展开其下层非空闲子代理，深先序、同层按创建序；
  派生逻辑只有一份纯函数（`src/shared/sessionRuntime.ts`），webview 与测试共用
  （[principles.md 第 8 节](../../docs/architecture/principles.md#8-契约只写现状派生字段从根字段推导)）。

### FR-002：黄色态悬停 1 秒显示运行明细浮层

- 触发面只限黄色态（`abortButtonState === 'background'`，含 spin）。指针进入按钮并
  持续悬停满 1 秒显示浮层；计时以进入为起点，悬停期间移动不重置；未满 1 秒移出则取消，
  再次进入重新计时；浮层显示中移出立即隐藏。
- 浮层内容两组：
  - 「后台任务」组：`backgroundTasks` 逐项显示 `description`；`command` 与
    `description` 不同时一并显示（不重复展示相同文本）。
  - 「子代理」组：按 FR-001 的派生口径逐项显示 `subAgentDescription`；为 `null` 的
    条目显示 i18n 回退文案。
- 空态：两组皆空（如恢复态 spin）不显示浮层——没有事实就不弹窗，与「点击为空操作」
  的既有语义一致。
- 原生 `title`：黄色态不再设置（浮层取代，避免双层提示）；红色 / 灰色态维持现状文案
  （「终止」）。浮层文案（组标题、回退文案）走 i18n（`src/webview/i18n/` 的 zh / en）。

### FR-003：明细只读，随快照刷新

- 浮层是快照明细的只读投影：不提供逐项中止 / 跳转等操作，点击条目无任何上行消息；
  abort 按钮的点击语义与中止范围不变（仍按
  [abort-button.md FR-002](../../docs/features/abort-button.md#fr-002中止范围) 整体判定）。
- 浮层显示期间快照更新时内容跟随刷新；两组皆空（任务 / 子代理在悬停期间全部结束）时
  浮层关闭。会话切换时浮层隐藏。

## 边界与错误路径

- **快照缺新字段**（旧宿主 / 未更新的 e2e 假宿主）：`backgroundTasks` 按空清单、
  `subAgentDescription` 按 `null` 判定，与
  [abort-button.md 第 4 节](../../docs/features/abort-button.md#4-边界与错误路径)
  「缺字段按缺省根事实」同口径；e2e 假宿主 fixture 随本 spec 同步补齐。
- **悬停期间状态跃迁**：1 秒内按钮由黄转红（新前台查询开始）→ 浮层不出现；已显示时
  转红 / 转灰 → 立即隐藏（浮层只属于黄色态）。
- **同会话多任务同名**：清单逐项平铺，不合并、不去重——注册表事实是什么就显示什么。
- **多视图宿主**（Electron 悬浮窗）：快照本就广播给所有聊天视图，浮层读当前视图会话的
  条目，不需要新推送链路。

## 非目标

- 浮层内逐项中止单个任务 / 子代理——abort 保持整体范围语义（将来需要时另立 spec）。
- 红色态的悬停明细——前台查询没有任务清单可列，查询进度是另一条流。
- 任务的 pid、已运行时长、输出预览进契约或浮层。
- Electron 侧栏 / 托盘的任务级明细展示。
- 点击浮层条目跳转子会话——查看子会话详情走既有对话树 / 侧栏。

## 对需求基线的影响

新增 [US-52](../../docs/features/user-stories/dialog-core.md#us-52-abort-黄灯悬停预览后台任务与子代理)
（EP-13 会话交互增强，分册 dialog-core.md；编号顺延——US-51 已被并行落库的 specs/020
Explorer 子代理占用）：作为用户，我希望黄灯时悬停 abort 按钮能预览正在运行的后台任务与子代理，以便
判断是否整体中止。验收标准：

1. 黄色态悬停满 1 秒显示浮层，列出运行中后台任务与子代理；红色 / 灰色态与恢复态 spin
   悬停无浮层。
2. 移出按钮浮层立即消失；显示期间任务全部结束则浮层随之关闭。
3. 浮层只读，点击条目无副作用；abort 按钮点击的中止范围不变。

e2e 登记：`e2e/webview/conversation.spec.ts` 新增悬停用例（假宿主注入带明细的快照），
`user-stories.md` 附录映射表补该用例与 US-52 的对应。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `SessionRuntimeState.backgroundTasks` / `subAgentDescription`（`src/shared/AssistantEventBus.ts`、`src/webview/types.ts` 镜像）；`core-rs/src/engine.rs` 的 `emit_runtime` / `runtime_state_json`；`bash_task.rs` 清单读取 | `core-rs/src/main_tests.rs` 的 `runtime_state_fields_match_parity_fixture`（fixture `core-rs/fixtures/runtimeState.json` 同步扩字段）+ `engine_tests.rs`（清单内容与收敛、子代理 description、明细变化触发推送） | 自动 |
| FR-002 | `src/shared/sessionRuntime.ts` 聚合纯函数；`src/webview/InputArea.tsx` 悬停计时与浮层 | `src/test/sessionBusyLevel.test.ts`（聚合纯函数与 `sessionBusyLevel` 同模块）+ `e2e/webview/conversation.spec.ts`（AC-1 ~ AC-6） | 自动 |
| FR-003 | `src/webview/InputArea.tsx` 浮层只读与关闭时机 | `e2e/webview/conversation.spec.ts`（AC-10 / AC-11） | 自动 |

## 待澄清

（无——契约形态、空态口径与触发面在评审前已定；评审提出的新问题回填本节。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
  - FR-001 / AC-7 / AC-8 / AC-9 → `core-rs/src/engine_tests.rs` 的
    `runtime_snapshot_lists_background_tasks_in_registration_order`（注册序 + 中止收敛）、
    `runtime_snapshot_carries_sub_agent_description`（子代理 description / 普通会话 null）、
    `runtime_snapshot_republishes_when_task_mix_changes`（布尔位不变清单变仍推送）；
    字段集合由 `runtime_state_fields_match_parity_fixture` + `runtimeState.json` 锁定
    （`npm run test:core` 917 全过）。
  - FR-002 / AC-1 ~ AC-6 → `e2e/webview/conversation.spec.ts` 的 US-52 悬停用例
    （黄态任务 / 子代理清单、command==description 不重复、idle 子代理跳过、未满 1s
    不出现、移出即隐、红 / 灰态与空明细无浮层）；嵌套子代理的深先序口径由
    `src/test/sessionBusyLevel.test.ts` 的 `collectRunningSubAgents` 用例锁定。
  - FR-003 / AC-10 / AC-11 → 同一 e2e 用例（点击浮层零 abort 上行、清单 2→1 刷新、
    两组皆空关闭、切会话隐藏由 `sessionId` effect 覆盖）。
- 偏差（已留痕，不影响行为验收）：
  - US 编号 51 → 52：并行落库的 specs/020（Explorer 子代理）占用了 US-51，需求登记
    顺延（spec / plan / tasks / dialog-core.md / 索引 / 附录已同步为 US-52）。
  - `collectRunningSubAgents` 的宿主类型采用零依赖结构化签名（不 import
    `AssistantEventBus`）：webview 构建图不含 node 类型链，导入契约文件会把
    `fileLock` / `configDir` 拉进 webview tsc 程序（`src/host/abortButtonState.ts`
    同款先例）；函数位置（`src/shared/sessionRuntime.ts`）与「唯一纯函数」不变。
  - 契约镜像多落一处：`src/host/webviewMessages.ts` 的 wire 内联 state 类型同步加
    两成员（plan 模块表原写「无改动」）。
  - 影响基线的 contracts.md §4 / events.md §2 两行经核对改判「不涉及」（见影响基线
    表留痕）：成员语义单点在 session-runtime.md，events.md 行数棘轮不允许加注。
  - e2e 假宿主 `fakeHost.send` 记录直推的 `sessionRuntimeStates` 到
    `state.runtimeStates`（对齐生产拉取回最近推送的语义），否则 App 主动拉取会清掉
    直推状态——plan 原写「无需改 helper」。
- 未做：（无——tasks.md 八项全勾。）
- 反向对照：实现 diff 逐分支对回 spec——缺字段口径（`?? []` / `?? null`）↔ 边界与
  错误路径；离黄 / 切会话隐藏 ↔ FR-003 与边界「悬停期间状态跃迁」；title 黄态移除 ↔
  FR-002；锁序 `sessions → TASKS` 为实现细节（plan 有载，spec 无对应行为，不需 AC）。
  已知残留：`create_sub_agent` 内 `sub_agent_description` 的写入行为无独立断言
  （AC-8 用例直接置位 `SessionState` 驱动快照侧；写入行为与相邻的 `sub_agent_role`
  同为单行赋值，由评审覆盖）——登记为可接受残留而非偏差。

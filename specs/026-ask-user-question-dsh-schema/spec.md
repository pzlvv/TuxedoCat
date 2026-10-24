---
status: 已收敛
---

# 改动规格：AskUserQuestion 入参对齐 dsh 的 questions 形状

把内置工具 `AskUserQuestion` 的入参从 `{ question, choices? }` 改为 dsh 的
`{ questions: [{ id, question, header?, options?, multi_select? }] }`，并把用户回复从
`{ index, reply? }` 改为 `{ answers: [{ id, selected[], custom? }] }`。目标是消除与业界
同类工具的命名冲突（业界统一使用 `questions` / `options` / `header` / 多选字段），同时让
一次调用可以携带多个问题、每个问题支持单选或多选。工具名保持 `AskUserQuestion`，不引入
dsh 的定时等待（`timeout`）与 pending 语义。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../../docs/architecture/events.md) | [第 2.2 节 CoreRequest](../../../docs/architecture/events.md#22-corerequestcore--ui请求-响应) | 修改 | `userChoice` 的结果类型从 `{ index, reply? }` 改为按场景区分的判别联合 |
| [docs/architecture/events.md](../../../docs/architecture/events.md) | [第 2.3 节 UiEvent](../../../docs/architecture/events.md#23-uieventui--core单向) | 修改 | `userChoicePendingChanged` 语义不变，补一句 AskUserQuestion 的等待仍走该事件 |
| [docs/architecture/host-ui-modules.md](../../../docs/architecture/host-ui-modules.md) | [第 1 节 UserChoiceManager](../../../docs/architecture/host-ui-modules.md#1-userchoicemanager) | 修改 | `UserChoiceOptions` / `UserChoiceResult` 的形状与场景区分 |
| [docs/hosts/webview-ui.md](../../../docs/hosts/webview-ui.md) | [第 9 节 生命周期：dropSession](../../../docs/hosts/webview-ui.md#9-生命周期dropsession) | 修改 | `AskUserQuestion` 挂起与回复的载荷形状 |
| [docs/core/standalone-core.md](../../../docs/core/standalone-core.md) | [第 4 节 契约](../../../docs/core/standalone-core.md#4-契约) | 修改 | `userChoice` 载荷字段与回复协议 |
| [docs/features/user-stories/messages.md](../../../docs/features/user-stories/messages.md) | [EP-4 权限与用户确认](../../../docs/features/user-stories/messages.md#ep-4-权限与用户确认) | 修改 | US-18 的验收标准补充 AskUserQuestion 的多问题 / 多选场景 |
| `docs/features/ask-user-question.md` | — | 新增 | AskUserQuestion 的完整行为规格（入参、回复、UI 交互、错误路径） |
| `docs/adr/0010-ask-user-question-dsh-schema.md` | — | 新增 | 记录「对齐 dsh 形状」的决策、背景与被否决的替代方案 |
| [docs/README.md](../../../docs/README.md) | 地图 | 修改 | 登记新增的特性规格与 ADR |

## 用户场景与验收标准

- 场景 1：模型一次问多个问题
  - **AC-1**（FR-001）：GIVEN 模型调用 `AskUserQuestion` 且 `questions` 含两个问题 WHEN 用户逐页作答并提交 THEN 宿主收到一条 `respondUserChoice`，`answers` 含两条按 `id` 对应的记录。
  - **AC-2**（FR-001）：GIVEN 某个问题没有 `options` WHEN 当前页呈现该问题 THEN 只显示自由文本输入，不显示选项按钮。
- 场景 2：多选问题
  - **AC-3**（FR-003）：GIVEN 某问题 `multi_select: true` WHEN 用户勾选两个选项并提交 THEN 该问题的 `selected` 含两个 label。
  - **AC-4**（FR-003）：GIVEN 某问题 `multi_select` 缺省或为 false WHEN 用户点击第二个选项 THEN 该问题的 `selected` 只含第二个 label（单选互斥）。
- 场景 2b：多问题逐页导航
  - **AC-13**（FR-003）：GIVEN `questions` 含三个问题 WHEN 选择框打开 THEN 只呈现第一页并显示进度 `1/3`，不显示其余两页。
  - **AC-14**（FR-003）：GIVEN 用户已作答第一页并切到第二页 WHEN 点击「上一页」THEN 回到第一页且已选内容保留。
  - **AC-15**（FR-003）：GIVEN 用户在最后一页 WHEN 点击「提交」THEN 一次性回传全部问题的回复。
- 场景 3：自由文本与跳过
  - **AC-5**（FR-004）：GIVEN 某问题有选项 WHEN 用户输入自由文本并提交 THEN 该问题的 `custom` 为该文本，`selected` 为空数组。
  - **AC-6**（FR-004）：GIVEN 某问题用户未作答 WHEN 用户提交 THEN 该问题的 `selected` 为空数组且无 `custom`。
- 场景 3b：回复回传与工具结果
  - **AC-11**（FR-002）：GIVEN 用户对两个问题分别作答 WHEN 宿主回传结果 THEN `answers` 含两条记录，每条带对应问题的 `id`，顺序不要求与问题顺序一致。
  - **AC-12**（FR-005）：GIVEN 用户回复了问题 WHEN 工具返回 THEN 工具结果是 `{"answers":[...]}` 的 JSON 文本，其中 `id` 与请求一致。
- 场景 4：非法入参
  - **AC-7**（FR-006）：GIVEN `questions` 为空数组 WHEN 执行该工具 THEN 产出 `InputValidationError`，不弹选择框、不标记会话 waiting。
  - **AC-8**（FR-006）：GIVEN 两个问题的 `id` 相同 WHEN 执行该工具 THEN 产出 `InputValidationError`，文案指出 id 必须唯一。
  - **AC-9**（FR-006）：GIVEN `options` 元素带未知字段 WHEN 执行该工具 THEN 产出 `InputValidationError`（`unrecognized_keys`）。
- 场景 5：历史对话
  - **AC-10**（FR-007）：GIVEN 历史对话里存在旧形状 `{ question, choices }` 的 tool_use WHEN 打开该对话 THEN 工具卡片仍能只读展示问题与选项，不抛错。

## 功能需求

### FR-001：入参形状对齐 dsh

`AskUserQuestion` 的入参顶层字段为 `questions`（必填数组，1–9 项）。每项为对象：

- `id`（string，必填）：单次调用内唯一的问题标识，回复按它回传。
- `question`（string，必填）：问题正文，非空。
- `header`（string，可选）：短标题，供选择框显示。
- `options`（array，可选）：候选选项；出现且非空时 1–9 项，每项
  `{ label: string（必填、非空）, description?: string }`。空数组等价于省略。
- `multi_select`（boolean，可选，缺省 false）：是否允许多选。

不再接受旧的 `question` / `choices` 字段。schema 必须把 `questions` 的元素形状、
`options` 的元素形状、数量上下限与必填字段完整写出，不得只声明为 `type: array`。
问题数量与选项数量的上限沿用本项目既有的 9 项保护（dsh 本身不设上限）。

### FR-002：回复协议对齐 dsh

`CoreRequest.userChoice` 的 AskUserQuestion 场景结果改为
`{ answers: [{ id, selected: string[], custom?: string }] }`：

- `id` 回显请求里的问题 `id`；回复顺序不要求与问题顺序一致。
- `selected` 是选项 `label` 的数组；单选最多一个，多选可多个。
- `custom` 是用户输入的自由文本；未输入时省略。
- 跳过某题 = `selected: []` 且无 `custom`。

权限确认与 AskUserQuestion 共用 `userChoice` 通道，两者的请求与结果必须用可区分的
形状表达，不得用可选字段混装。

### FR-003：多问题逐页呈现

选择框一次只呈现一个问题，不把全部问题挤在同一屏。每页显示 `header`（有则显示）、
`question` 与选项；`multi_select: true` 的选项为可多选控件，其余为单选。

多问题时提供「上一页」「下一页」导航与进度指示（如 `1/3`），最后一页显示「提交」。
切页时保留各页已选内容与自由文本；未作答直接点「下一页」按跳过处理。提交时一次性
回传全部回复。单问题时只呈现该页与「提交」，不显示上一页 / 下一页。

### FR-004：自由文本与跳过

每个问题都允许输入自由文本作为 `custom`。用户未作答的问题按「跳过」处理
（`selected: []`、无 `custom`）。自由文本与选项可以同时存在：有选项时，`selected` 与
`custom` 各自独立回传。

### FR-005：工具结果文案

工具结果返回 `{"answers":[...]}` 的 JSON 文本，形状与 dsh 的 `render` 一致。模型据此
按 `id` 对应问题。

### FR-006：运行期校验

- `questions` 必填、1–9 项；空数组或超上限报 `InputValidationError`。
- 每个问题 `id` 必填、非空、单次调用内唯一。
- 每个问题 `question` 必填、非空。
- `options` 出现且非空时 1–9 项；每项 `label` 必填、非空；`description` 出现时必须是字符串。
- 同一问题内的 option `label` 必须唯一（回复按 label 回传，重复会歧义）。
- 未知字段（顶层与元素级）报 `unrecognized_keys`。
- 校验失败只产出 `InputValidationError` 工具结果，不弹选择框、不标记会话 waiting
  （沿用现有口径）。

### FR-007：历史兼容

历史对话里旧形状 `{ question, choices }` 的 tool_use 仍能在工具卡片里只读展示；不迁移
落盘格式。旧字段不再被新调用接受。

## 边界与错误路径

| 输入 / 场景 | 预期行为 |
| --- | --- |
| `questions: []` | `InputValidationError`（至少 1 个问题） |
| `questions` 超过 9 项 | `InputValidationError`（最多 9 个问题） |
| `id` 重复 | `InputValidationError`，文案指出 id 必须唯一 |
| `id` 为空串 | `InputValidationError` |
| `question` 为空白 | `InputValidationError`（沿用现有 `Question cannot be empty` 口径） |
| `options: []` | 视为无选项（纯文本问题），不报错 |
| `options` 超过 9 项 | `InputValidationError` |
| `options` 元素缺 `label` | `InputValidationError` |
| 同一问题 option `label` 重复 | `InputValidationError` |
| 未知字段 | `InputValidationError`（`unrecognized_keys`） |
| 用户关闭会话 / 视图销毁 | 挂起的请求被拒绝，工具产出错误；不残留 waiting（沿用现有口径） |
| 用户未作答直接点「下一页」 | 该页对应的问题按跳过处理，继续呈现下一页 |
| 视图重建 / pending 重新投递 | 从第一页开始呈现，未提交的草稿不保留 |
| 只有一个问题 | 只呈现该页与「提交」，不显示上一页 / 下一页 |
| 用户提交时全部问题都跳过 | 合法回复：每条 `selected: []`，工具正常返回 |

## 非目标

- 不引入 dsh 的 `timeout` 定时等待与 pending 语义（「稍后回复」需要用户消息回填通道，
  不在本次范围）。去向：[docs/architecture/open-questions.md](../../../docs/architecture/open-questions.md)。
- 不把工具名改成 `ask_user_question`；保持 `AskUserQuestion`（与本项目工具命名约定一致）。
- 不引入 Claude schema 里的 `answers` 入参字段（内部回填用）。
- 不引入 pi 扩展的 `allowOther` / `required` / `placeholder` / `default` / `type` 字段。
- 不改变权限确认的既有交互语义（只调整共用通道的载荷形状）。

## 对需求基线的影响

新增 US-58「一次提问多个问题并支持多选」，覆盖多问题、单选/多选、自由文本与跳过；
e2e 用例在实施时登记到 `docs/features/user-stories.md` 的 US ↔ e2e 映射，或按既有口径
登记豁免。US-18 的验收标准补充 AskUserQuestion 的多问题场景，权限确认的既有行为不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 AskUserQuestion 定义、`core-rs/src/tool_input.rs` | `core-rs/src/tools_tests.rs`、`core-rs/fixtures/toolInputValidation.json` | 自动 |
| FR-002 | `src/shared/UserChoiceQueue.ts`、`src/shared/AssistantEventBus.ts` | `src/test/userChoiceDelivery.test.ts`、`src/test/userChoice.test.ts` | 自动 |
| FR-003 | `src/webview/QuestionOverlay.tsx` | 无自动覆盖 + 渲染层 | 无自动覆盖 + 现有 webview 无渲染单测车道 |
| FR-004 | `src/webview/QuestionOverlay.tsx` | 无自动覆盖 + 渲染层 | 无自动覆盖 + 同上 |
| FR-005 | `core-rs/src/tools.rs` 的 `run_ask_user_question` | `core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | `core-rs/src/tool_input.rs` | `core-rs/src/tools_tests.rs`、`core-rs/src/engine_tests.rs` | 自动 |
| FR-007 | `src/webview/tools/AskUserQuestion.tsx` | 无自动覆盖 + 渲染层 | 无自动覆盖 + 渲染层 |

## 待澄清

（无）

## 收敛记录

- 已满足：FR-001 / FR-006 → `core-rs/src/tools.rs` 的 `definitions()` 与
  `core-rs/src/tool_input.rs` 的 `check_questions` / `check_options`；
  `core-rs/fixtures/toolInputValidation.json` 的 23 条新用例通过。
- 已满足：FR-002 → `src/shared/UserChoiceQueue.ts` 的判别联合、
  `src/host/ui/webviewMessageHandler.ts` 的 `handleRespondUserChoice`；
  `src/test/userChoice*.test.ts` 通过。
- 已满足：FR-003 / FR-004 → `src/webview/QuestionOverlay.tsx` 的逐页 UI 与
  `src/webview/UserChoiceOverlay.tsx` 的分发；渲染层按 US-58 豁免段人工验证。
- 已满足：FR-005 → `core-rs/src/tools.rs` 的 `run_ask_user_question` 返回
  `{"answers":[...]}`；`core-rs/src/tools_tests.rs` 通过。
- 已满足：FR-007 → `src/webview/tools/AskUserQuestion.tsx` 兼容旧 `question` / `choices`。
- 偏差：无。
- 未做：无。
- 验证：`npm run check-types`、`npm run lint`、`npm run build:core:host`、
  `npm run test:all`（73 通过 / 0 失败 / 1 跳过，`sidebarFiles` 环境前置不满足）、
  `npm run test:all -- docs-lint` 全绿；`cargo test` 940 通过 / 5 失败，失败全部是
  `mcp::tests::*`（本地 MCP fake server 启动失败，与本次改动无关）。

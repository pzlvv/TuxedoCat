---
owner: pzlvv
last_reviewed: 2026-10-25
---

# 规格：AskUserQuestion 逐题提问

`AskUserQuestion` 是 Core 进程内的内置工具：模型一次可提出 1–9 个问题，每个问题可带
1–9 个选项、可要求多选，用户逐页作答后答案按问题 `id` 回传。入参形状对齐 dsh 的
`ask_user_question`（`questions` / `options` / `multi_select` / `answers`），工具名保持
`AskUserQuestion`。实现位于 `core-rs/src/tools.rs`（执行与结果）与
`core-rs/src/tool_input.rs`（入参校验），选择框位于 `src/webview/QuestionOverlay.tsx`。
需求基线见 [US-58](user-stories/messages.md#us-58-一次提问多个问题并支持多选)。

## 用户场景与验收标准

- 场景 1：模型一次提出多个问题
  - **AC-1**（FR-001）：GIVEN 模型调用 `AskUserQuestion` 且 `questions` 含两个问题 WHEN 入参校验通过 THEN 工具进入提问流程，选择框逐页呈现。
  - **AC-2**（FR-003）：GIVEN `questions` 含三个问题 WHEN 选择框打开 THEN 只呈现第一页并显示进度 `1/3`，不显示其余两页。
- 场景 2：单选与多选
  - **AC-3**（FR-003）：GIVEN 某问题 `multi_select` 为 true WHEN 用户勾选两个选项并提交 THEN 该问题的 `selected` 含两个 label。
  - **AC-4**（FR-003）：GIVEN 某问题 `multi_select` 缺省 WHEN 用户点击第二个选项 THEN 该问题的 `selected` 只含第二个 label，且非最后一页时自动进入下一页。
- 场景 3：其他项与自由回复
  - **AC-5**（FR-004）：GIVEN 某单选问题有选项 WHEN 用户输入自由文本并提交 THEN 该问题的 `custom` 为该文本、`selected` 为空数组。
  - **AC-6**（FR-004）：GIVEN 用户在输入框按 Enter WHEN 当前不是最后一页 THEN 进入下一页；WHEN 当前是最后一页 THEN 提交。
  - **AC-11**（FR-004）：GIVEN 多选问题且「其他」已勾选 WHEN 清空文本或点击输入框 THEN 勾选保持不变；WHEN 再点「其他」卡片 THEN 取消勾选、清空文本并解锁普通选项。
  - **AC-12**（FR-004）：GIVEN 多选问题 WHEN 勾选普通选项并输入自由文本后提交 THEN `selected` 含勾选的 label、`custom` 为输入的文本。
  - **AC-13**（FR-004）：GIVEN 多选问题已勾选 A、B 且「其他」已勾选 WHEN 点击任意普通选项 THEN 无响应（置灰锁定），A、B 保持勾选。
- 场景 4：答案与工具结果
  - **AC-7**（FR-002）：GIVEN 用户对两个问题分别作答 WHEN 宿主回传结果 THEN `answers` 含两条按 `id` 对应的记录。
  - **AC-8**（FR-005）：GIVEN 用户回答了问题 WHEN 工具返回 THEN 工具结果是 `{"answers":[...]}` JSON 文本。
- 场景 5：非法入参
  - **AC-9**（FR-006）：GIVEN `questions` 为空数组 WHEN 执行该工具 THEN 产出 `InputValidationError`，不弹选择框、不标记会话 waiting。
  - **AC-10**（FR-006）：GIVEN 两个问题的 `id` 相同 WHEN 执行该工具 THEN 产出 `InputValidationError`。

## 功能需求

### FR-001：入参形状

`AskUserQuestion` 的入参顶层字段为 `questions`（必填数组，1–9 项）。每项为对象：

- `id`（string，必填）：单次调用内唯一，答案按它回传。
- `question`（string，必填）：问题正文，非空。
- `header`（string，可选）：短标题。
- `options`（array，可选）：候选选项；出现且非空时 1–9 项，每项
  `{ label: string（必填、非空）, description?: string }`。空数组等价于省略。
- `multi_select`（boolean，可选，缺省 false）：是否允许多选。

schema 完整写出 `questions` 与 `options` 的元素形状、`minItems` / `maxItems` 与必填
字段，不再接受旧的 `question` / `choices`。

### FR-002：答案回传

用户回复为 `{ answers: [{ id, selected: string[], custom?: string }] }`：

- `id` 回显请求里的问题 `id`；答案顺序不要求与问题顺序一致。
- `selected` 是选项 `label` 的数组；单选最多一个，多选可多个。
- `custom` 是用户输入的自由文本；未输入时省略。
- 跳过某题 = `selected: []` 且无 `custom`。

权限确认与 AskUserQuestion 共用 `CoreRequest.userChoice` 通道，用 `kind` 判别
（`permission` / `question`），不得用可选字段混装。

### FR-003：逐页选择框

选择框一次只呈现一个问题，底部固定进度条与导航。每题显示 `header`（有则显示）、
`question` 与选项；`multi_select: true` 用多选控件，其余为单选。多问题时提供
「上一页」「下一页」与进度（如 `1/3`），最后一页显示「提交」；单问题只显示该页与
「提交」，不显示导航。

### FR-004：其他项与输入框

有选项的问题在选项末尾附「其他」卡片：勾选指示器（单选 radio / 多选 checkbox）与内嵌
输入框并排，输入框占位符以「其它」开头。输入框始终显示；焦点落入输入框、点击卡片、
输入非空文本都勾选「其他」，勾选后焦点自动落到输入框。多选勾选「其他」后整题置灰锁定：
checkbox 置灰，普通选项全部置灰——已勾选保持勾选、未勾选保持未勾选、不可再切换，清空
文本不取消；再点一次「其他」卡片即取消勾选，清空文本并解锁普通选项。单选点击普通选项
或清空文本即取消「其他」。多选下「其他」与普通选项并存，答案同时含 `selected` 与
`custom`，`custom` 只回传输入的文本、不引入「其他」label。输入框 Enter 触发下一页
（最后一页触发提交），Shift+Enter 换行，中文输入法合成中的回车不触发。

### FR-005：工具结果

工具结果返回 `{"answers":[...]}` 的 JSON 文本，形状与 dsh 的 `render` 一致。

### FR-006：运行期校验

- `questions` 必填、1–9 项；空数组或超上限报 `InputValidationError`。
- 每个问题 `id` 必填、非空、单次调用内唯一。
- 每个问题 `question` 必填、非空。
- `options` 出现且非空时 1–9 项；每项 `label` 必填、非空；`description` 出现时必须是字符串。
- 同一问题内的 option `label` 必须唯一。
- 未知字段（顶层与元素级）报 `unrecognized_keys`。
- 校验失败只产出 `InputValidationError` 工具结果，不弹选择框、不标记会话 waiting。

## 行为规格

### 逐页状态

- 进度条每页一段：已答为蓝色、已离开且未答（跳过）为黄色、当前页未作答为灰色。
- 进度条可点击跳页；离开当前页时若未作答，该页记为跳过。
- 切页保留各页已选内容与自由文本；视图重建 / pending 重新投递时从第一页开始，未提交
  的草稿不保留。

### 选项与自动翻页

- 单选点击普通选项后写入 `selected`，非最后一页时自动进入下一页；最后一页不自动提交。
- 多选点击选项切换该 label，与「其他」互不影响；「其他」与普通选项可并存。
- 点击「其他」卡片：未勾选时勾选并聚焦输入框（单选同时清空普通选项）；多选已勾选时取消勾选——清空文本并解锁普通选项。点击任一选项后焦点移到输入框。
- 用户主动聚焦输入框即勾选「其他」（单选清空普通选项，多选保留已选普通项）；程序聚焦（点选项后送入焦点）不改变选择。
- 多选勾选「其他」后整题置灰锁定：普通选项不可再切换、已勾选项保持勾选；锁定期间清空文本不取消勾选，点击输入框编辑文字也不取消。
- 单选清空文本或点击普通选项即取消「其他」。

### 提交

- 最后一页的「提交」或输入框 Enter 触发提交，一次性回传全部问题的答案。
- 未作答的问题按 `selected: []`、无 `custom` 处理。
- 提交后选择框关闭，主输入框恢复草稿与焦点；消息区复位滚离抑制并强制回底、后续
  新内容恢复自动跟随（[docs/hosts/webview-ui.md 第 11 节](../hosts/webview-ui.md#11-消息区视图行为)
  「选择框回底」）。

## 边界与错误路径

| 输入 / 场景 | 预期行为 |
| --- | --- |
| `questions: []` | `InputValidationError`（至少 1 个问题） |
| `questions` 超过 9 项 | `InputValidationError`（最多 9 个问题） |
| `id` 重复或为空 | `InputValidationError` |
| `question` 为空白 | `InputValidationError`（`Question cannot be empty`） |
| `options: []` | 视为无选项（纯文本问题），不报错 |
| `options` 超过 9 项 | `InputValidationError` |
| `options` 元素缺 `label` 或 `label` 重复 | `InputValidationError` |
| 未知字段 | `InputValidationError`（`unrecognized_keys`） |
| 用户关闭会话 / 视图销毁 | 挂起的请求被拒绝，工具产出错误；不残留 waiting |
| 全部问题都跳过 | 合法回复：每条 `selected: []`，工具正常返回 |

## 非目标

- 不引入 dsh 的 `timeout` 定时等待与 pending 语义（「稍后回复」需要用户消息回填通道）。
  去向：[docs/architecture/open-questions.md](../architecture/open-questions.md)。
- 不把工具名改成 `ask_user_question`。
- 不引入 Claude schema 里的 `answers` 入参字段。
- 不引入 pi 扩展的 allowOther / required / placeholder / default / type 字段。

## 对需求基线的影响

- [docs/architecture/events.md](../architecture/events.md) [第 2.2 节 CoreRequest](../architecture/events.md#22-corerequestcore--ui请求-响应)：
  `userChoice` 的载荷与结果类型。
- [docs/architecture/host-ui-modules.md](../architecture/host-ui-modules.md) [第 1 节 UserChoiceManager](../architecture/host-ui-modules.md#1-userchoicemanager)：
  `UserChoiceManager` 按 `kind` 透传。
- [docs/hosts/webview-ui.md](../hosts/webview-ui.md) [第 9 节 生命周期：dropSession](../hosts/webview-ui.md#9-生命周期dropsession)：
  `AskUserQuestion` 的回复形状。
- [docs/core/standalone-core.md](../core/standalone-core.md) [第 4 节 契约](../core/standalone-core.md#4-契约)：
  `userChoice` 契约。
- [docs/features/user-stories/messages.md](user-stories/messages.md) [EP-4 权限与用户确认](user-stories/messages.md#ep-4-权限与用户确认)：
  新增 US-58。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `definitions()`、`core-rs/src/tool_input.rs` 的 `check_questions` | `core-rs/src/tools_tests.rs`、`core-rs/fixtures/toolInputValidation.json` | 自动 |
| FR-002 | `src/shared/UserChoiceQueue.ts`、`src/host/ui/webviewMessageHandler.ts` | `src/test/userChoiceDelivery.test.ts`、`src/test/userChoiceQueue.test.ts` | 自动 |
| FR-003 | `src/webview/QuestionOverlay.tsx` | 无自动覆盖 + 现有 webview 无渲染单测车道 | 无自动覆盖 + 渲染层 |
| FR-004 | `src/webview/QuestionOverlay.tsx` | 无自动覆盖 + 同上 | 无自动覆盖 + 渲染层 |
| FR-005 | `core-rs/src/tools.rs` 的 `run_ask_user_question` | `core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | `core-rs/src/tool_input.rs` | `core-rs/src/tools_tests.rs`、`core-rs/src/engine_tests.rs` | 自动 |

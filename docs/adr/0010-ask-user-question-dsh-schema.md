# ADR-0010：AskUserQuestion 入参对齐 dsh 的 questions 形状

- 状态：已采纳
- 日期：2026-10
- 规格：[docs/features/ask-user-question.md](../features/ask-user-question.md)

## 背景

`AskUserQuestion` 的旧入参是 `{ question, choices? }`：单问题、单选的 `choices`，且
`choices` 在 schema 里只声明为 `type: array`，元素形状（`label` / `description`）由运行期
校验。实际使用中模型经常生成错误形状：

- 业界同类工具（Claude Code、opencode、dsh、ZCode、pi）统一使用
  `questions[]` + `options[]` + `header` + 多选字段；模型按这个先验生成时，
  旧形状的 `question` / `choices` 会被 `strictObject` 判为缺字段 / 未知字段。
- `choices` 不写 `items`，模型无法从 schema 得知元素字段名，只能从提示词散文里猜。
- 旧形状没有多问题与多选能力，复杂决策只能拆成多次调用。

dsh 的 `ask_user_question` 用 `id` 把问题与答案一一对应，比按数组下标更稳；`multi_select`
与 `options` 的形状也与本项目「选项只有 label / description」的模型一致。

## 决策

`AskUserQuestion` 的入参、答案回传、`userChoice` 请求 / 结果、webview 选择框统一改成
dsh 形状：

- 入参：`questions: [{ id, question, header?, options?, multi_select? }]`，1–9 题；
  `options` 每项 `{ label, description? }`，出现且非空时 1–9 项。
- 答案：`{ answers: [{ id, selected, custom? }] }`；`selected` 是 option label 数组。
- 工具结果：`{"answers":[...]}` JSON 文本。
- 工具名保持 `AskUserQuestion`；不引入 dsh 的 `timeout` 与 pending 语义。
- 权限确认与 AskUserQuestion 共用 `CoreRequest.userChoice` 通道，用 `kind` 判别
  （`permission` / `question`），结果分别带 `index` / `reply` 或 `answers`。

实现落点：`core-rs/src/tools.rs`（执行与结果）、`core-rs/src/tool_input.rs`（校验）、
`src/shared/UserChoiceQueue.ts`（判别联合）、`src/webview/QuestionOverlay.tsx`（逐页 UI）。

## 替代方案（被否决）与后果

1. **保持 `question` / `choices`，只补 `items`。** 否决：命名与业界先验冲突是错误的主因，
   只补 schema 不能阻止模型生成 `questions` / `options`。
2. **照搬 Claude 的 `multiSelect` 与必填 `description`。** 否决：用户指定按 dsh；dsh 的
   `id` 更适合多问题答案对应，`multi_select` 与 dsh 一致。
3. **引入 dsh 的 `timeout` 与 pending 语义。** 否决：需要「稍后回复」的用户消息回填
   通道与 pending 结果状态，超出本次范围。
4. **权限确认单独建通道。** 否决：现有通道已共用队列、pending 补偿与 waiting 语义；
   拆开会让 `UserChoiceManager` 与 `UserChoiceQueue` 出现两套状态机。
5. **保留 `{ index, reply? }` 结果，把 answers 编码进 `reply`。** 否决：类型不安全，
   调用方需要解析字符串。

代价：多问题 / 多选让选择框从「点一下即提交」变成逐页表单，webview 需要维护分页与草稿
状态；旧对话里的 `{ question, choices }` tool_use 只能只读展示，不再被新调用接受。

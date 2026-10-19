---
status: 实施中
---

# 改动规格：模型默认 radio、多模态开关与非多模态图片过滤

设置页模型行的三处联动改动：①「设为默认」从按钮改为 radio 单选，模型名输入框内不再
内嵌「默认」后缀；②模型行新增「多模态」checkbox，默认勾选，随 `settings.json` 持久化；
③Core 构建 LLM 请求时，非多模态模型的请求体过滤全部图片内容（用户消息与工具结果，
Anthropic / Responses / OpenAI Chat Completions 三协议一致）。过滤只发生在请求出口的
副本上，不改写消息事实：会话落盘无论模型是否多模态都保留完整图片。多模态开关经既有
配置快照通道下发 Core，不新增事件、不改 wire 协议。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [US-23 管理服务商与模型](../../docs/features/user-stories.md#us-23-管理服务商与模型) | 修改 | 验收标准 2 的「模型行可设默认」改为 radio 表述并去掉模型名内「默认」后缀；新增「多模态」勾选与非多模态请求过滤的验收条目 |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 4.3 节 快照字段](../../docs/architecture/core-ui-separation.md#43-快照字段) | 修改 | `provider.modelLimits` 条目成员与 `llm.modelLimitsFallback` 增加多模态成员（`context` / `output` / `apiType` / `thinkingTokenBudget` 之外新增） |

## 用户场景与验收标准

- 场景 1：用 radio 指定默认模型
  - **AC-1**（FR-001）：GIVEN 某服务商已配置多个模型 WHEN 点选某模型行的默认 radio THEN 该模型成为该服务商的默认模型，其 radio 呈选中态，其余模型 radio 呈未选态
  - **AC-2**（FR-001）：GIVEN 列表中已有默认模型 WHEN 渲染模型行 THEN 模型名输入框内不出现「默认」后缀覆盖层（默认身份只由 radio 表达）
- 场景 2：多模态开关持久化
  - **AC-3**（FR-002）：GIVEN 某模型在 `settings.json` 中没有多模态字段 WHEN 打开设置页 THEN 该模型行的「多模态」checkbox 呈勾选态
  - **AC-4**（FR-002）：GIVEN 用户取消勾选某模型的「多模态」 WHEN 保存 THEN `settings.json` 中该模型配置的多模态字段为 `false`，重新打开面板该模型仍呈未勾选态
- 场景 3：非多模态模型的请求过滤图片
  - **AC-5**（FR-004）：GIVEN 模型多模态为 `false` 且用户消息携带图片 WHEN 发送消息 THEN 任一协议（Anthropic / Responses / OpenAI Chat Completions）的请求体都不含图片形态（image source 块 / `input_image` / `image_url`）
  - **AC-6**（FR-004）：GIVEN 模型多模态为 `false` 且历史消息中的工具结果含图片 WHEN 构建下一轮请求 THEN 请求体不含工具结果里的图片部分
  - **AC-7**（FR-005）：GIVEN 过滤后某条用户消息或工具结果不再有任何内容 WHEN 构建请求 THEN 该位置保留一个文本为 `[Image]` 的 text 块，请求体不出现空内容块
  - **AC-8**（FR-004）：GIVEN 模型多模态为 `true` 或未配置 WHEN 发送带图消息 THEN 请求体照常携带图片（现状不变）
- 场景 4：快照契约
  - **AC-9**（FR-003）：GIVEN 模型未显式配置多模态 WHEN 宿主构造快照 THEN 该模型的解析限值带多模态 `true`，未知模型命中的全局兜底同样为 `true`
  - **AC-10**（FR-003）：GIVEN 快照缺多模态字段 WHEN Core 反序列化 THEN 按协议错误报错，不做静默回落
- 场景 5：消息事实与持久化不受过滤影响
  - **AC-11**（FR-006）：GIVEN 非多模态模型完成一轮带图请求 WHEN 查看会话落盘记录 THEN 该消息仍保留完整图片数据（base64 与 media_type 原样）
  - **AC-12**（FR-006）：GIVEN 会话历史带图且此前由非多模态模型处理 WHEN 之后换用多模态模型继续对话 THEN 下一次请求重新携带这些历史图片

## 功能需求

### FR-001：默认模型用 radio 单选

- 每个服务商的模型行构成一组 radio（组按服务商区分），语义与原「设为默认」按钮一致：
  选中即把该模型设为该服务商的默认模型（`defaultModel`）。
- 当前 `defaultModel` 对应的模型行 radio 呈选中态；`defaultModel` 为空（从未设置）时
  全部呈未选态，不猜第一个。
- 模型名输入框内不再渲染「默认」后缀覆盖层；默认身份只由 radio 表达。

### FR-002：模型行「多模态」checkbox

- 每个模型行提供「多模态」checkbox，默认勾选。
- 勾选态随保存持久化到 `settings.json` 该服务商的模型级配置（`modelConfigs`，与
  `apiType` 同级）；没有该字段的模型按勾选解析。
- 保存消息把每个模型的勾选态上送宿主；宿主按「面板传值 > 已有值 > 默认开启」合并进
  `modelConfigs`，用户手填的 `context` / `output` 不受影响。

### FR-003：快照携带已解析的多模态开关

- `provider.modelLimits` 条目与 `llm.modelLimitsFallback` 增加多模态成员
  （`multimodal`，boolean，必选）。
- 解析规则：模型级显式配置 > 默认 `true`；全局兜底为 `true`（未知模型、历史会话里的
  旧模型名按多模态处理）。
- TS 侧（`resolveSettingsSnapshot`）与 Rust 侧（`ModelLimits`）同步；字段缺失是协议
  错误（对齐快照「字段全部必选」的口径）。

### FR-004：非多模态模型的请求不携带图片

- 模型多模态为 `false` 时，发给该模型的每个 LLM 请求体不含任何图片内容：用户消息
  （含其中的 `tool_result` 块）里的图片一律不进入请求体，当前轮与历史轮同样生效。
- 对三种协议（Anthropic Messages / OpenAI Responses / OpenAI Chat Completions）一致
  成立：任一协议的请求体都不得出现图片形态（Anthropic image source 块、Responses
  `input_image`、Chat Completions `image_url`）。
- 多模态为 `true`（含缺省）时行为与现状一致。

### FR-005：过滤后的空内容以文本占位

- 过滤导致某条用户消息或工具结果不再有任何内容时，该位置保留一个 `text` 块，文本为
  `[Image]`——沿用压缩管线给摘要模型的既有占位（`core-rs/src/compact.rs` 的
  `[Image]`），同一语义不发明第二种写法；该文本面向模型，不进 i18n。这样请求体不会
  出现空内容块（Anthropic 对空 content 会拒绝）。
- 只有过滤真的清空了内容才占位；仍有文本的消息正常保留其余内容，不追加占位。

### FR-006：过滤不改写消息事实

- 过滤只作用于构建请求体时的副本：引擎内存中的消息列表与会话落盘记录无论模型是否
  多模态都保留完整图片信息（base64 数据与 media_type 原样，不替换、不删除）。
- 切换到多模态模型后，历史图片从下一次请求起恢复携带；不因「曾经用非多模态模型
  对话过」而丢失。

## 边界与错误路径

- `settings.json` 手编辑出非 boolean 的多模态值：按默认 `true` 解析（与其它字段的
  规范化口径一致），不报错。
- 快照缺多模态字段：Core 反序列化报协议错误（不做静默回落，架构铁律 1）。
- 重命名默认模型：`defaultModel` 不自动跟随（与现状一致）；没有模型名与 `defaultModel`
  相等时 radio 全部呈未选态。
- 多模态开关不参与「应用到当前对话」确认框（US-24）：它是模型属性而非会话默认值，
  随保存生效，下一次请求起按新值过滤。
- 过滤不改写消息事实（FR-006）：会话落盘、历史回显、输入区缩略图不受影响
  （US-6 的体验不变）。

## 非目标

- 不自动探测模型的多模态能力：与协议自动探测不同，开关只由用户配置。
- 不为内置模型注册表（`MODEL_CONFIGS`）引入多模态维度：所有模型统一默认开启，
  注册表条目不区分视觉能力。
- 不改会话落盘格式与历史消息结构。
- 图片被过滤时不弹提示、不发横幅（占位文本已可见）。

## 对需求基线的影响

- 修订 US-23 验收标准：第 2 条的「模型行可设默认」改为 radio 表述；新增「多模态」
  勾选与非多模态请求过滤的验收条目。无新增 US：radio 与 checkbox 是 US-23 既有
  能力的形态修订，图片过滤是发送管线的行为约束，归入 US-23 验收。
- e2e：沿用 US-23 既有口径；请求体过滤由 core 单测覆盖，不新增 e2e 用例。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/LLMConfigPanel.tsx`（模型行 radio、移除 `defaultModelSuffix` 覆盖层） | 无自动覆盖：webview 面板无渲染级单测；`defaultModel` 的保存链路由既有用例覆盖 | 无自动覆盖 + UI 交互，按 US-23 既有口径人工/e2e 验收 |
| FR-002 | `LLMConfigPanel.tsx`（checkbox）、`src/host/webviewMessages.ts`（载荷字段）、`src/host/llmConfigSave.ts` 与 `src/shared/utils/modelConfig.ts`（合并） | `src/test/hostSettings.test.ts` | 自动 |
| FR-003 | `src/shared/settingsSnapshot.ts`、`core-rs/src/settings.rs`（`ModelLimits`） | `src/test/settingsSnapshot.test.ts`、`core-rs/src/settings_tests.rs` | 自动 |
| FR-004 | `core-rs/src/llm.rs`（请求出口过滤） | `core-rs/src/llm_tests.rs`、`core-rs/src/responses_tests.rs` | 自动 |
| FR-005 | 同 FR-004 的过滤实现 | `core-rs/src/llm_tests.rs` | 自动 |
| FR-006 | `core-rs/src/llm.rs`（过滤作用于请求副本，不改写入参消息） | `core-rs/src/llm_tests.rs`（入参消息不被改写、落盘记录含完整图片） | 自动 |

## 待澄清

（无）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>

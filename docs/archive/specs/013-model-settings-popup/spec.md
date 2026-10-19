---
status: 已收敛
---

# 改动规格：模型行「设置」弹层（多模态 / context / output）

设置页模型行的「多模态」checkbox 收进一个「设置」按钮：点击打开该模型的设置弹层，
弹层内可配置「是否多模态」「context 大小」「output 大小」三项并随保存持久化到
`settings.json` 的 `modelConfigs`。多模态的请求过滤语义（specs/012 归档）不变；
context / output 从「只能手改文件」变为面板可编辑，快照字段与解析优先级不变。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [US-23 管理服务商与模型](../../docs/features/user-stories.md#us-23-管理服务商与模型) | 修改 | 验收 2 的模型行控件清单（「多模态」勾选 →「设置」按钮）；验收 5 改为弹层表述并补 context / output 编辑条目 |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 4.3 节 快照字段](../../docs/architecture/core-ui-separation.md#43-快照字段) | 修改 | `provider.modelLimits` 条目的合并规则补「面板显式编辑值」一级（面板编辑值 > 已有 modelConfigs 值 > 内置注册表 > 兜底，空输入回落到既有解析） |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [第 3 节 WebviewMessageHandler](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | `saveLLMConfig` 的载荷与合并口径说明补每模型 context / output 上送（消息分区表不变） |

## 用户场景与验收标准

- 场景 1：模型行收起三项设置
  - **AC-1**（FR-001）：GIVEN 设置页任一 provider 的模型行 WHEN 渲染 THEN 行内不出现「多模态」checkbox，出现「设置」按钮；默认 radio、API 协议下拉、删除按钮不受影响
  - **AC-2**（FR-002）：GIVEN 某模型行 WHEN 点击「设置」THEN 打开该模型的设置弹层，含「多模态」开关（沿当前持久化态，缺省开）与 context / output 数字输入（预填当前解析值）
- 场景 2：编辑并保存限值
  - **AC-3**（FR-003）：GIVEN 弹层中把 context 改为 200000 WHEN 保存成功 THEN `settings.json` 该模型 `modelConfigs.context = 200000`，重新打开面板弹层仍显示 200000，快照解析优先于内置注册表
  - **AC-4**（FR-003）：GIVEN 弹层中把 output 清空 WHEN 保存成功 THEN `settings.json` 该模型 `modelConfigs` 不含 output 显式值，快照按内置注册表 / 兜底解析（与「从未设置」同态）
  - **AC-5**（FR-003）：GIVEN 弹层中关闭「多模态」WHEN 保存成功 THEN `modelConfigs.multimodal = false`，该模型的 LLM 请求过滤图片（specs/012 语义不变）
- 场景 3：非法输入
  - **AC-6**（FR-004）：GIVEN 弹层中 context 或 output 输入 0、负数或非数字 WHEN 点保存 THEN 保存被既有校验拦下并给出模型级错误提示，不写盘
- 场景 4：不碰弹层时行为不变
  - **AC-7**（FR-003）：GIVEN 未打开 / 未修改弹层 WHEN 保存 THEN `modelConfigs` 的 context / output 与现状口径一致（已有值保留、缺失由内置注册表补齐），多模态仍逐模型显式上送
  - **AC-8**（FR-005）：GIVEN 弹层打开 WHEN 点击弹层外区域或「取消」THEN 弹层关闭，三项均不落盘（草稿丢弃）

## 功能需求

### FR-001：模型行以「设置」按钮取代「多模态」勾选

- 每个模型行提供一个「设置」按钮（图标按钮，行内位置在 API 协议下拉与默认 radio
  之后、删除按钮之前）；点击打开该模型的设置弹层。
- 行内不再直接渲染「多模态」checkbox；默认 radio、API 协议下拉、模型名输入、删除
  按钮的布局与行为不变。
- 模型名为空（新行未填写）时按钮行为与行内其它控件同口径（可点开弹层，但保存仍受
  「模型名非空」的既有校验约束）。

### FR-002：设置弹层的三项控件

- 弹层含三项：「多模态」开关（默认开，沿当前持久化态）、context 大小、output 大小。
- context / output 为数字输入，预填该模型当前解析值（面板载荷 `modelConfigs` 的
  context / output）；清空表示「移除显式值」。
- 弹层文案走 i18n（zh / en）。

### FR-003：保存合并与解析优先级

- 保存消息（`saveLLMConfig`）按模型上送三项：多模态勾选态、context 显式值（空则
  不上送）、output 显式值（空则不上送）。
- 宿主合并优先级：面板显式值 > 已有 `modelConfigs` 值 > 内置注册表 > 全局兜底；
  清空上送（该字段无显式值）时移除 `modelConfigs` 里的既有显式值，后续解析回落到
  注册表 / 兜底。
- 快照字段（`provider.modelLimits` 条目的 `context` / `output` / `apiType` /
  `thinkingTokenBudget` / `multimodal`）与 Core 侧消费不变；多模态仍逐模型显式
  上送（specs/012 口径）。

### FR-004：输入校验

- context / output 只接受正整数；0、负数、非数字在保存前校验拦下（并入面板既有的
  保存前校验与错误提示口径），不写盘。
- 不做 context 与 output 的跨字段大小强校验（运行时已有 `min(output,
  context - current)` 收敛，见 `core-rs/src/engine.rs` 的输出预留逻辑）。

### FR-005：弹层交互

- 弹层打开期间可反复修改；「取消」或点击弹层外区域关闭并丢弃草稿，不触发保存。
- 同一时刻只开一个弹层（切换到另一模型的「设置」即关闭前一个）。

## 边界与错误路径

- 模型行被删除时若其弹层开着：弹层随行一起关闭，草稿丢弃。
- 「自动获取」刷新模型列表后，`modelConfigs` 合并沿用既有规则（面板传值 > 已有值 >
  注册表补齐），新模型弹层预填注册表解析值。
- 输入超长 / 科学计数法等非整数文本：按 FR-004 的「非数字」处理，保存拦下。
- 保存失败（写盘异常）：沿面板既有失败路径提示，弹层状态不丢。

## 非目标

- 不引入 context 与 output 的跨字段校验（如 output < context）。
- 不改快照字段集合与 Core 侧限值消费逻辑（`available_output_tokens` 等）。
- 不改 `thinkingTokenBudget` 的配置方式（仍是 core 侧运行时取值，面板不暴露）。
- 不做 provider 级批量设置（每模型独立配置）。

## 对需求基线的影响

- 修改 US-23（管理服务商与模型）：验收 2 的模型行控件清单与验收 5 的多模态表述，
  新增 context / output 编辑验收条目。
- e2e：US-23 已有 `e2e/webview/settings.spec.ts` 覆盖口径，实施时补弹层交互用例
  （打开 / 编辑 / 清空回落 / 非法输入拦截）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/LLMConfigPanel.tsx`（模型行「设置」按钮，移除行内 checkbox） | `e2e/webview/settings.spec.ts` 补模型行控件断言 | 自动 |
| FR-002 | `LLMConfigPanel.tsx`（弹层组件与预填） | `e2e/webview/settings.spec.ts` 弹层用例 | 自动 |
| FR-003 | `LLMConfigPanel.tsx` / `src/host/webviewMessages.ts`（载荷）、`src/host/llmConfigSave.ts`（合并） | `src/test/hostSettings.test.ts` 补合并优先级用例 | 自动 |
| FR-004 | `LLMConfigPanel.tsx`（输入校验） | `e2e/webview/settings.spec.ts` 非法输入用例 | 自动 |
| FR-005 | `LLMConfigPanel.tsx`（弹层交互） | `e2e/webview/settings.spec.ts` 取消 / 切换用例 | 自动 |

## 待澄清

实施前无未决问题。

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：
  - AC-1 / AC-2**（FR-001 / FR-002）：e2e `settings.spec.ts`「模型设置弹层：预填解析值，
    改值保存进 modelLimits」——行内无「多模态」checkbox、`模型设置` 按钮可见；弹层标题、
    多模态开关、context / output 输入预填解析值（1024000 / 128000）齐备。
  - AC-3**（FR-003）：e2e 断言 `saveLLMConfig.providers[0].modelLimits['mock-model']`
    为 `{context: 200000, output: 8000}`；`hostSettings.test.ts`「弹层显式限值胜过已有值」
    锁定落盘 200000 / 8000。「重开面板仍显示」由链路分段覆盖：载荷 → `modelConfigs`
    落盘（同用例）→ 面板载荷经 `readLlmConfigPanelPayload` 重建（既有 settingsRead
    通路），e2e 假宿主不持久化，无法端到端断言重开显示。
  - AC-4**（FR-003）：`hostSettings.test.ts`「清空回落注册表（与从未设置同态）」——
    `deepseek-flash` 清空后写回注册表 context / output；e2e 断言清空上送
    `{context: null, output: null}`。
  - AC-5**（FR-003）：e2e 断言 `modelMultimodal['mock-model'] === false`；请求过滤
    语义归 specs/012 既有 `llm_tests` 用例，本次全量不回归。
  - AC-6**（FR-004）：e2e「非法限值保存被拦下」遍历 `0` / `-5` / `abc` 三种形态——
    均提示「模型 mock-model 的 Context / Output 必须是正整数」且 `saveLLMConfig` 零发出。
  - AC-7**（FR-003）：`hostSettings.test.ts`「未碰字段保留已有值」（333 / 444 原样）
    与既有「已有 context 不被多模态合并破坏」。
  - AC-8**（FR-005）：e2e「清空回落注册表，取消丢弃草稿」——应用空串后重开仍空串、
    填 999 取消后再开仍空串（草稿丢弃、不落盘）；点弹层外区域与「取消」走同一
    `onClick` handler（覆盖层），未单独断言。
- 偏差（收敛反向对照发现，已改代码）：
  - `buildModelDrafts` 初版把解析值初始化进 `contextText`，保存载荷会把**全部模型**
    当成 touched 逐个上送钉值，违背 FR-003「只收 touched 字段」。修复：草稿限值文本
    保持 `undefined = 未碰过`，弹层预填由 `openModelSettings` 从载荷解析值现取；
    应用守卫（与预填原文相同不写回）不变。修复后 e2e settings + messagePresentation
    25 项、Rust compact / interrupt 39 项复跑全绿。
- 未做：无。

反向对照（实现 → spec）：自动获取的新模型不带限值文本（`mergeFetchedModels` 保留
undefined，宿主按注册表补齐）落在 FR-003 与「边界」；重命名模型时已应用的弹层文本
随行带到新名字（保存按新名字上送显式值）——spec 未单列，属「草稿随模型行」的自然
语义，观测为该行的行内设置，记已满足；脏检测纳入 `contextText/outputText` 比对是
FR-003 保存链路的实现细节。追溯矩阵测试落点逐个打开验证存在：`hostSettings.test.ts`
4 条新断言、e2e settings 3 条用例（25 项全绿）。影响基线三行（US-23、
core-ui-separation 4.3、host-ui-modules 3）按实际 diff 复核均已落地，无多出未声明的
契约变更（wire 仅新增 `modelLimits` 可选载字段，`AssistantEventBus` 联合零改动）。

闸门证据：`check-types` / `lint` / `test:all`（57 项，含 docs-lint）全绿；
e2e webview settings 18 项 + messagePresentation 7 项全绿。

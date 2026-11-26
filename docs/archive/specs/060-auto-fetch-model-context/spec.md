---
status: 已收敛
---

# 改动规格：自动获取模型时的 context 尝试与两个勾选项

设置页「自动获取」拉取模型列表后弹出确认对话框，对话框把两个可独立勾选的动作并列：
「自动检测 API 协议」（既有行为，改为勾选项）与「尝试获取 context 大小」（默认勾选）。
勾选 context 时，本次获取总会带上一次上下文窗口的取数尝试；取到就覆盖既有值，取不到则
既有值不动、没有值时按注册表 / 兜底链解析。范围限「模型列表 → context 限值」这一条管道与
该对话框，不改协议探测的判定规则、不改 Core、不改落盘格式。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/host-ui-modules.md 第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | WebviewMessageHandler | 修改 | `fetchProviderModels` / `detectProviderModelApiTypes` 的回包增加上下文候选；分发表中两条的说明同步 |
| [docs/architecture/core-ui-separation.md 4.3](../../docs/architecture/core-ui-separation.md#43-快照字段) | 快照字段 | 修改 | context 限值的合并优先级链插入「自动获取探测值」这一级 |
| [docs/features/user-stories/sessions-and-llm.md US-23](../../docs/features/user-stories/sessions-and-llm.md#us-23-管理服务商与模型) | 管理服务商与模型 | 修改 | 验收标准 3 改写：自动获取后的确认对话框并列两个勾选项，context 勾选时取到即覆盖 |
| [docs/architecture/contracts.md 第 5 节](../../docs/architecture/contracts.md#5-宿主侧入口动作翻译为-uievent) | 宿主侧入口：动作翻译为 UiEvent | 修改 | 无副作用查询条目下两条消息的回包形态变化（均不产生 `UiEvent`） |

## 用户场景与验收标准

- 场景 1：本地 llama.cpp 服务，模型条目带真实上下文窗口
  - **AC-1**（FR-001）：GIVEN provider 地址指向一个在模型列表响应里返回 `data[].meta.n_ctx` 的服务 WHEN 用户点「自动获取」THEN 该模型的上下文候选取该值
  - **AC-2**（FR-002）：GIVEN 某条目同时有 `meta.n_ctx = 73728` 与 `meta.n_ctx_train = 262144` WHEN 提取上下文候选 THEN 候选为 73728
  - **AC-3**（FR-002）：GIVEN 某条目只有 `meta.n_ctx_train` WHEN 提取上下文候选 THEN 该模型没有上下文候选
  - **AC-4**（FR-002）：GIVEN 某条目的上下文字段为 `0`、负数、非数字字符串或缺失 WHEN 提取上下文候选 THEN 该字段被忽略，不产生候选
- 场景 2：对话框的两个勾选项
  - **AC-5**（FR-005）：GIVEN 模型列表拉取成功 WHEN 对话框弹出 THEN 「自动检测 API 协议」与「尝试获取 context 大小」两个勾选项并列显示，两者默认都勾选
  - **AC-6**（FR-005）：GIVEN 模型列表拉取成功但所有模型都已有协议 WHEN 对话框弹出 THEN 协议勾选项置灰不可勾选，context 勾选项照常可勾选
  - **AC-7**（FR-005）：GIVEN 模型列表拉取成功但响应里没有任何模型的上下文候选 WHEN 对话框弹出 THEN context 勾选项置灰不可勾选并标注未取到，协议勾选项不受影响
  - **AC-8**（FR-005）：GIVEN 对话框里用户取消勾选两个选项 WHEN 点确定 THEN 只合并模型列表，不发起协议探测、不应用任何上下文候选
  - **AC-9**（FR-005）：GIVEN 对话框里用户只勾选 context 选项 WHEN 点确定 THEN 不发起协议探测，模型 `apiType` 保持原状，上下文候选照常应用
- 场景 3：勾选时取到候选的覆盖语义
  - **AC-10**（FR-004）：GIVEN 勾选了 context 选项、探测值为 `73728` 且 `settings.json` 里已有 `context = 1024000` WHEN 保存 THEN 落盘的 `context` 为 73728
  - **AC-11**（FR-004）：GIVEN 勾选了 context 选项、探测值为 `73728` 且用户在同一次面板会话里于「设置」弹层填过 `context = 200000` WHEN 保存 THEN 落盘的 `context` 为 73728
  - **AC-12**（FR-004）：GIVEN 勾选了 context 选项、探测值为 `73728` 且用户在弹层把 context 清空 WHEN 保存 THEN 落盘的 `context` 为 73728
  - **AC-13**（FR-004）：GIVEN 某模型是本次获取前就已存在于 provider 模型列表里的模型、其 `context` 已有值、本次响应为它返回了候选 WHEN 勾选 context 并保存 THEN 该既有模型的 `context` 也被覆盖为候选值
  - **AC-14**（FR-004）：GIVEN 某模型既有 `apiType` 已配置值 WHEN 勾选 context 并保存 THEN 该模型的 `apiType` 不变，仅 `context` 被覆盖
- 场景 4：没取到候选时的回落
  - **AC-15**（FR-004）：GIVEN 勾选了 context 选项但该模型没有候选、且 `settings.json` 里已有 `context = 200000` WHEN 保存 THEN 落盘的 `context` 仍为 200000
  - **AC-16**（FR-004）：GIVEN 勾选了 context 选项但该模型没有候选、且该模型没有任何既有 context WHEN 保存 THEN 落盘的 `context` 为内置注册表解析值
  - **AC-17**（FR-003）：GIVEN 用户取消勾选 context 选项且 `settings.json` 里已有 `context = 200000` WHEN 保存 THEN 落盘的 `context` 仍为 200000
- 场景 5：取不到时的兜底与失败
  - **AC-18**（FR-001）：GIVEN 模型列表请求返回 500 WHEN 用户点「自动获取」THEN 面板显示获取失败提示，模型列表与已有 `context` 配置都不变
  - **AC-19**（FR-001）：GIVEN 响应里所有条目都没有可识别的上下文字段 WHEN 用户点「自动获取」并保存 THEN 落盘的 `context` 与本次改动前逐字节一致
- 场景 6：协议探测阶段不丢候选
  - **AC-20**（FR-006）：GIVEN 阶段一返回了非空的待探测模型列表与上下文候选 WHEN 用户确认后进入阶段二 THEN 阶段二回包携带同一份上下文候选，保存时的落盘结果与只走阶段一一致
- 场景 7：宿主差异
  - **AC-21**（FR-007）：GIVEN 同一份带回上下文字段的模型列表响应 WHEN 分别在 TS 宿主与 PyCharm 宿主的面板里点「自动获取」THEN 面板消费的回包字段名一致，Kotlin 侧本次不产出候选、面板按无候选路径回落

## 功能需求

### FR-001：取数尝试发生在模型列表请求内

上下文候选取自「自动获取」已有的那一次模型列表请求的响应体，逐模型提取；本次改动不新增
HTTP 请求，也不在阶段二（协议探测）里重复拉取模型列表。

「总是尝试获取一次」由此满足：每一次「自动获取」都会带着这次取数尝试执行，与既有配置里
是否已有值无关；响应里有没有该字段决定尝试是否成功。

### FR-002：提取口径与字段优先级

单个模型条目的上下文候选按固定顺序取第一个合法值：

1. `meta.n_ctx`
2. `context_length`
3. `max_model_len`
4. `max_context_length`

合法值 = 大于 0 的安全整数。非数字、`0`、负数、小数一律视为「该字段不存在」，继续看下一个
字段；四个字段都不可用时该模型没有上下文候选。

`meta.n_ctx_train` 不参与提取：它是训练上下文，不等于服务端本次加载的窗口，用它会把限值
高估。

### FR-003：context 勾选项控制是否应用

确认对话框里的「尝试获取 context 大小」控制本次获取的候选是否写入配置：勾选时按 FR-004
应用，未勾选时完全不应用（候选即使存在也丢弃，既有值原样保留）。

该勾选项默认勾选；勾选状态在对话框内单次生效，不持久化到 `settings.json`，也不跨面板会话
记忆。

### FR-004：应用语义（取到覆盖、取不到不动）

勾选 context 选项时，应用范围是**回包模型列表里的全部模型**，与它本次是否新出现、`apiType`
是否已配置都无关：

- **有候选**：写入该候选值，覆盖一切既有来源——包括 `settings.json` 里已有的
  `modelConfigs[model].context`、用户在同一次面板会话里于「设置」弹层填入的值（含把该字段
  清空的情形），以及该模型是既有条目的情形。
- **无候选**：既有值不动。既有值包括弹层本次填入的值与 `settings.json` 已有的值；
  两者都没有时按内置模型注册表解析，注册表未命中则用全局兜底值。

只在 `context` 这一个字段上应用：既有条目的 `apiType` / `multimodal` / `output` 不受影响。

因此 context 限值的最终优先级（高 → 低）：

1. 本次自动获取的探测值（勾选时，且该模型有候选）
2. 面板「设置」弹层在同一次面板会话里显式填入的值（含清空）
3. `settings.json` 已有的 `modelConfigs[model].context`
4. 内置模型注册表解析值
5. 全局兜底值

探测值一经保存即成为 `modelConfigs[model].context`，下次自动获取会写入新的探测值。落盘形态
与格式不变（仍是非负整数），Core 侧无感知。

### FR-005：确认对话框并列两个勾选项

模型列表拉取成功后**总会**弹出确认对话框（此前「所有模型都已有协议」时静默完成的路径取消），
两个勾选项并列呈现，各自独立生效、作用域不同：

- 「自动检测 API 协议」：只对**本次列表里尚未配置协议的模型**生效（既有语义不变）。默认
  勾选；待探测模型数为 0 时该选项置灰不可勾选，并标注没有待探测的模型。
- 「尝试获取 context 大小」：对**本次列表里全部模型**生效（FR-004），与协议是否已知无关。
  默认勾选；回包里没有任何模型候选时该选项置灰不可勾选，并标注本次未取到。

对话框的确定按钮按勾选情况执行：两个都勾选时先探测协议、再应用候选；只勾选其一时只执行对应
动作；都不勾选时只合并模型列表。跳过按钮与点击遮罩等同于「都不勾选」：只合并模型列表，
不发起协议探测、不应用候选。

两个动作互不依赖：协议探测失败不影响候选应用，候选缺失也不影响协议探测。两个勾选项的置灰
互不影响——一个置灰不改变另一个的默认勾选状态与可操作性。

### FR-006：wire 载荷携带上下文候选

`providerModelsFetched` 与 `providerModelsResult` 两个回包各带一个「模型名 → 上下文候选」
映射，缺失该映射或映射为空表示本次没有取到任何候选。两个回包携带的映射对同一次获取是同一份
内容：面板在阶段一拿到即可，阶段二回包用于用户跳过探测、或阶段一与阶段二之间面板重挂载后
仍能拿到候选。

映射中出现的模型名以该次回包的模型列表为准；列表里没有的名字面板忽略。

勾选状态由面板发给宿主的探测请求携带（「本次获取是否应用候选」），宿主不持久化该状态。

### FR-007：宿主实现各自独立

该能力属于各宿主设置面板的模型拉取实现。TS 宿主（VSCode / Electron 共用
`WebviewMessageHandler`）与 PyCharm 宿主（Kotlin `ProviderProbe`）各自提取、各自回包；
面板侧只消费回包里的映射，不感知提取细节。

## 边界与错误路径

- **同一 provider 多模型**：逐模型独立提取与合并，互不影响。
- **模型名重复**：以回包模型列表去重后的名字为键，同一名字只保留一个候选。
- **既有条目 vs 新增条目**：context 应用对两者一致；协议探测仍只认 `apiType` 为空的条目。
- **面板在阶段一之后关闭又打开**：候选随面板草稿生命周期结束，不跨面板会话保留；重新
  「自动获取」时重新取。
- **勾选状态**：只对当次获取生效，不写盘、不记忆。
- **探测值远小于既有值**：按 FR-004 覆盖为探测值（更保守，不超出服务端窗口）。
- **探测值远大于既有值**：同样覆盖为探测值；勾选是可关闭的开关，用户在对话框里取消勾选即可
  保留自己的配置。
- **弹层清空 + 有候选**：候选照常写入（覆盖优先于清空）。
- **弹层清空 + 无候选**：回落到内置注册表解析值，作用等同于既有清空语义。
- **候选为超大数值**（超过安全整数范围）：按非法处理，视作无候选，走 FR-004 的「无候选」
  分支。
- **部分模型有候选**：有候选的模型覆盖，无候选的模型各自保留现有值，互不影响。
- **Core 侧**：无变更。落盘仍是整数，快照解析与 `ModelLimits` 契约不变。

## 非目标

- PyCharm 宿主 `ProviderProbe` 的提取落地：本次只覆盖 TS 宿主的模型拉取实现，Kotlin 侧保持
  现状（该实现的「v1 简化」口径见其文件头注释），后续 spec 补齐。
- TUI：没有「自动获取」入口，不涉及。
- 输出 token 上限（`output`）的自动探测：模型列表响应里没有对应事实。
- 面板界面展示探测到的上下文窗口大小（只影响保存值，不新增显示）。
- context 勾选状态的持久化与跨面板会话记忆。
- 协议探测的判定规则、并发与重试策略的变动。

## 对需求基线的影响

修改 US-23 的验收标准 3：自动获取后**总会**弹出确认对话框，并列两个勾选项（协议探测 / 尝试
获取 context 大小，均默认勾选）；context 作用于列表里全部模型（含已有模型的既有值），取到
即覆盖、取不到则既有值不动；协议探测仍只针对未知协议的模型。该 US 已登记于
`e2e/webview/settings.spec.ts` 的附录映射，本次新增用例落在同一文件，不新增 US。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `WebviewMessageHandler` 的 `fetchModelsFromProvider` / `handleFetchProviderModels` | `src/test/modelContextProbe.test.ts`「单次模型列表请求内提取候选」 | 自动 |
| FR-002 | 上下文候选提取的纯函数（`src/shared/utils/modelConfig.ts`） | `src/test/modelContextProbe.test.ts` 字段优先级与非法值用例 | 自动 |
| FR-003 | 面板确认对话框的勾选状态与探测请求载荷 | `e2e/webview/settings.spec.ts` 取消勾选 context 用例 | 自动 |
| FR-004 | `normalizeModelTokenLimits` 的合并链（`src/shared/utils/modelConfig.ts`）+ `applyLlmConfigSave` 传参 | `src/test/hostSettings.test.ts` 覆盖 / 回落 / 既有条目被覆盖用例 | 自动 |
| FR-005 | `src/webview/LLMConfigPanel.tsx` 的确认对话框；`src/webview/i18n/zh.ts` / `en.ts` 文案 | `e2e/webview/settings.spec.ts` 两个勾选项与置灰用例 | 自动 |
| FR-006 | `src/host/webviewMessages.ts` 的两个回包载荷；面板阶段一 / 阶段二处理 | `e2e/webview/settings.spec.ts` 自动获取用例（`e2e/helpers/fakeHost.ts` 回带候选） | 自动 |
| FR-007 | 各宿主既有模型拉取实现（TS 侧改动面见 FR-001） | — | 无自动覆盖 + Kotlin 侧本次不落地，见「非目标」 |

## 待澄清

```text
```

## 收敛记录

收敛时由 /implement 填写，结论只分三类。

- 已满足：
  - FR-001 / FR-002 → `src/shared/utils/modelConfig.ts` 的 `readModelContextFromEntry`；
    `src/test/modelContextProbe.test.ts`（18 条，含字段优先级、`meta.n_ctx_train` 排除、
    `0` / 负数 / 小数 / 非数字 / 超安全整数、形态不受控条目）。
  - FR-003 / FR-004 → `normalizeModelTokenLimits` 的 `probeContexts` 一级；
    `src/test/hostSettings.test.ts` 的 AC-10 / AC-11 / AC-12 / AC-14 / AC-15 / AC-16 / AC-17 / AC-19。
  - FR-005 → `LLMConfigPanel.tsx` 的确认对话框（两个并列勾选项、各自置灰）；
    `e2e/webview/settings.spec.ts` 的三条自动获取用例（默认勾选并上送、取消勾选不上送、
    两种置灰）。
  - FR-006 → `webviewMessages.ts` 三处 `modelContexts` 载荷与 handler 两处回包；
    阶段二回带同一份候选的端到端判据由上面第一条 e2e 覆盖（既有模型 `mock-model` 的候选
    经阶段二回包后仍在保存载荷里）。
  - FR-007 → 面板只消费回包映射，未感知宿主实现；Kotlin 侧按「非目标」保持不变。
- 偏差：
  - 实现期发现并修复的两个缺陷（均在本次范围内闭环，未改 FR / AC）：
    1. `mergeFetchedModels` 重建既有条目时漏复制 `contextProbe`，阶段二只回带待探测模型
       时会让阶段一已应用的候选丢失。由 e2e 抓到（期望含 `mock-model`，实际只剩
       `probe-model`），已改为保留既有候选，并在「本次列表」分支里按需覆盖或清除。
    2. `e2e/helpers/fakeHost.ts` 注入脚本里误写 TypeScript 类型标注（`(m: string)`），
       该脚本在浏览器内直接执行，导致所有 webview 用例启动期报 `Unexpected token ':'`。
       属测试脚手架问题，已去掉标注。
- 未做：
  - PyCharm 宿主 `ProviderProbe` 的候选提取（spec 已列为非目标，Kotlin 侧不产出候选，
    面板走无候选回落路径）。

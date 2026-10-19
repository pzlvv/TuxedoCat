# 实施方案：模型行「设置」弹层（多模态 / context / output）

技术路线：面板内新增一个模态小弹层组件（复用既有 dialog 覆盖层模式），编辑三项值经
「应用」写回模型行草稿；保存消息（`saveLLMConfig`）的 provider 条目新增
`modelLimits` 逐模型上送（键存在 = 用户碰过该字段，数值 = 显式值，`null` = 清空）；
宿主侧合并走 `normalizeModelTokenLimits` 的新增 overrides 参数。语义上「清空 = 回落
注册表值」——保存链路的不变量是「每个模型的 `modelConfigs.context/output` 恒为具体
数字（缺失由注册表补齐）」，注册表数字正是「从未设置」的模型保存后会写入的同一个值，
因此清空后的落盘状态与从未设置**逐字节同态**（spec AC-4 的「同态」由此达成；首句
「不含显式值」读作「不含偏离注册表的用户显式值」）。指向同目录 `spec.md`。

## 技术方案

**面板（`src/webview/LLMConfigPanel.tsx`）**：

- `ModelDraft` 增加两个可编辑字段：`contextText?: string; outputText?: string`
  （`undefined` = 未碰过；字符串 = 弹层应用过的原文，含 `''` 与非法文本）。
  多模态仍是 `multimodal: boolean`，只是编辑入口从行内 checkbox 挪进弹层。
- 新增弹层组件（文件内 memo 组件，仿 `DeleteConfirmDialog` 的覆盖层 + 居中小卡）：
  - 打开时以 `{ providerId, index, name, multimodal, contextText, outputText }`
    快照为**弹层本地 state**；预填顺序：草稿已应用值 > 面板载荷解析值
    （`initialProviders[].modelConfigs`，来自 `readLlmConfigPanelPayload` 的
    `provider.modelLimits`，恒有具体数字）> 空串。
  - 「应用」把三项写回草稿（`multimodal` 直写、`contextText/outputText` 原文写入）
    并关闭；「取消」/点覆盖层直接关闭丢弃（FR-005）。面板级单份 state 天然保证
    「同一时刻只开一个」。
  - 模态覆盖层阻断行内交互，`index` 在打开期间稳定；应用时按 `providerId + index`
    回写，查不到（理论不可达）就地丢弃。
- 行内改动：删「多模态」checkbox 与其左侧竖向分割线，原位放「设置」图标按钮
  （复用 `Icon`，与右侧红叉删除按钮同尺寸语言）；radio、协议下拉、删除按钮不动。
- `providersChanged` 脏检测：模型比对加 `contextText/outputText` 与初始解析值字符串
  的比较（`undefined` 视为未碰 = 相等）。
- `buildProvidersPayload`：每模型解析 `contextText` →
  `{ kind: 'untouched' } | { kind: 'value', value: number | null } | { kind: 'invalid' }`
  （`''` → `null`；正整数 → number；其余 → invalid）。payload 新增
  `modelLimits: Record<string, { context?: number | null; output?: number | null }>`，
  只收 touched 字段；invalid 不进 payload。
- `handleSave` 校验链（FR-004）：在「每个 provider 至少一个模型」之后追加——存在
  invalid 字段时 `setModelError`（带模型名的 i18n 提示）、切到对应 tab、中止保存，
  不写盘。
- 预填与「自动获取」：`mergeFetchedModels` 对新模型不设 `contextText/outputText`
  （undefined = 未碰，宿主按注册表补齐）；已有模型保留草稿值。

**宿主（`src/host/llmConfigSave.ts` + `src/shared/utils/modelConfig.ts`）**：

- `PanelProvider` / `SaveLlmConfigProvider`（`src/host/webviewMessages.ts`）新增
  `modelLimits?: unknown`；逐字段校验：键为模型名，值只接受
  `{ context?: number | null; output?: number | null }`（正数或 null，其余丢弃）。
- `normalizeModelTokenLimits` 增加第 5 参 `limitOverrides`：
  - override 数值 > 0 → 直接作为该字段值（胜过已有值与注册表，spec FR-003）；
  - override `null` → 跳过已有值，取注册表 `fallback`（清空 = 回落注册表）；
  - 无 override → 现状（已有合法值保留，否则注册表补齐）。
  apiType / multimodal 的合并不变。
- 既有语义保持：`modelMultimodal` 仍逐模型显式上送；「全表 modelConfigs 补齐」
  （步骤 2，无 overrides 调用）不受影响——它只补缺失，不覆盖已写入的值。

**i18n（`src/webview/i18n/zh.ts` / `en.ts`）**：新增键
`llmConfig.modelSettings`（按钮 tooltip）、`llmConfig.modelSettingsTitle`（弹层标题，
带模型名插值）、`llmConfig.contextSize` / `llmConfig.outputSize`（字段标签）、
`llmConfig.modelSettingsApply` / `llmConfig.modelSettingsCancel`、
`llmConfig.invalidModelLimits`（校验提示，含模型名插值）。

**测试**：

- `src/test/hostSettings.test.ts`：合并优先级四例（面板显式值胜已有值；清空回落
  注册表；未碰字段保留已有值；非法载荷字段丢弃）。
- `e2e/webview/settings.spec.ts`：模型行不再有行内 checkbox、有设置按钮；打开弹层
  预填解析值；改值保存后重开面板仍显示；清空保存后显示回落注册表值；0 / 负数 /
  非数字保存被拦下且有错误提示；取消不改值。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/webview/LLMConfigPanel.tsx` | 修改：`ModelDraft` 两字段、弹层组件、行内按钮替换、脏检测、payload、保存校验 | webview 内部，无对外契约 |
| `src/host/webviewMessages.ts` | 修改：`SaveLlmConfigProvider.modelLimits` | wire 消息字段新增（可选字段，缺省 = 现状） |
| `src/host/llmConfigSave.ts` | 修改：`PanelProvider.modelLimits` 校验、传参 | 无事件 / 落盘格式变化（`modelConfigs` 结构不变） |
| `src/shared/utils/modelConfig.ts` | 修改：`normalizeModelTokenLimits` 第 5 参 | 纯函数扩展，既有调用不受影响 |
| `src/webview/i18n/zh.ts` / `en.ts` | 修改：新增 7 键 | 无 |
| `src/test/hostSettings.test.ts` | 修改：新增合并用例 | 无 |
| `e2e/webview/settings.spec.ts` | 修改：新增弹层用例 | 无 |
| `docs/features/user-stories.md`、`docs/architecture/core-ui-separation.md`、`docs/architecture/host-ui-modules.md` | 文档同步（同 spec 影响基线表） | docsLint 对照项同步 |

不涉及：CoreEvent / UiEvent 词汇表、`AssistantEventBus` 契约、落盘格式（对话 JSONL /
meta.json）、core-rs（快照消费端无变化，`modelConfigs` 是 settings.json 的 UI 侧概念，
快照 `modelLimits` 已是解析结果）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 webview / host / shared 叶子层；
      `modelConfig.ts` 是 shared 纯工具，不引宿主 API；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback——清空是用户显式动作，回落
      注册表是既有解析规则而非静默降级；不新增可选契约成员（wire 的 `modelLimits`
      是消息载荷新字段，缺省语义 = 现状，与 `modelMultimodal` 同模式）；默认值单源
      （注册表 / `FALLBACK_MODEL_PARAMS` 不动）；「弹层草稿」是 UI 本地态，不产生
      第二事实源（settings.json 仍只有 `applyLlmConfigSave` 一个写入点）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及——core-rs 零改动；
      `settings.json` 的 `modelConfigs` 既有结构不变，只是取值来源多一级。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：US-23、core-ui-separation 4.3、
      [host-ui-modules 第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler)随实施同提交修订；`npm run test:all -- docs-lint` 必绿。

## 被否决的替代方案

- **「清空 = 从 modelConfigs 删除该字段」**：要求放宽「每个模型恒有具体数字」的
  既有不变量，且步骤 2 的全表补齐会在同一次保存里把缺失字段重新填回，两处逻辑
  都要改；而「写注册表数字」与从未设置逐字节同态，观测结果一致。否决。
- **弹层编辑直写草稿（无本地快照）**：无法实现「取消 / 点外部丢弃草稿」（AC-8），
  需要额外快照回滚机制，比本地 state 复杂。否决。
- **行内展开（inline expander）代替模态弹层**：模型行在滚动容器内，展开体与
  「点外部关闭」的判定互相干扰（点滚动区即外部），且与面板既有 dialog 模式不一致。否决。
- **context/output 用受控 number 输入（保存时才解析）**：与 AC-6「点保存拦下」
  冲突（应用时就得拦），且丢失「清空」与「未碰」的区分。否决。

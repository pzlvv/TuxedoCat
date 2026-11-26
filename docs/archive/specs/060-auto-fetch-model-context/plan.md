# 实施方案：自动获取模型时尝试取回上下文窗口

技术路线一句话：模型列表的响应体里已经带着上下文窗口，提取做成 `src/shared/utils/modelConfig.ts`
里的纯函数；宿主 `WebviewMessageHandler` 在既有那次 `/models` 请求里顺路提取并随两个回包
下发；面板确认对话框改成两个并列勾选项，勾选时把候选落到草稿的「本次覆盖值」字段上，保存时
经 `normalizeModelTokenLimits` 的合并链写入 `modelConfigs[model].context`。需求见同目录
[spec.md](spec.md)。

## 技术方案

### 1. 提取：纯函数落在叶子层

`src/shared/utils/modelConfig.ts` 新增两个导出：

- `MODEL_CONTEXT_FIELD_PATH`（示意，实际形态见实现）：按优先级排列的字段取值器清单，
  `meta.n_ctx` → `context_length` → `max_model_len` → `max_context_length`。
- `readModelContextFromEntry(entry: unknown): number | null`：单个模型条目的候选提取。合法值
  定义 = 大于 0 的安全整数（`Number.isSafeInteger`），其余一律当作「该字段不存在」继续看下一个。
  取不到返回 `null`（而非 `undefined`）——与本工程的「没有用 `null`」约定一致。

放在 `shared/utils/` 的理由：它是纯函数、被宿主与测试共用；`src/host/` 可以 import 它，
符合分层（[AGENTS.md 第 1 节](../../AGENTS.md)）。

`meta.n_ctx_train` 不参与——spec FR-002 明确排除。

### 2. 宿主：在那一次请求里顺路取

`WebviewMessageHandler.fetchModelsFromProvider` 当前只返回 `string[]`。改为返回

```ts
{ models: string[]; modelContexts: Record<string, number> }
```

`modelContexts` 只收集取到候选的模型（取不到的键不出现），因此「映射为空 = 本次一个都没取到」
可以直接作为对话框置灰的判据（FR-005）。提取发生在既有的 `rawList.map(...)` 里——不新增
HTTP 请求（FR-001）。

`handleFetchProviderModels` 与 `handleDetectProviderModelApiTypes` 各自把 `modelContexts`
塞进对应回包（`providerModelsFetched` / `providerModelsResult`），两次是同一份内容：阶段二
不重新拉模型列表，直接复用阶段一的结果（FR-006）。阶段二的 `detectProviderModelApiTypes`
请求不携带候选，因此宿主侧在阶段二需要重新算一次——由面板把阶段一的候选随阶段二请求回传，
避免宿主在两次消息之间维护状态（宿主无状态，符合「一份事实一个写入点」）。

### 3. wire 契约

`src/host/webviewMessages.ts`：

- `providerModelsFetched` 增加 `modelContexts?: Record<string, number>`
- `providerModelsResult` 增加 `modelContexts?: Record<string, number>`
- `detectProviderModelApiTypes`（webview → host）增加 `modelContexts?: Record<string, number>`

三处都是可选字段。这与铁律 4.2「契约成员全必选」在字面上冲突，但既有 webview wire 消息
（`providerModelsFetched` 的 `models` / `modelApiTypes` / `needDetect` 全是可选）已经是这个
形态：wire 消息载荷是「webview 与宿主之间的松散 JSON」，不是 `UIHost` / `AssistantEventBus`
那类强契约。保持与相邻字段一致，不在此处引入判别联合——否则同一个回包里一半字段必选一半可选，
更难读。这条在「被否决的替代方案」里留痕。

### 4. 面板：两个勾选项 + 覆盖值落到草稿

`ModelDraft` 增加：

```ts
/** 本次自动获取探测到的 context（勾选时写入）；undefined = 本次没有候选 */
contextProbe?: number;
```

`mergeFetchedModels` 改为接受候选映射，对**所有**模型（新增 + 既有）写 `contextProbe`；
既有条目只改这一个字段，`apiType` 保持既有语义（`!existing.apiType && detectedType` 时补）。

对话框状态从「只暂存 needDetect」扩成：

```ts
{
  models: string[];
  modelApiTypes: Record<string, string>;
  needDetect: string[];
  modelContexts: Record<string, number>;
}
```

两个勾选项各自的初始值：`detectApiType = needDetect.length > 0`、`fetchContext =
Object.keys(modelContexts).length > 0`。这满足「默认勾选」且置灰项不会以勾选态呈现。

保存载荷：`buildProvidersPayload` 在收集 `modelLimits` 时，若该模型 `contextProbe` 有值则把它
当作 `context` 的 override 写进 `modelLimits[name].context`——**覆盖语义**由
`normalizeModelTokenLimits` 的合并链承担（见下）。

### 5. 合并链：`normalizeModelTokenLimits` 增一级

当前签名 `(models, existing, apiTypeOverrides, multimodalOverrides, limitOverrides)`。

`limitOverrides` 是「弹层碰过的值」，优先级最高。spec FR-004 要求探测值**高于**弹层手填值，
所以不能复用同一条通道。改为在 `limitOverrides` 之前插入一级：

```ts
probeContexts?: Record<string, number> | null
```

`resolveLimit` 的判定顺序变成：

```
probeContexts[model]（合法正值） > limitOverride === null（弹层清空） > 弹层显式值
  > 已有值 > 注册表
```

注意「弹层清空」在探测值之后：AC-12 要求「弹层清空 + 有候选 → 候选照常写入」。
探测值存在时不看弹层动作，直接用它。

`applyLlmConfigSave` 的新 `modelContexts` 载荷字段（panel → host）透传到下一步；
第 2 段「全表 `modelConfigs` 补齐」不传 `probeContexts`（那次补齐没有本次探测值，纯回落）。

### 6. 对话框 UI

`src/webview/LLMConfigPanel.tsx` 的 `pendingDetection` 遮罩层里，把原有一行说明改成两个
checkbox 行：

- 协议项：置灰条件 `needDetect.length === 0`，附带文案说明数量。
- context 项：置灰条件 `Object.keys(modelContexts).length === 0`，附带文案说明「本次未取到」。

确定按钮按两个勾选组合执行，跳过按钮 / 点遮罩 = 两个都当未勾选。文案走 i18n
（`src/webview/i18n/zh.ts` / `en.ts`），用户可见文本不进代码字面量。

### 7. 面板何时应用候选

用户点确定后：

- 勾了 context：候选已经随阶段一回包进了草稿的 `contextProbe`（`mergeFetchedModels` 时写入），
  此处不需要再做——但**未勾选时必须清掉** `contextProbe`，否则下次保存会误覆盖。实现上用
  「确定时按勾选状态重写草稿的 `contextProbe`」：勾选保留，未勾选 `delete`。
- 勾了协议：发 `detectProviderModelApiTypes`（既有路径）。
- 都不勾：只合并模型列表并按上面清掉 `contextProbe`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/utils/modelConfig.ts` | 新增 `readModelContextFromEntry`；`normalizeModelTokenLimits` 增 `probeContexts` 参数 | 无（shared 叶子层内部导出） |
| `src/host/ui/webviewMessageHandler.ts` | `fetchModelsFromProvider` 返回值扩成名字 + 候选；两个回包塞候选 | 无 |
| `src/host/webviewMessages.ts` | 三个消息各加一个 `modelContexts` 载荷字段；`saveLLMConfig` 的 provider 条目加 `modelContexts` | wire 载荷成员新增（非 `UIHost` / 总线契约） |
| `src/host/llmConfigSave.ts` | 透传 `modelContexts` 到 `normalizeModelTokenLimits` | 无 |
| `src/webview/LLMConfigPanel.tsx` | `ModelDraft.contextProbe`；对话框两个勾选项；保存载荷带上覆写值 | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | 对话框文案 | 无 |
| `e2e/helpers/fakeHost.ts` | 回包带 `modelContexts`；回执记录 | 无 |
| `e2e/webview/settings.spec.ts` | 新增自动获取与两个勾选项用例 | 无 |
| `src/test/modelContextProbe.test.ts` | 新增：提取纯函数单测 | 无 |
| `src/test/hostSettings.test.ts` | 新增：合并链覆盖 / 回落用例 | 无 |
| `docs/architecture/host-ui-modules.md` | 第 3 节两条消息说明 | 文档 delta |
| `docs/architecture/core-ui-separation.md` | 4.3 合并优先级链 | 文档 delta |
| `docs/features/user-stories/sessions-and-llm.md` | US-23 验收标准 3 | 文档 delta |
| `docs/architecture/contracts.md` | 第 5 节无副作用查询条目说明 | 文档 delta |

Core（`core-rs/`）零改动：落盘字段仍是 `modelConfigs[model].context`（非负整数），
`ModelLimits` serde 形态不变。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：提取纯函数放 `src/shared/utils/`（叶子层），宿主
      `src/host/` import 它属于允许方向；未新增 `host.kind` 嗅探、未 import 宿主 API。面板只
      消费 wire 载荷。不涉及 Core。
- [x] 架构铁律（[docs/architecture/principles.md](../../docs/architecture/principles.md)）：不过度 fallback——取不到候选时不写占位值，
      回落链是既有语义；契约成员全必选——本次只动 webview wire 载荷（松散 JSON，与相邻字段
      同口径），`UIHost` / `AssistantEventBus` 零改动；一份事实一个写入点——候选的写入点是
      `normalizeModelTokenLimits`，面板只暂存不改事实；默认值单源——`FALLBACK_MODEL_PARAMS`
      仍是唯一兜底，未新增第二处默认值。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及。Core 侧无改动，
      `modelConfigs` 的落盘格式与 `ModelLimits` 契约不变，无需 `core-rs/` 与 parity 表同步。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：四处 delta 见「受影响模块与契约」末尾；
      实施完成后 `npm run test:unit -- docs-lint` 必须绿。

## 被否决的替代方案

**1. 为 wire 载荷引入判别联合让 `modelContexts` 必选。**
否决理由：`providerModelsFetched` / `providerModelsResult` 的既有字段（`models` /
`modelApiTypes` / `needDetect`）全可选，单独把新字段做成必选会让同一个回包一半必选一半可选；
把整包改成判别联合则要改三处消费方与 PyCharm 的 Kotlin 实现对，收益与成本不成比例。铁律 4.2
的落点是强契约（`UIHost` / `AssistantEventBus`），不覆盖 webview 的松散 JSON。

**2. 用 `/props` 或 `/health` 之类的第二个端点取上下文窗口。**
否决理由：实测该 llama.cpp 服务的 `/props` 与 `/v1/props` 均返回 404，只有 `/v1/models` 带
`meta.n_ctx`；再加一次请求对不支持的服务是纯浪费，且违反 FR-001「不新增请求」。

**3. 把候选直接写进 `limitOverrides`（复用弹层通道）。**
否决理由：`limitOverrides` 的语义是「用户在弹层显式动作」，优先级最高且 `null` 表清空；
探测值要排在它之后（FR-004 的 AC-10 / AC-12），塞进同一条通道无法表达两级优先级。

**4. 宿主在阶段一与阶段二之间缓存候选（避免面板回传）。**
否决理由：宿主缓存等于引入一份「同一事实的第二写入点」，还要处理面板关闭 / 重开的失效；
由面板把阶段一的候选随阶段二请求回传，宿主保持无状态。

**5. 新增独立的 `probeModelContexts` 消息先取后应用。**
否决理由：与 FR-001「不新增请求」冲突；候选本来就在既有响应里。

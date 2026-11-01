---
status: 已修
---

# 缺陷：配置快照把非整数 / 负数限值原样下发，Core 整份快照被拒收、永远不就绪

`resolveSettingsSnapshot`（`src/shared/settingsSnapshot.ts`）是宿主侧唯一的配置规范化入口：
磁盘上的 `settings.json` 经它补默认值、校验白名单，产出的快照随
`UiEvent.hostEnvironmentProvided` 下发 Core。Core 用 `u64` 接收其中三个数值字段
（`core-rs/src/settings.rs` 的 `ModelLimits.context` / `.output` / `.thinkingTokenBudget`
与 `LlmSettings.max_tokens`），serde 对 `u64` 只接受非负整数。

快照解析对这几个字段只校验「是有限数」（`modelConfigs` 的 `context` / `output` 走
`Number.isFinite`，`llm.maxTokens` 只判 `> 0`），于是 `context: -1`、`context: 1.5`、
`maxTokens: 1.5` 都会被原样写进快照。serde 的校验粒度是**整份快照**：一个字段类型不符，
`apply_from_host_environment` 整体失败，Core 只打一条 log、`coreReady` 一次都不发。

后果是整条链路停摆而不是单个模型配置错：宿主侧 `coreReadiness` 一直是未就绪，
`SettingsStore` 的每次重推快照都重复失败，所有会话都按「Core 未就绪」拒绝受理。

## 现状

- `src/shared/settingsSnapshot.ts` 的 `normalizeModelConfigs`：

  ```ts
  if (typeof limits.context === 'number' && Number.isFinite(limits.context)) {
    entry.context = limits.context;
  }
  if (typeof limits.output === 'number' && Number.isFinite(limits.output)) {
    entry.output = limits.output;
  }
  ```

  `Number.isFinite` 同时放行负数与小数。

- 同文件的 `resolveSettingsSnapshot`：

  ```ts
  maxTokens: typeof llm.maxTokens === 'number' && Number.isFinite(llm.maxTokens) && llm.maxTokens > 0
    ? llm.maxTokens
    : FALLBACK_MODEL_PARAMS.maxOutputTokens,
  ```

  `> 0` 挡住 0 与负数，但 `1.5` 照样通过。

- 复现（真实 Core 二进制 `resources/core/x64-linux/<CORE_BINARY_NAME>`，`hello` → 就绪后发
  `hostEnvironmentProvided`，1.5s 后收尾）：

  ```
  context = -1                failed=true  ready=false
    :: hostEnvironmentProvided.settings is invalid: invalid value: integer `-1`, expected u64
  context 1.5                 failed=true  ready=false
    :: hostEnvironmentProvided.settings is invalid: invalid type: floating point `1.5`, expected u64
  maxTokens 1.5               failed=true  ready=false
    :: hostEnvironmentProvided.settings is invalid: invalid type: floating point `1.5`, expected u64
  context = 1000（对照）       failed=false ready=true
  ```

  粘住的是**整份**快照：同一份配置里其它 provider 的合法限值也一起失效。

- 手工编辑 `settings.json` 是受支持的用法（文件是用户可编辑的，快照解析对字段缺失 /
  类型不对一律回落默认值而不是抛错），因此 `context: 12.5` 这种误输入必须落在「回落」
  而不是「让 Core 起不来」。

## 期望

1. **快照里 Core 以 `u64` 接收的字段恒为非负整数**：`provider.modelLimits[*].context` /
   `.output` / `.thinkingTokenBudget` 与 `llm.maxTokens` 都必须满足
   `Number.isInteger(v) && v >= 0`。
2. **非法输入按字段回落，不影响同一份配置的其它字段**：`modelConfigs` 里的非整数 /
   负数按「未配置」处理（回落内置注册表 / 兜底），`llm.maxTokens` 的非法值回落默认值
   （`FALLBACK_MODEL_PARAMS.maxOutputTokens`）。
3. **合法值不受影响**：整数限值与整数 `maxTokens` 原样保留（含 0 的既有行为不变——
   `maxTokens: 0` 当前已被 `> 0` 判为非法并回落，保持不变）。
4. Core 收到上述快照后正常就绪（`coreReady` 发出），不再出现
   `Failed to apply settings snapshot`。

## 不变量

- 快照字段全必选、缺字段按默认值补
  （[docs/architecture/core-ui-separation.md 第 4.3 节](../../docs/architecture/core-ui-separation.md#43-快照字段)）；
  本次只收紧数值取值域，不新增 / 删除字段。
- 模型限值的合并优先级不变：面板显式值 > 已有 `modelConfigs` 值 > 内置注册表 > 兜底
  （[docs/architecture/core-ui-separation.md 第 4.3 节](../../docs/architecture/core-ui-separation.md#43-快照字段)）。
- `apiType` / `multimodal` 的校验口径不变。
- 保存链路（`src/host/llmConfigSave.ts`）的行为不变：它已按「正数或 `null`」过滤
  （`docs/architecture/host-ui-modules.md` 的 `saveLLMConfig` 一行），本次不动。
- Core 侧不做兜底、`u64` 类型不收窄（Core 仍按严格类型拒绝非法快照）。

## 回归测试

- **RT-1**：`modelConfigs` 给负数 `context` / `output` 时，解析结果的对应限值回落注册表兜底
  （`FALLBACK_MODEL_PARAMS`），且快照里全部 `u64` 字段都是非负整数。
  （落点：`src/test/settingsSnapshotContract.test.ts`）
- **RT-2**：`modelConfigs` 给小数 `context` / `output` 时同上（修复前 `context: 1.5` 原样进入快照）。
- **RT-3**：`llm.maxTokens` 为小数 / 负数时回落默认值，快照里 `maxTokens` 是合法 `u64`
  （修复前 `1.5` 原样进入快照）。
- **RT-4**：合法整数限值与 `maxTokens: 8192` 原样保留（防过度收紧）。
- **RT-5**：空配置产出的快照自身全部 `u64` 字段合法（默认值不破契约）。
- **RT-6**：真实 Core 二进制接受修复后的快照并发出 `coreReady`
  （落点：`src/test/standaloneBootstrap.test.ts` 的宿主环境握手用例已覆盖「空快照 + 就绪」，
  本缺陷的取值域用 RT-1～RT-5 的纯函数断言锁定；真实二进制侧在验证记录里留手工实测）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 ~ RT-5（修复前） | `node scripts/run-tests.mjs settings-snapshot-contract` | 红 | 6 项断言失败：RT-1/RT-2 的 `context` 保持 `-1` / `1.5`；RT-3 的 `maxTokens` 保持 `1.5`；三处「u64 字段全部合法」随之失败 |
| 真实 Core 复现（修复前） | `hello` → `hostEnvironmentProvided`（`context: -1` / `1.5` / `maxTokens: 1.5`） | 红 | 三种输入都得到 `Failed to apply settings snapshot`，`coreReady` 未发出；对照组 `context: 1000` 正常就绪 |
| RT-1 ~ RT-5（修复后） | `node scripts/run-tests.mjs settings-snapshot-contract` | 绿 | 9 通过 / 0 失败；非法输入全部回落，合法值与空配置快照通过 |
| 真实 Core 复现（修复后） | 同上，同一组输入 | 绿 | 五种输入（含小数 / 负数 / `maxTokens: 0`）全部 `ready=true`，不再出现 `Failed to apply settings snapshot` |
| 既有回归 | `node scripts/run-tests.mjs settings-snapshot host-settings` | 绿 | 快照解析与设置面板保存链路的既有断言全过 |
| 全量单测 | `npm run test:unit` | 绿 | 100 通过 / 0 失败 |
| 静态检查 | `npm run check-types && npm run lint` | 绿 | 含 webview / electron 三份配置 |

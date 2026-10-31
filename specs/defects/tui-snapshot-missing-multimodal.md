---
status: 已修
---

# 缺陷：TUI 配置快照缺 multimodal，Core 拒收整份快照永不就绪

TUI 宿主的 `hostEnvironmentProvided.settings` 由 `tui-rs/src/settings.rs` 的
`snapshot_to_payload` 组装。该函数产出的 `modelLimits` 条目与 `modelLimitsFallback`
只有 `context` / `output` / `apiType` / `thinkingTokenBudget` 四个字段，缺
`multimodal`（[docs/architecture/core-ui-separation.md 第 4.3 节](../../docs/architecture/core-ui-separation.md#43-快照字段)：快照字段全必选）。
Core 侧的 `ModelLimits.multimodal` 是必选字段（`core-rs/src/settings.rs`，无
`#[serde(default)]`），因此整份快照反序列化失败，`hostEnvironmentProvided` 的处理
只发一条 log 事件、不写快照，`coreReady` 永不回。TUI 按就绪序列推进（
`tui-rs/src/main.rs` 读线程转发 `Ready` 帧后推快照），于是挂在就绪握手：会话列表、
技能、模型菜单等所有依赖 Core 的界面都是空的。

影响面是 TUI 单端：VS Code / Electron 走 `src/shared/settingsSnapshot.ts`，
PyCharm 走 `pycharm-plugin` 的 `SettingsSnapshot.kt`，两者都带该字段。

## 现状

- `tui-rs/src/settings.rs` 的 `ModelLimits` 结构体无 `multimodal` 字段，
  `snapshot_to_payload` 的两个出线点（provider 的 `modelLimits` 条目与
  `llm.modelLimitsFallback`）都不写该键。
- 复现（修复前）：把 TUI 形状的 settings 载荷喂真实 Core 二进制（`stdio` 动作 +
  `hello` 握手），Core 回
  `Failed to apply settings snapshot: hostEnvironmentProvided.settings is invalid: missing field 'multimodal'`，
  全程没有 `coreReady`。
- 单测侧同样红：断言 `modelLimitsFallback` 含 `multimodal` 的用例失败。

## 期望

- `ModelLimits` 带必选 `multimodal: bool`，两个出线点都写该键。
- 取值口径与 `src/shared/settingsSnapshot.ts` 的 `resolveModelLimits` 一致：
  `modelConfigs[model].multimodal` 是布尔就用它，否则用默认值 `true`
  （`DEFAULT_MODEL_MULTIMODAL`）；`modelLimitsFallback` 恒为默认值 `true`。
- `normalize_model_configs` 只保留布尔的 `multimodal` 覆盖，非布尔取值丢弃后回落默认。
- 载荷字段集合与 TS 快照逐项一致，由字段名单对照测试锁定。

## 不变量

- Core 侧契约不变（`core-rs/src/settings.rs` 的 `ModelLimits` 零改动）。
- 其余快照字段（`activeProvider` / `webSearch` / `thinkingEffort` / `model` /
  `maxTokens` / `enableUsageStats` / `providers` / `mcp.enabled` /
  `defaultAgentMode` / `defaultPromptMode`）的取值与形状不变。
- 令牌数仍以整数出线（`token_count`）；既有模型注册表匹配、用户 context/output
  覆盖优先级、`resolve_model_ref` 语义不变。
- TS / Kotlin 两侧实现不变。

## 回归测试

- **RT-1**：TUI 快照载荷必须带 `multimodal`——`modelLimitsFallback` 与每个
  `modelLimits` 条目的字段集合恰为 `{context, output, apiType, thinkingTokenBudget,
  multimodal}`；显式 `false` 生效、非布尔覆盖回落 `true`、只覆盖 `context` 的条目
  也不漏字段（落点：`tui-rs/src/settings_tests.rs` 的
  `snapshot_payload_carries_multimodal`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path tui-rs/Cargo.toml snapshot_payload_carries_multimodal` | 红 | `modelLimitsFallback` 字段集合为 `["apiType", "context", "output", "thinkingTokenBudget"]`，缺 `multimodal` |
| RT-1（修复后） | `cargo test --manifest-path tui-rs/Cargo.toml snapshot_payload_carries_multimodal` | 绿 | 五字段齐全，`off` 条目为 `false` |
| 真 Core 端到端（修复前） | `node /tmp/repro_e2e_payload.mjs <core> <去掉 multimodal 的载荷>` | 红 | Core 日志 `... is invalid: missing field 'multimodal'`，无 `coreReady` |
| 真 Core 端到端（修复后） | `node /tmp/repro_e2e_payload.mjs <core> <TUI 真实产出载荷>` | 绿 | Core 日志 `Standalone Core ready.` + `RESULT: coreReady (accepted)` |
| 既有回归（tui 全套） | `cargo test --manifest-path tui-rs/Cargo.toml` | 绿 | 83/83 |
| core 契约不变 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1049 + 1 全绿，core-rs 零改动 |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 本规格落笔后复跑通过 |

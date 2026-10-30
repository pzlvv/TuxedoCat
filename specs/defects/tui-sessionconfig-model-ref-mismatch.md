---
status: 已修
---

# 缺陷：TUI 解析 sessionConfigChanged 的 model 键读 value，core 发的是 ref

[events.md 第 2.1 节](../../docs/architecture/events.md)的 `sessionConfigChanged` 载荷里，
model 键的身份字段是 `ref`（`{ key: 'model', ref: { model, provider } }`，core 侧
`engine.rs` 的 `on_session_config_changed`）；TS 宿主 `WebViewUI.onSessionConfigChanged`
读的也是 `change.ref`。TUI 的译层（`tui-rs/src/host.rs` 的 `sessionConfigChanged` 分支）
却读 `change.value`——模型变更广播到达时取到 `null`，组装出的 `Action::SetModel`
model 为空串、provider 为 `None`，store 里 `session.model` 被写成 `Some("")`。

后果：TUI 菜单里切换模型后，状态栏的模型名（`app.rs` 取 `session.model`，空串被
过滤后回落 `…`）不显示新模型，直到切换会话重新加载；`submit_message` 的会话覆盖
过滤空串后 model 变 `None`（功能上由 core 的会话状态兜住，LLM 仍用新模型，但
「已到达的事实随消息携带」断了）。thinkingEffort / promptMode / agentMode /
webSearch 四个键 core 发的就是 `value`，不受影响——错位只在 model 一个键。

## 现状

- `core-rs/src/engine.rs`：`sessionConfigChanged` 的 model 键发
  `json!({ "key": "model", "ref": { "model": …, "provider": … } })`。
- `tui-rs/src/host.rs`：`"model" =>` 分支 `change.get("value")` → `Null` →
  `Action::SetModel { model: "", provider: None }`。

## 期望

- TUI 的 model 分支改读 `change.ref`，与 core 载荷及 TS 宿主同口径；空 model 仍按
  非法值落 `…` 兜底（provider 为空即非法的既有守卫不变）。
- core 侧载荷不变（改 TUI 不改契约；`ref` 是词汇表现行定义）。

## 不变量

- `sessionConfigChanged` 其余键（thinkingEffort / promptMode / agentMode / webSearch /
  mcpEnabled）的 TUI 解析不变。
- `Action::SetModel` 的 reducer 语义不变（provider 缺省不覆盖旧值）。

## 回归测试

- **RT-1**：构造 `{ type: 'sessionConfigChanged', change: { key: 'model', ref: { model, provider } } }`
  喂 TUI 译层，断言产生的 `Action::SetModel` 携带该 model / provider（修复前 model 为
  空串）（落点：`tui-rs/src/host.rs` 内嵌测试）。
- **RT-2**：reducer 侧断言 `SetModel` 后会话的 model / provider 与动作一致
  （落点：`tui-rs/src/store.rs` 内嵌测试）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（译层解析，修复后） | `cargo test --manifest-path tui-rs/Cargo.toml session_config_model_reads_ref_field` | 绿 | `ref` 载荷 → `Action::SetModel` 携带 model / provider |
| RT-1（译层解析，修复前） | 同上（临时还原 model 分支读 `value` 后回放） | 红 | `assertion left == right failed: "" != "glm-4.7"`——`value` 缺失，model 解析为空串 |
| RT-2（reducer 写入，修复后） | `cargo test --manifest-path tui-rs/Cargo.toml session_config_and_context_tokens_updates` | 绿 | `SetModel` 后会话 model / provider 与动作一致 |
| 既有回归（tui 全套） | `cargo test --manifest-path tui-rs/Cargo.toml` | 绿 | 81/81 |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 验证记录落笔后复跑通过 |

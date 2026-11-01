---
status: 已修
---

# 缺陷：TUI 重读磁盘后不更新内存快照，编辑 settings.json 只对 Core 生效

TUI 的 `SettingsStore::refresh_from_disk`（`tui-rs/src/settings.rs`）用于
「打开菜单前重读一次磁盘，手工编辑过 `settings.json` 后不必重启」
（[docs/hosts/tui.md 第 5.4 节](../../docs/hosts/tui.md#54-宿主自有事实不问-core)：会话默认值
「重读磁盘，变化则重推快照」）。该函数在
内容变化时解析出新快照并返回它，但**没有把新快照写回 `self.snapshot`**：返回的
`Some(snapshot)` 被调用方丢弃，`self.snapshot` 仍是上一次 `load()` 的结果。

后果：`host.rs` 的 `push_settings_defaults` 只把「有没有变化」当信号重推快照，重推的
内容来自 `self.settings.snapshot()`——仍是编辑前的旧值。于是 Core 拿到旧配置、TUI
界面（`read_context_limit`、模型菜单之外的会话默认值）也按旧值渲染；下一轮
`refresh_from_disk` 又因为 `raw_settings` 已被替换成新内容而返回 `None`，这次编辑在
本进程内**永远不会生效**，直到重启 TUI。

## 现状

- `refresh_from_disk` 的两个「有变化」分支只写 `self.raw_settings`，不写
  `self.snapshot`；只有 `load()` 会设置 `self.snapshot`。
- 复现（修复前）：`load()` 空配置 → 手工把 `activeProvider: "p"` 写进
  `settings.json` → `refresh_from_disk()` 返回 `Some`（`active_provider == "p"`），
  但随后 `store.snapshot().active_provider` 仍为 `""`。

## 期望

- `refresh_from_disk` 报告变化时，同时以新解析结果替换 `self.snapshot`；返回的快照
  与 `snapshot()` 读到的是同一份。
- 「内容没变」与「读不出来」两个分支保持现状：返回 `None` 且不动现有快照。
- 配置被清空（文件里是 `{}`）时按新内容回落——不保留上一位 provider。

## 不变量

- 读不出来的文件保持现有快照（不能把「读失败」当「配置被清空」）；写入侧的
  「读不出拒绝写」三层保护不变。
- `update_settings` 的读-改-写 + 锁 + 原子落盘 + 内容未变不落盘语义不变。
- `raw_settings` 用于模型菜单（`push_models` 读原始 `providers`），其内容口径不变。
- `load()` 的行为不变。

## 回归测试

- **RT-1**：手工把 `activeProvider: "p"` 写进 `settings.json` 后
  `refresh_from_disk()` 返回新快照，且 `store.snapshot()` 立即读到 `p`（含
  `active_model_ref`）；随后写 `{}` 时快照回落；写入坏 JSON 时保持现有快照并返回
  `None`（落点：`tui-rs/src/settings_tests.rs` 的
  `refresh_from_disk_replaces_stored_snapshot`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path tui-rs/Cargo.toml refresh_from_disk_replaces_stored_snapshot` | 红 | `left: "" / right: "p"`——`refresh_from_disk` 返回了新快照，`store.snapshot()` 仍是旧的 |
| RT-1（修复后） | `cargo test --manifest-path tui-rs/Cargo.toml refresh_from_disk_replaces_stored_snapshot` | 绿 | 替换 / 清空回落 / 读不出保持三态都对 |
| 既有回归（tui 全套） | `cargo test --manifest-path tui-rs/Cargo.toml` | 绿 | 83/83，含既有的 `store_load_write_and_guards`（内容未变返回 `None`） |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 本规格落笔后复跑通过 |

---
status: 已修
---

# 缺陷：手动压缩写入口未接会话独占锁守卫，纯读的归档展开被误接变更租约

specs/032 会话独占锁（已归档，delta 并入
[US-66 验收 2](../../docs/features/user-stories/sessions-and-llm.md#us-66-会话跨实例独占)）要求
**手动压缩**作为变更入口接会话锁守卫。as-built 事件词汇表（
[events.md 第 2.2 节](../../docs/architecture/events.md)）明确手动压缩入口是
`compactRequested`（UiEvent → `Core::request_compact`，改写会话 JSONL 与压缩归档）；
实现却把变更租约接在了 `compactArchiveRequested`（展开压缩归档的**纯读**请求）上，
真正的写入口 `request_compact` 无任何锁守卫。根因是归档 spec 原稿的入口名笔误
（把手动压缩标成了 `compactArchiveRequested`），实现照笔误落码。
实际风险低（压缩按钮只在打开视图时可达，彼时本 Core 已持注册表锁），但语义错位：
纯读拿变更租约、真写入口裸奔，与 FR-002「一切变更类入口一律拒绝、纯读不受限」相悖。

## 现状

- `core-rs/src/main.rs` 的 `compactArchiveRequested` 分支：`begin_mutation` 取变更租约后
  才读归档——会话被其他实例持有时该**纯读**被拒（`Err` + 占用通知）。
- `core-rs/src/engine.rs` 的 `request_compact`（`compactRequested` 的处理体）：从
  `session_if_exists` / 可压缩判定到 `compact_and_apply_messages` 全程无会话锁——
  会话被其他实例持有时压缩照常执行、改写 JSONL 与归档。
- 复现路径：沙箱内持目标会话的裸句柄（模拟另一实例），调用
  `core.request_compact(sid)`——压缩照常执行（RT-1）；发
  `compactArchiveRequested`——被拒（RT-2）。

## 期望

- `request_compact` 与 rename / config 等变更入口同款守卫：注册表命中放行；未装载取
  短持有租约（压缩期间该会话对其他实例不可装载，结束即释放）；被其他实例持有时拒绝
  （发 `notice.session.lockedChange`，数据零改动）；目录解析不出的 Io 失败不发占用通知
  （对齐既有变更入口的口径，specs/032 收敛记录的偏差修复）。
- `compactArchiveRequested` 是纯读，不再取变更租约：会话被持有时照常返回归档展示。

## 不变量

- 既有手动压缩语义不变：无可压缩消息跳过、压缩中去重、非 idle 登记 `pendingCompact`
  排队、压缩完成 `resume_after_compact`（docs/features/compaction.md）。
- 会话锁其余行为不变：同 Core 重入、`drop_session` 释放、版本拒外、Io 与占用区分
  （只有 Held / 版本拒外发占用通知）。
- `compactArchiveRequested` 的响应载荷与 `clear_unread_completions` 等既有旁路不变。
- 已装载会话（本 Core 持注册表锁）上手动压缩照常工作（守卫的 Registered 放行路径）。

## 回归测试

- **RT-1**：会话被其他实例持有时 `request_compact` 拒绝——持裸句柄后调用，
  断言不产生 `compactBegin`、JSONL 字节不变、发 `notice.session.lockedChange`；
  未持有时压缩照常（Registered / 短持有放行路径不回归）（落点：
  `core-rs/src/session_lock_tests.rs` 的 `manual_compact_rejected_when_held_elsewhere`）
- **RT-2**：会话被其他实例持有时 `compactArchiveRequested`（纯读）照常返回——
  持裸句柄后 `dispatch_ui_request` 该请求，断言 `Ok` 且返回归档消息序列（落点：
  `core-rs/src/session_lock_tests.rs` 的 `compact_archive_read_works_when_held`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --bin standalone-core when_held -- --test-threads=1` | 红 | RT-1：「被持会话不得进入压缩流程，实际事件：[compactBegin, compactEnd, messagesReplaced]」（压缩全流程跑完）；RT-2：「纯读不受限……实际 Err("session is locked by another instance")」 |
| 回归用例（修复后） | 同上 | 绿 | RT-1 / RT-2 绿；`session_lock` 套件 17/17 |
| 既有回归（rust 全套） | `cargo test --bin standalone-core tests:: -- --test-threads=1` | 绿 | 1026 过；唯一失败 `abort_clears_pending_compact` 在本机 Windows ARM64 于基线（stash 对照）即失败、与本缺陷无关，CI Linux 为准 |
| 既有 dispatch 用例（随修复改版） | 同上 | 绿 | `session_lock_rejects_mutating_and_loading_requests` 的拒绝清单移出纯读 `compactArchiveRequested`、占用通知计数 4 → 3（先例：PR #3 的「锁旧语义既有用例随修复改版」） |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | — |
| check-types / lint | `npm run check-types && npm run lint` | 绿 | 纯 Rust 改动，TS 侧无涉，跑一遍确认 |

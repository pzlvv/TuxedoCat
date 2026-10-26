---
status: 已修
---

# 缺陷：Bash 流式进度的 total_bytes 会回跳（stdout / stderr 共用快照、锁外发射）

Bash 工具的 stdout / stderr 两条读管道共用一份按到达顺序拼接的输出快照（`full`），
进度回调却在**锁外**发射：两个管道的读取线程并发时，后发射的回调可能携带比自己更旧
的快照——`toolProgress` 事件的 `totalBytes` 随事件顺序**回跳**（UI 进度倒退；最后一条
事件若是旧快照，卡片停在少算的规模上）。断言「累计规模 ≥ 增量之和」的对照用例在
ubuntu 上两次内必现（smoke 车道实证）；Windows 是调度运气。

## 现状

- `core-rs/src/tools.rs` 的 `read_pipe`：锁内追加 + 取快照，锁外发 `BashProgress`
  （`total_bytes: utf16_len(snapshot)`）。
- 两线程交错时：A 读 6 字节（快照 6）→ B 读 7 字节（快照 13）→ B 先发（total=13）、
  A 后发（total=6）——事件流 total 回跳。
- 实证：PR #1 smoke run 40377964864（ubuntu），
  `tools::tests::bash_reports_streaming_progress` FAILED
  （`last.total_bytes >= joined.chars().count()` 断言失败——last 是旧快照）。

## 期望

- `toolProgress` 的事件顺序与快照时序一致：`total_bytes` 单调不减（进度不倒退）。
- 发射仍受 `stop` 门控：中止 / 超时后不再上报（既有回归
  `specs/defects/bash-abort-does-not-kill-process-tree.md` 保持）。

## 不变量

- 事件载荷字段与语义不变（增量 `output`、`full_output` 预览、`total_lines` /
  `total_bytes` 的 UTF-16 口径、`timeout_ms`）。
- 快照的拼接顺序（按到达顺序）与最终结果的 stdout / stderr 分离拼接不变。
- 中止 / 超时的收尾行为不变。

## 回归测试

- **RT-1**：`tools::tests::bash_reports_streaming_progress`（stdout + stderr 双流命令，
  断言最后一条事件的累计规模 ≥ 增量拼接规模）——现状红（CI 实证），修复后单调。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，Linux） | PR #1 smoke run 40377964864 | 红 | `bash_reports_streaming_progress` FAILED：last.total_bytes < 增量 chars 之和 |
| 回归用例（修复后，win32 本机） | `cargo test --bin standalone-core tools::` | 绿 | tools 全部用例通过（含流式进度、4KB 预览上限、后台转档） |
| 回归用例（修复后，Linux） | 随本修复所在 PR 的 smoke 重跑 | not-run | 本机无 Linux；由 CI 的 ubuntu 车道验证，结果见 PR #1 的后续 smoke run |
| 既有回归 | `cargo test --bin standalone-core` | 绿 | 981 项全通过（含中止不杀进程树的既有回归） |

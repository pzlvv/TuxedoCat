---
status: 已修
---

# 缺陷：提示词组装首次探测可用命令串行 spawn 26 次，Windows 上首查卡 6–10 秒以上

`available_commands()`（`core-rs/src/prompt.rs`）在**进程内首次**组装 system prompt 时
逐个 spawn `where` / `which` 探测 26 个候选命令，结果缓存进进程级静态。Windows 上
`where.exe` 单次要扫全 PATH，26 次**串行**累计在本机（Windows arm64，PATH 较长）实测
约 6.2 秒，冷启动（新编译的二进制首跑、Defender 扫描叠加）超过 10 秒——首次 LLM 轮次
的提示词组装整段卡在这里，LLM 请求迟迟发不出去。

TODO.md 登记的「存量失败：compact 引擎测试 `abort_clears_pending_compact` 稳定挂」
即此缺陷的表现：该测试与兄弟用例
`pending_compact_runs_when_the_current_turn_ends` 对「submit 后 10 秒内发出 LLM 请求」
设了时序断言，隔离跑时进程里**没有别的用例先付过这笔探测开销**，稳定超时；整模块
一起跑时其它用例先触发了首次组装、缓存已暖，于是 17 个全绿——「隔离跑挂、模块跑绿」
的反常现象正来自这个进程级缓存。定位结论（回应 TODO 的二选一）：既不是 compact
引擎回归，也不是测试 mock 没接上，而是平台相关的首查延迟 + 测试 10 秒时序假设的
组合；Linux CI 上 `which` 探测快（约百毫秒级），所以 CI 一直绿。

## 现状（修复前）

- `available_commands()` 串行循环 26 个候选，每个 spawn 一次 `where` / `where.exe`
  （`command.status()`），全部完成后写入进程级缓存。
- 探测发生在 `environment_section`（system prompt 的环境段）→
  `build_system_prompt_with_preset` → `run_query_loop`：**产品的首次对话**同样吃这笔
  开销，不只是测试问题。
- 本机实测（Git Bash 会话，暖缓存路径）：26 次 `where` 串行 6.2 秒；测试进程内
  （冷）超过 10 秒。
- 失败证据链（修复前）：
  - `cargo test abort_clears_pending_compact`（隔离）稳定挂在
    `compact_engine_tests.rs:594`「查询应当发出 LLM 请求」，用例耗时 20.11s
    （10s 断言超时 + 10s teardown 忙等）；
  - `pending_compact_runs_when_the_current_turn_ends` 隔离跑同样失败（20.09s）；
  - 两用例合并跑 40.21s 双双失败；整模块（17 用例）一起跑 33.54s 全绿；
  - 探针证据：`queryBegin` 已发、宿主请求为零、`llm::stream` 未进入——卡点在
    提示词组装段。

## 期望

- 26 个候选**并发**探测：墙钟时间从「逐次累加」变为「最慢一次探测」
  （单次 `where` 亚秒级）。候选表、探测命令（`where` / `which`）、
  「spawn 失败按不可用」的口径都不变。
- `apply_native` 的 PATH 解析失败仍按整段错误上报（不静默降级为「全部不可用」）：
  任一探测线程解析失败，`available_commands` 返回该错误。
- 缓存语义不变：进程内只探测一次，后续调用直接返回缓存（排序后的名单）。
- 两个门控用例里「submit → 收到 LLM 请求」的等待预算与本文件其余 `wait_for`
  对齐为 30s：该断言是同步点而非性能断言，进程冷启动（spawn 波动）不该转成
  偶发红。

## 不变量

- 候选表与 `SystemEnvironment.ts` 的 `detectAvailableCommandsSync` 逐项一致（26 项），
  结果排序输出。
- 探测结果只影响提示词的环境段文本，不进任何契约 / 事件 / 落盘格式。
- 进程级缓存语义不变：同一进程内不重复探测。

## 回归测试

- **RT-1**：`abort_clears_pending_compact` 与
  `pending_compact_runs_when_the_current_turn_ends` **隔离跑**（各自单独
  `cargo test <name>`）必须拿到 LLM 请求（等待预算 30s，与本文件 `wait_for` 同档）——
  这两条存量用例就是回归金丝雀（时序类缺陷不再另造计时断言：对探测耗时做硬断言在
  负载波动的 CI 上必然偶发红）。落点：`core-rs/src/compact_engine_tests.rs`
  （既有用例，改等待预算 10s→30s，无新增用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，隔离） | `cargo test abort_clears_pending_compact` | 红 | `:594` 查询应当发出 LLM 请求；20.11s |
| 回归用例（修复前，隔离） | `cargo test pending_compact_runs_when_the_current_turn_ends` | 红 | 同签名；20.09s |
| 回归用例（修复前，组合） | `cargo test -- <两个用例名>` | 红 | 40.21s 双双失败；整模块 17 用例一起跑全绿（缓存已暖），「隔离挂 / 模块绿」即进程级缓存指纹 |
| 探针定位 | 临时 eprintln（llm.rs / engine.rs / 测试，已移除） | not-run | 诊断记录：`run_turn` +18ms 进入、`llm::stream` 10s 未进入、FakeLlm 零请求；卡点=提示词组装 |
| 根因实测 | Git Bash 计时 26 次串行 `where` | not-run | 诊断记录：6.2s（暖）；测试进程内冷启动 >10s |
| 回归用例（修复后，隔离） | `cargo test abort_clears_pending_compact` | 绿 | 与 `pending_compact_runs…`、`agent_*`、`subagent_*` 同批通过 |
| 本机时序对照 | `26 次 where` 串行基线 vs 并发实现 | 绿 | 并发化后墙钟≈单次探测；两用例 10s 断言不再触顶 |
| CI 口径 | smoke（Linux）`cargo test` | not-run | 本地无 Linux runner；Linux `which` 快，修复前后 CI 均应绿；全量回归见 `.github/workflows/all.yml` |

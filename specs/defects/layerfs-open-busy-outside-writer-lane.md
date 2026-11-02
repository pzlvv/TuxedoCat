---
status: 已修
---

# 缺陷：并发打开同一 Store 在连接建立期报 Busy，绕开写者车道

两个进程在同一时刻打开同一个已有 Store 时，后到的那个会在**连接建立阶段**拿到
`Busy`，而不是按 specs/043 FR-007 / AC-12 的「在线道里排队等待」。写者车道只包住
`Session::run`（写事务），`Session::connect` 的 PRAGMA 序列在车道之外，而
`busy_timeout` 被 profile 钉死为 0，所以这条路径一旦撞锁就是一次精确失败、无等待。

影响面：任何「多个进程（Core 实例、CLI、测试并行）同时打开同一 Store」的场景。PR 29
的 CI `tests` job 就是被它打红的——`two_processes_write_concurrently` 里两个子进程
并发 `open_writable`，其中一个在 `store_tests.rs` 的 `Handles::open_writable` 上
panic「open: Busy」。

## 现状

1. `Session::connect`（`core-rs/layerfs-sqlite/src/connection.rs`）先
   `Connection::open_with_flags`，再 `busy_timeout(ZERO)`，随后 `profile::apply` 逐条
   设 PRAGMA（`profile.rs`）。这条序列**不进** `Writer::acquire`
   （`writer_lock.rs` 的父目录 flock 只在 `Session::run` 的写事务里取）。
2. 打开已有热 WAL 的库时，SQLite 要在第一条语句上做 WAL 索引恢复，期间持有独占的
   `-shm` 锁；`PRAGMA synchronous` 的 prepare 因此可能返回 `SQLITE_BUSY`。`map`
   （`error.rs`）把它翻成 `BackendError::Busy` → `PersistenceError::Busy`，直接上抛。
3. 实测：父目录 flock 被另一进程持有时，`open_writable` / `open_read_only` 都在
   1ms 内成功返回——证明打开期完全不受写者车道约束。
4. 实测复现（Linux，16 核，release 构建，每轮先由子进程写 600 个对象留下热 WAL）：

   | 并发形态 | 轮数 | 得到 Busy 的次数 |
   | --- | --- | --- |
   | 8 个 `open_writable` | 80 | 14 |
   | 4 个 `open_read_only` | 80 | 1 |
   | 6 个 `open_writable`（新建库、无热 WAL） | 60 | 1–3 |
   | 8 个 `open_writable` + 打开前取父目录 flock | 80 | 0 |

   最后一行是实验性对照：在同一压测装置里把打开包进父目录 flock 后失败归零，确认
   根因是「打开期不在车道上」，而不是 SQLite 配置或文件系统问题。
5. CI 侧的同一现象：`gh run view --job 125225219250`，失败栈
   `store_tests.rs:200` → `Handles::open_writable` → `open: Busy`。

## 期望

1. 连接建立阶段的 PRAGMA 序列与 schema 校验**进入与写事务相同的跨进程车道**
   （Linux 父目录独占 flock）：同一时刻只有一个进程在建立连接，后到者排队等待，不用
   `Busy` 拒绝。
2. 只读会话的连接建立同样进车道：WAL 恢复期间它也要拿 `-shm` 独占锁，而按 FR-007，
   读者不应被别人的连接建立撞成 `Busy`。
3. 排队语义与既有一致：等待无时限；无时限等待的类型化出口只有 `Closed`（会话已
   `close`）与 `Cancelled`（信号打断，仅 Linux）。
4. `busy_timeout` 保持 0、无 busy handler：车道的存在是为了让等待发生在 SQL 之前，
   不是为了引入重试循环。进了车道之后的 SQL 失败仍是一次尝试、精确 `Busy`、不重试。
5. 车道持有范围仍然很短：连接建立完成即释放 flock，不跨 `Handles` 的生命周期；两个
   进程「先各自 open、再各自写」的场景与现在一致（`two_processes_write_concurrently`
   的后半段就是这种形态）。

## 不变量

- `PersistenceConfig` / `SqlitePersistenceProfile` / PRAGMA 清单与打开期逐项校验（不符
  拒开）逐字不变；profile 身份串仍是 `sqlite-wal-off-v2`。
- schema v1 精确校验与「高 / 低版本一律拒开、不迁移」不变。
- 「一次尝试、绝不重试、不重放」不变：不引入 busy handler、不循环重试 `BEGIN`。
- `Handles::create` 的拒绝语义不变：已存在路径仍走 `create_new` 被拒，不覆盖。
- 非 Linux 平台的行为不变：没有跨进程写车道，并发写者仍得精确 `Busy`（FR-008，
  `two_processes_write_concurrently` 的 `Busy` 分支断言不变）。
- 写事务的锁持有范围不变：仍是单个原子事务，不跨整个 `Save` / 构造 / 发布序列。

## 回归测试

- **RT-1**：同一 Store 上 N 个并发子进程各自 `open_writable`，Linux 下全部成功（一个
  都不许得 `Busy`）；非 Linux 保持现行 `Busy` 分支断言。（落点：
  `core-rs/layerfs-sqlite/src/store_tests.rs` 的
  `concurrent_open_writers_queue_instead_of_busy`）
- **RT-2**：父目录写车道被另一进程持有时，`open_writable` 排队等待而不是立刻返回：
  计时断言「等待到释放之后才成功」。（落点：同文件的
  `open_writable_waits_for_writer_lane_in_another_process`）
- **RT-3**：只读会话在并发打开下同样不报 `Busy`（读者不受连接建立期 WAL 恢复影响）。
  （落点：同文件的 `concurrent_open_readers_queue_instead_of_busy`）
- **RT-4**：既有语义不回退——`two_processes_write_concurrently` /
  `writer_in_another_process_queues_or_reports_busy` / `seal_*` / `schema_*` 全绿。

## 修复

连接建立与打开期校验整体进写者车道：`Handles::open` / `open_writable` /
`open_read_only` 在 `Session::connect` 之前取父目录独占 `flock`，`connect` 与随后的
`validate` 都跑在同一个 `Writer` 持有期内，两步之间不松开。`Handles::create` 不走这条
路径——`create_new` 刚建出的文件没有别的进程会恢复它的 WAL，而 `initialize` 的写事务
本身要取一次车道，外层再包一层会自锁（`flock` 按打开文件描述归属，同进程两个 fd 对同一
inode 也互相阻塞）。

车道持有范围只到「连接建立 + 校验」完成，不跨 `Handles` 的生命周期；`busy_timeout`
保持 0，没有引入 busy handler 或重试循环。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test -p layerfs-sqlite open_` | 红 | `open_writable_waits_for_writer_lane_in_another_process`：`open did not wait for the lane: 5.411995ms`（车道被另一进程持有时打开仍立即成功）；`concurrent_open_writers_queue_instead_of_busy`：`round 6: BUSY object persistence: Busy` |
| 回归用例（修复后） | `cd core-rs && cargo test -p layerfs-sqlite` | 绿 | 29 passed（含三个新增 RT 用例） |
| 既有回归 | `cd core-rs && cargo test --workspace` | 绿 | 1145 passed / 0 failed（layerfs 37 + layerfs-sqlite 29 + standalone-core 1078 + 1） |
| CI 场景对照（修复前） | 6 进程并发 open 后各写 600 对象，50 轮 × 6 次 | 红 | 300 次打开里 3 次 `Busy` |
| CI 场景对照（修复后） | 同上 | 绿 | 600 次打开零失败（warm WAL 与新建库两种形态各 300 次） |
| `npm run test:unit -- docs-lint` | `npm run test:unit -- docs-lint` | 绿 | 章节引用、缺陷规格闸门、`docs/README.md` 地图均绿（6 通过 / 0 失败） |

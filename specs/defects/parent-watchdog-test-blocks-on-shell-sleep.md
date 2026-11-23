---
status: 已修
---

# 缺陷：父进程看门狗用例阻塞在中间 shell 上，90 秒墙钟且没验证它声称的时序

`core-rs/tests/parent_watchdog.rs` 的 `core_exits_when_parent_process_disappears`
是用例级的孤儿回归（对应缺陷 `orphan-core-processes-after-host-exit.md`）。它的时序
断言要求「先等 Core 武装看门狗、再杀掉**活着的**父进程」，但实现用
`Command::status()` 起中间 shell，而 shell 末尾是 `sleep 90`——`status()` 阻塞到
shell 退出，于是：

1. 用例墙钟固定 90 秒（CI 实测 `tests/parent_watchdog.rs` 90.11s，占
   `npm run test:core` 的 27%）；
2. `status()` 返回时父 shell 已经自己跑完 `sleep 90` 正常退出，随后那句
   `kill(parent_pid)` 杀的是一个**已经死亡的 pid**（甚至可能已被复用）。用例实际
   验证的是「父进程自然到期 → 看门狗开火」，而它注释里写的是「父进程被强杀 → 看门狗
   开火」——两者对看门狗是同一段代码路径，但用例声称的覆盖与它实际构造的竞态不一致，
   且「杀活进程」这条前提没有任何断言看着。

## 现状

- `core-rs/tests/parent_watchdog.rs` 用
  `Command::new("sh").arg("-c").arg("... ; sleep 90").status()` 起中间 shell。
  `status()` 语义是「等子进程退出并回收」，因此调用点之后的全部断言都在 shell 到期
  之后才执行。
- `kill(parent_pid)` 的 `parent_pid` 取自 shell 自己写出的 `$$`。到 `status()` 返回时
  该 pid 已退出，`kill -9` 对它无效果；Linux 上还可能在 pid 被复用后误杀无关进程。
- 用例里没有任何断言检查「父进程在 Core 武装之后仍然活着」——真要验证「强杀活父进程」
  就必须有这条断言，否则实现退化回「等父进程自然退出」也不会被发现。
- `sleep 90` 的 90 秒没有别的用途：注释说明它只是「让父进程活过 Core 启动与武装」，
  而杀死时机本来就由「已武装」诊断决定，不需要时钟兜底。

## 期望

- 用例不再阻塞在中间 shell 上：`spawn()` 拿到句柄即继续，父进程活多久由测试显式
  杀死决定。
- 父进程必须真的活着被杀死，且这一点由断言钉住：shell 的退出状态必须是「被信号
  终止」而不是 `exit 0`——后者正是「等自然到期」退化的特征。
- 任何提前失败（等 pid 文件超时、等「已武装」超时）都必须回收中间 shell，不能在
  runner 上留下睡眠进程。
- 用例墙钟从 90 秒降到秒级，且覆盖语义与注释一致。

## 不变量

1. 「先武装、后失父」的顺序由观察保证：只在 `watchdog armed on parent` 出现之后杀父
   进程，不靠固定时钟赌启动耗时（满载下 Core 启动可慢于任何固定时钟）。
2. 断言仍然验证「Core 在父进程消失后自行退出」，以及看门狗开火诊断存在。
3. 用例失败不留下残留进程：中间 shell 在成功与失败路径上都被 kill + `wait`。
4. `tests/parent_watchdog.rs` 仍是 `#![cfg(unix)]` 的进程级集成测试，不并入单测车道。

## 回归测试

- **RT-1**：中间 shell 以 `spawn()` 起，Core 武装看门狗后测试杀掉**活着的**父进程，
  Core 必须在 15 秒内自行退出。判据除「Core 退出」外还要有「父 shell 的退出状态不是
  `success()`」——它证明杀的是活进程，实现退化回「等 sleep 自然到期」时这条先红。
  （落点：`core-rs/tests/parent_watchdog.rs`「core_exits_when_parent_process_disappears」）
- **RT-2**：提前失败路径不留残留进程。等 pid 文件 / 等「已武装」诊断的超时都可能
  panic，`ShellGuard` 的 `Drop` 必须在栈展开时杀掉并 `wait` 中间 shell。
  （落点：同上，`ShellGuard` 的 `Drop` 实现）
- **RT-3**：用例墙钟不再固定 90 秒——该文件单独跑（`cargo test --test parent_watchdog`）
  在秒级完成。这条同时是「实现退化」的探针：墙钟回到 90 秒即说明 `status()` 语义回来了。
  （落点：同上；CI 的 `test:core` 步骤耗时里直接可见）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --test parent_watchdog` | 红 | 逻辑上必然失败于 RT-1 的活进程断言（旧实现根本没有这条断言，且墙钟固定 90s／CI 实测 90.11s） |
| 回归用例（修复前，CI 基线） | 见 `.github/workflows/smoke.yml` 的 tests job 日志 run `45112019661` | 红 | `test result: ok. 1 passed ... finished in 90.11s`——通过但墙钟 90 秒，正是本缺陷 |
| Core 编译检查（修复后） | `cargo check --manifest-path core-rs/Cargo.toml --all-targets`（注入 zig 的 CC / CFLAGS） | 绿 | 无 error；`ShellGuard` 与 `.spawn()` 改动类型正确 |
| Rust 格式基线（修复后） | `npm run fmt:rust:check` | 绿 | 四个 crate 的 `cargo fmt --check` 全过 |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml --test parent_watchdog` | not-run | 本机 `core-rs/target/debug/deps/standalone_core-*.exe` 被正在运行的 Core 占用，链接失败（LNK1104）；改由 CI 的 ubuntu `tests` job 验证 |

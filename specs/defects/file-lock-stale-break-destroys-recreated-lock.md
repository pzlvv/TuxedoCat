---
status: 已修
---

# 缺陷：fileLock 陈旧锁抢占在「锁已消失」时误删并发重建的新锁，造成双持有

`src/shared/utils/fileLock.ts` 的陈旧锁抢占把「锁文件已消失」与「锁文件陈旧可删」两种判定混为同一个布尔，且两种判定都通向 `unlinkSync`。当持有者恰好在等待者的「EEXIST → 陈旧判定」间隙完成「释放 → 重建」时，等待者的 unlink 删掉的是**重建的新锁**，随后等待者 create 成功——同一时刻两个进程都认为自己持有锁。后果是共享文件原子写的临时文件被双方同时操作：后 `rename` 的一方拿到 `ENOENT`（写进程异常退出），常写盘场景下则是并发读-改-写交错、丢失更新。`settings.json` 是多个宿主进程共写的用户配置文件，丢的是用户数据。

## 现状

`tryCreateLock`（`src/shared/utils/fileLock.ts` 第 91–112 行）在 `openSync('wx')` 收到 `EEXIST` 后调用 `isLockStale`，返回 true 即无条件 `unlinkSync(lockPath)` 再重试 create。而 `isLockStale`（第 54–72 行）返回 true 有两种语义：

1. 锁文件**存在**且陈旧（持有者 pid 已死，或 mtime 超过 `LOCK_STALE_MS`）——可以删；
2. `statSync` 抛 `ENOENT`，**锁文件根本不存在**（注释写明「锁已不存在，可立即重试」）——此时路径上没有任何东西可删，但代码仍执行 `unlinkSync`。

「不存在」与「陈旧可删」混同后，第 2 种语义的 true 会授权一次盲删。真实交错（WSL 插桩时间线，两个进程的事件按同一单调时钟对齐）：

```
等待者 W: openSync('wx') → EEXIST        （持有者 H 的锁 #1 在场）
持有者 H: unlinkSync（释放锁 #1）
等待者 W: statSync → ENOENT → isLockStale 返回 true（语义 2）
持有者 H: openSync('wx') 成功（重建锁 #2），进入临界区
等待者 W: unlinkSync → 删掉的是 H 的锁 #2
等待者 W: openSync('wx') 成功 → W、H 双持有
```

双持有后双方同时走 `writeFileAtomic` 写同一个 `.tmp` 再 rename：一方 rename 成功把 tmp 搬走，另一方 rename 报 `ENOENT`、写进程以非零码退出；数据是否丢失取决于两把锁下的写入是否都落在被搬走的同一份 tmp 上。

复现证据：

- CI：all 运行 40901761608（Actions，分支 fix/restart-tab-lights）的 smoke/tests，`settingsConcurrency` 失败——一个 worker 打出 `Error: ENOENT: no such file or directory, rename '<tmp>/settings.json.tmp' -> '<tmp>/settings.json'`，断言「全部子进程正常退出」失败（12 通过 / 1 失败）。同一提交的 PR smoke（40901106038）为绿，偶发。
- WSL2 本地（Linux，tmpfs `/tmp`）：仓库自带 `settingsConcurrency.test.ts` 首跑即复现，且除 ENOENT 外出现**丢失更新**（「全部 6 个进程的改动都在」失败，`丢失的改动：w0`）；将「内容未变不落盘」改为常写盘的插桩变体 5 轮坏 2 轮（150 次自增只落 101 / 139），插桩事件日志完整记录了上述 unlink 误删序列。

## 期望

1. **「锁文件不存在」不得触发对锁路径的任何 unlink**：陈旧判定来自 `statSync` ENOENT 时，唯一正确动作是放弃本轮（返回 false），由调用方按正常节奏重试 `openSync('wx')`——路径上若已有新锁，O_EXCL 会公平地拒绝。
2. **unlink 只允许发生在「确认路径上存在一把陈旧锁」之后**：删除的授权来自对现存文件的陈旧判定，而不是来自文件不在场的判定。
3. 互斥恢复：在测试可达的调度下（现有 `settingsConcurrency` 的 6 进程 × 25 次读-改-写，以及其常写盘变体），不再出现双持有——不再有 worker 因 `.tmp` 竞争非零退出，并发写入不丢失更新。

## 不变量

- **互斥**：同一时刻至多一个协作进程处于锁内临界区；并发读-改-写不丢更新（[docs/architecture/core-ui-separation.md 第 4.6 节](docs/architecture/core-ui-separation.md#46-写盘规则)）。
- **陈旧锁抢占语义保留**：持有者崩溃（pid 已死 / mtime 过旧）留下的锁仍可被后续等待者清除并接管，不能因本次修复让崩溃残留的锁永久卡死。
- **获取失败仍抛错**：`withFileLock` 预算耗尽时抛 `failed to acquire file lock`，不静默降级；`acquireLockSync` 拿不到时返回 false，调用方放弃写入。
- **锁文件格式与释放幂等**：内容仍为 `pid + 时间戳`；`releaseLockSync` 幂等（锁已被抢清时不报错）。
- **写入原子性与「读不出来拒绝写」不变**（`writeFileAtomic`、`SettingsStore.updateSettings` 的既有行为不动）。

## 回归测试

- **RT-1**：确定性单测——脚本化 fs 一次性注入「`openSync('wx')` 对锁路径报 `EEXIST` → `statSync` 对锁路径抛 `ENOENT`」的交错，磁盘上预先放一把「新持有者」的活锁（内容为本进程 pid，存活、mtime 新鲜）；断言 `withFileLock` 以 `failed to acquire file lock` 拒绝获取，且新持有者的锁文件原样存在、内容未被改写。修复前两个断言双红（withFileLock 偷锁成功 + 新锁被删）。（落点：`src/test/fileLock.test.ts`）
- **RT-2**：既有集成回归 `settingsConcurrency`（6 子进程 × 25 次读-改-写共写 `settings.json`）继续作为端到端守护：修复前 CI 偶发红（run 40901761608）、WSL 本地复现红；修复后连续多轮绿。（落点：`src/test/settingsConcurrency.test.ts`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- fileLock` | 红 | RT-1 三断言全红：withFileLock 未拒绝反而偷锁成功（resolved）；「并发重建的新锁未被 unlink」失败；「新锁内容未被改写」随之失败 |
| 回归用例（修复后） | `npm run test:unit -- fileLock` | 绿 | withFileLock 以 `failed to acquire file lock` 拒绝，新锁原样保留 |
| 既有回归（RT-2，Windows） | `npm run test:unit -- settingsConcurrency` | 绿 | 13 项断言全过 |
| 既有回归（RT-2，Linux） | WSL `node out/src/test/settingsConcurrency.test.js` × 30 轮 | 绿 | 修复前 WSL 首跑即红（ENOENT + 丢失更新），修复后 30 轮零失败 |
| 常写盘压力变体（Linux） | WSL `node .tmp-repro/repro-lock.mjs 15`（临时插桩，不入库） | 绿 | 修复前 5 轮坏 2 轮（150 次自增只落 101 / 139），修复后 15 轮全部 150/150 |
| 全量单测 | `npm run test:unit` | 部分验证 | 86 通过 / 3 失败 / 1 跳过：docsLint 与 docsLintLocalOnlyPaths 的红来自另一进行中缺陷 specs/defects/orphan-stalls-on-permission-roundtrip.md（status 待修，验证记录尚无绿行，非本缺陷范围）；brandLiteral 红由本规格的 GitHub URL 触发，已改为运行号引用；本缺陷相关文件（fileLock / settingsConcurrency）全绿 |
| 类型与 lint | `npm run check-types && npm run lint` | 绿 | — |

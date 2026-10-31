---
status: 已修
---

# 缺陷：陈旧锁 unlink 失败时 tryCreateLock 无界递归，拿不到锁变成栈溢出

`src/shared/utils/fileLock.ts` 的 `tryCreateLock` 在「判定陈旧 → `unlinkSync` → 重试创建」
这条链上把 unlink 失败当成「别人抢先清理了」并**无条件递归**。锁路径上是不可 unlink 的
对象时（最常见：同名目录），递归条件在每一层都成立——路径没变、陈旧判定还是命中、
unlink 还是失败——于是递归无界，最终 `RangeError: Maximum call stack size exceeded`。

后果不是「写盘失败」而是**进程级异常**：`acquireLockSync`（`Logger` 日志轮转路径）与
`withFileLock`（`SettingsStore` 的读-改-写路径）都直接抛栈溢出，且错误类型是 `RangeError`
而不是约定的 `failed to acquire file lock`——调用方按契约 catch 具体错误时接不住。

## 现状

- `tryCreateLock` 的 `EEXIST` 分支（`src/shared/utils/fileLock.ts`）：`isLockStale` 为真后
  `unlinkSync` 包在 `try/catch` 里吞掉所有错误，随后 `return tryCreateLock(lockPath)`
  ——同一路径、同一把仍未移除的「锁」，下一次进入必然重走同一条链。
- `isLockStale` 只按 mtime / pid 判定，不看对象的**类型**：锁路径上是个老目录时同样判为
  陈旧，而 `unlinkSync` 对目录报 `EISDIR`，正好落进那个被吞掉的 catch。
- 复现（Linux，仓库根，无任何 fs 注入）：

  ```
  mkdir -p /tmp/lk1/settings.json.lock
  node -e "require('./out/src/shared/utils/fileLock.js').acquireLockSync('/tmp/lk1/settings.json.lock')"
  ```

  实测输出 `sync threw: RangeError | Maximum call stack size exceeded`；
  `withFileLock` 同一路径同样以 `RangeError` reject。把目录 mtime 设为旧时间不是必要条件
  （pid 探活分支对非文件内容解析失败，只由 mtime 兜底），用旧 mtime 让触发条件确定。

## 期望

1. **unlink 失败即结束本轮**：`tryCreateLock` 在不移除锁对象的路径上返回 `false`，由调用方
   已有的重试预算（`acquireLockSync` 的 `LOCK_MAX_ATTEMPTS` / `withFileLock` 的
   `LOCK_ASYNC_MAX_ATTEMPTS`）决定结论。进程内重试不得递归——重试预算的语义是「等对方
   释放」，而删除失败不是「等一等就好」的状态。
2. **失败语义回到契约**：`acquireLockSync` 返回 `false`（调用方放弃写入），`withFileLock`
   抛 `failed to acquire file lock: <path>`，不再是 `RangeError`。
3. **删不掉的对象原样保留**：清理失败不能表现成「已清理」，锁路径上的目录不得被当成
   已释放。
4. **清理成功后的重建也有界**：`tryCreateLock` 全程不递归——「判陈旧 → 删 → 建」写成有界
   循环（正常路径一轮成功）。理论上存在「对手进程每次都恰好在 unlink 与 create 之间重建
   一把同样陈旧的锁」的活锁，上界把它降级成一次普通的获取失败，而不是让等待者在自己的
   调用栈里空转。

## 不变量

- 陈旧锁抢占语义保留：持有者崩溃（pid 已死 / mtime 过旧）留下的**文件**锁仍可被后续
  等待者清除并接管。
- 「锁已不存在」不得授权 unlink（`specs/defects/file-lock-stale-break-destroys-recreated-lock.md`
  的 RT-1 保持绿）。
- 锁文件内容格式不变：`<pid> <毫秒>`。
- 获取失败仍不静默降级：`withFileLock` 抛错、`acquireLockSync` 返回 false，调用方放弃写入。
- `settings.json` 的写安全四层（跨进程锁 / 读不出拒写 / 原子落盘 / 内容未变不落盘）不变。

## 回归测试

- **RT-1**：陈旧锁的锁路径上放一个目录（老 mtime），断言 `isLockStale` 判为陈旧（前置条件）、
  `acquireLockSync` 返回 `false` 且不抛错、`withFileLock` 以含 `failed to acquire file lock`
  的错误拒绝且错误不是 `RangeError`、目录原样保留。修复前两条断言双红（RangeError）。
  （落点：`src/test/fileLock.test.ts` 的「陈旧锁删不掉时不得无限递归」段）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- fileLock` | 红 | `acquireLockSync 遇到删不掉的陈旧锁返回 false，不抛栈溢出` 与 `withFileLock ... 不抛栈溢出` 双红：`RangeError: Maximum call stack size exceeded` |
| 回归用例（修复后） | `npm run test:unit -- fileLock` | 绿 | 7 通过 / 0 失败（含既有 RT-1 三条） |
| 既有回归 | `npm run test:unit` | 绿 | 全量单测（含 settingsConcurrency 跨进程并发写） |
| 静态检查 | `npm run check-types` + `npm run lint` | 绿 | — |

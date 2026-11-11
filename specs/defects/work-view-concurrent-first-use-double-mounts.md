---
status: 已修
---

# 缺陷：同一会话的并发首次工具调用把工作视图叠加挂载两次

并行工具批里两个以上并发安全工具（`Read` / `Grep` / `Glob`）同时首次触发视图建立时，
同一份 `upper` / `work` 被挂载两次。写入仍落同一份上层（数据不串味），但挂载层数对不上
登记表：`release` 只卸一层、`remove` 删不掉仍有挂载的视图目录。

两个**不同**的 overlay 对话同时跑 Bash 不受影响：各自一份 `upper`（`session_key` 由工作区
+ 会话 id 派生），每个 Bash 子进程在 `pre_exec` 里 `unshare(CLONE_NEWNS)` 后 bind，挂载
不泄漏给父命名空间。缺陷只在**同一会话**内。

## 现状

`ensure_work_view`（`core-rs/src/engine.rs`）的「检查 — 登记 — 挂载」三步没有互斥：

```text
WorkViewHandle::of(session)   → None（都还没挂）
WorkView::register(...)       → 第一个成功，其余拿到「已有工作视图」
WorkView::reopen(...)         → 其余拿到同一份记录（mounted: false 的克隆）
view.ensure_mounted()         → 每个调用方都挂了一次
```

`ensure_mounted` 判的是**自己克隆上的** `mounted` 字段，不是登记表里的真相；登记表只在
挂载成功后由它回写（`work_view_linux.rs` 的 `views().get_mut(...)`）。因此后到者的克隆
永远读到 `false`，`mount_overlay` 照常执行——`mount(2)` 允许在同一挂载点叠加挂载。

触发条件是会话的**第一次**工具调用落在一个并行批里且含两个以上并发安全工具：
`flush_pending_batch`（`engine.rs`）每个工具一个线程，`is_concurrency_safe` 对
`Read` / `Grep` / `Glob` 恒为真。

实测（临时用例，两个线程经 `Barrier` 同时进入，`/proc/self/mountinfo` 计数）：

```text
两次 ensure_mounted 结果：[Ok(()), Ok(())]
同一挂载点在 mountinfo 里出现 2 次
release 之后残留挂载条目 1 次
remove => Err("回收视图目录 ... 失败：Directory not empty (os error 39)")
视图目录还在吗 = true
```

后果：

- `release` 只 `umount` 一次，残留的那层挂到 Core 进程退出（挂载在 Core 的私有挂载
  命名空间里，进程退出即消失，但进程存活期间一直在）；
- `remove` 时登记表已被 `release` 清空，找不到条目就跳过 `umount`，直接 `remove_dir_all`
  一个仍有挂载的目录 → `EBUSY`，视图目录与挂载双双残留，删除对话后目录删不掉。

## 期望

1. 同一会话的视图只挂一层：并发首次工具调用之后，该挂载点在 `/proc/self/mountinfo`
   里恰好出现一次。
2. 并发首次工具调用的每个调用方都拿到可用句柄（`WorkViewHandle::of` 为 `Some`）——
   不得因为并发而退回真实磁盘（那等于隔离静默失效）。
3. 注销后不残留挂载；回收能删掉整个视图目录。
4. 注销与建立竞争时不留下「登记表里没有、内核里还挂着」的视图：视图已注销后
   `ensure_mounted` 报错而不是照挂。

## 不变量

- 视图目录布局与 overlay 挂载参数不变（`lowerdir` / `upperdir` / `workdir` / `userxattr`）。
- 会话 id → 视图目录的映射不变（`session_key` = 工作区 + 会话 id 派生），跨 Core 重启稳定。
- `conversationClosed` 卸载挂载但**保留**上层目录；`conversationDeleted` 卸载并回收整目录。
- 挂载失败仍然记日志并让工具按真实磁盘执行（FR-007 的设计允许降级），不改成 panic。
- 并发安全工具仍可并行执行：加互斥只串行化视图的**建立 / 注销**，不串行化工具本身。

## 回归测试

- **RT-1**：两个线程经 `Barrier` 同时走「首次取句柄」（`register` 失败则 `reopen`）+
  `ensure_mounted`，两者都返回 `Ok`、都能取到句柄，且 `mountinfo` 里该挂载点恰好 1 条。
  （落点：`core-rs/src/work_view_tests.rs` 的 `work_view_concurrent_first_use_mounts_once`）
- **RT-2**：同上并发挂载之后 `release`，挂载点从 `mountinfo` 消失；再 `remove` 成功且
  视图目录被删掉（不得 `EBUSY`）。
  （落点：`core-rs/src/work_view_tests.rs` 的
  `work_view_release_and_remove_after_concurrent_first_use`）
- **RT-3**：视图登记后先 `release`（对话在首次工具调用之前就关了），再 `ensure_mounted`
  必须报错且不产生挂载。
  （落点：`core-rs/src/work_view_tests.rs` 的 `work_view_mount_after_release_is_refused`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --bin standalone-core work_view_concurrent_first_use_mounts_once` | 红 | `同一视图只能挂一层`：`... 在 mountinfo 里出现 2 次`，`left: 2, right: 1`（两个线程的 `ensure_mounted` 都返回 `Ok`） |
| RT-2（修复前） | `cargo test --bin standalone-core work_view_release_and_remove_after_concurrent_first_use` | 红 | `注销后不得残留挂载`：`... 仍在 mountinfo 里`，`left: 1, right: 0`（`release` 只卸一层） |
| RT-3（修复前） | `cargo test --bin standalone-core work_view_mount_after_release_is_refused` | 红 | `已注销的视图不得再挂载`：`ensure_mounted` 返回 `Ok(())` |
| RT-1 / RT-2 / RT-3（修复后） | `cargo test --bin standalone-core work_view` | 绿 | 10 条全过；连跑 5 次均绿（并发用例不抖） |
| 既有回归 | `cargo test --bin standalone-core` | 绿 | 1141 passed / 0 failed（166s） |
| 文档一致性 | `npm run test:unit -- docs-lint` | 绿 | 49 + 6 全过；同步 [docs/core/conversation-work-view.md 第 3 节](../../docs/core/conversation-work-view.md#3-视图结构) |

---
status: 已修
---

# 缺陷：查看器并发刷新乱序完成时，旧内容覆盖新内容

[specs/018](../../docs/archive/specs/018-viewer-file-refresh/spec.md) FR-005 要求「刷新以最终
落盘内容为准」：两次相邻保存各触发一次「读 → 投递」，当前实现里两次 `refreshFromSource`
并发执行，读取完成顺序不保证与发起顺序一致（远程 SFTP 各自排队、本地线程池完成顺序），
旧内容可能后投递，查看器停在旧内容且没有任何后续事件纠正。

## 现状

- `ViewerWatchController.refreshFromSource` 无串行化：`handleCoreEvent` / `handleLocalEvent`
  / 注册后补读各自 `void this.refreshFromSource(active)`，两次事件的两次读取并发在途。
- 复现（远程）：保存 v1 与 v2 相隔约一个去抖周期到达——v1 的 SFTP 读因网络抖动慢于
  v2 的读，投递顺序变成 v2 → v1，查看器最终显示 v1；文件不再变化时无事件纠正。
- `lastContent` 判重同样被乱序破坏：v2 先写回 `lastContent`，v1 完成后与 v2 比较不等，
  判重放行旧内容投递。

## 期望

1. 同一 watch 的「读 → 判重 → 投递」串行执行：后一次刷新在前一次投递完成后才开始读取。
2. 在途刷新期间到达的新请求合并为一次补跑（相邻保存不堆队列），补跑以最终落盘内容为准。
3. 关闭 / 顶替后的 watch 停止补跑（既有丢弃语义不变）；读取失败标记与内容判重语义不变。

## 不变量

- 事件驱动的注册 / 注销生命周期、watchId 路由与迟到事件丢弃不变。
- 内容判重（文本按字符串、图片按 data URL）与标题标记机制不变。
- `deliver` 抛错不中断后续刷新（记日志继续），不引入未处理 rejection。

## 回归测试

- **RT-1**：第一读挂在受控 gate 上、第二读已完成投递的场景，gate 释放后最终投递为最新
  内容、旧内容不回填（落点：`src/test/viewerWatch.test.ts` 的「乱序完成时最终投递最新
  内容」，fake 的 `readQueue` 支持 `until` 门控条目复现乱序）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npm run test:all -- viewerWatch` | 红 | 最终投递为 v1（旧内容回填覆盖 v2） |
| RT-1（修复后） | `npm run test:all -- viewerWatch` | 绿 | 26 通过 / 0 失败，含既有 25 项 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 无 TS 报错、无 lint 报错 |

---
status: 已修
---

# 缺陷：FR-010 的端到端用例前提不成立，fail-closed 实际没被覆盖

Overlay 隔离的 FR-010 要求「隔离归属但视图不可用」时工具必须报错、不能退回真实磁盘。
端到端用例 `FR-010 隔离会话的 Write 与 Bash 在视图不可用时 fail-closed` 看名字覆盖了
它，实际上**测不到那条路径**；而且它本身还依赖执行顺序，单独跑与全量跑结论不同。

## 现状

### 1. 前提靠执行顺序，不靠用例自己保证

用例注释写「**不部署代理**：这条用例要的正是『视图不可用』」，但代码里没有任何
`uninstallProxy()` 或前置断言。全量跑时前面的 `FR-009` 已经把代理装好，于是勾选
Overlay 时视图**是可用**的，Write 成功落进叠加视图——断言「结果必须含 error」
随即失败。单独 `-g` 跑时反而「通过」，因为它跳过了 `FR-009`。

### 2. 即便前提摆正，也构造不出目标状态

把前置改成「先卸载代理」后，仍然测不到：宿主的部署闸门在消息到达 Core **之前**
就把它拦下了。

```ts src=src/host/ui/webviewMessageHandler.ts
  private async shouldBlockForMountProxy(sessionId: string, storage: 'workspace' | 'isolated'): Promise<boolean> {
    const capabilities = await requestStorageCapabilities();
    if (storage !== 'isolated') return false;
    if (capabilities.isolatedWorkView) return false;
```

`capabilities.isolatedWorkView` 由 `probe_capabilities()` 实时探测代理，代理文件被删
即转 false，于是 `isolated && !isolatedWorkView && deployable` 成立 → 弹确认框、
消息不入 Core。工具根本没被调用，用例在等模型收尾文本处超时。

「先装好、建会话、再卸载代理」也不行：已登记的会话持有代理句柄，
`ensure_work_view` 命中 `WorkViewHandle::of` 就直接返回 `View`，不会再查代理是否还在。

结论：**`ViewUnavailable` 到达工具执行层这个状态，在端到端层面不可构造。**

## 期望

按层次分工，两层各测各的：

- **工具侧**（Write / Bash 在 `ViewUnavailable` 时报错且不落磁盘）由 Core 单测覆盖，
  那里能直接构造 `WorkViewState::ViewUnavailable`。
- **宿主侧**（代理不可用时拦下消息、不产生磁盘写入）由端到端覆盖，这才是端到端能
  稳定观测到的行为。

## 不变量

- Write 与 Bash 各自独立 fail-closed：它们走不同分支（`io_path` / `run_bash` 的三态
  判断），一处退化不应被另一处的测试掩盖。
- 判据必须同时包含「报错」与「磁盘上没有该文件」：只查磁盘会漏掉「报了错但已经写了」，
  只查错误文案会漏掉「报错的同时落到了真实磁盘」。

## 回归测试

- **RT-1**：`tools::tests::write_fails_closed_when_view_unavailable`——`io_path` 在
  `ViewUnavailable` 时报错，且磁盘上不出现目标文件。
- **RT-2**：`tools::tests::bash_fails_closed_when_view_unavailable`——`run_bash` 的
  三态分支在 `ViewUnavailable` 时不起子进程、不写磁盘。
- **RT-3**：`overlayMountProxyRemote` 的「FR-010 代理不可用时宿主拦下消息」——宿主的
  部署闸门在消息进 Core 前拦下它，界面无用户气泡、模型无新请求、磁盘无写入。

两条 Core 单测分开是有意的：Write 走 `io_path`、Bash 走 `run_bash` 的三态判断，是
两条独立分支，一条退化不该被另一条的测试掩盖（见下表的分别注入记录）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `test:e2e:ssh -- overlayMountProxyRemote` | 红 | 视图可用导致 Write 成功，断言「须含 error」失败 |
| 构造性验证 | 加 `uninstallProxy()` 后重跑 | 红 | 宿主弹部署确认框，消息不入 Core，等模型收尾超时 |
| Write 分支注入 | 把 `io_path` 的 `ViewUnavailable` 改成返回真实路径 | 红 | 仅 `write_fails_closed_…` FAILED，Bash 那条仍绿 |
| Bash 分支注入 | 把 `run_bash` 的 `ViewUnavailable` 改成落到本机 spawn | 红 | 仅 `bash_fails_closed_…` FAILED，Write 那条仍绿 |
| Core 全量（修复后） | `npm run test:core` | 绿 | 1210 通过 / 0 失败 |
| 端到端（修复后） | `test:e2e:ssh -- overlayMountProxyRemote` | 绿 | 6 通过 / 6 跳过 |


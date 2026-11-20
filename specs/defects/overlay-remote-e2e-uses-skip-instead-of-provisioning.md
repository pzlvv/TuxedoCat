---
status: 已修
---

# 缺陷：挂载代理远端用例长期停在 skipped，修齐后暴露 9 处用例缺陷

`e2e/electron/overlayMountProxyRemote.spec.ts` 的 17 条用例里，有 6 条用
`test.skip(!installed, ...)` 依赖「远端已装代理」。但同文件的 FR-010 会**故意卸载代理**来
验证「能力消失」，而 `afterEach` 不恢复安装。于是那 6 条在任何执行顺序下都恒为 skipped
——它们从未真正跑过，「全绿」是跳过凑出来的。

把它改成各自 `ensureProxyInstalled()` 自备前置后，这 6 条第一次真正执行，连带暴露出
下游 9 处缺陷（其中 2 处是被跳过掩盖的产品/用例契约不一致，7 处是用例自身的实现错误）。

## 现状

修复前，逐项如下（行号指修复前的文件状态）：

1. **卸载只删主二进制，漏掉允许列表 sidecar**（产品文档与用例不一致）。
   [docs/core/mount-proxy.md](../../docs/core/mount-proxy.md#21-卸载) 的卸载一节删两个文件
   （`<落点>` 与 `<落点>.uids`），而用例的 `uninstallProxy()` 只 `rm -f` 前者。
   本机实测留下 `/usr/libexec/tuxedo-cat-mount-proxy.uids`（内容 `1002`）——下一个装机
   用户的 uid 会出现在放行名单里。AC-36 的断言也只查主二进制，因此没有拦住。
2. **6 条用例用 `test.skip` 掩盖本可自备的前置**（顺序耦合）。见上。
3. **AC-37 去远端找宿主的审计行**。审计行由宿主写
   （`src/host/ui/webviewMessageHandler.ts::applyDeployOutcome` 的 `this.log(auditLine(...))`），
   落在 `launchApp` 为该实例建的沙箱 HOME（`<home>/<configDir>/logs/<logFileName>`）；
   远端只有 Core 的日志。用例却去 `~/<configDir>/logs/` 里 `grep`，永远为空。
4. **AC-37 的轮询不返回值**。`await expect.poll(...).not.toBe('')` 求值结果是 `void`，
   紧接着的四要素 `expect(line).toMatch(...)` 拿到 `undefined`，报
   `Matcher error: received value must be a string`。
5. **代理归属按全机计数**（跨用例互相污染）。`remoteProcesses(PROXY_PROCESS_PATTERN, true)`
   数的是整机代理，而「每个隔离会话一个代理」：同轮上一条用例的代理还在收尾、或本机自测时
   开发机自己的会话，都会让「代理是否全部退出」永远不成立。AC-31 因此**稳定失败**
   （`等待远端代理退出` 30s 超时），AC-26 的「至少两个代理进程」也数不准。
6. **AC-26 的父子链断言用全机 `pgrep -d`**，同样混入别的会话；
   并且断言「B 的 euid 应为 0」与文档相反——[docs/core/mount-proxy.md](../../docs/core/mount-proxy.md#3-特权阶段的时序与加固) 的特权阶段步骤 6 明确
   「A 立刻降回真实 uid，此后只做 waitpid」，B 继承降权后的身份。
7. **清场用固定 `sleep 1`**。`pkill` 只负责发信号，SIGTERM 到进程真正退出之间还有 Core 的
   收尾写盘；负载高时 1s 不够，留下半死的 daemon 正是 `e2e/README.md` 已知坑 11 描述的
   故障（下一条用例建链挂在「等待活动聊天视图」上）。
8. **两处运行说明写着已废弃的开关**。`overlayMountProxyRemote.spec.ts` 与
   `e2e/webview/overlayMountProxy.spec.ts` 的文件头都写
   `<envPrefix>_E2E_MOUNT_PROXY=1 ...`，但实现落地后那个临时开关已删除
   （那个临时开关的 helper 已随实现落地删除，全仓库无任何代码读取该变量）。
9. **四条用例的 mock handler 设在勾选 Overlay 之后**。勾选后界面即接受输入，紧接着的
   `fill` + `Enter` 会让第一次请求落到默认应答上，断言就在等一个永远不会出现的终答
   （表现：`EXPLORER-BASELINE-DONE` / `OVERLAY-COMPILE-DONE` / `RECYCLE-PROBE-DONE`
   等文本 120s 不出现）。

## 期望

1. 卸载按文档删两个位点（主二进制 + `.uids`），AC-36 同时断言两者都消失。
2. 前置本文件能建立就不跳过：各用例自备 `ensureProxyInstalled()`（幂等）。
3. 审计行在**同一次实例**的沙箱 HOME 里读（部署与读日志必须同一个 `homeDir`）。
4. 四要素断言拿到的是审计行字符串本身；并额外断言不含 SSH 口令。
5. 代理的归属按**父子链**判：先记本会话 Core 的 pid，再沿 ppid 串后代
   （`sessionProxyGoneFor(corePid)`）。AC-31 断言「该 Core 后代里没有代理」。
6. AC-26 按本会话 Core 的后代树取 A / B；断言 A 是 Core 直接子进程、B 是 A 的子进程、
   A 已降回真实 uid（不是 root）。
7. 清场轮询等进程真的消失（`pollRemote` / `waitForNoCore`，上限 15s），不靠固定 `sleep`。
8. 运行说明写真实跑法，并注明 overlayfs 与「已安装段」前置。
9. handler 在勾选 Overlay **之前**就位。

## 不变量

- **被测链路的断言不重试**：只有布置前置（`ensureProxyInstalled`）允许重试一次，因为它要过
  SSH 建链 → daemon 引导 → 闸门 → 确认框 → sudo 口令 → 自检，已知坑 10 的瞬时失败率约 3%。
  产品行为的断言一旦重试，就会掩盖 `specs/defects/` 里那一类缺陷。
- **代理归属按父子链**，不按全机个数：`remoteProcesses(PROXY, true)` 只在确需跨 uid 时用。
- **Core 与代理的探测按 SSH 用户 uid 收口**（`pgrep -u "$(id -u)"`），否则本机自测时会把
  开发机正在用的 Core 数成本车道残留。
- **勾选框可见即能力已到达**：入口渲染条件就是 `isolatedWorkView || deployable`
  （`src/webview/MessagesView.tsx` 的 `showWorkViewOption`）。额外轮询 `deployable` 是错的
  ——代理就绪后它恒为 false（`core-rs/src/mount_proxy.rs::capabilities_from` 的 ready 分支）。
- **审计行只由宿主写**，远端日志里没有。

## 回归测试

- **RT-1**：卸载后两个位点都消失（主二进制 + `.uids`）。
  落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `FR-012 AC-36 文档里的卸载命令幂等：连跑两次都成功且两个位点都消失`。
- **RT-2**：审计行四要素齐全且不含口令，从同一次实例的沙箱 HOME 读取。
  落点：同文件 `FR-012 AC-37 安装写审计行：主机名 / 落点 / sha256 / 安装者 uid`。
- **RT-3**：会话关闭后**本会话**代理全部退出（别的会话的代理不算）。
  落点：同文件 `AC-31 隔离会话的 Write 不落真实磁盘，会话关闭后 mountinfo 无泄漏`。
- **RT-4**：A 是 Core 直接子进程、B 是 A 的子进程、A 已降权；SIGKILL Core 后 1 秒内
  本会话代理清零。
  落点：同文件 `AC-26/AC-26b/AC-26c Core 被 SIGKILL 后代理在 1 秒内消失，无残留`。
- **RT-5**：「已安装」段的用例不再依赖执行顺序（自备前置）。
  落点：同文件 `FR-009 已安装时能力 ready、Core pid 不变、帧通道正常`、
  `FR-012 AC-36`、`FR-012 AC-37`、`privileged` 段的 AC-15 / AC-19 / AC-21 / AC-26。
- **RT-6**：清场后远端无本 uid 的残留 Core。
  落点：`remoteChangeList.spec.ts` 的 `waitForNoCore`、`remoteTaskSurvival.spec.ts` /
  `overlayMountProxyRemote.spec.ts` / `remoteSshExecution.spec.ts` 的 `resetRemoteDaemon`。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| overlay 车道（17 条，修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote` | 红 | 6 skipped / 11 passed；改自备前置后暴露 9 处缺陷 |
| overlay 车道（17 条，修复后） | 同上 | 绿 | 17 passed（1.9m），0 skipped |
| electron-ssh 全车道（43 条） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh` | 绿 | 43 passed（13.3m），0 skipped / 0 failed |
| e2e 类型检查 | `npm run check-types:e2e` | 绿 | — |
| lint | `npm run lint` | 绿 | — |
| Rust 格式基线 | `npm run fmt:rust:check` | 绿 | — |
| `.uids` 残留复现 | 修复前跑完车道后 `ls /usr/libexec/tuxedo-cat-mount-proxy.uids` | 红 | 存在且内容为 `1002`；修复后收尾位点清空 |
| 清理验证 | `ps -u e2essh -o pid,cmd` | 绿 | 车道结束后无残留 Core / 代理 / 测试子进程 |

本机作为远端的额外前置（非本缺陷范围，供复现者参考）：内核需加载 overlayfs（本机是模块，
`sudo modprobe overlay` 后 `/proc/filesystems` 出现 `nodev overlay`，已写入
`/etc/modules-load.d/overlay.conf`）；`e2e/environments.json` 指向本机专用的测试用户（见该文件的 gitignore 说明）。

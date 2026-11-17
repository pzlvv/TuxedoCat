# ADR-0018：命名空间由常驻代理持有，Core 自身不进命名空间

- 状态：已采纳
- 日期：2026-11-14
- 取代：[ADR-0017](0017-root-mount-proxy.md)
- 规格：[specs/051-overlay-root-mount-proxy](../../specs/051-overlay-root-mount-proxy/spec.md)
- 实施状态：方案成立，代码未落地（上一轮实施的代码已还原，结论保留）

## 背景（Context）

ADR-0017 定下的形态是「特权前置 + Core `exec` 自身」：`run_core()` 最早调用
`mount_proxy::bootstrap()`，若代理就位就用 `Command::exec()` 把 Core 进程映像替换成代理，
代理建好用户 + 挂载命名空间、写完 id 映射后再 `exec` 回 Core。这样 Core 全程在命名空间里，
工具子进程继承它，`work_view_linux.rs` 的 overlay 挂载、`mounted_at` 校验、`umount_all`
卸载全部沿用既有实现。

这条路线在真机上暴露了致命缺陷。远端 Ubuntu 24.04 / kernel 6.8 上：

1. 部署槽位里存在随包代理产物，但是 `pz:pz 0755`（用户可写、无 setuid 位）；
2. `locate_proxy()` 只判 `0o111`，把它当成可执行代理返回；
3. `reexec_through_proxy()` 用 `Command::exec()` 执行它；
4. 代理入口自检发现 `euid != 0`，**正确**拒绝并 `_exit`；
5. 因为用的是 `exec`，Core 的进程映像早已被替换——代理的退出码 70 **成了 Core 的退出码**；
6. daemon 观察到 `core exited unexpectedly (code=Some(70))`，60 秒内重启 5 次后放弃，
   **整条 SSH 连接不可用**。

根因不是配置失误，而是 `exec` 与「失败不阻塞启动」在原理上无法共存：`exec` 成功后原进程
代码永不返回，任何下游失败都只能以原进程的退出码结束。

## 决策（Decision）

**Core 进程自身不 `exec`、不 `unshare`、不进任何命名空间。** 命名空间由一个常驻代理持有，
工具进程从代理 `fork` 继承。

进程拓扑：

```text
daemon ──spawn──▶ Core（帧循环，不进命名空间）
                    │ socketpair（CLOEXEC）
                    ▼
                  代理 A（setuid 启动，euid 0；写完 id 映射后降回真实 uid，只做 waitpid）
                    │
                    └─ fork ──▶ 代理 B（持 CLONE_NEWUSER + CLONE_NEWNS，真正干活）
                                  └─ fork ──▶ 工具子进程
```

要点：

- **A 与 B 不能合并成一个进程**：进入新 userns 的进程无法给自己写 `uid_map`——写映射需要
  **父 userns** 的 `CAP_SETUID`。A 留在父 userns 才写得成，且 A 退出会让 B 被 reparent。
- **回收主路径是 socketpair EOF，不是 `PR_SET_PDEATHSIG`**：Core 死 → fd 关闭 → B 读 EOF
  退出 → A 的 `waitpid` 返回 → A 退出。这条链不依赖进程父子关系，覆盖 Core 被 `SIGKILL`。
  `PDEATHSIG` 只兜底「A 异常死亡」，且必须在凭证变更**之后**设置（`prctl(2)` 明确
  euid/egid/fsuid/fsgid 变更会清除它）。
- **需要看叠加视图的 Core 侧操作全部经代理代执行**：Bash、Read、Write、Edit、Grep、Glob、
  `workViewFilesRequested`、`workViewChangesRequested`、`workViewFileDiffRequested`。
- **代理不可用只让能力回 `absent`**：Core 照常启动、照常服务帧通道，daemon 不观察到退出。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| Core `exec` 自身进命名空间（ADR-0017 的方案） | 实测导致 daemon 反复重启、整条连接不可用。`exec` 一旦成功，Core 无法再对下游失败做出反应，与「失败不阻塞启动」不可共存。 |
| Core 用 `setns` 加入代理的命名空间 | `setns` 到用户命名空间要求调用者在**目标 userns 里**有 `CAP_SYS_ADMIN`。Core 不是父 userns 的 root，在目标 userns 里没有任何 capability，因此这条路不可行——让 Core 以 root 运行才能满足，那等于放弃整个方案的前提。 |
| 代理保持父进程、Core 作子进程 | daemon 观察到的 pid 会变成代理，既有 `parent_watchdog` / `kill` / 状态追踪全部要改；代理还要承担信号转发与收尸的完整监督职责。收益不匹配。 |
| 代理常驻并独占 mount，但 Core 仍自己读挂载点 | Core 不在命名空间里就读不到 B 的挂载，这是内核语义，没有折中。 |

## 后果（Consequences）

**正面**：

- 代理的任何失败都不影响 Core 与 daemon，消除了本次故障整类。
- 不需要重启 Core 就能让新装好的代理生效（`isolatedWorkView` 由 Core 每次现查）。
- 与 Chrome 的 `chrome-sandbox` + zygote 同构，是经过大规模验证的形态。

**代价**：

- 工具与视图取数要从「直接调用」改为「经代执行」，`tools.rs` / `work_view_changes.rs` /
  三个 `workView*` 请求都要改。
- overlay 的挂载校验与卸载从 Core 侧移到代理侧：Core 的 `/proc/self/mountinfo` 看不到 B 的
  挂载，`mounted_at` / `umount_all` 必须在 B 里实现。
- 协议需要支持取消与超时（Core 不再持有 `Child` 句柄，中止必须翻译成 `cancel` 请求）。
- 「持有 userns 内 `CAP_SYS_ADMIN` 的进程」从一次性窗口延长到整个会话期；新增 Core ↔ 代理
  这条此前不存在的 fd 边界。两者都不改变「代理不是沙箱」的论断，但需要写进挂载代理规格
  （`docs/core/mount-proxy.md`，尚未落地）的威胁模型。
- 允许列表的撤销在常驻期不生效（只在入口读一次），需重启 Core 或杀掉代理。

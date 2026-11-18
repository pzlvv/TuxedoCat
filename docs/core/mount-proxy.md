---
owner: pzlvv
last_reviewed: 2026-11-18
---

# 规格：Overlay 挂载代理

本文描述随 Core 分发的 Overlay 挂载代理：它是什么、为什么需要它、特权阶段怎么走、与
Core 之间怎么通信、以及它在失败时的行为。Overlay 对话本身的语义见
[docs/core/conversation-work-view.md](conversation-work-view.md)。

## 1. 它解决什么

Electron、Chrome 这类宿主都带一个以 root 属主 + setuid 位部署的辅助程序（
`chrome-sandbox` 是最有名的那个）：需要特权的那一步不在主进程里做，而是交给一个受
审查的小程序。本代理是同一形态，服务的对象是 Overlay 对话的挂载命名空间。

它替换的是旧形态「Core 自己在非特权用户命名空间里 `unshare` + 挂 overlayfs」。那条路在
限制非特权用户命名空间的发行版上直接不可用，**而且**在真机上根本挂不起来：先建
`CLONE_NEWUSER` 会让后续 `mkdir` 与 overlay 的 whiteout 全部返回 `EOVERFLOW`（根因与
实测见 [specs/defects/mount-proxy-cannot-mkdir-under-private-tmpfs.md](../../specs/defects/mount-proxy-cannot-mkdir-under-private-tmpfs.md)）。

## 2. 分发、落点与安装判据

| 项 | 值 |
| --- | --- |
| 产物名 | `<core.mountProxyName>`（`src/config/project.json` 是唯一来源） |
| 安装落点 | `<core.mountProxyDir>/<core.mountProxyName>`，目录固定为 `/usr/libexec` |
| 落点属主 / 模式 | `root:root`、恰好 `04755` |
| 构建形态 | Linux 目标静态链接（musl）、零第三方依赖 |
| 受众 | `--install` 时把调用者的 uid 写进 `<落点>.uids`，入口只放行列表内的真实 uid |

**随包槽位里的同名产物永不执行。** 部署槽位里那份是「上传 / 安装的源」，把它当可执行
代理会得到 `euid != 0` 的拒绝——上一轮就是这么炸的（
[docs/adr/0018-resident-mount-proxy.md](../adr/0018-resident-mount-proxy.md) 的故障链）。
因此定位判据只认上表这四条，缺一条都记成「未部署」。

### 2.1 卸载

代理不提供 GUI 卸载按钮，但必须有一条可执行的卸载路径。幂等：

```bash
sudo rm -f /usr/libexec/<core.mountProxyName> /usr/libexec/<core.mountProxyName>.uids
```

确认已移除：`ls -l /usr/libexec/<core.mountProxyName>` 报 `No such file or directory`。
删掉后下一次能力查询回 `mountProxy: 'absent'`、`deployable` 随平台判据给出；正在服务的
会话不受影响（它们的代理进程仍在跑），新会话按未部署处理。

### 2.2 安装审计

每次安装或升级，宿主日志写一行审计记录：主机名、落点、内容 sha256、安装者 uid。密码与
代理内容本身不进日志。行由 `src/host/mountProxyInstall.ts` 的 `auditLine` 产出，形状有
单测锁定。

## 3. 特权阶段的时序与加固

入口自检与请求收紧在任何特权动作之前完成，两者都是纯函数，可被单测逐条驱动：

| 步骤 | 判据 | 拒绝时 |
| --- | --- | --- |
| 入口自检 | `euid == 0`；真实 uid `!= 0`；真实 uid 在允许列表内 | 非零退出，点名是哪一条 |
| 请求收紧 | bounding set 裁到 `CAP_SETUID` / `CAP_SETGID` / `CAP_SYS_ADMIN`；`umask(077)`；`chdir("/")`；不读任何环境变量 | 非零退出 |

随后是特权阶段，顺序每一步都是约束：

```text
1. unshare(CLONE_NEWNS) + 把 / 设为 MS_REC|MS_PRIVATE   ← 必须在 fork 之前
2. 建视图目录并 chown 给真实用户                          ← root 建的目录降权后要能用
3. 挂 overlay，并自查 mountinfo 里该挂载点恰好出现一次
4. root 身份读一次挂载点                                  ← 把「挂载没生效」与「权限不足」分开报
5. bind 视图到真实工作区路径（MS_BIND|MS_REC）
6. fork ──▶ B；A 立刻降回真实 uid，此后只做 waitpid
```

**没有 user namespace。** 代理是 setuid root 启动的，在初始 userns 里本来就持
`CAP_SYS_ADMIN`；再建 `CLONE_NEWUSER` 只会换来一个残缺的 id 映射，让 `mkdir` 与 overlay
的 whiteout 全部 `EOVERFLOW`。挂载隔离由 `CLONE_NEWNS` 提供，与 id 映射无关。

**为什么仍然要 fork。** 挂载在 fork 之前就做完了，A 不再需要特权做任何事。fork 的唯一
目的是让 A 留在原处只做收尸：B 的 `PR_SET_PDEATHSIG` 绑在 A 上，A 一旦退出 B 会被
reparent 且信号不再生效。A 在 fork 之后立刻降权，此后不持任何特权。

**A 自己不设 `PDEATHSIG`。** `prctl(2)` 的 `PR_SET_PDEATHSIG` 跟的是 parent **task**
（父线程）而不是父进程，而 Core 是在工具批的短命线程里 `spawn` 代理的——设了它，拉起
代理的那条工具线程一收尾，内核立刻 `SIGKILL` A，A 的死再顺着 B 的 `PDEATHSIG` 带走 B。
表现为同会话第一条工具成功、此后每条工具都回「挂载代理已退出：读到 EOF」
（[defect](../../specs/defects/mount-proxy-dies-with-tool-thread.md)）。回收由下面的 socketpair EOF
承担，与父线程无关。

**`umask(077)` 的两个后果必须显式处理**：由 root 建出来的目录会落成 `0700` 且归 root，
降权后的进程读不了。因此每建一个目录都 `chmod 0755` + `chown` 给真实用户；写进视图的
标记文件同样要 `chmod 0644` + `chown`（overlay 的 upper 会继承这份元数据，问题会一路带到
merged 与 bind 后的路径）。这两条都是真机实测踩出来的。

## 4. 代执行协议（Core ↔ 常驻代理）

帧格式是**长度前缀 + JSON**：`<8 位十六进制长度>\n<JSON 载荷>`。二进制字段按十六进制
编码成 JSON 字符串。代理零第三方依赖，JSON 的解析与拼装是手写的。

运行期协议版本（`ipcVersion`）与安装握手版本（产物里的协议版本）**分开**：前者是帧语义
兼容性，后者是「装的这份代理能不能被这个 Core 用」。两者任一不匹配都不启用能力。

每个请求带 `id`，应答按 `id` 回到等待它的那一方。这不是装饰：工具批本身就是并行线程，
没有 `id` 时一条长 Bash 会把同会话的 Read 卡在队头。

| 请求 | 载荷 | 应答 |
| --- | --- | --- |
| `ping` / `version` | 无 | `pong` / `ipcVersion` |
| `probeOverlay` | 无 | `ok` / `error` |
| `spawn` | `argv` / `cwd` / `env` / `stdin` | 流式：`stdout` / `stderr` 片段，末条 `exit`（含 `code`） |
| `kill` | `target`（被中止那条请求的 id） | `ok` |
| `readFile` | `path` / `maxBytes` | `bytes` |
| `writeFile` | `path` / `bytes` | `ok` |
| `listDir` | `dir` | `entries`（`[{name, isDir, size, isSymlink}]`） |
| `stat` | `path` | `exists` / `isFile` / `isDir` / `isSymlink` / `size` |
| `mkdirAll` | `path` | `ok` |
| `gitShow` | `repo` / `rev` / `path` | `bytes` |

**判断归属只在 Core**：代理不判断「这个会话该不该用视图」，只执行收到的路径操作。挂载的
校验与卸载同样闭环在代理侧——Core 的 `/proc/self/mountinfo` 看不到代理的挂载。

`spawn` 的 `argv[0]` 可以是裸名：代理按**请求自带的 `env`** 里的 `PATH` 解析可执行文件
（`execve(2)` 自己不查 PATH，代理也按 FR-006 不读自己的环境），找不到时子进程不启动并
给出带 `PATH` 值的原因；含 `/` 的 `argv[0]` 按调用方给的原样执行。

### 4.1 fd 纪律

- 代理与 Core 之间的 socketpair、以及代理内部 A ↔ B 的通道全部带 `CLOEXEC`；
- 工具子进程的 stdin / stdout / stderr 由代理**新建管道**，绝不继承代理自己的 FD；
- 工具在 `spawn` 时 `setpgid(0, 0)` 自立进程组，因此中止可以整组杀掉。

没有这两条时，工具的输出会直接写进 Core 的帧流（一帧就废），工具里的任意代码也能伪造
应答。

## 5. 进程链与生命周期

```text
宿主 ──spawn──▶ Core（帧循环，永不进入命名空间）
                  │ 某个隔离会话第一次需要视图时 spawn + socketpair
                  ▼
                代理 A（setuid 启动，euid 0；挂载做完后降回真实 uid，只做 waitpid）
                  │
                  └─ fork ──▶ 代理 B（站在挂载命名空间里，跑帧循环）
                                └─ fork ──▶ 工具子进程
```

| 形态 | 触发 | 生命周期 | 持命名空间 |
| --- | --- | --- | --- |
| 一次性 | `--install` / `--self-check` / `--protocol-version` | 执行完即退出 | 自检建立后销毁；安装不建 |
| 常驻 | `--serve --fd <n>` + 视图五条路径 | 与该会话的 Core 同寿命 | 是 |

**一个隔离会话一个代理。** 代理在 `--serve` 时刻拿到该会话视图的五条路径，在降权之前
挂好 overlay 并把视图 bind 到真实工作区路径上。因此工具在真实路径上执行就是叠加结果，
Core 侧不需要任何路径映射——脚本里写死的绝对路径、`$PWD`、`cd` 全部照常工作。

**按需拉起**：登记发生在会话创建时，代理在第一次真正需要视图时（工具调用或视图取数）才
`spawn`。用户从不使用 Overlay 对话时不产生任何进程。

**回收主路径是 socketpair EOF**：Core 死 → fd 关闭 → B 读到 EOF 退出 → A 的 `waitpid`
返回 → A 退出。这条链不依赖进程父子关系，因此覆盖 Core 被 `SIGKILL` 的情形，也不受
「Core 在哪条线程里 `spawn` 代理」影响（代理自身不设 `PDEATHSIG`，理由见第 3 节）。

**代理被杀不带走 Core**：视图取数与下一次工具调用都会发现已有句柄已死，摘掉它并重新拉起
（不重启 Core）。

## 6. 自检的四条断言

`--self-check` 建一次真实命名空间并挂一次 overlay，断言不成立即非零退出并点名是哪一条：

1. 降权后进程**不再**持 `CAP_SYS_ADMIN`（挂载已在降权之前完成）；
2. 降权后 `getresuid` 三个 id 全为真实 uid；
3. 挂载表可读，且该挂载点在 `/proc/self/mountinfo` 里恰好出现一次；
4. 叠加视图与 bind 后的工作区都读得到 lower 的内容（挂载真的生效，不是空目录）。

## 7. 失败路径与不降级

| 情形 | 行为 |
| --- | --- |
| 代理未安装 / 落点判据不满足 | 能力 `mountProxy: 'absent'`，`reason` 点名缺失；Core 照常启动 |
| 运行期协议版本不匹配 | 同上，`reason` 点名版本 |
| 自检失败（命名空间 / 挂载 / 断言） | 同上，`reason` 透传代理给的原因 |
| 隔离会话的视图建立失败 | 该会话的工具调用**报错**，改动不落真实磁盘（fail-closed） |
| 代理运行中被杀 | 能力改判 `absent`；下一次需要时重新拉起，不重启 Core |

Core 自身的启动与帧服务与代理完全解耦：上述任何一种都不以非零退出码结束 Core，也不让
daemon 观察到 Core 退出。

## 8. 威胁模型与边界

**代理不是沙箱，也不是权限降级装置。** 它以真实 uid 运行，能改的只有该用户本来就能改的
东西。命名空间内的 uid 0 不改变宿主侧的权限检查，`/etc/passwd` 这类 root-owned 文件仍被
内核拒绝。代理侧的路径校验**是卫生措施，不是安全边界**。

代理的写权限不是新的边界，但下面三条是它引入的新面，必须记着：

- 常驻期在挂载命名空间里跑工具的进程（B）与建命名空间的特权阶段分离，B 降权后才跑业务；
- Core ↔ 代理之间这条 fd 通道此前不存在：工具子进程不继承它，代理不接收 Core 之外的请求；
- 允许列表在入口读一次，常驻期不生效——撤销访问要重启 Core 或杀掉代理。

## 9. 平台

只有 Linux 有挂载命名空间、overlayfs 与 setuid 语义。Windows / macOS 目标：
- 不产出代理产物，构建日志说明原因；
- Core 侧存在同签名占位，「只能经代理获得能力」的判据恒为 false；
- 能力应答 `deployable: false`（装代理也解决不了），界面因此不渲染入口。

## 10. 追溯矩阵

| 需求 | 落点 | 验证 |
| --- | --- | --- |
| 产物名 / 落点 / 协议版本 | `src/config/project.json`、两个 crate 的 `build.rs` | `npm run test:unit -- brand-literal config` |
| 落点判据（root:root 04755） | `core-rs/src/mount_proxy/linux/client.rs` 的 `locate` / `verify_installed` / `judge_installed_facts` | `client.rs` 的 `tests`（属主与模式两条判据各自独立驱动）、`rejects_missing_slot`；`mountProxyGate` / `mountProxyTarget` 单测；真机 `stat` |
| 入口自检与请求收紧 | `mount-proxy-rs/src/privilege.rs::entry_rejection` / `tighten` | 纯函数矩阵单测（含在 `test:mount-proxy`） |
| 特权阶段时序 | `mount-proxy-rs/src/privilege.rs::enter_mount_namespace` / `establish_after_mount` | `--self-check`（真机车道） |
| 代执行协议与 `id` 关联 | `mount-proxy-rs/src/protocol.rs`、`serve.rs`；`core-rs/src/mount_proxy/linux/client.rs` | 两侧单测 + 真机端到端 |
| 工具 fail-closed | `core-rs/src/tools.rs::WorkViewState` | `work_view_tests`、`tools_tests` |
| 安装审计与卸载 | `src/host/mountProxyInstall.ts::auditLine` | `mountProxyInstall` 单测；真机卸载 |
| 能力事实与派生字段 | `core-rs/src/mount_proxy.rs::capabilities_from` | `hostCoreFacts` / `storageCapabilitiesRouting`；真机能力应答 |

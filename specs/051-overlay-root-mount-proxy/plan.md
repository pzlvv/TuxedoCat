# 实施方案：Overlay 挂载改由常驻 root 代理持有命名空间

spec 见 [spec.md](spec.md)。本文只定技术方案与改动面，验收标准以 spec 为准。

## 技术方案

### 1. 为什么是「代理常驻持有命名空间」

三种形态（spec「待澄清」已记取舍）：

| 形态 | 谁持有用户 / 挂载命名空间 | 工具子进程怎么进视图 | 代价 |
| --- | --- | --- | --- |
| A 特权前置 + Core `exec` 自身（**已废弃**） | Core 自己 | 沿用 `bind_view_onto_workspace` | `exec` 替换 Core 映像，代理失败 = Core 退出 |
| B 代理常驻持命名空间（**采纳**） | 常驻代理 | Core 请求代执行，代理 `fork` 出工具进程 | 工具与视图取数改走代执行通道 |
| C 全部 IO 经代理 | 代理 | 所有文件读写经 IPC | 工作区外路径也要过代理，无收益 |

**A 为什么废弃**：`core-rs/src/mount_proxy.rs` 的 `reexec_through_proxy` 用 `Command::exec()`
替换 Core 进程映像。`exec` 只在失败时返回，一旦代理拒绝（`euid != 0`）就以代理的退出码结束
——实测远端 `8.136.22.171` 上 daemon 观察到 `core exited unexpectedly (code=Some(70))`，
60 秒内重启 5 次后放弃，整条连接不可用。这与 FR-007 自己承诺的「代理缺失或引导失败时 Core
照常启动」在原理上无法共存。

**B 的依据**：Chrome 的 `chrome-sandbox` + zygote 是同一形态——SUID helper 建立命名空间后
`exec` 成 zygote，zygote 常驻并 `fork` 渲染进程。区别在于 Chrome 的浏览器主进程不在沙箱内；
本方案里 Core 也不进命名空间，只有工具进程进。

**为什么不能用 `setns`**：内核不允许进程加入一个既有的用户命名空间后取得其 capability。
「代理建好空间、Core 用 `setns` 进去」这条路在 Linux 上不可实现，因此命名空间必须由代理
持有、工具进程从代理 `fork` 继承。

### 2. 进程拓扑

```
daemon ──spawn（帧通道 stdin/stdout）──▶ Core（不进任何命名空间）
                                          │
                                          │ spawn + socketpair（CLOEXEC）
                                          ▼
                                       代理 A（setuid 启动，euid 0）
                                          │  写完 uid_map / gid_map 后 setresuid 降回真实 uid
                                          │  fork 出 B 后只做 waitpid，不持任何特权
                                          │
                                          └─ fork ──▶ 代理 B（持 CLONE_NEWUSER + CLONE_NEWNS）
                                                        │
                                                        └─ fork ──▶ 工具子进程
```

| 约束 | 理由 |
| --- | --- |
| A 是 Core 的**子进程**、B 是 A 的子进程 | daemon 观察到的 Core pid 不变；既有 `parent_watchdog` / `kill` 逻辑零改动 |
| **A 写完映射后不退出** | 进入新 userns 的 B 无法自己写 `uid_map`——写映射需要父 userns 的 `CAP_SETUID`；且 B 的 `PDEATHSIG` 绑在 A 上，A 一退 B 立刻被杀 |
| Core 与 A 用 socketpair 而非管道 | 需要双向请求 / 应答，且要能传 fd（代执行时传 stdin / stdout） |
| 回收靠 **socketpair EOF** | Core 死 → fd 关闭 → B 读 EOF → B 退 → A 的 `waitpid` 返回 → A 退。不依赖进程父子关系，覆盖 Core 被 `SIGKILL` |
| `PDEATHSIG` 只做兜底 | A 的 `PDEATHSIG` 指向 Core（直接父子，可信）；B 的指向 A，仅防 A 异常死亡 |
| 所有通信 fd 设 `CLOEXEC` | 工具子进程不得继承 socketpair，否则工具里的任意代码可以伪造应答 |

### 3. 代理的两种形态

| 形态 | 触发 | 生命周期 | 命名空间 |
| --- | --- | --- | --- |
| 一次性 | `--install` / `--self-check` / `--protocol-version` | 执行完即退出 | 自检建立后销毁；安装不建 |
| 常驻 | Core 请求 `spawn`（无参数或 `--serve`） | 与 Core 同寿命 | 持有，直到退出 |

常驻形态的入口序列（FR-006 的硬要求，实现里逐条注释指向 spec）：

```
Core ──spawn──▶ 代理 A（setuid root，euid 0，真实 uid U）
       1. 入口自检：euid==0；real uid != 0；real uid 在允许列表内
       2. 收紧：bounding set 裁三项；umask(077)；chdir("/")；信号处置复位；不读环境变量
       3. fork
          ├─ 子进程（= B）：PDEATHSIG(父 = A)；
          │                unshare(CLONE_NEWUSER)；通知 A；阻塞等 ack
          └─ 父进程（= A，仍是 host root）：
               写 <B 的 pid>/setgroups=deny → uid_map(0 U 1) → gid_map(0 U 1)
               setresgid(U,U,U) → setresuid(U,U,U) → 断言三个 id
               ack
               **不退出**：转入 waitpid(B) 循环（此后只做收尸，不持特权）
       4. B 在 ack 后：unshare(CLONE_NEWNS) + MS_REC|MS_PRIVATE /
          PR_SET_NO_NEW_PRIVS
          此后它就是常驻代理本体：在 socketpair 上收发帧，按请求 fork 工具子进程
```

与旧方案的差异：

| 项 | 旧 | 新 |
| --- | --- | --- |
| Core 是否进命名空间 | 是（`exec` 自身） | **否** |
| 临时 root 进程（A） | 写完映射后进入监督循环直到 B 结束，但同时也在转发信号 | 写完映射后只做 `waitpid`，降权后无特权 |
| 真正干活的进程（B） | `exec` 成 Core | 常驻代理本体，不 `exec` |
| 代理失败的影响 | Core 进程被替换 → 退出码变 Core 的 | 只有 B 失效，Core 记 `absent` |

关键约束（每条都是 FR-006 的硬要求）：

- **A 不能提前退出**：B 已在新 userns 里，自己写不了 `uid_map`（需要父 userns 的
  `CAP_SETUID`）；且 B 的 `PDEATHSIG` 绑在 A 上，A 一退 B 立即被 `SIGKILL`。
- **A 降权后才 `waitpid`**：`setresuid(U)` 之后 A 不再是 root，它唯一的职责是收尸。
- **`CLONE_NEWNS` 必须在 ack 之后**：映射写完前挂载命名空间仍属父 userns，`MS_PRIVATE` 会
  `EPERM`。
- **`uid_map` 恰好一行 `0 U 1`**：不映射宿主 0，因此命名空间内任何 setuid-root 文件的内核
  setuid 语义失效。这是安全论证的支点。
- **特权窗口最短化**：父进程从 `fork` 到 `setresuid` 之间是唯一的 root 时间窗，写完映射立即
  降权并退出；常驻代理本身以真实 uid 运行，只是持有命名空间。
- **代理的 fd 1 / fd 2 只归它自己**：工具子进程的 stdin / stdout / stderr 一律由 B **新建管道**，
  绝不继承代理的 fd——否则工具的输出会直接写进 Core 的帧流。代理的诊断走自己的 fd 2。

### 4. 代执行协议（Core ↔ 常驻代理）

单向帧（长度前缀 + JSON）在 socketpair 上跑，每个请求一个响应：

| 请求 | 载荷 | 响应 |
| --- | --- | --- |
| `spawn` | `argv` / `cwd` / `env`（白名单）/ `stdin` 或 `pty` / `timeout` / `stdinFd` | 流式：`stdout` 片段 / `stderr` 片段 / `exit` |
| `mkdirAll` | `path` | `ok` / `error` |
| `listDir` | `dir` | 目录项数组 |
| `readFile` | `path` / `maxBytes` | 字节流 / `error` |
| `writeFile` | `path` / `bytes` | `ok` / `error` |
| `gitShow` | `repo` / `rev` / `path` | 字节流 / `error` |
| `mountOverlay` | `lower` / `upper` / `work` / `merged` | `ok` / `error` |
| `unmountOverlay` | `merged` | `ok` / `error` |

- **帧格式复用既有基线**：与 Core 帧通道同一套长度前缀 + JSON（`core-rs/src/frame.rs`），
  不新造第二套序列化。
- **协议版本独立**：代理与 Core 之间的版本号与「安装握手」的 `PROTOCOL_VERSION` 分开——
  前者是运行期 IPC 的兼容性，后者是「装的那份代理能不能被这个 Core 用」。两者任一不匹配都
  不启用能力。
- **判断归属只在 Core**：代理不判断「这个会话该不该用视图」，只执行收到的路径操作。

### 5. Core 侧改动

| 落点 | 改动 |
| --- | --- |
| `core-rs/src/mount_proxy.rs` | 删除 `reexec_through_proxy` 与 bootstrap 标记；改为「定位 + 协议校验 + 拉起常驻代理 + 持有连接」，新增 `ProxyClient`（帧收发） |
| `core-rs/src/mount_proxy/`（新目录） | `client.rs`（连接与帧）、`exec.rs`（代执行）、`overlay.rs`（挂载 / 卸载请求） |
| `core-rs/src/main.rs::run_core` | **删除** `mount_proxy::bootstrap()` 调用与 `work_view::enter()` 的代理分支；改为按需 `mount_proxy::ensure()` |
| `core-rs/src/work_view_linux.rs` | `enter()` / `enter_in_place()` / `write_id_maps()` / `finish_mount_namespace()` 全部删除；`entered()` 判据换成「ProxyClient 连接就绪」。**`probe_overlay()` 搬进代理**（Core 没有 `CAP_SYS_ADMIN`，自己挂必然失败），Core 侧改成一次 `probeOverlay` 请求或直接读 `--self-check` 结论。`mounted_at()` / `umount_all()` 同样搬进代理（Core 的 `/proc/self/mountinfo` 看不到 B 的挂载） |
| `core-rs/src/work_view.rs` | `Capabilities` 保持四字段。`isolated_work_view` 的判据改为「代理 Client 连接就绪 + 代理报回 overlay 实测可挂」；`available()` 与 `mount_proxy: Absent` 的组合不再可达，注释与 T010 的单测同步改 |
| `core-rs/src/tools.rs::ToolContext` | 三态不变；`view(handle)` 下的路径解析改为经代执行（`spawn` / `readFile` / `writeFile`） |
| `core-rs/src/main.rs::dispatch_ui_request` | `workViewFilesRequested` / `workViewChangesRequested` / `workViewFileDiffRequested` 改走代执行（原先直接读挂载点） |
| `core-rs/src/work_view_changes.rs` | `gitShow` 类取数改走代执行 |
| `core-rs/src/main.rs::start_conversation` | 能力不可用时拒绝把 `isolated` 写进 `meta.json`（不变） |

**删除面**：`work_view_linux.rs` 的 `enter_in_place` / `write_id_maps` / `finish_mount_namespace`
全部不再需要；`mount_proxy.rs` 的 bootstrap 标记机制删除。这些是旧架构的核心，留着会与新路径
并存造成「两套都能建命名空间」的假象。

### 6. 宿主侧

安装编排、三选一、零密码通道、部署闸门、对话框、远端上传都不动。**唯一一处变化**是
`src/host/mountProxyGate.ts`：`finish()` 删掉 `restartCore()` 调用与那段「为什么必须重启」的
注释，`MountProxyGatePort.restartCore` 成员一并移除（属契约面删成员，已登记在「受影响模块与
契约」）。不改这里的话，部署成功后仍会重启 Core——与新 FR-008 相反。

### 7. 构建接线

不变：新 crate `mount-proxy-rs/`（纯 std、静态 musl），产物由 `scripts/build-core.mjs` 落位
成 `resources/<core.resourceDir>/<arch>-linux/<core.mountProxyName>`，只对 Linux 目标构建。

### 8. 失败路径与不降级

| 层 | 失败 | 行为 |
| --- | --- | --- |
| Core | 代理未安装 / 版本不匹配 / 允许列表拒绝 / `euid != 0` | 能力 `absent`，Core 照常服务；**不退出** |
| Core | 常驻代理意外消失 | 帧通道无影响；能力改判 `absent`，下次需要时重新拉起 |
| Core | 代执行超时 / 代理回错误 | 该次工具调用报错（fail-closed），不退回真实磁盘 |
| Core | overlay 挂载失败 | 能力 `absent` 并点名内核原因；已建会话的工具调用报错 |
| 代理 | 命名空间建立失败 | 自行 `_exit` 并在 fd 2 打原因；Core 读到 EOF 即判 `absent` |
| 宿主 | 安装失败 | 既有行为：停在对话框、不建会话、消息留在输入框 |

## 本文与 as-built 的落差

本方案定的是新拓扑，而下列 as-built 章节**当前仍是旧口径**，收口任务是 T042。这些落差不会
让 `docsLint` 变红（`specs/` 是豁免区），因此在这里显式声明：

| 文档 | 仍是旧口径的章节 |
| --- | --- |
| `docs/core/mount-proxy.md`（未落地） | 第 1 节（威胁模型缺「常驻期持有 userns」与「Core↔代理 fd」两条新面）、第 2 节（允许列表语义）、第 4 节（时序图是 `exec` 目标）、第 7 节（进程链）、已知限制、边界表与追溯矩阵三节（追溯矩阵引用 `privilege.rs::supervise`，已不存在） |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | 视图取数的执行形态一节、[第 4 节](../../docs/core/conversation-work-view.md#4-命名空间)（时序图 `unshare` + `exec`）、第 5 节（「bind 只改内容来源」）、第 6 节（「视图建立失败 → 工具按真实磁盘执行」= fail-open，与 FR-010 直接冲突）、失败路径与平台两节 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 6 节](../../docs/core/standalone-core.md#6-生命周期)（进程链「宿主 → 代理 → Core」） |

**要求**：T042 的每一条与对应代码改动的同一提交里完成，不要攒到最后。理由是
[AGENTS.md](../../AGENTS.md) 要求代码注释引用 `docs/<path>.md` 章节，而 `docsLint` 会扫代码注释里的
章节引用——新写的 `mount_proxy/*.rs` 若注释指向「第 4 节」（旧时序图），事后整篇改写会让
注释与文档同时对不上。

## 并发与队头阻塞

`plan.md` 的请求表只列了字段，控制面语义必须显式定下来：

| 问题 | 定案 |
| --- | --- |
| Core 侧并发 | `ProxyClient` 用「读线程分派 + pending 表」：每个请求带 `id`，应答按 `id` 关联。否则一条长 Bash 会把同会话的 Read 卡住 |
| 工具批并行 | 工具批本身就是并行线程（`engine.rs` 的工具执行线程），多个 `spawn` 请求同时在途是常态，不是例外 |
| 代理侧并发 | `spawn` 可并发；`mountOverlay` / `unmountOverlay` 串行互斥（挂载表是全局资源） |
| 取消 | Core 不再持 `Child` 句柄，中止/超时/后台化都必须翻译成 `cancel` 请求；代理 `kill(-pgid)` 后回 `exit` |
| 请求超时 | 由 Core 侧计时并发 `cancel`，代理不自己判超时（它是执行方，不是策略方） |

## E2E 测试计划

按 `e2e/README.md` 的六层分工落用例，每层只测该层能看见的事实。**禁止把「真实提权」伪装成
CI 车道**：需要 root 的断言一律走特权车道并按既有 `markSkipped()` 口径登记。

### 分层与文件

| 层 | project | 文件 | 覆盖 | 前置 |
| --- | --- | --- | --- | --- |
| webview UI | `webview-ui` | `e2e/webview/overlayMountProxy.spec.ts` | FR-002 入口渲染判据（不带前置提示）、FR-003 部署闸门与取消语义、FR-004 三选一 / 遮蔽 / 不限次数重试 / 模态层、FR-008 成功不弹提示 | 假宿主新增能力注入与 4 条 wire 消息应答 |
| 整应用（本地） | `electron-app` | `e2e/electron/overlayMountProxyLocal.spec.ts` | FR-001 / FR-008 / FR-010 / FR-011 的能力事实与 fail-closed：非 Linux 宿主不渲染入口、能力 `absent` 时 `isolated` 不落 meta、存量 isolated 会话的显式转换 | 真实 Core（宿主平台二进制）+ mock LLM |
| 整应用（真实 SSH） | `electron-ssh` | `e2e/electron/overlayMountProxyRemote.spec.ts` | FR-009 / AC-34 / AC-35 / AC-36 / AC-37 的远端全链路：上传 → 提权安装 → 自检 → 能力 ready → 工具改动不落真实磁盘 → 卸载后校验 → 审计行 | `e2e/environments.json` 的 ssh 段 + `npm run build:core:linux-x64` |
| 特权车道（手工） | 无（`npm run test:e2e:ssh` 的一个文件） | `e2e/electron/overlayMountProxyRemote.spec.ts` 的 `test.describe('privileged')` | FR-005 / FR-006 / AC-15 / AC-19 / AC-21 / AC-22 / AC-23 / AC-26 / AC-26b / AC-26c / AC-27 | 远端 `sudo` 可提权；不满足时 `test.skip(true, 原因)` 单列 |

一条 `REMOTE_SSH_SPECS` 名单：新文件加进
`e2e/playwright.config.ts` 的正则，`electron-app` 的 `testIgnore` 与 `electron-ssh` 的
`testMatch` 因此同时生效（只改一侧的后果见 `e2e/README.md`）。

### 环境（`e2e/environments.json` 的 ssh 段）

已对测试机 `8.136.22.171` 实测（本计划制定时）：`Linux x86_64`、用户 `pz` 在 `sudo` 组、
**免密 `sudo` 不可用**（`sudo -n` 报 `a password is required`）、口令式 `sudo -S` 可用、
`/usr/libexec` 存在且 `root root 0755`、所在文件系统无 `nosuid`、内核支持 `overlay`。
因此：

- 免密分支（AC-10）与口令分支（AC-11）都能在真机上验，**免密分支只能验失败路径**——
  这条机器要么改 sudoers 要么跳过，本计划按「口令分支为默认路径」设计；
- `requiretty` / `use_pty` / `nosuid` / 祖先可写 / `/usr/libexec` 不存在这五类拒绝面
  （AC-16 / AC-18 / AC-35）**不能靠改测试机**（那是污染共享机器），统一由假 SSH 桩
  （`src/test/sshDaemonBootstrap.test.ts`）覆盖，e2e 只断言「用户可行动的原因文案」；
- 失败重试（AC-14）用假宿主驱动，绝不在真机上反复输错密码；宿主不设次数上限，账号锁定
  由服务端报错点名。

### 用例清单

`e2e/webview/overlayMountProxy.spec.ts`（假宿主）：

| 用例 | 验收标准 | 断言要点 |
| --- | --- | --- |
| 入口渲染 | AC-4 / AC-5 / FR-002 | `deployable: true` 且 `isolatedWorkView: false` 时勾选框出现；两者皆 false 时整块不渲染；能力始终未到达（不推 `setStorageCapabilities`）时不渲染 |
| 勾选后发消息弹确认框 | AC-7 / AC-8 | 确认框出现且文案含四项事实（root + setuid、落点、主机名、可创建受限命名空间）；`sendMessage` 未上行、不建会话 |
| 取消 | AC-9 | 输入框内容保留、勾选态保留、零提权消息上行 |
| Escape / 点遮罩取消 | FR-003 | 模态层语义：Escape 与点遮罩都等价取消，焦点在遮罩内 |
| 免密直接安装 | AC-10 | 不出现密码框，进度态可见 |
| 三选一 | AC-11 | 三个选项可见；选「sudo 密码」出现遮蔽输入 |
| 遮蔽输入 | AC-13 | `input[type=password]`，值不出现在 DOM 文本、不出现在任何上行消息的可读字段 |
| 零密码通道 | AC-12 | 显示完整命令 + 复制按钮；轮询就位后按 FR-008 继续 |
| 失败重试 | AC-14 | 每次失败回到三选一，回显这次的原因；不设次数上限 |
| 成功不弹提示 | FR-008 | `done` 到达时对话框直接收起，界面不留结果态 |

**选择器契约**：用例先写、实现后补，因此「怎么点、怎么读到值」必须先定死，否则实现与用例
各写一套、改一处必然漂。下面这组属性是 `MountProxyDialog`（T020）与 `MessagesView` 的
实现契约，用例只按它们定位（不按文案，文案要随 i18n 与措辞评审变）：

| 元素 | 定位 | 语义 |
| --- | --- | --- |
| 勾选框 | `input[data-work-view-option]` | FR-002 的入口，`checked` 即当前勾选态 |
| 确认框 | `[data-mount-proxy-dialog="confirm"]` | 模态层根（`aria-modal="true"`） |
| 四要素文案 | `[data-mount-proxy-dialog="confirm"] [data-fact]` | `data-fact` ∈ `root-setuid` / `install-path` / `target-host` / `userns`，四个都必须存在且非空 |
| 取消 / 确认 | `[data-mount-proxy-action="cancel"]` / `"deploy"` | 两个动作按钮 |
| 三选一 | `[data-mount-proxy-action="sudo-password"]` / `"root-password"` / `"manual-command"` | FR-004 的三条来源 |
| 密码框 | `input[type="password"][data-mount-proxy-secret]` | 遮蔽输入（AC-13） |
| 进度 / 失败 | `[data-mount-proxy-phase]` | 取值 `idle` / `running` / `failed` / `done` |
| 零密码命令 | `pre[data-mount-proxy-command]` | 用户自己执行的那段命令 |
| 转为真实工作区 | `[data-conversation-storage-convert]` | FR-011 的显式动作 |

**wire 协议契约**（T019 的四个消息，用例按名字驱动假宿主）：

| 消息 | 方向 | 载荷 | 何时发 |
| --- | --- | --- | --- |
| `requestMountProxyDeploy` | webview → host | `{}` | 用户在确认框点「部署」 |
| `submitMountProxyCredential` | webview → host | `{ method: 'sudoPassword' \| 'rootPassword', secret: string }` | 用户在三选一里提交密码（handler 第一条语句声明不记录） |
| `cancelMountProxyDeploy` | webview → host | `{}` | 用户取消 / Escape / 点遮罩 |
| `mountProxyDeployState` | host → webview | `{ phase, failure, manualCommand, targetHost, installPath }` | 闸门弹出确认（`phase: 'confirm'`）、进度（`running`）、需要提权选择（`needsCredential`）、零密码命令（`manualCommand`）、失败（`failed`）、成功（`done`，webview 收到即收起对话框） |

`phase` 是判别字段，`failure` / `manualCommand` 用 `string | null` 而不是可选：契约成员全
必选（铁律 4.2）。闸门在宿主侧（FR-003），因此 `sendMessage` 在能力不可用且 `deployable`
为 true 时**不上行**——用例断言的是「上行消息里没有 sendMessage」而不是「前端没有调用」。

`e2e/electron/overlayMountProxyLocal.spec.ts`（本地整应用，宿主平台 Core）：

| 用例 | 验收标准 | 断言要点 |
| --- | --- | --- |
| 非 Linux 宿主不渲染入口 | AC-3 / AC-5 | 宿主平台无代理能力时新对话空状态无勾选框；`storageCapabilitiesRequested` 应答 `deployable: false` |
| 能力不可用时 `isolated` 被拒 | AC-32 | 直接发 `setConversationStorage: isolated` 后建会话，`meta.json` 无 `isolated`，界面回推事实 |
| 存量 isolated 会话的显式转换 | AC-33 / FR-011 | 预置 `meta.json: isolated` 的会话打开后出现「转为真实工作区」动作；点击后落盘为 `workspace`，工具读写真实磁盘 |

`e2e/electron/overlayMountProxyRemote.spec.ts`（真实 SSH 远端）：

| 用例 | 验收标准 | 车道 |
| --- | --- | --- |
| 首次使用远端触发部署 | AC-1 / AC-7 / AC-34 | `electron-ssh`（远端未装机时的确认框文案含真实主机名） |
| 部署后能力 `ready` 且不重启 Core | AC-29 / FR-008 | `electron-ssh`（`mountProxy: 'ready'`，Core pid 不变） |
| 隔离会话改动不落磁盘 | AC-31 / AC-34 | `electron-ssh`（Overlay 会话 Write 后 SFTP 直读真实目录，内容未变；Write 结果必须成功且不含 error） |
| 视图不可用时 fail-closed | FR-010 | `electron-ssh`（不部署代理：Write 与 Bash 都报错，真实磁盘上不出现文件） |
| 双端帧契约 | FR-007 | `cargo test`（两侧共用 `core-rs/fixtures/mountProxyProtocol.json`，单侧改编码另一侧立刻红） |
| 挂载无泄漏 | AC-28j | `electron-ssh`（会话关闭后 `mountinfo` 无该 overlay 条目） |
| 卸载命令幂等 | AC-36 / FR-012 | `electron-ssh`（文档命令执行两次，第二次也成功且位点不存在） |
| 审计行 | AC-37 / FR-012 | `electron-ssh`（Core 日志含主机名 / 落点 / sha256 / 安装者 uid 四要素） |
| 安装形态 | AC-15 / AC-17 | `privileged`（`root:root` + `04755`；同内容重装不重写） |
| 自检四断言 | AC-19 | `privileged`（降权后无 `CAP_SYS_ADMIN` / 三个 uid 全为真实值 / mountinfo 恰好一条 / 视图可读）——代理不建 userns，断言集随架构改过 |
| 进程链与回收 | AC-26 / AC-26b / AC-26c / AC-27 | `privileged`（A 是 Core 子进程、B 是 A 子进程、`SIGKILL` Core 后 1 秒内无残留、Core 自身不在命名空间里） |
| 代理拒绝面 | AC-21 / AC-22 / AC-25 | `privileged`（直接以调用者身份执行代理 → 非零退出；A 降权后 `getuid()`） |

### 前置与执行

```bash
npm run build:webview && npm run copy-assets && npm run build:electron
npm run build:core:host           # 本地车道
npm run build:core:linux-x64      # 远端车道
npm run test:e2e:webview -- overlayMountProxy
npm run test:e2e:electron -- overlayMountProxyLocal
npm run test:e2e:ssh -- overlayMountProxyRemote
```

特权断言在远端不满足前置时 `test.skip(true, '<缺哪一项>')` 单列原因，**不算通过**（口径同
`scoreChecker.markSkipped`）。真实远端是共享机器：用例自建工作区、`afterAll` 恢复安装位点
（装了就在收尾卸载，没装则断言「仍不存在」），不在远端留状态文件。

### 实现未落地的处理

用例先于实现落地（本计划的执行顺序），因此**三条车道都用同一个环境变量开关**：
`<envPrefix>_E2E_MOUNT_PROXY=1`（常量在 `e2e/helpers/mountProxyFeature.ts`）。缺省关闭时
文件内每条用例 `test.skip(mountProxyE2ESkipReason())` 单列，理由是「实现未到」而不是
「环境不满足」——两者的恢复责任不同。

选择开关而不是「先不写用例」的两条理由：

- `webview-ui` 与 `electron-app` 都在 `test:e2e:local` 与 `all.yml` 的车道里。写进去就先红
  会让全量回归的绿失去意义（真失败被已知红淹没），而拆出去单独车道又要同步 CI 配置、
  `e2e/README.md` 的车道表与 `test:e2e:local` 的 project 清单三处；
- 开关是**临时的**：T024 / T025 勾选时删除 `mountProxyFeature.ts` 与各文件里的两行调用，
  用例不再有跳过分支。这是收敛记录里要核对的项（`/converge` 逐条核对时该文件应不存在）。

实现落地后逐条跑红绿的顺序 = 上面的用例清单顺序：先 webview（只依赖假宿主），再本地整
应用（依赖能力应答与拒绝落盘），最后远端（依赖上传 / 安装 / 自检全链路）。

### 不在这条车道的

- **`nosuid` / 祖先可写 / `requiretty` / `/usr/libexec` 不存在**：靠改共享远端去逼近等于污染
  机器，由 `src/test/sshDaemonBootstrap.test.ts` 的假 SSH 桩覆盖拒绝面，e2e 只验可行动文案；
- **运行时崩溃恢复（AC-28b / AC-28d）**：进程级信号语义在 `core-rs` 单测与特权车道断言，
  整应用层再加一条会与单测重复且更慢；
- **Windows / macOS 上产出代理产物**：非目标，构建脚本只对 Linux 目标产出。

## 改动面

| 文件 | 变更 | 说明 |
| --- | --- | --- |
| `core-rs/src/mount_proxy.rs` | 重写 | 从「bootstrap + exec」改为「定位 + 拉起 + 客户端」 |
| `core-rs/src/mount_proxy/client.rs` | 新增 | 帧收发与连接生命周期 |
| `core-rs/src/mount_proxy/exec.rs` | 新增 | 代执行（spawn / 读 / 写 / 列目录） |
| `core-rs/src/mount_proxy/overlay.rs` | 新增 | 挂载 / 卸载请求 |
| `core-rs/src/work_view_linux.rs` | 重写 | 删除本地 `unshare`；改为向代理请求 |
| `core-rs/src/main.rs` | 修改 | 删除启动期 bootstrap；UI 请求改走代执行 |
| `core-rs/src/tools.rs` | 修改 | 视图路径下的 IO 经代执行 |
| `core-rs/src/work_view_changes.rs` | 修改 | 取数经代执行 |
| `mount-proxy-rs/src/main.rs` | 重写 | 增 `--serve` 形态 |
| `mount-proxy-rs/src/serve.rs` | 新增 | 常驻循环：收帧、fork 工具、回传 |
| `mount-proxy-rs/src/protocol.rs` | 新增 | 与 Core 共用的帧定义（两侧各自实现，靠测试对齐） |
| `mount-proxy-rs/src/privilege.rs` | 修改 | 父进程写完映射即退出；子进程不 `exec` 目标 |
| `docs/core/conversation-work-view.md` | 修改 | 第 4 节重写为新拓扑 |
| `docs/core/standalone-core.md` | 修改 | 第 6 节进程链 |
| `docs/core/mount-proxy.md` | 修改 | 第 4 节时序、第 7 节进程链 |

## 受影响模块与契约

### 模块

| 模块 | 角色变化 |
| --- | --- |
| `core-rs/src/mount_proxy.rs` | 从「启动期 bootstrap + exec 自身」改为「运行期客户端」——不再替换进程 |
| `core-rs/src/work_view_linux.rs` | 从「自己 unshare + 写 id 映射」改为「向代理请求挂载 / 卸载」 |
| `core-rs/src/tools.rs` | 视图路径下的文件 IO 从直接调用改为经代执行 |
| `core-rs/src/work_view_changes.rs` | 同上 |
| `mount-proxy-rs/src/privilege.rs` | 父进程完成映射后退出；子进程成为终点而非二传手 |
| `mount-proxy-rs/src/serve.rs`（新增） | 常驻循环：收帧、fork 工具、回传 |
| `src/host/mountProxyExec.ts` | 不变（上一轮缺陷修复已接线） |
| `src/host/mountProxyGate.ts` | 不变 |

### 契约

本次**不新增**对外契约成员；`storageCapabilitiesRequested` 的四字段与 `ToolContext` 的三态
判别联合都保持现状。变化在 Core 内部：

| 契约 | 影响 |
| --- | --- |
| `UiRequest.storageCapabilitiesRequested` | 四个字段语义不变；`isolatedWorkView` 的判据从「Core 自身的命名空间状态」改为「代理就绪 + overlay 实测可挂」 |
| `UiRequest.workViewFilesRequested` / `workViewChangesRequested` / `workViewFileDiffRequested` | 应答形状不变，取数改走代执行 |
| `ToolContext.work_view` | 三态判别联合不变 |
| **Core ↔ 代理的私有协议**（新增，非对外契约） | 长度前缀 + JSON 帧；运行期版本与安装握手版本分开。它不进 `AssistantEventBus`——那是 core-rs 与 TS 的边 |
| `src/config/project.json` 的 `core.mountProxyName` / `core.mountProxyDir` | 不变 |

**为什么 Core ↔ 代理的协议不算「契约成员」**：`AGENTS.md` 第 1 节定义的契约是
`AssistantEventBus` 上的 Core ↔ UI 唯一通道。Core 与它自己的子进程之间的 IPC 属于 Core 内部
实现细节，不跨分层边界，不进事件表，也不受「可选成员冻结」约束。但它仍然受版本约束——
两侧协议版本不匹配时代理拒绝服务、Core 记 absent。

## 宪章检查

- **分层**：代理是独立 crate，不与 TS 共享代码；宿主侧不 import `vscode` / `electron`；
  Core 侧不引宿主 API。Core ↔ 代理是进程内私有 socketpair，不走 `AssistantEventBus`
  （它是 core-rs 与 TS 的边，不是 core 内部的边）。通过。
- **铁律**：
  - 4.1 不过度 fallback：代理缺失时能力 `absent` 而不是静默按磁盘执行；工具侧三态报错。
  - 4.2 不让接口可选：`work_view` 用判别联合；能力应答字段全必选。
  - 4.3 core 描述事实 UI 决定表现：`mountProxy` / `deployable` 是事实，文案在 webview。
  - 4.4 一份事实一个写入点：`deployable` 只在 Core 推导；能力的唯一 owner 是 Core。
  - 4.6 默认值只有一处：代理名与目录只在 `project.json`。
- **Core 行为**：能力判据、命名空间请求、拒绝落盘都在 Core；宿主不猜平台、不缓存能力。
- **文档同步**：`docs/core/conversation-work-view.md` 第 4 节与第 7 节、`docs/core/standalone-core.md`
  第 6 节、`docs/core/mount-proxy.md` 第 4 / 7 节；`npm run test:unit -- docs-lint` 必须绿。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| Core `exec` 自身进命名空间（原方案 A） | `exec` 替换 Core 映像，代理任何拒绝都会变成 Core 的退出码并触发 daemon 重启——实测导致整条连接不可用。与「失败不阻塞启动」无法共存。 |
| Core `setns` 加入代理的命名空间 | 内核不允许进程加入既有用户命名空间后取得其 capability，这条路不可实现。 |
| 代理保持父进程、Core 作子进程 | daemon 观察到的 pid 变成代理，既有 `parent_watchdog` / `kill` / 状态追踪全部要改；且代理必须承担信号转发与收尸的完整监督职责。收益不匹配。 |
| file capabilities（`cap_setuid,cap_setgid=ep`） | 过不了限制非特权 userns 的那道闸——判据是本命名空间内的 `CAP_SYS_ADMIN`。加上 `cap_sys_admin` 后并不比 root 窄，却换来 xattr 依赖、`nosuid` 同样失效、硬化扫描漏检。 |
| 不装 setuid，改写成 sudoers 免密规则 | 用户已明确否决：执行期不写 `/etc/sudoers.d/`。 |
| 让管理员关掉内核开关 | 用户机器不可控，且方向相反：本改动就是为「开关已关」的机器提供能力。 |
| 只做远端、不做本地 | 本地是主场景，远端与本地共用同一套安装与自检，拆开做反而多一套路径。 |
| 代理按 Core 指纹分槽 | 代理与指纹无关（与 ripgrep / fd 同口径），分槽只会让多版本并存时反复要求提权；语义漂移由协议版本握手兜住。 |
| 卸载做个 GUI 按钮 | 一次性动作，文档给一条幂等命令即可。 |

## 实施注意事项

本节记录本轮实施中踩到的、与方案本身无关但会反复咬人的坑。落地时按此清单自检；它们不是
验收标准（验收以 spec 为准），而是「照做会失败」的经验。

### 1. 跨平台编译：Windows 目标必须单独验证

`npm run package` 会**同时构建 Windows 与 Linux 两个目标**，而 Windows 上没有
`std::os::unix`。只用 `--target x86_64-unknown-linux-musl` 编译通过，不代表打包能过。

具体的炸点（按出现顺序，全部已在实施中真实触发）：

| 位置 | 症状 | 处理 |
| --- | --- | --- |
| `mount_proxy/mod.rs` 的 `pub mod` | `use std::os::unix::io::{AsRawFd, RawFd}` → `E0433` | 模块声明加 `#[cfg(target_os = "linux")]` |
| `mount_proxy::exec::run_command` 调用点 | `cannot find exec in mount_proxy` | 调用处加同等 cfg |
| `mount_proxy::protocol::BindView` 构造 | 同上 | 构造处加 cfg，非 Linux 绑 `None` |
| `tools.rs` 的 `run_bash_through_proxy` | 函数体本身依赖 unix | **给整个函数加 cfg**，只包调用点不够 |
| `work_view_changes.rs` 的 `Runner::git` | 函数体中段依赖代理 | 函数开头的 `#[cfg(not(linux))]` 分支必须 `return`，把余下函数体整体放进 `#[cfg(linux)] {}` 块——`cfg` 是**编译期删除**，不是运行期分支，`return` 之后的代码照样参与编译 |

**验证顺序**：先 `cargo check --target x86_64-pc-windows-msvc`，再打 Linux 目标，最后
`npm run package`。反过来做会浪费整轮打包时间。

### 2. 仓库文件是 CRLF，脚本化编辑必须显式处理

用 `node -e` 做多行替换时，硬编码 `\n` 的 pattern 在 CRLF 文件上**静默不匹配**（返回
「未找到」而不是报错）。本仓 `core-rs/src/*.rs` 多数是 CRLF。

```js
const CRLF = String.fromCharCode(13, 10);
const old = 'line1' + CRLF + 'line2';
if (!s.includes(old)) process.exit(1);  // 必须显式失败，不要静默跳过
```

同理，按行号切分函数体（找第一个 `depth === 0` 的行）在含注释块时容易切错——实施中曾把
一行注释单独切出来，留下空 `#[cfg]` 块。**改动函数结构时优先用 Edit 工具做精确整段替换**，
不要用「按花括号计数切片」。

### 3. `fmt:rust` / `test:core` 的覆盖范围

新增 crate 后必须同步三处，否则它的代码从未被格式化、也从未被测试：

- `package.json` 的 `fmt:rust` / `fmt:rust:check` 脚本；
- `test:core` 的串联（本改动加了 `test:mount-proxy`）；
- `AGENTS.md` 里「三个 crate」的表述。

`mount-proxy-rs` 加入 `fmt:rust` 后第一次运行就会改写存量格式——先跑一次再提交，否则
`fmt:rust:check` 必红。

### 4. 本机没有 C 工具链

`ring` / `zstd` 这类带 C 依赖的 crate 在本机（Windows arm64）编译不过，因此 **Rust 侧改动
无法在本机跑 `npm run test:core`**。这意味着：

- 本机的能力边界只有「编译通过」；
- 行为正确性必须在真实 Linux 远端（`e2e/environments.json` 的 `8.136.22.171`）验证；
- 交付时必须如实说明「未经测试执行」，不能把编译通过当作功能可用。

### 5. 真机验证的判据（远端 `8.136.22.171`）

| 检查 | 命令 | 期望 |
| --- | --- | --- |
| 代理是否装机 | `ls -l <mountProxyDir>/<mountProxyName>` | `root root` + `04755` |
| 活跃槽位内容 | `ls -la ~/.local/share/<core.deployPrefix>/<fingerprint>/` | 代理与 Core 同目录 |
| 能力 | 会话能力应答 | `mountProxy: 'ready'` |
| 隔离是否生效 | 在隔离会话改文件后查真实磁盘 | 改动不落磁盘 |
| 挂载泄漏 | `cat /proc/self/mountinfo` | 无残留 overlay 条目 |
| Core 存活 | daemon 日志 | 无 `core exited unexpectedly` / 无重启风暴 |

**最容易误判的一条**：槽位里存在 `0755` 的代理产物**不等于**已安装。判据只认
`/usr/libexec` 下的 `root:root` + `04755`（FR-005b）；随包产物只是「待安装」信号。
本轮故障的直接起因就是 `locate_proxy()` 只判 `0o111`，把槽位里用户可写的产物当成代理执行。

### 6. 打包产物的路径约定

Electron 打包后，随包资源在 `app.asar.unpacked/dist/resources/...`，而不是
`app.asar/resources/...`。定位代码应复用 `coreBinaryCandidates` 已有的「两条基准 + 各自派生
解包变体」约定，不要新造第二套路径拼装。另外**架构取目标而非宿主**：宿主 arm64 去装 x64
远端时，按 `process.arch` 会挑错目录，应走 `UIHost.getTargetPlatform()`。

### 7. 对话框必须是模态层

`RewindConfirmDialog` 是本仓的参照形态：Tailwind `fixed inset-0 z-[9999]` + 行内 flex 居中，
点击遮罩与 Escape 都等价于取消。两条容易漏的细节：

- 只写 `backgroundColor` 的遮罩不会覆盖应用，会作为普通块挤进文档流；
- `onKeyDown` 是 React 合成事件，只在焦点位于遮罩内部时触发。非凭据态没有可聚焦控件时
  Escape 完全失效，需要遮罩上 `tabIndex={-1}` + ref，并在进入时把焦点收进去。

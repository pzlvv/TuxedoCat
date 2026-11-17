---
status: 待评审
---

# 改动规格：Overlay 挂载改由 root 代理完成

Overlay 对话的叠加视图目前由 Core 自己在非特权用户命名空间里挂 overlayfs。这条路在
限制非特权用户命名空间的发行版上直接不可用：`unshare(CLONE_NEWUSER)` 后写 `uid_map` 回
`EPERM`，`storageCapabilitiesRequested` 恒回不可用，勾选框永不出现。

本改动把「进入特权命名空间」这一步交给一个随 Core 分发、以 root 属主 + setuid 位部署的
挂载代理（产物名 `<core.mountProxyName>`，安装落点 `<core.mountProxyDir>`）：代理只做特权
前置（建用户 + 挂载命名空间、写 id 映射），**自己持有这份命名空间**并 `fork` 出工具进程代
Core 执行；Core 进程自身不 `exec`、不 `unshare`、不进入任何命名空间，因此代理的任何失败都
不会影响 Core 的启动与帧服务。代理未部署时，用户勾选 Overlay 对话并发消息会先被要求部署；
确认后优先尝试免密 `sudo`，需要密码时由用户选择提供 sudo 密码、root 密码或改走零密码通道。
部署失败或用户拒绝时**不创建该对话、不发送该消息**，不存在「勾了 Overlay 却写真实磁盘」的
形态。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 1 节](../../docs/core/conversation-work-view.md#1-能力) | 修改 | 能力应答新增代理状态与派生字段；能力的唯一 owner 是 Core |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 4 节](../../docs/core/conversation-work-view.md#4-命名空间) | 修改 | 命名空间改由**常驻代理持有**；Core 自身不进命名空间、不 `unshare`、不 `exec`；补「不采用 `setns`」的理由与代执行边界 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 7 节](../../docs/core/conversation-work-view.md#7-失败路径) | 修改 | 「视图建立失败 → 工具按真实磁盘执行」改为 fail-closed；补代理缺失 / 自检失败 / 协议不匹配 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 9 节](../../docs/core/conversation-work-view.md#9-平台) | 修改 | 「非特权用户命名空间」不再是能力前提 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 3 节](../../docs/core/standalone-core.md#3-core-形态) | 修改 | 产物清单增代理可执行文件；Core 启动形态**不再**经代理 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节](../../docs/core/standalone-core.md#4-契约) | 修改 | `storageCapabilitiesRequested` 应答字段清单 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 6 节](../../docs/core/standalone-core.md#6-生命周期) | 修改 | 进程链是「宿主 → Core →（常驻）代理 → 工具」；Core 的 pid 不变，代理是可回收子进程 |
| [docs/core/core-remote.md](../../docs/core/core-remote.md) | [第 2.8 节](../../docs/core/core-remote.md#28-ssh-接入ssh-scheme) | 修改 | SSH 引导增加代理上传、远端提权安装与远端边界 |
| [docs/hosts/product-identity.md](../../docs/hosts/product-identity.md) | [第 1 节](../../docs/hosts/product-identity.md#1-定义处) | 修改 | 新增 `core.mountProxyName` / `core.mountProxyDir` 两项工程变量 |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | `sendMessage` 前的部署闸门与新增消息类型 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2.3 节](../../docs/architecture/events.md#23-uieventui--core单向) | 修改 | 新增会话存储转换事件 |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | `US-78`（本节新增） | 新增 | 部署提示、密码来源选择与知情同意的验收基线 |
| `docs/core/mount-proxy.md` | — | 新增 | 威胁模型、特权阶段时序、加固清单与已知限制独立成篇 |
| `docs/adr/0017-root-mount-proxy.md` | — | 新增 | 取舍决策与被否决的替代方案（file capabilities / root 属主 Core 副本 / 常驻 broker / 零提权） |

## 威胁模型与取舍

**代理不是沙箱，也不是权限降级装置**。它是一个面向本地用户的用户命名空间启用器：在限制
非特权用户命名空间的主机上，调用者本人建不出命名空间，代理让他建得出来。因此：

- 命名空间内拿到的 `CAP_SYS_ADMIN` 对**调用者本人**不是边界。产品 Core 自带 Bash 工具，
  只要能正常启动 Core 就能在同一命名空间里执行任意代码——**目标路径校验是卫生措施，不是
  安全边界**。
- 唯一的边界是：`uid_map` 只映射调用者自己的 real uid 一个条目（**不映射宿主 0**，因此命名
  空间内执行任何 setuid-root 文件时 setuid 位在内核里失效），以及挂载命名空间的传播隔离。
- 文件权限 `04755` 意味着**机器上任何本地用户都能调用它**。可回收的收窄只有两条，且都必须
  做：限定受众（安装期写允许的 real uid 列表，代理入口校验）、收窄能力（入口立刻裁剪
  capability bounding set）。
- 部署确认对话框是知情同意的唯一载体，必须点明「这是一个以 root 运行、带 setuid 位的程序」
  与「它会让你的账户能够创建系统当前限制的用户命名空间」。

取舍与被否决的替代方案见 `docs/adr/0017-root-mount-proxy.md`；已知限制（命名空间内仍可见宿主
`/proc`、PID / 网络命名空间与宿主共享、不承诺限制命名空间内的能力）写进
`docs/core/mount-proxy.md`。

## 用户场景与验收标准

- 场景 1：能力应答与入口
  - **AC-1**（FR-001）：GIVEN 限制非特权用户命名空间且代理未部署 WHEN 宿主查询文件存储能力 THEN 应答 `isolatedWorkView: false`、`mountProxy: 'absent'`、`deployable: true`，`reason` 点名代理缺失
  - **AC-2**（FR-001）：GIVEN 代理未部署 WHEN 查询能力 THEN `isolatedWorkView: false`、`mountProxy: 'absent'`；**不存在「代理未安装但能力可用」的组合**（Core 自身不进命名空间，命名空间只能由代理提供）
  - **AC-3**（FR-001）：GIVEN 非 Linux Core WHEN 查询能力 THEN `isolatedWorkView: false`、`deployable: false`，`reason` 点名平台
  - **AC-4**（FR-002）：GIVEN 能力当下不可用但 `deployable` 为 true WHEN 用户新建对话 THEN 空状态仍渲染「Overlay 对话」勾选框，且勾选框旁不出现任何部署前置提示文案
  - **AC-5**（FR-002）：GIVEN `deployable` 为 false（非 Linux 或内核无 overlayfs） WHEN 用户新建对话 THEN 整块入口不渲染
  - **AC-6**（FR-002）：GIVEN 能力可用（代理已就绪） WHEN 用户勾选并发消息 THEN 直接建会话，不弹任何部署或提权对话框
- 场景 2：部署闸门与知情同意
  - **AC-7**（FR-003）：GIVEN `isolatedWorkView` 为 false 且 `deployable` 为 true 且用户勾选 Overlay WHEN 用户发出第一条消息 THEN 弹出部署确认对话框，该消息没有进入 Core：不建会话、不落盘、会话列表不新增条目
  - **AC-8**（FR-003）：GIVEN 部署确认对话框 WHEN 用户逐项阅读 THEN 文案点名「以 root 运行且带 setuid 位」、完整安装落点、目标主机（远端场景）、以及「会让你的账户能够创建系统当前限制的用户命名空间」
  - **AC-9**（FR-003）：GIVEN 部署确认对话框 WHEN 用户选择取消 THEN 会话保持空状态、消息内容留在输入框、勾选态保留，没有任何提权命令执行、没有文件写入
- 场景 3：提权与密码来源
  - **AC-10**（FR-004）：GIVEN 用户已确认部署且免密 `sudo` 可用 WHEN 执行部署 THEN 不弹密码输入，直接安装
  - **AC-11**（FR-004）：GIVEN `sudo` 需要密码 WHEN 用户已确认部署 THEN 弹出三选一「提供 sudo 密码」/「提供 root 密码」/「显示命令自己执行」，密码框为遮蔽输入
  - **AC-12**（FR-004）：GIVEN 用户选择「显示命令自己执行」 WHEN 用户在自己的终端跑完 THEN 宿主检测到代理就位并按 FR-008 继续，全程没有密码经过宿主进程
  - **AC-13**（FR-004）：GIVEN 用户输入密码 WHEN 提权子进程启动 THEN 密码只写一行进该子进程的标准输入并立即关闭，不进 argv、不进环境变量、不进日志或诊断输出，宿主侧缓冲区用后清零
  - **AC-14**（FR-004）：GIVEN 单次部署连续认证失败 WHEN 用户继续提交凭据 THEN 每次都回到三选一并回显这次的原因，不设次数上限、界面不显示「剩余次数」
- 场景 4：安装形态
  - **AC-15**（FR-005）：GIVEN 部署成功 WHEN 检查落点 THEN `<core.mountProxyDir>/<core.mountProxyName>` 存在、属主 `root:root`、模式恰好 `04755`、父目录 `(mode & 0o022) == 0`
  - **AC-15b**（FR-005b）：GIVEN 槽位里存在随包代理产物（`pz:pz 0755`）且未安装 WHEN 查询能力 THEN `mountProxy: 'absent'`、`reason` 点名未部署，且 **Core 从未执行该文件**（不 `exec`、不取协议版本）
  - **AC-15c**（FR-005b）：GIVEN 已安装位点的文件属主不是 root 或模式不是 `04755` WHEN 查询能力 THEN `mountProxy: 'absent'`、`reason` 点名具体是哪一条不满足
  - **AC-16**（FR-005）：GIVEN `<core.mountProxyDir>` 不存在 WHEN 执行安装 THEN 报错点名该目录，不在其上创建任何目录、也不改到其它落点
  - **AC-17**（FR-005）：GIVEN 同内容的代理已在位 WHEN 再次部署 THEN 不重写文件；内容不同时以 root 侧生成的唯一临时名写入再原子换名，执行中的旧 inode 不受影响
  - **AC-18**（FR-005）：GIVEN 目标目录所在文件系统含 `nosuid`，或某个已存在的祖先分量非 root 属主 / 组或其他可写 WHEN 部署 THEN 拒绝安装并点名是哪一段，不静默换落点
  - **AC-19**（FR-005）：GIVEN 安装完成 WHEN 自检执行 THEN 断言命名空间内 `CapEff` 含 `CAP_SYS_ADMIN`、`uid_map` 恰好一行且映射真实 uid、命名空间内 `getuid() == 0`、宿主侧 `getuid()` 仍为真实 uid；任一不成立即判部署失败
  - **AC-20**（FR-005）：GIVEN 代理与 Core 的协议版本不一致 WHEN Core 启动 THEN 不引导、能力回 `absent`，`reason` 点名版本不匹配
- 场景 5：代理的特权阶段与拒绝面
  - **AC-21**（FR-006）：GIVEN 代理被非产品程序或 `getuid() == 0` 的调用者调用 WHEN 入口校验 THEN 非零退出并给出原因，不建命名空间
  - **AC-22**（FR-006）：GIVEN 代理正常执行 WHEN 写入映射完成 THEN 父进程立刻降回真实 uid/gid 并断言三个 id 全为真实值后才进入 `waitpid`；父进程在 Core 整个生命周期内不再持有 euid 0
  - **AC-23**（FR-006）：GIVEN 代理入口 WHEN 完成能力裁剪 THEN bounding set 只剩 `CAP_SETUID` / `CAP_SETGID` / `CAP_SYS_ADMIN`，目标进程带 `PR_SET_NO_NEW_PRIVS`
  - **AC-25**（FR-006）：GIVEN 代执行请求 WHEN 工具子进程退出 THEN 常驻代理正确收尸并把退出状态回传 Core，不以 `ECHILD` 提前退出
- 场景 6：进程链语义
  - **AC-26**（FR-007）：GIVEN Core 已拉起常驻代理 WHEN 宿主发送 `SIGTERM` / `SIGKILL` THEN Core 在 1 秒内退出；代理 A 与 B 均消失，`ps` 里无残留孤儿；Core 的 pid 与不经代理时一致
  - **AC-26b**（FR-007）：GIVEN 常驻代理已就绪 WHEN 检查进程树 THEN A 是 Core 的直接子进程、B 是 A 的子进程；A 降权后 `geteuid()` 为真实 uid 且不再持有任何特权，B 在命名空间内 `getuid()` 为 0
  - **AC-26c**（FR-007）：GIVEN Core 被 `SIGKILL`（来不及做任何清理）WHEN 观察代理 THEN B 读到 socketpair EOF 后自行退出、A 的 `waitpid` 返回后退出，全程不依赖 Core 主动 `kill`
  - **AC-27**（FR-007）：GIVEN Core 进程 WHEN 检查其自身状态 THEN `getuid()` 仍是调用者真实 uid、`/proc/self/uid_map` 只有宿主原始那一行映射、`CapEff` 不含 `CAP_SYS_ADMIN`——Core 自身不在任何命名空间里
  - **AC-28**（FR-007）：GIVEN 代理缺失、协议不匹配、`euid != 0`、命名空间建立失败 任一情形 WHEN Core 启动 THEN Core 照常启动并正常服务帧通道（`uname` 等请求有应答）、能力回 `absent`、原因进日志；**daemon 不观察到 Core 退出**
  - **AC-28b**（FR-007）：GIVEN 代理在运行中被杀 WHEN Core 继续服务 THEN 帧通道不断、后续请求照常应答，能力改判 `absent` 并在下次需要时重新拉起代理
  - **AC-28c**（FR-007）：GIVEN 用户从不使用 Overlay 对话 WHEN 观察进程表 THEN 没有任何代理进程被拉起
  - **AC-28d**（FR-007b）：GIVEN 代理以一次性形态执行 `--install` / `--self-check` / `--protocol-version` WHEN 执行完毕 THEN 进程退出，不持有命名空间
  - **AC-28e**（FR-007）：GIVEN 代理以真实 uid 运行 WHEN 它尝试写 `/etc/passwd` 等 root-owned 文件 THEN 内核以 `EACCES` 拒绝（命名空间内 uid 0 不改变宿主侧权限检查）；同一进程能改的只有该 uid 本来就能改的文件
  - **AC-28f**（FR-007）：GIVEN 工具子进程被 fork WHEN 检查它的 fd 表 THEN 不包含 Core ↔ 代理的 socketpair fd（全部 `CLOEXEC`），只有它自己的 stdin / stdout / stderr
  - **AC-28g**（FR-007）：GIVEN 隔离会话里有一条正在跑的长 Bash WHEN 用户点中止 THEN Core 发出 `cancel` 请求、代理 `kill(-pgid)`、该次工具调用以「已中止」结束；同会话的其它工具请求不受影响
  - **AC-28h**（FR-007）：GIVEN 隔离会话 WHEN 执行 Bash / Grep / Glob / git THEN 它们拿到的 `PATH` 与工作区模式一致（来自 Core 的 `shell_env`），不因经过代理而退化成代理进程继承的 PATH
  - **AC-28i**（FR-007）：GIVEN 隔离会话里 Bash 打印大量输出 WHEN 观察 Core 帧通道 THEN 无解析错误，代理的诊断只出现在 daemon 日志、不混入帧流
  - **AC-28j**（FR-007）：GIVEN 一次 `mountOverlay` 请求 WHEN 代理回 ok THEN 该挂载点已在**代理自己的** mountinfo 里恰好出现一次（应答前自查）；GIVEN `unmountOverlay` 回 ok THEN 代理 mountinfo 里已无该挂载点
  - **AC-28k**（FR-007）：GIVEN 两个会话同时首次使用同一个 `upper` WHEN 并发请求挂载 THEN 只挂一层（代理侧串行 + 挂载前查自己 mountinfo），不出现叠挂
- 场景 7：部署后接上原动作
  - **AC-29**（FR-008）：GIVEN 部署与自检成功 WHEN 宿主重查能力 THEN `isolatedWorkView: true`、`mountProxy: 'ready'`，宿主创建该 Overlay 对话并发送原来那条消息，用户无需重输；此路径**不要求重启 Core**，且**不弹部署成功提示**（对话框直接收起）
  - **AC-30**（FR-008）：GIVEN 部署成功但重查后能力仍为 `absent` WHEN 重查 THEN 按 FR-010 报错，会话保持空状态、消息仍在输入框
- 场景 8：fail-closed
  - **AC-31**（FR-010）：GIVEN 会话归属 `isolated` 但视图不可用 WHEN 调用 Read / Write / Edit / Grep / Glob THEN 返回明确错误，**不退回真实磁盘读写**
  - **AC-32**（FR-010）：GIVEN 能力不可用 WHEN 宿主尝试以 `storage: isolated` 建会话 THEN Core 拒绝该归属并回推事实，不在 `meta.json` 里留下永久的 isolated
  - **AC-33**（FR-011）：GIVEN 存量 `isolated` 会话在能力不可用时打开 WHEN 用户选择「转为真实工作区」 THEN 该会话的后续工具读写真实磁盘，界面不再标注 Overlay，且转换由用户显式触发
- 场景 9：远端、卸载与审计
  - **AC-34**（FR-009）：GIVEN SSH 远端 Linux 工作区且远端未部署代理 WHEN 用户在 Overlay 对话里发第一条消息 THEN 宿主经 SSH 上传代理并用远端提权装到同一位点，流程与本地一致
  - **AC-35**（FR-009）：GIVEN 远端 `/usr/libexec` 只读或不存在、远端 `sudo` 配置了 `requiretty`、或远端为共享机器 WHEN 部署 THEN 失败原因点名该项并可行动，不静默换落点、不改用其它提权工具
  - **AC-36**（FR-012）：GIVEN 代理已安装 WHEN 使用者需要移除 THEN 文档给出幂等的卸载命令与校验方式
  - **AC-37**（FR-012）：GIVEN 每次安装或升级 WHEN 完成 THEN Core 日志写一行审计记录，含主机名、落点、内容 sha256 与安装者 uid

## 功能需求

### FR-001：能力应答的根字段与派生字段

`UiRequest.storageCapabilitiesRequested` 的应答：

| 字段 | 角色 | 取值 | 含义 |
| --- | --- | --- | --- |
| `isolatedWorkView` | 根 | 布尔 | 此刻就能为对话建立 Overlay 视图。判据 = 常驻代理 B 已就绪**且**它报回 overlay 实测可挂。Core 自身不进命名空间，因此该字段为 true 必然意味着 `mountProxy == 'ready'` |
| `mountProxy` | 根 | `'ready'` / `'absent'` | 代理是否就位、协议版本匹配且自检通过 |
| `deployable` | **派生** | 布尔 | 部署代理是否**可能**解决当下的不可用（Linux + overlayfs 存在） |
| `reason` | 根 | 字符串 | 不可用的原因；`isolatedWorkView` 为 true 时为空串 |

`deployable` 由前两项派生，**推导点只有 Core 一处**（平台为 Linux 且内核有 overlayfs 且代理尚未就位）；宿主不重算、不缓存，每次需要都问 Core。

**`isolatedWorkView: true` 与 `mountProxy: 'absent'` 的组合不可达**：Core 不再自己建命名空间，
能力只能由常驻代理提供。旧规格里「本机允许非特权 userns 且代理未安装 → 能力可用」这条
整块移除。

**时效性**：`storageCapabilitiesRequested` 每次都反映**当前**连接状态，`isolatedWorkView` 不得
来自启动期缓存——代理随时可能消失（AC-28b）。`reason` 是事实描述而不是界面
文案，界面自行本地化；`deployable == true` 而 `isolatedWorkView == false` 时 `reason` 必须点名
代理缺失或版本不匹配。

### FR-002：入口渲染判据

「Overlay 对话」勾选框在新对话空状态的渲染判据是 `isolatedWorkView || deployable`：当下可用、
或可经部署变得可用，都渲染；两者都不成立时不渲染整块入口。渲染不等于立即可用——首次使用时
由 FR-003 的部署流程补齐，不允许出现「勾选后静默无效」的形态。入口本身**不带任何前置提示
文案**：需要部署时由宿主在发第一条消息时弹确认（FR-003），知情同意在那一刻给出，勾选框旁不
出现「首次使用需要部署」一类的说明。`isolatedWorkView == true` 时 `mountProxy` 必然为
`ready`，因此不存在「能力可用却提示部署」的形态。

### FR-003：首次使用的部署闸门

用户在勾选 Overlay 的状态下发出第一条消息时，宿主在把消息交给 Core 之前判据：

- `isolatedWorkView == true` → 走既有链路，**不弹任何部署或提权对话框**（此时代理必然已就位）。
- `isolatedWorkView == false && deployable == true` → 弹部署确认对话框；用户确认进入 FR-004，
  用户取消则**不创建该对话、不发送该消息**（会话保持空状态、消息留在输入框、勾选态保留、
  不执行任何提权命令、不写任何文件）。
- `deployable == false` → 入口本就不渲染（FR-002），走到这里说明接线错误，直接报错。

确认对话框的文案必须点明四项事实：这是一个以 root 运行且带 setuid 位的程序；完整安装落点；
目标主机名（远端场景必须显示）；它会让该账户能够创建系统当前限制的用户命名空间。文案走
i18n（`zh` / `en`）。

闸门判据**不以 `mountProxy` 为键**：代理未安装但能力本就可用时不得打扰用户。

### FR-004：提权顺序、密码来源与零密码通道

按固定顺序取得安装权限：

1. **优先免密 `sudo`**：先执行不带密码的 `sudo`；成功即安装，问题密。
2. **需要密码时三选一**：由用户选择「提供 sudo 密码」、「提供 root 密码」或「显示命令自己
   执行」。第三种是零密码通道：宿主把完整安装命令打印出来，用户在自己的终端执行，宿主轮询
   代理是否就位后继续——密码全程不经过宿主进程、天然兼容 `doas` / `pkexec` / 各种 sudo 时间戳
   策略，远端场景同样适用。
3. **密码传递的硬约束**：只写一行进提权子进程的标准输入随后立即关闭（不能留多余输入，否则
   sudo 会用它自己重试）；不进 argv、不进环境变量、不进日志与诊断输出；**禁止为密码路径分配
   pty**（pty 缓冲会留下回显）；宿主侧收到后立刻转成可清零的字节缓冲，用后清零；承载密码的
  消息类型在其 handler 第一条语句就声明不记录，不经过任何通用日志钩子；webview 侧只存在于
   一个 `useRef`，提交后置空，不进 `useState`。
4. **不设重试上限**：认证能试几次由服务端策略（`pam_faillock` / `sudoers` 等）决定，宿主
   既不设上限、也不显示「剩余次数」；连续失败时只如实回显这次的原因（账号锁定由服务端报错
   点名，不在宿主侧预判）。
5. **失败可换路**：任一来源失败（密码错误、不在 sudoers、`sudo` 不存在、root 登录被禁用）都
   回到三选一，允许改用另一条来源继续重试或取消；取消按 FR-003 处理。
6. **不猜、不降级**：三条来源都不可用时不退回「普通对话继续发消息」，也不静默改用其它提权
   工具。
7. **副作用留痕**：`sudo` 的时间戳会被刷新（默认数分钟），这是用户平时输入密码也会发生的
   副作用；规格不延长它、也不在结束后主动清掉用户的缓存（那属于改用户状态）。

### FR-005：产物名、安装落点、安装不变量与自检

**产物名**：`src/config/project.json` 的 `core.mountProxyName` 唯一给出，取值口径
`<extensionName>-mount-proxy`；源码、构建脚本、用例与文档一律经该变量或占位符
`<core.mountProxyName>` 引用（[docs/hosts/product-identity.md 第 2 节](../../docs/hosts/product-identity.md#2-消费方式)）。

**分发形态**：Linux 目标的可执行文件，与 Core 产物同目录，随同一份构建与上传链路走；**静态
链接**（与 Linux 发布产物同形态；动态链接会让 setuid 下的 `LD_*` 一族重新成为问题）；
Windows / macOS 目标不产出该文件。

**安装落点**：`<core.mountProxyDir>/<core.mountProxyName>`，`core.mountProxyDir` 取
`/usr/libexec`；属主 `root:root`、模式恰好 `04755`。`<core.mountProxyDir>` 不存在时报错并
点名它，安装器**不在其上创建任何目录**、也不改到其它落点。已存在的目录自身与每个祖先分量
必须是 root 属主且 `(mode & 0o022) == 0`，否则拒绝安装并点名是哪一段。所在文件系统挂载选项含
`nosuid` 时同样拒绝。所有拒绝都不静默改落点。

**安装不变量**：

1. **内容经管道、不经路径**：root 侧从标准输入读字节，源路径不参与安装命令——彻底消除源侧
   替换窗口，也消除「root 向攻击者指定位置写字节」的符号链接原语。
2. **临时名由 root 侧生成**（`mkstemp` 一类），不接受调用方传入的名字。
3. `fchown(root,root)` 与 `fchmod(04755)` 在 `rename` **之前**完成——不允许「先落到最终名再
   提权」，那会留下一个非 root 可写的 4755 窗口。
4. 换名用相对目录 fd 的 `renameat`（目录 fd 以 `O_DIRECTORY|O_NOFOLLOW` 打开），随后
   `fsync` 文件与目录。目标可能正被一个运行中的进程执行，换名只换目录项、旧 inode 继续服务。
5. root 侧把安装后文件的 sha256 打印到标准输出，宿主与随包文件比对后写进部署日志。
6. 远端命令不拼接任何用户可控字符串：固定 argv + 位置参数，路径经既有引用口径处理；密码
   永不进 argv / env。

**升级**：安装落点不计指纹，全部 Core 版本共享一份；按内容比对决定是否重装（内容相同不重写）。

**协议版本握手**：代理带一个协议版本，Core 启动时比对。不匹配时不引导、能力回 `absent`，
`reason` 点名版本不匹配，界面据此提示「需要重新部署」。改代理的前置语义必须递增该版本。

**自检归属唯一**：自检由代理自身（`--self-check`，不 exec 任何目标）实现，宿主只负责「装完 →
重查能力（FR-008）→ 重发被拦消息」，**不自己判 ready**。自检的断言见 AC-19。

**受众收窄**：安装期由 root 侧写一份允许的 real uid 列表（`root:root 0600`，追加去重，不是
单值——共享机器上多个用户互不覆盖），代理入口校验 `getuid()` 在该表内。

### FR-005b：代理定位判据

**只有已安装位点算「已部署」**：`<core.mountProxyDir>/<core.mountProxyName>`，且同时满足
`st_uid == 0`、`st_mode == 04755`、`(mode & 0o022) == 0`。任一条不满足即视为**未部署**，
`mountProxy` 回 `absent`、原因点名缺哪一条。

**随包目录里的同名产物永不执行**：它只作为「上传 / 安装的源」存在。Core 定位代理时**不**回退到
随包产物——那条回退在真机上导致过一次故障：槽位里的 `pz:pz 0755` 文件被当成可执行代理，
`exec` 后代理因 `euid != 0` 拒绝，而 `exec` 已替换进程映像，退出码成了 Core 的退出码。

对应地，「随包产物缺失」与「代理未安装」是两个不同的原因，`reason` 要分清：前者说明构建不完整，
后者说明需要部署。

### FR-006：特权阶段的时序、加固与拒绝面

**入口自检**：`geteuid() != 0` 直接报错退出（`nosuid` 挂载或被剥掉 setuid 位时静默继续会得到
「看起来建了命名空间其实没有 `CAP_SYS_ADMIN`」的假成功）；`getuid() == 0` 拒绝（`uid_map` 会
写成 `0 0 1`，命名空间内 root 等于宿主 root）；调用者不在 FR-005 的 uid 列表内拒绝。

**请求收紧**（入口即做）：把 capability bounding set 裁到 `CAP_SETUID` / `CAP_SETGID` /
`CAP_SYS_ADMIN` 三项；`umask(0o077)`；`chdir("/")`；把全部信号处置复位为默认并清空信号掩码；
不读任何环境变量（目标路径只来自 argv，不用 `system` / `popen`，不读 `TMPDIR` / `PATH`）。

**特权阶段顺序**（每一步的顺序都是约束，不可重排）：

1. 父进程仍是 host root，`open(path, O_PATH|O_NOFOLLOW|O_CLOEXEC)` 打开目标**一次**并
   `fstat` 校验（见下）。
2. `fork`；子进程立刻设 `PR_SET_PDEATHSIG(SIGKILL)` 并回读 `getppid()` 与记录的父 pid 比对
   （防父进程在 `prctl` 之前就死），随后 `unshare(CLONE_NEWUSER)`，通过管道告诉父进程「已
   unshare」，然后**阻塞等待 ack**。
3. 父进程写 `/proc/<pid>/setgroups` = `deny`，再写 `uid_map`（恰好一行 `0 <real_uid> 1`）、
   `gid_map`（恰好一行 `0 <real_gid> 1`）；顺序固定，`setgroups` 必须在 `gid_map` 之前。
4. 父进程**不做 `waitpid`、不 double-fork、不用 `CLONE_PARENT`**——子进程在父进程收尸之前是
   僵尸，pid 因此不会被复用，这是「不会写到错误进程的映射」的支点。
5. 父进程写完映射后 `setresgid(real,real,real)` → `setresuid(real,real,real)`（顺序不可反，丢了
   euid 就 setgid 不了），用 `getresuid` / `getresgid` 断言三个 id 全为真实值，然后
   `close_range` 关掉继承的 fd、只保留同步管道。
6. 父进程 ack；子进程在 ack 之后才 `unshare(CLONE_NEWNS)` + 把 `/` 设为 `MS_REC|MS_PRIVATE`，
   设 `PR_SET_NO_NEW_PRIVS`。`CLONE_NEWNS` 必须在映射写完之后（否则挂载命名空间归父 userns
   所有，`MS_PRIVATE` 会 `EPERM`）。此后子进程**就是常驻代理本体**——它持有命名空间，等待
   Core 的代执行请求（FR-007b），不再 `exec` 任何目标程序。
7. 父进程（= A）**不退出**：降权后转入 `waitpid(B)` 循环，此后只做收尸，不持任何特权。
   A 不能提前退出的两个硬理由：B 已在新 userns 里、自己写不了 `uid_map`（需父 userns 的
   `CAP_SETUID`）；且 A 退出会让 B 被 reparent。
8. **`PDEATHSIG` 必须在凭证变更之后设置**：`prctl(2)` 明确「effective user ID / effective
   group ID / filesystem user ID / filesystem group ID 变更会**清除** parent-death signal」。
   A 在 `setresuid` 之后才设「指向 Core」的 `PDEATHSIG`；B 在 `setresuid(0,0,0)` 之后才设
   「指向 A」的。顺序写反则兜底实际不存在（`mount-proxy-rs/src/privilege.rs` 现状就是
   先设后改凭证，需一并修正）。
9. **回收主路径是 socketpair EOF，不是 `PDEATHSIG`**（见 FR-007b）。`PDEATHSIG` 只兜底
   「A 异常死亡」这一种情形。
10. 子进程等 ack 必须有超时；父进程写映射失败必须 `kill` 子进程再退出，不留无映射的孤儿。

**一次性模式**分两类：

| 模式 | 走特权阶段吗 | 理由 |
| --- | --- | --- |
| `--self-check` / `--protocol-version` | 是 | 需要真建一次命名空间来验证本机支持 |
| `--install` / `--uninstall` | **否** | 由 root 直接运行（`sudo` 拉起，取 `SUDO_UID` 作为允许列表写入值），只做文件落盘，不建 userns。它也不满足入口自检的 `ruid != 0` 条件——那个条件是给「被普通用户调用」的形态准备的 |

一次性模式在第 6 步之后执行对应动作并退出，不进入代执行循环、不持有长期命名空间。

**不再有「目标程序」这一概念**：旧架构里代理 `exec` 一个目标（Core），因此有
`O_PATH|O_NOFOLLOW` 打开 + `fstat` 校验 + `execveat(AT_EMPTY_PATH)` 那一整套 TOCTOU 防护。
新架构下 A 不 `exec` 任何目标、B 只 `fork` 工具进程，这套机制没有对象——相关代码与 AC 一并
删除，不要留下没有调用方的死代码。

**输出纪律**：代理自己的 fd 1 / fd 2 只用于它自己的帧通道与诊断。**工具子进程一律由 B 新建
三条管道**，工具绝不继承代理的 fd 1 / fd 2——否则工具的输出会直接写进 Core 的帧流，一帧就废。

### FR-007：命名空间由常驻代理持有，Core 自身不进命名空间

**架构形态**（参照 Chrome 的 `chrome-sandbox` + zygote）：

```text
daemon ──spawn──▶ Core（帧循环，**永不进入命名空间**）
                    │
                    │ 需要 Overlay 能力时 spawn + socketpair
                    ▼
                  代理 A（setuid 启动，euid 0；写完 id 映射后降回真实 uid 常驻）
                    │
                    └─ fork ──▶ 代理 B（在用户 + 挂载命名空间里；真正干活的那个）
                                  └─ fork ──▶ 工具子进程
```

**A 与 B 的分工**（这是本架构的关键，不能简化成一个进程）：

| 进程 | 父进程 | 身份 | 职责 |
| --- | --- | --- | --- |
| A | **Core**（`spawn` 出来） | 启动时 euid 0；写完映射后 `setresuid` 降回真实 uid | `fork` B、写 B 的 `uid_map` / `gid_map`、`waitpid` 收尸 B |
| B | A | 真实 uid（命名空间内 uid 0） | 持有命名空间、收 Core 的帧、`fork` 工具子进程 |

**A 必须存在且不能提前退出**：进入新用户命名空间的进程无法自己写 `uid_map`——写映射需要
**父 userns** 的 `CAP_SETUID`，而 B 已经在新 userns 里。A 留在父 userns 才写得成。A 一旦
退出，B 会被 reparent，而 B 的 `PR_SET_PDEATHSIG` 绑在 A 上，A 的死会立刻杀掉 B。

- **Core 进程自身不 `exec`、不 `unshare`、不进任何命名空间。**
- **Core 的启动与帧服务与代理完全解耦**：代理不存在、协议版本不匹配、自检失败、提权被拒、
  命名空间建立失败——任何一种都只让 `mountProxy` 回 `absent`、`isolatedWorkView` 回 false，
  **Core 照常启动、照常服务帧通道、daemon 不重启**。
- **代理按需拉起、可随时缺位**：代理只在需要 Overlay 能力的操作上被 spawn；它不常驻于
  Core 启动路径。用户从不使用 Overlay 对话时不产生任何进程。
- **不采用 `setns`**：内核不允许进程加入一个既有的用户命名空间后取得其 capability，
  「让代理建好空间、Core 再进去」这条路在 Linux 上不通。Core 要访问叠加视图，只能通过
  代理代执行的子进程，不能自己读挂载点。
- **代执行边界**：凡是需要看到叠加视图的 Core 侧操作（Bash、Read、Write、Edit、Grep、Glob、
  `workViewFilesRequested`、`workViewChangesRequested`、`workViewFileDiffRequested`）都经代理
  代执行，而不是 Core 自己 `open()`。代理代执行时 **fd 1 / fd 2 语义不变**（fd 1 只走帧数据，
  诊断走 fd 2）。
- **零额外提权**：B 代执行工具时**不再**执行 setuid 提权——它已在自己的命名空间里，工具只是
  它 `fork` 出来的普通子进程。setuid 只在 A 启动的那一刻起作用。
- **失败不带走 daemon**：任一环节失败都必须转成「能力不可用 + 原因」，不得以非零退出码结束
  Core 进程，也不得让 daemon 观察到 Core 退出。
- **代理的写权限不是新的边界**：B 以真实 uid 运行（威胁模型见 `docs/core/mount-proxy.md`，未落地），
  它能改的只有该用户本来就能改的东西（`~/.bashrc`、工作区文件）。`/etc/passwd` 这类
  root-owned 文件仍由内核按映射后的真实 uid 拒绝——命名空间内的 uid 0 不改变宿主侧的权限
  检查。因此代理侧的路径校验**是卫生措施，不是安全边界**。
- **fd 纪律**：A 与 B 之间、以及 socketpair 两侧的 fd 全部设 `CLOEXEC`，工具子进程**不得**
  继承 Core ↔ 代理的通信 fd；否则工具里的任意代码可以直接伪造应答。工具子进程的
  stdin / stdout / stderr 全部由 B **新建管道**，代理自己的 fd 1 / fd 2 不传给工具。
- **控制语义留在 Core**：超时判定、中止（`ctx.cancel`）、超时后的自动后台化仍由 Core 决定，
  翻译成 `cancel` / `kill` 请求发给代理；代理收到后 `kill(-pgid)` 并回 `exit`。Core 不再持有
  `Child` 句柄，因此**不能**自己 `kill`——协议必须提供这条通道，否则隔离会话里的 Bash 无法
  中止、死线也失效。
- **环境变量由 Core 构造**：`PATH` 等沿用 `shell_env` 的结果，作为 `spawn.env` 显式传给代理；
  代理只 `execve` 传入的 envp，**不读自己的环境变量、不跑 `$SHELL -lc`**。这与 FR-006
  「不读环境变量」不矛盾——那条约束的对象是代理自身的启动环境（防注入），不是工具的环境。
- **协议格式是长度前缀 + base64 字段的行记录，不是 JSON**：代理是**零第三方依赖**的纯
  std crate（它能以 setuid root 运行、静态链接的前提），不能引 serde。每个字段单独
  base64 编码后以 TAB 连接，因此任何二进制 / 控制字符都不会破坏分帧；外层仍是 4 字节大端
  长度前缀（与 Core 帧通道同口径）。
- **请求并发**：协议里每个请求带 `id`，应答按 `id` 关联。Core 侧 `ProxyClient` 支持多请求在途
  （读线程分派 + pending 表），否则一条长 Bash 会把同一会话的 Read 卡住；代理侧
  `mountOverlay` / `unmountOverlay` 串行互斥，`spawn` 可并发。
- **挂载的校验与卸载都在代理侧闭环**：Core 的 `/proc/self/mountinfo` 永远看不到 B 的挂载，
  因此三件事必须由 B 自己做——(1) `mountOverlay` 应答前自查**自己的** mountinfo，确认该挂载点
  恰好出现一次（否则报错而不是回 ok）；(2) `unmountOverlay` 循环 `umount` 直到自己的
  mountinfo 里消失才回 ok；(3) 「同一 `upper` 不得叠挂两层」由代理侧挂载前查自己 mountinfo +
  串行请求保证，Core 的登记表锁退化为会话级去重。缺这三条会让 `remove()` 去 `remove_dir_all`
  一个仍是挂载点的目录而 `EBUSY`，视图与挂载双双残留（`specs/defects/work-view-concurrent-first-use-double-mounts.md`
  的形态）。

### FR-007b：代理的两种运行形态

| 形态 | 触发 | 生命周期 | 是否持命名空间 |
| --- | --- | --- | --- |
| 一次性 | 安装 / 自检 / 协议版本查询（`--install` / `--self-check` / `--protocol-version`） | 执行完即退出 | 否 |
| 常驻 | Core 需要 Overlay 能力 | 与该工作区 Core 同寿命，Core 退出即回收 | 是 |

常驻形态的约束：

- **A 是 Core 的子进程**：pid 由 Core 持有，daemon 观察到的 Core pid 不变。B 是 A 的子进程，
  被 reparent 后不再是任何人的语义子进程，但它只通过 socketpair 与 Core 通信。
- **回收靠 socketpair EOF，不靠 `PDEATHSIG`**：Core 死 → 它持有的 socket 端关闭 → B 读到 EOF
  → B 退出 → A 的 `waitpid` 返回 → A 退出。这条链不依赖进程父子关系，因此覆盖 Core 被
  `SIGKILL` 的情形。`PR_SET_PDEATHSIG` 只用于 A←Core 这一段（A 直接是 Core 的子进程），
  B 的 `PDEATHSIG` 指向 A，仅作为 A 异常死亡时的兜底。
- **A 在写完映射后降回真实 uid，但不退出**：它此后只剩 `waitpid` 一个职责，不持有任何特权。
- 代理崩溃或被杀时，Core 把能力改判为 `absent` 并在下一次需要时重新拉起；不重启 Core、
  不断帧通道。
- 常驻代理**不接收**来自 Core 之外的请求：只经 Core 与它之间的私有 socketpair 通信。

### FR-008：部署完成后接上原动作

命名空间不再由 Core 在启动早期持有，因此**部署成功后不需要重启 Core**：宿主重新查询能力
（Core 重新拉起常驻代理并确认命名空间可用）即可。

- 能力转为 `isolatedWorkView: true` → 创建该 Overlay 对话并发送原来那条消息，用户不需要重发
  或重新勾选；期间界面显示进度。
- **成功不弹提示**：部署成功后对话框直接收起，不显示「已部署」一类的结果态或通知——成功是
  用户本来就要的结果，打断一次没有意义。进度态本身就是唯一的反馈。
- 能力仍为 `absent` → 按 FR-010 报错，会话保持空状态、消息仍在输入框；**只有失败留在界面上**
  说明原因。
- 重启 Core 仍是**允许**的手段（配置变更等场景复用既有策略），但不再是部署成功后的必需步骤。

### FR-009：远端 SSH 工作区的边界

SSH 远端 Linux 工作区走同一套逻辑：宿主把代理随 Core 一起上传，在远端执行同一份安装与自检；
远端 `sudo` 与 root 密码的采集、遮蔽输入、不落盘约束、零密码通道与本地一致。远端部署完成后
重查能力（FR-008），Core 拉起的常驻代理在远端建命名空间。

远端的额外边界：上传也走「内容经管道进 root 侧标准输入」，不在远端落用户可写的暂存文件
（需要给远端 exec 增加标准输入入参）；`/usr/libexec` 不存在、`/usr` 只读、文件系统 `nosuid`
都按 FR-005 拒绝并点名该项；远端 `sudo` 配置了 `requiretty` 或 `use_pty` 时失败原因点名该项并
给出可行动提示；安装命令不拼接任何用户可控字符串。远端常是多人共用的开发机——确认对话框
必须点名主机名，安装写进审计记录（FR-012），并保证有卸载路径。

### FR-010：工具侧 fail-closed 与拒绝落盘

- `ToolContext` 的工作视图字段按三态判别：`workspace`（按真实磁盘）/ `view(handle)` /
  `viewUnavailable(reason)`。第三态下路径解析**返回错误**，不退回真实路径。
- 「该会话不是隔离归属」与「隔离归属但视图不可用」是两件事：前者正常走真实磁盘，后者必须变成
  工具错误。视图建立失败不得被当成「没有视图」。
- 能力不可用时 Core **拒绝以 `storage: isolated` 建会话**：不把该归属写进 `meta.json`（否则
  这个会话永久是 isolated 且每次工具调用都失败），并回推事实给宿主。
- 已在 Overlay 归属的会话期间代理失效：Core 重启后新视图无法建立 → 工具返回明确错误，改动
  **不落真实磁盘**；不把会话自动改成 `workspace` 归属（改动归属由 FR-011 的用户显式动作完成）。

### FR-011：存量隔离会话的显式出路

能力不可用时，存量的 `isolated` 会话不能变成「只能看不能动」。提供一个**用户显式触发**的动作
「把该对话转为真实工作区」（`UiEvent`，登记进
[docs/architecture/events.md 第 2.3 节](../../docs/architecture/events.md#23-uieventui--core单向)）：
转换
后该会话的后续工具读写真实磁盘，界面不再标注 Overlay。这是用户决定，不是自动降级，因此不破
「不过度 fallback」；不做自动转换。

### FR-012：卸载路径与安装审计

- 文档（`docs/core/mount-proxy.md`）给出**一条幂等的卸载命令**与「如何确认已移除」的校验
  方式。不做 GUI 卸载按钮（见非目标），但不能没有可执行的卸载路径。
- 每次安装或升级，Core 日志写一行审计记录：主机名、落点、内容 sha256、安装者 uid。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 非 Linux Core | `deployable: false`，入口不渲染 |
| 代理未安装 / 版本不匹配 / 提权被拒 / 命名空间建立失败 | 能力 `absent` 并点名原因；**Core 照常启动并服务帧通道，daemon 不观察到退出** |
| 槽位里有已分发的代理产物但未安装（`root:root` + setuid 未生效） | 该产物**不**被当作可执行代理；能力 `absent`，界面在发第一条消息时弹部署确认（入口不预先提示） |
| 常驻代理在运行中被杀 | 帧通道不断；能力改判 `absent`，下次需要时重新拉起 |
| Core 退出 / 被 kill | 常驻代理经 `PR_SET_PDEATHSIG` 与 Core 显式回收双保险被清理，不留孤儿 |
| 用户从不使用 Overlay 对话 | 不拉起任何代理进程 |
| Linux 但内核无 overlayfs | `deployable: false`，`reason` 点名该项；不提示部署（装代理也解决不了） |
| 本机允许非特权用户命名空间但代理未安装 | 仍是 `isolatedWorkView: false` + `deployable: true`——Core 不再自己建命名空间，能力必须由代理提供 |
| 用户在部署确认框取消 | 对话不创建、消息留在输入框、勾选态保留，无提权动作 |
| `sudo` 不存在 / 用户不在 sudoers / `Defaults requiretty` | 失败原因点名该项，回到三选一，可改用零密码通道 |
| sudo / root 密码错误 | 同上；不限次数，每次回显这次的原因，账号锁定由服务端报错点名 |
| root 登录被禁用（无密码 / shell 被封） | 报错点名该原因，停在对话框 |
| `sudo` 的 `timestamp_timeout=0`（每次都要密码） | 两步式提权在第二步失败时明确报错并引导改用零密码通道，不偷偷退回路径复制 |
| 目标目录祖先非 root 属主或组 / 其他可写 | 拒绝安装并点名是哪一段 |
| 目标目录所在文件系统 `nosuid` | 拒绝安装并说明 setuid 位不生效，不改落点 |
| 产品子目录不存在 | root 侧以 `0755 root:root` 创建；`<core.mountProxyDir>` 之上不创建 |
| 目标位点已有内容相同的代理 | 不重写文件，直接自检 |
| 目标位点已有内容不同的代理且正被运行中的进程执行 | 临时名 + `renameat` 换名，旧 inode 继续服务 |
| 安装中途失败（磁盘满 / 权限） | 报错并清掉本次临时文件，不留半截产物；能力仍 `absent` |
| 自检断言不成立（`CapEff` 缺 `CAP_SYS_ADMIN` / `uid_map` 非一行 / 命名空间内非 uid 0） | `mountProxy: 'absent'`，`reason` 点名断言，对话不创建 |
| 代理协议版本与 Core 不匹配 | 不引导，`reason` 点名版本，界面提示重新部署 |
| 代理被以非产品程序或 `getuid() == 0` 调用 | 拒绝执行，非零退出并给出原因 |
| 代理被以 `SIGCHLD` 设为 `SIG_IGN` 的父进程拉起 | 仍正确收尸并传出状态，不以 `ECHILD` 提前退出 |
| 容器内 `/proc` 未挂载 | 写映射必然失败；前置检查并给明确原因 |
| Core 重启后代理不在位 | 新视图无法建立 → 工具返回明确错误，不落真实磁盘 |
| 存量 `isolated` 会话在能力不可用时打开 | 工具报错，界面提供「转为真实工作区」的显式动作 |
| 远端 `/usr` 只读 / `/usr/libexec` 不存在 / `nosuid` | 拒绝安装并点名该项 |
| 远端 `sudo` 配置 `requiretty` / `use_pty` | 失败原因点名该项，可改用零密码通道 |
| 远端为共享机器 | 确认对话框点名主机名；安装写审计行；文档给出卸载路径 |
| 两个工作区同时首次部署 | 安装串行化：同一位点只写一次，第二个观察内容一致后直接自检 |

## 非目标

- **sudoers 免密规则**：不写 `/etc/sudoers.d/` 任何条目；执行期靠 setuid 位取得 root 身份，
  安装期靠用户提供的一次性密码或零密码通道（去向：本 spec 的 FR-004 / FR-005）。
- **指纹化的代理位点**：代理暂不按 Core 构建指纹分槽，全部版本共享一份，按内容比对升级，靠
  协议版本握手兜住语义漂移（积累到需要并存时另行设计，去向：
  [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。
- **限制命名空间内的能力**：不承诺限制调用者在命名空间内能做什么（挂载任意 userns 可挂文件
  系统、建 netns、`mknod` 等）——对调用者本人那不是边界（去向：「威胁模型与取舍」）。
- **密码持久化 / 凭据管理**：不做密码记忆、钥匙串集成或免密重装。
- **把全部文件 IO 无差别交给代理**：只有需要看到叠加视图的操作走代执行；工作区外的路径、
  非 Overlay 会话、以及配置读写仍由 Core 直接访问磁盘。
- **代理长期以 root 身份运行**：常驻代理在建立命名空间并写完映射后立刻降回调用者的真实
  uid / gid，此后只在自己持有的命名空间内以普通用户身份 fork 工具进程。特权窗口仅限
  `fork` 到 `setresuid` 之间。
- **多工作区共享一个常驻代理**：一个常驻代理只服务一个 Core（一个工作区），不跨工作区复用
  ——命名空间状态与工作区视图绑定。
- **GUI 卸载按钮**：只提供文档化的幂等卸载命令（去向：FR-012）。
- **macOS / Windows 上的等价能力**：本改动只服务 Linux Core。
- **代理的自动静默升级**：升级只在用户下次使用 Overlay 对话时按 FR-003 触发。

## 对需求基线的影响

新增 US-78「Overlay 对话的挂载代理部署」，登记在
[docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md)，
覆盖部署确认、取消语义、三选一密码来源、遮蔽输入、知情同意文案与账号锁定保护。

e2e 覆盖：对话框、三选一与遮蔽输入是纯 webview 交互，用假宿主消息驱动，新增
`e2e/webview/overlayMountProxy.spec.ts`（部署确认、取消后不建会话、三选一、遮蔽输入、失败后
不限次数重试、成功不弹提示）。真实提权安装与 overlay 挂载不进 CI 车道（需要一台允许 root 提权的
Linux 机器），按既有口径登记豁免：特权集成断言用仓库既有的 `markSkipped()` 口径（检测到
`geteuid()==0` 且代理 4755 在位才跑，否则跳过并打印原因），由有 root 的 Linux 机器手工验证。

## 追溯矩阵

矩阵登记的是**目标落点**（重新实施时应写在哪、测试落在哪），不代表这些文件当前存在——本轮
实施的代码已还原，实现落点全部待重建。

| 需求 | 实现落点（待重建） | 测试落点（待重建） | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `UiRequest.storageCapabilitiesRequested` 应答（`mountProxy` 根字段 + `deployable` 唯一推导点） | `core-rs` 能力应答单测 + `src/test/storageCapabilitiesRouting.test.ts` | 自动 |
| FR-002 | `setStorageCapabilities` 消息与 `MessagesView` 的入口判据 | `e2e/webview/overlayMountProxy.spec.ts` | 自动 |
| FR-003 | `WebviewMessageHandler.handleUserMessage` 的部署闸门 + 新增 wire 消息 | `src/test/mountProxyGate.test.ts` + `e2e/webview/overlayMountProxy.spec.ts` | 自动 |
| FR-004 | `src/host/mountProxyInstall.ts`（提权顺序 / 密码来源 / 零密码通道 / 不限次数的失败重试） | `src/test/mountProxyInstall.test.ts` + e2e 三选一与遮蔽输入 | 自动 |
| FR-005 | 安装不变量、祖先校验、自检、协议版本握手、uid 列表 | `src/test/mountProxyInstall.test.ts` + 代理 `--self-check` 的 `markSkipped()` 特权车道 | 自动 |
| FR-005b | 代理定位判据（只认 `/usr/libexec` 下 `root:root` + `04755`） | 定位函数单测（槽位 0755 产物不回 ready） | 自动 |
| FR-006 | 代理特权阶段时序与加固（`core-rs` 新模块） | 纯函数矩阵（目标校验 / `uid_map` 文本 / 顺序）单测 + `markSkipped()` 特权车道 | 自动 |
| FR-007 | Core 启动早期的代理引导与进程链语义 | `core-rs` 启动路径单测（幂等 / 判据 / 缺失降级留痕）+ 特权车道的信号语义断言 | 自动 |
| FR-008 | 宿主侧「装完 → 重查能力 → 重发被拦消息」（**不再重启 Core**，`mountProxyGate.finish()` 删除 `restartCore`） | `src/test/mountProxyGate.test.ts`（假 Core 能力桩） | 自动 |
| FR-009 | 上传走管道、远端安装与远端边界表 | `src/test/sshDaemonBootstrap.test.ts`（假 SSH） | 无自动覆盖 + 真实远端安装需可提权的 SSH 机器，按既有口径由 `npm run test:e2e:ssh` 手工执行 |
| FR-010 | `ToolContext` 三态 + 路径解析错误 + 拒绝落盘 isolated | `core-rs` 工具错误路径单测 + `main_tests` 的拒绝落盘用例 | 自动 |
| FR-011 | 会话存储转换 `UiEvent` 与宿主翻译 | `core-rs` 转换语义单测 | 自动 |
| FR-012 | 卸载命令文档与安装审计日志行 | `src/test/mountProxyInstall.test.ts`（审计行形状）+ 文档里的卸载命令可执行性人工核对 | 自动 |

## 待澄清

已清零。评审阶段定下的决定与去向：

- 用户拒绝部署或提权全失败时「阻止创建、消息不发」（去向：FR-003 与 AC-7 / AC-9）。
- 执行期不写 sudoers 免密规则，改由 root 属主 + setuid 位取得 root 身份，并在入口裁剪
  bounding set（去向：FR-005 / FR-006 与非目标第 1 条）。
- 代理随 Core 打包、暂不按指纹分槽，落到 `<core.mountProxyDir>`，靠协议版本握手兜住语义漂移
  （去向：FR-005 与非目标第 2 条）。
- 保留 setuid root 形态而不用 file capabilities：只用 `cap_setuid,cap_setgid` 过不了限制非特权
  用户命名空间的那道闸（它的判据是本命名空间内的 `CAP_SYS_ADMIN`），而加上 `cap_sys_admin`
  并不比 root 窄，却换来 xattr 依赖、`nosuid` 同样失效、硬化扫描漏检（去向：
  [ADR-0017](../../docs/adr/0017-root-mount-proxy.md) 的被否决方案）。
- **不用 `setns` 让 Core 加入代理的命名空间**：内核不允许进程加入一个既有的用户命名空间后
  取得其 capability，「代理建好空间、Core 再进去」在 Linux 上不可实现。命名空间因此由常驻
  代理持有、工具进程从代理 `fork` 继承（去向：FR-007）。
- **Core 不再 `exec` 进命名空间**：`exec` 会替换 Core 进程映像，代理的任何拒绝都会变成 Core
  的退出码并触发 daemon 重启。改为「Core 不 exec、不 unshare、不进命名空间」（去向：FR-007
  与 FR-007b）。

## 实施现状

**本轮实施的代码已全部还原到库上版本**。工作树只保留本 spec、两份 ADR 与 plan 的
「实施注意事项」一节；`mount-proxy-rs/`、`core-rs/src/mount_proxy/`、宿主侧 `mountProxy*`
模块、`MountProxyDialog`、两条 e2e 用例与 `docs/core/mount-proxy.md` 均已删除，`tasks.md`
的勾选全部复位。

还原的直接原因：跨平台编译无法收敛。本轮改动只在 Linux 目标下验证过，而 `npm run package`
必须同时构建 Windows 目标，Windows 上没有 `std::os::unix`，代理相关模块与调用点需要逐处
`#[cfg(target_os = "linux")]`；修一处、露一处，始终没能让打包通过。本机又缺 C 工具链
（`ring` / `zstd` 编译不过），Rust 改动连 `npm run test:core` 都跑不了，反馈只有「能否编译」
这一条，继续盲改的风险大于收益。

**这不否定方案本身**。ADR-0017 / 0018 记录的取舍与架构结论都是实测得到的，仍然有效：

- `exec` 进命名空间这条路线在真机上确实炸了（`core exited unexpectedly (code=Some(70))`，
  5 次重启后放弃，整条连接不可用），根因是 `exec` 与「失败不阻塞启动」不可共存；
- 常驻代理持命名空间 + `fork` 工具进程的形态成立，`setns` 确实不可行；
- 代理定位判据必须只认 `/usr/libexec` 下 `root:root` + `04755`，随包产物永不执行。

重新实施时按 [plan.md 的实施注意事项](plan.md#实施注意事项)执行，尤其是第 1 条（先验
Windows 目标编译）与第 4 条（本机无法跑 Rust 测试，行为验证必须上真机）。

## 收敛记录

尚未收敛。上一轮实施留下的事实性结论如下，均已在真机或真实打包产物上核对过，可作重新
实施的输入：

- **架构结论（有效）**：FR-007 / FR-007b 的「常驻代理持有命名空间」形态经论证成立；
  `exec` 形态实测致命，见上文与 [ADR-0018](../../docs/adr/0018-resident-mount-proxy.md)。
- **安装判据（有效）**：槽位里的随包产物即使 `0755` 也不得执行。上一轮远端
  `8.136.22.171` 的活跃槽位只有 `<core.binaryName>`，`<mountProxyDir>` 下无代理，因此远端
  Overlay 始终不可用——这条既解释了故障，也确认了 FR-005b 的必要性。
- **打包路径（有效）**：Electron 分发包里随包资源在 `app.asar.unpacked/dist/resources/`，
  按 `app.asar/resources/` 找必然失败；架构须取目标而非宿主（宿主 arm64 装 x64 远端时按
  `process.arch` 会挑错目录）。
- **界面形态（有效）**：部署对话框必须是模态层（`fixed inset-0` + 遮罩 + `z-index`），只写
  `backgroundColor` 会退化成流内普通块；Escape 要生效必须把焦点收进遮罩。
- **未验证项**：修复后的代理装机、自检、隔离会话行为**没有任何一项在真机上跑过**。上一轮
  e2e 与单测全绿针对的是已被删除的那份实现，不能作为本 spec 的证据。

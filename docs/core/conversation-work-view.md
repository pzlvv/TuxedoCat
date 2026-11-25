---
owner: pzlvv
last_reviewed: 2026-11-25
---

# 规格：Overlay 对话工作视图

本文描述「Overlay 对话」的执行形态：一个对话的 Read / Write / Edit / Bash / Grep 看到
「真实工作区 + 本对话改动」的叠加结果，改动不污染磁盘，对话之间互不可见。磁盘是唯一基线
事实——磁盘上后来新增、修改、删除的文件，对话中立即可见，不需要任何同步动作。

能力由 Core 判据给出，宿主只转发；只在 Linux Core 上可用。

## 1. 能力

`UiRequest.storageCapabilitiesRequested` 应答 `{ isolatedWorkView, mountProxy, deployable, reason }`：

| 字段 | 角色 | 含义 | 判据 |
| --- | --- | --- | --- |
| `isolatedWorkView` | 根 | 此刻就能为对话建立 Overlay 视图 | 常驻挂载代理就绪**且**它报回 overlay 实测可挂 |
| `mountProxy` | 根 | 代理是否就位 | `'ready'` / `'absent'`：安装判据、协议版本、自检三者全过才是 ready |
| `deployable` | 派生 | 部署代理是否**可能**解决当下的不可用 | Linux 且内核有 overlayfs；代理已就绪时恒 false |
| `reason` | 根 | 不可用的原因；可用时为空串 | 点名代理缺失 / 版本不匹配 / 自检失败哪一项 |

`deployable` 的推导点只有 Core 一处，宿主不重算、不缓存。`isolatedWorkView: true` 与
`mountProxy: 'absent'` 的组合不可达：Core 不建命名空间，能力只能由代理提供。

界面在 `isolatedWorkView || deployable` 时渲染入口。两者都不成立时整块入口不出现——不给
「勾选后静默无效」的形态。入口本身不带任何前置提示：需要部署时由宿主弹确认。

部署确认有两个入口，判据只有一份（`isolated` 归属 **且** `isolatedWorkView === false`
**且** `deployable === true`）：

| 入口 | 时机 | 部署成功 | 部署失败 |
| --- | --- | --- | --- |
| 新对话勾选 Overlay | 发第一条消息时 | 重发被拦下的那条消息 | 消息留在输入框，会话保持空状态 |
| 打开已有 Overlay 对话 | 打开时（读盘与切会话之前） | 自动继续打开该对话 | 放弃打开：不加载内容、不降级为磁盘视图、界面停在原位置 |

`deployable === false` 时两个入口都不弹框：装代理解决不了该问题，宿主以 Core 给出的
`reason` 拒绝并点明原因。代理的形态、特权阶段与协议见 [docs/core/mount-proxy.md](mount-proxy.md)。

能力由 Core 判断而不是宿主猜平台：Windows 宿主连 Linux 远端 Core 时宿主不是 Linux，但
Core 是。

能力是**逐 Core** 的事实，因此请求必须点名问哪个 Core：`storageCapabilitiesRequested`
携带 `sessionId` 与 `workspacePath`（没有对应上下文时为 `null`），宿主侧据它选 Connection
（漏掉就落到活动连接，后台预热视图会拿到另一个 Core 的答案）。两个字段只参与宿主侧路由，
Core 忽略它们、只回答自己那份能力。同给时 `sessionId` 优先（会话归属比视图更具体）：
部署闸门按会话问，webview 按来源视图所属工作区问（预热视图还没有会话）。

### 1.1 按会话读取视图内容

宿主进程看不到 Core 私有挂载命名空间里的视图（读挂载点得到空目录），直接读 `upper/`
也不成立（whiteout 让删掉的文件仍可见、未改动的文件在 `lowerdir` 看不到）。侧栏的文件
资源管理器因此经只读请求取内容：

| 请求 | 载荷 | 应答 |
| --- | --- | --- |
| `UiRequest.workViewFilesRequested` | `sessionId`（可给子代理会话 id，Core 解析到所有者）、`dir`（`'/'` 分隔相对路径，`''` 为视图根） | `{ ok: true, entries }` 或 `{ ok: false, error }` |
| `UiRequest.workViewChangesRequested` | `sessionId`、`scope`（`doc` / `all`，与侧栏同一判别值） | `{ ok: true, entries }` 或 `{ ok: false, kind: 'not-a-git-workspace' \| 'error', error }`；条目带 `path` / `plus` / `minus` / `status`（`A` / `M` / `R`）/ `oldPath`（重命名前的旧路径，无则 `null`） |
| `UiRequest.workViewFileDiffRequested` | `sessionId`、`path`（不能是视图根） | `{ ok: true, kind: 'git', before: string \| null, after }`、`{ ok: true, kind: 'not-a-git-workspace', after }` 或 `{ ok: false, error }` |
| `UiRequest.workViewFileIoRequested` | `sessionId`、`payload`（判别联合：`op` = `stat` / `list` / `mkdirAll` / `rename` / `unlink` / `read` / `write`；`path` 是 `'/'` 分隔相对路径，`''` 为视图根；`rename` 另带 `to`，`read` 带 `offset` / `length`，`write` 带 `offset` / 字节数组） | 按 `op`：路径事实 / 目录项 / 一块字节与 `eof` / 写入后的字节数 / `{ ok: true }`；失败恒 `{ ok: false, error }` |

视图不需要事先建立：这几个取数请求在取数前都会把该会话的视图备好
（与工具调用同一个入口），因此用户进对话就展开资源管理器也能看到叠加视图的内容。
`dir` / `path` 越界（绝对路径、`..`）一律拒绝；会话不是 Overlay 归属、或视图建不起来时
它们回失败侧，由宿主显示错误行——Core 不替它改列磁盘。

`workViewChangesRequested` 列出该对话视图里相对 HEAD 的改动：改磁盘已有文件、对话内新建、
以及只用 Bash 写出的文件都进清单——判据是「视图内容 vs HEAD」，不是工具旁路的记录。
条目带状态字母：`A` = 该路径在视图 HEAD 里没有版本（未跟踪 / 已 `git add` 的新文件），
`M` = 有内容改动，`R` = 视图里的 git 把这一条判为重命名（同时给出旧路径 `oldPath`）。
状态取自 `git diff --name-status -z -M`，与行数（`--numstat`）同一份 pathspec、同一次取数，
不从行数反推——纯重命名（numstat `0 0`）因此保留为 `R` 行而不是被剔除。宿主据此渲染与磁盘
口径同一套字母（[docs/hosts/electron-multi-workspace.md 第 9 节](../hosts/electron-multi-workspace.md#9-侧栏)）。
`workViewFileDiffRequested` 一次给出两侧原文：`after` 是视图内容、`before` 是**视图里** HEAD
的版本（`null` = 该文件没有 HEAD 版本）。`not-a-git-workspace` 是事实而不是界面文案
（[docs/architecture/principles.md 第 6 节](../architecture/principles.md#6-core-描述事实ui-决定表现)）。

### 1.2 视图取数的执行形态

两个 git 取数走与 Bash 同一条通路：子进程在私有挂载命名空间里把视图 bind 到真实工作区
路径上，再在**那个路径**上 exec git。这样向上找 `.git` 与磁盘同一套规则，输出的路径也天然是
工作区相对（直接在挂载点上跑 git 找不到仓库；`--git-dir` + `--work-tree` 会让 `diff` 与
`ls-files --others` 的路径口径分叉）。

取数**不写入视图**：git 在 stat 信息陈旧时会重写 `.git/index`，那样对话私有层里会多出用户
没改过的条目。索引因此落在视图外的 `git-scratch/`（挂载点的兄弟目录），用 `GIT_INDEX_FILE`
指过去，并关掉 `core.untrackedCache` / `core.fsmonitor`；有 HEAD 时先用 `git read-tree HEAD`
按**视图里的** HEAD 重建这份索引，因此对话内自己 `git commit` 过也不会把已提交的文件当成
未跟踪文件；`before` 侧用 `git show HEAD:./<rel>` 读，不碰索引。

HEAD 以**视图**为准：对话内自己 `git commit` 之后变更清单随之清空，磁盘 HEAD 不变。

## 2. 归属

会话元数据的 `storage` 字段记录归属，取值 `workspace`（默认：直接操作磁盘）与
`isolated`（读写落在本对话私有的叠加视图上）。归属在会话创建时一次写定，之后不变；
缺失按 `workspace`（存量会话口径）。

归属的写入时机：

| 时机 | 落点 | 作用 |
| --- | --- | --- |
| `conversationStarted` | Core 内存态 | 新建对话的**初始**归属 |
| `storageChanged` | Core 内存态 + 已有的 `meta.json` | 勾选框在创建之后才渲染，用户勾选必然晚于创建，需补发 |
| 首条消息建档（`touch_metadata`） | `meta.json` 的 `storage` | 兜底：`storageChanged` 先到时 meta 还不存在 |
| 本地子代理创建（`create_sub_agent`） | Core 内存态 + 子会话 `meta.json` | 继承发起对话此刻的归属（下节） |

**本地子代理继承发起对话的归属**（specs/058 FR-001）：`Agent` 不带 `target`（或 `target`
等于当前工作区）建立的子代理，把归属写成发起对话此刻的归属——发起方是 `isolated` 时子代理
也是 `isolated`，值随子会话 `meta.json` 落盘，Core 重启后按落盘值恢复，不再向父会话追问。
继承与角色无关（`Master` 与 `Explorer` 一视同仁，角色只决定工具白名单）。

**跨工作区派发的会话不继承**：`target` 指向另一个已打开工作区时，目标工作区那份会话恒按
`workspace` 记账（`meta.json` 显式写该值）。叠加视图是发起方 Core 私有命名空间里的事实，
不跨工作区传递。

`storageChanged` 不是「归属可变」：**已经有消息**（`messageCount > 0`）时直接忽略并记日志。
判据是「是否有消息」而不是「`meta.json` 是否存在」——新建对话时宿主立刻推送默认配置
（model / provider）就已经建档，拿「文件存在」当判据会让每一次勾选都被拒绝。

收到 `storageChanged` 时若 `meta.json` 已存在（真实新建态就是这样）就当场补写归属。
建档入口不止 `touch_metadata` 一个（`update_context` 兜底同样建档），逐处补写必然漏；
归属的唯一写入口是 `set_session_storage`，就地补最稳妥。meta 缺失时不预建——
纯声明性对话（只发一条消息就关）不留磁盘痕迹。

建档时只在字段缺失时写入，已有值一律保留——否则会话重开、内存态按默认值重建后再落一条
消息，就会把 `isolated` 覆盖成 `workspace`。

读侧相应有两级：内存态优先（内存态是「本次进程内已确定」的归属，一定比磁盘新），
内存态缺失时读 `meta.json`（Core 重启、存量会话）。两处都没有才是 `workspace`。

### 2.1 视图的所有者

`isolated` 的视图有唯一所有者：**用户勾选 Overlay 的那条顶层对话**。本地子代理是使用者——
它继承来的 `isolated` 指向父对话那份视图（同一上层目录、同一挂载、同一常驻代理），不新建
第二份目录、不额外拉起代理。因此父子改动双向立即可见，两者之间没有同步、合并或回并动作。

所有者在读取时由 `parentSessionId` 链上溯推出（`Core::work_view_owner`）：父会话同样
`isolated` 时继续上溯，到没有父会话的那一层即所有者。父会话 id 两级来源——内存态
（创建时写定）与 `meta.json` 的 `parentSessionId`（Core 重启后唯一来源）；判据先看「这是不是
子代理」，主对话不为一次父链查询付目录枚举。上溯深度上限 64 层，父链成环时报错。

所有按会话寻址视图的能力（工具代执行、`workView*` 取数、变更清单、两侧原文、`Transfer`
的视图端）都以「使用者 → 所有者」的解析结果作答，因此以子代理会话 id 取数与以父对话会话 id
取数得到同一份内容。「这份 `isolated` 用哪份视图」是推导值，`meta.json` 不写第二个字段。

解析失败一律按视图不可用处理（不退回真实磁盘）：子代理查不到父会话 id、父会话归属不是
`isolated`、父链成环都是数据异常，见第 7 节。

## 3. 视图结构

每个Overlay 对话一份，位于 `<configHome>/work-views/<key>/`：

| 路径 | 内容 |
| --- | --- |
| `upper/` | 本对话的写入（普通目录） |
| `work/` | overlay 的 `workdir`（overlay 自身要求） |
| `mount/` | 挂载点（`merged`），工具与 Bash 看到的内容 |
| `git-scratch/` | git 取数的索引副本（第 1.2 节；不在 overlay 上层、也不在挂载结果里） |

`key` 由工作区路径 + 会话 id 派生，跨 Core 重启稳定。

挂载参数：

```text
lowerdir=<真实工作区路径>
upperdir=<视图根>/upper
workdir=<视图根>/work
userxattr
```

`lowerdir` 是活磁盘，因此基线永远是最新状态；`userxattr` 不可省——非特权用户命名空间里
不启用它时删除**目录**会 `EIO`。

挂载点在 `/proc/self/mountinfo` 里恰好出现一次。建立与注销都在视图登记表的锁内完成：
并行工具批里 `Read` / `Grep` / `Glob` 各占一个线程，都会首次触发建立，锁外做「检查 +
挂载」会让同一份 `upper` 被叠加挂两层——`mount(2)` 允许在同一挂载点叠加挂载并返回 0，
而登记表只记一层，`conversationClosed` 的卸载因此只撤得掉一层。锁内重读登记表条目后只有
一个线程真正挂载，其余采纳结果；条目已注销时报错，不挂出一个登记表里没有、谁也回收不到
的视图。

注销与回收按 `/proc/self/mountinfo` 卸载到该挂载点消失为止，不以登记表记的层数为准：
残留的挂载层不随登记项一起消失，而 `remove_dir_all` 对仍有挂载的目录报 `EBUSY`。

## 4. 命名空间

```text
Core（帧循环）                              ← 永不进入命名空间、不 unshare、不 exec
  │ 某个隔离会话第一次需要视图时 spawn + socketpair
  ▼
挂载代理 A（setuid 启动，euid 0）
  unshare(CLONE_NEWNS) + / 设为私有传播      ← 在 fork 之前，A / B 共享同一份挂载表
  建视图目录并 chown 给真实用户
  挂 overlay，自查 mountinfo 里恰好出现一次
  bind 视图 → 真实工作区路径                 ← 路径字符串不变，内容换成叠加结果
  fork ──▶ B；A 降回真实 uid，此后只 waitpid
            │
            ▼
          代理 B（站在命名空间里，跑帧循环）
            └─ fork ──▶ 工具子进程
```

**没有 user namespace。** 代理是 setuid root 启动的，在初始 userns 里本来就持
`CAP_SYS_ADMIN`；再建 `CLONE_NEWUSER` 只会换来一个残缺的 id 映射，让 `mkdir` 与 overlay
的 whiteout 全部 `EOVERFLOW`（实测见
[specs/defects/mount-proxy-cannot-mkdir-under-private-tmpfs.md](../../specs/defects/mount-proxy-cannot-mkdir-under-private-tmpfs.md)）。

**不采用 `setns`**：内核不允许进程加入一个既有的用户命名空间后取得其 capability，
「代理建好空间、Core 再进去」在 Linux 上不可实现。Core 要看叠加视图，只能经代理代执行。

**一个隔离会话一个代理**，视图在它建立时挂好：没有「之后还要挂新东西」的需求，因此不需要
第二个特权进程常驻。代理缺失或建立失败只让能力回 `absent`，Core 照常启动与服务帧通道。

## 5. 工具语义

工具对视图**透明**：路径解析、相对路径、`cwd` 行为与不带隔离的对话完全一致，用户看到的
路径字符串仍是真实工作区路径。`isolated` 的本地子代理与发起对话共用同一份视图（第 2.1 节），
因此它的工具读写与父对话落在同一份上层目录上。

实现上，工具的文件 IO 与 Bash 命令全部**经常驻挂载代理代执行**：Core 不在命名空间里，
它自己 `open()` / `spawn` 看到的都是真实磁盘。代理已经把视图 bind 到真实工作区路径上，
因此代执行时路径原样传过去就是叠加结果，不需要映射。对外的输出（工具结果、diff 展示、
`file_path`）仍是真实路径。

Bash 的路径字符串尤其重要：`pwd`、脚本里写死的绝对路径、`cd` 全部按真实工作区路径工作，
因为 bind 只改内容来源、不改路径。

前台的 `toolProgress`、中止（`ctx.cancel`）与后台任务同样走这条通道：Core 不持有工具的
`Child` 句柄，中止翻译成 `kill` 请求；后台任务的输出由 Core 追加进任务输出文件，退出码
取自代理的 `exit` 应答。

**权限阶段也是这条通道的一部分。** `Edit` / `Write` 的授权前判定要回答「目标文件在这个
会话里是否存在、旧内容是什么」，答案必须与工具执行同一份：隔离会话里它来自视图，非隔离
会话才是真实磁盘。`permission.rs` 因此不直接读盘，而是经 `WorkViewState` 的
`stat_path` / `read_bytes`——同一处失败语义：视图不可用时授权前就按「视图不可用」拒绝，
不退回磁盘（specs/defects/overlay-edit-and-card-links-read-real-disk.md）。确认框的
「创建新文件 / 覆盖现有文件」判据取自同一个读取点。

会话里的文件链接（Read / Write / Edit 卡片的路径）同样按归属取数：宿主看到来源视图的
会话归属是 `isolated` 时经 `UiRequest.workViewFileDiffRequested` 读视图内容，与侧栏
Overlay 双击打开同一份编排——磁盘上没有的对话内新文件因此也能打开。归属的 owner 仍是
Core（`meta.json` 的 `storage`），宿主只读投影、不重算。

跨工作区传输（`Transfer`）的一端同样按归属取放：属于本对话工作区的那一端经
`UiRequest.workViewFileIoRequested` 在视图里读写（`stat` / `list` / `mkdirAll` /
`rename` / `unlink` / `read` / `write`），另一端是真实磁盘或 SFTP。宿主读不到挂载点，
所以字节全部经这条请求往返；视图取不到时传输直接报错而不是退回磁盘
（[docs/features/cross-workspace-transfer.md 第 2.4 节](../features/cross-workspace-transfer.md#24-视图端的取放与失败语义)）。

## 6. 生命周期

| 时机 | 动作 |
| --- | --- |
| `conversationStarted`（`storage: isolated`） | 登记归属；视图**只登记**，不建目录、不拉起代理 |
| 本地子代理创建（继承 `isolated`） | 同样只登记归属：视图目录、挂载与代理都属于所有者，子代理不新建 |
| 第一次工具调用，或第一次视图取数（列目录 / 变更清单 / 两侧原文） | 按第 2.1 节解析出所有者，拉起**所有者**的代理：它建目录、挂 overlay、bind 到工作区；失败时工具与取数都**报错**（fail-closed） |
| `conversationClosed`（所有者） | 丢弃代理（关闭 socketpair → 它读到 EOF 自行退出），**保留**上层目录（改动跨重启保留） |
| `conversationClosed`（子代理） | 只让该会话退场，**不**碰共享视图：所有者的代理与上层目录都留着 |
| `conversationDeleted`（所有者） | 丢弃代理并回收整个视图目录（含子代理曾写入的内容）；失败只记日志 |
| `conversationDeleted`（子代理） | 不删共享视图目录：其中的改动随视图留在原处；父子链的整棵删除仍由引擎负责销号 |

惰性拉起的理由：纯声明性对话（只发一条消息就关）不该在磁盘上留下视图目录，也不该产生
任何代理进程。视图的所有者在会话关闭 / 删除**之前**解析：这两个动作会抹掉会话档案，
之后再解析就只剩「父会话缺失」了。

## 7. 失败路径

| 情形 | 预期 |
| --- | --- |
| 非 Linux 平台 | 能力回 unavailable，`deployable: false`，原因点名平台 |
| 代理未部署 / 落点判据不满足 | `mountProxy: 'absent'`、`deployable: true`，原因点名缺失 |
| 代理的运行期协议与 Core 不匹配 | 同上，原因点名版本 |
| 代理自检失败（命名空间 / 挂载 / 断言） | 同上，原因透传代理给出的那一条 |
| 视图建立失败（磁盘不可写等） | 该会话的工具调用**报错**，改动不落真实磁盘；原因记进 Core 日志 |
| 代理运行中被杀 | 能力改判 `absent`；下一次需要时重新拉起，不重启 Core |
| 视图未建立时的只读请求（列目录 / 变更清单 / 两侧原文） | 先按需建立该会话的视图再取数；建立失败回失败侧（变更清单带 `kind: 'error'`），由宿主显示错误行；不退回磁盘 |
| 视图里跑 git 失败（可执行缺失 / 子命令非零退出） | 回失败侧并带上失败原因，不回退磁盘清单 |
| 会话删除时回收失败 | 删除照常完成，日志记录残留路径 |
| 子代理 `isolated` 但父会话 id 解析不出（档案被删） | 工具与取数请求**报错**并点名缺失的父会话；不猜「父不在就自己一份视图」，不退回磁盘 |
| 父会话存在但归属是 `workspace`（归属链断了） | 同上：按数据异常报错，不退回磁盘 |
| 父链成环（`parentSessionId` 互相指向） | 上溯到 64 层后报错，不死循环 |

所有降级都**留痕**：不静默把「看起来隔离、实际写磁盘」的形态交给用户。

归属 `isolated` 的对话只在能力可用时打开（第 1 节的部署闸门）：能力不可用时它不是「打开后
只能看不能动」，而是根本打不开——因此不存在「把存量隔离对话转成真实工作区」这种出路，
也没有对应的 `UiEvent`。用户要么把代理装上继续用 Overlay，要么新建一条普通对话。

## 8. 与分支历史的区别

本形态只做「对话之间隔离」，不做 Commit 历史、回滚、跨对话合并。改动写在普通上层目录里，
没有版本化记录；需要历史时另行设计。

## 9. 平台

只在 Linux 上提供。挂载命名空间、overlayfs 与 setuid 语义都是 Linux 内核能力；其它平台
编译出同签名类型，能力恒回不可用、`deployable` 恒 false。

「非特权用户命名空间是否可用」**不再是**能力前提：命名空间由 setuid 代理在初始 userns 里
建立，与那条限制无关。

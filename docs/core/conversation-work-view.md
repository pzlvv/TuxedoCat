---
owner: pzlvv
last_reviewed: 2026-11-12
---

# 规格：Overlay 对话工作视图

本文描述「Overlay 对话」的执行形态：一个对话的 Read / Write / Edit / Bash / Grep 看到
「真实工作区 + 本对话改动」的叠加结果，改动不污染磁盘，对话之间互不可见。磁盘是唯一基线
事实——磁盘上后来新增、修改、删除的文件，对话中立即可见，不需要任何同步动作。

能力由 Core 判据给出，宿主只转发；只在 Linux Core 上可用。

## 1. 能力

`UiRequest.storageCapabilitiesRequested` 应答 `{ isolatedWorkView, reason }`：

| 字段 | 含义 | 判据 |
| --- | --- | --- |
| `isolatedWorkView` | 能否为对话建立 Overlay 工作视图 | 用户命名空间可建 + overlayfs 可挂（含 `userxattr`） |
| `reason` | 不可用的原因；可用时为空串 | 依次点名平台 / 用户命名空间 / overlayfs 哪一项不满足 |

界面在 `isolatedWorkView` 为 true 时才渲染入口。为 false 时整块入口不出现——不给「勾选后
静默无效」的形态。

能力由 Core 判断而不是宿主猜平台：Windows 宿主连 Linux 远端 Core 时宿主不是 Linux，但
Core 是。

### 1.1 按会话读取视图内容

宿主进程看不到 Core 私有挂载命名空间里的视图（读挂载点得到空目录），直接读 `upper/`
也不成立（whiteout 让删掉的文件仍可见、未改动的文件在 `lowerdir` 看不到）。侧栏的文件
资源管理器因此经只读请求取内容：

| 请求 | 载荷 | 应答 |
| --- | --- | --- |
| `UiRequest.workViewFilesRequested` | `sessionId`、`dir`（`'/'` 分隔相对路径，`''` 为视图根） | `{ ok: true, entries }` 或 `{ ok: false, error }` |
| `UiRequest.workViewChangesRequested` | `sessionId`、`scope`（`doc` / `all`，与侧栏同一判别值） | `{ ok: true, entries }` 或 `{ ok: false, kind: 'not-a-git-workspace' \| 'error', error }` |
| `UiRequest.workViewFileDiffRequested` | `sessionId`、`path`（不能是视图根） | `{ ok: true, kind: 'git', before: string \| null, after }`、`{ ok: true, kind: 'not-a-git-workspace', after }` 或 `{ ok: false, error }` |

视图尚未建立（会话还没调用过工具）时三者都回失败侧：由宿主决定显示磁盘基线还是报错，
Core 不替它决定。`dir` / `path` 越界（绝对路径、`..`）一律拒绝。

`workViewChangesRequested` 列出该对话视图里相对 HEAD 的改动：改磁盘已有文件、对话内新建、
以及只用 Bash 写出的文件都进清单——判据是「视图内容 vs HEAD」，不是工具旁路的记录。
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

写入有三个时机：

| 时机 | 落点 | 作用 |
| --- | --- | --- |
| `conversationStarted` | Core 内存态 | 新建对话的**初始**归属 |
| `storageChanged` | Core 内存态 + 已有的 `meta.json` | 勾选框在创建之后才渲染，用户勾选必然晚于创建，需补发 |
| 首条消息建档（`touch_metadata`） | `meta.json` 的 `storage` | 兜底：`storageChanged` 先到时 meta 还不存在 |

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
run_core() 最早（单线程）
  unshare(CLONE_NEWUSER) + 写 id 映射     ← 拿到命名空间内的 CAP_SYS_ADMIN
  unshare(CLONE_NEWNS) + / 设为私有传播    ← 本进程的挂载不泄漏给宿主

每次工具 / Bash 子进程
  unshare(CLONE_NEWNS)                    ← 取一份私有挂载副本
  bind <视图挂载点> → <真实工作区路径>      ← 路径字符串不变，内容换成叠加结果
  exec
```

`CLONE_NEWUSER` 必须在单线程时执行：内核要求调用者 `mm_users == 1`，进程一旦有第二个
线程就必然 `EINVAL`。位置因此固定在 `run_core()` 开头、任何后台线程启动之前。

进命名空间失败不阻塞 Core 启动：能力探测据此回不可用，Overlay 对话退回真实磁盘执行。

## 5. 工具语义

工具对视图**透明**：路径解析、相对路径、`cwd` 行为与不带隔离的对话完全一致，用户看到的
路径字符串仍是真实工作区路径。

实现上，工具解析出真实路径后经视图句柄映射成视图内路径再读写；对外的输出（工具结果、
diff 展示、`file_path`）仍是真实路径。

Bash 的路径字符串尤其重要：`pwd`、脚本里写死的绝对路径、`cd` 全部按真实工作区路径工作，
因为 bind 只改内容来源、不改路径。

## 6. 生命周期

| 时机 | 动作 |
| --- | --- |
| `conversationStarted`（`storage: isolated`） | 登记归属；视图**只登记**，不建目录不挂载 |
| 第一次工具调用 | 建目录并挂 overlay；失败记日志，工具按真实磁盘执行 |
| `conversationClosed` | 卸载挂载，**保留**上层目录（改动跨重启保留） |
| `conversationDeleted` | 卸载并回收整个视图目录；失败只记日志 |

惰性建立的理由：纯声明性对话（只发一条消息就关）不该在磁盘上留下视图目录。

## 7. 失败路径

| 情形 | 预期 |
| --- | --- |
| 非 Linux 平台 | 能力回 unavailable，原因点名平台 |
| 用户命名空间不可用（seccomp / 容器限制） | 同上，原因点名该项 |
| overlayfs 不支持 `userxattr` | 同上；不做「删文件可用、删目录失败」的半成品 |
| 视图建立失败（磁盘不可写等） | 工具按真实磁盘执行，原因记进 Core 日志 |
| 视图未建立时的只读请求（列目录 / 变更清单 / 两侧原文） | 回失败侧（变更清单带 `kind: 'error'`），由宿主显示错误行；不退回磁盘，也不替调用方建视图 |
| 视图里跑 git 失败（可执行缺失 / 子命令非零退出） | 回失败侧并带上失败原因，不回退磁盘清单 |
| 会话删除时回收失败 | 删除照常完成，日志记录残留路径 |

所有降级都**留痕**：不静默把「看起来隔离、实际写磁盘」的形态交给用户。

## 8. 与分支历史的区别

本形态只做「对话之间隔离」，不做 Commit 历史、回滚、跨对话合并。改动写在普通上层目录里，
没有版本化记录；需要历史时另行设计。

## 9. 平台

只在 Linux 上提供。overlayfs 与非特权用户命名空间都是 Linux 内核能力；其它平台编译出同
签名类型，能力恒回不可用。

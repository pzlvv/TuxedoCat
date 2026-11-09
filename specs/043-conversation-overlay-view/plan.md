# 实施方案：对话级 overlay 工作视图

需求见 [spec.md](spec.md)。技术路线一句话：**Core 在启动早期进用户命名空间，每个隔离视图
对话各自维护一份「真实工作区（lower）+ 私有上层（upper）」的 overlay 挂载；工具与 Bash 在
该挂载的私有挂载命名空间副本里执行，路径字符串保持真实工作区路径不变。**

## 技术方案

### 1. 为什么是 overlay，而不是分支快照

磁盘必须是唯一基线（FR-003）。这要求「基线内容」来自活磁盘而非导入时复制的副本。overlayfs
的 `lowerdir` 正好是「以某个目录为只读下层」，无需复制、无需同步，磁盘改动即时可见。

实测确认（本机 Linux 6.18，非特权用户命名空间）：

| 能力 | 结论 |
| --- | --- |
| overlay 在 `unshare -Urm` 内可挂 | 通过 |
| 读下层文件 / 目录（`node_modules` 场景） | 通过 |
| 写入落 upper，lower 不变 | 通过 |
| 删除**文件**（whiteout） | 通过 |
| 删除**目录** | 需要 `userxattr`，否则 `EIO` |
| 以 LayerFS FUSE 挂载点为 upperdir | **不可行**：`setxattr` / `mknod` 被 FUSE 层拒绝 |

最后一行是否决「上层用 LayerFS 分支」的依据：overlay 要求 upper 能写扩展属性
（`trusted.overlay.*`）并创建字符设备 whiteout，而上游 `layerfs-fuse` 的 `setxattr` 全部
拒绝、`mknod` 只放行普通文件与目录。

### 2. 进程与命名空间结构

```
宿主 ──stdio 帧──▶ Core 进程
                     │
                     │ run_core() 最早期（单线程时）：
                     │   unshare(CLONE_NEWUSER) + 写 id 映射
                     │   unshare(CLONE_NEWNS) + 把 / 设为私有传播
                     ▼
              此后所有线程与子进程都在同一命名空间里

每次工具调用 / 每次 Bash：
    fork 出子进程 → 子进程 unshare(CLONE_NEWNS) 取私有挂载副本
                 → 在该副本里把 <overlay 挂载点> bind 到真实工作区路径
                 → exec 工具动作 / shell
```

`CLONE_NEWUSER` 必须在**单线程**时执行（内核要求 `mm_users == 1`），因此位置固定在
`run_core()` 开头、任何后台线程启动之前。

对外仍报 `unshare(CLONE_NEWUSER)` 失败的原因（seccomp / 容器限制），由
`storageCapabilitiesRequested` 应答给宿主，入口不渲染（FR-001、FR-007）。

### 3. 视图的实体

每个隔离视图对话一份：

| 路径 | 内容 |
| --- | --- |
| `<configHome>/work-views/<sessionKey>/upper/` | 本对话的写入（普通目录） |
| `<configHome>/work-views/<sessionKey>/work/` | overlay 的 `workdir`（overlay 自身要求） |
| `<configHome>/work-views/<sessionKey>/mount/` | 挂载点（`merged`） |

`sessionKey` 由工作区路径 + sessionId 派生，与会话落盘目录同一套编码口径，跨 Core 重启
稳定（FR-006）。

挂载参数：

```
lowerdir=<真实工作区>
upperdir=<...>/upper
workdir=<...>/work
userxattr          ← 删除目录必需
```

### 4. 工具如何落到视图里

工具（`run_read` / `run_write` / `run_edit` / `grep` / `glob`）目前直接用 `std::fs` 操作
`ctx.cwd` 下的路径。**不为隔离视图改这些实现**：视图的作用方式是让 `ctx.cwd` 指向挂载点，
路径拼接方式完全不变。

具体做法：`ToolContext` 新增 `work_view: Option<WorkViewHandle>`。工具执行前，若该会话有
视图，则把路径解析的基底从真实工作区换成视图挂载点；对外的路径字符串（工具输出、diff 展示、
用户可见的 `file_path`）仍是真实工作区路径，由 `WorkViewHandle` 做双向映射（`strip` / `join`）。

Bash 必须在**私有挂载命名空间**里执行：子进程 `unshare(CLONE_NEWNS)` 后把挂载点 bind 到
真实工作区路径上，再 `exec` shell。这样脚本里写死的绝对路径、`$PWD`、`cd` 全部照常工作
（与既有 `specs/044` 的形态同源，但基线不含该实现，本次一并引入）。

### 5. 契约变化

| 成员 | 变化 |
| --- | --- |
| `CoreEvent.conversationStarted` | 新增必选字段 `storage: 'workspace' \| 'isolated'` |
| `UiRequest` | 新增 `storageCapabilitiesRequested`，应答 `{ isolatedWorkView: boolean; reason: string }` |

两个成员都必选；`reason` 在能力可用时为空串（不用 `null`，与既有能力应答同一口径）。

### 6. 生命周期

| 时机 | 动作 |
| --- | --- |
| `conversationStarted`（`storage: isolated`） | 登记归属；上层目录**惰性创建**（首次工具调用时），避免纯声明性对话就落目录 |
| 第一次工具调用 | 创建 upper / work / mount，挂 overlay；失败则记日志并按真实磁盘执行（FR-007） |
| 会话关闭（`conversationClosed`） | 释放该会话的挂载（若有），上层目录**保留**（改动跨重启保留） |
| 会话删除（`conversationDeleted`） | 卸载并回收整个 `work-views/<sessionKey>/`；失败只记日志 |

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/work_view.rs` | 新增：命名空间进入、overlay 挂载、视图登记与回收 | 无（模块内） |
| `core-rs/src/work_view_linux.rs` | 新增：Linux 实现 | 无 |
| `core-rs/src/work_view_unsupported.rs` | 新增：非 Linux 占位，能力恒 false | 无 |
| `core-rs/src/tools.rs` | 修改：`ToolContext` 增 `work_view`；`run_bash` 走私有命名空间 | 无 |
| `core-rs/src/main.rs` | 修改：`run_core()` 开头进命名空间；两条会话事件接视图生命周期；新增能力查询分支 | `storageCapabilitiesRequested` |
| `core-rs/src/engine.rs` | 修改：会话归属记录与释放 | `conversationStarted.storage` |
| `src/shared/AssistantEventBus.ts` | 修改：两个契约成员与类型 | `storage`、`storageCapabilitiesRequested` |
| `src/host/coreFacts.ts` | 修改：能力查询封装 | 无 |
| `electron/main.ts` | 修改：能力转发、会话创建传归属、删除时回收 | 无 |
| `electron/sidebar/main.ts` | 修改：会话列表标记 | 无 |
| `src/webview/` | 修改：新建对话空状态的勾选框 | 无 |

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：命名空间与挂载全在 `core-rs/`，宿主只读能力应答
      与归属字段，不做宿主嗅探；`src/shared/AssistantEventBus.ts` 只加类型与成员，不引入
      宿主 API。
- [x] **架构铁律**（[principles.md 第 1、2 节](../../docs/architecture/principles.md#1-不过度-fallback)）：不过度 fallback——视图建立失败要记日志并按真实磁盘
      执行，这是**设计允许的降级**且必须留痕（FR-007），不是静默降级；契约成员全必选
      （`storage` 与两个能力字段）；一份事实一个写入点——归属只写 `meta.json`，上层目录路径
      由它派生；无新增默认值。
- [x] **Core 行为与落盘格式同步**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：改动全在 `core-rs/`；`meta.json` 新增 `storage` 字段，
      与 `src/shared/history/Conversation.ts` 的类型声明两侧同步，读出侧对缺失值按
      `workspace`（存量会话口径）。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：[standalone-core.md 第 3 节](../../docs/core/standalone-core.md#3-core-形态)与[第 4 节](../../docs/core/standalone-core.md#4-契约)、`docs/architecture/contracts.md`、
      `docs/core/session-runtime.md`，以及新增 `docs/core/conversation-work-view.md`；
      事件表由 `docsLint` 对照代码校验。

## 被否决的替代方案

### 一、上层用 LayerFS 分支（Store）

曾设想「overlay 的 upperdir 直接指向 LayerFS 分支的 FUSE 挂载点」，以同时获得分支历史。
实测否决：`layerfs-fuse` 的 `setxattr` / `getxattr` / `listxattr` / `removexattr` 四个回调
全部返回拒绝，`mknod` 仅放行普通文件与目录（字符设备 whiteout 被 `NotPermitted` 拦下）。
overlay 挂载直接报 `wrong fs type / bad option`。

### 二、先写到普通上层，结束时 commit 进 LayerFS 分支

可行但引入两套写机制：运行期内容在 overlay 上层，历史在 Store，需要设计同步时机、失败
补偿与「两边不一致」的解释。本次目标是对话隔离而非历史，故不做（已列入 spec 非目标）。

### 三、把 `node_modules` 等目录重新纳入导入清单

即「全量复制进 Store」路线。本仓库工作区实测 26 GB，初始化需复制全部内容；且磁盘后续改动
仍不可见（快照语义不变），无法满足 FR-003。否决。

### 四、不改命名空间，只把工具与 Bash 的 `cwd` 指向上层目录

最省事，但上层目录里没有基线文件，对话里 `ls` 只能看到自己写的东西——与 FR-003 直接冲突。
否决。

### 五、每个隔离对话起一个独立 Core 进程

进程间隔离最彻底，但会话状态（消息、工具表、取消标记）都在 Core 内存里，跨进程同步成本
远高于命名空间方案，且与既有单进程 Core 形态（`docs/core/standalone-core.md` 第 3 节）冲突。
否决。

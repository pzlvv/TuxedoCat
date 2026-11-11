---
status: 实施中
---

# 改动规格：对话级 overlay 工作视图

新建一个「对话工作视图」开关：开启后，该对话的 Read / Write / Edit / Bash / Grep 全部看到
「磁盘工作区 + 本对话改动」的叠加视图，改动只落在对话私有的上层目录，不污染磁盘，对话之间
互不可见。磁盘是唯一基线事实：工作区里后来新增、修改、删除的文件，新开的对话立即可见，
不需要任何同步动作。

本改动替换此前「LayerFS 分支 + Store 快照」的隔离形态。基线（本分支分叉点）不含该形态的
任何代码，本 spec 从零定义能力。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [3. Core 形态](../../docs/core/standalone-core.md#3-core-形态) | 修改 | 新增「对话工作视图」形态与其生命周期 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [4. 契约](../../docs/core/standalone-core.md#4-契约) | 修改 | 新增能力查询与视图建立时机 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | — | 修改 | 新增 `UiRequest.storageCapabilitiesRequested` 与 `UiEvent.conversationStarted` 的 `storage` 字段 |
| [docs/core/session-runtime.md](../../docs/core/session-runtime.md) | — | 修改 | 会话释放时回收视图 |
| `docs/core/conversation-work-view.md` | — | 新增 | 视图的命名空间、挂载与回收规则独立成篇（300 行以上补目录） |

## 用户场景与验收标准

- 场景 1：新建对话时选择 Overlay 视图
  - **AC-1**（FR-001）：GIVEN 新建对话的空状态 WHEN 用户在 logo 下方勾选「Overlay 对话」THEN 创建出的对话带该归属并在会话列表显示标记
  - **AC-2**（FR-001）：GIVEN 运行 Core 的平台不支持该能力 WHEN 用户查看新建对话空状态 THEN 不渲染勾选框，不出现勾选后静默无效的形态
  - **AC-3**（FR-007）：GIVEN 能力可用但视图首次建立失败 WHEN 用户在 Overlay 视图对话里执行工具 THEN 工具按真实磁盘执行，且会话内可见失败原因
- 场景 2：Overlay 视图里的读写
  - **AC-4**（FR-002）：GIVEN 一个 Overlay 视图对话 WHEN 执行 Write 新建文件 THEN 该文件在同一对话的 Read 与 Bash 与 Grep 中立即可见
  - **AC-5**（FR-002）：GIVEN 一个 Overlay 视图对话 WHEN 修改磁盘上已存在的文件 THEN 对话内读到新内容而磁盘上的文件内容不变
  - **AC-6**（FR-003）：GIVEN 磁盘工作区有 node_modules 与 .git 与 target WHEN 在 Overlay 视图对话里列这些目录 THEN 都能列出内容
  - **AC-7**（FR-003）：GIVEN Overlay 视图对话已打开 WHEN 磁盘上被其他进程新增或修改文件 THEN 该对话内立即可见新内容而无需同步动作
- 场景 3：对话之间隔离
  - **AC-8**（FR-004）：GIVEN 对话 A 在 Overlay 视图里新建了 a.txt WHEN 在对话 B 里列目录 THEN 看不到 a.txt
  - **AC-9**（FR-004）：GIVEN 对话 A 修改了磁盘上已有的 f.txt WHEN 对话 B 读 f.txt THEN 读到磁盘原内容而不是 A 的改动
- 场景 4：删除与生命周期
  - **AC-10**（FR-005）：GIVEN Overlay 视图对话 WHEN 删除磁盘上已存在的文件或目录 THEN 该对话内不再可见而磁盘上的文件与目录仍在
  - **AC-11**（FR-006）：GIVEN 对话被关闭 WHEN 重新打开同一对话 THEN 之前的改动仍在
  - **AC-12**（FR-006）：GIVEN 对话被删除 WHEN 清理该对话 THEN 其私有上层目录一并回收

## 功能需求

### FR-001：对话归属与能力查询

会话元数据新增 `storage` 字段，取值 `workspace`（默认，直接操作磁盘）与 `isolated`
（改动落在对话私有上层）。归属在会话创建时一次写定，之后不变。

Core 经 `UiRequest.storageCapabilitiesRequested` 应答 `{ isolatedWorkView, reason }`，
宿主原样转发给界面。`isolatedWorkView` 为 false 时不渲染入口，`reason` 写明缺哪项前提
（非 Linux / 用户命名空间不可用 / overlayfs 不可用）。

### FR-002：叠加视图是工具的唯一事实来源

Overlay 视图对话里，Read / Write / Edit / Bash / Grep / Glob 看到的都是「磁盘 + 本次对话改动」
的叠加结果，与不带隔离的对话在**工具语义上无差别**：同样的路径、同样的相对路径解析、同样的
`cwd` 行为。工具实现不因归属而分叉——差异只在视图本身。

### FR-003：磁盘是唯一基线

上层只存本对话产生的改动，基线永远是当前磁盘状态。因此：

- 磁盘上已有的、体量大的目录（`node_modules`、`.git`、`target`、构建产物）全部可直接访问，
  不复制、不入库；
- 磁盘在对话打开期间被外部改动，对话内立即可见（无缓存、无快照、无同步时机）；
- 不存在「快照过期」这一失败形态。

### FR-004：对话之间互不可见

每个对话一个私有上层目录。对话 A 的改动不出现在对话 B 里；两者修改同一文件时各自看到
自己的版本，磁盘上的原文件都不变。

### FR-005：删除的正确表达

Overlay 视图内删除磁盘上已有的文件或目录时，该对话内不可见，磁盘保持不变。上层需要能表达
「此处曾有一个基线条目，现已删除」，包括目录。

### FR-006：生命周期与回收

私有上层目录按会话 id 落盘，跨 Core 重启保留：重开同一对话能看到之前的改动。会话删除时
一并回收；回收失败不阻塞删除，但要记录原因。

### FR-007：失败路径明确

视图建立失败（命名空间不可用、overlayfs 不可用、磁盘不允许）时，对话仍可用，但工具按
**真实磁盘**执行，并把原因记进 Core 日志与会话可见的错误。不静默降级成「看起来隔离、
实际写磁盘」。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 非 Linux 平台 | 能力查询回 `isolatedWorkView: false`，入口不渲染 |
| 用户命名空间不可用（seccomp / 容器限制） | 同上，`reason` 写明；已选择的对话退回磁盘并在日志留痕 |
| overlayfs 不支持 `userxattr` | 同上；不做「删除文件可用、删除目录失败」的半成品 |
| 磁盘工作区不可写 | 视图建立失败，按 FR-007 退回磁盘并报错 |
| 上层目录写满 / 权限错误 | 工具返回明确错误，不静默成功 |
| 会话删除时回收上层失败 | 删除照常完成，日志记录残留路径供清理 |
| 同一对话并发执行多个 Bash | 互不干扰：每个命令一份私有挂载命名空间 |

## 非目标

- **分支历史与回滚**：本次只做「对话之间隔离」，不做 Commit 历史、回滚、合并。需要时另行
  立 spec（去向：[docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。
- **跨对话合并改动**：不做把 A 的改动合进 B。
- **把改动写回磁盘**：不做「应用本对话改动到磁盘」。用户需要时在对话里自己执行。
- **Windows / macOS 支持**：只在 Linux 上提供该能力。
- **性能优化**：不做上层目录的增量压缩、去重。

## 对需求基线的影响

无新增 US。这是 Core 内部的执行形态扩充，用户可见的差异是「新建对话多一个勾选框」与
「对话内改动不再污染磁盘」，沿用既有 US-61（工具执行）与 US-42（文件浏览）的场景，
不单独立项。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `CoreEvent.conversationStarted.storage`、`UiRequest.storageCapabilitiesRequested` | `core-rs` 归属测试 + 宿主能力转发测试 | 自动 |
| FR-002 | 工作视图层（命名空间 + overlay 挂载） | `overlay_view_tests`：写后读、改后读、`cwd` 不变 | 自动 |
| FR-003 | overlay `lowerdir` = 真实工作区 | `overlay_view_tests`：`node_modules` 可见、外部改动立即可见 | 自动 |
| FR-004 | 每对话独立 `upperdir` | `overlay_view_tests`：两对话互不可见 | 自动 |
| FR-005 | `userxattr` 挂载选项 | `overlay_view_tests`：删文件、删目录后基线不变 | 自动 |
| FR-006 | 上层目录路径按会话 id 派生 + 会话删除时回收 | 生命周期测试 | 自动 |
| FR-007 | 能力查询 + 建立失败回退 | 能力不可用时的回退测试 | 自动 |

## 待澄清

已清零。

原待澄清项与结论：

- 「上层用普通目录还是 LayerFS 分支」→ 实测确认 LayerFS FUSE 视图不支持扩展属性与字符
  设备节点，无法作为 overlay 上层；改用普通目录（去向：本 spec 的 FR-002 与 plan.md 的
  否决方案）。
- 「删除目录是否会失败」→ 实测确认需要 `userxattr` 挂载选项；不用它时非特权用户命名空间里
  删除目录会 `EIO`（去向：FR-005 与边界表）。

## 收敛记录

尚未收敛。

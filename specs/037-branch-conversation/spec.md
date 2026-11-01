---
status: 待评审
---

# 改动规格：分支对话（git worktree 隔离）

## 这是什么

给同一项目加一种并行工作方式：**分支对话**。

- 一个工作区里可以同时开多个对话，每个分支对话在**自己的 git worktree 目录**里工作，
  该目录位于 Core 数据目录（不在仓库内），因此对主工作区的文件系统、文件搜索、文件监视、
  IDE 资源管理器一概不可见。
- 分支对话的读写以 worktree 为根；主工作区的文件、`git status` 完全不受影响。
- 每个分支对话对应一个**真实 git 分支** `tuxedo/<name>`：提交、历史、回退就是原生 git
  操作（模型用 `Bash` 执行 `git commit` / `git log` / `git reset`），不自建快照存储。
- 成果出口是**纯 git**：用户在主工作区执行 `git merge tuxedo/<name>`（或让模型执行）。
  本能力不提供发布按钮、不做三方对账、不自动写主工作区。

依赖目录（`node_modules` / `target` / venv 等）被 `.gitignore` 排除，worktree 天然没有；
Linux 上**且 Core 进程有挂载权限时**用 **overlayfs 只叠加依赖目录**（lower = 主工作区那份，
upper = 分支自己的增量；非特权进程探测失败同样退化为 `SkipDeps`），其余平台退化为
「不搬、模型按需重装」（FR-010）。

底层机制选 git worktree 而不是 overlayfs 做整个工作区、也不自建 Copy-on-Write 存储，取舍见
plan「被否决的替代方案」。**能力边界**：仅对 git 仓库可用（非 git 目录下分支对话入口置灰并
说明原因）；主工作区的未提交改动不进分支（分支从最新提交起，见 FR-003）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [1.1 Core 侧业务范围](../../docs/core/standalone-core.md#11-core-侧业务范围) | 修改 | 业务范围补「分支对话：git worktree 生命周期、分支命名、依赖目录策略、清理」 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [7. 事实归属](../../docs/core/standalone-core.md#7-事实归属) | 修改 | 事实表新增「分支对话的 worktree 路径与分支名」一行，owner 为 Core |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.1 CoreEvent](../../docs/architecture/events.md#21-coreeventcore--ui单向) | 修改 | 新增 `branchStateChanged`（全量快照）；`sessionConfigChanged` 的 change 联合补 `branchMode` 键 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.3 UiEvent](../../docs/architecture/events.md#23-uieventui--core单向) | 修改 | 新增 `branchModeChanged` / `branchPruneRequested` 两条 |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [2. 宿主侧的 core 事实读取](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | `UiRequest` 补 `branchTreeRequested`（分支 worktree 列目录）与 `branchOrphansRequested`（孤儿清单）；明确 worktree 路径等分支事实由 Core 下发、宿主只作显示、不自行跑 git |
| [docs/architecture/principles.md](../../docs/architecture/principles.md) | [7. 一份事实只有一个写入点](../../docs/architecture/principles.md#7-一份事实只有一个写入点) | 修改 | 事实表补「分支 worktree 的目录路径」：`meta.json` 的 `branch` 字段是唯一来源 |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | [EP-2 输入区与会话配置](../../docs/features/user-stories/dialog-core.md#ep-2-输入区与会话配置) | 修改 | 收录 US-76（新对话按钮 split 下拉选创建方式；US-8 菜单不加项） |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [EP-7 工具与技能](../../docs/features/user-stories/tools.md#ep-7-工具与技能) | 修改 | 收录 US-74 / US-75 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-61 Write 新建文件自动刷新文件树](../../docs/features/user-stories/desktop.md#us-61-write-新建文件自动刷新文件树) | 修改 | 侧栏文件树对分支对话读 worktree 树（不读主工作区） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [目录](../../docs/features/user-stories.md#目录) | 修改 | 对话分册收录范围补 US-76；工具分册补 US-74 / US-75 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | 登记三条新 US 的 e2e 落点或豁免理由 |
| [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md) | [待定](../../docs/architecture/open-questions.md) | 修改 | 登记「侧栏文件树的差异标记（预留：数据来源与 `change` 字段形态已定，本次不做）」、「Windows / macOS 的依赖目录复用（overlay 无等价物）」「非特权 Linux 的依赖目录复用（Core 无 `CAP_SYS_ADMIN` 时 overlay 挂不上，候选如 fuse-overlayfs 等用户态方案）」与「依赖策略是否开放用户配置」 |
| `docs/features/branch-conversation.md` | — | 新增 | 收敛后承载 as-built：worktree 生命周期与位置、分支命名、依赖策略、可见性边界、清理 |

## 用户场景与验收标准

- 场景 1：分支对话在自己的 worktree 里工作
  - **AC-1**（FR-002）：GIVEN 主工作区是 git 仓库 WHEN 创建分支对话 THEN Core 在 Core 数据目录下的 `<工作区目录>/worktrees/<branch>/` 建出 worktree，`branchStateChanged` 推送 `{ state: 'ready', branch, worktree, baseCommit, baseBranch, commits, dirty, peers, deps }`。
  - **AC-2**（FR-002）：GIVEN 分支对话 WHEN `Write` 写 `a.txt` 或 `Bash` 执行 `npm run build` THEN 文件落在 worktree 内；主工作区该路径不变、`git status` 无新增条目。
  - **AC-3**（FR-002）：GIVEN 分支对话 WHEN 调用工具 THEN 全部工具（`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob`）以 worktree 为根——实现是会话级 `cwd` 一次改向，无逐工具分支。
  - **AC-4**（FR-002）：GIVEN 分支对话的 worktree 已存在 WHEN 重新打开该对话 THEN 复用同一 worktree（不重建、不丢失未提交改动）。
- 场景 2：提交、历史与回退都是 git
  - **AC-5**（FR-004）：GIVEN 分支对话 WHEN 模型执行 `git commit` THEN 提交推进 `tuxedo/<name>` 分支指针，`git branch` 列表可见该名（`tuxedo/` 命名空间）。
  - **AC-6**（FR-004）：GIVEN 分支对话 WHEN 模型执行 `git log` / `git reset --hard` THEN 命令在 worktree 内正常执行，后果只影响该 worktree 与 `tuxedo/<name>`。
  - **AC-7**（FR-004）：GIVEN 分支历史面板 WHEN 打开 THEN 显示该分支的提交列表（短 id / 摘要 / 时间 / 与 base 的差异文件计数），数据来自 Core 侧读取而非宿主执行 git。
  - **AC-8**（FR-004）：GIVEN 分支对话 WHEN 看工具卡片 THEN 不显示自建 checkpoint 标记（提交由模型用 Bash 完成，无自建 Commit 概念）。
- 场景 3：创建前置与失败路径
  - **AC-9**（FR-003）：GIVEN 主工作区有未提交改动 WHEN 创建分支对话 THEN 状态条与创建入口说明「分支从最新提交 <base> 起，未提交改动不在本分支」，不弹阻塞确认框、不做 stash。
  - **AC-10**（FR-003）：GIVEN 目录不是 git 仓库（或不在仓库内） WHEN 看创建入口 THEN 分支对话项置灰并说明原因，不创建半成品。
  - **AC-11**（FR-003）：GIVEN worktree 创建失败（磁盘 / 权限 / 仓库锁） WHEN 创建分支对话 THEN 对话创建失败并说明原因，`meta.json` 不留半成品会话。
- 场景 4：并行、清理与启动对账
  - **AC-12**（FR-005）：GIVEN 同一仓库 WHEN 同时开三个分支对话 THEN 三份 worktree 互不可见对方的未提交改动，各自 `git status` 独立。
  - **AC-13**（FR-005）：GIVEN 分支对话 WHEN 删除该对话 THEN worktree 目录与 `tuxedo/<name>` 分支一并清理（未合并的提交一并丢弃，删除前提示提交数与差异计数）。
  - **AC-14**（FR-005）：GIVEN 应用异常退出留下的 worktree WHEN Core 启动 THEN 按 `meta.json` 对账：有效会话的 worktree 保留，孤儿 worktree 经 `branchOrphansRequested` 报告并可一键清理（`branchPruneRequested`，不自动删）。
  - **AC-15**（FR-005）：GIVEN 用户手动删除了 worktree 目录 WHEN 该对话下一轮开始 THEN 会话转 `unavailable` 并说明（不静默重建——未提交改动已丢失）。
- 场景 5：入口与展示
  - **AC-16**（FR-006）：GIVEN 任意宿主 WHEN 点新对话按钮的小三角 THEN 展开两个创建动作（普通对话 / 分支对话），无选中态；主「+」恒为普通方式新建。
  - **AC-17**（FR-006）：GIVEN 点「分支对话」 WHEN 创建 THEN 立即以分支形态建立，重开对话仍是分支形态；GIVEN 主「+」或「普通对话」 THEN 与今天完全一致。
  - **AC-18**（FR-006）：GIVEN 分支对话 WHEN 看消息区顶部 THEN 状态条显示分支名（`tuxedo/<name>`）+ worktree 状态 + 依赖策略 + 并行邻居计数（点击列出各分支名称 / 状态 / 提交数，可跳转）。
  - **AC-19**（FR-006）：GIVEN 分支对话 WHEN 看对话列表 THEN 条目标题前带 git-branch 图标 + 截断分支名（显示 `<name>` 而非 `tuxedo/` 前缀，宽度上限 140px），悬停显示全名与来源（「分支自 <baseBranch> · <base 短 id> · <创建时间>」，全部取自 `meta.json` 的 `branch` 字段与 `createdAt`）。
  - **AC-20**（FR-006）：GIVEN 宿主收到分支事件 WHEN 转发 THEN 宿主只翻译和路由，不本地改写分支事实；GIVEN 会话已打开但未收到 `branchStateChanged` WHEN 看分支入口 THEN 等待态，不按猜测值渲染。
- 场景 6：侧栏文件树
  - **AC-21**（FR-007）：GIVEN 活动对话是分支对话 WHEN 看 Electron 侧栏文件资源管理器 THEN 标题带分支名、树内容是 worktree 的树；GIVEN 切回普通对话 THEN 标题回落「（主分支）」、树是主工作区。
  - **AC-22**（FR-007）：GIVEN 分支对话 WHEN 侧栏右键 THEN 菜单只含只读操作（打开预览 / 复制路径）；`branchStateChanged` 到达时按 `branch` 失效原因重读。
- 场景 7：命名
  - **AC-23**（FR-009）：GIVEN 分支创建 WHEN 取名 THEN 名为绝区零角色英文名 + `-` + 3 位小写随机字母数字（如 `ellen-k3f`），格式匹配 `^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$`；会话改名不跟随。
  - **AC-24**（FR-009）：GIVEN 同仓库已存在同名分支 WHEN 创建新分支 THEN 换名重试，最终名字不与既有分支或 worktree 冲突。
- 场景 8：依赖目录
  - **AC-25**（FR-010）：GIVEN Linux 且依赖探测成功（Core 进程内试挂 overlay 通过）、主工作区有 `node_modules` WHEN 创建分支对话 THEN worktree 内 `node_modules` 读到主工作区内容，`npm install <新包>` 后该包只出现在 upper、主工作区 `node_modules` 不变。
  - **AC-26**（FR-010）：GIVEN 依赖探测失败（Core 进程无挂载权限，如非特权用户）或平台是 Windows WHEN 创建分支对话 THEN 装配 `SkipDeps`，不挂载任何东西，系统提示告知需自行安装依赖；分支对话其余能力不受影响。
  - **AC-27**（FR-010）：GIVEN 分支对话已挂 overlay WHEN 删除该对话 THEN 先卸载再删 worktree，upper 目录一并清理，主工作区依赖目录完好。
  - **AC-28**（FR-010）：GIVEN 主工作区没有某个已知依赖目录 WHEN 创建分支对话 THEN 不为该目录挂载（不创建空 lower）。
- 场景 9：契约与持久化
  - **AC-29**（FR-008）：GIVEN 分支成功创建 WHEN 观察事件流 THEN 新会话只经既有 `sessionCreated` 与 `conversationListChanged` 到达。
  - **AC-30**（FR-008）：GIVEN 分支会话已建立 WHEN 读 `meta.json` THEN `branch` 字段含 `name` / `worktree` / `baseCommit` / `baseBranch`，宿主侧 `ConversationMetadata` 类型与之同名同形（两侧同步测试锁定）。
  - **AC-31**（FR-008）：GIVEN 旧会话的 `meta.json` 没有 `branch` 键 WHEN 打开 THEN 按普通会话处理。

## 功能需求

### FR-001：事实归属——worktree 路径与分支名由 Core 拥有

分支对话的 worktree 路径与分支名是 Core 的事实，落在会话 `meta.json` 的
`branch: { name, worktree, baseCommit, baseBranch } | null`（Rust 写、TS 读，两侧同步）。
宿主只经 `branchStateChanged` 与 `branchTreeRequested` 消费，不自行拼路径、不自行跑 git。
真实仓库的 git 元数据（`.git/`、`.git/worktrees/`）由 git 自己管理，Core 不解析其内部格式
（全部经 `git worktree list --porcelain` 等命令读取）。

验收：
- **AC-32**（FR-001）：GIVEN 分支会话 WHEN 宿主渲染分支信息 THEN 全部数据来自 `branchStateChanged` 与 `meta.json`，宿主进程不执行 git 命令。
- **AC-33**（FR-001）：GIVEN git 的 `worktrees/<name>` 内部文件格式变化（升级 git 版本） WHEN 读取 worktree 事实 THEN 仍正确（不解析私有格式）。

### FR-002：会话级工作根改向

分支对话的所有工具以 worktree 为根：实现是会话级的**一次改向**——`SessionState.project`
与 `ToolContext.cwd` 指向 worktree（`core-rs/src/engine.rs` 的 `project_of` 是唯一派生点），
`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` 全部自动跟随，无逐工具分支、无工具层钩子。
`Bash` 的 `input.cwd` 语义不变（根内相对路径解析到根、绝对路径原样）。

**worktree 位置**：Core 数据目录下的 `<工作区目录>/worktrees/<branch>/`——**不在仓库内**。
这一条决定可见性（FR-011）：放在仓库内会让主工作区的 `Grep` / `Glob` / `Bash ls` / IDE
资源管理器 / 文件监视器全部看到分支内容，那是暴露而非隔离。

worktree 在创建分支对话时同步创建（`git worktree add <path> -b tuxedo/<name> HEAD`；失败则
会话创建失败并回滚，见 FR-003）；对话重开时已存在则复用。`cwd` 改向只在分支对话上发生，
普通对话的行为逐项不变。

### FR-003：创建前置与失败路径

- **仓库前置**：目标目录须在某个 git 仓库内（`git rev-parse --show-toplevel` 成功）。
  否则分支对话项置灰并说明原因。
- **未提交改动**：主工作区有未提交改动时**只说明不阻塞**——状态条与创建入口标注「分支从
  最新提交 `<base>` 起，未提交改动不在本分支」。不做 stash、不弹确认框（没有发布动作，
  未提交改动不会被覆盖或丢失）。
- **创建失败**（磁盘 / 权限 / 仓库锁）：会话创建失败并说明，`meta.json` 不留半成品，
  已建的分支与 worktree 回滚。
- **worktree 消失**：会话下一轮开始时发现 worktree 缺失 → 转 `unavailable` 并说明，
  不静默重建（未提交改动已丢失）。

### FR-004：提交、历史与回退交给 git

分支对话不自建 Commit / 检查点概念。模型用 `Bash` 执行原生 git 命令：

- **提交**：`git commit` → 推进 `tuxedo/<name>`（真实分支，`refs/heads/tuxedo/<name>`）。
  选真实分支而不是分离 HEAD + 隐藏 ref，是因为**分支 ref 是成果的唯一出口**——用户要能
  `git merge tuxedo/<name>`，ref 必须随时准确；分离 HEAD 需要每轮 `update-ref` 同步，ref
  最多落后一轮，出口就不可靠。
- **历史与回退**：`git log` / `git reset` / `git revert` 在 worktree 内正常执行，后果只影响
  该 worktree 与 `tuxedo/<name>`。
- **拒绝的操作**：`git worktree remove` 自身、`git branch -D` 自身的分支名（防模型自毁）；
  其余 git 命令不管。
- **系统提示**：分支对话的 system prompt 增补一段，说明「你在独立 worktree 里，分支名
  `tuxedo/<name>`，提交请用 git；用户在主工作区用 `git merge tuxedo/<name>` 取你的成果」。

分支历史面板展示 `git log --oneline <base>..HEAD` 的结果（Core 侧读取，宿主不跑 git）；
无提交时显示空态。回退不新造 UI：模型执行 `git reset`（面板里的「回退到此」按钮见非目标）。

### FR-005：并行、清理与启动对账

- **并行**：同一仓库可同时开多个分支对话，各自 worktree 独立，互不可见对方的未提交改动。
- **删除对话**：清理 worktree（`git worktree remove --force`）、`tuxedo/<name>` 分支、
  overlay 挂载与 upper 目录；删除前提示提交数与差异计数（未合并的提交会一并丢弃）。
- **启动对账**：Core 启动时按 `meta.json` 枚举分支会话，与 `git worktree list --porcelain`
  比对：有效会话的 worktree 保留，孤儿 worktree 报告并支持一键清理（不自动删——可能是用户
  手工创建的工作树；孤儿清单宿主经 `branchOrphansRequested` 拉取，清理动作是
  `branchPruneRequested`，见 FR-008）。
- **不写用户仓库的任何非 git 文件**：不在仓库内建目录、不改 `.gitignore`（worktree 在 Core
  数据目录，仓库里没有任何新增文件）。

### FR-006：入口与展示

**新对话是两个一次性创建动作，不是「模式选择」**：顶栏「新对话」按钮为 split button——
主「+」恒为普通方式新建（现状不变）；小三角展开「普通对话」与「分支对话」，点哪项就以
哪种形态创建，不记住选择、无选中态。三个入口（Electron 侧栏 / 顶栏 / VS Code）一致，
汇到既有 `openNewConversation` / `startNewConversation` 链。右下功能菜单（US-8）不加项。

**分支展示**：

1. **对话列表**：条目标题前带 git-branch 图标 + 截断分支名（显示 `<name>`，`tuxedo/`
   前缀只出现在悬停 tip 与状态条；宽度上限 140px）；tip 含来源（「分支自 <来源> ·
   <base 短 id> · <时间>」）与状态。数据随对话列表元数据下发；Electron 原生侧栏与
   webview 顶栏下拉一致呈现。
2. **会话内状态条**：消息区顶部状态条（形态对齐排队消息横幅）：分支名（`tuxedo/<name>`）+
   worktree 状态（就绪 / 不可用及原因）+ 依赖策略（共享 / 需自行安装）+ 并行邻居计数
   （点击弹出面板：各分支名称 / 状态 / 提交数，可跳转；同一面板列出可清理的孤儿 worktree
   ——数据经 `branchOrphansRequested` 拉取，一键清理发 `branchPruneRequested`）。
3. **分支历史**：顶栏时钟图标入口（与「对话历史」并排；Electron 原生侧栏头部同入口），
   显示 `git log --oneline <base>..HEAD`（短 id / 摘要 / 时间 / 差异文件计数）；无提交时
   显示空态并提示「模型提交后这里会出现历史」。

工具卡片不加分支相关按钮，也不加自建 checkpoint 标记。**无发布按钮**：成果出口是 git
命令（FR-011）。

### FR-007：文件资源管理器跟随对话

Electron 侧栏的「文件资源管理器」跟随当前活动对话：

- 标题旁括号标注分支名（分支对话显示 `<name>`，普通对话显示「主分支」）。
- 树内容 = 当前对话的工作根：分支对话读 worktree 的树；普通对话读主工作区（现状不变）。
- 刷新：`branchStateChanged` 到达时按 `branch` 失效原因重读（复用 specs/030 的
  `pushFilesInvalidate` 出口）。
- **不做差异标记**：树只展示 worktree 的文件与目录，不标注「新 / 改 / 删」、不做
  `git status` / `git diff --name-status` 的差异着色。这是**本次开发范围之外**的预留设计：
  将来要做时数据来源已确定（`git status --porcelain` + `git diff --name-status <base>`，
  按路径标记 added / modified / deleted），只需在 `branchTreeRequested` 的条目上补一个
  `change` 字段（判别联合，不用可选字段），UI 侧加徽标即可，契约其余部分不动。
- **写操作边界**：分支对话的侧栏视图只读（删除 / 新建隐藏）——分支的写入口是工具调用与
  git 命令，从侧栏直接删会绕过 git。侧栏写分支树是后续方向（[TODO.md](../../TODO.md)）。
- VS Code / TUI 无侧栏文件树，不涉及。

### FR-008：契约面与持久化

- `CoreEvent.branchStateChanged { sessionId, view }`：全量快照（漏推即错，与
  `sessionRuntimeChanged` 同口径）。`view` 判别联合：`{ state: 'ready', branch, worktree,
  baseCommit, baseBranch, commits, dirty, peers, deps }` 或 `{ state: 'unavailable', reason,
  detail }`（`reason` 取 `not-git` / `worktree-missing` / `git-failed`）；工作区无分支对话时
  推 `{ state: 'plain' }`。`commits` 为 git log 摘要（id / 摘要 / 时间 / 差异文件计数）；
  `dirty` 为 worktree 是否有未提交改动；`peers` 是同仓库其它分支对话的概览（名称 / 状态 /
  提交数）；`deps` 见 FR-010。
- `UiEvent` 两条：`branchModeChanged { sessionId, mode }`（创建动作的唯一携带者：webview
  点「分支对话」→ 宿主建会话后经本事件告知 Core，此后不再变）、`branchPruneRequested
  { worktree }`（一键清理孤儿 worktree；载荷不带 sessionId——孤儿没有会话，worktree 路径
  来自 Core 自己的孤儿清单，Core 校验在册才执行）。宿主只翻译 webview 消息，执行与守卫全在 Core。
- `UiRequest` 两条：`branchTreeRequested { sessionId, dir }`——宿主按活动会话索取该分支
  worktree 的目录树，Core 应答 `{ entries: DirectoryEntry[] }`（与既有文件树条目同形）或
  `{ ok: false, reason: 'not-branch' }`（宿主回落主工作区读盘）；`branchOrphansRequested`——
  启动对账后的孤儿 worktree 清单，应答 `{ orphans: { worktree, branch }[] }`（无孤儿为空数组）。
- `CoreEvent.sessionConfigChanged` 的 change 联合补
  `{ key: 'branchMode'; value: 'plain' | 'branch' }`。
- 会话形态与 worktree 事实持久化在 `meta.json`（`branch` 字段，见 FR-001）；旧会话没有
  该键一律按普通处理（宿主侧读取时把缺失归一为 `null`，`ConversationMetadata` 成员保持
  必选，不新增可选成员）。
- 新增事件按 [events.md 第 7 节](../../docs/architecture/events.md#7-新增事件时的检查清单)
  六步落地。

### FR-009：分支命名

名字 = 绝区零角色官方英文名 + `-` + 3 位小写随机字母数字，如 `ellen-k3f`。角色名取通行
英文简称（单名小写 `anby` / `nicole` / `billy` / `lycaon` / `miyabi`，多字名转连字符
`zhu-yuan` / `qing-yi`），核心代码内置常量表，命名时随机取一个。git 分支名为
`tuxedo/<name>`；同仓库重名换名重试；名字创建时定死，会话改名不跟随。

### FR-010：依赖目录策略

依赖目录（被 `.gitignore` 排除、体积大、路径敏感）不进 worktree。策略抽象成
`DepStrategy` trait（`install` / `uninstall` / `describe`），按平台与能力装配：

| 平台 | 实现 | 行为 |
| --- | --- | --- |
| Linux（Core 进程可挂载 overlay） | `OverlayDeps` | 对主工作区里**已存在**的已知依赖目录（`node_modules` / `target` / `.venv` / `venv` / `vendor` / `.gradle` / `build`）在 worktree 内挂 overlay：lower = 主工作区那份（只读），upper = `<工作区目录>/worktrees/deps/<branch>/<dir>`（分支增量，与 worktree 同生命周期，但在 worktree 目录**外**）。分支读到的依赖与主工作区一致，`npm install` 只写 upper，主工作区不动 |
| Linux（Core 进程不能挂载：非特权进程 / 内核不支持） | `SkipDeps` | 不搬，系统提示告知模型「依赖需自行安装」 |
| Windows / macOS | `SkipDeps` | 同上（无 overlay 等价物） |

- **探测时机**：首次创建分支对话时一次判定——**在 Core 进程内**实际试挂一个临时 overlay
  再卸载（比读 `/proc/filesystems` 可靠，后者只看模块存在；也不能用 `unshare` 子进程代替：
  子进程在独立命名空间里试挂成功不代表多线程的 Core 进程自己能挂，且子进程的挂载对本进程
  不可见，会「探测通过、真挂失败」）。结果进程内缓存，失败不重试（不过度 fallback），
  **不降级为符号链接**（link 会让分支的安装直写主工作区，隔离失效，见被否决方案）。
  非特权 Core 进程探测失败即 `SkipDeps`——这是设计允许的档位，不是静默降级。
- **只叠加已存在的目录**：主工作区没有 `node_modules` 就不挂（避免创建空 lower 层）。
- **upper 在 worktree 外**（`worktrees/deps/<branch>/`，与 worktree 平级）：upper 里的增量与
  whiteout 字符设备若落在 worktree 内，会以未跟踪文件污染该分支自己的 `git status`，`dirty`
  判定失真；放外面同时让 `git worktree remove` 不撞上层目录（挂载点仍在 worktree 内，先卸载
  即可，见卸载顺序）。
- **跨文件系统**：overlayfs 的 upper 与 workdir 须同一文件系统（都在 Core 数据目录内即
  满足），lower 可在另一文件系统（主工作区在别处）；试挂失败即 `SkipDeps`。
- **写隔离**：分支在挂载点内的写入只落 upper；主工作区的依赖目录一字不改。
- **卸载顺序**：先卸载所有挂载点，再 `git worktree remove`；upper 目录
  （`worktrees/deps/<branch>/`）随 worktree 一并删除。
- **崩溃残留**：Core 启动对账时枚举 `/proc/self/mountinfo` 里 `upperdir` 指向本工作区
  `worktrees/deps/` 的挂载点，仍挂着就卸载；对应会话已不存在则报告孤儿并把目录纳入一键清理。
- **系统提示**：无论哪档实现，都说明「依赖目录在哪、是否需要自行安装」。

### FR-011：可见性边界与成果出口

**worktree 放在 Core 数据目录（FR-002）是可见性设计的全部机制**，不靠权限、不靠过滤、不靠
文件监视白名单。逐观察者说明：

| 观察者 | 结果 | 机制 |
| --- | --- | --- |
| 主工作区 `git status` / `git diff` | 无任何分支内容 | worktree 不在仓库目录树内 |
| IDE 资源管理器 / 我们的侧栏文件树 | 无任何分支内容 | 同上（侧栏对分支对话读 `branchTreeRequested`，是另一条通道） |
| 主对话的 `Grep` / `Glob` | 搜不到 | 它们的根是主工作区（`ctx.cwd`），不是 worktree |
| 主对话的 `Bash`（`ls` / `rg` / `find`） | 看不到 | 同上 |
| 宿主的文件监视器 | 不监视分支文件 | 监视器按主工作区路径注册 |
| `git branch` | 见 `tuxedo/<name>` | **有意可见**：成果出口 |
| `git worktree list` | 见 worktree 路径 | **有意可见**：git 自己登记的工作树表，无法隐藏 |

`git worktree list` 的可见性是 git 的固有行为（工作树登记在 `<repo>/.git/worktrees/`），
不值得为隐藏它引入额外机制；它不出现在 `git status`、资源管理器、文件搜索、文件监视里。

**成果出口是唯一一条**：用户在主工作区执行 `git merge tuxedo/<name>`（或让模型执行）。
合并由 git 完成，冲突由 git 报出，我们的代码不介入、不改写、不弹自己的冲突 UI。因此：

- 没有发布按钮、没有 `branchPublished` 事件、没有三方对账、不自动写主工作区；
- 分支 ref 必须随时准确（这是 FR-004 选真实分支而非分离 HEAD + 隐藏 ref 的原因）。

验收：
- **AC-34**（FR-011）：GIVEN 分支对话存在且已产生文件 WHEN 在主工作区执行 `git status`、用 IDE 看资源管理器、主对话跑 `Grep` / `Glob`、宿主文件监视器观察 THEN 均无分支内容。
- **AC-35**（FR-011）：GIVEN 分支对话 WHEN 在主工作区执行 `git merge tuxedo/<name>` THEN 合并按 git 原生行为进行（冲突由 git 报出），我们的代码不介入。
- **AC-36**（FR-011）：GIVEN 分支对话 WHEN 检查主工作区文件 THEN 仓库内没有任何本能力新增的文件（无 `.tuxedo/`、无 `.gitignore` 改动）。

## 边界与错误路径

| 情形 | 预期行为 |
| --- | --- |
| 目录不是 git 仓库 | 入口置灰并说明；已存在的分支会话若仓库消失 → `unavailable` |
| 主工作区有未提交改动 | 状态条与入口说明「未提交改动不在本分支」，不阻塞、不 stash |
| 主工作区在分支工作期间切了分支 / 改了文件 | 不影响已建 worktree（两者互不相干） |
| worktree 创建失败 | 会话创建失败并说明，回滚已建分支与目录，不留半成品 |
| 用户手动删除 worktree | 下一轮转 `unavailable`，不重建 |
| 用户手动 `git worktree prune` | 与上一条同路径 |
| 用户手动 `git branch -D tuxedo/<name>` | worktree 仍在但分支指针没了 → 下一轮检测到转 `unavailable` 并说明 |
| 分支名撞名 | 换名重试直到不撞 |
| 模型执行 `git worktree remove` / `git branch -D` 自身分支 | 拒绝并说明（防自毁） |
| 分支对话有未提交改动时删除会话 | 提示提交数与差异计数后清理 worktree、分支与 upper |
| 后台任务（`run_in_background`）的 `cwd` | 指向 worktree，产物留在 worktree |
| `Bash` 的 `cwd` 在 worktree 外 | 原样交子进程执行（现状语义），后果不进分支视图 |
| `detach: true` | 脱离工具管理，后台继续跑（与既有语义一致） |
| 依赖目录挂载失败（权限 / 空间） | 该目录退化为 `SkipDeps` 并提示模型需自行安装，其余能力不受影响 |
| 用户在挂载点内删依赖 | 只删 upper 中的条目（whiteout），主工作区依赖不变 |
| 用户在 worktree 内 `npm install` | 只写 upper，主工作区依赖不变 |
| 用户在主工作区 `git merge tuxedo/<name>` 产生冲突 | git 自己的行为，我们不介入也不改写（FR-011） |
| 旧会话的 `meta.json` 没有 `branch` 键 | 按普通会话处理（兼容） |
| 普通对话 | 行为逐项不变，不涉 worktree |

## 非目标

- **发布 / 自动落地 / 三方对账**：不做。成果出口是原生 git 命令，我们既不提供发布按钮、
  也不自动写主工作区、也不做冲突点名 UI。
- **overlayfs 做整个工作区**：不引入（否决理由见 plan「被否决的替代方案」第 1 条）。因此
  分支看不到主工作区的**未提交**改动——只看到已提交内容（git worktree 的固有语义）。
  overlay 只用于依赖目录叠加（FR-010），不改变工作区隔离语义。
- **自建 CoW 存储（内容寻址对象库 + 自建 Commit）**：不引入（否决理由见 plan 第 2 条）。
- **主工作区未提交改动的自动带入**：不 stash、不临时快照。
- **自建 Commit / 检查点 / 逐调用快照**：提交交给 git 与模型。
- **分支历史面板里的「回退到此」按钮**：首版只读展示；回退由模型执行 `git reset`。
  去向：[TODO.md](../../TODO.md)。
- **合并 UI**：不提供「合并到主工作区」按钮（见第一条）。
- **侧栏文件树的差异标记**：不做「新 / 改 / 删」徽标与差异着色。预留设计（数据来源、
  契约字段形态）见 FR-007，去向 [open-questions](../../docs/architecture/open-questions.md)。
- **Windows / macOS 的依赖目录复用**：不提供（无 overlay 等价物），退化为按需重装。
- **依赖策略的用户配置**：不提供，按平台与能力自动装配。
- **非 git 目录的分支对话**：不支持（入口置灰）。
- **bare 仓库 / 嵌套子模块作为工作区**：不特殊处理，按 git 自身行为。
- **worktree 内的独立 IDE 打开入口**：不提供（worktree 路径是实现细节）。
- **跨机器共享分支**：分支只在本地仓库。
- **写用户仓库的 `.gitignore` 或任何非 git 文件**：不做（worktree 在 Core 数据目录）。

## 对需求基线的影响

新增三条 US：

- **US-76 新对话选创建方式**（[dialog-core.md EP-2](../../docs/features/user-stories/dialog-core.md#ep-2-输入区与会话配置)）：
  新对话按钮 split 下拉选「普通对话（默认）/ 分支对话」，点击即以该形态创建；非 git
  仓库时分支对话项置灰并给原因。
- **US-74 分支对话的独立工作区**（[tools.md EP-7](../../docs/features/user-stories/tools.md#ep-7-工具与技能)）：
  分支对话在独立 worktree 里工作，主工作区不受影响；状态条与历史面板展示分支状态与提交；
  成果经 `git merge tuxedo/<name>` 取用。
- **US-75 多个 agent 并行工作**（[tools.md EP-7](../../docs/features/user-stories/tools.md#ep-7-工具与技能)）：
  同时开多个分支对话各自独立工作，对话列表分支标记 + 并行邻居面板展示全部并行 agent。

三条当前都无完整 e2e 用例：分层验证依赖真实 Core 二进制与真实 git 仓库，`e2e/webview` 与
`e2e/electron` 车道没有 git 仓库夹具（也不为此引入——会拖慢整车道）。按既有豁免口径登记为
「e2e 豁免 + core 侧证据」，证据链见 plan「测试方案」：

- **核心行为**（worktree 创建 / 复用 / 清理、分支指针、启动对账、依赖策略装配、可见性边界）
  由 `core-rs` 单测用真实 git 夹具锁定；
- **契约往返**由 `standaloneBranch` 驱动真实 Core 二进制锁定（CI 的 tests job 在
  ubuntu-latest 上真跑；本地缺产物时 `markSkipped` 并打印原因，不算通过）；
- **e2e 只覆盖三件不依赖 Core 的 UI 事**：US-76 的下拉渲染与置灰、US-74 的状态条渲染、
  分支历史面板空态。

正式开发调测在 Linux 上做；Windows 上分支能力的行为（worktree 与路径处理）同样有单测真跑，
不因「只在 Linux 调测」而失去对称性验证。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `meta.json` 的 `branch` 字段（Rust 写 / TS 读）+ `src/shared/history/` 类型 | 单测：字段往返、旧会话兼容、不解析 git 私有格式 | 自动 |
| FR-002 | `core-rs/src/branch/`（worktree 生命周期）+ `SessionState.project` 改向（`engine.rs` 的 `project_of`） | 单测：全部工具跟随 cwd、worktree 复用、主工作区零改动 | 自动 |
| FR-003 | `git rev-parse` 前置校验、脏工作区判定、失败回滚 | 单测：非 git 拒绝、脏工作区只说明、创建失败不留会话 | 自动 |
| FR-004 | `tuxedo/<name>` 分支 + 系统提示增补 + `git log` 读取 + 自毁命令拦截 | 单测：提交推进分支指针、历史读取、拦截 worktree remove；standalone：真实 git 驱动 | 自动 |
| FR-005 | 删除清理（卸载 → remove worktree → 删分支）+ 启动对账 | 单测：清理顺序、孤儿报告、启动对账 | 自动 |
| FR-006 | `App.tsx` split button + 状态条 + 对话列表分支标记 + 历史面板 | e2e：下拉渲染与置灰（US-76）、状态条（US-74）；单测：UiEvent 翻译、等待态 | 自动 |
| FR-007 | `UiRequest.branchTreeRequested` + 侧栏 `branch` 失效原因 | 单测：应答形态与 not-branch 回落、条目**不含** `change` 字段（差异标记未做）；侧栏失效链同族用例 | 自动 |
| FR-008 | `src/shared/AssistantEventBus.ts` 联合类型 + `meta.json` 持久化 | `standalone*`：帧往返与快照字段；docsLint：事件表与载荷列 | 自动 |
| FR-009 | 角色名常量表 + 随机后缀 | 单测：命名格式、撞名重试 | 自动 |
| FR-010 | `core-rs/src/branch/deps.rs`（`DepStrategy` + `OverlayDeps` / `SkipDeps`） | 单测：两档装配、隔离性、卸载顺序；overlay 真实挂载用例在 Linux 车道跑（CI tests job 是 ubuntu-latest，Windows 车道只跑 `SkipDeps` 装配） | 自动 |
| FR-011 | worktree 位置（Core 数据目录）与分支命名空间 | 单测：仓库内无新增文件、`git status` 干净、`git branch` 含 `tuxedo/` 命名、主对话 `Grep` / `Glob` 搜不到分支内容；不做 e2e（无 git 夹具，理由见「对需求基线的影响」） | 自动 |

## 待澄清

（实施前清零——已关闭：底层机制定 git worktree、分支用真实分支 `tuxedo/<name>`、不做发布
（纯手动 git 出口）、worktree 放 Core 数据目录、依赖目录首版 Linux 用 overlay 叠加其余平台
退化为按需重装、依赖策略留接口但只装配两档。本轮无新增未决项。）

## 收敛记录

待 `/converge` 填写。

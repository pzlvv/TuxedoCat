---
owner: pzlvv
last_reviewed: 2026-11-01
---

# 规格：分支对话（git worktree 隔离）

本规格界定**分支对话**：一个工作区里可以同时开多个对话，每个分支对话在自己的 git
worktree 目录里工作，该目录位于 Core 数据目录（**不在仓库内**），因此对主工作区的文件
系统、文件搜索、文件监视、IDE 资源管理器一概不可见。每个分支对话对应一个真实 git 分支
`tuxedo/<name>`：提交、历史、回退就是原生 git 操作（模型用 `Bash` 执行 `git commit` /
`git log` / `git reset`），不自建快照存储。成果出口是纯 git：用户在主工作区执行
`git merge tuxedo/<name>`。本规格**不覆盖**发布 / 自动落地 / 三方对账（都不做），也不覆盖
会话数据落盘格式的其余部分（见 [docs/core/standalone-core.md 第 7 节](../core/standalone-core.md#7-事实归属)）。

交叉引用：事件词汇表见 [events.md 第 2.1 节](../architecture/events.md#21-coreeventcore--ui单向)与
[第 2.3 节](../architecture/events.md#23-uieventui--core单向)；`UiRequest` 与宿主读 core 事实的边界见
[standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)；
「一份事实只有一个写入点」见 [principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)；
「webview 不持有事实的默认值」见 [principles.md 第 10 节](../architecture/principles.md#10-webview-不持有事实的默认值)；
工具执行根与提示词见 [standalone-core.md 第 1.1 节](../core/standalone-core.md#11-core-侧业务范围)。

## 1. 用户场景与验收标准

- 场景 1：分支对话在自己的 worktree 里工作
  - **AC-1**（FR-002）：GIVEN 主工作区是 git 仓库 WHEN 发送分支对话的第一条消息 THEN 会话与 worktree 一并建立：Core 在 Core 数据目录下的 `<工作区短名>/worktrees/<branch>/` 建出 worktree，`branchStateChanged` 推送 `{ state: 'ready', branch, worktree, baseCommit, baseBranch }`。
  - **AC-2**（FR-002）：GIVEN 分支对话 WHEN `Write` 写 `a.txt` 或 `Bash` 执行 `npm run build` THEN 文件落在 worktree 内；主工作区该路径不变、`git status` 无新增条目。
  - **AC-3**（FR-002）：GIVEN 分支对话 WHEN 调用工具 THEN 全部工具（`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob`）以 worktree 为根——实现是会话级 `cwd` 一次改向，无逐工具分支。
  - **AC-4**（FR-002）：GIVEN 分支对话的 worktree 已存在 WHEN 重新打开该对话 THEN 复用同一 worktree（不重建、不丢失未提交改动）。
- 场景 2：提交、历史与回退都是 git
  - **AC-5**（FR-004）：GIVEN 分支对话 WHEN 模型执行 `git commit` THEN 提交推进 `tuxedo/<name>` 分支指针，`git branch` 列表可见该名。
  - **AC-6**（FR-004）：GIVEN 分支对话 WHEN 模型执行 `git log` / `git reset --hard` THEN 命令在 worktree 内正常执行，后果只影响该 worktree 与 `tuxedo/<name>`。
  - **AC-7**（FR-004）：GIVEN 分支对话 WHEN 看工具卡片 THEN 不显示自建 checkpoint 标记。
- 场景 3：创建前置与失败路径
  - **AC-8**（FR-003）：GIVEN 主工作区有未提交改动 WHEN 打开分支对话入口与草稿页 THEN 说明「分支从最新提交 <base> 起，未提交改动不在本分支」，不弹阻塞确认框、不做 stash、不阻塞发送。
  - **AC-9**（FR-003）：GIVEN 目录不是 git 仓库 WHEN 看创建入口 THEN 分支对话项置灰并说明原因，不创建半成品。
  - **AC-10**（FR-003）：GIVEN worktree 创建失败 WHEN 发送第一条消息建立会话 THEN 会话建立失败并说明原因，草稿页保留已输入内容、可重试，`meta.json` 不留半成品会话。
- 场景 4：并行、清理与启动对账
  - **AC-11**（FR-005）：GIVEN 同一仓库 WHEN 同时开三个分支对话 THEN 三份 worktree 互不可见对方的未提交改动，各自 `git status` 独立。
  - **AC-12**（FR-005）：GIVEN 分支对话 WHEN 删除该对话 THEN worktree 目录与 `tuxedo/<name>` 分支一并清理，计数写诊断日志。
  - **AC-13**（FR-005）：GIVEN 应用异常退出留下的 worktree WHEN Core 启动 THEN 按 `meta.json` 对账：有效会话的 worktree 保留，孤儿 worktree 只写诊断日志。
  - **AC-14**（FR-005）：GIVEN 用户手动删除了 worktree 目录 WHEN 该对话下一轮开始 THEN 会话转 `unavailable` 并说明（不静默重建）。
- 场景 5：入口与展示
  - **AC-15**（FR-006）：GIVEN 任意宿主 WHEN 点新对话按钮的小三角 THEN 展开两个创建动作（普通对话 / 分支对话），无选中态；主「+」恒为普通方式新建。
  - **AC-16**（FR-006）：GIVEN 点「分支对话」 WHEN 看新对话 THEN 只打开分支形态的草稿页——标题前有一个分支图标（唯一的形态标记），不显示分支名、不显示「分支对话」字样，不建会话、不建 worktree、不发总线事件；切回普通草稿页时图标消失。WHEN 发送第一条消息 THEN 会话以分支形态建立。
  - **AC-17**（FR-006）：GIVEN 分支对话 WHEN 看顶栏 THEN 会话标题**前**显示分支名（不带 `tuxedo/` 前缀），标题区没有图标、没有「分支对话」字样；消息区与状态条区域没有任何分支横幅、依赖策略、并行计数或发布按钮。
  - **AC-18**（FR-006）：GIVEN 分支对话 WHEN 看对话列表 THEN 条目标题前显示截断分支名（宽度上限 140px，无图标），悬停显示全名与来源。
  - **AC-19**（FR-006）：GIVEN 宿主收到分支事件 WHEN 转发 THEN 宿主只翻译和路由，不本地改写分支事实；GIVEN `branchStateChanged` 未到达 WHEN 看分支入口 THEN 等待态，不按猜测值渲染。
- 场景 6：侧栏文件树
  - **AC-20**（FR-007）：GIVEN 活动对话是分支对话 WHEN 看 Electron 侧栏文件资源管理器 THEN 标题带分支名、树内容是 worktree 的树；GIVEN 切回普通对话 THEN 标题回落「主分支」、树是主工作区。
  - **AC-21**（FR-007）：GIVEN 分支对话 WHEN 侧栏右键 THEN 菜单只含只读操作；`branchStateChanged` 到达时按 `branch` 失效原因重读。
- 场景 7：命名与依赖
  - **AC-22**（FR-009）：GIVEN 分支创建 WHEN 取名 THEN 名为绝区零角色英文名 + `-` + 3 位小写随机字母数字，格式匹配 `^[a-z]+(-[a-z]+)*-[a-z0-9]{3}$`；会话改名不跟随。
  - **AC-23**（FR-009）：GIVEN 同仓库已存在同名分支 WHEN 创建新分支 THEN 换名重试，最终名字不与既有分支或 worktree 冲突。
  - **AC-24**（FR-010）：GIVEN Linux 且 overlay 探测成功、主工作区有 `node_modules` WHEN 创建分支对话 THEN worktree 内 `node_modules` 读到主工作区内容，分支的安装只落 upper。
  - **AC-25**（FR-010）：GIVEN overlay 探测失败或平台是 Windows WHEN 创建分支对话 THEN 装配 `SkipDeps`，系统提示告知需自行安装依赖；其余能力不受影响。
  - **AC-26**（FR-010）：GIVEN 分支对话已挂 overlay WHEN 删除该对话 THEN 先卸载再删 worktree，upper 目录一并清理。
  - **AC-27**（FR-010）：GIVEN 主工作区没有某个已知依赖目录 WHEN 创建分支对话 THEN 不为该目录挂载。
- 场景 8：契约、持久化与可见性
  - **AC-28**（FR-008）：GIVEN 分支成功创建 WHEN 观察事件流 THEN 新会话只经既有 `sessionCreated` 与 `conversationListChanged` 到达。
  - **AC-29**（FR-008）：GIVEN 分支会话已建立 WHEN 读 `meta.json` THEN `branch` 字段含 `name` / `worktree` / `baseCommit` / `baseBranch`，宿主侧 `ConversationMetadata.branch` 与之同名同形。
  - **AC-30**（FR-008）：GIVEN 旧会话的 `meta.json` 没有 `branch` 键 WHEN 打开 THEN 按普通会话处理。
  - **AC-31**（FR-001）：GIVEN 分支会话 WHEN 宿主渲染分支信息 THEN 全部数据来自 `branchStateChanged` 与 `meta.json`，宿主进程不执行 git 命令。
  - **AC-32**（FR-001）：GIVEN git 的 `worktrees/<name>` 内部文件格式变化 WHEN 读取 worktree 事实 THEN 仍正确（不解析私有格式）。
  - **AC-33**（FR-011）：GIVEN 分支对话存在且已产生文件 WHEN 在主工作区执行 `git status`、用 IDE 看资源管理器、主对话跑 `Grep` / `Glob` THEN 均无分支内容。
  - **AC-34**（FR-011）：GIVEN 分支对话 WHEN 在主工作区执行 `git merge tuxedo/<name>` THEN 合并按 git 原生行为进行，我们的代码不介入。
  - **AC-35**（FR-011）：GIVEN 分支对话 WHEN 检查主工作区文件 THEN 仓库内没有任何本能力新增的文件。
  - **AC-36**（FR-010）：GIVEN 主工作区有被 `.gitignore` 忽略的 `.env` WHEN 创建分支对话 THEN worktree 内 `.env` 是指向主工作区原文件的符号链接；主工作区原子替换保存后分支读到新值。
  - **AC-37**（FR-010）：GIVEN 符号链接创建失败 WHEN 创建分支对话 THEN 退化为创建时复制（主工作区后续更新不传播），档位写诊断日志并进系统提示。

## 2. 功能需求

### FR-001：事实归属——worktree 路径与分支名由 Core 拥有

分支对话的 worktree 路径与分支名是 Core 的事实，落在会话 `meta.json` 的
`branch: { name, worktree, baseCommit, baseBranch } | null`（Rust 写、TS 读）。
宿主只经 `CoreEvent.branchStateChanged` 与 `UiRequest.branchTreeRequested` 消费，
不自行拼路径、不自行跑 git。git 的 `.git/` / `.git/worktrees/` 是 git 自己管理的私有格式，
Core 全部经 `git worktree list --porcelain` 等命令读取，不解析其内部文件。

### FR-002：会话级工作根改向 + worktree 位置

`SessionState.branch` 是「这个会话是不是分支对话」的唯一内存事实，工具执行根由
`Core::tool_root_of` **一处**派生：分支会话返回 `branch.worktree`，其余会话返回
`project_of` 的原文。`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` 全部经
`ToolContext.cwd` 跟随，无逐工具分支、无工具层钩子；`Bash` 的 `input.cwd` 语义不变
（根内相对路径解析到根、绝对路径原样交子进程）。

**worktree 位置**：`<Core 数据目录>/worktrees/<工作区短名>/<branch>/`——**不在仓库内**。`<工作区短名>` 是 `w-<sha256 前 12 位>`，固定长度：目录名若随工作区完整路径编码（复用它上面的对话空间目录），再拼 `<branch>/` 与 worktree 内的 `.git` 后会越过 Windows 的 260 字符上限 （缺陷规格 `specs/defects/branch-worktree-path-exceeds-windows-max-path.md`）。工作区全路径仍由 `meta.json` 的 `branch.worktree` 承载。
这一条决定可见性（FR-011）：放在仓库内会让主工作区的 `Grep` / `Glob` / `Bash ls` / IDE
资源管理器 / 文件监视器全部看到分支内容，那是暴露而非隔离。

worktree 在**会话建立时**同步创建（`git worktree add <path> -b tuxedo/<name> HEAD`），
会话重开时已存在则复用并校验 HEAD 与 `meta.json` 一致。

### FR-003：创建前置与失败路径

仓库前置数据经 `UiRequest.branchPrecheckRequested` 拉取（会话建立前没有
`branchStateChanged`，入口数据只有这一条来源；宿主不跑 git）：
`{ ok: true, head, dirty, baseBranch }` 或 `{ ok: false, reason: 'not-git', detail }`。
下拉展开与草稿页打开时各拉一次，不缓存承诺。

主工作区有未提交改动时**只说明不阻塞**：创建入口与草稿页标注「分支从最新提交 `<base>`
起，未提交改动不在本分支」。不做 stash、不弹确认框。

创建失败（磁盘 / 权限 / 仓库锁 / 发送时才暴露的非 git）发生在第一条消息的会话建立链上：
会话建立失败并说明，草稿页保留已输入内容、可重试，`meta.json` 不留半成品。

worktree 消失（用户手工删除 / `git worktree prune` / 分支被删）→ 下一轮开始时转
`unavailable` 并说明，**不静默重建**（未提交改动已丢失）。

### FR-004：提交、历史与回退交给 git

不自建 Commit / 检查点概念。模型用 `Bash` 执行原生 git 命令：`git commit` 推进
`tuxedo/<name>`（真实分支，ref 是成果的唯一出口）；`git log` / `git reset` / `git revert`
在 worktree 内正常执行，后果只影响该 worktree 与该分支。分支会话里拒绝作用于**自身**的
`git worktree remove` 与 `git branch -D tuxedo/<自身分支>`（防自毁）。系统提示追加一段，
说明「你在独立 worktree 里，分支名 `tuxedo/<name>`，提交请用 git；用户在主工作区用
`git merge tuxedo/<name>` 取你的成果」。提交历史不在 UI 里展示。

### FR-005：并行、清理与启动对账

同一仓库可同时开多个分支对话，各自 worktree 独立。删除对话时清理 worktree
（`git worktree remove --force`）、`tuxedo/<name>` 分支、overlay 挂载与 upper 目录；
提交数与差异计数写诊断日志（view 已收窄到最小事实集，不为确认框恢复计数字段）。
Core 启动时按 `meta.json` 枚举分支会话，与 `git worktree list --porcelain` 比对：有效会话的
worktree 保留，孤儿 worktree 只写诊断日志（不自动删、也不推送 UI）。本能力不写用户仓库的
任何非 git 文件：不在仓库内建目录、不改 `.gitignore`。

### FR-006：入口与展示

新对话是两个**一次性创建动作**，不是「模式选择」：三个入口（webview 顶栏 split button /
Electron 原生侧栏 split button / VS Code 顶栏）都是「主「+」恒为普通方式新建 + 小三角展开
两项」的同一形态。「普通对话」与「分支对话」点哪项就以哪种形态打开草稿页，不记住选择、
无选中态；下拉里两项各带一行说明（「直接读写工作区」/「在独立 worktree 里工作」，非 git
仓库时后者换成置灰原因）。下拉是 antd `Dropdown`，主题 token 与输入区两处菜单同源
（`src/webview/components/dropdownMenuTheme.ts`），亮 / 暗两套主题下弹层背景与文字跟随
主题色板；Electron 原生侧栏的自绘菜单与文件右键菜单同一灰阶、同样有浅色主题覆盖。
右下功能菜单（US-8）不加项。

**创建时序**：点「分支对话」只打开分支形态的草稿页（`new-` 临时 key 视图），不建会话、
不建 worktree、不发总线事件；发送第一条消息时 webview 在 `startNewConversation` 载荷里带
形态标记 `mode: 'branch'`，宿主翻译成 `UiEvent.branchModeChanged`——形态到达 Core 的唯一
一跳；Core 预创建引擎时同步建 worktree 并改向，失败即会话建立失败（FR-003）。重开该对话
按 `meta.json` 的 `branch` 字段复用 worktree。多视图宿主（Electron）的形态随**视图**走：
`openNewConversation` 带 `mode`，新视图以 `--draftMode=branch` 注入，草稿视图只在形态相同时
被复用（注入值只在创建时生效，改写已建视图会让草稿表现与首条消息的形态分叉）。

**展示**：草稿页**不显示分支名**（它是「还没发第一条消息」的状态，用户在这里只该看到形态），
标题前显示一个分支图标作为形态标记，脏工作区时输入区上方展示一行纯文字提示；对话列表（webview 顶栏下拉与 Electron
原生侧栏一致）条目标题前显示截断分支名（`<name>`，宽度上限 140px，无图标），悬停显示
「分支自 `<baseBranch>` · `<base 短 id>` · `<时间>`」；会话标题**前**显示分支名
（只有名字本身，不带图标、不带「分支对话」字样，悬停显示完整 `tuxedo/<name>`）。
`view.state === 'unavailable'` 时分支名转警告色并在悬停里给出原因，同时按既有会话错误通道
提示一次；它不是一个常驻状态区。**不新增任何面板或入口**：顶栏的时钟图标是既有的
「对话历史」，本能力不改动它；也不新增分支历史面板。**无发布按钮**。

### FR-007：文件资源管理器跟随对话

Electron 侧栏的「文件资源管理器」跟随当前活动对话：标题旁括号标注分支名（分支对话显示
`<name>`，普通对话显示「主分支」）；树内容 = 当前对话的工作根——分支对话经
`UiRequest.branchTreeRequested` 读 worktree（应答 `{ ok: true, entries }` 或
`{ ok: false, reason: 'not-branch' }`，宿主据此回落主工作区读盘），普通对话读主工作区。
`branchStateChanged` 到达时按 `branch` 失效原因重读（复用 specs/030 的
`pushFilesInvalidate` 出口）。树只读（右键只有打开预览 / 复制路径）。

**不做差异标记**：树只展示 worktree 的文件与目录，不标注「新 / 改 / 删」、不做
`git status` / `git diff --name-status` 的差异着色。这是本次开发范围之外的预留设计：
将来要做时数据来源已确定（`git status --porcelain` + `git diff --name-status <base>`），
只需在条目上补一个 `change` 字段（判别联合，不用可选字段），契约其余部分不动。
去向见 [open-questions.md](../architecture/open-questions.md)。

### FR-008：契约面与持久化

- `CoreEvent.branchStateChanged { sessionId, view }`：全量快照（漏推即错）。
  `view` 判别联合：`plain` / `ready`（`branch` / `worktree` / `baseCommit` / `baseBranch`）/
  `unavailable`（`reason` 取 `not-git` / `worktree-missing` / `git-failed`，带 `detail`）。
  视图只带渲染标题前分支名所需的最小事实——**不带** `commits` / `dirty` / `peers` / `deps`。
- `UiEvent.branchModeChanged { sessionId, mode }`：形态到达 Core 的唯一一跳。宿主只翻译
  webview 消息，执行与守卫全在 Core；此后不再变（因此没有「切换模式」入口）。
- `UiRequest.branchTreeRequested { sessionId, dir }`（目录树）与
  `UiRequest.branchPrecheckRequested { workspacePath }`（创建入口前置数据）。宿主不跑 git。
- `CoreEvent.sessionConfigChanged` 的 change 联合带 `{ key: 'branchMode'; value: 'plain' | 'branch' }`。
- 落盘：`meta.json` 的 `branch` 字段（FR-001）；旧会话没有该键一律按普通处理，读取侧归一为
  `null`，`ConversationMetadata.branch` 成员保持必选。
- 快照：**无新增字段**（分支能力不需要配置项——worktree 路径固定、命名固定、无预算）。

### FR-009：分支命名

名字 = 绝区零角色官方英文名 + `-` + 3 位小写随机字母数字（如 `ellen-k3f`）。角色名取通行
英文简称（单名小写 `anby` / `nicole` / `billy` / `lycaon` / `miyabi`，多字名转连字符
`zhu-yuan` / `qing-yi`），核心代码内置常量表，命名时随机取一个。git 分支名为
`tuxedo/<name>`；同仓库重名换名重试；名字创建时定死，会话改名不跟随。

### FR-010：依赖目录与单文件配置策略

依赖目录（被 `.gitignore` 排除、体积大、路径敏感）不进 worktree。策略抽象成
`DepStrategy` trait（`install` / `uninstall` / `describe`），按平台与能力装配：

| 实现 | 装配条件 | 行为 |
| --- | --- | --- |
| `OverlayDeps` | Linux 且 Core 进程**内**试挂 overlay 成功 | 对主工作区里**已存在**的已知依赖目录（`node_modules` / `target` / `.venv` / `venv` / `vendor` / `.gradle` / `build`）在 worktree 内挂 overlay：lower = 主工作区那份，upper = `<Core 数据目录>/worktrees/<工作区短名>/deps/<branch>/<dir>`（与 worktree 同生命周期，但在 worktree 目录**外**） |
| `SkipDeps` | Windows / macOS / 探测失败 | 不搬，系统提示告知模型「依赖需自行安装」 |

探测**在 Core 进程内**实际试挂一个临时 overlay 再卸载（读 `/proc/filesystems` 只看模块存在；
`unshare` 子进程的挂载对本进程不可见，会「探测通过、真挂失败」）。结果进程内缓存，失败不
重试，**不降级为符号链接**（link 会让分支的安装直写主工作区）。退到 `SkipDeps` 是设计允许
的档位，不是静默降级。upper 放 worktree 外：不污染分支自己的 `git status`、不撞
`git worktree remove`、upper 与 workdir 同一文件系统。卸载顺序：先卸载所有挂载点，再
`git worktree remove`。

**单文件本地配置**（`.env` / `.env.local` / `.npmrc` / `local.properties`）不走挂载：主工作区
存在、名字被 `.gitignore` 忽略（`git check-ignore` 校验）、且 worktree 内不存在时，在 worktree
内建**符号链接**指向主工作区原文件——按路径共享，主工作区一侧的原子替换保存也能实时跟上。
链接失败（Windows 未开开发者模式 / 无权限）退化为创建时复制，一次判定不重试，档位写诊断
日志并进系统提示。系统提示要求按只读语义使用（要改先 `cp` 断链）。

### FR-011：可见性边界与成果出口

worktree 放在 Core 数据目录是可见性设计的**全部机制**，不靠权限、不靠过滤、不靠监视白名单：

| 观察者 | 结果 | 机制 |
| --- | --- | --- |
| 主工作区 `git status` / `git diff` | 无任何分支内容 | worktree 不在仓库目录树内 |
| IDE 资源管理器 / 我们的侧栏文件树 | 无任何分支内容 | 同上（侧栏对分支对话读 `branchTreeRequested`，是另一条通道） |
| 主对话的 `Grep` / `Glob` | 搜不到 | 它们的根是主工作区（`ctx.cwd`） |
| 主对话的 `Bash`（`ls` / `rg` / `find`） | 看不到 | 同上 |
| 宿主的文件监视器 | 不监视分支文件 | 监视器按主工作区路径注册 |
| `git branch` | 见 `tuxedo/<name>` | **有意可见**：成果出口 |
| `git worktree list` | 见 worktree 路径 | **有意可见**：git 自己登记的工作树表，无法隐藏 |

成果出口是唯一一条：用户在主工作区执行 `git merge tuxedo/<name>`（或让模型执行）。合并由
git 完成，冲突由 git 报出，我们的代码不介入。因此没有发布按钮、没有发布事件、没有三方对账、不自动写主工作区。

## 3. 行为规格

**事件流**：分支会话建立 → `branchStateChanged { view: { state: 'ready', … } }`；普通会话在
打开时收到 `{ state: 'plain' }`（明确「不是分支对话」，不是停在等待态）；worktree / 分支
消失 → `{ state: 'unavailable', … }`（每轮开始前核对一次）。三者都是全量快照，消费者不维护
状态表。分支成功创建**不新增**会话创建事件：新条目经既有 `sessionCreated` 与
`conversationListChanged` 到达。

**webview 表现**（[principles.md 第 10 节](../architecture/principles.md#10-webview-不持有事实的默认值)：webview 不持有事实的默认值）：
`branchStateChanged` 未到达时是等待态（不渲染分支名），不猜「就绪」；分支名只从事件来，
不从对话标题猜。会话标题区只有分支名本身——无图标、无「分支对话」字样、无 worktree 状态、
无依赖策略、无并行计数、无发布按钮；唯一的图标出现在**未发送的分支草稿页**标题前
（形态标记，见 FR-006），消息区里也不出现任何常驻的分支横幅。

**系统提示**：分支会话的 system prompt 末尾追加一段（依赖策略只在这里出现，不进事件载荷）：
worktree 位置与分支名、修改只落当前目录、留检查点用 `git commit`、看不到主工作区的未提交
改动、成果由用户 `git merge` 取用、依赖目录档位事实、本地配置的共享方式与只读要求。

**删除清理顺序**：卸载依赖挂载 → `git worktree remove --force` → `git branch -D tuxedo/<name>`
→ 删 upper 目录；提交数与差异文件数写诊断日志。顺序是硬要求：挂载点还在 worktree 里时删
目录会留下悬挂挂载。

**层内实现落点**：`core-rs/src/branch/repo.rs` / `worktree.rs` / `state.rs` / `deps.rs` /
`naming.rs`（Core 内，单向被 `engine.rs` 调用）；工具根改向在 `engine.rs` 的 `tool_root_of`；`meta.json` 的
`branch` 字段由 `history.rs` 的 `touch_metadata_with_branch` 写入，`src/shared/history/`
的 `ConversationMetadata.branch` 读取。

## 4. 边界与错误路径

| 情形 | 预期行为 |
| --- | --- |
| 目录不是 git 仓库 | 入口置灰并说明（`branchPrecheckRequested`）；已存在的分支会话若仓库消失 → `unavailable` |
| 主工作区有未提交改动 | 创建入口与草稿页说明「未提交改动不在本分支」，不阻塞、不 stash |
| 主工作区在分支工作期间切了分支 / 改了文件 | 不影响已建 worktree（两者互不相干） |
| worktree 创建失败 | 首条消息的会话建立失败并说明，草稿页保留输入可重试，回滚已建分支与目录 |
| 用户手动删除 worktree / `git worktree prune` | 下一轮转 `unavailable`，不重建 |
| 用户手动 `git branch -D tuxedo/<name>` | worktree 仍在但分支指针没了 → 下一轮转 `unavailable` 并说明 |
| 分支名撞名 | 换名重试直到不撞 |
| 模型执行 `git worktree remove` / `git branch -D` 自身分支 | 拒绝并说明（防自毁） |
| 分支对话有未提交改动时删除会话 | 清理 worktree、分支与 upper；计数写诊断日志 |
| 后台任务（`run_in_background`）的 `cwd` | 指向 worktree，产物留在 worktree |
| `Bash` 的 `cwd` 在 worktree 外 | 原样交子进程执行（现状语义），后果不进分支视图 |
| 依赖目录挂载失败（权限 / 空间） | 该目录退化为不挂，系统提示说明需自行安装，其余能力不受影响 |
| 用户在挂载点内删依赖 | 只删 upper 中的条目（whiteout），主工作区依赖不变 |
| 分支就地改写链接的配置文件 | 经符号链接直写主工作区——系统提示要求「要改先 `cp` 断链」 |
| 主工作区删除了被链接的配置文件 | 链接悬空，分支读取报文件不存在（与主工作区同症状，不静默重建） |
| 名单内文件未被 `.gitignore` 忽略 / 已被跟踪 | 跳过不链接 |
| 旧会话的 `meta.json` 没有 `branch` 键 | 按普通会话处理（兼容） |
| 普通对话 | 行为逐项不变，不涉 worktree |

## 5. 非目标

- **发布 / 自动落地 / 三方对账**：不做。成果出口是原生 git 命令。
- **overlayfs 做整个工作区**、**自建 CoW 存储**：不引入。因此分支看不到主工作区的**未提交**
  改动——只看到已提交内容（git worktree 的固有语义）。overlay 只用于依赖目录叠加。
- **主工作区未提交改动的自动带入**：不 stash、不临时快照。
- **自建 Commit / 检查点 / 逐调用快照**：提交交给 git 与模型。
- **分支历史面板（整块）**：不做。既有的顶栏时钟图标是「对话历史」，本能力不改动它。
  去向：[TODO.md](../../TODO.md)。
- **合并 UI**：不提供「合并到主工作区」按钮。
- **侧栏文件树的差异标记**：不做。预留设计见 FR-007，去向
  [open-questions.md](../architecture/open-questions.md)。
- **Windows / macOS 的依赖目录复用**、**依赖策略的用户配置**：不提供。
- **非 git 目录的分支对话**：不支持（入口置灰）。
- **bare 仓库 / 嵌套子模块作为工作区**：不特殊处理，按 git 自身行为。
- **worktree 内的独立 IDE 打开入口**：不提供（worktree 路径是实现细节）。
- **跨机器共享分支**：分支只在本地仓库。
- **写用户仓库的 `.gitignore` 或任何非 git 文件**：不做。

## 6. 对需求基线的影响

三条需求基线（[docs/features/user-stories/dialog-core.md](user-stories/dialog-core.md)、
[tools.md](user-stories/tools.md)、[desktop.md](user-stories/desktop.md)）：

- **US-76 新对话选创建方式**：新对话按钮（webview 顶栏 / Electron 原生侧栏）为 split 下拉，
  选「普通对话（默认）/ 分支对话」，点击以该形态打开草稿页、会话随第一条消息建立；
  分支草稿页标题前有一个分支图标作形态标记；非 git 仓库时分支对话项置灰并给原因。
- **US-74 分支对话的独立工作区**：分支对话在独立 worktree 里工作，主工作区不受影响；
  标题前的分支名表明分支，提交历史用 git 命令看；成果经 `git merge tuxedo/<name>` 取用。
- **US-75 多个 agent 并行工作**：同时开多个分支对话各自独立工作，对话列表的分支标记
  展示全部并行 agent。

三条的 e2e 覆盖按分层口径登记（映射见
[docs/features/user-stories.md 附录](user-stories.md#附录us-与-e2e-场景用例映射)）：核心行为由
`core-rs` 单测用真实 git 夹具锁定，契约往返由 `standaloneBranch` 驱动真实 Core 二进制锁定，
webview 车道只覆盖不依赖 Core 的纯 UI 用例（下拉两项 / 置灰文案 / 标题前分支名 / 草稿页提示）——
e2e 车道没有 git 仓库夹具（也不为此引入，会拖慢整车道）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `history.rs` 的 `touch_metadata_with_branch` + `branch/state.rs` 的 `BranchFacts`；TS 侧 `ConversationMetadata.branch` | `branch/state_tests.rs`（字段往返 / 旧会话归一 `null`）、`branchContract.test.ts`（两侧同名同形） | 自动 |
| FR-002 | `engine.rs` 的 `tool_root_of`（唯一派生点）+ `branch/worktree.rs` 的创建 / 复用 | `worktree_tests.rs`（全部工具跟随 / worktree 在仓库外 / 复用不丢改动） | 自动 |
| FR-003 | `branch/repo.rs` 的 `detect_repo` / `is_dirty` / `precheck` + `on_branch_mode_changed` 的失败路径 | `repo_tests.rs`（仓库探测 / 脏工作区三态 / precheck 两态）、`worktree_tests.rs`（创建失败不留半成品） | 自动 |
| FR-004 | `branch/worktree.rs` 的 `is_self_destructive` + `SessionState.branch_prompt` + `engine.rs` 的防自毁闸门 | `worktree_tests.rs`（提交推进分支指针 / 拦截自毁命令） | 自动 |
| FR-005 | `branch/worktree.rs` 的 `remove` / `reconcile_on_start` / `work_summary` | `worktree_tests.rs`（清理顺序 / 孤儿只记日志 / 手删 worktree 转 unavailable） | 自动 |
| FR-006 | `src/webview/App.tsx`（split button / 草稿页图标与提示 / 标题前分支名）+ `ConversationTreeItem.tsx`（列表分支名）+ `electron/sidebar/main.ts` 与 `index.html`（侧栏 split 菜单 / 列表分支名）+ `electron/ChatViewManager.ts`（草稿形态随视图注入与复用）+ i18n | `e2e/webview/branchConversation.spec.ts`（下拉两项 / 主题配色 / 置灰原因 / 草稿页图标与提示 / 标题前分支名 / 列表分支名）、`e2e/electron/branchSidebar.spec.ts`（侧栏 split 项 / 置灰 / 分支草稿图标与落盘分支名）、`branchModeEntry.test.ts` | 自动 |
| FR-007 | `UiRequest.branchTreeRequested` + `electron/main.ts` 的 `readBranchTreeDir` + `ElectronUIHost.onBranchStateChanged` | `branchTreeRequested.test.ts`（应答形态 / `not-branch` 回落） | 自动 |
| FR-008 | `src/shared/AssistantEventBus.ts` 的四组联合 + `meta.json` 持久化 | `standaloneBranch.test.ts`（帧往返）、docsLint（事件表与载荷列） | 自动 |
| FR-009 | `branch/naming.rs` 的角色名常量表 + 随机后缀 | `naming_tests.rs`（格式正则 / 撞名重试） | 自动 |
| FR-010 | `branch/deps.rs` 的 `DepStrategy` / `OverlayDeps` / `SkipDeps` + `link_local_configs` | `deps_tests.rs`（两档装配 / 只叠加已存在目录 / 单文件链接四种情形 / overlay 真挂载） | 自动 |
| FR-011 | worktree 位置（Core 数据目录）与 `tool_root_of` 的隔离语义 | `worktree_tests.rs`（`git status` 干净 / 并行隔离 / 分支可见） | 自动 |

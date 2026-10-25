---
status: 已收敛
---

# 改动规格：侧栏文件浏览器增强（新建自动刷新 / 悬停修改时间 / 文档视图）

给 Electron 侧栏文件浏览器补三项能力：Write 工具新建文件后文件树自动刷新；文件与目录行悬停显示
修改时间（Host 系统时区）；刷新按钮旁新增文档视图开关，开启后只列出工作区内有变更的
Markdown 文档——git 工作区按与 HEAD 的比较口径显示新增 / 删减行数，非 git 工作区按
`workspace.meta.json` 里由工具调用记录的修改文档集合口径列出（不显示行数）。

范围全部落在侧栏既有车道：交互与数据走 Electron 私有 IPC（与既有 `sidebar:files-*` 同
车道），**不新增 AssistantEventBus 事件**；非 git 记录由 Core 在工具执行成功后写入该工作区
对话空间目录的 `workspace.meta.json`（该文件归属 Core 不变），宿主侧只读。本地与远程
（SSH）工作区同一支持范围：远端 git 判定 / 行数统计与记录读取复用既有 SSH 通道。
VS Code 宿主无侧栏文件浏览器，本次不涉及。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 文档视图开关与展示（含远程：远端 git 判定 / 行数统计与记录读取走共享 SSH 连接池）、Write 新建后的自动刷新推送、git 哨兵监听（commit / stage / checkout 自动刷新，会话内外一致，远程复用文件监听通道）、条目携带修改时间；新增 / 变更的 IPC 频道清单 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | workspace.meta.json 归属段 | 修改 | `workspace.meta.json` 增加 md 修改记录字段；声明宿主侧只读入口（写仍归 Core）；`UIHost` 新增 `onToolResult` 成员（宿主转发，不投递 webview） |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 4.1 节 归属](../../docs/architecture/core-ui-separation.md#41-归属) | 修改 | 清单写入时机从「目录首次创建写一次」扩到「工具修改 md 后更新记录」，仍由 Core 独占写 |
| [docs/architecture/repo-map.md](../../docs/architecture/repo-map.md) | 目录布局 | 修改 | 新增文件条目：侧栏文档视图逻辑、宿主侧记录读库、相关测试 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [EP-12 侧栏文件浏览器（桌面端）](../../docs/features/user-stories/desktop.md#ep-12-侧栏文件浏览器桌面端) | 修改 | 新增 US-61 / US-62 / US-63 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 附录 US ↔ e2e 映射 | 修改 | 三条新 US 的映射与豁免登记 |

总线事件与 wire 消息无新增；宿主契约 `UIHost` 新增一个成员（`toolResult` 的宿主
转发，照 `workspaceFileChanged` 先例，见 plan.md），`docs/architecture/events.md`
仅同步 §2.1 `toolResult` 行的宿主转发说明与 `workspaceFileChanged` 行的消费方说明
（哨兵监听复用该事件，查看器之外新增宿主消费方）。

## 用户场景与验收标准

- 场景 1：Write 新建的文件自动进树（不限文件类型）
  - **AC-1**（FR-001）：GIVEN 本地活动工作区已展开文件浏览器 WHEN 对话中 Write 工具在该工作区根内新建 `a.ts` 成功 THEN 不点击刷新按钮，树中出现 `a.ts`，滚动位置与目录展开状态保持（与手动刷新同口径）。
  - **AC-2**（FR-001）：GIVEN 打开集合含非活动工作区 W（本地或远程）WHEN Write 在 W 根内新建文件成功 THEN 切换到 W 时其树已含该文件，无需手动刷新，分区不因此自动展开。
  - **AC-3**（FR-001）：GIVEN Write 的新建路径在所有已打开工作区根之外 WHEN 工具成功 THEN 各工作区文件树内容不变。
- 场景 2：悬停显示修改时间（文件与目录）
  - **AC-4**（FR-002）：GIVEN 本地工作区树中文件 f WHEN 悬停 f 行 THEN 提示在相对路径之后显示修改时间，格式 `YYYY/MM/DD HH:mm`（24 小时制，如 `2026/10/25 12:15`），等于 f 的 mtime 按 Host 系统时区格式化。
  - **AC-5**（FR-002）：GIVEN 远程（SFTP）工作区树中文件 f WHEN 悬停 f 行 THEN 显示同格式修改时间（同一绝对时刻的 Host 系统时区呈现）。
  - **AC-6**（FR-002）：GIVEN 本地工作区树中目录 d WHEN 悬停 d 行 THEN 提示同样在相对路径之后显示 d 的修改时间（同格式）。
- 场景 3：文档视图（git 工作区）
  - **AC-7**（FR-003）：GIVEN 本地 git 工作区内 `a.md` 相对 HEAD 有 +3/-1 改动、`b.md` 无改动 WHEN 点击刷新按钮旁的文档视图按钮 THEN 视图仅列 `a.md`（保持目录层级，仅保留命中文档的路径分支），命中文档路径上的目录全部层级默认展开，行尾显示 +3 与 -1（配色区分）；再点一次按钮回到普通文件树，目录展开状态恢复为开启文档视图前的状态。
  - **AC-8**（FR-003）：GIVEN 未跟踪的新文件 `c.md`（10 行，未被 .gitignore 忽略）WHEN 开启文档视图 THEN 列出 `c.md`，显示 +10 与 -0。
  - **AC-9**（FR-003）：GIVEN `d.md` 仅被重命名 / 移动且内容不变 WHEN 开启文档视图 THEN `d.md` 不出现。
  - **AC-10**（FR-003）：GIVEN 工作区内 `e.md` 已被删除（HEAD 中存在）WHEN 开启文档视图 THEN `e.md` 不出现。
  - **AC-11**（FR-003）：GIVEN 工作区 W1 开启、W2 未开启文档视图 WHEN 重载应用并切到 W1 THEN W1 仍处于文档视图、W2 仍为普通文件树（开关状态按工作区记忆）。
  - **AC-12**（FR-003）：GIVEN 文档视图开启且列表含 `a.md` WHEN 会话内工具执行 `git commit` 成功（HEAD 前进、`a.md` 的变更已全部提交）THEN 视图自动刷新，`a.md` 从列表消失，无需手动刷新（哨兵监听捕获，与触发来源无关）。
  - **AC-13**（FR-003）：GIVEN 远程（SSH）git 工作区内 `a.md` 相对 HEAD 有 +3/-1 改动 WHEN 开启文档视图 THEN 同样仅列 `a.md` 并显示 +3 与 -1（git 判定与行数统计经 SSH 在远端执行），展示与自动刷新行为与本地一致。
  - **AC-14**（FR-003）：GIVEN 本地 git 工作区文档视图开启且列表含 `a.md` WHEN 用户在产品外的终端对该仓执行 `git commit`（`a.md` 变更已全部提交）THEN 视图自动刷新，`a.md` 从列表消失，无需手动刷新。
- 场景 4：非 git 工作区的记录与展示
  - **AC-15**（FR-004）：GIVEN 非 git 工作区 W WHEN Edit 工具修改 W 内 `x.md` 成功 THEN W 的对话空间目录 `workspace.meta.json` 的修改记录新增 `x.md`（修改过的文档集合），条目不含行数。
  - **AC-16**（FR-004）：GIVEN 非 git 工作区 WHEN Write 新建 `y.md` 或覆盖既有 `z.md` 成功 THEN 记录对应文档条目（新建与覆盖同记）。
  - **AC-17**（FR-004）：GIVEN Edit / Write 的目标 md 路径解析后在会话工作区根之外 WHEN 工具成功 THEN 记录不新增该条目。
  - **AC-18**（FR-004）：GIVEN git 工作区 WHEN Edit / Write 修改其中 md 成功 THEN `workspace.meta.json` 不记录（该工作区展示走 FR-003 口径）。
  - **AC-19**（FR-004）：GIVEN 记录中的 `x.md` 已被从磁盘删除 WHEN 在该非 git 工作区开启文档视图 THEN 列表不含 `x.md`；其余现存条目照常列出（不显示行数）。
  - **AC-20**（FR-004）：GIVEN 远程（SSH）非 git 工作区 WHEN 远端 Core 执行的 Edit 修改其中 `x.md` 成功 THEN 记录写入远端 Core 数据目录该工作区的 `workspace.meta.json`；开启文档视图时宿主经 SFTP 读出并列出 `x.md`（不显示行数）。

## 功能需求

### FR-001：Write 新建文件后自动刷新文件树

Write 工具在某个已打开工作区根内成功新建文件（不限类型）后，该工作区的文件树自动反映
新文件，无需点击刷新按钮；本地与远程（SFTP）工作区同一口径：活动且展开的文件浏览器立即重读（滚动位置与目录展开状态沿用既有手动刷新的
保留口径）；非活动或未展开的工作区使其树缓存失效，在切换 / 展开后呈现新文件，不自动展开
分区。新建路径在所有已打开工作区根之外时不触发任何刷新。触发仅限 Write 新建（Write 覆盖
既有文件与 Edit 修改不改变树结构，不触发）；文档视图开启期间的自动刷新见 FR-003。

### FR-002：条目悬停显示修改时间

文件与目录条目的悬停提示在相对路径之后追加该项的修改时间，格式 `YYYY/MM/DD HH:mm`
（24 小时制，如 `2026/10/25 12:15`），按宿主（Host）系统时区呈现；本地与远程（SFTP）
工作区同一口径（远程条目为同一绝对时刻的 Host 系统时区格式化）。目录列表的文件与目录
条目数据均携带修改时间（毫秒时间戳），本地与远程取值同形（同一份条目契约）。

### FR-003：文档视图开关与 git 口径展示

文件资源管理器分区条上、刷新按钮旁新增文档视图切换按钮，开关态可视。开启后文件树切换为
文档视图，仅展示该工作区内有工作区变更的 Markdown 文档（`.md` / `.markdown`，与双击打开
的 Markdown 判定同口径）：保持目录层级、只保留包含命中文档的路径分支，排序与既有树一致，
行尾显示新增 / 删减行数（+N / -M，配色区分；仅 git 口径显示行数，非 git 口径不显示）；
条目继承文件树的选中、右键菜单与双击打开行为。再点一次按钮回到普通文件树。

git 口径：工作区根位于 git 仓库内（含祖先目录）即按本口径，变更 = 与 HEAD 比较（含已暂存
与未暂存）；未跟踪的新文档计入，全文行数计为新增（.gitignore 忽略的不计入）；仅重命名 /
移动而无内容变化的文档不显示；工作区内已删除的文档不显示。开关状态按工作区独立记忆（与
展开 / 折叠状态同口径落盘，重载后恢复）。文档视图下命中文档路径上的目录全部层级默认
展开，该展开态不写回普通文件树的展开记忆，切回普通树时恢复原展开状态。

文档视图的自动刷新统一由 git 哨兵监听承担：文档视图开启期间对工作区的 `.git` 与
`.git/refs/heads` 目录挂文件监听——commit / stage / checkout（无论来自会话内工具还是
用户在产品外的终端）必然原子替换其中文件——变更去抖合并后重取文档视图数据；远程
工作区复用远端 Core 的文件监听通道（specs/018 的 `watchWorkspaceFile` /
`workspaceFileChanged`）监听同样两组路径。监听随开关挂 / 摘、工作区关闭即摘除。工具
对文档的未提交修改（Edit / Write 只改工作区文件，不触 `.git`）不触发自动刷新，经手动
刷新或下一次 git 事件（stage / commit）后可见。手动刷新按钮语义不变。

远程（SSH）工作区同一口径：git 判定与行数统计经 SSH 在远端执行（复用侧栏文件浏览与
远程终端的共享 SSH 连接池），开关、展示与自动刷新行为与本地一致。

### FR-004：非 git 工作区的 md 修改记录与展示

工作区根不在任何 git 仓库内时，Edit / Write 工具成功修改该工作区内的 Markdown 文档
（`.md` / `.markdown`，新建与覆盖同记）后，Core 在该工作区对话空间目录的
`workspace.meta.json` 中更新修改记录：记录是「被工具修改过的 md 文档集合」，条目为
工作区根相对路径（路径分隔符统一），不记行数。

目标路径按会话工作区根解析，在工作区根之外的不记录；工作区为 git 仓时不记录（展示走
FR-003 口径）。非 git 工作区开启文档视图时，展示记录中仍存在于磁盘上的文档（不显示
行数），已不存在的条目过滤不显示；数据来源为读取 `workspace.meta.json`（宿主侧只读，
Core 独占写）。远程（SSH）工作区：记录由远端 Core 写入其数据目录中该工作区的
`workspace.meta.json`，宿主经 SFTP 只读；git 与否的判定同样在远端进行。

## 边界与错误路径

- git 判定与执行：`git rev-parse` 判定工作区是否在仓内；判定为非 git 走 FR-004 记录口径
  （这是分流不是降级）。git 可执行缺失、判定或行数统计命令执行失败（非「不在仓内」的
  正常退出）时，文档视图显示错误提示，不静默显示空列表、不回退到记录口径（不过度
  fallback）。
- SSH 连接不可用或远端命令执行失败：远程工作区的文档视图显示错误态，不静默显示空列表
  （与远程文件树列表错误的既有口径一致）。
- git 哨兵监听建立失败（权限 / 文件系统不支持 / 远端 watch 请求失败）：不影响取数
  正确性（数据始终按需现场执行），记日志并保持手动刷新兜底——监听只优化刷新时机，
  不是事实来源。
- 尚无提交的 git 仓（无 HEAD）：已暂存与未跟踪的 md 计入，行数相对空树按全文计。
- `workspace.meta.json` 损坏 / 读不出：宿主读侧显示错误态；Core 写侧拒绝本次记录写入并
  报错，不覆盖原文件。记录写入为原子替换、内容未变不落盘；多会话并发修改同一工作区的
  md 时按集合并集合并，不丢条目、不产生损坏 JSON。
- 工具执行失败（Edit / Write 报错）：不触发自动刷新，不写记录。
- 悬停时取不到修改时间：提示仅显示相对路径，不显示猜值。
- 记录累计无上限、无已读 / 清空语义（见非目标）；展示时过滤磁盘上已不存在的条目。
- 自动刷新与用户手动刷新并发：沿用既有 generation 作废口径，以最后一次触发为准。

## 非目标

- 非 git 记录不感知本产品工具之外的文件修改；文件监听仅限 git 哨兵路径（`.git` 与
  `.git/refs/heads`），不引入工作区级 watcher，非 git 工作区无任何监听。
- 不做记录的已读 / 清空 / 基线重置语义。
- 不展示已删除的文档（git 与记录口径一致）。
- 不做目录级增删行数汇总与额外排序选项。
- VS Code 宿主不提供侧栏文件浏览器，本次不涉及（既有边界）。

## 对需求基线的影响

新增三条 US，登记进
[EP-12 侧栏文件浏览器（桌面端）](../../docs/features/user-stories/desktop.md#ep-12-侧栏文件浏览器桌面端)：

- US-61 Write 新建文件自动刷新文件树（FR-001）
- US-62 条目悬停显示修改时间——文件与目录（FR-002）
- US-63 文档视图：git 行数口径与非 git 记录口径（FR-003 / FR-004）

e2e 登记：三条 US 均在 `e2e/electron/fileExplorer.spec.ts` 扩展用例（US-63 的 git 口径用
临时 git 仓；会话外 commit 的哨兵用例由测试进程直接执行 git 命令模拟），用例驱动本地
工作区。豁免登记：远程工作区（文档视图与自动刷新的远程路径）
沿用 US-42 既有远程豁免口径；FR-004 的 Core 落盘细节（格式、幂等合并、写安全）由 core-rs
测试与宿主读库单测车道覆盖，不重复登记 e2e。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/sidebar/main.ts`（树状态）、`electron/main.ts`（新建事实 → 刷新推送） | `e2e/electron/fileExplorer.spec.ts` 新增用例；`src/test/ipcChannels.test.ts` 频道配对 | 自动 |
| FR-002 | `electron/sidebarFiles.ts` 与 `src/host/standalone/sshClient.ts`（条目契约加修改时间）、`electron/sidebar/main.ts`（提示渲染） | `src/test/sidebarFiles.test.ts`；`e2e/electron/fileExplorer.spec.ts` 新增用例 | 自动 |
| FR-003 | `electron/main.ts`（git 判定与行数统计通道；远程经 `src/host/standalone/sshClient.ts` SSH exec）、`electron/sidebar/main.ts`（开关与视图） | `src/test/`（git 通道单测，临时 git 仓）；`e2e/electron/fileExplorer.spec.ts` 新增用例 | 自动 |
| FR-004 | `core-rs/src/tools.rs` + `core-rs/src/config.rs`（成功后写记录）、宿主侧只读库（新增；远程经 SFTP 读取）、`electron/sidebar/main.ts`（展示） | core-rs 测试（记录写入 / 集合并集幂等 / 写安全）；Rust 对照表锁定格式；宿主读库单测 | 自动 |

## 待澄清

（无）

## 收敛记录

- 已满足：
  - **FR-001（AC-1 / AC-2 / AC-3）**：`UIHost.onToolResult` 宿主旁路 + `electron/toolResultSideEffects.ts` 解析定位 + 渲染层 `refreshWorkspaceFiles(id)`。证据：e2e `fileExplorer.spec.ts` US-61（活动工作区新建自动进树）；`src/test/toolResultSideEffects.test.ts`（前缀 / 相对路径 / 集合外 no-op）；AC-2 的后台工作区与 AC-1 共用同一按 id 刷新路径（`loadDir` 回包写回各自状态的既有语义，`electron/sidebar/main.ts`）。
  - **FR-002（AC-4 / AC-5 / AC-6）**：`DirectoryEntry.mtimeMs`（本地 stat / 远程 SFTP attrs 透传）+ 悬停 title 拼接。证据：e2e US-62（本地文件与目录的 `YYYY/MM/DD HH:mm` 断言）；`sidebarFiles.test.ts`（条目携带毫秒时间戳）；AC-5 远程沿用 US-42 远程豁免口径（attrs 透传实现于 `sshClient.listDirectory`）。
  - **FR-003（AC-7–AC-14）**：`electron/sidebarDocView.ts`（探测分流 / numstat -M / 未跟踪计行 / 存在性过滤 / 行铺平）+ `electron/sidebarDocWatch.ts`（git 哨兵）+ 渲染层文档视图。证据：e2e US-63（AC-7/8 git 口径与未跟踪计全文、AC-11 开关按工作区记忆、AC-14 外部 commit 哨兵自动刷新）；`sidebarDocViewGit.test.ts` 临时真实 git 仓锁定 AC-9 纯重命名跳过与 AC-10 已删除过滤；AC-12 会话内 commit 与 AC-14 同一哨兵触发源（`sidebarDocWatch.test.ts` 真实仓 commit / stage 触发断言）；AC-13 远程同远程豁免口径（解析与分流单测覆盖，SSH 执行器组装于 `electron/main.ts` `remoteGitRunner`）。
  - **FR-004（AC-15–AC-20）**：core `record_md_modification`（锁文件 + 持锁合并 + 原子替换 + git 探测缓存）+ 宿主只读库 `src/shared/workspaceMeta.ts`。证据：`core-rs/src/config_tests.rs`（记录 / 集合并集幂等 / git 仓跳过 / 根外跳过 / 非 md 跳过 / 损坏拒绝写）；`core-rs/src/tools_tests.rs`（Write 新建与覆盖、Edit 登记）；e2e US-63 记录口径（工具写入的 md 自动列出、无行数徽标）；`workspaceMeta.test.ts`（AC-20 远端读取经注入访问口端到端 + 与 Rust 同组路径样例对照）。
  - **影响基线七行 delta 全部并入**：contracts.md（UIHost 23 成员 + `modifiedDocs` 归属与只读库）、events.md §2.1（`toolResult` 宿主转发 / `workspaceFileChanged` 消费方）、core-ui-separation.md §4.1、repo-map.md、electron-multi-workspace.md §9 / §14.5、desktop.md EP-12 新增 US-61/62/63、user-stories.md 附录映射与豁免登记。
- 偏差：
  - spec 原注「不修改任何契约成员」在 plan 阶段修订为 `UIHost` +1 成员（宿主旁路转发，照 `onWorkspaceFileChanged` 先例）——已回写 spec 影响基线并留痕，无行为分歧。
  - 实施中发现远端 POSIX 路径不能按宿主平台归一：`projectDirCandidates` 增加 `posix` 选项（与 `resolveWithinRoot` 同一约定），远端读取按远端语义编码——与 spec 远程口径一致，属实现修正。
- 未做：无。

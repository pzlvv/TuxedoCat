---
status: 已收敛
---

# 改动规格：Overlay 对话的变更视图

文件资源管理器的「文档视图」与「全部变更」取的是工作区磁盘的 git 事实。Overlay 对话的改动只
落对话私有的上层目录，磁盘上看不到，于是同一个对话里目录树显示「改过 / 新建了文件」、变更视图
却一直显示「没有变更」。本规格让两个变更视图在活动对话是 Overlay 对话时改取**该对话叠加视图
里**的 git 事实，并让变更视图双击打开的文件的「变更」档能取到「视图内容相对 HEAD」的两侧原文。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容) | 修改 | 补 Overlay 对话的变更清单与文件 diff 两个只读请求及其应答形态 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 4 节](../../docs/core/standalone-core.md#4-契约) | 修改 | `UiRequest` 名单新增两个成员 |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | 宿主侧 core 事实读取表补两行 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节](../../docs/architecture/events.md#2-事件词汇表) | 修改 | `UiRequest` 汇总数量随新增成员更新 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 侧栏补变更视图的取数分流与 Overlay 下的打开来源口径 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-63 变更视图（文档 / 全部变更）](../../docs/features/user-stories/desktop.md#us-63-变更视图文档--全部变更) | 修改 | 新增 Overlay 对话的验收条目 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-38 文件与虚拟文档预览](../../docs/features/user-stories/desktop.md#us-38-文件与虚拟文档预览) | 修改 | 变更视图的渲染方说明覆盖 Overlay 答案的两侧原文来自 Core |

## 用户场景与验收标准

- 场景 1：Overlay 对话里的变更清单
  - **AC-1**（FR-001）：GIVEN 活动对话是 Overlay 对话且在对话内修改了磁盘上已有的 `f.txt` WHEN 展开「全部变更」 THEN 列表出现 `f.txt` 并带 +N / -M 徽标，同时磁盘上的 `f.txt` 内容未变
  - **AC-2**（FR-001）：GIVEN 活动对话是 Overlay 对话且在对话内新建了 `a.txt` WHEN 展开「全部变更」 THEN `a.txt` 出现且按未跟踪计为全文新增，磁盘上没有该文件
  - **AC-3**（FR-001）：GIVEN 活动对话是 Overlay 对话且在对话内只用 Bash 改动了文件 WHEN 展开「全部变更」 THEN 该文件出现在列表里（不依赖工具旁路记录）
  - **AC-14**（FR-001）：GIVEN 对话内用 Bash 执行了 `git commit` WHEN 展开「全部变更」 THEN 已提交的文件不出现、磁盘 HEAD 不变
  - **AC-4**（FR-001）：GIVEN 活动对话是 Overlay 对话 WHEN 切到「文档视图」 THEN 只列出视图内相对 HEAD 有改动的 Markdown，行数徽标与非 Overlay 对话同一口径
  - **AC-5**（FR-001）：GIVEN 活动对话是普通对话 WHEN 展开任一变更视图 THEN 列表与改动前逐条一致（取数仍走磁盘 git）
  - **AC-6**（FR-002）：GIVEN Overlay 对话的视图尚未建立 WHEN 展开变更视图 THEN 显示错误行与重试入口，不显示「没有变更」空态
  - **AC-7**（FR-002）：GIVEN 工作区不在 git 仓库内且活动对话是 Overlay 对话 WHEN 展开任一变更视图 THEN 显示「不在 git 仓库内，无法列出变更」提示
  - **AC-8**（FR-002）：GIVEN Overlay 对话的变更清单已显示 WHEN 在一次 Edit 成功后 THEN 列表按该次改动重取，不需要手动刷新
  - **AC-9**（FR-003）：GIVEN 活动对话从普通对话切到 Overlay 对话（或反向） WHEN 切换完成 THEN 变更清单按新来源重取，不再显示上一来源的结果
  - **AC-15**（FR-003）：GIVEN 活动对话是 Overlay 对话 WHEN 在变更视图里 THEN 不挂磁盘 `.git` 的哨兵；反向切回普通对话时按需挂上
- 场景 2：从变更视图打开文件
  - **AC-10**（FR-004）：GIVEN Overlay 对话在对话内修改了 `f.txt` WHEN 在「全部变更」里双击 `f.txt` THEN 查看器落在「变更」档并显示「HEAD 版本 → 视图内容」的左右对比
  - **AC-11**（FR-004）：GIVEN Overlay 对话在对话内新建了 `a.txt` WHEN 在「全部变更」里双击 `a.txt` THEN 查看器落在全文档并显示视图内容
  - **AC-12**（FR-004）：GIVEN Overlay 对话的某文件相对 HEAD 没有改动 WHEN 在查看器里点「变更」 THEN 显示「没有改动」空态而不是空白编辑器
  - **AC-13**（FR-005）：GIVEN 任一变更清单请求 WHEN 取数完成 THEN 该对话的视图上层目录没有新增条目（取数本身不写入视图）

## 功能需求

### FR-001：变更清单取活动对话的视图事实

活动对话是 Overlay 对话时，文件资源管理器的「文档视图」与「全部变更」列出该对话视图里
（磁盘基线 + 本对话改动）相对 HEAD 的改动，条目形态、行数统计、排序与目录层级组装与非
Overlay 对话完全一致：同样的 `+N` / `-M` 徽标、同样的「目录在前、全部层级默认展开」、
同样的纯重命名与已删除条目不显示。两个视图的差别仍然只有 pathspec（`doc` 只看 Markdown）。

改动来源不限工具：经 Bash 写出的文件同样进列表，因为判据是视图内容与 HEAD 的差异，不是
工具旁路记录。

活动对话是普通对话时取数完全不变（磁盘 git 口径）。

### FR-002：归属决定来源，失败不回退

取数来源由活动对话的归属派生，随活动对话切换；来源变化即重取，不复用另一来源的结果。

视图未建立（会话还没调用过工具）、Core 不可用、git 不可执行或 git 命令失败时显示错误行，
不回退成磁盘的变更清单——两个来源的行集不同，混在一起会让用户以为看到的改动属于当前对话。

非 git 工作区在 Overlay 对话里一律回「不在 git 仓库内」提示：项目级 `modifiedDocs` 记录
跨对话共享，拿它冒充某对话的改动是错误事实。非 Overlay 对话的记录口径保持不变。

### FR-003：失效信号按同一来源重取

Overlay 对话里的 Edit / Write 成功与非 Overlay 对话走同一条失效推送，变更视图按当前来源
重取。磁盘侧的外部改动不需要额外信号：视图的基线就是活磁盘，下一次取数天然包含它。

磁盘 `.git` 的哨兵只对磁盘来源有意义：Overlay 对话的 HEAD 与改动都在 Core 的视图里，
宿主侧的 `fs.watch` 既看不到视图里的 `.git`，也不该在别处 commit 时替它重取。两种变更
视图在 Overlay 来源下一律不挂该哨兵。

### FR-004：变更视图的两侧原文取视图事实

Overlay 对话里双击「全部变更」的非新增文件时，查看器按既有规则落在「变更」档，两侧原文是
「HEAD 版本」与「视图内容」；新增文件落全文档。「没有改动」沿用既有的空态判定。

变更视图的渲染方仍是查看器窗口内的 Monaco `DiffEditor`，不因来源不同新增渲染实现，也不
把工具卡片的 diff 下沉。

### FR-005：取数不写入视图

变更清单与两侧原文的取数都是只读查询：不修改 HEAD、不刷新索引，视图上层目录不因取数多出
条目。视图的内容只由对话里的工具与 Bash 改变。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 非 Overlay 对话 | 完全走既有磁盘通道，行为与行集不变 |
| Overlay 对话 + 视图未建立 | 错误行 + 重试，不显示空列表（Core 不替宿主建视图） |
| Overlay 对话 + 非 git 工作区 | 「不在 git 仓库内，无法列出变更」提示，两个视图同一口径 |
| git 可执行缺失 / git 子命令非零退出 | 错误行带上失败原因，不回退磁盘 |
| Core 断开 | 错误行，不回退磁盘 |
| 会话在取数过程中被关闭 | 该次请求报错；下一次取数按新的活动对话来源进行 |
| 取数期间活动对话已切走 | 该次回包作废（与目录读取同一套代次作废），不覆盖新来源的结果 |
| 视图内容与 HEAD 相同 | 变更清单不出现该文件；查看器「变更」档显示「没有改动」 |
| 对话内改动了 `.git`（如 Bash 里 commit） | 以视图里的 HEAD 为准：索引按视图 HEAD 重建，提交掉的文件不进清单、磁盘 HEAD 不变 |
| Overlay 对话里切到变更视图 | 不挂磁盘 `.git` 的哨兵（HEAD 在视图里，宿主看不到） |

## 非目标

- 不把视图改动写回磁盘、不做「应用到磁盘」。
- 不做「overlay 与磁盘」并排对比，也不给变更行标注来源。
- 不改目录树的取数（specs/046 已定）与视图的生命周期。
- 不改工具卡片的 diff 渲染，也不让 `ElectronUIHost.showDiff` 从空实现变成实现。
- 不给非 Overlay 对话换 git 口径（记录口径的既有回落保持不变）。
- 不做工作树级文件监听：磁盘外部改动靠下一次取数，与现状同口径。

## 对需求基线的影响

不新增 US：这是既有变更视图（US-63）与文件预览（US-38）在 Overlay 对话下的口径补齐。
US-63 新增一条 Overlay 验收条目，US-38 的变更视图说明补一句两侧原文的来源。

US-63 新条目的 e2e 按既有口径登记豁免：整链路要真实的 overlay 挂载（用户命名空间 +
`overlayfs` + `userxattr`），CI 容器不提供；由 Core 侧命名空间内用例与宿主侧纯函数 / 桩用例
覆盖，e2e 车道走手工核对。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `UiRequest.workViewChangesRequested`；`core-rs/src/work_view_changes.rs` 的取数；`electron/sidebar/main.ts` 的 `loadDocList` 分流 | `core-rs/src/work_view_tests.rs` 的 `work_view_changes_lists_view_only_edits` / `work_view_changes_scopes_to_markdown` / `work_view_changes_use_workspace_relative_paths_in_a_subdirectory` / `work_view_changes_follow_the_view_head_after_an_in_view_commit`；`core-rs/src/work_view_changes_tests.rs` 的解析用例 | 自动 |
| FR-002 | Core 的 `ChangesOutcome::NotAGitWorkspace` / 失败侧；`electron/main.ts` 的 `sidebar:files-doc-list-overlay`；`electron/sidebar/main.ts` 的错误态与重试 | `core-rs/src/work_view_tests.rs` 的 `work_view_changes_reports_non_git_workspace` / `work_view_changes_require_a_mounted_view`；`core-rs/src/main_tests.rs` 的 `work_view_changes_request_reports_missing_arguments_and_unmounted_view` | 自动 |
| FR-003 | `electron/sidebar/main.ts` 的 `syncOverlaySession` 作废与 `loadDocList` 重取；`electron/sidebarFilesMode.ts` 的 `shouldWatchGitSentinel` + `electron/main.ts` 的 `sidebar:files-mode-watch` 分支 | `src/test/sidebarFilesMode.test.ts` 的 `shouldWatchGitSentinel` 组合用例与 mode-watch 接线断言 | 自动 |
| FR-004 | `UiRequest.workViewFileDiffRequested`；`electron/fileOpen.ts` 的 `DiffSource` 判别联合；`ElectronUIHost.registerDiffResponder` 的按来源分流 | `src/test/fileOpen.test.ts` 的 Overlay 三种结果分支；`src/test/monacoDiff.test.ts`；`core-rs/src/work_view_tests.rs` 的 `work_view_file_diff_reads_both_sides_from_the_view` | 自动 |
| FR-005 | `core-rs/src/work_view_changes.rs` 的临时索引（`read-tree HEAD` 重建）与 `git show HEAD:./<rel>` | `core-rs/src/work_view_tests.rs` 的 `work_view_changes_do_not_write_into_the_view` | 自动 |

## 待澄清

无未决问题。

## 收敛记录

收敛方式：逐条核对 AC → 证据，再从实现 diff 反向枚举行为分支逐条找 spec 对应条目。

### 已满足

| 条目 | 证据 |
| --- | --- |
| AC-1（视图内改磁盘已有文件进清单，磁盘不变） | `work_view_changes_lists_view_only_edits`：`f.txt` 以 1/1 出现，磁盘内容仍是基线 |
| AC-2（对话内新建按未跟踪计全文新增） | 同上：`created.txt` 以 2/0 出现，磁盘上不存在 |
| AC-3（只用 Bash 改动也进清单） | 同上：判据是视图内容 vs HEAD，用例直接写视图文件、不经任何工具旁路记录 |
| AC-4（文档视图只出 Markdown） | `work_view_changes_scopes_to_markdown`：`doc` 范围出 `doc.md` / `new.md`，`all` 才含 `f.txt` |
| AC-5（普通对话行为不变） | 磁盘通道未改动；`sidebarDocView` / `sidebarDocViewGit` 全绿 |
| AC-6（视图未建立显示错误行而非空态） | `work_view_changes_require_a_mounted_view`、`work_view_changes_request_reports_missing_arguments_and_unmounted_view`（回 `kind: 'error'`） |
| AC-7（非 git 工作区回提示） | `work_view_changes_reports_non_git_workspace`（回 `NotAGitWorkspace` 事实）；`sidebar:files-doc-list-overlay` 翻成渲染层已认的 `NOT_A_GIT_WORKSPACE` |
| AC-8（Edit 成功后按当前来源重取） | `sidebar:files-invalidate` → `loadDocList` 一条入口，分流后按来源取数；`toolResultSideEffects` / `sidebarDocWatch` 全绿 |
| AC-9（切换对话按新来源重取） | `syncOverlaySession` 清缓存 + `docGeneration += 1` + 重置 `docRequested`；`sidebarFilesMode` 用例锁判别值闭合 |
| AC-10（双击非新增落变更档、显示 HEAD → 视图内容） | `work_view_file_diff_reads_both_sides_from_the_view`（`before` 为 HEAD 版本、`after` 为视图内容）；`fileOpen` 的「Overlay 变更来源 + 有 HEAD 版本 → 初始落变更视图」与「overlay 来源」判别值断言 |
| AC-11（双击新增落全文） | `fileOpen` 的「Overlay 新增文件初始落全文」「新增文件不给 diffSource」 |
| AC-12（无改动显示空态） | 空态判定仍是 `monacoDiff.buildDiffResult` 一份实现；`monacoDiff` 全绿 |
| AC-13（取数不写视图） | `work_view_changes_do_not_write_into_the_view`：取数后 `upper/` 只剩用户改过的文件 |
| AC-14（视图内 commit 后不误报） | `work_view_changes_follow_the_view_head_after_an_in_view_commit`：已提交文件不进清单、磁盘 HEAD 不变 |
| AC-15（Overlay 下不挂磁盘哨兵） | `sidebarFilesMode` 的 `shouldWatchGitSentinel` 四组组合 + `sidebar:files-mode-watch` 接线断言 |

### 偏差（已就地修正，不留待裁决）

两条都是**反向对照**发现、且都在本次收敛中改完并补了会红的用例：

1. **临时索引的来源与声明不符**（涉及 FR-001 / FR-005）。实现按「真实工作区」拼
   `git rev-parse --git-path index` 的相对路径，读到的其实是**磁盘**索引；而代码注释、plan
   与 spec 边界表都写「以视图里的 HEAD 为准」。实测复现：对话内 `git commit` 一个文件后，
   该文件被当成**未跟踪文件**列进变更清单。
   修正：有 HEAD 时用 `git read-tree HEAD` 从**视图里的** HEAD 重建视图外的临时索引，
   不再依赖复制哪一份索引；`git show HEAD:./<rel>` 本就不读索引，`file_diff` 不受影响。
   回归用例 `work_view_changes_follow_the_view_head_after_an_in_view_commit`：把实现退回
   复制索引时该用例红（已实测），改回后绿。
2. **Overlay 下挂了错对象的哨兵**（涉及 FR-003）。`sidebar:files-mode-watch` 按模式挂磁盘
   `.git` 哨兵，但 Overlay 对话的 HEAD 与改动都在 Core 私有挂载命名空间里，宿主看不到；
   挂上只会在别处 commit 时替它白重取一次。spec 原文也未定义这条。
   修正：新增纯函数 `shouldWatchGitSentinel(mode, overlaySessionId)`（模式依赖 git **且**
   来源是磁盘），侧栏把 `overlaySessionId` 一并上报；spec 补 FR-003 一段与 AC-15。
   连带：`needsGitSentinel` 此前是 `electron/main.ts` 里未使用的导入，现由判定函数消费。

### 未做

无。FR-001–FR-005 全部落地；e2e 按 spec「对需求基线的影响」登记的豁免口径保留（整链路要
真实 overlay 挂载，CI 容器不提供），由 core-rs 命名空间内用例与宿主侧用例覆盖。

### 反向对照记录

从实现 diff 枚举的额外行为分支，逐条比对 spec：

| 实现里的分支 | spec 对应 | 处置 |
| --- | --- | --- |
| 工作区是仓库**子目录**时 `diff` 带 `--relative` | FR-001（路径口径一致） | 已在 FR-001 正文与 AC 覆盖（`work_view_changes_use_workspace_relative_paths_in_a_subdirectory`） |
| 仓库内工作区之外的改动不进清单 | FR-001 | 同上用例断言 |
| 视图未建立 / git 子命令非零退出 / git 缺失 | FR-002 | 边界表两行 + `kind: 'error'` |
| 清单与两侧原文并发请求 | FR-005 | 临时索引每次调用独立文件名（`SCRATCH_SEQ`），共用一份会互写 |
| 慢请求离开帧循环 | 非 FR（同 `balanceRequested` 的处理方式） | 记在 plan「技术方案 5」，用例 `slow_ui_requests_run_off_the_frame_loop` |
| 取数期间活动对话切走 | FR-003（AC-9） | 代次作废，与目录读取同一口径 |
| 非 git 工作区的「两侧原文」仍要能打开 | FR-004 | `kind: 'not-a-git-workspace'` 分支带 `after`，`fileOpen` 三种分支用例覆盖 |

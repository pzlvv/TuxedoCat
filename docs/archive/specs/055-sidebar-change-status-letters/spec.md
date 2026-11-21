---
status: 已收敛
---

# 改动规格：变更视图用状态字母标记文件

侧栏文件资源管理器有两个变更视图（分段 switch 的「差异」段与「文档」段）。当前这两个
视图的每一行都复用目录树的文件类型图标（代码 / 配置 / 文本 / 图片等），行尾再挂
`+N` / `-M` 徽标；用户从行首看不出这一条是「新增」还是「修改」，也看不出它是从旧路径
重命名过来的——纯重命名（内容零变化）甚至根本不出现。

这次把两个变更视图里**文件行的行首类型图标**换成 git 状态字母 `A`（新增）/ `M`（修改）/
`R`（重命名），重命名行显示 `旧名 → 新名` 且不显示行数徽标。「全部」（目录树）模式与
非 git 工作区的记录口径不变，仍用文件类型图标。Overlay 对话的变更视图由 Core 在同一份
取数里给出状态与旧路径，界面不区分条目来自磁盘还是视图。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-63 变更视图（文档 / 全部变更）](../../docs/features/user-stories/desktop.md#us-63-变更视图文档--全部变更) | 修改 | 验收标准 1 / 2 / 6 从「行尾 +N/-M、无状态标记」改为「行首状态字母 + 重命名行」；「仅重命名 / 移动而无内容变化……不显示」改为「显示为 R 行」 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 两个变更视图的行内形态补状态字母与重命名行；取数事实补「状态与旧路径」 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [第 6 节 宿主固有差异（有意保留）](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 修改 | 「侧栏文件浏览器」行补同一段行内形态 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 1.1 节 按会话读取视图内容](../../docs/core/conversation-work-view.md#11-按会话读取视图内容) | 修改 | `workViewChangesRequested` 的条目形态补状态与旧路径字段 |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 2 节 宿主侧的 core 事实读取](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | 同一行的应答说明补「状态与旧路径随条目回传」 |

## 用户场景与验收标准

- 场景 1：在「差异」段分辨新增与修改
  - **AC-1**（FR-001）：GIVEN 工作区在 git 仓内且某 `.ts` 相对 HEAD 有改动、另有未跟踪的 `new.ts` WHEN 切到「差异」段 THEN `new.ts` 行首显示绿色 `A`、`.ts` 行首显示黄橙色 `M`，两行的文件类型图标都不再出现
  - **AC-2**（FR-002）：GIVEN 已 `git add` 的新文件（HEAD 里没有该路径）WHEN 看「差异」段 THEN 该行首显示 `A` 而不是 `M`
- 场景 2：重命名行
  - **AC-3**（FR-003）：GIVEN `guides/a.md` 被 `git mv` 到 `guides/b.md` 且内容有改动 WHEN 看「差异」段和「文档」段 THEN 该行首显示 `R`，行内显示 `a.md → b.md`，行尾不显示 `+N` / `-M` 徽标
  - **AC-4**（FR-003）：GIVEN 内容零变化、只是换了路径的文件 WHEN 看「差异」段 THEN 该行以 `R` 状态出现在新路径所在层级（此前这类条目不显示）
  - **AC-5**（FR-003）：GIVEN 重命名跨目录（`guides/a.md` → `notes/a.md`）WHEN 看该行 THEN 显示 `guides/a.md → a.md`，悬停提示给出完整的前后工作区相对路径
- 场景 3：其它模式与来源不受影响
  - **AC-6**（FR-005）：GIVEN 工作区不在 git 仓内、对话里用工具改过 Markdown WHEN 切到「文档」段 THEN 条目仍用文件类型图标，行尾不显示行数徽标
  - **AC-7**（FR-006）：GIVEN 活动对话是 Overlay 对话、对话视图里 `f.txt` 相对视图 HEAD 被修改、`n.txt` 是对话内新建 WHEN 看「差异」段 THEN 两行分别显示 `M` 与 `A`，与磁盘口径同一套字母与配色
  - **AC-8**（FR-001）：GIVEN 变更视图已展开 WHEN 在「全部」/「差异」/「文档」之间来回切换 THEN 行首图标槽宽度不变、文件名称列不左右跳动，目录行始终显示文件夹图标
  - **AC-9**（FR-004）：GIVEN 「差异」段里的 `A` 行 WHEN 双击它 THEN 落在全文视图（与既有「新增文件优先全文」一致），`M` / `R` 行双击仍落在变更视图

## 功能需求

### FR-001：变更视图文件行用状态字母替代类型图标

git 口径的「差异」段与「文档」段里，文件行的行首显示一个大写状态字母，占位宽度与目录树
的类型图标一致（同一行高、同一水平位置），使三段切换时行内不跳动；字母单色、等宽字体、
水平居中，配色为 `A` 绿、`M` 黄橙、`R` 蓝紫，深浅色主题各自给出可读的前景色。目录行照旧
显示文件夹图标；行尾 `+N` / `-M` 徽标除重命名行外照旧。

「全部」（目录树）模式与非 git 工作区的记录口径不显示状态字母，其行内形态不变。

### FR-002：状态由 git 事实给出，不由行数推断

每条变更条目的状态取 git 自己的状态事实（新增 / 修改 / 重命名），不由 `+N` / `-M` 的取值
推断——行数分不出 `A` 与 `M`，也表达不出重命名。判据：

- `A`：该路径在 HEAD 里没有版本。未跟踪文件、已 `git add` 的新文件、无 HEAD 的新仓里
  索引内的文件、以及当前 scope 内只出现新一侧的重命名，都归 `A`；
- `M`：该路径在 HEAD 里存在且内容有改动（含已暂存）；
- `R`：git 的重命名检测把这一条判为「旧路径 → 新路径」，且新路径落在当前 scope 内。

`A` 的判据与查看器「新增文件优先落全文」的判据同源（该路径没有 HEAD 版本），两处不各写
一套。已删除的路径不出现在清单里（状态里没有 `D`）。

### FR-003：重命名行显示前后名字，不显示行数

状态为 `R` 的行显示前后名字，形如 `旧名 → 新名`：新名是该行文件名，旧名在旧路径与新路径
父目录相同时取旧文件名、不同时取旧路径的工作区相对路径（跨目录移动与目录重命名都不至于
显示成 `a.md → a.md`）。行的悬停提示给出完整的前后工作区相对路径。

`R` 行的行尾不渲染 `+N` / `-M` 徽标：重命名行的增删行数不作为可读信息呈现。行数事实仍随
条目回传（取数不因表现而裁剪），显示与否由渲染层决定。

重命名行的相对路径、目录层级、选中 / 右键 / 双击打开语义都按**新路径**，与其它行一致；
双击 `R` 行落在变更视图（它不是新增文件）。

### FR-004：状态字母不改变双击打开的分流

行的状态只影响行内呈现，不改变打开行为：`A` 行双击落全文视图，`M` / `R` 行双击落变更
视图，判据仍是「该路径有没有 HEAD 版本」。打开来源规则（目录树恒全文、「差异」段非新增
落变更）保持不变。

### FR-005：记录口径保留类型图标

非 git 工作区的「文档」段走记录口径（`workspace.meta.json` 的 `modifiedDocs`），它只知道
「被工具改过」，没有新增 / 修改 / 重命名的区分。这一态继续用文件类型图标、不显示状态
字母，也只有它没有行数徽标。「差异」段在非 git 工作区仍是「不在 git 仓库内，无法列出
变更」的提示行。

### FR-006：Overlay 对话同一套字母

Overlay 对话（`storage` 为 `isolated`）的「差异」段与「文档」段由 Core 在对话视图里取数，
条目在回传路径与行数的同时回传状态与旧路径；渲染层的字母、重命名行形态、配色、行尾规则
与磁盘口径完全同一份，界面不区分条目来源。Core 的口径与磁盘侧同源：`A` 仍是「视图里
HEAD 没有该路径」。

## 边界与错误路径

- **跨类型重命名**：`a.txt` → `b.md` 这类重命名，在「文档」段的 pathspec 内 git 只看到
  新一侧，因此该行状态是 `A`（带行数）；同一改动在「差异」段显示为 `R`。两个视图的事实
  各自按自己的 scope 取，不为了让字母一致而改 scope 语义。
- **重命名 + 内容改动**：一条既重命名又改了内容的条目状态是 `R`（不重复标 `M`），行尾
  不显示行数——状态描述的是这一条的主要事实。
- **低于重命名阈值的移动**：git 不判为重命名时如实呈现为新路径的 `A`（旧路径的删除条目
  本就不显示），不做额外的相似度判断，也不合并两条。
- **大小写重命名**（`a.md` → `A.md`）：按 git 在目标平台上的实际输出呈现，不特判。
- **二进制文件**：与现状一致不进变更清单（不呈现状态字母），本条不改。
- **git 取数失败 / 无 HEAD 的新仓**：失败仍是错误态行「读取失败，点击重试」，不静默空列表；
  无 HEAD 的新仓里索引内的文件状态一律 `A`。
- **非 git 工作区**：「差异」段提示行、记录口径的类型图标都不变（FR-005）。
- **Overlay 视图未建立 / Core 不可用**：仍是错误行，不回退磁盘清单，也不猜状态。

## 非目标

- 不改「全部」（目录树）模式的行内形态与图标口径。
- 不引入 `D`（已删除）、`U`（冲突）、`?`（未跟踪）等其它状态标记：已删除条目继续不显示，
  未跟踪归入 `A`。
- 不在变更视图里同时保留类型图标（字母是替代，不是叠加）。
- 不改查看器（Markdown 预览 / 文本编辑器）的变更视图与「新增」判定实现，只要求判据同源。
- 不改条目排序与分组（目录在前、同类按名称），不改分段 switch 的形态与记忆方式。
- 不做变更视图的按状态过滤 / 分组（如需另立需求，进
  [docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。

## 对需求基线的影响

修改 US-63（[desktop.md](../../docs/features/user-stories/desktop.md#us-63-变更视图文档--全部变更)）
的验收标准，不新增 US：验收标准 1 / 6 补「行首状态字母」与配色，验收标准 2 / 6 中「仅重命名 /
移动而无内容变化……不显示」改为「显示为 `R` 行且不显示行数」，验收标准 1 中「行尾显示 +N / -M」
限定为 `A` / `M` 行。e2e 覆盖落在既有用例文件 `e2e/electron/fileExplorer.spec.ts`（磁盘口径）
与 `e2e/electron/remoteChangeList.spec.ts`（远端口径），不新增用例文件。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/sidebar/main.ts` 的变更视图行渲染与 `electron/sidebar/styles.css` 的状态字母样式 | `e2e/electron/fileExplorer.spec.ts`（`US-63 specs/055 AC-1/AC-8`：字母与配色、切换不跳动、目录行仍是文件夹图标） | 自动 |
| FR-002 | `electron/sidebarDocView.ts` 的 git 状态解析与 `core-rs/src/work_view_changes.rs` 的同一口径 | `src/test/sidebarDocView.test.ts`（`--name-status` 解析与纯重命名保留为 `R`）、`src/test/sidebarDocViewGit.test.ts`（真实仓：未跟踪 / 已暂存 / 修改 / 重命名的状态）、`core-rs/src/work_view_changes_tests.rs` | 自动 |
| FR-003 | `electron/sidebar/main.ts` 的重命名行渲染（前后名字与悬停提示） | `e2e/electron/fileExplorer.spec.ts`（`US-63 specs/055 AC-3/AC-4/AC-5`：`R` 行名字形态、无行数徽标、跨目录取旧相对路径） | 自动 |
| FR-004 | `electron/sidebar/main.ts` 的打开来源判定（不改判据，只回归） | `e2e/electron/fileExplorer.spec.ts`（`US-63 specs/055 AC-9`：`A` 落全文、`M` / `R` 落变更视图） | 自动 |
| FR-005 | `electron/sidebar/main.ts` 的记录口径分支继续用类型图标 | `e2e/electron/fileExplorer.spec.ts`（`US-63 specs/055 AC-6`） | 自动 |
| FR-006 | `core-rs/src/work_view_changes.rs` 与 `core-rs/src/main.rs` 的条目序列化、`src/shared/AssistantEventBus.ts` 的条目类型、`electron/main.ts` 的行组装 | `core-rs/src/work_view_changes_tests.rs`、`e2e/electron/remoteChangeList.spec.ts`（`US-63 specs/055 AC-7`） | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

- 已满足：
  - FR-001（行首状态字母替代类型图标）→ `electron/sidebar/main.ts` 的 `docRowHtml` 渲染
    `.doc-status doc-status-{a|m|r}`（复用 `.file-icon` 的 14px 槽位），`electron/sidebar/styles.css`
    给三档配色（深色 + 浅色主题各一档）。证据：e2e `US-63 specs/055 AC-1/AC-8`（字母文本、配色
    class、实际计算颜色互不相同、三段切换槽宽一致、目录行仍是 `.ficon-folder`）。
  - FR-002（状态来自 git 事实）→ 宿主 `electron/sidebarDocView.ts` 的 `parseNameStatus` +
    `collectGitEntries` 按新路径合并，`buildChangeCommands` 增第五条 `--name-status -z` 事实
    （仍是一次 `runBatch`）；Core `core-rs/src/work_view_changes.rs` 的 `parse_name_status_z` +
    `entries_against_head` 同一口径。证据：`src/test/sidebarDocView.test.ts`（`parseNameStatus`
    分段 / 复制按 A / 截断段跳过、`A` / `M` / `R` 与 `oldPath` 回传、状态事实失败转错误态、
    RT-2 五条命令同序一次发出）、`src/test/sidebarDocViewGit.test.ts`（真实仓：未跟踪 → A、
    已暂存新文件 → A、修改 → M、纯重命名 → R、跨类型重命名在 doc scope → A）、
    `core-rs/src/work_view_changes_tests.rs`、e2e `US-63 specs/055 AC-2`。
  - FR-003（重命名行显示前后名字、不显示行数）→ `renameOldName`（同父目录取旧文件名、跨目录取
    旧相对路径）+ `title` 给完整前后路径 + `R` 行不渲染 `.doc-count`。证据：e2e
    `US-63 specs/055 AC-3/AC-4/AC-5`（`b.md → c.md` 行内形态与无徽标、纯重命名 `docs/deep.md →
    docs/renamed.md` 出现、跨目录 `notes.txt → docs/notes-moved.txt` 的 `title`）。
  - FR-004（不改变双击打开分流）→ `openFileRow` 的 `source` 判据未改，`A` 行落全文由查看器的
    `hasHeadVersion` 决定。证据：e2e `US-63 specs/055 AC-9`（`A` 行无 DiffEditor、`M` 行
    DiffEditor 直接可见）。
  - FR-005（记录口径保留类型图标）→ `docRowHtml` 在 `status === null` 时走 `fileIconFor`。
    证据：e2e `US-63 specs/055 AC-6`（`.doc-status` 计数 0、`.ficon-text` 可见、无行数徽标）。
  - FR-006（Overlay 同一套字母）→ 契约 `WorkViewChangeEntry.status` / `oldPath`（都是必选，
    `oldPath` 的「没有」用 `null`）；Core `main.rs` 的 `work_view_changes_payload` 序列化两字段；
    `buildDocRows` 透传给同一条渲染路径。证据：`core-rs/src/main_tests.rs` 的
    `work_view_changes_payload_carries_status_and_old_path`、`core-rs/src/work_view_tests.rs` 的
    `work_view_changes_lists_view_only_edits`（M / A 断言）、e2e `overlayMountProxyRemote`（Overlay
    条目带 `status: 'A'` 与 `oldPath: null`）、e2e `US-63 specs/055 AC-7`（远端 M / A / R）。
  - AC-8（三段切换不跳动）→ 字母复用 `.file-icon` 的 14px 槽位，e2e 用 `boundingBox().width`
    比较「差异」段与目录树同一行的槽宽。
- 偏差：无。实现与 spec 的 FR / AC 逐条一致；跨类型重命名在 `doc` scope 下呈现 `A` 是 spec
  边界第 1 条已写明的预期行为，不是偏差。
- 未做：无。

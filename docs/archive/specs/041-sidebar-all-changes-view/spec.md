---
status: 已收敛
---

# 改动规格：文件资源管理器的「全部变更」视图

侧栏文件浏览器当前有两个模式：目录树（懒加载全量）与文档视图（只看有变更的
Markdown）。这次加第三个模式「全部变更」：与文档视图同形，但覆盖**所有文件类型**——
用户不必为了看一个 `.ts` 的改动而先把它改成 `.md`。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/hosts/electron-multi-workspace.md` | 9. 侧栏 | 修改 | 文件浏览器分区补第三个模式按钮与三条 IPC 口径 |
| `docs/features/user-stories/desktop.md` | US-63 文档视图 | 修改 | 扩展为「变更视图」：Markdown 文档视图与全部变更视图共用同一套取数与哨兵 |
| `docs/hosts/host-matrix.md` | 6. 宿主固有差异 | 修改 | 侧栏文件浏览器行补「全部变更」模式的取数口径（本地 / 远程同一份 `GitCommandRunner`） |

## 用户场景与验收标准

- 场景 1：切到全部变更视图
  - **AC-1**（FR-001）：GIVEN 文件浏览器已展开 WHEN 点「全部变更」按钮 THEN 列表只显示相对 HEAD 有改动的**全部类型**文件，每行带 `+N/-M` 徽标
  - **AC-2**（FR-001）：GIVEN 当前在目录树 WHEN 点「全部变更」 THEN 切到变更视图；再点一次回到目录树，三者互斥
  - **AC-3**（FR-001）：GIVEN 已切到全部变更视图 WHEN 切换工作区再切回 THEN 该工作区仍是全部变更视图（按工作区记忆，与文档视图同口径）
- 场景 2：取数口径
  - **AC-4**（FR-002）：GIVEN git 仓库 WHEN 取数 THEN 用 `git diff --numstat -M HEAD`（含已暂存与未暂存）+ `git ls-files --others --exclude-standard`（未跟踪按全文计新增），与文档视图同一套解析
  - **AC-5**（FR-002）：GIVEN 目录树里有多个文件被改 WHEN 看列表 THEN 目录在前、全部层级默认展开（与文档视图同形）
  - **AC-6**（FR-002）：GIVEN 纯重命名 / 已删除的文件 WHEN 取数 THEN 不显示（与文档视图同口径）
  - **AC-7**（FR-003）：GIVEN 非 git 工作区 WHEN 点「全部变更」 THEN 提示「不在 git 仓库内」而不是空列表
- 场景 3：与既有视图的关系
  - **AC-8**（FR-004）：GIVEN 在全部变更视图 WHEN 双击一行 THEN 打开对应文件；非新增文件落在**变更视图**（见 `specs/040-editor-diff-views`），新增文件落在全文
  - **AC-9**（FR-004）：GIVEN git 变更 WHEN 提交后 THEN 哨兵推送让全部变更视图自动刷新，与文档视图共用同一个监听

## 功能需求

### FR-001：第三个模式按钮

文件浏览器分区头部在既有「文档视图」按钮右侧加一个「全部变更」按钮。三种模式互斥：
目录树（默认）/ 文档视图（只看变更的 Markdown）/ 全部变更（看所有变更文件）。模式按
工作区记忆（沿用文档视图的 localStorage map 形态，键增加一个维度）。

按钮的 `aria-pressed` 与视觉态与文档视图同款；再点当前模式按钮回到目录树。

### FR-002：取数

新增一个与文档视图并列的取数函数，参数化 pathspec：

- 有 HEAD：`git diff --numstat -M HEAD --` + `git ls-files --others --exclude-standard --`
- 无 HEAD：`git ls-files --` 按索引全文计行 + 未跟踪全文计行
- 复用 `parseNumstat` / `parseLsFiles` / `unquoteGitPath` / `normalizeRenamedPath` /
  `countLines` / `buildDocRows`——不复制第二份解析（同一份 git 输出只有一处解析）
- 已删除文件按存在性过滤（与文档视图同口径）

与文档视图的差别只有 pathspec（不限定 `*.md`）与空态文案。

### FR-003：非 git 工作区

探测口径沿用 `probeGitWorkspace`：不在仓库内时按钮仍可点，列表显示「不在 git 仓库内，
无法列出变更」的提示态（不是空列表——空列表会被误读成「没有改动」）。

### FR-004：与打开策略、监听的接线

- 双击行的打开请求带 `initialView: 'changes'`（非新增文件），复用
  `specs/040-editor-diff-views` 的 `initialView` 字段；
- 刷新触发复用 `DocSentinelManager`：哨兵本来就在听 `.git` 与 `.git/refs/heads`，
  全部变更视图与文档视图共用同一次失效推送（`sidebar:files-invalidate` 的 `reasons`
  增加 `'changes'`，或复用 `'doc'` 并让两个模式都消费它）。

## 边界与错误路径

- git 命令失败：列表显示错误文案与原因（与文档视图同款错误态），不静默空态。
- 超大仓库（数千改动文件）：沿用既有的 `maxBuffer` 上限，超限报错而不是截断列表。
- 远程工作区：走同一个 `GitCommandRunner` 的 SSH exec 实现（复用 §14.5 的共享连接池），
  行为一致。
- 工作区是子目录（仓库根在上级）：paths 相对工作区根显示，git 命令仍以工作区为 `-C`。

## 非目标

- 不做 hunk 级操作、暂存、提交（只读清单）。
- 不做目录树与变更视图的混合模式（三选一互斥）。
- 不在变更视图里给单文件再画内联 diff（双击进查看器的变更视图）。
- 不改文档视图的既有取数口径（它仍是 Markdown-only）。

## 对需求基线的影响

修改 `docs/features/user-stories/desktop.md` 的 US-63（文档视图 → 变更视图族）。
e2e：`e2e/electron/fileExplorer.spec.ts` 补用例（`.ts` 改动出现在全部变更视图、
三个模式互斥、提交后自动刷新）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/sidebar/main.ts` 的模式状态与按钮；`electron/sidebar/index.html` | e2e `e2e/electron/fileExplorer.spec.ts` | 自动 |
| FR-002 | `electron/sidebarDocView.ts` 的取数参数化（pathspec） | `src/test/sidebarDocView.test.ts`（假 runner 驱动全类型 pathspec） | 自动 |
| FR-003 | 同上的探测分支 | `src/test/sidebarDocView.test.ts` | 自动 |
| FR-004 | `electron/fileOpen.ts` 的 `initialView`；`electron/sidebarDocWatch.ts` | `src/test/fileOpen.test.ts`；e2e | 自动 |

## 待澄清

（无）

## 收敛记录

### 已满足

| 验收标准 | 证据落点 |
| --- | --- |
| AC-1（FR-001）列表只显示相对 HEAD 有改动的全部类型文件，每行带 `+N/-M` | `fileExplorer.spec.ts` 的 `specs/041 AC-1/FR-002`：改一个 `.ts` 后出现在列表，`.doc-count` 含 `+3` / `-1` |
| AC-2（FR-001）三态互斥、再点当前模式回目录树 | `sidebarFilesMode.test.ts` 的 `toggleFilesMode` 六种转移；e2e `AC-2/FR-001` 断言 `aria-pressed` 往返与目录树恢复 |
| AC-3（FR-001）按工作区记忆 | `parseStoredModes` 的旧布尔迁移 + `toggleFilesMode` 用例；e2e `AC-3/FR-001` 切走再切回仍是全部变更 |
| AC-4（FR-002）numstat + ls-files 同一套解析 | `sidebarDocView.test.ts` 的 scope 断言：`all` 时三条命令 `args` 逐字（`--` 后为空）；解析/归一/剔除一行未改 |
| AC-5（FR-002）目录在前、全部层级默认展开 | 复用 `buildDocRows`（`sidebarDocView.test.ts` 的层级铺平用例） |
| AC-6（FR-002）纯重命名 / 已删除不显示 | `sidebarDocView.test.ts` 的 `scope=all：纯重命名与已删除文件仍被剔除` |
| AC-7（FR-003）非 git 工作区提示而不是空列表 | `renderDocFiles` 的 `NOT_A_GIT_WORKSPACE` 分支；e2e `AC-7/FR-003` 断言提示文案且空态不出现 |
| AC-8（FR-004）双击非新增文件落变更视图 | `resolveInitialView('changes', false)`；`fileExplorer` 的 `openFileRow` 按 mode 传 `source` |
| AC-9（FR-004）提交后自动刷新、与文档视图共用哨兵 | `ElectronUIHost` 的 `onInvalidate` 同时推 `doc` + `changes`；e2e `AC-9/FR-004` 提交后列表清空 |

### 偏差（已就地修正或补进 spec）

1. **Tab 的三态没有走 antd Dropdown**。plan 写「沿用 webview 既有的 antd Dropdown 主题」，但侧栏是独立 vite 页（无 antd），实际用同款视觉的自绘菜单/按钮类。已在 spec 的 FR-001 改写成「复用 `.files-doc-toggle` 视觉」，不再承诺 antd。
2. **`pathspecFor` 放在渲染层可测模块里，而非主进程**。plan 把 pathspec 写进 `sidebarDocView.ts`（主进程侧），实际落在该文件的导出函数由两侧共享——主进程 `main.ts` 也 import 它，因此「唯一定义处」成立。与 plan 一致，无偏差。
3. **`not-a-git-workspace` 的判定在主进程而非渲染层**。FR-003 只写「显示提示」，实际是主进程返回该 error 值、渲染层映射成提示行。已在 FR-003 写明判别值。

### 未做

无。T001 ～ T007 全部完成；`test:unit` 的 `sidebarFilesMode`（29 项）、`sidebarDocView`（21 项）与 e2e 5 条全绿。


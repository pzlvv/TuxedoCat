# 实施方案：文件资源管理器的「全部变更」视图

技术路线：把文件浏览器从「布尔开关（文档视图 yes/no）」改成三态模式
`'tree' | 'doc' | 'changes'`，第三态复用文档视图的渲染与取数实现——取数函数参数化
pathspec 之后，两者只差「限定 `*.md`」与空态文案。哨兵、按工作区记忆、双击打开策略全部
沿用既有链路，不新增监听、不新增 git 调用层。需求口径见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 取数参数化（`electron/sidebarDocView.ts`）

现有 `collectGitEntries(runner)` 里 pathspec 硬编码为 `['--', '*.md', '*.markdown']`。改为：

```ts 示意
export type ChangeScope = 'doc' | 'all';

/** pathspec 的唯一定义处：doc = Markdown，all = 不限定（git 的 `--` 之后为空即全部） */
function pathspecFor(scope: ChangeScope): string[];

export async function collectGitEntries(
  runner: GitCommandRunner,
  scope: ChangeScope = 'doc',
): Promise<DocListResult>;
```

- `scope === 'all'` 时三处调用（`diff --numstat -M HEAD` / 无 HEAD 的 `ls-files` /
  `ls-files --others --exclude-standard`）都不带 pathspec 过滤器（`--` 之后不再跟 `*.md`）。
- 解析、存在性过滤、排序一行不改——`parseNumstat` / `parseLsFiles` / `unquoteGitPath` /
  `normalizeRenamedPath` / `countLines` 全部复用（spec FR-002「不复制第二份解析」）。
- 纯重命名（numstat 的 `old => new` 归一后无增删）与已删除文件继续被既有逻辑剔除（AC-6）。
- 超大仓库：`maxBuffer` 仍是 `localGitRunner` 的 16 MB（spec 边界第 2 条），超限抛错由
  上层转错误态。

### 2. 三态模式（`electron/sidebar/main.ts`）

```ts
type FilesMode = 'tree' | 'doc' | 'changes';
```

- `WorkspaceFilesState.docView: boolean` 换成 `mode: FilesMode`；`docListing` 增加
  `scope: ChangeScope`（与 `mode` 一一对应，`'tree'` 时不取数）。
- localStorage 记忆：现有键 `FILES_DOCVIEW_KEY` 的值是 `Record<workspaceId, boolean>`。改为
  新键 `FILES_MODE_KEY`，值 `Record<workspaceId, FilesMode>`；读取时**兼容旧值**——布尔
  `true` → `'doc'`、`false` / 缺失 → `'tree'`，写回一律新格式（旧键不再写，也不主动删，
  免得回退版本时丢状态）。
- 渲染：`renderFiles()` 里 `mode === 'tree'` 走既有的目录树分支，其余两态都走
  `renderDocFiles(files, id, files.mode)`。空态文案按 scope 分叉：
  `doc` → 「没有变更的 Markdown 文档」（既有），`all` → 「没有变更的文件」。
- 两个按钮的 `aria-pressed` 与 `.active` 各自独立（互斥由状态机保证，不是两个布尔）。

### 3. 第三个按钮（`electron/sidebar/index.html` + 样式）

- 在 `#filesDocToggle` 右侧加 `#filesAllChangesToggle`，图标用「差异」语义的 SVG
  （上下箭头 / 两条横线），`title` 写「全部变更：列出所有有改动的文件」。
- 样式复用 `.files-doc-toggle`（同一 class，加一个 `.files-all-changes-toggle` 别名只为
  事件绑定好读）；`.files-section.expanded` 下的 `display: flex` 规则已经覆盖两者。
- 点击语义（写成一个 `toggleFilesMode(target: FilesMode)`）：点当前模式按钮回到
  `'tree'`；点另一模式按钮直接切到该模式（AC-2「再点一次回到目录树，三者互斥」）。

### 4. 与打开策略、监听的接线

- 双击行：`openFileRow(rel)` 增加来源参数。`mode === 'changes'` 时调
  `filesOpen(id, rel, 'changes')`，`'tree'` / `'doc'` 时传 `'tree'`。`sidebarPreload.ts` 的
  `filesOpen` 与主进程 `sidebar:files-open` 的 payload 增加 `source` 字段（`'tree' |
  'changes'`），交给 specs/040 的 `resolveInitialView` 决定初始视图（非新增文件落变更视图，
  新增落全文）。
- 哨兵：`DocSentinelManager` 本来就在听 `.git` 与 `.git/refs/heads`，**不新增监听**。开关
  上报从 `filesDocWatch(id, boolean)` 改为 `filesModeWatch(id, mode)`，主进程在
  `mode !== 'tree'` 时挂哨兵、`mode === 'tree'` 时摘。失效推送的 `reasons` 增加
  `'changes'`：`reasons.includes('changes')` 且 `mode === 'changes'` 时 `loadDocList(id)`；
  `'doc'` 分支保持原样（AC-9「共用同一个监听」）。
- 非活动工作区的失效推送：既有机制（`refreshWorkspace` 定向装载）不变。

### 5. 非 git 工作区（AC-7）

`mode === 'changes'` 时取数仍先跑 `probeGitWorkspace`：
- `'yes'` → `collectGitEntries(runner, 'all')`；
- `'no'` → **不**回落到记录口径（记录口径是「非 git 工作区里改过的 Markdown」，与「全部
  变更」语义不同），直接返回 `{ ok: false, error: 'not-a-git-workspace' }`；
- 探测出错 → 原样回错误态。

渲染层把 `not-a-git-workspace` 映射成「不在 git 仓库内，无法列出变更」的提示行
（AC-7 要求的「提示而不是空列表」）。`doc` 模式维持现状（`'no'` 回落到记录口径），不改
既有语义（spec 非目标最后一条）。

### 6. 测试落点

- `src/test/sidebarDocView.test.ts`（补）：`scope === 'all'` 时三条 git 命令的 args 逐字
  （无 pathspec）、`scope === 'doc'` 保持原样、`scope === 'all'` 下重命名 / 删除仍被剔除、
  非 git 探测结果不触发记录口径。
- `src/test/sidebarFilesMode.test.ts`（新增纯函数）：`parseStoredModes` 的旧布尔兼容、
  `modeForScope` 映射、`toggleFilesMode` 的三态转移（AC-2 / AC-3）。
- `e2e/electron/fileExplorer.spec.ts`（补）：改一个 `.ts` → 出现在全部变更视图（AC-1）、
  三个模式互斥往返（AC-2）、切工作区再切回记忆（AC-3）、双击非新增文件落变更视图（AC-8）、
  `git commit` 后列表自动清空（AC-9）、非 git 工作区提示（AC-7）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/sidebarDocView.ts` | `collectGitEntries(runner, scope)` + `pathspecFor` | 无（宿主内部） |
| `electron/sidebar/main.ts` | 三态模式、localStorage 迁移、按钮事件、空态文案 | 无 |
| `electron/sidebar/index.html` | 第三个按钮 | 无 |
| `electron/sidebar/styles.css` | 复用既有 class（可能加一行别名） | 无 |
| `electron/sidebarPreload.ts` | `filesModeWatch` + `filesOpen(id, rel, source)` | 侧栏 IPC 契约（preload 内） |
| `electron/main.ts` | `sidebar:files-doc-list` 接受 scope；`files-open` 接受 source；失效 reasons 增加 `changes` | 侧栏 IPC 契约 |
| `electron/sidebarDocWatch.ts` | 挂 / 摘改为按 mode（内部参数） | 无 |
| `electron/fileOpen.ts` | 消费 `source`（依赖 specs/040 的 `resolveInitialView`） | `FileOpenBridge` 参数 |
| `src/test/sidebarDocView.test.ts` / `sidebarFilesMode.test.ts` | 补 / 新增 | 无 |
| `e2e/electron/fileExplorer.spec.ts` | 补 6 条 | 无 |
| [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 三态模式 + 三条 IPC 口径 | 宿主规格 |
| `docs/features/user-stories/desktop.md` | US-63 扩展为「变更视图」 | 需求基线 |
| `docs/hosts/host-matrix.md` 第 6 节 | 侧栏文件浏览器行补取数口径 | 宿主规格 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md` 第 1 节）：改动全在 `electron/`（宿主侧渲染与 git 取数），
      不进 `src/shared/`、不进 core；`sidebarDocView.ts` 保持「不 import electron」。
- [x] 架构铁律（`AGENTS.md` 第 4 节）：不过度 fallback——非 git 工作区显式提示而不是空列表，
      git 失败显式错误态；契约成员全必选（`source` / `scope` 都是必选判别值，缺省由调用方
      显式写 `'tree'` / `'doc'`）；一份事实一个写入点（模式状态只有 `filesStateByWorkspace`
      一份，localStorage 是它的持久化投影）；派生逻辑只有一份（pathspec 只在
      `pathspecFor`，解析只在既有 `parseNumstat` 一族）。
- [x] Core 行为与落盘格式同步义务（`AGENTS.md` 第 5 节）：不涉及——纯宿主侧改动。git 命令
      输出永远产生在文件所在机器（本地 spawn / 远程 SSH exec），与既有文档视图同一口径。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：第 4 节三份文档与 specs/040 同一提交；spec 收敛
      时 delta 并入 `docs/hosts/`。

## 被否决的替代方案

1. **再加一个布尔 `allChanges: boolean`**：两个布尔能表达四种组合，其中三种是非法状态，
   得靠额外守卫压回去。三态判别联合是唯一真值表示。否决。
2. **在 `changes` 模式下用 `git status --porcelain`**：与文档视图的 numstat 口径不同
   （行数要重算、重命名表示不同、未跟踪要看全文），会形成第二份 git 解析。否决，同一套
   `parseNumstat` + pathspec 参数化。
3. **非 git 工作区回落记录口径**：记录口径只覆盖 Markdown，拿它冒充「全部变更」会让用户
   以为 `.ts` 没改。spec AC-7 要求提示。否决。
4. **新增独立哨兵 / 独立轮询**：`DocSentinelManager` 已经在听 `.git`，再加一份是同事实两个
   来源。改用共享失效推送 + `reasons` 分叉。否决。
5. **在变更视图里内联 diff**：spec 非目标（双击进查看器的变更视图，specs/040）。否决。
6. **混进目录树（在有改动的文件上打标）**：会让树需要全量 stat / diff，破坏懒加载语义。
   spec 非目标明确三选一互斥。否决。

# 实施方案：内置文本编辑器与 Markdown 预览的「变更」视图

技术路线：diff 的两侧都在主进程取（`git show HEAD:<path>` + 读盘），页面只负责渲染。
Monaco 窗口已经是三态（`view` / `diff` / `content`），这次把它变成「可编辑全文 + 只读变更」
两档同窗切换；Markdown 预览窗口在既有「渲染 / 文本」左侧加一组「全文 / 变更」。打开时的
初始视图由新增的纯函数 `electron/fileOpen.ts::resolveInitialView` 决定，调用方（侧栏、文件
树、工具卡片链接）只提供来源与文件状态。需求口径见同目录 [spec.md](spec.md)。

## 技术方案

### 1. git 取数（新模块 `electron/gitFileContent.ts`）

```ts 示意
export interface FileContentRunner {
  /** `git show <rev>:<path>`；无该版本时返回 null（不是错误） */
  showAtHead(rel: string): Promise<string | null>;
  /** 文件是否被 git 跟踪 / 是否有 HEAD 版本 */
  hasHeadVersion(rel: string): Promise<boolean>;
  /** HEAD 内容是否与工作区当前内容相同（「没有改动」空态用） */
  isClean(rel: string): Promise<boolean>;
}

export function localFileContentRunner(root: string): FileContentRunner;
```

- 三个方法都基于已有的 `GitCommandRunner`（`electron/sidebarDocView.ts`）：复用
  `run(['show', 'HEAD:<rel>'])` / `run(['cat-file', '-e', 'HEAD:<rel>'])` /
  `run(['diff', '--quiet', 'HEAD', '--', rel])`，**不新写一份 git 调用层**。远端工作区由
  `electron/main.ts` 的 `remoteGitRunner`（SSH exec）实现同一接口，行为一致（spec FR-004
  最后一句）。
- `hasHeadVersion` 同时是 spec FR-003 的「新增」判据：`cat-file -e` 失败即视为新增
  （与 `sidebarDocView.ts` 的 git 口径同源，不另写一份）。
- 失败（超时 / 非零退出且不是「不存在」）向上抛，由调用方转成视图错误态（spec 边界第 1
  条），不静默空态。
- 新模块纯 Node、不 import electron，单测直接驱动（与 `sidebarDocView.ts` 同模式）。

### 2. Monaco 窗口：`view` / `diff` 两档同窗切换

页面侧（`electron/monaco/main.ts`）：

- `MonacoInitData` 增加 `pathspec`（工作区相对路径，diff 用）与 `hasHeadVersion`；`mode`
  取值不变（`view` / `diff` / `content`，`diff` 从「一次性打开的工具 diff」升级为「相对
  HEAD 的变更视图」——工具卡片的 diff 仍然走 webview，`showDiff` 保持空实现）。
- 标题栏加一个切换按钮（与 Markdown 预览同款：标签是**切换目标**，`aria-pressed` 表示
  当前是否在变更视图）。`view` ↔ `diff` 互换时**复用同一个窗口与同一个 `filePath`**，只重建
  编辑器实例；`viewState` 用 `Map<'view' | 'diff', editorViewState>` 分别保存（spec FR-002
  第 3 段的同款要求，AC 不直接覆盖但要一起做）。
- 「没有改动」空态：`isClean === true` 时不创建 `DiffEditor`，容器里放一行提示（AC-2）。
- 切换按钮在 `mode === 'content'`（虚拟文档）时不渲染——虚拟文档没有 git 版本（spec FR-001
  的四态里 `content` 是只读展示）。
- 页面需要的 diff 内容由主进程在切换时按需下发 `monaco-diff`（`{ before, after }`），不在
  `monaco-init` 里预取——打开一个文件不该多跑一次 `git show`。

主进程（`electron/ElectronUIHost.openMonacoWindow`）：

- `init` 增加 `diffSource?: { root: string; rel: string; runner: FileContentRunner }`。有它才
  注册 `monaco-request-diff` 的 IPC 应答（发送方校验：必须是当前查看器窗口，
  `event.sender === win.webContents`），应答体 `{ before, after, clean }`。
- 没有 `diffSource`（虚拟文档 / 远程读失败兜底）时按钮不渲染——页面的 `monaco-init` 里
  `canDiff: false`。

### 3. Markdown 预览：两组开关

`electron/monaco/markdownMain.ts`：

- `state` 拆成两个正交字段：`contentMode: 'rendered' | 'text'`（既有）与
  `sourceMode: 'full' | 'changes'`（新增）。`applyMode()` 只决定主区域显示什么；
  `sourceMode` 只在 `contentMode === 'text'` 时生效（「渲染」态忽略变更开关，AC-4）。
- 标题栏两组按钮，从左到右：`全文 / 变更`（新）、`渲染 / 文本`（既有）。两组的标签语义
  与现有按钮一致：标签是**切换目标**。间距与样式沿用 `.files-doc-toggle` 那一套（与侧栏
  切换按钮同视觉）。
- 切到 `text` 且 `sourceMode === 'changes'` 时，把编辑器容器换成 `DiffEditor`（同一个只读
  Monaco 实例，`createDiffEditor` 时 `readOnly: true`、`renderSideBySide: true`，与 Monaco
  窗口同一套配置——渲染实现只有一份）。切回 `full` 时回到 `createModel(sourceText)`。
- `markdown-init` 增加 `canDiff` / `hasHeadVersion`；`markdown-refresh` 在变更态下改发
  `{ before, after }`（主进程按 `watchTarget` 重新取），全文态仍发 `{ text }`。
- 初始视图（AC-8）：`initialSourceMode === 'changes'` 且非新增时，`state.contentMode`
  直接落 `text` + `sourceMode: 'changes'`（跳过渲染视图）；否则维持现状（默认渲染视图，
  `selectedLines` 存在时落文本并定位）。

### 4. 打开时的初始视图（纯函数）

`electron/fileOpen.ts` 新增：

```ts 示意
export type OpenSource = 'tree' | 'changes' | 'toolLink';
export function resolveInitialView(source: OpenSource, isNewFile: boolean): 'full' | 'changes';
```

映射就是 spec FR-003 的表：`tree` → 恒 `full`；`changes` / `toolLink` → 新增 ? `full` :
`changes`。函数是纯的、单测直接驱动（`src/test/fileOpen.test.ts` 补一组）。

接线：

- `openLocalWorkspaceFile` / `openRemoteWorkspaceFile` 增加参数
  `source: OpenSource`，并在需要 `changes` 时先用 `fileContentRunner` 查 `hasHeadVersion`；
- `electron/main.ts` 的 `sidebar:files-open` 分支：目录树双击传 `tree`；「全部变更」视图
  双击（specs/041）传 `changes`；工具卡片链接（`WebViewUI` → `UIHost.openFile`）传
  `toolLink`。判定「新增」在主进程做一次（`hasHeadVersion`），不复用 webview 的任何缓存。
- 远程工作区没有本地 `git` 可跑：`remoteGitRunner` 走 SSH exec，接口相同（spec FR-004）。

### 5. 非 git 工作区（AC-9）

`probeGitWorkspace`（已有）在窗口打开时跑一次，结果塞进 `monaco-init` / `markdown-init`
的 `canDiff`。`canDiff === false` 时切换按钮 `disabled` 且 `title` 写「不在 git 仓库内，
无法显示变更」，不渲染空的 diff。

### 6. 测试落点

- `src/test/gitFileContent.test.ts`（新增）：假 `GitCommandRunner` 驱动——HEAD 有 / 无、
  clean / dirty、失败抛出、`cat-file` 与 `diff --quiet` 的参数逐字。
- `src/test/fileOpen.test.ts`（补）：`resolveInitialView` 六个组合 + 与「新增」判据的接线。
- `src/test/monacoDiff.test.ts`（新增）：diff 两侧的组装与空态判定的纯函数
  （`buildDiffPayload({before, after}) -> { mode: 'diff' } | { mode: 'empty' }`），组件层
  不单测（vite 页面不在单测车道）。
- `e2e/electron/preview.spec.ts`（补）：文件树打开非新增文本文件落全文 → 点变更显示 diff
  → 没有改动的文件点变更显示空态（AC-1 / AC-2）；Markdown 两组开关互不干扰（AC-3 / AC-4）；
  从「全部变更」视图与文件树打开同一文件的初始视图不同（AC-5 ～ AC-8）；非 git 工作区按钮
  置灰（AC-9）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/gitFileContent.ts` | 新增（`FileContentRunner` + 本地实现） | 无（宿主内部） |
| `electron/fileOpen.ts` | `resolveInitialView` + 两个 open 函数增加 `source` 参数 | `FileOpenBridge` 的 init 增加 `initialView` / `diffSource` |
| `electron/ElectronUIHost.ts` | `openMonacoWindow` / `openMarkdownPreviewWindow` 的 init 扩展；`monaco-request-diff` IPC | 宿主内部 |
| `electron/main.ts` | 三个打开来源传 `source`；注册 diff 应答；远程 runner 复用 | 无 |
| `electron/monaco/main.ts` | `view` ↔ `diff` 切换、空态、`viewState` 双份 | 页面协议 `monaco-diff` |
| `electron/monaco/markdownMain.ts` | 两组开关、变更态 DiffEditor | 页面协议 `markdown-init` / `markdown-refresh` 扩展 |
| `electron/sidebar/main.ts` | 「全部变更」视图双击传 `changes`（依赖 specs/041） | 无 |
| `electron/sidebarDocView.ts` | 无改动（只被复用） | 无 |
| `src/test/*` | 三个测试文件 | 无 |
| `e2e/electron/preview.spec.ts` | 补 6 条 | 无 |
| [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 与 specs/041 同一次编辑 | 宿主规格 |
| `docs/hosts/host-matrix.md` 第 6 节 | 查看器行补变更视图与初始视图口径 | 宿主规格 |
| `docs/features/user-stories/desktop.md` | US-38 / US-42 各补验收 | 需求基线 |
| `docs/architecture/principles.md` 第 5 节 | 补一句「变更视图唯一渲染方」 | 架构原则 |

## 宪章检查

- [x] 分层与依赖（`AGENTS.md` 第 1 节）：git 取数与 diff 组装在宿主（`electron/`），不把
      宿主 API 带进 `src/shared/` 或 core；core 不感知变更视图。`electron/gitFileContent.ts`
      不 import electron（与 `fileOpen.ts` / `sidebarDocView.ts` 同模式）。
- [x] 架构铁律（`AGENTS.md` 第 4 节）：不过度 fallback——git 失败显式错误态、非 git 工作区
      显式置灰，不做「读不到就当空文件」的静默降级；契约成员全必选（`OpenSource` 是
      判别联合，`initialView` 恒有值）；一份事实一个写入点（「是否新增」只有
      `hasHeadVersion` 一处判定，「取什么 repo」只有 `FileContentRunner`）；预览只有一份
      渲染实现（DiffEditor 在 Monaco 页面内，`showDiff` 仍是空实现）。
- [x] Core 行为与落盘格式同步义务（`AGENTS.md` 第 5 节）：不涉及——纯宿主侧改动，core 与
      `src/shared/history/` 零改动。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：第 4 节四份文档与 specs/041 同一提交；spec 收敛
      时 delta 并入 `docs/hosts/`。

## 被否决的替代方案

1. **webview 侧算 diff**：webview 拿不到 git（也不该拿），而且预览窗口是独立 BrowserWindow
   而不是 webview。否决，git 全在主进程。
2. **把工具卡片的 diff 下沉到宿主（实现 `ElectronUIHost.showDiff`）**：会让同一份 diff 有
   两个渲染方（spec 非目标 + 架构原则第 5 节）。否决，`showDiff` 保持空实现。
3. **打开时预取 diff（`monaco-init` 里带 before / after）**：每个打开动作都多跑一次
   `git show`，而多数会话不点变更。改为切换时按需拉（第 2 节）。
4. **Markdown 用「渲染 / 文本 / 变更」三态单选**：用户明确要求两组正交开关（能从 diff 切到
   渲染看效果、再切回文本仍是 diff）。三态单选做不到「渲染态记住变更取值」。否决。
5. **用 `git diff` 的输出解析出 diff 文本再自己画**：会引入第二份 diff 渲染实现，还与
   Monaco 的 `DiffEditor` 行为不一致（换行 / 空白 / 编码）。否决，取两侧原文交给
   `DiffEditor`。
6. **工作区级 diff 汇总**：spec 非目标，「全部变更」视图只是清单（双击进单文件变更视图）。

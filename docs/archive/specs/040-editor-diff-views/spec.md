---
status: 已收敛
---

# 改动规格：内置文本编辑器与 Markdown 预览的「变更」视图

Electron 的内置文本编辑器（Monaco 窗口）当前只有全文视图；Markdown 预览窗口只有
「渲染 / 文本」两态。这次给两侧都补上**变更视图**——相对 git HEAD 的 diff——并在
Markdown 预览窗口加一组独立的「全文 / 变更」开关（与既有「渲染 / 文本」并存），
按文件的变更状态决定打开时先落在哪个视图。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| `docs/hosts/electron-multi-workspace.md` | 9. 侧栏 | 修改 | 文件浏览器分区补「全部变更」视图（第三个模式）与两种打开策略 |
| `docs/hosts/host-matrix.md` | 6. 宿主固有差异 | 修改 | 查看器行补「变更视图」与打开时初始视图的选择口径；`showDiff` 仍是空实现（变更视图是查看器自己的能力，不是工具卡片的 diff 下沉） |
| `docs/features/user-stories/desktop.md` | US-38 文件与虚拟文档预览 / US-42 侧栏文件浏览器 | 修改 | 两条 US 各补验收标准（变更视图、打开策略） |
| `docs/architecture/principles.md` | 5. 预览只有一份渲染实现 | 修改 | 补一句：变更视图的唯一渲染方是查看器窗口内的 Monaco `DiffEditor`，webview 工具卡片的 diff 不受影响 |

## 用户场景与验收标准

- 场景 1：文本文件的变更视图
  - **AC-1**（FR-001）：GIVEN 工作在 git 仓库里且某文本文件相对 HEAD 有改动 WHEN 在内置文本编辑器里点「变更」 THEN 显示该文件相对 HEAD 的左右对比 diff，可切回「全文」
  - **AC-2**（FR-001）：GIVEN 文件相对 HEAD 没有改动 WHEN 点「变更」 THEN 显示「没有改动」空态而不是空白编辑器
- 场景 2：Markdown 的两组开关
  - **AC-3**（FR-002）：GIVEN 打开一个 Markdown 文件 WHEN 看标题栏 THEN 「全文 / 变更」开关在既有「渲染 / 文本」开关**左侧**，两组互不干扰
  - **AC-4**（FR-002）：GIVEN 停留在「变更」视图 WHEN 切到「渲染」 THEN 渲染视图不显示 diff（渲染态忽略变更开关），切回「文本」时变更开关的取值仍保留
- 场景 3：打开时的初始视图
  - **AC-5**（FR-003）：GIVEN 从文件树或「全部变更」视图打开**新增**文件（git 未跟踪 / 无 HEAD 版本） WHEN 查看器打开 THEN 优先显示全文视图（没有可对比的旧版本）
  - **AC-6**（FR-003）：GIVEN 从「变更」视图或工具卡片的变更链接打开**非新增**文件 WHEN 查看器打开 THEN 优先显示变更视图
  - **AC-7**（FR-003）：GIVEN 从文件树打开**非新增**文件 WHEN 查看器打开 THEN 优先显示全文视图
  - **AC-8**（FR-003）：GIVEN 打开的 Markdown 不是新增文件且入口是「变更」视图 WHEN 打开 THEN 先落在变更视图而不是渲染视图；反之入口是文件树时先落在渲染视图
- 场景 4：非 git 工作区
  - **AC-9**（FR-004）：GIVEN 工作区不在 git 仓库内 WHEN 点「变更」 THEN 提示「不在 git 仓库内，无法显示变更」而不是空白 diff

## 功能需求

### FR-001：文本编辑器的变更视图

内置文本编辑器窗口（`dist/monaco/index.html`）扩展为四态视图：`view`（全文，可编辑）、
`diff`（相对 HEAD 的只读对比）、`content`（虚拟文档只读全文）。标题栏加一个与 Markdown
预览同形态的切换按钮，在「全文 / 变更」之间切换。

diff 的原始侧取自 git：`git show HEAD:<path>`（无 HEAD 版本 = 空）。两侧都交给页面内
既有的 `monaco.editor.createDiffEditor`，`renderSideBySide: true`、`readOnly: true`——
渲染实现只有这一份（`docs/architecture/principles.md`）。

文件相对 HEAD 没有改动时显示「没有改动」空态；不在 git 仓库内时按钮置灰并说明原因。

### FR-002：Markdown 预览的两组开关

Markdown 预览窗口（`dist/monaco/markdown.html`）的标题栏放两组独立开关，从左到右：

1. 「全文 / 变更」——决定源文侧显示全文还是相对 HEAD 的 diff；
2. 「渲染 / 文本」——决定主区域显示渲染 HTML 还是编辑器。

「渲染」态不显示 diff（渲染视图是 HTML，没有行概念）；从「渲染」切到「文本」时沿用
「全文 / 变更」的当前取值。变更视图里的编辑器与文本视图共用同一个只读 Monaco 实例，
`viewState` 按视图分别保存（切来切去不丢滚动位置）。点「变更」时若当前在渲染视图，
先自动切到文本视图——diff 只渲染在文本档，留在渲染态会让用户以为「点了没反应」。

### FR-003：打开时的初始视图

打开请求新增 `initialView` 字段（`'full' | 'changes'`），由调用方按来源与文件状态决定：

| 来源 | 新增文件（未跟踪 / 无 HEAD 版本） | 非新增文件 |
| --- | --- | --- |
| 文件树双击 | 全文 | 全文 |
| 「全部变更」视图双击 | 全文 | 变更 |
| 工具卡片的变更链接 | 全文 | 变更 |

Markdown 在其上再叠一层：初始视图为「全文」时落在**渲染**视图，为「变更」时落在
**变更**视图（`selectedLines` 定位链接仍按既有口径落在文本视图）。

判定「新增」的口径是 git 未跟踪（`git ls-files --others`）或无 HEAD 版本
（`git cat-file -e HEAD:<path>` 失败）——与 `sidebarDocView.ts` 的 git 口径同源，不另写一份。

### FR-004：非 git 工作区

不在 git 仓库内时变更视图不可用：按钮置灰，提示「不在 git 仓库内，无法显示变更」。
远端工作区沿用同一接口（`GitCommandRunner` 的 SSH exec 实现），行为一致。

## 边界与错误路径

- git 命令失败（超时 / 非零退出）：变更视图显示错误文案与原因，不静默空态。
- 文件在查看器打开期间被改动：既有刷新链路（`specs/018`）照常工作，diff 的两侧都按新内容重取。
- 二进制文件：变更视图不适用（沿用既有「二进制交系统应用打开」的分流）。
- 超大文件：`git show` 的输出沿用既有的文本读取上限，超限时提示而不是把窗口卡住。

## 非目标

- 不做 hunk 级暂存 / 撤销（查看器只读）。
- 不把工具卡片的 diff 下沉到宿主（`ElectronUIHost.showDiff` 仍是空实现——工具卡片的
  diff 归 webview，见 `docs/architecture/principles.md`）。
- 不做工作区级 diff 汇总的 diff 视图（「全部变更」视图只是文件清单，双击进单文件变更视图）。
- 不做三方对比 / 分支间对比。

## 对需求基线的影响

修改 `docs/features/user-stories/desktop.md` 的 US-38（加变更视图与打开策略）与 US-42
（加「全部变更」视图入口）。e2e：`e2e/electron/preview.spec.ts` 补用例（文件树打开非新增
文件落全文、变更视图打开落 diff、md 两组开关互不干扰）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/monaco/main.ts` 的视图态与 `createDiffEditor`；`electron/ElectronUIHost.ts` 的 `openMonacoWindow` | `src/test/monacoDiff.test.ts`；e2e `e2e/electron/preview.spec.ts` | 自动 |
| FR-002 | `electron/monaco/markdownMain.ts` 的两组开关 | e2e `e2e/electron/preview.spec.ts` | 自动 |
| FR-003 | `electron/fileOpen.ts` 的 `initialView` 决策（纯函数） | `src/test/fileOpen.test.ts` | 自动 |
| FR-004 | `electron/sidebarDocView.ts` 的 `GitCommandRunner` 复用；查看器按钮置灰 | `src/test/sidebarDocView.test.ts` | 自动 |

## 待澄清

（无）

## 收敛记录

### 已满足

| 验收标准 | 证据落点 |
| --- | --- |
| AC-1（FR-001）文本编辑器点「变更」显示相对 HEAD 的左右对比、可切回「全文」 | `monaco/main.ts` 的 `toggleSourceView` / `initDiff`；e2e `specs/040 AC-1/FR-001`（`.monaco-diff-editor` 可见 → 切回后消失） |
| AC-2（FR-001）无改动时显示「没有改动」空态 | `monacoDiff.ts::buildDiffResult` 返回 `empty`；`monacoDiff.test.ts` 的空态用例；e2e `AC-2/FR-001` |
| AC-3（FR-002）「全文 / 变更」在「渲染 / 文本」左侧、两组互不干扰 | `markdownMain.ts` 的 `buildTitlebar` 顺序；e2e `AC-3/AC-4/FR-002` 逐字断言前三个按钮文案 |
| AC-4（FR-002）渲染态忽略变更开关，切回文本时取值保留 | `applyMode` 只在 `textMode` 下走 `showChangesView`；e2e 渲染 → 文本往返后 diff 直接出现 |
| AC-5（FR-003）新增文件优先全文 | `resolveInitialView(source, isNew)` 返回 `full`；`fileOpen.test.ts` 六组合 + 接线用例 |
| AC-6（FR-003）变更视图 / 工具链接打开非新增文件落变更 | 同上；`localGitFile` 判 `hasHeadVersion` |
| AC-7（FR-003）文件树打开非新增文件落全文 | `tree` → 恒 `full`；e2e `AC-5/AC-7/FR-003` |
| AC-8（FR-003）Markdown 非新增 + 变更入口先落变更视图 | `resolveInitialViewSource` 返回 `text` + `initialSourceMode: 'changes'` |
| AC-9（FR-004）非 git 工作区按钮置灰并提示 | `gitContext` 的 `inGit` 为假 → `diffSource: null` → `canDiff: false`；`fileOpen.test.ts` 的「不传 diffSource」用例；e2e `AC-9/FR-004` |

### 偏差（已就地修正或补进 spec）

1. **`FileContentRunner` 在 `electron/gitFileContent.ts`、由 `GitCommandRunner` 装配**，而不是 plan 里写的「三个方法直接挂在 `localFileContentRunner(root)` 上」——实际签名改为接收 runner，本地与远程共用同一实现（远程由 `main.ts` 传 `remoteGitRunner`）。与 plan 的「不新写 git 调用层」一致，签名差异已在 spec 的 FR-004 末句体现（复用同一 `GitCommandRunner`）。
2. **`canDiff` 的判据是 `diffSource !== null`**，而 `diffSource` 在 `fileOpen.ts` 里由 `gitContext` 的 `inGit` 决定。plan 写「`probeGitWorkspace` 结果塞进 `canDiff`」，实际等价：非 git → `inGit: false` → `diffSource: null`。spec FR-004 已写明这个链路。
3. **Markdown 的变更档强制切到文本视图**。plan 未写；点「变更」时若仍在渲染态，diff 容器会被 `article.hidden` 藏起来（用户看到「点了没反应」）。`showChangesView` 里补 `state.mode = 'text'`，spec FR-002 补一句。
4. **`monaco-request-diff` 的应答注册在两类窗口都做**。plan 只写 Monaco 窗口；Markdown 预览窗口同样需要（它的变更档也在页内渲染 diff），漏注册时表现为「点变更没反应」。spec FR-002 已写明「与 Monaco 窗口同一套 responder」。
5. **`updateToolStatus` 加了必选 `messageUuid: string | null`**（specs/039 的节点身份需要），属跨 spec 的契约增量，已在事件表登记。

### 未做

无。T001 ～ T008 全部完成；`monacoDiff.test.ts`（14）、`gitFileContent.test.ts`（13）、`fileOpen.test.ts`（35）与 e2e 5 条全绿。


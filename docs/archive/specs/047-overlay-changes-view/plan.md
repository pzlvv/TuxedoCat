# 实施方案：Overlay 对话的变更视图

技术路线一句话：变更清单与文件两侧原文都改由 **Core 在视图里跑 git** 得到，经两个新的
`UiRequest` 只读应答；宿主侧把「取数来源」做成判别联合（磁盘 / 视图），渲染层按活动对话
归属分流。需求与验收见 [spec.md](spec.md)。

## 技术方案

### 1. 为什么取数必须在 Core 里、而且要 bind 回工作区路径

宿主进程读不到 Core 私有挂载命名空间（specs/046 已定，[docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)）。git 又比「列目录」多一层要求：它要**从 cwd 向上找到 `.git`**，再按仓库口径算
「工作区相对路径」。

实测（`unshare -Urm` + overlay + `userxattr`）：

| 尝试 | 工作区 = 仓库根 | 工作区 = 仓库子目录 |
| --- | --- | --- |
| 直接在挂载点上跑 `git -C <mount>` | 失败：挂载点的父目录不在仓库里，`not a git repository` | 失败（同上） |
| 加 `GIT_DISCOVERY_ACROSS_FILESYSTEM=1` | 成功 | 失败 |
| `git --git-dir=<磁盘 .git> --work-tree=<mount>` | 成功 | 成功，但 `diff` 输出带仓库前缀，`ls-files --others` 不带——两种路径口径要靠调用方自己拼 |

第三行能跑但把「前缀拼接」变成第二份路径逻辑；而 Core 已经有一条现成的、正被 Bash 使用的
通路：**在子进程的私有挂载命名空间里把视图 bind 到真实工作区路径上，再 chdir 进那个路径**
（`work_view::bind_view_onto_workspace`，它会 bind 完重新 `set_current_dir`）。bind 之后
git 看到的是「真实工作区路径 + 视图内容」，向上找 `.git` 与磁盘同一套规则，路径也天然是
工作区相对。实测两种工作区形态都成功，且 `diff --numstat -M --relative` 与
`ls-files --others --exclude-standard` 的口径对齐。

因此 Core 侧取数的执行形态与 Bash 完全一致，只是 exec 的是 `git` 而不是 shell。

### 2. FR-005：取数不得写视图——临时索引

git 会在某些情况下重写 `.git/index`（stat 信息刷新）。视图里 `upper/.git/index` 一旦出现，
`upper/` 就多了一个用户从没改过的条目。实测：`--no-optional-locks` **不足以**避免（文件
mtime 陈旧时仍会 copy-up 出 `upper/.git`）。

做法：取数前把仓库索引复制到视图外的临时文件，用 `GIT_INDEX_FILE` 指过去，并显式关掉
`core.untrackedCache` / `core.fsmonitor`。实测后 `upper/` 只剩用户自己改过的文件。
HEAD 侧的读取用 `git show HEAD:./<rel>`（相对 cwd 的写法），不碰索引。

视图里的 HEAD 以视图为准：对话内自己 `git commit` 之后，变更清单随之清空而磁盘 HEAD 不变
（实测，spec 边界表最后一行）。

### 3. 两个新契约成员（`UiRequest`）

```ts 示意
// 变更清单：scope 与侧栏的 ChangeScope 同一判别值（doc / all）
| { type: 'workViewChangesRequested'; sessionId: string; scope: 'doc' | 'all' }

// 文件两侧原文：after 就是视图内容，before 为 HEAD 版本（null = 无 HEAD 版本）
| { type: 'workViewFileDiffRequested'; sessionId: string; path: string }
```

应答形态（判别联合，成员全必选）：

```ts 示意
export interface WorkViewChangeEntry {
  /** 工作区相对路径（'/' 分隔） */
  path: string;
  plus: number;
  minus: number;
}

export type WorkViewChangesResult =
  | { ok: true; entries: WorkViewChangeEntry[] }
  /** Core 报事实：该工作区不在 git 仓库内 / 取数失败；文案由界面决定 */
  | { ok: false; kind: 'not-a-git-workspace' | 'error'; error: string };

export type WorkViewFileDiffResult =
  | { ok: true; kind: 'not-a-git-workspace'; after: string }
  | { ok: true; kind: 'git'; before: string | null; after: string }
  | { ok: false; error: string };
```

`not-a-git-workspace` 作为**事实**而不是界面文案留在 Core，宿主侧转成既有的
`NOT_A_GIT_WORKSPACE` 判别值（`electron/sidebarFilesMode.ts`），渲染层文案不变
（[docs/architecture/principles.md 第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)：core 描述事实，UI 决定表现）。

### 4. 取代 `workViewFileReadRequested`

specs/046 的 `workViewFileReadRequested` 只返回视图内容；现在打开文件需要「内容 + 有没有
HEAD 版本」两件事一起判（FR-004 的「新增落全文」），而两者来自同一次 `git show` + 一次读
文件。保留两个请求会让打开路径发两次往返、且内容读两份。

因此 `workViewFileDiffRequested` **取代** `workViewFileReadRequested`（后者连同
`coreFacts.requestWorkViewFile`、`sidebar:files-open-overlay` 的读文本注入一起删除）。
非 git 工作区由 `kind: 'not-a-git-workspace'` 分支覆盖——它的 `after` 就是视图内容，
specs/046 FR-003 的行为不丢。

### 5. Core 侧模块划分

| 位置 | 职责 |
| --- | --- |
| `core-rs/src/work_view_changes.rs`（新增，由 `work_view_linux.rs` 以 `#[path]` 引入） | git 子进程编排（bind + chdir + 临时索引 + 超时）、`-z` 输出解析、无 HEAD 仓的行数口径 |
| `core-rs/src/work_view_linux.rs` | 新增 `changes(session_id, scope)` 与 `file_diff(session_id, path)`：取句柄、拼 `WorkViewGit { workspace, mount }`、转判别结果 |
| `core-rs/src/work_view_unsupported.rs` | 同签名占位，回「只在 Linux Core 上可用」 |
| `core-rs/src/work_view.rs` | 再导出两个函数与结果枚举 |
| `core-rs/src/main.rs` | `dispatch_ui_request` 两个分支；把 `spawn_balance_request` 泛化成「慢请求走独立线程」并把这两个请求加进去（git 在单线程帧循环里跑会卡住后续帧，与余额同型，见 `specs/defects/balance-fetch-blocks-frame-loop.md`） |
| `core-rs/fixtures/eventTypes.json` | `uiRequests` 补两个名字（Rust 侧双向锁定的唯一来源） |

`-z` 解析（实测输出形态）：

```text
<add>\t<del>\t<path>\0                     普通
<add>\t<del>\t\0<old>\0<new>\0             重命名（路径在第三段之后另起两项）
```

重命名取新名；纯重命名（0/0）与已删除文件不出现（`--diff-filter=d` + 0/0 过滤）；
二进制（`-\t-`）跳过——三条都与宿主侧既有 `parseNumstat` / `parseLsFiles` 同口径。

### 6. 宿主侧数据流

```text
侧栏「文档视图 / 全部变更」
  files.overlaySessionId === null → sidebar:files-doc-list（既有磁盘 git 路径，不变）
  files.overlaySessionId !== null → sidebar:files-doc-list-overlay
                                      → coreFacts.requestWorkViewChanges
                                      → UiRequest.workViewChangesRequested
                                      → 渲染行（buildDocRows 同一份组装）

查看器「变更」档
  diffSource = { kind: 'disk'; root; rel }      → 既有 git show + 读盘
  diffSource = { kind: 'overlay'; sessionId; rel } → coreFacts.requestWorkViewFileDiff
```

`DiffSource` 由 `{ root, rel }` 改成判别联合（`electron/fileOpen.ts`）：
「两侧原文从哪取」是两条不同的事实，不塞进可选字段（[docs/architecture/principles.md](../../docs/architecture/principles.md#2-不让接口--参数可选)）。`ElectronUIHost.registerDiffResponder` 按 `kind` 分流，其余（页面协议
`monaco-request-diff` / `buildDiffResult` 的空态判定 / 渲染实现）不变——FR-004 的最后一句
因此自然成立。

`openOverlayWorkspaceFile` 改为先发一次 `workViewFileDiffRequested`：`after` 作为查看器
内容、`before === null` 作为「新增」判据、`kind === 'git'` 作为 `canDiff`。三个事实来自同
一次请求，不重复读。

### 7. 渲染层

`WorkspaceFilesState` 已有 `overlaySessionId`；`loadDocList` 按它分流，`syncOverlaySession`
在归属变化时一并作废变更清单（`docGeneration += 1` / `docRequested = false`，文档模式立即
重取）——这是 AC-9。失效推送（`sidebar:files-invalidate`）无需改动：`loadDocList` 分流后
按当前来源重取（FR-003）。

### 8. 测试策略

| 层 | 用例 |
| --- | --- |
| 纯解析（不需要命名空间） | `-z` numstat（普通 / 重命名 / 二进制 / 含空格与中文名）、paths、行数口径 |
| 命名空间内（`in_namespace`，能力不可用时跳过） | 视图内改动 / 新建 / 仅 Bash 改动都进清单；取数后 `upper/` 无新增条目；`git show` 取到 HEAD 侧；非 git 工作区回 `not-a-git-workspace` |
| 请求分支（`main_tests`） | 缺参数报错、未挂载视图回判别失败、`dispatch_ui_request` 覆盖 |
| 宿主纯函数 | `fileOpen`：Overlay 的 `initialView` / `diffSource` 判别联合 / `canDiff` |
| 渲染层 | `loadDocList` 分流由 `sidebarDocView` 侧的纯函数 + 手工核对；e2e 车道豁免（要真实 overlay） |

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `WorkViewChangeEntry` / `WorkViewChangesResult` / `WorkViewFileDiffResult`；`UiRequest` 增 `workViewChangesRequested`、`workViewFileDiffRequested`，删 `workViewFileReadRequested`；`UiRequestResultMap` 增两项、删一项 |
| `src/host/coreFacts.ts` | 修改 | 增 `requestWorkViewChanges` / `requestWorkViewFileDiff`，删 `requestWorkViewFile` |
| `core-rs/src/work_view.rs` | 修改 | 再导出 `changes` / `file_diff` 与结果枚举 |
| `core-rs/src/work_view_changes.rs` | 新增 | 无（模块内） |
| `core-rs/src/work_view_linux.rs` | 修改 | 新增两个入口，改用临时索引取数 |
| `core-rs/src/work_view_unsupported.rs` | 修改 | 同签名占位 |
| `core-rs/src/main.rs` | 修改 | `dispatch_ui_request` 两分支；慢请求线程化 |
| `core-rs/fixtures/eventTypes.json` | 修改 | `uiRequests` 名单 |
| `electron/fileOpen.ts` | 修改 | `DiffSource` 判别联合；`openOverlayWorkspaceFile` 用 diff 请求 |
| `electron/ElectronUIHost.ts` | 修改 | `registerDiffResponder` 按 `kind` 分流 |
| `electron/main.ts` | 修改 | 新增 `sidebar:files-doc-list-overlay`；改写 `sidebar:files-open-overlay` 的读取注入 |
| `electron/sidebarPreload.ts` | 修改 | 增 `filesDocListOverlay` |
| `electron/sidebar/main.ts` | 修改 | `loadDocList` 分流；`syncOverlaySession` 作废变更清单 |
| `docs/core/conversation-work-view.md` | 修改 | 请求表（视图取数） |
| `docs/core/standalone-core.md` | 修改 | `UiRequest` 名单与数量 |
| `docs/core/standalone-core-boundaries.md` | 修改 | 宿主侧事实读取表 |
| `docs/architecture/events.md` | 修改 | 词汇汇总表数量 |
| `docs/hosts/electron-multi-workspace.md` | 修改 | 侧栏取数分流 |
| `docs/features/user-stories/desktop.md` | 修改 | US-63 / US-38 验收 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：git 取数在 `core-rs/`，不经总线发命令；宿主的
      `DiffSource` 判别联合只在 `electron/`（宿主实现层），`src/shared/` 只放契约与类型；
      新增请求的类型定义在 `src/shared/AssistantEventBus.ts`（共享叶子层），宿主与
      `coreFacts` 都只 import 它。不做 `host.kind` 嗅探——分流条件是数据（`kind` 字段 /
      `overlaySessionId`）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：不过度 fallback（视图未建立 / git 失败 / 非 git 一律
      回判别失败，宿主显示错误行，不回退磁盘清单）；契约成员全必选（三个结果类型都是判别
      联合，`before: string | null` 用 `null` 表达「无 HEAD 版本」）；一份事实一个写入点
      （变更行的组装仍是 `buildDocRows`；空态判定仍是 `monacoDiff.buildDiffResult`；
      「不在 git 仓库内」的文案仍只在 `sidebarFilesMode.ts`）；默认值单源（无新增默认值）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：改动只在 `core-rs/`（本仓库唯一的
      Core 实现）；不触碰 `src/shared/history/` 与 `core-rs/src/history*` 的落盘格式；
      `eventTypes.json` 双向锁定与 `src/shared/AssistantEventBus.ts` 同步。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：上表六篇文档同一提交内跟进；`npm run test:unit -- docs-lint` 必须绿（事件数量、成员名单、`UiRequest` 载荷列、US ↔ e2e 映射）。

## 被否决的替代方案

| 方案 | 否决理由 |
| --- | --- |
| 宿主直接读 `upper/` + 磁盘基线拼出清单 | whiteout 让删掉的文件仍可见、未改动的文件在 `lowerdir` 看不到（specs/046 已实测），拼出来的树是错的 |
| `nsenter` 进 Core 的命名空间跑 git | 要 Core 暴露 PID + 提权；每次取数起一个进程；SSH 远端完全不可行 |
| Core 里用 `--git-dir` + `--work-tree` 指向挂载点（不 bind） | 实测两种路径口径不一致（`diff` 带仓库前缀、`ls-files --others` 不带），要么在 Core 里复制一份前缀拼接逻辑，要么命令之间互相矛盾 |
| 用 Core 维护的会话级改动清单（工具成功即记路径）代替 git | 覆盖不了 Bash 产生的改动（FR-001 明确要求），且与 US-63 的 git 口径（行数 / 未跟踪）分叉 |
| 取数照旧写 `.git/index`，只在 UI 上过滤 `.git` | `upper/.git/index` 仍是对话私有层里的真实条目，对话内的 `git status` 会看到它；FR-005 要求取数不写视图 |
| 保留 `workViewFileReadRequested` 再加一个「有没有 HEAD 版本」的请求 | 打开路径要多一次往返、内容读两份；「内容 + HEAD 侧」本来就是同一次 `git show` + 一次读文件的事实对 |
| 让 `ElectronUIHost.showDiff` 承接工具卡片 diff | 架构原则第 5 节：预览只有一份渲染实现，工具卡片的 diff 归 webview（本规格非目标） |

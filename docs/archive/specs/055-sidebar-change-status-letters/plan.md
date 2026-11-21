# 实施方案：变更视图用状态字母标记文件

技术路线：把「一条变更条目的状态」当成 git 事实，在**取数层**（宿主 `sidebarDocView.ts`
与 Core `work_view_changes.rs`）判定并随条目回传，渲染层只做映射——`A` / `M` / `R` 字母、
重命名行的前后名字、行尾徽标的有无都在 `electron/sidebar/main.ts` 一处决定。需求与验收见
同目录 [spec.md](spec.md)。

## 技术方案

### 1. 状态从哪来（两份取数同源）

两侧都已有「与 HEAD 的 numstat diff」这一条事实，但它只给行数，分不出 `A` / `M` / `R`。
因此两侧各**补一条 `--name-status` 事实**，按新路径与 numstat 对齐：

| 侧 | 现有事实 | 新增事实 | 对齐键 |
| --- | --- | --- | --- |
| 宿主（磁盘 / 远程） | `git diff --numstat -M --relative --diff-filter=d HEAD -- <pathspec>` | `git diff --name-status -z -M --relative --diff-filter=d HEAD -- <pathspec>` | 新路径 |
| Core（Overlay 视图） | 同上（`Runner::git`） | 同上 | 新路径 |

宿主的这条新事实**拼进既有的 `buildChangeCommands` 批处理**（`runBatch` 一次往返），
因此远程工作区的往返次数不变——这是 `specs/defects/remote-change-list-n-plus-one-round-trips.md`
锁定的不变量，加命令不能加往返。

Core 侧在 `GitView::entries_against_head` 里多一次 `self.git(...)`（同进程内经由挂载代理
spawn，不是网络往返），与 numstat 结果按新路径合并。

### 2. 状态的判定口径（两侧同一份规则）

```
A  未跟踪（ls-files --others，遵循 .gitignore）              → A, oldPath = null
A  name-status 给 A（HEAD 里没有该路径：新文件 / 已暂存新文件 / 无 HEAD 新仓索引内）→ A
M  name-status 给 M（含已暂存）                               → M
R  name-status 给 R<score>（-M 检测出重命名）                 → R, oldPath = 旧路径
```

三条落地约束：

1. **`R` 不再被 0/0 丢掉**：`parseNumstat` / `parse_numstat_z` 原本把 `0 0` 一律丢弃（纯重命名
   与仅位置变更）。改为「`0 0` **且** name-status 不是 `R` 才丢」——纯重命名保留为 `R` 行，
   仅改文件模式（`0 0` + `M`）仍不出现，维持既有观测行为。
2. **`A` 与查看器的「新增」判据同源**：都是「该路径在 HEAD 里没有版本」。查看器用
   `git cat-file -e HEAD:<rel>`（`electron/gitFileContent.ts` 的 `hasHeadVersion`），取数层用
   `--name-status` 的 `A`——两者是同一个 git 事实的两种问法，不各写一套跟踪状态判定。
3. **跨类型重命名在 `doc` scope 下自然呈现 `A`**：pathspec 让 git 只看到新一侧，`--name-status`
   就回 `A`。不为字母一致去改 pathspec（spec 边界第 1 条）。

### 3. 数据形态

条目与渲染行都加两个**必选**成员（不写 `?`，缺失语义用 `null`）：

```ts 示意
// electron/sidebarDocView.ts
export type ChangeStatus = 'A' | 'M' | 'R';
export interface DocEntry {
  path: string;
  plus: number | null;
  minus: number | null;
  status: ChangeStatus | null;   // null = 记录口径（非 git，没有状态事实）
  oldPath: string | null;        // 仅 status === 'R' 有值
}

// src/shared/AssistantEventBus.ts（Overlay 契约）
export interface WorkViewChangeEntry {
  path: string;
  plus: number;
  minus: number;
  status: ChangeStatus;          // Core 只在 git 口径列条目，故不需要 null
  oldPath: string | null;
}
```

`DocRow`（主进程铺平后的渲染行）同样带 `status` / `oldPath`：`electron/main.ts` 的
`buildDocRows` 透传，`DocViewRow` 的判别值跟着扩。

### 4. 渲染（`electron/sidebar/main.ts` 一处决定）

- 文件行且 `status !== null`：行首渲染 `<span class="file-icon doc-status doc-status-a|m|r">A|M|R</span>`
  ——复用 `.file-icon` 的 14px 槽位，三段切换时列宽不跳（AC-8）。
- 目录行 / 记录口径行：仍走 `fileIconFor()` 的类型图标。
- `R` 行文件名显示 `旧名 → 新名`：旧路径与新路径的父目录相同时取旧文件名，不同时取旧路径；
  行的 `title` 给完整的前后工作区相对路径（AC-5）。
- `R` 行不渲染 `.doc-count`（`A` / `M` 行照旧）；行内行数事实仍随条目回传，只是不显示。
- 配色：深色 `A #4ade80` / `M #d4a05e`（与 `+N` 绿 / 行尾红同一套色板）/ `R #a78bfa`；
  浅色主题各给一档低饱和前景色，与既有 `.ficon-*` 的浅色块并列。

### 5. 不改的部分

`openFileRow` 的打开来源判定完全不动：`source` 仍由模式（`changes` / 其它）决定，查看器的
`initialView` 仍按「该路径有没有 HEAD 版本」判——`R` 行不是新增，落变更视图（AC-9）。
记录口径分支继续用类型图标（FR-005）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/sidebarDocView.ts` | 修改 | `DocEntry` 加 `status` / `oldPath`；`DocRow` 加同名成员；新增 `parseNameStatus`、`ChangeStatus`；`buildChangeCommands` 增一条 `--name-status` 事实；`parseNumstat` 的 0/0 规则改为「非 R 才丢」 |
| `electron/main.ts` | 修改 | 两个 `sidebar:files-doc-list*` 组装点透传 `status` / `oldPath`；Overlay 条目映射 |
| `electron/sidebar/main.ts` | 修改 | `DocViewRow` 加成员；`docRowHtml` 渲染字母 / 重命名名字 / 徽标取舍 |
| `electron/sidebar/styles.css` | 修改 | 新增 `.doc-status` 与三个配色 class（深浅色各一档） |
| `src/shared/AssistantEventBus.ts` | 修改 | `WorkViewChangeEntry` 加 `status`、`oldPath`（`UiRequest.workViewChangesRequested` 的应答载荷） |
| `core-rs/src/work_view_changes.rs` | 修改 | `ChangeEntry` 加 `status` / `old_path`；新增 `ChangeStatus`、`parse_name_status_z`；`entries_against_head` 增一次 `--name-status` 取数；`entries_without_head` / 未跟踪一律 `A` |
| `core-rs/src/main.rs` | 修改 | `workViewChangesRequested` 的条目序列化补 `status` / `oldPath` |
| `src/test/sidebarDocView.test.ts` | 修改 | `parseNameStatus` 单测、0/0 新规则、状态合并、`buildDocRows` 透传 |
| `src/test/sidebarDocViewGit.test.ts` | 修改 | 真实仓：未跟踪 / 已暂存新文件 / 修改 / 重命名（含纯重命名）的状态 |
| `core-rs/src/work_view_changes_tests.rs` | 修改 | `parse_name_status_z` 用例、0/0 保留为 R |
| `core-rs/src/main_tests.rs` | 修改 | 条目 JSON 含 `status` / `oldPath` 两字段 |
| `e2e/electron/fileExplorer.spec.ts` | 修改 | AC-1 / AC-3 / AC-4 / AC-5 / AC-6 / AC-8 / AC-9 七个用例 |
| `e2e/electron/remoteChangeList.spec.ts` | 修改 | AC-7（Overlay / 远端口径字母） |
| `docs/features/user-stories/desktop.md` | 修改 | US-63 验收标准 |
| `docs/hosts/electron-multi-workspace.md` | 修改 | [第 9 节 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) |
| `docs/hosts/host-matrix.md` | 修改 | [第 6 节「侧栏文件浏览器」](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) 行 |
| `docs/core/conversation-work-view.md` | 修改 | [第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)请求 / 应答表 |
| `docs/core/standalone-core-boundaries.md` | 修改 | [第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)变更清单行 |

契约影响只有一处：`UiRequest.workViewChangesRequested` 的应答条目加两个**必选**字段。
不新增事件 / 请求 / 面板 / 宿主，`docs/architecture/events.md` 的事件表不动（该请求的载荷
表记的是请求侧字段，条目形态记在 [conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`status` / `oldPath` 的判定在取数层（`electron/` 与
      `core-rs/`），渲染层只映射；契约类型仍只在 `src/shared/AssistantEventBus.ts` 定义，
      `src/shared/` 不 import 宿主实现、不 import 宿主 API；`core-rs` 不经 TS 侧取状态
      （自己在视图里跑 git）；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      - 不过度 fallback——`--name-status` 命令失败按既有错误态上抛（`git diff 失败`），
        不静默把状态降级成 `M`；
      - 契约成员全必选——`WorkViewChangeEntry.status` / `oldPath` 都是必选，`oldPath` 的
        「没有」用 `null`；`DocEntry.status` 用 `null` 表达「记录口径没有这个事实」；
      - 一份事实一个写入点——状态只由取数层写，渲染层不反推（不从 `plus > 0` 猜 `A`）；
      - 默认值单源——字母与配色只在 `styles.css` 一处定义。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 行为改动落在
      `core-rs/src/work_view_changes.rs`（取数与解析）与 `core-rs/src/main.rs`（序列化），
      两侧行为由 `work_view_changes_tests.rs`（纯解析）与 TS 侧 `sidebarDocView.test.ts` /
      `sidebarDocViewGit.test.ts` 各自锁定；`src/shared/history/` 与 core-rs 共用的落盘格式
      **不涉及**——本次只改 `UiRequest` 的应答载荷，不落盘。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格五处（见 spec「影响基线」），与代码同一
      提交落地；`npm run test:unit -- docs-lint` 作为独立任务，绿了才归档。

## 被否决的替代方案

1. **用 `git status --porcelain` 判状态**：`--porcelain` 给两列（索引 / 工作区）状态，与
   「相对 HEAD 的一条改动」不是同一维度（同一个文件可能 `AM`），而且它不带行数，得再配一次
   diff——等于把现在的一次批处理拆成两次事实源，且要自己合并两列。否决。
2. **从 `+N` / `-M` 反推状态**（`minus === 0 && plus === 文件行数` 即新增）：这正是 spec
   FR-002 明确禁止的做法——一个原有 1 行改成 3 行的文件是 `+3/-1`，一个 2 行新文件是
   `+2/-0`，用行数反推必然把「删空重写」误判成 `A`，而且永远表达不出重命名。否决。
3. **`git diff --raw --numstat` 一次拿两样**：实测 `--raw` 与 `--numstat` 同时给时 git 只输出
   `--raw`（numstat 被吞），拿不到行数。否决。
4. **重命名行拆成两行**（旧路径一条删除、新路径一条新增）：会与「增删行数」语义打架
   （旧路径那条本该是 `D`，而 spec 明确不引入 `D`），且用户在变更视图里看到的两行是同一个
   文件。改为一行 `旧名 → 新名`。
5. **在 Core 侧只回 `status`、`oldPath` 让宿主自己 `git show` 补**：宿主看不到 Overlay 视图
   里的 git（[docs/core/conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)的前提），补不出来。否决。
6. **`doc` scope 下为了把重命名显示成 `R` 而放宽 pathspec**：会让「文档」段列出非 Markdown
   的旧路径，破坏该段「只看 Markdown」的既有验收标准。按 spec 边界第 1 条保留 `A`。

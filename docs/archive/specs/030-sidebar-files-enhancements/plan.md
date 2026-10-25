# 实施方案：侧栏文件浏览器增强（新建自动刷新 / 悬停修改时间 / 文档视图）

技术路线一句话：刷新触发复用 `toolResult` 总线事件照 `workspaceFileChanged` 先例转发宿主
（`UIHost` 新增一个成员，不新增总线事件、不动 wire 消息）；修改时间走既有
`DirectoryEntry` 契约加一个必选字段；文档视图是主进程新 IPC 频道（本地 spawn git /
远程 `sshClient.exec`）+ 渲染层新视图态；非 git 记录由 core 在工具成功后写
`workspace.meta.json`、宿主经 `src/shared/` 只读库读取。需求与验收见同目录
[spec.md](spec.md)。

## 技术方案

### 1. 自动刷新链（FR-001 / FR-003 的刷新部分）

```
core 执行工具（engine.rs emit_tool_outcome → toolResult 事件）
  → Connection 总线 → WebViewUI 映射表（toolResult handler）
  → 新增宿主转发 this.host.onToolResult(e)        ← 照 workspaceFileChanged 先例
  → ElectronUIHost.onToolResult：解析 + 定位工作区
  → webContents.send('sidebar:files-invalidate', { workspaceId, reasons })
  → 侧栏渲染层按 reasons 刷新（树重读 / 文档视图重取，与手动刷新同口径）
```

- **宿主转发**：`src/host/WebViewUI.ts` 的 `buildCoreEventHandlers` 中 `toolResult`
  分支追加 `this.host.onToolResult(e)`（注释口径与 `workspaceFileChanged` 相同：
  「宿主事实，不投递 webview」）。`UIHost` 接口新增成员
  `onToolResult(event: Extract<CoreEvent, { type: 'toolResult' }>): void`
  （`src/host/UIHost.ts`，签名照 `onWorkspaceFileChanged`）。
- **ElectronUIHost 解析**（`electron/ElectronUIHost.ts`）：仅处理
  `status === 'success'` 且 `Write` 首行匹配 `Created file: <path>` 的结果 → 树刷新
  （前缀已被 `core-rs/src/tools_tests.rs` L1641-1666 锁定，实施时补断言防漂移）。
  文档视图不经此链——其自动刷新统一走哨兵监听（见下一条）。
- **路径定位**：载荷只有 `sessionId`（无工作区）。相对路径按
  `sessionWorkspaces` 索引（`electron/main.ts` `syncSessionWorkspaceIndex`）解析出
  会话工作区根后展开；绝对路径在打开集合内做包含判定（本地
  `resolveWithinRoot`、远程按根路径前缀 + 分隔符）。索引查不到或不含任何打开
  工作区 → no-op（跨工作区代理的占位会话无根，属设计允许的 no-op，注释说明）。
- **推送**：`ElectronUIHost` 经构造注入的回调（照 `viewerWatch` 注入先例）把
  `{ workspaceId: refKey(w), reasons: ['tree' | 'doc'] }` 发给侧栏 WebContentsView。
  `webContents.send` 推送频道不在 `ipcChannels.test.ts` 扫描范围，频道名字符串
  两侧字面量一致即可。
- **渲染层消费**（`electron/sidebar/main.ts`）：新增
  `refreshWorkspaceFiles(id)`——把现有 `refreshFiles()` 的代次 +1 / 清缓存 / 重读
  根与已展开目录抽成按 id 工作（在途回包静默入缓存的既有语义已支持后台工作区，
  L1150-1176）；`reasons` 含 `tree` 时调它，含 `doc` 且该工作区文档视图开启时重取
  文档数据。
- **git 哨兵监听（会话外 commit / stage 感知）**：文档视图开启期间，本地对
  `<root>/.git` 与 `<root>/.git/refs/heads` 两个目录挂非递归 `fs.watch`（commit /
  stage / checkout 都是写临时文件 + rename，目录监听可靠捕获；直接 watch 单个文件
  会因文件被 rename 替换而丢后续事件），新文件 `electron/sidebarDocWatch.ts` 负责
  去抖合并与生命周期，触发时走同一条 `sidebar:files-invalidate`（`doc`）——这是文档
  视图自动刷新的**唯一**触发源：会话内工具执行的 commit / stage 同样触达哨兵，无需再
  从 `toolResult` 观察。远程复用
  specs/018 的 `watchWorkspaceFile` / `unwatchWorkspaceFile` UiRequest（哨兵 watchId
  用侧栏前缀），`ElectronUIHost.onWorkspaceFileChanged` 先查查看器路由、未命中查
  哨兵注册表，同去抖。生命周期：渲染层开关经新增 send 频道
  `sidebar:files-doc-watch` 启停，工作区关闭由主进程统一摘除。监听只优化刷新时机、
  不是事实来源，建立失败记日志不阻断按需取数。

### 2. 修改时间（FR-002）

- **契约**：`DirectoryEntry`（`src/host/standalone/sshClient.ts`）加必选字段
  `mtimeMs: number | null`（取不到用 `null`，不用可选成员——铁律 4.2）。本地与远程
  是同一份契约（`electron/sidebarFiles.ts` 的 re-export 注释口径不变）。
- **本地**（`electron/sidebarFiles.ts` `listDirectory`）：`readdir withFileTypes` 后
  对每个条目 `stat`（符号链接跟随、断链跳过——与现状一致），取 `mtimeMs`。
- **远程**（`src/host/standalone/sshClient.ts` `listDirectory`）：readdir 回调的
  `FileEntryWithStats.attrs` 已含 mtime（秒），透传 `attrs.mtime * 1000`，当前在
  L306/L309 被丢弃处保留。
- **渲染层**：`fileRowHtml` 的 `title` 在相对路径后追加换行 +
  `YYYY/MM/DD HH:mm`（24 小时制），用 `new Date(mtimeMs)` 的本地 getter 格式化——
  渲染层就跑在宿主机上，本地时区即 Host 系统时区，本地与远程条目同一绝对时刻同一
  呈现。`mtimeMs === null` 时只显示相对路径（不猜值）。

### 3. 文档视图（FR-003 / FR-004 的展示部分）

- **IPC**：新增 `ipcMain.handle('sidebar:files-doc-list')` + preload
  `filesDocList(workspaceId)`（invoke 频道自动受 `ipcChannels.test.ts` 配对校验，
  两侧字符串字面量）。回执判别联合：

  ```ts
  type DocListResult =
    | { ok: true; mode: 'git' | 'record'; entries: Array<{ path: string; plus: number | null; minus: number | null }> }
    | { ok: false; error: string };
  ```

  `plus` / `minus` 仅 git 口径为数字，记录口径为 `null`（渲染层不显示行数）。
  `path` 为工作区根相对路径（'/' 分隔）。
- **git 探测与统计**（新文件 `electron/sidebarDocView.ts`，纯逻辑 + 执行器分离，
  便于单测）：
  - 探测：本地 spawn `git -C <root> rev-parse --is-inside-work-tree`；远程
    `sshClient.exec`（同一命令，posix 单引号转义 root）。退出码「不在仓内」→ 记录
    口径；git 缺失 / 超时 / 其它失败 → `{ ok: false, error }`（显式错误态，不降级）。
  - git 口径行数：`git -C <root> diff --numstat -M HEAD -- '*.md' '*.markdown'`
    （含已暂存 + 未暂存；`-M` 让纯重命名呈现为 `0 0`）；跳过 `0/0` 与二进制
    （`-` 计数）行；删除的文件经存在性过滤剔除。
  - 无 HEAD 的新仓：`git rev-parse --verify -q HEAD` 失败时改用
    `git ls-files -- '*.md' '*.markdown'`（索引内全部按新增计全文行数）。
  - 未跟踪：`git -C <root> ls-files --others --exclude-standard -- '*.md' '*.markdown'`
    列出后逐个读内容计行数（本地 fs 读 / 远程 SFTP 读），`+行数/-0`。
- **记录口径**（非 git）：本地经新读库 `src/shared/workspaceMeta.ts` 读取
  `<conversations>/<编码目录>/workspace.meta.json` 的 `modifiedDocs`（相对路径数组，
  见第 4 节）；远程用 `client.homeDir()` + `CONFIG_DIR_NAME` 推远端配置目录，SFTP 读
  同一路径（编码函数从 `src/shared/history/Config.ts` 抽出纯函数复用，含超长哈希
  分支同口径）。损坏 / 读不出 → `{ ok: false, error }`。
- **条目统一后处理**：存在性过滤（本地 `stat` / 远程 SFTP `stat`，剔除已删除）。
- **渲染层**：`WorkspaceFilesState` 增加 `docView`（localStorage 键
  `tuxedo.sidebar.filesDocView`，按工作区记忆，与折叠态同口径）、
  `docListing: { state: 'loading' | 'loaded' | 'error'; entries?; error? }`。
  分区条 `#filesRefresh` 旁加 `#filesDocToggle`（开关态 class + `aria-pressed`）。
  开启时由扁平 `entries` 建目录树（只保留命中文档的路径分支，排序复用
  `sortSidebarEntries` 口径），**全部层级默认展开**（展开集从命中路径推导，独立于
  `expandedDirs`，切回普通树时原展开状态原样恢复）；行尾 `+N / -M` 徽标（git 口径，
  新增绿 / 删减红）。行复用 `fileRowHtml`（带 `data-path` / `data-kind`），选中 /
  右键 / 双击打开经既有事件委托自动继承；删除后除 `refreshFiles()` 外补一次文档数据
  重取。空态提示行与错误行（点击重试）与文件树同款式。
  数据重取时机：开关开启、手动刷新（文档视图开启时 `refreshFiles` 顺带重取）、
  `sidebar:files-invalidate` 的 `doc` reason。

### 4. 非 git 记录写入（FR-004，core 侧）

- **挂点**：`core-rs/src/tools.rs` `run_write` / `run_edit` 成功分支（有绝对
  `path`、`ctx.session_id`、`ctx.cwd` 即会话工作区根），调用新函数
  `config::record_md_modification(root: &str, abs_path: &str)`。
- **判定**：扩展名 `.md` / `.markdown`；`abs_path` 在 `root` 内（前后都已绝对化，
  前缀 + 分隔符判定）；`root` 非 git 仓——`git rev-parse --is-inside-work-tree`
  spawn（照 `prompt.rs` `git_description` 的 `hide_console` / `shell_env` / 进程级
  `Mutex<HashMap>` 缓存写法，失败结果同样入缓存）。任一不满足 → 直接返回（no-op，
  语义即「不记录」，注释说明）。
- **落盘**：`ensure_project_conversation_dir(root)` 后读-合并-原子写该目录的
  `workspace.meta.json`：`workspacePath` 字段不动，新增
  `"modifiedDocs": ["a/b.md", ...]`（posix 分隔、去重、按字典序稳定输出）。写安全
  （铁律 9 / spec 边界）：同目录锁文件独占创建 + 持锁重读合并 + 临时文件
  `rename` 原子替换 + 内容未变不落盘 + 读不出 / 解析失败报错拒绝写（不覆盖）；
  进程内 `Mutex` 串行（并行工具线程 L2803-2826 下的并发安全）。
- **宿主只读库**：`src/shared/workspaceMeta.ts`——`readModifiedDocs(projectPath)`：
  复用 `src/shared/history/Config.ts` 的目录推导（抽纯编码函数），读文件、校验
  `modifiedDocs` 为字符串数组，损坏抛错（调用方转错误态）。只此一个入口，不写盘。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/UIHost.ts` | UIHost 接口新增 `onToolResult` 成员 | 宿主契约 +1 成员（照 `onWorkspaceFileChanged` 形态；docsLint 成员数对照同步） |
| `src/host/WebViewUI.ts` | `buildCoreEventHandlers` 的 `toolResult` 分支追加宿主转发 | 总线事件、wire 消息无变化 |
| `electron/ElectronUIHost.ts` | 实现 `onToolResult`（仅 Write 新建前缀解析 + 工作区定位 + 注入回调推送）；`onWorkspaceFileChanged` 增加哨兵事件分流（先查看器路由、未命中查哨兵注册表） | 无 |
| VS Code 宿主 `VSCodeUIHost.ts` | 实现 `onToolResult` 为 no-op（该宿主无侧栏消费方，注释理由——照 `onWorkspaceFileChanged` no-op 先例） | 无 |
| `electron/main.ts` | `sidebar:files-doc-list` handler、`sidebar:files-invalidate` 推送、`sidebar:files-doc-watch` 启停（ipcMain.on）、`ElectronUIHost` 回调注入、工作区关闭时哨兵监听统一摘除 | Electron 私有 IPC +3 频道（1 invoke + 1 on + 1 推送） |
| `electron/sidebarDocView.ts` | 新增：git 探测 / numstat 与 ls-files 解析、未跟踪计行、记录口径组装、存在性过滤（纯逻辑与执行器分离） | 无 |
| `electron/sidebarDocWatch.ts` | 新增：本地 git 哨兵监听（`.git` 与 `.git/refs/heads` 目录 fs.watch、去抖合并、生命周期）、哨兵注册表与远程 `watchWorkspaceFile` 复用 | 无 |
| `electron/sidebarFiles.ts` | `listDirectory` 补 `stat` 取 `mtimeMs` | `DirectoryEntry` 形状变化（透传） |
| `electron/sidebarFilesRemote.ts` | 远端 attrs mtime 透传；文档视图远端读取复用 `sharedClientFor` 连接池 | 无 |
| `src/host/standalone/sshClient.ts` | `DirectoryEntry` 加 `mtimeMs: number \| null`；`listDirectory` 透传 `attrs.mtime * 1000` | `DirectoryEntry` +1 必选字段（null 语义） |
| `src/shared/workspaceMeta.ts` | 新增：`workspace.meta.json` 宿主侧只读库 | 落盘格式双侧一致的 TS 侧入口 |
| `src/shared/history/Config.ts` | 抽出纯编码函数供本地 / 远端路径推导共用 | 无（行为不变） |
| `electron/sidebar/main.ts` | 文档视图状态与渲染、`#filesDocToggle`、悬停 title、`refreshWorkspaceFiles(id)`、`onFilesInvalidated` 订阅、删除后文档重取、开关时启停哨兵监听 | 无 |
| `electron/sidebar/index.html` + `styles.css` | `#filesDocToggle` 按钮、`doc-count` 徽标样式 | 无 |
| `electron/sidebarPreload.ts` | `filesDocList` / `onFilesInvalidated` / `filesDocWatch` | sidebarAPI +3 方法 |
| `core-rs/src/tools.rs` | `run_write` / `run_edit` 成功分支调 `record_md_modification` | 工具输出文本不变（前缀已有测试锁定） |
| `core-rs/src/config.rs` | 新增 `record_md_modification`（md 判定 / 包含判定 / git 缓存探测 / 锁 + 原子写） | `workspace.meta.json` +`modifiedDocs` 字段 |
| 测试 | `core-rs/src/tools_tests.rs`、`config_tests.rs` 扩展；新增 `src/test/sidebarDocView.test.ts`、`src/test/sidebarDocWatch.test.ts`、`src/test/workspaceMeta.test.ts`；`src/test/sidebarFiles.test.ts`、`ipcChannels.test.ts` 扩展；`e2e/electron/fileExplorer.spec.ts` 新增用例 | 无 |
| 文档 | `docs/hosts/electron-multi-workspace.md` §9 / §14.1、`docs/architecture/contracts.md`（UIHost 成员 + meta 字段 + 读库）、`core-ui-separation.md` §4.1、`repo-map.md`、`events.md` §2.1 `toolResult` 行处理方说明、`user-stories/desktop.md` EP-12、`user-stories.md` 附录 | 见 spec 影响基线 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../../AGENTS.md#1-分层与依赖评审必查)）：`src/shared/workspaceMeta.ts` 只依赖 node
      内建与 `src/shared/` / `src/config/`（配置目录常量既有依赖面）；`src/host/`
      不 import 宿主 API（`onToolResult` 只是接口成员）；`electron/sidebarDocView.ts`
      被 electron 持有、不反向进入 `src/`；无宿主嗅探（差异经 `WorkspaceRef.endpoint`
      判别，非 `host.kind`）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：git 失败显式错误态、不降级到记录口径（不过度
      fallback；VS Code 的 no-op 属「该宿主无消费方」的设计允许 no-op，带注释）；
      `DirectoryEntry.mtimeMs` 与 `DocListResult.plus/minus` 全必选、缺失语义用
      `null`（铁律 4.2）；记录唯一写入方是 core、宿主只读（一份事实一个写入点）；
      无新增配置默认值；渲染层 loading 转圈 / error 显式，不猜值。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 1 节](../../../AGENTS.md#1-分层与依赖评审必查)第 9 条、[第 5 节](../../../AGENTS.md#5-工作流)）：Core 改动
      全在 `core-rs/` 并带 Rust 测试；`workspace.meta.json` 变更双侧同步——Rust 写
      侧测试锁定字段与行为，TS 读库测试锁定同一形状（对照表口径），`npm run test:core`
      与 `npm run test:all` 都过。仅 standalone Core 一套实现，无第二侧 Core 需要
      parity。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../../AGENTS.md#0-文档要求)）：实施同批更新上表文档清单；`UIHost` 成员数、
      IPC 频道、`DirectoryEntry` 字段、事件表 `toolResult` 行说明均挂 docsLint 对照，
      `npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

- **新增 CoreEvent（如 `workspaceFilesChanged`）由 core 推送刷新**：刷新是宿主本地
  事实（侧栏不经总线，`electron-multi-workspace.md` §9 既有口径），`toolResult`
  载荷已携带所需全部信息；新事件扩大总线契约面，违背 spec「不新增总线事件」。
- **给 `CoreEvent.toolResult` 载荷加结构化 `fileEffects` 字段**：要动四组联合类型、
  events.md 载荷列与双侧测试；输出前缀（`Created file:` / `Updated file:` /
  `Edited file:`）已被 `tools_tests.rs` 全量断言锁定，解析成本低于契约扩张。
- **在 `ToolHandler`（webview 呈现链路）里解析并旁路通知**：ToolHandler 服务对话
  webview 的工具卡片；侧栏是宿主本地 UI，经 `UIHost` 宿主转发（`workspaceFileChanged`
  先例）才是正确的语义归属。
- **记录文件放在用户工作区根（用户目录里的 workspace.meta.json）**：污染用户项目、
  与既有 core 数据归属（contracts.md「归 core，不在宿主」）冲突；复用 core 数据目录
  每工作区一份的既有文件，归属不变、格式演进有双侧测试车道。
- **工作区级全量文件 watcher（外部文件改动也自动刷新）**：仍然不做——监听面大、事件
  噪声高；仅监听 git 哨兵目录（`.git` 与 `.git/refs/heads`）即覆盖会话外 commit /
  stage 的感知，非 git 工作区维持零监听。
- **监听单个哨兵文件（对 `.git/HEAD` / `.git/index` 的文件句柄 watch）**：git 以
  rename 替换这些文件，直接 watch 文件会因句柄指向旧文件丢后续事件；改为监听所在
  目录。
- **文档视图从 `toolResult` 事件触发（Edit / Write / Bash 观察）**：git 哨兵监听已
  覆盖全部 git 状态变化——会话内工具执行的 commit / stage 同样触达哨兵；工具改工作区
  文件不触 `.git` 的场景按手动刷新兜底。`toolResult` 观察因此只保留 FR-001 的
  Write 新建 → 文件树刷新，不再按 md 扩展名与 Bash 结果分流文档视图。

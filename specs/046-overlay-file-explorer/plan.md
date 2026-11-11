# 实施方案：Overlay 对话的文件资源管理器视图

技术路线：Core 新增一个只读的目录列举请求（`UiRequest.workViewFilesRequested`），侧栏的文件
资源管理器按活动对话的归属在两条通道间分流——普通对话走既有 `sidebar:files-list`，Overlay
对话走新请求。打开文件同理分流。标题标注是渲染层的纯展示改动。

需求见 [spec.md](spec.md)。

## 技术方案

### 1. 为什么必须经 Core 列目录

Core 的 overlay 挂在它私有的挂载命名空间里（`docs/core/conversation-work-view.md` 第 4 节）。
宿主进程读 `work-views/<key>/mount/` 得到的是**空目录**（实测：Core 侧
`/proc/self/mountinfo` 有该挂载、宿主侧没有）。直接读 `upper/` 也不成立：whiteout 是字符
设备（删掉的文件仍可见）、未改动的文件在 `lowerdir`（看不到）。因此列目录只能在 Core 进程内做。

这也与既有边界一致：宿主不直接读 Core 的磁盘数据，统一经 `UiRequest` 索取
（[docs/core/standalone-core-boundaries.md 第 2 节](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。

### 2. Core 侧：`work_view_files`

新增 `core-rs/src/work_view_linux.rs` 的 `list_view_dir(session_id, dir) -> Result<Vec<Value>, String>`：

1. `WorkViewHandle::of(session_id)` 取句柄；`None` 说明该会话没有已挂载的视图——回
   `Err("会话 <id> 没有已挂载的 Overlay 视图")`，由宿主决定显示磁盘基线（FR-004）还是报错。
   不在这里偷偷退回磁盘：Core 只描述事实（`docs/architecture/principles.md` 第 3 节）。
2. `dir` 按 `'/'` 分隔的相对路径解析：`Path::new(dir)`，拒绝 `is_absolute()`、含 `..`
   分量的输入（与 `electron/sidebarFiles.ts::resolveWithinRoot` 同一口径）。
3. 读 `mount.join(dir)`，逐项 `symlink_metadata` + `metadata` 归类（符号链接按目标归类、
   断链跳过——与 `listDirectory` 和 SFTP 的 `listDirectory` 同一语义）。
4. 排序交给宿主：Core 回未排序的条目，与远程 SFTP 路径一致（`sshClient.listDirectory`
   明确「排序不在这一层做」）。

非 Linux 的 `work_view_unsupported.rs` 同签名回 `Err`，保持两侧编译一致。

### 3. 契约

`src/shared/AssistantEventBus.ts`：

```ts 示意
// UiRequest 增
| { type: 'workViewFilesRequested'; sessionId: string; dir: string }

// UiRequestResultMap 增
workViewFilesRequested: WorkViewFilesResult;

// 应答（判别联合，与 FilesListResult 同形）
export type WorkViewFilesResult =
  | { ok: true; entries: DirectoryEntry[] }
  | { ok: false; error: string };
```

`DirectoryEntry` 复用 `src/host/standalone/sshClient.ts` 的类型（侧栏已有一份别名）。
注意 `src/shared/` 不能 import `src/host/`——`DirectoryEntry` 因此需要下沉到 `src/shared/`，
由 `sshClient.ts` 改为 re-export（保持既有 import 点不变）。

`core-rs/src/main.rs` 的 `dispatch_ui_request` 增分支；请求缺 `sessionId` / `dir` 时报错
（不静默取默认值）。

### 4. 宿主侧

`src/host/coreFacts.ts` 增：

```ts 示意
export async function requestWorkViewFiles(sessionId: string, dir: string): Promise<WorkViewFilesResult>
```

`electron/main.ts` 的 `sidebar:files-list` 保持原样（普通对话的路径不变），新增
`sidebar:files-list-overlay` 走 `requestWorkViewFiles`。分成两个 IPC 通道而不是给既有通道
加参数：参数会让「取数来源」这个事实藏进一个可选字段里
（`docs/architecture/principles.md` 第 2 节）。

`sidebar:files-open` 同理增 `sidebar:files-open-overlay`：读内容走 Core（视图路径），编辑器
标签仍以真实工作区路径标识（`ref.path + '/' + rel`），与工具输出的口径一致（FR-003）。

### 5. 渲染层（`electron/sidebar/main.ts`）

`WorkspaceFilesState` 增两个字段：

```ts
/** 该工作区当前活动对话的归属（null = 没有活动对话 / 普通对话） */
overlaySessionId: string | null;
```

- 归属来源：`conversations` 列表里 `sessionId === activeSessionId` 的那条的 `storage`
  （侧栏已消费该字段，见 `ConversationMeta.storage`）。
- `setActive` 与 `applyConversations` 里重算 `overlaySessionId`；值变化时清空该工作区的
  `tree` / `expandedDirs` / `generation += 1`（FR-005：不复用另一来源的缓存）。
- `loadDir` 按 `files.overlaySessionId !== null` 分流到两个 IPC 通道之一。
- 标题：`index.html` 的 `.files-title` 加 `id="filesTitle"`，`renderFiles` 里写
  `文件资源管理器 (overlay)` / `文件资源管理器`。后缀用小写 `overlay`（用户指定）。

### 6. 措辞统一

用户可见处「对话隔离视图」→「Overlay 对话」（英文 `Overlay conversation`）：

| 位置 | 现值 |
| --- | --- |
| `src/webview/i18n/zh.ts` `app.workViewOption` | 「对话隔离视图（改动只留在这个对话，磁盘不变）」 |
| `src/webview/i18n/en.ts` `app.workViewOption` | `Isolated work view (changes stay in this conversation)` |
| `electron/sidebar/main.ts` 的 `isolated-tag` tooltip | 「对话隔离视图（改动只留在这个对话，磁盘不变）」 |
| `docs/core/conversation-work-view.md` 全文 | 「对话隔离视图」→「Overlay 对话」 |

代码注释里的措辞一并统一（[AGENTS.md 第 2 节](../../AGENTS.md#2-代码风格)：注释用中文，术语与代码一致）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/DirectoryEntry.ts` | 新增（类型下沉） | 新类型，`sshClient.ts` 改为 re-export |
| `src/shared/AssistantEventBus.ts` | 修改 | 新增 `UiRequest.workViewFilesRequested` + `WorkViewFilesResult` + 结果映射 |
| `core-rs/src/work_view_linux.rs` | 修改 | 新增 `list_view_dir` |
| `core-rs/src/work_view_unsupported.rs` | 修改 | 同签名回 `Err` |
| `core-rs/src/work_view.rs` | 修改 | 导出 `list_view_dir` |
| `core-rs/src/main.rs` | 修改 | `dispatch_ui_request` 增分支 |
| `src/host/coreFacts.ts` | 修改 | 新增 `requestWorkViewFiles` |
| `electron/main.ts` | 修改 | 新增 `sidebar:files-list-overlay` / `sidebar:files-open-overlay` |
| `electron/sidebarPreload.ts` | 修改 | 两个新通道的 preload 出口 |
| `electron/sidebar/main.ts` | 修改 | 取数分流、标题后缀、措辞 |
| `electron/sidebar/index.html` | 修改 | `.files-title` 加 id |
| `src/webview/i18n/{zh,en}.ts` | 修改 | 措辞 |
| `core-rs/src/work_view_tests.rs` | 修改 | 新增用例 |
| `src/test/*` | 修改 | 契约与 coreFacts 的桩 |

## 宪章检查

- [x] **分层与依赖**（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`DirectoryEntry` 下沉到 `src/shared/` 是必须的——
      契约（`AssistantEventBus`，在 shared）不能 import `src/host/` 的实现。`sshClient.ts`
      改为 re-export 后既有 import 点不动，不产生反向依赖。Core 侧只读视图目录，不经总线以外
      的通道；宿主侧新增的 IPC 通道在 `electron/main.ts`（宿主实现层），不塞进 `UIHost`。
- [x] **架构铁律**（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      - 不过度 fallback：Core 侧视图未建立回 `Err` 而不是偷偷读磁盘；宿主侧请求失败显示错误
        文案，不回退磁盘（FR-006）。
      - 契约成员全必选：`WorkViewFilesResult` 是判别联合，「没有」用 `ok: false` + `error`
        而不是可选字段。
      - 一份事实一个写入点：取数来源由活动对话的 `storage` 派生，只有 `setActive` /
        `applyConversations` 两处重算（收敛到 `syncOverlaySession()` 一个函数）。
      - 默认值单源：无新增默认值。
- [x] **Core 行为与落盘格式同步义务**（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 侧改动在 `core-rs/`，不触碰
      落盘格式（视图目录只读、不写 meta）。`src/shared/history/` 无改动。两侧 Core
      （`work_view_linux.rs` / `work_view_unsupported.rs`）同签名，非 Linux 编译通过。
- [x] **文档同步义务**（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：同步
      [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) 第 1 节
      （新请求）与全文措辞、[docs/core/standalone-core.md](../../docs/core/standalone-core.md)
      第 4 节的 `UiRequest` 清单（数量 +1，docsLint 校验）、
      [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md)
      [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)侧栏、[docs/architecture/events.md](../../docs/architecture/events.md) 若涉及。
      `npm run test:unit -- docs-lint` 必须绿。

## 被否决的替代方案

| 路线 | 否决理由 |
| --- | --- |
| 侧栏直接读 `work-views/<key>/mount/` | 宿主看不到 Core 的挂载命名空间，读到空目录（已实测） |
| 侧栏直接读 `work-views/<key>/upper/` | 树是错的：whiteout 让删掉的文件仍显示，未改动的文件在 lowerdir 看不到 |
| `nsenter` 进 Core 的命名空间再列目录 | 需要 Core 暴露 PID + 提权；每次列目录起一个进程；SSH 远端完全不可行 |
| 给既有 `sidebar:files-list` 加 `sessionId` 参数 | 把「取数来源」这个事实藏进可选参数里，违反铁律「不让参数可选」；两条通道各自的失败语义也不同（磁盘失败 vs 视图未建立） |
| 只做标题标注、不显示 overlay 内容 | 用户明确要求「要显示当前 Overlay 的视图」；标注而不改内容会让人以为看到的是叠加结果 |
| 视图未建立时由 Core 自动建 | 视图是惰性建立的（`docs/core/conversation-work-view.md` 第 6 节），打开侧栏不该触发挂载；FR-004 定的是回基线 |

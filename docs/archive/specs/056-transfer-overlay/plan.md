# 实施方案：`Transfer` 支持 Overlay 对话的视图端

技术路线一句话：把「属于发起对话工作区的那一端」的 `TransferEndpoint` 换成经 Core 的
视图端点（新增 `UiRequest.workViewFileIoRequested` 一类请求），两端事实由发起方 Core 随
`crossWorkspaceTransferRequested` 给出；宿主侧的递归引擎、守卫与卡片一行不改。

需求见同目录 [spec.md](spec.md)。

## 技术方案

### 1. 事实怎么过河

`Transfer` 的入参是真实工作区路径（模型可见的东西不变）。Core 在 `run_transfer` 里已经
持有 `ToolContext.work_view`（三态：`Workspace` / `View` / `ViewUnavailable`）：

| `WorkViewState` | 语义 | 动作 |
| --- | --- | --- |
| `Workspace` | 非 Overlay 归属 | 请求照旧，`originInView: false` |
| `View` | 隔离归属且有视图 | 请求带 `originInView: true`，宿主该端走视图端点 |
| `ViewUnavailable(reason)` | 隔离归属但视图不可用 | 工具错误（FR-005），不发请求 |

因此判定点只有 `run_transfer` 一处，宿主只消费 `originInView` 这个布尔事实，不读
`meta.json`、不查 `sessionStorageOf`（宿主那份投影是给界面用的，不是给搬运用的）。

`originInView: true` 时 `TransferRequest` / `coreRequest` 载荷还需要一个**在视图端可寻址的
相对路径**：宿主拿不到 Core 的命名空间，但路径本身是真实工作区路径，Core 侧 уже 能把它
映射成视图里的相对位置。做法：`run_transfer` 把 `sourcePath` / `targetPath` 里**属于发起
工作区的那一端**用 `WorkViewState::io_path` 校验范围（FR-004），再把「相对工作区的路径」
一并发给宿主：

- `originInView: boolean` —— 本端是否按视图取放；
- `originSourceRelative: string | null` / `originDestRelative: string | null` —— 视图端路径
  相对发起会话工作区根的 POSIX 相对路径（绝对路径传 `''` 表示工作区根）；不属于本端时为
  `null`。

不在 Core 里另造一套「视图路径」，是因为跨进程搬字节必须由 Core 代执行（视图挂载在 Core
的私有命名空间里），而相对路径 + 会话 id 已经足以让 Core 定位视图里的路径。

### 2. 字节怎么过河（新契约成员）

新增一个 `UiRequest`：`workViewFileIoRequested`，判别字段 `op`：

| `op` | 载荷 | 应答 |
| --- | --- | --- |
| `'stat'` | `sessionId`, `path`（工作区相对，`''` = 根） | `{ ok: true, exists, kind, symlink, size }` |
| `'list'` | 同上 | `{ ok: true, entries: [{ name, kind }] }` |
| `'mkdirAll'` | 同上 | `{ ok: true }` |
| `'rename'` | `sessionId`, `path`, `to`（同端相对路径） | `{ ok: true }` |
| `'unlink'` | `sessionId`, `path` | `{ ok: true }` |
| `'read'` | `sessionId`, `path`, `offset`, `length` | `{ ok: true, bytes: number[], eof: boolean }` |
| `'write'` | `sessionId`, `path`, `offset`, `bytes: number[]`, `append: boolean` | `{ ok: true, size }` |

失败统一 `{ ok: false, error }`（与 `workViewFilesRequested` 同一口径：业务失败走失败侧，
请求非法才回 `Err`）。

分块读写（FR-003 最后一条）：`read` 按 `offset` / `length` 取片段、`eof` 表示到末尾；
`write` 按 `offset` 定位并在 `append: false` 时截断到该偏移。块的字节数以数字数组表达——
JSON 帧没有二进制类型，数字数组是 bus 上唯一不引入新编码约定的形态（`encodeHex` 会把
体积翻倍且 Core 侧没有现成的 hex 解码给这条路径用）。

### 3. 宿主侧端点

`src/host/workspaceTransfer.ts` 新增 `viewEndpoint(request, label)`（纯逻辑、注入取数函数
以便单测）：把 `TransferEndpoint` 的每个原语映射到上面的 `op`。`readStream` / `writeStream`
用 `Readable` / `Writable` 包住分块请求：

- 读：`_read` 里发 `read(offset, CHUNK)`，推入数据；`eof` 时 `push(null)`。
- 写：`_write` 里发 `write(offset, bytes, append)`；第一条非 append 写入前先按 `offset`
  截断（`write` 的 `append: false` 即语义），`offset` 随成功写入推进。

`WebViewUI.requestCrossWorkspaceTransfer` 里选端点：

```text
端属于发起工作区 && originInView  → viewEndpoint(该端)
其余                              → fsEndpoint() / SFTP（既有）
```

「端属于发起工作区」用已有的 `sameWorkspaceRef(sourceRef, origin.workspaceRef)` 判断，
与守卫同一份比较函数。

### 4. 「属于发起工作区的那一端」怎么认

`resolveTransferEnds` 的返回值已经是解析后的 `sourceRef` / `destRef`；Core 侧只对
`sourceTarget === null` / `destTarget === null` 或身份等于本工作区的那一端算出相对路径。
为避免两侧各算一次身份，Core 在 `run_transfer` 里按「`source_target` 缺省或其身份等于
`transfer_counterpart` 之外的自身身份」判定——但 Core 不持有工作区身份字符串。

改为：`run_transfer` 把**两端都**可能需要的相对路径都算出来（只要路径落在 `ctx.cwd` 之内），
宿主按自己解析出的「哪一端属于发起工作区」挑对应的那个。落在工作区之外的路径该端为
`null`，宿主拿到 `null` 却需要视图端点时报错（与 FR-004 的拒绝同一条路，兜底不会发生，
因为 Core 在发请求前已经拒过）。

这样两侧都不需要重新实现身份比较：Core 只做「路径 → 相对路径 / 越界」这一件事，宿主只做
「哪一端是本对话」这一件，各自用自己已有的单一事实来源。

### 5. 分块大小与中止

- 块大小 `WORK_VIEW_IO_CHUNK = 1 MiB`：远小于代理单帧 8 MiB 上限与主机帧通道的实际吞吐
  断点，同时把「一次请求一次 JSON」的往返次数压在可接受范围（1 GiB 文件约 1024 次）。
- 中止沿用 `AbortSignal`：`viewEndpoint` 的每个方法先 `signal.throwIfAborted()`，读流的
  `_read` 同样先查；`runSessionTransfer` 的注册表与 `cancelTransfersForSession` 不变。
- 暂存件清理沿用执行器的 `catch` 分支（`dest.unlink(tempPath)`），视图端点的 `unlink` 即
  代理的删除，因此失败 / 中止后 `upper/` 里不留 `.tuxedo-transfer-tmp`。

### 6. Core 侧落地

`core-rs/src/work_view.rs` 导出平台无关入口（两个平台各一份实现，非 Linux 恒报错）：

```text
view_stat(session_id, rel) / view_list(session_id, rel) / view_mkdir_all(session_id, rel)
view_rename(session_id, rel, to) / view_unlink(session_id, rel)
view_read_chunk(session_id, rel, offset, length) / view_write_chunk(session_id, rel, offset, bytes, append)
```

Linux 实现直接用 `WorkViewHandle::of(session_id)` 拿代理句柄，路径 = `handle.workspace()`
拼相对路径，全部经 `handle.proxy()` 的代执行原语（`stat` / `list_dir` / `mkdir_all` /
`read_file` / `write_file`）。`rename` / `unlink` / 定向读写代理当前没有对应 op，新增
`renamePath` / `unlinkPath` / `writeFile` 的 `offset` / `append` 支持（代理侧 `serve.rs` 的
`dispatch`）。IPC 版本因此 +1：新增 op 属于帧语义变更（`IPC_PROTOCOL_VERSION` 从 1 变 2，
`tests` 里的 fixture 与代理侧断言同步）。

路径校验复用 `check_view_relative`（拒绝对路径 / `..` / 反斜杠），并额外要求长度非空
（`rename` / `stat` / `read` / `write` 的 `path` 不能是根）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | 修改 | `CoreRequest.crossWorkspaceTransferRequested` 加 `originInView` / `originSourceRelative` / `originDestRelative`；新增 `UiRequest.workViewFileIoRequested` 与 `WorkViewFileIoResult` |
| `core-rs/src/tools.rs` | 修改 | `TransferRequest` 加三个字段；`run_transfer` 做三态判定与相对路径计算 |
| `core-rs/src/engine.rs` | 修改 | `transfer_hook` 透传三个新字段 |
| `core-rs/src/main.rs` | 修改 | `dispatch_ui_request` 增 `workViewFileIoRequested` 分支 |
| `core-rs/src/work_view.rs` / `work_view_linux.rs` / `work_view_unsupported.rs` | 修改 | 新增七个平台无关入口 |
| `core-rs/src/mount_proxy/linux/client.rs` | 修改 | 新增 `rename_path` / `unlink_path` / 定向读写；IPC 版本 +1 |
| `core-rs/src/mount_proxy/unsupported.rs` | 修改 | 同签名占位 |
| `mount-proxy-rs/src/serve.rs` | 修改 | 新增 `renamePath` / `unlinkPath`；`writeFile` 支持 `offset` / `append`；`IPC_PROTOCOL_VERSION` = 2 |
| `mount-proxy-rs/src/protocol.rs` | 修改 | 同上 |
| `mount-proxy-rs/fixtures/mountProxyProtocol.json` | 修改 | `version` 应答的 `ipcVersion` 改 2 |
| `src/host/workspaceTransfer.ts` | 修改 | 新增 `viewEndpoint`（分块读 / 写流） |
| `src/host/coreFacts.ts` | 修改 | 新增 `requestWorkViewFileIo` |
| `src/host/WebViewUI.ts` | 修改 | `requestCrossWorkspaceTransfer` 按 `originInView` 选端点 |
| `src/test/workspaceTransfer.test.ts` | 修改 | 端点契约 + 递归 / 覆盖 / 中止在视图端点上的用例 |
| `src/test/crossWorkspaceTransfer.test.ts` | 修改 | 端点选择矩阵 |
| `core-rs/src/tools_tests.rs` | 修改 | 三态判定 / 相对路径 / 越界拒绝 |
| `core-rs/src/engine_tests.rs` | 修改 | 载荷透传 |
| `core-rs/src/main_tests.rs` | 修改 | `workViewFileIoRequested` 的参数校验与失败侧 |
| `core-rs/src/mount_proxy/linux/client_tests.rs` | 修改 | 新 op 的帧形态 |
| `e2e/electron/overlayMountProxyRemote.spec.ts` | 修改 | 真实视图 + 真实 SSH 远端的 `Transfer` 用例 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新契约成员落在 `src/shared/AssistantEventBus.ts`
      （共享叶子层）；`src/host/workspaceTransfer.ts` 仍只依赖 `node:` 与注入函数，不 import
      宿主 API，也不做 `host.kind` 嗅探；视图取放全部经 Core（`UiRequest`），宿主不读挂载点
      ——`host/` 不 import core 实现，只发请求。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：`originInView` 由 Core 一次判出、宿主只消费（铁律 4.4
      一份事实一个写入点）；视图端不可用时 `run_transfer` 直接报错、不降级（4.1）；三个新
      载荷字段全必选、`null` 表达「不属于本端」（4.2）；相对路径派生只在 `run_transfer` 一处
      （4.5）；没有新增默认值（4.6）；视图文件 IO 的字节由 Core 转交代理，宿主不缓存内容
      （4.8 预览 / 内容取数只有一处实现）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 侧改动落在 `core-rs/`
      （`tools.rs` / `engine.rs` / `main.rs` / `work_view*`）与 `mount-proxy-rs/`，两侧 op 与
      IPC 版本同步、两侧测试同步。**不改会话落盘格式**（`meta.json` 的 `storage`、
      对话 JSONL 均不变），因此 `core-rs/src/history_tests.rs` 的对照表不动。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：`docs/features/cross-workspace-transfer.md`
      （FR-003 / 行为规格 / 边界 / 追溯矩阵）、`docs/core/conversation-work-view.md`
      （第 5 节工具语义）、`docs/architecture/events.md`（2.2 载荷列）、
      `docs/core/standalone-core.md`（第 4 节成员名单与数量）、
      `docs/core/standalone-core-boundaries.md`（第 2 节例外表）、
      `docs/features/user-stories/desktop.md`（US-60 验收）随代码同批更新，
      `npm run test:unit -- docs-lint` 绿。

## 被否决的替代方案

1. **宿主直接读 Core 的视图目录（`upper/` + 磁盘合并）**。否决：宿主读挂载点得到空目录；
   自己按 `upper/` 覆盖 `lowerdir` 重实现一套合并会引入 whiteout / 目录删除 / 权限三处
   与 overlayfs 不一致的语义，且这份实现会成为第二个「视图内容」的读取点（铁律 4.8）。
2. **让视图端也走 SFTP / 本地 fs，先导出到临时目录再搬**。否决：一是导出需要先读视图
   内容（回到方案 1 的取数问题），二是临时目录会留下中间态，且大文件要把空间占用翻倍。
3. **给 `Transfer` 加一个显式入参 `<fromView>` / `<view>`**。否决：视图归属不是模型可见的
   概念（提示词里刻意不出现 UI 概念，specs/028 FR-006）；归属应由 Core 按会话事实决定，
   让模型声明会变成「忘了传就搬磁盘」的新失败模式。
4. **复用一个 `workViewFilesRequested` 加上写方向**。否决：那个请求的应答形态是给界面渲染
   文件树的（`DirectoryEntry` 带 `mtimeMs`），塞进字节流会让「渲染用取数」与「搬运用 IO」
   共用一个载荷，任一方向的字段调整都会牵动另一处；分成一个带 `op` 的判别联合，语义与
   失败形态各自闭合。
5. **用十六进制编码搬字节**（对齐代理 IPC 的 `bytes`）。否决：hex 让每帧体积翻倍，而这条
   路径已经很靠近帧通道的实用吞吐断点；数字数组是 JSON 里唯一的无损字节形态，块大小固定
   1 MiB 保证体积可控。

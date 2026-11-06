---
status: 已修
---

# 缺陷：宿主侧仍直接 append 会话 JSONL（Edit / Write 的 `_meta`），Core 不是唯一写入点

会话落盘（`<sid>.jsonl` / `<sid>.meta.json` / 压缩归档 / `workspace.meta.json`）的
应有形态是**只有 Core 写**：宿主经 `UiEvent` 提出改动请求、经 `UiRequest` 读取事实。
现状是宿主还保留一整条直写链路——`ToolHandler` 在权限确认时把 Edit / Write 的
`beforeContent` / `afterContent` 等字段 append 进会话 JSONL；同一个文件同时存在两个
进程的写入方，而两侧的串行化都只是**进程内**的（Rust `WRITE_LOCK` / TS
conversationWriteQueue），跨进程没有任何互斥。这违反了
[docs/architecture/principles.md 第 11 节](../../docs/architecture/principles.md#11-共享文件的写安全)
对共享文件的写安全要求，也让远程工作区必然写错位置（宿主按本地家目录解析路径）。

## 现状

- **宿主的 append 路径**（VS Code 与 Electron 共用同一份 `WebViewUI`）：
  `ToolHandler.requestToolPermission` → updateToolUseMeta
  → appendToolUseUpdate → `appendFile(<sid>.jsonl)`（`src/shared/history/Conversation.ts`）。
  触发条件是 `toolName` 为 Edit / Write 且 `permResult` 带 `beforeContent`，
  写入一行 `{ type: 'tool_use_update', toolUseId, meta: { beforeContent, afterContent,
  contextBefore, contextAfter, startLine, endLine } }`。
- **没有跨进程锁**：Core 侧 `core-rs/src/history.rs` 的 `WRITE_LOCK` 是进程内 `Mutex`，
  宿主侧 conversationWriteQueue 是进程内 `Promise` 链。两个进程对同一 `<sid>.jsonl`
  的行写没有任何互斥，`writeln!` 还把正文与换行拆成两次 write。
- **写窗口真实存在**：Core 发 `toolPermissionRequested` 时**不等回包**，随后自己追加
  `_meta.confirmTimestamp`（`core-rs/src/engine.rs` 的 `resolve_permission` 之后）；
  宿主恰在这段时间里追加 diff `_meta`。
- **远程工作区必错**：getConversationPath 走 `resolveHomeDir()` 的本地口径，
  SSH 远程会话时算出的路径落在本机、通常不存在，append 失败只记一条日志。
- **PyCharm 宿主是同一件事的另一种写法**：HostUi.writeToolUseMeta 读全文件、改
  `_meta`、`Files.write(..., TRUNCATE_EXISTING)` 整份覆盖——注释写的是 append-only，
  实现是无锁的读-改-写。
- **同时存在成片死代码**：宿主侧会话写入 / 读取的大部分导出在生产代码里零调用
  （appendMessage、replaceConversationMessages、saveCompactArchive、
  createConversationMetadataSync、updateConversationMetadataTitle、
  cleanupOldConversations、markConversationAsRemote、updateConversationContext、
  deleteConversation、loadConversation、loadConversationList、
  ConversationSpace.ts 的三个函数、toolResultStorage.ts 的落盘与删除函数、
  mcp/Config.ts 的会话覆盖读写），ensureProjectConversationDir 还让宿主写
  `workspace.meta.json`——与「项目清单读与写都在 Core」的基线相反。

## 期望

1. **Core 独占会话落盘**：Edit / Write 的 diff `_meta` 由 Core 在权限判定后追加为
   `tool_use_update` 记录（同一格式、同一写入函数），宿主不再写会话 JSONL / meta.json /
   压缩归档 / 项目清单。宿主只保留「请求」与「读取」两条通路。
2. **落盘内容不变**：`_meta` 仍是 `beforeContent` / `afterContent` / `contextBefore` /
   `contextAfter` / `startLine` / `endLine`；Write 新建文件时 `beforeContent` 为 `null`
   （回滚据此删除文件）。回滚（`rollback.rs`）与历史恢复读到的值与现状逐字段一致。
3. **宿主侧写入入口清零**：TS（`src/host` / `electron` / `src/shared/history` /
   `src/shared/mcp`）与 PyCharm 插件都不再对会话文件调用任何写 API。
4. **死代码删除**：上述零调用的写入 / 读取导出、`ConversationSpace.ts`、
   `toolResultStorage.ts` 的会话落盘实现、`mcp/Config.ts` 的会话覆盖读写一并移除，
   只留下宿主仍在用的部分（`ConversationMetadata` 类型、`getConversationModelRef`、
   `collectConversationClosure`、路径解析与会话工作目录索引）。
5. **Electron 的删除闭包不再读宿主磁盘**：改由 `UiRequest.conversationListRequested`
   取列表，闭包规则仍用同一个纯函数 `collectConversationClosure`。

## 不变量

- 会话落盘格式（JSONL 行形状、`tool_use_update` 记录、meta.json 字段）不变；Rust 侧
  `history_tests.rs` 的格式对照用例不得修改。
- `toolPermissionRequested` 的载荷不变：`permResult` 仍带 diff 字段（webview 渲染卡片
  diff、manual 模式下宿主打开原生 diff 都依赖它）。
- `toolPermissionRequested` 仍是**发后不等**：不因新增落盘而阻塞工具执行；落盘失败
  只记日志，不影响权限判定与执行。
- `confirmTimestamp` 的写入点与语义不变（`resolve_permission` 之后、执行之前）。
- 宿主侧仍保留的读取（会话工作目录索引、`workspace.meta.json` 只读）行为不变。

## 回归测试

- **RT-1**：`auto` 模式下 Edit 工具跑完一轮后，会话 JSONL 回放出的 `tool_use` block
  带 `_meta.beforeContent` / `_meta.afterContent` / `_meta.startLine`（由 Core 写入，
  假宿主不写任何文件）；同一记录可被 `rollback::rollback_edit` 用来还原文件。
  （落点：`core-rs/src/engine_tests.rs` 的 `edit_diff_meta_is_persisted_by_core`）
- **RT-2**：Write 新建文件（`beforeContent` 为 `null`）时 `_meta.beforeContent` 落成
  JSON `null` 而不是空串/缺键——回滚依赖「null = 文件原本不存在」。
  （落点：`core-rs/src/engine_tests.rs` 的 `write_new_file_diff_meta_records_null_before`）
- **RT-3**：宿主侧不存在会话写入入口——扫描 `src/shared/history/*.ts`、
  `src/shared/mcp/Config.ts`、`src/host/ui/toolHandler.ts` 与 PyCharm 的 `HostUi.kt`，
  不允许出现 `appendFile` / `writeFile` / `Files.write` / `updateToolUseMeta`。
  （落点：`src/test/sessionSingleWriter.test.ts`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path core-rs/Cargo.toml edit_diff_meta_is_persisted_by_core` | 红 | `assert_eq!(meta["beforeContent"], "alpha\nbeta\ngamma\n")` 失败：`left: Null`——Core 没写，假宿主也不写，`_meta` 只有 `toolCallTimestamp` / `confirmTimestamp` |
| RT-2（修复前） | `cargo test --manifest-path core-rs/Cargo.toml write_new_file_diff_meta_records_null_before` | 红 | `beforeContent 必须落盘（null 也要写）：Object {"toolCallTimestamp": …, "confirmTimestamp": …}` |
| RT-3（修复前） | `npm run test:unit -- session-single-writer` | 红 | 4 项断言失败：Config.ts 的 writeFileSync（workspace.meta.json）、toolHandler.ts 的 updateToolUseMeta（3 处）、HostUi.kt 的 Files.write + writeToolMeta（3 处） |
| RT-1（修复后） | `cargo test --manifest-path core-rs/Cargo.toml diff_meta` | 绿 | 2 passed / 0 failed：`edit_diff_meta_is_persisted_by_core` + `write_new_file_diff_meta_records_null_before` |
| RT-3（修复后） | `npm run test:unit -- session-single-writer` | 绿 | 5 通过 / 0 失败（5 个被扫描文件各 0 处写入 API） |
| 既有回归（TS 单测） | `npm run test:unit` | 部分验证 | 97 通过 / 3 失败 / 2 跳过；3 个失败在未改动的 HEAD（stash 后重跑同一命令）上同样失败，属本机环境：`pdbPackaging`（子进程 PATH 里没有 `npm`）、`traySoundAssets`（同上）、`sidebarDocViewGit`（临时目录文件名含引号时 `writeFileSync` ENOENT）。改动的直接相关文件全绿：`docsLint` / `docsLintLocalOnlyPaths` / `sessionSingleWriter` / `conversationClosure` / `conversationSpaceClearHost` / `hostCoreFacts` / `persistedOutput` / `projectConversationDir` / `workspaceMeta` |
| 既有回归（Rust） | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1081 passed / 0 failed（含 `history::` 的落盘格式对照表与 `engine::` 的权限 / 回滚用例） |
| 静态检查 | `npm run check-types` | 绿 | 三份配置（tsc / webview / electron） |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 事件表、路径与标识符存在性、缺陷规格五节与验证记录取值 |
| PyCharm 插件编译 | — | not-run | 需要本机 PyCharm 平台（`e2e/environments.json` 的 pycharm 段）与 Gradle 依赖；改动的 Kotlin 只删除函数与构造参数，无新增 API |

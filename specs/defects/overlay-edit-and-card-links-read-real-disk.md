---
status: 已修
---

# 缺陷：Overlay 对话里新建的文件无法 Edit、卡片链接打开的是真实磁盘

Overlay 对话的改动只落在该对话私有的叠加视图里，磁盘（`lowerdir`）保持原样。有两处代码
仍然按**真实磁盘**取事实，于是「对话内新建的文件」在这两处都表现为「不存在」：

1. 权限层（`core-rs/src/permission.rs`）自己用 `std::fs` 读目标文件——Core 不在挂载
   命名空间里，读到的是真实磁盘。视图内新建的文件因此被判成「文件不存在」，`Edit`
   在权限阶段就被拒绝（提示改用 `Write`），工具根本没执行。
2. 宿主打开文件的通道（`electron/ElectronUIHost.ts` 的 `openFile`）只认真实磁盘 / SFTP，
   没有「这个会话的文件事实在视图里」这一支。点 Edit / Write 卡片上的路径链接，远程会话
   走 SFTP 读到 `No such file`，窗口里显示 `// 无法读取远程文件: SFTP read failed ...`；
   本地会话开出一个空 Monaco 窗口。

影响面：只要文件是**在 Overlay 对话里新建**的（磁盘上没有），就无法继续 Edit，也无法从
卡片链接查看内容——而这两件事正是「对话内连续改同一个文件」的基本动作。

## 现状

复现路径（Electron 宿主 + `electron-ssh` 车道的真实 Linux 远端，代理已部署，
`isolatedWorkView: true`）：

1. 新建对话，勾选「Overlay 对话」，让模型 `Write` 一个新文件（如 `/home/pz/ws/sum.py`）；
2. 让模型 `Edit` 同一个文件。

实际结果：`Edit` 返回工具错误
`File does not exist: <path>. Use Write tool to create new files.`——而该文件就在同一
对话的视图里（`Read` / `Bash cat` 都读得到）。

3. 同一张 `Write` / `Edit` 卡片上点路径链接。

实际结果：内置 Monaco 窗口内容为
`// 无法读取远程文件: SFTP read failed (/home/pz/ws/sum.py): No such file`
（本地工作区的 Overlay 会话则是空窗口：主进程 `fs.readFile` 得到 `ENOENT`）。

证据链（只读代码定位）：

- **权限层读真实磁盘。** `core-rs/src/permission.rs` 的 `base_check` 里，`Write` 用
  `std::fs::read_to_string` 取 `beforeContent`，`Edit` 用同一个调用取「待编辑内容」，
  文件不存在时直接 `deny`；确认框文案 / 选项的「创建 / 覆盖」判据在
  `write_target_exists`，也是 `Path::exists`（真实磁盘）。这与
  [docs/core/conversation-work-view.md 第 5 节](../../docs/core/conversation-work-view.md#5-工具语义)
  的 as-built 表述冲突：工具的**文件 IO 全部**经常驻挂载代理代执行，因为
  「Core 不在命名空间里，它自己 `open()` 看到的都是真实磁盘」。同模块的
  `ToolContext::read_bytes` / `stat_path` 已经按 `WorkViewState` 三态分流，权限层是漏网的一处。
- **宿主的 openFile 没有视图分支。** `electron/ElectronUIHost.ts` 的 `openFile` 只有
  两条路：`resolveRemoteFileWorkspace` 命中远程工作区 → `openRemoteFile`（SFTP
  `reader.readText(abs)`，失败开内容窗口显示 `// 无法读取远程文件: ...`）；否则本地
  `openMonacoWindow({ mode: 'view', filePath })`，由主进程 `fs.promises.readFile` 读盘。
  两条路都以真实磁盘为事实来源，[docs/hosts/host-matrix.md 第 3 节](../../docs/hosts/host-matrix.md#3-uihost-实现对照表)
  的 `openFile` 行也只登记了这两支。
- **同一份事实已有现成通道，只是没接到链接上。** 侧栏 Overlay 双击打开走的是
  `sidebar:files-open-overlay` → `openOverlayWorkspaceFile` + `UiRequest.workViewFileDiffRequested`
  （[docs/core/conversation-work-view.md 第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)），
  `electron/fileOpen.ts` 的同一份编排已支持「内容来自 Core、磁盘上没有的文件也能打开」。
  消息 / 工具卡片的 `openFile` 没走它。
- 视图取数的执行形态见 [docs/core/mount-proxy.md](../../docs/core/mount-proxy.md)：
  宿主读挂载点是空目录，因此任何「文件内容」都必须问 Core。
- **同类排查（其它工具）**：`Read` / `Grep` / `Glob` / `Bash` / `Write` / `Edit` 的
  工具执行体已全部经 `io_path` / `read_bytes` / `stat_path` / 代理 spawn 取数，没有第二份
  磁盘读点；`Read` 的存在性与大小判定（`stat_path`）与二进制嗅探（`read_bytes`）也在同一
  条通道上。剩下两处按真实磁盘读写的执行体**不在本条的取数范围内**，现状如下：

  | 落点 | 现状 | 为什么不是本缺陷 |
  | --- | --- | --- |
  | `core-rs/src/rollback.rs` 的 `restore_before` | `std::fs::remove_file` / `write` 直接落真实磁盘 | 回滚是「把改动写回」的用户显式动作，直接写盘是它要的效果；Overlay 会话里回滚应写视图（另一条需求，未在 spec 中定义状态） |
  | `core-rs/src/engine.rs` 里建空会话 JSONL 的那处 `std::fs::write`（`write_conversation_title` 的补空 `.jsonl` 分支） | `std::fs::write` 建空的会话 JSONL | 写的是 Core 自己的数据目录（会话落盘），不是工作区文件 |

  `core-rs/src/permission.rs` 与 `core-rs/src/tools.rs` 的 `ToolContext` 是本次唯一改动的
  两处；后者把 `std::fs` 分支收进 `WorkViewState`，让权限层能够复用同一条通道。

## 期望

1. **权限阶段与工具 IO 同一份事实。** `Write` / `Edit` 的「目标文件是否存在、旧内容是什么」
   经与工具同一通道取（隔离会话由常驻挂载代理代执行），不再由 `permission.rs` 直接
   `std::fs` 读盘；视图内新建的文件因此可以继续 `Edit`。
2. **确认框文案用同一份事实。** 「创建新文件 / 覆盖现有文件」判据与第 1 条同源
   （视图里已有的文件按「覆盖」展示）。
3. **文件链接读的是视图内容。** 隔离会话里，消息 / 工具卡片的文件链接按该会话的视图取数
   （与侧栏 Overlay 打开同一份编排），磁盘上没有的新建文件也能打开并显示内容；不再出现
   `无法读取远程文件: ... No such file`。
4. **非隔离会话行为不变。** `workspace` 归属的链接维持现有本地 / SFTP 语义。
5. **归属事实从 Core 取。** 宿主判断「该会话是不是 Overlay 归属」读 Core 的会话元数据
   （`ConversationMetadata.storage`，缺失即 `workspace`），不在宿主侧另存一份猜测。

## 不变量

- 工具对视图透明：路径字符串、相对路径解析、`cwd` 语义不变，工具输出里的 `file_path`
  仍是真实工作区路径。
- 磁盘仍是唯一基线：Overlay 对话的写入不落真实磁盘，`lowerdir` 不被改动。
- 非隔离会话的权限判定、确认文案、`Edit` / `Write` 结果与拒绝文案（`File does not exist: ...`、
  `权限检查失败: ...`）维持现状。
- `read_guard`（specs/038）的读后失效语义不变：`Write` 成功后同一会话可直接 `Edit`，
  外部改动仍要被拦下。
- 视图取数失败（视图建不起来 / 代理缺失）仍 fail-closed：显示错误，不退回磁盘内容。
- VS Code 宿主的 `openFile` 不在本次范围内（登记为已知分叉，见
  [docs/hosts/host-matrix.md 第 7 节](../../docs/hosts/host-matrix.md#7-尚未收敛的分叉点)）。
- 不新增 `UiRequest` / `UiEvent` / wire 消息成员。

## 回归测试

- **RT-1**：`permission.rs` 不得直接读盘——源码里不出现 `std::fs::`（目标文件的存在性与
  旧内容必须经 `WorkViewState` 的同一条通道）（落点：`core-rs/src/permission_tests.rs` 的
  `permission_layer_does_not_read_the_real_disk`）。
- **RT-2**：真实 Linux Core + 远端 Overlay 会话里 `Write` 新建文件后 `Edit` 同一文件成功
  （工具结果不含 `File does not exist`，内容改成新值）（落点：
  `e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `Overlay 会话：Write 新建的文件必须能被 Edit 继续修改`）。
- **RT-3**：同一会话里点 `Write` / `Edit` 卡片的文件链接，内置查看器显示**视图内容**，
  不出现 `无法读取远程文件`（落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `Overlay 会话：Edit 卡片链接打开的是视图内容而不是真实磁盘`）。
- **RT-4**：链接 → 视图相对路径的纯函数与归属判定——远程 / 本地工作区根内的绝对路径各自
  得到 `'/'` 分隔相对路径，越界（`..` / 根自身 / 不同根）得到 `null`；归属判定只在
  「正式会话 id + `isolated` + 根内路径」三条同时成立时返回取数三元组，`workspace`
  归属 / 根外路径 / `new-` 临时 key / 无来源视图都回 `null`
  （落点：`src/test/fileOpen.test.ts`，函数 `workViewRelForOpen` / `resolveOverlayOpenTarget`
  在 `src/host/overlayOpenResolve.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `CC_aarch64_pc_windows_msvc="zig cc" CFLAGS_aarch64_pc_windows_msvc="--target=aarch64-windows-msvc" cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core permission_layer_does_not_read_the_real_disk` | 红 | `权限层不得直接读盘（Overlay 会话里那是真实磁盘，不是对话视图）`：命中两处 `std::fs::read_to_string`（`Write` 的 `before_content` 与 `Edit` 的 `content`）。0 passed / 1 failed（1211 filtered out）。本机是 Windows arm64，cargo 必须先注入 `crossToolchainEnv` 给出的 `CC_*` / `CFLAGS_*`（与 `npm run build:core:host` 同源）才能编译 `ring` |
| 回归用例（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g Overlay` | 红 | RT-2：`Edit 必须真的执行：File does not exist: <ws>/overlay-edit-chain.py. Use Write tool to create new files.`；RT-3：`.view-lines` 收到 `// 无法读取远程文件: SFTP read failed (<ws>/overlay-card-link.py): No such file`。2 failed（真实远端 + 已装代理） |
| 回归用例（修复前） | `npm run test:unit -- file-open` | 红 | 编译失败：`src/test/fileOpen.test.ts(12,3): error TS2305: Module '"../../electron/fileOpen"' has no exported member 'workViewRelForOpen'`（纯函数尚不存在） |
| 回归用例（修复后） | `CC_aarch64_pc_windows_msvc="zig cc" CFLAGS_aarch64_pc_windows_msvc="--target=aarch64-windows-msvc" CARGO_TARGET_DIR=/tmp/tc-core2 cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core permission` | 绿 | `permission_layer_does_not_read_the_real_disk` 与新增的 `permission_edit_fails_closed_when_view_is_unavailable` 均通过；engine 侧权限用例（`edit_permission_request_carries_the_diff_preview` / `auto_mode_edit_keeps_the_diff_in_the_allowed_permission_result` 等）全绿 |
| 回归用例（修复后） | `npm run test:unit -- file-open` | 绿 | 64 通过 / 0 失败：新增 `workViewRelForOpen` 六项与 `resolveOverlayOpenTarget` 七项全过 |
| 回归用例（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "Overlay 会话"` | skipped | 环境不可用，跑了 3 次都在**启动阶段**超时：`等待活动聊天视图超时（候选 0 个均不满足 {}）`。用未改动的既有用例对照确认与本缺陷无关——把本次改动整体 `git stash` 后跑 `-g "FR-009 远端未装机时确认框点名真实主机"`，同样 1 failed、同一条 `等待活动聊天视图超时`。远端 `pgrep` 显示 daemon 已在跑、`/usr/libexec/<core.mountProxyName>` 不存在（上一轮 `afterAll` 卸载后没能重新装上） |
| 既有回归（Core） | `CARGO_TARGET_DIR=/tmp/tc-core2 cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1213 passed / 0 failed（244.83s） |
| 既有回归（单元） | `npm run test:unit` | 部分验证 | 115 通过 / 1 失败 / 2 跳过。失败为 `coreDaemon`，单独重跑该文件 50 通过 / 0 失败，属全量并发下的偶发；2 跳过的 `sidebarDocViewGit` / `sidebarFiles` 是环境前置缺失的既有 skip 分支 |
| 类型 / lint | `npm run check-types && npm run lint` | 绿 | 主 / webview / electron / e2e 四份 tsconfig 与 eslint 均过 |
| 文档一致性 | `npm run test:unit -- docs-lint` | 部分验证 | `docsLint` 全组通过（含缺陷规格组）；`docsLintLocalOnlyPaths` 仍红 1 项——**既有问题，与本缺陷无关**：把本次的 `docs/` 改动整体 stash 后重跑同一条用例仍然失败 |

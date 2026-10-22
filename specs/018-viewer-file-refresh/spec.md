---
status: 已收敛
---

# 改动规格：Electron 查看器窗口随源文件更新自动刷新

侧栏双击或文件链接打开的内置查看器（Markdown 预览、图片查看器、Monaco 文本查看）在
源文件被修改后自动刷新内容，并保持用户当前的缩放、滚动与光标位置。本地工作区由宿主
文件系统事件驱动；远程（SSH）工作区由远端 Core 监听文件并经总线主动推送变更，不做轮询。
虚拟文档、diff、Mermaid 与 Markdown 内嵌相对路径图片不在本期范围。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../../../docs/features/user-stories.md) | [US-38 文件与虚拟文档预览](../../../../docs/features/user-stories.md#us-38-文件与虚拟文档预览) | 修改 | 验收新增「查看器随源文件更新自动刷新并保持查看位置（本地事件 / 远程 Core 推送）」 |
| [docs/features/user-stories.md](../../../../docs/features/user-stories.md) | [US-42 侧栏文件浏览器](../../../../docs/features/user-stories.md#us-42-侧栏文件浏览器) | 修改 | 验收 6 补充：本地与远程双击打开后源文件更新都自动刷新 |
| [docs/architecture/events.md](../../../../docs/architecture/events.md) | [第 1 节 总线契约](../../../../docs/architecture/events.md#1-总线契约) | 修改 | 四组词汇表数量与处理方说明：新增 CoreEvent 与 UiRequest 成员 |
| [docs/architecture/events.md](../../../../docs/architecture/events.md) | [第 2.1 节 CoreEvent](../../../../docs/architecture/events.md#21-coreeventcore--ui单向) | 修改 | 新增 `workspaceFileChanged` 行：载荷、触发点、处理方 |
| [docs/architecture/contracts.md](../../../../docs/architecture/contracts.md) | [第 1 节 UIHost](../../../../docs/architecture/contracts.md#1-uihost对话-webview-的宿主能力) | 修改 | 新增 Core 文件变更投递成员（VSCode 为 no-op，Electron 路由到查看器） |
| [docs/core/standalone-core-boundaries.md](../../../../docs/core/standalone-core-boundaries.md) | [第 2 节 宿主侧的 core 事实读取](../../../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | 新增 `watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested` 两个 UiRequest |
| [docs/core/standalone-core.md](../../../../docs/core/standalone-core.md) | [第 1.1 节 Core 侧业务范围](../../../../docs/core/standalone-core.md#11-core-侧业务范围) | 修改 | Core 侧新增工作区文件监听与变更上报能力 |
| [docs/hosts/webview-ui.md](../../../../docs/hosts/webview-ui.md) | [第 3 节 总线注册](../../../../docs/hosts/webview-ui.md#3-总线注册) | 修改 | `onCoreEvents` 新增 `workspaceFileChanged` 处理器 |
| [docs/hosts/host-matrix.md](../../../../docs/hosts/host-matrix.md) | [第 2 节 ElectronUIHost](../../../../docs/hosts/host-matrix.md#2-electronuihost) | 修改 | 预览窗口辅助段落补充监听注册、watchId 生命周期与刷新投递 |
| [docs/hosts/host-matrix.md](../../../../docs/hosts/host-matrix.md) | [第 3 节 UIHost 实现对照表](../../../../docs/hosts/host-matrix.md#3-uihost-实现对照表) | 修改 | 新增成员在 VSCode / Electron 两个宿主的实现对照 |
| [docs/hosts/host-matrix.md](../../../../docs/hosts/host-matrix.md) | [第 6 节 宿主固有差异（有意保留）](../../../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 修改 | 侧栏双击打开行补充三类查看器的自动刷新与两种监听后端 |

不新增 `docs/` 文档，[docs/README.md](../../../../docs/README.md) 的地图不变。

## 用户场景与验收标准

- 场景 1：本地文件被外部修改后，查看器内容自动更新。
  - **AC-1**（FR-001）：GIVEN 本地 Markdown 文件已在预览窗口打开 WHEN 外部修改并保存该文件 THEN 窗口内渲染结果更新为新内容，窗口不关闭、不重开。
  - **AC-2**（FR-001）：GIVEN 本地图片已在图片查看器打开 WHEN 外部覆盖该图片文件 THEN 窗口显示新图片，标题仍为文件名。
  - **AC-3**（FR-001）：GIVEN 本地文本文件已在 Monaco 查看模式打开 WHEN 外部修改并保存该文件 THEN 编辑区显示新内容，窗口不关闭、不重开。
- 场景 2：远程文件变更由 Core 主动推送。
  - **AC-4**（FR-002）：GIVEN 远程（SSH）工作区文件已在内置查看器打开 WHEN 远端修改并保存该文件 THEN 1 秒内查看器显示新内容，窗口不关闭、不重开。
  - **AC-5**（FR-002）：GIVEN 远程查看器打开的文件被删除 WHEN Core 推送删除事件 THEN 窗口保留最后内容并在标题追加「文件已删除」标记，不关闭窗口、不弹错误框。
  - **AC-6**（FR-002）：GIVEN 被删除的远程文件在原路径重新创建 WHEN Core 推送变更事件 THEN 标题标记清除，查看器显示新内容。
  - **AC-7**（FR-003）：GIVEN 查看器打开的是工作区 A 的远程文件 WHEN 工作区 B 的远程文件变化 THEN 查看器不刷新，事件按工作区与 watchId 正确路由。
- 场景 3：刷新不打乱正在查看的位置。
  - **AC-8**（FR-004）：GIVEN 图片已放大并平移到某位置 WHEN 该图片文件更新 THEN 新图按同一缩放倍率与平移量显示；新图尺寸使倍率越界时夹到允许范围。
  - **AC-9**（FR-004）：GIVEN Markdown 预览已滚动到某位置 WHEN 该文件更新 THEN 刷新后保持原滚动位置；新内容更短时停在新的底部。
  - **AC-10**（FR-004）：GIVEN Monaco 查看模式已滚动且光标位于某行 WHEN 该文件更新 THEN 刷新后保持原滚动位置与光标行；原行超出新内容时夹到末行。
- 场景 4：监听只跟随当前查看器窗口。
  - **AC-11**（FR-003）：GIVEN 查看器窗口已关闭（本地或远程）WHEN 再修改源文件 THEN 不再刷新、不重开窗口、不弹错误；远程监听在 Core 侧已注销。
  - **AC-12**（FR-003）：GIVEN 查看器窗口 A 已被查看器窗口 B 顶替 WHEN 修改 A 的文件 THEN B 内容不变；WHEN 修改 B 的文件 THEN B 刷新。
  - **AC-13**（FR-003）：GIVEN 同一查看器窗口先后打开文件 A 与文件 B WHEN 修改 A THEN 当前查看器不刷新；WHEN 修改 B THEN 当前查看器刷新。
  - **AC-14**（FR-003）：GIVEN 查看器仍打开且所属工作区被关闭 WHEN 再修改该文件 THEN 监听已停止、查看器保留最后内容且不自动关闭。
  - **AC-15**（FR-003）：GIVEN Core 进程重启而远程查看器仍打开 WHEN Core 恢复就绪 THEN 宿主自动重新注册监听，重启期间的修改在重新注册后补齐显示。
- 场景 5：一次保存只产生一次刷新。
  - **AC-16**（FR-005）：GIVEN 编辑器以「写临时文件 + rename」方式原子保存 WHEN 保存完成 THEN 查看器只刷新一次，内容为最终版本。
  - **AC-17**（FR-005）：GIVEN 文件被重写为与当前内容完全相同 WHEN 变更被检测到 THEN 查看器内容与缩放 / 滚动 / 光标位置均不变。
  - **AC-18**（FR-005）：GIVEN 一次保存产生多条文件系统事件 WHEN 事件停止 THEN 查看器只刷新一次并显示最终内容。
  - **AC-19**（FR-005）：GIVEN 查看器打开过程中文件被修改 WHEN 窗口完成加载 THEN 显示修改后的最终内容，而不是打开瞬间读到的旧内容。
- 场景 6：源文件不可用或链路中断时不让查看器崩掉。
  - **AC-20**（FR-006）：GIVEN 远程文件已打开 WHEN Core 监听注册失败（路径越界 / 权限不足 / 监听上限）THEN 查看器仍显示已读出的内容，标题追加「自动刷新不可用」标记，不弹错误框。
  - **AC-21**（FR-006）：GIVEN Core 已推送变更 WHEN 宿主经 SFTP 读取新内容失败 THEN 保留最后内容并追加「读取失败」标记，下一次变更事件到达时重试并清除标记。
  - **AC-22**（FR-006）：GIVEN 远程查看器打开且 SSH 连接中断 WHEN 连接恢复 THEN 宿主重新注册监听、补齐断线期间的修改并清除「读取失败」标记。

## 功能需求

### FR-001：查看器随源文件更新自动刷新

Markdown 预览、图片查看器与 Monaco 文本查看（`mode: 'view'`）在打开期间监听其源文件。
本地工作区由宿主文件系统事件驱动；远程（SSH）工作区由远端 Core 监听并经总线推送变更。
检测到源文件变化后，查看器内容自动更新为最新内容，无需用户关闭重开或手动刷新。刷新不
重开窗口，不改变查看器窗口名额、位置与尺寸，不抢焦点，标题保持打开对象短名。

### FR-002：远程 Core 监听与主动推送

远端 Core 负责监听远程工作区中的目标文件，变更经 `CoreEvent.workspaceFileChanged` 主动
推送给宿主；宿主不轮询远端文件。事件载荷包含 `watchId`、`path`、`kind`
（`changed` / `deleted` / `error`）、`mtimeMs`、`size` 与 `error`（无错误时为 `null`），
不携带文件内容。宿主收到 `changed` 后经 SFTP 读取新内容并刷新查看器；收到 `deleted` 或
`error` 时按 FR-006 降级。Core 侧对同一次保存产生的多条文件系统事件去抖合并，一次保存
至多推送一次变更。

### FR-003：监听注册、路由与生命周期

宿主为当前查看器窗口向对应工作区的 Connection 注册一个监听（`watchId` 由宿主生成），
经 `UiRequest.watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested` 与 Core
交互。监听随查看器窗口打开而注册，随窗口关闭、被新查看器顶替、同一窗口切换到另一文件
或所属工作区关闭而注销；同一时刻至多一个查看器窗口、至多一个监听。Core 重启或 Connection
重建后，宿主对仍打开的查看器自动重新注册；停止后到达的迟到事件按 `watchId` 丢弃，不产生
刷新、不重开窗口、不弹错误。

### FR-004：刷新保持用户当前查看位置

- 图片：保持当前缩放倍率与平移量；新图尺寸或允许范围变化导致越界时夹到允许范围。
- Markdown：保持滚动位置；新内容更短时停在新的底部。
- Monaco：保持滚动位置与光标所在行；原行超出新内容时夹到末行。

### FR-005：变更合并与内容判重

同一次保存产生的多条事件合并为一次刷新；文件被重写为与当前内容完全相同时不刷新；刷新
以最终落盘内容为准。打开过程中发生的修改不丢失：窗口完成加载后显示最终内容。本地与远程
两种后端遵循同一组行为。

### FR-006：源文件不可用与链路降级

- 文件被删除或改名为其它路径：保留最后成功加载的内容，窗口标题追加「文件已删除」标记，
  不关闭窗口、不弹错误框；继续监听原路径，文件重新出现后清除标记并刷新。
- 监听注册失败（路径越界 / 权限不足 / 监听上限 / Core 不可用）：查看器仍显示已读出的
  内容，标题追加「自动刷新不可用」标记，不弹错误框；Core 恢复就绪后重新尝试注册。
- 内容读取失败（本地被占用 / 权限变化；远程 SFTP 失败）：保留最后成功内容，窗口标题
  追加「读取失败」标记；不弹错误框、不关闭窗口，下一次变更事件到达时重试并清除标记。
- SSH 连接中断：远程事件停止；连接恢复后重新注册监听并立即比对一次内容，补齐断线期间
  的修改。

## 边界与错误路径

- Core 只监听当前查看器的一个文件，不监听目录树；监听路径必须落在该 Core 的工作区根内，
  越界直接拒绝注册并返回错误。
- 文件内容不经总线传输：事件只带路径与元数据，大文件不占用帧通道；宿主经 SFTP 读取内容。
- Core 侧事件去抖后仍可能重复，宿主侧按内容判重兜底：内容未变不刷新。
- 远程文件被重命名到其它路径按删除处理，不自动跟随新路径；原路径重新出现才恢复。
- 监听注册失败不阻塞查看器打开：内容先经 SFTP 读出并显示，再显示「自动刷新不可用」标记。
- 刷新失败不弹错误框（查看器窗口没有确认 UI），只记日志并更新标题标记。
- 窗口在后台时照常刷新内容，但不置前、不抢焦点。
- 窗口销毁与事件到达竞态：投递前检查窗口存活，已销毁则丢弃；这是设计允许的瞬时状态，
  no-op 并记日志。
- 工作区关闭会销毁对应 Core 进程与全部监听；仍打开的查看器保留最后内容，不自动关闭。
- 路径匹配按各平台语义（Windows 大小写不敏感，macOS / Linux 按文件系统语义）；同一文件
  的不同路径写法不重复注册。
- 本地网络盘 / 云盘的文件事件不可靠时不引入轮询兜底：没有事件就没有刷新，不假装保证。
- Core 的文件监听后端按 Core 产物平台（Windows / Linux）实现；远端平台范围与 Core 产物一致。

## 非目标

- SFTP 轮询后端：本期改为 Core 主动推送，不保留轮询；需要 Core 不可用时的兜底时另立 spec，去向 [TODO.md](../../../../TODO.md)（落地时登记）。
- 远端文件树 / 多文件监听：本期只监听当前查看器文件，文件树刷新仍走 US-42 的刷新按钮。
- 本地文件也走 Core 推送：本地保留宿主文件系统事件，统一后端不在本期范围。
- Markdown 内嵌相对路径图片的加载与刷新：data URL 页面没有 base URL，属独立缺口，去向 [TODO.md](../../../../TODO.md)（落地时登记）。
- 查看器写回、外部修改与用户编辑的冲突确认（查看器保持只读）。
- 多查看器窗口或每个查看器独立名额（维持既有单名额顶替）。
- 监听去抖参数与刷新节流阈值做成配置项。
- VS Code 宿主：其编辑器自身随文件更新，新增的宿主投递成员在 VSCode 为 no-op。
- 非 Core 产物平台的远端主机（与 Core 产物范围一致）。

## 对需求基线的影响

- 修改 [US-38](../../../../docs/features/user-stories.md#us-38-文件与虚拟文档预览)：新增验收 6「本地与远程查看器在源文件被外部修改后自动刷新，并保持缩放 / 滚动 / 光标位置；远程由 Core 主动推送；虚拟文档不刷新」。
- 修改 [US-42](../../../../docs/features/user-stories.md#us-42-侧栏文件浏览器)：验收 6 补充「本地与远程双击打开后源文件更新都自动刷新」。
- 无新增 US：本次是既有预览与文件打开行为的细化，不新增入口或宿主。
- e2e 登记：扩展 `e2e/electron/preview.spec.ts` 覆盖本地三类查看器刷新与删除标记；远程真实 SSH 端到端沿用既有 US-42 远程豁免口径，由 `core-rs` 的监听测试与 `src/test/viewerWatch.test.ts` 的假总线 / 假 Core 覆盖推送、注销、重注册与降级。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/ElectronUIHost.ts`（查看器打开后启动监听）、`electron/imageViewer/main.ts`、`electron/monaco/main.ts`、新增 `electron/markdownPreload.ts` | `e2e/electron/preview.spec.ts`（本地三类查看器刷新）、`src/test/viewerWatch.test.ts`（远程推送刷新） | 自动 |
| FR-002 | `src/shared/AssistantEventBus.ts`（`CoreEvent.workspaceFileChanged`）、`core-rs/src/file_watch.rs`、`core-rs/src/main.rs`、`src/host/WebViewUI.ts`（事件 handler）、`src/host/UIHost.ts`（投递成员）、`electron/ElectronUIHost.ts`（路由到查看器） | `core-rs` 监听测试（去抖 / 删除 / 重建 / 越界拒绝）、`src/test/viewerWatch.test.ts`、`src/test/docsLint.test.ts` | 自动 |
| FR-003 | `src/shared/AssistantEventBus.ts`（`UiRequest.watchWorkspaceFileRequested` / `unwatchWorkspaceFileRequested`）、`src/host/Client.ts` / `Connection.ts`（按工作区路由与重注册）、`src/host/bootstrapCore.ts`（复用 `onWorkspaceConnectionState`）、`electron/ElectronUIHost.ts`（watchId 生命周期） | `src/test/viewerWatch.test.ts`（注销、顶替、换文件、Core 重启重注册、迟到事件丢弃）、`src/test/clientConnection.test.ts`（watch / unwatch 按工作区路由）；AC-14 工作区关闭由 Core 进程销毁保证（无自动覆盖：多窗口进程生命周期不驱动） | 自动 |
| FR-004 | 三个查看器渲染端页面；`electron/monaco/main.ts`（`saveViewState` / `restoreViewState`） | `e2e/electron/preview.spec.ts`（图片缩放 / Markdown 滚动保持；Monaco 内容刷新）；Monaco 滚动 / 光标保持无自动覆盖（滚动 DOM 在 viewer 中不稳定，人工验证） | 自动 |
| FR-005 | `core-rs` 事件去抖 + 宿主内容判重 | `core-rs` 监听测试、`src/test/viewerWatch.test.ts`（原子保存、重复内容、连续事件合并、注册后补读） | 自动 |
| FR-006 | `electron/ElectronUIHost.ts`（标题标记与重试）、`core-rs` 监听错误处理、`src/host/WebViewUI.ts` | `src/test/viewerWatch.test.ts`（注册失败、读取失败、断线重连、删除 / 重建）、`e2e/electron/preview.spec.ts`（本地删除标记） | 自动 |

## 待澄清

无。

## 收敛记录

- 已满足：
  - FR-001 / AC-1 ～ AC-3：本地 Markdown / 图片 / Monaco 刷新由 `e2e/electron/preview.spec.ts` 三条用例覆盖；`src/test/viewerWatch.test.ts` 与 `src/test/localFileWatch.test.ts` 覆盖本地分支。
  - FR-002 / AC-4 ～ AC-6：Core 推送链路由 `core-rs/src/file_watch_tests.rs` 5 条用例（越界拒绝 / 原子保存一次 changed / 删除重建 / unwatch / 同 id 替换）与 `viewerWatch.test.ts`（远程 changed、删除标记、重建清除）覆盖；`docsLint` 锁定 `workspaceFileChanged` 的载荷与触发点。
  - FR-003 / AC-7、AC-11 ～ AC-15：`viewerWatch.test.ts` 覆盖迟到 watchId、关闭 / 顶替 / 换文件注销、Core 重启重注册与补读；`clientConnection.test.ts` 覆盖 watch / unwatch 按工作区路由。AC-14 的工作区关闭由 Core 进程销毁保证（无自动覆盖，见偏差）。
  - FR-004 / AC-8 ～ AC-10：e2e 覆盖图片缩放保持、Markdown 滚动保持、Monaco 内容刷新；Monaco 滚动 / 光标保持由 `saveViewState` / `restoreViewState` 实现，无自动覆盖（见偏差）。
  - FR-005 / AC-16 ～ AC-19：Rust 原子保存 / 去抖测试、`localFileWatch` 原子保存测试、`viewerWatch` 相同内容不刷新与注册后补读。
  - FR-006 / AC-20 ～ AC-22：`viewerWatch` 注册失败、读取失败、Connection ready 重试；e2e 本地删除标记。
  - 契约与文档：`npm run test:all -- docs-lint` 46/46；CoreEvent 28、UiRequest 13、UIHost 21 与代码一致。
  - 全量验证：`npm run check-types`、`npm run lint`、`npm run build:core:host`、`npm run test:all`（65/65）、`CARGO_BUILD_TARGET=x86_64-pc-windows-msvc npm run test:core`（905/905）、`e2e/electron/preview.spec.ts`（3/3）。本机 ARM64 直跑 `cargo test` 受 zig cc / MSVC link.exe 的 COMDAT 兼容性限制，改用 x86_64 target 验证；属环境限制，不是代码偏差。
- 偏差：无行为偏差。收敛时按实际证据修正追溯矩阵两处覆盖口径：AC-10 Monaco 滚动 / 光标保持、AC-14 工作区关闭改为「无自动覆盖 + 理由」（前者 Monaco 滚动 DOM 在 Electron viewer 中不稳定，后者由 Core 进程销毁保证、多窗口进程生命周期不驱动）；spec 行为未变，改动已留痕于矩阵。
- 未做：无。`tasks.md` 15/15 已勾选。

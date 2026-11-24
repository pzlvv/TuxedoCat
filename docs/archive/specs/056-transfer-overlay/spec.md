---
status: 已收敛
---

# 改动规格：`Transfer` 支持 Overlay 对话的视图端

Overlay 对话（`storage: isolated`）里的工具与 Bash 看到的是「真实工作区 + 本对话改动」的
叠加视图，而跨工作区传输目前两端一律按真实磁盘 / SFTP 取放。于是同一个对话里出现两种
视角：`Read` 能看到对话内新建的文件、`Bash` 能列出对话内删除后的目录，`Transfer` 却把
磁盘上的旧副本搬出去、把别人工作区的内容直接写进磁盘——搬出去的与搬进来的都不是这个
对话看到的那个文件系统。

本改动让「属于发起对话工作区的那一端」按该对话的叠加视图取放，另一端仍按真实磁盘 /
SFTP。判定与视图取放都由发起方 Core 负责（视图在它的私有命名空间里，宿主读挂载点只能
得到空目录）；宿主的搬运编排、两端解析守卫与卡片口径不变。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [FR-003 传输语义](../../docs/features/cross-workspace-transfer.md#fr-003传输语义) | 修改 | 「两端都是真实文件系统」的隐含前提改为「视图端按视图、另一端按磁盘 / SFTP」 |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [行为规格](../../docs/features/cross-workspace-transfer.md#行为规格) | 修改 | 新增 2.4「视图端的取放与失败语义」；守卫矩阵补视图端路径范围与视图不可用两项 |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [4. 边界与错误路径](../../docs/features/cross-workspace-transfer.md#4-边界与错误路径) | 修改 | 补视图端各行（视图不可用 / 路径越界 / 大文件 / 中止后暂存清理） |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [7. 追溯矩阵](../../docs/features/cross-workspace-transfer.md#7-追溯矩阵) | 修改 | 补本次新增需求行 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 5 节 工具语义](../../docs/core/conversation-work-view.md#5-工具语义) | 修改 | 经代理代执行的工具枚举补 `Transfer`：视图端的取放同样只经代理，宿主不读挂载点 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [2.2 CoreRequest](../../docs/architecture/events.md#22-corerequestcore--ui请求-响应) | 修改 | `crossWorkspaceTransferRequested` 载荷补「发起方 Core 的本端是否按视图取放」这一事实 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [4. 契约](../../docs/core/standalone-core.md#4-契约) | 修改 | `UiRequest` 增视图文件 IO 请求（宿主与视图之间搬运字节的唯一通道） |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 2 节 宿主侧的 core 事实读取](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取) | 修改 | 例外表补视图文件 IO：视图内容只能经 Core 读写 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-60 跨工作区文件传输](../../docs/features/user-stories/desktop.md#us-60-跨工作区文件传输) | 修改 | 验收标准补一条 Overlay 对话口径 |

## 用户场景与验收标准

- 场景 1：从 Overlay 对话搬出
  - **AC-1**（FR-001）：GIVEN 对话归属是 `isolated` WHEN 调用 `Transfer` 且本对话工作区是源端 THEN 该端的目录列举与文件内容取自本对话的叠加视图，另一端按真实磁盘 / SFTP。
  - **AC-2**（FR-002）：GIVEN 对话内新建了磁盘上不存在的 `a.txt` WHEN 把它传到另一个工作区 THEN 目标端出现与该对话内内容一致的 `a.txt`，磁盘上本对话工作区仍没有 `a.txt`。
  - **AC-3**（FR-002）：GIVEN 对话内修改了 `f.txt` WHEN 把 `f.txt` 传出去 THEN 目标端内容等于视图内容，磁盘上的 `f.txt` 仍是修改前的版本。
  - **AC-4**（FR-002）：GIVEN 对话内删除了磁盘上仍存在的 `f.txt` WHEN 把所在目录传出去 THEN 目标端不含 `f.txt`（不搬磁盘上的旧副本）。
- 场景 2：搬进 Overlay 对话
  - **AC-5**（FR-003）：GIVEN 对话归属是 `isolated` 且本对话工作区是目标端 WHEN 从另一个工作区传入 `a.txt` THEN 传完后该对话的 `Read` / `Bash` 能看到 `a.txt`，磁盘上没有 `a.txt`，其他对话也看不到它。
  - **AC-6**（FR-003）：GIVEN 目标端在视图里已有同名文件 WHEN 传入同名文件 THEN 视图内同名文件被覆盖、目标端多余项保留、父目录自动创建（与 FR-003 既有语义一致）。
  - **AC-7**（FR-003）：GIVEN 视图端是目标端 WHEN 传输中途被 abort THEN 传输取消，视图里既无半写文件也无 `.tuxedo-transfer-tmp` 暂存件，已完成文件保留。
- 场景 3：视图端的事实来源与范围
  - **AC-8**（FR-001）：GIVEN 对话归属由 Core 记录 WHEN 宿主决定哪一端按视图取放 THEN 判定取自 Core 随请求给出的那项事实，宿主不读 `meta.json` 也不重算。
  - **AC-9**（FR-004）：GIVEN 视图端路径落在该对话工作区之外 WHEN 调用 `Transfer` THEN 工具错误与工具路径越界同族，两端零写入，且不读真实磁盘上的该路径。
  - **AC-10**（FR-005）：GIVEN 对话归属是 `isolated` 但视图建立失败（代理缺失 / 挂载失败） WHEN 调用 `Transfer` THEN 工具错误点名原因，两端零写入，不退回真实磁盘。
  - **AC-11**（FR-006）：GIVEN 非 Overlay 对话 WHEN 调用 `Transfer` THEN 两端解析守卫、确认框、统计行、文件清单与中止语义与改动前逐项一致。
  - **AC-12**（FR-006）：GIVEN 视图端参与了传输 WHEN 看工具结果与卡片 THEN 两端身份仍是真实工作区路径，结果里不出现视图内部路径。
  - **AC-13**（FR-003）：GIVEN 视图端要搬运的文件远大于单块上限 WHEN 传输完成 THEN 内容逐字节一致，传输过程不因大小整体失败。
  - **AC-14**（FR-007）：GIVEN 将来子代理继承了发起对话的 `isolated` 归属 WHEN 该子代理调用 `Transfer` THEN 视图端判定取自它自己的归属（无需为继承再加改动），视图不可用时仍拒绝而不退回磁盘。

## 功能需求

### FR-001：视图端的判定

- Overlay 对话调用 `Transfer` 时，**属于该对话工作区的那一端**按该对话的叠加视图取放，
  另一端按真实磁盘 / SFTP 取放。跨工作区守卫（至少一端是本对话工作区）已经保证任何一次
  传输都会涉及本对话工作区，因此 `storage: isolated` 的对话不存在「两端都走磁盘」的形态。
- 「本对话这一端按视图取放」是**发起方 Core 的事实**：它随
  `CoreRequest.crossWorkspaceTransferRequested` 告知宿主，宿主据此选择该端的通道。宿主
  不读会话落盘的 `storage`、不缓存、不重算——归属的 owner 仍是 Core
  （[docs/core/conversation-work-view.md 第 2 节](../../docs/core/conversation-work-view.md#2-归属)）。
- 另一端永远是真实工作区：叠加视图是**对话私有**的，工作区身份不指向任何对话的视图。

### FR-002：视图端作为源

- 目录列举与文件内容都取自视图：包含对话内新建的文件、取修改后的版本、不含对话内删除的
  文件（磁盘上仍有也不算存在）。
- 递归、覆盖合并、符号链接跳过、类型冲突报错、暂存 + 改名落盘的语义与真实磁盘端逐项一致
  （[FR-003](../../docs/features/cross-workspace-transfer.md#fr-003传输语义)）。
- 视图内容只经 Core 取：宿主读 Core 私有挂载命名空间里的挂载点只能得到空目录
  （[docs/core/conversation-work-view.md 第 4 节](../../docs/core/conversation-work-view.md#4-命名空间)）。

### FR-003：视图端作为目标

- 写入落在该对话的视图上层：传输完成后本对话的工具与 Bash 立即可见，磁盘不变，其他对话
  与普通对话不可见。
- 同名文件覆盖、同名目录逐项合并、目标端多余项保留、目标父目录自动创建。
- 逐文件「暂存名 + 改名」：成功前目标端不出现半写文件；失败 / 中止时暂存文件从视图里清掉
  （不留在 `upper` 里被后续变更清单看见）。
- 大文件分块搬运：内存占用与文件大小无关，不因单文件超过某个体积而整体失败。

### FR-004：视图端的路径范围

- 视图端的路径必须落在该对话的工作区内：叠加只覆盖工作区子树，工作区之外在视图里就是
  真实磁盘。为了让传输与本对话工具看到的范围一致（工具对越界路径一律报错，见
  [docs/core/conversation-work-view.md 第 5 节](../../docs/core/conversation-work-view.md#5-工具语义)），
  视图端的越界路径按工具错误拒绝，两端零写入，不静默读真实磁盘。
- 另一端（真实工作区端）的路径范围不变。

### FR-005：失败即拒绝，不降级

- `storage: isolated` 的对话在视图不可用（视图未建立且建立失败、代理缺失、非 Linux Core）
  时，`Transfer` 直接返回工具错误并点名原因，两端零写入；不退回真实磁盘——那会把「看起来
  搬的是这个对话的文件、实际搬的是磁盘」的形态交给用户
  （[docs/architecture/principles.md 第 1 节](../../docs/architecture/principles.md#1-不过度-fallback)）。
- 该拒绝发生在宿主执行之前：宿主收不到请求，因此不存在「先写了一部分才发现视图不可用」。
- 视图在首次需要时按需建立；建立成功则照常搬运。

### FR-006：不变的部分

- 两端解析与守卫（缺省端、未命中 / 歧义、同工作区、双非来源）、空串入参错误、权限确认
  文案、能力位、提示词、统计行与文件清单格式、卡片口径、中止映射全部不变。
- 工具结果与卡片里的两端身份仍是真实工作区路径，不出现视图内部路径（挂载点、`upper/`）。
- 视图内部的实现路径不进入工具入参：模型给的是真实工作区路径，与不带隔离的对话一致。

### FR-007：与「子代理继承 Overlay 归属」的兼容

- 本规格判定视图端所依据的事实是**「发起这次传输的会话本身此刻的归属」**，不是「会话是不是
  用户直接创建的主对话」。因此「子代理继承发起对话的 Overlay 归属」这项后续改动落地后，继承
  到 `isolated` 的子代理会话调用 `Transfer` 时自动获得同一份视图语义，本规格不需要再改一遍。
- 由此推出的两条约束：
  - `isolated` 会话的 `Transfer` **不允许**在「视图取不到」时静默退回磁盘（FR-005）——否则
    继承落地后子代理会在用户不知情时把主对话的改动漏在视图里、搬磁盘上的旧版本。
  - 视图端判定只依赖**该会话自己的**归属：不向上查父会话、不读别的会话的视图。会话归属是
    Core 的单一事实（[docs/core/conversation-work-view.md 第 2 节](../../docs/core/conversation-work-view.md#2-归属)），
    继承语义将来由归属本身表达，`Transfer` 不重复解释一次。
- 反向约束：本规格**不**因为「将来会继承」而给子代理加特例分支。现在归属为 `workspace` 的
  会话（含全部子代理）走的路径与改动前逐项一致，判定里不存在「是子代理就……」的谓词。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 非 Overlay 对话 | 完全走既有磁盘 / SFTP 通道，行为与改动前一致 |
| Overlay 对话 + 视图尚未建立 | 首次需要时按需建立，成功则照常搬运 |
| Overlay 对话 + 视图建立失败 | 工具错误点名原因，两端零写入，不退回磁盘 |
| 视图端路径越出工作区 | 工具错误（与工具路径越界同族），两端零写入 |
| 源端在视图里是目录、目标端同名项是文件（或反之） | 类型冲突错误，已完成项保留 |
| 目标端已有同名文件 / 多余文件 | 覆盖 / 保留（既有语义） |
| 传输中途 abort | 取消；视图与磁盘都不留半写文件与暂存件，已完成文件保留 |
| 另一端远程工作区未就绪 / 无可用凭证 | 既有错误文案，零写入 |
| 视图端单文件远大于单块上限 | 分块搬运，内容逐字节一致 |
| 视图端在列举过程中会话被关闭 | 该次传输报错，已搬完的文件保留，暂存件清理 |
| Windows Core（无 Overlay 能力） | 不存在 `isolated` 对话，本规格路径不进入 |
| 目标是另一个对话的叠加视图 | 不可达：端按工作区身份寻址，视图是对话私有的事实 |

## 非目标

- 不支持「把一个对话的叠加视图作为另一端」：视图按会话私有，`Transfer` 的端仍是工作区
  身份（要跨对话搬运请先把改动落到磁盘或在同一个对话里用 Bash）。
- 不改变视图的能力探测、部署闸门、生命周期与回收语义。
- 不做差量同步 / 断点续传 / 进度流式上报 / 符号链接本身的复制（沿用既有非目标）。
- 不改变子代理会话的存储归属：本地与跨工作区子代理会话都按 `workspace` 记账，它们调用
  `Transfer` 时两端仍是磁盘 / SFTP（现状，不在本次范围）。让子代理继承发起对话的 Overlay
  归属是**另一项改动**，本次只保证不与它冲突（兼容性约束见 FR-007）。
- 不改卡片渲染：视图端参与时卡片形态不变。

## 对需求基线的影响

- 修改 [US-60](../../docs/features/user-stories/desktop.md#us-60-跨工作区文件传输)：验收标准
  补一条 Overlay 对话口径（属于本对话工作区的那一端按叠加视图取放，视图不可用即拒绝）。
- e2e：`e2e/electron/overlayMountProxyRemote.spec.ts` 增用例（真实 overlay 挂载 + 真实 SSH
  远端；该车道已有代理部署与视图取数的前置）。CI 不提供 overlay 挂载的车道按既有口径
  豁免，核心语义由 core-rs 的命名空间内用例锁定。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `run_transfer` / `TransferRequest`；`core-rs/src/engine.rs` 的 `transfer_hook`；`src/shared/AssistantEventBus.ts` 的 `crossWorkspaceTransferRequested`；`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceTransfer` | `core-rs/src/tools_tests.rs`、`src/test/crossWorkspaceTransfer.test.ts` | 自动 |
| FR-002 | `core-rs/src/main.rs` 的视图文件 IO 请求与 `core-rs/src/work_view_linux.rs` 的代理取数；`src/host/workspaceTransfer.ts` 的端点抽象 | `core-rs/src/work_view_tests.rs`、`src/test/workspaceTransfer.test.ts` | 自动 |
| FR-003 | `core-rs/src/main.rs` 的视图文件写入请求（含暂存 / 改名 / 清理）；`src/host/workspaceTransfer.ts` 的递归与原子落盘 | `core-rs/src/work_view_tests.rs`、`src/test/workspaceTransfer.test.ts` | 自动 |
| FR-004 | `core-rs/src/tools.rs` 的 `run_transfer` 与 `WorkViewState::io_path` 同口径的范围校验 | `core-rs/src/tools_tests.rs` | 自动 |
| FR-005 | `core-rs/src/tools.rs` 的 `run_transfer`（`WorkViewState::ViewUnavailable` 分支） | `core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | 无代码改动（既有守卫、权限、卡片、提示词路径不变） | `src/test/crossWorkspaceTransfer.test.ts`、`src/test/transferCard.test.ts`、`e2e/electron/crossWorkspaceTransfer.spec.ts` | 自动 |
| FR-007 | `core-rs/src/engine.rs` 的 `session_storage` 是唯一归属读点；`run_transfer` 只读它、不查父会话 | `core-rs/src/tools_tests.rs`（归属为 workspace 时行为不变 + isolated 时 fail-closed） | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /implement 填写，结论只分三类。

- 已满足：
  - FR-001（视图端的判定）：`core-rs/src/tools.rs` 的 `run_transfer` 按 `ToolContext.work_view`
    三态判出 `origin_in_view`，`engine.rs` 的 `transfer_hook` 透传 `originInView` /
    `sourceRelative` / `targetRelative`；宿主 `planTransferChannels` 只消费这个事实。
    证据：`core-rs/src/engine_tests.rs::transfer_hook_roundtrip_and_cancel`、
    `src/test/crossWorkspaceTransfer.test.ts` 的「通道：」五条。
  - FR-002（视图端作为源）：`UiRequest.workViewFileIoRequested` 的 `stat` / `list` /
    `read` 经 `core-rs/src/work_view_linux.rs` 的 `view_*` 转代理；`viewEndpoint` 的
    `readStream` 按 `WORK_VIEW_IO_CHUNK` 分块。证据：
    `src/test/workspaceTransfer.test.ts` 的「视图端点：递归搬运」/「分块读过 4 字节的边界」、
    `core-rs/src/work_view_tests.rs::work_view_file_io_writes_reads_and_renames_in_the_view`。
  - FR-003（视图端作为目标）：`write` 定向写 + `renamePath` 覆盖语义 + `unlinkPath` 清理；
    执行器的暂存改名语义在视图端点上原样生效（执行器一行未改）。证据：同上「暂存件不留在
    视图里」、「暂存件不留在视图里 / 目录也建出来了」两条，以及命名空间用例
    `work_view_file_io_writes_reads_and_renames_in_the_view` 的「改名必须覆盖目标内容」。
  - FR-004（路径范围）：`transfer_view_relative` 在 Core 侧算出相对路径、越界为 `None`；
    `viewEndpoint.relative` 在宿主侧再拒一次，Core 的 `check_view_relative` 第三次拒。
    证据：`core-rs/src/tools_tests.rs::transfer_view_relative_derivation`、
    `src/test/workspaceTransfer.test.ts` 的「工作区之外的路径被拒绝」。
  - FR-005（失败即拒绝）：`run_transfer` 的 `ViewUnavailable` 分支在发请求前返回工具错误，
    宿主收不到请求；`viewEndpoint` 把 `ok: false` 翻成异常，读流走 `error` 事件。
    证据：`core-rs/src/tools_tests.rs::transfer_view_unavailable_is_rejected_before_the_host`
    （断言钩子零调用）、`src/test/workspaceTransfer.test.ts` 的两条失败语义用例、
    `core-rs/src/main_tests.rs::work_view_file_io_request_reports_missing_arguments_and_unmounted_view`。
  - FR-006（不变的部分）：两端解析守卫、入参校验、权限、卡片、提示词一行未改；
    非 Overlay 会话的 `originInView` 恒 `false`，通道选择退化为原来的 fs / SFTP。
    证据：`src/test/crossWorkspaceTransfer.test.ts` 的「非 Overlay 会话两端都不是视图端」、
    既有 `e2e/electron/crossWorkspaceTransfer.spec.ts` 用例未改动且仍应绿。
  - FR-007（与子代理继承的兼容）：判定只读 `ToolContext.work_view`（即该会话自己的归属），
    不查父会话、不读别的会话的视图，也没有「是子代理就……」的特例分支。
    证据：`run_transfer` 的实现本身 + `transfer_view_unavailable_is_rejected_before_the_host`
    （fail-closed 在继承落地后就是子代理需要的语义）。
- 偏差：
  - 契约成员形态：spec/plan 里写的是「`UiRequest` 的 `op` 与 `path` 平铺在请求顶层」，
    实现改成 `sessionId` + `payload`（判别联合 `WorkViewFileIoPayload`）。原因：`UiRequest`
    的成员抽取与事件表的载荷列按「顶层一个判别字段」解析，七个 `op` 平铺成七个联合成员会
    让 `UiRequest` 的成员数与名字都失去意义（docsLint 实测报 25 个成员）。改成嵌套后
    `UiRequest` 仍是 19 个成员，判别联合在 `payload` 上闭合。文档已按实现写（[第 1.1 节](../../docs/core/conversation-work-view.md#11-按会话读取视图内容)、
    [事件成员表](../../docs/features/cross-workspace-transfer.md#23-事件成员) 与 [boundaries 例外表](../../docs/core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。
  - 代理 IPC 版本：plan 预估「新增 op 需要 IPC +1」，实际是 1 → 2，且 `writeFile` 的
    `offset` 保持**可选**（缺省即老的整文件写），因此 `Write` 工具那条路径的帧形态不变。
  - 定向写去掉 `append` 字段：plan 原本设计了 `offset` + `append` 两个字段，实现时收敛成
    「从 offset 写并把文件截断在写入末尾」一条语义——传输的写流按 offset 递增分块，`append`
    永远是 `false`，留一个不会取其它值的必填布尔只是契约噪音。`payload` 因此少一个成员，
    代理 `/ Write` 工具那条老路径不受影响。
- 未做：
  - 无。T015 的 e2e 用例已写（`US-60 FR-009 Overlay 会话的 Transfer 按视图取放`），
    但 `electron-ssh` 车道需要真实远端 + 已装代理，本机未执行——收敛按「实现与单测证据」
    判定，e2e 的实际运行留给该车道（与既有 overlay 车道同一口径）。

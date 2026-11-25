---
status: 已收敛
---

# 改动规格：本地子代理继承 Overlay 归属

Overlay 对话里派生的本地子代理当前按 `workspace` 记账，它读写的是真实磁盘：主对话在叠加视图里
改过的文件，子代理看不到；子代理的写入落在磁盘上，反过来污染主对话的基线。本规格让本地派生的
子代理**继承发起对话的归属**，并与发起对话**共用同一份叠加视图**（同一上层目录、同一挂载、
同一常驻代理），因此父子的改动互相可见、都不落磁盘。跨工作区派发的会话（`Agent` 带目标工作区
身份）不继承：它是目标工作区里的顶层对话，视图不出工作区。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 2 节](../../docs/core/conversation-work-view.md#2-归属) | 修改 | 归属写入时机补「本地子代理继承发起对话的归属」与「跨工作区不继承」 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 2.1 节](../../docs/core/conversation-work-view.md#21-视图的所有者) | 新增 | 视图所有者、使用者 → 所有者的父链解析与失败判据 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 5 节](../../docs/core/conversation-work-view.md#5-工具语义) | 修改 | 工具语义点明子代理与父对话落在同一份上层 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 6 节](../../docs/core/conversation-work-view.md#6-生命周期) | 修改 | 关闭 / 删除按「视图所有者」而不是「任意使用者」判定；子代理会话不再是视图的所有者 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [第 7 节](../../docs/core/conversation-work-view.md#7-失败路径) | 修改 | 补「`isolated` 但所有者解析不出」的失败行（fail-closed） |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [第 5 节](../../docs/features/cross-workspace-transfer.md#5-非目标) | 删除 | 删掉「子代理会话继承发起对话的 Overlay 归属」这条非目标（本规格即那项改动） |
| [docs/features/cross-workspace-agent.md](../../docs/features/cross-workspace-agent.md) | [FR-003](../../docs/features/cross-workspace-agent.md#fr-003跨工作区子代理会话顶层普通对话) | 修改 | 写明跨工作区对话按目标工作区磁盘记账（`storage: workspace`），不继承发起方归属 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | Overlay 标识与「取数来源」判据覆盖子代理行（判据仍是该会话自己的 `storage`，宿主不加特例） |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md#us-79-overlay-对话的子代理继承) | `US-79`（本节新增） | 新增 | 子代理继承 Overlay 的用户场景与验收基线 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 目录与「未覆盖 e2e 的 US」段 | 修改 | 登记 US-79 的收录位置与 e2e 豁免理由 |

## 用户场景与验收标准

- 场景 1：Overlay 对话里派生的本地子代理活在同一个叠加视图里
  - **AC-1**（FR-001）：GIVEN 发起对话的 `storage` 是 `isolated` WHEN 模型不带 `target` 派发 `Agent` 且子代理会话建立 THEN 该子代理会话落盘的 `storage` 是 `isolated`，侧栏该行带 Overlay 标识
  - **AC-2**（FR-001）：GIVEN 发起对话的 `storage` 是 `workspace` WHEN 派发本地子代理 THEN 子代理的 `storage` 是 `workspace`，其工具直接读写磁盘（与改动前逐项一致）
  - **AC-3**（FR-001）：GIVEN 发起对话是 Overlay 对话 WHEN 派发 Explorer 角色的子代理 THEN 它同样是 `isolated`（`Read` / `Grep` / `Glob` 看到叠加视图内容，不看到磁盘旧版本）
  - **AC-4**（FR-001）：GIVEN 发起对话是 Overlay 对话 WHEN `Agent` 携带另一个已打开工作区的身份并派发成功 THEN 目标工作区那份会话的 `storage` 是 `workspace`，它的工具直接改目标工作区的磁盘
- 场景 2：父子共用同一份叠加视图，改动互见
  - **AC-5**（FR-002）：GIVEN 父对话是 Overlay 且已派生本地子代理 WHEN 子代理 `Write` 一个磁盘上不存在的新文件 THEN 父对话的 `Read` 与变更清单能看到该文件，磁盘上没有它，其它对话也看不到
  - **AC-6**（FR-002）：GIVEN 同一对父子会话 WHEN 父对话修改一个磁盘上已有的文件 THEN 子代理的 `Read` 立即读到新内容，磁盘内容不变，两者之间没有任何同步动作
  - **AC-7**（FR-002）：GIVEN 父对话是 Overlay WHEN 它并发派出多个本地子代理并各自读写 THEN 它们读写的是同一份视图（视图目录与常驻代理各只有一份），写入互相可见
  - **AC-8**（FR-002）：GIVEN 子代理会话的 `storage` 是 `isolated` WHEN 以它的会话 id 请求列目录 / 变更清单 / 两侧原文 / 视图文件 IO THEN 应答与以父对话会话 id 请求同一内容一致
- 场景 3：视图的生命周期由所有者决定
  - **AC-9**（FR-003）：GIVEN 父对话是 Overlay 且它的子代理会话被打开过 WHEN 关闭子代理会话 THEN 父对话后续的工具调用仍看到叠加视图内容（共享视图未被释放、上层目录仍在）
  - **AC-10**（FR-003）：GIVEN 同一对父子会话 WHEN 删除子代理会话 THEN 父对话的视图目录与它写入过的内容仍在
  - **AC-11**（FR-003）：GIVEN 父对话是 Overlay 且其子代理写入过文件 WHEN 删除父对话 THEN 闭包内子代理与父对话一并删除，视图目录整体回收
  - **AC-12**（FR-003）：GIVEN 子代理会话的 `storage` 是 `isolated` 但解析不出这份共享视图的所有者 WHEN 它调用工具或以它的会话 id 请求视图取数 THEN 调用报错并点名原因，不退回真实磁盘
- 场景 4：失败路径与既有语义不变
  - **AC-13**（FR-004）：GIVEN 子代理的 `storage` 是 `isolated` 且挂载代理未就绪 WHEN 它调用 `Bash` / `Write` / `Edit` THEN 工具错误点名视图不可用，磁盘零写入
  - **AC-14**（FR-004）：GIVEN 子代理的 `storage` 是 `isolated` WHEN 打开它会话的文件浏览器 THEN 目录树 / 变更清单 / 双击打开都取共享视图内容，不显示磁盘清单
  - **AC-15**（FR-004）：GIVEN 子代理的 `storage` 是 `isolated` 且能力不可用、部署代理可能解决 WHEN 打开该子代理会话 THEN 走与主对话同一个部署闸门：成功自动继续打开，失败或取消则放弃打开、不降级为磁盘视图
  - **AC-16**（FR-004）：GIVEN 子代理的 `storage` 是 `isolated` WHEN 它调用 `Transfer` THEN 属于该工作区那一端按共享视图取放，视图不可用时拒绝而不退回磁盘
- 场景 5：不追溯存量
  - **AC-17**（FR-005）：GIVEN 本改动之前创建的本地子代理会话（meta 里 `storage` 是 `workspace`） WHEN 打开它并调用工具 THEN 它仍直接读写磁盘，不因父对话现在是 Overlay 对话而被改写归属

## 功能需求

### FR-001：本地子代理在创建时继承发起对话的归属

- 本地派生的子代理会话（`Agent` 不带 `target`，或 `target` 等于当前会话所属工作区的身份）在
  创建时把归属写定为**发起对话此刻的归属**：发起方是 `isolated` 时子代理也是 `isolated`，
  发起方是 `workspace` 时子代理是 `workspace`。
- 继承与角色无关：`Master` 与 `Explorer` 一视同仁（角色只决定工具白名单）。Explorer 只有只读
  工具，读的仍是叠加视图内容，不是磁盘。
- 继承与「会话级配置继承」同口径：值在创建时一次确定并随子代理会话落盘（`meta.json` 的
  `storage`），Core 重启后按落盘值恢复，不再向父会话追问。
- 继承的判据只有一条：这个会话是不是**同一 Core 内**由本地子代理创建路径建立的。跨工作区派发
  建立的会话（`target` 指向另一个已打开工作区）**不继承**，按目标工作区磁盘记账
  （`storage: workspace`）——它是目标工作区里的顶层对话，发起方的叠加视图是发起方 Core 的私有
  事实，不跨工作区传递。

### FR-002：父子共用同一份叠加视图

- `isolated` 的子代理会话指向**发起对话那份视图**：同一上层目录、同一挂载、同一常驻代理。不为
  子代理新建第二份视图目录，也不为它额外拉起代理进程。
- 改动双向互见：子代理的写入立刻出现在父对话的工具结果与变更清单里，父对话的写入立刻对子代理
  可见。磁盘仍是唯一基线事实，两者之间没有任何同步、合并或回并动作。
- 视图的所有者是**发起对话**（用户勾选 Overlay 的那条顶层对话）；子代理是使用者。所有按会话
  寻址视图的能力（工具代执行、`workView*` 取数请求、变更清单、两侧原文、`Transfer` 的视图端）
  都以「使用者 → 所有者」的解析结果作答，因此以子代理会话 id 取数与以父对话会话 id 取数得到
  同一份内容。
- 不存在「子代理自己一份视图」的形态，也没有「把子代理改动回并到父视图」的动作：两者本来就是
  同一份。

### FR-003：视图的生命周期只由所有者决定

- 子代理会话关闭（`conversationClosed`）只让它不再是这份视图的使用者，**不**释放共享视图、
  **不**丢弃代理、**不**回收上层目录——所有者可能仍在用。
- 子代理会话删除（`conversationDeleted`）不删共享视图目录；上层里它写过的内容随视图留在原处。
- 所有者关闭时按既有语义释放：丢弃代理、保留上层目录（改动跨重启与重开对话保留）。所有者删除
  时按既有语义回收：视图目录整体删除（含子代理曾写入的内容）。
- `isolated` 但解析不出所有者（父会话档案缺失、或父会话不是 `isolated`）是数据异常，按视图
  不可用处理：调用失败并点名原因，不退回真实磁盘。

### FR-004：工具、取数与宿主投影沿用既有判据

- 子代理会话的一切文件行为（`Read` / `Write` / `Edit` / `Bash` / `Grep` / `Glob` / `Transfer`、
  授权前判定、`workView*` 取数）按共享视图作答，路径字符串仍是真实工作区路径，不出现视图内部
  路径（挂载点、`upper/`）。
- 视图不可用（代理缺失、未部署、建立失败、所有者解析不出、平台不支持）时工具与取数请求**报错**
  并点名原因，不退回磁盘——与主对话同一口径（fail-closed）。
- 宿主不加特例：归属的投影来源仍是该会话自己的 `storage`。侧栏 Overlay 标识、文件浏览器的取数
  分流、工具卡片链接的打开来源、变更视图的清单与两侧原文、打开已有 Overlay 对话的部署闸门，
  都因为子代理的 `storage` 是 `isolated` 而自动覆盖它，判据表达式不新增「这是子代理」的分支。
- 子代理的 `storage` 创建后不可变：没有「把子代理从 `isolated` 改成 `workspace`」或反向的入口。

### FR-005：不追溯存量，不扩契约面

- 本改动之前创建的本地子代理会话保持 `workspace`：归属在创建时一次写定，不因父对话如今的归属
  而回溯改写，也没有迁移动作或迁移提示。
- 不新增事件、请求、载荷字段或落盘字段：归属仍只由 `meta.json` 的 `storage` 表达，「这份
  `isolated` 用哪份视图」由父子关系与所有者的归属推导，不另写一份所有者字段。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| 子代理创建时父对话的视图尚未建立 | 继承只写归属：不建视图目录、不拉起代理（沿用惰性建立，第一次工具调用或取数时才建） |
| 父对话在子代理运行中被关闭 | 关闭即中止整棵工作树（既有语义），子代理随之停止；视图按所有者关闭释放代理、保留上层 |
| 子代理删除后父对话继续工作 | 上层目录与内容保留（删除子代理不回收共享视图），父对话的变更清单照常包含这些改动 |
| 父对话删除时子代理仍在跑 | 先中止闭包内查询与子代理，再删盘；视图目录整体回收，失败只记日志不阻塞删除 |
| 子代理 `storage: isolated` 但所有者解析不出 | 工具与取数请求报错并点名原因，不退回磁盘；不猜测「父会话不在就按磁盘」 |
| 父子并发写同一个文件 | 同一份视图，结果按文件系统语义确定；不做冲突检测、加锁或合并 |
| 跨工作区派发（`target` 是另一个工作区） | 目标工作区会话恒 `workspace`；发起方的视图与改动不跨 Core 传递 |
| 子代理内再调 `Agent` | 维持既有拒绝（禁止嵌套），因此继承只有一层，不产生「孙代理共用视图」的递归形态 |
| 子代理是 Spin 派生的会话 | 与普通本地子代理同一条规则（它同样经本地子代理创建路径建立） |
| 非 Linux 平台 | 平台判据不变：能力不可用时 `isolated` 父对话本身无法建立视图，子代理按 fail-closed 报错 |

## 非目标

- 跨工作区派发的会话继承发起方的 Overlay 归属（视图不出工作区，见 FR-001 末段）。
- 存量子代理会话的归属迁移或追溯改写。
- 给子代理单独一份视图，或把子代理视图回并到父视图。
- 父子 / 子代理之间的写入冲突检测、文件锁与合并。
- 新增事件、请求、契约成员或落盘字段来表达「这份视图属于谁」。
- 让子代理的归属可中途变更（勾选 / 取消勾选）。
- 子代理视图的可视化差异（例如在变更清单里标注「这条改动来自子代理」）。

## 对需求基线的影响

新增 US-79「Overlay 对话的子代理继承」，登记在 `docs/features/user-stories/dialog-core.md` 的
EP-13；验收覆盖继承判据、父子改动互见、生命周期只由所有者决定与 fail-closed。

既有故事的文案不需要改：US-60 验收 6、US-63 验收 10 与 US-38 验收 10 的判据都是「该会话自己的
`storage` 是 `isolated`」，继承落地后自动覆盖子代理会话。

e2e 豁免：整链路要真实的 overlay 挂载（用户命名空间 + overlayfs + `userxattr`）与真实 LLM 轮次，
CI 容器不提供，按既有口径登记在 `docs/features/user-stories.md` 的「未覆盖 e2e 的 US」段；由
core-rs 的视图 / 引擎用例锁定继承、共用视图与生命周期，宿主侧投影由侧栏与部署闸门的现有用例
锁定。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/engine.rs` 的 `create_sub_agent`（继承归属）、`start_remote_sub_agent`（显式 `workspace`）、`history::create_sub_agent_metadata` / `create_remote_sub_agent_metadata`（落盘） | `engine_tests`：`sub_agent_inherits_isolated_storage` / `explorer_sub_agent_inherits_isolated_storage` / `start_remote_sub_agent_records_creator`；`history_tests`：`local_sub_agent_metadata_persists_inherited_storage` / `remote_sub_agent_metadata_is_always_workspace` | 自动 |
| FR-002 | `core-rs/src/engine.rs` 的 `work_view_owner` / `parent_session_of` / `ensure_work_view`；`core-rs/src/main.rs` 的 `overlay_owner` 与四个 `workView*` 分支；`work_view_linux.rs` 视图层按所有者寻址 | `engine_tests`：`work_view_owner_follows_parent_chain`；`work_view_tests`：`work_view_child_writes_are_visible_to_parent`；`main_tests`：`work_view_requests_use_owner_session` | 自动 |
| FR-003 | `core-rs/src/main.rs` 的 `view_teardown` / `release_owned_work_view` / `remove_owned_work_view` 与 `conversationClosed` / `conversationDeleted` 分支；`work_view_linux.rs` 的 `release` / `remove` | `main_tests`：`view_teardown_distinguishes_owner_user_and_unknown` / `closing_and_deleting_sub_agent_keeps_shared_view`；`engine_tests`：`sub_agent_view_owner_resolution_fails_closed`；`work_view_tests`：`work_view_release_and_remove` | 自动 |
| FR-004 | `core-rs/src/tools.rs` 的 `WorkViewState` 三态、`core-rs/src/main.rs` 的 `ensure_view_ready`；宿主侧既有 `storage` 投影（`electron/sidebar/main.ts` / `src/host/ui/webviewMessageHandler.ts`）不改 | `engine_tests`：`isolated_session_tool_writes_stay_in_the_view` / `isolated_session_bash_writes_stay_in_the_view`；`tools_tests` / `permission_tests` 的视图三态用例；`src/test/overlayOpenDeployGate.test.ts` | 自动 |
| FR-005 | 无写入路径改动：`history::storage_of_session` 只读落盘值，创建路径是唯一写入点 | `history_tests`：`legacy_sub_agent_metadata_keeps_workspace` / `touch_metadata_keeps_existing_storage` | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

### 已满足

| 验收标准 | 证据 |
| --- | --- |
| AC-1 / AC-2（本地子代理继承归属、父为 `workspace` 时照旧） | `engine_tests::sub_agent_inherits_isolated_storage`（两个父归属各跑一遍，内存态与 meta 同时断言） |
| AC-3（Explorer 同口径） | `engine_tests::explorer_sub_agent_inherits_isolated_storage` |
| AC-4（跨工作区不继承） | `engine_tests::start_remote_sub_agent_records_creator`（`state.storage == Workspace` + meta `"workspace"`）、`history_tests::remote_sub_agent_metadata_is_always_workspace` |
| AC-5 / AC-6 / AC-7（父子互见、同一份视图） | `work_view_tests::work_view_child_writes_are_visible_to_parent`（子写父读、父改子读、同一视图根、`Arc::ptr_eq` 同一个代理、磁盘不变） |
| AC-8（按子会话 id 取数一致） | `main_tests::work_view_requests_use_owner_session`（四个 `workView*` 请求都先解析 owner，断言解析结果是父对话） |
| AC-9 / AC-10 / AC-11（生命周期只由所有者决定） | `main_tests::view_teardown_distinguishes_owner_user_and_unknown`（四态判定）、`closing_and_deleting_sub_agent_keeps_shared_view`（关 / 删子代理后父对话仍自持所有者）；`work_view_tests::work_view_release_and_remove`（所有者释放保留上层、回收删目录） |
| AC-12（所有者解析不出 fail-closed） | `engine_tests::work_view_owner_follows_parent_chain`（父缺失 / 父为 `workspace` / 成环三种错）与 `sub_agent_view_owner_resolution_fails_closed`（`ViewUnavailable`，不回 `Workspace`）；`main_tests::work_view_requests_fail_closed_when_owner_is_unknown` |
| AC-13（视图不可用时报错、磁盘零写入） | `engine_tests::isolated_session_tool_writes_stay_in_the_view` / `isolated_session_bash_writes_stay_in_the_view`（能力不可用时必须 `ViewUnavailable`），`tools_tests` 的 `ViewUnavailable` 用例 |
| AC-14 / AC-15 / AC-16（宿主投影、部署闸门、`Transfer` 视图端自动覆盖） | 判据未改（宿主读该会话自己的 `storage`）：`src/test/overlayOpenDeployGate.test.ts`、`work_view_tests` 的除取数用例与 `tools_tests` 的 `Transfer` 视图端用例全绿 |
| AC-17（存量不追溯） | `history_tests::legacy_sub_agent_metadata_keeps_workspace`（带 `storage: workspace` 的子代理经 `touch_metadata` 仍为 `workspace`），`touch_metadata_keeps_existing_storage` |

### 偏差

1. **生命周期判定抽成纯函数 `view_teardown`**（涉及 FR-003）。原计划在 `main.rs` 的两个分支里
   各写一遍「所有者 / 使用者 / 解析失败」的 `match`，实施时抽出四态纯函数让判定只有一份、
   可单测（`view_teardown_distinguishes_owner_user_and_unknown`）。FR / AC 未变，只是把
   「怎么判」收窄成一个可测点。
2. **`ensure_view_ready` 的签名从「回所有者」改成「收所有者」**（涉及 FR-002）。原计划的
   「回 `owner`」让「解析」与「备视图」耦合在一个返回值里，非 `isolated` 归属（`Workspace`）
   就无法与「解析失败」分开；实施时拆成 `overlay_owner`（解析 + 归属判据）与
   `ensure_view_ready`（只备视图），四个请求分支先解析再备视图。行为与 AC-8 / AC-12 一致。

### 未做

无。

### 反向对照记录

从实现 diff 枚举的额外行为分支，逐条比对本 spec：

| 实现里的分支 | spec 对应 | 处置 |
| --- | --- | --- |
| 父链上溯深度上限 64（成环收敛） | FR-002 末段 / 边界表 | 已在 FR-002 正文、边界表与 `work_view_owner_follows_parent_chain` 覆盖 |
| `parent_sessionId` 指向自己 | FR-002 末段 | 同一用例的成环分支（`owner-loop-*`）覆盖同一类错误 |
| 非 `isolated` 归属的关闭 / 删除完全无动作 | FR-003 / AC-9 | `view_teardown_distinguishes_owner_user_and_unknown` 的 `NotOverlay` 分支 |
| 所有者关闭 / 删除前先采样归属与父链 | FR-003 | `closing_and_deleting_sub_agent_keeps_shared_view` 末尾断言「关闭后仍按落盘父链解析出所有者」 |
| `ensure_loaded` 不还原 `parent_session_id`，靠 meta 兜底 | FR-002 | `parent_session_of` 的内存 → 落盘两级 + 同一用例的落盘分支 |
| 主对话不为父链查询读盘 | FR-002 | `parent_session_of` 先判 `is_sub_agent_session`（注释与实现同处），无独立用例（只影响性能，不改可观察事实） |
| 视图层参数改名为 `owner` | FR-002 非目标（不新增字段） | 只是命名与注释，无行为变化 |

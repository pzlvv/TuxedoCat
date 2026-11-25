# 实施方案：本地子代理继承 Overlay 归属

技术路线只有一条：**归属跟随创建者，视图按「使用者 → 所有者」解析**。子代理在创建时把归属写成
发起对话此刻的归属并落盘；视图登记表仍按会话 id 建键，但工具与取数在拿句柄前先把「会话 id」
解析成「视图所有者 id」，因此父子拿到的是同一份已挂载视图（同一上层目录、同一个常驻代理）。
需求见同目录 [`spec.md`](spec.md)。

## 技术方案

### 1. 归属继承（FR-001）

`Core::create_sub_agent` 在写 `SessionState` 时多写一格 `storage`：取
`self.session_storage(&creator)`（内存态优先、落盘次之，与读侧同一入口）。同一份值作为参数传给
`history::create_sub_agent_metadata`，由它直接写进子会话 `meta.json` 的 `storage`。

- 不走 `UiEvent.storageChanged`：那条通道的判据是「用户勾选」，且已有消息时拒绝；子代理创建时
  还没有消息，走它只会让「谁写的」变模糊。创建路径本身就是唯一写入点。
- `start_remote_sub_agent` 显式写 `storage: workspace`：跨工作区会话按定义不继承，把它写成显式
  事实而不是「靠缺字段回落」。
- `touch_metadata` 的既有规则（字段缺失才写）保持不动，因此首条消息落盘不会覆盖掉继承值。

### 2. 视图所有者解析（FR-002 / FR-003）

新增 `Core::work_view_owner(session_id) -> Result<String, String>`：沿 `parentSessionId` 上溯，
父会话同样 `isolated` 时继续上溯，到「没有父会话」的那一层即为所有者。

父会话 id 的解析分两级，与归属读侧同构：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 内存态 `SessionState.parent_session_id` | 创建时就写定；子代理运行中命中 |
| 2 | `meta.json` 的 `parentSessionId` | Core 重启 / 会话重新加载后唯一来源（`ensure_loaded` 不还原这一格） |

判据细节：

- 会话不是子代理（内存态的 `is_sub_agent_session()` 为假）→ 直接停在自己，**不读盘**：主对话的
  每次工具调用不能多付一次目录枚举。
- 子代理但两级都查不到父会话 id → `Err`：父会话档案被删掉是数据异常，按视图不可用处理（FR-003
  末段），不猜「父不在就自己一份」。
- 父会话存在但归属是 `workspace` → `Err`：父子的归属链断了，同样是数据异常。
- 上溯深度上限 64：父链成环时 `Err` 而不是死循环。

### 3. 拿视图的三条路径都先解析所有者（FR-002）

| 入口 | 现状 | 改动 |
| --- | --- | --- |
| `Core::ensure_work_view` | 按 `session_id` 登记 / 取回 / 挂载 | 先解析 `owner`，登记、挂载、取句柄全部按 `owner` |
| `main.rs` 的 `ensure_view_ready` | 只回 `Ok(())` | 回 `Ok(owner)`，四个 `workView*` 请求分支把 `owner` 传给视图层 |
| `Core::set_session_storage` | 按 `session_id` 登记 / 释放 | 不变（它只服务用户勾选，作用对象恒为顶层对话） |

视图层函数的签名从「会话 id」改为「所有者会话 id」——改名而不是加参数，调用方漏改就编译不过。
契约不动：请求与事件里仍是 `sessionId`，所有者是 Core 的内部事实。

### 4. 生命周期按所有者判定（FR-003）

`main.rs` 的 `conversationClosed` / `conversationDeleted` 分支在调
`work_view::release` / `remove` 前先看 `work_view_owner(&session_id)`：

- `Ok(owner)` 且 `owner == session_id` → 照既有语义释放 / 回收；
- `Ok(owner)` 且 `owner != session_id` → 使用者关闭 / 删除，**不**碰共享视图（也不删上层目录）；
- `Err(reason)` → 记日志，不碰视图（宁可残留也不误删别人的上层）。

`conversationDeleted` 的整棵闭包删除仍由引擎负责（子代理会话随父会话一起销号），视图目录只在
所有者那一次回收里删一次。

### 5. 宿主投影零改动（FR-004）

宿主的五个消费点（侧栏 Overlay 标识、文件浏览器取数分流、工具卡片链接、变更视图、部署闸门）判据
都是「该会话自己的 `storage` 是 `isolated`」。子代理的 `storage` 从创建起就是 `isolated`，因此这些
判据自动覆盖它——不加「是不是子代理」的分支，也不改契约。

### 6. 不追溯存量（FR-005）

没有迁移代码：`session_storage` 的读侧规则不动（内存 → `meta.json` → `workspace`），存量档案里
`storage: workspace` 就是事实。也没有反向入口：`storageChanged` 的「已有消息即拒绝」保持不动。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/engine.rs` | `create_sub_agent` 写继承归属；新增 `work_view_owner` / `parent_session_of`；`ensure_work_view` 按所有者建视图 | 无（内部事实） |
| `core-rs/src/history.rs` | `create_sub_agent_metadata` 增加归属参数；`create_remote_sub_agent_metadata` 显式写 `workspace` | 无新增字段（沿用 `storage`） |
| `core-rs/src/main.rs` | `ensure_view_ready` 回 `owner`；四个 `workView*` 分支按 owner 取数；`conversationClosed` / `conversationDeleted` 按所有者判定 | 无（请求载荷不变） |
| `core-rs/src/work_view_linux.rs` / `work_view_unsupported.rs` | 视图层函数的参数从「会话 id」改名为「所有者会话 id」，注释点明所有权 | 无 |
| `core-rs/src/engine_tests.rs` | 继承判据（本地 / Explorer / 父为 workspace）、所有者解析与失败分支 | — |
| `core-rs/src/work_view_tests.rs` | 父子共用一份视图（目录与代理各一份、写入互见）、非所有者关闭 / 删除不释放 | — |
| `core-rs/src/main_tests.rs` | `ensure_view_ready` 回 owner 的接线、关闭 / 删除分支的所有者判定 | — |
| `docs/core/conversation-work-view.md` | 归属、生命周期、失败路径三节补继承与所有者语义 | 文档 |
| `docs/features/cross-workspace-transfer.md` | 删掉「子代理继承是另一项改动」那条非目标 | 文档 |
| `docs/features/cross-workspace-agent.md` | FR-003 点明目标侧会话恒 `workspace` | 文档 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏)点明子代理行同判据 | 文档 |
| `docs/features/user-stories/dialog-core.md` | 新增 US-79 | 需求基线 |
| `docs/features/user-stories.md` | 目录收录与「未覆盖 e2e 的 US」段补 US-79 | 需求基线 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全在 `core-rs/`（引擎、落盘、请求分支）；`src/` 与
      `electron/` 零改动，宿主仍是 `storage` 的只读投影。无宿主嗅探、无跨层 import。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：所有者解析失败一律 `Err` → 工具 / 请求报错，不退回真实磁盘
      （铁律 4.1 不过度 fallback）；不新增可选参数，视图层参数只是改名；归属的唯一写入点仍是创建
      路径（铁律 4.4）；「这份 `isolated` 用哪份视图」由父链推导，不写第二份落盘字段（铁律 4.5）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：落盘字段沿用已存在的 `storage`，没有格式
      变更，因此不需要 `src/shared/history/` 与 core-rs 的对照表同步；行为落点在 `core-rs/` 并同步
      测试（`engine_tests` / `work_view_tests` / `main_tests`）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：归属 / 生命周期 / 失败路径
      三节、传输规格的非目标段、跨工作区代理的 FR-003、Electron 多工作区侧栏一节与 US-79 登记
      在同一轮里改；`npm run test:unit -- docs-lint` 收尾验证。

## 被否决的替代方案

1. **给子代理登记一份「别名视图」**（`views()` 里同时挂 `session_id` 与 `owner` 两个键，指同一个
   `WorkView`）。否决：登记表里出现同一份视图的两条记录，「一份视图一个代理」的判据要靠「两个键
   恰好指同一对象」维持，`release(sub)` 与 `release(owner)` 的语义差别只能靠调用方记忆；解析放在
   `ensure_work_view` 一处更窄。
2. **给子代理新建一份视图，再把父子写入双向同步 / 回并**。否决：overlay 的上层本来就是「这个对话
   的改动」，两份额外引入同步时机、冲突语义与「回并到哪一刻」的时序问题；用户明确要求父子共用
   同一份视图（spec FR-002）。
3. **在子会话 `meta.json` 里写 `viewOwner` 字段**。否决：多一个可以从父链推导的派生字段，必然与
   父链漂移（父会话被删后它指向谁？）；铁律 4.5 要求派生字段从根字段推导、且只有一份推导实现。
4. **跨工作区派发也继承 `isolated`**。否决：视图是发起方 Core 私有命名空间里的事实，跨工作区传递
   要么搬字节、要么在目标 Core 重建一份，两者都超出「继承归属」的范围（spec 非目标）。
5. **在 `conversationClosed` 里对子代理调用 `release` 但保留上层目录**。否决：`release` 会丢弃该
   视图的常驻代理，而所有者（父对话）可能正在用同一份视图；下一次工具调用只能重建代理，等于把
   「共享」退化成「按需重挂」，还会让在途工具丢代理句柄。

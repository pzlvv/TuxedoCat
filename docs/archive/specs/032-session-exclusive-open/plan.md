# 实施方案：会话跨实例独占打开

技术路线：Core 在会话数据目录放 `session.lock`，互斥用 OS 建议性文件锁（Unix `flock` /
Windows `LockFileEx`，手写 FFI、零新依赖），锁的生命周期归内核——持有进程退出即释放，
接管退化为「再次获取」，无摘除-重建协议。锁的持有者是 Core 进程内的会话实例：宿主
detach / 孤儿化只断控制连接，锁与注册表都不动（specs/031 的认领是同 Core 重入）。
锁文件内容（版本 / pid / 进程启动时刻）只作占用诊断与版本拒外，不参与互斥。获取收口在
会话装载与子代理创建入口，注册表去重同 Core 重入，`drop_session` 统一释放；变更入口经
统一守卫在锁内写入后释放。宿主与总线协议零改动，用户可见文案走既有 `CoreEvent.notice`
键 + 参数通道。需求与验收见同目录 [spec.md](spec.md)。

## 技术方案

### 锁原语模块（新增 `core-rs/src/session_lock.rs`，`main.rs` 注册 `mod`）

- **原语**：`acquire(path) -> Result<SessionLockHandle, LockError>` 非阻塞独占。
  - Unix：`File::options().read(true).write(true).create(true)` 打开后
    `flock(fd, LOCK_EX | LOCK_NB)`——`extern "C"` 声明，与 `parent_watchdog` 的 `kill`
    同风格（Rust std 无 flock API，不引第三方锁 crate）。
  - Windows：std `File` 的原始句柄上 `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK |
    LOCKFILE_FAIL_IMMEDIATELY)`，kernel32 手写声明 + 零填充 `OVERLAPPED`（对齐
    `parent_watchdog` 的 kernel32 先例）；释放走 `UnlockFileEx` + 关句柄。
  - 忙（`EWOULDBLOCK` / `ERROR_LOCK_VIOLATION`）→ `LockError::Held`；其余 IO 错误照常
    报错不降级。
- **句柄**：`SessionLockHandle`，Drop 只 unlock + close，**不删锁文件**——释放期摘文件
  会让并发的下一个获取者锁到已脱链 inode，另一个获取者在新 inode 上再锁成功，出现双
  持有；残留文件无害（进程死活由内核锁表达），随会话目录删除自然消失。
- **锁文件内容**：单行 JSON `{"version":1,"pid":…,"started":…}`。获取成功后覆写为
  自己；内容解析不出版本 → 视为损坏，照常持有（互斥在内核锁，落诊断，spec 边界明文）；
  解析出版本 ≠ 1 → 立即释放并拒绝（FR-003 版本拒外，持有者进程死活无关）。获取失败时
  读内容仅用于错误诊断（指认 pid，读不出为 `unknown`）。
- **进程启动时刻**（仅诊断）：Linux 读 `/proc/<pid>/stat` 第 22 字段（boot 相对时钟
  滴答，天然免疫墙钟回拨）；Windows `GetProcessTimes`。平台分支按 `parent_watchdog`
  的 `#[cfg(unix)] / #[cfg(windows)]` 模块组织。
- **注册表**：`Core` 新增 `session_locks: Mutex<HashMap<String, SessionLockHandle>>`
  （键 = sessionId，与 `Core.sessions` 同键空间）。入口辅助
  `acquire_for_core(core, session_id)`：注册表命中即重入放行（同 Core 内父子会话 /
  子代理 / specs/031 认领同一 Core，天然不自锁）；未命中则盘上获取，成功挂表。

### 获取点（不变式：凡写会话数据的路径必先持锁；纯读只校验不获取）

| 入口 | 现状 | 动作 |
| --- | --- | --- |
| `on_conversation_opened` → `ensure_loaded` | 创建 `SessionState` | 获取或拒绝；拒 = notice + 不创建状态 |
| `conversation_load_payload`（`conversationLoadRequested`） | 纯盘读 | 获取或拒绝；拒 = UiRequest 回 `Err`（`error_response`）+ notice，不回内容 |
| `create_sub_agent` | `session()` 直接建 | 获取（同 Core 重入） |
| `start_remote_sub_agent`（specs/023 跨工作区） | `session()` 直接建 | 获取；失败经 `CoreRequest` 回 `error`，Agent 工具收到明确失败（spec 边界），不排队不静默 |

「只装载未打开」的句柄随 `conversationClosed` / `drop_session` 按键释放，Core 退出由
内核兜底。

### 变更守卫（FR-002）

新增 `ensure_can_mutate(core, session_id) -> Result<(), LockError>`：注册表命中放行；
未命中走「取锁 → 写入 → 释放」的短持有路径（spec FR-002：未装载的会话按先取锁再改处理，
不留下长期持有），取不到即拒。接入六个变更入口：`on_conversation_renamed`、
`on_conversation_deleted`、`sessionConfigChanged` 链路、`smartNamingRequested`、
`compactArchiveRequested`、`spinDesignSaveRequested`；同一守卫套到
`conversationSpaceCleared` 的 `remove` 模式（整空间删除是变更类入口，spec FR-002「一切
变更类入口一律拒绝」的原则覆盖：空间内任一会话他持即整体拒绝，数据零改动——不被拒时
锁文件随目录删除自然消失）。四个 UiRequest 入口拒绝时回 `Err`，UiEvent 入口拒绝时落
notice + 诊断日志。删除自己持有的会话：先 Drop 句柄再删目录，避免 Windows 上活动句柄
与目录删除竞态。

### 释放（FR-001 / AC-3 / AC-13 / AC-14）

`drop_session`（`on_conversation_closed` 调用）移除注册表条目 → 句柄 Drop →
unlock + close。视图关闭 / VS Code 空闲回收都汇入 `conversationClosed`；崩溃 / 被杀 /
任一路径下 Core 进程退出由内核释放（AC-7 / AC-14），残留锁文件不影响下一次装载。
宿主断开不触发释放：`detach` / 孤儿化只断控制连接（specs/031），Core 与其中的会话实例
都还在，注册表与内核锁都不动（AC-10 / AC-11）；认领换宿主时注册表照旧命中，同 Core
重入放行。

### 错误文案（既有通道，宿主零改动）

- `core_text.rs` 新增键常量：`notice.session.lockedOpen`、`notice.session.lockedChange`
  （参数 `{pid}`，读不出持有者时为 `unknown`）。
- 发送复用既有 notice 形态：`{"type":"notice","sessionId",…,"key","params","level"}`
  （同 `spin_host` 的 emit 样式），webview `NoticeToast` 以 `t(key, params)` 翻译展示。
- `src/webview/i18n/zh.ts` / `en.ts` 各补两键。

### 测试（新增 `core-rs/src/session_lock_tests.rs`）

双进程竞争用「自 spawn」harness：`Command::new(std::env::current_exe())` +
`--exact <子测试名>` 跑一个持锁的子测试（父进程杀之 / 等其退出）——仓库无此先例，
按 `parent_watchdog_tests` 已有的子进程写法（`Command` + wait 收尸）扩展。矩阵：

| 用例 | 验证 |
| --- | --- |
| 原语互斥 | 绕过注册表，同进程第二柄 try-lock 必败 |
| 同 Core 重入 | 注册表两次 acquire 同 sid 返回同一持有（AC-10） |
| 释放 | Drop 后立即可再获取 |
| 宿主离场不释放 | 同 Core 上模拟 `conversationClosed` 之外的断链（注册表与句柄都不动）→ 另一进程仍抢锁失败（AC-11） |
| 崩溃接管 | 子进程持锁被杀 → 父立即获取（AC-7） |
| 并发至多一胜 | 父持锁期间子进程抢锁必败（AC-9） |
| 版本拒外 | 盘上 `version:99` 锁文件（无内核锁）→ 获取成功但立即释放并拒（AC-8，进程死活无关） |
| 内容损坏 | 空文件 / 坏 JSON → 照常持有 + 落诊断（边界） |
| 变更守卫 | 子进程持目标会话锁 → 六入口 + 空间清除拒绝、数据零改动（FR-002，engine 级） |
| 未装载变更 | 目标会话未在本 Core 装载 → 变更入口取锁写入后释放，随后另一进程可获取（AC-6） |

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/session_lock.rs` | 新增：锁原语 + 注册表辅助 + 启动时刻平台分支 | 无 |
| `core-rs/src/session_lock_tests.rs` | 新增：上述矩阵 | 无 |
| `core-rs/src/engine.rs` | `Core.session_locks` 字段；`ensure_loaded` / `create_sub_agent` / `start_remote_sub_agent` 接获取；`drop_session` 接释放；六个变更入口 + `conversationSpaceCleared`（remove）接守卫 | 无新成员 |
| `core-rs/src/main.rs` | `mod session_lock;`；`conversationLoadRequested` 拒绝路径回 `Err`；notice 发送 | 无 |
| `core-rs/src/core_text.rs` | 两个 notice 键常量 | `CoreEvent.notice` 载荷形态不变（key / params 是既有自由字段） |
| `src/webview/i18n/zh.ts` / `en.ts` | 各补两键翻译 | 无 |

事件词汇表无增删；`docs/architecture/events.md` 的 `notice` 触发点列补新 emit 位点
（docsLint 校验驱动）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动全落 `core-rs/`（Core 层）与
      `src/webview/i18n/`（用户可见文案的既有资源层）；宿主零改动，core 不 import
      host 实现，无 `host.kind` 嗅探，不新增注入点。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：锁获取失败直接拒绝不静默降级；「内容损坏照常
      持有」是 spec 边界明文的设计态且落诊断；无新契约成员、无新增可选；锁的持有
      事实唯一写入点是 `Core.session_locks`；webview 只翻译 key + params，不持锁
      事实；不涉及配置默认值。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：行为改动全在 `core-rs/` 并
      同步 Rust 单测；`session.lock` 是 Core 独有文件，不属 meta.json / 对话 JSONL
      落盘格式，`src/shared/history/` 不读写它（spec 影响基线 standalone-core.md 行）；
      ADR-0007 后 Core 只有 core-rs 一套，无双实现 parity 义务。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：与代码同一提交更新
      [client-connection.md 第 5 节](../../docs/core/client-connection.md#5-connection-生命周期)
      （连接独立、会话独占）、
      [standalone-core.md 第 7 节](../../docs/core/standalone-core.md#7-事实归属)
      （事实归属补 `session.lock`，模块清单补 `session_lock.rs`）、
      [sessions-and-llm.md EP-5](../../docs/features/user-stories/sessions-and-llm.md#ep-5-会话管理)
      （US-66）、
      [user-stories.md 附录](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射)
      （US-66 按豁免口径登记）、`docs/architecture/events.md` 的 `notice` 触发点列；
      `npm run test:unit -- docs-lint` 须绿。

## 被否决的替代方案

1. **纯锁文件 + 摘除式接管（spec 原稿：`O_EXCL` + pid + 启动时刻判陈旧）**：摘除-重建
   接管存在双持有竞态（两个接管者互相摘掉对方刚建的新锁，文件系统无 CAS 无法根除）；
   「残缺即无主」罩不住建锁后写 pid 前的窗口；Linux 僵尸被存在性判活误挡；Windows
   判活 / 启动时刻需整套平台实现且 remote.rs 先例在 Windows 是盲区。会话锁持锁小时级，
   不可容忍——已在 spec 修订时否决（记录于 spec 待澄清节）。
2. **收紧的摘除协议（摘前复读确认 + mtime 宽限 + 摘后建失败即让）**：把竞态窗口从
   毫秒压到微秒但残余仍在，协议复杂度反而高于内核锁——否决。
3. **fs2 / fs4 等锁 crate**：为两个 syscall 引第三方依赖；仓库既有手写 FFI 风格
   （`parent_watchdog` 的 kernel32 / libc 声明）零依赖可达成——否决。
4. **fcntl POSIX 记录锁替代 flock**：fcntl 锁在进程内任一 fd 关闭即全部释放（同文件
   多 fd 场景语义危险）；flock 按 open file description 独立，贴合「每会话一柄」——否决。
5. **宿主侧（TS `src/shared/history/`）加锁**：会话数据的写入者是 Core，宿主只在本
   实例会话打开时经窄场景直写（删除闭包 / 工具 diff 元数据），彼时锁必在本 Core 手里；
   宿主零改动也是 spec 约束——否决。
6. **mtime 老化判活沿用 remote.rs / config.rs 先例**：pid 复用误判、Windows 盲区、
   僵尸误判三病齐发，且只适合秒级短临界区——否决。

锁原语选型（内核建议性锁 vs 锁文件协议）是够分量的架构决策，建议随评审进
`docs/adr/`（下一个编号），评审时定。

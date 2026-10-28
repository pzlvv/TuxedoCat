# 实施方案：远程任务后台运行与认领重连

技术路线一句话：把「孤儿化 / 认领 / 空闲判定」全部收敛在 daemon（`core-rs/src/daemon.rs`），
Core 与总线协议零改动；daemon 对孤儿 Core 的帧保持排水并缓存两类元信息（最新忙闲快照、
待应答的用户请求帧），认领时一次性重放给新宿主——完成未读与挂起请求因此都走既有宿主
机制，宿主侧改动集中在退出链与对话框（`electron/main.ts`）与 Client 的 detach 分叉
（`src/host/Client.ts`）。方案对应 [spec.md](spec.md) 的 FR-001 ～ FR-007。

## 技术方案

### 1. daemon 侧：孤儿表与帧出口路由（FR-005 / FR-006 / FR-007）

**忙闲事实的获取（方案成立的前提）**：daemon 现在完全不解读内层帧
（`core-rs/src/daemon.rs` 只按 channel 转发），但孤儿判定需要「该 Core 是否非 idle」。
Core 已经在全量推送 `sessionRuntimeChanged` 快照（`docs/core/session-runtime.md`），
daemon 与 Core 是同一二进制（`docs/core/core-daemon.md` 第 1 节第 8 条），版本天然一致。
方案：daemon 对 Core → Host 方向的内层帧增加**唯一的窥探点**——识别
`{ kind: 'event', event: { type: 'sessionRuntimeChanged', … } }` 与
`{ kind: 'request', … }` 两种信封，其余内层帧保持不解读：

- 每个 channel 维护 `last_runtime`（最近一份快照的会话忙闲级别表，`Map<sessionId, 级别>`），
  Core 进程重启（respawn）时清空（缺失按 idle 处理：新进程尚无在跑工作）；
- 解不出（契约漂移 / 非预期形状）按**忙**处理并落诊断——fail-safe 方向是保活
  （daemon 多陪一会儿，用户可用 `kill` 收场），不静默杀任务。

对「daemon 不解读内层帧」这条既有不变量（[docs/core/core-daemon.md 第 4 节](../../docs/core/core-daemon.md#4-通道模型)、
[第 10 节](../../docs/core/core-daemon.md#10-验收要点)）的修正随本 spec 落地：改为
「除忙闲快照缓存与请求帧暂存两处只读窥探外不解读内层帧」。
建议就此进 ADR（见文末）。

**孤儿化**：daemon 增加全局孤儿表（`HashMap<OrphanKey, OrphanEntry>`，`OrphanKey` =
`openWorkspace` 携带的 `workspace_ref.path` + 原连接标识，per-endpoint daemon 内唯一）。
键必须带连接标识：同一 endpoint 上两个客户端各开同一工作区是两个独立 Core（AC-10 的
多窗口语义），只用 path 作键时第二次孤儿化会覆盖第一条，被覆盖的 Core 既不在表里也不会
被关闭，泄漏成无主进程——该进程不退则它持有的会话锁（specs/032）不会释放，会话对所有
实例永久不可装载。同键重复插入是错误，落诊断并拒绝插入，不静默覆盖。两条进入路径：

1. **连接断开**（现有 `close_all` 调用点）：逐 channel 查 `last_runtime`——存在非 idle
   会话 → 孤儿化；全 idle 或无快照 → 现行关闭。孤儿化 = 该 channel 的
   `CoreProcessHandle` 与读帧线程原样保留，帧出口从「连接输出」切到孤儿收集器；
2. **`detachWorkspace` 帧**（新控制帧，见第 3 节）：标签页关闭而 daemon 连接仍存活时，
   宿主对单个 channel 发 detach，daemon 把该 Core 移入孤儿表、回
   `workspaceClosed { reason: 'detached' }`，连接本身继续服务其余 channel。

孤儿收集器（`OrphanSink`）对每一帧做三件事：喂给窥探点更新 `last_runtime` / 捕获
`request` 帧、把 `sessionRuntimeChanged` 信封追加进重放缓冲（见下）、其余丢弃。
读线程持续排水，Core 永不因管道写满而阻塞。

**重放缓冲**：孤儿期间按序保留两类内层帧——`request` 帧（挂起的用户请求，AC-9 / AC-19）
与 `event` 信封里的 `sessionRuntimeChanged` 快照（完成未读的 running → idle 差分原料，
AC-14 / AC-15）。缓冲有上限（如最近 200 帧，超限丢最旧并落诊断）；无论缓冲内容如何，
`last_runtime` 恒保留最新一份——认领时若缓冲为空（孤儿期间无任何变化），直接重放
`last_runtime` 一帧，保证新宿主拿到全量当前状态（FR-006 的「重放完成后推送全量快照」
由这条重放承担，Core 无感知）。

**认领**：`open_workspace`（daemon.rs 第 634 行）先查孤儿表，命中的候选按 path 精确匹配，
若同 path 有多条孤儿，取进入孤儿表最早的一条（后来的都是同工作区的独立 Core，留给它自己
的客户端认领或空闲回收）。命中且进程存活 → 不 spawn，把 `CoreProcessHandle` 移入本连接的
channel 表，重放缓冲（按原序：先快照后请求，保持相对顺序）到新连接出口，然后清缓冲。
「摘表 + 句柄移交」在同一把锁内完成，同一孤儿并发认领至多一胜，败者重查孤儿表后按无孤儿
处理。未命中或进程已死（孤儿崩溃从表中移除，AC-13）→ 现行 spawn 路径。活跃连接的 channel
不进孤儿表，AC-12 的多窗口语义天然保持。

**空闲判定（FR-007）**：daemon 的空闲死线（`remote.rs` 起算、`run_daemon` 定时器驱动）
从「无控制连接」改为「无控制连接**且**孤儿表内无非 idle Core」；孤儿快照转全 idle 后
并不立即关闭——沿用 US-33 的口径（短暂 idle 可能是「空闲挂起项紧随提交」），全 idle
持续满 30s 才关闭该孤儿 Core 并移出孤儿表，期间任何会话回到非 idle 则取消。最后一个
条件满足后照旧 30s 退出并清状态文件。孤儿 Core 崩溃：不重启（不走 `respawn_core`），
移出孤儿表。`shutdown`（`kill`）语义不变：全局停机时孤儿表一并收尾。

### 2. Core 侧：零改动（一处既有语义记录在案）

Core 不感知 detach / 认领。挂起的 `CoreRequest` 应答等待是既有事实：
`engine.rs` 的 `waiting_request` 路径用 `bus::wait_response(receiver, 3_600s)`——**1 小时
上限**。孤儿超过 1 小时无人应答，该轮按既有超时失败路径收尾（会话里落一条失败），
daemon 缓冲里的请求帧随后重放时 Core 已无此待决 id，应答被丢弃（bus 对未知 id 的既有
口径）。这个边界写进 spec 的「边界与错误路径」。

### 3. 协议变化（daemon 控制通道，`daemon_protocol.rs` / `src/host/standalone/daemonProtocol.ts`）

| 变化 | 成员 | 方向 |
| --- | --- | --- |
| 新增帧 | `detachWorkspace { channel }` | Host → daemon |
| 新增枚举值 | `WorkspaceCloseReason` 增加 `'detached'`（`workspaceClosed` 复用，不新增应答帧） | daemon → Host |

Core ↔ Host 的总线协议（`CoreEvent` / `CoreRequest` / `UiEvent` / `UiRequest`）零变化，
`docs/architecture/events.md` 不动。

### 4. 宿主侧：退出链、对话框与 detach 分叉（FR-001 ～ FR-004）

**退出确认链**（`electron/main.ts` 窗口关闭确认处，约 888 行；现行
`confirmCloseBusy` 保留给本地工作区）：

1. 收集忙碌 SSH 工作区（`collectWorkspaceActivity()` 过滤 `scheme === 'ssh'`，判据与
   现有关闭确认同一份快照），按标签页顺序逐个弹三选对话框（`electron/styledMessageBox.ts`
   加三按钮形态：后台运行 / 立即关闭 / 取消，默认焦点取消）；任一「取消」中止退出
   （现有「每一条出口都必须能走到真正的退出」的 preventDefault 链复用）；
2. 本地忙碌工作区维持现有总确认，排在 SSH 逐区确认之后；
3. 决策表 `Map<workspaceRefKey, 'detach' | 'close'>` 存入退出上下文，
   `will-quit → shutdownCore(decisions)` 消费。

**标签页关闭**（`electron/main.ts` 的 `closeWorkspace`，约 3687 行）：忙碌 SSH 工作区
弹同一张三选；「后台运行」→ 对该 channel 发 `detachWorkspace`、按现行流程移除标签页与
打开集合（最近列表不动）；「立即关闭」→ 现行路径。同一 endpoint 上最后一个工作区被
detach 时直接断开整条连接（daemon 侧效果相同，省一次帧往返；优化项，不做也可）。

**Client 分叉**（`src/host/Client.ts`）：`closeAll` 加可选决策参数（或并列
`closeAll(decisions?: ReadonlyMap<string, 'detach' | 'close'>)`）：`detach` 的远程
Connection 走新路径——不调 `disposeBus`（即不向 daemon 发 `closeWorkspace`），只做
路由表摘除与资源释放，随后 `bootstrapCore.ts` 的 `shutdownCore` 照旧
`daemon.disconnect()`（只断控制链，既有语义）；`close` 与本地走现行
`closeConnection`。弹不出对话框的出口（窗口已毁）：决策表为空 = 全部只断链，
daemon 默认策略接管（spec AC-15）。

**与 specs/032 会话锁的咬合**：detach / 孤儿化不触碰 Core 内任何会话状态，会话锁的
注册表与内核锁原样保留（锁的持有者是 Core 内的会话实例，宿主断开不释放）；认领是同
Core 重入，宿主侧逐会话打开的重放路径在 Core 侧命中既有锁注册表、不自锁。他实例对
后台会话的装载 / 变更拒绝由 032 的锁守卫产生，daemon 侧无新增逻辑，本方案不改
`core-rs` 会话引擎即自然成立。

**完成未读（FR-006 末段）**：宿主侧**零新机制**——认领重放的快照序列经既有总线进入
`completionAttention` 的差分（空表登记 → 后续 running → idle 触发武装），绿灯、已读
判定、武装条件全部复用。一个风险与对策：启动恢复路径的认领发生在窗口尚未聚焦时，
重放的完成会命中托盘提醒（US-33）的「窗口不在前台」条件，造成开屏误闪提示音——
`completionAttention` 武装判定增加启动恢复窗口抑制（宿主进程内标志：启动恢复的认领
全部落定前不武装托盘 / 提醒音，对话列表绿灯不受影响）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/daemon.rs` | 孤儿表（键 = path + 原连接标识，登记冲突拒绝插入）、`OrphanSink` 帧出口路由、窥探点、重放缓冲、认领（摘表与移交原子化）、空闲判定、孤儿崩溃不重启 | 无 |
| `core-rs/src/daemon_protocol.rs` | 新增 `detachWorkspace` 帧；`WorkspaceCloseReason` 增加 `'detached'` | daemon 控制协议（帧表见 [docs/core/core-daemon.md 第 7.2 节](../../docs/core/core-daemon.md#72-帧类型)） |
| `core-rs/src/remote.rs` | 空闲死线起算条件纳入孤儿忙闲 | 无 |
| `src/host/standalone/daemonProtocol.ts` | 与 Rust 侧同步两个协议成员 | 同上 |
| `src/host/standalone/CoreDaemon.ts` | `detachWorkspace` 发送入口（供 detach 路径调用） | 无 |
| `src/host/Client.ts` | `closeAll` 决策参数与 detach 分叉（不 dispose 总线、只摘路由） | 无 |
| `src/host/bootstrapCore.ts` | `shutdownCore` 接收决策表并传给 `Client` | 无 |
| `electron/main.ts` | 退出确认链（SSH 逐区三选 + 决策表）、标签页关闭三选、启动恢复抑制标志 | 无 |
| `electron/styledMessageBox.ts` | 三按钮对话框形态 | 无 |
| `src/webview/i18n/`（zh / en） | 对话框与任务状态文案 | 无 |
| `e2e/playwright.config.ts` | `electron-ssh` project `testMatch` 纳入新用例文件，`electron-app` `testIgnore` 同步 | 无 |

不涉及：`src/shared/history/`（落盘格式零变化）、`docs/architecture/events.md`（总线协议
零变化）、`core-rs` 会话引擎与工具链。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动收敛在 `core-rs`（daemon / 协议）、
  `src/host/standalone`（协议与 daemon 客户端）、`src/host`（Client）、`electron`（UI）。
  `src/shared/` 不动；宿主差异不进共享层；无新增跨层 import；无宿主嗅探（决策按
  `workspaceRefKey` 与 scheme 字段区分，不比对宿主种类）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：窥探解析失败按「忙」fail-safe 并落诊断，不静默
  降级（铁律 1）；`last_runtime` 是 Core 忙闲事实的**只读投影**（铁律 4：owner 仍是
  Core 的 `sessionRuntimeChanged`），孤儿判定消费投影、不从 UI 状态反推；协议新成员
  全必选（`detachWorkspace.channel` 必填，`'detached'` 是枚举新值不是可选字段）；
  重放缓冲上限与孤儿收集的 30s 阈值为 daemon 内常量，不进配置、无默认值分叉（铁律 6）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core（会话引擎 / 落盘）零改动，
  `src/shared/history/` 不涉及；协议变化在 `daemon_protocol.rs` 与
  `daemonProtocol.ts` 两侧同步，Rust 侧 `daemon_protocol_tests.rs` 与 TS 侧
  `src/test/` 帧编解码用例各锁一份。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：spec 的「影响基线」13 处
  （`docs/core/core-daemon.md`、`docs/core/core-remote.md`、
  `docs/core/client-connection.md`、`docs/hosts/electron-multi-workspace.md`、
  `docs/features/user-stories/`）在 converge 阶段并入；`docsLint` 全绿为收敛闸门；
  spec「待澄清」的「协议不加新帧」随本 plan 修正为「新增 `detachWorkspace` 一帧 +
  `'detached'` 枚举值」，收敛时同步改注记。

## 被否决的替代方案

1. **宿主显式决定孤儿化（daemon 断开即全杀，宿主崩溃时任务全丢）**：违背 spec AC-2 /
   AC-5（崩溃路径任务必须存活），否决。
2. **Core 感知 detach / reattach（新增总线内层帧，Core 重连后重发挂起请求）**：改动面
   大（总线协议 + Core + 宿主三层），且 Core 需要维护 detached 状态机；daemon 侧缓冲
   重放以零总线协议代价达成同样效果，否决。
3. **宿主落盘忙闲级别做差分种子（workspace-state.json 记住退出时的 busy 集合）**：
   崩溃路径无落盘机会（AC-5 覆盖不到）、时点陈旧；daemon 重放真实快照序列是同一事实的
   无损版本，否决。
4. **不保进程、只靠磁盘会话恢复**：进程内在跑工作（LLM 流 / 工具执行 / 后台任务）
   不可恢复，违背本特性核心承诺，否决。
5. **daemon 合成「完成事件」而非重放真实快照**：伪造总线帧比原样重放耦合更深，且
   `completionAttention` 的差分机制本来就要吃快照序列，否决。
6. **孤儿 detached 存续上限（24h）**：spec 评审中否决——等待用户的孤儿让 daemon 陪跑
   是接受的语义，`kill` 是兜底出口。
7. **孤儿表纯 path 作键**：实现最简，但同一 endpoint 两个客户端各开同一工作区时第二次
   孤儿化覆盖第一条（AC-10 的两独立 Core 是合法形态），被覆盖的 Core 泄漏成无主进程——
   它不退则 `specs/032-session-exclusive-open` 的会话锁不释放，会话对所有实例永久不可
   装载。修订为 path + 原连接标识复合键、登记冲突拒绝插入，否决纯 path 键。

**建议进 ADR**：「daemon 对内层帧的两类只读窥探」（忙闲快照缓存 + 请求帧暂存）修正
「daemon 不解读内层帧」不变量——这是跨 Core 与 daemon 边界的架构决策，值得记录背景与
被否决的替代方案（上面第 2 / 3 / 5 条），实施时一并落 `docs/adr/`。

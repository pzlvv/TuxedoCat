# 规格：Core daemon

本规格描述 Core 进程的 daemon：Standalone Core 进程由 daemon 启动、监督与终止，帧通道
在 daemon 上多路复用。一个工作区对应一个 Core 进程，一个 endpoint 对应一个 daemon；
daemon 上活着的 Core 计数归零后 daemon 退出。

Standalone Core 的进程形态与帧协议见 `docs/standalone-core.md`；连接模型见
`docs/client-connection.md`；Core 与 UI 的分离形态见 `docs/core-ui-separation.md`。

---

## 1. 能力

1. **一个 endpoint 一个 daemon**：本地一个；每个远程 host 一个（远程未实现，见第 9 节）。
2. **一个工作区一个 Core 进程**：由 daemon 启动，daemon 持有其 stdio。
3. **多路复用**：Host 与 daemon 之间只有一条控制通道；每个 Core 的帧通道是它上面的一条
   逻辑 channel。
4. **生命周期归 daemon**：Core 的启动、重启、终止都由 daemon 承担，Host 不直接管理进程。
5. **计数归零退出**：daemon 上活着的 Core 数归零后，经 grace 期退出。
6. **帧语义不变**：daemon 只加一层信封，不改 `docs/standalone-core.md` 第 6.2 节的帧集合。
7. **同一二进制**：daemon 与 Core 是同一个可执行文件的两个模式，版本天然一致。
8. **通道描述符**：daemon 返回 `ChannelDescriptor`，今天表达「走这条控制通道、channel N」，
   将来可以表达「去连这个地址」，Host 上层不因此改动。

---

## 2. 术语

| 术语 | 含义 | owner |
| --- | --- | --- |
| daemon | 每个 endpoint 一个的 Core 进程管理者 | host |
| 控制通道 | Host 与 daemon 之间的双向帧通道 | 传输层 |
| channel | 控制通道上承载一个 Core 帧通道的逻辑通道 | 传输层 |
| ChannelDescriptor | 描述如何获得某个 channel 的帧通道 | 传输层 |
| Core 进程 | 一个 Standalone Core 实例，归属一个工作区的 Connection | daemon 启动，Core 自身 |
| grace 期 | 计数归零后等待新 Core 的窗口 | daemon |

---

## 3. 进程形态

- daemon 与 Core 是同一个可执行文件（`core.binaryName`）的两个模式：
  - `--daemon`：daemon 模式；
  - `--serve`：Core 模式，stdio 是帧通道（`docs/standalone-core.md` 第 4 节）。
- daemon 起 Core 时不再定位第二个可执行文件：以自身路径加 `--serve` 启动。
- daemon 的 stdin / stdout 是控制通道；stderr 是诊断输出。
- daemon 创建的子进程（Core 进程）不显示控制台窗口，与 Core 侧同一条规则。
- **本地 daemon 由 Host 启动**：Host 是 daemon 的父进程，控制通道走 stdio。Host 退出或
  崩溃时 stdin 关闭，daemon 据此判定 Host 断开（第 5 节）。
- 远程 daemon 的启动与接入方式不在本规格范围内（第 9 节）。

---

## 4. 通道模型

```
Host ── 控制通道（一条）── daemon ──┬── Core A（channel 1）
                                  └── Core B（channel 2）
```

- 控制通道上只有一条连接；每个 Core 的帧通道是它上面的一条 channel。
- 每条 channel 上跑的帧与 `docs/standalone-core.md` 第 6.2 节完全一致；daemon 不解读
  内层帧，只按 channel 转发。
- channel id 由 daemon 分配，在一条控制通道内唯一且**稳定**：Core 崩溃重启后沿用同一个
  channel id（第 6 节）。
- channel 是双向的；两侧的帧按写入顺序转发，不丢帧、不合并（沿用
  `docs/standalone-core.md` 第 6.5 节的背压约定）。

### 4.1 ChannelDescriptor

Host 请求打开工作区时，daemon 返回一个描述符：

| 形态 | 含义 | 状态 |
| --- | --- | --- |
| `{ kind: 'multiplexed', channel: number }` | 走当前控制通道的该 channel | 本规格实现 |
| `{ kind: 'direct', transport, address }` | 直连一个独立端点 | 预留，不实现 |

Host 侧只在取帧通道时读描述符，上层（Connection / 总线适配器）不感知形态差异。

---

## 5. 生命周期与计数

| 事件 | daemon 行为 |
| --- | --- |
| 收到 `openWorkspace` | 启动一个 Core 进程，分配 channel，回 `workspaceOpened` |
| 收到 `closeWorkspace` | 向该 Core 发 `shutdown`；超时后强制结束；channel 关闭；计数递减 |
| Core 进程退出 | channel 关闭；按第 6 节决定是否重启 |
| 控制通道断开（Host 退出 / 崩溃） | 关闭该控制通道上的全部 channel，然后按计数规则退出 |
| 收到 `shutdown` | 关闭全部 channel，退出 |

计数与退出：

- daemon 维护 `liveCores`（活着的 Core 进程数）。
- `liveCores` 归零后启动 **grace 计时器（30s）**；期间收到新的 `openWorkspace` 则取消
  计时器；到期后 daemon 退出。
- grace 期避免「关一个工作区又开一个」时反复启停。
- Host 断开后不给 Core 留存活口子：连接断开即关闭该 Host 的全部 Core。允许 Core 在 Host
  断开后存活是重连场景的需求，不在本规格范围内（第 9 节）。

---

## 6. 重启

- **触发**：Core 进程在收到 `shutdown` 之前退出。
- **策略**：daemon 以退避策略重启该 channel 的 Core 进程（沿用现有
  `CoreProcess.ts` 的 `restartPolicy`：时间窗口 + 最大次数）。
- **上限**：时间窗口内重启次数超过上限时停止重启，关闭该 channel 并向 Host 报告原因，
  不静默重试。
- **恢复**：重启后在**同一 channel** 上重新握手；Host 侧感知为「连接重置」，重新发
  `hello`，重放 `hostEnvironmentProvided`（含配置快照）与已打开的会话
  （`docs/standalone-core.md` 第 7.2 节）。
- **隔离**：一个 channel 的重启不影响其它 channel。

---

## 7. 协议

### 7.1 帧

控制通道沿用 `docs/standalone-core.md` 第 6.1 节的编码：UTF-8，换行分隔的 JSON，
一行一帧。

### 7.2 帧类型

| 方向 | 帧 | 载荷 |
| --- | --- | --- |
| Host → daemon | `openWorkspace` | `{ kind: 'openWorkspace', id: number, workspaceRef }` |
| daemon → Host | `workspaceOpened` | `{ kind: 'workspaceOpened', id: number, channel: number, descriptor: ChannelDescriptor }` |
| daemon → Host | `workspaceFailed` | `{ kind: 'workspaceFailed', id: number, error: string }` |
| Host → daemon | `closeWorkspace` | `{ kind: 'closeWorkspace', channel: number }` |
| daemon → Host | `workspaceClosed` | `{ kind: 'workspaceClosed', channel: number, reason: 'closed' \| 'crashed' \| 'failed' }` |
| daemon → Host | `channelReset` | `{ kind: 'channelReset', channel: number, reason: string }` |
| 双向 | `frame` | `{ kind: 'frame', channel: number, frame: <内层帧> }` |
| Host → daemon | `shutdown` | `{ kind: 'shutdown' }` |

- `id` 由 Host 生成，在单条控制通道内唯一；`workspaceOpened` / `workspaceFailed` 回带
  同一个 `id`。
- 内层帧是 `docs/standalone-core.md` 第 6.2 节的帧集合，原样嵌套在 `frame.frame` 里。
- 未知类型一律丢弃并记录，不做静默降级。

### 7.3 握手

控制通道没有协议版本握手：daemon 与 Host 随同一份产物分发，版本由分发保证。Core 与 Host
之间的协议版本校验仍在各自 channel 的 `hello` / `ready` 上完成
（`docs/standalone-core.md` 第 6.3 节）。

### 7.4 背压

- 控制通道是所有 channel 的公共路径：单条 channel 的拥塞不得阻塞其它 channel。
- 不丢帧、不合并帧；单条 channel 内保持顺序。
- 控制通道的写入方维护有序出站队列；越软水位时记录诊断，不丢弃帧。

---

## 8. 与 Connection 的关系

- 打开工作区：Client 取该工作区 endpoint 的 daemon（没有则先启动本地 daemon），发
  `openWorkspace`；拿到 `descriptor` 后建立 Connection（`docs/client-connection.md`
  第 5 节）。
- 关闭工作区：Client 发 `closeWorkspace`，Connection 销毁。
- Core 崩溃：daemon 重启后在同一 channel 上重置；Client 走第 6 节的恢复路径。
- `connectionId` 与 `channel` 是两层的概念：前者是 Host 侧的路由键，后者是传输层的多路
  复用标识；两者都不进入总线载荷。

---

## 9. 不覆盖范围

- 远程 daemon 的启动、接入与凭证（见 `docs/client-connection.md` 第 9 节）；
- `{ kind: 'direct' }` 描述符对应的直连形态；
- Host 断开后 Core 的存活与重连；
- daemon 自身的监督（daemon 崩溃时其上所有 Core 一起死，这是接受的语义）；
- daemon 的版本协商与热升级。

---

## 10. 验收要点

1. 打开一个工作区时 daemon 启动一个 Core 进程，并返回 channel 与描述符。
2. 两个工作区对应两个 channel、两个 Core 进程，且互不影响。
3. 关闭工作区后 channel 关闭、Core 退出、`liveCores` 递减。
4. `liveCores` 归零后 daemon 在 grace 期结束时退出；grace 期内新开工作区则继续服务。
5. 控制通道断开时，该 Host 的全部 Core 被关闭，daemon 随后退出。
6. Core 崩溃后 daemon 在同一 channel 上重启它；超过重启上限时关闭 channel 并报告。
7. 内层帧与 `docs/standalone-core.md` 第 6.2 节逐项一致，daemon 不解读内层帧。
8. 单条 channel 的拥塞不阻塞其它 channel。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| daemon 模式与 Core 模式 | `core-rs/src/main.rs`（`--daemon` / `--serve`） |
| daemon 进程与 channel 管理 | `core-rs/src/daemon.rs`（新增） |
| 控制通道协议 | `core-rs/src/daemon_protocol.rs`（新增）、`src/host/standalone/daemonProtocol.ts`（新增） |
| Host 侧 daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（新增） |
| 帧编解码（内层） | `src/host/standalone/protocol.ts`（不变） |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（重启策略） | `core-rs/src/daemon.rs`；`src/host/standalone/CoreProcess.ts` 的进程管理职责随之收缩 |

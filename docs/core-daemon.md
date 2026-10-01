# 规格：Core daemon

本规格描述 Core 进程的 daemon：Standalone Core 进程由 daemon 启动、监督与终止，帧通道
在 daemon 上多路复用。一个工作区对应一个 Core 进程，一个 endpoint 对应一个 daemon；
daemon 上活着的 Core 计数归零后 daemon 退出。

Standalone Core 的进程形态与帧协议见 `docs/standalone-core.md`；连接模型见
`docs/client-connection.md`；Core 与 UI 的分离形态见 `docs/core-ui-separation.md`。

---

## 1. 能力

1. **一个 endpoint 一个 daemon**：本地一个；每个远程 endpoint 一个（`{ scheme, host, port }`
   相同即同一 endpoint，见第 12 节）。
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

- daemon 与 Core 是同一个可执行文件（`core.binaryName`），用**动作**（子命令，裸词）选择
  做什么，`--host` / `--port` 这类**选项**才带 `--`：
  - `serve`（缺省）：Core 模式，stdio 是帧通道（`docs/standalone-core.md` 第 4 节）；
  - `start`：远程服务的启动器——确保后台 daemon 在跑（没有就拉起），打印连接信息后退出
    （第 12 节）；
  - `kill`：结束在跑的 daemon（第 12 节）；
  - `start-daemon`：daemon 实体本身，由 `start` 拉起；内部动作，不出现在 `--help` 里。
- daemon 起 Core 时不再定位第二个可执行文件：以自身路径加 `serve` 启动。
- daemon 创建的子进程（Core 进程）不显示控制台窗口，与 Core 侧同一条规则。
- **本地同机工作区不走 daemon**：Host 直接用 `serve` 起一个 Core 进程，stdio 是帧通道
  （不监听端口、不需要 token）。daemon 只服务远程 endpoint。
- **远程 daemon 由用户在目标机器上启动**：`start` 打印可达的 `IP:端口` 与 token；
  Host 用它们建立 TCP 控制通道（第 12 节）。
- **可独立运行**：`--help` / `-h` 打印用法，`--version` / `-V` 打印版本，未知动作 / 未知选项
  报错并提示 `--help`（退出码 2）。没有动作时：stdin 是终端（用户直接运行）打印用法；
  stdin 不是终端（宿主经管道接入）按 `serve` 启动。可执行文件保留控制台子系统，
  这样帮助与 `start` 横幅在终端里可见；宿主与 daemon 起本进程时用
  `windowsHide` / `CREATE_NO_WINDOW` 隐藏控制台窗口。

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
| Host → daemon | `auth` | `{ kind: 'auth', token: string }`（仅远程控制通道的第一帧，第 12 节） |
| daemon → Host | `authOk` | `{ kind: 'authOk' }` |
| daemon → Host | `authFailed` | `{ kind: 'authFailed', error: string }` |
| Host → daemon | `openWorkspace` | `{ kind: 'openWorkspace', id: number, workspaceRef }` |
| daemon → Host | `workspaceOpened` | `{ kind: 'workspaceOpened', id: number, channel: number, descriptor: ChannelDescriptor }` |
| daemon → Host | `workspaceFailed` | `{ kind: 'workspaceFailed', id: number, error: string }` |
| Host → daemon | `closeWorkspace` | `{ kind: 'closeWorkspace', channel: number }` |
| daemon → Host | `workspaceClosed` | `{ kind: 'workspaceClosed', channel: number, reason: 'closed' \| 'crashed' \| 'failed' }` |
| daemon → Host | `channelReset` | `{ kind: 'channelReset', channel: number, reason: string }` |
| 双向 | `frame` | `{ kind: 'frame', channel: number, frame: <内层帧> }` |
| Host → daemon | `listDirectories` | `{ kind: 'listDirectories', id: number, path: string \| null }`（`null` 从主目录开始） |
| daemon → Host | `directoriesListed` | `{ kind: 'directoriesListed', id: number, path: string, parent: string \| null, entries: Array<{ name: string, path: string }> }` |
| daemon → Host | `directoriesFailed` | `{ kind: 'directoriesFailed', id: number, error: string }` |
| Host → daemon | `shutdown` | `{ kind: 'shutdown' }` |

- `id` 由 Host 生成，在单条控制通道内唯一；`workspaceOpened` / `workspaceFailed` /
  `directoriesListed` / `directoriesFailed` 回带同一个 `id`。
- 内层帧是 `docs/standalone-core.md` 第 6.2 节的帧集合，原样嵌套在 `frame.frame` 里。
- 未知类型一律丢弃并记录，不做静默降级。

### 7.3 握手

控制通道没有协议版本握手：daemon 与 Host 随同一份产物分发，版本由分发保证。Core 与 Host
之间的协议版本校验仍在各自 channel 的 `hello` / `ready` 上完成
（`docs/standalone-core.md` 第 6.3 节）。

远程控制通道多一步 token 鉴权（第 12 节）：`auth` 必须是第一帧，daemon 回 `authOk` 之后
才接受其余帧；本地 stdio 通道没有这一步。

### 7.4 背压

- 控制通道是所有 channel 的公共路径：单条 channel 的拥塞不得阻塞其它 channel。
- 不丢帧、不合并帧；单条 channel 内保持顺序。
- 控制通道的写入方维护有序出站队列；越软水位时记录诊断，不丢弃帧。

---

## 8. 与 Connection 的关系

- 打开工作区：本地同机不走 daemon（Host 直接以 `serve` 起 Core）；远程取该 endpoint 的
  daemon（没有则先建立 TCP 控制通道并鉴权），发 `openWorkspace`；拿到 `descriptor` 后建立
  Connection（`docs/client-connection.md` 第 5 节）。
- 关闭工作区：Client 发 `closeWorkspace`，Connection 销毁。
- Core 崩溃：daemon 重启后在同一 channel 上重置；Client 走第 6 节的恢复路径。
- `connectionId` 与 `channel` 是两层的概念：前者是 Host 侧的路由键，后者是传输层的多路
  复用标识；两者都不进入总线载荷。

---

## 9. 不覆盖范围

- 远程凭证的持久化与安全存储（token 只活在会话内，见 `docs/client-connection.md` 第 9 节）；
- 远程传输的加密（明文 TCP；跨不可信网络需要外层隧道）；
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
9. `start` 缺省绑 `127.0.0.1:10975`；端口被占用时从该端口起逐个 +1，横幅给实际端口；
   `--token` 未给出时用操作系统随机数生成。
10. TCP 控制通道第一帧 token 不匹配时回 `authFailed` 并断开，匹配时回 `authOk`；
    鉴权通过后 `listDirectories` 返回目标机器上的子目录（连接后即可弹出远端目录选择）。
11. 本地同机工作区由 Host 直接用 `serve` 起 Core（stdio，无端口、无 token），不经过
    daemon。
12. 可执行文件可独立运行：`--help` / `--version` 直接输出，未知动作 / 未知选项报错并提示
    `--help`；没有动作且 stdin 是终端时打印用法，stdin 不是终端时按 `serve` 启动。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 动作分派 | `core-rs/src/main.rs`（`serve` / `start` / `start-daemon` / `kill`） |
| daemon 进程与 channel 管理 | `core-rs/src/daemon.rs` |
| 远程服务（后台 daemon、状态文件、目录列举） | `core-rs/src/remote.rs` |
| 控制通道协议 | `core-rs/src/daemon_protocol.rs`、`src/host/standalone/daemonProtocol.ts` |
| Host 侧 daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（TCP 控制通道） |
| 本地单进程 Core | `src/host/standalone/StandaloneEventBus.ts`（`createStandaloneCoreBus`，`serve`） |
| endpoint → daemon 注册表 | `src/host/bootstrapCore.ts`（`daemonForEndpoint` / `listRemoteDirectories`） |
| 远程连接与目录选择 UI | `electron/main.ts`、`electron/remoteWorkspaceDialogHtml.ts`、`electron/remoteWorkspacePreload.ts` |
| 帧编解码（内层） | `src/host/standalone/protocol.ts`（不变） |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（重启策略） | `core-rs/src/daemon.rs` |

---

## 12. 远程服务（`start` / `kill`）

### 12.1 动作

- `start`：确保后台 daemon 在跑，把连接信息打印到标准输出后**自己退出**（daemon 常驻）。
  - 已有 daemon 在跑（状态文件里的 endpoint 连得上）→ 直接复用它的连接信息；
  - 没有 → 以 `start-daemon` 拉起一个后台进程（脱离终端与进程组、stdin 置空、诊断追加到
    `~/<configDir>/core-daemon.log`），等它落盘后打印；
  - 本次参数与在跑的 daemon 不一致（`--host` / `--port` / `--token`）→ 报错退出，
    不静默忽略用户给的参数。
- `kill`：结束在跑的 daemon——连上它、`auth`、发 `shutdown`，随后清掉状态文件。
  幂等：没有状态文件、或文件里的 daemon 已经不在，都算目标状态已达成（退出码 0）；
  只有「连上了但 token 对不上」才报错。
- `start-daemon` 是启动器的内部实现，不出现在 `--help` 里；也可以直接运行（调试用）。

### 12.2 选项

- `--host <addr>`：绑定地址，默认 `127.0.0.1`（只绑回环；跨机接入显式传 `0.0.0.0`）；
- `--port <n>`：绑定端口，默认 `10975`；被占用时从该端口起**逐个 +1 重试**
  （最多 20 次；`--port 0` 交给内核，不重试）；
- `--token <token>`：token，给出时覆盖状态文件里的；缺省时优先复用状态文件里的，
  没有才用**操作系统安全随机数**生成（128 位十六进制）。

### 12.3 状态文件与横幅

- 状态文件 `~/<configDir>/core-daemon.json`（与 `settings.json` 同目录），字段：
  `requested`（启动时请求的 `host:port`）、`endpoint`（实际监听的 `IP:端口`）、`token`。
- **只有 daemon 写它**：daemon 同时知道实际绑定的端口与生效的 token。原子落盘；
  Unix 上权限 `0600`（token 是凭证）。`kill` 只在文件内容仍是该 daemon 那份时删除它
  （期间可能有新 daemon 覆盖过）。
- 状态文件缺失、或里面的 endpoint 连不上，都按「没有 daemon」处理（`start` 会拉起新的）。
- 横幅是两行：实际监听的 `IP:端口` 与 token。绑定地址是通配地址时，IP 取本机对外可达的
  IPv4（探测不到回退 `127.0.0.1`）。端口 +1 重试后横幅给的是**实际**端口。

### 12.4 鉴权

- TCP 控制通道的第一帧必须是 `auth`；daemon 用定长比较校验 token。
- 校验通过回 `authOk`，随后才接受其余控制帧；不通过回 `authFailed` 并关闭连接。

### 12.5 连接与生命周期

- 一个 endpoint 同时只服务一条控制通道：daemon 同步处理一条连接，断开后回到 accept
  等待下一次接入。
- 连接断开时，该连接上的全部 Core 进程被关闭；daemon 进程继续监听。
- 每条连接上的 daemon 状态（channel 表、计数、grace）独立。
- 控制通道**不因没有工作区而 grace 退出**（`DaemonOptions.idle_exit = false`）：控制通道
  本身是生命周期边界，目录选择期间可以长时间没有工作区。
- 远程 daemon 是常驻 server：一条连接结束后回到 accept 继续等待下一条；只有 `shutdown`
  帧（`kill` 发的）才结束进程。

### 12.6 远端目录选择

- `listDirectories { path }`：`path` 为 `null` / 空串时从目标机器的主目录开始；
  返回该目录的子目录（按名字排序）与上级目录。
- 路径必须是绝对路径：Host 拿到的目录名要能直接当工作区路径用。
- 只列子目录，不列文件；Host 在鉴权通过后立刻请求一次，据此弹出远端目录选择器。

### 12.7 本地同机不走 daemon

- 本地同机的工作区由 Host 直接用 `serve` 起一个 Core 进程（`createStandaloneCoreBus`），
  stdio 是帧通道：不监听端口、不需要 token，也不经过 daemon。
- daemon 只服务远程 endpoint（`tcp` 传输）。因此 token / 端口 / 端口 +1 重试
  只对远程接入有意义。

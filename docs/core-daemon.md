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
  - `stdio`：Core 模式，stdio 是帧通道（`docs/standalone-core.md` 第 4 节）；
  - `start`（缺省）：远程服务的启动器——确保后台 daemon 在跑（没有就拉起），打印连接串后
    退出（第 12 节）；
  - `kill`：结束在跑的 daemon（第 12 节）；
  - `start-daemon`：daemon 实体本身，由 `start` 拉起；内部动作，不出现在 `--help` 里。
- daemon 起 Core 时不再定位第二个可执行文件：以自身路径加 `stdio` 启动。
- daemon 创建的子进程（Core 进程）不显示控制台窗口，与 Core 侧同一条规则。
- **本地同机工作区不走 daemon**：Host 直接用 `stdio` 起一个 Core 进程，stdio 是帧通道
  （不监听端口、不需要 token）。daemon 只服务远程 endpoint。
- **远程 daemon 由用户在目标机器上启动**：`start` 打印连接串（`IP:端口#token`）；
  Host 用它建立 TCP 控制通道（第 12 节）。
- **可独立运行**：`--help` / `-h` 打印用法，`--version` / `-V` 打印版本，未知动作 / 未知选项
  报错并提示 `--help`（退出码 2）。没有动作时按 `start` 处理（直接运行即启动远程服务）。
  可执行文件保留控制台子系统，这样帮助与 `start` 的连接串在终端里可见；宿主与 daemon 起
  本进程时用 `windowsHide` / `CREATE_NO_WINDOW` 隐藏控制台窗口。

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
| Host → daemon | `createDirectory` | `{ kind: 'createDirectory', id: number, path: string }`（父目录不存在时一并创建） |
| daemon → Host | `directoryCreated` | `{ kind: 'directoryCreated', id: number, path: string }` |
| Host → daemon | `renameDirectory` | `{ kind: 'renameDirectory', id: number, path: string, name: string }`（只改同一父目录下的名字，不是移动） |
| daemon → Host | `directoryRenamed` | `{ kind: 'directoryRenamed', id: number, path: string }`（`path` 是改名后的新路径） |
| Host → daemon | `deleteDirectory` | `{ kind: 'deleteDirectory', id: number, path: string, recursive: boolean }`（`recursive` 为 `false` 时只接受空目录） |
| daemon → Host | `directoryDeleted` | `{ kind: 'directoryDeleted', id: number, path: string }` |
| daemon → Host | `directoryFailed` | `{ kind: 'directoryFailed', id: number, error: string, reason: 'notEmpty' \| 'other' }`（列举 / 新建 / 删除共用） |
| Host → daemon | `shutdown` | `{ kind: 'shutdown' }` |
| Host → daemon | `ping` | `{ kind: 'ping' }`（链路心跳，第 12.5 节；`authOk` 之后定期发送） |

- `id` 由 Host 生成，在单条控制通道内唯一；`workspaceOpened` / `workspaceFailed` /
  `directoriesListed` / `directoryCreated` / `directoryRenamed` / `directoryDeleted` /
  `directoryFailed` 回带同一个 `id`。
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

- 打开工作区：本地同机不走 daemon（Host 直接以 `stdio` 起 Core）；远程取该 endpoint 的
  daemon（没有则先建立 TCP 控制通道并鉴权），发 `openWorkspace`；拿到 `descriptor` 后建立
  Connection（`docs/client-connection.md` 第 5 节）。
- 关闭工作区：Client 发 `closeWorkspace`，Connection 销毁。
- Core 崩溃：daemon 重启后在同一 channel 上重置；Client 走第 6 节的恢复路径。
- `connectionId` 与 `channel` 是两层的概念：前者是 Host 侧的路由键，后者是传输层的多路
  复用标识；两者都不进入总线载荷。

---

## 9. 不覆盖范围

- 远程凭证的加密存储（宿主把 token / SSH 口令明文写进 `workspace-state.json`，
  见 `docs/client-connection.md` 第 9 节；钥匙串集成不在范围内）；
- `tcp` 传输的加密（明文直连；跨不可信网络改用 `ssh` 接入，见第 12.8 节）；
- SSH 的密钥 / agent 认证（当前只有口令一种凭证）；
- 断线重连（SSH 断开与 TCP 断开同口径：连接结束即该 endpoint 上全部 Core 关闭）；
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
9. `start` 缺省绑 `0.0.0.0:10975`；端口被占用时从该端口起逐个 +1，连接串给实际端口；
   `--token` 未给出时用操作系统随机数生成。
10. TCP 控制通道第一帧 token 不匹配时回 `authFailed` 并断开，匹配时回 `authOk`；
    鉴权通过后 `listDirectories` 返回目标机器上的子目录（连接后即可弹出远端目录选择）。
11. 本地同机工作区由 Host 直接用 `stdio` 起 Core（stdio 帧通道，无端口、无 token），不经过
    daemon。
12. `ssh` 接入下全部通信走 SSH 端口：daemon 端口不需要对外映射，`~/.local/bin` 里没有
    可执行文件时自动部署、没有在跑时自动启动，已在跑时直接复用；
13. SSH 主机密钥首次连接记录、之后不一致即报错；`start` 失败时把远端 stderr 带回宿主。
12. 可执行文件可独立运行：`--help` / `--version` 直接输出，未知动作 / 未知选项报错并提示
    `--help`；没有动作时按 `start` 处理。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 动作分派 | `core-rs/src/main.rs`（`stdio` / `start` / `start-daemon` / `kill`） |
| daemon 进程与 channel 管理 | `core-rs/src/daemon.rs` |
| 远程服务（后台 daemon、状态文件、目录列举） | `core-rs/src/remote.rs` |
| 控制通道协议 | `core-rs/src/daemon_protocol.rs`、`src/host/standalone/daemonProtocol.ts` |
| Host 侧 daemon 客户端 | `src/host/standalone/CoreDaemon.ts`（建链器：`tcpDaemonOpener`） |
| SSH 客户端 | `src/host/standalone/sshClient.ts`（`ssh2` 库，不依赖系统 OpenSSH） |
| SSH 接入建链与远端引导 | `src/host/standalone/sshTransport.ts`、`sshDaemonBootstrap.ts` |
| 本地单进程 Core | `src/host/standalone/StandaloneEventBus.ts`（`createStandaloneCoreBus`，`stdio`） |
| endpoint → daemon 注册表 | `src/host/bootstrapCore.ts`（`daemonForEndpoint` / `listRemoteDirectories`） |
| 远程连接与目录选择 UI | `electron/main.ts`、`electron/remoteWorkspace/`（vite 页面）、`electron/remoteWorkspacePreload.ts` |
| 帧编解码（内层） | `src/host/standalone/protocol.ts`（不变） |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（重启策略） | `core-rs/src/daemon.rs` |

---

## 12. 远程服务（`start` / `kill`）

### 12.1 动作

- `start`：确保后台 daemon 在跑，把连接串打印到标准输出后**自己退出**（daemon 常驻）。
  - 已有 daemon 在跑（状态文件里的 endpoint 连得上）→ 直接复用它的连接串；
  - 没有 → 以 `start-daemon` 拉起一个后台进程（脱离终端与进程组、stdin 置空、诊断追加到
    `~/<configDir>/core-daemon.log`），等它落盘后打印；
  - 本次参数与在跑的 daemon 不一致（`--host` / `--port` / `--token`）→ 报错退出，
    不静默忽略用户给的参数。
- `kill`：结束在跑的 daemon——连上它、`auth`、发 `shutdown`，随后清掉状态文件。
  幂等：没有状态文件、或文件里的 daemon 已经不在，都算目标状态已达成（退出码 0）；
  只有「连上了但 token 对不上」才报错。
  连上了但协议无应答（endpoint 探得通、`auth` 等不到应答——accept 循环被死连接占住的
  旧版 daemon）时按进程兜底强杀：扫描 `/proc` 找「本可执行文件 + `start-daemon`」的
  进程 SIGKILL（精确匹配 `argv[0]` 与 `argv[1]`，不靠名字模式，不会误伤别的进程），
  然后同样清掉状态文件；找不到匹配进程才报错。
- `start-daemon` 是启动器的内部实现，不出现在 `--help` 里；也可以直接运行（调试用）。
- 没有动作时按 `start` 处理。

### 12.2 选项

- `--host <addr>`：绑定地址，默认 `0.0.0.0`（绑全部网卡，跨机接入开箱可用；SSH 引导与
  本机自测传 `127.0.0.1`，SSH 见 12.8）；
- `--port <n>`：绑定端口，默认 `10975`；被占用时从该端口起**逐个 +1 重试**
  （最多 20 次；`--port 0` 交给内核，不重试）；
- `--token <token>`：token，给出时用它（并写回 token 文件）；缺省时优先复用 token 文件里的，
  没有才用**操作系统安全随机数**生成（128 位十六进制）。

### 12.3 状态文件与连接串

- 状态文件 `~/<configDir>/core-daemon.json`（与 `settings.json` 同目录），字段：
  `requested`（启动时请求的 `host:port`）、`endpoint`（实际监听的 `IP:端口`）、`token`。
- **只有 daemon 写它**：daemon 同时知道实际绑定的端口与生效的 token。原子落盘；
  Unix 上权限 `0600`（token 是凭证）。`kill` 只在文件内容仍是该 daemon 那份时删除它
  （期间可能有新 daemon 覆盖过）。
- 状态文件缺失、或里面的 endpoint 连不上，都按「没有 daemon」处理（`start` 会拉起新的）。
- 连接串是**一行一条**的 `<IP>:<端口>#<token>`：桌面端只有一个输入框，整行粘贴即可接入。
  端口是**实际**监听的那个（`--port 0` 或 +1 重试后与请求值不同）。
- 绑定地址是通配地址时**遍历全部网卡**：每个非回环 IPv4 一条连接串，末尾固定补一条回环
  （绑通配地址的 daemon 必然在回环上可达）；绑具体地址时只列它本身。
- endpoint 存的是**绑定的**主机（通配地址原样保留）：状态文件里的通配主机在探测 / `kill`
  时先换成回环，因为直接连 `0.0.0.0` 在 Windows 上会失败。
- token 另存一份 `~/<configDir>/core-daemon.token`（与会话数据同目录，Unix 上 `0600`）：
  状态文件是**本次 daemon** 的落盘结果、`kill` 会删掉它，token 却应该跨重启保留——
  否则每次重启 daemon 都得重新抄一遍连接串。取值顺序是
  `--token` > token 文件 > 新随机，三者都会把结果写回该文件。
- token 文件写不进去只打警告：token 已经生效，文件没写成不该让 daemon 起不来。

### 12.4 鉴权

- TCP 控制通道的第一帧必须是 `auth`；daemon 用定长比较校验 token。
- 校验通过回 `authOk`，随后才接受其余控制帧；不通过回 `authFailed` 并关闭连接。
- 第一帧有等待上限（10s）：accept 循环是同步单连接，连接后不发 `auth` 的探活连接 /
  端口扫描占着它，后续接入全部饿死。超时即关闭这条连接；上限只在鉴权阶段生效，
  通过后立刻清除，控制通道此后可以无限期空闲。

### 12.5 连接与生命周期

- 一个 endpoint 同时只服务一条控制通道：daemon 同步处理一条连接，断开后回到 accept
  等待下一次接入。
- 连接断开时，该连接上的全部 Core 进程被关闭；daemon 进程继续监听。
- 「断开」有两条判定路径：
  - TCP 层的 EOF / 读错误（Host 正常退出、socket 被关闭）；
  - **心跳空闲超时**（60s）：Host 每 15s 发一帧 `ping`，daemon 见到首个 `ping` 后
    武装空闲计时，此后任何控制帧都顺延它；超时仍无帧即按断开处理。Host 消失而
    TCP 未断（断网 / 休眠 / 进程冻结）时读线程永远等不到 EOF，沉默是 daemon 唯一
    的断开依据——同步 accept 循环被死连接占住时，后续接入全部堆在 backlog 里：
    TCP 探测照样「连得上」，`auth` 却永远得不到应答（Host 侧表现为建链超时）。
    旧版 Host 不发 `ping`，daemon 不武装计时，行为与原来一致；daemon 收到未知帧
    一律丢弃并记录，不因此断开。
- 每条连接上的 daemon 状态（channel 表、计数、grace）独立。
- 控制通道**不因没有工作区而 grace 退出**（`DaemonOptions.idle_exit = false`）：控制通道
  本身是生命周期边界，目录选择期间可以长时间没有工作区。
- 远程 daemon 是常驻 server：一条连接结束后回到 accept 继续等待下一条；只有 `shutdown`
  帧（`kill` 发的）才结束进程。
- 控制连接开启 TCP keepalive（空闲 45s 起、每 10s 探、3 次无应答判死）：SSH 接入时
  对端是本机 sshd，探活无意义但无害；直连 `tcp` 模式下 daemon 不主动发帧、读不到
  EOF，这是对端消失后唯一的回收手段。

### 12.6 远端目录选择

- `listDirectories { path }`：`path` 为 `null` / 空串时从目标机器的主目录开始；
  返回该目录的子目录（按名字排序）与上级目录。
- `createDirectory { path }`：新建目录，父目录不存在时一并创建；返回实际路径。
- `renameDirectory { path, name }`：重命名目录，只换同一父目录下的名字。`name` 必须是纯名字
  （不含分隔符、不是 `.` / `..`），目标已存在时拒绝、不覆盖；改名与移动是两件事，不开放移动。
- `deleteDirectory { path, recursive }`：删除目录。`recursive` 为 `false` 时只接受空目录，
  非空回 `directoryFailed` 且 `reason = 'notEmpty'`；Host 据此把删除升成「目录非空，
  连同其中的全部内容一起删除？」的**第二次确认**，确认后才带 `recursive = true` 重发。
- 无论哪种模式都拒绝文件系统根（`/`、`C:\`）：删根几乎一定是操作失误。
- 三个动作的路径都必须是绝对路径：Host 拿到的目录名要能直接当工作区路径用。
- 只列子目录，不列文件；Host 在鉴权通过后立刻请求一次，据此弹出远端目录选择器。
- 选择器页面是 `electron/remoteWorkspace/`（vite 产物，加载 `dist/remoteWorkspace/index.html`）：
  路径可编辑、列表首行是 `..`（上级）、工具栏可新建文件夹。破坏性操作不进常显 UI：
  右键目录行弹出「重命名 / 删除」菜单，选中后在该行内联编辑（重命名直接改名字；
  删除空目录一次确认、非空目录二次确认后递归删除）。
- 路径输入停顿 250ms 后刷新列表（`electron/remoteWorkspace/pathInput.ts` 负责拆分）：
  输入是**存在的目录**就展开它的内容；不是就把最后一段当**前缀过滤词**，列父目录再筛
  （`/workspace/a` 只留 `a` 开头的目录）。末尾带分隔符表示「这一级敲完了」，列它自己。
  过滤只作用于目录名——daemon 的目录列举本来就只回目录、不含文件。
- 列表按输入**预览**，不回写输入框（用户还在敲）；回车才是正式跳转，失败会给明确错误。

### 12.7 本地同机不走 daemon

- 本地同机的工作区由 Host 直接用 `stdio` 起一个 Core 进程（`createStandaloneCoreBus`），
  stdio 是帧通道：不监听端口、不需要 token，也不经过 daemon。
- daemon 只服务远程 endpoint（`tcp` / `ssh` 传输）。因此 token / 端口 / 端口 +1 重试
  只对远程接入有意义。

### 12.8 SSH 接入（`ssh` scheme）

目标机器只开放 SSH 端口、daemon 端口映射不出来时，用 `ssh` 接入：**全部通信走 SSH 端口**，
不需要端口映射，也不需要目标机器预装任何东西（Host 侧用 `ssh2` 库实现 SSH 客户端，
不依赖系统 OpenSSH）。

建链（`src/host/standalone/sshTransport.ts`）：

1. 按 SSH 的 host / port / user / 口令建立连接（口令鉴权；主机密钥首次记录、之后不一致
   即报错，指纹存 `~/<configDir>/known-hosts.json`）；
2. 引导远端 daemon（`sshDaemonBootstrap.ts`，见下）；
3. 在远端开一条 `direct-tcpip` 转发通道到该 daemon（等价于 `ssh -W`），它就是要用的
   控制通道；随后第一帧发 `auth`，之后与 `tcp` 接入完全同构。

引导的三条分支（按顺序判断）：

| 情况 | 判据 | 行为 |
| --- | --- | --- |
| 已经在跑 | 状态文件里的 endpoint 探得通，且远端可执行文件与本机携带产物一致（`sha256sum` 比对） | 直接复用：不重启 daemon、不覆盖可执行文件；只在缺自带 `ripgrep/` 时补传它 |
| 在跑但产物过期 | 探得通，但远端可执行文件与本机携带产物不一致（或哈希读不出，按过期处理） | `<可执行文件> kill`（幂等）→ 覆盖上传本机携带产物 → `start --host 127.0.0.1`。daemon 是常驻进程，旧版本应用留下的 daemon 会一直用旧产物拉起 Core（帧协议兼容、行为缺失——新增契约事件不发），不换血则远端永远跑旧版本 |
| 已部署未启动 | 可执行文件在、探测不通 | 产物与本机携带一致时原样使用，不一致则覆盖上传；补齐缺的自带 `ripgrep/`（若缺），执行 `<可执行文件> start --host 127.0.0.1`（幂等），再读状态文件 |
| 未部署 | `~/.local/bin` 下没有可执行文件 | 上传本机携带的对应平台产物（按远端 `uname -sm` 选平台）后 `start --host 127.0.0.1` |

- SSH 引导以 `--host 127.0.0.1` 启动 daemon：转发连接从远端本机发起，daemon 端口不出
  机器，绑回环使端口不对外暴露。直连 `tcp` 的连接串模式不受影响（`start` 缺省仍绑
  `0.0.0.0`，见 12.1）。绑定地址不作为复用条件——已在跑的 daemon 原样复用，存量宽绑定
  的 daemon 在下一次产物换血时自然迁到回环。

- 产物固定落在 `~/.local/bin`（远端 Linux；产物按 `arch-platform` 目录从
  `resources/core/` 取，见 `docs/standalone-core.md` 第 4.1 节）：可执行文件
  `~/.local/bin/<core.binaryName>`，自带的 ripgrep 在
  `~/.local/bin/ripgrep/rg`——Core 以**自己的可执行文件目录**为基准定位自带资源，
  远端机器不需要预装 `rg`。
- 产物以「与本机携带版本一致」为准：远端可执行文件的 sha256 与本机携带产物不一致
  （或 `sha256sum` 不可用 / 读不出，按过期处理）就覆盖上传。这条对「已经在跑」同样
  生效——否则升级桌面端后，远端常驻 daemon 会一直用旧产物拉起 Core。直连 `tcp` 的
  远端没有引导通道，产物升级由使用者自行完成。
- 覆盖上传走**临时名 + `mv` 原子换名**：状态文件可能丢失而 daemon 仍在执行该文件
  （此时宿主无从得知它在跑），对执行中的文件直接覆盖写是 `ETXTBSY`（SFTP 报
  `Failure`）；`mv` 只换目录项，运行中的进程继续用旧 inode。换血时先 `kill` 再覆盖
  只是让旧 daemon 尽快停止服务，不依赖它来保证覆盖成功。
- 状态文件缺失时按「没有 daemon」处理（与 `start` 同口径）：若旧 daemon 实际仍在跑并
  占着端口，重新 `start` 的 daemon 按 12.2 的规则 +1 换端口并在新的状态文件里登记，
  宿主跟着状态文件接入新端口——旧 daemon 成为无状态文件的残留（只拒绝 token 不匹配
  的连接），需要时在远端手工清理。
- 自带 `ripgrep/` 仍按「缺哪个补哪个」（哈希门禁只管可执行文件）；本机产物里没有这份
  ripgrep 属于构建不完整，直接报错，不静默降级。
- daemon 的端口与 token **以远端状态文件为准**（第 12.3 节）：Host 读
  `~/<configDir>/core-daemon.json`，把通配地址换成回环后转发。
- 状态文件缺失 / 损坏 / 连不上都按「没有在跑」处理，与 `start` 自己的判据同口径。
- 任何一步失败都直接报错（`start` 的退出码与 stderr 一并带回宿主），不回退到「先连上
  再说」。
- SSH 连接的生命周期就是控制通道的生命周期：SSH 断开等于控制通道断开，该 endpoint 上
  的全部 Core 一并关闭。

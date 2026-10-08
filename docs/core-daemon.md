# 规格：Core daemon

本规格描述 Core 进程的 daemon：Standalone Core 进程由 daemon 启动、监督与终止，帧通道
在 daemon 上多路复用。一个 endpoint 对应一个 daemon，同时服务多条控制连接（每条连接
是一个客户端）；每（连接, 工作区）一个 Core 进程。一条连接断开只结束该连接的全部 Core，
任一连接发 `shutdown` 才结束整个 daemon（第 12.5 节）。

Standalone Core 的进程形态与帧协议见 `docs/standalone-core.md`；连接模型见
`docs/client-connection.md`；Core 与 UI 的分离形态见 `docs/core-ui-separation.md`。

---

## 1. 能力

1. **一个 endpoint 一个 daemon**：本地一个；每个远程 endpoint 一个（`{ scheme, host, port }`
   相同即同一 endpoint，见第 12 节）。
2. **多客户端并发**：daemon 同时服务多条控制通道，连接之间互不阻塞；客户端身份就是
   那条控制连接本身，不是来源 IP（同一来源 IP 的多条连接就是多个客户端）。
3. **每（连接, 工作区）一个 Core 进程**：由 daemon 启动，daemon 持有其 stdio；两个
   客户端打开同一工作区得到两个互相独立的 Core 进程（对齐本地多窗口语义，不做跨
   客户端共享）。
4. **多路复用**：每个 Host 与 daemon 之间一条控制通道；每个 Core 的帧通道是它上面的
   一条逻辑 channel。
5. **生命周期归 daemon**：Core 的启动、重启、终止都由 daemon 承担，Host 不直接管理进程。
6. **状态按连接隔离**：channel 表、channel id 序列、计数、grace 与心跳（ping/pong）
   都按连接持有；一条连接断开只结束该连接及其全部 Core，其余连接不受影响。
7. **帧语义不变**：daemon 只加一层信封，不改 `docs/standalone-core.md` 第 6.2 节的帧集合。
8. **同一二进制**：daemon 与 Core 是同一个可执行文件的两个模式，版本天然一致。
9. **通道描述符**：daemon 返回 `ChannelDescriptor`，今天表达「走这条控制通道、channel N」，
   将来可以表达「去连这个地址」，Host 上层不因此改动。

---

## 2. 术语

| 术语 | 含义 | owner |
| --- | --- | --- |
| daemon | 每个 endpoint 一个的 Core 进程管理者 | host |
| 客户端 | 一条控制连接；daemon 同时服务多个 | daemon |
| 控制通道 | Host 与 daemon 之间的双向帧通道 | 传输层 |
| channel | 控制通道上承载一个 Core 帧通道的逻辑通道 | 传输层 |
| ChannelDescriptor | 描述如何获得某个 channel 的帧通道 | 传输层 |
| Core 进程 | 一个 Standalone Core 实例，归属一条连接的一个工作区 | daemon 启动，Core 自身 |
| grace 期 | 计数归零后等待新 Core 的窗口 | daemon |

---

## 3. 进程形态

- daemon 与 Core 是同一个可执行文件（`core.binaryName`），用**动作**（子命令，裸词）选择
  做什么，`--idle-exit` 这类**选项**才带 `--`：
  - `stdio`：Core 模式，stdio 是帧通道（`docs/standalone-core.md` 第 4 节）；
  - `start`（缺省）：远程服务的启动器——确保后台 daemon 在跑（没有就拉起），打印就绪
    信息后退出（第 12 节）；
  - `kill`：结束在跑的 daemon（第 12 节）；
  - `start-daemon`：daemon 实体本身，由 `start` 拉起；内部动作，不出现在 `--help` 里。
- daemon 起 Core 时不再定位第二个可执行文件：以自身路径加 `stdio` 启动。
- daemon 创建的子进程（Core 进程）不显示控制台窗口，与 Core 侧同一条规则。
- **本地同机工作区不走 daemon**：Host 直接用 `stdio` 起一个 Core 进程，stdio 是帧通道
  （不监听端口）。daemon 只服务远程 endpoint。
- **远程 daemon 只监听目标机器的回环地址，端口由内核分配**：Host 经 SSH 部署 / 启动
  daemon，再用 SSH 转发通道接入（第 12 节）；端口不出机器，用户不需要填任何连接信息。
- **可独立运行**：`--help` / `-h` 打印用法，`--version` / `-V` 打印版本，未知动作 / 未知选项
  报错并提示 `--help`（退出码 2）。没有动作时按 `start` 处理（直接运行即启动远程服务）。
  可执行文件保留控制台子系统，这样帮助与 `start` 的输出在终端里可见；宿主与 daemon 起
  本进程时用 `windowsHide` / `CREATE_NO_WINDOW` 隐藏控制台窗口。

---

## 4. 通道模型

```
Host A ── 控制通道 ──┐
                     ├─ daemon ──┬── Core A1（A 连接的 channel 1）
Host B ── 控制通道 ──┘           └── Core B1（B 连接的 channel 1）
```

- 每个 Host 与 daemon 之间一条控制通道；daemon 同时服务多条，每条连接一个服务线程，
  一条连接里的任何等待（目录列举、Core 重启）不阻塞其它连接。
- 每条 channel 上跑的帧与 `docs/standalone-core.md` 第 6.2 节完全一致；daemon 不解读
  内层帧，只按 channel 转发。
- channel id 由 daemon 分配，在**一条控制通道内**唯一且**稳定**：Core 崩溃重启后沿用
  同一个 channel id（第 6 节）；不同连接的编号空间互相独立（都从 1 起）。
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
| 控制连接断开（Host 退出 / 崩溃 / 心跳空闲超时） | 关闭该连接上的全部 channel 与 Core；服务线程结束，daemon 继续服务其它连接 |
| 收到 `shutdown` | 结束整个 daemon：全部连接各自关闭自己的全部 channel 与 Core 后，进程退出（第 12.5 节） |

计数与退出：

- 计数按连接维护：每条连接的会话自己持有 `liveCores`（本连接活着的 Core 进程数），
  不跨连接汇总。
- `liveCores` 归零后启动 **grace 计时器（30s）**；期间收到新的 `openWorkspace` 则取消
  计时器；到期后该连接的会话结束。grace 期避免「关一个工作区又开一个」时反复启停。
- 远程 daemon 的连接**不启用** grace 退出（`DaemonOptions.idle_exit = false`）：控制
  通道本身是生命周期边界，目录选择期间可以长时间没有工作区（第 12.5 节）。
- Host 断开后不给 Core 留存活口子：连接断开即关闭该连接的全部 Core。允许 Core 在
  Host 断开后存活是重连场景的需求，不在本规格范围内（第 9 节）。

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
| Host → daemon | `ping` | `{ kind: 'ping' }`（链路心跳，第 12.5 节；链路就绪后定期发送） |
| daemon → Host | `pong` | `{ kind: 'pong' }`（对 `ping` 的应答，第 12.5 节） |

- `id` 由 Host 生成，在单条控制通道内唯一；`workspaceOpened` / `workspaceFailed` /
  `directoriesListed` / `directoryCreated` / `directoryRenamed` / `directoryDeleted` /
  `directoryFailed` 回带同一个 `id`。
- 内层帧是 `docs/standalone-core.md` 第 6.2 节的帧集合，原样嵌套在 `frame.frame` 里。
- 未知类型一律丢弃并记录，不做静默降级。

### 7.3 握手

控制通道没有协议版本握手：daemon 与 Host 随同一份产物分发，版本由分发保证。Core 与 Host
之间的协议版本校验仍在各自 channel 的 `hello` / `ready` 上完成
（`docs/standalone-core.md` 第 6.3 节）。

### 7.4 背压

- 控制通道是所有 channel 的公共路径：单条 channel 的拥塞不得阻塞其它 channel。
- 一条控制连接的拥塞不得阻塞其它连接（每条连接一个服务线程，状态互相独立）。
- 不丢帧、不合并帧；单条 channel 内保持顺序。
- 控制通道的写入方维护有序出站队列；越软水位时记录诊断，不丢弃帧。

---

## 8. 与 Connection 的关系

- 打开工作区：本地同机不走 daemon（Host 直接以 `stdio` 起 Core）；远程取该 endpoint 的
  daemon（没有则先建立控制通道），发 `openWorkspace`；拿到 `descriptor` 后建立
  Connection（`docs/client-connection.md` 第 5 节）。
- 关闭工作区：Client 发 `closeWorkspace`，Connection 销毁。
- Core 崩溃：daemon 重启后在同一 channel 上重置；Client 走第 6 节的恢复路径。
- `connectionId` 与 `channel` 是两层的概念：前者是 Host 侧的路由键，后者是传输层的多路
  复用标识；两者都不进入总线载荷。

---

## 9. 不覆盖范围

- 远程凭证的加密存储（宿主把 SSH 口令明文写进 `workspace-state.json`，
  见 `docs/client-connection.md` 第 9 节；钥匙串集成不在范围内）；
- SSH 的密钥 / agent 认证（当前只有口令一种凭证）；
- 断线重连（SSH 断开与 TCP 断开同口径：一条连接结束即关闭它自己的全部 Core，其余
  连接不受影响）；
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
5. 控制连接断开时，该连接的全部 Core 被关闭，服务线程结束，daemon 继续服务其它连接。
6. Core 崩溃后 daemon 在同一 channel 上重启它；超过重启上限时关闭 channel 并报告。
7. 内层帧与 `docs/standalone-core.md` 第 6.2 节逐项一致，daemon 不解读内层帧。
8. 单条 channel 的拥塞不阻塞其它 channel；一条连接的等待不阻塞其它连接。
9. daemon 恒绑 `127.0.0.1`、端口交给内核分配。
10. 控制通道上的 `listDirectories` 返回目标机器上的子目录（连接后即可弹出远端目录选择）。
11. 本地同机工作区由 Host 直接用 `stdio` 起 Core（stdio 帧通道，无端口），不经过
    daemon。
12. `ssh` 接入下全部通信走 SSH 端口：daemon 端口不需要对外映射，远端部署槽位
    `~/.local/share/<core.deployPrefix>/<指纹>/`
    里没有可执行文件时自动部署、该指纹的 daemon 没有在跑时自动启动（端口交给内核
    分配），已在跑时直接复用；不同版本的客户端各占一个指纹槽位，互不覆盖、互不踢；
13. SSH 主机密钥首次连接记录、之后不一致即报错；`start` 失败时把远端 stderr 带回宿主。
14. 可执行文件可独立运行：`--help` / `--version` 直接输出，未知动作 / 未知选项报错并提示
    `--help`；没有动作时按 `start` 处理。
15. 多客户端并发：两条连接各自打开同一工作区，得到两个互相独立的 Core 进程
    （channel id 按连接独立分配）；一端断开只关闭它自己的 Core 与 channel，另一端
    不受影响（channel 不 reset、Core 不重启）。
16. 连上后一直不发帧的探活连接不阻塞后续接入：下一条连接立即得到服务。
17. 任一连接发 `shutdown` 即结束整个 daemon 进程：结束前该 daemon 上全部连接的 Core 都
    被各自的会话关闭。
18. 空闲退出（`--idle-exit 30`，SSH 引导）：daemon 启动后一直没有连接、或最后一条连接
    断开后满 30s，daemon 自行退出并清掉状态文件；期间任何新连接取消计时，断开后重新
    起算；`shutdown` 与空闲死线同时逼近时 `shutdown` 先到按停机处理。
19. 并发首次引导：两台机器的客户端同时对同一台未部署的服务器引导，同指纹只拉起一个
    daemon（`start` 的按指纹互斥锁，第 12.3 节）；并发部署产物互不损坏（客户端唯一
    暂存名 + 原子换名，第 12.8 节）。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 动作分派 | `core-rs/src/main.rs`（`stdio` / `start` / `start-daemon` / `kill`） |
| daemon 进程与 channel 管理 | `core-rs/src/daemon.rs` |
| 远程服务（后台 daemon、状态文件、目录列举） | `core-rs/src/remote.rs` |
| 控制通道协议 | `core-rs/src/daemon_protocol.rs`、`src/host/standalone/daemonProtocol.ts` |
| Host 侧 daemon 客户端 | `src/host/standalone/CoreDaemon.ts` |
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

- `start`：确保后台 daemon 在跑，把就绪信息打印到标准输出后**自己退出**（daemon 常驻）。
  - 已有 daemon 在跑（状态文件里的 endpoint 连得上）→ 直接复用它，打印它的实际端口；
  - 没有 → 以 `start-daemon` 拉起一个后台进程（脱离终端与进程组、stdin 置空、诊断追加到
    `~/<configDir>/logs/core-daemon-<指纹>.log`，按指纹区分见 12.3），等它落盘后打印。
  - 「检查 → 拉起」全程持按指纹的互斥锁（第 12.3 节）：两台机器的客户端同时首次引导
    同一台服务器时，同指纹只拉起一个 daemon；等锁的一方锁后重查，直接复用对方拉起的。
- `kill`：结束在跑的 daemon——连上它、`ping` 探活、发 `shutdown`，随后清掉状态文件。
  幂等：没有状态文件、或文件里的 daemon 已经不在，都算目标状态已达成（退出码 0）。
  连上了但 `ping` 等不到 `pong`（daemon 进程卡死）时按进程兜底强杀：扫描 `/proc` 找
  「本可执行文件 + `start-daemon`」的进程 SIGKILL（精确匹配 `argv[0]` 与 `argv[1]`，
  不靠名字模式，不会误伤别的进程），然后同样清掉状态文件；找不到匹配进程才报错。
- `start-daemon` 是启动器的内部实现，不出现在 `--help` 里；也可以直接运行（调试用）。
- 没有动作时按 `start` 处理。

### 12.2 选项

- `--idle-exit <秒>`：空闲退出——没有任何控制连接持续该秒数后 daemon 自行退出（0 视为
  没给）。SSH 引导固定传 30（见 12.8）：客户端异常退出（crash / 断电）后远端不留常驻
  进程。缺省不设：daemon 常驻，只有 `shutdown`（`kill`）结束。
- 没有绑定地址 / 端口 / 凭证选项：daemon 恒绑 `127.0.0.1`、端口交给内核分配（见 12.3）。

### 12.3 状态文件

- 落盘文件按**构建指纹**区分（`docs/standalone-core.md` 第 4.4 节；都在配置目录的
  子目录里，不与 `settings.json` 混放）：状态文件（运行期事实）与 start 互斥锁在
  `run/` 子目录，诊断日志在 `logs/` 子目录（与宿主侧日志同目录）：
  状态文件 `~/<configDir>/run/core-daemon-<指纹>.json`、诊断日志
  `~/<configDir>/logs/core-daemon-<指纹>.log`。一个指纹一个 daemon、一份落盘文件：
  多版本 Core 在同一台远端机器上各占一个槽位时，各自的 `start` / `kill` / 探测只作用于
  自己指纹的 daemon，互不踩踏。命名规则与 `src/host/standalone/daemonProtocol.ts` 的
  `daemonStateFileName` / `daemonLogFileName` 一致，改动必须同步两侧。
- 状态文件字段：`endpoint`（实际监听的 `127.0.0.1:<端口>`）。
- **只有 daemon 写它**：daemon 知道实际绑定的端口。原子落盘（落盘前自建 `run/`
  目录）；Unix 上权限 `0600`。
  `kill` 只在文件内容仍是该 daemon 那份时删除它（期间可能有新 daemon 覆盖过）。
- 状态文件缺失、或里面的 endpoint 连不上，都按「没有 daemon」处理（`start` 会拉起新的）。
- **start 互斥锁**：`core-daemon-<指纹>.json.lock`（状态文件名加 `.lock`，与状态文件
  同在 `run/` 子目录，
  自动按指纹区分——同版本才互斥，多版本各锁各的）。`start` 在「检查 → 拉起 → 等就绪」
  全程持锁：锁文件用 `O_CREAT | O_EXCL` 创建并写入持有者 pid；pid 已死或锁文件无 pid
  且超过宽限（15s）即被接管，持有者崩溃不留永久锁；等锁超时（15s）报错退出，不静默
  拉起第二个 daemon。锁只互斥 `start` 本身，daemon 运行期不持锁。
- endpoint 恒为 `127.0.0.1:<端口>`：daemon 只绑回环，端口由内核分配，多版本 daemon 并存
  时互不抢固定端口。Host 读它开 SSH 转发通道（第 12.8 节），端口不出目标机器。

### 12.4 接入边界

- daemon 只监听 `127.0.0.1`：控制通道不可从网络直接到达，访问边界就是承载它的 SSH 通道
  （第 12.8 节）。
- 控制通道上没有单独的鉴权帧：能连上回环端口的进程已经在目标机器上，SSH 已完成机器级
  认证。
- 连上后一直不发帧的连接由心跳空闲回收兜底（第 12.5 节）：控制通道建立即武装心跳死线，
  沉默超过 `heartbeat_timeout` 即关闭这条连接，不长期占用服务线程。

### 12.5 连接与生命周期

- 一个 endpoint 的 daemon 同时服务多条控制通道：accept 循环每接受一条连接就交一个
  线程去服务（thread-per-connection，同步阻塞模型，不引入 async runtime），随即回到
  accept。客户端身份就是那条控制连接，不是来源 IP：同一来源 IP 的多条连接就是多个
  客户端。一条连接里的任何等待（目录列举、Core 重启）都不阻塞其它连接。
- 每（连接, 工作区）一个 Core 进程：channel 表、channel id 序列、计数、grace 与心跳
  （ping/pong）都按连接持有，互相隔离；两个客户端打开同一工作区得到两个互相独立的
  Core 进程（对齐本地多窗口语义，不做跨客户端共享）。
- 连接断开时，该连接上的全部 Core 进程被关闭；服务线程结束，daemon 进程继续监听并
  服务其它连接。
- 「断开」有三条判定路径：
  - TCP 层的 EOF / 读错误（Host 正常退出、socket 被关闭）；
  - **心跳空闲超时**（60s，daemon 判 Host）：Host 每 1s 发一帧 `ping`，daemon 每帧
    回 `pong`；心跳计时在控制通道建立时武装，此后任何控制帧都顺延它，超时仍无帧
    即按断开处理（连上后一直不发帧的连接也由此回收）。Host 消失而 TCP 未断（断网 /
    休眠 / 进程冻结）时读线程永远等不到 EOF，沉默是 daemon 唯一的断开依据。心跳
    计时按连接独立武装与顺延；daemon 收到未知帧一律丢弃并记录，不因此断开。
  - **Host 侧沉默判定**（≤ 3s，Host 判 daemon）：daemon 死而 socket 未断（对端
    断电 / 网络分区）与 daemon 卡死，在 socket 层都没有任何信号，唯一依据是
    `pong` 的有无。Host 见到首个 `pong` 后武装沉默死线（2.5s）——链路上这么久
    没有任何入站帧即补发一帧探针 `ping`，再宽限 400ms，仍无任何入站帧就 kill
    链路并按 fatal 上报。探针宽限吸收本进程卡顿（定时器迟到、入站帧积压在内核
    缓冲），不误杀活链路；判死上限 = 死线 + 宽限 ≤ 3s。对端不回 `pong` 时 Host 不
    武装沉默判定（不误杀），判死退回 TCP 层的节奏。
- 控制通道**不因没有工作区而 grace 退出**（`DaemonOptions.idle_exit = false`）：控制通道
  本身是生命周期边界，目录选择期间可以长时间没有工作区。
- 远程 daemon 是常驻 server：一条连接结束后继续等待下一条；只有 `shutdown` 帧
  （`kill` 发的）才结束进程。给了 `--idle-exit`（SSH 引导传 30，见 12.8）的 daemon
  额外有空闲退出：**没有任何控制连接**持续该秒数就自行退出——死线在 daemon 启动时
  （兜住「拉起后无人接入」的孤儿）与最后一条连接断开时各起算一次，任何一条连接登记
  即取消；到期退出与 `shutdown` 同一条收尾路径（清状态文件、全连接收尾），到期的
  置位让迟到的连接被拒绝。断开后 30s 内的重连照常复用，不用重新 start。
- **`shutdown` 全局生效**：任一连接发 `shutdown` 即结束整个 daemon 进程，结束前该
  daemon 上全部连接的 Core 都被关闭。停机顺序：收到 `shutdown` 的连接先关闭自己的
  全部 Core（与断开同一条收尾路径），随后在连接注册表里置停机位，并向每条在途
  连接的会话注入 `HostDisconnected` 事件、同时掐断其 socket——各连接的会话主循环
  随之走自己的「Host 断开」收尾（关闭自己的全部 Core）后线程退出；主线程等全部
  连接收尾后清掉状态文件，进程退出。事件注入是主机制：Windows 上对自身 socket 的
  `shutdown` 不会取消进行中的 read，掐 socket 只作为 Unix 上让读线程立即退出的
  补充。停机窗口内新接受的连接不再服务，直接关闭（shutdown 是全局生效的 kill
  语义，设计允许的瞬时状态）。
- 停机收尾有等待上限（5s）：到点仍有连接没收尾就带着诊断退出，不让一条收不动的
  连接挂死 `kill`。Core 还有 stdin EOF 的兜底：daemon 进程退出后各 Core 读到 EOF
  自行退出。
- 控制连接开启 TCP keepalive（空闲 45s 起、每 10s 探、3 次无应答判死）：SSH 接入时
  对端是本机 sshd，探活无意义但无害；对端消失后读线程等不到 EOF 时，keepalive 是
  socket 层的回收手段（心跳超时兜底控制帧层的沉默）。
- daemon 的诊断按行原子追加到 `logs/core-daemon-<指纹>.log`（`start` 以追加模式把
  stderr 重定向到它）：全部诊断先整行格式化再一次写入（stderr 锁内），多线程并发不丢行、
  不交错半行；追加模式（O_APPEND）保证每次 write 原子落到文件尾。
- 崩溃诊断：进程入口安装 panic 钩子（`util::install_panic_hook`），panic 位置与强制
  捕获的调用栈整块写进上述日志（默认钩子依赖 `RUST_BACKTRACE`，没人设它）；daemon 的
  启动 / 停止、控制连接接入 / 关闭、Core 子进程启动（含 pid）与信号终止（Unix）各落
  一行锚点。release 构建不 strip 并保留行号表（`core-rs/Cargo.toml` 的
  `[profile.release]`；Windows 的行号表在 `.pdb` 里，由 `scripts/build-core.mjs` 随
  可执行文件一并部署），栈帧才能符号化出函数名与行号。

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
- 只列子目录，不列文件；Host 在控制通道建立后立刻请求一次，据此弹出远端目录选择器。
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
  stdio 是帧通道：不监听端口，也不经过 daemon。
- daemon 只服务远程 endpoint（`ssh` 接入）。因此端口只对远程接入有意义。

### 12.8 SSH 接入（`ssh` scheme）

目标机器只开放 SSH 端口、daemon 端口映射不出来时，用 `ssh` 接入：**全部通信走 SSH 端口**，
不需要端口映射，也不需要目标机器预装任何东西（Host 侧用 `ssh2` 库实现 SSH 客户端，
不依赖系统 OpenSSH）。

建链（`src/host/standalone/sshTransport.ts`）：

1. 按 SSH 的 host / port / user / 口令建立连接（口令鉴权；主机密钥首次记录、之后不一致
   即报错，指纹存 `~/<configDir>/known-hosts.json`。指纹变更时宿主弹告警展示新旧指纹，
   用户确认后经 `recordKnownHostFingerprint` 把新指纹写回再重连——
   模块本身不提供「跳过校验」的连接方式）；
2. 引导远端 daemon（`sshDaemonBootstrap.ts`，见下）；
3. 在远端开一条 `direct-tcpip` 转发通道到该 daemon（等价于 `ssh -W`），它就是要用的
   控制通道；控制帧与 `docs/standalone-core.md` 第 6.2 节完全一致。

引导的分支（按顺序判断）：

| 情况 | 判据 | 行为 |
| --- | --- | --- |
| 该指纹的 daemon 在跑 | 该指纹的状态文件 `core-daemon-<指纹>.json` 里的 endpoint 探得通 | 直接复用：不重启 daemon、不覆盖产物；槽位缺可执行文件或共享位缺 `ripgrep` 时补传（「在跑」不等于产物齐全——槽位被外部清过时进程仍在跑） |
| 已部署未启动 | `~/.local/share/<core.deployPrefix>/<指纹>/` 里有可执行文件、探测不通 | 补齐缺的自带 `ripgrep`（若缺），执行 `<可执行文件> start --idle-exit 30`（幂等），再读状态文件 |
| 未部署 | `~/.local/share/<core.deployPrefix>/<指纹>/` 里没有可执行文件 | 上传本机携带的对应平台产物（按远端 `uname -sm` 选平台）后 `start --idle-exit 30` |

- 部署槽位由本机携带产物的**构建指纹**决定（`docs/standalone-core.md` 第 4.4 节）：
  产物落远端部署槽位 `~/.local/share/<core.deployPrefix>/<指纹>/`
  （`coreDeployDirPath`：产品目录取 `core.deployPrefix`，槽位用完整指纹；自带的
  `ripgrep` 提升为产品目录根的共享位 `share/<core.deployPrefix>/ripgrep`，Core 以
  所在槽位的上一级目录定位它，远端机器不需要预装 `rg`），状态 / 日志文件按
  完整指纹命名（第 12.3 节）。多版本 Core 在同一台远端机器上各占一个槽位、各跑
  一个 daemon——不同版本的客户端同时接入互不干扰：新版本天然落在新槽位，旧 daemon
  原样留给旧版本的客户端。
- 「指纹槽位存在即视为同版本」：指纹只由源码内容与编译器身份决定，同一指纹的产物
  行为一致，因此可执行文件存在就不再上传，**不做产物哈希比对**——缺失才部署，
  不无脑覆盖。
- SSH 引导以 `start --idle-exit 30` 启动 daemon：daemon 恒绑 `127.0.0.1`、端口交给内核
  分配（第 12.2 / 12.3 节）——转发连接从远端本机发起，端口不出机器；多版本 daemon
  并存时互不抢固定端口，实际端口随状态文件读回。
  `--idle-exit 30` 让 daemon 在最后一条控制连接断开后自行退出（第 12.5 节）：客户端
  crash / 断电后远端不留常驻进程，「拉起后无人接入」的孤儿 daemon 也由同一条规则兜底。
- 上传走**客户端唯一暂存名 + `mv` 原子换名**：目标可能正被一个在跑的 daemon 执行（它的指纹目录
  被清过、状态文件丢失时宿主无从得知它在跑），对执行中的文件直接覆盖写是 `ETXTBSY`
  （SFTP 报 `Failure`）；`mv` 只换目录项，运行中的进程继续用旧 inode。暂存名带客户端
  的 pid + 随机数后缀：两台机器的客户端同时首次部署同一槽位时各写各的暂存文件，
  不会交错损坏同一个文件，换名后谁先谁后落地的都是完整产物；上传失败时客户端清掉
  自己的暂存，不在远端槽位留半截产物。
- 状态文件缺失时按「没有 daemon」处理（与 `start` 同口径）：若该指纹的 daemon 实际
  仍在跑并占着端口，重新 `start` 的 daemon 由内核分配新端口并在新的状态文件里登记，
  宿主跟着状态文件接入——旧 daemon 成为无状态文件的残留，需要时用该指纹的二进制
  `kill` 清理（`/proc` 兜底按可执行文件路径精确匹配，只命中本指纹的 daemon）。
- 指纹槽位**不做磁盘回收**：多版本累积（每个槽位约 11MB）是接受的语义，需要清理时
  在远端手工删除——先确认该指纹的 daemon 不在跑（状态文件探得通的就是在跑的）。
- 本机产物里没有指纹文件或缺自带的 ripgrep 属于构建不完整，直接报错，不静默降级。
- daemon 的端口 **以远端状态文件为准**（第 12.3 节）：Host 读
  `~/<configDir>/run/core-daemon-<指纹>.json`，按里面的 `127.0.0.1:<端口>` 开转发通道。
- 状态文件缺失 / 损坏 / 连不上都按「没有在跑」处理，与 `start` 自己的判据同口径。
- 任何一步失败都直接报错（`start` 的退出码与 stderr 一并带回宿主），不回退到「先连上
  再说」。
- SSH 连接的生命周期就是控制通道的生命周期：SSH 断开等于控制通道断开，该连接上的
  全部 Core 一并关闭（其余连接不受影响，见第 12.5 节）。

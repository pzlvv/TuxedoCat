---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：Core daemon

本规格描述 Core 进程的 daemon：Standalone Core 进程由 daemon 启动、监督与终止，帧通道
在 daemon 上多路复用。一个 endpoint 对应一个 daemon，同时服务多条控制连接（每条连接
是一个客户端）；每（连接, 工作区）一个 Core 进程。一条连接断开时，连接上非 idle 的 Core
孤儿化存活（后台运行，[specs/031](../../specs/031-remote-detached-tasks/spec.md)），全 idle
的 Core 照旧终止；任一连接发 `shutdown` 才结束整个 daemon（[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)）。

Standalone Core 的进程形态与帧协议见 `docs/core/standalone-core.md`；连接模型见
`docs/core/client-connection.md`；Core 与 UI 的分离形态见 `docs/architecture/core-ui-separation.md`；
远程服务（`start` / `kill`、状态文件与 SSH 接入）见 `docs/core/core-remote.md`。

---

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [能力](#1-能力) |
| 2. | [术语](#2-术语) |
| 3. | [进程形态](#3-进程形态) |
| 4. | [通道模型](#4-通道模型) |
| 5. | [生命周期与计数](#5-生命周期与计数) |
| 6. | [重启](#6-重启) |
| 7. | [协议](#7-协议) |
| 8. | [与 Connection 的关系](#8-与-connection-的关系) |
| 9. | [不覆盖范围](#9-不覆盖范围) |
| 10. | [验收要点](#10-验收要点) |
| 11. | [落点对照](#11-落点对照) |

---

## 1. 能力

1. **一个 endpoint 一个 daemon**：本地一个；每个远程 endpoint 一个（`{ scheme, host, port }`
   相同即同一 endpoint，见 [docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）。
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
7. **帧语义不变**：daemon 只加一层信封，不改 [docs/core/standalone-core.md 第 5.2 节](standalone-core.md#52-帧类型)的帧集合。
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
  - `stdio`：Core 模式，stdio 是帧通道（[docs/core/standalone-core.md 第 3 节](standalone-core.md#3-core-形态)）；
  - `start`（缺省）：远程服务的启动器——确保后台 daemon 在跑（没有就拉起），打印就绪
    信息后退出（[docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）；
  - `kill`：结束在跑的 daemon（[docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）；
  - `start-daemon`：daemon 实体本身，由 `start` 拉起；内部动作，不出现在 `--help` 里。
- daemon 起 Core 时不再定位第二个可执行文件：以自身路径加 `stdio` 启动。
- daemon 创建的子进程（Core 进程）不显示控制台窗口，与 Core 侧同一条规则。
- daemon 拉起的 Core 同样启用父进程看门狗：daemon 被强杀时 Core 在 1 秒内自行退出，
  不在远端留下孤儿（[docs/core/standalone-core.md 第 5.4 节](standalone-core.md#54-关闭)）。
- **本地同机工作区不走 daemon**：Host 直接用 `stdio` 起一个 Core 进程，stdio 是帧通道
  （不监听端口）。daemon 只服务远程 endpoint。
- **远程 daemon 只监听目标机器的回环地址，端口由内核分配**：Host 经 SSH 部署 / 启动
  daemon，再用 SSH 转发通道接入（[docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）；端口不出机器，用户不需要填任何连接信息。
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
- 每条 channel 上跑的帧与 [docs/core/standalone-core.md 第 5.2 节](standalone-core.md#52-帧类型)完全一致；daemon 除忙闲快照缓存
  与请求帧暂存两处只读窥探外不解读内层帧，只按 channel 转发（窥探的动机与边界见
  [第 5 节](#5-生命周期与计数)与 [docs/adr/0012-daemon-frame-peek.md](../adr/0012-daemon-frame-peek.md)）。
- channel id 由 daemon 分配，在**一条控制通道内**唯一且**稳定**：Core 崩溃重启后沿用
  同一个 channel id（第 6 节）；不同连接的编号空间互相独立（都从 1 起）。
- channel 是双向的；两侧的帧按写入顺序转发，不丢帧、不合并（沿用
  [docs/core/standalone-core.md 第 5.5 节](standalone-core.md#55-背压)的背压约定）。

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
| 控制连接断开（Host 退出 / 崩溃 / 心跳空闲超时） | 逐 channel 分叉：最近快照存在非 idle 会话的 Core 孤儿化存活（移入孤儿表，继续执行会话工作），全部 idle（或无快照）的 Core 照旧关闭；服务线程结束，daemon 继续服务其它连接 |
| 收到 `detachWorkspace` | 把该 Core 移入孤儿表（后台运行）、回 `workspaceClosed { reason: 'detached' }`；连接与其余 channel 不受影响 |
| `openWorkspace` 命中孤儿 | 不开新进程：把孤儿 Core 的句柄移交本连接（摘表与移交原子，同路径多条取最早一条），重放孤儿期间缓存的快照与挂起请求 |
| 收到 `shutdown` | 结束整个 daemon：全部连接各自关闭自己的全部 channel 与 Core 后，进程退出（[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)） |

计数与退出：

- 计数按连接维护：每条连接（`daemon.rs` 的 `ChannelState`）自己持有活着的 Core 进程
  （每 channel 一个），不跨连接汇总。
- 连接上活着的 Core 进程归零后启动 **grace 计时器（30s）**；期间收到新的 `openWorkspace` 则取消
  计时器；到期后该连接的会话结束。grace 期避免「关一个工作区又开一个」时反复启停。
- 远程 daemon 的连接**不启用** grace 退出（`DaemonOptions.idle_exit = false`）：控制
  通道本身是生命周期边界，目录选择期间可以长时间没有工作区（[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)）。
- **孤儿化与认领**（[specs/031](../../specs/031-remote-detached-tasks/spec.md)）：连接断开或
  收到 `detachWorkspace` 时，最近快照存在非 idle 会话的 Core 移入**孤儿表**继续执行
  （键 = 工作区路径 + 原连接标识，同一 endpoint 两个客户端的孤儿互不覆盖；登记冲突
  落诊断并按现行关闭兜底）。孤儿表按连接共享，daemon 进程内唯一；对孤儿 Core 的帧
  保持排水（Core 不因无宿主而阻塞），期间仅缓存两类帧——`sessionRuntimeChanged`
  快照（更新忙闲判据，解析失败按忙 fail-safe）与用户请求帧（暂存，超过 Core 应答
  时效 1 小时的不再重放）。对存在孤儿的工作区再次 `openWorkspace` 时认领：不开新
  进程，重放缓存帧（按到达序；缓冲安静时补放最新快照一帧）。孤儿 Core 崩溃不重启，
  移出孤儿表。
- **孤儿收尾**：全 idle 的孤儿满 30s 宽限（沿 US-33 口径，短暂 idle 可能紧随提交）后
  终止并移出孤儿表；daemon 的空闲退出判定为「无控制连接**且**无非 idle 孤儿」持续
  30s（[docs/core/core-remote.md 第 2.2 节](core-remote.md#22-选项)）；`shutdown` 与 daemon 停机时孤儿一并收尾。
  两个客户端并发打开同一工作区仍是两个互相独立的 Core，各自装载会话的互斥由会话锁
  承担（specs/032 会话跨实例独占打开）。

---

## 6. 重启

- **触发**：连接上的 Core 进程在收到 `shutdown` 之前退出。孤儿表里的 Core 退出不重启
  （孤儿没有宿主在等它，崩溃即移出孤儿表，之后对该工作区的 `openWorkspace` 按无孤儿
  处理新起 Core）。
- **策略**：daemon 以退避策略重启该 channel 的 Core 进程（沿用现有
  `CoreProcess.ts` 的 `restartPolicy`：时间窗口 + 最大次数）。
- **上限**：时间窗口内重启次数超过上限时停止重启，关闭该 channel 并向 Host 报告原因，
  不静默重试。
- **恢复**：重启后在**同一 channel** 上重新握手；Host 侧感知为「连接重置」，重新发
  `hello`，重放 `hostEnvironmentProvided`（含配置快照）与已打开的会话
  （[docs/core/standalone-core.md 第 6.2 节](standalone-core.md#62-连接态重放)）。
- **隔离**：一个 channel 的重启不影响其它 channel。

---

## 7. 协议

### 7.1 帧

控制通道沿用 [docs/core/standalone-core.md 第 6.1 节](standalone-core.md#51-帧)的编码：UTF-8，换行分隔的 JSON，
一行一帧。

### 7.2 帧类型

| 方向 | 帧 | 载荷 |
| --- | --- | --- |
| Host → daemon | `openWorkspace` | `{ kind: 'openWorkspace', id: number, workspaceRef }` |
| daemon → Host | `workspaceOpened` | `{ kind: 'workspaceOpened', id: number, channel: number, descriptor: ChannelDescriptor }` |
| daemon → Host | `workspaceFailed` | `{ kind: 'workspaceFailed', id: number, error: string }` |
| Host → daemon | `closeWorkspace` | `{ kind: 'closeWorkspace', channel: number }` |
| Host → daemon | `detachWorkspace` | `{ kind: 'detachWorkspace', channel: number }`（后台运行，[specs/031](../../specs/031-remote-detached-tasks/spec.md)：Core 移入孤儿表，连接与其余 channel 不受影响） |
| daemon → Host | `workspaceClosed` | `{ kind: 'workspaceClosed', channel: number, reason: 'closed' \| 'crashed' \| 'failed' \| 'detached' }` |
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
| Host → daemon | `ping` | `{ kind: 'ping' }`（链路心跳，[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)；链路就绪后定期发送） |
| daemon → Host | `pong` | `{ kind: 'pong' }`（对 `ping` 的应答，[docs/core/core-remote.md 第 2.5 节](core-remote.md#25-连接与生命周期)） |

- `id` 由 Host 生成，在单条控制通道内唯一；`workspaceOpened` / `workspaceFailed` /
  `directoriesListed` / `directoryCreated` / `directoryRenamed` / `directoryDeleted` /
  `directoryFailed` 回带同一个 `id`。
- 内层帧是 [docs/core/standalone-core.md 第 5.2 节](standalone-core.md#52-帧类型)的帧集合，原样嵌套在信封帧的 `frame` 字段里（`daemon_protocol.rs` 的 `Frame { channel, frame }`）。
- 未知类型一律丢弃并记录，不做静默降级。

### 7.3 握手

控制通道没有协议版本握手：daemon 与 Host 随同一份产物分发，版本由分发保证。Core 与 Host
之间的协议版本校验仍在各自 channel 的 `hello` / `ready` 上完成
（[docs/core/standalone-core.md 第 5.3 节](standalone-core.md#53-握手)）。

### 7.4 背压

- 控制通道是所有 channel 的公共路径：单条 channel 的拥塞不得阻塞其它 channel。
- 一条控制连接的拥塞不得阻塞其它连接（每条连接一个服务线程，状态互相独立）。
- 不丢帧、不合并帧；单条 channel 内保持顺序。
- 控制通道的写入方维护有序出站队列；越软水位时记录诊断，不丢弃帧。

---

## 8. 与 Connection 的关系

- 打开工作区：本地同机不走 daemon（Host 直接以 `stdio` 起 Core）；远程取该 endpoint 的
  daemon（没有则先建立控制通道），发 `openWorkspace`；拿到 `descriptor` 后建立
  Connection（[docs/core/client-connection.md 第 5 节](client-connection.md#5-connection-生命周期)）。
- 关闭工作区：Client 发 `closeWorkspace`，Connection 销毁。
- Core 崩溃：daemon 重启后在同一 channel 上重置；Client 走第 6 节的恢复路径。
- `connectionId` 与 `channel` 是两层的概念：前者是 Host 侧的路由键，后者是传输层的多路
  复用标识；两者都不进入总线载荷。

---

## 9. 不覆盖范围

- 远程凭证的加密存储（宿主把 SSH 口令明文写进 `workspace-state.json`，
  见 [docs/core/client-connection.md 第 9 节](client-connection.md#9-落盘与恢复宿主侧)；钥匙串集成不在范围内）；
- SSH 的密钥 / agent 认证（当前只有口令一种凭证）；
- 宿主侧对断网的自动重连（重连由启动恢复、最近列表、重连按钮三类用户动作触发）；
- `{ kind: 'direct' }` 描述符对应的直连形态；
- daemon 自身的监督（daemon 崩溃时其上所有 Core 一起死，这是接受的语义）；
- daemon 的版本协商与热升级。

---

## 10. 验收要点

1. 打开一个工作区时 daemon 启动一个 Core 进程，并返回 channel 与描述符。
2. 两个工作区对应两个 channel、两个 Core 进程，且互不影响。
3. 关闭工作区后 channel 关闭、Core 退出，该连接上活着的 Core 进程数递减。
4. 连接上活着的 Core 进程归零后 daemon 在 grace 期结束时退出；grace 期内新开工作区则继续服务。
5. 控制连接断开时，非 idle 的 Core 孤儿化存活、全 idle 的 Core 被关闭；服务线程结束，
   daemon 继续服务其它连接。孤儿在下次 `openWorkspace` 时被认领（不开新进程、重放缓存
   帧），崩溃的孤儿不重启。
6. Core 崩溃后 daemon 在同一 channel 上重启它；超过重启上限时关闭 channel 并报告。
7. 内层帧与 [docs/core/standalone-core.md 第 5.2 节](standalone-core.md#52-帧类型)逐项一致，daemon 除忙闲快照缓存与请求帧暂存两处只读窥探外不解读内层帧。
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
18. 空闲退出（`--idle-exit 30`，SSH 引导）：daemon 启动后一直没有连接、或「最后一条
    连接断开**且**没有非 idle 孤儿」后满 30s，daemon 自行退出并清掉状态文件；期间任何
    新连接取消计时，断开后重新起算；`shutdown` 与空闲死线同时逼近时 `shutdown` 先到
    按停机处理。全 idle 的孤儿满 30s 宽限后被终止并移出孤儿表。
21. `detachWorkspace` 把该 Core 移入孤儿表并回 `workspaceClosed { reason: 'detached' }`；
    被 detach 的 Core 进程不退出，同连接其余 channel 的帧照常转发。
22. 同一 endpoint 两个客户端各自的孤儿在孤儿表里按连接标识各占一条，互不覆盖；并发
    认领同一孤儿至多一胜，败者按无孤儿处理（新起 Core）。
19. 并发首次引导：两台机器的客户端同时对同一台未部署的服务器引导，同指纹只拉起一个
    daemon（`start` 的按指纹互斥锁，[docs/core/core-remote.md 第 2.3 节](core-remote.md#23-状态文件)）；并发部署产物互不损坏（客户端唯一
    暂存名 + 原子换名，[docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)）。
20. daemon 落盘前的同指纹把关：状态文件已指向另一个连得上的 endpoint 时，启动中的
    daemon 退出不落盘、不抢在跑 daemon 的客户端（孤儿防线，[docs/core/core-remote.md 第 2.3 节](core-remote.md#23-状态文件)）；拉起方
    随后读到兄弟的状态文件，宿主照样接到在跑的 daemon 上。endpoint 等于自己的
    过期文件不算兄弟，照常覆盖。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 动作分派 | `core-rs/src/main.rs`（`stdio` / `start` / `start-daemon` / `kill`） |
| daemon 进程与 channel 管理 | `core-rs/src/daemon.rs` |
| 孤儿表 / 认领 / detach | `core-rs/src/daemon.rs`（`OrphanRegistry` / `RoutableSink`） |
| 远程服务（后台 daemon、状态文件、目录列举） | `core-rs/src/remote.rs` |
| 控制通道协议 | `core-rs/src/daemon_protocol.rs`、`src/host/standalone/daemonProtocol.ts` |
| Host 侧 daemon 客户端 | `src/host/standalone/CoreDaemon.ts` |
| SSH 客户端 | `src/host/standalone/sshClient.ts`（`ssh2` 库，不依赖系统 OpenSSH） |
| SSH 接入建链与远端引导 | `src/host/standalone/sshTransport.ts`、`sshDaemonBootstrap.ts` |
| 本地单进程 Core | `src/host/standalone/StandaloneEventBus.ts`（`createStandaloneCoreBus`，`stdio`） |
| endpoint → daemon 注册表 | `src/host/bootstrapCore.ts`（`remoteDaemonForEndpoint` / `listRemoteDirectories`） |
| 远程连接与目录选择 UI | `electron/main.ts`、`electron/remoteWorkspace/`（vite 页面）、`electron/remoteWorkspacePreload.ts` |
| 帧编解码（内层） | `src/host/standalone/protocol.ts`（不变） |
| 总线适配器 | `src/host/standalone/StandaloneEventBus.ts` |
| 进程管理（重启策略） | `core-rs/src/daemon.rs` |

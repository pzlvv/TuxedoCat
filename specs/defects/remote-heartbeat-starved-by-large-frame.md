---
status: 已修
---

# 缺陷：心跳与业务帧共用一条控制通道，大帧传输期间 Host 侧沉默判定误杀活链路

远程工作区打开大对话时，`conversationLoadRequested` 的应答是**整段会话历史一帧**
（`core-rs/src/main.rs` 的 `conversation_load_payload` 全量返回会话内容）。8MB 的会话
JSON 在 3Mbps 链路上要传 20s 以上，而 Host 侧的沉默看门狗只看「有没有入站帧」，
且心跳 `ping` / `pong` 与业务帧**共用同一条 daemon 控制通道**——daemon 的出站写线程
严格按帧顺序写，大帧没写完之前 `pong` 排在它后面（`core-rs/src/remote.rs` 的
`SocketOutput`）。于是「正在传一个大帧」与「对端已经死了」在 Host 侧完全同形，
9.9s 内没有完整帧到达就 kill 链路并按 fatal 上报：用户看到的是长对话打开失败。

## 现状

- 心跳与业务帧同一条通道、同一个出站队列：
  - Host → daemon：`CoreDaemon.startHeartbeat` 每 1s 调 `enqueue(ping)`，与业务帧同一个
    `outbox`、同一条 `link`（`src/host/standalone/CoreDaemon.ts`）；
  - daemon → Host：`pong` 与业务帧同一个 `SocketOutput` 有序队列（`core-rs/src/remote.rs`）。
    写线程一次写一整帧，`write_all` 在对端不读 / 带宽不足时阻塞到该帧写完为止——大帧
    传输期间 `pong` 不可能插队。
- 存活判据是**完整帧**粒度，不是字节粒度：`CoreDaemon.handleFrame` 在
  `isDaemonToHostFrame` 通过之后才调 `noteInbound()`。8MB 帧在 9900ms 内收不完，
  期间虽然 socket 一直在交付字节，`lastInboundAt` 一次都不前移。
- 判死路径：`finishSilenceRecheck` 按 `lastInboundAt` 判死并 `writer?.kill()`，
  `handleExit` 以 `silenceFatal` 上报 fatal；channel 全部 `handleDaemonGone`，
  `loadConversation` 直接失败。
- 生产证据（宿主日志 `~/<configDir>/logs/<logFileName>`，指向某远端工作区）：

  ```
  01:37:19.341 [WebviewMessageHandler] loadConversation requested: session_1795152705008_xl9ulb6
  01:37:29.344 [daemon] Remote Core link has been silent for 9900ms (no pong); declaring it dead.
  01:37:31.097 [WebviewMessageHandler] handleWebviewMessage failed for type=loadConversation:
             Error: Remote Core link has been silent for 9900ms (no pong); ...
  ```

  请求发出到判死正好是 9.9s（死线 + 宽限），说明死的不是链路，而是「Host 侧看不到
  完整入站帧」。
- 反向不对称：daemon 判 Host 的依据是「最近一次收到控制帧」，Host 的 `ping` 走上行方向，
  不受下行拥塞影响；只有 Host 看 daemon 的这条判据被业务帧饿死。

## 期望

1. **心跳有一条独立通路**：Host 与 daemon 之间的存活探测不排在任何业务帧后面。
   Host 另开一条只承载 `ping` / `pong` 的控制通道——同一条 SSH 连接的另一条转发通道，
   在 daemon 侧是另一条连接（一条连接一个服务线程，`pong` 由它自己的写线程直接写出，
   不进业务帧所在连接的出站队列）。
2. **大帧不再触发误判**：单帧传输时间超过沉默死线 + 宽限时链路不被判死，帧照常完整
   到达，`loadConversation` 正常返回。
3. **存活判据不再要求「完整帧」**：控制通道上任何入站字节都证明对端还活着——一个正在
   慢慢写的大帧同样是存活证据。
4. **两条证据任一成立即算活**：心跳通路的 `pong` 与业务链路的入站字节都前移死线。
5. **仍然要能判死**：两条通路都静默（对端断电 / 网络分区 / daemon 卡死）时，判死上限
   仍是死线 + 探针宽限（≤ 10s），并按 fatal 上报、kill 链路。
6. **心跳通路建不起来 / 中途断掉就是链路失败**：不降级成「只在业务链路上心跳」
   （那正是本缺陷的形态）。

## 不变量

- 控制通道的帧协议与载荷不变：`{ kind: 'ping' }` / `{ kind: 'pong' }` 原样使用，
  不新增帧类型、不改 `daemonProtocol.ts` / `daemon_protocol.rs` 的判别联合
  （[docs/core/core-daemon.md 第 7.2 节](../../docs/core/core-daemon.md#72-帧类型)）。
- daemon 侧不新增任何协议处理：任何一条控制连接收到 `ping` 都回 `pong`，心跳连接只是
  「不开工作区的控制连接」。
- 业务链路上的 `ping` 继续发：daemon 的心跳空闲回收按连接独立武装，业务连接长时间没有
  入站帧（大帧正在下行）时仍要靠这条上行 `ping` 顺延自己的死线。
- 单条控制通道内的帧顺序、channel 分配、grace、孤儿化、重启语义不变。
- 心跳连接上除 `pong` 之外的任何帧只记诊断并丢弃。
- 链路退出 / 主动关闭 / 建链超时路径统一收尾：两条通道一起释放，不留悬挂连接。
- 判死文案仍能区分「沉默判死」与「链路意外退出」。

## 回归测试

- **RT-1**：大帧写到中途停住（业务链路此后不再交付字节，该连接也不再回 `pong`），
  心跳通路的 `pong` 照常往返 → 链路不被判死。
  （落点：`src/test/remoteCoreDaemon.test.ts` 的 `RT-1 大帧停顿期间心跳独立通路保活（不判死）`
  / `RT-1 心跳链路的 pong 独立往返`）
- **RT-2**：同一帧不中断但以远低于带宽的速度慢速下完（总时长 > 死线 + 宽限），期间只有
  半个帧的字节在流动（没有任何完整入站帧）→ 链路不被判死且帧完整到达。
  （落点：同文件的 `RT-2 慢速大帧完整到达` / `RT-2 慢速大帧期间未被判死`）
- **RT-3**：心跳链路建不起来 → 请求直接失败，不降级回单通路。
  （落点：同文件的 `心跳链路建不起来直接失败（不降级）`）
- **RT-4**：心跳链路中途断掉（业务链路仍可收发）→ 按链路退出收尾，不退回单通路。
  （落点：同文件的 `心跳链路中断 → 链路按退出收尾`）
- **RT-5**：既有沉默判定语义不回归——两条通路都静默仍判死、对端不回 `pong` 不武装沉默
  判定（不误杀）。
  （落点：同文件既有用例 `沉默超过死线 + 宽限后判死 fatal`、`默认常数下沉默判死发生`、
  `不回 pong：长静默不误杀`）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- remote-core-daemon`（临时把存活判据还原成帧级、心跳链路不发 ping） | 红 | `FAIL RT-1 大帧停顿期间心跳独立通路保活（不判死）`、`FAIL RT-2 慢速大帧完整到达`、`FAIL RT-2 慢速大帧期间未被判死`；同批既有 50 条通过 |
| 回归用例（修复后） | `npm run test:unit -- remote-core-daemon` | 绿 | 62 通过 / 0 失败：RT-1 / RT-2 / RT-3 / RT-4 全过，既有沉默判定 / 目录操作 / 协议校验 / detach / 残行用例不受影响 |
| 静态检查 | `npm run check-types` | 绿 | 三份 tsconfig（host / webview / electron）0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| 单测全量 | `npm run test:unit` | 绿 | 120 通过 / 0 失败 / 2 跳过（跳过的是 `sidebarDocViewGit` 与 `sidebarFiles`：环境前置不满足，与本缺陷无关） |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | docsLint 49 通过 / 0 失败；docsLintLocalOnlyPaths 6 通过 / 0 失败 |
| 真实限速链路实测（3Mbps / 8MB 会话） | — | not-run | 需要一条真实限速 SSH 链路与 8MB 会话；RT-1 / RT-2 用进程内假远端放大同一形态（大帧占住有序出站队列、字节级慢速下传），未在真实链路上复跑 |
| Core 侧回归 | `npm run test:core` | not-run | 本缺陷只改 Host 侧判据与建链，daemon 侧协议与写线程零改动（`core-rs` 未修改），未重跑 |

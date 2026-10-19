---
status: 已修
---

# 缺陷：远程链路沉默判死后重连复用死 SSH 连接，重新连接仍起不了 Core

远程工作区的控制链路被 Host 侧沉默判定斩断（网络闪断 / 休眠恢复，最迟判死上限内
fatal）后，标签页标红、占位页提供「重新连接」。网络已恢复时点「重新连接」，探测
（自带全新 SSH 连接）通过、标签恢复绿色，但 Core 并未随链路恢复：registry 里同一
`CoreDaemon` 重开 channel 时，建链器 `open()` 里 `SshClient.connect()` 因幂等语义
（`connected === true` 直接返回）复用了已死的底层 SSH 连接，`openWorkspace` 帧发往
死连接，引导 / 转发挂起或失败，握手超时后再次 fatal、标签重新标红——用户看到的是
「重新连接了，core 仍未启动」。

## 现状

- 链路死亡的收尾在 `CoreDaemon.handleExit`（`src/host/standalone/CoreDaemon.ts`）：
  清 writer / 心跳 / 看门狗、拒绝未决请求、`fatalAll` 上报。**没有触碰
  `options.transport`（opener）**——SSH opener 持有的那条 `SshClient` 底层连接原样
  留着；只有宿主退出的 `shutdownCore` → `disconnect()` / `shutdown()` 才 dispose。
- `SshClient.connect()`（`src/host/standalone/sshClient.ts`）幂等：`connected` 为真
  直接返回。链路死亡时 SSH 连接是否已被 ssh2 判死取决于 keepalive（15s × 3 ≈ 45s）
  与 TCP 自身的感知节奏：判死了（`close` 已触发，`client = null`）重连会建新连接、
  一切正常；没判死（半开 / 黑洞，典型：休眠恢复、网络分区）时重连整段引导
  （`homeDir` → SFTP 一串）与 `openTcpForward` 都挂在死连接上。
- 挂在死连接上的表现：SFTP / exec 无应用层超时，`open()` 一直不 settle，直到 ssh2
  keepalive 判死（≤45s）才以错误收场 → `failPendingLink` → `fatalAll` → channel
  `handleOpenFailed` → `onWorkspaceConnectionState('lost')` → `markWorkspaceUnavailable`
  重新标红；或 TCP 较早报错 → 同样 fatal。两条路都落回红点，Core 从未起来。
- 复现路径（模型级，RT-1 用 `src/test/remoteCoreDaemon.test.ts` 的假远端 + 模拟
  SSH 连接复用语义的 opener）：链路就绪 → 停 pong 触发沉默判死 fatal → 恢复 pong
  （网络恢复）→ 同一 `CoreDaemon` 重开 channel → 断言重新就绪。现状下第二次
  `open()` 返回写得出、永远没有回帧的「同一条死连接」，`openWorkspace` 发不出去，
  `workspaceOpened` 永不到达——channel 挂在 opening（`sendHello` 未执行，握手定时器
  都未武装），断言失败。
- 佐证（生产日志特征，与上述机制一致）：重连后 `[daemon] channel handshake timed
  out` 或建链阶段的 SSH 错误后紧跟 `connection lost`，标签红点复现。
- 高层接线已核对无此缺陷：运行期 fatal 在 `electron/main.ts` 的
  `onWorkspaceConnectionState` → `markWorkspaceUnavailable`（runtime）→
  `emitWorkspaceChange('closed')` 同步摘除 `Client` 路由表里的死 Connection，
  「重新连接」经 `emitWorkspaceChange('opened')` 必然新建 Connection——死连接
  复用只发生在传输层（opener 的 SSH 连接），不在 Client / Connection 层。

## 期望

- 非主动关闭的链路退出（沉默判死、建链超时的 kill、对端断开）在 `handleExit` 的
  收尾里**一并 dispose opener**：控制链路死了，opener 的底层连接（SSH）不再可信，
  下一次 `ensureStarted()` 的 `open()` 必须走全新连接（`SshClient.connect()` 在
  `dispose()` 后 `client === null`，重建 Client）。
- 沉默判死后点「重新连接」：探测通过 → 重开 channel → 全新连接上完成
  `openWorkspace` → hello → ready，channel 重新就绪，标签恢复后 Core 可用。
- 主动关闭路径（`disconnect()` / `shutdown()`）行为不变：仍由各自的方法 dispose
  （幂等，重复 dispose 无害）。

## 不变量

- 沉默判定机制本身不变：pong 武装、死线 + 探针宽限、判死 kill 链路并 fatal 上报
  （本缺陷只修「死了之后重连复用死连接」，不改判死节奏；判死上限的调整是独立的
  需求变更，不属本规格）。
- daemon 侧断开语义不变：EOF / 心跳超时关全部 Core、`--idle-exit` 空闲退出、
  30s 内重连复用在跑的 daemon。
- `CoreDaemonLinkOpener` 契约不变：`dispose` 幂等、释放底层资源；TCP 直连 opener
  的 `dispose` 为 no-op，不受影响。
- 目录操作（列举 / 新建 / 删除）与多 channel 复用同一 daemon 的行为不变。
- 本地（非 endpoint）工作区不走 daemon，不受影响。

## 回归测试

- **RT-1**：模拟 SSH 连接复用语义的 opener（首次 `open()` 给真链路；链路死后未
  dispose 时再次 `open()` 返回无回帧、不 close 的死链路；dispose 后才建新连接）：
  链路就绪 → 停 pong 沉默判死 fatal → 恢复 pong → 同一 `CoreDaemon` 重开 channel →
  断言重新就绪、无二次 fatal、假远端见到第二条连接（落点：`src/test/remoteCoreDaemon.test.ts`
  「沉默判死后重连：重开 channel 重新就绪」「沉默判死后重连：重开未再 fatal」
  「沉默判死后重连：重开是全新连接」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:all -- remote-core-daemon` | 红 | 「沉默判死后重连：重开 channel 重新就绪」「重开是全新连接」失败：僵尸链路上 `openWorkspace` 无应答，channel 挂在 opening 状态连握手定时器都未武装（`workspaceOpened` 不到达 → `sendHello` 不执行），`waitFor(() => second.isReady(), 3_000)` 超时、假远端连接数停在 1；其余 37 项既有断言全绿 |
| 回归用例（修复后） | `npm run test:all -- remote-core-daemon` | 绿 | 39 通过 / 0 失败：RT-1 三断言全过（重开就绪、无二次 fatal、假远端见到第二条连接），既有沉默判定 / 目录操作 / 协议校验用例不受影响。修复方式：`CoreDaemon.handleExit` 在非主动关闭分支（`shuttingDown` / `stopped` 早返回之后）调用 `options.transport.dispose()`，主动关闭路径 `disconnect()` / `shutdown()` 原有的 dispose 不变（幂等） |
| 既有回归（全量） | `npm run test:all` | 绿 | 56 通过 / 0 失败（本行落定于本规格验证记录补齐后重跑的那次；首跑 55/56，唯一失败是 docsLint 校验本规格「验证记录须红绿齐备」，属本报告未写完的自锁） |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 均无输出错误 |
| 真实 SSH 端到端 | — | not-run | 本机无可用 SSH 远端环境；模型级复现（RT-1 的 SSH 连接复用语义 opener）与生产路径的差异仅在传输载体（TCP vs ssh2 转发通道），`SshClient.dispose()` 后 `client === null`、`connect()` 重建 Client 的语义有 `sshTransport` / `sshClient` 既有用例与代码路径覆盖 |

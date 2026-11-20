---
status: 已修
---

# 缺陷：daemon 出站帧同步直写，大帧写满 socket 缓冲时整个控制通道的主循环停摆

`SocketOutput`（`core-rs/src/remote.rs`）是远程 daemon 控制通道的出站口，实现
`FrameOutput::write_line`：拿一把 `Mutex<TcpStream>`，在锁内 `write_all` + `flush`。
它是**同步阻塞**的，而所有出站帧——Core 业务帧的转发、`pong`、`workspaceOpened` /
`workspaceClosed` 这类控制应答——都从 `run_daemon`（`core-rs/src/daemon.rs`）这一个主循环里
调用它。

这条 TCP 连接没有设写超时（`set_write_timeout` 只出现在 `stop_daemon` 那条短命探活连接上）。
一旦对端不读、socket 发送缓冲写满，`write_all` 就一直阻塞，主循环随之停住：这期间
`events.recv_timeout` 一次都不跑，`Ping` 收不到、`CloseWorkspace` 处理不了、
心跳死线到期也判定不了。整个连接上所有 channel 一起停摆。

[docs/core/core-daemon.md 第 7.4 节](../../docs/core/core-daemon.md#74-背压)已经把应有行为写清楚了：「控制通道的写入方维护
有序出站队列；越软水位时记录诊断，不丢弃帧」「控制通道是所有 channel 的公共路径：
单条 channel 的拥塞不得阻塞其它 channel」。现状是直接同步写，既没有出站队列，也没有
软水位诊断——契约已定义、实现没做到。

## 现状

- `SocketOutput::write_line`（`core-rs/src/remote.rs`）：

  ```rust
  impl FrameOutput for SocketOutput {
      fn write_line(&self, line: String) {
          let mut stream = match self.stream.lock() {
              Ok(stream) => stream,
              Err(poisoned) => poisoned.into_inner(),
          };
          if let Err(error) = stream
              .write_all(line.as_bytes())
              .and_then(|_| stream.flush())
          {
              diag!("[core] remote control write failed: {error}");
          }
      }
  }
  ```

  调用点全在 daemon 主循环上：`send_to_host`（`daemon.rs:848`）被
  `DaemonEvent::FrameLine`（`daemon.rs:1088`）、`HostToDaemonFrame::Ping`（`daemon.rs:1069`）、
  `open_workspace`（`daemon.rs:1211`）、`close_all`（`daemon.rs:1587`）等直接调用。

- 同一文件里的对照实现证明这个模式本来就有：`SystemCoreSpawner::spawn`
  （`daemon.rs:697-734`）为**写 Core stdin** 专门起了一个写线程 + `mpsc` 通道，
  主循环只 `send`、从不同步写。出站到 Host 这一段缺了同样的结构。

- 阻塞后果的具体表现（按代码可判定）：`run_daemon` 是单线程顺序循环，`write_all` 卡住
  期间：

  - `HostToDaemonFrame::Ping` 排不上队 → Host 侧 `pong` 收不到 → Host 的沉默看门狗
    （`src/host/standalone/CoreDaemon.ts` 的 `LINK_SILENCE_DEADLINE_MS` 9s +
    `LINK_SILENCE_RECHECK_MS` 900ms）判死链路；
  - `CloseWorkspace` 排不上队 → 该关的 Core 不关，`shutdown` 全局收尾也被拖住
    （[docs/core/core-remote.md 第 2.5 节](../../docs/core/core-remote.md#25-连接与生命周期)「停机收尾有等待上限（5s）」因此可能失效）；
  - 心跳死线（`heartbeat_timeout` 60s）在 `run_daemon` 里是「回到循环顶部才检查」的
    到期时刻，主循环停住时它同样不生效——daemon 也就不会按断开口径收尾。

- 需要说明的边界：`pong` 与大帧共用**同一条有序字节流**，物理上无法越过已经排队的大帧
  提前到达对端。把写移出主循环消除的是「主循环停摆」（收不了 ping、处理不了控制帧、
  判定不了死线），不是「pong 一定先于大帧到达」。后者由
  [frame-decoder-quadratic-buffer-copy](frame-decoder-quadratic-buffer-copy.md)
  那条（Host 侧不再因为解码大帧而错过入站帧）承载。

## 期望

1. **出站写不阻塞 daemon 主循环**：主循环把帧交给出站口之后必须能立刻回到 `recv`，
   真正的 socket 写在别的线程上完成。判据落在「主循环有没有被拖住」，不限定队列住在
   `SocketOutput` 还是主循环侧——只要主循环上的调用是 O(1) 且不碰 socket 写。
2. **有序出站队列 + 软水位诊断**：出站帧进有序队列，由独立写线程按序写出；队列越过软水位
   记录诊断，不丢帧、不合并帧（[docs/core/core-daemon.md 第 7.4 节](../../docs/core/core-daemon.md#74-背压)）。
3. **顺序保证**：同一连接上出站帧的写出顺序与调用顺序一致（写线程是唯一写者）。
4. **写失败不静默**：写线程遇到 socket 错误按现状记录诊断并停止继续写，不 panic、不悬挂。
5. **收尾不泄漏**：连接结束（`serve_connection` 返回）时写线程必须退出，不留孤儿线程。

## 不变量

- 控制通道帧编码不变：UTF-8、`\n` 分隔 JSON（`DaemonToHostFrame::encode`）。
- `FrameOutput` 的 trait 签名（`fn write_line(&self, line: String)`）不变；
  `ChannelOutput`（测试实现）行为不变。
- daemon 主循环的事件处理顺序、channel 分配、grace 计时、心跳死线判定逻辑不变。
- 不丢帧、不合并帧、单条 channel 内保持顺序（[docs/core/core-daemon.md 第 7.4 节](../../docs/core/core-daemon.md#74-背压)）。
- Host 侧 `CoreDaemon` 的出站队列与背压（`src/host/standalone/CoreDaemon.ts`）不变。

## 回归测试

- **RT-1**：`SocketOutput::write_line` 对**从不读的对端**连续灌入 16MB（64 × 256KB）后
  必须立即返回——总量远超任何 socket 发送缓冲，修复前会永久阻塞。
  （落点：`core-rs/src/remote_tests.rs` 的 `outbound_write_returns_without_blocking_on_a_stalled_peer`）
- **RT-2**：出站帧写出顺序等于调用顺序（写线程是唯一写者，`mpsc` 保序）。
  （落点：`core-rs/src/remote_tests.rs` 的 `outbound_write_preserves_call_order`）
- **RT-3**：软水位诊断——队列越 `OUTBOX_WARN_THRESHOLD` 时出现诊断记录，帧不丢
  （与 RT-1 的 16MB 灌注同批覆盖；诊断走 `diag!`，落 daemon 日志）。
- **RT-4**：连接结束写线程收尾——`serve_connection` 返回前调 `dispose(grace)`，
  写线程已退出则 join，仍阻塞在 `write_all` 时按宽限放弃等待、不拖住连接收尾。
- **既有回归**：`cargo test --manifest-path core-rs/Cargo.toml` 全绿（含既有心跳、
  断开、孤儿化、停机收尾、`remote::` 控制通道用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml outbound_write`（临时还原原始 `SocketOutput`） | 红 | `panicked at src\remote_tests.rs:325: 16MB 出站写必须立即返回（不阻塞调用方），实际耗时 5.008014062s`——同步写在对端停读时被发送缓冲挡死；同批 `outbound_write_preserves_call_order` 通过（它不是阻塞用例） |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml outbound_write` | 绿 | `outbound_write_returns_without_blocking_on_a_stalled_peer` 与 `outbound_write_preserves_call_order` 均 ok（2 passed / 0 failed）；对端停读时 16MB 灌注立即返回 |
| 既有回归（修复后） | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1215 passed / 0 failed（253s）——含既有心跳、断开、孤儿化、停机收尾、`remote::` 控制通道全量用例 |
| 格式基线 | `cargo fmt --manifest-path core-rs/Cargo.toml --check` | 绿 | — |
| Host 侧既有回归 | `npm run test:unit -- frame-decoder` | 绿 | 控制通道语义未变；同批确认缺陷 1 的 7 条用例 |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 49 通过 / 0 失败 |

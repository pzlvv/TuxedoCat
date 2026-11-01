---
status: 已修
---

# 缺陷：CoreDaemon 重连后沿用上一条链路的半行，新链路的帧被拼成坏帧、请求永不应答

`FrameDecoder`（`src/host/standalone/protocol.ts`）是帧通道的唯一解码入口，同时也是
**有状态**的：它缓存没等到换行符的残行（`buffer`）与半个 UTF-8 字符（`StringDecoder` 的余量）。
`CoreDaemon`（`src/host/standalone/CoreDaemon.ts`）在构造时建**一个**解码器、跨全部链路复用，
而 `ensureStarted` 换链路时没有丢弃上一条链路留下的余量。

TCP 断开可以落在任意字节边界：上一条链路的最后一个 `data` 事件里可能只有半个帧。
这条残行留在解码器里，下一条链路的第一帧到达时被直接拼在后面，得到一个永远不会成立的 JSON 前缀，
于是新连接上**每一帧都解析失败**——包括 `directoriesListed` 这类请求应答。
请求方（目录选择器 / 开工作区）等不到应答，只能挂到自己的超时；心跳帧照发，链路看起来是活的。

## 现状

- `CoreDaemon`（`src/host/standalone/CoreDaemon.ts`）在构造函数里建一次解码器：

  ```ts
  this.decoder = new FrameDecoder({
    onFrame: (value) => this.handleFrame(value),
    onError: (error) => this.log(`[daemon] malformed frame: ${error.message}`),
  });
  ```

  `ensureStarted()` 的链路建立回调里只挂 `link.onData((chunk) => this.decoder.push(chunk))`，
  `handleExit()` / `failPendingLink()` / `disconnect()` 三处收尾都不调 `decoder.reset()`。
  全仓只有 `CoreProcess.spawnChild()`（`CoreProcess.ts` 的 `this.decoder.reset()`）做了这一步，
  单进程 Core 的重启因此没有这个问题。

- 复现（仓库根，进程内 `net` 假 daemon；第 1 条连接只发半个帧就断开，第 2 条连接正常应答）：

  ```
  node /tmp/repro_daemon_decoder.cjs
  ```

  实测输出：

  ```
  第 1 次调用（链路在第 1 条连接上断掉）: {"ok":false,"e":"Core daemon exited."}
  第 2 次调用（新连接）: {"ok":false,"e":"超时 5s（请求永远没有应答）"}
  宿主侧诊断: ["[daemon] exited unexpectedly",
              "[daemon] malformed frame: Expected ',' or '}' after property value in JSON at position 14 (line 1 column 15)"]
  假 daemon 收到/记录的帧: ["conn1 <- {\"kind\":\"listDirectories\",\"id\":1,\"path\":\"/home\"}",
                           "conn2 <- {\"kind\":\"listDirectories\",\"id\":2,\"path\":\"/home\"}",
                           "conn2 <- {\"kind\":\"ping\"}", ...]
  ```

  假 daemon 在 conn2 上**确实**回了 `directoriesListed`，宿主侧却报了一条 malformed frame
  并把这个 id 的等待者一直挂着——`Buffer.byteLength` 位置 14 正好是残行 `{"kind":"pong"`
  的长度，拼接点就在这里。

- 影响面：远程工作区的目录选择器、`openWorkspace`、`closeWorkspace` / `detachWorkspace`
  的应答全部走这条控制通道。链路抖动一次后（沉默判死、SSH 转发通道被重置、宿主重连按钮），
  后续请求整体失联，用户看到的是「连不上 / 点了没反应」，而日志里只有一行 malformed frame。
  第 2 次调用在**同一** daemon 实例上就复现，不需要重启宿主。

## 期望

1. **一条链路一个解码起点**：新链路建立时丢弃上一条链路的残行与半个字符，
   新链路的第一帧从字节流的起点开始解。
2. **重连后控制通道可用**：上一条链路在任意字节边界断开后，下一条链路上的
   `listDirectories` 能拿到应答。
3. **诊断不冒充成功**：残行被丢弃这件事可以有诊断记录，但不能把新链路的合法帧报成 malformed。
4. **不改帧协议**：线的编码（UTF-8、换行分隔 JSON）与 `FrameDecoder.push` 的入参形态不变。

## 不变量

- `FrameDecoder` 的跨块拼接语义不变（同一链路内被切开的半个 UTF-8 字符照样补全，
  `src/test/frameDecoder.test.ts` 的用例全绿）。
- `CoreProcess` 的单进程重启行为不变（它本来就调 `reset()`）。
- `CoreDaemon` 的连接代次（`linkAttempt`）、沉默判定、心跳、outbox 冲刷时序不变。
- 一条链路内的正常帧解析不引入额外拷贝或缓冲上限。

## 回归测试

- **RT-1**：同一 `CoreDaemon` 实例上，第 1 条链路在半个帧之后断开，第 2 条链路正常应答——
  `listDirectories` 必须拿到 `path`（修复前红：超时 / malformed frame）。
  （落点：`src/test/remoteCoreDaemon.test.ts` 的「残行跨链路」用例组）
- **RT-2**：第 2 条链路上没有任何 malformed frame 诊断（修复前红：日志里出现
  `malformed frame`）。（落点：同文件，断言 `logs` 不含 `malformed frame`）
- **RT-3**：残行被丢弃后，第 2 条链路上后续请求仍可用（连发两次 `listDirectories`
  都拿到应答，证明解码器没有再次错位）。（落点：同文件）
- **RT-4**：同一链路内被 TCP 切开的半个 UTF-8 字符仍能补全（守护既有语义，
  `src/test/frameDecoder.test.ts` 已覆盖；本次重跑确认不回归）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `node /tmp/repro_daemon_decoder.cjs` | 红 | 第 2 次调用超时 5s；宿主日志出现 `malformed frame: Expected ',' or '}' after property value in JSON at position 14` |
| 回归用例（修复前） | `npm run test:unit -- remote-core-daemon` | 红 | 2 条断言失败：`残行：第 2 条链路的请求拿到应答`、`残行：第 2 条链路上没有 malformed frame` |
| 回归用例（修复后） | `npm run test:unit -- remote-core-daemon` | 绿 | 50 通过 / 0 失败 |
| 既有回归 | `npm run test:unit -- frame-decoder` | 绿 | 同链路跨块拼接不变 |
| 静态检查 | `npm run check-types` | 绿 | — |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法 |

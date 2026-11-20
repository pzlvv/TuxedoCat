---
status: 已修
---

# 缺陷：FrameDecoder 按块重拼整个缓冲，大帧解码是 O(n²)，长对话打开超时

`FrameDecoder`（`src/host/standalone/protocol.ts`）是宿主侧唯一的帧解码入口，承载
单进程 Core（`CoreProcess` 的 `child.stdout`）与远程 daemon 控制通道（`CoreDaemon` 的
`link.onData`）两条链路的入站字节流。它的实现每收到一块就把**已有缓冲整体拼接**，
再在成行时把整段缓冲 `slice` 掉。一帧内没有换行符时（也就是帧还没收完），每来一块都
要把已经收到的全部内容重新拷一遍——总拷贝量与帧长的平方成正比。

帧大小没有上限（[docs/core/standalone-core.md 第 5.1 节](../../docs/core/standalone-core.md#51-帧)：
「无帧大小上限，按行读取」），而 `conversationLoadRequested` 的应答是**整段会话历史一个帧**
（`core-rs/src/main.rs` 的 `conversation_load_payload` 全量返回 `messages`）。会话越长，
这个帧越大，解码成本按平方增长。远程 SSH 转发通道的分块是 32KB
（`node_modules/ssh2/lib/Channel.js` 的 `PACKET_SIZE`），正好落在最坏分块区间。

后果不是「慢一点」：解码发生在 Host 主进程的事件循环上，整帧解完之前后续所有入站帧
都排不上；而 Host 侧的沉默看门狗（`src/host/standalone/CoreDaemon.ts` 的
`LINK_SILENCE_DEADLINE_MS` / `LINK_SILENCE_RECHECK_MS`，合计 9900ms）只看「有没有入站帧」，
于是把「还在解大帧」判成「daemon 死了」，kill 链路并按 fatal 上报——用户看到的是
「长对话打开失败」，不是解码慢。

## 现状

- `FrameDecoder.push`（`src/host/standalone/protocol.ts`）：

  ```ts
  push(chunk: Buffer | string): void {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      this.decodeLine(line);
      index = this.buffer.indexOf('\n');
    }
  }
  ```

  两点都在放大成本：`this.buffer += ...` 每块都重拼整个已收缓冲（帧未收完时缓冲一直在
  涨，块数也在涨），`this.buffer.slice(index + 1)` 再整体搬移一次。

- 实测（同一份编译产物 `out/src/host/standalone/protocol.js`，只喂一个帧，32KB 分块）：

  | 单帧大小 | 解码耗时 |
  | --- | --- |
  | 2 MB | 0.42 s |
  | 4 MB | 1.41 s |
  | 8 MB | 5.01 s |
  | 12 MB | 11.33 s |

  同一帧一次性喂入只要几十毫秒（`JSON.parse` 8MB 约 23ms）——瓶颈完全在缓冲重拼，
  不在 JSON 解析。

- 增长阶数实测：1MB → 354ms，8MB → 8376ms，比值 23.7x。体积 8 倍的线性预期是 8x，
  平方预期是 64x；实测落在两者之间（两种拷贝成本叠加），确认存在平方项。

- 生产证据（宿主日志 `~/<configDir>/logs/<logFileName>`，指向 `122.51.248.34` 上的远端工作区）：

  ```
  11:20:25.693  loadConversation requested: session_1795152705008_xl9ulb6
  11:20:35.674  [daemon] Remote Core link has been silent for 9900ms (no pong); declaring it dead.
  11:20:38.903  handleWebviewMessage failed for type=loadConversation: Error: Remote Core link has been silent for 9900ms ...
  ```

  同一会话在会话较短时打开正常（`07:45:31 readMs=2283`，1075 条消息），此后连续 5 次
  `loadConversation` 失败，全部落在同一条沉默判死链上。

## 期望

1. **解码成本与帧长线性**：一帧分成任意块数喂入的总拷贝量与帧长成正比，不随帧长平方增长。
   只给搜索加游标不够——残行仍在一个字符串上 `+=` 累积，累积期间每块照样整段重拷
   （实测「加游标」写法 8MB 仍是 3387ms、16MB 13509ms）。残行必须以分片形式累积，
   只在成行时拼一次。
2. **分块方式不影响结果**：同一段字节的任意切分，解出的帧与错误集合与整块喂入一致。
3. **跨块多字节字符仍补全**：`StringDecoder` 的余量语义不变（既有
   [frame-decoder-splits-multibyte-chunks](frame-decoder-splits-multibyte-chunks.md) 的回入口径）。
4. **`reset` 仍丢弃残行与半个字符**：既有语义不变（[daemon-decoder-keeps-stale-partial-line](daemon-decoder-keeps-stale-partial-line.md)）。
5. **大帧不再触发沉默误判**：会话大小到十几 MB 量级时，解码耗时不再逼近 Host 侧
   9900ms 的沉默预算。

## 不变量

- 帧协议语义不变：UTF-8、`\n` 分隔 JSON、一行一帧，帧边界只由 `\n` 决定
  （[docs/core/standalone-core.md 第 5.1 节](../../docs/core/standalone-core.md#51-帧)）。
- `FrameDecoder` 的公开签名（`push(chunk: Buffer | string)`、`reset()`、
  `FrameDecoderOptions`）不变；`CoreProcess` / `CoreDaemon` 两条生产链路零改动。
- 空行跳过、`\r\n` 尾随回车剥除、单行坏 JSON 只报该行且不中断后续行的既有行为不变。
- 行级 `onFrame` / `onError` 的调用顺序不变：仍按行在字节流中出现的顺序逐行回调。
- 不引入帧大小上限（规格明确「无帧大小上限」）；不得靠截断或丢帧换取速度。

## 回归测试

- **RT-1**：解码成本与帧长线性——8MB 帧按 32KB 分块喂入的耗时不得显著高于整块喂入
  （判据是同一帧两种喂法的比值，与机器快慢无关：修复前 34x，修复后约 1x）。
  （落点：`src/test/frameDecoder.test.ts` 的 `RT-5 大帧解码成本与帧长线性`）
- **RT-2**：大帧内容正确——8MB 帧按 32KB 分块喂入解出恰好一帧，且载荷与整块喂入
  `deepStrictEqual`（确认「变快不是靠丢内容」）。
  （落点：同文件的 `RT-6` / `RT-7`）
- **RT-3**：既有语义不回归——多字节切分、`reset`、字符串块路径等既有用例全绿
  （落点：同文件既有 `RT-1` ~ `RT-4`，重跑确认）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- frame-decoder` | 红 | `FAIL RT-5 大帧解码成本线性（2MB→8MB 耗时比 15.2x，阈值 <8x）`；同批 RT-6 / RT-7 通过（内容正确、只是慢），RT-1~RT-4 通过 |
| 既有回归（修复前基线） | `npm run test:unit -- frame-decoder` | 绿 | 既有 4 条用例在修复前全绿（本缺陷是性能阶数，不是正确性） |
| 回归用例（修复后） | `npm run test:unit -- frame-decoder` | 绿 | 7 通过 / 0 失败；RT-5 以「8MB 帧分块/整块耗时比」为判据实测 2.36x（阈值 <4x） |
| 既有回归（修复后） | `npm run test:unit -- frame-decoder` | 绿 | RT-1 ~ RT-4 全绿：多字节跨块补全、切分不改结果、字符串块路径、reset 语义均未回归 |
| 大帧实测（修复后） | 临时脚本量 `out/src/host/standalone/protocol.js`，32KB 分块 | 绿 | 1MB 7.6ms / 8MB 58.8ms（比值 7.7x，体积 8 倍）；对照修复前 8MB 5014ms |
| 真实会话实测（修复后） | 同一脚本喂真实 JSONL 组装的应答帧 | 绿 | 22.9MB / 1740 行的会话 → 应答帧 8.7MB：修复前 32KB 分块解码 3690ms，修复后 **108ms**；且分块（108ms）已与整块（72ms）持平 |
| 静态检查 | `npx tsc -p tsconfig.test.json` | 绿 | 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | — |

---
status: 已修
---

# 缺陷：帧解码器逐块 `toString('utf8')`，被 TCP / SSH 切开的多字节字符静默变成 U+FFFD

`FrameDecoder`（`src/host/standalone/protocol.ts`）是宿主侧唯一的帧解码入口，
承载 Core 进程（`CoreProcess` 的 `child.stdout`）与远程 daemon 控制通道
（`CoreDaemon` 的 `link.onData`）两条链路的入站字节流。它的契约写着「输入是任意切分的
字节块」，实现却对非字符串块逐个调用 `chunk.toString('utf8')`。

TCP 与 SSH 通道按自己的节奏切片（一次 `data` 事件可能是几十字节，也可能正好切在一个
多字节字符中间），因此中文、emoji 这类字符会被切在两次 `push` 之间。逐块解码时两半
各自得到 U+FFFD（`�`）——**替换字符是合法字符**，`JSON.parse` 照样成功，
`onError` 一次都不触发。坏文本因此静默进入 Core 与 UI：日志乱码、对话正文出现一排
`�`、工具输出里的中文全部损坏，而诊断日志里没有任何记录可循。

## 现状

- `FrameDecoder.push`（`src/host/standalone/protocol.ts`）：

  ```ts
  this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  ```

  每个字节块**独立**解码，块边界上的半个字符无法补全。

- 复现（仓库根，喂真实 `encodeFrame` 产出的 UTF-8 字节，按不同块大小切片）：

  ```
  node -e "const{FrameDecoder,encodeFrame}=require('./out/src/host/standalone/protocol.js');
  const f=encodeFrame({kind:'event',event:{type:'log',message:'中文日志 😀 emoji 混排'}});
  const b=Buffer.from(f,'utf8');
  for(const size of [1,2,3,5,7]){let got=null,errs=0;
    const d=new FrameDecoder({onFrame:v=>{got=v},onError:()=>{errs++}});
    for(let i=0;i<b.length;i+=size)d.push(b.subarray(i,i+size));
    console.log(size,'errors='+errs,JSON.stringify(got.event.message));}"
  ```

  实测输出（`errors` 全为 0——没有任何错误上报）：

  ```
  1 errors=0 "������������ ���� emoji ������"
  2 errors=0 "���������� ��� emoji ������"
  3 errors=0 "�������� ���� emoji ������"
  5 errors=0 "���文日�� �� emoji 混排"   (截断示意，实际同样含替换字符)
  7 errors=0 "中文���志 �� emoji 混排"   (同上)
  ```

  整块喂入（`decoder.push(buffer)`）时才得到正确文本——即「是否损坏」取决于
  通道恰好怎么切片。

- 生产链路的前置 `setEncoding('utf8')` 不能替代这一层：`CoreProcess`（`child.stdout`）
  与 `sshTransport`（`channel`）、测试用的 `tcpDaemonOpener`（socket）都调了
  `setEncoding`，但 `FrameDecoder` 的签名明确接受 `Buffer`，且 `CoreDaemon` 用
  `typeof chunk === 'string' ? chunk : chunk.toString('utf8')` 二次转换——
  任何一处漏掉 `setEncoding`、或将来新增一条按字节喂入的链路，都会直接落进这个坑，
  而失败是静默的。契约既然声明「任意切分的字节块」，实现就必须自己跨块拼接。

## 期望

1. **跨块补全**：字节块经 `StringDecoder` 解码，半个字符暂存到下一块；
   任意切分方式的解码结果与整块解码逐字一致。
2. **`reset` 丢弃半字符**：`reset`（进程重启）语义是丢弃残行，必须同时丢掉未完成的
   字符，否则旧字节流的半字符会与新字节流的首块拼出一个凭空多出来的字。
3. **字符串块行为不变**：既有调用方 `setEncoding('utf8')` 之后传的就是字符串
   （JS 本来就按 code unit 存，切开不会损坏），这条路径不改写文本。
4. **错误口径不变**：行级 JSON 解析失败仍然只报该行（`onError`），不中断后续行。

## 不变量

- 帧协议语义不变：编码仍是 UTF-8 + `\n` 分隔 JSON，帧边界只由 `\n` 决定
  （[docs/core/standalone-core.md 第 5.1 节](../../docs/core/standalone-core.md#51-帧)）。
- `FrameDecoder` 的公开签名（`push(chunk: Buffer | string)`、`reset()`、
  `FrameDecoderOptions`）不变，两条生产链路（`CoreProcess` / `CoreDaemon`）零改动。
- `encodeFrame` 一侧不变，仍走 `stringifyJsonSafe` 兜底孤立代理项。
- 空行跳过、`\r\n` 尾随回车处理、单行坏 JSON 只报该行的既有行为不变。

## 回归测试

- **RT-1**：含中文与 emoji 的帧按 1 / 2 / 3 / 5 / 7 字节切片喂入，解出的文本逐字
  等于原文且 `errors` 为 0（修复前红：每种切法都得到一串 U+FFFD）。
- **RT-2**：任意切片方式的解码结果与整块解码 `deepStrictEqual`（切分方式不影响结果）。
- **RT-3**：字符串块跨 `push` 拼接仍解出同一帧、文本不被改写（既有调用方行为不变）。
- **RT-4**：`reset` 丢弃残行与未完成的字符——切在多字节字符中间后 `reset`，
  紧随其后的完整帧正常解出，且不出现凭空多出的字符。
- 落点：`src/test/frameDecoder.test.ts`。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 ~ RT-4（修复前） | `node scripts/run-tests.mjs frame-decoder` | 红 | RT-1 首条断言即失败：`chunk=1` 解出 `'������������ ���� emoji ������'`，期望 `'中文日志 😀 emoji 混排'`；`errors` 为 0，确认是静默损坏 |
| 复现脚本（修复前） | 本规格「现状」节的 `node -e` 片段 | 红 | 1 / 2 / 3 / 5 / 7 字节切片全部产出替换字符，整块喂入才正确 |
| RT-1 ~ RT-4（修复后） | `node scripts/run-tests.mjs frame-decoder` | 绿 | 4 通过 / 0 失败；每种切片方式的文本逐字等于原文 |
| 既有回归（帧协议） | `npm run test:unit -- standalone-bus` | 绿 | 既有 `decoder buffers partial lines` / `splits on newline` / `reports malformed line` / `reset drops the remainder` 全过 |
| 静态检查 | `npm run check-types` | 绿 | 含 webview / electron 三份配置 |
| 静态检查 | `npm run lint` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节与验证记录取值合法、章节引用有效 |

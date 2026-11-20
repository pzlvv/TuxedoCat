/**
 * `FrameDecoder` 的字节块解码（`docs/core/standalone-core.md` 的帧编码：
 * UTF-8、换行分隔 JSON）。
 *
 * 守护的是「帧通道输入是任意切分的字节块」这条契约：
 * `src/host/standalone/protocol.ts` 的 `FrameDecoder.push` 明确写着
 * 「输入是任意切分的字节块」，而 TCP / SSH 通道本来就按自己的节奏切片，
 * 一个多字节 UTF-8 字符（中文、emoji）完全可能被切在两次 `push` 之间。
 *
 * 修复前：非字符串块直接 `chunk.toString('utf8')`，每个切片各自解码——被切开的
 * 字符在两半各得到 U+FFFD，`JSON.parse` 仍能成功（替换字符是合法字符），于是
 * **坏掉的内容静默进入 Core 与 UI**：日志乱码、对话正文出现一串 `�`、
 * 工具输出里的中文全部损坏，而错误日志里一条记录都没有。
 *
 * 修复后：跨块的半个字符由 `StringDecoder` 暂存，下一个块到达时补全。
 *
 * 运行方式：npm run test:unit -- frame-decoder
 */

import * as assert from 'assert';
import { FrameDecoder, encodeFrame } from '../host/standalone/protocol';
import { createChecker, runTests } from './helpers/harness';

/** 把一段字节按固定大小切片喂给解码器，返回解出的帧与错误数 */
function decodeInChunks(buffer: Buffer, chunkSize: number): { frames: unknown[]; errors: string[] } {
  const frames: unknown[] = [];
  const errors: string[] = [];
  const decoder = new FrameDecoder({
    onFrame: (value) => frames.push(value),
    onError: (error) => errors.push(error.message),
  });
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    decoder.push(buffer.subarray(offset, offset + chunkSize));
  }
  return { frames, errors };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  const message = '中文日志 😀 emoji 混排';
  const frame = encodeFrame({ kind: 'event', event: { type: 'log', message } });
  const buffer = Buffer.from(frame, 'utf8');

  // RT-1：多字节字符被切在两次 push 之间时不得损坏。
  // 修复前：chunkSize 1 / 2 / 3 / 5 / 7 全部解出 `����...`，errors 为 0（静默损坏）。
  for (const chunkSize of [1, 2, 3, 5, 7]) {
    const { frames, errors } = decodeInChunks(buffer, chunkSize);
    assert.strictEqual(errors.length, 0, `chunk=${chunkSize} 不应产生解码错误`);
    assert.strictEqual(frames.length, 1, `chunk=${chunkSize} 应解出恰好一帧`);
    const event = (frames[0] as { event?: { message?: string } }).event;
    assert.strictEqual(
      event?.message,
      message,
      `chunk=${chunkSize} 帧内文本应逐字保留（修复前得到替换字符）`,
    );
  }
  check('RT-1 多字节 UTF-8 字符跨块切分不损坏', true);

  // RT-2：整块喂入与切片喂入结果一致（切分方式不影响解码结果）。
  const whole = decodeInChunks(buffer, buffer.length);
  const split = decodeInChunks(buffer, 3);
  assert.deepStrictEqual(split.frames, whole.frames, '切片解码应与整块解码逐字一致');
  check('RT-2 切分方式不改变解码结果', true);

  // RT-3：字符串块路径不受影响（既有调用方 `setEncoding('utf8')` 之后传的就是字符串）。
  {
    const frames: unknown[] = [];
    const decoder = new FrameDecoder({
      onFrame: (value) => frames.push(value),
      onError: () => undefined,
    });
    // 字符串块哪怕在代码单元中间切开也不会损坏：JS 字符串本来就按 code unit 存。
    decoder.push(frame.slice(0, 20));
    decoder.push(frame.slice(20));
    assert.strictEqual(frames.length, 1, '字符串块跨 push 拼接仍解出一帧');
    assert.strictEqual(
      (frames[0] as { event?: { message?: string } }).event?.message,
      message,
      '字符串块路径的文本不被改写',
    );
  }
  check('RT-3 字符串块路径行为不变', true);

  // RT-4：残行在 reset 时不落成乱码——reset 丢弃未完成的字符。
  {
    const frames: unknown[] = [];
    const decoder = new FrameDecoder({
      onFrame: (value) => frames.push(value),
      onError: () => undefined,
    });
    const cjk = Buffer.from('{"kind":"log","message":"中文"}', 'utf8');
    // 切在「中」的三个字节中间：前两块留给 reset
    decoder.push(cjk.subarray(0, 25));
    decoder.reset();
    decoder.push(Buffer.from('{"kind":"shutdown"}\n', 'utf8'));
    assert.strictEqual(frames.length, 1, 'reset 之后只解出 reset 之后的帧');
    assert.strictEqual((frames[0] as { kind?: string }).kind, 'shutdown', 'reset 丢弃残行与半字符');
  }
  check('RT-4 reset 丢弃残行与未完成的字符', true);

  // RT-5 / RT-6 / RT-7：大帧解码成本。
  // 修复前：`push` 每块把整个已收缓冲 `+=` 重拼一次，一帧未收完时块数和缓冲一起涨，
  // 总拷贝量随帧长平方增长。帧大小本身没有上限（standalone-core.md 5.1），而
  // `conversationLoadRequested` 的应答是整段会话一个帧——大会话因此把 Host 主进程的
  // 事件循环占住，沉默看门狗把「还在解帧」判成「daemon 死了」。
  const bigFrame = (megabytes: number): string => {
    // 每条约 8KB（工具输出预览量级），帧形与真实 history 应答同构
    const perMessage = 8 * 1024;
    const count = Math.floor((megabytes * 1024 * 1024) / perMessage);
    const body = 'x'.repeat(perMessage);
    const messages: unknown[] = [];
    for (let i = 0; i < count; i += 1) {
      messages.push({
        type: 'assistant',
        uuid: `u${i}`,
        message: { role: 'assistant', content: [{ type: 'text', text: body }] },
      });
    }
    return encodeFrame({
      kind: 'response',
      id: 7,
      ok: true,
      result: { messages },
    } as unknown as Parameters<typeof encodeFrame>[0]);
  };

  /** 按固定块长喂入并计时（取多轮最小值，压掉 GC 抖动） */
  const timeDecode = (line: string, chunkSize: number, rounds: number): { ms: number; frames: unknown[] } => {
    let best = Number.POSITIVE_INFINITY;
    let frames: unknown[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const decoded: unknown[] = [];
      const decoder = new FrameDecoder({
        onFrame: (value) => decoded.push(value),
        onError: (error) => { throw error; },
      });
      const startedAt = process.hrtime.bigint();
      for (let offset = 0; offset < line.length; offset += chunkSize) {
        decoder.push(line.slice(offset, offset + chunkSize));
      }
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (ms < best) best = ms;
      frames = decoded;
    }
    return { ms: best, frames };
  };

  // ssh2 的转发通道按 PACKET_SIZE=32KB 切片，正是最坏分块区间
  const CHUNK = 32 * 1024;
  const bigLine = bigFrame(8);
  timeDecode(bigLine, CHUNK, 1); // 预热：让 JIT 与字符串内部表示稳定
  const chunked = timeDecode(bigLine, CHUNK, 3);
  const wholeBig = timeDecode(bigLine, bigLine.length, 3);

  // RT-5：成本与帧长线性——分块解码不得显著慢于整块解码。
  //
  // 这个判据只比「同一帧的两种喂法」，与机器快慢、JIT 状态无关：
  // - 修复前残行在单个字符串上 `+=` 累积，每块重拷整个已收缓冲：分块 1771ms vs
  //   整块 51ms ≈ 34x（块的切割方式直接决定成本，这正是 O(n²) 的证据）；
  // - 修复后残行按分片数组累积、成行只 join 一次：实测 0.90x ~ 1.25x。
  // 阈值取 <4x：远离修复后的实测值，也远离修复前的 34x，不会因机器抖动误判。
  const ratio = chunked.ms / Math.max(wholeBig.ms, 1);
  check(
    `RT-5 大帧解码成本与帧长线性（8MB 帧分块/整块耗时比 ${ratio.toFixed(2)}x，阈值 <4x）`,
    ratio < 4,
  );

  // RT-6：8MB 帧按 32KB 分块喂入仍解出恰好一帧（变快不得靠丢内容）
  assert.strictEqual(chunked.frames.length, 1, '8MB 帧应解出恰好一帧');
  check('RT-6 大帧分块解码仍解出恰好一帧', true);

  // RT-7：分块解码的载荷与整块解码逐字一致（切分方式不影响结果）
  {
    assert.deepStrictEqual(chunked.frames, wholeBig.frames, '8MB 帧分块与整块解码结果应一致');
  }
  check('RT-7 大帧分块与整块解码结果一致', true);

  finish();
}

runTests('frame-decoder', run);

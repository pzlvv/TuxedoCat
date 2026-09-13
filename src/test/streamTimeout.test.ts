/**
 * 流式请求看门狗单元测试（core/llm/streamTimeout.ts）。
 *
 * 运行方式（两种都支持）：
 *   1. 独立运行：`npx tsc -p tsconfig.test.json && node out/src/test/streamTimeout.test.js`
 *   2. 在 vscode-test 的 mocha 环境下自动注册为测试用例。
 *
 * 背景：网关「接受连接后静默不响应」或「持续发 ping 心跳挂住连接」时，
 * undici 的 headersTimeout/bodyTimeout 会被不断到达的心跳重置，请求永远挂着
 * 且不留任何日志。看门狗负责在首字节超时（默认 300s）或流空闲超时（默认 60s）
 * 时主动 abort。这里用毫秒级的超时值覆盖同样的逻辑分支。
 */
import * as assert from 'assert';
import { createStreamWatchdog, isProgressEvent } from '../core/llm/streamTimeout';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Case {
  name: string;
  run: () => void | Promise<void>;
}

const CASES: Case[] = [
  {
    name: '首字节超时：到期后报 first-byte 并 abort',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 150, idleTimeoutMs: 100 });
      assert.strictEqual(wd.timeoutError(), null, '初始不应超时');
      assert.strictEqual(wd.signal.aborted, false, '初始不应 abort');
      await sleep(250);
      assert.strictEqual(wd.timeoutError()?.phase, 'first-byte', '应报 first-byte 超时');
      assert.strictEqual(wd.signal.aborted, true, '超时后 signal 应已 abort');
      wd.dispose();
    },
  },
  {
    name: '持续有进展时不超时',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 150, idleTimeoutMs: 100 });
      const timer = setInterval(() => wd.noteProgress(), 40);
      await sleep(400);
      clearInterval(timer);
      assert.strictEqual(wd.timeoutError(), null, '持续有进展不应超时');
      assert.strictEqual(wd.signal.aborted, false);
      wd.dispose();
    },
  },
  {
    name: '有进展后停滞：报 idle 超时',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 150, idleTimeoutMs: 100 });
      wd.noteProgress();
      await sleep(60);
      assert.strictEqual(wd.timeoutError(), null, '刚有进展不应超时');
      await sleep(120);
      assert.strictEqual(wd.timeoutError()?.phase, 'idle', '停滞超过 idle 应超时');
      wd.dispose();
    },
  },
  {
    name: 'stop() 后不再计时（流已正常读完的收尾阶段）',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 150, idleTimeoutMs: 100 });
      wd.stop();
      await sleep(250);
      assert.strictEqual(wd.timeoutError(), null, 'stop 后不应再触发超时');
      assert.strictEqual(wd.signal.aborted, false);
      wd.dispose();
    },
  },
  {
    name: 'dispose() 后不再计时',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 100, idleTimeoutMs: 100 });
      wd.dispose();
      await sleep(200);
      assert.strictEqual(wd.timeoutError(), null);
      assert.strictEqual(wd.signal.aborted, false);
    },
  },
  {
    name: 'restart() 必须换新的 AbortController（否则重试会被立刻 abort）',
    run: async () => {
      const wd = createStreamWatchdog({ signal: null, firstByteTimeoutMs: 100, idleTimeoutMs: 100 });
      await sleep(180);
      assert.ok(wd.timeoutError() !== null && wd.signal.aborted, 'restart 前应已超时并 abort');

      wd.restart();
      assert.strictEqual(wd.signal.aborted, false, 'restart 后 signal 必须是未 abort 的新 controller');
      assert.strictEqual(wd.timeoutError(), null, 'restart 后超时记录应清空');

      wd.noteProgress();
      await sleep(60);
      assert.strictEqual(wd.timeoutError(), null, 'restart 后应能正常接收进展');

      await sleep(120);
      assert.strictEqual(wd.timeoutError()?.phase, 'idle', 'restart 后仍应能再次 idle 超时');
      wd.dispose();
    },
  },
  {
    name: '外部中断转发，且不产生超时错误（应走用户取消路径）',
    run: () => {
      const ac = new AbortController();
      const wd = createStreamWatchdog({ signal: ac.signal, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000 });
      assert.strictEqual(wd.signal.aborted, false);
      ac.abort();
      assert.strictEqual(wd.signal.aborted, true, '外部 abort 应转发到看门狗 signal');
      assert.strictEqual(wd.timeoutError(), null, '用户取消不应被记成超时');
      wd.dispose();
    },
  },
  {
    name: '外部信号传入时已 abort：立即转发',
    run: () => {
      const ac = new AbortController();
      ac.abort();
      const wd = createStreamWatchdog({ signal: ac.signal, firstByteTimeoutMs: 5000, idleTimeoutMs: 5000 });
      assert.strictEqual(wd.signal.aborted, true);
      wd.dispose();
    },
  },
  {
    name: 'isProgressEvent：只认业务事件，ping 心跳不算进展',
    run: () => {
      assert.strictEqual(isProgressEvent({ type: 'response.output_text.delta' }, 'response.'), true, 'Responses 业务事件算进展');
      assert.strictEqual(isProgressEvent({ type: 'ping' }, 'response.'), false, 'Responses ping 不算进展');
      assert.strictEqual(isProgressEvent({ type: 'message_delta' }, ''), true, 'Anthropic 业务事件算进展');
      assert.strictEqual(isProgressEvent({ type: 'ping' }, ''), false, 'Anthropic ping 不算进展');
      assert.strictEqual(isProgressEvent({ choices: [] }, ''), false, '没有 type 字段不算进展');
      assert.strictEqual(isProgressEvent(null, 'response.'), false, 'null 安全');
    },
  },
];

// mocha 环境（vscode-test）下注册为测试用例；否则独立运行并返回退出码。
if (typeof (globalThis as { suite?: unknown }).suite === 'function') {
  const g = globalThis as unknown as {
    suite: (name: string, fn: () => void) => void;
    test: (name: string, fn: () => void | Promise<void>) => void;
  };
  g.suite('streamTimeout', () => {
    for (const c of CASES) {
      g.test(c.name, async () => {
        await c.run();
      });
    }
  });
} else {
  void (async () => {
    let failed = 0;
    for (const c of CASES) {
      try {
        await c.run();
        console.log(`ok   ${c.name}`);
      } catch (err) {
        failed++;
        console.log(`FAIL ${c.name}`);
        console.log(String((err as Error).message).split('\n').map((l) => `     ${l}`).join('\n'));
      }
    }
    console.log(failed === 0 ? `\n全部通过（${CASES.length} 个用例）` : `\n${failed}/${CASES.length} 个用例失败`);
    process.exit(failed === 0 ? 0 : 1);
  })();
}

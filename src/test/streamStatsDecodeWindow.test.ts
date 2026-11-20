/**
 * 流式统计的 decode 分母口径（`docs/features/user-stories/dialog-core.md` US-4
 * 「流式性能统计（首字耗时、解码速率）」）。
 *
 * 缺陷：Core 对同一个 thinking 块会发**两条** `streamEnd` ——
 *  `BlockStop`（思考块真正结束，不带 usage）与 `MessageDelta`（整轮结束，带 usage）。
 * 两者带同一个 streamId，webview 的 `endStream` 被调用两次，而 `freeze()` 不判
 *  重入，第二次用「整轮结束时刻」覆盖了第一次的「思考块结束时刻」，把正文输出与
 *  工具空档一并算进 thinking 的分母，速率被稀释。
 *
 * 本用例按真实事件序驱动 store，断言 thinking 的 decodeMs 停在思考块结束时。
 *
 * 运行方式：npm run test:all -- streamStats
 */

import * as assert from 'assert';
import { createChecker, runTests } from './helpers/harness';

// `streamStatsStore` 直接引用 `window.setInterval` / `window.clearInterval`；
// 在 node 下补一个最小桩，让 ticker 可跑（用例靠显式 endStream 收敛，不依赖 ticker 触发）。
const g = globalThis as unknown as {
  window?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
};
if (!g.window) {
  g.window = { setInterval, clearInterval };
}

type Store = typeof import('../webview/streamStatsStore');

/** 用可推进的假时钟替换 Date.now，精确控制 decode 时长 */
function withFakeClock<T>(fn: (clock: { set: (ms: number) => void; now: () => number }) => T): T {
  const realNow = Date.now;
  let current = 1_000_000;
  Date.now = () => current;
  try {
    return fn({
      set: (ms) => { current = ms; },
      now: () => current,
    });
  } finally {
    Date.now = realNow;
  }
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();
  const store: Store = await import('../webview/streamStatsStore');

  withFakeClock((clock) => {
    const streamId = 'blk_thinking_1';
    const sessionId = 'sess_1';
    const t0 = clock.now();

    // 首个 thinking delta 到达（应用侧登记统计的时机）
    store.beginThinkingStream({ streamId, sessionId, firstTokenAt: t0, thinkingStartAt: t0 - 500 });

    // 思考块持续产出：末个 token 在 t0+3000 到达
    clock.set(t0 + 3000);
    store.updateStreamChars(streamId, 600);

    // 第一条 streamEnd：BlockStop（思考块结束，不带 usage）
    store.endStream(streamId);

    const afterBlockStop = store.getStreamStats(streamId);
    assert.ok(afterBlockStop, 'BlockStop 后应有统计');
    check(
      '思考块结束时 decodeMs 冻结在 token 到达跨度（3000ms）',
      afterBlockStop!.decodeMs === 3000,
    );

    // 正文输出 9000ms，随后整轮结束
    clock.set(t0 + 12000);
    // 第二条 streamEnd：MessageDelta（整轮结束，带 usage）
    store.endStream(streamId, { outputTokens: 400, reasoningTokens: 100 });

    const afterRoundEnd = store.getStreamStats(streamId);
    assert.ok(afterRoundEnd, '整轮结束后应仍有统计');
    check(
      '整轮结束不覆盖思考块的 decodeMs（仍为 3000ms）',
      afterRoundEnd!.decodeMs === 3000,
    );
    check(
      '结束后按 token 计数并取 reasoning_tokens',
      afterRoundEnd!.unit === 'tokens' && afterRoundEnd!.count === 100,
    );
    check(
      '速率用思考段耗时计算（100 tok / 3s ≈ 33.3 tok/s）',
      Math.abs(afterRoundEnd!.rate - 100 / 3) < 0.01,
    );
    check(
      '速率不被整轮耗时稀释（12s 口径会得 ≈8.3）',
      afterRoundEnd!.rate > 30,
    );
  });

  finish();
}

runTests('streamStats', run);

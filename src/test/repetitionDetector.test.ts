/**
 * 退化重复检测器单元测试（core/llm/repetitionDetector.ts）。
 *
 * 运行方式（两种都支持）：
 *   1. 独立运行：`npx tsc -p tsconfig.test.json && node out/src/test/repetitionDetector.test.js`
 *   2. 在 vscode-test 的 mocha 环境下自动注册为测试用例。
 *
 * 重点覆盖：
 *   - 阈值语义：minRepeats=50 与 minSpan=200 取更严格者（p=1 需 200 次，p=10 只需 50 次）
 *   - 不对齐的重复单元（长度不整除任何东西）也能命中
 *   - 尾窗头部混入循环前的正常内容不影响判定
 *   - 正常中文/英文/Markdown 长文本不误报
 *   - 5K 门槛、尾窗裁剪、节流
 */
import * as assert from 'assert';
import {
  RepetitionDetector,
  LLMRepetitionError,
  checkRepetition,
  DEFAULT_REPETITION_WINDOW,
  DEFAULT_REPETITION_MIN_CHECK_LENGTH,
} from '../core/llm/repetitionDetector';

/** 精确性测试用：关掉 5K 门槛与节流 */
function strict(): RepetitionDetector {
  return new RepetitionDetector({ minCheckLength: 0, checkInterval: 1 });
}

/** 断言命中，并校验单元长度与重复次数 */
function expectHit(text: string, unitLength: number, repeatCount: number): void {
  const hit = strict().append(text);
  assert.ok(hit, `期望触发重复检测，实际未触发（文本长度 ${text.length}）`);
  assert.strictEqual(hit!.unitLength, unitLength, `unitLength 应为 ${unitLength}，实际 ${hit!.unitLength}`);
  assert.strictEqual(hit!.repeatCount, repeatCount, `repeatCount 应为 ${repeatCount}，实际 ${hit!.repeatCount}`);
}

/** 断言不命中 */
function expectNoHit(text: string): void {
  const hit = strict().append(text);
  assert.strictEqual(hit, null, `不应触发重复检测，实际 unitLength=${hit?.unitLength} repeatCount=${hit?.repeatCount}`);
}

/** 生成内容各不相同的正常文本，避免测试用例自己构成重复 */
function variedText(lines: number): string {
  const zh = ['窗口管理器的实现', '输入框的焦点处理', '会话落盘的时机', '工具调用的确认流程', '日志轮转的策略'];
  const en = ['the renderer process', 'a stale socket', 'the abort controller', 'provider settings', 'tool result storage'];
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `第 ${i} 行：关于${zh[i % zh.length]}，这里记录一些与 ${en[(i * 7) % en.length]} 相关的说明，编号 ${i * 31 + 7}。`,
    );
  }
  return out.join('\n');
}

interface Case {
  name: string;
  run: () => void;
}

const CASES: Case[] = [
  {
    // minSpan=200 时 p=1 需要 200 次（而不是 50 次）
    name: 'p=1：199 个相同字符不触发、200 个触发',
    run: () => {
      expectNoHit('a'.repeat(199));
      expectHit('a'.repeat(200), 1, 200);
    },
  },
  {
    // p=2 → required = max(50, ceil(200/2)) = 100
    name: 'p=2：99 次不触发、100 次触发',
    run: () => {
      expectNoHit('ab'.repeat(99));
      expectHit('ab'.repeat(100), 2, 100);
    },
  },
  {
    // p=3 → required = ceil(200/3) = 67（向上取整，保证 span ≥ 200）
    name: 'p=3：66 次不触发、67 次触发',
    run: () => {
      expectNoHit('abc'.repeat(66));
      expectHit('abc'.repeat(67), 3, 67);
    },
  },
  {
    // p=4 起 minSpan 不再构成约束，回到 50 次
    name: 'p=10：49 次不触发、50 次触发',
    run: () => {
      expectNoHit('0123456789'.repeat(49));
      expectHit('0123456789'.repeat(50), 10, 50);
    },
  },
  {
    // 单元长度超过 minSpan 时按 50 次判定
    name: 'p=201：49 次不触发、50 次触发',
    run: () => {
      const unit = 'x'.repeat(200) + 'y'; // 避免单元自身存在更小周期
      expectNoHit(unit.repeat(49));
      expectHit(unit.repeat(50), 201, 50);
    },
  },
  {
    name: '非对齐单元（23 字符）+ 前置正常内容：命中',
    run: () => {
      expectHit('这是一段正常的开场白，介绍一下背景。' + 'I will check the file. '.repeat(50), 23, 50);
    },
  },
  {
    name: '窗口头部混入循环前的正常内容不影响判定',
    run: () => {
      expectHit('NORMAL-PREFIX-' + 'ab'.repeat(100), 2, 100);
    },
  },
  {
    name: '接近阈值但不足：20 字符单元重复 49 次不触发',
    run: () => {
      expectNoHit('check the file now. '.repeat(49));
      expectHit('check the file now. '.repeat(50), 20, 50);
    },
  },
  {
    name: '正常中文长文本不误报',
    run: () => {
      expectNoHit(variedText(300));
    },
  },
  {
    name: '正常英文长文本不误报',
    run: () => {
      const text = Array.from(
        { length: 500 },
        (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog number ${i * 17 + 3}.`,
      ).join('\n');
      expectNoHit(text);
    },
  },
  {
    name: '含 Markdown 分隔线与代码块的正常文本不误报',
    run: () => {
      expectNoHit(variedText(200) + '\n\n---\n\n' + variedText(200) + '\n\n```\ncode\n```\n');
    },
  },
  {
    name: '分片追加与一次性追加结果一致',
    run: () => {
      const text = 'normal-prefix-' + 'loop-block-'.repeat(50);
      const oneShot = strict().append(text);
      assert.ok(oneShot, '一次性追加应触发');

      const chunked = strict();
      let chunkedHit = null;
      for (let i = 0; i < text.length && !chunkedHit; i += 7) {
        chunkedHit = chunked.append(text.slice(i, i + 7));
      }
      assert.ok(chunkedHit, '分片追加应触发');
      assert.strictEqual(chunkedHit!.unitLength, oneShot!.unitLength, '两种追加方式应得到相同的单元长度');
    },
  },
  {
    name: '累积长度低于 5K 门槛时不检测，超过后检测',
    run: () => {
      assert.strictEqual(DEFAULT_REPETITION_MIN_CHECK_LENGTH, 5000, '默认门槛应为 5000');
      const loop = 'ab'.repeat(100); // 200 字符循环
      assert.strictEqual(new RepetitionDetector().append('x'.repeat(4000) + loop), null, '总长 4200 不应触发');
      const hit = new RepetitionDetector().append('x'.repeat(5000) + loop);
      assert.ok(hit, '总长 5200 应触发');
    },
  },
  {
    name: '超过尾窗被裁剪后仍能检测末尾循环',
    run: () => {
      assert.strictEqual(DEFAULT_REPETITION_WINDOW, 16384, '默认尾窗应为 16384');
      const detector = new RepetitionDetector();
      let hit = null;
      // 先灌入远超 2×尾窗的正常内容，触发裁剪
      for (let i = 0; i < 20; i++) hit = detector.append(variedText(60));
      assert.strictEqual(hit, null, `灌入 ${detector.length} 字符正常内容不应触发`);
      // 再灌入循环内容
      for (let i = 0; i < 20 && !hit; i++) hit = detector.append('abcabcabc-'.repeat(50));
      assert.ok(hit, '超长输出末尾出现循环时应触发');
    },
  },
  {
    name: '循环后紧跟正常内容时仍能触发',
    run: () => {
      const hit = strict().append(variedText(50) + 'repeat-me-'.repeat(50));
      assert.ok(hit, '应触发');
      assert.strictEqual(hit!.unitLength, 10);
    },
  },
  {
    name: '节流：新增字符不足 checkInterval 时跳过检测',
    run: () => {
      const d = new RepetitionDetector({ minCheckLength: 0, checkInterval: 1000 });
      assert.strictEqual(d.append('a'.repeat(300)), null, '新增 300 < 1000，应跳过检测');
      assert.ok(d.append('a'.repeat(800)), '累计达到 interval 后应检测并命中');
      const d2 = new RepetitionDetector({ minCheckLength: 0, checkInterval: 1 });
      assert.ok(d2.append('a'.repeat(200)), 'checkInterval=1 时首次即检测');
    },
  },
  {
    name: 'checkRepetition 抛出 LLMRepetitionError 且不是 AbortError',
    run: () => {
      let thrown: unknown = null;
      try {
        checkRepetition(strict(), 'a'.repeat(200), 'thinking');
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof LLMRepetitionError, '应抛出 LLMRepetitionError');
      assert.strictEqual((thrown as Error).name, 'LLMRepetitionError', 'name 不能是 AbortError（否则会被上层当成用户取消吞掉）');
      assert.strictEqual((thrown as LLMRepetitionError).stream, 'thinking', '应携带被检测的流类型');
      assert.ok((thrown as Error).message.includes('200'), `错误信息应包含重复次数，实际：${(thrown as Error).message}`);
    },
  },
];

// mocha 环境（vscode-test）下注册为测试用例；否则独立运行并返回退出码。
if (typeof (globalThis as { suite?: unknown }).suite === 'function') {
  const g = globalThis as unknown as {
    suite: (name: string, fn: () => void) => void;
    test: (name: string, fn: () => void) => void;
  };
  g.suite('repetitionDetector', () => {
    for (const c of CASES) {
      g.test(c.name, () => c.run());
    }
  });
} else {
  let failed = 0;
  for (const c of CASES) {
    try {
      c.run();
      console.log(`ok   ${c.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${c.name}`);
      console.log(String((err as Error).message).split('\n').map((l) => `     ${l}`).join('\n'));
    }
  }
  console.log(failed === 0 ? `\n全部通过（${CASES.length} 个用例）` : `\n${failed}/${CASES.length} 个用例失败`);
  process.exit(failed === 0 ? 0 : 1);
}

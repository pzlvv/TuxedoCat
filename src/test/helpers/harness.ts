/**
 * 测试基线工具：统一各测试文件里各自复制的「check / 汇总 / 退出码」样板。
 *
 * 为什么要有这一层：此前 `let passed/failed + const check = ...` 这段在十几个
 * 测试文件里各写一遍，写法还不一致（有的抛错、有的只置 process.exitCode），
 * 于是「失败到底算不算失败」在每个文件里得单独确认。
 *
 * 执行入口只有两个：
 * - `npm run test:all`（推荐）：`scripts/run-tests.mjs` 逐个文件起独立 node 进程；
 * - `npm test`：只跑 `src/test/vscodeHost/`，见 `src/test/README.md` 的两条车道说明。
 */

/**
 * mocha 的 tdd 全局（`suite` / `test`）。
 *
 * 只有被 mocha 收集时才有；`scripts/run-tests.mjs` 下是 undefined，走独立运行分支。
 * 保留这条分支是为了让同一份文件在两种 runner 下都能工作。
 */
export interface MochaGlobals {
  suite(name: string, fn: () => void): void;
  test(name: string, fn: () => void | Promise<void>): void;
}

export function mochaGlobals(): MochaGlobals | undefined {
  const g = globalThis as Partial<MochaGlobals>;
  return typeof g.suite === 'function' && typeof g.test === 'function'
    ? (g as MochaGlobals)
    : undefined;
}

export interface Checker {
  /** 记一条布尔断言，ok / FAIL 各打一行 */
  check(name: string, cond: boolean): void;
  /**
   * 标记本文件有（整文件或某一段）用例因环境前置不满足而未执行（如 Core 产物未构建）。
   *
   * 跳过不算失败，但不再是「静默的通过」：`finish()` 会把原因打进汇总，独立运行时
   * 退出码置 3，由 `scripts/run-tests.mjs` 单列成「跳过」计数——此前「打一行 skip →
   * 0 check → exit 0 → runner 记通过」是一条完整的假通过链（CI 未构建产物时全绿）。
   */
  markSkipped(reason: string): void;
  /**
   * 打印汇总。**有失败则抛错**：mocha 下即用例失败；独立运行时由 `runTests`
   * 接住并转成退出码 1。有跳过标记时独立运行退出码置 3（失败仍优先为 1）。
   */
  finish(): void;
}

export function createChecker(): Checker {
  let passed = 0;
  let failed = 0;
  const skipReasons: string[] = [];
  return {
    check(name: string, cond: boolean): void {
      if (cond) {
        passed++;
        console.log(`ok   ${name}`);
      } else {
        failed++;
        console.log(`FAIL ${name}`);
      }
    },
    markSkipped(reason: string): void {
      skipReasons.push(reason);
    },
    finish(): void {
      for (const reason of skipReasons) {
        console.log(`skip ${reason}`);
      }
      console.log(
        `\n${failed === 0 ? '全部通过' : '存在失败'}（${passed} 通过 / ${failed} 失败` +
          (skipReasons.length > 0 ? ` / ${skipReasons.length} 段跳过` : '') +
          '）',
      );
      if (failed > 0) {
        throw new Error(`${failed} 项断言失败（${passed} 通过 / ${failed} 失败）`);
      }
      // 跳过信号只在独立运行时用退出码传递；mocha 车道（vscodeHost/）没有这些
      // 产物门控分支，走到这里只打印即可
      if (skipReasons.length > 0 && !mochaGlobals()) {
        process.exitCode = process.exitCode === 1 ? 1 : 3;
      }
    },
  };
}

/**
 * 测试文件入口。每个测试文件底部写 `runTests('文件名', run);` 即可。
 *
 * - mocha 环境：注册成一个 suite + 一条 test，mocha 会 `await run()`，失败即失败；
 * - 独立运行：直接跑，失败时打印一行原因并把退出码置 1。
 *
 * 关键：**不要**用 `void run()` 收尾。游离 promise 的失败没人等，异步 I/O 的断言
 * 可能在进程退出前都跑不完，失败会被静默吞掉。
 */
export function runTests(name: string, run: () => void | Promise<void>): void {
  const g = mochaGlobals();
  if (g) {
    g.suite(name, () => {
      g.test(name, async () => {
        await run();
      });
    });
    return;
  }

  void Promise.resolve()
    .then(run)
    .catch((err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      console.error(`\n${name} 失败：\n${detail}`);
      process.exitCode = 1;
    });
}

/** 表驱动用例：一条命名 + 一段断言 */
export interface NamedCase {
  name: string;
  run: () => void | Promise<void>;
}

/**
 * 表驱动测试文件入口（`CASES` 数组那种写法）。
 *
 * mocha 下每个 case 注册成**独立用例**——CI 里能直接看出挂的是哪条，而不是"整个文件挂了"；
 * 独立运行时顺序执行，逐条 ok/FAIL，最后汇总。
 */
export function runCases(name: string, cases: readonly NamedCase[]): void {
  const g = mochaGlobals();
  if (g) {
    g.suite(name, () => {
      for (const testCase of cases) {
        g.test(testCase.name, async () => {
          await testCase.run();
        });
      }
    });
    return;
  }

  void (async () => {
    const { check, finish } = createChecker();
    for (const testCase of cases) {
      try {
        await testCase.run();
        check(testCase.name, true);
      } catch (err) {
        check(testCase.name, false);
        console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    finish();
  })().catch((err: unknown) => {
    console.error(`\n${name} 失败：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

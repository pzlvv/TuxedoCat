/**
 * 单测：自动获取模型时的上下文窗口提取（specs/060）。
 *
 * 覆盖两件事：
 * - 提取口径（FR-002）：字段优先级、`meta.n_ctx_train` 排除、四类非法值；
 * - 取值不额外发请求（FR-001）：提取发生在既有那次模型列表响应里。
 *
 * 运行方式：npm run test:unit -- modelContextProbe
 */

import { createChecker, runTests } from './helpers/harness';
import { readModelContextFromEntry } from '../shared/utils/modelConfig';

function run(): void {
  const { check, finish } = createChecker();

  // ---------------- FR-002：字段优先级 ----------------

  check(
    'FR-002 优先取 meta.n_ctx',
    readModelContextFromEntry({ meta: { n_ctx: 73728 } }) === 73728,
  );
  check(
    'FR-002 meta.n_ctx 缺失时取 context_length',
    readModelContextFromEntry({ meta: {}, context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 前两级缺失时取 max_model_len',
    readModelContextFromEntry({ max_model_len: 16384 }) === 16384,
  );
  check(
    'FR-002 前三级缺失时取 max_context_length',
    readModelContextFromEntry({ max_context_length: 8192 }) === 8192,
  );
  check(
    'FR-002 多字段并存时按优先级取 meta.n_ctx（不是更小的 context_length）',
    readModelContextFromEntry({ meta: { n_ctx: 73728 }, context_length: 32768, max_model_len: 16384 }) === 73728,
  );

  // ---------------- FR-002：n_ctx_train 不参与 ----------------

  check(
    'FR-002 同时有 meta.n_ctx 与 meta.n_ctx_train 时取 n_ctx',
    readModelContextFromEntry({ meta: { n_ctx: 73728, n_ctx_train: 262144 } }) === 73728,
  );
  check(
    'FR-002 只有 meta.n_ctx_train 时没有候选',
    readModelContextFromEntry({ meta: { n_ctx_train: 262144 } }) === null,
  );

  // ---------------- FR-002：非法值按「字段不存在」处理 ----------------

  check(
    'FR-002 0 视为不存在，继续看下一个字段',
    readModelContextFromEntry({ meta: { n_ctx: 0 }, context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 负数视为不存在，继续看下一个字段',
    readModelContextFromEntry({ meta: { n_ctx: -1 }, context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 非数字字符串视为不存在',
    readModelContextFromEntry({ meta: { n_ctx: '73728' }, context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 小数视为不存在（不做四舍五入）',
    readModelContextFromEntry({ meta: { n_ctx: 73728.5 }, context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 超过安全整数范围视为不存在',
    readModelContextFromEntry({ meta: { n_ctx: Number.MAX_SAFE_INTEGER + 2 } }) === null,
  );
  check(
    'FR-002 NaN / Infinity 视为不存在',
    readModelContextFromEntry({ meta: { n_ctx: Number.NaN }, context_length: Number.POSITIVE_INFINITY }) === null,
  );

  // ---------------- FR-002：形态不受控的条目 ----------------

  check(
    'FR-002 四个字段都缺失时返回 null',
    readModelContextFromEntry({ id: 'mock-model' }) === null,
  );
  check(
    'FR-002 meta 不是对象时不炸（继续看下一级）',
    readModelContextFromEntry({ meta: 'oops', context_length: 32768 }) === 32768,
  );
  check(
    'FR-002 非对象条目返回 null',
    readModelContextFromEntry('mock-model') === null && readModelContextFromEntry(null) === null,
  );
  check(
    'FR-002 数组条目返回 null',
    readModelContextFromEntry([73728]) === null,
  );

  // ---------------- FR-001：请求次数 ----------------

  // 提取是纯函数，只吃已经拿到的响应体：这条用例锁定「新增候选不需要再发请求」这一前提，
  // 真实的单次请求判据在 e2e 与 handler 侧用例里（模型列表请求命中同一个响应）。
  let calls = 0;
  const entryReader = (entry: unknown): number | null => {
    calls += 1;
    return readModelContextFromEntry(entry);
  };
  const rawList = [{ id: 'a', meta: { n_ctx: 100 } }, { id: 'b', meta: { n_ctx: 200 } }];
  const collected: Record<string, number> = {};
  for (const entry of rawList) {
    const context = entryReader(entry);
    if (context !== null) collected[(entry as any).id] = context;
  }
  check(
    'FR-001 一份响应体一次遍历即可收集全部候选',
    calls === rawList.length
      && collected.a === 100
      && collected.b === 200
      && Object.keys(collected).length === 2,
  );

  finish();
}

runTests('modelContextProbe', run);

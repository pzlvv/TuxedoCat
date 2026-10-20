/**
 * abort 按钮三态推导单测（`docs/features/abort-button.md` FR-001）。
 *
 * 根事实 → 颜色 / 可点性的唯一实现是 `src/host/abortButtonState.ts` 的纯函数，
 * webview 与测试共用它，不在组件里另写一遍 `if`。
 *
 * 运行方式：npm run test:all -- abort-button-state
 */

import * as assert from 'assert';
import { resolveAbortButtonState, type AbortButtonFacts } from '../host/abortButtonState';
import { createChecker, runTests } from './helpers/harness';

function facts(overrides: Partial<AbortButtonFacts> = {}): AbortButtonFacts {
  return {
    queryRunning: false,
    compacting: false,
    backgroundRunning: false,
    subAgentRunning: false,
    workMode: 'normal',
    ...overrides,
  };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  assert.equal(resolveAbortButtonState(facts()), 'none', '全空 → 灰色');
  check('全空 → none（灰）', true);

  assert.equal(resolveAbortButtonState(facts({ queryRunning: true })), 'query', '查询在跑 → 红色');
  assert.equal(resolveAbortButtonState(facts({ compacting: true })), 'query', '压缩中 → 红色');
  check('前台有工作 → query（红）', true);

  assert.equal(
    resolveAbortButtonState(facts({ backgroundRunning: true })),
    'background',
    '只剩后台任务 → 黄色',
  );
  assert.equal(
    resolveAbortButtonState(facts({ subAgentRunning: true })),
    'background',
    '只剩子代理 → 黄色',
  );
  assert.equal(
    resolveAbortButtonState(facts({ backgroundRunning: true, subAgentRunning: true })),
    'background',
    '后台任务 + 子代理 → 黄色',
  );
  check('前台空闲但有后台 / 子代理 → background（黄）', true);

  // 前台优先：即使还有后台任务 / 子代理，只要前台在跑就是红色
  assert.equal(
    resolveAbortButtonState(
      facts({ queryRunning: true, backgroundRunning: true, subAgentRunning: true }),
    ),
    'query',
    '前台在跑优先于后台',
  );
  check('前台优先于后台', true);

  // spin 模式没有 query engine：父会话的消费循环被 SpinLoop 占用，快照里的
  // queryRunning 为真，但按钮归入黄色档，只用于中止 spin 的子代理
  assert.equal(
    resolveAbortButtonState(facts({ workMode: 'spin' })),
    'background',
    '空闲 spin → 黄色',
  );
  assert.equal(
    resolveAbortButtonState(facts({ workMode: 'spin', queryRunning: true })),
    'background',
    '运行中的 spin 仍是黄色（queryRunning 是 SpinLoop，不是 query engine）',
  );
  assert.equal(
    resolveAbortButtonState(facts({ workMode: 'spin', backgroundRunning: true, subAgentRunning: true })),
    'background',
    'spin 与后台 / 子代理同档',
  );
  check('spin 模式 → background（黄，只中止子代理）', true);

  finish();
}

runTests('abortButtonState', run);

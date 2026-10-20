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

  // spin 模式计为可停止（specs/016 FR-004 / FR-005）：空闲的恢复态 spin 会话靠
  // 停止按钮退出 spin 模式，因此即使没有任何运行中工作也显示红色停止按钮
  assert.equal(resolveAbortButtonState(facts({ workMode: 'spin' })), 'query', '空闲 spin → 红色');
  assert.equal(
    resolveAbortButtonState(facts({ workMode: 'spin', backgroundRunning: true })),
    'query',
    'spin 优先于后台档',
  );
  check('spin 模式 → query（红，可退出）', true);

  finish();
}

runTests('abortButtonState', run);

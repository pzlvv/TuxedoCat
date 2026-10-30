/**
 * 任务进度计数单测（`docs/features/todo-list.md` FR-002）。
 *
 * `done` / `total` 的唯一实现是 `src/host/todoProgress.ts` 的纯函数：webview 只渲染它算出的
 * 两个数，不在组件里另写一遍 `filter`。
 *
 * 运行方式：npm run test:all -- todo-progress
 */

import * as assert from 'assert';
import { countTodoProgress } from '../host/todoProgress';
import type { TodoEntry } from '../shared/types';
import { createChecker, runTests } from './helpers/harness';

function entry(status: TodoEntry['status'], content = 'x'): TodoEntry {
  return { content, status };
}

async function run(): Promise<void> {
  const { check, finish } = createChecker();

  assert.equal(countTodoProgress([]), null, '空清单 → null（按钮不渲染）');
  assert.equal(countTodoProgress(null), null, '事实未到达 → null');
  assert.equal(countTodoProgress(undefined), null, '事实未到达 → null');
  check('空清单 / 事实未到达 → null', true);

  assert.deepEqual(countTodoProgress([entry('pending')]), { total: 1, done: 0, items: [entry('pending')] }, '单条未开始');
  check('1 条 pending → 0/1', true);

  const four = [
    entry('completed'),
    entry('in_progress'),
    entry('pending'),
    entry('pending'),
  ];
  assert.deepEqual(countTodoProgress(four), { total: 4, done: 1, items: four }, '4 条里 1 条完成');
  check('4 条（1 completed / 1 in_progress / 2 pending）→ 1/4', true);

  const allDone = [entry('completed'), entry('completed')];
  assert.deepEqual(countTodoProgress(allDone), { total: 2, done: 2, items: allDone }, '全部完成仍保留清单');
  check('全完成 → 2/2 且清单不被清空', true);

  // in_progress 不计入 done：只数 completed
  const inProgressOnly = [entry('in_progress'), entry('in_progress')];
  assert.equal(countTodoProgress(inProgressOnly)?.done, 0, 'in_progress 不算完成');
  check('in_progress 不计入 done', true);

  // 顺序原样透出（浮层按清单顺序渲染）
  const ordered = [entry('completed', 'a'), entry('pending', 'b'), entry('completed', 'c')];
  assert.deepEqual(
    countTodoProgress(ordered)?.items.map(item => item.content),
    ['a', 'b', 'c'],
    '顺序原样透出',
  );
  check('items 顺序原样透出', true);

  finish();
}

runTests('todoProgress', run);

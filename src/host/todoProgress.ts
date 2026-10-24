/**
 * 输入区任务进度按钮的计数（`docs/features/todo-list.md` FR-002）。
 *
 * core 是 Todo 的唯一持有者，这里只把清单折成「已完成 / 总数」两个数，供按钮文案与
 * 浮层使用（`docs/architecture/principles.md` 第 8 节：派生字段从根字段推导，且只有一份
 * 实现）。零依赖：不 import 宿主 API、不 import core 类型，webview 与单测共用。
 */

import type { TodoEntry } from '../shared/types.js';

/** 按钮与浮层需要的派生事实；`null` = 没有 Todo（按钮不渲染） */
export interface TodoProgress {
  /** 清单长度 */
  total: number;
  /** `status === 'completed'` 的条数 */
  done: number;
  /** 清单原样透出（浮层逐条渲染用） */
  items: readonly TodoEntry[];
}

/**
 * 由清单推导进度。
 *
 * - `done` 只数 `completed`；`in_progress` / `pending` 都不算完成；
 * - 空清单（含事实未到达）→ `null`，调用方据此不渲染按钮（不出现 `0/0`）；
 * - 不做去重 / 过滤 / 截断：`total` 就是清单长度。
 */
export function countTodoProgress(todos: readonly TodoEntry[] | null | undefined): TodoProgress | null {
  if (!todos || todos.length === 0) return null;
  let done = 0;
  for (const todo of todos) {
    if (todo.status === 'completed') done += 1;
  }
  return { total: todos.length, done, items: todos };
}

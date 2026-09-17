/**
 * collectConversationClosure 单测（DEVELOPMENT.md 第 11 节）：
 * 「受影响闭包」= 自身 + 所有层级的子孙对话（沿 parentSessionId 传递闭包）。
 * core 的 deleteConversation 与宿主关视图用同一条规则。
 * 运行方式：tsc -p tsconfig.test.json && node out/src/test/conversationClosure.test.js
 */

import * as assert from 'assert';
import { collectConversationClosure } from '../core/history/Conversation';

interface Meta {
  sessionId: string;
  parentSessionId?: string;
}

async function run(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, cond: boolean): void => {
    if (cond) { passed++; console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name}`); }
  };

  // A → B → C → E 是一条四层链；D 是 A 的另一个直接子；X/Y 与 A 无关
  const list: Meta[] = [
    { sessionId: 'A' },
    { sessionId: 'B', parentSessionId: 'A' },
    { sessionId: 'C', parentSessionId: 'B' },
    { sessionId: 'D', parentSessionId: 'A' },
    { sessionId: 'E', parentSessionId: 'C' },
    { sessionId: 'X' },
    { sessionId: 'Y', parentSessionId: 'X' },
  ];

  const closure = collectConversationClosure('A', list as never);
  assert.deepEqual([...closure].sort(), ['A', 'B', 'C', 'D', 'E']);
  check('closure covers all levels (A→B→C→E + D)', true);

  assert.ok(!closure.includes('X') && !closure.includes('Y'));
  check('closure excludes unrelated sessions', true);

  const middle = collectConversationClosure('B', list as never);
  assert.deepEqual([...middle].sort(), ['B', 'C', 'E']);
  check('closure of a middle node', true);

  const leaf = collectConversationClosure('E', list as never);
  assert.deepEqual([...leaf].sort(), ['E']);
  check('leaf closure is itself only', true);

  // 数据损坏形成环时不能死循环
  const cyclic: Meta[] = [
    { sessionId: 'P', parentSessionId: 'Q' },
    { sessionId: 'Q', parentSessionId: 'P' },
  ];
  const cyc = collectConversationClosure('P', cyclic as never);
  assert.deepEqual([...cyc].sort(), ['P', 'Q']);
  check('cycle-safe', true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

void run();

/**
 * buildEditDiffHunks 单元测试（Edit 工具 diff 预览的数据源）。
 *
 * 运行方式（两种都支持）：
 *   1. 独立运行：`npm run test:edit-diff`
 *   2. 在 vscode-test 的 mocha 环境下自动注册为测试用例。
 *
 * 重点覆盖「下方上下文行」的边界：
 * 在文件末尾删除行时，旧实现用 Math.max(contextEndOriginal, contextEndModified)
 * 作为循环上界，会把**刚被删除的行**再当成 unchanged 上下文渲染一遍
 * （同一条内容先红后白出现两次）。
 */
import * as assert from 'assert';
import { buildEditDiffHunks, type DiffLine } from '../core/utils/editDiff';

/** 期望的一行：`[类型, 内容]`。顺序敏感，逐行比对。 */
type ExpectedLine = [DiffLine['type'], string];

interface Case {
  name: string;
  before: string;
  after: string;
  startLine?: number;
  endLine?: number;
  replaceAll?: boolean;
  expected: ExpectedLine[];
}

/** 把行数组拼成内容字符串（`\n` 连接，与 buildEditDiffHunks 的入参一致）。 */
const lines = (...rows: string[]): string => rows.join('\n');

const CASES: Case[] = [
  {
    name: '末尾删除 2 行',
    before: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
    after: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    startLine: 9,
    endLine: 10,
    expected: [
      ['unchanged', 'g'],
      ['unchanged', 'h'],
      ['removed', 'i'],
      ['removed', 'j'],
    ],
  },
  {
    name: '末尾删除 1 行',
    before: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
    after: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'),
    startLine: 10,
    endLine: 10,
    expected: [
      ['unchanged', 'h'],
      ['unchanged', 'i'],
      ['removed', 'j'],
    ],
  },
  {
    name: '末尾清空到只剩前 2 行',
    before: lines('a', 'b', 'c', 'd'),
    after: lines('a', 'b'),
    startLine: 3,
    endLine: 4,
    expected: [
      ['unchanged', 'a'],
      ['unchanged', 'b'],
      ['removed', 'c'],
      ['removed', 'd'],
    ],
  },
  {
    name: '末尾新增 2 行',
    before: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    after: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'),
    startLine: 9,
    endLine: 8,
    expected: [
      ['unchanged', 'g'],
      ['unchanged', 'h'],
      ['added', 'i'],
      ['added', 'j'],
    ],
  },
  {
    name: '中间替换 1 行',
    before: lines('a', 'b', 'c', 'd', 'e', 'f', 'g'),
    after: lines('a', 'b', 'c', 'X', 'e', 'f', 'g'),
    startLine: 4,
    endLine: 4,
    expected: [
      ['unchanged', 'b'],
      ['unchanged', 'c'],
      ['removed', 'd'],
      ['added', 'X'],
      ['unchanged', 'e'],
      ['unchanged', 'f'],
    ],
  },
  {
    name: '中间删除 3 行',
    before: lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    after: lines('a', 'b', 'f', 'g', 'h'),
    startLine: 3,
    endLine: 5,
    expected: [
      ['unchanged', 'a'],
      ['unchanged', 'b'],
      ['removed', 'c'],
      ['removed', 'd'],
      ['removed', 'e'],
      ['unchanged', 'f'],
      ['unchanged', 'g'],
    ],
  },
  {
    name: '文件开头替换',
    before: lines('a', 'b', 'c', 'd'),
    after: lines('Z', 'b', 'c', 'd'),
    startLine: 1,
    endLine: 1,
    expected: [
      ['removed', 'a'],
      ['added', 'Z'],
      ['unchanged', 'b'],
      ['unchanged', 'c'],
    ],
  },
  {
    name: 'replaceAll 回退全量 diff 且末尾删除',
    before: lines('a', 'b', 'c', 'd', 'e', 'f'),
    after: lines('a', 'b', 'c', 'd'),
    startLine: 5,
    endLine: 6,
    replaceAll: true,
    expected: [
      ['unchanged', 'c'],
      ['unchanged', 'd'],
      ['removed', 'e'],
      ['removed', 'f'],
    ],
  },
  {
    name: 'CRLF 行尾 + 末尾删除',
    before: 'a\r\nb\r\nc\r\nd\r\ne',
    after: 'a\r\nb\r\nc',
    startLine: 4,
    endLine: 5,
    expected: [
      ['unchanged', 'b'],
      ['unchanged', 'c'],
      ['removed', 'd'],
      ['removed', 'e'],
    ],
  },
  {
    // 对应实际遇到的 UI 现象：改动点上方第 2 行是空行时，hunk 首行就是一条
    // 空上下文行，预览框顶部会看起来「多了一块空白」。这是 diff 语义正确的
    // 表现（VS Code 原生 diff 同样如此），此用例把行为钉住，避免被误当成 bug 改掉。
    name: '改动上方紧邻空行 → 首行为空上下文行',
    before: lines('l1', '', 'const t0 = 1;', 'await go();', 'l5'),
    after: lines('l1', '', 'const t0 = 1;', 'await go2();', 'l5'),
    startLine: 4,
    endLine: 4,
    expected: [
      ['unchanged', ''],
      ['unchanged', 'const t0 = 1;'],
      ['removed', 'await go();'],
      ['added', 'await go2();'],
      ['unchanged', 'l5'],
    ],
  },
];

function build(c: Case): DiffLine[] {
  return buildEditDiffHunks({
    beforeContent: c.before,
    afterContent: c.after,
    startLine: c.startLine,
    endLine: c.endLine,
    replaceAll: c.replaceAll,
  }).flatMap((hunk) => hunk.lines);
}

function checkCase(c: Case): void {
  const actual = build(c);
  assert.deepStrictEqual(
    actual.map((l) => [l.type, l.content]),
    c.expected,
    `${c.name}：hunk 内容与期望不一致`,
  );

  // 不变式：被删除的内容不允许再作为 unchanged 上下文出现（末尾删除行的老 bug）。
  const removed = new Set(actual.filter((l) => l.type === 'removed').map((l) => l.content));
  const duplicated = actual.filter((l) => l.type === 'unchanged' && removed.has(l.content));
  assert.deepStrictEqual(
    duplicated.map((l) => l.content),
    [],
    `${c.name}：删除行被重复当作上下文行`,
  );

  // 不变式：unchanged 行必须真实存在于编辑前或编辑后的内容里。
  const known = new Set([...c.before.split('\n'), ...c.after.split('\n')].map((l) => l.replace(/\r$/, '')));
  const ghost = actual.filter((l) => l.type === 'unchanged' && !known.has(l.content));
  assert.deepStrictEqual(
    ghost.map((l) => l.content),
    [],
    `${c.name}：出现了凭空捏造的上下文行`,
  );
}

// mocha 环境（vscode-test）下注册为测试用例；否则独立运行并返回退出码。
if (typeof (globalThis as { suite?: unknown }).suite === 'function') {
  const g = globalThis as unknown as {
    suite: (name: string, fn: () => void) => void;
    test: (name: string, fn: () => void) => void;
  };
  g.suite('buildEditDiffHunks', () => {
    for (const c of CASES) {
      g.test(c.name, () => checkCase(c));
    }
  });
} else {
  let failed = 0;
  for (const c of CASES) {
    try {
      checkCase(c);
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

#!/usr/bin/env node
/**
 * 生成「Spin Design 引擎」对等对照表。
 *
 * 对照表 `src/test/fixtures/spinParity.json` 被两侧共用：
 * - `src/test/spinParity.test.ts` 用 Embedded 的真实实现
 *   （`spin/Engine.ts` / `spin/SpinJudger.ts` 的导出）断言对照表仍成立；
 * - `core-rs/src/spin_tests.rs` 的 `parity_tests` 用 Rust `spin::*` 断言结果一致。
 *
 * 只覆盖**纯函数**：未赋值变量、结构问题分类、拓扑排序 / 下一个节点、rollout 归一化、
 * For Each 分行、子代理 prompt 拼装、变量替换、验收 JSON 提取、迭代进度计算。
 * 真正跑子代理 / 文件读写的流程由 Rust 侧假 `SpinHost` 端到端用例覆盖。
 *
 * 用法：先 `npm run compile-tests`，再 `node scripts/gen-spin-parity.mjs`
 *（`npx tsx scripts/gen-spin-parity.mjs` 亦可，脚本只依赖 `out/` 编译产物）。
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const spinDir = join(repoRoot, 'out', 'src', 'core', 'spin');

const {
  getVariablesWithoutValue,
  getSpinDesignIssue,
  topologicalSort,
  getNextNode,
  normalizeRolloutCount,
  normalizeRolloutPassed,
  splitForEachRows,
  buildRunPrompt,
  substituteSpinVariables,
} = require(join(spinDir, 'Engine.js'));
const { parseAccept } = require(join(spinDir, 'SpinJudger.js'));

// ---------------- 未赋值变量 ----------------

const variablesWithoutValue = [
  { name: '缺少 variables', config: {}, result: getVariablesWithoutValue({}) },
  { name: '空对象', config: { variables: {} }, result: getVariablesWithoutValue({ variables: {} }) },
  { name: '全部有值', config: { variables: { A: 'x' } }, result: getVariablesWithoutValue({ variables: { A: 'x' } }) },
  { name: '空串', config: { variables: { A: '' } }, result: getVariablesWithoutValue({ variables: { A: '' } }) },
  { name: '仅空白', config: { variables: { A: '   ' } }, result: getVariablesWithoutValue({ variables: { A: '   ' } }) },
  { name: 'null 值', config: { variables: { A: null } }, result: getVariablesWithoutValue({ variables: { A: null } }) },
  { name: '数字值', config: { variables: { A: 1 } }, result: getVariablesWithoutValue({ variables: { A: 1 } }) },
  { name: '布尔值', config: { variables: { A: 0, B: false } }, result: getVariablesWithoutValue({ variables: { A: 0, B: false } }) },
  {
    name: '跳过内置变量',
    config: { variables: { ROLLOUT_ID: '', LINE: '  ' } },
    result: getVariablesWithoutValue({ variables: { ROLLOUT_ID: '', LINE: '  ' } }),
  },
  { name: '跳过空键', config: { variables: { '': 'x' } }, result: getVariablesWithoutValue({ variables: { '': 'x' } }) },
  {
    name: '混合顺序',
    config: { variables: { A: 'x', B: '', C: 'z', D: ' ' } },
    result: getVariablesWithoutValue({ variables: { A: 'x', B: '', C: 'z', D: ' ' } }),
  },
  { name: 'variables 是数组', config: { variables: [] }, result: getVariablesWithoutValue({ variables: [] }) },
  { name: 'variables 是字符串', config: { variables: 'str' }, result: getVariablesWithoutValue({ variables: 'str' }) },
];

// ---------------- 结构问题分类 ----------------

const designIssueCases = [
  { name: 'null', config: null },
  { name: '数组', config: [] },
  { name: '空对象', config: {} },
  { name: 'nodes 为空', config: { nodes: [] } },
  { name: 'node 为 null', config: { nodes: [null] } },
  { name: 'node 缺 task', config: { nodes: [{ id: 1 }] } },
  { name: 'task 仅空白', config: { nodes: [{ id: 1, task: '   ' }] } },
  { name: 'id 是字符串', config: { nodes: [{ id: '1', task: 'x' }] } },
  { name: '合法单节点', config: { nodes: [{ id: 1, task: 'x' }] } },
  { name: '合法两节点连线', config: { nodes: [{ id: 1, task: 'x' }, { id: 2, task: 'y' }], edges: [{ from: 1, to: 2 }] } },
  {
    name: '存在未赋值变量',
    config: { nodes: [{ id: 1, task: 'x' }], variables: { K: '' } },
  },
  {
    name: '内置变量空值不算问题',
    config: { nodes: [{ id: 1, task: 'x' }], variables: { K: 'v', ROLLOUT_ID: '' } },
  },
  {
    name: '未赋值变量优先于非法 edges',
    config: { nodes: [{ id: 1, task: 'x' }], variables: { K: '' }, edges: 'nope' },
  },
  { name: 'edges 非数组', config: { nodes: [{ id: 1, task: 'x' }], edges: 'nope' } },
  { name: 'edges 为 null', config: { nodes: [{ id: 1, task: 'x' }], edges: null } },
  { name: 'variables 是数组', config: { nodes: [{ id: 1, task: 'x' }], variables: [1, 2] } },
  {
    name: '有环',
    config: {
      nodes: [{ id: 1, task: 'x' }, { id: 2, task: 'y' }],
      edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }],
    },
  },
];

const designIssues = designIssueCases.map(({ name, config }) => ({
  name,
  config,
  issue: getSpinDesignIssue(config),
}));

// ---------------- 拓扑排序 ----------------

const topoSortCases = [
  {
    name: '线性 1->2->3',
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
    edges: [{ from: 1, to: 2 }, { from: 2, to: 3 }],
  },
  {
    name: '菱形',
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    edges: [
      { from: 1, to: 2 },
      { from: 1, to: 3 },
      { from: 2, to: 4 },
      { from: 3, to: 4 },
    ],
  },
  {
    name: '孤立节点按输入顺序',
    nodes: [{ id: 5 }, { id: 1 }, { id: 3 }],
    edges: [],
  },
  {
    name: '有环只输出入度为 0 的节点',
    nodes: [{ id: 1 }, { id: 2 }, { id: 3 }],
    edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }],
  },
  {
    name: '边引用不存在的节点',
    nodes: [{ id: 1 }, { id: 2 }],
    edges: [{ from: 1, to: 9 }, { from: 9, to: 2 }],
  },
  { name: '空 nodes', nodes: [], edges: [] },
  {
    name: '重复边',
    nodes: [{ id: 1 }, { id: 2 }],
    edges: [{ from: 1, to: 2 }, { from: 1, to: 2 }],
  },
  {
    name: '重复 node id',
    nodes: [{ id: 1 }, { id: 1 }],
    edges: [],
  },
];

const topoSort = topoSortCases.map(({ name, nodes, edges }) => ({
  name,
  nodes,
  edges,
  order: topologicalSort(nodes, edges),
}));

// ---------------- 下一个节点 ----------------

const nextNodeCases = [
  {
    name: '空 meta 取拓扑序第一个',
    config: { nodes: [{ id: 1, task: 'a' }, { id: 2, task: 'b' }], edges: [{ from: 1, to: 2 }], meta: {} },
  },
  {
    name: '第一个已完成',
    config: {
      nodes: [{ id: 1, task: 'a' }, { id: 2, task: 'b' }],
      edges: [{ from: 1, to: 2 }],
      meta: { 1: { passed: true, note: '' } },
    },
  },
  {
    name: '全部完成',
    config: {
      nodes: [{ id: 1, task: 'a' }, { id: 2, task: 'b' }],
      edges: [{ from: 1, to: 2 }],
      meta: { 1: { passed: true, note: '' }, 2: { passed: true, note: '' } },
    },
  },
  {
    name: 'rolloutPassed 但不 passed 仍要执行',
    config: {
      nodes: [{ id: 1, task: 'a' }],
      edges: [],
      meta: { 1: { passed: false, note: '', rolloutPassed: 2 } },
    },
  },
  {
    name: '有环时无入度节点',
    config: {
      nodes: [{ id: 1, task: 'a' }, { id: 2, task: 'b' }],
      edges: [{ from: 1, to: 2 }, { from: 2, to: 1 }],
      meta: {},
    },
  },
];

const nextNode = nextNodeCases.map(({ name, config }) => {
  const node = getNextNode(config);
  return { name, config, nextNodeId: node ? node.id : null };
});

// ---------------- rollout 归一化 ----------------

const rolloutCountValues = [null, 0, 1, 3, -2, 1.5, 3.0, '2', true];
const rolloutCount = rolloutCountValues.map((value) => ({
  name: JSON.stringify(value) ?? 'undefined',
  value,
  result: normalizeRolloutCount(value),
}));

const rolloutPassedValues = [null, 0, 2, -1, 1.5, '1', true];
const rolloutPassed = rolloutPassedValues.map((value) => ({
  name: JSON.stringify(value) ?? 'undefined',
  value,
  result: normalizeRolloutPassed(value),
}));

// ---------------- For Each 分行 ----------------

const forEachValues = [
  null,
  '',
  '  ',
  'a\nb',
  'a\r\nb\rc',
  ' a \n\n b ',
  42,
  true,
  {},
  [1, 2],
];
const forEachRows = forEachValues.map((value) => ({
  name: JSON.stringify(value) ?? 'undefined',
  value,
  rows: splitForEachRows(value),
}));

// ---------------- 子代理 prompt ----------------

const runPromptCases = [
  {
    name: '有验收条件',
    node: { id: 1, task: '实现登录', criteria: ['支持邮箱', '支持手机号'] },
    note: null,
    skillsPrompt: null,
  },
  {
    name: '带上一轮反馈与 Skills',
    node: { id: 2, task: '修复 bug', criteria: ['不报错'] },
    note: '上一轮缺少边界检查',
    skillsPrompt: '### commit\n按规范提交',
  },
  {
    name: '无验收条件',
    node: { id: 3, task: '写文档', criteria: [] },
    note: null,
    skillsPrompt: null,
  },
  {
    name: 'note 为空串',
    node: { id: 4, task: 'A', criteria: ['c'] },
    note: '',
    skillsPrompt: '',
  },
  {
    name: 'skillsPrompt 仅空白',
    node: { id: 5, task: 'A', criteria: ['c'] },
    note: 'n',
    skillsPrompt: '   ',
  },
];

const runPrompts = runPromptCases.map(({ name, node, note, skillsPrompt }) => ({
  name,
  node,
  note: note ?? null,
  skillsPrompt: skillsPrompt ?? null,
  result: buildRunPrompt(node, note ?? undefined, skillsPrompt ?? undefined),
}));

// ---------------- 变量替换 ----------------

const substitutionCases = [
  { name: '基本替换', text: '你好 ${NAME}', variables: { NAME: '世界' } },
  { name: '未定义变量保持原样', text: '${MISSING}', variables: { NAME: 'x' } },
  { name: '无 variables', text: '你好 ${NAME}', variables: null },
  { name: '$$ 转义', text: '$${NAME}', variables: { NAME: 'x' } },
  { name: '单独 $', text: '价格 $5', variables: { NAME: 'x' } },
  { name: '长键优先', text: '${LONG}', variables: { A: 'x', LONG: '${A}' } },
  { name: '非法键名跳过', text: '${1BAD}', variables: { '1BAD': 'x' } },
  { name: '空文本', text: '', variables: { A: 'x' } },
  { name: '值里带 $', text: '${A}', variables: { A: 'a$b' } },
  { name: '多次出现', text: '${A}-${A}', variables: { A: 'x' } },
  { name: '值为 null', text: '${A}', variables: { A: null } },
];

const substitutions = substitutionCases.map(({ name, text, variables }) => ({
  name,
  text,
  variables: variables ?? null,
  result: substituteSpinVariables(text, variables ?? undefined),
}));

// ---------------- 验收 JSON 提取 ----------------

const judgeReplies = [
  '{"accept": true}',
  '{"accept": false}',
  '```json\n{"accept": true}\n```',
  '判定结果：{"accept": true}，请查收',
  '{"accept": 1}',
  'true',
  'false',
  'True',
  'FALSE',
  '随便写点什么',
  '',
  '{"note":"a}b"}',
  '  {"accept":true}  ',
  '{"foo":1}',
  '{"accept": true',
  'The answer is false',
  '{"accept":true} extra {"accept":false}',
  '{"accept": "true"}',
  // 字符串里带 `}`：TS 的正则会在该 `}` 处截断，解析失败后落到字母兜底
  '前缀 {"note":"a}b","accept":true} 后缀',
  '{"a":{"accept":true}}',
];

const judgeParse = judgeReplies.map((reply) => ({
  name: JSON.stringify(reply),
  reply,
  accept: parseAccept(reply),
}));

// ---------------- 迭代进度 ----------------

/** 逐行镜像 Loop.ts 326–352 行的进度计算（只有这部分是内联逻辑，无导出可调） */
function computeProgress(node, variables, meta) {
  const rolloutCount = normalizeRolloutCount(node.rollout);
  const forEachVar = typeof node.forEach === 'string' ? node.forEach.trim() : '';
  const forEachRows = forEachVar ? splitForEachRows(variables?.[forEachVar]) : [''];
  const totalIterations = forEachRows.length * rolloutCount;
  const completedIterations = normalizeRolloutPassed(meta?.[String(node.id)]?.rolloutPassed);
  const currentRowIndex = Math.floor(completedIterations / rolloutCount);
  const rolloutId = completedIterations % rolloutCount;
  const currentRowValue = forEachRows[currentRowIndex] ?? '';
  const iterationLabel =
    forEachRows.length > 1 && rolloutCount > 1
      ? ` [row ${currentRowIndex + 1}/${forEachRows.length}, rollout ${rolloutId + 1}/${rolloutCount}]`
      : forEachRows.length > 1
        ? ` [row ${currentRowIndex + 1}/${forEachRows.length}]`
        : rolloutCount > 1
          ? ` [rollout ${rolloutId + 1}/${rolloutCount}]`
          : '';
  return {
    rolloutCount,
    forEachVar,
    forEachRows,
    totalIterations,
    completedIterations,
    currentRowIndex,
    rolloutId,
    currentRowValue,
    iterationLabel,
  };
}

const progressCases = [
  {
    name: '单行单 rollout',
    node: { id: 1, task: 'a' },
    variables: {},
    meta: {},
  },
  {
    name: '单行 rollout 3 已完成 1',
    node: { id: 1, task: 'a', rollout: 3 },
    variables: {},
    meta: { 1: { rolloutPassed: 1 } },
  },
  {
    name: 'For Each 两行',
    node: { id: 1, task: 'a', forEach: 'ITEMS' },
    variables: { ITEMS: 'a\nb' },
    meta: {},
  },
  {
    name: 'For Each + rollout 已完成 1',
    node: { id: 1, task: 'a', forEach: 'ITEMS', rollout: 2 },
    variables: { ITEMS: 'a\nb' },
    meta: { 1: { rolloutPassed: 1 } },
  },
  {
    name: 'For Each + rollout 进入第二行',
    node: { id: 1, task: 'a', forEach: 'ITEMS', rollout: 2 },
    variables: { ITEMS: 'a\nb' },
    meta: { 1: { rolloutPassed: 2 } },
  },
  {
    name: 'For Each 变量不存在',
    node: { id: 1, task: 'a', forEach: 'MISSING' },
    variables: {},
    meta: {},
  },
  {
    name: 'For Each 变量为空串',
    node: { id: 1, task: 'a', forEach: 'ITEMS' },
    variables: { ITEMS: '' },
    meta: {},
  },
  {
    name: 'rolloutPassed 超出总数',
    node: { id: 1, task: 'a', rollout: 3 },
    variables: {},
    meta: { 1: { rolloutPassed: 5 } },
  },
];

const progress = progressCases.map(({ name, node, variables, meta }) => ({
  name,
  node,
  variables,
  meta,
  result: computeProgress(node, variables, meta),
}));

// ---------------- 写出 ----------------

const output = {
  note:
    'Spin Design 引擎纯函数对照表（Embedded `spin/Engine.ts` / `spin/SpinJudger.ts` ↔ ' +
    'Standalone `core-rs/src/spin.rs`）。只覆盖未赋值变量 / 结构问题分类 / 拓扑排序 / ' +
    '下一个节点 / rollout 归一化 / For Each 分行 / 子代理 prompt 拼装 / 变量替换 / ' +
    '验收 JSON 提取 / 迭代进度计算；真正跑子代理与文件读写的流程由 Rust 侧假 SpinHost 单测覆盖。',
  variablesWithoutValue,
  designIssues,
  topoSort,
  nextNode,
  rolloutCount,
  rolloutPassed,
  forEachRows,
  runPrompts,
  substitutions,
  judgeParse,
  progress,
};

writeFileSync(
  join(repoRoot, 'src', 'test', 'fixtures', 'spinParity.json'),
  `${JSON.stringify(output, null, 2)}\n`,
);

console.log('wrote src/test/fixtures/spinParity.json');

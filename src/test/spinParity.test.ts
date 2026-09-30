/**
 * Spin Design 引擎对等测试（Embedded ↔ Standalone）。
 *
 * 两侧读同一份 `src/test/fixtures/spinParity.json`：
 * - 本文件断言「对照表 == Embedded 的 `spin/Engine.ts` / `spin/SpinJudger.ts`」；
 * - `core-rs/src/spin_tests.rs` 断言「Rust `spin::*` == 对照表」。
 *
 * 只覆盖**纯函数**：未赋值变量、结构问题分类、拓扑排序 / 下一个节点、rollout 归一化、
 * For Each 分行、子代理 prompt 拼装、变量替换、验收 JSON 提取、迭代进度计算。
 * 真正跑子代理 / 文件读写的流程由 Rust 侧假 SpinHost 端到端用例覆盖。
 *
 * 运行方式：npm run test:all -- spin-parity
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  buildRunPrompt,
  getNextNode,
  getSpinDesignIssue,
  getVariablesWithoutValue,
  normalizeRolloutCount,
  normalizeRolloutPassed,
  splitForEachRows,
  substituteSpinVariables,
  topologicalSort,
} from '../core/spin/Engine';
import { parseAccept } from '../core/spin/SpinJudger';
import type { SpinDesign, SpinEdge, SpinNode } from '../core/spin/Types';
import { createChecker, runTests } from './helpers/harness';

interface ProgressResult {
  rolloutCount: number;
  forEachVar: string;
  forEachRows: string[];
  totalIterations: number;
  completedIterations: number;
  currentRowIndex: number;
  rolloutId: number;
  currentRowValue: string;
  iterationLabel: string;
}

interface Fixture {
  variablesWithoutValue: Array<{ name: string; config: unknown; result: string[] }>;
  designIssues: Array<{ name: string; config: unknown; issue: string | null }>;
  topoSort: Array<{ name: string; nodes: SpinNode[]; edges: SpinEdge[]; order: number[] }>;
  nextNode: Array<{ name: string; config: SpinDesign; nextNodeId: number | null }>;
  rolloutCount: Array<{ name: string; value: unknown; result: number }>;
  rolloutPassed: Array<{ name: string; value: unknown; result: number }>;
  forEachRows: Array<{ name: string; value: unknown; rows: string[] }>;
  runPrompts: Array<{ name: string; node: SpinNode; note: string | null; skillsPrompt: string | null; result: string }>;
  substitutions: Array<{ name: string; text: string; variables: Record<string, string> | null; result: string }>;
  judgeParse: Array<{ name: string; reply: string; accept: boolean }>;
  progress: Array<{
    name: string;
    node: SpinNode;
    variables: Record<string, string>;
    meta: Record<string, { rolloutPassed?: number }>;
    result: ProgressResult;
  }>;
}

const FIXTURE = path.resolve(__dirname, '../../../src/test/fixtures/spinParity.json');

/** 逐行镜像 `Loop.ts` 326–352 行的进度计算（该段逻辑内联在 spinLoop 里，没有可导出的函数） */
function computeProgress(
  node: SpinNode,
  variables: Record<string, string> | undefined,
  meta: Record<string, { rolloutPassed?: number }> | undefined,
): ProgressResult {
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

function run(): void {
  const { check, finish } = createChecker();
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture;

  check('对照表非空', fixture.variablesWithoutValue.length > 0 && fixture.progress.length > 0);

  for (const item of fixture.variablesWithoutValue) {
    check(
      `getVariablesWithoutValue: ${item.name}`,
      JSON.stringify(getVariablesWithoutValue(item.config as never)) === JSON.stringify(item.result),
    );
  }

  for (const item of fixture.designIssues) {
    check(
      `getSpinDesignIssue: ${item.name}`,
      getSpinDesignIssue(item.config) === item.issue,
    );
  }

  for (const item of fixture.topoSort) {
    check(
      `topologicalSort: ${item.name}`,
      JSON.stringify(topologicalSort(item.nodes, item.edges)) === JSON.stringify(item.order),
    );
  }

  for (const item of fixture.nextNode) {
    const node = getNextNode(item.config);
    check(`getNextNode: ${item.name}`, (node ? node.id : null) === item.nextNodeId);
  }

  for (const item of fixture.rolloutCount) {
    check(
      `normalizeRolloutCount: ${item.name}`,
      normalizeRolloutCount(item.value) === item.result,
    );
  }

  for (const item of fixture.rolloutPassed) {
    check(
      `normalizeRolloutPassed: ${item.name}`,
      normalizeRolloutPassed(item.value) === item.result,
    );
  }

  for (const item of fixture.forEachRows) {
    check(
      `splitForEachRows: ${item.name}`,
      JSON.stringify(splitForEachRows(item.value)) === JSON.stringify(item.rows),
    );
  }

  for (const item of fixture.runPrompts) {
    check(
      `buildRunPrompt: ${item.name}`,
      buildRunPrompt(
        item.node,
        item.note ?? undefined,
        item.skillsPrompt ?? undefined,
      ) === item.result,
    );
  }

  for (const item of fixture.substitutions) {
    check(
      `substituteSpinVariables: ${item.name}`,
      substituteSpinVariables(item.text, item.variables ?? undefined) === item.result,
    );
  }

  for (const item of fixture.judgeParse) {
    check(`parseAccept: ${item.name}`, parseAccept(item.reply) === item.accept);
  }

  for (const item of fixture.progress) {
    const actual = computeProgress(item.node, item.variables, item.meta);
    check(
      `computeProgress: ${item.name}`,
      JSON.stringify(actual) === JSON.stringify(item.result),
    );
  }

  finish();
}

runTests('spin-parity', run);

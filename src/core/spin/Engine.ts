/**
 * SpinEngine - Spin Design 核心引擎
 *
 * 负责：
 * - 读取/写入 spin.json（流程图格式）
 * - 拓扑排序获取执行顺序
 * - 进度计算
 * - 构建 sub-agent prompt
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { getProjectConversationDir, ensureProjectConversationDir } from '../history/Config.js';
import { tt } from '../i18n.js';
import { logger } from '../Logger.js';
import type { SpinDesign, SpinNode, SpinEdge, SpinNodeMeta } from './Types.js';

const SPIN_FILE = 'spin.json';

/**
 * 获取 spin.json 路径
 * 存储在 ~/<CONFIG_DIR_NAME>/conversations/<encoded-workspace>/spin.json
 */
function getSpinJsonPath(cwd: string): string {
  const projectDir = getProjectConversationDir(cwd);
  return path.join(projectDir, SPIN_FILE);
}

/**
 * 读取 spin.json
 */
export async function readSpinJson(cwd: string): Promise<SpinDesign | null> {
  try {
    const content = await fs.readFile(getSpinJsonPath(cwd), 'utf-8');
    const config = JSON.parse(content) as SpinDesign;
    return config;
  } catch {
    return null;
  }
}

/** spin.json 结构问题分类 */
export type SpinDesignIssue = 'invalid' | 'empty-node' | 'not-dag' | 'variable-no-value';

/** 内置变量名，不能作为用户变量 */
const RESERVED_BUILTIN_VARS = ['ROLLOUT_ID', 'LINE'];

/**
 * 找出“已命名但未赋值”的用户变量名（值为空字符串/仅空白）。
 * 变量名非法或与内置变量冲突的情况由其他校验处理，这里只关注值缺失。
 */
export function getVariablesWithoutValue(config: Partial<SpinDesign>): string[] {
  const vars = config.variables;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return [];
  const result: string[] = [];
  for (const key of Object.keys(vars)) {
    if (!key || RESERVED_BUILTIN_VARS.includes(key)) continue;
    const value = (vars as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.trim() === '') result.push(key);
  }
  return result;
}

/**
 * 获取 spin.json 的结构问题类型。
 * - invalid: JSON/节点数据非法
 * - empty-node: 存在空节点（无任务描述）
 * - not-dag: 不是有效的无环有向图（DAG）
 * - variable-no-value: 存在未赋值的用户变量
 */
function getSpinDesignIssue(config: unknown): SpinDesignIssue | null {
  if (!config || typeof config !== 'object') return 'invalid';

  const spin = config as Partial<SpinDesign>;
  if (!Array.isArray(spin.nodes) || spin.nodes.length === 0) return 'empty-node';

  for (const node of spin.nodes) {
    if (!node || typeof node !== 'object' || typeof (node as Partial<SpinNode>).id !== 'number') {
      return 'invalid';
    }
    const task = (node as Partial<SpinNode>).task;
    if (typeof task !== 'string' || task.trim() === '') {
      return 'empty-node';
    }
  }

  if (getVariablesWithoutValue(spin).length > 0) return 'variable-no-value';

  if (spin.edges !== undefined && !Array.isArray(spin.edges)) return 'invalid';

  const order = topologicalSort(spin.nodes, Array.isArray(spin.edges) ? spin.edges : []);
  if (order.length !== spin.nodes.length) return 'not-dag';

  return null;
}

/**
 * 校验 spin.json 是否可执行。
 * @returns 错误信息；合法时返回 null
 */
export function validateSpinDesign(config: unknown): string | null {
  if (!config || typeof config !== 'object') {
    return tt('spin.json 不是有效的对象。', 'spin.json is not a valid object.');
  }

  const spin = config as Partial<SpinDesign>;
  if (!Array.isArray(spin.nodes)) {
    return tt('spin.json 缺少 nodes 数组。', 'spin.json is missing the nodes array.');
  }
  if (spin.nodes.length === 0) {
    return tt('spin.json 中没有可执行的节点。', 'spin.json has no executable nodes.');
  }

  // 用户变量不能与内置变量冲突
  if (spin.variables && typeof spin.variables === 'object') {
    for (const key of Object.keys(spin.variables)) {
      if (RESERVED_BUILTIN_VARS.includes(key)) {
        return tt(
          `变量 "${key}" 与内置变量冲突，请重命名后重试。`,
          `Variable "${key}" conflicts with a built-in variable. Please rename it and retry.`,
        );
      }
    }
  }

  // 变量必须已赋值，否则 ${KEY} 会被替换为空字符串
  const noValueVars = getVariablesWithoutValue(spin);
  if (noValueVars.length > 0) {
    return tt(
      `存在未赋值的变量（${noValueVars.join(', ')}），请在变量列表中填写变量值后重试。`,
      `Variables without a value (${noValueVars.join(', ')}), please fill in their values in the variable list and retry.`,
    );
  }

  for (const node of spin.nodes) {
    if (!node || typeof node !== 'object' || typeof (node as Partial<SpinNode>).id !== 'number') {
      return tt('spin.json 中存在无效节点。', 'spin.json contains an invalid node.');
    }
    const task = (node as Partial<SpinNode>).task;
    if (typeof task !== 'string' || task.trim() === '') {
      return tt(
        `节点 ${(node as SpinNode).id} 缺少任务描述。`,
        `Node ${(node as SpinNode).id} is missing a task description.`,
      );
    }
    const forEachVar = typeof (node as Partial<SpinNode>).forEach === 'string'
      ? ((node as Partial<SpinNode>).forEach as string).trim()
      : '';
    if (
      forEachVar
      && (
        !spin.variables
        || typeof spin.variables !== 'object'
        || !Object.prototype.hasOwnProperty.call(spin.variables, forEachVar)
      )
    ) {
      return tt(
        `节点 ${(node as SpinNode).id} 的 For Each 变量 "${forEachVar}" 不存在。`,
        `Node ${(node as SpinNode).id}: For Each variable "${forEachVar}" does not exist.`,
      );
    }
  }

  if (spin.edges !== undefined && !Array.isArray(spin.edges)) {
    return tt('spin.json 缺少 edges 数组。', 'spin.json is missing the edges array.');
  }

  const order = topologicalSort(spin.nodes, Array.isArray(spin.edges) ? spin.edges : []);
  if (order.length !== spin.nodes.length) {
    return tt(
      '流程图不是有效的无环有向图（DAG），请检查连线后重试。',
      'The flow is not a valid directed acyclic graph (DAG), please check the edges and retry.'
    );
  }

  return null;
}

/**
 * 写入 spin.json
 *
 * 使用“先写临时文件，再原子 rename”的方式，避免读取方在写入过程中
 * 读到空文件或半截 JSON，导致 Spin Design 打开时节点内容被误判为空。
 */
export async function writeSpinJson(cwd: string, config: SpinDesign): Promise<void> {
  // 确保项目对话目录存在（目录由 core 建；其中的 settings.json 由宿主写）
  await ensureProjectConversationDir(cwd);
  const content = JSON.stringify(config, null, 2);
  const spinPath = getSpinJsonPath(cwd);
  const tmpPath = `${spinPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmpPath, spinPath);
  } catch (err) {
    // 清理可能残留的临时文件，避免下次读取/写入混淆
    await fs.rm(tmpPath, { force: true }).catch(() => { });
    throw err;
  }
}

/**
 * 对 nodes 做拓扑排序，返回按执行顺序排列的 node id 列表
 */
export function topologicalSort(nodes: SpinNode[], edges: SpinEdge[]): number[] {
  const idSet = new Set<number>();
  nodes.forEach(n => idSet.add(n.id));

  // 邻接表和入度
  const adj = new Map<number, number[]>();
  const inDeg = new Map<number, number>();
  nodes.forEach(n => { adj.set(n.id, []); inDeg.set(n.id, 0); });

  edges.forEach(e => {
    if (!idSet.has(e.from) || !idSet.has(e.to)) return;
    adj.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  });

  // Kahn
  const queue: number[] = [];
  nodes.forEach(n => { if (inDeg.get(n.id) === 0) queue.push(n.id); });

  const sorted: number[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const neighbor of adj.get(id) || []) {
      inDeg.set(neighbor, (inDeg.get(neighbor) || 0) - 1);
      if (inDeg.get(neighbor) === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 替换 Spin 变量引用
 * - ${KEY} -> variables[KEY]（KEY 为字母/数字/下划线组成的变量名）
 * - $$ -> 字面量 $（转义，且不会被当作变量前缀）
 * - 未匹配的 ${...} 保持原样
 */
export function substituteSpinVariables(text: string, variables?: Record<string, string>): string {
  if (!text) return text;
  const placeholder = '\u0000';
  let result = text.replace(/\$\$/g, placeholder);
  if (variables) {
    const keys = Object.keys(variables).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      result = result.replace(new RegExp(`\\$\\{${escapeRegExp(key)}\\}`, 'g'), () => variables[key] ?? '');
    }
  }
  // 还原 $$ 转义，并保留未匹配的 $
  result = result.replace(/\$/g, placeholder).split(placeholder).join('$');
  return result;
}

/**
 * 获取下一个未完成的节点（拓扑序中第一个未完成/未通过的）
 */
export function getNextNode(config: SpinDesign): SpinNode | null {
  if (!config.meta) config.meta = {};

  const order = topologicalSort(config.nodes, config.edges);
  for (const id of order) {
    const meta = config.meta[String(id)];
    if (!meta || !meta.passed) {
      return config.nodes.find(n => n.id === id) || null;
    }
  }
  return null;
}

/**
 * 规范化 rollout 执行次数：必须是 >=1 的整数，否则默认 1
 */
export function normalizeRolloutCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * 规范化已完成 rollout 数量：必须是 >=0 的整数，否则默认 0
 */
export function normalizeRolloutPassed(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * 将 For Each 变量值按行拆分
 * - 支持 CRLF / LF / CR 换行
 * - 每行 trim 后，空白行（空行或仅含空格/制表符的行）直接跳过，不参与迭代
 */
export function splitForEachRows(value: unknown): string[] {
  const rows: string[] = [];
  for (const rawLine of String(value ?? '').split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    rows.push(line);
  }
  return rows;
}

/**
 * 构建 sub-agent prompt
 */
export function buildRunPrompt(node: SpinNode, note?: string, skillsPrompt?: string): string {
  const acList = (node.criteria || [])
    .map(ac => `- [ ] ${ac}`)
    .join('\n');

  let previousNoteSection = '';
  if (note) {
    previousNoteSection = `\n### 上一轮反馈\n${note}\n`;
  }

  let skillsSection = '';
  if (skillsPrompt && skillsPrompt.trim()) {
    skillsSection = `\n### 已加载的 Skills\n${skillsPrompt}\n`;
  }

  return `## 子任务: ${node.task}

### 验收条件
${acList}
${skillsSection}
${previousNoteSection}
### 你的工作方式

1. 先阅读当前项目代码，了解现有结构
2. 实现该任务的所有功能
3. 确保所有验收条件都满足

### 重要

- 只实现当前这一个子任务，不要做额外的功能
- 完成后用 \`Reply\` 工具发送执行反馈，针对每一条验收标准，描述下完成的程度，若未完成说明下遇到的问题。
- 如果遇到阻塞或未解决的问题，在反馈中说明原因
- Reply 消息中只包含反馈内容，不要包含其他文字或 markdown 标记`;
}

/**
 * spin.json 写操作串行队列
 *
 * SpinLoop 的 updateNodeMeta 与 Spin Design webview 的保存都会对 spin.json
 * 做"读-改-写"。若两者并发，后写者会覆盖先写者的结果：
 * 例如用户点击"清除结果"（meta 写为 {}）后，正在运行的 Loop 回写某个节点的
 * meta，会把已完成状态重新写回，导致"清除结果不生效"。
 * 通过队列将所有写操作串行化，避免并发读-改-写造成的丢失更新。
 */
let spinWriteChain: Promise<void> = Promise.resolve();

/**
 * 串行化执行对 spin.json 的读-改-写操作
 * 按调用顺序排队执行（Promise 链），单个失败不影响后续队列。
 */
export function enqueueSpinWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = spinWriteChain.then(task, task);
  spinWriteChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * 串行写入 spin.json（供 SpinLoop 与 webview 保存共用）
 */
export function writeSpinJsonQueued(cwd: string, config: SpinDesign): Promise<void> {
  return enqueueSpinWrite(() => writeSpinJson(cwd, config));
}

/**
 * 更新某个节点的执行状态（串行化，避免并发读-改-写丢失更新）
 */
export function updateNodeMeta(
  cwd: string,
  nodeId: number,
  passed: boolean,
  note?: string,
  extra?: Partial<SpinNodeMeta>,
): Promise<boolean> {
  return enqueueSpinWrite(async () => {
    const config = await readSpinJson(cwd);
    if (!config) return;
    if (!config.meta) config.meta = {};

    const key = String(nodeId);
    const prev = config.meta[key] || {};
    config.meta[key] = {
      ...prev,
      passed,
      note: note || '',
      ...extra,
    };

    await writeSpinJson(cwd, config);
  })
    .then(() => true)
    .catch(() => false);
}

/**
 * 自动检测项目状态
 * - init: 不存在 spin.json
 * - ready: spin.json 存在且结构可执行
 * - invalid: JSON 非法或节点数据非法
 * - empty-node: 存在空节点（无任务描述）
 * - not-dag: 不是有效的无环有向图（DAG）
 */
export type SpinProjectState = 'init' | 'ready' | SpinDesignIssue;

export async function detectProjectState(cwd: string): Promise<SpinProjectState> {
  const spinPath = getSpinJsonPath(cwd);
  try {
    const content = await fs.readFile(spinPath, 'utf-8');
    const config = JSON.parse(content);
    const issue = getSpinDesignIssue(config);
    const state: SpinProjectState = issue ? issue : 'ready';
    logger.info('SpinEngine', `detectProjectState path=${spinPath} state=${state}`);
    return state;
  } catch (err) {
    const state: SpinProjectState = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'init' : 'invalid';
    logger.info('SpinEngine', `detectProjectState path=${spinPath} state=${state} err=${(err as Error)?.message ?? err}`);
    return state;
  }
}

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
import type { SpinDesign, SpinNode, SpinEdge } from './Types.js';

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

/**
 * 写入 spin.json
 *
 * 使用“先写临时文件，再原子 rename”的方式，避免读取方在写入过程中
 * 读到空文件或半截 JSON，导致 Spin Design 打开时节点内容被误判为空。
 */
export async function writeSpinJson(cwd: string, config: SpinDesign): Promise<void> {
  // 确保项目对话目录存在，并写入 settings.json（记录 workspacePath）
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
 * - $KEY -> variables[KEY]（KEY 为字母/数字/下划线组成的变量名）
 * - $$ -> 字面量 $（转义，且不会被当作变量前缀）
 * - 未匹配的 $ 保持原样
 */
export function substituteSpinVariables(text: string, variables?: Record<string, string>): string {
  if (!text) return text;
  const placeholder = '\u0000';
  let result = text.replace(/\$\$/g, placeholder);
  if (variables) {
    const keys = Object.keys(variables).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      result = result.replace(new RegExp(`\\$${escapeRegExp(key)}\\b`, 'g'), () => variables[key] ?? '');
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
): Promise<boolean> {
  return enqueueSpinWrite(async () => {
    const config = await readSpinJson(cwd);
    if (!config) return;
    if (!config.meta) config.meta = {};

    const key = String(nodeId);
    config.meta[key] = {
      passed,
      note: note || '',
    };

    await writeSpinJson(cwd, config);
  })
    .then(() => true)
    .catch(() => false);
}

/**
 * 自动检测项目状态
 */
export function detectProjectState(cwd: string): Promise<'init' | 'ready'> {
  return readSpinJson(cwd).then(config => config ? 'ready' : 'init');
}

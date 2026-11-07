/**
 * Edit / Write 工具结果的宿主侧旁路观察（specs/030 FR-001 / FR-003；US-61）。
 *
 * 从 `CoreEvent.toolResult` 的输出文本解析「本次改动落在了哪个文件」的事实，并把路径
 * 解析到打开集合中的某个工作区。纯函数、无 Electron 依赖：`ElectronUIHost.onToolResult`
 * 消费，`src/test/toolResultSideEffects.test.ts` 单测。
 *
 * 触发面（US-61 验收 1 / 2）：
 * - Write 新建（`Created file: `）：文件树（tree）+ 变更视图（doc / changes）；
 * - Write 覆盖（`Updated file: `）与 Edit（`Edited file: `）：只失效变更视图
 *   （doc / changes）——树结构没变，整树重读没有意义；
 * - 外部编辑器的修改不在触发面内（宿主没有工作树级监听，哨兵只听 `.git`）。
 */

/** 工具输出首行的路径前缀（core `run_write` / `run_edit` 的输出契约，
 * `core-rs/src/tools_tests.rs` 锁定；改前缀须与 Rust 侧测试同步） */
const CREATED_FILE_PREFIX = 'Created file: ';
const UPDATED_FILE_PREFIX = 'Updated file: ';
const EDITED_FILE_PREFIX = 'Edited file: ';

/** 本次工具改动对侧栏的含义：`create` 连树一起刷新，其余只失效变更视图 */
export type ToolMutationKind = 'create' | 'modify';

export interface ParsedToolMutation {
  /** 工具输入原样的路径（可能是相对路径） */
  path: string;
  kind: ToolMutationKind;
}

/** 本次工具改动落在哪个文件（非 Edit / Write 成功形态返回 null） */
export function parseToolMutation(toolName: string, status: string, output: string): ParsedToolMutation | null {
  if (status !== 'success') return null;
  const firstLine = output.split('\n', 1)[0] ?? '';
  const strip = (prefix: string): string | null =>
    firstLine.startsWith(prefix) ? firstLine.slice(prefix.length) : null;
  if (toolName === 'Write') {
    const created = strip(CREATED_FILE_PREFIX);
    if (created !== null) return { path: created, kind: 'create' };
    const updated = strip(UPDATED_FILE_PREFIX);
    if (updated !== null) return { path: updated, kind: 'modify' };
    return null;
  }
  if (toolName === 'Edit') {
    const edited = strip(EDITED_FILE_PREFIX);
    if (edited !== null) return { path: edited, kind: 'modify' };
    return null;
  }
  return null;
}

export interface OpenWorkspaceRoot {
  /** 工作区根在该机器上的绝对路径 */
  root: string;
  /** 远程（SSH）工作区的根是 POSIX 路径，按大小写敏感比较；本地根按大小写不敏感 */
  remote: boolean;
}

/** 绝对路径判定（平台无关：盘符 / UNC / POSIX 三形态，宿主与远端路径都可能出现在这） */
function isAbsolutePath(text: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(text);
}

/** 根包含判定：统一分隔符与尾斜杠后做前缀比较 */
function rootContains(root: string, candidate: string, caseInsensitive: boolean): boolean {
  const norm = (text: string): string => text.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const normalizedRoot = norm(caseInsensitive ? root.toLowerCase() : root);
  const normalizedCandidate = norm(caseInsensitive ? candidate.toLowerCase() : candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/**
 * 把工具路径解析到打开集合里的工作区：相对路径按会话工作区根展开，绝对路径在
 * 打开集合内做包含判定。解析不到（集合外 / 无会话根的相对路径）返回 null——
 * 这是「不属于任何侧栏视图」的设计允许 no-op，不是错误。
 */
export function resolveToolWorkspace(
  pathText: string,
  sessionRoot: string | null,
  openRoots: readonly OpenWorkspaceRoot[],
): OpenWorkspaceRoot | null {
  const trimmed = pathText.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return null;
  const candidate = isAbsolutePath(trimmed)
    ? trimmed
    : sessionRoot !== null
      ? `${sessionRoot.replace(/[\\/]+$/, '')}/${trimmed.replace(/^[\\/]+/, '')}`
      : null;
  if (candidate === null) return null;
  return openRoots.find((entry) => rootContains(entry.root, candidate, !entry.remote)) ?? null;
}

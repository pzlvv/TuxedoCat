/**
 * Write 工具结果的宿主侧旁路观察（specs/030 FR-001）。
 *
 * 从 `CoreEvent.toolResult` 的输出文本解析「新建文件」事实，并把路径解析到打开集合
 * 中的某个工作区。纯函数、无 Electron 依赖：`ElectronUIHost.onToolResult` 消费，
 * `src/test/toolResultSideEffects.test.ts` 单测。
 */

/** Write 成功输出的首行前缀（`core-rs/src/tools.rs` `run_write` 的输出契约，
 * `tools_tests.rs` 锁定；改前缀须与 Rust 侧测试同步） */
const CREATED_FILE_PREFIX = 'Created file: ';

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

/** Write 新建文件的路径（工具输入原样，可能是相对路径）；非该形态返回 null */
export function parseCreatedFilePath(toolName: string, status: string, output: string): string | null {
  if (toolName !== 'Write' || status !== 'success') return null;
  const firstLine = output.split('\n', 1)[0] ?? '';
  return firstLine.startsWith(CREATED_FILE_PREFIX) ? firstLine.slice(CREATED_FILE_PREFIX.length) : null;
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

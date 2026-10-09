/**
 * 路径输入框的解析（远程目录选择器用，纯函数）。
 *
 * 输入框里敲的可能是「已经敲完的目录」，也可能是「正在补全的最后一段」：
 * 前者直接列它自己，后者要列它的父目录再按前缀筛。这个模块只负责把字符串拆开，
 * 不判断路径是否存在（那是 daemon 的事，见 `electron/remoteWorkspace/main.ts`）。
 *
 * 不依赖 electron：可在单测里直接使用。
 */

/** 一次拆分的结果 */
export interface PathInputSplit {
  /** 要列的目录；末尾保留分隔符，直接交给 daemon 即可 */
  dir: string;
  /** 最后一段（过滤词）；末尾是分隔符时为空串 */
  prefix: string;
}

/**
 * 按**最后一个**分隔符拆开（`/` 与 `\` 都算，远端可能是 Windows 也可能是 Linux）。
 *
 * - `/workspace/a` → `{ dir: '/workspace/', prefix: 'a' }`
 * - `/workspace/`  → `{ dir: '/workspace/', prefix: '' }`（用户明确结束了这一级）
 * - `/workspace`   → `{ dir: '/', prefix: 'workspace' }`
 * - `C:\Users\dev` → `{ dir: 'C:\Users\', prefix: 'dev' }`
 * - `C:`           → `{ dir: '', prefix: 'C:' }`（没有分隔符，调用方据此放弃过滤回退）
 */
export function splitPathInput(value: string): PathInputSplit {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (index < 0) return { dir: '', prefix: value };
  if (index === value.length - 1) return { dir: value, prefix: '' };
  return { dir: value.slice(0, index + 1), prefix: value.slice(index + 1) };
}

/**
 * 目录显示路径统一以 `/` 结尾（根路径 `/` 本身已满足；Windows 风格的 `\` 结尾也认可）。
 *
 * 选择器的两条语义都建立在尾分隔符上：输入框展示的目录始终带 `/`（点击候选后
 * 自动补上，继续敲就是下一级）；预览把「末段无分隔符」当过滤词、有分隔符才进
 * 目录（见 `main.ts` 的 `previewPath`）。
 */
export function ensureTrailingSeparator(path: string): string {
  if (path.length === 0 || path.endsWith('/') || path.endsWith('\\')) return path;
  return `${path}/`;
}

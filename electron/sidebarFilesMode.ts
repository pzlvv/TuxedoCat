/**
 * 侧栏文件浏览器的三态模式（specs/041 FR-001；Electron 专属）。
 *
 * 三种模式互斥：目录树（默认）/ 文档视图（只看变更的 Markdown）/ 全部变更（所有类型）。
 * 三态判别联合是唯一真值表示——两个布尔能表达四种组合，其中三种是非法状态
 * （specs/041 被否决方案 1）。
 *
 * 刻意不 import electron：模式解析、localStorage 迁移与切换转移都是纯函数，渲染层
 * （`electron/sidebar/main.ts`）只做「读状态 → 调本模块 → 写回」，单测直接驱动。
 */

import type { ChangeScope } from './sidebarDocView.js';

/** 文件浏览器的三种模式（specs/041 FR-001） */
export type FilesMode = 'tree' | 'doc' | 'changes';

/** localStorage 里存的是「工作区 id → 模式」的 JSON 表 */
export type StoredModes = Record<string, FilesMode>;

/** 旧键存的是「工作区 id → 是否开启文档视图」的布尔表（specs/030 的形态） */
export type LegacyDocViewMap = Record<string, boolean>;

/**
 * 模式 → 取数范围。`'tree'` 不取数（目录树走懒加载），因此只在两态间映射。
 *
 * 与 `sidebarDocView.ts::pathspecFor` 同一个判别值：模式决定范围，范围决定 pathspec，
 * 三处不各写一份。
 */
export function scopeForMode(mode: FilesMode): ChangeScope | null {
  if (mode === 'tree') return null;
  return mode === 'doc' ? 'doc' : 'all';
}

/** 取数范围 → 模式（回包只带 rows，模式由请求侧记住；这个反向映射给回填用） */
export function modeForScope(scope: ChangeScope): FilesMode {
  return scope === 'doc' ? 'doc' : 'changes';
}

/**
 * 读出的存储值 → 模式表，兼容旧格式。
 *
 * - 新格式：值必须是 `'tree' | 'doc' | 'changes'` 之一，其余丢弃（存储被外部改坏时
 *   按「没有记录」处理，不猜一个模式出来）。
 * - 旧格式（生产环境升级路径）：布尔 `true` → `'doc'`、`false` → `'tree'`。
 *
 * 旧键读到了也**不主动删**：回退到旧版本时不至于丢状态。
 */
export function parseStoredModes(raw: string | null, legacy: string | null): StoredModes {
  const modes = parseModeTable(raw);
  if (Object.keys(modes).length > 0) return modes;
  return migrateLegacyDocView(legacy);
}

function parseModeTable(raw: string | null): StoredModes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const map: StoredModes = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === 'tree' || value === 'doc' || value === 'changes') map[id] = value;
  }
  return map;
}

/** 旧布尔表 → 新模式表（`false` 也显式写成 `'tree'`，与「缺失即默认」等价但更明确） */
function migrateLegacyDocView(raw: string | null): StoredModes {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const map: StoredModes = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'boolean') map[id] = value ? 'doc' : 'tree';
  }
  return map;
}

/**
 * 分段 switch 的显示顺序（与 `electron/sidebar/index.html` 里三段按钮的 DOM 顺序一致）：
 * 全部（目录树）/ 差异（全部变更）/ 文档（文档视图）。
 *
 * 方向键切换与单测都按这份顺序走，避免在渲染层再写一遍「上一段 / 下一段」的字面量。
 */
export const FILES_MODE_ORDER: readonly FilesMode[] = ['tree', 'changes', 'doc'];

/** 方向键在分段 switch 内的移动（左右环绕；`delta` 只取 ±1） */
export function stepFilesMode(current: FilesMode, delta: 1 | -1): FilesMode {
  const index = FILES_MODE_ORDER.indexOf(current);
  const next = (index + delta + FILES_MODE_ORDER.length) % FILES_MODE_ORDER.length;
  return FILES_MODE_ORDER[next] ?? current;
}

/** 空态文案（specs/041 FR-002：文案按 scope 分叉，不共用一个泛化的「没有内容」） */
export function emptyTextForMode(mode: FilesMode): string {
  return mode === 'changes' ? '没有变更的文件' : '没有变更的 Markdown 文档';
}

/**
 * 「不在 git 仓库内」的判别值（specs/041 FR-003 / AC-7）。
 *
 * 主进程在 `scope === 'all'` 且探测结果是 `'no'` 时把它当作 `error` 返回；渲染层按这个
 * 值给提示态而不是空列表。取值放这里而不是各处写字面量——它是 IPC 契约的一部分。
 */
export const NOT_A_GIT_WORKSPACE = 'not-a-git-workspace';

/**
 * 该模式是否需要 git 哨兵（specs/030 FR-003 / specs/041 FR-004）。
 *
 * 两种变更视图共用同一个哨兵：哨兵听的是 `.git` 与 `.git/refs/heads`，与「看哪些
 * 文件」无关。目录树不挂（没有依赖 git 的清单）。
 */
export function needsGitSentinel(mode: FilesMode): boolean {
  return mode !== 'tree';
}

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
 * 点按钮后的新模式（specs/041 AC-2）：点当前模式回到目录树，点另一模式直接切换。
 *
 * 三种模式的按钮语义一致——「按下去」表示「正在看它」，「再按一下」是退出到默认视图，
 * 而不是在另外两态之间轮转（用户点「文档视图」时想要的是文档视图，不是第三个模式）。
 */
export function toggleFilesMode(current: FilesMode, target: FilesMode): FilesMode {
  return current === target ? 'tree' : target;
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

/**
 * 该模式的变更清单要不要挂**磁盘** git 哨兵（specs/047 FR-003）。
 *
 * 两个条件缺一不可：模式依赖 git（不是目录树），且取数来源是磁盘。Overlay 对话的两个
 * 变更视图取的是 Core 视图里的 git 事实——视图的 HEAD 在 Core 私有挂载命名空间里，
 * 宿主侧 `fs.watch` 磁盘 `.git` 既看不到它、也不该在别处 commit 时替它重取。
 */
export function shouldWatchGitSentinel(mode: FilesMode, overlaySessionId: string | null): boolean {
  return needsGitSentinel(mode) && overlaySessionId === null;
}

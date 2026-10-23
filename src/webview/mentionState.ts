/**
 * `@` 工作区补全的纯函数（specs/023 FR-007）。
 *
 * 与 `InputArea` 解耦：区间判定、过滤与插入各一份实现，组件与单测共用
 * （与 `inputAreaState.ts` 同模式）。
 */

/** 候选：宿主下发的「除本工作区之外的已打开工作区」 */
export interface WorkspaceMentionItem {
  /** 工作区代理身份：`<机器名>:<工作区路径>` */
  id: string;
  /** 工作区路径（目标机器口径） */
  path: string;
  /** 展示名：路径最后一级目录名 */
  displayName: string;
}

export interface MentionRange {
  /** 光标是否位于 `@` 命令的区间内（含区间起点） */
  active: boolean;
  /** 区间内、光标之前的查询词 */
  query: string;
  /** 区间终点（不含）；未激活时为 0 */
  tokenEnd: number;
}

/**
 * `@` 命令区间。
 *
 * - 引号形态 `@"..."`：从 `@"` 起，到下一个 `"` 或输入末尾止；
 * - 非引号形态：从 `@` 起，到第一个空白（空格 / 制表 / 换行）或输入末尾止。
 *
 * 只认首字符开头的 `@`（与 `/` 补全同口径）。
 */
export function resolveMentionRange(value: string, caret: number): MentionRange {
  if (!value.startsWith('@')) {
    return { active: false, query: '', tokenEnd: 0 };
  }
  let tokenEnd: number;
  let queryStart: number;
  if (value.startsWith('@"')) {
    const closing = value.indexOf('"', 2);
    tokenEnd = closing === -1 ? value.length : closing + 1;
    queryStart = 2;
  } else {
    const whitespace = value.slice(1).search(/\s/);
    tokenEnd = whitespace === -1 ? value.length : 1 + whitespace;
    queryStart = 1;
  }
  const active = caret >= 1 && caret <= tokenEnd;
  const query = active ? value.slice(queryStart, Math.min(caret, tokenEnd)) : '';
  return { active, query, tokenEnd };
}

/** 过滤：身份 ID 命中优先于目录名命中；不区分大小写 */
export function filterWorkspaces(
  workspaces: readonly WorkspaceMentionItem[],
  query: string,
): WorkspaceMentionItem[] {
  const q = query.toLowerCase();
  const idMatches: WorkspaceMentionItem[] = [];
  const nameMatches: WorkspaceMentionItem[] = [];
  for (const workspace of workspaces) {
    if (workspace.id.toLowerCase().includes(q)) {
      idMatches.push(workspace);
    } else if (workspace.displayName.toLowerCase().includes(q)) {
      nameMatches.push(workspace);
    }
  }
  return [...idMatches, ...nameMatches];
}

/** 身份含空白时必须用引号形态（否则 `@` 区间会被第一个空白截断） */
export function mentionToken(identity: string): string {
  return /\s/.test(identity) ? `@"${identity}"` : `@${identity}`;
}

/**
 * 选中替换：替换 `@` 到光标之间的文本（引号形态替换到闭合引号），插入
 * `@<身份> ` 并保留其后原文；光标置于输入末尾（与 `/` 补全一致）。
 */
export function insertMention(
  value: string,
  caret: number,
  item: WorkspaceMentionItem,
  tokenEnd: number,
): { next: string; caret: number } {
  const end = value.startsWith('@"') ? tokenEnd : caret;
  const next = `${mentionToken(item.id)} ${value.slice(end)}`;
  return { next, caret: next.length };
}

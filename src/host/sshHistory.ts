/**
 * SSH 连接历史（宿主侧，纯函数；`docs/client-connection.md` 第 4.2 / 9 节）。
 *
 * 「打开远程工作区」窗口在 SSH 接入成功后把 host / 端口 / 用户 / 口令记入宿主本地状态
 * （`workspace-state.json` 的 `recentSshConnections`，**明文**、按最近连接在前排序）；
 * 再次打开窗口时，host 输入框聚焦即按关键字从历史里挑候选。
 *
 * 落盘 / 读盘由宿主实现负责，这里只放两份实现共用的推导逻辑：
 * 排序、去重键、候选择取（前缀匹配 > 非前缀匹配，其次按时间）与候选文案。
 */

/** 一条 SSH 连接历史：与表单字段一一对应，口令明文参与落盘与回填 */
export interface SshHistoryEntry {
  host: string;
  /** SSH 端口（1-65535） */
  port: number;
  user: string;
  password: string;
}

/** 历史最多保留的条数：候选一次最多显示 6 条，历史本身多留一些供关键字筛选 */
export const MAX_SSH_HISTORY = 20;

/** host 输入框聚焦时一次最多弹出的候选条数 */
export const SSH_SUGGESTION_LIMIT = 6;

/**
 * 历史条目的去重键：`user@host:port`（host 不分大小写）。
 * 同一台机器换个口令重连不新增条目，只把它顶到最前并更新口令。
 */
export function sshHistoryKey(entry: { user: string; host: string; port: number }): string {
  return `${entry.user}@${entry.host.toLowerCase()}:${entry.port}`;
}

/**
 * 解析落盘的历史数组：形状不合法的项整项丢弃，不猜、不补默认值
 * （与 `workspace-state.json` 其余字段的读取口径一致）。
 */
export function parseSshHistory(raw: unknown): SshHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SshHistoryEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const user = typeof record.user === 'string' ? record.user.trim() : '';
    const password = typeof record.password === 'string' ? record.password : '';
    const port = typeof record.port === 'number' ? record.port : Number.NaN;
    if (host.length === 0 || user.length === 0 || password.length === 0) continue;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    entries.push({ host, port, user, password });
  }
  return entries.slice(0, MAX_SSH_HISTORY);
}

/** 连接成功后写入历史：同一去重键只保留最新一条并顶到最前，超出上限截断 */
export function rememberSshEntry(list: readonly SshHistoryEntry[], entry: SshHistoryEntry): SshHistoryEntry[] {
  const key = sshHistoryKey(entry);
  return [entry, ...list.filter((candidate) => sshHistoryKey(candidate) !== key)].slice(0, MAX_SSH_HISTORY);
}

/** 删除一条历史（候选行的删除按钮）；按去重键匹配 */
export function removeSshEntry(list: readonly SshHistoryEntry[], key: string): SshHistoryEntry[] {
  return list.filter((candidate) => sshHistoryKey(candidate) !== key);
}

/** 候选文案：`<user>@<host>`，端口非 22 时追加 `:<port>` */
export function formatSshEntry(entry: SshHistoryEntry): string {
  return entry.port === 22
    ? `${entry.user}@${entry.host}`
    : `${entry.user}@${entry.host}:${entry.port}`;
}

/**
 * 按关键字挑候选：先「匹配方式」后「时间」两级排序——
 * 前缀匹配排在非前缀匹配（子串）之前，同级内按列表顺序（最近连接在前）。
 *
 * 关键字同时对着三种文本匹配：`user@host`、`user@host:port` 与裸 `host`——
 * 既支持敲用户名、也支持敲主机名或端口。空关键字视为「不过滤」，直接取最近的几条。
 */
export function matchSshEntries(
  list: readonly SshHistoryEntry[],
  keyword: string,
  limit: number = SSH_SUGGESTION_LIMIT,
): SshHistoryEntry[] {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return list.slice(0, limit);
  const ranked: Array<{ entry: SshHistoryEntry; prefix: boolean }> = [];
  for (const entry of list) {
    const targets = [
      `${entry.user}@${entry.host}`.toLowerCase(),
      `${entry.user}@${entry.host}:${entry.port}`.toLowerCase(),
      entry.host.toLowerCase(),
    ];
    if (targets.some((target) => target.startsWith(needle))) {
      ranked.push({ entry, prefix: true });
    } else if (targets.some((target) => target.includes(needle))) {
      ranked.push({ entry, prefix: false });
    }
  }
  // sort 稳定：非前缀在前缀之后，同级保持列表顺序（即连接时间序）
  return ranked
    .sort((a, b) => Number(a.prefix ? 0 : 1) - Number(b.prefix ? 0 : 1))
    .slice(0, limit)
    .map((item) => item.entry);
}

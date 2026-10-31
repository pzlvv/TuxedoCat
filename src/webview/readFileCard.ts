/**
 * Read 工具卡片的路径与行号派生（与 `mentionState.ts` / `inputAreaState.ts` 同模式：
 * 组件只渲染结果，派生是纯函数，组件与单测共用一份）。
 *
 * 两处派生都只服务「点击卡片 → 宿主 openFile」这一条链路，因此不在 JSX 里另写一遍
 * 换算（`docs/architecture/principles.md` 的「契约只写现状，派生字段从根字段推导」：
 * 派生逻辑只有一份纯函数）。
 *
 * 本模块零依赖：webview bundle 直接 import，单测也直接 import（webview 目录只在这一处
 * 被测试引用，不引入任何 DOM / Node 依赖）。
 */

/** Read 卡片的行区间（1-based、含端点；对应 `UIHost.openFile` 的 `LineSelection`） */
export interface ReadLineSelection {
  start: number;
  end: number;
}

/**
 * WSL 路径 `/mnt/<盘符>/...` → Windows 路径 `<盘符>:\...`。
 *
 * 与 Core 侧 `core-rs/src/tools.rs` 的 `wsl_mnt_path` 同口径：`/mnt/` 占 5 个字符，
 * 盘符在下标 5，路径正文从盘符后的 `/` 起（`/mnt/d/a/b` → `D:\a\b`）。
 * `/mnt/d` 与 `/mnt/d/` 都得到 `D:\`。
 *
 * 非 `/mnt/<盘符>` 形态原样返回：Linux / macOS 会话的绝对路径、已经是 Windows 形态
 * 的路径都不该被改写。
 */
export function wslToWindowsPath(p: string): string {
  const match = /^\/mnt\/([a-z])(\/.*)?$/i.exec(p);
  if (!match) return p;
  const drive = match[1].toUpperCase();
  const rest = (match[2] ?? '').replace(/\//g, '\\');
  return `${drive}:${rest || '\\'}`;
}

/**
 * `offset` / `limit` → 1-based 行区间。
 *
 * Read 的 `offset` 是 **1-based 起始行号**（`core-rs/src/tools.rs` 的 Read schema：
 * `The 1-based line number to start reading from (default: 1). 0 is accepted and
 * treated as 1`），`limit` 是行数；`selectedLines` 同样是 1-based 含端点，因此换算
 * 不做 `+1` 偏移。`offset < 1` 按 1 处理，`limit` 非正数时区间只覆盖起始行。
 *
 * 入参是已归一化的数值（`null` = 该参数缺失）：缺 `offset` 的调用方先自己判空，
 * 不把「没有 offset」表达成这里的可选参数（`docs/architecture/principles.md` 的
 * 「不让接口 / 参数可选」）。
 */
export function resolveReadSelection(
  offset: number,
  limit: number | null,
): ReadLineSelection {
  const start = Number.isFinite(offset) ? Math.max(1, Math.floor(offset)) : 1;
  const count = limit !== null && Number.isFinite(limit) ? Math.floor(limit) : 0;
  return { start, end: count > 0 ? start + count - 1 : start };
}

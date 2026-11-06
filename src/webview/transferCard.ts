/**
 * `Transfer` 工具卡片的派生逻辑（specs/042）。
 *
 * 卡片所需信息只有两个来源：工具入参（两端身份）与工具结果文本（统计行 +
 * 路径明细行）。本模块把它们解析成渲染模型，组件只渲染——解析口径只有一处，
 * 重放（历史会话重新打开）与实时会话走同一份代码，因此卡片形状天然一致
 * （specs/042 FR-005）。
 *
 * 结果文本格式（`core-rs/src/tools.rs` 的 `run_transfer` 生成，夹具
 * `core-rs/fixtures/transferResult.txt` 锁定）：
 *
 * ```
 * ✓ Transferred 3 files (4.0 KB) from `m1:/ws1` to `m2:/ws2` (skipped 2 symlinks)
 *   - src/a.txt
 *   - src/sub/b.txt
 *   - src/sub/deep/c.txt
 * ```
 *
 * 本模块零依赖、不产出用户可见文案（`null` 表示缺省端，由组件取 i18n 键渲染）：
 * webview bundle 直接 import，单测也直接 import（与 `persistedOutputParse.ts` 同模式）。
 */

/** 路径明细的上限：与 `core-rs/src/tools.rs` 的 `TRANSFER_PATH_DETAIL_LIMIT` 同值 */
export const TRANSFER_PATH_LIMIT = 20;

/** 长路径按中点截断时保留的最大字符数（含省略号） */
const PATH_DISPLAY_WIDTH = 56;

/** 统计行：`✓ Transferred {n} files ({size}) from `{src}` to `{dst}`{skipped}` */
const STATS_PATTERN =
  /^✓ Transferred (\d+) files \((.+)\) from `(.+)` to `(.+)`(?: \(skipped (\d+) symlinks\))?$/;

/** 路径明细行：两空格 + `- ` + 相对路径 */
const PATH_LINE_PATTERN = /^\s{2}- (.+)$/;

/** 折叠行：`  ... and {M} more files` */
const MORE_LINE_PATTERN = /^\s{2}\.\.\. and (\d+) more files$/;

export interface TransferStats {
  files: number;
  /** 原样保留工具给的形态（`4.0 KB`），不重算 */
  sizeText: string;
  /** 跳过的符号链接数；0 = 不渲染该段 */
  skipped: number;
}

export interface TransferCardModel {
  /** 统计行解析不出时为 null（失败态 / 旧版本结果）：卡片退到「身份行 + 原文」 */
  stats: TransferStats | null;
  /** 源端身份；`null` = 缺省端（发起会话所属工作区，组件显示 i18n 文案） */
  source: string | null;
  /** 目标端身份；语义同上 */
  dest: string | null;
  /** 展示用清单（已按 `TRANSFER_PATH_LIMIT` 截断） */
  paths: string[];
  /** 「还有 M 个文件」里的 M；0 = 不渲染该行 */
  moreCount: number;
  failed: boolean;
}

/**
 * 按中点截断长路径（保留首尾），完整值由调用方放进 `title`（specs/042 FR-001 第 3 段）。
 */
export function truncateMiddle(text: string, width = PATH_DISPLAY_WIDTH): string {
  if (text.length <= width) return text;
  const keep = Math.floor((width - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

/**
 * 从入参读一端身份，区分「键缺失」与「键为空」：
 *
 * - 键缺失（重放时 `toolArgs` 被裁剪）→ `undefined`，交给结果文本兜底；
 * - 空串 / `null` → `null`，即缺省端（specs/042 FR-001：显示「当前工作区」）。
 */
function readEnd(args: Record<string, unknown>, key: string): string | null | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

/**
 * 构造成员模型。`output` 是工具结果原文（可能为空 / 可能被裁剪成信封），
 * `status` 是卡片的执行状态（`fail` 时展示错误原文，不解析统计）。
 *
 * `unwrapPersisted` 由调用方注入（webview 用 `parsePersistedOutput` 的 preview）：
 * 4K 上限裁剪后的信封只展示预览，不额外请求完整输出（specs/042 边界第 1 条）。
 */
export function buildTransferCardModel(
  args: Record<string, unknown>,
  output: string | undefined,
  status: 'normal' | 'running' | 'success' | 'fail',
  unwrapPersisted?: (text: string) => string | null,
): TransferCardModel {
  const failed = status === 'fail';
  let text = output ?? '';
  if (text.includes('<persisted-output>') && unwrapPersisted) {
    text = unwrapPersisted(text) ?? text;
  }
  const lines = text.split(/\r?\n/);
  // 统计行是结果的第一行；被信封包裹时预览正文同样以它开头
  const statsMatch = STATS_PATTERN.exec(lines[0] ?? '');
  const argsSource = readEnd(args, 'sourceTarget');
  const argsDest = readEnd(args, 'destTarget');

  if (!statsMatch) {
    // 解析失败（失败态 / 旧结果）：不猜统计，只回落身份行 + 工具原文
    // （specs/042-transfer-tool-card/plan.md 的「派生纯函数」一节）
    return {
      stats: null,
      source: argsSource === undefined ? null : argsSource,
      dest: argsDest === undefined ? null : argsDest,
      paths: [],
      moreCount: 0,
      failed,
    };
  }

  // 结果文本里的两端只作兜底：入参缺失时（重放裁剪）才用，不额外造事实
  const source = argsSource === undefined ? (statsMatch[3] ?? null) : argsSource;
  const dest = argsDest === undefined ? (statsMatch[4] ?? null) : argsDest;

  const paths: string[] = [];
  let moreCount = 0;
  for (const line of lines.slice(1)) {
    const more = MORE_LINE_PATTERN.exec(line);
    if (more) {
      moreCount = Number(more[1]);
      break;
    }
    const path = PATH_LINE_PATTERN.exec(line);
    if (path) paths.push(path[1] ?? '');
  }
  const shown = paths.slice(0, TRANSFER_PATH_LIMIT);
  // 工具侧折叠掉的尾部与卡片侧截断叠加：总数以能读到的为准，不额外请求
  const truncatedByCard = paths.length - shown.length;

  return {
    stats: {
      files: Number(statsMatch[1]),
      sizeText: statsMatch[2] ?? '',
      skipped: statsMatch[5] === undefined ? 0 : Number(statsMatch[5]),
    },
    source,
    dest,
    paths: shown,
    moreCount: moreCount + truncatedByCard,
    failed,
  };
}

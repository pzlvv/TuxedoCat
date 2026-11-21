/**
 * 已执行时长的格式化（specs/054 FR-005）：abort 悬停明细里后台任务与子代理行尾的读数。
 *
 * 纯函数、零 import：单位文案由调用方从 i18n 取（本模块不进 webview 的 i18n 加载链，
 * 与 `src/host/abortButtonState.ts` / `inputAreaState.ts` 同款的「一份实现 + 注入文案」
 * 先例），因此 node 单测可直接 import 而不需要 `window`。
 *
 * 口径（docs/features/abort-button.md FR-004）：
 * - 从「天」到「秒」逐级拼接，数值为零的单位连同其单位一起省略；
 * - 全部为零（含时钟偏差钳零）显示「0秒」——0 本身不省略；
 * - 只看整秒（向下取整），不显示毫秒。
 */

/** 四个时间单位的文案注入点（zh：天 / 小时 / 分 / 秒；en：d / h / m / s） */
export interface ElapsedTimeLabels {
  day: string;
  hour: string;
  minute: string;
  second: string;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * 毫秒 → 「1天2小时3分4秒」形态的读数。
 *
 * 负数（开始时刻晚于本机当前时刻的时钟偏差）钳到 0，不出现负值也不抛错。
 */
export function formatElapsedTime(durationMs: number, labels: ElapsedTimeLabels): string {
  // NaN / 非有限值按 0 处理：调用方传的是 `now - startedAt`，异常值不该把浮层渲染炸掉
  const safeMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const totalSeconds = Math.floor(safeMs / MS_PER_SECOND);
  const days = Math.floor(totalSeconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY));
  const hours = Math.floor(totalSeconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) % HOURS_PER_DAY;
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}${labels.day}`);
  if (hours > 0) parts.push(`${hours}${labels.hour}`);
  if (minutes > 0) parts.push(`${minutes}${labels.minute}`);
  // 秒是最后一个单位：前面已有非零单位时，零秒省略；全零时仍显示「0秒」
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}${labels.second}`);
  return parts.join('');
}

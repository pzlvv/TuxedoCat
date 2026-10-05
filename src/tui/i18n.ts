/**
 * TUI 文案（docs/tui.md 第 4 节）。
 *
 * - TUI 自有界面文本（菜单、覆盖层提示、键位说明）复用宿主层 `tt()`（zh/en 二选一，
 *   语言经 `bootstrapCore` 的 `primeHostLocale` 在启动期收敛，与 Electron 菜单同一套）；
 * - core `notice` 键的翻译复用 webview 的字典**数据文件**（`zh.ts` / `en.ts` 是纯数据），
 *   不引入 `src/webview/i18n/index.ts`（它读 `window.__uiLocale`，是浏览器模块）。
 */

import { getHostLocale, tt } from '../host/i18n.js';
import { zhDict } from '../webview/i18n/zh.js';
import { enDict } from '../webview/i18n/en.js';

export { tt };

/**
 * core notice 键 → 当前语言文本；键缺失回显键本身（与 webview 的 t() 同口径，
 * 见 `docs/core-ui-separation.md` 第 4.9 节）。
 */
export function noticeText(key: string, params: Record<string, string | number>): string {
  const dict = getHostLocale() === 'zh' ? zhDict : enDict;
  const template = dict[key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

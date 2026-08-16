/**
 * Lightweight i18n for the webview.
 *
 * Language is decided by three sources:
 *   - the VS Code UI language, injected by the extension as `window.__vscodeLocale`
 *     (e.g. "zh-cn", "en", "zh-tw", ...);
 *   - the OS system locale, injected by the extension as `window.__systemLocale`;
 *   - the browser/webview language (`navigator.language`).
 * If any of these starts with "zh", Chinese is used; otherwise English.
 *
 * Resources live in `./zh.ts` and `./en.ts`. The `t()` helper looks up a key in
 * the active dictionary and (optionally) substitutes `{placeholders}`.
 */

import { zhDict } from './zh';
import { enDict } from './en';

export type Locale = 'zh' | 'en';
/** 用户可选的界面语言：auto 表示跟随 VS Code / 系统 / 浏览器语言 */
export type UiLanguage = 'auto' | 'zh' | 'en';
export type Dict = Record<string, string>;

/** True when a locale string refers to Chinese (e.g. "zh-cn", "zh-tw"). */
function isChineseLocale(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh');
}

/** 初始 UI 语言：优先读取宿主注入的 __uiLocale（来自 settings.json），否则 auto */
function readInitialUiLanguage(): UiLanguage {
  const v = (window as any).__uiLocale;
  return v === 'zh' || v === 'en' || v === 'auto' ? v : 'auto';
}

/** 当前用户显式选择的界面语言（模块内缓存，setUiLanguage 后立即生效） */
let uiLanguage: UiLanguage = readInitialUiLanguage();

/** 获取用户选择的界面语言（'auto' 表示自动跟随） */
export function getUiLanguage(): UiLanguage {
  return uiLanguage;
}

/**
 * 设置界面语言并同步到 window（供后续诊断日志读取）。
 * @returns 有效 locale 是否发生变化（true 时调用方应触发重渲染以刷新所有文案）
 */
export function setUiLanguage(lang: UiLanguage): boolean {
  const prev = getLocale();
  uiLanguage = lang;
  (window as any).__uiLocale = lang;
  return getLocale() !== prev;
}

/** Locale sources considered when resolving the UI language. */
function localeSources(): {
  vscodeLocale: unknown;
  systemLocale: unknown;
  navigatorLanguage: unknown;
} {
  return {
    vscodeLocale: (window as any).__vscodeLocale,
    systemLocale: (window as any).__systemLocale,
    navigatorLanguage: typeof navigator !== 'undefined' ? navigator.language : undefined,
  };
}

/**
 * Read the locale. If the user explicitly chose zh/en in settings, that choice
 * wins. Otherwise the VS Code UI language (injected by the extension), the OS
 * system locale (injected by the extension) and the browser/webview language
 * are all considered: if any one is Chinese, Chinese is used; otherwise English.
 */
export function getLocale(): Locale {
  if (uiLanguage === 'zh') return 'zh';
  if (uiLanguage === 'en') return 'en';
  const { vscodeLocale, systemLocale, navigatorLanguage } = localeSources();
  if (isChineseLocale(vscodeLocale) || isChineseLocale(systemLocale) || isChineseLocale(navigatorLanguage)) {
    return 'zh';
  }
  return 'en';
}

/** Access the currently active dictionary. */
export function getDict(): Dict {
  return getLocale() === 'zh' ? zhDict : enDict;
}

/** Fallback dictionary used when a key is missing from the active one. */
const FALLBACK_DICT: Dict = enDict;

/**
 * Look up a translation by key.
 *
 * Placeholders like `{name}` in the resource are replaced with the values
 * given in `params`. Missing keys fall back to English, then to the key itself.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = getDict();
  let value = dict[key];
  if (value === undefined) {
    value = FALLBACK_DICT[key];
  }
  if (value === undefined) {
    return key;
  }
  if (params) {
    return value.replace(/\{(\w+)\}/g, (match, name: string) => {
      const replacement = params[name];
      return replacement !== undefined ? String(replacement) : match;
    });
  }
  return value;
}

/** Convenience: a `t` bound to the currently active locale (for non-React code). */
export const translate = t;

/**
 * Resolve a conversation title for display.
 *
 * Convention: the extension side sends an empty string to denote an untitled
 * conversation (extension doesn't know the UI language). Here we translate the
 * empty string to the localized "Untitled" text; otherwise the title is kept.
 */
export function resolveTitle(title: string | undefined | null): string {
  if (title && title.trim()) {
    return title;
  }
  return t('app.untitled');
}

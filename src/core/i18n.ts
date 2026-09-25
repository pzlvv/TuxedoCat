/**
 * Lightweight i18n for the core layer.
 *
 * The core layer is shared by multiple hosts (VS Code extension / Electron), so
 * it cannot depend on `vscode.env.language` directly. Instead the host sets the
 * locale once at startup via `setCoreLocale()`:
 *   - VS Code extension: `setCoreLocale(vscode.env.language)`
 *   - Electron: `setCoreLocale(app.getLocale())`
 *
 * `tt()` picks between a Chinese and an English string based on the active
 * core locale. Non-UI strings (logs, prompts that must not be localized)
 * should not use this helper.
 */

import { execSync } from 'child_process';

let coreLocale: 'zh' | 'en' = 'en';
let coreLocaleSource: string = '';

export type CoreLocale = 'zh' | 'en';

/**
 * 语言变化订阅者（宿主据此刷新已经建好的本地化 UI，如 Electron 的原生菜单）。
 * 只在**有效语言**真正变化时通知，避免同值重复触发。
 */
const localeListeners = new Set<() => void>();

/** 订阅核心语言变化；返回取消订阅函数。 */
export function onCoreLocaleChanged(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

function notifyCoreLocaleChanged(): void {
  for (const listener of [...localeListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者抛错不影响其它订阅者
    }
  }
}

/** 更新有效语言并在变化时通知订阅者 */
function applyCoreLocale(next: 'zh' | 'en'): void {
  if (next === coreLocale) return;
  coreLocale = next;
  notifyCoreLocaleChanged();
}

function refreshCoreLocale(): void {
  const systemLocale = getSystemLocale();
  applyCoreLocale(
    (typeof coreLocaleSource === 'string' && coreLocaleSource.toLowerCase().startsWith('zh')) ||
    (systemLocale !== '' && systemLocale.toLowerCase().startsWith('zh'))
      ? 'zh'
      : 'en',
  );
}

/**
 * Set the active core locale. Any string starting with "zh" is treated as
 * Chinese. The OS system language (probed once at startup and cached) is also
 * considered: if either the given locale or the system locale is Chinese,
 * Chinese is used.
 */
export function setCoreLocale(locale: string | undefined | null): void {
  coreLocaleSource = locale || '';
  refreshCoreLocale();
}

/**
 * Set the active core locale from the user's UI language setting.
 * `'zh'` / `'en'` override auto-detection; `'auto'` falls back to the
 * locale passed to `setCoreLocale()` plus the OS system language.
 */
export function setCoreUiLanguage(lang: 'auto' | 'zh' | 'en'): void {
  if (lang === 'zh') {
    applyCoreLocale('zh');
    return;
  }
  if (lang === 'en') {
    applyCoreLocale('en');
    return;
  }
  refreshCoreLocale();
}

/** Get the active core locale. */
export function getCoreLocale(): CoreLocale {
  return coreLocale;
}

/** Pick the Chinese or English text based on the active core locale. */
export function tt(zh: string, en: string): string {
  return coreLocale === 'zh' ? zh : en;
}

let _cachedSystemLocale: string | undefined;

/**
 * Get the operating system's system language (locale), e.g. "zh-CN", "en-US".
 *
 * The result is probed once and cached for the lifetime of the process, so this
 * can be called any time (e.g. when opening a webview) without extra cost.
 *
 * Note: Node's `Intl.DateTimeFormat().resolvedOptions().locale` usually returns
 * "en-US" on Windows (ICU default) and does not reflect the OS display language,
 * so on Windows we query PowerShell's `Get-UICulture` (UI language) and
 * `Get-Culture` (regional format); if either is Chinese, a Chinese locale is
 * returned first.
 */
export function getSystemLocale(): string {
  if (_cachedSystemLocale !== undefined) {
    return _cachedSystemLocale;
  }

  let locale = '';

  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'powershell -NoProfile -NonInteractive -Command "Write-Output (Get-UICulture).Name; Write-Output (Get-Culture).Name"',
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const lines = out
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      // UI language or regional format being Chinese → prefer a Chinese locale
      locale = lines.find((line) => line.toLowerCase().startsWith('zh')) || lines[0] || '';
    } catch {
      // ignore, fall through to Intl/env
    }
  }

  if (!locale) {
    try {
      locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
    } catch {
      // ignore, fall through to env vars
    }
  }

  if (!locale) {
    locale = process.env.LANG || process.env.LC_ALL || '';
  }

  _cachedSystemLocale = locale;
  return locale;
}

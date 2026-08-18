/**
 * Lightweight i18n for the core layer.
 *
 * The core layer is used by both the VS Code extension and the CLI, so it
 * cannot depend on `vscode.env.language` directly. Instead the host sets the
 * locale once at startup via `setCoreLocale()`:
 *   - VS Code extension: `setCoreLocale(vscode.env.language)`
 *   - CLI: `setCoreLocale(process.env.LANG || process.env.LC_ALL || '')`
 *
 * `tt()` picks between a Chinese and an English string based on the active
 * core locale. Non-UI strings (logs, prompts that must not be localized)
 * should not use this helper.
 */

import { execSync } from 'child_process';

let coreLocale: 'zh' | 'en' = 'en';
let coreLocaleSource: string = '';

export type CoreLocale = 'zh' | 'en';

function refreshCoreLocale(): void {
  const systemLocale = getSystemLocale();
  coreLocale =
    (typeof coreLocaleSource === 'string' && coreLocaleSource.toLowerCase().startsWith('zh')) ||
    (systemLocale !== '' && systemLocale.toLowerCase().startsWith('zh'))
      ? 'zh'
      : 'en';
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
    coreLocale = 'zh';
    return;
  }
  if (lang === 'en') {
    coreLocale = 'en';
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

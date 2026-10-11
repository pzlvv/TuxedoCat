/**
 * Lightweight i18n for the host layer（`docs/architecture/core-ui-separation.md` 第 4.8 节）。
 *
 * i18n 归 UI：翻译表、语言选择与渲染都在 UI 侧。本模块只服务**宿主进程内的原生 UI**
 * （Electron 原生菜单、Spin 设计器页面等）；Core 不感知语言，面向界面的文本以
 * 「键 + 参数」表达（`src/core/coreText.ts`），由 webview 的翻译表渲染。
 *
 * 宿主被多个入口共用（VS Code 扩展 / Electron），不能直接依赖 `vscode.env.language`；
 * 宿主在启动时通过一次调用把 locale 交给本模块：
 *   - VS Code extension: `setHostLocale(vscode.env.language)`
 *   - Electron: `setHostLocale(app.getLocale())`
 *
 * `tt()` 按当前宿主语言在中文 / 英文之间二选一。非 UI 文案（日志、落盘文本、
 * 不允许本地化的提示词）不走这里。
 */

import { execSync } from 'child_process';

let hostLocale: 'zh' | 'en' = 'en';
let hostLocaleSource: string = '';

export type HostLocale = 'zh' | 'en';

/**
 * 语言变化订阅者（宿主据此刷新已经建好的本地化 UI，如 Electron 的原生菜单）。
 * 只在**有效语言**真正变化时通知，避免同值重复触发。
 */
const localeListeners = new Set<() => void>();

/** 订阅宿主语言变化；返回取消订阅函数。 */
export function onHostLocaleChanged(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

function notifyHostLocaleChanged(): void {
  for (const listener of [...localeListeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者抛错不影响其它订阅者
    }
  }
}

/** 更新有效语言并在变化时通知订阅者 */
function applyHostLocale(next: 'zh' | 'en'): void {
  if (next === hostLocale) return;
  hostLocale = next;
  notifyHostLocaleChanged();
}

function refreshHostLocale(): void {
  const systemLocale = getSystemLocale();
  applyHostLocale(
    (typeof hostLocaleSource === 'string' && hostLocaleSource.toLowerCase().startsWith('zh')) ||
    (systemLocale !== '' && systemLocale.toLowerCase().startsWith('zh'))
      ? 'zh'
      : 'en',
  );
}

/**
 * Set the active host locale. Any string starting with "zh" is treated as
 * Chinese. The OS system language (probed once at startup and cached) is also
 * considered: if either the given locale or the system locale is Chinese,
 * Chinese is used.
 */
export function setHostLocale(locale: string | undefined | null): void {
  hostLocaleSource = locale || '';
  refreshHostLocale();
}

/**
 * Set the active host locale from the user's UI language setting.
 * `'zh'` / `'en'` override auto-detection; `'auto'` falls back to the
 * locale passed to `setHostLocale()` plus the OS system language.
 */
export function setHostUiLanguage(lang: 'auto' | 'zh' | 'en'): void {
  if (lang === 'zh') {
    applyHostLocale('zh');
    return;
  }
  if (lang === 'en') {
    applyHostLocale('en');
    return;
  }
  refreshHostLocale();
}

/** Get the active host locale. */
export function getHostLocale(): HostLocale {
  return hostLocale;
}

/** Pick the Chinese or English text based on the active host locale. */
export function tt(zh: string, en: string): string {
  return hostLocale === 'zh' ? zh : en;
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

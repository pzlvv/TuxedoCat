/**
 * 偏好设置窗口的 HTML 生成（`electron/preferenceDialogHtml.ts`）。
 *
 * 锁住三类结构事实（页面脚本不在这里执行，只校验生成结果）：
 * - 三块偏好都在：主题单选（跟随系统 / 浅色 / 深色）、提示音开关 + 音量条、唤醒快捷键字段；
 * - 音量条默认隐藏（勾选提示音后由状态推入才显示）；
 * - 音量只在「松手」（change）时上报——拖动过程中只改数值显示，避免每帧试听；
 * - 配色走 `prefers-color-scheme`，窗口内切换主题后自己跟着变。
 *
 * 运行方式：npm run test:all -- preferenceDialog
 */

import { createChecker, runTests } from './helpers/harness';
import { getPreferenceDialogHtml } from '../../electron/preferenceDialogHtml';

runTests('preferenceDialog', () => {
  const { check, finish } = createChecker();
  const html = getPreferenceDialogHtml({ locale: 'zh' });

  // ── 主题单选 ──
  for (const mode of ['system', 'light', 'dark']) {
    check(`主题单选含 ${mode}`, html.includes(`name="theme" value="${mode}"`));
  }

  // ── 提示音开关与音量条 ──
  check('有提示音开关', html.includes('id="sound-enabled"'));
  check('有音量滑条', html.includes('id="volume"') && html.includes('type="range"'));
  // 音量条默认隐藏：勾选提示音后由主进程推来的状态把 hidden 去掉
  check('音量条默认隐藏（hidden）', /id="volume-row"[^>]*hidden/.test(html));

  // ── 音量只在松手时上报 ──
  check('拖动中只改数值显示（input 监听）', html.includes("volume.addEventListener('input'"));
  check(
    '松手（change）才上报音量并触发试听',
    html.includes("volume.addEventListener('change'")
      && html.includes('setSoundVolume'),
  );

  // ── 快捷键录制入口 ──
  check('快捷键字段点击后开始录制', html.includes("shortcutField.addEventListener('click'")
    && html.includes('captureShortcut'));

  // ── 配色跟随主题 ──
  check('配色走 prefers-color-scheme（窗口内切主题即时生效）', html.includes('prefers-color-scheme: dark'));

  // ── 本地化 ──
  const en = getPreferenceDialogHtml({ locale: 'en' });
  check('中文界面用中文标题', html.includes('偏好设置'));
  check('英文界面用英文标题', en.includes('Preferences') && !en.includes('偏好设置'));

  // 状态渲染：音量百分比与开关都来自状态，页面不持有事实默认值
  check('页面订阅主进程状态', html.includes('preferenceAPI.onState'));
  check('页面初次加载主动取状态', html.includes('preferenceAPI.getState'));

  finish();
});

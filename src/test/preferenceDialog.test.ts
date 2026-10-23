/**
 * 偏好设置窗口的 HTML 生成（`electron/preferenceDialogHtml.ts`）。
 *
 * 锁住三类结构事实（页面脚本不在这里执行，只校验生成结果）：
 * - 三块偏好都在：主题单选（跟随系统 / 浅色 / 深色）、提示音开关 + 音量条、
 *   快捷键三行（唤醒 / 下一标签 / 上一标签，specs/021）；
 * - 音量条默认隐藏（勾选提示音后由状态推入才显示）；
 * - 音量只在「松手」（change）时上报——拖动过程中只改数值显示，避免每帧试听；
 * - 快捷键行带 data-row 标识、录制上报带行参数（主进程按行路由与冲突判定）；
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

  // ── 快捷键三行（specs/021）：每行带行标识，点击上报行参数 ──
  for (const row of ['wake', 'nextTab', 'prevTab']) {
    check(`快捷键行 ${row} 存在且带 data-row`, html.includes(`data-row="${row}"`));
  }
  check('快捷键行点击后按行开始录制', html.includes("captureShortcut(btn.getAttribute('data-row'))"));
  check('录制中的行按 capturing 渲染提示文案', html.includes('state.capturing === row'));
  check('行显示值来自状态、按行拼接取字段（页面不持事实默认值）',
    html.includes('state[row + \'ShortcutDisplay\']'));

  // ── 配色跟随主题 ──
  check('配色走 prefers-color-scheme（窗口内切主题即时生效）', html.includes('prefers-color-scheme: dark'));

  // ── 本地化 ──
  const en = getPreferenceDialogHtml({ locale: 'en' });
  check('中文界面用中文标题', html.includes('偏好设置'));
  check('英文界面用英文标题', en.includes('Preferences') && !en.includes('偏好设置'));
  check('中文三行标签', html.includes('下一标签') && html.includes('上一标签') && !html.includes('Next Workspace Tab'));
  check('英文三行标签', en.includes('Next Workspace Tab') && en.includes('Previous Workspace Tab'));

  // 状态渲染：音量百分比与开关都来自状态，页面不持有事实默认值
  check('页面订阅主进程状态', html.includes('preferenceAPI.onState'));
  check('页面初次加载主动取状态', html.includes('preferenceAPI.getState'));

  finish();
});

/**
 * 单测：终端 `Ctrl+/` 补映射（`electron/terminal/ctrlSlashByte.ts`，docs/hosts/electron-multi-workspace.md 第 14.4 节）。
 *
 * 锁四件事（specs/defects/terminal-ctrl-slash-dropped.md 的 RT-3）：
 * - `Ctrl+/` → `^_`（0x1F）：xterm 的映射表没有斜杠键，不补就没字节；
 * - 只认用户打出的 `/`，不认物理 `code`——德语布局上 `/` 是 `Shift+7`，按 `code` 会漏；
 * - `Ctrl+Shift+/`（`key` 为 `?`）、无 `Ctrl`、带 `Alt` / `Meta` 一律不代发，交回 xterm；
 * - `keyup` / 非 keydown 不代发，避免一次按键写两遍。
 *
 * 运行方式：npm run test:unit -- terminal-key-fallback
 */

import { CTRL_SLASH_BYTE, ctrlSlashByte } from '../../electron/terminal/ctrlSlashByte';
import { createChecker, runTests } from './helpers/harness';

/** 与真实 keydown 同形的输入（未列出的字段取 false） */
function keydown(overrides: Partial<Parameters<typeof ctrlSlashByte>[0]> = {}): Parameters<typeof ctrlSlashByte>[0] {
  return {
    type: 'keydown',
    key: '/',
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

runTests('terminalCtrlSlash', () => {
  const { check, finish } = createChecker();

  // ---------- 目标行为：Ctrl+/ 发 ^_ ----------
  check('Ctrl+/ 发 ^_（0x1F）', ctrlSlashByte(keydown()) === '\u001f');
  check('^_ 与 Ctrl+Shift+- / Ctrl+7 是同一字节', CTRL_SLASH_BYTE === '\u001f');
  check('德语布局 Shift+7 打出 / 同样发 ^_', ctrlSlashByte(keydown({ shiftKey: true })) === '\u001f');

  // ---------- 不该代发：交回 xterm ----------
  check('Ctrl+Shift+/ 的 key 是 ? 不代发', ctrlSlashByte(keydown({ key: '?', shiftKey: true })) === null);
  check('无 Ctrl 不代发', ctrlSlashByte(keydown({ ctrlKey: false })) === null);
  check('Ctrl+Alt+/ 不代发（Alt 前缀归 xterm）', ctrlSlashByte(keydown({ altKey: true })) === null);
  check('Cmd+/ 不代发（Cmd 归宿主快捷键）', ctrlSlashByte(keydown({ metaKey: true })) === null);
  check('keyup 不代发', ctrlSlashByte(keydown({ type: 'keyup' })) === null);
  check('keypress 不代发', ctrlSlashByte(keydown({ type: 'keypress' })) === null);
  check('其它键不代发', ctrlSlashByte(keydown({ key: '-' })) === null && ctrlSlashByte(keydown({ key: 'a' })) === null);

  finish();
});

/**
 * 终端控制键补映射（docs/hosts/electron-multi-workspace.md 第 14.4 节）。
 *
 * 为什么需要它：`@xterm/xterm` 的键盘映射对「Ctrl + 可打印键」只认字母、空格、数字键
 * 3–8、`[` `\` `]` 与 `_` / `@`，斜杠键（`keyCode` 191、`key` 为 `/`）一条都不命中，
 * 映射结果为空后 `_keyDown` 直接返回——既不 `triggerDataEvent` 也不 `preventDefault`。
 * 于是 `Ctrl+/` 在渲染端被静默吞掉，readline 的 undo（`"\C-_": undo`）与 vim / emacs
 * 的撤销（都绑 `^_`）永远收不到（specs/defects/terminal-ctrl-slash-dropped.md）。
 *
 * 这里只补用户实际要用的那一条，其余仍交给 xterm：宿主不该重写一份键盘映射表，
 * 已经能映射的组合再补一遍就会写出两个字节。
 */

/** `Ctrl+/` 的字节：`^_`（0x1F），与 `Ctrl+Shift+-` / `Ctrl+7` 同字节 */
export const CTRL_SLASH_BYTE = '\u001f';

/**
 * 补映射判定：该 keydown 是否由本模块代为发声，返回要写进 stdin 的字节，`null` 表示
 * 交给 xterm 自己处理。
 *
 * 判据按**用户打出的字符**（`KeyboardEvent.key`）而不是物理 `code`：德语等布局上 `/`
 * 落在 `Shift+7`（`code` 为 `Digit7`），认 `code` 就会漏掉。带 `Alt` / `Meta` 的组合
 * 不属于本表（`Alt` 前缀归 xterm，`Cmd` 归宿主快捷键），`Ctrl+Shift+/` 打出来的是 `?`
 * 也不是 `^_` 的物理按法。
 */
export function ctrlSlashByte(input: {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  if (input.type !== 'keydown') return null;
  if (!input.ctrlKey || input.altKey || input.metaKey) return null;
  // `/` 与 `?` 共用斜杠键：`Ctrl+Shift+/` 的 key 是 `?`，传统终端不把它编成 ^_
  if (input.key !== '/') return null;
  // 德语等布局：`/` 需要 Shift，键被换成 `?` 或者带 Shift 但仍是 `/` 都按用户意图出 ^_
  return CTRL_SLASH_BYTE;
}

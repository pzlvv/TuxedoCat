---
status: 已修
---

# 缺陷：终端 Ctrl+/ 不发字节，撤销（^_）无效

远程终端窗口里按 `Ctrl+/`，远端 shell 什么也收不到：readline 的 undo（`"\C-_": undo`）、
vim / emacs 的撤销都绑在 `^_`（0x1F）上，用户按下去毫无反应。同一个 `^_` 用
`Ctrl+Shift+-` 或 `Ctrl+7` 按得出来，只有 `Ctrl+/` 这个最常用的物理按法丢失。

## 现状

- 渲染端把键入交给 `@xterm/xterm` 的键盘映射（`term.onData` → `api.input`），宿主侧只显式
  处理复制（`Ctrl+Shift+C` / `Cmd+C`）与标签切换组合，`Ctrl+/` 既不是宿主快捷键、也发不出
  字节——按键在渲染端就被吞掉了，没进 `terminal:input`。
- `@xterm/xterm@6.0.0` 的键盘映射（包内 keyboard 模块的 default 分支）对「`Ctrl` +
  可打印键」只认这几类：字母 `keyCode` 65–90 → 0x01–0x1A；空格 32 → 0x00；数字键
  `keyCode` 51–55 → 0x1B–0x1F；`keyCode` 56 → 0x7F；`keyCode` 219 / 220 / 221 → 0x1B /
  0x1C / 0x1D；`key === '_'` → 0x1F；`key === '@'` → 0x00。斜杠键的 `keyCode` 是 191、
  `key` 是 `/`，**表里没有任何一条命中**，映射结果为空，`_keyDown` 走
  「没有 key 就直接返回」的分支：既不 `triggerDataEvent`，也不 `preventDefault`。
- 实测（真实 `@xterm/xterm@6.0.0` bundle，派发与真实按键同形的 `keydown`）：

  | 组合 | xterm 输出 | `defaultPrevented` |
  | --- | --- | --- |
  | `Ctrl+/`（`key='/' code=Slash keyCode=191`） | 无 | false |
  | `Ctrl+Shift+/`（`key='?'`） | 无 | false |
  | `Ctrl+Shift+-`（`key='_'`，即 `Ctrl+_`） | `0x1F` | true |
  | `Ctrl+7` | `0x1F` | true |
  | `Ctrl+@`（`Ctrl+Shift+2`） | `0x00` | true |
  | `Ctrl+-`（`key='-'`） | 无 | false |

- 传统终端把 `Ctrl+/` 编成 `^_`（xterm / gnome-terminal / konsole 同口径；上游同一反馈见
  microsoft/terminal#86「ctrl+/ currently generates no codes at all. It should return the
  same as ^_ (0x1f)」）。xterm.js 至今没有这条映射，所以这不是宿主接线漏了，而是仿真器
  映射表缺一格。
- 复现（页面层，`e2e/terminal/terminalUi.spec.ts`）：聚焦首标签、按一次 `Control+Slash`，
  假 API 的 `inputs` 里没有任何记录（期望恰有一条 `\x1f`）。

## 期望

- `Ctrl+/` 向 stdin 写一次 `^_`（0x1F），与 `Ctrl+Shift+-` / `Ctrl+7` 同字节。
- 补齐只走既有上行路径：经 `term.onData` → `api.input`，不新增第二条写 stdin 的通道，
  也不改 `terminal:*` IPC 面。
- 只补 `Ctrl` + 标点的缺口里用户实际要用的一条（`Ctrl+/`）；xterm 已经能映射的组合
  （字母、数字键、`[` `\` `]`、空格、`_`、`@`）保持原样，不重复发送。
- [docs/hosts/electron-multi-workspace.md 第 14.4 节](../../docs/hosts/electron-multi-workspace.md#144-交互)
  写明这条补齐的存在与范围。

## 不变量

- 其余键的输出字节不变：字母 `Ctrl+A`…`Ctrl+Z`、`Ctrl+Space`、`Ctrl+[` `\` `]`、
  `Ctrl+Shift+-`、`Ctrl+7` 等仍由 xterm 自己映射，字节与 `defaultPrevented` 行为都不变。
- 复制（`Ctrl+Shift+C` / `Cmd+C`）与粘贴（原生 `paste`）的路径与行为不变；自定义按键处理器
  只有一个槽位（后装覆盖先装），补齐与复制必须在同一处接线。
- 带 `Alt` / `Meta` 的组合不受影响（`Alt` 前缀由 xterm 处理，`Cmd` 属于宿主快捷键）。
- 断开 / 连接中的标签仍按 `electron/terminalShells.ts` 的状态机丢弃键入。
- 布局无关：判定按 `KeyboardEvent.key`（用户打出的字符）而不是 `code`——德语等布局上 `/`
  是 `Shift+7`，物理 `code` 不是 `Slash`。

## 回归测试

- **RT-1**：聚焦首标签、按一次 `Control+Slash`，断言该标签收到的 `input` 恰好一条且等于
  `"\u001f"`（落点：`e2e/terminal/terminalUi.spec.ts` 的「Ctrl+/ 发 ^_（撤销）：只写一条
  input，且不与 xterm 自带映射重复」）。
- **RT-2**：同用例内断言 `Control+Digit7` 仍只产生一条 `"\u001f"`（xterm 自带映射不被补齐
  表重复触发）（落点：同上）。
- **RT-3**：纯函数映射表逐条锁定：`Ctrl+/` → `\u001f`；`Ctrl+Shift+/`（`key='?'`）、
  `Ctrl+-`、无修饰键、带 `Alt` / `Meta` 均返回 `null`；德语布局形态（`code='Digit7'`、
  `key='/'`、`shiftKey=true`）同样 → `\u001f`（落点：`src/test/terminalKeyFallback.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui -g "Ctrl\+/"` | 红 | `expect(inputs).toEqual(['\u001f'])` 收到 `[]`：按键在渲染端被 xterm 丢掉，`terminal:input` 一次都没发 |
| RT-3（修复前） | `npm run test:unit -- terminal-key-fallback` | 红 | 模块还不存在，用例集直接失败 |
| RT-1 / RT-2（修复后） | `npm run build:terminal && npx playwright test -c e2e/playwright.config.ts --project=terminal-ui -g "Ctrl\+/"` | 绿 | 一次 `Control+Slash` 产生一条 ``；随后 `Control+Digit7` 仍只有一条 ``（补映射表没有打重 xterm 自带映射） |
| RT-3（修复后） | `npm run test:unit -- terminal-key-fallback` | 绿 | 10 条断言全过（含德语布局 Shift+7、`?`、`Alt` / `Meta` / `keyup` / `keypress` 不代发） |
| 真实 Electron 按键注入 | 临时探针（`sendInputEvent` 注 `Ctrl+/` 与 `Ctrl+7`，与 `electron/terminal/main.ts` 同款接线） | 绿 | 两者都只发一条 `[31]`，两方向都不重复；探针为一次性验证，未入库 |
| 既有回归 | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui` | 绿 | 17/17（原 16 条 + 本缺陷 1 条） |
| 既有回归 | `npm run check-types && npm run lint && npm run check-types:e2e` | 绿 | — |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 49 / 7 全过；[docs/hosts/electron-multi-workspace.md 第 14.4 节](../../docs/hosts/electron-multi-workspace.md#144-交互)补「控制键补映射」条目并保持 500 行上限 |
| CSS / 终端主题 | `npm run test:unit -- terminal` | 绿 | terminalShells + terminalTheme 两项均过 |
| 真实 SSH 车道的撤销行为 | — | skipped | `electron-ssh` 要真实远端与本机 Linux Core 产物，本机不具备；字节层面的证据已由 RT-1 / RT-2 / RT-3 覆盖 |

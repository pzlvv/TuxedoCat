---
status: 已修
---

# 缺陷：终端 Ctrl+Shift+V 粘贴两次

远程终端窗口里按一次 `Ctrl+Shift+V`（macOS `Cmd+V`），粘贴内容进远端 stdin 两次：
同一次按键既走渲染端自实现的「读剪贴板 → 送 input」，又走 Chromium 的默认粘贴 →
xterm 原生 `paste` 监听 → `onData`。多行粘贴尤其明显——两条路径的负载还不一样（原生
路径把换行归一成 CR 并按对端模式加 bracketed paste 括号，自实现路径原样发送）。

## 现状

- 渲染端的剪贴板快捷键在 `electron/terminal/main.ts` 的自定义按键处理器里实现
  （`term.attachCustomKeyEventHandler` 一个槽位）：命中 KeyV 时回调 API 的粘贴读取
  （IPC `terminal:paste` → 主进程 `clipboard.readText()`）再
  `api.input()` 写 stdin，然后 `return false`。
- `attachCustomKeyEventHandler` 的返回值语义只是「xterm 要不要继续处理这个键」
  （`@xterm/xterm@6.0.0` 的 keydown 处理在自定义处理器返回 false 时直接返回，
  不走后面那段会调 `this.cancel(event)` 的路径），**不等于 `preventDefault()`**。于是 Chromium 的内置粘贴
  照常执行，在 xterm 的 helper textarea 上派发原生 `paste` 事件；xterm 的
  `handlePasteEvent`（`@xterm/xterm` 的 `browser/Clipboard.ts`）再调
  `coreService.triggerDataEvent()`，经 `term.onData` 第二次写 stdin。
- 两条路径的负载不同：原生路径先把 `\r?\n` 归一成 `\r`，再按对端
  `CSI ? 2004 h` 状态包 `\x1b[200~ … \x1b[201~`；自实现路径是主进程
  `clipboard.readText()` 的原文。顺序上原生先到（同步），自实现后到（等一次 IPC 往返）。
- 复现（页面层，`e2e/terminal/terminalUi.spec.ts`）：单行剪贴板内容
  `paste-once`、一次 `Control+Shift+v` → 假 API 收到
  `["pwd", "paste-once"]`（`pwd` 是假 API 的粘贴返回值，即自实现路径；
  原生路径读的是系统剪贴板）。多行 `line1\nline2` 且对端开启 bracketed paste →
  收到 `["pwd", "\x1b[200~line1\rline2\x1b[201~"]`，同一份内容两种编码。
- 同一份接线在真实 Electron（无菜单窗口、`sendInputEvent` 注入 `Ctrl+Shift+V`）
  下复现：`attachCustomKeyEventHandler` 只 `return false` 时，渲染端仍收到原生
  `paste` 事件（`clipboardData` 非空、`defaultPrevented === false`）。

## 期望

- 一次 `Ctrl+Shift+V` / `Cmd+V` 只向 stdin 写一次，负载由 xterm 的粘贴处理产生。
- 不再自实现粘贴：渲染端不读剪贴板、不持有粘贴分支，`window.terminalAPI` 与
  `terminal:*` IPC 面不暴露粘贴读取能力（preload 的粘贴读取方法与 `terminal:paste`
  一并删除）。
- 粘贴负载遵循 xterm 原生语义：换行归一为 `\r`；对端开启 bracketed paste 时
  首尾加 `\x1b[200~` / `\x1b[201~`。
- 复制侧不变：`Ctrl+Shift+C`（macOS `Cmd+C`）在有选区时写系统剪贴板，选中即复制
  仍即时写系统剪贴板；两条复制路径同走主进程 `clipboard`（`terminal:copy`）。
- [docs/hosts/electron-multi-workspace.md 第 14.4 节](../../docs/hosts/electron-multi-workspace.md#144-交互)
  的机制描述随之对齐：复制仍走主进程 `clipboard`（渲染端 `navigator.clipboard.writeText`
  不可依赖），粘贴改由 xterm 原生 `paste` 事件读——该事件由浏览器进程代读剪贴板，不经过
  渲染端的 `navigator.clipboard`，因此「渲染端剪贴板权限不可依赖」这一理由对粘贴不再成立
  也不再被引用。

## 不变量

- 界面文案、标签条、覆盖层、主题跟随、字号与焦点跟随的行为不变。
- `terminal:init` / `new-tab` / `input` / `resize` / `close-tab` / `reconnect` /
  `close-window` / `copy` 这组 IPC 的通道名、载荷形状与语义不变。
- `term.onData` 仍是键入与粘贴唯一的上行入口：不新增第二条写 stdin 的路径。
- 断开 / 连接中标签的键入仍按 `electron/terminalShells.ts` 的状态机丢弃。
- 其余宿主（VSCode / TUI / PyCharm）的剪贴板行为不受影响。

## 回归测试

- **RT-1**：单行剪贴板内容 + 一次 `Ctrl+Shift+V`，断言该标签收到的 `input` 恰好
  一条且等于系统剪贴板内容（落点：`e2e/terminal/terminalUi.spec.ts` 的「粘贴只发生
  一次：Ctrl+Shift+V 只产生一条 input（系统剪贴板是唯一数据源）」）。
- **RT-2**：多行剪贴板内容 + 对端开启 bracketed paste，断言收到的 `input` 恰好一条、
  换行归一为 `\r` 且首尾有 `\x1b[200~` / `\x1b[201~`（落点：同文件「多行粘贴走
  xterm 原生路径：换行归一为 CR、对端开启 bracketed paste 时加括号」）。
- **RT-3**：既有「复制选区与粘贴快捷键」用例在修复后仍绿——它的复制走向必须是真实的
  系统剪贴板（假 `terminalAPI.copyText` 除了记状态，还要同步写 `navigator.clipboard`，
  才对得上主进程 `clipboard.writeText` 与渲染端原生粘贴读同一个剪贴板的事实）。落点：
  `e2e/terminal/terminalUi.spec.ts` 的「复制选区与粘贴快捷键」与假 API 注入常量
  `FAKE_API_INIT`。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui -g "粘贴只发生一次"` | 红 | `expect(inputs).toEqual(['paste-once'])` 收到 `["pwd","paste-once"]`：自实现路径（假 API 的粘贴返回值 `pwd`）与原生路径各写一次 |
| RT-2（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui -g "多行粘贴走"` | 红 | 收到 `["pwd","\x1b[200~line1\rline2\x1b[201~"]`：同一次按键两种编码各写一次 |
| RT-3（修复前，同批既有用例） | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui` | 绿 | 14 条既有用例全过（含「复制选区与粘贴快捷键」）——它只断言 `inputs.join('')` **包含**被复制的子串，重复写两遍照样包含，因此测不出本缺陷 |
| RT-1 / RT-2（修复后） | `npm run build:terminal && npx playwright test -c e2e/playwright.config.ts --project=terminal-ui -g "粘贴只发生一次\|多行粘贴走"` | 绿 | 两条各断言一次按键只产生一条 `input`：单行为 `paste-once`，多行为 `\x1b[200~line1\rline2\x1b[201~`（换行归一 + bracketed paste 都在原生路径上） |
| RT-3（修复后） | 同上（整车道 16 条） | 绿 | 「复制选区与粘贴快捷键」在假 `copyText` 同步写系统剪贴板后仍绿；`page-error` 里不再出现「preload 没有粘贴读取方法」的调用错误 |
| 既有回归 | `npx playwright test -c e2e/playwright.config.ts --project=terminal-ui` | 绿 | 16/16（原 14 条 + 本缺陷 2 条） |
| 既有回归 | `npm run check-types && npm run lint && npm run check-types:e2e` | 绿 | — |
| docs-lint | `npm run test:unit -- docs-lint` | 绿 | 49 / 7 全过；[docs/hosts/electron-multi-workspace.md 第 14.4 节](../../docs/hosts/electron-multi-workspace.md#144-交互)的剪贴板条目随修复对齐（`docs/hosts/electron-multi-workspace.md` 保持 500 行上限） |
| 真实 SSH 车道的端到端粘贴 | — | skipped | `electron-ssh` 要 `e2e/environments.json` 的真实远端与本机 Linux Core 产物，本机不具备；页面层的双重写入证据已由 RT-1 / RT-2 覆盖 |

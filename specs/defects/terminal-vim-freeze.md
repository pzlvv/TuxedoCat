---
status: 已修
---

# 缺陷：打包版终端打开 vim 即卡死——esbuild 二次压缩破坏 xterm 的 DECRQM 应答，渲染链永久死亡

打包产物（`dist/terminal/`）里的终端窗口一进 vim（以及 htop / less 等启动时发终端
模式查询的全屏程序）就整页冻结：画面停在建链完成后的第一帧，键入不再回显，关窗重开
也一样。开发态（`npm run watch:terminal`，不压缩）无此问题，因此 specs/022 实施与
日常开发期未暴露；打包版从始至终带病。

## 现状

- 上游缺陷链（xtermjs/xterm.js#5800，压缩器缺陷已上游立案 evanw/esbuild#4508）：
  `@xterm/xterm@6.0.0` 的 `InputHandler.requestMode`（应答 DECRQM 模式请求
  `CSI ? … $ p`）内有一个只写不读的内部变量；Vite 生产构建用 esbuild 对
  xterm 已压缩的 `lib/xterm.mjs` **二次压缩**时，在「目标 ≤ es2020（`||=` 被降级）+
  压缩标识符 + DCE」三条件齐备下把声明删掉却保留赋值，产出对未声明标识符的引用。
- 我们的终端页构建（`vite.terminal.config.ts`）未设 `build.target`，落在会触发该
  缺陷的默认档：`dist/terminal/assets/index.js` 里就有这份坏代码。
- 行为复现（对当前产物页注入输出字节流）：喂 vim 启动即发的 `\x1b[?2026$p` 一条，
  页面立刻抛 `ReferenceError: i is not defined`（被压坏的标识符）；随后再喂的普通
  文本永远不出现在 `xterm-rows`——上游维护者确认该抛错会杀死 xterm WriteBuffer 的
  续写链：PTY 与键盘路径仍活着（键入照发、远端 shell 照收），但渲染从此永久停止。
  表现为「打开 vim 直接卡死」。
- 不受影响的面：主进程状态机（`electron/terminalShells.ts`）、SSH 通道
  （`src/host/standalone/sshClient.ts`）、preload IPC——均已核对，与本缺陷无关；
  纯渲染端构建产物问题。

## 期望

- 打包产物里，vim / htop / less 等启动时发 DECRQM 的全屏程序正常可用（as-built：
  `docs/features/user-stories/desktop.md` US-55 验收 2「全屏程序（vim 一类）可用」）。
- DECRQM 模式查询不再触发页面错误；查询之后的输出照常渲染。
- 修复手段落在构建配置（`build.target` 提到 es2021 以上，`||=` 不再被降级、缺陷
  形态无法产生），不关闭压缩、不换 terser、不升级 xterm 版本、不打运行时补丁。

## 不变量

- 终端页既有呈现全部不变：统一滚动条、标签条形态、连接中加载动画、viewport 底色
  同源（本缺陷修复只动构建目标，不触任何样式 / DOM / 行为）。
- xterm 版本（`@xterm/xterm@6.0.0`）与 API 用法不变。
- 其余 vite 页面（webview / sidebar / titlebar 等）的构建配置不动——只有终端页
  引 xterm；e2e 的假 `terminalAPI` 手法与既有用例全部保持。

## 回归测试

- **RT-1**：对构建产物页（e2e 静态伺服 `dist/terminal/`）喂 vim 启动即发的 DECRQM
  序列 `\x1b[?2026$p`，断言（a）不抛任何页面错误、（b）之后喂的普通文本仍渲染进
  `xterm-rows`。落点：`e2e/terminal/terminalUi.spec.ts` 新用例（ctl 增
  `emitOutput` 下行钩子，以主进程口吻推 `terminal:output`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:e2e -- --project=terminal-ui -g "DECRQM"` | 红 | `expect(...).toContain('after-decrqm')` 超时 15s：`xterm-rows` 只有 `welcome-1`——DECRQM 后渲染链已死（页面错误 `ReferenceError: i is not defined`） |
| 回归用例（修复后） | `npm run test:e2e -- --project=terminal-ui -g "DECRQM"`（`build.target: 'es2022'` 重建后） | 绿 | 查询后文本照常渲染、无页面错误 |
| 既有回归 | `npm run test:e2e -- --project=terminal-ui` | 绿 | 10/10：标签、键入路由、断开态与重连、连接中动画、主题、剪贴板、快捷键切换 |
| 既有回归 | `npm run check-types:e2e` | 绿 | — |

# 规格：TUI（终端宿主）

> **状态：方案（未实施）。** 本文档目前是设计提案，不是 as-built 规格：凡涉及 TUI 自身的
> 文件、行为均为设计意图（尚未存在）；凡引用的现有文件、契约成员、协议词汇均为已核实的
> 现状。实施落地时按 AGENTS.md 第 0 节约定把本文改写为只写现状的规格，并同步
> `DEVELOPMENT.md`（第 5、8.6、11.1 节与第 13 章待定项）与 `user-stories.md`。

本规格界定第三个宿主——TUI（终端界面）的设计。TUI 复用现有 core 与宿主层，与 VS Code
webview 宿主、Electron 宿主同构：core 与 UI 的分离形态见 `docs/core-ui-separation.md`；
事件词汇表见 `DEVELOPMENT.md` 第 3、4 节；宿主契约见第 5 节（UIHost / SpinDesign /
ConversationManager）；共享子模块端口见第 7 节；宿主接线见第 8.6 节；宿主固有差异见
第 11.1 节。Core 的两种实现见 `docs/standalone-core.md`；工作区连接模型见
`docs/client-connection.md`；远程 daemon 见 `docs/core-daemon.md`。

---

## 1. 定位与结论

1. **第三个宿主**：TUI 是继 VS Code webview、Electron 之后的第三个宿主实现，与两者走
   同一条复用路径——实现宿主契约（`DEVELOPMENT.md` 第 5 节），共享宿主层与 core 原样复用。
2. **不碰 core**：TS Embedded Core（`src/core/`）与 Rust Standalone Core（`core-rs/`）零改动，
   不产生 parity 对照表与两侧测试的同步义务。
3. **不直连 bus**：TUI 不注册自己的 `CoreEventHandlers` / `CoreRequestHandlers`，而是复用
   `WebViewUI`（`DEVELOPMENT.md` 第 6 节）。理由：用户消息回显 uuid、排队消息、会话加载翻译、
   设置读写翻译等宿主逻辑只允许存在一份（第 12 章原则「一份事实只有一个写入点」）；
   自建 handler 会形成与两个现有宿主的第二份实现。
4. **TUI 是 wire 协议的又一个渲染方**：渲染层消费 `HostToWebviewMessage`，用户输入生产
   `WebviewToHostMessage`，与 webview 里的 React 组件完全同位。终端语义的差异只落在
   渲染与 `UIHost` 实现上，不落在业务流上。
5. **单工作区**：TUI 以启动时的工作目录为唯一本地工作区（默认 `process.cwd()`），不支持
   Electron 的多工作区标签。`broadcastToWebviews` / `sendToWebviewView` 语义上退化为
   `sendToWebview`（TUI 只有一个对话视图）。
6. **v1 范围**：对齐 webview 主功能——聊天往返、流式渲染、工具卡片、权限确认、用户选择、
   会话切换与管理、模型与各模式菜单、abort、notice。**v1 不含**：侧栏文件浏览器、
   Spin 设计器、SSH 远程工作区（见第 11 节待定项）。

## 2. 接入架构

### 2.1 复用链

```
core（Embedded src/core/ ／ Standalone core-rs）
     │  CoreEvent / CoreRequest ↑        ↓ UiEvent / UiRequest   （AssistantEventBus，第 3 节）
     ▼
WebViewUI（src/host/WebViewUI.ts，宿主无关，由 bootstrapCore 内部构造，第 6 节）
     │  wire 协议：HostToWebviewMessage ↓        ↑ WebviewToHostMessage
     │  （src/host/webviewMessages.ts）
     ▼
TUI（src/tui/）
     ├─ TuiUIHost.sendToWebview → store 纯 reducer → Ink 渲染
     └─ 键盘输入 → WebviewToHostMessage → ui.handleWebviewMessage(message, { sender: null })
```

### 2.2 数据流与现有宿主逐点同位

| 环节 | VS Code 宿主 | Electron 宿主 | TUI（设计） |
| --- | --- | --- | --- |
| 组合根 | `bootstrapCore(...)`（`src/extension.ts`） | `bootstrapCore(...)`（`electron/main.ts`） | `bootstrapCore(...)`（`src/tui/main.ts`） |
| 宿主下行 | `host.sendToWebview` → webview postMessage | 同左（按 sessionId 路由到 ChatView） | `host.sendToWebview` → store dispatch → Ink |
| 宿主上行 | webview onDidReceiveMessage → `ui.handleWebviewMessage` | `electron/main.ts` 同一入口 | 键盘事件组装消息 → `ui.handleWebviewMessage(message, { sender: null })` |
| 权限/选择 | UserChoiceManager + ToolHandler（第 7.1/7.2 节） | 同左 | 同左（零改动，表现为终端覆盖层） |
| 会话列表 | ConversationManager 子类 | 同左 | `TuiConversationManager` 两个抽象方法写 store |
| 配置文件 | `updateSettingsJson` → `src/host/settingsFile.ts` | 同左 | 同左（复用共用实现） |

上行入口的 `WebviewRequestContext.sender` 允许为 `null`（`src/host/ui/webviewMessageHandler.ts`
的 `DEFAULT_REQUEST_CONTEXT`），TUI 单视图无需产出句柄。

### 2.3 Core 形态选择

- 默认 `standalone`：`bootstrapCore` 经 `openStandaloneChannel` spawn
  `<core-binary> stdio`（本地工作区路径，`docs/standalone-core.md`），二进制定位沿用
  `extensionPath`（TUI 传产物根目录，与 Electron 的 `APP_ROOT` 同位）。
- 开发期可切 `embedded`：选择变量只有 `resolveCoreKind()`（`src/host/coreKind.ts`，读
  `TUXEDO_CAT_CORE` 环境变量，esbuild define 烧入默认值）。TUI 入口若提供 `--core`
  参数，只在进程启动早期转设该环境变量，选择来源仍是 `resolveCoreKind()` 单一出口。

## 3. 选型

### 3.1 渲染层：Ink 5 + React 18（采用）

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **Ink 5 + React 18** | 采用 | React 组件模型与现有 webview 技术栈同构，流式更新（streamMessage 高频增量）自然映射为 state 更新；Claude Code / Codex CLI 同路线，生态成熟；Windows Terminal / VS Code 集成终端（conpty）支持良好，覆盖本仓库主平台 win32。Ink 5 与现有 `react ^18.3.1` 匹配；实施时若 Ink 更新版本已稳定且无迁移成本可重估 |
| 裸 ANSI 自绘 | 否决 | 零依赖但滚动区、光标、Resize、IME 全手写，工作量数倍且不可持续 |
| blessed / terminal-kit | 否决 | blessed 多年不维护、Windows 支持差；terminal-kit 偏命令式，与本仓库 React 风格不合 |

Ink 是 TUI 的独立 bundle 依赖（webview bundle 不受影响）；React 复用现有依赖。

### 3.2 markdown 与代码高亮

markdown 自渲染：`marked` 解析 + 自研「AST → Ink 元素」映射（现有 `ink-markdown` 类库维护
状态存疑，且需要与消息流、折叠行为深度配合）；代码块高亮用 `shiki` 的 ANSI 输出
（`shiki` 已是 webview 依赖，TUI bundle 单独打入所需语言包）。工具输出的 ANSI 转义
（Bash 输出）沿用 webview 侧 `ansi.tsx` 的同一套解析思路。

## 4. 文件布局（设计）

```
src/tui/
  main.ts                    # 入口：--workspace（默认 cwd）、--core（转设 TUXEDO_CAT_CORE）；
                             #   组装三契约 → bootstrapCore → 启动 Ink App
  TuiUIHost.ts               # UIHost 全部成员的终端实现（第 5 节映射表）
  TuiSpinDesign.ts           # SpinDesign：open/refresh 显式提示终端不支持（见第 5.2 节）
  TuiConversationManager.ts  # dispatchList / dispatchStates → store
  store.ts                   # 纯 reducer：HostToWebviewMessage 流 → TuiState（唯一渲染事实）
  App.tsx                    # Ink 根组件：布局、焦点与键盘路由、覆盖层栈
  components/                # MessageList / ToolCard / PermissionOverlay / ChoiceOverlay /
                             #   Composer / StatusBar / Menus（模型、会话、MCP）
  markdown.tsx               # marked + Ink 元素映射；shiki ANSI 代码高亮
  i18n.ts                    # TUI 自有文案 zh/en；core notice 键复用 src/webview/i18n/
```

- `store.ts` 对齐 webview 侧 `src/webview/sessionState.ts` 的模式：wire 协议是事实，
  store 是只读投影，不反推、不猜默认值（第 12 章原则）；对未知消息 type 丢弃并记 log，
  与 core 对未知词汇的口径一致。
- i18n：`src/webview/i18n/` 是纯数据模块（`index.ts` 仅聚合 zh/en 字典，无 React 依赖），
  TUI 直接复用它翻译 core `notice` 事件的键，避免词典分叉；TUI 自有文案（菜单、覆盖层
  提示、键位说明）单独放 `src/tui/i18n.ts`，同样 zh/en 两份。

## 5. UIHost 终端映射

`UIHost`（`src/host/UIHost.ts`）全部成员逐项给出终端语义。分组沿用接口注释分区。

### 5.1 传输

| 成员 | 终端语义 |
| --- | --- |
| `sendToWebview(message)` | `store.dispatch(message)`——TUI 唯一渲染入口 |
| `broadcastToWebviews(message)` | 同 `sendToWebview`（单视图） |
| `sendToWebviewView(view, message)` | 同 `sendToWebview`（单视图，句柄不参与路由） |
| `onThemeChanged(view \| null)` | no-op：终端配色在渲染期直接读主题常量。`isDarkTheme()` 是主题唯一判定源（接口注释），TUI 返回 `true`（终端以深色为基准配色）；后续如需跟随终端背景可经 OSC 11 探测，进第 11 节待定 |

### 5.2 环境

| 成员 | 终端语义 |
| --- | --- |
| `log(...args)` | 落文件日志（对齐 Electron 的 fileLogger 思路）+ `--verbose` 时打 stderr；**不打 stdout**（stdout 被备用作非交互输出通道） |
| `isDarkTheme()` | `true`（见 5.1 onThemeChanged） |
| `getLocale()` | 读 settings 的 UI 语言（与 webview 同一来源），未配置回退 env `LANG`/`LC_ALL` 的 zh/en 收敛 |

### 5.3 面板 / 窗口

| 成员 | 终端语义 |
| --- | --- |
| `openFile(filePath, target)` | 系统默认程序打开（`start` / `open` / `xdg-open` 按平台）；打开失败经 notice 键提示 |
| `showVirtualDocument(content, title)` | 全屏只读覆盖层，滚动查看，q/Esc 关闭 |
| `showDiff(options)` | 终端 diff 覆盖层：before/after 渲染为带色统一 diff（新增绿 / 删除红 / hunk 头青），权限确认弹出**之前**展示，语义与 VS Code 的 diff 标签一致 |
| `openMermaidPreview(code)` | 显式 notice「当前环境不支持 Mermaid 预览」（带 i18n 键）。这是设计允许的差异而非静默降级——渲染面按宿主能力表达（第 11.1 节同口径），实施时登记进第 11.1 节对照表 |
| `closePreview()` | 关闭当前覆盖层（diff / 虚拟文档） |
| `openExternalUrl(url)` | 系统默认浏览器 |
| `saveTextFile(content, options)` | 无对话框：写入当前工作目录下 `defaultFileName`，重名追加序号；返回 `SaveFileResult` 判别联合，成功后以 notice 告知落盘路径 |

### 5.4 会话 / 列表 / 状态 与 配置文件

| 成员 | 终端语义 |
| --- | --- |
| `closeConversationView(sessionId)` | 正在查看该会话则切出（回到列表选择），否则无显示变化；磁盘数据与运行时内存不动（接口注释语义） |
| `updateSettingsJson(mutator)` | 复用 `src/host/settingsFile.ts` 共用实现（串行队列 + 写后清 core 读缓存），终端不改写路径 |
| `getWorkspacePath()` / `getWorkspaceRef()` | 启动工作目录；ref 为 `{ scheme: 'local', path, endpoint: null }`（`docs/client-connection.md` 的工作区引用） |
| `getOpenWorkspaceRefs()` | 恒为 `[当前 ref]`（单工作区） |
| `onWorkspaceChanged(listener)` | TUI 不产生工作区变化；注册后立即以 opened 语义回调一次以对齐 Client 的装配时序（实施时以 `bootstrapCore` 的实际要求为准） |

## 6. SpinDesign 与 ConversationManager

- **SpinDesign**（第 5.2 节）：`open()` / `refresh()` 都以 notice 显式提示「Spin 设计器
  仅在 VS Code / Electron 宿主提供」。设计器本身是自包含 HTML（`src/host/ui/spinDesignHtml.ts`），
  终端不承载；TUI 会话内的 Spin 运行数据仍经 `spinDesignDataChanged` 照常进入 store，
  仅渲染为状态行。
- **ConversationManager**（第 5.4 节）：子类实现 `dispatchList`（会话列表 → store，
  供会话切换器）与 `dispatchStates`（运行时全量状态 → store，供状态栏流水灯与 abort
  三态）。缓存、脏标记、双流分发全部继承 concrete 实现，TUI 不重写。

## 7. 交互设计（v1）

### 7.1 布局

```
┌──────────────────────────────────────────────┐
│  消息流（滚动区，占满余高）                      │
│    用户气泡 / assistant markdown / 工具卡片     │
│    流式块（spinner + 增量文本，streamEnd 定稿）  │
├──────────────────────────────────────────────┤
│  状态栏（1 行）：工作目录 · 模型 · 模式标志 ·     │
│    会话流水灯 · 上下文 tokens                    │
├──────────────────────────────────────────────┤
│  编辑器（多行，底部固定）                        │
└──────────────────────────────────────────────┘
```

- 模式标志：agentMode（manual/risk/auto）、promptMode、thinking、webSearch、MCP 开关数。
- 流水灯：`sessionRuntimeStates` 全量投影（idle/waiting/queryRunning/compacting/
  backgroundRunning/subAgentRunning），语义对齐侧栏与托盘的既有消费。
- 上下文 tokens：`addMessage` 携带的 contextLength / cacheRead 等字段（webview 的
  StreamStats 同源数据）。

### 7.2 编辑器与键位

| 按键 | 行为 |
| --- | --- |
| `Enter` | 发送（`{ type: 'sendMessage', ... }`，经 `ui.handleWebviewMessage`） |
| `Shift+Enter` | 换行；粘贴含换行的文本原样保留 |
| `/`（行首） | 斜杠命令菜单（core `commandDispatched` 流回执行结果，与 webview 同一链路） |
| `Ctrl+L` | 会话切换器：列表（conversationsData 投影）/ 新建 / 重命名 / 删除 / smart naming / 子代理跳转（parentSessionId） |
| `Ctrl+M` | 模型菜单：provider → model 两级（provider 列表来自 settings 投影） |
| `Esc` | 有覆盖层时关覆盖层；无覆盖层时 abort——三态语义对齐 `docs/abort-button.md`（前台查询 / 转后台任务 / 子代理），按当前会话运行态投影呈现对应分支 |
| 排队 | core 忙时发送进入排队（webview「Waiting:」同语义，queuedMessage 投影），显示可取消 |

### 7.3 覆盖层

| 覆盖层 | 触发 | 交互 |
| --- | --- | --- |
| 权限确认 | `toolPermissionRequested`（`permResult.behavior === 'ask'`） | `y` 允许 / `n` 拒绝 / `a` 本会话不再询问（选项集合随 agentMode 与工具类型，与 webview 选项语义一一对应）；Edit/Write 附带 diff，默认折叠、`d` 展开（内容即 `showDiff` 覆盖层复用同一渲染） |
| 用户选择 | `userChoice` | 数字/方向键选择 + `Enter` 确认；`Esc` 转自由输入（对应 `{ index, reply }` 的 reply 分支） |
| 会话切换 / 模型菜单 | `Ctrl+L` / `Ctrl+M` | 列表导航 + 过滤；删除类操作需二次确认（对齐 webview 的 DeleteConfirmDialog 语义） |
| 虚拟文档 / diff | `showVirtualDocument` / `showDiff` | 全屏滚动查看，`q`/`Esc` 关闭 |

覆盖层是渲染层概念：pending 的权限与选择状态来自 store（`requestUserChoice` /
ToolHandler 的投递链路不变），core 侧 UserChoiceQueue 的「仅投递给打开的会话、加载时重投」
语义原样生效。

## 8. 构建与依赖（设计）

- 构建：新增 `tui/esbuild.js`，对齐 `electron/esbuild.js` 的口径——`bundle: true`、
  `format: 'cjs'`、`platform: 'node'`、`external: ['cpu-features', '*.node']`、
  同一 `__TUXEDO_CAT_CORE_KIND__` define；产物 `dist/tui.js`。
- 脚本：`"build:tui"`、`"tui": "node dist/tui.js"`、`watch` 并入 `watch:tui`。
- 依赖：`ink@^5`、`ink-testing-library`（devDependencies）；`react` 复用现有 `^18.3.1`；
  markdown 解析新增 `marked`。不引入 blessed / terminal-kit。
- 类型检查：`src/tui/` 落在 `src` 侧 tsconfig 覆盖范围内，`npm run check-types` 自动纳入
  （现有三份 tsconfig 口径不变）。

## 9. 测试策略（设计）

| 层 | 方式 | 位置 |
| --- | --- | --- |
| store reducer | 纯函数单测：`HostToWebviewMessage` 序列 → 状态断言（消息树、流式缓冲、工具卡片状态、pending 权限/选择、排队） | `src/test/tui*.test.ts`（对齐 AGENTS.md 第 5 节「测试在 src/test/*.test.ts」） |
| 组件 | `ink-testing-library` 渲染断言：权限覆盖层（y/n/a + diff 折叠）、用户选择、工具卡片、markdown 块、编辑器 | 同上 |
| 契约 | `TuiUIHost` 成员行为表驱动的单测（saveTextFile 命名规则、closeConversationView 切出等） | 同上 |
| core / parity | 不涉及——core 零改动，`src/test/fixtures/*Parity.json` 不动 | — |
| e2e | 暂缓。现有 Playwright 工程面向 webview / Electron；TUI 的端到端需伪终端驱动 `main.ts`，留待后续立项 | — |

## 10. 里程碑

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| M1 骨架 | 三契约 + bootstrapCore 接线；Ink 壳（消息流 + 编辑器 + 状态栏）；纯文本聊天往返：发送 / 流式 / `Esc` abort | 终端里完成一次带工具调用的问答 |
| M2 工具与权限 | 工具卡片（进度 / ANSI 输出 / 状态）；权限覆盖层（含 diff）；用户选择覆盖层；notice | manual 模式下 Edit/Write 全流程可走通 |
| M3 会话 | 会话切换 / 新建 / 重命名 / 删除 / smart naming；排队消息；状态栏流水灯；子代理跳转 | 断点续聊与多会话往返无状态错乱 |
| M4 配置面 | 模型菜单；agentMode / promptMode / thinking / webSearch / MCP 菜单；余额展示；默认值变更应用对话框 | 与 webview 等价的会话级配置能力 |
| M5 打磨 | markdown + shiki 高亮；i18n 补齐（zh/en）；Windows Terminal / VS Code 终端兼容验证；本文档改写为 as-built；`bin` 入口与打包评估 | 按 AGENTS.md 交付完整规格同步 |

## 11. 风险与待定

### 11.1 风险

1. **wire 协议约 50 种消息**：渲染按里程碑渐进补齐；reducer 对未知 type 丢弃 + log，
   不阻断其余渲染。
2. **终端兼容面**：目标 Windows Terminal 与 VS Code 集成终端（conpty）；Windows 老 conhost
   明确不在支持范围（Ink 依赖的现代终端特性缺失），实施时在 README 与 notice 中表达。
3. **多行编辑器是最大单点**：IME、粘贴、光标与撤销在 Ink 生态没有现成完整解。M1 先做
   可用版（换行、粘贴、退格），富编辑能力随迭代补齐；必要时评估引入成熟的终端编辑器
   原语（如 `ink-text-input` 的分叉维护）。
4. **markdown 渲染库**：不依赖现成 Ink markdown 组件（维护状态存疑），自研映射的表面积
   需在 M5 控制在常用子集（标题 / 强调 / 代码 / 列表 / 引用 / 表格 / 链接）。
5. **stdout 纪律**：TUI 全生命周期占用 stdout 作渲染面；任何库的 stdout 泄漏（如 ssh2
   的调试输出）都会打花界面，日志一律走 stderr / 文件（第 5.2 节 log 语义）。

### 11.2 待定项

实施启动时归位 `DEVELOPMENT.md` 第 13 章：

1. `@` 文件引用补全是否进 v1（webview 有文件引用 chips，终端需要目录补全交互）——倾向 v2。
2. SSH 远程工作区：`CoreDaemon` + `sshClient` 栈在纯 Node 可直接复用（`docs/core-daemon.md`
   第 12 节），缺的是密码输入与 host key TOFU 确认的终端交互——倾向 v2。
3. 主题是否跟随终端背景（OSC 11 探测）——倾向恒深色基准。
4. 分发形态：npm `bin` 字段 / 独立可执行 / 随桌面安装包附带——随 M5 评估。

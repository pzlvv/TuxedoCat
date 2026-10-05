# 规格：TUI（终端宿主）

> 第三个宿主（继 VS Code webview 宿主、Electron 宿主之后）的终端实现。v1 为原型：
> 主功能链路可用，架构按「又一个 wire 协议渲染方」组织，扩展点见第 10 节。
> 分发与 Core 部署见 `docs/tui-installer.md`。

本规格界定 TUI 的现状。TUI 复用现有 core 与宿主层，与 VS Code webview 宿主、Electron
宿主同构：core 与 UI 的分离形态见 `docs/core-ui-separation.md`；事件词汇表见
`DEVELOPMENT.md` 第 3、4 节；宿主契约见第 5 节（UIHost / SpinDesign /
ConversationManager）；共享子模块端口见第 7 节；宿主接线见第 8.6 节；宿主固有差异见
第 11.1 节。Core 的两种实现见 `docs/standalone-core.md`；工作区连接模型见
`docs/client-connection.md`；远程 daemon 见 `docs/core-daemon.md`。

---

## 1. 定位与结论

1. **第三个宿主**：TUI 实现宿主契约（`DEVELOPMENT.md` 第 5 节），共享宿主层与 core
   原样复用；core（`src/core/` TS Embedded 与 `core-rs/` Rust Standalone）零改动，
   不产生 parity 对照表与两侧测试的同步义务。
2. **不直连 bus**：TUI 不注册自己的 `CoreEventHandlers` / `CoreRequestHandlers`，
   而是复用 `WebViewUI`（`DEVELOPMENT.md` 第 6 节）。用户消息回显 uuid、排队消息、
   会话加载翻译、设置读写翻译等宿主逻辑只存在一份（第 12 章「一份事实只有一个
   写入点」）。
3. **TUI 是 wire 协议的又一个渲染方**：渲染层消费 `HostToWebviewMessage`，用户输入
   生产 `WebviewToHostMessage`（`src/host/webviewMessages.ts`），与 webview 里的
   React 组件完全同位；上行入口 `ui.handleWebviewMessage(message, { sender: null })`
   （`WebviewRequestContext.sender` 允许 null）。
4. **单工作区**：以启动时的工作目录为唯一本地工作区（默认 `process.cwd()`）；
   `broadcastToWebviews` / `sendToWebviewView` 退化为 `sendToWebview`。
5. **v1 范围**：聊天往返、流式渲染、工具卡片、权限确认、用户选择、会话切换 / 新建 /
   删除 / 重命名 / smart naming、模型与会话配置菜单、abort、notice、markdown 渲染
   （marked 子集，无 shiki 高亮）、斜杠命令菜单（来自 skills）。**v1 不含**：侧栏
   文件浏览器、Spin 设计器、SSH 远程工作区、`@` 文件补全（见第 11 节）。

## 2. 接入架构

### 2.1 复用链

```
core（Embedded src/core/ ／ Standalone core-rs）
     │  CoreEvent / CoreRequest ↑        ↓ UiEvent / UiRequest   （AssistantEventBus，第 3 节）
     ▼
WebViewUI（src/host/WebViewUI.ts，宿主无关，由 bootstrapCore 内部构造，第 6 节）
     │  wire 协议：HostToWebviewMessage ↓        ↑ WebviewToHostMessage
     ▼
TUI（src/tui/）
     ├─ TuiUIHost.sendToWebview → store 纯 reducer → Ink 渲染
     └─ 键盘输入 → WebviewToHostMessage → ui.handleWebviewMessage(message, { sender: null })
```

组合根是 `src/tui/render/main.ts`：解析 CLI → 解析 Core 产物根（第 2.4 节）→
TTY 守卫 → 构造三契约 → `bootstrapCore(...)` → Ink `render`。

### 2.2 数据流（与现有宿主逐点同位）

| 环节 | VS Code 宿主 | Electron 宿主 | TUI |
| --- | --- | --- | --- |
| 组合根 | `bootstrapCore`（`src/extension.ts`） | `bootstrapCore`（`electron/main.ts`） | `bootstrapCore`（`src/tui/render/main.ts`） |
| 宿主下行 | `host.sendToWebview` → webview postMessage | 按 sessionId 路由到 ChatView | `host.sendToWebview` → store dispatch → Ink |
| 宿主上行 | webview onDidReceiveMessage → `ui.handleWebviewMessage` | 同一入口 | 键盘事件组装消息 → `ui.handleWebviewMessage(message, { sender: null })` |
| 权限 / 选择 | UserChoiceManager + ToolHandler（第 7.1/7.2 节） | 同左 | 同左（零改动，表现为终端覆盖层） |
| 会话列表 | ConversationManager 子类 | 同左 | `TuiConversationManager` 两个抽象方法写 store |
| 配置文件 | `updateSettingsJson` → `src/host/settingsFile.ts` | 同左 | 同左（复用共用实现） |

### 2.3 Core 形态选择

- 默认 `standalone`：`bootstrapCore` 经 `openStandaloneChannel` 按需 spawn
  `<core-binary> stdio`（本机没有运行中的 Core 时由 TUI 进程直接拉起；帧协议与
  握手见 `docs/standalone-core.md` 第 6 节）。
- 开发期可切 `embedded`：`--core embedded|standalone` 只在进程启动早期转设
  `TUXEDO_CAT_CORE` 环境变量，选择来源仍是 `resolveCoreKind()`（`src/host/coreKind.ts`）
  单一出口。

### 2.4 Core 产物定位（`src/tui/coreRoot.ts`）

Core 的部署不在 TUI 里（独立安装程序，`docs/tui-installer.md`）。TUI 沿用
`resolveCoreBinary(extensionPath)` 的同一搜索路径，候选顺序（第一个能解析出
Core 二进制的胜出）：

1. 环境变量 `TUXEDO_CAT_TUI_ROOT`（显式指定安装前缀）；
2. 默认安装前缀 `~/.tuxedo-cat/tui`（安装程序的默认落点）；
3. bundle 所在目录（自定义前缀下就地运行 `node <prefix>/tui.mjs`）；
4. bundle 上一级（开发仓库：`dist/tui.mjs` → 仓库根的 `resources/core/`）。

全部落空直接抛错并给出安装指引（不静默降级）。

## 3. 选型与产物形态

- **渲染层 Ink 5 + React 18**（`ink@^5`，独立 bundle 依赖；React 复用现有依赖）。
- **产物是 ESM**（`dist/tui.mjs`，`node dist/tui.mjs` 运行，需要 Node ≥ 18）：ink 5
  的模块图带顶层 await（devtools 按需 import），CJS 产物在 Node 下无法加载。构建
  脚本 `tui/esbuild.js` 因此注入 `createRequire` / `__dirname` banner（打包进来的
  CJS 依赖需要），并把 ink 的可选 peer `react-devtools-core` 桩化（TUI 不支持 ink
  devtools，调试走 `--verbose`）。
- **markdown**：`marked` 解析 + 自研「token → Ink 元素」映射（`src/tui/render/markdown.tsx`），
  常用子集（标题 / 强调 / 代码 / 列表 / 引用 / 表格 / 链接 / 分隔线）；代码块的
  shiki ANSI 高亮不在 v1。解析按原文缓存，流式重渲染不重复解析。
- 不引入 blessed / terminal-kit。

## 4. 文件布局

```
src/tui/
  TuiUIHost.ts               # UIHost 全部成员的终端实现（第 5 节映射表）
  TuiSpinDesign.ts           # open/refresh 显式提示终端不支持（notice）
  TuiConversationManager.ts  # dispatchList / dispatchStates → store
  coreRoot.ts                # Core 产物根候选与安装指引（第 2.4 节）
  store.ts                   # 纯 reducer：wire 消息 + tui: 本地动作 → TuiState（唯一渲染事实）
  i18n.ts                    # TUI 自有文案复用宿主 tt()；core notice 键复用 webview 字典数据
  composerState.ts           # 编辑器纯状态机（按键 → 新状态，可单测）
  render/                    # ESM 作用域（render/package.json 声明 type:module）：
                             #   ink 5 是 ESM-only，tsc 按最近 package.json 判定模块格式，
                             #   渲染层收进子目录后，上层纯逻辑保持 CJS、可被测试车道 import
    main.ts                  # 入口：CLI 解析 → coreRoot → TTY 守卫 → bootstrapCore → Ink render
    App.tsx                  # Ink 根组件：布局、键盘路由、菜单 / 覆盖层栈、启动序列
    markdown.tsx             # marked token → Ink 元素映射
    components/              # MessageList / ToolCard / StatusBar / Composer / Overlays / Spinner
```

- `render/package.json` 只含 `{"type":"module"}`，是模块格式的作用域声明，不是包。
- `store.ts` 对齐 webview 侧 `src/webview/sessionState.ts` 的模式：wire 协议是事实，
  store 是只读投影，不反推、不猜默认值（事实未到达用 `null` 表达等待态）；对未知
  消息 type 丢弃并记日志，与 core 对未知词汇的口径一致。
- i18n：`src/webview/i18n/zh.ts` / `en.ts` 是纯数据，TUI 直接复用翻译 core `notice`
  键（不引入 `index.ts`——它读 `window.__uiLocale`，是浏览器模块）；TUI 自有文案走
  宿主层 `tt()`（语言经 `bootstrapCore` 的 `primeHostLocale` 在启动期收敛）。

## 5. UIHost 终端映射

`UIHost`（`src/host/UIHost.ts`）全部成员的终端语义（实现 `src/tui/TuiUIHost.ts`）：

### 5.1 传输

| 成员 | 终端语义 |
| --- | --- |
| `sendToWebview(message)` | `store.dispatch(message)`——TUI 唯一渲染入口 |
| `broadcastToWebviews(message)` | 同 `sendToWebview`（单视图） |
| `sendToWebviewView(view, message)` | 同 `sendToWebview`（句柄不参与路由） |
| `onThemeChanged(view \| null)` | no-op：终端配色在渲染期读主题常量，`isDarkTheme()` 恒 true 是唯一判定源 |

### 5.2 环境

| 成员 | 终端语义 |
| --- | --- |
| `log(...args)` | `fileLogger` 落盘 + `--verbose` 时打 stderr；**不打 stdout**（stdout 被 Ink 占用作渲染面） |
| `isDarkTheme()` | `true`（恒深色基准） |
| `getLocale()` | `getHostLocale()`（`primeHostLocale` 收敛后的宿主语言） |

### 5.3 面板 / 窗口

| 成员 | 终端语义 |
| --- | --- |
| `openFile(filePath, target)` | 系统默认程序打开（`start` / `open` / `xdg-open` 按平台）；失败经 notice 提示 |
| `showVirtualDocument(content, title)` | 全屏只读覆盖层（j/k/↑↓ 滚动、PgUp/PgDn 翻页、q/Esc 关闭） |
| `showDiff(options)` | 终端 diff 覆盖层：`diff` 包的行级对比渲染为带色统一 diff（新增绿 / 删除红 / 等值灰），等值上下文每侧折叠到 3 行；在权限确认覆盖层弹出**之前**展示 |
| `openMermaidPreview(code)` | 显式 notice「当前环境不支持 Mermaid 预览」——设计允许的能力差异，不静默降级 |
| `closePreview()` | 关闭当前覆盖层（权限应答后由 UserChoiceManager 自动调用） |
| `openExternalUrl(url)` | 系统默认浏览器（与 `openFile` 同一打开器） |
| `saveTextFile(content, options)` | 无对话框：写入工作目录下 `defaultFileName`，重名追加序号（`name (1).ext`）；返回 `SaveFileResult` 判别联合，成功后 notice 告知落盘路径 |

### 5.4 会话 / 列表 / 状态 与 配置文件

| 成员 | 终端语义 |
| --- | --- |
| `closeConversationView(sessionId)` | 正查看该会话则切出到空态（`tui:closeConversationView` 本地动作，reducer 只在活动会话匹配时生效）；磁盘数据与运行时内存不动 |
| `updateSettingsJson(mutator)` | 复用 `src/host/settingsFile.ts` 共用实现 |
| `getWorkspacePath()` / `getWorkspaceRef()` | 启动工作目录；ref 为 `{ scheme: 'file', path, endpoint: null }` |
| `getOpenWorkspaceRefs()` | 恒为 `[当前 ref]` |
| `onWorkspaceChanged(listener)` | 返回 no-op 取消函数（单工作区没有变化；bootstrap 装配同步读 `getOpenWorkspaceRefs`，无需补发） |

## 6. SpinDesign 与 ConversationManager

- **SpinDesign**（`TuiSpinDesign`）：`open()` / `refresh()` 都以 notice 显式提示
  「Spin 设计器仅在 VS Code / Electron 宿主提供」；设计器是自包含 HTML
  （`src/host/ui/spinDesignHtml.ts`），终端不承载。
- **ConversationManager**（`TuiConversationManager`）：只实现 `dispatchList`
  （会话列表 → `conversationsData`）与 `dispatchStates`（运行态 →
  `sessionRuntimeStates`）两个抽象方法（写 store）；缓存、脏标记、双流分发全部
  继承 concrete 实现。Electron 专用的 `setStatusListener` / `setSidebarOutlet`
  保持基类默认（未注册即 no-op）。

## 7. 交互（v1）

### 7.1 布局

```
┌──────────────────────────────────────────────┐
│  通知条（最近 3 条，8s 消散）                   │
│  消息流（滚动区，渲染上限 150 条，超出头部折叠）  │
│    用户行 / assistant markdown / thinking 折叠行 │
│    工具卡片 / 系统行 / 流式块 / 排队提示          │
├──────────────────────────────────────────────┤
│  状态栏（1 行）：工作目录 · 模型 · 模式标志 ·     │
│    会话流水灯 · 上下文 tokens · 余额             │
├──────────────────────────────────────────────┤
│  覆盖层（栈：文档/diff > 用户选择 > 菜单）        │
│  编辑器（多行，底部固定）+ 键位提示行             │
└──────────────────────────────────────────────┘
```

- 流水灯读 `sessionRuntimeStates` 全量投影（idle/waiting/queryRunning/compacting/
  backgroundRunning/subAgentRunning → ○◑●◍），abort 语义同源。
- 上下文 tokens 读 `addMessage` / `streamEnd` 携带的 input + output（服务端值直接
  采用，不取 max）。

### 7.2 编辑器与键位

| 按键 | 行为 |
| --- | --- |
| `Enter` | 发送（`sendMessage`，经 `ui.handleWebviewMessage`；会话配置带上已到达的事实） |
| `Ctrl+O` | 换行（多数终端里 Shift+Enter 与 Enter 同码，无法区分；Ctrl+J 同理按换行兜底） |
| 粘贴 | 含多行的文本原样插入（`composerState.ts` 的 `insertText`） |
| `/`（空编辑器） | 斜杠命令菜单（skills 投影，选择后回填 `/name `；发送时按普通消息交给 core 分发） |
| `Ctrl+L` | 会话切换器：列表（含运行态点）/ 新建 / 重命名 / smart naming / 删除（二次确认） |
| `Ctrl+M` | 模型菜单：provider → model 两级（`setModels` 投影） |
| `Ctrl+K` | 会话配置菜单：agentMode / thinking / promptMode / webSearch / MCP 开关 / 压缩上下文 |
| `Esc` | 有覆盖层时关覆盖层；编辑器有内容时清空；否则 abort 当前会话查询 |
| `Ctrl+C` | 退出（Ink 默认；退出路径走 `shutdownCore`） |

### 7.3 覆盖层

| 覆盖层 | 触发 | 交互 |
| --- | --- | --- |
| 权限确认 / 用户选择 | `requestUserChoice` | ↑↓/数字 选择 + Enter 确认；Esc 转自由输入（提交 `{ index: -1, reply }`，与 webview 同语义） |
| 会话 / 模型 / 配置 / 斜杠菜单 | `Ctrl+L` / `Ctrl+M` / `Ctrl+K` / `/` | ↑↓ 选择 + Enter 确认 + 输入即过滤；删除类操作二次确认；Esc 逐级返回 |
| 虚拟文档 / diff | `showVirtualDocument` / `showDiff`（UIHost） | 全屏滚动查看，q/Esc 关闭 |

同一时刻只有一个交互面接键（优先级：文档/diff 覆盖层 > 用户选择 > 菜单 > 编辑器）；
pending 的事实都在 store，覆盖层只持导航类局部状态。

## 8. 构建与依赖

- `npm run build:tui`（`tui/esbuild.js`）→ `dist/tui.mjs`（ESM，见第 3 节）；
  `npm run watch:tui` 监听；`npm run tui` 启动（等于 `node dist/tui.mjs`）。
- `npm run package:tui` 生成安装程序（`docs/tui-installer.md`），并挂在
  `npm run package` 链尾。
- 依赖：`ink@^5`、`marked`（dependencies）；`react` 复用现有；无 blessed /
  terminal-kit。
- 类型检查：`src/tui/` 落在根 tsconfig 覆盖范围内（`jsx: react-jsx`），
  `npm run check-types` 自动纳入。

## 9. 测试

| 层 | 方式 | 位置 |
| --- | --- | --- |
| store reducer | 纯函数表驱动：wire 消息序列 → 状态断言（消息流 / 流式 / 去重 / 排队 / 工具卡片 / 配置回写 / 通知 / 本地动作 / 未知词汇丢弃） | `src/test/tuiStore.test.ts` |
| 宿主契约 | `TuiUIHost` 成员行为表驱动（传输三出口、预览覆盖层、diff 折叠、saveTextFile 命名、closeConversationView、coreRoot 候选与指引）+ SpinDesign / ConversationManager + 编辑器状态机 | `src/test/tuiHost.test.ts` |
| 组合根 | 真 Standalone Core 集成：三契约 + `bootstrapCore` 拉起 Core 进程、握手、`requestSettingsDefaults` 回包进 store（产物缺失跳过） | `src/test/tuiBootstrap.test.ts` |
| 安装程序 e2e | 构建 → 自解压 → 布局 / 指纹 / 幂等 → 内嵌 Core `--version` → 安装目录里的 TUI 启动守卫 | `e2e/tui/installer.spec.ts`（project `tui-installer`） |
| Ink 组件渲染 | 暂无自动化：ink 5 是带顶层 await 的 ESM，无法被仓库的 CJS 测试车道 require（渲染层与纯逻辑分层的第 4 节注释即为此）；组件正确性经 store 契约 + 真 core 集成间接锁定，交互渲染留待伪终端 e2e（第 11 节） | — |
| core / parity | 不涉及——core 零改动 | — |

## 10. 扩展点

- **新消息渲染**：`store.ts` 的 reducer 加一个 case（未知词汇默认丢弃 + 记日志，
  新词汇在 `default` 的穷尽性检查处编译期暴露）；渲染组件读 store 投影。
- **新覆盖层 / 菜单**：`components/Overlays.tsx` 的通用 `MenuOverlay` /
  `InputOverlay` 组合，`App.tsx` 的 `Menu` 联合加一个 kind。
- **SSH 远程工作区（v2 方向）**：`CoreDaemon` + `sshClient` 栈是纯 Node 可直接复用，
  缺的是密码输入与 host key TOFU 确认的终端交互（可做成 `InputOverlay` /
  `ChoiceOverlay` 的变体）。
- **`@` 文件补全（v2 方向）**：编辑器状态机已可承载（`insertText` 注入），
  需要目录补全交互。

## 11. 风险与待定

### 11.1 风险（现状口径）

1. **终端兼容面**：目标 Windows Terminal 与 VS Code 集成终端（conpty）；老 conhost
   与重定向管道不支持 raw mode——入口在渲染前显式拦截并给出可行动报错。
2. **多行编辑器**：IME、撤销、富编辑无现成完整解；v1 状态机覆盖换行（Ctrl+O）/
   粘贴 / 退格 / 方向键 / 清行，`composerState.ts` 独立可测。
3. **stdout 纪律**：全生命周期 stdout 是 Ink 渲染面；日志走 stderr / 文件
   （第 5.2 节），库的 stdout 泄漏会打花界面。
4. **渲染上限**：消息流只渲染最近 150 条（整帧重绘的帧率约束），更早的历史经
   会话加载仍在 store，翻页查看留给后续。

### 11.2 待定项

1. `@` 文件引用补全——倾向 v2（第 10 节）。
2. SSH 远程工作区——倾向 v2（第 10 节）。
3. 主题跟随终端背景（OSC 11 探测）——当前恒深色基准。
4. shiki ANSI 代码高亮——当前代码块单色渲染。
5. 伪终端驱动的 TUI 交互 e2e（现有 playwright 工程面向 webview / Electron；
   TUI 交互层暂无自动化，见第 9 节）。

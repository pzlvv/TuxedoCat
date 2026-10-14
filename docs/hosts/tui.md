---
owner: pzlvv
last_reviewed: 2026-10-11
---

# 规格：TUI（终端宿主）

本规格界定第三个宿主（继 VS Code webview 宿主、Electron 宿主之后）的终端实现：纯 Rust
（`tui-rs/`），直连 Standalone Core 的帧通道，不依赖 Node。分发与 Core 部署见
`docs/features/tui-installer.md`。

本规格界定 TUI 的现状。TUI 与 core-rs 同语言、同阻塞线程模型；core 的两种实现
（`docs/core/standalone-core.md`）与事件词汇表（[docs/architecture/events.md 第 1 节](../architecture/events.md#1-总线契约)、[第 2 节](../architecture/events.md#2-事件词汇表)）零改动，
不产生 parity 对照表与两侧测试的同步义务。帧协议见 `docs/core/standalone-core.md`
第 6 节；`src/host/` 的宿主层（WebViewUI 及其子模块）继续服务 VS Code 与
Electron 两个宿主，TUI 侧的等价行为由 `tui-rs/src/host.rs` 移植承载。

---

## 目录

| 节 | 标题 |
| --- | --- |
| 1. | [定位与结论](#1-定位与结论) |
| 2. | [接入架构](#2-接入架构) |
| 3. | [选型与产物形态](#3-选型与产物形态) |
| 4. | [文件布局](#4-文件布局) |
| 5. | [译层映射（`host.rs` ⇆ TS 宿主行为）](#5-译层映射hostrs--ts-宿主行为) |
| 6. | [UI 终端语义](#6-ui-终端语义) |
| 7. | [交互（v1）](#7-交互v1) |
| 8. | [构建与依赖](#8-构建与依赖) |
| 9. | [测试](#9-测试) |
| 10. | [扩展点](#10-扩展点) |
| 11. | [风险与待定](#11-风险与待定) |

---

## 1. 定位与结论

1. **第三个宿主（纯 Rust）**：TUI 直连 Standalone Core（`core-rs`）的 stdio 帧通道
   （`<core-binary> stdio`，协议 v2），进程内没有 TS core，也不复用 `src/host/`
   的 TS 宿主层——「UI 侧翻译」在 `tui-rs/src/host.rs` 重建（第 5 节），core 零改动。
2. **宿主逻辑的单一实现点**：TS 宿主的用户消息回显 uuid、排队 deferEcho、会话
   加载翻译、设置读写翻译等行为，在 Rust 侧只存在于 `host.rs` 一处；与 TS 宿主
   的行为对应关系以本规格第 5 节的映射表为契约。
3. **store 是唯一渲染事实**：core 帧经译层转成 `Action`，`store.rs` 的纯 reducer
   是唯一写入点；本地动作（`Local::` 前缀）与 core 事实同走一个 reducer。
4. **单工作区**：以启动时的工作目录为唯一本地工作区（默认当前目录，
   `--workspace` 覆盖）；SSH 远程工作区不在 v1。
5. **v1 范围**：聊天往返、流式渲染、工具卡片、权限确认（含 manual 模式的 diff
   覆盖层）、用户选择（数字/方向键/Esc 转自由输入）、会话切换 / 新建 / 删除 /
   重命名 / smart naming、模型与会话配置菜单、abort、notice 翻译、markdown 子集
   渲染（无 shiki 高亮）、斜杠命令菜单（skills 投影）、状态栏（运行态流水灯 /
   tokens / 余额）、多行编辑器。**v1 不含**：文件浏览器、Spin 设计器、SSH 远程、
   `@` 文件补全、图片输入。

## 2. 接入架构

```
core-rs（Standalone Core，子进程，stdio 即帧通道）
     │  CoreEvent / CoreRequest ↑        ↓ UiEvent / UiRequest   （协议 v2）
     ▼
host.rs（译层：WebViewUI + webviewMessageHandler + ToolHandler + UserChoiceManager 的移植）
     │  Action ↓                            ↑ App 调用 Host 方法（上行帧进 outbox）
     ▼
store.rs（纯 reducer，唯一渲染事实） → app.rs（ratatui 投影 + 键盘路由）
```

- 组合根是 `tui-rs/src/main.rs`：CLI 解析 → Core 产物定位（第 2.4 节）→ TTY 守卫
  → 配置读盘与语言收敛 → spawn Core → 握手（hello/ready）→ 推送
  `hostEnvironmentProvided` → 事件循环（第 2.3 节）。
- **线程模型**：主线程跑 crossterm 事件循环与 ratatui 整帧重绘；读线程阻塞读
  Core 的 stdout 逐帧转发（mpsc）；child stdin 由主线程独占（译层的 outbox 每轮
  排空写入）。无异步运行时，与 core-rs 的阻塞模型一致。
- **就绪序列**：`ready` 帧到达后译层推送宿主环境与配置快照（core 的就绪判据），
  App 随即执行挂载序列（拉列表 / 技能 / 模型 / 默认值 / 上下文上限 + 新建首个
  会话），与 webview 挂载行为同构。

### 2.1 帧协议

信封与编解码在 `tui-rs/src/protocol.rs`，与 `core-rs/src/frame.rs` 同构（载荷以
JSON Value 透传；`FrameDecoder::read_from` 按行阻塞读，坏行跳过不中断）。词汇表
消费以 `host.rs` 的 handler 表为准：CoreEvent 全量处理（`toolArgsUpdated` /
`sessionCreated` 等已知词汇显式忽略），未知类型记日志丢弃。

### 2.2 Core 形态

只有 Standalone：本机 Core 产物由本进程按需 spawn（`stdio` 动作）。TS 宿主的
`--core embedded|standalone` 开关不存在（Embedded Core 是进程内 TS，Rust 宿主
没有该形态）；`resolveCoreKind()` 的单一出口对 TUI 不适用。

### 2.3 事件循环

每轮：排空 core 帧（`try_recv`）→ 处理键盘 / 粘贴 / 窗口事件（`poll` 80ms）→
排空上行帧并 flush → 整帧重绘。空闲轮触发 tick：通知按时效消散（8s）、spinner
动画、斜杠菜单回填。Core 进程退出 → 译层丢弃挂起请求、清空选择框与查询计数、
notice 提示后退出。

### 2.4 Core 产物定位（`tui-rs/src/core_root.rs`）

部署布局（[docs/features/tui-installer.md 第 2 节](../features/tui-installer.md#2-功能需求)）：`<前缀>/share/<产品名>/<指纹>/` 放
Core 槽位，`<前缀>/share/<产品名>/ripgrep/` 是全部槽位共享的 rg，TUI 二进制在
`<前缀>/share/<产品名>/tui[.exe]`（unix 上另有软链接 `<前缀>/bin/<产品名>` 指向它）。

候选根顺序（每个根先按部署布局、再按开发期仓库布局解析；第一个能解析出 Core
二进制的胜出；全部落空报错附安装指引，不静默降级）：

1. 环境变量 `<envPrefix>_TUI_ROOT`（显式指定部署前缀或仓库根）；
2. 默认部署前缀（应用根）：unix `~/.local`（产品目录即 `~/.local/share/<产品名>/`），
   Windows `~/<configDir>`（安装程序的默认落点）；
3. TUI 可执行文件所在目录（就地运行：本程序就在产品目录里）；
4. 可执行文件的各级上级目录（有层数上限）：经软链接或产品目录启动时回溯到部署
   前缀；开发期 `tui-rs/target/<profile>/` 回溯到仓库根。

布局判定（`core_binary_in`）：

- 部署布局：`<根>/share/<产品名>/` 下任一「`fingerprint` + Core 二进制都齐」的
  指纹槽位（多版本并存取排序最大的一员，只为确定）；
- 仓库布局（开发期）：`<根>/resources/core/<arch-platform>/<core.binaryName>[.exe]`
  （平台矩阵见 [docs/core/standalone-core.md 第 4.1 节](../core/standalone-core.md#41-平台矩阵)）。

## 3. 选型与产物形态

- **渲染 ratatui + crossterm 0.28**：整帧重绘（与 Ink 的自上而下重绘同预算约束，
  消息流渲染上限 150 条、markdown 解析按消息 id 缓存）。不引入异步运行时。
- **产物是原生二进制**：`tui-rs/target/release/standalone-tui[.exe]`，运行不需要
  Node。crate 依赖只有 `serde` / `serde_json`（preserve_order，settings.json 键序
  不乱）、`ratatui` / `crossterm`、`uuid`（会话 id v4）。
- **markdown**（`markdown.rs`）：自研子集解析（标题 / 强调 / 行内代码 / 围栏代码 /
  列表 / 引用 / 表格 / 链接 / 图片占位 / 分隔线 / HTML 字面），产出带样式行，
  纯函数可测；无 marked、无 shiki（待定项，第 11.2 节）。
- **diff**（`diffview.rs`）：行级 LCS（超 4000 行/侧退化为整侧替换）+ 等值上下文
  每侧折叠 3 行，与 TS 版 `showDiff` 的组装口径一致。
- **编辑器**（`composer.rs`）：多行状态机（`lines/row/col`，char 粒度），输入 /
  多行粘贴 / 退格 / 删除 / 方向键 / Tab / Ctrl+U 清行；换行用 Ctrl+O（Ctrl+J 兜底
  ——终端无法区分 Shift+Enter）。粘贴走 bracketed paste（不支持的终端静默降级，
  与 Ink 同边界）。

## 4. 文件布局

```
tui-rs/
  Cargo.toml / .cargo/config.toml   # 纯 Rust crate；musl 交叉配 rust-lld（与 core-rs 同手法）
  src/
    main.rs            # 入口：CLI → 产物定位 → TTY 守卫 → spawn Core → 事件循环
    protocol.rs        # 帧信封 + 编解码（对齐 core-rs/src/frame.rs，协议 v2）
    settings.rs        # 配置快照（settings.json / mcp.json 规范化 + 模型注册表 + 原子写）
    core_root.rs       # Core 产物根候选与安装指引（第 2.4 节）
    i18n.rs            # 语言收敛（tt()）+ core notice 键翻译（复用 webview 字典数据）
    ui_state.rs        # 按会话的活动阶段 / 工具并发计数 / 查询计数
    choices.rs         # 用户选择队列 + diff 快照（每会话一个 pending；帧 id 跟随）
    conversations.rs   # 会话列表与运行态缓存（单工作区）
    host.rs            # 译层：core 帧 ↔ 渲染动作（第 5 节映射表）
    store.rs           # 状态 + 纯 reducer（唯一渲染事实）
    app.rs             # ratatui 渲染 + 键盘路由（菜单 / 覆盖层 / 编辑器 / 状态栏）
    composer.rs        # 编辑器纯状态机
    markdown.rs        # markdown 子集 → 带样式行
    diffview.rs        # 行级 diff + 等值折叠
```

- `*_tests.rs` 与被测模块同目录（`#[cfg(test)] #[path = ...]`，core-rs 同风格）。
- store 对齐 webview 侧 `src/webview/sessionState.ts` 的模式：core 事实是源，
  store 是只读投影，不反推、不猜默认值；未知动作在译层就不产生。
- i18n：`uiLanguage`（zh/en/auto）在启动期收敛（auto → 宿主 locale / 系统语言，
  Windows 查 PowerShell 的 UI 语言），TUI 自有文案走 `tt()`；core `notice` 键复用
  webview 字典的对应条目（键缺失回显键本身，[docs/architecture/core-ui-separation.md 第 4.9 节](../architecture/core-ui-separation.md#49-瞬时状态通知)）。

## 5. 译层映射（`host.rs` ⇆ TS 宿主行为）

### 5.1 CoreEvent → 渲染动作

| CoreEvent | 行为（TS 对照） |
| --- | --- |
| `message` | `AddMessage` 动作；role 为 user 时顺带刷新对话列表（`onMessage`） |
| `streamMessage` | assistant 空累积跳过；thinking / text 阶段标记 + 流式缓冲替换 |
| `streamEnd` | 按 (role, streamId) 匹配消息就地收敛（同一块两条收尾：block_stop 缺 usage + message_delta 带 usage），未匹配才追加（相邻同内容兜底）；tokens 记账（input+output，不取 max） |
| `toolCall` / `toolResult` | 工具卡片状态机（running → success/fail；状态只升不降；并发计数） |
| `toolProgress` | 卡片输出替换（core 已按 4K 上限裁剪，原样转发） |
| `toolArgsUpdated` | 显式忽略（文件引用 chips 数据面，v1 不渲染） |
| `aiBegin` / `aiEnd` | thinking 动画开关；aiEnd 触发余额拉取（`balanceRequested`） |
| `messagesReplaced` | 整批替换消息列表（压缩后重建 / 展开归档） |
| `queryBegin` / `queryEnd` | 查询计数去重（嵌套 begin/end 只表现一次）；queryEnd 收敛悬挂流式缓冲 + 刷新列表 |
| `titleChanged` | 会话标题 |
| `sessionCreated` | 显式忽略（`initSessionState` 对 TUI 无语义） |
| `conversationListChanged` | 重读列表（`conversationListRequested`） |
| `sessionRuntimeChanged` | 全量运行态入缓存 + store（排队判定 / 状态栏流水灯 / abort 语义同源） |
| `sessionConfigChanged` | 按 change.key 转成 setModel / setThinkingMode / setPromptMode / setAgentMode / setWebSearch；mcpEnabled 触发列表重拉 |
| `commandDispatched` | 清除该会话排队项；`spin` 命令提示设计器不支持 |
| `notice` | 键 + 参数翻译后进通知条（第 4 节 i18n 口径） |
| `compactBegin` / `compactEnd` | 压缩进度提示（start / complete / error） |
| `highlightLanguagesUsed` | 并入 settings.json 的 `highlightLanguages`（去重、上限 60）+ 重推快照 |
| `spinDesignDataChanged` | notice 提示设计器仅在 VS Code / Electron 提供 |
| `log` | 落文件日志（不打 stdout——stdout 是渲染面） |
| `coreReady` | 闩锁（每次重推快照后再来一次；不触发渲染） |

### 5.2 CoreRequest → 交互与应答

| CoreRequest | 行为 |
| --- | --- |
| `toolPermissionRequested` | 上架工具卡片（normal）；Edit/Write 且带 diff 时保存 diff 快照，manual 模式在确认框**之前**弹终端 diff 覆盖层；permResult 原样应答（'ask' 的确认框由随后的 `userChoice` 发出，不在这里弹） |
| `userChoice` | 按会话入队（每会话最多一个，旧请求以错误帧收场）；会话 open（== 当前显示）立即弹覆盖层并上报 `userChoicePendingChanged(true)`，未 open 保留、会话打开时重投 |

### 5.3 用户输入 → UiEvent / UiRequest

| 用户操作 | 上行 |
| --- | --- |
| Enter 发送 | `userMessageSubmitted`（uuid 形如 `user_<ts>_<rand>`；会话覆盖带已到达的事实；忙碌 / 命令消息置 `deferEcho`，忙碌时登记排队项） |
| Esc（空编辑器） | `abortRequested` |
| Ctrl+L / 菜单新建 | `sessionWorkspaceAssigned` + `conversationStarted` + `conversationOpened`（新 id 为 uuid v4） |
| Ctrl+L 打开会话 | 旧会话 `flushSessionRequested`（切换前等落盘收尾）→ `conversationLoadRequested` → 完成后 `conversationOpened`；加载翻译含默认值补齐（thinkingMode / webSearch / promptMode）、模型身份校验（失效时 `modelChanged` 回写）、agentMode 三级回退（core 权威值 → meta.json → 配置默认） |
| 菜单删除 / 重命名 | `conversationDeleted` / `conversationRenamed` |
| 智能命名 | `smartNamingRequested` → 回包设标题 + `conversationRenamed` 落盘 |
| 模型 / 思考 / 提示词 / MCP 菜单 | `modelChanged` / `thinkingEffortChanged` / `promptModeChanged` / `mcpEnabledChanged` |
| 压缩上下文 | `compactRequested` |
| 选择覆盖层应答 | response 帧 `{ index, reply? }`（Esc 转自由输入提交 `{ index: -1, reply }`，与 webview 同语义）+ `userChoicePendingChanged(false)` |

### 5.4 宿主自有事实（不问 core）

| 事实 | 来源 |
| --- | --- |
| 会话默认值（settingsDefaults） | `settings.rs` 快照：`readActiveModelRef` + thinking / agentMode / promptMode / webSearch 默认值（重读磁盘，变化则重推快照） |
| 模型菜单（setModels） | 原始 settings.json 的 providers（baseURL 非空），默认模型补回列表头部 |
| 上下文上限（contextLimitUpdated) | 快照里已解析的 modelLimits（未命中用兜底） |
| 余额（balanceUpdate） | `balanceRequested` 让 Core 查（余额按 provider 的 apiKey，是 core 的事实）；失败清空显示 |
| 技能列表（setSkills) | `skillsRequested`（带 tracked 会话 → 项目技能） |
| MCP 列表（setMcpServers） | `mcpServersRequested`（配置 + 会话启用状态 + 运行时状态） |
| 对话列表（conversationsData） | `conversationListRequested`（单工作区，无多目录脏标记） |

## 6. UI 终端语义

| 能力 | 归属 |
| --- | --- |
| diff 覆盖层（manual 权限预览） | `host.rs`（权限请求）+ `diffview.rs`（行级对比 / 折叠）+ `app.rs`（渲染） |
| 虚拟文档覆盖层 | `store.rs` 的 Overlay 词汇保留；v1 无触发路径（webview 的 showVirtualDocument 通路 TUI 不发） |
| Mermaid 预览 | 显式 notice「不支持」（设计允许的能力差异；v1 未接线，markdown 内联 HTML 按字面展示） |
| 系统打开器（openFile / openUrl） | v1 未接线（消息流不做链接点击） |
| saveTextFile | v1 未接线 |
| Spin 设计器 | notice 提示仅在 VS Code / Electron 提供（`spinDesignDataChanged` / `commandDispatched(spin)`） |

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
| `Enter` | 发送（会话配置带上已到达的事实） |
| `Backspace` | 删除光标前字符（把退格键发成 ^H 的终端经 crossterm 到达为 `Ctrl+H`，同按退格处理） |
| `Ctrl+O` | 换行（多数终端里 Shift+Enter 与 Enter 同码；Ctrl+J 同理按换行兜底） |
| `Ctrl+U` | 清当前行 |
| 粘贴 | 含多行的文本原样插入（bracketed paste） |
| `/`（空编辑器） | 斜杠命令菜单（skills 投影，选择后回填 `/name `；发送时按普通消息交给 core 分发） |
| `Ctrl+L` | 会话切换器：列表（含运行态点）/ 新建 / 重命名 / smart naming / 删除（二次确认） |
| `Ctrl+M` | 模型菜单：provider → model 两级（`setModels` 投影） |
| `Ctrl+K` | 会话配置菜单：agentMode / thinking / promptMode / MCP 开关 / 压缩上下文 |
| `Esc` | 有覆盖层时关覆盖层；编辑器有内容时清空；否则 abort 当前会话查询 |
| `Ctrl+C` | 退出（退出路径发 `shutdown` 帧后收尸子进程） |

### 7.3 覆盖层

| 覆盖层 | 触发 | 交互 |
| --- | --- | --- |
| 权限确认 / 用户选择 | `userChoice` 请求 | ↑↓/数字 选择 + Enter 确认；Esc 转自由输入（提交 `{ index: -1, reply }`） |
| 会话 / 模型 / 配置 / 斜杠菜单 | `Ctrl+L` / `Ctrl+M` / `Ctrl+K` / `/` | ↑↓ 选择 + Enter 确认 + 输入即过滤；删除类操作二次确认；Esc 逐级返回 |
| diff / 虚拟文档 | manual 权限预览（虚拟文档 v1 无触发路径） | 全屏滚动查看（j/k/↑↓、PgUp/PgDn），q/Esc 关闭 |

同一时刻只有一个交互面接键（优先级：文档/diff 覆盖层 > 用户选择 > 菜单 > 编辑器）；
pending 的事实都在 store，覆盖层只持导航类局部状态。

## 8. 构建与依赖

- `npm run build:tui`（cargo build --release）→ `tui-rs/target/release/standalone-tui[.exe]`；
  `npm run tui` 启动（cargo run --release）。
- `npm run package:tui` 生成安装程序（`docs/features/tui-installer.md`），并挂在
  `npm run package` 链尾。
- 依赖：`ratatui` / `crossterm` / `serde` / `serde_json`（preserve_order）/
  `uuid`（v4）；无 Node 运行时依赖。
- 类型检查：`npm run check-types` 覆盖 TS 三份配置（TUI 已不在其中）；Rust 侧
  `cargo test`（manifest `tui-rs/Cargo.toml`）。

## 9. 测试

| 层 | 方式 | 位置 |
| --- | --- | --- |
| 协议 | 帧编解码 / 增量解码 / 坏行跳过 | `tui-rs/src/protocol_tests.rs` |
| 配置 | 快照默认值 / 注册表匹配 / 模型身份校验 / mcp.json / 写入纪律（拒绝覆盖、键序保留） | `tui-rs/src/settings_tests.rs` |
| store | 纯 reducer 表驱动：消息流 / 流式 / 去重 / 排队 / 工具卡片 / 配置回写 / 通知 / 本地动作 | `tui-rs/src/store_tests.rs` |
| 译层 | 选择队列（投递 / 重投 / 覆盖收帧 / 释放收帧）+ 译层翻译 | `tui-rs/src/choices.rs` 内嵌 `mod tests`、`tui-rs/src/host.rs` 的纯函数 |
| 渲染子集 | markdown 块与行内 / diff 着色折叠 / 编辑器状态机 | `markdown_tests.rs` / `diffview_tests.rs` / `composer_tests.rs` |
| i18n / 产物定位 | notice 键翻译 / 占位符 / 候选顺序 / 失败指引 | `i18n_tests.rs` / `core_root_tests.rs` |
| 安装程序 e2e | 构建 → 自解压 → 布局 / 指纹 / 幂等 → 内嵌 Core `--version` → 安装目录里的 TUI 启动守卫 | `e2e/tui/installer.spec.ts`（project `tui-installer`） |
| core / parity | 不涉及——core 零改动；协议契约经真 Core 冒烟验证（握手 / 快照 / 列表 / 加载 / 消息 / 关闭） | — |

## 10. 扩展点

- **新消息渲染**：译层 handler 表加一个分支 + store reducer 加一个 case（未知
  CoreEvent 记日志丢弃）；渲染读 store 投影。
- **新覆盖层 / 菜单**：`app.rs` 的 `Menu` 联合加一个 kind + `menu_items` / 渲染分支。
- **SSH 远程工作区（v2 方向）**：帧通道与 daemon 协议是纯 JSON over TCP（`core-rs`
  的 `daemon_protocol.rs`），Rust 侧可直接实现客户端；缺的是密码输入与 host key
  TOFU 确认的终端交互。
- **`@` 文件补全（v2 方向）**：编辑器状态机已可承载（`insert_text` 注入），
  需要目录补全交互。

## 11. 风险与待定

### 11.1 风险（现状口径）

1. **终端兼容面**：目标 Windows Terminal 与 VS Code 集成终端（conpty）；老 conhost
   与重定向管道不支持 raw mode——入口在渲染前显式拦截并给出可行动报错。
2. **多行编辑器**：IME、撤销、富编辑无现成完整解；v1 状态机覆盖换行（Ctrl+O）/
   粘贴 / 退格 / 删除 / 方向键 / 清行，`composer.rs` 独立可测。
3. **stdout 纪律**：全生命周期 stdout 是渲染面；日志走文件（`~/<configDir>/tui-rs.log`）
   + `--verbose` 时的 stderr，库的 stdout 泄漏会打花界面。
4. **渲染上限**：消息流只渲染最近 150 条（整帧重绘的帧率约束），更早的历史经
   会话加载仍在 store，翻页查看留给后续。
5. **Edit/Write 的 `_meta` 落盘**：TS 宿主在权限通过前把 before/after 追加写进
   会话 `_meta`（[docs/core/standalone-core-boundaries.md 第 2 节](../core/standalone-core-boundaries.md#2-宿主侧的-core-事实读取)的宿主例外）；Rust TUI 不直接写
   core 的会话文件，回滚依赖 core 侧 `tool_result` 备份（`rollback.rs` 的兜底路径）。

### 11.2 待定项

1. `@` 文件引用补全——倾向 v2（第 10 节）。
2. SSH 远程工作区——倾向 v2（第 10 节）。
3. 主题跟随终端背景（OSC 11 探测）——当前恒深色基准。
4. shiki ANSI 代码高亮——当前代码块单色渲染。
5. 伪终端驱动的 TUI 交互 e2e（现有 playwright 工程面向安装器；覆盖层 / 菜单的
   交互正确性由 store 契约 + 状态机单测间接锁定）。

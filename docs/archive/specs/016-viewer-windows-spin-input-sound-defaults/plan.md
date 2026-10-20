# 实施方案：内置查看器窗口单实例与标题、Spin 模式输入禁用与会话标记、提示音默认值

> 指向同目录 `spec.md`（FR-001 ～ FR-006）。技术路线：查看器窗口的顶替 / 矩形决策抽
> electron 下的纯函数模块；spin 工作模式经总线新增 `workModeChanged` 事件 + meta.json
> `workMode` 字段双侧落盘；提示音只动默认值常量与开关语义。

## 技术方案

### FR-001 / FR-002 / FR-003：查看器窗口（Electron 侧）

**顶替机制（销毁重建，不换页）**：`ElectronUIHost` 持 `viewerWindow` 引用（与既有
`mermaidWindow` 同模式）。三个打开函数（`openMonacoWindow` /
`openImagePreviewWindow` / `openMarkdownPreviewWindow`）建窗前统一走
`takeViewerSlot()`：若现存查看器窗口未销毁，取其 `getNormalBounds()` 作为继承矩形并
`destroy()`（加载随窗口销毁取消，不等待）；返回「继承矩形或经校验的已存矩形或
undefined」，作为新窗口的 x/y/width/height（undefined 时用各类型现有默认尺寸、默认
摆放）。`closed` 时清引用（防悬挂）。Spin 设计器（`ElectronSpinDesign` 自持单例）与
Mermaid（`mermaidWindow`）不经过该名额，互不影响。

**标题**：渲染端消费 init 数据——`electron/monaco/main.ts` 与
`electron/imageViewer/main.ts` 收到 init 后 `document.title = title ?? 现值`（调用侧
`init.title` 已是 basename；页面 `<title>` 是构建期注入的产品名，作为无短名兜底）。
BrowserWindow 构造的 `title` 选项维持现状（会被页面标题覆盖，无害）。

**矩形记忆**：新模块 `electron/viewerWindowRect.ts`（零 electron 依赖，可单测）：

- `sanitizeViewerRect(saved: unknown): WindowRect | undefined`——有限数字、宽高 ≥ 300 /
  200（各类查看器默认尺寸的下限档），否则 undefined；
- `isRectVisibleOnSomeDisplay(rect, workAreas)`——从 `electron/main.ts` 的同名函数
  迁来（120×40 最小可见面积判据），main.ts 改为转调（一份实现）；
- `planViewerSlotBounds({ liveBounds, savedRect, workAreas })`——优先级：存活窗口
  继承矩形 > 校验通过的已存矩形 > undefined（默认）。纯函数，锁定顶替与回退决策；
- rect 读写薄封装（read-modify-write `workspaceStateStore`）：`viewerWindowRect` /
  `spinDesignWindowRect` 两个字段加进 `WorkspaceState`（可选，与 `windowSize` 同
  `WindowRect` 形态）。

**接线**：查看器窗口 `move`/`resize` 防抖 2s 落盘（与主窗口同节奏），`close`（含被
顶替销毁前）补记一次 `getNormalBounds()`；`ElectronSpinDesign.open` 建窗前读
`spinDesignWindowRect`（同判据校验），move/resize/close 同样防抖落盘。

### FR-004 / FR-005：spin 工作模式（总线 + core 双侧）

**事件通道**（core → UI）：

- `src/shared/AssistantEventBus.ts`：CoreEvent 联合加
  `{ type: 'workModeChanged'; sessionId: string; workMode: 'normal' | 'spin' }`，
  handler `onWorkModeChanged`；`LoadedConversation` 加必填 `workMode`。
- `core-rs`：`Core` 新增 `set_work_mode(&self, session_id, mode)`——改
  `SessionState.work_mode`、写 meta.json `workMode`、`emit workModeChanged`，一处实现
  三个写入点共用（进入 / 退出 / abort 恢复退出）：
  - `spin_host.rs` 进入（`:243`）与退出（`:249`）两处改调它；
  - `engine.rs on_abort`：会话空闲且 `work_mode == Spin`（应用重启后恢复出的死 spin
    态）时调它退出并 return——运行中的 spin 走既有路径（cancel 标记 → SpinLoop 停止
    → `spin_host.rs` 退出点），不动。
- meta.json 是无 schema 的 JSON（`history::update_metadata` 读-改-写），Rust 侧只写
  键值 `"workMode": "normal" | "spin"`；TS 侧 `src/shared/history/Conversation.ts`
  `ConversationMetadata` 加 `workMode?: 'normal' | 'spin'`（存量豁免口径的可选字
  段，与 `onceMessage` 同模式）。

**恢复链**：`engine.rs ensure_loaded`（`:1620` metadata 分支）恢复
`state.work_mode`；`main.rs conversation_load_payload` 增
`"workMode": metadata.workMode ?? "normal"`；宿主
`webviewMessageHandler.handleLoadConversation` 把 `loaded.workMode` 经
`ConversationLoadedExtra` 进 `buildConversationLoadedPayload`；wire 消息
`conversationLoaded` 载荷加必填 `workMode`。

**UI 面**：

- `WebViewUI`：`buildCoreEventHandlers` 注册
  `workModeChanged: (e) => this.onWorkModeChanged(...)`，方法体
  `postToWebview(sessionId, { type: 'setWorkMode', workMode })`。
- `src/host/webviewMessages.ts`：HostToWebviewMessage 加
  `{ type: 'setWorkMode'; workMode: 'normal' | 'spin' }`（wire 命名跟随 setModel 先例）。
- `src/host/abortButtonState.ts`：`AbortButtonFacts` 加 `workMode`，spin 计入第一分支
  （红、可点）——空闲的恢复态 spin 会话因此有「停止」出口（AC-10 / AC-13）。
- webview：`useMessageHandler` 加 `case 'setWorkMode'`（sessionId 非当前会话忽略）→
  App 状态 `workMode`；`conversationLoaded` 处置从载荷读 `workMode`（新会话默认
  normal）；`InputArea` 新 prop `workMode`：与 `isProviderConfigured` 分开两个条件——
  disabled = provider 未配置 ∨ spin；provider 引导覆盖层只在 provider 未配置时渲染；
  placeholder 三态：spin 文案 > provider 空 > 默认；发送按钮禁用并入 spin。
- i18n：`inputArea.placeholderSpinMode`（zh「Spin 模式下不响应用户输入」/ en
  "Not accepting input while Spin mode is running"），zh/en 同步。

### FR-006：提示音默认值

`electron/soundSettings.ts`：`DEFAULT_SOUND_VOLUME = 0.5`；`enabled` 语义改为
`state.soundEnabled === true`（缺失 / 非布尔一律关）。`workspaceStateStore.ts` 两个
字段注释同步。偏好设置 UI / 播放链路零改动（它们读规范化结果）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/shared/AssistantEventBus.ts` | 修改 | CoreEvent 加 `workModeChanged`；`LoadedConversation` 加必填 `workMode` |
| `src/shared/history/Conversation.ts` | 修改 | `ConversationMetadata` 加可选 `workMode`（落盘格式，双侧一致） |
| `src/host/WebViewUI.ts` | 修改 | 订阅 `onWorkModeChanged` → `setWorkMode` |
| `src/host/webviewMessages.ts` | 修改 | HostToWebviewMessage 加 `setWorkMode`；`conversationLoaded` 载荷加 `workMode` |
| `src/host/conversationPayload.ts` | 修改 | `ConversationLoadedExtra` 与载荷带 `workMode` |
| `src/host/abortButtonState.ts` | 修改 | `AbortButtonFacts` 加 `workMode` |
| `src/webview/App.tsx` / `hooks/useMessageHandler.ts` | 修改 | `setWorkMode` 处置 + 状态下发 |
| `src/webview/InputArea.tsx` | 修改 | `workMode` prop：禁用 / placeholder / 发送 |
| `src/webview/i18n/zh.ts` / `en.ts` | 修改 | `inputArea.placeholderSpinMode` |
| `electron/ElectronUIHost.ts` | 修改 | 查看器名额跟踪、顶替、矩形接线 |
| `electron/viewerWindowRect.ts` | 新增 | 无（electron 层内部模块） |
| `electron/workspaceStateStore.ts` | 修改 | `WorkspaceState` 加两个可选 rect 字段 + 声音注释 |
| `electron/ElectronSpinDesign.ts` | 修改 | 建窗用已存矩形、move/resize/close 落盘 |
| `electron/main.ts` | 修改 | `isRectVisibleOnSomeDisplay` 转调新模块 |
| `electron/monaco/main.ts` / `electron/imageViewer/main.ts` | 修改 | init 后设 `document.title` |
| `electron/soundSettings.ts` | 修改 | 默认音量 0.5、开关语义翻转 |
| `core-rs/src/engine.rs` | 修改 | `set_work_mode`、`ensure_loaded` 恢复、`on_abort` 恢复态退出 |
| `core-rs/src/spin_host.rs` | 修改 | 进入 / 退出改调 `set_work_mode` |
| `core-rs/src/main.rs` | 修改 | `conversation_load_payload` 加 `workMode` |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`viewerWindowRect.ts` 在 electron/（宿主实现层），
      不进 `src/`；`src/host`、`src/webview` 不新增 electron 依赖；`abortButtonState.ts`
      保持零依赖纯函数；无宿主嗅探（两宿主共用的 workMode 行为在总线与 webview 层）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：`work_mode` 唯一写入点 = core `SessionState`
      （`set_work_mode` 一处实现）；UI 只读投影（事件 + 加载载荷）；契约成员全必选
      （`LoadedConversation.workMode`、wire 载荷）；默认值单源（音量默认只在
      `soundSettings.ts`，查看器默认尺寸只在建窗处——各自唯一）；矩形校验失败回退
      默认是「设计允许的瞬时态」（注释说明），非静默降级；页面产物缺失维持现状
      log + 不开窗（既有行为，边界已写进 spec）。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：meta.json `workMode` 由
      core-rs 写入、`src/shared/history/Conversation.ts` 同步类型，Rust 侧对照表测试
      锁定（找 `core-rs` 现有 meta 字段对照测试并扩展）；core 行为改动全落 `core-rs/`
      并补 `engine_tests`；本地跑 `npm run build:core:host` 后 `test:all`（standalone*
      驱动真实二进制）。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec「影响基线」九处，实施完成、
      `npm run test:all -- docs-lint` 全绿后归档（events.md 事件表由 docsLint 逐项
      对照 emit 位点，必须在实施中同步登记）。

## 被否决的替代方案

- **顶替 = 同一 BrowserWindow 内换页面**：三类查看器 preload / 沙箱形态不同
  （monacoPreload / imageViewerPreload / sandbox + data URL），`webPreferences` 构造期
  定死不可换；销毁重建无状态残留、代码路径与既有 Mermaid 单例同构。否决。
- **spin 态并入 `sessionRuntimeChanged` 快照**：runtime 是「运行时聚合」事实流（不同
  来源不同频率不合并，分层规则 6）；workMode 是模式标记，生命周期独立。否决。
- **恢复出的死 spin 态在加载时自动收敛回 normal**：违背「加载时恢复」的需求语义，
  且无法与「运行中切走再切回」区分。改为恢复 + abort 出口（`on_abort` 空闲分支）。
- **标题用主进程 `win.setTitle`**：页面加载完成会用 `document.title` 再覆盖一次，
  治标不治本；在渲染端消费 init 数据里的短名才稳定。否决。
- **提示音默认值改在偏好设置 UI 层兜底**：违反默认值单源（铁律 6）；规范化函数
  `readSoundSettings` 是唯一取值点，翻转它的语义即可，UI / 播放链路零改动。

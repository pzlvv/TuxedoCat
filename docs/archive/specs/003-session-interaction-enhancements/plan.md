# 实施方案：会话交互增强——标签页右键菜单、空闲发送与跳到底部

技术路线分三块互不依赖：标签页右键在 Electron 主进程用原生 `Menu.popup`（与标签栏「+」的
`popupWorkspaceMenu` 同形态），批量关闭的判定抽成无 electron 依赖的纯函数供单测；空闲发送
在 webview App 层做本地挂起（宿主契约零改动），提交复用 `handleSend` 的载荷构造，触发读
core 推送的运行时快照显式 `idle === true`；跳到底部按钮挂在 `MessagesView` 既有
`useAutoScroll` 的判定上。指向同目录 `spec.md`。

## 技术方案

### FR-001：标签页右键菜单（Electron 主进程）

- **通道**：新增 send 型 IPC `titlebar:tab-context-menu`（载荷 = 工作区稳定 id，即
  `refKey`）。`electron/titlebarPreload.ts` 暴露 `showTabContextMenu(id)`；
  `electron/titlebar/main.ts` 的 `TitlebarAPI` 接口同步补成员，`renderWorkspaces` 给每张
  `.ws-tab` 挂 `contextmenu` 监听（`preventDefault` 后上报；不碰既有拖拽 / 中键 / × 交互）。
  主进程 handler 走既有 `isTitlebarSender` 守卫（send 型静默 return），按 id 从
  `openWorkspaces` 回查 `WorkspaceRef`（与 `resolveFilesRef` 同一约定：按 id 不按路径）。
- **菜单**：主进程内新函数 `popupTabContextMenu(ref)`，仿 `popupWorkspaceMenu`
  （`Menu.buildFromTemplate` + `tt()` + `menu.popup({ window: mainWindow })`，光标处弹出）。
  四项与置灰：
  - 关闭 → `void closeWorkspace(refKey(ref))`（忙碌确认在 `closeWorkspace` 内，语义与 ×
    完全一致）；恒可用。
  - 关闭所有空闲会话 → 枚举该工作区会话（遍历 `sessionWorkspaces` +
    `workspacePathMatches`，`closeWorkspace` 内 3287 已有先例），取 `!sessionIsBusy(sid)`
    者（当前选中的对话空闲也包含在内），逐个走
    `closeConversationWithConfirm(sid)`——它在关闭时刻重查忙闲，判定后转忙的会话自然落入
    既有逐会话忙碌确认（spec 边界条）；无可关会话时 `enabled: false`。
  - 关闭其它所有工作区 → 其余工作区逐一查 `workspaceHasBusySession`；任一忙碌则先弹
    **一次**汇总确认（`confirmCloseBusy`，文案说明将中止进行中的运行），确认后全部关闭、
    取消则全部不动；无忙碌直接关。只有一张标签时 `enabled: false`。
  - 打开命令行 → `ref.endpoint === null && fs.existsSync(ref.path)` 才可用；click 调
    既有 `spawnTerminalAt(ref.path)`。
- **批量关闭的重构**：`closeWorkspace` 的清理段（splice、availability/SSH 释放、视图销毁、
  索引清理、活动权移交、emitWorkspaceChange、sync 系列）抽成内部函数
  `teardownWorkspace(ref)`；`closeWorkspace` = 忙确认 + `teardownWorkspace`。「关闭其它
  所有工作区」在汇总确认后逐个 `teardownWorkspace`，避免每工作区重复弹确认。
- **纯函数与单测**：新增 `electron/workspaceBatchClose.ts`（**不 import electron**，与
  `fileTypes.ts` 同类的可测纯模块）：
  - `selectClosableIdleSessions(sessions: { sessionId: string; busy: boolean; displayed: boolean }[]): string[]`
    ——忙不动、显示中不关，返回可关清单；
  - `summarizeOtherWorkspaces(workspaces: { id: string; hasBusySession: boolean }[]):
    { needsConfirm: boolean; ids: string[] }` ——汇总确认判定与目标清单。
  main.ts 的菜单组装消费这两个函数；`src/test/workspaceBatchClose.test.ts` 直接 import
  （先例 `fileOpen.test.ts:4-11`），`tsconfig.test.json` 的 include 补
  `electron/workspaceBatchClose.ts`。IPC 收发配对由 `ipcChannels.test.ts` 自动扫描覆盖。

### FR-002 / FR-003：发送模式与空闲挂起（webview 本地）

- **载荷构造共用**：`useAppHandlers.handleSend` 的「读输入 → 构造 `sendMessage` 载荷 →
  清输入」段抽出为内部共用（载荷字段见 `useAppHandlers.ts:276-296`，wire 类型
  `webviewMessages.ts:554-571` 不动）。主按钮 / 下拉「立即发送」/ Enter 都走原路径；
  下拉「空闲发送」构造同一载荷后进入挂起判定。
- **挂起状态**：App.tsx 新增 `idleSuspendedRef = useRef<Map<string, QueuedMessagePayload>>`
  （按会话，与 `queuedMessageRef` 同型；`uuid` 用本地生成值，仅为复用
  `restoreQueuedMessageToInput` 的类型）+ `idleSuspendedMessage` state（当前会话投影，与
  `activeQueuedMessage` 同法过滤）。挂起判定：提交时刻该会话快照
  `idle === true` → 等价立即发送直接提交；否则入 Map + 横幅。
- **横幅**：InputArea 新增 prop `idleSuspendedMessage`，与既有排队横幅同区块渲染，标签用
  新 i18n 键「空闲后发送：」区分「等待中：」；编辑 / 删除按钮复用同形态——处理函数为
  **纯本地动作**（删 Map + 清 state，编辑走 `restoreQueuedMessageToInput`），不发
  `discardQueuedMessage`。`sendDisabled` 追加 `!!idleSuspendedMessage`；`handleSend` 的
  排队守卫（`useAppHandlers.ts:219-222`）同步查两个 Map（一次一条，任一存在即禁发）。
- **触发**：App 的 effect 挂在 `sessionIdleVersion` 上，遍历 `idleSuspendedRef`：该会话在
  `sessionRuntimeStatesRef` 中**显式** `idle === true`（快照缺失不触发——不过度 fallback）
  才移除并提交。提交复用 `handleSend` 抽出的提交段（此刻若又忙碌，宿主按既有忙碌语义
  接收，消息不丢）。
- **中止回填（竞态的收敛点）**：`handleAbort` 在发 `abort` 前同步检查当前会话的挂起项：
  存在即移除并 `restoreQueuedMessageToInput`。中止点击是同步动作、触发是渲染后 effect 且
  以 ref 为事实源——中止先清挂起项，后到的空闲触发查不到即 no-op，AC-16 的「中止回填
  优先」在源头成立。`queryEnd` 路径不需要感知挂起项。
- **清除**：会话关闭 / 删除的 wire 处理处（`conversationHandlers` 中既有排队项清理点）
  同步删挂起 Map 项；webview 重载即内存丢失，无持久化。

### FR-004：跳到底部按钮（webview）

- `MessagesView` 的 `useAutoScroll` 已在 scroll 里维护 `isAtBottomRef`（2px 容差）。给
  hook 加一个翻转回调（或组件内以 state 镜像）：仅布尔翻转时 setState，避免流式期间
  高频重渲。按钮绝对定位在容器外层 relative 包装（`MessagesView.tsx:2184`）底部居中
  （bottom 即输入框上方），`data-jump-to-bottom` 供 e2e，图标 `chevron-down`，文案
  i18n `messages.jumpToBottom`（zh / en 两份字典对齐插入）。点击：
  `userScrolledAwayRef.current = false`（恢复自动跟随）+ `scrollToBottom(true)`。会话切换
  时既有 layoutEffect（1965-1973 重置滚离 + forceScroll 重滚）会把判定带回底部 → 按钮隐藏。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `electron/workspaceBatchClose.ts` | 新增（纯函数 ×2） | 无（新模块，不涉总线契约） |
| `electron/main.ts` | 新增 `titlebar:tab-context-menu` handler 与 `popupTabContextMenu`；`closeWorkspace` 抽 `teardownWorkspace` | 新 IPC 通道（Electron 内部，非 AssistantEventBus 契约；`ipcChannels.test.ts` 自动配对） |
| `electron/titlebarPreload.ts` / `electron/titlebar/main.ts` | preload 补 `showTabContextMenu`；`TitlebarAPI` 补成员；`.ws-tab` 挂 contextmenu | `TitlebarAPI` 接口新增成员（标题栏页内部） |
| `src/webview/hooks/useAppHandlers.ts` | `handleSend` 抽提交段；新增 `handleSendIdle` / 挂起编辑 / 删除 handler；`handleAbort` 补挂起回填；排队守卫查双 Map | 无 wire 变化 |
| `src/webview/App.tsx` | 挂起 state/ref + 触发 effect + 会话关闭清理 + 新 props 下发 | 无 |
| `src/webview/InputArea.tsx` | 发送按钮 split 形态（antd Dropdown 同 ToggleMenu 先例）；横幅支持空闲挂起态 | 组件 props 新增（webview 内部） |
| `src/webview/MessagesView.tsx` | useAutoScroll 翻转回调 + 跳到底部按钮 | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | 新键（下拉两项、空闲横幅、跳到底部） | 无 |
| `src/test/workspaceBatchClose.test.ts` | 新增单测 | 无 |
| `tsconfig.test.json` | include 补 `electron/workspaceBatchClose.ts` | 无 |
| `e2e/webview/sendModes.spec.ts`、`e2e/webview/jumpToBottom.spec.ts` | 新增 e2e（US-46 / US-47） | 无 |

两套 Core 均不改（见宪章 parity 条）；`docs/architecture/contracts.md` 无 delta（spec 影响基线已定案）。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：core 与
      `src/host/` 均不改；`electron/*` 是宿主实现，可 import `src/core/sessionRuntime.js`
      （`sessionBusyLevel`，main.ts:94 既有先例）与 `src/host/workspaceRef`；新纯模块
      `electron/workspaceBatchClose.ts` 零 import；webview 只加组件内状态与 props，不触
      `host.kind` 嗅探，无新宿主分叉（VS Code 宿主不渲染标签页菜单，输入区 / 跳到底部
      两宿主同享）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：
      不新增 fallback——空闲触发要求显式 `idle === true`，快照缺失不猜；挂起事实的写入点
      唯一（webview App 的 ref），横幅是投影；总线契约零新增成员、零可选化；无新默认值；
      webview 不回传猜测值（挂起项不上送宿主）。
- [x] 两套 Core parity 义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：**不涉及**——
      空闲判定消费既有 `SessionRuntimeState` 快照（`idle` 派生字段两侧已 parity 锁定），
      不改引擎 / 工具 / 事件；无新 CoreEvent / UiEvent / wire 类型；`test:core` 不受本改动
      影响，仍按 CI 照跑。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：按 spec 影响基线
      在收敛时并入——`docs/features/user-stories.md`（US-46/47/48 本体 + 映射表 +
      US-48 豁免文案）、`docs/features/user-message-pipeline.md`（FR-003 空闲挂起 /
      中止回填口径 + 追溯矩阵 + 基线影响）、`docs/hosts/electron-multi-workspace.md`
      （§5 标签页右键、§8.2 批量关闭）、`docs/hosts/vscode-idle-close.md`（§1/§4 补
      Electron 手动批量入口说明）、`docs/hosts/webview-ui.md` 或对应 webview as-built
      文档（发送模式与跳到底部行为落点，落地时按 docs/README 地图定准）；
      `npm run test:all -- docs-lint` 必须绿。

## 被否决的替代方案

- **宿主侧挂起**（扩 `sendMessage` 载荷带模式 + `onQueuedMessage` 扩口径）：评审已定案
  webview 本地挂起——挂起是纯 UI 提交时机语义，进宿主会平白扩 wire 契约并在宿主多养一份
  可挂起状态，违背「一份事实一个写入点」。
- **右键菜单用自绘 HTML 菜单**（`titlebarMenuView` 形态）：需要新视图、定位与开合管理，
  而原生 `Menu.popup` 与「+」菜单同构、实现面小；US-48 本就豁免 e2e 人工验证，自绘的可
  测试性收益不成立。
- **「关闭其它所有工作区」逐工作区复用 `closeWorkspace`**：其内嵌的逐工作区忙碌确认会把
  一次汇总确认放大成 N 次弹窗，违背 spec 的「一次汇总确认」——必须抽 `teardownWorkspace`。
- **空闲触发挂在 `queryEnd`**：`queryEnd` 不携带忙闲语义（waiting / background 结束后仍
  非 idle），以它触发会引入二次猜测；快照推送（`sessionRuntimeStates`）才是 idle 的事实源。
- **跳到底部按钮加未读计数徽标**：spec 非目标，纯定位操作。

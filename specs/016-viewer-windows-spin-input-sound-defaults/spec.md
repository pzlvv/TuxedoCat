---
status: 实施中
---

# 改动规格：内置查看器窗口单实例与标题、Spin 模式输入禁用与会话标记、提示音默认值

四项桌面端体验收敛：(1) Monaco 编辑器窗口标题随打开文件变化；(2) 文件查看器窗口
（Monaco / 图片 / Markdown）共用一个窗口名额、后来者顶替，并记忆上次窗口位置尺寸
（多屏校验），Spin 设计器窗口独立名额、同样记忆位置；(3) Spin 模式期间禁用主输入框
并经总线广播工作模式，会话 meta.json 落盘 `workMode` 标记、加载时恢复；(4) 提醒音
默认关闭、默认音量 50%。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | 2.1 CoreEvent（core → UI，单向） | 修改 | 新增 `workModeChanged` 事件行（进入 / 退出 spin 模式广播） |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | 3. 总线注册 | 修改 | WebViewUI 订阅 `onWorkModeChanged`，向 webview 下发 `setWorkMode` |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | 4. 对话相关数据：ConversationManager | 修改 | 磁盘元数据字段清单新增 `workMode` |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | 5. 宿主侧入口：动作翻译为 UiEvent | 修改 | 偏好设置表「提示音开关 / 提示音音量」两行的默认值口径 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 2. ElectronUIHost | 修改 | 查看器窗口单实例、标题、位置记忆的职责描述 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 4. SpinDesign 实现对照表 | 修改 | 设计器窗口位置记忆 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | 6. 宿主固有差异（有意保留） | 修改 | 提醒音默认关闭 / 50%；查看器与设计器窗口位置持久化 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | 11. 持久化 | 修改 | workspace-state.json 新增查看器 / 设计器窗口 rect 字段 |
| [docs/features/abort-button.md](../../docs/features/abort-button.md) | FR-001 | 修改 | abort 按钮三态推导的事实输入纳入 `workMode`（spin 模式视为可停止） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-33 / US-38 / US-39 | 修改 | 验收标准补充（见「对需求基线的影响」） |

## 用户场景与验收标准

- 场景 1：从任何入口（工具卡片文件链接、侧栏双击、远程文件、虚拟文档）打开查看器窗口，标题一眼可辨是哪个文件。
  - **AC-1**（FR-001）：GIVEN 任一文件入口打开 Monaco 窗口 WHEN 窗口就绪 THEN 窗口标题为所打开文件的 basename（不含目录），不是构建期注入的固定产品标题。
  - **AC-2**（FR-001）：GIVEN `showVirtualDocument(content, title)` 以指定标题打开 WHEN 窗口就绪 THEN 窗口标题为传入的 title。
  - **AC-2a**（FR-001）：GIVEN 打开图片查看器 WHEN 窗口就绪 THEN 窗口标题为图片文件名，不是构建期注入的固定产品标题。
- 场景 2：查看器窗口只占一个名额，反复打开不堆窗。
  - **AC-3**（FR-002）：GIVEN 已有一个 Monaco 查看器窗口 WHEN 打开另一文件的 Monaco 窗口 THEN 旧窗口关闭，桌面只剩一个查看器窗口且显示新文件。
  - **AC-4**（FR-002）：GIVEN 已有任一类查看器窗口（Monaco / 图片 / Markdown 之一）WHEN 打开另一类查看器 THEN 旧窗口被顶替，查看器窗口总数仍为 1。
  - **AC-5**（FR-002）：GIVEN Spin 设计器窗口已打开 WHEN 打开任一文件查看器 THEN 设计器窗口不受影响；反向打开设计器也不顶替查看器窗口。
  - **AC-6**（FR-002）：GIVEN 查看器窗口已全部关闭 WHEN 再次打开文件 THEN 正常新开查看器窗口。
- 场景 3：窗口摆哪儿，下次还在哪儿。
  - **AC-7**（FR-003）：GIVEN 用户移动 / 缩放查看器窗口后将其关闭（或被顶替）WHEN 下次打开任一类查看器 THEN 新窗口按上次的位置与尺寸打开。
  - **AC-8**（FR-003）：GIVEN 保存的查看器窗口矩形不在任何现存显示器工作区的可见范围（如显示器已拔掉）WHEN 打开查看器 THEN 不复用该矩形，按默认尺寸与默认摆放打开。
  - **AC-9**（FR-003）：GIVEN 用户移动 / 缩放 Spin 设计器窗口后关闭 WHEN 再次打开设计器 THEN 按上次位置与尺寸打开；矩形失效时按默认尺寸打开（与 AC-8 同判据）。
- 场景 4：Spin 执行期间输入不添乱，会话标记可恢复。
  - **AC-10**（FR-004）：GIVEN 会话进入 spin 模式（`/spin` 执行中）WHEN 主输入框渲染 THEN 输入框禁用（不可输入、发送不可用）且 placeholder 显示「Spin 模式下不响应用户输入」，停止按钮保持可用。
  - **AC-11**（FR-004）：GIVEN spin 结束（完成 / 中止 / 失败）WHEN `workModeChanged` 的 spin→normal 到达 THEN 输入框恢复可用，placeholder 恢复默认。
  - **AC-12**（FR-005）：GIVEN spin 执行中用户切到其它会话再切回 WHEN 会话重新加载 THEN 输入框仍为禁用（加载载荷携带 spin 态）。
  - **AC-13**（FR-005）：GIVEN spin 执行中应用退出（meta.json 停在 spin）WHEN 重新加载该会话 THEN 输入框禁用，用户触发停止（abort）后会话退出 spin 模式并落盘，输入框恢复。
  - **AC-14**（FR-005）：GIVEN 非 spin 会话（meta.json 无 `workMode` 或为 `normal`）WHEN 加载 THEN 输入框正常可用。
- 场景 5：提示音不再默认打扰。
  - **AC-15**（FR-006）：GIVEN 全新安装或状态文件无声音字段 WHEN 后台任务完成（窗口在后台）THEN 不播放提示音，偏好设置中开关为未勾选、音量滑条为 50%。
  - **AC-16**（FR-006）：GIVEN 用户在偏好设置勾选提示音 WHEN 后台任务完成 THEN 按所设音量播放一次（调整音量后预览播放一次的既有行为不变）。

## 功能需求

### FR-001：查看器窗口标题显示打开对象短名

Monaco 窗口与图片查看器窗口的标题为本次打开对象的短名：文件入口用路径 basename
（不含目录），虚拟文档用调用方传入的 title。标题随每次打开更新（渲染端把 init 数据
中的短名设为页面标题）；没有短名的场景保留产品默认标题。Markdown 预览的标题行为
不变（标题已写入 data URL 页面）。

### FR-002：文件查看器窗口共用单实例、后来者顶替

Monaco 编辑器、图片查看器、Markdown 预览三类内置查看器共用同一个窗口名额：任一新的
打开请求（无论类型、无论与当前内容是否相同）先关闭现存查看器窗口，再以新内容开窗。
顶替发生时，新窗口的初始位置与尺寸继承被顶替窗口关闭前的当前值。Spin 设计器窗口不占
用该名额、与查看器互不顶替（维持既有单例复用）；Mermaid 预览窗口维持既有独立单例，
同样不占名额。VS Code 宿主无多窗口概念，不受影响。

### FR-003：查看器窗口与 Spin 设计器窗口的位置尺寸记忆

查看器名额与 Spin 设计器各记一份「上次窗口矩形」（位置 + 尺寸），持久化到
workspace-state.json；窗口移动 / 缩放防抖落盘，关闭（含被顶替）时补记一次。下次开窗用
保存的矩形，且矩形必须在至少一块现存显示器的工作区上可见（沿用主窗口的可见性判据：
露出面积不足即视为失效）才复用；失效或缺失时按默认尺寸与默认摆放开窗。多显示器拔插
后矩形失效即回退默认，不把窗口开到看不见的位置。

### FR-004：Spin 模式下主输入框禁用

新增 CoreEvent `workModeChanged`（载荷 `{ sessionId, workMode: 'normal' | 'spin' }`），
core 在进入与退出 spin 模式时各广播一次。WebViewUI 订阅后向 webview 下发
`setWorkMode`；webview 对 `sessionId` 非当前会话的事件忽略。当前会话处于 spin 模式时
主输入框禁用（textarea 不可输入、发送不可用），placeholder 显示
`inputArea.placeholderSpinMode`（zh「Spin 模式下不响应用户输入」/ en 同义英文）；abort
按钮三态推导把 spin 模式计为可停止（空闲的 spin 会话也显示停止按钮，作为退出出口），
退出后恢复。两宿主（Electron / VS Code）一致生效（逻辑在总线与 webview 层）。

### FR-005：Spin 模式标记落盘 meta.json 并随会话加载恢复

meta.json 顶层新增可选字段 `workMode: 'normal' | 'spin'`（缺省 `normal`）：core 进入
spin 模式时写 `spin`，退出（完成 / 中止 / 失败 / 恢复态下 abort）时写 `normal`，与
core-rs `SessionState.work_mode` 同步。会话加载（`ensure_loaded`）从 meta.json 恢复
`work_mode`，加载结果（`LoadedConversation` 与 webview 的 `conversationLoaded` 载荷）携带
`workMode`（必填，`normal` 也是事实），webview 据此恢复输入框状态。恢复出的 spin 态
（应用重启后 spin 已不在运行）由会话停止请求退出：`abortRequested` 到达且
`work_mode = spin` 且无运行中的 SpinLoop 时，core 直接置回 `normal`、落盘并广播
`workModeChanged`。落盘格式双侧一致：`src/shared/history/Conversation.ts` 的
`ConversationMetadata` 同步该字段。

### FR-006：提示音默认关闭、默认音量 50%

提醒音（meow 通道，完成与转等待共用、仅后台窗口触发）的默认值变更：`soundEnabled`
缺失或非布尔时按关闭（仅显式 `true` 开启）；`DEFAULT_SOUND_VOLUME` 由 1 改为 0.5。
既有语义不变：偏好设置开关与音量条、调整后预览播放一次、音量收敛 [0, 1]、VS Code 宿主
无此通道。存量用户已显式写入的设置值不受影响。

## 边界与错误路径

- Monaco / 图片页面构建产物缺失（dist 未构建）：维持现状「记日志 + 不开窗」，不顶替、
  也不关闭已有查看器窗口。
- 顶替时旧窗口尚在加载（页面未就绪）：直接销毁旧窗口，加载随窗口销毁取消，不等待就绪。
- workspace-state.json 缺失 / 字段损坏 / 矩形值非法（非数字、非正宽高）：按无记忆处理，
  回退默认尺寸与默认摆放；不抛错、不写回垃圾值。
- meta.json 无 `workMode` 字段（存量会话）或值非法：按 `normal` 加载，不视为错误。
- `workModeChanged` 的 `sessionId` 非当前会话：webview 忽略，不误禁用其它会话；切回时
  由 `conversationLoaded` 载荷恢复正确状态。
- 恢复态 spin 会话中输入框已禁用，`userMessageSubmitted` 不会发生；core 不为恢复态新增
  消息排队语义。
- `soundEnabled` 为非布尔值（旧状态文件异常形态）：按默认关闭处理，与字段缺失同口径。

## 非目标

- 不提供「多查看器窗口」或单实例开关配置——单实例是固定行为，不进设置。
- Mermaid 预览窗口不并入查看器名额、不记位置（其语义是同一图表反复预览复用，保持现状；
  如需纳入另立 spec）。
- 不改变提醒音触发条件（仅后台窗口）、不新增独立完成音或音频资源。
- 不改变 SpinLoop 执行语义、spin.json 结构、`/spin` 命令行为。
- VS Code 宿主不加窗口管理行为（无多窗口概念）；提示音与窗口记忆为 Electron 专属。

## 对需求基线的影响

- 修改 [US-33](../../docs/features/user-stories.md) 验收 4：补「提示音默认关闭、默认音量
  50%，可在偏好设置开启并调整」。
- 修改 [US-38](../../docs/features/user-stories.md)：验收补「Monaco 窗口标题为打开文件名；
  三类查看器共用一个窗口名额、后来者顶替；窗口位置尺寸记忆（多屏失效回退默认）」。
- 修改 [US-39](../../docs/features/user-stories.md)：验收补「`/spin` 执行期间主输入框禁用
  （placeholder 提示），会话 meta.json 落盘 spin 标记、重载恢复；恢复态经停止退出」。
- 无新增 US（均为既有 US 的行为细化）。e2e 登记：查看器窗口单实例 / 位置记忆——
  Playwright 无法断言多 BrowserWindow 生命周期与屏幕坐标，按既有口径登记豁免（顶替决策
  与矩形有效性抽纯函数由单测锁定，窗口行为人工验证）；US-39 输入禁用由 webview 层单测
  锁定（状态 → props 映射），登记豁免；提示音默认值由 soundSettings 单测锁定。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `electron/monaco/main.ts`、`electron/imageViewer/main.ts`（消费 init.title 设页面标题）；`electron/ElectronUIHost.ts` `openMonacoWindow` / `openImagePreviewWindow` | `src/test/viewerWindows.test.ts`（标题决策纯函数）+ 人工验证渲染端 | 自动 |
| FR-002 | `electron/ElectronUIHost.ts`（查看器窗口跟踪与顶替，决策抽纯函数） | `src/test/viewerWindows.test.ts`（新增：顶替决策、名额互斥、bounds 继承） | 自动 |
| FR-003 | `electron/viewerWindowRect.ts`（新增纯函数）、`electron/workspaceStateStore.ts`（rect 字段）、`electron/ElectronUIHost.ts` / `electron/ElectronSpinDesign.ts`（接线）、`electron/main.ts`（复用可见性判据） | `src/test/viewerWindows.test.ts`（矩形有效性 / 多屏判据 / 读写合并） | 自动 |
| FR-004 | `src/shared/AssistantEventBus.ts`（`workModeChanged`）、`src/host/WebViewUI.ts`、`src/host/webviewMessages.ts`（`setWorkMode`）、`src/host/abortButtonState.ts`（事实输入纳入 workMode）、`src/webview/`（App 状态 + InputArea props）、`src/webview/i18n/{zh,en}.ts` | `src/test/abortButtonState.test.ts` 扩展 + webview 状态 → InputArea props 单测 + `src/test/standaloneBus.test.ts` 扩展（事件往返） | 自动 |
| FR-005 | `core-rs/src/spin_host.rs` / `engine.rs` / `history.rs`（落盘与恢复）、`src/shared/history/Conversation.ts`、`src/host/conversationPayload.ts` | core-rs 对照表测试 + `engine_tests`（恢复与 abort 退出）+ `src/test/`（加载载荷带 workMode） | 自动 |
| FR-006 | `electron/soundSettings.ts` | `src/test/soundSettings.test.ts`（默认值断言更新） | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>

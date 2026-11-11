---
status: 已修
---

# 缺陷：后台预热视图永远拿不到 Overlay 能力，「Overlay 对话」勾选框不出现

新建对话的空状态有时不渲染「Overlay 对话」勾选框，另起一个对话视图后才出现。根因不在
Core 的能力探测：能力应答被投给了**回包时刻的活动视图**，而问它的视图不是那个视图。
影响面是 Electron 多视图宿主；VS Code 单视图宿主的默认路由就是唯一 webview，不受影响。

## 现状

1. **回包没有定向到请求视图**：`src/host/ui/webviewMessageHandler.ts` 的
   `handleRequestStorageCapabilities` 用 `this.host.sendToWebview(...)` 回
   `setStorageCapabilities`，`entry('requestStorageCapabilities', ...)` 也不接收 `ctx`。
   Electron 下 `sendToWebview` 经 `ElectronUIHost.sendToRenderer` 落到
   `ChatViewManager.sendToActive`——只发给**回包时刻**的活动视图。同类「按来源回包」的
   查询（`requestSkills` / `requestSessionRuntimeStates` / `requestContextLimit` /
   `requestTheme`）都用 `ctx.sender` + `sendToWebviewView`。
2. **能力只在挂载时问一次**：`src/webview/App.tsx` 里 `useEffect(..., [])` 在每次视图
   挂载时发 `requestStorageCapabilities`，不区分预热视图；`activatePrewarmedView` 的补做
   清单（skills / MCP / models / settingsDefaults / 会话列表 / 运行时状态）里没有它。
3. **结果**：预热视图（Electron 启动期给非活动标签页预加载的视图、`markSessionUsed`
   之后后台补的新对话视图）在后台挂载即发请求，应答被投给当时的前台视图；它自己的
   `workViewCapable` 停在 `null`（等待态）。`showWorkViewOption` 要求
   `workViewCapable === true`，于是空状态不渲染勾选框；它被切到前台（点标签页 / 点
   「新建」复用该视图）也不会再问。Core 支持该能力（`isolatedWorkView: true`）也一样。

## 期望

- 能力应答按来源视图投递：`ctx.sender` 非空时 `sendToWebviewView(sender, message)`；
  为空（单视图宿主 / 宿主主动推送）时走默认路由——与 `handleRequestSkills` 同一口径
  （[docs/architecture/host-ui-modules.md 第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler)
  「需要按来源回包的消息依赖它定向投递」）。
- 能力可用（`isolatedWorkView === true`）时，新对话空状态在 logo 下方渲染「Overlay 对话」
  勾选框；预热视图被切到前台后的新对话同样渲染（specs/045 FR-001 / AC-1）。

## 不变量

- 能力只由 Core 判（`UiRequest.storageCapabilitiesRequested`），宿主不猜平台；
  `isolatedWorkView === false` 时整块入口不渲染（specs/045 AC-2）。
- 勾选框仍只在新对话空状态出现（`messages` 为空且不在加载会话）；wire 载荷与
  `setConversationStorage` 补发路径不变。
- 勾选状态 `workViewSelected` 的本地语义不变；Core 侧「归属一次写定」规则不变
  （[docs/core/conversation-work-view.md 第 2 节](../../docs/core/conversation-work-view.md#2-归属)）。

## 回归测试

- **RT-1**：带来源视图发 `requestStorageCapabilities` 时，`setStorageCapabilities` 只经
  `sendToWebviewView(sender, …)` 投给请求视图、不落到默认路由；无来源视图时走
  `sendToWebview`（落点：`src/test/storageCapabilitiesRouting.test.ts` 的
  `storageCapabilitiesRouting`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- storage-capabilities-routing` | 红 | `FAIL 应答只投给请求视图` / `FAIL 不落到默认路由（回包时刻的活动视图）` / `FAIL 无来源视图时走默认路由`（两条请求都落到默认路由：`toView` 0 条、`toDefault` 2 条） |
| 回归用例（修复后） | `npm run test:unit -- storage-capabilities-routing` | 绿 | 6 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 109 通过 / 0 失败（含 `storageCapabilitiesRouting`）；`npm run check-types` / `npm run lint` / `npm run test:unit -- docs-lint` 同批通过 |
| 启动期真机表现 | — | skipped | 需要 Electron 图形界面：预热视图（非活动标签页 / 后台补的新对话）被切到前台后观察勾选框；评估段只读代码，未真跑复现路径 |

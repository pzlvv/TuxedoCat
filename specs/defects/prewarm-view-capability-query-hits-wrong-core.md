---
status: 已修
---

# 缺陷：预热视图的能力查询落到活动标签页的 Core，「Overlay 对话」勾选框首次启动不出现

Electron 多工作区宿主：首次启动时，非活动标签页的聊天视图是**后台预热视图**（`--prewarm=1`）。
这些视图在新对话空状态里不渲染「Overlay 对话」勾选框；把该标签页点成活动项后关闭再新建
对话（视图重建）才出现。影响面是「能力随工作区不同」的配置——典型形态是本地 Windows
工作区（Core 报 `isolatedWorkView: false, deployable: false`）与远端 Linux 工作区（报
`deployable: true`，装了代理后 `isolatedWorkView: true`）同时打开。

上一轮修的是「应答投给谁」（[specs/defects/work-view-option-missing-on-startup.md](work-view-option-missing-on-startup.md)：
`setStorageCapabilities` 按 `ctx.sender` 直发）。本条是另一半：**问的是哪个 Core**。

## 现状

1. `UiRequest.storageCapabilitiesRequested` 不带任何路由载荷
   （`src/shared/AssistantEventBus.ts` 的 `UiRequest` 成员只有 `type`），
   `requestStorageCapabilities()`（`src/host/coreFacts.ts`）也只能原样发出去。
2. `Client.connectionForRequest`（`src/host/Client.ts`）只对
   `conversationListRequested` 与 watch / unwatch 按 `workspacePath` 路由，其余请求一律落到
   `currentConnection()`——即**最近激活的工作区**的 Connection。因此能力查询总是问
   「当前活动的那个 Core」。
3. 预热视图在后台挂载时就发 `requestStorageCapabilities`（`src/webview/App.tsx` 的启动
   effect）。启动期 `bootstrapCore` 把活动连接对齐到活动标签页，于是预热视图（属于另一个
   工作区）问到的答案是**活动标签页那个 Core** 的。本地 Windows Core 恒回
   `isolatedWorkView: false, deployable: false`，`workViewCapable` 折算成 `false`，
   `showWorkViewOption` 不成立 → 勾选框不出现。
4. 视图被切到前台后不再重问（能力查询只跑一次，`useEffect(..., [])`），所以「点开该
   标签页」本身不修复它；只有重建视图（关闭对话 / 新建对话）才重新问一次，此时活动连接
   已经是该工作区的 Core，答案才正确。
5. 同一条错路由还影响部署闸门：`WebviewMessageHandler.shouldBlockForMountProxy` 等四处
   调用 `requestStorageCapabilities()` 时同样不携带会话 / 工作区，读到的是活动标签页
   Core 的能力，而不是该会话所属 Core 的能力。

## 期望

- **能力查询按「请求方所属工作区」路由**：`UiRequest.storageCapabilitiesRequested` 携带
  宿主侧路由载荷（`sessionId` / `workspacePath`，与 `conversationListRequested`、watch /
  unwatch 同一口径：只在宿主侧参与选 Connection，不改 Core 的语义——Core 侧的应答仍是
  它自己那份能力事实）。
- `WebviewMessageHandler` 处理 `requestStorageCapabilities` 时，用 `ctx.sender` 所属视图的
  工作区（`UIHost.getWorkspaceRefForView`）填路由载荷：预热视图问到的必须是**它自己那个
  工作区的 Core** 的答案。单视图宿主（VS Code）没有 sender，行为不变。
- 部署闸门的三处能力查询按**会话**路由（`sessionId`），保证读到的是该会话所属 Core 的能力
  （[docs/core/conversation-work-view.md 第 1 节](../../docs/core/conversation-work-view.md#1-能力)：
  「能力由 Core 判断……Windows 宿主连 Linux 远端 Core 时宿主不是 Linux，但 Core 是」）。
- 路由载荷给不出唯一 Connection（工作区未打开 / 已关闭）时**报错**，不静默落到活动连接——
  落到活动连接正是本缺陷：界面会拿到另一个 Core 的答案并据此决定是否渲染入口。
- 结果：本地 Windows 工作区与远端 Linux 工作区同时打开、应用首次启动时，远端标签页的预热
  视图在**被切到前台之前**就拿到自己那个 Core 的能力；点开该标签页即渲染「Overlay 对话」
  勾选框，不需要重建视图（specs/045 FR-001 / specs/051 FR-002 的渲染判据不变）。

## 不变量

- 能力**只由 Core 判**（`UiRequest.storageCapabilitiesRequested` 的应答），宿主不按平台
  重算 `isolatedWorkView` / `deployable`，也不缓存（[docs/core/conversation-work-view.md 第 1 节](../../docs/core/conversation-work-view.md#1-能力)）。
- 入口渲染判据仍是 `isolatedWorkView || deployable`，勾选框仍只在新对话空状态出现
  （`messages` 为空且不在加载会话）。
- 回包仍按 `ctx.sender` 定向（[specs/defects/work-view-option-missing-on-startup.md](work-view-option-missing-on-startup.md)），
  这条不回退成默认路由。
- 单视图宿主（VS Code）与「宿主主动推送」（`sender` 为 `null`）仍走默认路由，行为不变。
- 会话 / 会话运行状态 / 技能（`sessionId`）与对话列表、文件监听（`workspacePath`）的既有
  路由规则不变。
- 部署闸门的判据不变：`storage === 'isolated'` 且能力不可用且 `deployable` 才拦截；
  `deployable === false` 走到闸门仍报接线错误（不静默放行）。

## 回归测试

- **RT-1**：两个 Connection（活动 = 本地 A，另一个 = 远端 B），`requestCore` 发
  `storageCapabilitiesRequested` 且带 B 的 `workspacePath` 时，请求只到 B 的通道、不到活动
  连接 A 的通道；不带路由载荷时仍落到活动连接（落点：`src/test/clientConnection.test.ts`
  的「能力查询按工作区路由」用例组）。
- **RT-2**：路由载荷给不出唯一 Connection（工作区未打开）时 `requestCore` reject，不退回
  活动连接（落点：同上用例组「给不出唯一 Connection 时报错」）。
- **RT-3**：带来源视图发 `requestStorageCapabilities` 时，上行 `UiRequest` 携带该视图所属
  工作区的 `workspacePath`，且应答仍只投给请求视图（落点：
  `src/test/storageCapabilitiesRouting.test.ts`）。
- **RT-4**：部署闸门读能力时按会话路由：`isolated` 会话的 `sendMessage` 触发的
  `storageCapabilitiesRequested` 带该会话的 `sessionId`（落点：
  `src/test/storageCapabilitiesRouting.test.ts`）。
- **RT-5**：宿主按视图登记的工作区 **id**（`workspaceRefKey`）能解析回对应引用，同路径
  不同主机的两个远程工作区不互相串；解析不出时不猜（落点：
  `src/test/workspaceRef.test.ts` 的 `findWorkspaceRefByKey` 用例组）。
- **RT-6**：`coreFacts.requestStorageCapabilities` 把两个路由载荷原样带上行，无上下文时
  两字段都是 `null`（落点：`src/test/hostCoreFacts.test.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前）· RT-1 / RT-2 | `npm run test:unit -- client-connection` | 红 | 4 项断言失败：`FAIL 能力查询按 workspacePath 路由到 B 的 Connection` / `FAIL 能力查询不落到活动连接 A` / `FAIL 工作区未打开时报错，不退回活动连接` / `FAIL 未打开工作区的请求没有落到任何通道`（60 通过） |
| 回归用例（修复前）· RT-3 / RT-4 | `npm run test:unit -- storage-capabilities-routing` | 红 | 2 项断言失败：`FAIL 能力查询按来源视图所属工作区路由` / `FAIL 部署闸门的能力查询按会话路由`（9 通过） |
| 定位中发现的第二处断裂 | — | 红 | `ElectronUIHost.getWorkspaceRefForView` 拿 `ChatViewManager.getWorkspaceForWebContents` 的返回值与 `ref.path` 比较，而那里登记的是工作区 **id**（`workspaceRefKey`）：两者永不相等，解析恒退回活动工作区。只接通路由载荷不够，视图仍会被判成属于活动标签页，故补 RT-5 |
| 回归用例（修复后）· RT-1 / RT-2 | `npm run test:unit -- client-connection` | 绿 | 64 通过 / 0 失败 |
| 回归用例（修复后）· RT-3 / RT-4 | `npm run test:unit -- storage-capabilities-routing` | 绿 | 11 通过 / 0 失败 |
| 回归用例（修复后）· RT-5 | `npm run test:unit -- workspace-ref` | 绿 | 27 通过 / 0 失败（含 4 条 `findWorkspaceRefByKey` 断言） |
| 回归用例（修复后）· RT-6 | `npm run test:unit -- host-core-facts` | 绿 | 20 通过 / 0 失败 |
| 既有回归 | `npm run test:unit` | 绿 | 114 通过 / 0 失败 / 2 跳过（`sidebarDocViewGit` / `sidebarFiles` 环境前置不满足） |
| 类型与 lint | `npm run check-types && npm run lint` | 绿 | 三份 tsc 0 error；eslint 0 warning |
| 文档闸门 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格五节 + 验证记录红绿两行齐全；事件表与契约清单未漂 |
| 真机表现（首次启动预热视图的勾选框） | — | not-run | 需要 Electron 图形界面，且要本地 Windows 工作区与远端 Linux 工作区同时打开才有能力差异：未真跑启动路径，逻辑链由 RT-1 / RT-3 / RT-5 分段锁定 |

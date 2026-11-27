---
status: 已收敛
---

# 改动规格：Overlay 对话的部署检测先于消费输入

新对话勾选 Overlay 后按下发送时，部署检测发生在**输入已被消费之后**：webview 先清空输入框、
清掉新对话草稿暂存、生成会话 id、往对话列表插占位条目、写命令历史，再把 `sendMessage` 交给
宿主；宿主这时才判「该会话是 `isolated` 归属且当下建不了视图」，需要部署就弹确认框。
用户取消部署后，被打断的不是「一次发送」，而是一串已经落地的界面动作：内容靠宿主事后推一条
`userMessageDraftRestored` 送回去，而图片、文件引用、勾选态之外的光标与列表占位条目、命令历史
都没有对应的回退通道——界面回不到发送前。

本规格把部署检测提前到**消费输入之前**：发送拆成「提交请求（载荷快照）」与「受理后消费」两步，
检测属于第一步的裁决；裁决到达之前输入区的一切状态保持不变。裁决为「需要部署」时弹既有确认框，
用户取消则这次提交**整体作废**，载体（输入区草稿 / 空闲挂起项）原样留在原处——不是「清空后再回填」。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/mount-proxy.md](../../docs/core/mount-proxy.md) | [2.0 部署触发时机](../../docs/core/mount-proxy.md#20-部署触发时机) | 修改 | 新对话勾选 Overlay 的时机改写为「发送检测先于消费输入」；取消 = 本次提交作废、输入区原样 |
| [docs/core/conversation-work-view.md](../../docs/core/conversation-work-view.md) | [1. 能力](../../docs/core/conversation-work-view.md#1-能力) | 修改 | 部署入口表里「发第一条消息」的取消语义改为「载体不动」，与打开已有对话那一行同一收尾形态 |
| [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) | [FR-001：唯一入口](../../docs/features/user-message-pipeline.md#fr-001唯一入口) | 修改 | 唯一入口新增「受理后才消费」一步：内容、会话 id、列表、命令历史只在上送前一次性结算 |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [3. WebviewMessageHandler](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | `sendMessage` 的受理语义与新增下行裁决消息；`userMessageDraftRestored` 从分发表消失（消息类型数随之变化） |
| [docs/hosts/webview-facts.md](../../docs/hosts/webview-facts.md) | [3. 事实清单](../../docs/hosts/webview-facts.md#3-事实清单) | 修改 | 新增「本次提交的裁决」这一宿主事实：webview 收到它才消费，未到达时保持等待态 |
| [docs/hosts/webview-ui.md](../../docs/hosts/webview-ui.md) | [11. 消息区视图行为](../../docs/hosts/webview-ui.md#11-消息区视图行为) | 修改 | 部署确认框改为应用级模态：遮挡范围、焦点圈定、只读浏览与 Escape 取消 |
| [docs/hosts/electron-multi-workspace.md](../../docs/hosts/electron-multi-workspace.md) | [5. 标签页](../../docs/hosts/electron-multi-workspace.md#5-标签页) / [9. 侧栏](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 修改 | 部署确认框与提交在飞行期间禁用标签页切换（含快捷键）与侧栏的打开 / 新建 / 关闭 / 删除对话 |
| [docs/hosts/host-matrix.md](../../docs/hosts/host-matrix.md) | [6. 宿主固有差异（有意保留）](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 修改 | 模态拦截的宿主侧落点：VS Code 只有 webview 内入口，Electron 另含主进程 IPC 与菜单动作；判据同一份 |

## 用户场景与验收标准

- 场景 1：检测期间输入区不动
  - **AC-1**（FR-001）：GIVEN 新对话勾选 Overlay 且该会话所属 Core 报 `isolatedWorkView: false`、`deployable: true` WHEN 用户按下发送 THEN 检测结论到达前输入框文本、粘贴图片、当前文件引用、勾选态与光标位置逐项保持原值，当前会话 id 未变、对话列表未新增条目、命令历史未写入、消息区没有用户气泡
  - **AC-2**（FR-001）：GIVEN 用户以「空闲发送」提交一条 Overlay 消息 WHEN 空闲触发提交、部署检测进行中 THEN 该挂起项仍登记在横幅上，输入区与对话列表不动
- 场景 2：需要部署
  - **AC-3**（FR-002）：GIVEN 检测结论为「需要部署」WHEN 宿主推了确认态 THEN 弹出既有部署确认框（四项事实文案与三选一流程不变），输入区与对话列表仍保持 AC-1 的发送前状态
  - **AC-4**（FR-002）：GIVEN 该会话归属 `isolated` 且 Core 报 `deployable: false` WHEN 用户按下发送 THEN 不弹确认框、以 Core 给出的 `reason` 报错，输入区原样且 Core 未收到该消息
- 场景 3：取消部署
  - **AC-5**（FR-003）：GIVEN 部署确认框已弹出 WHEN 用户选择取消 THEN 文本、粘贴图片、当前文件引用、勾选态与光标位置与发送前逐项一致
  - **AC-6**（FR-003）：GIVEN 部署确认框已弹出 WHEN 用户选择取消 THEN 当前会话 id 与发送前相同、对话列表没有新增条目、命令历史没有新增、没有排队项或空闲挂起项、消息区没有用户气泡，且 Core 从未收到该条 `userMessageSubmitted`
  - **AC-7**（FR-003）：GIVEN 同一条草稿 WHEN 用户连续三次「发送 → 取消」 THEN 三次结束后输入区内容与状态字符串完全一致，且每次都只有一次检测、一次确认框
  - **AC-8**（FR-003）：GIVEN 空闲挂起项触发的确认框 WHEN 用户选择取消 THEN 该挂起项仍登记在横幅上、不自动重试、不回填输入区、没有消息进入 Core
- 场景 4：受理后消费并上送
  - **AC-9**（FR-004）：GIVEN 检测结论为「可发送」WHEN 裁决到达 THEN 消费与上送各发生一次：输入区清空一次、Core 收到该条 `userMessageSubmitted` 一次，不因裁决与后继投影的到达顺序而重复
  - **AC-10**（FR-004）：GIVEN 一次提交的裁决尚未返回 WHEN 用户再次按发送或继续输入 THEN 输入区只读、不产生第二次提交请求，裁决返回后恢复可编辑
  - **AC-11**（FR-004）：GIVEN 一次提交已发出 WHEN 裁决尚未返回 THEN 消息区与排队横幅上都不出现该消息的乐观气泡或排队项
- 场景 5：部署成功
  - **AC-12**（FR-005）：GIVEN 部署成功且重查能力已就绪 WHEN 宿主继续原提交 THEN Core 收到的是**原载荷**（内容、图片、文件引用、询问模式、思考强度、模型身份、联网搜索、`isolated` 归属全部保留），用户没有再次按发送
  - **AC-13**（FR-005）：GIVEN 部署流程结束后重查能力仍不可用 WHEN 宿主收尾 THEN 明确报错、无消息进入 Core，输入区与 AC-1 的发送前状态一致
- 场景 6：回填补偿通道退场
  - **AC-14**（FR-006）：GIVEN 取消或部署失败 WHEN 检查两端消息流 THEN 上下行都不出现 `userMessageDraftRestored`（该消息类型与 webview 处理分支已不存在），输入框内容自始至终没有离开
  - **AC-15**（FR-006）：GIVEN 用户取消部署 WHEN 检查 webview 上行的消息 THEN 该次尝试没有发出过 `sendMessage`
- 场景 7：确认框是应用级模态（单视图与多视图宿主都要）
  - **AC-16**（FR-007）：GIVEN 部署确认框的任一态（`confirm` / `running` / `needsCredential` / `failed`）WHEN 用户查看界面 THEN 确认框遮住整个聊天视图，输入区、对话列表 / 对话树、新建对话入口、历史按钮都不响应点击，焦点在确认框内，`Tab` / `Shift+Tab` 只在框内控件之间循环
  - **AC-17**（FR-007）：GIVEN 确认框打开 WHEN 用户按 `Escape` 或点遮罩 THEN 等价于取消（沿用现状，所有态一致），本次提交作废、界面回到发送前
  - **AC-18**（FR-007）：GIVEN 确认框打开 WHEN 用户滚动消息区 THEN 只读浏览照常（滚轮与键盘滚动作用于消息区），但点击不穿透、不改任何状态，框内文案不随之滚走、焦点不离开框
  - **AC-19**（FR-007）：GIVEN VS Code 单视图宿主 WHEN 确认框打开 THEN 对话树 / 历史按钮 / 新建对话入口的全部点击路径都不切换对话，当前对话与消息区内容停在发送前那一个
  - **AC-20**（FR-007）：GIVEN Electron 多视图宿主 WHEN 确认框打开 THEN 标签页切换（含 `Ctrl+Tab` 快捷键）、侧栏的点选 / 新建 / 关闭 / 删除对话、标题栏菜单里的对话与工作区动作都不生效，界面停在原对话
  - **AC-21**（FR-007）：GIVEN 一次提交的裁决尚未返回（还没弹框）WHEN 用户点另一个对话、点新建对话或切标签页 THEN 结论返回前这些入口都不生效，当前对话不变；结论为「需要部署」时按 AC-16 锁住界面，结论为「可发送」时照常上送原会话

## 功能需求

### FR-001：部署检测先于消费

用户消息从输入区到 Core 的路径分两步：**提交请求**（载荷快照）与**受理后消费**。部署检测是第一步
的裁决，不是第二步的副作用。

- 消费指可观察的界面与协议动作：清空输入框、清掉新对话草稿暂存、生成并切换会话 id、往对话列表
  条目里插入占位项、写命令历史、登记排队项或空闲挂起项、画用户气泡、上行 `sendMessage`。
- 裁决到达之前，上述动作一个都不发生。请求载荷把这次要用的内容与会话 id 带上，但会话身份、列表
  与历史只在受理时结算。
- 载体有两处，检测点都在「载体内容被取走」之前：立即发送是输入区草稿，空闲发送是横幅上的挂起项。
- 既有发送前置守卫（空内容、一次一条、无工作目录、服务商未配置）不变，仍先于部署检测。

### FR-002：裁决与确认框

宿主对一次提交给出裁决，取值只有三种，语义固定：

- **可发送**：能力当下可用，或该会话不是 `isolated` 归属——受理并按既有链路继续。
- **需要部署**：`isolated` 归属且 `isolatedWorkView === false`、`deployable === true`——弹既有部署
  确认框；确认框的文案、三选一、密码通道与不设重试上限全部沿用
  [docs/core/mount-proxy.md](../../docs/core/mount-proxy.md)，本规格不改。
- **拒绝**：`deployable === false` 说明入口本就不该渲染，属接线错误——直接报错并带 Core 的
  `reason`，不弹框、不静默放行。

确认框的确认态只能由「需要部署」这一条裁决产生；能力可用时导出任何提示都不成立。

### FR-003：取消即本次提交整体作废

用户取消部署时，这次提交不复存在，界面回到发送前：

- 立即发送：输入区文本、粘贴图片、当前文件引用、勾选态、光标位置逐项保持发送前的值；当前会话 id、
  对话列表、命令历史、排队项与消息区都没有被这次尝试触碰过。
- 空闲发送：挂起项仍在横幅上、不自动重试、不回填输入区。
- 取消是幂等的：同一份草稿反复「发送 → 取消」，每次结果与第一次相同。
- 取消不写归属、不建会话、不落盘、不执行任何提权动作。

### FR-004：受理后一次性消费并上送

裁决为「可发送」时，消费与上送在同一次收尾里完成：

- 输入区只清空一次、Core 只收到一条 `userMessageSubmitted`；裁决与该次提交的后继投影（排队登记 /
  乐观气泡）到达顺序不同，结果相同——webview 以裁决为准决定是否消费。
- 同一时刻至多一个未决提交。裁决返回之前输入区只读（不可编辑、不可再次发送），裁决返回后恢复；
  已处于排队项或空闲挂起项的会话仍按「一次只有一条」的既有守卫拒绝新的提交。
- 乐观回显与排队登记不早于裁决：未受理的消息不出现气泡、也不登记排队项。

### FR-005：部署成功后按原载荷继续

部署成功且重查能力就绪后，宿主继续的是**原提交**：

- 上送载荷与用户按下发送时构造的快照逐字段相同：内容、图片、文件引用、询问模式、思考强度、
  模型身份、联网搜索与 `isolated` 归属都不重新采集、不丢失。
- 用户不需要再按一次发送，也不需要重新输入。
- 重查后能力仍不可用时明确失败，按 FR-003 的收尾保留发送前状态，不把消息发出去、不改归属、
  不退回普通对话。

### FR-006：回填补偿通道退场

「发送时清空、取消后回填」的补偿不再需要：

- 用户草稿路径上不再有 `userMessageDraftRestored` 的发送方，该下行消息类型与 webview 处理分支一并
  删除——恢复发送前状态靠「从未消费」，不靠事后写回。
- 已受理的消息由宿主重新投递时不存在输入区载体（见边界节），不再进部署确认框。

### FR-007：确认框是应用级模态

部署确认框一打开，界面就只剩这一件可做的事。它的锁不只在 webview 的遮罩层里：

- **锁的范围**：确认框的任一态（`confirm` / `running` / `needsCredential` / `failed`）都锁；只有取消、
  部署成功、部署失败后用户关掉才解锁。锁的粒度是「当前这次提交」，不是会话状态。
- **惰性**：确认框之外的一切界面不响应点击，也不可聚焦——输入区、对话列表 / 对话树、新建对话
  入口、历史按钮、标题栏标签页、侧栏、标题栏菜单。焦点始终在框内，`Tab` / `Shift+Tab` 在框内控件
  之间循环，`Escape` 与点遮罩等价于取消（沿用既有语义，所有态一致）。
- **只读浏览保留**：消息区仍可滚动查看上下文（纯显示，不改任何状态），点击一律不穿透。
- **切换对话一律不生效**：下一 / 上一标签页与工作目录的快捷键、侧栏点选、新建 / 关闭 / 删除对话
  都不执行。判据是「存在打开中的确认框」，不是给每个入口单独加开关——新增入口自动落在锁内。
- **跨宿主同一口径**：VS Code 只有一个 webview，对话树 / 历史按钮 / 新建入口都在这个 webview 里，
  锁在视图内即可成立；Electron 每个对话一个视图，遮罩只盖住当前视图，标签页与原生侧栏在视图之外，
  因此锁必须同时落在宿主侧（主进程的对话 / 工作区动作入口）。
- **锁的事实只有一个 owner**：它由宿主侧的部署闸门事实派生，webview 只是投影——不自己在收到
  `mountProxyDeployState` 时猜「现在该锁了」，也不在解锁时自己判可以切了。
- **提交在飞行期间同样锁**：裁决尚未返回时用户的跳转 / 新建 / 切标签页请求一律不生效（AC-21）；
  否则裁决回来时「发送时的会话」已经不在前台，弹框与取消都无从落到正确的载体上。

## 边界与错误路径

- **部署目标解析失败**（远端连接不可用、会话工作区既非本地 Linux 也非 SSH）：报错，按 FR-003 的
  收尾保留发送前状态，不弹确认框、不消费。
- **能力查询失败**：判据向上失败（报错），不默认放行；输入区原样。
- **提交未决期间切换会话或关闭视图**：按 FR-007 这些入口本就不生效；若宿主侧仍收到（例如窗口从
  系统层面被切走再切回），裁决到达时载体已不属于当前会话则本次提交作废——不消费、不上送，与取消
  同一收尾（写日志点名原因）。
- **提交未决期间的能力变化**：以受理时刻的裁决为准；受理后不再二次判据，避免同一份草稿被判两次。
- **已受理消息的重新投递**（查询收尾后宿主重投排队项）：它没有输入区载体，不进部署确认框；闸门
  判据不通过时丢弃这次重投并写日志点名原因，不弹框、不改输入区（去向：
  [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) 的排队与收尾口径）。
- **部署失败后重试**：确认框留在失败态，载体仍不动、锁仍生效；重试成功走 FR-005，取消走 FR-003。
- **同一个会话连点发送**：第一个未决期间后续点击是 no-op（不排队、不弹第二个框）。
- **确认框打开期间窗口失焦 / 最小化**：锁不因此解除；回到窗口时仍是同一态。
- **确认框打开期间收到别的会话的完成提醒**：提醒事实照常落库，但不在锁期间呈现可点击的入口，
  也不改当前对话 —— 解锁后该会话的未读提醒照常可见。

## 非目标

- 不改部署确认框的四项事实文案、三选一来源、密码不落内存与不限重试次数（[docs/core/mount-proxy.md](../../docs/core/mount-proxy.md)）。
- 不改「打开已有 Overlay 对话」的闸门形态与失败语义
  （[docs/core/conversation-work-view.md 第 1 节](../../docs/core/conversation-work-view.md#1-能力)）。
- 不改 Core 侧的能力判据、`deployable` 的唯一推导点与 agent 代理定位判据。
- 不为提交未决期间的往返做本地能力缓存以省掉这次查询（去向：[docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。
- 不引入发送队列、草稿持久化或跨视图的未决提交复用（去向：[docs/architecture/open-questions.md](../../docs/architecture/open-questions.md)）。

## 对需求基线的影响

无新增 US：可观察效果是既有「取消部署后消息留在输入框、会话保持空状态」要求的收紧与补全
（[docs/core/mount-proxy.md 第 2.0 节](../../docs/core/mount-proxy.md#20-部署触发时机)），不构成新的用户故事。
验收落在本规格的 AC 与既有 e2e 车道 `e2e/webview/overlayMountProxy.spec.ts`（假宿主补上裁决应答），
不新增 US 编号、不改附录映射。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/webview/hooks/useAppHandlers.ts` 的发送入口（提交请求与消费分离）+ `src/host/ui/webviewMessageHandler.ts` 的 `handleUserMessage` 闸门 | `src/test/userMessageSubmitAck.test.ts`、`src/test/mountProxyGate.test.ts`、`e2e/webview/overlayMountProxy.spec.ts` 的提交请求用例 | 自动 |
| FR-002 | `src/host/ui/webviewMessageHandler.ts` 的 `shouldBlockForMountProxy` / `blockMessageForMountProxyAsync` + 既有 `mountProxyDeployState` 推送 | `src/test/userMessageSubmitAck.test.ts`、`src/test/mountProxyGate.test.ts`、`e2e/webview/overlayMountProxy.spec.ts` 的 AC-3 / AC-4 用例 | 自动 |
| FR-003 | `src/webview/hooks/useAppHandlers.ts` 的取消收尾（不消费）+ `src/host/ui/webviewMessageHandler.ts` 的 `handleMountProxyCancel` 去掉回填 | `src/test/userMessageSubmitAck.test.ts`、`e2e/webview/overlayMountProxy.spec.ts` 的「取消后逐项回到发送前」用例 | 自动 |
| FR-004 | `src/webview/hooks/useAppHandlers.ts` 的受理收尾（清空 / 会话 id / 列表 / 历史）+ `src/host/webviewMessages.ts` 的下行裁决消息 | `src/test/userMessageSubmitAck.test.ts`（受理回执与不代发）、`src/test/inputAreaState.test.ts`（未决只读） | 自动 |
| FR-005 | `src/host/ui/webviewMessageHandler.ts` 的 `continueBlockedAction` 按原载荷重投 | `src/test/mountProxyGate.test.ts`（原载荷不丢）、`e2e/webview/overlayMountProxy.spec.ts` 的部署成功用例 | 自动 |
| FR-006 | `src/host/webviewMessages.ts` 删除 `userMessageDraftRestored`、`src/webview/hooks/useMessageHandler.ts` 删除对应分支 | `src/test/userMessageSubmitAck.test.ts`（两端消息流无该类型） | 自动 |
| FR-007 | `src/webview/components/MountProxyDialog.tsx` + `src/webview/components/focusTrap.ts`（焦点圈定）+ `src/webview/App.tsx` 的 `conversationSwitchLocked` 与上报 + `src/host/conversationSwitchLock.ts` 与 `electron/main.ts` 的入口早返回 | `src/test/focusTrap.test.ts`、`src/test/conversationSwitchLock.test.ts`、`src/test/userMessageSubmitAck.test.ts`、`e2e/webview/overlayMountProxy.spec.ts` 的「FR-007 模态锁」用例 | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

- **已满足**：
  - **FR-001 / AC-1、AC-2** → `src/webview/hooks/useAppHandlers.ts` 的 `buildSubmitPayloadFromInput`
    只读输入与前置守卫（不清输入框、不建会话 id、不写列表与历史），未决提交登记在 `pendingSubmitRef`；
    宿主侧 `WebviewMessageHandler.handleSubmitMessage` 裁决前不发 `UiEvent`。证据：
    `userMessageSubmitAck.test.ts` 的「AC-1 裁决前 Core 未收到 userMessageSubmitted」、
    「AC-1 workspace 归属照常受理」、「AC-9 受理不代发」；`overlayMountProxy.spec.ts` 的
    「FR-003 未就绪时发消息弹确认框」断言 `sendMessage` 不出现而 `submitMessage` 出现。
  - **FR-002 / AC-3、AC-4** → `mountProxyVerdict` 三态判别联合（`send` / `needsDeploy` / `reject`）；
    `needsDeploy` 进闸门、`reject` 回 `userMessageRejected{reason}`。证据：
    「AC-3 推了确认态」「AC-3 不推受理回执」「AC-4 拒绝回执携带 Core 的 reason」「AC-4 不弹部署框」。
  - **FR-003 / AC-5～AC-8** → `handleMountProxyCancel` 改为按 `submitId` 回 `userMessageRejected`、
    不再发 `userMessageDraftRestored`；webview 的 `rejectSubmit` 只丢弃未决提交、什么都不改；
    空闲挂起项留到受理之后才清。证据：`userMessageSubmitAck.test.ts` 的「AC-6 取消回一条拒绝」
    「AC-14 取消不发 userMessageDraftRestored」「AC-15 取消后 Core 仍什么都没收到」
    「AC-7 三次都各自作废」；`overlayMountProxy.spec.ts` 的「取消部署：逐项回到发送前」
    「取消后逐项还原：图片与文件引用同样不动」。
  - **FR-004 / AC-9～AC-11** → `commitSubmit` 一次做完消费载体、结算会话 id、乐观列表与命令历史、
    上行；未决提交进入「一次只有一条」守卫，`submitPending` 让输入区只读；乐观回显与排队登记
    都在受理之后。证据：「AC-9 可发送时回一条受理」「AC-9 受理不代发」、`inputAreaState.test.ts`
    的「提交未决 → submitPending」「裁决返回即恢复可输入」。
  - **FR-005 / AC-12、AC-13** → `BlockedAction.message` 携带完整 `SendMessagePayload`，
    `continueBlockedAction` 按原载荷走已受理上行。证据：「AC-12 部署成功后 Core 收到一条」
    及其后四条逐字段原样断言（内容 / 文件引用 / 会话配置 / 模型身份 / 归属）；「AC-13 失败态留在界面上」。
  - **FR-006 / AC-14、AC-15** → `sendMessage` 保留为已受理上行，但草稿路径不再发它；
    `userMessageDraftRestored` 从 wire 联合与 webview 分支一并删除。证据：「AC-14 取消不发
    userMessageDraftRestored」「AC-15 取消后 Core 仍什么都没收到」、`rg 'userMessageDraftRestored' src/`
    零命中。
  - **FR-007 / AC-16～AC-21** → `nextFocusIndex` 纯函数（`src/webview/components/focusTrap.ts`）+ 
    `MountProxyDialog` 的 Tab 圈定与滚轮穿透；`conversationSwitchLocked`（确认框或未决提交）统一
    拦视图内入口；`conversationSwitchLockChanged` 上报 + `ConversationSwitchLock` 按视图记锁，
    Electron 主进程在 `openConversation` / `openNewConversation` / `sidebar:open-conversation` /
    `sidebar:new-conversation` / `sidebar:close-conversation` / `sidebar:delete-conversation` /
    `titlebar:activate-workspace` / 相邻标签快捷键上早返回。证据：`focusTrap.test.ts`（13 条）、
    `conversationSwitchLock.test.ts`（13 条）、`userMessageSubmitAck.test.ts` 的「AC-16 锁上报落到宿主」；
    `overlayMountProxy.spec.ts` 的「FR-007 模态锁」用例（锁事实 + 6 次 Tab / 3 次 Shift+Tab 焦点不逃逸 +
    取消后解锁）。
  - **边界与错误路径** → 「已受理消息在 !deployable 时丢弃并点名原因」「重投遇到需要部署时丢弃、
    不弹框、不进 Core」两条用例；部署目标解析失败沿用既有链路（`mountProxyVerdict` 不改其抛错路径）。
  - **回归**：`npm run test:unit` 138 通过 / 0 失败 / 2 跳过（跳过为既有环境前置；
    新增 `userMessageSubmitAck` / `focusTrap` / `conversationSwitchLock` 三组）；
    `check-types`、`lint`、`docs-lint` 全绿；`npm run test:e2e:webview -- overlayMountProxy` 18/18 绿、
    `npm run test:e2e:electron -- overlayMountProxyLocal` 2/2 绿。
- **偏差**：
  - **未落地 `WebviewMessageHandler.isMountProxyLocked()`**（plan 的 T004 原稿）：锁的判据落在 webview
    的 `conversationSwitchLocked`（确认框状态是 webview 的投影、未决提交是 webview 自己的事实），
    宿主只做落点与拦截。理由与 plan 的被否决方案第 5 条一致：宿主拿不到「哪个视图锁着」，
    按 `sender` 过滤的落点才是正确口径。已在 `tasks.md` 的 T004 就地留痕。
  - **`sendMessage` 的宿主侧部署判据从「拦下 + 弹框」改为「静默复核 + 丢弃并记日志」**：已受理消息
    没有输入区载体，弹框无从落地；spec 的边界节原本就写的是「丢弃这次重投并写日志点名原因」，
    实现与之一致，只是原 `handleUserMessage` 的注释与代码还留着抛错，已同步。
  - **假宿主 `sent` 的过滤语义改为不过滤**：`submitMessage` 必须到达宿主才谈得上裁决，用
    `__fakeHostGateBlocked` 把整条消息从 `sent` 里摘掉会让「提交请求上行了、但已受理消息没上行」
    这个关键事实不可观测。改为记录全部上行、由「`sendMessage` 不出现」承担断言。
- **未做**：无。

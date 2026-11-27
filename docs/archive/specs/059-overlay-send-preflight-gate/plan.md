# 实施方案：Overlay 对话的部署检测先于消费输入

spec 见 [spec.md](spec.md)。技术路线一句话：把「一次发送」拆成**提交请求（`submitMessage`）**
与**受理后消费（`commitMessage`）**两个上行阶段，部署检测挪进提交请求的裁决里，webview 拿到裁决
才消费载体；确认框期间与提交在飞行期间用同一份「闸门锁定」事实锁住对话切换入口。

## 技术方案

### 1. 提交 / 受理两段式（FR-001、FR-004、FR-005）

现状（`src/webview/hooks/useAppHandlers.ts`）：`buildUserMessageFromInput` 一次性做完全部事——
读输入、清输入框、生成 session id、写列表占位、写命令历史——然后 `submitUserMessage` 直接
`postMessage(sendMessage)`。

拆开的落点：

```text
handleSend / handleSendIdle
  └─ buildUserMessageFromInput()        ← 只读输入 + 补图片宽高 + 前置守卫（不清任何状态）
       └─ requestSubmit(wire, carrier)  ← 记未决提交；post 新的提交请求消息
            └─ 宿主裁决（Core 能力 + 归属）
                 ├─ accepted → 下行 userMessageAccepted{...} → commitMessage(wire)
                 │                                        ← 清输入框 / 会话 id / 列表 / 历史 / 上行
                 └─ blocked → 推 mountProxyDeployState(confirm)，提交仍挂起
                                ├─ 取消 → 下行 userMessageRejected → 丢弃未决提交，什么都不动
                                └─ 部署成功 → 复用同一份 wire 直接上送（不经 webview 再消费）
```

关键取舍：

- **载荷在提交时就固定**。`commitMessage` 用的是提交时那份 `SendMessageWire` 快照，不在受理时
  重读输入框——否则用户在检测窗口里改了输入框就会串味（AC-12 的「原载荷」由此成立）。
- **会话 id 在提交时算**，但只在受理时才写进 `currentSessionIdRef` / `setCurrentSessionId`。
  提交请求消息把算好的 id 带给宿主，宿主按它查能力；用户取消则这个 id 从未被使用
  （AC-6「当前会话 id 与发送前相同」）。
- **宿主是裁决方**。webview 不查能力、不判 `deployable`——FR-002 的三态裁决只由
  `WebviewMessageHandler` 产生，webview 只消费结论。
- **部署成功后宿主继续原提交**：`BlockedAction` 已带 `kind: 'message'` + 完整 wire 载荷，
  宿主在 `continueBlockedAction` 里直接 `handleUserMessage(wire)`，**不回调 webview 再消费**
  （否则 webview 的未决提交状态与宿主的重投会各走一次）。

### 2. 新 wire 消息（FR-004、FR-006）

| 方向 | 类型 | 载荷 | 语义 |
| --- | --- | --- | --- |
| webview → host | `submitMessage` | `SendMessageWire` 全字段 + `submitId` | 提交请求；宿主裁决后按 `submitId` 回包 |
| host → webview | `userMessageAccepted` | `submitId`、`sessionId`、`uuid` | 受理：webview 消费载体并上行（或宿主已代发，见下） |
| host → webview | `userMessageRejected` | `submitId`、`reason` | 拒绝 / 取消：丢弃未决提交，界面原样 |
| 删除 | `sendMessage` | — | 用户草稿路径不再发它；宿主侧仍保留该类型给内部重投 |

`sendMessage` 不删：宿主自己重投排队项 / 已消费消息仍用它（`streamHandlers.ts` 的重投、
`continueBlockedAction` 的继续），它是「已受理消息的上行」而不是「用户按下发送」。`submitMessage`
才是用户按钮的唯一出口，两者在宿主侧汇进同一个 `handleUserMessage`。

删除 `userMessageDraftRestored`（FR-006）：它只服务「清空后回填」，两段式之后没有发送方。

### 3. 未决提交的唯一持有者（FR-004、AC-10、AC-11）

webview 侧新增一个 ref 而非 state：

```ts
interface PendingSubmit {
  submitId: string;
  wire: SendMessageWire;
  carrier: 'input' | 'idleSuspended';
}
```

- 用 ref：它是「一次未决的协议往返」，不参与渲染；派生出的只读态（输入区只读）用
  `pendingSubmitVersion` 递增触发重渲染（与既有 `sessionIdleVersion` 同一手法）。
- 「一次只有一条」守卫从「排队项 / 挂起项」扩成「排队项 / 挂起项 / 未决提交」，命中即
  `buildUserMessageFromInput` 返回 null（AC-10）。
- 未决期间不乐观回显、不登记排队项——这两件事都在 `commitMessage` 里，受理后才发生（AC-11）。
- 空闲发送：`carrier: 'idleSuspended'`，挂起项**登记后**才提交请求；取消时挂起项原样留在横幅上
  （AC-8）。这与现状的差别是：现状在触发那一刻就 `delete(sid)` 再从宿主排队，现在要等受理。

### 4. 闸门锁定（FR-007）

锁的事实 owner 是宿主侧的部署闸门，webview 只是投影：

- 宿主：`MountProxyGate` 已有 `currentPhase`。`WebviewMessageHandler` 增加
  `isMountProxyLocked()`：闸门存在且 `phase !== null`（含 `running` / `failed`）。
  该判据同时用于「用户消息入口」与「对话切换入口」，不复制第二份。
- 提交在飞行期间也算锁：webview 侧有未决提交时，`navigateToSession` / `handleNewConversation` /
  `toggleSubSession` 等入口早返回（AC-21）。这是 UI 自己的事实（未决提交由 webview 持有），
  不跨进程，因此不需要宿主参与。
- Electron 侧：主进程的 `openConversation` / `openNewConversation` / `sidebar:*` / 标签页切换
  在收到 webview 上报的「锁定」事实后早返回。上报走既有上行通道：新增
  `conversationSwitchLockChanged`（webview → host，载荷 `locked: boolean` + `reason`），
  主进程把它落在 `chatViews` 之外的一个模块级布尔集合里，按来源视图过滤——
  只锁「有确认框的那个视图所属的对话切换」，不锁别的标签页里的正常操作。

  > 为什么不让主进程自己查闸门：闸门实例在 `WebviewMessageHandler` 里，Electron 主进程
  > 拿不到；而且「哪个视图锁着」是视图级事实，主进程按 `sender` 过滤才不误伤。

### 5. 确认框的惰性与焦点圈定（FR-007）

`MountProxyDialog` 现在已经有 `fixed inset-0` 遮罩，缺三点：

1. **焦点圈定**：`Tab` / `Shift+Tab` 在框内循环。纯函数 `nextFocusIndex(current, length, shift)`
   落在 `src/webview/components/focusTrap.ts`，可单测；组件只调它。
2. **背景惰性**：遮罩本身拦点击已成立（`onClick` + 内层 `stopPropagation`），补
   `aria-hidden` 之外的键盘路径——遮罩层 `onKeyDown` 处理 `Tab` 与 `Escape`，
   并给容器加 `role="dialog"` / `aria-modal="true"`（已有）。
3. **只读浏览**：消息区滚动保留。做法是遮罩层不拦 `wheel`，滚轮事件穿透到消息容器
   （现状遮罩 `fixed inset-0` 会吞掉 wheel，需要在遮罩上显式转发）。

### 6. 测试策略

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 纯函数单测 | `src/test/focusTrap.test.ts` | 焦点循环判据（AC-16） |
| 宿主单测 | `src/test/userMessageSubmitAck.test.ts` | 三态裁决、原载荷、取消无副作用、锁判据（AC-1～AC-15、AC-21） |
| webview e2e | `e2e/webview/overlayMountProxy.spec.ts` | 取消后逐项回到发送前、模态焦点圈定、Escape（AC-5～AC-8、AC-16～AC-18） |
| Electron e2e | `e2e/electron/overlayMountProxyLocal.spec.ts` | 标签页与侧栏锁（AC-19、AC-20） |

假宿主 `e2e/helpers/fakeHost.ts` 补 `submitMessage` 的应答：默认回 `userMessageAccepted`；
在 `mountProxyCapabilities` 表明不可部署时按归属回 blocked（与真实宿主同一判据）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `src/host/webviewMessages.ts` | 修改 | 新增 `submitMessage` / `userMessageAccepted` / `userMessageRejected` / `conversationSwitchLockChanged`；删除 `userMessageDraftRestored` |
| `src/host/ui/webviewMessageHandler.ts` | 修改 | `submitMessage` 分发表项；`handleUserMessage` 拆出裁决；`isMountProxyLocked()` 公开给宿主；`handleMountProxyCancel` 去掉回填、改推 `userMessageRejected` |
| `src/host/mountProxyGate.ts` | 修改 | `BlockedAction.message` 改携带完整 wire 载荷（原载荷不丢） |
| `src/host/UIHost.ts` | 修改 | 新增 `setConversationSwitchLock(sender, locked)`（Electron 主进程据此拦住切换入口；VS Code 空实现） |
| `src/webview/hooks/useAppHandlers.ts` | 修改 | 提交 / 受理拆分、未决提交 ref、锁期间入口早返回 |
| `src/webview/hooks/useMessageHandler.ts` | 修改 | 处理 `userMessageAccepted` / `userMessageRejected`；删除 `userMessageDraftRestored` 分支 |
| `src/webview/components/MountProxyDialog.tsx` | 修改 | 焦点圈定、背景惰性、滚轮穿透 |
| `src/webview/components/focusTrap.ts` | 新增 | 焦点循环纯函数 |
| `src/webview/App.tsx` | 修改 | 锁态的接线与入口早返回、`pendingSubmit` 只读态传给 InputArea |
| `src/webview/InputArea.tsx` | 修改 | 未决提交期间只读 |
| `electron/main.ts` | 修改 | 对话切换入口按锁事实早返回 |
| `src/VSCodeUIHost.ts` | 修改 | `setConversationSwitchLock` 空实现（单视图无需宿主拦截） |
| `e2e/helpers/fakeHost.ts` | 修改 | `submitMessage` 应答编排 |
| `docs/**` | 修改 | 见 spec 的影响基线表 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：新增代码只在 `src/host/`（不 import `vscode` /
      `electron`）、`src/webview/`（只经 `UIHost` 注入）、`src/shared/` 无改动；Electron 侧
      拦截落在 `electron/main.ts`（宿主实现层，允许）。`isMountProxyLocked` 留在 host 层，
      不进 shared。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd))）：裁决三态用判别联合（不写成两个布尔 + 可选字段）；
      锁事实只有一个 owner（`MountProxyGate`），webview 与主进程都只读投影；载荷快照在提交时
      固定，不在受理时重读（避免两个写入点）；不引入「能力缓存」这类 fallback。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不涉及 + 理由——本次只改 TS 宿主的
      上行时序与 webview 交互，Core 的能力判据、`deployable` 推导与落盘格式一个字段都不动，
      `core-rs/` 无 diff，因此不需要 parity 对照表更新。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：受影响规格 8 份（spec 的影响基线表），在收敛阶段
      一次性并入；`docsLint` 校验消息类型数、章节引用与名单对照，实施中途先跑一次确认不误红。

## 被否决的替代方案

1. **webview 自己查能力、自己判要不要弹框**。否决理由：判据要读 Core 事实，webview 只能经
   宿主问——那等于把闸门拆成两处；且 wire 上仍会出现 `sendMessage`，Core 会真的建会话
   （specs/051 FR-003 的 AC-7 断言的正是「消息没有进入 Core」）。
2. **保留 `sendMessage` 作为唯一上行、只把「清空输入框」挪后**。否决理由：清空只是被观察到的
   一串副作用之一；列表占位、命令历史、会话 id、乐观气泡都在同一段里，只挪一处等于把
   「回到发送前」做成六处散落的补丁，下一处漏掉就复发（spec 开篇举的正是这个形态）。
3. **让宿主在受理后回调 webview 再消费**。否决理由：一次提交会跨两个进程来回两趟，webview
   的未决状态与宿主的重投各走一次，重复上送的风险比省下的代码量大；部署成功的继续动作本来就是
   宿主侧的事实（`BlockedAction` 已经带着载荷）。
4. **主进程自己查闸门来锁标签页**。否决理由：闸门实例在 `WebviewMessageHandler`（每视图一份
   语义），主进程拿不到；即便拿得到，「哪个视图锁着」也是视图级事实，按 `sender` 过滤才是
   正确口径。
5. **未决提存放在 React state**。否决理由：它不参与渲染（只有派生出的只读标志参与），
   放 state 会让每次 `postMessage` 都触发一轮渲染；沿用 `sessionIdleVersion` 的 ref + 递增
   版本号手法，与既有代码同一约定。

---
status: 已修
---

# 缺陷：SSH 断连重连后聊天区先于 Connection 就绪恢复，窗口期内发送的对话被静默丢弃

远程工作区链路死亡标红后点「重新连接」，聊天区在 Connection 尚未建立时就恢复可交互
（重连入口把「探测通过 + opened 事件已派发」当成功，daemon 路径的通道建立是异步的）；
此刻 `Client.connections` 为空，用户紧接着发送的对话在路由层抛
`No Connection owns session` 被静默丢弃——无重试、无排队、无 UI 反馈，表现为
「发送对话无反应」。叠加
[workspace-unavailable-teardown-strands-orphan-views](workspace-unavailable-teardown-strands-orphan-views.md)
的孤儿视图，用户此时面对的恰是旧对话，进一步坐实「坏掉了」的观感（需关闭对话重新
打开——那时 Connection 早已就绪，重开的对话走正常登记链路所以能用）。

## 现状

- `reconnectWorkspace`（`electron/main.ts`）的 `finally` 无条件
  `clearConnecting` + `syncChatAreaForActiveWorkspace`：占位页撤掉、聊天区恢复；
  `openRemoteWorkspaceAfterProbe` 在探测通过后 `clearAll` + `emitWorkspaceChange('opened', ref)`
  ——标签页同步变绿。
- 「opened」监听器（`src/host/bootstrapCore.ts` 的 `onWorkspaceChanged`）对
  `openWorkspace(change.ref)` **不 await**；daemon 路径 `openChannel` 返回 Promise
  （要经 SSH 读远端状态文件定位在跑的 daemon，之后才建 channel 与 Connection），
  Connection 注册滞后数秒。复现日志时序：发送抛错在前，`[ssh] reusing running
  daemon at …` 在后。
- 窗口期内 `Client.connections.size === 0`，`connectionForSession` 的唯一连接退路
  不成立，`emitUiEvent(userMessageSubmitted)` 直接抛错，消息丢弃（仅错误日志）。
  Client 的「就绪门禁排队」（Connection `connecting` 态排队帧）帮不上忙：此刻连
  Connection 对象都尚未存在，事件到不了排队层。
- 复现（真实 SSH，SIGSTOP 远端 daemon 制造沉默判死 → 标红 → SIGCONT → 点「重新连接」→
  立即发送）：
  - 紧接发送：死信。`handleWebviewMessage failed for type=sendMessage: Error: No
    Connection owns session "session_…"`，mock LLM 请求数停在 2（消息从未到达 LLM）。
  - 等 20s（Connection 就绪）再发：响应正常到达（请求数 2 → 3）——缺陷只覆盖
    「恢复到就绪」的窗口期，但用户第一反应恰恰是在窗口期里发送。
- 启动恢复路径（`probeStartupRemoteWorkspaces` → 探测成功 → opened）同样是
  「opened 即撤 connecting」，存在同构窗口（启动期用户尚未输入，实际暴露小，语义
  一并修正）。

## 期望

- 重连（含启动恢复）的标签页与聊天区在 Connection **就绪（coreReady）前**保持
  connecting 表现（黄色呼吸点 + 「正在连接」占位页）：用户在就绪前不可达输入框，
  窗口期不暴露给输入链路。
- 就绪信号（`onWorkspaceConnectionState` 的 ready）落定时才恢复聊天区（撤占位页、
  恢复 / 新建对话视图）；建链失败由既有 lost → `markWorkspaceUnavailable` 落红，
  不需要额外超时兜底。
- 就绪后发送的对话正常往返（现状已满足，回归锁定）。

## 不变量

- Client「查不到归属报错、不静默丢弃」的路由语义不变：不在路由层为窗口期开
  排队 / 重试旁路（[docs/core/client-connection.md 第 6 节](../../docs/core/client-connection.md#6-会话路由)）。
- 标签页三态状态机（available / unavailable / connecting）语义不变：connecting
  表示「建链中」，ready 才落 available。
- 本地工作区（stdio 通道，Connection 同步注册、coreReady 异步）同样按本语义收敛。
- 正常打开新工作区（添加目录）的既有表现不变。

## 回归测试

- **RT-1**：真实 SSH 场景（electron-ssh 车道）：链路死亡标红 → 重连 → 聊天区恢复
  （建链中收场）后**立即**发送一条对话，断言响应到达（mock LLM 请求数递增、回复
  气泡可见）；20s 后再发一条，断言同样往返（锁定恢复后路由稳定）。现状红：恢复后
  窗口期与就绪后的发送均死信（孤儿 + 无唯一连接退路下持续抛路由错误）。修复后
  聊天区恢复即已就绪，紧接发送必然落在就绪后。（落点：
  `e2e/electron/remoteSshExecution.spec.ts`「SSH 断连标红重连：孤儿视图清零、恢复后
  发送正常往返」，与
  [workspace-unavailable-teardown-strands-orphan-views](workspace-unavailable-teardown-strands-orphan-views.md)
  共用场景）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `E2E_DEBUG=1 npx playwright test -c e2e/playwright.config.ts --project=electron-ssh -g "孤儿视图清零"` | 红 | 紧接发送与就绪后发送均死信（LLM 请求数停在 2）；主进程日志 `handleWebviewMessage failed for type=sendMessage: Error: No Connection owns session "session_…"` |
| 回归用例（修复后） | 同上 | 绿 | 恢复后紧接发送响应到达（LLM 请求数 2 → 3），20s 后再发同样到达（→ 4） |
| 既有回归（单测全量） | `npm run test:unit` | 绿 | 85 通过 / 0 失败 / 1 跳过（sidebarFiles 环境前置不满足，既有 skip 分支）；docsLint 含两份缺陷规格的闸门校验 |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 三份 tsc 配置与 eslint 无错误 |
| 新视图启动期配置事件丢失（相邻观察） | — | not-run | 修复后重连新建对话的启动期 `setAgentMode` / `setModel` 等配置事件仍会因会话尚未登记（登记先于配置事件才生效）在多连接下路由抛错丢弃——**既有独立缺口**（正常打开新对话同样存在，多连接宿主限定），不属本缺陷修复面，已另行告知使用者 |

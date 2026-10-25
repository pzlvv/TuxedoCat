---
status: 已修
---

# 缺陷：首条消息抢跑 startNewConversation 上报时视图未晋升，manual 权限确认永久挂起

新对话的**第一条消息**若抢在 webview 挂载后 500ms 的 `startNewConversation` 上报之前发出
（发送路径会自己生成 session id，`src/webview/hooks/useAppHandlers.ts` 的
"Generate session ID if not exists"），Electron 宿主永远不知道「这个视图现在是哪个会话」：
`ChatViewManager` 的视图键停在 `new-` 临时键，`getLoadedSessionIds()` 按定义排除它，
`WebviewMessageHandler.isSessionOpen()` 恒为 false。后果是 `UserChoiceQueue.enqueue` 把
manual 模式的权限确认请求登入 pending 后**永不投递**（open=false 走「等会话 open 后重投」
分支，而没有任何后续事件会再触发）——用户看到的是：不弹确认框、回合无任何进展、无报错，
即「远程工作区无法执行」的一种确定性形态（本地工作区同样存在该竞态，只是真人很难在
500ms 内完成点击+输入；SSH 远程工作区的 e2e 以自动化速度稳定踩中）。

基线是 [docs/hosts/webview-facts.md](../../docs/hosts/webview-facts.md) 的会话身份上报口径与
`UserChoiceQueue` 的投递语义（open 即投递到该会话自己的视图）：视图正在显示该会话、用户
正在其中对话，它就是 open，缺失的只是宿主侧的身份登记。

## 现状（修复前）

- `electron/main.ts` 的 `handleWebviewMessageFromSource` 只在 `startNewConversation` /
  `loadConversation` 两条消息上调用 `chatViews.registerSession(sender, sessionId)` 晋升
  `new-` 临时键；`sendMessage` 分支只调 `markSessionUsed`。
- webview 发送路径（`useAppHandlers.ts`）在 `currentSessionIdRef` 为空时自建 session id 并
  直接发 `sendMessage`，**不发** `startNewConversation`；随后挂载 500ms 定时器里的
  `onStartup` 因 `currentSessionIdRef` 已有值而早退（`useAppHandlers.ts` 的
  「如果已有 session，不重复生成」），上报永远不会补发。
- 实测（真实 SSH 远程工作区 + manual 模式 + mock LLM 的 Bash 工具轮）：
  `UserChoiceQueue` 日志 `Enqueued choice for session session_…, open: false`，
  60s 内无任何页面出现 `.user-choice-overlay`，回合无进展；同一链路 auto 模式正常
  （策略放行不依赖确认框），因此该缺陷只在 manual（默认档）下显形。
- core 侧无辜：插桩证实会话 `agent_mode=manual`、快照正常，
  `resolve_permission` 的初始 behavior 是 ask——请求确实发出了，卡在宿主投递侧。

## 期望

- 视图身份的确立有三个入口：`startNewConversation`、`loadConversation`、以及「携带新
  session id 且来源视图仍是 `new-` 临时键的 `sendMessage`」。第三种到达时同样晋升
  （`registerSession`），使该会话进入「已打开会话」集合、`isSessionOpen()` 为 true。
- 晋升必须发生在 `markSessionUsed` 之前：`registerSession` 会把临时键的「未发送新对话」
  标记迁移到正式 id，先标记再晋升会漏删、导致该视图被误判为仍可复用的空新对话。
- 已晋升（键等于 sessionId）时 `registerSession` 是空操作，正常路径行为不变。

## 不变量

- `getLoadedSessionIds()` 的定义不变：排除 `new-` 临时键、只算存活视图。
- `handleStartNewConversation` 的重语义（conversationStarted / conversationOpened /
  默认值回推 / 配置面板）**不**因本缺陷扩展到 sendMessage 路径——sendMessage 只做视图
  身份晋升，不触发新对话初始化（避免默认值回推覆写用户已改过的会话配置）。
- UserChoiceQueue 的「open 即投递 / 未 open 挂起等重投」语义不变。

## 回归测试

- **RT-1**：`e2e/electron/remoteSshExecution.spec.ts` 的
  「manual 权限模式：远程 Bash 弹确认、允许后在远端执行」——真实 SSH 远程工作区上，
  Playwright 以自动化速度在视图挂载后 ~200ms 发出首条消息（稳定踩中竞态窗口），
  断言确认框出现、点击允许后命令在远端执行（tool_result 含 `uname -s` 的 Linux 输出）。
  SSH 环境从 `e2e/environments.json` 读取（`e2e/README.md`「测试环境配置」）；配置缺失
  / 形状非法或连不上时用例**直接报错**（每用例开头的环境有效性判断），不跳过、不进常规车道。
- **RT-2**：本地回归——`e2e/electron/backgroundBash.spec.ts` 的 manual 权限流不受晋升
  顺序调整影响（修复后整文件绿）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 修复前（manual 用例） | `npm run test:e2e:electron -- remoteSshExecution` | 红 | 60s 等不到 `.user-choice-overlay`；diag 扫描全部页面无确认框，第二轮 LLM 请求照常到达（read-only 白名单命令）或挂起（非白名单命令） |
| 修复后（2026-10-25，真实 SSH 172.20.56.28 Arch Linux x86_64） | 同上；另 `npm run test:e2e:electron -- backgroundBash` | 绿 | `remoteSshExecution.spec.ts` 9/9（含冷部署 / 强杀清理 / 陈旧状态文件 / manual 权限）；`backgroundBash.spec.ts` 本地 manual 权限绿 |

---
status: 已修
---

# 缺陷：提交裁决遇到闸门异常时没有裁决，webview 的未决提交永久挂起

用户按下发送后，宿主对 `submitMessage` 做三态裁决（可发送 / 需要部署 / 拒绝）。裁决链路上
任何一步抛错时，这条消息既不回 `userMessageAccepted` 也不回 `userMessageRejected`——
异常只被 `handleWebviewMessage` 的统一兜底记进日志。webview 的 `pendingSubmitRef` 于是
永远不为 `null`，输入区按「未决提交」保持只读（`InputArea` 的 `submitPending`），那条消息
从未进入 Core。界面上没有任何错误态，用户看到的是「点了发送，输不进去、也没有回复」。

`all` 车道的偶发红是它的一个可观察面：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
AC-31 在「等工具结果回投」上 45 秒超时、`Received string: ""`（run `45930019983`），
而该会话的 `meta.json` 既没有 `storage` 也没有 `messageCount`——`userMessageSubmitted`
从未到达 Core。同轮相邻用例的会话两者都有。

## 现状

`WebviewMessageHandler.handleSubmitMessage`（`src/host/ui/webviewMessageHandler.ts`）先
`ensureSessionWorkspace`，再 `await this.mountProxyVerdict(...)`，然后按
`send` / `needsDeploy` / `reject` 三态回执。这条 await 链上有两处会抛：

1. **能力查询失败**：`mountProxyVerdict` 里 `requestStorageCapabilities({ sessionId })`
   直接向上抛。路由不到该会话的 Connection（`Client.connectionForRequest` 回 `null` →
   `No Connection can serve request(storageCapabilitiesRequested).`）、Connection 已关闭、
   或 Core 侧应答出错，都走这条。
2. **部署目标解析失败**：`blockMessageForMountProxyAsync` 里
   `this.host.resolveMountProxyTarget(sessionId)` 回 `null` 时主动 `throw`（宿主解析不出
   部署目标）。

部署通道上还有两条同形态的入口，它们重查能力同样没有收尾：`applyDeployOutcome` 的
`installed` 分支与手动命令轮询 `handleMountProxyManualCommand` 的 `poll`，都在
`requestStorageCapabilities` 之后只做 `gate.fail(...)`——闸门进了失败态，被拦的提交却
既没拿到受理也没拿到拒绝。

这些异常都冒泡到 `handleWebviewMessage` 的 `try/catch`，只写一条
`handleWebviewMessage failed for type=submitMessage` 日志（`src/host/ui/webviewMessageHandler.ts`
的兜底分支）。`replySubmitAccepted` / `replySubmitRejected` 一次都没调用，于是：

- webview 侧 `useAppHandlers` 的 `pendingSubmitRef.current` 停在登记值，`commitSubmit` 与
  `rejectSubmit` 都因为「收到的 submitId 对不上任何未决提交」而不生效——没有任何收尾；
- 输入区按「未决提交」保持只读，`buildSubmitPayloadFromInput` 的
  `if (props.pendingSubmitRef.current !== null) return null` 让后续每次发送都直接返回；
- 那条消息从未上行到 Core，落盘痕迹为零。

[specs/059 的「边界与错误路径」](../../docs/archive/specs/059-overlay-send-preflight-gate/spec.md) 已经定义了两处的应有收尾：
能力查询失败是「判据向上失败（报错），**不默认放行**；输入区原样」，部署目标解析失败是
「**报错**，按 FR-003 的收尾保留发送前状态，不弹确认框、不消费」。而 FR-003 的收尾就是
`userMessageRejected` + 载体从未被消费——不是「什么都不回」。

## 期望

- **一次提交必然拿到裁决**：`handleSubmitMessage` 在 `send` / `needsDeploy` / `reject`
  之外不再有第四种结局。裁决链路上任何一步失败都收敛成 `userMessageRejected`，
  `reason` 点名失败原因（能力查询的异常文案 / 解析不出部署目标）。
- **部署通道同样必须收尾**：部署成功后重查能力失败（抛错或仍不可用）时，闸门进失败态
  **并**给被拦的提交回拒绝回执；两条部署通道（免密 / 凭据、手动命令轮询）同一口径。
- 失败同时**记日志**：诊断信息不能因为改走回执而丢，日志内容与判据文案同源。
- 不默认放行：失败绝不退化成 `userMessageAccepted`，那条消息仍然不进 Core。
- 载体仍不被消费：拒绝回执走 `rejectSubmit`，输入区内容、图片、文件引用、勾选态与光标
  原样（[specs/059](../../docs/archive/specs/059-overlay-send-preflight-gate/spec.md) FR-003 的 AC-5 / AC-6）。
- 收尾后输入区恢复可编辑（同一规格 FR-004 的 AC-10「裁决返回后恢复可编辑」）。

## 不变量

- 三态裁决的语义与载荷不变：`userMessageAccepted { submitId, sessionId }`、
  `userMessageRejected { submitId, reason }`，`submitId` 原样回带。
- 可发送路径（能力就绪）与非 Overlay 路径（`storage: 'workspace'`）的行为不变：仍只回
  `userMessageAccepted`，仍不代发——上送由 webview 拿到回执后自己走 `sendMessage`。
- `needsDeploy` 路径不变：仍弹确认框、仍不回受理回执、仍不消费载体。
- 部署目标解析失败的**原因文案**不变（仍是「宿主解析不出部署目标」那条），只是落点从
  「未处理异常」改成拒绝回执的 `reason`。
- 已受理消息（`sendMessage`）在能力不可用时的静默丢弃语义不变：那条没有载体可弹框，
  丢弃 + 记日志，不回执（`docs/features/user-message-pipeline.md`）。

## 回归测试

- **RT-1**：能力查询抛错时仍必须有裁决——回 `userMessageRejected`、`reason` 点名失败原因、
  Core 未收到该消息、日志里有该失败（落点：`src/test/userMessageSubmitAck.test.ts` 的
  `submit-verdict-lost-on-gate-error` 组）。
- **RT-2**：部署目标解析不出时同样必须有裁决——回 `userMessageRejected`、不弹确认框、
  Core 未收到该消息（同上落点）。
- **RT-3**：部署后重查能力仍不可用时也必须回拒绝回执（不误发受理、Core 未收到、
  闸门留失败态）（同上落点）。
- **RT-4**：部署后重查能力抛错时回拒绝回执、闸门留失败态、Core 未收到、记日志
  （同上落点）。
- **RT-5**：失败没有把「三态」变成第四态——可发送路径仍只回受理、`needsDeploy` 路径仍
  既不回受理也不回拒绝（由既有 AC-1 / AC-3 / AC-9 用例继续锁定）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- user-message-submit` | 红 | 首轮（只加了 RT-1 / RT-2）：46 通过 / 4 失败，失败项正是缺陷形态——`FAIL RT-1 能力查询失败也必须有裁决（拒绝回执）`、`FAIL RT-1 拒绝原因点名能力查询失败`、`FAIL RT-2 部署目标解析失败也必须有裁决（拒绝回执）`、`FAIL RT-2 拒绝原因点名解析不出部署目标`；`broadcasts` 里既无 `userMessageAccepted` 也无 `userMessageRejected`。同一批的旁证断言全绿（`ok RT-1 失败不放行`、`ok RT-1 失败仍记日志`、`ok RT-2 不弹确认框`、`ok RT-2 Core 未收到该消息`、`ok RT-2 失败仍记日志`），证明缺口精确落在「回执」这一格 |
| 回归用例（修复后） | `npm run test:unit -- user-message-submit` | 绿 | 56 通过 / 0 失败（RT-1～RT-4 共 19 条断言；既有 AC-1 / AC-3 / AC-9 / AC-12 / AC-13 与边界组一并通过） |
| 可证伪性（RT-1～RT-4） | `git stash push src/host/ui/webviewMessageHandler.ts` 后重跑上一条 | 红 | 43 通过 / 6 失败：`FAIL RT-1 …`、`FAIL RT-2 …` 与两条 `TypeError: gate.finishDeployAndContinue is not a function`（RT-3 / RT-4 依赖的新收尾方法在旧代码里不存在）——四条用例都咬住缺口，恢复修复后全绿 |
| 既有回归 | `npm run test:unit` | 绿 | 140 通过 / 0 失败 / 2 跳过（跳过为既有环境前置 `sidebarFiles` / `sidebarDocViewGit`）；含 docs-lint 两套件 |
| 静态检查 | `npm run check-types` / `npm run lint` | 绿 | 四份 tsconfig 与 eslint 均无输出 |
| CI 实证 | 下一轮 `all` 的 `e2e-ssh` 车道（`overlayMountProxyRemote`） | not-run | 需推送后由整点车道或手动 dispatch 验证；本机无自托管 runner 与远端 sudo 账号 |

---
status: 已修
---

# 缺陷：`launchApp` 内部无参 `waitForChatPage()` 架空调用方的聊天视图超时

`e2e/helpers/electronApp.ts` 的 `launchApp` 在返回 `AppHandle` 之前无条件调用一次
`waitForChatPage()`（无参数）。该调用的 `opts` 为空对象、超时取函数默认值 45s，
而 `AppHandle.chatPage(opts, timeoutMs)` 声明的超时是**调用方传入**的。于是所有
「启动后等远端工作区恢复」的用例都无法用自己声明的预算等待：内部 45s 一到就抛错，
调用方写的 180s / 120s 从未生效。CI 上远端工作区恢复一旦超过 45s，整条 `electron-ssh`
车道的第一条用例即失败，后续用例连带（`maxFailures: 3` 提前终止，14 条只跑 6 条）。

## 现状

`launchApp` 的收尾（`e2e/helpers/electronApp.ts` 里 `const chatPage = await waitForChatPage();` 那一处）：

```ts
const chatPage = await waitForChatPage();
await chatPage.waitForSelector('textarea.input-textarea', { timeout: 30_000 });
```

`waitForChatPage` 的签名是 `(opts: ChatPageOptions = {}, timeout = 45_000)`，所以这行是
「空 opts + 45s」。它与 `AppHandle.chatPage` 的声明
（同一文件的 `chatPage(opts?: ChatPageOptions, timeoutMs?: number): Promise<Page>`）冲突：
调用方传的超时在这条路径上用不到。

**实证（run `44973531021`，`e2e-ssh（electron/remoteSshExecution.spec.ts）`）**：

| 项 | 值 |
| --- | --- |
| 报错 | `等待活动聊天视图超时（候选 0 个均不满足 {}）` |
| 报错里的 `opts` | **空对象 `{}`**——调用方传的是 `{ workspaceIncludes: 'tuxedo-e2e-ssh' }` |
| 用例 1 耗时 | 78s |
| 调用方声明超时 | 180s（`remoteSshExecution.spec.ts:168`） |
| 12 次失败报错 | 全部同一条，`opts` 均为 `{}` |

78s 的构成与「内部 45s 默认值」吻合：Electron 启动 + mock 约 33s，加内部
`waitForChatPage()` 的 45s 上限。同一份代码在 run `44962124641` 里该用例 29.7s
通过——29.7s < 45s 过、78s > 45s 挂，分界线正是 45s。

**排除项**（评估阶段实测，避免误判）：

- 远端不是瓶颈：负载 0.14 / 4 核、可用内存 3025MB、磁盘 59%、inode 11%、sshd 连接 6。
- CDP 握手不是瓶颈：`connectOverCDP` 成功（报错发生在它之后的视图解析）。
- 不是本地测试污染：上一轮 run 确有本地 `pkill` 杀 CI 远端 Core 的污染，但本轮远端已
  清理干净（`.new` 残留 0、无残留进程），仍复现。

## 期望

1. `launchApp` 的启动后视图等待**不得使用与调用方无关的固定超时**。它要么接受显式的
   启动等待预算并透传给 `waitForChatPage`，要么把「等哪个视图」的决定完全交给调用方。
2. 调用方在 `AppHandle.chatPage(opts, timeoutMs)` 上声明的超时必须在整条启动路径上生效：
   传 180s 时，从 `launchApp` 开始到拿到该视图的总等待不得在 45s 处中断。
3. 报错信息里的 `opts` 必须反映**实际等待条件**：调用方要的是
   `{workspaceIncludes:'tuxedo-e2e-ssh'}` 时，超时文案不得显示 `{}`——否则排障会被
   误导成「调用方没传条件」。
4. 启动阶段失败仍必须杀掉进程树并清沙箱（既有 `killSpawnedApp` 行为不变，见
   `e2e/README.md` 已知坑 17）。

## 不变量

- `launchApp` 的既有调用方（`e2e/electron/*.spec.ts` 里不传超时的那批）行为不变：
  不传预算时仍按默认 45s 等待，不因本次修复变成无限等。
- 启动失败路径的收尸不变：`killSpawnedApp` 照旧杀进程组（POSIX `kill(-pid)` /
  Windows `taskkill /T /F`）并删沙箱。
- `waitForChatPage` 的视图解析优先级不变（工作区过滤 → 空态过滤 → 不在侧栏列表 →
  侧栏活动项 → 最后一个候选）。
- `electron-app` 车道（不碰远端）不受影响：它的视图在启动时就绪，改动不改变其耗时。
- 报错文案的其余部分（候选数量、现有页面列表）保持可读。

## 回归测试

- **RT-1**：`launchApp` 内部那次视图等待不得无参调用 `waitForChatPage()`（无参 = 空 opts
  + 默认 45s，调用方预算失效）（落点：`src/test/e2eLaunchStartupBudget.test.ts`
  的「RT-1 launchApp 内部不得无参调用 waitForChatPage」）。
- **RT-1b**：`launchApp` 的 options 声明 `startupChatWaitMs` 并把它透传给内部那次等待
  （落点：同文件「RT-1b launchApp 声明并透传 startupChatWaitMs」）。
- **RT-2**：不传预算时仍按默认上限失败，不退化成无限等；默认值落在 30s–180s
  （落点：同文件「RT-2 不传预算时仍按默认上限失败」）。
- **RT-3**：超时文案仍打印实际等待条件（`JSON.stringify(opts)`），排障能看出在等什么
  （落点：同文件「RT-3 超时文案仍打印实际等待条件」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `npm run test:unit -- e2eLaunchStartupBudget` | 红 | RT-1 报「launchApp 里有 `await waitForChatPage()`（无参数）」；RT-1b 报「options 没有 `startupChatWaitMs` 字段」。RT-2 / RT-3 通过（防退化项，本就应绿） |
| 回归用例（修复后） | `npm run test:unit -- e2eLaunchStartupBudget` | 绿 | 4 通过 / 0 失败 |
| 既有回归（e2e 单测） | `npm run test:unit -- e2e` | 绿 | 13 + 4 通过 / 0 失败 |
| 类型检查 | `npm run check-types` / `check-types:e2e` | 绿 | 三份 tsconfig 全过 |
| lint | `npm run lint` | 绿 | — |
| 单条 ssh 用例（本地） | `npx playwright test --project=electron-ssh remoteSshExecution -g "远程工作区启动恢复"` | 绿 | 修复后仍通过，未引入回归 |
| CI 车道实测 | `gh run view` | not-run | 需推送后在 `all.yml` 的 ssh 车道验证 |

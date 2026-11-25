---
status: 已修
---

# 缺陷：remoteTaskSurvival 的长任务 sleep 取值与超时口径脱节，等待预算随之失准

`e2e/electron/remoteTaskSurvival.spec.ts` 用一条远端 `sleep 180` 撑起「后台任务跨孤儿期」
的全部场景，并用固定 `setTimeout` 等待宿主断链 / daemon 察觉。两处在 as-built 口径下都已
站不住：

1. **180s 的理由已失效**。`646e51c` 把 `sleep 90` 改成 `sleep 180`，理由是「超过 Bash 工具
   2 分钟默认超时，由超时收口出工具结果」；但之后的 `221390b` 把前台默认超时定为
   `DEFAULT_BASH_TIMEOUT_MS = 60_000`，且含 `sleep` 的命令取
   `max(60s, sleep 时长总和)`——`sleep 180` 的死线就是 180s，永远不会由超时收口。
   注释里的依据与实现相反。
2. **固定等待掩盖了真实的判断点**。用例体内有 4 处固定 `setTimeout`（5s / 35s / 8s），
   它们等的都是「某个状态已经变了」这一条件（daemon 察觉断链、孤儿跨过 idle 窗口、
   宿主进程真的退出），用固定时长代替判断，慢机上等不够、快机上白等。

实际代价：US-65「离场完成」要等孤儿自然跑完 + 30s 空闲宽限，最坏路径
`180 + 30 = 210s`，而它的轮询窗口只有 260s；CI 上（真实远端与其它 SSH 车道共用）
出现过 `等待远端条件超时（孤儿 Core 在任务完成 + 30s 空闲宽限后收尾）`。

## 现状

- 实测依据（本轮探针，真实 SSH 远端）：

  | 指标 | 实测 |
  | --- | --- |
  | 重开远程工作区（launchApp + 恢复 + 聊天视图就绪） | **5.8s** |
  | 用例注释声称的重开代价 | 「要几十秒」 |

  也就是说 180s 里绝大头是凭空等，而不是为了覆盖重开。

- 固定等待位点（同文件）：

  ```text 示意（三处固定等待，等的都是一个状态条件）
  await new Promise((r) => setTimeout(r, 5_000));   // 等 daemon 察觉宿主断链
  await new Promise((r) => setTimeout(r, 35_000));  // 等孤儿跨过 idle-exit 窗口
  await new Promise((r) => setTimeout(r, 8_000));   // 等宿主进程真的退出
  ```

- CI 现场（run `45548035490` 的 `e2e-ssh`）：

  ```
  Error: 等待远端条件超时（孤儿 Core 在任务完成 + 30s 空闲宽限后收尾）。
  远端残留进程：[{"cmd":".../<CORE_BINARY_NAME> start-daemon --idle-exit 30"},
                 {"cmd":".../<CORE_BINARY_NAME> stdio"}]
  ```

  残留的 daemon 与 `stdio` 孤儿都健在，说明孤儿在那 260 秒里始终没转 idle——
  与 `sleep 180` 把「跑完」推到窗口边缘、再叠加远端负载直接相关。

## 期望

- 长任务的时长要由**被覆盖的最长等待**推导，而不是由已失效的超时理由设定：
  重开实测 5.8s、各段断言窗口合计不足 60s，`sleep` 取 60s 已有约 10 倍余量。
- 换成条件等待：凡是「等某状态发生」的位点都改为轮询真实可观测条件（远端进程表、
  宿主进程存活），条件满足即继续，不满足到上限才失败；只有**需要「整整跨过多久」**的
  语义（孤儿必须跨过 idle-exit 窗口而不被收尾）才保留固定时长，并写明为什么必须等满。
- 预算随取值一起收敛：`sleep 60` 后 US-65「离场完成」的最坏路径是 `60 + 30 = 90s`，
  轮询窗口与 `test.setTimeout` 都要跟着收紧，不得继续留着迁就 210s 的空转余量。
- 注释里的超时依据必须与 `core-rs/src/tools.rs` 的 `default_bash_timeout_ms` 一致
  （默认 60s，含 `sleep` 按 `sleep 时长总和` 顺延，不注销死线）。

## 不变量

- 产品行为不变：Bash 超时口径、孤儿回收 TTL、daemon 空退条件、`restricted` 闸门
  （`docs/features/background-bash.md` FR-005）都不改；本次只动用例的任务时长、
  等待方式与预算。
- 各用例真正要锁的语义不变：US-64 的三选弹框与「非 idle 孤儿在跑时 daemon 不空退」
  （AC-17）、US-65 的认领同一 pid（AC-7）、孤儿期完成证据落 `meta.json` 后重开亮绿灯
  （AC-4）都必须继续被验证，不得为了快而弱化断言。
- 「孤儿必须跨过 idle-exit 窗口仍存活」这条必须仍然等满宽限再加余量——它验的就是
  「不得提前收尾」，提前结束会让断言失去意义。

## 回归测试

- **RT-1**：长任务时长与等待方式有据可依——同文件的 `sleep` 取值不超过各断言窗口的
  10 倍，且用例体内剩余的固定等待都带「为什么必须等满」的说明
  （落点：`src/test/e2eCiLane.test.ts` 的 e2e 预算扫描组）。
- **RT-2**：US-65「离场完成」在共享真实远端下稳定走到「孤儿跑完 → 宽限收尾」
  （落点：`e2e/electron/remoteTaskSurvival.spec.ts` 的
  `US-65 离场完成：孤儿期跑完、daemon 空退，重开后亮绿色未读完成灯（AC-4）`）。
- **RT-3**：US-64 的「非 idle 孤儿跨过 idle-exit 窗口仍存活」仍是等满窗口后判断
  （落点：同文件 `US-64 关闭在跑任务的远程工作区：…`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1） | `npm run test:unit -- e2eCiLane` | 红 | 两条判据同时红：`固定等待都写明了为何不能用条件等待（缺：remoteTaskSurvival.spec.ts:212、272、276、306）`、`注释里的 Bash 默认超时与 tools.rs 一致（不符：remoteTaskSurvival.spec.ts:226：注释称 2 分钟，实现是 60s）` |
| 实测依据 | 真实 SSH 探针：`launchApp` + 恢复远程工作区 + 聊天视图就绪 | 部分验证 | `launchApp=5718ms chatPage=5765ms ready=5783ms`，即 5.8s，与注释「要几十秒」不符 |
| CI 实证（修复前） | run `45548035490` 的 `e2e-ssh`（remoteTaskSurvival） | 红 | 1 failed / 4 passed：`等待远端条件超时（孤儿 Core 在任务完成 + 30s 空闲宽限后收尾）` |
| 回归用例（修复后，RT-1） | `npm run test:unit -- e2eCiLane` | 绿 | 45 通过 / 0 失败；两条判据均转绿 |
| 判据可证伪自检 | 临时把「必须等满」的说明换成空注释 / 把注释改回「2 分钟」 | 红 | 分别报 `缺：remoteTaskSurvival.spec.ts:298` 与 `注释称 2 分钟，实现是 60s`，证明两条判据不是恒真 |
| 固定等待收敛 | 改读代码 | 绿 | 4 处固定等待降为 1 处：`等 daemon 察觉断链` 改 `pollRemote`（远端进程表条件）、`等宿主退出` 改按孤儿 pid 轮询、另 1 处删除（已有 `toBeEnabled` 条件）；仅保留 `跨过 idle-exit 窗口` 那处（语义要求等满） |
| 预算收敛 | 改读代码 | 绿 | `sleep 180` → 90s；US-65「离场完成」等待窗口 260s → 180s（最坏路径 90+30=120s，余量 60s）、`test.setTimeout` 420s → 300s；`startupChatWaitMs`/`chatPage` 180s → 60s；终答断言 180s → 120s |
| 单测全量 | `npm run test:unit` | 绿 | 134 通过 / 0 失败 / 2 跳过（跳过的是环境前置不满足的 `sidebarFiles` / `sidebarDocViewGit`） |
| 静态检查 | `npm run check-types:e2e` / `npm run lint` | 绿 | e2e tsconfig 与 eslint 均无输出 |
| 真实 SSH 车道（修复后） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh remoteTaskSurvival` | 绿 | **5 passed（5.6m）**，含此前一直红的两条 US-65；整轮从修复前的 8.5m 降到 5.6m |
| 取值反证：60s 不够 | 同上（`sleep` 试定为 60s） | 红 | 2 failed：两条 US-65 的任务都在「重开认领 → 终答」之前就跑完（`SURVIVAL-DONE` 等不到 / 绿灯未武装），证明 60s 覆盖不了整条交互链（detach → 强杀 → 重开 → 两轮断言，实测 40–50s 再叠加远端负载） |
| 取值定档 | 同上（`sleep` 定 90s） | 绿 | 90s 对实测整链约 2 倍余量，5 条全绿；等待窗口 180s = 最坏路径 120s 再加 60s（50%）余量 |

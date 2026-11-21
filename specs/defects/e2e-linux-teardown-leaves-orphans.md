---
status: 已修
---

# 缺陷：Linux 上 e2e 关闭应用只杀主进程，孤儿进程让后续用例自我放大超时

`electron-ssh` 车道在 GitHub 托管 runner（Linux）上单文件跑 140 分钟仍未结束，同一份代码在
Windows 开发机上整轮 2.5 分钟（17 条用例全部 ≤13.2s）。差距来自 `killSpawnedApp` 的 Linux
分支：只对 Electron 主进程发 `SIGKILL` 就返回，既不等进程真正退出、也不处理它的子进程。
孤儿进程与下一条用例争 CPU，CDP 握手变慢 → 断言超时 → `retries: 1` 重试 → 又留孤儿，
逐条放大。影响面是所有在 Linux 上跑整应用的 e2e 车道（`electron-app` 与 `electron-ssh`）。

## 现状

`e2e/helpers/electronApp.ts` 的 `killSpawnedApp` 两个分支行为不对等：

| 分支 | 杀进程树 | 等真正退出 | 结果 |
| --- | --- | --- | --- |
| Windows | `taskkill /T /F` | 轮询 `tasklist`，最多 10s | 符合 `e2e/README.md` 已知坑 17 |
| Linux / macOS | `spawned.child.kill('SIGKILL')` | 无 | 只杀主进程，立即返回 |

Linux 分支缺的三件事：

1. **不杀进程树**：Electron 的 GPU / renderer / network service / 被测 Core 子进程不随主进程
   一起死，成为孤儿。`spawn` 调用（同文件 `launchApp`）没有 `detached: true`，子进程与父进程
   不同组，`process.kill(-pid)` 也用不上。
2. **不等退出**：`child.kill()` 只是发信号，返回时进程可能还在。下一条用例立刻启动新实例，
   与垂死进程争 CPU——`e2e/README.md` 已知坑 17 原文：「垂死的 Electron 进程与下一个实例争
   CPU 正是时序敏感断言偶发超时的成因」。
3. **不清理子进程树**：孤儿 Core 继续持有远端 SSH 连接，远端 `sshd-session` 累积（实测 CI
   期间同时存在 13 个存活 3000–7000 秒的会话）。

**平台差异已实测确认**（同一份探针代码，Linux 远端 vs Windows 本机）：

```
# 远端 Linux：父进程被 SIGKILL，孙进程存活 → 孤儿
parent=1309249 grandchild=1309262
before: parent_alive=true  grandchild_alive=true
after:  parent_alive=false grandchild_alive=true
ORPHAN_LEFT=true

# Windows 本机：父子都被杀
父=16688 孙=49832，都存活: true/true
旧实现 child.kill('SIGKILL') 之后:
  父进程存活: false
  孙进程存活: false
```

即：这个缺陷**只在 POSIX 上成立**。Windows 的 `child.kill()` 会连带结束子进程，所以开发机
上永远复现不出来——这正是它一直没被发现的原因。

复现（GitHub 托管 runner，Linux）：

```
run 44914253912 的 e2e-ssh job：139 分钟仍在 in_progress，本地同文件 2.5 分钟
```

远端证据（同一轮 CI 运行中采样）：

```
$ ps -u e2essh -o pid=,etimes=,args= | grep sshd-session
1203251  7065  sshd-session: e2essh     ← 13 个会话，全部无子进程
...
$ 每个会话的 /proc/<pid>/task/<pid>/children  → 空
```

本地对照（Windows，同一份代码、同一远端）：

```
17 passed / 1 failed (2.5m)
  13.2s  Overlay 对话：Write 的风车必须收起
   9.7s  FR-009 远端未装机时确认框点名真实主机
   ...（全部 ≤ 13.2s）
```

## 期望

1. **Linux / macOS 分支与 Windows 分支同口径**：杀**整棵进程树**，并轮询等到进程真正消失
   才返回（上限与 Windows 一致，10s）。
2. **杀进程树的手段**：`spawn` 时带 `detached: true` 让 Electron 及其子进程同属一个进程组，
   关闭时 `process.kill(-pid, 'SIGKILL')` 一次杀全组；组杀失败（如进程已退出、ESRCH）时退回
   `child.kill('SIGKILL')`，不因此抛错。
3. **等退出是必须的**：与 Windows 分支一样轮询到进程消失，最长 10s；超时后继续（不阻塞收尾），
   因为调用方随后还要删沙箱目录。
4. **不留孤儿**：关闭后该实例拉起的 Electron 子进程与 Core 子进程全部消失。

## 不变量

- Windows 分支行为不变（`taskkill /T /F` + 轮询）。
- `killSpawnedApp` 的 `finally` 仍负责删沙箱 `homeDir`（`ownsHomeDir` 为真时）。
- 关闭是**尽力而为**：任何一步失败都不向调用方抛错（现有 `try/finally` 语义）。
- 启动失败路径（`launchApp` 里 CDP 握手超时）与正常 `close` 走同一个 `killSpawnedApp`。
- `detached: true` 不改变 stdio 管道行为：`waitForOutput` 仍能从 stdout/stderr 读到
  `Debugger listening on` / `DevTools listening on`。
- 不改变远端清理职责：远端 daemon / 代理的清场仍由各 spec 的 `afterAll` 负责。

## 回归测试

落点统一是 `src/test/e2eProcessTeardown.test.ts`（真实子进程，不是读源码猜）：

- **RT-1**：关闭后**父进程真的消失**——不是发完信号就返回（用例「RT-1：关闭后父进程真的消失」）。
- **RT-2**：关闭后**孙进程也消失**——杀的是进程树而非单个进程（用例「RT-2 孤儿断言」）。
  这是缺陷的判别用例：POSIX 上旧实现留下孤儿，Windows 上两种实现都通过，因此该用例在
  Windows 上显式跳过并打印原因，判别力来自 CI 的 ubuntu `tests` job。
- **RT-3**：`ownsHomeDir` 为真时关闭后删掉沙箱目录（用例「RT-3：关的是沙箱目录」）。
- **RT-4**：对已退出的进程重复关闭不抛错（幂等；启动失败路径会重复调用，用例
  「RT-4：对已退出进程重复关闭不抛错」）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 平台语义（Linux 旧实现） | 远端 `node` 探针：父 + 孙进程树 → `child.kill('SIGKILL')` | 红 | `after: parent_alive=false grandchild_alive=true` / `ORPHAN_LEFT=true` |
| 平台语义（Windows 旧实现） | 本机同一探针 | 绿 | `父进程存活: false 孙进程存活: false`——Windows 的 kill 连带结束子进程，所以开发机复现不出 |
| 修复后行为（Linux） | 远端同一探针，改 `process.kill(-pid, 'SIGKILL')` | 绿 | `after: parent_alive=false grandchild_alive=false` / `ORPHAN_LEFT=false` |
| 回归用例（修复前，Linux） | 远端等价探针 | 红 | 孙进程存活，断言 `关闭后孙进程仍存活` 会失败 |
| 回归用例（Windows） | `npm run test:unit -- e2eProcessTeardown` | 绿 | RT-2 显式跳过并打印原因：Windows 测不出孤儿分支 |
| 回归用例（CI，Linux） | `npm run test:unit -- e2eProcessTeardown`（ubuntu `tests` job） | not-run | 本地是 Windows，判别面在 CI；推送后由 smoke 闸门给出结论 |
| 既有回归 | `npm run test:unit` | 绿 | 127 通过 / 2 跳过（sidebarDocViewGit、sidebarFiles 的环境前置），0 失败 |
| 类型与 lint | `npm run check-types && npm run lint && npm run check-types:e2e` | 绿 | 0 error |
| CI 端到端耗时 | `gh workflow run all.yml` | not-run | 修复前 139 分钟未完成；修复后应接近本地的 2.5 分钟量级，待下一轮全量车道确认 |

补充说明（不改「现状 / 期望」两节）：本缺陷**只能在 POSIX 上复现**，Windows 开发机上的
`npm run test:unit -- e2eProcessTeardown` 通过不代表修复有效——判别力来自 CI 的 ubuntu
`tests` job。RT-2 在 Windows 上显式跳过并打印原因，不静默算通过。


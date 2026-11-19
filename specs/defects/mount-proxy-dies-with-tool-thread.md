---
status: 已修
---

# 缺陷：Overlay 会话里第一条工具之后所有工具都报「挂载代理已退出：读到 EOF」

隔离（Overlay）对话里，模型发出的**第一条**工具调用正常返回，此后同一会话的每一条工具
调用（Bash、Read 等全部工具）都失败：

```
Error executing Read: Read failed: 挂载代理已退出：读到 EOF
Error executing Bash: Bash: 挂载代理已退出：读到 EOF
```

用户在界面上看到「Bash：挂载代理已退出：读到 EOF」。影响面是 specs/051 FR-007 的代执行
边界：只要代理停住，隔离会话的所有工具都不可用，只有重启 Core 才能恢复。

## 现状

### 触发条件

代理的 A 进程（Core 直接子进程）设了 `PR_SET_PDEATHSIG(SIGKILL)`
（`mount-proxy-rs/src/privilege.rs` 的 `establish_after_mount` 父进程分支）：

```rust
// A 的「父」是内核记录的 parent **task**，不是 parent process
let _ = sys::set_pdeathsig();
```

`prctl(2)` 的 `PR_SET_PDEATHSIG` 跟随的是**父线程**（parent task），不是父进程。Core 侧
`spawn` 代理的是工具批里的短命线程：

```ts src=core-rs/src/engine.rs
            std::thread::spawn(move || {
                execute_tool(
```

`execute_tool` → `ensure_work_view` → `mount_proxy::session_proxy` →
`client::spawn_session`，代理的 parent task 就是这一条工具线程。工具线程收尾退出后，
内核按 `PDEATHSIG` 立即 `SIGKILL` A；A 一死 B 的 `PDEATHSIG`（指向 A）跟着触发，两个
代理进程同时消失。Core 的读线程读到 EOF，此后所有请求都回「挂载代理已退出：读到 EOF」。

第一条工具能成功，是因为它自己就是那个还没退出的工具线程。

### 证据

真机（`e2e/environments.json` 的 ssh 段）上走真实应用链路，一条会话里连发四个工具：

```
REPRO-RESULTS [
  "total 8\ndrwxrwxr-x  1 pz pz 4096 ...",      // Bash  ls -la        成功
  "Error executing Read: Read failed: 挂载代理已退出：读到 EOF",
  "Error executing Bash: Bash: 挂载代理已退出：读到 EOF",
  "Error executing Bash: Bash: 挂载代理已退出：读到 EOF"
]
```

同一条链路上代理侧只收到第一条 `spawn`：`[diag] B<-spawn id=3` 之后再无任何请求进来，
也没有走 `serve_loop` 的 EOF 分支（B 是被内核杀掉的，不是读到 EOF 主动退出）。

`PR_SET_PDEATHSIG` 的父**线程**语义在同一台机器上单独验证：

```
用例 1：从短命线程拉起
  启动线程 128937255499456 已退出；主线程 128937263947904
  子进程已死：signal=9（9=SIGKILL 即父线程退出把它杀了）
用例 2：从常驻主线程拉起
  在主线程里启动（线程常驻）
  子进程仍存活
```

### 影响面

- 现有远端 e2e（`overlayMountProxyRemote.spec.ts`）每条用例只发**一条**工具调用，因此
  一直是绿的——缺陷落在用例覆盖之外；
- 真实使用里模型几乎总是连发多条工具，表现为「Overlay 对话里只要超过一步就全红」。

## 期望

1. 代理的生命周期绑 Core 的**进程**，不绑拉起它的那条线程：工具线程收尾不得带走代理；
2. 代理的回收仍以 socketpair EOF 为主路径（[docs/core/mount-proxy.md 第 5 节](../../docs/core/mount-proxy.md#5-进程链与生命周期)）：Core
   退出 → fd 关闭 → B 读到 EOF 退出 → A 收尸退出；
3. A 上的 `PDEATHSIG` 只兜底「Core 进程异常死亡」，且必须在 Core 进程（不是线程）死亡
   时才生效；
4. Core 重启 / 被 SIGKILL 后代理在 1 秒内消失的既有性质不变。

## 不变量

- 隔离会话的工具 IO 全部经代理代执行，`ViewUnavailable` 时 fail-closed（specs/051
  FR-010）；
- 一个隔离会话一个代理，代理按需拉起、被杀后下次使用时重新拉起且不重启 Core；
- 代理特权阶段的顺序不变：`unshare(CLONE_NEWNS)` → 挂载 → bind → fork → 降权，`PDEATHSIG`
  仍在凭证变更**之后**设置（`prctl(2)` 会因 euid 变更清掉该值）；
- 代理常驻期间的 `NO_NEW_PRIVS`、bounding set 收窄、fd 纪律不变。

## 回归测试

- **RT-1**：一条隔离会话里连发三条以上工具（Bash → Read → Bash），全部必须成功、都不
  含「代理已退出」（落点：`e2e/electron/overlayMountProxyRemote.spec.ts` 的
  `FR-007 连续工具调用不因工具线程收尾而丢代理`）。
- **RT-2**：Core 进程被 `SIGKILL` 后代理仍在 1 秒内消失（落点：`e2e/electron/overlayMountProxyRemote.spec.ts`
  的 `AC-26/AC-26b/AC-26c Core 被 SIGKILL 后代理在 1 秒内消失，无残留`，确认修复没有削弱
  兜底回收）。该用例原本只让 Overlay 勾选框可见就往下走，代理从未被拉起——它的前置
  「代理进程出现」必然在 60s 后超时（修复前后的二进制上都一样红）。修复后它先真的建一个
  隔离会话并跑一条工具，才有「代理在跑」可杀。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 复现（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote -g "连续工具调用"` | 红 | 第一条 Bash 成功，后续 Read / Bash 两条均回「挂载代理已退出：读到 EOF」 |
| `PDEATHSIG` 父线程语义 | 真机 `python3 /tmp/pdeath.py` | 红 | 从短命线程拉起的子进程收到 `SIGKILL`；从常驻线程拉起的存活 |
| RT-1（修复前） | 同上第一条命令 | 红 | 失败点在第 2 步 Read：`挂载代理已退出：读到 EOF` |
| RT-1（修复后） | 同上第一条命令 | 绿 | 1 passed（58.2s）：四步工具全部成功 |
| RT-2（修复前，用例前置） | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote --grep "FR-009 远端未装机\|AC-26"`（装修复前二进制） | 红 | `远端轮询超时（60000ms）：代理进程出现`——用例没建隔离会话，代理从未拉起 |
| RT-2（修复后） | 同上命令（装修复后二进制） | 绿 | 2 passed（40.5s）：A 与 B 在 Core 被 `SIGKILL` 后 1 秒内消失 |
| 远端全量 | `npx playwright test -c e2e/playwright.config.ts --project=electron-ssh overlayMountProxyRemote --reporter=line` | 绿 | 13 条：7 passed / 6 skipped |
| 代理单测 | `cargo test --manifest-path mount-proxy-rs/Cargo.toml` | 绿 | 9 passed / 0 failed |
| 格式基线 | `npm run fmt:rust:check` | 绿 | 四个 crate 全绿 |
| e2e 类型检查 | `npm run check-types:e2e` | 绿 | — |
| 文档守卫 | `npm run test:unit -- docs-lint` | 绿 | — |
| core 单测 | `cargo test --manifest-path core-rs/Cargo.toml` | skipped | 本机 cargo 处于 `Blocking waiting for file lock` 挂死态，多次重试均未拿到结果；CI 的 tests job 会跑 |

备注：

- **「期望」第 3 条与实现的分歧**：Linux 没有「父进程死亡」的接口——`PR_SET_PDEATHSIG` 只
  认父 **task**，因此「只兜底 Core 进程异常死亡」这件事无法用该接口表达。实现取的是「A 不设
  `PDEATHSIG`、回收全交给 socketpair EOF」，与期望第 1、2、4 条一致，第 3 条按不可实施处理。
- **同文件的 `privileged` 段与 `AC-36` / `AC-37` 在全量运行里恒跳过**：`FR-010` 用例以「卸载
  代理」为步骤且不重装，此后的用例前置「代理已安装」因此不成立。这是既有用例排序问题，与
  本次改动无关；RT-2 因此用 `--grep "FR-009 远端未装机|AC-26"`（先经界面装一次）单独取证。
- 构建产物：`dist/resources/core/x64-linux/` 已按修复后的源码重建（代理 sha256
  `30cea876…d31bb3`），RT-1 与 RT-2 的绿行都跑在这份产物上。

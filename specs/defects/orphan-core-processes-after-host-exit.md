---
status: 已修
---

# 缺陷：宿主退出后本地 Core stdio 进程残留为孤儿，跨版本累积

本地工作区的 Core 以 `stdio` 单进程形态由宿主直接启动（不走 daemon）。宿主进程消失后，
Core 只靠「标准输入读到 EOF」退出；扩展升级场景下旧窗口的扩展宿主被替换或强杀，EOF
兜底存在时序缺口，旧 Core 留在旧版本扩展目录里成为孤儿（父进程被 init 收养）。因为
Windows 上运行中的 exe 锁住旧扩展目录、Linux 上旧目录同样被保留，孤儿进程跨多次升级
累积成「多个版本号、多个安装路径」的 Core 进程列表。

## 现状

- 进程模型：一个工作区一个本地 Core（`src/host/bootstrapCore.ts` 的
  `openStandaloneChannel` → `src/host/standalone/StandaloneEventBus.ts` 的
  `createStandaloneCoreBus` → `src/host/standalone/CoreProcess.ts` 的 `spawnChild`）。
  `spawnChild` 只设置 `stdio: ['pipe','pipe','pipe']` 与 `windowsHide`，没有父进程存活
  探测，也没有把子进程绑定到宿主的操作系统级生命周期（Windows 无 Job Object、Unix 无
  进程组约束）。
- Core 侧的退出条件只有两条（`core-rs/src/main.rs` 的 `run_core` / `run_frame_loop`）：
  收到 `shutdown` 帧，或标准输入读到 EOF。EOF 之后还要串行执行 `mcp::shutdown()`
  （对每个 MCP server `taskkill` + `wait`），没有总超时。
- 宿主侧的退出清理只有 `deactivate()` 一条路（`src/extension.ts`）：`shutdownCore()` →
  `Connection.dispose()` → `CoreProcess.stop()`。`stop()` 的默认关闭等待是
  `5_000ms`，与 VS Code 对 `deactivate` 的秒级时限贴得很近；扩展宿主崩溃、OOM 或被
  强杀时 `deactivate()` 根本不执行。
- 复现路径（Linux / Docker 与 Windows 同构）：
  1. 装两个版本的扩展包，让旧版本的 VS Code 窗口保持打开（或升级后不重载旧窗口）；
  2. 升级扩展（新版本落到新目录），随后直接结束旧扩展宿主进程（模拟升级时的替换 /
     强杀），不触发 `deactivate()`；
  3. `ps -eo pid,ppid,lstart,args | grep standalone-core`：旧版本目录的 Core 进程
     `PPID=1` 且不退出；如果 Core 的主线程正卡在同步处理或 `mcp::shutdown()`，EOF 也
     不能让它及时退出。
  4. 再次升级重复第 2 步，进程列表里出现第三个、第四个不同版本目录的 Core。
- 对照：MCP 子进程有 `mcp::prune()` 与 `mcp::shutdown()`，远程 daemon 有 `--idle-exit`；
  本地 stdio Core 没有任何孤儿回收或父进程存活防线。

## 期望

- Core 侧：启动时记录父进程 PID，后台线程周期探测（间隔不超过 2 秒）；父进程消失后
  在一个探测周期内自行退出（写一行诊断，退出码 0）。探测只把「进程不存在」当作死亡，
  「无权限查询」按存活处理，避免误杀。
- 宿主侧：宿主进程退出（含 `process.exit()` 与正常退出）时同步结束本次启动的 Core
  子进程，不依赖 `deactivate()` 是否被调用、也不依赖 `shutdown` 帧是否得到应答。
- 宿主侧：本地 stdio 的关闭等待上限不超过 2 秒，超时后强杀，给 VS Code 的
  `deactivate` 时限留出余量。
- 正常路径不变：`stop()` 仍先发 `shutdown` 帧，进程按时退出就不额外等待。

## 不变量

- `shutdown` 帧语义、握手（`hello` / `ready`）、重启策略与退避、帧协议、背压均不变。
- 多窗口 / 多工作区各自独立的 Core 互不影响：不按产品名或安装路径扫描并结束进程，
  只结束本次宿主自己启动的子进程、只按「自己的父进程是否存活」判断。
- daemon 模式不变：daemon 的正常 `shutdown` 与连接生命周期语义不动；daemon 被强杀时
  它拉起的 Core 走同一条父进程看门狗退出（与本地形态同口径）。
- 不改变 Core 的启动参数与 stdio 通道布局（仍是三根管道）。
- 扩展升级后旧扩展目录的清理仍由 VS Code 负责；本缺陷只保证旧 Core 进程会退出。

## 回归测试

- **RT-1**：Unix 集成测试：中间 shell 作为父进程拉起真实 Core 二进制（stdin 接一根
  不会 EOF 的管道）后立刻退出；Core 必须在 5 秒内自行退出，不能等 stdin EOF。
  （落点：`core-rs/tests/parent_watchdog.rs`「core_exits_when_parent_process_disappears」）
- **RT-2**：宿主进程退出钩子结束 Core 子进程：启动一个忽略 stdin 的假 Core 后手动触发
  `process` 的 `exit` 事件（等价于宿主退出钩子执行），假 Core 必须被结束，不能继续存活。
  （落点：`src/test/standaloneBus.test.ts`「宿主进程退出时结束 Core 子进程」）
- **RT-3**：默认关闭等待上限不超过 2 秒：用一个不响应 `shutdown` 的假 Core 调
  `bus.shutdown()`，耗时必须小于 3 秒（含强杀）。
  （落点：`src/test/standaloneBus.test.ts`「默认关闭等待上限不超过 2 秒」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml --test parent_watchdog` | not-run | 本地 Windows 无 Unix 环境（无 WSL / Docker），RT-1 是 `#![cfg(unix)]`，只在 CI Linux 执行；本地 cargo 构建还缺 clang（ring 的 C / 汇编） |
| 回归用例（修复前） | `node scripts/run-tests.mjs standalone-bus` | 红 | 2 项失败：「宿主进程退出时结束 Core 子进程」（假 Core 存活）、「默认关闭等待上限不超过 2 秒」（实测约 5 秒） |
| 回归用例（修复后） | `node scripts/run-tests.mjs standalone-bus` | 绿 | 56 / 56 通过（含 RT-2「宿主进程退出时结束 Core 子进程」与 RT-3「默认关闭等待上限不超过 2 秒」） |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml --test parent_watchdog` | not-run | RT-1 是 `#![cfg(unix)]`，本地 Windows ARM64 无法执行；由 CI Linux 执行 |
| Core 编译检查 | `cargo check --manifest-path core-rs/Cargo.toml --bin standalone-core`（CC / CFLAGS 注入 zig） | 绿 | 含 Windows FFI 分支与看门狗模块 |
| 看门狗单元测试（Windows 分支） | `cargo test --manifest-path core-rs/Cargo.toml --bin standalone-core parent_watchdog` | 绿 | 4 passed：探测循环 2 条、父 PID 获取、已退出子进程判死 |
| RT-1 集成测试编译 | `cargo test --manifest-path core-rs/Cargo.toml --test parent_watchdog` | 绿 | Windows 上按 `#![cfg(unix)]` 跑 0 个用例，编译通过；Unix 行为由 CI Linux 执行 |
| 既有回归 | `npm run test:all -- standalone client-connection bootstrap-wiring conversation-space-clear` | 绿 | 10 个文件全部通过（standaloneBus / standaloneBootstrap / standaloneCoreEngine / standaloneCoreRestart / standaloneCoreTools / standaloneCorePermission / standaloneCorePermissionPreview / clientConnection / bootstrapWiring / conversationSpaceClearHost） |
| 缺陷复现路径（Linux / Docker 升级场景） | — | 部分验证 | 本地是 Windows ARM64，无 Linux / Docker 环境；等价路径由 RT-1 在 CI Linux 覆盖 |
| 类型检查 | `npm run check-types` | 绿 | 三份 tsconfig 均 0 错 |
| 静态检查 | `npm run lint` | 绿 | — |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 缺陷规格结构与文档链接校验通过 |
| 全量 TS 测试 | `npm run test:all` | 绿 | 57 / 57 个测试文件通过 |
| 全量 Rust 测试 | `npm run test:core` | 绿 | 849 passed / 0 failed（集成用例在 Windows 上 0 个，Unix 由 CI 覆盖） |
| 打包 | `npm run package` | 绿 | `.vsix` + NSIS x64 / arm64 + TUI 四平台安装器全部产出 |

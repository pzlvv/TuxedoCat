---
status: 已修
---

# 缺陷：会话中止只终止直接子进程，Bash 命令继续执行并在工具结果之后补报输出

会话中止后 Bash 卡片当场显示 `Command was interrupted`，但命令实际仍在跑：Windows 上
shell 探测命中的 `bin/bash.exe` 是启动器，`child.kill()` 只终止启动器，真正的 shell 与
`sleep` 及其后续命令继续执行到自然结束；读线程随后补报一块 `toolProgress`，UI 把已定稿的
中断结果刷成命令的真实输出——用户看到的是「当场显示被中止，命令时长走完后 bash 结果又被
刷新成完成执行」。基线是 [docs/features/abort-button.md](../../docs/features/abort-button.md)
FR-002（中止使前台工作立即失效）与
[docs/features/background-bash.md](../../docs/features/background-bash.md)
「中止后台任务必须连树一起杀」的既有口径：中止是终止工作本身，不是只改结果文案。

## 现状

- `core-rs/src/shell.rs` 的探测优先返回 `<git>/bin/bash.exe`；该路径是启动器而非执行命令的
  shell（实测：以 `bin/bash.exe -c "sleep 2 && echo done > late.marker"` 起进程，0.4s 时
  `kill()` 直接子进程，2.5s 后标记文件仍出现；换 `usr/bin/bash.exe` 则不出现）。
- `core-rs/src/tools.rs` 的 `run_bash` 中止路径是 `let _ = child.kill()`——只杀直接子进程，
  没有走进程树终止；同文件的前台等待出错分支与自动转后台失败分支同样是 `child.kill()`。
- `core-rs/src/bash_task.rs` 的 `kill_tree` 虽封装了 `taskkill /T /F`，但只服务后台任务，
  前台执行路径完全没有接入；且顺序是「先 `child.kill()` 再 `taskkill`」——根进程先被杀掉
  后 `taskkill /T` 的子树枚举可能落空（实测：kill 后等进程退出再 taskkill，标记文件仍
  出现；先 taskkill 后 kill 则不出现）。
- `read_pipe` 只在 `read` **之前**检查 `stop`：中止时已在途的 `read` 返回后仍会走一次进度
  回调，工具结果之后还会补报 `toolProgress`。
- 复现：模型调 `Bash` 执行 `sleep 10 && echo done`，中途 abort → 会话落盘的工具结果正确
  （`exit_code: 130` / `Command was interrupted` / `is_canceled: false`），但 abort 之后约
  10s 仍收到 `toolProgress`，`progress.fullOutput` 为 `"done\n"`，卡片内容被刷成 `done`
  （用例化实测：`sleep 3 && echo done` 在工具结果之后 3.07s 补报）。用例见 RT-1 / RT-2。
- UI 侧不应为此加屏蔽：迟到进度不再出现必须由 core 保证（core 描述事实，UI 只渲染事实）。

## 期望

- 中止前台 Bash 时终止**整棵进程树**（Windows 先 `taskkill /T /F /PID`，`taskkill` 不可用
  或进程已退出时退回 `child.kill()`），命令不再继续执行、不再产生输出与副作用。
- 中止之后不再上报该工具的 `toolProgress`：`stop` 置位后，已在途的 `read` 结果也不上报。
- UI 保持现状：不做终态屏蔽，收到什么渲染什么。

## 不变量

- 中止的工具结果内容、`exit_code: 130`、`is_canceled: false` 与落盘格式不变。
- 前台超时仍转后台、手工转后台路径与 `pause_loop` 语义不变；后台任务的输出文件收集与
  完成通知不变。
- 后台任务中止仍走同一棵树终止实现（`bash_task::kill_tree` 顺序改为先 `taskkill`），
  注册 / 完成通知 / 提醒时序不变。
- 非中止路径（正常结束、超时转后台、后台任务完成）不受影响；`read_pipe` 的输出累积
  （`fullOutput` 与输出文件）不变。

## 回归测试

- **RT-1**：`Bash` 执行 `sleep 3 && touch late.marker`，1.2s 后置取消标记。断言工具结果为
  `Command was interrupted`，且等过命令的自然结束点后 `late.marker` 不存在（命令没有继续跑）。
  （落点：`core-rs/src/tools_tests.rs`「bash_abort_kills_the_whole_process_tree」）
- **RT-2**：`Bash` 执行 `sleep 3 && echo done`，1.2s 后置取消标记并收集进度回调。断言工具
  结果为 `Command was interrupted`，且等过命令的自然结束点后进度回调次数不再增加
  （工具结果之后没有迟到的 `toolProgress`）。
  （落点：`core-rs/src/tools_tests.rs`「bash_abort_stops_reporting_progress_after_the_result」）

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cargo test --manifest-path core-rs/Cargo.toml bash_abort_ -- --test-threads=1` | 红 | RT-1：`中止后命令仍在继续执行（孙进程未被终止）`；RT-2：`工具结果之后仍上报了进度：["done\n"]`（left: 1 / right: 0） |
| 进程树语义实测 | `bin/bash.exe -c "sleep 2 && echo done > late.marker"`，0.4s `kill()` 直接子进程 | 红 | 2.5s 后标记文件仍出现；同命令先 `taskkill /T /F /PID` 再 `kill()` 则标记文件不出现 |
| 回归用例（修复后） | `cargo test --manifest-path core-rs/Cargo.toml bash_abort_ -- --test-threads=1` | 绿 | RT-1 / RT-2 与两条既有中止用例（`bash_abort_kills_a_sleep_command_without_a_timeout`、`bash_abort_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe`）4/4 通过 |
| 既有回归 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 863 项全绿（修复前 860 项 + 新增 2 条 RT + 1 条后台护栏） |
| 后台任务护栏 | `cargo test --manifest-path core-rs/Cargo.toml background_task_abort_kills_the_whole_process_tree` | 绿 | 新增护栏用例（修复前后均绿）：后台任务中止同样连树终止；`kill_tree` 顺序改为先 `taskkill` 后 `child.kill()` |
| 真实链路验证（修复前） | 整应用 e2e：`Bash` 执行 `sleep 10 && echo done`，卡片 running 后 abort，等 12s | 红 | abort 后当场 `Command was interrupted`；12s 后卡片变成 `done`（`done·` 带流式光标），`*User Interrupted*` 仍在 |
| 真实链路验证（修复后） | 重建 host Core（`npm run build:core:host`）与 `dist/resources` 产物后重跑同一用例 | 绿 | abort 后与 12s 后时间线逐字相同：`Bash / Sleep ten / sleep 10 && echo done / (无输出) Command was interrupted / *User Interrupted*`，`done` 不再出现 |
| docs-lint | `npm run test:all -- docs-lint` | 绿 | 45 组全过（缺陷规格五节 + RT + 验证记录红/绿行 + 链接） |
| check-types / lint | `npm run check-types && npm run lint` | 绿 | 本次改动只涉及 Rust 与文档，TS 门禁确认无连带破坏 |

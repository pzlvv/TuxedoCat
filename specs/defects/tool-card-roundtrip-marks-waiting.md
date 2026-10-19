---
status: 已修
---

# 缺陷：失败卡片的工具卡片往返仍把会话标成等待用户，后台时误响提醒音

工具入参校验失败（典型：模型给出的 AskUserQuestion 结构非法——`choices` 项带多余字段、
`choices` 为空或超过 9 项、`question` 纯空白）以及工具名不存在时，core 仍会把会话标成
`waiting`：宿主侧因此多出一次 `running → waiting` 迁移，托盘黄点闪一下，窗口在后台时
再响一声提醒音——而界面上只有一张失败卡片，没有任何需要用户回答的东西，用户无从应答。
合法提问反而不会响（auto 模式下被权限层 deny），行为方向相反。

## 现状

- 校验失败分支（`core-rs/src/engine.rs`，`validation_message` 命中后的 `let _ =
  core.waiting_request(...)`）与未知工具分支（`core-rs/src/engine.rs`，`!is_known_tool`
  后的同一调用）都经 `waiting_request` 发 `toolPermissionRequested`。
- `waiting_request` 的语义就是「真的在等用户」：入队前把 `SessionState.waiting` 置
  `true` 并 `emit_runtime()`，应答后置回 `false` 再 `emit_runtime()`（`core-rs/src/engine.rs`
  的 `waiting_request`）。
- 与规格冲突：[docs/core/session-runtime.md 第 1 节](../../docs/core/session-runtime.md#1-来源与调用点) 规定 `waiting` 只表示真的在等用户，
  `CoreRequest.toolPermissionRequested` 的往返**不算**（宿主拿到 `permResult` 就返回，
  `ask` 也直接返回），该往返由 `Engine::plain_request` 承担。正常执行路径的
  `request_tool_permission` 已是 `plain_request`；上述两条分支漏改，仍用 `waiting_request`。
- 宿主侧无去抖：`electron/ElectronConversationManager.ts` 的 `dispatchStates` 把每条全量
  快照直接交给 `statusListener`；`electron/main.ts` 的 `updateTrayStatusFromStates` 用
  `diffSessionEndEvents` 差分出 `anyNowWaiting` 即 `startAttention(status)`，与托盘闪烁
  同一处调用 `attentionSound.play()`（窗口在后台、`DISABLE_TRAY_SOUND` 未置位、偏好里
  「播放提示音」开着时才出声）。同一份快照也驱动侧栏黄灯，因此黄灯同样闪一下。
- 复现路径：manual 模式下让模型发一次 `AskUserQuestion`，入参为
  `{"question":"选哪个？","choices":[{"label":"A","color":"red"}]}`（`strictObject` 报
  `unrecognized_keys`）；把应用最小化到托盘 → 听到一次提醒音、托盘黄点闪一下，但界面没有
  提问框，模型收到 `InputValidationError: ...` 后继续。
- 现有用例覆盖不到：RT-1 / RT-2（`core-rs/src/engine_tests.rs`）只锁 `resolve_permission`
  的两条路径；校验失败与未知工具的既有用例只断言 `toolResult` 文案与「不发 toolCall」，
  没有断言 `waiting` 快照条数。

## 期望

- 校验失败分支与未知工具分支的 `toolPermissionRequested` 往返**不得**改变
  `sessionRuntime.waiting`（走 `plain_request` 语义），快照序列在该往返前后都保持
  `running` / `waiting=false`。
- 其余可观察行为逐条不变：仍发一次 `toolPermissionRequested`（UI 借此上架失败卡片，
  未知工具分支 `permResult` 恒 `allow`、`displayArgs` 照常展开）；不发 `toolCall` /
  `toolArgsUpdated`；产出 `InputValidationError: ...` 或 `Error: Tool "X" not found`
  并跳过该工具（skip 而非 stop）。
- 真的在等用户的请求继续标记 `waiting`：合法 AskUserQuestion / 权限确认的 `userChoice`
  在途期间 `waiting` 为真。

## 不变量

- `waiting_request` 与 `plain_request` 的分工不变：只有 `userChoice`（及
  `userChoicePendingChanged`）算等用户。
- 非法入参的 `toolResult` 文案与落盘 `tool_result` block 不变（`exit_code=-1` /
  `is_canceled=false`）。
- auto 模式下合法 AskUserQuestion 被权限层 deny 的语义不变。
- 托盘提醒音的触发条件（窗口在后台 / 偏好开关 / `DISABLE_TRAY_SOUND`）与播放载体不变；
  本次只改 core 侧 `waiting` 的来源。

## 回归测试

- **RT-1**：结构非法的 AskUserQuestion（`choices` 项带多余字段）→ `toolResult` 为
  `InputValidationError:` 开头、不发 `toolCall`、`toolPermissionRequested` 一次、
  `userChoice` 零次、`waiting` 快照零条（落点：`core-rs/src/engine_tests.rs`
  `invalid_ask_user_question_schema_never_marks_the_session_waiting`）。
- **RT-2**：语义非法的 AskUserQuestion（`question` 纯空白）→
  `InputValidationError: Question cannot be empty`、`userChoice` 零次、`waiting` 快照零条
  （落点：`core-rs/src/engine_tests.rs`
  `blank_ask_user_question_never_marks_the_session_waiting`）。
- **RT-3**：未知工具（模型幻觉出的名字）→ `Error: Tool "Nope" not found`、`userChoice`
  零次、`waiting` 快照零条（落点：`core-rs/src/engine_tests.rs`
  `unknown_tool_never_marks_the_session_waiting`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc never_marks_the_session_waiting -- --test-threads=1` | 红 | RT-1 / RT-2 / RT-3 三条都失败在最后一条断言 `waiting_snapshots == 0`：实测 `left: 1, right: 0`——失败卡片往返确实产生了一条 `waiting=true` 快照；同一命令里的既有 RT-1（auto 免确认）仍绿，说明红的只有本次两条分支。注：本机不带 `--target` 的 `cargo test` 在 `ring` 的 build script 上因缺 `clang` 直接构建失败（与本次改动无关），故显式指定宿主三元组 `x86_64-pc-windows-msvc`（该目标的依赖产物已缓存） |
| 回归用例（修复后） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc never_marks_the_session_waiting -- --test-threads=1` | 绿 | 4 passed / 0 failed：RT-1 / RT-2 / RT-3 与既有 auto 免确认用例全过。修复方式是两处改为复用既有唯一组装点 `request_tool_permission`（内部走 `plain_request`）：`toolPermissionRequested` 的载荷组装从三处收敛到一处；修复后 `waiting_request` 的调用点只剩两处 `userChoice`（真确认框、AskUserQuestion 问答）。收敛成 `request_tool_permission` 之后在最终代码上重跑过该命令，三条仍绿 |
| 类型守卫（载荷类型拆分） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc never_marks_the_session_waiting -- --test-threads=1` | 绿 | `plain_request` 只收 `HostRenderRequest`、`waiting_request` 只收 `UserBlockingRequest`（仅由 `user_choice` 构造，`session_id` 随类型走）：渲染往返在类型上就拿不到标记 `waiting` 的入口，发起点选错入口编译不过。编译通过、三条 RT 仍绿；[docs/core/session-runtime.md 第 1 节](../../docs/core/session-runtime.md#1-来源与调用点) 同步补了这段口径 |
| 既有回归（core 全量） | `cd core-rs && cargo test --target x86_64-pc-windows-msvc -- --test-threads=1` | 绿 | 845 passed / 0 failed（含 RT-1 / RT-2 / RT-3），在载荷类型拆分后的最终代码上重跑。`--target` 同上：本机默认目标在 `ring` 的 build script 上缺 `clang`。过程中的两次红与本次改动无关：一次是两条 Bash 计时用例（`auto_background_failure_falls_back_to_exit_code_124`、`bash_abort_applies_after_the_shell_exits_with_a_grandchild_holding_the_pipe`）在机器满载时误判，单独重跑与安静时的全量都绿；另一次是我在临时 worktree 里共享了构建产物目录，主目录复用了那份二进制，导致 fixture 路径指向已删除的目录，`cargo clean -p standalone-core` 重建后全绿 |
| 文档守卫 | `npm run test:all -- docs-lint` | 绿 | 45 通过 / 0 失败（首跑红在「章节引用全部有效」：本规格与 `TODO.md` 里的裸章节引用，已改成带锚点的相对链接） |
| 类型与静态检查 | `npm run check-types && npm run lint` | 绿 | 本次改动只在 Rust 侧，两条检查与改动前同状态 |

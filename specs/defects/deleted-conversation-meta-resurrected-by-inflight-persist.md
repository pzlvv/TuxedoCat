---
status: 已修
---

# 缺陷：删除会话后 `.meta.json` 被在途查询写回，会话在盘上「复活」

`on_conversation_deleted` 先中止在跑查询、再删盘，但中止只是把取消标志置位
（`abort_foreground`），**不等待查询线程真正退出**。删盘与在途线程的落盘之间存在窗口：
查询线程随后的 `persist_message` / `touch_metadata` 会以「meta 缺失即兜底建档」的语义
把 `session_*.meta.json` 重新写出来。表现为删除看似成功（会话从侧栏消失、聊天区切到新对话），
盘上却留着该会话的 `meta.json`。

## 现状

- 删除入口 `core-rs/src/engine.rs` 的 `on_conversation_deleted`：遍历闭包调
  `abort_session_scope` → `drop_session` → 清理 todo / MCP，最后
  `let _ = history::delete_conversation(session_id, &project)` 删盘，再广播
  `conversationListChanged`。
- `abort_session_scope` 内部对每个会话调 `abort_foreground`，后者只做
  `state.cancel.store(true, Ordering::Relaxed)`（`core-rs/src/engine.rs` 第 1198 行的
  `abort_foreground`），**没有 join / 等待**。
- 在途线程的落盘路径会「缺档即建」：
  - `history::touch_metadata`（第 1304 行）的兜底建档分支：meta 缺失时用默认值建一份；
  - `update_title_if_needed`（`core-rs/src/engine.rs` 第 7410 行）在 `meta_missing` 时
    同样走建档分支。
  两者都经 `write_file_atomic`（第 436 行）落盘，临时名形如 `<name>.tmp-<随机>`。
- 实测（本机 `electron-app` 车道，`--repeat-each=3` 整套文件连跑）删除后逐次采样目录：

  ```text 示意
  [DIAG] session_1795388771596_1rqlysw.meta.json.tmp-1796c1907, workspace.meta.json
  [DIAG] session_1795388806232_bmzlvl6.meta.json, workspace.meta.json
  ```

  第一行是「正在写」的临时文件，第二行已转正——`.jsonl` 删掉了，`.meta.json` 被写回。
- e2e 实证：`e2e/electron/sessions.spec.ts` 的 US-22（删除会话）单跑 3/3 通过（2.1–2.3s），
  整套 `sessions.spec.ts` 连跑时反复失败，断言是「目录里 `session_` 前缀文件数为 0」
  实际读到 1–4。CI run `45047284736` 的 `e2e-electron` 同样红在这一条
  （`Expected: 0, Received: 4`），同 run 的 `45046252618` 该条通过——时序相关。
- 影响面：删除不干净会在盘上留下孤儿会话数据，侧栏刷新后若枚举到该 meta，会话会
  重新出现；同时 `tool-results/` 之外的残留随删除次数累积。

## 期望

- 删除一旦返回，该会话（含子孙闭包）在项目对话目录下不再有任何以 `session_` 开头的
  `meta.json` / `.jsonl` / `.compact_archive.jsonl` / `.session.lock`。
- 在途查询线程的中止与落盘不得跨越删盘：中止后必须先让相关线程退出（或让它们的落盘
  在删除后无从重建），再执行删盘。
- 删除失败不静默：`delete_conversation` 的错误目前被 `let _ =` 丢弃，期望至少留下可观测
  信号（日志/事件），不让「删了但没删干净」与「删成功」不可区分。

## 不变量

- 删除的**闭包语义**不变：会话自身 + 所有层级子孙对话，先删子孙再删自己
  （`history::conversation_closure_in` 与 `history_tests.rs` 的
  `delete_conversation_also_removes_sub_conversations`）。
- `workspace.meta.json`（工作区清单，不是会话）保留，不被删除
  （`history_tests.rs` 的 `delete_conversation_keeps_workspace_manifest`）。
- 删除不存在的会话不报错（`delete_conversation_removes_all_related_files` 的末段断言）。
- 删除当前打开的会话后，聊天区仍切到可用的新对话（US-22 的前置断言）。
- 跨实例锁语义不变：闭包内任一会话被其他实例持有时整体拒绝、数据零改动
  （specs/032 FR-002）。

## 回归测试

- **RT-1**：删除后盘上无残留——`e2e/electron/sessions.spec.ts` 的
  「US-22 侧栏删除会话带二次确认，确认后数据删除」断言项目对话目录里 `session_` 前缀
  文件数为 0（落点：同文件的该用例，第 154–158 行的 `expect.poll`）。
- **RT-2**：整套连跑稳定——同一文件以 `--repeat-each=3` 连跑，US-22 三次全绿
  （落点：`npx playwright test -c e2e/playwright.config.ts --project=electron-app
  e2e/electron/sessions.spec.ts --repeat-each=3`；修复前实测 3/4 次失败）。
- **RT-3**：Core 侧锁定——删盘后由在途落盘触发的 `touch_metadata` / `update_title_if_needed`
  不得为该会话重建 meta（落点：`core-rs/src/engine_tests.rs`，待本轮补用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前，RT-1 单跑） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app e2e/electron/sessions.spec.ts -g "US-22 侧栏删除会话" --repeat-each=3` | 绿 | 3 passed (7.7s)——单跑稳定通过，竞态窗口靠时序触发 |
| 回归用例（修复前，RT-2 整套连跑） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app e2e/electron/sessions.spec.ts --repeat-each=4` | 红 | 3 failed / 25 passed，失败均为 US-22「删除后 session_ 文件数为 0」 |
| 现场采样（修复前） | 在 US-22 删除后逐次读项目对话目录 | 红 | 残留 `session_<id>.meta.json.tmp-<随机>`（写入中）与 `session_<id>.meta.json`（已转正）；`workspace.meta.json` 属预期保留 |
| CI 实证（修复前） | run `45047284736` 的 `e2e-electron` | 红 | `US-22 侧栏删除会话带二次确认，确认后数据删除` 失败：`Expected: 0, Received: 4`（15s 超时）；同 run 其余 121 条通过 |
| CI 对照（同代码早前一轮） | run `45046252618` 的 `e2e-electron` | 绿 | 同一用例 `✓ 95 ... (2.5s)`——时序相关，非稳定失败 |
| Core 回归（RT-3 先红） | 临时注掉 `delete_conversation` 里的 `mark_deleted` 后 `cargo test --manifest-path core-rs/Cargo.toml deleted_conversation_is_not_resurrected` | 红 | `deleted_conversation_is_not_resurrected_by_late_writes ... FAILED`（panicked at `history_tests.rs`）——证明该用例确实锁住墓碑闸门 |
| Core 回归（RT-3 后绿） | 恢复 `mark_deleted` 后同上 | 绿 | `1 passed` |
| Core 全量 | `cargo test --manifest-path core-rs/Cargo.toml` | 绿 | 1228 通过 / 0 失败（连跑两次同结果） |
| e2e 单条稳定性（RT-1 强化） | `npx playwright test ... -g "US-22 侧栏删除会话" --repeat-each=6` | 绿 | 6 passed (15.2s)，单条 2.1–2.2s |
| e2e 整套连跑（RT-2，第一次） | `... e2e/electron/sessions.spec.ts --repeat-each=3` | 部分验证 | 20 passed / 1 failed；**US-22 3/3 通过**（2.2–2.5s），唯一失败是 US-21 `Target page, context or browser has been closed`（浏览器实例被关，与删除无关） |
| e2e 整套连跑（RT-2，第二次） | 同上 | 绿 | **21 passed (54.9s)**，US-22 3/3 通过——修复前同口径为 3/4 次 US-22 失败 |
| 静态检查 | `npm run check-types` / `npm run lint` / `cargo check` | 绿 | tsc 与 eslint 无输出；`cargo check` 0 错误 |

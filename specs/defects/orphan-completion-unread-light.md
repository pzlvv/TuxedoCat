---
status: 已修
---

# 缺陷：孤儿期间完成的任务不武装「任务完成」绿灯（daemon 空退后证据丢失）

US-65 验收第 4 条（[docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md)）：
「孤儿期间完成的任务按既有『任务完成』未读语义武装绿灯（对话列表项与未激活标签页），
阅读后清除」。现状只在「认领重连时 daemon 仍存活」的窄窗口内成立；最常见的实际顺序——
后台运行、任务跑完、daemon 空退、之后才重开工作区——绿灯不亮，用户得不到任何未读提示。

## 现状

- 「任务完成」绿灯的检测只有一处：宿主对相邻两次 `sessionRuntimeChanged` 全量快照做差分
  （`electron/completionAttention.ts` 的 `diffCompletionAttention`，running → idle 且用户
  当时看不到才武装）。它依赖宿主**亲眼**看到迁移前的 running 快照与迁移后的 idle 快照。
- 后台运行（detach）期间 Core 的输出帧进 daemon 孤儿表（`feed_orphan_line`），不进任何
  连接——宿主看不到孤儿期的任何快照，迁移自然无从差分。
- 认领重连时若 daemon 仍存活，重放缓冲按到达序补放 running → idle 快照对，差分补看到
  迁移、绿灯亮起——这是现有实现的全部覆盖面。
- 任务在孤儿期结束后，孤儿转 idle，daemon 在无连接且无非 idle 孤儿持续 30s 后空闲退出
  并清状态文件（US-65 验收第 5 条的空退口径）。此后重开工作区拉起的是**全新 Core**：
  运行时表为空，该会话不再出现在任何快照里，绿灯永远不会武装。完成内容在对话记录里
  可见（JSONL 落盘照常），但用户没有未读提示。

## 期望

- **计数**：孤儿路由期间的 running → idle 迁移由 daemon 检出（它是孤儿帧的唯一观察者，
  `feed_orphan_line` 已持有前后两份快照），经 Core 的 stdin 控制帧（与 `shutdown` 同通道、
  同样不经 UI 总线契约）通知 Core 把该会话的未读完成次数记进 `meta.json` 新字段
  `unreadCompletions`。meta.json 保持 Core 单进程写入——daemon 不直接写盘。
- **补武装**：宿主（Electron）装载对话列表时，对 `unreadCompletions > 0` 的会话补武装
  对话行绿灯与未激活标签页绿灯，agent 创建的会话保持安静（specs/025 FR-003 同一口径）。
- **清除**：打开对话（`conversationLoadRequested`）即视为阅读，Core 把计数清零；
  在线期间的完成不计数（帧走连接路由，不经孤儿观察点），重启后不翻旧账。

## 不变量

- 完成语义与宿主差分同口径：只算 running → idle（waiting → idle 是用户应答 / 中止的
  结果，不算完成）；级别判定对齐 `src/shared/sessionRuntime.ts` 的 `sessionBusyLevel`
  （waiting 优先于 running）。
- `meta.json` 仍是 Core 单进程写（读-改-写走 `history::update_metadata` 的原子落盘）；
  daemon 与宿主都不直接写它。
- daemon ↔ Core 的控制帧不经 UI 总线契约：不新增 UiEvent / UiRequest / CoreEvent，
  `docs/architecture/events.md` 的事件表不变。
- 在线期间完成的行为完全不变：`diffCompletionAttention` 及其武装 / 清除路径零改动。
- 会话删除等既有路径不受影响：`delete_single_conversation` 的清理后缀清单已含
  `.session.lock` 等派生文件，`unreadCompletions` 是 meta.json 内字段，随文件一起删除。

## 回归测试

- **RT-1**：孤儿期 running → idle 迁移被检出并向 Core stdin 发控制帧；waiting → idle
  不发（落点：`core-rs/src/daemon_tests.rs`）。
- **RT-2**：Core 收到控制帧后把 `unreadCompletions` 逐会话递增（落点：
  `core-rs/src/main_tests.rs` 帧循环用例）。
- **RT-3**：`conversationLoadRequested` 装载成功后计数清零；计数为 0 时不落盘
  （落点：`core-rs/src/main_tests.rs` / `core-rs/src/history_tests.rs`）。
- **RT-4**：宿主按列表补武装（`unreadCompletions > 0` → 对话行 + 未激活标签页），
  agent 创建的会话安静、已武装集合幂等（落点：`src/test/completionAttention.test.ts`
  纯函数 + e2e 本地车道）。
- **RT-5**：e2e SSH 车道全流程——后台运行、孤儿期完成、daemon 空退、重开后绿灯亮、
  打开对话后清除（落点：`e2e/electron/remoteTaskSurvival.spec.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-5（修复前） | 手工复现（用户报告：任务在孤儿期跑完、daemon 空退、重开后无绿灯）+ 现状走查 | 红 | 重开拉起全新 Core，快照流里不再出现该会话，宿主差分无从谈起；远端 `meta.json` 当时没有 `unreadCompletions` 字段，绿灯证据在 daemon 空退时随进程消失 |
| RT-1 / RT-2 / RT-3（修复后） | `cargo test orphan` + 全量 `cargo test` | 绿 | 新增 5 用例：孤儿期 running → idle 检出并发控制帧、waiting → idle 不计、控制帧逐会话递增（含形状不对丢弃）、控制帧走真实帧循环路径、装载清零与免落盘；全量无回归 |
| RT-4（修复后） | `npm run test:unit -- completionAttention` | 绿 | 补武装 6 断言：计数 > 0 武装对话行与未激活标签页、agent 会话安静、缺失 / 0 不武装、已在集合幂等、批量去重 |
| RT-4 e2e（修复后） | `npx playwright test --project=electron-app -g completionAfterRestart` | 绿 | 本地两段式（建对话 → 关应用 → 手工补计数 → 重开）：对话行亮 `.running-bar--completed`、打开即熄灭、盘上计数归零 |
| RT-5（修复后） | `npm run test:e2e:ssh -- remoteTaskSurvival -g 离场完成` | 绿 | 全流程 4.2m：后台运行 → 任务在孤儿期跑完（远端 meta.json 的 `unreadCompletions` 落为 1，daemon 日志可见 detach）→ 连接存活期间孤儿被收尾、daemon 空退（远端进程清零）→ 重开绿灯（`.running-bar--completed`）→ 打开清除。首两次跑红与修复无关的污染见 specs/defects/idle-orphan-linger-while-connected.md 的验证记录 |

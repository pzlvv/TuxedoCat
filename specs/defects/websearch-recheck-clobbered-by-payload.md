---
status: 已修
---

# 缺陷：重新勾选联网搜索后，消息负载用 webview 旧值把会话状态覆盖回关闭

用户在会话里重新勾选「联网搜索」（配置事件已到 core 并持久化 meta.json
`context.webSearch: true`）后，紧接着发送的消息仍不带 WebSearch / WebFetch 工具，
模型继续报告「没有 websearch 工具」；直到新建会话才恢复。实测记录：本机
2026-10-18 15:07:05 的勾选事件已持久化（meta 存在 `webSearch: true`），15:07:12 与
15:07:44 的两轮请求模型枚举的工具清单里均无这两个工具。

## 现状

- core 对「配置事件 → 注入」是正确的：`webSearchChanged` 写入
  `state.web_search`（`core-rs/src/engine.rs` `on_session_config_changed`），
  `run_turn` 合并、`run_query_loop` 按生效值注入（有测试
  `web_tools_follow_the_web_search_flag` 与
  `web_search_toggle_syncs_tool_list_and_prompt_details` 锁定）。
- 但 `on_user_message` 对**随消息携带的 `webSearch` 负载无条件覆盖**会话状态
  （`core-rs/src/engine.rs`，`if let Some(enabled) = payload.get("webSearch") …
  state.web_search = Some(enabled)`），且该覆盖不落 meta.json。webview 每条
  `sendMessage` 都带自己的本地 `webSearch` 值（`useAppHandlers.ts`
  `buildUserMessageFromInput`），宿主原样转发（`webviewMessageHandler.ts`
  `handleUserMessage`）。
- webview 侧 `webSearch` 是唯一**没有**宿主同步 effect 的会话级配置：
  `App.tsx` 里 agentMode / promptMode / thinkingMode / modelRef 各有一个
  `useEffect` 变更即 `postMessage` 下发（新建会话时日志可见四条 set 消息、
  独缺 setWebSearch），`handleApplyDefaults` 的注释声称「下发到宿主由各字段
  自己的 effect 完成」——对 webSearch 该 effect 不存在。本地状态一旦与 core
  发散（回显时序、多视图标签页、应用默认值流程），每条消息的负载就把 core
  状态拉回 webview 旧值：勾选被"吞掉"，meta.json 仍是 true（负载不落盘），
  问题被掩盖且稳定复现。

## 期望

- 会话已确立（`state.web_search` 已有值，含恢复会话的种子值）时，随消息携带的
  `webSearch` 负载**不得覆盖**既有会话状态；会话事实以 core 状态为准
  （架构原则 4：一份事实只有一个写入点）。
- 全新会话（尚无该状态）的首条消息负载继续承担种子职责：行为不变——
  负载 `false` → 工具不注入，负载 `true` / 缺省 → 按 settings 默认。
- webview 侧补齐 webSearch 的变更同步：勾选值变化时与其它会话级配置同样
  经 effect 下发 `setWebSearch`（应用默认值到当前对话的流程由此生效），
  不再依赖"随下一条消息捎带"。

## 不变量

- 配置事件（`webSearchChanged`）语义不变：仍是唯一持续写入口，写入即持久化。
- 新对话首条消息的种子语义不变（负载缺省时按 settings 默认）。
- 关闭方向的一切现有行为不变（注入过滤、提示词段跟随清单）。
- `agentMode` / `thinkingMode` / `model` 的负载覆盖语义本次不动（另行评估，
  见验证记录备注）。

## 回归测试

- **RT-1**：配置事件置 ON 后，发送携带 `webSearch: false` 负载的消息——下一轮
  请求**必须仍注入** WebSearch / WebFetch（负载不得覆盖已确立的会话状态）；
  另用一个全新会话发 `webSearch: false` 首条消息——工具**不得注入**（种子
  语义保持）（落点：`core-rs/src/engine_tests.rs`
  `message_payload_does_not_override_established_web_search`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 回归用例（修复前） | `cd core-rs && cargo test message_payload_does_not_override_established_web_search` | 红 | 会话 A 分支失败于「已确立的 ON 不被负载 false 覆盖」，失败打印的工具清单（Bash…Skill，无两 web 工具）与线上会话 15:07:44 模型枚举的清单一致；会话 B（种子）分支通过 |
| 回归用例（修复后） | `cd core-rs && cargo test message_payload_does_not_override_established_web_search` | 绿 | 会话 A（已确立不被覆盖）与会话 B（种子）两分支都过。B 分支等待由 `wait_query_end` 改为按次数等第二轮 `queryEnd` + `conversationListChanged`：原判定是「capture 曾出现过该两帧」，s-a 的帧会让等待立即通过、断言读到 s-a 的请求体（该竞态在红阶段被会话 A 的先失败掩盖）；断言语义不变 |
| 既有基线就地改版 | `cd core-rs && cargo test message_payload_overrides_apply_after_metadata_except_established_web_search` | 绿 | 原 `message_payload_overrides_win_over_metadata` 锁「负载胜过 meta」的旧语义，随修复改版：`agentMode` / `thinkingMode` 覆盖断言保留（不变量：本次不动），webSearch 断言翻转为「meta.json 恢复的已确立值不被负载覆盖」，函数名同步改写。改版前该用例失败时断言持有会话锁、`EngineHarness` 收尾对毒化锁 unwrap，进程 fail-fast（靠单线程跑定位） |
| 既有回归（core 全量） | `cd core-rs && cargo test` | 绿 | 842 通过 / 0 失败 |
| 既有回归（仓库全量） | `npm run build:core:host && npm run test:all` | 绿 | 57 组全过（standalone 系列驱动重建的 x64-win32 二进制、webviewFacts、docsLint；首跑唯一失败即本表当时还缺「修复后的绿」行）；`npm run check-types` / `npm run lint` 干净 |

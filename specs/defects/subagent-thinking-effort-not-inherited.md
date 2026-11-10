---
status: 已修
---

# 缺陷：本地子代理的 thinking effort 没有随主对话继承落盘

`Agent` 工具派发的**本地**子代理在内存里确实继承了创建者会话的 thinking effort 与联网
搜索开关，但这两个继承值没有写进子会话 `meta.json` 的 `context`——`create_sub_agent`
只落盘了 `agentMode`。于是打开子代理会话（或 Core 重启后重新装载它）时，宿主读不到
`context.thinkingMode`，按 [docs/hosts/webview-facts.md 第 4 节](../../docs/hosts/webview-facts.md#4-等待态的判据)
的默认值补齐规则回落 `settings.json` 的全局默认值，webview 随即经 `setThinkingMode`
把它下发回 Core——子代理的思考强度被**不可见地改成了全局默认**，主对话的 inherited 值
丢失。

## 现状

- `Core::create_sub_agent`（`core-rs/src/engine.rs`）从创建者会话读出
  `agent_mode` / `model` / `provider` / `thinking_effort` / `prompt_mode` / `web_search`
  写进子会话 `SessionState`（内存继承成立），随后只对 `agentMode` 调一次
  `persist_context`；`thinking_effort` / `web_search` 没有对应的落盘调用，
  `history::create_sub_agent_metadata`
  （`core-rs/src/history.rs`）也只写 `parentSessionId` / `role` / `creator` / `model` /
  `provider`，不写 `context`。
- 对照：跨工作区路径的 `Core::start_remote_sub_agent` 在同一个坑位落齐了四个键
  （`agentMode` / `thinkingMode` / `promptMode` / `webSearch`），本地路径漏了其中两个
  （`thinkingMode` / `webSearch`）。
- 复现（Electron）：主对话把思考强度切到「低」→ 同轮 `Agent` 派一个 Master 子代理 →
  子代理跑完（或运行中）在侧栏点开该子代理会话。输入区思考强度显示的是
  `settings.json` 的默认值（如「高」），并且 webview 打开会话时 `App.tsx` 的
  `setThinkingMode` effect 把这个值写回 Core，覆盖掉原本继承来的 `low`。
- Core 重启后重开同一子代理会话同此：`ensure_loaded` 读 `context.thinkingMode` 缺失，
  回落 `config::default_thinking_effort()`。
- 既有用例只锁了 `agentMode` 落盘（`sub_agent_inherits_parent_agent_mode`），
  `thinkingMode` / `webSearch` 没有落盘断言，因此这一半继承链路无人拦。

## 期望

- 本地子代理的会话级配置与跨工作区子代理同口径：创建时一次确定的继承值全部落进子会话
  `meta.json` 的 `context`——`agentMode` / `thinkingMode`（落盘字段名）/ `promptMode` /
  `webSearch`。重启后重开子代理会话，思考强度 / 联网搜索 / 提示词模式仍显示继承值。
- 落盘值按角色规则取，与内存赋值同一处来源：非 Master 角色的 `promptMode` / `webSearch`
  是固定值（normal / 关，specs/020 FR-003），Master 取创建者值；落盘必须与内存一致。
- 子代理 LLM 请求的 `reasoning_effort` 由继承值决定（内存链路已成立，本次一并锁住）。

## 不变量

- 继承语义本身不变（specs/020 FR-003 / specs/025 FR-005）：Master 完整继承创建者的
  agentMode / thinking / 模型身份成对 / 联网 / 提示词预设；非 Master 的提示词预设恒
  normal、联网恒关、MCP 名单恒空；跨工作区路径的行为与落盘字段不变。
- 落盘格式不变：仍是 `meta.json` 的 `context.*` 嵌套字段，键名沿用 `thinkingMode`
  （wire 协议名 `thinkingEffort` 与落盘名的差异是既有约定，见
  [docs/architecture/events.md 第 4 节](../../docs/architecture/events.md#4-命名约定)）。
- 唯一写入点不变：会话级配置仍只由 Core 经 `history::update_context` 写 `meta.json`，
  宿主不回写会话文件。
- 子代理创建成败语义：`meta.json` 预建与 `context` 写入失败都按创建失败上报（铁律 1，
  不静默降级）——成功路径的可见行为不变。
- 普通会话、跨工作区子代理、Spin 子代理的既有用例不受影响。

## 回归测试

- **RT-1**：创建者会话 `thinking_effort=low` / `web_search=false`（settings 默认 `high`），
  `create_sub_agent` 一个 Master 子代理后，子会话 `meta.json` 的
  `context.thinkingMode === "low"`、`context.webSearch === false`、
  `context.agentMode` 与内存一致（落点：`core-rs/src/engine_tests.rs`
  `sub_agent_inherits_and_persists_thinking_effort`）。
- **RT-2**：同用例内子代理的 LLM 请求体带 `reasoning_effort: "low"`（继承值而非全局默认）
  （落点：同上）。
- **RT-3**：丢弃引擎（模拟 Core 重启）后 `ensure_loaded(sub_id)`，子会话
  `thinking_effort === Some("low")`、`web_search === Some(false)`（落点：同上）。
- **RT-4**：非 Master 角色的固定值同样落盘（`context.promptMode === "normal"`、
  `context.webSearch === false`），与内存一致（落点：`core-rs/src/engine_tests.rs`
  `explorer_fixes_session_config_while_master_inherits` 补落盘断言）。
- **RT-5**：整应用链路（真实 Core + 假 LLM）：父会话把思考强度切到「低」→ 同轮 `Agent`
  派 Master 子代理 → 子会话 `meta.json` 的 `context.thinkingMode === "low"`；打开子会话
  视图后输入区菜单的思考强度高亮仍是「低」（settings 默认是 `off`，继承失效时会显示
  「关」）且打开会话后落盘值不被回写改动；子代理请求体带 `reasoning_effort: "low"`
  （落点：`e2e/electron/subagentInheritance.spec.ts`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2 / RT-3（修复前） | `cd core-rs && cargo test --bin standalone-core sub_agent_inherits_and_persists_thinking_effort` | 红 | 失败于 `engine_tests.rs` 的「继承来的 thinking effort 应当落盘到子会话 meta.json」——`metadata["context"]["thinkingMode"]` 为 `Null`，期望 `"low"`；`reasoning_effort=low` 的请求侧断言已通过（内存继承成立，缺的是落盘） |
| RT-4（修复前） | `cd core-rs && cargo test --bin standalone-core explorer_fixes_session_config_while_master_inherits` | 红 | 失败于「Explorer 固定的提示词模式应当落盘」——`metadata["context"]["promptMode"]` 为 `Null`，期望 `"normal"` |
| RT-1 / RT-2 / RT-3（修复后） | `cd core-rs && cargo test --bin standalone-core sub_agent_inherits_and_persists_thinking_effort` | 绿 | 落盘走一次 `history::update_context` 批量写四个键（同一把锁内一次原子落盘），不经 `persist_context` 逐个调——写入点仍是 `history::update_context`，与「唯一写入点不变」不冲突 |
| RT-5（修复前） | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g subagentInheritance`（先 `git stash` 掉 `engine.rs` 的修复并重建 Core） | 红 | 失败于 `e2e/electron/subagentInheritance.spec.ts` 的 `expect(meta.context.thinkingMode).toBe('low')`——`Received: undefined`（未修复的 Core 只落 `agentMode`） |
| RT-5（修复后） | 同上 | 绿 | 9.1s 通过：落盘 / 打开子会话后菜单仍高亮「低」（settings 默认 `off` 未被回落覆盖）/ 子代理请求体 `reasoning_effort: "low"` 三段断言全绿 |
| 既有回归 | `cd core-rs && cargo test --bin standalone-core` | 绿 | 1165 passed / 0 failed（含 `sub_agent` 前缀的全部子代理用例与跨工作区继承用例） |
| 格式基线 | `cargo fmt --manifest-path core-rs/Cargo.toml --check` | 绿 | — |
| 文档闸门 | `npm run test:unit -- docs-lint` | 绿 | 缺陷规格结构 / RT 编号 / 验证记录四列与结果取值校验通过；基线 `docs/architecture/core-ui-separation.md` 的 `context.*` 写入方补上子代理创建时的继承值预写；`docs/features/user-stories.md` 的 US ↔ e2e 附录登记新用例 |
| 类型检查 / eslint | `npm run check-types && npm run lint && npm run check-types:e2e` | 绿 | e2e 改动随 `check-types:e2e` 校验 |
| 相邻 e2e 用例 | `npx playwright test -c e2e/playwright.config.ts --project=electron-app -g "subagentExplorer"` | 绿 | `subagentExplorer.spec.ts` 改用启动器的共享 `sessionPage` 后行为不变 |


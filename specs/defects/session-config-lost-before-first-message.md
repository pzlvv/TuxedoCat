---
status: 待修
---

# 缺陷：首条消息前设置的会话级配置不落盘，重启后恢复不了

新建对话后（尚未发第一条消息）用户切换询问模式 / 思考强度 / 提示词模式 / 联网搜索
/ MCP 启用名单，配置只写进 Core 进程内的会话状态（`SessionState`），随后用户改发消息
或 Core 重启，全部回到默认值——用户对「新对话先调好配置再开问」的直觉不成立。

## 现状

- `Core::on_session_config_changed`（`core-rs/src/engine.rs`）是会话级配置的唯一写入口：
  先写 `SessionState`，再 `persist_context` → `history::update_context` 落 `meta.json`
  的 `context.*`。
- 但 `history::update_context` 开头有硬闸门（`core-rs/src/history.rs`）：
  `if !metadata_path(...).exists() { return Ok(()) }`——meta.json 尚不存在时**静默跳过**，
  连内存值都不落。而 meta.json 按设计只在首条消息落盘时创建
  （`update_title_if_needed` / `touch_metadata` 兜底建档，
  [docs/architecture/events.md 第 2.3 节](../../docs/architecture/events.md#23-uieventui--core单向)）。
- 时序缺口：`conversationStarted`（新建对话）只建内存引擎，磁盘无 meta.json；此窗口内
  `setAgentMode` / `setThinkingMode` / `setPromptMode` / `setWebSearch` /
  `setMcpEnabledList` 五个配置动作全部丢失。首条消息建档时
  （`touch_metadata`）只补 `context.promptMode` 一个字段的缺省值，其余配置无从恢复。
- 复现（Electron）：新建对话 → 输入区菜单把询问模式切到「自动」→ 发送消息 → 重启应用
  （或 Core 崩溃重启后重开该对话）→ 询问模式回到「手动」。

## 期望

- 会话级配置的落盘不再以「meta.json 已存在」为前提：`update_context` 在 meta.json
  缺失时兜底建档（与 `touch_metadata` 同一口径的建档，不带标题与消息计数），
  让任何时点的配置变化都可从对话恢复。
- 建档不出现在对话列表里：兜底建档的 `messageCount` 为 0 且无 `clearedAt`，
  `load_conversation_list` 的既有空对话过滤天然把它排除；首条消息建档时
  `touch_metadata` 读到既有 meta 继续合并（标题、`updatedAt`、计数照常）。
- 五个配置 key（`agentMode` / `thinkingMode`（落盘名）/ `promptMode` / `webSearch` /
  `mcpEnabled`）与模型身份（`model` / `provider`，已在 `update_context` 里扁平双写）
  行为一致；模型身份的现有路径不变。

## 不变量

- 落盘格式不变：仍是 meta.json 的 `context.*` 嵌套字段 + `model` / `provider` 顶层扁平
  双写；宿主侧读取（`src/shared/history/Conversation.ts`）不受影响。
- 配置事件是唯一持续写入口的语义不变（specs/defects/websearch-recheck-clobbered-by-payload）。
- meta.json 仍由首条消息建档创建「正式条目」：标题推导、`updatedAt` 刷新、
  `messageCount` 递增、`creator` 归属等逻辑不变；`update_context` 兜底建档**不写**这些字段。
- 会话没有工作目录（`project_of` 失败）时仍静默跳过，不报错（配置先于工作目录登记的
  瞬时状态，铁律 1 允许的 no-op）。
- `history::update_metadata` 的写锁与原子落盘语义不变。

## 回归测试

- **RT-1**：新建会话（无 meta.json）后切 `webSearch: false`，meta.json 兜底建档且
  `context.webSearch === false`；随后 `ensure_loaded`（模拟重启后重开）恢复出
  `state.web_search === Some(false)`（落点：`core-rs/src/engine_tests.rs`
  `session_config_persists_before_first_message_and_restores`）。
- **RT-2**：同场景切 `agentMode` / `thinkingMode` / `promptMode`，三字段各自落盘并可恢复；
  且兜底建档的会话不出现在 `load_conversation_list` 里（messageCount 0 被过滤）
  （落点：同上用例）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1 / RT-2（修复前） | `cargo test session_config_persists_before_first_message` | 红 | 失败于「配置应建档 meta.json」——`update_context` 的 `metadata_path(...).exists()` 闸门直接返回，四字段全丢 |
| RT-1 / RT-2（修复后中途） | `cargo test session_config_persists_before_first_message` | 红 | 兜底建档后 `ensure_loaded` 报 `meta.json is missing creator`（specs/025 FR-002 要求 meta 必带 creator）；兜底对象补 `creator: { kind: "user" }` 后转绿 |
| RT-1 / RT-2（修复后） | `cargo test session_config_persists_before_first_message` | 绿 | 配置落盘 + 零消息不出现在列表 + `ensure_loaded` 恢复四个字段 |
| 既有基线就地改版 | `cargo test update_context` / `cargo test flush_skips` | 绿 | 两条锁旧语义的用例随修复改版：`update_context_writes_nested_context_and_flattens_model_identity`（无 meta 时改为断言兜底建档 + user 归属 + 模型身份扁平双写）、`flush_skips_when_no_override_and_falls_back_when_no_meta`（原名 `..._or_no_meta`，改为断言兜底建档写入 `context.mcpEnabled` 且不留锁文件） |

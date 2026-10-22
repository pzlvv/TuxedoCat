# 实施方案：子代理角色 explorer（文件浏览专用，只读工具集）

技术路线：core-rs 新增**角色注册表**（合法角色 + 角色工具白名单各一个落点），引擎在
子代理创建时按角色固定会话级配置、在查询循环按白名单过滤工具清单（提示词的工具说明段
由清单推导，自动只描述白名单工具）、在工具执行入口按白名单拒绝越权调用；webview 消费
既有的 `conversationLoaded.metadata.role` 事实，经纯函数判定把选项菜单三项置灰。
无 wire 字段与事件变化。指向同目录 `spec.md`（FR-001～FR-005）。

## 技术方案

### 角色注册表（core-rs/src/tools.rs，FR-001）

```ts src=core-rs/src/tools.rs 示意
pub const SUB_AGENT_ROLES: &[&str] = &["Master", "explorer"];
pub fn sub_agent_role_tools(role: &str) -> Option<&'static [&'static str]>
// "explorer" => Some(&["Read", "Glob", "Grep", "Reply"])，其余 None
```

- `SUB_AGENT_ROLES` 是合法角色的**单一落点**，四处消费推导：
  1. `tools.rs` `run_agent` 的执行侧校验（替换现在的 `role != "Master"`）；
  2. `tool_input.rs` `agent_fields` 的枚举（`Kind::Enum(SUB_AGENT_ROLES)`，多值后
     zod 对齐文案自动变为 `Invalid option: expected one of "Master"|"explorer"`，
     `invalid_value_issue` 已实现多值分支，无需改）；
  3. `permission.rs` Agent 分支的空 role deny 文案（从常量拼接）；
  4. `prompt.rs` 系统提示词 Agent 角色表（新增 explorer 条目，prose 文本 + 测试锁定）。
- 白名单含 `Reply`：子代理完成判定与 Reminder 以「调用过 Reply」为基准
  （`engine.rs` `sub_agent_has_reply`），Reply 是生命周期设施。
- Agent 工具 JSON schema 维持 `"agentRole": {"type": "string"}`（现状注释口径：
  enum 不展开），description 更新为点名两个角色。

### 引擎：创建时固定配置 + 查询循环过滤 + 执行侧防线（core-rs/src/engine.rs，FR-002 / FR-003）

1. **`create_sub_agent`**：继承块之后，`sub_agent_role_tools(role)` 命中时
   `state.prompt_mode = None`（normal）、`state.web_search = Some(false)`——非 Master
   不继承预设与联网搜索；MCP 与工具集在查询循环统一过滤，不在创建时另改。
2. **`run_query_loop`**：从 `state.sub_agent_role` 解析白名单；命中时在
   `all_tool_definitions`（内置 + MCP）的结果上按白名单过滤，并把预设**强制 normal**
   （不调 `active_preset` 的 mixed→minimal 切换）——一处过滤同时落实
   「无 `mcp__*`、不联网、预设不叠加」。提示词组装已按传入工具清单渲染工具说明段
   （`build_system_prompt_with_preset(preset, project, &tools)`），无需第二份提示词文本。
3. **`execute_tool`**：函数入口（MCP 分流之前）读 `state.sub_agent_role`，白名单存在且
   工具不在名单时返回 `ToolOutcome::Error`（文案点名角色与可用工具，如
   `explorer 子代理只有 Read / Glob / Grep / Reply 工具，Bash 不可用`）。所有工具执行
   路径（串行 / 并行批 / Skill 注入）都经过该入口，压缩不经过（压缩直连 LLM 无工具），
   防线无旁路。

`Master` 与普通会话：白名单为 `None`，三条路径全部维持现状（继承、全量工具、预设切换）。

### Webview：角色事实消费 + 选项置灰（FR-005）

1. **事实接线**：`conversationLoaded` 处理器（`conversationHandlers.ts`）读
   `msg.conversation.metadata?.role`，经新的 App 级状态 `subAgentRole` 下发——与既有
   `parentSessionId` 的接线完全同构（同一消息、同一位置取值）。
2. **置灰判定**：`src/webview/inputAreaState.ts` 新增纯函数
   `resolveSessionOptionsLocked({ subAgentRole })`——role 存在且 `!== "Master"` 时锁定。
   判据是「子代理且非 Master」，将来新增非 Master 角色 UI 不用改；role 缺失（旧数据 /
   普通会话）不锁定。InputArea 与 `src/test/inputAreaState.test.ts` 共用一份实现。
3. **三个选项的置灰**（`InputArea.tsx`）：
   - 联网搜索：`webSearchDisabled = promptMode === 'minimal' || optionsLocked`
     （复用既有置灰渲染：opacity 0.45 + cursor default + 点击早退）；
   - 提示词模式：锁定时 `PromptModeSegmentControl` 的 onChange 早退 + 降透明度；
   - MCP 服务器：子菜单各服务器行的 `onMcpToggle` 调用早退 + 行降透明度。
   - 置灰 title 提示新增 i18n 键（zh / en 各一条：非 Master 子代理会话不可更改）。

### e2e（e2e/electron/subagentExplorer.spec.ts）

仿 `subagentConcurrency.spec.ts`（mock LLM + 真实 standalone core）：
父会话脚本化发起 `Agent(agentRole="explorer")` → 断言子代理首请求 tools 恰为四件套 →
mock 让子代理调 Bash，断言 tool_result 为点名可用工具的错误 → 子代理 Reply 收尾 →
点击侧栏子会话打开视图，断言选项菜单三项置灰。文件头注释标 `US-51`。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 角色注册表（常量 + 白名单函数）；`run_agent` 校验改走注册表；Agent schema description 更新 | 无（`agentRole` 保持 string） |
| `core-rs/src/tool_input.rs` | `agent_fields` 枚举改引 `SUB_AGENT_ROLES` | 无 wire 变化；非法值错误文案变多值格式 |
| `core-rs/src/permission.rs` | 空 `agentRole` deny 文案改由常量拼接 | 无 |
| `core-rs/src/prompt.rs` | Agent 角色表新增 explorer 条目 | 无（提示词正文） |
| `core-rs/src/engine.rs` | `create_sub_agent` 固定非 Master 配置；`run_query_loop` 白名单过滤 + 预设强制 normal；`execute_tool` 执行侧拒绝 | 无新增事件 / 契约成员；`meta.json` 的 `role` 字段已存在 |
| `src/webview/types.ts` | `SessionState` 不动；App 级 `subAgentRole` 状态（App.tsx useState + HandlerContext props） | 无 |
| `src/webview/hooks/handlers/conversationHandlers.ts` | `conversationLoaded` 读 `metadata.role` 并下发 | 无（`metadata.role` wire 字段已存在） |
| `src/webview/inputAreaState.ts` | 新增 `resolveSessionOptionsLocked` 纯函数 | 无 |
| `src/webview/InputArea.tsx` | 三个选项接锁定判定 + i18n 键 | 无 |
| `src/webview/i18n/zh.ts` / `en.ts` | 新增置灰提示键各一条 | 无 |
| `core-rs/src/engine_tests.rs` / `tools_tests.rs` / `prompt_tests.rs` | 新增 / 调整用例 | 无 |
| `src/test/inputAreaState.test.ts` | 新增锁定判定用例 | 无 |
| `e2e/electron/subagentExplorer.spec.ts` | 新增 | 无 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：改动只在 core-rs 与 webview；webview 只消费
      wire 既有事实（`metadata.role`），不 import 宿主 API、不嗅探宿主；置灰判定抽纯函数
      （`inputAreaState.ts` 既有模式），组件不另写 `if`。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：角色清单与白名单单点定义（铁律 4.4「一份事实一个
      写入点」、4.6「默认值单源」——非 Master 的固定值只落在 `tools.rs` 注册表，webview
      不内置「explorer 有哪些工具」的猜测，只消费 role 事实做表现（铁律 4.3）；执行侧
      拒绝 fail loud（铁律 4.1）；role 缺失按普通会话不置灰是 spec 边界明定的设计决断，
      注释说明。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：行为改动落点 `core-rs/` 并同步
      `engine_tests` / `tools_tests` / `prompt_tests`；不新增落盘字段（`role` 已存在），
      不涉及 `src/shared/history/` 双侧同步；仓库只有一套 Core（core-rs），无 parity 义务。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：US-51 在 /converge 并入
      `docs/features/user-stories.md`（含 e2e 映射表行），spec 收敛后整目录归档
      `docs/archive/specs/`；`npm run test:all -- docs-lint` 绿为准出条件。

## 被否决的替代方案

- **Agent schema 展开角色 enum**：否决——现状注释已说明 enum 不展开（`agentRole` 只声明
  string），角色清单由提示词角色表承载给 LLM；改声明形态影响所有 provider 的兼容口径，
  收益为零。
- **explorer 用 `static_system_prompt` 整体替换提示词**（引擎已有该机制）：否决——
  需要维护第二份完整提示词文本，与主对话提示词必然漂移；而工具说明段本就按传入清单渲染，
  过滤清单即得到一致且自动收敛的提示词。
- **webview 按 `parentSessionId` 置灰**：否决——Spin 起的子代理（Master）会被误置灰，
  与「非 Master 才置灰 / Master 保持可操作」冲突；判据必须是角色事实。
- **UI 侧硬编码 explorer 工具清单做提示**：否决——webview 不持有事实默认值（铁律 4.7），
  置灰解释文案不点名具体工具，工具清单事实只存在于 core。

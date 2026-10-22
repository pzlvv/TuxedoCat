---
status: 已收敛
---

# 改动规格：子代理角色 explorer（文件浏览专用，只读工具集）

`Agent` 工具新增子代理角色 `explorer`：派生文件浏览专用的只读子代理，其 LLM 工具清单
恰为 Read / Glob / Grep（外加生命周期必需的 Reply），并配套只描述这组工具的系统提示词。
同时确立**按角色区分的继承规则**：Master 子代理维持现状（继承创建者会话的提示词预设 /
联网搜索 / MCP 启用），非 Master 角色一律固定——提示词预设恒 normal、联网搜索恒关、
MCP 工具恒空；且打开非 Master 子代理会话的视图时，输入区选项菜单中的这三项置灰不可操作。
核心改动只落在 core-rs（现仅此一套 Core 实现）；UI 改动只落在 webview 的置灰判定——
角色事实经既有的 `conversationLoaded.metadata.role` 到达 webview（wire 字段已存在），
不新增事件与 wire 字段；Agent 工具卡片已按 `agentRole` 原样展示，不变。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | 新增 US-51 小节 | 新增 | 登记 explorer 角色的用户故事与验收（含子代理视图选项置灰）；e2e 用例登记进附录映射表 |

角色合法性目前没有任何 as-built 文档（只在 `core-rs` 代码与 `prompt.rs` 提示词正文里），
本次新增的 as-built 语义（角色清单、explorer 工具集、按角色的继承规则）随 US-51 落在
user-stories.md，口径同 US-50（WebSearch / WebFetch 工具行为写在 US 条目里）。

## 用户场景与验收标准

- 场景 1：主对话派生 explorer 子代理做文件浏览
  - **AC-1**（FR-001）：GIVEN 主对话 WHEN 发起 `Agent` 调用且 `agentRole="explorer"` THEN 创建成功，工具结果含 `✓ Agent [explorer] created`，子会话 `meta.json` 的 `role` 为 `"explorer"`、`parentSessionId` 指向父会话，对话列表出现子会话
  - **AC-2**（FR-002）：GIVEN explorer 子代理的首轮 LLM 请求 WHEN 检查请求携带的工具清单 THEN 恰为 Read、Glob、Grep、Reply 四个工具名（无 Bash / Write / Edit / TodoWrite / Agent / AskUserQuestion / Skill / WebSearch / WebFetch，也无 `mcp__*`）
  - **AC-3**（FR-002）：GIVEN explorer 子代理 WHEN 模型调用 Bash（白名单外） THEN 工具结果为错误文案（点名该角色可用的工具），命令未执行，会话未中止、后续轮次可继续
  - **AC-4**（FR-002）：GIVEN 工作区启用了 MCP 服务器 WHEN 对比 explorer 与 Master 子代理的工具清单 THEN explorer 不含任何 `mcp__*` 工具，Master 不受影响
- 场景 2：非法与缺省角色
  - **AC-5**（FR-001）：GIVEN `agentRole="Explorer"`（大小写不符）或 `"Dev"` WHEN 调用 `Agent` THEN 入参校验失败，文案为多值枚举文案（`Invalid option: expected one of "Master"|"explorer"`），不创建会话
  - **AC-6**（FR-001）：GIVEN `agentRole` 缺省 WHEN 权限检查 THEN deny 文案列出 Master 与 explorer 两个支持角色
  - **AC-7**（FR-001）：GIVEN 主对话的系统提示词 WHEN 组装 THEN Agent 工具的角色表含 Master 与 explorer 两个条目，explorer 条目说明其文件浏览定位与只读工具集
- 场景 3：会话级配置的固定与继承（按角色区分）
  - **AC-8**（FR-003）：GIVEN explorer 子代理 WHEN 组装 system prompt THEN 以 `## Communication` 段开头，工具说明段只描述 Read / Glob / Grep / Reply 四个工具
  - **AC-9**（FR-003）：GIVEN 创建者会话的提示词预设为 minimal 或 mixed WHEN 派生 explorer 子代理 THEN 其工具清单与提示词仍按四件套口径（不继承预设，不出现空工具清单）
  - **AC-10**（FR-003）：GIVEN 创建者会话开启联网搜索（会话级覆盖） WHEN 派生 explorer 子代理 THEN explorer 的请求不含 WebSearch / WebFetch（固定不联网，不随创建者覆盖变化）
  - **AC-11**（FR-003）：GIVEN 创建者会话为 minimal / mixed 预设且开启联网搜索 WHEN 派生 Master 子代理 THEN Master 维持现状：预设与联网搜索随创建者继承（继承规则只对非 Master 角色改变）
- 场景 4：生命周期与既有角色不回归
  - **AC-12**（FR-004）：GIVEN explorer 子代理完成任务 WHEN 调用 Reply THEN 回投创建者会话并唤醒父会话消费，语义与 Master 一致
  - **AC-13**（FR-004）：GIVEN 同一父会话已有 4 个子代理在运行（含 explorer） WHEN 再发起 `Agent` 调用 THEN 排队语义与 specs/005 一致（FIFO、槽位随任一子代理结束释放）
  - **AC-14**（FR-004）：GIVEN explorer 子代理在运行 WHEN 中止父会话（递归中止） THEN explorer 随之中止；`Master` 子代理与普通会话的工具清单、提示词组装与改动前完全一致
- 场景 5：非 Master 子代理视图的选项置灰
  - **AC-15**（FR-005）：GIVEN 正在查看 explorer 子代理会话的视图 WHEN 打开输入区选项菜单 THEN 提示词模式、联网搜索、MCP 服务器三项置灰，点击不产生任何状态变更、不发送任何 `UiEvent`
  - **AC-16**（FR-005）：GIVEN 正在查看普通会话或 Master 子代理（含 Spin 起的子代理）会话 WHEN 打开输入区选项菜单 THEN 三项照常可操作（现状不回归）

## 功能需求

### FR-001：角色注册与单一清单

`Agent` 工具的 `agentRole` 接受 `Master` 与 `explorer` 两个值，精确匹配（大小写敏感）。
合法角色清单在 core-rs 内只有一个落点，四处消费都从它推导：工具执行侧校验
（`tools.rs` 的 `run_agent`）、入参枚举校验（`tool_input.rs` 的 `agent_fields`）、
权限 deny 文案（`permission.rs`）、系统提示词的角色表（`prompt.rs`）。主对话系统提示词的
Agent 角色表新增 explorer 条目，说明它是文件浏览专用角色、只有只读工具集；Master 条目
语义不变。`agentRole` 的 JSON schema 保持 string 声明（不展开 enum，维持现状注释口径）。

### FR-002：explorer 的工具集

explorer 子代理的 LLM 工具清单恰为 **Read、Glob、Grep、Reply** 四个。Reply 是子代理
生命周期的必需工具（完成判定与 Reminder 都以「调用过 Reply」为基准），不属于工作工具，
因此计入白名单。其余内置工具与该会话启用的 MCP 工具一律不进清单。执行侧防线：explorer
会话内模型调用白名单外工具（含 `mcp__*`）时直接拒绝，返回点名可用工具的错误文案，
不执行、不静默降级、不中止会话。Master 子代理与普通会话的工具清单行为不变。
工具集差异由角色决定，在会话创建时一次确定，生命周期内不变。

### FR-003：按角色区分的会话级配置继承

非 Master 角色的子代理会话，三项会话级配置一律**固定、不继承创建者**：

- **提示词预设恒 normal**：不按 minimal / mixed 过滤工具（预设白名单只有 Bash / Edit，
  与角色白名单交集为空会得到空工具清单）；system prompt = `## Communication` 前缀
  （Reply 语义，与 Master 同款）+ 按其工具清单组装的提示词，工具说明段由清单推导。
- **联网搜索恒关**：请求不含 WebSearch / WebFetch，与创建者会话的联网搜索覆盖无关。
- **MCP 工具恒空**：该会话不注入任何 `mcp__*` 工具，与全局 / 会话级 MCP 启用列表无关。

Master 子代理维持现状：提示词预设与联网搜索继承创建者会话，MCP 按既有「按会话启用列表
解析」口径不变。三项固定值在会话创建时一次确定，生命周期内不受迟到的会话级覆盖事件影响
（webview 侧入口由 FR-005 置灰兜住）。

### FR-004：生命周期一致，差异只在工具与配置

explorer 与 Master 走同一条子代理链路：并发槽位与 FIFO 排队（specs/005）、前台中止时
排队调用取消、递归中止覆盖、Reply 投递与 Reminder 重试、`meta.json` 的
`parentSessionId` / `role`（原样落盘 explorer）、对话树关联与「返回主对话」、
`sessionRuntime` 的空闲递归判定、model / provider / thinking effort 继承——全部不变。
Spin 编排起的子代理仍固定 `Master`，不受本改动影响。

### FR-005：非 Master 子代理视图的选项置灰

打开**非 Master 子代理**会话（`role` 存在且不等于 `"Master"`）的视图时，输入区选项菜单中的
**提示词模式、联网搜索、MCP 服务器**三项置灰：不可点击、点击不产生任何状态变更、
不发送任何 `UiEvent`（`promptModeChanged` / `webSearchChanged` / MCP 开关变更）。
置灰判据是当前查看会话的角色事实，来源为既有的 `conversationLoaded.metadata.role`
（wire 字段已存在，webview 开始消费即可），不新增事件与 wire 字段。普通会话（无 role）
与 Master 子代理（含 Spin 起的子代理）的视图不置灰，行为与现状完全一致。

## 边界与错误路径

- **角色名精确匹配**：`"Explorer"` / `"EXPLORER"` 等大小写变体不合法，不做别名归一（AC-5）。
- **缺省与空值**：`agentRole` 缺省 / 空串沿用既有 deny 路径，文案更新为列出两个角色（AC-6）。
- **白名单外调用的错误通道**：执行侧拒绝走既有 `ToolOutcome::Error` 通道（tool_result 带
  `Error executing <Tool>: ` 前缀、正常落盘），不新增错误类型。
- **嵌套禁令不变**：explorer 会话（`sub_` 前缀）内调用 `Agent` 仍被一刀切 deny，与角色无关。
- **存量数据兼容**：`meta.json` 的 `role` 是纯事实字段，读取与恢复路径只透传字符串、
  不按枚举白名单解释；存量 `role:"Master"` 会话不受影响。
- **并发槽位对 explorer 生效**：explorer 与 Master 共用同一上限与队列，不因角色分池。
- **置灰按角色而非逐角色列举**：webview 的置灰判据是「子代理且 role ≠ Master」，将来新增
  非 Master 角色时 UI 无需改动（与 FR-003 的固定规则同口径）；角色事实缺失（如旧数据）
  时按普通会话对待、不置灰。
- **子代理会话恢复后置灰不变**：explorer 会话重启后重新打开，role 从 `meta.json` 恢复，
  置灰状态与运行期一致。

## 非目标

- **不做用户自定义角色**：`<configDir>/agents/*.md` 式的自定义角色注册机制不在本次范围；
  将来需要时另立 spec。
- **不改 Spin 编排**：Spin 设计器节点与 `spin_host.rs` 固定 `Master`，不提供角色选择；
  Spin 子代理的选项菜单不置灰。
- **不给 explorer 扩工具**：TodoWrite / AskUserQuestion / 写类工具的「只读降级」都不做；
  工具集就是四件套。
- **不限制 Master 与普通会话**：主对话与 Master 子代理的工具清单、提示词组装、
  继承行为、菜单可操作性完全不变。
- **不新增事件类型与 wire 字段**：webview 只开始消费既有的 `conversationLoaded.metadata.role`；
  Agent 工具卡片展示不变。

## 对需求基线的影响

- 新增 **US-51 子代理角色 explorer**（user-stories.md，收敛时并入）：用户故事 + 验收标准
  （核心行为 + 子代理视图选项置灰）。
- e2e 登记：新增 `e2e/electron/subagentExplorer.spec.ts`（mock LLM 驱动真实 standalone
  core：从记录的请求断言子代理工具清单与执行侧拒绝；派生 explorer 后断言选项菜单置灰），
  映射表补一行指向 US-51。
- 无其他 US 修改：US-14（工具卡片）、US-49（并发上限）、US-8 / US-9 / US-29 / US-50
  （三项选项在普通会话与 Master 子代理上）行为不变。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（角色清单与 `run_agent` 校验）、`core-rs/src/tool_input.rs`、`core-rs/src/permission.rs`、`core-rs/src/prompt.rs`（角色表） | `core-rs/src/tools_tests.rs`、`core-rs/src/prompt_tests.rs`、入参校验对等测试 | 自动 |
| FR-002 | `core-rs/src/engine.rs`（按角色过滤工具清单 + 执行侧拒绝） | `core-rs/src/engine_tests.rs`、`e2e/electron/subagentExplorer.spec.ts` | 自动 |
| FR-003 | `core-rs/src/engine.rs`（角色键控的继承与固定值） | `core-rs/src/engine_tests.rs`、`core-rs/src/prompt_tests.rs` | 自动 |
| FR-004 | `core-rs/src/engine.rs` 的 `create_sub_agent` / `run_sub_agent`（既有链路回归） | `core-rs/src/engine_tests.rs`（存量用例回归）、`e2e/electron/subagentExplorer.spec.ts` | 自动 |
| FR-005 | `src/webview/InputArea.tsx`（置灰判定）、角色事实接线（`conversationLoaded` 消费） | `src/test/inputAreaState.test.ts`、`e2e/electron/subagentExplorer.spec.ts` | 自动 |

## 待澄清

（无——实施前保持本节为空。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

### 已满足

- **FR-001**（角色注册表与单一清单）：`core-rs/src/tools.rs` 的 `SUB_AGENT_ROLES` +
  `sub_agent_role_tools` 为唯一落点；四处消费全接注册表——`run_agent` 校验
  （tools_tests::agent_tool_validates_role_against_registry）、入参枚举
  （tools_tests::agent_role_input_validation_reports_multi_value_enum +
  fixtures/toolInputValidation.json 三处枚举用例同步）、permission 空 role 文案（常量
  拼接）、prompt.rs 角色表（prompt_tests::agent_role_table_lists_all_registered_roles，
  与注册表双向锁定）。AC-5 / AC-6 / AC-7 覆盖。
- **FR-002**（explorer 工具集与执行侧防线）：engine_tests::
  explorer_sub_agent_gets_role_toolset_and_rejects_others——首请求工具恰为
  Read / Grep / Glob / Reply（内置定义顺序投影，含「无 `mcp__*`」的结构性保证）、
  Bash 被拒文案点名角色与工具、命令未执行、会话不中止 Reply 收尾、meta.json 落
  `role="explorer"`。e2e subagentExplorer.spec.ts 同链路复证。AC-1 / AC-2 / AC-3 /
  AC-4 覆盖（AC-4 的 explorer 侧由「恰为四件套」的集合相等断言承载：任何白名单外
  来源——含 MCP——都不可能出现）。
- **FR-003**（按角色区分的配置继承）：engine_tests::
  explorer_fixes_session_config_while_master_inherits——创建者 minimal + 联网开时
  explorer 固定（prompt_mode=None / web_search 关 / 请求含核心身份段 + 四件套），
  Master 维持继承（minimal + Bash / Edit）。AC-8 / AC-9 / AC-10 / AC-11 覆盖。
- **FR-004**（生命周期一致）：specs/005 存量用例全量回归（cargo test 912 全绿）+
  e2e Master 用例（创建 / 收尾 / 菜单可操作）。AC-12 / AC-13 / AC-14 覆盖。
- **FR-005**（视图选项置灰）：inputAreaState.test.ts 5 断言（explorer 锁定、Master /
  无 role / 未到达不锁定、非 Master 泛化）；e2e subagentOptionsLock.spec.ts
  （webview 层：置灰样式 + 点击不上报 setPromptMode / setWebSearch + Master 与普通
  会话不置灰）；e2e subagentExplorer.spec.ts（electron 全链路：role 事实经
  conversationLoaded 到达后置灰生效）。AC-15 / AC-16 覆盖。

### 偏差

1. **spec 编号 019 → 020**：起草期编号取 019（当时 specs/ 已用最大 018），收敛时发现
   并行会话的在途规格 `specs/019-abort-hover-background-tasks/` 同占 019；按「编号
   不复用」本 spec 改号 020，实现内引用同步改写。
2. **影响基线落地形态**：US-51 实际落在 `docs/features/user-stories/dialog-core.md`
   （分册，US-49 之后）+ `user-stories.md` 索引行与附录两行——收敛期仓库正被并行会话
   从单文件重构为「索引 + 分册」，基线文档结构变化所致；delta 内容与 spec 承诺一致
   （US-51 + 两行 e2e 登记）。

### 未做

- **user-stories 分册合并的随提**：US-51 的 delta 已写入工作区（dialog-core.md 分册 +
  索引 + 附录），但 user-stories 相关文件正被并行会话整体重构且未提交，为避免把他人在
  途工作混入本提交，该 delta 留在工作区、随并行会话的收敛提交落地。本 spec 相关的
  docsLint 检查（US ↔ e2e 双向映射、020 文件引用有效性）已绿；全仓 docs-lint 剩余
  失败（章节引用 17 处 + 失效常量 1 处）全部位于并行会话的进行中文件
  （`specs/019-abort-hover-background-tasks/*`、
  `specs/defects/subagent-registry-outlives-dropped-sessions.md`），不在本 spec 范围。

### 反向对照

从实现 diff 反向枚举行为分支逐条对 spec：固定值生命周期稳定与迟到覆盖事件不破坏
固定值（FR-003 正文 + AC-9）、role 缺失按普通会话不置灰与恢复后置灰一致（边界节）、
嵌套 Agent 禁令不变（边界节）、并发槽位共用不分池（边界节）——均有对应条目；
追溯矩阵五个测试落点全部真实存在且绿。实现中未发现 spec 未接的额外行为分支。

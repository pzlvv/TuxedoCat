---
status: 已收敛
---

# 改动规格：Bash 的 restricted 闸门 + 删除提示词模式控制

本次改动是两件互相独立的收紧，共用一次评审：

1. **Bash 新增 `restricted` 参数（布尔、默认 `true`）**。`restricted` 为真时，Bash 在
   执行前拒绝两类写法：命令里出现 `sleep` 命令（引导模型等完成通知，而不是用计时器 poll）、
   以及去掉所有 `cd` 段后只剩 `sed` 的命令（引导模型用 `Read` 工具读文件）。`restricted`
   为假时两条限制都不生效，既有那条「首段 `sleep` + 后续命令」的无条件闸门也一并收进这个
   开关里——限制从「永远生效」变成「模型显式关掉才不生效」。
2. **删除「提示词模式」这一控制**（原取值域为普通 / 极简 / 混合，原实现用
   promptMode / PromptPreset 命名）。从输入区菜单、设置面板、宿主 wire、`UiEvent` /
   `CoreEvent` 契约、`meta.json` 的 `context.promptMode` 落盘字段、`settings.json` 的
   `defaultPromptMode` 默认值、Core 的预设组装与工具白名单、TUI 与 PyCharm 宿主的
   菜单/快照，一路删到测试与 as-built 规格。

交叉引用：read-only 判定与权限三档见 [docs/core/standalone-core.md 第 4 节](../../docs/core/standalone-core.md#4-契约)；
既有 sleep 等待闸门与后台完成通知见 [docs/features/background-bash.md 第 2 节](../../docs/features/background-bash.md#2-功能需求)；
detach 豁免与两条闸门的优先顺序见 [docs/features/bash-detach.md 第 2 节](../../docs/features/bash-detach.md#2-功能需求)；
「不让接口 / 参数可选」与默认值单一来源见 [docs/architecture/principles.md 第 9 节](../../docs/architecture/principles.md#9-同一字段的默认值只有一处)；
会话级配置的归属见 [docs/architecture/core-ui-separation.md 第 4.1 节](../../docs/architecture/core-ui-separation.md#41-归属)。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/background-bash.md](../../docs/features/background-bash.md) | [用户场景与验收标准](../../docs/features/background-bash.md#1-用户场景与验收标准) / [功能需求](../../docs/features/background-bash.md#2-功能需求) / [行为规格](../../docs/features/background-bash.md#3-行为规格) / [边界与错误路径](../../docs/features/background-bash.md#4-边界与错误路径) / [追溯矩阵](../../docs/features/background-bash.md#7-追溯矩阵) | 修改 | FR-005 从「首段 sleep + 后续命令无条件失败」改为「`restricted` 为真时任何 `sleep` 命令都失败」，并新增 FR-012（两条失败文案以 `restricted: false` 逃生口收尾）；AC 与逐字文案重写；删除「系统提示词与工具描述不因本闸门改动」的旧结论 |
| [docs/features/bash-detach.md](../../docs/features/bash-detach.md) | [功能需求](../../docs/features/bash-detach.md#2-功能需求) | 修改 | 「`detach: true` 不解除本闸门」补一句：闸门由 `restricted` 决定是否生效，`detach` 与 `restricted` 互不豁免（只留链接，不复述判据） |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | [US-76](../../docs/features/user-stories/tools.md#us-76-后台等待不靠-sleep-轮询) | 修改 | 验收标准从「首段 sleep + 后续命令」改为「`restricted` 为真时任何 `sleep` 命令」，并去掉「单条 `sleep 5` 放行」 |
| [docs/features/user-stories/tools.md](../../docs/features/user-stories/tools.md) | — | 新增小节 | 新增 US-78（`sed` 全量交给 `Read` 工具）；US 编号唯一性由 docsLint 的 US↔e2e 组校验（[specs/README.md](../../specs/README.md#3-需求-id-与追溯)） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | [目录](../../docs/features/user-stories.md#目录) / [附录：US 与 e2e 场景用例映射](../../docs/features/user-stories.md#附录us-与-e2e-场景用例映射) | 修改 | 分册收录表补 US-78；「未覆盖 e2e 的 US」豁免段登记 US-78 的判定口径 |
| [docs/features/user-stories/dialog-core.md](../../docs/features/user-stories/dialog-core.md) | [US-8](../../docs/features/user-stories/dialog-core.md#us-8-功能开关菜单) / [US-51](../../docs/features/user-stories/dialog-core.md#us-51-子代理角色-explorer文件浏览专用) | 修改 | US-8 菜单项顺序与分段控件删掉提示词模式、去掉「极简模式禁用联网搜索」；US-51 的锁定项从三项变两项、删除「提示词模式恒 normal」例外 |
| [docs/features/user-stories/sessions-and-llm.md](../../docs/features/user-stories/sessions-and-llm.md) | [US-24](../../docs/features/user-stories/sessions-and-llm.md#us-24-默认设置界面语言与界面字号) | 修改 | 「默认提示词模式」从设置面板与「默认配置变化应用于当前对话」清单里删除 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | [US-56](../../docs/features/user-stories/desktop.md#us-56-跨工作区代理) | 修改 | 删除「提示词模式不继承、恒 normal」例外，跨工作区会话改为全量继承、无第二类例外 |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [CoreEvent](../../docs/architecture/events.md#21-coreeventcore--ui单向) / [UiEvent](../../docs/architecture/events.md#23-uieventui--core单向) | 修改 | `sessionConfigChanged` 的 `change.key` 清单去掉 `promptMode`；删除整条 promptModeChanged 行；汇总数量随联合类型重算；`crossWorkspaceAgentRequested` / `remoteSubAgentStarted` 补「无提示词模式」的说明改为无例外全量继承 |
| [docs/architecture/class-diagrams.md](../../docs/architecture/class-diagrams.md) | [第 1 节](../../docs/architecture/class-diagrams.md#1-事件契约与-ui-侧) | 修改 | `UiEvent` 成员串删掉 promptModeChanged |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 4.1 节](../../docs/architecture/core-ui-separation.md#41-归属) / [第 4.3 节](../../docs/architecture/core-ui-separation.md#43-快照字段) | 修改 | owner 表的会话级配置清单去掉 `promptMode`；快照字段表删 `defaultPromptMode` 行 |
| [docs/architecture/principles.md](../../docs/architecture/principles.md) | [第 9 节](../../docs/architecture/principles.md#9-同一字段的默认值只有一处) | 修改 | 默认值唯一来源的字段列举去掉 `promptMode` |
| [docs/architecture/host-ui-modules.md](../../docs/architecture/host-ui-modules.md) | [第 3 节](../../docs/architecture/host-ui-modules.md#3-webviewmessagehandler) | 修改 | 消息类型数量随 entry('setPromptMode') 删除而重算；「会话配置」分区名单去掉 setPromptMode |
| [docs/hosts/webview-facts.md](../../docs/hosts/webview-facts.md) | [第 3 节](../../docs/hosts/webview-facts.md#3-事实清单) / [第 5 节](../../docs/hosts/webview-facts.md#5-会话配置的下发时机) / [第 7 节](../../docs/hosts/webview-facts.md#7-不允许的做法) | 修改 | 会话配置清单、下发时机、变化通知名单去掉提示词模式与 setPromptMode |
| [docs/hosts/tui.md](../../docs/hosts/tui.md) | [第 5 节](../../docs/hosts/tui.md#5-译层映射hostrs--ts-宿主行为) | 修改 | `Ctrl+K` 菜单项、`sessionConfigChanged` 的键翻译、settingsDefaults 字段、会话加载补齐清单去掉 `promptMode` |
| [docs/features/user-message-pipeline.md](../../docs/features/user-message-pipeline.md) | [功能需求](../../docs/features/user-message-pipeline.md#2-功能需求) | 修改 | 「会话覆盖」行的「`promptMode` 由独立的 setPromptMode 消息承载」整句删除 |
| [docs/features/web-search.md](../../docs/features/web-search.md) | [FR-004](../../docs/features/web-search.md#fr-004开关语义) | 修改 | 「仍受提示词模式白名单约束」删除——该约束随预设一起消失 |
| [docs/features/cross-workspace-agent.md](../../docs/features/cross-workspace-agent.md) | [功能需求](../../docs/features/cross-workspace-agent.md#2-功能需求) | 修改 | 「提示词模式不继承、恒 normal」例外段删除；继承清单不再有例外项 |
| [docs/features/cross-workspace-transfer.md](../../docs/features/cross-workspace-transfer.md) | [FR-004](../../docs/features/cross-workspace-transfer.md#fr-004权限与角色绑定) | 修改 | 「minimal / mixed 预设自然不含」的论据删除，角色白名单结论不变 |
| [docs/core/standalone-core.md](../../docs/core/standalone-core.md) | [第 3 节](../../docs/core/standalone-core.md#3-core-形态) | 修改 | 前台超时段落的 sleep 死线后移补一句「仅在 `restricted: false` 时可观察到」 |
| [docs/architecture/contracts.md](../../docs/architecture/contracts.md) | [第 1 节](../../docs/architecture/contracts.md#1-uihost对话-webview-的宿主能力) | 修改 | `settings.json` 内容清单去掉 `defaultPromptMode`（该字段随快照一起删除） |
| `docs/adr/0016-bash-restricted-gate.md` | — | 新增 | 记录「`restricted` 定为模型面收紧开关、缺省为真」的决策、背景与被否决的替代方案；`docs/adr/README.md` 索引补一行 |
| `specs/defects/` 下五个 `status: 已修` 的缺陷规格 | — | 修改 | `session-config-lost-before-first-message` / `subagent-thinking-effort-not-inherited` / `web-search-off-still-usable` / `websearch-recheck-clobbered-by-payload` / `tui-sessionconfig-model-ref-mismatch` 中失效的 `promptMode` 不变量与回归条目就地收窄（缺陷规格是回归证据索引，不归档） |

## 用户场景与验收标准

- 场景 1：模型用 `sleep` 等结果
  - **AC-1**（FR-001）：GIVEN 一次 Bash 调用没带 `restricted` WHEN 执行 THEN 按 `restricted: true` 处理（默认收紧）
  - **AC-2**（FR-002）：GIVEN `restricted` 缺省或为 `true` WHEN 命令按 `;` / `&&` / `||` / `|` / 换行切开后任一段的命令名是 `sleep` THEN 工具结果失败、命令不执行
  - **AC-3**（FR-002）：GIVEN `restricted: true` WHEN 命令是单条 `sleep 5`（没有其它命令）THEN 同样失败（不再有单条 sleep 的放行口）
  - **AC-4**（FR-002）：GIVEN `restricted: true` WHEN `sleep` 只出现在引号内字符串、`#` 注释段或 heredoc 正文里 THEN 命令照常执行，不算「包含 sleep 命令」
  - **AC-5**（FR-005）：GIVEN 被本节拦下 WHEN 观察本轮 THEN 不弹权限确认框、不产生后台任务与 taskId、`manual` / `risk` / `auto` 三档行为与文案完全相同
- 场景 2：模型用 `sed` 替代 Read
  - **AC-6**（FR-003）：GIVEN `restricted` 缺省或为 `true` WHEN 命令分段后去掉所有 `cd` 段、剩余段全部是 `sed` 且至少一段 THEN 工具结果失败、命令不执行，文案引导用 `Read` 工具读文件
  - **AC-7**（FR-003）：GIVEN `restricted: true` WHEN `cd x && sed -n '1,40p' f` / `sed -i 's/a/b/' f` / 多段 `cd` 与 `sed` 交替 THEN 都失败（`sed` 的读与写形态一视同仁）
  - **AC-8**（FR-003）：GIVEN `restricted: true` WHEN 命令里除 `cd` / `sed` 外还有别的段（`sed -n 1p f | head`、`rg x | sed 's/a/b/'`、`git diff | sed -n 1,20p`）THEN 不被本节拦下，按既有权限路径处理
- 场景 3：显式关闭限制
  - **AC-9**（FR-004）：GIVEN `restricted: false` WHEN 命令含 `sleep`（含首段 `sleep` + 后续命令）THEN 不被本节拦下，按既有权限判定与前台超时路径执行
  - **AC-10**（FR-004）：GIVEN `restricted: false` WHEN 命令去掉 `cd` 后只剩 `sed` THEN 不被本节拦下，按既有权限判定执行（`sed` 仍不在只读白名单）
  - **AC-11**（FR-004）：GIVEN `detach: true` 且命中 sleep 或 sed 判据 WHEN `restricted` 缺省 THEN 仍失败（两个字段互不豁免）
- 场景 4：说明面
  - **AC-12**（FR-006）：GIVEN 组装工具的 LLM 可见定义 WHEN 检查 Bash 的 `restricted` 字段 THEN 类型是 `boolean`，说明里写明「默认 true、通常传 true」
  - **AC-13**（FR-006）：GIVEN 组装系统提示词 WHEN 读 Bash 段 THEN 仅有一句 `The restricted parameter is normally true.`（不展开判据与案例）；schema 成员带 `default: true`
  - **AC-25**（FR-012）：GIVEN 命令被 sleep 或 sed 任一分支拦下 WHEN 读失败文案 THEN 末尾是同一句 `- If you are certain this is a false positive, re-run the same command with restricted: false.`
  - **AC-26**（FR-012）：GIVEN 模型判断是误拦截 WHEN 把原命令带上 `restricted: false` 重跑 THEN 闸门不再拦，回到既有权限路径
- 场景 5：删除提示词模式的用户可见入口
  - **AC-14**（FR-008）：GIVEN 打开输入区功能菜单 WHEN 读菜单项 THEN 没有「提示词模式」项与三分段控件，菜单项顺序为 设置 / Spin 设计 / 联网搜索 / MCP / 模型 / 询问模式 / 思考强度
  - **AC-15**（FR-008）：GIVEN 打开设置面板 WHEN 读「默认配置」区 THEN 没有「默认提示词模式」控件；保存配置不再写 `defaultPromptMode`
  - **AC-16**（FR-008）：GIVEN 会话联网搜索开关 WHEN 任意会话配置状态 THEN 不再因「极简提示词模式」置灰，只剩子代理锁定与未就绪两种状态
- 场景 6：删除提示词模式的契约与落盘
  - **AC-17**（FR-007）：GIVEN `AssistantEventBus` 的四组联合类型 WHEN 检索 `promptMode` THEN 无 promptModeChanged、`sessionConfigChanged` 的 `change` 无 `promptMode` 成员
  - **AC-18**（FR-007）：GIVEN 宿主收到 webview 的未知消息 setPromptMode WHEN 处理 THEN 按未知消息忽略（该 wire 类型已从 `WebviewToHostMessage` 删除），不写 `meta.json`
  - **AC-19**（FR-009）：GIVEN 组装系统提示词与工具清单 WHEN 任意会话执行一轮 THEN 恒为「完整核心原则 + `## Tool Usage` + `## Tool Details` + 环境段 + 全部会话可用工具」，不再按预设裁剪
- 场景 7：旧数据与新宿主
  - **AC-20**（FR-010）：GIVEN 旧会话 `meta.json` 的 `context.promptMode` 仍是 `minimal` WHEN 加载并继续对话 THEN 加载成功、该字段原样保留、不参与任何判定
  - **AC-21**（FR-010）：GIVEN 旧 `settings.json` 含顶层 `defaultPromptMode` WHEN 读盘 THEN 键保留不被删除，按「历史遗留字段」口径处理（不报警、不进快照）
  - **AC-22**（FR-011）：GIVEN TUI 与 PyCharm 宿主 WHEN 打开会话配置菜单 / 读设置快照 THEN 均无提示词模式项与 `defaultPromptMode` 字段
- 场景 8：子代理与跨工作区
  - **AC-23**（FR-009）：GIVEN 本地 Master / Explorer 子代理 WHEN 组装提示词与工具清单 THEN 差异只来自角色白名单，会话级配置按既有继承规则处理、无「恒 normal」覆盖
  - **AC-24**（FR-009）：GIVEN 跨工作区派发的对话 WHEN 组装 `crossWorkspaceAgentRequested` / `remoteSubAgentStarted` 载荷 THEN 会话级配置全量继承、无「提示词模式不携带」的例外项

## 功能需求

### FR-001：`restricted` 参数的形态与默认值

Bash 工具新增可选布尔字段 `restricted`，默认 `true`：调用方不传即按 `true` 处理，只有显式
传 `false` 才关闭两条限制。字段进入 LLM 可见的 `input_schema` 与工具入参校验（schema 校验
必须接受该字段，否则真实链路会把它判成未知键），读取口径与既有 `detach` / `run_in_background`
同源（同一处 JS 真值语义），缺省值只在一处定义。

### FR-002：`sleep` 命令一律拒绝

`restricted` 为真时，命令的切分沿用既有 sleep 等待闸门的口径（`gate_segments`：先在
屏蔽 heredoc 正文的副本上按行切开，再用 `split_by_separators` 切 `;` / `&&` / `||` /
`|`，`#` 起头的纯注释段不构成命令），切出来的**任一段**命令名是 `sleep` 即失败——不再区分
它在首段还是后续段、后面有没有别的命令，单条 `sleep 5` 同样失败。命令名判定复用
`extract_command_name`（剥环境变量前缀、首尾各至多去一个引号），不另起一套首词口径。

判定只看「是不是命令」：引号里的字面量、`#` 起头的注释段、heredoc 正文（对 shell 是字面
文本）都不算命中。用于前台超时死线后移与兜底提醒的 `contains_sleep_command` 口径不变
——它是延时估算与提醒门槛，不是闸门。

失败文案说明「不要用 `sleep` 来 poll；可以条件 poll，或直接停止、等结果返回时收到通知」。

### FR-003：`cd` + `sed` 形态拒绝

`restricted` 为真时，按 FR-002 同一口径切分命令（含换行、屏蔽 heredoc 正文、跳过纯注释段），
**去掉所有 `cd` 段**后，若剩余段至少一段且全部是 `sed`，则失败——这类调用是把 `sed` 当
文件读取器用，`Read` 工具才是读文件的入口。判定同时覆盖读形态与写形态（`sed -n` /
`sed -i`），并允许多段 `cd` 与 `sed` 交替（`cd a && cd b && sed -n 1p f`）。只有 `cd` 段、
没有 `sed` 段的命令不命中（剩余段为空）。

只要还有别的段（管道下游 `| head`、上游 `rg`、`git diff` 等）就**不**命中本判据：那是有
上下游的文本加工，不是「拿 `sed` 替代读文件」。

失败文案说明请改用 `Read` 工具读取文件。

### FR-004：`restricted: false` 关闭两条限制

显式传 `restricted: false` 时，FR-002 / FR-003 都不生效，且既有的「首段 `sleep` + 后续命令」
无条件闸门一并收进这个开关——限制的存在与否只有一个开关决定，不再有一条「任何情况都拦」
的旧闸门与之并存。关闭后 `sleep` 照既有口径参与前台超时死线后移，`sed` 照既有权限判定
（不在只读白名单，`manual` 询问、`risk` / `auto` 放行）。

`restricted` 与 `detach` 互不豁免：`detach: true` 不关闭本闸门，`restricted: false` 也不
豁免后台化构造闸门。

### FR-005：闸门落点与三档一致

两条判据在权限层判定为 **deny**（不是 ask），落在只读判定之前：被拦的调用不弹权限确认框、
不产生后台任务与 taskId、不发完成通知或提醒，`manual` / `risk` / `auto` 三档行为与文案完全
相同。判据是纯函数、每个判据只有一份实现；失败文案各只有一个常量。

### FR-006：说明面

Bash 的 schema 字段说明一句话写清「默认 `true`，通常传 `true`」并显式带 `default: true`，
不展开用法与案例；系统提示词的 Bash 段只补一句 `The restricted parameter is normally true.`。
两处都不复述判据细节与逃生口（那些只在失败文案里给）。

### FR-007：删除提示词模式的契约成员

删除 `UiEvent` 的 promptModeChanged、`CoreEvent.sessionConfigChanged.change` 里的
`{ key: 'promptMode' }` 判别成员，以及宿主侧对应的 wire 类型 setPromptMode 与
sessionConfigChanged → setPromptMode 的翻译。Core 的 `dispatch_ui_event` 同步删除该分支；
事件词汇表、类图与聚合数量随之更新。旧版宿主发来的 setPromptMode 按未知消息忽略。

### FR-008：删除提示词模式的用户界面

输入区功能菜单删掉「提示词模式」项与三分段控件；设置面板删掉「默认提示词模式」控件与保存
载荷字段；「极简提示词模式下联网搜索禁用」的置灰与兜底拦截删除。会话选项锁定只剩
联网搜索 / MCP 两项（本地非 Master 子代理）。中英文文案条目一并删除，不留死键。

### FR-009：删除 Core 的提示词预设

删除 `promptMode` 的会话状态与恢复、`sessionConfigChanged` 的 `promptMode` 键、预设组装
（`normal` / `minimal` / `mixed`、工具白名单、极简核心身份、`mixed` 的首轮切换、极简强制
关联网搜索）与 `meta.json` `context.promptMode` 的补写。系统提示词与工具清单恒为完整形态，
过滤只保留角色白名单（Explorer）与会话级联网搜索 / MCP 名单这两条既有链路。子代理与跨工作区
派发删除「提示词模式恒 normal」的赋值与落盘，会话级配置按既有继承规则全量传递。

### FR-010：旧数据的落位

旧 `meta.json` 的 `context.promptMode` 与旧 `settings.json` 的顶层 `defaultPromptMode` 不
迁移、不删除、不读取：`meta.json` 按读-改-写整体保留未知/遗留键；`settings.json` 把
`defaultPromptMode` 归入「历史遗留字段」（与 `theme` / `shortcut` 同口径，保留在文件里、
不进快照、不报 unknown）。**快照必须同步删除该必选字段**——只删一侧会让 Core 因快照缺字段
而永远不就绪。

### FR-011：TUI 与 PyCharm 宿主同步

TUI 的 `Ctrl+K` 会话配置菜单删掉提示词模式项（含二级菜单与快捷键提示）、
`sessionConfigChanged` 的键翻译与 `settingsDefaults` / `conversationLoaded` 补齐字段删除；
PyCharm 插件的设置快照解析、setPromptMode 双向翻译、`settingsDefaults` /
llmConfigPanel / `setNewConversationDefaults` 载荷与 `defaultsChanged` 比对字段删除。
三个宿主的快照字段集合与 Core 保持同一份。

### FR-012：误拦截的逃生口写在失败文案里

两条失败文案都以同一句逃生口收尾：确认这是误拦截时，把同一个命令带上 `restricted: false`
重跑。模型不必改写命令、不必向用户提问，也不必从别处推断这个参数的存在——与
[docs/features/bash-detach.md](../../docs/features/bash-detach.md) 的「失败文案给三条出路」
是同一种教学方式。

## 边界与错误路径

| 情形 | 预期 |
| --- | --- |
| `sleep` 写成绝对路径（`/usr/bin/sleep 10`）或被包裹（`timeout 30 sleep 5`、`bash -c 'sleep 5'`） | 不命中——命令名判定与既有 `sleep` 口径同源（剥环境变量前缀后取首词），绝对路径与包裹写法是既有已知边界，本次不扩判定 |
| `sleep` 出现在引号内（`echo 'sleep 5'`）、`#` 注释段、heredoc 正文 | 不命中：这些位置对 shell 是字面文本 |
| `sleep 5 &` / `sleep 5 & cat a` | `&` 不是既有切分符，`sleep 5 &` 的单段命令名是 `sleep` → 命中失败（`restricted: true` 下 `sleep` 一律拒绝）；本条闸门在权限层先于 detach 闸门判定，`restricted: false` 时 `&` 仍由 detach 闸门拦截 |
| `cd x; sed -n 1p f` / `cd x && cd y && sed ...` | 命中——去掉所有 `cd` 段后只剩 `sed` |
| `sed -n 1p f; echo done` | 不命中——`echo` 不是 `cd`，剩余段不全是 `sed` |
| `sed` 写成绝对路径（`/usr/bin/sed -n 1p f`） | 不命中（与 `sleep` 同一口径，已知边界） |
| 空命令 / 纯空白命令 | 走既有 `Invalid command` 校验，本闸门不接触 |
| `restricted` 传非布尔（`"false"` / `0` / `null`） | 按既有 JS 真值语义归一：字符串 `"false"` 为真（视为 `true`）、`0` / `null` 为假；与 `run_in_background` 的既有 coerce 口径一致，不新增第二套 |
| 权限层拿不到会话工作目录 / 工具名未知 | 与现状一致：未知工具不跑本闸门 |
| 旧会话 `meta.json` 含 `context.promptMode` | 加载成功、字段原样保留、不参与任何判定；不写迁移 |
| 旧 `settings.json` 含 `defaultPromptMode` | 保留在文件里、记入历史遗留字段、不进快照、不报 unknown |
| 旧版宿主发 setPromptMode | 按未知消息忽略（不写 `meta.json`、不回执） |
| 新建会话 / 首条消息前改会话配置 | 不受影响：仍只有 agentMode / thinkingMode（落盘名）/ webSearch / MCP 名单 / 模型身份这几项 |

- **`detach` 的既有缺口不在本次范围**：`detach` 今天没有登记进工具入参校验的 Bash 字段表，
  真实链路上带 `detach: true` 会被判成未知键。本次只为 `restricted` 补登记，不为 `detach`
  补——那是一个独立的缺陷，不夹带进本次改动。
- **失败是工具错误，不是权限拒绝**：`restricted` 的两条判据用 deny 走工具结果失败路径，
  不进用户确认队列；因此被拦的调用在 UI 上只有一张失败卡片。
- **文案不得插值**：两条文案各自只有一个常量，逐字被单测与对照表锁定。

## 非目标

- **不识别绝对路径 / 包裹写法的 `sleep` 与 `sed`**：与既有命令名口径保持一致，扩判定会把
  只读 / 破坏性 / detach 三套判据一起改，属于另一个量级的变更。
- **不改 `sed` 的只读白名单归属**：`sed` 仍不是只读命令，`manual` 下照常询问。
- **不改 `sleep` 的前台超时死线后移**：`restricted: false` 时该行为原样保留。
- **不迁移旧数据**：不删 `meta.json` / `settings.json` 里的遗留字段，也不做一次性清洗任务。
- **不保留极简 / 混合提示词作为别的开关**：没有「省 token 模式」「小白模式」等替代品，功能整体
  删除；将来的同类需求重新走 spec。
- **不动 MCP / 联网搜索 / 角色白名单三条既有过滤链**：它们与预设无关，删除预设不改变其行为。

## 对需求基线的影响

- **修改 US-76**（后台等待不靠 sleep 轮询）：验收标准从「首段 `sleep` + 后续命令」改为
  「`restricted` 为真时任何 `sleep` 命令都失败」，并新增「`restricted: false` 才放行」。
- **新增 US-78**（`sed` 读文件改用 `Read` 工具）：判定只看命令文本，由 core-rs 单测锁定，
  e2e 车道不为纯文本判定新增用例——按既有口径登记在「未覆盖 e2e 的 US」豁免段。
- **修改 US-8 / US-24 / US-51 / US-56**：删除提示词模式相关的菜单项、默认设置项、锁定项与
  跨工作区例外。US-8 / US-24 的 e2e（`e2e/webview/inputMenu.spec.ts` /
  `e2e/webview/settings.spec.ts`）与 US-51 的置灰断言（`subagentOptionsLock.spec.ts` /
  `subagentExplorer.spec.ts`）在同一提交里删掉对应断言。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs`（Bash `input_schema` 的 `restricted` 成员与说明常量）、`core-rs/src/tool_input.rs`（Bash 字段表）、`core-rs/fixtures/toolSchema.json` / `toolInputValidation.json` | `core-rs/src/tools_tests.rs` 的 `bash_schema_exposes_restricted_with_minimal_description` / `tool_input_validation_parity_tests`；`core-rs/src/tools_tests.rs` 的 `schema_parity_tests` | 自动 |
| FR-002 | `core-rs/src/tools.rs` 的纯函数（`gate_segments` 共用切段 + `has_sleep_command`，命令名判定复用 `extract_command_name`）、文案常量；`core-rs/src/permission.rs` 的 Bash 分支 | `core-rs/src/tools_tests.rs` 的 `restricted_gate_rejects_sleep_anywhere`；`core-rs/src/permission_tests.rs` 的 `restricted_sleep_gate_denies_in_every_agent_mode` / `restricted_gate_ignores_quoted_comment_and_heredoc_sleep` | 自动 |
| FR-003 | `core-rs/src/tools.rs` 的纯函数（去 `cd` 段后判定 `sed`）、文案常量；`core-rs/src/permission.rs` 的 Bash 分支 | `core-rs/src/tools_tests.rs` 的 `restricted_gate_rejects_cd_and_sed_only`；`core-rs/src/permission_tests.rs` 的 `restricted_sed_gate_denies_in_every_agent_mode` | 自动 |
| FR-004 | `core-rs/src/tools.rs` 的 `restricted` 读取（缺省 `true`）、`core-rs/src/permission.rs` 的 Bash 分支；`docs/features/background-bash.md` 的 FR-005 改写 | `core-rs/src/permission_tests.rs` 的 `restricted_false_lifts_both_gates` / `restricted_false_keeps_detach_gate`；对照表 `core-rs/fixtures/permission.json` | 自动 |
| FR-005 | `core-rs/src/permission.rs` 的 `base_check` Bash 分支（两处 deny，判据在只读判定之前） | `core-rs/src/permission_tests.rs` 的 `restricted_gates_do_not_use_ask` / `restricted_sleep_branch_wins_over_sed_branch` / `restricted_gate_wins_over_detach_gate`；`core-rs/fixtures/permission.json` 的三档对照 | 自动 |
| FR-006 | `core-rs/src/prompt.rs` 的 `TOOL_DETAILS_BEFORE_TRANSFER` Bash 段、`core-rs/src/tools.rs` 的字段说明常量 | `core-rs/src/prompt_tests.rs` 的 `system_prompt_static_text_matches_the_shared_table`；`core-rs/fixtures/systemPrompt.json` | 自动 |
| FR-012 | `core-rs/src/tools.rs` 的 `BASH_RESTRICTED_SLEEP_MESSAGE` / `BASH_RESTRICTED_SED_MESSAGE` 末行 | `core-rs/src/permission_tests.rs` 的 `restricted_messages_name_the_escape_hatch` / `restricted_false_lifts_both_gates` | 自动 |
| FR-007 | `src/shared/AssistantEventBus.ts`、`src/host/webviewMessages.ts`、`src/host/WebViewUI.ts`、`src/host/ui/webviewMessageHandler.ts`、`core-rs/src/main.rs`、`core-rs/fixtures/eventTypes.json` | `src/test/docsLint.test.ts` 的事件词汇表组；`src/test/legacyPromptModeMessage.test.ts`（旧 `setPromptMode` 按未知消息忽略）；`core-rs/src/main_tests.rs` 的 `dispatch_ui_event_covers_every_ui_event_type` | 自动 |
| FR-008 | `src/webview/InputArea.tsx`、`src/webview/App.tsx`、`src/webview/LLMConfigPanel.tsx`、`src/webview/inputAreaState.ts`、`src/webview/i18n/zh.ts`、`src/webview/i18n/en.ts`、`src/host/settingsRead.ts`、`src/host/llmConfigSave.ts` | `src/test/inputAreaState.test.ts`、`src/test/webviewFacts.test.ts`、`e2e/webview/inputMenu.spec.ts`、`e2e/webview/settings.spec.ts`、`e2e/webview/subagentOptionsLock.spec.ts` | 自动 |
| FR-009 | `core-rs/src/prompt.rs`（删预设函数，收归单一组装）、`core-rs/src/engine.rs`（会话状态、恢复、子代理、查询循环、`sessionConfigChanged` 键）、`core-rs/src/history.rs`（`touch_metadata` 不再补写）、`core-rs/src/settings.rs`（快照字段） | `core-rs/src/prompt_tests.rs` 的 `system_prompt_always_contains_the_full_sections`、`core-rs/src/engine_tests.rs` 的 `prompt_and_tool_list_are_never_trimmed_by_a_preset` / `legacy_prompt_mode_in_metadata_is_inert` / `explorer_fixes_session_config_while_master_inherits`、`core-rs/src/history_tests.rs`、`core-rs/src/settings_tests.rs` | 自动 |
| FR-010 | `core-rs/src/history.rs`（读-改-写保留遗留键）、`src/host/SettingsStore.ts`（`KNOWN_TOP_LEVEL_KEYS` 归入历史遗留字段）、`src/shared/settingsSnapshot.ts`（删字段）、`core-rs/src/settings.rs`（删必选字段） | `src/test/settingsSnapshot.test.ts`（遗留 `defaultPromptMode` 不进快照 / 不报 unknown / 写盘保留）、`core-rs/src/engine_tests.rs` 的 `legacy_prompt_mode_in_metadata_is_inert`、`src/test/settingsConcurrency.test.ts`、`src/test/hostSettings.test.ts` | 自动 |
| FR-011 | `tui-rs/src/app.rs`、`tui-rs/src/host.rs`、`tui-rs/src/settings.rs`、`tui-rs/src/store.rs`、`pycharm-plugin/src/main/kotlin/pycharm/host/{settings/SettingsSnapshot.kt,ui/HostUi.kt,llm/LlmConfigSave.kt}` | `tui-rs/src/settings_tests.rs` 的 `snapshot_payload_round_shape`（顶层键集 = llm / mcp / defaultAgentMode）、`tui-rs/src/host.rs` 的 `session_config_drops_removed_prompt_mode_key`、`pycharm-plugin/src/test/kotlin/pycharm/host/SettingsAndLockTest.kt` 的快照键集断言 | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

### 已满足

前置闸门：`npm run check-types`、`npm run lint`、`npm run check-types:e2e`、
`npm run fmt:rust:check`、`npm run test:unit`（111 通过 / 2 skip，skip 为
sidebarDocViewGit、sidebarFiles 的环境前置）、`npm run test:core`（1206 通过 / 0 失败，
先 `npm run build:core:host`）、`npm run test:unit -- docs-lint` 全绿。受本次改动影响的
`--project=webview-ui` 三条 e2e 实跑通过（`inputMenu` + subagentOptionsLock 16 passed、
`settings` 18 passed）。

- **AC-1 / FR-001**（缺省按 `true`）：`core-rs/src/tools.rs` 的 `bash_restricted` 缺省
  `true`，给定值走 `js_coerce_bool`；落点 `core-rs/src/permission_tests.rs` 的
  `restricted_defaults_to_true`（含 `"false"` / `0` / `null` 的真值语义）。
- **AC-2 / AC-3 / FR-002**（任一段 `sleep` 即失败，含单条）：`tools.rs` 的
  `has_sleep_command`（共用 `gate_segments`）；落点 `core-rs/src/tools_tests.rs` 的
  `restricted_gate_rejects_sleep_anywhere`（含 `sleep 30` 单条、`cat a.txt; sleep 30`、
  换行分隔）与 `permission_tests.rs` 的 `restricted_sleep_gate_denies_in_every_agent_mode`。
- **AC-4**（引号 / 注释 / heredoc 正文不命中）：`gate_segments` 屏蔽 heredoc 正文、跳过
  纯注释段；落点 `tools_tests.rs` 的 `restricted_gate_rejects_sleep_anywhere` 反向用例
  与 `permission_tests.rs` 的 `restricted_gate_ignores_quoted_comment_and_heredoc_sleep`。
- **AC-5 / FR-005**（deny 而非 ask、三档一致、不弹确认框）：`permission.rs` 的
  `base_check` Bash 分支在 `is_read_only_command` 之前返回 `CheckResult::deny`；落点
  `permission_tests.rs` 的 `restricted_gates_do_not_use_ask`（本次新增）、
  `restricted_sleep_gate_denies_in_every_agent_mode` /
  `restricted_sed_gate_denies_in_every_agent_mode`（三档逐档断言），对照表
  `core-rs/fixtures/permission.json` 的三档条目。
- **AC-6 / AC-7 / FR-003**（去 `cd` 段后只剩 `sed`）：`tools.rs` 的
  `is_cd_sed_only_command`（读 / 写形态一视同仁、多段 `cd` 与 `sed` 交替）；落点
  `tools_tests.rs` 的 `restricted_gate_rejects_cd_and_sed_only`。
- **AC-8**（有上下游不命中）：同一用例的反向列表（`sed -n 1p f | head`、
  `rg x src | sed 's/a/b/'`、`git diff | sed -n '1,20p'`、`sed -n 1p f; echo done`）。
- **AC-9 / AC-10 / FR-004**（`restricted: false` 关闭两条限制）：落点
  `permission_tests.rs` 的 `restricted_false_lifts_both_gates`（sleep 与 `cd`+`sed`
  都回到 manual=Ask / risk=Allow），对照表 `permission.json` 的 `restricted: false` 条目。
- **AC-11**（`detach` 与 `restricted` 互不豁免）：落点 `restricted_gate_is_not_lifted_by_detach`
  / `restricted_false_keeps_detach_gate` / `restricted_gate_wins_over_detach_gate`。
- **AC-12 / AC-13 / FR-006**（说明面最小披露）：`tools.rs` 的 `BASH_RESTRICTED_FIELD`
  带 `default: true`、系统提示词 Bash 段一句 `The restricted parameter is normally true.`；
  落点 `tools_tests.rs` 的 `bash_schema_exposes_restricted_with_minimal_description`
  （本次新增，锁类型 / `default` / 文案关键词 / 不复述判据）与
  `prompt_tests.rs` 的 `system_prompt_static_text_matches_the_shared_table`、对照表
  `toolSchema.json` / `systemPrompt.json`。
- **AC-25 / AC-26 / FR-012**（同一句逃生口收尾）：两条文案常量末行逐字一致；落点
  `permission_tests.rs` 的 `restricted_messages_name_the_escape_hatch`。
- **AC-14 / AC-15 / AC-16 / FR-008**（UI 入口与置灰）：`InputArea.tsx` 菜单项顺序为
  设置 / Spin 设计 / 联网搜索 / MCP / 模型 / 询问模式 / 思考强度，`LLMConfigPanel.tsx`
  无默认提示词模式控件，`resolveSessionOptionsLocked` 只剩子代理锁定一种置灰来源；
  落点 `e2e/webview/inputMenu.spec.ts`（菜单项齐全）、`e2e/webview/settings.spec.ts`
  （`saveLLMConfig` 不再带 `defaultPromptMode`）、`e2e/webview/subagentOptionsLock.spec.ts`
  （置灰只剩联网搜索 / MCP）、`src/test/inputAreaState.test.ts`。
- **AC-17 / FR-007**（契约成员删除）：四组联合类型里 `promptMode` 零命中；落点
  `src/test/docsLint.test.ts` 的事件词汇表组与 `core-rs/src/main_tests.rs` 的
  `dispatch_ui_event_covers_every_ui_event_type`。
- **AC-18**（旧 `setPromptMode` 按未知消息忽略）：`webviewMessageHandler.ts` 的
  `dispatchWebviewMessage` 兜底分支记 warning 后返回；落点
  `src/test/legacyPromptModeMessage.test.ts`（本次新增：不抛错、不产生 `UiEvent`、
  不回执、不写 settings）。
- **AC-19 / AC-23 / FR-009**（提示词与工具清单不再按预设裁剪）：`prompt.rs` 只剩单一
  `build_system_prompt`，`engine.rs` 无 preset 分支；落点 `prompt_tests.rs` 的
  `system_prompt_always_contains_the_full_sections`、`engine_tests.rs` 的
  `prompt_and_tool_list_are_never_trimmed_by_a_preset`、
  `explorer_fixes_session_config_while_master_inherits`。
- **AC-20 / AC-21 / FR-010**（旧数据不迁移、不读、不删）：`history.rs` 的
  `touch_metadata` 不再补写、读-改-写整份保留；`SettingsStore.ts` 把
  `defaultPromptMode` 归入历史遗留字段。落点 `engine_tests.rs` 的
  `legacy_prompt_mode_in_metadata_is_inert`、`src/test/settingsSnapshot.test.ts` 的
  遗留键用例（本次新增：不进快照 / 不报 unknown / 写盘保留）。
- **AC-22 / FR-011**（TUI 与 PyCharm 同步）：`tui-rs` 无 `Menu::PromptMode` 与
  `promptMode` 翻译、`settingsDefaults` 无该字段；PyCharm 快照解析与双向翻译同删。
  落点 `tui-rs/src/settings_tests.rs` 的 `snapshot_payload_round_shape`（本次补顶层
  键集断言）、`tui-rs/src/host.rs` 的 `session_config_drops_removed_prompt_mode_key`
  （本次新增）、`pycharm-plugin/.../SettingsAndLockTest.kt` 的快照键集断言。
- **AC-24**（跨工作区全量继承、无例外项）：`AssistantEventBus.ts` 两个载荷无
  `promptMode`，`engine.rs` 的 `start_remote_sub_agent` 全量应用；落点
  `engine_tests.rs` 的跨工作区载荷断言（`mcpServers` / `thinkingEffort` / `webSearch`）
  与 `cross_workspace_spawn_payload_falls_back_to_global_defaults`。

### 偏差

收敛时发现并已就地修正的偏差（均改代码或改 spec，留痕于此）：

1. **追溯矩阵两处虚指**：`bash_schema_exposes_restricted_with_minimal_description` 与
   `restricted_gates_do_not_use_ask` 在矩阵里被引用但当时不存在 → 补测试（均通过），
   矩阵保留原引用。
2. **`schema_parity_tests` 指向不存在**：Rust 侧的真实函数名是
   `matches_the_shared_tool_schema_table`（在 `mod schema_parity_tests` 内）→ 文档
   `docs/features/background-bash.md` 与 spec 矩阵改为模块名 + 真实用例名。
3. **FR-002 实现描述漂移**：spec 原文写「sleep 判定复用 `contains_sleep_command`」，
   实现是新增的 `gate_segments` + `has_sleep_command`（口径不同：前者不认换行、不屏蔽
   heredoc）→ spec 改为实际实现，矩阵同步。
4. **AC 编号挂错 FR**：`docs/features/background-bash.md` 的 AC-19 标 `（FR-004）`，
   而 `restricted: false` 在本规格是 FR-005 → 改正。
5. **未声明的基线变更**：`docs/adr/0016-bash-restricted-gate.md`（新增）与
   `docs/architecture/contracts.md`（`settings.json` 字段清单去 `defaultPromptMode`）
   实际已改但「影响基线」未登记 → 补两行。
6. **残留死引用**：`src/host/settingsRead.ts` 有一行孤立注释「新对话的默认提示词模式」，
   `InputArea.tsx` 仍引用已删除的 inputArea.webSearchMinimalHint（i18n 键已删，
   运行期会打 missing-key warning）→ 一并清除，`webSearchDisabled` 只剩子代理锁定一种
   来源（与 AC-16 一致）。
7. **代码与测试注释残留提示词模式**：`src/webview/**`、`src/shared/AssistantEventBus.ts`、
   `src/host/WebViewUI.ts`、`core-rs/src/engine.rs`、`core-rs/src/tools.rs`、`core-rs/src/engine_tests.rs`、
   `src/test/inputAreaState.test.ts` 里「提示词模式 / 预设 / 恒 normal」的描述与实际行为
   不符 → 全部改为现状描述（「无例外项」「只剩一种组装形态」）。
8. **`specs/defects/` 收窄不彻底**：五个已修缺陷规格中 `tui-snapshot-missing-multimodal`
   的 `defaultPromptMode` 与另两处的 `promptMode` 残留 → 就地收窄。
9. **`docs/architecture/events.md` 一处标点残留**：`remoteSubAgentStarted` 行的
   `specs/025 FR-005；）` → 去掉多余分号。
10. **文档小节顺序**：`docs/features/user-stories/tools.md` 的 US-78 被插到
    「联网搜索」章节标题之后 → 移回 EP-7 工具章节内、按编号排在 US-77 之后。
11. **行为分支缺测试**：文档承诺「sleep 与 sed 两条判据都命中时先报 sleep 文案」，此前
    只测了 sleep+detach → 新增 `restricted_sleep_branch_wins_over_sed_branch`。

### 未做

- **TUI crate 的 `cargo test` 在干净工作区跑不通**（既有问题，与本次改动无关）：
  `tui-rs/src/core_root_tests.rs` 的 `shared_fd_lives_beside_slots` 类型不匹配
  （`Option<&Path>` vs `Option<Option<&Path>>`，来自提交 `326d061`）。本次新增的
  `session_config_drops_removed_prompt_mode_key` 与补强的 `snapshot_payload_round_shape`
  用临时补丁跑过（85 passed / 0 failed），补丁已还原、未进仓库。已回写 `tasks.md`
  作为遗留项。
- **完整 e2e 车道未在本次收敛中执行**：`--project=webview-ui` 下受本次改动影响的三条
  用例已实跑并全绿——`e2e/webview/inputMenu.spec.ts` + `subagentOptionsLock.spec.ts`
  16 passed、`e2e/webview/settings.spec.ts` 18 passed（AC-14 / AC-15 / AC-16 的端到端
  证据）。其余车道（`electron-app` / `remote-workspace-ui` / `terminal-ui` /
  `tui-installer`）与 `npm run test:e2e:local` 全量留给 CI 的 `all.yml`，`tasks.md`
  的 T021 跟踪。

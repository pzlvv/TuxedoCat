---
owner: pzlvv
last_reviewed: 2026-10-20
---

# 规格：用户消息管线

本规格描述用户消息从 webview 输入到进入 LLM 上下文的完整管线：入口唯一、命令在轮次边界
解析、排队状态与消息归属一致、Skill 注入顺序唯一、系统环境信息按工作目录缓存、斜杠补全的
替换边界由光标定义。

交叉引用：UiEvent 词汇表见 [events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)；
宿主契约见 [contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)（ConversationManager）、
[第 3 节](../architecture/host-ui-modules.md#3-webviewmessagehandler)（WebviewMessageHandler）、[第 4 节](../architecture/host-ui-modules.md#4-端口webviewuiport)（WebViewUiPort）；`queryBegin` / `queryEnd` 去重见
[docs/hosts/webview-ui.md 第 7 节](../hosts/webview-ui.md#7-查询计数querybegin--queryend-去重)；
「不过度 fallback」见 [principles.md 第 1 节](../architecture/principles.md#1-不过度-fallback)、
「一份事实只有一个写入点」见 [principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)。

## 1. 用户场景与验收标准

- 场景 1：发送普通消息
  - **AC-1**（FR-001）：GIVEN 引擎不存在 WHEN 发送用户消息 THEN 引擎被建立、消息进入队列，不经过第二条处理路径
  - **AC-2**（FR-003）：GIVEN 引擎空闲 WHEN 发送普通消息 THEN 立即乐观回显，不产生排队项
- 场景 2：命令消息
  - **AC-3**（FR-002）：GIVEN 查询进行中 WHEN 发送内置命令 THEN 命令在该轮 query 结束后执行一次；查询进行中不执行、不注入
  - **AC-4**（FR-004）：GIVEN 首条消息是 Skill 命令 WHEN 消费 THEN 上下文顺序为 `[用户消息, tool_use(Skill), tool_result]`，后续消息同序
- 场景 3：排队与撤回
  - **AC-5**（FR-003）：GIVEN 查询进行中 WHEN 发送内置命令 THEN 排队项在执行后被清除，`queryEnd` 不重复投递
  - **AC-6**（FR-003）：GIVEN 查询进行中 WHEN 发送 Skill 命令 THEN 消息进入上下文时补发用户气泡、排队项被清除
  - **AC-7**（FR-003）：GIVEN 连续两次发送相同文本 WHEN 消费 THEN 各自的排队项按 `uuid` 独立清除
  - **AC-8**（FR-003）：GIVEN 用户中止查询 WHEN 存在未消费的排队项 THEN 回填输入框
  - **AC-9**（FR-003）：GIVEN 排队项 WHEN 用户点「编辑」 THEN 排队项消失、消息回填输入框、引擎不再消费它；正在运行的查询不受影响
  - **AC-10**（FR-003）：GIVEN 已被消费的消息 WHEN 用户点「删除」 THEN 按 `uuid` 不匹配而保持不动
  - **AC-11**（FR-003）：GIVEN 存在排队项 WHEN 渲染发送按钮 THEN 禁用；撤回（编辑 / 删除）后恢复可用
  - **AC-12**（FR-003）：GIVEN `requestSessionRuntimeStates` WHEN 回包 THEN 只投递给请求方视图
- 场景 4：系统环境信息
  - **AC-13**（FR-005）：GIVEN 切换工作目录后切回 WHEN 会话创建 / 恢复 THEN 该目录的 git 信息与技能清单重新计算
  - **AC-14**（FR-005）：GIVEN 两个工作目录的会话 WHEN 各自取系统环境信息 THEN 各自命中自己目录的缓存条目
- 场景 5：斜杠补全
  - **AC-15**（FR-006）：GIVEN 已有正文 WHEN 补 `/` 后选补全 THEN 正文保留，结果为 `/${skillName} 正文`
  - **AC-16**（FR-006）：GIVEN 输入不以 `/` 开头 WHEN 输入 THEN 不展示补全菜单
- 场景 6：空闲发送
  - **AC-17**（FR-003）：GIVEN 会话忙碌 WHEN 以「空闲发送」提交 THEN 消息不上送宿主，横幅登记该项且标明「空闲后发送」
  - **AC-18**（FR-003）：GIVEN 空闲挂起项 WHEN 该会话快照变为 idle THEN 挂起项自动按立即发送语义提交、横幅清除
  - **AC-19**（FR-003）：GIVEN 空闲挂起项 WHEN 用户中止该会话 THEN 挂起项回填输入框、不再自动提交；空闲推送与带中止标记的 `queryEnd` 竞态以中止回填收敛
  - **AC-20**（FR-003）：GIVEN 空闲挂起项 WHEN 编辑 / 删除 THEN 本地清除并回填 / 丢弃，无 `discardQueuedMessage` 上行
  - **AC-21**（FR-003）：GIVEN 空闲挂起项 WHEN 非空快照不再包含该会话或 webview 重载 THEN 挂起项清除 / 丢失、不投递
- 场景 7：Spin 模式
  - **AC-22**（FR-007）：GIVEN 会话处于 spin 模式 WHEN 收到用户消息 THEN Core 丢弃该消息，不入队、不进上下文、不发起 LLM 轮次
  - **AC-23**（FR-007）：GIVEN spin 子代理已投递过 Reply WHEN 同一子代理再次投递 Reply THEN 只保留首条 silent 上下文与一次验收判定，后续 Reply 忽略且不发起父对话 LLM 轮次
  - **AC-24**（FR-007）：GIVEN spin 子代理在 Spin 结束后才投递首条 Reply WHEN 投递 THEN 只落 silent 上下文，不进入消费队列、不发起父对话 LLM 轮次

## 2. 功能需求

### FR-001：唯一入口

webview 的用户消息经宿主 `WebviewMessageHandler` 的一个处理器进入管线。该处理器是用户消息的
唯一处理路径。

- 协议中用户消息的类型是 `sendMessage`；`queueMessage` 不作为独立类型存在。
- 处理器不区分「新消息」与「排队消息」：是否排队由引擎的忙碌状态决定，不由消息类型决定。

处理器只做「宿主侧」的事，然后发 `UiEvent.userMessageSubmitted`：

| 步骤 | 内容 |
| --- | --- |
| 活动计时 | `noteSessionActivity(sessionId)`（空闲回收只在 VS Code 生效，见 [contracts.md 第 4 节](../architecture/contracts.md#4-对话相关数据conversationmanager)） |
| 消息身份 | 生成 `uuid` 并回带进 `UiEvent`；core 落盘沿用同一个 uuid，UI 按它配对排队项与用户气泡 |
| 排队判定 | 读 core 的会话运行时快照：该会话 `idle === false` 时登记排队项并置 `deferEcho`；命令消息（`/` 开头）即使空闲也置 `deferEcho`、不做乐观回显（内置命令就地执行、不落盘，立刻画气泡会留下刷新后消失的「幽灵」消息）；其余空闲消息乐观回显（FR-003） |
| 字段翻译 | wire 的 `selectedLines` 翻译成 `UiEvent` 的 `fileSelectedLines`（[events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)） |
| 会话覆盖 | `agentMode` / `thinkingMode` / `webSearch` / 模型身份（provider + model）随 `UiEvent` 下发；`promptMode` 由独立的 `setPromptMode` 消息承载 |
| 入队 | 发 `UiEvent.userMessageSubmitted`：取 / 建引擎、应用会话覆盖、入队、命令解析都在 core 侧 |

- 引擎创建不预置用户消息：`initialMessages` 为空，首条消息与后续消息同路径。
- 发送区 UI 不改变唯一入口：主按钮恒为立即发送；「空闲发送」（下拉项）在 webview 本地
  挂起，触发时仍以 `sendMessage` 进入本管线（FR-003）。
- 查询开始 / 结束状态由 core 在消费循环里发（`queryBegin` / `queryEnd`，见
  [docs/hosts/webview-ui.md 第 7 节](../hosts/webview-ui.md#7-查询计数querybegin--queryend-去重)）。
- 无工作目录的会话不进入管线：webview 显示引导，不发送消息。
- 入口不解析命令、不注入 Skill、不执行内置命令、不把消息直接写入 LLM 上下文。这些语义只在引擎的
  消费循环内决定。因此不存在「调用方已解析、消费方再解析」的重复解析，也不需要表达「调用方已解析」的标记。

### FR-002：命令在轮次边界解析

消费循环在每轮 query 开始前，对队首的用户消息做一次命令解析。解析发生在轮次边界：

- 上一轮 query（可能包含多步工具调用）结束之后；
- 本轮 query 开始之前。

查询进行中不解析队首命令：多步工具调用中途到达的命令消息停留在待处理队列，直到该轮 query 结束。

| 结果 | 判定 | 消息去向 | 本轮 LLM |
| --- | --- | --- | --- |
| 内置命令 | 匹配内置命令名 / 别名 | 就地执行，不进入 LLM 上下文 | 不运行 |
| Skill 命令 | 匹配 Skill 名 / 别名 | 进入 LLM 上下文 | 运行 |
| 其它 | 未匹配任何命令 / Skill | 进入 LLM 上下文 | 运行 |

- 命令名与参数的分割口径：第一个空白之前是命令名，其余（含换行）是参数。
- 命令消息只解析一次：解析结果就地消费该消息（内置命令）或标记待注入（Skill）。
- **`@` 工作区命令**（[cross-workspace-agent.md](cross-workspace-agent.md) FR-008）同一位置解析：
  去首尾空白后以 `@` 开头的消息，身份取引号形态 `@"..."` 的引号内文本、或到第一个空白为止；
  用户消息照常进上下文，随后注入一条 silent reminder（点名 `Agent.target`）。
  仅在宿主声明 `crossWorkspaceAgent` 时生效。

### FR-003：排队状态与消息归属一致

**登记**：宿主按 core 推送的会话运行时快照判断忙碌：该会话 `idle === false`（消费循环运行中 / 压缩中 /
有后台任务或子代理）时，消息要等下一次 LLM 请求才进入上下文，因此宿主

- 向 webview 回推 `queuedMessage`（携带该用户消息的 `uuid` 与选中的文件信息），webview 按会话
  登记排队项，不做发送侧乐观回显；
- 给 `UiEvent.userMessageSubmitted` 带上 `deferEcho`，由 core 在消息真正进入上下文时补发用户气泡。

空闲（`idle === true`，或快照里没有该会话）且**不是命令消息**（`/` 开头）时仍是发送侧乐观回显，
不登记排队项；命令消息无论忙闲都置 `deferEcho`、不乐观回显，由 core 在消息真正进入上下文时
补发用户气泡（Skill 命令）或干脆不发（内置命令就地执行、不落盘）。

**清除**：

| 时机 | 发出方 | 消息 |
| --- | --- | --- |
| 消息进入 LLM 上下文（补发用户气泡） | 引擎消费循环 | `addMessage`（role = user，含 `uuid`） |
| 内置命令就地执行 | 宿主（`commandDispatched`） | `clearQueuedMessage` |
| 会话关闭 / 释放 | 宿主 | `clearQueuedMessage` |
| 用户在排队项上点「编辑 / 删除」 | webview 本地清除；宿主把 `discardQueuedMessage` 翻译成 `UiEvent.queuedMessageDiscarded` | core 按 `uuid` 丢弃引擎里尚未消费的同一消息（已被消费或被更新的排队消息替换时不动） |

内置命令不进入上下文、不产生用户气泡，其排队项由 `commandDispatched` 显式清除。清除按排队项的
`uuid` 匹配，不按文本内容匹配。

用户撤回（编辑 / 删除）是 webview 自己发起的动作：webview 先本地清除排队项，再发
`discardQueuedMessage` 让 core 丢弃引擎队列里的同一消息，两步用同一 `uuid` 关联。撤回不置
abort 标记、不打断正在运行的查询。「编辑」在清除排队项的同时把消息回填输入框（与 abort 在
`queryEnd` 的回填共用同一实现 `restoreQueuedMessageToInput`），「删除」直接丢弃。存在排队项
期间发送按钮禁用：排队项一次只有一条，改主意走编辑 / 删除，不靠继续提交覆盖。

**兜底回投**：`queryEnd` 到达时，webview 对仍登记的排队项做一次回投：

- 用户主动中止的会话：回填输入框，等待用户确认；
- 其它：作为 `sendMessage` 重新提交。

已消费 / 已执行的消息在 `queryEnd` 之前清除了排队项，因此回投只作用于真正未被消费的消息
（入队失败 / 引擎缺失）。

**顺序**：同一会话内，`queuedMessage` 先于该消息的 `addMessage` / `clearQueuedMessage` 到达。

**空闲挂起（webview 本地）**：发送区下拉的「空闲发送」把提交时机推迟到会话完全空闲：

- 挂起项不上送宿主：`sendMessage` wire 类型与载荷、`onQueuedMessage` 登记口径都不变，
  挂起事实由 webview 持有；横幅按当前会话派生展示，标签「空闲后发送」与忙碌排队的
  「等待中」区分等待条件。
- 触发以 core 推送的会话运行时快照为准：该会话显式 `idle === true`（无进行中查询 /
  等待用户输入 / 压缩 / 后台任务 / 子代理）才按立即发送语义提交；快照缺失不触发
  （不过度 fallback）。提交走本节顶端登记的同一入口，此刻若会话又忙碌则落入既有忙碌
  排队语义，消息不丢。
- 中止回填优先：用户中止时挂起项随中止回填输入框、不再自动提交（与忙碌排队的中止
  回填共用同一实现）；空闲推送与带中止标记的 `queryEnd` 竞态以中止回填收敛——回填先
  清除挂起项，后到的触发 no-op。
- 清除：**非空**快照中不再包含该会话（已关闭 / 释放）即清除；空快照视为信息不足
  （启动期补拉的种子），不回收、不触发。webview 重载即丢失（本地状态，无持久化）。
- 挂起项与忙碌排队项同为一次一条：任一存在期间发送区禁用；编辑 / 删除是纯本地动作，
  无 `discardQueuedMessage` 上行。

### FR-004：Skill 注入顺序唯一

Skill 命令的注入内容是一条 assistant `tool_use`（`name: 'Skill'`）与对应的 `tool_result`
（携带技能正文）。上下文顺序固定为：

```
[..., 用户消息, assistant(tool_use: Skill), tool_result]
```

首条消息与后续消息共用同一段注入逻辑，顺序一致。用户消息在消费时追加到上下文末尾，
Skill 的 `tool_use` / `tool_result` 紧跟在用户消息之后。

### FR-005：系统环境信息按工作目录缓存

系统环境信息（git 信息、技能清单、可用命令）是 system prompt 的输入，按工作目录区分
（`core-rs/src/prompt.rs`）。

| 操作 | 语义 |
| --- | --- |
| 取系统环境信息（`cwd`） | 命中 `cwd` 的缓存条目则返回；未命中则计算并写入（如 `GIT_CACHE` 按 `cwd` 分桶） |
| 会话创建 / 恢复时的刷新 | 重新计算该目录的条目并覆盖（刷新语义） |

- 缓存键是工作目录；不同目录的条目互不命中。
- 条目数量有上限；超出时淘汰最早写入的条目。
- 预热是刷新：为某工作目录下的会话创建 / 恢复引擎时，该目录的 git 信息与技能清单重新计算。
- git 信息依赖 `cwd`；命中缓存时不重复执行 git 命令。

### FR-006：斜杠补全

**命令名区间与查询词**。输入以 `/` 开头时：

- 命令名区间 = `/` 之后到第一个空白（空格 / 制表 / 换行）之前，或到输入末尾；
- 光标位于命令名区间内（含区间起点）时展示补全菜单；
- 查询词 = 命令名区间内、光标之前的文本；菜单按查询词过滤。

只看「输入里有没有空白」不足以判断用户是否在输入命令名：输入框已有正文时，正文里的空白属于
正文。

**`@` 工作区补全**（[cross-workspace-agent.md](cross-workspace-agent.md) FR-007）。同一套区间与替换规则，
差异：

- 触发字符是 `@`，候选是宿主下发的「除来源视图所属工作区之外的已打开工作区」；
- 身份两种形态：引号 `@"..."` 到下一个 `"` 止（支持含空格的路径），否则到第一个空白止；
- 插入 `@<身份> `；身份含空白时插入 `@"<身份>" `；引号形态的替换范围到闭合引号；
- 键盘操作、首字符限定与多行正文与 `/` 一致。

**选中替换**。选中补全项时：

- 替换范围 = `/` 到光标之间的文本；
- 插入文本 = `/${skillName} `；
- 光标之后的原文保持不变；
- 选中后光标置于输入末尾。

替换边界由光标定义：「在已有正文前补 `/` 再选补全」的输入保留正文；光标位于命令名中间时，
区间内光标之后的字符保持不变，由用户继续编辑。

### FR-007：Spin 模式下的用户输入与 Reply 投递

Spin 模式（`WorkMode::Spin`）期间父对话完全由 SpinLoop 程序驱动，不参与 LLM 消费循环。

- **用户输入**：`UiEvent.userMessageSubmitted` 在 Core 侧直接丢弃——不入队、不进上下文、
  不拉起消费循环。webview 同时禁用输入框（US-39），Core 的丢弃是兜底，不依赖 UI 状态。
- **进入 spin**：清掉排队中的自动消息与 Reminder，并复位 Reminder 驱动标记；Spin 期间
  后续到达的自动消息也不入队。这样 Spin 结束后消费循环不会拿到旧消息跑 LLM。
- **自动消息**：后台 Bash 通知等自动消息不入队，避免 Spin 结束后被消费循环当成下一轮
  LLM 输入。
- **子代理 Reply**：只落 `silent` 上下文并经 `emit_reply_delivered` 交给 SpinLoop 做节点
  验收判定，不进入 `agent_messages`。
- **只响应一次**：同一子代理的首条 Reply 被消费后，后续重复 Reply 直接忽略（不落盘、
  不触发投递事件、不静默中止）。
- **迟到 Reply**：SpinLoop 起的子代理登记在会话上；其 Reply 即使到达时 SpinLoop 已
  结束（spin 单向，`work_mode` 保持 `Spin`），仍按 spin 语义处理，只落 `silent` 上下文，
  不拉起父对话的 LLM 轮次。

## 3. 行为规格

### 3.1 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 用户消息 | webview 发出的、代表用户输入的消息 | webview |
| 会话引擎 | Core 进程内该会话的消费循环与状态（`engine.rs`） | Core |
| 待处理队列 | 引擎持有的待消费消息（用户消息 / reminder / agent 回复） | Core |
| 轮次边界 | 消费循环中「上一轮 query 已结束、下一轮 query 未开始」的时刻 | Core |
| 命令消息 | 去除首尾空白后以 `/` 开头的用户消息 | Core `commands.rs` 的 `dispatch` |
| `@` 命令 | 去除首尾空白后以 `@` 开头的用户消息 | Core `engine.rs` 的 `resolve_pending_mention` |
| 内置命令 | 命令注册表中按名称 / 别名匹配的命令（如 `/spin`） | Core `commands.rs` |
| Skill 命令 | 匹配 Skill 名称 / 别名的命令消息 | Core `skills.rs`（宿主侧补全用 `src/shared/skills/` 的加载器读同一份技能目录） |
| 排队项 | webview 中表示「已提交、尚未进入上下文」的 UI 状态 | webview |
| 工作目录 | 会话归属的目录，`project_root(sessionId)` 的返回值 | Core `config.rs` |

命令消息的归属由**引擎**判定；webview 不区分普通消息与命令消息。

### 3.2 契约一致性

| 项 | 规格 |
| --- | --- |
| 用户消息类型 | 用户消息在协议中只有一个类型（`sendMessage`） |
| 环境查询请求 | webview → host 的请求类型（`requestSkills` / `requestSessionRuntimeStates`）按同一约定声明 |
| 会话运行时状态推送 | `pushSessionRuntimeStates` 是模块内实现细节；对外入口是消息分发表 |
| 活动指示动效 | 运行中 = 蓝色流水（渐变背景滚动）；等待用户 = 黄色呼吸（明暗脉动，不滚动）。webview 对话列表与 Electron 标题栏用同一套语义；等待用户态以单一动画表达。未读完成（Electron：用户看不到时完成的任务）= 绿色呼吸一次后常亮，直到该对话被打开；回窗聚焦时正被看着的对话视为已读、不挂灯（状态机见 [docs/hosts/host-matrix.md](../hosts/host-matrix.md)「未读完成呼吸」） |

### 3.3 不变量

- 用户消息只有一个处理路径：会话引擎的待处理队列。
- 入口不解析命令；命令解析只发生在引擎消费循环的轮次边界。
- 一条命令消息最多被解析一次。
- 内置命令不进入 LLM 上下文，不产生用户气泡。
- Skill 注入的上下文顺序唯一：用户消息在前，`tool_use` / `tool_result` 在后。
- 排队项在消息进入上下文、被就地执行、被用户撤回（编辑 / 删除）、或会话关闭时被清除。
- 排队项以消息 `uuid` 关联，不以文本内容关联。
- 未被消费的排队项在 `queryEnd` 时回投。
- 系统环境信息缓存按工作目录分桶；预热刷新该目录条目。
- 补全只改写 `/` 到光标之间的文本。
- 运行中与等待用户两种活动指示的动效语义不同。
- 空闲挂起项是 webview 本地状态：不上送宿主，触发与回收都以 core 推送的快照为准。
- spin 模式父对话没有 LLM 消费循环：用户消息 / 自动消息不入队，子代理 Reply 只作结果
  更新与验收判定。
- 同一 spin 子代理的 Reply 只响应一次；重复 / 迟到 Reply 忽略。

## 4. 边界与错误路径

- **引擎不存在**：发送用户消息时建立引擎，消息进入队列（AC-1），不经过第二条路径。
- **无工作目录**：会话未登记工作目录时不进入管线，webview 显示引导、不发送消息。
- **撤回竞态**：已被消费 / 被更新的排队消息替换时，`discardQueuedMessage` 按 `uuid`
  不匹配而保持不动（AC-10）。
- **回投兜底**：入队失败 / 引擎缺失导致的未消费排队项由 `queryEnd` 回投兜底（FR-003）。
- **spin 期间输入**：Core 直接丢弃用户消息（UI 已禁用输入框），不报错、不入队。
- **迟到 Reply**：SpinLoop 结束后到达的 spin 子代理 Reply 只落 `silent` 上下文，不拉起 LLM。
- **provider 为空**：模型身份不合法时记录日志并忽略（[events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向)的 `modelChanged` 口径）。

## 5. 非目标

- 协议层不引入 `queueMessage` 独立类型（排队是状态，不是消息类型）。
- 输入框与排队项的视觉样式不在本规格内（动效语义见 3.2 契约一致性）。

## 6. 对需求基线的影响

关联既有 [user-stories.md](user-stories.md) 的 US-1（发送消息并获得流式回复）/
US-3（消息排队）/ US-5（输入历史与斜杠命令补全）/ US-27（斜杠命令与技能触发）/
US-39（Spin 设计器：spin 期间禁止用户输入与父对话不跑 LLM）；
新增 US-46（空闲发送与发送模式，e2e 见 `e2e/webview/sendModes.spec.ts`）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/host/ui/webviewMessageHandler.ts` 的用户消息处理器（`handleUserMessage`）→ `Core::on_user_message` | `core-rs/src/engine_tests.rs`（用户消息入队与消费） | 自动 |
| FR-002 | `core-rs/src/engine.rs` 的 `run_consumer`（轮次边界的命令解析）+ `core-rs/src/commands.rs` 的 `dispatch` | `core-rs/src/commands_tests.rs`（`non_slash_text_passes_through` 等解析用例）；`core-rs/src/engine_tests.rs` 的 `slash_builtin_command_is_handled_without_an_llm_round` | 自动 |
| FR-003 | 排队链路：`src/host/ui/webviewMessageHandler.ts` 的 `queuedMessage` 回推、`src/host/WebViewUI.ts` 的 `onCommandSend` / `onQueuedMessage`、`src/webview/hooks/useAppHandlers.ts` 的撤回（共用 `restoreQueuedMessage.ts`）→ `core-rs/src/engine.rs` 的 `on_queued_message_discarded`；空闲挂起（webview 本地）：`useAppHandlers` 的挂起 / 触发 / 中止回填 | `core-rs/src/engine_tests.rs` 的 `queued_message_is_discarded_by_uuid` / `queued_message_is_flushed_before_the_next_llm_round`；e2e `e2e/webview/sendModes.spec.ts`（US-46） | 自动 |
| FR-004 | `core-rs/src/engine.rs` 的 `inject_skill_tool_use` | `core-rs/src/engine_tests.rs` 的 `slash_skill_command_injects_the_skill_tool_use` | 自动 |
| FR-005 | `core-rs/src/prompt.rs` 的系统环境缓存（`GIT_CACHE` 等，按 `cwd` 分桶） | `core-rs/src/prompt_tests.rs`（环境信息组装用例） | 自动 |
| FR-006 | `src/webview/InputArea.tsx` 的 `handleInputChange` / `commitSlash` | 无自动覆盖 + webview 输入交互，现有测试车道未覆盖，AC-15 / AC-16 由人工场景验证 | 无自动覆盖 + 现有车道未建输入框补全用例 |
| FR-007 | `core-rs/src/engine.rs` 的 `on_user_message`（spin 丢弃）、`enqueue_agent_message`（spin 不入队）、`deliver_agent_reply` + `register_spin_sub_agent`（Reply 只响应一次 / 迟到 Reply 按 spin 语义处理）；`core-rs/src/spin_host.rs` 的 `CoreSpinHost::run_sub_agent` 登记 spin 子代理、`run_spin_command` 进入 spin 时清队列 | `core-rs/src/engine_tests.rs` 的 `user_message_is_dropped_while_spin_mode` / `spin_reply_is_consumed_once_and_late_replies_are_ignored` / `late_first_reply_from_spin_sub_agent_stays_silent`；`core-rs/src/spin_host_tests.rs` 的 `spin_run_feeds_replies_to_the_loop_not_the_main_llm`（含 Spin 结束后的重复 Reply）/ `entering_spin_clears_queued_auto_messages_and_reminders` | 自动 |

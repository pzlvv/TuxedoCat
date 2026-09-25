# 规格：用户消息管线

本规格描述用户消息从 webview 输入到进入 LLM 上下文的完整管线：入口唯一、命令在轮次边界
解析、排队状态与消息归属一致、Skill 注入顺序唯一、系统环境信息按工作目录缓存、斜杠补全的
替换边界由光标定义。

参考 `DEVELOPMENT.md` 第 4.3 节（UiEvent）、第 5.4 节（ConversationManager）、第 7.3 节
（WebviewMessageHandler）、第 7.4 节（WebViewUiPort）、第 10.3 节（`queryBegin` / `queryEnd`
去重）、第 12.1 节（不过度 fallback）、第 12.7 节（一份事实只有一个写入点）。

---

## 1. 能力

1. **唯一入口**：webview 的用户消息只有一个处理路径——会话引擎的待处理队列。
2. **命令在轮次边界解析**：内置命令就地执行、Skill 注入、普通消息进入上下文，三种结果都由
   引擎的消息消费循环在轮次边界决定。
3. **排队状态与消息归属一致**：消息进入 LLM 上下文或被就地执行时，对应排队项被清除；
   未被消费的排队项在查询结束时回投。
4. **顺序唯一**：Skill 命令的上下文顺序与普通消息一致——用户消息在前，Skill
   `tool_use` / `tool_result` 在后；首条消息与后续消息同序。
5. **系统环境信息按工作目录缓存**：缓存键是工作目录；预热刷新该目录的条目，读取命中同目录条目。
6. **斜杠补全**：命令名区间与替换边界由 `/` 与光标定义。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 用户消息 | webview 发出的、代表用户输入的消息 | webview |
| 会话引擎 | 会话的 `QueryEngine` 单例 | core |
| 待处理队列 | 引擎持有的待消费消息（用户消息 / reminder / agent 回复） | core |
| 轮次边界 | 消费循环中「上一轮 query 已结束、下一轮 query 未开始」的时刻 | core |
| 命令消息 | 去除首尾空白后以 `/` 开头的用户消息 | core `CommandDispatcher` |
| 内置命令 | 命令注册表中按名称 / 别名匹配的命令（如 `/spin`） | core `builtinCommands` |
| Skill 命令 | 匹配 Skill 名称 / 别名的命令消息 | core `bundledSkills` / `loadSkillsDir` |
| 排队项 | webview 中表示「已提交、尚未进入上下文」的 UI 状态 | webview |
| 工作目录 | 会话归属的目录，`getProjectRoot(sessionId)` 的返回值 | core `history/Config` |

命令消息的归属由**引擎**判定；webview 不区分普通消息与命令消息。

---

## 3. 消息入口

### 3.1 唯一入口

webview 的用户消息经宿主 `WebviewMessageHandler` 的一个处理器进入管线。该处理器是用户消息的
唯一处理路径。

- 协议中用户消息的类型是 `sendMessage`；`queueMessage` 不作为独立类型存在。
- 处理器不区分「新消息」与「排队消息」：是否排队由引擎的忙碌状态决定，不由消息类型决定。

### 3.2 入队前的登记

处理器在入队前完成与会话状态无关的登记：

| 步骤 | 内容 |
| --- | --- |
| 取引擎 | `getSessionEngine(sessionId)`；不存在时以 `Integration.createEngine(sessionId, '')` 建立（幂等） |
| 会话覆盖 | `agentMode` / `thinkingMode` / `webSearch` / `promptMode` / 模型身份（provider + model） |
| 活动计时 | `noteSessionActivity(sessionId)`（空闲回收只在 VS Code 生效，见 `DEVELOPMENT.md` 第 5.4 节） |
| 消息对象 | 内容块（文本 + 图片）、`uuid`、文件信息、图片宽高、`_userInitiated` |
| 入队 | `engine.submitMessage(content, 'user', { manageQueryUI: true, userMsgData })` |

- 引擎创建不预置用户消息：`initialMessages` 为空，首条消息与后续消息同路径。
- 查询开始 / 结束状态由引擎在消费循环中发出（`manageQueryUI: true`，见 `DEVELOPMENT.md`
  第 10.3 节）。
- 无工作目录的会话不进入管线：webview 显示引导，不发送消息。

### 3.3 入口不做的事

入口不解析命令、不注入 Skill、不执行内置命令、不把消息直接写入 LLM 上下文。这些语义只在引擎的
消费循环内决定。

因此不存在「调用方已解析、消费方再解析」的重复解析，也不需要表达「调用方已解析」的标记。

---

## 4. 引擎消费循环

### 4.1 轮次边界

消费循环在每轮 query 开始前，对队首的用户消息做一次命令解析。解析发生在轮次边界：

- 上一轮 query（可能包含多步工具调用）结束之后；
- 本轮 query 开始之前。

查询进行中不解析队首命令：多步工具调用中途到达的命令消息停留在待处理队列，直到该轮 query 结束。

### 4.2 命令解析结果

| 结果 | 判定 | 消息去向 | 本轮 LLM |
| --- | --- | --- | --- |
| 内置命令 | 匹配内置命令名 / 别名 | 就地执行，不进入 LLM 上下文 | 不运行 |
| Skill 命令 | 匹配 Skill 名 / 别名 | 进入 LLM 上下文 | 运行 |
| 其它 | 未匹配任何命令 / Skill | 进入 LLM 上下文 | 运行 |

- 命令名与参数的分割口径：第一个空白之前是命令名，其余（含换行）是参数。
- 命令消息只解析一次：解析结果就地消费该消息（内置命令）或标记待注入（Skill）。

### 4.3 Skill 注入

Skill 命令的注入内容是一条 assistant `tool_use`（`name: 'Skill'`）与对应的 `tool_result`
（携带技能正文）。

上下文顺序固定为：

```
[..., 用户消息, assistant(tool_use: Skill), tool_result]
```

首条消息与后续消息共用同一段注入逻辑，顺序一致。

### 4.4 消息顺序

用户消息在消费时追加到上下文末尾。Skill 的 `tool_use` / `tool_result` 紧跟在用户消息之后。

---

## 5. 排队状态的 UI 契约

### 5.1 登记

引擎处于忙碌（消费循环运行中或压缩中）时，宿主向 webview 回推 `queuedMessage`，webview 按会话
登记排队项。排队项携带该用户消息的 `uuid`。

### 5.2 清除

| 时机 | 发出方 | 消息 |
| --- | --- | --- |
| 消息进入 LLM 上下文（补发用户气泡） | 引擎消费循环 | `addMessage`（role = user，含 `uuid`） |
| 内置命令就地执行 | 宿主（`commandDispatched`） | `clearQueuedMessage` |
| 会话关闭 / 释放 | 宿主 | `clearQueuedMessage` |

内置命令不进入上下文、不产生用户气泡，其排队项由 `commandDispatched` 显式清除。清除按排队项的
`uuid` 匹配，不按文本内容匹配。

### 5.3 兜底回投

`queryEnd` 到达时，webview 对仍登记的排队项做一次回投：

- 用户主动中止的会话：回填输入框，等待用户确认；
- 其它：作为 `sendMessage` 重新提交。

已消费 / 已执行的消息在 `queryEnd` 之前清除了排队项，因此回投只作用于真正未被消费的消息
（入队失败 / 引擎缺失）。

### 5.4 顺序

同一会话内，`queuedMessage` 先于该消息的 `addMessage` / `clearQueuedMessage` 到达。

---

## 6. 系统环境信息（按工作目录缓存）

系统环境信息（git 信息、技能清单、可用命令）是 system prompt 的输入，按工作目录区分。

| 操作 | 语义 |
| --- | --- |
| `getSystemDynamicInfo(cwd)` | 命中 `cwd` 的缓存条目则返回；未命中则计算并写入 |
| `warmupSystemDynamicInfo(cwd)` | 重新计算 `cwd` 的条目并覆盖（刷新语义） |

- 缓存键是工作目录；不同目录的条目互不命中。
- 条目数量有上限；超出时淘汰最早写入的条目。
- 预热是刷新：切回一个已打开过的工作目录时，该目录的 git 信息与技能清单重新计算。
- git 信息依赖 `cwd`；命中缓存时不重复执行 git 命令。

---

## 7. 斜杠补全（webview）

### 7.1 命令名区间与查询词

输入以 `/` 开头时：

- 命令名区间 = `/` 之后到第一个空白（空格 / 制表 / 换行）之前，或到输入末尾；
- 光标位于命令名区间内（含区间起点）时展示补全菜单；
- 查询词 = 命令名区间内、光标之前的文本；菜单按查询词过滤。

只看「输入里有没有空白」不足以判断用户是否在输入命令名：输入框已有正文时，正文里的空白属于
正文。

### 7.2 选中替换

选中补全项时：

- 替换范围 = `/` 到光标之间的文本；
- 插入文本 = `/${skillName} `；
- 光标之后的原文保持不变；
- 选中后光标置于输入末尾。

替换边界由光标定义：「在已有正文前补 `/` 再选补全」的输入保留正文；光标位于命令名中间时，
区间内光标之后的字符保持不变，由用户继续编辑。

---

## 8. 契约一致性

| 项 | 规格 |
| --- | --- |
| 用户消息类型 | 用户消息在协议中只有一个类型（`sendMessage`） |
| 环境查询请求 | webview → host 的请求类型（`requestSkills` / `requestSessionRuntimeStates`）按同一约定声明 |
| 会话运行时状态推送 | `pushSessionRuntimeStates` 是模块内实现细节；对外入口是消息分发表 |
| 活动指示动效 | 运行中 = 蓝色流水（渐变背景滚动）；等待用户 = 黄色呼吸（明暗脉动，不滚动）。webview 对话列表与 Electron 标题栏用同一套语义；等待用户态以单一动画表达 |

---

## 9. 不变量

- 用户消息只有一个处理路径：会话引擎的待处理队列。
- 入口不解析命令；命令解析只发生在引擎消费循环的轮次边界。
- 一条命令消息最多被解析一次。
- 内置命令不进入 LLM 上下文，不产生用户气泡。
- Skill 注入的上下文顺序唯一：用户消息在前，`tool_use` / `tool_result` 在后。
- 排队项在消息进入上下文、被就地执行、或会话关闭时被清除。
- 排队项以消息 `uuid` 关联，不以文本内容关联。
- 未被消费的排队项在 `queryEnd` 时回投。
- 系统环境信息缓存按工作目录分桶；预热刷新该目录条目。
- 补全只改写 `/` 到光标之间的文本。
- 运行中与等待用户两种活动指示的动效语义不同。

---

## 10. 验收要点

1. 引擎不存在时发送用户消息：引擎被建立，消息进入队列，不经过第二条处理路径。
2. 首条消息是 Skill 命令时，上下文顺序为 `[用户消息, tool_use(Skill), tool_result]`。
3. 后续消息是 Skill 命令时，上下文顺序与首条一致。
4. 查询进行中发送内置命令：命令在该轮 query 结束后执行一次；查询进行中不执行、不注入。
5. 查询进行中发送内置命令：排队项在执行后被清除，`queryEnd` 不重复投递。
6. 查询进行中发送 Skill 命令：消息进入上下文时补发用户气泡，排队项被清除。
7. 连续两次发送相同文本的消息：各自的排队项按 `uuid` 独立清除。
8. 用户中止查询时，未消费的排队项回填输入框。
9. 引擎空闲时发送普通消息：立即回显，不产生排队项。
10. 切换工作目录后切回：该目录的 git 信息与技能清单重新计算。
11. 两个工作目录的会话各自拿到自己目录的系统环境信息。
12. 在已有正文前补 `/` 后选补全：正文保留，结果为 `/${skillName} 正文`。
13. 输入不以 `/` 开头时不展示补全菜单。
14. `requestSessionRuntimeStates` 的回包只投递给请求方视图。

---

## 11. 落点对照

| 规格项 | 现有落点 |
| --- | --- |
| 唯一入口 | `src/host/ui/webviewMessageHandler.ts` 的用户消息处理器 |
| 引擎获取 / 创建 | `src/core/Integration.ts` 的 `createEngine`；`src/core/QueryEngine.ts` 的 `getSessionEngine` |
| 入队 | `src/core/QueryEngine.ts` 的 `submitMessage` |
| 轮次边界 / 命令解析 | `src/core/QueryEngine.ts` 的 `messageConsumer` / `resolvePendingCommand` |
| 命令匹配 | `src/core/CommandDispatcher.ts` 的 `dispatch` |
| Skill 注入 | `src/core/QueryEngine.ts` 的 `injectSkillToolUse` |
| 排队项登记 / 清除 | `src/host/ui/webviewMessageHandler.ts` 的 `queuedMessage` 回推；`src/host/WebViewUI.ts` 的 `onCommandSend` / `onQueuedMessage`；`src/webview/hooks/useMessageHandler.ts` 的 `addMessage` / `queryEnd` 分支 |
| 系统环境信息缓存 | `src/core/prompt/SystemEnvironment.ts` 的 `getSystemDynamicInfo` / `warmupSystemDynamicInfo` |
| 斜杠补全 | `src/webview/InputArea.tsx` 的 `handleInputChange` / `commitSlash` |
| 活动指示动效 | `src/webview/styles/index.css` 的 `.running-bar` / `.running-bar--waiting`；`electron/titlebar/styles.css` 的 `.ws-tab-activity` |
| 消息类型 | `src/core/webviewTypes.ts` 的 `WebviewMessage` |
| 环境查询分发 | `src/host/ui/webviewMessageHandler.ts` 的 `requestSessionRuntimeStates` / `pushSessionRuntimeStates` |

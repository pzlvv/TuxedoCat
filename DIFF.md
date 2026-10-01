# DIFF：Standalone Core（Rust）与 Embedded Core（TS）的差异清单

本清单只记录**有意保留**的差异：Embedded（`src/core`，TypeScript）是唯一真值，
Standalone（`core-rs`）逐项对齐；无法对齐的只有两类——

1. **原 TS 实现有 bug**：按 TS 复刻会重现缺陷，Rust 保留正确行为；
2. **Rust 实现更健壮**：TS 的行为在边界条件下会丢数据 / 挂死 / 产生非法输出。

除本清单与 `TODO.md`「已知缺口」列出的未迁入能力外，其余行为均由两侧共用的
对照表（`src/test/fixtures/*.json`）逐字锁定，任一侧偏离即测试失败。

---

## 1. TS 实现有 bug（Rust 不复刻）

### 1.1 Grep `content` 模式的相对路径（Windows 盘符）

| | 行为 |
| --- | --- |
| Embedded | `Grep.ts` 用 `line.indexOf(':')` 截出「文件路径」，再交给 `path.relative(searchPath, filePath)`。Windows 上 rg 输出的是绝对路径 `C:\dir\a.txt:1:match`，第一个 `:` 落在**盘符后**，于是 `filePath === 'C'`；`path.relative` 把 `C` 当相对路径再解析，产出 `D:\<进程cwd>\C:\dir\a.txt:1:match` 这类错乱路径（搜索目录与进程 cwd 不同盘时尤其明显）。 |
| Standalone | `tools.rs::strip_search_root` 直接剥掉搜索根前缀，得到正确的相对路径；`count` / `files_with_matches` 两种模式 TS 用 `lastIndexOf(':')` / 完整路径，本来就没有这个问题，Rust 与之一致。 |

复现（Windows，`npm run compile-tests` 后）：

```
node -e "…GrepTool.call({pattern:'alpha',output_mode:'content'}, {cwd: <temp dir>})"
# Embedded 输出：D:\git\TuxedoCat\C:\Users\...\Temp\xxx\a.txt:1:alpha
# Standalone 输出：a.txt:1:alpha
```

因此 `content` 模式**不放进共用对照表**（放进去两侧必然不一致）。

### 1.2 Anthropic `baseURL` 已带 `/v1` 时的重复拼接

| | 行为 |
| --- | --- |
| Embedded | `RealApi.ts` 直接 `${baseURL}/v1/messages`。用户把 `baseURL` 配成 `https://gw.example/anthropic/v1` 时会请求 `/v1/v1/messages`，必然 404。 |
| Standalone | `llm.rs::messages_url` 去掉尾部 `/`，且 `baseURL` 已以 `/v1` 结尾时不再重复拼（与 OpenAI 的 `joinV1Path` 口径统一）。 |

### 1.3 Edit 的 `replace_all` 工具 schema

| | 行为 |
| --- | --- |
| Embedded | `Edit/Types.ts` 声明 `z.union([z.boolean(), z.string().transform(...)]).optional().default(false)`；`zodToJsonSchema` 把它渲染成 `{ type: 'string' }` 且列入 `required`。发给模型的 schema 因此是「必填字符串」，与运行时实际接受的 boolean 不一致。 |
| Standalone | `tools.rs` 的 Edit `input_schema` 按 zod 的真实语义渲染为 `boolean` + 非必填。运行时两侧都能接受 `true` / `false` / `"true"` / `"false"`（对照表 `toolInputValidation` / `permissionPolicyParity` 的 `edit-replace-all-*` 用例）。 |

差异已登记在 `src/test/fixtures/toolSchemaParity.json` 的 `divergences` 中。

### 1.4 会话标题截断可能切开代理对

| | 行为 |
| --- | --- |
| Embedded | `buildConversationTitle` 用 `trimmedText.substring(0, 50)`（按 UTF-16 code unit）。标题第 50 个 code unit 正好是 emoji 的高位代理项时，会产出**孤立代理项**；`JSON.stringify` 写进 `meta.json` 后是 `"\ude00"`（语法合法、语义非法），宿主 / Core 的严格解析器读到会整行丢弃。 |
| Standalone | `history.rs::derive_title` 用 `util::utf16_take`（按代理对边界对齐）截断，最多 50 个 code unit 且不留孤立代理项。 |

### 1.5 标题推导跳过 `isMeta` 消息

| | 行为 |
| --- | --- |
| Embedded | `titleFromUserMessage` 不检查 `isMeta`：若会话第一条落盘消息是被注入的 meta 用户消息（`SkillTool` 注入的 prompt），会拿它当标题。 |
| Standalone | `history.rs::derive_title` 跳过 `isMeta === true`，只用真实用户消息起标题；取不到时兜底 `New Conversation`。 |

当前 `isMeta` 只由 `SkillTool` 产生，而 Skill 尚未迁入 Standalone（见 `TODO.md`
已知缺口），因此这条差异目前不可达；迁入 Skill 时按本条保留 Rust 行为。

### 1.6 SheetJS 读 `t="d"`（ISO 8601 日期）单元格的系统性偏移

| | 行为 |
| --- | --- |
| Embedded | `xlsx` npm 包把 `t="d"` 单元格的 ISO 字符串转成 Excel 序列号时带约 43 秒的固定偏移：`2024-01-02T00:00:00` → `45293.000497685185`（反解 `00:00:43`）；带 `Z` 的 `2024-01-02T00:00:00Z` 还会再叠一次本地时区（`45293.33383101852` → `08:00:43Z`）。Excel 自身不产出 `t="d"` 单元格，这是 SheetJS 的解析缺陷。 |
| Standalone | `tools.rs::xlsx_cell_value` 对 `calamine::Data::DateTimeIso` / `DurationIso` 原样输出单元格里的 ISO 文本，不复制该偏移（用例 `tools_tests.rs::read_xlsx_keeps_iso_dates_as_text`）。 |

---

## 2. Rust 更健壮（有意保留）

### 2.1 Anthropic 流内 `signature_delta` / `error`

| | 行为 |
| --- | --- |
| Embedded | `RealApi.ts` 不处理 `signature_delta`（thinking block 的 signature 只取 `content_block_start` 初值），SSE `error` 帧被静默忽略。Anthropic 扩展思考要求历史 thinking block 携带 signature；静默吞掉流错误会产出空回复。 |
| Standalone | `llm.rs` 把 `signature_delta` 累积进 thinking block 的 `signature`，并把 `error` 帧当流错误上报。 |

### 2.2 Edit 权限预览不下发 `diffHunks`

| | 行为 |
| --- | --- |
| Embedded | `PermissionPolicy` 预计算紧凑的 `displayArgs.diffHunks`（`utils/editDiff.ts::buildEditDiffHunks`）。 |
| Standalone | 不下发该键，改为额外下发 `beforeContent` / `afterContent`；webview 用同一份 `buildEditDiffHunks`（同一算法、同一入参）在 `EditFile.tsx` 回退计算，渲染结果一致。代价是这一帧体积更大（整份内容 vs 紧凑 hunks）。`permResult` 与 tool_use `_meta` 的 diff 字段已与 Embedded 对齐。 |

对照表 `permissionPolicyParity.json` 比对前统一剔除 `diffHunks`。

### 2.3 文件名 / 内部 id 形态

工具结果持久化文件名、消息 uuid 等内部 id 的**生成算法**两侧不同（TS 用
`Date.now()+Math.random()`，Rust 用时间戳+进程内计数器），但格式契约一致
（`<sessionId>__<taskId>.txt`、`sessionId_timestamp_rand`），落盘后互相可读。
这类 id 从不参与对照表比对。

### 2.4 `sessionRuntimeChanged` 快照包含全部已登记会话

| | 行为 |
| --- | --- |
| Embedded | `sessionRuntime` **惰性登记**：只有调用过 `markQueryRunning` / `markSessionWaiting` 等 `update()` 的会话才进入快照（`pushIfChanged` 只遍历内部事实表）。刚打开、还没跑过查询的会话不会出现在 `states` 里。 |
| Standalone | 只要会话被登记（`conversationStarted` / `conversationOpened` / `ensure_loaded` / 收到用户消息）就进入快照，`idle: true`。 |

原因：Rust 没有 Embedded「创建 QueryEngine」这个钩子可作为「会话已登记」的确定信号；
Standalone 宿主需要一条握手级事件确认会话已建立（`standaloneCoreEngine.test.ts`
也以该事件为同步点）。对宿主而言，多一条 `idle: true` 条目与「未知会话按空闲处理」
等价，不改变流水灯 / 托盘的实际显示。`sessionRuntimeChanged` 的 diff、插入序与
「无变化不发」口径与 Embedded 一致（`eventGranularityParity.test.ts` ↔
`engine_tests.rs::emit_runtime_is_silent_when_nothing_changed` /
`session_runtime_states_follow_insertion_order`）。

### 2.5 同一轮内 assistant content block 的顺序

| | 行为 |
| --- | --- |
| Embedded | `RealApi` / `OpenAiApi` 按流内 block 出现顺序保留 `contentBlocks`；同一轮里 text 与 tool_use 交错时会产生多个 text 段（如 `[text(A), tool_use, text(B)]`）。 |
| Standalone | `build_assistant_message` 按类型分组：thinking → text → tool_use，同类型的多个段合并成一个 block（如 `[text(AB), tool_use]`）。 |

正常形态（thinking → text → tool_use、多个连续 tool_use）两侧逐字一致；
只有「text 与 tool_use 交错」这种少见形态下 block 粒度与顺序不同，**文本内容不丢**。
两份实现里 assistant 消息的 tool_use / tool_result 配对不受影响（配对看 id 与
下一条 user 消息，不看 block 在 content 数组里的位置）。

### 2.6 压缩归档的容错读取

| | 行为 |
| --- | --- |
| Embedded | `loadCompactArchive` 用 `content.split('\n').filter(Boolean)`，随后逐行 `JSON.parse`；任意一行损坏都会让整个函数抛错、`catch` 后返回 `null`（等价于「没有归档」）。 |
| Standalone | `history::load_compact_archive` 逐行解析、**跳过**损坏行（`filter_map`），返回能读到的消息。 |

归档由 Core 自己写入，正常路径下不会出现坏行；差异只在文件被手工改坏 / 写到一半
崩溃时体现。Rust 保留可读部分，属于有意保留的更稳健行为。

### 2.7 SSE `data: [DONE]` 的处理

| | 行为 |
| --- | --- |
| Embedded | `parseSSELines` 遇到 `[DONE]` 只是 `continue`，随后继续读响应体直到服务端关闭连接；若服务端在 `[DONE]` 后保持连接不关，请求要等看门狗超时才结束（被当成错误重试）。 |
| Standalone | `llm::read_sse` 收到 `[DONE]` 立即结束读取并返回成功。 |

`[DONE]` 按协议就是最后一个事件，Rust 的提前收尾不丢任何内容，属于有意保留的
更稳健行为。

### 2.8 pandoc 转换失败的报错文案

| | 行为 |
| --- | --- |
| Embedded | `Read.ts::convertDocToMd` 抛 `Failed to convert document to markdown: ${error.message}`，其中 `error.message` 是 Node `execSync` 的整段文案（`Command failed: "<pandoc>" ...\n<stderr>`）。 |
| Standalone | 抛 `Failed to convert document to markdown: <trimmed stderr>`；没有 stderr 时退化为 `pandoc exited with <status>`。 |

Node 的 `error.message` 含完整命令行与 OS 级错误串，Rust 侧无法逐字复刻；这里保留
更干净的 stderr 文案。错误**前缀**（`Failed to convert document to markdown: `）
与「删掉半成品 md」的收尾两侧一致，只有冒号后的细节不同。

### 2.9 数字字符串的宽松解析

| | 行为 |
| --- | --- |
| Embedded | `parseInt` / `parseFloat`：接受数字前缀 + 任意后缀（`parseInt('5abc') === 5`），非数字返回 `NaN`。 |
| Standalone | `str::parse`：要求整串（允许首尾空白）都是合法数字，否则解析失败并走各自的兜底（Grep count 不计入、余额 `total_balance` 记 0、`HARNESS_MAX_OUTPUT_TOKENS` 视为未设置）。 |

输入分别是 ripgrep `-c` 的输出（恒为 `<path>:<数字>`）、DeepSeek 余额接口的
`total_balance`（恒为数字字符串）与环境变量，正常路径下不会出现「数字前缀 + 垃圾后缀」，
因此差异不可达。Rust 的严格解析属于有意保留的更稳健行为（不把坏输入当有效值）。

### 2.10 tool_result 内容数组里的 `null` 元素

| | 行为 |
| --- | --- |
| Embedded | `convertMessagesToResponsesInput` 对 tool_result 的 `content` 数组直接 `.map(toToolOutputPart)`；`toToolOutputPart(null)` 读 `block.type` 抛 `TypeError: Cannot read properties of null (reading 'type')`，整次转换失败。 |
| Standalone | `responses::to_tool_output_part` 对 `null` 元素按 `JSON.stringify(null ?? '')` 处理，产出 `""` 文本块，转换继续。 |

`tool_result.content` 由内置工具生成，恒为字符串或带 `type` 的块数组，正常路径下
不会出现 `null` 元素；Rust 不因单个坏元素让整轮请求失败，属于有意保留的更稳健行为。

---

## 3. 未迁入能力

MCP、Spin 引擎、智能命名 / 归档展开 / 余额推送、UI → core 请求通道、对话空间统计、
会话加载与技能列表都已迁入；剩余缺口（内置 Web Search、助手回复的超长落盘兜底等）
见 `TODO.md`「已知缺口（Standalone 下暂不可用）」，本清单只展开需要说明细节的那几条。

### 3.0 对话空间统计（`requestConversationSpaces`）

统计与清空都在 Core：宿主经 `UiRequest.conversationSpacesRequested` 取列表
（Embedded 走 `coreFacts` 的同进程分支，Standalone 走 Rust 的
`history::conversation_spaces`），清空走 `UiEvent.conversationSpaceCleared`。

有意保留的差异：会话数只数 `<sessionId>.meta.json`，空间清单 `workspace.meta.json`
不算会话（M12 改名后两侧同步修正）；排序按字节数降序，两侧同口径。

### 3.1 MCP

`mcp.rs` / `mcp_http.rs` / `mcp_config.rs` 对齐 `src/core/mcp/*`，对等面见第 4 节。
有意保留的差异：

- **旧版 SSE 的 `stop()` 不能立刻中断底层读**：TS 用 `AbortController` 立即 abort
  长连接；`reqwest::blocking` 没有对外中止句柄，`stop()` 只置停止标记，读线程在
  服务器关闭连接或下一个事件到达时退出。Streamable HTTP 每请求独立超时，不受影响。
- **MCP 工具的执行失败前缀**：Embedded 的 `RunTools` 对任意 `call()` 抛错都写
  `Error executing <name>: <msg>`；Rust 侧 `tools::is_known` 原本不含 `mcp__*`，
  已通过 `engine::is_known_tool` 把 MCP 工具算作「已注册」从而加上同一前缀
  （工具**不存在**与**执行失败**两条错误通道的区分口径保持一致）。
- **prompt 缓存失效是空实现**：Standalone 引擎每轮重新组装 system prompt / 工具
  列表，没有 Embedded `invalidateAllPromptCaches` 的对应物，调用点保留但为空。

### 3.2 Spin

- `enqueueSpinWrite` 用进程级 `Mutex` 而不是 Promise 串行链：对「读-改-写」的互斥
  等价；并发写入的先后在两边本来都不确定。
- `SpinNode.id` 用 `i64`（TS 的 `number` 允许非整数）；真实 id 都是整数，非整数
  只在排序 / `meta` 键上退化。
- `write_spin_json` 未设 Unix `0o600` 权限（TS 有）；Windows 下无差异。
- **验收判定用会话实际生效的模型**：Embedded 的 `callLLM` 不传 `modelConfig`，
  因此判定始终走全局 active provider；Rust 侧 `SpinHost::judge` 优先用父会话的
  模型 / provider（取不到才回落全局）。这是有意保留的更一致行为——用户切了会话
  模型后，判定用的模型与执行用的模型应当一致。
- `/spin` 的执行在**当前线程**跑完整个循环（对齐 TS `await spinLoop(...)` 阻塞
  `resolvePendingCommand` 的语义）：消费循环因此不排空队列、用户后续消息排队等待、
  `queryEnd` 在 Spin 结束后才发出。

### 3.3 落盘时机：Embedded 异步 vs Rust 同步

Embedded 的 `QueryEngine` 用 `startPersist(persistUnpersistedMessages())`
**fire-and-forget** 落盘（不 await），查询循环立刻继续；Rust 在调 LLM **之前**
同步落盘。因此「落盘驱动的 CoreEvent」（`conversationListChanged`、
`projectConversationDirReady`）在整条事件流里的**插入位置**不同：

```
embedded  = queryBegin, sessionConfigChanged, aiBegin, projectConversationDirReady,
            streamMessage, streamEnd ×2, aiEnd, conversationListChanged ×2, queryEnd
standalone= queryBegin, sessionConfigChanged, projectConversationDirReady,
            conversationListChanged, aiBegin, streamMessage, streamEnd ×2,
            conversationListChanged, aiEnd, queryEnd
```

事件**集合**与查询生命周期的**相对顺序**完全一致（由
`src/test/coreEventParity.test.ts` 锁定）；只有落盘类事件与 LLM 事件的交错不同。
这是有意保留的：同步落盘让「崩溃现场」更可预测（消息在进 LLM 前一定已落盘），
代价是首字节延迟多一次磁盘写。此外 Rust 会多推一次
`sessionRuntimeChanged`（全量快照，幂等），因为「会话开始忙」的观察点比 Embedded
多一个。

### 3.4 模型注册表

模型注册表（`src/core/utils/modelConfig.ts` 的 `MODEL_CONFIGS`）归 UI：宿主按注册表
把 `modelLimits` 预解析进配置快照（`docs/core-ui-separation.md` 第 4 节），Core 只消费
`modelLimits` / `modelLimitsFallback`，两侧不存在需要各自维护的第二张表。Rust 侧没有
按模型名匹配的注册表，命中逻辑与快照逐项一致。

### 3.5 LLM 配置保存

`handleSaveLLMConfig` 的 mutation（provider 表重建 / `modelConfigs` 保留与补齐 /
顶层默认值 / MCP 默认启用列表）归宿主（`src/host/llmConfigSave.ts`，M9）：写盘后
`SettingsStore` 重新构造整份快照并推给所有 Connection，Core 不感知 `settings.json`
路径，也没有保存请求。两侧的差异只剩快照内容本身：字段名、默认值、白名单由
`settingsSnapshot.test.ts` 与 `coreEventParity.test.ts` 锁定。

### 3.6 i18n

Core 不再产出文案：提示类输出经 `CoreEvent.notice` 携带「键 + 参数 + 级别」，键表由
`coreTextParity` 对照锁定（M11）；系统语言探测归宿主（`src/host/i18n.ts`），Core
不感知语言，也没有 `systemLocaleRequested` 请求。Rust 侧只保留键与参数，不再有
`i18n.rs`。

### 3.7 MCP 默认列表重同步的触发点

两侧都在 `hostEnvironmentProvided` 应用完快照后比较 `mcp.enabled` 的差异，变化时重同步
所有已注册会话（Embedded：`initializeCoreEvents` → `getMcpManager().syncAllSessions()`；
Standalone：`settings::apply_from_host_environment` 返回 `mcp_defaults_changed` →
`mcp::sync_all_sessions()`）。宿主不再触发重同步：`getMCPHost().onSessionEnabledChanged()`
这条直接调用已删除（M15）。同步完成后 Core 广播 `sessionConfigChanged(mcpEnabled)`，
UI 据此经 `UiRequest.mcpServersRequested` 重读列表。

### 3.8 模型身份解析的归属

`meta.json` 里的 `model` / `provider` 是会话事实，落盘与引擎同步都归 Core：加载会话时
宿主把解析出的可用身份经 `UiEvent.modelChanged` 交给 Core（Core 写 meta.json + 同步
引擎配置），宿主不再直接调 `updateConversationContext` / `setSessionModel`（M15）。
宿主只做「按快照校验身份」这一步纯计算（`resolveModelRef`）。

### 3.9 就绪门禁在两种装配下的表现

- Embedded：总线在 `emitToCore` 时硬断言（快照未到达前收到其它 `UiEvent` 抛错），
  `coreReady` 只是诊断信号；
- Standalone：Core 同样在就绪前拒绝 `UiEvent`（记 log 并丢弃），Host 侧另有 Client
  门禁——Connection 未就绪时 `UiEvent` 排队、`requestCore` 挂起，收到 `coreReady`
  后按序冲刷。

两边的共同点：`coreReady` 是「Core 已应用配置快照」的判据，每次快照重推都会再发一次。

### 3.10 daemon 与重启责任

Standalone 下 Core 的启动、重启（退避 + 上限）与终止由 daemon 承担（`daemon.rs`）；
Host 侧只把 `channelReset` 翻译成「连接重置」（重新 `hello`、重放连接态事件与已打开
会话），把 `workspaceClosed(failed)` 翻译成 fatal。Embedded 没有进程，也就没有这一层。
`CoreProcess.ts` 保留为单进程形态的传输层实现（测试与回退路径），生产装配走
`CoreDaemon.ts`。

### 3.11 宿主侧 core 事实读取的例外

`coreFacts` 是宿主侧统一入口（Embedded 直读 / Standalone 走 `UiRequest`）。仍保留的
直接读取见 `DEVELOPMENT.md` 第 2 节规则 9 的审计结论：会话工作目录的宿主侧索引、
工具 `_meta` 的 before/after 写入。两者在 Standalone 下与本机 Core 共用同一份磁盘；
远程工作区落地时需要迁到 `UiRequest`（`docs/client-connection.md` 第 9 节把远程列为
不覆盖范围）。

### 3.12 额外接受的旧事件

Rust 的 `dispatch_ui_event` 额外接受 `workspaceChanged`（`UiEvent` 词汇表已无此事件）：
它是旧多工作目录模型的活动工作目录入口，现仅作为测试 / 兜底路径设置活动工作目录
（`conversationListRequested` 不带 `workspacePath` 时回退到它）。未知事件类型仍按契约
记录并丢弃。

### 3.13 会话加载的派生事实

`UiRequest.conversationLoadRequested` 一次返回消息、元数据与派生事实。两侧的差异只在
`pendingToolUseIds`：Embedded 返回进程内「仍在等待权限 / 执行」的工具调用 id；
Standalone 恒为空（Core 加载时已给缺失 `tool_result` 的 `tool_use` 补取消结果，不存在
需要 UI 恢复的待执行表）。`agentMode` 两侧都取 meta.json 的权威值，缺失为 `null`，
由宿主回退 `settings.json` 默认值。

AskUserQuestion 已迁入（定义 / schema / 权限直接放行 / `CoreRequest.userChoice`
往返 / 结果文案），对等面见第 4 节。

Read 的 doc/docx/ppt/pptx（pandoc 转 markdown）与 xlsx/xlsm（`calamine` 读取）
已迁入，`toolResultParity` 用提交入库的 `src/test/fixtures/xlsx/people.xlsx`
锁定 xlsx 输出；`Read` schema 的 `sheet` 缺口已消除。

后台 Bash 已迁入（`core-rs/src/bash_task.rs`）：`run_in_background`（file mode 输出
文件 + 完成通知）、前台超时自动转后台、通知驱动的转后台、完成通知经
`enqueue_bash_notification` 注入为 `origin='bash'` 的 user 消息、
`SessionState.background` 参与 `idle` 判定、会话中止 / 关闭时中止后台任务、
「仍有后台任务在跑」兜底提醒。`toolSchemaParity` 的 `Bash.run_in_background`
缺口已消除，端到端见 `standaloneCoreTools.test.ts`。

未迁入的子项（不构成对外缺口，逐条列在 `bash_task.rs` 模块头）：
`TaskOutput` 的 pipe mode（内存 buffer + 超限 spill）与进度轮询、5GB 磁盘看门狗；
自动转后台的说明文案不含「转后台前已累积的 stderr」（Rust 前台不增量留 stderr）。
`watchSleepNotifications` 的两半（后台任务完成 + 子代理 Reply）都已接线。

子代理已迁入（`core-rs/src/subagent.rs` + `tools::run_agent` / `run_reply` +
`engine::run_sub_agent`）：`Agent` 建 `sub_*` 子会话、写 `parentSessionId` / `role` 的
`meta.json`、后台跑消费循环并在没调用 `Reply` 时注入 Reminder（最多 3 次）；
`Reply` 把回复作为 `origin='agent'` 的 user 消息投回创建者会话（含 From 头），
`sessionRuntime.idle` 递归到子代理。`toolSchemaParity` / `systemPromptParity` /
`toolInputValidation` / `permissionPolicyParity` 四份对照表已覆盖这两个工具。

技能 / 斜杠命令已迁入（`core-rs/src/skills.rs` + `core-rs/src/commands.rs`）：
`frontmatterParser` / `variableResolver` / `loadSkillsDir` / `bundledSkills` 逐字对齐，
`CommandDispatcher` 的三段优先级（内置命令 → Skill 匹配 → passthrough）与参数切分正则一致，
命令在**出队时**解析（`engine::resolve_pending_command`，位于消费循环内、
`flush_queued_messages` 之外），内置命令就地执行并丢弃该消息，Skill 命中后由
`run_turn` 注入 Skill tool_use（`inject_skill_tool_use` ↔ `submitToolUse`）。
`Skill` 工具已进 `tools::definitions()` 末位（`assert_skill_tool_is_last` 守不变式），
技能清单注入系统提示的环境段。

对话压缩已迁入（`core-rs/src/compact.rs` + `core-rs/src/replay.rs`）：
阈值口径（保留浮点）、三道触发闸门、提示词与边界标记文案、`sanitizeToolPairing`、
`buildPostCompactMessages`、`buildReplayMessageData` 都逐字对齐；压缩就地替换消息数组、
整文件重写 jsonl、归档写到 `<sid>.compact_archive.jsonl`、`meta.json` 打
`isCompacted` / `isExpanded`，最后发一条 `messagesReplaced`。
触发点：自动压缩在 `run_query_loop` 里 `aiBegin` 之前；手动压缩经
`UiEvent.compactRequested` → `Core::request_compact`（非空闲时登记延后）。

Responses API 已迁入（`core-rs/src/responses.rs`）：URL / 工具 / 消息转换、status 映射、
usage 提取、本地输入估算、usage 可信度判定与 `response.output` 权威校准都逐字对齐；
SSE 事件循环覆盖文本 / 思考 / 工具调用 / 终止 / 失败与截断检测。

已知缺口（Responses）：内置 `web_search` 工具与搜索卡片事件
（`web_search_call` / `web_search_call_update` / `web_search_call_done`）尚未迁入——
本阶段不下发该工具，`webSearchUsed` 恒为 false，因此
`shouldSkipUsageForContext` 只剩「超过上下文窗口 60%」那道闸门。
另有两点与 Embedded 的取舍一致或更保守：
- 终止事件里 `response.output` 的权威校准在 Rust 侧以
  `LlmEvent::AuthoritativeBlocks` 表达，引擎据此整体替换本轮累积的
  text / thinking / tool_use。Embedded 保留块顺序，Rust 的引擎模型是
  「text / thinking / tool_uses」三段，因此同轮多 text 块会被拼接
  （同第 2.5 节的取舍）。
- 单条 assistant 回复超过 40K 字符时，Embedded 会把全文持久化到磁盘、消息里只留
  文件路径 + 预览；Standalone 暂未接这条兜底（助手回复侧的 `persistLargeOutput`
  等价物），超长文本会原样进上下文。

有意保留的差异（压缩）：
- 边界标记的 `content` 与 `compactMetadata` 里 `preCompactTokenCount` /
  `postCompactTokenCount` 恒为 0——Embedded 在移除本地估算后同样写 0，此处一致；
  但 `compactEnd.result.postCompactTokenCount` 取摘要请求的真实 `output_tokens`，
  Rust 侧同口径（摘要请求失败时为 0）。
- `messagesReplaced` 里的 Edit 工具卡片：Embedded 预计算 `diffHunks`，Standalone
  改发 `beforeContent` / `afterContent`（同第 2.2 节的取舍，由 webview 回退计算）。
- 压缩期间到达的消息：Embedded 由 `resumeAfterCompact` 在**压缩收尾**唤醒；
  Standalone 同样如此（`Core::resume_after_compact`），但 Standalone 的压缩可以
  跑在独立线程上，因此「压缩中」这个事实同时反映在 `SessionState.compacting`
  与 `sessionRuntimeChanged.compacting` 两处。

有意保留的差异（技能）：
- 内置 `spin` 命令只有 `design` 分支可用（UI 据此打开设计器）；`auto` / 其它分支依赖
  Spin 引擎，随 M6-198 接入，当前返回一条说明消息。
- 用户级技能目录统一走 `config::config_home()`（`USERPROFILE` 优先），与
  `settings.json` / `conversations/` 保持一致；Embedded 的 skills 走
  `process.env.HOME || process.env.USERPROFILE`（两者在真实宿主下通常同指一处）。
- `i18n` 只迁入 `tt` / locale 收敛 / `getSystemLocale` 的最小实现（`core-rs/src/i18n.rs`），
  尚无 `UiEvent` 把宿主 locale 交给 Core（随 M6-200 接入），因此默认英文；
  `getSystemLocale` 少了 Embedded 的 `Intl.DateTimeFormat()` 兜底（Rust 无等价 ICU 查询）。

有意保留的差异：Embedded 的 Reminder 重试在每次 `submitMessage` 后固定等待 1.5s 再复查
（`RETRY_DELAY_MS`）；Standalone 的 Reminder 走消费循环的队列，循环返回即代表该轮
（含 Reminder 触发的 LLM 调用与工具执行）彻底结束，因此不再需要那个等待窗口。

---

## 4. 已由对照表锁定的对等面

| 对照表 | Embedded 侧 | Standalone 侧 |
| --- | --- | --- |
| `permissionParity.json` | `resolveToolPermission` | `permission::decide` |
| `permissionFuzzParity.json` | `resolveToolPermission` | `permission::decide` |
| `permissionPolicyParity.json` | `resolveToolPermission` 的 `permResult` / `displayArgs` | `permission::resolve_tool_permission` |
| `toolSchemaParity.json` | 工具定义（zodToJsonSchema） | `tools::definitions` |
| `toolInputValidation.json` | `inputSchema.safeParse` | `tool_input::parse_input` |
| `toolInputRepairParity.json` | `fixToolInput` | `engine::fix_tool_input` |
| `toolResultParity.json` | 真实 `tool.call` + 结果映射 | `tools::execute` |
| `editResultParity.json` | `EditTool` | `tools::run_edit` |
| `binaryDetection.json` | `isbinaryfile` | `tools::is_binary_content` |
| `historyChainParity.json` | `loadConversation` | `history::load_messages` |
| `jsParity.json` | `formatFileSize` / `generateHeadTailPreview` / Bash `validateInput` | `tools::format_file_size` / `util::clamp_output` / `tools::validate_input` |
| `jsValueParity.json` | `parseDataUrl` / `String()` | `engine::split_data_url` / `util::js_string` |
| `chatCompletionParity.json` | `OpenAiApi` 请求体 | `llm.rs` Chat Completions 请求体 |
| `systemPromptParity.json` | `generateCoreSystemPrompt` / `generateToolUsagePrompt` / `assembleSystemPrompt` | `prompt::core_prompt` / `prompt::tool_usage_section` / `prompt::preset_core_prompt` |
| `pathParity.json` | `utils/path.ts::expandPath` | `tools::expand_path` |
| `skillsParity.json` | `skills/frontmatterParser` / `skills/variableResolver` / `formatSkillListing` | `skills::parse_frontmatter` / `skills::substitute_arguments` / `skills::format_skill_listing` |
| `compactParity.json` | `compact/prompt` / `compact/types` / `compact/compact` / `utils/replayMessages` | `compact::generate_compact_summary_prompt` / `compact::get_auto_compact_threshold` / `compact::build_post_compact_messages` / `replay::build_replay_message_data` |
| `mcpParity.json` | `mcp/Client.ts` 的 `normalizeMcpCallResult` / `quoteWindowsArg`、`mcp/Config.ts` 的解析与归一化 | `mcp::normalize_mcp_call_result` / `mcp::quote_windows_arg` / `mcp_config::*` |
| `spinParity.json` | `spin/Engine.ts` / `spin/SpinJudger.ts` 的纯函数 | `spin::get_variables_without_value` / `spin::topological_sort` / `spin::compute_progress` / `spin::build_run_prompt` / `spin::parse_accept` |
| `responsesParity.json` | `llm/ResponsesApi.ts` 的转换纯函数 | `responses::build_responses_url` / `responses::convert_messages_to_responses_input` / `responses::sync_content_blocks_from_output` |

对照表的生成脚本在 `scripts/gen-*.mjs`，改动任一侧实现后重跑生成脚本并跑
`npm run test:all` 与 `npm run test:core` 即可确认没有漂移。

---

## 5. `#[allow(dead_code)]` 审计（M16）

`core-rs` 的 allow 逐项归类（`cargo check` 与 `cargo check --tests` 均无 dead_code 警告）：

- `#[cfg_attr(not(test), allow(dead_code))]`：测试专用入口——parity 测试、夹具与
  对等断言直接调用，生产路径不走（如 `write_spin_json` / `parse_mcp_server_definitions` /
  `truncate_bytes` 等）；
- `#[allow(dead_code)]`：wire / 数据契约字段或预留入口——serde 反序列化字段、与
  Embedded 类型逐项对齐的字段、协议预留变体（`ChannelDescriptor::Direct` /
  `WorkspaceCloseReason::Crashed`），每处都有注释说明用途；
- 真死代码已删除：`write_spin_json_queued`、`SpinLoop::abort_flag`、
  `SpinHandle::abort_flag`（无任何调用方，含测试）。

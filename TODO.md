# TODO：Standalone Core（Rust）

本清单是 `docs/standalone-core.md` 的落地分解。原 Embedded Core（`src/core`）保留不动，
Standalone Core 是 Core 的第二套实现。

当前产出：Windows x64（`x86_64-pc-windows-msvc`）。目标矩阵预留 Windows / Linux ×
x64 / arm64，见 `docs/standalone-core.md` 第 4.1 节。

**状态**：本清单 143 项全部完成；三项预留平台的**实际产物**未产出（缺交叉工具链，
实测记录见 `docs/standalone-core.md` 第 4.3 节）。已知缺口与有意保留的实现差异见
`DIFF.md`。

进程模型：一个宿主实例一个 Core 进程；崩溃由宿主重启。

事件词汇表以 `src/core/AssistantEventBus.ts` 为准（`CoreEvent` 24 / `CoreRequest` 2 /
`UiEvent` 21）。字段名逐项一致。

产品名、Core 可执行文件名、产物目录名、选择变量名一律取自 `src/config/project.json`。

## 进度

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 选择变量与骨架 | 已完成 |
| M1 | 传输与契约打通 | 已完成 |
| M2 | 引擎与 LLM | 已完成 |
| M3 | 工具 | 已完成 |
| M4 | 历史与配置 | 已完成 |
| M5 | MCP 与技能 | 已完成 |
| M6 | Spin / i18n / 会话运行时 | 已完成 |
| M7 | 宿主侧收敛 | 已完成 |
| M8 | 构建、打包与验证 | 已完成（三项预留平台的产物未产出，见「预留」一节） |

---

## M0 选择变量与骨架（已完成）

- [x] 新增 `src/host/coreKind.ts`：`CoreKind = 'embedded' | 'standalone'`，默认 `CORE_KIND = 'standalone'`，`CORE_KIND_ENV` 覆盖。
- [x] `bootstrapCore` 按 `CORE_KIND` 装配总线：`embedded` 走 `createEventBus`，`standalone` 走帧通道；两种装配共用同一套接线顺序。
- [x] 新增 `core-rs/` Cargo 包：`Cargo.toml`（edition 2021，包名中性）、`src/main.rs`、`.cargo/config.toml` 按目标三元组参数化。
- [x] `core-rs` 设 Windows subsystem，无控制台窗口；标准输入 / 标准输出接帧通道。
- [x] 新增 `src/host/standalone/protocol.ts`：帧类型定义与编解码（`hello` / `ready` / `event` / `request` / `response` / `uiEvent` / `shutdown`）。
- [x] 新增 `src/host/standalone/coreBinary.ts`：按平台 / 架构解析产物目录（`resources/<core.resourceDir>/<arch>-<platform>/`）。
- [x] 新增 `src/host/standalone/CoreProcess.ts`：启动子进程、握手、关闭、崩溃检测、退避重启。
- [x] 新增 `src/host/standalone/StandaloneEventBus.ts`：实现 `AssistantEventBus`；连接态事件与会话集合在每次握手后重放。
- [x] `shutdownCore()` 在 `standalone` 下终止 Core 进程；`extension.ts` 的 `deactivate` 等待它。
- [x] `bootstrapSnapshot()` 增加 `coreKind` 字段。
- [x] 产品名 / 可执行文件名 / 产物目录名 / 环境变量名改从 `src/config/project.json` 读取（`core.binaryName` / `core.resourceDir` / `core.envVarSuffix`）。
- [x] 单测 `standaloneBus.test.ts` / `standaloneBootstrap.test.ts`：选择变量、帧编解码、产物定位、握手、排队、重放、崩溃重启、超限、关闭、隔离、突发不乱序、真实产物冒烟。
- [x] `bootstrapWiring.test.ts` 固定 embedded 装配，避免与 Standalone 接线互相污染。
- [x] 真实 VS Code 宿主冒烟（`npx vscode-test`）：扩展在 standalone 装配下正常激活。

完成判据：`CORE_KIND = standalone` 时 UI 能拉起 Core 进程并完成握手；`embedded` 路径不受影响。（已达成）

---

## M1 传输与契约打通（已完成）

- [x] Rust 侧帧读写：按行读取、按行写入、UTF-8、无帧上限。
- [x] Rust 侧事件总线：`emit` / `log` / `request` / `handle_response` / `handle_ui_event`。
- [x] `CoreRequest` 往返：`id` 生成、`response` 匹配、未决请求表。
- [x] `CoreEvent` 全量转发：帧通道按 `type` 透传，UI 侧处理器表穷尽注册（24 个 type）。
- [x] `UiEvent` 全量接收：帧通道按 `type` 透传，Core 侧记录并统计（20 个 type）。
- [x] 日志：`CoreEvent.log` 上报；标准错误只作诊断。
- [x] 崩溃：进程退出时连接断开、退避重启；重启超限报 fatal。
- [x] 契约测试：Rust 侧帧编解码单测 + TS 侧真实产物冒烟（`cargo test` / `standaloneBus.test.ts`）。
- [x] Core 侧业务事件落地：`message` / `streamMessage` / `streamEnd` / `toolCall` / `toolResult` / `toolArgsUpdated` / `queryBegin` / `queryEnd` / `aiBegin` / `aiEnd` / `sessionCreated` / `titleChanged` / `conversationListChanged` / `sessionRuntimeChanged` / `log` 已由 Core 进程产生。
- [x] 其余 `CoreEvent` 的产生点全部落地：`messagesReplaced`（压缩 / 归档展开）、`compactBegin` / `compactEnd`、`commandDispatched`、`highlightLanguagesUsed`、`projectConversationDirReady`、`spinDesignDataChanged`（Spin 循环起止）、`sessionConfigChanged` 的六个 `key`（`model` / `thinkingEffort` / `promptMode` / `agentMode` / `webSearch` / `mcpEnabled`，最后一项由 MCP 的 `notifyServersChanged` 出口发）。
- [x] `CoreRequest` 的业务发起点：`toolPermissionRequested` 已在工具执行前发出并等待应答。
- [x] `CoreRequest.userChoice` 的业务发起点：AskUserQuestion 经 `ToolContext::user_choice` 回调发 `userChoice` 并阻塞等待应答（对齐 Embedded `Integration.requestUserChoice`）。

完成判据：桩实现下 24 + 2 + 20 个词汇表可双向跑通，字段一致。（帧链路已达成）

---

## M2 引擎与 LLM（已完成）

- [x] 消息与状态类型：会话消息以 JSON 透传，字段与 `src/core/types.ts` 一致。
- [x] `QueryEngine` / query loop：`core-rs/src/engine.rs`（轮次循环、工具结果回填）。普通会话**不设轮次上限**：Embedded 的 `maxTurns` 只由 Spin / Agent 子会话传入（`MAX_SAFE_INTEGER`），`settings.json` 的 `features.maxTurns` 在 TS 侧没有任何消费方，Standalone 同样不读（用例 `engine_tests.rs::settings_features_max_turns_is_ignored_like_embedded` / `tool_loop_has_no_default_turn_limit`）。
- [x] 用户消息管线：唯一入口 `UiEvent.userMessageSubmitted`；队列 + 单消费循环；多轮上下文从内存 / 磁盘载入（`standaloneCoreEngine.test.ts` 覆盖两轮）。待处理的用户消息是**单槽位**（`SessionState.pending_user_message`），新消息**替换**排队中的旧消息——对齐 Embedded `submitMessage(type='user')` 的 `this.pendingUserMessage = promptStr`（Agent 回复才追加，见 `agent_messages`）。用例 `engine_tests.rs::a_second_user_message_replaces_the_pending_one`。
- [x] 排队消息在每次 LLM 请求前 flush（`flush_queued_messages`）：多轮工具调用期间到达的用户消息在生成下一个 tool_use 之前插入上下文并落盘，对齐 `QueryEngine.flushQueuedMessagesIntoContext` / `Query.ts` 阶段 0.5（对等用例 `queueFlushParity.test.ts` ↔ `engine_tests.rs::queued_message_is_flushed_before_the_next_llm_round`）。
- [x] Reminder 落盘：`silent` / `origin=agent` 的 reminder 与普通消息一样写进 jsonl、计入 `messageCount`、各发一次 `conversationListChanged`，对齐 `persistUnpersistedMessages`（对等用例 `queueFlushParity.test.ts` ↔ `engine_tests.rs::assistant_reply_ending_with_a_colon_triggers_a_silent_reminder_follow_up`）。
- [x] 命令解析：`CommandDispatcher`、内置命令、技能命令。`commands.rs::dispatch` 三段优先级（内置命令 → Skill 匹配 → passthrough）与 `^\/(\S+)(?:\s+([\s\S]*))?$` 的参数切分逐字对齐（多行参数 / 别名 / 多个空格都覆盖）；命令在**出队时**才解析（`engine::resolve_pending_command`，放在消费循环里、`flush_queued_messages` 之外），内置命令就地执行并丢弃该消息（`Handled`，执行前发 `commandDispatched`，非空返回值转 system 消息），Skill 命中则记 `pending_skill_injection`、用户消息照常进上下文，随后由 `run_turn` 注入 Skill tool_use（`inject_skill_tool_use`：assistant tool_use + tool_result 携带技能正文，对齐 `submitToolUse`）。内置命令注册表含冲突检测（Skill 与内置命令同名 / 同别名时记 WARNING 并忽略该 Skill）。对等用例 `skillsParity.test.ts` ↔ `skills_tests.rs`；单测 `commands_tests.rs`。
- [x] LLM API 类型：Anthropic Messages 与 OpenAI Chat Completions 的流式调用。
- [x] Responses API。`responses.rs` 逐项对齐 `llm/ResponsesApi.ts`：URL（`joinV1Path` 口径）、工具转换（非 `function` 原样透传）、消息 → input items（工具调用是**顶层 item**：`function_call` / `function_call_output`，reasoning 转顶层 `reasoning` item 且空 thinking 跳过、不生成随机 id 以保持请求前缀字节一致）、`max_output_tokens` / `temperature=1.0` / `top_p=0.95` / `instructions` / `reasoning.effort`（`off` → 显式 `none`）、status → `stop_reason` 映射、usage 提取（`input_tokens` 已含缓存命中，不再加回）、本地输入估算（图片 base64 先剔除再按固定成本补回）、usage 可信度（超上下文窗口 60% 跳过本轮，跳过时不发 `Usage` 事件）、以及 `response.output` → 内容块的权威校准（新增 `LlmEvent::AuthoritativeBlocks`，服务端只发终止事件时由引擎整体替换本轮累积）。SSE 事件循环覆盖 `output_item.added/done`、`content_part.added`、`output_text.delta/done`、`reasoning_*_text.delta/done`、`function_call_arguments.delta/done`、`completed` / `incomplete` / `failed`，以及「流结束但无终止事件」的截断检测（所有 output item 都 done 则接受为 `end_turn`，否则丢弃部分输出并重试）。**已知缺口**：内置 `web_search` 工具与搜索卡片事件（`web_search_call` / `_update` / `_done`）尚未迁入——本阶段不下发该工具，`webSearchUsed` 恒为 false。对等面：`responsesParity.json`（55 条断言，`responsesParity.test.ts` ↔ `responses_tests.rs`）；流式端到端见 `responses_stream_tests.rs`。
- [x] 流式解析与 `streamMessage` / `streamEnd` / `aiBegin` / `aiEnd` 事件。
- [x] Anthropic `content_block_start` 的初始值：thinking 块的 `signature` 与 tool_use 块的 `input` 都按 Embedded `RealApi` 保留（没有 `signature_delta` / `input_json_delta` 时它们就是最终值；有增量时 signature 追加、input 解析后覆盖）。用例 `llm_tests.rs::anthropic_stream_keeps_signature_from_content_block_start` / `anthropic_stream_uses_content_block_start_input_when_no_delta` 与 `engine_tests.rs::anthropic_start_signature_is_persisted_in_thinking_block` / `anthropic_content_block_start_input_is_persisted_without_delta`。
- [x] 流式 block 粒度：`llm.rs` 的 `LlmEvent` 补 `BlockStart` / `BlockStop` / `MessageDelta` 三个边界事件（Anthropic 直接来自 `content_block_start` / `content_block_stop` / `message_delta`；Chat Completions 由适配器按角色切换合成，对齐 `OpenAiApi` 的 `emitBlockStop()` / `emitMessageDelta()`），`engine.rs` 据此对齐 `Query.ts`：块级 `streamId`（`blk_*`，`streamMessage` 与 `streamEnd` 共用）、`block_stop` 一条 **usage 缺省**的 `streamEnd`、`message_delta` 按角色各一条**带 usage** 的（纯 tool_use 轮次补一条 `accumulated` 为空、`streamId` 回退轮次级 `msg_*` 的 assistant 事件）。用例 `llm_tests.rs::anthropic_stream_emits_block_boundaries` / `anthropic_stream_emits_a_tool_use_block` / `openai_stream_synthesizes_block_boundaries` / `openai_tool_calls_get_their_own_block`、`engine_tests.rs::anthropic_stream_end_granularity_matches_embedded_blocks` / `openai_stream_end_granularity_matches_embedded_blocks` / `pure_tool_use_turn_emits_one_usage_carrying_stream_end`，以及 `standaloneCoreEngine.test.ts` 的真实帧通道断言。
- [x] 重试与退化重复：网络错误 / 502、503 与「无内容且无结束原因」按 `MAX_RETRIES=3` / `RETRY_DELAY_MS=1000` 重试；`repetitionDetector.ts` 的退化重复检测（尾窗 + 反转串 Z 函数）已移植并接入两条流（`DEFAULT_MAX_REPETITION_RETRIES=1`，重试前发 `Reset` 丢弃本轮输出），对齐 `shared.ts` / `OpenAiApi.ts` / `RealApi.ts`。Chat Completions 的 `stream_options.include_usage` 被 400 拒绝时，与 Embedded 一致地**占用一次重试预算 + 先等 `RETRY_DELAY_MS`**，并在本次调用内的后续请求里持续省略该字段（用例 `llm_tests.rs::openai_stream_drops_stream_options_when_provider_rejects_it`）。
- [x] 流式看门狗：移植 `streamTimeout.ts` 的首字节 300s / 空闲 60s（`DEFAULT_FIRST_BYTE_TIMEOUT_MS` / `DEFAULT_STREAM_IDLE_TIMEOUT_MS`）与超时重试 1 次（独立预算 `DEFAULT_MAX_TIMEOUT_RETRIES`，重试前发 `Reset` 丢弃本轮输出）。阻塞读取放在独立线程、主线程 `recv_timeout` 计时；「有效事件」口径与 Embedded 一致（Anthropic 的 `ping` / SSE 注释不算进展，OpenAI 能解析出 JSON 的数据帧都算）。用例 `llm_tests.rs::stream_watchdog_times_out_on_first_byte_and_retries_once` / `stream_watchdog_does_not_treat_anthropic_ping_as_progress` / `stream_watchdog_times_out_after_idle_gap_and_retries_once` / `stream_watchdog_resets_idle_timer_on_progress`。
- [x] 用量统计（input / output / cache / reasoning token）：`streamEnd` 的 usage 恒带 cache 两键（缺省 0），与 Embedded `extractUsageFields` 一致。
- [x] 上下文估算与输出上限钳制：移植 `tokenEstimate.ts`，按 Query.ts 的 `getAvailableOutputTokens = min(output, contextWindow - 当前上下文占用)` 钳制请求体 `max_tokens`（`util::estimate_request_tokens` + `ProviderConfig.context_window`）。
      **当前上下文占用**取 `Math.max(exactTokenCount ?? 0, 估算值)`：`exactTokenCount` 是最近一条带 `usage` 的 assistant 消息的 `input + output`（内存里找不到时回退 `meta.json` 的 `context.totalContextTokens`），见 `engine.rs::exact_context_tokens`；只取估算值时，真实上下文大于估算值（多模态图片等）会把输出空间留大，导致 `input + max_tokens` 超出窗口（用例 `engine_tests.rs::available_output_tokens_matches_the_embedded_formula` / `exact_context_tokens_prefers_the_last_assistant_usage` / `exact_context_tokens_falls_back_to_metadata_total_context_tokens`）。
- [x] 流内错误与工具调用 id 口径：Chat Completions 的 `data: {"error":...}` 文案按 `` `Chat Completions failed: ${err?.message || JSON.stringify(err)}` `` 拼接（没有 `message` 字段时显示整个 error 对象，而不是 `unknown error`）；`tool_calls[].id` 在 block 创建时定死（`tc.id || call_${streamMessageId}_${idx}`），后续分片补上的 id 不替换兜底 id（用例 `llm_tests.rs::openai_stream_error_without_message_serializes_the_error_object` / `openai_stream_keeps_the_fallback_tool_id_when_a_later_chunk_carries_one`）。
- [x] 压缩触发：`compact/*`、`compactBegin` / `compactEnd` / `messagesReplaced`。`compact.rs` 的阈值口径逐字对齐 `types.ts`（`contextWindow - min(50K, 0.3 * maxOutputTokens)`，**保留浮点**：`0.3 * 8192 = 2457.6` 这类非整数值会原样参与比较）与 `autoCompact.ts` 的三道闸门（`DISABLE_AUTO_COMPACT=true` 关闭 / 连续失败 >= 3 熔断 / token 数达到阈值）；触发点在 `run_query_loop` 里、`aiBegin` **之前**，上下文占用口径与 Embedded 一致（`max(exactTokenCount ?? 0, estimate(messages, systemPrompt))`，**不含** tools）；手动触发走 `Core::request_compact`（`compactRequested` UiEvent → 后台线程）：无可压缩消息直接忽略、已在压缩中忽略、非空闲则登记 `pending_compact` 并提示、否则立即压缩并在收尾时 `resume_after_compact` 唤醒压缩期间入队的消息。用例 `compact_tests.rs::auto_compact_gate_checks_env_circuit_breaker_and_threshold`、`compact_engine_tests.rs::auto_compact_triggers_when_the_context_exceeds_the_threshold` / `manual_compact_is_deferred_while_the_session_is_busy` / `messages_arriving_during_compact_are_queued_then_resumed`。
- [x] 模型引用与 LLM 配置：会话级 provider / model 覆盖 + `settings.json` 解析。
- [x] 系统提示与环境信息：核心原则、工具清单、环境（OS / shell / cwd / git）、`AGENTS.md`、会话上下文。
- [x] `PromptPreset`（normal / minimal / mixed）：`prompt.rs` 按 `PROMPT_PRESETS` 组装（minimal / mixed 只有单行核心身份、无区块），工具白名单仅 `Bash` / `Edit`，`mixed` 在首次 assistant 回复前用 minimal 后切 normal；会话级 `promptMode` 从 meta.json 恢复、落盘时按 `updateMetadataForNewMessage` 补写，`minimal` 强制关闭 webSearch。
- [x] 压缩：`compact/*`、`compactBegin` / `compactEnd` / `messagesReplaced`。`compact/prompt.ts`（摘要 prompt / 压缩后 user 消息 / 边界标记文案 / 用户输入历史提取）、`compact/compact.ts`（`hasCompactableMessages` 的「边界之后严格多于保留数」、`sanitizeToolPairing` 的孤儿 tool_result 删除与孤儿 tool_use 补 `is_canceled`、`clearMessageUsage`、`buildPostCompactMessages`）与 `utils/replayMessages.ts`（`buildReplayMessageData`：`_meta` 裁剪、文件标签隐藏、Edit 的 diff 分支、`isMeta` / `silent` / 边界标记跳过）全部迁入（`compact.rs` + `replay.rs`）；`compact_and_apply_messages` 就地把消息数组换成 `[边界, 摘要, ...保留区]`、整文件重写 jsonl（`history::replace_messages`）、归档写出被摘要的部分（`history::save_compact_archive` → `<sid>.compact_archive.jsonl`）、`meta.json` 打 `isCompacted` / `isExpanded`，最后发一条 `messagesReplaced` 让 UI 整批替换。对等面：`compactParity.json`（38 条断言，`compactParity.test.ts` ↔ `compact_tests.rs` / `replay_tests.rs`）；端到端见 `compact_engine_tests.rs::manual_compact_rewrites_the_conversation_and_archives_the_rest`。

完成判据：用户消息 → 流式回复回路可用，事件序列与 Embedded 一致。

---

## M3 工具（已完成）

- [x] 工具框架：`core-rs/src/tools.rs`（定义表 + 执行分发 + 结果上限 前 2K + 后 2K）。
- [x] 入参修复：`engine::fix_tool_input` 完整对齐 `RunTools.fixToolInput`——顶层 double-encode 解包、字段值合法 JSON 字符串解包、以及畸形数组 / 对象的抢救（key 缺引号、单引号、按逗号拆分、嵌套括号、引号内逗号）。对等用例 `toolInputRepairParity.test.ts` ↔ `engine_tests.rs::fix_tool_input_parity_tests`（共用 `src/test/fixtures/toolInputRepairParity.json`，39 条）。
- [x] `Bash`：shell 探测对齐 `ShellDetector`（Git Bash > 常见安装路径 > PATH > PowerShell > cmd）、cwd（`input.cwd || context.cwd` 原样交给子进程：相对路径按 Core 进程 cwd 解析、`~` 不展开）、超时策略（含 `sleep` 子命令不设前台超时，对齐 `SleepDetect` / `TimeoutPolicy`）、stdout/stderr 合并；子进程 stdin 置空（不继承帧通道）。
- [x] 中断语义：`abortRequested` 在工具执行前到达时**不执行**该工具，补 `Command was aborted before execution`（`exit_code: -1` / `is_canceled: true`）并结束本轮；执行中到达时杀掉子进程（`exit_code: 130` / `Command was interrupted`），均对齐 Embedded `executeSingleItem` / `Exec.ts`。
- [x] 工具往返端到端：假 LLM 触发 Bash / Read → 工具结果回填 → 最终回复（`standaloneCoreTools.test.ts`）。
- [x] 后台 Bash 任务与完成通知事件：`core-rs/src/bash_task.rs` 对齐 `tools/bash/LocalShellTask.ts` + `TaskOutput.ts`（file mode）+ `ShellCommand.ts`。
  - `run_in_background`：子进程 stdout/stderr 直接重定向到 `<TMPDIR>/tuxedo-cat-tasks/<taskId>.output`，立刻返回 `taskId`（tool_result 文案逐字对齐 `Result.ts`）；`run_in_background` 按 JS `Boolean(value)` 强制转换（对齐 `z.coerce.boolean()`）。
  - 前台超时**不再杀进程**，改为自动转后台继续跑（`bg-auto-` 前缀，`assistantAutoBackgrounded` 文案 + `find` reminder）；只有「打开输出文件失败」才以退出码 124 收尾。
  - 通知驱动转后台：普通命令收到后台任务完成通知且已运行 ≥ `AUTO_BG_MIN_RUNNING_MS`(3s) → 转后台；`sleep` 命令收到**本会话**的后台任务完成通知或子代理 Reply 投递 → 立刻转后台。
  - 完成通知经 `enqueue_bash_notification` 注入为一条 `origin='bash'` 的 user 消息（进上下文 + 上报 UI + 落盘），空闲时唤醒消费循环；`SessionState.background` 参与 `idle` 判定；会话中止 / 关闭 / 删除时中止该会话全部后台任务（先移除记录再 kill，被中止任务不发通知）。
  - 兜底提醒：消费循环即将空转但仍有未提醒的后台任务时，注入一条 reminder 列出 `taskId` / `pid` / 命令与按当前 OS 生成的 kill 命令（同一批任务只提醒一次）。
  - 用例：`bash_task_tests.rs`（9 条）、`tools_tests.rs`（后台 / 自动转后台 / 中断 / find 词边界共 9 条）、`engine_tests.rs`（通知唤醒消费循环、后台任务占用 idle 2 条）、`standaloneCoreTools.test.ts`（后台 Bash 端到端 + schema 暴露 `run_in_background`）。
- [x] 并行工具批：连续出现的并发安全工具攒成一批**并行**执行（对齐 `RunTools.executeToolBatch` 的收集循环 + `executeParallelBatch`）。
      `tools::is_concurrency_safe` 逐工具对齐 `isConcurrencySafe`（Read / Grep / Glob 恒真；Bash 等同 `isReadOnly(input)`；Edit / Write / TodoWrite / AskUserQuestion 为假）。
      顺序契约：批内所有工具的 `toolCall`（授权一次 + 执行前一次）先发完，再**按原顺序**发 `toolResult`——tool_result 的顺序与内容与串行实现完全一致，差别只在耗时与 `toolCall` 时序。
      批边界：遇到非并发安全工具 / 入参校验失败（skip）/ 权限拒绝 / 批末时冲刷；拒绝路径先补 `cancelRemainingTools`（index 之后）再补 `cancelApprovedItems`（批内未执行的），顺序与 Embedded 一致；执行前已中止则整批按 `Command was aborted before execution` 取消。
      实现上把「执行单个工具」与「上报结果」抽成 `execute_tool` / `emit_tool_outcome`，并行批每个工具一个线程（`tools::execute` 是阻塞调用）。
      用例 `engine_tests.rs::consecutive_concurrency_safe_tools_run_as_one_parallel_batch`（两 Read 的完整事件时序）/ `a_non_concurrency_safe_tool_flushes_the_pending_batch`（`[Read, Bash(非只读), Read]` 的批边界）、`tools_tests.rs::concurrency_safety_matches_embedded`。
- [x] `Read` / `Write` / `Edit`：行号 `N|text` 输出、窗口上限、图片 base64、精确替换 + 行区间。
- [x] `Edit` / `Write` 的 diff 预览字段与回滚：tool_result 携带 `beforeContent`（Edit 另带 `startLine` / `endLine`），请求载荷经 `NON_LLM_BLOCK_FIELDS` 剔除。
- [x] `Edit` 的权限阶段匹配校验：`checkPermissions` 读文件后先跑 `computeEdit` 的「old_string 找不到 / 多处匹配且未 replace_all」检查，命中即 deny（不弹确认框，`auto` / `risk` 也不放行），与 `run_edit` 共用 `tools::edit_match_error`；对照表 `permissionParity.json` 新增 3 条用例（两侧同表）。
- [x] `editRolledBack` 回滚：`core-rs/src/rollback.rs` 对齐 `history/rollback.ts`——按消息顺序收集 Edit / Write tool_use，`_meta.beforeContent` 缺失时回退 `tool_result.beforeContent`；`before` / `after` 两个方向写回目标文件，并把目标之后对其它文件的修改恢复到各自第一次 Edit 前的状态；`beforeContent` 为 `null` 时删除文件；相对路径按**会话自己的工作目录**解析（`tools::expand_path`）；结果作为 system 消息回传（文案逐字对齐）。用例 `rollback_tests.rs`（10 条）。
- [x] `Grep` / `Glob`：复用随应用分发的 ripgrep 产物。
- [x] `TodoWrite`。
- [x] `Agent` / `Reply` / `SubAgentRegistry`：`core-rs/src/subagent.rs` 是注册表（子会话 → 创建者，对齐 `SubAgentRegistry.ts`；与 Embedded 一致只注册不注销），`tools.rs::run_agent` / `run_reply` + `engine::run_sub_agent` 承担完整链路。
  - `Agent`：权限层对齐 `AgentTool.checkPermissions`（prompt 空 → deny `Agent 工具需要提供任务描述(prompt)。`；缺 agentRole → deny；会话 id 以 `sub_` 开头 → deny 且 `shouldTerminate: true`；其余返回裸 `{ behavior: 'ask' }`）；`call` 建 `sub_<millis>_<rand>` 子会话、预写 `meta.json`（parentSessionId / role / model，对齐 `createConversationMetadataSync`）、继承父会话的 agent mode（父 auto → auto，其余 risk）/ model / thinking effort、登记注册表、起后台线程，立刻返回 `✓ Agent [Master] created` 的结果文案。
  - 子代理驱动 `run_sub_agent`：静态系统提示词 = 核心身份 + `## Communication`（对齐 `staticSystemPrompt`，整体替换按预设组装的提示词）；一对 `queryBegin` / `queryEnd` 覆盖含 Reminder 的整个生命周期；跑完一轮后按 `checkSubAgentHasReply`（最后一个非 silent、content 为字符串的 user 消息之后是否有 `Reply` 的 tool_use）判断，未回复则注入 Reminder 重试（最多 3 次，文案随重试递进，对齐 `buildReminderContent`）。
  - `Reply`：目标解析顺序 = 显式 `targetSessionId`（排除 `current_session` 占位）→ 注册表里的创建者；投递经 `enqueue_agent_message`（`origin='agent'` + `agentId` + `_meta: {param: '<host>:agent:<id>', type: 'from'}`），进父会话上下文、上报 UI（markdown + From 头）、落盘；同时触发 `agentReplyDelivered` 事件。
  - `sessionRuntime.idle` 递归：父会话「自身不忙且所有已登记子代理都空闲」才算空闲（对齐 `isIdleInSnapshot`）。
  - `sleep` 的 `watchSleepNotifications` 两半都已接线：后台任务完成 + 子代理 Reply 投递都会把前台 sleep 转入后台。
  - 对等面：`toolSchemaParity` / `systemPromptParity` / `toolInputValidation` / `permissionPolicyParity` 四份对照表新增 Agent / Reply 用例；`engine_tests.rs` 两条端到端用例（Agent→Reply→父会话上下文、无 Reply 时 3 次 Reminder）。
- [x] `AskUserQuestion`：定义 + 入参 schema（`question` 必填、`choices` 1–9 可选）+ `checkPermissions` 直接放行（不带 `updatedInput`）+ 经 `CoreRequest.userChoice` 弹框，响应映射与 `mapToolResultToToolResultBlockParam` 文案逐字对齐（`tools.rs::run_ask_user_question`）。对等面：`toolSchemaParity` / `toolInputValidation` / `permissionParity` / `permissionPolicyParity` / `systemPromptParity` 五份对照表新增 AskUserQuestion 用例，另有 `tools_tests.rs` / `engine_tests.rs` 单测。
- [x] `Skill`：技能工具与 `SkillTool` 末位不变式。工具定义（`skill` 必填 + `args` 可选，`description` 固定为 `Execute a skill (slash command).`）已加入 `tools::definitions()` 的**末位**，并有 `assert_skill_tool_is_last` 守住该不变式（对齐 `tools/index.ts` 模块加载期校验）；`validateInput` 语义（空 skill → `Invalid skill format: `、找不到 → `Unknown skill: x`）进 `tools::validate_input`（新增 `cwd` 参数，Skill 需要按目录解析技能）；`checkPermissions` 直接放行（不带 `updatedInput`）；`call()` 取技能正文 → 替换 `${SKILL_DIR}` / `${SESSION_ID}` → 包装成 `isMeta: true` 的 user 消息经 `ToolOutcome::SuccessWithMessages` 注入对话（对齐 `RunTools` 的 `toolResult.newMessages` 在 tool_result 之后逐条 yield）。对等面：`systemPromptParity.json` 新增 `### Skill` 段与工具清单末位；`tools_tests.rs` 覆盖定义 / 校验 / 执行。
- [x] 权限策略：完整对齐 `PermissionPolicy`——只读命令表 / 多词只读对（git 子命令）/ 破坏性命令表 / `risk` 风险拦截（`git checkout|reset` 与破坏性命令）/ `auto` 全放行 / `manual` 一律询问。
- [x] `ask` 两步链路：`toolPermissionRequested`（上架卡片、取权限结果）→ 结果保持 `ask` 时再发 `userChoice` 弹确认框；拒绝消息为「用户拒绝操作」。
- [x] 权限请求覆盖全路径：与 Embedded 一致，**所有**工具（allow / deny / ask）执行前都发一次 `toolPermissionRequested`（UI 上架卡片；Edit / Write 还靠它写 `_meta`）。`displayArgs` 完整展开（Read / Write / Edit 路径展开、Write 的 `contentPreview` / `totalLines` / `isTruncated`、Edit 的 `old_string` / `new_string` / `replace_all` 与 diff 字段），`permResult` 带 Edit / Write 的 `beforeContent` / `afterContent` / `contextBefore` / `contextAfter` / `startLine` / `endLine` / `lineEndings`，以及默认工具（Read / Grep / Glob / TodoWrite）与只读 Bash 的 `updatedInput`；`updatedInput` 与内存入参不同（zod coerce / default）时追加 `tool_use_update`。对照表 `permissionPolicyParity.json`（34 条，两侧同表）+ `standaloneCorePermissionPreview.test.ts`。
- [x] 工具执行前写 `_meta.confirmTimestamp`（`tool_use_update` 合并进已有 `_meta`），并再发一次 `toolCall`（对齐 `executeSingleItem` / `executeParallelBatch`）。
- [x] 对等测试：`permissionParity.test.ts` 与 `core-rs` 单测读同一份 `src/test/fixtures/permissionParity.json`（24 条用例）。
- [x] 权限回归测试：`standaloneCorePermission.test.ts`（risk / manual / auto × 允许 / 拒绝）。
- [x] 工具参数与结果事件：`toolArgsUpdated` / `toolCall` / `toolResult`。
- [x] 工具进度事件：`toolProgress`：Bash 的 stdout / stderr 按块上报 `bash_progress`（`output` / `fullOutput`（4K 预览）/ `elapsedTimeSeconds` / `totalLines` / `totalBytes` / `timeoutMs`）。
- [x] 子进程不闪窗：所有 spawn 走 `util::hide_console`（`CREATE_NO_WINDOW`），
      git 状态按工作目录缓存；`standaloneCoreEngine.test.ts` 有静态守卫。
- [x] 资源定位：ripgrep 产物。
- [x] 文档读取：doc/docx/ppt/pptx 经随应用分发的 pandoc 转 markdown（缓存到 `tool-results/<sessionId>__<stem>_<sha1>.md`）；xlsx/xlsm 用 `calamine` 读成对齐列宽的行文本（`sheet` 选表、`offset`/`limit` 窗口、每行 `String(cell)` 走 ECMAScript 口径）。`Read` schema 补 `sheet`，`toolSchemaParity` 的 `Read.sheet` 缺口移除；`toolResultParity` 新增 4 条 xlsx 用例（共用提交入库的 `src/test/fixtures/xlsx/people.xlsx`）。

完成判据：默认工具集在 Core 侧可执行，权限确认与用户问答经帧通道往返。

---

## M4 历史与配置（已完成）

- [x] 配置目录：`~/<configDirName>`、对话根目录、项目对话目录（含超长路径哈希）。
- [x] 全局 `settings.json` 读取（provider / 模型 / 协议 / 用量参数）。
      错误口径对齐 Embedded：会话显式指定的 provider 不存在 / 没有 `baseURL` → `provider "X" 不存在或未配置 baseURL`（`getConfigForProvider` 不做回退）；其余「没有可用 provider / 没有 apiKey」→ `getConfig` 的「API Key 未配置，无法调用 LLM。」文案（逐字一致，含 `~/<configDirName>/settings.json` 路径）。模型解析链对齐 `llm.model`（顶层遗留字段，仅在无会话级 provider 覆盖时生效）→ `provider.defaultModel` → `provider.models[0]`（用例 `config_tests.rs::resolve_provider_reports_missing_configuration` / `resolve_provider_prefers_the_legacy_top_level_model`）。
- [x] 全局 `settings.json` 写入（唯一写入点在 Core）：`config::update_settings_json` 串行化「读-改-写」（进程内写锁）+ JSON Merge Patch（RFC 7386：对象递归合并 / `null` 删除键 / 数组与标量整体替换）+ 写盘后清读缓存，无变化时不写盘；`UiEvent.settingsJsonUpdateRequested` 是宿主的写入口，`config::merge_highlight_languages` 把新语言并入 `highlightLanguages`（去重 + 上限 60）并在 `emit_highlight_languages` 里直接落盘。用例 `config_tests.rs::merge_json_patch_follows_rfc7386` / `update_settings_json_merges_and_resets_the_cache` / `update_settings_json_skips_a_no_op_patch` / `merge_highlight_languages_dedupes_and_caps`、`main_tests.rs::settings_json_update_requested_writes_the_global_config` / `settings_json_update_requested_accepts_null_to_delete_a_key`、`engine_tests.rs::highlight_languages_event_only_reports_fresh_languages`、`standaloneCoreEngine.test.ts`（真实帧通道）。
      **仍归宿主的写入口**：LLM 配置保存（`handleSaveLLMConfig`）与 MCP 默认值——它们需要把设置面板的整段 mutation 逻辑搬到 Core（含 `normalizeModelTokenLimits` / `providerKeyFromBaseURL` / 模型注册表），随 M7 的「全局配置写入口」一并切换。
- [x] 项目清单 `<conversations>/<project>/settings.json` 读写：Core 建目录时自己写（`config::write_project_settings`，`workspacePath` 未变化时不重写；文件非对象时按空对象重建），并提供反查（`config::project_settings_workspace_path`，对齐 `ConversationSpace.readWorkspacePath`；消费方随对话空间列表接入）。用例 `config_tests.rs::write_project_settings_is_idempotent_and_readable` / `ensure_project_conversation_dir_writes_the_manifest`、`standaloneCoreEngine.test.ts`。
- [x] 会话数据：`meta.json`、`<sessionId>.jsonl`、`tool_use_update` 回放。
- [x] 历史按 `parentUuid` 链重建：`history::parse_messages` 与 Embedded `loadConversation` 同口径——单条损坏 / 缺 `uuid` 的行只跳过、重复 `uuid` 后写覆盖先写且保留首次位置、自引用 `parentUuid` 的合成恢复消息重新挂到包含对应 `tool_use` 的 assistant（找不到则退化为根节点）、父节点缺失退化为根节点、根与同层兄弟按 `timestamp` 稳定排序后 BFS。两侧共用对照表 `src/test/fixtures/historyChainParity.json`（7 条，`historyChainParity.test.ts` ↔ `history_tests.rs::load_messages_matches_the_embedded_chain_fixture`）。
- [x] 崩溃恢复补出的 `tool_result` 落盘：`ensure_tool_results` 补出的合成结果先进内存（`persisted_count` 之前的未落盘区），下一次持久化时机（用户消息 / 排队消息 / reminder / 中断收尾）由 `persist_unpersisted_messages` 按序补写；消息自带 `parentUuid` 优先（对齐 `resolvePersistParentUuid`），新消息接在恢复结果之后，`meta.json` 的 `messageCount` 与 Embedded 一致。`restoreConversationEngine` 的 `lastPersistedMessageUuid` 同样跳过 `tool_recovered_*`。对等用例 `historyCrashRecoveryParity.test.ts` ↔ `engine_tests.rs::crash_recovered_tool_results_are_persisted_before_the_next_user_message`。
- [x] 落盘格式与目录布局与 Embedded 一致（两实现可互读）。
      有意保留的差异：Embedded 会把内部标记 `_persisted: true` 写在消息对象上、随 jsonl 一起落盘；
      Standalone 用 `SessionState::persisted_count` 在内存里等价跟踪「哪些消息已落盘」，不写该内部标记
      （不影响两实现互读，也不进 LLM 请求载荷）。
- [x] 会话列表：`conversationListChanged` 已上报；粒度对齐 Embedded——每落盘一条消息（`Conversation.appendMessage`）各发一次，`meta.json` 的 `messageCount` 同步刷新（列表读取仍由宿主直接读盘）。
- [x] 事件粒度：`titleChanged` 只在 `conversationRenamed`（与 Spin 改名）时发出，新消息推导标题不发；`sessionRuntimeChanged` 内部 diff 后才发（无变化不发），`states` 按会话插入序输出。
- [x] 会话生命周期：`conversationStarted` / `conversationOpened` / `conversationClosed` / `conversationRenamed` / `conversationDeleted`。
- [x] 会话上下文：`conversationContextUpdated`、会话工作目录表、`conversationSpaceCleared`。
- [x] 会话配置：`modelChanged` / `agentModeChanged`（其余为记录后忽略）。
- [x] 回滚（`rollback`）：`editRolledBack` 已接线到 `rollback::rollback_edit`（见 M3）。
- [x] 智能命名、归档、余额推送（`smartNaming` / `balancePush` / `expandCompact`）。三者都要读 core 的磁盘数据（会话消息 / 压缩归档 / `settings.json` 里的 DeepSeek Key），因此 Standalone 下整体在 Core 侧完成，宿主经 `UiRequest` 取结果：
      - `smartNamingRequested` → `smart_naming.rs`（`collect_smart_naming_context` / `SMART_NAMING_SYSTEM_PROMPT` / `parse_smart_naming_title` 逐字对齐 `history/smartNaming.ts`，含「最后一个 JSON 对象」的反向扫描与三级回退）；只**生成**标题，改名仍由宿主发 `UiEvent.conversationRenamed`，两种装配下宿主后续代码相同；
      - `balanceRequested` → `balance.rs`：固定查 DeepSeek 官方，Key 按 **hostname** 匹配 `api.deepseek.com` 那个 provider（与 active provider 无关——网关的 Key 打官方接口只会 401），没配就返回 `null` 不发请求；
      - `compactArchiveRequested` → `compact_archive_display`：归档 + 主 JSONL 的合并（旧格式补摘要、新格式只补保留区），合并口径在 Core 侧，宿主只做 `buildReplayMessageData` 转换与下发。
      用例 `smart_naming_tests.rs`（19）/ `balance_tests.rs`（8）/ `main_tests.rs` 的 `ui_request_*`。
- [x] 高亮语言上报：`highlightLanguagesUsed`：消息落盘后扫描围栏代码块语言，只上报 `settings.json` 的 `highlightLanguages` 尚未记录过的项。Standalone 下 Core 自己把新语言并入 `settings.json`（`config::merge_highlight_languages`），宿主侧处理器在 standalone 下不再写盘。
- [x] 项目目录就绪：`projectConversationDirReady`：首次确保项目对话目录（含启动时对既有目录的补上报）时上报一次，宿主据此写目录里的 `settings.json`（core 只读不写）。
- [x] `meta.json` 的 `updatedAt` 只由用户主动发送的消息（`_userInitiated`）刷新，后台自动消息只累加 `messageCount`（对齐 `updateMetadataForNewMessage`）。

完成判据：Embedded 写出的会话目录可被 Standalone 读取与续写，反之亦然。

---

## M5 MCP 与技能（已完成）

- [x] MCP 客户端：stdio 与 HTTP。`mcp.rs`（公共契约 + stdio + `McpTool` + `Manager` + `MCPHost`）、`mcp_http.rs`（Streamable HTTP + 旧版 SSE 回退）、`mcp_config.rs`（`mcp.json` 读取与会话启用覆盖）逐项对齐 `src/core/mcp/*`：
      JSON-RPC 骨架（`initialize` → `notifications/initialized` → `tools/list` 含 `nextCursor` 分页最多 50 页 → `tools/call`，`PROTOCOL_VERSION`/`CONTROL_TIMEOUT_MS`/`CALL_TIMEOUT_MS` 三个常量原样）；
      服务器反向请求一律回 `-32601 Method not found`（避免其阻塞等待）、通知直接忽略、非 JSON 行只记日志；
      `normalizeMcpCallResult` 的四种 content block 与「空 content 兜底序列化」；
      Windows 下 `shell:true` 的参数自行加引号（`quote_windows_arg`）、终止走 `taskkill /T /F`。
      stdio 用真实子进程（`node -e`）做端到端：握手 / 分页 / 调用 / 反向请求被回绝 / 进程退出时的 reject 与 `onExit` / 主动 `stop` 不触发 `onExit`；HTTP 用自写的可编程假服务器覆盖 Streamable 头回传、POST 返回 SSE、JSON-RPC error 合并、旧版 SSE 回退。
      **有意保留差异**：`reqwest::blocking` 没有对外中止句柄，旧版 SSE 的 `stop()` 只置停止标记（读线程在服务器关闭连接或下一个事件时退出），Streamable HTTP 不受影响。
- [x] MCP 管理器与 `MCPHost`：连接池、会话引用计数、引用归零后的延迟回收、`prune()` 残留清理、`shutdown()`、后台串行工作线程（等价 TS 的 `opChain`）、运行时状态（连接中 / 已连接 / 失败 + `toolCount` / `error` / `refCount`）。
      生命周期信号全部来自 core：会话打开（`Integration.createEngine` / `restoreConversationEngine` → `on_conversation_opened`）、会话关闭（`releaseSessionResources` / `deleteConversation`）、启用列表变化（`UiEvent.sessionConfigChanged(mcpEnabled)`）、宿主退出（`mcp::shutdown()`）。`set_servers_changed_sink` 接在 `main.rs`，经 `sessionConfigChanged(mcpEnabled)` 广播「该会话当前启用的 server 名列表」。
      会话级启用选择写入 `meta.json` 的 `context.mcpEnabled`（内存覆盖 + 查询结束时补写，对齐 `flushSessionMcpToMeta`）。
- [x] MCP 工具注入：`engine::all_tool_definitions(session_id)` = `tools::definitions()` + `mcp::tools_for_session(session_id)`（按会话启用列表过滤）；工具分派在 `run_tool` 里**先**判 `mcp::is_mcp_tool` 再落到 `tools::execute`（否则会掉进内置工具表的兜底分支被报成「工具不存在」）；`engine::is_known_tool` 把 `mcp__*` 也算已注册（决定 `Error executing <name>:` 前缀是否加）；并发安全按服务器给的 `readOnlyHint` 注解判定（`engine::is_tool_concurrency_safe`）。用例 `engine_tests.rs::mcp_*`。
- [x] 技能加载：`loadSkillsDir`、`frontmatterParser`、`variableResolver`、`bundledSkills`。`skills.rs` 逐字对齐四份 TS：frontmatter 子集 YAML 解析（标量 / 数组 / `|` 多行 / 引号 / 布尔 / 数字 / `~`）、`parseSkillFrontmatterFields`、描述兜底提取（首段非空文本，150 字符截断）、`paths` 归一化（只去尾部 `**`）、`arguments` 归一化；变量替换含 JS 替换串的 `$$` / `$&` 特殊模式还原（`args: "$& literal"` 是回归用例）与 `$name` 词边界；目录加载按 user → project 顺序合并、按 `realpath` 去重、只认 `<name>/SKILL.md`；内置 Skill 的参考文件首次调用时提取到 `~/.<configDir>/.skills/<name>`（`create_new` 不覆盖、`..` 逃逸被拒）。对等用例 `skillsParity.test.ts` ↔ `skills_tests.rs`（110 条断言）。
- [x] 内置命令与技能命令注册。`commands.rs` 的注册表（`register_builtin_command` / `builtin_commands`，`Description` 支持静态与按 locale 延迟求值两种形态）与 `skills.rs` 的 `register_bundled_skill` / `bundled_skills`；`ensure_builtins()` 对齐 `bundledSkills.ts` 的 模块加载 IIFE（先注册内置命令 `spin`，再注册内置 Skill `commit`，冲突的 Skill 被忽略并记 WARNING）。**已知缺口**：`spin` 命令的 `design` 分支可用（UI 据此打开设计器），`auto` / 其它分支依赖 Spin 引擎，随 M6-198 接入（当前返回一条说明消息，见 `commands.rs::spin_command_definition` 的 TODO）。
- [x] 技能目录与 `AGENTS.md` 读取。技能目录 = `<configHome>/skills/`（user）+ `<cwd>/<configDir>/skills/`（project），清单经 `skills::available_skills_section` 注入系统提示的环境段（对齐 `SystemEnvironment.ts` 的 `availableSkills`，只列 `!isHidden && userInvocable`）；`AGENTS.md` 早已由 `prompt::read_agents_md` 读入（`## Environment` 之后原样追加）。

完成判据：MCP 工具与技能在 Standalone 下与 Embedded 行为一致。

---

## M6 Spin / i18n / 会话运行时（已完成）

- [x] Spin 引擎：`spin.rs` 对齐 `src/core/spin/*`（`Types` / `Engine` / `SpinJudger` / `Runner` 的等价物 + `SpinHost` 回调边界 + `SpinLoop`/`SpinHandle`），`spin_host.rs` 是 `SpinHost` 的 Core 实现：
      读写 `spin.json`（进程级串行 + 临时文件 rename）、拓扑排序、结构校验四类问题、进度与迭代标签（`rollout` / `forEach` 的迭代语义）、子代理 prompt 与变量替换、验收判定（`{"accept": bool}` 的容错提取）；
      `run_sub_agent` 走 `Core::create_sub_agent`（Master 角色）后阻塞等 Reply 投递回父会话（用 `subagent::on_reply_delivered` 监听，带中止轮询）；`push_message` 把进度写进会话上下文**并落盘**（否则消息只到 UI、模型看不到）；`judge` 用会话实际生效的模型，取不到时回落全局 active provider。
      `/spin` 非 `design` 分支由 `engine.rs` 注入 `CommandContext::start_spin`：结构有问题 / 缺文件只发说明消息；`ready` 则改名成「Spin 设计」并**在当前线程跑完整个循环**（对齐 TS `await spinLoop(...)` 阻塞 `resolvePendingCommand` 的语义——消费循环因此不排空队列、`queryEnd` 在 Spin 结束后才发）。
      对等面 `spinParity.json`（112 条断言，`spinParity.test.ts` ↔ `spin_tests.rs`）；假 `SpinHost` 端到端 13 例 + `/spin` 分支 8 例（`spin_host_tests.rs`）。
- [x] `spinDesignDataChanged` 事件：`/spin` 跑完（含被中止）后必发一次，让打开着的设计器丢弃旧缓存重新读盘（否则它保存时会用旧内容覆盖执行结果）。用例 `spin_host_tests.rs::ready_design_*`。
- [x] i18n：locale 收敛（`hostEnvironmentProvided.locale` → `set_core_locale`，`settingsJsonUpdateRequested.uiLanguage` → `set_core_ui_language`，顺序与 `initializeCoreEvents` → 宿主环境事件一致）、`getSystemLocale`（新增 `UiRequest.systemLocaleRequested`，Standalone 下由 Core 探测一次并缓存，宿主不再为同一台机器重复起 PowerShell）。
      `onCoreLocaleChanged` 在 Standalone 下不需要新事件：宿主侧的 `tt()`（Electron 原生菜单、Spin 设计器页面）用的是**宿主进程内**的 `src/core/i18n.ts`，`primeCoreFacts` 把 core 的收敛结果灌回去（`setCoreUiLanguage(core 的 uiLanguage)` + `setCoreLocale(宿主 locale)`），本地订阅者照常被通知。
- [x] 会话运行时：`sessionRuntime`（`idle` / `waiting`）与 `sessionRuntimeChanged` 全量推送。
- [x] 会话资源与空闲判定：`SessionState::is_idle`（队列空 + 不在跑 + 不在等用户）。
- [x] 会话队列：等价物是引擎自带的会话内队列 + 单消费循环——用户消息单槽位（替换语义，见 M2 用户消息管线）、Agent 回复成列表、`SessionState.running` 对应 `markProcessing` / `isProcessing`、消费循环退出对应 `onQueueDrained`、`cancel` 对应 `cancelQueued`。Embedded 的 `SessionQueue` 本身也是会话内队列（`pendingUserMessages` / `pendingAgentMessages` 都按 sessionId 分键），没有跨会话调度，因此无需另建全局调度器。

完成判据：流水灯 / 托盘 / abort 按钮读取的状态与 Embedded 一致。

---

## M7 宿主侧收敛（已完成）

Standalone 下宿主不直接读取 core 的磁盘数据（`docs/standalone-core.md` 第 10 节）。

- [x] 对话列表元数据：改为经总线。新增 **UI → core 的请求通道**（协议升到 v2：`UiToCoreFrame.request` / `CoreToUiFrame.response`，`AssistantEventBus` 新增 `UiRequest` / `UiRequestResultMap` / `UiRequestHandlers` 与 `requestCore()` / `onUiRequests()`），宿主经 `UiRequest.conversationListRequested` 取列表（`history::load_conversation_list` 对齐 `loadConversationList`：只认 `*.meta.json`、跳过空对话但保留清空过的、按 `updatedAt ?? createdAt` 倒序；有意**不做**列表缓存——core 是磁盘的唯一写入方，现读即最新）。`ConversationManager.load()` 统一走 `coreFacts.loadConversationListForHost()`。
- [x] 会话运行时状态：`getSessionRuntimeStates` 改为经 `sessionRuntimeChanged`——宿主侧已无该函数的调用方，`ConversationManager` 缓存每次全量推送的快照并对外提供 `getSessionStatesSnapshot()`（新视图主动拉取时不再回查 core）。
- [x] 会话工作目录：`getSessionWorkspace` 改为经总线——宿主侧已无调用方，会话工作目录由 `UiEvent.userMessageSubmitted` 随带的 `workspacePath` 登记、由 `conversationContextUpdated` / `sessionWorkspace` 相关事件广播。
- [x] UI 语言：`UiRequest.uiLanguageRequested` → `config::read_ui_language()`（绕过缓存现读，字段缺失 / 非法值回落 `auto`）。宿主侧统一走 `coreFacts.readUiLanguage()`：Embedded 直接读盘，Standalone 读握手后预热的缓存（预热前回落 `auto`，与读盘失败的取值一致）。调用点 `extension.ts` / `WebViewUI.ts` / `webviewMessageHandler.ts` / `bootstrapCore.ts` 的 `readUiLanguageSync` 全部替换。
- [x] 高亮语言：`readHighlightLanguagesSync` 改为 `highlightLanguagesUsed`——宿主侧已无调用方；Standalone 下 Core 直接把新语言并入 `settings.json`（`config::merge_highlight_languages`）并上报 `highlightLanguagesUsed`。
- [x] 配置目录：`UiRequest.configHomeDirRequested` → `config::config_home()`。宿主侧统一走 `coreFacts.readConfigHomeDir()`；Standalone 下未预热时**抛错**而不是猜一个路径（配置目录是 core 的事实，猜错会让调用方悄悄写到别处）。`settingsFile.ts` 的 `writeSettingsJson` 已改用它（该写入口在 Standalone 下只剩 M7-219 未迁完的 LLM 配置保存）。
- [x] 全局配置写入口：`UIHost.updateSettingsJson` 的写改由 Core 承担。高亮语言（Core 直接落盘）、通用写入口（`UiEvent.settingsJsonUpdateRequested` → `config::update_settings_json`）、项目清单（Core 建目录时自己写）此前已完成；**最后一段 LLM 配置保存**现在也搬到了 Core：
      - 新增 `UiRequest.llmConfigSaveRequested`（载荷是 webview 的 `saveLLMConfig` 原始消息）→ `llm_config::apply_llm_config_save`：整段 mutation（provider 表重建、`providerKeyFromBaseURL`、`normalizeModelTokenLimits` 的保留/补齐、顶层默认值与 `uiLanguage` 的「变化才写 / `auto` 删除」、MCP 默认启用列表）在 Core 侧执行——它要读**磁盘上的旧 `modelConfigs`** 才能保留用户手填的 context/output，这正是 mutation 必须在这边做的原因；
      - 保存后 Core 一并返回宿主组装 `llmConfigSaved` / `setModels` 所需的事实（默认值、provider 分组、当前会话解析后的模型身份），并在解析结果与旧身份不同时同步写回会话 `meta.json`（`resolveModelRef` 的等价物）；
      - 新增 `config::replace_settings_json`：**整体替换**语义（合并补丁表达不了「删掉 `uiLanguage`」这类改动）；
      - 宿主侧 `handleSaveLLMConfig` 按 `CORE_KIND` 分派：Standalone 不再调 `updateSettingsJson`、不再自己清 core 的配置缓存、也不再自己收敛 core locale（Core 在保存时一并做掉）。
      用例 `llm_config_tests.rs`（16 条，含「保留用户手填限值」这条关键不变式）与 `standaloneBus.test.ts` 的请求往返。
- [x] 项目清单写入口：`UIHost.ensureProjectSettings` 的写改由 Core 承担——Core 建目录时写清单，`WebViewUI.onProjectConversationDirReady` 在 standalone 下直接返回（Embedded 仍由宿主写）。
- [x] 清理宿主对 core 状态变更函数的调用：`electron/main.ts::registerCoreSessionWorkspace` 原直接调 core 的 `setSessionWorkspace()`（Standalone 下那张表在 Core 进程内，这个调用是静默空操作），改为发 `UiEvent.sessionWorkspaceAssigned`——Embedded 的事件处理器转调同一个函数（行为不变），Standalone 由 `main.rs` 落到 `config::set_session_workspace`。`workspacePath` 为 `null` / 空串表示清除登记。其余宿主对 core 的 import 都是**只读纯函数**（`DEVELOPMENT.md` 第 2 节规则 9 允许），不再有状态变更调用。
- [x] 移除过渡期双投（`StandaloneEventBus.emitToCore` 只写帧；`request()` 不由 UI 调用）；
      Standalone 下 `bootstrapCore` 不注册进程内 core 侧订阅。
- [x] 用户消息入口改走总线（`WebviewMessageHandler.handleUserMessage` 发
      `UiEvent.userMessageSubmitted`，不再直接调用 `QueryEngine.submitMessage`）。

完成判据：宿主侧不存在对 core 磁盘数据的直接读取；宿主不直接调用 core 的状态变更函数；
`embedded` 路径的读取保持不变。

---

## M8 构建、打包与验证（已完成）

- [x] 构建脚本：`npm run build:core`，按目标三元组参数化（当前 `x86_64-pc-windows-msvc`）。
- [x] 产物落位：`resources/<core.resourceDir>/<arch>-<platform>/<core.binaryName>[.exe]`（名称取自 `src/config/project.json`）。
- [x] `copy-assets` 覆盖 `resources/core`；`asarUnpack` 覆盖 `dist/resources/core/**`（沿用既有规则）。
- [x] `package:app` 串联 Rust 构建；`build:all` / `dev:electron` 同步串联。
- [x] 崩溃测试：Core 进程被杀死时宿主重启并恢复接线、超限后停止重启。
- [x] 隔离测试：两个宿主实例各自一个 Core 进程，其中一个崩溃不影响另一个。
- [x] 关闭测试：退出应用时 Core 进程被正常终止（含标准输入 EOF 自退）。
- [x] 背压测试：突发帧不丢、顺序保持。
- [x] Rust 侧单测：全模块覆盖（帧编解码、总线、配置、历史落盘、工具、权限、提示词、shell 探测、LLM 双协议与流式看门狗、引擎轮次、UiEvent 分发、帧循环），共 467 项（`npm run test:core`）。
- [x] 对等测试（两实现共用同一份对照表）：权限决策 `src/test/fixtures/permissionParity.json`
      （`permissionParity.test.ts` ↔ `core-rs/src/permission_tests.rs`）、
      权限加工 `src/test/fixtures/permissionPolicyParity.json`
      （`permissionPolicyParity.test.ts` ↔ `core-rs/src/permission_tests.rs::permission_policy_matches_the_embedded_fixture`）、
      工具定义 `src/test/fixtures/toolSchemaParity.json`
      （`toolSchemaParity.test.ts` ↔ `core-rs/src/tools_tests.rs`）、
      工具结果 `src/test/fixtures/toolResultParity.json`
      （`toolResultParity.test.ts` ↔ `core-rs/src/tools_tests.rs::tool_result_parity_tests`）、
      Edit 结果 `src/test/fixtures/editResultParity.json`
      （`editResultParity.test.ts` ↔ `core-rs/src/tools_tests.rs::edit_result_parity_tests`）、
      历史链重建 `src/test/fixtures/historyChainParity.json`
      （`historyChainParity.test.ts` ↔ `core-rs/src/history_tests.rs::load_messages_matches_the_embedded_chain_fixture`）、
      JS 语义 `src/test/fixtures/jsParity.json`
      （`jsParity.test.ts` ↔ `core-rs/src/tools_tests.rs::js_parity_tests`，
      覆盖 `formatFileSize` / `generateHeadTailPreview` / Bash `validateInput`）、
      路径展开 `src/test/fixtures/pathParity.json`
      （`pathParity.test.ts` ↔ `core-rs/src/tools_tests.rs::path_parity_tests`，
      覆盖 `~` 展开 / 词法规范化 / 尾随分隔符 / Windows 的 WSL、`/c/...`、UNC、
      当前盘根路径与不完整 UNC）、
      系统提示词静态部分 `src/test/fixtures/systemPromptParity.json`
      （`systemPromptParity.test.ts` ↔ `core-rs/src/prompt_tests.rs::system_prompt_parity_tests`，
      覆盖核心身份 / `## Tool Usage` + `## Tool Details` / 极简预设）、
      权限决策随机表 `src/test/fixtures/permissionFuzzParity.json`
      （`permissionFuzzParity.test.ts` ↔ `core-rs/src/permission_tests.rs::fuzz_parity_tests`，
      固定种子生成 420 条命令分词 / 引号 / 转义 / 空白组合）。
      任一侧偏离对照表即失败；有意保留的差异见 `DIFF.md`，未迁入项登记在
      对照表的 `divergences` 里。
- [x] JS 空白口径统一（U+0085 / U+FEFF）：`util::js_trim` / `util::is_js_whitespace` 显式实现
      ECMAScript WhiteSpace + LineTerminator，替换掉 `permission` / `tools` / `history` / `prompt` /
      `tool_input` / `engine` 里会与 JS 相反的 Rust `trim` / `split_whitespace`。
      权限对照表新增 `git<U+0085>status` / `git<U+FEFF>status` / `echo hi;<U+0085>` 等只读分词用例，
      JS 语义对照表新增 `"\u0085"` / `"\uFEFF"` 的 Bash `validateInput` 用例；
      Rust 另有 `util::tests::js_trim_follows_ecmascript_whitespace` 与
      `tools::tests::bash_validate_input_uses_js_whitespace` 直接锁集合。
- [x] 工具边界对齐：Read 目标是目录时报 Embedded `isbinaryfile` 的 `Path provided was not a file!`；
      Edit 目标文件不存在时报 Node `fs.readFile` 的 `ENOENT: no such file or directory, open '<path>'`；
      Write 的 `permResult.afterContent` 原样保留入参类型（数字 / 布尔 / 对象不 stringify，
      只有 `displayArgs` 预览字段用 `String()` 文本化），对照表新增 `write-non-string-content-zero` /
      `write-object-content`。
- [x] ripgrep 调用对齐：不再给 rg 设置 `current_dir`（与 Embedded 一样继承进程工作目录），
      含 `/` 的 `--glob`（如 `sub/*.txt`）两实现结果一致；去掉 Standalone 多传的 `--color` / `--`，
      失败文案与 Node `execFile` 的 `Command failed: <cmd> <args>\n<stderr>` 逐字一致
      （对照表新增 `glob-relative-subdir` / `grep-relative-glob-subdir`，
      Rust 另有 `tools::tests::grep_failure_matches_node_exec_file_message`）。
- [x] ripgrep stdout 解析对齐 Embedded `utils/ripgrep.ts` 的
      `stdout.trim().split('\n').filter((line) => line.length > 0)`：先按 JS 空白口径
      trim 整个 stdout（rg content 输出会带出匹配行的尾随空格，此前 Rust 的 `.lines()`
      不会去掉），再按 `\n` 切分（CRLF 文件里中间匹配行的 `\r` 原样保留，`.lines()`
      会吃掉）。用例 `tools_tests.rs::ripgrep_lines_matches_embedded_stdout_trim_and_split`。
- [x] 路径展开对齐 Node `path.isAbsolute` / `path.normalize` 的平台语义（对照表 `pathParity.json`）：
      Windows 上「单个分隔符开头」的路径（`/tmp/x`）是**当前盘根路径**而不是相对路径，
      Rust `Path::is_absolute` 认不出来，此前会拼上会话工作目录；不完整 UNC（`//tmp`）按
      Node 退化成根路径，合法 UNC（`\\server\share`）只到 share 时补尾随分隔符；
      `path.normalize` 保留绝对路径的尾随分隔符（`C:\a\b\` / `/a/b/`），此前被 Rust 的
      词法规范化丢掉。Glob 的 `path.isAbsolute(pattern)` 分支同步改用
      `tools::is_absolute_like_node`，`/tmp/*.txt` 这类绝对 glob 两实现拆分一致。
      同时修掉 WSL 分支的按字节切片（`path[..5]` 比较 `/mnt/`）：9 字节以上的纯中文
      路径在第 5 个字节不是字符边界时直接 panic、会让 Core 进程崩溃；改为字节比较，
      对照表新增多字节相对 / 绝对路径用例，Rust 另有
      `tools::tests::expand_path_handles_multibyte_paths_without_panicking`。
- [x] 删除会话递归清理子对话：Embedded `deleteConversation` 沿 `parentSessionId` 传递闭包
      删除所有层级的子孙会话（文件 / 归档 / `tool-results`），Rust 此前只删当前会话，
      子对话会残留；现 `history::conversation_closure` 复刻同一闭包规则（先删子孙再删自己）。
- [x] 系统提示词静态部分逐字对齐：对照表 `systemPromptParity.json` 锁定核心身份、
      `## Tool Usage` 工具清单与 `## Tool Details` 逐工具详细用法、极简预设；
      Read 窗口限制（offset/limit / 2000 行 / 2000 字符 / 50KB / 256KB 预检 / CRLF / 尾随空行）
      新增 10 条 `toolResultParity.json` 用例。有意保留的差异（TS bug / Rust 更健壮）集中登记在
      新增的 `DIFF.md`。
- [x] Rust 侧覆盖率：`npm run coverage:core` 用 `-C instrument-coverage` + `llvm-tools` 度量，行覆盖 93.6%、函数 91.3%、区域 92.5%（`--check 80` 可作门槛）；测试代码不计入统计。
- [x] Core 引擎端到端：本地假 LLM + 真实产物跑通「新建会话 → 用户消息 → 流式回复 → 落盘 → 第二轮带上历史」；`standaloneCoreEngine.test.ts` 另覆盖「磁盘上只有 tool_use 的崩溃现场 → 恢复结果先于新用户消息落盘、parentUuid 接链、messageCount 计入」与「冒号结尾触发 reminder 追问时只有一对 queryBegin/queryEnd（消费循环级事件，对齐 Embedded `submitMessage` / `finalizeIdle`）」。
- [x] 开发期 watch：`scripts/watch-app.js` 在前端 watcher 之外增加 Rust 重建轮询——监听
      `core-rs/src/**/*.rs` 与 `core-rs/Cargo.toml` 的 mtime，变化时（去抖 800ms）跑一次
      `npm run build:core`；不在启动时构建（源码没动就不白等一次 release 构建）；
      与前端 watcher 解耦（不进 `watchers` 数组，构建失败只打日志，不触发「任一 watcher 退出则整体退出」）；
      `WATCH_CORE=0` 可关闭，Rust 侧改动也可手动 `npm run build:core` 重建（README 已补说明）。
- [x] 对等测试：同一串 `UiEvent` 在两种实现下产出同一串 `CoreEvent`。新增 `src/test/coreEventParity.test.ts`：同一串脚本化 `UiEvent`（宿主环境 → 活动工作目录 → 新建会话 → 打开会话 → 用户消息）分别喂给进程内 Embedded Core 与真实 Rust 产物，两边都指向同一个本地假 LLM，断言（1）产生同一**组** `CoreEvent`、（2）查询生命周期（`queryBegin` / `aiBegin` / `streamMessage` / `streamEnd` / `aiEnd` / `queryEnd`）的**相对顺序**一致、（3）两边都推了会话运行时快照且收尾回到空闲。
      **它抓出了两处真实偏差**：① Rust 把 `queryEnd` 发在 `sessionRuntimeChanged` **之前**（Embedded 相反），会让托盘/流水灯的收尾晚一拍——已修正；② 落盘驱动的事件（`conversationListChanged` / `projectConversationDirReady`）插入位置不同，根因是 Embedded 的 `startPersist` 是 fire-and-forget、Rust 在调 LLM 前同步落盘；这一条**有意保留**（同步落盘让崩溃现场更可预测），登记在 `DIFF.md` 第 3.3 节。此外 Rust 会多推一次全量快照 `sessionRuntimeChanged`（幂等），比较时单列断言。
- [x] 端到端（不含真实 LLM 凭据）。五段分别落在四个文件里，全部用本地假 LLM 冒充 OpenAI Chat Completions：
      - 用户消息 → 流式回复 → 落盘：`standaloneCoreEngine.test.ts`（另覆盖崩溃恢复与 reminder 追问只有一对 `queryBegin`/`queryEnd`）；
      - 工具执行：`standaloneCoreTools.test.ts`（真实产物 + 真实文件系统）、`standaloneCorePermission*.test.ts`（权限往返与预览）；
      - **重启续读**：`standaloneCoreRestart.test.ts`——第一轮跑完后**直接杀掉** Core 进程（不发 `shutdown`，模拟崩溃），用同一个 HOME 起新进程，断言对话列表能从磁盘读到该会话、且第二轮 LLM 请求里带上第一轮的用户消息与助手回复（角色序列 `user → assistant → user`）。
      **有意不覆盖**：真实 LLM（需要 API 凭据，不进自动化）与真实宿主（Electron / VS Code 的启动由 `standaloneBootstrap.test.ts` + `bootstrapWiring.test.ts` 覆盖接线，端到端人工验证走 `npm run package:app`）。
- [x] 文档同步（随各里程碑滚动更新）：`DEVELOPMENT.md` 第 13.2 节的现状表已按当前实现更新（内置工具含后台 Bash / 子代理 / AskUserQuestion、并行工具批、配置读写、子代理单列一行）；`docs/standalone-core.md` 第 1.1 节与第 10 节的「未迁入 / 来源」表已按实际落地状态改写，并注明「待改」的三项（对话列表 / UI 语言 / 配置目录）需要 UI → core 的请求通道，而同机部署下直接读盘仍然成立（规格第 11 节把跨机器列为不覆盖范围）。M2–M7 全部落地后再做一次收尾校对。

完成判据：`npm run package:app` 产出的安装包内含 Rust Core，Standalone 模式可跑通全流程。

---

## 已知缺口（Standalone 下暂不可用）

Core 进程已接管会话引擎、内置工具、会话落盘与配置读取；以下能力尚未迁入，
在 Standalone 装配下表现为缺失或提示消息：

| 能力 | 表现 |
| --- | --- |


| i18n 的宿主侧文案 | `tt()` 只覆盖 core 层文案（命令描述、Spin 提示）；宿主进程内的原生文案（Electron 菜单、设计器页面）用的是宿主自己那份 `src/core/i18n.ts`，由 `primeCoreFacts` 按 core 的收敛结果灌值 |
| Responses API 的内置 Web Search | `apiType='Responses'` 已可用，但不下发内置 `web_search` 工具，模型不会自动联网搜索（搜索卡片事件 `web_search_call` 也未迁入） |
| Grep content 模式路径 | 输出里的文件路径口径与 Embedded 不同（有意保留） |
| Edit `displayArgs.diffHunks` | Embedded 的 `PermissionPolicy` 预计算紧凑 diff hunks；Standalone 不下发该键，改为额外下发 `beforeContent` / `afterContent`，webview 用同一份 `buildEditDiffHunks`（同一算法、同一入参）在 `EditFile.tsx` 回退计算，渲染结果一致。代价是这一帧体积更大（整份内容 vs 紧凑 hunks）；`permResult` 与 tool_use `_meta` 的 diff 字段已与 Embedded 对齐 |
| Anthropic 流内 `signature_delta` / `error` 事件 | Embedded 的 `RealApi` 两条都没处理（thinking 的 signature 只取 `content_block_start` 初值，SSE `error` 帧被静默忽略）；Standalone 会把 `signature_delta` 累积进 thinking block 的 `signature`、并把 `error` 帧当流错误上报。这是有意保留的更稳健行为（Anthropic 扩展思考要求历史 thinking block 带 signature；静默吞掉流错误会产出空回复） |
| Anthropic `baseURL` 拼接 | Embedded 的 `RealApi` 直接拼 `${baseURL}/v1/messages`；Standalone 会去掉尾部 `/`、且 `baseURL` 已以 `/v1` 结尾时不再重复拼 `/v1`（与 OpenAI 的 `joinV1Path` 口径统一）。baseURL 带 `/v1` 时 Embedded 会请求 `/v1/v1/messages`，Standalone 请求 `/v1/messages`。这是有意保留的更稳健行为（用户把 baseURL 配成 `.../v1` 时 Standalone 仍可用） |
| 对话空间统计 | `requestConversationSpaces`（设置面板「对话空间」页的占用统计）**未迁入 Core**：Standalone 下宿主仍 bundle 并执行 `src/core/history/ConversationSpace.ts` 的 `getConversationSpaces`，直接读 `conversations/` 目录。清空路径（`conversationSpaceCleared`）已迁入 Core。同机部署结果一致，跨机器部署需补一条 UI → core 请求通道。详见 `DIFF.md` 第 3.0 节 |

宿主侧已无对 core 磁盘数据的直接读取：对话列表 / UI 语言 / 配置目录都经新增的
UI → core 请求通道（协议 v2）向 Core 索取，高亮语言与项目对话目录走 Core 的推送事件。
**例外**：对话空间统计（见上表）仍由宿主直接读盘。
同机部署下 Core 与宿主读写同一份磁盘格式，跨机器部署时这些读取必须改为总线事实
（规格第 11 节把跨机器列为不覆盖范围）。

---

## 预留（构建目标与产物目录已登记，产物未产出）

- [x] Windows arm64（`aarch64-pc-windows-msvc`）：产物目录 `resources/core/arm64-win32/` 与构建目标已登记（`scripts/build-core.mjs` 的 `TARGETS`），运行时按 `<arch>-<platform>` 解析，矩阵一致性由 `src/test/corePlatformMatrix.test.ts`（44 条断言）锁定。
      **实际未产出**：`rustup target add aarch64-pc-windows-msvc` 之后构建会停在 `ring`（`reqwest` 的 `rustls-tls` 依赖）的自定义构建脚本上，报 `failed to find tool "clang"`——`ring` 含 ARM64 汇编，交叉编译需要 LLVM/clang 与 ARM64 的 MSVC 链接器。详见 `docs/standalone-core.md` 第 4.3 节。
- [x] Linux x64（`x86_64-unknown-linux-gnu`）：产物目录 `resources/core/x64-linux/` 与构建目标已登记并由矩阵测试锁定。**实际未产出**：当前环境未安装该 GNU 目标与对应的交叉链接器（详见 `docs/standalone-core.md` 第 4.3 节）。
- [x] Linux arm64（`aarch64-unknown-linux-gnu`）：产物目录 `resources/core/arm64-linux/` 与构建目标已登记并由矩阵测试锁定。**实际未产出**：同上（详见 `docs/standalone-core.md` 第 4.3 节）。
- [x] 平台差异模块审查：逐项核对进程管理 / 路径处理 / shell 探测 / 资源定位，结论与落点已列表登记在 `docs/standalone-core.md` 第 4.2 节。要点：
      - 进程管理：`bash_task::kill_tree` 与 `mcp.rs` 的子进程终止都用 `#[cfg(windows)]` 走 `taskkill /T /F`；**非 Windows 分支只杀直接子进程，与 Embedded 逐字对齐**（Node 的 `detached: true` + `childProcess.kill()` 同样不覆盖孙进程）——不是缺口，是刻意的行为对等；
      - 路径处理：盘符 / UNC 换算都在 `cfg!(windows)` 分支内，非 Windows 走 POSIX 分支（多字节路径按字节比较，见 M3 的 `expand_path` 修复）；
      - shell 探测：非 Windows 直接用 `$SHELL`（缺省 `/bin/bash`），Windows 才走 Git Bash → PowerShell → cmd.exe；
      - 资源定位：可执行名按 `cfg!(windows)` 加 `.exe`，产物目录按 `<arch>-<platform>` 解析、矩阵外直接拒绝；
      - 主目录（`USERPROFILE` 优先、`HOME` 兜底）、系统语言（仅 Windows 查 PowerShell）、控制台窗口（仅 Windows 设 `CREATE_NO_WINDOW`）同样都已分平台。

---

## 未定项

- [x] 跨机器部署的传输形态：**本规格不覆盖**（`docs/standalone-core.md` 第 11 节）。
      已核实并记录在本清单：宿主侧不再直接读 core 的磁盘数据（第 10 节的三项「待改」
      已全部经 UI → core 请求通道完成），因此把传输从本机管道换成网络通道时，
      契约与磁盘格式都不需要改动；真正的未定项是**传输形态本身**（帧通道目前假定
      本机 stdin/stdout，没有认证、没有重连、没有多宿主复用），这属于产品决策而非
      移植工作。

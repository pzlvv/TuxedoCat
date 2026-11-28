---
owner: pzlvv
last_reviewed: 2026-11-28
---

# 规格：LLM 请求载荷

本规格描述 Core 组装的 LLM 请求载荷：会话里的内部消息如何变成三种协议的线格式、哪些内容块
参与回传、哪些字段只服务 UI。协议适配器在 `core-rs/src/llm.rs`（Anthropic Messages 与
Chat Completions）和 `core-rs/src/responses.rs`（Responses API）；消息从用户输入到进入
上下文的链路见 [docs/features/user-message-pipeline.md 第 3 节](../features/user-message-pipeline.md#3-行为规格)。

## 1. 消息组装

引擎每轮请求前用 `build_llm_messages_from` 把落盘消息转成线格式消息，三步固定顺序：

| 步骤 | 实现 | 作用 |
| --- | --- | --- |
| 取会话轮次 | `build_raw_api_messages` | 只保留 user / assistant；字符串 content 按文件上下文补前缀；数组 content 剔除 UI 专用字段 |
| 补思考占位 | `ensure_thinking_blocks` | assistant 消息缺 thinking block 时补一个空占位，与当前是否开启思考无关 |
| 合并同角色 | `merge_consecutive_same_role` | 连续同角色的多条消息合并成一条，满足 Anthropic 的 user / assistant 交替要求 |

补占位发生在合并之前，因此合并后的消息里每条原消息各自带一个占位。理由：工具执行中途把
思考从关闭切到开启时，历史 assistant 缺 thinking block 会让服务端拒绝整轮请求。

## 2. 思考回传

历史 assistant 的思考内容参与请求，三条协议的形态不同：

| 协议 | 线格式 | 空思考（占位） |
| --- | --- | --- |
| Anthropic Messages | `thinking` block 原样下发，带 `signature` | 照常下发空 block |
| Responses API | 顶层 reasoning item，正文取思考文本 | 跳过，不生成空 item |
| Chat Completions | assistant 消息的 `reasoning_content` 字段 | 不写该字段 |

Chat Completions 侧的字段只在思考文本非空时出现：多个 thinking block 按出现顺序拼接成
一个字符串。思考模式下的续轮（尤其带工具调用的那一轮）若丢掉推理文本，DeepSeek / Moonshot
这类服务商会以「思考模式下的推理内容必须回传」拒绝请求；反过来，在没有推理可回放时多发一个
空字段只会招惹严格校验的网关。

Responses API 的 reasoning item 不带随机 id：请求前缀逐字节稳定才能保住提示缓存命中。

## 3. Chat Completions 的 assistant 形态

| 输入内容块 | 线格式 |
| --- | --- |
| 只有 text | `content` 为拼接后的字符串 |
| 有 tool_use | `content` 恒为字符串（无正文时是空串，不是 `null`），`tool_calls` 列出全部调用 |
| 有 thinking | 非空文本进 `reasoning_content`，不进 `content` |
| 只有 thinking | 不成条（没有正文也没有工具调用，服务端不会为它校验推理字段） |

`content` 恒为字符串：部分网关对 `content: null` 直接拒绝，空串是「没有正文」的通用表示。

逐例形态由对照表 `core-rs/fixtures/chatCompletion.json` 锁定，Rust 侧
`llm_tests.rs` 的对照表用例断言实时输出 == 对照表，另有
`chat_messages_convert_tool_use_and_thinking` /
`chat_messages_replay_reasoning_content_only_when_non_empty` /
`chat_messages_tool_use_only_sends_empty_content_not_null` 覆盖空思考与非空思考两类边界。

## 4. 不参与请求的字段

content block 上只服务 UI / 内部流程的字段在请求载荷里剔除（`NON_LLM_BLOCK_FIELDS`）：
`_meta`、`_partialJson`、`beforeContent`、`afterContent`、`contextBefore`、`contextAfter`。
`beforeContent` 可能是整份文件内容，留在请求里会把上下文撑大若干倍；落盘消息保持原样。

非多模态模型的请求出口另行过滤全部图片（用户消息的 image 块与 tool_result 内的 image 部分），
过滤只作用于请求副本：会话落盘与历史回显保留完整图片。

## 5. 事实归属

| 事实 | owner | 说明 |
| --- | --- | --- |
| 线格式转换与字段取舍 | Core（`core-rs/src/llm.rs` / `core-rs/src/responses.rs`） | 宿主不复刻，也不在转发时二次改写 |
| 协议选择 | Core（`ProviderConfig.api_type`） | 宿主经配置快照下发，不按 URL 嗅探 |
| 思考强度 | Core（会话级 `thinking_effort`） | 落盘字段名是 `thinkingMode`，见 [docs/architecture/events.md 第 2.3 节](../architecture/events.md#23-uieventui--core单向) |

---
owner: pzlvv
last_reviewed: 2026-11-25
---

# 规格：工具结果上限

本规格描述 Core 对工具结果的长度约束：哪些工具共用一套上限、`Read` 为什么走自己的窗口，
以及超限时进入上下文与 UI 的文本形态。工具清单、入参与执行分支在
`core-rs/src/tools.rs`；Read 与 Edit / Write 的时效契约见
[docs/core/tool-read-guard.md](tool-read-guard.md)；宿主侧的渲染与信封解析见
[docs/hosts/webview-ui.md 第 11 节](../hosts/webview-ui.md#11-消息区视图行为)。

## 1. 能力

模型永远拿到一段**有界**的工具结果：单次调用的输出不会把上下文撑爆，超限部分要么落盘并给出
预览，要么由工具自己的窗口截断。窗口截断必须给出可继续的入口，且同一段内容不会同时以
「窗口」和「落盘副本」两种形态存在。

## 2. 统一上限（Bash / Grep / Glob / WebSearch / WebFetch / 子代理等）

| 项 | 口径 |
| --- | --- |
| 阈值 | `MAX_RESULT_SIZE_CHARS`（4K，按 UTF-16 code unit 计，对齐 JS `.length`） |
| 未超限 | 结果原样进入工具结果与 UI |
| 超限 | 完整内容写入 `<projectConversationDir>/tool-results/<sessionId>__<taskId>.txt`，结果文本替换成 `<persisted-output>` 信封 |
| 信封形态 | 表头 `Output too large (NKB). Full output saved to: <path>` + `Preview (first 2K + last 2K):` + 预览正文；预览保留头尾各 `TOOL_RESULT_HEAD` / `TOOL_RESULT_TAIL` |
| 落盘失败 | 不丢内容：退化为「前 2K + 后 2K」预览，并在 stderr 记一行 |
| 落盘副本上限 | `MAX_PERSISTED_SIZE`（64MB），超出部分追加截断说明；副本随会话删除一并清理 |

信封的解析只有一份实现（`src/webview/persistedOutputParse.ts`），宿主与 TUI 原样转发结果文本，
不二次截断。

## 3. Read 的窗口（10K，不落盘）

`Read` 是唯一不经过第 2 节上限的工具：它的结果本身就是一段**完整窗口**，续读入口在窗口末尾的
footer 里，落盘副本给不出任何模型看不到的内容。

| 项 | 口径 |
| --- | --- |
| 结果上限 | `READ_MAX_RESULT_CHARS`（10K，按 UTF-16 code unit 计） |
| 预算包含 | `N\|` 行号前缀、正文与续读 footer 都算在内；footer 另按 `READ_FOOTER_RESERVE_CHARS` 预留，保证整段不越界 |
| 截断位置 | 整行边界：不切半行，也不切代理对。单行先受 `READ_MAX_LINE_CHARS` 约束（截断后仍带标记，远小于 10K），因此预算截断总能落在某一行之前 |
| 续读 footer | `(Output capped. Showing lines a-b of c. Use offset=d to continue.)`；`Output capped.` 只在结果预算截断时出现，行数上限与入参 `limit` 不触发该前缀 |
| 行数上限 | 不设独立的行数上限：窗口由 10K 预算决定（`offset` / `limit` 的 `limit` 上界是 `READ_MAX_LINES`，超过按入参错误返回） |
| 单行长度 | `READ_MAX_LINE_CHARS`（超长行截断并追加 `... (line truncated to N chars)`） |
| 落盘 | 不落盘，原样作为工具结果；`cap_tool_result` 对 `Read` 不做裁剪，越过上限属接线漂移（debug 构建断言） |
| 整文件预检 | 未传 `limit` 时文件大于 `READ_MAX_SIZE_BYTES`（256KB）直接报错并提示用 `offset` / `limit`；xlsx / 图片分支豁免 |
| 图片 | 上限 `READ_MAX_IMAGE_BYTES`（15MB），以 image content block 返回，不进文本管线 |

同一套窗口渲染供文本与 xlsx 共用（`render_read_window`）：xlsx 先格式化成 `Row N: ...` 文本，
再按单行长度与结果上限选出窗口。

## 4. 事实归属

| 事实 | owner | 说明 |
| --- | --- | --- |
| 上限常量与截断规则 | Core（`core-rs/src/tools.rs`） | 宿主不复刻，也不在转发时二次裁剪 |
| 落盘副本 | Core | 写入点只有 `persist_large_output`；删除随会话清理 |
| 信封解析与渲染 | UI（`src/webview/persistedOutputParse.ts`） | 只解析、不生成 |

## 5. 测试落点

| 覆盖 | 落点 |
| --- | --- |
| 统一上限按 UTF-16 计、Read 不落盘 | `core-rs/src/tools_tests.rs` 的 `cap_tool_result_*` |
| Read 窗口：行号、`offset` / `limit`、单行截断、10K 整行截断 | `core-rs/src/tools_tests.rs` 的 `read_*` |
| 工具结果文本对照表（含两个 Read 上限用例） | `core-rs/fixtures/toolResult.json` 与 `tools_tests.rs` 的 `tool_result_parity_tests` |
| 端到端：超限 Read 不产生 `tool-results/` 副本 | `core-rs/src/engine_tests.rs` 的 `read_results_are_not_persisted_to_disk` |

---
status: 已收敛
---

# 改动规格：联网搜索改为客户端工具（DeepSeek Search / Fetch API）

把联网搜索从「Responses 接口的 server 端内置 `web_search`」改为 Core 进程内的两个
客户端工具 `WebSearch` / `WebFetch`（DeepSeek Search / Fetch API，`POST
https://api.deepseek.com/v1/tools/search|fetch`，与模型 API 同一 Bearer 鉴权）。工具
随会话的联网搜索开关注入，任何 apiType（OpenAI Chat Completions / Anthropic /
Responses）的模型都能调用；随「仅 Responses 协议支持联网搜索」一起存在的 UI 禁用与
提示删除。Responses 请求不再拼装 server 端 `web_search` 工具及其附属逻辑（会话轮的
usage 剔除、`web_search_call` 流式事件的适配残留）。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/core/standalone-core-boundaries.md](../../docs/core/standalone-core-boundaries.md) | [第 4 节 不覆盖范围](../../docs/core/standalone-core-boundaries.md#4-不覆盖范围) | 修改 | 删除「Responses API 的内置 Web Search」已知缺口行：联网搜索以客户端工具落地 |
| [docs/architecture/core-ui-separation.md](../../docs/architecture/core-ui-separation.md) | [第 4.3 节](../../docs/architecture/core-ui-separation.md)（配置快照字段表） | 修改 | `llm.webSearch` 的语义由「Responses 内置搜索开关」改为「WebSearch / WebFetch 工具注入开关」，字段与默认值不变 |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | US-8 功能开关菜单、US-24 默认设置 | 修改 | 「联网搜索」开关语义改为工具注入（验收条目措辞随改，不新增验收点）；US-24 的默认值条目同步措辞 |
| `<docs/features/web-search.md>` | — | 新增 | 落地后新增特性规格：工具行为、鉴权、开关语义、卡片展示（独立成篇：跨 Core / 设置 / 卡片三个 surface） |

## 用户场景与验收标准

- 场景 1：任意协议的模型联网搜索
  - **AC-1**（FR-001）：GIVEN 活动服务商为 `apiType='OpenAI'`（或 `'Anthropic'`）且会话联网搜索开启 WHEN 模型发起 `WebSearch` 工具调用 THEN Core 以 DeepSeek Search API 执行并把结果作为工具结果回给模型，会话不中断
  - **AC-2**（FR-001）：GIVEN 会话联网搜索关闭 WHEN 本轮 LLM 请求组装工具清单 THEN `WebSearch` 与 `WebFetch` 均不出现在下发的工具定义里
  - **AC-3**（FR-002）：GIVEN 模型发起 `WebFetch` 工具调用且 URL 合法 WHEN Core 执行 THEN 返回该页的标题与 Markdown 正文作为工具结果
- 场景 2：设置与开关不再受协议限制
  - **AC-4**（FR-004）：GIVEN 活动服务商的默认模型 `apiType` 不是 `'Responses'` WHEN 打开设置面板的 LLM 配置页 THEN 联网搜索复选框可交互、不置灰，提示文案不再出现「只有 Responses 协议支持」
  - **AC-5**（FR-004）：GIVEN 会话提示词模式为极简（minimal）WHEN 打开输入区功能菜单 THEN 联网搜索开关仍为禁用（极简模式限制保留，与协议无关）
- 场景 3：卡片与错误
  - **AC-6**（FR-005）：GIVEN 会话联网搜索开启 WHEN 模型调用 `WebSearch` / `WebFetch` THEN 时间线渲染搜索卡片（查询词）与抓取卡片（URL），成功 / 失败状态与既有工具卡片同口径
  - **AC-7**（FR-003）：GIVEN 未配置 `api.deepseek.com` 服务商 WHEN 模型调用 `WebSearch` 或 `WebFetch` THEN 工具结果返回明确错误（指明未配置 DeepSeek 服务商），会话不中断、不静默
  - **AC-8**（FR-003）：GIVEN Search / Fetch 返回 4xx / 5xx 或网络错误 WHEN Core 收到错误响应 THEN 工具结果包含状态码与简短原因（含可重试类错误的提示），本次调用不自动重试

## 功能需求

### FR-001：WebSearch 工具（DeepSeek Search API）

Core 内置只读工具 `WebSearch`：入参 `query`（必填，1–128 Unicode 字符，去除首尾空白
后非空）与 `count`（可选，1–50，缺省 10）。执行 `POST
{DEEPSEEK_BASE_URL}/v1/tools/search`，请求体 `{query, count, need_content: false}`；
响应 `results` 为空时返回「无结果」文本。工具结果按结果条目逐条给出 `rerank_score /
title / url / snippet / summary / site_name / date`（缺失字段省略），正文不返回——
模型需要正文时自行调用 `WebFetch`。`query` 中的搜索语法（`site:` / `lang:` /
`after:` 等）原样传递给搜索服务。

### FR-002：WebFetch 工具（DeepSeek Fetch API）

Core 内置只读工具 `WebFetch`：入参 `url`（必填；HTTP/HTTPS、含 host、不含用户名
密码、长度 ≤8192，不合法直接以工具错误返回、不发请求）。执行 `POST
{DEEPSEEK_BASE_URL}/v1/tools/fetch`，请求体 `{url}`；返回 `title`（缺失为空字符串）
与 `content`（Markdown 正文）。超长正文按工具输出上限截断并在结果尾部注明截断。

### FR-003：鉴权、错误与超时

两个工具的鉴权复用 DeepSeek 服务商的 apiKey：取配置快照里 baseURL host 为
`api.deepseek.com` 的 provider（与余额查询同一解析口径）；未配置时返回工具错误
「未配置 api.deepseek.com 服务商」。HTTP 层：请求带 `Authorization: Bearer <key>` 与
`Content-Type: application/json`；整体超时 30 秒；错误响应（OpenAI 兼容 error 格式）
与网络错误一律转成工具错误文本，包含 HTTP 状态码与 `error.message`（无响应体时给
原因短语）；402（余额不足）单独注明「账户余额不足」。不自动重试——错误文本附
「可稍后重试」提示（408/429/5xx），模型可自行决定再次调用。工具失败不中断会话，
按既有工具错误口径落 `toolResult`（status fail）。

### FR-004：开关语义与 UI 限制删除

联网搜索的生效判定不变：会话覆盖（消息随带 / `sessionConfigChanged` 的
`webSearch`，落 meta.json `context.webSearch`）优先，缺省回 `settings.json` 的
`llm.webSearch`（默认 true）。生效时 `WebSearch` 与 `WebFetch` 进入本轮 LLM 请求的
工具清单（仍受提示词模式白名单约束——极简模式本就不含这两个工具），未生效时不出
现。设置面板 LLM 配置页的联网搜索复选框删除「仅 Responses 协议可用」的置灰与提示
（webSearchDisabledHint 文案与判定逻辑删除）；极简提示词模式下的开关禁用（输入区
功能菜单）保留。Responses 请求不再拼装 server 端 `web_search`：相关的工具剥离、
联网轮的 usage 剔除（webSearchUsed）及其测试与对照表条目删除。

### FR-005：卡片展示

`WebSearch` 调用渲染为既有搜索卡片（显示查询词），`WebFetch` 调用复用同一卡片组件
的「打开网页」形态（显示 URL）。两者进行中 / 成功 / 失败的表现与既有工具卡片一致；
不再出现 Responses 专有的 `web_search_call` 流式事件适配。

## 边界与错误路径

- `query` 全空白或超 128 字符：工具校验错误，不发请求。
- `count` 越界（<1 或 >50）：按 API 侧 400 报错口径透传（不做本地钳制）。
- `url` 不合法（非 HTTP/HTTPS、无 host、带 userinfo、超长）：工具校验错误，不发请求。
- 未配置 DeepSeek 服务商：工具错误，指明配置路径（服务商 baseURL 须为
  `api.deepseek.com`）。
- 请求超时 / 连接失败 / 5xx / 429：工具错误（含状态码或原因），不重试、不中断会话。
- 会话联网搜索关闭：两个工具不出现在工具清单（模型无从调用），已有进行中会话在
  下一轮请求即生效（不追溯中止已发出的调用）。
- 多会话并发：工具为无副作用的网络请求，按并发安全工具调度（与 Read / Grep 同类）。
- 鉴权 key 只用于请求头，不进日志、不进工具结果。

## 非目标

- 不做搜索结果缓存、去重或自动多轮检索编排（模型自行决定是否再搜 / 抓取）。
- 不做自动重试与限速退避（错误文本提示可重试，由模型决定）。
- 不引入新的总线事件 / wire 消息（复用 `toolCall` / `toolResult` / `toolArgsUpdated`）。
- 不改 `llm.webSearch` 字段名、默认值与 meta.json 落盘格式。
- 其它服务商的搜索 / 抓取端点（当前仅 DeepSeek 官方域）。

## 对需求基线的影响

- US-8「功能开关菜单」：菜单项「联网搜索」的语义条目随 FR-004 措辞更新（开关 =
  工具注入），无新增验收点。
- US-24「默认设置」：联网搜索默认值条目措辞同步（删除 Responses 限定）。
- 新增 US-50「联网搜索与网页抓取（客户端工具）」登记于 user-stories，e2e 覆盖按
  既有口径：webview 侧由 LLMConfigPanel 置灰删除的既有 e2e（settings.spec）改写；
  Core 侧行为由 Rust 单测（工具执行、鉴权解析、错误透传）与既有 standalone 工具
  链路测试覆盖，整链联网调用不进 e2e（外网依赖，登记豁免）。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/web_search.rs::run_web_search` | `core-rs/src/web_search_tests.rs`（校验 / 请求体 / 拼装 / 空结果） | 自动 |
| FR-002 | `core-rs/src/web_search.rs::run_web_fetch` | `core-rs/src/web_search_tests.rs`（URL 校验 / 请求体 / 拼装） | 自动 |
| FR-003 | `core-rs/src/web_search.rs`（key 解析复用 `balance.rs`，错误映射） | `core-rs/src/web_search_tests.rs`（未配置 / 402 / 429 / 超时；本地一_shot 假服务器） | 自动 |
| FR-004 | `core-rs/src/engine.rs`（工具清单过滤）、`src/webview/LLMConfigPanel.tsx`（删置灰） | `core-rs/src/engine_tests.rs::web_tools_follow_the_web_search_flag`；`e2e/webview/settings.spec.ts` | 自动 |
| FR-005 | `src/webview/MessagesView.tsx` / `src/webview/tools/WebSearch.tsx` | `e2e/webview/settings.spec.ts`（随 US-50 回归） | 自动 |

## 待澄清

（无未决问题。）

## 收敛记录

- 已满足：AC-1 → `core-rs/src/web_search_tests.rs::post_request_parses_success_json` /
  `format_search_results` 系（请求构造与结果拼装）；工具进入清单由
  `engine_tests.rs::web_tools_follow_the_web_search_flag`（apiType=OpenAI 的假 LLM）
  锁定；真实外网调用不进测试（US-50 豁免口径）。
- 已满足：AC-2 → 同上引擎用例（webSearch=false 时名单不含两工具，Bash/Read 不受影响）。
- 已满足：AC-3 → `web_search_tests.rs::fetch_url_validation` / `format_fetch_result` /
  `post_request_*`（URL 校验、正文拼装、超时）。
- 已满足：AC-4 → `e2e/webview/settings.spec.ts`（US-24 用例内断言复选框可交互、
  「只有 Responses 协议支持」提示不再出现），15/15 绿。
- 已满足：AC-5 → 极简禁用为既有行为（`InputArea.tsx` 未动），开关存在性由
  `e2e/webview/inputMenu.spec.ts` 既有用例覆盖。
- 已满足：AC-6 → `e2e/webview/messagePresentation.spec.ts` US-50 用例（WebSearch 卡
  显示查询词、WebFetch 卡显示 URL，标题用真实工具名）。
- 已满足：AC-7 → `web_search_tests.rs::run_web_search_without_provider_errors_without_request`
  / `run_web_fetch_validates_url`。
- 已满足：AC-8 → `web_search_tests.rs::http_error_mapping_by_status` /
  `post_request_times_out_on_silent_socket` / `post_request_maps_error_body_message`。
- 偏差（已修）：实现初版在 `count` 未提供时请求体带 `"count": null`，与 FR-001 的
  「缺省 10」不符——已改为未提供时整体省略（取接口默认），`web_search.rs` 内联注释
  说明。
- 反向对照：工具定义 / schema 对照表 / 系统提示词对照表（`core-rs/fixtures/toolSchema.json`、
  `systemPrompt.json`）与 `definitions()`、`TOOL_DETAILS` 同步更新；Responses 侧删除
  的行为（server 端 web_search 剥离、联网轮 usage 剔除）在 spec 影响基线与
  [`docs/features/web-search.md` 第 6 节](../../docs/features/web-search.md#6-对需求基线的影响)声明，无未声明变更。

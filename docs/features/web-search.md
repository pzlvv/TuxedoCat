---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：联网搜索与网页抓取（WebSearch / WebFetch）

联网搜索是 Core 进程内的两个客户端工具：`WebSearch` 按 query 搜索网页（DeepSeek
Search API），`WebFetch` 抓取单个网页返回 Markdown 正文（DeepSeek Fetch API）。工具
是否注入由会话的联网搜索开关决定，对所有 API 协议（Completion / Anthropic /
Responses）生效；实现位于 `core-rs/src/web_search.rs`，卡片复用既有工具卡基础设施。
需求基线见 [US-50](user-stories.md#us-50-联网搜索与网页抓取客户端工具)。

## 1. 用户场景与验收标准

- 用户问时效性问题，模型调 `WebSearch` 取最新结果，按摘要判断后调 `WebFetch` 读某一页正文，引用进回答。
  - **AC-1**（FR-001）：GIVEN 会话联网搜索开启 WHEN 模型调用 `WebSearch` THEN 工具结果返回逐条搜索元信息，会话不中断。
  - **AC-2**（FR-002）：GIVEN 模型需要某页正文 WHEN 调用 `WebFetch` 且 URL 合法 THEN 工具结果返回标题与 Markdown 正文。
- 用户不需要搜索时关掉开关：两个工具从模型工具清单消失，模型无从调用。
  - **AC-3**（FR-004）：GIVEN 会话联网搜索关闭 WHEN 组装下一轮 LLM 请求 THEN `WebSearch` 与 `WebFetch` 不在工具清单里。
  - **AC-4**（FR-004）：GIVEN 活动服务商默认模型协议非 Responses WHEN 打开设置页 LLM 配置 THEN 联网搜索复选框可交互，不出现「只有 Responses 协议支持」提示。
- 未配置 DeepSeek 服务商的用户误触发搜索：工具返回明确错误，会话继续。
  - **AC-5**（FR-003）：GIVEN 未配置 `api.deepseek.com` 服务商 WHEN 模型调用任一联网工具 THEN 工具结果为指明配置路径的错误，状态 fail、会话不中断。
- 卡片呈现与其它工具一致。
  - **AC-6**（FR-005）：GIVEN 联网工具调用到达 WHEN 时间线渲染卡片 THEN 搜索卡显示查询词、抓取卡显示 URL，成功 / 失败状态与既有工具卡同口径。

## 2. 功能需求

### FR-001：WebSearch

入参 `query`（1–128 Unicode 字符、非空白）与 `count`
  （1–50，缺省 10）；`POST {DEEPSEEK_BASE_URL}/v1/tools/search`，请求体
  `{query, count, need_content:false}`；结果逐条给出 `rerank_score / title / url /
  snippet / summary / site_name / date`（缺失省略），正文不返回。
### FR-002：WebFetch

入参 `url`（HTTP/HTTPS、含 host、无凭证、≤8192）；
  `POST {DEEPSEEK_BASE_URL}/v1/tools/fetch`，请求体 `{url}`；返回 `# title` +
  Markdown 正文，超长由 `tools::cap_tool_result` 统一上限承担。
### FR-003：鉴权与错误

Key 取配置快照里 baseURL host 为 `api.deepseek.com` 的
  provider（与余额查询同一解析）；未配置时工具错误指明配置路径。30s 超时；错误文本
  含 HTTP 状态码与 `error.message`，402 注明余额不足，408/429/5xx / 网络错误附
  「稍后可重试」提示，不自动重试；Key 不进错误文本。
### FR-004：开关语义

会话覆盖（meta.json `context.webSearch` / 消息随带 /
  配置事件）优先，缺省回 `settings.json` 的 `llm.webSearch`（默认 true，见
  [core-ui-separation 第 4.3 节](../architecture/core-ui-separation.md)）；生效时
  两工具进入工具清单（仍受提示词模式白名单约束），未生效时剔除。
### FR-005：卡片

`WebSearch` 渲染搜索卡（查询词，取 `args.query`；旧会话的
  `args.queries` 兼容），`WebFetch` 复用同一卡片的「打开网页」形态（URL）。

## 3. 行为规格

| 环节 | 行为 | 落点 |
| --- | --- | --- |
| 工具定义 | `WebSearch` / `WebFetch` 在内置工具表（Skill 之前），并发安全（只读网络请求），权限只读放行 | `core-rs/src/tools.rs`、`core-rs/src/permission.rs` |
| 工具注入 | 组装工具清单时按生效联网搜索值过滤（false 剔除两工具，MCP 工具不受影响） | `core-rs/src/engine.rs`（`run_query_loop`） |
| 执行 | 校验 → Key 解析 → 请求 → 拼装；参数错误与未配置不发请求 | `core-rs/src/web_search.rs` |
| Key 解析 | baseURL host = `api.deepseek.com`（或 provider key 恰为该域名），与 active provider 无关 | `core-rs/src/balance.rs::deepseek_provider_api_key` |
| 卡片 | 工具名 → 组件映射 `WebFetch` 复用 WebSearch 卡；标题用真实工具名 | `src/webview/MessagesView.tsx`、`src/webview/tools/WebSearch.tsx` |
| 设置 | 复选框不再按默认模型协议置灰 | `src/webview/LLMConfigPanel.tsx` |

## 4. 边界与错误路径

- `query` 全空白 / 超长、`url` 非法：工具校验错误，不发请求。
- 搜索无结果：返回 `No results found.`。
- 4xx（402 除外）：透传状态与消息，不附重试提示。
- 会话中途关开关：下一轮请求即生效，不追溯中止进行中的调用。

## 5. 非目标

- 搜索结果缓存 / 去重 / 多轮检索编排；自动重试与限速退避；其它服务商的搜索端点；
  新的总线事件或 wire 消息（复用 `toolCall` / `toolResult`）。

## 6. 对需求基线的影响

- 取代「Responses 协议的 server 端内置 web_search」路线：
  [standalone-core-boundaries 第 4 节](../core/standalone-core-boundaries.md#4-不覆盖范围)
  的对应缺口已消除；Responses 请求不再拼装 server 端工具，联网轮次的 usage
  剔除逻辑随之删除（usage 可信度只剩「超过上下文窗口 60%」一道闸门）。
- 设置语义：`llm.webSearch` 由「Responses 内置搜索开关」改为「工具注入开关」
  （字段名、默认值、meta.json 落盘格式不变）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/web_search.rs::run_web_search` | `core-rs/src/web_search_tests.rs` | 自动 |
| FR-002 | `core-rs/src/web_search.rs::run_web_fetch` | `core-rs/src/web_search_tests.rs` | 自动 |
| FR-003 | `core-rs/src/web_search.rs`（key 解析复用 `balance.rs`） | `core-rs/src/web_search_tests.rs`（未配置 / 402 / 429 / 超时；本地一_shot 假服务器） | 自动 |
| FR-004 | `core-rs/src/engine.rs`（工具清单过滤）、`src/webview/LLMConfigPanel.tsx` | `core-rs/src/engine_tests.rs::web_tools_follow_the_web_search_flag`、`e2e/webview/settings.spec.ts` | 自动 |
| FR-005 | `src/webview/MessagesView.tsx`、`src/webview/tools/WebSearch.tsx` | `e2e/webview/settings.spec.ts`（随 US-50 回归） | 自动 |

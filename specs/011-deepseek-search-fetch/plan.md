# 实施方案：联网搜索改为客户端工具（DeepSeek Search / Fetch API）

需求见同目录 `spec.md`。技术路线：在 `core-rs` 新增一个 `web_search.rs` 模块承载两个
内置工具（`WebSearch` / `WebFetch`）的执行与错误映射，工具定义登记进
`tools.rs::definitions()`，注入与否由引擎按会话的联网搜索生效值在组装工具清单时过滤；
鉴权复用 `balance.rs` 的 DeepSeek 服务商解析。webview 侧只删「仅 Responses 可用」的
置灰与提示、给抓取卡片补 URL 展示来源，不新增任何 wire 消息或事件。

## 技术方案

### Core（core-rs）

- **新模块 `core-rs/src/web_search.rs`**：
  - `pub fn run_web_search(input: &Value) -> ToolOutcome` / `run_web_fetch(input: &Value)`：
    参数校验（spec FR-001/002 的口径，校验失败 `ToolOutcome::Error`，不发请求）→
    解析 DeepSeek 服务商 key（复用 `balance.rs::deepseek_provider_api_key`；
    `DEEPSEEK_BASE_URL` 同源）→ `post_json`（`reqwest::blocking`，30s 超时，Bearer 头）
    → 解析响应拼装工具结果文本；错误按 FR-003 映射（状态码 + `error.message` +
    402 专述 + 可重试提示；key 不进文本）。
  - 请求体构造与响应拼装拆成纯函数（`build_search_request` / `format_search_results` /
    `format_fetch_result` / `map_http_error` / `validate_fetch_url`），单测全部落在
    纯函数与本地 TCP 一_shot 服务（`test_support` 起 `TcpListener` 回放固定响应，
    覆盖 200 / 400 / 402 / 429 / 超时路径），不打外网。
  - 抓取正文截断：与工具输出既有上限同口径（`tools.rs` 的结果上限常量；超长截断
    尾部注明 `[truncated]`）。
- **`tools.rs`**：`definitions()` 在 `Skill` 之前插入 `WebSearch` / `WebFetch` 两条
  JSON 定义（`input_schema`：query+count / url）；`execute()` 加两个 match 分支；
  `is_concurrency_safe` 加 `"WebSearch" | "WebFetch" => true`；`validate_input` 加
  query 非空白 / URL 合法两条（与 web_search.rs 内的校验同一实现，tools 侧调它）；
  `is_known` 自动跟上（从 definitions 推导，无需改）。
- **`permission.rs::base_check`**：`WebSearch` / `WebFetch` 归入只读放行组
  （与 `Read | Grep | Glob | TodoWrite` 同行）。
- **`engine.rs`**：组装工具清单处（`run_query` 的 `all_tool_definitions` 之后、
  `filter_tools_by_preset` 之前）按生效联网搜索值过滤：`provider_config.web_search`
  为 false 时剔除 `WebSearch` / `WebFetch`（MCP 工具不受影响）。生效值解析已有
  （会话覆盖 → `config::default_web_search()`，engine.rs 现有代码），不动。
- **`responses.rs`**：删除 `web_search` 工具剥离（`retain` 行）与
  `should_skip_usage_for_context` 的 `web_search_used` 参数及调用；`config.rs` 的
  `ProviderConfig.web_search` 去掉 `#[allow(dead_code)]`（现在真实消费于工具过滤）。
  `fixtures/responses.json` 删除 web_search 工具透传与 `webSearchUsed` 条目，
  `responses_tests.rs` / `responses_stream_tests.rs` 同步（「不应下发 web_search」
  用例改为「任何情况下不下发 server 端 web_search」由请求构造的单测锁）。
- **测试**：`web_search_tests.rs`（新）：参数校验、请求体、结果拼装、错误映射、
  key 解析失败、本地 TCP 一_shot 的执行路径；`engine_tests.rs` 增：webSearch
  开 / 关时工具清单含 / 不含两个工具（mock LLM 断言请求里的 tools 名单）。

### Webview / host

- **`src/webview/LLMConfigPanel.tsx`**：删除 `defaultModelApiType` 判定块与
  `webSearchDisabled`（复选框的 opacity / disabled / cursor / 提示切换全部回常量态）；
  `UNCONFIGURED_MODEL_API_TYPE` 保留（协议下拉仍在用）。
- **`src/webview/i18n/{zh,en}.ts`**：删 `llmConfig.webSearchDisabledHint` 两行。
- **`src/webview/MessagesView.tsx`**：工具名 → 组件映射加 `'WebFetch'` 复用
  `WebSearch` 卡片。
- **`src/webview/tools/WebSearch.tsx`**：search 形态显示 `args.query`（新工具的入参）
  ，保留 `args.queries` 兼容旧会话的历史卡片。
- **InputArea / webviewMessages / settingsSnapshot**：不动（极简禁用与既有 wire 语义
  原样保留）。

### 文档（收敛时并入）

- `docs/core/standalone-core-boundaries.md` 不覆盖范围删 Web Search 缺口行。
- `docs/architecture/core-ui-separation.md` §4.3 `llm.webSearch` 行语义更新。
- `docs/features/user-stories.md`：US-8 / US-24 措辞 + 新增 US-49。
- 新增 `docs/features/web-search.md`（特性规格七节骨架）。
- `docs/architecture/open-questions.md`：无涉（web search 缺口已随 boundaries 行消除）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/web_search.rs` | 新增 | 无（内部模块） |
| `core-rs/src/tools.rs` | 修改 | 内置工具集合 +2（`WebSearch` / `WebFetch`） |
| `core-rs/src/permission.rs` | 修改 | 无（只读放行组 +2 成员） |
| `core-rs/src/engine.rs` | 修改 | 无（工具清单按既有 webSearch 生效值过滤） |
| `core-rs/src/responses.rs`、`config.rs` | 修改 | 无（删 server 端 web_search 残留） |
| `core-rs/fixtures/responses.json` + responses 两侧测试 | 修改 | 对照表删 web_search 相关条目 |
| `src/webview/LLMConfigPanel.tsx`、`i18n/{zh,en}.ts` | 修改 | 无（删置灰与提示） |
| `src/webview/MessagesView.tsx`、`tools/WebSearch.tsx` | 修改 | 无（复用既有卡片） |
| `e2e/webview/settings.spec.ts` | 修改 | 无（补「非 Responses 服务商下复选框可用」断言） |
| docs 五份 | 修改 / 新增 | 无 |

事件词汇表、wire 消息、`settings.json` / meta.json 格式均无变化。

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：工具实现全部在 `core-rs`，webview 只删限制与
      展示，`src/shared/` 不动；无宿主嗅探。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：未配置服务商 / 参数非法直接报工具错误（不静默
      降级）；默认值单源不动（`settingsSnapshot` / `config::default_web_search`）；
      工具结果格式只有 web_search.rs 一处拼装。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：Core 只有 core-rs 一套；
      落盘格式（meta.json `context.webSearch`）不变，无 shared/history 同步项。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：上文「文档」清单在 /converge 时并入；
      US-49 登记 e2e 或豁免（整链联网调用不进 e2e：外网依赖，Core 侧行为由 Rust
      单测覆盖，UI 限制删除由 settings.spec 断言）。

## 被否决的替代方案

- **单工具（action: search|open_page 分派）**：模型侧一次调用语义含糊（一个 schema
  两种载荷），DeepSeek 本就是两个端点；两个工具的 schema 更利于模型正确调用。
- **保留 server 端 web_search 作为 Responses 的快路径**：两套搜索路径并存会让「开关
  语义」「卡片形态」「usage 口径」各留一份特判，正是本次要消除的 Responses-only 分叉。
- **自动重试（408/429/5xx 退避）**：Core 内重试会拉长工具时延并放大限速；错误文本
  已带可重试提示，重试决策留给模型（与 Agent 语义一致）。
- **`need_content: true` 一次取正文**：token 成本高（结果 × 全文），且 billed 同价；
  summary（600–800 字符）+ 按需 `WebFetch` 的组合更省。

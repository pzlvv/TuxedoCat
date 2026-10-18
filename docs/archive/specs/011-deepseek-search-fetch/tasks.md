# 任务分解：联网搜索改为客户端工具（DeepSeek Search / Fetch）

回指同目录 `spec.md` 的 FR；完成判据可验证。按依赖排序。

- [x] **T001**（FR-001、FR-002、FR-003）：新增 `core-rs/src/web_search.rs`：参数校验
  （query 非空白 ≤128、count 1–50 不本地钳制、URL 合法性）、请求体构造
  （`{query,count,need_content:false}` / `{url}`）、结果拼装（逐条 rerank_score /
  title / url / snippet / summary / site_name / date；title+content 截断注明）、
  错误映射（状态码 + error.message、402 专述、可重试提示、key 不泄漏）、30s 超时的
  `reqwest::blocking` 执行；依赖：—；完成判据：`cargo test -p --manifest-path
  core-rs/Cargo.toml web_search` 通过（含本地 TCP 一_shot 的 200/400/402/429/超时）。
- [x] **T002**（FR-001/002/005）：`tools.rs` 登记：`definitions()` 插入 `WebSearch` /
  `WebFetch`（Skill 之前）、`execute()` 分支、`is_concurrency_safe` 放行、
  `validate_input` 接 T001 校验；`permission.rs::base_check` 只读放行组 +2；
  依赖：T001；完成判据：`cargo test` 的 tools / permission 相关组绿 +
  `definitions` 顺序不变式（Skill 末位）用例仍绿。
- [x] **T003**（FR-004）：`engine.rs` 工具清单按会话联网搜索生效值过滤
  （false 剔除两工具，MCP 不受影响）；`config.rs` `web_search` 去 dead_code 标记；
  依赖：T002；完成判据：`engine_tests` 新增用例「webSearch 开 / 关时 mock LLM 收到的
  tools 名单含 / 不含 WebSearch、WebFetch」绿。
- [x] **T004**（FR-004）：删 Responses 的 server 端 web_search 残留：
  `responses.rs` 的 `retain` 剥离与 `web_search_used` 参数；`fixtures/responses.json`
  删相关条目并同步 `responses_tests.rs` / `responses_stream_tests.rs`；依赖：—；
  完成判据：`cargo test` responses 组绿，`grep -rn web_search core-rs/src/responses.rs`
  无命中。
- [x] **T005**（FR-004）：webview 删限制：`LLMConfigPanel.tsx` 删 `defaultModelApiType`
  判定与置灰；`i18n/{zh,en}.ts` 删 `webSearchDisabledHint`；依赖：—；完成判据：
  `npm run check-types` + `npm run lint` 绿；`grep -rn webSearchDisabled src/` 无命中。
- [x] **T006**（FR-005）：卡片：`MessagesView.tsx` 映射 `'WebFetch'` 复用 WebSearch
  卡片；`WebSearch.tsx` search 形态显示 `args.query`（保留 `queries` 兼容旧会话）；
  依赖：—；完成判据：`npm run check-types:webview` 绿；e2e
  `test:e2e:webview -- settings` 相关用例绿。
- [x] **T007**（FR-004/005）：e2e：`e2e/webview/settings.spec.ts` 补「非 Responses
  服务商下联网搜索复选框可交互」断言；依赖：T005；完成判据：
  `npm run test:e2e:webview -- settings` 绿。
- [x] **T008**（全部 FR）：文档：删 boundaries 缺口行、core-ui-separation §4.3 语义
  行更新、user-stories US-8/US-24 措辞 + 新增 US-49（e2e 覆盖按 T007 登记，整链
  豁免）、新增 `docs/features/web-search.md`、`docs/README.md` 地图登记；依赖：
  T001–T007；完成判据：`npm run test:all -- docs-lint` 全绿。
- [x] **T009**（全部 FR）：全量验证：`npm run check-types && npm run lint && npm run
  test:all && npm run test:core`；依赖：T001–T008；完成判据：四项全绿，逐条对照
  spec AC 记录证据（/converge 输入）。

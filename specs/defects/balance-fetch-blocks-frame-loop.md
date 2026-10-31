---
status: 已修
---

# 缺陷：余额查询在 Core 帧循环线程上同步执行，30 秒超时期间整个 Core 无响应

每次 LLM 轮次结束（`aiEnd`）/ 加载对话 / 新建对话，宿主都发
`UiRequest.balanceRequested`。Core 侧在**帧循环线程**上同步执行 HTTP 请求
（`reqwest::blocking`，30 秒超时）：DeepSeek 接口慢或网络不通时，帧循环被阻塞最长
30 秒——期间所有事件不上报、所有 UiEvent 不处理、所有请求不应答，表现为整个应用
假死，与模型请求形成事实上的同步耦合。

## 现状

- `run_frame_loop`（`core-rs/src/main.rs`）单线程逐帧处理；
  `dispatch_ui_request` 的 `"balanceRequested"` 分支直接调用
  `balance::fetch_balance()`——内含 `reqwest::blocking::Client` 同步请求，
  超时 30 秒（`core-rs/src/balance.rs`）。
- 余额查询的触发点（每轮 LLM 结束 / 加载对话 / 新建对话）与用户操作高度重叠：
  查询挂住时用户随后的任何操作（发消息、切对话、打开面板）全部排队等 HTTP。
- `smartNamingRequested` 走 LLM 调用（已有独立处理），`balanceRequested` 是
  `dispatch_ui_request` 里唯一的同步网络出口。

## 期望

- 余额查询移出帧循环：请求到达后由独立线程执行，应答异步回写（Core 侧经
  `CoreBus` 的 pending 表以同 id 应答；帧循环继续处理后续帧）。
- 请求超时从 30 秒收紧到 **3 秒**：余额是状态条装饰性信息，超时即按失败处理
  （宿主清空显示，既有语义），不值得阻塞更久。
- 帧协议语义不变：`UiRequest.balanceRequested` 的应答帧仍走
  `CoreToUiFrame::Response`，宿主（Electron / TUI / VS Code）零改动。

## 不变量

- `UiRequest.balanceRequested` 契约（类型、载荷、结果形态）不变；
  `docs/architecture/events.md` 与 `docs/core/standalone-core-boundaries.md` 的
  UiRequest 清单不变。
- 未配置 `api.deepseek.com` provider 时仍不发请求、立即回 `null`
  （`balance.rs` 的既有口径）。
- 应答帧仍按请求 id 配对；宿主侧 `requestCore` 的 Promise 语义不变。
- 其余 UiRequest 仍在帧循环上同步应答（它们只读磁盘 / 内存，无网络出口）。

## 回归测试

- **RT-1**：`balanceRequested` 的应答不阻塞帧循环——同一条输入里紧随其后的
  `conversationSpacesRequested` 先被应答，余额应答随后异步到达（落点：
  `core-rs/src/main_tests.rs` `balance_request_does_not_block_the_frame_loop`，
  余额接口经 `balance::set_base_url_for_test` 指向本地挂起服务器）。
- **RT-2**：请求整体超时常量为 3 秒（落点：`core-rs/src/balance_tests.rs`
  `balance_timeout_is_three_seconds`）。
- **RT-3**：HTTP 分支可测——假服务器返回合法响应体解析成余额，非 2xx 回 `None`
  （落点：`balance_tests.rs` 的 `fetch_balance_parses_a_served_response` /
  `fetch_balance_returns_none_when_the_server_fails`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test balance_request_does_not_block` | 红 | 首次红：断言「后续帧未被处理」——`responses: []`，同步 `fetch_balance` 卡住整个帧循环。补 `set_base_url_for_test` 前用例还会打到真实接口（实测挂 60s+ 被杀）；改指本地挂起服务器后红得稳定：`responses: [7, 8]`（余额应答先于后续帧） |
| RT-1 / RT-2 / RT-3（修复后） | `cargo test balance::` + `cargo test balance_request_does_not_block` | 绿 | 12 项余额用例全过（超时常量 / 合法响应解析 / 非 2xx / provider 查找 / hostname 归一）；帧循环用例 0.27s 完成且 `responses` 首位为 8 |
| 测试基建补齐 | — | skipped | 既有用例从未覆盖 HTTP 分支（「地址固定为官方，无法在测试里改指向假服务器」，`balance_tests.rs` 原注释）。本次引入 `BASE_URL_OVERRIDE` + `#[cfg(test)] set_base_url_for_test`，只影响测试构建；无独立命令，随 RT-1 / RT-3 一起验证 |

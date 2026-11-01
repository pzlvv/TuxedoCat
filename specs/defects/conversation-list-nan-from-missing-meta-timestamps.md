---
status: 已修
---

# 缺陷：meta.json 缺 createdAt / updatedAt，对话列表把相对时间渲染成 NaN/NaN/NaN

Spin 会话在 Electron 侧栏与 webview 对话树里显示成「NaN/NaN/NaN 33 条」。宿主的相对时间
格式化只认数字毫秒（`relativeTime(c.updatedAt ?? c.createdAt)`）：meta.json 里两个时间戳
都缺失时取到 `undefined`，`new Date(undefined)` 得到一个非法日期，三个取数器全返回 `NaN`，
列表行就成了 `NaN/NaN/NaN`。受影响的会话不止 Spin：凡是走过「兜底建档」再被非用户消息
推进的会话（配置先落盘、后台 / 子代理回复）都缺时间戳。

## 现状

- 复现证据（Core 跑在一台远程 Linux 主机上）：该工作目录的
  `session_1793462135244_3dce4v9.meta.json` 为 `{ "title": "Spin Design",
  "workMode": "spin", "messageCount": 33, context / model / provider … }`，**没有**
  `createdAt` / `updatedAt`；同名 `.jsonl` 是 33 条真实消息记录，`messageCount` 与之吻合。
  侧栏条目即渲染成 `NaN/NaN/NaN 33 条`（用户截图）。
- 本机数据同样成片：`~/<configDir>/conversations/` 下该工作目录的档案里有 130 个
  `*.meta.json` 缺 `createdAt`（如 `session_1793462133998_6x33l1i`：有 `updatedAt`、
  有 `messageCount: 48`，无 `createdAt`）。
- 落盘侧有四个「只写被点名键」的入口，谁都不负责补齐时间戳：
  - `history::update_metadata`（`core-rs/src/history.rs`）是 meta.json 的唯一写入点，
    但 `mutator` 只改调用方点名的字段，`fallback` 只在档案缺失时生效；
  - `history::update_context` 的兜底建档（`specs/defects/session-config-lost-before-first-message.md`）
    只写 `sessionId` / `project` / `creator`，零时间戳；
  - `history::touch_metadata` 的兜底建档同样零时间戳，且 `mutator` 只在
    `user_initiated` 时写 `updatedAt`（后台 / 子代理消息不写），写 `createdAt` 的分支根本不存在；
  - `Core::write_conversation_title` 对**已存在**的档案只写 `title`（建档 fallback 才带时间戳）。
- Spin 路径把这条缝放大：`CoreSpinHost::push_message`（`core-rs/src/spin_host.rs`）直接
  `history::append_message` + 发 `conversationListChanged`，不经过 `announce_message_appended`
  → 进度消息既不刷 `updatedAt` 也不触碰时间戳；而 `/spin` 的标题改写（
  `Core::update_conversation_title`）对「配置阶段已兜底建档」的会话又只写标题。
- 读取侧原样透出磁盘字段：`history::load_conversation_list` 把 meta.json 的解析结果直接
  进列表。宿主 `ConversationMetadata.createdAt` / `updatedAt` 在 TS 侧是必选 `number`
  （`src/shared/history/Conversation.ts`），Electron 侧栏
  （`electron/sidebar/main.ts` 的 `relativeTime`）与 webview 对话树
  （`src/webview/hooks/useAppHandlers.ts` 的 `formatRelativeTime`）都按数字直接格式化，
  缺失即渲染 `NaN`。

## 期望

- meta.json 的**任何**写入路径落盘后都带 `createdAt` 与 `updatedAt` 两个数字毫秒时间戳：
  补齐职责收在唯一写入点 `history::update_metadata`（落盘前补齐），调用方不必各自记着写。
- 读取侧对**存量**缺时间戳的档案就地补齐，使列表契约（[contracts.md 第 4 节](../../docs/architecture/contracts.md#4-对话相关数据conversationmanager)的
  `createdAt` / `updatedAt`）在读取时恒成立：
  - `updatedAt` 缺失 → 取 `createdAt`；
  - `createdAt` 缺失 → 取 `updatedAt`；
  - 两者都缺失 → 取 meta.json 的文件修改时间（同一档案最近一次写入时刻，是磁盘上仅剩的
    时间证据）；
  - 仍取不到（mtime 读不出）→ 取当前时刻。
- 列表输出不再出现缺时间戳的条目，两个宿主的时间渲染对每一条都拿到数字。
- 补齐只影响读出的值：不因读取而写盘（读取仍是只读投影）。

## 不变量

- `updatedAt` 语义不变：只有用户主动发送的消息刷新它，后台消息 / 子代理回复 / Spin 进度
  消息都不刷新（列表排序不被后台活动顶到最前）。
- `createdAt` 语义不变：只为缺失的档案补一次，已有值不因新消息或后台写入改变。
- 落盘格式不变：仍是 JSON 数字毫秒；字段名、嵌套结构（`context.*`、`model` / `provider`
  顶层扁平双写）与原子落盘 / 写锁语义都不变。
- 列表口径不变：`workspace.meta.json` 仍排除；`messageCount === 0` 且无 `clearedAt` 的
  档案仍不进列表；排序仍是 `updatedAt ?? createdAt` 倒序；`clearedAt` 语义不变。
- `load_metadata` 的既有容错不变：档案缺失 / 解析失败返回 `None`，无效 UTF-8 宽松解码。
- 宿主侧渲染逻辑不变（不给 UI 加「时间缺失就显示空」的兜底分支）：
  [principles.md 第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)与
  [principles.md 第 10 节](../../docs/architecture/principles.md#10-webview-不持有事实的默认值)
  要求事实由 core 给全，缺省值不散落到渲染侧。

## 回归测试

- **RT-1**：存量档案只有 `title` / `workMode` / `messageCount`（与远端 Spin 会话同形）时，
  `load_conversation_list` 返回的条目仍带两个数字时间戳，且 `createdAt <= updatedAt`
  （落点：`core-rs/src/history_tests.rs` `conversation_list_fills_timestamps_for_legacy_metadata`）。
- **RT-2**：写入路径恒落两个时间戳——(a) 首条消息前的配置兜底建档（`update_context`）、
  (b) 对「有 `updatedAt` 无 `createdAt`」的存量档案做一次 `touch_metadata`，落盘后的
  meta.json 两个键都在（(b) 断言直接读原始文件，绕开读取侧补齐）
  （落点：`core-rs/src/history_tests.rs` `metadata_writes_land_both_timestamps`）。
- **RT-3**：新会话先改配置（兜底建档只带 `context`）再 `/spin`：进入 Spin 后 meta.json
  带两个时间戳，列表条目不再是缺时间戳的形态
  （落点：`core-rs/src/spin_host_tests.rs` `spin_ready_bootstraps_list_timestamps`）。

## 验证记录

| 检查 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| RT-1（修复前） | `cargo test --manifest-path core-rs/Cargo.toml conversation_list_fills_timestamps_for_legacy_metadata` | 红 | `createdAt 必须是数字：{"sessionId":"s1","project":"D:/repo/demo","title":"Spin Design","workMode":"spin","messageCount":33,"creator":{"kind":"user"}}`——列表条目原样透出磁盘字段，无时间戳 |
| RT-2（修复前） | `cargo test --manifest-path core-rs/Cargo.toml metadata_writes_land_both_timestamps` | 红 | 首个断言即红：`配置兜底建档必须带两个时间戳：{"sessionId":"bootstrap","project":"D:/repo/demo","creator":{"kind":"user"},"context":{"webSearch":false}}`——`update_context` 的 fallback 只写 sessionId / project / creator |
| RT-3（修复前） | `cargo test --manifest-path core-rs/Cargo.toml spin_ready_bootstraps_list_timestamps` | 红 | `spin 会话落盘必须带两个时间戳：{"…","context":{"webSearch":false},"title":"Spin Design","workMode":"spin"}`——与远端 `session_1793462135244_3dce4v9.meta.json` 同形 |
| RT-1 / RT-2 / RT-3（修复后） | `cargo test --manifest-path core-rs/Cargo.toml <各自用例名>` | 绿 | 三条各 1 passed / 0 failed：补齐收在 `history::update_metadata`（落盘前补两个键），读取侧 `load_conversation_list` 对存量档案就地补齐（缺一个取另一个、两者都缺取档案 mtime） |
| 既有回归（history / spin_host 模块） | `cargo test --manifest-path core-rs/Cargo.toml history::` 与 `spin_host::` | 绿 | 47 passed / 13 passed，0 failed——`load_metadata` 容错、列表排除清单与空对话、once 槽位、`updatedAt` 不被后台消息刷新等既有口径未变 |
| 既有回归（engine 模块，clean worktree） | `CARGO_TARGET_DIR=/tmp/tc-verify-target cargo test --manifest-path core-rs/Cargo.toml engine::`（worktree `/tmp/tc-verify` = HEAD + 本改动） | 绿 | 196 passed / 0 failed。评估时的工作树里另有无关的 `@` reminder 半成品改动，会让 2 条 engine 用例红；clean worktree 里没有它们，本模块全绿 |
| 既有回归（mcp 模块） | `cargo test --manifest-path core-rs/Cargo.toml mcp::tests::` | 部分验证 | 5 条 stdio 假服务器用例红于 `启动 MCP server "fake" 失败: 进程已退出`（本机 node 24 跑那段内联脚本起不来）；把本改动 stash 后在 HEAD 上单跑同样红——环境问题，与本改动无关 |
| 真实数据核对（修复前） | 同一临时用例在 HEAD 的 `history.rs` 上跑 | 红 | `真实数据：110 条会话；缺时间戳 8 条 [session_1793493249659_nw7yrux, session_1793490299993_wpgr4zi, session_1793489990055_6up2ubl, session_1793462133998_6x33l1i, session_1793454564982_2q37l6h, session_1793400091223_2jz4ptg, session_1793290398628_td7jf7y, session_1793290177594_t914fmv]`——本地该工作目录里 8 条真实会话会渲染成 `NaN/NaN/NaN`，含本次会话自身 |
| 真实数据核对（修复后） | 同一临时用例 | 绿 | `真实数据：110 条会话；缺时间戳 0 条 []`；Spin 条目带 `createdAt: 1792510303507` / `updatedAt: 1792510391833` |

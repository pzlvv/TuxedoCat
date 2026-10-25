---
owner: pzlvz
last_reviewed: 2026-10-25
---

# 规格：跨工作区文件传输（`Transfer` 工具）

本规格界定 Electron 多工作区宿主上的跨工作区文件传输：内置工具 `Transfer` 把文件 /
目录在两个已打开工作区之间递归搬运——本机两个本地工作区之间直接复制，涉及 SSH
远程工作区时由宿主经传输专用的 SSH 连接（SFTP）完成，SSH↔SSH 由宿主逐文件流式中继。
两端以工作区代理身份寻址（与 `Agent.target` 同一口径，见
[docs/features/cross-workspace-agent.md 第 2 节](cross-workspace-agent.md#fr-001工作区代理身份)），
至少一端必须是发起对话所属的工作区。VS Code 宿主与 TUI 不提供本能力（调用返回工具错误），
但工具定义与提示词段恒定注入。

交叉引用：工作区身份与跨工作区路由见
[docs/features/cross-workspace-agent.md](cross-workspace-agent.md)；
事件与载荷见 [docs/architecture/events.md 第 2 节](../architecture/events.md#2-事件词汇表)；
SSH 接入（SFTP 同源的凭证与链路）见
[docs/core/core-remote.md 第 2.8 节](../core/core-remote.md#28-ssh-接入ssh-scheme)；
中止范围见 [docs/features/abort-button.md](abort-button.md)。

## 用户场景与验收标准

- 场景 1：本地 ↔ 本地递归传输
  - **AC-1**（FR-001）：GIVEN 合法四入参 WHEN 调用 THEN `sourceTarget` / `destTarget` 缺省按发起会话工作区解析、空字符串按入参错误拒绝。
- - **AC-1**（FR-003）：GIVEN 两个本地工作区打开 WHEN `Transfer` 源目录到另一工作区的目标路径 THEN 目标端出现整棵子树（含点文件），目标父目录自动创建，无暂存残留。
  - **AC-2**（FR-003）：GIVEN 目标端已有同名文件与多余文件 WHEN 传输 THEN 同名文件被覆盖、多余文件保留。
- 场景 2：两端解析守卫
  - **AC-3**（FR-002）：GIVEN 两端缺省或解析后同工作区 WHEN 调用 THEN 工具错误提示同工作区用 Bash（cp / mv），两端零写入。
  - **AC-4**（FR-002）：GIVEN 任一 target 未命中打开集合或匹配多项 WHEN 调用 THEN 工具错误与 `Agent.target` 同族点名身份。
- 场景 3：能力边界
  - **AC-5**（FR-004）：GIVEN manual 模式 WHEN 调 `Transfer` THEN 弹出含源 → 目标路径的确认框；Explorer 角色的工具清单不含 `Agent` 也不含 `Transfer`。
- **AC-7**（FR-005）：GIVEN VS Code 宿主 WHEN 调 `Transfer` THEN 返回「当前宿主不支持」；三宿主的工具定义与提示词段逐字节一致。
  - **AC-6**（FR-006）：GIVEN 跨工作区子代理会话 WHEN 组装提示词 THEN `### Transfer` 段为详细形态并点名发起方身份；普通会话为简述且不含参数表。
- **AC-8**（FR-007）：GIVEN 传输进行中 WHEN 发起会话被中止 THEN 传输取消、按「工具被中止」收尾，已完成文件保留且无半写文件。

## 功能需求

### FR-001：入参形态

- `Transfer` 内置工具四入参：`sourcePath` / `targetPath`（必填，各自机器上的非空
  绝对路径）+ `sourceTarget` / `destTarget`（可选，工作区代理身份；缺省 = 发起会话
  所属工作区；空字符串是入参错误，与 `Agent.target` 同口径）。
- 权限判定为 ask（确认文案含源 → 目标路径），agentMode 加工如常；入参非法直接
  deny。`is_concurrency_safe` 恒为假（写类工具，不与相邻工具并行）。

### FR-002：两端解析守卫

- 执行经 `CoreRequest.crossWorkspaceTransferRequested` 由宿主完成（宿主是唯一握有
  两端事实的角色）：解析与守卫在 `resolveTransferEnds`（缺省端 = 来源、未命中 /
  歧义 / 同工作区 / 双非来源逐项报错，文案与 `Agent.target` 同族）、执行在
  `src/host/workspaceTransfer.ts`。守卫违反即工具错误，两端零写入。

### FR-003：传输语义

- 递归整棵子树逐项复制（含点文件、无排除规则）；同名文件覆盖、同名目录逐项合并、
  不删除目标端多余项；目标父目录自动创建；符号链接不跟随、不复制，计数进结果。
- 本地↔本地直接复制；涉 SSH 由宿主建传输专用连接（SFTP）；SSH↔SSH 宿主逐文件
  流式中继。逐文件「暂存名 + 改名」落盘——中止 / 失败无半写文件，已完成文件
  不回滚。类型冲突（目录 ↔ 文件）报错，已完成项保留。

### FR-004：权限与角色绑定

- 确认框展示源 → 目标路径；`Transfer` 与 `Agent` 工具绑定——角色白名单不含
  `Agent` 的角色同样不含 `Transfer`（Explorer 两者皆无；minimal / mixed 预设自然
  不含）。

### FR-005：宿主能力位与恒定清单

- 能力位 `hostEnvironmentProvided.crossWorkspaceTransfer` 只作用于执行
  （Electron true，VS Code / TUI false；位假时报「current host does not support
  cross-workspace transfer」）。工具定义与提示词段恒定注入所有宿主——前缀缓存按
  内容寻址、跨会话共享，会话中途增删工具会使前缀一次性全量失效。

### FR-006：提示词双形态与 reminder

- `### Transfer` 段随会话类型在创建时一次确定——普通会话与本地子代理为简述
  （一句能力定位 + 「仅在 cross-workspace ToolAgent 之后」），跨工作区子代理为
  详细形态（完整用法 + 点名发起方身份，由 `SessionState.transfer_counterpart`
  驱动）；详细用法正文是单一公共变量（`transfer_usage_lines`），与发起方带
  `target` 派发成功后注入的 reminder 正文逐字同源。措辞不出现 `Agent.target`
  点记号与 `@` 补全等模型不可见的 UI 概念。

### FR-007：中止语义

- abort 的 UiEvent 必经宿主中转：转发前取消该会话进行中的传输，执行器以
  「transfer canceled」收尾，Core 侧按「工具被中止」收敛；零新增事件。

## 行为规格

### 2.1 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| 传输请求 | `CoreRequest.crossWorkspaceTransferRequested`（两端身份缺省用 `null`） | 发起方 Core（阻塞等宿主应答） |
| 传输执行器 | `src/host/workspaceTransfer.ts` 的端点抽象 + 递归引擎 + 会话取消注册表 | 宿主（`WebViewUI.requestCrossWorkspaceTransfer`） |
| 两端解析 | `resolveTransferEnds`（缺省端 = 来源、未命中 / 歧义 / 同工作区 / 双非来源守卫） | 宿主 `crossWorkspaceRouting.ts` |
| 对端身份 | 跨工作区子代理的发起方身份（`SessionState.transfer_counterpart`） | 目标 Core（会话创建时一次写入） |

### 2.2 守卫矩阵（违反即工具错误，两端零写入）

- `sourcePath` / `targetPath` 缺失、空串、相对路径：入参错误 / 宿主报错。
- `sourceTarget` / `destTarget` 空字符串：入参错误（不静默当缺省）。
- 两端解析后是同一工作区（含两端都缺省）：提示同工作区复制用 Bash（cp / mv）。
- 两端都不是发起会话所属工作区：至少一端必须是本对话的工作区。
- 身份未命中 / 歧义 / 远程端连接未就绪：错误文案与 `Agent.target` 同族。
- 源路径不存在：点名路径。类型冲突（目录 ↔ 文件）：报错，已完成项保留。

### 2.3 事件成员

- `CoreRequest.crossWorkspaceTransferRequested`（发起方 Core → 宿主，等待期间切片
  轮询取消标记）→ `{ files, bytes, skippedSymlinks, sourceWorkspaceId,
  destWorkspaceId } / { error }`；
- `hostEnvironmentProvided.crossWorkspaceTransfer`（能力位）。
- 中止零新增事件：abort 的 UiEvent 必经宿主中转（`WebviewMessageHandler` 在转发
  `abortRequested` 前调 `cancelTransfersForSession`），执行器以「transfer canceled」
  收尾，Core 侧取消标记已置位 → 映射为「工具被中止」的结果形态。

## 3. 提示词与措辞

- 简述形态（普通会话 / 本地子代理，恒定）：

```text
### Transfer
## Transfer Tool

Moves files or directories between open workspaces, only after a cross-workspace ToolAgent (see the Agent tool).
```

- `### Agent` 段新增一条术语定义（唯一的既有段落改动）：

```text
- Dispatching with `target` set to another open workspace is a **cross-workspace ToolAgent**: the sub-agent runs in that workspace instead of the current one
```

- 详细形态（跨工作区子代理会话）= 边界句 + 公共用法正文（`transfer_usage_lines`，
  对端 = 发起方身份）；发起方 reminder（`run_agent` 带 `target` 成功派发后经
  `SuccessWithMessages` 注入的 isMeta silent 消息）= 开场句 + 同一公共正文
  （对端 = 本次目标身份）。两处消费不写第二份。
- 措辞约束：简述、详细、reminder 与工具入参描述不出现 `Agent.target` 点记号与
  `@` 补全等模型不可见的 UI 概念。

## 4. 边界与错误路径

- 传输中途 SSH 链路断开 / 目标端写失败：工具错误点名底层原因；逐文件原子性保证
  无半写文件（暂存名带 `.tuxedo-transfer-tmp` 后缀，rename 前失败即清理）。
- 传输进行中发起会话被中止：宿主取消传输，工具结果按「工具被中止」收尾；已完成
  文件保留、无半写文件。
- 非 Electron 宿主：工具恒在清单，执行报「当前宿主不支持」，两端零写入。
- 旧宿主缺 `crossWorkspaceTransfer` 字段按不支持处理（与 `crossWorkspaceAgent` 同款
  兼容口径，`core-rs/src/main.rs` 的 `unwrap_or(false)`）。
- 远程端非 `ssh` scheme 或非口令凭证（`WorkspaceEndpoint.auth` 非 `sshPassword`）：
  拒绝执行并报错——当前产品的远程凭证只有 SSH 口令一种。
- 宿主结果文本含文件数、字节数、跳过符号链接数与两端身份。

## 5. 非目标

- VS Code 宿主与 TUI 的跨工作区传输。
- 断点续传、差量同步、镜像删除（`--delete` 语义）、排除规则、权限位 / 修改时间
  保留、符号链接本身的复制。
- 传输进度的流式上报与专用工具卡片。
- 会话中途动态注入 / 移除工具（实测击穿前缀缓存，specs/028 调研结论）。

## 6. 对需求基线的影响

- [US-60](user-stories/desktop.md#us-60-跨工作区文件传输)（EP-9 多工作区）。
- e2e：`e2e/electron/crossWorkspaceTransfer.spec.ts`（US-60：本地↔本地递归传输、
  守卫零写入）。

## 7. 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `definitions` / `run_transfer`；`core-rs/src/tool_input.rs` 的 `transfer_fields` | `core-rs/src/tools_tests.rs` | 自动 |
| FR-002 | `src/host/crossWorkspaceRouting.ts` 的 `resolveTransferEnds`；`src/host/WebViewUI.ts` 的 `requestCrossWorkspaceTransfer`；`core-rs/src/engine.rs` 的 `transfer_hook` | `src/test/crossWorkspaceTransfer.test.ts`、`src/test/standaloneTransfer.test.ts` | 自动 |
| FR-003 | `src/host/workspaceTransfer.ts`（递归 / 覆盖合并 / 暂存改名 / 符号链接 / 中继）；`src/host/standalone/sshClient.ts` 的 `transferEndpoint` | `src/test/workspaceTransfer.test.ts`、`e2e/electron/crossWorkspaceTransfer.spec.ts` | 自动 |
| FR-004 | `core-rs/src/permission.rs` 的 `base_check` `Transfer` 分支 | `core-rs/src/tools_tests.rs`（角色绑定不变式） | 自动 |
| FR-005 | `src/shared/AssistantEventBus.ts`、三宿主发送点、`core-rs/src/config.rs` | `src/test/bootstrapWiring.test.ts`、`core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | `core-rs/src/prompt.rs` 的 `transfer_usage_lines` / `TRANSFER_BRIEF_DETAILS` / `transfer_reminder`；`core-rs/src/engine.rs` 的 `transfer_counterpart` | `core-rs/src/prompt_tests.rs`、`core-rs/src/tools_tests.rs` | 自动 |
| FR-007 | `src/host/ui/webviewMessageHandler.ts` 的 abort 中转取消；`core-rs/src/engine.rs` 的 `cancellable_request` | `src/test/workspaceTransfer.test.ts`、`core-rs/src/engine_tests.rs` | 自动 |

# 实施方案：Transfer 工具——跨工作区文件传输

> 前置：同目录 `spec.md` 已评审通过（含两轮修订：恒定工具清单、`Transfer` 与 `Agent`
> 角色绑定）。本文件只写技术路线与改动面，不复述需求。

技术路线：`Transfer` 是 Core 内置工具，执行时经新增 `CoreRequest.
crossWorkspaceTransferRequested` 阻塞请求宿主（对齐 `crossWorkspaceAgentRequested` 的
阻塞口径，`engine.rs` 的 `plain_request`）；宿主是唯一握有两端事实（本地路径 +
SSH endpoint）的角色，在 `src/host/` 新增传输执行模块完成解析守卫与搬运（本地 `fs` /
既有 `sshClient.ts` 的 SFTP / SSH↔SSH 宿主中继），结果回 Core 组装工具文本。工具定义
与提示词段恒定注入所有宿主（前缀一致性），能力位只在执行时拦截。

## 技术方案

### 1. 提示词与工具定义改动（重点）

**`core-rs/src/tools.rs` 的 `definitions()`**：在 `Reply` 与 `AskUserQuestion` 之间插入
（保持「Skill 恒最后」与「清单顺序 = Tool Details 顺序」两条既有不变量）：

```rust
// specs/028：跨工作区传输。定义恒定注入（含不支持的宿主，FR-005 前缀一致性），
// 能力位只在 run_transfer 执行时拦截。入参描述不出现 `Agent.target` 点记号与
// `@` 概念（FR-006 措辞约束）。
json!({
    "name": "Transfer",
    "description": "Transfer files or directories between open workspaces, for cross-workspace agent workflows only.",
    "input_schema": {
        "type": "object",
        "properties": {
            "sourcePath": { "type": "string", "description": "Absolute source path on the source workspace's machine" },
            "targetPath": { "type": "string", "description": "Absolute target path on the target workspace's machine" },
            "sourceTarget": { "type": "string", "description": "Source workspace agent ID (`hostname:path`). Omit for the current conversation's workspace" },
            "destTarget": { "type": "string", "description": "Destination workspace agent ID (`hostname:path`). Omit for the current conversation's workspace" }
        },
        "required": ["sourcePath", "targetPath"]
    }
}),
```

`## Tool Usage` 的列表行由 `tool_usage_section` 从 `definitions()` 自动生成，无第二份
（`- **Transfer**: Transfer files or directories between open workspaces, for
cross-workspace agent workflows only.`）。

**`core-rs/src/prompt.rs`：公共变量 + 简详双形态（FR-006）**。`### Transfer` 段在
`### Reply` 段之后、`### AskUserQuestion` 段之前插入（位置与 `definitions()` 一致）；
实现上把 `TOOL_DETAILS` 常量按插入点拆为两段，组装时把简述或详细形态插进其间——
普通会话的输出与拆分前逐字节一致，工具表顺序不变量保持。

- **公共变量 `transfer_usage_lines(counterpart)`**：详细用法正文（单一模板，`counterpart`
  为对端工作区身份占位），两处消费、不写第二份：
  1. 跨工作区子代理会话 Tool Details 的详细形态（对端 = 发起方身份）；
  2. 发起方 reminder 正文（对端 = 本次目标身份，`run_agent` 回填）。
- **简述形态常量**（普通会话与本地子代理），逐字文本（一句能力定位 + 时机限制，
  术语在 `### Agent` 段定义，不含 `Agent.target` / `@` 记号）：

```text
### Transfer
## Transfer Tool

Moves files or directories between open workspaces, only after a cross-workspace ToolAgent (see the Agent tool).
```

- **`### Agent` 段加一句术语定义**（唯一的既有段落改动）：在 `target` 相关 Usage
  bullet 之后插入——

```text
- Dispatching with `target` set to another open workspace is a **cross-workspace ToolAgent**: the sub-agent runs in that workspace instead of the current one
```

- **详细形态**（跨工作区子代理会话）= 边界句 + `transfer_usage_lines(发起方身份)`，
  逐字文本：

```text
### Transfer
## Transfer Tool

Moves files or directories (recursively) between this workspace and the creator workspace `{counterpart}`. For anything inside a single workspace, use Bash (cp / mv) instead.

- sourcePath / targetPath: absolute paths, each on its own machine; a remote path is never translated into local form
- sourceTarget / destTarget: workspace agent ID (`hostname:path`). Omit the end that is the current conversation's workspace; the other end here is `{counterpart}`
- At least one end must be the current conversation's workspace
- Directories transfer recursively; existing files are overwritten, existing directories are merged, nothing extra at the destination is deleted; symlinks are skipped and reported in the result
```

- **形态判定与传参**：形态随会话类型创建时一次确定、会话内恒定。`build_system_prompt_with_preset`
  与 `tool_usage_section` 增加 `transfer_counterpart: Option<&str>` 参数（`None` = 简述，
  `Some(id)` = 详细并回填对端）；`engine.rs` 在创建跨工作区子代理会话时把发起方身份
  （`originWorkspaceId`，派发载荷既有字段）存进会话状态，组装提示词时传入——
  `remote_sub_agent_system_prompt` 前缀模板**不再改动**（specs/025 FR-006 原样）。
- **发起方 reminder**：`run_agent` 在带 `target` 且派发成功时，把结果从 `Success` 升为
  `SuccessWithMessages`——文本不变，附一条 `{ type: 'user', isMeta: true }` 的
  `<Reminder>` 消息（与 `@` reminder、Skill 注入同一 silent 管道，引擎在工具结果后
  逐条 yield，无新机制），正文 = 开场句 + `transfer_usage_lines(本次 target)`。不带
  `target` 的调用不升档。逐字文本：

```text
<Reminder>
You just dispatched an agent to workspace "{counterpart}". To move files between the current workspace and "{counterpart}", use the Transfer tool:
- sourcePath / targetPath: absolute paths, each on its own machine; a remote path is never translated into local form
- sourceTarget / destTarget: workspace agent ID (`hostname:path`). Omit the end that is the current conversation's workspace; the other end here is "{counterpart}"
- At least one end must be the current conversation's workspace
- Directories transfer recursively; existing files are overwritten, existing directories are merged, nothing extra at the destination is deleted; symlinks are skipped and reported in the result
</Reminder>
```

提示词其余部分零改动：`### Agent` 段仅新增上述术语定义一句，`@` reminder、Skill 段
位置均不动。

### 2. Core 侧（core-rs）

- **`tools.rs`**：`execute` 增加 `"Transfer" => run_transfer(input, ctx)` 分支；
  `is_concurrency_safe` 不加新分支（默认假，写类工具）；`validate_input` 增加
  `Transfer` 分支（`sourcePath` / `targetPath` 缺失或纯空白 → `InputValidationError`，
  对齐 Bash 空命令口径）；新增 `TransferRequest`（五字段，`sourceTarget` / `destTarget`
  为 `Option<String>`）与 `TransferSummary`（`files` / `bytes` / `skippedSymlinks` /
  `sourceWorkspaceId` / `destWorkspaceId`）；`run_transfer`：入参解析（target 空串报错，
  对齐 `Agent`）→ 能力位检查（`config::cross_workspace_transfer()` 为假报「current host
  does not support cross-workspace transfer」）→ 经 `ctx.transfer` 钩子阻塞等宿主 →
  组装结果文本（文件数 / 字节数 / 跳过符号链接数 / `源身份 → 目标身份`）；钩子缺省
  （单测）时报「no transfer runtime available」（对齐 `Agent` 的钩子缺省文案）。
  另改 `run_agent`：带 `target` 且派发成功时结果升为 `SuccessWithMessages`，附
  `<Reminder>` 形态的 `Transfer` 详细 Usage（isMeta user 消息，复用 Skill 的
  newMessages 管道；正文复用 `transfer_usage_lines(本次 target)`，模板见第 1 节）；
  不带 `target` 不升档。
- **`ToolContext` 新增 `transfer` 钩子**（对齐 `subagent` 钩子的注入形态）：
  `Arc<dyn Fn(TransferRequest, &AtomicBool) -> Result<TransferSummary, String>>`，第二参
  是会话取消标记；引擎侧实现 = `plain_request`（发 `crossWorkspaceTransferRequested`）
  + 等待期间轮询取消标记，取消时提前返回，宿主侧按第 4 节自行收敛。
- **`tool_input.rs`**：`parse_input` 增加 `transfer_fields()`（四个字符串字段，两个
  必填、两个可选，schema 口径对齐 `agent_fields`）。
- **`permission.rs` 的 `base_check`**：`Transfer` 分支——路径 / target 入参非法直接
  `deny`；合法时 `ask`（确认文案含两端身份与源 / 目标路径，`displayArgs` 展示展开后
  路径），交 agentMode 加工。
- **`engine.rs`**：`subagent_hooks` 旁新增 `transfer_hook` 组装（包 `plain_request` 与
  取消轮询），注入 `ToolContext`；创建跨工作区子代理会话时把发起方身份
  （`originWorkspaceId`）存进会话状态（如 `transfer_counterpart: Option<String>`），
  组装提示词时作为 `transfer_counterpart` 传入（第 1 节形态判定）。
- **`config.rs`**：`HostEnvironment` 增加 `cross_workspace_transfer: bool` 字段与
  `cross_workspace_transfer()` 读取函数（对齐 `cross_workspace_agent` 的两条落点）。
- **角色绑定（FR-004）**：`sub_agent_role_tools` 白名单保持显式列举（Explorer 不加
  `Transfer`）；绑定不变式由 `tools_tests` 断言——对每个角色白名单，`Transfer` ∈ 白名单
  ⇒ `Agent` ∈ 白名单。单一落点 + 测试锁定，不做运行期过滤。

### 3. 契约（src/shared/AssistantEventBus.ts）

- `CoreRequest` 新增成员（全必选，缺省语义用 `null`）：

```ts
| {
    type: 'crossWorkspaceTransferRequested';
    sessionId: string;
    sourcePath: string;
    targetPath: string;
    /** null = 发起会话所属工作区（缺省端） */
    sourceTarget: string | null;
    destTarget: string | null;
  };
```

- `CoreRequestResultMap` 新增：

```ts
crossWorkspaceTransferRequested:
  | { files: number; bytes: number; skippedSymlinks: number; sourceWorkspaceId: string; destWorkspaceId: string }
  | { error: string };
```

- `hostEnvironmentProvided` 载荷新增必选字段 `crossWorkspaceTransfer: boolean`（Electron
  true，VS Code / TUI false），三处宿主发送点与 `bootstrapWiring.test.ts` 同步。

### 4. 宿主侧（src/host/ + electron/）

- **新模块 `src/host/workspaceTransfer.ts`**（纯逻辑、无宿主 API；fs 与 SSH 经参数注入
  便于单测）：
  - 输入：两端解析后的 `WorkspaceRef` + 路径 + `AbortSignal`；
  - 端适配：本地端用注入的 fs 适配器；远程端用注入的 SFTP 适配器（由
    `sshClient.ts` 的既有 `SshClientManager` 提供，一个 endpoint 一个实例，含
    stat / readdir / mkdir / rename / 读写）；
  - 递归遍历源树（SFTP `lstat` / 本地 `lstat` 判符号链接并跳过计数），逐文件
    「暂存名写入 + rename」落盘（对齐 [core-remote.md 第 2.8 节](../../docs/core/core-remote.md#28-ssh-接入ssh-scheme)的共享写安全口径），
    目标父目录按需 `mkdir -p`；同名文件覆盖、同名目录合并、类型冲突报错；
  - SSH↔SSH：源端读流 → 目标端暂存写 → rename，宿主中继，不经第三台机器；
  - 输出 `TransferSummary`；错误逐项点名路径与底层原因；
  - 按 `sessionId` 登记活跃传输的 `AbortController`。
- **`WebViewUI.ts`**：请求表新增 `crossWorkspaceTransferRequested` handler
  `requestCrossWorkspaceTransfer`——`connectionForSession` 定位来源工作区 → 两端身份经
  `resolveCrossWorkspaceTarget` 同口径解析（缺省端 = 来源 ref；`local` 分支即「该端是
  来源」）→ 守卫（两端同 ref / 两端都不是来源 / 未就绪 → `{ error }`）→ 路径绝对性
  按各自平台判（本地按宿主平台，远程按 POSIX）→ 调 `workspaceTransfer` 执行 → 回
  `{ files, ... }` / `{ error }`。
- **中止（FR-007）**：abort 的 UiEvent 路径必然经宿主中转（webview → 宿主 → Core）；
  宿主在转发 `abortRequested` 前先 `cancelTransfersForSession(sessionId)` 触发执行器
  `AbortController`，执行器以 `{ error: 'transfer canceled' }` 收尾请求；Core 钩子收到
  时若取消标记已置位，映射为既有「工具被中止」文案。零新增事件。
- **`electron/main.ts`、VSCode host、TUI**：`hostEnvironmentProvided` 补
  `crossWorkspaceTransfer` 字段（Electron `true`，其余 `false`）。

### 5. 测试

- `core-rs/src/tools_tests.rs`：入参校验矩阵（空路径 / target 空串 / 非字符串）、能力位
  拦截、钩子缺省报错、结果文本内容、角色绑定不变式、`definitions` 顺序不变量、
  `run_agent` 带 `target` 成功派发后 `SuccessWithMessages` 携带 reminder（含逐字目标
  身份）而缺省派发不携带。
- `core-rs/src/prompt` 相关测试：简述形态位于 `### Reply` 之后且不展开参数表、
  普通会话与本地子代理为简述形态、`### Agent` 段仅新增术语定义 bullet（其余未变）、
  跨工作区子代理会话为详细形态并逐字点名发起方身份（`build_system_prompt_with_preset` /
  `tool_usage_section` 的 `transfer_counterpart` 参数双分支）；reminder 正文与详细形态
  正文逐字同源（公共变量断言）；简述形态 / 详细形态 / reminder / 入参描述不含
  `Agent.target` 点记号与 `@` 记号（措辞约束断言）。
- `core-rs/src/engine_tests.rs`：transfer 钩子阻塞与取消路径。
- `src/test/workspaceTransfer.test.ts`：本地↔本地递归 / 覆盖 / 合并 / 父目录创建 /
  符号链接跳过 / 暂存改名 / 类型冲突（fs 桩）；守卫矩阵复用
  `src/test/crossWorkspaceRouting.test.ts` 形态。
- `src/test/bootstrapWiring.test.ts`：新字段三宿主对照。
- e2e：`e2e/electron/crossWorkspaceTransfer.spec.ts`（US-60）。

## 受影响模块与契约

| 模块 / 文件 | 改动 | 契约影响 |
| --- | --- | --- |
| `core-rs/src/tools.rs` | 新增 | `definitions` / `execute` / `validate_input` / `TransferRequest` / `TransferSummary` / `run_transfer` / `ToolContext.transfer` 钩子 |
| `core-rs/src/tool_input.rs` | 新增 | `transfer_fields` schema 校验 |
| `core-rs/src/permission.rs` | 新增 | `base_check` 的 `Transfer` 分支（ask + displayArgs） |
| `core-rs/src/engine.rs` | 新增 | `transfer_hook` 组装（`plain_request` + 取消轮询）并注入 `ToolContext`；跨工作区子代理会话状态记录发起方身份并传入提示词组装 |
| `core-rs/src/config.rs` | 新增 | `cross_workspace_transfer` 字段与读取函数 |
| `core-rs/src/prompt.rs` | 新增 | `transfer_usage_lines` 公共变量与 `### Transfer` 双形态段；`TOOL_DETAILS` 按插入点拆分、`build_system_prompt_with_preset` / `tool_usage_section` 增加 `transfer_counterpart` 形态参数 |
| `src/shared/AssistantEventBus.ts` | 新增 | `CoreRequest.crossWorkspaceTransferRequested`、`CoreRequestResultMap` 结果、`hostEnvironmentProvided.crossWorkspaceTransfer` |
| `src/host/WebViewUI.ts` | 新增 | 请求 handler `requestCrossWorkspaceTransfer`、abort 中转取消 |
| `src/host/workspaceTransfer.ts` | 新增 | 传输执行器（fs / SFTP 适配器注入、暂存改名、中继、AbortController） |
| `src/host/standalone/sshClient.ts` | 按需补 | SFTP 写入 / rename 助手（若现有面不足） |
| `electron/main.ts`、VS Code 宿主、TUI | 修改 | `hostEnvironmentProvided` 补字段（true / false / false） |
| 测试与 e2e | 新增 | 见「技术方案」第 5 节 |

## 宪章检查

- [x] 分层与依赖（[AGENTS.md 第 1 节](../../AGENTS.md#1-分层与依赖评审必查)）：`workspaceTransfer.ts` 在 `src/host/` 内、不
      import 宿主 API（fs / SFTP 经参数注入）；`WebViewUI.ts` 的 handler 不嗅探宿主
      类型；Core 只读能力位（铁律同 specs/023 FR-009）。
- [x] 架构铁律（[AGENTS.md 第 4 节](../../AGENTS.md#4-架构铁律docsarchitectureprinciplesmddocsarchitectureprinciplesmd)）：错误点名抛出不静默降级（守卫矩阵逐项报错）；
      契约成员全必选（缺省端用 `null`，不用 `?`）；传输执行只有宿主一个写入点，
      Core 只翻译结果；无新增配置默认值。
- [x] Core 行为与落盘格式同步义务（[AGENTS.md 第 5 节](../../AGENTS.md#5-工作流)）：不触会话落盘格式（meta /
      JSONL 不变），`src/shared/history/` 无改动——不涉及 + 理由：传输不写会话事实。
- [x] 文档同步义务（[AGENTS.md 第 0 节](../../AGENTS.md#0-文档要求)）：实施落地后同步
      [docs/architecture/events.md 第 2 节](../../docs/architecture/events.md#2-事件词汇表)
      （新 CoreRequest 成员、结果映射、`hostEnvironmentProvided` 载荷列）、新增
      `docs/features/cross-workspace-transfer.md` 并登记地图、
      [docs/features/user-stories.md](../../docs/features/user-stories.md) 与
      `user-stories/desktop.md` 的 US-60；`docsLint` 名单同步。

## 被否决的替代方案

1. **会话中途动态注入（defer loading）**：实测（opencode / DeepSeek 三通道）中途增删
   工具使前缀一次性全量失效（chat 通道仅余 ~7%，Responses / Anthropic 保留的也只是
   system 头部），对话历史全量按全价重读；恒注入的 ~400 token 从第二轮起走缓存价。
   已按实测否决（见会话调研记录，结论已并入 FR-005）。
2. **能力位收敛工具清单（旧 FR-005 形态）**：跨宿主前缀不一致，VS Code / TUI 会话
   与 Electron 会话不共享前缀头部；且与 `Agent` 工具「恒在清单、执行时报错」的先例
   不一致。用户决策否决。
3. **Core 侧执行（Bash 跑 scp / rsync）**：Core 无 SSH 凭据、无跨端工作区事实，
   `target` 解析只在宿主；且 Windows 本地无 rsync。否决。
4. **经 exec 跑 scp / rsync 代替 SFTP**：要求远端预装工具、SSH↔SSH 要求两台远程互达
   且互持凭据；SFTP 中继零额外依赖。否决。
5. **元工具模式（静态 dispatch 工具 + 消息下发动态清单）**：零前缀成本的唯一形态，
   但失去服务端 schema 校验、模型对工具的注意力变弱，与内置工具形态不一致。过度
   设计，否决（如未来需要可进 TODO.md 评估）。

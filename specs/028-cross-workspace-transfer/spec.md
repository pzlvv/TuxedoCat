---
status: 已收敛
---

# 改动规格：Transfer 工具——跨工作区文件传输

新增内置工具 `Transfer`，把文件 / 目录在两个已打开工作区之间递归传输：本机两个
本地工作区之间直接复制；涉及 SSH 远程工作区（本地↔SSH、SSH↔本地、SSH↔SSH）时由
宿主经既有 SSH 接入完成传输。两端以工作区代理身份（同 `Agent.target` 的
`<host>:<path>`）寻址，至少一端必须是发起对话所属的工作区；工具仅服务跨工作区场景，
主对话与子代理（Master）的系统提示词都写明这一边界。工具定义与提示词段在所有宿主
恒定注入（跨宿主前缀一致，见 FR-005）；VS Code 宿主与 TUI 不提供本能力，调用返回
工具错误。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/architecture/events.md](../../docs/architecture/events.md) | [第 2 节 事件词汇表](../../docs/architecture/events.md#2-事件词汇表) | 修改 | 新增 `CoreRequest.crossWorkspaceTransferRequested`（含结果映射）与 `hostEnvironmentProvided` 载荷字段 `crossWorkspaceTransfer`；docsLint 名单同步 |
| `<docs/features/cross-workspace-transfer.md>` | — | 新增 | 特性规格：工具形态、两端解析守卫、传输语义、提示词段（跨 Core / 宿主多 surface，独立成篇） |
| [docs/features/user-stories.md](../../docs/features/user-stories.md) | e2e 映射附录 | 修改 | 登记 `e2e/electron/crossWorkspaceTransfer.spec.ts` ↔ US-60 |
| [docs/features/user-stories/desktop.md](../../docs/features/user-stories/desktop.md) | EP-9 多工作区 | 修改 | 新增 US-60 跨工作区文件传输 |

## 用户场景与验收标准

- 场景 1：本地 ↔ 本地直接复制
  - **AC-1**（FR-001/FR-002）：GIVEN 本地工作区 A（发起会话）与本地工作区 B 均打开 WHEN 调 `Transfer`（`sourcePath` 为 A 下绝对路径、`targetPath` 为 B 下绝对路径、`sourceTarget` 缺省、`destTarget` 为 B 的身份）THEN 文件出现在 B 的 `targetPath`，结果文本包含文件数、字节数与两端身份。
  - **AC-2**（FR-003）：GIVEN 源是目录且含子目录与点文件 WHEN 传输 THEN 目标端目录结构与内容逐项一致（整棵递归，无排除项）。
  - **AC-3**（FR-003）：GIVEN `targetPath` 的父目录不存在 WHEN 传输 THEN 目标端父目录被自动创建后完成写入。
  - **AC-4**（FR-003）：GIVEN 目标端已存在同名文件 / 同名目录 WHEN 传输 THEN 同名文件被覆盖、同名目录逐项合并，目标端多余文件不被删除。
- 场景 2：涉及 SSH 远程工作区
  - **AC-5**（FR-003）：GIVEN 发起会话在本地工作区、`destTarget` 指向已打开的 SSH 工作区 WHEN 传输 THEN 传输经宿主对该工作区的 SSH 接入完成，远端 `targetPath` 出现内容。
  - **AC-6**（FR-003）：GIVEN 发起会话在 SSH 工作区 B、`sourceTarget` 为本地工作区身份、`destTarget` 缺省 WHEN 传输 THEN 内容从本地拉到 B 的 `targetPath`。
  - **AC-7**（FR-003）：GIVEN 发起会话在 SSH 工作区 B、另一端是 SSH 工作区 C WHEN 传输 THEN 传输完成，全程不要求 B 与 C 互相可达、不要求任一远程持有对方的登录凭据（宿主中继）。
- 场景 3：target 解析与跨工作区守卫
  - **AC-8**（FR-002）：GIVEN `sourceTarget` 与 `destTarget` 都显式指向发起会话所属工作区之外的身份 WHEN 调用 THEN 返回工具错误（至少一端必须是本对话的工作区），两端都不发生任何写入。
  - **AC-9**（FR-002）：GIVEN 两端解析后是同一工作区（含两端都缺省）WHEN 调用 THEN 返回工具错误并提示同工作区复制应使用 Bash，不发生传输。
  - **AC-10**（FR-002）：GIVEN 任一 target 未匹配打开集合 / 匹配多项 / 目标工作区连接未就绪 WHEN 调用 THEN 返回工具错误并点名类别与身份，不发生传输。
  - **AC-11**（FR-001）：GIVEN `sourceTarget` 或 `destTarget` 传空字符串 WHEN 调用 THEN 入参校验失败（与 `Agent.target` 空串同口径），不静默当缺省。
  - **AC-12**（FR-001）：GIVEN `sourcePath` / `targetPath` 缺失、为空串或相对路径 WHEN 调用 THEN 返回工具错误点名路径必须是非空绝对路径。
- 场景 4：权限、并发与宿主能力
  - **AC-13**（FR-004）：GIVEN manual 模式 WHEN 调 `Transfer` THEN 弹出确认框，内容含两端身份与源 / 目标路径；确认后执行、拒绝后不执行。
  - **AC-14**（FR-004）：GIVEN `Transfer` 与其他工具同批 WHEN 执行 THEN 不与相邻工具并行执行（写类工具）。
  - **AC-15**（FR-005）：GIVEN VS Code 宿主或 TUI WHEN 调 `Transfer` THEN 返回「当前宿主不支持」的工具错误，两端零写入。
  - **AC-16**（FR-005）：GIVEN Electron、VS Code、TUI 分别组装会话工具清单与系统提示词 WHEN 对比三份组装结果中的 `Transfer` 定义与说明段 THEN 逐字节一致且恒在（不随宿主能力位收敛）。
- 场景 5：提示词暗示与动态 Usage 注入
  - **AC-17**（FR-006）：GIVEN normal 预设的主对话 WHEN 组装系统提示词 THEN `### Transfer` 段为简述——一句能力定位加「仅在 cross-workspace ToolAgent 之后」，且该术语在 `### Agent` 段有定义；不展开参数表与传输语义。
  - **AC-18**（FR-006）：GIVEN 本地 Master 子代理 WHEN 组装系统提示词 THEN `### Transfer` 段为简述形态（与主对话同段）；子代理内不触发 reminder（嵌套禁止调用 `Agent`）。
  - **AC-23**（FR-006）：GIVEN 带 `target` 的 `Agent` 调用派发成功 WHEN 工具结果落位 THEN 紧随注入一条 silent reminder（isMeta、`<Reminder>` 包装），正文复用公共变量（与详细形态逐字同源）并逐字点名本次派发的目标身份。
  - **AC-24**（FR-006）：GIVEN 不带 `target` 的 `Agent` 调用 WHEN 工具结果落位 THEN 不注入 `Transfer` 的 reminder。
  - **AC-25**（FR-006）：GIVEN `Transfer` 简述形态、详细形态、reminder 文案与工具入参描述 WHEN 检查措辞 THEN 不出现 `Agent.target` 点记号与 `@` 补全等模型不可见的 UI 概念。
  - **AC-26**（FR-006）：GIVEN 跨工作区子代理会话 WHEN 目标 Core 组装系统提示词 THEN `### Transfer` 段为详细形态（含完整用法）并逐字点名发起方工作区身份。
  - **AC-27**（FR-006）：GIVEN 普通会话或本地子代理 WHEN 组装系统提示词 THEN `### Transfer` 段为简述形态、不展开参数表，且会话内不发生简详切换。
  - **AC-19**（FR-004）：GIVEN Explorer 子代理 WHEN 组装其工具清单 THEN 白名单不含 `Agent` 也不含 `Transfer`（`Transfer` 与 `Agent` 绑定）。
- 场景 6：中止与失败路径
  - **AC-20**（FR-007）：GIVEN 传输进行中 WHEN 发起会话被中止 THEN 传输被取消、工具结果按「工具被中止」收尾，已完成文件保留且无半写文件。
  - **AC-21**（FR-003）：GIVEN `sourcePath` 在源端不存在 WHEN 调用 THEN 返回工具错误点名路径，目标端零写入。
  - **AC-22**（FR-003）：GIVEN 传输进行中 WHEN SSH 链路断开 THEN 返回工具错误点名原因，已完成文件保持完整、目标端无半写文件（逐文件暂存 + 改名）。

## 功能需求

### FR-001：`Transfer` 工具与入参形态

- 新增内置工具 `Transfer`，定义插在 `Skill` 之前（保持 `Skill` 恒为最后一项）；
  执行入口与语义校验对齐既有工具四件套（`definitions` / `execute` / `validate_input` /
  `parse_input`）。
- 入参四项：
  - `sourcePath`（string，必填）：源路径，源端机器上的非空绝对路径；
  - `targetPath`（string，必填）：目标路径，目标端机器上的非空绝对路径；
  - `sourceTarget`（string，可选）：源工作区代理身份（`<host>:<path>`，语义同
    `Agent.target`）；缺省 = 发起会话所属工作区；空字符串 = 入参错误；
  - `destTarget`（string，可选）：目标工作区身份，语义同上。
- 两端路径各自按所在机器的语义解释（远程路径不套用本地规范化），Core 不做跨端转换。
- `Transfer` 是写类工具：不与相邻工具并行执行；传输不经对话上下文、流式搬运，无大小上限。

### FR-002：两端解析与跨工作区守卫（宿主侧）

- `Transfer` 的执行经新契约成员 `CoreRequest.crossWorkspaceTransferRequested` 发给宿主
  并阻塞等待结果（对齐 `crossWorkspaceAgentRequested` 的阻塞口径）；载荷携带
  `sessionId`、`sourcePath`、`targetPath` 与 `sourceTarget` / `destTarget`
  （缺省用 `null` 表示，契约成员全必选）。
- 宿主按打开集合解析两端身份，判定顺序复用 `Agent.target` 的口径：未命中 → 工具错误
  `target workspace is not open`；命中多项 → `target workspace identity is ambiguous`；
  任一端缺省 → 发起会话所属工作区。
- 解析后的守卫，违反即工具错误且两端零写入：
  - 两端是同一工作区（含两端都缺省）——本工具仅服务跨工作区场景，同工作区复制用 Bash；
  - 两端都不是发起会话所属工作区——至少一端必须是本对话的工作区；
  - 目标工作区打开但连接未就绪——`target workspace is not ready`。
- 结果契约：成功返回
  `{ files, bytes, skippedSymlinks, sourceWorkspaceId, destWorkspaceId }`（后两项是宿主
  解析后的身份回执，供结果文本使用），失败返回 `{ error }`。

### FR-003：传输执行语义

- 本机两个本地工作区之间：宿主直接递归复制，不经 SSH。
- 涉 SSH 端：宿主经该工作区的既有 SSH 接入完成读写；SSH↔SSH 由宿主中继（从源端读、
  向目标端写），不要求两台远程机器互相可达或互持凭据。
- 递归语义：源是文件 → 单文件；源是目录 → 整棵子树逐项复制，含点文件，无排除规则。
- 落盘语义：
  - 目标父目录不存在时自动创建；
  - 同名文件覆盖、同名目录逐项合并；不删除目标端多余项（无镜像 / `--delete` 语义）；
  - 类型冲突（源是目录而目标路径已存在同名文件、或反之）→ 工具错误，冲突项之前的
    已完成项保留；
  - 逐文件「暂存 + 改名」落盘：中止 / 失败不产生半写文件，已完成文件不回滚。
- 符号链接不跟随、不复制，跳过数进结果文本。
- 源路径不存在 → 工具错误点名路径，目标端零写入。
- 成功结果文本包含：传输文件数、字节数、跳过的符号链接数与两端身份
  （`<sourceWorkspaceId> → <destWorkspaceId>`）。

### FR-004：权限、并发与子代理可用性

- 权限判定为 ask：确认信息含两端身份与源 / 目标路径；agentMode 加工如常
  （auto / risk 放行、manual 保持询问）。入参非法（路径缺失 / 空串、target 空串）直接
  deny，不弹确认框。
- `is_concurrency_safe` 恒为假：不与相邻工具并行执行。
- 子代理可用性：`Transfer` 与 `Agent` 工具绑定——角色白名单不含 `Agent` 的角色同样
  不含 `Transfer`（Explorer 只读白名单两者都不含）；Master 全量工具两者都含；
  minimal / mixed 预设的工具白名单（Bash / Edit）自然不含，无特殊处理。

### FR-005：宿主能力位与恒定工具清单

- `hostEnvironmentProvided` 新增必选字段 `crossWorkspaceTransfer: boolean`：Electron 为
  true，VS Code 与 TUI 为 false；三处宿主发送点与 `bootstrapWiring` 同步。
- **工具清单与提示词恒定**：`Transfer` 的工具定义与说明段在所有宿主一律进入组装
  结果，不随能力位收敛（对齐 `Agent` 工具恒在清单、`target` 在不支持的宿主上报错的
  先例）。理由：前缀缓存按内容寻址、跨会话共享，工具清单逐字节恒定使各宿主、各会话
  共享同一前缀头部；会话中途增删工具会使前缀一次性全量失效，不做。
- 能力位只作用于执行：位假时调用 `Transfer` 返回「current host does not support
  cross-workspace transfer」的工具错误，不发生任何传输；Core 只读能力位，不做宿主
  类型嗅探。

### FR-006：提示词暗示与动态 Usage 注入（简详双形态）

- 共享 Tool Details 的 `### Transfer` 段有**简述 / 详细两种形态**，随会话类型在创建时
  一次确定、会话内恒定（不中途切换，FR-005 的前缀恒定不受影响）：
  - **简述形态**（普通会话与本地子代理）：一句能力定位 + 时机限制——跨工作区搬移
    文件 / 目录，**仅在 cross-workspace ToolAgent 之后**使用；不展开参数表与传输语义，
    不预告 reminder。
  - **详细形态**（跨工作区子代理会话）：传输边界 + 完整用法，逐字点名发起方工作区
    身份（派发载荷的 `originWorkspaceId`，不经模型工具入参）。
- **公共变量**：详细用法正文是单一共享模板（对端工作区身份为占位参数），两处消费、
  不写第二份——跨工作区子代理会话 Tool Details 的详细形态（对端 = 发起方身份）、
  发起方派发后的 reminder（对端 = 本次目标身份）。
- **发起方 reminder**：带 `target` 的 `Agent` 调用派发成功后，紧随工具结果注入一条
  silent 消息（isMeta、模型可见、UI 消息流不展示，`<Reminder>` 包装——与 `@`
  reminder 同款机制），正文复用公共变量、对端回填本次目标身份。不带 `target` 的调用
  不注入；每次带 `target` 的成功派发注入一条。
- **措辞约束**：简述形态、详细形态、reminder 与工具入参描述不出现 `Agent.target`
  点记号与 `@` 补全等模型不可见的 UI 概念；与 `Agent` 的联动以自然语言表达。
- Tool Details 基础段不随角色白名单裁剪（既有口径，Explorer 的提示词本就含
  `### Agent` 段），`### Transfer` 同口径；`### Agent` 段**仅新增一句术语定义**——
  「`target` 指向其他已打开工作区的派发是 cross-workspace ToolAgent（子代理运行在
  该工作区）」，供简述形态引用；`@` reminder 文案不改。
- 子代理内不能调用 `Agent`（嵌套禁止），reminder 不会在子代理内触发：本地子代理以
  简述形态与入参 schema 为信息源，跨工作区子代理以详细形态为信息源。

### FR-007：中止语义

- 传输进行中发起会话被中止：宿主取消进行中的传输，工具结果按「工具被中止」收尾
  （与既有工具被中止的结果形态一致）；已完成文件保留、无半写文件。

## 边界与错误路径

- `sourcePath` / `targetPath` 缺失、空串、相对路径：工具错误，点名「必须是非空绝对路径」。
- `sourceTarget` / `destTarget` 空字符串：入参校验失败（`sourceTarget must not be empty`
  口径），不静默当缺省。
- 身份未命中 / 歧义 / 目标未就绪：错误文案与 `Agent.target` 同族，点名身份。
- 两端同一工作区、两端都不是本对话工作区：工具错误，文案点名原因与替代（Bash）。
- 源不存在：工具错误点名路径，目标端零写入。
- 类型冲突：工具错误，已完成项保留。
- 传输中途链路断开 / 目标端写失败（磁盘满、权限拒绝）：工具错误并点名底层原因；
  逐文件原子性保证无半写文件。
- 传输期间目标文件被外部并发修改：逐文件暂存 + 改名保证最终态是完整的一份
  （本端内容），不做合并。
- 非 Electron 宿主：`Transfer` 照常在工具清单与提示词中；调用返回「当前宿主不支持」，
  两端零写入。

## 非目标

- VS Code 宿主与 TUI 的跨工作区传输（无多工作区模型）。
- 断点续传、差量同步（rsync 算法）、镜像删除（`--delete` 语义）。
- 权限位 / 修改时间 / 符号链接本身的保留（内容字节一致即可）。
- 排除规则（glob 过滤、忽略 `.git` 等）。
- 传输进度的流式上报与专用工具卡片（默认工具渲染即可）。
- `@` reminder 文案扩展（不改 specs/023 的 reminder 注入）。
- 自动打开未打开的工作区（两端只认已打开集合）。
- 传输内容审查与目录白名单（与 Bash / Write 同权，由权限确认把关）。

## 对需求基线的影响

- 新增 **US-60 跨工作区文件传输**（`Transfer` 工具、两端身份守卫、本地 / SSH 传输
  语义、递归与中止），落在 EP-9 多工作区。
- e2e 落点：`e2e/electron/crossWorkspaceTransfer.spec.ts`。
- 事件词汇表与 `hostEnvironmentProvided` 载荷扩一字段（docsLint 对照同步）；
  新增特性规格 `docs/features/cross-workspace-transfer.md` 并登记进 docs 地图。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `core-rs/src/tools.rs` 的 `definitions` / `run_transfer`、`core-rs/src/tool_input.rs` 的 transfer 字段校验 | `core-rs/src/tools_tests.rs` | 自动 |
| FR-002 | `src/shared/AssistantEventBus.ts` 的 `CoreRequest.crossWorkspaceTransferRequested`；`core-rs/src/engine.rs` 的阻塞请求；宿主侧解析守卫（`src/host/crossWorkspaceRouting.ts` 复用 + 传输守卫） | `core-rs/src/tools_tests.rs`、`src/test/crossWorkspaceRouting.test.ts`、`src/test/crossWorkspaceTransfer.test.ts` | 自动 |
| FR-003 | 宿主传输执行模块（本地递归复制 + SFTP 读写 + 暂存改名） | `src/test/crossWorkspaceTransfer.test.ts`、`e2e/electron/crossWorkspaceTransfer.spec.ts` | 自动 |
| FR-004 | `core-rs/src/permission.rs` 的 `base_check` 分支、`core-rs/src/tools.rs` 的 `is_concurrency_safe` 与角色白名单 | `core-rs/src/tools_tests.rs`、`core-rs/src/permission_tests.rs` | 自动 |
| FR-005 | `src/shared/AssistantEventBus.ts` 的 `hostEnvironmentProvided.crossWorkspaceTransfer`；三个宿主发送点；`core-rs/src/config.rs`；`core-rs/src/tools.rs` 的 `run_transfer` 能力位检查 | `src/test/bootstrapWiring.test.ts`、`core-rs/src/tools_tests.rs` | 自动 |
| FR-006 | `core-rs/src/prompt.rs` 的详细用法公共变量与 `### Transfer` 双形态段（`tool_usage_section` / `build_system_prompt_with_preset` 的形态参数）；`core-rs/src/engine.rs` 的会话类型判定（跨工作区子代理携带发起方身份）；`core-rs/src/tools.rs` 的 `run_agent`（reminder 复用公共变量） | `core-rs/src/prompt_tests.rs`（双形态、本地缺席、与 reminder 同源、措辞禁记号）、`core-rs/src/tools_tests.rs`（reminder 注入 / 不注入） | 自动 |
| FR-007 | `core-rs/src/engine.rs` 的取消标记接入 + 宿主取消传输 | `core-rs/src/engine_tests.rs`、`e2e/electron/crossWorkspaceTransfer.spec.ts` | 自动 |

## 待澄清

## 收敛记录

### 已满足

- FR-001 / AC-1..4、AC-11..12：`core-rs/src/tools_tests.rs` 的 `transfer_definition_position_and_schema` / `transfer_input_validation_matrix`；`definitions()` 中 Transfer 位于 Reply 与 AskUserQuestion 之间（`cargo test` 957 通过）。
- FR-002 / AC-8..10：`src/test/crossWorkspaceTransfer.test.ts`（缺省端 / 同工作区 / 双非来源 / 未命中 / 歧义九例矩阵）；CoreRequest 往返在 `core-rs/src/engine_tests.rs` 的 `transfer_hook_roundtrip_and_cancel`（载荷缺省端以 `null` 下发）。
- FR-003 / AC-1..4、AC-21..22：`src/test/workspaceTransfer.test.ts`（递归 / 覆盖合并 / 父目录 / 符号链接跳过与根链接整体跳过 / 类型冲突 / 源不存在零写入 / 暂存无残留）；整链路 `e2e/electron/crossWorkspaceTransfer.spec.ts`（真实 Electron 双工作区，递归落到目标 + 守卫零写入，2 passed）。
- FR-004 / AC-13..14、AC-19：`transfer_follows_agent_in_role_whitelists`（绑定不变式：Transfer ∈ 白名单 ⇒ Agent ∈ 白名单；Explorer 两者皆无）；权限分支非法入参 deny / 合法 ask 由 `permission.rs` 分支与既有 agentMode 加工路径承载。
- FR-005 / AC-15..16：`src/test/bootstrapWiring.test.ts`（能力位随宿主环境一次给齐）；非 Electron 报错由 `transfer_capability_gate_and_missing_hook` 锁定；恒定清单由 `definitions_cover_every_builtin_tool` 与 fixture 对照（toolSchema / systemPrompt 三宿主同一份）。
- FR-006 / AC-17..18、AC-23..27：`prompt_tests.rs` 的 `transfer_brief_details_position_and_agent_term` / `transfer_detailed_form_and_reminder_share_usage_lines`（公共变量逐字同源）/ `transfer_texts_avoid_invisible_notation`（无 `Agent.target` / `@` 记号）/ `local_sub_agent_prompt_keeps_brief_form`；注入与缺席由 `tools_tests.rs` 的 `agent_dispatch_appends_transfer_reminder`。
- FR-007 / AC-20：`core-rs/src/engine_tests.rs` 的取消路径（宿主不响应 + 取消标记置位立即收敛）；`workspaceTransfer.test.ts` 的会话取消注册表（abort 立即失败 / 未知会话 no-op / 收尾注销可重入）；e2e abort 由宿主中转取消承载。
- 文档同步：events.md 词汇表（76 事件 / CoreRequest 第 4 行 / 能力位载荷列）与新特性规格 `docs/features/cross-workspace-transfer.md` 均落地，docsLint 绿；`npm run test:all` 76 文件全绿（sidebarFiles 的跳过为 Windows 符号链接权限的既有环境行为，与本改动无关）。

### 偏差

- 无与 spec 相悖的实现。反向对照补记三处 spec 未明说、实施中落地的分支，均按既有口径并入 as-built 文档（不影响验收）：
  1. 旧宿主缺 `crossWorkspaceTransfer` 字段按 false 处理（`core-rs/src/main.rs`，与 `crossWorkspaceAgent` 同款兼容口径）；
  2. 非 `ssh` scheme 或非口令凭证的远程端拒绝执行并报错（`requestCrossWorkspaceTransfer` 的 `endpointFor`，当前产品仅 SSH 口令一种远程凭证）；
  3. `CoreRequest` 每种类型的 waiting 语义登记（`src/test/coreRequestWaiting.test.ts` 的 WAITING_REGISTRY 增 `crossWorkspaceTransferRequested: waiting=false`，登记完备性检查强制）。

### 未做

- 无。

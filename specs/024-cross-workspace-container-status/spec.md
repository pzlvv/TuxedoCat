---
status: 实施中
---

# 改动规格：跨工作区容器对话的状态灯与提示音策略

跨工作区子代理的占位父对话（容器，`ph_` 前缀）目前在侧栏是纯静态节点：不显示消息内容、
打开只显示跳转页（[specs/023 FR-004](../../docs/archive/specs/023-cross-workspace-agent/spec.md#fr-004占位父对话)）。
本规格做两件事。其一，容器行补上按其子代理运行时**派生**的状态灯（容器自身仍无运行时
事实），提示音策略定死：子代理完成静默、转入等待用户照常提醒——容器的提醒口径与
本地子代理一致（完成不提醒）。其二，容器的**会话级设置继承链**：容器承载发起方对话
的会话级设置快照（agent mode / thinking effort / 提示词模式 / 模型 provider 成对 /
联网搜索 / MCP 启用名单），其下子对话从容器继承，继承规则与本地子代理
（[specs/020 FR-003](../../docs/archive/specs/020-explorer-subagent-role/spec.md#fr-003按角色区分的会话级配置继承)）
一致。消息内容的隔离（不显示内容、不建立运行时）保持不变。

## 影响基线

| 基线文档 | 章节 | 变更 | 说明 |
| --- | --- | --- | --- |
| [docs/features/cross-workspace-agent.md 第 2 节 FR-003](../../docs/features/cross-workspace-agent.md#fr-003跨工作区子代理会话) | FR-003 跨工作区子代理会话 | 修改 | 会话级配置（agent mode / thinking / 提示词 / 模型 provider 成对 / 联网 / MCP 启用名单）经容器继承发起方，按 specs/020 FR-003 的角色继承规则应用（specs/024 FR-004） |
| [docs/hosts/electron-multi-workspace.md 第 9 节](../../docs/hosts/electron-multi-workspace.md#9-侧栏) | 侧栏 | 修改 | 容器行条目增加「状态灯按子代理运行时派生」的表述（点击行为与内容隔离不变） |
| [docs/hosts/host-matrix.md 第 6 节](../../docs/hosts/host-matrix.md#6-宿主固有差异有意保留) | 未读完成呼吸 / ConversationManager 实现对照表 | 修改 | 「灯条只挂顶层对话行」口径扩展到容器行（按子代理派生）；写明跨工作区子代理的任务结束提醒适用「子对话完成不提醒、转等待照常提醒」 |
| [docs/features/user-stories/desktop.md US-56](../../docs/features/user-stories/desktop.md#us-56-跨工作区代理) | US-56 验收标准 | 修改 | 第 2 条占位节点处增补容器状态灯；第 1 条增补子代理配置经容器继承发起方 |
| [docs/features/user-stories/desktop.md US-33](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒) | US-33 验收标准 | 修改 | 写明「子代理（含跨工作区）完成不提醒、转等待照常」在本 US 语义内的适用性 |

## 用户场景与验收标准

- 场景 1：派活后盯进度
  - **AC-1**（FR-001）：GIVEN 目标工作区侧栏显示跨工作区容器且其子代理会话正在运行 WHEN 侧栏渲染对话树 THEN 容器行显示运行流水灯（蓝），与普通对话行同款动效。
  - **AC-2**（FR-001）：GIVEN 同一容器下多个子代理并发且至少一个转入等待用户 WHEN 状态推送到达 THEN 容器行显示等待呼吸（黄），优先于运行流水。
  - **AC-3**（FR-001）：GIVEN 容器下没有非 idle 的子代理会话（全部空闲或尚无子代理） WHEN 状态推送到达 THEN 容器行不亮任何状态灯。
- 场景 2：完成静默、等待有声
  - **AC-4**（FR-002）：GIVEN 主窗口在后台、容器的子代理会话从运行转入空闲 WHEN 状态推送差分 THEN 不触发任务结束提醒（托盘不闪烁、不播放提示音）。
  - **AC-5**（FR-002）：GIVEN 主窗口在后台、容器的子代理会话从运行转入等待用户 WHEN 状态推送差分 THEN 触发一次任务结束提醒（托盘闪烁 + 播放一次提示音）。
- 场景 3：跳转页与内容隔离不变
  - **AC-6**（FR-003）：GIVEN 容器行点亮运行流水灯 WHEN 用户点击容器 THEN 仍显示跨工作区占位页（跳转页），不加载消息、不建立会话运行时。
- 场景 4：设置经容器继承
  - **AC-7**（FR-004）：GIVEN 发起方对话的会话级设置为模型 M / provider P / agent mode auto / thinking max / 提示词模式 mixed / 联网开 / MCP 启用名单 N WHEN 以 Master 角色派发到目标工作区 THEN 子代理会话以上述设置与名单运行，而不是目标工作区的默认值。
  - **AC-8**（FR-004）：GIVEN 非 Master 角色（如 Explore）从配置了非默认设置的发起方派发 WHEN 子代理创建 THEN 提示词预设固定 normal、联网恒关、MCP 恒空（角色口径），agent mode / 模型 provider 成对 / thinking 继承发起方。
  - **AC-9**（FR-004）：GIVEN 同一发起方对话先后两次派发且期间修改了模型 WHEN 第二次派发 THEN 容器设置随最近一次派发同步，新子对话继承修改后的值，已创建的子对话不受影响。
  - **AC-10**（FR-004）：GIVEN 发起方会话启用了 MCP 服务器名单 WHEN 以 Master 角色派发 THEN 子代理会话启用同一名单并落进其 meta 的 `context.mcpEnabled`；目标 Core 的定义集合里没有同名项的 server 不建立连接。

## 功能需求

### FR-001：容器行的状态灯按子代理运行时派生

容器行（`sessionId` 以 `ph_` 前缀标识的占位父对话）在侧栏对话树中按其**全部子代理会话**
（`parentSessionId` 指向该容器的真实会话）的运行时状态派生状态灯：

- 任一子代理非 idle → 容器行亮运行流水灯（蓝，流水滚动）；
- 其中任一子代理等待用户 → 容器行亮等待呼吸（黄），优先于运行；
- 全部子代理 idle（或没有子代理会话状态）→ 无灯。

忙闲级别判定复用 core 的 `sessionBusyLevel` 语义（waiting 优先、其次 running、idle
垫底，[docs/core/session-runtime.md](../../docs/core/session-runtime.md)），不在侧栏
另写一套判等。派生只读侧栏已收到的状态流快照（`sidebar:session-states-updated` 的
多 Connection 合并全量）与列表已建好的父子树，**不新增事件、不新增契约成员、不向
core 索取**——容器自身没有运行时事实，灯是子代理运行时的只读投影（
[架构原则第 7 节](../../docs/architecture/principles.md#7-一份事实只有一个写入点)、
[第 6 节](../../docs/architecture/principles.md#6-core-描述事实ui-决定表现)）。
容器行与普通顶层对话行同款动效，等待态与标题栏标签页流水灯同语义。

### FR-002：容器的子代理完成静默、等待用户照常提醒

容器本质是子代理容器，提醒口径与本地子代理对齐：

- 容器的子代理会话（`parentSessionId` 指向 `ph_` 容器）从运行转入空闲**不触发任务
  结束提醒**（托盘不闪烁、不播放提示音）——沿用「子对话完成不提醒」既有判定，
  跨工作区子代理的 `parentSessionId` 非空同样命中。
- 子代理从运行转入等待用户**照常触发**任务结束提醒（托盘闪烁 + 播放一次提示音）——
  沿用「转等待不受抑制」既有判定（ask user / 权限确认同样要提醒）。
- 发起方对话自身的轮次完成提醒语义不变（[US-33](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒)）。

本 FR 是既有托盘判定在跨工作区形态下的**锁定**（防容器亮灯后误把容器接入完成提醒），
不改变提醒通道的载体与音量策略。

### FR-003：容器行的点击行为与内容隔离不变

容器行亮灯不改变既有行为：点击仍显示跨工作区占位页（跳转页），不加载消息、不建立
会话运行时。「不显示内容」仅指消息内容——状态灯是对话列表行的属性，不属于内容。

### FR-004：容器的会话级设置继承链（发起方 → 容器 → 子对话）

- 派发时容器从发起方对话取得**会话级设置快照**：agent mode（工作模式）、thinking
  effort（思考强度）、提示词模式（prompt preset）、模型（model 与 provider 成对）、
  联网搜索（web search）、MCP 启用名单（server 名单）——以发起方会话当时的生效值为准
  （会话级覆盖优先、缺省回落全局默认），由发起方 Core 随派发请求携带。
- 容器下新建的子代理会话**继承容器的这份设置**，继承规则与本地子代理一致
  （[specs/020 FR-003](../../docs/archive/specs/020-explorer-subagent-role/spec.md#fr-003按角色区分的会话级配置继承)）：
  Master 角色全量继承；非 Master 角色维持角色固定（提示词预设恒 normal、联网搜索恒关、
  MCP 恒空），agent mode / 模型（model 与 provider 成对）/ thinking effort 仍继承。
- MCP 启用名单按**名单**继承：名单随子代理 meta 的 `context.mcpEnabled` 落盘；名单里
  的 server 在目标 Core 的定义集合中没有同名项时不建立连接（MCP 定义是机器本地资源，
  不跨机器拷贝）。
- 同一容器的多次派发：容器设置随每次派发同步为发起方当时的生效值；已创建的子对话
  不受后续派发影响（固定值在创建时一次确定，与本地子代理口径一致）。
- 契约面：`CoreRequest.crossWorkspaceAgentRequested` 与 `UiEvent.remoteSubAgentStarted`
  载荷新增上述设置字段（发起方 Core 侧填充、宿主透传、目标 Core 应用；成员必选，
  [架构原则第 2 节](../../docs/architecture/principles.md#2-不让接口--参数可选)）。

## 边界与错误路径

- 子代理会话的运行时快照尚未到达（刚派发 / 侧栏刚拉到列表）：容器行无灯——状态缺失
  用 undefined 表示等待态，不猜值（
  [架构原则第 10 节](../../docs/architecture/principles.md#10-webview-不持有事实的默认值)）。
- 子代理会话完成 / 被关闭后从快照消失：容器行灯随子代理状态消失；容器条目本身由
  子代理 meta 派生（[specs/023 FR-004](../../docs/archive/specs/023-cross-workspace-agent/spec.md#fr-004占位父对话)），
  最后一个子代理删除后容器条目消失，灯随之不存在。
- 目标工作区关闭 / 连接丢失：跨工作区子代理按结束收敛（specs/023 FR-010），子代理
  归 idle 后容器行灯熄灭。
- `parentSessionId` 指向的容器不在当前列表（列表未含 / 条目已被清理）：无行可亮，
  no-op——灯只存在于列表行上，不产生任何副作用。

## 非目标

- **不给容器行新增未读完成呼吸（绿色灯条）**：容器行为对齐子代理，完成在列表里保持
  静默（子代理行本就不挂呼吸条——「子会话的完成属于对话整体」，容器行亦不挂）；
  标题栏标签页的未读绿点等既有视觉不变。
- **webview 内嵌对话列表（浮窗模式）不同步本派生**：浮窗下列表由 webview 渲染，容器
  状态灯留待浮窗模式实际需要时另立 spec（去向：`TODO.md`）。
- 不改变完成提醒在发起方对话上的语义、不改变提示音的播放载体 / 音量策略（US-33）。
- 容器的状态灯派生（FR-001）不触契约面；契约面变更仅限 FR-004 的两条既有载荷新增
  设置字段——不新增事件类型、不改既有字段语义。
- 不在容器占位页上新增设置展示或修改入口（容器不可交互，设置只作为继承载体；
  子对话的设置 UI 照常展示继承值）。

## 对需求基线的影响

无新增 US：本规格是 [US-56](../../docs/features/user-stories/desktop.md#us-56-跨工作区代理)
（跨工作区代理）与 [US-33](../../docs/features/user-stories/desktop.md#us-33-系统托盘与任务提醒)
（任务结束提醒）既有场景的细化——容器状态灯与配置继承补进 US-56 验收标准（第 1 条
继承口径、第 2 条状态灯），提示音策略在 US-33 语义内（「子对话完成不提醒、转等待照常」
是 trayAttention 的既有判定）。
e2e：`e2e/electron/crossWorkspaceAgent.spec.ts` 扩展容器行状态灯断言（AC-1 / AC-3）与
继承断言（AC-7 的 Master 全量继承，经假 LLM 的请求体断言子代理会话的模型与预设）；
提示音（AC-4 / AC-5）为 OS 音频链路，按 US-33 既有口径登记真机核验豁免。

## 追溯矩阵

| 需求 | 实现落点 | 测试落点 | 覆盖 |
| --- | --- | --- | --- |
| FR-001 | `src/shared/sessionRuntime.ts` 的容器级别纯函数（按子代理状态集派生 waiting/running/idle）；`electron/sidebar/main.ts` 对话树渲染对容器行套用 | 纯函数单测（waiting 优先 / 全 idle 无灯 / 空集）；`e2e/electron/crossWorkspaceAgent.spec.ts` 容器行状态灯断言 | 自动 |
| FR-002 | 既有 `electron/trayAttention.ts` 的 `diffSessionEndEvents`（无代码改动） | 既有托盘差分单测扩展跨工作区形态（`parentSessionId: "ph_…"` 的完成抑制与转等待提醒） | 自动 |
| FR-003 | 既有 `electron/main.ts` 的 `showCrossWorkspacePlaceholder`（无代码改动） | 既有 `src/test/chatPlaceholderReason.test.ts` + e2e 占位页断言 | 自动 |
| FR-004 | `CoreRequest.crossWorkspaceAgentRequested` / `UiEvent.remoteSubAgentStarted` 载荷字段；`src/host/WebViewUI.ts` 透传；`core-rs/src/engine.rs` 的 `start_remote_sub_agent` 继承应用；`core-rs/src/mcp_config.rs` 的 `read_enabled_mcps` / `write_session_enabled`（MCP 名单） | `core-rs/src/engine_tests.rs`（Master 全量继承 / 非 Master 角色固定 / MCP 名单 / 载荷缺字段报错）；宿主透传单测；e2e 继承断言 | 自动 |

## 待澄清

（无——亮灯范围与完成静默口径已按用户原话定死；「容器行不挂完成呼吸」作为非目标
随本 spec 一并评审。）

## 收敛记录

收敛时由 /converge 填写，结论只分三类。

- 已满足：<FR / AC → 证据（实现与测试落点）>
- 偏差：<与 spec 的差异；改代码或改 spec 并留痕>
- 未做：<回写 tasks.md 的未完成项>

---
owner: pzlvv
last_reviewed: 2026-10-18
---

# 规格：Client 与 Connection

本规格描述宿主侧的连接模型。Client 是宿主级唯一实例，持有配置快照与路由；Connection 是
宿主与一个 Core 之间的一对一连接，是总线、就绪状态与生命周期的作用域。工作区表示、
Connection 生命周期、会话路由与就绪门禁都在本规格内确定。

Core 与 UI 的分离形态见 `docs/architecture/core-ui-separation.md`；Core（Rust 独立进程）
的进程形态见 `docs/core/standalone-core.md`；Core 进程的 daemon 见
`docs/core/core-daemon.md`。

参考 [docs/architecture/layering.md 第 2 节](../architecture/layering.md#2-规则清单)（分层与依赖规则）、[第 1 节](../architecture/events.md#1-总线契约)（核心契约：AssistantEventBus）、
[docs/hosts/host-bootstrap.md 第 1 节](../hosts/host-bootstrap.md#1-宿主接线)（宿主接线）、[docs/architecture/principles.md 第 7 节](../architecture/principles.md#7-一份事实只有一个写入点)（一份事实只有一个写入点）。

---

## 1. 能力

1. **两层**：Client 一个，Connection 每个工作区一个。
2. **Connection 随工作区创建**：一个工作区对应一个 Connection、一个 Core 进程；
   `openWorkspace` 恒开通道。
3. **同一工作区不可重复打开**：重复打开激活已有视图，不新建 Connection。
4. **工作区不可切换**：视图打开哪个工作区就属于哪个；换工作区只能关闭再打开。
5. **数量对上层透明**：调用方经 `connectionForWorkspace()` 取连接，不假设连接数量。
6. **配置快照是 Client 级的**：一份快照推给所有 Connection。
7. **就绪门禁在 Client 侧**：Connection 未就绪时不投递任何 `UiEvent`。
8. **连接身份是内部概念**：`connectionId` 不进入总线契约，不向用户展示。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| Client | 宿主级唯一实例：配置快照、路由表、连接集合 | host |
| Connection | 宿主与一个 Core 之间的一对一连接 | host |
| connectionId | Connection 的内部标识 | host |
| 工作区引用 | `{ scheme, path, endpoint }` | host |
| 总线 | `AssistantEventBus`；作用域是单个 Connection | 契约由 core 定义 |
| 就绪 | Core 已处理宿主环境与配置快照 | core 产生，host 消费 |
| 配置快照 | 规范化后的全局配置与 MCP 服务器表 | host |

---

## 3. 分层

```
webview ── Client ── Connection A ── bus ── Core A
                  └─ Connection B ── bus ── Core B
```

Client 持有：

- 配置快照（`SettingsStore`）；
- `workspaceId → connectionId` 主表；
- `sessionId → connectionId` 派生表；
- 会话列表聚合；
- 就绪门禁。

Connection 持有：

- 总线（1:1）；
- Core 通道（本机 `stdio` 直起的 Core 进程，或 daemon channel）与进程句柄；
- 就绪状态；
- 该工作区的会话集合；
- 连接身份。

### 3.1 总线作用域

- 一个 Connection 内，总线是唯一的、单例的；`requireEventBus()` 在宿主进程内解析为
  Client（按会话 / 工作区路由到对应 Connection 的总线）。
- Core 侧的进程级状态天然每进程一份，不需要跨 Connection 共享。

### 3.2 装配形态

- 每个打开的工作区一个 Connection：本机工作区直接以 `stdio` 动作起一个 Core 进程；
  远程工作区连该 endpoint 的 daemon、每个工作区一条 channel。
- 没有打开的工作区时用空引用占位（`emptyWorkspaceRef`）开一个 Connection，保证宿主
  环境与配置快照在启动期送达、空态视图的只读请求（技能列表 / 对话列表等）仍可应答；
  打开第一个真实工作区时这个占位 Connection 被关闭。
- 工作区是 Connection 的归属；配置快照经帧通道传递。

---

## 4. 工作区引用

| 字段 | 含义 | 本地取值 | 远程取值 |
| --- | --- | --- | --- |
| `scheme` | 这类工作区怎么接 | `file` | `ssh`（全部通信走 SSH 端口）；`wsl` / `container` 预留 |
| `endpoint` | 接哪台机器、用什么凭证 | `null` | `{ host, port, user, auth }` |
| `path` | 那台机器上的目录 | `d:\git\demo` | `/home/alice/src/demo` |

- `(scheme, endpoint)` 决定 Connection 的目标；`path` 是 Core 的会话工作目录。
- 未打开工作目录时用空引用占位（`emptyWorkspaceRef`：`path` 为空串）；它没有目录，
  去重键（`workspaceRefKey`）只取 `(scheme, endpoint)`，不进本地路径规范化
  （`path.resolve('')` 得到宿主进程的当前目录，会与真实工作区撞键）。
- **Core 只见 `path`**：endpoint 与凭证不下发到 Core，也不进入配置快照。
- `auth` 是判别联合，`kind` 唯一决定控制通道怎么建（[docs/core/core-remote.md 第 2 节](core-remote.md#2-远程服务start--kill)）：
  只有 `{ kind: 'sshPassword' }`（`ssh`，口令只用于建 SSH 连接）。
- `ssh` 下 `host` / `port` 是 SSH 的地址与端口，daemon 的端口由引导流程从远端状态文件
  取得，不写进引用。
- `workspaceEndpointKey` 取 `(scheme, user, host, port)`：同一 endpoint 的多个工作区共用
  一个 daemon。
- VS Code 的 workspace URI（`scheme://authority/path`）是取值的来源：`scheme` 取 URI 的
  scheme，`endpoint` 由 authority 解析，`path` 取 URI 的 path。当前实现只取了
  `uri.fsPath`（`src/VSCodeUIHost.ts`），本规格要求把 scheme 与 authority 一并保留。

### 4.1 与 Core 数据目录的关系

- Core 的数据目录仍是 `~/<CONFIG_DIR_NAME>`，按 Core 实例一份，在 Core 所在机器上；
  `getConfigHomeDir()` 的语义不变（[docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)）。
- 会话目录名仍由 `path` 派生（`encodeURIComponent`，超长走哈希），**不引入工作区身份**：
  不同机器上的相同路径落在各自 Core 的数据目录里，不会相撞。
- `meta.json` 的 `project` 字段仍存 `path`。
- Spin 设计的 `spin.json` 与 `workspace.meta.json` 一样落在各 Core 实例的会话目录；
  设计器经 `UiRequest.spinDesignRequested` / `spinDesignSaveRequested` 访问，宿主不按
  本地路径读写（[docs/core/standalone-core-boundaries.md 第 2 节](standalone-core-boundaries.md#2-宿主侧的-core-事实读取)）。

### 4.2 远程打开流程（Electron）

1. 菜单 / 标题栏加号选「打开远程工作区」，填 SSH 表单（IP / 端口 / 用户 / 口令）；
   Host 自动部署并启动远端 Core（[docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)）；
2. Host 把输入收敛成 `endpoint`，**连接成功后立刻**列出远端主目录，弹出远端目录选择器
   （[docs/core/core-remote.md 第 2.6 节](core-remote.md#26-远端目录选择)）；
3. 选定目录后按 `remoteWorkspaceRef` 加入打开集合：`(scheme, endpoint, path)`；
4. 打开该工作区时复用同一条控制通道发 `openWorkspace`。

- `scheme` 恒为 `ssh`（`src/host/workspaceRef.ts::remoteWorkspaceRef`）。
- 「连接」这一步包含部署与启动，可能较慢；窗口在此期间显示进度提示。
- **SSH 连接历史**（`src/host/sshHistory.ts`）：SSH 接入**连上即**记入
  `recentSshConnections`（以「连上」为准，不是「选完目录」——用户可能停在目录选择
  这一步，下次仍要一键回填）。host 输入框聚焦时弹出最多 6 条候选，文案
  `<user>@<host>(:port)`（端口 22 不显示）；关键字对 `user@host` / `user@host:port` /
  裸 `host` 匹配，**前缀匹配排在非前缀匹配之前**、同级按最近连接在前。候选列表**不含
  口令**（展示与筛选只要 host / 端口 / 用户）；选定候选后按去重键单独取整条（含口令）
  回填表单——口令只在用户显式选定的那一次跨进程，不随整表常驻页面；候选行右侧的
  删除按钮清掉这条历史。

---

## 5. Connection 生命周期

| 事件 | 行为 |
| --- | --- |
| 打开工作区 | 建立 Connection：本机直接以 `stdio` 起一个 Core 进程，远程经该 endpoint 的 daemon 开 channel |
| 重复打开同一工作区 | 不新建 Connection；激活已有视图 |
| 关闭工作区 | 销毁 Connection；关闭 Core 进程（daemon 计数递减） |
| 宿主退出 | 销毁全部 Connection；关闭所有 Core |
| 工作区切换 | 不允许；只能关闭再打开 |

- `connectionId` 自动生成；`local-` / `remote-` 前缀用于区分来源。取值不进入总线载荷，
  也不向用户展示。
- 同一工作区在宿主内至多一个 Connection。跨宿主实例（两个 VS Code 窗口 / 两个 Electron
  实例）各自独立，互不感知。

---

## 6. 会话路由

- Client 维护 `workspaceId → connectionId` 主表；`sessionId → connectionId` 是派生表。
- 新建会话落在当前工作区的 Connection。
- 会话 ID 由 webview 生成（`session_<timestamp>_<random>`），在 Client 范围内唯一；
  登记冲突时以先登记者为准并报错，不做静默覆盖。
- 加载历史会话时，Client 按主表推导归属；推导不出时向各 Connection 查询会话列表，
  仍查不到则报错。
- 只有一个**存活**的 Connection 时，查不到归属的会话按它登记（数量对上层透明的退路）；
  已进入关闭流程的 Connection 在 `dispose()` 之前就从主表与派生表摘除，既不参与这个
  数量判定，也不再是路由目标（`dispose()` 要等 Core 进程退出，等待期不得继续被路由）。
- Connection 收到的 `CoreEvent` / `CoreRequest` 交给 Client；Client 按 `sessionId` 分发。
  总线载荷不带 `connectionId`。
- 宿主按工作区路径登记会话归属（`sessionWorkspaceAssigned`）时，**本地路径按宿主口径判等、
  远程路径逐字比较**（远程路径是目标机器上的字符串，跑本地规范化会把它变成
  `D:\home\pz\proj` 这种错误值，两个 Connection 并存时会直接路由失败）。
- 删除 / 重命名 / 会话配置变更等按 `sessionId` 路由到对应 Connection。

---

## 7. 就绪状态机

| 状态 | 含义 | 允许的操作 |
| --- | --- | --- |
| `connecting` | Connection 已建立，尚未收到 `coreReady` | 不投递 `UiEvent`；不发起 `requestCore` |
| `ready` | Core 已处理宿主环境与配置快照 | 正常投递 |
| `closed` | Connection 已销毁 | 不投递 |

- 就绪判据由 Core 侧定义：Core 处理完 `hostEnvironmentProvided`（含配置快照）后发出
  `CoreEvent.coreReady`。
- `coreReady` 幂等：同一 Connection 内重复到达只生效一次。
- **门禁在 Client 侧**：未就绪期间的 `UiEvent` 一律不发出。Core 侧对应地拒绝：
  就绪前收到任何 `UiEvent` 记 log 丢弃，把顺序错误变成启动日志可见的诊断
  （[docs/architecture/events.md 第 6 节](../architecture/events.md#6-边界语义)）。
- 一个 Connection 未就绪不影响其它 Connection。
- 重连不在本规格范围内（第 10 节）。

---

## 8. 配置快照

- 快照是 Client 级的：`SettingsStore` 读磁盘、补默认值、规范化后产出一份；每个 Connection
  就绪时推同一份。
- Connection 建立时推送；快照变化时推给所有已就绪的 Connection。
- 快照的字段、默认值来源、同步点清单与写盘规则见 [docs/architecture/core-ui-separation.md 第 4 节](../architecture/core-ui-separation.md#4-配置归-ui)。

---

## 9. 落盘与恢复（宿主侧）

打开集合与最近列表由宿主落盘在 `userData/workspace-state.json`，本地项与远程项同格式
（序列化实现见 `src/host/workspaceState.ts`）：

| 字段 | 内容 |
| --- | --- |
| `openWorkspaces` | 打开集合（按标签页顺序）：本地项是路径字符串，远程项是 `{ scheme, path, endpoint }` |
| `activeWorkspaceKey` | 活动项的去重键（`workspaceRefKey`） |
| `recentWorkspaces` | 最近打开的工作区（最多 20 个，最近的在最前），与 `openWorkspaces` 同格式 |
| `recentSshConnections` | SSH 连接历史（最多 20 条，最近连接在前）：`{ host, port, user, password }`，同一 `user@host:port` 只留最新一条；口令明文，供「打开远程工作区」的表单回填与候选（第 4.2 节） |

- **远程凭证明文落盘**：`endpoint.auth`（`sshPassword`）随引用一起写进
  `workspace-state.json`，SSH 连接历史里的口令同一条规则。这是「重启后直接恢复并打开
  已连接过的工作区」的前提；该文件属于宿主本地状态，不进 core、不进配置快照、不参与
  会话数据。
- **启动恢复与可用性判定**：本地项在恢复时检查目录是否存在，不存在的**保留在打开集合里**
  并标记为不可用；远程项从启动起处于建链中，由宿主经 `probeRemoteEndpoint` 逐 endpoint
  探测落定（传输层建链，**3 秒建链超时，远端引导不计入**——opener 的 `prepare` 先完成
  发现 / 部署 / 启动（冷部署上传产物可能远超 3 秒），3 秒只管 daemon 就绪后的建链；同一
  endpoint 只探测一次，SSH 引导按目标去重，探测与正式连接不重复部署；正式连接的长超时
  不适用于此），daemon 存活但工作区 channel 建失败等形态由 `onWorkspaceConnectionState` 的
  lost 信号兜底（只对从未就绪的远程 Connection 标记，曾就绪过的 Core 退出走重启策略）。
  不可用的工作区保留标签页且可正常激活，但聊天区显示占位页（不显示对话列表与 webview）：
  目录不存在显示「目录不存在」，远程不可连显示「无法连接远程主机」并提供重新连接按钮
  （重连期间转建链中，同一 3 秒建链超时；成功撤销判定、补建 Connection 并切回对话视图）。
  活动项
  不因不可用而回退；可用的引用（含远程）交给 `Client.openWorkspace` 建立 Connection，
  远程项按落盘凭证重新走一遍 SSH 引导（[docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)）。连不上不影响
  其它工作区。
- **最近列表**：本地项在读取时过滤掉已不存在的目录；远程项无法本地检查，原样保留。
  关闭标签页只从打开集合移除，不抹掉最近列表里的凭证。
- 读取口径：形状不合法（缺 host、端口越界、认不出的凭证种类等）的项整项丢弃，
  不猜、不补默认值（[docs/architecture/principles.md 第 1 节](../architecture/principles.md#1-不过度-fallback)）。

---

## 10. 不覆盖范围

- 远程凭证的加密存储与钥匙串集成（当前是明文落盘，见第 9 节）；
- SSH 的密钥 / agent 认证（当前只有口令）；
- 远程 daemon 的部署由 Host 自动完成（[docs/core/core-remote.md 第 2.8 节](core-remote.md#28-ssh-接入ssh-scheme)）；
- 断线重连（含远程工作区在重启后连不上时的自动重试）；
- 多 Connection 的界面呈现（归属标识、切换入口）。

---

## 11. 验收要点

1. 打开一个工作区建立一个 Connection；重复打开只激活已有视图。
2. 两个工作区对应两个 Connection、两个 Core 进程。
3. 没有打开的工作区时以空引用占位；打开第一个真实工作区时占位 Connection 关闭。
4. Client 未收到 `coreReady` 前不发出任何 `UiEvent`；Core 在就绪前收到 `UiEvent` 记 log 拒绝。
5. 一份配置快照推给所有 Connection，Connection 之间不共享内存状态。
6. `connectionId` 不出现在任何总线载荷中。
7. 关闭工作区后 Connection 销毁；daemon 计数递减，归零后按 `docs/core/core-daemon.md` 退出。
8. 会话按 `sessionId` 路由到正确 Connection；查不到归属时报错。
9. 同一 endpoint 的多个工作区共用一个 daemon；不同 endpoint 各自独立。
10. 远程连接失败时报错，不建立 Connection。
11. 关闭并重启宿主后，打开集合里的本地与远程项都被恢复；远程项按落盘凭证重新接入。
12. 最近列表同时包含本地与远程项；远程项按 id 打开（同一路径在不同机器上是两项）。
13. 状态文件里形状不合法的项被丢弃，不影响其余项的恢复。

---

## 12. 落点对照

| 规格项 | 落点 |
| --- | --- |
| Client | `src/host/Client.ts` |
| Connection | `src/host/Connection.ts` |
| 配置快照 | `src/host/SettingsStore.ts` |
| 工作区引用 | `src/host/workspaceRef.ts`、`src/host/UIHost.ts`（`WorkspaceProvider`） |
| 打开集合 / 最近列表的落盘与恢复 | `src/host/workspaceState.ts`、`electron/main.ts`（`workspace-state.json`） |
| 就绪门禁与会话路由 | `src/host/Client.ts` |
| 启动接线 / endpoint → daemon 注册表 | `src/host/bootstrapCore.ts` |
| 远程连接与目录选择 UI | `electron/main.ts`、`electron/remoteWorkspace/`（vite 页面）、`electron/remoteWorkspacePreload.ts` |

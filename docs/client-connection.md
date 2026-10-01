# 规格：Client 与 Connection

本规格描述宿主侧的连接模型。Client 是宿主级唯一实例，持有配置快照与路由；Connection 是
宿主与一个 Core 之间的一对一连接，是总线、就绪状态与生命周期的作用域。工作区表示、
Connection 生命周期、会话路由与就绪门禁都在本规格内确定。

Core 与 UI 的分离形态见 `docs/core-ui-separation.md`；Standalone 进程形态见
`docs/standalone-core.md`；Core 进程的 daemon 见 `docs/core-daemon.md`。

参考 `DEVELOPMENT.md` 第 2 节（分层与依赖规则）、第 3 节（核心契约：AssistantEventBus）、
第 8.6 节（宿主接线）、第 12.7 节（一份事实只有一个写入点）。

---

## 1. 能力

1. **两层**：Client 一个，Connection 每个工作区一个。
2. **Connection 随工作区创建**：一个工作区对应一个 Connection、一个 Core 进程。
3. **同一工作区不可重复打开**：重复打开激活已有视图，不新建 Connection。
4. **工作区不可切换**：视图打开哪个工作区就属于哪个；换工作区只能关闭再打开。
5. **数量对上层透明**：调用方经 `connectionForWorkspace()` 取连接，不假设连接数量。
6. **配置快照是 Client 级的**：一份快照推给所有 Connection。
7. **就绪门禁在 Client 侧**：Connection 未就绪时不投递任何 `UiEvent`。
8. **连接身份是内部概念**：`connectionId` 不进入总线契约，不向用户展示。
9. **装配形态互斥**：`embedded` 与 `standalone` 二选一；`embedded` 恒一个 Connection。

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
- Core kind 与进程句柄（standalone），或进程内 Core（embedded）；
- 就绪状态；
- 该工作区的会话集合；
- 连接身份。

### 3.1 总线作用域

- 一个 Connection 内，总线是唯一的、单例的；`requireEventBus()` 在该作用域内解析。
- `standalone` 下 Core 侧的进程级状态天然每进程一份，不需要跨 Connection 共享。
- `embedded` 下只有一个 Connection，`setGlobalEventBus()` 的进程级单例语义保持现状。

### 3.2 装配形态的差异

| | `embedded` | `standalone` |
| --- | --- | --- |
| Connection 数量 | 恒 1 | 每个打开的工作区 1 个 |
| Core | 进程内，`initializeCoreEvents` | 独立进程，经 daemon 起 |
| 工作区 | 会话的属性（沿用现状） | Connection 的归属 |
| 配置快照 | 同一份，进程内传递 | 同一份，帧通道传递 |

差异只在进程边界，不在契约：两种形态对 UI 呈现同一份事件词汇表。

---

## 4. 工作区引用

| 字段 | 含义 | 本地取值 | 远程取值 |
| --- | --- | --- | --- |
| `scheme` | 这类工作区怎么接 | `file` | `ssh` / `wsl` / `container`（预留） |
| `endpoint` | 接哪台机器、用什么凭证 | `null` | `{ host, port, user, auth }` |
| `path` | 那台机器上的目录 | `d:\git\TuxedoCat` | `/home/alice/src/tuxedo-cat` |

- `(scheme, endpoint)` 决定 Connection 的目标；`path` 是 Core 的会话工作目录。
- **Core 只见 `path`**：endpoint 与凭证不下发到 Core，也不进入配置快照。
- VS Code 的 workspace URI（`scheme://authority/path`）是取值的来源：`scheme` 取 URI 的
  scheme，`endpoint` 由 authority 解析，`path` 取 URI 的 path。当前实现只取了
  `uri.fsPath`（`src/VSCodeUIHost.ts`），本规格要求把 scheme 与 authority 一并保留。
- 远程连接本规格不实现，但取值与传递路径按上表固定，实现时不得另立形态。

### 4.1 与 Core 数据目录的关系

- Core 的数据目录仍是 `~/<CONFIG_DIR_NAME>`，按 Core 实例一份，在 Core 所在机器上；
  `getConfigHomeDir()` 的语义不变（`docs/core-ui-separation.md` 第 4 节）。
- 会话目录名仍由 `path` 派生（`encodeURIComponent`，超长走哈希），**不引入工作区身份**：
  不同机器上的相同路径落在各自 Core 的数据目录里，不会相撞。
- `meta.json` 的 `project` 字段仍存 `path`。

---

## 5. Connection 生命周期

| 事件 | 行为 |
| --- | --- |
| 打开工作区 | 建立 Connection；`standalone` 下经 daemon 起一个 Core 进程；`embedded` 下复用进程内 Core |
| 重复打开同一工作区 | 不新建 Connection；激活已有视图 |
| 关闭工作区 | 销毁 Connection；`standalone` 下关闭 Core 进程（daemon 计数递减） |
| 宿主退出 | 销毁全部 Connection；`standalone` 下关闭所有 Core |
| 工作区切换 | 不允许；只能关闭再打开 |

- `connectionId` 自动生成；`local-` / `remote-` 前缀用于区分来源。取值不进入总线载荷，
  也不向用户展示。
- 同一工作区在宿主内至多一个 Connection。跨宿主实例（两个 VS Code 窗口 / 两个 Electron
  实例）各自独立，互不感知。
- `embedded` 下不按工作区建 Connection：恒一个，工作区仍是会话属性。

---

## 6. 会话路由

- Client 维护 `workspaceId → connectionId` 主表；`sessionId → connectionId` 是派生表。
- 新建会话落在当前工作区的 Connection。
- 会话 ID 由 webview 生成（`session_<timestamp>_<random>`），在 Client 范围内唯一；
  登记冲突时以先登记者为准并报错，不做静默覆盖。
- 加载历史会话时，Client 按主表推导归属；推导不出时向各 Connection 查询会话列表，
  仍查不到则报错。
- Connection 收到的 `CoreEvent` / `CoreRequest` 交给 Client；Client 按 `sessionId` 分发。
  总线载荷不带 `connectionId`。
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
- **门禁在 Client 侧**：未就绪期间的 `UiEvent` 一律不发出。Core 侧对应地做硬断言：
  就绪前收到任何 `UiEvent` 直接抛错，把顺序错误变成启动期错误（`DEVELOPMENT.md` 第 12 章）。
- 一个 Connection 未就绪不影响其它 Connection。
- 重连不在本规格范围内（第 9 节）。

---

## 8. 配置快照

- 快照是 Client 级的：`SettingsStore` 读磁盘、补默认值、规范化后产出一份；每个 Connection
  就绪时推同一份。
- Connection 建立时推送；快照变化时推给所有已就绪的 Connection。
- 快照的字段、默认值来源、同步点清单与写盘规则见 `docs/core-ui-separation.md` 第 4 节。

---

## 9. 不覆盖范围

- 远程工作区的实现（传输、凭证存储、远程 daemon 部署）；
- 断线重连；
- 多 Connection 的界面呈现（归属标识、切换入口）；
- 连接目标的存储格式与配置入口。

---

## 10. 验收要点

1. 打开一个工作区建立一个 Connection；重复打开只激活已有视图。
2. 两个工作区对应两个 Connection、两个 Core 进程（standalone）。
3. `embedded` 下恒一个 Connection，工作区仍是会话属性。
4. Client 未收到 `coreReady` 前不发出任何 `UiEvent`；Core 在就绪前收到 `UiEvent` 抛错。
5. 一份配置快照推给所有 Connection，Connection 之间不共享内存状态。
6. `connectionId` 不出现在任何总线载荷中。
7. 关闭工作区后 Connection 销毁；daemon 计数递减，归零后按 `docs/core-daemon.md` 退出。
8. 会话按 `sessionId` 路由到正确 Connection；查不到归属时报错。

---

## 11. 落点对照

| 规格项 | 落点 |
| --- | --- |
| Client | `src/host/Client.ts`（新增） |
| Connection | `src/host/Connection.ts`（新增） |
| 配置快照 | `src/host/SettingsStore.ts`（新增） |
| 工作区引用 | `src/host/workspaceRef.ts`（新增）、`src/host/UIHost.ts`（`WorkspaceProvider`） |
| 就绪门禁与会话路由 | `src/host/Client.ts` |
| 启动接线 | `src/host/bootstrapCore.ts` |

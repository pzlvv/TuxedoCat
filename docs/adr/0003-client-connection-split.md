# ADR-0003：Client / Connection 拆分（连接模型按工作区收敛）

- 状态：已采纳
- 日期：2025（Core / UI 架构重构，M13）
- 规格：`docs/client-connection.md`

## 背景

拆分前：`bootstrapCore` 直接建一个全局总线，把整份宿主环境发过去；会话与总线的关系
隐含在全局单例里（`WebViewUI.getInstance()` / `requireEventBus()`）。多工作区（Electron
同开多个目录）与远程工作区落地后，「一个 Host 对多个 Core」没有模型可表达。

## 决策

**宿主级 `Client` + 每工作区 `Connection`**：

- `Client` 是宿主级唯一实例：维护 `workspaceRef → Connection` 映射与 `sessionId → Connection`
  会话路由（查不到归属抛错，不静默丢弃）；同时实现 `AssistantEventBus` 作为宿主侧路由器；
- `Connection` 是宿主与一个 Core 的一对一连接：持有总线、就绪状态机
  （`connecting → ready → closed`）、该工作区的会话集合；未就绪时排队 `UiEvent`、
  挂起 `requestCore`；
- 总线作用域收敛到 Connection：全局单例保留为注册入口，路由按会话找归属；
  `connectionId` 是内部概念，不进任何总线载荷；
- 就绪门禁上移到 Client（未收到 `coreReady` 前不发任何 `UiEvent`，Core 侧门禁保留为兜底）；
- 一份配置快照推给所有已就绪的 Connection；同一 workspace 重复打开 → 激活已有视图，
  不新建 Connection。

## 替代方案（被否决）

- **全局单一总线按事件字段区分工作区**：每个载荷都要带工作区标记，且「哪个会话归哪个
  Core」仍无处安放，违反「不同来源的数据走不同的流」（[DEVELOPMENT.md 第 2 章](../../DEVELOPMENT.md#2-分层与依赖规则)规则 8）。
- **每会话一个连接**：Core 进程与会话的生命周期解耦（会话可跨进程恢复），按会话建连接
  会把进程管理与对话管理耦死。

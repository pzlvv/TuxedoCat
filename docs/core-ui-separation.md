# 规格：Core 与 UI 分离

本规格描述 Core 与 UI 的分离形态。Core 与 UI 之间只有一条边——事件总线；Core 持有会话
状态、配置读写与工具执行，可独立进程部署；UI 以连接的方式接入 Core。宿主环境差异
（工作目录、扩展路径、locale、日志出口）与配置文件读写都收敛到这条边上。

参考 `DEVELOPMENT.md` 第 2 节（分层与依赖规则）、第 3 节（核心契约：AssistantEventBus）、
第 4 节（事件列表）、第 5.1 节（UIHost）、第 8.6 节（宿主接线）、第 8.7 节（注入点与读取器）、
第 12.7 节（一份事实只有一个写入点）。

---

## 1. 能力

1. **唯一的边**：Core 与 UI 之间只有事件总线一条通信路径。两侧不互相引用，也不共享行为。
2. **宿主环境差异经总线传递**：工作目录、扩展路径、locale、日志出口由 UI 经总线交给 Core。
3. **配置读写归 Core**：全局配置文件与项目对话目录清单文件的读与写都由 Core 承担。
4. **Core 独立进程部署**：Core 不依赖 UI 所在进程；工具在 Core 所在机器上执行。
5. **连接一对一**：一个 Core 同一时刻只服务一个 UI 连接；已有连接时新连接被拒绝并得到提示。
6. **请求不设超时**：本地与远程同一口径，`request()` 不内置计时器。

---

## 2. 术语与事实来源

| 术语 | 含义 | owner |
| --- | --- | --- |
| Core | 对话引擎、工具、历史、配置读写 | core |
| UI | 宿主（VS Code 扩展 / Electron）与 webview | host |
| 总线 | `AssistantEventBus`：Core 与 UI 之间唯一的事件契约 | 契约由 core 定义 |
| 连接 | UI 与 Core 之间承载总线事件的一条通道 | 传输层 |
| 宿主环境 | 工作目录、扩展路径、locale、日志出口 | UI 提供，Core 消费 |
| 全局配置 | `~/<CONFIG_DIR_NAME>/settings.json` | core |
| 项目清单 | `<conversations>/<project>/settings.json` | core |

---

## 3. 总线：唯一的边

### 3.1 事件契约

三组词汇表构成 Core 与 UI 的公共词汇：

| 词汇表 | 方向 | 语义 |
| --- | --- | --- |
| `CoreEvent` | core → UI | 单向事实通知 |
| `CoreRequest` | core → UI | 请求-响应 |
| `UiEvent` | UI → core | 单向，报告用户动作与宿主环境 |

### 3.2 宿主环境差异

宿主环境差异经 `UiEvent` 进入 Core。Core 侧没有面向宿主的 provider 注入入口。

| 事实 | 性质 | 传递 | Core 侧读取入口 |
| --- | --- | --- | --- |
| 工作目录 | 动态 | 连接建立后一次；此后每次打开 / 切换 / 关闭各一次 | `getProjectRoot()` |
| 扩展路径 | 静态 | 连接建立后一次 | `getExtensionPath()` |
| locale | 静态 | 连接建立后一次 | `getCoreLocale()` |
| 日志出口开关 | 静态 | 连接建立后一次 | — |

- 工作目录到达时，Core 更新项目根，并以新路径预热系统动态信息（`SystemEnvironment`
  的缓存按工作目录分桶；不同工作目录不互相命中）。
- 静态事实在连接建立后传递一次。
- Core 侧的读取入口在对应事实到达前抛错，与 `requireEventBus()` 同一口径。
- 会话工作目录表（`sessionId` → 路径）由 Core 自行维护，不经总线。

### 3.3 宿主状态上报

宿主自己知道、Core 需要用来判定的事实，由宿主经 `UiEvent` 上报。Core 不持有宿主的判定
闭包，也不反向调用宿主。

| 事实 | 上报时机 | Core 侧落地 | Core 侧读取入口 |
| --- | --- | --- | --- |
| 该会话的用户选择是否在 webview 里等待应答 | webview 弹出选择 / 用户应答 / 视图释放 | `sessionRuntime.markSessionWaiting` | `sessionRuntime.isSessionWaiting()` |

「会话是否空闲」（`sessionResources.isSessionIdle`）读 Core 自己的 `sessionRuntime`，
不读宿主闭包。

### 3.4 日志

Core 的日志出口在 Core 侧。UI 需要展示日志时经 `CoreEvent` 接收。

### 3.5 边界语义

| 场景 | 语义 |
| --- | --- |
| `emitToUi` 时 `onCoreEvents` 尚未注册 | 抛错（接线缺失在启动期暴露） |
| `emitToCore` / `onUiEvent` 对某 type 无订阅者 | 静默丢弃（允许某动作暂无消费方） |
| `request()` 时无对应处理器 | 立即 reject |
| `request()` 的响应未到达 | 挂起，由调用点自行兜底 |

---

## 4. 配置读写归 Core

全局配置与项目清单的**读**与**写**都由 Core 承担。

| 项 | 内容 |
| --- | --- |
| 唯一写入点 | Core |
| 读缓存 | Core 侧；写盘后失效 |
| 写操作 | 串行化，按调用顺序排队 |
| UI 的改动请求 | 经 `UiEvent` 发给 Core，由 Core 落盘 |
| Core 自身产生的改动 | 在 Core 内直接落盘，不经总线 |

- Core 侧没有「只读」的例外：写入入口与读取入口同属 Core。
- UI 侧没有配置文件写入口。
- 宿主本地偏好（`theme` / `shortcut`）不在全局配置里：它们只有宿主消费，落宿主本机
  （Electron 为 `userData/workspace-state.json`），Core 不读不写。

---

## 5. Core 的部署形态

- Core 与 UI 位于各自的进程；两者可以在同一台机器，也可以在不同机器。
- 工具（Bash、文件读写、ripgrep、MCP stdio server）在 Core 所在机器上执行，操作 Core
  侧的文件系统。
- 会话状态、历史落盘、配置读写都在 Core 侧。
- UI 侧保留表现与宿主界面能力：diff 预览、Mermaid 预览、打开外部链接、另存为、界面构造。

---

## 6. 连接模型

- 一个 Core 同一时刻服务一个 UI 连接。
- 连接已存在时，新连接被拒绝，并得到提示。
- 总线契约不感知连接数量。

---

## 7. 请求超时

- `request()` 不内置计时器，本地与远程同一口径。
- 权限确认与用户选择的耗时上界由用户决定，不设上界。
- 断线导致的未决请求另行处理。

---

## 8. 不覆盖范围

- 事件在连接上的序列化与反序列化格式。
- 流式事件的节流与合并。
- 断线后的恢复。

---

## 9. 验收要点

1. Core 与 UI 之间只有总线一条通信路径。
2. 工作目录变更后，新路径的系统动态信息被预热；不同工作目录的会话各自命中自己的缓存。
3. 扩展路径 / locale / 日志出口开关在连接建立后传递一次；Core 侧读取入口在此之前抛错。
4. 全局配置与项目清单的写入只有 Core 一处。
5. 第二个连接到达时被拒绝并得到提示。
6. `request()` 在响应到达前保持挂起，不因计时器 reject。
7. Core 不持有任何宿主提供的判定闭包；「会话是否空闲」只看 Core 自己的事实。

---

## 10. 落点对照

| 规格项 | 落点 |
| --- | --- |
| 总线契约与词汇表 | `src/core/AssistantEventBus.ts` |
| 内存实现 | `src/host/EventBus.ts` |
| 工作目录传递与预热 | `src/core/initializeCoreEvents.ts`、`src/core/prompt/SystemEnvironment.ts` |
| 用户选择等待状态 | `src/host/ui/userChoice.ts`（上报）、`src/core/sessionRuntime.ts`（落地与读取） |
| 项目根 / 扩展路径 | `src/core/history/Config.ts` |
| locale | `src/core/i18n.ts` |
| 配置读写 | `src/core/history/Config.ts` |
| 启动接线 | `src/host/bootstrapCore.ts` |
